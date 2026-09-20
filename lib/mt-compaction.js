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
// 生成器纪律（与 lib/rp-agent.js 的 buildInjectModule 同款）：
//   · 返回【源码文本】而不是模块对象 —— 文本随预设目录落盘、以 ./ 相对路径被 preset 引用；
//   · 产物自包含：只许 node:* 内置模块 + 运行时解析到的官方包，⛔ 不许 import 本插件 lib；
//   · 产物确定性：同一次调用永远逐字节相同（无时间戳/随机数）；
//   · 产物 import 期绝不抛异常：解析不到官方包 ⇒ 降级（大声日志 + degraded 导出 +
//     占位类），绝不因本文件让 preset 挂不上。
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
// 它是什么：官方 @deepseek-ai/dsh-compaction-basic 的【子类】，只覆盖 summarize() 这一个钩子
// —— 官方源码 compaction-basic/src/index.ts:231 的原话：*"Override this sole hook for a
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

import { createRequire } from 'node:module'
import { join } from 'node:path'

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
 * @param {Array} messages - 宿主的重放前缀（input.messages）。
 * @returns {{messages: Array, previous: string}} 过滤后的最小消息数组 + 上一份摘要。
 */
export function renderSummaryInput(messages) {
  const kept = []
  let previous = ''
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message && message.role
    if (role !== 'user' && role !== 'assistant') continue
    const text = textOf(message)
    if (text === '') continue
    if (role === 'assistant') {
      kept.push({ role: 'assistant', content: [{ type: 'text', text }] })
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
    kept.push({ role: 'user', content: [{ type: 'text', text }] })
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

if (basicLoad.ok && llmLoad.ok) {
  const BasicCompactionEngine = basicLoad.mod.default ?? basicLoad.mod.BasicCompactionEngine
  const { BlockAssembler, LlmError, contentHasImage, createUserMessage } = llmLoad.mod

  /** 把终态的摘要 finish 映射成 fail-closed 的错误（逐行对应官方 finishError）。 */
  function finishError(finish) {
    switch (finish.kind) {
      case 'error':
      case 'aborted': {
        const error = new Error(finish.failure.message)
        error.code = finish.failure.code
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
    }

    /**
     * 用 RP 归档指令摘要被压区。
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
     */
    async summarize(input, agent, signal) {
      const target = summarizeTarget(this, agent)
      const rendered = renderSummaryInput(input.messages)
      const messages = [
        ...rendered.previous === ''
          ? []
          : [createUserMessage({ content: [{ type: 'text', text: wrapped('previous_summary', rendered.previous) }] })],
        createUserMessage({ content: [{ type: 'text', text: SUMMARY_TARGET_OPEN }] }),
        ...rendered.messages,
        createUserMessage({ content: [{ type: 'text', text: SUMMARY_TARGET_CLOSE }] }),
        createUserMessage({
          content: [{ type: 'text', text: this.instruction }],
          source: { kind: 'plugin', plugin: TAG },
        }),
      ]
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
      for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk)
      const error = finishError(assembler.finish)
      if (error !== undefined) throw error

      const rawOutput = assembler.blocks()
      const summary = summaryText(rawOutput)
      if (!summary.some((block) => block.text.trim().length > 0)) {
        throw new Error('summarization produced no text summary content')
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
