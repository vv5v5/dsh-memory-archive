/**
 * memory-protocol —— `roleplay` preset 的 **记忆检索协议**段（`section()`）。
 *
 * ## 先读这段再改：它和 D13 是一个**有先后**的整体
 * D13 的两半不能拆开做：
 *   ① **每轮注入要关** —— 检索不再每轮自动发生（`anima:memory` 段），改由**模型主动调 `anima_query`**；
 *   ② **关之前必须先有这条条款** —— DSH **没有强制工具调用**（方案 §4 查实），模型会不会去查
 *      **只**取决于它被告知"什么时候该查"。
 * ⛔ 先关注入、条款还是空的 ⇒ 记忆**永远不出场**，而且失效是**静默的**：界面正常、无报错、
 *   只是角色再也不回忆 —— 方案 §8 D13 原话："静默失效，最难发现"。
 * ⇒ **条款为空（本文件默认就是空）时，不许把 anima 的每轮注入关掉。**
 *   为此 `apply()` 在空文本时**每次都写一条显眼的 warn**（见下），让"忘了填"在启动日志里就能看见。
 *
 * ## 文本从哪来（"占位"就是这个意思）
 * 条款**正文（内容层）不写死在本文件里** —— 由 preset 的 `config.text` 提供。
 * 不给 ⇒ 文本为空 ⇒ 本模块**不产出任何文本**（DSH `renderPrompt` 丢掉空段），对现网**零改变**。
 * 用户统一填词时只改 preset 那一处；本文件只负责**机制**：注册成段 / 位置 / 拒变量 / 失败降级。
 *
 * ## 定稿（2026-09-18 用户拍板，已落进真机预设的 `config.text`）
 * ```
 * 此外，当这一轮要承接的事需要历史细节（更早的人、地点、物品、说过的话、约定）而你不确定时，
 * 先调用一次 anima_query 去查找；查到就按记忆用，没查到就照常演，不要在正文里解释检索。
 * 插件不存在时跳过。确保对应角色只呈现自己知道的部分 —— 角色不该知道的，
 * 即使查到了也不许使用。
 * ```
 * ★ 最后那句不是修辞：**检索注入越强，角色越容易变全知**（方案 §4.3 原则 3 专门点名过这个反噬）。
 * ★ 定稿相对首版草稿**删掉了两句**（用户口径）：①「只是当前场景内的事、或纯 OOC / 元讨论 /
 *   聊设定时，不要调用」；②「一轮最多一次」。⇒ 副作用是**模型在 OOC 时也可能去查、且一轮可能查多次**。
 *   真机上如果观察到这种过量调用，把这两句加回来即可（改 preset 那一处，本模块不动）。
 *
 * ## 位置
 * order 取 **1**：紧跟 persona(0) 之后、Tavern profile(10) 之前 —— 与 persona 里那条同类的顶层
 * 行为条款（`state_patch` 那段）读起来是连着的；且不与既有段撞位
 * （`harness:identity` -1000 · persona 0 · profile 10 · rp:policy 45 · state:card 50 · anima 55 · storyAnchor 56 · tail 10201+）。
 *
 * ## 诚实边界
 * · ⛔ **绝不抛**：本模块抛 = 预设挂不上 = 开不了周目。
 * · 含 `{{名字}}` 的文本**拒绝注册**（DSH 会当提示词变量并让整轮失败）—— 与 `rp-identity` 同款处置：
 *   不注册、只告警，宁可少改也不要炸会话。
 * · 服务缺失 / order 认不出 ⇒ 一律降级并写 warn，RP 照常可用。
 *
 * @module memory-protocol
 * @license CC-BY-NC-4.0
 */

/** Cordis 插件名（与预设挂载行的 id 无关，仅用于日志/自述）。 */
export const name = 'memory-protocol'

/** 需要提示词注册表（缺了 cordis 不调 apply ⇒ 天然安全）。 */
export const inject = ['systemPrompt']

/** 段名。前缀 `mt:` 沿用本仓库其它自建段的命名（`mt:postHistory` / `mt:lastFloors`）。 */
export const SECTION_NAME = 'mt:memoryProtocol'

/** 段位置：紧跟 persona 之后（理由见文件头「位置」）。 */
export const MEMORY_PROTOCOL_ORDER = 1

/**
 * 默认文本 = **空**（= 占位未填）。
 * ⛔ 别在这里塞草稿：那会让"没填"看起来像"填了"，把上面那条约定的守门变成摆设。
 */
export const DEFAULT_TEXT = ''

/** DSH 的提示词变量形态（`{{名字}}`）—— 含它会被宿主判 malformed/unknown 并让整轮失败。 */
const PROMPT_VARIABLE = /\{\{[^{}]*\}\}/

/**
 * 拼出最终文本（纯函数，便于自检）：`config.text` 优先；`config.extra` 追加在后面。
 * ⛔ 空就是空 —— 返回 `''` 表示**占位未填**，调用方据此告警/守门。
 * @param {{text?:string, extra?:string}} [config]
 * @returns {string}
 */
export function resolveProtocolText(config = {}) {
  const cfg = config && typeof config === 'object' ? config : {}
  const base = typeof cfg.text === 'string' ? cfg.text.trim() : ''
  const extra = typeof cfg.extra === 'string' ? cfg.extra.trim() : ''
  if (base === '') return extra === '' ? '' : extra
  return extra === '' ? base : base + '\n\n' + extra
}

/** 该 config 是否还是"占位未填"（语义入口，别在别处重写这个判据）。 */
export function isPlaceholder(config = {}) {
  return resolveProtocolText(config) === ''
}

/**
 * 挂载入口：在 preset 作用域注册 `mt:memoryProtocol` 段。
 * @param {object} ctx - preset 作用域内的 cordis 上下文
 * @param {{text?:string, extra?:string, order?:number}} [config]
 * @returns {{registered:boolean, reason?:string, chars?:number, order?:number, placeholder?:boolean}}
 */
export function apply(ctx, config = {}) {
  const info = (m) => { try { ctx?.logger?.info?.(String(m)) } catch {} }
  const warn = (m) => { try { ctx?.logger?.warn?.(String(m)) } catch {} }
  try {
    const prompt = ctx && ctx.systemPrompt
    if (!prompt || typeof prompt.section !== 'function') {
      warn('[memory-protocol] systemPrompt 不可用 ⇒ 不注册记忆检索协议段（RP 照常可用）')
      return { registered: false, reason: 'no-system-prompt' }
    }
    const text = resolveProtocolText(config)
    if (PROMPT_VARIABLE.test(text)) {
      // ⛔ 不清洗也不注册：清洗等于替你改词，注册等于炸会话。如实告警，宁可少改。
      warn('[memory-protocol] 条款里带 `{{…}}` ⇒ 拒绝注册（DSH 会当提示词变量并让整轮失败）')
      return { registered: false, reason: 'prompt-variable-in-text' }
    }
    const order = Number.isFinite(config?.order) ? config.order : MEMORY_PROTOCOL_ORDER
    // ★ 空文本也照常注册：段虽然被 renderPrompt 丢掉（零影响），但位置被占住、
    //   面板上也能看见这一行"空 ⇒ 待填"，比"悄悄不存在"可发现得多。
    ctx.effect(() => prompt.section({ name: SECTION_NAME, order, text }))
    if (text === '') {
      // ★★ 守门：这条 warn 就是 D13 那条约定的可见落点。看到它就说明——
      //   检索协议**缺席**；此时⛔ 不要把 anima 的每轮注入关掉（关了 = 记忆永远不出场）。
      warn('[memory-protocol] 记忆检索协议条款**还是空的（占位未填）** ⇒ 模型不知道该去调 anima_query；'
        + '⛔ 在填上之前不要把 anima 的每轮注入关掉（见方案 §8 D13）')
      return { registered: true, chars: 0, order, placeholder: true }
    }
    info(`[memory-protocol] 已注册记忆检索协议段：${text.length} 字符（order ${order}）`)
    return { registered: true, chars: text.length, order, placeholder: false }
  } catch (e) {
    warn(`[memory-protocol] 注册失败，跳过该段（RP 照常可用）：${e && e.stack ? e.stack : e}`)
    return { registered: false, reason: 'threw' }
  }
}
