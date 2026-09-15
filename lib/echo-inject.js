// ---------------------------------------------------------------------------
// echo-inject —— 「记忆回响」的装配件（D2 引擎半成品：本单【不接线】）。
//
// 本模块只导出两件东西（§1 的硬约束）：
//   1) buildEchoText(hits, opts)          —— 纯函数：命中数组 → 注入文本；
//   2) createEchoInject({ getConfig, storageDir, query }) —— 工厂：
//        返回 { section: { name:'dma:echo', order:54, text }, refresh() }。
// getConfig / storageDir / query 全部由调用方注入 ⇒ 本模块不读全局配置、
// ⛔ 不自己注册段（注册动作留给后续接线单）；开关默认 false（插件默认关、本机再开）。
//
// 段位（§4.2，登记进 card-sections 保留表的事同样留给接线单）：
//   dma:echo = order 54 —— rp:policy(45)/state:card(50) 之后、anima:memory(55) 之前。
//
// 失败语义（§4.1）：回响是增强，refresh 里任何一步失败 ⇒ 本轮 text=''（fail-silent），
// 绝不抛、绝不阻塞主对话；refresh 同步执行（node:sqlite 是同步 API）⇒ 天然有界。
// ---------------------------------------------------------------------------

import {
  ECHO_DB_FILENAME,
  extractCandidates,
  openEchoIndexSafe,
  searchEchoSafely,
} from './echo-index.js'

/** 注入文本的前言（逐字固定，自检台钉住）：讲清「历史回响、不是此刻、锚点优先」。 */
const PREAMBLE =
  '（历史回响：下面是本档案过往楼层的原文片段——都是已经发生过的事，不是此刻；与 <storyAnchor> 当前坐标冲突时，一律以锚点为准。）'

/** 单条片段被截断时的行尾标注（不静默）。 */
const CUT_MARK = '…［片段已截断］'

/** 超出预算/条数时的总结标注（不静默）。 */
const overflowNotice = (maxChars, topK, kept, total) =>
  `［已截断：回响预算 ${maxChars} 字 / 最多 ${topK} 条，本轮保留 ${kept}/${total} 条］`

/** 预留给总结标注的空间（标注自身也要算进预算，见 buildEchoText）。 */
const NOTICE_RESERVE = 80

/**
 * buildEchoText(hits, { maxChars=1200, perHitChars=280, topK=5 }) → string
 * 纯函数。hits: [{ floor:Number, body:String, … }]（search 的输出可直接喂进来）。
 * 形状：
 *   <memoryEcho>
 *   （前言逐字……）
 *   [楼 0012] 片段…
 *   [楼 0456] 片段…
 *   ［已截断：…］        ← 只在超预算/超条数时出现（标注，绝不静默）
 *   </memoryEcho>
 * 预算：maxChars 为总字数上限（JS 字符串长度口径），perHitChars 为单条上限，
 * topK 为最多条数；任一超限都截断并带标注。空命中 ⇒ 返回 ''（本轮不注入）。
 */
export function buildEchoText(hits, opts = {}) {
  const maxChars = Math.max(240, Math.trunc(Number(opts.maxChars ?? 1200)))
  const perHitChars = Math.max(20, Math.trunc(Number(opts.perHitChars ?? 280)))
  const topK = Math.max(1, Math.trunc(Number(opts.topK ?? 5)))

  const clean = (Array.isArray(hits) ? hits : []).filter(
    (h) => h != null && Number.isFinite(Number(h.floor)) &&
      typeof h.body === 'string' && h.body.trim() !== ''
  )
  if (clean.length === 0) return ''

  const picked = clean.slice(0, topK)
  const header = '<memoryEcho>\n' + PREAMBLE
  const footer = '\n</memoryEcho>'
  const bodyBudget = maxChars - header.length - footer.length - NOTICE_RESERVE
  if (bodyBudget < 40) return '' // 预算小到放不下任何一条 ⇒ 宁可不注入也不给烂壳

  const lines = []
  let used = 0
  let kept = 0
  let cutAny = false
  let overflow = false
  for (const h of picked) {
    let snippet = String(h.body).replace(/\s+/g, ' ').trim()
    let cut = false
    if (snippet.length > perHitChars) { snippet = snippet.slice(0, perHitChars); cut = true }
    const line = '[楼 ' + String(Number(h.floor)).padStart(4, '0') + '] ' + snippet + (cut ? CUT_MARK : '')
    const remain = bodyBudget - used
    if (line.length <= remain) {
      lines.push(line)
      used += line.length + 1
      kept++
      if (cut) cutAny = true
    } else {
      const room = remain - CUT_MARK.length
      if (room >= 40) {
        lines.push('[楼 ' + String(Number(h.floor)).padStart(4, '0') + '] ' + snippet.slice(0, room) + CUT_MARK)
        kept++
      }
      cutAny = true
      overflow = true
      break // 预算见底，后面的条一律放不下
    }
  }

  const dropped = clean.length - kept
  let out = header
  for (const line of lines) out += '\n' + line
  if (cutAny || dropped > 0) out += '\n' + overflowNotice(maxChars, topK, kept, clean.length)
  out += footer
  // 防御性兜底：任何路径下都不许超预算（真超了就硬切并补标注 —— 仍然不静默）
  if (out.length > maxChars) out = out.slice(0, maxChars - 1) + '…'
  return out
}

/**
 * createEchoInject({ getConfig, storageDir, query, loadFloors? }) →
 *   { section: { name:'dma:echo', order:54, text }, refresh() }
 *
 * 注入项（全部由调用方给，本模块不读任何全局状态）：
 *   getConfig() → { enabled, maxChars, topK, perHitChars, minDf, maxDf, maxCandidates, timeBudgetMs }
 *                 （enabled 缺省/非 true ⇒ 回响关闭，text 恒为 ''；其余缺省用内置默认）
 *   storageDir  → 回响库所在目录（<storageDir>/echo-index.db；绝不写死路径）
 *   query()     → { text: 最近一轮 user+assistant 的文本,
 *                   excludeFloors?: [最新一轮所在楼层号…], source?: 周目标识 } | null
 *   loadFloors? () → [{ floor, text, source? }]（可选：装配期顺带增量入库归档楼层；
 *                     幂等、只读源；不给 ⇒ 只查库里已有的）
 *
 * refresh()：同步、有界、fail-silent —— 任何异常 ⇒ section.text=''（绝不阻塞主对话）。
 */
export function createEchoInject(deps = {}) {
  const getConfig = typeof deps.getConfig === 'function' ? deps.getConfig : () => ({})
  const query = typeof deps.query === 'function' ? deps.query : () => null
  const loadFloors = typeof deps.loadFloors === 'function' ? deps.loadFloors : null
  const storageDir = deps.storageDir

  const DEFAULTS = {
    maxChars: 1200,
    perHitChars: 280,
    topK: 5,
    minDf: 2,
    maxDf: 12,
    maxCandidates: 12,
    timeBudgetMs: 1000,
  }

  const section = { name: 'dma:echo', order: 54, text: '' }

  // 打开失败的缓存：60s 内不重试（库坏不是每轮能好的），过了再试一次
  let cachedIndex = null
  let lastFailAt = 0
  function ensureIndex() {
    if (cachedIndex) return cachedIndex
    const now = Date.now()
    if (lastFailAt && now - lastFailAt < 60_000) return null
    const r = openEchoIndexSafe({ storageDir, filename: ECHO_DB_FILENAME })
    if (r.index) { cachedIndex = r.index; lastFailAt = 0; return cachedIndex }
    lastFailAt = now
    return null
  }

  function refresh() {
    section.text = ''
    try {
      const cfg = { ...DEFAULTS, ...(getConfig() ?? {}) }
      if (cfg.enabled !== true) return section // 开关默认 false：关着就绝不注入

      const q = query() ?? null
      if (!q || typeof q.text !== 'string' || q.text.trim() === '') return section

      const t0 = Date.now()
      const budgetMs = Math.max(1, Math.trunc(Number(cfg.timeBudgetMs) || DEFAULTS.timeBudgetMs))

      const index = ensureIndex()
      if (!index) return section // 库不可用 ⇒ 本轮不注入（fail-silent，E8 同款语义）

      // 增量入库（可选、幂等）：只在时间预算内做，绝不拖长装配
      if (loadFloors && Date.now() - t0 < budgetMs / 2) {
        index.ingestFloors(loadFloors(), {})
      }

      // 抽候选 → df 筛 → 查询（每步都在预算外再加一道闸：超了就用已有进度继续）
      const cands = extractCandidates(q.text)
      const picked = index.filterCandidatesByDf(cands, {
        minDf: cfg.minDf, maxDf: cfg.maxDf, maxCandidates: cfg.maxCandidates,
      })
      const r = searchEchoSafely(index, {
        candidates: picked,
        excludeFloors: Array.isArray(q.excludeFloors) ? q.excludeFloors : [],
        source: q.source ?? null,
        topK: cfg.topK,
      })
      section.text = buildEchoText(r.hits, {
        maxChars: cfg.maxChars, perHitChars: cfg.perHitChars, topK: cfg.topK,
      })
    } catch {
      section.text = '' // 回响是增强：失败就静默跳过本轮，绝不抛、绝不阻塞主对话
    }
    return section
  }

  return { section, refresh }
}
