# 记忆库 · 思路与实现逻辑

> 对象：`dsh-memory-archive`（DSH 插件，本项目的交付物）
> 写法：**先讲第一块基石（复用 DSH 自身的压缩机制），再往上讲架构** —— 因为这个项目的每一个设计决定，
> 几乎都是被 DSH 原生已有的机制**逼出来或者让出来**的，不是凭空设计的。
> 证据约定：标【源码】的给 `文件:行号`（路径相对 DSH 检出）；标【实测】的是本项目跑出来的数；
> 标【推断】/【未验证】的不许当结论引用。

---

## 0. 一句话

> **不发明记忆，只把 DSH 已经压掉的东西重新变得「取得到」。**

DSH 的压缩机制已经在做「把旧内容折叠出上下文」这件事了，而且做得比我们自研更严（有 provenance 校验）。
所以本项目**不重写清洗、不重写压缩、不重写摘要调用链**，只补三件原生没做的事：
**① 把被折叠的内容索引成可检索的记忆；② 把折叠时的摘要指令换成面向检索的模板；③ 给它一个能看、能配、能搜的入口。**

---

## 1. 第一块基石：高度复用 DSH 自己的压缩机制

### 1.1 原生压缩已经在跑，而且挂对了一层

常被误读的一处：`packages/bundle/web-app/cordis.patch.yml` 里 `compaction-basic` 那三行写着 `disabled: true`
—— 这**不是关掉压缩**，是**让位给 agent preset 层**（旁边的注释原话就是「token METER 留在宿主平面，
只有读它的压缩后端跟着走」）。

真正挂载它的地方是 **agent preset**：

```
packages/preset/agent-presets/presets/standard/agent.cordis.yml:137-155
  - id: compaction
    name: cordis:group
    group: true
    isolate: { compaction: true, toolResultPruner: true }
    config:
      - id: compaction-basic
        name: '@deepseek-ai/dsh-compaction-basic'
      - id: command-compact
      - id: tool-result-pruner
        config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
```

而 RP 会话的 header 里就是 `agentPreset: "standard"`（本机解压 `session.jsonl.zstd` 实测）
⇒ **RP 会话本来就在被压缩**，用的是官方默认策略：
`thresholdRatio 0.8` / `retainRatio 0.16`【源码 `compaction/compaction-basic/src/config.ts:19-23`】。

⚠️ 一个必须知道的细节：`retainRatio` 是**跟着上下文窗口缩放**的
——`retainTokens = floor(contextWindow × retainRatio)`【源码 `config.ts:144-147`】。
在 256k 窗口上它的默认行为是「攒到 **204,800** token 才压、压完还留 **40,960**」，
与「原文层留十几层」的直觉差了将近一个数量级。⇒ 这是后来必须换成绝对 `retainTokens` 的原因（见 §1.4）。

### 1.2 「折叠」的机制是 surface 遮蔽 —— 这是整个项目的立足点

DSH 的事件流是**只追加**的真相源；「模型看得见的那一面」（surface）是它上面的一层**投影**。

```ts
// core/session/src/surface.ts:3
//   The append-only log remains the source of truth.

// core/session/src/types.ts:346-361
export type SurfaceOp = 'append' | { op: 'replace'; start: number; end: number }
//   `{ op: 'replace', start, end }`: replaces surface nodes from `start` (inclusive)
//   through `end` (inclusive) with this node. ...
//   Used by compaction; any surface-replacing producer may use it.   ← ★ 关键句
```

三条直接推论，每一条都决定了一个设计：

| # | 事实 | 出处 | 对项目的含义 |
|---|---|---|---|
| 1 | 替换**用替换节点本身占住那段区间** | `types.ts:352-354` | 用**短占位节点**替换旧区间 ⇒ 这就是 ST 的「隐藏 + 折叠标记」，**原生可表达，不用硬造** |
| 2 | `sourceEventSeqs` **必须列出每一个被遮蔽的 surface 节点**，缺一个抛错 | `surface.ts:239-241` | 遮蔽必须精确算区间，不能图省事 |
| 3 | 额外的严格校验**只在替换节点自身是 `tool/result` 时**生效 | `surface.ts:286-301`（非 tool/result 直接 return） | 用普通节点作占位符**没有额外限制** ✅ |

**⇒ 结论 A：「隐藏旧楼层」这件事不需要自研** —— 原生就有、有严格 provenance、而且已经在跑。
（这也正是本项目**否掉** `graph-memory` 那类方案的理由：它宣传的 "context takeover" 就是这件事。）

### 1.3 ★★ 最反直觉、也最省事的一条：被压掉的内容**没有消失，早就在索引里**

方案的早期版本把「收容」（把折叠掉的内容落进记忆库）写成**唯一真正的缺口**。
【实测】证明**这个判断是错的**：存储层不缺，缺的是**取用**层。

**证据一（源码）**：`session-query` 建检索文档时**遍历整个事件日志，不按可见面过滤**，
只用 `foldSurface()` 的 `replacements[].shadowedSeqs` 做**打标**：

```
session-query/session-query/src/documents.ts:35-54   遍历全量事件建文档
session-query/session-query/src/documents.ts:56-73   classifySurface() → 'current' | 'shadowed' | 'log-only'
```

**证据二（真库实测）**——`search.db` 的 surface 分布：

| surface | 篇数 | 含义 |
|---|---|---|
| `current` | 13,252 | 还在模型可见面上 |
| `log-only` | 7,197 | 本来就不上面（工具结果等） |
| **`shadowed`** | **752**（1,525,915 字） | ★ **已经被压缩出上下文**。★ 全部来自**一个**会话 —— 一个 `agent_preset: standard` 的**编程会话**（**不是** RP 会话）。取样实证见 §1.5 |

用「先完整」在库层搜同一会话 → **4 命中，含 shadowed 篇** ⇒ **被压掉的内容搜得到。**

**⇒ 结论 B：缺的不是「收容」，是三件「取用」的事：**
1. **模型够不到** —— RP 会话里没有检索工具（`tool-session-query` 是 opt-in，默认不挂）；
2. **看不出** —— 检索结果不区分「在上下文里」与「已被移出上下文」；
3. **取不回原文** —— 缺「按 `sessionId` + `seq` 精确读回整条」的入口。

**⇒ 整个项目的形态因此定为「检索取用」，而不是「再建一份存储」。**

### 1.4 只改了原生压缩的**一个钩子**：摘要指令

原生压缩唯一不适合 RP 的地方是**摘要指令本身**：它是**硬编码的英文工程模板**
（*"Write concise English engineering prose…"*，`compaction-basic/src/summarizer.ts:31-66`），**没有任何配置键**。

而 RP 会话被压掉的那段历史，用途是**日后被检索找回**，不是给人读的工程 checkpoint ——
需要的是「时间跨度 / 地点 / 涉及角色 / 关键事件 / 未回收伏笔，专有名词与数值逐字照抄」。

官方源码在同一个文件里**明确留了这个扩展点**：

```ts
// compaction/compaction-basic/src/index.ts:231
//   …prompt, tools, and messages so the provider's KV cache is not invalidated.
//   Override this sole hook for a template or remote summarizer.
```

⇒ `dsh-compaction-rp` 就是**只覆盖 `summarize()` 一个钩子**的子类。
**压力阈值、保留策略、token 计量、溢出恢复、`/compact`、durable 压缩事务——全部继承官方。**
它自己的三行配置（`customInstruction` / `faithful` / `summaryLanguage`）之外**不导出 `Config` schema**，
`config` 原样转发给官方 base 校验 ⇒ 官方将来加键自动透传，不会因 schema 落后报 `unknown key`。

★ 实现上还有一条**性能**讲究：辅助调用沿用官方的调用形状 ——
会话自己的 system + tools + 被压区消息放最前面，**我们的指令作为最后一条 user 消息**
⇒ 这次辅助调用是上次真实请求的**前缀延长**，provider 的 **KV cache 被复用而不是被击穿**。

### 1.5 隔离：RP 的压缩后端**碰不到编程模式**

这是「改了压缩机制会不会污染编程模式」的正面回答。两侧组装文件的**实际内容**：

```yaml
# RP preset（用户级）
- id: compaction
  name: cordis:group
  group: true
  isolate: { compaction: true, toolResultPruner: true }
  config:
    - id: compaction-rp           # ← 我们的 RP 归档模板
      config: { thresholdRatio: 0.15, retainTokens: 8000, summaryLanguage: auto }

# standard preset（随包，编程模式）
- id: compaction
  name: cordis:group
  group: true
  isolate: { compaction: true, toolResultPruner: true }
  config:
    - id: compaction-basic        # ← 官方原版英文工程模板
```

两者**在各自的 `isolate` realm 里注册同名的 `compaction` 服务** ⇒ 实例隔离、互不可见。
`standard` 的组装文件**一个字都没动**，RP preset 只被**显式选了它的会话**挂载。

⚠️ 为什么必须用 realm、不能挂进 profile：profile 是**宿主级**、所有会话共用一个 realm，
两个 `ctx.compaction` 实例抢同一个服务名会**启动即崩**。realm 是这里唯一的正解。

#### ★ 取样实证（已完成 · 2026-09-12）

工具：一个**只读的 sqlite 取样脚本**（直读检索库；**不碰会话日志、不解多帧 zstd**）。
**取样的巧劲**：不走多帧 zstd 解码 —— `session-query` 建文档时遍历的是**整条事件日志**，
而**压缩产生的替换节点本身也是一条事件** ⇒ 它同样落在 `persisted_docs` 里 ⇒ 一条 SQL 就能把
真实 checkpoint 正文捞出来。（这条方法本身就值得记下来：以后查压缩产物不必碰会话日志。）

| 断言 | 实测 |
|---|---|
| 全库会话的 preset 分布 | **39 个会话全部是 `standard`** —— 索引里**没有任何 roleplay 会话** |
| 全库真实 checkpoint 篇数（按官方英文签名句 `automatically generated checkpoint` 找） | **恰好 1 篇** |
| 那 1 篇属于谁 | 一个 `agent_preset = "standard"` 的会话（即一个**编程**会话） |
| 它的正文 | `"This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context…"` ⇒ **官方英文工程模板** |
| 中文 RP 模板签名词 | 「涉及角色」**0**、「未回收伏笔」**0**（「时间跨度」6 篇 / 「未决伏笔」3 篇的命中来自**本项目自己的对话正文**，不是 checkpoint） |

**⇒ 正面回答「压缩提示词会不会污染编程模式」：不会，而且这次是实证不是结构推断。**
全库唯一一个真实 checkpoint 产生于**编程会话**，模板是**官方英文工程腔**，没有沾到 RP 模板。

**⇒ 但必须如实标注一个反向空白（不许当结论用）**：`dsh-compaction-rp` **至今一次都没真正跑过** ——
没有任何 roleplay 会话长到触发阈值（`0.15 × 256k = 38,400` token），且该 preset 是 2026-09-12 凌晨才建的。
⇒ 「RP 会话会得到中文归档模板」目前**只有结构依据 + 该包自己的行为单测**
（假 LLM 服务 + 真官方 base，断言最后一条 user 消息是 RP 指令而非英文模板），
**没有一份真实 checkpoint 样本**。这一条**未验证**。

**⇒ 附带纠正一处旧表述**：项目文档里「被压掉的内容已存储、已索引、已可检索（752 篇 / 152 万字）」
这句话本身是对的，但那个样本**是一个编程会话**（即本项目自己的会话，遮蔽段有 **730 个断点** ⇒ 压缩过很多轮），
**不是 RP 会话**。凡是拿它当「RP 历史可检索」论据的地方，都要打这个折扣。

> ★ 顺带一个以后省时间的事实：`persisted_sessions` 表里**有 `agent_preset` 列** ——
> 判断某个会话跑的是哪个 preset，**不用去解码 zstd 会话日志**，查库即可。

### 1.6 数据安全的不变量

「复用原生」带来一条很强的不变量，它是本项目敢做遮蔽的唯一底气：

> **append-only 日志是真相源，遮蔽只改投影** ⇒ **任何「清洗」都是可逆的**，
> 被遮蔽的原文随时能从日志里读回来。

另一条同源的实测结论：`tool-result-pruner` 也**不毁原文**
（它自己的 README 原话「完整原始结果仍保留在会话日志中，可供精确回放与检查」）
⇒ **两种驱逐都可回捞**。

---

## 2. 架构：三层 + 一个「只取用、不落盘」的召回层

```
┌─ 长盘（standing，每轮都在，必须极小）──────────────────────────────┐
│  · DSH Tavern 固定段（order 10 / 45）                              │
│  · L1 状态卡（order 50，dsh-state-bridge）  ~1352 字               │
│  · 记忆导航（order 55 起）                  ← 只放「有什么可查」     │
└──────────────────────────────────────────────────────────────────┘
┌─ 即时记忆（本轮想起来，不落长盘、不落历史）──────────────────────────┐
│  A. FTS5 检索（本地、零 API 成本）→ 装配期注入「结果摘要」           │
│  B. 向量/语义检索（要 API）→ 子 agent 级，按需                      │
└──────────────────────────────────────────────────────────────────┘
┌─ 历史记忆库（数据，不是对话）──────────────────────────────────────┐
│  · L3 原文：archive/floors/NNNN.json        ← 254 楼逐楼原文        │
│  · L2 摘要：archive/summaries/*.md + index.json                    │
│  · L1 状态：archive/state/current.json                             │
│  · 索引：借用 DSH 自己的 sessionQuery（FTS5），不建第二份存储        │
└──────────────────────────────────────────────────────────────────┘
```

**「记忆库是数据，不是对话」** —— 这条是设计红线。它借用会话存储与索引机制，
但**不是一个你会切进去聊天的会话**，也**永远不进 RP 会话的 prompt**。

### 2.1 表：三层各自的职责与「谁来写」

| 层 | 内容 | 谁写 | 谁读 |
|---|---|---|---|
| **L1 状态** | 状态原子（数值 / 分组 / 到期） | `dsh-state-bridge` 每轮记账（副 LLM） | 每轮注入 state 段（order 50）+ RP 里 `state_show` 工具 |
| **L2 摘要** | 段落备忘（时间/地点/人物/事件/未决） | 离线段落总结器 | 向量检索的语料 + 面板「摘要」tab |
| **L3 原文** | 逐楼原始 JSON | Tavern / 归档抽取器 | 面板「原文」tab + 检索命中后的「取回原文」 |

---

## 3. 注入缝：为什么**只**能走 `section()` / `assemble`

DSH 有四个「每轮重算」的缝，但**后果完全不同**：

| 缝 | 位置 | 每轮重算 | **写进 durable 历史？** | 本项目 |
|---|---|---|---|---|
| `systemPrompt.section()` 的 text provider | `core/system-prompt/src/index.ts:66,432` | ✅ | ❌ **不写** | ✅ 可用 |
| `'system-prompt/assemble'` waterfall | 同 `:19-31,601-604` | ✅ 且 **async** | ❌ **不写** | ✅ **首选**（能在这里 await 检索） |
| `systemPrompt.context()` | 同 `:76-84` | ✅ | **✅ 写**（durable user-role 快照） | ⛔ **禁用** |
| `agent/pre-step` | `core/agent-loop/src/agent.ts:243-244` | ✅ | **✅ 写**（`:291-293` 逐条 `session.append('user/message')`） | ⛔ **禁用** |

**时序陷阱**：section provider 的求值（`:590-599`）**先于** assemble waterfall（`:601-604`）
⇒ 在 waterfall 里 await 检索**不会**让 provider 拿到新值 —— **必须自己改写 `assembly.sections`**。

【实测】`agent/pre-step` 那条路是用**一次性探针 preset** 亲手验的：在 waterfall 里往
`decision.messages[0]` 追加一个标记串，跑一轮后**在会话日志 `seq 7` 的 `user/message` 事件里读到了那个标记**
⇒ **pre-step 注入 = 写历史**，社区插件那句 "without long-lasting context contamination" **不适用于这种用法**。

⇒ **落地方式 = 在 `system-prompt/assemble` 里 await 检索，然后改写 `out.sections`。**
这条模式在本项目里已被两个插件各实现过一次（`dsh-state-bridge` / `dsh-anima-rag`），是可复制的成熟做法。

### 3.1 顺带被这条规则否掉的写法

`dsh-mneme` 那类「hot memory 每轮重建最近 N 轮」的做法之所以被否，就是因为它走
`systemPrompt.context()` —— 那是 **durable 快照，文本一变就追加一条 user 消息**，
长 RP 里等于**每轮往历史追加一条 ~2k token 的重复快照**。

---

## 4. 四层区间：把「历史」按远近分层

以 1000 轮为例：

| 层 | 区间 | 内容 | 机制 |
|---|---|---|---|
| **锚** | **第 1 轮** | 开场白 + 首轮**完整保留** | ★ **永不清洗** —— 它是「思维模式/文风」的附着点 |
| 1 | 0–750 | 只有**占位符**「前 750 楼已进入记忆库」 | `surfaceOp: {op:'replace'}` + 短占位节点 |
| 2 | 750–950 | **定制 RP 提示词压缩成的摘要文本** | 替换节点 = 摘要（**不能用 `compaction-basic`**：它的配置键里没有模板项） |
| 3 | 950–1000 | **原始文本** | durable 历史原样 |

**关键简化：第 1 层和第 2 层是同一个动作，只差「替换节点里放什么文本」⇒ 只需要一个清洗器。**

**★ 三条硬规则**：
1. **第 1 轮永不清洗** ⇒ 清洗区间永远从第 2 轮之后开始，占位节点不能吞掉第 1 轮的 turn 边界；
2. **先归档、后遮蔽**（顺序不能反）；
3. **遮蔽可逆**（原文永远在 append-only 日志里）。

### 4.1 与 compaction 的分工

两者都会做 surface `replace`，**必须先定策略**，否则会出现「我遮蔽了一段，compaction 又想遮蔽包含它的更大区间」。
选定策略是**「前置」**：记忆层的清洗阈值**低于** compaction（例如 0.15 vs 0.8）
⇒ 清洗管「远段」、compaction 管「近段」，两者不重叠。
（并且占位节点里记录被遮蔽区间的指纹，便于与 compaction 的 snapshot 对账。）

### 4.2 世界书触发这条隐性约束

【实测结论】世界书条目的命门只有一个：**`entry.keys` 必须在扫描文本里以子串形式出现过**，
而扫描文本来自 `deriveMessages()` —— **它就是压缩之后的 surface**。
被 compaction `replace` 掉的楼层**不是「变短了」，是「从派生里删掉了」**。

⇒ 占位符不能写成纯模板，**要把该楼段的关键词附在占位行本身**；
`compaction-rp` 指令里「专有名词/数值逐字照抄」那条规则也因此多了一个硬理由。

（本机用户的 `scan_depth = 2`，只扫最近一楼对话 ⇒ 老楼本来就不参与触发，这条对当前配置不构成风险。
但它是「以后想调大扫描窗口」时的前置约束。）

---

## 5. 检索后端：借用 DSH 的 sessionQuery（FTS5）

### 5.1 打开它：零核心改动

原生内容检索**默认是关的**（`packages/bundle/base/cordis.patch.yml:121-133`，`path: ':memory:'` + `openAt: never`），
官方注释明确指定「要在更靠后的 patch 层覆盖 `openAt`」：

```yaml
# profile 的 cordis.patch.yml
- id: session-query-sqlite
  config:
    path: '<持久库路径>'
    openAt: startup
    # ⚠️ patch 不做深合并 ⇒ 必须重述完整 config
```

可配项：`path` / `openAt(startup|first-search|never)` / `journalMode` / `defaultLimit(20)` / `maxLimit(100)` /
`snippetChars(240)` / `readWindowMax` / `persistedInspectConcurrency`【源码 `session-query-sqlite/src/index.ts:199-212`】。
**注意：没有 tokenizer 配置项。**

### 5.2 中文检索：`unicode61` 不可用，`trigram` 可救

内置分词器 `unicode61` 按 Unicode 词边界切，而**汉字无空格 ⇒ 整段切成一个 token**。【实测】

| 查询 | `unicode61`（默认） | `trigram` |
|---|---|---|
| 「孙师傅」（原文里有） | **0** | **1** |
| 「指节发白」 | 1 | 1 |
| 「衣角」/「灯笼」（**2 字**） | 0 | **0**（trigram 需 ≥3 字） |
| `wound` / `bleeding` | 1 | 1 |

★ **tokenizer 是建表参数、无法原地改**（`ALTER TABLE t tokenize='trigram'` → 语法错误）⇒ 只能 DROP + CREATE。

**不用 fork、不用改核心就能换掉**，靠三处既有设计叠加：

| 出处 | 事实 | 利用 |
|---|---|---|
| `session-query-sqlite/src/schema.ts:87-94` | `assertDerivedUserTables` **只校验表名**，不校验 DDL | trigram 表照样被接受 |
| 同 `:126` | `CREATE VIRTUAL TABLE **IF NOT EXISTS**` | 预建的表被原样沿用 |
| 同 `:64-66` | 仅 `user_version !== 8` 才重置 | 写上 `user_version = 8` ⇒ 不重置 |

⚠️ **这是维护负债**（靠校验不严走通，上游一加 DDL 校验即失效）⇒ 必须留回滚，并报上游 issue。

### 5.3 trigram 的语义（比「能搜中文」精确得多）

1. **查询 ≥3 字**：3 字窗口做**子串 OR 匹配** ⇒ 命中含它的文档；
2. **查询 ≤2 字**：**一律 0** ⇒ **关键词提取必须产出 ≥3 字的中文词**，2 字词只能走「展开层」原文读取；
3. **整数句当查询噪声极大**（一句话里有几十个 3-gram，命中任一即算）⇒ 必须限词长、限条数；
4. **查询词必须先 sanitize** —— 含 `-` / `"` 会被当 FTS 语法，直接 `no such column` 报错。

### 5.4 ★ 一条把 GUI 路线否掉的硬事实

宿主 GUI 的会话搜索**永远不返回 `shadowed`** —— 它调引擎时**硬编码过滤**了可见面：

```ts
// api/session-controller/src/list.ts:258-266
eventFilters: [
  { kind: 'surface', values: ['current'] },                        // ← shadowed 被滤掉
  { kind: 'type', values: ['user/message', 'assistant/message'] },
]
```

⇒ 契约注释 "Search the Host's **visible** message-content index" 是准确的：**visible = current**。
⇒ 客户端**结构上也拿不到** shadowed（`ConversationNode` 联合类型里根本没有这个节点）。

**⇒ 所以「看被压缩掉的内容」这件事，浏览器半侧做不到，只能由宿主半侧直读库提供。**
这条直接决定了插件的形态：宿主半侧不是可选的装饰，而是**唯一能看到完整历史的那一侧**。

---

### 5.5 ★★ 精确读的「便宜入口」清单（本项目最硬的一条纪律的落点）

`ctx.sessionQuery` 上有一批方法**只做 corpus load，不碰 SQLite、不触发索引对账**。
它们和 `searchSessions` / `searchEvents` 是**两个世界** —— 后者会触发全量对账
（本项目实测：真机上 **88 秒 / 2 GB 内存**，而且发生在用户界面正等着的那个请求里）。

【源码】`packages/session-query/session-query/src/index.ts`：

| 方法 | 行 | 返回 | 是否便宜 |
|---|---|---|---|
| `listSessions(signal?)` | `:155` | `SessionRecord[]` | ✅ |
| `readSession(sessionId)` | `:165` | `SessionLogSnapshot` | ✅ |
| `readTitle(sessionId, signal?)` / `readTitleSnapshots(ids, signal?)` | `:194` / `:225` | `string \| null` | ✅ |
| **`listEvents(sessionId)`** | **`:243`** | **`SessionEventRecord[]`** | ✅ |
| **`filterEvents(sessionId, filters)`** | **`:254`** | `SessionEventSearchDocument[]` | ✅ |
| `readSurface(sessionId)` | `:284` | `SessionSurfaceSnapshot` | ✅ |
| ⛔ `searchSessions` / `searchEvents` | `:134` / `:145` | — | ❌ **会触发全量对账** |

便宜的依据（都是 `this._corpus.load(sessionId)` 一行带过）：
`listEvents`（`:243-246`）· `filterEvents` → `_filterEvents`（`:269-276`）· `readSurface`（`:284-291`）。

**形状上的三个坑（都是必须知道的）**【源码 `types.ts`】：

1. ★ **`SessionEventRecord` 自带 `surface`**（`:52-63`）—— 取值 `'current' | 'shadowed' | 'log-only'`（`:21`）。
   ⇒ **「哪些内容已经被压缩出上下文」这个招牌功能，靠一条便宜调用就能如实拿到，不需要任何猜测。**
   这是 `listEvents` / `filterEvents` 存在的真正价值。
2. **`readSession` 只接受 `sessionId` 一个参数**（`:165`），返回的 `events` 是**全部事件**、**没有分页选项**。
   ⇒ 想分页必须**拿到之后本地切片**。（⚠️ 这条有陷阱：JS 多传参数**不会抛错**，
   所以「带 options 调用、失败再退化」那种写法**兜底永远不会触发**，分页会静默失效。）
3. **`SessionRecord` 只有 `{header, live, persisted}`，没有 `title`**（`:24-31`）；
   会话 id 在 `record.header.id`。要标题得单独调 `readTitle` / `readTitleSnapshots`（别 N 次串行）。

**⇒ 会话模式（根模式 A）的正确取数姿势**：

- **首选**：`filterEvents(sessionId, [])` —— **一次调用同时拿到「正文 + `surface`」**。
  ★ 空 filters 等于「不过滤」**已查实**（不是推断了）：`filters.ts:32-37` 是
  `documents.filter(d => predicates.every(p => p(d)))`，而 `[].every(...)` **恒为 `true`**
  ⇒ 空数组 ⇒ 全部文档返回。
- **兜底**：`listEvents`（surface）+ `readSession`（正文），**按 `seq` 对齐 join**。
- 无论走哪条，`surface` **拿不到就填 `null`，任何情况下都不许从 `type` 猜**。

---

## 6. 两种根模式

记忆库要能在两种环境里用，而它们的「根」根本不是同一种东西：

| | **会话模式**（默认） | **工作区模式** |
|---|---|---|
| 根 | 一条**手动选定的 DSH 会话**（`sessionId`） | Tavern 工作区里某个周目的 `archive/`（`characterId` + `playthroughId`） |
| 数据来源 | DSH 自己的会话事件日志 + `sessionQuery` 索引 | 归档文件（`floors/` `summaries/` `state/`） |
| 依赖 | **零依赖**（原版 DSH 纯净环境就能跑） | **需要 `pmp-dsh-tavern`**（可选依赖） |
| 能看到的 | 该会话的全部事件**含 `shadowed`**（宿主半侧直读） | 归档契约覆盖的三样：原文 / 摘要 / 状态 |
| 典型场景 | 原版 DSH 里做 RP，会话本身就是记忆 | 在 Tavern 环境里，记忆另有归档目录 |

**设计要点**：
- 根是**一个联合类型**，不是两条代码路径 —— 面板决定用哪个「取数后端」，上层 UI 不变；
- **Tavern 缺失时工作区模式自动降级**（隐藏或置灰 + 说明原因），**绝不崩溃**，也绝不把它写成普通 `dependencies`；
- 会话模式的「手动选择」是刻意的：**不做自动推断**，因为「哪条会话算记忆」是用户的语义判断，不是可以猜的。

---

## 7. 已知边界（诚实清单）

| # | 边界 | 性质 |
|---|---|---|
| 1 | **2 字中文查询必然 0 命中** | trigram 硬限制，无解；只能走原文展开层 |
| 2 | **宿主 GUI 搜索看不到 `shadowed`** | 宿主硬编码过滤；只有宿主半侧直读库能看 |
| 3 | **第三方插件没有通用的 client↔host 自定义 RPC** | 意味着面板的「配置读写」不能走通用通道，必须用宿主半侧自己暴露的接口（**本条正在复核**：本项目早期结论如此，需与当前 DSH 版本再对一次） |
| 4 | 入库时 `sourceEventSeqs` 缺一个就抛错 | 遮蔽必须精确算区间 |
| 5 | 不能在事件监听器里同步 `session.append` | 清洗必须从工具/命令/延迟任务发起 |
| 6 | tokenizer 靠「表名校验不严」走通 | 维护负债，上游一变即失效 |
| 7 | 遮蔽与 compaction 同时发生时的边界行为 | **未实测**；先用「前置策略」规避 |
| 8 | 摘要指令模板的正确性 | `compaction-rp` 的模板是**设计的**，尚未经过长周目标定 |

---

## 8. 与 SillyTavern 的对应关系（为什么这个设计是「和 ST 一个逻辑」）

| ST | DSH 等价物 | 差异 |
|---|---|---|
| 每条消息 `is_system` 决定是否发给模型 | surface `replace` 遮蔽**区间** | ST 是**逐条**开关；DSH 是**区间**替换 |
| 用户手改「隐藏」 | 需要「清洗」入口（工具/命令/策略） | DSH 没有现成的逐条隐藏 UI |
| 隐藏后仍保留在 chat 文件里 | 遮蔽后**仍在 append-only 日志里** | ✅ 语义一致，且 DSH 更严（有 provenance 校验） |
| 世界书 constant 注入 | `section()` / 世界书 constant | ✅ 已有 |

---

## 9. 项目的三条「不做」

1. **不自研压缩 / 清洗内核** —— 原生已有且更严（§1.2）；
2. **不建第二份存储** —— 被压掉的内容**已在索引里**，缺的是取用（§1.3）；
3. **不把记忆塞进主会话的实时历史** —— 只走 `section()` / `assemble` 两个**不写历史**的缝（§3）。

## 10. v4 增补（2026-09-12）

### 10.1 提示词查看器并入本包
原先作为独立插件存在的提示词查看器（看「每次模型请求真正发出的全文」）**两半代码搬进了本插件**，
宿主半侧挂成**第二条同源路由** `prefix /dsh-memory-archive/prompt`，客户端变成一个子页。
并入的动机是入口收敛：一个齿轮、一个面板。两条路由必须**同步注册**（都在 `apply()` 的 effect 里），
否则在 `patchReload: live` 的宿主上热重载会留下野路由。

### 10.2 真名从哪来（会话 / 周目 / 角色）
工作区根的 `catalog.json` 是权威来源：
`playthroughs[].title`（周目名）、`.ext.pmpDshTavern.characterName`（角色名）、`.rootSessionId`（周目 ↔ 会话的桥）。
`<archive>/manifest.json` 的 `target.rootSessionId` 是同一条信息的第二来源（Tavern 不可达时仍可用）。
会话标题走宿主 `readTitle`，但**必须显式请求 `?titles=1`** —— `/sessions` 的默认路径是刻意的快路径、标题为 null。
界面拿不到名字时**降级为 8 位截断 id 并标注来源**，任何情况下都不显示完整 UUID。

### 10.3 提示词的可见性（两个面板）
「压缩指令」= 官方在 `summarize()` 上留给外部的**唯一扩展点**；「收纳占位」= 被收纳段落在原位留下的前言
（官方 `frameSummary()` 把前言 + 摘要包进 `<compacted-summary>`）。两者都在面板里**可编辑、可恢复默认、并附作用解释**。
★ 诚实的边界：本插件保存的只是文本，真正生效需要落到 preset 的 `customInstruction`；
而「收纳占位」在本插件还没有收纳执行器之前**只是待用的配置位**。

### 10.4 阅读优先的信息架构
面板 = `阅读 / 提示词 / 设置`：阅读区连续滚动（摘要按楼序拼接、原文顺序懒加载并标注 `sent === false` 的楼层
即「未发给模型」、会话事件按 200 条分页自动追加），设置降为次级视图，根模式不再常驻顶栏。
