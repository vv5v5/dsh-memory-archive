/**
 * collect-scan（A2）—— 压缩联动的自动收纳：把**被压缩替换掉的那些内容**收进周目归档。
 *
 * 设计决定（不改压缩后端，别自己改回去）：
 *   - 遮蔽已由官方 compaction 做完（真机实证单会话 752 篇 shadowed）⇒ 本模块只做
 *     「把已被压出去的内容事后收进归档」，不拦压缩、不碰 mt-compaction.js（生成器，
 *     生成物只依赖 推理/tokenMeter/sessions 三个服务名的既有契约，不许被 IO 破坏）。
 *   - append-only 日志是真相源 ⇒ 事后扫描不会丢内容，不需要 fail-closed。
 *   - 事件读取只认宿主注入的**原始事件**装载器 deps.loadRawEvents（lib/index.js 的路由分派行
 *     注入的 loadSessionLog 包装，本模块不重造、不自己读盘）；⛔ 禁 searchSessions/searchEvents
 *     （全量对账 88s/2GB）。⚠️ 宿主那条便宜的 `collectSurfaces`（filterEvents 文档）**不再是**
 *     本模块的数据来源 —— 它的文档结构上没有 `data`（见 rawEventsViaHost 头注）。
 *   - 台账 <DSH_HOME>/magictarven/collect-ledger.json 是幂等唯一依据：★ 只存哈希/计数/
 *     路径，绝不存正文。alreadyArchived 只来自台账 contentHash（不靠楼号猜）。
 *   - skipped.reason 完整枚举（planScan/applyScan 返回的 skipped 数组，含义如下）：
 *       'already-archived' —— 该 region 的 contentHash 已在台账里（幂等跳过，不重写）；
 *       'too-big'          —— region 楼数超过 maxFloorsPerRegion，跳过它、其余 region 照常；
 *       'empty'            —— region 里一条 user/message / assistant/message 都没有（如纯
 *                               tool/result 的遮蔽段），或消息文档全为空正文：本就不该落成
 *                               楼层，放 skipped（而非 warnings）让调用方一眼看出这条区间
 *                               被跳过了、为什么。
 *   - ★★ 2026-09-22「一次压缩一段」（用户口径：「内容切割问题，摘要收纳的直接是聊天记录，原文更是
 *     全部都有」）：区间分段判据 = 会话日志里的**替换事件**（compaction/summary / compaction/prune），
 *     **一条替换 = 一个区间**，区间的 seq 集合就是它自己的 shadowedSeqs（**面顺序**，⛔ 不是数字区间
 *     —— 见 findShadowRegionsFromEvents 头注）。原始事件经 deps.loadRawEvents 注入
 *     （lib/index.js 的 loadSessionLog：活注册表 → 宿主持久化 → readSession 退路）。
 *     ⛔ 旧的「seq 相邻即归一段」判据已废（真机实测：一次压缩 shadowedSeqs 266 个、min 9/max 1068，
 *     被它切成 208 段 ⇒ 147 条 80 字机械截断桩 + 44 条 agent 机制楼混进归档）。
 *   - ★ 摘要条目 = **那次压缩自己的模型摘要**：区间 → 它对应的那条 compaction/summary → data.summary
 *     （ContentBlock[] 取文本块）⇒ kind:'model-summary'。⛔ 机械兜底不是常态：只有 prune 区间
 *     （官方那一段本来就没有摘要）/ 摘要文本为空 / 超字节上限 / 判成指令回声才回落（kind:'mechanical'），
 *     原因码枚举不变：no-model-summary / ambiguous-coverage / model-summary-too-big / prompt-echo。
 *   - ★★ 2026-09-22 第二条（用户口径「摘要里显示的直接是 json」「tag 做一下标签化」）：那份模型摘要
 *     本身是**结构化 JSON**（[{"summary":散文,"tags":{vibe,special,important}},…]）⇒ 归档前先
 *     **美化**（正文 = 各段 summary 散文按 '\n' 连接，⛔ JSON 外壳与元信息头一个都不落）+
 *     **标签化**（各段 tags 对象逐个词表收编 ⇒ 段级 tags；各段并集只作区间视图）。解析不出结构化条目
 *     时**fail-open**（正文照旧用模型原文，⛔ 不丢、⛔ 不回落机械）并如实播报。见 beautifyModelSummary。
 *   - ★★ 2026-09-22 第三条「摘要按段切片」（用户口径：「摘要没做切分吗，我看到是一大段一条。但内部
 *     是有分段的。这回影响向量检索吗」—— **影响**：检索的粒度就是「一个摘要文件 = 一条切片」，
 *     anima 入库时整文件一条、⛔ 入库侧不切块）：结构化那一路**一个叙事段 = 一条摘要条目**
 *     —— 一条 `.md` + `index.json` 一条 entry，每段带**它自己的** tags（不是并集）；
 *     一次调用只把楼层写一遍（走 A1 的追加式 `summaries`，id = `mt-<from4>-<to4>-<N>`，
 *     **多段一律带后缀 / 只有一段时不带**）。机械兜底（prune）与 fail-open（解析不出的整篇原文）
 *     **没有"段"可分 ⇒ 照旧一条**（⛔ 不硬造分段）。字节上限**逐段各自判**（某段超限只有那一段
 *     回落机械条目 + 播报 model-summary-too-big，⛔ 区间级那条旧判据已退役）。见 planScan
 *     与 selectModelSummary.segments。
 *   - ★「楼」只收**真对话**，判据一律走**事件结构**（⛔ 不许用文本前缀或正则猜）：见 mapRegionToFloors
 *     的三条排除（压缩的替换节点 / 插件注入的 user 消息 / 工具事件）。
 *   - ★ D1（20260915）：模型摘要优先归档、机械条目降级为兜底 —— 口径不变，只是摘要的取法从
 *     「另走一次 filterEvents 找覆盖该区间的事件」改成「区间自带的那条替换事件」。
 *   - ★ D4（20260915，2026-09-22 扩成两条路）：tags 经 lib/ami-tags.js 的词表收编成扁平枚举数组，
 *     随 summary.meta 进索引条目（白名单在 A1 buildIndexDoc）。**优先结构化**：模型按指令回的是
 *     `[{"summary":…,"tags":{vibe,special,important}},…]`，就把各段的 tags 对象逐个 validateTags →
 *     flattenTags（★ 2026-09-22 第三条起：**按段分开**，并集只作区间视图与播报）；**兜底**才是老路
 *     extractTagsLine（正文末尾的 `tags:` 行，模型输出不是结构化 JSON 时用）。收编不进的如实播报
 *     （tags-partial / tags-empty）。
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
import { extractJson, normalizeSummaryItem, parseSummaryOutput } from './summarize.js'

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
// ★★ 2026-09-22「一次压缩一段」的三个结构性判据（全是**事件类型/来源**，⛔ 不猜文本）：
//   REPLACEMENT_TYPES —— 压缩的**替换事件**：一条 = 一个区间（官方 types.ts 的 compaction/summary
//     与 compaction/prune 都自带 shadowedSeqs；prune 没有 summary）。
//   TOOL_TYPES —— 工具事件：不是对话，⛔ 既不单独成楼、也不许把正文并进前一条楼。
//   PLAYER_SOURCE_KIND —— `user/message` 的 `data.source.kind` 里唯一算"玩家自己说的"的取值
//     （真机三种：'user'=玩家 / 'plugin'=插件注入 / 'skill-catalog'=技能目录注入，见 lib/prompt-viewer.js）。
const REPLACEMENT_TYPES = ['compaction/summary', 'compaction/prune']
const TOOL_TYPES = ['tool/call', 'tool/result']
const PLAYER_SOURCE_KIND = 'user'
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
 * 一条原始事件 → 归档用的正文（**只取文本块**，⛔ 不渲染工具调用/思维链、⛔ 不猜前缀）。
 * 形状照 lib/prompt-viewer.js 的真机实测口径：`user/message` 的正文在 `data.content`，
 * `assistant/message` / `tool/*` 的在 `data.message.content`；两者都是 ContentBlock[]（或纯字符串）。
 * 取不到 ⇒ ''（如实为空，不编）。
 */
function eventTextOf(ev) {
  const d = isPlainObject(ev) && isPlainObject(ev.data) ? ev.data : null
  if (d === null) return ''
  const cands = [isPlainObject(d.message) ? d.message.content : undefined, d.content]
  for (const c of cands) {
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      const parts = []
      for (const b of c) {
        if (!isPlainObject(b)) continue
        if (b.type !== undefined && b.type !== 'text') continue // 思维链 / 工具调用块一律不取
        if (typeof b.text === 'string') parts.push(b.text)
      }
      return parts.join('')
    }
  }
  return ''
}

/**
 * 一条原始事件 → `source.kind`（三种形状都认；取不到 ⇒ null，⛔ 不猜）。
 * 喂的是**带 data 的原始事件**（loadSessionLog）—— 这正是旧守卫失效的那一环（派单任务书 §1-⑤）：
 * 便宜路径 filterEvents 给的是 `{sessionId,seq,type,time,surface,text}`（结构上没有 data），
 * 于是 `sourceKindOf` 恒 null、插件注入守卫**永不触发**。
 */
function sourceKindOf(ev) {
  const d = isPlainObject(ev) && isPlainObject(ev.data) ? ev.data : null
  const cands = [
    d !== null && isPlainObject(d.source) ? d.source.kind : undefined,
    d !== null && isPlainObject(d.message) && isPlainObject(d.message.source) ? d.message.source.kind : undefined,
    isPlainObject(ev) && isPlainObject(ev.source) ? ev.source.kind : undefined,
  ]
  for (const c of cands) if (typeof c === 'string') return c
  return null
}

/**
 * 这条 `user/message` 是不是**插件注入**（不是玩家说的）。
 * ★ 判据是**结构性**的 `data.source.kind`，⛔ 不是文本前缀、⛔ 不是正则：真机三种取值里只有
 *   `'user'` 是玩家自己发的，其余（'plugin' 运行上下文快照/后处理提示词、'skill-catalog' 技能清单）
 *   都是注入 ⇒ 不是对话。
 * ⚠️ kind 缺失 / 拿不到（老日志 / 结构变了）⇒ **照旧当玩家消息**：那可能是真玩家发言，
 *   ⛔ 不许因为"认不出"就把它丢掉（宁可留下可疑的，也不静默丢真消息）。
 */
function isInjectedUserMessage(doc) {
  return isPlainObject(doc) && doc.type === 'user/message'
    && typeof doc.sourceKind === 'string' && doc.sourceKind !== PLAYER_SOURCE_KIND
}

/** 原始事件 → 归档侧的一条文档（正文/来源/是否替换节点都在这里定性，⛔ 不留到楼映射里猜）。 */
function docOfEvent(ev, prevType) {
  return {
    seq: ev.seq,
    surface: typeof ev.surface === 'string' ? ev.surface : null,
    type: typeof ev.type === 'string' ? ev.type : null,
    text: eventTextOf(ev),
    sourceKind: sourceKindOf(ev),
    // ★ 压缩的**替换节点**：紧跟在 compaction/summary|prune **之后**的那条 `user/message`
    //   —— 官方 types.ts:26-32 明写"真正的面替换由紧随其后的一条 user/message 完成，That adjacency
    //   is contractual" ⇒ 它是官方英文 checkpoint 前言，**不是玩家消息**（真机楼 0208 就是它）。
    replacementNode: ev.type === 'user/message' && REPLACEMENT_TYPES.includes(String(prevType)),
  }
}

/**
 * 原始会话事件（带 data 的 SessionEvent[]）→ Region[]（纯函数）。
 *
 * ★★ 2026-09-22 分段判据（唯一一条，别加第二条）：**一条替换事件 = 一个区间**。
 *   替换事件 = `compaction/summary` / `compaction/prune`（官方两种），它们**自带** `shadowedSeqs`
 *   —— 被遮蔽节点的**权威集合**，且按**面顺序**排列（types.ts:107-117 逐字：shadowedRange 是
 *   「面位置跨度」不是数字 seq 区间，`start` 可能大于 `end`；权威集合只看 shadowedSeqs）。
 *   ⇒ 区间的 seq 集合 = 该事件自己的 shadowedSeqs，顺序照抄（⛔ 不排序）。
 *
 * ⛔ 两条被明令禁掉的写法（反证锚点见 `_selftest-collect-scan.mjs` §13）：
 *   ① 旧判据「`seq === cur.toSeq + 1` 即归一段」（真机把一次压缩切成 208 段）；
 *   ② 把 shadowedSeqs **排序后切相邻段**（它是面顺序，不是数字区间）。
 *
 * `fromSeq` / `toSeq` = 该区间的**数字跨度**（min/max，只用于 regionId 与展示）；
 * `docs` 的顺序 = **面顺序**（权威，⛔ 别拿 fromSeq/toSeq 去推 docs 的顺序）。
 * 找不到对应事件的 seq 如实计数（`missingDocCount`），⛔ 不编造文档。
 */
export function findShadowRegionsFromEvents(events) {
  if (!Array.isArray(events)) return []
  const bySeq = new Map() // seq → 原始事件（同 seq 重复出现 ⇒ 以最后一条为准：后写的是更新的事实）
  const prevTypeBySeq = new Map() // seq → **紧跟其前**那条事件（日志顺序上的前一条）的类型
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    if (!isPlainObject(ev) || !Number.isFinite(ev.seq)) continue
    bySeq.set(ev.seq, ev)
    const prev = i > 0 && isPlainObject(events[i - 1]) ? events[i - 1] : null
    prevTypeBySeq.set(ev.seq, prev !== null && typeof prev.type === 'string' ? prev.type : null)
  }
  const drafts = []
  for (const ev of events) {
    const repl = normalizeReplacementEventDoc(ev)
    if (repl === null) continue
    const docs = []
    let missing = 0
    for (const seq of repl.shadowedSeqs) {
      const target = bySeq.get(seq)
      if (!target) {
        missing += 1 // 日志里没有这条 seq：如实计数（分叉/截断日志都可能），⛔ 不编
        continue
      }
      docs.push(docOfEvent(target, prevTypeBySeq.get(seq)))
    }
    drafts.push({ repl, docs, missing })
  }
  // 覆盖唯一性：同一段 seq 集合被两条替换事件声称 ⇒ 不唯一（selectModelSummary 据此回落 ambiguous-coverage）
  const claimed = new Map() // seqsKey → 声称它的替换事件数
  for (const d of drafts) {
    const key = d.repl.shadowedSeqs.join(',')
    claimed.set(key, (claimed.get(key) || 0) + 1)
  }
  // 区间之间的 seq 重合如实计数（⛔ 不去重：一条替换 = 一个区间是权威口径，重合只可能是上游语义变了；
  // 于是这里只把事实报上去，由 planScan 记 warning，别让"同一段被收两遍"无声发生）
  const seen = new Map() // seq → 先声称它的 region 序号
  const regions = []
  for (const d of drafts) {
    const seqs = d.repl.shadowedSeqs
    let from = null
    let to = null
    for (const s of seqs) {
      if (from === null || s < from) from = s
      if (to === null || s > to) to = s
    }
    const regionId = `region-${from}-${to}`
    const overlapSeqs = []
    for (const s of seqs) {
      if (seen.has(s)) overlapSeqs.push(s)
      else seen.set(s, regionId)
    }
    const key = seqs.join(',')
    const claimants = claimed.get(key) || 1
    regions.push({
      regionId,
      fromSeq: from,
      toSeq: to,
      docs: d.docs, // ★ 面顺序（⛔ 不是 seq 升序）
      missingDocCount: d.missing,
      overlapSeqs,
      replacement: d.repl,
      ambiguous: claimants > 1,
      ambiguousCount: claimants,
    })
  }
  return regions
}

/**
 * ★ 口径（写死）：region.docs 数组顺序以 '\n' 拼接后 sha256（utf8）。
 * findShadowRegionsFromEvents 给的 docs 顺序 = 替换事件的 `shadowedSeqs` 顺序（**面顺序**）
 * ⇒ 等价于任务书「按该事件自己的 shadowedSeqs 顺序拼接」口径；空串参与拼接、缺 text 当空串。
 * 哈希对数组顺序敏感：乱序数组得不同哈希（自检 2 锁死该性质）。
 * ★★ 2026-09-22：原料随「楼」的口径一起变了（正文只取文本块、区间不再按相邻 seq 切）
 *   ⇒ 同一份会话重扫给出的是**新的一套哈希**。⛔ 不写"旧哈希也认"的兼容路径
 *   （旧台账与旧归档由派单方清，见任务书 §2.4/§4）。
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
 *   - ★★ 2026-09-22 **只收真对话**：三条结构性排除（判据一律走事件结构，⛔ 不用文本前缀/正则猜）：
 *       ① 压缩的**替换节点**（`doc.replacementNode`：紧跟 compaction/summary|prune 的那条 user/message）
 *          —— 官方英文 checkpoint 前言，不是玩家消息（真机楼 0208）；
 *       ② **插件注入的 user 消息**（`source.kind` 不是 'user'：后处理提示词 / 技能清单 / 运行上下文快照）
 *          —— 2026-09-20「不被记忆库收录」的守卫；它以前是**死的**（喂进来的文档没有 data ⇒
 *          sourceKind 恒 null），现在喂原始事件，这条守卫**真的有牙**；
 *       ③ **工具事件**（tool/call · tool/result）—— 本来就不是楼类型，⛔ 也不许把正文并进前一条楼；
 *       三者一律**直接跳过**：既不成楼、也不并进楼、更不进摘要与向量库。
 *   - `assistant/message` 的正文只取文本块（提取在 docOfEvent/eventTextOf，⛔ 不用宿主那个把工具调用
 *     渲染成文本的抽取口径）；取完为空（= 这条消息全是工具调用块/思维链块）⇒ **不成楼**
 *     （真机那 38 条 memory_write、2 条 read 就是这么混进来的）；
 *   - 其余类型并入它前面那条楼的正文（'\n' 接），不单独成楼；开头还没有楼可并的内容不进 floors
 *     （仍参与 contentHash / chars）；
 *   - is_system 恒 false；name 恒 '（来自会话）'；
 *   - 楼号从 startFloor 起（调用方传「现有最大楼号 + 1」，目录不存在传 0）。
 * 返回 { floors, nextFloor }。
 */
export function mapRegionToFloors(region, startFloor = 0) {
  const base = Number.isFinite(startFloor) ? Math.floor(startFloor) : 0
  const floors = []
  let next = base
  for (const doc of (region && Array.isArray(region.docs) ? region.docs : []) || []) {
    if (!isPlainObject(doc)) continue
    const text = typeof doc.text === 'string' ? doc.text : ''
    const type = typeof doc.type === 'string' ? doc.type : null
    // ★★ 三条排除：不是对话的东西（替换节点 / 插件注入 / 工具事件）—— 见本函数头注①②③
    if (doc.replacementNode === true) continue
    if (isInjectedUserMessage(doc)) continue
    if (TOOL_TYPES.includes(type)) continue
    if (FLOOR_TYPES.includes(type)) {
      if (type === 'assistant/message' && text === '') continue // 全是工具调用块 ⇒ 不成楼
      floors.push({
        floor: next,
        isUser: type === 'user/message',
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
      prev.toSeq = Number.isFinite(doc.seq) ? doc.seq : prev.toSeq
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
// 纯函数：替换事件 → 区间自带的模型摘要（D1 的取法在 2026-09-22 改了来源）
//
// ★ 事件的真实形状（读的是官方 dsh-compaction-basic 产物源码 commitCompactionBody，
//   逐字字段名，不是猜的）：session.append("compaction/summary", {
//     compactionId, [sourceCommandId], summary, [rawOutput 及流式调用标记],
//     shadowedRange: { start, end }, shadowedSeqs: [...], shadowedTokenCount,
//     provider, model, [maxTokens], [usage] })
//   其中 summary = summarize() 返回的【文本块数组】[{type:'text',text},…]（安全纯文本拷贝）。
//   另一种替换事件 `compaction/prune`（同文件 82–89 行）也带 shadowedSeqs / shadowedRange，
//   但**没有 summary** —— 那一段没有模型摘要可用，如实走机械兜底。
//
// ★ 取哪一份：替换节点正文 = 官方英文前言（CHECKPOINT_PREAMBLE，在 frameSummary 里与
//   summarize() 钩子之外拼上，⛔ 不在事件里）+ 模型输出块 + 官方收尾标签块。事件里的 summary
//   字段恰好就是【中间那份模型输出】= 我们的归档指令写出的中文条目本身。⇒ 归档取事件 summary
//   块按 '\n' 连接的文本（通常只有一个块，连接不改变内容），**不是**整个替换节点正文。
//   rawOutput 是含非文本块的原始拷贝，不用它（summary 已是官方过滤后的纯文本视图）。
//
// ★★ 2026-09-22：区间与摘要事件的对应关系从「扫一遍事件找谁覆盖了这段 seq」变成
//   **区间自带**（一条替换 = 一个区间）—— 于是 findCoveringSummaryEvents 那套覆盖判定连同
//   它依赖的便宜路径（filterEvents 的文档**结构上没有 data**，恒取不到负载，见任务书 §1-④⑤）
//   一并作废；摘要只从区间自己那条替换事件的 `data.summary` 里取。
// ---------------------------------------------------------------------------

/**
 * 原始事件 → 归一化的**替换事件**；不是替换事件 / 字段不可用 ⇒ null（⛔ 不猜：缺关键字段就当没有这条）。
 * @returns null | { eventSeq, type, compactionId, provider, model, shadowedTokenCount, shadowedSeqs, summaryText }
 */
export function normalizeReplacementEventDoc(doc) {
  if (!isPlainObject(doc)) return null
  const type = typeof doc.type === 'string' ? doc.type : null
  if (type === null || !REPLACEMENT_TYPES.includes(type)) return null
  const payload = isPlainObject(doc.data) ? doc.data : doc
  const seq = Number.isFinite(doc.seq) ? doc.seq : Number.isFinite(payload.seq) ? payload.seq : null
  // 被遮蔽的 seq：优先 shadowedSeqs（逐字数组、**面顺序**，权威）；兜底 shadowedRange{start,end} 展开为
  // 闭区间（官方两个字段都写；range 是「面位置跨度」不是数字 seq 区间 ⇒ 只在 shadowedSeqs 缺席时才用，
  // 展开加上限，防异常大区间把内存吃穿）。
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
  return {
    eventSeq: seq,
    type, // 'compaction/summary' | 'compaction/prune'（prune 没有 summary ⇒ 机械兜底）
    compactionId: typeof payload.compactionId === 'string' && payload.compactionId !== '' ? payload.compactionId : null,
    provider: typeof payload.provider === 'string' && payload.provider !== '' ? payload.provider : null,
    model: typeof payload.model === 'string' && payload.model !== '' ? payload.model : null,
    shadowedTokenCount: Number.isFinite(payload.shadowedTokenCount) ? payload.shadowedTokenCount : null,
    shadowedSeqs: seqs, // ★ 面顺序（⛔ 不排序）
    summaryText: summaryBlocksText(payload.summary), // prune / 形状不对 ⇒ ''
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
 * D1 选择器：区间的摘要条目用**它自己那条压缩的模型摘要**还是机械兜底
 * （⛔ 不猜：每一种回落都给原因码）。
 * 返回 { kind:'model-summary', text, tags, warnings, meta } 或 { kind:'mechanical', reason }。
 * reason ∈ no-model-summary（不是 summary 事件 / 摘要为空 —— 含 **compaction/prune**：
 *             官方那一段本来就没有模型摘要，如实回落）/
 *           ambiguous-coverage（同一段 seq 集合被两条替换事件声称 ⇒ 不唯一，不猜哪一份对）/
 *           model-summary-too-big（超单文件字节上限，不截断模型正文）/
 *           prompt-echo（★ 20260918：模型把**压缩指令原文**当摘要回吐 ⇒ 拒收，回落机械条目。
 *           闸门在 parseSummaryOutput **内部**（lib/summarize.js 的 looksLikePromptEcho），
 *           ⛔ 这里不再另写一条判据；`opts.instruction` 为空 = 拿不到当前生效的指令 ⇒
 *           只按结构判（不瞎猜，如实给不出 echo 判定）。
 *           命中时 planScan 会**大声播报**（warnings），绝不静默回落。）
 * ★ 2026-09-22：`text` 不再是模型原文，而是**美化后的散文**、`tags` 是**标签化**后的词表内扁平数组
 *   （两者都由 beautifyModelSummary 算出，见那里；tags 的收编播报也在它的 warnings 里，
 *   由 planScan 加上区间前缀）。⛔ 原因码枚举一个字没变。
 * ★★ 2026-09-22「摘要按段切片」：额外回 `segments: [{text, tags, tooBig}, …]` —— **段级**的散文与
 *   收编结果（planScan 据此逐段落盘）；字节上限**逐段各自判**（某段 tooBig ⇒ 只有那一段回落机械
 *   条目），全段都超限才整条回落 mechanical/model-summary-too-big（原因码不变）。
 * @param region findShadowRegionsFromEvents 产出的区间（摘要来源 = `region.replacement`）
 */
export function selectModelSummary(region, opts = {}) {
  const repl = region && isPlainObject(region.replacement) ? region.replacement : null
  if (repl === null) return { kind: 'mechanical', reason: 'no-model-summary' }
  if (region.ambiguous === true) {
    return { kind: 'mechanical', reason: 'ambiguous-coverage', coveringCount: region.ambiguousCount }
  }
  // compaction/prune：官方那一段没有模型摘要（types.ts:82-89）⇒ 如实回落，⛔ 不静默
  const raw = repl.type === 'compaction/summary' && typeof repl.summaryText === 'string' ? repl.summaryText : ''
  if (raw.trim() === '') return { kind: 'mechanical', reason: 'no-model-summary' }
  const instruction = typeof opts.instruction === 'string' ? opts.instruction : ''
  // ★★ 2026-09-22「摘要美化 + tags 标签化」：以前这一步把 repl.summaryText **原样**带走
  //   （⇒ 归档正文就是那份 JSON），tags 则留给 planScan 用 extractTagsLine 从正文**末尾**找
  //   `tags:` 行（⇒ 逐段嵌在 JSON 里的 tags 对象一个都收不到）。两道加工现在都在
  //   beautifyModelSummary（纯函数）里，⛔ 判据只此一处：回声闸门在 parseSummaryOutput 内部。
  const beauty = beautifyModelSummary(raw, { instruction })
  if (beauty.echo === true) return { kind: 'mechanical', reason: 'prompt-echo' }
  // ★★ 2026-09-22「摘要按段切片」：字节上限从「区间级一份」改成**逐段各自判**（判据仍只在这一处）——
  //   片段化之后落盘的是**每段各自一张 `.md`**，于是上限也按每段自己算：某段超限 ⇒ 只有**那一段**
  //   回落机械条目（planScan 据 `tooBig` 播报 model-summary-too-big 并把那一段的正文换成机械正文），
  //   其余段照常落盘。全段都超限 ⇒ 整个区间回落机械条目（与改造前同形：fail-open 的整篇原文、
  //   单段结构化都是这一条）。⛔ 不截断模型正文、⛔ 不因为一段超限就把整条摘要丢掉。
  const segments = (Array.isArray(beauty.segments) ? beauty.segments : []).map((seg) => ({
    text: seg.text,
    tags: seg.tags,
    tooBig: Buffer.byteLength(seg.text, 'utf8') > MODEL_SUMMARY_MAX_BYTES,
  }))
  if (segments.length > 0 && segments.every((s) => s.tooBig)) return { kind: 'mechanical', reason: 'model-summary-too-big' }
  return {
    kind: 'model-summary',
    text: beauty.text,
    tags: beauty.tags,
    warnings: beauty.warnings,
    // ★ 逐段落盘的依据：一段一条（text/tags 都是**这一段自己的**）；tooBig 的那段由 planScan 换成
    //   机械正文并播报（判据只在这里算过一次，⛔ planScan 不重算）。
    segments,
    meta: {
      kind: 'model-summary',
      compactionId: repl.compactionId,
      provider: repl.provider,
      model: repl.model,
      shadowedTokenCount: repl.shadowedTokenCount,
      eventSeq: repl.eventSeq,
    },
  }
}

/**
 * 模型摘要原文 → 归档用的正文（散文）+ tags（扁平词表数组）。**纯函数**、零 IO。
 *
 * ★★ 2026-09-22（本函数的由来，真机取证在派单任务书 §1）：模型按压缩指令回的是**结构化 JSON**
 *   （`[{"summary":"第1天 清晨: …","tags":{"vibe":"Serious","special":[],"important":false}},…]`），
 *   旧写法把这串原文**原样**当摘要正文落盘 ⇒ 归档里显示的就是 json（用户口径「现在摘要里显示的
 *   直接是 json」）；而 tags 是**逐段嵌在 JSON 里的对象**，旧取法 extractTagsLine 找的是
 *   「正文末尾的 `tags:` 行」⇒ 一个都收不到，真机两条摘要都记了 tags-empty。两道加工：
 *     ① **美化**：正文 = 各段 `summary` 散文按 '\n' 连接（每段一行；item 自带的「第1天 清晨: 」
 *        这类分段前缀原样保留，⛔ 不许再包一层）。⛔ 正文里不出现 JSON 外壳（键名 `"summary"` /
 *        `"tags"` 与花括号方括号一个都不落），⛔ 也不加任何元信息头（本模块铁律：这段文字之后要被
 *        embed 进向量库，头会污染切片）。
 *     ② **标签化**：各段 `tags` 对象逐个走 lib/ami-tags.js 的词表收编（validateTags → flattenTags），
 *        各段结果**合并去重**（顺序 = 首次出现顺序）。⚠️ 多段时 vibe 可能不止一个 ⇒ 取**并集**
 *        （⛔ 别只取第一段、⛔ 别自创"选一个 dominant"：那是指令让**模型**选的，不是收编方的活）。
 *
 * ★ **fail-open（本模块铁律，⛔ 别改成"丢"或"回落机械条目"）**：没解析成结构化条目
 *   （纯散文 / 坏 JSON / JSON 里没有可用条目）⇒ **正文照旧用模型原文**（`kind` 仍会是
 *   `'model-summary'`，⛔ 一个字节都不丢），tags 退回**老路** extractTagsLine，并如实给一条
 *   warning 说明"没解析成结构化条目，正文用了模型原文"。
 *
 * 回声闸门在这一步**内部**（`parseSummaryOutput` 自带）：`echo:true` ⇒ 调用方按 prompt-echo
 * 回落机械条目（此时 text 无意义；⛔ 别在外面另写一条回声判据）。
 *
 * ★★ 2026-09-22 第二条（「摘要按段切片」，用户口径：「摘要没做切分吗，我看到是一大段一条。但内部
 *   是有分段的。这回影响向量检索吗」—— **影响**：检索侧的粒度就是「一个摘要文件 = 一条切片」，
 *   45 段挤成一个向量点 = 语义被平均掉、命中就灌一整篇、再长还会撞 embedding 上限）：
 *   本函数除了那份**拼好的**正文，还回**段数组** `segments: [{text, tags}, …]` —— 每段的散文与
 *   **它自己那段**的收编结果（⛔ 不是各段并集）。判据（怎么解析、怎么收编、哪条不算数）**只此一处**；
 *   planScan 拿段数组决定落几条（>1 段 ⇒ 一次提交 N 份，见那里的头注），⛔ 不再自己解析一遍 JSON。
 *
 * @param {string} raw 模型原文（= 替换事件的 `data.summary` 文本）
 * @param {{instruction?: string}} [opts] 当前生效的压缩指令（给了才做回声拒收）
 * @returns {{echo: boolean, structured: boolean, text: string, tags: string[],
 *            segments: {text: string, tags: string[]}[], warnings: string[]}}
 *   segments = 逐段的散文与**段级** tags（结构化那条路一段一条；fail-open 时是**一段** = 整篇原文，
 *   ⛔ 不硬造分段）；tags = 各段并集（区间视图**只是**给老读者/播报用的，⛔ 别拿它冒充某一段的 tags）；
 *   warnings = 不带区间前缀的播报（planScan 加上 `region <id>` 前缀后进 plan.warnings）
 */
export function beautifyModelSummary(raw, opts = {}) {
  const instruction = typeof opts.instruction === 'string' ? opts.instruction : ''
  const parsed = parseSummaryOutput(String(raw ?? ''), { instruction })
  if (parsed.echo === true) return { echo: true, structured: false, text: '', tags: [], segments: [], warnings: [] }
  const items = parsed.ok === true && Array.isArray(parsed.items) ? parsed.items : []
  if (parsed.usedJson === true && items.length > 0) {
    const text = items.map((it) => it.text).join('\n')
    const bag = collectItemTags(raw, items)
    const warnings = []
    if (bag.partial) warnings.push(TAGS_PARTIAL_NOTICE)
    if (bag.tags.length === 0) warnings.push('模型摘要的 tags 一段都没收编进词表，tags 按空数组归档（tags-empty）')
    return { echo: false, structured: true, text, tags: bag.tags, segments: bag.segments, warnings }
  }
  // ★ fail-open：正文照旧用**模型原文**（⛔ 不 trim、⛔ 不丢、⛔ 不回落机械条目 —— 这份原文
  //   之后照样 embed 进向量库，所以一个字节都不动），tags 走老路。
  const legacy = tagsLineOf(raw)
  return {
    echo: false,
    structured: false,
    text: String(raw ?? ''),
    tags: legacy.tags,
    // ★ fail-open 的正文是**模型原文一整篇**（没有"段"可分）⇒ segments 就是**一段**：planScan 于是
    //   照旧走单份那条路（与改造前逐字同形，⛔ 不硬造分段）。
    segments: [{ text: String(raw ?? ''), tags: legacy.tags }],
    warnings: ['模型摘要没解析成结构化条目，正文照旧用模型原文（未美化，summary-plain）', ...legacy.warnings],
  }
}

/** tags 收编不进的播报文案（结构化那条路与老路共用；⛔ planScan 只加上区间前缀，别的字不改）。 */
const TAGS_PARTIAL_NOTICE = 'tags 有收编不进的值（已剔除），只归档词表内的部分（tags-partial）'

/**
 * 结构化 items 的 tags：逐段 validateTags → flattenTags → 得**段级** tags，同时给出各段并集。
 * ★ 为什么要回头去拿**原始 JSON**：parseSummaryOutput 给的 items 只带 `{text, tags:扁平[]}`
 *   （normalizeSummaryItem 把 tags 那层对象压平了，`special` 数组整个丢掉）—— 而收编要的是
 *   `{vibe,special,important}` **原文**（validateTags 的入参形状）。于是用 extractJson 取同一份
 *   结构，再按 `text` 与 items **逐个对齐**：parseSummaryOutput 只可能因为「text 为空 / 判成回声」
 *   丢条目、且顺序不变 ⇒ 对齐是精确的。⛔ 这里不重写任何判据，只做对齐与收编。
 * ★ 2026-09-22「摘要按段切片」：收编结果**按段分开**给（`segments[i].tags` = 第 i 段自己那些
 *   收编得进的标签；某段没给 tags 对象 ⇒ 那一段就是 `[]`，⛔ 不报 partial —— 那不是"收编不进"）。
 *   并集（`tags`）只是**区间视图与播报**用的（老读者照旧），⛔ 不再是"落盘的那份 tags"。
 * @returns {{segments: {text: string, tags: string[]}[], tags: string[], partial: boolean}}
 */
function collectItemTags(raw, items) {
  const parsedJson = extractJson(String(raw ?? ''))
  const list = Array.isArray(parsedJson) ? parsedJson : isPlainObject(parsedJson) ? [parsedJson] : []
  const segments = []
  const tags = []
  const seen = new Set()
  let partial = false
  let k = 0
  for (const entry of list) {
    if (k >= items.length) break
    if (normalizeSummaryItem(entry).text !== items[k].text) continue // 没活下来的那条（空 text / 回声）
    const item = items[k]
    k += 1
    const segTags = []
    const segSeen = new Set()
    if (isPlainObject(entry)) {
      const rawTags = entry.tags ?? entry.Tags ?? entry.tag ?? entry.Tag
      if (isPlainObject(rawTags)) { // 这一段没给 tags：⛔ 不据此报 partial（不是"收编不进"）
        const verdict = validateTags(rawTags)
        if (!verdict.ok) partial = true
        for (const t of flattenTags(verdict.tags)) {
          if (segSeen.has(t)) continue
          segSeen.add(t)
          segTags.push(t)
        }
      }
    }
    for (const t of segTags) {
      if (seen.has(t)) continue
      seen.add(t)
      tags.push(t)
    }
    segments.push({ text: item.text, tags: segTags })
  }
  return { segments, tags, partial }
}

/**
 * 老路（⛔ 留着别删）：从**正文末尾**找 `tags:` 行 —— 模型输出不是结构化 JSON（纯散文）时的兜底。
 * 两条路都走不到才判空（tags-empty）。语义与 2026-09-22 之前逐字一致。
 */
function tagsLineOf(text) {
  const extracted = extractTagsLine(text)
  if (!extracted.found) {
    return { tags: [], warnings: ['模型摘要没有可解析的 tags 行，tags 按空数组归档（tags-empty）'] }
  }
  const verdict = validateTags(extracted.parsed)
  return {
    tags: flattenTags(verdict.tags),
    warnings: verdict.ok ? [] : [TAGS_PARTIAL_NOTICE],
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
 * deps  : { loadRawEvents(sessionId) → { events, inheritedEventCount? }（或直接给事件数组）,
 *           maxExistingFloor(target) → number|null,                    // null = 目录不存在
 *           collect: { planCollect(request) → subPlan, applyCollect(subPlan, opts) → result },
 *           dshHome: string }                                          // DSH 根（非插件子目录）
 *
 * ★★ 2026-09-22 注入面换人：以前是 loadSurfaces（宿主 collectSurfaces 的便宜路径：只给
 *   `{surface,text,type}` 的 Map，**结构上没有 data** ⇒ 模型摘要取不到、插件注入守卫恒假）。
 *   现在要**带 data 的原始事件**——由 lib/index.js 的 loadSessionLog 提供（活注册表 → 宿主持久化
 *   → readSession 退路）。⛔ 不许改 collectSurfaces() 的返回形状（它还有两个别的消费者）；
 *   这里是**新增**一条注入面，不是替换它。缺 loadRawEvents ⇒ 扫描无法进行（可读地抛，⛔ 不猜）。
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
  if (!deps || typeof deps.loadRawEvents !== 'function' || typeof deps.maxExistingFloor !== 'function') {
    throw mkErr('SCAN_INVALID', 'deps 缺 loadRawEvents / maxExistingFloor')
  }
  if (!deps.collect || typeof deps.collect.planCollect !== 'function' || typeof deps.collect.applyCollect !== 'function') {
    throw mkErr('SCAN_COLLECT_BACKEND_MISSING', 'deps.collect 缺 planCollect / applyCollect（A1 lib/collect.js）')
  }

  const warnings = []
  // ★ 20260918 回声闸门：`deps.instruction` = 当前生效的压缩指令文本（接线处注入；可选）。
  //   拿不到（未注入/空串）⇒ 闸门只按结构判（looksLikePromptEcho 对空指令恒 false），如实降级，
  //   ⛔ 不瞎猜。接线：lib/index.js 的路由与自动收纳钩子都传 templates.compaction.current。
  const echoInstruction = typeof deps.instruction === 'string' ? deps.instruction : ''
  // ★★ 2026-09-22：区间与摘要的唯一来源 = **带 data 的原始事件**（loadRawEvents）。
  //   ⛔ 读不出来 = 会话不可读（可读地抛，状态码与旧口径一致：SCAN_SESSION_UNREADABLE）；
  //   ⛔ 空数组 = 这份会话真的没有事件（如实 0 区间，⛔ 不当成"读失败"）。
  let rawEvents = []
  let inheritedEventCount = null
  try {
    const loaded = await deps.loadRawEvents(sessionId)
    if (Array.isArray(loaded)) {
      rawEvents = loaded
    } else if (isPlainObject(loaded) && Array.isArray(loaded.events)) {
      rawEvents = loaded.events
      // 分叉：readSession 会给「继承自父会话的事件数」。如实带出来（见下面的 warning）——
      // ⛔ 不据此丢内容：继承来的正文也是这个周目的剧情，同一份内容靠台账 contentHash 去重。
      inheritedEventCount = Number.isFinite(loaded.inheritedEventCount) ? loaded.inheritedEventCount : null
    } else {
      throw new Error('loadRawEvents 返回形状不识别（要事件数组或 {events:[…]}）')
    }
  } catch (e) {
    throw mkErr('SCAN_SESSION_UNREADABLE', `会话不可读：${String((e && e.message) || e).slice(0, 200)}`)
  }

  const { ledger, warning } = readLedger(deps.dshHome)
  if (warning) warnings.push(warning)

  const maxFloor = await deps.maxExistingFloor(target) // number|null（null = 目录不存在 ⇒ 0 起）
  let startFloor = typeof maxFloor === 'number' && Number.isFinite(maxFloor) ? Math.floor(maxFloor) + 1 : 0

  const regions = findShadowRegionsFromEvents(rawEvents)
  if (inheritedEventCount !== null && inheritedEventCount > 0) {
    // 如实说明口径：继承内容**照收**（它就是本会话的剧情），但同一份内容不会被收两遍
    // —— 幂等只认台账的 contentHash。
    warnings.push(`本会话有 ${inheritedEventCount} 条分叉继承来的事件（readSession.inheritedEventCount）；继承内容照常参与扫描，重复的按台账 contentHash 幂等跳过`)
  }
  for (const r of regions) {
    if (r.missingDocCount > 0) warnings.push(`region ${r.regionId} 有 ${r.missingDocCount} 个被遮蔽的 seq 在会话日志里找不到（如实跳过，该区间只收找到的那些）`)
    if (Array.isArray(r.overlapSeqs) && r.overlapSeqs.length > 0) warnings.push(`region ${r.regionId} 与更早的区间有 ${r.overlapSeqs.length} 个 seq 重合（如实报告，⛔ 不去重：一条替换 = 一个区间是权威口径）`)
  }
  const planRegions = []
  const skipped = []
  const willWrite = []
  const willUpdate = []
  const now = Date.now()

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
    // D1：摘要 = **本区间自己那条压缩**的模型摘要（区间 ↔ 替换事件 1:1，见 selectModelSummary）；
    // 机械条目降级为兜底，每一种回落的原因都如实进 warnings（⛔ 不猜、不截断模型正文）。
    // ★ 20260918：正文先过回声闸门（prompt-echo ⇒ 拒收 + 大声播报，见 selectModelSummary）。
    // ★★ 2026-09-22：正文**美化**（JSON → 散文）+ tags **标签化**（各段 tags 结构化收编、合并去重）
    //   都在 selectModelSummary → beautifyModelSummary 里做完了；这里只落盘 + 把它的播报
    //   加上区间前缀（tags-partial / tags-empty / summary-plain 三条如实带上，⛔ 不静默）。
    const sel = selectModelSummary(region, { instruction: echoInstruction })
    if (sel.kind === 'model-summary') {
      for (const w of Array.isArray(sel.warnings) ? sel.warnings : []) {
        warnings.push(`region ${region.regionId} ${w}`)
      }
      // ★★ 2026-09-22「摘要按段切片」：**一个叙事段 = 一条摘要条目**（一条 `.md` + `index.json`
      //   一条 entry）—— 检索侧的粒度就是「一条文件 = 一条切片」（anima 入库时整文件一条、
      //   ⛔ 入库侧不切块）：45 段挤成一条会把语义平均掉、命中就灌一整篇、再长还会撞 embedding
      //   上限。每段带**它自己的** tags（⛔ 不是各段并集）。
      //   只有一段（含 fail-open 的整篇原文）⇒ 照旧走**单份**那条老路：文件名不带后缀、
      //   落盘形状与改造前逐字一致（少动）。
      //   段级回落：某段超字节上限 ⇒ **那一段**的正文换成机械条目正文、meta 留空（= 老机械条目的
      //   形状：模型字段与 tags 都没有），其余段照常 —— 判据在 selectModelSummary 里算过一次。
      const segs = Array.isArray(sel.segments) ? sel.segments : []
      const anyTooBig = segs.some((s) => s.tooBig)
      const mechText = anyTooBig ? buildRegionSummary(region).text : ''
      const placed = segs.map((s) => (s.tooBig
        ? { text: mechText, tags: [], meta: null }
        : { text: s.text, tags: s.tags, meta: { ...sel.meta, tags: s.tags } }))
      segs.forEach((s, i) => {
        if (s.tooBig) warnings.push(`region ${region.regionId} 第 ${i + 1} 段模型摘要超单文件字节上限，该段如实回落机械条目（model-summary-too-big）`)
      })
      entry.summary = {
        // 区间视图（单份那条路它就是落盘正文）：没有段回落时**就是选择器给的那一篇**（= 各段散文
        // '\n' 连接，逐字不变）；有段回落时按**实际落盘的那几段**拼（⛔ 不拿模型原文冒充机械正文）。
        text: anyTooBig ? placed.map((p) => p.text).join('\n') : sel.text,
        floorCount: entry.floorCount,
        kind: 'model-summary',
        meta: { ...sel.meta, tags: sel.tags }, // 区间视图：tags 是各段**并集**（⛔ 别拿它冒充某一段的）
      }
      entry.summaryKind = 'model-summary'
      if (placed.length > 1) entry.summaries = placed // >1 段 ⇒ 逐段落盘（一次提交 N 份，id 带 -N 后缀）
    } else {
      entry.summary = buildRegionSummary(region)
      entry.summaryKind = 'mechanical'
      entry.summaryFallback = sel.reason
      if (sel.reason === 'prompt-echo') {
        // ⛔ 大声播报：模型把压缩指令原文当摘要回吐了。静默跳过 = 坏文本无声地换成了机械条目，
        // 谁也不知道模型出了问题；这里的 warning 会一路带进 HTTP 响应与自动收纳的播报。
        warnings.push(`region ${region.regionId} ★ 模型摘要是**压缩指令原文的回声**（prompt-echo），已拒收，该区间回落机械条目 —— 请检查压缩指令与模型`)
      } else if (sel.reason === 'no-model-summary' && region.replacement && region.replacement.type === 'compaction/prune') {
        // prune 与 summary 是两种替换事件：prune 的区间官方**没有**模型摘要（如实说明 + 带原因码，⛔ 不静默）
        warnings.push(`region ${region.regionId} 是 compaction/prune 的区间（官方那一段本来就没有模型摘要），已按机械条目归档（no-model-summary）`)
      } else {
        warnings.push(`region ${region.regionId} 模型摘要不可用（${sel.reason}），已按机械条目归档`)
      }
    }
    // 一次调用：楼层写一遍 + 每份摘要各一条 `.md` + 索引追加 N 条（老路 = 单份 = N=1，字节不变）。
    // 机械兜底与 fail-open 两路**没有"段"可分** ⇒ 照旧一条（⛔ 不硬造分段）。
    const subPlan = await deps.collect.planCollect({
      characterId: target.characterId,
      playthroughId: target.playthroughId,
      floors: kept,
      ...(Array.isArray(entry.summaries) && entry.summaries.length > 0
        ? { summaries: entry.summaries }
        : { summary: entry.summary }),
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
    // ★★ 2026-09-22「摘要按段切片」：逐段落盘的区间带的是 `region.summaries`（N 份）—— 现取计划
    //   必须**照原样带过去**，⛔ 不能只带 region.summary：那份只有一份，现取出来的计划会把 N 份
    //   缩回 1 份（落库时静默少写，最坏的一种 bug）。
    const segments = Array.isArray(region.summaries) && region.summaries.length > 0 ? region.summaries : null
    if (segments === null && (!isPlainObject(region.summary) || typeof region.summary.text !== 'string')) return original
    try {
      const fresh = await deps.collect.planCollect({
        characterId: plan.target.characterId,
        playthroughId: plan.target.playthroughId,
        floors: region.floors,
        ...(segments !== null ? { summaries: segments } : { summary: region.summary }),
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

/**
 * ★ 20260922：HTTP 路由的 Tavern 基址 —— **照 A1 的取法**从当前请求推同源地址
 * （`collect.js` 的 `tavernBaseFromReq`：Host 头优先，兜底 `127.0.0.1:<socket.localPort>`），
 * ⛔ 不在这里自己拼字符串、⛔ 不写死端口。
 *
 * 为什么单独抽一步：`runCollectRoute` 以前**没把 base 传给内核** ⇒ 基址退化成 `http://127.0.0.1`
 * （没有端口）⇒ 打 80 端口 ⇒ 面板的「收纳」按钮与补收全走不通，用户只看到没头没脑的
 * `TAVERN_UNREACHABLE: Tavern 工作区请求失败：fetch failed`（2026-09-22 真机事故）。
 * 抽出来之后这一步能**直测**：喂假 backend 就能把「请求的 Host ⇒ 客户端拿到的 baseUrl」逐字记下来断言。
 * `backend` 可注入（生产传空 = 动态 import A1 的 collect.js；自检台喂假 backend 记账）。
 */
export async function routeTavernBase(req, backend = null) {
  const b = backend === null || backend === undefined ? await importCollectBackend() : backend
  if (typeof b.tavernBaseFromReq !== 'function') {
    throw mkErr('SCAN_COLLECT_INCOMPATIBLE', 'collect.js 未导出 tavernBaseFromReq')
  }
  return b.tavernBaseFromReq(req)
}

/**
 * `opts.base`（Tavern 基址）→ 喂给 A1 `tavernBaseFromReq` 的**合成请求**：A1 只读
 * `req.headers.host` / `req.socket.localPort` 两个字段（见 lib/collect.js），所以两处适配器
 * （makeA1Tavern / tavernMaxExistingFloor）一行都不用改。
 *
 * ★ 20260922 契约收紧：**必须给得出基址**。给不出 ⇒ 抛可读错误 `SCAN_BASE_UNKNOWN`，
 * ⛔ 绝不退化成一个没端口的地址去打默认端口 —— 那正是真机事故的形态（`null` 进来 ⇒ A1 走兜底
 * 分支 ⇒ `http://127.0.0.1` ⇒ 连 80 ⇒ 上层只见 `fetch failed`，让人白查两小时）。
 * 判据 = **基址里有没有一个可用端口**：两条正常来路（HTTP 路由从 Host 头推、自动收纳从
 * `webServer.port` 推）都必然带端口；只剩一个主机名 = 推不出宿主自己的地址。
 */
export function reqLikeFromBase(base) {
  const raw = typeof base === 'string' ? base.trim() : ''
  const host = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  const m = /:(\d+)$/.exec(host)
  const port = m === null ? 0 : Number(m[1])
  if (!(port >= 1 && port <= 65535)) {
    throw mkErr(
      'SCAN_BASE_UNKNOWN',
      `推不出宿主自己的地址（Tavern 基址${raw === '' ? '没给出来' : '里没有可用端口：' + raw}），本轮没连 Tavern。`,
    )
  }
  return { headers: { host } }
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

/** A1 的同源 Tavern client：基址从当前 HTTP 请求推（照抄 A1 makeTavern 的默认分支）。
 *  导出是给自检台用的注入面：**喂假 backend 就能把 `createTavernClient({baseUrl})` 的入参记下来断言**。 */
export function makeA1Tavern(backend, req) {
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

/** A1 summary.id 缺省 s-<from>-<to>，这里加 mt- 前缀标明来源（只允许 [A-Za-z0-9._-]）。
 *  ★ 2026-09-22「摘要按段切片」：一次压缩的 N 段**一律带 `-N` 后缀**（N 从 1 起，各自不同的落点）；
 *    只有一段时**不带后缀**（形状与改造前逐字一致，少动）。楼号区间各段共用（模型的分段跟楼层
 *    没有一一对应，如实共用，⛔ 不硬编）。 */
function summaryIdFor(floors, segmentNo) {
  const base = 'mt-' + String(floors[0].floor).padStart(4, '0') + '-' + String(floors[floors.length - 1].floor).padStart(4, '0')
  return Number.isInteger(segmentNo) && segmentNo >= 1 ? base + '-' + segmentNo : base
}

/**
 * ★★ 2026-09-22：**原始事件**装载（唯一的数据来源）—— 由 lib/index.js 注入它的 `loadSessionLog`
 * 包装（活会话注册表 → 宿主持久化 → sessionQuery.readSession 退路；该文件头注第 33–38 行说的
 * 就是这条口径）。本模块**不自己读盘、不碰 fs**（照旧只经注入面）。
 *
 * 为什么必须换掉旧的 `collectSurfaces`（宿主那条便宜路径）：
 *   ① 它给的是 `{sessionId,seq,type,time,surface,text}` 的**文档**（`buildSessionEventSearchDocuments`
 *      的产物，**结构上没有 `data`**）⇒ `payload.shadowedSeqs` 恒 undefined、`source.kind` 恒 null
 *      ⇒ 模型摘要永远拿不到（全回落 no-model-summary）、插件注入守卫**永不触发**（任务书 §1-④⑤）；
 *   ② 它把工具调用渲染进 text ⇒ `memory_write` / `read` 这类机制楼混进归档（§1-③）。
 * ⛔ 不改那个函数的返回形状（它还有两个别的消费者：最近几楼 / 未被遮蔽字数）—— 这里是新增一条注入面。
 *
 * deps.loadRawEvents 的返回：`{ events, inheritedEventCount? }` 或事件数组（两种都认）。
 * 拿不出来 ⇒ 抛（planScan 会转成 SCAN_SESSION_UNREADABLE），⛔ 不返回空数组冒充"这会话没内容"。
 */
function rawEventsViaHost(loadRawEvents, sessionId) {
  if (typeof loadRawEvents !== 'function') {
    throw mkErr('SCAN_COLLECT_BACKEND_MISSING', '宿主未注入原始事件装载器（loadRawEvents）—— collectOnce 由 lib/index.js 接线注入')
  }
  return loadRawEvents(sessionId)
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
  // SCAN_BASE_UNKNOWN：宿主自己那侧的地址都推不出来（环境问题，与请求内容无关）⇒ 503，
  // 与 SCAN_COLLECT_BACKEND_MISSING / SESSION_QUERY_UNAVAILABLE 同一族（宿主缺能力）。
  if (code === 'SCAN_COLLECT_BACKEND_MISSING' || code === 'SESSION_QUERY_UNAVAILABLE' || code === 'SCAN_BASE_UNKNOWN') return 503
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
 * @param opts.base  Tavern 基址（**必给**：拿不出 ⇒ 可读地抛 `SCAN_BASE_UNKNOWN`，见 reqLikeFromBase，
 *                   ⛔ 不再静默退化成 `http://127.0.0.1` 打 80 端口）。HTTP 路径从当前请求的 Host 头推
 *                   （`runCollectRoute` 里的 `routeTavernBase(req)`）；自动触发那条路没有 req，
 *                   用 `http://127.0.0.1:<webServer.port>`（host/webserver 的 `port`
 *                   getter 就是实际监听端口）。内部把它包成一个**合成 req**，因为
 *                   A1 的 `tavernBaseFromReq` 只读 `req.headers.host` / `req.socket.localPort`
 *                   —— 这样两处适配器（makeA1Tavern / tavernMaxExistingFloor）一行都不用改。
 * @returns `{ kind:'plan', plan }`（auto=false）或 `{ kind:'result', plan, result }`（auto=true）
 * @throws 带 code 的错误（调用方自己决定 HTTP 状态或怎么播报）
 */
export async function collectOnce(ctx, opts = {}) {
  const { sessionId, target, auto, base, dshHome: dshHomeIn, loadRawEvents, expectedRevisions, maxFloorsPerRegion: maxFloors, instruction } = opts
  if (typeof sessionId !== 'string' || sessionId === '' || !isPlainObject(target) ||
      typeof target.characterId !== 'string' || target.characterId === '' ||
      typeof target.playthroughId !== 'string' || target.playthroughId === '') {
    throw mkErr('SCAN_INVALID', '需要 sessionId 与 target:{characterId,playthroughId}（非空字符串）')
  }
  const sq = ctx && typeof ctx.get === 'function' ? ctx.get('sessionQuery') : null
  if (!sq) throw mkErr('SESSION_QUERY_UNAVAILABLE', '宿主未挂载 sessionQuery')
  // ★ 20260922：拿不出基址 ⇒ 可读错误（⛔ 不许静默退化成 `http://127.0.0.1` 打 80 端口，
  //   那会让上层报没头没脑的 `fetch failed`）。判据与文案都在 reqLikeFromBase。
  const reqLike = reqLikeFromBase(base)
  const dshHome = typeof dshHomeIn === 'string' && dshHomeIn !== '' ? dshHomeIn : dshRootFromEnv()
  const deps = {
    dshHome,
    instruction: typeof instruction === 'string' ? instruction : '', // 回声闸门用（当前生效的压缩指令；可省）
    // ★★ 2026-09-22：**原始事件**（带 data）是区间与摘要的唯一来源 —— 由调用方（lib/index.js 的
    // 路由分派行 / 自动收纳钩子）注入 `loadSessionLog` 的包装；本模块不自己读盘。
    // 旧的两条便宜路径（collectSurfaces / loadSummaryEventsViaHost）已废：它们的文档结构上没有 data
    // ⇒ 模型摘要恒取不到、插件注入守卫恒假（任务书 §1-④⑤）。⛔ 那条函数本身没动（另有消费者）。
    loadRawEvents: (sid) => rawEventsViaHost(loadRawEvents, sid),
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
        // ★ 摘要的 model 记进索引既有 model 字段；meta 原样带过去（A1 侧白名单收编）。
        // ★★ 2026-09-22「摘要按段切片」：逐段落盘的区间带来的是 `request.summaries`（N 份）——
        //   一次调用提交 N 份，**每份一个 id**（`mt-<from4>-<to4>-N`，见 summaryIdFor），
        //   落点由 A1 的 summaryPathOf 按各自的 id 推（⛔ 这里不自己拼路径）。
        const intoA1Summary = (s, i) => {
          const m = isPlainObject(s) && isPlainObject(s.meta) ? s.meta : null
          return {
            text: s.text,
            id: summaryIdFor(floors, i),
            model: m !== null && typeof m.model === 'string' && m.model !== '' ? m.model : undefined,
            meta: m,
          }
        }
        return backend.planCollect(
          {
            target: { characterId: request.characterId, playthroughId: request.playthroughId },
            range: { fromFloor: floors[0].floor, toFloor: floors[floors.length - 1].floor },
            floors,
            ...(Array.isArray(request.summaries) && request.summaries.length > 0
              ? { summaries: request.summaries.map((s, i) => intoA1Summary(s, i + 1)) }
              : { summary: { text: request.summary.text, id: summaryIdFor(floors), model: meta !== null && typeof meta.model === 'string' && meta.model !== '' ? meta.model : undefined, meta } }),
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

/**
 * 两条 HTTP 路由的共用实现。
 * `loadRawEvents` = 宿主注入的**原始事件**装载器（lib/index.js 的 `createRawEventLoader(ctx)`，
 * 内部就是 loadSessionLog）。★ 20260922：它取代了以前那个位置上的 `collectSurfaces`
 * —— 区间与摘要都要带 `data` 的事件，那条便宜路径结构上给不出（见 rawEventsViaHost 头注）。
 */
async function runCollectRoute(ctx, req, send, log, loadRawEvents, auto, instruction) {
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
    // ★★ 20260922：这条路以前**漏传 base** —— 内核推不出基址就退化成 `http://127.0.0.1`（无端口）
    //   ⇒ 打 80 端口 ⇒ 面板的「收纳」按钮（/collect/scan）与补收（/collect/auto）全走不通，
    //   用户只看到 `TAVERN_UNREACHABLE: … fetch failed`。基址照 A1 的取法从**当前请求**推
    //   （Host 头优先，兜底 `socket.localPort`，见 routeTavernBase），⛔ 不自己拼、⛔ 不写死端口。
    const base = await routeTavernBase(req)
    const out = await collectOnce(ctx, {
      sessionId,
      target,
      auto: auto === true,
      base,
      loadRawEvents,
      expectedRevisions: body && body.expectedRevisions,
      maxFloorsPerRegion: body && body.maxFloorsPerRegion,
      instruction,
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

/** POST /magictarven/api/collect/scan —— 只规划不落库（dryRun 语义固定为 plan-only）。
 *  `loadRawEvents` = 宿主注入的原始事件装载器（lib/index.js 的 createRawEventLoader）。
 *  `instruction` = 当前生效的压缩指令文本（lib/index.js 注入；回声闸门用，可省）。 */
export async function handleCollectScan(ctx, req, send, log, loadRawEvents, instruction) {
  return runCollectRoute(ctx, req, send, log, loadRawEvents, false, instruction)
}

/** POST /magictarven/api/collect/auto —— 规划 + 落库 + 记台账（幂等）。`loadRawEvents` / `instruction` 同上。 */
export async function handleCollectAuto(ctx, req, send, log, loadRawEvents, instruction) {
  return runCollectRoute(ctx, req, send, log, loadRawEvents, true, instruction)
}
