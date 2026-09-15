/**
 * import-formats —— 聊天导入 · 格式适配器 + 统一中间格式 + 计划器（B1，零落库零写入）
 *
 * 支持两种格式（纯文本不做）：
 *   1) tavern-import-context —— Tavern import-context JSON：
 *      { schemaVersion:1, source:object, greeting:string|null, qa:[{user,assistant}] }。
 *      校验规则照抄 tavern-loader 的 normalizeDocument()（schemaVersion===1 / qa 是数组 /
 *      每项 user+assistant 都是 string / source 非对象归 {} / greeting 非 string 归 null）。
 *   2) sillytavern-jsonl —— SillyTavern 聊天导出 jsonl：1 行文件头 + N 行消息（逐行独立
 *      JSON，不是数组）。文件头行只有 character_name / chat_metadata / user_name 三键；
 *      消息行必有 mes(string 正文) + is_user(boolean)，可能另有 is_system / name /
 *      send_date / extra / swipes 等。★ hidden 口径（实测交叉验证，与归档侧 visibility 的
 *      sent:false + source:"st:is_system" 同口径）：hidden = (is_system === true)，
 *      缺键 = 可见（不是隐藏）。
 *
 * 统一中间格式（字段名冻结）：
 *   NormalizedTurn   = { index:number, role:'user'|'assistant', text:string,
 *                        hidden:boolean, name?:string, time?:string }
 *   NormalizedImport = { schemaVersion:1, format, sourceHash, greeting?, sourceMeta, turns }
 *     sourceHash = 原始文本（原样、未 trim）的 sha256 hex；
 *     sourceMeta = { bytes, lines, turns, hidden, visible }（lines = 非空行数）。
 *
 * 硬约束：
 *   - 任何畸形输入都收口为结构化错误（Error.code ∈ IMPORT_INVALID / IMPORT_TOO_LARGE /
 *     IMPORT_TOO_MANY_TURNS），绝不抛未捕获异常，绝不崩进程。
 *   - 大小上限 maxBytes 默认 8 MiB（先查字节数再 parse，不裸读大文件）；轮数上限
 *     maxTurns 默认 5000。
 *   - ⛔ 零落库：planImport 是纯计划器，唯一 IO 是注入的 deps.tavern（A1 同款形状
 *     list/read/write/mkdir；返回形状宽容：{ok,list}/裸数组、{ok,text}/裸字符串都认）。
 *     本模块【只调 list 与 read】，绝不调 write/mkdir（HTTP 版依赖里这两个直接抛
 *     ZERO_WRITE_GUARD，误调用会当场炸响而不是静默写盘）。
 *   - 隐私：错误消息 / 日志 / 响应只允许 长度·哈希·行号·判定词，绝不出正文。
 *
 * 端点接线（lib/index.js 对本模块只加两行分派，处理函数都在本文件）：
 *   GET  /magictarven/api/import/formats → handleImportFormats(ctx, req, send)
 *   POST /magictarven/api/import/plan    → handleImportPlan(ctx, req, send, log)
 *     source.path 走 Tavern 现成只读面 GET /pmp-dsh-tavern/api/v2/workspace/files
 *     ?path=<相对路径>（同源基址，照 probeTavern() 的取法）。★ 实测：该面单文件读上限
 *     1 MiB（play/src/workspace.js 的 MAX_FILE_BYTES，超出 413 PLAY_FILE_TOO_LARGE），
 *     更大的源请走 source.text 直传；?path= 的 200 响应是 {ok,path,content} 包一层，
 *     原文在 content 字段。?list= 缺目录 ⇒ HTTP 404 + {ok:false}，按空目录处理不抛。
 *
 * 楼层/摘要落点（willWrite 的内容形状由本模块冻结，后续落库单照 bytes/sha256 落地）：
 *   <charId>/playthrough-<pid>/archive/floors/NNNN.json   每轮一楼，楼号 = 现存最大楼号+1 起
 *     内容 = JSON.stringify({_floor, is_user, is_system, mes, name}) + '\n'
 *     ★ 形状 = Tavern 真机现存楼层的原样 5 键（两处独立出处核对：真机 archive/floors/0000.json
 *     的键集合；本项目 _import-archive-as-session.mjs 读的也正是这 5 键）。
 *     映射：_floor=楼号；is_user=(role==='user')；is_system=hidden；mes=正文；
 *     name=有则带、无则 ''（不塞 sessionId/标题；解析侧的 time 不落楼，真机形状无此键）。
 *   <charId>/playthrough-<pid>/archive/summaries/import-<hash 前 8 位>.md   批次摘要
 *     （纯文本 md，不是 JSON；keepGreeting 时开场白写进它；同哈希重复导入可凭文件名撞上 → warning）
 */

import { createHash } from 'node:crypto'

/** 大小/轮数上限与格式清单（冻结；数组也冻结防手滑改）。 */
export const importConstants = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxTurns: 5000,
  formats: Object.freeze(['tavern-import-context', 'sillytavern-jsonl']),
})

const TAVERN_FILES_PATH = '/pmp-dsh-tavern/api/v2/workspace/files'
const TAVERN_TIMEOUT_MS = 10_000
// 请求体上限：text 直传 8 MiB 源在 JSON 里经转义最多膨胀 ~6 倍，再留 64 KiB 结构余量。
const IMPORT_BODY_CAP = importConstants.maxBytes * 6 + 64 * 1024

/** 结构化导入错误：{code,message} 挂在 Error 上，端点层按 code 映射 400。 */
function importError(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function byteLen(text) {
  return Buffer.byteLength(text, 'utf8')
}

function positiveInt(v, dflt) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : dflt
}

// ---------------------------------------------------------------------------
// 两个适配器：真判别（detect 先行，绝不「先试 A 失败再试 B」）+ 各自的文本→轮解析
// ---------------------------------------------------------------------------

/**
 * tavern-import-context 的判别：整份文本 JSON.parse 成功 且 是对象 且 schemaVersion===1
 * 且 qa 是数组。只判形，不逐项校验（逐项在 parse 里给结构化错误）。
 */
function detectTavernImportContext(text) {
  let v
  try {
    v = JSON.parse(text)
  } catch {
    return false
  }
  return isRecord(v) && v.schemaVersion === 1 && Array.isArray(v.qa)
}

/**
 * sillytavern-jsonl 的判别：每个非空行都能 JSON.parse 成对象，且至少一行是
 * 「消息行」（mes 是 string 且 is_user 是 boolean）。文件头行不算消息行。
 */
function detectSillytavernJsonl(text) {
  const lines = text.split(/\r?\n/)
  let sawMessageRow = false
  for (const line of lines) {
    if (line.trim() === '') continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      return false
    }
    if (!isRecord(obj)) return false
    if (typeof obj.mes === 'string' && typeof obj.is_user === 'boolean') sawMessageRow = true
  }
  return sawMessageRow
}

function isHeaderRow(obj) {
  return obj.mes === undefined
    && (obj.chat_metadata !== undefined || obj.character_name !== undefined || obj.user_name !== undefined)
}

/**
 * tavern-import-context 文本 → { greeting, source, turns, lineCount }。
 * 校验规则照抄 tavern-loader normalizeDocument()；错误一律结构化、消息不含正文。
 */
function parseTavernImportContextText(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw importError('IMPORT_INVALID', '整份文本不是合法 JSON')
  }
  if (!isRecord(value)) throw importError('IMPORT_INVALID', '顶层不是 JSON 对象')
  if (value.schemaVersion !== 1) {
    throw importError('IMPORT_INVALID', 'schemaVersion 必须 === 1（实际 ' + JSON.stringify(value.schemaVersion) + '）')
  }
  if (!Array.isArray(value.qa)) throw importError('IMPORT_INVALID', 'qa 必须是数组')
  const turns = []
  value.qa.forEach((entry, i) => {
    if (!isRecord(entry) || typeof entry.user !== 'string' || typeof entry.assistant !== 'string') {
      throw importError('IMPORT_INVALID', 'qa[' + i + '] 的 user/assistant 必须都是 string')
    }
    turns.push({ index: turns.length, role: 'user', text: entry.user, hidden: false })
    turns.push({ index: turns.length, role: 'assistant', text: entry.assistant, hidden: false })
  })
  return {
    greeting: typeof value.greeting === 'string' ? value.greeting : null,
    source: isRecord(value.source) ? value.source : {},
    turns,
    lineCount: text.split(/\r?\n/).filter((l) => l.trim() !== '').length,
  }
}

/**
 * sillytavern-jsonl 文本 → { turns, lineCount, headers }。
 * 行分类：消息行（mes:string + is_user:boolean）→ 一轮；文件头行（无 mes 且带
 * character_name/chat_metadata/user_name 之一）→ 跳过；其余 → IMPORT_INVALID（不猜）。
 * hidden = (is_system === true)，缺键 = 可见。
 */
function parseSillytavernJsonlText(text) {
  const rawLines = text.split(/\r?\n/)
  const turns = []
  let lines = 0
  let headers = 0
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]
    if (line.trim() === '') continue
    lines++
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      throw importError('IMPORT_INVALID', '第 ' + (i + 1) + ' 行不是合法 JSON')
    }
    if (!isRecord(obj)) throw importError('IMPORT_INVALID', '第 ' + (i + 1) + ' 行不是 JSON 对象')
    if (typeof obj.mes === 'string' && typeof obj.is_user === 'boolean') {
      const turn = {
        index: turns.length,
        role: obj.is_user ? 'user' : 'assistant',
        text: obj.mes,
        hidden: obj.is_system === true,
      }
      if (typeof obj.name === 'string' && obj.name !== '') turn.name = obj.name
      if (typeof obj.send_date === 'string' && obj.send_date !== '') turn.time = obj.send_date
      turns.push(turn)
      continue
    }
    if (isHeaderRow(obj)) {
      headers++
      continue
    }
    throw importError('IMPORT_INVALID', '第 ' + (i + 1) + ' 行既不是消息行（缺 mes(string)+is_user(boolean)）也不是文件头行')
  }
  return { turns, lineCount: lines, headers }
}

const PARSERS = {
  'tavern-import-context': parseTavernImportContextText,
  'sillytavern-jsonl': parseSillytavernJsonlText,
}

/**
 * 格式适配器清单（顺序即判别优先级：tavern 单份 JSON 在前，jsonl 在后）。
 * ★ 判别器是真判别；detectFormat 活迭代本数组（自检台靠换掉 detect 做反证）。
 */
export const IMPORT_FORMATS = [
  {
    id: 'tavern-import-context',
    label: 'Tavern import-context JSON',
    detect: detectTavernImportContext,
    parse(text) {
      return normalizeImport(text)
    },
  },
  {
    id: 'sillytavern-jsonl',
    label: 'SillyTavern 聊天导出 jsonl',
    detect: detectSillytavernJsonl,
    parse(text) {
      return normalizeImport(text)
    },
  },
]

/** → 格式 id；认不出返回 null（不猜、不回退「先试 A 失败再试 B」）。 */
export function detectFormat(text) {
  if (typeof text !== 'string') return null
  for (const f of IMPORT_FORMATS) {
    try {
      if (f.detect(text)) return f.id
    } catch {
      // 判别器自身不许抛；抛了视为「不认得」
    }
  }
  return null
}

/**
 * 文本 → NormalizedImport。顺序：非 string → INVALID；字节超限 → TOO_LARGE（先查再
 * parse）；认不出格式 → INVALID；逐项校验失败 → INVALID；轮数超限 → TOO_MANY_TURNS。
 */
export function normalizeImport(text, opts = {}) {
  const maxBytes = positiveInt(opts.maxBytes, importConstants.maxBytes)
  const maxTurns = positiveInt(opts.maxTurns, importConstants.maxTurns)
  if (typeof text !== 'string') throw importError('IMPORT_INVALID', '源文本必须是 string')
  const bytes = byteLen(text)
  if (bytes > maxBytes) throw importError('IMPORT_TOO_LARGE', '源文本 ' + bytes + ' 字节超上限 ' + maxBytes)
  const format = detectFormat(text)
  if (format === null) {
    throw importError('IMPORT_INVALID', '认不出的格式（既不是 Tavern import-context JSON，也不是 SillyTavern 聊天导出 jsonl）')
  }
  const parsed = PARSERS[format](text)
  if (parsed.turns.length > maxTurns) {
    throw importError('IMPORT_TOO_MANY_TURNS', '轮数 ' + parsed.turns.length + ' 超上限 ' + maxTurns)
  }
  const hidden = parsed.turns.reduce((n, t) => n + (t.hidden ? 1 : 0), 0)
  const out = {
    schemaVersion: 1,
    format,
    sourceHash: sha256Hex(text),
    sourceMeta: { bytes, lines: parsed.lineCount, turns: parsed.turns.length, hidden, visible: parsed.turns.length - hidden },
    turns: parsed.turns,
  }
  if (format === 'tavern-import-context' && typeof parsed.greeting === 'string') out.greeting = parsed.greeting
  return out
}

// ---------------------------------------------------------------------------
// 入参校验 + 计划器（纯计划：唯一 IO 是注入的 deps.tavern 的 list/read）
// ---------------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/ // target id：防路径穿越的最小约束

/**
 * POST /import/plan 的入参校验。
 * → { ok:true, value:{ format, source, target, keepGreeting, keepHidden } }
 *   | { ok:false, code:'IMPORT_INVALID', message }
 */
export function validateImportInput(input) {
  const bad = (message) => ({ ok: false, code: 'IMPORT_INVALID', message })
  if (!isRecord(input)) return bad('请求体必须是 JSON 对象')
  const format = input.format === undefined ? 'auto' : input.format
  if (format !== 'auto' && !importConstants.formats.includes(format)) {
    return bad('format 只接受 "auto" 或 ' + importConstants.formats.join(' / '))
  }
  if (!isRecord(input.source)) return bad('缺 source（{path:相对路径} 或 {text:原文} 二选一）')
  const hasPath = typeof input.source.path === 'string' && input.source.path !== ''
  const hasText = typeof input.source.text === 'string'
  if (hasPath && hasText) return bad('source.path 与 source.text 只能二选一')
  if (!hasPath && !hasText) return bad('source 必须给 path（相对路径）或 text（原文）之一')
  if (hasPath) {
    const p = input.source.path
    if (p.includes('\\') || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..')) {
      return bad('source.path 必须是相对路径（不许绝对路径、反斜杠或 .. 穿越段）')
    }
  } else if (input.source.text === '') {
    return bad('source.text 是空字符串')
  }
  if (!isRecord(input.target)) return bad('缺 target（characterId / playthroughId）')
  for (const k of ['characterId', 'playthroughId']) {
    const v = input.target[k]
    if (typeof v !== 'string' || !ID_RE.test(v)) {
      return bad('target.' + k + ' 必须是 [A-Za-z0-9][A-Za-z0-9._-]* 形态的非空字符串')
    }
  }
  const keepGreeting = input.keepGreeting === undefined ? true : input.keepGreeting
  const keepHidden = input.keepHidden === undefined ? true : input.keepHidden
  if (typeof keepGreeting !== 'boolean') return bad('"keepGreeting" 必须是 boolean（缺省 true）')
  if (typeof keepHidden !== 'boolean') return bad('"keepHidden" 必须是 boolean（缺省 true）')
  return {
    ok: true,
    value: {
      format,
      source: hasPath ? { path: input.source.path } : { text: input.source.text },
      target: { characterId: input.target.characterId, playthroughId: input.target.playthroughId },
      keepGreeting,
      keepHidden,
    },
  }
}

/** deps.tavern.list 的宽容解包：{ok,list:[{path|name}]} / {ok,names:[…]} / 裸数组。 */
async function safeList(tavern, rel) {
  let r
  try {
    r = await tavern.list(rel)
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) }
  }
  let entries = null
  if (Array.isArray(r)) entries = r
  else if (isRecord(r) && Array.isArray(r.list)) entries = r.list
  else if (isRecord(r) && Array.isArray(r.names)) entries = r.names
  if (entries === null) {
    return { ok: false, reason: isRecord(r) && r.ok === false ? '远端报目录不存在' : '返回形状不认识' }
  }
  const names = []
  for (const ent of entries) {
    const raw = typeof ent === 'string'
      ? ent
      : isRecord(ent) && typeof ent.path === 'string'
        ? ent.path
        : isRecord(ent) && typeof ent.name === 'string'
          ? ent.name
          : null
    if (raw !== null) names.push(raw.split('/').pop())
  }
  return { ok: true, names }
}

function floorNumbers(names) {
  const nums = []
  for (const n of names) {
    const m = /^(\d+)\.json$/.exec(n)
    if (m) nums.push(Number(m[1]))
  }
  return nums
}

/** deps.tavern.read 的宽容消费：{ok,text} / 裸字符串 都认；失败/缺失 → false。 */
async function readExists(tavern, rel) {
  try {
    const r = await tavern.read(rel)
    if (typeof r === 'string') return true
    return Boolean(isRecord(r) && r.ok === true && typeof r.text === 'string')
  } catch {
    return false
  }
}

/**
 * 楼层文件内容（形状冻结，见文件头注释）：Tavern 真机楼层的原样 5 键，键集合恰为
 * ['_floor','is_user','is_system','mes','name']（自检台按 Object.keys().sort() 恰等断言，
 * 多一键少一键都红）。导出仅供自检台核形；plan 只外传 bytes + sha256，绝不外传正文。
 */
export function floorBodyText(floorNo, turn) {
  const doc = {
    _floor: floorNo,
    is_user: turn.role === 'user',
    is_system: turn.hidden,
    mes: turn.text,
    name: typeof turn.name === 'string' ? turn.name : '',
  }
  return JSON.stringify(doc) + '\n'
}

/** 批次摘要 markdown（keepGreeting 时含开场白原文；plan 只外传 bytes + sha256）。 */
function summaryBodyText({ planId, normalized, kept, keepGreeting }) {
  const lines = []
  lines.push('# 导入批次 ' + planId)
  lines.push('')
  lines.push('- 来源格式：' + normalized.format)
  lines.push('- 来源哈希（sha256）：' + normalized.sourceHash)
  lines.push('- 源体积：' + normalized.sourceMeta.bytes + ' 字节 / 非空 ' + normalized.sourceMeta.lines + ' 行')
  const hiddenNote = keepHiddenAll(normalized, kept)
  lines.push('- 楼层：' + kept.length + ' 楼' + (hiddenNote === '' ? '' : '（' + hiddenNote + '）'))
  lines.push('')
  if (keepGreeting && typeof normalized.greeting === 'string') {
    lines.push('## 开场白')
    lines.push('')
    lines.push(normalized.greeting)
    lines.push('')
  }
  return lines.join('\n')
}

function keepHiddenAll(normalized, kept) {
  const dropped = normalized.sourceMeta.hidden - kept.filter((t) => t.hidden).length
  return dropped > 0 ? '另弃 ' + dropped + ' 个隐藏楼' : normalized.sourceMeta.hidden > 0 ? '含 ' + normalized.sourceMeta.hidden + ' 个隐藏楼（照导，标记 hidden）' : ''
}

/**
 * 计划器（零落库）：文本（直传或 deps.tavern.read 读来）→ NormalizedImport →
 * willWrite（每轮一楼 + 一条批次摘要）。楼号从「现存最大楼号 + 1」起；floors 目录
 * 列不到（不存在/网络失败）⇒ 按空目录从 0000 起 + warning，绝不抛。
 * ⛔ 本函数【只调 deps.tavern 的 list 与 read】，绝不调 write/mkdir。
 */
export async function planImport(input, deps) {
  const v = validateImportInput(input)
  if (!v.ok) throw importError(v.code, v.message)
  const { format, source, target, keepGreeting, keepHidden } = v.value
  const tavern = deps && isRecord(deps) ? deps.tavern : null
  if (!isRecord(tavern) || typeof tavern.list !== 'function' || typeof tavern.read !== 'function') {
    throw importError('IMPORT_INVALID', '缺 deps.tavern（需要 list 与 read；本单零写入，write/mkdir 不许存在调用）')
  }

  let text
  if (typeof source.text === 'string') {
    text = source.text
  } else {
    let r
    try {
      r = await tavern.read(source.path)
    } catch (e) {
      throw importError('IMPORT_SOURCE_UNREADABLE', '读取源文件失败：' + String((e && e.message) || e))
    }
    const t = typeof r === 'string' ? r : isRecord(r) && r.ok === true && typeof r.text === 'string' ? r.text : null
    if (t === null) throw importError('IMPORT_SOURCE_UNREADABLE', '源文件读不到（' + source.path + '）')
    text = t
  }

  const normalized = normalizeImport(text)
  if (format !== 'auto' && format !== normalized.format) {
    throw importError('IMPORT_FORMAT_UNSUPPORTED', '声明格式 ' + format + ' 与识别结果 ' + normalized.format + ' 不一致')
  }

  const warnings = []
  const archiveRel = target.characterId + '/playthrough-' + target.playthroughId + '/archive'
  const floorsRel = archiveRel + '/floors'

  let start = 0
  const listed = await safeList(tavern, floorsRel)
  if (listed.ok) {
    const nums = floorNumbers(listed.names)
    if (nums.length > 0) start = Math.max(...nums) + 1
    else warnings.push('IMPORT_FLOORS_EMPTY：' + floorsRel + ' 下没有可识别的 NNNN.json 楼层，楼号从 0000 起')
  } else {
    warnings.push('IMPORT_FLOORS_FROM_ZERO：' + floorsRel + ' 列不到（' + listed.reason + '），按空目录从 0000 起')
  }

  const hash8 = normalized.sourceHash.slice(0, 8)
  const planId = 'import-' + hash8
  const summaryRel = archiveRel + '/summaries/' + planId + '.md'
  if (await readExists(tavern, summaryRel)) {
    warnings.push('IMPORT_BATCH_EXISTS：' + summaryRel + ' 已存在同哈希批次（可能重复导入）')
  }

  const kept = keepHidden ? normalized.turns : normalized.turns.filter((t) => !t.hidden)
  if (kept.length !== normalized.turns.length) {
    warnings.push('IMPORT_HIDDEN_DROPPED：keepHidden=false，弃 ' + (normalized.turns.length - kept.length) + ' 个隐藏楼')
  }
  if (kept.length === 0) warnings.push('IMPORT_NO_TURNS：没有可导入的楼层')
  if (typeof normalized.greeting === 'string' && !keepGreeting) {
    warnings.push('IMPORT_GREETING_DROPPED：keepGreeting=false，开场白不写入批次摘要')
  }

  const willWrite = []
  kept.forEach((turn, i) => {
    const floorNo = start + i
    const body = floorBodyText(floorNo, turn)
    willWrite.push({
      path: floorsRel + '/' + String(floorNo).padStart(4, '0') + '.json',
      bytes: byteLen(body),
      sha256: sha256Hex(body),
    })
  })
  if (kept.length > 0 || typeof normalized.greeting === 'string') {
    const body = summaryBodyText({ planId, normalized, kept, keepGreeting })
    willWrite.push({ path: summaryRel, bytes: byteLen(body), sha256: sha256Hex(body) })
  }

  const first = kept.length > 0 ? kept[0] : null
  return {
    ok: true,
    planId,
    format: normalized.format,
    hash: normalized.sourceHash,
    stats: {
      bytes: normalized.sourceMeta.bytes,
      lines: normalized.sourceMeta.lines,
      turns: normalized.sourceMeta.turns,
      hidden: normalized.sourceMeta.hidden,
      visible: normalized.sourceMeta.visible,
      greeting: typeof normalized.greeting === 'string' && keepGreeting,
    },
    // ★ 只给角色与字数，不给正文（隐私铁律）
    firstTurnPreview: first === null ? null : { role: first.role, chars: first.text.length },
    willWrite,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// 端点处理函数（lib/index.js 只加两行分派到这两个函数）
// ---------------------------------------------------------------------------

const DETECT_BRIEFS = {
  'tavern-import-context': '整份文本 JSON.parse 成功，且是对象、schemaVersion===1、qa 是数组',
  'sillytavern-jsonl': '每个非空行都能 JSON.parse 成对象，且至少一行是消息行（mes 是 string 且 is_user 是 boolean）；文件头行不算消息行',
}

/** 取源方式与上限（两格式共用，如实写进 notes：?path= 有 1 MiB 上限，更大的源走 source.text）。 */
const SOURCE_LIMIT_NOTE =
  '★ 取源上限：source.path 走 Tavern files 只读面（GET /pmp-dsh-tavern/api/v2/workspace/files?path=），'
  + '单文件读上限 1 MiB（超出 413）；更大的源必须走 source.text 直传（text 上限 8 MiB = maxBytes）。'

const FORMAT_NOTES = {
  'tavern-import-context':
    'Tavern import-context JSON：{schemaVersion:1, source, greeting:string|null, qa:[{user,assistant}]}。'
    + '校验口径与 tavern-loader 的 normalizeDocument() 一致：qa 每项 user/assistant 都是 string；'
    + 'source 非对象归 {}；greeting 非 string 归 null。qa[i] 展开为两楼（user→assistant），全部可见（hidden=false）。'
    + SOURCE_LIMIT_NOTE,
  'sillytavern-jsonl':
    'SillyTavern 聊天导出 jsonl：1 行文件头（character_name/chat_metadata/user_name）+ N 行消息（逐行独立 JSON）。'
    + '★ hidden 口径：hidden = (is_system === true)，即该楼不发给模型 —— 与归档侧 visibility 的 '
    + 'sent:false + source:"st:is_system" 同口径；is_system 键缺失 = 可见（不是隐藏）。'
    + 'role = is_user ? user : assistant；name/send_date 存在则带入。'
    + SOURCE_LIMIT_NOTE,
}

const PLANNABLE_CODES = new Set([
  'IMPORT_INVALID',
  'IMPORT_FORMAT_UNSUPPORTED',
  'IMPORT_TOO_LARGE',
  'IMPORT_TOO_MANY_TURNS',
  'IMPORT_SOURCE_UNREADABLE',
])

function errBody(code, message) {
  return { ok: false, error: { code, message } }
}

/** GET /import/formats：静态清单 + 判别口径 + hidden 口径（§3.2）。 */
export function handleImportFormats(_ctx, _req, send) {
  send(200, {
    ok: true,
    formats: IMPORT_FORMATS.map((f) => ({
      id: f.id,
      label: f.label,
      detectedBy: DETECT_BRIEFS[f.id] || '',
      notes: FORMAT_NOTES[f.id] || '',
    })),
  })
}

/** req → Tavern 同源基址（照 lib/index.js probeTavern() 的取法，不硬编码端口）。 */
function tavernBaseFromReq(req) {
  const host = req && req.headers && req.headers.host
  const localPort = req && req.socket && req.socket.localPort
  return host ? 'http://' + host : 'http://127.0.0.1' + (localPort ? ':' + localPort : '')
}

/**
 * deps.tavern 的 HTTP 版（A1 同款形状 list/read/write/mkdir）。list/read 走 Tavern
 * files 只读面；★ write/mkdir 直接抛 ZERO_WRITE_GUARD —— B1 零写入，万一被误调用
 * 当场炸响而不是静默写盘。
 */
function httpTavernDeps(req) {
  const base = tavernBaseFromReq(req)
  const call = async (query, rel) => {
    const resp = await fetch(base + TAVERN_FILES_PATH + '?' + query + '=' + encodeURIComponent(String(rel)), {
      signal: AbortSignal.timeout(TAVERN_TIMEOUT_MS),
      redirect: 'manual',
    })
    const j = await resp.json().catch(() => null)
    if (!resp.ok || !isRecord(j) || j.ok !== true) return { ok: false }
    return j
  }
  return {
    async list(rel) {
      const j = await call('list', rel)
      return { ok: j.ok === true, list: Array.isArray(j.list) ? j.list : [] }
    },
    async read(rel) {
      const j = await call('path', rel)
      if (j.ok !== true || typeof j.content !== 'string') return { ok: false }
      return { ok: true, text: j.content }
    },
    async write() {
      throw new Error('ZERO_WRITE_GUARD：B1 零落库，write 禁止调用')
    },
    async mkdir() {
      throw new Error('ZERO_WRITE_GUARD：B1 零落库，mkdir 禁止调用')
    },
  }
}

function readRequestBody(req) {
  return new Promise((resolveP, rejectP) => {
    const chunks = []
    let size = 0
    let done = false
    req.on('data', (c) => {
      if (done) return
      size += c.length
      if (size > IMPORT_BODY_CAP) {
        done = true
        chunks.length = 0
        rejectP(importError('IMPORT_TOO_LARGE', '请求体超上限（text 直传最多 ~' + importConstants.maxBytes + ' 字节源）'))
        req.resume()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!done) {
        done = true
        resolveP(Buffer.concat(chunks))
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

/**
 * POST /import/plan：解析 + 出计划（零落库零写入）。200 = 计划；400 = 结构化错误
 * （IMPORT_INVALID / IMPORT_FORMAT_UNSUPPORTED / IMPORT_TOO_LARGE /
 * IMPORT_TOO_MANY_TURNS / IMPORT_SOURCE_UNREADABLE）；其余异常收口 500 INTERNAL。
 * 日志只打 长度/哈希/计数，绝不打正文。
 */
export async function handleImportPlan(ctx, req, send, log) {
  let body
  try {
    const raw = await readRequestBody(req)
    body = JSON.parse(raw.toString('utf8') || '{}')
  } catch (e) {
    const code = e && e.code === 'IMPORT_TOO_LARGE' ? 'IMPORT_TOO_LARGE' : 'IMPORT_INVALID'
    return send(400, errBody(code, '请求体不可用：' + String((e && e.message) || e)))
  }
  try {
    const plan = await planImport(body, { tavern: httpTavernDeps(req) })
    if (typeof log === 'object' && log !== null && typeof log.info === 'function') {
      try {
        log.info(
          '[mt] /import/plan：format=' + plan.format
          + ' hash8=' + plan.hash.slice(0, 8)
          + ' stats=' + JSON.stringify(plan.stats)
          + ' willWrite=' + plan.willWrite.length
          + ' warnings=' + plan.warnings.length,
        )
      } catch {}
    }
    return send(200, plan)
  } catch (e) {
    const code = e && typeof e.code === 'string' && PLANNABLE_CODES.has(e.code) ? e.code : 'INTERNAL'
    return send(code === 'INTERNAL' ? 500 : 400, errBody(code, String((e && e.message) || e)))
  }
}
