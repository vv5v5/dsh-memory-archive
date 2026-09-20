/**
 * v3-observe-cache —— 「这一轮段表里我们自己的段在不在」这条**观察**的短命缓存。
 *
 * ## 它从哪来（2026-09-19 瘦身）
 * 2026-09-18 那版叫 `v3-sources-cache`，一行三个槽：`sources`（HTTP 来源快照）、`rendered`（PHI 已渲染正文）、
 * `observed`（段表观察）。前两个槽存在的原因只有一个 —— 喂 `mt:postHistory` 那个尾段。
 * 2026-09-19 用户拍板**删掉尾段**（「mt post 那个字段就可以删了」）：位置改由
 * `lib/tavern-field-plan.js` 摆位直接做到 ⇒ 前两个槽连同整套"一步滞后 + TTL"的麻烦一起没了，
 * 只剩下 `observed` 这一个槽：**replace 模式的看守**（`/v3.replaceGuard`）靠它。
 *
 * ## 边界（照旧）
 * · 有界：最多 `maxSessions` 个会话，按最近使用淘汰；
 * · 过期即视为没有（⛔ 不用旧数据假装是新的；时钟倒退也当过期）；
 * · ⛔ 只装"在不在"这种**结构事实**，不装任何正文。
 *
 * @module dsh-memory-archive/v3-observe-cache
 * @license CC-BY-NC-4.0
 */

export const V3_OBSERVE_CACHE_VERSION = 1
/** 默认 TTL：60 秒。每轮装配都会重写这条观察，TTL 只是"没有新装配时"的兜底上限。 */
export const DEFAULT_OBSERVE_TTL_MS = 60000
/** 默认容量：32 个会话。 */
export const DEFAULT_MAX_SESSIONS = 32

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v) => (typeof v === 'string' ? v : '')

/**
 * 建一个观察缓存。
 * @param {{ttlMs?:number, maxSessions?:number, now?:() => number}} [opts]
 * @returns {{setObserved:(sid:unknown, observed:unknown)=>boolean, getObserved:(sid:unknown)=>object|null, drop:(sid:unknown)=>boolean, clear:()=>void, stats:()=>object}}
 */
export function createObserveCache(opts = {}) {
  const ttl = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_OBSERVE_TTL_MS
  const max = Number.isSafeInteger(opts.maxSessions) && opts.maxSessions > 0 ? opts.maxSessions : DEFAULT_MAX_SESSIONS
  const clock = typeof opts.now === 'function' ? opts.now : Date.now
  /** @type {Map<string, {observed:object, at:number}>} 插入序 = LRU 序（命中时重新插入刷新）。 */
  const rows = new Map()

  const key = (sid) => {
    const s = str(sid)
    return s === '' ? null : s
  }
  const evict = () => {
    while (rows.size > max) {
      const oldest = rows.keys().next().value
      if (oldest === undefined) break
      rows.delete(oldest)
    }
  }

  return {
    /** 存一条观察。形状不对（非对象 / 空 id）⇒ 不存（宁可不存，也不存半个）。 */
    setObserved(sessionId, observed) {
      const sid = key(sessionId)
      if (sid === null || !isObj(observed)) return false
      rows.delete(sid)
      rows.set(sid, { observed, at: clock() })
      evict()
      return true
    },

    /** 取一条**未过期**的观察；取不到 / 已过期 / 形状不对 ⇒ null（⛔ 不返回旧数据假装新鲜）。 */
    getObserved(sessionId) {
      const sid = key(sessionId)
      if (sid === null) return null
      const row = rows.get(sid)
      if (row === undefined) return null
      const age = clock() - row.at
      // 时钟倒退（age < 0）也当过期：宁可重判，也不用"来自未来"的时间戳
      if (!(age >= 0) || age > ttl) { rows.delete(sid); return null }
      rows.delete(sid)
      rows.set(sid, row)
      return isObj(row.observed) ? row.observed : null
    },

    /** 主动丢弃一个会话（例如那局的绑定变了）。 */
    drop(sessionId) {
      const sid = key(sessionId)
      return sid === null ? false : rows.delete(sid)
    },

    clear() { rows.clear() },

    /** 诊断用（⛔ 只出计数与年龄，不出内容）。 */
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

export default { createObserveCache, V3_OBSERVE_CACHE_VERSION, DEFAULT_OBSERVE_TTL_MS, DEFAULT_MAX_SESSIONS }
