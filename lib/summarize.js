/**
 * 手动「扫归档原文 → 总结」（2026-09-16）
 *
 * 为什么要有它：导入只落**原文**（`floors/`）+ 一条**批次清单**（`summaries/import-*.md` 里只有
 * 来源格式/哈希/体积/楼层数），归档里**没有任何内容摘要**。近场记忆（`<immediateHistory>`）
 * 与远端检索（`dsh-anima-rag` 的自动入库）都吃 `summaries/`，所以缺的就是这一步。
 *
 * 形状（两步：预览即合同）：
 *   `planSummarize()`  —— **零 LLM 调用**：列楼层 → 按 `rangeSize`（默认 20，与 anima 的
 *                        `trigger_interval` 同口径）切区间 → 已经在 `summaries/index.json` 里
 *                        覆盖过的区间标 `covered`。只读。
 *   `applySummarize()` —— 逐区间：读楼层 → 拼 anima 那套消息（破限头[可选] +
 *                        `<previous_summary>`[有就要] + 正文包在 `<text_to_summarize>` 里 +
 *                        指令作最后一条 system）→ 调 `api` 渠道 → 两级抓 JSON → 写
 *                        `summaries/s-XXXX-YYYY.md` + 追加 index 条目。
 *
 * ⛔ 只动 `archive/summaries/*` 与 `manifest.json` 的 `summaries.*`：
 *    不碰 `floors/`、不碰 `visibility.json`、不碰任何会话。
 * ⛔ 摘要正文**不带元信息头**：这段文字之后要被 embed 进向量库，头会污染切片。
 */
import { tavernForRequest } from './collect.js'

const SUMMARY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const INDEX_KIND = 'dsh-tavern-l2-summaries'

function fail(code, message, extra) {
  const e = new Error(message)
  e.code = code
  if (extra !== undefined) e.details = extra
  return e
}

const pad4 = (n) => String(n).padStart(4, '0')

export function defaultSummarizeConfig(raw) {
  const s = raw && typeof raw === 'object' ? raw : {}
  const n = Number(s.rangeSize)
  return {
    /** 每个总结区间覆盖多少楼。anima 的 `trigger_interval` 实测是 20，这里同口径。 */
    rangeSize: Number.isInteger(n) && n > 0 && n <= 200 ? n : 20,
  }
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

// ─────────────────────────── 读

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

/** 归档里有哪些楼层（只看 `floors/NNNN.json` 的文件名，不读内容）。 */
async function listFloorNumbers(tavern, archiveRel) {
  const rel = archiveRel + '/floors'
  let data = null
  try { data = await tavern.list(rel) } catch (e) {
    const code = String(e && e.code || '')
    if (code.includes('404') || code.includes('ENOENT')) return []
    throw e
  }
  const names = Array.isArray(data.list) ? data.list : []
  const out = []
  for (const item of names) {
    // ⛔ 真机实测（2026-09-16）：Tavern 的 list 每项是 **`{path, type}`**，不是 `{name, type}`
    //    —— 只认 `name` 会数出 0 楼（嘴上说"归档里没有楼层"，而磁盘上明明有 254 个）。
    //    兼容三种形状：字符串 / `{name}` / `{path}`（取 basename）。
    const raw = typeof item === 'string'
      ? item
      : (item && typeof item.name === 'string' && item.name !== ''
        ? item.name
        : (item && typeof item.path === 'string' ? item.path : ''))
    if (raw === '') continue
    const base = raw.slice(raw.lastIndexOf('/') + 1)
    const m = /^(\d{4})\.json$/.exec(base)
    if (m) out.push(Number(m[1]))
  }
  return out.sort((a, b) => a - b)
}

async function readFloor(tavern, archiveRel, n) {
  const r = await tavern.read(archiveRel + '/floors/' + pad4(n) + '.json')
  let j = null
  try { j = JSON.parse(r.content) } catch { throw fail('SUMMARIZE_FLOOR_BROKEN', '楼层文件不是合法 JSON：' + pad4(n)) }
  return {
    floor: n,
    name: typeof j.name === 'string' && j.name !== '' ? j.name : (j.is_user ? 'User' : 'AI'),
    isUser: j.is_user === true,
    isSystem: j.is_system === true,
    mes: typeof j.mes === 'string' ? j.mes : '',
  }
}

// ─────────────────────────── 计划

/**
 * 零 LLM 的只读计划：把归档楼层按 `rangeSize` 切成区间，标出哪些已经被总结覆盖。
 * @returns `{ok, target, archiveRel, rangeSize, floorCount, ranges:[…], toSummarize:[…]}`
 */
export async function planSummarize(input = {}, deps = {}) {
  const target = input.target
  const archiveRel = archiveRelOf(target)
  const cfg = defaultSummarizeConfig(deps.config)
  const rangeSize = Number.isInteger(input.rangeSize) && input.rangeSize > 0 ? input.rangeSize : cfg.rangeSize
  const tavern = deps.tavern || tavernForRequest(deps.req, deps)
  if (!tavern || typeof tavern.list !== 'function') throw fail('TAVERN_CONFIG', 'planSummarize 缺可用的 tavern 客户端')

  const nums = await listFloorNumbers(tavern, archiveRel)
  if (nums.length === 0) {
    return { ok: true, target, archiveRel, rangeSize, floorCount: 0, ranges: [], toSummarize: [], reason: '归档里没有楼层（先导入或先收纳）' }
  }
  const { entries } = await readIndex(tavern, archiveRel)
  const covered = (from, to) => entries.some((e) => Number.isInteger(e.fromFloor) && Number.isInteger(e.toFloor)
    && e.fromFloor <= from && e.toFloor >= to && typeof e.id === 'string' && !String(e.id).startsWith('import-'))
  const min = nums[0]
  const max = nums[nums.length - 1]
  const ranges = []
  for (let from = min; from <= max; from += rangeSize) {
    const to = Math.min(from + rangeSize - 1, max)
    const have = nums.filter((n) => n >= from && n <= to).length
    const isCovered = covered(from, to)
    ranges.push({
      fromFloor: from, toFloor: to, floors: have,
      covered: isCovered, needsSummary: !isCovered && have > 0,
    })
  }
  return {
    ok: true, target, archiveRel, rangeSize, floorCount: nums.length,
    ranges,
    toSummarize: ranges.filter((r) => r.needsSummary).map((r) => ({ fromFloor: r.fromFloor, toFloor: r.toFloor })),
  }
}

// ─────────────────────────── 模型输出解析（照 anima 的口径）

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

/** 从模型输出里取**全部**摘要条目（anima 也是把数组每一项各存一条切片 ⇒ tags 才带得进去）。
 *  不是 JSON 就退化成"整段纯文本算一条"。 */
export function parseSummaryOutput(raw) {
  const parsed = extractJson(raw)
  const list = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : [])
  const items = []
  for (const item of list) {
    const one = normalizeSummaryItem(item)
    if (one.text !== '') items.push(one)
  }
  if (items.length > 0) return { ok: true, items, usedJson: true }
  const plain = String(raw ?? '').trim()
  if (plain === '') return { ok: false, items: [], usedJson: false }
  return { ok: true, items: [{ text: plain, tags: [] }], usedJson: false }
}

// ─────────────────────────── 拼消息（anima 那套分段，能落多少落多少）

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

/** 兜底渠道（这台机器 ST 侧那四个渠道用的就是它；换渠道在面板设置里改 `api.url/model`）。 */
export const DEFAULT_SUMMARY_API_URL = 'https://api.siliconflow.cn/v1'
export const DEFAULT_SUMMARY_API_MODEL = 'deepseek-ai/DeepSeek-V3.2'

/** 调总结渠道（OpenAI 兼容 `/chat/completions`）。失败抛带 code 的错。
 *  url/model/key 的取值顺序：显式传入 > 环境变量 > 内置兜底（key 没有兜底值 ⇒ 必须能给到）。 */
export async function callSummaryModel({ api, messages, fetchImpl, timeoutMs = 120000 }) {
  const env = process.env || {}
  const url = String(api?.url || env.ANIMA_RAG_EMBED_URL || DEFAULT_SUMMARY_API_URL).replace(/\/+$/, '')
  const model = String(api?.model || env.ANIMA_RAG_SUMMARY_MODEL || DEFAULT_SUMMARY_API_MODEL)
  const key = String(api?.key || env.SILICONFLOW_API_KEY || env.ANIMA_RAG_EMBED_KEY || '')
  if (key === '') {
    throw fail('SUMMARIZE_API_INCOMPLETE', '没拿到总结渠道的 key：面板设置里填 api.key，或设环境变量 ANIMA_RAG_EMBED_KEY / SILICONFLOW_API_KEY')
  }
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : (u, o) => fetch(u, o)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let resp
  try {
    resp = await doFetch(url + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, messages, temperature: Number(api.temperature) || 1, max_tokens: Number(api.maxTokens) || 8192, stream: false }),
      signal: ctrl.signal,
    })
  } catch (e) {
    const why = e && (e.name === 'AbortError' || e.name === 'TimeoutError') ? `超时（${timeoutMs}ms）` : String(e && e.message || e)
    throw fail('SUMMARIZE_API_FAILED', '总结渠道请求失败：' + why)
  } finally { clearTimeout(timer) }
  let data = null
  try { data = await resp.json() } catch {}
  if (!resp.ok) {
    const msg = data && data.error && (data.error.message || data.error.code) ? String(data.error.message || data.error.code) : ''
    throw fail('SUMMARIZE_API_HTTP_' + resp.status, '总结渠道返回 HTTP ' + resp.status + (msg ? '（' + msg + '）' : ''))
  }
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.trim() === '') throw fail('SUMMARIZE_API_EMPTY', '总结渠道返回空内容')
  return content
}

// ─────────────────────────── 落库（只动 summaries + manifest）

async function writeSummaryFile({ tavern, archiveRel, id, text }) {
  const rel = archiveRel + '/summaries/' + id + '.md'
  await tavern.mkdir(archiveRel + '/summaries')
  await tavern.write(rel, text)
  const back = await tavern.read(rel)
  if (back.content !== text) throw fail('SUMMARIZE_WRITE_UNVERIFIED', '写盘后回读不一致：' + rel)
  return rel
}

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

async function updateIndex({ tavern, archiveRel, index, entry }) {
  index.entries = [...index.entries, entry]
  await writeIndex({ tavern, archiveRel, index })
}

async function bumpManifest({ tavern, archiveRel, add }) {
  const rel = archiveRel + '/manifest.json'
  let cur = null
  try { cur = JSON.parse((await tavern.read(rel)).content) } catch { return { updated: false, reason: 'manifest 不存在或读不到（跳过，不新建）' } }
  if (!cur || typeof cur !== 'object') return { updated: false, reason: 'manifest 形状不识（跳过）' }
  cur.summaries = cur.summaries && typeof cur.summaries === 'object' ? cur.summaries : {}
  cur.summaries.count = (Number(cur.summaries.count) || 0) + add
  cur.summaries.writer = 'dsh-memory-archive/summarize'
  const text = JSON.stringify(cur, null, 2) + '\n'
  await tavern.write(rel, text)
  return { updated: true }
}

// ─────────────────────────── 执行

/**
 * 逐区间总结并落库。**绝不因为某一个区间失败就整批停**（失败逐条留在返回值里）。
 * @param {{target, ranges:[{fromFloor,toFloor}], instruction, jailbreak, api, overwrite?}} input
 */
export async function applySummarize(input = {}, deps = {}) {
  const target = input.target
  const archiveRel = archiveRelOf(target)
  const tavern = deps.tavern || tavernForRequest(deps.req, deps)
  if (!tavern || typeof tavern.read !== 'function') throw fail('TAVERN_CONFIG', 'applySummarize 缺可用的 tavern 客户端')
  const ranges = Array.isArray(input.ranges) ? input.ranges : []
  if (ranges.length === 0) throw fail('SUMMARIZE_PLAN_REQUIRED', '缺 ranges：请把 /summarize/plan 的结果原样带回来（预览即合同）')
  const instruction = String(input.instruction ?? '')
  if (instruction.trim() === '') throw fail('SUMMARIZE_NO_INSTRUCTION', '缺指令（面板里的压缩指令模板就是它）')
  const now = typeof deps.now === 'function' ? deps.now() : Date.now()

  const index = await readIndex(tavern, archiveRel)
  const results = []
  let prevSummary = ''
  for (const r of ranges) {
    const from = Number(r.fromFloor)
    const to = Number(r.toFloor)
    if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) {
      results.push({ fromFloor: r.fromFloor, toFloor: r.toFloor, ok: false, error: 'SUMMARIZE_RANGE_INVALID', message: '区间不合法' })
      continue
    }
    try {
      const already = index.entries.find((e) => Number.isInteger(e.fromFloor) && Number.isInteger(e.toFloor)
        && e.fromFloor <= from && e.toFloor >= to && typeof e.id === 'string' && !String(e.id).startsWith('import-'))
      if (already && input.overwrite !== true) {
        results.push({ fromFloor: from, toFloor: to, ok: true, skipped: 'covered', id: already.id, message: '该区间已有内容摘要（要覆盖请带 overwrite:true）' })
        continue
      }
      // ★ 覆盖语义：先把**完全落在本区间内**的旧内容摘要从 index 里摘掉、文件清空。
      //   为什么不是删文件：tavern 客户端只有 `{list,read,write,mkdir}` **没有删除**接口 ⇒
      //   清空是能做到的最干净的处置（空文件不会被自动入库读进来，因为空文本会被跳过）。
      let removed = 0
      if (already && input.overwrite === true) {
        const stale = index.entries.filter((e) => e && typeof e.id === 'string' && !String(e.id).startsWith('import-')
          && Number.isInteger(e.fromFloor) && Number.isInteger(e.toFloor)
          && e.fromFloor >= from && e.toFloor <= to)
        for (const e of stale) {
          if (typeof e.file === 'string' && e.file !== '') {
            try { await tavern.write(archiveRel + '/summaries/' + e.file, '') } catch { /* 清空失败不致命 */ }
          }
          removed += 1
        }
        if (removed > 0) {
          index.entries = index.entries.filter((e) => !stale.includes(e))
          await writeIndex({ tavern, archiveRel, index })
        }
      }
      const floors = []
      for (let n = from; n <= to; n++) {
        try { floors.push(await readFloor(tavern, archiveRel, n)) } catch { /* 缺楼层就跳过（区间口径按 from/to 记） */ }
      }
      if (floors.length === 0) {
        results.push({ fromFloor: from, toFloor: to, ok: false, error: 'SUMMARIZE_NO_FLOORS', message: '这个区间里读不到楼层' })
        continue
      }
      const messages = buildSummaryMessages({ floors, instruction, jailbreak: input.jailbreak, previousSummary: prevSummary })
      const raw = await callSummaryModel({ api: input.api, messages, fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs })
      const parsed = parseSummaryOutput(raw)
      if (!parsed.ok || parsed.items.length === 0) {
        results.push({ fromFloor: from, toFloor: to, ok: false, error: 'SUMMARIZE_PARSE_EMPTY', message: '模型没给出可用正文' })
        continue
      }
      // ★ 一次总结产出多条时**每条各存一条切片**（anima 同款：批次 → 多条 slice，各自带 tags）。
      //   只有一条时 id 不带序号，好看也好认。
      const baseId = 's-' + pad4(from) + '-' + pad4(to)
      const multi = parsed.items.length > 1
      const written = []
      for (let k = 0; k < parsed.items.length; k += 1) {
        const item = parsed.items[k]
        const id = multi ? baseId + '-' + (k + 1) : baseId
        if (!SUMMARY_ID_RE.test(id)) throw fail('SUMMARIZE_ID_INVALID', '生成的 id 不合法：' + id)
        const rel = await writeSummaryFile({ tavern, archiveRel, id, text: item.text })
        const entry = {
          id, file: id + '.md', fromFloor: from, toFloor: to,
          part: multi ? k + 1 : null, itemCount: parsed.items.length,
          createdAt: new Date(now).toISOString(), model: String(input.api?.model ?? '') || null,
          chars: Buffer.byteLength(item.text, 'utf8'),
          tags: item.tags,
          sourceHash: null,
          writer: 'dsh-memory-archive/summarize',
          usedJson: parsed.usedJson,
        }
        await updateIndex({ tavern, archiveRel, index, entry })
        written.push({ id, file: rel, chars: entry.chars, tags: item.tags })
      }
      prevSummary = parsed.items.map((x) => x.text).join('\n\n')
      results.push({
        fromFloor: from, toFloor: to, ok: true,
        id: written[0].id, ids: written.map((x) => x.id), items: written.length,
        chars: written.reduce((a, b) => a + b.chars, 0),
        tags: [...new Set(written.flatMap((x) => x.tags))],
        usedJson: parsed.usedJson, floors: floors.length, removed,
      })
    } catch (e) {
      results.push({ fromFloor: from, toFloor: to, ok: false, error: String(e && e.code || 'SUMMARIZE_FAILED'), message: String(e && e.message || e) })
    }
  }
  const okCount = results.filter((x) => x.ok && x.skipped === undefined).length
  const failCount = results.filter((x) => !x.ok).length
  let manifest = { updated: false, reason: '没有新摘要' }
  if (okCount > 0) {
    try { manifest = await bumpManifest({ tavern, archiveRel, add: okCount }) } catch (e) {
      manifest = { updated: false, reason: String(e && e.message || e) }
    }
  }
  return { ok: failCount === 0, written: okCount, failed: failCount, results, manifest }
}

// ─────────────────────────── HTTP 壳

export async function handleSummarizePlan(ctx, url, req, send, deps = {}) {
  const body = await readJsonBody(req)
  const out = await planSummarize(body, { ...deps, req })
  return send(200, out)
}

export async function handleSummarizeApply(ctx, url, req, send, deps = {}) {
  const body = await readJsonBody(req)
  // 指令/破限/渠道**默认由服务端注入**（面板只要带 ranges 就行）；
  // 请求体里显式给了就用请求体的（便于测试与 CLI 直接驱动）。
  const merged = {
    ...body,
    instruction: typeof body.instruction === 'string' && body.instruction.trim() !== ''
      ? body.instruction : String(deps.instruction ?? ''),
    jailbreak: typeof body.jailbreak === 'string' ? body.jailbreak : String(deps.jailbreak ?? ''),
    api: body.api && typeof body.api === 'object' ? body.api : deps.api,
  }
  const out = await applySummarize(merged, { ...deps, req })
  return send(out.ok ? 200 : 207, out)
}

// ─────────────────────────── 清空总结（补救：预设没调好就重来）

/**
 * 清空「内容摘要」——**保留原文楼层**与**导入批次清单**：
 *   ① 把每条内容摘要的正文**备份**到 `archive/_backup-summaries-<时间戳>/`（走 PUT 写文件，
 *      摘要都是几 KB，远低于 Tavern 的 1 MiB/文件 上限）；
 *   ② 把原来那些 `.md` **清空**（Tavern 工作区面**只有 GET/PUT、没有 DELETE** ⇒ 清空是能做到的
 *      最干净处置；空文件不会被自动入库读进来，因为空文本会被跳过）；
 *   ③ 重写 `summaries/index.json`：**只留 `import-*`** 条目 ⇒ 之后「扫归档 → 总结」就是全新一遍。
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
  // index 只留 import-*（⭐ 这是"归档里还有没有总结"的唯一判据 ⇒ 重跑 plan 会重新列出全部区间）
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
