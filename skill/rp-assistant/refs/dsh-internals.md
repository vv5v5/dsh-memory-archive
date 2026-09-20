# DSH 内部事实与踩坑集（本项目的"事实库"）

> 读者是**执行配置/架构类改动的 AI 助手**。这里每一条都是**一手实测或官方源码原文**，不是推测；
> 每条尽量给出「出处」与「怎么自己再验一遍」。⛔ 不许凭感觉发挥。
>
> ★ 本文件是 [`rp-assistant`](../SKILL.md) 的资料之一（2026-09-20 起，原来是独立的 `config-kb` skill）。
> **什么时候读它**：用户在问「装得对不对 / 怎么改配置 / 为什么没生效 / 换台机器还能不能用」这类问题时。
> ⛔ **演故事的时候不需要它**，也不要在 RP 会话里去翻配置与源码。
>
> 许可：CC-BY-NC-4.0（详见仓库 LICENSE）；移植来源 anima-rag (<https://github.com/Ellinav/anima-rag>) 作者 Ellinav。

---

## 0 先记住三条纪律（都是踩出来的）

1. **别人说"改好了"不算证据**。只认你自己在真机上跑出来、读得到的东西。
   常见两种假象：「自述全绿、实际没生效」以及「检查报红、但其实是检查自己错」。
   ⇒ **自己的工具报 FAIL 时，先怀疑工具**（假阳性比真问题更常见）。
2. **看源码 ≠ 看运行的东西**。宿主加载的可能不是你改的那个目录（见 §7「旧副本」陷阱）。
   判断"跑的是哪份代码"要用**差分标记**：挑一个只在你的新版里存在的字符串/字段，去活宿主上验它。
3. **数字要标单位**。`String.length` 是**字符数**，字节数要 `Buffer.byteLength`。
   中文内容 UTF-8 下两者差很多（实测同一份 bundle：242456 字符 = 279783 字节）。
   标错单位最后会变成别人查不出来的悬案。

---

## 1 三层隔离：东西该放哪一层

| 层 | 作用域 | 住哪 | 谁写 |
|---|---|---|---|
| **profile** | 整个宿主进程 | `$DSH_HOME/profiles/<name>/`（`node_modules/` + `package.json` 的 `dsh.profile.bundles`） | 用户 / 市场安装 |
| **preset** | 一个 agent preset | `$DSH_HOME/.agent-presets/<id>/`（`agent.cordis.yml` + 可选 `preset.yml`） | 用户（★ 本插件 2026-09-19 起**不再**替用户写预设） |
| **realm** | `isolate` 出来的服务实例域 | `agent.cordis.yml` 里 `cordis:group` + `isolate:` 声明 | preset 作者 |

★ **工具面（tool face）的收窄来自 preset scope，不是 realm。** 别把两件事混为一谈：
- `restrict({deny})` 写在 preset 的插件行里 ⇒ 收窄**继承来的全局工具**（见 §4）
- `isolate` ⇒ 让同名服务（如 `compaction`）在各 preset 之间有独立实例，互不可见

出处：`packages/preset/agent-presets/README.zh.md:12,119`。

---

## 2 组装落点：system 块里的 order 表

`packages/core/system-prompt/src/index.ts:121-153` 定义了段的 order；`section()` 只校验 `order` 是有限数
（`:433-435`）。关键锚点：

| order | 段 |
|---|---|
| **-1000** | `HARNESS_IDENTITY`（内置的 "You are an AI agent powered by DeepSeek Harness."，`:412`） |
| -900 / -800 | `HARNESS_SOURCE` / `WEB_SURFACE` |
| **0** | `DEPLOYMENT_PERSONA` ← ★ RP 身份（IDENTITY）落这里，所以它天然在最前 |
| 500 | `PLAN_POLICY` |
| 1000–5000 | 各 `TOOL_*` 说明 |
| 9000 | `DELIVERABLE_FILE_REFERENCES` |
| **9900** | `STRUCTURED_OUTPUT` ← ★ 所以"静态核心规则落最末尾"取 **>9900**（本项目取 10201+） |

★ 用户口径原话：「**只要结果是在消息的最末尾就行**」⇒ 核心规则放 system 块末尾。
**RP 那一侧的实际段分布**见表 §12 原则 4。

**自己再验一遍**：不要只断言"文本里有 10201"（那是**文本级**断言，常量里写着就过）。
要**真 import 生成物、用假 ctx 调 `apply()`，断言 `systemPrompt.section` 实收的 `{name, order, text}`**。
★ 这一步能抓出"生成的模块少了 `inject:['systemPrompt']` ⇒ 宿主根本不调它"的。

---

## 3 注入缝：哪条是"每轮"，哪条会**写进历史**

| 缝 | 语义 | 能不能放每轮内容 |
|---|---|---|
| `systemPrompt.section()` | 每轮重新组装 system | ✅ 正确用法 |
| `system-prompt/assemble` 瀑布 | 每轮、可 async、返回值权威 | ✅ 正确用法（要改写 `assembly.sections`） |
| `systemPrompt.context()` | **写一条 durable `user/message`** | ⛔ 放每轮内容 = 污染会话历史 |
| `agent/pre-step` | 同上，durable | ⛔ 同上；★ 除非你**故意**要一次性写一条 |

出处：`packages/agent/agent-loop/src/agent.ts:291-293`（pre-step 改写的 messages 会被逐条 `session.append('user/message', …)`）。

★ **一次性写**是合法用途（例如"在用户第一条消息之后追加一条指令"），但必须**刻意**、有幂等保护，并明白它会**永久留在记录里**。
本项目的「角色卡后处理指令」就是这类**故意**用法：DSH 的 system 段做不到"文末注入"，只能拿 user 消息模拟
（代价：它在每轮之间积累 ⇒ 提示词查看器里标红、不计楼层，记忆库不收它）。

---

## 4 工具面收窄（`restrict`）的正确姿势

`ctx.tools.restrict({ deny: [...] })`：

1. **层是相交+追加的**：再调一次 `restrict({deny: []})` **不会**撤掉上一层。⇒ 撤层必须用返回的官方 disposer。
2. **只对"收窄"有用的是 `deny`**：`allow` 不能点名 realm 本地的工具（deny 只由全局视图算）。
3. `run_code` 是**保留传输层**，不能出现在 `deny` 里。
4. ★ **失败要 fail-closed**：装新层成功之后再撤旧层；撤层失败就**不动**记录，让下次 `tools/change` 自动重试。
5. ★ **deny 名单可能被"晚注册"击穿**：MCP 之类在启动后才注册工具。⇒ 除了 deny，还要订阅工具表变化并**重算**。

**已知缺口**：某些第三方守卫（如 Tavern 的 `rp-mode.js`）只覆盖自己认识的工具名，**不覆盖 `mcp__chrome__*`**。

**判决通道**：要证明"这个会话到底能拿到哪些工具"，唯一可靠的证据是会话日志里的
`request/header.header.tools` —— 那是模型真实收到的清单。
（注意：会话日志是**多个 zstd 帧拼接**的，`zlib.zstdDecompressSync` 只解第一帧，会得到一段截断内容
—— ★ 这就是"183 字节"那种假结论的来源；要逐帧解。）

---

## 5 preset 的创作边界

**官方原文**（`packages/preset/agent-presets/src/preset.ts:3-8`）：

> A `system` preset ships with the deployment; a `user` preset was authored locally,
> **by a person or by an agent**, and therefore carries the same trust as shell access.

⇒ ① **agent 创作 user preset 是设计内行为**，不是越界；
② ★ 但它的信任等级是「**与 shell 同等**」——所以任何"自动创建/改写 preset"的动作都要有可见的确认与可回滚路径。

**官方对"写"的限制**（`src/authoring.ts:8-11`）：只许"整目录复制已有 preset"（`copyComposition`），
那是给**远程/浏览器侧**调用方立的规矩；宿主侧插件自己写文件是另一回事。
★ 本项目**已经不做这件事了**（2026-09-19 退役写入面）：预设目录由用户自己维护。

**官方接口**（`@deepseek-ai/dsh-agent-presets`）：`scanRoot` / `discoverPresets` / `copyComposition` /
`deleteComposition` / `readComposition` / `writableRoot`。
**实测拒绝码**：id 被占 / id 含 `../` / 不合 `^[a-z0-9][a-z0-9-]*$` ⇒ `agent-preset/invalid`；动随部署自带的 ⇒ `agent-preset/read-only`。

---

## 6 ★ 组成里的"插件名"怎么写，决定能不能换台机器跑

`src/specifier.ts` 的 `classifyRowSpecifier()` 把每行 `name` 分四类：

| 形态 | kind | 解析基准 | 可移植性 |
|---|---|---|---|
| `cordis:xxx` | `builtin` | 不解析 | ✅ |
| `./xxx.js` | `preset` | **预设自己的目录**（"the preset ships the file"） | ✅ **唯一与机器无关的形态** |
| `file:` / 绝对路径 | `file` | stat 一个文件 | ❌ 机器相关 |
| 裸包名 `@scope/pkg` | `package` | 从已安装的 harness 基往上找 `node_modules/<pkg>` | ⚠️ 只对该基下装着的包成立 |

**校验是硬的**：`scanRoot()` 逐行解析，任何一行解析不到 ⇒ 该 preset **仍在名册上但 `broken`**，原因精确到行名与包名。
⇒ ★ **"装了一个插件" ≠ "预设能跑"**。好消息是它**可见、不静默**。

**实测（dev checkout 形态）**：以 `process.argv[1]`（`apps/cli/src/bin.ts`）或 `apps/cli/package.json` 为锚点 ⇒
官方包解析得到；**checkout 根当锚点 ⇒ 一个都解析不到**（pnpm 只把 workspace 包链进**消费者**的 node_modules）。
★ 这条同时是"怎么让一个住在没有 node_modules 的目录里的脚本拿到官方包"的答案：**用正在运行的宿主自己当锚点**。

---

## 7 ★ 发现是"无缓存"的 ⇒ 新建 preset **立刻**生效

`src/index.ts:96` 原文：*"Discovery is unmemoized: `list()` and `resolve()` re-read the roots on every [call]"*。
实测：不重启宿主新建 preset 目录，`/agent/detect` 立刻能列到它。
⚠️ 但 **roots 本身是"派生一次"的** ⇒ 改 roots 配置可能需要重启/recompose。

### 7.1 同名陷阱：宿主加载的可能是**旧副本**

`<profile>/node_modules/<包名>` 若是**真目录**（而不是指向仓库的 junction），它**从不跟着仓库更新**，
而宿主照样能启动、照样能用 —— 只是跑的是旧代码。
**识别**：`lstatSync(p).isSymbolicLink()`；**判定**：差分标记（见 §0.2）。
★ 本项目用的是"**同步脚本 + 逐字节复检**"（`_sync-plugin-deploy.mjs --apply`）来消灭这个陷阱。

---

## 8 压缩（compaction）：那条链为什么容易断

- 官方 `@deepseek-ai/dsh-compaction-basic` 的摘要指令是**硬编码的英文工程模板**，配置键集合里**没有 `customInstruction`**，
  且 `resolveConfig()` 第一件事是 `validateKeys(...)` ⇒ **给它传未知键不会生效**。
- 官方留了**唯一一个扩展点**（`compaction-basic/src/index.ts:231` 原话）：
  *"Override this sole hook for a template or remote summarizer."* ⇒ 覆盖 **`summarize()`**。
- 正确做法：写一个 `compaction-basic` 的**子类**，只覆盖 `summarize()`，其余（压力阈值、保留策略、token 计量、
  `/compact`、溢出恢复）**全部继承官方**；把它放进 preset 的 `isolate` 组里与别的 preset 互不可见。

### 8.1 ★★ 子类里**不许用哈希私有成员**（`#x`）—— 2026-09-20 真机踩的

cordis 把**服务对象包成可追踪 Proxy**（`context.ts:74` → `reflect.ts:141 getTraceable` → `utils.ts:117 createTraceable`；
方法取值再经 `createShadowMethod`，`thisArg` 被换成 shadow —— **仍是 Proxy**）。
而 **ES 哈希私有成员过不了 Proxy**：`this.#x` 会先做品牌检查 ⇒ 抛
`Receiver must be an instance of class X`。
官方 `compaction-basic` 全文件**零个 `#`**，所以它经 Proxy 一路正常；**子类一旦用了 `#`，第一次压缩就炸**
（现象 = 「压缩按钮没反应」，实际每次都在 1 毫秒内失败）。
⇒ **给服务子类加成员一律用公开属性 / 模块级函数**。复现：用宿主自带的 cordis 跑一个最小复刻即可。

### 8.2 ★ 摘要后端拿到的 `input` 长什么样（2026-09-20 核实）

- `buildSummarizationInput`（`region.ts:530-545`）返回 `{ tools?, messages }` ——
  **`messages[0]` 就是整个系统提示词**（surface node 0 的 `system/message`，为复用 KV cache 前缀）；
  **没有** `input.system` 这个字段（写它是空操作）。
- ⇒ 不处理的话，摘要 LLM 会看到**系统提示词里注入的近场原文**，并**去总结它**（真机原话：
  *"The most recent actual RP content I have: recentFloors (楼 0249-0253) and immediateHistory."*）
  ⇒ 摘要变成"原文的二次摘要"。
- 本项目的口径（用户 2026-09-20）：**只传玩家发言 + AI 的最终文本**；思维链、工具调用/结果、
  系统提示词、插件注入一律摘除；历史 checkpoint 抠出来当 `<previous_summary>`；
  正文包进 `<text_to_summarize>`（让指令点名的标签真的存在）。**`input.tools` 也不传**。
- 另一处易错：`createUserMessage(...)` 的构造不带 `source` 也合法（运行时只 spread 角色与内容）。

推荐做法：指令作为**最后一条 user 消息**追加，让这次辅助调用成为上一次真实请求的**前缀延长**（复用 KV cache）——
★ 但**它与会 8.2 的取舍是冲突的**：本项目选择"只看对话"（放弃前缀复用）。

---

## 9 沙箱与真机（怎么安全地验）

- **沙箱** = 另一个 `DSH_HOME` + 另一个端口。隔离是成立的。
- ★ 起沙箱时**必须**让 `profiles/node_modules` 指向真机安装依赖（cordis 等由它供给），**插件本体要各装各的**（否则就是 §7.1）。
- ⛔ 不要把沙箱的 presetsRoot 指向一个含 **junction 指向真机 preset** 的目录（写它等于写到别的地方去；动手前 `lstatSync` 看一眼）。
- ⛔ 起第二个宿主时**别加载**会做启动对账的插件（例如把其它宿主的运行中任务改判为失败的桥）。
- ⛔ 夹具 preset 里若挂了会**写真实状态**的第三方插件（检索库、状态机），**不要在该沙箱里起真实会话**。

---

## 10 踩过的具体坑（按"症状 → 真因"列）

| 症状 | 真因 |
|---|---|
| 宿主拒收配置：`file is not valid JSON` / `Unexpected token '﻿'` | 文件带了 **UTF-8 BOM**（PowerShell 的 `Out-File -Encoding utf8` 会带） |
| `set "VAR=..."` 嵌在 `cmd /c` 的字符串里被截断 | Windows **嵌套引号**：Node 因空格而整体加引号 ⇒ 内层引号提前闭合 |
| 用 `statSync()` 读 junction 的 mtime，得到的是**目标目录**的时间 | `statSync` **跟随**符号链接；读链接本身要用 `lstatSync` |
| 备份文件的 mtime 不是备份那一刻 | Windows 上 `copyFileSync` **保留源文件 mtime**（要判定就用文件名里的 stamp） |
| "替换全部成功"之后文件里还有旧串 | 工具的成功消息也是**自述**。改完**必须 grep 复核** |
| 抽样报 PASS 但其实什么都没扫 | **真空通过** ⇒ 加 `scanned > 0` 门槛 |
| 「干跑零写入」断言写成"同一时刻取两次快照相比" | 那是**恒等式 = 橡皮图章**。必须**调用前后**各取一次 |
| 验收器报 401，但接口其实是好的 | `fetch` **没有 cookie 罐**，`?token=` 是 **303 重定向** |
| 用 `require.resolve(包名)` 判断"包装没装上" | 宿主不用它：宿主是 `resolve.paths()` + `existsSync(dir/package.json)`。**判据要与消费者同源** |
| 会话日志解出来只有一小截（"183 字节"） | 它是**多个 zstd 帧拼接**的，`zstdDecompressSync` 只解第一帧 ⇒ 要**逐帧解** |
| 压缩后端抛 `Receiver must be an instance of class …` | 子类用了哈希私有成员（见 §8.1） |
| 摘要里出现"原文的二次摘要" | 摘要 LLM 看到了系统提示词里的注入段（见 §8.2） |
| 检索一条都召不回，但库明明有 51 条 | **周目隔离**：库里切片带的 `pt:<周目>` 与当前绑定不是同一个（见 §13） |

---

## 11 想更权威时去哪里读

| 想确认 | 读 |
|---|---|
| system 段 order 表 | `packages/core/system-prompt/src/index.ts`（`SECTION_ORDERS`） |
| preset 发现/信任/创作边界 | `packages/preset/agent-presets/src/{preset,discovery,authoring,specifier}.ts` |
| 组装文件怎么被挂载、`isolate` 语义 | 同包 `src/mount.ts`、`README.zh.md` |
| 技能注册与 `/` 源（含 `resourceBase`） | `packages/skill/skill/src/index.ts`（`SkillDefinition` / `renderSkillContent`） |
| 压缩的扩展点与输入形状 | `packages/compaction/compaction-basic/src/{index,config,summarizer,region}.ts` |
| 工具面收窄 | `packages/core/tools/src/`（`restrict` 与 disposer 契约） |
| profile/bundle 解析 | `packages/boot/app-boot/src/profile.ts` |

---

## 12 RP agent 优化的 8 条原则（每条可自己复验）

> ★ 适用对象：**只动 `trust === 'user'` 的 preset**（`~/.dsh/.agent-presets/` 下用户自带的那些）。
> 随部署附带的 preset 官方语义只读（`agent-preset/read-only`，见 §5）——一个字节都不许改。

### 原则 1 · 注入只走「不写历史」的两条缝

**原则**：每轮注入（检索记忆 / 占位行 / 最近几楼）只允许用 `systemPrompt.section()` 与 `system-prompt/assemble`。
⛔ 禁用 `systemPrompt.context()` 与 `agent/pre-step` —— **除非你刻意要一次性写一条**（本项目的「角色卡后处理指令」
就是这样一处，见 §3；它有幂等保护、且在查看器里标红、不进记忆库）。

**事实/出处**：`agent-loop/src/agent.ts:291-293` 逐条落盘；`systemPrompt.context()` 是 durable user-role 快照，
文本一变就往历史追加一条（实测：某个第三方插件在长 RP 里基本每轮追加 ~2k token 重复快照）。
`section()` 与 `assemble` 不落盘，每轮重算、只影响本轮请求。

### 原则 2 · 压缩只在 `summarize()` 一个钩子上扩展；遮蔽必须精确覆盖

**原则**：改压缩行为只允许覆盖 `summarize()`；要遮蔽走 `session.append(..., { surfaceOp:{op:'replace',start,end} })`，
且 `sourceEventSeqs` **必须精确覆盖**被遮蔽的全部 surface 节点，否则**当场抛错**。
★ 子类成员不许用 `#`（§8.1）。

**事实/出处**：官方源码原话 *"Override this sole hook for a template or remote summarizer"*；
surface 遮蔽语义见 `core/session/src/surface.ts:64-67, 241`。宁可少遮一段，不许错位。

### 原则 3 · 占位行必须带该段关键词

**原则**：被收纳段落原位留下的占位行**必须包含该段的关键词**（专有名词/地名/物品名逐字保留）。

**事实/出处**：世界书条目靠「关键词在上下文里出现过」触发，而扫描的正是**压缩之后的 surface**
（与本项目「收纳占位」模板解释同源）——老楼被替换后关键词就不再参与触发；这也是压缩指令里
「专有名词逐字照抄」那条规则的硬理由。

### 原则 4 · 各段 order 的真实分布（不许另造）

| 段 | order | 注入方 |
|---|---|---|
| harness identity | **-1000** | DSH 核心（`system-prompt/src/index.ts:122` 的 `SECTION_ORDERS`） |
| persona（部署/agent 人设） | 0 | DSH persona（`DEPLOYMENT_PERSONA`） |
| `mt:memoryProtocol` | 1 | 记忆库（`dsh-memory-archive`） |
| `mt:memoryHome` | 2 | 记忆库 |
| preset（ST 预设归一化段） | 10 | `pmp-dsh-tavern`（profile 层） |
| `rp:policy` | 45 | `pmp-dsh-tavern`（profile 层） |
| `dma:echo`（本地记忆回响） | 54 | 记忆库 |
| `anima:memory`（检索记忆） | 55 | `dsh-anima-rag` |
| 工具说明 | 100–199 | DSH 核心 |
| `STRUCTURED_OUTPUT` | 9900 | DSH 核心 |
| `DEPLOYMENT_PERSONA_SUFFIX` | 10200 | 官方槽位（尾段起点） |
| `rp:firstRound` | 10201 | 记忆库 |
| `mt:lastFloors` | 10202 | 记忆库 |
| `mt:postHistory`（尾段/后处理指令位置） | 10203 | 记忆库 |

★ 校对注：`HARNESS_IDENTITY` 是 **-1000**（官方 `SECTION_ORDERS`），不是 "≈ -100"。
★ 旧表里的 `state:card`（order 50）已随**状态子系统整体剥离**（2026-09-20）消失；状态现在由周目笔记 `state.md` 承载。

### 原则 5 · ★「可回捞」不等于「可回滚」

**原则**：日志是 append-only、原文随时可读回（**可回捞**）；但 surface 投影**撤不回**（**不可回滚**）——
要回到折叠前的可见状态，只能从折叠前的回合 fork 新会话。

**事实/出处**：`core/session/src/surface.ts` 的遮蔽只改「模型可见面」投影，事件日志本身不可变。
给用户做任何压缩/遮蔽操作前，必须先讲清这条差别。

### 原则 6 · ★ 不设 `persona.complete: true`

**原则**：为 RP preset 改写 persona 时**不要**设 `complete: true`（也不要 `includeRuntimeContext: false` 之外的侥幸组合）；
用「persona 遮蔽部署人设 + 一条显式忽略指令」压制 harness 文本就够了。

**事实/出处**：`system-prompt/src/index.ts:601-610`：complete 覆盖发生在 `system-prompt/assemble` waterfall **之后**
⇒ 连"在 waterfall 里改写 `assembly.sections`"也救不回来，**每一轮的注入段会被一次性废掉**。
附带事实：两个 complete section 并存时装配**直接抛错**（`:576`），换来只是抹掉一句 ~8 token 的 harness identity。

### 原则 7 · ⛔ 不许删工具说明

**原则**：不许删模型可见的 harness identity / persona / 工具文字说明来「省 token」。

**事实/出处**：删掉模型可见的这些文字会让 Code Mode 或结构化输出**失效**。收窄工具面的正确做法是
**组装层不挂那一行**（工具根本不进 catalog），而不是删掉留在场上的说明文字。host 层工具（profile 层挂的）
任何 preset 都删不掉，只能靠 host 层守卫兜底。

### 原则 8 · 改完的生效方式：`recompose`，拿不到就明说

**原则**：preset 文件改完后优先调 `agentPresets.recompose(agentCtx, id)` 让改动在不重启的情况下生效；
**拿不到该服务就明说「需要新开会话 / 手动切换才生效」，绝不假装已生效**。

**事实/出处**：`agent-presets/README.zh.md:173` —— *"会话一旦产出任何内容便无法更换 preset"*；
所以「改 preset 文件」与「让现有会话用上」是两回事。**插件代码的改动**同理由宿主启动时加载 ⇒ 通常要重启宿主。

### 行动红线（违反任何一条就停手）

1. 只动 `trust === 'user'` 的 preset；随部署附带的一律硬拒（`agent-preset/read-only`）。
2. 写入前必须备份（时间戳），写后回读校验，失败自动回滚。
3. `compaction` 整块（compaction-basic + command-compact + tool-result-pruner，含其 isolate realm）**必留** ——
   删行时最容易漏它，漏了长对话必撞上下文窗口。
4. 被 `cordis:group` + `isolate:` 包着的块要么整块留、要么整块删，不能只抄里面的行。

---

## 13 记忆 / 检索链（本项目的两块，2026-09-20 核实）

**分工**：`dsh-memory-archive`（面板 / 注入 / 收纳 / 笔记工具）· `dsh-anima-rag`（向量 + BM25 检索 / 回响 / 入库）。

### 13.1 向量生成的时机只有两处

| 时机 | 做什么 |
|---|---|
| **自动压缩入库时** | 摘要目录一变 ⇒ 把**还没入过**的条目写进库（**向量 + BM25 同一次 `engine.insert`**），账本按"文件名 + 内容签名"防重 |
| **工具 / 检索调用时** | 发现目标集合的向量库**不存在** ⇒ 当场**排队补建**（写一张请求单，下一次装配执行） |

★ 两处都要**给反馈**：给 agent（`anima_query` 的返回里带 `diagnostics`）、给人（状态快照 + 面板回执）。

### 13.2 ★ 两处"静默失效"（都真机抓到、都已修）

| 症状 | 真因 |
|---|---|
| BM25 支线**从来没工作过**：日志 `库不存在，跳过: undefined` | 配置对象传的键是 `collectionId`，而 `lib/bm25.js` 读的是 **`dbId`** ⇒ 解析成 undefined ⇒ `continue`。**不报错、不提示** |
| 检索 0 命中、但库里有 51 条 | 读侧缺库时 `Create: false` ⇒ 直接跳过，一个字都不说；而"库里全是别的周目"这种情况也无人解释 |

### 13.3 周目隔离（为什么"库里有东西却一条都翻不出来"）

- 切片带标签 `pt:<周目id>`；读侧只认**当前周目**的切片，其余**一律进 deny 名单**。
- 拿不到当前周目 ⇒ **本轮不注入**（宁可漏，也不跨周目串味）。
- ★ 真机案例：库 51 条全部带 `pt:playthrough-adacc634-…`，而当时绑定的是另一个周目 ⇒
  `deny 51/51` ⇒ 必然 0 命中。**这不是索引坏了，是绑定与切片的周目不是同一个。**
- 面板「向量」页签的体检行就是给这件事显影的（总数 / 属于本周目 / 被排除 / 两库是否在）。

### 13.3.1 ★★「哪个周目」的口径：**会话优先，认不出来的会话当新会话**（2026-09-20 定）

真机事故：**开一条新对话，它绑的是上一轮的 `.roleplay-memory`，还把上一轮的归档楼层注进了提示词。**
根因：「哪个周目」在全局只有一处真相 = 面板绑定 `config.root`（**不按会话存**），而解析它有**两套兜底口径** ——
一条**还没被 Tavern 的 `catalog.json`/`timeline.json` 认领**的新会话（`for-session` 回 `source:'none'`）
就被当成"上一轮"，于是笔记路径 / 最近几楼 / 回响 / 检索 / 入库全指向上一轮。

现在的口径（**一条，全局通用**）：

| 情形 | 用哪个周目 |
|---|---|
| 会话能在 catalog/timeline 里认出周目 | **它那个**（`source:'session'`） |
| 认不出（新会话 / 非 Tavern 会话 / catalog 读不到） | **没有周目** ⇒ 注入停、写盘停，**如实说** |

- `config.root`（面板「工作区根」）降级为**面板的视图选择** —— 手动选根看别的周目照旧，⛔ 不再给任何注入/写盘路径兜底。
- 落到代码：`sessionPlaythroughOf()` 是全局唯一入口；`rootFloorsDir`/`echoArchiveSource` 都收 `sessionId`；
  `memory_write` 认不出周目 ⇒ **拒写**并给可读原因；anima 侧隔离与入库目标的兜底传空串（fail-closed）。
- ★★ **会话同时属于两个周目时判给谁**（2026-09-20 真机事故）：判给**它是 `rootSessionId` 的那个**，
  判定**与 catalog 行序无关**。真机形状：一条会话是**影子·12周目**的根、又在 **Rika·1周目** 的 timeline 里
  当 variant 切片 ⇒ 旧的"先到者胜"判给了 catalog 更靠前的 Rika·1周目 ⇒ 面板跟着绑过去、笔记目录/归档楼层/
  检索**全指到一个空周目**（现象就是"怎么还是没用 roleplay-memory"）。`conflicts` 照旧如实列。
- ★★ **预部署信息**（「先统一落点」）：`mt:memoryHome` 段除了**本会话周目的笔记目录**（唯一可写处），
  还列出**跨周目共用的预置资料** = `<工作区根>/.roleplay-memory/`（**只读**，开局参考用）。
  为什么只能提到这儿：周目目录名带**新建时才知道的 UUID** ⇒ 建立前唯一能放东西的是工作区根。
  ⛔ 那份不进 `memory_write`（否则各周目写串味）；⛔ 目录不存在时不写进段。
- 代价（有意为之）：**只有经 Tavern「与 X 新开周目」开的会话才有周目**；裸「新建会话」什么都拿不到，
  顶栏会红字标出来，⛔ 不会再偷偷用上一轮。

### 13.4 面板动作的通道

真拥有向量库的是 `dsh-anima-rag`（**按会话挂载**，引擎在它 `apply()` 闭包里），宿主平面拿不到 ⇒
面板只做两件事：**读状态快照**（`vector-info.json`）+ **写一张请求单**（`panel-request.json`）；
anima 在它下一脚（每次装配都会跑的 kick）取走执行，把**回执**（`panel-result.json`）写回来。
★ 一般的教训：**"入库"这件事只能有一份实现**（否则就是两份真相）。
