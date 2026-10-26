/**
 * 启动维护的调度测试：首次 announcement 后 settle 执行一次、兜底计时、dispose 取消。
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createStartupMaintenance } from '../src/startup-sweep.js'

const failures = []
const expect = (label, ok) => { if (!ok) failures.push(label); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`) }
const wait = (ms) => new Promise((done) => { setTimeout(done, ms) })
const report = (message) => console.log('[report]', message)

const root = join(process.env.TEMP, 'nws-maintenance-root')
rmSync(root, { recursive: true, force: true })
mkdirSync(join(root, '2026-10-27', '12-00-00'), { recursive: true })

const ctx = { get: (key) => (key === 'sessions' ? { list: () => [] } : undefined) }

/** 每次 run 都会调用 retireLeftovers 并清扫空目录。 */
function makeLedger() {
  let retired = 0
  return { get retired() { return retired }, retireLeftovers: async () => { retired += 1 } }
}

// 1) arm 后 settle 执行一次；dispose 后不再执行
const ledger = makeLedger()
const maintenance = createStartupMaintenance({ ctx, readDir: () => root, ledger, report, settleMs: 50, fallbackMs: 5000 })
maintenance.arm()
await wait(150)
expect('arm 后执行过一次维护', ledger.retired === 1)
expect('空任务目录被清扫', !existsSync(join(root, '2026-10-27', '12-00-00')))
maintenance.dispose()
await wait(120)
expect('dispose 后不再执行', ledger.retired === 1)

// 2) 无人 restore 时：兜底计时执行一次
mkdirSync(join(root, '2026-10-27', '12-00-01'), { recursive: true })
const fallbackLedger = makeLedger()
const fallback = createStartupMaintenance({ ctx, readDir: () => root, ledger: fallbackLedger, report, settleMs: 5000, fallbackMs: 60 })
await wait(150)
expect('兜底计时执行过一次维护', fallbackLedger.retired === 1)
expect('兜底路径也清扫空目录', !existsSync(join(root, '2026-10-27', '12-00-01')))
fallback.dispose()

// 3) 运行前 dispose：什么也不做
const disposedLedger = makeLedger()
const disposed = createStartupMaintenance({ ctx, readDir: () => root, ledger: disposedLedger, report, settleMs: 40, fallbackMs: 60 })
disposed.dispose()
await wait(150)
expect('运行前 dispose 不执行', disposedLedger.retired === 0)

console.log(failures.length === 0 ? '全部通过' : `未通过：\n - ${failures.join('\n - ')}`)
rmSync(root, { recursive: true, force: true })
process.exit(failures.length === 0 ? 0 : 1)
