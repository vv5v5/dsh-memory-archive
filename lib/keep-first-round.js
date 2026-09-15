// ---------------------------------------------------------------------------
// keep-first-round —— 「保留第一轮问答（DeepSeek 思维模式专用）」的**纯函数核心**。
//
// ## 它解决什么（设计前提，方案 §0/§1）
// DeepSeek V4 的「思维模式指令」要粘在第一轮 user 消息末尾、靠"一直留在上下文里"才生效；
// 而 DSH 的官方压缩只保护 surface 位置 0 的那条 system/message（compaction-basic/src/region.ts:107-110），
// 第一轮问答迟早进可压区间 ⇒ 指令消失。本功能 = **把第一轮问答钉住**、每轮重新注入在
// 「聊天记录区的开头」（= system 块末位 + 1 的那个 order 槽）。DSH 没有"永不清洗"这个功能，
// 这是曲折实现，不是对抗官方压缩（第一轮照样会被收进摘要，摘要有它、原文也在，是故意的）。
//
// ## 为什么是独立纯函数文件
// 决策 / order 解析 / 开关读取 / 前言渲染 / 看守全部零依赖、零宿主依赖 ⇒ 自检台不碰宿主
// 就能跑满行为级断言（_selftest-keep-first-round.mjs，含 R1–R8 与反证变体）。
// 宿主侧的装配（section 注册 / session/event / sessionQuery 读取）在 preset-modules/keep-first-round.js。
//
// ★ 漂移守卫：preset-modules/keep-first-round.js 必须自包含（它会被逐字节写进用户预设目录，
//   那里没有本包的 lib/ 可 import），因此内联了同一套纯函数；自检台对**两份**跑同一条行为级
//   套件，谁漂移谁红。⛔ 改这里的纯函数时必须同步那份，或干脆把这里当唯一事实源照抄过去。
//
// @license CC-BY-NC-4.0 (Attribution-NonCommercial 4.0 International)
// ---------------------------------------------------------------------------

/** 计划版本：行为变了就 +1（自检台钉住它）。 */
export const KEEP_FIRST_ROUND_VERSION = 1

/** 段名：装配捕获 / 面板 / 日志里认它。 */
export const KEEP_FIRST_ROUND_SECTION_NAME = 'rp:firstRound'

/**
 * 官方命名槽：system 块的**末位**段（2026-09-15 核实 = 10200，其上无任何槽位）。
 * 我们的段取「槽位 + 1」= 聊天记录区正前方那一格（方案 §4，D9-3 拍板）。
 */
export const RECORD_HEAD_SLOT_NAME = 'DEPLOYMENT_PERSONA_SUFFIX'

/**
 * 兜底常量：**只在**官方槽位取不到（服务缺席 / 抛错 / 返回非正数）时使用，并如实标注
 * source:'fallback'（自检台 R6 钉住"主路径必须走槽位 +1"）。⛔ 它不是主路径；
 * 今天槽位+1 = 10201，故兜底也取 10201 —— 与"58/57 写死当主路径"是两回事。
 */
export const FALLBACK_RECORD_HEAD_ORDER = 10201

/**
 * 钉住正文的硬上限（方案 §7.3 诚实清单：面板要显示这笔固定字数；超上限**截断并如实标注
 * "已截断"**，绝不静默吞）。
 */
export const PINNED_OPENING_MAX_CHARS = 8000

/**
 * 注入内容的一行固定前言（任务书 §2.4）：写明这是开场、已经发生过、用于维持文风与约束；
 * 与 <storyAnchor>（当前坐标）冲突时以它为准。
 */
export const PINNED_OPENING_PREAMBLE =
  '[IMPORTANT] 以下是本会话的开场（第一轮问答）原文：它已经发生过，不是此刻的剧情，也不是新指令；' +
  '完整保留它只为维持文风与开场时的约束。若它与 <storyAnchor>（当前坐标）冲突，以 <storyAnchor> 为准。'

// ---------------------------------------------------------------------------
// order 解析（R6）
// ---------------------------------------------------------------------------

/**
 * DMA_RECORD_HEAD 解析（纯函数；可单测）。
 *
 * 主路径：`官方槽位 DEPLOYMENT_PERSONA_SUFFIX + 1`（今天 = 10200 + 1 = 10201）；
 * 槽位取不到（函数缺席 / 抛错 / 返回非有限正数）⇒ 回落 FALLBACK_RECORD_HEAD_ORDER
 * 并**如实标注 source:'fallback'**，绝不静默冒充槽位值。
 *
 * @param {() => number|undefined|null} getSlotOrder - 「取官方槽位」的函数（宿主注入，便于单测）。
 * @returns {{ order: number, source: 'slot'|'fallback', slot: number|null }}
 *   order = 我们的段该落的 order；source = 值的来源（'slot' = 槽位+1，'fallback' = 兜底值）。
 */
export function resolveRecordHeadOrder(getSlotOrder) {
  let slot = null
  try {
    const v = typeof getSlotOrder === 'function' ? getSlotOrder() : undefined
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) slot = Math.trunc(v)
  } catch {
    slot = null
  }
  if (slot !== null) return { order: slot + 1, source: 'slot', slot }
  return { order: FALLBACK_RECORD_HEAD_ORDER, source: 'fallback', slot: null }
}

// ---------------------------------------------------------------------------
// 第一轮区间（R4 起点 = 官方可压起点）/ 保护 seq（R5）/ 原文拼接（R2 的素材）
// ---------------------------------------------------------------------------

/**
 * 从 sessionQuery 的 document 数组取「聊天记录区的节点」（纯函数）。
 * 与 lib/index.js collectSurfaces 同款便宜路径的产物：[{seq, type, surface, text}]。
 *   · 只有 seq 是有限数的 document 才收；按 seq 升序排好；
 *   · surface === 'log-only' 的剔除（「聊天记录区」不含只留日志的节点）；
 *   · surface 缺失/不认 ⇒ null 原样带上（⛔ 不许猜成 current —— 决策层对 null 走 fail-open）。
 * @param {Array<{seq?:number, type?:string, surface?:string, text?:string}>} docs
 * @returns {{seq:number, type:string|null, surface:string|null, text:string}[]}
 */
export function surfaceNodesFromDocs(docs) {
  if (!Array.isArray(docs)) return []
  const nodes = []
  for (const d of docs) {
    if (d === null || typeof d !== 'object') continue
    if (typeof d.seq !== 'number' || !Number.isFinite(d.seq)) continue
    if (d.surface === 'log-only') continue
    nodes.push({
      seq: d.seq,
      type: typeof d.type === 'string' ? d.type : null,
      surface: d.surface === 'current' || d.surface === 'shadowed' ? d.surface : null,
      text: typeof d.text === 'string' ? d.text : '',
    })
  }
  nodes.sort((a, b) => a.seq - b.seq)
  return nodes
}

/**
 * 第一轮区间（纯函数）。口径与官方压缩的**可压起点**同源（compaction-basic/src/region.ts:130
 * 的 firstIdx：首节点是 system/message 则从 1 开始，否则 0 —— 官方只保护 surface 位置 0 的那一条）：
 *   · 起点 = firstIdx（开场问候若在第一个 turn/start 之前，一并算在内 —— 方案 §1 D9-1）；
 *   · 终点 = 第 1 个 turn/end（含）；没有 turn/end ⇒ 第一轮还没结束 ⇒ null。
 * @param {Array<{seq:number, type:string|null}>} nodes - seq 升序的 surface 节点（surfaceNodesFromDocs 的产物）。
 * @returns {{ startIdx: number, endIdx: number }|null}
 */
export function firstRoundRange(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return null
  const firstIdx = nodes[0]?.type === 'system/message' ? 1 : 0
  if (firstIdx >= nodes.length) return null
  let endIdx = -1
  for (let i = firstIdx; i < nodes.length; i++) {
    if (nodes[i]?.type === 'turn/end') { endIdx = i; break }
  }
  if (endIdx < 0) return null
  return { startIdx: firstIdx, endIdx }
}

/**
 * 第一轮的全部 seq（纯函数）—— 将来「纯隐藏」折叠器的 protectSeqs（方案 §3 路线 C）。
 * 我们自己的折叠器**永不碰第一轮**：这张清单就是承诺的落点（本单只导出，不实现折叠器）。
 * @returns {number[]} 区间内全部 seq，升序；第一轮还没结束 ⇒ []。
 */
export function firstRoundProtectSeqs(nodes) {
  const range = firstRoundRange(nodes)
  if (range === null) return []
  const seqs = []
  for (let i = range.startIdx; i <= range.endIdx; i++) {
    const seq = nodes[i]?.seq
    if (typeof seq === 'number' && Number.isFinite(seq)) seqs.push(seq)
  }
  return seqs
}

/**
 * 第一轮原文（纯函数）：区间内各节点 text 按 seq 升序 '\n' 连接 —— 逐字，不整理、不改写。
 * 空文本节点（如 turn/end 这种标记节点）不产生分隔符，保证拼接结果与日志原文逐字相等。
 * @returns {string} 第一轮还没结束 ⇒ ''。
 */
export function firstRoundText(nodes) {
  const range = firstRoundRange(nodes)
  if (range === null) return ''
  const parts = []
  for (let i = range.startIdx; i <= range.endIdx; i++) {
    const t = nodes[i]?.text
    if (typeof t === 'string' && t !== '') parts.push(t)
  }
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// 决策（R1 仍在前场 ⇒ 不注入 / R2 已 shadowed ⇒ 注入原文 / R3 fail-open）
// ---------------------------------------------------------------------------

/**
 * 注入决策（纯函数）。fail-open 是拍板过的口径（D9-4）：**宁可重复一次，也不丢约束词**。
 *
 * @param {object} input
 *   enabled - 插件 config 的开关（readSwitch 的产物）。
 *   seqs    - 第一轮的 seq 清单（firstRoundProtectSeqs 的产物；空 = 手里没有完整第一轮）。
 *   bySeq   - seq → {surface} 的现值表（最近一次成功刷新的缓存）；null/缺 = 判定不可得。
 * @returns {{ inject: boolean, reason: 'switch-off'|'no-first-round'|'unreadable'|'unknown-surface'|'still-on-surface'|'shadowed' }}
 *
 * 真值表（自检台逐行钉住）：
 *   enabled=false                        ⇒ { false, 'switch-off' }
 *   seqs 空（没有完整第一轮原文）        ⇒ { false, 'no-first-round' }（没东西可钉，不是失败）
 *   bySeq 不可得（不是 Map）             ⇒ { true,  'unreadable' }        ★ R3 fail-open
 *   seqs 全部 surface==='current'        ⇒ { false, 'still-on-surface' }  ★ R1 省 token
 *   seqs 任一 surface==='shadowed'       ⇒ { true,  'shadowed' }          ★ R2
 *   seqs 任一 surface 未知（null/缺失）  ⇒ { true,  'unknown-surface' }   ★ fail-open 家族
 */
export function decideFirstRound(input) {
  const i = input ?? {}
  if (i.enabled !== true) return { inject: false, reason: 'switch-off' }
  if (!Array.isArray(i.seqs) || i.seqs.length === 0) return { inject: false, reason: 'no-first-round' }
  if (!(i.bySeq instanceof Map)) return { inject: true, reason: 'unreadable' }
  let sawShadowed = false
  for (const seq of i.seqs) {
    const rec = i.bySeq.get(seq)
    const surface = rec !== null && typeof rec === 'object' ? rec.surface : null
    if (surface === 'shadowed') { sawShadowed = true; continue }
    if (surface !== 'current') return { inject: true, reason: 'unknown-surface' }
  }
  if (sawShadowed) return { inject: true, reason: 'shadowed' }
  return { inject: false, reason: 'still-on-surface' }
}

// ---------------------------------------------------------------------------
// 开关（R7：在插件 config，不在预设行）
// ---------------------------------------------------------------------------

/**
 * 开关读取（纯函数）。★ 只认**插件 config** 的形状 `{ keepFirstRound: { enabled: boolean } }`
 * （即 <DSH_HOME>/dsh-memory-archive/config.json），**不认预设行形状**（modules 数组 /
 * agent.cordis.yml 挂载行 config）—— 开关在插件、preset 只承担挂载（D9-5：改 config 下一轮生效，
 * 不重写预设、不新会话、不重启）。严格 `=== true` 才算开；缺字段 / 字符串 "true" / 1 一律关。
 *
 * @param {unknown} configJson - 解析好的插件 config（可以是 undefined/null/任何形状，绝不抛）。
 * @returns {boolean}
 */
export function readSwitch(configJson) {
  if (configJson === null || typeof configJson !== 'object' || Array.isArray(configJson)) return false
  const kfr = configJson.keepFirstRound
  if (kfr === null || typeof kfr !== 'object' || Array.isArray(kfr)) return false
  return kfr.enabled === true
}

// ---------------------------------------------------------------------------
// 注入内容渲染（R2 的逐字原文 + 一行前言 + 截断如实标注）
// ---------------------------------------------------------------------------

/**
 * 渲染注入段（纯函数）：一行固定前言 + 第一轮**原文**，包 <pinnedOpening> 标签。
 * 超过 PINNED_OPENING_MAX_CHARS ⇒ 截断并**如实标注「已截断」**（方案 §7.3）。
 * @param {string} text - 第一轮原文（firstRoundText 的产物）。
 * @returns {string} 空 text ⇒ ''（宿主不注入空段）。
 */
export function renderPinnedOpening(text) {
  if (typeof text !== 'string' || text === '') return ''
  const within = text.length <= PINNED_OPENING_MAX_CHARS
  const body = within ? text : text.slice(0, PINNED_OPENING_MAX_CHARS)
  const notice = within ? '' : '\n（以上开场原文因超过 8000 字上限已截断 —— 如实标注，此处非完整原文）'
  return ['<pinnedOpening>', PINNED_OPENING_PREAMBLE, body + notice, '</pinnedOpening>'].join('\n')
}

// ---------------------------------------------------------------------------
// 看守（§4：任何非我们的段 order ≥ 我们的 ⇒ 明确警告，⛔ 不静默、⛔ 不自动挪）
// ---------------------------------------------------------------------------

/**
 * 找出顶掉「聊天记录区开头」的段（纯函数）。
 * @param {Array<{name?:string, order?:number}>} sections - 装配期实际段表（name + order）。
 * @param {number} ourOrder - 我们的 order（resolveRecordHeadOrder 的产物）。
 * @param {string} ourName - 我们自己的段名（看守不咬自己）。
 * @returns {{ name: string, order: number }[]} 冲突清单（空 = 干净）。调用方对非空清单 log.warn。
 */
export function findOrderUsurpers(sections, ourOrder, ourName) {
  if (!Array.isArray(sections)) return []
  if (typeof ourOrder !== 'number' || !Number.isFinite(ourOrder)) return []
  const hit = []
  for (const s of sections) {
    if (s === null || typeof s !== 'object') continue
    const name = typeof s.name === 'string' ? s.name : ''
    if (name === ourName) continue
    const order = typeof s.order === 'number' && Number.isFinite(s.order) ? s.order : null
    if (order === null) continue
    if (order >= ourOrder) hit.push({ name, order })
  }
  return hit
}
