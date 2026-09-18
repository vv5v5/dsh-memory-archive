/**
 * v3 来源快照的**带外缓存** —— 让 `mt:postHistory` 在 trace 合同下还能拿到卡字段。
 *
 * ## 为什么需要它（2026-09-17）
 * `mt:postHistory`（order 10203）的段文本取卡里的 `postHistoryInstructions`。它一直走
 * Tavern 的**同步** Cordis 服务 `pmpDshTavernPrompt.getSources(sessionId)`。
 * 而 trace 合同（`codex/trace-api-v3`）**不再提供那个服务** —— 它只给 HTTP。
 *
 * ⛔ 段 provider 必须**同步**（官方硬要求，`system-prompt` 在装配时逐个调它，不能 await、不能联网）。
 * ⇒ 只能**在装配之前**异步把来源取好放进缓存，段函数再同步读。
 *
 * ## 时序（踩过的坑，别改）
 * 填充时机是 `agent/inbox/spliced` —— 人类消息进收件箱，**在本轮装配之前**。
 * ⛔ **不要**挪到 `system-prompt/assemble` 瀑布里去填：那时段的文本**早已结算完**
 *   （`system-prompt/src/index.ts:595-620` 先渲染所有段、再跑瀑布），填了也只会**慢一轮**生效。
 *   这个坑 `lib/v3-tail.js` 的文件头已经记过一次（第一版设计实测永远是空段）。
 *
 * ## 边界
 * · 本模块**纯逻辑**（不发请求）—— HTTP 由调用方做，取回来喂 `set()`；
 * · ⛔ 存的是 Tavern 原样的 `sources` 对象，**不做投影、不落盘**（只在内存里活一个 TTL）；
 * · 有界：最多 `maxSessions` 个会话，按最近使用淘汰（⛔ 不无界增长）；
 * · 过期即视为没有（⛔ 不用旧数据假装是新的）。
 *
 * @module dsh-memory-archive/v3-sources-cache
 * @license CC-BY-NC-4.0
 */

export const V3_SOURCES_CACHE_VERSION = 1
/** 默认 TTL：60 秒。每轮 `agent/inbox/spliced` 都会重取，TTL 只是"没有新事件时"的兜底上限。 */
export const DEFAULT_TTL_MS = 60000
/** 默认容量：32 个会话。 */
export const DEFAULT_MAX_SESSIONS = 32

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v) => (typeof v === 'string' ? v : '')

/**
 * 建一个来源快照缓存。
 * @param {{ttlMs?:number, maxSessions?:number, now?:() => number}} [opts]
 * @returns {{set:(sid:unknown, sources:unknown) => boolean, get:(sid:unknown) => object|null, drop:(sid:unknown) => boolean, clear:() => void, stats:() => object}}
 */
export function createSourcesCache(opts = {}) {
  const ttl = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS
  const max = Number.isSafeInteger(opts.maxSessions) && opts.maxSessions > 0 ? opts.maxSessions : DEFAULT_MAX_SESSIONS
  const clock = typeof opts.now === 'function' ? opts.now : Date.now
  /**
   * @type {Map<string, {sources:object|null, rendered:string|null, at:number}>}
   * 插入序 = LRU 序（命中时重新插入以刷新）。
   * ★ 一行两个槽：`sources`（composer 合同那套来源快照）与 `rendered`（trace 合同下从官方
   *   `:part:` 段里摘到的**已渲染**正文）。⛔ 共用同一行/TTL/LRU —— 不做第二套生命周期。
   */
  const rows = new Map()

  const key = (sid) => {
    const s = str(sid)
    return s === '' ? null : s
  }

  return {
    /**
     * 存入一份来源快照。⛔ 形状不对**不存**（宁可不存，也不存半个）。
     * @returns {boolean} 是否真的存了
     */
    set(sessionId, sources) {
      const sid = key(sessionId)
      if (sid === null || !isObj(sources)) return false
      // 命中已存在的键时先删再插 ⇒ Map 的插入序即"最近使用序"；另一槽原样保留
      const prev = rows.get(sid)
      rows.delete(sid)
      rows.set(sid, { sources, rendered: prev?.rendered ?? null, at: clock() })
      while (rows.size > max) {
        const oldest = rows.keys().next().value
        if (oldest === undefined) break
        rows.delete(oldest)
      }
      return true
    },

    /**
     * 存一段**已渲染**的卡字段正文（trace 合同下没有 `/sources` 时的替代来源：
     * 从官方 `:part:…:character:postHistoryInstructions` 段里摘下来的那一份）。
     * 与 `set` 共用同一行/TTL/LRU；空串不存（宁可不存，也不存半个）。
     * @returns {boolean} 是否真的存了
     */
    setRendered(sessionId, text) {
      const sid = key(sessionId)
      const t = str(text)
      if (sid === null || t.trim() === '') return false
      const prev = rows.get(sid)
      rows.delete(sid)
      rows.set(sid, { sources: prev?.sources ?? null, rendered: t, at: clock() })
      while (rows.size > max) {
        const oldest = rows.keys().next().value
        if (oldest === undefined) break
        rows.delete(oldest)
      }
      return true
    },

    /**
     * 取一份**未过期**的快照。取不到 / 已过期 / 形状不对 ⇒ `null`（⛔ 不返回旧数据假装新鲜）。
     * 命中会刷新 LRU 位置。
     * ⚠️ 形状不对时**只返回 null，不删行** —— 这一行可能只装了 `rendered`（那正是 trace 合同下的正常态），
     *    删掉它会让紧随其后的 `getRendered` 也取不到（修 `/sources` 删除的那条路就白修了）。
     */
    get(sessionId) {
      const sid = key(sessionId)
      if (sid === null) return null
      const row = rows.get(sid)
      if (row === undefined) return null
      const age = clock() - row.at
      // 时钟倒退（age < 0）也当过期：宁可重取，不用"来自未来"的时间戳
      if (!(age >= 0) || age > ttl) { rows.delete(sid); return null }
      rows.delete(sid)
      rows.set(sid, row)
      return isObj(row.sources) ? row.sources : null
    },

    /**
     * 取那段**已渲染**正文（未过期、非空才给）。⛔ 与 `get` 同理：不因为另一个槽空就删行。
     * @returns {string|null}
     */
    getRendered(sessionId) {
      const sid = key(sessionId)
      if (sid === null) return null
      const row = rows.get(sid)
      if (row === undefined) return null
      const age = clock() - row.at
      if (!(age >= 0) || age > ttl) { rows.delete(sid); return null }
      rows.delete(sid)
      rows.set(sid, row)
      const t = str(row.rendered)
      return t.trim() === '' ? null : t
    },

    /** 主动丢弃一个会话（例如那局的绑定变了）。 */
    drop(sessionId) {
      const sid = key(sessionId)
      return sid === null ? false : rows.delete(sid)
    },

    clear() { rows.clear() },

    /** 诊断用（⛔ 只出计数与年龄，不出正文）。 */
    stats() {
      const at = clock()
      return {
        size: rows.size,
        maxSessions: max,
        ttlMs: ttl,
        entries: [...rows.entries()].map(([sid, row]) => ({ session: sid.slice(-6), ageMs: at - row.at })),
      }
    },
  }
}

export default { createSourcesCache, V3_SOURCES_CACHE_VERSION, DEFAULT_TTL_MS, DEFAULT_MAX_SESSIONS }
