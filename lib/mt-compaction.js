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
function rpArchiveInstruction(language, faithful) {
  if (language === 'en') {
    return [
      'You are writing a HISTORY ARCHIVE ENTRY for a long roleplay session. This slice of',
      'history is about to leave the model context; it can be retrieved later through memory',
      'search, so it does NOT need prose style or detail — it only needs to be FINDABLE.',
      'Treat the whole slice as ONE continuous passage: write a single entry, do NOT split it',
      'per turn or per message.',
      '',
      'Output exactly this structure, every section present, empty ones as "(none)":',
      '',
      '## Time span',
      '(in-story time, from → to; prefix the entry with the in-story date/time when available)',
      '',
      '## Locations',
      '(which scenes took place; copy place names exactly)',
      '',
      '## Characters',
      '(each: name + what they did in this slice; state actions and facts only)',
      '',
      '## Key events',
      '(3-8 bullets, one line each; keep exact numbers, item names, place names, proper nouns verbatim)',
      '',
      '## Open threads',
      '(0-3 bullets; "(none)" if empty)',
      '',
      '## Tags',
      '(as the LAST line, output exactly this shape, filling the values per the rules below:',
      '  tags: {"vibe":"…","special":[…],"important":false} )',
      '',
      'Rules:',
      faithful
        ? '- Keep proper nouns, numbers, and item names from the source verbatim; do not rewrite them.'
        : '- Keep proper nouns, numbers, and item names recognizable; light paraphrase elsewhere is allowed.',
      '- Show, do not tell: record who did what and what happened; no atmosphere adjectives,',
      '  no emotion summaries, no evaluation. A reader must be able to RE-FIND the facts.',
      '- Do not write prose description, do not replay dialogue, do not evaluate.',
      '- Never mention "compaction", "summary", or "context".',
      '- Output only the structure itself, with no preamble or trailing remarks.',
      '- vibe: pick exactly ONE dominant mood, copied verbatim (case included) from:',
      '  Daily / Wholesome / Comedy / Conflict / Action / Angst / Suspense / Romantic / Sexual / Serious',
      '- special: an array of extra tag strings, may be empty [].',
      '- important: boolean, default false. Set true ONLY for IRREVERSIBLE world-state changes:',
      '  death, breakup/marriage, firsts (kiss/date/confession), permanent separation; a major',
      '  secret revealed, a key item/location unlocked, an irreversible shift of allegiance.',
      '  Intense but reversible emotional conflict does NOT count.',
    ].join('\\n')
  }
  return [
    '你在为一个中文角色扮演长会话生成「历史归档条目」。这段历史会被移出模型上下文，',
    '之后可通过记忆检索取回，所以**不需要保留文风与细节，只需要让未来的检索能找回它**。',
    '把这一段区间当作**一个连续片段**来写：只产出一条条目，⛔ 不要再按回合/楼层切成多条。',
    '',
    '输出严格用下面的结构，每节都要有，空的写 "(无)"：',
    '',
    '## 时间跨度',
    '（故事内时间，起 → 止；拿得到时给条目加故事内日期/时刻前缀，如"第3天 深夜"）',
    '',
    '## 地点',
    '（发生过哪些场景；地名照原文写）',
    '',
    '## 涉及角色',
    '（每个角色：名字 + 这段里他/她做了什么；只陈述动作与事实）',
    '',
    '## 关键事件',
    '（3–8 条，每条一行；保留**具体数值/物品名/地名/专有名词**，不要改写）',
    '',
    '## 未回收的伏笔',
    '（0–3 条；没有就写 (无)）',
    '',
    '## 标签',
    '（最后一行输出 tags，格式逐字如下，值按下面规则填：',
    '  tags: {"vibe":"…","special":[…],"important":false} ）',
    '',
    '规则：',
    faithful
      ? '- 用**中文**写。保留原文里的专有名词、数字、物品名，逐字照抄，不要"整理"。'
      : '- 用中文写。专有名词、数字、物品名保持原样，其余内容可轻度转写。',
    '- 只写"谁做了什么、发生了什么"，不写氛围渲染、不写情绪形容、不做评价 ——',
    '  让未来的检索能从条目里找回事实本身，而不是被告知气氛如何。',
    '- 不要写文风描写、不要复述对话。',
    '- 不要提到"压缩""摘要""上下文"这些词。',
    '- 只输出这个结构本身，不要任何前后语。',
    '- vibe：从下面 10 个里选**一个**主导基调，逐字照抄（含大小写）：',
    '  Daily / Wholesome / Comedy / Conflict / Action / Angst / Suspense / Romantic / Sexual / Serious',
    '- special：补充标签字符串数组，可为空 []；没有合适的就不填。',
    '- important：布尔，**默认 false**；只有**不可逆**的世界状态变更才填 true ——',
    '  死亡、分手/结婚、各种"初次"（初吻/初次约会/告白）、永久分离；重大秘密被揭露、',
    '  关键物品/地点解锁、不可逆的立场/阵营转变。激烈但可逆的情绪冲突**不**算。',
  ].join('\\n')
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
     * 用 RP 归档指令摘要被压区（形状与官方 summarizeWithLlm 逐行一致：会话自己的
     * system / tools / 消息放前面保住 KV cache 前缀，我们的指令作为最后一条 user 消息）。
     * @param {object} input - 被压的重放会话前缀 { system?, tools?, messages }。
     * @param {object} agent - 提供路由模型历史、回退模型与会话 id。
     * @param {AbortSignal} [signal] - 取消信号，透传给适配器。
     */
    async summarize(input, agent, signal) {
      const target = this.#summarizeTarget(agent)
      const messages = [
        ...input.messages,
        createUserMessage({
          content: [{ type: 'text', text: this.instruction }],
          source: { kind: 'plugin', plugin: TAG },
        }),
      ]
      const options = {
        provider: target.provider,
        model: target.model,
        messages,
        ...input.system === undefined ? {} : { system: input.system },
        ...input.tools === undefined ? {} : { tools: [...input.tools] },
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

    /**
     * 这次辅助调用该打给谁、用多大的输出预算（照官方语义两层：策略按会话自己的路由目标取；
     * 调用目标 = configured(显式摘要模型) ?? 最近一次请求的路由 ?? agent 选项）。
     */
    #summarizeTarget(agent) {
      const routed = agent.session.requestHeader()?.config
      const agentTarget = typeof agent.options?.provider === 'string' && agent.options.provider.length > 0
        && typeof agent.options?.model === 'string' && agent.options.model.length > 0
        ? { provider: agent.options.provider, model: agent.options.model }
        : undefined
      const route = routed !== undefined && routed.provider.length > 0 && routed.model.length > 0
        ? { provider: routed.provider, model: routed.model }
        : agentTarget

      const resolved = this.config
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
