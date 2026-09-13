/**
 * dsh-prompt-viewer —— 宿主半侧的并入版
 *
 * 本文件是 `dsh-prompt-viewer` 宿主半侧的并入版（原插件整体并入 dsh-memory-archive，
 * 单包自包含，对 dsh-prompt-viewer 零依赖），路由挂在 `/magictarven/prompt` 之下，
 * 由本包 lib/index.js 统一注册；本文件不再自带 name/inject/apply，
 * 只导出 createHandler / createSessionSource / resolveConfig。
 *
 * 把 `<home>/.dsh/sessions/<projectKey>/<sessionId>/session.jsonl.zstd` 解析成 JSON，
 * 供客户端半侧同源 fetch：
 *
 *   GET /health               → { ok:true, sessions:<n> }
 *   GET /api/sessions[?refresh=1]
 *                             → { ok:true, sessions:[{ id, workspace, sizeBytes, mtime, title, requests }] }
 *                               只扫目录、不解析任何会话：title=''、requests=-1 是
 *                               「尚未解析」哨兵（0 是「解析过、确实没有请求」的真值）。
 *   GET /api/sessions/resolve?ids=<id,id,…>（一次 ≤10 个）
 *                             → { ok:true, sessions:[同形行，已解析] }；前端空闲时
 *                               分批调用补标题，随时可中断（刷新/卸载即弃）。
 *   GET /api/session?id=<sid> → { ok:true, title, meta:{ cwd, agentPreset, effectivePreset }, requests:[摘要] }
 *   GET /api/part?id=<sid>&turn=<N>&part=system|messages
 *                             → { ok:true, part, text }        （text 超 40 万字符截断）
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
 */

import { createRequire } from 'node:module'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createByteBudgetedCache, estimateBytes } from './mem-budget.js'

/** system 段里固定检出的注入标记（与任务书给定的清单逐字一致）。 */
const MARKS = ['【当前状态】', 'recalledMemories', 'immediateHistory', 'storyAnchor', 'rp:policy', 'pmp-dsh-tavern', 'harness:identity']

/** /api/part 的 text 截断上限（字符）。 */
const MAX_TEXT_CHARS = 400000

/** 会话列表扫描缓存与 fs 索引的存活时间。 */
const SCAN_TTL_MS = 30000

/** /api/sessions/resolve 单次调用最多解析多少个会话（分批节奏由客户端控制）。 */
const RESOLVE_BATCH_LIMIT = 10

/** 部署可变项；都可从 cordis.patch.yml 的 config 覆盖。 */
const DEFAULTS = {
  /** 会话根目录。 */
  sessionsRoot: '',
  /** DSH 运行时模块目录（createRequire 的解析起点）。 */
  runtimeDsh: '',
  /** 宿主 webServer 上的挂载前缀。 */
  webPath: '/magictarven/prompt',
  /** 列表最多收录多少个会话（按 mtime 倒序取前 N）。 */
  maxSessions: 100,
  /** 解析结果 LRU 容量（按会话文件的 路径+mtime+size 缓存）。
   *  P0 内存修复：8 → 3。实测单会话解析后驻留 ~130–190 MB，8 条最坏 ≈1.4 GB。 */
  parseCacheSize: 3,
  /** 解析缓存总字节上限（默认 96 MB）。单条解析结果就超限 ⇒ 不缓存、每次重新解析
   *  （实测 6.8 MB 压缩会话 ≈186 MB > 96 MB ⇒ 大会话永不驻留，内存有硬上界）。 */
  parseCacheMaxBytes: 96 * 1024 * 1024,
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
function summarizeHeader(ev, index) {
  const d = ev?.data ?? {}
  const hd = d.header ?? {}
  const cfgIn = hd.config ?? {}
  const system = typeof hd.system === 'string' ? hd.system : ''
  const toolsRaw = Array.isArray(hd.tools) ? hd.tools : []
  const tools = toolsRaw
    .map((t) => ({ name: String(t?.name ?? t?.function?.name ?? '?'), chars: JSON.stringify(t ?? {}).length }))
    .sort((a, b) => b.chars - a.chars)
  const head = {
    index,
    seq: typeof ev?.seq === 'number' ? ev.seq : null,
    reason: String(d.reason ?? ''),
    provider: String(cfgIn?.provider ?? ''),
    model: String(cfgIn?.model ?? ''),
    reasoningEffort: cfgIn?.reasoningEffort == null ? '' : String(cfgIn.reasoningEffort),
    maxTokens: typeof cfgIn?.maxTokens === 'number' ? cfgIn.maxTokens : null,
    systemChars: system.length,
    toolCount: toolsRaw.length,
    toolChars: tools.reduce((n, t) => n + t.chars, 0),
    marks: MARKS.filter((m) => system.includes(m)),
    topTools: tools.slice(0, 8),
  }
  return { head, system, tools }
}

/**
 * 数据源：DSH 运行时持久化模块的惰性加载 + 会话解析缓存 + fs 扫描索引。
 * 单独导出工厂，是为了测试可以在不启 DSH 的情况下构造它、指向 fixture 根目录。
 * @param {Record<string, unknown>|undefined} rawConfig - 任意形态的配置；
 *   内部先过一遍 resolveConfig，外部调用方不需要自己补默认值。
 */
export function createSessionSource(rawConfig) {
  const cfg = resolveConfig(rawConfig)
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
    const { persistence } = await getStack()
    const loaded = await persistence.load(sessionId)
    const events = Array.isArray(loaded?.events) ? loaded.events : []
    if (loaded == null || events.length === 0) throw new Error(`会话日志为空或不可读：${sessionId}`)

    // meta.agentPreset 只是建会话时的值；中途 agent-preset/selected 换过的话它会说谎 ——
    // 必须取最后一次选择的 agentPreset（与 Session 投影同一套语义）。
    const selections = events
      .filter((ev) => ev?.type === 'agent-preset/selected')
      .map((ev) => ev?.data?.agentPreset)
    const effectivePreset = selections.length > 0 ? selections[selections.length - 1] : loaded.meta?.agentPreset

    const requests = []
    let title = ''
    const messageLines = []
    for (const ev of events) {
      if (ev?.type === 'request/header') {
        requests.push(summarizeHeader(ev, requests.length + 1))
        continue
      }
      if (ev?.type === 'user/message' || ev?.type === 'assistant/message') {
        const blocks = ev.type === 'user/message' ? ev.data?.content : ev.data?.message?.content
        const text = blocksText(blocks)
        messageLines.push(`── [seq ${typeof ev.seq === 'number' ? ev.seq : '?'}] ${ev.type === 'user/message' ? 'user' : 'assistant'} ──\n${text}`)
        if (!title && text) title = text.replace(/\s+/g, ' ').trim().slice(0, 60)
      }
    }

    return {
      meta: {
        cwd: loaded.meta?.cwd == null ? '' : String(loaded.meta.cwd),
        agentPreset: loaded.meta?.agentPreset == null ? '' : String(loaded.meta.agentPreset),
        effectivePreset: effectivePreset == null ? '' : String(effectivePreset),
      },
      title,
      requests,
      messagesText: messageLines.join('\n\n'),
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
        `[magictarven] 会话解析结果 ~${mb} MB 超过 parseCacheMaxBytes ${Math.round(cfg.parseCacheMaxBytes / (1024 * 1024))} MB，不缓存（每次重新解析）：…${String(sessionId ?? '').slice(-8)}`,
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
        const path = join(wsDir, s.name, 'session.jsonl.zstd')
        let st
        try {
          st = statSync(path)
        } catch {
          continue
        }
        if (!st.isFile()) continue
        rows.push({ id: s.name, workspace: ws.name, path, sizeBytes: st.size, mtimeMs: st.mtimeMs })
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
   * 索引里不存在的 id 直接跳过；单个会话解析失败降级 title=''/requests=0，不拖垮整批。
   * @param {string[]} ids - 会话 id 列表
   */
  async function resolveSessions(ids) {
    const byId = new Map(scanIndex().map((row) => [row.id, row]))
    const out = []
    for (const id of ids) {
      const row = byId.get(id)
      if (!row) continue
      let title = ''
      let requests = 0
      try {
        const parsed = await parsedFor(row)
        title = parsed.title
        requests = parsed.requests.length
      } catch {
        // 单个会话坏掉不拖垮整批：title='' / requests=0。
      }
      out.push({
        id: row.id,
        workspace: row.workspace,
        sizeBytes: row.sizeBytes,
        mtime: new Date(row.mtimeMs).toISOString(),
        title,
        requests,
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

  /** 释放持久化栈（尽力而为）。 */
  async function stop() {
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

  return { scanIndex, listSessions, resolveSessions, sessionDetail, forget, stop }
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

async function sessionsApi(source, params) {
  if (params.get('refresh') === '1') source.forget?.()
  const sessions = await source.listSessions()
  return { ok: true, sessions }
}

async function sessionsResolveApi(source, params) {
  const ids = (params.get('ids') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '')
  if (ids.length === 0) return { ok: false, error: '缺少 ids 参数（逗号分隔的会话 id）' }
  if (ids.length > RESOLVE_BATCH_LIMIT) {
    return { ok: false, error: `ids 一次最多 ${RESOLVE_BATCH_LIMIT} 个（收到 ${ids.length} 个）` }
  }
  const sessions = await source.resolveSessions(ids)
  return { ok: true, sessions }
}

async function sessionApi(source, params) {
  const id = params.get('id') ?? ''
  if (!id) return { ok: false, error: '缺少 id 参数' }
  const found = await source.sessionDetail(id)
  if (!found) return { ok: false, error: `会话不存在：${id}` }
  return {
    ok: true,
    title: found.parsed.title,
    meta: found.parsed.meta,
    requests: found.parsed.requests.map((r) => r.head),
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
  const found = await source.sessionDetail(id)
  if (!found) return { ok: false, error: `会话不存在：${id}` }
  const request = found.parsed.requests[turn - 1]
  if (!request) {
    return { ok: false, error: `没有第 ${turn} 次请求（共 ${found.parsed.requests.length} 次）` }
  }
  if (part === 'system') return { ok: true, part, text: clipText(request.system) }
  if (part === 'messages') return { ok: true, part, text: clipText(found.parsed.messagesText) }
  // tools / inventory：同一份 per-tool 清单（已按字符数降序），列表/分组视图由客户端决定。
  return { ok: true, part, tools: request.tools }
}

/**
 * HTTP 路由。抽成工厂与 createSessionSource 一样是为了测试：临时 server 可以
 * 直接挂这个 handler，不需要启动 DSH。
 * @param {Record<string, unknown>|undefined} rawConfig - 任意形态的配置；
 *   内部先过一遍 resolveConfig，外部调用方（验收脚本、单独测 handler 的人）
 *   传 `{}` 甚至 undefined 都能拿到全部默认值。
 */
export function createHandler(rawConfig) {
  const cfg = resolveConfig(rawConfig)
  const source = createSessionSource(cfg)
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
        body = await sessionsApi(source, url.searchParams)
      } else if (path === '/api/sessions/resolve') {
        body = await sessionsResolveApi(source, url.searchParams)
      } else if (path === '/api/session') {
        body = await sessionApi(source, url.searchParams)
      } else if (path === '/api/part') {
        body = await partApi(source, url.searchParams)
      } else {
        body = {
          ok: false,
          error: 'not found',
          hint: 'GET /health | /api/sessions | /api/sessions/resolve?ids=<id,… ≤10> | /api/session?id= | /api/part?id=&turn=&part=system|tools|messages|inventory',
        }
      }
    } catch (error) {
      // 解析失败（文件坏、模块加载不了、参数怪）绝不抛出 —— 统一降级为 ok:false。
      body = { ok: false, error: String((error && error.message) || error) }
    }
    sendJson(res, body)
  }
}
