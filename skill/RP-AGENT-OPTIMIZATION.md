# RP agent 优化原则（给 AI 看的操作原则）

> 随 `dsh-memory-archive` 包提供。读者是**执行优化的 AI 助手**：当用户在「Agent 编辑器」里勾选
> 「启用 RP agent 优化」并请你调整某个 RP agent preset 时，按本文 8 条原则行动。
> 每条都给出**出处/事实**（来自 2026-09-11 的第一轮一手调研：官方源码带行号 + 官方 README 原文逐字核对），
> 不许凭感觉发挥；调研原文见工作区 `03-调研与报告/RP-agent-调研-第一轮.md`（下称「调研」）。
>
> ★ 适用对象：**只动 `trust === 'user'` 的 preset**（`~/.dsh/.agent-presets/` 下用户自带的那些）。
> 随部署附带的 preset（`standard` / `minimal` / `ptc` / `cordis`）官方语义只读
> （错误码 `agent-preset/read-only`，官方原话 *"it ships with the deployment"*）——一个字节都不许改。

---

## 原则 1 · 注入只走「不写历史」的两条缝

**原则**：每轮注入（状态卡 / 检索记忆 / 占位行）只允许用 `systemPrompt.section()` 与
`system-prompt/assemble` waterfall。⛔ 禁用 `systemPrompt.context()` 与 `agent/pre-step`。

**事实/出处**：
- `agent/pre-step` 改写的 messages 会被 `agent-loop/src/agent.ts:291-293` 逐条
  `session.append('user/message', …)` 落盘——用它注入等于把状态**每轮写进 durable 历史**
  （dsh-state-bridge README.zh.md:41-42 原话写明了这条弃用理由）。
- `systemPrompt.context()` 是 durable user-role 快照：文本一变就往历史追加一条 user 消息
  （调研 §一.6 反面清单：dsh-mneme 的 hot memory 实测长 RP 里基本每轮追加 ~2k token 重复快照）。
- `section()` 与 `assemble` 不落盘，每轮重算、只影响本轮请求——这是唯一的干净注入面。

## 原则 2 · 压缩只在 `summarize()` 一个钩子上扩展；遮蔽必须精确覆盖

**原则**：改压缩行为，只允许覆盖压缩后端的 `summarize()` 一个钩子；
要遮蔽（把旧内容移出模型可见面）走 `session.append(..., { surfaceOp:{op:'replace',start,end} })`，
且 `sourceEventSeqs` **必须精确覆盖**被遮蔽的全部 surface 节点，否则**当场抛错**。

**事实/出处**：
- 官方 compaction-basic 源码原话：*"Override this sole hook for a template or remote summarizer"*
  （`compaction-basic/src/summarizer.ts`）——压力阈值、保留策略、token 计量、`/compact`、溢出恢复全部继承官方，不要自研。
- surface 遮蔽语义见 `core/session/src/surface.ts:64-67, 241`：replace 是官方给 compaction 用的公开机制
  （原话 *"Used by compaction; any surface-replacing producer may use it"*）；
  `sourceEventSeqs` 与被遮蔽节点不精确对齐时 session 层直接抛错——宁可少遮一段，不许错位。

## 原则 3 · 占位行必须带该段关键词

**原则**：被收纳段落原位留下的占位行，**必须包含该段的关键词**（专有名词/地名/物品名逐字保留）。

**事实/出处**：世界书条目靠「关键词在上下文里出现过」触发，而扫描的正是**压缩之后的 surface**
（调研 §一.6 与本插件「收纳占位」模板解释同源）——老楼被替换成占位行后，它的关键词就不再参与触发；
所以占位行要自带关键词，这也是压缩指令里「专有名词逐字照抄」那条规则的硬理由。

## 原则 4 · 各段 order 的真实分布（不许另造）

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

**事实/出处**：调研 §一.2、§2.15、§2.16（本机源码带行号核实）。
注意 persona 的 `complete: true` 会把上面所有段一次性清场（见原则 6 的通道级后果）。

## 原则 5 · ★「可回捞」不等于「可回滚」

**原则**：日志是 append-only、原文随时可读回（**可回捞**）；但 surface 投影**撤不回**（**不可回滚**）——
要回到折叠前的可见状态，只能从折叠前的回合 fork 新会话。

**事实/出处**：`core/session/src/surface.ts` 的遮蔽只改「模型可见面」投影，事件日志本身不可变；
本插件 README 设计说明第 1 条同源（*"append-only 事件日志是真相源 ⇒ 任何遮蔽都可逆"*指的是**读回原文**，
不是把 surface 投影复原）。给用户做任何压缩/遮蔽操作前，必须先讲清这条差别。

## 原则 6 · ★ 不设 `persona.complete: true`

**原则**：为 RP preset 改写 persona 时，**不要**设置 `complete: true`（也不要 `includeRuntimeContext: false` 之外的侥幸组合）；
用「persona 遮蔽部署人设 + 一条显式忽略指令」压制 harness 文本就够了。

**事实/出处**（调研 §2.15 源码级实证，两次独立确认）：
- `system-prompt/src/index.ts:601-610`：complete 覆盖发生在 `system-prompt/assemble` waterfall **之后**
  （`:601-604` 先跑 waterfall，`:608` 才用 `[completeSection]` 覆盖 sections）⇒ 连「在 waterfall 里改写
  `assembly.sections`」也救不回来，状态卡 `state:card` 与记忆 `anima:memory` 的每轮注入会被**一次性废掉**。
- 附带事实：两个 complete section 并存时装配**直接抛错**（`:576`，不是静默覆盖）；
  换来的好处只是抹掉一句 8 token 的 harness identity——收益成本比不成立。

## 原则 7 · ⛔ 不许删工具说明

**原则**：不许删除模型可见的 harness identity / persona / 工具文字说明来「省 token」。

**事实/出处**：Tavern 文档原话（调研转引）：删掉模型可见的 harness identity/persona/工具文字说明会让
Code Mode 或结构化输出**失效**。收窄工具面的正确做法是**组装层不挂那一行**（工具根本不进 catalog），
而不是删掉留在场上的说明文字。同时记住 host 层工具（profile 层挂的，如 `mcp-chrome`）任何 preset 都删不掉，
只能靠 host 层守卫兜底（调研 §2.13 约束 3）。

## 原则 8 · 改完的生效方式：`recompose`，拿不到就明说

**原则**：preset 文件改完后，优先调 `agentPresets.recompose(agentCtx, id)` 让改动在不重启的情况下生效
（已实测存在：`packages/preset/agent-presets/index.ts:650`，排队后再 `agent-preset/selected` 记录、客户端 `resetSession`）；
**拿不到该服务就明说「需要新开会话 / 手动切换才生效」，绝不假装已生效**。

**事实/出处**：调研 §2.3（终态方案）与 `agent-presets/README.zh.md:173`——
*"会话一旦产出任何内容便无法更换 preset"*；所以「改 preset 文件」与「让现有会话用上」是两回事，
后者只有空白会话才可能，通常只能引导用户**新开会话并在选择器里选显示名**（显示名来自 `preset.yml` 的 `name`）。

---

## 行动红线（违反任何一条就停手）

1. 只动 `trust === 'user'` 的 preset；随部署附带的一律硬拒（`agent-preset/read-only`）。
2. 写入前必须备份原文件（时间戳），写后回读校验，失败自动回滚——P0 阶段本插件**只读**，
   这些写入能力落地前，任何「帮你改 preset」的请求都应答复「当前版本只做检测与预览」。
3. `compaction` 整块（compaction-basic + command-compact + tool-result-pruner，含其 isolate realm）**必留**——
   从 `standard` 复制后删行时漏了它，长对话必撞上下文窗口（调研 §2.11：自建 RP 预设最容易漏的一行）。
4. 被 `cordis:group` + `isolate:` 包着的块要么整块留、要么整块删，不能只抄里面的行
   （`agent.cordis.yml:11-18` 注释原话：isolate 外的行会发布进 root realm，与别的 preset 冲突，挂载被拒）。

---

# 选卡：读什么 / 产出什么 / 格式契约（v5 P1b）

> 契约出处：《选卡-读卡与pack输出契约.md》（2026-09-13 修订见《选卡-设计修订与组装骨架-20260913.md》，冲突以后者为准）。
> 一句话：**插件不解析卡字段 —— 卡的原始数据全给你（AI），你读、你判断、你产出；插件只负责定义格式 + 校验 + 路由。**
> 为什么必须这样（实测）：① 卡的键是 **camelCase**（`systemPrompt`/`firstMessage`/`postHistoryInstructions`），按 snake_case 读一律 `undefined`；
> ② 「主提示词」在卡里有**两份且大面积不同**（`data.systemPrompt` 6732 字 vs `data.extensions.system_prompt` 8432 字）——不许由插件写死读哪份，**由你判断并向用户说明**；
> ③ 描述字段可能是空壳（`description` 5 字、`personality`/`scenario` 0 长度）——别按"四字段拼接"机械干活；
> ④ 卡是注入段的语义权威（它定义 `躯体/密氛/恐惧` 怎么算）——读漏了卡，模型就不知道那些数字是什么。
> ⛔ **世界书（characterBook）这次留空**：不接、不检索、不写进产物。

## 你能读到什么（全都给，不做预筛）

| # | 数据 | 来源 |
|---|---|---|
| 1 | **卡的原始全字段**（JSON 原样，含 `data.*` / `extensions.*` / `compatibility.*` / `characterBook`，一个字段不省） | `GET /dsh-memory-archive/api/agent/card?id=<文件名>` |
| 2 | **可用卡清单**（id / name / creatorNotes / 字数概览——只是导航提示） | `GET /dsh-memory-archive/api/agent/cards` |
| 3 | **当前 RP preset 的现状**（persona 全文、工具面脚本是否在） | 既有 `GET /agent` / `GET /agent/backups` |
| 4 | ★ **两个固定段**（见下） | 插件内置（你只读，⛔ 不许改、不许重复其职责） |
| 5 | 用户当前根 / 绑定 | `dma-binding.json`（经既有端点可见） |

⛔ 你不许做的：替用户决定"读哪份 systemPrompt"、做字段优先级、把空字段补默认值。
✅ 你要做的：读全、列 `readFields`/`missing`、做取舍、**把该问的写成 QUESTIONS 问玩家**。

## 你要产出两份文档（缺一不可，都是机器可校验的接口）

### 第一份：`RP-AGENT-QUESTIONS v1` —— 给玩家看的白话选择题（先出这份）

```
RP-AGENT-QUESTIONS v1

## 说明
<一两句白话：这是给你定的几件事，不选也能用，我会按默认来。>

## 要你定的第 1 件事
问：<一句白话问题，⛔ 不许出现技术词>
  · <选项 A 的白话名字>：<选了会怎样 —— 说后果，不说原理>
  · <选项 B 的白话名字>：<选了会怎样>
我的建议：<选项名>。因为 <一句话理由>。
不选也行：默认「<选项名>」。
```

校验器会拦：`BAD_MAGIC` / `NO_QUESTIONS`（一题都没有）/ `QUESTION_INCOMPLETE`（四要素缺一）/
`TECH_JARGON`（**术语禁令**，见下一节）/ `NO_FALLBACK`（缺「不选也行」）/ `TOO_FEW_OPTIONS`（选项 <2，警告）。

### 第二份：`RP-AGENT-PACK v1` —— 可执行产物（玩家答完后再出）

```markdown
RP-AGENT-PACK v1

## META
name: <角色显示名>
sourceCard: <卡 id 或文件名>
readFields: <实际读到并采用过的字段清单，含长度，如 data.systemPrompt(6732)、data.firstMessage(1022)>
missing: <为空/缺失的字段清单；如实列。全都有就写 NONE>
decisions: <你替用户做的取舍，逐条一行；没做就写 NONE。★ 只留给无关体验的小事；凡影响体验的一律进 QUESTIONS>
identity: <★ 新增：它以为自己是干什么的（扮演角色 / 当 KP…），≤400 字，要短 —— 这段落最前，需用户认可>
thinkMode: <★ 新增：analysis | immersion | off（封闭枚举；缺省 = analysis；概率性效果，由实测裁决）>
cardHash: <卡文件的 sha256 前 16 位>

## SETTINGS
<★「设定与规则」：将被放到对话历史之前的整段文本。
 应覆盖：世界与社会形态 / 核心数值及其语义 / 判定与检定规则（那些被注入的块是什么，由固定段 B 解释，你不要重复）。
 ⛔ 不要写成对模型的元指令（"你必须…"那类）。>

## TONE
<KEEP 或 演出规范文本。若写正文：只写"怎么演"（人称/段落/文风/节奏），不写世界规则。>

## OPENING
<首轮开场文本（通常来自卡的 firstMessage，可做最小必要改写）。卡没有开场就写 NONE。>

## POST
<可选。靠后生效的规则。没有就写 NONE。>

## CONFLICTS
<★ 需要用户拍板的问题，逐条三段式：问题 / 你的建议 / 影响。没有就写 NONE。
 这就是"跟用户商量"的入口 —— 不要自己闷着决定。>
```

校验器会拦（错误级）：`BAD_MAGIC` / `MISSING_SECTION`（META/SETTINGS/TONE/OPENING/CONFLICTS 必备，POST 可选）/
`META_INCOMPLETE`（name/readFields/missing/decisions/cardHash 五项）/ `EMPTY_SETTINGS` / `BAD_TONE`（非 KEEP 也得有正文）/
**`CARD_HASH_MISMATCH`**（拿旧 pack 套新卡，必拦）/ `BAD_THINK_MODE`（封闭枚举外）/ `BAD_IDENTITY`（缺失、空、或 >400 字）。
警告级（不阻断但会显示）：`DUPLICATES_CONTRACT`（SETTINGS 里写了固定段 B 的职责）/ `SETTINGS_TOO_LONG`（>8000 字）/
`HAS_CONFLICTS`（非 NONE ⇒ **不许写盘**，先商量）。

## 两个固定段（⛔ 不要重复它们的职责）

| 固定段 | 内容 | 落点 | 谁维护 |
|---|---|---|---|
| **A · persona 槽（deployment:persona，order 0）** | ★ **IDENTITY**：「你是 KP / 你扮演 X」——由你产出、**用户认可**后才用 | 最前（`harness:identity` 只有一句 "You are an AI agent…"，在它前面且可关） | **你产出 + 用户认可** |
| **B · 对接层（seam contract）** | 6 条**注入缝解读**：`<recalledMemories>` 是历史资料不是此刻 · `<storyAnchor>` 是当前坐标且冲突以它为准 · `【当前状态】` 是权威数值 · `OOC:`/`导演:` 前缀路由 · 不出戏边界 · 数值单列 | 插件内置常量 | **插件（⛔ 不被卡/你覆盖）** |

★ 为什么 B 必须固定（实测）：卡的两份 systemPrompt 里 **0 个尖括号标签**、完全不提 `OOC`/`导演`/`【当前状态】`
⇒ 你的文本若把 B 的职责也写了，会两处说法冲突；校验器会以 `DUPLICATES_CONTRACT` 提醒。
★ 注：早期那份「用户手写 7 段演出规范」的前提**已作废**（用户只维护规则书）——persona 槽可由你的 IDENTITY/演出文本替换，是否替换**问玩家**。
★ 写入面归 P1b-2（路由/组装/压缩保护）；**当前版本只产出与校验，不会自动写进任何文件**。

---

# 怎么跟玩家说话（★ skill 默认玩家完全不懂计算机知识，只会用微信聊天）

1. **不许出现技术词**。禁用词（校验器会拦，报 `TECH_JARGON`）：
   `order` / `section` / `prompt` / `system` / `token` / `压缩` / `注入` / `枚举` / `schema` / `preset` / `JSON` / `字段` / `路径` / `配置项` / `durable` / `hash` / `scope` / `realm`
2. **每件事都要**：一句白话问题 + 每个选项**说后果**（不说原理）+ **我的建议 + 一句话为什么** + **不选也行（默认值）**。
3. **优先问玩家，不要替他定**。`META.decisions` 只留给**无关体验的小事**（例如"卡里有两份主提示词，我取了归一化那份"）；凡影响体验的，一律进 QUESTIONS。
4. ★ **翻译对照表**（照抄，给 AI 当范例用）：

| ⛔ 不许对玩家这么说 | ✅ 要这么说 |
|---|---|
| 组装顺序 / order | 「先说什么、后说什么 —— **越靠后说的，它越当回事**」 |
| 首轮不收纳 / 压缩保护 | 「**开场和你的第一句话永远留着**，不会被'记成摘要'以后就忘了」 |
| 思考模式 marker | 「它想事情的时候，是**入戏地在心里嘀咕**，还是**冷静地盘算**」 |
| 世界书 | 「设定小册子（**这次先不放**）」 |
| 规则书 / SETTINGS | 「你那本规则书」 |
| IDENTITY / persona 槽 | 「它**以为自己是干什么的**」 |
| `<recalledMemories>` | 「它翻出来的**往事**」 |
| 工具面 / restrict | 「它能用哪些本事」 |
| 回滚 / 备份 | 「改坏了能一键变回去（每次改之前都会先存一份）」 |

5. ★ **面板上用同一套白话**：同一个选项，skill 里和界面上**说法一致**（玩家点的时候不用重新理解）。
