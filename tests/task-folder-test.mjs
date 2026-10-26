/**
 * 任务目录形状、路径归一与启动清扫的纯函数测试（不依赖 cordis ctx）。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalPath,
  isTaskFolder,
  normalizePath,
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

// ---- canonicalPath：真实目录经 realpath 归一（8.3 短名/junction 同机制） ----
mkdirSync(valid, { recursive: true })
const canonical = await canonicalPath(valid)
expect('canonicalPath 返回含日期/时间段的归一路径', typeof canonical === 'string'
  && canonical.includes('2026-10-27') && canonical.includes('09-00-00'))
expect('canonicalPath 对不存在的路径退回词法归一', await canonicalPath(join(base, 'missing', 'x')) === normalizePath(join(base, 'missing', 'x')))

// ---- 启动清扫 ----
const sweepBase = join(base, 'sweep')
const sweepDate = join(sweepBase, '2026-10-29')
const sweepLive = join(sweepDate, '11-00-01')
const sweepPersisted = join(sweepDate, '11-00-03')
mkdirSync(join(sweepDate, '11-00-00'), { recursive: true })
mkdirSync(sweepLive, { recursive: true })
mkdirSync(sweepPersisted, { recursive: true })
mkdirSync(join(sweepDate, '11-00-02'), { recursive: true })
writeFileSync(join(sweepDate, '11-00-02', 'keep.txt'), 'x')
mkdirSync(join(sweepBase, '2026-10-30', '11-00-00'), { recursive: true })
const keep = new Set([normalizePath(sweepLive), normalizePath(sweepPersisted)])
await sweepEmptyTaskFolders(sweepBase, keep)
expect('无主空任务目录被清扫', !existsSync(join(sweepDate, '11-00-00')))
expect('live 会话的任务目录保留', existsSync(sweepLive))
expect('有持久记录的任务目录也保留（resume 不会重建 cwd）', existsSync(sweepPersisted))
expect('有内容的任务目录保留', existsSync(join(sweepDate, '11-00-02', 'keep.txt')))
expect('仅剩空子目录的日期目录被清扫', !existsSync(join(sweepBase, '2026-10-30')))
expect('仍含在用/有内容子目录的日期目录保留', existsSync(sweepDate))

console.log(failures.length === 0 ? '全部通过' : `未通过：\n - ${failures.join('\n - ')}`)
rmSync(base, { recursive: true, force: true })
process.exit(failures.length === 0 ? 0 : 1)
