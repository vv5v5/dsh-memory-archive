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
 *
 * @license CC-BY-NC-4.0 (Attribution-NonCommercial 4.0 International)
 * 移植来源：anima-rag (https://github.com/Ellinav/anima-rag) — 作者 Ellinav
 * 仅限个人学习与非商业用途；禁止闭源商用或转为付费插件/服务；不重新分发预置私域数据。
 * 含 DeepSeek Harness 派生部分（MIT, Copyright (c) 2026 DeepSeek）时该部分保留 MIT。
 */

import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
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
// ★ inject 声明（真机教训 20260913）：没有它，cordis 代理在 fiber 链上找不到 tools 服务时
//   连 ctx.tools 的「属性读取」本身都会抛（vendor/cordis/src/reflect.ts:144），收窄整个静默
//   失效。照真机跑通的 rp-tool-scope.js 逐字声明；ctx.events 的后备访问有 try 守卫，
//   不进名单（访问失败 = 只少一个重算订阅，绝不抛穿）。
export const inject = ['tools']
const RESERVED_TRANSPORT = ['run_code'] // 受保护传输层：restrict() 不接受点名它，⛔ 绝不进 deny
let applying = false // 重入保护：restrict() 自身会 emit tools/change，无标志位会递归
let lastKey = null // 上次生效的 deny 指纹：没变化就不重放（也兜住异步重发的事件，免得来回重算）
let liftLast = null // 上一次 restrict() 返回的 disposer：重算前先撤它（限制按层叠加且相交，不撤会越堆越多）
// 降级日志：⛔ 这条路自己必须绝不抛 —— ctx 上可能没有 log/logger 服务，或 cordis 的 inject
// 代理拒绝这次属性访问本身（沙箱实测：cannot get property "log" without inject，旧写法在
// 错误处理分支里裸读 ctx.log ⇒ 降级路径反成致命路径 = preset 挂不上）。读属性这一步也要包
// 进 try；日志发不出去就安静放弃（fail-closed 的旧遮罩原样不动，收窄语义不受影响）。
function safeWarn(ctx, text) {
  try {
    const log = ctx && (ctx.logger || ctx.log)
    if (log && typeof log.warn === 'function') log.warn('[rp-tool-scope] ' + text)
  } catch {}
}
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
      safeWarn(ctx, '收窄失败，旧遮罩保持原样（fail-closed）：' + String((e && e.message) || e))
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
    safeWarn(ctx, '枚举全局工具失败，降级为不收窄：' + String((e && e.message) || e))
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
 * 「deny 构造已排除 run_code」的两段合判（修复单 v3 ①）：
 *   ① 脚本里存在「值为 run_code 的字面量或常量」（直接字面量，或 const X = … run_code …）；
 *   ② deny 的构造表达式里引用了它（!== X / !includes(X) / 直接写 'run_code' 都算）。
 * ★ 为什么这么做：不能用「只认自己写法」的规则去判别人的代码 —— 真机手写 rp-tool-scope.js
 *   用的是 `const RESERVED_TRANSPORT = 'run_code'`（字符串）+ `t !== RESERVED_TRANSPORT`，
 *   旧判定只找数组字面量 `['run_code']` ⇒ 假阳性（纪律：沙箱与隔离-开发原则.md §6
 *   「现象与机制冲突时，先怀疑自己的台子」——本项目已 12 次工具假阳性，这次场合最坏：
 *   在真机上、对着别人的文件）。两段合判对【数组形态】【字符串常量形态】【直接字面量】
 *   三种写法都成立，而对「真没排除」（deny 构造里既无 run_code 也无相关常量）仍失败。
 */
function runCodeExcluded(t) {
  const denyZone = /deny\s*=[\s\S]{0,240}/.exec(t)
  const denyExpr = denyZone ? denyZone[0] : ''
  if (!denyExpr) return false
  if (/run_code/.test(denyExpr)) return true // 形态 A：deny 构造里直接出现 run_code 字面量
  const constDecl = /(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*run_code/.exec(t)
  return !!(constDecl && denyExpr.includes(constDecl[2])) // 形态 B：常量含 run_code 且 deny 引用它
}

/**
 * 工具面脚本契约自检（修复单 v2 §二；修复单 v3 ① 加来源分级）：
 * 生成路径写盘前必过；修复路径只读校验并如实报告。
 * 条目口径出处：
 *   - EXPORT_SHAPE：vendor/cordis/src/registry.ts:222-228 的 resolve() 只认「函数」或
 *     「带 .apply 函数的对象」（isApplicable 见 :8-10）——activate/deactivate 之类挂不上；
 *   - 枚举：packages/core/tools/src/index.ts 的 ToolRuntime 没有 list()（只有
 *     register/restrict/guard/get/schemas:1225）——tools.list() 会静默落 []；
 *   - 白名单退役：新契约 deny = 全部全局 − run_code（沙箱与隔离-开发原则.md §8）；
 *   - run_code：受保护传输层，restrict() 不接受点名它（会抛）⇒ 绝不进 deny。
 * ★ 来源分级（修复 v3 ①(b)）：`opts.generated === true` = 我们生成的（错误级，生成器归我们
 *   管且行为级断言在手）；否则 = 别人的文件（修复路径读到的 rp-tool-scope.js）——
 *   **RUN_CODE_NOT_EXCLUDED 这类「写法敏感」的条目降为警告级、措辞不判死**（只提示、不判死）。
 *   行为级事实条目（tools.list() 不存在、没订阅重算、导出形状 cordis 不认）对谁都成立，保持原强度。
 */
export function checkToolScopeContract(scriptText, opts = {}) {
  const generated = opts.generated === true
  const t = String(scriptText == null ? '' : scriptText)
  const violations = []
  const add = (code, detail, severity) => violations.push({ code, detail, severity })
  if (!(
    /export\s+function\s+apply\s*\(/.test(t) ||
    /export\s*\{[^}]*\bapply\b[^}]*\}/.test(t) ||
    /export\s+default[\s\S]{0,200}\bapply\b/.test(t)
  )) {
    add('EXPORT_SHAPE', '导出形状 cordis 解析不了：需要 export function apply(ctx, config)（或带 .apply 的导出对象）——registry.ts:222-228 只认这两种', 'error')
  }
  if (t.includes('tools.list(')) {
    add('USES_TOOLS_LIST', 'ToolRuntime 没有 list()（只有 schemas()）——tools.list() 会静默落空，一个工具都挡不掉', 'error')
  }
  if (!t.includes('tools.schemas(')) {
    add('NO_SCHEMAS_ENUM', '没有用 tools.schemas() 枚举全局工具（不带 scope 的全局视图正是 restrict 能点名的名字集合）', 'error')
  }
  if (!t.includes('tools/change')) {
    add('NO_CHANGE_SUBSCRIPTION', '没有订阅 tools/change —— mcp 那类晚注册的工具会被静默漏掉', 'error')
  }
  if (!/\bapplying\b/.test(t)) {
    add('NO_REENTRY_GUARD', '没有重入保护（restrict() 自身会 emit tools/change，无标志位会递归）', 'error')
  }
  if (/\bALLOW\b/.test(t) || t.includes('config.allow')) {
    add('HAS_ALLOWLIST', '还留着白名单（ALLOW / config.allow）——新契约 deny = 全部全局 − run_code，白名单已退役', 'error')
  }
  if (!runCodeExcluded(t)) {
    add(
      'RUN_CODE_NOT_EXCLUDED',
      generated
        ? 'deny 构造没有排除 run_code（restrict() 不接受点名它，会抛）'
        : '疑似未排除 run_code —— 该脚本不是本插件生成的，写法可能不同，请人工确认',
      generated ? 'error' : 'warn',
    )
  }
  if (!(/try\s*\{/.test(t) && /\bcatch\b/.test(t))) {
    add('NO_TRY_CATCH', '整段没有 try/catch —— 脚本一行抛异常 = preset 挂不上 = 用户开不了周目', 'error')
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

/** DSH 根目录推导（DSH_HOME 优先，退 ~/.dsh；⛔ 不写死绝对路径）。 */
function resolveDshHome(env = process.env) {
  const configured = env.DSH_HOME
  const dshHome =
    configured !== undefined && String(configured).trim() !== ''
      ? String(configured)
      : join(homedir(), '.dsh')
  return resolve(expandHome(dshHome))
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
  return join(resolveDshHome(env), '.agent-presets')
}

/**
 * 卡目录（P1b-1 ① 数据面）：由 DSH 根推 pmp-dsh-tavern 的存储根
 * <dshRoot>/pmp-dsh-tavern/characters/（契约《选卡-读卡与pack输出契约.md》§1 第 1 行），
 * ⛔ 不写死绝对路径；本模块对卡**只读**，绝不写。
 */
export function resolveCharactersRoot(env = process.env) {
  return join(resolveDshHome(env), 'pmp-dsh-tavern', 'characters')
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
    : Object.assign({ present: true }, checkToolScopeContract(scopeText, { generated: false })) // 别人的文件：写法敏感条目只提示不判死
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
  // ★ 我们自己的生成器走【错误级】（generated:true）：生成器归我们管，且行为级断言在手。
  const contract = checkToolScopeContract(RP_TOOL_SCOPE_JS, { generated: true })
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

// ---------------------------------------------------------------------------
// 选卡数据面（P1b-1 ①）：把卡【原样】交给 AI —— 只读、零解析、零写入。
// 契约：《选卡-读卡与pack输出契约.md》§0/§1（修订见《选卡-设计修订与组装骨架-20260913.md》）。
// ★ 插件不解析卡字段：卡的键是 camelCase（systemPrompt/firstMessage/postHistoryInstructions）；
//   「主提示词」在卡里有两份且大面积不同（data.systemPrompt vs data.extensions.system_prompt），
//   插件不许写死读哪份；描述字段可能是空壳。⇒ 本模块只给「原始全字段 + 导航提示」，
//   导航提示（*Chars 等）⛔ 不许用于任何筛选/裁剪/合并/补默认值。
// ---------------------------------------------------------------------------

/** 卡 id 的目录穿越防御：照 resolveBackupFile 同款纵深口径 —— 拒空串 / / \ .. : 、basename 比对、必须真在该目录下。 */
function resolveCardFile(cardId, charactersRoot) {
  if (typeof cardId !== 'string' || cardId.trim() === '') {
    return fail('BAD_CARD_ID', '缺 id：必须是 characters/ 目录下的纯文件名（如 <uuid>.json）')
  }
  if (cardId.includes('/') || cardId.includes('\\') || cardId.includes('..') || cardId.includes(':')) {
    return fail('BAD_CARD_ID', 'id 只允许纯文件名（不许含 / \\ .. : 等路径成分，防目录穿越）：' + JSON.stringify(cardId))
  }
  if (basename(cardId) !== cardId) {
    return fail('BAD_CARD_ID', 'id 必须是纯文件名（basename 比对不过）：' + JSON.stringify(cardId))
  }
  const path = join(charactersRoot, cardId)
  if (dirname(path) !== charactersRoot) {
    return fail('BAD_CARD_ID', '解析出的路径不在卡目录里：' + JSON.stringify(cardId))
  }
  let st = null
  try {
    st = statSync(path)
  } catch {}
  if (!st || !st.isFile()) {
    return fail('CARD_NOT_FOUND', '卡目录里没有这个文件（或不是常规文件）：' + cardId)
  }
  return { ok: true, path, name: cardId, bytes: st.size }
}

/** 列卡导航提示：只量「存在性/长度」（坏卡如实给空提示，id/bytes 仍真实，绝不拖垮列表），绝不取内容、绝不做取舍。 */
function cardNavHint(file) {
  const out = {
    name: null,
    creatorNotes: null,
    hasSystemPrompt: false,
    systemPromptChars: 0,
    extensionsSystemPromptChars: 0,
    firstMessageChars: 0,
    hasCharacterBook: false,
  }
  let raw = null
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return out
  }
  const d = raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object' ? raw.data : {}
  const ext =
    d.extensions && typeof d.extensions === 'object' ? d.extensions
      : raw && raw.extensions && typeof raw.extensions === 'object' ? raw.extensions
        : null
  const len = (v) => (typeof v === 'string' ? v.length : 0)
  const firstStr = (...vals) => {
    for (const v of vals) if (typeof v === 'string' && v !== '') return v
    return null
  }
  out.name = firstStr(raw && raw.name, d.name)
  out.creatorNotes = firstStr(d.creator_notes, d.creatorNotes, raw && raw.creator_notes, raw && raw.creatorNotes)
  out.hasSystemPrompt = len(d.systemPrompt) > 0
  out.systemPromptChars = len(d.systemPrompt)
  out.extensionsSystemPromptChars = len(ext && ext.system_prompt)
  out.firstMessageChars = len(d.firstMessage ?? d.first_mes)
  out.hasCharacterBook = !!(d.characterBook || (raw && raw.characterBook))
  return out
}

/** GET /agent/cards 的数据面：目录扫 + 导航提示（零写入；目录不存在 ⇒ ok:true 空列表 + 可读说明）。 */
export function listCards({ charactersRoot } = {}) {
  const root = charactersRoot ? resolve(charactersRoot) : resolveCharactersRoot()
  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { ok: true, dir: root, cards: [], note: '卡目录还不存在（pmp-dsh-tavern 尚未存过卡）：' + root }
    }
    return fail('LIST_CARDS_FAILED', '读卡目录失败：' + String((e && e.message) || e))
  }
  const cards = []
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.json')) continue
    const full = join(root, ent.name)
    let bytes = 0
    try {
      bytes = statSync(full).size
    } catch {}
    cards.push(Object.assign({ id: ent.name, bytes }, cardNavHint(full)))
  }
  return {
    ok: true,
    dir: root,
    cards,
    note: '导航提示只用于浏览；插件不解析、不筛选、不补默认值（契约 §1）。',
  }
}

/** GET /agent/card?id= 的数据面：原样全字段 + sha256（pack META.cardHash = 前 16 位，契约 §2）。零写入。 */
export function readCard({ charactersRoot, cardId } = {}) {
  const root = charactersRoot ? resolve(charactersRoot) : resolveCharactersRoot()
  const found = resolveCardFile(cardId, root)
  if (!found.ok) return found
  let bytes = null
  try {
    bytes = readFileSync(found.path)
  } catch (e) {
    return fail('CARD_READ_FAILED', '卡文件读不出来：' + found.name + ' —— ' + String((e && e.message) || e))
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  let raw = null
  try {
    raw = JSON.parse(bytes.toString('utf8'))
  } catch (e) {
    return fail('CARD_PARSE_FAILED', '卡不是合法 JSON：' + found.name + ' —— ' + String((e && e.message) || e))
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('CARD_PARSE_FAILED', '卡 JSON 顶层不是对象：' + found.name)
  }
  return {
    ok: true,
    id: found.name,
    path: found.path,
    bytes: found.bytes,
    sha256,
    cardHash: sha256.slice(0, 16),
    data: raw.data === undefined ? null : raw.data,
    extensions: raw.extensions === undefined ? null : raw.extensions,
    compatibility: raw.compatibility === undefined ? null : raw.compatibility,
    raw, // 顶层原样：spec/name 等其余顶层键也不丢（原样全字段，一个不省）
  }
}

// ---------------------------------------------------------------------------
// RP-AGENT-QUESTIONS v1 / RP-AGENT-PACK v1 双契约校验器（P1b-1 ②，本单核心）。
// 依据：《选卡-设计修订与组装骨架-20260913.md》§1/§2 +《选卡-读卡与pack输出契约.md》§2/§2.1。
// ★ 设计核心：skill 是「翻译」不是「决策者」——QUESTIONS 给玩家（白话、点选、不答也有默认），
//   PACK 给插件（校验 + 路由）。★ 正/反向对照缺一不可：『校验器返回 ok』本身不是证据 ——
//   不配反向对照，分不清它是「检查过了」还是「压根没检查」。
// ---------------------------------------------------------------------------

export const QUESTIONS_MAGIC = 'RP-AGENT-QUESTIONS v1'
export const PACK_MAGIC = 'RP-AGENT-PACK v1'
/** 术语禁令（骨架 §1.2 逐字）：对玩家说话时不许出现；违反 ⇒ TECH_JARGON（错误级）。 */
export const QUESTIONS_BANNED_TERMS = [
  'order', 'section', 'prompt', 'system', 'token', '压缩', '注入', '枚举',
  'schema', 'preset', 'JSON', '字段', '路径', '配置项', 'durable', 'hash', 'scope', 'realm',
]
const QUESTIONS_SECTION_RE = /^##\s*(说明|要你定的第\s*(\d+)\s*件事)\s*$/
const PACK_SECTION_RE = /^##\s*(META|SETTINGS|TONE|OPENING|POST|CONFLICTS)\s*$/

/** 术语禁令判定：拉丁词按词边界（不误伤中文），中文词按子串；每个命中的词各报一条。 */
function findJargon(text) {
  const hits = []
  for (const term of QUESTIONS_BANNED_TERMS) {
    if (/^[a-z]+$/i.test(term)) {
      if (new RegExp('\\b' + term + '\\b', 'i').test(text)) hits.push(term)
    } else if (text.includes(term)) {
      hits.push(term)
    }
  }
  return hits
}

/** 通用分段：只按标题行切（标题是结构，允许两侧空白）；段内文本逐字保留（⛔ 不 trim 段内换行/缩进）。 */
function splitByHeadings(lines, sectionRe) {
  const sections = [] // { title, key, lines }
  let current = null
  for (const line of lines) {
    const m = sectionRe.exec(line.trim())
    if (m) {
      current = { title: m[1], key: m[2] === undefined ? m[1] : m[2], lines: [] }
      sections.push(current)
    } else if (current) {
      current.lines.push(line)
    }
  }
  return sections
}

/** parseQuestions：白话选择题的结构化读取。intro/题面逐字保留（只去结构前缀）；缺段 ⇒ null；不猜不补。 */
export function parseQuestions(text) {
  const raw = String(text == null ? '' : text)
  const lines = raw.split(/\r?\n/)
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const magicOk = (lines[0] || '').trim() === QUESTIONS_MAGIC
  const sections = splitByHeadings(lines.slice(1), QUESTIONS_SECTION_RE)
  const introSection = sections.find((s) => s.title === '说明') || null
  const intro = introSection ? introSection.lines.join(eol) : null
  const questions = []
  for (const s of sections) {
    if (s.title === '说明') continue
    const q = { n: Number(s.key), ask: null, options: [], advice: null, why: null, fallback: null }
    for (const line of s.lines) {
      const askM = /^问\s*[:：]\s?(.*)$/.exec(line.trim())
      if (askM && q.ask === null) {
        q.ask = askM[1]
        continue
      }
      const opt = /^\s*·\s?(.*)$/.exec(line)
      if (opt) {
        const body = opt[1]
        const c = body.indexOf('：') >= 0 ? body.indexOf('：') : body.indexOf(':')
        if (c >= 0) q.options.push({ label: body.slice(0, c).trim(), effect: body.slice(c + 1).trim() })
        else q.options.push({ label: body.trim(), effect: '' })
        continue
      }
      const advM = /^我的建议\s*[:：]\s*(.*)$/.exec(line.trim())
      if (advM) {
        const rest = advM[1]
        const because = /^(.*?)(?:。|\.)?\s*因为\s*(.*)$/.exec(rest)
        if (because) {
          q.advice = because[1].trim()
          q.why = because[2].replace(/。\s*$/, '').trim()
        } else {
          q.advice = rest.trim()
        }
        continue
      }
      const fbM = /^不选也行\s*[:：]\s*(.*)$/.exec(line.trim())
      if (fbM) q.fallback = fbM[1]
    }
    questions.push(q)
  }
  return { ok: magicOk, magic: lines[0] === undefined ? '' : lines[0], intro, questions }
}

/** checkQuestionsContract：六条校验（骨架 §2.1 具名 code；TECH_JARGON = 术语禁令，错误级）。 */
export function checkQuestionsContract(text) {
  const violations = []
  const add = (code, detail, severity) => violations.push({ code, detail, severity })
  const raw = String(text == null ? '' : text)
  const p = parseQuestions(raw)
  if (!p.ok) add('BAD_MAGIC', '第一行必须是 ' + QUESTIONS_MAGIC + '（版本不明，拒）', 'error')
  if (p.questions.length === 0) add('NO_QUESTIONS', '一份「要你定的第 N 件事」都没有（至少 1 题）', 'error')
  for (const q of p.questions) {
    const missing = []
    if (q.ask === null) missing.push('问：')
    if (q.options.length < 2) missing.push('≥2 个 · 选项')
    if (q.advice === null) missing.push('我的建议：')
    if (q.fallback === null) missing.push('不选也行：')
    if (missing.length > 0) {
      add('QUESTION_INCOMPLETE', '第 ' + q.n + ' 题四要素缺：' + missing.join('、'), 'error')
    }
    if (q.fallback === null) {
      add('NO_FALLBACK', '第 ' + q.n + ' 题没有「不选也行：」——必须保证不答也能跑（按默认来）', 'error')
    }
    if (q.options.length === 1) {
      add('TOO_FEW_OPTIONS', '第 ' + q.n + ' 题只有 1 个选项（至少给两条路，否则谈不上选择）', 'warn')
    }
  }
  // 术语禁令：只扫正文（第一行魔数除外）。玩家只会用微信聊天 —— 技术词必须翻译成白话。
  const body = raw.includes('\n') ? raw.slice(raw.indexOf('\n') + 1) : ''
  for (const term of findJargon(body)) {
    add('TECH_JARGON', '正文出现技术词「' + term + '」——对玩家说话必须用白话（见 skill 翻译对照表）', 'error')
  }
  const ok = !violations.some((v) => v.severity === 'error')
  return { ok, violations }
}

/** parsePack：只按标题切段，段内文本逐字保留（给模型看的文本，⛔ 不 trim 段内换行/缩进）；缺段 ⇒ null。 */
export function parsePack(text) {
  const raw = String(text == null ? '' : text)
  const lines = raw.split(/\r?\n/)
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const magicOk = (lines[0] || '').trim() === PACK_MAGIC
  const sections = splitByHeadings(lines.slice(1), PACK_SECTION_RE)
  const present = sections.map((s) => s.title)
  const bodyOf = (title) => {
    const s = sections.find((x) => x.title === title)
    return s ? s.lines.join(eol) : null
  }
  // META：key: value 按首次出现取值；未知键原样保留（⛔ 不许丢）；不成对的行原样收进 metaOtherLines。
  const meta = {}
  const metaOtherLines = []
  const metaSection = sections.find((s) => s.title === 'META')
  if (metaSection) {
    for (const line of metaSection.lines) {
      const m = /^([^:]+)\s*:\s?(.*)$/.exec(line)
      if (m && m[1].trim() !== '') {
        const k = m[1].trim()
        if (!(k in meta)) meta[k] = m[2]
      } else if (line.trim() !== '') {
        metaOtherLines.push(line)
      }
    }
  }
  return {
    ok: magicOk,
    magic: lines[0] === undefined ? '' : lines[0],
    present,
    meta,
    metaOtherLines,
    settings: bodyOf('SETTINGS'),
    tone: bodyOf('TONE'),
    opening: bodyOf('OPENING'),
    post: bodyOf('POST'),
    conflicts: bodyOf('CONFLICTS'),
  }
}

/** checkPackContract：九条（契约 §2.1）+ thinkMode / identity 两条（骨架 §3.4 与 §0 决定 1）。 */
export function checkPackContract(packText, opts = {}) {
  const violations = []
  const add = (code, detail, severity) => violations.push({ code, detail, severity })
  const maxSettingsChars =
    typeof opts.maxSettingsChars === 'number' && opts.maxSettingsChars > 0 ? opts.maxSettingsChars : 8000
  const expectCardHash =
    typeof opts.expectCardHash === 'string' && opts.expectCardHash.trim() !== '' ? opts.expectCardHash.trim() : null
  const p = parsePack(packText)
  if (!p.ok) add('BAD_MAGIC', '第一行必须是 ' + PACK_MAGIC + '（版本不明，拒）', 'error')
  for (const t of ['META', 'SETTINGS', 'TONE', 'OPENING', 'CONFLICTS']) {
    if (!p.present.includes(t)) add('MISSING_SECTION', '缺必备标题 ## ' + t + '（POST 可选，其余必备）', 'error')
  }
  if (p.present.includes('META')) {
    const missingMeta = ['name', 'readFields', 'missing', 'decisions', 'cardHash'].filter(
      (k) => typeof p.meta[k] !== 'string' || p.meta[k].trim() === '',
    )
    if (missingMeta.length > 0) {
      add('META_INCOMPLETE', 'META 缺：' + missingMeta.join('/') + '（五项都要有）', 'error')
    }
  }
  if (typeof p.settings === 'string' && p.settings.trim() === '') {
    add('EMPTY_SETTINGS', 'SETTINGS 段是空的（不许写出一份空 agent）', 'error')
  }
  if (typeof p.tone === 'string' && p.tone.trim() === '') {
    add('BAD_TONE', 'TONE 既不是 KEEP 也没有正文', 'error')
  }
  if (expectCardHash !== null) {
    const got = typeof p.meta.cardHash === 'string' ? p.meta.cardHash.trim() : null
    if (got !== null && got !== expectCardHash) {
      add('CARD_HASH_MISMATCH', 'cardHash ' + got + ' ≠ 当前卡 ' + expectCardHash + '（像在拿旧 pack 套新卡——静默错配最坏，拦）', 'error')
    }
  }
  // 警告级三条（不阻断，但必须能在界面显示）
  if (typeof p.settings === 'string') {
    const marks = [
      [/(^|\n)\s*OOC\s*[:：]/, 'OOC: 前缀路由定义（那是固定段 B 对接层的职责）'],
      [/(^|\n)\s*导演\s*[:：]/, '导演: 前缀路由定义（那是固定段 B 对接层的职责）'],
      [/<recalledMemories>/, '<recalledMemories> 的解读（那是固定段 B 对接层的职责）'],
      [/<storyAnchor>/, '<storyAnchor> 的解读（那是固定段 B 对接层的职责）'],
      [/【当前状态】/, '【当前状态】的解读规则（那是固定段 B 对接层的职责）'],
    ]
    for (const [re, detail] of marks) {
      if (re.test(p.settings)) add('DUPLICATES_CONTRACT', 'SETTINGS 里出现' + detail + '，重复会造成两处说法冲突', 'warn')
    }
    const len = p.settings.trim().length
    if (len > maxSettingsChars) {
      add('SETTINGS_TOO_LONG', 'SETTINGS ' + len + ' 字 > 上限 ' + maxSettingsChars + '（太长会挤占上下文，建议精简）', 'warn')
    }
  }
  if (typeof p.conflicts === 'string' && p.conflicts.trim() !== '' && p.conflicts.trim() !== 'NONE') {
    add('HAS_CONFLICTS', 'CONFLICTS 非 NONE —— 先跟用户商量，用户答完之前不许写盘', 'warn')
  }
  // 本单新增两条（骨架 §3.4 与 §0 决定 1）
  const thinkMode = typeof p.meta.thinkMode === 'string' ? p.meta.thinkMode.trim() : null
  if (thinkMode !== null && !['analysis', 'immersion', 'off'].includes(thinkMode)) {
    add('BAD_THINK_MODE', 'thinkMode 只许 analysis / immersion / off（封闭枚举；缺省 = analysis），收到：' + JSON.stringify(p.meta.thinkMode), 'error')
  }
  const identity = typeof p.meta.identity === 'string' ? p.meta.identity.trim() : null
  if (identity === null) {
    add('BAD_IDENTITY', 'META.identity 缺失 —— rp 身份（它以为自己是干什么的）必须有，落最前（deployment:persona 槽）', 'error')
  } else if (identity === '') {
    add('BAD_IDENTITY', 'META.identity 是空的', 'error')
  } else if (identity.length > 400) {
    add('BAD_IDENTITY', 'META.identity ' + identity.length + ' 字 > 400（身份要短、要在最前）', 'error')
  }
  const ok = !violations.some((v) => v.severity === 'error')
  return { ok, violations }
}

// ---------------------------------------------------------------------------
// P1b-2a ①：我们自己的 preset 级注入模块 + pack 落地（dma:settings order 60 / dma:rules order 9950）。
// 依据：《选卡-设计修订与组装骨架-20260913.md》§2 order 表；范本 = 同目录跑通的 story-anchor.js
//（export function apply(ctx, config)，ctx.systemPrompt.section({name,order,text}) —— 官方签名
//  packages/core/system-prompt/src/index.ts:432-441，order 必须有限数）。persona 槽不在本模块
//（走 agent.cordis.yml 的 persona 行，见 applyPackToPreset）。⛔ 纯注入：不读会话、不写历史。
// ---------------------------------------------------------------------------

export const INJECT_FILE_NAME = 'dma-rp-inject.js'
export const PACK_FILE_NAME = 'dma-rp-pack.md'
const MOUNT_ID = 'dma-rp-inject'
const THINK_MODES = ['analysis', 'immersion', 'off']

/** 生成 <preset>/dma-rp-inject.js（自包含：不 import 本插件的 lib；config.settingsText/rulesText 优先，否则读同目录 pack 文件）。 */
function buildInjectModule() {
  return `// 由 dsh-memory-archive 生成（v5 P1b-2a）：本 preset 专属的注入模块（纯注入：不读会话、不写历史、不做收纳）。
// 导出形状照同目录跑通的 story-anchor.js / rp-tool-scope.js：export function apply(ctx, config)
//（cordis registry.resolve() 只认「函数」或「带 .apply 函数的对象」，registry.ts:222-228；
//  Cordis 只读 name / inject / apply —— inject 声明依赖，服务没就绪时 cordis 会等，
//  而不是让我们在 apply 里静默跳过 ⇒ 静默失效是最难发现的那类问题）。
// 职责：把 pack 的「规则书」（dma:settings，默认 order 60）与「核心规则+情感线」（dma:rules，
// 默认 order 9950 = system 块最末尾）注册进 systemPrompt waterfall。身份段（persona 槽，order 0）
// 不在这里 —— 它走 agent.cordis.yml 的 persona 行。段名带 dma: 前缀，避免与别的插件撞车。
// ★ section() 必须包在 ctx.effect(...) 里：DSH 在 preset 文件变化时会按 stamp 重新挂载，
//   不绑生命周期 = 不释放 = 段重复累积（规则书被注入两遍、三遍…）—— 与工具面「层堆积」
//   是同一类错：忘了用官方 disposer 契约。
// 绝不抛：拿不到 config / 文本为空 ⇒ 跳过该段并大声写日志 —— 这一行抛 = preset 挂不上 = 开不了周目。
export const name = 'dma-rp-inject'
export const inject = ['systemPrompt']
import { readFileSync } from 'node:fs'
const DEFAULTS = { packFile: './dma-rp-pack.md', settingsOrder: 60, rulesOrder: 9950, settingsEnabled: true, rulesEnabled: true }
function say(ctx, msg) {
  try {
    if (ctx && ctx.log && typeof ctx.log.warn === 'function') ctx.log.warn('[dma-rp-inject] ' + msg)
  } catch {}
}
function textOf(v) {
  if (typeof v !== 'string') return null
  const t = v.replace(/^\\n+/, '').replace(/\\s+$/, '')
  return t === '' || t === 'NONE' ? null : t
}
function sectionOfPack(pack, title) {
  const lines = String(pack || '').split(/\\r?\\n/)
  let i = lines.findIndex((l) => l.trim() === '## ' + title)
  if (i < 0) return null
  const body = []
  for (i = i + 1; i < lines.length; i++) {
    if (/^##\\s+\\S/.test(lines[i])) break
    body.push(lines[i])
  }
  return textOf(body.join('\\n'))
}
function register(ctx, name, order, text) {
  if (!text) return
  try {
    if (!ctx || !ctx.systemPrompt || typeof ctx.systemPrompt.section !== 'function') {
      say(ctx, '拿不到 systemPrompt.section，跳过 ' + name)
      return
    }
    // ★ 官方 disposer 契约：section() 的返回值是撤段的 disposer，必须经 ctx.effect 交给
    //   生命周期管理（preset 重挂载时释放，段才不会重复累积）。text 保持静态字符串
    //   （我们是静态规则书，不是每轮变的锚点）。
    const install = () => ctx.systemPrompt.section({ name, order, text })
    if (ctx && typeof ctx.effect === 'function') {
      ctx.effect(install, 'dma-rp-inject.' + name + '()')
    } else {
      say(ctx, 'ctx.effect 不可用，直接注册 ' + name + '（未绑生命周期，重挂载可能重复累积）')
      install()
    }
  } catch (e) {
    say(ctx, '注册 ' + name + ' 失败，跳过该段：' + String((e && e.message) || e))
  }
}
export function apply(ctx, config) {
  try {
    const c = Object.assign({}, DEFAULTS, config && typeof config === 'object' ? config : {})
    let settings = textOf(c.settingsText)
    let rules = textOf(c.rulesText)
    if (settings === null || rules === null) {
      try {
        const pack = readFileSync(new URL(c.packFile, import.meta.url), 'utf8')
        if (settings === null) settings = sectionOfPack(pack, 'SETTINGS')
        if (rules === null) rules = sectionOfPack(pack, 'POST')
      } catch (e) {
        say(ctx, '读 pack 文件失败（' + c.packFile + '）：' + String((e && e.message) || e))
      }
    }
    if (c.settingsEnabled !== false) register(ctx, 'dma:settings', Number(c.settingsOrder) || DEFAULTS.settingsOrder, settings)
    if (c.rulesEnabled !== false) register(ctx, 'dma:rules', Number(c.rulesOrder) || DEFAULTS.rulesOrder, rules)
  } catch (e) {
    say(ctx, '初始化失败（不影响 preset 加载）：' + String((e && e.message) || e))
  }
}
`
}

/** 六个开关的默认值（骨架 §3：settings 60 / rules 9950 压轴；thinkMode 缺省 analysis）。 */
function packSwitchDefaults(sw) {
  const s = sw && typeof sw === 'object' ? sw : {}
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
  return {
    packFile: './' + PACK_FILE_NAME,
    settingsOrder: num(s.settingsOrder, 60),
    rulesOrder: num(s.rulesOrder, 9950),
    settingsEnabled: s.settingsEnabled === false ? false : true,
    rulesEnabled: s.rulesEnabled === false ? false : true,
    thinkMode: THINK_MODES.includes(s.thinkMode) ? s.thinkMode : 'analysis',
  }
}

/** 挂载块（追加到 agent.cordis.yml 的段列表末尾；indent 与最后一个列表项对齐）。 */
function buildMountBlock(sw, indent) {
  const pad = ' '.repeat(indent)
  return [
    pad + '- id: ' + MOUNT_ID,
    pad + "  name: './" + INJECT_FILE_NAME + "'",
    pad + '  config:',
    pad + '    packFile: ' + JSON.stringify(sw.packFile),
    pad + '    settingsOrder: ' + sw.settingsOrder,
    pad + '    rulesOrder: ' + sw.rulesOrder,
    pad + '    settingsEnabled: ' + sw.settingsEnabled,
    pad + '    rulesEnabled: ' + sw.rulesEnabled,
    pad + '    thinkMode: ' + sw.thinkMode,
  ]
}

/** 定位「最外层段列表」的末尾：取所有列表项里【缩进最小】的那一层（嵌套的 config 子列表不算），追加到该层最后一个项之后；若其后还有顶层键行则保守拒绝（不猜）。 */
function locateAppendPoint(text) {
  const lines = text.split('\n')
  let minIndent = Infinity
  for (const line of lines) {
    if (/^\s*(#|$)/.test(line)) continue
    const m = /^(\s*)-\s/.exec(line)
    if (m && m[1].length < minIndent) minIndent = m[1].length
  }
  if (!Number.isFinite(minIndent)) {
    return { ok: false, code: 'NO_LIST_TO_APPEND', message: 'agent.cordis.yml 里找不到任何列表项 —— 保守拒绝，不猜插入点' }
  }
  const itemRe = new RegExp('^ {' + minIndent + '}-\\s')
  let lastItem = -1
  for (let i = 0; i < lines.length; i++) {
    if (itemRe.test(lines[i])) lastItem = i
  }
  for (let i = lastItem + 1; i < lines.length; i++) {
    if (/^\s*(#|$)/.test(lines[i])) continue
    if (/^[^ \t#-]/.test(lines[i])) {
      return { ok: false, code: 'UNABLE_TO_LOCATE_APPEND_POINT', message: '最外层列表之后还有顶层键（' + lines[i].trim() + '）—— 追加会落到数组外，保守拒绝' }
    }
  }
  return { ok: true, indent: minIndent }
}

/** 在段列表末尾追加挂载块；已挂载（id: dma-rp-inject 存在）⇒ 幂等：只按开关改写那六行值。 */
function upsertMount(text, sw) {
  if (text.includes('id: ' + MOUNT_ID)) {
    // 已挂载：块内改写六个键的值（只动我们自己的那几行，别的一个字节不碰）
    const lines = text.split('\n')
    const start = lines.findIndex((l) => l.trim() === '- id: ' + MOUNT_ID)
    let end = lines.length
    const indent = lines[start].match(/^\s*/)[0].length
    for (let i = start + 1; i < lines.length; i++) {
      const li = lines[i]
      if (li.trim() === '') continue
      const ind = li.match(/^\s*/)[0].length
      if (ind <= indent) {
        end = i
        break
      }
    }
    for (let i = start + 1; i < end; i++) {
      for (const k of ['packFile', 'settingsOrder', 'rulesOrder', 'settingsEnabled', 'rulesEnabled', 'thinkMode']) {
        const re = new RegExp('^([ \\t]*' + k + '\\s*:\\s*).*$')
        if (re.test(lines[i])) lines[i] = lines[i].replace(re, '$1' + String(sw[k]))
      }
    }
    return { ok: true, newText: lines.join('\n'), mount: 'updated' }
  }
  const point = locateAppendPoint(text)
  if (!point.ok) return point
  const block = buildMountBlock(sw, point.indent)
  const eol = text.endsWith('\n') ? '' : '\n'
  return { ok: true, newText: text + eol + block.join('\n') + '\n', mount: 'created' }
}

/**
 * 改写 persona 段的 config.text（v5 P1b-2a §二）：定位 `- id: persona` 列表项，改写其块标量 body。
 * ⛔ 绝不设 complete:true；pack 没有 IDENTITY ⇒ 不写（保留原文本，如实报告）。
 * 手术方式与 buildReplacement 同款：只动 text: | 那一块的正文行，其余行（含注释）原样保留。
 */
function rewritePersonaText(text, newText) {
  const lines = text.split('\n')
  // persona 项的定位兼容两种写法：`- id: persona`（单行）与 `- cordis:group` + 换行 `id: persona`（仓库自检样例的同款两行式）
  let start = -1
  let itemIndent = -1
  const singleLine = lines.findIndex((l) => /^\s*-\s+id:\s*persona\s*$/.test(l))
  if (singleLine >= 0) {
    start = singleLine
    itemIndent = lines[start].match(/^\s*/)[0].length
  } else {
    const idLine = lines.findIndex((l) => /^\s*id:\s*persona\s*$/.test(l))
    if (idLine < 0) {
      return { ok: false, code: 'PERSONA_SECTION_MISSING', message: '找不到 id: persona 的列表项 —— 保留原文本，不猜' }
    }
    const idIndent = lines[idLine].match(/^\s*/)[0].length
    // 向上找最近的、缩进比 id 行更浅的列表项头（- 行）—— 那就是 persona 所属项的第一行
    for (let i = idLine; i >= 0; i--) {
      const m = /^(\s*)-\s/.exec(lines[i])
      if (m && m[1].length < idIndent) {
        start = i
        itemIndent = m[1].length
        break
      }
    }
    if (start < 0) {
      return { ok: false, code: 'PERSONA_SECTION_MISSING', message: 'id: persona 之上找不到同层列表项头（- 行）—— 保留原文本，不猜' }
    }
  }
  let textHdr = -1
  for (let i = start + 1; i < lines.length; i++) {
    const li = lines[i]
    if (li.trim() === '') continue
    const ind = li.match(/^\s*/)[0].length
    if (ind <= itemIndent) break // 出了 persona 项
    if (/^\s*text\s*:\s*(\||>|[-+])/.test(li) || /^\s*text\s*:\s*$/.test(li)) {
      textHdr = i
      break
    }
  }
  if (textHdr < 0) {
    return { ok: false, code: 'PERSONA_TEXT_NOT_FOUND', message: 'persona 项里找不到 text 块标量 —— 保留原文本，不猜' }
  }
  const bodyIndent = lines[textHdr].match(/^\s*/)[0].length + 2
  let end = textHdr + 1
  for (let i = textHdr + 1; i < lines.length; i++) {
    const li = lines[i]
    if (li.trim() === '') {
      end = i + 1
      continue
    }
    if (li.match(/^\s*/)[0].length >= bodyIndent) {
      end = i + 1
      continue
    }
    break
  }
  // 提取旧值时按块标量语义剥掉 bodyIndent（这才是「文本本身」，UI 的改前/改后与写后探针都用它）
  const stripIndent = (l) => (l.trim() === '' ? '' : l.slice(bodyIndent))
  const before = lines.slice(textHdr + 1, end).map(stripIndent).join('\n').replace(/\n+$/, '')
  const bodyLines = newText.split('\n').map((l) => (l === '' ? '' : ' '.repeat(bodyIndent) + l))
  const out = lines.slice(0, textHdr + 1).concat(bodyLines, lines.slice(end))
  return { ok: true, newText: out.join('\n'), before, after: newText }
}

/** 探针：取当前 persona 的 text 块标量内容（回读校验用）。 */
function personaTextOf(text) {
  const r = rewritePersonaText(text, '@@PROBE@@')
  return r.ok ? r.before : null
}

/** pack 的 CONFLICTS 警告是否在（在 ⇒ 不写盘，先商量）。 */
function hasConflicts(contract) {
  return contract.violations.some((v) => v.code === 'HAS_CONFLICTS')
}

/** pack META 的 identity 取值（空/NONE ⇒ null）。 */
function identityOf(meta) {
  const v = typeof meta.identity === 'string' ? meta.identity.trim() : null
  return v === '' || v === 'NONE' ? null : v
}

/**
 * P1b-2a ①②③：把校验通过的 pack 落地进 preset ——
 *   1) <preset>/dma-rp-inject.js（我们的注入模块，新文件）
 *   2) <preset>/dma-rp-pack.md（pack 原文逐字留档，新文件）
 *   3) agent.cordis.yml：段列表末尾追加挂载行（幂等；只新增不删改）+ persona 的 text 改写为 IDENTITY（+TONE 非 KEEP 时接后）
 * ★ 全走四步写入纪律：先算后写、TOCTOU 重核（写前）、备份 → 原子写 → 回读（逐字节 + 注释保全 +
 *   挂载在 + persona 读回）→ 不一致自动回滚；组合文件失败时连带清掉本次新建的两个文件（零残留）。
 * ★ 白名单：本函数只写上述三处；pack 有 CONFLICTS ⇒ 拒（先商量）；无 IDENTITY ⇒ persona 不写（如实报告）。
 */
export function applyPackToPreset(opts) {
  const o = opts || {}
  const inspected = inspectPreset(o)
  if (!inspected.ok) return inspected
  const dir = inspected.dir
  const compositionPath = join(dir, COMPOSITION_FILE_NAME)
  const originalText = inspected.composition
  const sw = packSwitchDefaults(o.switches)
  const parsed = parsePack(o.packText)
  const contract = checkPackContract(o.packText, { expectCardHash: typeof o.expectCardHash === 'string' ? o.expectCardHash : undefined })
  // ★ 本单 §二：pack 没有 IDENTITY ⇒ 不是错误 —— persona 不写（保留原文本）并如实报告；
  //   identity 为空/超 400 字仍是错误级（BAD_IDENTITY）。
  const identity = identityOf(parsed.meta)
  const hardViolations = contract.violations.filter(
    (v) => v.severity === 'error' && !(v.code === 'BAD_IDENTITY' && identity === null),
  )
  if (hardViolations.length > 0) {
    return fail('PACK_INVALID', 'pack 没过契约校验（错误级 ' + hardViolations.length + ' 条）：' + hardViolations.map((v) => v.code).join('、'), { violations: contract.violations })
  }
  if (hasConflicts(contract)) {
    return fail('PACK_HAS_CONFLICTS', 'CONFLICTS 非 NONE —— 先跟用户商量，用户答完之前不写盘', { violations: contract.violations })
  }
  const tone = parsed.tone && parsed.tone.trim() !== '' && parsed.tone.trim() !== 'KEEP' ? parsed.tone.trim() : null
  const personaNext = identity === null ? null : identity + (tone ? '\n\n' + tone : '')

  // —— 全部文本计算都在任何写盘之前（失败 = 零写入）——
  const mounted = upsertMount(originalText, sw)
  if (!mounted.ok) return mounted
  let personaResult = null
  if (personaNext !== null) {
    personaResult = rewritePersonaText(mounted.newText, personaNext)
    if (!personaResult.ok) return personaResult
  }
  const finalText = personaResult ? personaResult.newText : mounted.newText
  const injectModule = buildInjectModule()
  const packText = String(o.packText == null ? '' : o.packText)

  const stamp = nowStamp()
  const backupPlan = { dir: join(dir, BACKUP_DIR_NAME), files: [COMPOSITION_FILE_NAME + '.' + stamp] }
  const persona = personaResult
    ? { before: personaResult.before, after: personaResult.after, changed: personaResult.before !== personaResult.after, written: true }
    : { before: null, after: null, changed: false, written: false, note: 'pack 没有 identity —— persona 保留原文本（不猜不补）' }

  const plan = [
    '写 ' + INJECT_FILE_NAME + '（我们的注入模块：dma:settings@' + sw.settingsOrder + ' / dma:rules@' + sw.rulesOrder + '）',
    '写 ' + PACK_FILE_NAME + '（pack 原文逐字留档，含 cardHash）',
    mounted.mount === 'created'
      ? 'agent.cordis.yml 段列表末尾追加挂载块（- id: ' + MOUNT_ID + '；只新增，不删不改任何现有行）'
      : 'agent.cordis.yml 已有挂载块 —— 只按开关更新那几行值（幂等）',
    personaResult ? '改写 persona 的 text 为 pack 的 identity' + (tone ? '（TONE 非 KEEP，接在其后）' : '') : 'persona 不动（pack 没有 identity）',
    '备份 → 原子写 → 回读（逐字节 + 注释保全 + 挂载在 + persona 读回）→ 不一致自动回滚',
  ]

  if (o.dryRun) {
    return {
      ok: true,
      dryRun: true,
      presetId: o.presetId,
      presetDir: dir,
      switches: sw,
      persona,
      plan,
      backup: backupPlan,
      note: 'dryRun：以上是计划，本调用一个字节都没写。',
    }
  }

  // —— 写前重核（TOCTOU）：rename 之前、备份之前 ——
  const recheck = recheckUnchanged(dir, COMPOSITION_FILE_NAME, originalText, inspected.stat, o._fault === 'recheck')
  if (!recheck.ok) return recheck

  // —— 先写两个新文件（没有挂载行它们是惰性的；组合文件失败时连带清掉，零残留）——
  const injectPath = join(dir, INJECT_FILE_NAME)
  const packPath = join(dir, PACK_FILE_NAME)
  const injectExisted = existsSync(injectPath)
  const packExisted = existsSync(packPath)
  const cleanupNewFiles = () => {
    try {
      if (!injectExisted) rmSync(injectPath, { force: true })
      if (!packExisted) rmSync(packPath, { force: true })
    } catch {}
  }
  try {
    atomicWrite(injectPath, injectModule)
    if (readFileSync(injectPath, 'utf8') !== injectModule) throw new Error('注入模块回读不一致')
    atomicWrite(packPath, packText)
    if (readFileSync(packPath, 'utf8') !== packText) throw new Error('pack 留档回读不一致')
  } catch (e) {
    cleanupNewFiles()
    return fail('WRITE_FAILED', '写注入模块/pack 文件失败：' + String((e && e.message) || e))
  }

  // —— 组合文件：备份 → 原子写 → 回读 → 不一致自动回滚（复用 P1a 四步）——
  let backup
  try {
    backup = backupFile(dir, COMPOSITION_FILE_NAME, originalText, stamp)
  } catch (e) {
    cleanupNewFiles()
    return fail('BACKUP_FAILED', '备份失败（未改动原文件）：' + String((e && e.message) || e))
  }
  try {
    atomicWrite(compositionPath, finalText)
  } catch (e) {
    cleanupNewFiles()
    return fail('WRITE_FAILED', '原子写失败（原文件未被改动）：' + String((e && e.message) || e), { backup })
  }
  let readBack = null
  try {
    readBack = readFileSync(compositionPath, 'utf8')
  } catch {}
  let verifyBad = null
  if (o._fault === 'verify') verifyBad = '（自检注入）模拟回读不一致'
  else if (readBack !== finalText) verifyBad = '回读与预期文本逐字节不一致'
  else if (!commentsPreserved(originalText, readBack)) verifyBad = '回读后发现注释行丢失'
  else if (!readBack.includes('id: ' + MOUNT_ID)) verifyBad = '回读后发现挂载行不在'
  else if (personaResult && personaTextOf(readBack) !== personaNext) verifyBad = '回读后发现 persona 的 text 不是刚写入的值'
  if (verifyBad) {
    let rolledBack = false
    try {
      atomicWrite(compositionPath, originalText)
      rolledBack = readFileSync(compositionPath, 'utf8') === originalText
    } catch {}
    cleanupNewFiles()
    return fail('VERIFY_FAILED', '回读校验不过（' + verifyBad + '）' + (rolledBack ? '；已用备份自动回滚，文件回到原样' : '；回滚也失败了'), {
      rolledBack,
      backup,
    })
  }

  return {
    ok: true,
    dryRun: false,
    presetId: o.presetId,
    presetDir: dir,
    switches: sw,
    persona,
    mount: mounted.mount,
    written: { injectModule: injectPath, packFile: packPath, composition: compositionPath },
    applied: [
      { file: INJECT_FILE_NAME, field: '注入模块（dma:settings@' + sw.settingsOrder + ' / dma:rules@' + sw.rulesOrder + '）', from: injectExisted ? '（已存在，覆盖为当前生成器版本）' : '（新建）', to: '（模块文件）' },
      { file: PACK_FILE_NAME, field: 'pack 原文留档', from: packExisted ? '（已存在，覆盖）' : '（新建）', to: '（pack 全文 ' + packText.length + ' 字）' },
      { file: COMPOSITION_FILE_NAME, field: mounted.mount === 'created' ? '段列表末尾挂载块' : '挂载块开关值', from: mounted.mount === 'created' ? '（无 dma-rp-inject 行）' : '（已有，按开关更新）', to: '见备份 diff' },
      ...(personaResult ? [{ file: COMPOSITION_FILE_NAME, field: 'persona 的 text', from: personaResult.before, to: personaResult.after }] : []),
    ],
    backup,
    errors: [],
  }
}

// ---------------------------------------------------------------------------
// 末尾新增导出（任务书 20260913「RP 预设落地」授权：只许在末尾新增导出，不改任何既有
// 函数的语义）。lib/mt-preset.js 的一键生成走【单一事实源】：注入模块用本文件的
// buildInjectModule()、工具面用 RP_TOOL_SCOPE_JS、绑定字段口径用 BINDING_SCHEMA_VERSION
// 与 MANAGED_BY —— 绝不在 mt-preset 里另写一份。
// ---------------------------------------------------------------------------
export { buildInjectModule, RP_TOOL_SCOPE_JS, BINDING_SCHEMA_VERSION, MANAGED_BY }
