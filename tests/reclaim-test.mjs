/**
 * 针对「挂载被客户端撤回 → 立即回收空任务目录」的验证。
 * 用带服务守卫的 mock ctx 调真实 apply()，用假注册表驱动挂载与撤回。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const failures = []
process.on('unhandledRejection', (reason) => { failures.push(`unhandledRejection: ${String(reason)}`) })

const base = join(process.env.TEMP, 'nws-reclaim-base')
rmSync(base, { recursive: true, force: true })
const abandoned = join(base, '2026-10-16', '10-00-00')   // 空 → 应被回收
const used = join(base, '2026-10-16', '10-00-01')        // 空但已发消息 → 保留
const nonempty = join(base, '2026-10-16', '10-00-02')    // 非空 → 保留
for (const dir of [abandoned, used, nonempty]) mkdirSync(dir, { recursive: true })
writeFileSync(join(nonempty, 'note.txt'), 'x')

// 假注册表：create 挂会话，delete 移除；外部可模拟客户端清理（把工作区从列表里摘掉）
const workspaces = []
const registry = {
  list: () => workspaces,
  resolveByPath: async () => undefined,
  create: async (path, title) => {
    const workspace = {
      id: `w${workspaces.length + 1}`, title, path, sessionIds: [],
      attachSession: async (sessionId) => { workspace.sessionIds.push(sessionId) },
    }
    workspaces.push(workspace)
    return workspace
  },
  delete: async (id) => {
    const at = workspaces.findIndex((w) => w.id === id)
    if (at >= 0) workspaces.splice(at, 1)
  },
}
const reclaim = (sessionId) => {
  const at = workspaces.findIndex((w) => w.sessionIds.includes(sessionId))
  if (at >= 0) workspaces.splice(at, 1)
}

const listeners = new Map()
const allowed = {
  on: (name, fn) => { listeners.set(name, fn) },
  inject: () => {},
  effect: (fn) => { fn() },
  get: (key) => (key === 'sessions'
    ? { list: () => [{ header: { cwd: used } }] }
    : undefined),
  root: { get: (key) => (key === 'workspaceRegistry' ? registry : undefined) },
  logger: { warn: (...args) => console.log('[warn]', ...args) },
  fiber: {},
}
const ctx = new Proxy(allowed, {
  get: (target, key) => {
    if (typeof key === 'symbol' || key in target) return Reflect.get(target, key)
    throw new Error(`cannot get property "${String(key)}" without inject`)
  },
})

const { apply } = await import(new URL('../index.js', import.meta.url).href)
apply(ctx, { defaultDir: base })
const announce = listeners.get('api-session/added')
const activity = listeners.get('api-session/activity')
announce?.({ sessionId: 'session-nws-a', blank: true, cwd: abandoned })
announce?.({ sessionId: 'session-nws-b', blank: true, cwd: used })
announce?.({ sessionId: 'session-nws-c', blank: true, cwd: nonempty })
await new Promise((r) => setTimeout(r, 150))
const mountedCount = workspaces.length

activity?.('session-nws-b')                                  // B 发过消息
await new Promise((r) => setTimeout(r, 80))
reclaim('session-nws-a')                                     // 客户端撤回 A 的挂载（未发消息）
reclaim('session-nws-c')                                     // C 也被撤回，但目录非空
await new Promise((r) => setTimeout(r, 1400))                // 早于启动清理的 2s settle

const exists = (p) => existsSync(p)
const expect = (label, ok) => { if (!ok) failures.push(label); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`) }
expect('三次挂载都建立', mountedCount === 3)
expect('A 的空目录在撤回后约 1 秒内被回收', !exists(abandoned))
expect('B 发过消息，目录保留', exists(used))
expect('C 目录非空，保留', exists(nonempty) && exists(join(nonempty, 'note.txt')))
expect('日期目录仍含其它任务目录因此保留', exists(join(base, '2026-10-16')))
expect('无未捕获拒绝（宿主不会因此退出）', failures.length === 0)

console.log(failures.length === 0 ? '全部通过' : `未通过：\n - ${failures.join('\n - ')}`)
rmSync(base, { recursive: true, force: true })
process.exit(failures.length === 0 ? 0 : 1)
