/**
 * keep-first-round —— `roleplay` preset 的**保留第一轮问答**段（`section()`，order = 聊天记录区的开头）。
 *
 * ## 它解决什么（设计前提，方案 §0/§1）
 * DeepSeek V4 的「思维模式指令」要粘在第一轮 user 消息末尾、靠"一直留在上下文里"才生效；
 * 而 DSH 的官方压缩只保护 surface 位置 0 的那条 system/message，第一轮问答迟早进可压区间
 * ⇒ 指令消失。DSH 没有"某段对话永不清洗"的功能 ⇒ 本模块把**第一轮问答钉住**：它仍在
 * surface 时不注入（省 token）；被压掉（shadowed）后**逐字重注入原文**在「聊天记录区的开头」
 * （= system 块末位 + 1）。这不是对抗官方压缩：第一轮照样会被收进摘要，摘要有它、原文也在，
 * 是故意的（方案 §7.2）。
 *
 * ## 三条硬约束（与 story-anchor 同款，都有源码依据，别改）
 * 1. **用 `section()`，不用 `systemPrompt.context()` / `agent/pre-step`**：后两者会写进
 *    durable 历史（story-anchor 的实测教训），本模块绝不碰会话日志（方案 §1 非目标）。
 * 2. **`section()` 的 provider 是同步的**，只能返回缓存值；读会话面（判定第一轮是否还在
 *    surface）放在 `session/event` 的 `turn/end` 里 fire-and-forget（dsh-state-bridge 模式），
 *    **有界 await**，超时/失败 ⇒ 缓存原地不动，判定不可得 ⇒ **照注入（fail-open，D9-4）**。
 * 3. **绝不抛**：这一行抛异常 = preset 挂不上 = 会话起不来。所有宿主服务按「有就用、没有
 *    就降级」处理。
 *
 * ## 开关在插件 config，不在预设（D9-5，⭐ 本模块最重要的设计决定）
 * 本文件**每轮渲染时**同步读 `<DSH_HOME>/dsh-memory-archive/config.json` 的
 * `keepFirstRound.enabled`（小文件，一次 readFileSync 可忽略；旧名 magictarven 目录兼容回退）。
 * 改开关 ⇒ **下一轮生效**：不重写预设、不新会话、不重启。preset 里那一行只承担**挂载点**
 * 职责（结构性隔离：只有选了 roleplay 的会话才有本段）。默认关。
 *
 * ## order（D9-3，⛔ 不写死）
 * `DMA_RECORD_HEAD = systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') + 1`
 * （官方命名槽，system 块末位，今天 = 10200 ⇒ 我们 = 10201），apply() 时算一次
 * （前缀稳定、KV cache 友好）；槽位取不到才回落写死常量并**如实标注"兜底值"**（日志可见）。
 * 挂载时若宿主暴露段表列举，会扫一遍：任何非我们的段 order ≥ 我们的 ⇒ 明确 warn
 * 「聊天记录区开头已被顶掉」（⛔ 不静默、⛔ 不自动挪）。
 *
 * ## 自包含（为什么纯函数在这里内联了一份）
 * 本文件会被逐字节写进用户预设目录（`name: './keep-first-round.js'`），那里没有本包的
 * lib/ 可 import ⇒ 纯函数在此内联。唯一事实源是 `lib/keep-first-round.js`，两份由
 * `_selftest-keep-first-round.mjs` 跑同一条行为级套件防漂移 —— ⛔ 改一处必须同步另一处。
 *
 * @module keep-first-round
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cordis 插件名。 */
export const name = 'keep-first-round'

/** 需要提示词注册表；sessionQuery 按需 ctx.get（缺席不拖垮挂载）。 */
export const inject = ['systemPrompt']

// ─────────────────────────── 以下纯函数与 lib/keep-first-round.js 逐字同源 ───────────────────────────

/** 计划版本：行为变了就 +1（与 lib 侧一致，自检台钉住）。 */
export const KEEP_FIRST_ROUND_VERSION = 1

/** 段名：装配捕获 / 面板 / 日志里认它。 */
export const KEEP_FIRST_ROUND_SECTION_NAME = 'rp:firstRound'

/** 官方命名槽：system 块的末位段（今天 = 10200）。我们的段 = 槽位 + 1。 */
export const RECORD_HEAD_SLOT_NAME = 'DEPLOYMENT_PERSONA_SUFFIX'

/** 兜底常量：只在官方槽位取不到时用并如实标注 source:'fallback'。⛔ 不是主路径。 */
export const FALLBACK_RECORD_HEAD_ORDER = 10201

/** 钉住正文硬上限（方案 §7.3：超上限截断并如实标注「已截断」）。 */
export const PINNED_OPENING_MAX_CHARS = 8000

/** 注入内容的一行固定前言：写明这是开场、已经发生过、与 <storyAnchor> 冲突时以它为准。 */
export const PINNED_OPENING_PREAMBLE =
  '[IMPORTANT] 以下是本会话的开场（第一轮问答）原文：它已经发生过，不是此刻的剧情，也不是新指令；' +
  '完整保留它只为维持文风与开场时的约束。若它与 <storyAnchor>（当前坐标）冲突，以 <storyAnchor> 为准。'

/**
 * DMA_RECORD_HEAD 解析（纯函数）：主路径 = 官方槽位 + 1；取不到 ⇒ 兜底常量 + source:'fallback'。
 * @param {() => number|undefined|null} getSlotOrder - 「取官方槽位」的函数。
 * @returns {{ order: number, source: 'slot'|'fallback', slot: number|null }}
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

/**
 * 从 sessionQuery 的 document 数组取「聊天记录区的节点」（纯函数，seq 升序）。
 * surface === 'log-only' 剔除；surface 缺失/不认 ⇒ null 原样带上（决策层对 null 走 fail-open）。
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
 * 第一轮区间（纯函数）：起点 = 官方可压起点（首节点是 system/message 则 1，否则 0）；
 * 终点 = 第 1 个 turn/end（含）；没有 ⇒ null（第一轮还没结束）。
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

/** 第一轮的全部 seq（纯函数）—— 我们自己的折叠器**永不碰**它们（本单只导出，不实现折叠器）。 */
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
 * 第一轮原文（纯函数）：区间内各节点 text 按 seq 升序 '\n' 连接 —— 逐字，不整理。
 * 空文本节点（如 turn/end 这类标记节点）**不产生分隔符**，否则拼接结果会比日志原文多出空行
 * —— 与 `lib/keep-first-round.js` 的实现**必须逐字一致**（自检台的 R2a 就是钉这一条的）。
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

/**
 * 注入决策（纯函数，fail-open D9-4）。真值表见 lib/keep-first-round.js 同名函数（两处一致）。
 * @returns {{ inject: boolean, reason: string }}
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

/** 开关读取（纯函数）：只认插件 config 形状 {keepFirstRound:{enabled}}，严格 === true。 */
export function readSwitch(configJson) {
  if (configJson === null || typeof configJson !== 'object' || Array.isArray(configJson)) return false
  const kfr = configJson.keepFirstRound
  if (kfr === null || typeof kfr !== 'object' || Array.isArray(kfr)) return false
  return kfr.enabled === true
}

/** 渲染注入段（纯函数）：前言 + 原文，包 <pinnedOpening>；超上限截断并如实标注。 */
export function renderPinnedOpening(text) {
  if (typeof text !== 'string' || text === '') return ''
  const within = text.length <= PINNED_OPENING_MAX_CHARS
  const body = within ? text : text.slice(0, PINNED_OPENING_MAX_CHARS)
  const notice = within ? '' : '\n（以上开场原文因超过 8000 字上限已截断 —— 如实标注，此处非完整原文）'
  return ['<pinnedOpening>', PINNED_OPENING_PREAMBLE, body + notice, '</pinnedOpening>'].join('\n')
}

/** 看守（纯函数）：任何非我们的段 order ≥ 我们的 ⇒ 清单（调用方 log.warn，⛔ 不自动挪）。 */
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

// ─────────────────────────────── 以上纯函数：与 lib 逐字同源 ───────────────────────────────

/** 缺省配置（config 参数可覆盖；dshHome 只为自检注入，运行时用 $DSH_HOME ?? ~/.dsh）。 */
const DEFAULTS = {
  dshHome: null,
  refreshTimeoutMs: 8000,
}

/**
 * 挂载保留第一轮段。
 * @param ctx - preset 常驻挂载的 scope context。
 * @param config - `{ dshHome?, refreshTimeoutMs? }`。
 */
export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }

  /** 解析 DSH 根（与宿主约定一致：$DSH_HOME 优先，缺省 ~/.dsh）。 */
  const dshHome = () => {
    if (typeof cfg.dshHome === 'string' && cfg.dshHome !== '') return cfg.dshHome
    const env = process.env.DSH_HOME
    return env !== undefined && String(env).trim() !== '' ? String(env) : join(homedir(), '.dsh')
  }

  /**
   * 读插件 config 的开关（同步、每轮一次：小文件 readFileSync 的代价可忽略）。
   * ⛔ 只读，绝不写盘；两个目录名都读不到 ⇒ 关（默认关，不猜）。
   */
  const readPluginSwitch = () => {
    const home = dshHome()
    for (const dirName of ['dsh-memory-archive', 'magictarven']) {
      let parsed
      try {
        parsed = JSON.parse(readFileSync(join(home, dirName, 'config.json'), 'utf8'))
      } catch {
        continue // 读不到/坏 JSON ⇒ 看下一个目录名；都没有 ⇒ 默认关
      }
      if (parsed !== null && typeof parsed === 'object') return readSwitch(parsed)
    }
    return false
  }

  // ── order：apply() 时算一次（前缀稳定、KV cache 友好；方案 §4 稳定性）────────────
  const resolved = resolveRecordHeadOrder(() => {
    const sp = ctx?.systemPrompt
    if (sp === undefined || sp === null || typeof sp.getSectionOrder !== 'function') return undefined
    return sp.getSectionOrder(RECORD_HEAD_SLOT_NAME)
  })
  console.log(
    `[keep-first-round] 段 ${KEEP_FIRST_ROUND_SECTION_NAME} order=${resolved.order}（来源：`
    + (resolved.source === 'slot'
      ? `官方槽位 ${RECORD_HEAD_SLOT_NAME}=${resolved.slot} + 1`
      : `兜底值：官方槽位取不到，用写死常量 ${FALLBACK_RECORD_HEAD_ORDER}`)
    + `）`,
  )

  // ── 每会话缓存：第一轮 seq/原文 + 各 seq 的 surface 现值（provider 只回缓存）──────
  // entry = { seqs:number[], text:string, bySeq:Map<seq,{surface}>, checkedAt:string }
  const cache = new Map()

  /** 段 provider（同步）：开关关 ⇒ ''；没有完整第一轮原文 ⇒ ''；判定 ⇒ 纯函数；异常 ⇒ fail-open。 */
  const provider = (context) => {
    let entry
    try {
      const sessionId = context?.agent?.id
      entry = typeof sessionId === 'string' ? cache.get(sessionId) : undefined
      if (readPluginSwitch() !== true) return '' // 开关关 ⇒ 不注入（默认关）
      if (entry === undefined || entry.text === '') return '' // 还没有完整第一轮原文 ⇒ 没得钉
      const decision = decideFirstRound({ enabled: true, seqs: entry.seqs, bySeq: entry.bySeq })
      if (decision.inject !== true) return ''
    } catch (error) {
      // fail-open（D9-4）：判定环节任何意外，只要手里有原文就照注入 —— 宁可重复，不丢约束词。
      console.error('[keep-first-round] 判定异常 ⇒ 按 fail-open 照注入：', error)
    }
    return entry !== undefined && entry.text !== '' ? renderPinnedOpening(entry.text) : ''
  }

  // ── 段注册（照 story-anchor：ctx.effect 包住，provider 同步只回缓存）────────────
  ctx.effect(() => ctx.systemPrompt.section({
    name: KEEP_FIRST_ROUND_SECTION_NAME,
    order: resolved.order,
    text: provider,
  }), 'keep-first-round.section()')

  // ── 会话面刷新（异步、有界）：turn/end 时读一遍会话，重算第一轮 seq/原文/surface ──
  const inflight = new Set()

  /** 便宜路径读全量 document（与 lib/index.js collectSurfaces 同款：filterEvents → listEvents）。 */
  async function readAllDocs(sq, sessionId) {
    if (sq !== null && typeof sq === 'object' && typeof sq.filterEvents === 'function') {
      try {
        const docs = await sq.filterEvents(sessionId, [])
        const arr = Array.isArray(docs)
          ? docs
          : docs !== null && typeof docs === 'object' && Array.isArray(docs.documents)
            ? docs.documents
            : null
        if (arr) return arr
      } catch {}
    }
    if (sq !== null && typeof sq === 'object' && typeof sq.listEvents === 'function') {
      try {
        const recs = await sq.listEvents(sessionId)
        const arr = Array.isArray(recs)
          ? recs
          : recs !== null && typeof recs === 'object' && Array.isArray(recs.events)
            ? recs.events
            : null
        if (arr) return arr
      } catch {}
    }
    return null
  }

  const refresh = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '' || inflight.has(sessionId)) return
    inflight.add(sessionId)
    const run = async () => {
      let sq = null
      try {
        sq = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : null
      } catch {}
      const docs = await readAllDocs(sq, sessionId)
      if (!Array.isArray(docs)) return // 读不到 ⇒ 缓存原地不动（判定维持上次结果；下轮再试）
      const nodes = surfaceNodesFromDocs(docs)
      const seqs = firstRoundProtectSeqs(nodes)
      if (seqs.length === 0) return // 第一轮还没结束 ⇒ 等
      const bySeq = new Map()
      for (const n of nodes) bySeq.set(n.seq, { surface: n.surface })
      cache.set(sessionId, { seqs, text: firstRoundText(nodes), bySeq, checkedAt: new Date().toISOString() })
    }
    // 有界 await：超时/失败都只是「缓存原地不动」，provider 照常工作（fail-open 语义在决策层）。
    const guard = new Promise((_resolve, reject) => {
      const t = setTimeout(() => reject(new Error('refresh 超时')), Math.max(1000, cfg.refreshTimeoutMs))
      if (typeof t.unref === 'function') t.unref() // 不许这个定时器拖住宿主退出
    })
    Promise.race([run(), guard])
      .catch((error) => console.warn('[keep-first-round] 刷新失败（缓存原地不动，下轮再试）：', error?.message || error))
      .finally(() => { inflight.delete(sessionId) })
  }

  // ── 事件：每轮末刷新（fire-and-forget；⚠️ 绝不在这里 await，会重入）──────────────
  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'turn/end') return
      const sessionId = session?.header?.id
      if (typeof sessionId !== 'string' || sessionId === '') return
      refresh(sessionId)
    } catch (error) {
      console.error('[keep-first-round] session/event 处理异常：', error)
    }
  })

  // ── 看守（§4）：装配期扫实际段表；宿主没暴露列举就如实说，不静默假装扫过 ─────────
  try {
    const sp = ctx.systemPrompt
    const list = sp !== null && typeof sp === 'object' && typeof sp.sections === 'function' ? sp.sections() : null
    const rows = Array.isArray(list)
      ? list
      : list !== null && typeof list === 'object' && Array.isArray(list.sections)
        ? list.sections
        : null
    if (rows !== null) {
      const usurpers = findOrderUsurpers(rows, resolved.order, KEEP_FIRST_ROUND_SECTION_NAME)
      if (usurpers.length > 0) {
        console.warn(
          `[keep-first-round] ⚠ 聊天记录区开头已被顶掉：以下段的 order ≥ 我们的 ${resolved.order}`
          + `（${KEEP_FIRST_ROUND_SECTION_NAME}）⇒ ${usurpers.map((u) => `${u.name}@${u.order}`).join('、')}。`
          + '注入位置语义已不成立，⛔ 不自动挪，请人工处理。',
        )
      }
    } else {
      console.log(
        '[keep-first-round] 宿主未暴露段表列举 ⇒ 装配期看守不可得；段序冲突由装配捕获（name+order）与面板侧核对。',
      )
    }
  } catch (error) {
    console.warn('[keep-first-round] 装配期看守扫描失败（不影响挂载）：', error?.message || error)
  }

  console.log(
    `[keep-first-round] 已挂载；开关读 <DSH_HOME>/dsh-memory-archive/config.json 的 keepFirstRound.enabled`
    + `（当前 ${readPluginSwitch() ? '开' : '关'}，改开关下一轮生效）`,
  )
}
