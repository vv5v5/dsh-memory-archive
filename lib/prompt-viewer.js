/**
 * dsh-prompt-viewer —— 宿主半侧的并入版
 *
 * 本文件是 `dsh-prompt-viewer` 宿主半侧的并入版（原插件整体并入 dsh-memory-archive，
 * 单包自包含，对 dsh-prompt-viewer 零依赖），路由挂在 `/dsh-memory-archive/prompt` 之下，
 * 由本包 lib/index.js 统一注册；本文件不再自带 name/inject/apply，
 * 只导出 createHandler / createSessionSource / resolveConfig。
 *
 * 把 `<home>/.dsh/sessions/<projectKey>/<sessionId>/session.jsonl.zstd` 解析成 JSON，
 * 供客户端半侧同源 fetch：
 *
 *   GET /health               → { ok:true, sessions:<n> }
 *   GET /api/sessions[?refresh=1]
 *                             → { ok:true, archive:{ known, archivedCount },
 *                                 sessions:[{ id, workspace, sizeBytes, mtime, title, requests, archived }] }
 *                               只扫目录、不解析任何会话：title=''、requests=-1 是
 *                               「尚未解析」哨兵（0 是「解析过、确实没有请求」的真值）。
 *                               archived（字段名冻结）：true|false|null，null = 归档状态未知
 *                               （注册表读不到 ≠ 没归档，⛔ 不许用 false 冒充）。归档位来自
 *                               archivedProvider（工作区注册表 global.archivedSessionIds 的只读投影），
 *                               每次请求现取现合并，⛔ 不进 scanIndex() 的 30 秒缓存 —— 归档是实时的。
 *   GET /api/sessions/resolve?ids=<id,id,…>（一次 ≤10 个）
 *                             → { ok:true, sessions:[同形行，已解析] }；前端空闲时
 *                               分批调用补标题，随时可中断（刷新/卸载即弃）。
 *   GET /api/session?id=<sid> → { ok:true, title, meta:{ cwd, agentPreset, effectivePreset }, requests:[摘要] }
 *   GET /api/turns?id=<sid>   → { ok:true, sessionId, latest, turns:[{ turn, startedAt, endedAt,
 *                                 messageCount, seqRange, requestLogged, headerCarried,
 *                                 systemChars, toolCount }] }
 *                             轮次锚点 = turn/start / turn/end（⛔ 不是 request/header 条数 ——
 *                             header 是「变了才记」，静态会话 3 楼也只 1 条）；requestLogged:false
 *                             的楼按 carry-forward 取之前最近一条 header 并标 headerCarried:true。
 *   GET /api/messages?id=<sid>&from=&limit=
 *                             → { ok:true, total, latestIndex, messages:[{ index, seq, turn,
 *                                 role, preview, chars, isToolResult, isCompacted }] }
 *                             默认返回最后 N 条；preview 只放首行截断。
 *   GET /api/part?id=<sid>&turn=<N>&part=system|messages
 *                             → { ok:true, part, text }        （text 超 40 万字符截断；
 *                               messages 按轮次：该楼 turn/end 之前的活着消息行，非会话级全文）
 *   GET /api/part?…&part=tools|inventory
 *                             → { ok:true, part, tools:[{ name, chars }] }
 *
 * 数据层照抄 CLI 版 _prompt-viewer.mjs：**不自解 zstd**，用 createRequire 从
 * DSH 运行时拿它自己的持久化模块（cordis + dsh-session + session-persistence-jsonl）。
 * 列表接口只扫目录不解析（68 个真实会话逐个解析实测 10.5 秒，扫目录 <10ms）；
 * 解析成本只花在被选中的会话（/api/session）与空闲批量补齐（/api/sessions/resolve）上。
 * 列表/详情响应只携带摘要 —— 一段 system 实测 18000+ 字符，带全文会把页面拖死；
 * 全文只在 /api/part 按轮次取。
 *
 * 路由纪律：HTTP 一律 200，错误放 body 的 {ok:false,error}；每个响应都带
 * no-store / json;charset=utf-8 / content-length；解析失败绝不抛出到响应之外。
 * 同一会话的解析结果按 (路径+mtime+size) 缓存，容量「条数 + 字节」双限额
 * （LRU，默认 3 条 / 96 MB；单会话超字节上限 ⇒ 不缓存，见 ./mem-budget.js）；
 * fs 扫描索引缓存 ≤30 秒。
 *
 * 零外部依赖：只用 node: 内置模块 + 上述 createRequire。
 *
 * @license CC-BY-NC-4.0 (Attribution-NonCommercial 4.0 International)
 * 移植来源：anima-rag (https://github.com/Ellinav/anima-rag) — 作者 Ellinav
 * 仅限个人学习与非商业用途；禁止闭源商用或转为付费插件/服务；不重新分发预置私域数据。
 * 含 DeepSeek Harness 派生部分（MIT, Copyright (c) 2026 DeepSeek）时该部分保留 MIT。
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createByteBudgetedCache, estimateBytes } from './mem-budget.js'

/** system 段里固定检出的注入标记（与任务书给定的清单逐字一致）。 */
const MARKS = ['【当前状态】', 'recalledMemories', 'immediateHistory', 'storyAnchor', 'rp:policy', 'pmp-dsh-tavern', 'harness:identity']

/** /api/part 的 text 截断上限（字符）。 */
const MAX_TEXT_CHARS = 400000

/** 会话列表扫描缓存与 fs 索引的存活时间。 */
const SCAN_TTL_MS = 30000

/** /api/sessions/resolve 单次调用最多解析多少个会话（分批节奏由客户端控制）。 */
const RESOLVE_BATCH_LIMIT = 10

/**
 * 常驻投影的**版本号**（20260915）：投影口径一变（例如 `title` 从"第一条消息 60 字"改成**真标题**）
 * 就 +1 ⇒ 盘上旧投影被当成 stale **自动重热**，不用让用户手工删 `resident.json`。
 * 2 = title 改为日志里最后一条 `session/title` 的 data.title；preview 独立成字段。
 * 3 = 读取改走**宿主自己的**持久化（`readLog` 注入）—— 旧私有栈读的是 0.1.2 那份、
 *     只认 `session.jsonl.zstd` ⇒ 盘上按旧口径热出来的 requests/标题全是**迁移前的冻结值**，
 *     必须整批重热，否则重启后仍旧显示旧数字。
 */
const PROJECTION_VERSION = 3

/** /api/messages 的 preview 截断上限（首行再截断，字符）。 */
const PREVIEW_MAX_CHARS = 120

/** /api/messages 默认返回最后多少条（配合"自动定位最新楼"），以及单次上限。 */
const DEFAULT_MESSAGES_LIMIT = 200
const MAX_MESSAGES_LIMIT = 1000

/** 部署可变项；都可从 cordis.patch.yml 的 config 覆盖。 */
const DEFAULTS = {
  /** 会话根目录。 */
  sessionsRoot: '',
  /** DSH 运行时模块目录（createRequire 的解析起点）。 */
  runtimeDsh: '',
  /** 宿主 webServer 上的挂载前缀。 */
  webPath: '/dsh-memory-archive/prompt',
  /** 列表最多收录多少个会话（按 mtime 倒序取前 N）。 */
  maxSessions: 100,
  /** 解析结果 LRU 容量（按会话文件的 路径+mtime+size 缓存）。
   *  P0 内存修复：8 → 3。实测单会话解析后驻留 ~130–190 MB，8 条最坏 ≈1.4 GB。 */
  parseCacheSize: 3,
  /** 解析缓存总字节上限（默认 96 MB）。单条解析结果就超限 ⇒ 不缓存、每次重新解析
   *  （实测 6.8 MB 压缩会话 ≈186 MB > 96 MB ⇒ 大会话永不驻留，内存有硬上界）。 */
  parseCacheMaxBytes: 96 * 1024 * 1024,
  /**
   * 插件存储根（20260915 查看器提速）：由 `lib/index.js` 传入（= 它自己的 `storageDir()`）。
   * 留空 ⇒ 回落 `<DSH_HOME>/dsh-memory-archive`。
   */
  storageDir: '',
  /**
   * 常驻集文件：用户自己选的「常住会话」清单 + 它们的**轻投影**缓存（title/requests/耗时…）。
   * 路径 = `<storageDir>/resident.json`。★ 打开面板只读它，**绝不解析**。
   */
  residentFile: '',
  /** 后台刷新间隔（ms）：重扫 fs 索引，常驻会话的 mtime/size 变了才排队**串行**预热。0 = 关。 */
  residentRefreshMs: 60000,
  /** 常驻集上限（条）。预热是串行的，上限只影响「一轮刷新最长多久」。 */
  residentMax: 20,
}

/** 照抄 lib/index.js 的官方约定（含 ~ 展开）。 */
function expandHome(p, home = homedir()) {
  if (p === '~') return home
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2))
  return p
}

/** DSH_HOME 未设/为空时回落 ~/.dsh（与 lib/index.js 的 storageDir 同一套约定）。 */
function dshHomeDir(env = process.env) {
  const configured = env.DSH_HOME
  return configured !== undefined && String(configured).trim() !== ''
    ? resolve(expandHome(String(configured)))
    : join(homedir(), '.dsh')
}

/**
 * 归一化插件配置（幂等：对已归一化的配置再跑一遍结果不变）。
 * @param {Record<string, unknown>|undefined} raw - cordis 传入的 config（可为空）。
 * @returns {typeof DEFAULTS} 补齐默认值后的配置。
 */
export function resolveConfig(raw) {
  const provided = raw && typeof raw === 'object' ? raw : {}
  const cfg = { ...DEFAULTS, ...provided }
  if (!cfg.sessionsRoot) cfg.sessionsRoot = join(dshHomeDir(), 'sessions')
  if (!cfg.runtimeDsh) cfg.runtimeDsh = join(dshHomeDir(), 'runtime', 'node_modules', '@deepseek-ai', 'dsh')
  cfg.webPath = String(cfg.webPath || DEFAULTS.webPath)
  cfg.maxSessions = Math.max(1, Number(cfg.maxSessions) || DEFAULTS.maxSessions)
  cfg.parseCacheSize = Math.max(1, Number(cfg.parseCacheSize) || DEFAULTS.parseCacheSize)
  cfg.parseCacheMaxBytes = Math.max(1, Number(cfg.parseCacheMaxBytes) || DEFAULTS.parseCacheMaxBytes)
  cfg.residentMax = Math.max(1, Number(cfg.residentMax) || DEFAULTS.residentMax)
  cfg.residentRefreshMs = Number.isFinite(Number(cfg.residentRefreshMs))
    ? Math.max(0, Number(cfg.residentRefreshMs))
    : DEFAULTS.residentRefreshMs
  if (!cfg.residentFile) {
    const root = cfg.storageDir
      ? resolve(expandHome(String(cfg.storageDir)))
      : join(dshHomeDir(), 'dsh-memory-archive')
    cfg.residentFile = join(root, 'resident.json')
  }
  return cfg
}

/** 消息 blocks → 纯文本；非数组按字符串兜底，未知 block 类型显示为 [type]。 */
function blocksText(blocks) {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map((b) => (b && typeof b.text === 'string' ? b.text : `[${b?.type ?? '?'}]`))
    .join('')
}

/**
 * 把一条 request/header 事件折成「摘要 + 可按需取的全文」。
 * 列表/详情响应只携带 head；full 部分留在解析缓存里，等 /api/part 来取。
 * @param {{seq?:number, data?:any}} ev - request/header 事件
 * @param {number} index - 1 起算的请求序号
 */
function summarizeHeader(ev, index, systemFallback = null) {
  const d = ev?.data ?? {}
  const hd = d.header ?? {}
  const cfgIn = hd.config ?? {}
  const headerSystem = typeof hd.system === 'string' ? hd.system : ''
  // ★ v3（20260915 真机）：`request/header` 里**不再有 system**（只留 config/adapterDefaults/tools），
  //   system 正文搬到独立的 `system/message` 事件。旧读法在这版宿主上**永远是空串** ——
  //   用户看到的就是「字段抓到了、就是不给看上下文」。这里用调用方解析好的同楼 system 正文兜底。
  const fromFallback = headerSystem === '' && systemFallback !== null
  const system = fromFallback ? systemFallback.text : headerSystem
  const toolsRaw = Array.isArray(hd.tools) ? hd.tools : []
  const tools = toolsRaw
    .map((t) => ({ name: String(t?.name ?? t?.function?.name ?? '?'), chars: JSON.stringify(t ?? {}).length }))
    .sort((a, b) => b.chars - a.chars)
  // ★ M10：清单只留 {name, chars}（省内存），但**点开某个工具**要看那一条的实际文本 —— 所以原文也留着，
  //   只不过**给一个上限**：超上限就如实记 null（+ 原因），⛔ 不许悄悄截断成半份 JSON 让用户以为那就是全部。
  const rawLen = toolsRaw.length === 0 ? 0 : JSON.stringify(toolsRaw).length
  const rawTools = rawLen <= RAW_TOOLS_MAX_CHARS ? toolsRaw : null
  const head = {
    index,
    seq: typeof ev?.seq === 'number' ? ev.seq : null,
    reason: String(d.reason ?? ''),
    provider: String(cfgIn?.provider ?? ''),
    model: String(cfgIn?.model ?? ''),
    reasoningEffort: cfgIn?.reasoningEffort == null ? '' : String(cfgIn.reasoningEffort),
    maxTokens: typeof cfgIn?.maxTokens === 'number' ? cfgIn.maxTokens : null,
    systemChars: system.length,
    // 这段 system 是从哪来的（如实标注，⛔ 不许让 UI 把"猜的/上一楼的"当成"这一楼发的"）：
    //   'header'            = 老式路径（header 自带 system）
    //   'system/message'    = v3 路径，同楼 system/message 事件拼起来的
    //   'system/message(prev-turn)' = 同楼没有 ⇒ 退回该 header 之前最近的那条（跨楼回退，来源不同要能区分）
    //   null                = 两处都没有 ⇒ 未知（配合 systemParts:0）
    systemSource: fromFallback ? systemFallback.source : (headerSystem === '' ? null : 'header'),
    systemParts: fromFallback ? systemFallback.parts : (headerSystem === '' ? 0 : 1),
    toolCount: toolsRaw.length,
    toolChars: tools.reduce((n, t) => n + t.chars, 0),
    marks: MARKS.filter((m) => system.includes(m)),
    topTools: tools.slice(0, 8),
  }
  return { head, system, tools, rawTools, rawToolsChars: rawLen }
}

/** 一条 `system/message` 事件的纯文本（content blocks → text）；不是那形状 ⇒ ''。 */
function systemMessageText(ev) {
  const content = ev?.data?.message?.content
  if (!Array.isArray(content)) return ''
  return content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
}

/**
 * 把日志里的 `system/message` 按**楼号**归堆（v3 起 system 正文就在这里）。
 * @param {any[]} events - 会话事件
 * @returns {Map<number|null, Array<{seq:number|null,text:string}>>}
 */
function indexSystemMessages(events) {
  const byTurn = new Map()
  for (const ev of events) {
    if (ev?.type !== 'system/message') continue
    const text = systemMessageText(ev)
    if (text === '') continue
    const turn = typeof ev?.data?.turn === 'number' ? ev.data.turn : null
    if (!byTurn.has(turn)) byTurn.set(turn, [])
    byTurn.get(turn).push({ seq: typeof ev?.seq === 'number' ? ev.seq : null, text })
  }
  return byTurn
}

/**
 * 某条 `request/header` 该配哪一段 system 正文。★ 与 `sections-capture.js` 的
 * `systemCandidatesForTurn` **同一条轴**（先按 `data.turn` 归楼，再只取该 header 之前的），
 * 两处口径不一致会让「提示词」和「分区正文」对不上，改一处必须改另一处。
 *
 * ⛔ 不猜：本楼一条都没有时，只回退到该 header 之前**最近的一条**，并把 source 标成
 * `'system/message(prev-turn)'` —— 让调用方与 UI 知道它**不是这一楼发的**。
 * @param {number|null} seq - header 的 seq
 * @param {number|null} turn - 该 header 所在楼号（楼没开 ⇒ null）
 * @param {Map<number|null, Array<{seq:number|null,text:string}>>} byTurn - indexSystemMessages 的产物
 * @returns {{text:string, parts:number, source:string}|null} 两处都没有 ⇒ null（未知）
 */
function systemFallbackForHeader(seq, turn, byTurn) {
  const before = (list) => (seq === null ? list : list.filter((x) => x.seq === null || x.seq < seq))
  const sameTurn = turn === null ? null : (byTurn.get(turn) ?? null)
  if (sameTurn !== null) {
    const picked = before(sameTurn)
    if (picked.length > 0) {
      return { text: picked.map((x) => x.text).join('\n\n'), parts: picked.length, source: 'system/message' }
    }
  }
  let nearest = null
  for (const list of byTurn.values()) {
    for (const x of before(list)) {
      if (x.seq === null) continue
      if (nearest === null || x.seq > nearest.seq) nearest = x
    }
  }
  return nearest === null ? null : { text: nearest.text, parts: 1, source: 'system/message(prev-turn)' }
}

/** 单楼 header 里**工具定义原文**的保留上限（超过就如实记 null + 原因，⛔ 不截断冒充全份）。 */
const RAW_TOOLS_MAX_CHARS = 200000

/** 事件时间（epoch ms）→ ISO 字符串；缺失/非法给 null（不猜）。 */
function isoTime(time) {
  return typeof time === 'number' && Number.isFinite(time) ? new Date(time).toISOString() : null
}

/** preview：首行截断（⛔ 不把全文塞进列表响应）。 */
function previewOf(text) {
  const firstLine = String(text).split('\n', 1)[0] ?? ''
  return firstLine.length <= PREVIEW_MAX_CHARS
    ? firstLine
    : `${firstLine.slice(0, PREVIEW_MAX_CHARS)}…`
}

/**
 * 从会话事件流构建「轮次模型 + 消息行」（纯函数，_selftest-* 直接喂假事件）。
 *
 * ★ 轮次的唯一锚点是 `turn/start`/`turn/end`（成对、按序、不嵌套），⛔ 不是 `request/header`
 * 的条数 —— 宿主只在 header 变了时才记一条（agent-loop/src/agent.ts:498-518），对提示词静态的
 * 会话 header 条数恒为 1（或重启次数），拿它当轮次数就是「切了没变」这个 bug 本身。
 *
 * ★ `requestLogged:false` 不是缺陷，是权威信息：宿主只有 `headerEquals(baseline, header) === true`
 * 才不记 ⇒ 该楼实际用的 system/tools 等于该楼之前最近一条 header（carry-forward，headerCarried:true）。
 *
 * 返回：
 *   headers         —— 按序的 request/header（seq 升序，head/system/tools 同 summarizeHeader）
 *   headerAvailable —— 整条会话有没有任何 request/header（false ⇒ systemChars/toolCount 为 null，不猜）
 *   turns           —— [{ turn, startSeq, startTime, endSeq, endTime, endReason, open }]
 *                      open=true 表示 turn/start 还没等到配对的 turn/end（如实标注，不猜结局）
 *   rows            —— 当前活着的消息行（seq 升序；被 compaction/summary 遮蔽的行已剔除）：
 *                      [{ seq, time, turn, role, text, chars, isToolResult, isCompacted }]
 *                      role ∈ 'user'|'assistant'|'tool'；compaction/summary 行 role 为 'user' 且
 *                      isCompacted:true。turn=该行 seq 所在楼的楼号（楼外：首个楼之前的行归第 1 楼
 *                      —— 它是第 1 楼实际发出的历史的一部分；无任何楼时 turn=0）。
 */
export function buildConversation(events) {
  const list = Array.isArray(events) ? events : []
  const headers = []
  const rows = []
  const shadowed = new Set()
  /** v3：system 正文在 `system/message` 里 —— 先按楼归堆，供 header 兜底（见 systemFallbackForHeader）。 */
  const systemsByTurn = indexSystemMessages(list)
  /** turn/start 的开放栈：turn 严格顺序不嵌套，turn/end 关掉最近一个未配对的 start。 */
  const openStarts = []
  const turns = []

  for (const ev of list) {
    const seq = typeof ev?.seq === 'number' ? ev.seq : null
    const time = typeof ev?.time === 'number' && Number.isFinite(ev.time) ? ev.time : null
    switch (ev?.type) {
      case 'request/header': {
        // header 归属的楼 = 当前已开、尚未配对的 turn/start（照日志顺序：turn/start → system/message → request/header）。
        const currentTurn = openStarts.length > 0 ? openStarts[openStarts.length - 1].turn : null
        const s = summarizeHeader(ev, headers.length + 1, systemFallbackForHeader(seq, currentTurn, systemsByTurn))
        headers.push({ seq, time, head: s.head, system: s.system, tools: s.tools, rawTools: s.rawTools, rawToolsChars: s.rawToolsChars })
        break
      }
      case 'turn/start':
        openStarts.push({ turn: typeof ev.data?.turn === 'number' ? ev.data.turn : turns.length + 1, seq, time })
        break
      case 'turn/end': {
        const start = openStarts.pop() ?? { turn: typeof ev.data?.turn === 'number' ? ev.data.turn : turns.length + 1, seq: null, time: null, open: true }
        turns.push({
          turn: start.turn,
          startSeq: start.seq,
          startTime: start.time,
          endSeq: seq,
          endTime: time,
          endReason: ev.data?.reason?.kind == null ? null : String(ev.data.reason.kind),
        })
        break
      }
      case 'user/message':
        // ★ 20260914 M10：`source.kind` 是**结构性**判据（不是猜文本前缀）—— 真机实测三种取值的形状：
        //   {kind:'user', rpcId…}                       ⇒ 玩家自己发的（点发送那一下）
        //   {kind:'plugin', plugin:'…dsh-system-prompt', form:'snapshot', sections:[…]}  ⇒ 插件注入（运行上下文快照）
        //   {kind:'skill-catalog', form:'catalog', entries:[…]}                          ⇒ 技能目录注入
        //   拿不到 kind ⇒ null（未知），调用方⛔ 不许默认当成"玩家发的"。
        rows.push({
          seq, time, role: 'user', text: blocksText(ev.data?.content),
          sourceKind: typeof ev.data?.source?.kind === 'string' ? ev.data.source.kind : null,
          sourcePlugin: typeof ev.data?.source?.plugin === 'string' ? ev.data.source.plugin : null,
          isToolResult: false, isCompacted: false,
        })
        break
      case 'assistant/message':
        rows.push({ seq, time, role: 'assistant', text: blocksText(ev.data?.message?.content), isToolResult: false, isCompacted: false })
        break
      case 'tool/result':
        rows.push({ seq, time, role: 'tool', text: blocksText(ev.data?.message?.content), isToolResult: true, isCompacted: false })
        break
      case 'compaction/summary': {
        const shadowList = Array.isArray(ev.data?.shadowedSeqs) ? ev.data.shadowedSeqs : []
        for (const s of shadowList) if (Number.isInteger(s)) shadowed.add(s)
        rows.push({ seq, time, role: 'user', text: blocksText(ev.data?.summary), isToolResult: false, isCompacted: true })
        break
      }
      default:
        break
    }
  }
  // 没等到配对 turn/end 的尾部 start：如实标 open（endSeq/endTime 为 null）。
  for (const start of openStarts) {
    turns.push({ turn: start.turn, startSeq: start.seq, startTime: start.time, endSeq: null, endTime: null, endReason: null, open: true })
  }
  turns.sort((a, b) => (a.startSeq ?? 0) - (b.startSeq ?? 0))

  // 行去 shadow（被压缩摘要遮蔽的行已不在模型历史里，⛔ 不冒充"真实行"）+ 轮次归属。
  const live = rows
    .filter((r) => r.seq == null || !shadowed.has(r.seq))
    .map((r) => ({ ...r, chars: r.text.length }))
  const firstTurn = turns[0]
  const lastTurn = turns[turns.length - 1]
  for (const row of live) {
    if (row.seq == null) { row.turn = 0; continue }
    const inside = turns.find((t) => t.startSeq != null && t.startSeq <= row.seq && (t.endSeq == null || row.seq <= t.endSeq))
    if (inside) { row.turn = inside.turn; continue }
    // 楼外：首个楼之前（种子/压缩摘要种子）归第 1 楼（它是第 1 楼实际发出的历史的一部分）；
    // 最后一个楼之后的（排队中、尚未开楼的输入）如实给 0。
    row.turn = lastTurn != null && row.seq < (firstTurn.startSeq ?? 0) ? (firstTurn.turn ?? 1) : 0
  }

  return { headers, headerAvailable: headers.length > 0, turns, rows: live }
}

/** 该楼（seq ≤ endSeq）之前最近一条 request/header；没有给 null。 */
function headerForSeq(headers, endSeq) {
  let found = null
  for (const h of headers) {
    if (h.seq == null || (endSeq != null && h.seq > endSeq)) continue
    found = h
  }
  return found
}

/** 该楼自己的 request/header（seq 落在前一楼结束与本楼结束之间）；没有给 null。 */
function turnOwnHeader(conv, entry) {
  const idx = conv.turns.indexOf(entry)
  const prevEndSeq = idx > 0 ? conv.turns[idx - 1].endSeq ?? 0 : 0
  const endSeq = entry.open ? Number.MAX_SAFE_INTEGER : entry.endSeq
  return conv.headers.find((h) => h.seq != null && h.seq > prevEndSeq && h.seq <= endSeq) ?? null
}

/** 把契约 C1 的一条楼折成响应行（carry-forward 在这里发生）。 */
function turnView(conv, t, prevEndSeq) {
  const endSeq = t.open ? Number.MAX_SAFE_INTEGER : t.endSeq
  const own = conv.headers.find((h) => h.seq != null && h.seq > prevEndSeq && h.seq <= endSeq) ?? null
  const carried = headerForSeq(conv.headers, t.open ? null : t.endSeq)
  const requestLogged = own != null
  const headerCarried = !requestLogged && carried != null
  const source = requestLogged ? own : carried
  return {
    turn: t.turn,
    startedAt: isoTime(t.startTime),
    endedAt: isoTime(t.endTime),
    messageCount: conv.rows.filter((r) => r.seq != null && t.startSeq != null && r.seq >= t.startSeq && r.seq <= endSeq).length,
    seqRange: [t.startSeq, t.endSeq],
    requestLogged,
    headerCarried,
    systemChars: source?.head?.systemChars ?? null,
    toolCount: source?.head?.toolCount ?? null,
  }
}

/**
 * 数据源：会话解析缓存 + fs 扫描索引 + 「怎么读日志」这一层。
 *
 * 读日志两条路：
 *   · **宿主注入的 `readLog`（生产走这条）**：由 `lib/index.js` 的 createHostSessionReader 提供，
 *     用的是宿主进程里那个 persistence 实例（活注册表 → 宿主持久化 → sessionQuery）——
 *     写日志的是哪个版本，读的就是哪个版本。
 *   · **私有栈（兜底）**：按 `<DSH_HOME>/runtime` 里的包名 require 一份 persistence，自建 cordis app。
 *     离线自检 / fixture 没有宿主时才走这条。⚠️ 实测那份包是 **0.1.2-rc.1**，只认
 *     `session.jsonl.zstd`：宿主迁到 v3 之后，走这条会「v3-only 会话 not found / 带旧文件的
 *     只读到迁移前的冻结快照」——2026-09-15 真机 bug 的根因，所以生产路径必须注入。
 *
 * 单独导出工厂，是为了测试可以在不启 DSH 的情况下构造它、指向 fixture 根目录。
 * @param {Record<string, unknown>|undefined} rawConfig - 任意形态的配置；
 *   内部先过一遍 resolveConfig，外部调用方不需要自己补默认值。
 * @param {{readLog?:((sessionId:string)=>Promise<{meta?:any,events:any[]}>)|null}} [deps] -
 *   宿主侧读取器；缺省（或不是函数）⇒ 退回私有栈。也认 `rawConfig.readLog`。
 */
export function createSessionSource(rawConfig, deps = {}) {
  const cfg = resolveConfig(rawConfig)
  const hostReadLog = typeof deps.readLog === 'function'
    ? deps.readLog
    : (typeof cfg.readLog === 'function' ? cfg.readLog : null)
  /** Promise<持久化栈>；失败不记住，下一次请求重试。 */
  let stackPromise = null

  function getStack() {
    if (!stackPromise) {
      // 加载序列逐行照抄 CLI 版 _prompt-viewer.mjs:76-88（含两段等待）——别自己改。
      stackPromise = (async () => {
        const req = createRequire(join(cfg.runtimeDsh, 'package.json'))
        const cordis = req('@deepseek-ai/cordis')
        const dshSession = req('@deepseek-ai/dsh-session')
        const persistMod = req('@deepseek-ai/dsh-session-persistence-jsonl')
        const app = new (cordis.Context ?? cordis.default)()
        app.plugin(dshSession.SessionStore ?? dshSession.default)
        await new Promise((r) => setTimeout(r, 200))
        app.plugin(persistMod.JsonlSessionPersistence ?? persistMod.default, { root: cfg.sessionsRoot })
        await new Promise((r) => setTimeout(r, 400))
        const persistence = await app.get('sessionPersistence')
        return { app, persistence }
      })()
      stackPromise.catch(() => { stackPromise = null })
    }
    return stackPromise
  }

  /** 解析一个会话：meta（含 preset 折叠）+ 每次请求的摘要/全文 + 消息流全文。 */
  async function loadParsed(sessionId) {
    // ★ 宿主侧读取器优先（生产路径）：版本与写日志的宿主一致，v3 也读得到。
    //   没有注入才退回私有栈 —— 那条路在 v3 宿主上**读不到新会话**，只会把失败如实抛出去。
    let loaded
    if (hostReadLog !== null) {
      loaded = await hostReadLog(sessionId)
    } else {
      const { persistence } = await getStack()
      loaded = await persistence.load(sessionId)
    }
    const events = Array.isArray(loaded?.events) ? loaded.events : []
    if (loaded == null || events.length === 0) throw new Error(`会话日志为空或不可读：${sessionId}`)

    // meta.agentPreset 只是建会话时的值；中途 agent-preset/selected 换过的话它会说谎 ——
    // 必须取最后一次选择的 agentPreset（与 Session 投影同一套语义）。
    const selections = events
      .filter((ev) => ev?.type === 'agent-preset/selected')
      .map((ev) => ev?.data?.agentPreset)
    const effectivePreset = selections.length > 0 ? selections[selections.length - 1] : loaded.meta?.agentPreset

    // 轮次模型 + 消息行（C1/C2/C3 共用这一份；part=messages 从这里按轮次取，
    // ⛔ 不再拼接会话级 messagesText —— 那是「切了内容没变」的第二层原因）。
    const conversation = buildConversation(events)
    // ★ 请求摘要**从 conversation.headers 派生**（20260915 真机第二批）：
    //   改之前这里自己又扫了一遍 `request/header`，于是「system 正文兜底」只在 conversation 里生效，
    //   列表页那一列 systemChars 仍是 0 —— 同一个事实两套算路，必然漂移。
    //   现在只有一条算路（buildConversation）⇒ `/api/session` 与 `/api/part` 天然一致。
    const requests = conversation.headers.map((h) => ({
      head: h.head,
      system: h.system,
      tools: h.tools,
      rawTools: h.rawTools,
      rawToolsChars: h.rawToolsChars,
    }))
    // 预览文本 = 会话里第一条有正文的消息（60 字截断）。★ **它不是标题** —— 只作降级展示
    // （用户 2026-09-15 口径：列表名必须用会话标题，不能用消息正文冒充）。
    const firstTextRow = conversation.rows.find((r) => r.text) ?? null
    const preview = firstTextRow ? firstTextRow.text.replace(/\s+/g, ' ').trim().slice(0, 60) : ''
    // 真标题：取日志里**最后一条** `session/title` 事件的 data.title。
    // 实测形状（真会话日志，探针 `_probe-session-title-shape.mjs`）：
    //   data = { title: string, messageSeqs: array, source: object }；标题会被重新生成 ⇒ 取最后一条。
    // 没有标题事件 ⇒ ''（⛔ 不许拿 preview 冒充；客户端会照它的三级回退去 catalog.json 取「角色 · 周目」）。
    let title = ''
    for (const ev of events) {
      if (ev?.type !== 'session/title') continue
      const t = ev?.data?.title
      if (typeof t === 'string' && t.trim() !== '') title = t.trim()
    }

    return {
      meta: {
        cwd: loaded.meta?.cwd == null ? '' : String(loaded.meta.cwd),
        agentPreset: loaded.meta?.agentPreset == null ? '' : String(loaded.meta.agentPreset),
        effectivePreset: effectivePreset == null ? '' : String(effectivePreset),
      },
      title,
      preview,
      requests,
      conversation,
    }
  }

  /**
   * 解析缓存：key = 路径+mtime+size（文件一变 key 就变，天然失效）。
   * 「条数 + 字节」双限额（共用 ./mem-budget.js）：先按 LRU 淘到条数内，
   * 再淘到字节内；★ 单条就超 parseCacheMaxBytes ⇒ 不缓存（每次重新解析）。
   */
  const parseCache = createByteBudgetedCache({
    maxEntries: cfg.parseCacheSize,
    maxBytes: cfg.parseCacheMaxBytes,
  })
  /** 超限不缓存的告警按 key 去重：翻同一大会话的每一页不该刷屏。 */
  const oversizeWarned = new Set()

  function cachePut(key, value, sessionId) {
    if (parseCache.set(key, value)) return
    if (!oversizeWarned.has(key)) {
      if (oversizeWarned.size >= 100) oversizeWarned.clear()
      oversizeWarned.add(key)
      const mb = Math.round(estimateBytes(value) / (1024 * 1024))
      console.warn(
        `[dsh-memory-archive] 会话解析结果 ~${mb} MB 超过 parseCacheMaxBytes ${Math.round(cfg.parseCacheMaxBytes / (1024 * 1024))} MB，不缓存（每次重新解析）：…${String(sessionId ?? '').slice(-8)}`,
      )
    }
  }

  /** 取某次扫描行的解析结果（带缓存）。 */
  async function parsedFor(row) {
    const key = `${row.path}|${row.mtimeMs}|${row.sizeBytes}`
    const hit = parseCache.get(key)
    if (hit !== undefined) return hit
    const parsed = await loadParsed(row.id)
    cachePut(key, parsed, row.id)
    return parsed
  }

  /** fs 扫描索引：<root>/<workspace>/<id>/session.jsonl.zstd，按 mtime 倒序，缓存 ≤30 秒。 */
  let indexCache = { at: 0, rows: [] }

  function scanIndex() {
    const now = Date.now()
    if (now - indexCache.at < SCAN_TTL_MS) return indexCache.rows
    if (!existsSync(cfg.sessionsRoot)) {
      throw new Error(`会话根目录不存在：${cfg.sessionsRoot}（可在插件 config 里设 sessionsRoot）`)
    }
    const rows = []
    for (const ws of readdirSync(cfg.sessionsRoot, { withFileTypes: true })) {
      if (!ws.isDirectory()) continue
      const wsDir = join(cfg.sessionsRoot, ws.name)
      let entries
      try {
        entries = readdirSync(wsDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const s of entries) {
        if (!s.isDirectory()) continue
        const latest = latestSessionFile(join(wsDir, s.name))
        if (latest === null) continue
        rows.push({ id: s.name, workspace: ws.name, path: latest.path, sizeBytes: latest.sizeBytes, mtimeMs: latest.mtimeMs })
      }
    }
    rows.sort((a, b) => b.mtimeMs - a.mtimeMs)
    indexCache = { at: now, rows: rows.slice(0, cfg.maxSessions) }
    return indexCache.rows
  }

  /**
   * 会话列表：只扫 fs 索引，绝不解析 —— title='' / requests=-1 表示「尚未解析」
   * （requests=0 是「解析过、确实没有 request/header」的真值，两者必须可区分）。
   * 解析成本由 /api/session（选中即拉）与 /api/sessions/resolve（空闲分批补齐）承担。
   */
  function listSessions() {
    return scanIndex().map((row) => ({
      id: row.id,
      workspace: row.workspace,
      sizeBytes: row.sizeBytes,
      mtime: new Date(row.mtimeMs).toISOString(),
      title: '',
      requests: -1,
    }))
  }

  /**
   * 按 id 批量解析（调用方每批 ≤RESOLVE_BATCH_LIMIT 个）：返回与列表同形的行，
   * 索引里不存在的 id 直接跳过；单个会话解析失败降级 title=''/requests=-2，不拖垮整批。
   * ★ 20260913 哨兵语义（缺陷 3）：-1 = 未解析（列表快路径）、0 = 解析过、确实没有请求、
   *   -2 = 解析失败。旧版把失败折成 0，客户端把 0 当「空会话」隐藏 ⇒ 大会话静默消失。
   * @param {string[]} ids - 会话 id 列表
   */
  async function resolveSessions(ids) {
    const byId = new Map(scanIndex().map((row) => [row.id, row]))
    const out = []
    for (const id of ids) {
      const row = byId.get(id)
      if (!row) continue
      let title = ''
      let preview = ''
      let requests = -2
      let readError = null
      try {
        const parsed = await parsedFor(row)
        title = parsed.title
        preview = parsed.preview
        requests = parsed.requests.length
      } catch (error) {
        // 单个会话坏掉不拖垮整批：title='' / requests=-2（解析失败哨兵，不是 0）。
        // ★ 20260914 M8：顺手把**原因**带回去（readError）—— 客户端列表行才能打「日志读不了」徽标，
        //   用户不必一条条点进去才知道哪几条是坏的。成功行显式 readError:null（"已知能读"≠"没查过"）。
        readError = readErrorShape(error)
      }
      out.push({
        id: row.id,
        workspace: row.workspace,
        sizeBytes: row.sizeBytes,
        mtime: new Date(row.mtimeMs).toISOString(),
        title,
        preview,
        requests,
        readError,
      })
    }
    return out
  }

  /** 按 id 找会话并解析；找不到返回 null（由调用方决定错误文案）。 */
  async function sessionDetail(id) {
    const row = scanIndex().find((r) => r.id === id)
    if (!row) return null
    return { row, parsed: await parsedFor(row) }
  }

  // -------------------------------------------------------------------------
  // 常驻会话（20260915 查看器提速；用户思路：① 不自动抓列表 ② 常驻的后台自动抓）
  //
  // 为什么要它：列表页原来会在打开时「空闲批量补标题」，每个会话都是一次**整份日志解析**
  // （客户端注释实测：单会话在宿主堆里瞬时驻留 126–186 MB）。会话一多就是"打开就卡"。
  // 现在的分工：**用户自己选常驻集** → 后台**串行**预热出**轻投影**（只留 title/requests/规模/耗时，
  // ⛔ 不留解析结果本体）→ 打开面板只读这份投影（**读路径一次解析都不做**）。
  // 串行是硬约束：同一时刻最多一个解析活着（与 parseCacheSize=3 / 96 MB 的 P0 内存纪律同源）。
  // -------------------------------------------------------------------------

  /** 常驻集：ids = 用户选的顺序；rows = id → 轻投影。 */
  let resident = { ids: [], rows: new Map() }
  let residentLoaded = false
  let warmQueue = []
  let warming = false
  let refreshTimer = null
  let lastWarmAt = null
  let lastRefreshAt = null
  const warmStats = { warmed: 0, skipped: 0, failed: 0, parseMsTotal: 0 }

  /** 读常驻集文件：不存在 ⇒ 空集（不是错误）；存在但坏了 ⇒ 空集 + warn（⛔ 不抛、不覆盖）。 */
  function loadResident() {
    if (residentLoaded) return
    residentLoaded = true
    try {
      const parsed = JSON.parse(readFileSync(cfg.residentFile, 'utf8'))
      const ids = Array.isArray(parsed?.ids)
        ? parsed.ids.map((x) => String(x)).filter((x) => x !== '').slice(0, cfg.residentMax)
        : []
      const rows = new Map()
      const src = parsed?.rows
      if (src && typeof src === 'object' && !Array.isArray(src)) {
        for (const [id, v] of Object.entries(src)) {
          if (!v || typeof v !== 'object' || Array.isArray(v)) continue
          rows.set(String(id), { ...v, id: String(id) })
        }
      }
      resident = { ids, rows }
      console.info(`[dsh-memory-archive] 常驻集已载入：${ids.length} 个（投影 ${rows.size} 条）`)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn(`[dsh-memory-archive] 常驻集文件读不了（当空集，不覆盖）：${error?.message || error}`)
      }
    }
  }

  /** 原子写常驻集（tmp → rename）；失败只 warn：内存态照常，绝不影响面板。 */
  function persistResident() {
    try {
      mkdirSync(dirname(cfg.residentFile), { recursive: true })
      const rows = {}
      for (const [id, row] of resident.rows) rows[id] = row
      const body = JSON.stringify({ version: 1, ids: resident.ids, rows, updatedAt: new Date().toISOString() }, null, 1)
      const tmp = `${cfg.residentFile}.tmp-${process.pid}`
      writeFileSync(tmp, body, 'utf8')
      renameSync(tmp, cfg.residentFile)
    } catch (error) {
      console.warn(`[dsh-memory-archive] 常驻集写盘失败（内存态照常）：${error?.message || error}`)
    }
  }

  /** 预热一个会话 → 轻投影（**只留 title/requests/规模/耗时**，解析结果本体不驻留在这里）。 */
  async function warmOne(id) {
    const row = scanIndex().find((r) => r.id === id)
    if (!row) {
      warmStats.failed++
      return null
    }
    const key = `${row.path}|${row.mtimeMs}|${row.sizeBytes}`
    const prev = resident.rows.get(id)
    if (prev && prev.key === key && prev.readError == null && prev.projVersion === PROJECTION_VERSION) {
      warmStats.skipped++
      return prev
    }
    const t0 = Date.now()
    let projection
    try {
      const parsed = await parsedFor(row)
      projection = {
        id,
        key,
        workspace: row.workspace,
        sizeBytes: row.sizeBytes,
        mtime: new Date(row.mtimeMs).toISOString(),
        // ★ title = 会话**真标题**（日志里最后一条 session/title）；preview = 第一条消息 60 字。
        //   两者不许混：列表名用 title，preview 只在标题缺失时作降级展示。
        title: parsed.title,
        preview: parsed.preview,
        projVersion: PROJECTION_VERSION,
        requests: parsed.requests.length,
        readError: null,
        warmedAt: new Date().toISOString(),
        parseMs: Date.now() - t0,
      }
      warmStats.warmed++
    } catch (error) {
      projection = {
        id,
        key,
        workspace: row.workspace,
        sizeBytes: row.sizeBytes,
        mtime: new Date(row.mtimeMs).toISOString(),
        title: '',
        preview: '',
        projVersion: PROJECTION_VERSION,
        requests: -2,
        readError: readErrorShape(error),
        warmedAt: new Date().toISOString(),
        parseMs: Date.now() - t0,
      }
      warmStats.failed++
    }
    resident.rows.set(id, projection)
    warmStats.parseMsTotal += projection.parseMs
    lastWarmAt = projection.warmedAt
    persistResident()
    console.info(
      `[dsh-memory-archive] 常驻预热 …${String(id).slice(-8)} parseMs=${projection.parseMs} `
      + `requests=${projection.requests}${projection.readError ? ' 读不了' : ''}`,
    )
    return projection
  }

  /** 串行消费预热队列（同一时刻最多一个解析在跑 ⇒ 内存峰值不叠）。 */
  function pumpWarm() {
    if (warming) return
    const next = warmQueue.shift()
    if (next === undefined) return
    warming = true
    void (async () => {
      try {
        await warmOne(next)
      } catch (error) {
        console.warn(`[dsh-memory-archive] 常驻预热失败（继续下一个）：${error?.message || error}`)
      } finally {
        warming = false
        if (warmQueue.length > 0) setTimeout(pumpWarm, 0).unref?.()
      }
    })()
  }

  function enqueueWarm(ids) {
    for (const id of Array.isArray(ids) ? ids : []) {
      const s = String(id ?? '')
      if (s === '' || warmQueue.includes(s)) continue
      warmQueue.push(s)
    }
    pumpWarm()
  }

  /** 读常驻集（**绝无解析**）：面板打开时打这个。 */
  function getResident() {
    loadResident()
    startResidentTimer()
    const sessions = resident.ids.map((id) => {
      const row = resident.rows.get(id)
      return row
        ? { ...row }
        : { id, workspace: null, sizeBytes: null, mtime: null, title: '', preview: '', requests: -1, readError: null, warmedAt: null, parseMs: null }
    })
    return {
      ok: true,
      ids: [...resident.ids],
      sessions,
      pending: sessions.filter((s) => s.requests === -1).map((s) => s.id),
      queued: [...warmQueue],
      stats: { ...warmStats },
      lastWarmAt,
      lastRefreshAt,
      refreshMs: cfg.residentRefreshMs,
      max: cfg.residentMax,
    }
  }

  /** 改常驻集：落盘 + 排队预热（⛔ 不在请求里解析，避免把面板请求拖住）。 */
  function setResident(ids) {
    loadResident()
    startResidentTimer()
    const clean = []
    for (const raw of Array.isArray(ids) ? ids : []) {
      const id = String(raw ?? '').trim()
      if (id === '' || clean.includes(id)) continue
      if (clean.length >= cfg.residentMax) break
      clean.push(id)
    }
    resident.ids = clean
    for (const id of [...resident.rows.keys()]) if (!clean.includes(id)) resident.rows.delete(id)
    warmQueue = warmQueue.filter((id) => clean.includes(id))
    persistResident()
    enqueueWarm(clean.filter((id) => {
      const row = resident.rows.get(id)
      return row === undefined || row.requests === -1
    }))
    return getResident()
  }

  /** 后台刷新：重扫 fs 索引，常驻里 mtime/size 变了的排队预热。 */
  function refreshResident() {
    try {
      loadResident()
      if (resident.ids.length === 0) return
      forget()
      const byId = new Map(scanIndex().map((r) => [r.id, r]))
      const stale = []
      for (const id of resident.ids) {
        const row = byId.get(id)
        if (!row) continue
        const key = `${row.path}|${row.mtimeMs}|${row.sizeBytes}`
        const prev = resident.rows.get(id)
        if (!prev || prev.key !== key) stale.push(id)
      }
      lastRefreshAt = new Date().toISOString()
      if (stale.length > 0) {
        console.info(`[dsh-memory-archive] 常驻刷新：${stale.length}/${resident.ids.length} 个变了 ⇒ 排队预热`)
        enqueueWarm(stale)
      }
    } catch (error) {
      console.warn(`[dsh-memory-archive] 常驻刷新失败（跳过本轮）：${error?.message || error}`)
    }
  }

  /** 定时器懒启动（第一次碰常驻集才起）；unref ⇒ 不拖住进程退出。 */
  function startResidentTimer() {
    if (refreshTimer || !(cfg.residentRefreshMs > 0)) return
    refreshTimer = setInterval(refreshResident, cfg.residentRefreshMs)
    refreshTimer.unref?.()
  }

  /** 释放持久化栈（尽力而为）。 */
  async function stop() {
    if (refreshTimer) {
      clearInterval(refreshTimer)
      refreshTimer = null
    }
    warmQueue = []
    if (!stackPromise) return
    const { app } = await stackPromise
    try {
      await app.stop?.()
    } catch {
      // 尽力而为：宿主卸载路径上不允许再抛。
    }
  }

  /** 清空 fs 扫描索引缓存（?refresh=1 用）；解析缓存按 (路径+mtime+size) 键控，无需清。 */
  function forget() {
    indexCache = { at: 0, rows: [] }
  }

  return {
    scanIndex, listSessions, resolveSessions, sessionDetail, forget, stop,
    // 20260915 查看器提速：常驻集读（绝不解析）/ 改集 + 排队预热 / 后台刷新
    getResident, setResident, enqueueWarm, refreshResident,
  }
}

/**
 * 会话日志文件名（正则**锚定**）：`session.jsonl.zstd` 与格式迁移后的 `session.v3.jsonl.zstd` 都认。
 * ⛔ 不认 `.pre-repair.bak` / `.tmp` / `.migration.*` —— 那些是备份与中间态，不是当前日志。
 */
const SESSION_FILE_RE = /^session(?:\.v\d+)?\.jsonl\.zstd$/

/**
 * 一个会话目录里**最新的**日志文件（没有 ⇒ null）。
 *
 * ★ 2026-09-15 真机 bug：DSH 的会话格式迁移会写出 **`session.v3.jsonl.zstd`**，而旧实现只 `stat`
 *   `session.jsonl.zstd` ⇒ **只带 v3 文件的会话整个从列表里漏掉**（真机实测 18 个，含"最新的那个"），
 *   而带两个文件的会话会**按旧文件的 mtime 排序、拿旧文件的 path 当解析缓存键** ⇒ 看到的是旧数据。
 *   ⇒ 现在按"目录里最新的一份日志"取，正则锚定，将来再加 v4 也不用改。
 * @param {string} dir - `<sessionsRoot>/<workspace>/<sessionId>`
 * @returns {{path:string,sizeBytes:number,mtimeMs:number}|null}
 */
function latestSessionFile(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  let best = null
  for (const e of entries) {
    if (!e.isFile() || !SESSION_FILE_RE.test(e.name)) continue
    const p = join(dir, e.name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (!st.isFile()) continue
    if (best === null || st.mtimeMs > best.mtimeMs) best = { path: p, sizeBytes: st.size, mtimeMs: st.mtimeMs }
  }
  return best
}

function sendJson(res, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** text 超上限截断，并在末尾写明原长度。 */
function clipText(text) {
  if (text.length <= MAX_TEXT_CHARS) return text
  return `${text.slice(0, MAX_TEXT_CHARS)}…（已截断，原 ${text.length} 字符）`
}

const PART_NAMES = 'system|tools|messages|inventory'

// ---------------------------------------------------------------------------
// 归档位（20260914 M4）：「已归档」不是会话文件的属性，而是工作区注册表的全局集合
// global.archivedSessionIds（服务键 workspaceRegistry）。它由宿主半侧经 createHandler
// 的 archivedProvider 选项注入；这里只读投影，⛔ 不做任何归档/取消归档动作。
// 语义红线：provider 没传 / 抛错 / 形状不对 ⇒ known:false（未知）——未知 ≠ 未归档，
// 绝不许折成空集冒充「谁都没归档」。并且必须在每次请求时现取（归档是实时的），
// ⛔ 不进 scanIndex() 的 30 秒索引缓存。
// ---------------------------------------------------------------------------

/** 读一次归档来源：→ { known:true, ids:Set<string> }；拿不到 ⇒ { known:false, ids:空 }。 */
function readArchiveState(archivedProvider) {
  if (typeof archivedProvider !== 'function') return { known: false, ids: new Set() }
  try {
    const res = archivedProvider()
    if (!res || res.known !== true || !Array.isArray(res.ids)) return { known: false, ids: new Set() }
    return { known: true, ids: new Set(res.ids.map(String)) }
  } catch {
    return { known: false, ids: new Set() }
  }
}

/** 行的归档位（字段名冻结）：known ⇒ true/false；未知 ⇒ null（⛔ 不许用 false 冒充）。 */
function archiveBitOf(state, id) {
  return state.known ? state.ids.has(String(id)) : null
}

/** 列表响应的信封字段：客户端据此判断「归档位能不能信」。 */
function archiveEnvelope(state, sessions) {
  return {
    known: state.known,
    archivedCount: state.known ? sessions.filter((r) => r.archived === true).length : 0,
  }
}

/** 给一批行现取现合并归档位（map 发生在每次请求里，不碰 indexCache）。 */
function withArchiveBits(state, sessions) {
  return sessions.map((row) => ({ ...row, archived: archiveBitOf(state, row.id) }))
}

async function sessionsApi(source, params, archivedProvider) {
  if (params.get('refresh') === '1') source.forget?.()
  const state = readArchiveState(archivedProvider)          // ★ 每次请求现取，绝不烤进索引缓存
  const sessions = withArchiveBits(state, await source.listSessions())
  return { ok: true, archive: archiveEnvelope(state, sessions), sessions }
}

/** 常驻集响应（GET/POST 共用）：读路径**绝不解析**；归档位与列表同口径现取现合并。 */
async function residentApi(source, params, archivedProvider) {
  const state = readArchiveState(archivedProvider)
  const payload = source.getResident()
  const sessions = withArchiveBits(state, payload.sessions)
  return { ...payload, sessions, archive: archiveEnvelope(state, sessions) }
}

/** POST /api/resident：改集 → 再读一次投影（**改集本身不解析**，预热在后台串行跑）。 */
async function residentApiAfterSet(source, value, archivedProvider) {
  source.setResident(Array.isArray(value?.ids) ? value.ids : [])
  return await residentApi(source, null, archivedProvider)
}

/**
 * 读一个小 JSON 请求体（默认上限 64 KB）。超限 / 坏 JSON 都如实返回 error（⛔ 不抛）——
 * 常驻集是几十个 id，正常只有几 KB。
 * @param {import('node:http').IncomingMessage} req - 宿主交来的请求。
 * @param {number} [maxBytes] - 上限（超出即停读并回错，不再累积内存）。
 */
function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolveBody) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        resolveBody({ ok: false, error: `请求体超过 ${maxBytes} 字节` })
        try { req.destroy() } catch {}
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolveBody({ ok: true, value: text.trim() === '' ? {} : JSON.parse(text) })
      } catch (error) {
        resolveBody({ ok: false, error: `请求体不是合法 JSON：${error?.message || error}` })
      }
    })
    req.on('error', (error) => resolveBody({ ok: false, error: String(error?.message || error) }))
  })
}

async function sessionsResolveApi(source, params, archivedProvider) {
  const ids = (params.get('ids') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '')
  if (ids.length === 0) return { ok: false, error: '缺少 ids 参数（逗号分隔的会话 id）' }
  if (ids.length > RESOLVE_BATCH_LIMIT) {
    return { ok: false, error: `ids 一次最多 ${RESOLVE_BATCH_LIMIT} 个（收到 ${ids.length} 个）` }
  }
  const state = readArchiveState(archivedProvider)          // ★ 同上：现取现合并
  const sessions = withArchiveBits(state, await source.resolveSessions(ids))
  return { ok: true, archive: archiveEnvelope(state, sessions), sessions }
}

async function sessionApi(source, params, archivedProvider) {
  const id = params.get('id') ?? ''
  if (!id) return { ok: false, error: '缺少 id 参数' }
  const state = readArchiveState(archivedProvider)          // ★ 详情出口同样带归档位（详情页提示用）
  let found
  try {
    found = await source.sessionDetail(id)
  } catch (error) {
    // ★ M8：日志读不出来 ≠ 会话不存在 —— 把宿主原文与位置一起交出去，客户端才有话可说。
    return parseFailedShape(error, { archived: archiveBitOf(state, id) })
  }
  if (!found) return { ok: false, error: `会话不存在：${id}` }
  return {
    ok: true,
    title: found.parsed.title,
    preview: found.parsed.preview,
    meta: found.parsed.meta,
    requests: found.parsed.requests.map((r) => r.head),
    archived: archiveBitOf(state, id),
  }
}

async function partApi(source, params) {
  const id = params.get('id') ?? ''
  const turn = Number(params.get('turn'))
  const part = params.get('part') ?? ''
  if (!id) return { ok: false, error: '缺少 id 参数' }
  if (!Number.isInteger(turn) || turn < 1) return { ok: false, error: 'turn 必须是从 1 开始的整数' }
  if (!['system', 'tools', 'messages', 'inventory'].includes(part)) {
    return { ok: false, error: `part 必须是 ${PART_NAMES} 之一` }
  }
  const found = await (async () => {
    try {
      return await source.sessionDetail(id)
    } catch (error) {
      return { parseFailed: parseFailedShape(error) }   // ★ M8：part 出口同样交代原因
    }
  })()
  if (found && found.parseFailed) return found.parseFailed
  if (!found) return { ok: false, error: `会话不存在：${id}` }
  const conv = found.parsed.conversation
  const entry = conv.turns.find((t) => t.turn === turn)
  if (!entry) {
    const latest = conv.turns.reduce((m, t) => Math.max(m, t.turn), 0)
    return {
      ok: false,
      error: latest > 0 ? `没有第 ${turn} 楼（共 ${latest} 楼）` : '该会话没有任何轮次（turn/start / turn/end）',
    }
  }
  // 本楼自己的 header；没有 ⇒ carry-forward（该楼之前最近一条，宿主判定过逐字相等）。
  const own = turnOwnHeader(conv, entry)
  const carried = headerForSeq(conv.headers, entry.open ? null : entry.endSeq)
  const requestLogged = own != null
  const headerCarried = !requestLogged && carried != null
  const header = own ?? carried
  // W0 增量字段 5：carried 楼必须带 mutabilityBasis:'header-equal'（权威：宿主 headerEquals 判定）。
  const carriedFields = { requestLogged, headerCarried, ...(headerCarried ? { mutabilityBasis: 'header-equal' } : {}) }
  if (part === 'system') {
    if (!header) return { ok: false, error: '该会话没有任何 request/header 记录（headerAvailable:false），system 未知（不猜）' }
    return {
      ok: true,
      part,
      sessionId: id,
      turn,
      ...carriedFields,
      chars: header.system.length,
      text: clipText(header.system),
      // 正文来源（见 summarizeHeader）：'header' | 'system/message' | 'system/message(prev-turn)' | null=未知。
      // UI 必须把它显示出来 —— "跨楼回退"与"本楼发的"是两件事，不许混成一句"这就是本楼上下文"。
      systemSource: header.head?.systemSource ?? null,
      systemParts: header.head?.systemParts ?? 0,
    }
  }
  if (part === 'messages') {
    // ★ C3 语义修正：该楼实际发出的历史 = 该楼 turn/end 之前的全部活着消息行
    //   （楼开始前就在历史里的 + 楼内产生的），随楼号单调增长；
    //   ⛔ 不再是会话级 messagesText（旧实现两楼必然相同）。
    const endSeq = entry.open ? Number.MAX_SAFE_INTEGER : entry.endSeq
    const inTurn = conv.rows.filter((r) => r.seq != null && r.seq <= endSeq)
    const text = inTurn.map((r) => `── [seq ${r.seq ?? '?'}] ${r.role} ──\n${r.text}`).join('\n\n')
    return {
      ok: true, part, sessionId: id, turn, ...carriedFields,
      count: inTurn.length, chars: text.length, text: clipText(text),
      messages: inTurn.map((r) => ({
        seq: r.seq, role: r.role, preview: previewOf(r.text), chars: r.chars,
        isToolResult: r.isToolResult, isCompacted: r.isCompacted,
      })),
    }
  }
  // tools / inventory：该楼之前最近一条 header 的 per-tool 清单（已按字符数降序），语义不变。
  if (!header) return { ok: false, error: '该会话没有任何 request/header 记录（headerAvailable:false），tools 未知（不猜）' }
  return { ok: true, part, sessionId: id, turn, ...carriedFields, tools: header.tools }
}

/**
 * 从宿主日志解析器的报错里把**位置**抠出来（20260914 M8）。
 *
 * 宿主 `session-persistence-jsonl` 的 seq 连续性检查会抛：
 *   `corrupt session log: seq gap in committed region at line 662 (expected 13596, got 13594)`
 * 行号与 seq 对定位很有用（能直接告诉用户"哪一行、期望多少、实得多少"），所以单独解析出来。
 * ★ 解析不出来就返回 `null` —— ⛔ 绝不编行号（不同形状的报错没有位置信息是真事）。
 * @param {unknown} message - 原始报错文本
 * @returns {{line:number, expected:number, got:number}|null}
 */
function parseSeqGapDetail(message) {
  const m = /at line (\d+) \(expected (\d+), got (\d+)\)/.exec(String(message ?? ''))
  if (!m) return null
  return { line: Number(m[1]), expected: Number(m[2]), got: Number(m[3]) }
}

/**
 * W0 增量字段 1 的失败形状：解析失败 ≠ 0 楼/空列表，客户端徽标必须显「失败」。
 * ★ 20260914 M8：补 `detail`（行号/期望 seq/实得 seq，解不出即 null）—— 光说"失败"用户没法判断是什么坏了；
 *   带位置才能让人一眼看出这是**宿主自己的日志解析器**在拒绝（`session-persistence-jsonl` 的 seq 连续性检查）。
 */
function parseFailedShape(error, empty) {
  const message = String((error && error.message) || error)
  return {
    ok: false,
    error: { code: 'session-parse-failed', message, detail: parseSeqGapDetail(message) },
    ...empty,
  }
}

/** 供会话来源复用：把一次解析失败折成行上的 `readError`（形状与 parseFailedShape().error 一致）。 */
function readErrorShape(error) {
  const message = String((error && error.message) || error)
  return { code: 'session-parse-failed', message, detail: parseSeqGapDetail(message) }
}

/** 契约 C1：轮次列表（锚点 = turn/start / turn/end，⛔ 不是 request/header 条数）。 */
async function turnsApi(source, params) {
  const id = params.get('id') ?? ''
  if (!id) return { ok: false, error: '缺少 id 参数' }
  let found
  try {
    found = await source.sessionDetail(id)
  } catch (error) {
    return parseFailedShape(error, { turns: [], latest: 0 })
  }
  if (!found) return { ok: false, error: `会话不存在：${id}` }
  const conv = found.parsed.conversation
  let prevEndSeq = 0
  const turns = conv.turns.map((t) => {
    const view = turnView(conv, t, prevEndSeq)
    prevEndSeq = t.endSeq ?? prevEndSeq
    return view
  })
  const latest = conv.turns.reduce((m, t) => Math.max(m, t.turn), 0)
  // W0 增量字段 3：一条 header 都没有 ⇒ headerAvailable:false（systemChars/toolCount 已是 null）。
  return { ok: true, sessionId: id, latest, ...(conv.headerAvailable ? {} : { headerAvailable: false }), turns }
}

/** 契约 C2：消息行列表（二级导航）。默认返回最后 limit 条（自动定位最新楼）。 */
async function messagesApi(source, params) {
  const id = params.get('id') ?? ''
  if (!id) return { ok: false, error: '缺少 id 参数' }
  let limit = DEFAULT_MESSAGES_LIMIT
  const rawLimit = params.get('limit')
  if (rawLimit != null && rawLimit !== '') {
    limit = Number(rawLimit)
    if (!Number.isInteger(limit) || limit < 1) return { ok: false, error: 'limit 必须是正整数' }
    limit = Math.min(limit, MAX_MESSAGES_LIMIT)
  }
  let from = null
  const rawFrom = params.get('from')
  if (rawFrom != null && rawFrom !== '') {
    from = Number(rawFrom)
    if (!Number.isInteger(from) || from < 0) return { ok: false, error: 'from 必须是非负整数' }
  }
  let found
  try {
    found = await source.sessionDetail(id)
  } catch (error) {
    return parseFailedShape(error, { total: 0, latestIndex: null, messages: [] })
  }
  if (!found) return { ok: false, error: `会话不存在：${id}` }
  const rows = found.parsed.conversation.rows
  const total = rows.length
  // W0 增量字段 2：空会话 total:0 / messages:[] / latestIndex:null（不存在"最新一条"）。
  if (from == null) from = Math.max(0, total - limit)
  const page = rows.slice(from, from + limit)
  // ★ M10：给每行标出**是谁发的**（结构性判据 source.kind）。
  //   `playerTyped` 只对 source.kind==='user' 为 true；kind 缺失 ⇒ null（未知，⛔ 不许默认当真）。
  //   计数分开给：`player`（玩家真发的）/`injected`（插件·技能目录等注入的 user 行）/`unknownUser`（拿不到 kind 的 user 行）。
  const counts = { player: 0, injected: 0, unknownUser: 0, assistant: 0, tool: 0, compacted: 0 }
  for (const r of rows) {
    if (r.role === 'user') {
      if (r.sourceKind === 'user') counts.player++
      else if (typeof r.sourceKind === 'string') counts.injected++
      else counts.unknownUser++
    } else if (r.role === 'assistant') counts.assistant++
    else if (r.role === 'tool') counts.tool++
    if (r.isCompacted) counts.compacted++
  }
  return {
    ok: true, sessionId: id, total, latestIndex: total === 0 ? null : total - 1, counts,
    messages: page.map((r, i) => ({
      index: from + i, seq: r.seq, turn: r.turn, role: r.role,
      preview: previewOf(r.text), chars: r.chars,
      isToolResult: r.isToolResult, isCompacted: r.isCompacted,
      sourceKind: r.sourceKind ?? null,
      sourcePlugin: r.sourcePlugin ?? null,
      playerTyped: r.role === 'user' ? (r.sourceKind === 'user') : null,
    })),
  }
}

/**
 * 单条**工具定义**出口（20260914 M10）。
 *
 * 用户报障：「点击工具比如 state_seed，弹出的依然是目录，而不是注入的实际文本」——
 * 以前点工具行只会打开 `part=tools`（整份工具清单＝目录），看不到那一条自己长什么样。
 * 这里按同一套口径（走会话日志的 `request/header.header.tools`，⛔ 不直读会话文件、⛔ 不给整份工具表）
 * 只交出**被点开的那一条**，原样 JSON（那就是模型实际看到的东西）。
 *
 * @param {object} source - 会话来源
 * @param {URLSearchParams} params - id / turn / name
 * @returns {Promise<object>} 与 C1/C3 同风格的 `{ok:true,…}` / `{ok:false,error}`
 */
async function toolApi(source, params) {
  const id = params.get('id') ?? ''
  const name = params.get('name') ?? ''
  const turn = Number(params.get('turn'))
  if (!id) return { ok: false, error: '缺少 id 参数' }
  if (name === '') return { ok: false, error: '缺少 name 参数' }
  if (!Number.isInteger(turn) || turn < 1) return { ok: false, error: 'turn 必须是从 1 开始的整数' }
  let found
  try {
    found = await source.sessionDetail(id)
  } catch (error) {
    return parseFailedShape(error)     // ★ M8 口径：读不了就说清原因，⛔ 不折成"没有工具"
  }
  if (!found) return { ok: false, error: `会话不存在：${id}` }
  const conv = found.parsed.conversation
  const entry = conv.turns.find((t) => t.turn === turn)
  if (!entry) {
    const latest = conv.turns.reduce((m, t) => Math.max(m, t.turn), 0)
    return { ok: false, error: latest > 0 ? `没有第 ${turn} 楼（共 ${latest} 楼）` : '该会话没有任何轮次（turn/start / turn/end）' }
  }
  const own = turnOwnHeader(conv, entry)
  const carried = headerForSeq(conv.headers, entry.open ? null : entry.endSeq)
  const header = own ?? carried
  if (!header) {
    return { ok: false, error: '该会话没有任何 request/header 记录（headerAvailable:false），工具定义未知（不猜）' }
  }
  const list = Array.isArray(header.tools) ? header.tools : []
  // ★ 原文优先：清单（header.tools）只有 {name, chars}；要"注入的实际文本"必须用 header.rawTools。
  const rawList = Array.isArray(header.rawTools) ? header.rawTools : null
  if (rawList === null) {
    return {
      ok: false,
      error: {
        code: 'tool-text-omitted',
        message: `该楼 header 的工具定义原文超出本插件保留上限（${RAW_TOOLS_MAX_CHARS} 字符，实际 ${header.rawToolsChars ?? '未知'}）—— 只能给清单（name/字数），⛔ 不截断冒充全文`,
      },
    }
  }
  const hit = rawList.find((t) => t && String(t?.name ?? t?.function?.name) === name)
  if (!hit) {
    return {
      ok: false,
      error: {
        code: 'no-such-tool',
        message: `第 ${turn} 楼没有名为 ${JSON.stringify(name)} 的工具定义（该楼共 ${list.length} 个）`,
      },
    }
  }
  // 原样 JSON —— 这就是模型实际看到的那一条定义（不裁剪、不美化字段名）。
  const text = JSON.stringify(hit, null, 2)
  return {
    ok: true, sessionId: id, turn, name,
    requestLogged: own != null,
    headerCarried: own == null && carried != null,
    chars: text.length,
    text,
  }
}

/**
 * HTTP 路由。抽成工厂与 createSessionSource 一样是为了测试：临时 server 可以
 * 直接挂这个 handler，不需要启动 DSH。
 * @param {Record<string, unknown>|undefined} rawConfig - 任意形态的配置；
 *   内部先过一遍 resolveConfig，外部调用方（验收脚本、单独测 handler 的人）
 *   传 `{}` 甚至 undefined 都能拿到全部默认值。
 *   归档来源（20260914 M4）：rawConfig.archivedProvider —— 返回
 *   `{ known:true, ids:string[] }` 的函数（工作区注册表 archivedSessionIds 的只读投影）；
 *   没传 / 抛错 / 形状不对 ⇒ 全部行 archived:null、archive.known:false（未知，不冒充未归档）。
 * @param {object} [sourceOverride] - 测试注入：直接顶替内部 createSessionSource
 *   的产物（实现同一组方法即可）。省略时行为与旧版完全一致（index.js 单参调用不受影响）。
 */
export function createHandler(rawConfig, sourceOverride) {
  const cfg = resolveConfig(rawConfig)
  const source = sourceOverride ?? createSessionSource(cfg, {
    readLog: typeof cfg.readLog === 'function' ? cfg.readLog : null,
  })
  const archivedProvider = typeof cfg.archivedProvider === 'function' ? cfg.archivedProvider : null
  return async (req, res) => {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      return sendJson(res, { ok: false, error: 'bad url' })
    }
    // 宿主挂载后路径形如 /prompt-viewer/api/… —— 先剥掉前缀。
    let path = url.pathname
    if (path === cfg.webPath) path = '/'
    else if (path.startsWith(`${cfg.webPath}/`)) path = path.slice(cfg.webPath.length)

    let body
    try {
      if (path === '/health') {
        let count = 0
        try {
          count = source.scanIndex().length
        } catch {
          // 根目录不可用时 health 仍存活；具体错误由 /api/sessions 报。
        }
        body = { ok: true, sessions: count }
      } else if (path === '/api/sessions') {
        body = await sessionsApi(source, url.searchParams, archivedProvider)
      } else if (path === '/api/resident') {
        // 20260915 查看器提速：GET = 读常驻投影（绝不解析）；POST {ids:[…]} = 改集并排队预热。
        if (req.method === 'POST') {
          const parsed = await readJsonBody(req)
          body = parsed.ok ? await residentApiAfterSet(source, parsed.value, archivedProvider) : { ok: false, error: parsed.error }
        } else {
          body = await residentApi(source, url.searchParams, archivedProvider)
        }
      } else if (path === '/api/sessions/resolve') {
        body = await sessionsResolveApi(source, url.searchParams, archivedProvider)
      } else if (path === '/api/session') {
        body = await sessionApi(source, url.searchParams, archivedProvider)
      } else if (path === '/api/turns') {
        body = await turnsApi(source, url.searchParams)
      } else if (path === '/api/messages') {
        body = await messagesApi(source, url.searchParams)
      } else if (path === '/api/part') {
        body = await partApi(source, url.searchParams)
      } else if (path === '/api/tool') {
        body = await toolApi(source, url.searchParams)   // M10：单条工具定义（点工具行看实际文本）
      } else {
        body = {
          ok: false,
          error: 'not found',
          hint: 'GET /health | /api/resident | POST /api/resident {ids:[…]} | /api/sessions | /api/sessions/resolve?ids=<id,… ≤10> | /api/session?id= | /api/turns?id= | /api/messages?id=&from=&limit= | /api/tool?id=&turn=&name= | /api/part?id=&turn=&part=system|tools|messages|inventory',
        }
      }
    } catch (error) {
      // 解析失败（文件坏、模块加载不了、参数怪）绝不抛出 —— 统一降级为 ok:false。
      body = { ok: false, error: String((error && error.message) || error) }
    }
    sendJson(res, body)
  }
}
