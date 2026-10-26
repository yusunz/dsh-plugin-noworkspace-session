/**
 * 宿主挂载账本测试：创建/复用/失败重试/按 workspaceId 卸载/窄谓词遗留清理。
 * 用假 registry，不触碰磁盘。
 */
import { join } from 'node:path'
import { createMountLedger } from '../src/mounts.js'

const failures = []
const expect = (label, ok) => { if (!ok) failures.push(label); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`) }
const report = (message) => console.log('[report]', message)
const wait = (ms) => new Promise((done) => { setTimeout(done, ms) })
const root = join(process.env.TEMP, 'nws-mounts-root')
const cwd = (date, time) => join(root, date, time)

/** 假注册表：记录 attach/delete 调用。 */
function makeRegistry(initial = []) {
  const workspaces = [...initial]
  return {
    workspaces,
    list: () => workspaces,
    resolveByPath: async (path) => workspaces.find((workspace) => workspace.path === path),
    create: async (path, title) => {
      const workspace = {
        id: `w${workspaces.length + 1}`,
        path,
        title,
        createdAt: new Date().toISOString(),
        sessionIds: [],
        async attachSession(sessionId) { this.sessionIds.push(sessionId) },
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
}

const startedAt = Date.now()
const registry = makeRegistry()
const ledger = createMountLedger({ registryOf: () => registry, report, startedAt })

const first = cwd('2026-10-27', '10-00-00')
expect('挂载前不持有', ledger.handles('session-a') === false)
expect('首次挂载成功', await ledger.mount('session-a', first) === true)
expect('挂载后持有', ledger.handles('session-a') === true)
expect('创建了带展示前缀的工作区', registry.workspaces[0].title.startsWith('无项目任务 · '))
expect('会话已 attach', registry.workspaces[0].sessionIds.includes('session-a'))
expect('同一会话重复挂载幂等', await ledger.mount('session-a', first) === true && registry.workspaces.length === 1)

// 用户自建的同路径工作区：只接管带前缀的遗留，不碰用户的
const userPath = cwd('2026-10-27', '10-00-01')
const userWorkspace = {
  id: 'user-1', path: userPath, title: 'my project', createdAt: new Date().toISOString(),
  sessionIds: [], async attachSession(sessionId) { this.sessionIds.push(sessionId) },
}
registry.workspaces.push(userWorkspace)
expect('用户工作区不被接管', await ledger.mount('session-b', userPath) === false)
expect('用户工作区未被 attach', userWorkspace.sessionIds.length === 0)

const leftoverPath = cwd('2026-10-27', '10-00-02')
const leftoverWorkspace = {
  id: 'leftover-1', path: leftoverPath, title: '无项目任务 · 09-00-00', createdAt: new Date().toISOString(),
  sessionIds: [], async attachSession(sessionId) { this.sessionIds.push(sessionId) },
}
registry.workspaces.push(leftoverWorkspace)
expect('带前缀的遗留工作区被接管', await ledger.mount('session-c', leftoverPath) === true)

// 同一目录下已有另一会话的挂载：不再 attach，避免共享挂载被首条消息连带删除
const sharedPath = cwd('2026-10-27', '10-00-04')
const sharedWorkspace = {
  id: 'shared-1', path: sharedPath, title: '无项目任务 · 10-00-04', createdAt: new Date().toISOString(),
  sessionIds: ['session-owner'], async attachSession(sessionId) { this.sessionIds.push(sessionId) },
}
registry.workspaces.push(sharedWorkspace)
expect('已被别的会话占用的挂载不重复 attach', await ledger.mount('session-second', sharedPath) === false)
expect('原会话仍是唯一成员', sharedWorkspace.sessionIds.length === 1)

// 失败可重试：一次瞬态失败后，下一次挂载成功且账本干净
const flaky = makeRegistry()
let attempts = 0
const originalCreate = flaky.create
flaky.create = async (path, title) => {
  attempts += 1
  if (attempts === 1) throw new Error('transient')
  return await originalCreate(path, title)
}
const flakyLedger = createMountLedger({ registryOf: () => flaky, report, startedAt })
expect('首次失败返回 false', await flakyLedger.mount('session-d', cwd('2026-10-27', '10-00-03')) === false)
expect('失败不写入账本', flakyLedger.handles('session-d') === false)
expect('重试成功', await flakyLedger.mount('session-d', cwd('2026-10-27', '10-00-03')) === true)
expect('重试后持有', flakyLedger.handles('session-d') === true)

// 同一会话的两次公告可能并行到达：pending 守卫只允许一次挂载
const slowRegistry = makeRegistry()
const baseCreate = slowRegistry.create
slowRegistry.create = async (path, title) => { await wait(20); return await baseCreate(path, title) }
const slowLedger = createMountLedger({ registryOf: () => slowRegistry, report, startedAt })
const [firstAttempt, secondAttempt] = await Promise.all([
  slowLedger.mount('session-concurrent', cwd('2026-10-27', '10-00-05')),
  slowLedger.mount('session-concurrent', cwd('2026-10-27', '10-00-05')),
])
expect('并发公告只发起一次挂载', [firstAttempt, secondAttempt].filter(Boolean).length === 1)
expect('并发后只建一个工作区', slowRegistry.workspaces.length === 1)

// 按 workspaceId 卸载
const mountedId = registry.workspaces.find((workspace) => workspace.sessionIds.includes('session-a')).id
await ledger.unmount('session-a')
expect('卸载后不再持有', ledger.handles('session-a') === false)
expect('按记账 id 删除工作区', registry.workspaces.some((workspace) => workspace.id === mountedId) === false)

// 窄谓词的遗留清理
const oldTime = new Date(startedAt - 120_000).toISOString()
const leftovers = makeRegistry([
  { id: 'old-mount', path: cwd('2026-10-20', '08-00-00'), title: '无项目任务 · 08-00-00', createdAt: oldTime, sessionIds: ['session-x'] },
  { id: 'fresh-mount', path: cwd('2026-10-20', '08-00-01'), title: '无项目任务 · 08-00-01', createdAt: new Date().toISOString(), sessionIds: ['session-y'] },
  { id: 'user-shaped', path: cwd('2026-10-20', '08-00-02'), title: 'my project', createdAt: oldTime, sessionIds: ['session-z'] },
  { id: 'outside-shape', path: join(root, 'plain'), title: '无项目任务 · 08-00-03', createdAt: oldTime, sessionIds: ['session-w'] },
  { id: 'empty-mount', path: cwd('2026-10-20', '08-00-04'), title: '无项目任务 · 08-00-04', createdAt: oldTime, sessionIds: [] },
])
const sweepLedger = createMountLedger({ registryOf: () => leftovers, report, startedAt })
await sweepLedger.mount('session-keep', cwd('2026-10-27', '11-00-00'))
await wait(0)
await sweepLedger.retireLeftovers(root)
const remaining = leftovers.workspaces.map((workspace) => workspace.id)
expect('上一进程留下的挂载被清理', !remaining.includes('old-mount'))
expect('本进程刚建的不清理', remaining.some((id) => leftovers.workspaces.find((w) => w.id === id)?.sessionIds.includes('session-keep')))
expect('用户自建同形状工作区不清理', remaining.includes('user-shaped'))
expect('形状不符的遗留不清理', remaining.includes('outside-shape'))
expect('空成员项按窄谓词清理（无标题前缀要求之外的当前行为）', !remaining.includes('empty-mount'))

console.log(failures.length === 0 ? '全部通过' : `未通过：\n - ${failures.join('\n - ')}`)
process.exit(failures.length === 0 ? 0 : 1)
