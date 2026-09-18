/**
 * v3 尾部段（`mt:postHistory`）—— 把**卡的后处理指令**排到提示词的**最后**。
 *
 * ## 为什么需要它
 * v3 外部组合器产出的段会被 Tavern 统一放在 **profile 槽位（order 10）**，
 * 所以"后处理指令放最后"最多只能做到"在我们那一块里最后"。要真排到全文末尾，
 * 必须由**宿主平面**自己注册一段，order 取在已知所有段之后：
 *   `deployment:persona-suffix` = **10200**（DSH 核心，`system-prompt/src/index.ts:434`）
 *   `rp:firstRound`             = **10201**（我们自己的"保留第一轮"）
 *   `mt:lastFloors`             = **10202**（我们自己的"最近几楼"，2026-09-17 起占位 ——
 *                                 用户口径：它必须是**倒数第二**，紧随本段之前）
 *   ⇒ 本段用 **10203**（可配）。⚠️ "绝对最后"无法保证：将来有插件注册更高 order 会插到我们后面。
 *
 * ## 每轮怎么拿到"这一刻是哪一局"的卡
 * 段文本写成**函数**：`PromptSection.text: string | ((context) => string)`（`system-prompt/src/index.ts:66`），
 * DSH 在 `assemble()` 里**逐个段调用它、把 context 原样递进来**（同文件 `:599`）。
 * 所以"这一刻是哪一局"就在**段函数自己的入参**上：`context.agent.session.id`
 * （类型上 `AssembleContext` 只声明 `{scope, signal}`（`:42-50`），但真机它带着 agent —— 我们的
 * `dma:echo` 早就在用同一个字段，见 `lib/index.js` 的 `registerEcho`）。
 * 取卡字段走 Tavern 的**同步**服务 `pmpDshTavernPrompt.getSources(sessionId)`。
 *
 * ⛔ **千万别改回"在装配瀑布里刷新缓存"** —— 这是我第一版的设计，真机实测**永远是空段**：
 *    `:595-603` 先把每个段的 text 全部结算掉、`:604-616` 组成 assembly，
 *    **然后**才在 `:617-620` `await this.ctx.waterfall('system-prompt/assemble', assembly, context, …)`。
 *    也就是说瀑布拿到的已经是**渲染完的成品**（`:25` 明说 listeners "cannot add to or replace"），
 *    在瀑布里写缓存时，本轮文本早就取完了 —— 只会**慢一轮**生效。沙箱端到端证据：
 *    段注册在 10202、组合器也确实让出了 post-history，但捕获与本轮请求里该段 chars=0。
 * 同理**不要**缓存文本：`context` 每次装配都新鲜，直接算最准（一次 `getSources` 的代价，
 * 与组合器自己那次同量级）。
 *
 * ## 纪律（照抄本插件的既有做法）
 * · ⛔ **永不抛**：任何一步失败都只是"这一段为空"，绝不拖垮装配或宿主启动。
 * · 段 provider **同步**（官方要求）：不 await、不联网。
 * · **不串场**：不是"有卡绑定的那一局" ⇒ 文本置空（DSH 只拼非空段，它就不出现）。
 * · **不重复**：启用本段时必须让 v3 组合器**不再产出** post-history
 *   （由调用方传 `omitFields:['postHistoryInstructions']`），否则同一条会进两次。
 * · 文本必须过 `neutralizePromptVariables`：卡里带 `{{user}}`/`{{char}}` 时，
 *   DSH 会把 `{{名字}}` 当提示词变量并**让整轮直接失败**（现场记录见 v3-composer.js）。
 *
 * @module dsh-memory-archive/v3-tail
 * @license CC-BY-NC-4.0
 */

import { neutralizePromptVariables } from './v3-composer.js'

/** 默认段名（最终段名就是它；须唯一，且不与别人的段撞名）。 */
export const DEFAULT_TAIL_NAME = 'mt:postHistory'
/** 默认 order：> persona-suffix(10200)、rp:firstRound(10201) 与 mt:lastFloors(10202)。 */
export const DEFAULT_TAIL_ORDER = 10203
/** 包裹标签（与组合器同一套观感，便于在看请求原文时一眼认出）。 */
const TAG = 'st-character-field'
/** ⚠️ 两个名字不一样，别混：卡里那个键是**驼峰** `postHistoryInstructions`；
 *  标签属性值用连字符 `post-history-instructions`（与组合器一致）。我第一版就是把标签名当键查，
 *  结果永远是空 —— 自检当场抓住了。 */
const DATA_KEY = 'postHistoryInstructions'
const LABEL = 'post-history-instructions'

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v) => (typeof v === 'string' ? v : '')

/**
 * 纯函数：把 v3 `sources` 里的卡后处理指令取出来并做成段文本。
 * @param {object} sources - `getSources()` 的返回值
 * @param {{tag?:string, dataKey?:string, label?:string}} [opts]
 * @returns {{text:string, reason:string, chars:number}} reason ∈ ok|no-sources|no-card|prefer-off|empty
 */
export function tailTextFromSources(sources, opts = {}) {
  const o = isObj(opts) ? opts : {}
  const s = isObj(sources) ? sources : null
  if (s === null) return { text: '', reason: 'no-sources', chars: 0 }
  const sel = isObj(s.selection) ? s.selection : {}
  const selChar = isObj(sel.character) ? sel.character : {}
  const docs = isObj(s.documents) ? s.documents : {}
  const card = isObj(docs.character) ? docs.character : null
  if (card === null) return { text: '', reason: 'no-card', chars: 0 }
  // 与组合器同一口径：用户把"用卡的后处理"关掉时不注入（⛔ 别自作主张）
  if (selChar.preferCharacterPostHistory === false) return { text: '', reason: 'prefer-off', chars: 0 }
  const data = isObj(card.data) ? card.data : {}
  const raw = str(data[o.dataKey || DATA_KEY])
  if (raw.trim() === '') return { text: '', reason: 'empty', chars: 0 }
  // 宏/变量处理：`{{char}}`/`{{user}}` 用卡与用户名展开，解不了的中和（⛔ 不能原样透传）
  const user = isObj(docs.user) ? docs.user : null
  const userData = user && isObj(user.data) ? user.data : {}
  const fixed = neutralizePromptVariables(raw, { character: str(data.name), user: str(userData.name) })
  const tag = o.tag || TAG
  const text = '<' + tag + ' name="' + (o.label || LABEL) + '">\n' + fixed.text + '\n</' + tag + '>'
  return { text, reason: 'ok', chars: fixed.text.length, macros: { expanded: fixed.expanded, neutralized: fixed.neutralized } }
}

/**
 * 把**已经渲染好的**正文包成尾部段 —— **与 `tailTextFromSources` 同一个壳**（同一个 tag/label、
 * 同样的换行、同样过一遍变量中和）。
 *
 * ★ 为什么需要第二条入口（2026-09-18，沙箱 A/B 实测）：
 *   上游在 `b0b0b7b` 里**删掉了** `GET /sessions/:id/sources`（404、无别名、无重定向），
 *   而 trace 合同下我们原本靠"带外抓那个端点"才拿到卡的后处理指令 ⇒ **这条卡字段整条从请求里消失**
 *   （实测：`d195134` 上 1 次 → `0408457` 上 0 次）。Tavern 产的那份被我们的摘除器摘掉，
 *   我们这份又没正文 ⇒ 两头都没了。
 *   而那段正文**并没有丢**：它就在我们**本来就要摘掉**的那一段里（`assembly.sections[].text`，
 *   装配期已渲染）⇒ 由摘除器把它交过来即可。⛔ 不新增上游依赖、不复制 v1 的资源读取合同。
 *
 * ⚠️ 与 `tailTextFromSources` 的唯一差别：进来的文本**已经由 Tavern 渲染过**（宏已展开），
 *   所以这里只做"残留变量中和"（`{{char}}`/`{{user}}` 无值 ⇒ 留空；未知变量按既有口径处理），
 *   ⛔ **不**自己再展开一遍宏。
 */
export function tailTextFromRendered(rawText, opts = {}) {
  const o = isObj(opts) ? opts : {}
  const raw = str(rawText)
  if (raw.trim() === '') return { text: '', reason: 'empty-rendered', chars: 0 }
  const fixed = neutralizePromptVariables(raw, { character: '', user: '' })
  const tag = o.tag || TAG
  const text = '<' + tag + ' name="' + (o.label || LABEL) + '">\n' + fixed.text + '\n</' + tag + '>'
  return { text, reason: 'ok', chars: fixed.text.length, macros: { expanded: fixed.expanded, neutralized: fixed.neutralized } }
}

/**
 * 接线：注册尾部段 + 装配前刷新它的文本。
 * @param {object} ctx - 宿主平面 cordis 上下文（必须有 ctx.plugin）
 * @param {{enabled?:boolean, name?:string, order?:number}} [config]
 * @param {{info?:Function,warn?:Function,error?:Function}} [log]
 * @param {{readSources?:(sessionId:string) => object|null}} [deps] - **带外来源**读取器（同步）。
 *   trace 合同不再提供 Cordis 服务 `pmpDshTavernPrompt`，而段 provider 必须同步 ⇒ 由调用方
 *   在本轮装配之前把来源取好放进缓存，这里同步读（见 `lib/v3-sources-cache.js`）。⛔ 本模块自己不联网。
 * @param {{readRenderedPhi?:(sessionId:string) => string|null}} [deps] - **第二来源**（同步）：
 *   trace 合同下 `/sources` 被上游删掉之后的替代 —— 摘除器把官方 PHI `:part:` 段的**已渲染正文**
 *   存进同一个缓存，这里同步读（见 `v3-contract.phiSectionText` 与 `tailTextFromRendered`）。
 * @returns {{registered:boolean, reason?:string, status:Function, name?:string, order?:number}}
 */
export function registerV3Tail(ctx, config = {}, log, deps = {}) {
  const cfg = isObj(config) ? config : {}
  /** 带外来源读取器（同步、永不抛；取不到 ⇒ null）。 */
  const readSources = typeof deps?.readSources === 'function' ? deps.readSources : null
  /** 第二来源读取器（trace 合同：从官方 `:part:` 段摘下来的已渲染正文）。 */
  const readRenderedPhi = typeof deps?.readRenderedPhi === 'function' ? deps.readRenderedPhi : null
  const info = (m) => { try { log?.info?.(String(m)) } catch {} }
  const warn = (m) => { try { log?.warn?.(String(m)) } catch {} }
  if (cfg.enabled !== true) return { registered: false, reason: 'disabled', status: () => ({ enabled: false }) }
  if (!ctx || typeof ctx.plugin !== 'function') {
    warn('[mt] ctx.plugin 不可用 ⇒ 尾部段未接线（后处理仍留在组合器那一块里）')
    return { registered: false, reason: 'no-ctx-plugin', status: () => ({ enabled: false }) }
  }
  const name = str(cfg.name) || DEFAULT_TAIL_NAME
  const order = Number.isFinite(cfg.order) ? Number(cfg.order) : DEFAULT_TAIL_ORDER
  /** 只用于 /v3 的**诊断投影**（"最近一次装配取到了什么、为什么"）——⛔ 不是文本的真相源。 */
  const holder = { reason: 'init', chars: 0, at: 0, sid: null, origin: null }

  /**
   * 段文本的**唯一**来源：DSH 装配时按段调用它（`system-prompt/src/index.ts:599`）。
   * 同步、永不抛；任何失败都返回空串（DSH 只拼非空段 ⇒ 这一段就不出现）。
   * @param {object} assembleContext - 本轮装配上下文（真机上带 `agent.session.id`）
   * @returns {string}
   */
  const computeTail = (assembleContext) => {
    const stamp = (reason, sid, chars, origin) => {
      holder.reason = reason
      holder.chars = chars
      holder.at = Date.now()
      holder.origin = origin ?? null
      if (typeof sid === 'string' && sid !== '') holder.sid = sid
    }
    try {
      const sid = assembleContext?.agent?.session?.id ?? null
      if (typeof sid !== 'string' || sid === '') { stamp('no-session', null, 0, null); return '' }
      // ★ 三级取数（2026-09-17，上游换合同之后）：
      //   ① **composer 合同**：进程内同步服务 `pmpDshTavernPrompt.getSources()` —— 最准、零延迟；
      //   ② **trace 合同**：上游**不再提供那个服务** ⇒ 读**带外缓存**（由调用方在本轮装配之前用 HTTP 填好，
      //      见 lib/v3-sources-cache.js）。段 provider 不能 await/联网，所以只能这样；
      //   ③ 两条都没有 ⇒ 空段 + 如实的原因（⛔ 不猜、不吐半个段、不用过期数据假装新鲜）。
      // 每一步都把 `origin` 记进诊断投影 —— 面板要能回答"这一轮到底从哪拿的"。
      const fromService = (() => {
        const service = typeof ctx.get === 'function' ? ctx.get('pmpDshTavernPrompt') : null
        if (!service || typeof service.getSources !== 'function') return { ok: false, reason: 'no-tavern-service' }
        try { return { ok: true, sources: service.getSources(sid) } }
        catch (e) { return { ok: false, reason: 'sources-threw:' + String((e && e.message) || e) } }
      })()
      let sources = null
      let rendered = null
      let origin = null
      if (fromService.ok) {
        sources = fromService.sources
        origin = 'cordis-service'
      } else {
        const cached = (() => { try { return readSources === null ? null : readSources(sid) } catch { return null } })()
        // ⛔ 必须排除数组：`typeof [] === 'object'` —— 放进去会让 `tailTextFromSources` 判成 no-card，
        //   段虽然为空，但 origin 会被记成 'out-of-band-cache'（谎报"拿到了"）。自检台 K4e 抓到的。
        if (cached !== null && typeof cached === 'object' && !Array.isArray(cached)) { sources = cached; origin = 'out-of-band-cache' }
        else {
          // ★ ②b（2026-09-18）：trace 合同下 `/sources` 被上游删了 ⇒ 退到第二来源 ——
          //   摘除器在装配下游把官方 PHI `:part:` 段的**已渲染正文**交进了同一个缓存。
          //   ⛔ 与 ② 一样：拿不到就**不猜**，如实记原因（不吐半个段、不用旧数据假装新鲜）。
          const part = (() => { try { return readRenderedPhi === null ? null : readRenderedPhi(sid) } catch { return null } })()
          if (typeof part === 'string' && part.trim() !== '') { rendered = part; origin = 'part-section' }
        }
      }
      if (rendered === null && sources === null) { stamp(fromService.reason, sid, 0, null); return '' }
      const r = rendered !== null
        ? tailTextFromRendered(rendered, { tag: TAG, label: LABEL })
        : tailTextFromSources(sources, { tag: TAG, dataKey: DATA_KEY, label: LABEL })
      if (r.text === '') { stamp(r.reason, sid, 0, origin); return '' }
      const changed = holder.chars !== r.chars || holder.sid !== sid || holder.origin !== origin
      stamp(r.reason, sid, r.chars, origin)
      if (changed) info(`[mt] 尾部段已产出：会话 …${sid.slice(-6)} · ${r.chars} 字符 · order ${order} · 来源 ${origin}`)
      return r.text
    } catch (e) {
      stamp('threw:' + String((e && e.message) || e), null, 0, null)
      return ''
    }
  }

  try {
    ctx.plugin({
      name: 'dsh-memory-archive:v3-tail',
      inject: ['systemPrompt'],
      apply(scope) {
        // 段文本 = 函数。DSH 每次装配都会调它并把 context 递进来 ⇒ **就在那一刻**按会话取卡字段。
        // ⛔ 不要挪到 'system-prompt/assemble' 瀑布里去算：那时段文本早已结算完（见文件头）。
        scope.effect(() => scope.systemPrompt.section({ name, order, text: computeTail }))
      },
    })
  } catch (e) {
    warn(`[mt] 尾部段接线失败（已降级，后处理仍留在组合器那一块）：${String((e && e.message) || e)}`)
    return { registered: false, reason: 'plugin-failed', status: () => ({ enabled: false }) }
  }

  info(`[mt] 尾部段已接线：name=${name} order=${order}（后处理指令排到全文最后；v3 组合器那边须同时 omitFields:['postHistoryInstructions']）`)
  return {
    registered: true,
    name,
    order,
    status: () => ({
      enabled: true, name, order, chars: holder.chars, reason: holder.reason, at: holder.at,
      // 这一轮**从哪拿的**：'cordis-service' | 'out-of-band-cache' | null（两条都没有）
      source: holder.origin,
      sessionTail: holder.sid ? holder.sid.slice(-6) : null,
    }),
  }
}
