// ---------------------------------------------------------------------------
// session-playthrough —— 「**活跃会话**属于哪个周目」的**纯函数核心**。
//
// ## 它解决什么
// 面板原来只认**配置里的绑定**（`config.root.{characterId,playthroughId}`）：你在 Tavern 里切到
// 另一个周目开会话，点开记忆库看到的还是老周目的档。用户口径（2026-09-19）：「点开记忆库要
// **自动跳转到对应周目**」⇒ 打开面板时先拿活跃会话问一句"你属于哪个周目"，是就**把绑定改成它**
// （改绑定而不是只改显示 ⇒ 面板读的、面板里收纳写的、后台自动收纳的口径全都对得上）。
//
// ## 数据从哪来（普通文件，⛔ 不连 Tavern、不连宿主）
//   · `<rootPath>/catalog.json`：`playthroughs[].{ id, path, ext.pmpDshTavern.rootSessionId }`
//     （`path` 形如 `<角色>/<周目>/timeline.json`）
//   · `<rootPath>/<角色>/<周目>/timeline.json`：`{ nodes[].variants[].sessionId, head.sessionId }`
//     —— 一个周目有**多条**会话（继续/分支都在里面），所以不能只看 rootSessionId。
//
// ⚠️ 与 dsh-anima-rag 的 `lib/session-playthrough.js` 是**同一套判据的两份实现**（两个插件之间没有
//    直接通道，且各自要能独立自检）。改判据时**两边一起改** —— 那边有更全的注释与真机锚。
//
// @license CC-BY-NC-4.0 (Attribution-NonCommercial 4.0 International)
// ---------------------------------------------------------------------------

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (v) => (typeof v === 'string' ? v.trim() : '')

/** 从 catalog 条目取周目 id：优先 `id`，退从 `path` 的倒数第二段取。 */
export function playthroughIdOf(entry) {
  if (!isRecord(entry)) return ''
  const id = str(entry.id)
  if (id !== '') return id
  const path = str(entry.path)
  if (path === '') return ''
  const parts = path.split(/[\\/]+/).filter((p) => p !== '')
  return parts.length >= 2 ? parts[parts.length - 2] : ''
}

/** 从 catalog 条目取角色 id：优先 `ext.pmpDshTavern.characterId`，退从 `path` 首段取。 */
export function characterIdOf(entry) {
  if (!isRecord(entry)) return ''
  const id = str(entry.ext?.pmpDshTavern?.characterId)
  if (id !== '') return id
  const path = str(entry.path)
  if (path === '') return ''
  const parts = path.split(/[\\/]+/).filter((p) => p !== '')
  return parts.length >= 2 ? parts[0] : ''
}

/** 从 catalog 条目取根会话 id（`ext.pmpDshTavern.rootSessionId`）。 */
export function rootSessionIdOf(entry) {
  if (!isRecord(entry)) return ''
  return str(entry.ext?.pmpDshTavern?.rootSessionId)
}

/** `timeline.json` 里出现过的所有会话 id（head ∪ 各 nodes[].variants[]）。畸形一律跳过。 */
export function sessionIdsOfTimeline(timeline) {
  const out = new Set()
  if (!isRecord(timeline)) return out
  const head = str(timeline.head?.sessionId)
  if (head !== '') out.add(head)
  const nodes = Array.isArray(timeline.nodes) ? timeline.nodes : []
  for (const node of nodes) {
    if (!isRecord(node)) continue
    const variants = Array.isArray(node.variants) ? node.variants : []
    for (const variant of variants) {
      if (!isRecord(variant)) continue
      const id = str(variant.sessionId)
      if (id !== '') out.add(id)
    }
  }
  return out
}

/**
 * 造「会话 → 周目」索引（纯函数）。行序 = catalog 顺序 ⇒ 同一会话命中两个周目时**先到者胜**，
 * 并把冲突**如实列出来**（⛔ 不静默丢）。
 *
 * @param {Array<{ entry?: object, timeline?: object }>} rows
 * @returns {{ map: Map<string,string>, byId: Map<string,{characterId:string}>, conflicts: string[] }}
 */
export function buildSessionIndex(rows) {
  const map = new Map()
  const byId = new Map()
  const conflicts = []
  const list = Array.isArray(rows) ? rows : []
  for (const row of list) {
    if (!isRecord(row)) continue
    const playthroughId = playthroughIdOf(row.entry)
    if (playthroughId === '') continue
    if (!byId.has(playthroughId)) byId.set(playthroughId, { characterId: characterIdOf(row.entry) })
    const ids = new Set(sessionIdsOfTimeline(row.timeline))
    const root = rootSessionIdOf(row.entry)
    if (root !== '') ids.add(root)
    for (const id of ids) {
      const existing = map.get(id)
      if (existing === undefined) { map.set(id, playthroughId); continue }
      if (existing !== playthroughId && !conflicts.includes(id)) conflicts.push(id)
    }
  }
  return { map, byId, conflicts }
}

/**
 * 解析「这个会话属于哪个周目」（纯函数）。**只认会话**：查不到就 `source:'none'`
 * （⛔ 这一步**不回落**配置绑定 —— 回落与否是调用方的决定，端点要把事实说清楚）。
 *
 * @returns {{ characterId: string, playthroughId: string, source: 'session'|'none' }}
 */
export function resolveForSession(index, sessionId) {
  const sid = str(sessionId)
  const map = index && index.map instanceof Map ? index.map : null
  if (sid === '' || map === null) return { characterId: '', playthroughId: '', source: 'none' }
  const playthroughId = str(map.get(sid))
  if (playthroughId === '') return { characterId: '', playthroughId: '', source: 'none' }
  const characterId = str(index.byId?.get?.(playthroughId)?.characterId)
  return { characterId, playthroughId, source: 'session' }
}
