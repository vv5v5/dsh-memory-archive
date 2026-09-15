# Changelog

本文件记录 dsh-memory-archive 的所有显著变更。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.5.0] - 2026-09-16

> 面板侧收口：**提示词装配地图把每个字段的来路说清**，RP 预设遮蔽掉「给编码 agent 用的定位文字」，
> 模板卡能直接把文本**应用**进预设，自动收纳加了「绑定」这道门。
> ⚠️ 诚实边界：遮蔽作用在**预设作用域**，只对**新开的会话/周目**生效（已在跑的会话留在旧一代装配）；
> 面板侧的注释、灰标、标蓝**刷新即生效**。

### Added

- **RP 遮蔽宿主定位段（预设模块）**：`preset-modules/rp-suppress-host-sections.js` —— 在 preset 作用域里把
  `harness:source`(10000) / `app:web-surface`(10100) / `context:file-reference`(900) /
  `ui:deliverable-file-references`(9000) 注册成**同名空文本**段（上游 `systemPrompt.section()` 契约：
  *作用域内同名段遮蔽全局段*；上游**没有**「注销别人注册的段」的 API）。order 取 `getSectionOrder`
  ⇒ 只换内容不换位置；逐段 `try/catch`、整体**绝不抛**（抛 = 预设挂不上 = 开不了周目）。
- **地图的字段注释表**：按真机实测补齐 18 条，逐条写清「来源 + 作用」；上述 4 段另写清
  「**RP 模式已禁用** ⇒ 占位、不会出现具体内容」，行上加灰标「RP 遮蔽」（**仅当该段确实 0 字**）。
  这几行**照常逐行给出** —— 每段占一个 order，⛔ 不折叠、不隐藏。
- **工具段的两个通道**：`tool:*` 行与抽屉标蓝药丸，并写明 ① 本段 = system 里的说明与纪律
  ② 请求的 `tools` 字段 = 它的 JSON 定义。
- **自动收纳**：加「绑定」这道门（只有绑定过的会话才自动收纳），失败如实播报并落
  `<storageDir>/auto-collect.json`（面板顶栏标红）。
- `_selftest-rp-suppress.mjs`：遮蔽模块的行为自检（8 项，含「把 text 改成非空则判据必红」的反证）。

### Changed

- 模板卡：压缩指令的「保存」改成「**应用**」，直接用 `/agent/apply` 写进预设
  （`writable` 候选过滤 + 应用回读 + 失败带 hint）；「收纳占位」卡改**只读**（它没有可写目的地）；
  撤掉多余的 ⚠️ 提示块与随之而来的空框。
- 段归属收敛成一张表：**按段名前缀认 + 精确名覆盖**（`rp:policy`=上游 pmp-dsh-tavern、
  `rp:storyAnchor`/`rp:firstRound`/`dma:echo`=本插件、`state:card`=本插件子包 state-bridge），
  表里⛔ 不许写 order 数字（数字一律来自捕获）。
- 导入：新增 `lib/import-apply.js`（导入应用路径）与配套字具。

### Fixed

- 服务端错误体解析：`{ok:false,error:{code,message}}` 以前把**整个 error 对象**当成消息 ⇒ 现在取 `error.message`。
- 注释里残留的旧口径（旧版地图把这几段**折叠成一行汇总**；现行是「字段照给 + 注释说清」）已清干净。

### Notes

- 遮蔽的生效范围：**新会话 / 新周目**（预设是会话级换代）；已在跑的会话里那几段仍有内容
  ⇒ 面板**不会**给它加灰标（说真话优先）。
- 自检：**39 套全绿**（含新增的 `_selftest-rp-suppress.mjs`）。

## [0.4.0] - 2026-09-15

> 一轮大版本：**服务端能力补齐 + 三处「读不到」的真机 bug 修复**。
> ⚠️ 诚实边界：收纳（A1/A2）与导入（B1）目前**只有服务端端点，面板还没有入口**（见 Added 末条与 Notes）。

### Added

- **收纳执行器（A1/A2）**：`lib/collect.js`（周目归档写入器）+ `lib/collect-scan.js`（压缩联动自动收纳）。
  端点：`/collect/targets`、`/collect/plan`、`/collect/apply`、`/collect/scan`、`/collect/auto`。
  扫会话里 `surface==='shadowed'` 的区间 → 映射成楼层 → 写进 Tavern 周目归档（台账幂等；⛔ 不碰 DSH 会话文件）。
- **聊天导入适配器（B1）**：`lib/import-formats.js` + `/import/formats`、`/import/plan`（零落库零写入）。
- **本地记忆回响（D2）**：`lib/echo-index.js`（node:sqlite FTS5 trigram 引擎）+ `lib/echo-inject.js`，
  以 `dma:echo`（order 54）注入；语料 = 周目归档楼层原文（摘要只保留原文实体串的 1.6%，故不入库）。
- **D4 标签归一**：`lib/ami-tags.js`（纯函数，被收纳链路引用）。
- **保留第一轮**：`lib/keep-first-round.js`（唯一事实源）+ `preset-modules/keep-first-round.js`（逐字节副本，写进用户预设目录）+ `lib/preset-modules.js`（幂等写面与挂载行）。
- **`state-bridge` 子包**：原独立包 `dsh-state-bridge` 收编为 `dsh-memory-archive/state-bridge`
  （子路径导出 + `cordis.patch.yml` 挂载行；该子目录 MIT、仓库其余 CC-BY-NC-4.0，见 `state-bridge/NOTICE.md`），含原样测试 70 项。
- **查看器**：常驻会话集（用户自己选、后台串行预热轻投影）、会话真标题与预览分离、
  `PROJECTION_VERSION=3`（旧投影自动重热）、批量勾选式选常驻。

### Fixed

- **只带 `session.v3.jsonl.zstd` 的会话整个读不到**（真机实测 6/6）**、带旧文件的会话只读到迁移前的冻结快照**：
  查看器原先按 `<DSH_HOME>/runtime` 里的包名 require 一份 persistence（那份是 0.1.2，只认 `session.jsonl.zstd`）。
  现在统一走**宿主自己的**读取链：活注册表 → 宿主持久化读句柄（`open(id,'read')`）→ `sessionQuery`。
  量化对照（真机同一条会话）：`not found` → 10635 事件 / 99 楼；69 楼（冻结）→ **103 楼**。
- **最新一楼看得到字段、看不到上下文**：v3 起 `request/header` 不再带 `system`，正文改走 `system/message` 事件。
  现在按楼归堆取正文，并**如实标注来源**（`header` | `system/message` | `system/message(prev-turn)` | null）。
- **同一事实两套算路**：`requests` 摘要改为从 `conversation.headers` 派生（此前列表页那列 `systemChars` 恒为 0）。
- **自检不再碰真机数据**：一律使用临时 `storageDir`（此前会用真机插件存储，实测会覆写用户的常驻集）。

### Changed

- 真夹具**改由环境变量提供**（`DSH_ST_CHAT` / `DMA_L1_STATE_DIR` / `DMA_PRESET_SRC` / `DMA_CORPUS_FLOORS`），
  没设就跳过 —— 本包不绑定某一台机器，也避免把本机路径写进仓库。

### Notes

- ⛔ **收纳与导入还没有面板入口**：`lib/client.js` 里 `/collect/*`、`/import/*` 出现 0 次，目前只能用端点调；
  面板接入（含替换 `lib/client.js` 里那句「本插件尚未实现收纳执行器」的过期文案）排在下一版。

## [0.3.0] - 2026-09-14

> 首次面向公开仓库/插件市场的版本：包名改回 `dsh-memory-archive`，与 GitHub 仓库同名。

### Changed

- **改回 `dsh-memory-archive`**（2026-09-14）：包名 / cordis 挂载 id 与 name / 客户端 loader id / 存储目录名 /
  两条路由前缀（`/dsh-memory-archive/api`、`/dsh-memory-archive/prompt`）全部回到本名，
  与 GitHub 仓库名一致（上架插件市场要求"包认领它被收录的那个仓库"）。
  - **兼容**：存储目录在新名目录**不存在**时回退读旧名目录（老用户不会"数据没了"）；两个都在时用新名目录，
    并库由一次性迁移工具做。组装捕获文件只按 `v` 读、文件名里的 `kind` 仅写侧使用 ⇒ 老捕获文件照常可读。
  - **防漂移**：`_selftest-sections.mjs` 新增三条断言 —— 新名优先 / 只有旧名时回退 / 两个都没有时给新名路径，
    且每条都额外断言 `lib/index.js` 与 `lib/sections-capture.js` 两份 `storageDir` **解析结果必须一致**。
- **README 新增「设计思路」**（中英各一份）：① 用原生机制、不污染原生编程架构；② RP 是一个模式、
  与编程模式的工具注册表互不透明、搭配上游 dsh-tavern 做成一站式「agent 酒馆 / 酒馆 agent」；
  ③ **对 DSH 本体一行都没改**（逐条列出用到的官方扩展点）+ 完成度如实标注。
- （历史）2026-09-13 曾把本包改名为 `magictarven`（包名 / id / 路由 / 存储目录同步，行为未变）；
  2026-09-14 已按上条改回 `dsh-memory-archive`。
- **许可**：由 MIT 统一改为 CC BY-NC 4.0（含上游 anima-rag 署名与场景限制；法律正文逐字节照抄上游副本，代码零改动）。

## [0.2.0] - 2026-09-12

### Added

- **并入提示词查看器**（原独立插件 `dsh-prompt-viewer`）：两半代码搬进本包，成为**单包自包含**，
  **不再依赖那个插件**。宿主半侧新增第二条同源路由 `prefix /dsh-memory-archive/prompt`
  （`/health`、`/api/sessions`、`/api/sessions/resolve`、`/api/session`、`/api/part`），
  客户端新增「提示词 → 每次请求」子页 —— 看**每次模型请求真正发出的全文**。
- **真名解析**：工作区模式下读工作区根的 `catalog.json`
  （`playthroughs[].title` / `.ext.pmpDshTavern.characterName` / `.rootSessionId`），
  以 `<archive>/manifest.json` 兜底；会话名三级回退
  （`title` → 周目反查（如「角色名 · 1周目」）→ 8 位截断 id），每级如实标注来源；
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
