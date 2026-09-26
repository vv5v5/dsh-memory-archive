/**
 * deadzone —— 「剧情文本**死区**（模型禁改区）」+「剧情文本**直接编辑**」的纯逻辑内核（20260923）。
 *
 * ## 为什么有它（用户 2026-09-23 原话）
 * 「**给剧情大纲加 1、剧情文本支持设置死区 2、剧情文本支持直接编辑**」。
 * 背景是真机事故：模型用 `memory_write index.md [overwrite]` 把作者写在 `index.md` 里的
 * 【核心规则】【H-scene 写作准则】**整段覆盖没了**（3 周目）。预设侧已加铁律（「开局已存在的文件
 * 只有追加权」），本模块补**用户侧**：**用户自己划"哪几段模型碰不得"**，并且能直接在面板里改这些文件。
 *
 * ## 三条不许动的口径（用户当场拍板；⛔ 谁都不许"顺手做全"）
 *   ① **死区 = 模型禁改区**：在剧情文本里划出一段（如 `index.md` 的核心规则），标明「⛔ 模型不许改写/覆盖」，
 *      系统把这条约束**喂给模型**（⇢ `mt:memoryHome` 段，见 `renderHint`）。
 *   ② **违规处理 = 只喂约束 + 检测告警**：检测到被改时**大声告警**（面板红字 + 日志），
 *      ★★ **⛔ 绝不自动改回去** —— 文件始终是用户的。这条守的是**被明确否掉的那个选项**：
 *      本模块里**没有任何一处**会把快照写回文件（自检第 8 对就是钉这件事）。
 *   ③ **判据只能是「与死区快照不符」**，⛔ 不许写成"文件被改过 = 模型干的"：
 *      用户自己也在外部编辑器改这些文件（`rulebook.md` / `大纲-*.md` / `幻蕊示例.txt` 都是他手维护的）
 *      ⇒ 告警文案一律**不定性**（见 `describeItems` 的措辞）。
 *
 * ## 粒度 = markdown 块（以空行分隔），⛔ 不做任意行范围
 * 行号会在用户或模型写入后**漂移**（今天插一行，昨天的"第 12–20 行"就指到别处了）；
 * **块级快照**同时解决了"定位"与"检测"两件事：快照本身就是那一段的原文，找它 = 在现文里找同一段。
 * ⚠️ 两条由此而来的已知语义（都如实、都不"猜"）：
 *   · 段落定位**只认 sha**（同 sha = 同一条）⇒ 两份内容**完全相同**的块算同一段（设一条两条都上锁、
 *     解锁一条两条都松）；
 *   · 首行只是**告警文案**里的补充线索（sha 找不到时用它认"这一段被改了"），⛔ 不是定位依据。
 *
 * ## 快照里的换行一律归一成 `\n`（`normalizeText`）
 * 面板里的编辑器（HTML textarea）把 `\r\n` 当 `\n` 收，保存回去就是 LF ⇒ 若按原始字节比，
 * **用户自己在面板里保存**会让同一段内容"sha 变了"，凭空告警。所以快照与现况都先归一换行再算 sha
 * （文件本身一个字节都不动 —— 归一只发生在**内存里的比较**上）。
 *
 * ## 存哪儿
 * `.roleplay-memory/.dma-deadzones.json` —— **跟笔记同一处**（用户会在周目之间手工拷这些文件，
 * 死区必须跟着拷过去）。⛔ 用点开头的我们自己的文件名、⛔ 不用 `.md`/`.txt`
 * （免得被社区预设当笔记读，也免得被本插件自己的清单列出来）。
 *
 * @license CC-BY-NC-4.0 (Attribution-NonCommercial 4.0 International)
 * 仅限个人学习与非商业用途；禁止闭源商用或转为付费插件/服务。
 */

import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** 死区数据文件（点开头 ⇒ 面板清单/社区预设都不会当笔记读它）。 */
export const DEADZONE_FILE_NAME = '.dma-deadzones.json'
export const DEADZONE_SCHEMA_VERSION = 1
/** 一条死区能带上限（防病态文档把每一段都划进去；到顶就拒，⛔ 不静默丢弃）。 */
export const DEADZONE_MAX_ZONES = 500
/** 用户给的备注名上限（只影响显示）。 */
export const DEADZONE_LABEL_MAX = 60
/** 首行摘要上限（进注入段与告警文案；⛔ 快照原文整段不进注入）。 */
export const DEADZONE_FIRST_LINE_MAX = 120
/** 一份文件在注入段里最多列几个段名（再多就折叠成「等 N 段」，⛔ 不撑爆上下文）。 */
export const DEADZONE_HINT_MAX_PER_FILE = 6

/**
 * 「直接编辑」的扩展名白名单（★ 比读侧窄：读侧是 `rel-path-jail` 那张表，
 * 写侧只放行正文类 `.md` / `.txt`）。
 * ⚠️ 死区**不受**这一条限制（它一个字节都不写文件 —— 只记快照），仍按读侧那张表走。
 */
export const RP_MEMORY_WRITE_EXTS = Object.freeze(['.md', '.txt'])

/** 中文段数（1–9；其余走阿拉伯数字）—— 注入那句话要逐字好读，别写「2段」。
 *  ★ 2 用「两」不用「二」：用户给的那句原文是「…两段」。 */
const CN_NUM = Object.freeze(['', '一', '两', '三', '四', '五', '六', '七', '八', '九'])

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// ---------------------------------------------------------------------------
// ① 纯逻辑（自检台直接吃这一层，⛔ 不碰文件系统）
// ---------------------------------------------------------------------------

/** 换行归一（`\r\n` / 单独的 `\r` ⇒ `\n`）。★ 只用于**比较**：盘上的文件一个字节都不动。 */
export function normalizeText(text) {
  return typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : ''
}

/** 文本内容的 sha256（十六进制）——「快照 sha」与「现况 sha」共用这一个算法（⛔ 不两处各算一份）。 */
export function sha256Hex(text) {
  return createHash('sha256').update(typeof text === 'string' ? text : '', 'utf8').digest('hex')
}

/** 一段的首行（trim 后截到上限）—— 进注入段与告警文案的**摘要**。 */
export function firstLineOf(text) {
  const s = typeof text === 'string' ? text : ''
  const nl = s.indexOf('\n')
  const line = (nl === -1 ? s : s.slice(0, nl)).trim()
  return line.length > DEADZONE_FIRST_LINE_MAX ? line.slice(0, DEADZONE_FIRST_LINE_MAX) + '…' : line
}

/**
 * 按**空行**切 markdown 块（用户口径：粒度 = markdown 块）。
 * 返回每块：`{index, text, chars, firstLine, sha256}` —— `text` 是**归一换行后**的块原文
 * （块内的换行保留、块之间的空行与首尾空行不参与）。
 */
export function splitBlocks(text) {
  const out = []
  let buf = []
  const flush = () => {
    if (buf.length === 0) return
    const body = buf.join('\n')
    out.push({ index: out.length, text: body, chars: body.length, firstLine: firstLineOf(body), sha256: sha256Hex(body) })
    buf = []
  }
  for (const line of normalizeText(text).split('\n')) {
    if (line.trim() === '') { flush(); continue }
    buf.push(line)
  }
  flush()
  return out
}

/** 空文档（还没有任何死区 —— 这是**正常空态**，不是错误）。 */
export function emptyDoc() {
  return { schemaVersion: DEADZONE_SCHEMA_VERSION, zones: [] }
}

/**
 * 把盘上读到的一条死区归一成内部形状；认不出（缺 file/sha）⇒ `null`（调用方丢弃这一条）。
 *
 * ★ 快照的**原文优先**：`text` 在场时 sha 由它现算（= 快照自愈：手改过的文档若 text 还在，
 *   就以 text 为准）；`text` 缺席（手写/截断过的文档）才用存下来的 `sha256`。
 */
export function normalizeZone(raw) {
  if (!isObj(raw)) return null
  const file = typeof raw.file === 'string' ? raw.file : ''
  const stored = typeof raw.sha256 === 'string' ? raw.sha256 : ''
  const text = typeof raw.text === 'string' ? normalizeText(raw.text) : ''
  if (file === '' || (text === '' && stored === '')) return null
  return {
    file,
    sha256: text === '' ? stored : sha256Hex(text),
    text,
    chars: Number.isFinite(raw.chars) ? raw.chars : text.length,
    firstLine: typeof raw.firstLine === 'string' && raw.firstLine !== '' ? raw.firstLine : firstLineOf(text),
    label: typeof raw.label === 'string' ? raw.label.slice(0, DEADZONE_LABEL_MAX) : '',
    at: typeof raw.at === 'string' ? raw.at : null,
  }
}

/** 文档归一（认不出的条目一律丢弃；`zones` 到顶就截断）。 */
export function normalizeDoc(raw) {
  const zones = []
  if (isObj(raw) && Array.isArray(raw.zones)) {
    for (const z of raw.zones) {
      const n = normalizeZone(z)
      if (n !== null) zones.push(n)
    }
  }
  return { schemaVersion: DEADZONE_SCHEMA_VERSION, zones: zones.slice(0, DEADZONE_MAX_ZONES) }
}

/** 找一条死区（同一份文件 + 同一段快照 = 同一条；段落定位**只认 sha**，⛔ 不认行号）。 */
export function findZone(doc, file, sha256) {
  const zones = Array.isArray(doc?.zones) ? doc.zones : []
  return zones.find((z) => z.file === file && z.sha256 === sha256) ?? null
}

/** 一份文件上有几条死区（面板清单那一行用）。 */
export function zoneCountsByFile(doc) {
  const out = {}
  for (const z of Array.isArray(doc?.zones) ? doc.zones : []) out[z.file] = (out[z.file] ?? 0) + 1
  return out
}

/**
 * 设置 / 解除一条死区（**纯函数**：给文档 + 请求 ⇒ 新文档）。
 *
 * @param {object} doc 现文档
 * @param {{action:'add'|'remove', file:string, sha256:string, text?:string, label?:string, at?:string}} req
 * @returns {{ok:true, doc:object, zone:object}|{ok:false, code:string, message:string}}
 */
export function decideToggle(doc, req) {
  const file = typeof req?.file === 'string' ? req.file : ''
  const sha = typeof req?.sha256 === 'string' ? req.sha256 : ''
  const base = normalizeDoc(doc)
  if (file === '' || sha === '') {
    return { ok: false, code: 'RP_MEMORY_ZONE_BAD_BODY', message: '设置死区要带 file 与 sha256（那一段的快照 sha）' }
  }
  const hit = findZone(base, file, sha)
  if (req.action === 'remove') {
    if (hit === null) {
      return { ok: false, code: 'RP_MEMORY_ZONE_MISSING', message: '这一段不在死区里（可能已经解锁，或者文件刚变过 —— 刷新一下再试）' }
    }
    return { ok: true, doc: { schemaVersion: DEADZONE_SCHEMA_VERSION, zones: base.zones.filter((z) => z !== hit) }, zone: hit }
  }
  if (req.action !== 'add') {
    return { ok: false, code: 'RP_MEMORY_ZONE_BAD_ACTION', message: '死区动作只认 add / remove' }
  }
  if (hit !== null) {
    return { ok: false, code: 'RP_MEMORY_ZONE_EXISTS', message: '这一段已经是死区了（同一段再设一次没有意义）' }
  }
  if (base.zones.length >= DEADZONE_MAX_ZONES) {
    return { ok: false, code: 'RP_MEMORY_ZONE_FULL', message: `死区条数已到上限 ${DEADZONE_MAX_ZONES} 条（先解锁几条再加）` }
  }
  const text = normalizeText(typeof req.text === 'string' ? req.text : '')
  const zone = normalizeZone({
    file, text, sha256: sha, chars: text.length,
    firstLine: firstLineOf(text),
    label: typeof req.label === 'string' ? req.label : '',
    at: typeof req.at === 'string' ? req.at : null,
  })
  if (zone === null) return { ok: false, code: 'RP_MEMORY_ZONE_BAD_BODY', message: '那一段的原文快照没带上（要设死区得给 text）' }
  return { ok: true, doc: { schemaVersion: DEADZONE_SCHEMA_VERSION, zones: base.zones.concat([zone]) }, zone }
}

/**
 * 一段死区在**现文**里还在不在（定位顺序：先 sha 完全相同 ⇒ 再首行相同）。
 * @returns {{state:'ok'|'changed'|'missing'|'missing-file', nowSha:string|null, blockIndex:number|null}}
 *   · `ok` —— 逐字未变；
 *   · `changed` —— 同一段（首行还在）但内容变了 ⇒ 告警，并给出**两个 sha**；
 *   · `missing` —— 连首行都找不到了（被整段删掉/改写/挪走）；
 *   · `missing-file` —— 那份文件在盘上读不到。
 */
export function locateZone(zone, blocks) {
  const base = { state: 'ok', nowSha: null, blockIndex: null }
  if (blocks === null) return Object.assign(base, { state: 'missing-file' })
  const exact = blocks.find((b) => b.sha256 === zone.sha256)
  if (exact !== undefined) return Object.assign(base, { blockIndex: exact.index })
  if (zone.firstLine !== '') {
    const near = blocks.find((b) => b.firstLine === zone.firstLine)
    if (near !== undefined) return Object.assign(base, { state: 'changed', nowSha: near.sha256, blockIndex: near.index })
  }
  return Object.assign(base, { state: 'missing' })
}

/**
 * 死区快照 vs 盘上现况（**纯函数**，喂给它"每份文件的现文"）。
 *
 * @param {object} doc 死区文档
 * @param {Record<string, string|null>} fileTexts 文件名 ⇒ 现文（读不到 ⇒ `null`，⛔ 别喂空串冒充）
 * @returns {{status:'ok'|'changed', zones:number, items:Array, changed:Array}}
 *   `items` 一条死区一行；`changed` 只装**不一致**的那些（一致 ⇒ 什么都不做，⛔ 不刷状态）。
 */
export function compareZones(doc, fileTexts) {
  const zones = Array.isArray(doc?.zones) ? doc.zones : []
  const cache = new Map()
  const blocksOf = (file) => {
    if (cache.has(file)) return cache.get(file)
    const t = isObj(fileTexts) ? fileTexts[file] : undefined
    const b = typeof t === 'string' ? splitBlocks(t) : null
    cache.set(file, b)
    return b
  }
  const items = zones.map((z) => {
    const found = locateZone(z, blocksOf(z.file))
    return {
      file: z.file, label: z.label, firstLine: z.firstLine,
      snapSha: z.sha256, nowSha: found.nowSha, blockIndex: found.blockIndex, state: found.state,
    }
  })
  const changed = items.filter((i) => i.state !== 'ok')
  return { status: changed.length === 0 ? 'ok' : 'changed', zones: zones.length, items, changed }
}

/**
 * ★★ **用户自己改的 ⇒ 快照跟着走**（本模块最要紧的一条"不误报"判据）。
 *
 * 面板里保存成功后拿**新文**重算：同一份文件上每条死区重新定位
 * （先 sha、再首行）⇒ 还在的**重拍快照**（sha/原文/首行都更新成现值），
 * 连首行都找不到的 ⇒ **解除该条**（那一段已经被用户整段改掉/删掉了，没有东西可守）。
 * ⛔ 这一步**只动 `.dma-deadzones.json`**，一个字节都不回写剧情文本。
 *
 * @returns {{doc:object, refreshed:number, updated:number, dropped:Array<{file,label,firstLine}>}}
 */
export function refreshAfterEdit(doc, file, newText, at) {
  const blocks = splitBlocks(newText)
  const zones = []
  const dropped = []
  let refreshed = 0
  let updated = 0
  for (const z of normalizeDoc(doc).zones) {
    if (z.file !== file) { zones.push(z); continue }
    const exact = blocks.find((b) => b.sha256 === z.sha256)
    const near = exact === undefined && z.firstLine !== '' ? blocks.find((b) => b.firstLine === z.firstLine) : undefined
    const hit = exact ?? near
    if (hit === undefined) {
      dropped.push({ file: z.file, label: z.label, firstLine: z.firstLine })
      continue
    }
    refreshed += 1
    if (hit.sha256 !== z.sha256) updated += 1
    zones.push(Object.assign({}, z, {
      sha256: hit.sha256, text: hit.text, chars: hit.chars, firstLine: hit.firstLine,
      at: typeof at === 'string' ? at : z.at,
    }))
  }
  return { doc: { schemaVersion: DEADZONE_SCHEMA_VERSION, zones }, refreshed, updated, dropped }
}

/**
 * 喂给模型的**约束那一段**（挂在 `mt:memoryHome` 里，模型每轮都看得见）。
 *
 * 形状**逐字**照用户给的那句：
 * `⛔ 死区（作者预置，你只有追加权）：index.md 的「## 【必须遵守的核心规则】」「## 【H-scene 写作准则】」两段 —— 不许改写/覆盖/删除，要更新只能追加在它们之外。`
 * ⛔ 只给**文件名 + 首行原文**，**绝不**把死区原文整段塞进注入（那会把上下文撑爆）。
 * 没有死区 ⇒ 返回空串（那一段就不出现，⛔ 不注入半句）。
 */
export function renderHint(doc) {
  const zones = Array.isArray(doc?.zones) ? doc.zones : []
  if (zones.length === 0) return ''
  const order = []
  const byFile = new Map()
  for (const z of zones) {
    if (!byFile.has(z.file)) { byFile.set(z.file, []); order.push(z.file) }
    byFile.get(z.file).push(z)
  }
  const HEAD = '⛔ 死区（作者预置，你只有追加权）：'
  const TAIL = ' —— 不许改写/覆盖/删除，要更新只能追加在它们之外。'
  return order.map((file, i) => {
    const list = byFile.get(file)
    const shown = list.slice(0, DEADZONE_HINT_MAX_PER_FILE).map((z) => '「' + z.firstLine + '」').join('')
    const count = list.length > DEADZONE_HINT_MAX_PER_FILE
      ? '等 ' + list.length + ' 段'
      : (CN_NUM[list.length] ?? String(list.length)) + '段'
    return (i === 0 ? HEAD : '') + file + ' 的' + shown + count + TAIL
  }).join('\n')
}

/** 写侧扩展名白名单（`.md` / `.txt`；⛔ 其余一律不写，路径越界由 rel-path-jail 另有裁决）。 */
export function writableExtOk(name) {
  if (typeof name !== 'string' || name === '') return false
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return RP_MEMORY_WRITE_EXTS.includes(name.slice(dot).toLowerCase())
}

/**
 * 备份名（`<文件>.bak-<时间戳>`，与 `compaction-threshold.js` / `collect-scan.js` 同款拼法）。
 * ★ 2026-09-26（收纳，用户口径「各种bak堆满了……藏一下」）：备份统一落进**同目录的 `.bak/`
 *   子目录**（`<目录>/.bak/<文件>.bak-<戳>`）—— 真机 3 天就堆了 71 份躺在 `.roleplay-memory/`
 *   顶层，面板那侧 `listRpMemoryFiles` 的顶层 readdir 把它们全数计成 skipped 噪声。
 *   用 dot 前缀 + 子目录：`listRpMemoryFiles` 的 `isFile()` 过滤把它折成 1 条 skipped，
 *   备份仍在**同一块盘、同一个记忆目录里**（恢复语义不变，⛔ 不引入任何写死的机外路径）。
 */
export function backupNameFor(name, stamp) {
  return join(dirname(name), '.bak', basename(name) + '.bak-' + String(stamp))
}

/**
 * 时间戳（ISO 把 `:` `.` 换成 `-`，**带毫秒**；与 `vector-panel.js` 的 `removedStamp` 同形，只多三位）。
 * 为什么带毫秒：同一秒里连点两次保存时，秒级戳会让第二次的备份**盖掉**第一次那份
 * （文件名撞上 = 上一份"改前"没了）；毫秒戳让每一次备份都留得住。
 */
export function stampNow(now) {
  const d = now instanceof Date ? now : new Date()
  return d.toISOString().replace(/[:.]/g, '-').slice(0, 23)
}

/**
 * 「直接编辑」落盘前的**裁决**（纯函数：现文由调用方读好喂进来 ⇒ 自检台不用起 HTTP 就能直测）。
 *
 * 纪律（全仓既有口径，照抄）：
 *   ① ⛔ 编辑 ≠ 新建：文件不在 ⇒ 拒（409 那一类里我们给 404 —— 它确实是"没有"）；
 *   ② ⛔ 只改 `.md` / `.txt`；
 *   ③ **乐观锁**：`sha256` 必须是**用户看到的那份**的 sha，与盘上现文对不上 ⇒ 409 + 可读文案（⛔ 不静默覆盖）；
 *   ④ 面板显示被截断过的大文件（超 `maxChars`）⇒ 拒（否则会把没显示出来的部分写没）。
 *
 * @returns {{ok:true, chars:number, bytes:number, sha256:string}|{ok:false, status:number, code:string, message:string}}
 */
export function decideWrite(req) {
  const file = typeof req?.file === 'string' ? req.file : ''
  const text = req?.text
  const want = typeof req?.sha256 === 'string' ? req.sha256 : ''
  const maxChars = Number.isFinite(req?.maxChars) ? req.maxChars : 200000
  if (file === '' || typeof text !== 'string') {
    return { ok: false, status: 400, code: 'RP_MEMORY_WRITE_BAD_BODY', message: '保存要带 file 与 text（整份正文）' }
  }
  if (!writableExtOk(file)) {
    return {
      ok: false, status: 400, code: 'RP_MEMORY_WRITE_EXTS',
      message: `面板里只直接改 ${RP_MEMORY_WRITE_EXTS.join(' / ')}（这一份是 ${file}）—— 其他类型请用系统编辑器`,
    }
  }
  if (req?.exists !== true) {
    return { ok: false, status: 404, code: 'RP_MEMORY_FILE_MISSING', message: `记忆库里还没有 ${file}（编辑 ≠ 新建，这里不替你先建一份）` }
  }
  if (typeof req?.currentText !== 'string') {
    return { ok: false, status: 409, code: 'RP_MEMORY_WRITE_UNREADABLE', message: `${file} 现在读不出来（权限或路径问题）⇒ 拒改` }
  }
  if (req.currentText.length > maxChars) {
    return {
      ok: false, status: 413, code: 'RP_MEMORY_WRITE_TOO_BIG',
      message: `${file} 有 ${req.currentText.length} 字符，超过面板一次能显示的 ${maxChars} 字符 ⇒ 拒改`
        + '（在面板里改它会把没显示出来的部分写没）。请用系统编辑器改。',
    }
  }
  if (want === '') {
    return { ok: false, status: 400, code: 'RP_MEMORY_WRITE_BAD_BODY', message: '保存要带上你看到的那份的 sha256（乐观锁）' }
  }
  const now = sha256Hex(req.currentText)
  if (now !== want) {
    return {
      ok: false, status: 409, code: 'RP_MEMORY_WRITE_STALE',
      message: '盘上已经变了（可能是模型刚写过，也可能是你在别处改过），先刷新再改 —— 你手里的那份没有覆盖上去',
    }
  }
  return { ok: true, chars: text.length, bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256Hex(text) }
}

// ---------------------------------------------------------------------------
// ② 落盘（薄薄一层：读/写那份 `.dma-deadzones.json` + 写前备份）
// ---------------------------------------------------------------------------

/**
 * 读死区文档。
 * @returns {{doc:object, error:null|'unreadable'|'corrupt', exists:boolean}}
 *   文件不在 ⇒ 正常空态（`error:null / exists:false`）；**在但读不出来/不是合法 JSON ⇒ 如实报错**
 *   （⛔ 不许折成"没有死区" —— 那会让告警静默消失）。
 */
export function readDocFile(dir) {
  if (typeof dir !== 'string' || dir === '') return { doc: emptyDoc(), error: null, exists: false }
  let raw
  try {
    raw = readFileSync(join(dir, DEADZONE_FILE_NAME), 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return { doc: emptyDoc(), error: null, exists: false }
    return { doc: emptyDoc(), error: 'unreadable', exists: true }
  }
  try {
    return { doc: normalizeDoc(JSON.parse(raw)), error: null, exists: true }
  } catch {
    return { doc: emptyDoc(), error: 'corrupt', exists: true }
  }
}

/** 写死区文档（临时文件 + rename，与 `writeConfigFile` 同款原子写法；⛔ 不动任何剧情文本）。 */
export function writeDocFile(dir, doc) {
  mkdirSync(dir, { recursive: true })
  const finalPath = join(dir, DEADZONE_FILE_NAME)
  const tmpPath = finalPath + '.tmp'
  writeFileSync(tmpPath, JSON.stringify(normalizeDoc(doc), null, 2) + '\n', 'utf8')
  renameSync(tmpPath, finalPath)
  return finalPath
}

/** 文档当前是否已经在盘上（段里/告警都不必读整份时用它先探一脚）。 */
export function docExists(dir) {
  if (typeof dir !== 'string' || dir === '') return false
  try { return statSync(join(dir, DEADZONE_FILE_NAME)).isFile() } catch { return false }
}

/**
 * 写前备份 + 落盘（`compaction-threshold.js` 的同一套纪律：**先备份、再写、写后回读校验**）。
 * ⛔ 备份是**复制**（改名归档的语义：原件改名留档、新件顶上），⛔ 绝不 rm / 绝不销毁。
 *
 * @returns {{ok:true, backupPath:string, bytes:number}|{ok:false, backupPath:string|null, reason:string}}
 */
export function writeWithBackup(absPath, text, stamp) {
  const backupPath = backupNameFor(absPath, stamp)
  try {
    // ★ 备份进 `.bak/` 子目录 ⇒ 先保证它在（已存在时 recursive mkdir 是 no-op，幂等）
    mkdirSync(dirname(backupPath), { recursive: true })
    copyFileSync(absPath, backupPath)
  } catch (e) {
    return { ok: false, backupPath: null, reason: `备份失败（${e?.code || e?.message || e}）⇒ 一个字都没改` }
  }
  try {
    writeFileSync(absPath, text, 'utf8')
  } catch (e) {
    return { ok: false, backupPath, reason: `写盘失败（${e?.code || e?.message || e}）—— 备份 ${backupPath} 保留在原地` }
  }
  let reread = null
  try {
    reread = readFileSync(absPath, 'utf8')
  } catch (e) {
    return { ok: false, backupPath, reason: `写后回读失败（${e?.code || e?.message || e}）—— 备份 ${backupPath} 保留在原地` }
  }
  if (reread !== text) {
    return { ok: false, backupPath, reason: `写后回读校验不一致 —— 备份 ${backupPath} 保留在原地` }
  }
  return { ok: true, backupPath, bytes: Buffer.byteLength(text, 'utf8') }
}

export default {
  DEADZONE_FILE_NAME, DEADZONE_SCHEMA_VERSION, DEADZONE_MAX_ZONES,
  RP_MEMORY_WRITE_EXTS,
  normalizeText, sha256Hex, firstLineOf, splitBlocks, emptyDoc,
  normalizeZone, normalizeDoc, findZone, zoneCountsByFile, decideToggle,
  locateZone, compareZones, refreshAfterEdit, renderHint,
  writableExtOk, backupNameFor, stampNow, decideWrite,
  readDocFile, writeDocFile, docExists, writeWithBackup,
}
