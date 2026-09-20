// sections-capture —— 组装捕获（真相源）+ 默认落盘 + C4 段结构数据访问（编辑器 v2 · B 流）
//
// 契约：docs/INTERFACES-editor-v2.md（W0 冻结版）C4/C5。这个模块只做三件事：
//   1) 挂 `system-prompt/assemble` 瀑布监听，从 context.agent.session.id 认会话，
//      从 assembly.sections 拿**运行时真段名**与真文本 —— ⛔ 不做任何"名单/标记子串"式的段识别；
//      段清单完全来自瀑布载荷，名单外（乃至未来新增）的段天然可见。
//   2) 按 C5 默认落盘**元数据**（段名 + order + 字数 + hash，正文不存）到
//      <storageDir>/dsh-memory-archive/assembly/<sessionId>.jsonl（storageDir 与 lib/index.js 同一套推导）。
//      全文落盘必须显式开（env MAGICTARVEN_SECTIONS_FULLTEXT=1 或 options.fullText），默认关。
//   3) resolveSections(sessionId, turn)：C4 的数据访问面；没有捕获记录时返回
//      source:"inferred"（降级，segments 为空数组），绝不抛、绝不把推断标成 captured。
//
// 真相源接口（deepseek-harness，只读核对过）：
//   packages/core/system-prompt/src/index.ts:31   'system-prompt/assemble'(assembly, context, next) —— 瀑布
//   packages/core/system-prompt/src/index.ts:87   AssembledSection { name, text }（text 为**插值前**）
//   packages/core/system-prompt/src/index.ts:263  renderPrompt：sections.map(interpolate).filter(非空).join('\n\n')
//   packages/core/agent-loop/src/agent.ts:239     preStep 里 assemble(assembleContextFor(this, signal))
//   packages/core/agent/src/dispatch.ts:174       assembleContextFor 返回 { agent, scope: agent, signal? }
//   packages/core/agent-loop/src/index.ts:416     ctx.systemPrompt.variable('cwd', c => c.agent?.session.header.cwd)
//                                                 ⇒ 真实回合 context.agent 一定拿得到（§3 实测见 B 流报告）
//   packages/core/agent-loop/src/agent.ts:101     sessionProjections.stateOf(session, 'turnBoundary')?.lastTurn
//
// order 与 mutability 的来源（尽量权威，逐级回退，全部 try/catch 包住）：
//   首选：systemPrompt.layers.merge(scope, layer => layer.sections) —— 注册定义本身，
//         拿到真 order 与"text 是不是函数"（mutabilityBasis:"definition"，最权威）。
//         （layers 是 TS 私有字段，运行时可读；读不到就走回退，不影响捕获。）
//   回退：段名按 SECTION_ORDERS 命名约定转键后调 getSectionOrder（如 harness:identity →
//         HARNESS_IDENTITY）；转不出 ⇒ order:null，mutability:"unknown"。
//   ⛔ 这不是名单制：任何段名都进清单，order/可变性只是尽力而为的注解；查不出就如实 null/unknown。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { locateSections, isFullyLocated } from './final-text-locate.js'

const SCHEMA_VERSION = 1
const FILE_KIND = 'dsh-memory-archive-assembly'

// entry 兼容（cordis Plugin.Object 的顶层声明）：想以独立条目挂载（或经 ctx.plugin(module)
// 挂载）时，cordis 从这里读 name/inject。registerSectionsCapture 内部用的同一份列表。
export const name = 'dsh-memory-archive-sections-capture'
export const inject = ['systemPrompt', 'sessionProjections']
const MAX_TURNS_PER_SESSION_DEFAULT = 200 // C5：每会话保留最近 N 楼
const MAX_TOTAL_BYTES_DEFAULT = 32 * 1024 * 1024 // C5：全局总量上限
// 同时最多为多少个会话保留"等最终正文来定位"的待定记录（每会话只留最后一条，正文只在内存里）。
const PENDING_MAX_SESSIONS = 64
const SWEEP_INTERVAL_MS = 60_000 // 全局总量扫描的节奏（不必每次写都扫）
const FILENAME_SAFE = /[^A-Za-z0-9._-]/g

// ---------------------------------------------------------------------------
// storageDir 推导：与 lib/index.js 的 storageDir() 同一套约定（DSH_HOME 或 ~/.dsh）
// —— 这里自带一份，避免反向依赖 index.js（那个文件归 D）。
// ---------------------------------------------------------------------------

function expandHome(p, home = homedir()) {
  if (p === '~') return home
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2))
  return p
}

/**
 * 存储目录推导：与 `lib/index.js` 的 `storageDir()` **逐字相同**（DSH_HOME 或 ~/.dsh）。
 * ★ 两份必须一致：`_selftest-sections.mjs` 有断言钉住解析结果相同，防漂移。
 *
 * ★ 改名遗留（2026-09-14 改回 `dsh-memory-archive`）：盘上可能只有旧名 `magictarven/` 目录
 *   （那个名字是中途用过的），新名目录不存在时回退读它 —— 否则老用户会以为"数据没了"。
 *   两个都在时不猜：用新名目录（并库由一次性迁移工具做，见 CHANGELOG）。
 */
export const PLUGIN_DIR_NAME = 'dsh-memory-archive'
export const LEGACY_DIR_NAMES = ['magictarven']

export function storageDir(env = process.env) {
  const configured = env.DSH_HOME
  const dshHome =
    configured !== undefined && String(configured).trim() !== ''
      ? String(configured)
      : join(homedir(), '.dsh')
  const root = resolve(expandHome(dshHome))
  const primary = join(root, PLUGIN_DIR_NAME)
  if (existsSync(primary)) return primary
  for (const legacy of LEGACY_DIR_NAMES) {
    const dir = join(root, legacy)
    if (existsSync(dir)) return dir
  }
  return primary
}

export function assemblyDir(env = process.env, override) {
  return override?.dir || join(storageDir(env), 'assembly')
}

// ---------------------------------------------------------------------------
// 落盘（C5）：元数据默认、有界、容错。
// 文件布局：首行 {"v":1,"kind":"dsh-memory-archive-assembly"}，之后每楼一行（同一楼多步
// 组装只保留最后一次 —— 与"该楼最终发出的请求"对齐）。
// ---------------------------------------------------------------------------

function safeSessionFileName(sessionId) {
  const base = String(sessionId).replace(FILENAME_SAFE, '_')
  return base.length > 120 ? base.slice(0, 120) : base
}

function sessionFilePath(dir, sessionId) {
  return join(dir, `${safeSessionFileName(sessionId)}.jsonl`)
}

/** 读一个落盘文件 ⇒ { version, records }；任何异常都不抛（返回可读的失败态）。 */
export function readAssemblyFile(path) {
  try {
    if (!existsSync(path)) return { version: null, records: [], missing: true }
    const content = readFileSync(path, 'utf8')
    const lines = content.split('\n').filter((line) => line.trim() !== '')
    if (lines.length === 0) return { version: null, records: [], empty: true }
    let header
    try {
      header = JSON.parse(lines[0])
    } catch {
      return { version: null, records: [], corrupt: true }
    }
    const version = header && typeof header === 'object' ? header.v ?? header.schema ?? null : null
    // 版本不认识 ⇒ 当作"未记录"（契约 C5），不抛；写侧会把旧文件改名另存（见 compactWrite）。
    if (version !== SCHEMA_VERSION) return { version, records: [], unknownVersion: true }
    const records = []
    for (let i = 1; i < lines.length; i += 1) {
      try {
        const row = JSON.parse(lines[i])
        if (row && typeof row === 'object') records.push(row)
      } catch {
        // 单行坏 ⇒ 跳过那一行，其余照常（不抛）。
      }
    }
    return { version, records }
  } catch {
    return { version: null, records: [], unreadable: true }
  }
}

/**
 * 原子化重写一个会话文件：按 turn 归并（后写覆盖先写）、按 capturedAt 稳定排序、
 * 裁到最近 maxTurns 楼。旧文件版本不认识时改名保留（不销毁数据），另起新文件。
 * （导出仅供自检台直测裁剪语义；运行时由模块内部的写队列调用。）
 */
export function compactWrite(path, records, maxTurns) {
  const byTurn = new Map()
  for (const row of records) {
    if (!row || typeof row !== 'object' || typeof row.turn !== 'number') continue
    byTurn.set(row.turn, row) // 同一楼：最后一次组装为准
  }
  const merged = [...byTurn.values()]
    .sort((a, b) => a.turn - b.turn)
    .slice(-maxTurns)
  const body = [`${JSON.stringify({ v: SCHEMA_VERSION, kind: FILE_KIND })}`, ...merged.map((row) => JSON.stringify(row))].join('\n') + '\n'
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, body, 'utf8')
  renameSync(tmp, path)
  return merged
}

/** 全局总量上限（C5 32 MB）：超限按 mtime 淘汰最旧的会话文件。返回被删的文件数。 */
function sweepOverBudget(dir, maxTotalBytes) {
  let removed = 0
  try {
    if (!existsSync(dir)) return 0
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => {
        const p = join(dir, name)
        try {
          return { p, size: statSync(p).size, mtime: statSync(p).mtimeMs }
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.mtime - b.mtime)
    let total = files.reduce((sum, f) => sum + f.size, 0)
    for (const f of files) {
      if (total <= maxTotalBytes) break
      try {
        unlinkSync(f.p)
        total -= f.size
        removed += 1
      } catch {
        break // 删不动就到此为止，不抛
      }
    }
  } catch {}
  return removed
}

// ---------------------------------------------------------------------------
// 捕获
// ---------------------------------------------------------------------------

function hash16(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 16)
}

/** SECTION_ORDERS 的键是 SCREAMING_SNAKE；运行时段名是 kebab-colon。约定转换，转不出返回 null。 */
export function sectionOrderKey(name) {
  const key = String(name)
    .split(':')
    .map((part) => part.replace(/-/g, '_').toUpperCase())
    .join('_')
  return /^[A-Z][A-Z0-9_]*$/.test(key) ? key : null
}

/**
 * 从 systemPrompt 服务尽力拿"段注册定义表"（name → { order, text, complete }）。
 * layers 是 TS 私有字段，运行时可读；读不到返回 null（调用方走回退，不影响捕获）。
 */
function readSectionDefs(systemPrompt, scope) {
  try {
    const layers = systemPrompt?.layers
    if (layers && typeof layers.merge === 'function') {
      const merged = layers.merge(scope, (layer) => layer.sections)
      if (merged && typeof merged.get === 'function') return merged
    }
  } catch {}
  return null
}

/**
 * 官方渲染（system-prompt/src/index.ts:263-268 逐字语义）：
 *   sections.map(interpolate).filter(text => text.length > 0).join('\n\n')
 * 这里按同样语义实现插值（严格 {{var}}，未知/未定义变量按官方语义抛错 —— 调用方自捕）。
 * 只用于进程内自检比对，绝不落盘、绝不出模块。
 */
function interpolateStrict(text, variables) {
  return String(text).replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (raw, name) => {
    if (!Object.prototype.hasOwnProperty.call(variables ?? {}, name)) {
      throw new Error(`unknown prompt variable ${JSON.stringify(name)}`)
    }
    const value = variables[name]
    if (value === undefined) throw new Error(`undefined prompt variable ${JSON.stringify(name)}`)
    return String(value)
  })
}

export function renderJoinedSystem(sections, variables) {
  return sections
    .map((section) => interpolateStrict(section.text, variables))
    .filter((text) => text.length > 0)
    .join('\n\n')
}

/**
 * 官方渲染口径（system-prompt/src/index.ts:263-268 逐字语义）自拼 + 切片自洽校验
 * （纯函数，自检台直测 —— 反证 A/B 就靠它红）：
 *   rendered = texts.filter(非空).join('\n\n')
 *   offsets[i] = Σ_{j<i, 非空} (len_j + 2)；插值后 0 字的段不占位 ⇒ offset 记 null（⛔ 不编 0）
 * claimedOffsets 传入时逐段核对（任何一位对不上 ⇒ ok:false，绝不产出可能错位的 offset）；
 * 返回带 rendered，供调用方记 renderedChars/renderedHash（客户端切片前与 header.system 对凭据）。
 */
export function computeSectionsLayout(texts, claimedOffsets = null) {
  const list = (Array.isArray(texts) ? texts : []).map((t) => String(t ?? ''))
  const rendered = list.filter((t) => t.length > 0).join('\n\n')
  const nonEmptyIdx = []
  list.forEach((t, i) => {
    if (t.length > 0) nonEmptyIdx.push(i)
  })
  const offsets = new Array(list.length).fill(null)
  let acc = 0
  for (const i of nonEmptyIdx) {
    offsets[i] = acc
    acc += list[i].length + 2
  }
  const sumChars = nonEmptyIdx.reduce((n, i) => n + list[i].length, 0)
  // 长度自洽（§3.3.2）：Σ chars + 2×(非空段数−1) === rendered.length
  const selfConsistent = sumChars + Math.max(0, nonEmptyIdx.length - 1) * 2 === rendered.length
  if (!selfConsistent) return { ok: false, reason: 'length-mismatch', rendered, offsets }
  if (claimedOffsets !== null && claimedOffsets !== undefined) {
    const claimed = Array.isArray(claimedOffsets) ? claimedOffsets : null
    const shapeOk = Array.isArray(claimed) && claimed.length === list.length
    if (!shapeOk || claimed.some((c, i) => c !== offsets[i])) {
      return { ok: false, reason: 'offset-mismatch', rendered, offsets }
    }
  }
  return { ok: true, reason: null, rendered, offsets }
}

/**
 * 由一次瀑布载荷构造 C5 记录（不含 sessionId —— 它在文件名里）。
 * fullText=true 时才带正文（sections[].text），默认关。
 *
 * 口径（20260914 M1 单 §3.1）：chars/hash 一律取**插值后**的段文本 —— 会话日志
 * header.system 里就是插值后的，客户端要按 offset+chars 从那里切片。
 * （导出仅供自检台直测纯函数行为；运行时由模块内部的瀑布监听调用。）
 */
export function buildRecord(assembly, assembleContext, defs, options) {
  const fullText = options.fullText === true
  const variables = assembly?.variables ?? {}
  let interpolateFailed = false
  const sections = (assembly?.sections ?? []).map((section) => {
    const def = defs?.get(section.name) ?? null
    const hasDefinition = def !== null && typeof def === 'object'
    // 首选注册定义（真 order + "text 是不是函数"）；拿不到走命名约定回退。
    let order = hasDefinition && Number.isFinite(def.order) ? def.order : null
    let mutability = hasDefinition ? (typeof def.text === 'function' ? 'per-turn' : 'static') : 'unknown'
    let mutabilityBasis = hasDefinition ? 'definition' : 'unknown'
    if (order === null) {
      const key = sectionOrderKey(section.name)
      // getSectionOrder 只认 SECTION_ORDERS 的键；未知名返回 undefined ⇒ 如实 null。
      order = null
      if (key && typeof options.getSectionOrder === 'function') {
        const lookedUp = options.getSectionOrder(key)
        if (Number.isFinite(lookedUp)) order = lookedUp
      }
    }
    // 插值无条件先做（§3.1）；失败保底用原文，整条记录的 offset 标不可用（见下）
    let finalText
    try {
      finalText = interpolateStrict(String(section.text ?? ''), variables)
    } catch {
      interpolateFailed = true
      finalText = String(section.text ?? '')
    }
    const record = { name: section.name, order, chars: finalText.length, hash: hash16(finalText), mutability, mutabilityBasis }
    if (hasDefinition && def.complete === true) record.complete = true
    if (fullText) record.text = finalText
    return { record, text: finalText }
  })
  // complete 段（宿主在瀑布后把它还原成唯一段 —— system-prompt/src/index.ts assemble 尾部）：
  // 捕获按"实际发出的 system"对齐 ⇒ 存在 complete 段时只保留它。
  const effective = sections.some((s) => s.record.complete === true)
    ? sections.filter((s) => s.record.complete === true)
    : sections
  // offset + 自校验（§3.2/§3.3）：按官方渲染口径自拼 rendered，长度自洽才发 offset；
  // 插值失败过的记录整个放弃 offset（此时的 rendered 不是真实发出的 system，凭据不可信）。
  const layout = interpolateFailed ? null : computeSectionsLayout(effective.map((s) => s.text))
  effective.forEach(({ record }, i) => {
    if (layout && layout.ok) {
      record.offset = record.chars > 0 ? layout.offsets[i] : null // 0 字段不占位：null，⛔ 不编 0
      record.renderedChars = layout.rendered.length
      record.renderedHash = hash16(layout.rendered)
    } else {
      record.offset = null
      record.offsetUnavailableReason = interpolateFailed ? 'interpolate-failed' : 'layout-mismatch'
    }
  })
  const contexts = (assembly?.contexts ?? []).map((ctx) => {
    const record = { name: ctx.name, chars: String(ctx.text ?? '').length }
    if (fullText) record.text = String(ctx.text ?? '')
    return record
  })
  const tools = (assembly?.tools ?? []).map((tool) => {
    const raw = JSON.stringify(tool?.parameters ?? {})
    const record = { name: tool.name, chars: String(raw).length, hash: hash16(raw) }
    if (fullText) record.text = raw
    return record
  })
  const out = {
    turn: null, // 由调用方填（sessionProjections / agent.phase）
    capturedAt: new Date().toISOString(),
    agentId: assembleContext?.agent?.id ?? null,
    sections: effective.map((s) => s.record),
    contexts,
    tools,
  }
  // ★ 段文本（插值后）**只留在内存里**给调用方用：定义成**非枚举** ⇒ `JSON.stringify` 不会带上它，
  //   C5"组装捕获不落正文"的铁律一字不变。
  //   用途：装配期算不出可信 offset（anima 是 `next()` 之后才改写、DSH 之后还做 complete 覆盖），
  //   所以要等 DSH 把**最终**系统正文写进会话日志（`system/message`）后，按段序在它里面定位
  //   （见 lib/final-text-locate.js）。那份正文只在这一个进程里短暂驻留（每会话一条，有界）。
  try {
    Object.defineProperty(out, '__sectionTexts', {
      value: effective.map((s) => s.text),
      enumerable: false,
      configurable: true,
      writable: true,
    })
  } catch { /* 定不上去也不影响既有行为 */ }
  return out
}

// 调试探针（§3 最小验证）：MAGICTARVEN_SECTIONS_DEBUG=1 时把实测结构写进
// <dir>/_debug.log（只含键名/ID/计数，不含任何正文）。默认关。
function debugLog(dir, payload) {
  try {
    writeFileSync(join(dir, '_debug.log'), `${JSON.stringify({ at: new Date().toISOString(), ...payload })}\n`, { flag: 'a' })
  } catch {}
}

// ---------------------------------------------------------------------------
// 注册（冻结 API）：registerSectionsCapture(context, options?)
// ---------------------------------------------------------------------------

const REGISTERED = new WeakSet() // 幂等：同一 ctx 重复注册直接跳过（index.js 挂载 + 热重载双保险）

export function registerSectionsCapture(context, options = {}) {
  if (!context || typeof context !== 'object') return null
  if (typeof context.plugin !== 'function') return null // 挂不上 cordis 的场合：安全放弃，绝不抛
  if (REGISTERED.has(context)) return null
  REGISTERED.add(context)

  const env = process.env
  const opts = {
    dir: options.dir || assemblyDir(env, options),
    maxTurns: Number.isFinite(options.maxTurns) ? options.maxTurns : MAX_TURNS_PER_SESSION_DEFAULT,
    maxTotalBytes: Number.isFinite(options.maxTotalBytes) ? options.maxTotalBytes : MAX_TOTAL_BYTES_DEFAULT,
    fullText: options.fullText === true || env.MAGICTARVEN_SECTIONS_FULLTEXT === '1',
    debug: options.debug === true || env.MAGICTARVEN_SECTIONS_DEBUG === '1',
    getSectionOrder: null, // 首次用到时从 systemPrompt 服务取
  }

  // 用自带 inject 的内联插件（cordis Plugin.Object）：调用方（index.js 的 apply）自己的
  // inject 列表里没有 systemPrompt 也没关系 —— cordis 会为这个子 fiber 解析依赖。
  // （rp-agent.js 的真机教训：没有 inject 声明的代理属性访问会被 cordis 拒绝。）
  const plugin = {
    name: 'dsh-memory-archive-sections-capture',
    inject: ['systemPrompt', 'sessionProjections'],
    apply: (scope) => {
      let pendingSweep = 0
      // 每个会话一条写队列：瀑布监听是同步返回 next() 的，落盘全部异步化，绝不阻塞组装。
      const queues = new Map()

      const enqueueWrite = (sessionId, record) => {
        const path = sessionFilePath(opts.dir, sessionId)
        const prev = queues.get(sessionId) ?? Promise.resolve()
        const next = prev
          .catch(() => {})
          .then(async () => {
            try {
              let existing = { version: SCHEMA_VERSION, records: [] }
              if (existsSync(path)) {
                existing = readAssemblyFile(path)
                if (existing.unknownVersion) {
                  // 版本不认识：旧文件改名保留（不销毁、不抛），另起新版本文件。
                  try {
                    renameSync(path, `${path}.unrecognized-${Date.now()}`)
                  } catch {}
                  existing = { version: SCHEMA_VERSION, records: [] }
                }
              }
              compactWrite(path, [...existing.records, record], opts.maxTurns)
            } catch (e) {
              try {
                scope?.logger?.warn?.(`[mt-sections] 落盘失败（忽略，不影响组装）：${e?.message || e}`)
              } catch {}
            }
            const now = Date.now()
            if (now - pendingSweep > SWEEP_INTERVAL_MS) {
              pendingSweep = now
              sweepOverBudget(opts.dir, opts.maxTotalBytes)
            }
          })
        queues.set(sessionId, next)
        next.finally(() => {
          if (queues.get(sessionId) === next) queues.set(sessionId, Promise.resolve())
        })
      }

      const resolveTurn = (agent) => {
        // 首选投影（agent-loop 自己就这么读：agent.ts:101）；回退 agent.phase.turn（运行时字段）。
        try {
          const projections = scope.sessionProjections
          const last = projections?.stateOf?.(agent?.session, 'turnBoundary')?.lastTurn
          if (Number.isFinite(last)) return last
        } catch {}
        try {
          const phaseTurn = agent?.phase?.turn
          if (Number.isFinite(phaseTurn)) return phaseTurn
        } catch {}
        return null
      }

      // ★★ 我们**必须站在瀑布最外层，并且读它的返回值**（2026-09-17 真机判据实验后定案，
      //   替代原先的「延迟接管」）：
      //   · 有些插件是在 `await next()` **之后**才改写 `out.sections` 的 —— `anima:memory`
      //     （dsh-anima-rag/lib/index.js:1029-1093）与世界书都是这种。排在它**后面**的监听器
      //     只能看到它改写之前的半成品；而它的产物会**沿返回值往上传**，所以只有排在它
      //     **前面**、并且**看返回值**的人拿得到。
      //   · 曾经的解法是"第一个会话事件时追加一份下游监听"（lib/deferred-install.js）—— 那是为了
      //     看 Tavern 的 `:part:` 展开（Tavern 是**往下传**的）。实测这个理由已过期（整个捕获库里
      //     `:part:` 段 0 个），而且往下游挪恰好离 anima 更远。
      //   · 现在：站最外层 + 读返回值 = **DSH 真正要发出去的那一份**（下游一切改写都在里面）。
      //     判据（真机 session-c37c466c turn 7）：入参 Σ=8923 / `anima:memory`=0；
      //     返回值 Σ=10972 / `anima:memory`=2049，且 10972+2×(6−1)=10982 **正好等于**
      //     该楼真正的系统消息长度。
      //   ⛔ 凭据可不可信的判据仍然是记录上的 `finalized`（等最终正文来定位后才发布 offset），
      //      不是"排在哪"。`listenerMode` 只是排查用的注解（客户端不读它）。

      /** 每会话留一份"等最终正文来定位"的待定记录（有界，只留该会话最后一条）。 */
      const pending = new Map()
      /**
       * 每会话"最近一份**真正发出去**的系统正文"（有界，同上）。
       *
       * ★ 为什么它能当别楼的底本（2026-09-18 源码核实，不是近似）：
       *   宿主只在**正文变了**的时候才追加 `system/message` ——
       *   `core/agent-loop/src/runtime-context.ts:94`：`if (latest.text === rendered) return []`，
       *   而 `latest` 取的是 `findLast(node => node.text !== '')`（同文件 :87）那一份。
       *   ⇒ **本楼没有 `system/message` ⟺ 本楼发出去的系统正文与上一份逐字节相同。**
       *   所以底本回退拿的就是**同一份文本**，不是"退而求其次的近似"。
       */
      const lastFinal = new Map()

      /**
       * 拿一份系统正文给该楼待定记录定 offset，然后**覆写**该楼记录
       * （`compactWrite` 同楼后写覆盖先写，所以就是"补完"那一条）。
       * ⛔ 只有**全部非空段都落位**才发布 offset —— 部分命中说明正文与我们的段表不是同一份，
       *   此时宁可不给正文位置，也不给可能错位的（界面上会如实显示"未记录位置"）。
       * @param basis `'own'` = 本楼宿主重发了系统提示词；`'carried'` = 本楼没重发，沿用上一份
       * @param carriedFromTurn 沿用时，那上一份是哪一楼的（如实写进记录，供界面说明）
       * @returns {{ok:boolean, reason:string, matched?:number, total?:number}}
       */
      const applyFinalText = (sessionId, finalText, dshTurn, basis, carriedFromTurn) => {
        const p = pending.get(sessionId)
        if (p === undefined) return { ok: false, reason: 'no-pending' }
        if (Number.isFinite(dshTurn) && Number.isFinite(p.record.turn) && dshTurn !== p.record.turn) {
          return { ok: false, reason: 'turn-mismatch' }
        }
        if (p.record.finalized === true) return { ok: false, reason: 'already-finalized' }
        // ⛔ 必须在**楼号校验之后**才打这个标记：楼号对不上的 `system/message` 不是"本楼的正文"，
        //   打了它就会把待定的底本回退误判成 `had-own-text` 而白白放弃。
        if (basis === 'own') p.sawOwnText = true
        const texts = Array.isArray(p.record.__sectionTexts) ? p.record.__sectionTexts : []
        const r = locateSections(
          p.record.sections.map((s, i) => ({ name: s.name, text: texts[i] })),
          finalText,
        )
        if (!isFullyLocated(r)) {
          const why = 'locate-' + r.reason
          if (p.record.finalizeReason !== why) { // 同一楼可能有多条 system/message：只改一次，不刷盘
            p.record.finalizeReason = why
            enqueueWrite(sessionId, p.record)
          }
          // ★★ **失败也要能自查**（2026-09-18 真机 turn 10/12 只报 `locate-partial` 却看不出
          //   是哪一段坏的）：如实记下**没落位的段名**与三类计数。⛔ 只记名字与计数，不记正文。
          //   界面据此把"为什么给不出位置"讲清楚 —— 这正是"切不到就老实说"的一部分。
          const miss = []
          const locWhy = {}
          for (let i = 0; i < p.record.sections.length; i += 1) {
            if ((texts[i] ?? '') === '') continue
            if (r.offsets[i].offset === null) miss.push(p.record.sections[i].name)
            const rr = r.reasons?.[i]
            // 四个失败码含义完全不同（anchor-miss / blocked / nonpositive），⛔ 不许糊成一句
            if (rr === 'anchor-miss' || rr === 'blocked' || rr === 'nonpositive') locWhy[p.record.sections[i].name] = rr
          }
          const counts = { exact: r.exact, anchored: r.anchored, total: r.total }
          const prevMiss = Array.isArray(p.record.locateMiss) ? p.record.locateMiss.join(',') : ''
          const prevCounts = p.record.locateCounts ? JSON.stringify(p.record.locateCounts) : ''
          const prevWhy = p.record.locateWhy ? JSON.stringify(p.record.locateWhy) : ''
          if (prevMiss !== miss.join(',') || prevCounts !== JSON.stringify(counts) || prevWhy !== JSON.stringify(locWhy)) {
            p.record.locateMiss = miss
            p.record.locateCounts = counts
            if (Object.keys(locWhy).length > 0) p.record.locateWhy = locWhy
            else delete p.record.locateWhy
            enqueueWrite(sessionId, p.record)
          }
          return { ok: false, reason: r.reason, matched: r.matched, total: r.total, miss, counts, why: locWhy }
        }
        const renderedHash = hash16(finalText)
        for (const [i, s] of p.record.sections.entries()) {
          const o = r.offsets[i]
          s.offset = o.offset
          s.renderedChars = r.renderedChars
          s.renderedHash = renderedHash
          if (o.anchored === true) {
            // ★ **锚点定界**（2026-09-18）：这一段的内容被宿主改写过了（逐字匹配不上），
            //   所以它的 `chars/hash` 一律**以最终正文的切片为准** ——
            //   铁律「底本 = 实际文本」：面板要显示的是**真正发出去的那一版**。
            //   界面据 `anchored` 如实区分"逐字匹配"与"锚点定界"（边界可能有偏差，内容不会）。
            s.chars = o.chars
            s.hash = hash16(finalText.slice(o.offset, o.offset + o.chars))
            s.anchored = true
          }
        }
        p.record.finalized = true
        p.record.finalizeReason = 'located'
        p.record.finalizeBasis = basis
        // 定稿成功 ⇒ 清掉上一次尝试留下的失败明细（同楼可能分次提交：先失败后成功）
        delete p.record.locateMiss
        delete p.record.locateCounts
        delete p.record.locateWhy
        if (Number.isFinite(carriedFromTurn)) p.record.carriedFromTurn = carriedFromTurn
        p.record.anchoredCount = r.anchored
        enqueueWrite(sessionId, p.record)
        pending.delete(sessionId)
        return { ok: true, reason: 'located', matched: r.matched, total: r.total }
      }

      /** 记下"最近一份真正发出去的系统正文"（有界）。 */
      const trackLastFinal = (sessionId, finalText, dshTurn) => {
        lastFinal.set(sessionId, { text: finalText, turn: dshTurn })
        while (lastFinal.size > PENDING_MAX_SESSIONS) {
          const oldest = lastFinal.keys().next().value
          if (oldest === undefined) break
          lastFinal.delete(oldest)
        }
      }

      /** 本楼宿主重发了系统提示词 ⇒ 用**这一楼自己的**正文定 offset，并把它记成"最近一份"。 */
      const finalizePending = (sessionId, finalText, dshTurn) => {
        const p = pending.get(sessionId)
        // ⛔ 楼号对不上的 `system/message` **不是"本楼的正文"**：既不许借它定稿（`applyFinalText`
        //   里判），也⛔不许把它记成"最近一份" —— 否则回退会写出"沿用第 99 楼"这种不存在的来路。
        //   `pending` 不在时（本会话没在捕获，或本楼已定稿）无从判楼号 ⇒ 照记
        //   （这也正是"一楼分次提交多条 system/message"能记到最后那条的路径）。
        const turnOk = p === undefined
          || !Number.isFinite(dshTurn)
          || !Number.isFinite(p.record.turn)
          || dshTurn === p.record.turn
        const res = applyFinalText(sessionId, finalText, dshTurn, 'own')
        if (turnOk) trackLastFinal(sessionId, finalText, dshTurn)
        return res
      }

      /**
       * 从**会话日志的当前 surface**里取最近一份非空系统正文。
       *
       * ★ 为什么需要它（2026-09-18 真机 turn 15 实测）：宿主自己的判据是**从句会话日志恢复**的
       *   （`SystemPromptProjection.systemNodes()` 扫 `session.surface.nodes`，再取
       *   `findLast(node => node.text !== '')`）—— 所以**宿主重启后仍然知道上一份是什么**，
       *   于是它继续不发 `system/message`；而我们那份 `lastFinal` 是进程内存、重启即空
       *   ⇒ 回退会一路 `no-previous-final-text`，整段剧情卡在测试信息上时就永远定不了稿。
       *   这里**照抄宿主那条判据**（同一个 surface、同一个"最后一个非空"），把对称性补回来。
       * ⛔ 只读日志，不合成、不猜。
       */
      const latestSystemNodeOf = (session) => {
        try {
          const nodes = session?.surface?.nodes
          if (nodes === undefined || typeof session?.eventAt !== 'function') return undefined
          let found
          for (const seq of nodes) {
            const ev = session.eventAt(seq)
            if (ev?.type !== 'system/message') continue
            const content = ev?.data?.message?.content
            const text = Array.isArray(content)
              ? content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
              : ''
            if (text !== '') found = { text, turn: ev?.data?.turn } // 按 surface 顺序，最后一个非空的即最近一份
          }
          return found
        } catch {
          return undefined
        }
      }

      /**
       * ★★ 底本回退（2026-09-18）：本楼宿主**没有**重发系统提示词 ⇒ 沿用**上一份**正文。
       *
       * 由 `turn/end` 触发 —— 该楼此刻已经确定结束，还没有正文就说明"宿主这楼没发"
       * （见 `lastFinal` 上方的机制说明：那等价于"正文与上一份相同"）。
       * 上一份的来路有两处，先内存后日志（`latestSystemNodeOf`，宿主重启后靠它）。
       * ⛔ 三个不许：两处都没有（会话第一楼就是）⇒ **不编位置**、如实留 `waiting-final-text`；
       *   本楼自带过正文 ⇒ **不覆盖**它的结论；定过稿的 ⇒ 幂等不动。
       * @returns {{ok:boolean, reason:string}}
       */
      const finalizeFromPrevious = (sessionId, dshTurn, session) => {
        const p = pending.get(sessionId)
        if (p === undefined) return { ok: false, reason: 'no-pending' }
        if (p.record.finalized === true) return { ok: false, reason: 'already-finalized' }
        if (p.sawOwnText === true) return { ok: false, reason: 'had-own-text' }
        if (Number.isFinite(dshTurn) && Number.isFinite(p.record.turn) && dshTurn !== p.record.turn) {
          return { ok: false, reason: 'turn-mismatch' }
        }
        let prev = lastFinal.get(sessionId)
        let prevFrom = 'memory'
        if (prev === undefined) {
          prev = latestSystemNodeOf(session)
          prevFrom = 'session-log'
          if (prev !== undefined) trackLastFinal(sessionId, prev.text, prev.turn) // 顺手缓存，别每楼重扫
        }
        if (prev === undefined) return { ok: false, reason: 'no-previous-final-text' }
        const res = applyFinalText(sessionId, prev.text, dshTurn, 'carried', prev.turn)
        if (opts.debug) {
          debugLog(opts.dir, {
            event: 'finalize-carried',
            sessionId,
            turn: dshTurn,
            carriedFromTurn: prev.turn,
            prevFrom,
            ok: res.ok,
            reason: res.reason,
          })
        }
        return res
      }
      const runCapture = async (assembly, assembleContext, next) => {
        // ① **链之前**：只取与"时点"有关的东西（会话、轮号、段定义、调试快照）。
        //    链跑完之后 `agent.phase.turn` 与投影可能已经翻页 ⇒ 必须此刻取，语义与旧版完全一致。
        let prepared = null
        try {
          const agent = assembleContext?.agent
          const sessionId = agent?.session?.id ?? null
          if (opts.debug) {
            const defsSeen = readSectionDefs(scope.systemPrompt, assembleContext?.scope)
            debugLog(opts.dir, {
              event: 'assemble',
              contextKeys: Object.keys(assembleContext ?? {}),
              sessionId,
              agentId: agent?.id ?? null,
              turnProjection: (() => {
                try {
                  return agent ? scope.sessionProjections?.stateOf?.(agent.session, 'turnBoundary')?.lastTurn ?? null : null
                } catch {
                  return 'throw'
                }
              })(),
              turnPhase: (() => {
                try {
                  return agent?.phase?.turn ?? null
                } catch {
                  return 'throw'
                }
              })(),
              sectionNames: (assembly?.sections ?? []).map((s) => s.name),
              defsAccessible: defsSeen !== null,
              steps: assembly ? { contexts: assembly.contexts?.length ?? 0, tools: assembly.tools?.length ?? 0, variables: Object.keys(assembly.variables ?? {}) } : null,
            })
          }
          if (sessionId !== null) {
            if (opts.getSectionOrder === null) {
              try {
                opts.getSectionOrder = (key) => scope.systemPrompt.getSectionOrder(key)
              } catch {
                opts.getSectionOrder = () => undefined
              }
            }
            const defs = readSectionDefs(scope.systemPrompt, assembleContext?.scope)
            const turn = resolveTurn(agent)
            if (Number.isFinite(turn)) prepared = { sessionId, defs, turn }
            else if (opts.debug) debugLog(opts.dir, { event: 'skip-no-turn', sessionId }) // 轮号拿不到：宁可漏记也不记错楼
          }
        } catch (e) {
          // 捕获通道自身绝不影响组装瀑布：任何异常都吞掉并继续。
          try {
            scope?.logger?.warn?.(`[mt-sections] 捕获失败（忽略）：${e?.stack || e}`)
          } catch {}
        }
        // ② **跑完瀑布**：`after` = 下游全部改写之后的那一版 = DSH 真正要发出去的那一份。
        //    ⛔ `next()` 的异常照常往外抛（绝不吞）—— 捕获通道不得改变组装行为。
        const after = await next()
        // ③ **链之后**：用 `after` 建记录（⛔ 不是入参 `assembly` —— 那一版缺下游的注入）。
        if (prepared !== null) {
          try {
            const record = buildRecord(after, assembleContext, prepared.defs, opts)
            record.turn = prepared.turn
            record.listenerMode = 'outermost-return'
            // ★★ 装配期**不发布 offset / 整段凭据**：这里拿到的是"瀑布返回值"，但 DSH 之后
            //    还会做 `complete` 段覆盖 ⇒ 它未必等于**最终**系统正文。所以先把位置**如实留空**，
            //    等 DSH 把最终正文写进会话日志（`system/message`）后再由 finalizePending 填上真位置。
            for (const s of record.sections) {
              s.offset = null
              s.renderedChars = null
              s.renderedHash = null
            }
            record.finalized = false
            record.finalizeReason = 'waiting-final-text'
            pending.set(prepared.sessionId, { record, at: Date.now() })
            while (pending.size > PENDING_MAX_SESSIONS) {
              const oldest = pending.keys().next().value
              if (oldest === undefined) break
              pending.delete(oldest)
            }
            if (opts.debug) {
              debugLog(opts.dir, {
                event: 'assemble-after',
                sessionId: prepared.sessionId,
                sectionNames: record.sections.map((s) => s.name),
                nonEmpty: record.sections.filter((s) => s.chars > 0).map((s) => `${s.name}(${s.chars})`),
              })
            }
            enqueueWrite(prepared.sessionId, record)
          } catch (e) {
            try {
              scope?.logger?.warn?.(`[mt-sections] 捕获失败（忽略）：${e?.stack || e}`)
            } catch {}
          }
        }
        return after
      }
      // ⚠️ **必须挂在插件顶层 ctx（`context`），⛔ 不能挂在子作用域 `scope` 上**（2026-09-17 真机实测）：
      //   挂 `scope` 时沙箱能收到 `session/event`、**真机收不到**（真机多挂了一堆插件，会话事件
      //   来自另一棵子树）⇒ 监听永远挂不上（实测 turn 3 的捕获里 `anima:memory` 仍是 `chars=0`）。
      //   顶层 ctx 这条路已被 PHI 摘除器证明：`system-prompt/assemble` 与 `session/event` 都收得到。
      //   ⛔ `runCapture` 里继续用子作用域的 `scope`（它有 `systemPrompt`/`sessionProjections` 注入），只换注册位置。
      // ★★ **直接挂最外层**（2026-09-17 判据实验后定案，替代原来的「延迟接管」哨兵）：
      //   我们读的是瀑布**返回值**，只有站在最外层，`await next()` 才覆盖**全部**下游插件。
      //   （`lib/deferred-install.js` 那套仍给 PHI 摘除器用；本捕获不再用它。）
      let disposeAssemble = null
      if (typeof context.on === 'function') {
        const d = context.on('system-prompt/assemble', (a, b, next) => runCapture(a, b, next))
        if (typeof d === 'function') disposeAssemble = d
      } else {
        try {
          scope?.logger?.warn?.('[mt-sections] 顶层 ctx 没有 on() ⇒ 组装捕获未挂载')
        } catch {}
      }
      // ★ `system/message` —— DSH 把**最终**系统正文写进会话日志的那一刻。瀑布返回值虽然已经含
      //   下游全部改写（见上面那段定案），但 DSH 之后还会做 `complete` 段覆盖
      //   （core/system-prompt/src/index.ts:621-626），且整个 system-prompt 包里**没有**任何
      //   "装配完成"事件 ⇒ **逐字节等于真正发出去那一份**的正文只在这里拿得到，
      //   所以真 offset 只在这里定（`finalizePending`）。
      // ★ `turn/end` —— 该楼结束。若这一楼**始终没有** `system/message`，就说明宿主没重发系统
      //   提示词 ⇒ 这一楼发出去的正文与上一份逐字节相同（机制见 `lastFinal` 上方），
      //   于是用上一份当底本定 offset（`finalizeFromPrevious`）。⛔ 拿不到上一份就不定，如实留白。
      //   同样挂在**插件顶层 ctx**：子作用域在真机上收不到 `session/event`（2026-09-17 实测）。
      if (typeof context.on === 'function') {
        context.on('session/event', (session, event) => {
          try {
            const sid = session?.id
            if (typeof sid !== 'string' || sid === '') return
            const type = event?.type
            if (type === 'system/message') {
              const content = event?.data?.message?.content
              if (!Array.isArray(content)) return
              const text = content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
              if (text === '') return
              finalizePending(sid, text, event?.data?.turn)
              return
            }
            if (type === 'turn/end') finalizeFromPrevious(sid, event?.data?.turn, session)
          } catch { /* 定位失败绝不影响这一轮 */ }
        })
      }
      if (typeof disposeAssemble === 'function') {
        scope.effect(() => disposeAssemble, 'dsh-memory-archive-sections-capture: assemble listener')
      }
      try {
        mkdirSync(opts.dir, { recursive: true })
      } catch {}
      scope.logger?.info?.(`[mt-sections] 组装捕获已挂载（dir=${basename(opts.dir)}，fullText=${opts.fullText ? 'on' : 'off'}；装配监听=最外层·读返回值）`)
    },
  }
  return context.plugin(plugin)
}

// ---------------------------------------------------------------------------
// C4 数据访问（冻结 API）：resolveSections(sessionId, turn?) —— 不抛、绝不把推断标成捕获
// ---------------------------------------------------------------------------

function inferredShape(reason, message, turn, sessionId) {
  return {
    ok: true,
    sessionId,
    source: 'inferred',
    capturedAt: null,
    turn: turn ?? null,
    inferred: { reason, message },
    sections: [], // ⛔ 降级不给段名：旧"名单/标记"推断已删，界面对空段清单明示"结构为文本推断"
    contexts: [],
    tools: [],
  }
}

export async function resolveSections(sessionId, turn, options = {}) {
  const dir = options.dir || assemblyDir(process.env, options)
  const sid = String(sessionId ?? '').trim()
  if (sid === '') {
    return { ok: false, error: { code: 'bad-request', message: 'sessionId 不能为空' } }
  }
  const path = sessionFilePath(dir, sid)
  const file = readAssemblyFile(path)
  if (file.missing) return inferredShape('no-capture-record', '该会话没有组装捕获记录（早于本插件加载，或从未在捕获开启的状态下跑过回合）。', turn, sid)
  if (file.unknownVersion || file.corrupt || file.unreadable) {
    return inferredShape('schema-version-unknown', '捕获记录的版本不认识或文件损坏，按"未记录"处理（契约 C5，不抛）。', turn, sid)
  }
  if (file.empty || file.records.length === 0) {
    return inferredShape('no-capture-record', '该会话的捕获记录为空。', turn, sid)
  }
  let wanted = Number.isFinite(Number(turn)) ? Number(turn) : null
  const turns = file.records.map((row) => row.turn)
  const latest = Math.max(...turns)
  if (wanted === null) wanted = latest
  const record = [...file.records].reverse().find((row) => row.turn === wanted)
  if (!record) {
    return inferredShape('no-capture-record', `没有第 ${wanted} 楼的捕获记录（现有楼号：${[...new Set(turns)].sort((a, b) => a - b).join(', ')}）。`, wanted, sid)
  }
  return {
    ok: true,
    sessionId: sid,
    source: 'captured',
    capturedAt: record.capturedAt,
    turn: record.turn,
    latest,
    sections: (record.sections ?? []).map((s) => ({
      name: s.name,
      order: s.order ?? null,
      chars: s.chars ?? 0,
      offset: s.offset ?? null, // ?? 只兜"字段缺失"：0 是合法位置（第一段），不会被动成 null
      hash: s.hash ?? null,
      mutability: s.mutability ?? 'unknown',
      mutabilityBasis: s.mutabilityBasis ?? 'unknown',
      // 切片凭据 + 不可用原因：有才带（旧记录没有这些字段，原样缺省，不编造）
      ...(s.renderedChars !== undefined ? { renderedChars: s.renderedChars } : {}),
      ...(s.renderedHash !== undefined ? { renderedHash: s.renderedHash } : {}),
      ...(s.offsetUnavailableReason !== undefined ? { offsetUnavailableReason: s.offsetUnavailableReason } : {}),
    })),
    contexts: (record.contexts ?? []).map((c) => ({ name: c.name, chars: c.chars ?? 0 })),
    tools: (record.tools ?? []).map((t) => ({ name: t.name, chars: t.chars ?? 0 })),
  }
}

/** C4 端点处理（给 D 的 dispatch 行用）：handleSectionsGet(ctx, url, send, log)。 */
export async function handleSectionsGet(_ctx, url, send, log) {
  try {
    const params = url instanceof URL ? url.searchParams : new URL(String(url), 'http://dsh.local').searchParams
    const sessionId = params.get('sessionId') ?? params.get('id') ?? ''
    const turnRaw = params.get('turn')
    const turn = turnRaw === null || turnRaw === '' ? undefined : Number(turnRaw)
    const result = await resolveSections(sessionId, Number.isFinite(turn) ? turn : undefined)
    send(200, result)
  } catch (e) {
    // 端点绝不抛（契约）：最坏情况给一个诚实的 inferred。
    try {
      log?.warn?.(`[mt-sections] /api/sections 处理失败：${e?.stack || e}`)
    } catch {}
    send(200, inferredShape('schema-version-unknown', `内部处理失败，按"未记录"处理：${e?.message || e}`, undefined, ''))
  }
}

// ---------------------------------------------------------------------------
// §9 正文切片端点（20260914 追加）：GET /dsh-memory-archive/sections/text?sessionId=&turn=&name=
// 正文来源走 lib/index.js 的 loadSessionLog（活会话注册表优先 → sessionQuery.readSession 退路，
// 全量事件含 request/header 的 data.header.system）；⛔ 绝不直读 ~/.dsh/sessions 下的会话文件，
// ⛔ 绝不把整段 system 返回给客户端 —— 只回被点开的那一段（凭据相等才允许切）。
// ---------------------------------------------------------------------------

/** 与 index.js 的 getService 同款兜底（那里不让动，这里自带一份，只读不写）。 */
function getServiceOf(ctx, serviceName) {
  try {
    if (ctx && typeof ctx.get === 'function') return ctx.get(serviceName)
  } catch {}
  return undefined
}

/**
 * 从宿主报错里抠出位置（行号 / 期望 seq / 实得 seq）；解不出 ⇒ null。
 * ⚠ 与 `lib/prompt-viewer.js` 的 `parseSeqGapDetail` 是同一口径的两份实现 —— 两边分属不同半侧、
 *   文件所有权不同，宁可各自带一份，也⛔ 不让一端去 require 另一端（那会多一条隐性耦合）。
 */
function seqGapDetailOf(message) {
  const m = /at line (\d+) \(expected (\d+), got (\d+)\)/.exec(String(message ?? ''))
  if (!m) return null
  return { line: Number(m[1]), expected: Number(m[2]), got: Number(m[3]) }
}

/** readSession 返回形状的宽松提取（照 index.js extractEvents 的三种形状）。 */
function eventsOfSnapshot(snapshot) {
  if (Array.isArray(snapshot)) return snapshot
  if (snapshot && Array.isArray(snapshot.events)) return snapshot.events
  if (snapshot && snapshot.session && Array.isArray(snapshot.session.events)) return snapshot.session.events
  return null
}

/**
 * 会话日志读取（20260915）：三个出口（正文切片 / 原始 JSON / 结构化诊断）统一复用
 * lib/index.js 导出的 loadSessionLog（活会话注册表优先 → readSession 退路，两条都失败就抛）。
 *
 * 为什么不再直接用 readSession：上游 readSession 走 Session.create 的 snapshot 模式，
 * seeded 会话（fork 出来的周目，本机 24 条）只要有自己的事件就必抛 ——
 *   deepseek-harness packages/session-query/session-query/src/index.ts:183-196（readSession → snapshot 模式）
 *   deepseek-harness packages/core/session/src/index.ts:599-600（seed must equal its inherited prefix 校验）
 * 而 ctx.sessions.get(id).snapshotEvents() 这条路不做该校验（同上游 corpus.ts:297-303 的
 * snapshotLive() 同款取法）。
 *
 * ⚠ 这里用【调用时动态 import】而不是顶部静态 import('./index.js')：index.js 顶层有
 *   `await import('./sections-capture.js')`（守卫加载），本文件若静态反向 import 会构成
 *   "顶层 await + 模块环" —— 自检台直接 import 本文件时可能整进程挂死。拿到即缓存。
 */
let sharedLoadSessionLog = null
async function sessionLogOf(ctx, sq, sessionId) {
  if (!sharedLoadSessionLog) {
    try {
      sharedLoadSessionLog = (await import('./index.js')).loadSessionLog ?? null
    } catch {}
  }
  if (typeof sharedLoadSessionLog !== 'function') {
    throw new Error('loadSessionLog 不可用（lib/index.js 加载失败）')
  }
  return sharedLoadSessionLog(ctx, sq, sessionId)
}

/**
 * 从事件流里找第 turn 楼实际用的 system（**旧路径**：system 记在 `request/header` 里的年代）：
 * 楼锚点 = turn/start（data.turn）… 配对的 turn/end（⛔ 不是 request/header 条数 ——
 * 宿主只在 header 变了时才记，楼与楼之间是 carry-forward）。该楼的 system =
 * seq ≤ 楼末（楼未闭合则不设上限）的最后一条 request/header 的 data.header.system。
 * 找不到楼/没有任何 header ⇒ null（调用方如实给 unavailable，不猜）。
 *
 * ⚠ 本版宿主的 header 里**没有 system**（见 `systemCandidatesForTurn` 的说明）⇒ 本函数
 *   只作为候选之一保留，真正取正文的是同楼的 `system/message`。
 */
function pickSystemForTurn(events, turn) {
  let inTarget = false
  let endSeq = null
  for (const ev of events) {
    const seq = typeof ev?.seq === 'number' && Number.isFinite(ev.seq) ? ev.seq : null
    if (ev?.type === 'turn/start') {
      const t = typeof ev?.data?.turn === 'number' ? ev.data.turn : null
      if (!inTarget && t === turn) {
        inTarget = true
        endSeq = null
      }
    } else if (ev?.type === 'turn/end' && inTarget) {
      endSeq = seq
      break
    }
  }
  if (!inTarget) return null
  let best = null
  for (const ev of events) {
    if (ev?.type !== 'request/header') continue
    const seq = typeof ev?.seq === 'number' && Number.isFinite(ev.seq) ? ev.seq : null
    if (endSeq !== null && seq !== null && seq > endSeq) continue
    const system = typeof ev?.data?.header?.system === 'string' ? ev.data.header.system : null
    if (system === null) continue
    if (best === null || (seq ?? Infinity) >= (best.seq ?? Infinity)) best = { seq, system }
  }
  return best ? best.system : null
}

/**
 * 该楼 system 正文的**候选串**（按可信度排序），供切片端点逐个试、由哈希裁决。
 *
 * 为什么要有"候选"这一层：宿主把 system 从 `request/header` 搬走了。
 * `agent-loop/src/agent.ts:562` 的 `canonicalHeader({config, adapterDefaults, tools})`
 * **不再带 system** —— 实测本机会话日志里 `request/header` 的 headerKeys 只有
 * `config,adapterDefaults,tools`，system 正文改走 `system/message` 这条 surface 事件
 * （`agent.ts:370-372`）。因此只认 header 的旧路径在本版宿主上**永远 null**，
 * 编辑器"原文"整块功能等于死的（20260915 沙箱实测：`unavailable: 'turn-not-found'`）。
 *
 * ⛔ 这里**不猜正文**：候选只是"结构上说得通的几种拼法"，最终由
 *    `sliceSectionByHeader` 的长度+hash 两道验决定用哪一条；都对不上就如实报
 *    `slice-mismatch`，绝不回可能错位的文本。
 */
function systemCandidatesForTurn(events, turn) {
  const out = []
  const fromHeader = pickSystemForTurn(events, turn) // 老式路径（header 里带 system 的年代）
  if (typeof fromHeader === 'string') out.push(fromHeader)
  const texts = []
  for (const ev of events) {
    if (ev?.type !== 'system/message') continue
    if (Number(ev?.data?.turn) !== turn) continue
    const content = ev?.data?.message?.content
    if (!Array.isArray(content)) continue
    const text = content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
    if (text !== '') texts.push(text)
  }
  // 单条：后提交的先试（in-history 路线可能在一楼里分次提交 system）
  for (let i = texts.length - 1; i >= 0; i--) out.push(texts[i])
  if (texts.length > 1) {
    out.push(texts.join('\n\n'))
    out.push(texts.join('\n'))
    out.push(texts.join(''))
  }
  // ★★ 底本回退（2026-09-18）：本楼**一条都没有** ⇒ 宿主这楼没重发系统提示词
  //    ⇒ 它这楼发出去的正文就是**上一份**（`core/agent-loop/src/runtime-context.ts:94`：
  //    正文没变就不追加；空的 `system/message` 同理被跳过，因为有效正文取的是
  //    `findLast(text !== '')`）。⛔ 本楼有就别回退 —— 有就说明宿主发了（哪怕分次提交）。
  if (out.length === 0) {
    const prev = latestSystemTextBefore(events, turn)
    if (typeof prev === 'string') out.push(prev)
  }
  return out
}

/**
 * 目标楼**之前**最近一份非空 `system/message` 正文（底本回退用；找不到 ⇒ `null`）。
 * ⛔ 只回**实际存在过**的正文，绝不合成、绝不拿本楼的段表去拼。
 */
function latestSystemTextBefore(events, turn) {
  let best = null
  let bestTurn = null
  for (const ev of events) {
    if (ev?.type !== 'system/message') continue
    const t = Number(ev?.data?.turn)
    if (!Number.isFinite(t) || !(t < turn)) continue
    const content = ev?.data?.message?.content
    if (!Array.isArray(content)) continue
    const text = content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
    if (text === '') continue
    if (bestTurn === null || t > bestTurn) { best = text; bestTurn = t }
  }
  return best
}

/** 逐候选切：只有**两道验都对得上**的那条才算数（⛔ 不拼、不挪 offset、不猜）。 */
function sliceWithCandidates(section, candidates) {
  for (const system of candidates) {
    const sliced = sliceSectionByHeader(section, system)
    if (!sliced.unavailable) return sliced
  }
  return { unavailable: 'slice-mismatch' }
}

/** 捕获记录里一段的切片凭据形状（供 resolveSectionText / handler 复用）。 */
function sectionCredentials(section) {
  return {
    offset: Number.isFinite(section?.offset) && section.offset >= 0 ? section.offset : null,
    chars: Number.isFinite(section?.chars) && section.chars > 0 ? section.chars : null,
    renderedChars: Number.isFinite(section?.renderedChars) ? section.renderedChars : null,
    renderedHash: typeof section?.renderedHash === 'string' && section.renderedHash !== '' ? section.renderedHash : null,
    hash: typeof section?.hash === 'string' && section.hash !== '' ? section.hash : null,
    // ★ 这一段的位置是**锚点定界**来的（内容被宿主改写、逐字匹配不上）⇒ 端点如实转达，
    //   界面据此把"锚点定界"与"逐字匹配"分开说（⛔ 内容永远是最终正文的切片，这点两者一样）。
    anchored: section?.anchored === true,
  }
}

/**
 * 查某楼某段的捕获记录（不含正文）：没有记录/没有 offset/凭据缺失都如实给 unavailable，
 * ⛔ 绝不带着可疑的 offset 往下走。unavailable ∈
 *   'no-capture-record' | 'turn-not-found' | 'no-offset' | 'slice-mismatch'(凭据缺失)
 */
export async function resolveSectionText(sessionId, turn, name, options = {}) {
  const dir = options.dir || assemblyDir(process.env, options)
  const sid = String(sessionId ?? '').trim()
  if (sid === '') return { ok: false, error: { code: 'bad-request', message: 'sessionId 不能为空' } }
  const sectionName = String(name ?? '').trim()
  if (sectionName === '') return { ok: false, error: { code: 'bad-request', message: 'name 不能为空' } }
  const wanted = Number.isFinite(Number(turn)) ? Number(turn) : null
  const file = readAssemblyFile(sessionFilePath(dir, sid))
  const noRecord = (t) => ({
    ok: true,
    sessionId: sid,
    turn: t,
    name: sectionName,
    source: null,
    section: null,
    unavailable: 'no-capture-record',
  })
  if (file.missing || file.empty || file.records.length === 0 || file.unknownVersion || file.corrupt || file.unreadable) {
    return noRecord(wanted)
  }
  const latest = Math.max(...file.records.map((row) => row.turn))
  const at = wanted === null ? latest : wanted
  const record = [...file.records].reverse().find((row) => row.turn === at)
  if (!record) return { ...noRecord(at), unavailable: 'turn-not-found' }
  const section = (record.sections ?? []).find((s) => s.name === sectionName) ?? null
  if (!section) {
    return { ok: false, error: { code: 'no-such-section', message: `第 ${at} 楼的捕获记录里没有名为 ${JSON.stringify(sectionName)} 的段` } }
  }
  const cred = sectionCredentials(section)
  const base = {
    ok: true,
    sessionId: sid,
    turn: record.turn,
    name: sectionName,
    source: 'captured',
    /**
     * ★ **底本回退的如实说明**（2026-09-18）：`'own'` = 本楼宿主重发了系统提示词；
     *   `'carried'` = 本楼**没有**重发（正文与上一份逐字节相同）⇒ 沿用第 `carriedFromTurn` 楼那份定界。
     *   界面必须据此说明来路，⛔ 别让"沿用来的 offset"看起来和普通楼一模一样。
     */
    finalizeBasis: typeof record.finalizeBasis === 'string' ? record.finalizeBasis : null,
    carriedFromTurn: Number.isFinite(record.carriedFromTurn) ? record.carriedFromTurn : null,
    /**
     * ★ 这一楼定稿失败时**没落位的段名**（⛔ 只有名字与计数，没有正文）。
     *   界面据此把"为什么给不出位置"讲清楚 —— "切不到就老实说"的一部分。
     */
    locateMiss: Array.isArray(record.locateMiss) && record.locateMiss.length > 0 ? record.locateMiss.slice() : null,
    locateCounts: record.locateCounts && typeof record.locateCounts === 'object' ? record.locateCounts : null,
    /** 逐段的失败原因：`anchor-miss`（锚点根本没找到）/ `blocked`（夹着别的未定位段）/ `nonpositive`（长度算成 ≤0） */
    locateWhy: record.locateWhy && typeof record.locateWhy === 'object' ? { ...record.locateWhy } : null,
  }
  if (cred.offset === null || cred.chars === null) return { ...base, section: cred, unavailable: 'no-offset' }
  // 凭据（renderedChars/renderedHash）缺失 ⇒ 客户端没法先比对再切，宁可不给也不盲切
  if (cred.renderedChars === null || cred.renderedHash === null) return { ...base, section: cred, unavailable: 'slice-mismatch' }
  return { ...base, section: cred, unavailable: null }
}

/**
 * 拿捕获凭据去会话日志的 header.system 上切这一段（§9 实现顺序第 3/4 步），两道验：
 * ① 整段凭据：system 的长度/renderedHash 与记录相等（对不住 ⇒ 日志不是那次组装发出的）；
 * ② 单段凭据：切出来的文本哈希与该段 hash 相等 —— 整段凭据对、但 offset 被改错一位时
 *    只有这一道能抓住（此时必须 'slice-mismatch'，⛔ 绝不回可能错位的正文）。
 */
export function sliceSectionByHeader(section, system) {
  if (typeof system !== 'string') return { unavailable: 'slice-mismatch' }
  if (system.length !== section.renderedChars || hash16(system) !== section.renderedHash) {
    return { unavailable: 'slice-mismatch' }
  }
  const end = section.offset + section.chars
  if (!Number.isFinite(section.offset) || section.offset < 0 || end > system.length) {
    return { unavailable: 'slice-mismatch' }
  }
  const text = system.slice(section.offset, end)
  if (section.hash !== null && hash16(text) !== section.hash) return { unavailable: 'slice-mismatch' }
  return { text }
}

/**
 * 逐候选按**整段凭据**（长度 + sha256）挑出"捕获认过的那一份"（纯函数，自检台直测）。
 * ⛔ 只认**两道验都对得上**的：长度相等但内容不同照样算不认 —— 真机就撞过这种
 *   （两份同为 8,384 字、内容不同）。
 */
export function pickVerifiedSystemText(candidates, renderedChars, renderedHash) {
  if (!Number.isFinite(renderedChars) || renderedChars <= 0) return null
  if (typeof renderedHash !== 'string' || renderedHash === '') return null
  for (const system of (Array.isArray(candidates) ? candidates : [])) {
    if (typeof system !== 'string') continue
    if (system.length !== renderedChars) continue
    if (hash16(system) !== renderedHash) continue
    return system
  }
  return null
}

/** 从捕获记录里取"整段凭据"（任取一条非空段；同一楼的各段共享同一份正文的凭据）。 */
export function recordCredentials(record) {
  for (const s of (Array.isArray(record?.sections) ? record.sections : [])) {
    if (Number(s?.chars) > 0 && Number.isFinite(s?.renderedChars)
      && typeof s?.renderedHash === 'string' && s.renderedHash !== '') {
      return { renderedChars: s.renderedChars, renderedHash: s.renderedHash }
    }
  }
  return null
}

/**
 * 「本楼**捕获认过**的 system 全文」出口（2026-09-20）。
 *
 * ★★ 为什么要它（用户报障，原文）：「以上是没抓到的字段。很抽象，都是些字段碎片。我觉得算bug」。
 *   面板的「未抓到（切完的剩余）」= 拿**捕获的 offset/chars** 去切**另一条路取来的** system 全文
 *   （`/prompt/api/part?part=system`：该楼 `request/header` 那一刻生效的正文），而捕获定稿用的是
 *   **同一楼里另一条 `system/message`**。一楼只要有多份正文（工具循环里跑了好几步），两者就不是
 *   同一份 ⇒ 补集切出来的是错位的渣。
 *   真机复现（session-d3aea3f4 · 第 1 楼）：捕获那份含 `state:card`(820 字) 且没有开场白；viewer
 *   那份开场白在、`state:card` 不在；**两份都恰好 8,384 字**（所以连"长度对不上"都发现不了）。
 *
 * ⇒ 这里**只回捕获认过的那一份**：逐候选按 `renderedChars` + sha256 两道验
 *   （与 `/sections/text` 的 `sliceSectionByHeader` 同一口径），对不上就如实说拿不到，⛔ 不端半份、
 *   ⛔ 不近似、⛔ 不拿我们自己那份副本冒充。
 * ⚠️ 面板拿它当**底本**（"未抓到"那一行的减数与补集切片），于是"段表 / 段位置 / 底本"来自**同一条记录**，
 *   自洽 —— 这才是"底本 = 实际文本"该有的样子。
 *
 * @returns 命中：`{ok:true, source:'capture-verified', text, textChars, renderedChars, renderedHash, …}`
 *   拿不到：`{ok:true, text:null, unavailable:'…'}`，unavailable ∈
 *   'no-capture-record' | 'turn-not-found' | 'not-finalized' | 'no-credentials' |
 *   'session-query-unavailable' | 'session-read-failed' | 'credential-mismatch'
 */
export async function resolveSectionsSystemText(ctx, sessionId, turn, options = {}) {
  const dir = options.dir || assemblyDir(process.env, options)
  const sid = String(sessionId ?? '').trim()
  if (sid === '') return { ok: false, error: { code: 'bad-request', message: 'sessionId 不能为空' } }
  const wanted = Number.isFinite(Number(turn)) ? Number(turn) : null
  const miss = (reason, at, extra = {}) => ({
    ok: true, sessionId: sid, turn: at ?? null, source: null,
    renderedChars: null, renderedHash: null, text: null, unavailable: reason, ...extra,
  })
  const file = readAssemblyFile(sessionFilePath(dir, sid))
  if (file.missing || file.empty || file.records.length === 0 || file.unknownVersion || file.corrupt || file.unreadable) {
    return miss('no-capture-record', wanted)
  }
  const latest = Math.max(...file.records.map((row) => row.turn))
  const at = wanted === null ? latest : wanted
  const record = [...file.records].reverse().find((row) => row.turn === at)
  if (!record) return miss('turn-not-found', at)
  // 没定稿 ⇒ 段上根本没有可信 offset（这一步是"位置"的前提）⇒ 底本也就无从谈起
  if (record.finalized !== true) return miss('not-finalized', at, { finalizeReason: record.finalizeReason ?? null })
  const cred = recordCredentials(record)
  if (cred === null) return miss('no-credentials', at)
  const basis = {
    finalizeBasis: typeof record.finalizeBasis === 'string' ? record.finalizeBasis : null,
    carriedFromTurn: Number.isFinite(record.carriedFromTurn) ? record.carriedFromTurn : null,
  }
  const sq = getServiceOf(ctx, 'sessionQuery')
  if (!sq || typeof sq.readSession !== 'function') return { ...miss('session-query-unavailable', at), ...cred, ...basis }
  let events
  try {
    // 与 /sections/text 同一条读取路径（活会话注册表优先 → readSession 退路）
    events = (await sessionLogOf(ctx, sq, sid)).events
  } catch {
    return { ...miss('session-read-failed', at), ...cred, ...basis }
  }
  const candidates = systemCandidatesForTurn(events, at)
  const text = pickVerifiedSystemText(candidates, cred.renderedChars, cred.renderedHash)
  if (text === null) {
    return {
      ...miss('credential-mismatch', at),
      ...cred, ...basis,
      candidateCount: candidates.length,
      note: '本楼日志里没有任何一条 system 正文与捕获凭据（长度+sha256）对得上 ⇒ 不给底本',
    }
  }
  return { ok: true, sessionId: sid, turn: at, source: 'capture-verified', ...cred, ...basis, text, textChars: text.length, unavailable: null }
}

/** 端点处理（给 dispatch 行用）：GET /dsh-memory-archive/api/sections/system?sessionId=&turn= */
export async function handleSectionsSystemGet(ctx, url, send, log, options = {}) {
  try {
    const params = url instanceof URL ? url.searchParams : new URL(String(url), 'http://dsh.local').searchParams
    const sessionId = params.get('sessionId') ?? params.get('id') ?? ''
    const turnRaw = params.get('turn')
    let turn
    if (turnRaw !== null && turnRaw !== '') {
      turn = Number(turnRaw)
      if (!Number.isFinite(turn)) return send(400, { ok: false, error: { code: 'bad-request', message: 'turn 必须是数字' } })
    }
    send(200, await resolveSectionsSystemText(ctx, sessionId, turn, options))
  } catch (e) {
    try {
      log?.warn?.(`[mt-sections] /api/sections/system 处理失败：${e?.stack || e}`)
    } catch {}
    send(500, { ok: false, error: { code: 'INTERNAL', message: String(e?.message || e) } })
  }
}

/** §9 端点处理（给 D 的 dispatch 行用）：handleSectionsTextGet(ctx, url, send, redact, log, options?)。 */
export async function handleSectionsTextGet(ctx, url, send, redact, log, options = {}) {
  const respondUnavailable = (found) =>
    send(200, {
      ok: true,
      sessionId: found.sessionId,
      turn: found.turn,
      name: found.name,
      offset: found.section?.offset ?? null,
      chars: found.section?.chars ?? null,
      source: found.source,
      // ★ 给不出位置时，把"哪几段没落位、各自为什么"一并如实带出去（⛔ 只有名字与原因码）
      locateMiss: found.locateMiss ?? null,
      locateCounts: found.locateCounts ?? null,
      locateWhy: found.locateWhy ?? null,
      text: null,
      unavailable: found.unavailable,
    })
  try {
    const params = url instanceof URL ? url.searchParams : new URL(String(url), 'http://dsh.local').searchParams
    const sessionId = params.get('sessionId') ?? params.get('id') ?? ''
    const name = params.get('name') ?? ''
    const turnRaw = params.get('turn')
    if (String(sessionId).trim() === '') return send(400, { ok: false, error: { code: 'bad-request', message: '缺少 sessionId 查询参数' } })
    if (String(name).trim() === '') return send(400, { ok: false, error: { code: 'bad-request', message: '缺少 name 查询参数' } })
    let turn
    if (turnRaw !== null && turnRaw !== '') {
      turn = Number(turnRaw)
      if (!Number.isFinite(turn)) return send(400, { ok: false, error: { code: 'bad-request', message: 'turn 必须是数字' } })
    }
    const found = await resolveSectionText(sessionId, turn, name, options)
    if (found.ok === false) return send(200, found) // no-such-section 等：照「测不通不是服务器错误」约定给 200+ok:false
    if (found.unavailable) return respondUnavailable(found)
    // 记忆库同款读取路径（带 LRU 的是 index.js 自己的 eventsCache；这里按需直读一次，
    // 切片是低频"点开"动作，不值得为它再背一层缓存）。
    const sq = getServiceOf(ctx, 'sessionQuery')
    if (!sq || typeof sq.readSession !== 'function') {
      return send(503, { ok: false, error: { code: 'SESSION_QUERY_UNAVAILABLE', message: '宿主未挂载 sessionQuery（或缺少 readSession 方法），正文切片不可用' } })
    }
    let events
    try {
      // 为什么不再直接用 readSession：seeded 会话在上游必抛（session-query/src/index.ts:183-196
      // → core/session/src/index.ts:599-600 的 seed 校验），fork 周目会话曾全部 500 ——
      // 改走 loadSessionLog（活会话注册表优先），失败仍按 SESSION_READ_FAILED 降级。
      events = (await sessionLogOf(ctx, sq, found.sessionId)).events
    } catch (e) {
      const msg = String(e?.message || e)
      return send(500, { ok: false, error: { code: 'SESSION_READ_FAILED', message: typeof redact === 'function' ? redact(msg) : msg } })
    }
    const candidates = systemCandidatesForTurn(events, found.turn)
    if (candidates.length === 0) return respondUnavailable({ ...found, unavailable: 'turn-not-found' })
    const sliced = sliceWithCandidates(found.section, candidates)
    if (sliced.unavailable) return respondUnavailable({ ...found, unavailable: sliced.unavailable })
    return send(200, {
      ok: true,
      sessionId: found.sessionId,
      turn: found.turn,
      name: found.name,
      offset: found.section.offset,
      chars: found.section.chars,
      source: 'captured',
      anchored: found.section.anchored === true,
      // ★ 底本回退的来路（照抄 `resolveSectionText` 读到的记录值）—— 界面据此说明
      //   "这一楼的底本是沿用上一份来的"，⛔ 不许把它显示得和普通楼一样。
      finalizeBasis: found.finalizeBasis ?? null,
      carriedFromTurn: found.carriedFromTurn ?? null,
      text: sliced.text,
      unavailable: null,
    })
  } catch (e) {
    // 端点绝不抛（契约）：最坏情况给可读错误。
    try {
      log?.warn?.(`[mt-sections] /sections/text 处理失败：${e?.stack || e}`)
    } catch {}
    send(500, { ok: false, error: { code: 'INTERNAL', message: String(e?.message || e) } })
  }
}

// entry 兼容（本沙箱临时挂载 / 任何想以独立 cordis 条目挂载的场合）：
/**
 * 编辑器「结构化诊断」出口（20260914 M9）。
 *
 * **为什么要有它**：编辑器里的坏消息一直是**散的**（`no-capture-record` / `offset` 缺 / 凭据缺 /
 * `session-parse-failed` / `archived:null`），用户得点开好几处才能拼出"这条会话到底哪儿不对"。
 * 这个出口一次问清，并且每条诊断都按同一套形状给全四样东西（对照 Archify 的 `validate --json`）：
 *   `code`（稳定规则码）· `subject`（准确对象：会话/楼/段）· `evidence`（测量证据，不是形容词）·
 *   `supportedFixes`（真正支持的修法；⛔ 不写做不到的建议）。
 *
 * ★ 口径：**诊断只描述"看到的事实"**，⛔ 不推断影响、不给风险评级、不猜"应该是谁的问题"。
 * ★ 只读：不写任何文件、不做任何修复动作。
 *
 * @param {object} ctx - 宿主上下文（只读服务：sessionQuery）
 * @param {URL|string} url - 查询串：sessionId（必填）、turn（可选，缺省=最新楼）
 * @param {Function} send - (status, payload) 响应器
 * @param {Function} [redact] - 消息脱敏（宿主注入）
 * @param {object} [log] - 日志器
 * @param {{dir?:string, env?:object, archivedProvider?:Function}} [options]
 */
export async function handleEditorDiagnosticsGet(ctx, url, send, redact, log, options = {}) {
  const params = url instanceof URL ? url.searchParams : new URL(String(url), 'http://dsh.local').searchParams
  const sessionId = String(params.get('sessionId') ?? params.get('id') ?? '').trim()
  const turnRaw = params.get('turn')
  let turn = null
  if (turnRaw !== null && turnRaw !== '') {
    turn = Number(turnRaw)
    if (!Number.isInteger(turn) || turn < 1) {
      return send(400, { ok: false, error: { code: 'bad-request', message: 'turn 必须是从 1 开始的整数' } })
    }
  }
  if (sessionId === '') {
    return send(400, { ok: false, error: { code: 'bad-request', message: '缺少 sessionId 查询参数' } })
  }
  const clean = (m) => (typeof redact === 'function' ? redact(String(m)) : String(m))
  const diagnostics = []
  const add = (code, severity, subject, evidence, supportedFixes) =>
    diagnostics.push({ code, severity, subject, evidence, supportedFixes })

  // ① 日志在宿主侧读不读得出来（读得出来 ≠ 有捕获；读不出来 ⇒ 后面一切都无从谈起）
  const sq = getServiceOf(ctx, 'sessionQuery')
  if (!sq || typeof sq.readSession !== 'function') {
    add('session-query-unavailable', 'warn', { sessionId },
      { reason: '宿主未挂载 sessionQuery 或缺少 readSession' },
      ['确认 dsh-memory-archive 插件的 inject 里含 tools/sessionQuery（宿主版本差异）'])
  } else {
    try {
      // 为什么不再直接用 readSession：seeded 会话在上游必抛（session-query/src/index.ts:183-196
      // → core/session/src/index.ts:599-600 的 seed 校验）—— 之前会把 24 条 fork 周目全部
      // 误报成 log-unreadable；改走 loadSessionLog（活会话注册表优先），真读不出仍走下面原分类。
      await sessionLogOf(ctx, sq, sessionId)
    } catch (error) {
      const message = clean(error?.message || error)
      // ★ 分清两件完全不同的事：**这个会话不存在** ≠ **日志读不出来**。
      //   把前者报成后者会是假指控（真机实测：`session "…" not found` 被我第一版报成了 log-unreadable）。
      if (/not found|no such session|不存在|unknown session/i.test(message)) {
        add('session-not-found', 'error', { sessionId }, { message },
          ['确认 sessionId 拼写；会话可能已被删除'])
      } else {
        add('log-unreadable', 'error', { sessionId },
          { message, detail: seqGapDetailOf(message) },
          ['这是宿主自己的日志解析器（session-persistence-jsonl 的 seq 连续性检查）拒绝的，本插件无法修复',
            '其它会话不受影响；可换一条会话查看'])
      }
    }
  }

  // ② 该楼的组装捕获
  const cap = await resolveSections(sessionId, turn, options)
  const resolvedTurn = cap && cap.turn !== undefined ? cap.turn : turn
  const subjectTurn = { sessionId, turn: resolvedTurn === null ? turn : resolvedTurn }
  if (cap && cap.source === 'inferred') {
    const reason = (cap.inferred && cap.inferred.reason) || 'no-capture-record'
    add(reason === 'schema-version-unknown' ? 'capture-schema-unknown' : 'no-capture-record', 'warn', subjectTurn,
      { reason, message: cap.inferred && cap.inferred.message ? cap.inferred.message : null },
      ['装配捕获只对**插件加载之后**跑的回合生效；旧楼没有记录是历史限制，⛔ 不会自动补',
        '图表会退化为"文本推断 · 边界可能不准"，只用于定位'])
  } else if (cap && cap.ok === true && Array.isArray(cap.sections)) {
    const nonEmpty = cap.sections.filter((s) => Number(s.chars) > 0)
    const noOffset = nonEmpty.filter((s) => s.offset === null || s.offset === undefined)
    const noCred = nonEmpty.filter((s) => !Number.isFinite(s.renderedChars) || typeof s.renderedHash !== 'string' || s.renderedHash === '')
    const offsetOnEmpty = cap.sections.filter((s) => Number(s.chars) === 0 && s.offset !== null && s.offset !== undefined)
    if (noOffset.length > 0) {
      add('offset-missing', 'warn', subjectTurn,
        { sectionsWithoutOffset: noOffset.length, totalSections: cap.sections.length, sample: noOffset.slice(0, 5).map((s) => s.name) },
        ['旧版捕获没有 offset ⇒「点开看正文」会如实说"该段内容不可用（未记录位置）"',
          '新跑的回合会带 offset'])
    }
    if (noCred.length > 0) {
      add('credentials-missing', 'warn', subjectTurn,
        { sectionsWithoutCredentials: noCred.length, totalSections: cap.sections.length, sample: noCred.slice(0, 5).map((s) => s.name) },
        ['切片前要比对 renderedChars/renderedHash 凭据；缺凭据时接口宁可不给正文（slice-mismatch）也不盲切'])
    }
    if (offsetOnEmpty.length > 0) {
      add('offset-on-empty-section', 'error', subjectTurn,
        { sections: offsetOnEmpty.slice(0, 5).map((s) => s.name), rule: '0 字的段不占位 ⇒ offset 必须是 null（⛔ 不是 0）' },
        ['这是捕获侧的契约破坏，请报给插件作者并附上本响应的 evidence'])
    }
    if (nonEmpty.length > 0) {
      const expected = nonEmpty.reduce((a, s) => a + Number(s.chars), 0) + 2 * (nonEmpty.length - 1)
      const recorded = [...new Set(nonEmpty.map((s) => s.renderedChars).filter((n) => Number.isFinite(n)))]
      if (recorded.length === 1 && recorded[0] !== expected) {
        add('length-arithmetic-mismatch', 'error', subjectTurn,
          { expectedBySections: expected, recordedRenderedChars: recorded[0], formula: 'Σ(非空段字数) + 2×(非空段数−1)' },
          ['捕获记录自洽校验失败 ⇒ 该楼的 offset 一律记 null（宁可不给也不错位）；请附本响应报给作者'])
      }
    }
  } else if (cap && cap.ok === false && cap.error) {
    add('capture-unavailable', 'warn', subjectTurn, { code: cap.error.code, message: cap.error.message }, [])
  }

  // ③ 归档位（注册表只读投影；读不到 ⇒ 未知，⛔ 不冒充"未归档"）
  const provider = typeof options.archivedProvider === 'function' ? options.archivedProvider : null
  if (!provider) {
    add('archive-unknown', 'info', { sessionId }, { reason: '宿主半侧没有注入归档来源（workspaceRegistry 不可用）' }, [])
  } else {
    let arc = null
    try {
      arc = provider()
    } catch {
      arc = null
    }
    if (!arc || arc.known !== true || !Array.isArray(arc.ids)) {
      add('archive-unknown', 'info', { sessionId }, { reason: '归档来源返回的形状不认识或读不到' }, [])
    } else if (arc.ids.map(String).includes(sessionId)) {
      add('archived', 'info', { sessionId }, { source: '工作区注册表 archivedSessionIds（只读投影）' },
        ['归档不影响日志与正文可读性；编辑器列表默认隐藏它（有开关）'])
    }
  }

  const counts = { error: 0, warn: 0, info: 0 }
  for (const d of diagnostics) counts[d.severity] = (counts[d.severity] || 0) + 1
  if (typeof log?.info === 'function') {
    log.info(`[mt] 编辑器诊断 ${sessionId} 第 ${subjectTurn.turn ?? '—'} 楼：${diagnostics.length} 项（${counts.error} 错 / ${counts.warn} 警 / ${counts.info} 讯）`)
  }
  return send(200, { ok: true, sessionId, turn: subjectTurn.turn === undefined ? null : subjectTurn.turn, counts, diagnostics })
}

/**
 * 「**原始 JSON**」出口（20260914 M12，用户要求）：
 * 「把其它字段也改成工具那样的 json 原样字段呈现吧。不要因为过大不展开。」
 *
 * ★ 与 `/sections`（投影：字段挑过、算过）的区别：这里**原样**交出捕获文件里的那一条 ——
 *   字段一个不删、不改名、不算派生值，`JSON.stringify` 出来就是模型/插件当时记下的东西。
 * ★ `name` 省略 ⇒ 交出**整楼记录**（sections/contexts/tools + turn/capturedAt/agentId 都在）。
 * ★ 正文（可选）：section 走记忆库同款路径切（凭据相等才给）；context 走**日志里那条注入消息**
 *   （`user/message` 且 `source.kind === 'plugin'`）—— 因为 contexts **不在 system 里**（它是独立一条消息）。
 * ★ 「不要因为过大不展开」：本出口**不设字符上限**（你点开哪一条就给你哪一条的全文）。
 *
 * @param {object} ctx - 宿主上下文（只读 sessionQuery）
 * @param {URL|string} url - sessionId | id、turn（可选，缺省=最新楼）、name（可选）、kind=section|context
 * @param {Function} send - (status, payload)
 * @param {object} [log] - 日志器
 * @param {{dir?:string, env?:object}} [options]
 */
export async function handleSectionsRawGet(ctx, url, send, log, options = {}) {
  const params = url instanceof URL ? url.searchParams : new URL(String(url), 'http://dsh.local').searchParams
  const sid = String(params.get('sessionId') ?? params.get('id') ?? '').trim()
  const kind = params.get('kind') === 'context' ? 'context' : 'section'
  const name = String(params.get('name') ?? '').trim()
  const turnRaw = params.get('turn')
  let turn = null
  if (turnRaw !== null && turnRaw !== '') {
    turn = Number(turnRaw)
    if (!Number.isInteger(turn) || turn < 1) {
      return send(400, { ok: false, error: { code: 'bad-request', message: 'turn 必须是从 1 开始的整数' } })
    }
  }
  if (sid === '') return send(400, { ok: false, error: { code: 'bad-request', message: '缺少 sessionId 查询参数' } })

  const dir = options.dir || assemblyDir(process.env, options)
  const file = readAssemblyFile(sessionFilePath(dir, sid))
  if (file.missing || file.empty || file.records.length === 0 || file.unknownVersion || file.corrupt || file.unreadable) {
    return send(200, {
      ok: false,
      error: { code: 'no-capture-record', message: '该会话没有组装捕获记录（早于本插件加载，或从未在捕获开启的状态下跑过回合）。' },
    })
  }
  const latest = Math.max(...file.records.map((row) => row.turn))
  const at = turn === null ? latest : turn
  const record = [...file.records].reverse().find((row) => row.turn === at)
  if (!record) {
    return send(200, { ok: false, error: { code: 'turn-not-found', message: `没有第 ${at} 楼的捕获记录（现有楼号：${[...new Set(file.records.map((r) => r.turn))].sort((a, b) => a - b).join(', ')}）。` } })
  }
  const list = kind === 'context' ? (record.contexts ?? []) : (record.sections ?? [])
  const entry = name === '' ? null : (list.find((x) => x && x.name === name) ?? null)
  if (name !== '' && !entry) {
    return send(200, {
      ok: false,
      error: {
        code: kind === 'context' ? 'no-such-context' : 'no-such-section',
        message: `第 ${at} 楼的捕获记录里没有名为 ${JSON.stringify(name)} 的${kind === 'context' ? '上下文' : '段'}`,
      },
    })
  }

  // 正文：section 从 system 上切；context 从日志里那条注入消息取（⛔ contexts 不在 system 里）
  let text = null
  let textUnavailable = null
  let textSource = null
  const sq = getServiceOf(ctx, 'sessionQuery')
  if (!sq || typeof sq.readSession !== 'function') {
    textUnavailable = 'session-query-unavailable'
  } else if (entry) {
    let events = null
    try {
      // 为什么不再直接用 readSession：seeded 会话在上游必抛（session-query/src/index.ts:183-196
      // → core/session/src/index.ts:599-600 的 seed 校验）—— 改走 loadSessionLog
      // （活会话注册表优先），读不出仍如实 textUnavailable='session-read-failed'。
      events = (await sessionLogOf(ctx, sq, sid)).events
    } catch (error) {
      textUnavailable = 'session-read-failed'
    }
    if (!Array.isArray(events)) {
      if (textUnavailable === null) textUnavailable = 'session-read-failed'
    } else if (kind === 'section') {
      const cred = sectionCredentials(entry)
      if (cred.offset === null || cred.chars === null) textUnavailable = 'no-offset'
      else if (cred.renderedChars === null || cred.renderedHash === null) textUnavailable = 'slice-mismatch'
      else {
        const candidates = systemCandidatesForTurn(events, record.turn)
        if (candidates.length === 0) textUnavailable = 'turn-not-found'
        else {
          const sliced = sliceWithCandidates(cred, candidates)
          if (sliced.unavailable) textUnavailable = sliced.unavailable
          else { text = sliced.text; textSource = 'system 切片（记忆库路径）' }
        }
      }
    } else {
      const snap = pickContextSnapshotForTurn(events, record.turn)
      if (snap === null) textUnavailable = 'context-snapshot-not-found'
      else { text = snap; textSource = '日志里那条注入消息（user/message · source.kind=plugin）' }
    }
  }

  const payload = {
    ok: true,
    sessionId: sid,
    turn: record.turn,
    kind,
    name: name === '' ? null : name,
    // ★ 原样：name 省略 ⇒ 整楼记录；否则那一条本身（字段一个不删、不改名、不算派生值）
    record: name === '' ? record : entry,
    text,
    textChars: typeof text === 'string' ? text.length : null,
    textSource,
    textUnavailable,
    /** 切片凭据（照抄记录里的原值；⛔ 不改名、不换算） */
    credentials: kind === 'section' && entry ? sectionCredentials(entry) : null,
    /**
     * ★ **底本回退的如实说明**（2026-09-18）：`'own'` = 本楼宿主重发了系统提示词；
     *   `'carried'` = 本楼**没有**重发（正文与上一份逐字节相同）⇒ 沿用第 `carriedFromTurn` 楼那一份定界。
     *   界面必须据此说明来路，⛔ 别让"沿用来的 offset"看起来和普通楼一模一样。
     */
    finalizeBasis: typeof record?.finalizeBasis === 'string' ? record.finalizeBasis : null,
    carriedFromTurn: Number.isFinite(record?.carriedFromTurn) ? record.carriedFromTurn : null,
  }
  // ★ M14（20260914 用户问「原始 json 为什么就这么一点」）：捕获记录**只存元数据** ——
  //   甲方案：正文不落第二份副本，点开时按 offset 从会话日志切。想让 JSON 里也带上正文，就传 `withText=1`：
  //   这里额外给一份**读取时派生**的副本 `recordWithText`（`record` 本身依旧原样）；
  //   ⛔ 落盘的记录永远不会因此变大，派生这点也写在响应里，免得被当成"捕获存了正文"。
  if (params.get('withText') === '1' && entry && typeof text === 'string') {
    payload.recordWithText = Object.assign({}, entry, { text })
    payload.recordWithTextNote = '正文是读取时按 offset 从会话日志切出来的（⛔ 不落盘；落盘的记录只有元数据）'
  }
  if (typeof log?.info === 'function') {
    log.info(`[mt] 原始 JSON 出口：${sid} 第 ${record.turn} 楼 ${kind}${name === '' ? '（整楼）' : ' ' + name}，正文 ${text === null ? '取不到（' + textUnavailable + '）' : text.length + ' 字符'}`)
  }
  return send(200, payload)
}

/**
 * 从事件流里取「第 turn 楼的运行上下文快照」原文：那条 `user/message` 且 `source.kind === 'plugin'`
 * （真机实测形状：`{kind:'plugin', plugin:'@deepseek-ai/dsh-system-prompt', form:'snapshot', sections:[…]}`）。
 * 找不到 ⇒ null（调用方如实给 unavailable）。
 */
function pickContextSnapshotForTurn(events, turn) {
  let inTarget = false
  let endSeq = null
  for (const ev of events) {
    const seq = typeof ev?.seq === 'number' && Number.isFinite(ev.seq) ? ev.seq : null
    if (ev?.type === 'turn/start') {
      const t = typeof ev?.data?.turn === 'number' ? ev.data.turn : null
      if (!inTarget && t === turn) { inTarget = true; endSeq = null }
    } else if (ev?.type === 'turn/end' && inTarget) { endSeq = seq; break }
  }
  if (!inTarget) return null
  let best = null
  for (const ev of events) {
    if (ev?.type !== 'user/message') continue
    if (String(ev?.data?.source?.kind ?? '') !== 'plugin') continue
    const seq = typeof ev?.seq === 'number' && Number.isFinite(ev.seq) ? ev.seq : null
    if (endSeq !== null && seq !== null && seq > endSeq) continue
    const blocks = ev?.data?.content
    const textOf = typeof blocks === 'string'
      ? blocks
      : (Array.isArray(blocks) ? blocks.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('') : '')
    if (textOf !== '') best = textOf
  }
  return best
}

export const apply = registerSectionsCapture
