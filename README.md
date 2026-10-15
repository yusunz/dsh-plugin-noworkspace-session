# dsh-plugin-noworkspace-session

在 DSH 里创建**未分组（无工作区）会话**，并且用的是 DSH 原生的输入区——不接管、不自绘。

## 功能

1. **入口**：hero 行右侧一枚 chip「不在工作区中工作」（几何照抄原生 chip）。点击后创建一个未分组会话，工作目录为 `<默认位置>\<YYYY-MM-DD>\<HH-MM-SS>`，由 Host 递归创建。
2. **原生输入区**：未分组空白会话在原生的判定里是 `inert`（输入区禁用）。宿主半把该会话临时挂到"它自己 cwd 对应的工作区"上，使原生输入区可用——模型、权限、附件、斜杠命令全部原生。首条消息一落地，这个临时工作区即被删除，会话落回**未分组**。
3. **不留残留**：点击后不打字就切走，分组立即消失；进程崩溃/升级留下的旧挂载由宿主半在启动时回收。
4. **设置行**：「设置 → 通用设置 → 无项目任务文件夹」，显示当前路径、更改（宿主原生目录选择框）、重置；值持久化到 profile 的 `cordis.patch.yml`。

## 实现要点

| 半区 | 文件 | 职责 |
|---|---|---|
| Host | `index.js` | `api-session/added` → 挂载临时工作区；`api-session/activity` → 首条消息后脱离；启动回收遗留挂载 |
| Client | `client.js` | chip（dock 座位；将来 DSH 有 `conversation.hero.options` 时自动迁移到 hero 行内）、等挂载完成后开会话、只删本页自建挂载的清理、设置行 |

原生的 `conversation.hero.workspace` 选择框**不被遮蔽**，保持 DSH 原生实现。

## 安装

通过 `plugin_manager` 的 `install_bundle` 安装本目录 → **重启 DSH 桌面版**（宿主半代码只在重启后加载）→ 页面 **Ctrl+Shift+R**（bundle URL 带 `?rev=` 指纹，但引导 HTML 可能命中缓存）。

## 已知边界

- 首条消息直接在原生输入区输入，附件走原生链路。
- 放弃的 scratch 会话（切走且未发消息）回到未分组；空白会话在侧栏本来就隐藏（DSH 原生规则），会话日志与文件夹都保留。
- 「跟随会话标题」未实现：标题在首条消息之后才生成，而那时临时分组已按设计脱离；磁盘文件夹不可改名（cwd 不可变）。

## 文件

| 文件 | 职责 |
|---|---|
| `index.js` | Host 半 |
| `client.js` | 浏览器半 |
| `cordis.patch.yml` | Loader patch：insert `noworkspace-session` row |
| `交接文档.md` | 面向接手者的现状与坑（含源码依据） |
| `项目日志.md` | 开发过程与决策记录 |
