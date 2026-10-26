/**
 * 浏览器半清理语义的回归测试（不依赖构建链）。
 *
 * 用假的 `window.__ModuleLoader__` 加载真实 `client.js`，用 mock ctx 驱动 apply，
 * 重点守住 v0.3 评审的阻塞回归：「点完创建 → 立刻切走」时，已 adopted 的挂载
 * 必须**立即**撤销，不能等 15s 创建窗口或 60s 最小年龄。
 */
import { readFile } from 'node:fs/promises'

const failures = []
const expect = (label, ok) => { if (!ok) failures.push(label); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`) }
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
}
const fakeRequire = (id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require(${id})`)
}

/** 一个可订阅的 store 替身。 */
function createStore(snapshot) {
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    set: (next) => {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** 加载 client.js 并返回 factory 产物。 */
function loadClient() {
  let definition
  const win = { __ModuleLoader__: { load: (value) => { definition = value } } }
  const doc = {
    head: { appendChild: () => {} },
    createElement: () => ({ setAttribute: () => {}, remove: () => {}, style: {} }),
  }
  new Function('window', 'document', source)(win, doc)
  return definition.factory(fakeRequire)
}

/** 一套能装配 client.js 的 mock ctx；`state` 暴露给用例驱动。 */
function createContext() {
  const opened = []
  const deleted = []
  const sessions = createStore({ ids: [], byId: {}, phase: 'ready' })
  const workspaces = createStore({ items: [], phase: 'ready' })
  const effects = []
  const registrations = []
  const slots = {
    inject: (name, callback) => { callback(); return () => {} },
    register: (definition, component) => { registrations.push({ ...definition, component }); return () => {} },
  }
  const configForms = {
    describe: () => ({ getSnapshot: () => ({ view: { namespaces: [{ ns: 'noworkspace-session' }] } }) }),
    get: () => ({
      getSnapshot: () => ({ value: { defaultDir: 'C:\\tasks' }, user: {}, status: 'ready' }),
      set: async () => true,
      unset: async () => true,
    }),
    whileServed: (ids, callback) => { callback(new Set(['noworkspace-session'])); return () => {} },
  }
  const childFor = (extra) => ({
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose) },
    slots,
    ...extra,
  })
  const ctx = {
    slots,
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose) },
    inject: (deps, callback) => {
      if (deps.includes('configForms')) callback(childFor({ configForms }))
      if (deps.includes('sidebarRightTabs')) callback(childFor({ sidebarRightTabs: { register: () => () => {} } }))
    },
    get: (name) => (name === 'configForms' ? configForms : undefined),
    locale: { register: () => {}, bind: () => (key) => key },
    remote: { $host: { home: 'C:\\Users\\tester' } },
    sessions: {
      list: sessions,
      create: async ({ cwd }) => {
        const id = `session-${sessions.getSnapshot().ids.length + 1}`
        const snapshot = sessions.getSnapshot()
        sessions.set({
          ...snapshot,
          ids: [...snapshot.ids, id],
          byId: { ...snapshot.byId, [id]: { id, blank: true, cwd, retainedBy: {} } },
        })
        const ws = workspaces.getSnapshot()
        workspaces.set({ ...ws, items: [...ws.items, { workspaceId: `w-${id}`, path: cwd, sessionIds: [id] }] })
        return id
      },
    },
    workspaces: {
      list: workspaces,
      delete: async (workspaceId) => {
        deleted.push(workspaceId)
        const ws = workspaces.getSnapshot()
        workspaces.set({ ...ws, items: ws.items.filter((item) => item.workspaceId !== workspaceId) })
      },
    },
    uiWorkspace: { openSession: (id) => { opened.push(id) } },
  }
  return { ctx, sessions, workspaces, opened, deleted, registrations, effects }
}

/** 挂载当前会话在 store 中的 retain 计数（模拟主视图切换）。 */
function setCurrent(context, sessionId, patch = {}) {
  const snapshot = context.sessions.getSnapshot()
  const byId = {}
  for (const id of snapshot.ids) {
    const row = snapshot.byId[id]
    byId[id] = { ...row, retainedBy: id === sessionId ? { mainView: 1 } : {}, ...(id === sessionId ? patch : {}) }
  }
  context.sessions.set({ ...snapshot, byId })
}

const taskCwd = 'C:\\tasks\\2026-10-27\\09-00-00'

// ---- 1) 创建 → 立即切走：已 adopted 的挂载必须立刻撤销（BL-1） ----
{
  const harness = createContext()
  const client = loadClient()
  client.apply(harness.ctx)
  const chip = harness.registrations.find((entry) => entry.name === 'conversation.hero.options')
  expect('hero.options 座位完成注册', chip !== undefined)
  const start = chip.inject().start
  harness.ctx.uiWorkspace.openSession = (id) => {
    harness.opened.push(id)
    setCurrent(harness, id)
  }
  await start()
  expect('创建后打开了会话', harness.opened.length === 1)
  const workspaceId = harness.workspaces.getSnapshot().items[0]?.workspaceId
  expect('创建后存在临时挂载', workspaceId !== undefined)

  // 操作者切到另一个会话（不是 tracked 的空白会话）
  const afterCreate = harness.sessions.getSnapshot()
  harness.sessions.set({
    ids: [...afterCreate.ids, 'session-other'],
    byId: {
      ...afterCreate.byId,
      [afterCreate.ids[0]]: { ...afterCreate.byId[afterCreate.ids[0]], retainedBy: {} },
      'session-other': { id: 'session-other', blank: false, retainedBy: { mainView: 1 } },
    },
  })
  expect('切走后挂载被立即撤销（不再等 15s 窗口）', harness.deleted.includes(workspaceId))
  for (const dispose of harness.effects) dispose()
}

// ---- 2) 同一会话重复点 chip：复用当前空白会话，不新建 ----
{
  const harness = createContext()
  const client = loadClient()
  client.apply(harness.ctx)
  const start = harness.registrations.find((entry) => entry.name === 'conversation.hero.options').inject().start
  harness.ctx.uiWorkspace.openSession = (id) => { harness.opened.push(id); setCurrent(harness, id) }
  await start()
  await start()
  expect('重复点击复用同一会话', harness.opened.length === 2 && harness.opened[0] === harness.opened[1])
  expect('重复点击不新建会话', harness.sessions.getSnapshot().ids.length === 1)
  for (const dispose of harness.effects) dispose()
}

// ---- 3) 硬刷新：当前 blank + 形状匹配 + 已挂载 → 重采纳，离开即撤销 ----
{
  const harness = createContext()
  const client = loadClient()
  client.apply(harness.ctx)
  harness.sessions.set({
    ids: ['session-restored'],
    byId: { 'session-restored': { id: 'session-restored', blank: true, cwd: taskCwd, retainedBy: { mainView: 1 } } },
  })
  harness.workspaces.set({ items: [{ workspaceId: 'w-restored', path: taskCwd, sessionIds: ['session-restored'] }] })
  // 触发一次 sweep（订阅 + 2s 定时器都会驱动；这里直接推一次 store 变化）
  harness.sessions.set(harness.sessions.getSnapshot())
  harness.sessions.set({
    ids: ['session-restored', 'session-other'],
    byId: {
      'session-restored': { id: 'session-restored', blank: true, cwd: taskCwd, retainedBy: {} },
      'session-other': { id: 'session-other', blank: false, retainedBy: { mainView: 1 } },
    },
  })
  expect('刷新后未点 chip 的挂载在离开时也被撤销', harness.deleted.includes('w-restored'))
  for (const dispose of harness.effects) dispose()
}

// ---- 4) 挂载属于操作者自己的工作区时只删记账 id，不做成员推断 ----
{
  const harness = createContext()
  const client = loadClient()
  client.apply(harness.ctx)
  const start = harness.registrations.find((entry) => entry.name === 'conversation.hero.options').inject().start
  harness.ctx.uiWorkspace.openSession = (id) => { harness.opened.push(id); setCurrent(harness, id) }
  await start()
  const ours = harness.workspaces.getSnapshot().items[0].workspaceId
  // 手工塞入一个“操作者工作区”，其中也包含该会话（不应被删）
  const snapshot = harness.workspaces.getSnapshot()
  harness.workspaces.set({ ...snapshot, items: [...snapshot.items, { workspaceId: 'w-operator', path: 'C:\\projects\\a', sessionIds: ['session-1'] }] })
  harness.sessions.set({
    ids: ['session-1', 'session-other'],
    byId: {
      'session-1': { id: 'session-1', blank: true, cwd: taskCwd, retainedBy: {} },
      'session-other': { id: 'session-other', blank: false, retainedBy: { mainView: 1 } },
    },
  })
  expect('只删除记账的挂载 id', harness.deleted.includes(ours) && !harness.deleted.includes('w-operator'))
  for (const dispose of harness.effects) dispose()
}

// ---- 5) chip 在自己的空白 scratch 会话上隐藏，在普通空白会话上仍显示 ----
{
  const harness = createContext()
  const client = loadClient()
  client.apply(harness.ctx)
  const chip = harness.registrations.find((entry) => entry.name === 'conversation.hero.options')
  const faces = chip.inject()
  const render = (row) => chip.component({
    ...faces,
    useSessions: (selector) => selector({ ids: ['session-x'], byId: { 'session-x': { retainedBy: { mainView: 1 }, ...row } } }),
    t: (key) => key,
  })
  expect('自己的空白 scratch 会话上隐藏 chip', render({ id: 'session-x', blank: true, cwd: taskCwd }) === null)
  expect('普通空白未分组会话仍显示 chip', render({ id: 'session-x', blank: true }) !== null)
  expect('非空白会话不按 scratch 隐藏（由 hero 座位自身不渲染）',
    render({ id: 'session-x', blank: false, cwd: taskCwd }) !== null)
  for (const dispose of harness.effects) dispose()
}

console.log(failures.length === 0 ? '全部通过' : `未通过：\n - ${failures.join('\n - ')}`)
process.exit(failures.length === 0 ? 0 : 1)
