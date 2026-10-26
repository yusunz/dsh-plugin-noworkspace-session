# dsh-plugin-noworkspace-session

为 DeepSeek Harness 增加**未分组（无工作区）会话**：点一下就开一个不占用任何项目工作区的会话，输入区仍是 DSH 原生那一个——模型选择、权限、附件、斜杠命令全部照旧。

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/yusunz/dsh-plugin-noworkspace-session)

## 为什么需要它

DSH 的输入区要求会话属于某个工作区；未分组会话在原生判定里是"空白会话"，输入区会被禁用。本插件在创建会话后，**临时**把它挂到与它自己工作目录同名的工作区上，让原生输入区可用；你发出第一条消息后，这个临时工作区被删除，会话落回**未分组**并照常保留、可恢复。

## 入口

| 位置 | 说明 |
|---|---|
| 新会话行右侧 | 一枚「不在工作区中工作」按钮，与原生工作区选择框、Agent 预设同一行；原生控件保持原生，未被替换 |
| 右侧栏「开始」页 | 一张「非工作区会话」卡片，与「工作区文件 / 新建终端 / 浏览器」并列 |
| 右侧栏「更多」菜单 | 同一入口的次级菜单项；点开是一页说明，可在其中直接创建 |

几处动作一致：新建会话 → 临时挂载 → 原生输入区可用 → 首条消息后回到未分组。已经处在无项目任务空白会话时，新会话行上的按钮会自动隐藏（右栏卡片仍可作为再次新建的入口）。

## 工作目录

每次新建会话都会在工作目录下创建 `<YYYY-MM-DD>\<HH-MM-SS>` 子目录并作为该会话的 cwd，因此每个未分组任务互不干扰。会话 id 由 DSH 自己铸造，插件不自定义 id。

默认位置：`~/Documents/dsh`（可在设置里改）。

- **不留残留**：点了按钮却没发消息就切走，临时分组立刻消失；磁盘上那个空目录会在**下次启动 DSH 时**被回收。目录里只要有文件（代理写过东西）就永远不会被删。
- 会话本身从不被删除。

## 设置

**设置 → 通用设置 → 无项目任务文件夹**：显示当前路径，支持「更改」（宿主原生目录选择框）与「重置」（回落默认 `~/Documents/dsh`）。修改写入当前 profile 的配置并立即生效，之后新建的会话立即使用新位置。

路径必须是**绝对路径**（目录选择器给出的即是）；手写在 profile 配置里的相对路径不受支持。

## 安装

在应用内用插件管理器安装，或在命令行：

```bash
# npm
dsh plugin --profile desktop add dsh-plugin-noworkspace-session

# GitHub
dsh plugin --profile desktop add github:yusunz/dsh-plugin-noworkspace-session

# 本地 tarball
dsh plugin --profile desktop add /absolute/path/to/dsh-plugin-noworkspace-session-0.3.0.tgz
```

安装后**重启 DSH**（宿主半代码只在进程启动时加载），随后**硬刷新页面**（Ctrl+Shift+R）以确保取到新的客户端 bundle。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-plugin-noworkspace-session
```

然后在应用内用插件管理器移除 bundle 并刷新页面。已创建的未分组会话不会被删除。

## 已知限制

- **右侧栏不能承载会话**：DSH 的右侧栏整套注册都绑定「当前会话」，标签页是文件 / 浏览器 / 终端这类面板类型，没有渲染对话面的座位。所以卡片点击后是在**主视图**打开会话。
- 放弃的空白会话回到未分组后遵循 DSH 原生规则：空白会话在侧栏不可见（有了消息才会作为普通会话显示）；它留下的空目录在下次启动时回收。
- 若任务目录下的 `<日期>\<时间>` 已被手工注册为工作区，插件不会接管它：该会话保持未分组（输入区不可用），以免删掉你自己的分组。
- 首条消息直接输入即可；附件走原生链路。
- 「更多」菜单里点开的说明页只做入口说明与创建，不会在右栏内嵌对话。

## 兼容性

- 目标：**DSH 0.2.1-rc.3 及以上**（`package.json` 的 `engines.dsh` 已声明）；桌面版与 Web 版均可。`conversation.hero.options` 座位自 DSH 0.2.1-alpha.4 起提供，旧版没有该座位。
- 依赖：`@deepseek-ai/schemastery`（DSH 自带，随插件声明，版本跟随宿主）。
- 只在 `conversation.hero.options`、`settings.general.item`、`sidebar.right.tab.guide.entry`、`sidebar.right.pane.tab` 这类**增量座位**上注册，不替换任何 DSH 原生控件。

## License

MIT

---

## English

Adds **sessions without a workspace** to DeepSeek Harness: one click opens a session that occupies no project workspace while keeping DSH's own composer (model, permissions, attachments, slash commands). The session is temporarily attached to a workspace named after its own directory so the native composer unlocks; after your first message that temporary workspace is removed and the session lands under **Ungrouped**, resumable as usual. Entry points: a button at the right end of the new-session row, a card on the right sidebar's start page, and the same entry in the sidebar's More menu. Each session gets its own `<date>\<time>` working directory; empty ones are reclaimed on the next DSH start, and a directory holding files is never touched. Requires DSH 0.2.1-rc.3 or newer (`engines.dsh`). Install with `dsh plugin --profile desktop add dsh-plugin-noworkspace-session`, then restart DSH and hard-refresh the page. MIT.
