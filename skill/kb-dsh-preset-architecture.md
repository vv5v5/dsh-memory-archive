# 配置知识库（agent preset 架构 · DSH）

> 读者是**执行配置/架构类改动的 AI 助手**。这里每一条都是**一手实测或官方源码原文**，不是推测；
> 每条尽量给出「出处」与「怎么自己再验一遍」。⛔ 不许凭感觉发挥。
>
> 配套 skill：`rp-assistant`（RP 助手 —— 怎么用这份知识库做事：结构地图 + 结构化优化流程）。
> §12 的 8 条 RP agent 优化原则也归它使用。
> 许可：CC-BY-NC-4.0（详见仓库 LICENSE）；移植来源 anima-rag (https://github.com/Ellinav/anima-rag) 作者 Ellinav。

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
| **preset** | 一个 agent preset | `$DSH_HOME/.agent-presets/<id>/`（`agent.cordis.yml` + 可选 `preset.yml`） | 用户 / **agent**（见 §5） |
| **realm** | `isolate` 出来的服务实例域 | `agent.cordis.yml` 里 `cordis:group` + `isolate:` 声明 | preset 作者 |

★ **工具面（tool face）的收窄来自 preset scope，不是 realm。** 别把两件事混为一谈：
- `restrict({deny})` 写在 preset 的插件行里 ⇒ 收窄**继承来的全局工具**（见 §4）
- `isolate` ⇒ 让同名服务（如 `compaction`）在各 preset 之间有独立实例，互不可见

出处：`packages/preset/agent-presets/README.zh.md:12,119`；实测台子 `_verify-rp-toolface.mjs`。

---

## 2 组装落点：system 块里的 order 表

`packages/core/system-prompt/src/index.ts:121-153` 定义了段的 order；`section()` 只校验 `order` 是有限数
（`:433-435`）。关键锚点：

| order | 段 |
|---|---|
| **-1000** | `HARNESS_IDENTITY`（内置的 "You are an AI agent powered by DeepSeek Harness."，`:412`） |
| -900 / -800 | `HARNESS_SOURCE` / `WEB_SURFACE` |
| **0** | `DEPLOYMENT_PERSONA` ← ★ **rp 身份（IDENTITY）就落这里**，所以它天然在最前 |
| 500 | `PLAN_POLICY` |
| 1000–5000 | 各 `TOOL_*` 说明 |
| 9000 | `DELIVERABLE_FILE_REFERENCES` |
| **9900** | `STRUCTURED_OUTPUT` ← ★ 所以"静态核心规则落最末尾"取 **>9900**（我们取 9950） |
| 60 | 我们自己的「规则书」段（`dma:settings`） |

★ 用户口径原话：「**只要结果是在消息的最末尾就行**」⇒ 核心规则放 system 块末尾。

**自己再验一遍**：跑 `_verify` 类台子时不要只断言"文本里有 9950"（那是**文本级**断言，
常量里写着就过）。要**真 import 生成物、用假 ctx 调 `apply()`，断言 `systemPrompt.section`
实收的 `{name, order, text}`**。★ 这一步能抓出"生成的模块少了 `inject:['systemPrompt']`
⇒ 宿主根本不调它"的。

---

## 3 注入缝：哪条是"每轮"，哪条会**写进历史**

| 缝 | 语义 | 能不能放每轮内容 |
|---|---|---|
| `systemPrompt.section()` | 每轮重新组装 system | ✅ 正确用法 |
| `systemPrompt.context()` | **写一条 durable `user/message`** | ⛔ 放每轮内容 = 污染会话历史 |
| `agent/pre-step` | 同上，durable | ⛔ 同上；★ 除非你**故意**要一次性写一条 |

出处：`packages/agent/agent-loop/src/agent.ts:291-293`。

★ **一次性写**是合法用途（例如"在用户第一条消息末尾追加一条指令"），但必须是**刻意的**、
有幂等保护的，而且要明白它会**永久留在记录里**。

---

## 4 工具面收窄（`restrict`）的正确姿势

`ctx.tools.restrict({ deny: [...] })`：

1. **层是相交+追加的**：再调一次 `restrict({deny: []})` **不会**撤掉上一层。
   ⇒ 撤层必须用 `restrict()` **返回的官方 disposer**。
2. **只对"收窄"有用的是 `deny`**：`allow` 不能点名 realm 本地的工具（因为 deny 只由全局视图算）。
3. `run_code` 是**保留传输层**，不能出现在 `deny` 里。
4. ★ **失败要 fail-closed**：装新层成功之后再撤旧层；撤层失败就**不动**记录，让下次
   `tools/change` 自动重试（"失败不动 lastKey ⇒ 下次事件自动重试"）。反过来写会留下"面具被摘下"的窗口。
5. ★ **deny 名单可能被"晚注册"击穿**：MCP 之类在启动后才注册工具。⇒ 除了 deny，
   还要订阅工具表变化并**重算**。

**已知缺口（别以为收窄就万事大吉）**：某些第三方的守卫（如 Tavern 的 `rp-mode.js`）
只覆盖自己认识的工具名，**不覆盖 `mcp__chrome__*`**。

**判决通道**：要证明"这个会话到底能不能拿到 chrome / pwsh"，唯一可靠的证据是会话日志里的
`request/header.header.tools` —— 那是模型真实收到的清单。
（注意：会话日志是**多个 zstd 帧拼接**的，`zlib.zstdDecompressSync` 只解第一帧，
会得到一段截断内容 —— ★ 这就是"183 字节"那种假结论的来源。）

---

## 5 preset 的创作边界（★ 这条最容易被误解）

**官方原文**（`packages/preset/agent-presets/src/preset.ts:3-8`）：

> A `system` preset ships with the deployment; a `user` preset was authored locally,
> **by a person or by an agent**, and therefore carries the same trust as shell access.

⇒ ① **agent 创作 user preset 是设计内行为**，不是越界；
② ★ 但它的信任等级是「**与 shell 同等**」——所以任何"自动创建/改写 preset"的动作，
   都要有可见的确认与可回滚路径。

**官方对"写"的限制**（`src/authoring.ts:8-11`）：

> The only authoring write is a whole-directory copy of an existing preset.
> **No caller supplies composition text** … so authoring grants no capability the copied preset did not already carry.

⇒ 这是给**远程/浏览器侧**调用方（`remoteExportCopy`）立的规矩：只许"整目录复制已有 preset"。
   宿主侧插件自己写文件是另一回事（本插件就是这么做的，且已有先例）。

**可用的官方接口**（都在 `@deepseek-ai/dsh-agent-presets` 里导出）：
`scanRoot` / `discoverPresets` / `copyComposition` / `deleteComposition` / `readComposition` / `writableRoot`。
- `copyComposition(roots, source, id, name?)`：**整目录复制**（`dereference: true`
  ⇒ 符号链接会被解开，副本**自包含**）、失败自动清干净、**绝不覆盖已存在的 id**。
- `writableRoot()` 取**第一个 `trust==='user'` 的根**；`deleteComposition` 只认 user。

**实测过的拒绝码**（自己再验一遍用得上）：
| 情形 | 错误码 |
|---|---|
| id 被占 / id 含 `../` / id 不合 `^[a-z0-9][a-z0-9-]*$` | `agent-preset/invalid` |
| 删/改随部署附带的 preset | `agent-preset/read-only` |

---

## 6 ★ 组成里的"插件名"怎么写，决定能不能换台机器跑

`src/specifier.ts` 的 `classifyRowSpecifier()` 把每行 `name` 分四类：

| 形态 | kind | 解析基准 | 可移植性 |
|---|---|---|---|
| `cordis:xxx` | `builtin` | 不解析 | ✅ |
| `./xxx.js` | `preset` | **预设自己的目录**（"the preset ships the file"） | ✅ **唯一与机器无关的形态** |
| `file:` / 绝对路径 | `file` | stat 一个文件 | ❌ 机器相关 |
| 裸包名 `@scope/pkg` | `package` | **从已安装的 harness 基**往上走找 `node_modules/<pkg>` | ⚠️ 只对该基下装着的包成立 |

**校验是硬的**：`scanRoot()` 会逐行解析，任何一行解析不到 ⇒ 该 preset **仍在名册上但 `broken`**，
原因精确到行名与包名，例如：
`row "persona": @deepseek-ai/dsh-persona` 解析不到。
⇒ ★ **"装了一个插件" ≠ "预设能跑"**。好消息是它**可见、不静默**。

**实测（dev checkout 形态）**：
- `process.argv[1]`（`apps/cli/src/bin.ts`）或 `apps/cli/package.json` 当锚点
  ⇒ 官方 4 个包（`dsh-persona` / `dsh-compaction-basic` / `dsh-command-compact` /
  `dsh-compaction-tool-result-pruner`）**全部解析得到**
- **checkout 根当锚点 ⇒ 一个都解析不到**（pnpm 只把 workspace 包链进**消费者**的 node_modules）

★ 这条同时是"怎么让一个**住在没有 node_modules 的目录**里的脚本拿到官方包"的答案：
用**正在运行的宿主自己**当锚点（`process.argv[1]` / `cwd`），别用 `import.meta.url`。

---

## 7 ★ 发现是"无缓存"的 ⇒ 新建 preset **立刻**生效

`src/index.ts:96` 原文：

> Discovery is **unmemoized**: `list()` and `resolve()` re-read the roots on every [call]

实测：在活宿主**不重启**的情况下新建 preset 目录，`/agent/detect` 立刻就能列到它，
`trust=user`、`writable=true`。

⚠️ 但 **roots 本身是"派生一次"的**（`index.ts:119`）⇒ 目录变化是活的，
**改 roots 配置**（比如新增一个预设根）可能需要重启/recompose。这一条尚未实测。

### 7.1 同名陷阱：宿主加载的可能是**旧副本**
`<profile>/node_modules/<包名>` 如果是**真目录**（而不是指向仓库的 junction），它就**从不跟着仓库更新**，
而宿主照样能启动、照样能用 —— 只是跑的是旧代码。
**识别方法**：`lstatSync(p).isSymbolicLink()`；**判定方法**：差分标记（见 §0.2）。

---

## 8 压缩（compaction）：那条链为什么容易断

- 官方 `@deepseek-ai/dsh-compaction-basic` 的摘要指令是**硬编码的英文工程模板**，
  配置键集合 `BASIC_COMPACT_CONFIG_KEYS` 里**没有 `customInstruction`**，
  而且 `resolveConfig()` 第一件事是 `validateKeys(...)` ⇒ **给它传未知键不会生效**。
- 官方留了**唯一一个扩展点**（`compaction-basic/src/index.ts:231` 原话）：
  *"Override this sole hook for a template or remote summarizer."* ⇒ 覆盖 **`summarize()`**。
- 正确做法：写一个 `compaction-basic` 的**子类**，只覆盖 `summarize()`，
  其余（压力阈值、保留策略、token 计量、`/compact`、溢出恢复）**全部继承官方**；
  把它放进 preset 的 `isolate` 组里（`isolate: { compaction: true, toolResultPruner: true }`），
  这样与别的 preset 的同名实例互不可见。
- ★ 该后端要读 `customInstruction`，就必须**自己在 `summarize()` 里实现**这个语义。

**性能讲究**：指令作为**最后一条 user 消息**追加，让这次辅助调用成为上一次真实请求的**前缀延长**，
从而复用 provider 的 KV cache，而不是击穿它。

---

## 9 沙箱与真机（怎么安全地验）

- **沙箱** = 另一个 `DSH_HOME` + 另一个端口。隔离是成立的（实测：插件的 `storageDir`
  落在沙箱自己的 `DSH_HOME` 下，真机零改动）。
- ★ 起沙箱时**必须**让 `profiles/node_modules` 指向真机安装依赖（cordis 等由它供给），
  但**插件本体要各装各的** —— 否则就是 §7.1 那个旧副本陷阱。
- ⛔ **不要**把沙箱的 presetsRoot 指向一个含 **junction 指向真机 preset** 的目录
  （实测过一种常见情形：某个预设目录本身就是一条**指向别处**的 junction ——
   写它等于写到别的地方去。动手前先 `lstatSync` 看一眼它是不是链接。）
- ⛔ 起第二个宿主时**别加载**会做启动对账的插件（例如把其它宿主的运行中任务改判为失败的桥），
  否则会弄坏第一个宿主的状态。
- ⛔ 夹具 preset 里若挂了会**写真实状态**的第三方插件（检索库、状态机），
  **不要在该沙箱里起真实会话** —— 会污染真机数据。

---

## 10 踩过的具体坑（按"症状 → 真因"列）

| 症状 | 真因 |
|---|---|
| 宿主拒收配置：`unit 'workspace': file is not valid JSON` / `Unexpected token '﻿'` | 文件带了 **UTF-8 BOM**。PowerShell 的 `Out-File -Encoding utf8` 会带；用 `[System.IO.File]::WriteAllText` 或 `fs.writeFileSync` 写无 BOM |
| `set "VAR=..."` 嵌在 `cmd /c` 的一段字符串里被截断 | Windows **嵌套引号**：Node 因字符串含空格而整体加引号 ⇒ 内层引号提前闭合。用 `windowsVerbatimArguments: true`，或别把 `set` 塞进带空格的一整段 |
| 用 `statSync()` 读 junction 的 mtime，得到的是**目标目录**的时间 | `statSync` **跟随**符号链接；读链接本身要用 `lstatSync` |
| 备份文件的 mtime 不是备份那一刻 | Windows 上 `copyFileSync` **保留源文件 mtime** |
| 想让"新备份与本次操作同时"用 mtime 判定，结果假红 | 改用**文件名里的 stamp**（同一次操作产出的多个留档带同一个 stamp） |
| "替换全部成功"之后文件里还有旧串 | 工具的成功消息也是**自述**。改完**必须 grep 复核** |
| 抽样"目录不存在时依赖闭包扫到 0 个文件"却报 PASS | **真空通过**：加了 `scanned > 0` 门槛 |
| 「干跑零写入」断言写成"同一时刻取两次快照相比" | 那是**恒等式 = 橡皮图章**。必须**调用前后**各取一次 |
| 断言"其它条目一个没动"却报假红 | 我拿**已经被别人改过的现状**当基线。基线必须是"操作前"的状态，并加一条**夹具自检**断言 |
| 验收器报 401，但接口其实是好的 | `fetch` **没有 cookie 罐**，`?token=` 是 **303 重定向** ⇒ 跟到 `/` 时没带 cookie。要么手动跟并带上 `Set-Cookie`，要么直接用自签 cookie 打 `/` |
| 用 `require.resolve(包名)` 判断"包装没装上" | 宿主不用它：宿主是 `resolve.paths()` + `existsSync(dir/package.json)`（`profile.ts:746-751` 明说不依赖包导出 `./package.json`）。**判据要与消费者同源** |
| 把"真机正在用的 preset 坏了"扫出来 | **锚点取错**。`packageInstalled` 是从你给的基往上走，基取成仓库根就全解析不到。基要取**宿主 app 包**那一层 |

---

## 11 想更权威时去哪里读

| 想确认 | 读 |
|---|---|
| system 段 order 表 | `packages/core/system-prompt/src/index.ts`（`SECTION_ORDERS`） |
| preset 发现/信任/创作边界 | `packages/preset/agent-presets/src/{preset,discovery,authoring,specifier}.ts` |
| 组装文件怎么被挂载、`isolate` 语义 | 同包 `src/mount.ts`、`README.zh.md` |
| 技能注册与 `/` 源 | `packages/skill/skill/lib/types/index.d.ts`、`packages/client/ui-skill/src/index.ts` |
| 压缩的扩展点与配置键 | `packages/compaction/compaction-basic/src/{index,config,summarizer}.ts` |
| 工具面收窄 | `packages/core/tools/src/`（`restrict` 与 disposer 契约） |
| profile/bundle 解析 | `packages/boot/app-boot/src/profile.ts` |
| 技能/插件在 base bundle 里的启用状态 | `packages/bundle/base/cordis.patch.yml` |

---

## 12 RP agent 优化的 8 条原则（每条可自己复验）

> 读者是**执行 RP agent preset 优化的 AI 助手**：当用户在「Agent 编辑器」里勾选
> 「启用 RP agent 优化」并请你调整某个 RP agent preset 时，按本节 8 条原则行动。
> 每条都给出**出处/事实**——官方源码带行号、官方 README 原文逐字核对，不许凭感觉发挥；
> 行号都可自己打开对应源码复验。
>
> ★ 适用对象：**只动 `trust === 'user'` 的 preset**（`~/.dsh/.agent-presets/` 下用户自带的那些）。
> 随部署附带的 preset（`standard` / `minimal` / `ptc` / `cordis`）官方语义只读
> （错误码 `agent-preset/read-only`，官方原话 *"it ships with the deployment"*，见 §5）——一个字节都不许改。

### 原则 1 · 注入只走「不写历史」的两条缝

**原则**：每轮注入（状态卡 / 检索记忆 / 占位行）只允许用 `systemPrompt.section()` 与
`system-prompt/assemble` waterfall。⛔ 禁用 `systemPrompt.context()` 与 `agent/pre-step`。

**事实/出处**：
- `agent/pre-step` 改写的 messages 会被 `agent-loop/src/agent.ts:291-293` 逐条
  `session.append('user/message', …)` 落盘——用它注入等于把状态**每轮写进 durable 历史**
  （dsh-state-bridge README.zh.md:41-42 原话写明了这条弃用理由）。
- `systemPrompt.context()` 是 durable user-role 快照：文本一变就往历史追加一条 user 消息
  （实测：dsh-mneme 的 hot memory 在长 RP 里基本每轮追加 ~2k token 重复快照）。
- `section()` 与 `assemble` 不落盘，每轮重算、只影响本轮请求——这是唯一的干净注入面。

### 原则 2 · 压缩只在 `summarize()` 一个钩子上扩展；遮蔽必须精确覆盖

**原则**：改压缩行为，只允许覆盖压缩后端的 `summarize()` 一个钩子；
要遮蔽（把旧内容移出模型可见面）走 `session.append(..., { surfaceOp:{op:'replace',start,end} })`，
且 `sourceEventSeqs` **必须精确覆盖**被遮蔽的全部 surface 节点，否则**当场抛错**。

**事实/出处**：
- 官方 compaction-basic 源码原话：*"Override this sole hook for a template or remote summarizer"*
  （`compaction-basic/src/summarizer.ts`）——压力阈值、保留策略、token 计量、`/compact`、溢出恢复全部继承官方，不要自研。
- surface 遮蔽语义见 `core/session/src/surface.ts:64-67, 241`：replace 是官方给 compaction 用的公开机制
  （原话 *"Used by compaction; any surface-replacing producer may use it"*）；
  `sourceEventSeqs` 与被遮蔽节点不精确对齐时 session 层直接抛错——宁可少遮一段，不许错位。

### 原则 3 · 占位行必须带该段关键词

**原则**：被收纳段落原位留下的占位行，**必须包含该段的关键词**（专有名词/地名/物品名逐字保留）。

**事实/出处**：世界书条目靠「关键词在上下文里出现过」触发，而扫描的正是**压缩之后的 surface**
（与本插件「收纳占位」模板解释同源）——老楼被替换成占位行后，它的关键词就不再参与触发；
所以占位行要自带关键词，这也是压缩指令里「专有名词逐字照抄」那条规则的硬理由。

### 原则 4 · 各段 order 的真实分布（不许另造）

**原则**：注入段排序按下面的真实分布落位，不自创 order：

| 段 | order | 注入方 |
|---|---|---|
| identity（harness identity） | ≈ -100 | DSH 核心（`system-prompt/src/index.ts:408-414` 无条件注册，preset 删不掉） |
| persona（部署/agent 人设） | ≈ 0 | `packages/preset/persona/src/index.ts:57-63`（`DEPLOYMENT_PERSONA`） |
| preset（ST 预设归一化段） | 10 | pmp-dsh-tavern（profile 层，不随 preset 变） |
| rp:policy | 45 | pmp-dsh-tavern（profile 层） |
| state:card（L1 状态卡） | 50 | dsh-state-bridge（`lib/index.js:39, 306-307`） |
| anima:memory（L2 检索记忆） | 55 | dsh-anima-rag |
| 工具引导 | 100–199 | DSH 核心 |

**事实/出处**：即上表各行标注的 `file:line`，官方源码带行号核实，可逐条复验。
注意 persona 的 `complete: true` 会把上面所有段一次性清场（见原则 6 的通道级后果）。

★ 校对注（并入本库时核对官方源码所得）：`HARNESS_IDENTITY` 的 order 在官方
`SECTION_ORDERS` 里是 **-1000**（`system-prompt/src/index.ts:122`，本库 §2 同），上表「≈ -100」是原件笔误；
排序结论不受影响——它仍在所有段之前。

### 原则 5 · ★「可回捞」不等于「可回滚」

**原则**：日志是 append-only、原文随时可读回（**可回捞**）；但 surface 投影**撤不回**（**不可回滚**）——
要回到折叠前的可见状态，只能从折叠前的回合 fork 新会话。

**事实/出处**：`core/session/src/surface.ts` 的遮蔽只改「模型可见面」投影，事件日志本身不可变；
随包 README 设计说明第 1 条同源（*"append-only 事件日志是真相源 ⇒ 任何遮蔽都可逆"*指的是**读回原文**，
不是把 surface 投影复原）。给用户做任何压缩/遮蔽操作前，必须先讲清这条差别。

### 原则 6 · ★ 不设 `persona.complete: true`

**原则**：为 RP preset 改写 persona 时，**不要**设置 `complete: true`（也不要 `includeRuntimeContext: false` 之外的侥幸组合）；
用「persona 遮蔽部署人设 + 一条显式忽略指令」压制 harness 文本就够了。

**事实/出处**（源码级实证，两次独立确认）：
- `system-prompt/src/index.ts:601-610`：complete 覆盖发生在 `system-prompt/assemble` waterfall **之后**
  （`:601-604` 先跑 waterfall，`:608` 才用 `[completeSection]` 覆盖 sections）⇒ 连「在 waterfall 里改写
  `assembly.sections`」也救不回来，状态卡 `state:card` 与记忆 `anima:memory` 的每轮注入会被**一次性废掉**。
- 附带事实：两个 complete section 并存时装配**直接抛错**（`:576`，不是静默覆盖）；
  换来的好处只是抹掉一句 8 token 的 harness identity——收益成本比不成立。

### 原则 7 · ⛔ 不许删工具说明

**原则**：不许删除模型可见的 harness identity / persona / 工具文字说明来「省 token」。

**事实/出处**：Tavern 文档原话：删掉模型可见的 harness identity/persona/工具文字说明会让
Code Mode 或结构化输出**失效**。收窄工具面的正确做法是**组装层不挂那一行**（工具根本不进 catalog），
而不是删掉留在场上的说明文字。同时记住 host 层工具（profile 层挂的，如 `mcp-chrome`）任何 preset 都删不掉，
只能靠 host 层守卫兜底。

### 原则 8 · 改完的生效方式：`recompose`，拿不到就明说

**原则**：preset 文件改完后，优先调 `agentPresets.recompose(agentCtx, id)` 让改动在不重启的情况下生效
（已实测存在：`packages/preset/agent-presets/index.ts:650`，排队后再 `agent-preset/selected` 记录、客户端 `resetSession`）；
**拿不到该服务就明说「需要新开会话 / 手动切换才生效」，绝不假装已生效**。

**事实/出处**：`agent-presets/README.zh.md:173`——
*"会话一旦产出任何内容便无法更换 preset"*；所以「改 preset 文件」与「让现有会话用上」是两回事，
后者只有空白会话才可能，通常只能引导用户**新开会话并在选择器里选显示名**（显示名来自 `preset.yml` 的 `name`）。

### 行动红线（违反任何一条就停手）

1. 只动 `trust === 'user'` 的 preset；随部署附带的一律硬拒（`agent-preset/read-only`，见 §5）。
2. 写入前必须备份原文件（时间戳），写后回读校验，失败自动回滚
   （本插件 rp-agent 写入路径即按此实现：备份 → 临时文件原子替换 → 逐字节校验 → 校验不过用备份盖回）。
3. `compaction` 整块（compaction-basic + command-compact + tool-result-pruner，含其 isolate realm）**必留**——
   从 `standard` 复制后删行时最容易漏它，漏了长对话必撞上下文窗口（实测：自建 RP 预设最常见的翻车点）。
4. 被 `cordis:group` + `isolate:` 包着的块要么整块留、要么整块删，不能只抄里面的行
   （`agent.cordis.yml:11-18` 注释原话：isolate 外的行会发布进 root realm，与别的 preset 冲突，挂载被拒）。
