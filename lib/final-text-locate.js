/**
 * 在**最终系统正文**里按段序定位每一段 —— 算出可信的 `offset`。
 *
 * ## 铁律：**底本 = 实际文本**（2026-09-18 用户口径）
 * 面板要回答的是"**这一楼真正发出去的是什么**"。所以权威底本永远是**最终系统正文**
 * （会话日志里的 `system/message`），我们的活只是"把每段的边界放上去"。
 * ⇒ 边界可以切错（用户原话："我们可以切错，但底本一定要是实际文本"），
 *   ⛔ 但**绝不许**拿我们手里那份副本去冒充发布内容。
 *
 * ## 为什么不能在装配瀑布里算（2026-09-17 真机查死）
 * §9 的"点开看正文"要求 `renderedChars/renderedHash` 与**最终**系统消息逐字节相等。
 * 而装配瀑布里算不出这个：
 * · **anima**（`dsh-anima-rag`）是 **`next()` 之后才改写** —— 它的产出只沿瀑布**返回值**往上传，
 *   排在下游的监听器拿不到（`deferred-install.js` 当初就是为此）；2026-09-17 判据实验后，
 *   捕获改成"站最外层 + 读返回值"，**拿得到**这一版（见 sections-capture.js）；
 * · **但 DSH 还会在瀑布之后做 `complete` 段覆盖**（`core/system-prompt/src/index.ts:621-626`）
 *   —— 这一步任何监听器都看不到 ⇒ 瀑布返回值未必等于**最终**正文；
 * · ★★ 2026-09-18 真机实测补：**宿主渲染时会改写某些段的文本** —— 同一楼里
 *   `profile` 的哈希我们与最终正文**完全相等**，而 `anima:memory` 我们那版 1959 字、
 *   最终正文是 **2293 字**，且我们那版**不是它的子串**（±400 偏移都试过）。
 *   ⇒ 所以"逐字匹配"只能覆盖**宿主原样搬运**的段；被改写的段必须**换一种定界方式**。
 *
 * ⇒ 真位置只能等 DSH 把**最终正文**写进会话日志（`system/message` 事件）之后再定。
 *
 * ## 定位口径（两遍，⛔ 都不猜）
 * **第一遍 · 逐字匹配（权威）**：从游标向后找整段正文；找到就把游标推到段末。
 * **第二遍 · 锚点定界**（只用于第一遍没命中的段）：用段正文**开头 N 字**当锚点找起点，
 * 终点取**下一个已知起点 − 段间分隔符**。切出来的内容因此**一定来自最终正文**。
 *   ⛔ 边界（必须守住）：锚点找不到 ⇒ 不发；它和下一个已知起点之间**还夹着别的非空且未定位的段**
 *   ⇒ 拆不开，**不发**（那才是猜）；算出来长度 ≤ 0 ⇒ 不发。
 * **空段跳过且不占位**（宿主也不会给 0 字段 offset）。
 *
 * @module dsh-memory-archive/final-text-locate
 * @license CC-BY-NC-4.0
 */

export const FINAL_TEXT_LOCATE_VERSION = 2

/**
 * 锚点取段正文开头多少字符。
 * ★ 自适应（2026-09-18 真机推出）：宿主对段的改写可能**只保留开头一点点共同部分** ——
 *   实测 anima 那段两边都以 `<recalledMemories>`（18 字）开头，第 19 个字起就分岔
 *   ⇒ 固定 24 字会必然失配。所以**先拿最长前缀试，不中就逐步缩短**（下限 {@link MIN_ANCHOR_CHARS}）。
 * ⚠️ 相应代价：锚点越短越可能撞到别处的相同片段 —— 用户口径已认下这个风险
 *   （"我们可以切错，但底本一定要是实际文本"）。
 */
export const ANCHOR_CHARS = 24

/** 锚点最短长度（低于这个就不敢当锚点了）。 */
export const MIN_ANCHOR_CHARS = 8

/**
 * @param {Array<{name?:string, text?:string}>} sections - 段表（顺序即正文顺序）；`text` 是**插值后**正文
 * @param {string} finalText - 最终系统正文
 * @param {{sepLen?:number, anchorChars?:number}} [opts]
 * @returns {{ok:boolean, reason:string, offsets:Array<{offset:number|null, chars:number|null,
 *            exact:boolean, anchored:boolean}>, matched:number, exact:number, anchored:number,
 *            total:number, renderedChars:number|null, reasons:string[]}}
 *
 * ★ `reasons[i]` 是**逐段**的定界结果，取值：
 *   `'empty'` 空段（不占位）· `'exact'` 逐字命中 · `'anchored'` 锚点定界成功 ·
 *   `'anchor-miss'` 锚点**根本没找到**（该段开头在最终正文里不存在）·
 *   `'blocked'` 锚点找到了，但它和下一个已知起点之间还夹着别的未定位非空段 ⇒ 拆不开 ·
 *   `'nonpositive'` 算出来长度 ≤ 0（自己或下一个起点在上游，说明锚点撞到了别处）。
 *   界面「为什么给不出位置」就靠它说人话 —— 四个失败码的含义**完全不同**，⛔ 不许糊成一句。
 */
export function locateSections(sections, finalText, opts = {}) {
  const list = Array.isArray(sections) ? sections : []
  const text = typeof finalText === 'string' ? finalText : ''
  const sepLen = Number.isInteger(opts?.sepLen) ? opts.sepLen : 2
  const anchorChars = Number.isInteger(opts?.anchorChars) && opts.anchorChars > 0 ? opts.anchorChars : ANCHOR_CHARS
  const blank = () => ({ offset: null, chars: null, exact: false, anchored: false })
  const offsets = list.map(blank)
  const reasons = list.map((s) => (typeof s?.text === 'string' && s.text !== '' ? 'pending' : 'empty'))
  const textOf = (i) => (typeof list[i]?.text === 'string' ? list[i].text : '')

  if (text === '') {
    return { ok: false, reason: 'no-final-text', offsets, matched: 0, exact: 0, anchored: 0, total: 0, renderedChars: null, reasons }
  }

  // ── 第一遍：逐字匹配（宿主原样搬运的段；权威） ──
  let cursor = 0
  let exact = 0
  let total = 0
  for (let i = 0; i < list.length; i += 1) {
    const t = textOf(i)
    if (t === '') continue // 空段不占位
    total += 1
    const at = text.indexOf(t, cursor)
    if (at < 0) continue // 找不到 ⇒ 留给第二遍
    offsets[i] = { offset: at, chars: t.length, exact: true, anchored: false }
    reasons[i] = 'exact'
    cursor = at + t.length
    exact += 1
  }
  if (total > 0 && exact === total) {
    return { ok: true, reason: 'all-matched', offsets, matched: exact, exact, anchored: 0, total, renderedChars: text.length, reasons }
  }

  // ── 第二遍：锚点定界（内容被宿主改写的段） ──
  const starts = new Array(list.length).fill(null)
  for (let i = 0; i < list.length; i += 1) if (offsets[i].exact) starts[i] = offsets[i].offset
  let anchored = 0
  {
    let cur = 0
    for (let i = 0; i < list.length; i += 1) {
      if (starts[i] !== null) { cur = Math.max(cur, starts[i] + offsets[i].chars); continue }
      const t = textOf(i)
      if (t === '') continue
      // 最长前缀先试，不中再逐步缩短（宿主可能只保留了开头那点共同部分）
      let at = -1
      const maxL = Math.min(anchorChars, t.length)
      for (let L = maxL; L >= MIN_ANCHOR_CHARS; L -= 1) {
        const pos = text.indexOf(t.slice(0, L), cur)
        if (pos >= 0) { at = pos; break }
      }
      if (at < 0) { reasons[i] = 'anchor-miss'; continue }
      starts[i] = at
      cur = Math.max(cur, at + MIN_ANCHOR_CHARS) // 推进到锚点之后，避免同一位置反复命中
    }
  }
  // 定终点：下一个**已知起点** − 分隔符；中间夹着非空且未定位的段 ⇒ 拆不开，整段作废
  for (let i = 0; i < list.length; i += 1) {
    if (starts[i] === null || offsets[i].exact) continue
    let j = i + 1
    let blocked = false
    while (j < list.length && starts[j] === null) {
      if (textOf(j) !== '') { blocked = true; break }
      j += 1
    }
    if (blocked) { reasons[i] = 'blocked'; continue }
    const end = j >= list.length ? text.length : starts[j] - sepLen
    const len = end - starts[i]
    if (len <= 0) { reasons[i] = 'nonpositive'; continue }
    offsets[i] = { offset: starts[i], chars: len, exact: false, anchored: true }
    reasons[i] = 'anchored'
    anchored += 1
  }

  const resolved = exact + anchored
  return {
    ok: resolved > 0,
    reason: total === 0 ? 'no-nonempty-section' : (resolved === total ? 'all-matched' : 'partial'),
    offsets,
    matched: resolved,
    exact,
    anchored,
    total,
    renderedChars: text.length,
    reasons,
  }
}

/**
 * 只有**全部非空段都落位**（逐字命中 **或** 锚点定界）才敢发布 offset
 * （⛔ 还有段没落位 ⇒ 说明正文与我们的段表不是同一份，宁可不给可能错位的）。
 * @param {ReturnType<typeof locateSections>} r
 */
export function isFullyLocated(r) {
  return r != null && r.ok === true && r.reason === 'all-matched' && r.total > 0 && r.matched === r.total
}

export default { locateSections, isFullyLocated, ANCHOR_CHARS, MIN_ANCHOR_CHARS, FINAL_TEXT_LOCATE_VERSION }
