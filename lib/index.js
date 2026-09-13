/**
 * magictarven —— 宿主半侧
 *
 * 职责（规格：《GLM任务-记忆库-v4-宿主半侧.md》，接口契约冻结）：
 *   1) 配置存储：用户自配 API（baseURL/key/model）+ 根模式，落盘到
 *      `<DSH_HOME | ~/.dsh>/magictarven/config.json`（原子写、0600、读坏回落默认值）。
 *   2) HTTP API：注册两条 prefix 路由 —— `/magictarven/api`（读写配置、测连通、
 *      精确读 DSH 会话事件、提示词模板 /templates、健康自检）与 `/magictarven/prompt`
 *      （并入的 dsh-prompt-viewer 宿主半侧，实现见 ./prompt-viewer.js）。
 *   3) 提示词模板：压缩指令与占位前言存进配置可选段 prompts（null = 内置默认），
 *      只经 /templates 读写，GET/PUT /config 的既有契约不变。
 *   4) v4.1：GET /sessions 每行追加 cwd / origin 两个字段（来自 record.header，
 *      取不到为 null）—— 客户端查看器用它解析工作区真名、识别子会话；
 *      ⛔ 老字段（sessionId/title/updatedAt）、?titles=0 快路径、titles=1 语义、
 *      排序与错误码全部原样不动。
 *   5) v5 P0（Agent 编辑器·只读）：GET /agent 与 GET /agent/detect —— 只读 preset
 *      （优先 ctx.agentPresets 服务，退回扫 ~/.dsh/.agent-presets/ 目录）与记忆库根状态，
 *      返回组成/可写性/绑定检查与「生成/修复 RP agent」的检测预览。⛔ 本节零写入
 *      （连备份目录都不创建）；拿不到服务一律 HTTP 200 + ok:false + 可读 code，
 *      绝不抛、绝不 500；既有 rest 契约一字不动。
 *   6) v5 P1a（真落盘 + 联动）：POST /agent/apply 与 GET /agent/backups —— 把 P0 的
 *      「生成/修复 RP agent」从只读预览升级为真写入。写入面全部在 ./rp-agent.js：
 *      可注入 presetsRoot（默认 DSH_HOME/homedir() 推，禁写死绝对路径）、三条硬拒绝
 *      （trust==='user' / 白名单 id / 不碰部署 preset）、四步写入（备份→原子写→回读校验→
 *      不一致自动回滚）、保注释的 customInstruction 定点替换（⛔ 禁止整份重写）、
 *      dma-binding.json 根绑定。dryRun:true 一个字节都不写。一律 HTTP 200、错误放 body。
 *   7) v5 P2：POST /agent/rollback —— 一键回滚到 .dma-backup/ 里的指定备份。写法全部
 *      复用 ./rp-agent.js 的 restoreFromBackup：三条硬拒绝 + backupFile 目录穿越防御
 *      （只认纯文件名）+ 回滚前先把当前文件再备份一次（回滚本身可再回滚）+ 原子写与
 *      逐字节回读校验。dryRun:true 零写入。一律 HTTP 200、错误放 body，绝不抛、绝不 500。
 *
 * 硬约束：
 *   - 会话读取只用「精确读 + 便宜路径」：listSessions / readSession / filterEvents / listEvents。
 *     ⛔ 绝不调 searchSessions / searchEvents（会触发全量索引对账，实测 88s / 2GB，拖住宿主）。
 *   - readSession 只吃一个参数、返回全量事件（SessionLogSnapshot{session,events}），分页在本地切片；
 *     surface 首选 filterEvents(id,[])（空过滤=全量，document 带 surface+正文），兜底 listEvents 按 seq 对齐。
 *   - 性能：/session/events 的派生行走 LRU 缓存（≤3 会话、TTL 20s、?refresh=1 绕过，
 *     总字节上限默认 128 MB —— 单会话超限就不缓存，见 ./mem-budget.js 与
 *     EVENTS_CACHE_MAX_BYTES）；/sessions 默认不做 title 投影（?titles=1 才做，
 *     结果同样短 TTL）。
 *   - 只用 node: 内置模块，零 npm 依赖；不导出 Config schema。
 *   - 任何服务缺失都不让 apply 抛错；handler 内异常一律收口为 500 INTERNAL。
 *   - api.key 绝不回显原文（只回 keySet/keyHint），任何响应/日志都不出现 key。
 */

import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const name = 'magictarven'

/**
 * 不写死服务依赖：webServer 用「有就注册、没有就跳过」，sessionQuery 在请求时按需
 * ctx.get —— 两者缺失时插件都要能 apply 成功（宿主启动不能被本插件拖死）。
 */
export const inject = []

const API_PREFIX = '/magictarven/api'
const PROMPT_PREFIX = '/magictarven/prompt' // 并入的提示词查看器（./prompt-viewer.js）
const TEMPLATES_MAX_CHARS = 20000 // 单个提示词模板的字符上限
const PLUGIN_DIR_NAME = 'magictarven'
const CONFIG_FILE_NAME = 'config.json'
const CONFIG_SCHEMA_VERSION = 1
const BODY_LIMIT = 64 * 1024
const TEST_TIMEOUT_MS = 15_000
const TAVERN_PROBE_PATH = '/pmp-dsh-tavern/api/v2/workspace/files?list='
const TAVERN_PROBE_TIMEOUT_MS = 3_000
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const KEY_CLEAR = '__CLEAR__'
const EVENTS_CACHE_TTL_MS = 20_000 // 事件行缓存 TTL（规格 §3a 默认 20 秒）
const SESSIONS_TITLES_TTL_MS = 20_000 // /sessions?titles=1 投影结果用同样的短 TTL
const MAX_CACHED_SESSIONS = 3 // 事件行 LRU 容量：大会话单份行数组可达上百 MB，必须设上限
// 事件行缓存总字节上限（默认 128 MB）。P0 内存修复：原来只按条数限容，实测单会话
// 解析后驻留 ~130–190 MB，条数上限拦不住字节量 ⇒ 单会话行就超上限的【不缓存】
// （该会话每次都重新取，慢但内存安全）。经 createByteBudgetedCache 生效。
const EVENTS_CACHE_MAX_BYTES = 128 * 1024 * 1024

// ---------------------------------------------------------------------------
// 并入的提示词查看器（./prompt-viewer.js）：模块顶层预加载
// ---------------------------------------------------------------------------

// 宿主 loader 用 `await import(entry)` 加载本入口，模块顶层 await 在 apply 被调用之前
// 就已求值完成 ⇒ 两条路由可以在 apply 内【同一轮同步】注册。ctx.effect 是 fiber 生命
// 周期的一部分，必须在 apply 调用栈内执行；若等 apply 返回后再进微任务注册，effect
// 挂不上 fiber（热重载 dispose 不掉 ⇒ 野路由），甚至被 cordis 拒绝 ⇒ 第二条路由静默
// 消失。加载失败只记下错误、降级不注册第二条，绝不抛。
let promptViewerFactory = null
let promptViewerLoadError = null
try {
  const mod = await import('./prompt-viewer.js')
  promptViewerFactory = typeof mod.createHandler === 'function' ? mod.createHandler : null
  if (promptViewerFactory === null) {
    promptViewerLoadError = new Error('prompt-viewer.js 未导出 createHandler')
  }
} catch (e) {
  promptViewerLoadError = e
}

// mem-budget（./mem-budget.js，P0 内存修复的共用字节预算工具）：与 prompt-viewer
// 同样的顶层守卫加载 —— 它缺席时本模块必须照常可加载、apply 照常注册路由
// （降级语义：服务缺失仍可用）。此时事件缓存整体禁用（一个字节都不缓存，
// 比没有字节上限的旧 Map 更安全），/session/events 每次重新取，慢但可用。
let memBudget = null
let memBudgetLoadError = null
try {
  memBudget = await import('./mem-budget.js')
} catch (e) {
  memBudgetLoadError = e
}

// rp-agent（./rp-agent.js，v5 P1a 真落盘写入面 + v5 P2 一键回滚）：与上面同样的顶层守卫加载 ——
// 它缺席时 /agent/apply、/agent/backups、/agent/rollback 三条 rest 降级为可读错误
// （HTTP 200 + ok:false），其余全部 rest 与插件加载完全不受影响。
let rpAgent = null
let rpAgentLoadError = null
try {
  rpAgent = await import('./rp-agent.js')
} catch (e) {
  rpAgentLoadError = e
}

// ---------------------------------------------------------------------------
// 配置存储
// ---------------------------------------------------------------------------

/** 照抄 tavern-loader storage-location.js 的官方约定（含 ~ 展开）。 */
function expandHome(p, home = homedir()) {
  if (p === '~') return home
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2))
  return p
}

function storageDir(env = process.env) {
  const configured = env.DSH_HOME
  const dshHome =
    configured !== undefined && String(configured).trim() !== ''
      ? String(configured)
      : join(homedir(), '.dsh')
  return join(resolve(expandHome(dshHome)), PLUGIN_DIR_NAME)
}

function configPath() {
  return join(storageDir(), CONFIG_FILE_NAME)
}

function defaultConfig() {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    rootMode: 'session', // 'session'（默认，纯 DSH）| 'workspace'（Tavern 环境）
    root: { sessionId: null, characterId: null, playthroughId: null },
    api: { url: '', model: '', key: '' },
    // 提示词模板：null = 内置默认（见 templatesResponse）；字符串 = 用户自定义。
    // 只经 /templates 读写；老配置没有这段时 sanitizeConfig 会补齐。
    prompts: { compaction: null, placeholder: null },
  }
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 只保留已知字段；类型不对的字段回落默认值并记入 issues（不静默吞）。 */
function sanitizeConfig(parsed) {
  const issues = []
  const config = defaultConfig()
  if (!isPlainObject(parsed)) {
    issues.push('顶层不是 JSON 对象，已整体回落默认值')
    return { config, issues }
  }
  if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    issues.push(`schemaVersion=${JSON.stringify(parsed.schemaVersion)} 不是 ${CONFIG_SCHEMA_VERSION}`)
  }
  if (parsed.rootMode !== undefined) {
    if (parsed.rootMode === 'session' || parsed.rootMode === 'workspace') config.rootMode = parsed.rootMode
    else issues.push('rootMode 非法，已回落 "session"')
  }
  if (parsed.root !== undefined) {
    if (isPlainObject(parsed.root)) {
      for (const k of ['sessionId', 'characterId', 'playthroughId']) {
        const v = parsed.root[k]
        if (v === undefined || v === null) continue
        if (typeof v === 'string' && v !== '') config.root[k] = v
        else issues.push(`root.${k} 类型异常，已置 null`)
      }
    } else issues.push('root 不是对象，已回落默认值')
  }
  if (parsed.api !== undefined) {
    if (isPlainObject(parsed.api)) {
      for (const k of ['url', 'model', 'key']) {
        const v = parsed.api[k]
        if (v === undefined) continue
        if (typeof v === 'string') config.api[k] = v
        else issues.push(`api.${k} 不是字符串，已置空`)
      }
    } else issues.push('api 不是对象，已回落默认值')
  }
  if (parsed.prompts !== undefined) {
    if (isPlainObject(parsed.prompts)) {
      for (const k of ['compaction', 'placeholder']) {
        const v = parsed.prompts[k]
        if (v === undefined || v === null) continue // null = 内置默认
        if (typeof v === 'string' && v !== '') config.prompts[k] = v
        else if (v !== '') issues.push(`prompts.${k} 不是字符串，已置 null`) // 空串 = 默认，静默归一
      }
    } else issues.push('prompts 不是对象，已回落默认值')
  }
  return { config, issues }
}

/** 读配置：不存在 → 默认值；解析失败/类型不对 → 默认值 + configError（如实上报）。 */
function readConfigFile() {
  const path = configPath()
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return { config: defaultConfig(), configError: null }
    return { config: defaultConfig(), configError: `读取配置失败：${err?.message || err}` }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { config: defaultConfig(), configError: '配置文件不是合法 JSON，已回落默认值' }
  }
  const { config, issues } = sanitizeConfig(parsed)
  return { config, configError: issues.length ? `配置字段异常已回落：${issues.join('；')}` : null }
}

/** 原子写：tmp → rename 覆盖；权限收 0600（Windows 上 chmod 近似 no-op，不视为失败）。 */
function writeConfigFile(config) {
  const dir = storageDir()
  mkdirSync(dir, { recursive: true })
  const finalPath = join(dir, CONFIG_FILE_NAME)
  const tmpPath = finalPath + '.tmp'
  writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
  try {
    chmodSync(tmpPath, 0o600)
  } catch {}
  renameSync(tmpPath, finalPath)
  try {
    chmodSync(finalPath, 0o600)
  } catch {}
}

/** PUT 合并 + 校验；校验失败抛 {code:'CONFIG_INVALID'}。未知字段一律丢弃。 */
function mergeConfig(current, patch) {
  const fail = (message) => {
    const e = new Error(message)
    e.code = 'CONFIG_INVALID'
    throw e
  }
  if (!isPlainObject(patch)) fail('请求体必须是 JSON 对象')
  const next = JSON.parse(JSON.stringify(current))
  if (patch.rootMode !== undefined) {
    if (patch.rootMode !== 'session' && patch.rootMode !== 'workspace') {
      fail('rootMode 只接受 "session" 或 "workspace"')
    }
    next.rootMode = patch.rootMode
  }
  if (patch.root !== undefined) {
    if (!isPlainObject(patch.root)) fail('"root" 必须是对象')
    for (const k of ['sessionId', 'characterId', 'playthroughId']) {
      if (patch.root[k] === undefined) continue
      const v = patch.root[k]
      next.root[k] = typeof v === 'string' && v !== '' ? v : null
    }
  }
  if (patch.api !== undefined) {
    if (!isPlainObject(patch.api)) fail('"api" 必须是对象')
    if (patch.api.url !== undefined) {
      if (patch.api.url !== null && typeof patch.api.url !== 'string') fail('"api.url" 必须是字符串')
      const u = patch.api.url ?? ''
      if (u !== '' && !/^https?:\/\//i.test(u)) fail('"api.url" 必须以 http:// 或 https:// 开头')
      next.api.url = u
    }
    if (patch.api.model !== undefined) {
      if (patch.api.model !== null && typeof patch.api.model !== 'string') fail('"api.model" 必须是字符串')
      next.api.model = patch.api.model ?? ''
    }
    if (patch.api.key !== undefined) {
      if (typeof patch.api.key !== 'string') fail('"api.key" 必须是字符串')
      if (patch.api.key === KEY_CLEAR) next.api.key = ''
      else if (patch.api.key !== '') next.api.key = patch.api.key // 空串 = 保留原有 key
    }
  }
  return next
}

/** key 提示：最多露尾 4 位；过短的 key 一位都不露。 */
function keyHint(key) {
  if (!key) return null
  if (key.length < 8) return '…'
  return '…' + key.slice(-4)
}

/** GET/PUT /config 的统一响应（绝不回显 api.key 原文）。 */
function publicConfig(config, configError) {
  return {
    ok: true,
    rootMode: config.rootMode,
    api: { url: config.api.url, model: config.api.model },
    keySet: Boolean(config.api.key),
    keyHint: keyHint(config.api.key),
    storageDir: storageDir(),
    configPath: configPath(),
    configError: configError ?? null,
  }
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function err(code, message) {
  return { ok: false, error: { code, message } }
}

function toInt(v, dflt) {
  // 缺参/空串回默认值（Number(null)===0 的坑：不能让「没传」变成 0）
  if (v === null || v === undefined) return dflt
  const s = String(v).trim()
  if (s === '') return dflt
  const n = Number(s)
  return Number.isFinite(n) ? Math.trunc(n) : dflt
}

function getService(ctx, serviceName) {
  try {
    if (ctx && typeof ctx.get === 'function') return ctx.get(serviceName)
  } catch {}
  return undefined
}

function makeLog(ctx) {
  const l = ctx && ctx.logger
  const emit = (level, msg) => {
    try {
      if (l && typeof l[level] === 'function') l[level](String(msg))
    } catch {}
  }
  return {
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
  }
}

/** 错误信息出境前把配置中的 key 原文抹掉（双保险，正常路径本就不含 key）。 */
function makeRedactor() {
  return (text) => {
    let s = String(text ?? '')
    try {
      const k = readConfigFile().config.api.key
      if (k) s = s.split(k).join('***')
    } catch {}
    return s
  }
}

function readBody(req, cap) {
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
        const e = new Error('payload too large')
        e.code = 'PAYLOAD_TOO_LARGE'
        rejectP(e)
        req.resume() // 丢弃余量，让连接自然收尾
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

// ---------------------------------------------------------------------------
// 会话精确读 + 便宜路径（⛔ 只用 listSessions / readSession / filterEvents /
// listEvents / readTitleSnapshots，绝不碰 searchSessions / searchEvents）
// ---------------------------------------------------------------------------

function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v !== '') return v
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return null
}

function firstTime(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) return v
  }
  return null
}

function extractEvents(raw) {
  if (Array.isArray(raw)) return { events: raw, total: null }
  if (isPlainObject(raw)) {
    if (Array.isArray(raw.events)) {
      return { events: raw.events, total: typeof raw.total === 'number' ? raw.total : null }
    }
    const s = raw.session
    if (isPlainObject(s) && Array.isArray(s.events)) {
      const total =
        typeof s.total === 'number' ? s.total : typeof raw.total === 'number' ? raw.total : null
      return { events: s.events, total }
    }
  }
  return null
}

/** 只取正文文本；工具调用等取不到就 ""，绝不把 JSON 塞进 text。 */
function extractText(raw) {
  const candidates = [
    raw.text,
    raw.content,
    isPlainObject(raw.message) ? raw.message.content : undefined,
  ]
  for (const c of candidates) {
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      const parts = []
      for (const b of c) {
        if (isPlainObject(b) && typeof b.text === 'string') parts.push(b.text)
      }
      if (parts.length) return parts.join('')
    }
  }
  return ''
}

/** surface 三态：只接受原始数据如实携带的值，绝不从 type 推断。 */
function validSurface(v) {
  return v === 'current' || v === 'shadowed' || v === 'log-only' ? v : null
}

/**
 * surface 只在原始事件如实携带时才填（'current'/'shadowed'/'log-only'），
 * 拿不到就是 null —— 宁可 null，不许编造。
 */
function normalizeEvent(raw, fallbackSeq) {
  const out = { seq: fallbackSeq, type: null, time: null, role: null, text: '', surface: null }
  if (!isPlainObject(raw)) return out
  for (const k of ['seq', 'index', 'eventIndex']) {
    if (typeof raw[k] === 'number' && Number.isFinite(raw[k])) {
      out.seq = raw[k]
      break
    }
  }
  for (const k of ['type', 'kind', 'event', 'eventType']) {
    if (typeof raw[k] === 'string' && raw[k] !== '') {
      out.type = raw[k]
      break
    }
  }
  out.time = firstTime(raw.time, raw.timestamp, raw.createdAt, raw.created_at, raw.at)
  const role =
    typeof raw.role === 'string'
      ? raw.role
      : isPlainObject(raw.message) && typeof raw.message.role === 'string'
        ? raw.message.role
        : null
  if (role === 'user' || role === 'assistant') out.role = role
  out.text = extractText(raw)
  out.surface = validSurface(raw.surface)
  return out
}

// ---------------------------------------------------------------------------
// HTTP 各端点实现
// ---------------------------------------------------------------------------

async function handlePutConfig(req, send, redact) {
  const ct = String((req.headers && req.headers['content-type']) || '')
  if (!ct.toLowerCase().includes('application/json')) {
    return send(415, err('UNSUPPORTED_MEDIA_TYPE', '只接受 application/json'))
  }
  let bodyBuf
  try {
    bodyBuf = await readBody(req, BODY_LIMIT)
  } catch (e) {
    if (e && e.code === 'PAYLOAD_TOO_LARGE') {
      return send(413, err('PAYLOAD_TOO_LARGE', `请求体超过 ${BODY_LIMIT} 字节上限`))
    }
    throw e
  }
  let patch
  try {
    patch = JSON.parse(bodyBuf.toString('utf8'))
  } catch {
    return send(400, err('CONFIG_INVALID', '请求体不是合法 JSON'))
  }
  try {
    const { config: current } = readConfigFile()
    const next = mergeConfig(current, patch)
    writeConfigFile(next)
    // 回读校验：确认盘上就是刚写的值
    const reread = readConfigFile()
    if (
      reread.config.rootMode !== next.rootMode ||
      reread.config.api.url !== next.api.url ||
      reread.config.api.model !== next.api.model
    ) {
      return send(500, err('CONFIG_WRITE_UNVERIFIED', '写盘后回读校验不一致'))
    }
    return send(200, publicConfig(reread.config, reread.configError))
  } catch (e) {
    if (e && e.code === 'CONFIG_INVALID') return send(400, err('CONFIG_INVALID', redact(e.message)))
    throw e
  }
}

async function handleTestConfig(send, redact) {
  const { config } = readConfigFile()
  const { url, model, key } = config.api
  if (!url || !model || !key) {
    return send(400, err('CONFIG_INCOMPLETE', '缺少 api.url / api.model / api.key，请先在设置里补全'))
  }
  const started = Date.now()
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 16,
        stream: false,
      }),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    })
    const elapsedMs = Date.now() - started
    if (!resp.ok) {
      // 测不通是预期结果，不是服务器错误：照 Tavern 约定用 HTTP 200 + ok:false
      let detail = ''
      try {
        detail = (await resp.text()).slice(0, 200)
      } catch {}
      return send(
        200,
        Object.assign(
          err('API_ERROR', `API 返回 HTTP ${resp.status}${detail ? '：' + redact(detail) : ''}`),
          { httpStatus: resp.status, elapsedMs },
        ),
      )
    }
    let content = ''
    try {
      const data = await resp.json()
      const c = isPlainObject(data) && isPlainObject(data.choices?.[0]?.message) ? data.choices[0].message.content : undefined
      if (typeof c === 'string') content = c
      else if (Array.isArray(c)) {
        content = c.map((b) => (isPlainObject(b) && typeof b.text === 'string' ? b.text : '')).join('')
      }
    } catch {}
    return send(200, {
      ok: true,
      model,
      httpStatus: resp.status,
      elapsedMs,
      replyPreview: content.slice(0, 120), // 不整段回显：可能很长/含隐私
    })
  } catch (e) {
    const elapsedMs = Date.now() - started
    const timedOut =
      e?.name === 'TimeoutError' || e?.name === 'AbortError' || /timed?\s*out/i.test(e?.message || '')
    return send(
      200,
      Object.assign(
        timedOut
          ? err('TIMEOUT', `请求超时（${Math.round(TEST_TIMEOUT_MS / 1000)} 秒）`)
          : err('NETWORK_ERROR', redact(e?.message || String(e))),
        { elapsedMs },
      ),
    )
  }
}

// ---------------------------------------------------------------------------
// 提示词模板（GET/PUT /templates；存配置可选段 prompts，只经这两个端点读写，
// /config 的既有契约不变）
// ---------------------------------------------------------------------------

/** 内置中文 RP 归档指令（规格 §3.4，逐字照抄，勿改一字）。 */
const BUILTIN_COMPACTION_ZH = `你在为一个中文角色扮演长会话生成「历史归档条目」。这段历史会被移出模型上下文，
之后可通过记忆检索取回，所以**不需要保留文风与细节，只需要让未来的检索能找回它**。

输出严格用下面的结构，每节都要有，空的写 "(无)"：

## 时间跨度
（故事内时间，起 → 止）

## 地点
（发生过哪些场景）

## 涉及角色
（每个角色：名字 + 这段里他/她做了什么）

## 关键事件
（3–8 条，每条一行；保留**具体数值/物品名/地名/专有名词**，不要改写）

## 未回收的伏笔
（0–3 条；没有就写 (无)）

规则：
- 用**中文**写。保留原文里的专有名词、数字、物品名，逐字照抄，不要"整理"。
- 不要写文风描写、不要复述对话、不要评价。
- 不要提到"压缩""摘要""上下文"这些词。
- 只输出这个结构本身，不要任何前后语。`

/** 内置英文 RP 归档指令（规格 §3.4，逐字照抄，勿改一字）。 */
const BUILTIN_COMPACTION_EN = `You are writing a HISTORY ARCHIVE ENTRY for a long roleplay session. This slice of
history is about to leave the model context; it can be retrieved later through memory
search, so it does NOT need prose style or detail — it only needs to be FINDABLE.

Output exactly this structure, every section present, empty ones as "(none)":

## Time span
(in-story time, from → to)

## Locations
(which scenes took place)

## Characters
(each: name + what they did in this slice)

## Key events
(3-8 bullets, one line each; keep exact numbers, item names, place names, proper nouns verbatim)

## Open threads
(0-3 bullets; "(none)" if empty)

Rules:
- Keep proper nouns, numbers, and item names from the source verbatim; do not rewrite them.
- Do not write prose description, do not replay dialogue, do not evaluate.
- Never mention "compaction", "summary", or "context".
- Output only the structure itself, with no preamble or trailing remarks.`

/** 内置占位前言模板（{from}/{to} 为变量占位，另有 {cast} 备用；现在只存不改，规格 §3.4）。 */
const BUILTIN_PLACEHOLDER_ZH = `这是一段自动生成的历史归档：此前 {from}–{to} 楼的对话已被收入记忆库并从上下文移出。请把其中记录的内容当作既成背景，直接在此基础上继续，不要复述、也不要回应这段归档本身，从随后的消息继续推进。`

// 来源：DSH 官方 packages/compaction/compaction-basic/src/summarizer.ts:31-66
// （MIT, Copyright (c) 2026 DeepSeek），仅作对照展示。
const OFFICIAL_COMPACTION = `You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.

Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.

## Primary Request and Intent
- [the user's original and evolving goals; quote verbatim where the exact wording matters]

## Key Technical Concepts
- [technologies, frameworks, patterns, and conventions in play]

## Files and Code
- [exact path: why it matters, key changes or snippets]

## Errors and Fixes
- [error: how it was resolved, plus any related user feedback]

## Pending Jobs
- [explicitly requested work not yet completed]

## Current Work
- [precisely what was in progress at this checkpoint]

## Next Step
- [the single next action, directly in line with the most recent request, or "(none)"]

## Critical Context
- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]

Rules:
- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.
- Capture user feedback and explicit instructions faithfully, especially corrections.
- Do NOT mention this summarization request or that the context was compacted.
- Output only the checkpoint text: do not call any tool or take any other action.
- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`

// 来源：同上 summarizer.ts:69-70。官方 frameSummary() 的完整形状是「前言 + 两个换行 +
// <compacted-summary>」放在最前、摘要正文居中、</compacted-summary> 收尾（仅注释，不进响应体）。
const OFFICIAL_PREAMBLE = `This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.`

/** GET /templates：custom = 用户自定义；current = 自定义优先，否则 = builtin。 */
function templatesResponse() {
  const { config } = readConfigFile()
  const prompts = config.prompts
  const compactionCustom = typeof prompts.compaction === 'string' && prompts.compaction !== ''
  const placeholderCustom = typeof prompts.placeholder === 'string' && prompts.placeholder !== ''
  return {
    ok: true,
    templates: {
      compaction: {
        current: compactionCustom ? prompts.compaction : BUILTIN_COMPACTION_ZH,
        custom: compactionCustom,
        builtin: BUILTIN_COMPACTION_ZH,
        builtinEn: BUILTIN_COMPACTION_EN,
      },
      placeholder: {
        current: placeholderCustom ? prompts.placeholder : BUILTIN_PLACEHOLDER_ZH,
        custom: placeholderCustom,
        builtin: BUILTIN_PLACEHOLDER_ZH,
      },
    },
    reference: {
      officialCompaction: OFFICIAL_COMPACTION,
      officialPreamble: OFFICIAL_PREAMBLE,
    },
  }
}

/**
 * PUT /templates：键缺失 = 不改；null/'' = 恢复内置默认（盘上存 null）；
 * 非字符串 / 单段超 20000 字符 = 400 CONFIG_INVALID；未知键一律丢弃。
 * 原子写 + 0600 + 回读校验；成功响应 = 写完之后的 GET /templates 同形状。
 */
async function handlePutTemplates(req, send, redact) {
  let bodyBuf
  try {
    bodyBuf = await readBody(req, BODY_LIMIT)
  } catch (e) {
    if (e && e.code === 'PAYLOAD_TOO_LARGE') {
      return send(413, err('PAYLOAD_TOO_LARGE', `请求体超过 ${BODY_LIMIT} 字节上限`))
    }
    throw e
  }
  let patch
  try {
    patch = JSON.parse(bodyBuf.toString('utf8'))
  } catch {
    return send(400, err('CONFIG_INVALID', '请求体不是合法 JSON'))
  }
  if (!isPlainObject(patch)) return send(400, err('CONFIG_INVALID', '请求体必须是 JSON 对象'))
  const next = {}
  for (const k of ['compaction', 'placeholder']) {
    if (patch[k] === undefined) continue // 键缺失 = 不改该字段
    const v = patch[k]
    if (v === null || v === '') {
      next[k] = null
      continue
    }
    if (typeof v !== 'string') return send(400, err('CONFIG_INVALID', `"${k}" 必须是字符串或 null`))
    if (v.length > TEMPLATES_MAX_CHARS) {
      return send(400, err('CONFIG_INVALID', `"${k}" 超过 ${TEMPLATES_MAX_CHARS} 字符上限`))
    }
    next[k] = v
  }
  const { config: current } = readConfigFile()
  const merged = JSON.parse(JSON.stringify(current))
  merged.prompts = { ...merged.prompts, ...next }
  writeConfigFile(merged)
  // 回读校验：确认盘上就是刚写的值
  const reread = readConfigFile()
  for (const k of Object.keys(next)) {
    if ((reread.config.prompts[k] ?? null) !== next[k]) {
      return send(500, err('CONFIG_WRITE_UNVERIFIED', '写盘后回读校验不一致'))
    }
  }
  return send(200, templatesResponse())
}

/**
 * 便宜路径取 surface（+正文补齐）：首选 filterEvents(id, [])（空 filters = 不过滤，
 * 返回全部 document，既带 surface 又带正文）；兜底 listEvents(id) 的 {seq,surface}。
 * 任一方法不存在 / 抛错 / 返回形状不识 → 降到下一档，最终 surface=null。绝不抛。
 */
async function collectSurfaces(sq, sessionId) {
  const bySeq = new Map()
  const put = (seq, surface, text) => {
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return
    bySeq.set(seq, { surface: validSurface(surface), text: typeof text === 'string' ? text : '' })
  }
  if (typeof sq.filterEvents === 'function') {
    try {
      const docs = await sq.filterEvents(sessionId, [])
      const arr = Array.isArray(docs)
        ? docs
        : isPlainObject(docs) && Array.isArray(docs.documents)
          ? docs.documents
          : null
      if (arr) {
        for (const d of arr) {
          if (!isPlainObject(d)) continue
          put(d.seq, d.surface, extractText(d))
        }
        return bySeq
      }
    } catch {}
  }
  if (typeof sq.listEvents === 'function') {
    try {
      const recs = await sq.listEvents(sessionId)
      const arr = Array.isArray(recs)
        ? recs
        : isPlainObject(recs) && Array.isArray(recs.events)
          ? recs.events
          : null
      if (arr) {
        for (const r of arr) {
          if (!isPlainObject(r)) continue
          put(r.seq, r.surface, '')
        }
      }
    } catch {}
  }
  return bySeq
}

/** mem-budget 缺席时的兜底「黑洞」缓存：什么都不存，set 返回 true（成功假象，
 *  让 cachePutLru 别去刷「超字节上限」的误导性 warn —— 真正的原因已由模块顶层
 *  的 memBudgetLoadError warn 说清）。内存绝对安全，代价只是每次重新取。 */
function makeDisabledCache() {
  return {
    get: () => undefined,
    set: () => true,
    delete: () => false,
    get size() {
      return 0
    },
    get bytes() {
      return 0
    },
    clear() {},
  }
}

/**
 * LRU 读：命中刷新新近度（刷新由 mem-budget 的 get 完成）；过期即逐出并立即
 * 回收字节（mem-budget 的 delete）。
 */
function cacheGetLru(cache, key, now) {
  const hit = cache.get(key)
  if (hit === undefined) return null
  if (now >= hit.expires) {
    cache.delete(key)
    return null
  }
  return hit.rows
}

/**
 * LRU 写：条数上限 MAX_CACHED_SESSIONS + 总字节上限 EVENTS_CACHE_MAX_BYTES
 * （默认 128 MB，见常量处注释）。★ 单会话事件行就超字节上限 ⇒ 不缓存
 * （每次重新取，慢但内存安全），只 warn 一次这一次的事实，不刷屏。
 */
function cachePutLru(cache, key, rows, ttlMs, log) {
  if (cache.set(key, { rows, expires: Date.now() + ttlMs })) return
  log.warn(
    `[magictarven] /session/events sessionId=${String(key).slice(0, 24)} 事件行超过事件缓存字节上限 ${Math.round(EVENTS_CACHE_MAX_BYTES / (1024 * 1024))} MB，不缓存（每次重新取）`,
  )
}

async function handleSessions(ctx, url, send, redact, log, titlesCache) {
  const sq = getService(ctx, 'sessionQuery')
  if (!sq || typeof sq.listSessions !== 'function') {
    return send(503, err('SESSION_QUERY_UNAVAILABLE', '宿主未挂载 sessionQuery（或缺少 listSessions 方法），精确读会话不可用'))
  }
  // ?titles=0（默认）：不做 title 投影（69 会话逐个投影实测 9s），必须快
  const wantTitles = url.searchParams.get('titles') === '1'
  let data = null
  if (wantTitles && titlesCache.current && Date.now() < titlesCache.current.expires) {
    data = titlesCache.current.data
  } else {
    let raw
    try {
      raw = await sq.listSessions()
    } catch (e) {
      return send(500, err('SESSION_READ_FAILED', redact(e?.message || String(e))))
    }
    // SessionRecord 只有 {header, live, persisted}：id 在 record.header.id；
    // SessionHeader 只有 createdAt（没有 updatedAt），createdAt 只是 updatedAt 的退路
    const items = Array.isArray(raw) ? raw : isPlainObject(raw) && Array.isArray(raw.sessions) ? raw.sessions : null
    if (!items) return send(500, err('SESSION_READ_FAILED', 'listSessions 返回了无法识别的数据形状'))
    const sessions = items.map((item) => {
      const o = isPlainObject(item) ? item : {}
      const h = isPlainObject(o.header) ? o.header : {}
      return {
        sessionId: firstString(h.id, o.sessionId, o.id, o.uuid, o.session_id),
        title: null,
        updatedAt: wantTitles
          ? firstTime(h.createdAt, h.created_at, o.createdAt, o.updatedAt, o.updated_at, o.mtime)
          : null,
        // v4.1 只追加不改动：cwd（工作区真名线索）与 origin（'subagent' 子会话标记）。
        // 缺失 / 非字符串 / 空串一律 null —— 绝不因这两个字段抛错、绝不影响快路径。
        cwd: typeof h.cwd === 'string' && h.cwd !== '' ? h.cwd : null,
        origin: typeof h.origin === 'string' && h.origin !== '' ? h.origin : null,
      }
    })
    if (wantTitles) {
      // title 用 readTitleSnapshots 一次批量取；缺失/抛错/形状不识 → title=null（不许编造、不 500）
      const ids = sessions.map((s) => s.sessionId).filter(Boolean)
      if (ids.length && typeof sq.readTitleSnapshots === 'function') {
        try {
          const titleMap = extractTitleMap(await sq.readTitleSnapshots(ids), ids)
          for (const s of sessions) {
            const t = s.sessionId === null ? undefined : titleMap.get(s.sessionId)
            if (!t) continue
            if (t.title !== null) s.title = t.title
            if (t.updatedAt !== null) s.updatedAt = t.updatedAt // 标题事件时间戳优先于 createdAt
          }
        } catch {}
      }
      data = { ok: true, sessions }
      titlesCache.current = { data, expires: Date.now() + SESSIONS_TITLES_TTL_MS }
    } else {
      data = { ok: true, sessions }
    }
  }
  log.info(`[magictarven] /sessions titles=${wantTitles ? 1 : 0} 返回 ${data.sessions.length} 条`)
  return send(200, data)
}

/**
 * readTitleSnapshots 归一。★ 真实形状（session-query/src/types.ts:153-168）是 allSettled 风格数组：
 *   { sessionId, status:'fulfilled', value:{ session, title?:SessionTitleSnapshot } }
 *   { sessionId, status:'rejected',  reason }   ← 必须跳过，不许拿 null 覆盖
 * 标题字符串在 value.title.title（value.title 是对象），updatedAt 在 value.title.updatedAt
 * （session/src/session-title/types.ts:40-55）。旧形状（Map / 以 id 为键的对象 / 数组带 id）兜底；
 * 任何形状不识都不许抛。
 */
function extractTitleMap(snaps, ids) {
  const map = new Map() // id → { title: string|null, updatedAt: number|string|null }
  const put = (id, title, updatedAt) => {
    if (typeof id !== 'string' || id === '' || map.has(id)) return
    map.set(id, {
      title: typeof title === 'string' ? title : null,
      updatedAt:
        typeof updatedAt === 'string' || (typeof updatedAt === 'number' && Number.isFinite(updatedAt))
          ? updatedAt
          : null,
    })
  }
  const putSnapshot = (id, v) => {
    if (id === null || v === null || v === undefined) return
    if (isPlainObject(v)) {
      const snap = isPlainObject(v.title) ? v.title : null
      if (snap) put(id, snap.title, snap.updatedAt)
      else put(id, typeof v.title === 'string' ? v.title : null, null)
    } else if (typeof v === 'string') {
      put(id, v, null)
    }
  }
  if (Array.isArray(snaps)) {
    snaps.forEach((res, i) => {
      if (!isPlainObject(res)) return
      if (res.status !== undefined && res.status !== 'fulfilled') return // rejected：跳过，不覆盖
      const id = firstString(res.sessionId, res.id) ?? (snaps.length === ids.length ? ids[i] : null)
      putSnapshot(id, res.value)
    })
  } else if (typeof Map !== 'undefined' && snaps instanceof Map) {
    for (const [k, v] of snaps) putSnapshot(k, v)
  } else if (isPlainObject(snaps)) {
    for (const [k, v] of Object.entries(snaps)) putSnapshot(k, v)
  }
  return map
}

async function handleEvents(ctx, url, send, redact, log, eventsCache) {
  const sq = getService(ctx, 'sessionQuery')
  if (!sq || typeof sq.readSession !== 'function') {
    return send(503, err('SESSION_QUERY_UNAVAILABLE', '宿主未挂载 sessionQuery（或缺少 readSession 方法），精确读会话不可用'))
  }
  const sessionId = url.searchParams.get('sessionId')
  if (!sessionId) return send(400, err('INVALID_ARGUMENT', '缺少 sessionId 查询参数'))
  const limit = Math.min(MAX_LIMIT, Math.max(1, toInt(url.searchParams.get('limit'), DEFAULT_LIMIT)))
  const offset = Math.max(0, toInt(url.searchParams.get('offset'), 0))
  const refresh = url.searchParams.get('refresh') === '1'

  // 读整条日志一次 ~8s 量级（_corpus.load 全量重放）：命中缓存就完全不碰 sessionQuery
  if (!refresh) {
    const cached = cacheGetLru(eventsCache, sessionId, Date.now())
    if (cached) {
      log.info(
        `[magictarven] /session/events sessionId=${sessionId.slice(0, 24)} 缓存命中（total=${cached.length}，limit=${limit}，offset=${offset}）`,
      )
      return send(200, {
        ok: true,
        sessionId,
        total: cached.length,
        events: cached.slice(offset, offset + limit),
      })
    }
  }

  // readSession 只吃一个参数、返回全部事件：JS 多传实参不报错，分页必须本地切片
  let snapshot
  try {
    snapshot = await sq.readSession(sessionId)
  } catch (e) {
    return send(500, err('SESSION_READ_FAILED', redact(e?.message || String(e))))
  }
  const extracted = extractEvents(snapshot)
  if (!extracted) return send(500, err('SESSION_READ_FAILED', 'readSession 返回了无法识别的数据形状'))
  const rawEvents = extracted.events
  const total = rawEvents.length // 真实总数，不是本页条数

  const bySeq = await collectSurfaces(sq, sessionId)
  // 缓存的是「已派生好的轻量行」：{seq,type,time,role,text,surface}
  const rows = rawEvents.map((raw, i) => {
    const ev = normalizeEvent(raw, i)
    const seq = isPlainObject(raw) && typeof raw.seq === 'number' && Number.isFinite(raw.seq) ? raw.seq : null
    if (seq !== null && bySeq.has(seq)) {
      const extra = bySeq.get(seq)
      if (extra.surface) ev.surface = extra.surface // 权威来源覆盖
      if (!ev.text && extra.text) ev.text = extra.text // 快照缺正文时用 document 正文补
    }
    return ev
  })
  cachePutLru(eventsCache, sessionId, rows, EVENTS_CACHE_TTL_MS, log)
  log.info(
    `[magictarven] /session/events sessionId=${sessionId.slice(0, 24)} 返回 ${Math.min(limit, Math.max(0, total - offset))} 条（total=${total}，limit=${limit}，offset=${offset}，refresh=${refresh ? 1 : 0}）`,
  )
  return send(200, { ok: true, sessionId, total, events: rows.slice(offset, offset + limit) })
}

async function probeTavern(req) {
  try {
    const host = req && req.headers && req.headers.host
    const localPort = req && req.socket && req.socket.localPort
    const base = host
      ? `http://${host}`
      : `http://127.0.0.1${localPort ? ':' + localPort : ''}`
    // 可选依赖不 import，只靠 HTTP 探活；能连通即 true（不管状态码），任何失败 false
    await fetch(base + TAVERN_PROBE_PATH, {
      signal: AbortSignal.timeout(TAVERN_PROBE_TIMEOUT_MS),
      redirect: 'manual',
    })
    return true
  } catch {
    return false
  }
}

async function handleHealth(ctx, req, send) {
  const storageDirWritable = (() => {
    try {
      const dir = storageDir()
      mkdirSync(dir, { recursive: true })
      accessSync(dir, fsConstants.W_OK)
      return true
    } catch {
      return false
    }
  })()
  const tavernReachable = await probeTavern(req)
  return send(200, {
    ok: true,
    webServer: Boolean(getService(ctx, 'webServer')),
    sessionQuery: Boolean(getService(ctx, 'sessionQuery')),
    storageDirWritable,
    tavernReachable,
  })
}

// ---------------------------------------------------------------------------
// v5 P0 · Agent 编辑器只读数据面（GET /agent、GET /agent/detect）
//
// ⛔ 零写入：只读 agentPresets 服务 / 只读 ~/.dsh/.agent-presets/ 目录 / 只读本插件配置，
//   绝不 mkdir、绝不写盘、连备份目录都不创建（写入面是 P2）。
// 降级纪律：agentPresets 服务拿不到 → 退目录扫；目录也读不到 → ok:false + 可读 code
//   （HTTP 200，照 /config/test 的「测不通不是服务器错误」约定）；handler 内任何异常
//   一律收口为 ok:false，绝不抛、绝不 500。
// 诚实纪律：拿不到的字段一律 null（界面显示「未知」），绝不从形状猜。
// ---------------------------------------------------------------------------

const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]*$/ // 官方约束：preset id 同时是目录名（agent-presets/README.zh.md:75）

/** DSH 根目录（与 storageDir 同源的推导方式；路径只由 DSH_HOME / homedir() 推，绝不写死）。 */
function dshRootDir(env = process.env) {
  const configured = env.DSH_HOME
  const dshHome =
    configured !== undefined && String(configured).trim() !== ''
      ? String(configured)
      : join(homedir(), '.dsh')
  return resolve(expandHome(dshHome))
}

function agentPresetsRootDir(env = process.env) {
  return join(dshRootDir(env), '.agent-presets')
}

function readTextIfExists(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** 单值标量（允许行首缩进：嵌套在 config 里的键也认得到）。失败给 null —— 不猜。 */
function yamlTopScalar(text, key) {
  if (typeof text !== 'string') return null
  const m = new RegExp('^[ \\t]*' + key + '\\s*:\\s*(.+?)\\s*(?:#.*)?$', 'm').exec(text)
  if (!m) return null
  let v = m[1].trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
  return v === '' ? null : v
}

/** 折叠块标量（customInstruction: | / >，允许行首缩进）：按缩进收集正文。失败给 null。 */
function yamlBlockScalar(text, key) {
  if (typeof text !== 'string') return null
  const m = new RegExp('^[ \\t]*' + key + '\\s*:\\s*[|>][-+]?\\s*$', 'm').exec(text)
  if (!m) return null
  const lines = text.slice(m.index).split(/\r?\n/).slice(1)
  const body = []
  let indent = null
  for (const line of lines) {
    if (line.trim() === '') {
      body.push('')
      continue
    }
    const cur = line.match(/^[ \t]*/)[0].length
    if (indent === null) {
      if (cur === 0) break
      indent = cur
    }
    if (cur < indent) break
    body.push(line.slice(indent))
  }
  while (body.length && body[body.length - 1] === '') body.pop()
  return body.length ? body.join('\n') : null
}

/** preset 组成里压缩后端的 customInstruction（若有）。提取不到给 null —— 不猜。 */
function extractCustomInstruction(compositionText) {
  if (typeof compositionText !== 'string' || compositionText === '') return null
  return yamlBlockScalar(compositionText, 'customInstruction') || yamlTopScalar(compositionText, 'customInstruction')
}

// 组成探针：按 v4 的 12 条注释口径给「一句注释 + order」；探测只是子串匹配，
// 探不到就不列（绝不把「没探到」说成「不存在」）。
const COMPOSITION_PROBES = [
  {
    key: 'persona', name: 'persona（人设段）', order: '≈0',
    re: /@deepseek-ai\/dsh-persona|(^|\n)\s*-\s*id:\s*persona\b/,
    note: '部署/agent 配置里的人设与定位（这个 agent 是谁、怎么说话）。',
  },
  {
    key: 'preset', name: 'pmp-dsh-tavern preset 段', order: '10',
    re: /pmp-dsh-tavern/,
    note: '当前所选预设的固定段：ST 预设归一化后的系统提示内容（身份与文风主要来自这里）。（profile 层注入，不随 preset 文件变）',
  },
  {
    key: 'rpPolicy', name: 'rp:policy', order: '45',
    re: /rp:policy|rp-policy/,
    note: 'RP 模式策略段。默认只说明“高风险操作被锁”，不是扮演身份；身份与文风仍来自 preset / 角色卡。（profile 层注入）',
  },
  {
    key: 'stateCard', name: 'state:card（L1 状态卡）', order: '50',
    re: /state:card|dsh-state-bridge/,
    note: 'L1 状态卡：由副 LLM 每轮记账的当前状态（数值/分组/到期），让模型不必从正文里重算。（插件注入，不随 preset 文件变）',
  },
  {
    key: 'anima', name: 'anima:memory（L2 检索记忆）', order: '55',
    re: /anima:memory|dsh-anima-rag/,
    note: 'L2 检索记忆：从历史里检索出来的摘录（<recalledMemories>）与近场历史（<immediateHistory>）。只对 RP 会话注入。（插件注入）',
  },
  {
    key: 'compaction', name: 'compaction（上下文压缩块）', order: 'preset 层',
    re: /compaction-basic/,
    note: '被压缩出上下文的那段历史（checkpoint）。★ 必留：漏了它长对话必撞上下文窗口。',
  },
  {
    key: 'toolFs', name: 'tool-fs（read/write/edit）', order: '100–199',
    re: /@deepseek-ai\/dsh-tool-fs(?![a-z-])/,
    note: '文件工具：记忆系统要 read/write/edit（不许删）。',
  },
  {
    key: 'toolFsSearch', name: 'tool-fs-search（glob/grep）', order: '100–199',
    re: /dsh-tool-fs-search/,
    note: '文档导航工具（glob/grep）：检索式记忆库最省 token 的读取路径。',
  },
  {
    key: 'toolGuide', name: '工具引导行（bash/pwsh/web/subagent/goal/plan/todo…）', order: '100–199',
    re: /tool-bash|tool-pwsh|tool-web|tool-subagent|tool-workflow|tool-ralph|tool-goal|plan-mode|tool-todo/,
    note: '工具的使用说明与纪律，和这次请求 tools 里的定义配套。对 RP 多为负资产（生成 RP 副本时会删）。',
  },
]
// harness identity 不在任何 preset 文件里，但组成视图需要它定位（恒定注入，永远排最前）。
const IDENTITY_SECTION = {
  key: 'identity', name: 'identity（harness identity）', order: '≈-100',
  note: 'DSH 核心注入的 agent 身份与环境说明：告诉模型它在 DSH 里、检出目录在哪、GUI 上下文与行为纪律。恒定注入，永远排在最前。',
  source: '运行时恒定注入（不在 preset 文件里）',
}
// 与 RP 无关、生成副本时应删的工具行（规格 §三.6 第 6 条的「将删」清单）。
const RISKY_TOOL_RE = /tool-bash|tool-pwsh|tool-web|tool-subagent|tool-workflow|tool-ralph|tool-goal|plan-mode|tool-todo/

/** 从组成文本（agent.cordis.yml）探测已知段/插件。读不到文本给 null。 */
function detectComposition(compositionText) {
  if (typeof compositionText !== 'string' || compositionText === '') return null
  const sections = []
  for (const probe of COMPOSITION_PROBES) {
    if (!probe.re.test(compositionText)) continue
    sections.push({ name: probe.name, order: probe.order, note: probe.note, source: 'preset 组成（子串探测）' })
  }
  return sections
}

/**
 * 收集 preset 清单：优先 ctx.agentPresets.list()（形状未知，防御式归一），
 * 拿不到/为空就退回扫 ~/.dsh/.agent-presets/（user 根目录里的 preset 官方语义就是
 * 用户自带 trust='user'）。两路都拿不到给空数组 + source:'none'。绝不抛。
 */
async function collectPresetInfos(ctx) {
  const items = []
  let source = 'none'
  const ap = getService(ctx, 'agentPresets')
  if (ap && typeof ap.list === 'function') {
    try {
      const raw = await ap.list()
      const arr = Array.isArray(raw) ? raw : isPlainObject(raw) && Array.isArray(raw.presets) ? raw.presets : null
      if (arr) {
        for (const it of arr) {
          if (!isPlainObject(it)) continue
          const id = firstString(it.id, it.presetId, it.dir, it.name)
          if (!id) continue
          const trust = it.trust === 'user' ? 'user' : it.trust ? 'deployment' : null
          items.push({
            id,
            name: typeof it.displayName === 'string' && it.displayName !== '' ? it.displayName
              : typeof it.name === 'string' && it.name !== id ? it.name : null,
            trust,
            dir: typeof it.dir === 'string' ? it.dir : null,
            compositionText: null,
            serviceItem: it,
          })
        }
        if (items.length) source = 'service'
      }
    } catch {}
  }
  if (source !== 'service') {
    // 退路：扫 user 根目录。只读目录与两个文件，绝不写。
    try {
      const root = agentPresetsRootDir()
      const entries = readdirSync(root, { withFileTypes: true })
      for (const ent of entries) {
        if (!ent.isDirectory() || !AGENT_ID_RE.test(ent.name)) continue
        const dir = join(root, ent.name)
        const metaText = readTextIfExists(join(dir, 'preset.yml'))
        const compositionText = readTextIfExists(join(dir, 'agent.cordis.yml'))
        items.push({
          id: ent.name,
          name: metaText ? yamlTopScalar(metaText, 'name') : null,
          trust: 'user', // includeUserRoot 追加的 <dshHome>/.agent-presets 官方语义就是 user 根
          dir,
          compositionText,
          serviceItem: null,
        })
      }
      if (items.length) source = 'fallback'
    } catch {}
  }
  return { items, source, service: ap || null }
}

/** 服务侧补读某 preset 的组成文本（readComposition / read，形状未知逐个试）。失败给 null。 */
/**
 * 组成文本读取（v5 修复 v3 ②：**盘优先**）。
 * ★ 依据（写进注释）：盘上的文本才是「下一个新会话会用到的东西」——而会话一旦在跑就保持
 *   它当初那一代（agent.cordis.yml 自己的注释也这么写）；且 recompose 在宿主半侧拿不到
 *   scoped ctx（真机实测 "refusing to recompose an unscoped context"）⇒ 服务侧组成不刷新，
 *   服务里的文本可能是旧一代。⇒ 统一成「盘优先」：盘上读得到就以盘为准，读不到才退服务，
 *   并【如实返回来源】（source: 'disk' | 'service'），界面能显示"这是盘上/服务里的值"。
 *   真机实证：apply（直接读盘）看得到新值、detect（service 优先）看不到 ⇒ 不是解析 bug，
 *   是读路径读到了服务里不刷新的旧组成。
 */
async function readCompositionText(ap, info) {
  if (!ap || !info) return null
  if (info.compositionText) return { text: info.compositionText, source: 'disk' } // 目录扫路径的 compositionText 本来就读自盘
  const diskPaths = []
  if (typeof info.dir === 'string' && info.dir !== '') diskPaths.push(join(info.dir, 'agent.cordis.yml'))
  if (typeof info.id === 'string' && AGENT_ID_RE.test(info.id)) {
    diskPaths.push(join(agentPresetsRootDir(), info.id, 'agent.cordis.yml'))
  }
  for (const p of diskPaths) {
    const disk = readTextIfExists(p)
    if (typeof disk === 'string' && disk !== '') return { text: disk, source: 'disk' }
  }
  const tryString = (v) => {
    if (typeof v === 'string') return v
    if (isPlainObject(v)) {
      for (const k of ['text', 'content', 'yaml', 'composition', 'cordis']) {
        if (typeof v[k] === 'string') return v[k]
      }
    }
    return null
  }
  try {
    if (typeof ap.readComposition === 'function') {
      const got = tryString(await ap.readComposition(info.serviceItem || info.id))
      if (got !== null) return { text: got, source: 'service' }
    }
  } catch {}
  try {
    if (typeof ap.read === 'function') {
      const p = await ap.read(info.id)
      if (isPlainObject(p)) {
        for (const k of ['composition', 'cordis', 'assembly', 'agentCordisYml']) {
          const got = tryString(p[k])
          if (got !== null) return { text: got, source: 'service' }
        }
      }
    }
  } catch {}
  return null
}

/** 便宜路径：会话头字段里的 agentPreset（listSessions 快路径）。拿不到给 null。 */
async function presetFromSessionHeader(ctx, sessionId) {
  const sq = getService(ctx, 'sessionQuery')
  if (!sq || typeof sq.listSessions !== 'function') return null
  try {
    const raw = await sq.listSessions()
    const items = Array.isArray(raw) ? raw : isPlainObject(raw) && Array.isArray(raw.sessions) ? raw.sessions : null
    if (!items) return null
    for (const item of items) {
      const o = isPlainObject(item) ? item : {}
      const h = isPlainObject(o.header) ? o.header : {}
      const id = firstString(h.id, o.sessionId, o.id, o.uuid, o.session_id)
      if (id !== sessionId) continue
      const preset = firstString(h.agentPreset, o.agentPreset, h.presetId, h.preset)
      return preset ? { id: preset, evidence: '会话头（listSessions）' } : null
    }
  } catch {}
  return null
}

/** 会话自带事实：事件 agent-preset/selected（防御式提取，形状不识就 null）。 */
async function presetFromSessionEvents(ctx, sessionId) {
  const sq = getService(ctx, 'sessionQuery')
  if (!sq || typeof sq.readSession !== 'function') return null
  let snapshot
  try {
    snapshot = await sq.readSession(sessionId)
  } catch {
    return null
  }
  const extracted = extractEvents(snapshot)
  if (!extracted) return null
  let found = null
  for (const raw of extracted.events) {
    if (!isPlainObject(raw)) continue
    const type = firstString(raw.type, raw.kind, raw.event, raw.eventType) || ''
    if (!/agent-preset/i.test(type)) continue
    const v = isPlainObject(raw.value) ? raw.value : isPlainObject(raw.data) ? raw.data : {}
    const id = firstString(
      raw.agentPreset, raw.presetId, raw.preset,
      v.agentPreset, v.presetId, v.preset, v.id, raw.id,
    )
    if (id) found = { id, evidence: '会话事件 ' + type }
  }
  if (!found && isPlainObject(snapshot) && isPlainObject(snapshot.session)) {
    const s = snapshot.session
    const id = firstString(s.agentPreset, s.presetId, s.preset)
    if (id) found = { id, evidence: 'readSession 会话对象' }
  }
  return found
}

/**
 * 「面板值 vs preset 实际值」：把 preset 组成里 compaction 后端的 customInstruction（若有）
 * 与本插件配置里的压缩指令比一比。只比对，不写。提取不到一律 consistent:null（未知）。
 */
function compactionConsistency(prompts, compositionText) {
  const panelCustom = typeof prompts.compaction === 'string' && prompts.compaction !== ''
  const panelText = panelCustom ? prompts.compaction : BUILTIN_COMPACTION_ZH
  let presetState = 'unknown'
  let consistent = null
  if (typeof compositionText === 'string' && compositionText !== '') {
    const inst = extractCustomInstruction(compositionText)
    if (typeof inst === 'string' && inst !== '') {
      presetState = 'set'
      consistent = inst.trim() === panelText.trim()
    } else if (/compaction-basic/.test(compositionText)) {
      presetState = 'absent' // 有压缩块、没写指令 = 用后端内置模板；后端真实内置是什么我们不知道 ⇒ 不下结论
    }
  }
  let note
  if (presetState === 'set') {
    note = consistent
      ? '一致：preset 的 customInstruction 与面板当前文本相同。'
      : '不一致：面板里改的这份不会生效——preset 实际用的是它自己写的 customInstruction。'
  } else if (presetState === 'absent') {
    note = 'preset 的压缩块没有 customInstruction（用后端内置模板）；与面板文本的一致性无法判定，显示未知。'
  } else {
    note = 'preset 组成读不到（或没有压缩块），无法比对。'
  }
  return { panelSource: panelCustom ? 'custom' : 'builtin', presetInstruction: presetState, consistent, note }
}

/** GET /agent：当前 preset（id/trust/writable）+ 组成 + 压缩一致性。只读；拿不到 = null。 */
async function handleAgentGet(ctx, url, req, send) {
  try {
    const sessionIdParam = url.searchParams.get('sessionId')
    const sessionId = typeof sessionIdParam === 'string' && sessionIdParam !== '' ? sessionIdParam : null
    const { config } = readConfigFile()
    const infos = await collectPresetInfos(ctx)

    // 当前会话用哪个 preset：先便宜路径（listSessions 头字段），再会话事件（readSession）。
    let selected = null
    if (sessionId) selected = (await presetFromSessionHeader(ctx, sessionId)) || (await presetFromSessionEvents(ctx, sessionId))

    let preset = { id: null, name: null, trust: null, writable: null }
    let active = null
    let sections = []
    let compositionText = null
    let compositionSource = null // v5 修复 v3 ②：'disk' | 'service'（盘优先；拿不到 = null）
    let reason = null
    if (selected) {
      active = true // preset 取自该会话自带事实 ⇒ 「已生效」成立
      const info = infos.items.find((x) => x.id === selected.id) || null
      preset = {
        id: selected.id,
        name: info ? info.name : null,
        trust: info ? info.trust : null,
        writable: info ? info.trust === 'user' : null, // 官方语义：trust !== 'user' ⇒ agent-preset/read-only
      }
      const comp = info ? await readCompositionText(infos.service, info) : null
      compositionText = comp ? comp.text : null
      compositionSource = comp ? comp.source : null
      const detected = detectComposition(compositionText)
      if (detected) {
        sections = [Object.assign({ source: '运行时恒定注入（不在 preset 文件里）' }, IDENTITY_SECTION)].concat(detected)
      } else {
        sections = [Object.assign({}, IDENTITY_SECTION)]
        reason = compositionText === null
          ? `preset「${selected.id}」的组成读不到（agentPresets 服务与 ${agentPresetsRootDir()} 目录都拿不到它的 agent.cordis.yml）`
          : `preset「${selected.id}」的组成文本为空`
      }
    } else {
      reason = sessionId
        ? '该会话没有 agent-preset 选择记录（会话头与会话事件都拿不到）——如实显示未知，不猜'
        : '未选会话：先在中间栏选一个会话，才能从它的自带事实读到 preset'
    }

    return send(200, {
      ok: true,
      sessionId,
      preset,
      active,
      sections,
      compositionSource, // v5 修复 v3 ②：'disk' | 'service' —— 组成文本如实标来源（盘优先）
      compaction: compactionConsistency(config.prompts, compositionText),
      presetsSource: infos.source,
      error: reason,
      note: '本接口只读；拿不到的字段一律 null（界面显示未知）。零写入。组成读取盘优先（盘上才是下个新会话会用到的）。',
    })
  } catch (e) {
    return send(200, { ok: false, error: { code: 'AGENT_READ_FAILED', message: String((e && e.message) || e) } })
  }
}

/** 「生成 / 修复 RP agent」预览的 6 条事实（规格 §三.6 口径 + §〇 三处实测修正）。 */
function detectPreviewFacts() {
  return [
    '① 生成方式：调官方 agentPresets.copy(\'cordis\', <id>, \'<显示名>\')（官方原话「创作即复制」），落到 ~/.dsh/.agent-presets/<id>/；<id> 必须匹配 [a-z0-9][a-z0-9-]*（它同时是目录名）。★ 规格书 §〇.2 实测修正：本机既有 roleplay 就是 copy(\'cordis\',…) 来的，从零生成也从 cordis 复制，不是 standard。',
    '② ★ 显示名来自 preset.yml 的 name —— 「新开会话时多出来的那个选项」显示的就是它。',
    '③ ★ 只有完全空白的新会话才能用这个 preset（agent-presets/README.zh.md:173：「会话一旦产出任何内容便无法更换 preset」）⇒ 生成后引导用户新开会话并在选择器里选它，不要说「已应用到当前会话」。',
    '④ ★ 不会设置 persona.complete: true —— 因为 complete 的覆盖发生在 system-prompt/assemble waterfall 之后（system-prompt/src/index.ts:601-610），会一次性废掉每轮状态/记忆注入通道（state:card / anima:memory）。',
    '⑤ ★ 工具面收窄在 preset scope 已经解决：roleplay 的 rp-tool-scope.js 用 ctx.tools.restrict({deny}) 把「全局工具 − 白名单」挡掉，实测 preset=roleplay 会话模型收到的 tools 恰好 3 个（anima_query / state_list / state_show）、零 chrome；对照 preset=standard 是 69 个（含 23 个 mcp-chrome 的 mcp__chrome__*）。⛔ 因此不需要任何 host 层 tools.guard 兜底，本插件也不写守卫。',
    '⑥ 将删：bash / pwsh / web / subagent* / workflow / ralph / goal / plan / todo（由 preset scope 的 restrict 完成）；修复路径（本机）⛔ 不动工具面（已实测收窄正确）；将保留：compaction 整块必留（漏了长对话必撞窗口）、tool-fs、tool-fs-search。',
  ]
}

/** GET /agent/detect：只读检测（候选 / 记忆库根 / 缺什么）+ 生成与修复预览。零写入。 */
async function handleAgentDetect(ctx, url, req, send) {
  try {
    const { config } = readConfigFile()
    const infos = await collectPresetInfos(ctx)

    // 记忆库根：配置里有没有 + 能不能解析到（只读验证，绝不改配置）。
    const root = isPlainObject(config.root) ? config.root : {}
    const rootMode = config.rootMode === 'workspace' ? 'workspace' : 'session'
    const rootSessionId = typeof root.sessionId === 'string' && root.sessionId !== '' ? root.sessionId : null
    const rootCharacterId = typeof root.characterId === 'string' && root.characterId !== '' ? root.characterId : null
    const rootPlaythroughId = typeof root.playthroughId === 'string' && root.playthroughId !== '' ? root.playthroughId : null
    const configured = rootMode === 'session' ? !!rootSessionId : !!(rootCharacterId && rootPlaythroughId)
    let resolvable = null
    let rootDetail = ''
    if (!configured) {
      resolvable = false
      rootDetail = '记忆库根未配置（先到「记忆库 ⚙ 设置」里选根）'
    } else if (rootMode === 'session' && rootSessionId) {
      const sq = getService(ctx, 'sessionQuery')
      if (sq && typeof sq.listSessions === 'function') {
        try {
          const raw = await sq.listSessions()
          const items = Array.isArray(raw) ? raw : isPlainObject(raw) && Array.isArray(raw.sessions) ? raw.sessions : null
          if (items) {
            resolvable = items.some((item) => {
              const o = isPlainObject(item) ? item : {}
              const h = isPlainObject(o.header) ? o.header : {}
              return firstString(h.id, o.sessionId, o.id, o.uuid, o.session_id) === rootSessionId
            })
            rootDetail = resolvable ? '根会话在会话列表里' : '根会话不在会话列表里（可能已删除）'
          } else {
            rootDetail = 'listSessions 返回形状不识，无法验证根会话'
          }
        } catch (e) {
          rootDetail = '验证根会话失败：' + String((e && e.message) || e)
        }
      } else {
        rootDetail = 'sessionQuery 不可用，无法验证根会话'
      }
    } else {
      const reachable = await probeTavern(req)
      resolvable = reachable
      rootDetail = reachable ? 'Tavern 可达，工作区根可解析' : 'Tavern 不可达，工作区根解析不到'
    }

    // 候选：用户自带（trust==='user'）的 preset 才是可写对象；给每个候选做只读体检。
    const candidates = []
    for (const info of infos.items) {
      if (info.trust !== 'user') continue
      let compositionText = info.compositionText
      let compositionSource = compositionText != null ? 'disk' : null
      if (compositionText == null) {
        const comp = await readCompositionText(infos.service, info)
        compositionText = comp ? comp.text : null
        compositionSource = comp ? comp.source : null
      }
      const hasCompactionInstruction = (() => {
        const inst = compositionText ? extractCustomInstruction(compositionText) : null
        return typeof inst === 'string' && inst !== ''
      })()
      const risky = compositionText && RISKY_TOOL_RE.test(compositionText)
      candidates.push({
        id: info.id,
        name: info.name,
        trust: info.trust,
        writable: info.trust === 'user',
        bound: hasCompactionInstruction && configured, // 绑定口径：压缩指令已写入 + 记忆库根已配置
        hasCompactionInstruction,
        compositionSource, // v5 修复 v3 ②：'disk' | 'service'（盘优先后的如实来源）
        riskyToolRows: risky === true ? '检出与 RP 无关的工具行（bash/pwsh/web/subagent/goal/plan/todo 等）' : (risky === false ? '未检出' : '未知（组成读不到）'),
      })
    }
    candidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

    // 缺什么（只读事实，逐条可执行）。
    const missing = []
    if (candidates.length === 0) {
      missing.push('没有用户自带（trust=user）的 RP preset（' + agentPresetsRootDir() + ' 为空、不可读，或 agentPresets 服务没列出 user preset）')
    }
    for (const c of candidates) {
      if (!c.hasCompactionInstruction) {
        missing.push(`「${c.id}」的压缩后端 customInstruction 是空的 —— 记忆库的压缩指令模板对它不生效；点「应用（真写入）」即可补上`)
      }
      if (c.riskyToolRows === '检出与 RP 无关的工具行（bash/pwsh/web/subagent/goal/plan/todo 等）') {
        missing.push(`「${c.id}」的组成文本里检出与 RP 无关的工具行（生成副本时会由 preset scope 的 restrict 删；修复路径不动工具面——本机 roleplay 已实测收窄正确）`)
      }
    }
    if (!configured) missing.push('记忆库根未配置（先到「记忆库 ⚙ 设置」里选根；没有根就没有可注入的检索面）')
    else if (resolvable === false) missing.push('记忆库根当前解析不到：' + rootDetail)

    return send(200, {
      ok: true,
      presetsSource: infos.source,
      candidates,
      memoryRoot: { configured, resolvable, mode: rootMode, detail: rootDetail },
      missing,
      preview: {
        createOrFix: detectPreviewFacts(),
        backupPlan: '应用（真写入）走 POST /agent/apply：先 dryRun 零写入出计划，确认后 备份→原子写→回读校验→不一致自动回滚，备份落在 <preset>/.dma-backup/，可随时查（GET /agent/backups）。',
      },
      note: '本版只做检测与预览，不会写入任何文件。',
    })
  } catch (e) {
    return send(200, { ok: false, error: { code: 'AGENT_DETECT_FAILED', message: String((e && e.message) || e) } })
  }
}

// ---------------------------------------------------------------------------
// v5 P1a · 真落盘 + 联动（POST /agent/apply、GET /agent/backups）
//
// 写入面全部在 ./rp-agent.js（可注入 presetsRoot + 三条硬拒绝 + 四步写入 +
// 保注释定点替换）。宿主侧只做：body 解析、压缩指令取值（请求 knobs 优先，
// 退面板模板）、trust 解析（agentPresets 服务优先，退 user 根目录官方语义）、
// recompose 联动。一律 HTTP 200、错误放 body {ok:false,error,hint}；绝不抛、绝不 500。
// ---------------------------------------------------------------------------

/** 记忆库当前根的可读串（dma-binding.json 的 memoryArchiveRoot）；没选根给 null（绑定如实记 null）。 */
function memoryArchiveRootString(config) {
  const root = isPlainObject(config.root) ? config.root : {}
  if (config.rootMode === 'workspace') {
    return root.characterId && root.playthroughId
      ? 'workspace/' + root.characterId + '/' + root.playthroughId
      : null
  }
  return root.sessionId ? 'session/' + root.sessionId : null
}

function rpUnavailable() {
  return {
    ok: false,
    error: {
      code: 'RP_AGENT_UNAVAILABLE',
      message:
        '写入面模块 rp-agent.js 加载失败：' +
        String((rpAgentLoadError && rpAgentLoadError.message) || rpAgentLoadError),
    },
    hint: '本插件其余 rest 不受影响；修复 rp-agent.js 后重载宿主即可。',
  }
}

/** trust 解析：服务清单优先；服务没给/没列出时退官方语义——presetsRoot 就是 user 根，目录在即 user。 */
async function resolvePresetTrust(ctx, rpAgent, presetsRoot, presetId) {
  const infos = await collectPresetInfos(ctx)
  const info = infos.items.find((x) => x.id === presetId) || null
  if (info && info.trust) return { trust: info.trust, name: info.name }
  const trust = rpAgent.dirExists(join(presetsRoot, presetId)) ? 'user' : null
  return { trust, name: info ? info.name : null }
}

/**
 * 写后一致性核对（v5 修复 v3 ④）：落盘成功后，用与界面【同一条读路径】（盘优先的
 * readCompositionText）再读一次，确认刚写进去的压缩指令能被读回。
 * ★ 理由：「文件写对了、面板说没写」是自相矛盾 —— 必须被自己的回读校验抓到，
 *   而不是等验收方在真机上发现。不一致 ⇒ 返回 ok:false + 可读 note，界面红字显示。
 */
async function panelConsistencyAfterWrite(ctx, presetId, expected) {
  const ap = getService(ctx, 'agentPresets')
  const comp = await readCompositionText(ap, { id: presetId })
  if (!comp || typeof comp.text !== 'string' || comp.text === '') {
    return { ok: null, via: null, note: '写后核对没做成：经面板同一条读路径读不到组成文本' }
  }
  const via = comp.source
  const got = extractCustomInstruction(comp.text)
  if (typeof got === 'string' && expected != null && got.trim() === String(expected).trim()) {
    return { ok: true, via, note: '写后核对通过：经' + (via === 'disk' ? '盘上' : '服务') + '读路径能读回刚写入的值' }
  }
  return {
    ok: false,
    via,
    note:
      '写后核对不一致：文件已写入，但经' + (via === 'disk' ? '盘上' : '服务') +
      '读路径读回的压缩指令不是刚写的值 —— 读路径可能 stale，界面一致性以本核对为准',
  }
}

// ---------------------------------------------------------------------------
// v5 P1b-2a：pack 落地（POST /agent/pack/apply）。写入面在 rp-agent.applyPackToPreset：
// <preset>/dma-rp-inject.js + dma-rp-pack.md + agent.cordis.yml（挂载行 + persona text）。
// 硬约束：pack 过双契约校验才写；CONFLICTS 非 NONE 拒（先商量）；四步写入 + TOCTOU 重核；
// persona 改前/改后随 dryRun 给出，玩家确认才真写。一律 HTTP 200、错误放 body。
// ---------------------------------------------------------------------------

async function handleAgentPackApply(ctx, url, req, send) {
  try {
    if (!rpAgent) return send(200, rpUnavailable())
    let body = null
    try {
      const raw = await readBody(req, BODY_LIMIT)
      body = JSON.parse(raw.toString('utf8') || '{}')
    } catch (e) {
      return send(200, {
        ok: false,
        error: { code: 'BAD_JSON', message: '请求体不是合法 JSON：' + String((e && e.message) || e) },
      })
    }
    if (!isPlainObject(body)) {
      return send(200, { ok: false, error: { code: 'BAD_REQUEST', message: '请求体必须是 JSON 对象' } })
    }
    const presetId = typeof body.presetId === 'string' ? body.presetId.trim() : ''
    const packText = typeof body.packText === 'string' ? body.packText : ''
    if (presetId === '') {
      return send(200, { ok: false, error: { code: 'BAD_REQUEST', message: '缺 presetId（要应用到的白名单 preset）' } })
    }
    if (packText.trim() === '') {
      return send(200, { ok: false, error: { code: 'BAD_REQUEST', message: '缺 packText（RP-AGENT-PACK v1 全文）' } })
    }
    const dryRun = body.dryRun === true
    const presetsRoot = rpAgent.resolvePresetsRoot()
    const { trust, name } = await resolvePresetTrust(ctx, rpAgent, presetsRoot, presetId)
    const result = rpAgent.applyPackToPreset({
      presetsRoot,
      presetId,
      trust,
      packText,
      switches: isPlainObject(body.switches) ? body.switches : null,
      dryRun,
      expectCardHash: typeof body.expectCardHash === 'string' ? body.expectCardHash : undefined,
    })
    if (!result.ok) {
      return send(200, {
        ok: false,
        error: { code: result.code || 'PACK_APPLY_FAILED', message: result.message },
        hint: result.hint || null,
        violations: result.violations || null,
        rolledBack: result.rolledBack === true,
        backup: result.backup || null,
      })
    }
    if (dryRun) {
      return send(200, Object.assign({}, result, {
        note: 'dryRun：以上是计划（含 persona 改前/改后），一个字节都没写；确认后才会真写。',
        nextStep: '确认无误后带 dryRun:false 重新提交，才会真写。',
      }))
    }
    // 真写成功：尽量 recompose（拿不到就明说，绝不显示「已生效」）
    let recompose = {
      ok: false,
      method: 'unavailable',
      note: 'agentPresets 服务或 recompose 不可用：改动已落盘，但要新开会话才会用上',
    }
    const ap = getService(ctx, 'agentPresets')
    if (ap && typeof ap.recompose === 'function') {
      try {
        await ap.recompose(ctx, presetId)
        recompose = { ok: true, method: 'agentPresets.recompose', note: '已请求重组；现有会话仍不能换 preset' }
      } catch (e) {
        recompose = {
          ok: false,
          method: 'agentPresets.recompose',
          note: 'recompose 调用失败：' + String((e && e.message) || e) + '；要新开会话才会用上',
        }
      }
    }
    const displayName = name || presetId
    return send(200, Object.assign({}, result, {
      recompose,
      consistencyAfterWrite: null,
      nextStep: '已把「' + displayName + '」按 pack 更新；需新开会话或重启才完全生效',
      note: '写入完成：注入模块 + pack 留档 + 挂载行（幂等）+ persona（若有 identity）。',
    }))
  } catch (e) {
    return send(200, { ok: false, error: { code: 'PACK_APPLY_INTERNAL', message: String((e && e.message) || e) } })
  }
}

async function handleAgentApply(ctx, url, req, send) {
  try {
    if (!rpAgent) return send(200, rpUnavailable())
    let body = null
    try {
      const raw = await readBody(req, BODY_LIMIT)
      body = JSON.parse(raw.toString('utf8') || '{}')
    } catch (e) {
      return send(200, {
        ok: false,
        error: { code: 'BAD_JSON', message: '请求体不是合法 JSON：' + String((e && e.message) || e) },
      })
    }
    if (!isPlainObject(body)) {
      return send(200, { ok: false, error: { code: 'BAD_REQUEST', message: '请求体必须是 JSON 对象' } })
    }
    const presetId = typeof body.presetId === 'string' ? body.presetId.trim() : ''
    if (presetId === '') {
      return send(200, { ok: false, error: { code: 'BAD_REQUEST', message: '缺 presetId（要应用到的白名单 preset，如 roleplay）' } })
    }
    const dryRun = body.dryRun === true
    const knobs = isPlainObject(body.knobs) ? body.knobs : {}
    const { config } = readConfigFile()

    // 压缩指令取值（联动①的写入内容）：请求带了非空 knobs.customInstruction 就用它；
    // 否则用面板模板（自定义优先，退内置中文模板）——「面板值」从此有地方真正生效。
    const panelTemplate =
      typeof config.prompts.compaction === 'string' && config.prompts.compaction !== ''
        ? config.prompts.compaction
        : BUILTIN_COMPACTION_ZH
    const customInstruction =
      typeof knobs.customInstruction === 'string' && knobs.customInstruction.trim() !== ''
        ? knobs.customInstruction
        : panelTemplate
    const memoryArchiveRoot = memoryArchiveRootString(config)
    const presetsRoot = rpAgent.resolvePresetsRoot()
    const { trust, name } = await resolvePresetTrust(ctx, rpAgent, presetsRoot, presetId)

    const result = rpAgent.applyToPreset({ presetsRoot, presetId, trust, customInstruction, memoryArchiveRoot, dryRun })
    if (!result.ok) {
      return send(200, {
        ok: false,
        error: { code: result.code || 'APPLY_FAILED', message: result.message },
        hint: result.hint || null,
        rolledBack: result.rolledBack === true,
        backup: result.backup || null,
      })
    }
    const backupShaped = result.backup
      ? {
        dir: result.backup.dir,
        files: Array.isArray(result.backup.files) ? result.backup.files : [result.backup.name],
      }
      : null

    // 联动①：落盘成功后尽量 recompose；拿不到就明说「需新开会话」，绝不显示「已生效」。
    let recompose
    if (dryRun) {
      recompose = { ok: null, method: 'skipped', note: 'dryRun 不调用 recompose' }
    } else {
      recompose = {
        ok: false,
        method: 'unavailable',
        note: 'agentPresets 服务或 recompose 不可用：改动已落盘，但要新开会话才会用上',
      }
      const ap = getService(ctx, 'agentPresets')
      if (ap && typeof ap.recompose === 'function') {
        try {
          await ap.recompose(ctx, presetId)
          recompose = { ok: true, method: 'agentPresets.recompose', note: '已请求重组；现有会话仍不能换 preset' }
        } catch (e) {
          recompose = {
            ok: false,
            method: 'agentPresets.recompose',
            note: 'recompose 调用失败：' + String((e && e.message) || e) + '；要新开会话才会用上',
          }
        }
      }
    }

    const displayName = name || presetId
    // v5 修复 v3 ④：真写成功后用面板同一条读路径再核对一次（dryRun 不做）
    const consistencyAfterWrite =
      dryRun === true
        ? null
        : await panelConsistencyAfterWrite(ctx, presetId, result.applied && result.applied[0] ? result.applied[0].to : null)
    return send(200, Object.assign({}, result, {
      backup: backupShaped,
      recompose,
      consistencyAfterWrite,
      nextStep: '请新开会话并选「' + displayName + '」',
      note: dryRun ? 'dryRun：以上是计划，一个字节都没写。' : '写入完成：备份→原子写→回读校验全过。',
    }))
  } catch (e) {
    return send(200, { ok: false, error: { code: 'APPLY_INTERNAL', message: String((e && e.message) || e) } })
  }
}

async function handleAgentBackups(ctx, url, req, send) {
  try {
    if (!rpAgent) return send(200, rpUnavailable())
    const presetId = (url.searchParams.get('presetId') || '').trim()
    if (presetId === '') {
      return send(200, { ok: false, error: { code: 'BAD_REQUEST', message: '缺 presetId 参数（?presetId=roleplay）' } })
    }
    const presetsRoot = rpAgent.resolvePresetsRoot()
    const { trust } = await resolvePresetTrust(ctx, rpAgent, presetsRoot, presetId)
    const result = rpAgent.listBackups({ presetsRoot, presetId, trust, limit: 50 })
    if (!result.ok) {
      return send(200, { ok: false, error: { code: result.code || 'LIST_BACKUPS_FAILED', message: result.message }, hint: result.hint || null })
    }
    return send(200, Object.assign({}, result, { note: result.note || '按时间倒序；面板最多展示 10 条。' }))
  } catch (e) {
    return send(200, { ok: false, error: { code: 'BACKUPS_INTERNAL', message: String((e && e.message) || e) } })
  }
}

// ---------------------------------------------------------------------------
// v5 P1b-1 ①：选卡数据面（GET /agent/cards、GET /agent/card?id=）—— 只读、零解析、零写入。
// 契约：《选卡-读卡与pack输出契约.md》§1（修订见《选卡-设计修订与组装骨架-20260913.md》）：
// 卡的原始数据全给 AI，插件不解析、不筛扬、不补默认值；*Chars 只是导航提示。
// id 防目录穿越在 rp-agent.resolveCardFile（resolveBackupFile 同款纵深口径）。
// 一律 HTTP 200、错误放 body、绝不抛、绝不 500。
// ---------------------------------------------------------------------------

async function handleAgentCards(ctx, url, req, send) {
  try {
    if (!rpAgent) return send(200, rpUnavailable())
    const charactersRoot = rpAgent.resolveCharactersRoot()
    const result = rpAgent.listCards({ charactersRoot })
    if (!result.ok) {
      return send(200, { ok: false, error: { code: result.code || 'LIST_CARDS_FAILED', message: result.message }, hint: null })
    }
    return send(200, result)
  } catch (e) {
    return send(200, { ok: false, error: { code: 'CARDS_INTERNAL', message: String((e && e.message) || e) } })
  }
}

async function handleAgentCard(ctx, url, req, send) {
  try {
    if (!rpAgent) return send(200, rpUnavailable())
    const id = (url.searchParams.get('id') || '').trim()
    if (id === '') {
      return send(200, { ok: false, error: { code: 'BAD_REQUEST', message: '缺 id 参数（?id=<uuid>.json，必须是 characters/ 下的纯文件名）' } })
    }
    const charactersRoot = rpAgent.resolveCharactersRoot()
    const result = rpAgent.readCard({ charactersRoot, cardId: id })
    if (!result.ok) {
      return send(200, { ok: false, error: { code: result.code || 'CARD_READ_FAILED', message: result.message }, hint: null })
    }
    return send(200, result)
  } catch (e) {
    return send(200, { ok: false, error: { code: 'CARD_INTERNAL', message: String((e && e.message) || e) } })
  }
}

// v5 P2 ①：一键回滚（POST /agent/rollback）。写法全部在 rp-agent.restoreFromBackup
//（三条硬拒绝 + backupFile 目录穿越防御 + 回滚前先备份当前文件 + 原子写 + 逐字节回读校验，
// dryRun 零写入）；宿主侧只做 body 解析、trust 解析、落盘成功后的 recompose 尝试。
// 一律 HTTP 200、错误放 body {ok:false,error,hint}；绝不抛、绝不 500。
async function handleAgentRollback(ctx, url, req, send) {
  try {
    if (!rpAgent) return send(200, rpUnavailable())
    let body = null
    try {
      const raw = await readBody(req, BODY_LIMIT)
      body = JSON.parse(raw.toString('utf8') || '{}')
    } catch (e) {
      return send(200, {
        ok: false,
        error: { code: 'BAD_JSON', message: '请求体不是合法 JSON：' + String((e && e.message) || e) },
      })
    }
    if (!isPlainObject(body)) {
      return send(200, { ok: false, error: { code: 'BAD_REQUEST', message: '请求体必须是 JSON 对象' } })
    }
    const presetId = typeof body.presetId === 'string' ? body.presetId.trim() : ''
    const backupFile = typeof body.backupFile === 'string' ? body.backupFile.trim() : ''
    if (presetId === '') {
      return send(200, { ok: false, error: { code: 'BAD_REQUEST', message: '缺 presetId（要回滚的白名单 preset，如 roleplay）' } })
    }
    if (backupFile === '') {
      return send(200, { ok: false, error: { code: 'BAD_REQUEST', message: '缺 backupFile（.dma-backup/ 下的纯文件名，先查 GET /agent/backups）' } })
    }
    const dryRun = body.dryRun === true
    const presetsRoot = rpAgent.resolvePresetsRoot()
    const { trust, name } = await resolvePresetTrust(ctx, rpAgent, presetsRoot, presetId)
    const result = rpAgent.restoreFromBackup({ presetsRoot, presetId, trust, backupFile, dryRun })
    if (!result.ok) {
      return send(200, {
        ok: false,
        error: { code: result.code || 'ROLLBACK_FAILED', message: result.message },
        hint: result.hint || null,
        rolledBack: result.rolledBack === true,
        backup: result.backup || null,
      })
    }

    // 落盘成功（或 dryRun 跳过）后尽量 recompose；拿不到就明说「需新开会话或重启」，绝不显示「已生效」。
    let recompose
    if (dryRun) {
      recompose = { ok: null, method: 'skipped', note: 'dryRun 不调用 recompose' }
    } else {
      recompose = {
        ok: false,
        method: 'unavailable',
        note: 'agentPresets 服务或 recompose 不可用：回滚已落盘，但要新开会话（或重启）才会用上',
      }
      const ap = getService(ctx, 'agentPresets')
      if (ap && typeof ap.recompose === 'function') {
        try {
          await ap.recompose(ctx, presetId)
          recompose = { ok: true, method: 'agentPresets.recompose', note: '已请求重组；现有会话仍不能换 preset' }
        } catch (e) {
          recompose = {
            ok: false,
            method: 'agentPresets.recompose',
            note: 'recompose 调用失败：' + String((e && e.message) || e) + '；要新开会话（或重启）才会用上',
          }
        }
      }
    }

    const displayName = name || presetId
    // v5 修复 v3 ④：回滚成功后同样做面板一致性核对（期望值 = 盘上回滚后文本里读出的指令）
    let consistencyAfterWrite = null
    if (dryRun !== true) {
      const diskText = readTextIfExists(join(agentPresetsRootDir(), presetId, 'agent.cordis.yml'))
      const expectedInst = extractCustomInstruction(typeof diskText === 'string' ? diskText : '')
      consistencyAfterWrite =
        expectedInst === null
          ? { ok: null, via: null, note: '回滚后核对没做成：盘上组成读不到或没有压缩指令' }
          : await panelConsistencyAfterWrite(ctx, presetId, expectedInst)
    }
    return send(200, Object.assign({}, result, {
      recompose,
      consistencyAfterWrite,
      nextStep: dryRun
        ? null
        : '已把「' + displayName + '」回滚到 ' + result.restoredFrom.name + '；需新开会话或重启才完全生效',
      note: dryRun ? 'dryRun：以上是计划，一个字节都没写。' : '回滚完成：回滚前已先把当前文件备份一份，回读校验通过。',
    }))
  } catch (e) {
    return send(200, { ok: false, error: { code: 'ROLLBACK_INTERNAL', message: String((e && e.message) || e) } })
  }
}

// ---------------------------------------------------------------------------
// 路由与注册
// ---------------------------------------------------------------------------

const ENDPOINTS = {
  '/config': ['GET', 'PUT'],
  '/config/test': ['POST'],
  '/templates': ['GET', 'PUT'],
  '/sessions': ['GET'],
  '/session/events': ['GET'],
  '/agent': ['GET'],
  '/agent/detect': ['GET'],
  '/agent/apply': ['POST'],
  '/agent/rollback': ['POST'],
  '/agent/backups': ['GET'],
  '/agent/cards': ['GET'],
  '/agent/card': ['GET'],
  '/agent/pack/apply': ['POST'],
  '/health': ['GET'],
}

function createHandler(ctx, log) {
  const redact = makeRedactor()
  // 进程内缓存（随 handler 生命周期，热重载即重建）：
  //   eventsCache —— 已派生的轻量事件行，按 sessionId LRU（≤MAX_CACHED_SESSIONS 个
  //     会话、TTL 20s、总字节上限 EVENTS_CACHE_MAX_BYTES 默认 128 MB；单会话超限
  //     不缓存）。不含 key、不跨会话串味（键就是 sessionId）。mem-budget 缺席时
  //     整体禁用（黑洞缓存，见 makeDisabledCache）
  //   titlesCache —— /sessions?titles=1 的投影结果，单槽 + 同样短 TTL
  const eventsCache =
    memBudget && typeof memBudget.createByteBudgetedCache === 'function'
      ? memBudget.createByteBudgetedCache({
          maxEntries: MAX_CACHED_SESSIONS,
          maxBytes: EVENTS_CACHE_MAX_BYTES,
        })
      : makeDisabledCache()
  const titlesCache = { current: null }
  return async function handler(req, res) {
    let responded = false
    const send = (status, payload) => {
      if (responded || !res || res.writableEnded || res.destroyed) return
      responded = true
      try {
        let body = JSON.stringify(payload)
        // 双保险：响应体里绝不出现 key 原文
        try {
          const k = readConfigFile().config.api.key
          if (k) body = body.split(k).join('***')
        } catch {}
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(body)
      } catch {
        try {
          res.destroy()
        } catch {}
      }
    }
    try {
      const method = String((req && req.method) || 'GET').toUpperCase()
      const url = new URL((req && req.url) || '/', 'http://dsh.local')
      let rest = url.pathname.startsWith(API_PREFIX)
        ? url.pathname.slice(API_PREFIX.length)
        : url.pathname
      if (rest !== '/') rest = rest.replace(/\/+$/, '') || '/'
      if (rest === '/' || !ENDPOINTS[rest]) {
        return send(404, err('NOT_FOUND', `未知路径 ${rest}；可用：${Object.keys(ENDPOINTS).join(' ')}`))
      }
      if (!ENDPOINTS[rest].includes(method)) {
        return send(405, err('METHOD_NOT_ALLOWED', `${rest} 只接受 ${ENDPOINTS[rest].join(' / ')}`))
      }
      if (rest === '/config' && method === 'GET') {
        const { config, configError } = readConfigFile()
        return send(200, publicConfig(config, configError))
      }
      if (rest === '/config' && method === 'PUT') return await handlePutConfig(req, send, redact)
      if (rest === '/config/test') return await handleTestConfig(send, redact)
      if (rest === '/templates' && method === 'GET') return send(200, templatesResponse())
      if (rest === '/templates' && method === 'PUT') return await handlePutTemplates(req, send, redact)
      if (rest === '/sessions') return await handleSessions(ctx, url, send, redact, log, titlesCache)
      if (rest === '/session/events') return await handleEvents(ctx, url, send, redact, log, eventsCache)
      if (rest === '/agent') return await handleAgentGet(ctx, url, req, send)
      if (rest === '/agent/detect') return await handleAgentDetect(ctx, url, req, send)
      if (rest === '/agent/apply') return await handleAgentApply(ctx, url, req, send)
      if (rest === '/agent/rollback') return await handleAgentRollback(ctx, url, req, send)
      if (rest === '/agent/backups') return await handleAgentBackups(ctx, url, req, send)
      if (rest === '/agent/cards') return await handleAgentCards(ctx, url, req, send)
      if (rest === '/agent/card') return await handleAgentCard(ctx, url, req, send)
      if (rest === '/agent/pack/apply') return await handleAgentPackApply(ctx, url, req, send)
      if (rest === '/health') return await handleHealth(ctx, req, send)
      return send(404, err('NOT_FOUND', `未知路径 ${rest}`))
    } catch (e) {
      log.error(`[magictarven] handler 内部错误：${e?.stack || e}`)
      return send(500, err('INTERNAL', redact(e?.message || String(e))))
    }
  }
}

function registerHttpApi(ctx, scope, log) {
  const webServer = scope && scope.webServer
  if (!webServer || typeof webServer.register !== 'function') {
    log.warn('[magictarven] webServer 不可用，跳过 HTTP API 注册（插件保持可用）')
    return
  }
  const effectFn =
    (scope && typeof scope.effect === 'function' && scope.effect) ||
    (typeof ctx.effect === 'function' ? ctx.effect : null)
  const run = effectFn ? (fn) => effectFn(fn) : (fn) => fn()
  const wrapDispose = (dispose) => () => {
    try {
      if (typeof dispose === 'function') dispose()
    } catch {}
  }
  const handler = createHandler(ctx, log)
  if (memBudgetLoadError) {
    log.warn(
      `[magictarven] mem-budget 不可用（${memBudgetLoadError?.message || memBudgetLoadError}），事件缓存已禁用（/session/events 每次重新取）；其余功能不受影响`,
    )
  }
  if (rpAgentLoadError) {
    log.warn(
      `[magictarven] rp-agent 不可用（${rpAgentLoadError?.message || rpAgentLoadError}），/agent/apply、/agent/backups、/agent/rollback、/agent/cards、/agent/card 与 /agent/pack/apply 已降级为可读错误；其余 rest 不受影响`,
    )
  }
  // 第一条路由：同步注册，包进 effect（热重载时 dispose 掉旧路由，不留野路由）。
  run(() => {
    const dispose = webServer.register({ kind: 'prefix', path: API_PREFIX, handler })
    return wrapDispose(dispose)
  }, 'magictarven: HTTP API')
  log.info(`[magictarven] HTTP API 已注册（prefix ${API_PREFIX}）`)
  // 第二条路由（并入的提示词查看器）：与第一条【同一轮同步】注册（effect 必须在
  // apply 调用栈内挂上 fiber，见模块顶层的预加载说明）。prompt-viewer.js 加载失败
  // 或 createHandler 抛错都只降级本条：第一条路由不受影响，apply() 也绝不抛错。
  if (promptViewerFactory === null) {
    log.warn(
      `[magictarven] 提示词查看器不可用，已降级（${promptViewerLoadError?.message || promptViewerLoadError}）；/api 不受影响`,
    )
  } else {
    try {
      const pvHandler = promptViewerFactory({})
      run(() => {
        const dispose = webServer.register({ kind: 'prefix', path: PROMPT_PREFIX, handler: pvHandler })
        return wrapDispose(dispose)
      }, 'magictarven: prompt viewer')
      log.info(`[magictarven] 提示词查看器已注册（prefix ${PROMPT_PREFIX}）`)
    } catch (e) {
      log.warn(`[magictarven] 提示词查看器注册失败，已降级（/api 不受影响）：${e?.stack || e}`)
    }
  }
}

/**
 * 入口：绝不抛错。webServer 走 inject（服务晚到也能挂上）；
 * 旧版宿主没有 ctx.inject 时退化为 ctx.get 即时挂载。
 */
export function apply(ctx) {
  const log = makeLog(ctx)
  try {
    if (!ctx || typeof ctx !== 'object') return
    const mount = (scope) => {
      try {
        registerHttpApi(ctx, scope || {}, log)
      } catch (e) {
        log.error(`[magictarven] HTTP API 注册失败（已降级）：${e?.stack || e}`)
      }
    }
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], mount)
    } else if (typeof ctx.get === 'function') {
      const webServer = ctx.get('webServer')
      if (webServer !== undefined) mount({ webServer })
    }
  } catch (e) {
    log.error(`[magictarven] apply 失败（已降级，不影响宿主启动）：${e?.stack || e}`)
  }
}
