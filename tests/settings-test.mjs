/**
 * 有效配置读取优先级测试：settings 镜像 → Volatile 引用 → schema 默认值；
 * 同时确认设置展示被关闭（auto:false）且 owner 是本插件 fiber。
 *
 * settings 镜像优先：浏览器半的路径与写入都走同一个镜像，宿主跟它读同一个值，
 * 才能保证「设置里改的目录」与「新会话落到的目录」一致；Volatile 引用只在没有
 * settings 服务的裁剪组合里兜底。
 */
import { Config, DEFAULT_DIR, createDirReader } from '../src/settings.js'

const failures = []
const expect = (label, ok) => { if (!ok) failures.push(label); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`) }

function makeCtx({ described = [], withSettings = true, configureCalls = [] } = {}) {
  const child = {
    effect: (fn) => { fn() },
    settings: {
      configure: (...args) => { configureCalls.push(args); return () => {} },
      describe: () => described,
    },
  }
  const ctx = { fiber: { id: 'plugin-fiber' }, inject: (deps, callback) => { if (withSettings && deps.includes('settings')) callback(child) } }
  return ctx
}

expect('Config 声明了 defaultDir 默认值', Config.dict?.defaultDir?.meta?.default === DEFAULT_DIR)
expect('defaultDir 必须是 volatile（否则设置行不可写）', Config.dict?.defaultDir?.meta?.volatile === true)

const calls = []
const withSettings = makeCtx({ described: [{ ns: 'noworkspace-session', value: { defaultDir: '/from-settings' } }], configureCalls: calls })
const fromService = createDirReader(withSettings, { defaultDir: { get: () => '/from-config' } })
expect('settings 镜像优先于 Volatile 引用（与客户端同源）', fromService() === '/from-settings')
expect('设置展示被显式关闭（auto:false）', calls.length === 1 && calls[0][0]?.auto === false)
expect('configure 的 owner 是本插件 fiber', calls[0][1] === withSettings.fiber)

const noSettings = makeCtx({ withSettings: false })
expect('无 settings 时用 Volatile 引用兜底', createDirReader(noSettings, { defaultDir: { get: () => '/from-config' } })() === '/from-config')
expect('无 settings 时普通字符串配置可用', createDirReader(noSettings, { defaultDir: '/plain-config' })() === '/plain-config')
expect('都没有时回落到 schema 默认值', createDirReader(noSettings, {})() === DEFAULT_DIR)

expect('settings 镜像无值时回落默认值', createDirReader(makeCtx({ described: [] }), {})() === DEFAULT_DIR)
expect('空白 settings 值被忽略', createDirReader(makeCtx({ described: [{ ns: 'noworkspace-session', value: { defaultDir: '   ' } }] }), {})() === DEFAULT_DIR)

console.log(failures.length === 0 ? '全部通过' : `未通过：\n - ${failures.join('\n - ')}`)
process.exit(failures.length === 0 ? 0 : 1)
