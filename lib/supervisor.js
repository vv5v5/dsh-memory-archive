// lib/supervisor.js —— 记忆主管的**纯逻辑层**（2026-09-29）。
//
// 分工（⛔ 别处不抄这些判据）：
//   · 收 + 排期（旁路 LLM）在压缩后端模块（lib/mt-compaction.js 生成物）——它有 ctx.llm；
//     产出两份文件：`briefing.md`（写作者-facing 注入物）+ `supervisor-ops.json`（底账操作单）。
//   · 用（每轮注入）+ 操作单落盘在本插件（本文件 + lib/index.js 的 registerSupervisor）——
//     注入零 LLM（读简报拼尾部消息），ops 走 memory-write 的纯函数（备份/死区/防猜全继承）。
//   · 本文件只放**纯函数与常量**：配置读取、兜底简报拼装、操作单校验、注入日志。⛔ 不碰文件系统
//     （文件读写都在 lib/index.js 的接线层，台子好测）。
//
// 底账契约（主管独占维护；写作者零接触）：
//   notes.md     近 3 场场记（超限挪 world）      ⛔ 固定设定/伏笔
//   index.md     当前状态 + 导演笔记（作者天轴）   ⛔ 角色固定像
//   world.md     世界设定 + 未解伏笔（排期池）
//   characters.md 只收**固定内容**的**增量**（世界书已覆盖的义体/香氛/外貌/XP ⛔ 不收——核对判据）；
//                未揭露的真相先入 world 未解伏笔，揭露后才转正。

export const SUPERVISOR_FILES = ['notes.md', 'index.md', 'world.md', 'characters.md']
export const SUPERVISOR_MODES = ['append', 'replace']
export const SUPERVISOR_BRIEFING_FILE = 'briefing.md'
export const SUPERVISOR_OPS_FILE = 'supervisor-ops.json'

/** 配置读取（缺省全兜住；⛔ 不抛）。enabled 默认开。dryRun 已按用户口径移除（2026-09-29：操作单直接真写）。 */
export function readSupervisorConfig(configJson) {
  const s = configJson && typeof configJson === 'object' ? configJson.supervisor : null
  const s2 = s && typeof s === 'object' ? s : {}
  const intOr = (v, d, lo, hi) => {
    const n = Math.trunc(Number(v))
    return Number.isFinite(n) && n >= lo && n <= hi ? n : d
  }
  return {
    enabled: s2.enabled !== false,
    everyNFloors: intOr(s2.everyNFloors, 1, 1, 20),
    briefingMaxChars: intOr(s2.briefingMaxChars, 1800, 600, 4000),
    model: typeof s2.model === 'string' ? s2.model.trim() : '',
  }
}

/**
 * 主管 system 提示词的**展示副本**（面板「提示词」卡在运行捕获缺失时也有的看）。
 * 运行期唯一真相在压缩后端模块（readSupervisorSystemPrompt）；两份一致性由
 * _selftest-supervisor.mjs ⑥ 从生成器源码逐行钉住（⛔ 改一处必须改两处）。
 */
export const SUPERVISOR_SYSTEM_TEMPLATE = [
  '你是 RP 记忆主管，不在演戏。每楼后会收到一份材料（user 消息）：线程首轮/对账轮是 [维护任务]（上一楼正文＋四份底账全文），平时是 [维护增量]（上一楼正文＋底账读数——历史在线程里，你已经知道）。',
  '职责两件事：把上一楼收纳进底账，并为下一楼排好「该用什么」。',
  '你只输出一个 JSON 对象：{"briefing":"…","ops":[{"file":"notes.md|index.md|world.md|characters.md","mode":"append|replace","find":"…","text":"…"}]}',
  '没有可记的 ⇒ ops 给 []，但 briefing 仍要给（下一楼的简报）。⛔ JSON 之外一个字都不许有。',
  '简报铁律——只写材料里已确立的事实：⛔ 编造没发生过的事、⛔ 替玩家角色添设定、⛔ 替剧情做新决定；玩家角色的形象只以玩家亲口所说为准。',
  'briefing（≤{maxChars} 字，写给写作者看；上限不是目标，写紧凑）：①当前时间地点——时间用「年 · 月日 · 时段 时:分」格式、从上一楼正文的时间头顺推，地点与状态张力各一句 ②在场角色要点（只挑固定特质）③本段应念的伏笔（从 world.md 未解伏笔里挑，标明为何是现在）④导演笔记要点（含到期导演指令）⑤近 3 场一行记。',
  '收纳纪律：notes.md 只留最近 3 场场记、上限 2500 字，超了把最早的场记整段挪进 world.md「未解伏笔」、原位只留一行标记；',
  'index.md 只动〔AI 自记〕段（当前时间地点随剧情更新；导演笔记只收纳整理，⛔ 不删改作者原意）；',
  '导演指令＝用户当场下达的最高优先级即时指令（OOC、【导演】、剧情走向与设定补正等）：原话逐条收进 index.md 导演笔记的「导演指令」小节，记下达楼号；',
  '每楼自主判断各条到期没有：到期该执行的 ⇒ 写进简报「导演笔记要点」最前；未到期 ⇒ 段内留档待命；已兑现、被用户撤销或被新指令取代 ⇒ 标记了结、不再进简报；⛔ 不替用户撤销、不改原话原意。',
  'world.md 收世界设定与未解伏笔；characters.md 只收**增量**固定特质（未揭露的真相先进 world.md 未解伏笔，剧情揭露后才转正），单场情绪/临时状态一律不进 characters。',
  '「死区」＝底账里没有〔AI 自记〕标记的段落（作者预置）。作者预置段（无〔AI 自记〕标记/死区）一个字节不许动；',
  '段名合同（宿主的兜底简报按段名取数，⛔ 不另起名）：index.md 自记区固定有「当前时间地点」与「导演笔记」两段；world.md 用「未解伏笔」；notes.md 每场一个「## 第N场 · 标题」。',
  'index.md 布局：自记段放全文末尾、最后一段是「导演笔记」——写作者的随记（append）会堆到文件末尾＝堆进这段；收纳＝用段替换把随记折进导演笔记（整段重写、含折入内容），不让随记散落段外。',
  '新周目首楼（底账全空或缺文件）属正常，append 即建档：index.md 依次写「〔AI 自记〕」标记行＋「## 当前时间地点」＋一行状态（时间取上一楼正文的时间头，即开场白首行那个锚），再写「〔AI 自记〕」＋「## 导演笔记」；notes.md 记第一场场记；world.md／characters.md 有可收内容才建。',
  'replace 两种指法：①逐字——find＝现文里只出现一次的一小段原文（出现两次即拒）；②段模式——find 第一行整行就是〔AI 自记〕、其后可跟该段标题行消歧 ⇒ 换掉那一整段（text＝整段新内容，含标记行与标题行）。',
  '输出要经济：超预算被截断＝整楼作废。ops 一般不超过 6 条，一轮收不完先收最重要的（下一楼材料还会来）；拿不准就用 append——宁可漏，不可错。',
].join('\n')

/** 取某节的内容：`## 标题` 起到下一个 `## ` 或文末（不含下一题）。找不到 ⇒ ''。 */
function sliceSection(text, heading) {
  if (typeof text !== 'string' || text === '') return ''
  const lines = text.split('\n')
  const at = lines.findIndex((l) => l.trim().startsWith('##') && l.includes(heading))
  if (at < 0) return ''
  const out = []
  for (let n = at + 1; n < lines.length; n += 1) {
    if (/^#{1,6}\s/.test(lines[n].trim())) break
    out.push(lines[n])
  }
  return out.join('\n').trim()
}

/** 非空行取前 n 条。 */
const firstLines = (text, n) => String(text ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '').slice(0, n)

/** 节内取行：从 lines[start] 起收非空行，撞到下一个标题就停（⛔ 不越节 —— 真机烟测抓过吃进下一节）。 */
function sectionBodyLines(lines, start, count) {
  const out = []
  for (let n = start; n < lines.length && out.length < count; n += 1) {
    const t = lines[n].trim()
    if (t === '') continue
    if (/^#{1,6}\s/.test(t)) break
    out.push(t)
  }
  return out
}

/**
 * 规则兜底简报（主管 LLM 没跑过 / briefing.md 缺失时的即时注入物）。
 * `focusText` 用于挑「在场角色」：characters.md 里段名被它提到的才进（取段首 2 行）。
 * 总长超 maxChars ⇒ 硬截加 …（⛔ 不抛；文件缺失传 null 就行）。
 */
export function buildFallbackBriefing({ index, notes, world, characters, focusText, maxChars = 1800 }) {
  const parts = []
  // 段名合同：「当前时间地点」为主；旧周目（剥离前建档）用「最近进展」段名 ⇒ 兜住，别让兜底简报失明
  const status = sliceSection(index, '当前时间地点') || sliceSection(index, '最近进展')
  if (status !== '') parts.push('■ 当前状态\n' + firstLines(status, 3).join('\n'))
  const director = sliceSection(index, '导演')
  if (director !== '') {
    const tail = director.length > 120 ? '…' + director.slice(-120) : director
    parts.push('■ 导演笔记（尾）\n' + tail)
  }
  if (typeof notes === 'string' && notes !== '') {
    const lines = notes.split('\n')
    const scenes = []
    for (let n = 0; n < lines.length; n += 1) {
      if (!lines[n].trim().startsWith('##')) continue
      const body = sectionBodyLines(lines, n + 1, 1)[0] ?? ''
      scenes.push(lines[n].trim() + (body === '' ? '' : ' — ' + body.slice(0, 60)))
    }
    // 场记按 append 序（旧→新）排 ⇒ 新→旧 = 取**末 3 条**再倒序（⛔ 先截后倒会把最新的剪掉——台子抓过）
    const recent = scenes.slice(-3).reverse()
    if (recent.length > 0) parts.push('■ 近场记（新→旧）\n' + recent.join('\n'))
  }
  const foreshadow = sliceSection(world, '未解伏笔')
  if (foreshadow !== '') parts.push('■ 未解伏笔（头几条）\n' + firstLines(foreshadow, 5).join('\n'))
  if (typeof characters === 'string' && characters !== '' && typeof focusText === 'string' && focusText !== '') {
    const lines = characters.split('\n')
    const picks = []
    for (let n = 0; n < lines.length; n += 1) {
      if (!lines[n].trim().startsWith('##')) continue
      const name = lines[n].trim().replace(/^#+\s*/, '')
      if (name === '' || !focusText.includes(name)) continue
      const body = sectionBodyLines(lines, n + 1, 2).join('；')
      picks.push(name + '：' + body.slice(0, 100))
      if (picks.length >= 4) break
    }
    if (picks.length > 0) parts.push('■ 在场角色要点\n' + picks.join('\n'))
  }
  let body = parts.join('\n\n')
  if (body.length > maxChars) body = body.slice(0, maxChars) + '…'
  return body === '' ? '' : `[剧情简报 · 兜底拼装（主管未精排）]\n${body}\n[/剧情简报]`
}

/** 主管 LLM 产出的操作单校验：形状/文件白名单/mode 白名单/find 必带。⇒ {ok, ops|error}。 */
export function parseOpsJson(raw) {
  let parsed
  try { parsed = JSON.parse(String(raw)) } catch (e) { return { ok: false, error: `JSON 解析失败：${String(e?.message ?? e).slice(0, 120)}` } }
  const ops = parsed?.ops
  if (!Array.isArray(ops)) return { ok: false, error: '形状不对：缺 ops 数组' }
  const clean = []
  for (let n = 0; n < ops.length; n += 1) {
    const op = ops[n]
    const err = validateOp(op)
    if (err !== null) return { ok: false, error: `ops[${n}] ${err}` }
    clean.push({ file: String(op.file), mode: String(op.mode), find: op.find, text: op.text })
  }
  return { ok: true, ops: clean }
}

function validateOp(op) {
  if (!op || typeof op !== 'object') return '不是对象'
  if (!SUPERVISOR_FILES.includes(op.file)) return `file 不在白名单（${SUPERVISOR_FILES.join('/')}）`
  if (!SUPERVISOR_MODES.includes(op.mode)) return 'mode 只许 append/replace'
  if (op.mode === 'append') {
    if (typeof op.text !== 'string' || op.text.trim() === '') return 'append 要有非空 text'
    return null
  }
  if (typeof op.find !== 'string' || op.find.trim() === '') return 'replace 要带 find'
  if (typeof op.text !== 'string') return 'replace 的 text 要是字符串（空串 = 整段删）'
  return null
}

/** 尾注消息文本（简报 → 写作者看到的那条 user 消息）。 */
export function briefMessageText(briefing, { source = 'llm' } = {}) {
  const tag = source === 'llm' ? '主管精排' : '兜底拼装'
  return `[剧情简报 —— ${tag}：当前状态/在场角色/应念伏笔/导演要点。写戏以此为准，⛔ 不通读底账（按需定点检索除外）]\n\n${briefing}\n[/剧情简报]`
}

/**
 * 注入记录：`last` 存**全文**（面板「最近一轮注入」卡的主 content），`list` 只存摘要（历史行）。
 * 纯对象操作：prevFile = 注入文件的反序列化（{last, list} 或旧版数组/缺失都兜住）。
 */
export function recordInjection(prevFile, entry, cap = 30) {
  const prevList = Array.isArray(prevFile?.list) ? prevFile.list : (Array.isArray(prevFile) ? prevFile : [])
  const list = [{ at: entry.at, sessionId: entry.sessionId, source: entry.source, chars: entry.chars, excerpt: entry.excerpt }, ...prevList].slice(0, cap)
  return { last: { ...entry }, list }
}

// ───────────── 主管线程（2026-09-30，用户拍板「会话式思维链保留」）─────────────
// 主管从「每楼独立调用」升级为「一条持续生长的对话线程」：assistant 的回复（含 thinking）
// 留在线程里，下一楼只发增量（上一楼正文 + 底账读数）——provider 前缀缓存命中历史，
// 且主管对「张力曲线/伏笔节奏/自己上次的判断」有连续记忆。纯函数：线程的组装/修剪/校验。

export const SUPERVISOR_THREAD_FILE = 'supervisor-thread.json'
/** 线程携带上限（字符）：超过 ⇒ 硬重置（全量重建）。 */
export const THREAD_MAX_CHARS = 40000
/** 保底保留的最近轮数。 */
export const THREAD_KEEP_TURNS = 6

/** 底账读数行（增量 user 消息里给主管的「现状一眼」）。纯函数。 */
export function ledgerDigest({ index, notes, world, characters }) {
  const row = (name, text) => {
    const s = String(text ?? '')
    if (s === '') return `- ${name}:（空）`
    let last = ''
    for (const line of s.split('\n')) { const t = line.trim(); if (/^#{1,6}\s/.test(t)) last = t }
    return `- ${name}: ${s.length} 字${last ? ' · 末标题 ' + last : ''}`
  }
  return ['[底账读数]', row('index.md', index), row('notes.md', notes), row('world.md', world), row('characters.md', characters), '[/底账读数]'].join('\n')
}

/**
 * 追加一轮到线程：user 增量 + assistant 回复（thinking + JSON）。
 * 纯函数：返回新线程对象 { turns: [{seq, user, assistant:{thinking, json}}], fullSince: seq|null }。
 */
export function threadAppend(prev, { seq, user, thinking, json }) {
  const turns = Array.isArray(prev?.turns) ? prev.turns : []
  const next = { turns: [...turns, { seq, user, assistant: { thinking: String(thinking ?? ''), json: String(json ?? '') } }] }
  return threadTrim(next)
}

/**
 * 线程修剪：只留最近 KEEP_TURNS 轮 + 硬上限重置（返回 null ⇒ 调用方全量重建）。
 * 被剪轮次不保留（它们的结论已折进底账与简报——线程只是短期工作记忆）。
 */
export function threadTrim(thread, { keep = THREAD_KEEP_TURNS, maxChars = THREAD_MAX_CHARS } = {}) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : []
  if (turns.length === 0) return { turns: [] }
  const size = turns.reduce((a, t) => a + (t.user?.length ?? 0) + (t.assistant?.json?.length ?? 0) + (t.assistant?.thinking?.length ?? 0), 0)
  if (size > maxChars) return null
  return { turns: turns.slice(-keep) }
}

/** 线程 → llm.stream 的 messages（system 由调用方给）。⛔ 只回线程承载的历史。 */
export function threadMessages(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : []
  const messages = []
  for (const t of turns) {
    messages.push({ role: 'user', content: [{ type: 'text', text: String(t.user ?? '') }] })
    const a = t.assistant ?? {}
    const blocks = []
    if (a.thinking) blocks.push({ type: 'reasoning', text: String(a.thinking) })
    blocks.push({ type: 'text', text: String(a.json ?? '') })
    messages.push({ role: 'assistant', content: blocks })
  }
  return messages
}

/** 线程文件读取的形状校验（坏/空 ⇒ null，调用方重建）。 */
export function threadFromJson(raw) {
  try {
    const j = JSON.parse(String(raw))
    if (!j || !Array.isArray(j.turns)) return null
    return { turns: j.turns.filter((t) => t && typeof t === 'object' && typeof t.user === 'string' && t.assistant && typeof t.assistant.json === 'string') }
  } catch { return null }
}

// ───────────── 首轮政策（2026-09-30，用户拍板）：积压清偿不走 LLM ─────────────
// notes.md 超保养线 2 倍（积压态）时，LLM ops 再怎么分批也装不下「搬 14k 字」——
// ⇒ **代码级机械分档**：按标题块切，保留最近 keep 个块，更早的整块进档案文件
// `notes-archive.md`。零 LLM 输出、可备份可回滚；主管之后面对的就是小 notes。
export const NOTES_ARCHIVE_FILE = 'notes-archive.md'

/**
 * 机械分档（纯函数）：把 notes 按标题切块，保留最近 keep 块（含尾随非标题内容），
 * 更早的块作为归档文本返回。块数 ≤ keep 或无内容 ⇒ null（不需要分档）。
 */
export function splitOverloadNotes(notesText, { keep = 3 } = {}) {
  const s = String(notesText ?? '')
  if (s === '') return null
  const lines = s.split('\n')
  const heads = []
  for (let i = 0; i < lines.length; i += 1) if (/^#{1,6}\s/.test(lines[i].trim())) heads.push(i)
  if (heads.length <= keep) return null
  const cut = heads[heads.length - keep]
  const archived = lines.slice(0, cut).join('\n').trim()
  const kept = lines.slice(cut).join('\n').replace(/^\n+/, '')
  if (archived === '' || kept === '') return null
  return { kept, archived }
}

/** 归档块文本（进 notes-archive.md 的样子，带分隔头）。纯函数。 */
export function archiveBlock(archived, stamp) {
  return '\n\n<!-- ── 记忆主管首轮政策归档 ' + stamp + ' ── -->\n\n' + String(archived ?? '').trim() + '\n'
}
