# Changelog

本文件记录 dsh-memory-archive 的所有显著变更。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-09-12

### Added

- **并入提示词查看器**（原独立插件 `dsh-prompt-viewer`）：两半代码搬进本包，成为**单包自包含**，
  **不再依赖那个插件**。宿主半侧新增第二条同源路由 `prefix /dsh-memory-archive/prompt`
  （`/health`、`/api/sessions`、`/api/sessions/resolve`、`/api/session`、`/api/part`），
  客户端新增「提示词 → 每次请求」子页 —— 看**每次模型请求真正发出的全文**。
- **真名解析**：工作区模式下读工作区根的 `catalog.json`
  （`playthroughs[].title` / `.ext.pmpDshTavern.characterName` / `.rootSessionId`），
  以 `<archive>/manifest.json` 兜底；会话名三级回退
  （`title` → 周目反查（如「影子 · 1周目」）→ 8 位截断 id），每级如实标注来源；
  **界面不再显示完整 UUID / 完整 sessionId**。
- **阅读优先界面**：
  - 面板放大到 `min(1280px,96vw) × min(860px,92vh)`，支持**全屏**与**键盘翻页**；
  - 顶栏撤掉常驻的根模式单选；**设置降为次级视图**（带「返回阅读」）；
  - 阅读区**连续滚动**：摘要按楼序拼成长文；原文按需顺序懒加载，未发给模型的楼层**如实标注**；
    会话事件按 200 条一页自动追加；`surface` 如实标记。
- **提示词面板**：新增「压缩指令」与「收纳占位」两个可编辑子页
  （`null`/空串 = 恢复内置默认），面板内解释这两段提示词**各自的作用**；
  新增接口 `GET/PUT /dsh-memory-archive/api/templates`；
  配置新增可选段 `prompts: { compaction, placeholder }`（缺省 = 用内置默认，老配置兼容）。

### Fixed

- ★ **会话列表此前从不带 `?titles=1`**：宿主 `/sessions` 默认走**刻意的快路径**、标题一律为 `null`
  ⇒ 界面只能显示会话 id。现在带上该参数
  （真机实测 62/70 有标题、70/70 有 `updatedAt`，且比默认路径更快）。

### Changed

- 移除「会话搜索」阅读源（玩家侧检索用浏览器 Ctrl+F 即可）；`摘要` / `原文` / `状态` 与会话事件不受影响。

## 计划中（未实现）

- **编辑功能**：直接修改摘要正文、楼层正文与状态档案。当前版本只读；先做编辑需要先定「改哪一份真相源」与回滚策略。
- **占位符收纳执行器**：把老楼替换成一行占位节点（占位模板已在面板里可编辑，但尚无执行器）。
- **CSS 兼容**：支持自定义 CSS / DSH 主题变量覆盖；当前只用系统色与内联样式，尚未支持用户自定义 CSS。

## [0.1.0] - 2026-09-12

### Added

- **两种根模式**（可在面板里切换，选择持久化在配置里）：
  - **会话模式**（默认）：手动选定一条 DSH 会话为根，经宿主半侧**精确读**取其事件日志；
    原版 DSH 纯净环境即可用，**零额外依赖**。
  - **工作区模式**：以 Tavern 工作区里某个周目的 `archive/` 为根（`floors/` / `summaries/` / `state/`）。
    依赖 `pmp-dsh-tavern`（已声明为**可选** peer 依赖）；未安装时该模式置灰并说明原因，不会崩溃。
- **自有控制面板** —— 侧边栏一个齿轮按钮打开记忆库**自己的**面板，**不占用 DSH 设置页**：
  - **配置**：根模式切换与根选择、API 设置、连接测试、诊断；
  - **浏览**：随根模式切换 —— 会话模式给事件列表（含 `surface` 标注与分页），
    工作区模式给 `摘要` / `原文` / `状态` / `会话搜索`。
- **用户自配 API**：`接口地址` / `模型` / `密钥`。密钥**永不回显**
  （宿主只回 `keySet` 与末 4 位提示；留空表示不修改，另有单独的清空动作）；
  `保存` 后回读校验，`测试连接` 真发一次最小请求。
- **宿主半侧 `lib/index.js`**：配置存储
  （`<DSH_HOME 或 ~/.dsh>/dsh-memory-archive/config.json` —— 权限 0600、原子写、
  读坏回落默认值并如实上报）+ 同源 HTTP API（前缀路由 `/dsh-memory-archive/api`，6 条接口）。
- **浏览器半侧 `lib/client.js`**：工厂形式 CJS，只 `require('react')`，**无 JSX、无需构建**。
- **文档**：中文 `README.md` 与英文 `README.en.md`；`docs/DESIGN.zh.md` 说明设计思路与实现逻辑
  —— 其中记录了本插件如何**复用 DSH 自身的压缩机制**（而不是自研压缩或另建存储）。
- `LICENSE`（MIT）、`.gitignore`（★ `lib/` 是发布产物，**不**忽略）、`CHANGELOG.md`。
- `scripts.check`：`node --check lib/index.js && node --check lib/client.js`。

### Notes

- **本插件是只读的**：它不修改会话日志、不修改任何会话、不写检索索引 ——
  只读会话与归档；唯一的写入是它自己的那一个配置文件。
- **两条降级路径**：宿主 API 不可用时面板不白屏（浏览区退回工作区模式）；
  `pmp-dsh-tavern` 缺失时工作区模式置灰而非失败。
- `surface` 拿不到时**如实填 `null`**，从不从事件类型猜测。

[0.2.0]: https://github.com/vv5v5/dsh-memory-archive/releases/tag/v0.2.0
[0.1.0]: https://github.com/vv5v5/dsh-memory-archive/releases/tag/v0.1.0
