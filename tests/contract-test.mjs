/**
 * 跨半契约的文本级对照测试。
 *
 * 浏览器半与宿主半运行在不同模块系统里，无法共享运行时模块，所以任务目录形状、
 * 默认目录这些约定只能靠「两份实现 + 测试」保持一致。本测试直接读两侧源码，
 * 防止任一侧悄悄改格式（日期/时间/默认目录）。
 */
import { readFile } from 'node:fs/promises'

const failures = []
const expect = (label, ok) => { if (!ok) failures.push(label); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`) }
const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8')

const client = await read('client.js')
const taskFolder = await read('src/task-folder.js')
const settings = await read('src/settings.js')
const index = await read('index.js')

// ---- 默认目录常量 ----
const hostDefault = settings.match(/DEFAULT_DIR = '([^']+)'/)?.[1]
const clientDefault = client.match(/DEFAULT_DIR = '([^']+)'/)?.[1]
expect('两侧默认任务目录一致', hostDefault !== undefined && hostDefault === clientDefault)

// ---- 任务目录形状 ----
const hostDate = taskFolder.match(/DATE_FOLDER = \/(.+)\//)?.[1]
const hostTime = taskFolder.match(/TIME_FOLDER = \/(.+)\//)?.[1]
expect('宿主声明了日期/时间形状', hostDate !== undefined && hostTime !== undefined)
const stripAnchors = (source) => source.replace(/^\^/, '').replace(/\$$/, '')
const expectedPattern = `/^${stripAnchors(hostDate)}\\/${stripAnchors(hostTime)}$/`
expect('客户端任务目录正则与宿主日期/时间形状一致', client.includes(expectedPattern))
expect('客户端产出时间目录用零填充的本地时分秒', client.includes('pad2(now.getHours())')
  && client.includes('pad2(now.getMinutes()') && client.includes('pad2(now.getSeconds())'))

// ---- 会话 id 与命令契约 ----
expect('客户端不再自铸 session id', /sessions\.create\(\{\s*cwd\s*\}\)/.test(client) && !client.includes('SESSION_ID_PREFIX'))
expect('客户端在自身空白 scratch 会话上隐藏入口', client.includes('isOwnScratch'))
expect('客户端放弃时走 workspaces.delete', client.includes('ctx.workspaces.delete('))
expect('两端都不再依赖标题前缀做运行时所有权判断',
  !client.includes('MOUNT_TITLE_PREFIX') && !index.includes('MOUNT_TITLE_PREFIX'))
expect('宿主只按挂载账本卸载（index 不按标题扫描）', !index.includes('.startsWith(') && index.includes('ledger.unmount'))
expect('宿主监听的事件与该契约一致', ['api-session/added', 'api-session/activity', 'api-session/removed']
  .every((name) => index.includes(`'${name}'`)))

console.log(failures.length === 0 ? '全部通过' : `未通过：\n - ${failures.join('\n - ')}`)
process.exit(failures.length === 0 ? 0 : 1)
