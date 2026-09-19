# Changelog

本文件记录 dsh-memory-archive 的所有显著变更。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

> 提示词重整（第一批）：**身份句改写模块** + **装配注入口径按用户定稿调整**。纯调试阶段。

### Added

- **OOC 前缀席（输入栏「OOC」按钮，20260919）**：一键把输入框里的东西标成**场外指令**。
  为什么需要：社区 RP 预设（`oliblue-evan/dsh-roleplay-preset`）的 OOC 契约是**看开头**的
  ——「以 `OOC:` 或 `（OOC）` 开头、或以 `【导演】` 开头的内容是场外指令」；而我们已有的
  「质疑」产出的块以 `> 引用` 开头、标记写的是 `【OOC】`，**两个都不在它的名单里** ⇒
  光按质疑**进不去**它的场外分支。新按钮（席位 `ooc-prefix`，order 89，排在质疑 90 之前）把
  `OOC: ` 放到**整条消息最前面**：空草稿 ⇒ 只放前缀（"激活"，接着写你的场外要求）；有内容 ⇒
  就地标成场外（引用块则让前缀单独起一行，不插进 `>` 里）；**幂等** —— 已有前缀一个字不动。
  ⛔ 与「质疑」同款纪律：只写草稿、绝不替玩家发送、读不到草稿就一个字不写。
  纯函数 `buildOocPrefix`；自检 `OOC·验收5`（含幂等反证、缺 inputActions 禁用、读不到草稿不写）。
- **面板「剧情大纲」档改成只读展示角色扮演预设的记忆库**（宿主端点 `GET /playthrough/rp-memory`，20260919）：
  读社区 RP 预设（`oliblue-evan/dsh-roleplay-preset`）自己写在工作目录下的 `.roleplay-memory/`。
  **纯只读** —— ⛔ 不写、不建、不删、不改名，⛔ 一个字节都不碰那个预设（人家写，我们看）。
  列出**目录里实际有的**（⛔ 不再写死四个名字）：子目录与非文本扩展名不列、只如实计入 `skipped`，
  所以预设哪天多写一份也看得见；排序把预设那四份排在前面（index 打头）。名字必须过路径裁决
  （`rel-path-jail.js`）且目录里真的在 ⇒ 不构成任意文件读入口；清单（不带 `?file=`）**一个字节正文都不读**。
  落点走**候选链**（周目目录 → 工作区根＝会话工作目录）并**如实回报命中的是哪一处**：命中工作区根时
  额外提示「可能被同一工作区的多个周目共用」（这不是我们的 bug，但不说会让人以为数据串了）。
  同一档里我们那份单文件大纲（`OutlineFlow`）**整块退役** —— 面板下半块、宿主端点
  `/playthrough/outline`、配置键 `config.outline.fileName` 一处不留（用户口径「退役吧」）。
  自检：`_selftest-rp-memory.mjs`（19 项：越界/保留名/点开头反证、只读反证〔请求前后字节+目录逐项未变〕、
  「目录里多出来的要看得见」、源码级"体内零写 API"反证）；`_selftest-client.mjs` R1–R3（含"挂载即取数"的灵敏度反例）。
- **`preset-modules/rp-identity.js`**（新）：在 RP 作用域里用**同名段遮蔽**把 DSH 的
  `harness:identity`（order -1000，原文 `You are an AI agent powered by DeepSeek Harness.`）换成
  `You are an AI agent made for role-playing games.`。可经 `config.text` / `config.extra` 改词；
  **拒绝**注册含 `{{名字}}` 的文本（DSH 会拿它当提示词变量、让整轮失败）并告警；认不出安置名退回 -1000；
  ⛔ 绝不抛（抛 = 预设挂不上）。自检 `_selftest-rp-identity.mjs`（5 项，含"带变量必须拒绝"的反证）。

### Changed

- **「质疑」的产出改为以 `OOC:` 单独一行开头**（20260919）：社区 RP 预设（`oliblue-evan/dsh-roleplay-preset`）
  的场外契约**看开头**（`OOC:` / `（OOC）` / `【导演】`），旧形状（`> 引用` 打头 + `【OOC】我的质疑：`）
  两个都不在它名单里 ⇒ 光按质疑进不了场外分支。新形状逐字：
  `OOC:`＋空行＋**原草稿逐字**＋空行＋`> `逐行引用（超 120 字符截断并如实标注，口径不变）＋空行＋`我的质疑：`。
  ① `OOC:` 永远单独占首行；② 原草稿在前缀的下一段，一个字符不许改写/截断/重排（"不许覆盖草稿"纪律照旧，
  读不到草稿一个字不写）；③ 引导行不再挂 `【OOC】`（场外标记由首行承担，预设名单里没这种写法）。
  产出已被前缀幂等判据认出 ⇒ 质疑之后再按「OOC」按钮一个字不动。自检 `_selftest-client.mjs`
  验收2 / buildOocText / buildOocPrefix 三处断言同步（保持逐字/位置判据与反证，未放宽成"包含即可"）。
- **输入栏两颗 OOC 按钮（「OOC」/「质疑」）改成与邻居同一套视觉语言**（20260919）：不再借用面板的
  `.dma-btn`（那是给面板写的规矩），对齐输入栏事实标准 `dsh-restart-button`：28 高幽灵盒（定高 +
  border-box + `0 8px` + radius 6 + inline-flex + gap 5 + nowrap + flex:none，内联样式）；
  交互态改走注入 CSS（新类 `.dma-ooc-btn` —— 自己的 dma- 前缀，⛔ 绝不命中 DSH 自有界面；
  常态 GrayText 透明底、hover `CanvasText` + 6% color-mix、焦点环 1px 内描边、禁用 opacity .55，
  逐条对齐邻居 `.dsrrb-btn`）。主次可辨：「OOC」是主操作，带 14×14 内联 SVG 气泡图标
  （`fill: currentColor` 跟 hover 走，aria-hidden 不进可访问树）；「质疑」纯文字。
  无红、无 emoji、只用系统色；按钮文字/席位 id/order/aria-label 全部未动。
- **「最近几楼」（`mt:lastFloors`）的触发条件：从「首轮空对话」改成「当前上下文 < 5000 字」**
  （2026-09-19 用户口径）：只要本会话**非遮蔽正文总字数**少于 `LAST_FLOORS_CONTEXT_CHARS`(5000)
  就注入，上下文长过阈值就停（不再只看首轮）；默认楼层数 8 → **5**（「注入前五楼的内容」）。
  字数是**带外**算的（`system-prompt/assemble` 里先算再 `next()`、带 `ECHO_PREP_BUDGET_MS` 预算，
  段 provider 仍同步只读缓存）；**算不出来**（刚重启/续跑）时**回退**到旧的"首轮"判据 ——
  判不出就不注，宁可少注一次也不重复喂历史。纯逻辑新增 `contextIsShort`；自检台 L6/L6b/L8
  重写（含 4999/5000/5001 边界反证与"短则注、长则停"的分水岭反证）。
- **v3 组合器的段序按定稿口径改**（`lib/v3-composer.js`）：
  ① 只注入"控制角色"的内容（主要提示词 / 描述 / 性格 / 场景 / 示例）——作者署名一类不注入；
  ② **主要提示词紧跟上面的预设段**（= 我们块第一段）→ 描述/性格/场景/示例 → 世界书命中 → 来源标记
  → **后处理指令放最后**；
  ③ ⛔ **开场白不再注入**（原先是"仅首轮注入 `greeting-reference`"）：它属于"开场那一刻"的消息。
  来源标记里改为如实记一句 `greeting=first-turn(本块不注入开场)`。
  ⚠️ "最后"只能是**我们这一块内的最后**：外部段整体落在 profile 槽位（order 10）——
  想真排到全文末尾得走宿主槽位（如 `deployment:persona-suffix` @10200），本轮不做。

## [0.5.2] - 2026-09-16

> v3 消费端（Tavern 外部组合 API）：**代码到位、默认关**。开着才接管装配；关着与 0.5.0 完全一样。
> ⚠️ v3 目前只活在 Tavern 的候选分支（`codex/prompt-composition-api-v3` @ `92d5924`，未合并未发布）；
> 正式版 2.2.0 上 `/pmp-dsh-tavern/api/v3/*` 是 404，本插件会**如实降级**（`GET /v3` 回 `TAVERN_V3_UNAVAILABLE`）。

### Added

- **v3 组合器**（`lib/v3-composer.js`）：经 Cordis 服务 `pmpDshTavernPrompt` 注册一个**同步**组合器
  （owner 默认 `dsh-memory-archive`）。会话被显式切成 `external` 后由我们产出命名段：
  卡字段（system-prompt / description / personality / scenario / message-example）、**本轮命中**的世界书条目
  （命中判定读 `runtime.worldBookAudit…decisions`，读不到就退回候选集并在来源标记里**如实写明**）、
  后置指令、**仅首轮**的开场（`runtime.greetingReferenceApplies`）、一行 `[external-composition owner=… v=…]` 来源标记。
  ⛔ 不做（诚实边界）：ST 完整 marker/宏策略、`prompt_order` 重排、深度注入精确插入位、token 预算裁剪。
- **`GET /v3`**：capabilities + 本会话 mode + sources **摘要**（卡 id/名、开场序号与语义、各字段字数、世界书计数、
  suggestedCallConfig、revision）+ 我方组合器状态（含 `needsHostRestart`）。⛔ 只回投影，不回卡片正文。
- **`POST /v3/mode`**：显式切 builtin/external（先读 revision 做 CAS；**必须 `confirm:true`**；409 的两种原因如实提示）。
- **维护抽屉里的「v3 外部组合」面板**：上面这份投影 + 三个显式动作（启用我方组合器 / 切到 external / 切回 builtin）。
- 两个自检台：`_selftest-v3-composer.mjs`（12 项，含"退回候选集必须标注""改判据必须红"两条反证）、
  `_selftest-v3-panel.mjs`（8 项，含"卡片正文不进面板""没注册不许显示成已生效"两条反证）。

### Notes

- **默认关**（`config.v3.composer.enabled=false`）：今天卡字段/世界书明细靠 `pmp-dsh-tavern:profile`
  + `/api/v1/traces` 已经够用，v3 是"换活法"不是修 bug。改这个开关要**重启宿主**（注册发生在插件加载时），
  `/v3` 投影里的 `needsHostRestart` 会如实说。
- 组合器走**软注入**（`ctx.inject([...], cb)`）：硬 `inject: ['pmpDshTavernPrompt']` 的插件在 Tavern 被卸载后
  会让整个 Host 起不来（沙箱实测：`1 entry did not activate`）。
- `callConfig` 默认**不回传**（上游"推荐回传还是省略"那一问未定前的保守选择，可开 `echoSuggestedCallConfig`）。
- ★ **三个只有真机才暴露的集成陷阱**（已写进代码注释并各有自检钉住，也已回帖上游 issue #3）：
  1. **段文本里的 `{{名字}}` 会被 DSH 插值**（只认 `provider`/`model`/`cwd`）⇒ 卡片示例里的 `{{user}}`
     让整轮**直接失败**。Tavern 把卡原文原样交给组合器 ⇒ **宏由我们负责**：`{{char}}`/`{{user}}` 用
     `runtime.macroContext` 展开（值为空就留空，与内置一致）、解不了的**中和**成不带花括号的词、畸形嵌套兜底拆花括号。
  2. **段对象只许有 `{id, text}` 两个键**：多一个键就 `422 OUTPUT_INVALID`，而报错文案
     （"Sections require unique ids and text"）不指向真因（出处：上游 `prompt-composition.js:224-226`）。
  3. **世界书审计的 `entryId` 是裸 uid**（字符串或数字），而 `loreEntries[].id` 是全名 ——
     只按一种查会**一条都命中不了且不报错**（静默少注入）。现在两种键都收，命中拿不到正文时如实计数
     （来源标记里写 `worldInfo-unresolved=`）。

### Known gaps

- `extensions.depth_prompt` **没进**装配（内置会按 depth 插进消息历史；v1 需要 DSH 侧的插入能力，先不做）。
- ST 完整 marker/宏策略、`prompt_order` 重排、世界书 token 预算裁剪：不做（与上游示例同档的诚实边界）。

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
