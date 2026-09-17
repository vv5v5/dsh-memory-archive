/**
 * 在**最终系统正文**里按段序定位每一段 —— 算出可信的 `offset`。
 *
 * ## 为什么不能在装配瀑布里算（2026-09-17 真机查死）
 * §9 的"点开看正文"要求：`renderedChars/renderedHash` 与**最终**系统消息逐字节相等，
 * 且每段的 `offset/chars` 能从那一段里切出该段。而装配瀑布里算不出这个：
 *
 * · **anima**（`dsh-anima-rag/lib/index.js:1029`）是 **`next()` 之后才改写** —— 它的产出只沿
 *   瀑布**返回值**往上传，所以**排在它下游**的监听器拿不到（`deferred-install.js` 当初就是为此）；
 *   2026-09-17 判据实验后，捕获改成"站最外层 + 读返回值"**拿得到**这一版（见 sections-capture.js）；
 * · **但 DSH 还会在瀑布返回之后做 `complete` 段覆盖**（`core/system-prompt/src/index.ts:621-626`）
 *   —— 这一步任何监听器都看不到 ⇒ 瀑布返回值未必等于**最终**系统正文；
 * · 实测：捕获在装配期算出的整段凭据 = 8931/10100，而日志里最终系统消息 = 10997/12074。
 *
 * ⇒ 真位置只能等 DSH 把**最终正文**写进会话日志（`system/message` 事件）之后再定。
 *
 * ## 定位口径（顺序匹配，⛔ 不猜）
 * 从游标处**向后**找该段正文；找到 ⇒ 记下真实 offset 并把游标推到该段末尾；找不到 ⇒
 * 这一段 `offset=null`（如实缺，⛔ 不编 0、不拿上次的位置顶）。
 * **空段跳过且不占位**（宿主也不会给 0 字段 offset）。
 *
 * 为什么顺序匹配是对的：即使中间有**我们拿不到正文的段**（anima 那种），它也只占一段区间；
 * 我们从**上一个命中点之后**继续找，所以**命中段的 offset 依然正确**，不会被中间的空白带偏。
 *
 * @module dsh-memory-archive/final-text-locate
 * @license CC-BY-NC-4.0
 */

export const FINAL_TEXT_LOCATE_VERSION = 1

/**
 * @param {Array<{name?:string, text?:string}>} sections - 段表（顺序即正文顺序）；`text` 是**插值后**正文
 * @param {string} finalText - 最终系统正文
 * @returns {{ok:boolean, reason:string, offsets:Array<{offset:number|null, chars:number|null}>,
 *            matched:number, total:number, renderedChars:number|null}}
 */
export function locateSections(sections, finalText) {
  const list = Array.isArray(sections) ? sections : []
  const text = typeof finalText === 'string' ? finalText : ''
  const offsets = list.map(() => ({ offset: null, chars: null }))
  if (text === '') {
    return { ok: false, reason: 'no-final-text', offsets, matched: 0, total: 0, renderedChars: null }
  }
  let cursor = 0
  let matched = 0
  let total = 0
  for (let i = 0; i < list.length; i += 1) {
    const t = typeof list[i]?.text === 'string' ? list[i].text : ''
    if (t === '') continue // 空段不占位
    total += 1
    const at = text.indexOf(t, cursor)
    if (at < 0) continue // 找不到 ⇒ 如实 null
    offsets[i] = { offset: at, chars: t.length }
    cursor = at + t.length
    matched += 1
  }
  return {
    ok: matched > 0,
    reason: total === 0 ? 'no-nonempty-section' : (matched === total ? 'all-matched' : 'partial'),
    offsets,
    matched,
    total,
    renderedChars: text.length,
  }
}

/**
 * 只有**全部非空段都落位**才敢发布 offset（⛔ 部分命中说明正文与我们的段表不是同一份，
 * 此时宁可不给正文位置，也不给可能错位的）。
 * @param {ReturnType<typeof locateSections>} r
 */
export function isFullyLocated(r) {
  return r != null && r.ok === true && r.reason === 'all-matched' && r.total > 0 && r.matched === r.total
}

export default { locateSections, isFullyLocated, FINAL_TEXT_LOCATE_VERSION }
