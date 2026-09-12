/**
 * dsh-memory-archive —— 宿主半侧
 *
 * 职责（规格：《GLM任务-记忆库-v4-宿主半侧.md》，接口契约冻结）：
 *   1) 配置存储：用户自配 API（baseURL/key/model）+ 根模式，落盘到
 *      `<DSH_HOME | ~/.dsh>/dsh-memory-archive/config.json`（原子写、0600、读坏回落默认值）。
 *   2) HTTP API：注册两条 prefix 路由 —— `/dsh-memory-archive/api`（读写配置、测连通、
 *      精确读 DSH 会话事件、提示词模板 /templates、健康自检）与 `/dsh-memory-archive/prompt`
 *      （并入的 dsh-prompt-viewer 宿主半侧，实现见 ./prompt-viewer.js）。
 *   3) 提示词模板：压缩指令与占位前言存进配置可选段 prompts（null = 内置默认），
 *      只经 /templates 读写，GET/PUT /config 的既有契约不变。
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
  renameSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const name = 'dsh-memory-archive'

/**
 * 不写死服务依赖：webServer 用「有就注册、没有就跳过」，sessionQuery 在请求时按需
 * ctx.get —— 两者缺失时插件都要能 apply 成功（宿主启动不能被本插件拖死）。
 */
export const inject = []

const API_PREFIX = '/dsh-memory-archive/api'
const PROMPT_PREFIX = '/dsh-memory-archive/prompt' // 并入的提示词查看器（./prompt-viewer.js）
const TEMPLATES_MAX_CHARS = 20000 // 单个提示词模板的字符上限
const PLUGIN_DIR_NAME = 'dsh-memory-archive'
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
    `[dsh-memory-archive] /session/events sessionId=${String(key).slice(0, 24)} 事件行超过事件缓存字节上限 ${Math.round(EVENTS_CACHE_MAX_BYTES / (1024 * 1024))} MB，不缓存（每次重新取）`,
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
  log.info(`[dsh-memory-archive] /sessions titles=${wantTitles ? 1 : 0} 返回 ${data.sessions.length} 条`)
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
        `[dsh-memory-archive] /session/events sessionId=${sessionId.slice(0, 24)} 缓存命中（total=${cached.length}，limit=${limit}，offset=${offset}）`,
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
    `[dsh-memory-archive] /session/events sessionId=${sessionId.slice(0, 24)} 返回 ${Math.min(limit, Math.max(0, total - offset))} 条（total=${total}，limit=${limit}，offset=${offset}，refresh=${refresh ? 1 : 0}）`,
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
// 路由与注册
// ---------------------------------------------------------------------------

const ENDPOINTS = {
  '/config': ['GET', 'PUT'],
  '/config/test': ['POST'],
  '/templates': ['GET', 'PUT'],
  '/sessions': ['GET'],
  '/session/events': ['GET'],
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
      if (rest === '/health') return await handleHealth(ctx, req, send)
      return send(404, err('NOT_FOUND', `未知路径 ${rest}`))
    } catch (e) {
      log.error(`[dsh-memory-archive] handler 内部错误：${e?.stack || e}`)
      return send(500, err('INTERNAL', redact(e?.message || String(e))))
    }
  }
}

function registerHttpApi(ctx, scope, log) {
  const webServer = scope && scope.webServer
  if (!webServer || typeof webServer.register !== 'function') {
    log.warn('[dsh-memory-archive] webServer 不可用，跳过 HTTP API 注册（插件保持可用）')
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
      `[dsh-memory-archive] mem-budget 不可用（${memBudgetLoadError?.message || memBudgetLoadError}），事件缓存已禁用（/session/events 每次重新取）；其余功能不受影响`,
    )
  }
  // 第一条路由：同步注册，包进 effect（热重载时 dispose 掉旧路由，不留野路由）。
  run(() => {
    const dispose = webServer.register({ kind: 'prefix', path: API_PREFIX, handler })
    return wrapDispose(dispose)
  }, 'dsh-memory-archive: HTTP API')
  log.info(`[dsh-memory-archive] HTTP API 已注册（prefix ${API_PREFIX}）`)
  // 第二条路由（并入的提示词查看器）：与第一条【同一轮同步】注册（effect 必须在
  // apply 调用栈内挂上 fiber，见模块顶层的预加载说明）。prompt-viewer.js 加载失败
  // 或 createHandler 抛错都只降级本条：第一条路由不受影响，apply() 也绝不抛错。
  if (promptViewerFactory === null) {
    log.warn(
      `[dsh-memory-archive] 提示词查看器不可用，已降级（${promptViewerLoadError?.message || promptViewerLoadError}）；/api 不受影响`,
    )
  } else {
    try {
      const pvHandler = promptViewerFactory({})
      run(() => {
        const dispose = webServer.register({ kind: 'prefix', path: PROMPT_PREFIX, handler: pvHandler })
        return wrapDispose(dispose)
      }, 'dsh-memory-archive: prompt viewer')
      log.info(`[dsh-memory-archive] 提示词查看器已注册（prefix ${PROMPT_PREFIX}）`)
    } catch (e) {
      log.warn(`[dsh-memory-archive] 提示词查看器注册失败，已降级（/api 不受影响）：${e?.stack || e}`)
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
        log.error(`[dsh-memory-archive] HTTP API 注册失败（已降级）：${e?.stack || e}`)
      }
    }
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], mount)
    } else if (typeof ctx.get === 'function') {
      const webServer = ctx.get('webServer')
      if (webServer !== undefined) mount({ webServer })
    }
  } catch (e) {
    log.error(`[dsh-memory-archive] apply 失败（已降级，不影响宿主启动）：${e?.stack || e}`)
  }
}
