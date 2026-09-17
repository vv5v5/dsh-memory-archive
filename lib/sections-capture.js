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
import { makeDeferredAssembleListener } from './deferred-install.js'
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

      // ★★ 延迟挂载（2026-09-17 真机查出来的）：开机即挂的话，我们**排在所有插件最上游** ——
      //   实测抓到的是**下游 await 注入之前**的半成品：`anima:memory` 与世界书都不是注册段，
      //   而是**在 `system-prompt/assemble` 瀑布里 await 检索后改写 `out.sections`** 加进去的。
      //   后果：捕获记的 `renderedChars/renderedHash` 是半成品的大小/哈希，而 §9 切片要求它与
      //   **最终**系统消息逐字节相等 ⇒ 查看器"点开看正文"永远 `slice-mismatch`（"内容不可用（校验未通过）"）。
      //   证据（真机 session-c37c466c）：turn 1 没有 anima/世界书 ⇒ 捕获 13308 与日志 13308 完全一致；
      //   turn 2 有 ⇒ 捕获 8931 对不上日志 11248。
      //   解法与理由见 lib/deferred-install.js：第一个会话事件时**追加**一份下游版，哨兵退位。
      /** 装配监听的模式（`upstream-sentinel` | `downstream`）—— 写进每条记录，便于排查插入顺序。
       *  ⛔ 它**不是**"凭据可不可信"的判据：anima 是 `next()` 之后才改写，排多后都拿不到它的产出。
       *  那个判据是记录上的 `finalized`。 */
      const listenMode = { now: () => 'upstream-sentinel' }

      /** 每会话留一份"等最终正文来定位"的待定记录（有界，只留该会话最后一条）。 */
      const pending = new Map()

      /**
       * DSH 把**最终系统正文**写进会话日志时，按段序在它里面定位真 offset，然后**覆写**该楼记录
       * （`compactWrite` 同楼后写覆盖先写，所以就是"补完"那一条）。
       * ⛔ 只有**全部非空段都落位**才发布 offset —— 部分命中说明正文与我们的段表不是同一份，
       *   此时宁可不给正文位置，也不给可能错位的（界面上会如实显示"未记录位置"）。
       * @returns {{ok:boolean, reason:string, matched?:number, total?:number}}
       */
      const finalizePending = (sessionId, finalText, dshTurn) => {
        const p = pending.get(sessionId)
        if (p === undefined) return { ok: false, reason: 'no-pending' }
        if (Number.isFinite(dshTurn) && Number.isFinite(p.record.turn) && dshTurn !== p.record.turn) {
          return { ok: false, reason: 'turn-mismatch' }
        }
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
          return { ok: false, reason: r.reason, matched: r.matched, total: r.total }
        }
        const renderedHash = hash16(finalText)
        for (const [i, s] of p.record.sections.entries()) {
          s.offset = r.offsets[i].offset
          s.renderedChars = r.renderedChars
          s.renderedHash = renderedHash
        }
        p.record.finalized = true
        p.record.finalizeReason = 'located'
        enqueueWrite(sessionId, p.record)
        pending.delete(sessionId)
        return { ok: true, reason: 'located', matched: r.matched, total: r.total }
      }
      const runCapture = async (assembly, assembleContext, next) => {
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
          if (!sessionId) return next() // 认不出会话就不记（不猜）
          if (opts.getSectionOrder === null) {
            try {
              opts.getSectionOrder = (key) => scope.systemPrompt.getSectionOrder(key)
            } catch {
              opts.getSectionOrder = () => undefined
            }
          }
          const defs = readSectionDefs(scope.systemPrompt, assembleContext?.scope)
          const record = buildRecord(assembly, assembleContext, defs, opts)
          const turn = resolveTurn(agent)
          if (!Number.isFinite(turn)) {
            if (opts.debug) debugLog(opts.dir, { event: 'skip-no-turn', sessionId })
            return next() // 轮号拿不到：宁可漏记也不记错楼
          }
          record.turn = turn
          // ★ `listenerMode` 只说明"排在谁后面"，⛔ **不代表**能拿到 anima 那种 `next()` 之后改写的产出
          //   （2026-09-17 真机查死：瀑布之后只有 DSH 自己看得见，没有"装配完成"钩子）。
          //   所以它**不能**用来判断"凭据可不可信" —— 判据是下面的 `finalized`。
          record.listenerMode = listenMode.now()
          // ★★ 装配期**不发布 offset / 整段凭据**：这个位置原理上拿不到最终正文（见 lib/final-text-locate.js
          //    的模块说明）。旧行为在这里记的是"注入前"的位置与哈希 ⇒ §9 切片永远 `slice-mismatch`
          //    （界面上表现为"内容不可用（校验未通过）"）。改成先把位置**如实留空**，
          //    等 DSH 把最终正文写进会话日志（`system/message`）后再由 finalizePending 填上真位置。
          for (const s of record.sections) {
            s.offset = null
            s.renderedChars = null
            s.renderedHash = null
          }
          record.finalized = false
          record.finalizeReason = 'waiting-final-text'
          pending.set(sessionId, { record, at: Date.now() })
          while (pending.size > PENDING_MAX_SESSIONS) {
            const oldest = pending.keys().next().value
            if (oldest === undefined) break
            pending.delete(oldest)
          }
          enqueueWrite(sessionId, record)
        } catch (e) {
          // 捕获通道自身绝不影响组装瀑布：任何异常都吞掉并继续。
          try {
            scope?.logger?.warn?.(`[mt-sections] 捕获失败（忽略）：${e?.stack || e}`)
          } catch {}
        }
        return next()
      }
      // ⚠️ **必须挂在插件顶层 ctx（`context`），⛔ 不能挂在子作用域 `scope` 上**（2026-09-17 真机实测）：
      //   挂 `scope` 时沙箱能收到 `session/event`、**真机收不到**（真机多挂了一堆插件，会话事件
      //   来自另一棵子树）⇒ 延迟接管永远不触发，捕获永远留在上游（实测 turn 3 的捕获里
      //   `anima:memory` 仍是 `chars=0`，而最终系统消息里有内容）。
      //   顶层 ctx 这条路已被 PHI 摘除器证明：`system-prompt/assemble` 与 `session/event` 都收得到。
      //   ⛔ `runCapture` 里继续用子作用域的 `scope`（它有 `systemPrompt`/`sessionProjections` 注入），只换注册位置。
      const deferred = makeDeferredAssembleListener({
        on: typeof context.on === 'function' ? context.on.bind(context) : null,
        run: runCapture,
        log: scope?.logger,
      })
      listenMode.now = deferred.mode
      // ★ `system/message` —— DSH 把**最终**系统正文写进会话日志的那一刻，**唯一**能拿到最终正文的时机
      //   （瀑布里原理上拿不到：anima 是 `next()` 之后才改写、DSH 之后还做 complete 覆盖，
      //   而且整个 system-prompt 包里**没有**任何"装配完成"事件）。
      //   同样挂在**插件顶层 ctx**：子作用域在真机上收不到 `session/event`（2026-09-17 实测）。
      if (typeof context.on === 'function') {
        context.on('session/event', (session, event) => {
          try {
            if (event?.type !== 'system/message') return
            const sid = session?.id
            if (typeof sid !== 'string' || sid === '') return
            const content = event?.data?.message?.content
            if (!Array.isArray(content)) return
            const text = content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
            if (text === '') return
            finalizePending(sid, text, event?.data?.turn)
          } catch { /* 定位失败绝不影响这一轮 */ }
        })
      }
      scope.effect(() => deferred.dispose, 'dsh-memory-archive-sections-capture: assemble listener')
      try {
        mkdirSync(opts.dir, { recursive: true })
      } catch {}
      scope.logger?.info?.(`[mt-sections] 组装捕获已挂载（dir=${basename(opts.dir)}，fullText=${opts.fullText ? 'on' : 'off'}；装配监听=${deferred.mode()}）`)
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
  return out
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
  const base = { ok: true, sessionId: sid, turn: record.turn, name: sectionName, source: 'captured' }
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
