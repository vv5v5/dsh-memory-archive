/**
 * rp-identity —— 在 RP 预设作用域里把 **`harness:identity`** 换成我们自己的那句话。
 *
 * ## 为什么要单独一个模块
 * DSH 核心在 `HARNESS_IDENTITY`（order **-1000**）注册了一句固定文本：
 *   `You are an AI agent powered by DeepSeek Harness.`
 * （出处：`packages/core/system-prompt/src/index.ts:419-425`；order 表同文件 `:121-122`）
 * 对 RP 来说这句话把角色往"编程助手/产品外壳"的方向拽。上游**没有**注销别人段的 API，
 * 唯一被官方注释支持的路径是**同作用域同名遮蔽**（同文件 `:440-444`）——
 * 与 `rp-suppress-host-sections.js` 同一个机制，区别只是：那个把文本置空，这个**换成新文本**。
 *
 * ## 诚实边界
 * · 只换**这一句**；DSH 的身份段本身很短（46 字符），其余"你在哪儿/目录/界面纪律"分别在
 *   `harness:source`(10000) / `app:web-surface`(10100) 等段里，与本模块无关（那些由
 *   `rp-suppress-host-sections.js` 负责遮蔽）。
 * · 换掉之后 **`{{model}}` 之类不再出现在这段里**（原句也不含变量）；本模块**拒绝**注册含
 *   `{{名字}}` 的文本 —— 因为 DSH 会把它当提示词变量并**让整轮直接失败**
 *   （只认 `provider`/`model`/`cwd`；见 `neutralizePromptVariables` 里的现场记录）。
 *   遇到这种文本：**不注册、只告警**，让原句留着（宁可少改，不要炸会话）。
 * · ⛔ 绝不抛：本模块抛 = 预设挂不上 = 开不了周目。
 *
 * ## 失败模式
 * 服务缺失 / order 认不出 / 注册抛 ⇒ 一律降级为"保持原样"并写 warn，RP 照常可用。
 *
 * @module rp-identity
 * @license CC-BY-NC-4.0
 */

/** Cordis 插件名（与预设挂载行的 id 无关，仅用于日志/自述）。 */
export const name = 'rp-identity'

/** 需要提示词注册表（缺了 cordis 不调 apply ⇒ 天然安全）。 */
export const inject = ['systemPrompt']

/** 默认新身份句（用户 2026-09-16 定的原文，⛔ 不许改写）。 */
export const DEFAULT_TEXT = 'You are an AI agent made for role-playing games.'

/** DSH 那句原文（只用于日志对照，不参与写入）。 */
const HOST_IDENTITY_TEXT = 'You are an AI agent powered by DeepSeek Harness.'

/** DSH 的提示词变量形态（`{{名字}}`）—— 含它会被宿主判 malformed/unknown 并让整轮失败。 */
const PROMPT_VARIABLE = /\{\{[^{}]*\}\}/

/**
 * 拼出最终文本（纯函数，便于自检）：`config.text` 优先，其次默认句；`config.extra` 追加在后面。
 * @param {{text?:string, extra?:string}} [config]
 * @returns {string}
 */
export function resolveIdentityText(config = {}) {
  const cfg = config && typeof config === 'object' ? config : {}
  const base = typeof cfg.text === 'string' && cfg.text.trim() !== '' ? cfg.text : DEFAULT_TEXT
  const extra = typeof cfg.extra === 'string' && cfg.extra.trim() !== '' ? cfg.extra : ''
  return extra === '' ? base : base + '\n\n' + extra
}

/**
 * 挂载入口：在 preset 作用域注册同名 `harness:identity`（同 order ⇒ 只换内容不换位置）。
 * @param {object} ctx - preset 作用域内的 cordis 上下文
 * @param {{text?:string, extra?:string, orderName?:string}} [config]
 * @returns {{registered:boolean, reason?:string, chars?:number, order?:number}}
 */
export function apply(ctx, config = {}) {
  const info = (m) => { try { ctx?.logger?.info?.(String(m)) } catch {} }
  const warn = (m) => { try { ctx?.logger?.warn?.(String(m)) } catch {} }
  try {
    const prompt = ctx && ctx.systemPrompt
    if (!prompt || typeof prompt.section !== 'function') {
      warn('[rp-identity] systemPrompt 不可用 ⇒ 不改身份句（RP 照常可用）')
      return { registered: false, reason: 'no-system-prompt' }
    }
    const text = resolveIdentityText(config)
    if (PROMPT_VARIABLE.test(text)) {
      // ⛔ 不注册也不"清洗"：清洗等于替你改词，注册等于炸会话。如实告警，让原句留着。
      warn('[rp-identity] 给了带 `{{…}}` 的文本 ⇒ 拒绝注册（DSH 会把它当提示词变量并让整轮失败）；身份句保持原样')
      return { registered: false, reason: 'prompt-variable-in-text' }
    }
    const orderName = typeof config?.orderName === 'string' && config.orderName !== '' ? config.orderName : 'HARNESS_IDENTITY'
    let order = -1000
    try {
      if (typeof prompt.getSectionOrder === 'function') {
        const resolved = prompt.getSectionOrder(orderName)
        if (Number.isFinite(resolved)) order = resolved
      }
    } catch { /* 安置名不认识 ⇒ 用 -1000 兜底，位置不漂 */ }
    ctx.effect(() => prompt.section({ name: 'harness:identity', order, text }))
    info(`[rp-identity] 已把身份句换成我们的 ${text.length} 字符版本（order ${order}；原句「${HOST_IDENTITY_TEXT}」在本作用域内被遮蔽）`)
    return { registered: true, chars: text.length, order }
  } catch (e) {
    warn(`[rp-identity] 改写失败，保留原身份句（RP 照常可用）：${e && e.stack ? e.stack : e}`)
    return { registered: false, reason: 'threw' }
  }
}
