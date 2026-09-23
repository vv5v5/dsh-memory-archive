/**
 * collect —— 周目归档写入器（「收纳」的落库半边 = manifest 里 writer 曾经写着
 * "pending（写入者②）" 的那个写入者）。
 *
 * 职责：把调用方给定的一段楼层 + 一条摘要写进 Tavern 工作区的周目归档目录
 * （<charId>/<playthroughId>/archive/ 下的 floors/ 与 summaries/，含 index.json），
 * 并增量更新 manifest.json 的 summaries.count / writer。⛔ 不碰 visibility.json、
 * 不碰 INDEX.md 等说明件、不碰占位/遮蔽（那是 DSH 官方 compaction 的职责）。
 *
 * 结构（与真机归档逐字对齐，字段一个不自创）：
 *   floors/NNNN.json      {_floor, is_user, is_system, mes, name}（楼号 4 位补零）
 *   summaries/<id>.md     纯文本摘要正文（<id> 缺省 s-<from 4 位>-<to 4 位>）
 *   summaries/index.json  {schemaVersion:1, kind, updatedAt, entries:[…]} —— 追加一条（★ 或 N 条）
 *   manifest.json         只增量改 summaries.count 与 summaries.writer
 *
 * ★★ 2026-09-22「摘要按段切片」（用户口径：「摘要没做切分吗，我看到是一大段一条。但内部是有分段的。
 *   这回影响向量检索吗」—— 影响：检索侧的粒度就是「一个摘要文件 = 一条切片」，见 A2 头注）：
 *   输入多了一条**追加式**能力 `summaries: [{id?, text, model?, meta?}, …]` —— 一次调用 = 楼层只写
 *   一遍 + **每份一张 `.md`** + 索引**追加 N 条** + manifest.count = 追加后的条目数（口径不变，
 *   只是 +N）。落点口径仍只有 summaryPathOf 一处（每份传自己的 `id`）。`summary`（单份）那条老路
 *   **逐字保持原样**（同一份代码路径：内部统一成「一份的数组」，N=1 时产出的计划/落盘字节与从前一致）；
 *   两路都传 ⇒ COLLECT_INVALID（⛔ 不猜该用哪个）。
 *
 * 硬纪律：
 *   - 响应一律不回显正文：证明「写了什么」只用 字节数 + sha256 + 路径。
 *   - 顺序：建目录 → 楼层 → 摘要正文 → 索引（最后写，索引没写上 = 没收）→ manifest。
 *   - 索引双读乐观锁：读 → 追加 → 写前再读一次比 sha256 → 变了就 409（⛔ 不用
 *     expectedRevision 参数 —— index.json 不是 managed document，官方接口对它不收该参）。
 *   - fail-closed：任何一步失败都如实报告已落盘清单（partial），绝不假装成功、
 *     绝不回滚（append-only 归档，回滚比孤儿文件更危险）。
 *   - 字节上限：单文件 1 MiB、单计划 ≤512 楼、请求体 ≤8 MiB、单次读 ≤8 MiB
 *     （mem-budget 的教训：任何一次读入都要有界）。
 *   - 零相对导入：只用 node:crypto（宿主半侧经动态 import 挂载，保持可独立加载）。
 *
 * @license CC-BY-NC-4.0 (Attribution-NonCommercial 4.0 International)
 * 含 DeepSeek Harness 派生部分（MIT, Copyright (c) 2026 DeepSeek）时该部分保留 MIT。
 */

import { createHash, randomBytes } from 'node:crypto'

export const collectConstants = Object.freeze({
  planTtlMs: 10 * 60 * 1000, // plan 的有效期：过期必须重新 plan（floor/index 指纹会漂）
  maxFloorsPerPlan: 512,
  maxBytesPerFile: 1024 * 1024,
  indexKind: 'dsh-tavern-l2-summaries',
  maxTargets: 200, // targets 发现时最多细查多少个周目（防大 catalog 拖住宿主）
  maxReadBytes: 8 * 1024 * 1024, // 单次从 Tavern 读回的字节上限（catalog/index/manifest 共用）
  bodyLimit: 8 * 1024 * 1024, // plan/apply 请求体字节上限（本端点自带，不动全局 BODY_LIMIT）
})

const MANIFEST_WRITER = 'magictarven/collect'
const FLOOR_FILE_RE = /^(\d{4,})\.json$/
const SUMMARY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function failCode(code, message, extra) {
  const e = new Error(message)
  e.code = code
  if (extra && typeof extra === 'object') Object.assign(e, extra)
  return e
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function sha256Hex(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

function pad4(n) {
  return String(n).padStart(4, '0')
}

function floorFileName(n) {
  return pad4(n) + '.json'
}

/** 楼层文档：键序与真机归档一致（_floor, is_user, is_system, mes, name）。 */
function floorDocText(f) {
  return JSON.stringify({
    _floor: f.floor,
    is_user: f.isUser === true,
    is_system: f.isSystem === true,
    mes: f.mes,
    name: typeof f.name === 'string' ? f.name : '',
  })
}

/**
 * Tavern 工作区文件面的薄客户端（基址 = 本宿主同源地址，见 tavernBaseFromReq）。
 *   list(dir)              → { ok, list:[{path,type}] }（path 是带前缀的全相对路径）
 *   read(path[, capBytes]) → { content }（超上限抛 TAVERN_FILE_TOO_LARGE）
 *   write(path, content)   → { ok }（⛔ 不传 expectedRevision —— 只有 catalog/timeline
 *                             是 managed document，其余文件官方接口本就不收该参）
 *   mkdir(path)            → { ok }（「已存在」吞掉：官方 createDir 本就幂等，
 *                             其它实现若报错则再 list 一次确认存在即放行）
 * 所有错误都带 code：TAVERN_UNREACHABLE（网络/超时）或 TAVERN_HTTP_<status>。
 */
export function createTavernClient({ baseUrl, fetchImpl, timeoutMs = 15000, maxReadBytes } = {}) {
  if (typeof baseUrl !== 'string' || baseUrl === '') {
    throw failCode('TAVERN_CONFIG', 'createTavernClient 缺 baseUrl')
  }
  const base = baseUrl.replace(/\/+$/, '')
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : (u, o) => fetch(u, o)
  const readCap = Number.isFinite(maxReadBytes) ? maxReadBytes : collectConstants.maxReadBytes
  const FILES = base + '/pmp-dsh-tavern/api/v2/workspace/files'
  const DIRS = base + '/pmp-dsh-tavern/api/v2/workspace/dirs'
  // 与 base 严格同源（base 本就来自 tavernBaseFromReq(req) 的 host，不另造地址）
  const baseOrigin = new URL(base).origin

  async function request(method, url, bodyObj) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    // dsh-tavern 外层 secureTavernApi（tavern-loader/src/api-security.js:119-123）的 sameOrigin()
    // 规则：变更方法（非 GET/HEAD/OPTIONS）必须带 Origin 且其 host === 请求 Host，缺失/跨源
    // 一律 403 TAVERN_API_ORIGIN_FORBIDDEN。Node fetch 默认不发 Origin ⇒ 写入必 403（实测）。
    // ⛔ 不伪造 sec-fetch-site（那是浏览器语义，服务端不该装）；GET 不带（读写面行为最小化）。
    const headers = bodyObj !== undefined ? { 'content-type': 'application/json' } : {}
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') headers.origin = baseOrigin
    let resp
    try {
      resp = await doFetch(url, {
        method,
        headers,
        body: bodyObj !== undefined ? JSON.stringify(bodyObj) : undefined,
        signal: ctrl.signal,
      })
    } catch (e) {
      const why = e && (e.name === 'AbortError' || e.name === 'TimeoutError')
        ? '超时（' + timeoutMs + 'ms）'
        : String((e && e.message) || e)
      throw failCode('TAVERN_UNREACHABLE', 'Tavern 工作区请求失败：' + why)
    } finally {
      clearTimeout(timer)
    }
    let data = null
    try {
      data = await resp.json()
    } catch {}
    if (!resp.ok) {
      const serverCode = isPlainObject(data) && isPlainObject(data.error) && typeof data.error.code === 'string'
        ? data.error.code
        : ''
      throw failCode('TAVERN_HTTP_' + resp.status, 'Tavern 工作区返回 HTTP ' + resp.status + (serverCode ? '（' + serverCode + '）' : ''))
    }
    return data
  }

  async function list(relDir) {
    const data = await request('GET', FILES + '?list=' + encodeURIComponent(relDir))
    if (!isPlainObject(data) || !Array.isArray(data.list)) {
      throw failCode('TAVERN_BAD_SHAPE', '工作区 list 接口返回形状不识')
    }
    return data
  }

  async function read(relPath, capBytes) {
    const data = await request('GET', FILES + '?path=' + encodeURIComponent(relPath))
    const content = isPlainObject(data) && typeof data.content === 'string' ? data.content : null
    if (content === null) throw failCode('TAVERN_BAD_SHAPE', '工作区文件接口返回形状不识（缺 content）')
    if (Buffer.byteLength(content, 'utf8') > (capBytes ?? readCap)) {
      throw failCode('TAVERN_FILE_TOO_LARGE', '文件超过读取字节上限：' + relPath)
    }
    return { content }
  }

  async function write(relPath, content) {
    if (typeof content !== 'string') throw failCode('TAVERN_CONFIG', 'write 只接受字符串内容')
    if (Buffer.byteLength(content, 'utf8') > collectConstants.maxBytesPerFile) {
      throw failCode('TAVERN_FILE_TOO_LARGE', '写入内容超过单文件字节上限：' + relPath)
    }
    await request('PUT', FILES + '?path=' + encodeURIComponent(relPath), { content })
    return { ok: true }
  }

  async function mkdir(relPath) {
    try {
      return await request('POST', DIRS, { path: relPath })
    } catch (e) {
      try {
        await list(relPath)
        return { ok: true }
      } catch {
        throw e
      }
    }
  }

  return { list, read, write, mkdir }
}

/** 与 index.js probeTavern 同源的基址推导：host 优先，兜底 127.0.0.1:<localPort>。⛔ 不写死端口。 */
export function tavernBaseFromReq(req) {
  const host = req && req.headers && req.headers.host
  const port = req && req.socket && req.socket.localPort
  return 'http://' + (host ? host : '127.0.0.1' + (port ? ':' + port : ''))
}

function isMissingErr(e) {
  return Boolean(e) && e.code === 'TAVERN_HTTP_404'
}

/** 读不到给 null（404 = 不存在），其余错误照抛。 */
async function readIfExists(tavern, relPath, capBytes) {
  try {
    return await tavern.read(relPath, capBytes)
  } catch (e) {
    if (isMissingErr(e)) return null
    throw e
  }
}

function parseJsonOrNull(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * catalog.json 的一条 playthrough → 归档定位。path 形如
 * "<charId>/<playthroughId>/timeline.json"；ext.pmpDshTavern 里有 characterId 等。
 * 解析不了给 null（绝不抛、绝不猜）。
 */
function catalogTarget(pt) {
  if (!isPlainObject(pt)) return null
  const p = typeof pt.path === 'string' ? pt.path : ''
  const segs = p.split('/').filter(Boolean)
  if (segs.length < 3 || !segs[segs.length - 1].endsWith('.json')) return null
  const ext = isPlainObject(pt.ext) && isPlainObject(pt.ext.pmpDshTavern) ? pt.ext.pmpDshTavern : {}
  const characterId =
    typeof ext.characterId === 'string' && ext.characterId !== '' ? ext.characterId : segs[0]
  const playthroughId = segs[segs.length - 2]
  if (!characterId || !playthroughId) return null
  const title =
    typeof pt.title === 'string' && pt.title !== ''
      ? pt.title
      : typeof ext.characterName === 'string' && ext.characterName !== ''
        ? ext.characterName
        : null
  return {
    characterId,
    playthroughId,
    title,
    archiveRel: characterId + '/' + playthroughId + '/archive',
  }
}

/**
 * 输入校验（违规抛 Error{code,message}）。口径：
 *   target.characterId/playthroughId 非空且不含路径分隔符（目录穿越防御）；
 *   range 0 起闭区间 from<=to；floors 非空、floor 在区间内、不重复、mes 非空且不超限；
 *   summary.text 非空且不超限；summary.id（若给）只允许 [A-Za-z0-9._-]。
 */
export function validatePlanInput(input) {
  const C = collectConstants
  const bad = (code, message) => {
    throw failCode(code, message)
  }
  if (!isPlainObject(input)) bad('COLLECT_INVALID', '请求体必须是 JSON 对象')
  const target = input.target
  if (!isPlainObject(target)) bad('COLLECT_INVALID', '缺 target（{characterId, playthroughId}）')
  for (const k of ['characterId', 'playthroughId']) {
    const v = target[k]
    if (typeof v !== 'string' || v.trim() === '') bad('COLLECT_INVALID', 'target.' + k + ' 必须是非空字符串')
    if (v.includes('/') || v.includes('\\') || v.includes('..')) bad('COLLECT_INVALID', 'target.' + k + ' 含非法字符')
  }
  const range = input.range
  if (!isPlainObject(range)) bad('COLLECT_RANGE_INVALID', '缺 range（{fromFloor, toFloor}）')
  const from = range.fromFloor
  const to = range.toFloor
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
    bad('COLLECT_RANGE_INVALID', 'range.fromFloor/toFloor 必须是 0 起的整数且 fromFloor <= toFloor（闭区间）')
  }
  const floors = input.floors
  if (!Array.isArray(floors) || floors.length === 0) bad('COLLECT_INVALID', 'floors 必须是非空数组')
  if (floors.length > C.maxFloorsPerPlan) bad('COLLECT_INVALID', 'floors 超过单计划上限 ' + C.maxFloorsPerPlan)
  const seen = new Set()
  for (const f of floors) {
    if (!isPlainObject(f)) bad('COLLECT_INVALID', 'floors 里每项必须是对象')
    if (!Number.isInteger(f.floor) || f.floor < 0) bad('COLLECT_INVALID', 'floor 必须是非负整数')
    if (f.floor < from || f.floor > to) bad('COLLECT_RANGE_INVALID', 'floor ' + f.floor + ' 不在 range 内')
    if (typeof f.mes !== 'string' || f.mes === '') bad('COLLECT_INVALID', 'floor ' + f.floor + ' 缺 mes')
    if (Buffer.byteLength(f.mes, 'utf8') > C.maxBytesPerFile) bad('COLLECT_INVALID', 'floor ' + f.floor + ' 的 mes 超过单文件字节上限')
    if (seen.has(f.floor)) bad('COLLECT_INVALID', 'floor ' + f.floor + ' 重复')
    seen.add(f.floor)
  }
  const summary = input.summary
  // ★ 2026-09-22「摘要按段切片」：summaries（数组，一次追加 N 份、每份自带 id/落点）与 summary
  //   （单份，老路）二选一 —— 两路都传、或 summaries 形状不对，都由 summaryEntriesOf 可读地拒
  //   （COLLECT_INVALID，⛔ 不猜该用哪个）。老路那几行的判据与文案一个字没动。
  if (input.summaries !== undefined && input.summaries !== null) {
    summaryEntriesOf(input, input.target, input.range)
  } else {
    if (!isPlainObject(summary) || typeof summary.text !== 'string' || summary.text === '') {
      bad('COLLECT_INVALID', 'summary.text 必须是非空字符串')
    }
    if (Buffer.byteLength(summary.text, 'utf8') > C.maxBytesPerFile) bad('COLLECT_INVALID', 'summary.text 超过单文件字节上限')
    if (summary.id !== undefined && summary.id !== null) {
      if (typeof summary.id !== 'string' || !SUMMARY_ID_RE.test(summary.id)) bad('COLLECT_INVALID', 'summary.id 只允许 [A-Za-z0-9._-] 且不以符号开头')
    }
    if (summary.model !== undefined && summary.model !== null && typeof summary.model !== 'string') {
      bad('COLLECT_INVALID', 'summary.model 必须是字符串')
    }
  }
  if (input.overwrite !== undefined && typeof input.overwrite !== 'boolean') bad('COLLECT_INVALID', 'overwrite 必须是布尔值')
  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') bad('COLLECT_INVALID', 'dryRun 必须是布尔值')
}

/**
 * 摘要正文的落点（**唯一口径**）：`planCollect`、`observeArchive` 的两个调用方都必须用这一个式子。
 * 2026-09-16 事故：导入侧自己拼路径、而 `expectedRevisions[摘要]` 被写死 `null`，于是"同一份源重导"
 * （planId 相同 ⇒ 摘要文件已存在）在写前重核里被误判成"plan 之后被改过" ⇒ 409 乐观锁。
 */
export function summaryPathOf(target, summary, range) {
  const from = range && Number.isInteger(range.fromFloor) ? range.fromFloor : 0
  const to = range && Number.isInteger(range.toFloor) ? range.toFloor : from
  const id = summary && typeof summary.id === 'string' && summary.id !== ''
    ? summary.id
    : 's-' + pad4(from) + '-' + pad4(to)
  return { id, path: target.characterId + '/' + target.playthroughId + '/archive/summaries/' + id + '.md' }
}

/** 一次追加 N 份（summaries）时，同一份落点被两项声称 ⇒ 后写的会盖掉先写的、索引两条指向同一文件。 */
const SUMMARIES_SAME_PATH_MSG = 'summaries 里有两项的落点是同一个摘要文件（每项必须给出各自不同的 id）'
const SUMMARIES_BOTH_MSG = 'summary 与 summaries 只能给一个（summary = 一份摘要；summaries = 一次追加 N 份、每份自带 id），⛔ 不替你挑'

/**
 * ★★ 2026-09-22「摘要按段切片」：`summaries`（数组）→ 归一化的条目列表
 * `[{id, path, text, model, meta}, …]` —— 每项 = 一份摘要正文 + **它自己的**落点。
 *
 * 落点口径**只有 summaryPathOf 一处**（每项把自己的 `id` 交给它；缺 id 时两项都会落到同一个
 * `s-<from>-<to>.md` ⇒ 这里如实拒，⛔ 不替你改名）。校验与 planCollect 共用本函数，
 * 于是「必填/上限/id 词法/落点唯一」只有一份实现，报错码统一 COLLECT_INVALID。
 *
 * ⛔ `input.summary`（单份）同时给出来 ⇒ 可读地拒（不猜该用哪个）。
 * @returns {{id: string, path: string, text: string, model: string|null, meta: object|null}[]}
 */
function summaryEntriesOf(input, target, range) {
  const C = collectConstants
  const bad = (message) => {
    throw failCode('COLLECT_INVALID', message)
  }
  const list = input.summaries
  if (isPlainObject(input.summary)) bad(SUMMARIES_BOTH_MSG)
  if (!Array.isArray(list) || list.length === 0) bad('summaries 必须是非空数组（每项 = 一份摘要条目 + 它自己的 id/落点）')
  const entries = []
  const seenPath = new Set()
  for (const s of list) {
    if (!isPlainObject(s) || typeof s.text !== 'string' || s.text === '') bad('summaries 里每项必须是对象且 text 为非空字符串')
    if (Buffer.byteLength(s.text, 'utf8') > C.maxBytesPerFile) bad('summaries 里每项 text 都不得超过单文件字节上限')
    if (s.id !== undefined && s.id !== null && (typeof s.id !== 'string' || !SUMMARY_ID_RE.test(s.id))) {
      bad('summaries 里每项 id 只允许 [A-Za-z0-9._-] 且不以符号开头')
    }
    if (s.model !== undefined && s.model !== null && typeof s.model !== 'string') bad('summaries 里每项 model 必须是字符串')
    const sp = summaryPathOf(target, s, range) // ★ 唯一落点口径
    if (seenPath.has(sp.path)) bad(SUMMARIES_SAME_PATH_MSG)
    seenPath.add(sp.path)
    entries.push({
      id: sp.id,
      path: sp.path,
      text: s.text,
      model: typeof s.model === 'string' ? s.model : null,
      meta: summaryMetaOf(s), // 白名单与单份同口径（plan 时定死，apply 确定性重建）
    })
  }
  return entries
}

/**
 * 纯计划（零 IO）：输入已被 validatePlanInput 校验过，observed 是 handler 从 Tavern
 * 观察到的现状。产出 willWrite / willUpdate / expectedRevisions（路径 → 当前内容
 * sha256 或 null），供 apply 做写前重核。楼层已存在且未 overwrite ⇒ COLLECT_FLOOR_CONFLICT；
 * 索引存在但解析不了 ⇒ COLLECT_INDEX_BROKEN（fail-closed：索引是唯一的「已收」判据）。
 */
export function planCollect(input, deps = {}) {
  const observed = deps.observed || {}
  if (!observed.targetKnown) {
    throw failCode('COLLECT_TARGET_UNKNOWN', 'catalog.json 里找不到该周目（characterId=' + input.target.characterId + '）')
  }
  const archiveRel = input.target.characterId + '/' + input.target.playthroughId + '/archive'
  const from = input.range.fromFloor
  const to = input.range.toFloor
  const overwrite = input.overwrite === true
  const warnings = []

  const floors = input.floors.slice().sort((a, b) => a.floor - b.floor)
  const existing = observed.existingFloors instanceof Set ? observed.existingFloors : new Set()
  const floorShas = observed.floorShas instanceof Map ? observed.floorShas : new Map()
  const clashes = floors.filter((f) => existing.has(f.floor))
  if (clashes.length > 0 && !overwrite) {
    throw failCode(
      'COLLECT_FLOOR_CONFLICT',
      '楼层已存在于归档（' + clashes.map((f) => f.floor).slice(0, 8).join(', ') + (clashes.length > 8 ? ' …' : '') + '）；确认覆盖请带 overwrite:true',
      { floors: clashes.map((f) => f.floor) },
    )
  }
  if (clashes.length > 0) warnings.push('overwrite:true：将覆盖 ' + clashes.length + ' 个已存在的楼层文件')
  const gaps = []
  for (let n = from; n <= to; n++) {
    if (!existing.has(n) && !floors.some((f) => f.floor === n)) gaps.push(n)
  }
  if (gaps.length > 0) warnings.push('range 内有 ' + gaps.length + ' 个楼层不在本次 floors 里（允许，但索引口径按 from/to 记）')

  const sp = summaryPathOf(input.target, input.summary, input.range)
  const summaryId = sp.id
  const summaryPath = sp.path
  const indexPath = archiveRel + '/summaries/index.json'
  const manifestPath = archiveRel + '/manifest.json'

  const willWrite = []
  const willUpdate = []
  const expectedRevisions = {}

  for (const f of floors) {
    const path = archiveRel + '/floors/' + floorFileName(f.floor)
    const text = floorDocText(f)
    willWrite.push({ path, bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256Hex(text) })
    expectedRevisions[path] = floorShas.has(f.floor) ? floorShas.get(f.floor) : null
  }

  // ★★ 2026-09-22「摘要按段切片」：本次要追加的条目列表。老路（只给 `summary`）= **一份的列表**
  //   （落点与正文都来自上面那个 summaryPathOf，于是产出的 willWrite / expectedRevisions / 索引
  //   字节与从前逐字一致）；`summaries`（N 份）= 每份自带 id/正文/meta，落点仍只有 summaryPathOf
  //   一处（summaries 那条在 summaryEntriesOf 里走同一个式子，⛔ 不另拼路径）。
  const summaryEntries = (
    input.summaries !== undefined && input.summaries !== null
      ? summaryEntriesOf(input, input.target, input.range)
      : [{
          id: summaryId,
          path: summaryPath,
          text: input.summary.text,
          model: typeof input.summary.model === 'string' ? input.summary.model : null,
          meta: summaryMetaOf(input.summary), // D1/D4：模型摘要元数据 + tags（白名单见 summaryMetaOf）
        }]
  ).map((e) => ({ ...e, sourceHash: sha256Hex(e.text), chars: Array.from(e.text).length }))
  const oneShot = summaryEntries.length === 1

  const summaryShas = observed.summaryShas instanceof Map ? observed.summaryShas : new Map()
  for (const e of summaryEntries) {
    willWrite.push({ path: e.path, bytes: Buffer.byteLength(e.text, 'utf8'), sha256: e.sourceHash })
    // ★ 覆盖模式：摘要文件**可能已经存在**（同一份源重复导入时 planId 相同）⇒ 期望值必须取实际指纹，
    //   否则写前重核会把「本来就存在」误判成「plan 之后被改过」（2026-09-16 那个 409 乐观锁的真因）。
    const summaryPreExists = summaryShas.has(e.path) && summaryShas.get(e.path) !== null
    if (summaryPreExists && !overwrite) {
      throw failCode('COLLECT_SUMMARY_EXISTS', '摘要文件 ' + e.path + ' 已存在；确认重写请带 overwrite:true')
    }
    if (summaryPreExists) warnings.push('overwrite:true：摘要 ' + e.id + '.md 已存在，将被覆盖')
    expectedRevisions[e.path] = overwrite && summaryShas.has(e.path) ? summaryShas.get(e.path) : null
  }

  // 索引：已存在 ⇒ willUpdate（fromRevision 用内容指纹，官方对非 managed 文件没有 revision）；
  // 摘要 id 已在索引里且未 overwrite ⇒ 拒（同 id 重复追加会毁掉「已收」判据）。N 份逐份判。
  let indexDoc = null
  if (observed.index && observed.index.exists) {
    indexDoc = observed.index.doc
    if (!isPlainObject(indexDoc) || !Array.isArray(indexDoc.entries)) {
      throw failCode('COLLECT_INDEX_BROKEN', 'summaries/index.json 存在但解析不了（fail-closed，拒绝追加）')
    }
    if (indexDoc.schemaVersion !== 1 || indexDoc.kind !== collectConstants.indexKind) {
      throw failCode('COLLECT_INDEX_BROKEN', 'summaries/index.json 的 schemaVersion/kind 不是本写入器的口径（fail-closed）')
    }
    for (const e of summaryEntries) {
      if (indexDoc.entries.some((x) => isPlainObject(x) && x.id === e.id) && !overwrite) {
        throw failCode('COLLECT_SUMMARY_EXISTS', '摘要 id ' + e.id + ' 已在索引里；确认重写请带 overwrite:true')
      }
    }
  }

  const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now()
  const iso = new Date(nowMs).toISOString()
  const newIndexDoc = buildIndexDoc(indexDoc, summaryEntries.map((e) => ({
    id: e.id,
    fromFloor: from,
    toFloor: to,
    createdAt: iso,
    model: e.model,
    sourceHash: e.sourceHash,
    chars: e.chars,
    meta: e.meta,
  })))
  const newIndexText = JSON.stringify(newIndexDoc, null, 2) + '\n'
  const indexNew = { path: indexPath, bytes: Buffer.byteLength(newIndexText, 'utf8'), sha256: sha256Hex(newIndexText) }
  if (indexDoc === null) {
    willWrite.push(indexNew)
    expectedRevisions[indexPath] = null
  } else {
    willUpdate.push({
      path: indexPath,
      fromRevision: typeof observed.index.sha256 === 'string' ? observed.index.sha256 : null,
      toBytes: indexNew.bytes,
      sha256: typeof observed.index.sha256 === 'string' ? observed.index.sha256 : null,
    })
    expectedRevisions[indexPath] = typeof observed.index.sha256 === 'string' ? observed.index.sha256 : null
  }

  // manifest：存在且能解析才增量更新 count/writer；解析不了 ⇒ 跳过 + warning（绝不覆盖）。
  let manifestUpdate = false
  if (observed.manifest && observed.manifest.exists) {
    if (isPlainObject(observed.manifest.doc)) {
      manifestUpdate = true
      willUpdate.push({
        path: manifestPath,
        fromRevision: typeof observed.manifest.sha256 === 'string' ? observed.manifest.sha256 : null,
        toBytes: null, // 落库时才知道最终字节（要在索引写完后计数）
        sha256: typeof observed.manifest.sha256 === 'string' ? observed.manifest.sha256 : null,
      })
      expectedRevisions[manifestPath] = typeof observed.manifest.sha256 === 'string' ? observed.manifest.sha256 : null
    } else {
      warnings.push('manifest.json 存在但解析不了：已跳过更新（绝不覆盖）')
    }
  } else {
    warnings.push('manifest.json 不存在：已跳过更新')
  }

  const plan = {
    v: 1,
    createdAt: nowMs,
    target: { characterId: input.target.characterId, playthroughId: input.target.playthroughId, archiveRel },
    range: { fromFloor: from, toFloor: to },
    overwrite,
    dryRun: input.dryRun === true,
    // 老路（一份）的五个字段名与语义逐字不变；N 份时改走 `summaries`（数组），⛔ 不再有
    // 「只写第一份」的歧义：读不到 plan.summaryPath 的旧读者会**响亮地失败**，而不是静默少写。
    ...(oneShot
      ? {
          summaryId: summaryEntries[0].id,
          summaryPath: summaryEntries[0].path,
          summaryText: summaryEntries[0].text,
          entryModel: summaryEntries[0].model,
          entryMeta: summaryEntries[0].meta, // plan 时定死，apply 确定性重建（与 entryModel 同纪律）
        }
      : {
          summaries: summaryEntries.map((e) => ({ id: e.id, path: e.path, text: e.text, model: e.model, meta: e.meta })),
        }),
    indexPath,
    manifestPath,
    manifestUpdate,
    floorDocs: floors.map((f) => ({ path: archiveRel + '/floors/' + floorFileName(f.floor), text: floorDocText(f) })),
    indexExisted: indexDoc !== null,
    indexBeforeSha: indexDoc !== null ? expectedRevisions[indexPath] : null,
    willWrite,
    willUpdate,
    expectedRevisions,
    warnings,
  }
  plan.hash = sha256Hex(JSON.stringify({
    target: plan.target,
    range: plan.range,
    summaryId: oneShot ? summaryEntries[0].id : summaryEntries.map((e) => e.id).join(','),
    summarySha: oneShot ? summaryEntries[0].sourceHash : sha256Hex(summaryEntries.map((e) => e.sourceHash).join('|')),
    floors: willWrite.filter((w) => w.path.includes('/floors/')).map((w) => [w.path, w.sha256]),
    expectedRevisions: plan.expectedRevisions,
  }))
  return plan
}

/**
 * 摘要条目的可选元数据白名单收集（D1/D4）：调用方（collect-scan）在 summary.meta 里带来
 * 模型摘要的来源信息与 tags，这里只收白名单内、类型正确的字段，其余一律丢弃（⛔ 不透传
 * 任意键，索引里不出现来路不明的字段；没有 meta 或全为空给 null —— 条目形状与旧版逐字节一致）。
 * 只存哈希/计数/枚举值/路径类元数据，⛔ 不存正文。
 */
function summaryMetaOf(summary) {
  const meta = isPlainObject(summary) && isPlainObject(summary.meta) ? summary.meta : null
  if (meta === null) return null
  const out = {}
  if (meta.kind === 'model-summary' || meta.kind === 'mechanical') out.kind = meta.kind
  if (typeof meta.compactionId === 'string' && meta.compactionId !== '') out.compactionId = meta.compactionId
  if (typeof meta.provider === 'string' && meta.provider !== '') out.provider = meta.provider
  if (Array.isArray(meta.tags)) out.tags = meta.tags.filter((t) => typeof t === 'string' && t !== '')
  if (Number.isFinite(meta.shadowedTokenCount)) out.shadowedTokenCount = meta.shadowedTokenCount
  if (Number.isInteger(meta.eventSeq) && meta.eventSeq >= 0) out.eventSeq = meta.eventSeq
  return Object.keys(out).length > 0 ? out : null
}

/** 追加条目；kind/schemaVersion/既有 entries 原样保留（overwrite 时同 id 原位替换）。
 *  ★ 2026-09-22「摘要按段切片」：第二参可以是**一条**（老路，逐字不变）或**一组**（一次追加 N 份，
 *  按给定顺序逐条追加；同一次调用的 N 条 createdAt 相同 ⇒ updatedAt 取第一条即本次时刻）。
 *  entry.meta（白名单已收编）非空时原样并入新条目（D1：kind/compactionId/provider/
 *  shadowedTokenCount/eventSeq/tags —— 让索引能区分模型摘要与机械条目、并带检索侧 tags）。 */
function buildIndexDoc(existingDoc, entryOrEntries) {
  const list = Array.isArray(entryOrEntries) ? entryOrEntries : [entryOrEntries]
  const first = list[0]
  const doc = existingDoc === null
    ? { schemaVersion: 1, kind: collectConstants.indexKind, updatedAt: first.createdAt, entries: [] }
    : existingDoc
  let entries = doc.entries
  for (const entry of list) {
    entries = entries.filter((e) => !(isPlainObject(e) && e.id === entry.id))
    const fresh = {
      id: entry.id,
      file: entry.id + '.md',
      fromFloor: entry.fromFloor,
      toFloor: entry.toFloor,
      createdAt: entry.createdAt,
      model: entry.model,
      sourceHash: entry.sourceHash,
      chars: entry.chars,
    }
    if (isPlainObject(entry.meta)) Object.assign(fresh, entry.meta)
    entries.push(fresh)
  }
  return { ...doc, updatedAt: first.createdAt, entries }
}

/**
 * 真落库。deps.tavern = createTavernClient(...)，deps.now 可注入时钟（TTL 用）。
 * 顺序：写前重核 → 建目录 → 楼层（升序）→ 摘要正文 → 索引（双读锁）→ manifest。
 * 每写成一个文件立刻从 Tavern 读回来记 bytes+sha256（⛔ 不拿发出去的内容自己对）。
 * 任何失败：抛 Error{code, collectPartial/written/readBack/warnings}——partial 就是
 * 「已确认落盘」的清单，调用方必须如实呈现。
 */
export async function applyCollect(plan, deps = {}) {
  const tavern = deps.tavern
  if (!tavern || typeof tavern.read !== 'function' || typeof tavern.write !== 'function') {
    throw failCode('COLLECT_TAVERN_UNREACHABLE', '缺可用的 Tavern client（deps.tavern）')
  }
  const now = typeof deps.now === 'function' ? deps.now : Date.now
  if (!isPlainObject(plan) || typeof plan.createdAt !== 'number' || !isPlainObject(plan.target)) {
    throw failCode('COLLECT_PLAN_EXPIRED', 'plan 缺失或形状不识（先 POST /collect/plan）')
  }
  if (now() - plan.createdAt > collectConstants.planTtlMs) {
    throw failCode('COLLECT_PLAN_EXPIRED', 'plan 已过期（TTL ' + collectConstants.planTtlMs + 'ms），请重新 plan')
  }

  const written = []
  const readBack = []
  const warnings = Array.isArray(plan.warnings) ? plan.warnings.slice() : []
  const record = async (path) => {
    const got = await tavern.read(path)
    const buf = Buffer.from(got.content, 'utf8')
    const rec = { path, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') }
    written.push(rec)
    readBack.push(rec)
    return rec
  }

  try {
    // ① 写前重核：每个目标文件的当前指纹必须与 plan 时一致，变了就 409（一个字节都不写）。
    //    三类原因分开说清（2026-09-16：笼统写「被改过」会让人以为锁坏了 —— 实际常常是
    //    「目标文件本来就存在」而计划认定它不该存在）。
    const conflicts = []
    const expected = plan.expectedRevisions && typeof plan.expectedRevisions === 'object' ? plan.expectedRevisions : {}
    const allPaths = []
    for (const w of plan.willWrite || []) allPaths.push(w.path)
    for (const w of plan.willUpdate || []) allPaths.push(w.path)
    for (const p of allPaths) {
      const want = Object.prototype.hasOwnProperty.call(expected, p) ? expected[p] : null
      const cur = await readIfExists(tavern, p)
      const actual = cur === null ? null : sha256Hex(cur.content)
      if (actual === want) continue
      const reason = want === null ? 'EXISTS' : (actual === null ? 'GONE' : 'CHANGED')
      conflicts.push({ path: p, expected: want, actual, reason })
    }
    if (conflicts.length > 0) {
      const n = (r) => conflicts.filter((c) => c.reason === r).length
      const parts = []
      if (n('EXISTS') > 0) parts.push(n('EXISTS') + ' 个目标文件已存在（本次计划认定它们不该存在）')
      if (n('GONE') > 0) parts.push(n('GONE') + ' 个目标文件在计划之后消失了')
      if (n('CHANGED') > 0) parts.push(n('CHANGED') + ' 个目标文件在计划之后被改过')
      throw failCode('COLLECT_REVISION_CHANGED', parts.join('；') + '（乐观锁拒绝写入，一个字节都没写）', { conflicts })
    }

    // ② 建目录（已存在则吞掉）。
    await tavern.mkdir(plan.target.archiveRel + '/floors')
    await tavern.mkdir(plan.target.archiveRel + '/summaries')

    // ③ 楼层（升序逐楼写，每写一个立刻读回实证）。
    for (const fd of plan.floorDocs) {
      await tavern.write(fd.path, fd.text)
      await record(fd.path)
    }

    // ④ 摘要正文。老路一份（plan.summaryPath/summaryText）；★ 2026-09-22「摘要按段切片」的 N 份
    //    走 plan.summaries（每份自己的 path/text/meta，**plan 时定死**）—— 逐份写、逐份读回实证，
    //    ⛔ 顺序与索引 entries 的顺序一致。
    const summaryDocs = Array.isArray(plan.summaries) && plan.summaries.length > 0
      ? plan.summaries.map((s) => ({ id: s.id, path: s.path, text: s.text, model: s.model, meta: s.meta }))
      : [{
          id: plan.summaryId,
          path: plan.summaryPath,
          text: plan.summaryText,
          model: plan.entryModel !== undefined ? plan.entryModel : null,
          meta: isPlainObject(plan.entryMeta) ? plan.entryMeta : null,
        }]
    for (const sd of summaryDocs) {
      await tavern.write(sd.path, sd.text)
      await record(sd.path)
    }

    // ⑤ 索引（最后写）：读 → 追加 → 写前【再读一次】比 sha256 → 变了就 409 → PUT。
    let indexDoc = null
    const firstRead = await readIfExists(tavern, plan.indexPath)
    const firstSha = firstRead === null ? null : sha256Hex(firstRead.content)
    if (firstRead !== null) {
      indexDoc = parseJsonOrNull(firstRead.content)
      if (!isPlainObject(indexDoc) || !Array.isArray(indexDoc.entries) || indexDoc.schemaVersion !== 1 || indexDoc.kind !== collectConstants.indexKind) {
        throw failCode('COLLECT_INDEX_BROKEN', 'summaries/index.json 存在但口径不对（fail-closed，拒绝追加；楼层与摘要正文已落盘，见 partial）')
      }
    }
    const iso = new Date(plan.createdAt).toISOString() // 用 plan 时刻：与 willWrite 的指纹逐字节一致（确定性重建）
    const newIndex = buildIndexDoc(indexDoc, summaryDocs.map((sd) => ({
      id: sd.id,
      fromFloor: plan.range.fromFloor,
      toFloor: plan.range.toFloor,
      createdAt: iso,
      model: sd.model !== undefined ? sd.model : null, // plan 时定死，apply 确定性重建
      sourceHash: sha256Hex(sd.text),
      chars: Array.from(sd.text).length,
      meta: isPlainObject(sd.meta) ? sd.meta : null, // 同上：plan 时定死，apply 不重算
    })))
    const newIndexText = JSON.stringify(newIndex, null, 2) + '\n'
    const reread = await readIfExists(tavern, plan.indexPath)
    const rereadSha = reread === null ? null : sha256Hex(reread.content)
    if (rereadSha !== firstSha) {
      throw failCode('COLLECT_REVISION_CHANGED', 'summaries/index.json 在写入前又被改了（双读乐观锁拒绝）', {
        conflicts: [{ path: plan.indexPath, expected: firstSha, actual: rereadSha }],
      })
    }
    await tavern.write(plan.indexPath, newIndexText)
    await record(plan.indexPath)

    // ⑥ manifest：存在且能解析才增量改 summaries.count / writer；否则跳过 + warning。
    if (plan.manifestUpdate) {
      const mRead = await readIfExists(tavern, plan.manifestPath)
      if (mRead !== null) {
        const mDoc = parseJsonOrNull(mRead.content)
        if (isPlainObject(mDoc)) {
          if (!isPlainObject(mDoc.summaries)) mDoc.summaries = {}
          mDoc.summaries.count = newIndex.entries.length
          mDoc.summaries.writer = MANIFEST_WRITER
          const mText = JSON.stringify(mDoc, null, 2) + '\n'
          if (sha256Hex(mText) !== sha256Hex(mRead.content)) {
            await tavern.write(plan.manifestPath, mText)
            await record(plan.manifestPath)
          }
        } else {
          warnings.push('manifest.json 解析不了：已跳过更新（绝不覆盖）')
        }
      } else {
        warnings.push('manifest.json 已消失：已跳过更新')
      }
    }

    return {
      ok: true,
      written: written.slice(),
      readBack: readBack.slice(),
      partial: [],
      warnings,
      target: plan.target,
    }
  } catch (e) {
    // fail-closed：不回滚，但必须如实交代已经落盘了什么。
    e.collectPartial = written.slice()
    e.collectWritten = written.slice()
    e.collectReadBack = readBack.slice()
    e.collectWarnings = warnings
    throw e
  }
}

/** 响应里的 plan 视图：⛔ 不含任何正文（floorDocs/summaryText 只留在服务端 store 里）。 */
function publicPlan(plan) {
  return {
    planId: plan.planId ?? null,
    hash: plan.hash,
    target: plan.target,
    range: plan.range,
    overwrite: plan.overwrite,
    willWrite: plan.willWrite,
    willUpdate: plan.willUpdate,
    expectedRevisions: plan.expectedRevisions,
    warnings: plan.warnings,
    planTtlMs: collectConstants.planTtlMs,
  }
}

/** 请求体读取（本端点自带字节上限；⛔ 不动 index.js 的全局 BODY_LIMIT）。 */
function readJsonBody(req, cap) {
  return new Promise((resolveP, rejectP) => {
    const chunks = []
    let size = 0
    let done = false
    req.on('data', (c) => {
      if (done) return
      size += c.length
      if (size > cap) {
        done = true
        chunks.length = 0
        rejectP(failCode('PAYLOAD_TOO_LARGE', '请求体超过 ' + cap + ' 字节上限'))
        req.resume()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!done) {
        done = true
        resolveP(Buffer.concat(chunks).toString('utf8'))
      }
    })
    req.on('error', (e) => {
      if (!done) {
        done = true
        rejectP(e)
      }
    })
  })
}

async function parseBody(req, deps) {
  // 自检台注入口（deps.rawBody）：生产路径永远从 req 读，注入只是给行为级自检用
  if (deps && typeof deps.rawBody === 'string') {
    let body
    try {
      body = JSON.parse(deps.rawBody || '{}')
    } catch (e) {
      throw failCode('BAD_JSON', '请求体不是合法 JSON：' + String((e && e.message) || e))
    }
    if (!isPlainObject(body)) throw failCode('BAD_REQUEST', '请求体必须是 JSON 对象')
    return body
  }
  const raw = await readJsonBody(req, collectConstants.bodyLimit)
  let body
  try {
    body = JSON.parse(raw || '{}')
  } catch (e) {
    throw failCode('BAD_JSON', '请求体不是合法 JSON：' + String((e && e.message) || e))
  }
  if (!isPlainObject(body)) throw failCode('BAD_REQUEST', '请求体必须是 JSON 对象')
  return body
}

// ---------------------------------------------------------------------------
// 三个端点 handler（lib/index.js 只加一行分派，实现全部收在这里）
// ---------------------------------------------------------------------------

/** plan 的进程内 store：可注入（自检台换自己的 Map + 时钟）。 */
const defaultPlanStore = new Map()

function pruneStore(store, nowMs) {
  for (const [k, v] of store) {
    if (!v || typeof v.expires !== 'number' || nowMs >= v.expires) store.delete(k)
  }
}

function makeTavern(req, deps) {
  if (deps && deps.tavern) return deps.tavern
  return createTavernClient({ baseUrl: tavernBaseFromReq(req) })
}

/**
 * 给同包的落库模块（import-apply.js）用：拿到与 A1 **同一套** Tavern 客户端
 * （同基址推导、同超时/上限、同 Origin 纪律）。`deps.tavern` 注入优先（自检台用）。
 */
export function tavernForRequest(req, deps = {}) {
  return makeTavern(req, deps)
}

/**
 * GET /collect/targets —— 从 catalog.json 发现周目并粗查归档现状。
 * 任何一步失败都降级为 hasArchive:false / null，绝不抛；Tavern 不可达或 catalog
 * 坏了才给 ok:false（HTTP 200，照 /agent 系的「读不到不是服务器错误」约定）。
 */
export async function handleCollectTargets(ctx, url, req, send, deps = {}) {
  void ctx
  void url
  try {
    const tavern = makeTavern(req, deps)
    let catalogText
    try {
      const got = await tavern.read('catalog.json')
      catalogText = got.content
    } catch (e) {
      if (isMissingErr(e)) return send(200, { ok: true, targets: [], note: '工作区还没有 catalog.json' })
      if (e.code === 'TAVERN_UNREACHABLE') return send(200, Object.assign(errBody('COLLECT_TAVERN_UNREACHABLE', e.message), { targets: [] }))
      return send(200, Object.assign(errBody('COLLECT_CATALOG_BROKEN', e.message), { targets: [] }))
    }
    const catalog = parseJsonOrNull(catalogText)
    if (!isPlainObject(catalog) || !Array.isArray(catalog.playthroughs)) {
      return send(200, Object.assign(errBody('COLLECT_CATALOG_BROKEN', 'catalog.json 不是 {playthroughs:[…]} 形状'), { targets: [] }))
    }
    const targets = []
    for (const pt of catalog.playthroughs.slice(0, collectConstants.maxTargets)) {
      const t = catalogTarget(pt)
      if (t === null) continue
      const row = {
        characterId: t.characterId,
        playthroughId: t.playthroughId,
        title: t.title,
        archiveRel: t.archiveRel,
        hasArchive: false,
        floorCount: null,
        summaryCount: null,
        manifestWriter: null,
      }
      try {
        const lst = await tavern.list(t.archiveRel)
        row.hasArchive = Array.isArray(lst.list) && lst.list.length > 0
      } catch {}
      if (row.hasArchive) {
        try {
          const fl = await tavern.list(t.archiveRel + '/floors')
          row.floorCount = fl.list.filter((x) => x && x.type === 'file' && FLOOR_FILE_RE.test(String(x.path).split('/').pop() || '')).length
        } catch {}
        try {
          const ix = await readIfExists(tavern, t.archiveRel + '/summaries/index.json')
          const d = ix === null ? null : parseJsonOrNull(ix.content)
          row.summaryCount = isPlainObject(d) && Array.isArray(d.entries) ? d.entries.length : null
        } catch {}
        try {
          const mf = await readIfExists(tavern, t.archiveRel + '/manifest.json')
          const d = mf === null ? null : parseJsonOrNull(mf.content)
          row.manifestWriter = isPlainObject(d) && isPlainObject(d.summaries) && typeof d.summaries.writer === 'string' ? d.summaries.writer : null
        } catch {}
      }
      targets.push(row)
    }
    return send(200, { ok: true, targets })
  } catch (e) {
    return send(200, Object.assign(errBody('COLLECT_TARGETS_FAILED', String((e && e.message) || e)), { targets: [] }))
  }
}

/**
 * 观察一个周目的归档现状（**只读**：list/read，绝不写）。handleCollectPlan 与导入落库
 * （import-apply.js）共用这一份观察口径 —— 两处各抄一遍迟早会分叉。
 *
 * 缺 catalog.json ⇒ `targetKnown:false`（不抛，交给 planCollect 抛 COLLECT_TARGET_UNKNOWN）；
 * 其余 catalog 读失败**原样抛出**（调用方按老口径映射成 COLLECT_TAVERN_UNREACHABLE / COLLECT_CATALOG_BROKEN）。
 * `opts.overwrite` 为 true 时才去读撞楼文件的当前指纹（默认拒绝路径下 planCollect 会先抛冲突）。
 * `opts.summaryPaths`（数组，路径口径见 `summaryPathOf`）会把**将要写的那个摘要文件**的当前指纹
 * 一并观察出来 —— 覆盖重导同一个源时它已经存在，期望值必须取自这里（否则写前重核必误报）。
 */
export async function observeArchive(tavern, target, opts = {}) {
  const overwrite = opts.overwrite === true
  let targetKnown = false
  try {
    const catGot = await tavern.read('catalog.json')
    const catalog = parseJsonOrNull(catGot.content)
    const pts = isPlainObject(catalog) && Array.isArray(catalog.playthroughs) ? catalog.playthroughs : []
    targetKnown = pts.some((pt) => {
      const t = catalogTarget(pt)
      return t !== null && t.characterId === target.characterId && t.playthroughId === target.playthroughId
    })
  } catch (e) {
    if (!isMissingErr(e)) throw e
  }

  const archiveRel = target.characterId + '/' + target.playthroughId + '/archive'
  const observed = { targetKnown, existingFloors: new Set(), floorShas: new Map(), summaryShas: new Map(), index: { exists: false }, manifest: { exists: false } }
  const known = Array.isArray(opts.floors) ? opts.floors : []
  let archiveExists = false
  try {
    const lst = await tavern.list(archiveRel)
    archiveExists = Array.isArray(lst.list) && lst.list.length > 0
  } catch {}
  if (archiveExists) {
    try {
      const fl = await tavern.list(archiveRel + '/floors')
      for (const x of fl.list) {
        if (!x || x.type !== 'file') continue
        const m = FLOOR_FILE_RE.exec(String(x.path).split('/').pop() || '')
        if (m) observed.existingFloors.add(Number(m[1]))
      }
    } catch {}
  }
  for (const f of known) {
    if (!observed.existingFloors.has(f.floor)) continue
    if (!overwrite) continue
    const p = archiveRel + '/floors/' + floorFileName(f.floor)
    const got = await readIfExists(tavern, p)
    observed.floorShas.set(f.floor, got === null ? null : sha256Hex(got.content))
  }
  // 摘要正文的指纹：调用方用 summaryPathOf() 给出**将要写的那一个**路径（覆盖模式下它可能已存在，
  // 期望值必须等于它的真身 sha，否则写前重核必然误报「被改过」）。
  for (const p of Array.isArray(opts.summaryPaths) ? opts.summaryPaths : []) {
    if (typeof p !== 'string' || p === '') continue
    const got = await readIfExists(tavern, p)
    observed.summaryShas.set(p, got === null ? null : sha256Hex(got.content))
  }
  if (archiveExists) {
    const ix = await readIfExists(tavern, archiveRel + '/summaries/index.json')
    if (ix !== null) {
      observed.index = { exists: true, doc: parseJsonOrNull(ix.content), sha256: sha256Hex(ix.content) }
    }
    const mf = await readIfExists(tavern, archiveRel + '/manifest.json')
    if (mf !== null) {
      observed.manifest = { exists: true, doc: parseJsonOrNull(mf.content), sha256: sha256Hex(mf.content) }
    }
  }
  observed.archiveExists = archiveExists
  observed.archiveRel = archiveRel
  return observed
}

function errBody(code, message) {
  return { ok: false, error: { code, message } }
}

/**
 * POST /collect/plan —— 校验 + 观察 Tavern 现状 + 纯计划。dryRun:true 只出计划不存
 * planId；正常路径存进 store（TTL 见 collectConstants.planTtlMs，单次使用）。
 * 错误一律 HTTP 400 + 可读 code；Tavern 网络类错误归一为 COLLECT_TAVERN_UNREACHABLE。
 */
export async function handleCollectPlan(ctx, url, req, send, deps = {}) {
  void ctx
  void url
  const now = deps && typeof deps.now === 'function' ? deps.now : Date.now
  const store = deps && deps.store instanceof Map ? deps.store : defaultPlanStore
  try {
    const body = await parseBody(req, deps)
    try {
      validatePlanInput(body)
    } catch (e) {
      return send(400, errBody(e.code || 'COLLECT_INVALID', e.message))
    }
    const tavern = makeTavern(req, deps)

    // 观察 catalog + 归档现状（观察口径与导入落库共用 observeArchive，见其文档）。
    // ★ 连**将要写的摘要正文**一起观察：覆盖模式下它可能已存在，期望值要取它的真身 sha。
    // ★ 2026-09-22「摘要按段切片」：summaries（N 份）⇒ N 个落点都要观察（落点口径仍是 summaryPathOf）。
    const summaryPaths = Array.isArray(body.summaries) && body.summaries.length > 0
      ? body.summaries.map((s) => summaryPathOf(body.target, s, body.range).path)
      : [summaryPathOf(body.target, body.summary, body.range).path]
    let observed
    try {
      observed = await observeArchive(tavern, body.target, { overwrite: body.overwrite === true, floors: body.floors, summaryPaths })
    } catch (e) {
      if (e.code === 'TAVERN_UNREACHABLE') return send(400, errBody('COLLECT_TAVERN_UNREACHABLE', e.message))
      return send(400, errBody('COLLECT_CATALOG_BROKEN', e.message))
    }

    const plan = planCollect(body, { observed, now })
    if (plan === null || typeof plan !== 'object') throw failCode('COLLECT_INVALID', 'planCollect 返回形状不识')
    if (body.dryRun === true) {
      // dryRun：只出计划，不存 planId（要落库请带 dryRun:false 重新 plan 再 apply）
      return send(200, { ok: true, dryRun: true, ...publicPlan(plan), note: 'dryRun：只出计划，planId 为空；确认后带 dryRun:false 重新 plan。' })
    }
    const planId = randomBytes(12).toString('hex')
    plan.planId = planId
    pruneStore(store, now())
    store.set(planId, { plan, expires: now() + collectConstants.planTtlMs })
    return send(200, { ok: true, dryRun: false, ...publicPlan(plan) })
  } catch (e) {
    const code = (e && e.code) || 'COLLECT_PLAN_FAILED'
    if (code === 'TAVERN_UNREACHABLE' || code.startsWith('TAVERN_HTTP_') || code === 'TAVERN_FILE_TOO_LARGE' || code === 'TAVERN_BAD_SHAPE') {
      return send(400, errBody('COLLECT_TAVERN_UNREACHABLE', e.message))
    }
    return send(400, errBody(code, String((e && e.message) || e)))
  }
}

/**
 * POST /collect/apply —— 单次使用 planId + 乐观锁落库。
 *   410 COLLECT_PLAN_EXPIRED（过期或不存在）；409 COLLECT_REVISION_CHANGED（附 conflicts）；
 *   其余失败 500 但如实附 partial/written/readBack（已确认落盘的文件清单）。成功后 plan 即焚。
 */
export async function handleCollectApply(ctx, url, req, send, deps = {}) {
  void ctx
  void url
  const now = deps && typeof deps.now === 'function' ? deps.now : Date.now
  const store = deps && deps.store instanceof Map ? deps.store : defaultPlanStore
  let body
  try {
    body = await parseBody(req, deps)
  } catch (e) {
    return send(400, errBody(e.code || 'BAD_REQUEST', e.message))
  }
  const planId = typeof body.planId === 'string' ? body.planId : ''
  const entry = planId !== '' ? store.get(planId) : undefined
  if (!entry || !isPlainObject(entry.plan) || now() >= entry.expires) {
    if (planId !== '') store.delete(planId)
    return send(410, errBody('COLLECT_PLAN_EXPIRED', 'plan 不存在或已过期（TTL ' + collectConstants.planTtlMs + 'ms），请重新 plan'))
  }
  const plan = JSON.parse(JSON.stringify(entry.plan))
  if (isPlainObject(body.expectedRevisions)) {
    const merged = { ...plan.expectedRevisions }
    for (const [k, v] of Object.entries(body.expectedRevisions)) {
      if (v === null || typeof v === 'string') merged[k] = v
    }
    plan.expectedRevisions = merged
  }
  store.delete(planId) // 单次使用：无论成败，这份 plan 的指纹已消费掉
  const tavern = makeTavern(req, deps)
  try {
    const result = await applyCollect(plan, { tavern, now })
    return send(200, result)
  } catch (e) {
    const code = (e && e.code) || 'COLLECT_APPLY_FAILED'
    const partial = Array.isArray(e.collectPartial) ? e.collectPartial : []
    const written = Array.isArray(e.collectWritten) ? e.collectWritten : []
    const readBack = Array.isArray(e.collectReadBack) ? e.collectReadBack : []
    const warnings = Array.isArray(e.collectWarnings) ? e.collectWarnings : []
    if (code === 'COLLECT_PLAN_EXPIRED') {
      return send(410, { ...errBody(code, e.message), partial, written, readBack, warnings })
    }
    if (code === 'COLLECT_REVISION_CHANGED') {
      return send(409, { ...errBody(code, e.message), conflicts: Array.isArray(e.conflicts) ? e.conflicts : [], partial, written, readBack, warnings })
    }
    return send(500, { ...errBody(code, String((e && e.message) || e)), partial, written, readBack, warnings })
  }
}
