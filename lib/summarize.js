/**
 * summarize —— 20260918 撤掉「扫归档 → 总结」侧路之后，本模块只剩三块，**无一调模型**：
 *
 *   ① `looksLikePromptEcho` —— 摘要输出的「回声」判据（纯函数）。消费方是**压缩链**那条路：
 *      lib/collect-scan.js 从官方 compaction/summary 事件取模型正文时过这道闸
 *      （模型把指令原文当摘要回吐 ⇒ 拒收，该区间回落机械条目 + 大声播报）。
 *   ② `parseSummaryOutput` / `extractJson` / `normalizeSummaryItem` / `buildSummaryMessages` ——
 *      anima 口径的摘要解析 / 拼消息**纯函数**（自检在用；解析判据与 anima 逐字对齐，留作工具）。
 *   ③ `resetSummaries`（POST /summarize/reset）—— 清空总结的**运维口**：只清摘要、**不调模型**
 *      （备份正文 → 清空 → 重置 index；保留原文楼层与导入批次清单）。
 *
 * 历史（为什么没有「扫归档 → 总结」了）：旧的那条路会**自己发 HTTP、自己配 url/model/key**
 * 调一个副渠道产摘要 —— 用户口径（2026-09-18）：总结应该**直接走主 API**，不用配置才对。
 * 压缩链本来就是这么干的（ctx.llm.stream，见 lib/mt-compaction.js），于是侧路整个拆除：
 * 摘要条目由 collect-scan 优先取 compaction/summary 事件里的模型正文（该文件 D1 注），
 * 本模块不再有任何模型调用、渠道配置与端点（reset 除外，它不调模型）。
 *
 * ⛔ 只动 `archive/summaries/*` 与 `manifest.json` 的 `summaries.*`：
 *    不碰 `floors/`、不碰 `visibility.json`、不碰任何会话。
 * ⛔ 摘要正文**不带元信息头**：这段文字之后要被 embed 进向量库，头会污染切片。
 */
import { tavernForRequest } from './collect.js'

const INDEX_KIND = 'dsh-tavern-l2-summaries'

function fail(code, message, extra) {
  const e = new Error(message)
  e.code = code
  if (extra !== undefined) e.details = extra
  return e
}

/** `characterId/playthroughId/archive`（与 collect.js / import-formats.js 同一口径）。 */
export function archiveRelOf(target) {
  if (!target || typeof target.characterId !== 'string' || typeof target.playthroughId !== 'string'
    || target.characterId === '' || target.playthroughId === '') {
    throw fail('SUMMARIZE_TARGET_INVALID', '缺 target（{characterId, playthroughId}）')
  }
  for (const k of ['characterId', 'playthroughId']) {
    const v = target[k]
    if (v.includes('/') || v.includes('\\') || v.includes('..')) {
      throw fail('SUMMARIZE_TARGET_INVALID', 'target.' + k + ' 含非法字符')
    }
  }
  return target.characterId + '/' + target.playthroughId + '/archive'
}

// ─────────────────────────── 读（reset 用）

async function readIndex(tavern, archiveRel) {
  const p = archiveRel + '/summaries/index.json'
  let raw = null
  try {
    const r = await tavern.read(p)
    raw = r.content
  } catch (e) {
    // 文件不存在 = 还没总结过（正常）；其它错照抛
    const code = String(e && e.code || '')
    if (code.includes('404') || code.includes('ENOENT')) return { path: p, raw: null, entries: [], missing: true }
    throw e
  }
  let j = null
  try { j = JSON.parse(raw) } catch {
    throw fail('SUMMARIZE_INDEX_BROKEN', 'summaries/index.json 存在但解析不了（fail-closed，拒绝写）')
  }
  if (!j || j.schemaVersion !== 1 || j.kind !== INDEX_KIND || !Array.isArray(j.entries)) {
    throw fail('SUMMARIZE_INDEX_BROKEN', 'summaries/index.json 的 schemaVersion/kind 不是本写入器的口径（fail-closed）')
  }
  return { path: p, raw, entries: j.entries, missing: false }
}

// ─────────────────────────── 模型输出解析（照 anima 的口径；纯函数，本模块没有调用方时自检在用）

/** 两级抓取：先代码栏，再括号配平暴力扫。找不到返回 null。 */
export function extractJson(text) {
  const s = String(text ?? '')
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(s)
  const candidates = []
  if (fence) candidates.push(fence[1])
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c !== '[' && c !== '{') continue
    const open = c
    const close = c === '[' ? ']' : '}'
    let depth = 0
    let inStr = false
    let esc = false
    for (let j = i; j < s.length; j++) {
      const ch = s[j]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') { inStr = true; continue }
      if (ch === open) depth++
      else if (ch === close) {
        depth--
        if (depth === 0) { candidates.push(s.slice(i, j + 1)); break }
      }
    }
    if (candidates.length > 1) break
  }
  for (const cand of candidates) {
    try { return JSON.parse(cand) } catch { /* 换下一个候选 */ }
  }
  return null
}

/** `{summary, tags:{vibe,special,important}}` → `{text, tags[]}`；`important:true` ⇒ `Important`。 */
export function normalizeSummaryItem(item) {
  if (typeof item === 'string') return { text: item.trim(), tags: [] }
  if (!item || typeof item !== 'object') return { text: '', tags: [] }
  const text = String(item.summary ?? item.Summary ?? item.content ?? item.Content ?? item.text ?? item.Text ?? '').trim()
  const tags = []
  const raw = item.tags ?? item.Tags ?? item.tag ?? item.Tag
  if (Array.isArray(raw)) {
    for (const t of raw) if (typeof t === 'string' && t.trim() !== '') tags.push(t.trim())
  } else if (typeof raw === 'string' && raw.trim() !== '') {
    tags.push(raw.trim())
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (v === true) tags.push(k.charAt(0).toUpperCase() + k.slice(1))
      else if (typeof v === 'string' && v.trim() !== '') tags.push(v.trim())
    }
  }
  return { text, tags: [...new Set(tags)] }
}

/**
 * 摘要输出的**回声**判据（纯函数，零 IO，可自检）。
 *
 * ★ 为什么必须有这道兜底（2026-09-18 真机）：
 *   早期照 anima 的段序（指令作**最后一条 system**）发过去时，模型把末尾那条 system 当成
 *   要续写的内容，**回的是规范原文**——实测落盘的"摘要"就是
 *   `Do NOT use time/location change…` / `Now, execute. Format EXACTLY as specified.` 这类句子。
 *   段序已在生成器里改掉（根因已消），但压缩链这条路同样会把我们的指令发给模型、模型同样
 *   可能把指令回吐成"摘要" ⇒ 万一回声，那段指令原文会照样落盘、照样被 anima 入库、照样进
 *   system（真机 `dsh-memory` 里就躺着这么一条）。
 *   ⇒ 这里是**兜底拒收**：输出与指令高度重合 ⇒ 判 "不是摘要"，**不落盘**。
 *   消费方：lib/collect-scan.js（压缩链摘要归一化处），见该文件 prompt-echo 一节。
 *
 * 判据（两条互补，都不写死任何提示词原文 —— 全从传进来的 `instruction` 推）：
 *   ① 整段逐字出现在指令里；或
 *   ② 正文里**一半以上的行**能在指令里逐字找到（回声就是从指令里抄来的碎片）。
 *   `instruction` 为空 = 拿不到当前生效的指令 ⇒ **只按结构判**（本函数恒 false，不瞎猜）。
 */
export function looksLikePromptEcho(text, instruction, opts = {}) {
  const t = String(text ?? '').trim()
  const ins = String(instruction ?? '').trim()
  if (t === '' || ins === '') return false
  if (t.length > ins.length) return false   // 比指令还长 ⇒ 不可能是回声
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim()
  // ★ 比之前先把 JSON 标点擦掉：回声经常裹在 `[{"summary":"…"}]` 里，
  //   末尾的 `]}` 会粘在最后一行上 ⇒ 那行就再也逐字匹配不上（实测踩到过：比例 1/3，
  //   于是"坏 JSON 里的回声"整个漏过闸门）。擦掉括号引号后 3/3。
  const scrub = (s) => norm(s).replace(/[[\]{}"',:]+/g, ' ').replace(/\s+/g, ' ').trim()
  const insS = scrub(ins)
  if (insS.includes(scrub(t))) return true
  const lines = t.split('\n').map((l) => l.trim()).filter((l) => l.length >= 8)
  if (lines.length === 0) return false
  const hit = lines.filter((l) => insS.includes(scrub(l))).length
  return hit / lines.length >= (opts.minLineRatio ?? 0.5)
}

/**
 * @param {string} raw 模型原始输出
 * @param {{instruction?: string}} [opts] 给了 `instruction` 就做**回声拒收**（见上）
 */
export function parseSummaryOutput(raw, opts = {}) {
  const instruction = String(opts?.instruction ?? '')
  const echo = (s) => instruction !== '' && looksLikePromptEcho(s, instruction)
  const parsed = extractJson(raw)
  const list = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : [])
  const items = []
  let droppedEcho = 0
  for (const item of list) {
    const one = normalizeSummaryItem(item)
    if (one.text === '') continue
    if (echo(one.text)) { droppedEcho += 1; continue }
    items.push(one)
  }
  if (items.length > 0) return { ok: true, items, usedJson: true }
  // ★ 抽出了条目、但**全被回声闸门拦下** ⇒ 到此为止，⛔ 不许再掉进下面的"纯文本兜底"
  //   （否则 raw 会以"纯文本摘要"的身份被收下 —— 闸门形同虚设。这个坑正是自检抓出来的。）
  if (droppedEcho > 0) return { ok: false, items: [], usedJson: true, echo: true }
  const plain = String(raw ?? '').trim()
  if (plain === '') return { ok: false, items: [], usedJson: false }
  if (echo(plain)) return { ok: false, items: [], usedJson: false, echo: true }
  return { ok: true, items: [{ text: plain, tags: [] }], usedJson: false }
}

// ─────────────────────────── 拼消息（anima 那套分段，能落多少落多少；压缩链段序同此）

/**
 * 消息形状（2026-09-16 真机修正）：
 *   system①  破限头（玩家填了才有）+ 指令（面板里那份 anima 原文）
 *   user②    `<previous_summary>` 块（有上一区间摘要才有；放在正文**外面** ⇒ 不参与总结）
 *             + `<text_to_summarize>` + `说话人: 正文` 逐楼 + `</text_to_summarize>`
 *
 * ⛔ **为什么不是 anima 那个"指令作最后一条 system"的段序**：真机实测（DeepSeek-V3.2 @ SiliconFlow）
 *    照那个段序发过去，模型把**末尾那条 system 当成要续写的内容**，回的是指令自己的碎片
 *    （实测落盘的"摘要"是 "Do NOT use time/location change…" 这类规范原文）而不是总结。
 *    改成"指令在前、待总结正文作最后一条 user"之后才正常。
 *    —— 这也是所有摘要器的标准形状：system 交代任务，user 是被处理的数据。
 */
export function buildSummaryMessages({ floors, instruction, jailbreak, previousSummary, includeNames = true }) {
  const sys = []
  if (typeof jailbreak === 'string' && jailbreak.trim() !== '') sys.push(jailbreak.trim())
  sys.push(String(instruction ?? ''))
  const body = floors.map((f) => {
    const who = includeNames && f.name ? f.name : (f.isUser ? 'User' : 'AI')
    return who + ': ' + f.mes
  }).join('\n\n')
  const parts = []
  if (typeof previousSummary === 'string' && previousSummary.trim() !== '') {
    parts.push('<previous_summary>\n' + previousSummary.trim() + '\n</previous_summary>')
  }
  parts.push('<text_to_summarize>\n' + body + '\n</text_to_summarize>')
  return [
    { role: 'system', content: sys.join('\n\n') },
    { role: 'user', content: parts.join('\n\n') },
  ]
}

// ─────────────────────────── 落库（只动 summaries + manifest；reset 专用）

/** 把当前 `index.entries` 原样写回（覆盖清理与追加都用它 ⇒ 只有一处写 index 的逻辑）。 */
async function writeIndex({ tavern, archiveRel, index }) {
  const next = {
    schemaVersion: 1,
    kind: INDEX_KIND,
    updatedAt: new Date().toISOString(),
    entries: index.entries,
  }
  const text = JSON.stringify(next, null, 2) + '\n'
  await tavern.write(index.path, text)
  const back = await tavern.read(index.path)
  if (back.content !== text) throw fail('SUMMARIZE_WRITE_UNVERIFIED', '写盘后回读不一致：' + index.path)
}

// ─────────────────────────── 清空总结（运维口：只清摘要、不调模型）

/**
 * 清空「内容摘要」——**保留原文楼层**与**导入批次清单**：
 *   ① 把每条内容摘要的正文**备份**到 `archive/_backup-summaries-<时间戳>/`（走 PUT 写文件，
 *      摘要都是几 KB，远低于 Tavern 的 1 MiB/文件 上限）；
 *   ② 把原来那些 `.md` **清空**（Tavern 工作区面**只有 GET/PUT、没有 DELETE** ⇒ 清空是能做到的
 *      最干净处置；空文件不会被自动入库读进来，因为空文本会被跳过）；
 *   ③ 重写 `summaries/index.json`：**只留 `import-*`** 条目 ⇒ 覆盖记录清零。
 * ⛔ 不碰 `floors/`（原文）、不碰 `visibility.json`、不碰别的周目。
 * ⛔ `dryRun:true` 只出计划、零写入。
 */
export async function resetSummaries(input = {}, deps = {}) {
  const target = input.target
  const archiveRel = archiveRelOf(target)
  const tavern = deps.tavern || tavernForRequest(deps.req, deps)
  if (!tavern || typeof tavern.read !== 'function') throw fail('TAVERN_CONFIG', 'resetSummaries 缺可用的 tavern 客户端')
  const dryRun = input.dryRun === true
  const now = typeof deps.now === 'function' ? deps.now() : Date.now()
  const index = await readIndex(tavern, archiveRel)
  const content = index.entries.filter((e) => e && typeof e.id === 'string' && !String(e.id).startsWith('import-'))
  const kept = index.entries.filter((e) => e && typeof e.id === 'string' && String(e.id).startsWith('import-'))
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  const backupRel = archiveRel + '/_backup-summaries-' + stamp
  const out = {
    ok: true, dryRun, archiveRel, content: content.length, kept: kept.length,
    backupRel, backupFiles: 0, cleared: 0, failed: 0, results: [], reason: null,
  }
  if (content.length === 0) { out.reason = '没有内容摘要可清（可能已经清过了）'; return out }
  if (dryRun) { out.reason = 'dryRun：零写入（会清 ' + content.length + ' 条、备份到 ' + backupRel + '）'; return out }

  try { await tavern.mkdir(backupRel) } catch { /* 目录已存在/建不动都不致命，写的时候会再报 */ }
  for (const e of content) {
    const file = typeof e.file === 'string' && e.file !== '' ? e.file : (typeof e.id === 'string' ? e.id + '.md' : '')
    if (file === '') { out.failed += 1; out.results.push({ id: String(e.id), ok: false, error: 'SUMMARIZE_ENTRY_NO_FILE' }); continue }
    let backed = false
    try {
      const r = await tavern.read(archiveRel + '/summaries/' + file)
      const text = typeof r?.content === 'string' ? r.content : ''
      if (text !== '') { await tavern.write(backupRel + '/' + file, text); out.backupFiles += 1; backed = true }
    } catch (err) {
      out.results.push({ id: String(e.id), ok: false, error: 'BACKUP_FAILED ' + String(err?.message ?? err) })
      out.failed += 1
      continue   // ⛔ 备份失败就**不清**这一条（宁可不干净，也不丢内容）
    }
    try {
      await tavern.write(archiveRel + '/summaries/' + file, '')
      out.cleared += 1
      out.results.push({ id: String(e.id), ok: true, error: backed ? null : '原文为空（无需备份）' })
    } catch (err) {
      out.failed += 1
      out.results.push({ id: String(e.id), ok: false, error: 'CLEAR_FAILED ' + String(err?.message ?? err) })
    }
  }
  // index 只留 import-*（⭐ 这是"归档里还有没有总结"的唯一判据）
  index.entries = kept
  await writeIndex({ tavern, archiveRel, index })
  // manifest 的 summaries.count 尽量跟着改（没有就不新建）
  try {
    const rel = archiveRel + '/manifest.json'
    const cur = JSON.parse((await tavern.read(rel)).content)
    if (cur && typeof cur === 'object') {
      cur.summaries = cur.summaries && typeof cur.summaries === 'object' ? cur.summaries : {}
      cur.summaries.count = kept.length
      cur.summaries.writer = 'dsh-memory-archive/reset'
      await tavern.write(rel, JSON.stringify(cur, null, 2) + '\n')
    }
  } catch { /* manifest 不存在 ⇒ 跳过，不新建 */ }

  out.ok = out.failed === 0
  out.reason = out.ok
    ? `已清空 ${out.cleared} 条内容摘要（备份 ${out.backupFiles} 个文件到 ${backupRel}）；原文与批次清单未动`
    : `清空完成但有 ${out.failed} 条失败（已备份 ${out.backupFiles} 个文件到 ${backupRel}）`
  return out
}

export async function handleSummarizeReset(ctx, url, req, send, deps = {}) {
  const body = await readJsonBody(req)
  const out = await resetSummaries(body, { ...deps, req })
  return send(out.ok ? 200 : 207, out)
}

async function readJsonBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try { return JSON.parse(text) } catch { throw fail('SUMMARIZE_BODY_INVALID', '请求体不是合法 JSON') }
}
