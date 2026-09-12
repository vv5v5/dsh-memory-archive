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
 *   6) v5 P2：restoreFromBackup —— 一键回滚。三条硬拒绝与 applyToPreset 完全一致，
 *      外加 backupFile 的目录穿越防御（只认 .dma-backup/ 下的纯文件名）；回滚前先把
 *      「当前文件」再备份一次 ⇒ 回滚本身可再回滚；然后复用同一套原子写 + 逐字节回读校验，
 *      不过就用第 1 步的备份自动盖回。dryRun:true 零写入。
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
import { basename, dirname, join, resolve } from 'node:path'

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
 * 路径 F 用：preset 级工具面收窄脚本（照本机 rp-tool-scope.js 的做法）。
 * ★ 新契约（沙箱与隔离-开发原则.md §8）：要进 RP 会话的工具必须挂在 RP 的 preset 上，
 *   挂在 profile 层的一律看不见 ⇒ 收窄规则只有一条：deny = 全部全局工具 − run_code
 *   （白名单已退役：迁移后 anima_query/state_show/state_list 在 preset scope 内注册，
 *   不再是全局工具，allow 一条都匹配不上 —— 那是死代码，§1.2.3 明令删掉）。
 * ★ 三个已验证的优点一个不丢（rp-tool-scope.js 跑通过的）：
 *   订阅 tools/change 重算（mcp 工具晚注册；重算时【先装新层再撤旧层】—— fail-closed：
 *   装新层失败时旧遮罩原样保留，绝不出现「完全没收窄」的窗口态）；
 *   重入保护（restrict() 自身会 emit tools/change ⇒ applying 标志挡递归）；
 *   绝不抛（整段 try/catch，出错只降级并大声写日志 —— 这一行抛 = preset 挂不上）。
 * ★ 导出形状照跑通脚本：export function apply(ctx, config)（cordis registry.resolve()
 *   只认「函数」或「带 .apply 函数的对象」，vendor/cordis/src/registry.ts:222-228）。
 * ★ 枚举用 ctx.tools.schemas()（ToolRuntime 没有 list()；不带 scope = 全局视图，
 *   正是 restrict() 能点名的那个名字集合）。
 */
const RP_TOOL_SCOPE_JS = `// 由 dsh-memory-archive 生成（v5 修复单 v2）：preset 级工具面收窄。
// 契约（沙箱与隔离-开发原则.md §8）：要进 RP 会话的工具必须挂在 RP 的 preset 上，
// 挂在 profile 层的一律看不见 —— 收窄规则只有一条：deny = 全部全局工具 − run_code。
// 导出形状照本目录跑通的 rp-tool-scope.js / story-anchor.js：export function apply(ctx, config)
//（cordis registry.resolve() 只认「函数」或「带 .apply 函数的对象」，registry.ts:222-228）。
const RESERVED_TRANSPORT = ['run_code'] // 受保护传输层：restrict() 不接受点名它，⛔ 绝不进 deny
let applying = false // 重入保护：restrict() 自身会 emit tools/change，无标志位会递归
let lastKey = null // 上次生效的 deny 指纹：没变化就不重放（也兜住异步重发的事件，免得来回重算）
let liftLast = null // 上一次 restrict() 返回的 disposer：重算前先撤它（限制按层叠加且相交，不撤会越堆越多）
function denyAllButTransport(ctx) {
  if (applying) return
  applying = true
  try {
    const tools = ctx && ctx.tools
    if (!tools || typeof tools.schemas !== 'function' || typeof tools.restrict !== 'function') return
    let names = []
    const all = tools.schemas() // 不带 scope = 全局视图（正是 restrict 能点名的那个名字集合）
    if (Array.isArray(all)) {
      names = all
        .map((t) => (t && typeof t === 'object' ? t.name || t.id : t))
        .filter((n) => typeof n === 'string' && n !== '')
    } else if (all && typeof all === 'object') {
      names = Object.keys(all).filter((n) => typeof n === 'string' && n !== '')
    }
    const deny = names.filter((n) => !RESERVED_TRANSPORT.includes(n))
    const key = deny.join('\\n')
    if (key === lastKey) return
    // 先加后撤（fail-closed）：restrict() 的官方契约是「返回值 = 撤掉这一层的 disposer」
    //（packages/core/tools/src/index.ts:1060/1084-1088；restrictions 相交、按层 append）。
    // ★ 窗口期无害：deny 只会增长（晚注册是追加进全局表）⇒ 旧 deny ⊆ 新 deny，而多层限制
    //   相交 ⇒ 窗口期有效 deny = 旧 ∪ 新 = 新（正是目标值，既不偏窄也不偏宽）。
    // ★ 若 restrict() 抛（schemas→restrict 之间 MCP 中途断开、工具名失效）：旧层原样不动
    //   （liftLast/lastKey 都不变 ⇒ 下次 tools/change 自动重试），只记降级日志、绝不抛穿
    //   —— 旧顺序「先撤后加」在第二步抛时 = 完全没收窄（29 个 mcp__chrome__* 全看见），严格更差。
    let next = null
    try {
      next = tools.restrict({ deny })
    } catch (e) {
      const say = ctx && ctx.log && typeof ctx.log.warn === 'function' ? ctx.log.warn.bind(ctx.log) : null
      if (say) say('[rp-tool-scope] 收窄失败，旧遮罩保持原样（fail-closed）：' + String((e && e.message) || e))
      return
    }
    if (typeof liftLast === 'function') {
      try {
        liftLast()
      } catch {}
    }
    liftLast = next
    lastKey = key
  } catch (e) {
    const say = ctx && ctx.log && typeof ctx.log.warn === 'function' ? ctx.log.warn.bind(ctx.log) : null
    if (say) say('[rp-tool-scope] 枚举全局工具失败，降级为不收窄：' + String((e && e.message) || e))
  } finally {
    applying = false
  }
}
export function apply(ctx, config) {
  denyAllButTransport(ctx)
  try {
    const tools = ctx && ctx.tools
    if (tools && typeof tools.on === 'function') {
      tools.on('tools/change', () => denyAllButTransport(ctx))
    } else if (ctx && ctx.events && typeof ctx.events.on === 'function') {
      ctx.events.on('tools/change', () => denyAllButTransport(ctx))
    }
  } catch {}
}
`

/**
 * 工具面脚本契约自检（修复单 v2 §二）：生成路径写盘前必过；修复路径只读校验并如实报告。
 * 条目口径出处：
 *   - EXPORT_SHAPE：vendor/cordis/src/registry.ts:222-228 的 resolve() 只认「函数」或
 *     「带 .apply 函数的对象」（isApplicable 见 :8-10）——activate/deactivate 之类挂不上；
 *   - 枚举：packages/core/tools/src/index.ts 的 ToolRuntime 没有 list()（只有
 *     register/restrict/guard/get/schemas:1225）——tools.list() 会静默落 []；
 *   - 白名单退役：新契约 deny = 全部全局 − run_code（沙箱与隔离-开发原则.md §8），
 *     迁移后 anima_query/state_show/state_list 在 preset scope 内注册，allow 是死代码；
 *   - run_code：受保护传输层，restrict() 不接受点名它（会抛）⇒ 绝不进 deny。
 */
export function checkToolScopeContract(scriptText) {
  const t = String(scriptText == null ? '' : scriptText)
  const violations = []
  const add = (code, detail) => violations.push({ code, detail })
  if (!(
    /export\s+function\s+apply\s*\(/.test(t) ||
    /export\s*\{[^}]*\bapply\b[^}]*\}/.test(t) ||
    /export\s+default[\s\S]{0,200}\bapply\b/.test(t)
  )) {
    add('EXPORT_SHAPE', '导出形状 cordis 解析不了：需要 export function apply(ctx, config)（或带 .apply 的导出对象）——registry.ts:222-228 只认这两种')
  }
  if (t.includes('tools.list(')) {
    add('USES_TOOLS_LIST', 'ToolRuntime 没有 list()（只有 schemas()）——tools.list() 会静默落空，一个工具都挡不掉')
  }
  if (!t.includes('tools.schemas(')) {
    add('NO_SCHEMAS_ENUM', '没有用 tools.schemas() 枚举全局工具（不带 scope 的全局视图正是 restrict 能点名的名字集合）')
  }
  if (!t.includes('tools/change')) {
    add('NO_CHANGE_SUBSCRIPTION', '没有订阅 tools/change —— mcp 那类晚注册的工具会被静默漏掉')
  }
  if (!/\bapplying\b/.test(t)) {
    add('NO_REENTRY_GUARD', '没有重入保护（restrict() 自身会 emit tools/change，无标志位会递归）')
  }
  if (/\bALLOW\b/.test(t) || t.includes('config.allow')) {
    add('HAS_ALLOWLIST', '还留着白名单（ALLOW / config.allow）——新契约 deny = 全部全局 − run_code，白名单已退役')
  }
  if (!(/\['run_code'\]/.test(t) && /deny\s*=\s*[\s\S]{0,200}RESERVED_TRANSPORT/.test(t))) {
    add('RUN_CODE_NOT_EXCLUDED', 'deny 构造没有排除 run_code（restrict() 不接受点名它，会抛）')
  }
  if (!(/try\s*\{/.test(t) && /\bcatch\b/.test(t))) {
    add('NO_TRY_CATCH', '整段没有 try/catch —— 脚本一行抛异常 = preset 挂不上 = 用户开不了周目')
  }
  return { ok: violations.length === 0, violations }
}

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

/**
 * 写前重核（修复单 v2 §四，TOCTOU）：rename 之前、备份之前调用。
 * 背景：另一条会话正在往同一个 agent.cordis.yml 迁 dsh-state-bridge/dsh-anima-rag；
 * 「读盘→定点替换→原子写」挡得住陈旧覆盖，但挡不住「读→rename 之间对方写入」——
 * 旧读会把对方的新行 rename 掉，而回读校验两边各自自洽、不会报。⇒ 写前重读一次：
 * 1) mtimeMs+size 与读取时比对；2) 再逐字节比对一次（覆盖 mtime 精度不足）。
 * 任一不过 ⇒ 返回 CONCURRENT_MODIFICATION（调用方必须中止、零写入）。
 * ★ faulted = _fault:'recheck'（自检钩子，模拟重核不过），与 applyToPreset 的 _fault:'verify' 同思路。
 */
function recheckUnchanged(dir, fileName, recordedText, recordedStat, faulted) {
  if (faulted) {
    return fail('CONCURRENT_MODIFICATION', '写前重核不过：文件在读取之后被别的进程改过（mtime/size 变了）——已中止，未写入任何内容')
  }
  const file = join(dir, fileName)
  let st = null
  try {
    st = statSync(file)
  } catch {}
  if (!st) {
    return fail('CONCURRENT_MODIFICATION', '写前重核不过：文件现在读不到了（可能被删除或改名）——已中止，未写入任何内容')
  }
  if (recordedStat && (st.mtimeMs !== recordedStat.mtimeMs || st.size !== recordedStat.size)) {
    return fail('CONCURRENT_MODIFICATION', '写前重核不过：文件在读取之后被别的进程改过（mtime/size 变了）——已中止，未写入任何内容')
  }
  const nowText = readIfExists(file)
  if (nowText !== recordedText) {
    return fail('CONCURRENT_MODIFICATION', '写前重核不过：文件内容与读取时已不一致（逐字节比对不过，覆盖 mtime 精度不足）——已中止，未写入任何内容')
  }
  return { ok: true }
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
  // ③ 提案式差异（v5 P2）：只取被替换的那一段（单行标量 = 那一行；块标量 = 头行 + 正文整块），
  // ⛔ 不贴整个文件；before/after 截断，防止超长模板撑爆面板。line = 1 起算的行号（原头行）。
  const clipSeg = (s) => (s.length > 400 ? s.slice(0, 400) + '…（截断，共 ' + s.length + ' 字符）' : s)
  const segBefore = lines.slice(startIdx, endIdx + 1).join('\n')
  const segAfter = [header]
    .concat(bodyLines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)))
    .join('\n')
  return {
    ok: true,
    newText,
    value: normalized,
    from,
    eol,
    diff: { line: startIdx + 1, before: clipSeg(segBefore), after: clipSeg(segAfter) },
  }
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
  const target = join(dir, COMPOSITION_FILE_NAME)
  // 写前重核要用：读之前先 statSync 记下 mtimeMs/size（修复单 v2 §四.1）
  let stat = null
  try {
    stat = statSync(target)
  } catch {}
  const composition = readIfExists(target)
  if (composition === null) {
    return fail(
      'COMPOSITION_MISSING',
      '读不到 ' + target + ' —— 没有「生成/修复」的对象，不猜',
    )
  }
  return {
    ok: true,
    dir,
    composition,
    stat: stat ? { mtimeMs: stat.mtimeMs, size: stat.size } : null,
    name: null,
    hasBinding: existsSync(join(dir, BINDING_FILE_NAME)),
  }
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
 *   dryRun             true ⇒ 一个字节都不写，只回「将要做什么」（含工具面契约自检与写前重核的如实报告）
 *   justCreated        路径 F 刚 copy 出来的 preset（本次白名单豁免，绑定会立刻补上）
 *   _fault             ★ 自检专用：'verify' 模拟回读不一致（测自动回滚）、'recheck' 模拟写前重核
 *                        不过（测并发中止），其余值忽略
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

  // ---- ② 修复路径也校验工具面契约（只读 + 如实报告；⛔ 不改写别人的 rp-tool-scope.js）----
  // 修复路径的写入面只有 customInstruction（P1 规格钉死的白名单）；工具面只校验、绝不顺手改写。
  // （TOOL_SCOPE_FILE_NAME 此前只在 generatePreset 出现 —— 修复路径完全不校验，是本单补上的缺口。）
  const scopePath = join(dir, TOOL_SCOPE_FILE_NAME)
  const scopeText = readIfExists(scopePath)
  const scopeChecked = scopeText === null
    ? { present: false, ok: null, violations: [] }
    : Object.assign({ present: true }, checkToolScopeContract(scopeText))
  const toolScope = {
    file: scopePath,
    present: scopeChecked.present,
    ok: scopeChecked.ok,
    violations: scopeChecked.violations,
  }

  // ---- ④ 写前重核（TOCTOU）：发生在 rename 之前、备份之前（不过则连备份都不产生）----
  const recheck = recheckUnchanged(dir, COMPOSITION_FILE_NAME, originalText, inspected.stat, o._fault === 'recheck')

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
  const scopeLine = toolScope.present
    ? (toolScope.ok
      ? '工具面契约自检：' + TOOL_SCOPE_FILE_NAME + ' 通过'
      : '⚠ 工具面契约自检未通过（' + TOOL_SCOPE_FILE_NAME + '，' + toolScope.violations.length + ' 条违例）——只报告不改写，详见 toolScope.violations')
    : '工具面契约自检：本 preset 没有 ' + TOOL_SCOPE_FILE_NAME + '（未校验）'
  const recheckLine = recheck.ok
    ? '写前重核（mtime/size + 逐字节）：通过，未检测到并发修改'
    : '⚠ 写前重核：检测到并发修改（' + (recheck.code || '?') + '）——此时真写将被中止，不落任何字节'

  if (o.dryRun) {
    return {
      ok: true,
      dryRun: true,
      path: 'repair',
      presetId: o.presetId,
      presetDir: dir,
      willApply: applied,
      // ③ 提案式差异（v5 P2 只增字段，既有字段形状不变）：逐行对照被改的那一段。
      diff: built.diff,
      // ② 工具面契约自检结果（只读报告，不阻塞修复写入）
      toolScope,
      // ④ 写前重核结果（dryRun 本就不写；如实报告是否检测到并发修改）
      recheck: { ok: recheck.ok, code: recheck.code || null },
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
        scopeLine,
        recheckLine,
      ],
      note: 'dryRun：以上是计划，本调用一个字节都没写。',
    }
  }

  // ---- 写前重核不过 ⇒ 中止、零写入（备份都还没开始做，不留任何痕迹）----
  if (!recheck.ok) return recheck

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
    // ② 工具面契约自检结果（只读报告；违例由界面标红，修复写入不受它阻塞）
    toolScope,
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
  // ---- ② 契约自检（写盘之前）：copy 会创建 preset 目录，也算写 —— 自检不过就连 copy 都不做 ----
  const contract = checkToolScopeContract(RP_TOOL_SCOPE_JS)
  if (!contract.ok) {
    return fail(
      'TOOL_SCOPE_CONTRACT',
      '生成物的工具面脚本没过契约自检（未写盘）：'
        + contract.violations.map((v) => v.code + '（' + v.detail + '）').join('；'),
      { violations: contract.violations },
    )
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

// ---------------------------------------------------------------------------
// restoreFromBackup（v5 P2 ① 一键回滚）：把 .dma-backup/ 里的某份备份盖回
// agent.cordis.yml；回滚前先把当前文件再备份一次 ⇒ 回滚本身可再回滚。
// ---------------------------------------------------------------------------

/**
 * backupFile 的目录穿越防御（§1.2 第 2 条）：只允许【纯文件名】——
 * ⛔ 不许含 /、\、..、:（Windows 盘符/ADS 也一并拒），basename 比对兜底；
 * 然后必须【确实存在】于 <preset>/.dma-backup/ 之下且是可读的常规文件。
 * 任何一条不过 ⇒ ok:false + 可读 code（BAD_BACKUP_NAME / BACKUP_NOT_FOUND / BACKUP_UNREADABLE）。
 */
function resolveBackupFile(backupFile, backupDir) {
  if (typeof backupFile !== 'string' || backupFile.trim() === '') {
    return fail('BAD_BACKUP_NAME', '缺 backupFile：必须是 .dma-backup/ 下的纯文件名（如 agent.cordis.yml.<时间戳>）')
  }
  if (backupFile.includes('/') || backupFile.includes('\\') || backupFile.includes('..') || backupFile.includes(':')) {
    return fail(
      'BAD_BACKUP_NAME',
      'backupFile 只允许纯文件名（不许含 / \\ .. : 等路径成分，防目录穿越）：' + JSON.stringify(backupFile),
    )
  }
  if (basename(backupFile) !== backupFile) {
    return fail('BAD_BACKUP_NAME', 'backupFile 必须是纯文件名（basename 比对不过）：' + JSON.stringify(backupFile))
  }
  const path = join(backupDir, backupFile)
  if (dirname(path) !== backupDir) {
    return fail('BAD_BACKUP_NAME', '解析出的路径不在备份目录里：' + JSON.stringify(backupFile))
  }
  let st = null
  try {
    st = statSync(path)
  } catch {}
  if (!st || !st.isFile()) {
    return fail('BACKUP_NOT_FOUND', '.dma-backup/ 里没有这份备份（或不是常规文件）：' + backupFile)
  }
  let text = null
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    return fail('BACKUP_UNREADABLE', '备份读不出来：' + backupFile + ' —— ' + String((e && e.message) || e))
  }
  return { ok: true, path, name: backupFile, text, bytes: st.size }
}

/**
 * opts:
 *   presetsRoot / presetId / trust  与 applyToPreset 同一套三条硬拒绝（走同一个 inspectPreset）
 *   backupFile                      .dma-backup/ 下的纯文件名（防目录穿越，见 resolveBackupFile）
 *   dryRun                          true ⇒ 一个字节都不写，只回「将把哪个备份盖回哪个文件、当前文件会被先备份到哪」
 *   _fault                          ★ 自检专用：'verify' 模拟回读不一致（测自动回滚），其余值忽略
 * 返回形状与 applyToPreset 对齐：{ ok, dryRun?, presetId, presetDir, restoredFrom, backup, readBack, errors? }
 */
export function restoreFromBackup(opts) {
  const o = opts || {}
  // ---- 第 0 步：全部校验与读取都在任何写盘之前（失败 = 零写入）----
  const inspected = inspectPreset(o) // trust !== 'user' / 部署 id / 白名单 / 目录 / 组成文件都在这里硬拒
  if (!inspected.ok) return inspected
  const dir = inspected.dir
  const target = join(dir, COMPOSITION_FILE_NAME)
  const currentText = inspected.composition // 回滚对象=当前文件内容（读不到时 inspectPreset 已拒）
  const backupDir = join(dir, BACKUP_DIR_NAME)
  const found = resolveBackupFile(o.backupFile, backupDir)
  if (!found.ok) return found

  // ---- ④ 写前重核（TOCTOU）：rename 之前、安全备份之前（不过则连备份都不产生）----
  const recheck = recheckUnchanged(dir, COMPOSITION_FILE_NAME, currentText, inspected.stat, o._fault === 'recheck')

  const stamp = nowStamp()
  // 回滚前那份「当前文件」的备份（第 1 步要用；dryRun 里只是计划）
  const safetyPlan = { dir: backupDir, file: join(backupDir, COMPOSITION_FILE_NAME + '.' + stamp), name: COMPOSITION_FILE_NAME + '.' + stamp }
  const recheckLine = recheck.ok
    ? '写前重核（mtime/size + 逐字节）：通过，未检测到并发修改'
    : '⚠ 写前重核：检测到并发修改（' + (recheck.code || '?') + '）——此时真回滚将被中止，不落任何字节'

  if (o.dryRun) {
    return {
      ok: true,
      dryRun: true,
      presetId: o.presetId,
      presetDir: dir,
      restoredFrom: { file: found.path, name: found.name, bytes: found.bytes },
      backup: safetyPlan,
      recheck: { ok: recheck.ok, code: recheck.code || null },
      plan: [
        '把备份 ' + found.name + '（' + found.bytes + ' 字节）盖回 ' + target,
        '回滚前先把当前文件备份到 ' + safetyPlan.file + '（回滚本身可再回滚，绝不吃掉唯一副本）',
        '原子写（tmp → fsync → rename）→ 回读校验（逐字节比对备份内容）→ 不过则用第 2 步的备份自动回滚',
        recheckLine,
      ],
      note: 'dryRun：以上是计划，本调用一个字节都没写。',
    }
  }

  // ---- 写前重核不过 ⇒ 中止、零写入（安全备份也还没做，不留任何痕迹）----
  if (!recheck.ok) return recheck

  // ---- 第 1 步：先把「当前文件」备份一次（这步失败 ⇒ 整个操作 ok:false、零写入）----
  let safety
  try {
    safety = backupFile(dir, COMPOSITION_FILE_NAME, currentText, stamp)
  } catch (e) {
    return fail('BACKUP_FAILED', '回滚前备份当前文件失败（未改动任何文件）：' + String((e && e.message) || e))
  }

  // ---- 第 2 步：原子写（复用 P1a 的 atomicWrite：tmp-<pid> → fsync → rename）----
  try {
    atomicWrite(target, found.text)
  } catch (e) {
    // rename 没发生 ⇒ 原文件未被碰过；如实报错（第 1 步的备份照常保留，可追溯）。
    return fail('WRITE_FAILED', '原子写失败（原文件未被改动）：' + String((e && e.message) || e), {
      backup: safety,
    })
  }

  // ---- 第 3 步：回读校验（逐字节：备份内容 === 现在文件内容）----
  let readBack = null
  try {
    readBack = readFileSync(target, 'utf8')
  } catch {}
  let verifyBad = null
  if (o._fault === 'verify') verifyBad = '（自检注入）模拟回读不一致'
  else if (readBack !== found.text) verifyBad = '回读与备份内容逐字节不一致'

  // ---- 第 4 步：校验不过 ⇒ 用第 1 步那份「当前文件」的备份自动盖回，绝不留半截状态 ----
  if (verifyBad) {
    let rolledBack = false
    let rollbackError = null
    try {
      atomicWrite(target, currentText)
      rolledBack = readFileSync(target, 'utf8') === currentText
      if (!rolledBack) rollbackError = '回滚后读回的内容仍与回滚前不一致'
    } catch (e) {
      rollbackError = String((e && e.message) || e)
    }
    return fail(
      'VERIFY_FAILED',
      '回读校验不过（' + verifyBad + '）；已用回滚前的备份自动恢复，原文件未变' +
        (rollbackError ? '；恢复也失败了：' + rollbackError : ''),
      { rolledBack, backup: safety },
    )
  }

  return {
    ok: true,
    dryRun: false,
    presetId: o.presetId,
    presetDir: dir,
    restoredFrom: { file: found.path, name: found.name, bytes: found.bytes },
    backup: safety, // 回滚前那份「当前文件」的备份 ⇒ 本次回滚可再回滚
    readBack: { match: true },
    errors: [],
  }
}
