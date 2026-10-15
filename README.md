# dsh-plugin-noworkspace-session

在新会话的工作区菜单（hero 区域的 workspace chip 下拉）中增加一项「不在工作区中工作」，用于创建**未分组（无工作区）会话**；并在「设置 → 通用设置」中提供仿 Codex 的「无项目任务文件夹」设置项。

## 功能

1. **Hero 工作区菜单新增入口**：顶替 `conversation.hero.workspace` 插槽（`priority: -1` 遮蔽原生实现），菜单在「添加工作区…」之后追加「不在工作区中工作」。
2. **首条消息可用**：未分组空白会话在原生 hero 中输入框被禁用（`inert`）。本插件向 `conversation.composer` 链注册一个 selector 条目，仅当会话属于本插件（`session-nws-` id 前缀）且为空白时当选，渲染一个可用的首条输入框；首条消息发出后 `blank` 翻转，链自动落选，原生 composer 无缝接管。
3. **通用设置行**：「无项目任务文件夹」显示当前默认目录，「更改」调用宿主原生目录选择框，「重置」回落 schema 默认值。值持久化到 profile 的 `cordis.patch.yml`（经 `configForms` 镜像）。

## 会话目录结构

新会话的 cwd 为 `<默认位置>\<YYYY-MM-DD>\<HH-MM-SS>`，由 Host 侧 `session.create` 递归创建（`agent.ts` 中 `mkdir(cwd, {recursive: true})`），无需 browse 后端的目录原语。`~` 前缀在浏览器半用 `ctx.remote.$host.home` 展开。

默认位置：`~/Documents/dsh`。

## 安装

通过 `plugin_manager` 的 `install_bundle` 安装本目录，然后刷新 Web GUI 页面。

## 文件

| 文件 | 职责 |
|---|---|
| `index.js` | Host 半：声明 `Config`（`defaultDir`），抑制自动生成的设置页 |
| `client.js` | 浏览器半：picker 顶替、composer 链条目、设置行 |
| `cordis.patch.yml` | Loader patch：insert 一条 `noworkspace-session` row |

## 已知边界

- 未分组会话的会话日志仍由 DSH 统一存放在 `~/.dsh/sessions/` 下（按 cwd 编码分桶），本设置只影响会话的工作目录。
- 会话重命名不会重命名磁盘上的时间目录。
- 首条消息通过 `ctx.remote.session.prompt` 直发（`mode: 'queue'`），不经过本地回显；消息在 durable 事件到达后出现在对话流中。
