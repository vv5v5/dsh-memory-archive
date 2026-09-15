/**
 * collect-scan（A2）—— 压缩联动的自动收纳：扫 shadowed 区间 → 写进周目归档。
 *
 * 设计决定（不改压缩后端，别自己改回去）：
 *   - 遮蔽已由官方 compaction 做完（真机实证单会话 752 篇 shadowed）⇒ 本模块只做
 *     「把已被压出去的内容事后收进归档」，不拦压缩、不碰 mt-compaction.js（生成器，
 *     生成物只依赖 推理/tokenMeter/sessions 三个服务名的既有契约，不许被 IO 破坏）。
 *   - append-only 日志是真相源 ⇒ 事后扫描不会丢内容，不需要 fail-closed。
 *   - surface 判定只认宿主 collectSurfaces(sq, sessionId)（由 lib/index.js 的路由分派行
 *     注入，本模块不重造）；⛔ 禁 searchSessions/searchEvents（全量对账 88s/2GB）。
 *   - 台账 <DSH_HOME>/magictarven/collect-ledger.json 是幂等唯一依据：★ 只存哈希/计数/
 *     路径，绝不存正文。alreadyArchived 只来自台账 contentHash（不靠楼号猜）。
 *   - skipped.reason 完整枚举（planScan/applyScan 返回的 skipped 数组，含义如下）：
 *       'already-archived' —— 该 region 的 contentHash 已在台账里（幂等跳过，不重写）；
 *       'too-big'          —— region 楼数超过 maxFloorsPerRegion，跳过它、其余 region 照常；
 *       'empty'            —— region 里一条 user/message / assistant/message 都没有（如纯
 *                               tool/result 的遮蔽段），或消息文档全为空正文：本就不该落成
 *                               楼层，放 skipped（而非 warnings）让调用方一眼看出这条区间
 *                               被跳过了、为什么。
 *   - ★ D1（20260915）：摘要条目优先用覆盖该区间的官方 compaction/summary 事件里【模型写的
 *     那份】（kind:'model-summary'，事件真实字段见 normalizeSummaryEventDoc 头注；它就是
 *     替换节点里去掉官方英文前言/收尾标签后的中间段 = 我们的中文归档条目）。机械截断条目
 *     降级为兜底（kind:'mechanical'，行为与 D1 前逐字节一致）；覆盖不唯一 / 找不到 / 文本
 *     为空 / 超字节上限 ⇒ 回落 + warnings 如实记原因码（no-model-summary / ambiguous-coverage
 *     / model-summary-too-big），⛔ 不猜、不截断模型正文。事件经 deps.loadSummaryEvents 注入
 *     （HTTP 路径走 loadSummaryEventsViaHost 的便宜路径；不注入 = 路径不可用，plan 级 warning）。
 *   - ★ D4（20260915）：模型摘要末尾的 tags 行经 lib/ami-tags.js 校验收编成扁平枚举数组，
 *     随 summary.meta 进索引条目（白名单在 A1 buildIndexDoc）；没给/给错 ⇒ 空数组 + warning。
 *   - 落库只经 A1 的 lib/collect.js（planCollect/applyCollect/createTavernClient），
 *     通过 deps.collect 注入；lib/index.js 的路由 handler 里动态 import 并适配。
 *     ⛔ 本模块不修改 A1 的任何文件。
 *   - ★ 命名口径：本模块对外的 planHash（'scanplan-<16hex>'）是【规划指纹】，⛔ 不是可消费的
 *     plan token；落库走 /collect/auto，它自己重扫。与 /collect/plan 的 planId（A1 的
 *     一次性令牌、dryRun:true 时为 null、apply 即焚）语义不同，别混用。
 *
 * 隐私铁律：本文件任何输出（HTTP 响应 / 台账 / 日志）都不含会话正文、标题、角色卡内容，
 * 只有长度/哈希/seq 号/路径/非空判定。
 */
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { extractTagsLine, validateTags, flattenTags } from './ami-tags.js'

/** 阈值冻结：region 楼数上限 / 摘要总长上限 / 摘要每楼截断。 */
export const scanConstants = Object.freeze({
  maxFloorsPerRegion: 200,
  regionSummaryChars: 2000,
  regionSummaryPerFloor: 80,
})

/** 模型摘要正文的字节上限（与 A1 单文件上限同口径；超限视为不可用，回落机械条目，⛔ 不截断模型正文）。 */
const MODEL_SUMMARY_MAX_BYTES = 1024 * 1024

const LEDGER_SCHEMA_VERSION = 1
const LEDGER_FILE_NAME = 'collect-ledger.json'
const PLAN_TTL_MS = 10 * 60 * 1000 // plan 有效期：过期 apply ⇒ COLLECT_PLAN_EXPIRED（410）
const FLOOR_TYPES = ['user/message', 'assistant/message'] // ★ 规则写死：只有这两类单独成楼
const FROM_SESSION_NAME = '（来自会话）' // ★ 恒定：不许塞 sessionId 或标题
const BODY_LIMIT = 64 * 1024 // 与 lib/index.js 的 BODY_LIMIT 同口径

function mkErr(code, message, extra) {
  const e = new Error(message)
  e.code = code
  if (extra) Object.assign(e, extra)
  return e
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// ---------------------------------------------------------------------------
// 纯函数：区间识别 / 哈希 / 摘要 / 楼映射
// ---------------------------------------------------------------------------

/**
 * Map<seq,{surface,text,type?}> → Region[]（纯函数）。
 * ★ 权威判据写死：只有 surface === 'shadowed' 的 seq 进 region（current / log-only /
 *   null 一律不并）。升序排好后连续段归一个 region，不连续即断开。
 */
export function findShadowRegions(bySeq) {
  if (!(bySeq instanceof Map)) return []
  const seqs = []
  for (const [seq, v] of bySeq) {
    if (typeof seq !== 'number' || !Number.isFinite(seq)) continue
    if (!isPlainObject(v) || v.surface !== 'shadowed') continue
    seqs.push(seq)
  }
  seqs.sort((a, b) => a - b)
  const regions = []
  let cur = null
  for (const seq of seqs) {
    const v = bySeq.get(seq)
    const doc = {
      seq,
      surface: 'shadowed',
      text: typeof v.text === 'string' ? v.text : '',
      type: typeof v.type === 'string' ? v.type : null,
    }
    if (cur && seq === cur.toSeq + 1) {
      cur.toSeq = seq
      cur.docs.push(doc)
    } else {
      cur = { regionId: '', fromSeq: seq, toSeq: seq, docs: [doc] }
      regions.push(cur)
    }
  }
  for (const r of regions) r.regionId = `region-${r.fromSeq}-${r.toSeq}`
  return regions
}

/**
 * ★ 口径（写死）：region.docs 数组顺序以 '\n' 拼接后 sha256（utf8）。findShadowRegions
 * 保证 docs 按 seq 升序 ⇒ 等价于任务书「按 seq 升序拼接」口径；空串参与拼接、缺 text
 * 当空串。哈希对数组顺序敏感：乱序数组得不同哈希（自检 2 锁死该性质）。
 */
export function regionContentHash(region) {
  const parts = ((region && Array.isArray(region.docs) ? region.docs : []) || []).map((d) =>
    isPlainObject(d) && typeof d.text === 'string' ? d.text : '',
  )
  return createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex')
}

/**
 * region → 楼（规则写死，别发挥）：
 *   - 只有 type ∈ {user/message, assistant/message} 单独成楼；is_user = type==='user/message'；
 *   - 其余类型（tool/result、assistant/chunk…）并进它前面那条楼的正文（'\n' 接），不单独成楼；
 *     开头还没有楼可并的内容不进 floors（仍参与 contentHash / chars）；
 *   - is_system 恒 false；name 恒 '（来自会话）'；
 *   - 楼号从 startFloor 起（调用方传「现有最大楼号 + 1」，目录不存在传 0）。
 * 返回 { floors, nextFloor }。
 */
export function mapRegionToFloors(region, startFloor = 0) {
  const base = Number.isFinite(startFloor) ? Math.floor(startFloor) : 0
  const floors = []
  let next = base
  for (const doc of (region && Array.isArray(region.docs) ? region.docs : []) || []) {
    const text = isPlainObject(doc) && typeof doc.text === 'string' ? doc.text : ''
    if (isPlainObject(doc) && FLOOR_TYPES.includes(doc.type)) {
      floors.push({
        floor: next,
        isUser: doc.type === 'user/message',
        isSystem: false,
        name: FROM_SESSION_NAME,
        text,
        fromSeq: doc.seq,
        toSeq: doc.seq,
      })
      next += 1
    } else if (floors.length > 0) {
      const prev = floors[floors.length - 1]
      prev.text = prev.text + '\n' + text
      prev.toSeq = isPlainObject(doc) ? doc.seq : prev.toSeq
    }
  }
  return { floors, nextFloor: next }
}

/**
 * region 的摘要文本（⛔ 不调 LLM）：由 region 内各楼正文截断而成 —— 每楼取前
 * regionSummaryPerFloor(80) 字、'\n' 连接、连着末尾后缀总长上限 regionSummaryChars(2000)，
 * 末尾追加「（合成/自动收纳，共 N 楼）」。返回 { text, floorCount }。
 * ★ D1 之后它的角色降级为**兜底**：仅当覆盖本区间的模型摘要不可用时才作为条目正文
 *   （行为与 D1 之前逐字节一致，见 selectModelSummary / planScan 内的回落路径）。
 */
export function buildRegionSummary(region, opts = {}) {
  const per = Math.max(1, Number.isFinite(opts.perFloorChars) ? opts.perFloorChars : scanConstants.regionSummaryPerFloor)
  const cap = Math.max(per, Number.isFinite(opts.maxChars) ? opts.maxChars : scanConstants.regionSummaryChars)
  const { floors } = mapRegionToFloors(region, 0)
  const suffix = `（合成/自动收纳，共 ${floors.length} 楼）`
  let joined = floors.map((f) => (typeof f.text === 'string' ? f.text : '').slice(0, per)).join('\n')
  if (joined.length + suffix.length > cap) joined = joined.slice(0, Math.max(0, cap - suffix.length))
  return { text: joined + suffix, floorCount: floors.length }
}

// ---------------------------------------------------------------------------
// 纯函数：compaction/summary 事件 → 模型摘要条目（D1）
//
// ★ 事件的真实形状（读的是官方 dsh-compaction-basic 产物源码 commitCompactionBody，
//   逐字字段名，不是猜的）：session.append("compaction/summary", {
//     compactionId, [sourceCommandId], summary, [rawOutput 及流式调用标记],
//     shadowedRange: { start, end }, shadowedSeqs: [...], shadowedTokenCount,
//     provider, model, [maxTokens], [usage] })
//   其中 summary = summarize() 返回的【文本块数组】[{type:'text',text},…]（安全纯文本拷贝）。
//
// ★ 取哪一份（任务书 §2.5 的回答）：替换节点正文 = 官方英文前言（CHECKPOINT_PREAMBLE，
//   在 frameSummary 里与 summarize() 钩子之外拼上，⛔ 不在事件里）+ 模型输出块 + 官方收尾
//   标签块。事件里的 summary 字段恰好就是【中间那份模型输出】= 我们的归档指令写出的中文
//   条目本身。⇒ 归档取事件 summary 块按 '\n' 连接的文本（通常只有一个块，连接不改变内容），
//   **不是**整个替换节点正文。rawOutput 是含非文本块的原始拷贝，不用它（summary 已是
//   官方过滤后的纯文本视图，即进入替换节点的那份）。
// ---------------------------------------------------------------------------

/**
 * 事件文档 → 归一化的摘要事件；不可用给 null（⛔ 不猜：缺关键字段就当没有这条）。
 * 兼容两种文档形状：宿主事件文档 {seq, type, data:{…}} 与扁平负载 {…}。
 */
export function normalizeSummaryEventDoc(doc) {
  if (!isPlainObject(doc)) return null
  if (typeof doc.type === 'string' && doc.type !== 'compaction/summary') return null
  const payload = isPlainObject(doc.data) ? doc.data : doc
  const seq = Number.isFinite(doc.seq) ? doc.seq : Number.isFinite(payload.seq) ? payload.seq : null
  // 覆盖 seq：优先 shadowedSeqs（逐字数组）；兜底 shadowedRange{start,end} 展开为闭区间
  // （官方两个字段都写；range 展开加上限，防异常大区间把内存吃穿）。
  let seqs = null
  if (Array.isArray(payload.shadowedSeqs)) {
    seqs = payload.shadowedSeqs.map(Number).filter((n) => Number.isFinite(n))
    if (seqs.length === 0) seqs = null
  }
  if (seqs === null && isPlainObject(payload.shadowedRange) &&
      Number.isFinite(payload.shadowedRange.start) && Number.isFinite(payload.shadowedRange.end)) {
    const from = Math.floor(payload.shadowedRange.start)
    const to = Math.floor(payload.shadowedRange.end)
    if (from >= 0 && to >= from && to - from + 1 <= 100000) {
      seqs = []
      for (let n = from; n <= to; n++) seqs.push(n)
    }
  }
  if (seqs === null) return null
  const text = summaryBlocksText(payload.summary)
  return {
    eventSeq: seq,
    compactionId: typeof payload.compactionId === 'string' && payload.compactionId !== '' ? payload.compactionId : null,
    provider: typeof payload.provider === 'string' && payload.provider !== '' ? payload.provider : null,
    model: typeof payload.model === 'string' && payload.model !== '' ? payload.model : null,
    shadowedTokenCount: Number.isFinite(payload.shadowedTokenCount) ? payload.shadowedTokenCount : null,
    shadowedSeqs: seqs,
    coverage: new Set(seqs),
    text,
  }
}

/** 事件的 summary 字段 → 正文文本：只收文本块，按 '\n' 连接；字符串原样；其它给 ''。 */
function summaryBlocksText(summary) {
  if (typeof summary === 'string') return summary
  if (!Array.isArray(summary)) return ''
  return summary
    .map((b) => (isPlainObject(b) && typeof b.text === 'string' && (b.type === undefined || b.type === 'text') ? b.text : ''))
    .filter((s) => s !== '')
    .join('\n')
}

/**
 * 覆盖判定：[fromSeq..toSeq] 的每个 seq 都在该事件的 shadowedSeqs 里 ⇒ 覆盖。
 * （区间是连续 seq 段；事件的历史覆盖面与当前 surface 状态可能不完全重合，
 *   因此只要求「区间被盖住」，不要求逐字节相等 —— 覆盖是否唯一由调用方数条数判。）
 */
export function findCoveringSummaryEvents(events, fromSeq, toSeq) {
  if (!Array.isArray(events)) return []
  const want = new Set()
  for (let n = fromSeq; n <= toSeq; n++) want.add(n)
  if (want.size === 0) return []
  return events.filter((e) => isPlainObject(e) && e.coverage instanceof Set && [...want].every((s) => e.coverage.has(s)))
}

/**
 * D1 选择器：region 的摘要条目用模型摘要还是机械兜底（⛔ 不猜：每一种回落都给原因码）。
 * 返回 { kind:'model-summary', text, meta } 或 { kind:'mechanical', reason }。
 * reason ∈ no-model-summary（找不到 / 文本为空）/ ambiguous-coverage（覆盖不唯一）/
 *           model-summary-too-big（超单文件字节上限，不截断模型正文）。
 */
export function selectModelSummary(events, region) {
  const covering = findCoveringSummaryEvents(events, region.fromSeq, region.toSeq)
  if (covering.length === 0) return { kind: 'mechanical', reason: 'no-model-summary' }
  if (covering.length > 1) return { kind: 'mechanical', reason: 'ambiguous-coverage', coveringCount: covering.length }
  const ev = covering[0]
  if (typeof ev.text !== 'string' || ev.text.trim() === '') return { kind: 'mechanical', reason: 'no-model-summary' }
  if (Buffer.byteLength(ev.text, 'utf8') > MODEL_SUMMARY_MAX_BYTES) return { kind: 'mechanical', reason: 'model-summary-too-big' }
  return {
    kind: 'model-summary',
    text: ev.text,
    meta: {
      kind: 'model-summary',
      compactionId: ev.compactionId,
      provider: ev.provider,
      model: ev.model,
      shadowedTokenCount: ev.shadowedTokenCount,
      eventSeq: ev.eventSeq,
    },
  }
}

// ---------------------------------------------------------------------------
// 台账（幂等的唯一依据）：只存哈希/计数/路径，绝不存正文
// ---------------------------------------------------------------------------

function pluginDirOf(dshHome) {
  return join(String(dshHome || ''), 'magictarven')
}

function ledgerPathOf(dshHome) {
  return join(pluginDirOf(dshHome), LEDGER_FILE_NAME)
}

function emptyLedger() {
  return { schemaVersion: LEDGER_SCHEMA_VERSION, regions: {} }
}

/** 台账文件是否「坏」＝存在但解析不出 {regions: 对象}。 */
function ledgerRawIsBad(raw) {
  try {
    const p = JSON.parse(raw)
    return !(isPlainObject(p) && isPlainObject(p.regions))
  } catch {
    return true
  }
}

function stampNow() {
  return new Date().toISOString().replace(/[^0-9TZ]/g, '') // Windows 文件名里不能有冒号
}

/**
 * 读台账：不存在 → 空台账 + null warning；读失败 / 损坏 → 空台账 + warning
 * （⛔ 不因此拒绝干活）。返回 { ledger, warning }。
 */
export function readLedger(dshHome) {
  let raw
  try {
    raw = readFileSync(ledgerPathOf(dshHome), 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ledger: emptyLedger(), warning: null }
    return { ledger: emptyLedger(), warning: `台账读取失败，按空台账继续：${String((e && e.message) || e).slice(0, 200)}` }
  }
  if (ledgerRawIsBad(raw)) {
    return { ledger: emptyLedger(), warning: '台账损坏（不是合法 JSON 或缺 regions 对象），按空台账继续；下次写入前会先把坏文件备份成 .bak-*' }
  }
  const parsed = JSON.parse(raw)
  return {
    ledger: {
      schemaVersion: typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : LEDGER_SCHEMA_VERSION,
      regions: parsed.regions,
    },
    warning: null,
  }
}

/**
 * 原子写台账（tmp → rename，0600）；目标位置已有坏文件时【先】把它备份成
 * .bak-<时间戳> 再覆盖（自检 6 锁死备份行为）。
 */
export function writeLedger(dshHome, ledger) {
  const dir = pluginDirOf(dshHome)
  mkdirSync(dir, { recursive: true })
  const finalPath = join(dir, LEDGER_FILE_NAME)
  try {
    const raw = readFileSync(finalPath, 'utf8')
    if (ledgerRawIsBad(raw)) copyFileSync(finalPath, join(dir, `${LEDGER_FILE_NAME}.bak-${stampNow()}`))
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      // 读都读不出来的文件没法备份，继续原子写覆盖（rename 保证不写半份）
    }
  }
  const norm = isPlainObject(ledger)
    ? {
        schemaVersion: typeof ledger.schemaVersion === 'number' ? ledger.schemaVersion : LEDGER_SCHEMA_VERSION,
        regions: isPlainObject(ledger.regions) ? ledger.regions : {},
      }
    : emptyLedger()
  const tmpPath = finalPath + '.tmp'
  writeFileSync(tmpPath, JSON.stringify(norm, null, 2) + '\n', 'utf8')
  try {
    chmodSync(tmpPath, 0o600)
  } catch {}
  renameSync(tmpPath, finalPath)
  try {
    chmodSync(finalPath, 0o600)
  } catch {}
  return { path: finalPath, schemaVersion: norm.schemaVersion, regions: Object.keys(norm.regions).length }
}

// ---------------------------------------------------------------------------
// planScan / applyScan
// ---------------------------------------------------------------------------

/**
 * 规划一次收纳（零写入）。
 *
 * input : { sessionId, target:{characterId,playthroughId}, expectedRevisions?,
 *           maxFloorsPerRegion?, dryRun? }
 * deps  : { loadSurfaces(sessionId) → Map<seq,{surface,text,type?}>,   // 宿主接线注入
 *           maxExistingFloor(target) → number|null,                    // null = 目录不存在
 *           collect: { planCollect(request) → subPlan, applyCollect(subPlan, opts) → result },
 *           dshHome: string }                                          // DSH 根（非插件子目录）
 *
 * subPlan 约定（A1 lib/collect.js 的真实签名，已对齐源码）：
 *   planCollect(input, { observed }) —— input = { target:{characterId,playthroughId},
 *     range:{fromFloor,toFloor}, floors:[{floor,isUser,isSystem,mes,name}],
 *     summary:{text,id}, overwrite:false, dryRun:false }；observed = { targetKnown,
 *     existingFloors:Set, floorShas:Map, index:{exists,doc,sha256}, manifest:{…} }
 *     （观察口径照抄 A1 handleCollectPlan：catalog → archive 目录 → 楼号 → index/manifest）。
 *   applyCollect(subPlan, { tavern }) —— 成功 { ok, written:[{path,bytes,sha256}],
 *     readBack:[…], warnings }；冲突抛 { code:'COLLECT_REVISION_CHANGED', conflicts }
 *     （409）；过期抛 COLLECT_PLAN_EXPIRED（410，planTtlMs 同为 10 分钟）。
 *   createTavernClient({ baseUrl }) + tavernBaseFromReq(req) —— 同源基址从 req 推。
 * 适配全部收在本文件底部的接线节（A1 若再改签名，只对齐那一处）。
 */
export async function planScan(input, deps) {
  const sessionId = input && input.sessionId
  const target = input && input.target
  if (typeof sessionId !== 'string' || sessionId === '' || !isPlainObject(target) ||
      typeof target.characterId !== 'string' || target.characterId === '' ||
      typeof target.playthroughId !== 'string' || target.playthroughId === '') {
    throw mkErr('SCAN_INVALID', '需要 sessionId 与 target:{characterId,playthroughId}（非空字符串）')
  }
  const maxFloorsPerRegion =
    Number.isFinite(input.maxFloorsPerRegion) && input.maxFloorsPerRegion >= 1
      ? Math.floor(input.maxFloorsPerRegion)
      : scanConstants.maxFloorsPerRegion
  if (!deps || typeof deps.loadSurfaces !== 'function' || typeof deps.maxExistingFloor !== 'function') {
    throw mkErr('SCAN_INVALID', 'deps 缺 loadSurfaces / maxExistingFloor')
  }
  if (!deps.collect || typeof deps.collect.planCollect !== 'function' || typeof deps.collect.applyCollect !== 'function') {
    throw mkErr('SCAN_COLLECT_BACKEND_MISSING', 'deps.collect 缺 planCollect / applyCollect（A1 lib/collect.js）')
  }

  const warnings = []
  let bySeq
  try {
    bySeq = await deps.loadSurfaces(sessionId)
  } catch (e) {
    throw mkErr('SCAN_SESSION_UNREADABLE', `会话不可读：${String((e && e.message) || e).slice(0, 200)}`)
  }
  if (!(bySeq instanceof Map)) throw mkErr('SCAN_SESSION_UNREADABLE', 'loadSurfaces 返回形状不识别（要 Map）')

  const { ledger, warning } = readLedger(deps.dshHome)
  if (warning) warnings.push(warning)

  const maxFloor = await deps.maxExistingFloor(target) // number|null（null = 目录不存在 ⇒ 0 起）
  let startFloor = typeof maxFloor === 'number' && Number.isFinite(maxFloor) ? Math.floor(maxFloor) + 1 : 0

  const regions = findShadowRegions(bySeq)
  const planRegions = []
  const skipped = []
  const willWrite = []
  const willUpdate = []
  const now = Date.now()

  // D1：装载 compaction/summary 事件（宿主半侧事件流里的官方字段，见 normalizeSummaryEventDoc
  // 头注）。deps.loadSummaryEvents 是**可选**依赖（旧调用方/部分自检台不注入）——不注入时
  // 模型摘要路径整体不可用，全部区间回落机械条目，并如实给一条 plan 级 warning（⛔ 不静默）。
  let summaryEvents = []
  const summaryEventsAvailable = typeof deps.loadSummaryEvents === 'function'
  if (summaryEventsAvailable) {
    try {
      const docs = await deps.loadSummaryEvents(sessionId)
      if (Array.isArray(docs)) summaryEvents = docs.map(normalizeSummaryEventDoc).filter(Boolean)
    } catch (e) {
      warnings.push(`compaction/summary 事件读取失败，全部区间回落机械条目：${String((e && e.message) || e).slice(0, 160)}`)
    }
  } else {
    warnings.push('deps.loadSummaryEvents 未注入：模型摘要路径不可用，全部区间回落机械条目（no-model-summary）')
  }

  for (const region of regions) {
    const contentHash = regionContentHash(region)
    const chars = region.docs.map((d) => d.text).join('\n').length
    // ★ alreadyArchived 只认台账 contentHash（不靠楼号猜）
    const alreadyArchived = Object.prototype.hasOwnProperty.call(ledger.regions, contentHash)
    const entry = { regionId: region.regionId, fromSeq: region.fromSeq, toSeq: region.toSeq, docCount: region.docs.length, chars, contentHash, alreadyArchived }
    if (alreadyArchived) {
      entry.skipped = { reason: 'already-archived' }
      skipped.push({ regionId: region.regionId, reason: 'already-archived' })
      planRegions.push(entry)
      continue
    }
    entry.floorCount = mapRegionToFloors(region, 0).floors.length
    if (entry.floorCount === 0) {
      entry.skipped = { reason: 'empty', code: 'COLLECT_REGION_EMPTY' }
      skipped.push({ regionId: region.regionId, reason: 'empty', code: 'COLLECT_REGION_EMPTY' })
      warnings.push(`region ${region.regionId} 没有可成楼的消息文档，已跳过`)
      planRegions.push(entry)
      continue
    }
    if (entry.floorCount > maxFloorsPerRegion) {
      entry.skipped = { reason: 'too-big', code: 'COLLECT_REGION_TOO_BIG' }
      skipped.push({ regionId: region.regionId, reason: 'too-big', code: 'COLLECT_REGION_TOO_BIG' })
      planRegions.push(entry)
      continue // 跳过它、继续处理别的 region（不许整单失败）
    }
    // A1 planCollect 校验 mes 非空 ⇒ 空 text 的楼在编号前剔除，并保持编号连续
    // （被剔除的是空内容，不丢任何正文；floorCount 以实际会写的楼数为准）。
    const kept = mapRegionToFloors(region, startFloor).floors.filter((f) => typeof f.text === 'string' && f.text !== '')
    if (kept.length === 0) {
      entry.floorCount = 0
      entry.skipped = { reason: 'empty', code: 'COLLECT_REGION_EMPTY' }
      skipped.push({ regionId: region.regionId, reason: 'empty', code: 'COLLECT_REGION_EMPTY' })
      warnings.push(`region ${region.regionId} 的消息文档全是空正文，已跳过`)
      planRegions.push(entry)
      continue
    }
    entry.floorCount = kept.length
    entry.floors = kept
    entry.floorFrom = kept[0].floor
    entry.floorTo = kept[kept.length - 1].floor
    startFloor = kept[kept.length - 1].floor + 1
    // D1：优先归档覆盖本区间的模型摘要（唯一覆盖 + 文本非空才用）；机械条目降级为兜底，
    // 每一种回落的原因都如实进 warnings（⛔ 不猜、不截断模型正文）。
    const sel = selectModelSummary(summaryEvents, region)
    if (sel.kind === 'model-summary') {
      // D4：模型正文末尾的 tags 行 → 结构化校验 → 扁平枚举数组（只含词表内的值）。
      // 模型没给 / 给错 ⇒ 空数组 + warning（⛔ 不编、不猜）。
      const extracted = extractTagsLine(sel.text)
      let tags = []
      if (extracted.found) {
        const verdict = validateTags(extracted.parsed)
        tags = flattenTags(verdict.tags)
        if (!verdict.ok) warnings.push(`region ${region.regionId} tags 有收编不进的值（已剔除），只归档词表内的部分（tags-partial）`)
      } else {
        warnings.push(`region ${region.regionId} 模型摘要没有可解析的 tags 行，tags 按空数组归档（tags-empty）`)
      }
      entry.summary = { text: sel.text, floorCount: entry.floorCount, kind: 'model-summary', meta: { ...sel.meta, tags } }
      entry.summaryKind = 'model-summary'
    } else {
      entry.summary = buildRegionSummary(region)
      entry.summaryKind = 'mechanical'
      entry.summaryFallback = sel.reason
      warnings.push(`region ${region.regionId} 模型摘要不可用（${sel.reason}），已按机械条目归档`)
    }
    const subPlan = await deps.collect.planCollect({
      characterId: target.characterId,
      playthroughId: target.playthroughId,
      floors: kept,
      summary: entry.summary,
      meta: { source: 'mt-collect-scan', regionId: region.regionId, contentHash, sessionId },
    })
    entry.collectPlan = subPlan
    for (const w of (subPlan && Array.isArray(subPlan.willWrite) ? subPlan.willWrite : [])) willWrite.push(w)
    for (const w of (subPlan && Array.isArray(subPlan.willUpdate) ? subPlan.willUpdate : [])) willUpdate.push(w)
    planRegions.push(entry)
  }

  // 台账 willUpdate 预告（只在有 region 会写时出现；真写发生在 applyScan 落库成功之后）
  const included = planRegions.filter((r) => !r.skipped)
  if (included.length > 0) {
    const preview = { schemaVersion: LEDGER_SCHEMA_VERSION, regions: { ...ledger.regions } }
    for (const r of included) {
      preview.regions[r.contentHash] = {
        archivedAt: new Date(now).toISOString(),
        target: { characterId: target.characterId, playthroughId: target.playthroughId },
        floorFrom: r.floorFrom,
        floorTo: r.floorTo,
        chars: r.chars,
        paths: (r.collectPlan && Array.isArray(r.collectPlan.willWrite) ? r.collectPlan.willWrite : []).map((w) => w.path),
      }
    }
    const json = JSON.stringify(preview, null, 2) + '\n'
    willUpdate.push({
      path: ledgerPathOf(deps.dshHome),
      bytes: Buffer.byteLength(json, 'utf8'),
      sha256: createHash('sha256').update(json, 'utf8').digest('hex'),
    })
  }

  const planHash =
    'scanplan-' +
    createHash('sha256')
      .update([sessionId, regions.map((r) => `${r.fromSeq}-${r.toSeq}`).join(','), String(now)].join('|'), 'utf8')
      .digest('hex')
      .slice(0, 16)
  if (input.dryRun === false) warnings.push('scan 端点只做规划，不落库；真正落库走 /collect/auto')

  return {
    planHash,
    createdAt: now,
    sessionId,
    target,
    expectedRevisions: isPlainObject(input.expectedRevisions) ? input.expectedRevisions : {},
    maxFloorsPerRegion,
    scanned: regions.length,
    regions: planRegions, // ★ 内部对象（含 floors/summary 正文）—— HTTP 响应前必须过 publicRegionOf
    willWrite,
    willUpdate,
    skipped,
    warnings,
  }
}

/**
 * 按计划落库（真正写 Archive 的唯一入口）。
 * deps: { collect:{applyCollect}, dshHome }
 * ★ 幂等铁闸：每个 region 落库前重查台账 contentHash —— 同一 plan 跑两遍，第二遍
 *   archived=0、write 调用次数不变（自检 5 锁死）。
 * ★ 台账只在 A1 落库成功之后才更新；部分成功只记实际写成的那部分并给 partial。
 */
export async function applyScan(plan, deps) {
  if (!isPlainObject(plan) || !Array.isArray(plan.regions) || typeof plan.planHash !== 'string') {
    throw mkErr('SCAN_INVALID', 'plan 形状不对（要 planScan 的返回值）')
  }
  if (!deps || typeof deps.dshHome !== 'string' || !deps.collect || typeof deps.collect.applyCollect !== 'function') {
    throw mkErr('SCAN_COLLECT_BACKEND_MISSING', 'deps 缺 collect.applyCollect / dshHome')
  }
  const age = Date.now() - (typeof plan.createdAt === 'number' ? plan.createdAt : 0)
  if (age > PLAN_TTL_MS) throw mkErr('COLLECT_PLAN_EXPIRED', 'plan 已过期，请重新发起 scan/auto')

  const { ledger, warning } = readLedger(deps.dshHome)
  const warnings = warning ? [warning] : []
  const skipped = []
  const written = []
  const readBack = []
  let archived = 0
  let failed = 0
  let ledgerDirty = false
  // ★ 调用方（HTTP body）传进来的 expectedRevisions 是**对当前磁盘状态的一次断言**。
  //   它只对本轮**第一个真正落库的区间**有效 —— 那之后磁盘状态就被我们自己改掉了，
  //   再拿它去核对别的区间必然假冲突。见下面 replanForRegion 的注释。
  const callerRevisions = isPlainObject(plan.expectedRevisions) ? plan.expectedRevisions : {}
  let callerRevisionsConsumed = false

  /**
   * ★★ 多区间 bug 修复（20260914）：
   * `planScan` 是在**扫描那一刻**为每个区间各算了一份 collectPlan，那份计划里的
   * `expectedRevisions` 记的是**当时的** index.json / manifest.json 修订值。
   * 而每个区间落库都会**追加索引 + 更新 manifest** ⇒ 从第 2 个区间起，
   * 它手里的快照已经过时，apply 的写前重核必然报 COLLECT_REVISION_CHANGED，
   * 结果是「一次真压缩产出 18 个区间，只有第 1 个落得下去」（2026-09-14 真沙箱实测）。
   *
   * 修法：**落库前为这个区间现取一次计划** —— `deps.collect.planCollect` 会重新观察 Tavern
   * 现状，于是拿到的是**刚刚新鲜**的修订值。区间里要写的楼层本身没变（还是 region.floors
   * 与 region.summary），变的是「写之前先核对谁」。
   * ⛔ 拿不到 planCollect（例如某些自检台的精简后端）时退回扫描时那份计划，行为与修复前一致。
   */
  const replanForRegion = async (region) => {
    const original = region.collectPlan
    if (typeof deps.collect.planCollect !== 'function') return original
    if (!Array.isArray(region.floors) || region.floors.length === 0) return original
    if (!isPlainObject(region.summary) || typeof region.summary.text !== 'string') return original
    try {
      const fresh = await deps.collect.planCollect({
        characterId: plan.target.characterId,
        playthroughId: plan.target.playthroughId,
        floors: region.floors,
        summary: region.summary,
      })
      return isPlainObject(fresh) ? fresh : original
    } catch (e) {
      // 现取计划失败（楼层已被别人占了 / 索引坏了 …）：如实记一条 warning，用原计划继续。
      // 真冲突会在下面的 apply 里以 COLLECT_REVISION_CHANGED / 别的码浮现，不在这里吞掉语义。
      warnings.push(`region ${region.regionId} 现取计划失败，退回扫描时那份：${String((e && e.message) || e).slice(0, 160)}`)
      return original
    }
  }

  for (const region of plan.regions) {
    if (region && region.skipped) {
      skipped.push(region.skipped.code ? { regionId: region.regionId, reason: region.skipped.reason, code: region.skipped.code } : { regionId: region.regionId, reason: region.skipped.reason })
      continue
    }
    if (!isPlainObject(region) || typeof region.contentHash !== 'string' || !region.contentHash) continue
    if (Object.prototype.hasOwnProperty.call(ledger.regions, region.contentHash)) {
      skipped.push({ regionId: region.regionId, reason: 'already-archived' })
      continue
    }
    let result
    try {
      // ★ 先现取计划（拿到新鲜修订值），再落库；调用方断言只喂给第一个真正落库的区间。
      const subPlan = await replanForRegion(region)
      const overrides = callerRevisionsConsumed ? {} : callerRevisions
      callerRevisionsConsumed = true
      result = await deps.collect.applyCollect(subPlan, { expectedRevisions: overrides })
    } catch (e) {
      if (e && (e.code === 'COLLECT_REVISION_CHANGED' || e.code === 'COLLECT_PLAN_EXPIRED')) {
        if (ledgerDirty) writeLedger(deps.dshHome, ledger) // 冲突前已落库的部分先记进台账
        throw e
      }
      failed += 1
      warnings.push(`region ${region.regionId} 落库失败：${String((e && e.message) || e).slice(0, 200)}`)
      continue
    }
    const paths = (result && Array.isArray(result.written) ? result.written : []).map((w) => (isPlainObject(w) ? w.path : String(w)))
    ledger.regions[region.contentHash] = {
      archivedAt: new Date().toISOString(),
      target: { characterId: plan.target.characterId, playthroughId: plan.target.playthroughId },
      floorFrom: region.floorFrom,
      floorTo: region.floorTo,
      chars: region.chars,
      paths,
    }
    ledgerDirty = true
    archived += 1
    for (const w of (result && Array.isArray(result.written) ? result.written : [])) written.push(w)
    for (const r of (result && Array.isArray(result.readBack) ? result.readBack : [])) readBack.push(r)
  }

  let ledgerUpdated = false
  if (ledgerDirty) {
    writeLedger(deps.dshHome, ledger)
    ledgerUpdated = true
  }
  /**
   * ★ 口径修正（20260914 实测）：A1 的 `applyCollect` 返回的 `written` **包含「被更新的目标」**
   * —— 每个区间落库都会更新一次 `summaries/index.json` 与 `manifest.json`。
   * 于是多区间时同一路径会被累加很多次（真机实测：16 个区间 ⇒ `written` 66 条，
   * 其中 index 16 次、manifest 16 次），调用方会误以为写了 66 个文件。
   * ⇒ 这里**按路径去重、保留最后一次**（最后一次就是最终状态，且 readBack 的意义与之一致）。
   * ⛔ 注意：这不是「重复写」的修复 —— 实测磁盘上每个文件只写了一次、`written` 里的路径
   *   全部存在于磁盘（`missing = 0`），仅仅是**报告口径**。
   */
  const dedupeByPath = (arr) => {
    const m = new Map()
    for (const x of arr) {
      const p = isPlainObject(x) && typeof x.path === 'string' ? x.path : String(x)
      m.set(p, x) // 后写覆盖先写 ⇒ 保留最后一次
    }
    return [...m.values()]
  }
  return {
    ok: true,
    planHash: plan.planHash,
    scanned: plan.scanned,
    archived,
    skipped,
    written: dedupeByPath(written),
    readBack: dedupeByPath(readBack),
    ledgerUpdated,
    partial: failed > 0 && archived > 0,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// 宿主接线（lib/index.js 的两条分派行调这里；本节是唯一碰 ctx / A1 的地方）
// ---------------------------------------------------------------------------

function expandHome(p, home = homedir()) {
  if (p === '~') return home
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2))
  return p
}

/** 照抄 lib/index.js storageDir() 的同源推导，但返回 DSH 根（台账函数自己再拼 magictarven）。 */
export function dshRootFromEnv(env = process.env) {
  const configured = env && env.DSH_HOME
  const dshHome =
    configured !== undefined && String(configured).trim() !== '' ? String(configured) : join(homedir(), '.dsh')
  return resolve(expandHome(dshHome))
}

async function importCollectBackend() {
  try {
    return await import('./collect.js')
  } catch (e) {
    throw mkErr('SCAN_COLLECT_BACKEND_MISSING', `collect.js（A1 落库后端）不可用：${String((e && e.message) || e).slice(0, 200)}`)
  }
}

/** 与 A1 同口径的 sha256 / JSON 解析（A1 的同名内部函数不导出，这里照抄语义）。 */
function sha256HexOf(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

function parseJsonOrNull(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 读不到给 null（404 = 不存在），其余错误照抛（照抄 A1 readIfExists）。 */
async function readIfExists(tavern, relPath) {
  try {
    return await tavern.read(relPath)
  } catch (e) {
    if (e && e.code === 'TAVERN_HTTP_404') return null
    throw e
  }
}

/** 照抄 A1 catalogTarget：catalog.json 的一条 playthrough → {characterId, playthroughId}。 */
function catalogTargetOf(pt) {
  if (!isPlainObject(pt)) return null
  const segs = (typeof pt.path === 'string' ? pt.path : '').split('/').filter(Boolean)
  if (segs.length < 3 || !segs[segs.length - 1].endsWith('.json')) return null
  const ext = isPlainObject(pt.ext) && isPlainObject(pt.ext.pmpDshTavern) ? pt.ext.pmpDshTavern : {}
  const characterId = typeof ext.characterId === 'string' && ext.characterId !== '' ? ext.characterId : segs[0]
  const playthroughId = segs[segs.length - 2]
  if (!characterId || !playthroughId) return null
  return { characterId, playthroughId }
}

/**
 * 照抄 A1 handleCollectPlan 的观察口径：catalog（targetKnown）→ archive 目录 →
 * 已有楼号（floorShas 只在 overwrite 时才需要，本写入器恒 overwrite:false，不取）→
 * index.json / manifest.json 的存在与指纹。catalog 缺失 = targetKnown:false；
 * catalog 坏 / Tavern 网络错误照抛（fail-closed，A1 会在 plan 阶段给出可读错误）。
 */
async function observeArchiveForCollect(tavern, characterId, playthroughId) {
  const observed = { targetKnown: false, existingFloors: new Set(), floorShas: new Map(), index: { exists: false }, manifest: { exists: false } }
  try {
    const catGot = await tavern.read('catalog.json')
    const catalog = parseJsonOrNull(catGot.content)
    const pts = isPlainObject(catalog) && Array.isArray(catalog.playthroughs) ? catalog.playthroughs : []
    observed.targetKnown = pts.some((pt) => {
      const t = catalogTargetOf(pt)
      return t !== null && t.characterId === characterId && t.playthroughId === playthroughId
    })
  } catch (e) {
    if (e && e.code !== 'TAVERN_HTTP_404') throw e
    return observed
  }
  if (!observed.targetKnown) return observed
  const archiveRel = characterId + '/' + playthroughId + '/archive'
  let archiveExists = false
  try {
    const lst = await tavern.list(archiveRel)
    archiveExists = Array.isArray(lst.list) && lst.list.length > 0
  } catch {}
  if (!archiveExists) return observed
  try {
    const fl = await tavern.list(archiveRel + '/floors')
    for (const x of fl.list) {
      if (!isPlainObject(x) || x.type !== 'file') continue
      const m = /(\d{4,})\.json$/.exec(String(x.path || '').split('/').pop() || '')
      if (m) observed.existingFloors.add(Number(m[1]))
    }
  } catch {}
  const ix = await readIfExists(tavern, archiveRel + '/summaries/index.json')
  if (ix !== null) observed.index = { exists: true, doc: parseJsonOrNull(ix.content), sha256: sha256HexOf(ix.content) }
  const mf = await readIfExists(tavern, archiveRel + '/manifest.json')
  if (mf !== null) observed.manifest = { exists: true, doc: parseJsonOrNull(mf.content), sha256: sha256HexOf(mf.content) }
  return observed
}

/** 楼号起点用的「现有最大楼号」：archive/floors 目录列表里 NNNN.json 的最大 N；目录不存在 ⇒ null。 */
function maxFloorOfListing(list) {
  let max = null
  for (const x of Array.isArray(list) ? list : []) {
    if (!isPlainObject(x) || x.type !== 'file') continue
    const m = /(\d{4,})\.json$/.exec(String(x.path || '').split('/').pop() || '')
    if (m) {
      const n = Number(m[1])
      if (max === null || n > max) max = n
    }
  }
  return max
}

/** A1 的同源 Tavern client：基址从当前 HTTP 请求推（照抄 A1 makeTavern 的默认分支）。 */
function makeA1Tavern(backend, req) {
  if (typeof backend.createTavernClient !== 'function' || typeof backend.tavernBaseFromReq !== 'function') {
    throw mkErr('SCAN_COLLECT_INCOMPATIBLE', 'collect.js 未导出 createTavernClient / tavernBaseFromReq')
  }
  return backend.createTavernClient({ baseUrl: backend.tavernBaseFromReq(req) })
}

/** 楼号起点 = GET ?list=<archiveRel>/floors 现有最大楼号（404 = 目录不存在 ⇒ null ⇒ 从 0 起）。 */
async function tavernMaxExistingFloor(req, target) {
  const backend = await importCollectBackend()
  const tavern = makeA1Tavern(backend, req)
  try {
    const lst = await tavern.list(target.characterId + '/' + target.playthroughId + '/archive/floors')
    return maxFloorOfListing(lst.list)
  } catch (e) {
    if (e && e.code === 'TAVERN_HTTP_404') return null
    throw e
  }
}

/** A1 summary.id 缺省 s-<from>-<to>，这里加 mt- 前缀标明来源（只允许 [A-Za-z0-9._-]）。 */
function summaryIdFor(floors) {
  return 'mt-' + String(floors[0].floor).padStart(4, '0') + '-' + String(floors[floors.length - 1].floor).padStart(4, '0')
}

/**
 * 会话面装载：surface 判定只认注入进来的宿主 collectSurfaces（便宜路径 filterEvents）；
 * type 供切楼用，另走一次同款便宜路径补齐（collectSurfaces 的返回不带 type）。
 * 空 Map 时用一次精确读探会话存在性，区分「真空会话」与「不可读」。
 */
async function loadSurfacesViaHost(sq, collectSurfaces, sessionId) {
  const bySeq = await collectSurfaces(sq, sessionId)
  if (!(bySeq instanceof Map)) throw mkErr('SCAN_SESSION_UNREADABLE', 'collectSurfaces 返回形状不识别')
  if (bySeq.size === 0) {
    let probe = null
    try {
      probe = await sq.readSession(sessionId)
    } catch {}
    if (!probe) throw mkErr('SCAN_SESSION_UNREADABLE', '会话不可读或不存在（精确读失败/为空）')
  }
  const typeBySeq = new Map()
  const grab = (arr) => {
    for (const d of arr) {
      if (isPlainObject(d) && typeof d.seq === 'number' && Number.isFinite(d.seq) && typeof d.type === 'string') {
        typeBySeq.set(d.seq, d.type)
      }
    }
  }
  try {
    if (typeof sq.filterEvents === 'function') {
      const docs = await sq.filterEvents(sessionId, [])
      const arr = Array.isArray(docs) ? docs : isPlainObject(docs) && Array.isArray(docs.documents) ? docs.documents : null
      if (arr) grab(arr)
    }
  } catch {}
  if (typeBySeq.size === 0) {
    try {
      if (typeof sq.listEvents === 'function') {
        const recs = await sq.listEvents(sessionId)
        const arr = Array.isArray(recs) ? recs : isPlainObject(recs) && Array.isArray(recs.events) ? recs.events : null
        if (arr) grab(arr)
      }
    } catch {}
  }
  for (const [seq, v] of bySeq) {
    if (isPlainObject(v) && v.type === undefined) v.type = typeBySeq.get(seq) ?? null
  }
  return bySeq
}

/**
 * D1：compaction/summary 事件装载（与 collectSurfaces 同一条便宜路径，⛔ 不用全量对账）。
 * filterEvents 空过滤返回全部 document（带 type 与负载），从里挑 type === 'compaction/summary'
 * 的原文档返回；负载的归一化（shadowedSeqs / summary 块数组 → 文本）统一在 planScan 里做。
 * 便宜路径不可用 / 抛错 ⇒ 返回 []（上层按 no-model-summary 回落，绝不猜、绝不抛）。
 */
async function loadSummaryEventsViaHost(sq, sessionId) {
  if (typeof sq.filterEvents !== 'function') return []
  try {
    const docs = await sq.filterEvents(sessionId, [])
    const arr = Array.isArray(docs) ? docs : isPlainObject(docs) && Array.isArray(docs.documents) ? docs.documents : null
    if (!arr) return []
    return arr.filter((d) => isPlainObject(d) && d.type === 'compaction/summary')
  } catch {
    return []
  }
}

/** HTTP 响应里的 region：只留元数据（⛔ floors/summary 正文与 collectPlan 不出网）。 */
function publicRegionOf(r) {
  return {
    regionId: r.regionId,
    fromSeq: r.fromSeq,
    toSeq: r.toSeq,
    docCount: r.docCount,
    floorCount: r.floorCount,
    chars: r.chars,
    contentHash: r.contentHash,
    alreadyArchived: r.alreadyArchived,
    summaryKind: r.summaryKind, // D1：model-summary | mechanical（机械兜底时不带正文，只带事实）
    summaryFallback: r.summaryFallback, // D1：机械兜底原因码（仅 mechanical 时存在）
  }
}

function statusOf(code) {
  if (code === 'SCAN_INVALID' || code === 'SCAN_SESSION_UNREADABLE') return 400
  if (code === 'COLLECT_REVISION_CHANGED') return 409
  if (code === 'COLLECT_PLAN_EXPIRED') return 410
  if (code === 'SCAN_COLLECT_BACKEND_MISSING' || code === 'SESSION_QUERY_UNAVAILABLE') return 503
  if (typeof code === 'string' && code.startsWith('COLLECT_')) return 400 // A1 后端给出的可读错误
  return 500
}

function errBodyOf(e) {
  const code = (e && e.code) || 'SCAN_INTERNAL'
  const error = { code, message: String((e && e.message) || e).slice(0, 300) }
  if (code === 'COLLECT_REVISION_CHANGED') error.conflicts = Array.isArray(e && e.conflicts) ? e.conflicts : []
  return { ok: false, error }
}

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > BODY_LIMIT) throw mkErr('PAYLOAD_TOO_LARGE', `请求体超过 ${BODY_LIMIT} 字节上限`)
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw mkErr('SCAN_INVALID', '请求体不是合法 JSON')
  }
}

/**
 * 一次归档运行的**内核（无 req）**—— HTTP 端点（`/collect/scan`·`/collect/auto`）与
 * **压缩后自动触发**（lib/index.js 的轮末钩子）共用这一份实现，⛔ 不复制第二份。
 *
 * @param opts.base  Tavern 基址。HTTP 路径从 req 的 Host 头推；自动触发那条路没有 req，
 *                   用 `http://127.0.0.1:<webServer.port>`（host/webserver 的 `port`
 *                   getter 就是实际监听端口）。内部把它包成一个**合成 req**，因为
 *                   A1 的 `tavernBaseFromReq` 只读 `req.headers.host` / `req.socket.localPort`
 *                   —— 这样两处适配器（makeA1Tavern / tavernMaxExistingFloor）一行都不用改。
 * @returns `{ kind:'plan', plan }`（auto=false）或 `{ kind:'result', plan, result }`（auto=true）
 * @throws 带 code 的错误（调用方自己决定 HTTP 状态或怎么播报）
 */
export async function collectOnce(ctx, opts = {}) {
  const { sessionId, target, auto, base, dshHome: dshHomeIn, collectSurfaces, expectedRevisions, maxFloorsPerRegion: maxFloors } = opts
  if (typeof sessionId !== 'string' || sessionId === '' || !isPlainObject(target) ||
      typeof target.characterId !== 'string' || target.characterId === '' ||
      typeof target.playthroughId !== 'string' || target.playthroughId === '') {
    throw mkErr('SCAN_INVALID', '需要 sessionId 与 target:{characterId,playthroughId}（非空字符串）')
  }
  const sq = ctx && typeof ctx.get === 'function' ? ctx.get('sessionQuery') : null
  if (!sq) throw mkErr('SESSION_QUERY_UNAVAILABLE', '宿主未挂载 sessionQuery')
  const reqLike = typeof base === 'string' && base !== ''
    ? { headers: { host: base.replace(/^https?:\/\//, '') } }
    : null
  const dshHome = typeof dshHomeIn === 'string' && dshHomeIn !== '' ? dshHomeIn : dshRootFromEnv()
  const deps = {
    dshHome,
    loadSurfaces: (sid) => loadSurfacesViaHost(sq, collectSurfaces, sid),
    // D1：compaction/summary 事件装载 —— 与 collectSurfaces 同一条便宜路径（filterEvents
    // 空过滤 = 全量 document，带 type 与负载）；拿不到就如实给空数组，上层按 no-model-summary 回落。
    loadSummaryEvents: (sid) => loadSummaryEventsViaHost(sq, sid),
    maxExistingFloor: (t) => tavernMaxExistingFloor(reqLike, t),
    collect: {
      // 我方内部契约（planScan/applyScan 用）：planCollect(request) / applyCollect(subPlan, opts)。
      // 这里适配到 A1 lib/collect.js 的真实签名（planCollect(input, {observed}) / applyCollect(plan, {tavern})）。
      planCollect: async (request) => {
        const backend = await importCollectBackend()
        const tavern = makeA1Tavern(backend, reqLike)
        const observed = await observeArchiveForCollect(tavern, request.characterId, request.playthroughId)
        const floors = request.floors.map((f) => ({
          floor: f.floor,
          isUser: f.isUser === true,
          isSystem: f.isSystem === true,
          mes: typeof f.text === 'string' ? f.text : '',
          name: typeof f.name === 'string' ? f.name : '',
        }))
        const meta = isPlainObject(request.summary) && isPlainObject(request.summary.meta) ? request.summary.meta : null
        return backend.planCollect(
          {
            target: { characterId: request.characterId, playthroughId: request.playthroughId },
            range: { fromFloor: floors[0].floor, toFloor: floors[floors.length - 1].floor },
            floors,
            summary: {
              text: request.summary.text,
              id: summaryIdFor(floors),
              // D1：模型摘要的 model 记进索引既有 model 字段；meta 原样带过去（A1 侧白名单收编）
              model: meta !== null && typeof meta.model === 'string' && meta.model !== '' ? meta.model : undefined,
              meta,
            },
            overwrite: false,
            dryRun: false,
          },
          { observed },
        )
      },
      applyCollect: async (subPlan, applyOpts) => {
        const backend = await importCollectBackend()
        const tavern = makeA1Tavern(backend, reqLike)
        let plan = subPlan
        // 调用方的 expectedRevisions 覆盖（合并规则照抄 A1 handleCollectApply：只收 null/字符串）
        if (applyOpts && isPlainObject(applyOpts.expectedRevisions) && isPlainObject(subPlan) && isPlainObject(subPlan.expectedRevisions)) {
          const merged = { ...subPlan.expectedRevisions }
          for (const [k, v] of Object.entries(applyOpts.expectedRevisions)) {
            if (v === null || typeof v === 'string') merged[k] = v
          }
          plan = { ...subPlan, expectedRevisions: merged }
        }
        return backend.applyCollect(plan, { tavern })
      },
    },
  }
  const plan = await planScan(
    {
      sessionId,
      target,
      expectedRevisions,
      maxFloorsPerRegion: maxFloors,
      dryRun: auto !== true,
    },
    deps,
  )
  if (auto !== true) return { kind: 'plan', plan }
  const result = await applyScan(plan, { dshHome, collect: deps.collect })
  return { kind: 'result', plan, result }
}

async function runCollectRoute(ctx, req, send, log, collectSurfaces, auto) {
  try {
    const body = await readJsonBody(req)
    const sessionId = body && body.sessionId
    const target = body && body.target
    if (typeof sessionId !== 'string' || sessionId === '' || !isPlainObject(target) ||
        typeof target.characterId !== 'string' || target.characterId === '' ||
        typeof target.playthroughId !== 'string' || target.playthroughId === '') {
      return send(400, errBodyOf(mkErr('SCAN_INVALID', '需要 sessionId 与 target:{characterId,playthroughId}（非空字符串）')))
    }
    const sq = ctx && typeof ctx.get === 'function' ? ctx.get('sessionQuery') : null
    if (!sq) return send(503, errBodyOf(mkErr('SESSION_QUERY_UNAVAILABLE', '宿主未挂载 sessionQuery')))
    const dshHome = dshRootFromEnv()
    const out = await collectOnce(ctx, {
      sessionId,
      target,
      auto: auto === true,
      collectSurfaces,
      expectedRevisions: body && body.expectedRevisions,
      maxFloorsPerRegion: body && body.maxFloorsPerRegion,
    })
    if (out.kind === 'plan') {
      const plan = out.plan
      return send(200, {
        ok: true,
        planHash: plan.planHash,
        sessionId: plan.sessionId,
        regions: plan.regions.map(publicRegionOf),
        willWrite: plan.willWrite,
        willUpdate: plan.willUpdate,
        skipped: plan.skipped,
        warnings: plan.warnings,
      })
    }
    const result = out.result
    return send(200, {
      ok: true,
      planHash: result.planHash,
      scanned: result.scanned,
      archived: result.archived,
      skipped: result.skipped,
      written: result.written,
      readBack: result.readBack,
      ledgerUpdated: result.ledgerUpdated,
      partial: result.partial,
      warnings: result.warnings,
    })
  } catch (e) {
    const code = (e && e.code) || 'SCAN_INTERNAL'
    try {
      if (log && typeof log.warn === 'function') log.warn(`[mt] collect/${auto ? 'auto' : 'scan'} 失败：${code}`)
    } catch {}
    return send(statusOf(code), errBodyOf(e))
  }
}

/** POST /magictarven/api/collect/scan —— 只规划不落库（dryRun 语义固定为 plan-only）。 */
export async function handleCollectScan(ctx, req, send, log, collectSurfaces) {
  return runCollectRoute(ctx, req, send, log, collectSurfaces, false)
}

/** POST /magictarven/api/collect/auto —— 规划 + 落库 + 记台账（幂等）。 */
export async function handleCollectAuto(ctx, req, send, log, collectSurfaces) {
  return runCollectRoute(ctx, req, send, log, collectSurfaces, true)
}
