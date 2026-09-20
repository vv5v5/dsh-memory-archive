# Changelog

本文件记录 dsh-memory-archive 的所有显著变更。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

> 提示词重整（第一批）：**身份句改写模块** + **装配注入口径按用户定稿调整**。纯调试阶段。

### 2026-09-20（状态剥离 · 向量页签 · 压缩链修复 · skill 重塑 · README 重写）

- **Added｜自带的 RP 预设并进本仓**：`preset/`（装配文件 + README + **`install.mjs`**）+ `preset-modules/anima-rag.js`
  （薄壳：让 `dsh-anima-rag` 那一行随预设目录走，运行期按 `DSH_HOME → profiles/*` 解析真包，解析不到就大声抛错）。
  `install.mjs` **默认 dry-run**，文件清单**从装配 YAML 现扫**（清单只有一份、不会漂），`mt-compaction-rp.js` 现场生成，
  已存在且内容不同的文件先备份 `.bak-<时间戳>`。自检：`_selftest-preset-install.mjs`（20 条）。
  ⇒ 预设**不再单独一个仓库**（原先那个本地仓库 `dsh-roleplay-preset` 已归档）。
- **Removed｜状态子系统整体剥离**：删掉 `state-bridge` 子包与其在宿主/预设两处的挂载、`state:card` 段（order 50）、
  5 个 `state_*` 工具与对应放行名单；状态改由**周目笔记 `state.md`** 承载（维护要求写在文件自己开头，模型用
  `memory_write` 维护）。旧数据改名归档（`l1-state.removed-20260920/`），⛔ 没有直接删。
  自检：新增 `_selftest-state-removed.mjs`。
- **Added｜「向量」页签 + 宿主两端点**：记忆库面板第四档（与摘要/原文/剧情大纲平级）——本库体检行
  （总数 / 属于本周目 / 被隔离排除 / 两个库在不在 / 上次入库结果 / 快照落后多久）+ 两行库（`⚠缺失` / 重建 / 删除）
  + 一个「参与检索」开关。`lib/vector-panel.js` 只做两件事：读状态快照、写**请求单**；真正的库归 `dsh-anima-rag`
  （按会话挂载）⇒ 动作由它在下一轮装配前执行，回执写回来。端点：`GET /vector/state`、`POST /vector/action`。
- **Fixed｜压缩后端不许用哈希私有成员**（真机事故）：cordis 把服务对象包成可追踪 Proxy，而 ES 私有成员
  （`#x`）过不了 Proxy ⇒ 每次 `/compact` 都在 1 毫秒内抛 `Receiver must be an instance of class …`，
  现象是"压缩按钮没反应"。→ 私有方法挪成模块级函数；自检台新增第 8 节**守真机挂载的那份副本**（含与仓库生成物逐字节比对）。
- **Changed｜技能工具**挂回来**了，改成"在目录那条上明写"**（真机：「重启了还是有 skill 注入」→ 同日用户的
  第二次口径：「**那不用摘掉。需要的是明确注明**」）：
  先说清机制（这一版没变）：技能目录 `<available_skills>` **只在 `@deepseek-ai/dsh-tool-skill` 被解析到时才发**
  （`tool-skill/src/index.ts:85-88`），是**每会话一次**以 user 消息塞进上下文的（`source.kind='skill-catalog'`），
  里面每条渲染成 `- \`<name>\`: <description>`。⇒ **挂了就发目录；不挂就连目录带工具一起消失**，没有第三种状态。
  · 同日早先那一版为此**摘掉了** `preset/agent.cordis.yml` 里的 `- id: tool-skill`（实测确实 0 注入）——
    但用户不要"消失"，要"把话说明白"，于是**挂回来**，注释也改成"为什么必须挂"。
  · ★ 关键约束：description 会被宿主**截断**（`catalogDescription`：压空白 → 超长就 `slice(0, max-3)+'...'`，
    `tool-skill/src/index.ts:390-393`；预设里把 `catalogDescriptionMaxLength` **显式钉成 500**）
    ⇒ "三条必知事实"必须排在**前 500 字以内**，摆后半段等于没写（上一版的 RP 禁令就排在最末尾 —— 目录里根本看不见）：
    ① 由 `dsh-memory-archive` 插件注入；② 用途 = 插件的**配置 / 安装 / 报错**；③ ⛔ **RP 模式请勿调用**。
    写在三处：`lib/index.js` 的 `SKILL_DEFS[].description`（目录那条就看得见）+ `skill/rp-assistant/SKILL.md`
    正文开头（万一真被加载）+ 预设 §三 工具清单里的 `skill` 那行。
  ★ 自检：`_selftest-skills.mjs` ③b 重写 —— **照抄宿主的截断函数**（不照抄就是我自己想象的窗口），
    钉"三条都在前 500 字以内" + "正文里也有"，外加三条反证（注明推到 500 字后必红 / 剪掉 RP 禁令必红 /
    剪掉「由 … 插件注入」必红）。
  ★ 真机实测（新建一条 roleplay 会话、发一轮；⛔ 探针会话与临时脚本用完即删）：`skill-catalog` 事件 **1 条**，
    目录里**只有我们这一条**（`rp-assistant`）；渲染出来的那一行里**三条事实都在**（描述 282 字，**没触发
    500 字截断**，`source.entries[0].description` 与渲染文本逐字一致）；工具面 **8 个**
    （`anima_query / ask_user_question / glob / grep / memory_write / read / skill / web_search`）；
    `tool/call` 里 `name==='skill'` **0 次**。
    ⚠️ 生效方式：**预设改动**新会话即生效（stamp 换代）；但**描述来自宿主插件**（`lib/index.js` 的注册）
    ⇒ 这一版**重启过宿主**（pid 35240 → 31384）。
- **Changed｜人设段顶层新增「第零节」：每一轮开演前先读 `index.md`（用户口径：「加一个需要先读 index 的硬性要求，
  放在顶层」）**：加在 `@deepseek-ai/dsh-persona` 的 `config.prefix` 里、**身份句之后、第一节之前**，写明它
  **优先级高于其余各节**。内容：先看 `<memoryHome>` 段有没有出现 ⇒ 出现了就以 `read` `index.md` 作为本轮
  **第一件事**（先读本局周目目录那份，没有再看共用预置那份），**读完没变也要读**（`index.md` 按设计只有几行，
  买的是"每轮都站在同一份事实上"）；`index.md` 不在（新周目）⇒ 按第四节先建四份笔记再开演；`<memoryHome>`
  **没出现**（会话未归周目）⇒ ⛔ 不猜路径、不写盘，先用 `ask_user_question` 问清。
  ★ 顺带**去掉一处重复**：第四节旧的第 4 条（"新会话开始…读它、说记忆已恢复、问继续还是新开"）**并进了第零节**，
  原处只留一行指路 —— 两处各写一份迟早会漂。
  ★ 真机实测（新建 roleplay 会话、发一轮；探针会话与脚本用完即删）：第零节**在 system 里**、**排在第一节之前**
  （偏移 135 vs 875，段长 740 字符），工具面仍是 8 个。
  ⚠️ 这一条改的是**预设**⇒ **不用重启宿主**，新会话即生效。行为那半边（模型真的每轮先 `read` `index.md`）
  只有**已归入周目的会话**才看得到 —— 本机裸会话不带 `<memoryHome>` 段，验不到，留给真机扮演时看。
- **Fixed｜`rp-assistant` 的 RP 禁令在合并 skill 时被弄丢了（真机）**：老的那个 `config-kb` 描述里原本写着
  「⛔ 角色扮演（RP）会话里不要调用本技能：演故事时不需要、也不许碰配置与源码 —— 只有用户明确在问
  "装得对不对 / 怎么改配置"时才用」，2026-09-20 把两个 skill 合并成一个时**这句没带过来** ⇒ 技能目录
  （`<available_skills>`，由 `@deepseek-ai/dsh-tool-skill` **每条会话一次**以 user 消息里的 `<system-reminder>`
  塞进上下文）里那条读起来"RP 里也相关"（真机自检会话里，模型确实**犹豫过**要不要加载它，虽然最后没调）。
  ⇒ **禁令写回两处**：注册的 `description`（模型看目录那条就看见）+ `SKILL.md` 正文开头（万一真被加载，
  第一眼就看见，并写明"被误加载就先说明再回到角色"）。
  ⚠️ 实测结论供参照：**全机近 30 小时、所有会话里 `tool/call` 且 `name==='skill'` 的 0 次** —— 它从没被真调用过；
  这条禁令防的是"目录那行诱惑模型去想它"。自检：`_selftest-skills.mjs` 新增 ③b（两处都要有 + "剪掉禁令必红"的反证）。
  ⚠️ 生效：技能注册在宿主插件里 ⇒ **要重启宿主**；且目录是**会话开始时**写进历史的 ⇒ 老会话改不掉，新会话才有。
- **Fixed｜`rp-tool-scope` 的日志在 MCP 逐条握手时刷屏（真机："scope 地狱又回来了"）**：
  它的打印按「全局数/挡掉数/白名单」**指纹**去重，可 **MCP 握手时全局表是一条一条地长**
  （真机实测 `16 → 44` 一路 +1）⇒ 指纹每次都变 ⇒ 光一次握手就刷几十行。
  ★ 先核了**不是泄漏**：全局表本来就随 MCP 上下线涨落（同日各会话分别见到 `12 / 14 / 55 / 76`），
  `44` 已接近全量（29 chrome + 8 glm + …），而**模型实收的工具面始终是 8 个**（收窄没坏）。
  ⇒ 改法：**打印按稳定态防抖**（`logSettleMs` 默认 2500ms，自检台可压到毫秒级）——指纹变了只重置计时器，
  静下来打**一行**，并带上这段时间里全局表摆动过的区间与被折叠的次数（⛔ 不隐瞒它涨了多少）；
  收工（作用域销毁）时把攒着的那行**补打**，⛔ 不因为防抖把信息吞掉。
  ⚠️ **收窄本身一点没变**（该调的 `restrict()` 一次不少），变的只是**什么时候说话**。
  自检：`_selftest-rp-tool-scope.mjs` 新增 S6/S7/S8（连打 11 次 ⇒ 1 行带区间；对照：每次等窗口 ⇒ 5 行；
  收工补打），并**在旧文件上验证新判据是红的**。生效方式：下一个**新建 RP 会话**（⛔ 不用重启宿主）。
- **Fixed｜「剧情大纲」档：新周目既没有按钮也没有状态（真机）**：那一档的**打开文件夹**原来只在
  "目录已经存在"时才渲染，而新周目**两处落点都还没建** ⇒ 按钮不出现、内容也是空 ⇒ 用户既看不到落点、
  也没有入口去放东西（而"预部署"恰恰要在新周目开局前把文件放进去）。
  现在：落点**一行一个**（周目目录 / 跨周目共用那份），`empty` 与 `ready` **两支都给**，
  每行各自 `在 · N 份` / `还没有`，按钮按情况分三种文案 ——
  「打开文件夹」（在）／「**创建并打开**」（周目目录不存在 ⇒ 宿主按需 `mkdir`：那是我们的写面）／
  「打开工作区根」（共用那份不存在 ⇒ **绝不建**（社区预设的地盘），退而打开工作区根让你自己放）。
  `POST /playthrough/reveal` 随之收**枚举** `{base}`（⛔ 仍然一个路径都不带；认不出就 `RP_MEMORY_BAD_BASE`），
  回执多两个如实字段 `created` / `fallbackTo`。`GET /playthrough/rp-memory` 的每个候选多一个 `fileCount`。
  自检：`_selftest-client.mjs` 那条重写（含"挖掉 empty 支的落点块必红"）；`_selftest-rp-memory.mjs`
  T17b 改成"只认枚举 base"、新增 T17e/T17f（只给周目目录 mkdir + 反证）。
- **Fixed｜会话同时属于两个周目时判错（真机：`for-session` 解析到了别的角色）**：口径改成
  **「根会话」归属优先** —— 「这个会话是某周目的 `rootSessionId`」比「它只是被某条 timeline 引用
  （继续 / 分支 / QA variant）」硬得多 ⇒ 根**顺序无关、永远赢**；两个都不是根时才按 catalog 顺序（先到者胜）。
  `conflicts` 照旧如实列出。真机事故：一条会话是**影子·12周目**的 root、又在 **Rika·1周目** 的 timeline 里
  当 variant 切片 ⇒ 旧的"先到者胜"判给了 catalog 里更靠前的 Rika·1周目 ⇒ 面板跟着绑过去、笔记目录/归档楼层/
  检索**全指到一个空周目**（用户看到的就是"怎么还是没用 roleplay-memory"）。两侧索引一起改
  （`dsh-memory-archive` 与 `dsh-anima-rag` 各一份 `session-playthrough.js`）。
- **Changed｜落点统一：`<memoryHome>` 同时给出「能提前放」的那一处**（用户口径「先统一落点」）：段里除了
  **本会话周目的笔记目录**（唯一可写处），还会列出**跨周目共用的预置资料**目录（= 工作区根下的
  `.roleplay-memory/`，**只读**，开局参考用）。为什么只能提到这儿：周目目录名带**新建时才有的 UUID**
  ⇒ 建立前唯一能放东西的地方就是工作区根。⛔ 那份**不进 `memory_write`**（否则各周目写串味）；
  ⛔ 目录不存在时**不写进段**（不报不存在的路径）。配套预设三处文案同步（§一 段说明 / §四 放置原则 /
  §五-4 新会话开始），并加了"两处都读、只写周目目录"的规矩。
- **Changed｜「哪个周目」收成一条口径：会话优先，认不出来的会话当新会话**（用户口径原话，真机事故触发）：
  事故是**开一条新对话，它绑的是上一轮的 `.roleplay-memory`，还把上一轮的归档楼层注进了提示词**。根因是「哪个周目」
  在全局只有一处真相 = 面板绑定 `config.root`（**不按会话存**），而解析它有**两套兜底口径**：
  `memoryHomeFor()` 会话优先→回落 config；`rootPlaythroughDir()/rootFloorsDir()/echoArchiveSource()` 只看 config。
  ⇒ 一条**还没被 Tavern 的 catalog/timeline 认领**的新会话（`for-session` 回 `source:'none'`）就被当成"上一轮"：
  `mt:memoryHome` 把**上一轮的笔记目录**写进提示词、`memory_write` 会**静默写进上一轮的周目**、最近几楼/回响的语料
  读的是 config 那个周目、anima 的检索与入库也按面板绑定走。
  现在：**会话能在 catalog/timeline 里认出周目 ⇒ 用它；认不出 ⇒ 没有周目**（注入停、写盘停，全都如实说）。
  `config.root` 降级为**面板的视图选择**（手动选根看别的周目照旧），⛔ 不再给任何注入/写盘路径当兜底。
  落点：`sessionPlaythroughOf()`（新，全局唯一入口）+ `sessionPlaythroughDir()`（新）；`memoryHomeFor` 去掉兜底；
  `rootFloorsDir`/`echoArchiveSource` 收 `sessionId`（语料跟会话）；最近几楼的**门**也换成会话判据
  （旧门是 `catalog ∪ config.root.sessionId`，会与语料指两个周目）；`dma:echo` 补"认不出 ⇒ 清空缓存不回响"；
  `memory_write` 认不出时**拒写**并给可读原因（⛔ 不替它落到上一轮）。面板：顶栏新增一行**本会话周目态**
  （认得出给真名 / 认不出红字「本会话：未归入周目 ⇒ 注入与笔记停用」），「向量」档未归入时也有一条自己的红字。
  配套（`dsh-anima-rag`）：`isolationPlan` 与入库目标解析的兜底传空串 ⇒ 认不出**不检索、不入库、不注最近总结**
  （fail-closed），删掉已无调用方的 `boundPlaythroughId()`。
  自检：`_selftest-session-playthrough.mjs` 新增第 ⑤ 节（10 条，含"换回 `rootPlaythroughDir()` 必红"的反证）、
  `_selftest-ingest-kick.mjs` K3c–K3e、`_selftest-playthrough-isolate.mjs` 第 ⑦ 节、`_selftest-client.mjs` 顶栏两相 + 反证。
- **Changed｜「向量检索 API」卡拆成两套完整接口**（用户口径「两个模型都要有接口」）：向量与重排**各**一套
  「接口地址 / 模型名 / 密钥」—— 两个模型可以落在**不同服务商**上，那正是拆开的原因。`retrieval` 新增
  `rerankUrl` / `rerankKey`（`publicConfig` 另给 `rerankKeySet`/`rerankKeyHint`/`rerankKeyInherited`；
  ⛔ 两组密钥都只写不读）。**向后兼容**：`rerankUrl` 空 ⇒ 沿用 `url`、`rerankKey` 空 ⇒ 沿用 `key`
  —— 老配置一字不用改、行为一字不变。地址推导：向量 = `url` + `/embeddings`；重排 = `rerankUrl` + `/rerank`
  （已经以 `/rerank` 结尾就不再拼 —— 拼两次会变成"重排永远不通"，那类静默失败最难查）。
  `POST /retrieval/test` 随之**两个模型各测一次**、分别如实各报一行（⛔ 不再"只说测试成功却只覆盖向量那一半"）；
  两个都没配全仍是 400 且**一个请求都不发**。消费端 `dsh-anima-rag` 的 `applyRetrievalConfig` 同步改口径
  （且只改 `url` 时**不覆盖**显式填的 `rerankUrl`）。自检：两侧各加一节（宿主侧用**两个独立假端点**证"各打各的"，
  外加兼容 / 去重 / 不发请求三条反证）。全量门 **64/0**。
- **Fixed｜工作区根（角色 / 周目）下拉「切不动」（真机）**：两个下拉的显示值取自 `disc`（**自动发现挑的那个**），
  而不是**已保存的绑定** ⇒ ① 打开面板时显示的就跟真实绑定不是一回事（逐条实测：绑定 `70a0502d…/…0256fcac`，
  下拉却显示 `5c04213e…` 的周目）；② 每次保存后 `reload()` 会 bump tick ⇒ 发现结果重算 ⇒ 显示值被重置回自动挑的那个
  —— 用户看到的就是「切了又弹回去」。修正：显示值一律**优先取绑定**（`config.root`，与「根会话」下拉同一口径），
  没绑定时才退回自动发现；绑定指向的 id 若已不在工作区 ⇒ **照样列出来并标「⚠ 不在工作区」**（⛔ 不再静默显示成别的项
  —— 那正是这次误会的来源）；「无归档」徽标改为跟着**显示的那一行**走（`discoverWorkspaces` 新增逐行 `archiveMap`）；
  另加一道「本面板手动选过就不再自动跟随」的闸（跟随只在挂载时问一次会话归属，手动选择必须赢过它）。
  自检：`_selftest-client.mjs` 新增两条渲染断言（含"绑定不在工作区"与"徽标跟显示行走"的反证）。
- **Changed｜摘要输入只看对话**（用户口径：只传玩家发言 + AI 最终正文）：摘要后端不再原样转发重放前缀
  （`input.messages[0]` 就是整个系统提示词，含注入的近场原文 ⇒ 摘要会变成"原文的二次摘要"），
  改走过滤：思维链、工具调用/结果、系统提示词、插件注入一律摘除；正文包进 `<text_to_summarize>`、
  历史 checkpoint 抠成 `<previous_summary>`；`input.tools` 也不传。自检：4b 节 13 条 + **4c 节 8 条真装配截获**。
- **Changed｜压缩后端改挂预设目录内的相对模块**（为能换台机器）：`./mt-compaction-rp.js`（由本仓库生成，
  用 `产物/memory-tools/_materialize-preset-modules.mjs --apply` 铺盘）；配套自检守"预设目录那份必须在、
  且与仓库逐字节一致"。旧的独立插件改名归档。
- **Changed｜收纳时机**：除"该轮末收一次"外，新增**压缩成功后延迟收一次**（手动 `/compact` 不产生 turn/end，
  只靠轮末会让那份摘要永远进不了库）；归属门一个字没松。
- **Changed｜skill 重塑成一个**：原来两个（`rp-assistant` + 只给模型的 `config-kb`）合并为**一个** `rp-assistant`：
  正文保留原「说人话的工作流」，并带上**资料基准目录**（`resourceBase`）指路三份资料
  （本包 README / 酒馆 README 快照 / 检索插件 README 快照 / 平台内部事实与踩坑集）。
  ⛔ 演故事时不读这些；只有用户在问"装得对不对 / 怎么改配置"时才用。
- **Docs｜README 重写 + 英文版下架**：中文 README 按当前真相重写（四档面板、每轮注入表、PHI 的两处清洗、
  两个可选依赖、已知限制）；`README.en.md` 删除（16KB 已过时 ⇒ 避免两份真相），`package.json` 的 `files` 同步。

### Added

- **面板跟随当前会话（打开即跳转）+ 只读查询端点 `GET /playthrough/for-session?sessionId=…`**
  （20260919，用户口径「点开记忆库要自动跳转到对应周目」）：面板打开时问一句"这个会话属于哪个周目"
  （宿主读 Tavern 的 `catalog.json` + 每个周目的 `timeline.json`，纯函数核心见 `lib/session-playthrough.js`），
  查到就**把绑定改过去**（`PUT /config` 的 `root.{characterId,playthroughId}`）—— 改**绑定**而不是只改显示：
  面板读的档、面板里「收纳/导入」写的、后台自动收纳，三处都读同一个绑定，于是口径全都对得上。
  ⛔ 只在 `source==='session'` 时动；查不到（非 Tavern 会话 / catalog 读不到）**一个字都不改**（保持原绑定）；
  本次打开跟过就不再写（`followRef` 防 reload→effect 来回写）；跟随失败绝不影响面板。
  为此把 `sessions` 加回客户端 inject（**不是**搜索类阅读源回来了，是跟随要拿当前会话 id）。
  自检：`_selftest-session-playthrough.mjs`（17 项：纯函数真值表 + ★真机锚〔真实 catalog 断言每个周目的
  rootSessionId 映射回自己〕+ 端点四相〔命中/不认识/缺参数/响应不含路径〕）；
  `_selftest-client.mjs` 新增「面板跟随」断言（含"只在 source=session 才动""端点只此一处""不重复写"）。
- **后台收纳提示条 + 只读端点 `GET /anima/ingest-state`**（20260919）：dsh-anima-rag 在后台收纳
  （它现在**按活跃会话的周目**入库）时会把状态落 `<DSH_HOME>/dsh-anima-rag/ingest-state.json`；
  本插件读它并投影成端点，客户端在 **`shell.overlay`**（DSH 官方推荐的 frame-wide 叠加席位，
  `ui-renderer/registry.ts:40` 原话「register into `shell.overlay` instead (a list slot: additive…)」）
  上挂一条小提示：收纳中显示「记忆库正在后台收纳当前会话…」，跑完 ≤6s 显示一句结果，其余不渲染。
  ⛔ 端点只投影白名单字段（不吐原始文件、⛔ 不吐任何路径）；挂载期 5s 低频轮询、卸载即停。
  自检：`_selftest-anima-state.mjs`（6 项，含"坏类型不猜""文件坏掉如实报错""不吐路径"三条反证）；
  `_selftest-client.mjs` 新增收纳提示席断言（含"该端点只许出现一次""空闲不渲染""卸载停轮询"）。
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
