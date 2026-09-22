// ---------------------------------------------------------------------------
// mt-compaction：生成「RP 专用压缩后端」的源码文本。
// 产物 = 预设目录内的 ./mt-compaction-rp.js（自包含模块；随预设目录发布 ⇒ 与机器无关）。
//
// 为什么要有它：官方 @deepseek-ai/dsh-compaction-basic 的摘要指令硬编码在 summarizer.ts
//（content: [{ type:'text', text: COMPACTION_INSTRUCTION }]），resolveConfig() 还会用
// validateKeys 拒掉未知键 ⇒ 它没有 customInstruction 配置位。「把中文 RP 归档指令写进
// 预设」必须有一个认这个键的后端 —— 即官方引擎的子类，只覆盖 summarize() 这一个钩子
//（官方 index.ts:231 原话：Override this sole hook for a template or remote summarizer.）。
//
// 移植来源：用户私有插件 dsh-compaction-rp（已授权并入；逐行对应官方 summarizeWithLlm）。
//
// 生成器纪律（与 lib/rp-agent.js 的 buildInjectModule 同款）：
//   · 返回【源码文本】而不是模块对象 —— 文本随预设目录落盘、以 ./ 相对路径被 preset 引用；
//   · 产物自包含：只许 node:* 内置模块 + 运行时解析到的官方包，⛔ 不许 import 本插件 lib；
//   · 产物确定性：同一次调用永远逐字节相同（无时间戳/随机数）；
//   · 产物 import 期绝不抛异常：解析不到官方包 ⇒ 降级（大声日志 + degraded 导出 +
//     占位类），绝不因本文件让 preset 挂不上。
//
// ★ 2026-09-21 起产物覆盖**两个**钩子（第二个的理由见产物头部「自动压缩触发阈值」一节）：
//   ① summarize()        —— 换成 RP 归档指令（本文件的存在理由，见上）；
//   ② compactIfNeeded()  —— 「自动压缩触发阈值」**每轮现读**面板那个数
//      （官方源码在注册自动压缩处逐字写着：`compactIfNeeded` stays dynamically dispatched
//      so **subclass overrides are honored at event time**）—— 面板改完下一轮就生效。
//      覆写体只换"拿哪个阈值"，随后 `super.compactIfNeeded(...)` 原样走官方实现。
// ---------------------------------------------------------------------------

/** 产物的约定文件名（preset compaction 组里 name: './mt-compaction-rp.js' 引用）。 */
export const RP_COMPACTION_FILE_NAME = 'mt-compaction-rp.js'

/**
 * 生成 <preset>/mt-compaction-rp.js 的完整源码文本。
 * @returns {string} 自包含 ESM 模块源码（确定性：同样的调用逐字节相同）。
 */
export function buildRpCompactionBackend() {
  return `// dsh-memory-archive — CC-BY-NC-4.0；移植来源 anima-rag (https://github.com/Ellinav/anima-rag) 作者 Ellinav
//
// mt-compaction-rp —— 中文 RP 长会话专用的上下文压缩后端（本文件随预设目录发布，用 ./ 相对路径引用）。
//
// 它是什么：官方 @deepseek-ai/dsh-compaction-basic 的【子类】，覆盖 summarize() 与
// compactIfNeeded() 两个钩子（后者只为「每轮现读面板阈值」，见下）—— summarize 是官方源码
// compaction-basic/src/index.ts:231 留的那个钩子：*"Override this sole hook for a
// template or remote summarizer."* 其余全部继承：压力阈值判定、保留策略、token 计量、
// agent/pre-step 自动触发、agent/request-error 的溢出恢复、/compact 手动触发、durable 压缩事务。
//
// 为什么换提示词要自己重写那次调用：官方 summarize() = summarizeWithLlm(...)，指令硬编码在
// summarizer.ts:149（content: [{ type: 'text', text: COMPACTION_INSTRUCTION }]），没有任何配置键。
// ⇒ 照它的形状自己发一次 ctx.llm.stream()：会话自己的 system + tools + 被压区消息原样放前面，
//   我们的指令作为最后一条 user 消息追上去 —— 这次辅助调用是上一次真实请求的前缀延长，
//   provider 的 KV cache 能复用而不是被击穿。下面 summarize() 逐行对应官方实现。
//
// ★ import 期绝不抛异常：本文件 import 时抛 = preset 挂不上 = 用户开不了周目。
//   官方包拿不到 ⇒ 降级：大声记日志，并让本 preset 回落到官方 compaction-basic 的行为
//   （锚点能解析到官方包就重导出官方引擎本身；连它也拿不到 ⇒ 导出能被安全实例化的占位类）。
//
// ★ 模块解析：为什么是【同步 require】而不是 import() —— 本文件住在预设目录里，那里没有
//   node_modules；而预设目录里的 .js 会被宿主 loader 用 esbuild 转成 CJS 再执行（沙箱实测
//   报错：Top-level await is currently not supported with the "cjs" output format）
//   ⇒ 本文件⛔不允许任何顶层 await、import.meta、动态 import —— 违反任意一条 = Transform
//   failed = preset 挂不上。解法：用正在运行的宿主自己当解析锚点，createRequire(anchor)
//   同步拿包。锚点候选按可靠性排序（实测结论）：
//     · process.argv[1]（宿主入口）最优，两个官方包都能解析；
//     · <cwd>/apps/cli/package.json、<cwd>/packages/bundle/base/package.json 也可以；
//     · checkout 根目录本身解析不到（pnpm 只把 workspace 包链进消费者的 node_modules）
//       ⇒ cwd 只能当最后的兜底。
//   官方包是 esbuild 的 CJS 产物 ⇒ require 拿到的就是宿主正在用的同一个模块实例
//   （同一条绝对路径 = 同一个 CJS 缓存条目，instanceof 语义一致）。
//   全部锚点都失败 ⇒ 每一条原因原样写进降级日志与 degraded 导出，不吞。
//
// 配置面（摘掉前三个键，其余全部原样转发给官方 base，由官方 resolveConfig 校验与填默认值
// ⇒ 上游加键自动透传，不会因 schema 跟不上而报 unknown key）：
//   customInstruction  ''     整段替换摘要指令；非空时优先于内置模板
//   summaryLanguage    'auto' auto / zh / en；对 customInstruction 是追加语言提示，auto 不追加
//   faithful           true   内置模板是否要求专有名词/数值逐字照抄
//   其余键                    thresholdRatio / retainRatio / retainTokens / summarizationProvider /
//                             summarizationModel / maxTokens / compactionRetries / maxOverflowRetries /
//                             modelPolicies / auto（全部官方默认）
//
// ★ 面板阈值（2026-09-21）走的是**另一条路**，⛔ 不是上面这些配置键：面板把玩家选的百分比写进
//   插件配置 「<DSH_HOME|~/.dsh>/dsh-memory-archive/config.json」 的 「autoCompact」 一段，
//   本模块每次 compactIfNeeded() 现读它并用比例式（thresholdRatio + retainRatio）**整体替换**
//   「this.config」 ⇒ 预设 YAML 里那两个数只是**没开面板时**的原值。详见下面「自动压缩触发阈值」一节。

import { createRequire } from 'node:module'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const TAG = 'mt-compaction-rp'
const BASIC_PKG = '@deepseek-ai/dsh-compaction-basic'
const LLM_PKG = '@deepseek-ai/dsh-llm'

export const name = TAG

/** 与官方 basic 同构：需要 LLM、token 计量与会话注册表。 */
export const inject = ['llm', 'tokenMeter', 'sessions']

/** 解析锚点候选，按可靠性排序（实测结论写在文件头注释）。 */
function hostAnchors() {
  const cwd = process.cwd()
  return [
    process.argv[1],
    join(cwd, 'apps', 'cli', 'src', 'bin.ts'),
    join(cwd, 'apps', 'cli', 'package.json'),
    join(cwd, 'packages', 'bundle', 'base', 'package.json'),
    cwd,
  ].filter((anchor) => typeof anchor === 'string' && anchor.length > 0)
}

/**
 * 按锚点同步 require 宿主侧包；全失败返回 { ok:false, error }，绝不抛（每条原因原样在案）。
 * ⛔ 本函数必须保持同步：顶层 await 在宿主 loader 的 CJS 转译下直接 Transform failed。
 */
function tryLoadHostPackage(specifier) {
  const reasons = []
  for (const anchor of hostAnchors()) {
    try {
      return { ok: true, mod: createRequire(anchor)(specifier) }
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\\n')[0] : String(error)
      reasons.push(anchor + ': ' + message)
    }
  }
  return {
    ok: false,
    error: TAG + ': cannot load host module "' + specifier + '" from the running host.\\n'
      + reasons.map((reason) => '  - ' + reason).join('\\n'),
  }
}

const basicLoad = tryLoadHostPackage(BASIC_PKG)
const llmLoad = tryLoadHostPackage(LLM_PKG)

/** 降级记录：null = 正常；非 null = 拿不到官方包，已降级（reason 含每一条原因，如实报告）。 */
export const degraded = basicLoad.ok && llmLoad.ok
  ? null
  : { reason: [basicLoad, llmLoad].filter((r) => !r.ok).map((r) => r.error).join('\\n\\n') }

if (degraded !== null) {
  // 大声：import 期还没有 ctx，只有 console；挂载后构造时还会用 ctx.logger 复述一遍。
  console.error('[' + TAG + '] ★★★ 降级：拿不到官方包，本 preset 将回落（详见 degraded 导出）:\\n' + degraded.reason)
}

/** 支持的摘要语言标签；auto 表示跟随内置模板（中文 RP ⇒ 中文）。 */
export const LANGUAGES = ['auto', 'zh', 'en']

/**
 * 内置 RP 归档指令（设计意图：不要长摘要、不要文风 —— 产出的是给未来检索用的索引条目：
 * 时间跨度 / 地点 / 角色 / 关键事件 / 未回收伏笔 + 结构化 tags，专有名词与数值逐字照抄）。
 *
 * D4（20260915）：并入 anima「Summarization Guidelines」的准则 —— 时间前缀 / 专有名词
 * 数值逐字照抄 / Show-Don't-Tell / 防过度切分 / 结构化标签（{vibe, special, important}，
 * vibe 枚举见 lib/ami-tags.js 的 VIBE_TAGS）。anima 原文依赖它自己包装层填的三个外部
 * 标签占位，本指令是**自包含**的：⛔ 不出现任何外部标签名 —— 输入就是被压区消息本身，
 * 指令作为最后一条 user 消息追加（见本文件 summarize()），无需占位标签。
 * @param {string} language - zh 或 en。
 * @param {boolean} faithful - 是否要求专有名词逐字照抄（关掉则允许轻度转写）。
 */
/**
 * anima 的「总结提示词」逐字（2026-09-16 对齐）。
 * 来源：人的文件/anima_summary_prompts_20260916T06575.json 第 11 条（title「总结提示词」）。
 * ⛔ 不含 anima 的「破限」那条 —— 按用户口径，破限头不由我们内置（界面留空、玩家自填）。
 */
const ANIMA_SUMMARY_INSTRUCTION = [
  "# Summarization Guidelines",
  "Target: Create a high-density NARRATIVE CHRONICLE of the Macro Plot. Consolidate interactions into coherent storylines while explicitly preserving specific entities as memory anchors.",
  "",
  "## MACRO Plot Progression",
  "- Reference <basic_info> & <previous_summary> for context.",
  "- Comprehensively scan <new_text_to_summarize>. Identify the core narrative arcs (Who/What/Where/Result).",
  "",
  "## Segmentation Strategy",
  "0. Aggressive Merging: Prioritize continuity. Group continuous interactions into ONE segment unless a hard trigger is met.",
  "1. Minimum Density: A segment MUST contain a full plot loop (Action -> Reaction -> Result). NEVER split for brief reactions.",
  "2. Split Triggers ONLY when:",
  "- Sustained Vibe Shift: Split ONLY if the atmosphere flips AND STAYS changed for the rest of the scene. Ignore transient spikes.",
  "  - Merge: a joke during a serious meeting",
  "  - Split: [Daily] -> Explosion -> [Action]",
  "- Narrative Break: Significant change in Location/Time. Ignore natural time passing during continuous dialogue (e.g., Midnight -> Dawn without a \\"fade to black\\" break)",
  "",
  "## Writing Logic",
  "Structure: [Time Prefix]: [Content]",
  "1. Time Prefix: Combine Date (if found) with General Time Block (e.g., \\"2025/12/11 深夜\\", \\"永和九年 子时\\", \\"初夏某日 下午\\"). DO NOT split minute-by-minute.",
  "2. Anchors",
  "- Preserve specific appointment times/locations (e.g., \\"晚上9点见\\", NOT \\"晚上见\\")",
  "- Unique & Interactive Proper Nouns (e.g., \\"在Mellow甜品店吃柠檬巴菲\\", NOT \\"吃甜品\\" )",
  "3. Dialogue:",
  "  - Key: Quote directly (Max 1-2 line). Triggered by plot-critical reveals, confessions, threats, promises, or declarations.",
  "  - Casual: Summarize intent (e.g., Sam抱怨了冬天的寒冷)",
  "",
  "## Style",
  "- Perspective: Third-person.",
  "- Objectivity: State facts directly. DO NOT evade/censor sensitive/NSFW content, record what exactly happens.",
  "- Show, Don't Tell: Record the evidence. NO abstract conclusion.",
  "  - Bad: 他们的关系更亲密了",
  "  - Good: Sam第一次主动握住了Sofia的手",
  "",
  "# Tagging Rules (PER Segment)",
  "",
  "### Vibe Tag (Select ONE dominant)",
  "- [Daily] (Routine, relax, casual)",
  "- [Wholesome] (Comfort, sweet, peace)",
  "- [Comedy] (Funny, absurd)",
  "- [Conflict] (Arguments, hostility, misunderstandings, jealousy, cold wars. NOT playful teasing.)",
  "- [Action] (Combat, adventure, danger)",
  "- [Angst] (Pain, tragedy, trauma)",
  "- [Suspense] (Fear, mystery, tension)",
  "- [Romantic] (Heart-focused, intimacy, flirting, love)",
  "- [Sexual] (Body-focused, lust)",
  "- [Serious] (Work, deep logic, lore-dump)",
  "",
  "### Special Tags (OPTIONAL Array)",
  "ONLY include if the segment occurs during the event OR contains related content (conversations/items/symptoms)",
  "- Events: [Halloween], [Christmas], [Birthday], [Anniversary], [NewYear], [Valentine], [Travel]",
  "- Health:",
  "  - [Period] (Explicit mentions OR implied cues like cramps, hot water bottles)",
  "  - [Sick] (Physical illness, weakness or injury)",
  "- If none apply, output an empty list [].",
  "",
  "## Important Tag (Boolean)",
  "Default \`false\`. Narrative Logic > Emotional Intensity. Set \`true\` ONLY for **IRREVERSIBLE World State Changes**:",
  "1. Status: Death, Breakup/Marriage, Firsts (kiss/date/confession), Permanent Separation, etc.",
  "2. Lore: Major Secret Revealed (New info), Key Item/Location unlocked.",
  "IMPORTANT: Set \`false\` for everything else, including:",
  "- Emotional outbursts/threats/arguments without permanent consequence",
  "- Repeating known info",
  "- Revertable Status",
  "",
  "# Format",
  "- Type: RAW JSON Array \`[...]\`. Start immediately with \`[\`.",
  "- Language: Summary in Chinese. JSON keys/Tags in English.",
  "- Length: ~600-800 tokens in total",
  "- Example:",
  "[",
  "  {",
  "    \\"summary\\": \\"2025/10/15 深夜: 在废弃地铁站的安全屋中，Ellina和Krist正在整理补给品。Ellina一边处理手上的擦伤，一边调侃罐头食品的口味，试图缓解紧张的气氛。Krist配合着她的玩笑，默默地将稀缺的抗生素递给她。这段时间的宁静与温情让二人暂时忘记了外面的追兵。\\",",
  "    \\"tags\\": {",
  "      \\"vibe\\": \\"Wholesome\\",",
  "      \\"special\\": [],",
  "      \\"important\\": false",
  "    }",
  "  },",
  "  {",
  "    \\"summary\\": \\"2025/10/15 深夜: 警报声突然刺破了宁静，打破了之前的温馨氛围。安全屋监控显示‘猎犬’部队已突破。Krist的态度瞬间转变，他迅速推灭篝火，将Elina护在身后，语气冰冷地命令她进入隐蔽点。他首次拔出了背后的高频震动刃，并向Elina揭露了残酷的真相：敌人不是来抓捕的，而是来执行清除指令的。\\",",
  "    \\"tags\\": {",
  "      \\"vibe\\": a\\"Suspense\\",",
  "      \\"special\\": [],",
  "      \\"important\\": true",
  "    }",
  "  }",
  "]",
  "",
  "# Critical Review",
  "Prevent Over-Segmentation. Default to merge!",
].join('\\n')

/**
 * 内置归档指令 —— anima 的「总结提示词」逐字（见下方常量 ANIMA_SUMMARY_INSTRUCTION）。
 * 语言/faithful 两个参数保留只为兼容既有调用与配置（anima 原文自带 Language: Summary in Chinese，
 * 不再分 zh/en 两版、也不再有 faithful 变体）。
 */
function rpArchiveInstruction(language, faithful) {
  return ANIMA_SUMMARY_INSTRUCTION
}

/**
 * 从配置解析出生效的摘要指令（构造函数在构造期调用一次，之后只读）。
 * @param {string} customInstruction - 整段替换；非空时优先，空时用内置 RP 模板。
 * @param {string} summaryLanguage - 已校验的 auto / zh / en。
 * @param {boolean} faithful - 内置模板的逐字保留开关。
 */
export function resolveInstruction(customInstruction, summaryLanguage, faithful) {
  if (typeof customInstruction === 'string' && customInstruction.length > 0) {
    if (summaryLanguage === 'zh') return customInstruction + '\\n\\n（输出用中文。）'
    if (summaryLanguage === 'en') return customInstruction + '\\n\\n(Write the output in English.)'
    return customInstruction
  }
  return rpArchiveInstruction(summaryLanguage === 'en' ? 'en' : 'zh', faithful)
}

let RpCompactionEngine

// ───────────────────────────────────────────────────────────────────────────
// 摘要输入该长什么样（2026-09-20 用户口径：「只传最终生成的文本和 user 信息，不传思维链
// （但思维链需要被摘除）」）
//
// ⚠️ 为什么必须有这一层（真机踩过，验收单〇之十六）：宿主交给摘要后端的 input.messages
// **第 0 条就是整个系统提示词** —— compaction-basic/src/region.ts:530-545 把 surface node 0 的
// system/message 连同被压区间一起重放（为的是复用 KV cache 前缀）。那份 system 里含
// **我们/anima 注入的近场原文与检索记忆**，而它们这次**根本没被压掉**（下一轮还在）⇒
// 一起喂进去，模型就会去总结它们，摘要于是变成"原文的二次摘要"。
// 真机原文（模型自己的话）："The most recent actual RP content I have: recentFloors (楼 0249-0253)
// and immediateHistory." —— 那次压缩的可压区间是一条剧情都没有的测试会话。
//
// 所以这一层只放行：**真·玩家发言 + AI 的最终文本**。其余一律摘除（思维链、工具调用/结果、
// 系统提示词、插件注入、技能目录快照…），历史上那份 checkpoint 抠出来单独当 <previous_summary>。
// ───────────────────────────────────────────────────────────────────────────

/** 一条消息里可当"正文"用的文本块（text 之外的都不算：reasoning / tool-call / tool-result…）。 */
export function textOf(message) {
  const blocks = Array.isArray(message && message.content) ? message.content : []
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\\n')
    .trim()
}

/** 宿主 checkpoint 消息的固定抬头与包裹标签（见 compaction-basic 的 framedSummary）。 */
const CHECKPOINT_MARK = 'automatically generated checkpoint'
const COMPACTED_OPEN = '<compacted-summary>'
const COMPACTED_CLOSE = '</compacted-summary>'

/** 从 checkpoint 文本里抠出上一份摘要正文；抠不到 ⇒ 空串（⛔ 不猜）。 */
export function previousSummaryOf(text) {
  const open = text.indexOf(COMPACTED_OPEN)
  const close = text.lastIndexOf(COMPACTED_CLOSE)
  if (open < 0 || close <= open) return ''
  return text.slice(open + COMPACTED_OPEN.length, close).trim()
}

/**
 * 把宿主的重放前缀过成"摘要该看的东西"。
 *
 * 摘除规则（每条都有真机样本）：
 *   · role system：整条丢 —— 就是那份系统提示词（含注入的近场原文）；
 *   · role tool / 块类型 tool-result：丢（工具结果虽然 role 是 user，但不是玩家说的话）；
 *   · assistant：**只要 text 块**（reasoning 思维链、tool-call 全摘除）；
 *   · user：**只要 source.kind === 'user'** —— 真·玩家发言；插件注入的后处理指令、
 *     技能目录快照等一律不进摘要；
 *   · checkpoint：抠成 previous_summary 标签块，不混进正文。
 *
 * ★★ 2026-09-22（真机事故 + 修复）：重建消息时**必须**把原来的 source 搬过去。
 *   为什么（真机取证链条）：官方 llm runtime 的 forAdapter 对**每条 assistant 消息**无守卫地读
 *   message.source.kind；我们以前重建出来的消息**一条都没有 source** ⇒ 它在**调用 provider 之前**
 *   就抛 "Cannot read properties of undefined (reading 'kind')"，被包成 code=UNKNOWN 的 error finish
 *   （**零内容块**）⇒ 整轮压缩失败，而现象只是"自动压缩好像没触发"。
 *   ⛔ 所以这里**没有开关**：有 source 就搬（原来没有 ⇒ 不硬造，形状如实）。
 *   **过滤规则一个字没动**（还是"只要 text 块 / 丢 system 与 tool-result / checkpoint 抠成 previous"）。
 * @param {Array} messages - 宿主的重放前缀（input.messages）。
 * @returns {{messages: Array, previous: string}} 过滤后的最小消息数组 + 上一份摘要。
 */
export function renderSummaryInput(messages) {
  const kept = []
  let previous = ''
  /** 重建一条消息；**原来的 source 照搬**（是个对象才搬；没有就不给）。 */
  const rebuilt = (role, message, text) => {
    const out = { role, content: [{ type: 'text', text }] }
    const source = message && message.source
    if (source !== null && typeof source === 'object') out.source = source
    return out
  }
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message && message.role
    if (role !== 'user' && role !== 'assistant') continue
    const text = textOf(message)
    if (text === '') continue
    if (role === 'assistant') {
      kept.push(rebuilt('assistant', message, text))
      continue
    }
    const blocks = Array.isArray(message.content) ? message.content : []
    if (blocks.some((block) => block && block.type === 'tool-result')) continue
    // checkpoint：**先认标记再认来源**（真机那份是 kind plugin + plugin 'compact'，
    // 但不押在来源上 —— 判据只看那段固定抬头 + <compacted-summary> 标签）。
    if (text.includes(CHECKPOINT_MARK)) {
      const inner = previousSummaryOf(text)
      if (inner !== '') previous = inner
      continue
    }
    const kind = message.source && message.source.kind
    if (kind !== 'user') continue
    kept.push(rebuilt('user', message, text))
  }
  return { messages: kept, previous }
}

/** 开标签那一条的措辞（逐字取自 anima 提示词链第 7 条，让指令点名的标签真的存在）。 */
const SUMMARY_TARGET_OPEN = '## Summary Target'
  + '\\nScan the entire provided text within <text_to_summarize>. Every line matters to the Chronicle.'
  + '\\n<text_to_summarize>'
const SUMMARY_TARGET_CLOSE = '</text_to_summarize>'

/** 包一层标签。 */
function wrapped(tag, body) {
  return '<' + tag + '>\\n' + body + '\\n</' + tag + '>'
}

/**
 * 造一条 user 消息 —— 官方 「createUserMessage」 的同形兜底（不传工厂时用它）。
 * ⛔ 只为**自检台**能直接测这个纯函数（降级导入时拿不到官方包 ⇒ 必须有这份兜底）。
 * @param {object} input - { content, source? }（与官方 createUserMessage 的入参同形）。
 * @returns {object} { role:'user', content, source? }。
 */
function plainUserMessage(input) {
  const message = { role: 'user', content: input.content }
  if (input.source !== undefined) message.source = input.source
  return message
}

/**
 * 组装 RP 摘要请求的 messages（★ 2026-09-22 修好后的唯一形状）。
 *
 * **每条消息都带 source**（这是硬要求，不是可选项 —— 真机事故见 renderSummaryInput 的注释：
 * 少一条 assistant 的 source，整条请求在**调用 provider 之前**就被上游拒掉）：
 *   · 会话消息：由 renderSummaryInput 带着**原来的** source 进来；
 *   · 我们自己那几条（previous_summary 包裹 / 开闭标签 / 指令）：统一给 plugin source。
 * @param {{messages: Array, previous: string}} rendered - renderSummaryInput 的结果。
 * @param {string} instruction - 生效的摘要指令（构造期解析好的 this.instruction）。
 * @param {Function} [makeUserMessage] - 造 user 消息的工厂：产物里传官方 createUserMessage
 *   （带 id 与冻结），不传就用同形的 plainUserMessage（自检台直接测这个纯函数时走这条）。
 * @returns {Array} 要发给 ctx.llm.stream 的 messages（⛔ 不许出现没有 source 的消息）。
 */
export function buildRpSummaryMessages(rendered, instruction, makeUserMessage) {
  const make = typeof makeUserMessage === 'function' ? makeUserMessage : plainUserMessage
  const pluginSource = { kind: 'plugin', plugin: TAG }
  const user = (text) => make({ content: [{ type: 'text', text }], source: pluginSource })
  const kept = []
  for (const message of rendered && Array.isArray(rendered.messages) ? rendered.messages : []) {
    const source = message && message.source
    // ★ 不变量：**这条请求里绝不许出现没有 source 的消息**（上游 forAdapter 对每条 assistant
    //   消息都读 source.kind，少一条整条请求就被拒）。会话消息搬**原来的** source；
    //   原来没有（理论上宿主每条都有，但**一旦没有就是静默全败**）⇒ 补一个 plugin source。
    kept.push({
      role: message.role,
      content: message.content,
      source: source !== null && typeof source === 'object' ? source : pluginSource,
    })
  }
  const previous = rendered && typeof rendered.previous === 'string' ? rendered.previous : ''
  const out = []
  if (previous !== '') out.push(user(wrapped('previous_summary', previous)))
  out.push(user(SUMMARY_TARGET_OPEN))
  out.push(...kept)
  out.push(user(SUMMARY_TARGET_CLOSE))
  out.push(user(instruction))
  return out
}

// ───────────────────────────────────────────────────────────────────────────
// 「自动压缩触发阈值」—— **每轮现读**（2026-09-21，面板「记忆库 → 压缩」）
//
// 面板把阈值写进 <DSH_HOME|~/.dsh>/dsh-memory-archive/config.json 的 autoCompact 一段。
// **正在玩的这一场**吃它，靠的就是下面这几个函数：每次 compactIfNeeded() 都现读一次盘
// ⇒ 改完**下一轮**就生效（不用重开周目、不用重启宿主；官方 pre-step 每轮都会调这个方法）。
//
// ★ 路径推导与本插件宿主侧 lib/index.js 的 storageDir() **逐字同一套**
//   （DSH_HOME 优先 → ~/.dsh；再拼 dsh-memory-archive；新名目录不存在时回退旧名
//   magictarven）—— 自检台有一条「同一组 env 下两边必须给出同一个绝对路径」的正反证钉漂移。
// ⛔ 本文件随预设发布、必须**自包含**：⛔ 不许 import 本插件的 lib（预设目录里没有它），
//   所以这里带一份最小实现。
//
// 纪律（任务书 §3.2）：
//   · 读不到 / JSON 坏 / 没有这一段 / usePanelThreshold === false ⇒ **用 YAML 原值**
//     （⛔ 绝不退回官方默认的 0.8 —— 那是"没配就变官方默认"，会让面板看着像生效了）；
//   · 「retainTokens」 换成**比例式** 「retainRatio」（与窗口无关），并在读取处夹紧
//     「retainRatio = min(YAML 值, thresholdRatio × 0.7)」 ⇒ 「retainRatio < thresholdRatio」
//     **恒成立**（玩家把阈值调到 5% 也不会撞官方的 TargetPressureConfigError）；
//   · 覆写里**不许吞异常**：拿不到配置就照原值走，但⛔ 不许让异常冒出去打断整轮
//     （照官方 pre-step 那个 try/catch + logger.warn 的口径）。
// ───────────────────────────────────────────────────────────────────────────

const PANEL_PLUGIN_DIR = 'dsh-memory-archive'
const PANEL_CONFIG_FILE = 'config.json'
/** 改名遗留（与宿主侧同一张表）：盘上只有旧名目录时回退读它。 */
const PANEL_LEGACY_DIRS = ['magictarven']
const PANEL_PERCENT_MIN = 5
const PANEL_PERCENT_MAX = 90
const PANEL_PERCENT_STEP = 5
const PANEL_RETAIN_DEFAULT = 0.05
const PANEL_RETAIN_CAP = 0.7

/** 展开开头的 ~（与宿主侧同一套；Windows 上 ~\\ 也认）。 */
function panelExpandHome(p, home) {
  if (p === '~') return home
  if (p.slice(0, 2) === '~/' || p.slice(0, 2) === '~\\\\') return join(home, p.slice(2))
  return p
}

/**
 * 存储目录 = 「<DSH_HOME|~/.dsh>/dsh-memory-archive」（与宿主侧 storageDir() 同一套推导）。
 * 导出只为自检台能直接比"两边同一组 env 下是不是同一个绝对路径"（运行时不依赖这个导出）。
 */
export function panelStorageDir(env) {
  const configured = env && env.DSH_HOME
  const dshHome = configured !== undefined && String(configured).trim() !== ''
    ? String(configured)
    : join(homedir(), '.dsh')
  const root = resolve(panelExpandHome(dshHome, homedir()))
  const primary = join(root, PANEL_PLUGIN_DIR)
  if (existsSync(primary)) return primary
  for (const legacy of PANEL_LEGACY_DIRS) {
    const dir = join(root, legacy)
    if (existsSync(dir)) return dir
  }
  return primary
}

/**
 * 把面板百分比收成「5–90 的整数、步长 5」；非数字/缺值 ⇒ **null**（调用方据此用 YAML 原值）。
 * ⛔ 这里不"猜一个数顶上"：读不出来就是 null，理由留给状态端点去说（那才是能显示给人看的地方）。
 */
export function clampPanelPercent(value) {
  const raw = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN)
  if (!Number.isFinite(raw)) return null
  const aligned = Math.round(raw / PANEL_PERCENT_STEP) * PANEL_PERCENT_STEP
  return Math.min(PANEL_PERCENT_MAX, Math.max(PANEL_PERCENT_MIN, aligned))
}

/**
 * 保留比例夹紧：「min(给定值, thresholdRatio × 0.7)」 ⇒ **恒小于 「thresholdRatio」**。
 * 「thresholdRatio」 不合法（≤0/非数）⇒ null（判不出来就不换配置，照原值走）。
 */
export function clampPanelRetainRatio(retainRatio, thresholdRatio) {
  const t = typeof thresholdRatio === 'number' ? thresholdRatio : Number(thresholdRatio)
  if (!Number.isFinite(t) || t <= 0) return null
  const raw = typeof retainRatio === 'number' ? retainRatio : Number(retainRatio)
  const want = Number.isFinite(raw) && raw > 0 ? raw : PANEL_RETAIN_DEFAULT
  // 四舍五入到 6 位：只为去掉浮点尾巴（0.05 × 0.7 = 0.034999999999999996 这种），
  // ⛔ 不影响「严格小于」—— 0.7×t 与 t 之间至少差 0.3t（面板最小 5% ⇒ 差 0.015）。
  // ⚠️ 宿主侧 lib/compaction-threshold.js 的 clampRetainRatio 是同一套（自检台两边都扫）。
  const out = Math.round(Math.min(want, t * PANEL_RETAIN_CAP) * 1e6) / 1e6
  return out > 0 && out < t ? out : null
}

/**
 * 纯函数：从**配置文本**里读 「autoCompact」（⛔ 不碰盘 —— 自检台直接喂假读盘结果测这一条）。
 * @param {string} text - config.json 的全文（读不到就传空串/null）。
 * @returns {{usePanelThreshold: boolean, thresholdPercent: number|null, reason: string|null}|null}
 *          整段读不出来（空/坏 JSON/没有这一段）⇒ **null** = 用 YAML 原值。
 */
export function readPanelAutoCompact(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { usePanelThreshold: false, thresholdPercent: null, reason: 'config.json 不是合法 JSON（' + String((error && error.message) || error) + '）⇒ 用预设原值' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const section = parsed.autoCompact
  if (section === null || typeof section !== 'object' || Array.isArray(section)) {
    return { usePanelThreshold: false, thresholdPercent: null, reason: 'config.json 里没有 autoCompact 这一段 ⇒ 用预设原值' }
  }
  return {
    usePanelThreshold: section.usePanelThreshold === true,
    thresholdPercent: clampPanelPercent(section.thresholdPercent),
    reason: null,
  }
}

/**
 * 薄壳：读盘 → 「readPanelAutoCompact」。读盘失败（不存在/权限/目录不是目录）⇒ null，⛔ 不抛。
 * @param {object} [env] - 环境变量（注入以便自检；默认 process.env）。
 */
export function readPanelConfigFromDisk(env) {
  const e = env === undefined ? process.env : env
  try {
    return readPanelAutoCompact(readFileSync(join(panelStorageDir(e), PANEL_CONFIG_FILE), 'utf8'))
  } catch (error) {
    return null
  }
}

/**
 * 纯函数：算出这一轮该用的 「ResolvedConfig」。
 *
 * 口径：
 *   · 「panel」 为 null / 「usePanelThreshold !== true」 / 阈值读不出来 ⇒ **原样返回 baseConfig**
 *     （= 预设 YAML 那份，⛔ 不是官方默认 0.8）；
 *   · 否则**整体替换**成一份新对象（⛔ 不原地改 —— baseConfig 是 deepFreeze 的）：
 *     删掉互斥的 「retainTokens」（官方 resolveConfig 会以
 *     "retainRatio and retainTokens are mutually exclusive" 拒掉同给两份的配置），
 *     写上 「thresholdRatio」 与夹紧后的 「retainRatio」。
 *   基座永远是**构造期那一份**（「this.baseConfig」）⇒ 每轮算出的结果只由「面板 + YAML」决定，
 *   不会一轮一轮地累积（幂等：同样的输入永远同样的输出）。
 *
 * @param {object} baseConfig - 构造期官方 resolveConfig 出来的 ResolvedConfig。
 * @param {object|null} panel - 「readPanelAutoCompact」 / 「readPanelConfigFromDisk」 的结果。
 * @returns {{config: object, applied: boolean, thresholdRatio: number|null, retainRatio: number|null, reason: string|null}}
 */
export function applyPanelThreshold(baseConfig, panel) {
  const base = baseConfig !== null && typeof baseConfig === 'object' ? baseConfig : {}
  const keep = (reason) => ({ config: base, applied: false, thresholdRatio: null, retainRatio: null, reason })
  if (panel === null || panel === undefined) return keep(null)
  if (panel.usePanelThreshold !== true) return keep(null)
  const percent = clampPanelPercent(panel.thresholdPercent)
  if (percent === null) return keep('面板开关开着，但阈值读不出来（config.json 里 autoCompact.thresholdPercent 不是数）⇒ 用预设原值')
  const thresholdRatio = percent / 100
  const retainRatio = clampPanelRetainRatio(base.retainRatio, thresholdRatio)
  if (retainRatio === null) return keep('面板阈值 (' + percent + '%) 算不出保留比例 ⇒ 用预设原值')
  const next = Object.assign({}, base)
  delete next.retainTokens
  next.thresholdRatio = thresholdRatio
  next.retainRatio = retainRatio
  return { config: next, applied: true, thresholdRatio, retainRatio, reason: null }
}

/**
 * 取装配器的终态 finish，**任何异常都不许冒出去**（2026-09-22 真机修复）。
 *
 * 为什么不能直接写「assembler.finish」：官方那个 getter 在正常构建里有兜底
 * （没 finish chunk ⇒ {kind:'stop'}），但**真机（seeded / fork 会话）上实测**：这一取
 * 要么给 undefined，要么**取值本身就抛** "Cannot read properties of undefined (reading 'kind')"
 * —— 那是 45 轮压缩全炸的那一行。取不到就按官方语义当「正常结束」，让下游
 * 「有没有正文」那条（可读的错）去判；⛔ 绝不在这里猜成 'error'。
 *
 * @param {object} assembler - 官方 BlockAssembler 实例。
 * @returns {{kind: string}} 一个**保证可读 .kind** 的对象（拿不到就是 {kind:'stop'}）。
 */
export function readFinish(assembler) {
  try {
    const finish = assembler === null || assembler === undefined ? undefined : assembler.finish
    if (finish !== null && typeof finish === 'object') return finish
    return { kind: 'stop', unreadable: 'finish 不是对象：' + typeof finish }
  } catch (error) {
    return { kind: 'stop', unreadable: '取 finish 抛错：' + String((error && error.message) || error) }
  }
}

/**
 * 把要发给模型的消息**形状**压成一行（⛔ 不记正文）：i:role/src=来源/blocks=块类型+块类型。
 * 只给排障用（2026-09-22：真机请求"刚发就废"，要在这一行里看出哪个消息/块是空的）。
 * @param {Array} messages - 即将发给 ctx.llm.stream 的 messages。
 * @returns {string} 一行形状描述。
 */
export function describeMessages(messages) {
  try {
    return (Array.isArray(messages) ? messages : []).map((message, i) => {
      const source = message && message.source
      const content = message && message.content
      const blocks = Array.isArray(content)
        ? content.map((b) => (b === undefined ? 'UNDEF' : (b === null ? 'NULL' : String(b.type || b.kind || typeof b)))).join('+')
        : (content === undefined ? 'NO-CONTENT' : typeof content)
      return i + ':' + String((message && message.role) || '?')
        + '/src=' + (source === undefined ? 'MISSING' : (source === null ? 'NULL' : String(source.kind)))
        + '/blocks=' + blocks
    }).join(' ')
  } catch (error) {
    return 'shape-unavailable:' + String((error && error.message) || error)
  }
}

/**
 * 往同一份日志追加**一行 note**（不是失败，是"发生了什么"）。⛔ 同样自己绝不抛。
 * @param {object} ctx - 引擎的 ctx（不用，只为签名一致）。
 * @param {string} text - 一行说明。
 * @returns {void}
 */
export function logCompactionNote(ctx, text) {
  try {
    const dir = panelStorageDir(typeof process === 'undefined' ? undefined : process.env)
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'compaction-failures.log'),
      new Date().toISOString() + '  NOTE  ' + String(text).slice(0, 2000) + '\\n', 'utf8')
  } catch { /* ⛔ 记日志失败绝不影响压缩本身 */ }
}

/**
 * 压缩失败时把「一句话 + 堆栈」追加进日志 —— ⛔ 自己绝不抛（留证据可以，影响压缩不行）。
 *
 * 为什么要有它（2026-09-21 真机事故）：压缩失败时官方只在「agent/pre-step」的 catch 里
 * 「logger.warn」一句，而宿主是**控制台窗口**起的，玩家和维护者都看不到 ⇒ 故障能静默累积
 * **45 轮**（现象就是"自动压缩好像没触发"，上下文一路涨到 32% 还没被压过）。
 * 落盘到插件自己的目录，面板/人都能读。
 * 上限：单条截断 8KB；文件超过约 256KB 时整份重写成空（只保留最近若干条，避免无限增长）。
 *
 * @param {object} ctx - 引擎的 ctx（只为借 logger 复述一句）。
 * @param {unknown} error - 「compactIfNeeded」抛出的原样错误。
 * @param {string} trigger - 触发路（'pressure' / 'context-overflow' …）。
 * @returns {void}
 */
export function logCompactionFailure(ctx, error, trigger) {
  try {
    const dir = panelStorageDir(typeof process === 'undefined' ? undefined : process.env)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'compaction-failures.log')
    const message = String((error && error.message) || error)
    const stack = String((error && error.stack) || '(no stack)')
    const entry = new Date().toISOString() + '  trigger=' + String(trigger) + '  ' + message + '\\n'
      + (error && typeof error.failureDetail === 'string' ? '  failureDetail=' + error.failureDetail + '\\n' : '')
      + (error && typeof error.streamTrace === 'string' ? '  streamTrace=' + error.streamTrace + '\\n' : '')
      + (error && typeof error.requestShape === 'string' ? '  requestShape=' + error.requestShape.slice(0, 1500) + '\\n' : '')
      + (error && error.cause ? '  cause=' + String((error.cause && error.cause.message) || error.cause) + '\\n' : '')
      + stack.split('\\n').slice(0, 12).join('\\n') + '\\n\\n'
    let size = 0
    try { size = readFileSync(file, 'utf8').length } catch { size = 0 }
    if (size > 262144) writeFileSync(file, '', 'utf8')
    appendFileSync(file, entry.slice(0, 8192), 'utf8')
    try {
      if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn('[' + TAG + '] 压缩失败（已记入 ' + file + '）：' + message)
      }
    } catch { /* 复述失败无所谓 */ }
  } catch { /* ⛔ 记日志失败绝不影响压缩本身 */ }
}

/** 两份配置在"阈值/保留"这三件事上是不是同一形状（一样就不必换对象 —— 免得每轮都造新对象）。 */
function sameThresholdShape(a, b) {
  const x = a !== null && typeof a === 'object' ? a : {}
  const y = b !== null && typeof b === 'object' ? b : {}
  return x.thresholdRatio === y.thresholdRatio
    && x.retainRatio === y.retainRatio
    && ('retainTokens' in x) === ('retainTokens' in y)
}

if (basicLoad.ok && llmLoad.ok) {
  const BasicCompactionEngine = basicLoad.mod.default ?? basicLoad.mod.BasicCompactionEngine
  const { BlockAssembler, LlmError, contentHasImage, createUserMessage } = llmLoad.mod

  /** 把终态的摘要 finish 映射成 fail-closed 的错误（逐行对应官方 finishError）。 */
  function finishError(finish) {
    // ★ 2026-09-22 真机修复（事故：45 轮压缩全炸在这一行，现象=「自动压缩好像没触发」）：
    //   官方 BlockAssembler 的 finish getter 自带兜底 —— 它的注释逐字写着「流结束时没有 finish
    //   chunk ⇒ {kind:'stop'}」；但**真机（seeded / fork 会话）拿到的 finish 是 undefined**，
    //   于是下面 finish.kind 直接抛 "Cannot read properties of undefined (reading 'kind')"。
    //   我们这份是**照抄官方函数**，却漏了那句兜底语义 ⇒ 在这里按官方语义补齐：
    //   拿不到 finish ⇒ 当「正常结束」，让下游「有没有正文」那条去判（那条报的错是可读的）。
    if (finish === undefined || finish === null) return undefined
    switch (finish.kind) {
      case 'error':
      case 'aborted': {
        const error = new Error(finish.failure.message)
        error.code = finish.failure.code
        // ★ 2026-09-22：把**流层给的原始 failure** 一并带出去 —— 上游那条 message 只说
        //   "reading 'kind'"，不说它读的是谁的 kind。带出去由 logCompactionFailure 落盘。
        try { error.failureDetail = JSON.stringify(finish.failure).slice(0, 2000) } catch { /* 不影响 */ }
        return error
      }
      case 'max-tokens': {
        const error = new Error('summarization truncated at the token cap (incomplete checkpoint)')
        error.code = 'MAX_TOKENS'
        return error
      }
      default:
        return undefined
    }
  }

  /** 拒绝图像输出，只留文本块（逐行对应官方 summaryText）。 */
  function summaryText(blocks) {
    if (contentHasImage(blocks)) {
      throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
    }
    return blocks.filter((block) => block.type === 'text')
  }

  /**
   * 这次辅助调用该打给谁、用多大的输出预算（照官方语义两层：策略按会话自己的路由目标取；
   * 调用目标 = configured(显式摘要模型) ?? 最近一次请求的路由 ?? agent 选项）。
   *
   * ⚠️ **它必须是模块级普通函数，⛔ 不能写成类里的哈希私有方法**（2026-09-20 真机踩坑：
   * 报错原文「Receiver must be an instance of class RpCompactionEngine」，压缩按钮看起来"失灵"）。
   * 机制：cordis 把服务对象包成**可追踪 Proxy**（cordis/src/reflect.ts:141 的 getTraceable
   * → utils.ts:117 → createTraceable；方法取值再经 createShadowMethod，thisArg 被换成
   * shadow —— 仍是 Proxy）。而 **ES 私有成员过不了 Proxy**：this.#x 触发品牌检查 ⇒ 必抛。
   * 官方 compaction-basic 全文件**零个哈希私有成员**，所以它经 Proxy 没事；子类一旦用了，
   * 这个后端就会在第一次压缩时炸掉。**此后新增成员一律用公开属性**。
   * @param {object} engine - 引擎实例（它的属性都是公开的，经 Proxy 读得到）。
   * @param {object} agent - 被压会话的 agent。
   * @returns {{provider: string, model: string, maxTokens: number}} 辅助调用的目标。
   */
  function summarizeTarget(engine, agent) {
    const routed = agent.session.requestHeader()?.config
    const agentTarget = typeof agent.options?.provider === 'string' && agent.options.provider.length > 0
      && typeof agent.options?.model === 'string' && agent.options.model.length > 0
      ? { provider: agent.options.provider, model: agent.options.model }
      : undefined
    const route = routed !== undefined && routed.provider.length > 0 && routed.model.length > 0
      ? { provider: routed.provider, model: routed.model }
      : agentTarget

    const resolved = engine.config
    const override = route === undefined
      ? undefined
      : (resolved.modelPolicies ?? []).find(
        (policy) => policy.provider === route.provider && policy.model === route.model,
      )
    const summarizationProvider = override?.summarizationProvider ?? resolved.summarizationProvider
    const summarizationModel = override?.summarizationModel ?? resolved.summarizationModel
    const maxTokens = override?.maxTokens ?? resolved.maxTokens

    const configured = summarizationProvider.length === 0
      ? undefined
      : { provider: summarizationProvider, model: summarizationModel }
    const target = configured ?? routed ?? agentTarget
    if (target === undefined) {
      throw new Error(
        TAG + ': no provider/model available for summarization: set '
        + 'summarizationProvider/summarizationModel, route one request, or set both AgentOptions fields',
      )
    }
    return { provider: target.provider, model: target.model, maxTokens }
  }

  /**
   * 中文角色扮演会话的压缩后端。
   *
   * 构造函数摘掉自己的三个键、把其余全部转发给官方 base（由官方 resolveConfig 校验与填默认值）。
   * @param {object} ctx - 宿主 context（官方 base 需要 llm / tokenMeter / sessions）。
   * @param {object} [config] - RP 自己的三个键 + 官方 base 的全部键。
   */
  RpCompactionEngine = class RpCompactionEngine extends BasicCompactionEngine {
    constructor(ctx, config = {}) {
      const {
        customInstruction = '',
        faithful = true,
        summaryLanguage = 'auto',
        ...official
      } = config ?? {}
      if (!LANGUAGES.includes(summaryLanguage)) {
        throw new Error(
          TAG + ': summaryLanguage (' + String(summaryLanguage) + ') must be one of '
          + LANGUAGES.map((value) => '"' + value + '"').join(', '),
        )
      }
      super(ctx, official)
      /** 构造期解析一次，之后只读。 */
      this.instruction = resolveInstruction(customInstruction, summaryLanguage, faithful)
      /**
       * ★ 2026-09-21：**构造函数里把官方那部分原始配置存成公开属性**（⛔ 不用 「#」 —— cordis 把服务
       * 包成可追踪 Proxy，哈希私有成员过不了 Proxy，第一次压缩就炸「Receiver must be an instance…」）。
       * 两个都留：「officialConfig」 = 我们摘掉自己那三个键之后**交给官方 base 的那一份**（原始输入，
       * 面板/排障要看"预设里写的到底是什么"）；「baseConfig」 = 官方 resolveConfig **解析出来的**
       * ResolvedConfig（deepFreeze 过的、含填好的默认值）—— 每轮现读面板阈值时以**它**为基座
       * 整体替换，⛔ 不原地改（冻的，改会抛）。
       */
      this.officialConfig = official
      this.baseConfig = this.config
      /** 最近一次"算不出面板阈值"的人话原因（null = 正常）；面板/日志可读，⛔ 不参与判定。 */
      this.panelThresholdReason = null
      /** 每类告警只喊一声（与官方 pre-step 的 logger.warn 口径；公开属性，⛔ 不用 「#」）。 */
      this.panelThresholdWarned = ''
    }

    /**
     * ★ 自动触发点的**每轮现读**（2026-09-21）—— 面板改完，**正在玩的这一场下一轮就生效**。
     *
     * 为什么能这么接：官方 「compaction-basic」 源码在注册自动压缩时**逐字写明**
     * 「「compactIfNeeded」 stays dynamically dispatched so **subclass overrides are honored at
     * event time**」，并且 「agent/pre-step」 每个回合都会调它 ⇒ 子类覆写这个方法 = 官方那条
     * 自动触发路真的会走我们的代码（这正是任务书 §1.3 指定的那条缝）。
     *
     * 三件事，顺序不能换：
     *   ① 现读 「<DSH_HOME|~/.dsh>/dsh-memory-archive/config.json」 的 「autoCompact」；
     *   ② 由「构造期那份 ResolvedConfig + 面板读数」算出这一轮该用的 config（纯函数
     *      「applyPanelThreshold」：面板关着/读不到 ⇒ 原样返回 YAML 那份，⛔ 绝不退回官方 0.8）；
     *   ③ **整体替换** 「this.config」（形状没变就不动它 —— 免得每轮都造新对象）。
     * 然后**原样走官方那条路**（「super.compactIfNeeded(...)」）—— 阈值判定、保留策略、溢出恢复
     * 全部还是官方的实现，我们只换了"拿哪个阈值"。
     *
     * ⛔ 异常绝不外冒（照官方 pre-step 的 「try/catch + logger.warn」）：读盘/算配置出任何意外都
     *   只当"这一轮没读到面板阈值"，照 YAML 原值继续 —— 绝不让一次读盘失败打断玩家的整轮对话。
     *
     * @param {object} agent - 被判定会话的 agent。
     * @param {string} trigger - 'pressure'（自动）等（透传官方）。
     * @param {AbortSignal} [signal] - 取消信号（透传官方）。
     * @returns {Promise<*>} 官方的返回值（没到阈值 ⇒ null）。
     */
    async compactIfNeeded(agent, trigger, signal) {
      try {
        const panel = readPanelConfigFromDisk()
        const resolved = applyPanelThreshold(this.baseConfig, panel)
        this.panelThresholdReason = resolved.reason
        if (!sameThresholdShape(this.config, resolved.config)) {
          this.config = resolved.config
        }
      } catch (error) {
        const message = TAG + ': 面板阈值现读失败（照预设原值继续）：' + String((error && error.message) || error)
        if (this.panelThresholdWarned !== message) {
          this.panelThresholdWarned = message
          try {
            if (this.ctx && this.ctx.logger && typeof this.ctx.logger.warn === 'function') this.ctx.logger.warn(message)
            else console.warn(message)
          } catch {}
        }
      }
      try {
        return await super.compactIfNeeded(agent, trigger, signal)
      } catch (error) {
        // ★ 2026-09-21：压缩失败**必须留证据** —— 官方只在 pre-step 里 warn 一句，而宿主的
        //   控制台窗口没人看 ⇒ 真机上静默失败了 45 轮（现象="自动压缩好像没触发"）。
        logCompactionFailure(this.ctx, error, trigger)
        throw error
      }
    }

    /**
     * 用 RP 归档指令摘要被压区 —— **三档回退梯子**（★ 2026-09-22）。
     *
     * 三档（每档只差一个变量，逐档试，谁赢谁上）：
     *   · **R1** = 现状形状（RP 指令 + renderSummaryInput 重建的消息、**不带 source** + 两层包裹，
     *     不传 tools）—— 基线；真机 requestShape 里「0:user/src=MISSING … 35:user/src=plugin/blocks=text」
     *     就是它；
     *   · **R2** = R1 **+ 每条消息都带 source**（会话消息保留原来的 source、我们的包裹给 plugin
     *     source）—— 用来判「缺 source 就是元凶」（⛔ 两档之间只差这一个变量）；
     *   · **R3** = 官方形状（「super.summarize」：input.messages 原样 + 有 tools 就传 + 官方指令）
     *     —— 已知能成的那条。
     * ⛔ 上限三档（最多三次 ctx.llm.stream），⛔ 不无限重试；三档全失败 ⇒ 抛**最后那条**的错误（⛔ 不吞）。
     * ★ **谁赢的必须落盘**（logCompactionNote，人话结论）；每档失败也落盘
     *   （logCompactionFailure，trigger = summarize-r1 / summarize-r2 / summarize-r3）。
     *
     * 真机线索（2026-09-22）：失败时流里**只有一条 error finish、零内容块**、code=UNKNOWN、
     * message="Cannot read properties of undefined (reading 'kind')" ⇒ 请求**刚发就废**。
     * 上游 llm/src/index.ts 里那条处理路径（forAdapter → dispatch → adapterFailureChunk）正好
     * 逐条读 message.source.kind，而**只有 assistant 消息**会走到那次读 —— 我们重建的 assistant
     * 消息恰好没有 source。⇒ R2 补的就是这一处（**真机验证归人**，这里只落梯子与证据）。
     *
     * ⚠️ 与官方 summarizeWithLlm **故意不同**的两处（2026-09-20 用户口径 = 只传玩家发言 +
     * AI 最终正文、思维链摘除）：
     *   ① 不再原样转发 input.messages（它第 0 条是**整个系统提示词**，含注入的近场原文），
     *      改走 renderSummaryInput() 过滤；
     *   ② 不再传 input.tools（摘要不需要工具；系统提示词都不传了，KV cache 前缀本来也保不住）。
     *   顺带补上 anima 提示词链里点名的标签 text_to_summarize / previous_summary
     *   —— 指令一个字没改，只是让它们真正存在（否则模型会去总结别处的文本，真机踩过）。
     *
     * ⚠️ input.system：宿主**没有**这个字段 —— SummarizationInput 只有 { tools?, messages }，
     *   系统提示词是作为 messages[0]（role: system）来的（region.ts:530-545）。
     *   ⛔ 别再写 input.system 的判断，那是空操作。
     * @param {object} input - 被压的重放前缀 { tools?, messages }。
     * @param {object} agent - 提供路由模型历史、回退模型与会话 id。
     * @param {AbortSignal} [signal] - 取消信号，透传给适配器。
     * @returns {Promise<object>} 官方 SummarizationResult 形状。
     */
    async summarize(input, agent, signal) {
      // 目标模型先解析：三档都要用它，解析不出（没配摘要模型/没路由过）就直接抛 ——
      // 那不是"形状"问题，落盘由上层 compactIfNeeded 的 catch 负责（trigger = 调用方给的那个）。
      const target = summarizeTarget(this, agent)
      // 只渲染一次（**带** source）：R1 由 buildRpSummaryMessages 把 source 摘掉
      // ⇒ 两档同源，差别只剩「要不要 source」那一个开关（这就是本单要排查的变量）。
      const rendered = renderSummaryInput(input.messages, true)

      /**
       * 一档的完整尝试：发一次流 → 收 finish → 取正文。**三档共用这一段**
       * ⇒ 档与档之间的差别只可能在传进来的 messages 形状上。
       * 抛出的错一律配上「流里发生了什么」（streamTrace）与「我们发了什么形状」（requestShape）。
       */
      const attempt = async (messages) => {
        const options = {
          provider: target.provider,
          model: target.model,
          messages,
          maxTokens: target.maxTokens,
          sessionId: agent.session.id,
          purpose: 'compaction',
          ...signal === undefined ? {} : { signal },
        }
        const assembler = new BlockAssembler()
        // ★ 2026-09-22 诊断：把流里的 chunk 序列记下来（截断）。真机上这条请求**刚发就废**
        //   （流里只有一条 error finish、零内容块），序列落盘才看得出"零内容块"这件事。
        //   ⛔ 只记 type/index/长度，⛔ 不记正文。
        const seen = []
        for await (const chunk of this.ctx.llm.stream(options)) {
          if (seen.length < 120) {
            seen.push(String(chunk && chunk.type) + '#' + String(chunk && chunk.index)
              + (chunk && chunk.reason ? '/reason=' + String(chunk.reason.kind) : ''))
          }
          assembler.push(chunk)
        }
        /** 给这条错配上两条诊断字符串（⛔ 不含正文）；已有的就不覆盖。 */
        const diagnose = (failure) => {
          try { if (failure && failure.streamTrace === undefined) failure.streamTrace = seen.join(' ') } catch { /* 不影响 */ }
          try { if (failure && failure.requestShape === undefined) failure.requestShape = describeMessages(messages) } catch { /* 不影响 */ }
          return failure
        }
        const finish = readFinish(assembler)
        const failed = finishError(finish)
        if (failed !== undefined) throw diagnose(failed)
        try {
          const rawOutput = assembler.blocks()
          const summary = summaryText(rawOutput)
          if (!summary.some((block) => block.text.trim().length > 0)) {
            throw new Error('summarization produced no text summary content'
              + (typeof finish.unreadable === 'string' ? '（' + finish.unreadable + '）' : ''))
          }
          return {
            summary,
            rawOutput,
            llmStreamCall: true,
            provider: options.provider,
            model: options.model,
            maxTokens: target.maxTokens,
            ...assembler.usage === undefined ? {} : { usage: assembler.usage },
          }
        } catch (failure) {
          throw diagnose(failure)
        }
      }

      // ── 主档：RP 形状（**每条消息都带 source** —— 真机验证过的那条）──
      try {
        const rp = await attempt(buildRpSummaryMessages(rendered, this.instruction, createUserMessage))
        logCompactionNote(this.ctx, 'summarize-rp 成功：RP 形状（每条消息都带 source）直接成了，'
          + '本次摘要用的是 RP 归档指令')
        return rp
      } catch (error) {
        logCompactionFailure(this.ctx, error, 'summarize-rp')
      }

      // ── 兜底：官方形状（super.summarize：input.messages 原样 + 有 tools 就传 + 官方指令）──
      try {
        const official = await super.summarize(input, agent, signal)
        logCompactionNote(this.ctx, 'summarize-official 成功（走兜底）⇒ RP 形状这次没被接受'
          + '（缺 source 又回来了？或上游改了口味）。本次摘要用官方形状，RP 味会淡一点')
        return official
      } catch (error) {
        logCompactionFailure(this.ctx, error, 'summarize-official')
        throw error
      }
    }

  }
} else {
  // 降级占位：能被 loader 安全实例化（构造函数绝不抛），只负责用 ctx.logger 把降级再喊一遍。
  // 它不继承 CompactionEngine ⇒ 不假装自己是压缩服务：会话照常能开，只是这个 preset 没有 RP 压缩。
  RpCompactionEngine = class RpCompactionUnavailable {
    static inject = []

    constructor(ctx) {
      const say = (text) => {
        try {
          if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('[' + TAG + '] ' + text)
        } catch {}
      }
      say('★★★ 降级挂载：拿不到官方包，本 preset 没有 RP 压缩后端（compaction 不生效）。原因：'
        + (degraded !== null ? degraded.reason : 'unknown'))
    }
  }
}

export { RpCompactionEngine }
export default RpCompactionEngine
`
}
