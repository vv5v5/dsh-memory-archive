// ---------------------------------------------------------------------------
// echo-index —— 「记忆回响」引擎（D2）：本地 FTS5(trigram) 预扫**归档原文**。
//
// 语料 = 周目归档 archive/floors/NNNN.json 的 `mes`（键名已按真文件核对）。
// 实测依据（03-调研与报告/实测-FTS5本地回响-20260915.md，本模块的验收基线）：
//   254 楼 / 105,746 字 → 建索引 32ms、查询 0.01ms、回声命中率 100%；
//   ≤2 字查询必 0 命中 ⇒ 抽取器只产出 ≥3 字窗口；摘要字面保留率仅 1.6%/4.2% ⇒ 摘要不入索引。
// ⛔ 只索引归档：不索引 DSH 会话、不索引摘要；入库只读归档、绝不改归档一个字节。
// ⛔ 存储根 storageDir 一律由调用方注入（运行时来自 lib/index.js 的 storageDir()），
//    本模块绝不写死任何家目录路径。
//
// 隐私纪律：本模块没有 console/log —— 日志面不存在正文外泄；对外的错误对象只带
//   SQLite/IO 的短消息，不带任何正文片段。
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 库文件名（放在调用方注入的 storageDir 下）。 */
export const ECHO_DB_FILENAME = 'echo-index.db'

/** 白名单字符：CJK（含扩展 A 区/兼容区）+ 英文字母数字 —— 与实测脚本 isCJK 同一口径。 */
const WHITELIST = /[\u3400-\u9fff\uf900-\ufaffA-Za-z0-9]/

/**
 * 内容哈希口径（写死，以后能复算）：
 *   sha256( String(text) 的 UTF-8 字节 ) 的完整 64 位小写 hex。
 * 不 trim、不做任何 Unicode 归一化 —— 归档字符串原样进哈希。
 * docKey = 楼层标识（见 makeDocKey），meta 表里 docKey → contentHash，哈希不变即跳过入库。
 */
export function contentHashOf(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

/** 楼层文件名惯例与 lib/collect.js 的 floorFileName 对齐：4 位补零 + .json。 */
function pad4(n) {
  return String(n).padStart(4, '0')
}

/**
 * docKey = 楼层标识：`<source>/floors/<NNNN>.json`（source 缺省时省略前缀）。
 * source 由调用方给（周目归档的标识，例如 `<charId>/<playthroughId>`）；同一库可装多个周目。
 */
export function makeDocKey(source, floor) {
  return (source ? String(source) + '/' : '') + 'floors/' + pad4(floor) + '.json'
}

/**
 * 规则 2 的前半：按非白名单字符把文本切段。
 * 标点、空白、换行都是切点 —— 窗口永远不跨它们（E2）。
 */
export function extractSegments(text) {
  const out = []
  let cur = []
  for (const ch of String(text ?? '')) {
    if (WHITELIST.test(ch)) cur.push(ch)
    else if (cur.length > 0) { out.push(cur.join('')); cur = [] }
  }
  if (cur.length > 0) out.push(cur.join(''))
  return out
}

/**
 * 候选抽取（纯函数）：extractCandidates(text, { minLen, maxLen }) → string[]
 * 三条写死规则：
 *  1) 窗口长度 L ∈ [minLen, maxLen]，默认 minLen = maxLen = 3（= 全部 3-gram，与实测基线同口径）；
 *     默认参数下 <3 的窗口一律不产出（trigram 下 ≤2 字查询必 0 命中，实测复核）。
 *  2) 先按非白名单字符切段、再在段内滑窗 —— 窗口绝不跨标点/空白/换行。
 *  3) 去重且保首次出现序（同一候选只出现一次，顺序确定 ⇒ 自检可复现）。
 * minLen/maxLen 可被调用方覆盖（仅供自检台做反证：证明长度门槛是承重的）。
 */
export function extractCandidates(text, opts = {}) {
  const minLen = Math.max(1, Math.trunc(Number(opts.minLen ?? 3)) || 3)
  const maxLen = Math.max(minLen, Math.trunc(Number(opts.maxLen ?? opts.minLen ?? minLen)) || minLen)
  const seen = new Set()
  const out = []
  for (const seg of extractSegments(text)) {
    const chars = Array.from(seg)
    for (let len = minLen; len <= maxLen; len++) {
      if (chars.length < len) break
      for (let i = 0; i + len <= chars.length; i++) {
        const w = chars.slice(i, i + len).join('')
        if (!seen.has(w)) { seen.add(w); out.push(w) }
      }
    }
  }
  return out
}

/**
 * FTS5 MATCH 的短语安全包装：`"…"`，内部 `"` 翻倍。
 * 候选本就只含白名单字符，这里只是防御（⇒ 绝无裸多词查询，规避 FTS5 隐式 AND/OR 歧义）。
 */
function quotePhrase(s) {
  return '"' + String(s).replaceAll('"', '""') + '"'
}

const SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS echo USING fts5(body, docKey UNINDEXED, floor UNINDEXED, source UNINDEXED, tokenize='trigram');
CREATE TABLE IF NOT EXISTS meta (
  docKey TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  floor INTEGER NOT NULL,
  contentHash TEXT NOT NULL,
  chars INTEGER NOT NULL,
  ingestedAt TEXT NOT NULL
);
`

/** 单候选 MATCH 的防御性行数上限（候选已过 df≤maxDf 筛，正常远达不到）。 */
const MATCH_ROW_LIMIT = 400

export class EchoIndex {
  /** @param {DatabaseSync} db 已打开、已建表的库 */
  constructor(db) {
    this.db = db
    this.stIns = db.prepare('INSERT INTO echo(body, docKey, floor, source) VALUES(?, ?, ?, ?)')
    this.stDel = db.prepare('DELETE FROM echo WHERE docKey = ?')
    this.stMetaGet = db.prepare('SELECT contentHash FROM meta WHERE docKey = ?')
    this.stMetaUpsert = db.prepare(
      'INSERT INTO meta(docKey, source, floor, contentHash, chars, ingestedAt) VALUES(?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(docKey) DO UPDATE SET source=excluded.source, floor=excluded.floor, ' +
      'contentHash=excluded.contentHash, chars=excluded.chars, ingestedAt=excluded.ingestedAt'
    )
    this.stMatch = db.prepare('SELECT docKey, floor, source, body FROM echo WHERE echo MATCH ? LIMIT ' + MATCH_ROW_LIMIT)
    this.stDf = db.prepare('SELECT count(*) AS n FROM echo WHERE echo MATCH ?')
  }

  /**
   * 增量幂等入库。docs: [{ floor:Number, text:String, source?:String }]
   * 规则：contentHash 相同 ⇒ 跳过（不重写 FTS 行，meta 不动）；哈希变了 ⇒ 先删该 docKey 的
   * FTS 行再插新行（同一 docKey 永远只有一行），meta 走 UPSERT。
   * opts.force    —— 跳过哈希比对、整批重写（仅供自检台反证 E4 用）。
   * opts.replace  —— 换内容时是否删旧行（仅供自检台反证 E5 用；默认 true = 替换）。
   * 返回 { inserted, replaced, skipped, empty, docs, chars }（纯计数，无正文）。
   */
  ingestFloors(docs, opts = {}) {
    const force = opts.force === true
    const replace = opts.replace !== false
    const res = { inserted: 0, replaced: 0, skipped: 0, empty: 0, docs: 0, chars: 0 }
    const now = new Date().toISOString()
    this.db.exec('BEGIN')
    try {
      for (const d of Array.isArray(docs) ? docs : []) {
        if (!d || !Number.isFinite(Number(d.floor))) continue
        const text = typeof d.text === 'string' ? d.text : ''
        res.docs++
        if (text === '') { res.empty++; continue }
        const docKey = d.docKey != null ? String(d.docKey) : makeDocKey(d.source ?? '', Number(d.floor))
        const hash = contentHashOf(text)
        res.chars += text.length
        const prev = force ? null : (this.stMetaGet.get(docKey) ?? null)
        if (prev != null && prev.contentHash === hash) { res.skipped++; continue }
        if (replace) this.stDel.run(docKey)
        this.stIns.run(text, docKey, Number(d.floor), String(d.source ?? ''))
        this.stMetaUpsert.run(docKey, String(d.source ?? ''), Number(d.floor), hash, text.length, now)
        if (prev != null) res.replaced++
        else res.inserted++
      }
      this.db.exec('COMMIT')
    } catch (e) {
      try { this.db.exec('ROLLBACK') } catch {}
      throw e
    }
    return res
  }

  /** 一批候选在索引里的文档频：candidate → 命中楼数（df）。 */
  candidateDf(candidates) {
    const df = new Map()
    for (const c of candidates) {
      const row = this.stDf.get(quotePhrase(c))
      df.set(c, Number(row?.n ?? 0))
    }
    return df
  }

  /**
   * df 窗口过滤 + 居中排序（纯查询，不写库）。
   * 只保留 df ∈ [minDf, maxDf]（默认 2..12，实测的"有回声价值"层）；
   * 排序：|df − 中点| 小者优先（df 居中的先查），同分 df 小者优先，再按传入序稳定排序；
   * 取前 maxCandidates（默认 12）个。
   */
  filterCandidatesByDf(candidates, opts = {}) {
    const minDf = Math.max(1, Math.trunc(Number(opts.minDf ?? 2)))
    const maxDf = Math.max(minDf, Math.trunc(Number(opts.maxDf ?? 12)))
    const maxCandidates = Math.max(1, Math.trunc(Number(opts.maxCandidates ?? 12)))
    const mid = (minDf + maxDf) / 2
    const uniq = [...new Set(candidates)]
    const scored = []
    uniq.forEach((c, order) => {
      const df = this.candidateDf([c]).get(c) ?? 0
      if (df >= minDf && df <= maxDf) scored.push({ c, df, order })
    })
    scored.sort((a, b) =>
      (Math.abs(a.df - mid) - Math.abs(b.df - mid)) ||
      (a.df - b.df) ||
      (a.order - b.order)
    )
    return scored.slice(0, maxCandidates).map((s) => s.c)
  }

  /**
   * 查询：每个候选一次短语 MATCH（⛔ 不用裸多词查询）；合并结果按
   * 「命中候选数多者优先 → 楼层新者优先（就近）→ docKey 字典序（确定性）」排序，取 topK。
   * excludeFloors：最新一轮所在的楼层号 —— 这些楼绝不出现在回响里（E6，排除自身）。
   * source：给了就只搜该周目（docKey 里带的标识）。
   * hits: [{ docKey, source, floor, body, hitCount, hitCandidates }]
   */
  search({ candidates, excludeFloors = [], source = null, topK = 5 } = {}) {
    const excl = new Set((Array.isArray(excludeFloors) ? excludeFloors : []).map((n) => Number(n)))
    const byKey = new Map()
    for (const c of Array.isArray(candidates) ? candidates : []) {
      const rows = this.stMatch.all(quotePhrase(c))
      for (const r of rows) {
        const floor = Number(r.floor)
        if (excl.has(floor)) continue
        if (source != null && String(r.source) !== String(source)) continue
        const key = String(r.docKey)
        let e = byKey.get(key)
        if (!e) {
          e = { docKey: key, source: String(r.source), floor, body: String(r.body), hitCandidates: [] }
          byKey.set(key, e)
        }
        e.hitCandidates.push(String(c))
      }
    }
    const hits = [...byKey.values()]
    for (const h of hits) h.hitCount = h.hitCandidates.length
    hits.sort((a, b) =>
      (b.hitCount - a.hitCount) ||
      (b.floor - a.floor) ||
      (a.docKey < b.docKey ? -1 : a.docKey > b.docKey ? 1 : 0)
    )
    return hits.slice(0, Math.max(1, Math.trunc(Number(topK) || 5)))
  }

  /** meta 行数（已入库楼层数，含被替换过的）。 */
  metaCount() {
    return Number(this.db.prepare('SELECT count(*) AS n FROM meta').get()?.n ?? 0)
  }

  /** 某 docKey 在 FTS 里的行数（健康时恒为 1；E5 用它证明"替换"而不是"新增"）。 */
  rowVersions(docKey) {
    return Number(this.db.prepare('SELECT count(*) AS n FROM echo WHERE docKey = ?').get(String(docKey))?.n ?? 0)
  }

  /** 索引体积（PRAGMA page_count × page_size），只用于报告/自检的聚合数字。 */
  indexBytes() {
    const pages = this.db.prepare('PRAGMA page_count').get()
    const size = this.db.prepare('PRAGMA page_size').get()
    return Number(Object.values(pages)[0]) * Number(Object.values(size)[0])
  }

  close() {
    this.db.close()
  }
}

/**
 * 打开（必要时创建）回响索引库：<storageDir>/<filename>。
 * ⛔ storageDir 必须由调用方注入；本函数只做 mkdir -p + 建表。库坏了会 throw（要走
 *   fail-silent 请用 openEchoIndexSafe / searchEchoSafely —— 回响是增强，失败该静默跳过）。
 */
export function openEchoIndex({ storageDir, filename = ECHO_DB_FILENAME } = {}) {
  if (!storageDir || typeof storageDir !== 'string') {
    throw new Error('echo-index: storageDir 必须由调用方注入（绝不写死路径）')
  }
  mkdirSync(storageDir, { recursive: true })
  const db = new DatabaseSync(join(storageDir, filename))
  db.exec(SCHEMA_SQL)
  return new EchoIndex(db)
}

/** openEchoIndex 的不抛版本：{ index, error }，坏了给 null + 错误（E8）。 */
export function openEchoIndexSafe(opts) {
  try {
    return { index: openEchoIndex(opts), error: null }
  } catch (e) {
    return { index: null, error: e }
  }
}

/**
 * 查询的不抛版本（E8 fail-silent）：任何异常（库损坏/表缺失/参数坏）都返回
 * { hits: [], failed: true, error }，绝不向上抛 —— 回响是增强，失败就静默跳过本轮。
 */
export function searchEchoSafely(indexOrNull, request) {
  try {
    if (!indexOrNull || typeof indexOrNull.search !== 'function') {
      return { hits: [], failed: true, error: new Error('echo-index: 索引不可用') }
    }
    return { hits: indexOrNull.search(request), failed: false, error: null }
  } catch (e) {
    return { hits: [], failed: true, error: e }
  }
}

/**
 * 从磁盘读一份归档楼层目录（archive/floors/）：只读，绝不写。
 * 按真文件键名取：`_floor`（楼号）、`mes`（正文）。坏文件跳过、不中断。
 * 返回 [{ floor, text }]，按楼号升序。selftest 与本地归档直读用；线上接线走注入。
 */
export function readArchiveFloors(floorsDir) {
  const out = []
  let files = []
  try {
    files = readdirSync(floorsDir).filter((f) => f.endsWith('.json')).sort()
  } catch {
    return out
  }
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(join(floorsDir, f), 'utf8'))
      const floor = Number(j?._floor)
      if (!Number.isFinite(floor)) continue
      out.push({ floor, text: typeof j?.mes === 'string' ? j.mes : '' })
    } catch {}
  }
  out.sort((a, b) => a.floor - b.floor)
  return out
}
