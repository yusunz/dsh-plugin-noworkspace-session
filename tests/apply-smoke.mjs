/**
 * 端到端冒烟（v0.3）：用带服务守卫的 mock ctx 调真实 apply()，验证
 *   挂载（空白 + 任务目录形状）→ 首条消息卸载；subagent/非空白不挂载；
 *   启动期空目录回收（2s settle）与有内容/在用目录保留；不产生未捕获拒绝。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const failures = []
const unhandled = []
process.on('unhandledRejection', (reason) => { unhandled.push(String(reason)) })

const base = join(process.env.TEMP, 'nws-smoke-base')
rmSync(base, { recursive: true, force: true })
const abandoned = join(base, '2026-10-27', '09-00-00')
const live = join(base, '2026-10-27', '09-00-01')
const nonempty = join(base, '2026-10-27', '09-00-02')
for (const dir of [abandoned, live, nonempty]) mkdirSync(dir, { recursive: true })
writeFileSync(join(nonempty, 'keep.txt'), 'x')

const workspaces = []
const registry = {
  list: () => workspaces,
  resolveByPath: async (path) => workspaces.find((workspace) => workspace.path === path),
  create: async (path, title) => {
    const workspace = {
      id: `w${workspaces.length + 1}`, title, path, createdAt: new Date().toISOString(), sessionIds: [],
      attachSession: async (sessionId) => { workspace.sessionIds.push(sessionId) },
    }
    workspaces.push(workspace)
    return workspace
  },
  delete: async (id) => {
    const at = workspaces.findIndex((workspace) => workspace.id === id)
    if (at < 0) return false
    workspaces.splice(at, 1)
    return true
  },
}

const listeners = new Map()
const disposers = []
const childContext = {
  effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
  settings: {
    configure: () => () => {},
    describe: () => [{ ns: 'noworkspace-session', value: { defaultDir: base } }],
  },
}
const allowed = {
  on: (name, fn) => { listeners.set(name, fn) },
  inject: (deps, callback) => { if (deps.includes('settings')) callback(childContext) },
  effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
  get: (key) => {
    if (key === 'sessions') return { list: () => [{ header: { cwd: live } }] }
    if (key === 'workspaceRegistry') return registry
    return undefined
  },
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
// 走 Volatile 引用路径（真实 Loader 交给 apply 的就是这种形状）
apply(ctx, { defaultDir: { get: () => base } })
console.log('apply 返回，未抛异常')

const announce = listeners.get('api-session/added')
const activity = listeners.get('api-session/activity')
const removed = listeners.get('api-session/removed')
const expect = (label, ok) => { if (!ok) failures.push(label); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`) }
const wait = (ms) => new Promise((done) => { setTimeout(done, ms) })
const workspaceOf = (sessionId) => workspaces.find((workspace) => workspace.sessionIds.includes(sessionId))

announce?.({ sessionId: 'session-a', blank: true, cwd: abandoned })
announce?.({ sessionId: 'session-child', blank: true, cwd: abandoned, origin: 'subagent', parentSessionId: 'session-a' })
announce?.({ sessionId: 'session-used', blank: false, cwd: nonempty })
await wait(150)

const mounted = workspaceOf('session-a')
expect('空白任务目录会话被挂载', mounted !== undefined)
expect('挂载标题带展示前缀', mounted?.title.startsWith('无项目任务 · ') === true)
expect('挂载路径就是会话 cwd', mounted?.path === abandoned)
expect('subagent 会话不被挂载', workspaceOf('session-child') === undefined)
expect('非空白会话不被挂载', workspaceOf('session-used') === undefined)

activity?.('session-a')
await wait(80)
expect('首条消息后挂载被卸载', workspaceOf('session-a') === undefined)

// 再挂一个，然后用 removed 事件放掉账本项：不应抛错
const third = join(base, '2026-10-27', '09-00-03')
mkdirSync(third, { recursive: true })
announce?.({ sessionId: 'session-b', blank: true, cwd: third })
await wait(80)
expect('第二个会话也被挂载', workspaceOf('session-b') !== undefined)
removed?.('session-b')

await wait(2300) // 越过 2s settle，触发启动期维护
expect('空任务目录在启动维护中被回收', !existsSync(abandoned))
expect('在用的任务目录保留', existsSync(live))
expect('有内容的任务目录保留', existsSync(nonempty) && existsSync(join(nonempty, 'keep.txt')))
expect('日期目录仍含在用/有内容子目录', existsSync(join(base, '2026-10-27')))

for (const dispose of disposers) dispose()
await wait(80)
expect('无未捕获拒绝（宿主不会因此退出）', unhandled.length === 0)
if (unhandled.length > 0) console.log('未捕获拒绝：', unhandled)

console.log(failures.length === 0 ? '全部通过' : `未通过：\n - ${failures.join('\n - ')}`)
rmSync(base, { recursive: true, force: true })
process.exit(failures.length === 0 ? 0 : 1)
