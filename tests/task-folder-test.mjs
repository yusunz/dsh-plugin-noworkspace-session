/**
 * 任务目录形状与磁盘回收的纯函数测试（不依赖 cordis ctx）。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  isTaskFolder,
  normalizePath,
  removeEmptyTaskFolder,
  sweepEmptyTaskFolders,
  taskFolderRoot,
} from '../src/task-folder.js'

const failures = []
const expect = (label, ok) => { if (!ok) failures.push(label); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`) }
const base = join(process.env.TEMP, 'nws-task-folder-base')
rmSync(base, { recursive: true, force: true })
mkdirSync(base, { recursive: true })

// ---- root 展开 ----
expect('~ 展开到宿主主目录', taskFolderRoot('~/Documents/dsh') === join(homedir(), 'Documents', 'dsh'))
expect('普通绝对路径原样解析', taskFolderRoot(base) === base)
expect('空白配置返回 undefined', taskFolderRoot('   ') === undefined)
expect('非字符串配置返回 undefined', taskFolderRoot(undefined) === undefined)

// ---- 形状判定 ----
const valid = join(base, '2026-10-27', '09-00-00')
expect('合法日期/时间形状', isTaskFolder(base, valid) === true)
expect('日期段非法', isTaskFolder(base, join(base, '2026-10', '09-00-00')) === false)
expect('时间段非法', isTaskFolder(base, join(base, '2026-10-27', '9-0-0')) === false)
expect('多一层子目录不算任务目录', isTaskFolder(base, join(valid, 'work')) === false)
expect('root 之外不算任务目录', isTaskFolder(join(base, 'other'), valid) === false)
expect('空参数不算任务目录', isTaskFolder('', valid) === false && isTaskFolder(base, undefined) === false)
if (process.platform === 'win32') {
  expect('Windows 下大小写等价', isTaskFolder(base.toUpperCase(), valid) === true)
} else {
  expect('POSIX 下大小写敏感', isTaskFolder(base.toUpperCase(), valid) === false)
}
expect('normalizePath 统一分隔符', normalizePath(valid).includes('/') === true)

// ---- 单目录回收：空目录连空日期目录一起删 ----
const lonelyDate = join(base, '2026-10-31')
const lonely = join(lonelyDate, '10-00-00')
mkdirSync(lonely, { recursive: true })
await removeEmptyTaskFolder(lonely)
expect('空任务目录被删', !existsSync(lonely))
expect('随之变空的日期目录也被删', !existsSync(lonelyDate))

// ---- 单目录回收：有内容的、形状不符的都不动 ----
const sharedDate = join(base, '2026-10-28')
const used = join(sharedDate, '10-00-01')
const stray = join(base, 'not-a-task-folder')
mkdirSync(used, { recursive: true })
mkdirSync(stray, { recursive: true })
writeFileSync(join(used, 'note.txt'), 'x')
await removeEmptyTaskFolder(used)
await removeEmptyTaskFolder(stray)
expect('有内容的任务目录保留', existsSync(used) && existsSync(join(used, 'note.txt')))
expect('形状不符的目录不动', existsSync(stray))

// ---- 启动清扫 ----
const sweepBase = join(base, 'sweep')
const sweepDate = join(sweepBase, '2026-10-29')
const sweepLive = join(sweepDate, '11-00-01')
mkdirSync(join(sweepDate, '11-00-00'), { recursive: true })
mkdirSync(sweepLive, { recursive: true })
mkdirSync(join(sweepDate, '11-00-02'), { recursive: true })
writeFileSync(join(sweepDate, '11-00-02', 'keep.txt'), 'x')
mkdirSync(join(sweepBase, '2026-10-30', '11-00-00'), { recursive: true })
await sweepEmptyTaskFolders(sweepBase, new Set([normalizePath(sweepLive)]))
expect('无主空任务目录被清扫', !existsSync(join(sweepDate, '11-00-00')))
expect('在用的任务目录保留', existsSync(sweepLive))
expect('有内容的任务目录保留', existsSync(join(sweepDate, '11-00-02', 'keep.txt')))
expect('仅剩空子目录的日期目录被清扫', !existsSync(join(sweepBase, '2026-10-30')))
expect('仍含在用/有内容子目录的日期目录保留', existsSync(sweepDate))

console.log(failures.length === 0 ? '全部通过' : `未通过：\n - ${failures.join('\n - ')}`)
rmSync(base, { recursive: true, force: true })
process.exit(failures.length === 0 ? 0 : 1)
