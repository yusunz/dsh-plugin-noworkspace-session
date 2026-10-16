/**
 * 回归冒烟测试（针对 "cannot get property X without inject" 那次宿主崩溃）。
 *
 * 用一个模仿 cordis 服务守卫的 mock ctx 调用真实的 apply()：
 *   - 任何未在白名单里的属性访问（如 ctx.config / ctx.sessions）都抛与线上相同的错误；
 *   - 捕获所有 unhandledRejection —— 那次崩溃正是异步 IIFE 里未捕获的拒绝。
 * 随后伪造一次 api-session/added 触发清扫，验证空目录被删、有内容的目录保留。
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const failures = []
process.on('unhandledRejection', (reason) => {
  failures.push(`unhandledRejection: ${String(reason)}`)
})

const base = join(process.env.TEMP, 'nws-smoke-base')
rmSync(base, { recursive: true, force: true })
mkdirSync(join(base, '2026-10-15', '21-00-00'), { recursive: true })
mkdirSync(join(base, '2026-10-15', '21-00-01'), { recursive: true })
writeFileSync(join(base, '2026-10-15', '21-00-01', 'keep.txt'), 'x')

const listeners = new Map()
const allowed = {
  on: (name, fn) => { listeners.set(name, fn) },
  inject: () => {},
  effect: () => {},
  get: () => undefined,
  root: { get: () => undefined },
  logger: { warn: (...args) => { console.log('[warn]', ...args) } },
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
console.log('apply 返回，未抛异常')

// 伪造渲染端恢复时的第一次会话公告
listeners.get('api-session/added')?.({ sessionId: 'session-probe', blank: false, cwd: base })
console.log('已伪造 api-session/added')

// 等过 RESTORE_SETTLE_MS(2s) 与清扫完成
await new Promise((done) => { setTimeout(done, 4000) })

const list = readdirSync(base, { recursive: true }).map(String)
console.log('剩余：', JSON.stringify(list))

const expect = (label, condition) => {
  if (!condition) failures.push(label)
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`)
}
expect('空目录 2026-10-15/21-00-00 已被清扫', !list.some((p) => p.includes('21-00-00')))
expect('有内容的 21-00-01 保留', list.some((p) => p.includes('keep.txt')))
expect('无 unhandledRejection（宿主不会因此退出）', failures.length === 0)

if (failures.length > 0) {
  console.log('未通过：')
  for (const failure of failures) console.log(' -', failure)
}
console.log(failures.length === 0 ? '全部通过' : `${failures.length} 项未通过`)
rmSync(base, { recursive: true, force: true })
process.exit(failures.length === 0 ? 0 : 1)
