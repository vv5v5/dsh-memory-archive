/**
 * rp-agent.js —— v5 P1a「生成 / 修复 RP agent」真落盘写入面（独立模块，零 npm 依赖）
 *
 * 职责（规格《GLM任务-记忆库-v5-P1a-真落盘修复与联动.md》§二/§三/§五）：
 *   1) 可注入写入根：resolvePresetsRoot(env) —— 显式 env 优先（DSH_MEMORY_ARCHIVE_PRESETS_ROOT），
 *      默认由 DSH_HOME / homedir() 推导 <dshRoot>/.agent-presets。⛔ 绝不写死任何绝对路径。
 *      本模块的每个写入函数都只经由调用方传入的 presetsRoot 定位，方便在临时根上做全流程自检；
 *      真机 ~/.dsh/.agent-presets 的写入由验收方执行。
 *   2) 三条硬拒绝（§2.1）：trust !== 'user' ⇒ 拒（官方语义 agent-preset/read-only）；
 *      白名单外 id ⇒ 拒（默认只认 roleplay 与生成时登记的 id：前缀 roleplay 且已有本插件
 *      dma-binding.json）；standard/cordis/minimal/ptc、删 preset、写 plugins、改 profile bundles
 *      都不在本模块的写入面里（字段级白名单，见下），结构性越界无从发生。
 *   3) 写入四步（§2.3，一个不省）：备份（<preset>/.dma-backup/<名>.<时间戳>，只备份被改的文件）
 *      → 原子写（tmp-<pid> → fsync → rename）→ 回读校验（按预期值逐字节 + YAML 语义 + 注释保全）
 *      → 校验不过用备份原样盖回并返回可读错误。绝不留半截状态。
 *   4) 字段级白名单（§3.1，越界即拒）：agent.cordis.yml 只改压缩后端项的 customInstruction
 *      这一个标量（保注释的定点替换，⛔ 禁止 yaml.parse→stringify 整份重写；键不存在/多义/
 *      块标量/顶层键一律保守拒绝 + 可读原因，不猜位置）；dma-binding.json 是我们唯一的自有状态。
 *   5) 路径 F（从零生成，本机不会走到）：agentPresets.copy('cordis', <id>, '<显示名>')
 *      （★ 从 cordis 复制，不是 standard —— 规格书 §〇.2 实测修正）+ 生成 preset 级工具面收窄
 *      脚本（照 rp-tool-scope 的做法，常量见 RP_TOOL_SCOPE_JS）+ 保留 compaction 整块
 *      + ⛔ 不设 persona.complete。copy 之后仍走同一套 applyToPreset 四步写入。
 *
 * 降级纪律：本模块所有函数要么返回结果对象、要么抛给调用方前已自带可读 code/message；
 * 绝不碰 process、绝不让半个文件悬在盘上。
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const BINDING_FILE_NAME = 'dma-binding.json'
export const BACKUP_DIR_NAME = '.dma-backup'
const BINDING_SCHEMA_VERSION = 1
const MANAGED_BY = 'dsh-memory-archive'
const COMPOSITION_FILE_NAME = 'agent.cordis.yml'
const TOOL_SCOPE_FILE_NAME = 'rp-tool-scope.js'

/** 官方约束：preset id 同时是目录名（agent-presets/README.zh.md:75）。 */
const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]*$/
/** 白名单：固定 id + 「生成时登记的 id」= 前缀 roleplay 且目录里有我们的 dma-binding.json（或本次刚生成）。 */
const FIXED_ALLOWED_IDS = new Set(['roleplay'])
const GENERATED_ID_PREFIX = 'roleplay'
/** 随部署附带的 preset（⛔ 不可修改，官方语义只读）。 */
const DEPLOYMENT_IDS = new Set(['standard', 'cordis', 'minimal', 'ptc'])

/** §4.3 逐字口径：任一侧缺依赖时的界面指引（不是报错）。 */
export const GUIDANCE_ROOT_MISSING =
  '记忆库还没有根（没有选定会话或周目归档）。点这里选一个根，或先「生成 / 修复 RP agent」。'

/**
 * 路径 F 用：preset 级工具面收窄脚本（照本机 rp-tool-scope.js 的做法：
 * restrict({deny}) + 订阅 tools/change 重算 + 绝不抛）。★ 规格书 §五.3 明确允许
 * 「走 lib/rp-agent.js 里的常量」——本机那份讲究的脚本不硬编码进 lib，这里只按
 * §〇.1 实测口径（白名单 = anima_query / state_list / state_show）给生成副本用。
 */
const RP_TOOL_SCOPE_JS = `// 由 dsh-memory-archive 生成（v5 P1a 路径 F）：preset 级工具面收窄。
// 做法照 roleplay 的 rp-tool-scope：把「全部全局工具 − 白名单」deny 掉，并订阅
// tools/change 重算；任何一步失败都只降级（绝不抛，绝不让会话起不来）。
const ALLOW = ['anima_query', 'state_list', 'state_show']
function denyAllButAllowlist(ctx) {
  try {
    const tools = ctx && ctx.tools
    if (!tools || typeof tools.restrict !== 'function') return
    let names = []
    try {
      const all = typeof tools.list === 'function' ? tools.list() : []
      if (Array.isArray(all)) {
        names = all
          .map((t) => (t && typeof t === 'object' ? (t.name || t.id) : t))
          .filter((n) => typeof n === 'string' && n !== '')
      }
    } catch {}
    tools.restrict({ deny: names.filter((n) => !ALLOW.includes(n)) })
  } catch {}
}
export function activate(ctx) {
  denyAllButAllowlist(ctx)
  try {
    const tools = ctx && ctx.tools
    if (tools && typeof tools.on === 'function') tools.on('tools/change', () => denyAllButAllowlist(ctx))
    else if (ctx && ctx.events && typeof ctx.events.on === 'function') {
      ctx.events.on('tools/change', () => denyAllButAllowlist(ctx))
    }
  } catch {}
}
export function deactivate() {}
`

// ---------------------------------------------------------------------------
// 错误与结果的小工具（全部返回对象，不抛异常给调用方）
// ---------------------------------------------------------------------------

function fail(code, message, extra) {
  return Object.assign({ ok: false, code, message }, extra || {})
}

function nowStamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return (
    String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) +
    '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '-' + p(d.getMilliseconds(), 3)
  )
}

// ---------------------------------------------------------------------------
// 写入根（可注入；默认由 DSH_HOME / homedir() 推，⛔ 不写死绝对路径）
// ---------------------------------------------------------------------------

function expandHome(p, home = homedir()) {
  if (p === '~') return home
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2))
  return p
}

/**
 * presetsRoot 解析（规格 §2.2 的「可注入配置项」）：
 *   1) env.DSH_MEMORY_ARCHIVE_PRESETS_ROOT 显式指定（自检/多环境注入用）；
 *   2) 否则 <DSH_HOME | ~/.dsh>/.agent-presets（与宿主 P0 目录扫同源）。
 */
export function resolvePresetsRoot(env = process.env) {
  const explicit = env.DSH_MEMORY_ARCHIVE_PRESETS_ROOT
  if (explicit !== undefined && String(explicit).trim() !== '') {
    return resolve(expandHome(String(explicit)))
  }
  const configured = env.DSH_HOME
  const dshHome =
    configured !== undefined && String(configured).trim() !== ''
      ? String(configured)
      : join(homedir(), '.dsh')
  return join(resolve(expandHome(dshHome)), '.agent-presets')
}

export function dirExists(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** 白名单判定（§2.1 第 2 条）：roleplay 固定放行；生成登记的 id = 前缀 roleplay + 已有绑定（或本次刚生成）。 */
export function isAllowedPresetId(presetId, presetDir, justCreated) {
  if (FIXED_ALLOWED_IDS.has(presetId)) return true
  if (!presetId.startsWith(GENERATED_ID_PREFIX)) return false
  if (!AGENT_ID_RE.test(presetId)) return false
  if (justCreated) return true
  return existsSync(join(presetDir, BINDING_FILE_NAME))
}

// ---------------------------------------------------------------------------
// 原子写 + 备份（§2.3 第 1、2 步）
// ---------------------------------------------------------------------------

/** 原子写：tmp-<pid> → 全量写入 → fsync → rename 覆盖。⛔ 不许直接 writeFile 盖原文件。 */
function atomicWrite(file, data) {
  const tmp = file + '.tmp-' + process.pid
  const fh = openSync(tmp, 'w')
  try {
    let off = 0
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
    while (off < buf.length) off += writeSync(fh, buf, off, buf.length - off)
    fsyncSync(fh)
  } finally {
    closeSync(fh)
  }
  renameSync(tmp, file)
}

function readIfExists(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** 备份：写到 <presetDir>/.dma-backup/<原文件名>.<时间戳>，只备份要改的那几个文件。 */
function backupFile(presetDir, fileName, data, stamp) {
  const backupDir = join(presetDir, BACKUP_DIR_NAME)
  mkdirSync(backupDir, { recursive: true })
  const backupPath = join(backupDir, fileName + '.' + stamp)
  atomicWrite(backupPath, data)
  return { dir: backupDir, file: backupPath, name: fileName + '.' + stamp }
}

// ---------------------------------------------------------------------------
// agent.cordis.yml 的保注释定点替换（§3.1 第 1 行 + §3.3）
// ---------------------------------------------------------------------------

/** 把新值写成 YAML 字面量块标量（|-）：多行模板一行都不丢，且 P0 的提取器（块标量口径）能原样读回。 */
function buildBlockScalar(indent, value, trailingComment) {
  const cr = '' // 由调用方按 eol 统一处理
  const header =
    ' '.repeat(indent) + 'customInstruction: |-' + (trailingComment ? '  ' + trailingComment : '')
  const bodyLines = value.split('\n').map((l) => (l === '' ? '' : ' '.repeat(indent + 2) + l))
  return [header + cr].concat(bodyLines.map((l) => l + cr))
}

/**
 * 定位 customInstruction 键（不按后端 id 硬编码，§3.1）：
 * 扫全文件的键行（跳过注释行），配合「文件里确有 compaction 组/后端」的上下文检查。
 * 找不到 / 多处 / 顶层裸键 / 块标量 ⇒ 一律保守拒绝 + 可读原因，不猜位置。
 */
function locateInstruction(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  const hits = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*(#|$)/.test(line)) continue
    const m = /^(\s*)customInstruction\s*:(.*)$/.exec(line)
    if (m) hits.push({ index: i, indent: m[1].length, rest: m[2] })
  }
  const compactionCtx =
    /compaction-basic/.test(text) || /^\s*(?:-\s*)?(?:id|name)\s*:\s*['"]?compaction/m.test(text)
  if (hits.length === 0) {
    return fail(
      'CUSTOM_INSTRUCTION_MISSING',
      compactionCtx
        ? '未找到压缩后端项：agent.cordis.yml 里有 compaction 组但没有 customInstruction 键 —— 不猜位置、不整份重写'
        : '未找到压缩后端项：agent.cordis.yml 里既没有 compaction 组也没有 customInstruction 键 —— 不猜位置、不整份重写',
    )
  }
  if (hits.length > 1) {
    return fail(
      'CUSTOM_INSTRUCTION_AMBIGUOUS',
      '找到 ' + hits.length + ' 处 customInstruction 键，无法唯一定位压缩后端项 —— 保守拒绝（不猜位置）',
    )
  }
  if (!compactionCtx) {
    return fail(
      'NO_COMPACTION_CONTEXT',
      '文件里找不到 compaction 组/后端（compaction-basic），无法确认这处 customInstruction 属于压缩后端 —— 保守拒绝',
    )
  }
  const hit = hits[0]
  if (hit.indent === 0) {
    return fail(
      'CUSTOM_INSTRUCTION_TOPLEVEL',
      'customInstruction 出现在顶层而不是压缩后端的 config 里 —— 保守拒绝（不猜位置）',
    )
  }
  return { ok: true, eol, lines, hit }
}

/** 解析该行现有标量（只为报 from 与识别块标量；解析不了就如实说，不猜）。 */
function parseInlineScalar(rest) {
  const v = rest.trim()
  if (v === '') return { form: 'empty' }
  if (v === "''" || v === '""') return { form: 'quoted', value: '', comment: null }
  const sq = /^'((?:[^']|'')*)'\s*(#.*)?$/.exec(v)
  if (sq) return { form: 'quoted', value: sq[1].replace(/''/g, "'"), comment: sq[2] || null }
  const dq = /^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/.exec(v)
  if (dq) {
    let value
    try {
      value = JSON.parse('"' + dq[1] + '"')
    } catch {
      return { form: 'unsupported' }
    }
    return { form: 'quoted', value, comment: dq[2] || null }
  }
  if (/^[|>][-+]?(\s|#|$)/.test(v)) {
    const cm = /^[|>][-+]?\s+(#.*)$/.exec(v)
    return { form: 'block', comment: cm ? cm[1] : null }
  }
  const bare = /^(\S+)(\s+#.*)?$/.exec(v)
  if (bare) return { form: 'plain', value: bare[1], comment: bare[2] || null }
  return { form: 'unsupported' }
}

/** 从结果文本里按块标量口径读回 customInstruction（与宿主 P0 的提取器同口径），用于回读校验。 */
function extractBlockInstruction(text) {
  const m = /^[ \t]*customInstruction\s*:\s*[|>][-+]?\s*(?:#.*)?$/m.exec(text)
  if (!m) return null
  const srcLines = text.slice(m.index).split(/\r?\n/).slice(1)
  const body = []
  let indent = null
  for (const line of srcLines) {
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

/** 注释保全检查：原文每条注释行在结果里逐条还在（次数只多不少）。 */
export function commentsPreserved(originalText, newText) {
  const count = (t) => {
    const m = new Map()
    for (const line of String(t).split('\n')) {
      const s = line.trim()
      if (s.startsWith('#')) m.set(s, (m.get(s) || 0) + 1)
    }
    return m
  }
  const a = count(originalText)
  const b = count(newText)
  for (const [k, n] of a) if ((b.get(k) || 0) < n) return false
  return true
}

/**
 * 计算替换后的完整文本（⛔ 任何写盘之前调用；失败返回 {ok:false,*}）。
 * 定点替换 = 原文里「那一项」（单行标量，或我们/用户此前写的块标量整块）换成新块标量，
 * 其余每一行（含全部注释）原样保留 —— 本机那份四成是注释的文件只有这一处被碰。
 * 支持块标量是必须的：第一次应用之后键就变成 |- 块，二次修复要能原地替换，否则「修复」只能跑一次。
 */
function buildReplacement(text, value) {
  const located = locateInstruction(text)
  if (!located.ok) return located
  const { eol, lines, hit } = located
  const parsed = parseInlineScalar(hit.rest)
  if (parsed.form === 'unsupported') {
    return fail(
      'CUSTOM_INSTRUCTION_UNPARSABLE',
      'customInstruction 的现有值解析不了（非单引号/双引号/裸标量/块标量）——保守拒绝，不猜格式',
    )
  }
  // 计算要替换的行区间 [startIdx, endIdx]（含端点）：单行标量就是这一行；
  // 块标量是「头行 + 后续所有缩进更深（或空）的行」的连续段 —— 停在第一条缩进 ≤ 头行的非空行。
  let startIdx = hit.index
  let endIdx = hit.index
  let from = ''
  if (parsed.form === 'block') {
    for (let i = hit.index + 1; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim() === '') {
        endIdx = i
        continue
      }
      const indent = line.match(/^[ \t]*/)[0].length
      if (indent > hit.indent) {
        endIdx = i
        continue
      }
      break
    }
    const bodyLines = lines.slice(hit.index + 1, endIdx + 1)
    const inner = bodyLines
      .map((l) => (l.trim() === '' ? '' : l.slice(Math.min(hit.indent + 2, l.length))))
      .filter((l, i, arr) => !(l === '' && i === arr.length - 1))
    from = inner.length ? inner.join('\n') : ''
  } else {
    from = parsed.form === 'quoted' || parsed.form === 'plain' ? parsed.value : ''
  }
  const normalized = String(value).replace(/\r\n?/g, '\n').replace(/[\n\t ]+$/, '')
  if (normalized === '') {
    return fail('EMPTY_INSTRUCTION', '要写入的压缩指令是空的（没有可写的内容）——拒绝空写')
  }
  const cr = eol === '\r\n' ? '\r' : ''
  const header =
    ' '.repeat(hit.indent) + 'customInstruction: |-' + (parsed.comment ? '  ' + parsed.comment : '')
  const bodyLines = normalized
    .split('\n')
    .map((l) => (l === '' ? '' : ' '.repeat(hit.indent + 2) + l) + cr)
  const newLines = lines
    .slice(0, startIdx)
    .concat([header + cr], bodyLines, lines.slice(endIdx + 1))
  const newText = newLines.join('\n')
  return { ok: true, newText, value: normalized, from, eol }
}

// ---------------------------------------------------------------------------
// dma-binding.json（§3.1 第 3 行：我们唯一的自有状态）
// ---------------------------------------------------------------------------

export function readBinding(presetDir) {
  const raw = readIfExists(join(presetDir, BINDING_FILE_NAME))
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function writeBinding(presetDir, presetId, memoryArchiveRoot, now) {
  const binding = {
    schemaVersion: BINDING_SCHEMA_VERSION,
    presetId,
    memoryArchiveRoot: memoryArchiveRoot || null,
    updatedAt: now.toISOString(),
    managedBy: MANAGED_BY,
  }
  const file = join(presetDir, BINDING_FILE_NAME)
  const text = JSON.stringify(binding, null, 2) + '\n'
  atomicWrite(file, text)
  let readBack = null
  try {
    readBack = JSON.parse(readFileSync(file, 'utf8'))
  } catch {}
  if (!readBack || readBack.presetId !== presetId || readBack.managedBy !== MANAGED_BY) {
    return { written: false, file, error: 'dma-binding.json 回读校验不过（写入后读不回同样内容）' }
  }
  return { written: true, file, binding }
}

// ---------------------------------------------------------------------------
// 只读体检（dryRun 与面板预览共用；零写入）
// ---------------------------------------------------------------------------

export function inspectPreset({ presetsRoot, presetId, trust, justCreated }) {
  if (typeof presetId !== 'string' || !AGENT_ID_RE.test(presetId)) {
    return fail('BAD_PRESET_ID', 'presetId 必须匹配 [a-z0-9][a-z0-9-]*（它同时是目录名）')
  }
  if (DEPLOYMENT_IDS.has(presetId)) {
    return fail(
      'PRESET_READ_ONLY',
      '「' + presetId + '」是随部署附带的 preset（trust !== user，官方语义 agent-preset/read-only）——不可修改',
    )
  }
  const dir = join(resolve(presetsRoot), presetId)
  if (!dirExists(dir)) return fail('PRESET_NOT_FOUND', 'preset 目录不存在：' + dir)
  if (trust !== 'user') {
    return fail(
      'PRESET_READ_ONLY',
      '「' + presetId + '」不是用户自带（trust !== user，官方语义 agent-preset/read-only）——随部署附带，不可修改',
    )
  }
  if (!isAllowedPresetId(presetId, dir, justCreated)) {
    return fail(
      'PRESET_NOT_WHITELISTED',
      '「' + presetId + '」不在白名单里（只认 roleplay 与生成时登记的 id：前缀 roleplay 且有本插件的 dma-binding.json）',
    )
  }
  const composition = readIfExists(join(dir, COMPOSITION_FILE_NAME))
  if (composition === null) {
    return fail(
      'COMPOSITION_MISSING',
      '读不到 ' + join(dir, COMPOSITION_FILE_NAME) + ' —— 没有「生成/修复」的对象，不猜',
    )
  }
  return { ok: true, dir, composition, name: null, hasBinding: existsSync(join(dir, BINDING_FILE_NAME)) }
}

// ---------------------------------------------------------------------------
// applyToPreset：路径 R（就地修复）主体 = 四步写入；dryRun 全程零写入
// ---------------------------------------------------------------------------

/**
 * opts:
 *   presetsRoot        写入根（可注入，见 resolvePresetsRoot）
 *   presetId           白名单内的 preset id
 *   trust              调用方解析好的 trust（服务优先，退 user 根目录语义）；非 'user' 一律硬拒
 *   customInstruction  要写入的压缩指令（空/缺省由宿主侧先落到面板模板，这里再拒一次空串）
 *   memoryArchiveRoot  记忆库当前根的可读串（session/<id> 或 workspace/<char>/<play>）；null 也可写绑定
 *   dryRun             true ⇒ 一个字节都不写，只回「将要做什么」
 *   justCreated        路径 F 刚 copy 出来的 preset（本次白名单豁免，绑定会立刻补上）
 *   _fault             ★ 自检专用：'verify' 模拟回读不一致（测自动回滚），其余值忽略
 */
export function applyToPreset(opts) {
  const o = opts || {}
  // ---- 第 0 步：全部校验与文本计算都在任何写盘之前（失败 = 零写入）----
  const inspected = inspectPreset(o)
  if (!inspected.ok) return inspected
  const dir = inspected.dir
  const originalText = inspected.composition
  const built = buildReplacement(originalText, o.customInstruction)
  if (!built.ok) return built

  const stamp = nowStamp()
  const backupPlan = { dir: join(dir, BACKUP_DIR_NAME), files: [COMPOSITION_FILE_NAME + '.' + stamp] }
  const applied = [
    {
      file: COMPOSITION_FILE_NAME,
      field: 'compaction 后端 config.customInstruction',
      from: built.from === '' ? '（空字符串——记忆库压缩指令此前完全没生效）' : built.from,
      to: built.value,
    },
  ]

  if (o.dryRun) {
    return {
      ok: true,
      dryRun: true,
      path: 'repair',
      presetId: o.presetId,
      presetDir: dir,
      willApply: applied,
      backup: backupPlan,
      binding: {
        file: join(dir, BINDING_FILE_NAME),
        memoryArchiveRoot: o.memoryArchiveRoot || null,
        existed: inspected.hasBinding,
      },
      guidance: o.memoryArchiveRoot ? null : GUIDANCE_ROOT_MISSING,
      plan: [
        '备份 ' + COMPOSITION_FILE_NAME + ' → ' + backupPlan.dir + '/' + backupPlan.files[0],
        '定点替换 customInstruction（原值 ' + (built.from === '' ? '空字符串' : built.from.length + ' 字符') + ' → ' + built.value.length + ' 字符，其余行含全部注释原样保留）',
        '原子写（tmp → fsync → rename）→ 回读校验（逐字节 + YAML 块标量语义 + 注释保全）→ 不过则用备份自动回滚',
        '写 ' + BINDING_FILE_NAME + '（memoryArchiveRoot = ' + (o.memoryArchiveRoot || 'null（记忆库还没选根）') + '）',
      ],
      note: 'dryRun：以上是计划，本调用一个字节都没写。',
    }
  }

  // ---- 第 1 步：备份（只备份要改的文件）----
  let backup
  try {
    backup = backupFile(dir, COMPOSITION_FILE_NAME, originalText, stamp)
  } catch (e) {
    return fail('BACKUP_FAILED', '备份失败（未改动原文件）：' + String((e && e.message) || e))
  }

  // ---- 第 2 步：原子写 ----
  try {
    atomicWrite(join(dir, COMPOSITION_FILE_NAME), built.newText)
  } catch (e) {
    // 原子写失败时原文件未被 rename 碰过，仍是原样；如实报错。
    return fail('WRITE_FAILED', '原子写失败（原文件未被改动）：' + String((e && e.message) || e), {
      backup,
    })
  }

  // ---- 第 3 步：回读校验（按预期值：逐字节 + YAML 语义 + 注释保全）----
  let readBack = null
  try {
    readBack = readFileSync(join(dir, COMPOSITION_FILE_NAME), 'utf8')
  } catch {}
  let verifyBad = null
  if (readBack !== built.newText) verifyBad = '回读与预期文本逐字节不一致'
  else if (extractBlockInstruction(readBack) !== built.value) verifyBad = '回读后按 YAML 块标量语义提取的 customInstruction 与预期值不一致'
  else if (!commentsPreserved(originalText, readBack)) verifyBad = '回读后发现注释行丢失（注释保全校验不过）'
  if (o._fault === 'verify') verifyBad = '（自检注入）模拟回读不一致'

  // ---- 第 4 步：校验不过 ⇒ 用备份原样盖回，绝不留半截状态 ----
  if (verifyBad) {
    let rolledBack = false
    let rollbackError = null
    try {
      atomicWrite(join(dir, COMPOSITION_FILE_NAME), originalText)
      const restored = readFileSync(join(dir, COMPOSITION_FILE_NAME), 'utf8')
      rolledBack = restored === originalText
      if (!rolledBack) rollbackError = '回滚后读回的内容仍与原文不一致'
    } catch (e) {
      rollbackError = String((e && e.message) || e)
    }
    return fail(
      'VERIFY_FAILED',
      '回读校验不过（' + verifyBad + '）' + (rollbackError ? '；回滚也失败了：' + rollbackError : ''),
      { rolledBack, backup },
    )
  }

  // ---- 联动②：dma-binding.json（新文件，无需备份；同样原子写 + 回读）----
  const bindingResult = writeBinding(dir, o.presetId, o.memoryArchiveRoot, new Date())

  return {
    ok: true,
    dryRun: false,
    path: 'repair',
    presetId: o.presetId,
    presetDir: dir,
    applied,
    backup,
    binding: {
      written: bindingResult.written,
      file: bindingResult.file,
      memoryArchiveRoot: o.memoryArchiveRoot || null,
      error: bindingResult.written ? null : bindingResult.error,
    },
    guidance: o.memoryArchiveRoot ? null : GUIDANCE_ROOT_MISSING,
    errors: bindingResult.written ? [] : [bindingResult.error],
  }
}

// ---------------------------------------------------------------------------
// 路径 F：从零生成（本单实现；本机已有讲究的 roleplay，不会走到）
// ---------------------------------------------------------------------------

/**
 * opts: { service: ctx 的 agentPresets 服务, presetsRoot, presetId, displayName }
 * 步骤（§五）：copy('cordis', id, 显示名)（★ 不是 standard）→ 验证目录 → 写 rp-tool-scope.js
 * （工具面收窄照 rp-tool-scope 的做法）→ 保留 compaction（cordis 自带，我们不碰）→
 * ⛔ 不设 persona.complete。customInstruction 与 dma-binding.json 由随后的 applyToPreset 写。
 */
export async function generatePreset(opts) {
  const o = opts || {}
  const id = o.presetId
  if (typeof id !== 'string' || !AGENT_ID_RE.test(id)) {
    return fail('BAD_PRESET_ID', 'presetId 必须匹配 [a-z0-9][a-z0-9-]*（它同时是目录名），收到：' + JSON.stringify(id))
  }
  if (DEPLOYMENT_IDS.has(id)) {
    return fail('PRESET_READ_ONLY', '「' + id + '」是随部署附带的 preset id，不能拿来生成（也不能覆盖它）')
  }
  if (!id.startsWith(GENERATED_ID_PREFIX)) {
    return fail('BAD_PRESET_ID', '生成 id 必须用前缀「' + GENERATED_ID_PREFIX + '」（生成即登记进白名单），收到：' + id)
  }
  if (typeof o.displayName !== 'string' || o.displayName.trim() === '') {
    return fail('BAD_DISPLAY_NAME', '显示名（preset.yml 的 name = 新会话选择器里显示的那个）不能为空')
  }
  const ap = o.service
  if (!ap || typeof ap.copy !== 'function') {
    return fail(
      'SERVICE_MISSING',
      'agentPresets 服务不可用（拿不到 copy）——无法从 cordis 复制生成。可先在已有 user preset 上走「修复」',
    )
  }
  const root = resolve(o.presetsRoot)
  const dir = join(root, id)
  if (dirExists(dir)) {
    return fail('ALREADY_EXISTS', 'preset 目录已存在：' + dir + ' —— 不覆盖、不重命名（要改就走「修复」）')
  }
  try {
    await ap.copy('cordis', id, o.displayName.trim())
  } catch (e) {
    return fail('COPY_FAILED', 'agentPresets.copy(cordis, ' + id + ') 失败：' + String((e && e.message) || e))
  }
  if (!dirExists(dir)) {
    return fail('COPY_FAILED', 'copy 调用返回了但目录没出现（' + dir + '）——如实报错，不猜')
  }
  // 工具面收窄（新文件，无需备份；原子写 + 回读）。
  const scopePath = join(dir, TOOL_SCOPE_FILE_NAME)
  try {
    atomicWrite(scopePath, RP_TOOL_SCOPE_JS)
  } catch (e) {
    return fail('SCOPE_WRITE_FAILED', '写 ' + TOOL_SCOPE_FILE_NAME + ' 失败：' + String((e && e.message) || e))
  }
  const scopeBack = readIfExists(scopePath)
  if (scopeBack !== RP_TOOL_SCOPE_JS) {
    return fail('SCOPE_VERIFY_FAILED', TOOL_SCOPE_FILE_NAME + ' 回读校验不过')
  }
  return {
    ok: true,
    path: 'create',
    presetId: id,
    presetDir: dir,
    displayName: o.displayName.trim(),
    from: 'cordis',
    toolScope: scopePath,
    note: '骨架来自 cordis（compaction 整块保留；未设 persona.complete）。工具面由 ' + TOOL_SCOPE_FILE_NAME + ' 在 preset scope 收窄。',
  }
}

// ---------------------------------------------------------------------------
// 备份列表（GET /agent/backups 用；只读）
// ---------------------------------------------------------------------------

export function listBackups({ presetsRoot, presetId, trust, limit = 50 } = {}) {
  const inspected = inspectPreset({ presetsRoot, presetId, trust })
  if (!inspected.ok) return inspected
  const backupDir = join(inspected.dir, BACKUP_DIR_NAME)
  let entries = []
  try {
    entries = readdirSync(backupDir, { withFileTypes: true })
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { ok: true, presetId, backupDir, backups: [], note: '还没有备份（应用写入后备份会出现在这里）' }
    }
    return fail('LIST_BACKUPS_FAILED', '读备份目录失败：' + String((e && e.message) || e))
  }
  const backups = []
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.startsWith(COMPOSITION_FILE_NAME + '.')) continue
    const full = join(backupDir, ent.name)
    let mtimeMs = 0
    let bytes = 0
    try {
      const st = statSync(full)
      mtimeMs = st.mtimeMs
      bytes = st.size
    } catch {}
    backups.push({ file: ent.name, path: full, mtimeMs, mtime: new Date(mtimeMs).toISOString(), bytes })
  }
  backups.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return { ok: true, presetId, backupDir, backups: backups.slice(0, Math.max(1, limit)) }
}
