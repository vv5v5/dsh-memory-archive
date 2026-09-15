/**
 * 分支隔离：turn 锚点 + history 重推导。
 *
 * ## 为什么必须重写
 *
 * ST 的 `resolveBase`（`状态系统v1.js:443-460`）是一条四级推导链：
 *   **快照@N-1 → 归档 ≤N-1 最近条 → 状态 → 空状态**
 * 它建立在 TavernHelper 的两级变量作用域上 —— `type:'message'` 的楼层快照**随删楼自动消失**，
 * 这是 ST 分支隔离的全部机制。DSH 没有等价物（`方案-L1状态系统迁移.md` §1 的"需重设计"表）。
 *
 * ## DSH 版怎么做
 *
 * DSH 有更好的东西：**权威的 session log + 单调 seq**（`agent.ts:2-3` "Every request is derived
 * from the session log"），以及 `turnBoundary` 投影给的出现成 `lastTurn`
 * （`agent-loop/src/index.ts:55-93`，字段 `openTurnStartSeq` / `lastStepStartSeq` /
 * `lastStepBoundary` / `lastTurn`）。
 *
 * 所以四级链重映射为：
 *   **history[turn ≤ 当前 turn] 的最近一条 → baseline → emptyStatus**
 *
 * 判定"发生了回退/分支"的信号：观测到的 `lastTurn` **小于**我们记录的锚点 turn。
 * （`方案-L1状态系统迁移.md` 的风险表第 1 条把这个标为"未验证" —— 所以本模块同时接受
 *  一个 `seq` 信号做交叉校验：若 `lastTurn` 没回头但 log 长度比锚点 seq 短，同样判回退。）
 */
import { emptyStatus, normalizeStatus, clone } from './state.js'

/**
 * 从 history + baseline 推导出当前应有的基座状态。
 *
 * @param opts.history      [{turn, seq, at, state}]（任意顺序）
 * @param opts.baseline     baseline.json 的内容（含 `.state`）或裸状态
 * @param opts.currentTurn  当前 turn（无法确定时传 null → 取 history 里最新的）
 * @returns {{ status, source, turn }}
 */
export function resolveBase({ history = [], baseline = null, currentTurn = null } = {}) {
  const usable = history
    .filter(h => h && h.state && typeof h.turn === 'number')
    .filter(h => currentTurn === null || h.turn <= currentTurn)
    .sort((a, b) => a.turn - b.turn)

  if (usable.length) {
    const last = usable[usable.length - 1]
    return { status: normalizeStatus(clone(last.state)), source: `history@turn${last.turn}`, turn: last.turn }
  }

  const bstate = baseline?.state ?? baseline
  if (bstate && typeof bstate === 'object' && Object.keys(bstate).length) {
    return { status: normalizeStatus(clone(bstate)), source: 'baseline', turn: null }
  }

  return { status: emptyStatus(), source: 'empty', turn: null }
}

/**
 * 判断是否需要重新推导基座（即锚点是否失效）。
 *
 * @param anchor        {turn, seq} 我们记录的锚点
 * @param observedTurn  当前观测到的 turn（`turnBoundary.lastTurn`）
 * @param observedSeq   当前观测到的 log 长度（可选，用于交叉校验）
 * @returns {{ rewind: boolean, reason: string }}
 */
export function detectRewind(anchor, observedTurn, observedSeq) {
  if (!anchor || typeof anchor.turn !== 'number') {
    return { rewind: true, reason: 'no-anchor' }
  }
  if (typeof observedTurn === 'number' && observedTurn < anchor.turn) {
    return { rewind: true, reason: `turn 回头 ${anchor.turn} → ${observedTurn}` }
  }
  // 交叉校验：seq 变短说明日志被截断（turn 号可能因为 fork 而重新计数）
  if (typeof observedSeq === 'number' && typeof anchor.seq === 'number' && observedSeq < anchor.seq) {
    return { rewind: true, reason: `log 变短 ${anchor.seq} → ${observedSeq}` }
  }
  return { rewind: false, reason: 'ok' }
}

/**
 * 从 session 事件序列里取"本轮的增量文本"。
 *
 * DSH 侧的做法（`方案-L1状态系统迁移.md` §6.3 的另一条路）：`turn/end` 是 `finally` 里
 * 最后追加的，此刻本轮全部消息事件已在日志里，监听器可**同步**提取整轮数据。
 *
 * @param events   session 的事件数组（按 seq 升序）
 * @param sinceSeq 只取 seq > sinceSeq 的事件（上一轮锚点）
 * @param maxChars 文本上限（默认 6000 字；ST 的 contextFloors=2 是在 SP 侧截的，这里按字数截）
 */
export function extractTurnText(events, sinceSeq = -1, maxChars = 6000) {
  const lines = []
  for (const ev of events ?? []) {
    if (typeof ev?.seq === 'number' && ev.seq <= sinceSeq) continue
    const t = ev?.type
    if (t !== 'user/message' && t !== 'assistant/message') continue
    const text = messageText(ev.data)
    if (!text) continue
    const who = t === 'user/message' ? '玩家' : 'KP'
    lines.push(`#${ev.seq}【${who}】${text}`)
  }
  let out = lines.join('\n\n')
  if (out.length > maxChars) out = out.slice(out.length - maxChars) // 保留最近的部分
  return out
}

/** 从一条消息事件里取纯文本（内容块数组 → 拼接 text 块）。 */
export function messageText(data) {
  const content = data?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim()
}

/** 供日志/审计用的可读描述。 */
export function describeBase({ source, turn }) {
  return turn === null || turn === undefined ? source : `${source}`
}
