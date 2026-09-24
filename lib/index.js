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
 *   - 读整条日志一律走 loadSessionLog（活会话注册表优先 → readSession 退路）：上游 readSession
 *     对 seeded 会话必抛（session-query/src/index.ts:183-196 → core/session/src/index.ts:599-600
 *     的 seed 校验），fork 周目会话曾全部 500 —— 见 loadSessionLog 顶注。
 *   - readSession 只吃一个参数、返回全量事件（SessionLogSnapshot{session,events}），分页在本地切片；
 *     surface 首选 filterEvents(id,[])（空过滤=全量，document 带 surface+正文），兜底 listEvents 按 seq 对齐。
 *   - 性能：/session/events 的派生行走 LRU 缓存（≤3 会话、TTL 20s、?refresh=1 绕过，
 *     总字节上限默认 128 MB —— 单会话超限就不缓存，见 ./mem-budget.js 与
 *     EVENTS_CACHE_MAX_BYTES）；/sessions 默认不做 title 投影（?titles=1 才做，
 *     结果同样短 TTL）。
 *   - 只用 node: 内置模块，零 npm 依赖；不导出 Config schema。
 *   - 任何服务缺失都不让 apply 抛错；handler 内异常一律收口为 500 INTERNAL。
 *   - retrieval.key 绝不回显原文（只回 keySet/keyHint），任何响应/日志都不出现 key。
 *
 *   8) B1（聊天导入·零落库）：GET /import/formats 与 POST /import/plan（实现全在 ./import-formats.js，本文件只加两行分派；⛔ 不落库不写盘）。
 *   8b) B2（聊天导入·落库）：POST /import/apply（实现全在 ./import-apply.js；它复用 A1 的
 *       planCollect/applyCollect 真写盘，并靠"预览即合同"与"两个写手字节交叉核对"两道闸拒错写）。
 *   9) A1 周目归档写入器（「收纳」落库半边）：/collect/targets、/collect/plan、/collect/apply —— 实现全部在 ./collect.js，本文件只加分派行与端点表项。
 *   10) A2 压缩联动·自动收纳：/collect/scan 与 /collect/auto —— 按会话日志里的**压缩替换事件**
 *       （compaction/summary·prune 的 shadowedSeqs，一条压缩 = 一个区间）切区间、取那次压缩自己的
 *       模型摘要，按台账（只存哈希/计数/路径）幂等落库进周目归档；原始事件由 createRawEventLoader
 *       （loadSessionLog 包装）注入，实现全在 ./collect-scan.js，这里只加分派行与端点表项。
 *   11) 角色扮演记忆库只读出口（20260919）：GET /playthrough/rp-memory —— 面板「剧情大纲」那一档
 *       （手动确认后才取），读社区预设写在工作目录下的 .roleplay-memory/。列目录里实际有的那些；
 *       文件名过 ./rel-path-jail.js 的裁决（只调用不修改）⇒ 不是任意文件读入口。
 *       ⛔ 曾经的 memory_write 工具、以及我们那份单文件大纲（/playthrough/outline）都已退役。
 * @license CC-BY-NC-4.0 (Attribution-NonCommercial 4.0 International)
 * 移植来源：anima-rag (https://github.com/Ellinav/anima-rag) — 作者 Ellinav
 * 仅限个人学习与非商业用途；禁止闭源商用或转为付费插件/服务；不重新分发预置私域数据。
 * 含 DeepSeek Harness 派生部分（MIT, Copyright (c) 2026 DeepSeek）时该部分保留 MIT。
 */

import {
  accessSync,
  appendFileSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-memory-archive'

/**
 * skills：DSH 里 skill 的唯一界面形态是输入框打 `/` 弹出的列表，而 skill 必须由插件
 * 申请 skills 服务并在 apply() 里同步注册才会出现（@deepseek-ai/dsh-skill 在 base
 * bundle 里启用）。webServer 仍不写死依赖：用「有就注册、没有就跳过」，sessionQuery
 * 在请求时按需 ctx.get —— 服务缺失时插件都要能 apply 成功（宿主启动不能被本插件拖死）。
 */
export const inject = ['skills']

const API_PREFIX = '/dsh-memory-archive/api'
const PROMPT_PREFIX = '/dsh-memory-archive/prompt' // 并入的提示词查看器（./prompt-viewer.js）
const TEMPLATES_MAX_CHARS = 20000 // 单个提示词模板的字符上限
const PLUGIN_DIR_NAME = 'dsh-memory-archive'
const CONFIG_FILE_NAME = 'config.json'
const CONFIG_SCHEMA_VERSION = 1

/** 记忆回响（D2）可配的数值键与合法区间；sanitizeConfig 与 mergeConfig 共用，防两处漂移。 */
const ECHO_NUMBER_KEYS = Object.freeze([
  { key: 'topK', min: 1, max: 20 },
  { key: 'maxChars', min: 240, max: 8000 },
  { key: 'minDf', min: 1, max: 100 },
  { key: 'maxDf', min: 1, max: 1000 },
])
/** 最近几楼（mt:lastFloors）可配的数值键与合法区间；sanitizeConfig 与 mergeConfig 共用，防两处漂移。 */
const LAST_FLOORS_NUMBER_KEYS = Object.freeze([
  { key: 'count', min: 1, max: 200 },
  { key: 'maxChars', min: 200, max: 60000 },
])
/** 归档楼层读盘结果的缓存 TTL（毫秒）：一次装配要读 254 个文件，靠它把「每步重读」压成「每 20s 一次」。 */
const LAST_FLOORS_CACHE_TTL_MS = 20000

/**
 * 角色扮演记忆库（`.roleplay-memory/`）—— 这是**社区预设 `oliblue-evan/dsh-roleplay-preset`
 * 自己的契约**（写在它的 `agent.cordis.yml`「六、记忆系统」里），⛔ 不做成配置键。
 *
 * 列的是**目录里实际有的**（不写死名单：预设哪天多写一份也要看得见），只受两条约束：
 * ① 只列普通文件、扩展名在 `RP_MEMORY_EXTENSIONS` 里（在场时以 `rel-path-jail.js` 的同一张表为准，
 *    防两处漂移）；② 名字必须能过路径裁决 ⇒ 天然排掉 `..`、盘符、保留设备名这类。
 * 排序：先按**偏好顺序**（预设那四份，index 打头：它被定义为「索引 + 最近剧情进展 + 当前时间地点」），
 * 其余按名字排在后面 —— 只为稳定好找，⛔ 与"读不读"无关。
 */
const RP_MEMORY_DIR_NAME = '.roleplay-memory'
const RP_MEMORY_PREFERRED_ORDER = Object.freeze(['index.md', 'state.md', 'story.md', 'characters.md', 'world.md'])
/** 兜底扩展名表（`rel-path-jail.js` 缺席时才用到；在场时用它的 ALLOWED_EXTENSIONS）。 */
const RP_MEMORY_EXTENSIONS = Object.freeze(['.md', '.txt', '.json', '.yaml', '.yml'])
const RP_MEMORY_MAX_FILES = 200
/** 单份正文的交付上限：超了截断并如实回 `originalChars`（⛔ 不把标注写进正文）。 */
const RP_MEMORY_MAX_FILE_CHARS = 200000
/**
 * ★ 2026-09-23（死区）：一次比对最多读几份文件（死区通常落在一两份笔记上；到顶就少读几份，
 * ⛔ 宁可少读也不许把一轮装配拖成 N 次读盘 —— 条数本身另有 `DEADZONE_MAX_ZONES` 管着）。
 */
const DEADZONE_STATUS_MAX_FILES = 50
/** 每轮那条看守的**结果文件**（面板顶栏/状态端点只读投影它；⛔ 结果没变就不重写）。 */
const DEADZONE_STATUS_FILE = 'deadzone-status.json'
/** 一个会话里"这一轮查过了"的门（`turnBoundary.lastTurn` 取不到时的兜底最小间隔，毫秒）。 */
const DEADZONE_FALLBACK_MIN_MS = 5000
/**
 * 「楼层快照」的**最近一次回档跟随**结果文件（面板那一行"最近一次自动回档跟随"只读投影它；
 * ⛔ 结果没变就不重写、不重记日志 —— 与死区看守同一条纪律）。
 */
const FLOOR_STATUS_FILE = 'floor-status.json'

/** 装配期"取最近一轮文本"的有界等待（超时 ⇒ 本轮不注入；绝不阻塞主对话）。 */
const ECHO_PREP_BUDGET_MS = 1200
/** 拼 query 时取尾部多少条正文（最近一轮通常 1–2 条，取 6 条留余量）。 */
const ECHO_QUERY_TAIL_DOCS = 6
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

// v3 消费端（./v3-composer.js，外部组合器）：同样的顶层守卫加载。它缺席时：
//   · 组合器不注册（装配仍归 Tavern 内置策略）
//   · /v3 与 /v3/mode 两条端点降级为可读错误（HTTP 200 + ok:false）
// ⛔ 它**不** import Tavern 代码：只经 Cordis 服务面 pmpDshTavernPrompt（软注入）与 HTTP。
let v3Composer = null
let v3ComposerLoadError = null
try {
  const mod = await import('./v3-composer.js')
  v3Composer = typeof mod.registerV3Composer === 'function' ? mod : null
  if (v3Composer === null) v3ComposerLoadError = new Error('v3-composer.js 未导出 registerV3Composer')
} catch (e) {
  v3ComposerLoadError = e
}
/** 默认 owner（与 v3-composer.js 的 DEFAULT_OWNER 一致；模块缺席时端点仍要给个名字）。 */
const V3_DEFAULT_OWNER = v3Composer?.DEFAULT_OWNER ?? 'dsh-memory-archive'

// 上游卡字段的**位置计划**（./tavern-field-plan.js）：顶层守卫加载。模块缺席 ⇒ 我们不动段表
// （上游的段留在原位、面板照旧显示），其余一切照旧。
// ★ 为什么要有它（用户 2026-09-19 口径）：「上游没有指定 order 或什么东西，这就是让位给我们，让我们设置注入位置」
//   ⇒ 我们把上游解出来的每个字段摆到 ST 该有的位置上（PHI 摆到全文最后、开场白摆到历史之前…）。
let tavernFieldPlan = null
let tavernFieldPlanLoadError = null
try {
  const mod = await import('./tavern-field-plan.js')
  tavernFieldPlan = typeof mod.placeTavernParts === 'function' ? mod : null
  if (tavernFieldPlan === null) tavernFieldPlanLoadError = new Error('tavern-field-plan.js 未导出 placeTavernParts')
} catch (e) {
  tavernFieldPlanLoadError = e
}

/** 段表摆位的接线句柄（apply() 里赋值）：让 /v3 能如实报告"这一轮我们把哪些字段摆到了哪儿"。 */
let tavernPartsHandle = null

// 后处理提示词「作为玩家消息注入」（./phi-message.js）：顶层守卫加载。
// ★ 为什么要有它（用户 2026-09-20 拍板）：「有没有办法脱离 system，直接到 user 信息后方」——
//   DSH 里唯一能到那个位置的通路是 `agent/pre-step` 的 `decision.messages`（官方 time-context 同款）。
//   ⚠️ 代价是它**进会话日志**（durable、每轮一份），用户已知并接受；三处清洗见那个模块的文件头注释。
let phiMessage = null
let phiMessageLoadError = null
try {
  const mod = await import('./phi-message.js')
  phiMessage = typeof mod.registerPhiMessage === 'function' ? mod : null
  if (phiMessage === null) phiMessageLoadError = new Error('phi-message.js 未导出 registerPhiMessage')
} catch (e) {
  phiMessageLoadError = e
}
/** 每会话"上游那份后处理提示词的正文"（装配期记下来，pre-step 注入时用）。有界。 */
const phiTextBySession = new Map()
/** 已经**成功注入过**的会话：从第二轮起把 system 里那份清空（⛔ 只有跑通过才敢清，第一轮留作兜底）。 */
const phiInjectedSessions = new Set()
const PHI_SESSION_MAX = 64
function rememberPhiText(sessionId, text) {
  if (typeof sessionId !== 'string' || sessionId === '') return
  phiTextBySession.delete(sessionId)
  phiTextBySession.set(sessionId, { text, at: Date.now() })
  while (phiTextBySession.size > PHI_SESSION_MAX) {
    const oldest = phiTextBySession.keys().next().value
    if (oldest === undefined) break
    phiTextBySession.delete(oldest)
  }
}
/** phi 注入的接线句柄（apply() 里赋值）。 */
let phiMessageHandle = null
/** `phiAsMessage.enabled` 的短 TTL 缓存（装配期每轮都要问，别每轮读一次盘）。 */
let phiSwitchCache = { at: 0, enabled: true }
function phiSwitchEnabled() {
  const now = Date.now()
  if (now - phiSwitchCache.at > 10000) {
    let enabled = phiSwitchCache.enabled
    try { enabled = sanitizeConfig(readConfigFile().config).phiAsMessage.enabled === true } catch { /* 读不到就沿用上一次 */ }
    phiSwitchCache = { at: now, enabled }
  }
  return phiSwitchCache.enabled
}

// 「最近几楼」的纯函数核心（./last-floors.js）：同样是顶层守卫加载 —— 模块缺席只是这段不注入。
// ⚠️ 它必须**先于组装捕获**注册（见 apply() 里的同款说明）。
let lastFloors = null
let lastFloorsLoadError = null
try {
  const mod = await import('./last-floors.js')
  lastFloors = typeof mod.readSwitch === 'function' ? mod : null
  if (lastFloors === null) lastFloorsLoadError = new Error('last-floors.js 未导出 readSwitch')
} catch (e) {
  lastFloorsLoadError = e
}

// v3 合同识别与投影（./v3-contract.js）：纯逻辑、零宿主依赖。同样是顶层守卫加载 ——
// 模块缺席时 /v3 降级为可读错误，其余全部功能不受影响。
// ★ 为什么必须单独成模块：Tavern 有**两套互不相容的 v3**（composer / trace），
//   两套的 capabilities 字段面不重叠、端点路径不同；判错的后果不是报错、是**静默谎报**
//   （把新合同的"没有 composers 字段"读成"重启宿主就好了"）。判定要有前瞻、要有反证。
let v3Contract = null
let v3ContractLoadError = null
try {
  const mod = await import('./v3-contract.js')
  v3Contract = typeof mod.detectV3Contract === 'function' ? mod : null
  if (v3Contract === null) v3ContractLoadError = new Error('v3-contract.js 未导出 detectV3Contract')
} catch (e) {
  v3ContractLoadError = e
}
// 段表观察缓存（./v3-observe-cache.js）：只装"这一轮段表里我们自己的段在不在"这一条观察，
// 供 replace 模式看守（/v3.replaceGuard）读取。⛔ 不再缓存任何正文（尾段已退役，见 registerTavernParts）。
let v3ObserveCacheMod = null
let v3ObserveCacheLoadError = null
try {
  const mod = await import('./v3-observe-cache.js')
  v3ObserveCacheMod = typeof mod.createObserveCache === 'function' ? mod : null
  if (v3ObserveCacheMod === null) v3ObserveCacheLoadError = new Error('v3-observe-cache.js 未导出 createObserveCache')
} catch (e) {
  v3ObserveCacheLoadError = e
}
const v3ObserveCache = (() => { try { return v3ObserveCacheMod === null ? null : v3ObserveCacheMod.createObserveCache() } catch { return null } })()

// 「向量」页签的宿主半侧（./vector-panel.js，2026-09-20）：纯文件读写 —— 读 anima 落的状态快照、
// 写一张请求单。顶层守卫加载（与本文件其它模块同款）：模块缺席时两条 /vector/* 端点降级为可读错误，
// 其余一切照旧。★ 为什么不用静态 import：宿主 loader 用 `await import(entry)` 加载本入口，
//   只有顶层守卫加载才能保证"加载失败也不拖死 apply"。
let vectorPanel = null
let vectorPanelLoadError = null
try {
  const mod = await import('./vector-panel.js')
  vectorPanel = typeof mod.readVectorState === 'function' ? mod : null
  if (vectorPanel === null) vectorPanelLoadError = new Error('vector-panel.js 未导出 readVectorState')
} catch (e) {
  vectorPanelLoadError = e
}

// 延迟挂载工具（./deferred-install.js）：见模块说明 —— 开机即挂的 `system-prompt/assemble`
// 监听会排在最上游，看不见下游 await 注入的内容（anima 记忆 / 世界书）。
let deferredInstall = null
try {
  const mod = await import('./deferred-install.js')
  deferredInstall = typeof mod.makeDeferredAssembleListener === 'function' ? mod : null
} catch { deferredInstall = null }

/** 本插件自己注册的段名（replace 模式白名单之外的那些）—— 用途见下面 replace 看守。 */
// ⚠️ 2026-09-19：`mt:postHistory` **退役**（用户拍板删掉那个字段）—— 卡的后处理指令现在只有上游那一份，
//   由 `lib/tavern-field-plan.js` 摆到全文最后（order 10203）。⛔ 别再把那个段名加回来。
// ⚠️ 2026-09-20：`state:card` **整个剥离**（状态子系统退役，状态改由周目笔记 `.roleplay-memory/state.md` 维护）；
//   `rp:storyAnchor` **暂时不注册**（用户口径：「直接取消这个注册段吧。暂时不注册了」）——
//   两个都不再期待存在，所以从这份名册里摘掉（留着只会让 replace 看守永远报"缺失"）。
//   ★ 哪天真要把 story-anchor 挂回来：这里加回 `rp:storyAnchor` 即可（模块文件与预设副本都还在）。
const OUR_SECTION_NAMES = Object.freeze([
  'dma:echo', 'anima:memory', 'rp:firstRound', 'mt:lastFloors', 'mt:memoryHome',
])

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

// ★ 2026-09-19：「一键生成 RP 预设」那条线**整块退役**（用户口径「不用保持了」）——
//   `lib/mt-preset.js` 与 `/agent/provision` 一起删掉了，这里不再加载它。
//   本插件现在是**通用工具**：不生成、不修复、不供给 agent preset（理由与范围见方案文档 §8/§9）。

// sections-capture（./sections-capture.js，编辑器 v2 · B 流的组装捕获真相源 + C4 段结构）：
// 与上面同样的顶层守卫加载 —— 它缺席时组装捕获跳过注册、/sections 降级为可读错误
// （HTTP 200 + ok:false），其余全部 rest 与插件加载完全不受影响。
// ⛔ 本文件对它只【调用】不修改（B 流所有物）；导出名见 docs/INTERFACES-editor-v2.md 冻结片段。
let sectionsCapture = null
let sectionsCaptureLoadError = null
try {
  sectionsCapture = await import('./sections-capture.js')
} catch (e) {
  sectionsCaptureLoadError = e
}

// 记忆回响（D2）：./echo-index.js（node:sqlite FTS5 trigram 引擎：建表/增量入库/抽候选/查询）
// + ./echo-inject.js（拼注入文本 + 工厂 createEchoInject）。与上面同样的顶层守卫加载 ——
// 两者缺席时**不接线**（不注册段、不注入），插件其余功能与宿主启动完全不受影响。
let echoModules = null
let echoModulesLoadError = null
try {
  const [idx, inj] = await Promise.all([import('./echo-index.js'), import('./echo-inject.js')])
  echoModules = { ...idx, ...inj }
} catch (e) {
  echoModulesLoadError = e
}

// 「相对路径裁决」（./rel-path-jail.js）：与上面同样的顶层守卫加载 —— 它缺席时只有**用它那一处**
// 降级（`GET /playthrough/rp-memory` 的名单过滤与 `?file=` 校验会退到内置的扩展名表），
// 插件其余功能与宿主启动完全不受影响。
// ★ 2026-09-19：这份裁决原属 `memory_write` 工具；那个工具**整块退役**（用户口径「记忆库写入也可以
//   摘除，包括代码和描述」），但**读侧仍靠它**保证"只读记忆库目录里的普通文件，不是任意文件读入口"
//   ⇒ 把裁决抽成独立模块留下，写侧特有的东西（工具名/写入模式/字数预算）随工具一起删掉。
let relPathJail = null
let relPathJailLoadError = null
try {
  const mod = await import('./rel-path-jail.js')
  relPathJail = typeof mod.resolveUnderDir === 'function' ? mod : null
  if (relPathJail === null) relPathJailLoadError = new Error('rel-path-jail.js 未导出 resolveUnderDir')
} catch (e) {
  relPathJailLoadError = e
}

// 「会话 → 周目」（./session-playthrough.js，20260919）：面板的**跟随当前会话**靠它。
// 同样顶层守卫加载 —— 缺席时只有那一处降级（`/playthrough/for-session` 如实回 `source:'none'`），
// 插件其余功能与宿主启动完全不受影响。
let sessionPlaythrough = null
let sessionPlaythroughLoadError = null
try {
  const mod = await import('./session-playthrough.js')
  sessionPlaythrough = typeof mod.buildSessionIndex === 'function' ? mod : null
  if (sessionPlaythrough === null) sessionPlaythroughLoadError = new Error('session-playthrough.js 未导出 buildSessionIndex')
} catch (e) {
  sessionPlaythroughLoadError = e
}

// 「剧情笔记」写入（./memory-write.js，20260919 复活版）：纯逻辑（开关 / 判据 / 名字常量）。
// 同样顶层守卫加载 —— 缺席时**不注册 memory_write 工具**（RP 照常可用，只是没有写工具）。
let memoryWrite = null
let memoryWriteLoadError = null
try {
  const mod = await import('./memory-write.js')
  memoryWrite = typeof mod.decideNoteWrite === 'function' ? mod : null
  if (memoryWrite === null) memoryWriteLoadError = new Error('memory-write.js 未导出 decideNoteWrite')
} catch (e) {
  memoryWriteLoadError = e
}

// 「自动压缩触发阈值」纯逻辑（./compaction-threshold.js，20260921）：占用率公式 / 阈值夹紧 /
// 预设 YAML 的定点替换（数出现次数 + 备份 + 回读校验）。同样顶层守卫加载 —— 缺席时只有
// `/compaction/state` 与 `/compaction/config` 两条 rest 降级为可读的 ok:false，
// 插件其余功能与宿主启动完全不受影响（⛔ 不为这一块把整个插件拖下水）。
let compactionThreshold = null
let compactionThresholdLoadError = null
try {
  const mod = await import('./compaction-threshold.js')
  compactionThreshold = typeof mod.patchThresholdRatio === 'function' ? mod : null
  if (compactionThreshold === null) compactionThresholdLoadError = new Error('compaction-threshold.js 未导出 patchThresholdRatio')
} catch (e) {
  compactionThresholdLoadError = e
}

// 「剧情文本死区（模型禁改区）」+「剧情文本直接编辑」（./deadzone.js，20260923）：纯逻辑内核。
// 同样顶层守卫加载 —— 缺席时**三条新端点**降级为可读错误、`mt:memoryHome` 段与死区看守都不注入，
// 插件其余功能（含「剧情大纲」档的只读那半边）与宿主启动完全不受影响。
let deadzone = null
let deadzoneLoadError = null
try {
  const mod = await import('./deadzone.js')
  deadzone = typeof mod.compareZones === 'function' ? mod : null
  if (deadzone === null) deadzoneLoadError = new Error('deadzone.js 未导出 compareZones')
} catch (e) {
  deadzoneLoadError = e
}

// 「新周目自动挂 RP 预设」（./rp-preset-attach.js，20260924）：收编原先打在第三方 Tavern 上的
// 那一处补丁（用户 2026-09-24 拍板）。缺席时**只是这个功能不接线**（照旧走 DSH 默认预设），
// 插件其余功能与宿主启动完全不受影响。
let rpPresetAttach = null
let rpPresetAttachLoadError = null
try {
  const mod = await import('./rp-preset-attach.js')
  rpPresetAttach = typeof mod.registerRpPresetAttach === 'function' ? mod : null
  if (rpPresetAttach === null) rpPresetAttachLoadError = new Error('rp-preset-attach.js 未导出 registerRpPresetAttach')
} catch (e) {
  rpPresetAttachLoadError = e
}

// 「按楼层绑定的笔记快照 + 回档跟随」（./floor-snapshot.js，20260923）：纯逻辑内核 + 落盘。
// 同样顶层守卫加载 —— 缺席时两条新端点降级为可读错误、两条钩子都不接（⛔ 一个字节都不写），
// 插件其余功能与宿主启动完全不受影响。★ 它静态 import `./deadzone.js`（复用同一份 sha 与
// "写前备份 + 写后回读"），所以死区模块坏掉时它也会一起缺席（判据只有一处，⛔ 不各写一份）。
let floorSnapshot = null
let floorSnapshotLoadError = null
try {
  const mod = await import('./floor-snapshot.js')
  floorSnapshot = typeof mod.syncFloor === 'function' ? mod : null
  if (floorSnapshot === null) floorSnapshotLoadError = new Error('floor-snapshot.js 未导出 syncFloor')
} catch (e) {
  floorSnapshotLoadError = e
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

/**
 * 存储目录 = `<DSH_HOME | ~/.dsh>/dsh-memory-archive`（与包名一致）。
 *
 * ★ 改名遗留（2026-09-14 改回）：这个包先叫 `dsh-memory-archive`、中途改成 `magictarven`、现在改回来。
 *   盘上可能**只有**旧名目录（老用户），所以新名目录不存在时回退读旧名 —— 否则用户会以为"数据没了"。
 *   两个都在时**不猜**：用新名目录（并库由一次性迁移工具做，见 CHANGELOG）。
 *   ⚠️ `lib/sections-capture.js` 里有一份**逐字相同**的实现（那个文件刻意不反向依赖本文件）；
 *      `_selftest-sections.mjs` 有一条断言钉住"两份解析结果必须一致"，防漂移。
 */
const LEGACY_DIR_NAMES = ['magictarven']

function storageDir(env = process.env) {
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

/** 仅供自检台核对"新旧名解析与 sections-capture 那份一致"；运行时不用。 */
export { storageDir }

/** `<DSH_HOME | ~/.dsh>` 本身（与 storageDir 同源推导；记忆回响要用它找 Tavern 的工作区绑定）。 */
function dshHomeDir(env = process.env) {
  const configured = env.DSH_HOME
  const dshHome =
    configured !== undefined && String(configured).trim() !== ''
      ? String(configured)
      : join(homedir(), '.dsh')
  return resolve(expandHome(dshHome))
}

function configPath() {
  return join(storageDir(), CONFIG_FILE_NAME)
}

function defaultConfig() {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    rootMode: 'session', // 'session'（默认，纯 DSH）| 'workspace'（Tavern 环境）
    root: { sessionId: null, characterId: null, playthroughId: null },
    // 向量检索（20260918：从「预设 + 环境变量」搬进本配置 —— 面板「向量检索 API」卡收整套）。
    // 消费方是 dsh-anima-rag（它直接读本文件）。
    // ★★ 2026-09-20（用户口径「两个模型都要有接口」）：向量与重排**各一套完整三件套** ——
    //   向量 = {url, model, key}；重排 = {rerankUrl, rerankModel, rerankKey}。
    //   ⚠️ 两个 `*Url` 都是 **baseURL**（各自能落在不同服务商）：向量端点 = url + '/embeddings'，
    //      重排端点 = rerankUrl + '/rerank'（以 '/rerank' 结尾时不再拼）。
    //   ⚠️ 向后兼容：`rerankUrl` 空 ⇒ 沿用 `url`；`rerankKey` 空 ⇒ 沿用 `key`
    //      —— 老配置（只有 url/model/rerankModel/key 四项）行为**一字不变**。
    // key / rerankKey 都只写不读：GET /config 只回 keySet/keyHint（两组），任何响应/日志不出现原文。
    // ★ chatEnabled（2026-09-20）：「向量」页签那颗「参与检索」开关 —— 同时管向量与 BM25 两条支线。
    //   默认 **true**：开关上线前记忆库一直是参与检索的，默认值只能保持现状（⛔ 不许因为加了个开关
    //   就把用户原来开着的功能悄悄关掉）。消费方同样是 anima（它直接读这份 config）。
    retrieval: { url: '', model: '', key: '', rerankUrl: '', rerankModel: '', rerankKey: '', chatEnabled: true },
    // 提示词模板：null = 内置默认（见 templatesResponse）；字符串 = 用户自定义。
    // 只经 /templates 读写；老配置没有这段时 sanitizeConfig 会补齐。
    prompts: { compaction: null, placeholder: null, compactionJailbreak: null },
    // 保留第一轮问答（DeepSeek 思维模式专用）：默认关。RP 预设模块
    // preset-modules/keep-first-round.js 每轮渲染时读这里 ⇒ 改开关下一轮生效
    // （不重写预设、不新会话、不重启）。面板走既有 /config 投影，不开新端点。
    keepFirstRound: { enabled: false },
    // 记忆回响（D2）：本地 FTS5（trigram）预扫**归档原文** → 每轮把最相关的几楼塞进提示词。
    // 引擎在 ./echo-index.js（建表/入库/抽候选/查询）+ ./echo-inject.js（拼文本/工厂）；
    // **开关与预算都走这里**（面板走既有 /config 投影，不开新端点）。默认关；
    // 打开后不调任何副 API（纯本地 node:sqlite）。实测基线见
    // `03-调研与报告\实测-FTS5本地回响-20260915.md`（254 楼：建索引 32 ms、查 0.01 ms、回声命中 100%）。
    echo: { enabled: false, topK: 5, maxChars: 1200, minDf: 2, maxDf: 12 },
    // 「最近几楼」（mt:lastFloors @10202，2026-09-17 上线 / 2026-09-19 改触发条件）：**默认关**。
    // 打开后，只要**当前上下文少于 5000 字**，就把当前周目归档里最近的 count 楼原文注入成
    // <recentFloors>（排在 `mt:postHistory`@10203 之前 = **倒数第二**）—— 新周目开局才有可承接
    // 的上下文；上下文长过阈值就停（不与真历史打架）。
    // 判据见 last-floors.js 的 contextIsShort / decideInject；字数是 registerLastFloors 带外算的缓存。
    lastFloors: { enabled: false, count: 5, maxChars: 3000 },
    // 「剧情笔记」写入（memory_write，20260919 复活版）：**默认开** —— RP 预设回档到我们那份
    // （工具面里 read/glob/grep 全是只读）后，没有它就"让 agent 维护文档"这件事做不到。
    // ⛔ 落点固定为**本会话周目的** `<周目目录>/.roleplay-memory/`（会话优先、配置兜底），
    //   走插件自己的 node:fs（Tavern 会把 RP 沙箱钉成只读 ⇒ 走 ctx.fs 写不进去）。
    memoryWrite: { enabled: true, maxChars: 20000 },
    // 后处理提示词**作为玩家消息注入**（2026-09-20 用户拍板：**默认开**）：卡的
    // `post_history_instructions` 在 ST 里是"历史之后"，DSH 的 system 是整块 ⇒ 光摆到 system 末尾
    // 仍然离玩家那句话很远。这条走 `agent/pre-step` 的 decision.messages，落点就是**玩家消息之后**。
    // ⚠️ 代价（用户已知并接受「多就多吧」）：**进会话日志**（durable）、每轮一份、也进压缩摘要。
    //   实现与三处清洗见 lib/phi-message.js（① 查看器不当楼层 ② 归档不收录 ③ system 里那份不再重复）。
    phiAsMessage: { enabled: true },
    // 压缩后**自动收纳**（2026-09-15，用户拍板：轮末触发 / 只收当前绑定的「角色-周目」/ **默认开**
    // / 失败要播报）。机制：会话日志里出现 `compaction/summary` ⇒ 记下这个会话；该轮 `turn/end`
    // 时跑一次 `/collect/auto` 的内核（collect-scan.js 的 collectOnce）—— 台账按 contentHash 记账
    // ⇒ 幂等，重复触发无害。★ 只对**绑定周目的会话**生效（见 autoCollectSessionIds），
    // ⛔ 别的会话（例如你正在跟 AI 干活的编程会话）压了也不会写进角色档案。
    // 上一次运行的结果落 <storageDir>/auto-collect.json，面板与 GET /auto-collect 读它（失败必播报）。
    autoCollect: { enabled: true },
    /**
     * 手动「扫归档原文 → 总结」（2026-09-16）。
     * `rangeSize` = 每个总结区间覆盖多少楼（默认 20，与 anima 的 `trigger_interval` 同口径，
     * 254 楼 ⇒ 13 个区间）。指令与破限头**不在这里**：沿用 `prompts.compaction` /
     * `prompts.compactionJailbreak`，保证与压缩那条链是同一段文字。
     */
    summarize: { rangeSize: 20, maxTokens: 8192 },
    // v3 消费端（Tavern 外部组合 API，2026-09-16）：**默认关**。
    // 打开 = 我们注册一个 Cordis 组合器（owner 见下），会话被显式切成 `external` 后由**我们**产出
    // 命名 system 段，Tavern 默认 profile 正文不再产生。这是"换活法"（接管装配），不是修 bug：
    // 今天卡字段/世界书明细靠 `pmp-dsh-tavern:profile` + `/api/v1/traces` 已经够用。
    // ⚠️ 改这条要**重启宿主**才生效（注册发生在插件加载时）；/v3 端点的 composer.needsHostRestart 会如实说。
    v3: {
      composer: {
        enabled: false,
        owner: 'dsh-memory-archive',
        marker: true, // 产出一行 `[external-composition owner=… v=…]`，让"这段谁装的"在看请求原文时一眼可辨
        echoSuggestedCallConfig: false, // 上游那一问（推荐回传还是省略）未定前：保守不回传
      },
      // 角色卡「对话后指示」的末尾段（2026-09-16）：**默认关**。
      // 打开 = 在宿主面注册一段 order 10203 的 system 段，把卡里的 postHistoryInstructions 排到全文最后
      // （persona-suffix 10020/10200、rp:firstRound 10201、mt:lastFloors 10202 之后）。
      // 它只在 `external` 模式下有意义：那时组合器不产 post-history，否则同一段文字会出现两次
      // （composer 侧自动 omit 见 apply()）。
      // ⚠️ 同样是**加载时注册**：改 enabled 要重启宿主才生效。
      tail: {
        enabled: false,
        name: 'mt:postHistory', // 段名（宿主面唯一的同名段会遮蔽全局同名段）
        order: 10203, // > DEPLOYMENT_PERSONA_SUFFIX(10200) > rp:firstRound(10201) > mt:lastFloors(10202)
      },
    },
    /**
     * 自动压缩触发阈值（20260921）：面板让玩家以 **DSH 自带的那个上下文百分比**为单位选
     * 「到多少 % 自动压缩」。**默认开、默认 15%** —— 与预设 YAML 里那个 `thresholdRatio: 0.15`
     * 同一个数 ⇒ 装上就是原来那个行为（⛔ 默认值不许改变现网行为）。
     *
     * 两条作用路（写一次、两处都吃）：
     *   ① **正在玩的这一场**：预设里的压缩后端每轮现读本文件 ⇒ 改完下一轮就生效
     *      （实现：`lib/mt-compaction.js` 生成物里的 `compactIfNeeded` 覆写）；
     *   ② **新周目 / 新分叉**：`POST /compaction/config` 同时把 `thresholdPercent/100` 写进
     *      **部署的预设 YAML** 的 `thresholdRatio`（数出现次数 + 备份 + 回读校验，见 POST 注释）。
     *
     * ⚠️ 与「真正被比的那个数」不是一回事：判定用的是 `tokenMeter` 的 `totalTokens`（**含输出
     * token**），所以「到 X% 触发」是**近似**、实际略早；撞上上下文溢出还会绕过阈值直接压。
     *   ⇒ 面板两个数都显示（`percent` = DSH 那个 / `triggerPercent` = 判定那个），小字照实写。
     */
    autoCompact: { usePanelThreshold: true, thresholdPercent: 15 },
  }
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 面板阈值收成「5–90 的整数、步长 5」——**薄壳**，真逻辑在 ./compaction-threshold.js
 * （纯函数 + 自检台直测）。这里只处理"模块缺席"这一种降级：如实回落默认值并把原因写出来，
 * ⛔ 不在这里再抄一份夹紧规则（两份真相 = 迟早漂移）。
 */
function clampAutoCompactPercent(value) {
  if (compactionThreshold === null) {
    return {
      percent: AUTO_COMPACT_DEFAULT_PERCENT,
      clamped: true,
      reason: `阈值 ${JSON.stringify(value)} 没法夹紧（compaction-threshold 模块缺席${compactionThresholdLoadError ? '：' + (compactionThresholdLoadError.message || compactionThresholdLoadError) : ''}），已回落默认 ${AUTO_COMPACT_DEFAULT_PERCENT}%`,
    }
  }
  return compactionThreshold.clampThresholdPercent(value)
}

/** 面板阈值的默认百分比（模块缺席时的兜底；与那本模块的常量同值，自检台钉住不许漂）。 */
const AUTO_COMPACT_DEFAULT_PERCENT = 15

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
  // （20260918 撤侧路：旧的 `api.*` 面已整体删除 —— 面板不再有那张卡，也没有任何消费方。
  //   盘上若还留着 `api` 键，`sanitizeConfig` 直接忽略它，不报 issue、不再写回。）
  if (parsed.retrieval !== undefined) {
    if (isPlainObject(parsed.retrieval)) {
      for (const k of ['url', 'model', 'key', 'rerankUrl', 'rerankModel', 'rerankKey']) {
        const v = parsed.retrieval[k]
        if (v === undefined) continue
        if (typeof v === 'string') config.retrieval[k] = v
        else issues.push(`retrieval.${k} 不是字符串，已置空`)
      }
      // ⚠️ chatEnabled 是**布尔**，⛔ 不能塞进上面那个"只认字符串"的循环（会被置成空串）。
      //   漏了这一段的后果是**静默失效**：盘上写着 false，sanitize 却丢掉它 ⇒ readConfigFile()
      //   永远回默认 true ⇒ 开关永远关不掉，而且没有任何报错。
      if (parsed.retrieval.chatEnabled !== undefined) {
        const v = parsed.retrieval.chatEnabled
        if (typeof v === 'boolean') config.retrieval.chatEnabled = v
        else issues.push('retrieval.chatEnabled 不是布尔值，已回落 true')
      }
    } else issues.push('retrieval 不是对象，已回落默认值')
  }
  if (parsed.prompts !== undefined) {
    if (isPlainObject(parsed.prompts)) {
      // ★ compactionJailbreak（2026-09-16 用户口径）：破限头**不由我们内置**，默认 null（界面留空，
      //   玩家自填）；填了只在「应用（写进预设）」时拼在指令前面。⛔ 任何默认值里都不许出现破限文本。
      for (const k of ['compaction', 'placeholder', 'compactionJailbreak']) {
        const v = parsed.prompts[k]
        if (v === undefined || v === null) continue // null = 内置默认
        if (typeof v === 'string' && v !== '') config.prompts[k] = v
        else if (v !== '') issues.push(`prompts.${k} 不是字符串，已置 null`) // 空串 = 默认，静默归一
      }
    } else issues.push('prompts 不是对象，已回落默认值')
  }
  if (parsed.keepFirstRound !== undefined) {
    if (isPlainObject(parsed.keepFirstRound)) {
      const v = parsed.keepFirstRound.enabled
      if (v === undefined || v === null) { /* 缺省 = false，保持默认 */ }
      else if (typeof v === 'boolean') config.keepFirstRound.enabled = v
      else issues.push('keepFirstRound.enabled 不是布尔值，已回落 false')
    } else issues.push('keepFirstRound 不是对象，已回落默认值')
  }
  if (parsed.echo !== undefined) {
    if (isPlainObject(parsed.echo)) {
      const b = parsed.echo.enabled
      if (b === undefined || b === null) { /* 缺省 = false，保持默认 */ }
      else if (typeof b === 'boolean') config.echo.enabled = b
      else issues.push('echo.enabled 不是布尔值，已回落 false')
      for (const spec of ECHO_NUMBER_KEYS) {
        const v = parsed.echo[spec.key]
        if (v === undefined || v === null) continue
        if (typeof v === 'number' && Number.isFinite(v) && v >= spec.min && v <= spec.max) config.echo[spec.key] = Math.trunc(v)
        else issues.push(`echo.${spec.key} 必须是 ${spec.min}..${spec.max} 的数，已回落默认值`)
      }
    } else issues.push('echo 不是对象，已回落默认值')
  }
  if (parsed.lastFloors !== undefined) {
    if (isPlainObject(parsed.lastFloors)) {
      const b = parsed.lastFloors.enabled
      if (b === undefined || b === null) { /* 缺省 = false，保持默认 */ }
      else if (typeof b === 'boolean') config.lastFloors.enabled = b
      else issues.push('lastFloors.enabled 不是布尔值，已回落 false')
      for (const spec of LAST_FLOORS_NUMBER_KEYS) {
        const v = parsed.lastFloors[spec.key]
        if (v === undefined || v === null) continue
        if (typeof v === 'number' && Number.isFinite(v) && v >= spec.min && v <= spec.max) config.lastFloors[spec.key] = Math.trunc(v)
        else issues.push(`lastFloors.${spec.key} 必须是 ${spec.min}..${spec.max} 的数，已回落默认值`)
      }
    } else issues.push('lastFloors 不是对象，已回落默认值')
  }
  if (parsed.phiAsMessage !== undefined) {
    if (isPlainObject(parsed.phiAsMessage)) {
      const b = parsed.phiAsMessage.enabled
      if (b === undefined || b === null) { /* 缺省 = 默认（开） */ }
      else if (typeof b === 'boolean') config.phiAsMessage.enabled = b
      else issues.push('phiAsMessage.enabled 不是布尔值，已回落默认值')
    } else issues.push('phiAsMessage 不是对象，已回落默认值')
  }
  if (parsed.memoryWrite !== undefined) {
    if (isPlainObject(parsed.memoryWrite)) {
      const b = parsed.memoryWrite.enabled
      if (b === undefined || b === null) { /* 缺省 = 默认（开） */ }
      else if (typeof b === 'boolean') config.memoryWrite.enabled = b
      else issues.push('memoryWrite.enabled 不是布尔值，已回落默认值')
      const m = parsed.memoryWrite.maxChars
      if (m === undefined || m === null) { /* 缺省 */ }
      else if (typeof m === 'number' && Number.isFinite(m) && m >= 200 && m <= 200000) config.memoryWrite.maxChars = Math.trunc(m)
      else issues.push('memoryWrite.maxChars 必须是 200..200000 的数，已回落默认值')
    } else issues.push('memoryWrite 不是对象，已回落默认值')
  }
  if (parsed.autoCollect !== undefined) {
    if (isPlainObject(parsed.autoCollect)) {
      const v = parsed.autoCollect.enabled
      if (v === undefined || v === null) { /* 缺省 = true（用户拍板默认开），保持默认 */ }
      else if (typeof v === 'boolean') config.autoCollect.enabled = v
      else issues.push('autoCollect.enabled 不是布尔值，已回落 true')
    } else issues.push('autoCollect 不是对象，已回落默认值')
  }
  // 自动压缩触发阈值（20260921）：**⛔ 越界/非法一律不抛**（照本函数既有风格）——
  //   · usePanelThreshold 非布尔 ⇒ 回落默认（开）；
  //   · thresholdPercent 交给 clampThresholdPercent 收成 5–90/步长 5，**夹过就写进 issues**（如实回报）。
  //   ⚠️ 默认是**开**（true）⇒ 判据必须是 `!== false`：写成 `=== true` 会让"老配置里没这一段"
  //     变成关，从而悄悄回到预设原值 —— 那是"装了没生效"的静默失效。
  if (parsed.autoCompact !== undefined) {
    if (isPlainObject(parsed.autoCompact)) {
      const v = parsed.autoCompact.usePanelThreshold
      if (v === undefined || v === null) { /* 缺省 = true，保持默认 */ }
      else if (typeof v === 'boolean') config.autoCompact.usePanelThreshold = v
      else issues.push('autoCompact.usePanelThreshold 不是布尔值，已回落 true')
      const p = parsed.autoCompact.thresholdPercent
      if (p !== undefined && p !== null) {
        const got = clampAutoCompactPercent(p)
        config.autoCompact.thresholdPercent = got.percent
        if (got.clamped) issues.push('autoCompact.thresholdPercent ' + got.reason)
      }
    } else issues.push('autoCompact 不是对象，已回落默认值')
  }
  if (parsed.v3 !== undefined) {
    if (isPlainObject(parsed.v3)) {
      const c = isPlainObject(parsed.v3.composer) ? parsed.v3.composer : null
      if (c === null) {
        if (parsed.v3.composer !== undefined) issues.push('v3.composer 不是对象，已回落默认值')
      } else {
        for (const k of ['enabled', 'marker', 'echoSuggestedCallConfig']) {
          const v = c[k]
          if (v === undefined || v === null) continue
          if (typeof v === 'boolean') config.v3.composer[k] = v
          else issues.push(`v3.composer.${k} 不是布尔值，已回落默认值`)
        }
        if (c.owner !== undefined && c.owner !== null) {
          if (typeof c.owner === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(c.owner)) config.v3.composer.owner = c.owner
          else issues.push('v3.composer.owner 形状不合法（须匹配 ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$），已回落默认值')
        }
      }
      // 末尾段（宿主面 order 10203）。⛔ 这一段必须显式放行：readConfigFile() 返回的是
      // sanitize 之后的对象，不认的键会被**静默丢掉** —— 那样配置文件里写 enabled:true 也永远不生效。
      const t = isPlainObject(parsed.v3.tail) ? parsed.v3.tail : null
      if (t === null) {
        if (parsed.v3.tail !== undefined) issues.push('v3.tail 不是对象，已回落默认值')
      } else {
        if (t.enabled !== undefined && t.enabled !== null) {
          if (typeof t.enabled === 'boolean') config.v3.tail.enabled = t.enabled
          else issues.push('v3.tail.enabled 不是布尔值，已回落默认值')
        }
        if (t.name !== undefined && t.name !== null) {
          if (typeof t.name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(t.name)) config.v3.tail.name = t.name
          else issues.push('v3.tail.name 形状不合法（须匹配 ^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$），已回落默认值')
        }
        if (t.order !== undefined && t.order !== null) {
          if (typeof t.order === 'number' && Number.isFinite(t.order) && Math.abs(t.order) <= 1e6) config.v3.tail.order = Math.trunc(t.order)
          else issues.push('v3.tail.order 必须是 |order| ≤ 1000000 的有限数，已回落默认值')
        }
      }
    } else issues.push('v3 不是对象，已回落默认值')
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
  // （20260918：旧的 `patch.api.*` 面已删。老客户端若仍 PUT 这个键 ⇒ **明确拒**，
  //   免得"改了但没生效"这种静默失败 —— 面板早已换成 `retrieval`。）
  if (patch.api !== undefined) fail('"api" 已废弃（20260918 撤总结侧路）⇒ 请改用 "retrieval"')
  if (patch.retrieval !== undefined) {
    if (!isPlainObject(patch.retrieval)) fail('"retrieval" 必须是对象')
    if (patch.retrieval.url !== undefined) {
      if (patch.retrieval.url !== null && typeof patch.retrieval.url !== 'string') fail('"retrieval.url" 必须是字符串')
      const u = patch.retrieval.url ?? ''
      if (u !== '' && !/^https?:\/\//i.test(u)) fail('"retrieval.url" 必须以 http:// 或 https:// 开头')
      next.retrieval.url = u
    }
    if (patch.retrieval.model !== undefined) {
      if (patch.retrieval.model !== null && typeof patch.retrieval.model !== 'string') fail('"retrieval.model" 必须是字符串')
      next.retrieval.model = patch.retrieval.model ?? ''
    }
    if (patch.retrieval.rerankModel !== undefined) {
      if (patch.retrieval.rerankModel !== null && typeof patch.retrieval.rerankModel !== 'string') fail('"retrieval.rerankModel" 必须是字符串')
      next.retrieval.rerankModel = patch.retrieval.rerankModel ?? ''
    }
    if (patch.retrieval.key !== undefined) {
      if (typeof patch.retrieval.key !== 'string') fail('"retrieval.key" 必须是字符串')
      if (patch.retrieval.key === KEY_CLEAR) next.retrieval.key = ''
      else if (patch.retrieval.key !== '') next.retrieval.key = patch.retrieval.key // 空串 = 保留原有 key
    }
    // ★ 2026-09-20：重排那套自己的接口地址（baseURL）与密钥。两条规则与向量侧**逐条对齐**：
    //   rerankUrl 与 url 同判据（http/https 或空）；rerankKey 与 key 同判据（空串 = 保留原有、KEY_CLEAR = 清空）。
    if (patch.retrieval.rerankUrl !== undefined) {
      if (patch.retrieval.rerankUrl !== null && typeof patch.retrieval.rerankUrl !== 'string') fail('"retrieval.rerankUrl" 必须是字符串')
      const u = patch.retrieval.rerankUrl ?? ''
      if (u !== '' && !/^https?:\/\//i.test(u)) fail('"retrieval.rerankUrl" 必须以 http:// 或 https:// 开头')
      next.retrieval.rerankUrl = u
    }
    if (patch.retrieval.rerankKey !== undefined) {
      if (typeof patch.retrieval.rerankKey !== 'string') fail('"retrieval.rerankKey" 必须是字符串')
      if (patch.retrieval.rerankKey === KEY_CLEAR) next.retrieval.rerankKey = ''
      else if (patch.retrieval.rerankKey !== '') next.retrieval.rerankKey = patch.retrieval.rerankKey // 空串 = 保留原有 key
    }
    // 「参与检索」开关（2026-09-20）：「向量」页签那颗开关走 PUT /config 这条既有写路（读-改-写，
    // ⛔ 不整份覆盖 —— 那样会丢 retrieval.url/model/key 等所有别的字段）。
    if (patch.retrieval.chatEnabled !== undefined) {
      if (typeof patch.retrieval.chatEnabled !== 'boolean') fail('"retrieval.chatEnabled" 必须是布尔值')
      next.retrieval.chatEnabled = patch.retrieval.chatEnabled
    }
  }
  if (patch.keepFirstRound !== undefined) {
    if (!isPlainObject(patch.keepFirstRound)) fail('"keepFirstRound" 必须是对象')
    if (patch.keepFirstRound.enabled !== undefined) {
      if (typeof patch.keepFirstRound.enabled !== 'boolean') fail('"keepFirstRound.enabled" 必须是布尔值')
      next.keepFirstRound.enabled = patch.keepFirstRound.enabled
    }
  }
  if (patch.echo !== undefined) {
    if (!isPlainObject(patch.echo)) fail('"echo" 必须是对象')
    if (patch.echo.enabled !== undefined) {
      if (typeof patch.echo.enabled !== 'boolean') fail('"echo.enabled" 必须是布尔值')
      next.echo.enabled = patch.echo.enabled
    }
    for (const spec of ECHO_NUMBER_KEYS) {
      const v = patch.echo[spec.key]
      if (v === undefined) continue
      if (typeof v !== 'number' || !Number.isFinite(v) || v < spec.min || v > spec.max) {
        fail(`"echo.${spec.key}" 必须是 ${spec.min}..${spec.max} 的数`)
      }
      next.echo[spec.key] = Math.trunc(v)
    }
  }
  if (patch.lastFloors !== undefined) {
    if (!isPlainObject(patch.lastFloors)) fail('"lastFloors" 必须是对象')
    if (patch.lastFloors.enabled !== undefined) {
      if (typeof patch.lastFloors.enabled !== 'boolean') fail('"lastFloors.enabled" 必须是布尔值')
      next.lastFloors.enabled = patch.lastFloors.enabled
    }
    for (const spec of LAST_FLOORS_NUMBER_KEYS) {
      const v = patch.lastFloors[spec.key]
      if (v === undefined) continue
      if (typeof v !== 'number' || !Number.isFinite(v) || v < spec.min || v > spec.max) {
        fail(`"lastFloors.${spec.key}" 必须是 ${spec.min}..${spec.max} 的数`)
      }
      next.lastFloors[spec.key] = Math.trunc(v)
    }
  }
  if (patch.memoryWrite !== undefined) {
    if (!isPlainObject(patch.memoryWrite)) fail('"memoryWrite" 必须是对象')
    if (patch.memoryWrite.enabled !== undefined) {
      if (typeof patch.memoryWrite.enabled !== 'boolean') fail('"memoryWrite.enabled" 必须是布尔值')
      next.memoryWrite.enabled = patch.memoryWrite.enabled
    }
    if (patch.memoryWrite.maxChars !== undefined) {
      const m = patch.memoryWrite.maxChars
      if (typeof m !== 'number' || !Number.isFinite(m) || m < 200 || m > 200000) fail('"memoryWrite.maxChars" 必须是 200..200000 的数')
      next.memoryWrite.maxChars = Math.trunc(m)
    }
  }
  if (patch.autoCollect !== undefined) {
    if (!isPlainObject(patch.autoCollect)) fail('"autoCollect" 必须是对象')
    if (patch.autoCollect.enabled !== undefined) {
      if (typeof patch.autoCollect.enabled !== 'boolean') fail('"autoCollect.enabled" 必须是布尔值')
      next.autoCollect.enabled = patch.autoCollect.enabled
    }
  }
  // 自动压缩触发阈值（20260921）：与 echo/lastFloors 那几段**故意不同**的一条 ——
  //   thresholdPercent 走"**夹紧但不抛**"（面板滑块本来只会给 5–90/步长 5；越界了如实夹到边界，
  //   由调用方把夹紧后的值回显给用户），理由：这条是"旋钮"不是"契约"，抛 400 只会让人以为坏了。
  //   ⛔ 类型错（不是数）仍然 fail（与全文件同一口径：类型错是调用方写错了，不是越界）。
  //   ⚠️ usePanelThreshold 默认 **true** ⇒ 判据用 `!== false` 那套的等价写法（显式真值才写真）。
  if (patch.autoCompact !== undefined) {
    if (!isPlainObject(patch.autoCompact)) fail('"autoCompact" 必须是对象')
    if (patch.autoCompact.usePanelThreshold !== undefined) {
      if (typeof patch.autoCompact.usePanelThreshold !== 'boolean') fail('"autoCompact.usePanelThreshold" 必须是布尔值')
      next.autoCompact.usePanelThreshold = patch.autoCompact.usePanelThreshold
    }
    if (patch.autoCompact.thresholdPercent !== undefined && patch.autoCompact.thresholdPercent !== null) {
      const raw = patch.autoCompact.thresholdPercent
      if (typeof raw !== 'number' || !Number.isFinite(raw)) fail('"autoCompact.thresholdPercent" 必须是数字')
      next.autoCompact.thresholdPercent = clampAutoCompactPercent(raw).percent
    }
  }
  if (patch.v3 !== undefined) {
    if (!isPlainObject(patch.v3)) fail('"v3" 必须是对象')
    const c = patch.v3.composer
    if (c !== undefined) {
      if (!isPlainObject(c)) fail('"v3.composer" 必须是对象')
      for (const k of ['enabled', 'marker', 'echoSuggestedCallConfig']) {
        if (c[k] === undefined) continue
        if (typeof c[k] !== 'boolean') fail(`"v3.composer.${k}" 必须是布尔值`)
        next.v3.composer[k] = c[k]
      }
      if (c.owner !== undefined) {
        if (typeof c.owner !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(c.owner)) {
          fail('"v3.composer.owner" 必须是 ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$ 形状（它进最终段名）')
        }
        next.v3.composer.owner = c.owner
      }
    }
    const t = patch.v3.tail
    if (t !== undefined) {
      if (!isPlainObject(t)) fail('"v3.tail" 必须是对象')
      if (t.enabled !== undefined) {
        if (typeof t.enabled !== 'boolean') fail('"v3.tail.enabled" 必须是布尔值')
        next.v3.tail.enabled = t.enabled
      }
      if (t.name !== undefined) {
        if (typeof t.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(t.name)) {
          fail('"v3.tail.name" 必须是 ^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$ 形状（它进段名）')
        }
        next.v3.tail.name = t.name
      }
      if (t.order !== undefined) {
        if (typeof t.order !== 'number' || !Number.isFinite(t.order) || Math.abs(t.order) > 1e6) {
          fail('"v3.tail.order" 必须是 |order| ≤ 1000000 的有限数')
        }
        next.v3.tail.order = Math.trunc(t.order)
      }
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

/** GET/PUT /config 的统一响应（绝不回显 retrieval.key 原文）。 */
function publicConfig(config, configError) {
  return {
    ok: true,
    rootMode: config.rootMode,
    // 根回显（20260914 M6）：原样回显已配置的 root；没配置（含全 null 字段的默认态）⇒ null
    // —— ⛔ 不编空串、不编默认路径。之前不回 ⇒ 面板保存根后下拉弹回占位项，
    // 头部也没法提示「当前根已归档」（M6 的两件事都卡在这一个字段上）。
    root: hasConfiguredRoot(config.root) ? config.root : null,
    // （20260918：旧的 `api` / 顶层 `keySet` / `keyHint` 已删 —— 那套是总结侧路的渠道设置。
    //   现在**只有** `retrieval.*` 一组密钥面，⛔ 别再出两组 keySet/keyHint 让人分不清谁是谁。）
    // 向量检索（20260918；20260920 拆成两套三件套）：⛔ 只出两组 url/model + 两组 keySet/keyHint，
    // 绝不出 retrieval.key / retrieval.rerankKey 原文。
    // ★ 2026-09-20：`rerankKeyInherited` = 重排**没有**自己的密钥、正在沿用向量那把
    //   —— 面板要能如实说「未单独设置，用向量模型那把」，⛔ 不许把它显示成"已单独保存"。
    retrieval: {
      url: config.retrieval?.url ?? '',
      model: config.retrieval?.model ?? '',
      rerankUrl: config.retrieval?.rerankUrl ?? '',
      rerankModel: config.retrieval?.rerankModel ?? '',
      keySet: Boolean(config.retrieval?.key),
      keyHint: keyHint(config.retrieval?.key),
      rerankKeySet: Boolean(config.retrieval?.rerankKey || config.retrieval?.key),
      rerankKeyHint: keyHint(config.retrieval?.rerankKey || config.retrieval?.key),
      rerankKeyInherited: !config.retrieval?.rerankKey && Boolean(config.retrieval?.key),
      // 「参与检索」开关（2026-09-20）：「向量」页签用它的初始态；缺省 **true**（与 defaultConfig 同口径
      // —— 老配置文件里没有这一项时，面板要如实显示"开着"，⛔ 不能显示成关着）。
      chatEnabled: config.retrieval?.chatEnabled !== false,
    },
    // 保留第一轮问答开关（默认关）：GET/PUT 都走既有 /config 投影，面板不开新管道。
    keepFirstRound: { enabled: config.keepFirstRound?.enabled === true },
    // 记忆回响开关与预算（默认关）：同样走既有 /config 投影。
    echo: {
      enabled: config.echo?.enabled === true,
      topK: config.echo?.topK ?? 5,
      maxChars: config.echo?.maxChars ?? 1200,
      minDf: config.echo?.minDf ?? 2,
      maxDf: config.echo?.maxDf ?? 12,
    },
    // 「最近几楼」开关与预算（默认关）：同样走既有 /config 投影，面板不开新管道。
    lastFloors: {
      enabled: config.lastFloors?.enabled === true,
      count: config.lastFloors?.count ?? 5,
      maxChars: config.lastFloors?.maxChars ?? 3000,
    },
    // 后处理提示词「作为玩家消息注入」（默认**开**，2026-09-20）：只投影开关。
    phiAsMessage: {
      enabled: config.phiAsMessage?.enabled !== false,
    },
    // 「剧情笔记」写入（默认开）：只投影开关与预算，⛔ 不投影任何路径（落点由会话/绑定算）。
    memoryWrite: {
      enabled: config.memoryWrite?.enabled !== false,
      maxChars: config.memoryWrite?.maxChars ?? 20000,
    },
    storageDir: storageDir(),
    configPath: configPath(),
    configError: configError ?? null,
    // 自动收纳开关（默认开）+ 上一次运行结果（失败播报用；⛔ 只含计数/路径/code，不含正文）
    autoCollect: { enabled: config.autoCollect?.enabled !== false, last: readAutoCollectStatus() },
    // 自动压缩触发阈值（20260921，默认**开** + 15%）：面板「压缩」档的开关与滑块初值。
    // ★ 与 autoCollect/phiAsMessage 同口径：默认开 ⇒ 判据必须是 `!== false`（老配置文件里没有这一段时
    //   要如实显示"开着"，⛔ 不能显示成关着 —— 那会让人以为功能没生效）。
    // ⛔ 这里不投影任何"当前占用率"：那是本会话的实时数，只在 GET /compaction/state 里给。
    autoCompact: {
      usePanelThreshold: config.autoCompact?.usePanelThreshold !== false,
      thresholdPercent: config.autoCompact?.thresholdPercent ?? AUTO_COMPACT_DEFAULT_PERCENT,
    },
    // v3 消费端（默认关）：面板要能看见"我们是不是接管了装配"，也要能改 owner/标记这两个旋钮。
    // ⚠️ 改 enabled 需重启宿主（注册在插件加载时）—— /v3 投影里另给 needsHostRestart。
    v3: {
      composer: {
        enabled: config.v3?.composer?.enabled === true,
        owner: config.v3?.composer?.owner ?? V3_DEFAULT_OWNER,
        marker: config.v3?.composer?.marker !== false,
        echoSuggestedCallConfig: config.v3?.composer?.echoSuggestedCallConfig === true,
      },
      // ★ 2026-09-19：原来的 `tail`（末尾段）配置项已删 —— 尾段退役，卡字段位置改由
      //   `lib/tavern-field-plan.js` 的摆位表决定（PHI 摆到全文最后）。这里只剩组合器那两个旋钮。
      parts: {
        // 摆位表是**代码里的常量**（PHI 10203 / 开场白 10150…），不给用户旋钮：
        // 位置一旦可配，"这条指令到底排哪儿"就又变成一处会漂的真相。
        planLoaded: tavernFieldPlan !== null,
        planVersion: tavernFieldPlan ? tavernFieldPlan.TAVERN_FIELD_PLAN_VERSION : null,
      },
    },
  }
}

/** 「配置了根」= 至少一个字段是非空字符串（load/PUT 都会把 root 归一成三字段对象）。 */
function hasConfiguredRoot(root) {
  if (!isPlainObject(root)) return false
  return ['sessionId', 'characterId', 'playthroughId'].some((k) => typeof root[k] === 'string' && root[k] !== '')
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

/** 配置里所有密钥原文（现在只有 `retrieval.key`；redactor 与响应体擦除共用这一份清单）。 */
function secretKeysOf(config) {
  const cfg = config && typeof config === 'object' ? config : {}
  return [cfg.retrieval && cfg.retrieval.key].filter((k) => typeof k === 'string' && k !== '')
}

/** 错误信息出境前把配置中的 key 原文抹掉（双保险，正常路径本就不含 key）。 */
function makeRedactor() {
  return (text) => {
    let s = String(text ?? '')
    try {
      for (const k of secretKeysOf(readConfigFile().config)) s = s.split(k).join('***')
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

/**
 * 用**宿主自己的**持久化服务读一次整条日志；拿不到实例/方法/形状不对 ⇒ null（⛔ 不假装成功）。
 *
 * 为什么不能自己造一个 persistence 栈：查看器原先是「按 `<DSH_HOME>/runtime` 里的包名 require
 * 一份 persistence，再建一个私有 cordis app」——那份包是 **0.1.2-rc.1**，只认
 * `session.jsonl.zstd`。宿主换到 v3 日志后，这条私有栈就成了**唯一读不到新数据的路**：
 * v3-only 会话报 `session "…" not found`，带旧文件的会话读到迁移前的冻结快照。
 * ⇒ 现在优先用宿主进程里那个实例（就是写日志的同一个版本）。
 *
 * @param {object} ctx - 宿主上下文
 * @param {string} sessionId - 会话 id
 * @returns {Promise<{events:any[],session:any,via:string}|null>}
 */
async function readLogViaPersistence(ctx, sessionId) {
  const persistence = getService(ctx, 'sessionPersistence') ?? ctx?.sessionPersistence ?? null
  if (!persistence) return null
  if (typeof persistence.open === 'function') {
    const handle = await persistence.open(sessionId, 'read')
    try {
      const slice = await handle.read()
      const events = Array.isArray(slice?.events) ? slice.events : []
      if (events.length === 0) return null
      return { events, session: handle.header ?? null, via: 'persistence-open' }
    } finally {
      try { await handle.close() } catch {}
    }
  }
  if (typeof persistence.load === 'function') { // 旧宿主（0.1.2）的服务面
    const loaded = await persistence.load(sessionId)
    const events = Array.isArray(loaded?.events) ? loaded.events : []
    if (events.length === 0) return null
    return { events, session: loaded.meta ?? loaded.session ?? null, via: 'persistence-load' }
  }
  return null
}

/**
 * 查看器用的宿主侧读取器：把 loadSessionLog 的完整退路链（活注册表 → 宿主持久化 → sessionQuery）
 * 包成一个 `(sessionId) => { meta, events }`，交给 prompt-viewer 注入。
 *
 * 契约：读不出来就**抛**（查看器把你看到的原话报给用户），⛔ 绝不返回空数组冒充「这会话没内容」。
 * @param {object} ctx - 宿主上下文
 * @returns {(sessionId:string)=>Promise<{meta:any,events:any[]}>}
 */
export function createHostSessionReader(ctx) {
  return async function readLog(sessionId) {
    const sq = getService(ctx, 'sessionQuery')
    if ((!sq || typeof sq.readSession !== 'function') && typeof ctx?.sessionPersistence?.open !== 'function') {
      throw new Error('宿主未挂载 sessionQuery 与 sessionPersistence，读不到会话日志')
    }
    const log = await loadSessionLog(ctx, sq, sessionId)
    return { meta: log.session ?? null, events: log.events }
  }
}

/**
 * 公共会话日志读取助手（20260915）：先试宿主 session 注册表里的活会话，再试宿主持久化服务，
 * 最后退回 sessionQuery.readSession；全都失败就抛（调用方维持既有 500 + SESSION_READ_FAILED 降级）。
 *
 * 为什么不再直接用 readSession：上游 readSession 走 Session.create 的 snapshot 模式，
 * seeded 会话只要有自己的事件（inheritedEventCount ≠ 事件总数）就必抛——
 *   deepseek-harness packages/session-query/session-query/src/index.ts:183-196（readSession → snapshot 模式）
 *   deepseek-harness packages/core/session/src/index.ts:599-600（seed must equal its inherited prefix 校验）
 * 实测本机 69 个会话里 24 个 seeded（fork 出来的周目）全部 500。而同一宿主里
 * session-query/src/corpus.ts:297-303 的 snapshotLive() 证明 ctx.sessions.get(id).snapshotEvents()
 * 这条路不做该校验、且给的是带 data 的完整 SessionEvent[] ⇒ 活注册表优先，readSession 只当退路。
 *
 * 契约：
 *   ① ctx.sessions.get(sessionId) 的 snapshotEvents() 给出**非空**数组 ⇒
 *      { events, session: live.header, via: 'live' }。
 *      ctx.sessions 可能不存在（旧宿主）⇒ 只探测不抛，直接走②；snapshotEvents() 给空数组
 *      也算没命中（⛔ 不把空当成功）。
 *   ② 否则走**宿主自己的持久化服务**（版本无关，只看方法在不在）：
 *      0.1.5+ 用 `open(id,'read')` 拿读句柄 → `handle.read()`；0.1.2 用 `load(id)`。
 *      ★ 2026-09-15 真机 bug 的修法：日志格式迁到 **v3**（`session.v3.jsonl.zstd`）后，
 *      旧 runtime 那份 persistence 只认 `session.jsonl.zstd` ⇒ v3-only 的会话整个读不到
 *      （报 `session "…" not found`），带旧文件的会话只能读到**迁移前的冻结快照**。
 *      读句柄不抢写所有权（上游 handle.ts 明确：read 可在别的写句柄持有时打开）。
 *   ③ 再退到 sessionQuery 的同名读取方法（只吃一个参数、返回全量事件），events 沿用
 *      extractEvents 的抽取口径 ⇒ { events, session: snapshot.session, via: 'readSession' }。
 *   ④ 全都失败 ⇒ 抛出（message 保留原始失败原因）。⛔ 绝不返回空数组冒充成功、⛔ 绝不编造内容。
 */
export async function loadSessionLog(ctx, sq, sessionId) {
  try {
    const registry = ctx?.sessions
    if (registry && typeof registry.get === 'function') {
      const live = registry.get(sessionId)
      if (live && typeof live.snapshotEvents === 'function') {
        const events = live.snapshotEvents()
        if (Array.isArray(events) && events.length > 0) {
          return { events, session: live.header, via: 'live' }
        }
      }
    }
  } catch {} // 活注册表这条路上任何意外都只当"没命中"，继续往下退
  try {
    const viaPersistence = await readLogViaPersistence(ctx, sessionId)
    if (viaPersistence !== null) return viaPersistence
  } catch {} // 打不开/不存在都只当"没命中"，退路与旧版一致（最终仍抛真原因）
  const snapshot = await sq.readSession(sessionId)
  const extracted = extractEvents(snapshot)
  if (!extracted) {
    throw new Error('会话日志读取失败：readSession 返回了无法识别的数据形状')
  }
  return {
    events: extracted.events,
    session: snapshot?.session,
    via: 'readSession',
  }
}

/**
 * ★★ 2026-09-22：归档侧（A2 `lib/collect-scan.js`）的**原始事件装载器**注入面 ——
 * 把 `loadSessionLog` 包成 `(sessionId) => Promise<{events, …}>`，由两条路由分派行
 * （`/collect/scan`·`/collect/auto`）与压缩后自动收纳钩子传进内核。
 *
 * 为什么归档不再用 `collectSurfaces`：那条便宜路径给的是宿主的事件**检索文档**
 * （`{sessionId,seq,type,time,surface,text}`，见 session-query 的 `buildSessionEventSearchDocuments`），
 * **结构上没有 `data`** ⇒ ① 压缩事件的 `shadowedSeqs` / `summary` 永远取不到（模型摘要恒回落
 * 机械条目）；② `source.kind` 恒 null ⇒ 插件注入守卫永不触发（两者都是真机实测的病）。
 * `loadSessionLog` 给的是**完整 SessionEvent[]**（活注册表 → 宿主持久化 → readSession 退路，
 * 正是本文件头注第 33–38 行那条口径）⇒ 压缩替换事件与消息正文都在。
 * ⛔ `collectSurfaces` 本身不动：它还有两个别的消费者（最近几楼 / 未被遮蔽字数）。
 *
 * 拿不出 sq 时**抛**（照 `collectOnce` 里那道 SESSION_QUERY_UNAVAILABLE 的口径，⛔ 不返回空数组
 * 冒充"这会话没内容"——那会让归档静默漏收）。
 */
export function createRawEventLoader(ctx) {
  return async (sessionId) => {
    const sq = getService(ctx, 'sessionQuery')
    if (!sq) throw new Error('宿主未挂载 sessionQuery')
    return loadSessionLog(ctx, sq, sessionId)
  }
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

/**
 * 从 filterEvents/listEvents 的 document 里取 `source.kind`（三种形状都认；取不到 ⇒ null，⛔ 不猜）。
 * 用途：归档侧把**插件注入的 user 消息**排除在"楼"之外（2026-09-20 清洗②）。
 */
function sourceKindOf(raw) {
  if (!isPlainObject(raw)) return null
  const cands = [
    isPlainObject(raw.source) ? raw.source.kind : undefined,
    isPlainObject(raw.data) && isPlainObject(raw.data.source) ? raw.data.source.kind : undefined,
    isPlainObject(raw.message) && isPlainObject(raw.message.source) ? raw.message.source.kind : undefined,
  ]
  for (const c of cands) if (typeof c === 'string') return c
  return null
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
      reread.config.rootMode !== next.rootMode
    ) {
      return send(500, err('CONFIG_WRITE_UNVERIFIED', '写盘后回读校验不一致'))
    }
    if (
      reread.config.retrieval?.url !== next.retrieval?.url ||
      reread.config.retrieval?.model !== next.retrieval?.model ||
      reread.config.retrieval?.rerankUrl !== next.retrieval?.rerankUrl ||
      reread.config.retrieval?.rerankModel !== next.retrieval?.rerankModel
    ) {
      return send(500, err('CONFIG_WRITE_UNVERIFIED', '写盘后回读校验不一致（retrieval）'))
    }
    // ⚠️ chatEnabled 默认 **true** ⇒ 回读比较的兜底值也必须是 true（写 false 时缺省就永远对不上）
    if ((reread.config.retrieval?.chatEnabled ?? true) !== (next.retrieval?.chatEnabled ?? true)) {
      return send(500, err('CONFIG_WRITE_UNVERIFIED', '写盘后回读校验不一致（retrieval.chatEnabled）'))
    }
    if ((reread.config.keepFirstRound?.enabled ?? false) !== (next.keepFirstRound?.enabled ?? false)) {
      return send(500, err('CONFIG_WRITE_UNVERIFIED', '写盘后回读校验不一致（keepFirstRound.enabled）'))
    }
    if ((reread.config.echo?.enabled ?? false) !== (next.echo?.enabled ?? false)) {
      return send(500, err('CONFIG_WRITE_UNVERIFIED', '写盘后回读校验不一致（echo.enabled）'))
    }
    // ⚠ autoCollect 默认是 **true** ⇒ 回读比较的兜底值也必须是 true（写 false 缺省就永远对不上）
    if ((reread.config.autoCollect?.enabled ?? true) !== (next.autoCollect?.enabled ?? true)) {
      return send(500, err('CONFIG_WRITE_UNVERIFIED', '写盘后回读校验不一致（autoCollect.enabled）'))
    }
    // ⚠ autoCompact.usePanelThreshold 默认也是 **true**（20260921）⇒ 同款兜底值。
    //   少了这一条，把开关从"开"改成"关"时会静默对不上（或更糟：写进去了却没人校验）。
    if ((reread.config.autoCompact?.usePanelThreshold ?? true) !== (next.autoCompact?.usePanelThreshold ?? true)
      || (reread.config.autoCompact?.thresholdPercent ?? AUTO_COMPACT_DEFAULT_PERCENT)
        !== (next.autoCompact?.thresholdPercent ?? AUTO_COMPACT_DEFAULT_PERCENT)) {
      return send(500, err('CONFIG_WRITE_UNVERIFIED', '写盘后回读校验不一致（autoCompact）'))
    }
    return send(200, publicConfig(reread.config, reread.configError))
  } catch (e) {
    if (e && e.code === 'CONFIG_INVALID') return send(400, err('CONFIG_INVALID', redact(e.message)))
    throw e
  }
}

/** 一次最小 embeddings 请求 ⇒ **纯结果对象**（⛔ 不抛、不发响应，好让两个模型各跑各的）。
 *  形状：`{ ready, ok, endpoint, httpStatus?, elapsedMs, dims?, code?, message? }`。
 *  `ready:false` = 配置不全，**没发请求**（⛔ 不许拿空 key 打端点）。 */
async function probeEmbeddingEndpoint(url, model, key, redact) {
  const endpoint = url.replace(/\/+$/, '') + '/embeddings'
  const started = Date.now()
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, input: 'ping' }), // 最小请求：一个词
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    })
    const elapsedMs = Date.now() - started
    if (!resp.ok) {
      // 测不通是预期结果，不是服务器错误：照 Tavern 约定用 HTTP 200 + ok:false（见调用方）
      let detail = ''
      try {
        detail = (await resp.text()).slice(0, 200)
      } catch {}
      return {
        ready: true, ok: false, endpoint, httpStatus: resp.status, elapsedMs,
        code: 'API_ERROR', message: `向量端点返回 HTTP ${resp.status}${detail ? '：' + redact(detail) : ''}`,
      }
    }
    let dims = null
    try {
      const data = await resp.json()
      const v = isPlainObject(data) && Array.isArray(data.data) && isPlainObject(data.data[0]) ? data.data[0].embedding : undefined
      if (Array.isArray(v)) dims = v.length
    } catch {}
    return { ready: true, ok: true, endpoint, httpStatus: resp.status, elapsedMs, dims }
  } catch (e) {
    const elapsedMs = Date.now() - started
    const timedOut =
      e?.name === 'TimeoutError' || e?.name === 'AbortError' || /timed?\s*out/i.test(e?.message || '')
    return {
      ready: true, ok: false, endpoint, elapsedMs,
      code: timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
      message: timedOut ? `向量端点在 ${Math.round(TEST_TIMEOUT_MS / 1000)} 秒内没有响应` : redact(e?.message || String(e)),
    }
  }
}

/** 一次最小 rerank 请求 ⇒ 纯结果对象（同上）。请求形状**逐字对齐** anima 的 `fetchRerank`
 *  （`engine.js:375-387`：POST、`{model, query, documents}`、Bearer）—— 测的必须就是线上那条路，
 *  ⛔ 不是另编一个"看起来差不多"的请求（那测通了也不代表检索能重排）。 */
async function probeRerankEndpoint(url, model, key, redact) {
  // 重排端点 = baseURL + '/rerank'（与 anima 的推导同一口径）。粘贴的**已经是完整 `…/rerank`** 时
  // 不再拼 —— 拼两次会得到 `…/rerank/rerank`，那会变成"重排永远不通"且最难查的一类静默失败。
  const base = url.replace(/\/+$/, '')
  const endpoint = /\/rerank$/i.test(base) ? base : base + '/rerank'
  const started = Date.now()
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, query: 'ping', documents: ['ping'] }), // 最小请求：一问一答
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    })
    const elapsedMs = Date.now() - started
    if (!resp.ok) {
      let detail = ''
      try {
        detail = (await resp.text()).slice(0, 200)
      } catch {}
      return {
        ready: true, ok: false, endpoint, httpStatus: resp.status, elapsedMs,
        code: 'API_ERROR', message: `重排端点返回 HTTP ${resp.status}${detail ? '：' + redact(detail) : ''}`,
      }
    }
    let results = null
    try {
      const data = await resp.json()
      if (isPlainObject(data) && Array.isArray(data.results)) results = data.results.length
    } catch {}
    return { ready: true, ok: true, endpoint, httpStatus: resp.status, elapsedMs, results }
  } catch (e) {
    const elapsedMs = Date.now() - started
    const timedOut =
      e?.name === 'TimeoutError' || e?.name === 'AbortError' || /timed?\s*out/i.test(e?.message || '')
    return {
      ready: true, ok: false, endpoint, elapsedMs,
      code: timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
      message: timedOut ? `重排端点在 ${Math.round(TEST_TIMEOUT_MS / 1000)} 秒内没有响应` : redact(e?.message || String(e)),
    }
  }
}

/** POST /retrieval/test（20260918；★ 20260920 起**两个模型各测一次**）。
 *  为什么改成两个：卡上现在有两套「接口地址」（向量 / 重排），一个按钮只说"测试成功"却只覆盖了
 *  向量那一半 —— 那就是**静默失败**（重排地址填错也照样报成功）。两个都测、**分别如实各报一行**。
 *
 *  重排的兜底与 anima 的 `applyRetrievalConfig` **同一口径**：`rerankUrl` 空 ⇒ 沿用 `url`；
 *  `rerankKey` 空 ⇒ 沿用 `key`（⇒ 老配置的测试结果与改版前一致）。
 *
 *  返回：两个都通 ⇒ 200 `{ok:true, message, embedding, rerank}`；
 *        有失败   ⇒ 200 `{ok:false, error:{code,message}, embedding, rerank}`（code 取**第一个**失败那个）；
 *        两个都没配全 ⇒ 400 `CONFIG_INCOMPLETE`（没有任何可测的东西，⛔ 不发请求）。
 *  密钥只进请求头，响应里绝不回显。
 *  ⛔ 只测本配置里填的值：环境变量兜底只在 anima 侧生效，这里不读环境变量（口径见「向量检索 API」卡）。 */
async function handleTestRetrieval(send, redact) {
  const { config } = readConfigFile()
  const r = config.retrieval || {}
  const embUrl = r.url || ''
  const embModel = r.model || ''
  const embKey = r.key || ''
  const rrUrl = r.rerankUrl || embUrl
  const rrModel = r.rerankModel || ''
  const rrKey = r.rerankKey || embKey
  const embMissing = []
  if (embUrl === '') embMissing.push('接口地址')
  if (embModel === '') embMissing.push('模型名')
  if (embKey === '') embMissing.push('密钥')
  const rrMissing = []
  if (rrUrl === '') rrMissing.push('接口地址')
  if (rrModel === '') rrMissing.push('模型名')
  if (rrKey === '') rrMissing.push('密钥')
  if (embMissing.length > 0 && rrMissing.length > 0) {
    return send(400, err('CONFIG_INCOMPLETE',
      `两个模型都还没配全（向量模型缺${embMissing.join('、')}；重排模型缺${rrMissing.join('、')}）`
      + '。请先在「向量检索 API」卡里补全（环境变量兜底只在 anima 侧生效，本测试只测这里的配置）'))
  }
  const embedding = embMissing.length > 0
    ? { ready: false, ok: false, code: 'CONFIG_INCOMPLETE', message: '向量模型缺' + embMissing.join('、') }
    : await probeEmbeddingEndpoint(embUrl, embModel, embKey, redact)
  const rerank = rrMissing.length > 0
    ? { ready: false, ok: false, code: 'CONFIG_INCOMPLETE', message: '重排模型缺' + rrMissing.join('、') }
    : await probeRerankEndpoint(rrUrl, rrModel, rrKey, redact)
  const lineOf = (label, x, extra) => x.ok
    ? label + '通（HTTP ' + x.httpStatus + ' · ' + x.elapsedMs + 'ms' + extra + '）'
    : label + '不通：' + x.message
  const summary = lineOf('向量模型', embedding, typeof embedding.dims === 'number' ? ' · 维度 ' + embedding.dims : '')
    + ' · ' + lineOf('重排模型', rerank, typeof rerank.results === 'number' ? ' · 返回 ' + rerank.results + ' 条' : '')
  if (embedding.ok === true && rerank.ok === true) {
    return send(200, { ok: true, message: summary, embedding: embedding, rerank: rerank })
  }
  const firstFail = embedding.ok === true ? rerank : embedding
  return send(200, Object.assign(err(firstFail.code || 'API_ERROR', summary), { embedding: embedding, rerank: rerank }))
}

// ---------------------------------------------------------------------------
// 提示词模板（GET/PUT /templates；存配置可选段 prompts，只经这两个端点读写，
// /config 的既有契约不变）
// ---------------------------------------------------------------------------

/** 内置中文 RP 归档指令（规格 §3.4，逐字照抄，勿改一字）。 */
const BUILTIN_COMPACTION_ZH = `# Summarization Guidelines
Target: Create a high-density NARRATIVE CHRONICLE of the Macro Plot. Consolidate interactions into coherent storylines while explicitly preserving specific entities as memory anchors.

## MACRO Plot Progression
- Reference <basic_info> & <previous_summary> for context.
- Comprehensively scan <new_text_to_summarize>. Identify the core narrative arcs (Who/What/Where/Result).

## Segmentation Strategy
0. Aggressive Merging: Prioritize continuity. Group continuous interactions into ONE segment unless a hard trigger is met.
1. Minimum Density: A segment MUST contain a full plot loop (Action -> Reaction -> Result). NEVER split for brief reactions.
2. Split Triggers ONLY when:
- Sustained Vibe Shift: Split ONLY if the atmosphere flips AND STAYS changed for the rest of the scene. Ignore transient spikes.
  - Merge: a joke during a serious meeting
  - Split: [Daily] -> Explosion -> [Action]
- Narrative Break: Significant change in Location/Time. Ignore natural time passing during continuous dialogue (e.g., Midnight -> Dawn without a "fade to black" break)

## Writing Logic
Structure: [Time Prefix]: [Content]
1. Time Prefix: Combine Date (if found) with General Time Block (e.g., "2025/12/11 深夜", "永和九年 子时", "初夏某日 下午"). DO NOT split minute-by-minute.
2. Anchors
- Preserve specific appointment times/locations (e.g., "晚上9点见", NOT "晚上见")
- Unique & Interactive Proper Nouns (e.g., "在Mellow甜品店吃柠檬巴菲", NOT "吃甜品" )
3. Dialogue:
  - Key: Quote directly (Max 1-2 line). Triggered by plot-critical reveals, confessions, threats, promises, or declarations.
  - Casual: Summarize intent (e.g., Sam抱怨了冬天的寒冷)

## Style
- Perspective: Third-person.
- Objectivity: State facts directly. DO NOT evade/censor sensitive/NSFW content, record what exactly happens.
- Show, Don't Tell: Record the evidence. NO abstract conclusion.
  - Bad: 他们的关系更亲密了
  - Good: Sam第一次主动握住了Sofia的手

# Tagging Rules (PER Segment)

### Vibe Tag (Select ONE dominant)
- [Daily] (Routine, relax, casual)
- [Wholesome] (Comfort, sweet, peace)
- [Comedy] (Funny, absurd)
- [Conflict] (Arguments, hostility, misunderstandings, jealousy, cold wars. NOT playful teasing.)
- [Action] (Combat, adventure, danger)
- [Angst] (Pain, tragedy, trauma)
- [Suspense] (Fear, mystery, tension)
- [Romantic] (Heart-focused, intimacy, flirting, love)
- [Sexual] (Body-focused, lust)
- [Serious] (Work, deep logic, lore-dump)

### Special Tags (OPTIONAL Array)
ONLY include if the segment occurs during the event OR contains related content (conversations/items/symptoms)
- Events: [Halloween], [Christmas], [Birthday], [Anniversary], [NewYear], [Valentine], [Travel]
- Health:
  - [Period] (Explicit mentions OR implied cues like cramps, hot water bottles)
  - [Sick] (Physical illness, weakness or injury)
- If none apply, output an empty list [].

## Important Tag (Boolean)
Default \`false\`. Narrative Logic > Emotional Intensity. Set \`true\` ONLY for **IRREVERSIBLE World State Changes**:
1. Status: Death, Breakup/Marriage, Firsts (kiss/date/confession), Permanent Separation, etc.
2. Lore: Major Secret Revealed (New info), Key Item/Location unlocked.
IMPORTANT: Set \`false\` for everything else, including:
- Emotional outbursts/threats/arguments without permanent consequence
- Repeating known info
- Revertable Status

# Format
- Type: RAW JSON Array \`[...]\`. Start immediately with \`[\`.
- Language: Summary in Chinese. JSON keys/Tags in English.
- Length: ~600-800 tokens in total
- Example:
[
  {
    "summary": "2025/10/15 深夜: 在废弃地铁站的安全屋中，Ellina和Krist正在整理补给品。Ellina一边处理手上的擦伤，一边调侃罐头食品的口味，试图缓解紧张的气氛。Krist配合着她的玩笑，默默地将稀缺的抗生素递给她。这段时间的宁静与温情让二人暂时忘记了外面的追兵。",
    "tags": {
      "vibe": "Wholesome",
      "special": [],
      "important": false
    }
  },
  {
    "summary": "2025/10/15 深夜: 警报声突然刺破了宁静，打破了之前的温馨氛围。安全屋监控显示‘猎犬’部队已突破。Krist的态度瞬间转变，他迅速推灭篝火，将Elina护在身后，语气冰冷地命令她进入隐蔽点。他首次拔出了背后的高频震动刃，并向Elina揭露了残酷的真相：敌人不是来抓捕的，而是来执行清除指令的。",
    "tags": {
      "vibe": a"Suspense",
      "special": [],
      "important": true
    }
  }
]

# Critical Review
Prevent Over-Segmentation. Default to merge!`

/** 内置英文 RP 归档指令（规格 §3.4，逐字照抄，勿改一字）。 */
const BUILTIN_COMPACTION_EN = `# Summarization Guidelines
Target: Create a high-density NARRATIVE CHRONICLE of the Macro Plot. Consolidate interactions into coherent storylines while explicitly preserving specific entities as memory anchors.

## MACRO Plot Progression
- Reference <basic_info> & <previous_summary> for context.
- Comprehensively scan <new_text_to_summarize>. Identify the core narrative arcs (Who/What/Where/Result).

## Segmentation Strategy
0. Aggressive Merging: Prioritize continuity. Group continuous interactions into ONE segment unless a hard trigger is met.
1. Minimum Density: A segment MUST contain a full plot loop (Action -> Reaction -> Result). NEVER split for brief reactions.
2. Split Triggers ONLY when:
- Sustained Vibe Shift: Split ONLY if the atmosphere flips AND STAYS changed for the rest of the scene. Ignore transient spikes.
  - Merge: a joke during a serious meeting
  - Split: [Daily] -> Explosion -> [Action]
- Narrative Break: Significant change in Location/Time. Ignore natural time passing during continuous dialogue (e.g., Midnight -> Dawn without a "fade to black" break)

## Writing Logic
Structure: [Time Prefix]: [Content]
1. Time Prefix: Combine Date (if found) with General Time Block (e.g., "2025/12/11 深夜", "永和九年 子时", "初夏某日 下午"). DO NOT split minute-by-minute.
2. Anchors
- Preserve specific appointment times/locations (e.g., "晚上9点见", NOT "晚上见")
- Unique & Interactive Proper Nouns (e.g., "在Mellow甜品店吃柠檬巴菲", NOT "吃甜品" )
3. Dialogue:
  - Key: Quote directly (Max 1-2 line). Triggered by plot-critical reveals, confessions, threats, promises, or declarations.
  - Casual: Summarize intent (e.g., Sam抱怨了冬天的寒冷)

## Style
- Perspective: Third-person.
- Objectivity: State facts directly. DO NOT evade/censor sensitive/NSFW content, record what exactly happens.
- Show, Don't Tell: Record the evidence. NO abstract conclusion.
  - Bad: 他们的关系更亲密了
  - Good: Sam第一次主动握住了Sofia的手

# Tagging Rules (PER Segment)

### Vibe Tag (Select ONE dominant)
- [Daily] (Routine, relax, casual)
- [Wholesome] (Comfort, sweet, peace)
- [Comedy] (Funny, absurd)
- [Conflict] (Arguments, hostility, misunderstandings, jealousy, cold wars. NOT playful teasing.)
- [Action] (Combat, adventure, danger)
- [Angst] (Pain, tragedy, trauma)
- [Suspense] (Fear, mystery, tension)
- [Romantic] (Heart-focused, intimacy, flirting, love)
- [Sexual] (Body-focused, lust)
- [Serious] (Work, deep logic, lore-dump)

### Special Tags (OPTIONAL Array)
ONLY include if the segment occurs during the event OR contains related content (conversations/items/symptoms)
- Events: [Halloween], [Christmas], [Birthday], [Anniversary], [NewYear], [Valentine], [Travel]
- Health:
  - [Period] (Explicit mentions OR implied cues like cramps, hot water bottles)
  - [Sick] (Physical illness, weakness or injury)
- If none apply, output an empty list [].

## Important Tag (Boolean)
Default \`false\`. Narrative Logic > Emotional Intensity. Set \`true\` ONLY for **IRREVERSIBLE World State Changes**:
1. Status: Death, Breakup/Marriage, Firsts (kiss/date/confession), Permanent Separation, etc.
2. Lore: Major Secret Revealed (New info), Key Item/Location unlocked.
IMPORTANT: Set \`false\` for everything else, including:
- Emotional outbursts/threats/arguments without permanent consequence
- Repeating known info
- Revertable Status

# Format
- Type: RAW JSON Array \`[...]\`. Start immediately with \`[\`.
- Language: Summary in Chinese. JSON keys/Tags in English.
- Length: ~600-800 tokens in total
- Example:
[
  {
    "summary": "2025/10/15 深夜: 在废弃地铁站的安全屋中，Ellina和Krist正在整理补给品。Ellina一边处理手上的擦伤，一边调侃罐头食品的口味，试图缓解紧张的气氛。Krist配合着她的玩笑，默默地将稀缺的抗生素递给她。这段时间的宁静与温情让二人暂时忘记了外面的追兵。",
    "tags": {
      "vibe": "Wholesome",
      "special": [],
      "important": false
    }
  },
  {
    "summary": "2025/10/15 深夜: 警报声突然刺破了宁静，打破了之前的温馨氛围。安全屋监控显示‘猎犬’部队已突破。Krist的态度瞬间转变，他迅速推灭篝火，将Elina护在身后，语气冰冷地命令她进入隐蔽点。他首次拔出了背后的高频震动刃，并向Elina揭露了残酷的真相：敌人不是来抓捕的，而是来执行清除指令的。",
    "tags": {
      "vibe": a"Suspense",
      "special": [],
      "important": true
    }
  }
]

# Critical Review
Prevent Over-Segmentation. Default to merge!`

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
  // 破限头：默认留空（我们**不内置**任何破限文本 —— 2026-09-16 用户口径：规避法律风险，由玩家自填）
  const jailbreak = typeof prompts.compactionJailbreak === 'string' ? prompts.compactionJailbreak : ''
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
      // ★ 破限头：**默认空串**（不内置任何破限文本）；`custom` 只是"玩家填过没有"。
      compactionJailbreak: {
        current: jailbreak,
        custom: jailbreak !== '',
      },
    },
    reference: {
      officialCompaction: OFFICIAL_COMPACTION,
      officialPreamble: OFFICIAL_PREAMBLE,
    },
  }
}

/** 当前**生效的压缩指令**（custom 优先，否则内置）—— collect-scan 的回声闸门用它判
 *  「模型摘要是不是指令原文的回吐」。拿不到（异常/空）就给 ''，闸门只按结构判，不瞎猜。
 *  这是本插件侧能拿到的唯一一份"当前生效指令"；生成器侧（mt-compaction.js）那份不在这里 import。 */
function currentCompactionInstruction() {
  try {
    const t = templatesResponse().templates.compaction.current
    return typeof t === 'string' ? t : ''
  } catch {
    return ''
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
  for (const k of ['compaction', 'placeholder', 'compactionJailbreak']) {
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
  // ★★ 2026-09-20 清洗②（用户口径：「也不被记忆库收录」）：把 `source.kind` 一并带出去 ——
  //   归档侧（collect-scan 的 mapRegionToFloors）靠它把**插件注入的 user 消息**排除在"楼"之外
  //   （本插件注入的后处理提示词、官方运行上下文快照都属此类）。⛔ 取不到就 null，⛔ 不猜。
  const put = (seq, surface, text, sourceKind) => {
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return
    bySeq.set(seq, {
      surface: validSurface(surface),
      text: typeof text === 'string' ? text : '',
      sourceKind: typeof sourceKind === 'string' ? sourceKind : null,
    })
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
          put(d.seq, d.surface, extractText(d), sourceKindOf(d))
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
    `[mt] /session/events sessionId=${String(key).slice(0, 24)} 事件行超过事件缓存字节上限 ${Math.round(EVENTS_CACHE_MAX_BYTES / (1024 * 1024))} MB，不缓存（每次重新取）`,
  )
}

/**
 * 归档来源（20260914 M4 接线，M5 抽成可复用函数）：「已归档」不是会话文件的属性，而是
 * 工作区注册表（服务键 workspaceRegistry）的 global.archivedSessionIds，不在会话文件里。
 * ★ 服务解析必须放进每次调用里 —— 接线时 registry 往往还没起（3104 实测：接线时
 *   ctx.get 拿不到 ⇒ 全部行降级 unknown）；ctx.get 与 ctx.workspaceRegistry 两条路都试
 *   （宿主自己的 workspace-controller 用的是后者）。每次读都是内存现值（归档实时）；
 *   读不到 ⇒ known:false（未知 ≠ 未归档，⛔ 不许折成空集冒充「谁都没归档」）。
 * ★ 只读投影：本插件绝不写注册表；不进 inject（它不是必须的兄弟服务）。
 * 消费方：prompt-viewer（编辑器列表三出口，M4）与 handleSessions（记忆库主面板
 * /sessions，M5）。返回 { known:true, ids:string[] } | { known:false, ids:[] }。
 */
function makeArchivedProvider(ctx) {
  return () => {
    try {
      let wsReg = null
      try { wsReg = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : null } catch { }
      if (wsReg == null) wsReg = ctx.workspaceRegistry
      const ids = wsReg && wsReg.archivedSessionIds
      if (!Array.isArray(ids)) return { known: false, ids: [] }
      return { known: true, ids: ids.map(String) }
    } catch { return { known: false, ids: [] } }   // 未启动 / 形状变了 ⇒ 未知，不是空
  }
}

// 洞 B 修复（20260914 C0）：回给客户端的错误消息里把 36 位 UUID 截成**尾 12 位**。
// 界面纪律：任何地方都不显示完整 UUID / 完整 sessionId（完整值只进 title 悬停属性）。
// ⛔ 只截断「回给客户端的那份」；log.info/warn 里一律**不要**截（日志要能排查）。
const CLIENT_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
export function shortIdForClient(text) {
  return String(text ?? '').replace(CLIENT_UUID_RE, (m) => m.slice(-12))
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
      return send(500, err('SESSION_READ_FAILED', shortIdForClient(redact(e?.message || String(e)))))
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
  // 归档位（20260914 M5）：与编辑器三出口（prompt-viewer.js readArchiveState/archiveBitOf）
  // 同一语义 —— known ⇒ 每行 true/false；未知 ⇒ null（未知 ≠ 未归档，null 折成 false 会谎报
  // 「谁都没归档」）。★ 逐请求现取 + 浅拷贝补位：titlesCache 里的行不带 archived 键，位绝不
  // 烤进缓存（同一 TTL 窗口内换掉注册表 ⇒ 下一个响应必须跟着变）；信封口径与 prompt-viewer.js
  // archiveEnvelope 一致（archivedCount = 本响应标 true 的行数；未知 ⇒ 0）。
  const arc = makeArchivedProvider(ctx)()
  const arcIds = new Set(arc.ids)
  const sessions = data.sessions.map((row) => Object.assign({}, row, {
    archived: arc.known && row.sessionId != null ? arcIds.has(String(row.sessionId)) : null,
  }))
  const payload = {
    ok: true,
    sessions,
    archive: {
      known: arc.known === true,
      archivedCount: arc.known ? sessions.filter((r) => r.archived === true).length : 0,
    },
  }
  log.info(`[mt] /sessions titles=${wantTitles ? 1 : 0} 返回 ${payload.sessions.length} 条（archive known=${payload.archive.known} archivedCount=${payload.archive.archivedCount}）`)
  return send(200, payload)
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
        `[mt] /session/events sessionId=${sessionId.slice(0, 24)} 缓存命中（total=${cached.length}，limit=${limit}，offset=${offset}）`,
      )
      return send(200, {
        ok: true,
        sessionId,
        total: cached.length,
        events: cached.slice(offset, offset + limit),
      })
    }
  }

  // 为什么不再直接用 readSession：上游 readSession 对 seeded 会话必抛（seed === inherited
  // prefix 校验，deepseek-harness packages/session-query/session-query/src/index.ts:183-196 与
  // packages/core/session/src/index.ts:599-600），fork 周目会话全 500 —— 改走 loadSessionLog
  // （活会话注册表优先）。readSession 只吃一个参数、返回全部事件：分页仍本地切片。
  let loaded
  try {
    loaded = await loadSessionLog(ctx, sq, sessionId)
  } catch (e) {
    return send(500, err('SESSION_READ_FAILED', shortIdForClient(redact(e?.message || String(e)))))
  }
  const rawEvents = loaded.events
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
    `[mt] /session/events sessionId=${sessionId.slice(0, 24)} 返回 ${Math.min(limit, Math.max(0, total - offset))} 条（total=${total}，limit=${limit}，offset=${offset}，refresh=${refresh ? 1 : 0}）`,
  )
  return send(200, { ok: true, sessionId, total, events: rows.slice(offset, offset + limit) })
}

/**
 * 洞 A 修复（20260914 C0）：Tavern 探活判据（纯函数，probeTavern 与
 * _selftest-health-20260914.mjs 共用）。旧判据「fetch 不抛即 true（不管状态码）」是
 * 假阳性：没装 Tavern 的宿主对任意路径都答 404（空 body），同样「能连通」——它
 * 区分不了「Tavern 在」与「宿主对任何路径都答 404」。
 * 三条全中才 true；任何一条不中（超时 / 404 / 空 body / 非 JSON / ok:false / 缺 list）
 * 一律 false —— 宁可 false（面板降级并说明原因）也不要假 true。⛔ 不许放宽：
 *   1) HTTP 200；
 *   2) content-type 含 application/json；
 *   3) body 能 JSON.parse 且是对象、ok===true、且 Array.isArray(json.list)
 *      —— list 是该端点（GET /pmp-dsh-tavern/api/v2/workspace/files?list=）契约里的
 *        必有字段（出处：tavern-loader/src/api-security.js；对照实证：真机装了 Tavern
 *        → 200 {ok:true,list:[…]}；沙箱没装 → 404 空 body，与乱编路径同形）。
 */
export function tavernProbeOk({ status, contentType, body } = {}) {
  if (status !== 200) return false // 判据 1：非 200 一律不可达
  if (typeof contentType !== 'string' || !contentType.toLowerCase().includes('application/json')) {
    return false // 判据 2：必须声明 JSON
  }
  try {
    const json = JSON.parse(body)
    return isPlainObject(json) && json.ok === true && Array.isArray(json.list) // 判据 3
  } catch {
    return false // body 非合法 JSON（含空 body）
  }
}

async function probeTavern(req) {
  try {
    const host = req && req.headers && req.headers.host
    const localPort = req && req.socket && req.socket.localPort
    const base = host
      ? `http://${host}`
      : `http://127.0.0.1${localPort ? ':' + localPort : ''}`
    // 可选依赖不 import，只靠 HTTP 探活；判据见 tavernProbeOk（三条全中才 true ——
    // 旧「能连通即 true」是假阳性），超时 / 拒连 / 任何失败一律 false。
    const res = await fetch(base + TAVERN_PROBE_PATH, {
      signal: AbortSignal.timeout(TAVERN_PROBE_TIMEOUT_MS),
      redirect: 'manual',
    })
    const body = await res.text().catch(() => '')
    return tavernProbeOk({ status: res.status, contentType: res.headers.get('content-type'), body })
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
  // ★ 2026-09-20：`state:card`（原 order 50）**已退役** —— 状态子系统整个剥离（state-bridge 子包归档、
  //   story-anchor 也不再挂载），状态改由周目笔记 `.roleplay-memory/state.md` 维护。⛔ 别再把这个条目加回来。
  {
    key: 'storyAnchor', name: 'story-anchor（rp:storyAnchor · 剧情锚点）', order: '56',
    re: /story-anchor/,
    note: '本插件预设模块（preset-modules/story-anchor.js）：每轮注入的场景/进度锚（≤400 字），把「此刻在哪、进行到哪」钉住，免得模型漂。',
  },
  {
    key: 'rpToolScope', name: 'rp-tool-scope（RP 工具面收窄）', order: '不注入 system 段（只管工具注册表）',
    re: /rp-tool-scope/,
    note: '本插件预设模块（preset-modules/rp-tool-scope.js）：把工具面收窄到 RP 需要的那几个；fail-closed 已兜底 —— 出错只降级不收窄，绝不让 preset 挂载失败。',
  },
  {
    key: 'keepFirstRound', name: 'keep-first-round（rp:firstRound · 保留第一轮）', order: '10201',
    re: /keep-first-round/,
    note: '本插件预设模块（preset-modules/keep-first-round.js）：把首轮原文钉住，官方压缩永不碰它 ⇒ 首轮末尾的约束词不消失；关掉＝完全恢复官方行为。',
  },
  {
    key: 'lastFloors', name: '最近几楼（mt:lastFloors · 倒数第二）', order: '10202',
    re: /mt:lastFloors|last-floors/,
    note: '本插件（lib/last-floors.js + registerLastFloors）：**当前上下文少于 5000 字**时，把当前周目归档里最近几楼原文注入成 <recentFloors>，让新周目开局有可承接的上下文（上下文长过阈值就停）。位置是**倒数第二** —— 紧随其后的 mt:postHistory@10203（卡的后处理指令）保持绝对最后。默认关。',
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
  // 为什么不再直接用 readSession：seeded 会话在上游 readSession 必抛（deepseek-harness
  // packages/session-query/session-query/src/index.ts:183-196 与
  // packages/core/session/src/index.ts:599-600 的 seed 校验）—— 这里读日志只为找
  // agentPreset 线索，读不出就如实 null，与之前"readSession 抛 ⇒ null"的降级一致。
  let loaded
  try {
    loaded = await loadSessionLog(ctx, sq, sessionId)
  } catch {
    return null
  }
  let found = null
  for (const raw of loaded.events) {
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
  if (!found && isPlainObject(loaded.session)) {
    const s = loaded.session
    const id = firstString(s.agentPreset, s.presetId, s.preset)
    if (id) found = { id, evidence: '会话对象（loadSessionLog）' }
  }
  return found
}

/**
 * 「面板值 vs preset 实际值」：把 preset 组成里 compaction 后端的 customInstruction（若有）
 * 与本插件配置里的压缩指令比一比。只比对，不写。提取不到一律 consistent:null（未知）。
 *
 * ★ 2026-09-19 解耦框定：本插件是**通用工具**，**不假定预设由我们管**（白名单已砍）。
 *   这个比对仍然有意义 —— 它回答的是「**你面板里改的这份到底生不生效**」
 *   （预设自带的 customInstruction 会盖过它）。所以留着，但话术不再带"我们的预设"口吻：
 *   预设读不到 / 没有压缩块 ⇒ 一律如实说**无法判定**，⛔ 不许暗示"预设应该由我们配"。
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

    // 当前会话用哪个 preset：★ 事件路径（最后一次 agent-preset/selected）优先 —— 头字段
    // 只是【建会话时】的 agentPreset，中途 agent-preset/selected 换过的话它会说谎
    // （与 lib/prompt-viewer.js 与会话投影同一口径）；头字段只作兜底（从未换过的旧会话
    // 没有选择事件，走头字段）。两者都拿不到 ⇒ 如实给"未知、不猜"（见下方 reason 文案）。
    let selected = null
    if (sessionId) selected = (await presetFromSessionEvents(ctx, sessionId)) || (await presetFromSessionHeader(ctx, sessionId))

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
// ---------------------------------------------------------------------------
// v3 消费端（Tavern 外部组合 API）：只读投影 + 显式切模式
//
// 为什么要有这两条端点：v3 的合同是**后端/HTTP 交付**（上游明说「没有新增内置 UI 按钮」），
// 所以"谁去读 sources / 谁去切 mode"得由管理器插件自己给界面一个面。这里只做两件事：
//   ① GET  /v3            把 capabilities + 本会话 mode + sources 摘要 + 我们组合器的状态收成一份投影
//   ② POST /v3/mode       显式切 builtin/external（带 CAS：先读 revision 再写；⛔ 必须 confirm:true）
// ⛔ 不 import Tavern 代码、不缓存正文、不改 selection —— 只做 HTTP 转发与摘要。
// ---------------------------------------------------------------------------

/** 从请求推出 Tavern 同源基址（与 probeTavern 同一取法，⛔ 不硬编码端口）。 */
function tavernBaseFromReq(req) {
  const host = req && req.headers && req.headers.host
  const localPort = req && req.socket && req.socket.localPort
  return host ? `http://${host}` : `http://127.0.0.1${localPort ? ':' + localPort : ''}`
}

/** 一次 Tavern v3 调用：返回 `{ok, status, json, text}`；任何异常都变成可读结果，⛔ 不抛。 */
async function tavernV3Fetch(req, path, init) {
  const base = tavernBaseFromReq(req)
  try {
    const res = await fetch(base + path, Object.assign({ signal: AbortSignal.timeout(TAVERN_PROBE_TIMEOUT_MS), redirect: 'manual' }, init || {}))
    const text = await res.text().catch(() => '')
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { ok: res.status >= 200 && res.status < 300, status: res.status, json, text }
  } catch (e) {
    return { ok: false, status: 0, json: null, text: '', error: String((e && e.message) || e) }
  }
}

// ---------------------------------------------------------------------------

/**
 * 把上游 Tavern 解出来的段**按计划摆到位置上**（用户 2026-09-19 口径：「上游没有指定 order…这就是让位给我们」）。
 *
 * ## 它取代了什么（⛔ 别再往回加）
 * 2026-09-18/19 那一版是「我们自己注册一个 `mt:postHistory` @10203 尾段 + 把上游那份 PHI 摘掉/挪到末尾」。
 * 2026-09-19 用户拍板**删掉那个字段**（原话：「mt post 那个字段就可以删了」）—— 因为"排到全文最后"这件事
 * 由**摆位**直接做到就够了（上游那份就是唯一一份）：不需要我们再多注一份，也不需要那套"一步滞后 +
 * 60 秒 TTL"的带外运输（它正是"后处理指令在长回合里整段消失"的成因）。
 * ⇒ 现在：没有尾段、没有摘除、没有带外缓存；只有「给上游的段派 order + 按 order 摆进段表」。
 *
 * ## 为什么必须延迟到"第一个会话事件"才挂这个监听
 * 上游在 `system-prompt/assemble` 里把自己那段 profile **就地展开**成 `:part:` 段；而监听按**注册顺序**跑，
 * 我们只 inject `['skills']`、Tavern 要等四个服务 ⇒ 它激活更晚、注册更晚，于是排在我们后面。
 * 开机即挂 = 永远跑在它前面 = 那时段表里一个 `:part:` 都没有（真机实测：`parts:0`）。会话事件一定在
 * 所有插件激活之后、又一定在**本轮装配之前** ⇒ 那时才挂：既是下游，又不漏首轮。⛔ 别改成直接挂。
 *
 * ## 失败模式
 * 摆位失败**绝不影响这一轮装配**（整段 try/catch）：最坏情况就是"段留在上游给的位置"，功能照旧。
 */
function registerTavernParts(ctx, log) {
  const handle = {
    installed: false, reason: 'not-attempted', mode: () => 'unavailable',
    placedTotal: 0, lastPlaced: null, lastSeen: null, lastGuard: null, lastPhi: null,
  }
  if (tavernFieldPlan === null) { handle.reason = 'plan-module-missing'; return handle }
  if (deferredInstall === null) { handle.reason = 'install-module-missing'; return handle }
  if (v3Contract === null) { handle.reason = 'contract-module-missing'; return handle }
  const run = async (assembly, assembleContext, next) => {
    try {
      if (assembly !== null && typeof assembly === 'object' && Array.isArray(assembly.sections)) {
        const sid = assembleContext?.agent?.session?.id
        // ① 摆位：认出字段的按计划 order 摆；认不出的按兜底 order（卡字段之后）——⛔ 一条 part 都不落下
        const placed = tavernFieldPlan.placeTavernParts(assembly.sections)
        if (placed.placed.length > 0) {
          assembly.sections = placed.sections
          handle.placedTotal += placed.placed.length
          handle.lastPlaced = { at: Date.now(), placed: placed.placed, fallback: placed.fallback }
        }
        // ② 看守（2026-09-18 改版）：就在这一刻**直接观察**段表 —— 我们自己的段在不在。
        //   为什么在这儿：这是每轮装配**唯一**能看见完整段表的地方（下游监听、段文本已结算）。
        try {
          if (typeof sid === 'string' && sid !== '' && v3ObserveCache !== null) {
            const g = v3Contract.guardFromSections(assembly.sections, OUR_SECTION_NAMES)
            v3ObserveCache.setObserved(sid, g)
            handle.lastGuard = { at: Date.now(), ...g }
          }
        } catch { /* 观察失败不影响装配 */ }
        // ③ 诊断：这一轮看见了什么（段数 / `:part:` 数 / 摆了几段 / 几个字段没进表 + 摆位摘要）
        handle.lastSeen = {
          at: Date.now(),
          total: assembly.sections.length,
          parts: assembly.sections.filter((s) => v3Contract.parsePartSectionName(s?.name) !== null).length,
          placed: placed.placed.length,
          fallback: placed.fallback,
          summary: tavernFieldPlan.describePlacement(placed.placed),
        }
        // ④ 后处理提示词（2026-09-20）：
        //   ① 每次都把上游那份的**正文**记下来 —— pre-step 注入时要用它（上游每轮重新展开，所以每轮都有）；
        //   ② 已经**成功注入过**的会话：把 system 里那一份**整个摘掉**（⛔ 不是清空 —— 用户口径：
        //      「…postHistoryInstructions 字段还是出现了」；留着一条 0 字的段，面板上照样是一行）。
        //      ⇒ 同一个东西全世界只有一份（走玩家消息之后那条）。⛔ 第一轮不摘：注入还没跑通，留着兜底。
        try {
          if (typeof sid === 'string' && sid !== '' && phiMessage !== null) {
            let phiText = ''
            for (const s of assembly.sections) {
              const parsed = tavernFieldPlan.parseTavernPart(isPlainObject(s) ? s.name : null)
              if (parsed !== null && parsed.key === 'character:postHistoryInstructions'
                && typeof s.text === 'string' && s.text.trim() !== '') { phiText = s.text; break }
            }
            if (phiText !== '') {
              rememberPhiText(sid, phiText)
              let dropped = 0
              if (phiSwitchEnabled() && phiInjectedSessions.has(sid)) {
                const r = tavernFieldPlan.dropPostHistoryPart(assembly.sections)
                dropped = r.dropped
                if (dropped > 0) assembly.sections = r.sections
              }
              handle.lastPhi = { at: Date.now(), cached: phiText.length, dropped }
            }
          }
        } catch { /* 缓存/摘除失败绝不影响这一轮 */ }
      }
    } catch { /* 摆位失败绝不影响这一轮 */ }
    return next()
  }
  const d = deferredInstall.makeDeferredAssembleListener({
    on: typeof ctx.on === 'function' ? ctx.on.bind(ctx) : null,
    run,
    log,
  })
  const mode = d.mode()
  handle.installed = mode !== 'unavailable'
  handle.mode = d.mode
  handle.reason = handle.installed ? 'ok' : 'install-failed'
  if (handle.installed) log.info('[mt] 卡字段摆位已接线（哨兵在位；第一个会话事件后由下游版接管）')
  else log.warn('[mt] 卡字段摆位接线失败（已降级）：监听没挂上')
  return handle
}

// ⚠️ 卡片字段字数原先在这里（`v3FieldChars`）—— 2026-09-17 搬到 `./v3-contract.js` 的
// `fieldChars()`：两套合同的 `sources` 形状一致，共用一个投影，不复制第二份。

/** GET /v3?sessionId=…：capabilities + 本会话 mode + sources 摘要 + 我方组合器状态。 */
async function handleV3Get(ctx, url, req, send, log) {
  const sessionId = (url.searchParams.get('sessionId') || '').trim()
  if (v3Contract === null) {
    return send(200, {
      ok: false,
      error: {
        code: 'V3_CONTRACT_MODULE_MISSING',
        message: '识别 v3 合同的模块（lib/v3-contract.js）没加载上 ⇒ 不敢猜这台 Tavern 是哪一套合同'
          + (v3ContractLoadError ? '：' + String(v3ContractLoadError.message || v3ContractLoadError) : ''),
      },
    })
  }
  const caps = await tavernV3Fetch(req, v3Contract.v3Paths.capabilities())
  if (!caps.ok) {
    return send(200, {
      ok: false,
      error: {
        code: 'TAVERN_V3_UNAVAILABLE',
        message: caps.status === 404
          ? '这台 Tavern 没有 v3（`/pmp-dsh-tavern/api/v3/*` 404）：v3 目前只活在候选分支上，未合并、未发布'
          : `读 capabilities 失败：status=${caps.status}${caps.error ? ' ' + caps.error : ''}`,
      },
      tavern: { reachable: false, status: caps.status },
    })
  }
  // ★ 先认合同，再谈别的：两套 v3 的端点路径与能力面都不同，认错了会**静默谎报**。
  const det = v3Contract.detectV3Contract(caps.json)
  const info = v3Contract.contractInfo(det.contract)
  const contract = { id: det.contract, known: det.known, reason: det.reason, ...info }
  const cfg = (() => { try { return readConfigFile().config } catch { return defaultConfig() } })()
  const composerCfg = (cfg.v3 && cfg.v3.composer) || {}
  const servicePresent = (() => { try { return Boolean(getService(ctx, 'pmpDshTavernPrompt')) } catch { return false } })()
  const owners = Array.isArray(caps.json?.composers) ? caps.json.composers : []
  const ours = typeof composerCfg.owner === 'string' && composerCfg.owner !== '' ? composerCfg.owner : V3_DEFAULT_OWNER
  const composer = {
    enabled: composerCfg.enabled === true,
    owner: ours,
    // ★ `usable`：这台 Tavern **有没有**组合器注册表这回事（true/false/未知 null）。
    //   ⛔ 与 `registered` 分开：`registered:false` 可能是"配置没开"，也可能是"这条路根本不存在"，
    //   旧代码把后者读成"重启宿主就好"，把人指向一个**不存在的修复动作**。
    usable: info.composerUsable,
    registered: info.composerUsable === true && servicePresent && owners.includes(ours),
    servicePresent,
    owners,
    needsHostRestart: composerCfg.enabled === true && info.composerUsable === true && !owners.includes(ours),
    note: info.composerUsable === false
      ? '这条路在这台 Tavern 上**不存在**：trace 合同没有组合器注册表（capabilities 自述 composerRegistry:false）。⛔ 与配置无关，**重启也不会变好**。'
      : (info.composerUsable === null
        ? '无法判定：没读到 v3 capabilities ⇒ 不知道这台 Tavern 有没有组合器注册表（⛔ 不猜）'
        : (composerCfg.enabled !== true
          ? '未启用：装配仍由 Tavern 内置策略负责（我们的组合器默认关）'
          : (owners.includes(ours) ? '已注册：本会话切到 external 后，装配由我们产出' : '配置说启用，但本进程里没注册上 —— 改完这条配置要**重启宿主**才生效'))),
  }
  const out = {
    ok: true,
    tavern: { reachable: true, status: caps.status },
    capabilities: caps.json,
    // ★ 认出来的合同：面板据此决定显示什么、以及"我们的哪些功能**在这台 Tavern 上不适用**"
    contract,
    composer,
    // ★ 2026-09-19：**卡字段摆位**（取代 tail + sourcesFiller + phiStrip 那三块投影）。
    //   我们不再自己注册尾段、也不再摘上游的段 —— 只把上游解出来的每个字段**摆到计划里的位置**
    //   （PHI → 全文最后、开场白 → 历史之前…见 lib/tavern-field-plan.js）。
    parts: (() => {
      const h = tavernPartsHandle
      const reason = h?.reason ?? 'not-attempted'
      // ★ `mode()` 由 lib/deferred-install.js 给：`upstream-sentinel` = 哨兵在位（正常待启用，
      //   第一个会话事件后自动换成下游版）；`downstream` = 真正干活的已就位。
      //   ⛔ `upstream-sentinel` 是**正常中间态**，不是故障 —— 别渲染成警告。
      const mode = typeof h?.mode === 'function' ? String(h.mode()) : 'unavailable'
      const installed = h?.installed === true
      return {
        registered: installed && mode === 'downstream',
        armed: installed && mode === 'upstream-sentinel',
        mode,
        reason,
        planLoaded: tavernFieldPlan !== null,
        planVersion: tavernFieldPlan ? tavernFieldPlan.TAVERN_FIELD_PLAN_VERSION : null,
        placedTotal: h?.placedTotal ?? 0,
        lastPlaced: h?.lastPlaced ?? null,
        lastSeen: h?.lastSeen ?? null,
        // ★ 看守的直接观察（最近一轮）：我们自己的段在不在那一轮的段表里。
        //   ⛔ 这是"事实"，与 replaceGuard.presetMode（读配置）分开报 —— 两处口径不同。
        guard: h?.lastGuard ?? null,
        note: tavernFieldPlan === null
          ? '未接线（摆位模块没加载上：' + String(tavernFieldPlanLoadError?.message ?? '') + '）⇒ 上游解出来的段留在它给的位置'
          : (installed
            ? '已接线：给上游解出来的每个字段派 order + 按计划摆进段表（PHI 摆到全文最后、开场白摆到历史之前）'
            : '未接线（' + reason + '）⇒ 上游解出来的段留在它给的位置'),
      }
    })(),
  }
  if (sessionId !== '') {
    // ① 装配模式：**只有 composer 合同有**这条端点。trace 合同没有 ⇒ 不给 mode 字段（⛔ 不伪造）。
    const modePath = v3Contract.v3Paths.mode(det.contract, sessionId)
    if (modePath !== null) {
      const mode = await tavernV3Fetch(req, modePath)
      out.mode = mode.ok ? (mode.json?.composition ?? mode.json) : null
      if (!mode.ok) out.modeError = { code: mode.json?.code || 'MODE_READ_FAILED', status: mode.status, message: mode.json?.error || mode.text.slice(0, 200) }
    }
    // ② 当前来源快照：**两套合同都有**，但路径不同（`prompt-sources` vs `sources`）。形状一致，共用一个投影。
    const sourcesPath = v3Contract.v3Paths.sources(det.contract, sessionId)
    if (sourcesPath !== null) {
      const src = await tavernV3Fetch(req, sourcesPath)
      const projected = src.ok ? v3Contract.projectSources(src.json?.sources) : null
      if (projected !== null) out.sources = projected
      else if (!src.ok) out.sourcesError = { code: src.json?.code || 'SOURCES_READ_FAILED', status: src.status, message: src.json?.error || src.text.slice(0, 200) }
      else out.sourcesError = { code: 'SOURCES_SHAPE_UNEXPECTED', status: src.status, message: '响应形状不是预期的 {ok,sources} —— ⛔ 不猜' }
    }
    // ③ 历史装配索引：**只有 trace 合同有**（只读、不含段正文）。
    const assembliesPath = v3Contract.v3Paths.assemblies(det.contract, sessionId)
    if (assembliesPath !== null) {
      const idx = await tavernV3Fetch(req, assembliesPath)
      const projected = idx.ok ? v3Contract.projectAssemblyIndex(idx.json, { maxRecords: 256 }) : null
      if (projected !== null) out.assemblies = projected
      else out.assembliesError = { code: idx.json?.code || 'ASSEMBLIES_READ_FAILED', status: idx.status, message: idx.json?.error || idx.text.slice(0, 200) }
    }
  }
  // ── replace 模式看守（用户 2026-09-17 点名要的"防线"）──────────────────────────
  // Tavern 在 `systemPromptMode === 'replace'` 时把装配**过滤成只留它自己的段**
  // （`profile` / `:part:` / `rp:policy`）⇒ 我们这七段会被**整批滤掉**，而且没有任何报错。
  // ★ 判据是**确定性的**：sources 快照里 `documents.preset.systemPromptMode` 直接可读。
  //   ⛔ 故意**不用**"我们的段变少了"这种启发式 —— 段为空是常态（首轮之外没有 mt:lastFloors、
  //   没绑卡就没有 mt:postHistory），误报会训练人忽略这条警告，比没有看守更糟。
  // 看守（2026-09-18 改版）：**以"直接观察"为主**，预设模式只作补充。
  // 为什么改：原来只看 `out.sources.presetMode`，而上游在 trace 候选里把 `/sources` 删了 ⇒ 看守瞎了。
  // 现在每轮装配期我们**真的看得见段表**（摘除器/观察器就在里面）⇒ 「我们的段在不在」是硬事实，
  // 它连"因为别的原因（插件没挂上）导致段没了"也一并抓到；预设模式则用来**提前**预警。
  const obs = (() => { try { return v3ObserveCache === null ? null : v3ObserveCache.getObserved(sessionId) } catch { return null } })()
  const presetMode = out.sources?.presetMode ?? null
  const observedOk = obs !== null && obs.observed === true
  const wholesale = observedOk && obs.wholesale === true
  const presetSaysReplace = presetMode === 'replace'
  const presetSaysAppend = presetMode === 'append'
  const atRisk = wholesale || presetSaysReplace
  // basis = **这条判词是谁给的**（面板/排障要能分辨"读配置来的"与"看段表来的"）
  const basis = wholesale && presetSaysReplace ? 'both'
    : wholesale ? 'observed'
      : presetSaysReplace ? 'preset'
        : observedOk ? 'observed'
          : presetSaysAppend ? 'preset'
            : 'unknown'
  // ⛔ 注意：`presetMode === 'append'` 是**正向**判据（Tavern 不会滤我们）—— 别把它也归成"无法判定"。
  const note = wholesale
    ? `⚠ 这一轮装配（共 ${obs.total} 段）里**我们自己的段一个都没有**：${OUR_SECTION_NAMES.join('、')}`
      + ` ⇒ 极可能是预设的 systemPromptMode = replace 把非 Tavern 段整批滤掉了`
      + `${presetSaysReplace ? '（预设模式也确认了这点）' : '（预设模式读不到，这里是直接观察的结论）'}。`
    : (presetSaysReplace
      ? `⚠ 预设的 systemPromptMode = **replace** ⇒ Tavern 只保留它自己的段（profile / :part: / rp:policy），`
        + `我们这 ${OUR_SECTION_NAMES.length} 段会被**整批滤掉**：${OUR_SECTION_NAMES.join('、')}`
      : (observedOk && obs.partial
        ? `这一轮装配（共 ${obs.total} 段）里我们缺了 ${obs.missing.join('、')}`
          + `（在的有 ${obs.present.length} 段）—— 可能只是某个插件没启用（例如 anima 那条要 dsh-anima-rag 在场），`
          + `不一定是被滤；换 preset 模式时留意这几段。`
        : (observedOk
          ? `这一轮装配（共 ${obs.total} 段）里我们 ${obs.present.length} 段**全在** ⇒ 没有被滤`
            + `${presetSaysAppend ? '（预设模式也确认 append）' : ''}`
          : (presetSaysAppend
            ? '预设是 append 模式 ⇒ Tavern **不会**滤掉我们的段（这一轮的段表还没观察到；下一轮 RP 后会有直接观察）'
            : '还没观察到一轮装配（看守靠每轮的段表，首轮之前没有依据），预设模式也读不到 ⇒ 无法判定，⛔ 不猜'))))
  out.replaceGuard = {
    basis,
    presetMode,
    ourSections: [...OUR_SECTION_NAMES],
    // 直接观察（有就给全，面板/排障要能看见"哪几段在、哪几段不在"）
    observed: observedOk,
    total: obs?.total ?? null,
    present: Array.isArray(obs?.present) ? obs.present : [],
    missing: Array.isArray(obs?.missing) ? obs.missing : [],
    partial: observedOk && obs.partial === true,
    atRisk,
    note,
  }
  try { log?.info?.(`[mt] /v3：capabilities ok，composers=${JSON.stringify(owners)}，session=${sessionId === '' ? '（未给）' : '有'}`) } catch {}
  return send(200, out)
}

/**
 * GET /v3/assembly?sessionId=…&recordId=…[&section=N] —— trace 合同的**单条装配记录**详情。
 *
 * 两段式（与上游自己的 Trace 页面同款）：索引只给元数据，这里才读单条；
 * 段正文**只有显式给 `section=N` 才带**（⛔ 不整份塞给面板 —— 那是系统提示词全文）。
 *
 * ⚠️ 这里**独立重认一次合同**（不信任调用方传来的 hint）：多一次回环 HTTP 的代价，
 *    换来"面板说什么就真的是什么"。composer 合同下如实回 NOT_SUPPORTED，而不是 404 了事。
 */
async function handleV3Assembly(url, req, send) {
  if (v3Contract === null) {
    return send(200, {
      ok: false,
      error: {
        code: 'V3_CONTRACT_MODULE_MISSING',
        message: '识别 v3 合同的模块（lib/v3-contract.js）没加载上 ⇒ 不敢猜这台 Tavern 是哪一套合同'
          + (v3ContractLoadError ? '：' + String(v3ContractLoadError.message || v3ContractLoadError) : ''),
      },
    })
  }
  const sessionId = (url.searchParams.get('sessionId') || '').trim()
  const recordId = (url.searchParams.get('recordId') || '').trim()
  if (sessionId === '' || recordId === '') {
    return send(200, { ok: false, error: { code: 'BAD_REQUEST', message: '缺 sessionId 或 recordId' } })
  }
  const wantTextParam = (url.searchParams.get('section') || '').trim()
  const wantText = wantTextParam !== ''
  const sectionIndex = wantText ? Number(wantTextParam) : -1
  if (wantText && !Number.isSafeInteger(sectionIndex)) {
    return send(200, { ok: false, error: { code: 'BAD_REQUEST', message: 'section 必须是整数下标' } })
  }
  const caps = await tavernV3Fetch(req, v3Contract.v3Paths.capabilities())
  if (!caps.ok) {
    return send(200, {
      ok: false,
      error: { code: 'TAVERN_V3_UNAVAILABLE', status: caps.status, message: `读 capabilities 失败：status=${caps.status}${caps.error ? ' ' + caps.error : ''}` },
    })
  }
  const det = v3Contract.detectV3Contract(caps.json)
  const recordPath = v3Contract.v3Paths.assemblyRecord(det.contract, sessionId, recordId)
  if (recordPath === null) {
    return send(200, {
      ok: false,
      error: {
        code: 'NOT_SUPPORTED',
        message: `这台 Tavern 是 ${det.contract} 合同（${det.reason}）⇒ 没有「单条装配记录」这条端点`,
      },
      contractId: det.contract,
    })
  }
  const got = await tavernV3Fetch(req, recordPath)
  if (!got.ok) {
    return send(200, {
      ok: false,
      error: {
        code: got.json?.code || 'ASSEMBLY_READ_FAILED',
        status: got.status,
        // 上游 404 的语义是"记录不存在或被容量策略淘汰"——⛔ **不能**当成"该轮没注入"
        message: got.json?.error || got.text.slice(0, 200),
      },
    })
  }
  const raw = got.json?.record
  const record = v3Contract.projectAssemblyRecord(raw, { includeText: false })
  if (record === null) {
    return send(200, { ok: false, error: { code: 'ASSEMBLY_SHAPE_UNEXPECTED', message: 'record 形状不是预期的对象 —— ⛔ 不猜' } })
  }
  const out = { ok: true, contractId: det.contract, record }
  if (wantText) {
    const text = v3Contract.pickSectionText(raw, sectionIndex)
    if (text === null) {
      out.sectionTextError = {
        code: 'SECTION_TEXT_UNAVAILABLE',
        message: `第 ${sectionIndex} 段没有正文 —— 可能越界，也可能上游因超限（omitted-size-limit）或装配失败没保存正文`,
      }
    } else {
      out.sectionText = { index: sectionIndex, name: record.sections[sectionIndex]?.name ?? null, text }
    }
  }
  return send(200, out)
}

/** POST /v3/mode：显式切模式（CAS）。体 {sessionId, mode, owner?, confirm}。 */
async function handleV3Mode(ctx, url, req, send, log) {
  let body = null
  try {
    const raw = await readBody(req, BODY_LIMIT)
    body = JSON.parse(raw.toString('utf8') || '{}')
  } catch (e) {
    return send(200, { ok: false, error: { code: 'BAD_JSON', message: '请求体不是合法 JSON：' + String((e && e.message) || e) } })
  }
  if (!isPlainObject(body)) return send(200, { ok: false, error: { code: 'BAD_REQUEST', message: '请求体必须是 JSON 对象' } })
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  const mode = body.mode === 'external' ? 'external' : body.mode === 'builtin' ? 'builtin' : ''
  if (sessionId === '') return send(200, { ok: false, error: { code: 'BAD_REQUEST', message: '缺 sessionId' } })
  if (mode === '') return send(200, { ok: false, error: { code: 'BAD_REQUEST', message: 'mode 必须是 external 或 builtin' } })
  if (body.confirm !== true) {
    return send(200, { ok: false, error: { code: 'CONFIRM_REQUIRED', message: '切模式会改变"这一会话的提示词由谁装配"，必须带 confirm:true' } })
  }
  // ★ 切模式这条**只存在于 composer 合同**（trace 合同没有 prompt-mode 端点）。
  //   ⛔ 不去打一个必然 404 的端点、然后把 404 说成"读当前 mode 失败" —— 那会把用户
  //   指向"重试/刷新"这种无效动作。如实说明这条路在这台 Tavern 上不存在。
  if (v3Contract === null) {
    return send(200, {
      ok: false,
      error: { code: 'V3_CONTRACT_MODULE_MISSING', message: '识别 v3 合同的模块（lib/v3-contract.js）没加载上 ⇒ 不敢切模式' },
    })
  }
  const capsForMode = await tavernV3Fetch(req, v3Contract.v3Paths.capabilities())
  const detMode = capsForMode.ok
    ? v3Contract.detectV3Contract(capsForMode.json)
    : { contract: 'absent', known: false, reason: `读不到 capabilities（status=${capsForMode.status}）` }
  const modePath = v3Contract.v3Paths.mode(detMode.contract, sessionId)
  if (modePath === null) {
    return send(200, {
      ok: false,
      error: {
        code: detMode.contract === 'trace' ? 'NOT_SUPPORTED' : 'TAVERN_V3_UNAVAILABLE',
        message: detMode.contract === 'trace'
          ? '这台 Tavern 用的是 trace 合同：**没有**「按会话切装配模式」这条端点（也没有组合器注册表）⇒ 这条路不存在，⛔ 与配置无关，重启也不会变好。'
          : `无法判定这台 Tavern 的 v3 合同（${detMode.reason}）⇒ 不切`,
      },
      contractId: detMode.contract,
    })
  }
  const cfg = (() => { try { return readConfigFile().config } catch { return defaultConfig() } })()
  const composerCfg = (cfg.v3 && cfg.v3.composer) || {}
  const owner = mode === 'external'
    ? (typeof body.owner === 'string' && body.owner.trim() !== '' ? body.owner.trim() : (typeof composerCfg.owner === 'string' && composerCfg.owner !== '' ? composerCfg.owner : V3_DEFAULT_OWNER))
    : undefined
  const cur = await tavernV3Fetch(req, modePath)
  if (!cur.ok) {
    return send(200, {
      ok: false,
      error: { code: cur.json?.code || 'TAVERN_V3_UNAVAILABLE', message: '读当前 mode 失败：' + String(cur.json?.error || cur.text || cur.status).slice(0, 200) },
      tavern: { reachable: cur.status !== 0, status: cur.status },
    })
  }
  const revision = cur.json?.composition?.revision
  const put = await tavernV3Fetch(req, modePath, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin: tavernBaseFromReq(req) },
    body: JSON.stringify(mode === 'external' ? { mode, owner, expectedRevision: revision } : { mode, expectedRevision: revision }),
  })
  try { log?.info?.(`[mt] /v3/mode：session=…${sessionId.slice(-6)} ⇒ ${mode}（HTTP ${put.status}）`) } catch {}
  if (!put.ok) {
    return send(200, {
      ok: false,
      error: { code: put.json?.code || 'MODE_WRITE_FAILED', message: String(put.json?.error || put.text || '').slice(0, 300) || ('HTTP ' + put.status) },
      hint: put.status === 409
        ? '409 的两种常见原因：① 这一轮还在跑（回合结束后再切）② revision 过期（刷新后再切）'
        : null,
      attempted: { mode, owner: owner ?? null, expectedRevision: revision ?? null },
    })
  }
  return send(200, {
    ok: true,
    composition: put.json?.composition ?? put.json ?? null,
    note: mode === 'external'
      ? '已切到 external：**Tavern 默认 profile 正文不再产生**，改由我们的组合器产出命名段（下一轮生效）'
      : '已切回 builtin：装配交回 Tavern 内置策略（下一轮生效）',
    nextStep: '新会话/子会话不会继承这个选择，需要分别显式开启',
  })
}

// ---------------------------------------------------------------------------
// 路由与注册
// ---------------------------------------------------------------------------

const ENDPOINTS = {
  '/import/formats': ['GET'],
  '/import/plan': ['POST'],
  '/import/apply': ['POST'],
  '/collect/targets': ['GET'],
  '/collect/plan': ['POST'],
  '/collect/apply': ['POST'],
  '/collect/scan': ['POST'],
  '/collect/auto': ['POST'],
  // 「扫归档原文 → 总结」侧路已撤（20260918：摘要改由压缩链产出，走宿主主 API，不用配置）。
  // 只留 /summarize/reset（只清摘要、不调模型的运维口）。
  '/summarize/reset': ['POST'],
  '/config': ['GET', 'PUT'],
  '/auto-collect': ['GET'],
  // 「角色扮演记忆库」只读出口（20260919 面板第四档）：读社区预设写在工作目录下的 .roleplay-memory/。
  // 清单不带正文；正文要 ?file=<目录里那一份> 才读。⛔ 纯只读，不碰那个预设。
  // （曾有的 `/playthrough/outline`＝我们那份单文件大纲，2026-09-19 随面板下半块一起退役。）
  '/playthrough/rp-memory': ['GET'],
  // ★★ 2026-09-23（用户口径「给剧情大纲加 1、剧情文本支持设置死区 2、剧情文本支持直接编辑」）：
  //   这一档第一次开写 —— 三条新端点与上面那条**同源**（同一份落点候选链、同一份 rel-path-jail 裁决）：
  //   · `/write`      = 剧情文本直接编辑（写回 .roleplay-memory/<file>，白名单 .md/.txt，乐观锁 409）；
  //   · `/deadzones`  = 死区（模型禁改区）的设置/解除（读写 `.dma-deadzones.json`，⛔ 不动剧情文本）；
  //   · `/deadzones/status` = 死区快照 vs 盘上现况的**只读**比对（面板画红字用，⛔ 不写盘）。
  '/playthrough/rp-memory/write': ['POST'],
  '/playthrough/rp-memory/deadzones': ['GET', 'POST'],
  '/playthrough/rp-memory/deadzones/status': ['GET'],
  // ★★ 2026-09-23（用户口径「**按楼层绑定的笔记快照**，每轮模型修改都记录，能自动跟随回档」）：
  //   · `/floors`         = 楼层清单（只读：第 N 楼 · 时间 · 改了哪几份（+几字节）· 当前那一楼 · 最近一次回档）；
  //   · `/floors/restore` = 面板「回到这一楼 / 把档案退回第 N 楼」（★ 2026-09-24 起**这是那 5 份唯一的写入口**）；
  //   · `/floors/pending/settle` = 面板「保持现状」＝**就地登记**（★ 2026-09-24 用户口径：跟 Tavern 一致，
  //     回档之后那段历史就是没有了 ⇒ 把**当下盘上那 5 份**的现文记成"剧情现在站的这一楼"那一份快照，
  //     并把 `last` 锚到它；⛔ 那 5 份**正文一个字节都不写**）；
  //   记录与"判回档"是**钩子**做的（轮末记一份、组装时 + 轮末判一次），⛔ 这三条端点都不改判据。
  //   ★ 2026-09-24 改口径（用户原话「**不要做跟随楼层的功能，先做手动挡**，开 fork 时（回档）**前台弹提示，
  //     让用户手动回退剧情档案**」）：判到回档**只在清单里记一条 `pending`**（GET /floors 带出去给面板画横幅），
  //     ⛔ 那 5 份一个字节都不写 —— **正文**的写盘只走 `/floors/restore` 那一脚。
  '/playthrough/rp-memory/floors': ['GET'],
  '/playthrough/rp-memory/floors/restore': ['POST'],
  '/playthrough/rp-memory/floors/pending/settle': ['POST'],
  // 「剧情大纲」档的**打开文件夹**（2026-09-20 用户口径；同日补：空态也用它）—— 动作型 ⇒ POST。
  // ⛔ 客户端**不传路径**，只给枚举 `{base:'playthrough'|'workspace-root'}`（缺省 = 第一个存在的候选）：
  //   要开哪个目录由宿主自己按候选链解析（见 rpMemoryCandidates）。周目目录不存在时按需创建
  //   （我们的写面）；工作区根那份**绝不建**（那是社区预设的地盘），退而打开工作区根本身。
  '/playthrough/reveal': ['POST'],
  // 「后台收纳状态」只读出口（20260919）：读 dsh-anima-rag 落的 ingest-state.json —— 面板的
  // shell.overlay 提示条靠它显示"正在收纳当前会话"。⛔ 只投影白名单字段，不吐原始文件、不吐路径。
  '/anima/ingest-state': ['GET'],
  // 「这个会话属于哪个周目」只读查询（20260919）：面板**跟随当前会话**靠它（查到就把绑定改过去）。
  '/playthrough/for-session': ['GET'],
  // 「向量」页签（2026-09-20，记忆库面板第四档）：状态只读 + 写一张请求单给 anima。
  // ⛔ 真拥有向量库的是 dsh-anima-rag（按会话挂载，引擎在它 apply() 闭包里）—— 本插件的宿主平面
  //   拿不到，所以只会「读状态快照 / 写请求单」，动作由 anima 在下一轮装配前执行（见 lib/vector-panel.js）。
  '/vector/state': ['GET'],
  '/vector/action': ['POST'],
  // 「压缩」档（2026-09-21，记忆库面板新一档）：本会话的实时占用读数（只读）+ 阈值保存。
  // ⛔ 客户端不自己算百分比、不直连任何官方内部接口 —— 一律读这两个端点。
  // ⛔ 也不把两个服务写进 `export const inject`：全部在请求时 `ctx.get('…')` 懒取，
  //   拿不到就照常 200 + 字段如实 null（inject 不满足会让**整个插件**不加载）。
  '/compaction/state': ['GET'],
  '/compaction/config': ['POST'],
  '/retrieval/test': ['POST'],
  '/templates': ['GET', 'PUT'],
  '/sessions': ['GET'],
  '/session/events': ['GET'],
  // ★ 2026-09-19 预设线整块退役（用户口径「不用保持了」）：本插件是**通用工具**，
  //   不再生成/修复/供给 agent preset。摘掉的端点：
  //   `/agent/detect`（"能给哪个 preset 装我们的东西"）、`/agent/apply`、`/agent/rollback`、
  //   `/agent/provision`、`/agent/backups`、`/agent/pack/apply`。
  //   ⛔ 保留 `/agent`（会话装配只读检视 = 提示词查看器那半边）与 `/agent/cards`、`/agent/card`（角色卡阅读）。
  '/agent': ['GET'],
  '/agent/cards': ['GET'],
  '/agent/card': ['GET'],
  '/sections': ['GET'],
  '/sections/text': ['GET'],
  '/sections/raw': ['GET'],
  // 「未抓到」那一行的底本：**捕获认过的那一份** system 全文（⛔ 不是 viewer 那条路）
  '/sections/system': ['GET'],
  '/editor/diagnostics': ['GET'],
  '/health': ['GET'],
  // v3 消费端（Tavern 外部组合 API）：只读投影 + 显式切模式
  '/v3': ['GET'],
  '/v3/mode': ['POST'],
  // trace 合同的「单条装配记录」详情（按需读；`section=` 才带那一段的正文）
  '/v3/assembly': ['GET'],
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
        // 双保险：响应体里绝不出现 key 原文（retrieval.key）
        try {
          for (const k of secretKeysOf(readConfigFile().config)) body = body.split(k).join('***')
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
      if (rest === '/templates' && method === 'GET') return send(200, templatesResponse())
      if (rest === '/templates' && method === 'PUT') return await handlePutTemplates(req, send, redact)
      // 自动收纳的状态出口（面板播报用）：开关 + 上一次运行结果（含失败原因）。
      if (rest === '/auto-collect') {
        let enabled = true
        try { enabled = readConfigFile().config.autoCollect?.enabled !== false } catch {}
        return send(200, { ok: true, enabled, last: readAutoCollectStatus() })
      }
      // 「角色扮演记忆库」只读出口（20260919 面板第四档）：落点解析/名单裁决/文件读取全在 handleRpMemory。
      if (rest === '/playthrough/rp-memory') return await handleRpMemory(send, url)
      // ★ 2026-09-23 三条新端点（同源：同一份候选链 + 同一份 jail 裁决）：编辑 / 死区 / 死区现状。
      if (rest === '/playthrough/rp-memory/write') return await handleRpMemoryWrite(req, send, log, redact)
      if (rest === '/playthrough/rp-memory/deadzones') return await handleRpMemoryDeadzones(req, send, log, redact)
      if (rest === '/playthrough/rp-memory/deadzones/status') return handleRpMemoryDeadzoneStatus(send)
      // ★ 2026-09-23：按楼层绑定的笔记快照（只读清单 + 面板「回到这一楼」+ ★ 2026-09-24「保持现状」）。
      if (rest === '/playthrough/rp-memory/floors') return handleRpMemoryFloors(send)
      if (rest === '/playthrough/rp-memory/floors/restore') return await handleRpMemoryFloorRestore(req, send, log, redact)
      if (rest === '/playthrough/rp-memory/floors/pending/settle') return await handleRpMemoryFloorPendingSettle(req, send, log, redact)
      if (rest === '/playthrough/reveal') return await handleRevealRpMemory(req, send, log)
      // 「后台收纳状态」只读出口（20260919）：读 dsh-anima-rag 落的 ingest-state.json（拿不到就如实 null）。
      if (rest === '/anima/ingest-state') return await handleAnimaIngestState(send)
      if (rest === '/playthrough/for-session') return await handlePlaythroughForSession(send, url)
      // 「向量」页签（2026-09-20）：状态只读 + 动作请求单（实现全在 ./vector-panel.js）。
      if (rest === '/vector/state') return await handleVectorState(send)
      if (rest === '/vector/action') return await handleVectorAction(req, send, redact)
      // 「压缩」档（2026-09-21）：实时占用只读 + 阈值保存（配置 + 部署预设 YAML 两件事各自如实）。
      if (rest === '/compaction/state') return await handleCompactionState(ctx, url, send)
      if (rest === '/compaction/config') return await handleCompactionConfig(req, send, redact)
      if (rest === '/sessions') return await handleSessions(ctx, url, send, redact, log, titlesCache)
      if (rest === '/session/events') return await handleEvents(ctx, url, send, redact, log, eventsCache)
      if (rest === '/agent') return await handleAgentGet(ctx, url, req, send)
      // ★ 2026-09-19 预设线退役：detect / apply / rollback / provision / backups / pack/apply 六条已删。
      if (rest === '/agent/cards') return await handleAgentCards(ctx, url, req, send)
      if (rest === '/agent/card') return await handleAgentCard(ctx, url, req, send)
      if (rest === '/collect/targets') return await import('./collect.js').then((m) => m.handleCollectTargets(ctx, url, req, send))
      if (rest === '/collect/plan') return await import('./collect.js').then((m) => m.handleCollectPlan(ctx, url, req, send))
      if (rest === '/collect/apply') return await import('./collect.js').then((m) => m.handleCollectApply(ctx, url, req, send))
      // 回声闸门（20260918）：把**当前生效的压缩指令**带给 collect-scan —— 模型摘要是
      // 指令回吐时拒收并大声播报。拿不到就传空串（闸门只按结构判，不瞎猜）。
      // ★★ 2026-09-22：第五个参数换成**原始事件装载器**（createRawEventLoader = loadSessionLog 包装）
      // —— 区间判据与模型摘要都要带 `data` 的事件；旧的 collectSurfaces 结构上给不出（见该助手头注）。
      if (rest === '/collect/scan') return await import('./collect-scan.js').then((m) => m.handleCollectScan(ctx, req, send, log, createRawEventLoader(ctx), currentCompactionInstruction()))
      if (rest === '/collect/auto') return await import('./collect-scan.js').then((m) => m.handleCollectAuto(ctx, req, send, log, createRawEventLoader(ctx), currentCompactionInstruction()))
      // 「扫归档原文 → 总结」侧路已撤（20260918）：摘要由压缩链产出（走宿主主 API，不用配置）。
      // plan / apply 两条路由连同处理函数一并删除。只留这个运维口：
      // /summarize/reset 只清摘要、不调模型（备份正文 → 清空 → 重置 index）。
      if (rest === '/summarize/reset') {
        const cfgR = readConfigFile().config
        return await import('./summarize.js').then((m) => m.handleSummarizeReset(ctx, url, req, send, { config: { ...cfgR.summarize } }))
      }
      if (rest === '/retrieval/test') return await handleTestRetrieval(send, redact)
      if (rest === '/import/formats') return await (await import('./import-formats.js')).handleImportFormats(ctx, req, send)
      if (rest === '/import/plan') return await (await import('./import-formats.js')).handleImportPlan(ctx, req, send, log)
      // B2 导入落库：实现全在 ./import-apply.js（它复用 A1 的 planCollect/applyCollect 写盘）。
      if (rest === '/import/apply') return await (await import('./import-apply.js')).handleImportApply(ctx, req, send, log)
      if (rest === '/v3') return await handleV3Get(ctx, url, req, send, log)
      if (rest === '/v3/mode') return await handleV3Mode(ctx, url, req, send, log)
      if (rest === '/v3/assembly') return await handleV3Assembly(url, req, send)
      if (rest === '/sections') {
        // C4 段结构（编辑器 v2 契约）：处理函数在 B 的模块里（handleSectionsGet），
        // 这里只接线；模块缺席时按既有降级风格给可读错误（HTTP 200 + ok:false）。
        if (sectionsCapture && typeof sectionsCapture.handleSectionsGet === 'function') {
          return await sectionsCapture.handleSectionsGet(ctx, url, send, log)
        }
        return send(200, {
          ok: false,
          error: {
            code: 'SECTIONS_UNAVAILABLE',
            message: `sections-capture 模块不可用，已降级（${sectionsCaptureLoadError?.message || sectionsCaptureLoadError}）`,
          },
        })
      }
      if (rest === '/sections/text') {
        // §9 正文切片（"点开看正文"）：处理函数在 B 的模块里（handleSectionsTextGet），
        // 取日志走 loadSessionLog（活会话注册表优先 → readSession 退路，⛔ 不直读会话文件），
        // 只返回被点开的那一段，凭据（renderedChars/renderedHash）相等才允许切。
        if (sectionsCapture && typeof sectionsCapture.handleSectionsTextGet === 'function') {
          return await sectionsCapture.handleSectionsTextGet(ctx, url, send, redact, log)
        }
        return send(200, {
          ok: false,
          error: {
            code: 'SECTIONS_UNAVAILABLE',
            message: `sections-capture 模块不可用，已降级（${sectionsCaptureLoadError?.message || sectionsCaptureLoadError}）`,
          },
        })
      }
      if (rest === '/sections/raw') {
        // M12「原始 JSON」出口：把被点开的那一条**原样**交出去（字段不删不改不算），
        // 并附正文（section 切 system；context 取日志里那条注入消息）。⛔ 不设字符上限。
        if (sectionsCapture && typeof sectionsCapture.handleSectionsRawGet === 'function') {
          return await sectionsCapture.handleSectionsRawGet(ctx, url, send, log)
        }
        return send(200, {
          ok: false,
          error: {
            code: 'SECTIONS_UNAVAILABLE',
            message: `sections-capture 模块不可用，已降级（${sectionsCaptureLoadError?.message || sectionsCaptureLoadError}）`,
          },
        })
      }
      if (rest === '/sections/system') {
        // 「未抓到」那一行的**底本**（2026-09-20）：只回**捕获认过的那一份** system 全文
        // （逐候选按 renderedChars + sha256 两道验）。⛔ 与 /prompt/api/part?part=system 不是同一条路：
        //   那条取的是"该楼 header 那一刻生效的正文"，一楼里有多份正文时它跟捕获的 offset 对不上。
        if (sectionsCapture && typeof sectionsCapture.handleSectionsSystemGet === 'function') {
          return await sectionsCapture.handleSectionsSystemGet(ctx, url, send, log)
        }
        return send(200, {
          ok: false,
          error: {
            code: 'SECTIONS_UNAVAILABLE',
            message: `sections-capture 模块不可用，已降级（${sectionsCaptureLoadError?.message || sectionsCaptureLoadError}）`,
          },
        })
      }
      if (rest === '/editor/diagnostics') {
        // M9 结构化诊断（20260914）：一次问清"这条会话/这一楼哪儿不对"。
        // 处理函数在 B 的模块里（handleEditorDiagnosticsGet）；归档来源复用 M5 抽出的 makeArchivedProvider。
        if (sectionsCapture && typeof sectionsCapture.handleEditorDiagnosticsGet === 'function') {
          return await sectionsCapture.handleEditorDiagnosticsGet(ctx, url, send, redact, log, {
            archivedProvider: makeArchivedProvider(ctx),
          })
        }
        return send(200, {
          ok: false,
          error: {
            code: 'SECTIONS_UNAVAILABLE',
            message: `sections-capture 模块不可用，已降级（${sectionsCaptureLoadError?.message || sectionsCaptureLoadError}）`,
          },
        })
      }
      if (rest === '/health') return await handleHealth(ctx, req, send)
      return send(404, err('NOT_FOUND', `未知路径 ${rest}`))
    } catch (e) {
      log.error(`[mt] handler 内部错误：${e?.stack || e}`)
      return send(500, err('INTERNAL', redact(e?.message || String(e))))
    }
  }
}

function registerHttpApi(ctx, scope, log) {
  const webServer = scope && scope.webServer
  if (!webServer || typeof webServer.register !== 'function') {
    log.warn('[mt] webServer 不可用，跳过 HTTP API 注册（插件保持可用）')
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
      `[mt] mem-budget 不可用（${memBudgetLoadError?.message || memBudgetLoadError}），事件缓存已禁用（/session/events 每次重新取）；其余功能不受影响`,
    )
  }
  if (rpAgentLoadError) {
    log.warn(
      `[mt] rp-agent 不可用（${rpAgentLoadError?.message || rpAgentLoadError}），/agent/cards、/agent/card 已降级为可读错误；其余 rest 不受影响`,
    )
  }
  // 第一条路由：同步注册，包进 effect（热重载时 dispose 掉旧路由，不留野路由）。
  // ★ §9 正文切片端点走本表 /sections/text（= /dsh-memory-archive/api/sections/text）：
  //   既有契约自检台把「恰好 2 条 prefix 注册、path 逐字冻结」也一并锁死，第三条
  //   /dsh-memory-archive/sections 别名注册会让 6 个自检台红 —— 是否加别名由调用方拍板。
  run(() => {
    const dispose = webServer.register({ kind: 'prefix', path: API_PREFIX, handler })
    return wrapDispose(dispose)
  }, 'dsh-memory-archive: HTTP API')
  log.info(`[mt] HTTP API 已注册（prefix ${API_PREFIX}）`)
  // 第二条路由（并入的提示词查看器）：与第一条【同一轮同步】注册（effect 必须在
  // apply 调用栈内挂上 fiber，见模块顶层的预加载说明）。prompt-viewer.js 加载失败
  // 或 createHandler 抛错都只降级本条：第一条路由不受影响，apply() 也绝不抛错。
  if (promptViewerFactory === null) {
    log.warn(
      `[mt] 提示词查看器不可用，已降级（${promptViewerLoadError?.message || promptViewerLoadError}）；/api 不受影响`,
    )
  } else {
    try {
      // 归档来源（20260914 M4；M5 起抽成模块级 makeArchivedProvider(ctx)）：实现与完整注释
      // 就在 handleSessions 上方 —— 编辑器三出口（prompt-viewer）与记忆库主面板 /sessions
      // 两处共用这一个函数，⛔ 不许复制出第二份实现。
      // readLog（20260915）：宿主侧会话日志读取器。★ 必传 —— 查看器自带的私有 persistence 栈
      // 走 `<DSH_HOME>/runtime` 那份 **0.1.2** 包，只认 `session.jsonl.zstd`；宿主写 v3 之后
      // 那条路读不到新会话（真机实测：v3-only 6/6 报 not found，带旧文件的读到冻结快照）。
      const pvHandler = promptViewerFactory({
        archivedProvider: makeArchivedProvider(ctx),
        storageDir: storageDir(),
        readLog: createHostSessionReader(ctx),
      })
      run(() => {
        const dispose = webServer.register({ kind: 'prefix', path: PROMPT_PREFIX, handler: pvHandler })
        return wrapDispose(dispose)
      }, 'dsh-memory-archive: prompt viewer')
      log.info(`[mt] 提示词查看器已注册（prefix ${PROMPT_PREFIX}）`)
    } catch (e) {
      log.warn(`[mt] 提示词查看器注册失败，已降级（/api 不受影响）：${e?.stack || e}`)
    }
  }
}

// ---------------------------------------------------------------------------
// skill 注册：DSH 里 skill 的唯一界面形态 = 输入框打 `/` 弹出的列表；skill 必须由
// 插件在 apply() 里【同步】注册才会出现（ctx.skills.register(skill) 返回 disposer）。
// 正文从包内 skill/*.md 读（new URL 相对 import.meta.url ⇒ 随包走、无绝对路径）；
// 某个正文读不到只降级那一个（log.warn + 跳过），绝不拖垮 apply。
// ---------------------------------------------------------------------------

/** skill 正文相对本文件的目录（末尾带 /）。 */
const SKILL_SOURCE_DIR = '../skill/'

const SKILL_DEFS = [
  {
    // ★ skill 的 name 必须是 ASCII kebab-case（官方 SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/），
    //   中文名放不下 ⇒ 放在 description **开头**，`/` 列表里显示的就是 name + description，
    //   于是玩家看到的第一眼就是「RP 助手」。
    //
    // ★★ 2026-09-20（用户口径「skill 彻底重塑，只留下一个通用 skill」）：**只剩这一个**。
    //   原来是两个（`rp-assistant` + 只给模型的 `config-kb`），知识库那一份并进来当**资料**：
    //   `rp-assistant/refs/dsh-internals.md`（平台内部事实与踩坑）+ 三份 README 快照/指路。
    //   为什么合成一个：知识（是什么）与工作流（怎么做）本来要一起用，而两个 skill 会让
    //   "该加载哪个"变成额外的判断成本；资源文件按需读，比"第二个 skill"更干净。
    name: 'rp-assistant',
    file: 'rp-assistant/SKILL.md',
    dir: 'rp-assistant/',
    resourceBase: true, // ⇒ 注册时带上资料基准目录（正文里的相对路径按它解析）
    // ★★ 2026-09-20（用户口径「那不用摘掉。需要的是明确注明」）：description 的**前 500 字**
    //   必须装下三条必知事实，顺序也是刻意的 —— 因为技能目录（`<available_skills>`）里每条就渲染成
    //     `- \`<name>\`: <description>`
    //   而 description 会被宿主**截断**（`catalogDescription(…, maxLength)`：压空白 → 超长就
    //   `slice(0, maxLength - 3) + '...'`，见 `tool-skill/src/index.ts:390-393`；预设里把 maxLength
    //   显式钉成 500）。摆到后半段 = 模型在**目录里根本看不见**（上一版的 RP 禁令就排在最末尾，
    //   等于白写）。所以顺序固定为：
    //     ① 中文名（`/` 列表与目录都靠它露脸；name 只能是 ASCII kebab-case，放不下中文）
    //     ② 由 `dsh-memory-archive` 插件注入 —— 免得被当成"平台自带"或别的插件的东西
    //     ③ 它是干什么用的（插件配置 / 安装 / 报错）＋ ⛔ RP 模式请勿调用
    //   `_selftest-skills.mjs` ③b 照抄了那个截断函数，专门钉"三条都在前 500 字以内" + 反证。
    description: 'RP 助手 —— 由 dsh-memory-archive 插件注入，用来解决本插件的配置 / 安装 / 报错相关问题（怎么配、装不上、选不到、改了没生效、换台机器就坏）。⛔ 角色扮演（RP）模式请勿调用本技能：演故事时不需要、也不许碰配置与源码 —— 它只在用户明确要修插件时才用。它把你这套角色扮演 agent 从头到尾理顺：它以为自己是干什么的、怎么说话、每轮都在的设定各落在哪儿、改哪一块有什么风险。手上带着这个项目的三份资料（酒馆 / 记忆库 / 翻往事那半边）与平台内部事实，可当场查。先只读体检摆事实，再逐块讲作用并问你的意见，全程你只需要做选择题。',
    whenToUse: '用户要把角色卡变成 / 优化成一个 RP agent、要体检现有 agent 时；要调整它的结构 / 配置时；以及遇到"装不上 / 选不到 / 换机器就坏 / 改了没生效 / 聊久了变傻 / 翻不出往事"时。',
    invocation: null, // 人可见：进 / 列表
  },
]

/** 注册 skill；逐个 try/catch，单个失败只 warn + 跳过，其余照常。 */
function registerSkills(ctx, log) {
  const skills = ctx && ctx.skills
  if (!skills || typeof skills.register !== 'function') {
    log.warn('[mt] skills 服务不可用，跳过 skill 注册（插件其余功能不受影响）')
    return
  }
  const effectFn = typeof ctx.effect === 'function' ? ctx.effect : null
  const run = effectFn ? (fn, label) => effectFn(fn, label) : (fn) => fn()
  const wrapDispose = (dispose) => () => {
    try {
      if (typeof dispose === 'function') dispose()
    } catch {}
  }
  for (const def of SKILL_DEFS) {
    let content
    try {
      content = readFileSync(new URL(SKILL_SOURCE_DIR + def.file, import.meta.url), 'utf8')
    } catch (e) {
      log.warn(`[mt] skill 正文读取失败，跳过 ${def.name}（${def.file}）：${e?.message || e}`)
      continue
    }
    try {
      // ★ source 是**必填**：SkillRegistration = Omit<SkillDefinition,'invocation'|'provider'>，
      //   而 SkillDefinition 从 SkillSummary 继承了 `source: SkillSource`（字符串联合）。
      //   漏了它 **注册不报错、列表照常出现**，但一旦真去**加载**就抛
      //   `loaded skill "…" source must be a string`（skill/src/index.ts:765）。
      //   这正是 2026-09-13「两个 skill 都点不开」的真因 —— 台子当时只记了调用、
      //   没校验必填字段，所以没抓到。取值 `'runtime'`：插件在 apply() 里注册的运行时技能。
      const skill = { name: def.name, description: def.description, source: 'runtime', content }
      if (def.whenToUse) skill.whenToUse = def.whenToUse
      if (def.invocation) skill.invocation = { ...def.invocation }
      // ★ 2026-09-20：给 skill 一个**资料基准目录** —— 宿主渲染时会告诉模型
      //   「Base directory for this skill: <path>；正文里写的相对路径按它解析」
      //   （`packages/skill/skill/src/index.ts:187-201` 的 renderResourceHint）。
      //   正文里那几份资料（`../README.md`、`refs/*.md`）于是不用写死绝对路径、也不随机器变。
      if (def.resourceBase === true) {
        try {
          skill.resourceBase = {
            kind: 'directory',
            // ⚠️ 去掉尾部斜杠：`fileURLToPath` 对以 `/` 结尾的 URL 会给出带分隔符的路径，
            //   留着会让面板/日志里显示成 `…\rp-assistant\`（拼路径没问题，但看着像没写完）。
            path: fileURLToPath(new URL(SKILL_SOURCE_DIR + def.dir, import.meta.url)).replace(/[\\/]+$/, ''),
          }
        } catch (e) {
          log.warn(`[mt] skill ${def.name} 的资料目录解析失败（正文里的相对路径可能读不到）：${e?.message || e}`)
        }
      }
      const dispose = skills.register(skill)
      if (!effectFn) {
        log.warn(`[mt] ctx.effect 不可用，skill ${def.name} 的 disposer 未能挂上生命周期（热重载可能残留）`)
      } else {
        // disposer 交给 fiber 生命周期（照抄 registerHttpApi 的 effect 写法）：热重载时
        // 旧 skill 被 dispose，不留同名僵尸（宿主对同名注册只 first-wins + warn）。
        run(() => wrapDispose(dispose), `dsh-memory-archive: skill ${def.name}`)
      }
      log.info(`[mt] skill 已注册：${def.name}`)
    } catch (e) {
      log.warn(`[mt] skill 注册失败，已跳过 ${def.name}：${e?.stack || e}`)
    }
  }
}

// ---------------------------------------------------------------------------
// 记忆回响（D2）接线：子 fiber（自带 systemPrompt 依赖）+ **入箱即算**的真缓存
//
// 为什么是"入箱即算"（这一版是踩过坑改出来的，别再改回装配期改写）：
//   · 段 provider **必须同步**（官方约束）⇒ 引擎算完的结果放缓存，provider 只返回缓存值；
//   · 时序：`agent-loop/src/agent.ts:245` 的 `systemPrompt.assemble()` 跑在
//     `agent/pre-step`(249) **之前**，而本轮的人类消息要到 `agent.ts:375` 才 append
//     ⇒ 装配期**拿不到**本轮输入，任何"装配期再算"都只能算上一轮；
//   · 但人类消息**更早**就以 `agent/inbox/spliced`（`inserted[].source.kind === 'user'`）
//     落进会话日志 —— 那是 turn 开始之前，天然早于本轮装配。此时取正文、同步刷新缓存，
//     装配时 provider 读到的就已经是本轮的值：**不早不晚**。
//   · ⛔ 不要再"算完改写 assembly.sections"：组装捕获（`sections-capture.js:452`）是
//     **先建记录、后 `next()`** 的快照式监听器 ⇒ 它记下的永远是瀑布上游那一刻的段文本。
//     靠"注册顺序"抢先只会让捕获显示 chars=0、而模型其实收到了内容（查看器与事实不符——
//     这正是上一版被沙箱真注入验收抓出来的账）。段文本只从 provider 出，捕获就必然一致。
// 失败语义：整块包在 try/catch 里，任何异常只记一行 warn ⇒ 回响是**增强**，失败静默跳过。
// ---------------------------------------------------------------------------

/** 有界等待：超时/失败都解析成 null（绝不抛、绝不挂住装配）。 */
function echoWithBudget(promise, ms) {
  return new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null) } }, ms)
    Promise.resolve(promise).then(
      (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v) } },
      () => { if (!done) { done = true; clearTimeout(timer); resolve(null) } },
    )
  })
}

/** 取「最近一轮」文本：复用 collectSurfaces 的便宜路径，只留尾部若干条**未被遮蔽**的正文。 */
async function echoLastTurnText(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  const sq = getService(ctx, 'sessionQuery')
  if (!sq) return null
  const bySeq = await collectSurfaces(sq, sessionId)
  const rows = [...bySeq.entries()]
    .filter(([, v]) => v && v.surface !== 'shadowed' && typeof v.text === 'string' && v.text.trim() !== '')
    .sort((a, b) => a[0] - b[0])
  const tail = rows.slice(-ECHO_QUERY_TAIL_DOCS).map(([, v]) => v.text).join('\n')
  return tail.trim() === '' ? null : tail
}

/**
 * 本会话**当前上下文的字数**（★ 带外算，喂给「最近几楼」的同步门）：
 * 会话里**未被遮蔽**（没被压缩掉）的那些消息正文的总字数。同一份 `collectSurfaces` 便宜路径。
 *
 * ⛔ 只数字数、不返回正文；拿不到就 null（调用方回退"首轮"判据，判不出不注）。
 */
async function sessionContextChars(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  const sq = getService(ctx, 'sessionQuery')
  if (!sq) return null
  const bySeq = await collectSurfaces(sq, sessionId)
  let n = 0
  for (const [, v] of bySeq) {
    if (!v || v.surface === 'shadowed') continue
    if (typeof v.text === 'string') n += v.text.length
  }
  return n
}

/**
 * ★★ 2026-09-20 起这是**面板视图**的周目目录（按 `config.root` = 用户显式在看哪个周目）：
 * Tavern 的绑定根（`<DSH_HOME>/pmp-dsh-tavern/play-workspace.json` 的 `rootPath`）
 * + 配置里的「角色-周目」⇒ `<rootPath>/<charId>/<playthroughId>`（**只读**）。
 *
 * ⚠️ **它不再给注入/写盘兜底** —— 笔记落点、最近几楼、回响的语料一律走 `sessionPlaythroughDir()`
 *    （会话优先，认不出 ⇒ 当新会话）。两者成对存在、口径不同，⛔ 别合并（见 `sessionPlaythroughOf`）。
 *
 * 返回：`dir` = 周目目录（archive/floors 的上一级）、`source` = `<charId>/<ptId>` 人话标注；
 * 另带 `rootPath/characterId/playthroughId` 三个原料 —— 读者（剧情大纲那档）要按同样的
 * 三元组拼 baseDir，照原样喂给它（别让它对 source 做字符串手术）。
 */
function rootPlaythroughDir() {
  try {
    const { config } = readConfigFile()
    const ch = config.root?.characterId
    const pt = config.root?.playthroughId
    if (typeof ch !== 'string' || ch === '' || typeof pt !== 'string' || pt === '') return null
    const rootPath = tavernRootPath()
    if (rootPath === '') return null
    return { dir: join(rootPath, ch, pt), source: ch + '/' + pt, rootPath, characterId: ch, playthroughId: pt }
  } catch {
    return null
  }
}

/**
 * Tavern 工作区根（`<DSH_HOME>/pmp-dsh-tavern/play-workspace.json` 的 `rootPath`）；拿不到 ⇒ `''`。
 * ★ 20260919 从 `rootPlaythroughDir()` 里提出来：**跟随当前会话**那条路要在"配置里还没绑定任何
 *   周目"时也能拿到根（那正是它最该发力的场合）⇒ 读根这件事不能绑在 config.root 上。
 *   ⛔ 语义与原来那一句完全相同（读不到 / 不是字符串 / 空串 ⇒ `''`）。
 */
function tavernRootPath() {
  try {
    const wsFile = join(dshHomeDir(), 'pmp-dsh-tavern', 'play-workspace.json')
    const ws = JSON.parse(readFileSync(wsFile, 'utf8'))
    return typeof ws?.rootPath === 'string' ? ws.rootPath : ''
  } catch {
    return ''
  }
}

/**
 * 「会话 → 周目」索引（读 `<rootPath>/catalog.json` + 每个周目的 `timeline.json`）。
 * 缓存键 = 根 + 每条 timeline 的 mtime，TTL 与 echo / lastFloors 同款（20s）。
 * ⛔ 只读；模块缺席 / 读不到 catalog ⇒ `null`（调用方如实回 `source:'none'`，不猜）。
 */
let sessionIndexCache = { key: '', val: null, at: 0 }
function sessionIndex() {
  if (sessionPlaythrough === null) return null
  const base = tavernRootPath()
  if (base === '') return null
  let entries = null
  try { entries = JSON.parse(readFileSync(join(base, 'catalog.json'), 'utf8'))?.playthroughs } catch { return null }
  if (!Array.isArray(entries)) return null
  const rows = []
  const parts = []
  for (const entry of entries) {
    const rel = typeof entry?.path === 'string' ? entry.path : ''
    const file = rel === '' ? '' : join(base, rel)
    let timeline = null
    let mt = 'x'
    if (file !== '') {
      try { mt = String(statSync(file).mtimeMs) } catch { mt = 'missing' }
      try { timeline = JSON.parse(readFileSync(file, 'utf8')) } catch { timeline = null }
    }
    parts.push(`${rel}|${mt}`)
    rows.push({ entry, timeline })
  }
  const key = `${base}::${parts.join(';')}`
  if (sessionIndexCache.key === key && Date.now() - sessionIndexCache.at < LAST_FLOORS_CACHE_TTL_MS) return sessionIndexCache.val
  const val = sessionPlaythrough.buildSessionIndex(rows)
  sessionIndexCache = { key, val, at: Date.now() }
  return val
}

/**
 * ★★ 2026-09-20（用户口径：「**认不出来的会话默认为新会话。会话优先**」）：
 * **本会话的周目** —— 全局唯一入口（笔记落点、最近几楼/回响的语料、都在这里取）。
 *
 * ⛔ 只认会话（Tavern 的 `catalog.json` + 各周目 `timeline.json`，走 `sessionIndex()`）；
 *    **认不出 ⇒ `null`，⛔ 绝不回落 `config.root`** —— 回落正是"新对话冒充上一轮"那件事的根：
 *    一条还没被 Tavern 认领的新会话会拿到**上一轮**的笔记目录 / 归档楼层 / 检索结果，
 *    而 `memory_write` 还会把笔记**静默写进上一轮的周目**。
 *    `config.root` 从此只当**面板的视图选择**（用户显式在看哪个周目），不再给任何注入/写盘路径兜底。
 *
 * ⚠️ 例外（都**不在这里**）：`config.root.sessionId`（会话模式下用户**显式**选的根会话）只还给
 *    `memoryArchiveRootString()` 那份可读绑定串用。★ 2026-09-22 起**自动收纳那道门也走会话优先**
 *    （`decideAutoCollect()`）—— 它原来是这条例外最大的消费者，而真机事故就是它把续接会话全误杀了。
 */
function sessionPlaythroughOf(sessionId) {
  if (sessionPlaythrough === null) return null
  const idx = sessionIndex()
  if (idx === null) return null
  const hit = sessionPlaythrough.resolveForSession(idx, sessionId)
  if (hit.source !== 'session' || hit.characterId === '' || hit.playthroughId === '') return null
  return { characterId: hit.characterId, playthroughId: hit.playthroughId }
}

/**
 * 本会话该用的「周目记忆库目录」。返回 `{ dir, playthroughId, source }` 或 `null`
 * （没绑工作区根 / **本会话认不出周目** —— 见 `sessionPlaythroughOf` 的口径）。
 * ⛔ 只拼路径，不建目录、不写盘。
 */
function memoryHomeFor(sessionId) {
  if (memoryWrite === null) return null
  const root = tavernRootPath()
  if (root === '') return null
  const hit = sessionPlaythroughOf(sessionId)
  if (hit === null) return null
  return {
    dir: join(root, hit.characterId, hit.playthroughId, memoryWrite.MEMORY_WRITE_DIR),
    playthroughId: hit.playthroughId, source: 'session',
  }
}

/**
 * 会话事件快照（只读）：活会话走 `session.snapshotEvents()`，老宿主退 `session.events`。
 * 拿不到 / 抛错 ⇒ 空数组（⛔ 绝不抛 —— 调用方按"认不出"处理）。
 */
function sessionEventsOf(session) {
  try {
    const ev = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : session?.events
    return Array.isArray(ev) ? ev : []
  } catch { return [] }
}

/** memory_write 的工具描述（面向 RP；⛔ 不写维护/诊断口径）。 */
const NOTE_WRITE_DESCRIPTION = [
  '把一段**剧情笔记**写进本会话周目的记忆库（.roleplay-memory/），供以后回忆用。',
  'path 用**相对本记忆库**的路径（如 notes.md / characters.md / world.md / index.md）；',
  'mode 默认 overwrite（整份替换），用 append 追加到末尾。',
  '⛔ 只在真的记东西时调；一次写一段完整的 —— 超预算会被**拒收**（那时拆成两次写，不要硬塞）。',
].join('\n')

/**
 * 注册 `memory_write` 工具（20260919 复活版）。
 *
 * ★ 为什么走**插件自己的 `node:fs`** 而不是 `ctx.fs`（用户 2026-09-19 原话：
 *   「当初那么绕是因为 tavern 有收回，不能写」）：绑了周目的 RP 会话里 Tavern 把沙箱钉成
 *   **read-only**，还有一个按工具名拦 write/edit/bash 的守卫 ⇒ 走沙箱的写落不下去。
 *   路径由本插件夹死（`relPathJail` + 只允许本会话周目的 `.roleplay-memory/`）⇒ 越界一律拒收。
 * ⛔ 绝不让异常冒到插件加载链上（任何失败只降级：不注册这个工具）。
 */
function registerNoteWriteTool(ctx, log) {
  if (memoryWrite === null) {
    log.warn(`[mt] 剧情笔记写入模块不可用，memory_write 未注册（${memoryWriteLoadError?.message || memoryWriteLoadError}）`)
    return
  }
  try {
    if (!ctx || typeof ctx.inject !== 'function') return
    ctx.inject(['tools'], (toolCtx) => {
      try {
        if (!toolCtx.tools || typeof toolCtx.tools.register !== 'function') {
          log.warn('[mt] tools 服务不可用 ⇒ memory_write 未注册')
          return
        }
        toolCtx.tools.register({
          name: memoryWrite.MEMORY_WRITE_TOOL,
          description: NOTE_WRITE_DESCRIPTION,
          parameters: {
            type: 'object', additionalProperties: false, required: ['path', 'text'],
            properties: {
              path: { type: 'string', description: '相对本记忆库的路径，例如 notes.md / characters.md / world.md / index.md' },
              text: { type: 'string', description: '要写入的整段内容（超单次上限会被拒收 ⇒ 拆成两次写）' },
              mode: { type: 'string', enum: ['overwrite', 'append'], description: 'overwrite（默认，整份替换）或 append（追加到末尾）' },
            },
          },
          output: {
            schema: {
              type: 'object', additionalProperties: false,
              required: ['path', 'mode', 'chars', 'bytes', 'playthroughId', 'source'],
              properties: {
                path: { type: 'string' }, mode: { type: 'string' },
                chars: { type: 'integer' }, bytes: { type: 'integer' },
                playthroughId: { type: 'string' }, source: { type: 'string' },
              },
            },
            render: (args, value) => [{
              type: 'text',
              text: `已写入 ${value.path}（${value.mode}，${value.chars} 字符）· 周目 ${value.playthroughId}`,
            }],
          },
          isConcurrencySafe: () => false,
          async execute(args, exec) {
            const cfgNow = (() => { try { return readConfigFile().config } catch { return {} } })()
            const sw = memoryWrite.readMemoryWriteSwitch(cfgNow)
            const sid = exec && exec.agent && exec.agent.session ? exec.agent.session.id : undefined
            const home = memoryHomeFor(sid)
            // ★★ 2026-09-20 口径：认不出周目 ⇒ **拒写**，⛔ 绝不替它落到"面板绑定的上一轮"去。
            //   文案要点出**怎么办**（去 Tavern 开/选周目），并说明面板那个绑定只是视图 —— 否则
            //   玩家会以为"面板显示着影子·11周目，为什么写不进去"。
            if (home === null) {
              throw new Error('这个会话还没归入任何周目 ⇒ 没有可写的记忆库目录。'
                + '先在 Tavern 里给它开/选一个周目（周目由 Tavern 的 catalog 认领；'
                + '记忆库面板里那个「工作区根」只是查看用的视图，不决定这里写哪儿）')
            }
            if (!relPathJail || typeof relPathJail.resolveUnderDir !== 'function') {
              throw new Error('相对路径裁决模块（rel-path-jail.js）不可用，拒绝写入')
            }
            const rel = typeof args?.path === 'string' ? args.path : ''
            const target = relPathJail.resolveUnderDir(home.dir, rel)
            if (!target.ok) throw new Error(`path 未通过路径裁决：${target.reason}`)
            const decided = memoryWrite.decideNoteWrite({
              enabled: sw.enabled, relPath: rel, text: args?.text, maxChars: sw.maxChars, mode: args?.mode,
            })
            if (!decided.write) {
              if (decided.reason === 'switch-off') throw new Error('记忆写入未启用：面板/配置里 memoryWrite.enabled 没打开')
              if (decided.reason === 'over-budget') {
                throw new Error(`这一段 ${decided.chars} 字符，超过单次上限 ${decided.maxChars} ⇒ 请拆成两次写（⛔ 不会截断硬写）`)
              }
              throw new Error(`拒写：${decided.reason}`)
            }
            // ★★ 2026-09-20 **尊重沙箱**（用户口径：「尊重，tarven里有关沙箱的设置」）：
            //   本工具的写盘走插件自家的 `node:fs` ⇒ **绕得过**宿主沙箱（那是刻意的，见 lib/memory-write.js 文件头）。
            //   所以"只读"这件事必须**由我们自己认账** —— 判据 = 会话事件里最后一个 `sandbox/mode`
            //   （与上游 `RpModeController` 同一套取值；见 memory-write.js 的 foldSandboxMode）。
            const sandboxMode = memoryWrite.foldSandboxMode(sessionEventsOf(exec?.agent?.session))
            const sandbox = memoryWrite.sandboxDecision(sandboxMode)
            if (!sandbox.allow) {
              throw new Error('本会话的文件沙箱是**只读**（Tavern 的「RP 模式（高风险锁定）」钉的）⇒ 拒写，⛔ 不绕过。'
                + '要让它写笔记：把角色卡上的 RP 模式关掉（或在聊天里发 /rp off），沙箱恢复后再写。')
            }
            try { mkdirSync(dirname(target.absPath), { recursive: true }) } catch { /* 已存在或并发建，忽略 */ }
            if (decided.mode === 'append') appendFileSync(target.absPath, args.text, 'utf8')
            else writeFileSync(target.absPath, args.text, 'utf8')
            log.info(`[mt] memory_write：${target.relPath}（${decided.mode}，${decided.chars} 字符 → 周目 ${home.playthroughId}）`)
            return {
              path: target.relPath, mode: decided.mode, chars: decided.chars,
              bytes: Buffer.byteLength(args.text, 'utf8'),
              playthroughId: home.playthroughId, source: home.source,
            }
          },
        })
      } catch (e) {
        log.warn(`[mt] memory_write 注册失败（已降级）：${e?.message || e}`)
      }
    })
  } catch (e) {
    log.warn(`[mt] memory_write 接线失败（已降级）：${e?.message || e}`)
  }
}

/**
 * ★★ 2026-09-20（用户口径「先统一落点」）：**跨周目共用的预置资料**目录 = 工作区根下的
 * `.roleplay-memory/`（`<rootPath>/.roleplay-memory`）。
 *
 * 用途：想让**新周目开局就带上下文**时，把要预置的文件（角色设定 / 世界书 / 写作规矩一类）放这儿。
 * ⚠️ 为什么"提前"只能提到这儿：周目目录名里带**新建时才知道的 UUID**（`playthrough-<uuid>`）
 *   ⇒ **不可能**在周目建立前把文件放进那个周目目录；工作区根是唯一"建立前就存在"的地方。
 * ⛔ **只读**：它不进 `memory_write`（那会让所有周目写串味 —— 一个周目写的笔记会被别的周目看见）。
 * ⛔ 只有目录**真的在**才返回（段里不许报一条不存在的路径让模型去撞）。
 */
function sharedRpMemoryDir() {
  const rootPath = tavernRootPath()
  if (rootPath === '') return null
  const dir = join(rootPath, RP_MEMORY_DIR_NAME)
  return isDirectorySafe(dir) ? { dir } : null
}

/**
 * 段 `mt:memoryHome`（order 2，★ 2026-09-19 用户口径「要更靠前一点，放在 mt:memoryProtocol 后面」）：
 * 把**本会话的记忆库目录**告诉模型 —— RP 提示词里"路径由注入给出"
 * 指的就是这一段。**会话优先**（认不出周目 ⇒ **空段**，不注入半句）。
 *
 * ★★ 2026-09-20（「先统一落点」）：工作区根那份**共用预置**目录也一并说清楚（只读、开局参考）。
 *   两处的关系必须写明：**本局的真相永远是周目目录**，共用那份是素材，⛔ 不是写的地方。
 * ★★ 2026-09-23（死区）：段尾追加**死区约束**（`renderHint`：文件名 + 那段首行原文 + "只有追加权"）。
 *   ⛔ 死区原文**整段不进注入**（只给首行摘要，别把上下文撑爆）；没有死区 ⇒ 那几行不出现。
 */
function registerMemoryHome(ctx, log) {
  if (memoryWrite === null) return
  try {
    if (!ctx || typeof ctx.plugin !== 'function') return
    ctx.plugin({
      name: 'dsh-memory-archive:memory-home',
      inject: ['systemPrompt'],
      apply(scope) {
        scope.effect(() => scope.systemPrompt.section({
          name: 'mt:memoryHome',
          order: 2,
          text: (assembleContext) => {
            try {
              const sid = assembleContext?.agent?.session?.id
              const home = memoryHomeFor(sid)
              if (home === null) return ''
              const shared = sharedRpMemoryDir()
              return [
                '<memoryHome>',
                `本会话的剧情笔记目录：${home.dir}`,
                '一个周目一份 —— **只往这里写**，⛔ 不要写到别的周目目录。',
                shared === null
                  ? ''
                  : `跨周目共用的预置资料（**只读**，⛔ 别改也别往里写）：${shared.dir}`,
                shared === null
                  ? ''
                  : '  那一份是给**开局参考**用的（设定/世界书一类，所有周目共享）；**本局的真相永远是上面那个目录**。',
                deadzoneHintFor(sid),
                '</memoryHome>',
              ].filter((line) => line !== '').join('\n')
            } catch { return '' }
          },
        }), 'memoryHome.section()')
      },
    })
  } catch (e) {
    log.warn(`[mt] 记忆库路径段接线失败（已降级）：${e?.message || e}`)
  }
}

// ---------------------------------------------------------------------------
// 「剧情文本死区（模型禁改区）」的接线（2026-09-23）
//
// 三件事，各自只有一处实现（⛔ 不两处各写一遍）：
//   ① **喂约束**：`mt:memoryHome` 段尾追加死区那句（`deadzoneHintFor`，见上）；
//   ② **比一对**：每轮**至多一次**，拿 `.dma-deadzones.json` 的快照与盘上现况比（`deadzone.compareZones`），
//      不一致就**告警**（日志 + 结果文件给面板红字读）；
//   ③ ⛔ **绝不还原**：本模块里**没有任何一处**会把快照写回剧情文本（用户明确否掉了那个选项）。
//
// 落点（★ 与会话优先那条口径同源）：本会话解析出的周目 ⇒ 候选链
// `周目目录/.roleplay-memory` → `工作区根/.roleplay-memory`，**带死区文件的那一处赢**
// （真机上笔记落在工作区根那份，死区跟着笔记走）。⛔ 不用 `config.root` 兜底（那是面板的视图）。
// ---------------------------------------------------------------------------

/** 死区文档的读缓存（键 = 目录 + mtime + 大小）：段 provider 每轮都会问，别每轮真读一次盘。 */
let deadzoneDocCache = { dir: '', mtimeMs: -1, size: -1, doc: null, error: null }

/** 本会话该读哪一处死区文档（会话优先；两处都没有死区文件 ⇒ `null`）。 */
function deadzoneHomeFor(sessionId) {
  if (deadzone === null) return null
  const hit = sessionPlaythroughOf(sessionId)
  if (hit === null) return null
  const rootPath = tavernRootPath()
  if (rootPath === '') return null
  const dirs = [
    { base: 'playthrough', dir: join(rootPath, hit.characterId, hit.playthroughId, RP_MEMORY_DIR_NAME) },
    { base: 'workspace-root', dir: join(rootPath, RP_MEMORY_DIR_NAME) },
  ]
  const found = dirs.find((d) => deadzone.docExists(d.dir))
  return found === undefined ? null : { dir: found.dir, base: found.base, playthroughId: hit.playthroughId }
}

/** 读死区文档（带 mtime 缓存；文件不在 ⇒ 空文档）。⛔ 只读，绝不建目录/绝不写盘。 */
function deadzoneDocOf(dir) {
  let st = null
  try { st = statSync(join(dir, deadzone.DEADZONE_FILE_NAME)) } catch { st = null }
  if (st === null) {
    if (deadzoneDocCache.dir !== dir) deadzoneDocCache = { dir, mtimeMs: -1, size: -1, doc: deadzone.emptyDoc(), error: null }
    return { doc: deadzoneDocCache.doc, error: deadzoneDocCache.error }
  }
  if (deadzoneDocCache.dir === dir && deadzoneDocCache.mtimeMs === st.mtimeMs && deadzoneDocCache.size === st.size) {
    return { doc: deadzoneDocCache.doc, error: deadzoneDocCache.error }
  }
  const read = deadzone.readDocFile(dir)
  deadzoneDocCache = { dir, mtimeMs: st.mtimeMs, size: st.size, doc: read.doc, error: read.error }
  return { doc: read.doc, error: read.error }
}

/**
 * 段里那句死区约束（没有死区 / 认不出周目 ⇒ 空串）。
 * ⛔ 只给摘要；那一处在**共用**落点上时额外点明目录（否则模型会去错目录找那几段）。
 */
function deadzoneHintFor(sessionId) {
  try {
    const home = deadzoneHomeFor(sessionId)
    if (home === null) return ''
    const read = deadzoneDocOf(home.dir)
    if (read.error !== null) {
      return `⚠ 死区数据（${deadzone.DEADZONE_FILE_NAME}）读不出来（${read.error}）—— 作者设的禁改区这次没能生效，⛔ 别猜哪几段是死区。`
    }
    const hint = deadzone.renderHint(read.doc)
    if (hint === '') return ''
    return home.base === 'playthrough' ? hint : hint + `\n（以上死区在那份共用目录里：${home.dir}）`
  } catch {
    return ''
  }
}

function deadzoneStatusPath() {
  return join(storageDir(), DEADZONE_STATUS_FILE)
}

/** 每轮那条看守最近一次的结果（按周目取；⛔ 别的周目的记录当没有，不拿它冒充本局）。 */
function readDeadzoneStatus(playthroughId) {
  try {
    const doc = JSON.parse(readFileSync(deadzoneStatusPath(), 'utf8'))
    if (!isPlainObject(doc)) return null
    if (typeof playthroughId === 'string' && playthroughId !== '' && doc.playthroughId !== playthroughId) return null
    return doc
  } catch {
    return null
  }
}

function writeDeadzoneStatus(doc) {
  try {
    const dir = storageDir()
    mkdirSync(dir, { recursive: true })
    const finalPath = deadzoneStatusPath()
    const tmpPath = finalPath + '.tmp'
    writeFileSync(tmpPath, JSON.stringify(doc) + '\n', 'utf8')
    renameSync(tmpPath, finalPath)
  } catch { /* 状态写不进去不影响判据本身（下一轮还会再算一次） */ }
}

/** 已经写过的「比对结果指纹」（按目录）：⛔ 结果没变就**一个字节都不重写**（用户口径）。 */
const deadzoneWritten = new Map()

/**
 * 一轮的比对（**异步、绝不抛**；调用方 `void … .catch()`）：
 * 结果与上一次**完全相同** ⇒ 什么都不做（⛔ 不刷状态文件）；变了（含从"一致"变"不一致"）⇒
 * 写结果文件 + 不一致时**大声告警**（日志如实记一条，文案**不定性**）。
 */
async function runDeadzoneCheck(sessionId, log) {
  if (deadzone === null) return
  const home = deadzoneHomeFor(sessionId)
  if (home === null) return
  const read = deadzoneDocOf(home.dir)
  if (read.error !== null) {
    const key = home.dir + '|error:' + read.error
    if (deadzoneWritten.get(home.dir) !== key) {
      deadzoneWritten.set(home.dir, key)
      writeDeadzoneStatus({ at: new Date().toISOString(), playthroughId: home.playthroughId, status: 'error', docError: read.error, zones: 0, changed: [] })
      try { log.warn(`[mt] ⚠ 死区数据（${deadzone.DEADZONE_FILE_NAME}）读不出来（${read.error}）：作者设的禁改区**这次没能生效**`) } catch {}
    }
    return
  }
  if (read.doc.zones.length === 0) return   // 没设死区 ⇒ 这一轮什么都不做（零开销路径）
  const files = [...new Set(read.doc.zones.map((z) => z.file))].slice(0, DEADZONE_STATUS_MAX_FILES)
  const fileTexts = {}
  for (const f of files) {
    if (!rpMemoryNameOk(f)) { fileTexts[f] = null; continue }
    try { fileTexts[f] = readFileSync(join(home.dir, f), 'utf8') } catch { fileTexts[f] = null }
  }
  const report = deadzone.compareZones(read.doc, fileTexts)
  const fingerprint = home.dir + '|' + report.changed.map((c) => `${c.file}:${c.state}:${c.nowSha ?? '-'}`).join(',')
  if (deadzoneWritten.get(home.dir) === fingerprint) return   // ★ 拿"上次的比对结果"做闸门：不重写
  deadzoneWritten.set(home.dir, fingerprint)
  writeDeadzoneStatus({
    at: new Date().toISOString(), playthroughId: home.playthroughId, base: home.base,
    status: report.status, zones: report.zones, changed: report.changed,
  })
  if (report.changed.length === 0) return
  try {
    const items = report.changed.map((c) => {
      const where = `${c.file} 的「${c.firstLine}」`
      if (c.state === 'missing-file') return `${where}（那份文件现在读不到）`
      if (c.state === 'missing') return `${where}（那一段在现文里找不到了）`
      return `${where}（快照 ${String(c.snapSha).slice(0, 12)}… → 现况 ${String(c.nowSha).slice(0, 12)}…）`
    })
    log.warn(`[mt] ⚠ 死区内容与快照不符（**可能是模型改的，也可能是你在别处改过**）—— 共 ${report.changed.length} 处：`
      + items.join('；') + '。⛔ 本插件不会替你改回去，文件始终是你的（面板「剧情大纲」档有红字详情）')
  } catch {}
}

/**
 * 接线：**新周目自动挂 RP 预设**（挂 `agent/created`，⛔ 不是 `system-prompt/assemble` 那条瀑布）。
 *
 * 判据全在 `lib/rp-preset-attach.js`（纯函数，台子直测）；这里只把 DSH_HOME 与取服务的口子递进去。
 * 它**不改任何段**，所以注册位置对它无所谓 —— 但还是放在组装捕获之前那一段里，方便一眼看全。
 */
function registerRpPresetAttach(ctx, log) {
  if (rpPresetAttach === null) {
    log.warn(`[mt] 新周目挂预设未接线（${rpPresetAttachLoadError?.message || rpPresetAttachLoadError}）`)
    return
  }
  try {
    const r = rpPresetAttach.registerRpPresetAttach(ctx, {
      log,
      dshHome: dshHomeDir(),
      getService,
    })
    if (r?.installed) log.info('[mt] 新周目挂预设已接线（agent/created → agentPresets.select）')
    else log.warn(`[mt] 新周目挂预设未接线（${r?.reason || 'unknown'}）`)
  } catch (e) {
    log.warn(`[mt] 新周目挂预设接线失败（已降级）：${e?.message || e}`)
  }
}

/**
 * 接线：每轮**至多一次**的死区看守（挂 `system-prompt/assemble`，与回响/最近几楼同一条瀑布）。
 *
 * 三条纪律（用户口径）：
 *   · **每轮至多一次** —— 门 = `turnBoundary.lastTurn`（同款判据见「最近几楼」），取不到就退到
 *     一个最小间隔（同一轮里装配被调多次时也只会查一次）；
 *   · **不许阻塞轮次** —— 本监听**一个字都不 await**：装完就 `return next()`，
 *     比对那件事用 `setTimeout(…, 0)` 排到本轮之外再跑（`void … .catch()`，绝不抛）；
 *   · **不许每轮重写状态文件** —— 见 `deadzoneWritten` 那道指纹闸门。
 */
function registerDeadzoneWatch(ctx, log) {
  if (deadzone === null) {
    log.warn(`[mt] 死区看守未接线（${deadzoneLoadError?.message || deadzoneLoadError}）`)
    return
  }
  if (!ctx || typeof ctx.plugin !== 'function') {
    log.warn('[mt] ctx.plugin 不可用，死区看守未接线')
    return
  }
  ctx.plugin({
    name: 'dsh-memory-archive:deadzone-watch',
    inject: ['systemPrompt'],
    apply(scope) {
      const perTurn = new Map() // sid → {turn, at}：这一轮查过没有（LRU 上限 64）
      scope.on('system-prompt/assemble', async (assembly, assembleContext, next) => {
        try {
          const sid = assembleContext?.agent?.session?.id
          if (typeof sid === 'string' && sid !== '') {
            let turn = null
            try {
              turn = getService(scope, 'sessionProjections')?.stateOf?.(assembleContext?.agent?.session, 'turnBoundary')?.lastTurn
            } catch { turn = null }
            if (!Number.isFinite(turn)) {
              try { turn = assembleContext?.agent?.phase?.turn } catch { turn = null }
            }
            const last = perTurn.get(sid)
            const sameTurn = Number.isFinite(turn) && last !== undefined && last.turn === turn
            const tooSoon = !Number.isFinite(turn) && last !== undefined && (Date.now() - last.at) < DEADZONE_FALLBACK_MIN_MS
            if (!sameTurn && !tooSoon) {
              perTurn.delete(sid)
              perTurn.set(sid, { turn: Number.isFinite(turn) ? turn : null, at: Date.now() })
              while (perTurn.size > 64) perTurn.delete(perTurn.keys().next().value)
              // ★ 排到**这一轮之外**再跑（`setTimeout 0` + `unref`，与自动收纳的延迟触发同款）——
              //   组装这一脚**立刻** `return next()`：读盘/比对一点不占本轮的时间。
              const timer = setTimeout(() => {
                void Promise.resolve(runDeadzoneCheck(sid, log)).catch(() => {})
              }, 0)
              if (typeof timer.unref === 'function') timer.unref()
            }
          }
        } catch { /* 看守失败绝不影响这一轮装配 */ }
        return next()
      })
    },
  })
  log.info('[mt] 死区看守已接线（每轮至多查一次；只喂约束 + 检测告警，⛔ 绝不自动还原）')
}

// ---------------------------------------------------------------------------
// 「**按楼层绑定**的笔记快照 + **回档提示（手动挡）**」的接线（2026-09-23；★ 2026-09-24 改口径）
//
// 用户口径（2026-09-23）：「**能不能做按楼层绑定管理的功能，也就是每轮模型修改都记录，能自动跟随回档**」；
// ★★ 2026-09-24 改口径（用户原话）：「**不要做跟随楼层的功能，先做手动挡**，开 fork 时（回档）
// **前台弹提示，让用户手动回退剧情档案**。做**更显著的更改表示**」。
// 锚 = Tavern `timeline.json` 的**节点 + 变体**（`head = {nodeId, variantId}` = 当前站在哪一楼哪一支；
// ★ 2026-09-23 用户拍板：**同一楼换变体（swipe 重 roll）也算回档**）；判据与落盘全在
// `lib/floor-snapshot.js`（纯函数 + 薄薄一层 IO），这里只做四件事，各自也只有一处实现：
//   ① **认地方**：本会话那个周目的记忆库目录（会话优先 + "笔记在哪一处"优先 —— `floorHomeFor`）；
//   ② **记**：轮末（`turn/end` / `compaction/end`）比一次那 5 份，**变了才**落一份 `(楼层, 变体)` 快照；
//   ③ **提示**（★ 改口径）：组装时（每轮至多一次）+ 轮末各判一次回档，判到**只往清单里记一条 `pending`**
//      （幂等：同一次回档不刷 `at`）⇒ 面板档顶弹一条**显著**横幅；⛔ **那 5 份一个字节都不写**
//      —— 写盘只在用户点了「把档案退回第 N 楼」之后走 `POST …/floors/restore` 那一脚（唯一写入口）；
//   ④ ⛔ **不碰别的**：只写那 5 份 + 我们自己的 `.dma-floor-snapshots/`；★ 死区那几段**按块合并**
//      （非死区块照快照、死区块保留盘上现况 —— 判据只有 `.dma-deadzones.json` 那一处），
//      ⛔ 作者预置一个字都不动，⛔ 不碰会话、⛔ 不碰归档、⛔ 不碰 Tavern 的任何文件（时间线/周目目录**只读**）。
// ---------------------------------------------------------------------------

/** 时间线缓存（键 = 路径 + mtime + 大小）：判回档每轮都要问它，⛔ 别每轮真读一次盘。 */
let floorTimelineCache = { key: '', timeline: null }

/** 这一块里的小工具：字符串归一（`''` = 认不出），只给下面的回执/指纹用。 */
const floorStr = (v) => (typeof v === 'string' ? v : '')

/**
 * 某个周目的 `timeline.json`（从 Tavern 的 `catalog.json` 找到它那一条；⛔ 只读）。
 * 拿不到（没绑工作区根 / 这个周目不在 catalog 里 / 文件读不出来）⇒ `null` —— 调用方据此**安静跳过**
 * （拿不到时间线就没有"楼层"可言，⛔ 不猜、⛔ 不写）。
 */
function playthroughTimeline(characterId, playthroughId) {
  try {
    const rootPath = tavernRootPath()
    const wantId = typeof playthroughId === 'string' ? playthroughId : ''
    if (rootPath === '' || wantId === '' || sessionPlaythrough === null) return null
    let entries = null
    try { entries = JSON.parse(readFileSync(join(rootPath, 'catalog.json'), 'utf8'))?.playthroughs } catch { return null }
    if (!Array.isArray(entries)) return null
    for (const entry of entries) {
      if (sessionPlaythrough.playthroughIdOf(entry) !== wantId) continue
      const ch = sessionPlaythrough.characterIdOf(entry)
      if (typeof characterId === 'string' && characterId !== '' && ch !== '' && ch !== characterId) continue
      const rel = typeof entry?.path === 'string' ? entry.path : ''
      if (rel === '') return null
      const file = join(rootPath, rel)
      let st = null
      try { st = statSync(file) } catch { return null }
      const key = `${file}|${st.mtimeMs}|${st.size}`
      if (floorTimelineCache.key === key) return floorTimelineCache.timeline
      let timeline = null
      try { timeline = JSON.parse(readFileSync(file, 'utf8')) } catch { timeline = null }
      floorTimelineCache = { key, timeline }
      return timeline
    }
    return null
  } catch {
    return null
  }
}

/** 候选链 + 「这一处有什么」的探针（判"笔记与我们的快照在哪一处"用；⛔ 不读任何正文）。 */
function floorCandidates(hit) {
  const floor = floorSnapshot === null ? { hasAnyFloorFile: () => false, indexExists: () => false } : floorSnapshot
  return rpMemoryCandidates(hit).map((c) => {
    const isDir = isDirectorySafe(c.dir)
    return {
      base: c.base, label: c.label, dir: c.dir, isDir,
      hasNotes: isDir && floor.hasAnyFloorFile(c.dir),
      hasIndex: isDir && floor.indexExists(c.dir),
      hasDeadzone: isDir && deadzone !== null && deadzone.docExists(c.dir),
    }
  })
}

/**
 * 本会话该用哪一处记忆库做楼层快照（★ 会话优先；⛔ **不回落 `config.root`** —— 那是面板的视图，
 * 回落正是"新对话冒充上一轮"那件事的根，见 `sessionPlaythroughOf`）。
 * 两处都不是目录 ⇒ `null`：还没有笔记可记（安静跳过，⛔ 绝不替谁建目录）。
 */
function floorHomeFor(sessionId) {
  if (floorSnapshot === null) return null
  const hit = sessionPlaythroughOf(sessionId)
  if (hit === null) return null
  const rootPath = tavernRootPath()
  if (rootPath === '') return null
  // ⚠️ `sessionPlaythroughOf` 只给 `{characterId, playthroughId}`（**没有**现成的周目目录），
  //    而候选链要的是 `{dir, rootPath}` ⇒ 在这里按**同一份拼法**造出来（与 `deadzoneHomeFor` 一模一样：
  //    `周目目录 = <工作区根>/<角色>/<周目>`）。⛔ 别拿一个缺字段的对象去喂 `rpMemoryCandidates`。
  const ranked = floorSnapshot.rankMemoryHomes(
    floorCandidates({ dir: join(rootPath, hit.characterId, hit.playthroughId), rootPath }),
  )
  if (ranked.hit === null) return null
  return {
    dir: ranked.hit.dir, base: ranked.hit.base, baseLabel: ranked.hit.label,
    characterId: hit.characterId, playthroughId: hit.playthroughId, source: 'session',
  }
}

/** 面板那条路（按**面板绑定的周目**认地方；与上面**同一份**排序判据 —— ⛔ 不两处各写一遍）。 */
function floorHomeBound() {
  if (floorSnapshot === null) return null
  const hit = rootPlaythroughDir()
  if (hit === null) return null
  const ranked = floorSnapshot.rankMemoryHomes(floorCandidates(hit))
  if (ranked.hit === null) return null
  return {
    dir: ranked.hit.dir, base: ranked.hit.base, baseLabel: ranked.hit.label,
    characterId: hit.characterId, playthroughId: hit.playthroughId, source: 'bound',
  }
}

/**
 * **死区那几条数据**（`doc.zones`）= "哪几段不许碰"的**唯一判据**（来自 `.dma-deadzones.json`）。
 * ⚠️ 数据在、但读不出来 / 不是合法 JSON ⇒ `null` = **判据未知** ⇒ 恢复整次不做
 *   （⛔ 宁可这次不跟随，也不赌"这一份不在死区里"；fail-closed 照旧）。
 * ⚠️ 返回的是**整条 zone**（不是文件名清单）：回档侧按**块**合并，而"这一段是不是死区"的判据
 *   （`file` + 块首行/sha）只有 `deadzone.js` 有 ⇒ ⛔ 本模块不另立一份。
 */
function floorDeadZones(dir) {
  if (deadzone === null) return null
  const read = deadzone.readDocFile(dir)
  if (read.error !== null) return null
  return read.doc.zones
}

/** 「楼同步」最近一次**报没报过**的指纹（按记忆库目录）：⛔ 结果没变就不重写状态文件、不重记日志。 */
const floorWritten = new Map()

function floorStatusPath() {
  return join(storageDir(), FLOOR_STATUS_FILE)
}

/** 最近一次回档跟随的结果（按周目取；⛔ 别的周目的记录当没有，不拿它冒充本局）。 */
function readFloorStatus(playthroughId) {
  try {
    const doc = JSON.parse(readFileSync(floorStatusPath(), 'utf8'))
    if (!isPlainObject(doc)) return null
    if (typeof playthroughId === 'string' && playthroughId !== '' && doc.playthroughId !== playthroughId) return null
    return doc
  } catch {
    return null
  }
}

function writeFloorStatus(doc) {
  try {
    const dir = storageDir()
    mkdirSync(dir, { recursive: true })
    const finalPath = floorStatusPath()
    const tmpPath = finalPath + '.tmp'
    writeFileSync(tmpPath, JSON.stringify(doc) + '\n', 'utf8')
    renameSync(tmpPath, finalPath)
  } catch { /* 状态写不进去不影响判据本身（下一轮还会再算一次） */ }
}

/** 回执 → 人话（**唯一一处措辞**：日志与面板的「最近一次」都读它，⛔ 不两处各写一句）。 */
function floorReceiptText(home, receipt) {
  const kind = receipt?.kind
  const rest = receipt?.restore ?? null
  const from = rest?.from?.seq ?? null
  const to = rest?.seq ?? null
  /** ★ 回档那一脚说的是 **head 站在哪一楼**（`headSeq`）；手动那一脚说的是**你点的那一楼**。
   *  —— "退回进楼前"时这两个**不是**同一楼，⛔ 别混着说。
   *  ★ 2026-09-24：回档改手动挡后这一支**没有 `restore`**（`rest === null`）⇒ `headSeq` 改读回执
   *  顶层的那个（判据那一层给的）。 */
  const at0 = kind === 'rollback' ? (Number.isFinite(receipt?.headSeq) ? receipt.headSeq : to) : to
  const seat = (n) => (Number.isFinite(n) ? `第 ${n} 楼` : '未知楼层')
  const names = (list) => (list.length === 0 ? '无' : list.join('、'))
  const branch = (v) => (typeof v === 'string' && v !== '' ? v : '不知道哪一支')
  /** 「这次跳过了什么」的人话。★ `deadzone` 的语义已改口径（2026-09-23）：
   *  不再是"整份跳过"，而是"该文件有死区、**已按块合并**"（死区那几段保留盘上现况）。 */
  const skipText = (list) => list.map((s) => {
    if (s.reason === 'deadzone') {
      const kept = Array.isArray(s.kept) ? s.kept.length : 0
      const dropped = Array.isArray(s.dropped) ? s.dropped.length : 0
      const appended = Array.isArray(s.appended) ? s.appended.length : 0
      const bits = []
      if (s.merged === true) {
        bits.push(kept > 0
          ? `死区那 ${kept} 段保留盘上现况、其余照快照回档`
          : '其余照快照回档')
      } else {
        bits.push('死区按块合并后与盘上现况一样，没写')
      }
      if (dropped > 0) bits.push(`盘上找不到的 ${dropped} 段没补回（⛔ 死区内容不擅自写回去）`)
      if (appended > 0) bits.push(`盘上有、这一楼没有的 ${appended} 段保留在末尾`)
      return s.name + '（' + bits.join('；') + '）'
    }
    const why = s.reason === 'absent-then' ? '那一楼本来就没有这份'
      : s.reason === 'no-content' ? '那一楼的正文没存下来（读不到）'
        : s.reason === 'unchanged' ? '与那一楼逐字节一样'
          : s.reason === 'not-target' ? '不在那 5 份里'
            : String(s.reason)
    return s.name + '（' + why + '）'
  })
  // ★★ 2026-09-24 改口径（用户拍板「**不要做跟随楼层的功能，先做手动挡**」）：
  //   判到回档 ⇒ **只提示、⛔ 那 5 份一个字节都不写**（写盘要人在面板上点「把档案退回第 N 楼」）
  //   ⇒ 回档那一支的回执**没有 `restore`**（`rest === null`），说的是清单里那条 `pending`。
  //   ⚠️ 面板按**纯文本**渲染这一句 ⇒ ⛔ 不用 `**` 那种强调写法（星号会原样显示）。
  if (kind === 'rollback' && rest === null) {
    // ⚠️ 这一支**一定**有那条 `pending`（判据认出 rollback 就必定有 target ⇒ `planPending` 必给一条）——
    //   `p === null` 那条老分支（"这一档你点过「保持现状」⇒ 不再提示"）已随"就地登记"一起作废：
    //   现在点「保持现状」是**把 last 锚到当前这一楼**，之后判据根本不会再认成回档。
    const p = receipt && isPlainObject(receipt.pending) ? receipt.pending : null
    const toSeq = p !== null && Number.isFinite(p.toSeq) ? p.toSeq : at0
    const fromSeq = p !== null && Number.isFinite(p.fromSeq) ? p.fromSeq : (Number.isFinite(receipt?.lastSeq) ? receipt.lastSeq : from)
    const pre = p !== null && p.why === 'variant'
      ? `检测到${seat(toSeq)}换了变体（swipe 重 roll：${branch(p.fromVariantId)} → ${branch(p.toVariantId)}）`
      : `检测到回档到${seat(toSeq)}（从${seat(fromSeq)}）`
    const usedPrev = p === null ? '' : p.source === 'prev'
      ? `（${seat(p.toSeq)}这一支没记过 ⇒ 要退回的是"进这一楼之前"的样子，用的是${seat(p.targetSeq)}那一份）`
      : ''
    return pre + ' ⇒ ⛔ 这次一个字节都没写（回档不再自动跟随）：要把剧情档案退回'
      + seat(p === null ? null : p.targetSeq) + '得由你在面板上点' + usedPrev
      + '。⛔ 那 5 份一个字节都没动，⛔ 不影响会话，⛔ 预置那几份一个字都不动。'
  }
  if (kind === 'manual') {
    // ⚠️ 面板按**纯文本**渲染这一句 ⇒ ⛔ 不用 `**` 那种强调写法（星号会原样显示）。
    const targetVariant = typeof rest?.target?.variantId === 'string' && rest.target.variantId !== ''
      ? ' · ' + branch(rest.target.variantId)
      : ''
    const pre = `面板点了「回到这一楼」（${seat(to)}${targetVariant}）`
    if (rest?.blocked === 'deadzones-unreadable') {
      return pre + ' ⇒ ⚠ 死区数据读不出来（那几段的判据未知）⇒ 这次不敢恢复（怕碰死区里的内容），笔记保持原样'
    }
    const usedPrev = rest?.source === 'prev' && rest?.target !== null && rest?.target !== undefined
      ? `（这一楼这一支没记过 ⇒ 退回"进这一楼之前"的样子，用的是${seat(rest.target.seq)}那一份）`
      : ''
    const bits = [
      `已把笔记恢复到${seat(to)}的样子${usedPrev}（恢复 ${names(rest?.moved?.map((m) => m.name) ?? [])}）`,
      (rest?.skipped ?? []).length > 0 ? `跳过/按块合并 ${skipText(rest.skipped).join('、')}` : '',
      (rest?.failed ?? []).length > 0 ? `⚠ 没写进去 ${(rest.failed).map((f) => f.name + '（' + f.reason + '）').join('、')}` : '',
      '⛔ 预置那几份没动',
    ].filter((s) => s !== '')
    return pre + ' ⇒ ' + bits.join('；')
  }
  if (kind === 'back-no-snapshot') {
    const legacy = receipt?.legacyAtHead === true
      ? '（这一楼只有老记录：只有 nodeId、不知道是哪一支 ⇒ 老记录只读、不许拿来恢复）'
      : ''
    const tail = receipt?.prevNodeId === null || receipt?.prevNodeId === undefined
      ? '连前一楼也没有（这是第一楼）'
      : '前一楼也没有能用的快照'
    return `检测到回档到${seat(receipt?.restore?.seq ?? null)}，但这一楼没有能用的快照、${tail} ⇒ 笔记保持原样${legacy}`
  }
  if (kind === 'legacy-no-restore') {
    return '这一楼只有老记录（只有 nodeId、不知道是哪一支）⇒ 老记录只读、不许拿来恢复 ⇒ 笔记保持原样'
  }
  if (kind === 'unknown-order') return '楼层换了，但认不出它在时间线里的先后 ⇒ ⛔ 不动笔记（⛔ 不拿时间戳猜）'
  if (kind === 'index-error') return `⚠ 楼层快照清单读不出来（${receipt?.error}）⇒ 这个周目的记录与回档跟随本轮都跳过（面板「剧情大纲」档能看到）`
  if (kind === 'no-head') return '还没有楼层（时间线的 head 为空）⇒ 这一轮不记快照（开局第一轮很正常）'
  return ''
}

/**
 * 如实播报（日志 + 状态文件）。三档纪律：
 *   · **真回档跟随**（没失败）⇒ **每次都报**（这是用户要看见的那件事）；
 *   · **没快照 / 认不出版序 / 清单读不出来 / 还没楼层** ⇒ 也报，但**同一个结果只报一次**
 *     （指纹门：⛔ 不每个 step 刷一遍屏 —— 与死区看守同款）；
 *   · 没回档、没有变化 ⇒ **什么都不说**（这一脚每轮都跑，安静是刻意的）。
 * ⚠️ 状态文件只管**回档这一族**（面板那句「最近一次自动回档跟随」读它）；"记了一份快照"只进日志。
 */
function reportFloorReceipt(home, receipt, mode, head, log) {
  if (receipt === null || receipt === undefined) return
  const dir = typeof home?.dir === 'string' ? home.dir : ''
  const kind = receipt.kind
  const rest = receipt.restore ?? null
  const failed = Array.isArray(rest?.failed) ? rest.failed : []
  const moved = Array.isArray(rest?.moved) ? rest.moved : []
  const rec = receipt.record ?? null
  const rollbackFamily = kind === 'rollback' || kind === 'manual' || kind === 'back-no-snapshot'
    || kind === 'legacy-no-restore' || kind === 'unknown-order' || kind === 'index-error'
  const recorded = rec !== null && Array.isArray(rec.changed) && rec.changed.length > 0
  // ★ 2026-09-24：那条待处理也进指纹（目标变了 / 被清掉了 ⇒ 该报一条新的）
  const pend = receipt.pending === undefined || receipt.pending === null ? null : receipt.pending
  // 「还没有楼层」（首轮 / 拿不到时间线）⇒ **不进状态文件**，但**要如实记一条日志**（一次就够，
  // 别每个 step 都记 —— 用户口径 §2.1）。
  const logOnly = kind === 'no-head'
  if (!rollbackFamily && !recorded && !logOnly) return      // 安静档（same/first/forward/no-change）
  const text = rollbackFamily || logOnly ? floorReceiptText(home, receipt) : ''
  const headNodeId = typeof head?.nodeId === 'string' ? head.nodeId : ''
  const fp = [
    kind, headNodeId, floorStr(head?.variantId),
    rest?.from?.nodeId ?? '', floorStr(rest?.from?.variantId), rest?.target?.nodeId ?? '', floorStr(rest?.target?.variantId),
    rest?.source ?? '', rest?.why ?? '',
    moved.map((m) => `${m.name}:${m.sha256}`).join(','),
    failed.map((f) => `${f.name}:${f.reason}`).join(','),
    rest?.blocked ?? '',
    recorded ? `${rec.floor?.nodeId ?? ''}:${rec.floor?.variantId ?? ''}:${(rec.floor?.files ?? []).filter((f) => f.changed).map((f) => `${f.name}:${f.sha256}`).join(',')}` : '',
    pend === null ? '' : `pending:${pend.targetKey}:${pend.toNodeId}:${pend.toVariantId}:${pend.at ?? ''}`,
  ].join('|')
  // ★ "真恢复了、一份都没失败、也没有被死区挡住" ⇒ 每次都报（含状态文件）；
  //   其余（包括"某个结果一直不变"与"死区挡住所以没恢复"）⇒ 同一个结果只报一次（⛔ 不每轮刷屏）。
  //   ⚠️ ★ 2026-09-24 改口径：**回档那一支不再算"每次都报"** —— 改手动挡后它每轮都被判到、
  //   而结果（那条 pending）一个字都不变 ⇒ 走指纹门，⛔ 绝不每轮刷一条屏。
  const always = kind === 'manual' && failed.length === 0 && (rest === null || rest.blocked === null)
  if (!always) {
    if (floorWritten.get(dir) === fp) return
    floorWritten.set(dir, fp)
  }
  if (rollbackFamily) {
    // ★ 2026-09-24：回档那一支（只提示、没有 restore）⇒ "从哪一楼 → 哪一楼"改读那条待处理
    //   （from = 档案停在哪、to = 剧情站到哪）；手动那一支照旧读 restore（from = 恢复前 last、to = 目标）。
    const pendFrom = pend === null ? null : { nodeId: pend.fromNodeId, variantId: floorStr(pend.fromVariantId), seq: pend.fromSeq ?? null }
    const pendTo = pend === null ? null : { nodeId: pend.toNodeId, variantId: floorStr(pend.toVariantId), seq: pend.toSeq ?? null }
    writeFloorStatus({
      at: receipt.at, playthroughId: home.playthroughId, base: home.base, kind,
      from: rest === null ? pendFrom : (rest?.from === undefined || rest?.from === null ? null : { nodeId: rest.from.nodeId, variantId: floorStr(rest.from.variantId), seq: rest.from.seq ?? null }),
      to: rest === null ? pendTo : (rest?.target === undefined || rest?.target === null ? null : { nodeId: rest.target.nodeId, variantId: floorStr(rest.target.variantId), seq: rest.seq ?? null }),
      // ★ 2026-09-24：回档那一支没有 restore ⇒ 判据那一层的 source/why 从那条待处理里读回来
      source: rest?.source ?? (pend === null ? null : pend.source),
      why: rest?.why ?? (pend === null ? null : pend.why),
      restored: moved.map((m) => m.name),
      skipped: Array.isArray(rest?.skipped) ? rest.skipped : [],
      failed, blocked: rest?.blocked ?? null, message: text,
      // ★ 2026-09-24：那条待处理（判到回档时记的；手动恢复成功会把它清成 null）—— 机器可读的一小份。
      pending: pend === null ? null : {
        targetKey: pend.targetKey, fromSeq: pend.fromSeq, toSeq: pend.toSeq, targetSeq: pend.targetSeq,
        source: pend.source, why: pend.why, at: pend.at,
      },
    })
  }
  try {
    // ⚠️ 记一份那一支也带上变体：同一楼 swipe 之后会有**两条**记录（`(N,V1)` / `(N,V2)`），
    //    日志里不写变体就看不出它们的区别。
    const branch = typeof rec?.floor?.variantId === 'string' && rec.floor.variantId !== ''
      ? ` · ${rec.floor.variantId}`
      : ''
    const line = `[mt] 楼层快照：${recorded ? `记下第 ${rec.floor?.seq ?? '?'} 楼${branch}（${receipt.notes?.[receipt.notes.length - 1] ?? ''}）` : text}`
    if (failed.length > 0 || kind === 'index-error' || rest?.blocked !== null && rest?.blocked !== undefined) log.warn(line)
    else log.info(line)
  } catch {}
}

/**
 * 跑一次「楼同步」（两个时机共用；异步、**绝不抛**）。
 * @param {object|null} home `floorHomeFor` / `floorHomeBound` 的结果（`null` ⇒ 认不出周目，静默）
 * @param {'watch'|'turn'} mode `watch` = 组装那一脚（判回档、只记那条待处理 —— ★ 2026-09-24 起⛔ 不恢复）；
 *   `turn` = 轮末（还记一份快照）
 */
async function floorSyncAt(home, mode, log) {
  if (floorSnapshot === null || home === null) return null
  try {
    const timeline = playthroughTimeline(home.characterId, home.playthroughId)
    const head = floorSnapshot.headOf(timeline)
    const seqMap = floorSnapshot.seqMapOf(timeline)
    // ★ "紧邻前一楼"（时间线 `nodes[]` 里 `N` 的前一个）—— 判据只此一处，⛔ 不另造一份解析。
    const order = floorSnapshot.nodeOrderOf(timeline)
    const at = new Date().toISOString()
    const receipt = floorSnapshot.syncFloor({
      memoryDir: home.dir,
      mode,
      head,
      seq: floorSnapshot.seqOfNode(seqMap, head === null ? '' : head.nodeId),
      seqOf: (id) => floorSnapshot.seqOfNode(seqMap, id),
      prevOf: (id) => floorSnapshot.prevNodeOf(order, id),
      at,
      stamp: deadzone !== null && typeof deadzone.stampNow === 'function' ? deadzone.stampNow() : at.replace(/[:.]/g, '-'),
      zones: floorDeadZones(home.dir),
    })
    reportFloorReceipt(home, receipt, mode, head, log)
    return receipt
  } catch (e) {
    // ⛔ 绝不抛（绝不影响会话轮次），但也**不许静默**：同一个错误只记一条（指纹门，⛔ 不刷屏）。
    reportFloorError(home, e, log)
    return null
  }
}

/**
 * 「楼同步」整块**摔了**（意外异常）时的那一条日志 —— 同一个错误只记一次（按目录 + 错误文本做门）。
 * ★ 为什么必须有它：这一脚是异步排出去的（`void … .catch()`），摔了的话**什么都没发生**，
 *   而"什么都没发生"与"没事发生"在盘面上长得一模一样 —— 那不叫降级，那叫静默失效。
 */
function reportFloorError(home, error, log) {
  try {
    const dir = typeof home?.dir === 'string' ? home.dir : ''
    const text = String((error && error.message) || error)
    const fp = 'error|' + text
    if (floorWritten.get(dir) === fp) return
    floorWritten.set(dir, fp)
    writeFloorStatus({
      at: new Date().toISOString(), playthroughId: home?.playthroughId ?? null, base: home?.base ?? null,
      kind: 'error', from: null, to: null, restored: [], skipped: [], failed: [], blocked: null,
      message: `⚠ 楼层快照这一轮摔了（已跳过，不影响会话）：${text}`,
    })
    log.warn(`[mt] ⚠ 楼层快照这一轮摔了（已跳过，不影响会话）：${text}`)
  } catch {}
}

/** 会话那一侧（认不出周目 ⇒ 静默返回 null；⛔ 不抛）。 */
async function floorSyncForSession(sessionId, mode, log) {
  return floorSyncAt(floorHomeFor(sessionId), mode, log)
}

/**
 * ★ 决定 ④（用户口径）：**用户在面板里「直接改」保存过的那一份 ⇒ 该楼层的快照跟着刷新**
 *   （用户自己改的当然算这一楼的样子，⛔ 不许因为"和记录不符"就被回档冲掉 —— 与死区快照刷新同一套思路）。
 * ⛔ 只动**我们自己的清单**：不新增楼层、不改 `last`、⛔ **一个字节都不回写剧情文本**。
 * 刷新的那一楼 = **当下这一楼**（该周目时间线的 `head`）；认不出 / 那一楼还没有快照 ⇒ 没什么可刷的。
 * @returns {{refreshed:boolean, seq:number|null, reason:string, error:boolean}}
 */
function refreshFloorAfterEdit(home, name, text, at) {
  if (floorSnapshot === null || home === null || deadzone === null) return { refreshed: false, seq: null, reason: 'unavailable', error: false }
  try {
    if (!floorSnapshot.isFloorFile(name)) return { refreshed: false, seq: null, reason: 'not-a-floor-file', error: false }
    const read = floorSnapshot.readIndex(home.dir)
    if (read.error !== null) return { refreshed: false, seq: null, reason: read.error, error: true }
    const head = floorSnapshot.headOf(playthroughTimeline(home.characterId, home.playthroughId))
    // ⚠️ 刷新的必须是**当下这一支** `(head.nodeId, head.variantId)` 那一条 —— ⛔ 不拿同一楼的
    //    另一支冒充（那会把"在 V2 上改的"写进 V1 的快照里，等于毒掉那一支的回档）。
    const target = head === null
      ? floorSnapshot.baseFloorOf(read.index)
      : floorSnapshot.floorOfVariant(read.index, head.nodeId, head.variantId)
    if (target === null) return { refreshed: false, seq: null, reason: 'no-floor', error: false }
    // ★ 老条目（只有 nodeId、不知道哪一支）**只读**：⛔ 连刷新也不写它（反正它也不能拿来恢复）。
    if (!floorSnapshot.isRestorableFloor(target)) return { refreshed: false, seq: target.seq, reason: 'legacy-floor', error: false }
    const i = target.files.findIndex((f) => f.name === name)
    if (i === -1) return { refreshed: false, seq: target.seq, reason: 'not-recorded', error: false }
    const prev = target.files[i]
    const sha = deadzone.sha256Hex(text)
    if (prev.sha256 === sha) return { refreshed: false, seq: target.seq, reason: 'unchanged', error: false }
    const bytes = Buffer.byteLength(text, 'utf8')
    const files = target.files.slice()
    files[i] = { name, sha256: sha, bytes, changed: true, delta: prev.sha256 !== null && Number.isFinite(prev.bytes) ? bytes - prev.bytes : null }
    floorSnapshot.writeBlob(home.dir, sha, text)   // ⛔ 同 sha 不重写；这一份是"这一楼现在的样子"，必须留得住
    floorSnapshot.writeIndex(home.dir, {
      schemaVersion: floorSnapshot.FLOOR_SCHEMA_VERSION, updatedAt: at, last: read.index.last,
      floors: floorSnapshot.upsertFloor(read.index.floors, Object.assign({}, target, { files, updatedAt: at })),
      // ★ 2026-09-24：写清单是整份替换 ⇒ 那条待处理必须原样带过去（漏带＝悄悄清掉横幅）
      pending: read.index.pending,
    })
    return { refreshed: true, seq: target.seq, reason: '', error: false }
  } catch (e) {
    return { refreshed: false, seq: null, reason: String(e?.message || e), error: true }
  }
}

/**
 * 接线：楼层快照 + 回档跟随（**两个时机、同一份编排**）。
 *
 * 三条纪律（照死区看守与自动收纳那两条既有的钩子抄，⛔ 不新造调度）：
 *   · **组装那一脚绝不阻塞轮次**：监听里一个字都不 await，装完就 `return next()`；
 *     判回档（+ 记那条待处理）排到本轮之外再跑（`setTimeout(…, 0)` + `unref`，`void … .catch()`，绝不抛），
 *     **每轮至多一次**（门 = `turnBoundary.lastTurn`，取不到退到最小间隔）。★ 这一脚的意义：
 *     用户一开 fork（回档），**本轮之内**那条横幅就已经在清单里了（不等轮末）。⛔ 它不写那 5 份。
 *   · **轮末那一脚**记一份快照（`turn/end` + `compaction/end` —— 手动 `/compact` 不产生 `turn/end`，
 *     漏了它就会漏掉压缩那一轮；与 `registerAutoCollect` 同一条判据）。
 *   · **绝不刷屏**：一切"要不要写盘、要不要播报"的判据都在 `lib/floor-snapshot.js` 与
 *     `reportFloorReceipt` 的指纹门里（⛔ 这一层不自己判）。
 */
function registerFloorSnapshot(ctx, log) {
  if (floorSnapshot === null) {
    log.warn(`[mt] 楼层快照未接线（${floorSnapshotLoadError?.message || floorSnapshotLoadError}）`)
    return
  }
  if (!ctx || typeof ctx.plugin !== 'function') {
    log.warn('[mt] ctx.plugin 不可用，楼层快照未接线')
    return
  }
  ctx.plugin({
    name: 'dsh-memory-archive:floor-snapshot',
    // 两个服务都是在场与否决定这一条子 fiber 挂不挂 —— 与 echo 那条同款（两个都是宿主常驻服务）。
    inject: ['systemPrompt', 'sessionQuery'],
    apply(scope) {
      const perTurn = new Map() // sid → {turn, at}：这一轮查过没有（LRU 上限 64）
      scope.on('system-prompt/assemble', async (assembly, assembleContext, next) => {
        try {
          const sid = assembleContext?.agent?.session?.id
          if (typeof sid === 'string' && sid !== '') {
            let turn = null
            try {
              turn = getService(scope, 'sessionProjections')?.stateOf?.(assembleContext?.agent?.session, 'turnBoundary')?.lastTurn
            } catch { turn = null }
            if (!Number.isFinite(turn)) {
              try { turn = assembleContext?.agent?.phase?.turn } catch { turn = null }
            }
            const last = perTurn.get(sid)
            const sameTurn = Number.isFinite(turn) && last !== undefined && last.turn === turn
            const tooSoon = !Number.isFinite(turn) && last !== undefined && (Date.now() - last.at) < DEADZONE_FALLBACK_MIN_MS
            if (!sameTurn && !tooSoon) {
              perTurn.delete(sid)
              perTurn.set(sid, { turn: Number.isFinite(turn) ? turn : null, at: Date.now() })
              while (perTurn.size > 64) perTurn.delete(perTurn.keys().next().value)
              // ★ 排到**这一轮之外**再跑：读时间线/清单与恢复那几脚一点不占本轮的时间。
              const timer = setTimeout(() => {
                void Promise.resolve(floorSyncForSession(sid, 'watch', log)).catch(() => {})
              }, 0)
              if (typeof timer.unref === 'function') timer.unref()
            }
          }
        } catch { /* 楼层看守失败绝不影响这一轮装配 */ }
        return next()
      })
      // 轮末那一脚：判回档（★ 2026-09-24 起**只记那条待处理、⛔ 不写那 5 份**）+ 记一份快照（有变化才写盘）。
      scope.on('session/event', (session, event) => {
        try {
          const type = event?.type
          if (type !== 'turn/end' && type !== 'compaction/end') return
          const sid = session?.id
          if (typeof sid !== 'string' || sid === '') return
          // 落盘那一脚（异步、不 await：⛔ 绝不阻塞会话轮次）。摔了会在 `reportFloorError` 里如实记一条。
          void Promise.resolve(floorSyncForSession(sid, 'turn', log)).catch(() => {})
        } catch {}
      })
    },
  })
  log.info('[mt] 楼层快照已接线（轮末记一份；组装时 + 轮末各判一次回档 —— ★ 判到只提示、⛔ 不自动写；'
    + '写盘只在面板点「把档案退回第 N 楼」时走 POST …/floors/restore；'
    + '只动那 5 份笔记 + .dma-floor-snapshots/，⛔ 预置那几份一个都不碰、死区那几段按块合并（保留盘上现况））')
}

/**
 * GET /playthrough/for-session?sessionId=… —— 「这个会话属于哪个周目」只读查询（20260919）。
 *
 * 谁在用：面板打开时问一句，是就**把绑定改到那个周目**（用户口径「点开记忆库要自动跳转到对应
 * 周目」）—— 改绑定而不是只改显示，这样面板读的、面板里收纳写的、后台自动收纳的口径全都对得上。
 *
 * ⛔ 纯只读（这里只回答"是哪个"，⛔ 不写配置 —— 写由面板决定）；⛔ 响应里只有 id 与判词，
 * 不吐会话正文、不吐任何路径。查不到 ⇒ `source:'none'`（**如实说"不知道"**，由调用方决定是否
 * 回落配置绑定）。
 */
async function handlePlaythroughForSession(send, url) {
  const raw = url && url.searchParams ? url.searchParams.get('sessionId') : ''
  const sid = typeof raw === 'string' ? raw.trim() : ''
  if (sid === '') return send(200, err('FOR_SESSION_NO_ID', '缺 sessionId（要问的是哪个会话）'))
  if (sessionPlaythrough === null) {
    return send(200, err('FOR_SESSION_UNAVAILABLE', `会话→周目模块不可用：${String((sessionPlaythroughLoadError && sessionPlaythroughLoadError.message) || sessionPlaythroughLoadError || '未加载')}`))
  }
  const idx = sessionIndex()
  if (idx === null) {
    return send(200, err('FOR_SESSION_NO_CATALOG', '读不到 Tavern 的 catalog.json —— 工作区根还没绑？'))
  }
  const hit = sessionPlaythrough.resolveForSession(idx, sid)
  return send(200, { ok: true, ...hit, conflicts: idx.conflicts.length })
}

/**
 * ★ 2026-09-20：**本会话的**周目目录（`<rootPath>/<角色>/<周目>`，会话优先）。
 * 与 `rootPlaythroughDir()`（按 `config.root` = **面板视图**）**成对**存在 —— ⛔ 别把两者合并：
 *   · **注入与语料**（笔记落点、最近几楼、回响）走**这个**：会话优先，认不出 ⇒ `null`（当新会话）；
 *   · **面板那几档**（摘要/原文/剧情大纲/顶部「当前根」）读的是**那个**：用户显式在看哪个周目。
 */
function sessionPlaythroughDir(sessionId) {
  const rootPath = tavernRootPath()
  if (rootPath === '') return null
  const hit = sessionPlaythroughOf(sessionId)
  if (hit === null) return null
  return {
    dir: join(rootPath, hit.characterId, hit.playthroughId),
    source: hit.characterId + '/' + hit.playthroughId,
    rootPath, characterId: hit.characterId, playthroughId: hit.playthroughId,
  }
}

/** 归档楼层目录 = **本会话的**周目目录下的 `archive/floors`（认不出该会话的周目 ⇒ `null`）。 */
function rootFloorsDir(sessionId) {
  const hit = sessionPlaythroughDir(sessionId)
  if (hit === null) return null
  return { dir: join(hit.dir, 'archive', 'floors'), source: hit.source }
}

/** 回响语料（口径同 `rootFloorsDir`）。认不出 ⇒ `{floors: [], source: null}` ⇒ 调用方不注入。 */
function echoArchiveSource(sessionId) {
  const hit = rootFloorsDir(sessionId)
  if (hit === null) return { floors: [], source: null }
  return { floors: echoModules.readArchiveFloors(hit.dir), source: hit.source }
}

/**
 * 角色扮演记忆库（`.roleplay-memory/`）的**落点候选链** —— 从前到后取第一个「真的是目录」的命中。
 *
 *   ① 周目目录（`rootPlaythroughDir().dir` = `<rootPath>/<角色>/<周目>`）：更**具体**，
 *      哪天真把记忆库放进某一周目，它该赢。
 *   ② 工作区根（`hit.rootPath`）：★ **真机实际落点** —— 预设写的是「**会话工作目录**」下的
 *      `.roleplay-memory/`，而周目根会话的 `header.cwd` 实测就是 Tavern 的 `rootPath`
 *      （`play-workspace.json` 里那个），**不是**周目目录。
 *
 * 候选顺序与「谁赢」都必须如实回报给面板（⛔ 不许猜一个）。⛔ 只做拼接，不另写一套解析。
 */
function rpMemoryCandidates(hit) {
  return [
    { base: 'playthrough', label: '周目目录', dir: join(hit.dir, RP_MEMORY_DIR_NAME) },
    { base: 'workspace-root', label: '工作区根（会话工作目录）', dir: join(hit.rootPath, RP_MEMORY_DIR_NAME) },
  ]
}

function isDirectorySafe(abs) {
  try { return statSync(abs).isDirectory() } catch { return false }
}

/** 记忆库里的一份文件**能不能读**：普通文件名 + 过得了路径裁决（点开头的，如 `.DS_Store`，不列）。 */
function rpMemoryNameOk(name) {
  if (typeof name !== 'string' || name === '' || name.startsWith('.')) return false
  if (/[\\/]/.test(name)) return false
  if (/[\u0000-\u001f]/.test(name)) return false
  if (relPathJail && typeof relPathJail.validateRelPath === 'function') {
    // 裁决器在场 ⇒ 用它的表与规则（扩展名表也只有一份，防两处漂移）
    return relPathJail.validateRelPath(`${RP_MEMORY_DIR_NAME}/${name}`).ok === true
  }
  const lower = name.toLowerCase()
  return RP_MEMORY_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** 列记忆库目录：只列能读的那几份（顺序见 RP_MEMORY_PREFERRED_ORDER），并如实报"有几项没列"。 */
function listRpMemoryFiles(dir) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return null }
  const files = []
  let skipped = 0
  for (const ent of entries) {
    if (!ent.isFile() || !rpMemoryNameOk(ent.name)) { skipped += 1; continue }
    let st = null
    try { st = statSync(join(dir, ent.name)) } catch { st = null }
    if (st === null) { skipped += 1; continue }
    files.push({ name: ent.name, exists: true, bytes: st.size, mtime: st.mtimeMs })
  }
  const rank = (n) => { const i = RP_MEMORY_PREFERRED_ORDER.indexOf(n); return i === -1 ? RP_MEMORY_PREFERRED_ORDER.length : i }
  files.sort((a, b) => (rank(a.name) - rank(b.name)) || a.name.localeCompare(b.name))
  const capped = files.slice(0, RP_MEMORY_MAX_FILES)
  return { files: capped, skipped: skipped + (files.length - capped.length) }
}

/**
 * GET /playthrough/rp-memory —— 「角色扮演记忆库」只读出口（20260919 面板第四档）。
 *
 * 读的是**社区预设自己约定写出来**的产物：`<工作目录>/.roleplay-memory/` 下那些 md
 * （见 `oliblue-evan/dsh-roleplay-preset` 的 `agent.cordis.yml`「六、记忆系统」）。
 * ⛔ 本端点**绝不写**、⛔ **绝不碰那个预设**，也不新建/删除/改名任何文件 ——
 *    盘面动作只有 `statSync` / `readdirSync` / `readFileSync`。
 *
 * 两条纪律（跟已退役的那份单文件大纲同款）：
 *   ① 清单（不带 `?file=`）**一个字节正文都不读**，只 stat；正文要 `?file=<目录里实际有的那一份>` 才读。
 *   ② 请求可控的只有**文件基名**，而基名必须过路径裁决、且目录里真的在 ⇒ 不构成任意文件读入口。
 * ⛔ 响应里绝不出现绝对路径；只说命中的是候选链里的哪一处。
 */
/**
 * 解析「本会话绑定的角色-周目」下的**记忆库目录**（候选链里第一个真实存在的那个）。
 * ⛔ 越界不了：候选链是 `周目目录/.roleplay-memory` 与 `工作区根/.roleplay-memory` 两处，
 *   全部由宿主自己按绑定算出来，**客户端一个字符都插不进来**。
 * @returns {{hit:object, candidates:Array, found:object}|null} 没有绑定 / 两处都不存在 ⇒ null
 */
function resolveRpMemoryDir() {
  const hit = rootPlaythroughDir()
  if (hit === null) return null
  const candidates = rpMemoryCandidates(hit)
  const found = candidates.find((c) => isDirectorySafe(c.dir))
  if (found === undefined) return null
  return { hit, candidates, found }
}

/** 在系统文件管理器里打开一个目录（Windows / macOS / Linux）。⛔ 不经 shell ⇒ 无注入面。 */
function openDirInFileManager(dir) {
  try {
    const opts = { detached: true, stdio: 'ignore' }
    const child = process.platform === 'win32'
      ? spawn('explorer.exe', [dir], opts)
      : process.platform === 'darwin'
        ? spawn('open', [dir], opts)
        : spawn('xdg-open', [dir], opts)
    child.on('error', () => {}) // 拉不起来只记在返回值里，⛔ 绝不抛
    child.unref()
    return true
  } catch {
    return false
  }
}

/**
 * POST /playthrough/reveal —— 「剧情大纲」档的**打开文件夹**（2026-09-20 用户口径：
 *   「给剧情大纲面板加一个打开文件夹的按钮」）。
 *
 * ★★ 2026-09-20 补（用户口径：「**没有加打开文件夹的按钮**，新会话依旧不显示」）：
 *   原来只有"目录已经存在"才给按钮；新周目**两处都还没建** ⇒ 按钮不渲染、内容也空
 *   ⇒ 用户既看不到状态、也没有入口去放东西（而"预部署"恰恰要在新周目开局前把文件放进去）。
 *   现在：请求体可给 `{base:'playthrough'|'workspace-root'}`（缺省 = 第一个存在的候选）——
 *   · `playthrough`（= 周目目录，**我们的写面**）不存在 ⇒ **按需创建**再打开（`created:true`）；
 *   · `workspace-root`（= 社区 RP 预设的地盘）不存在 ⇒ ⛔ **绝不创建**，退而打开**工作区根本身**
 *     （`fallbackTo:'workspace-root'`）—— 你在那儿自己新建 `.roleplay-memory/` 即可预置。
 *
 * 三条纪律：
 *   ① 要开哪个目录**由宿主自己解析**（候选链 / 枚举 base）—— ⛔ 请求体里只有枚举，**没有也不接受任何路径**
 *      ⇒ 不构成"任意目录打开"入口；
 *   ② ⛔ 不经 shell（`spawn(cmd, [dir])`，没有 `shell: true`）⇒ 路径里的字符不参与命令解析；
 *   ③ ⛔ 响应里**不回绝对路径**（与 rp-memory 同口径：只说命中的是候选链里的哪一处）。
 */
async function handleRevealRpMemory(req, send, log) {
  const hit = rootPlaythroughDir()
  if (hit === null) {
    return send(200, err('RP_MEMORY_NO_PLAYTHROUGH', '当前没有绑定的「角色-周目」：先到 ⚙ 设置里选好工作区根'))
  }
  let body = {}
  try {
    const raw = await readBody(req, BODY_LIMIT)
    body = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'))
  } catch { body = {} }   // 体坏了/没给 ⇒ 走缺省（⛔ 不因为体坏了就拒绝干活）
  const cands = rpMemoryCandidates(hit)
  const want = isPlainObject(body) && typeof body.base === 'string' && body.base !== '' ? body.base : null
  const target = want !== null
    ? cands.find((c) => c.base === want) ?? null
    : cands.find((c) => isDirectorySafe(c.dir)) ?? cands[0]
  if (target === null) {
    return send(200, err('RP_MEMORY_BAD_BASE', `落点只认 ${cands.map((c) => c.base).join(' / ')}`))
  }
  const exists = isDirectorySafe(target.dir)
  let created = false
  let openThis = target.dir
  let fallbackTo = null
  if (!exists) {
    if (target.base === 'playthrough') {
      // 只在这一个上按需创建：它是**我们的写面**（`memory_write` / 预设 §四"新周目第一轮先把这几份建起来"）。
      try { mkdirSync(target.dir, { recursive: true }); created = true } catch {
        return send(200, err('REVEAL_MKDIR_FAILED', '那个目录建不出来（权限或路径问题）'))
      }
    } else {
      // 工作区根那份是**社区 RP 预设的地盘** ⇒ ⛔ 不替它建（本档纪律：人家写、我们看）。
      openThis = hit.rootPath
      fallbackTo = 'workspace-root'
    }
  }
  const okOpened = openDirInFileManager(openThis)
  try {
    log?.info?.(`[mt] 打开记忆库落点：base=${target.base} created=${created} fallback=${fallbackTo ?? '-'} ok=${okOpened}`)
  } catch {}
  if (!okOpened) {
    return send(200, err('REVEAL_FAILED', '没能在系统文件管理器里打开那个目录（宿主进程拉不起来文件管理器）'))
  }
  return send(200, { ok: true, base: target.base, baseLabel: target.label, created, fallbackTo })
}

async function handleRpMemory(send, url) {
  const name = url && url.searchParams ? url.searchParams.get('file') : null
  const hit = rootPlaythroughDir()
  if (hit === null) {
    return send(200, err('RP_MEMORY_NO_PLAYTHROUGH', '当前没有绑定的「角色-周目」：先到 ⚙ 设置里选好工作区根'))
  }
  // ★ 2026-09-20：候选链的解析抽成 `resolveRpMemoryDir()`（与 `POST /playthrough/reveal` 同一份，
  //   ⛔ 不许两处各写一遍 —— 那是"两处真相"，迟早漂开）。这里只是把它的结果摊成响应。
  //   ★★ 同日补：每个候选额外给 `fileCount` —— 面板要把**两处落点**都如实摆出来（各自在不在、有几份），
  //      用户才能"把要预置的文件放进共用那份"（新周目那两份都还没有时更是只靠这行才知道往哪放）。
  const candidatesView = rpMemoryCandidates(hit).map((c) => {
    const ex = isDirectorySafe(c.dir)
    if (!ex) return { base: c.base, label: c.label, exists: false, fileCount: 0 }
    const l = listRpMemoryFiles(c.dir)
    return { base: c.base, label: c.label, exists: true, fileCount: l === null ? null : l.files.length }
  })
  const resolved = resolveRpMemoryDir()
  if (resolved === null) {
    return send(200, {
      ok: false, exists: false, dir: RP_MEMORY_DIR_NAME, candidates: candidatesView,
      error: { code: 'RP_MEMORY_MISSING', message: '这个周目还没有记忆库（.roleplay-memory/）' },
    })
  }
  const found = resolved.found
  const listing = listRpMemoryFiles(found.dir)
  if (listing === null) {
    // 目录在、但读不出来（权限/长路径）—— 如实说，⛔ 不假装空态
    return send(200, { ok: false, dir: RP_MEMORY_DIR_NAME, candidates: candidatesView, error: { code: 'RP_MEMORY_UNREADABLE', message: '记忆库目录读不出来（权限或路径问题）' } })
  }
  // ★ 2026-09-23：死区数据**与笔记同一处**（一起被用户拷走）；这里只读它，给每份文件标几条、
  //   给清单带一句总览。⛔ 读不到/坏掉不当作"没有死区"—— 如实把 docError 交出去（面板要能看见）。
  const dz = deadzone === null ? null : deadzone.readDocFile(found.dir)
  const dzCounts = dz === null ? {} : deadzone.zoneCountsByFile(dz.doc)
  const dzView = dz === null
    ? { available: false, count: 0, docError: null, writable: false }
    : {
        available: true, count: dz.doc.zones.length, docError: dz.error,
        // 有没有**可写**的那种文件在这个目录里（面板据此决定要不要显示"能直接改"的说明）
        writable: listing.files.some((f) => deadzone.writableExtOk(f.name)),
      }
  const where = {
    dir: RP_MEMORY_DIR_NAME, base: found.base, baseLabel: found.label, candidates: candidatesView,
    skipped: listing.skipped,
    // base === 'workspace-root' ⇒ 记忆库落在会话工作目录、**可能被同一工作区里的多个周目共用**；
    // 这不是我们的 bug，但面板必须如实说出来，否则用户会以为数据串了。
    sharedHint: found.base === 'workspace-root',
    deadzones: dzView,
  }

  if (name === null || name === '') {
    return send(200, {
      ok: true, ...where,
      files: listing.files.map((f) => Object.assign({}, f, {
        deadzones: dzCounts[f.name] ?? 0,
        writable: deadzone === null ? false : deadzone.writableExtOk(f.name),
      })),
    })
  }

  if (!rpMemoryNameOk(name)) {
    // ⛔ 不回显入参（免得日志里出现伪路径）
    return send(200, { ok: false, ...where, error: { code: 'RP_MEMORY_BAD_FILE', message: '这个文件名不能读（只能是记忆库目录里的普通文件）' } })
  }
  const abs = join(found.dir, name)
  let st = null
  try { st = statSync(abs) } catch { st = null }
  if (st === null || !st.isFile()) {
    return send(200, { ok: false, ...where, file: { name, exists: false }, error: { code: 'RP_MEMORY_FILE_MISSING', message: `记忆库里还没有 ${name}` } })
  }
  let text
  try {
    text = readFileSync(abs, 'utf8')
  } catch (e) {
    return send(200, { ok: false, ...where, file: { name, exists: true }, error: { code: 'RP_MEMORY_READ_FAILED', message: `记忆库文件读取失败：${String((e && e.message) || e)}` } })
  }
  // ★ 2026-09-23：**先**按整份现文算 sha 与按块切（它们是"用户看到的这一份"的身份，
  //   乐观锁与死区都以它为准）—— 截断只影响下面回给面板的 `text`，⛔ 不影响这两样。
  const sha256 = deadzone === null ? null : deadzone.sha256Hex(text)
  const allBlocks = deadzone === null ? null : deadzone.splitBlocks(text)
  const deadShas = new Set((dz === null ? [] : dz.doc.zones).filter((z) => z.file === name).map((z) => z.sha256))
  const blocks = allBlocks === null ? null : allBlocks.map((b) => ({
    index: b.index, firstLine: b.firstLine, chars: b.chars, sha256: b.sha256,
    text: b.text, dead: deadShas.has(b.sha256),
  }))
  const originalChars = text.length
  const truncated = originalChars > RP_MEMORY_MAX_FILE_CHARS
  if (truncated) text = text.slice(0, RP_MEMORY_MAX_FILE_CHARS)
  return send(200, {
    ok: true, ...where,
    file: {
      name, exists: true, text, chars: text.length, originalChars, truncated, mtime: st.mtimeMs,
      sha256,
      // 块：死区与面板逐块渲染共用同一份切法（⛔ 客户端不另切一遍 —— 那是"两处真相"）；
      // 截断过的大文件不回块（面板也据此**不给**编辑入口：免得把没显示出来的部分写没）。
      blocks: truncated ? null : blocks,
      deadzones: dzCounts[name] ?? 0,
      writable: deadzone === null ? false : deadzone.writableExtOk(name),
    },
  })
}

/**
 * ★★ 2026-09-23（用户口径「**剧情文本支持直接编辑**」）：`POST /playthrough/rp-memory/write`。
 *
 * 这是「剧情大纲」档**第一次开写**，纪律全仓照抄：
 *   ① **写前备份** `<文件>.bak-<时间戳>`（复制留档，⛔ 绝不销毁）+ **写后回读校验**（`deadzone.writeWithBackup`）；
 *   ② **白名单**：只允许 `.roleplay-memory/` 下的 `.md` / `.txt`
 *      （名字过 `rpMemoryNameOk` ⇒ `rel-path-jail.js` 的原裁决；扩展名**再收窄**到那两个
 *       —— 读侧那张表还放行 `.json/.yaml/.yml`，但"面板里直接改正文"只对正文类开放）；
 *      ⛔ 拒路径穿越、⛔ 拒别的扩展名、⛔ 拒**不存在**的文件（编辑 ≠ 新建，先只做已存在的）；
 *   ③ **乐观锁**：请求带**用户看到的那份的 sha256**，落盘前重读比对；不一致 ⇒ **409 + 可读文案**
 *      （「盘上已经变了（可能是模型刚写过），先刷新再改」），⛔ **绝不静默覆盖**；
 *   ④ 保存成功 ⇒ **顺手刷新该文件的死区快照**（用户自己改的 ⇒ 快照跟着走，⛔ 不许因此告警）；
 *   ⑤ 回执如实：字节数 / sha256 / **备份名** / 刷新了几条死区。⛔ 响应里不回正文、不回绝对路径。
 * ⛔ **绝不把编辑内容塞进任何 system 段** —— 用户改的是文件，模型下一轮自己读（`mt:memoryHome` 那套不变）。
 */
async function handleRpMemoryWrite(req, send, log, redact) {
  if (deadzone === null) {
    return send(200, err('RP_MEMORY_WRITE_UNAVAILABLE', '死区/编辑模块（deadzone.js）不可用，拒写'))
  }
  const body = await readJsonObjectBody(req, send)
  if (body === null) return undefined
  const resolved = resolveRpMemoryDir()
  if (resolved === null) {
    return send(409, err('RP_MEMORY_MISSING', '这个周目还没有记忆库（.roleplay-memory/）⇒ 没有可改的文件'))
  }
  const found = resolved.found
  const name = typeof body.file === 'string' ? body.file : ''
  // 与读侧**同一份**名字裁决（扩展名再收窄在 decideWrite 里 —— 那份白名单只有一处定义）。
  if (!rpMemoryNameOk(name)) {
    return send(400, err('RP_MEMORY_BAD_FILE', '这个文件名不能写（只能是记忆库目录里的普通文件）'))
  }
  const abs = join(found.dir, name)
  let exists = false
  let cur = null
  try {
    const st = statSync(abs)
    if (st.isFile()) { exists = true; cur = readFileSync(abs, 'utf8') }
  } catch { /* 不在 / 读不出来 ⇒ 交给 decideWrite 的裁决各自说话 */ }
  const plan = deadzone.decideWrite({
    file: name, text: body.text, sha256: body.sha256,
    currentText: cur, exists, maxChars: RP_MEMORY_MAX_FILE_CHARS,
  })
  if (!plan.ok) {
    try { log?.info?.(`[mt] 剧情文本写盘被拒：${name} ${plan.code}`) } catch {}
    return send(plan.status, err(plan.code, redact ? redact(plan.message) : plan.message))
  }
  const wrote = deadzone.writeWithBackup(abs, body.text, deadzone.stampNow())
  if (!wrote.ok) {
    try { log?.warn?.(`[mt] 剧情文本写盘失败：${name} —— ${wrote.reason}`) } catch {}
    return send(500, err('RP_MEMORY_WRITE_FAILED', redact ? redact(wrote.reason) : wrote.reason))
  }
  // ④ 用户自己改的 ⇒ 快照跟着走（这一条是"不误报"的关键：改完再比对必须是"一致"）。
  const dzRead = deadzone.readDocFile(found.dir)
  const dzResult = { refreshed: 0, updated: 0, dropped: [], total: dzRead.doc.zones.length, error: dzRead.error }
  if (dzRead.error === null && dzRead.doc.zones.some((z) => z.file === name)) {
    const next = deadzone.refreshAfterEdit(dzRead.doc, name, body.text, new Date().toISOString())
    try {
      deadzone.writeDocFile(found.dir, next.doc)
      dzResult.refreshed = next.refreshed
      dzResult.updated = next.updated
      dzResult.dropped = next.dropped
      dzResult.total = next.doc.zones.length
    } catch (e) {
      dzResult.error = 'unwritable'
      try { log?.warn?.(`[mt] 死区快照刷新失败（文件已写入，快照还是旧的）：${e?.message || e}`) } catch {}
    }
  }
  // ⑤ ★ 2026-09-23（用户口径决定④）：**用户自己改的 ⇒ 那一楼的快照跟着走**
  //    （与上面死区快照刷新同一套思路；⛔ 只动我们自己的清单，⛔ 绝不回写剧情文本）。
  //    真刷成功/真失败都如实回给面板；"没能刷"（那一楼还没有快照一类）也如实说，⛔ 不装成功。
  const fl = refreshFloorAfterEdit(
    { dir: found.dir, base: found.base, baseLabel: found.label, characterId: resolved.hit.characterId, playthroughId: resolved.hit.playthroughId },
    name, body.text, new Date().toISOString(),
  )
  try {
    log?.info?.(`[mt] 剧情文本已写入：${name}（${plan.chars} 字符 → ${found.label}），备份 ${basename(wrote.backupPath)}，`
      + `死区快照刷新 ${dzResult.refreshed} 条，楼层快照 ${fl.refreshed ? `已跟上（第 ${fl.seq} 楼）` : `未刷新（${fl.reason}）`}`)
  } catch {}
  return send(200, {
    ok: true,
    file: name,
    base: found.base, baseLabel: found.label, sharedHint: found.base === 'workspace-root',
    chars: plan.chars, bytes: wrote.bytes, sha256: plan.sha256,
    backup: basename(wrote.backupPath),   // ★ 只给**名字**（⛔ 响应里不回绝对路径）
    deadzones: {
      refreshed: dzResult.refreshed, updated: dzResult.updated, dropped: dzResult.dropped,
      total: dzResult.total, error: dzResult.error,
    },
    // ★ 楼层快照那边：`reason` 是**为什么没刷新**（那一楼还没有快照 / 这一份不在那 5 份里 / 清单读不出来…）
    floors: { refreshed: fl.refreshed, seq: fl.seq, reason: fl.reason, error: fl.error === true },
  })
}

/**
 * ★★ 2026-09-23（用户口径「**剧情文本支持设置死区**」）：`GET/POST /playthrough/rp-memory/deadzones`。
 *
 * 死区 = **模型禁改区**：用户在某一份剧情文本里划出一段（块级），标明「⛔ 模型不许改写/覆盖」，
 * 我们把这条约束喂给模型（`mt:memoryHome` 段），并在每一轮比对**快照 vs 现况**、不一致就告警。
 * ⛔ **只告警、不还原**（用户明确否掉了"自动改回去"那个选项）—— 本函数一个字节都不写剧情文本。
 *
 * 数据落 `<记忆库目录>/.dma-deadzones.json`（**跟笔记同一处**：用户会连目录一起拷到别的周目）。
 * 每条 = 文件 + 那段原文快照 + 快照 sha256（+ 可选备注名）；粒度 = markdown 块（空行分隔）。
 *
 * 状态码口径：读侧（GET）照 `GET /playthrough/rp-memory` 的老口径（HTTP 200 + ok:false）；
 * 写侧（POST）照 `POST …/write`（400 体坏 / 409 拒改 —— 都不写盘）。
 */
async function handleRpMemoryDeadzones(req, send, log, redact) {
  if (deadzone === null) {
    return send(200, err('RP_MEMORY_DEADZONE_UNAVAILABLE', `死区模块（deadzone.js）不可用：${deadzoneLoadError?.message || deadzoneLoadError}`))
  }
  const method = String((req && req.method) || 'GET').toUpperCase()
  const resolved = resolveRpMemoryDir()
  if (resolved === null) {
    return send(method === 'GET' ? 200 : 409, err('RP_MEMORY_MISSING', '这个周目还没有记忆库（.roleplay-memory/）⇒ 还没有可划死区的文件'))
  }
  const found = resolved.found
  const read = deadzone.readDocFile(found.dir)
  const view = {
    base: found.base, baseLabel: found.label, sharedHint: found.base === 'workspace-root',
    file: deadzone.DEADZONE_FILE_NAME, docExists: read.exists, docError: read.error,
  }
  if (method === 'GET') {
    // ⛔ 不回快照正文（那是用户自己的原文，面板用不着；响应只给定位与计数）
    return send(200, {
      ok: true, ...view,
      zones: read.doc.zones.map((z) => ({
        file: z.file, label: z.label, firstLine: z.firstLine, sha256: z.sha256, chars: z.chars, at: z.at,
      })),
    })
  }
  const body = await readJsonObjectBody(req, send)
  if (body === null) return undefined
  const name = typeof body.file === 'string' ? body.file : ''
  // 死区**不写文件内容**（只记快照）⇒ 名字用读侧那张表（含 .json/.yaml）；越界/保留名照旧一律拒。
  if (!rpMemoryNameOk(name)) return send(400, err('RP_MEMORY_BAD_FILE', '这个文件名不能划死区（只能是记忆库目录里的普通文件）'))
  const decided = deadzone.decideToggle(read.doc, {
    action: body.action, file: name, sha256: body.sha256, text: body.text,
    label: body.label, at: new Date().toISOString(),
  })
  if (!decided.ok) return send(409, err(decided.code, redact ? redact(decided.message) : decided.message))
  try {
    deadzone.writeDocFile(found.dir, decided.doc)
  } catch (e) {
    return send(500, err('RP_MEMORY_DEADZONE_WRITE_FAILED', `死区数据写不进去：${(e && e.message) || e}`))
  }
  try {
    log?.info?.(`[mt] 死区${body.action === 'remove' ? '解锁' : '设置'}：${name} 的「${decided.zone.firstLine}」（${found.label}；`
      + `现在共 ${decided.doc.zones.length} 条）`)
  } catch {}
  return send(200, {
    ok: true, ...view, action: body.action === 'remove' ? 'remove' : 'add',
    // 刚写完 ⇒ 这份数据文件现在**一定在**（上面那个 view 是写之前读的，别把旧值带出去）
    docExists: true, docError: null,
    zone: {
      file: decided.zone.file, label: decided.zone.label, firstLine: decided.zone.firstLine,
      sha256: decided.zone.sha256, chars: decided.zone.chars,
    },
    count: decided.doc.zones.length,
  })
}

/**
 * ★★ 2026-09-23：`GET /playthrough/rp-memory/deadzones/status` —— 死区快照 vs 盘上现况（**只读**）。
 *
 * 面板「剧情大纲」档的红字靠它：把每条死区在现文里重新定位（先 sha、再首行），
 * 给出 `state`（ok / changed / missing / missing-file）与**两个 sha**（快照 sha 与现况 sha）。
 * ⛔ 本端点**不写任何文件**（连状态文件都不写 —— 那是每轮那条看守的事），⛔ 也**不还原**任何东西。
 * ⚠️ 文案口径（用户口径）：**不许定性**「模型违规」—— 用户自己也会在别处改这些文件。
 */
function handleRpMemoryDeadzoneStatus(send) {
  if (deadzone === null) {
    return send(200, err('RP_MEMORY_DEADZONE_UNAVAILABLE', `死区模块（deadzone.js）不可用：${deadzoneLoadError?.message || deadzoneLoadError}`))
  }
  const resolved = resolveRpMemoryDir()
  if (resolved === null) {
    return send(200, {
      ok: false, exists: false, dir: RP_MEMORY_DIR_NAME,
      error: { code: 'RP_MEMORY_MISSING', message: '这个周目还没有记忆库（.roleplay-memory/）' },
    })
  }
  const found = resolved.found
  const read = deadzone.readDocFile(found.dir)
  const files = [...new Set(read.doc.zones.map((z) => z.file))].slice(0, DEADZONE_STATUS_MAX_FILES)
  const fileTexts = {}
  for (const f of files) {
    // 只有**真的过得了名字裁决**的那几份才去读（文档被手改过也不构成任意文件读入口）
    if (!rpMemoryNameOk(f)) { fileTexts[f] = null; continue }
    try { fileTexts[f] = readFileSync(join(found.dir, f), 'utf8') } catch { fileTexts[f] = null }
  }
  const report = deadzone.compareZones(read.doc, fileTexts)
  const hit = resolved.hit
  return send(200, {
    ok: true,
    base: found.base, baseLabel: found.label, sharedHint: found.base === 'workspace-root',
    file: deadzone.DEADZONE_FILE_NAME, docExists: read.exists, docError: read.error,
    zones: report.zones, status: report.status, items: report.items,
    checkedAt: new Date().toISOString(),
    // 每轮那条看守最近一次的结果（只读投影；⛔ 本端点绝不写它）。
    lastWatch: readDeadzoneStatus(hit.playthroughId),
  })
}

/**
 * ★★ 2026-09-23：`GET /playthrough/rp-memory/floors` —— 「**按楼层绑定的笔记快照**」只读清单。
 *
 * 面板「剧情大纲」档那一块靠它画：每**一支**一行（`第 N 楼 · 变体 · 时间 · 改了哪几份文件
 * （+几字节）· [回到这一楼]`）、当前站的那一支高亮、档顶一句「最近一次回档」。
 * ★ 2026-09-24 改口径（用户拍板「**不要做跟随楼层的功能，先做手动挡**，开 fork 时（回档）前台弹提示」）：
 *   **判到回档只提示、⛔ 不写盘** ⇒ 响应里多带一条 `pending`（没有就 `null`）—— 面板靠它画档顶那条
 *   **显著**横幅（「把档案退回第 N 楼」/「保持现状」）。⛔ 本端点仍然**纯只读**。
 * ★ 2026-09-23 改口径：快照按 `(floor, variant)` 记 ⇒ 同一楼 swipe 过会有**多行**；
 *   "只有 nodeId 的老记录"照实列出来但标 `legacy:true`（**只读、不能拿来恢复**）。
 *
 * ⛔ 面板**不许直连 Tavern、不许自己算"当前第几楼"**（用户口径）—— 一律走本端点：
 *   楼层序号 = 该周目 `timeline.json` 里 `nodes[]` 的位置（+1），"当前站在哪一楼哪一支" = `head`。
 * ⛔ 纯只读：⛔ 不写任何文件（连状态文件都不写 —— 那是钩子的事）、⛔ 不恢复任何东西。
 * 读侧口径照 `GET /playthrough/rp-memory`：HTTP 200 + `ok:false`。
 */
function handleRpMemoryFloors(send) {
  if (floorSnapshot === null) {
    return send(200, err('RP_MEMORY_FLOOR_UNAVAILABLE', `楼层快照模块（floor-snapshot.js）不可用：${floorSnapshotLoadError?.message || floorSnapshotLoadError}`))
  }
  const home = floorHomeBound()
  if (home === null) {
    return send(200, {
      ok: false, exists: false, dir: RP_MEMORY_DIR_NAME,
      error: { code: 'RP_MEMORY_MISSING', message: '这个周目还没有记忆库（.roleplay-memory/）⇒ 还没有楼层快照' },
    })
  }
  const read = floorSnapshot.readIndex(home.dir)
  const timeline = playthroughTimeline(home.characterId, home.playthroughId)
  const head = floorSnapshot.headOf(timeline)
  const seqMap = floorSnapshot.seqMapOf(timeline)
  const headSeq = head === null ? null : floorSnapshot.seqOfNode(seqMap, head.nodeId)
  const zones = floorDeadZones(home.dir)
  // ★ 死区**按文件**归并（面板要的是"这份文件里有死区"）；判据仍是 `.dma-deadzones.json` 那一份。
  const deadFiles = zones === null ? null : [...new Set(zones.map((z) => z.file))]
  const deadSet = new Set(deadFiles ?? [])
  const floors = read.index.floors.map((f) => {
    const seq = f.seq === null ? floorSnapshot.seqOfNode(seqMap, f.nodeId) : f.seq
    const changed = f.files.filter((x) => x.changed === true)
    const legacy = floorSnapshot.isLegacyFloor(f)
    // ★ "当前这一支"必须**节点 + 变体**都对上（老记录永远不是"当前这一支"）。
    const current = head !== null && !legacy && f.nodeId === head.nodeId && f.variantId === head.variantId
    return {
      nodeId: f.nodeId, variantId: f.variantId, seq, at: f.at, updatedAt: f.updatedAt,
      legacy, current,
      // 同一楼、不是这一支（swipe 掉的另一支）—— 面板据此说清"这几行是同一楼的两支"。
      sameNode: head !== null && f.nodeId === head.nodeId,
      changed: changed.map((x) => ({ name: x.name, bytes: x.bytes, delta: x.delta })),
      // 「这一楼有哪几份」与"哪几份里有死区"都如实摊出来（面板据此说"那几段会保留盘上现况"）
      present: f.files.filter((x) => x.sha256 !== null).map((x) => x.name),
      absent: f.files.filter((x) => x.sha256 === null).map((x) => x.name),
      deadzone: f.files.filter((x) => x.sha256 !== null && deadSet.has(x.name)).map((x) => x.name),
    }
  }).sort((a, b) => {
    const sa = Number.isFinite(a.seq) ? a.seq : Number.MAX_SAFE_INTEGER
    const sb = Number.isFinite(b.seq) ? b.seq : Number.MAX_SAFE_INTEGER
    if (sa !== sb) return sa - sb
    if (a.nodeId !== b.nodeId) return String(a.nodeId).localeCompare(String(b.nodeId))
    return String(a.variantId ?? '').localeCompare(String(b.variantId ?? '')) || String(a.at ?? '').localeCompare(String(b.at ?? ''))
  })
  const lastFloor = read.index.last === null
    ? null
    : floorSnapshot.floorOfVariant(read.index, read.index.last.nodeId, read.index.last.variantId)
  return send(200, {
    ok: true,
    base: home.base, baseLabel: home.baseLabel, sharedHint: home.base === 'workspace-root',
    dir: floorSnapshot.FLOOR_DIR_NAME, docExists: read.exists, docError: read.error,
    targets: [...floorSnapshot.FLOOR_FILES],
    head: head === null ? null : { nodeId: head.nodeId, variantId: head.variantId, seq: headSeq },
    orderKnown: head === null ? false : headSeq !== null,
    last: read.index.last === null ? null : {
      nodeId: read.index.last.nodeId, variantId: read.index.last.variantId,
      seq: read.index.last.seq, at: read.index.last.at,
    },
    lastFloorSeq: lastFloor?.seq ?? null,
    // 死区数据 = "哪几段是作者的、回档时保留盘上现况"那份判据（读不出来 ⇒ `deadzonesReadable:false`，
    // 那时恢复整次不做 —— 面板要能把这件事说出来，⛔ 不许静默）
    deadzonesReadable: zones !== null, deadFiles: deadFiles ?? [],
    // 清单里那几条"只有 nodeId 的老记录"（**只读、不能拿来恢复** —— 面板要如实标一句）
    legacyFloors: floors.filter((f) => f.legacy === true).map((f) => ({ nodeId: f.nodeId, seq: f.seq })),
    floors,
    // ★★ 2026-09-24：那条**待处理**（判到回档时记的；没有 ⇒ `null`）—— 面板档顶那条显著横幅用。
    //   字段：`from*` = 档案停在哪（last）、`to*` = 剧情站到哪（head）、`target*` = 要写回的那一份快照、
    //   `targetKey` = "同一次回档"的判据（dismiss 也用它）、`source`('self'|'prev')、`why`('back'|'variant')、`at`。
    pending: read.index.pending === null || read.index.pending === undefined ? null : read.index.pending,
    // 最近一次回档（检测 / 手动恢复都落它；钩子落的，⛔ 本端点只读投影）
    lastAuto: readFloorStatus(home.playthroughId),
    checkedAt: new Date().toISOString(),
  })
}

/**
 * ★★ 2026-09-23：`POST /playthrough/rp-memory/floors/restore` —— 面板「**回到这一楼**」。
 * ★ 2026-09-23 改口径：体里带 `{nodeId, variantId}`（恢复到**那一支**）；
 *   `variantId` 缺席 ⇒ 只有一条"老记录"可认时**拒恢复**（404 / 409，见下）。
 *
 * 用户口径（§2.3）：**手动**触同一个恢复函数（与自动回档跟随**同一份** `runRestore`），
 * 面板上明说"会把笔记恢复到那一楼，且不影响会话"。恢复前**先给当下存一份**（可撤销）。
 *
 * 状态码口径照写侧那条（`POST …/write`）：体坏 400 / 认不出落点 409 / 那一楼没有快照 404 /
 * 有哪一份写不进去 **500 + 哪几份写不进去**（⛔ 绝不"部分成功当全成功"、⛔ 绝不静默）。
 * ⛔ 一个字节都不写剧情文本以外的任何东西（⛔ 不碰会话、⛔ 不碰归档、⛔ 不碰 Tavern）。
 */
async function handleRpMemoryFloorRestore(req, send, log, redact) {
  if (floorSnapshot === null) {
    return send(200, err('RP_MEMORY_FLOOR_UNAVAILABLE', `楼层快照模块（floor-snapshot.js）不可用：${floorSnapshotLoadError?.message || floorSnapshotLoadError}`))
  }
  const body = await readJsonObjectBody(req, send)
  if (body === null) return undefined
  const nodeId = typeof body.nodeId === 'string' ? body.nodeId : ''
  const variantId = typeof body.variantId === 'string' ? body.variantId : ''
  if (nodeId === '') {
    return send(400, err('RP_MEMORY_FLOOR_BAD_BODY', '要恢复到哪一楼得带 nodeId（列表里那一行的 id）'))
  }
  const home = floorHomeBound()
  if (home === null) {
    return send(409, err('RP_MEMORY_MISSING', '这个周目还没有记忆库（.roleplay-memory/）⇒ 没有可恢复的笔记'))
  }
  const read = floorSnapshot.readIndex(home.dir)
  if (read.error !== null) {
    return send(409, err('RP_MEMORY_FLOOR_INDEX_' + String(read.error).toUpperCase(),
      `楼层快照清单读不出来（${read.error}）⇒ 拒改（⛔ 不拿一份读不出来的清单去动你的笔记）`))
  }
  const target = floorSnapshot.floorOfVariant(read.index, nodeId, variantId)
  if (target === null) {
    return send(404, err('RP_MEMORY_FLOOR_NO_SNAPSHOT', '这一楼这一支没有快照（可能还没记过）⇒ 笔记保持原样'))
  }
  // ★ 老条目（只有 nodeId、不知道是哪一支）**只读不恢复** —— 一个字节都不写，并如实说清。
  if (!floorSnapshot.isRestorableFloor(target)) {
    return send(409, err('RP_MEMORY_FLOOR_LEGACY',
      '这一楼只有老记录（只有 nodeId、不知道是哪一支）⇒ 老记录只读、不许拿来恢复 ⇒ 笔记保持原样'))
  }
  const timeline = playthroughTimeline(home.characterId, home.playthroughId)
  const head = floorSnapshot.headOf(timeline)
  const seqMap = floorSnapshot.seqMapOf(timeline)
  const at = new Date().toISOString()
  const receipt = floorSnapshot.restoreFloor({
    memoryDir: home.dir, nodeId, variantId, head,
    seq: floorSnapshot.seqOfNode(seqMap, nodeId), at,
    stamp: deadzone !== null && typeof deadzone.stampNow === 'function' ? deadzone.stampNow() : at.replace(/[:.]/g, '-'),
    zones: floorDeadZones(home.dir),
  })
  if (receipt.kind === 'index-error') {
    return send(409, err('RP_MEMORY_FLOOR_INDEX_CORRUPT', '楼层快照清单读不出来 ⇒ 拒改'))
  }
  if (receipt.kind === 'no-snapshot') {
    return send(404, err('RP_MEMORY_FLOOR_NO_SNAPSHOT', '这一楼这一支没有快照 ⇒ 笔记保持原样'))
  }
  if (receipt.kind === 'legacy-no-restore') {
    return send(409, err('RP_MEMORY_FLOOR_LEGACY',
      '这一楼只有老记录（只有 nodeId、不知道是哪一支）⇒ 老记录只读、不许拿来恢复 ⇒ 笔记保持原样'))
  }
  const rest = receipt.restore
  // ★ 播报：手动那一脚也落同一条状态（面板顶上那句"最近一次回档跟随"两处共用一份措辞）。
  reportFloorReceipt(home, receipt, 'manual', head, log)
  const text = floorReceiptText(home, receipt)
  const view = {
    base: home.base, baseLabel: home.baseLabel, sharedHint: home.base === 'workspace-root',
    nodeId, variantId, seq: rest?.seq ?? null,
    restored: (rest?.moved ?? []).map((m) => ({
      name: m.name, bytes: m.bytes, backup: m.backup === null ? null : basename(m.backup),
      created: m.created === true, merged: m.merged === true,
    })),
    skipped: rest?.skipped ?? [],
    failed: rest?.failed ?? [],
    blocked: rest?.blocked ?? null,
    source: rest?.source ?? null,
    pre: receipt.pre === null ? null : { nodeId: receipt.pre.nodeId, variantId: receipt.pre.variantId, seq: receipt.pre.seq },
    // ★ 2026-09-24：这一脚成功后顺手清掉了那条待处理（面板据此知道"横幅该消失了"）；
    //   ⛔ 有哪一份没写进去 / 被死区挡住 ⇒ 不清（横幅还得在）。
    pendingCleared: receipt.pendingChanged === true,
    message: text,
  }
  if ((rest?.moved ?? []).length === 0 && (rest?.failed ?? []).length === 0) {
    // 一份都没写、也没失败 ⇒ 只是跳过（与那一楼逐字节一样 / 有死区按块合并后一样 / 那一楼没这份 / 老记录）：
    // ⛔ 这**不是**失败，但必须如实说清"为什么没动"，别让它看起来像"恢复成功了"。
    try { log?.info?.(`[mt] 楼层面板恢复（无写入）：${text}`) } catch {}
    return send(200, { ok: true, ...view, unchanged: true })
  }
  if ((rest?.failed ?? []).length > 0) {
    try { log?.warn?.(`[mt] 楼层面板恢复**没做完**：${text}`) } catch {}
    // 500 + 把"哪几份写不进去"如实带上（面板据此红字；⛔ 绝不部分成功当全成功）
    return send(500, Object.assign(err('RP_MEMORY_FLOOR_RESTORE_FAILED', redact ? redact(text) : text), { restore: view }))
  }
  try { log?.info?.(`[mt] 楼层面板恢复：${text}`) } catch {}
  return send(200, { ok: true, ...view, unchanged: false })
}

/**
 * ★★ 2026-09-24：`POST /playthrough/rp-memory/floors/pending/settle` —— 面板「**保持现状**」，
 * 语义 = **就地登记**（用户口径：「跟 Tavern 一致 —— 回档之后那段历史就是没有了，记忆回档之后也
 * 直接按新的来」）。⚠️ 名字里的 `dismiss` 是**面板那颗按钮的动作**（把横幅处理掉），
 * ⛔ 不是"什么都不做"—— 具体做什么全在纯函数 `floorSnapshot.settlePending` 里。
 *
 * 判据全在 `settlePending`：① 把**当下盘上那 5 份**的现文记成 **(pending.to*)** 那一支的快照；
 * ② `last` 锚到那一支（档案就地对齐到当前这一楼）；③ 清掉那条待处理。
 * ⛔ 那 5 份**正文一个字节都不写**（只读）、⛔ 不碰会话、⛔ 不碰归档、⛔ 不碰 Tavern。
 *
 * 体：`{ targetKey? }` —— 面板把它看到的那条 pending 的 `targetKey` 带上；**跟当下这条不一致**
 * （这段时间里又发生了另一次回档、目标换了）⇒ 409 `…_PENDING_STALE`，⛔ 绝不"按老目标就地登记"。
 * 状态码口径照写侧那条：体坏 400 / 认不出落点 409 / 清单读不出来 409。
 */
async function handleRpMemoryFloorPendingSettle(req, send, log, redact) {
  if (floorSnapshot === null) {
    return send(200, err('RP_MEMORY_FLOOR_UNAVAILABLE', `楼层快照模块（floor-snapshot.js）不可用：${floorSnapshotLoadError?.message || floorSnapshotLoadError}`))
  }
  const body = await readJsonObjectBody(req, send)
  if (body === null) return undefined
  const wantKey = typeof body.targetKey === 'string' ? body.targetKey : ''
  const home = floorHomeBound()
  if (home === null) {
    return send(409, err('RP_MEMORY_MISSING', '这个周目还没有记忆库（.roleplay-memory/）⇒ 没有可登记的'))
  }
  const read = floorSnapshot.readIndex(home.dir)
  if (read.error !== null) {
    return send(409, err('RP_MEMORY_FLOOR_INDEX_' + String(read.error).toUpperCase(),
      `楼层快照清单读不出来（${read.error}）⇒ 拒改（⛔ 不拿一份读不出来的清单去动你的笔记）`))
  }
  const cur = read.index.pending === null || read.index.pending === undefined ? null : read.index.pending
  if (cur !== null && wantKey !== '' && wantKey !== cur.targetKey) {
    return send(409, err('RP_MEMORY_FLOOR_PENDING_STALE',
      '这一条回档提示已经换成新的了（回档目标变了）⇒ 刷新面板再点（⛔ 没按你看到的那一条动手）'))
  }
  const at = new Date().toISOString()
  const r = floorSnapshot.settlePending(home.dir, { at })
  if (r.ok !== true) {
    return send(409, err('RP_MEMORY_FLOOR_INDEX_' + String(r.reason).toUpperCase(),
      `这条待处理登记不掉（${r.reason}）⇒ 拒改（⛔ 一个字节都没写）`))
  }
  const seat = (n) => (Number.isFinite(n) ? `第 ${n} 楼` : '当前这一楼')
  const text = r.changed && r.settled !== null
    ? `已「保持现状」（就地登记）：档案就地认成${seat(r.settled.seq)}现在的样子；⛔ 那 5 份笔记的正文一个字节都没写（只把账对齐了），⛔ 不影响会话`
    : '没有待处理的一条（本来就没什么可登记的）；⛔ 那 5 份笔记一个字节都没动'
  try {
    log?.info?.(r.changed && r.settled !== null
      ? `[mt] 楼层回档提示「保持现状」＝就地登记：档案锚到第 ${String(r.settled.seq ?? '?')} 楼（${String(r.settled.nodeId).slice(0, 18)}）—— 那 5 份正文一个字节都没写`
      : '[mt] 楼层回档提示「保持现状」：没有待处理的一条（一个字节都没写）')
  } catch {}
  return send(200, {
    ok: true,
    base: home.base, baseLabel: home.baseLabel, sharedHint: home.base === 'workspace-root',
    changed: r.changed === true,
    // ★ 就地登记成了哪一支（面板据此说人话）；顺手重取清单就能看到那一行
    settled: r.settled === null ? null : { nodeId: r.settled.nodeId, variantId: r.settled.variantId, seq: r.settled.seq },
    pending: null,
    message: redact ? redact(text) : text,
  })
}

/**
 * 读一个 JSON 对象请求体（三个新写端点的公共前几步：限长 / 合法 JSON / 必须是对象）。
 * 不成 ⇒ **已经 send 出去**并返回 `null`（调用方直接 return，⛔ 别继续干活）。
 */
async function readJsonObjectBody(req, send) {
  let buf
  try {
    buf = await readBody(req, BODY_LIMIT)
  } catch (e) {
    if (e && e.code === 'PAYLOAD_TOO_LARGE') {
      send(413, err('PAYLOAD_TOO_LARGE', `请求体超过 ${BODY_LIMIT} 字节上限`))
      return null
    }
    send(400, err('RP_MEMORY_BAD_BODY', `请求体读取失败：${(e && e.message) || e}`))
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(buf.toString('utf8'))
  } catch {
    send(400, err('RP_MEMORY_BAD_BODY', '请求体不是合法 JSON'))
    return null
  }
  if (!isPlainObject(parsed)) {
    send(400, err('RP_MEMORY_BAD_BODY', '请求体必须是 JSON 对象'))
    return null
  }
  return parsed
}

/**
 * GET /anima/ingest-state —— 「后台收纳状态」只读出口（20260919）。
 *
 * 读的是 dsh-anima-rag 插件落的 `<DSH_HOME>/dsh-anima-rag/ingest-state.json`（两个插件之间
 * 没有直接通道，**走文件**是本项目一贯的交接方式，与 `auto-collect.json` 同款）。面板的
 * `shell.overlay` 提示条拿它显示「记忆库正在后台收纳当前会话」。
 * ⛔ 纯只读；⛔ 只投影白名单字段（不吐原始文件、⛔ 不吐任何路径）；文件还没有 ⇒ `state: null`
 * （面板据此**不显示**提示，这是正常态，不是错误）。
 */
async function handleAnimaIngestState(send) {
  const file = join(dshHomeDir(), 'dsh-anima-rag', 'ingest-state.json')
  let raw = null
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    if (e && e.code === 'ENOENT') return send(200, { ok: true, state: null })
    return send(200, err('ANIMA_STATE_READ_FAILED', `收纳状态读取失败：${String((e && e.message) || e)}`))
  }
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const str = (v) => (typeof v === 'string' && v !== '' ? v : '')
  return send(200, {
    ok: true,
    state: {
      running: raw?.running === true,
      at: num(raw?.at),
      startedAt: num(raw?.startedAt),
      finishedAt: num(raw?.finishedAt),
      playthroughId: str(raw?.playthroughId),
      characterId: str(raw?.characterId),
      source: str(raw?.source) || null,
      pending: num(raw?.pending),
      inserted: num(raw?.inserted),
      failed: num(raw?.failed),
      skipped: str(raw?.skipped) || null,
      error: str(raw?.error) || null,
    },
  })
}

/**
 * GET /vector/state —— 「向量」页签的**只读**出口（2026-09-20）。
 *
 * 读什么：`<DSH_HOME>/dsh-anima-rag/` 下 anima 落的三张文件（状态快照 / 回执 / 入库状态）。
 * 实现全在 `./vector-panel.js`（那边有路径基准与容错口径）；这里只接线 + 把模块缺席降级成可读错误。
 *
 * ⛔ 纯只读：本端点一个字节都不写。
 * ⛔ key 绝不进响应：这里交出去的是 anima 写的快照，正常不含 `retrieval.key`；`send()` 那层
 *   还会对响应体做一次全局擦除（见 createHandler 里的 secretKeysOf 循环）—— 双保险。
 * 快照不存在 ⇒ `info: null`（面板据此显示"还没有快照"，这是正常态：anima 还没跑过那一脚）。
 */
async function handleVectorState(send) {
  if (vectorPanel === null) {
    return send(200, err('VECTOR_PANEL_UNAVAILABLE', `向量面板模块不可用，已降级（${vectorPanelLoadError?.message || vectorPanelLoadError}）`))
  }
  try {
    return send(200, { ok: true, ...vectorPanel.readVectorState({ homeDir: dshHomeDir() }) })
  } catch (e) {
    // readVectorState 自身承诺不抛（文件坏/缺失都回 null）；走到这里说明是意外（如 DSH_HOME 不是字符串）
    return send(500, err('VECTOR_STATE_FAILED', `读向量状态失败：${String((e && e.message) || e)}`))
  }
}

/**
 * POST /vector/action —— 「向量」页签的动作出口（2026-09-20）。body：`{action, note?, enabled?, playthroughId?}`。
 *
 * 三条路，⛔ 别混：
 *   · `action === 'enable'`（面板那颗**参与检索**开关）—— **不走 anima**：它就是一个配置项，
 *     走本仓既有的「读-改-写」helper（readConfigFile → mergeConfig → writeConfigFile + 回读校验），
 *     ⛔ 绝不 writeFileSync 整份覆盖（那会丢掉 retrieval.url/model/key 等所有别的字段）。
 *   · `action === 'delete-vector' | 'delete-bm25'` —— ★★ 2026-09-22（用户口径「直接冻面板 60s，
 *     然后告诉我要下一轮？**改成直接删**」）：**当次就做完**，回执随本次响应回去（`deleted:true`）。
 *     删除 = 改名留档 + 忘账本，宿主平面自己做得到（实现全在 `./vector-panel.js` 的 `deleteNow`，
 *     逐字对齐 anima 的删除语义）；⛔ 不再写请求单、⛔ 不再等该周目的下一轮。
 *     `playthroughId` 只用来定位"该忘哪个周目的账本"（清单由宿主自己去读那份归档的
 *     `summaries/index.json`，⛔ 不接受客户端递来的文件名列表）。
 *   · `action === 'ingest-now' | 'rebuild'` —— 写一张**请求单**给 anima（真正拥有向量库和引擎的是它，
 *     实现只有一份）：面板立刻得到"已排队"并**放开按钮**，回执到了再自己更新（⛔ 不再冻面板 60 秒）。
 *   · 不认识的 action ⇒ 400 UNKNOWN_ACTION（⛔ 不猜、不写盘）。
 *
 * ⛔ `retrieval.key` 绝不出现在任何响应体里：下面每一条 return 都只回 action/id/message/固定 hint，
 *   一次都没有把 config 或请求体原样交出去。
 */
async function handleVectorAction(req, send, redact) {
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
  let body
  try {
    body = JSON.parse(bodyBuf.toString('utf8'))
  } catch {
    return send(400, err('BAD_REQUEST', '请求体不是合法 JSON'))
  }
  if (!isPlainObject(body)) return send(400, err('BAD_REQUEST', '请求体必须是 JSON 对象'))
  const action = typeof body.action === 'string' ? body.action : ''
  const note = typeof body.note === 'string' ? body.note : ''

  // ① 面板开关（不走 anima）：写的是本插件自己的 config，走既有读-改-写 helper。
  if (action === 'enable') {
    if (typeof body.enabled !== 'boolean') {
      return send(400, err('BAD_REQUEST', '"enabled" 必须是布尔值（开关只有开/关两态）'))
    }
    try {
      const { config: current } = readConfigFile()
      const next = mergeConfig(current, { retrieval: { chatEnabled: body.enabled } })
      writeConfigFile(next)
      // 回读校验（与 handlePutConfig 同款的"写完要能读回来"纪律）：读不回刚写的值就如实报 500，
      // ⛔ 不假装成功 —— 静默失效正是这个开关最容易踩的坑（sanitize 漏放行就会这样）。
      const reread = readConfigFile()
      if ((reread.config.retrieval?.chatEnabled ?? true) !== body.enabled) {
        return send(500, err('CONFIG_WRITE_UNVERIFIED', '写盘后回读校验不一致（retrieval.chatEnabled）'))
      }
      return send(200, { ok: true, saved: true, chatEnabled: body.enabled })
    } catch (e) {
      if (e && e.code === 'CONFIG_INVALID') return send(400, err('CONFIG_INVALID', redact(e.message)))
      throw e
    }
  }

  // ② 四个真动作：删除**当场做完**，入库/重建写请求单等 anima 取走。
  if (vectorPanel === null) {
    return send(200, err('VECTOR_PANEL_UNAVAILABLE', `向量面板模块不可用，已降级（${vectorPanelLoadError?.message || vectorPanelLoadError}）`))
  }
  if (!vectorPanel.isKnownAction(action)) {
    return send(400, err('UNKNOWN_ACTION', `不认识的 action「${action}」；可用：${vectorPanel.PANEL_ACTIONS.join(' / ')}`))
  }
  if (vectorPanel.isDeleteAction(action)) {
    // ★★ 2026-09-22：**点了就删** —— 删除不需要 anima 的引擎（改名留档 + 忘账本），宿主平面当场做完，
    //   回执随本次响应回去；面板不再转 60 秒。逐字对齐 anima 的删除语义，见 ./vector-panel.js 的 deleteNow。
    //   ⛔ 忘账本的清单由宿主自己去读归档的 summaries/index.json（只收"是哪个周目"这一个输入）。
    const playthroughId = typeof body.playthroughId === 'string' ? body.playthroughId : ''
    const out = vectorPanel.deleteNow({
      homeDir: dshHomeDir(),
      action,
      summariesDir: summariesDirOfPlaythrough(playthroughId) || '',
    })
    if (out.ok !== true) {
      // DELETE_FAILED（改名失败）：回执已落盘 ⇒ 如实 500，面板「最近一次动作」也看得到原因。
      // 其余两种（快照读不到 / 缺落点）**一个字节都没动** ⇒ 200 + 可读错误（与本 handler 里
      // "模块不可用"那条同款口径：面板拿 ok!==true 当失败显示那句人话）。
      return send(out.code === 'DELETE_FAILED' ? 500 : 200, err(out.code, out.message))
    }
    return send(200, {
      ok: true,
      deleted: true,
      ...out.receipt,
      // 回执没落盘时那句话也要带回去（⛔ 不静默）；正常路径下这两项是 false/''。
      ledgerForgotten: out.ledgerForgotten,
      requestConsumed: out.requestConsumed,
      receiptNote: out.note,
    })
  }
  const reqDoc = vectorPanel.writeRequest({ homeDir: dshHomeDir(), action, note })
  if (reqDoc === null) {
    // writeRequest 只在 action 不认识时回 null —— 上面已经拦过，走到这里说明两边白名单漂移了。
    return send(400, err('UNKNOWN_ACTION', `不认识的 action「${action}」（白名单校验不一致，请查 lib/vector-panel.js）`))
  }
  return send(200, {
    ok: true,
    queued: true,
    id: reqDoc.id,
    action: reqDoc.action,
    hint: '已排队：anima 会在该周目会话的下一轮开始前执行',
  })
}

/**
 * 「这个周目」的归档摘要目录 —— 删除时**宿主自己**去那里读 `index.json` 拿文件名清单
 * （⛔ 不接受客户端递来的清单；客户端只能告诉我们"是哪个周目"这一个输入）。
 *
 * 走的是本文件既有的知识：工作区根 `tavernRootPath()` + `sessionIndex()` 的
 * `byId`（周目 → 角色；判据与 `sessionPlaythroughDir` 同款，⛔ 不另造一套解析）。
 * 解不出（没绑工作区根 / catalog 读不到 / 这个周目不认识 / 传了个像路径的东西）⇒ `null`，
 * 调用方据此"一条账本都不忘"并如实播报（⛔ 宁可不错忘别的周目）。
 */
function summariesDirOfPlaythrough(playthroughId) {
  const pt = typeof playthroughId === 'string' ? playthroughId.trim() : ''
  if (pt === '') return null
  // 拒收（⛔ 不清洗后放行）：周目 id 只会当路径的一段用，绝不许夹带分隔符或 `..`
  if (pt.includes('/') || pt.includes('\\') || pt === '.' || pt === '..') return null
  const root = tavernRootPath()
  if (root === '') return null
  const idx = sessionIndex()
  const characterId = idx && idx.byId instanceof Map ? String(idx.byId.get(pt)?.characterId ?? '') : ''
  if (characterId === '') return null
  return join(root, characterId, pt, 'archive', 'summaries')
}

/**
 * 本会话的**活会话对象** —— `sessionProjections.stateOf(session, key)` 与 `tokenMeter.measure(session)`
 * 两个官方服务都要它（同一口径：`ctx.sessions.get(id)` 拿注册表里的那一个）。
 * 拿不到 ⇒ `session: null` + 一句人话原因（⛔ 不编一个壳顶上去 —— 那样读到的数全是假的）。
 */
function liveSessionOf(ctx, sessionId) {
  const sessions = getService(ctx, 'sessions')
  if (!sessions || typeof sessions.get !== 'function') {
    return { session: null, reason: '宿主没有 sessions 服务（拿不到活会话注册表）' }
  }
  try {
    const session = sessions.get(sessionId)
    if (session === undefined || session === null) {
      return { session: null, reason: '这个会话不在活会话注册表里（宿主重启过 / 会话已关）—— 实时占用读不到' }
    }
    return { session, reason: null }
  } catch (e) {
    return { session: null, reason: `sessions.get(${sessionId}) 抛错：${String((e && e.message) || e)}` }
  }
}

/**
 * 组装 `GET /compaction/state` 的响应（**如实**是唯一纪律：拿不到的字段一律 null + 一句人话原因）。
 *
 * 两个数**故意分开**（任务书 §1.2 的硬要求）：
 *   · `percent` / `usedTokens` —— DSH 自带的那个上下文占用率（`contextPressure` 投影，
 *     **不含输出 token**，是 prompt 侧压力）；
 *   · `triggerPercent` / `triggerTokens` —— **真正被拿去比阈值的那个数**（`tokenMeter.measure`
 *     的 `totalTokens`，**含输出 token**，还可能退化成启发式估算）。
 *   ⇒ 面板两个都显示，⛔ 不许只给一个让人以为是同一个。
 *
 * ⛔ 本函数不自己估算任何数：投影/计量服务拿不到就是 null（客户端显示红字「读不到（原因）」）。
 */
function readCompactionState(ctx, sessionId) {
  const { config } = readConfigFile()
  const usePanelThreshold = config.autoCompact?.usePanelThreshold !== false
  const thresholdPercent = config.autoCompact?.thresholdPercent ?? AUTO_COMPACT_DEFAULT_PERCENT
  const preset = compactionThreshold.readDeployedThresholdRatio(agentPresetsRootDir())
  const reasons = []
  let occupancy = { percent: null, usedTokens: null, formula: null, reason: null }
  let trigger = { percent: null, totalTokens: null, reason: null }
  let contextWindow = null

  if (typeof sessionId !== 'string' || sessionId === '') {
    reasons.push('没给 sessionId（面板得先知道"看哪个会话"）')
  } else {
    const live = liveSessionOf(ctx, sessionId)
    if (live.session === null) reasons.push(live.reason)
    else {
      const projections = getService(ctx, 'sessionProjections')
      let state = null
      if (!projections || typeof projections.stateOf !== 'function') {
        reasons.push('宿主没有 sessionProjections 服务（读不到 contextPressure 投影）')
      } else {
        try {
          state = projections.stateOf(live.session, 'contextPressure')
        } catch (e) {
          reasons.push(`读 contextPressure 投影抛错：${String((e && e.message) || e)}`)
        }
      }
      if (state !== null && state !== undefined) {
        occupancy = compactionThreshold.contextOccupancy(state)
        if (occupancy.reason !== null) reasons.push(occupancy.reason)
        contextWindow = typeof state.contextWindow === 'number' && Number.isFinite(state.contextWindow)
          ? state.contextWindow
          : null
      }
      const meter = getService(ctx, 'tokenMeter')
      if (!meter || typeof meter.measure !== 'function') {
        reasons.push('宿主没有 tokenMeter 服务（读不到触发判定用的 token 数）')
      } else {
        let measured = null
        try {
          measured = meter.measure(live.session)
        } catch (e) {
          reasons.push(`tokenMeter.measure 抛错：${String((e && e.message) || e)}`)
        }
        if (measured !== null && measured !== undefined) {
          // 窗口优先用投影那份（同一条通路上的数）；计量自己带了 contextWindow 才用它 —— ⛔ 不猜
          const windowForTrigger = contextWindow !== null
            ? contextWindow
            : (typeof measured.contextWindow === 'number' && Number.isFinite(measured.contextWindow) ? measured.contextWindow : null)
          if (contextWindow === null && windowForTrigger !== null) contextWindow = windowForTrigger
          trigger = compactionThreshold.triggerOccupancy(measured, windowForTrigger)
          if (trigger.reason !== null) reasons.push(trigger.reason)
        }
      }
    }
  }

  const readError = reasons.length > 0 ? reasons.join('；') : null
  // 生效的阈值比例：面板开着 = 面板那个数；面板关着 = 预设 YAML 里读到的那个（读不到 ⇒ null，⛔ 不当 0）
  const effectiveRatio = usePanelThreshold ? thresholdPercent / 100 : (preset.ok ? preset.ratio : null)
  const thresholdTokens = contextWindow === null || effectiveRatio === null
    ? null
    : Math.floor(contextWindow * effectiveRatio)
  const notes = compactionThreshold.compactionNotes({
    thresholdPercent,
    usePanelThreshold,
    presetRatio: preset.ok ? preset.ratio : null,
    readError,
  })
  if (!preset.ok && preset.reason) notes.push('预设阈值那一条读不到的原因：' + preset.reason)
  return {
    ok: true,
    // 面板开关（= config.autoCompact.usePanelThreshold）。字段名按任务书的响应形状叫 enabled。
    enabled: usePanelThreshold,
    thresholdPercent,
    presetThresholdRatio: preset.ok ? preset.ratio : null,
    presetThresholdReason: preset.ok ? null : preset.reason,
    // ★ 两个数：percent = DSH 那个（prompt 侧压力）；triggerPercent = 真正比阈值的那个（含输出 token）
    percent: occupancy.percent,
    triggerPercent: trigger.percent,
    usedTokens: occupancy.usedTokens,
    triggerTokens: trigger.totalTokens,
    // 触发阈值折算成 token（用**生效口径**：面板开着就用面板那个数）—— 只作展示；
    // 官方那层用的是它自己算的 `floor(contextWindow × thresholdRatio)`，同式同值。
    thresholdTokens,
    effectiveThresholdRatio: effectiveRatio,
    contextWindow,
    sessionId: typeof sessionId === 'string' && sessionId !== '' ? sessionId : null,
    readError,
    notes,
  }
}

/** GET /compaction/state?sessionId=…（只读；拿不到就 null + readError，⛔ 绝不自己估算）。 */
async function handleCompactionState(ctx, url, send) {
  if (compactionThreshold === null) {
    return send(200, err('COMPACTION_PANEL_UNAVAILABLE', `压缩面板模块不可用，已降级（${compactionThresholdLoadError?.message || compactionThresholdLoadError}）`))
  }
  try {
    const sessionIdParam = url.searchParams.get('sessionId')
    return send(200, readCompactionState(ctx, typeof sessionIdParam === 'string' ? sessionIdParam : ''))
  } catch (e) {
    return send(200, err('COMPACTION_STATE_FAILED', `读压缩状态失败：${String((e && e.message) || e)}`))
  }
}

/**
 * POST /compaction/config —— 「压缩」档的保存出口（2026-09-21）。body：`{usePanelThreshold?, thresholdPercent?}`。
 *
 * **两件事各自如实**（⛔ 不许一个失败另一个报成功）：
 *   ① 写 `config.json`（走既有配置管线：read → merge → 原子写 → 回读校验）；
 *   ② **点改部署的预设 YAML** 里的 `thresholdRatio` = `thresholdPercent/100`
 *      —— 先数出现次数（≠1 就拒绝改）、改前备份 `.bak-<时间戳>`、**写后回读校验**
 *      （实现全在 ./compaction-threshold.js 的 `writeDeployedThresholdRatio`）。
 * 两条**互不牵连**：config 写失败也照样去试预设那条（用户要的是两件事都办），各自回报。
 *
 * 整体 `ok` = 两条都 ok；不全 ok 时另给 `error.message`（把两条的原因都写进去），
 * 好让客户端在"看不了结构化字段"的地方也能把话说全。
 */
async function handleCompactionConfig(req, send, redact) {
  const ct = String((req.headers && req.headers['content-type']) || '')
  if (!ct.toLowerCase().includes('application/json')) {
    return send(415, err('UNSUPPORTED_MEDIA_TYPE', '只接受 application/json'))
  }
  if (compactionThreshold === null) {
    return send(200, err('COMPACTION_PANEL_UNAVAILABLE', `压缩面板模块不可用，已降级（${compactionThresholdLoadError?.message || compactionThresholdLoadError}）`))
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
  let body
  try {
    body = JSON.parse(bodyBuf.toString('utf8'))
  } catch {
    return send(400, err('BAD_REQUEST', '请求体不是合法 JSON'))
  }
  if (!isPlainObject(body)) return send(400, err('BAD_REQUEST', '请求体必须是 JSON 对象'))
  const hasPercent = body.thresholdPercent !== undefined && body.thresholdPercent !== null
  const hasSwitch = body.usePanelThreshold !== undefined && body.usePanelThreshold !== null

  // ① config.json
  let configPart = { ok: false, reason: '请求里既没有 usePanelThreshold 也没有 thresholdPercent —— 什么都没改', usePanelThreshold: null, thresholdPercent: null }
  let appliedPercent = hasPercent ? clampAutoCompactPercent(body.thresholdPercent).percent : null
  let appliedSwitch = hasSwitch ? body.usePanelThreshold === true : null
  const clampedNote = hasPercent ? clampAutoCompactPercent(body.thresholdPercent) : null
  if (hasSwitch || hasPercent) {
    try {
      const { config: current } = readConfigFile()
      const patch = {}
      if (hasSwitch) patch.usePanelThreshold = body.usePanelThreshold
      if (hasPercent) patch.thresholdPercent = body.thresholdPercent
      const next = mergeConfig(current, { autoCompact: patch })
      writeConfigFile(next)
      // 回读校验（与 handlePutConfig 同一纪律）：读不回刚写的值就如实报失败，⛔ 不假装成功
      const reread = readConfigFile()
      const sameSwitch = (reread.config.autoCompact?.usePanelThreshold ?? true) === (next.autoCompact?.usePanelThreshold ?? true)
      const samePercent = (reread.config.autoCompact?.thresholdPercent ?? AUTO_COMPACT_DEFAULT_PERCENT)
        === (next.autoCompact?.thresholdPercent ?? AUTO_COMPACT_DEFAULT_PERCENT)
      if (!sameSwitch || !samePercent) {
        configPart = {
          ok: false, reason: '写盘后回读校验不一致（config.json）',
          usePanelThreshold: null, thresholdPercent: null,
        }
      } else {
        appliedPercent = reread.config.autoCompact?.thresholdPercent ?? AUTO_COMPACT_DEFAULT_PERCENT
        appliedSwitch = reread.config.autoCompact?.usePanelThreshold !== false
        configPart = {
          ok: true,
          reason: clampedNote !== null && clampedNote.clamped ? clampedNote.reason : null,
          usePanelThreshold: appliedSwitch,
          thresholdPercent: appliedPercent,
        }
      }
    } catch (e) {
      if (e && e.code === 'CONFIG_INVALID') {
        configPart = { ok: false, reason: redact(e.message), usePanelThreshold: null, thresholdPercent: null }
      } else {
        configPart = { ok: false, reason: `写配置失败：${String((e && e.message) || e)}`, usePanelThreshold: null, thresholdPercent: null }
      }
    }
  }

  // ② 部署的预设 YAML（值 = thresholdPercent/100）。⛔ 没带 thresholdPercent 就不动预设一个字节。
  let yamlPart
  if (!hasPercent) {
    yamlPart = { ok: false, changed: false, path: null, backupPath: null, before: null, after: null, reason: '本次请求没带 thresholdPercent ⇒ 预设 YAML 一个字都没改' }
  } else {
    const ratio = (appliedPercent === null ? clampAutoCompactPercent(body.thresholdPercent).percent : appliedPercent) / 100
    yamlPart = compactionThreshold.writeDeployedThresholdRatio({ presetRoot: agentPresetsRootDir(), ratio })
  }

  const ok = configPart.ok && yamlPart.ok
  const parts = []
  parts.push('config.json：' + (configPart.ok ? (configPart.reason === null ? '已写入' : `已写入（${configPart.reason}）`) : `没写成（${configPart.reason}）`))
  parts.push('预设 YAML：' + (yamlPart.ok ? (yamlPart.changed === false ? '本来就是这个数（未改动）' : `已写入 ${yamlPart.path}`) : `没改成（${yamlPart.reason}）`))
  const payload = {
    ok,
    config: { ok: configPart.ok, reason: configPart.reason, usePanelThreshold: configPart.usePanelThreshold, thresholdPercent: configPart.thresholdPercent },
    yaml: {
      ok: yamlPart.ok,
      changed: yamlPart.changed === true,
      path: yamlPart.path ?? null,
      backupPath: yamlPart.backupPath ?? null,
      presetId: yamlPart.presetId ?? null,
      before: yamlPart.before ?? null,
      after: yamlPart.after ?? null,
      reason: yamlPart.reason ?? null,
    },
    applied: {
      usePanelThreshold: appliedSwitch === null ? configPart.usePanelThreshold : appliedSwitch,
      thresholdPercent: appliedPercent,
      thresholdRatio: hasPercent ? (appliedPercent === null ? null : appliedPercent / 100) : null,
    },
    note: parts.join('；'),
  }
  if (!ok) payload.error = { code: 'COMPACTION_CONFIG_PARTIAL', message: parts.join('；') }
  return send(200, payload)
}

/** 从一条消息里取纯文本：只认文本块（⛔ 不做标记/段识别）。 */
function messageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const parts = []
  for (const b of blocks) {
    if (typeof b === 'string') { parts.push(b); continue }
    if (b && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n').trim()
}

/**
 * 同步刷新回响缓存 —— **唯一的写入口**（段 provider 只读缓存）。
 * @returns 命中的楼层数；未启用 / 空文本 / **本会话认不出周目** ⇒ 清空缓存并返回 0；异常 ⇒ -1（调用方只记日志）。
 */
function echoRefreshSync(holder, injector, text, sessionId) {
  try {
    const clear = () => { holder.query = null; holder.floors = []; injector.refresh() }
    const cfg = readConfigFile().config.echo ?? {}
    if (cfg.enabled !== true || typeof text !== 'string' || text.trim() === '') {
      clear()
      return 0
    }
    // ★★ 2026-09-20 口径（会话优先）：回响的语料必须是**本会话自己的周目**。
    //   认不出 ⇒ **不回响**（清空缓存）—— ⛔ 不许拿 `config.root`（面板绑定）兜底：
    //   那正是一条新会话"回响"上一轮剧情的原因。
    const arc = echoArchiveSource(sessionId)
    if (arc.source === null) {
      clear()
      return 0
    }
    holder.query = { text, excludeFloors: [], source: arc.source }
    // ★ 每条 doc 必须带上 source：索引按 (source, floor) 存 docKey，检索时又用 source 过滤
    //   —— 不带 source（存成空串）却按周目过滤 ⇒ **永远 0 命中**。这是本接线第一版的真 bug，
    //   在沙箱里被"真注入"验收抓到的（`_verify-echo-injection.mjs`）。
    holder.floors = (Array.isArray(arc.floors) ? arc.floors : []).map((f) => ({ ...f, source: arc.source ?? '' }))
    injector.refresh()
    return holder.floors.length
  } catch {
    return -1
  }
}

/** 接线：注册段（同步 provider）+ 入箱即算的缓存刷新。绝不抛（调用方还会再包一层）。 */
function registerEcho(ctx, log) {
  if (!echoModules || typeof echoModules.createEchoInject !== 'function') {
    log.warn(`[mt] 记忆回响模块不可用，未接线（${echoModulesLoadError?.message || echoModulesLoadError}）`)
    return
  }
  if (!ctx || typeof ctx.plugin !== 'function') {
    log.warn('[mt] ctx.plugin 不可用，记忆回响未接线（段与注入都不注册）')
    return
  }
  const holder = { query: null, floors: [], sid: null }
  const injector = echoModules.createEchoInject({
    getConfig: () => { try { return readConfigFile().config.echo ?? {} } catch { return {} } },
    storageDir: storageDir(),
    query: () => holder.query,
    loadFloors: () => holder.floors,
  })
  const section = injector.section // { name:'dma:echo', order:54, text:'' }
  ctx.plugin({
    name: 'dsh-memory-archive:echo',
    inject: ['systemPrompt', 'sessionQuery'],
    apply(scope) {
      // 调试开关（默认关）：MT_ECHO_DEBUG=1 ⇒ 每轮把"回响算到哪一步"落进 <storageDir>/echo-debug.json
      // （只记阶段名与计数/长度，⛔ 不放正文）。接线排障用，生产不写。
      const dbg = (stage, extra) => {
        if (process.env.MT_ECHO_DEBUG !== '1') return
        try {
          writeFileSync(join(storageDir(), 'echo-debug.json'), JSON.stringify({ at: new Date().toISOString(), stage, ...extra }) + '\n', 'utf8')
        } catch {}
      }
      const echoCfg = () => { try { return readConfigFile().config.echo ?? {} } catch { return {} } }
      // ① 主路径：人类消息入收件箱（`agent/inbox/spliced`，turn 开始之前）⇒ 同步算好缓存。
      //   这是唯一"早于本轮装配、又拿得到本轮输入"的时机（见上方接线说明的时序）。
      //   只认 `source.kind === 'user'`（直连人类提示）：plugin 注入的上下文/技能正文不算玩家输入。
      scope.on('session/event', (session, event) => {
        try {
          if (event?.type !== 'agent/inbox/spliced') return
          const inserted = event.data?.inserted
          if (!Array.isArray(inserted) || inserted.length === 0) return
          const human = inserted.filter((m) => m?.source?.kind === 'user')
          if (human.length === 0) return
          const text = human.map(messageText).filter((t) => t !== '').join('\n')
          if (text === '') return
          const sid = session?.id
          if (typeof sid === 'string' && sid !== '') holder.sid = sid
          if (echoCfg().enabled !== true) return
          const floors = echoRefreshSync(holder, injector, text, sid)
          dbg('refresh-splice', { floors, queryChars: text.length, echoChars: section.text.length })
        } catch (e) {
          try { dbg('threw', { where: 'splice', message: String(e?.message || e).slice(0, 200) }) } catch {}
        }
      })
      // ② 兜底 + 防串场：装配期只做两件事 —— 会话换了先**同步清空**，再**异步**预热下一轮。
      //   ⛔ 这里绝不改写 assembly.sections（组装捕获是先快照后 next ⇒ 改了会让查看器与事实不符）。
      scope.on('system-prompt/assemble', async (assembly, assembleContext, next) => {
        try {
          const sid = assembleContext?.agent?.session?.id ?? null
          if (typeof sid === 'string' && sid !== '' && holder.sid !== null && holder.sid !== sid) {
            holder.sid = sid
            echoRefreshSync(holder, injector, '', sid) // 别的会话的回响⛔绝不许串进这一场
            dbg('cleared-other-session', {})
          }
          if (echoCfg().enabled === true && typeof sid === 'string' && sid !== '' && holder.query === null) {
            // 冷启动（刚挂载/续跑会话）：本轮装配已来不及，预热缓存让**下一轮**有回响。
            const text = await echoWithBudget(echoLastTurnText(scope, sid), ECHO_PREP_BUDGET_MS)
            if (typeof text === 'string' && text !== '' && holder.query === null) {
              holder.sid = sid
              const floors = echoRefreshSync(holder, injector, text, sid)
              dbg('warm', { floors, queryChars: text.length, echoChars: section.text.length })
            }
          }
        } catch (e) {
          try { dbg('threw', { where: 'assemble', message: String(e?.message || e).slice(0, 200) }) } catch {}
          try { log.warn(`[mt] 记忆回响本轮跳过：${e?.message || e}`) } catch {}
        }
        return next()
      })
      // 段注册：provider 同步、只返回缓存值（官方约束）；/sections 与查看器因此能看到这一段。
      scope.effect(() => scope.systemPrompt.section({
        name: section.name,
        order: section.order,
        text: () => section.text,
      }), 'echo.section()')
    },
  })
  log.info(`[mt] 记忆回响已接线（段 ${section.name} @${section.order}；默认关，开关走 /config 的 echo.enabled）`)
}

// ---------------------------------------------------------------------------
// 「最近几楼」（mt:lastFloors @10202，2026-09-17）
//
// 解决什么：新开的周目会话是**空的**（254 楼只在 archive/floors 里），模型开局没有可承接的
// 上下文 ⇒ 回复质量无从判断。本段把最近 N 楼原文注入成 <recentFloors>，位置是**倒数第二**
// （紧随其后的 mt:postHistory@10203 = 卡的后处理指令，保持绝对最后）。
//
// 四条口径：
//   · ⛔ 做不到注册成真会话历史（messages 块由宿主管）⇒ 只能是一段 system；
//   · 位置必须是倒数第二（在后处理提示词**之前**）；
//   · ★ 触发条件（用户 2026-09-19 改）：**当前上下文 < 5000 字**（`LAST_FLOORS_CONTEXT_CHARS`）
//     就注入，上下文长过阈值就停 —— 不再只看"首轮"。字数是**带外**算的缓存值（非遮蔽正文
//     总字数），算不出来时回退"首轮"判据；
//   · ★★ 2026-09-20（用户口径「认不出来的会话默认为新会话。会话优先」）：**语料与门都按会话** ——
//     只有「这个会话自己解析得出周目」才注入，语料就是**它那个**周目的归档楼层。
//     ⛔ 旧口径是"门看 catalog∪config、语料看 config" ⇒ 两者可能指两个周目；一条新会话还会
//     被塞进**上一轮**的最近几楼。认不出的会话（编程会话 / Tavern 没认领的新会话）一个字都不注。
//
// 接线纪律（照抄 echo）：段 provider **同步**、只返回算好的字符串；绝不抛；模块/服务缺席只降级。
// ---------------------------------------------------------------------------

/** 接线：注册 `mt:lastFloors` 段 + 带外算「当前上下文字数」+ 越权看守。绝不抛（调用方还会再包一层）。 */
function registerLastFloors(ctx, log) {
  if (!lastFloors) {
    log.warn(`[mt] 最近几楼模块不可用，未接线（${lastFloorsLoadError?.message || lastFloorsLoadError}）`)
    return
  }
  if (!echoModules || typeof echoModules.readArchiveFloors !== 'function') {
    log.warn(`[mt] 归档楼层读取不可用，最近几楼未接线（${echoModulesLoadError?.message || echoModulesLoadError}）`)
    return
  }
  if (!ctx || typeof ctx.plugin !== 'function') {
    log.warn('[mt] ctx.plugin 不可用，最近几楼未接线（段不注册）')
    return
  }
  /** 读盘缓存：一次装配要读 254 个文件，靠 TTL 把「每一步都重读」压成「每 20 s 一次」。 */
  const cache = { source: null, floors: [], at: 0 }
  /** 「本会话解析得出周目吗」缓存（sid → `{yes, at}`；LRU 上限 64，与上下文缓存同款）。 */
  const hasPtCache = new Map()
  const cfgOf = () => { try { return readConfigFile().config } catch { return {} } }
  /**
   * ★ **周目门**（必须有）：本段注的是**这个周目**的归档楼层 —— 认不出周目的会话
   * （你正在跟 AI 干活的编程会话、或 **Tavern 还没认领的新会话**）⛔ 一个字都不许注。
   *
   * ★★ 2026-09-20 口径（「认不出来的会话默认为新会话。会话优先」）：判据改成**会话自己解析得出的周目**
   *   （`sessionPlaythroughOf`）—— 与下面取语料的那个条件**同一条**。
   *   ⛔ 旧判据是 `autoCollectScope().ids`（catalog 的 rootSessionId ∪ `config.root.sessionId`），
   *   而语料取的是 `config.root` ⇒ **门与语料可能指两个不同的周目**（真机就是这个味道）。
   *   ⛔ 也**不许**再拿 `config.root` 兜底判"算不算本局"。
   */
  const sessionHasPlaythrough = (sid) => {
    const now = Date.now()
    const hit = hasPtCache.get(sid)
    if (hit !== undefined && now - hit.at < LAST_FLOORS_CACHE_TTL_MS) return hit.yes
    const yes = sessionPlaythroughOf(sid) !== null
    hasPtCache.set(sid, { yes, at: now })
    if (hasPtCache.size > 64) hasPtCache.delete(hasPtCache.keys().next().value)
    return yes
  }
  /** 归档楼层（走 TTL 缓存；⛔ 只读，绝不写）。 */
  const floorsFor = (dir, source) => {
    const now = Date.now()
    if (cache.source === source && now - cache.at < LAST_FLOORS_CACHE_TTL_MS) return cache.floors
    const floors = echoModules.readArchiveFloors(dir)
    cache.source = source
    cache.floors = floors
    cache.at = now
    return floors
  }
  /**
   * 本会话**当前上下文的字数**（sessionId → 字数）。
   * ⛔ 由 `system-prompt/assemble` 钩子在**本轮装配之前**算好（带预算、绝不拖慢这一轮）；
   * 段 provider 是同步的，只读它；读不到 ⇒ undefined ⇒ 回退到"首轮"判据。
   * ⚠️ 只留最近用过的少量会话，别无界增长。
   */
  const contextCharsCache = new Map()
  const OUR_SECTIONS = [lastFloors.LAST_FLOORS_SECTION_NAME, 'mt:postHistory', 'rp:firstRound']
  /**
   * 本会话是不是「空对话的首轮」（**同步**判据，供段 provider 用）。
   *
   * ★ 真机实测（2026-09-17）：`turnBoundary.lastTurn` 是**当前第几轮**（1 起），
   *   不是"上一次**完成**的轮"。证据：组装捕获里首次装配记的 `turn = 1`，而那个字段
   *   就是 sections-capture 的 `resolveTurn()` 用同一个 `stateOf(…,'turnBoundary')` 填的
   *   （`lib/sections-capture.js:438-450`、`:527`）。第一版我写成 `=== 0` ⇒ 首轮判成 false
   *   ⇒ 一个字都不注（真机 `chars=0` 抓到的）。
   *   ⇒ 用 `<= 1`，**两种语义都成立**（当前轮 1 起 ⇒ 1；已完成轮 0 起 ⇒ 0）。
   *
   * 回退 `agent.phase.turn`（同样是当前轮号）。两个都拿不到 ⇒ null
   * ⇒ **判不出就不注入**（宁可少注一次，也不把历史重复喂进去）。
   */
  const firstTurnOf = (scope, agent) => {
    try {
      const last = scope.sessionProjections?.stateOf?.(agent?.session, 'turnBoundary')?.lastTurn
      if (Number.isFinite(last)) return lastFloors.isFirstTurn(last)
    } catch { /* 服务缺席/代理抛错 ⇒ 走回退 */ }
    try {
      const t = agent?.phase?.turn
      if (Number.isFinite(t)) return lastFloors.isFirstTurn(t)
    } catch { /* 同上 */ }
    return null
  }
  ctx.plugin({
    name: 'dsh-memory-archive:last-floors',
    inject: ['systemPrompt', 'sessionProjections', 'sessionQuery'],
    apply(scope) {
      // ★ 带外算「本会话当前上下文字数」：段 provider **同步**、只能读缓存 ⇒
      //   在 `system-prompt/assemble` 里**先算再 next()**（本轮就是新值），并带预算
      //   （算不出来 ⇒ 本轮缓存里没有 ⇒ 回退"首轮"判据，⛔ 绝不为它拖慢对话）。
      //   两个便宜门先挡掉绝大多数轮次：开关关着 / 不是绑定周目的会话 ⇒ 连算都不算。
      scope.on('system-prompt/assemble', async (assembly, assembleContext, next) => {
        try {
          const sid = assembleContext?.agent?.session?.id
          if (lastFloors.readSwitch(cfgOf()).enabled === true
            && typeof sid === 'string' && sid !== '' && sessionHasPlaythrough(sid)) {
            const n = await echoWithBudget(sessionContextChars(scope, sid), ECHO_PREP_BUDGET_MS)
            if (Number.isFinite(n)) {
              contextCharsCache.delete(sid) // 重新插入 ⇒ 保持"最近用过"在队尾（LRU）
              contextCharsCache.set(sid, n)
              if (contextCharsCache.size > 32) contextCharsCache.delete(contextCharsCache.keys().next().value)
            }
          }
        } catch { /* 算不出来就沉默 —— 缓存里没有 ⇒ 回退判据兜着 */ }
        return next()
      })
      // 段注册：provider **同步**、只返回算好的字符串（官方约束）；返回空串 = 这一段不存在。
      scope.effect(() => scope.systemPrompt.section({
        name: lastFloors.LAST_FLOORS_SECTION_NAME,
        order: lastFloors.LAST_FLOORS_ORDER,
        text: (assembleContext) => {
          try {
            const sw = lastFloors.readSwitch(cfgOf())
            if (sw.enabled !== true) return ''
            const sid = assembleContext?.agent?.session?.id
            if (typeof sid !== 'string' || sid === '') return ''
            if (!sessionHasPlaythrough(sid)) return '' // ★ 周目门：认不出这个会话的周目 ⇒ 一个字不注（当新会话）
            // ★ 触发条件（2026-09-19 用户口径）：**上下文 < 5000 字**才注；字数还没算出来时
            //   回退到旧的"首轮"判据（判不出就不注 —— 宁可少注一次，也不重复喂历史）。
            const contextChars = contextCharsCache.get(sid)
            const isFirstTurn = firstTurnOf(scope, assembleContext?.agent) === true
            if (!lastFloors.contextIsShort({ contextChars, isFirstTurn })) return ''
            // ★★ 语料 = **本会话的**周目（2026-09-20 口径；⛔ 不再是 `config.root` 那个面板绑定）
            const hit = rootFloorsDir(sid)
            if (hit === null) return ''
            const floors = floorsFor(hit.dir, hit.source)
            const text = lastFloors.renderRecentFloors(
              lastFloors.pickRecentFloors(floors, sw.count),
              { maxChars: sw.maxChars },
            )
            const decided = lastFloors.decideInject({ enabled: true, contextChars, isFirstTurn, floors, text })
            return decided.inject ? text : ''
          } catch (e) {
            try { log.warn(`[mt] 最近几楼本轮跳过：${e?.message || e}`) } catch {}
            return ''
          }
        },
      }), 'lastFloors.section()')
      // 越权看守：装配期扫**渲染后**的段表（0 字的段不占位置，故只算非空段），
      // 有**外来**段 order ≥ 10202 ⇒ 明确警告（⛔ 不静默、⛔ 不自动挪）。只警告一次，免得刷屏。
      let warned = false
      // ★ 同样要排到**下游**才看得全：开机即挂会漏掉别人在下游加的段（见 lib/deferred-install.js）。
      const runGuard = async (assembly, assembleContext, next) => {
        try {
          if (!warned) {
            const rendered = (assembly?.sections ?? []).filter((s) => typeof s?.text !== 'string' || s.text !== '')
            const conflicts = lastFloors.findOrderConflicts(rendered, lastFloors.LAST_FLOORS_ORDER, OUR_SECTIONS)
            if (conflicts.length > 0) {
              warned = true
              log.warn(`[mt] ⚠ 有外来段挤到「最近几楼」之后（order ≥ ${lastFloors.LAST_FLOORS_ORDER}）：`
                + `${conflicts.map((c) => `${c.name}@${c.order}`).join('、')}`
                + ' —— 本段的相对位置可能已不再是预期的「倒数第二」')
            }
          }
        } catch { /* 看守失败不影响注入 */ }
        return next()
      }
      let disposeGuard = null
      if (deferredInstall !== null) {
        const d = deferredInstall.makeDeferredAssembleListener({
          // ⚠️ 挂**插件顶层 ctx**（`ctx`），理由同上：子作用域在真机上收不到 `session/event`。
          on: typeof ctx.on === 'function' ? ctx.on.bind(ctx) : null,
          run: runGuard,
          log: scope?.logger,
        })
        disposeGuard = () => { try { d.dispose() } catch {} }
      } else {
        // 工具缺席 ⇒ 退回老行为（开机即挂 = 上游；不如下游全，但不至于看守失效）
        disposeGuard = scope.on('system-prompt/assemble', async (a, b, next) => runGuard(a, b, next))
      }
      scope.effect(() => () => { try { disposeGuard?.() } catch {} }, 'lastFloors.guard-dispose()')
    },
  })
  log.info(`[mt] 最近几楼已接线（段 ${lastFloors.LAST_FLOORS_SECTION_NAME} @${lastFloors.LAST_FLOORS_ORDER}；默认关，开关走 /config 的 lastFloors.enabled）`)
}

// ---------------------------------------------------------------------------
// 压缩后自动收纳（2026-09-15，用户拍板：**轮末触发 / 只收绑定周目 / 默认开 / 失败要播报**）
//
// 机制（三条都踩在既有能力上，⛔ 不新造通路）：
//   · 压缩完成的信号 = 会话日志里的 `compaction/summary` 事件（`session/event` 会送达；
//     回响（echo）挂的就是同一个 hook，沙箱已实测能收到）；
//   · 它只**记下"这个会话这一轮压过"**，真正落库放到该轮 `turn/end` —— 不在装配/压缩路径上抢 IO，
//     且一轮里压多次只收一次；
//   · 落库复用的是 HTTP 端点那份内核（`collect-scan.js` 的 `collectOnce`），所以扫描走的仍是
//     被批准的便宜路径（⛔ 不碰被明令禁止的 `searchEvents` 全量对账）。
//
// ★ 为什么要有"绑定"这道门：**本机任何会话都可能被压缩**（包括你正在跟 AI 干活的编程会话）。
//   只对**本目标的会话**生效 ⇒ 别的会话压了也绝不会写进角色档案。
//   ★★ 判据（2026-09-22 起）= **会话优先**，见 `decideAutoCollect()`：这条会话**自己解析出来的
//   周目**（Tavern 的 catalog.json + 各周目 timeline.json）== 面板绑定的目标周目 ⇒ 放行；
//   认不出周目的会话（新会话 / 编程会话）与属于**另一个**周目的会话**一律拒绝**（宁可漏，也不猜）。
//   ⛔ 旧判据是"会话 id 在不在 catalog 的 `ext.pmpDshTavern.rootSessionId` ∪ `config.root.sessionId`
//   里"—— 那只装**周目第一场会话**，真机事故（2026-09-22）恰恰是**一路「从这里继续」续接出来的
//   会话**被它全部误杀：摘要压出来了，周目里却没归档，下游没东西可入。
//
// ★ 失败要播报：结果（含失败）落 `<storageDir>/auto-collect.json`，面板顶栏会把失败标红、
//   「导入 / 收纳」卡里给一行原文，`GET /auto-collect` 也能读。⛔ 状态里只有计数/路径/code，不含正文。
// ---------------------------------------------------------------------------

function autoCollectStatusPath() {
  return join(storageDir(), 'auto-collect.json')
}

/** 上一次自动收纳的结果；读不到 ⇒ null（⛔ 不编造）。 */
function readAutoCollectStatus() {
  try {
    const doc = JSON.parse(readFileSync(autoCollectStatusPath(), 'utf8'))
    return isPlainObject(doc) ? doc : null
  } catch {
    return null
  }
}

function writeAutoCollectStatus(doc) {
  try {
    writeFileSync(autoCollectStatusPath(), JSON.stringify(doc) + '\n', 'utf8')
  } catch {}
}

/** 会话 id 进状态文件时截短（⛔ 状态文件不该是又一份会话清单）。 */
function shortSessionId(sid) {
  return typeof sid === 'string' && sid.length > 18 ? sid.slice(0, 18) + '…' : String(sid ?? '')
}

/** 从 <rootPath>/catalog.json 取该周目的 rootSessionId（只读本地文件；判据形状与 catalogTarget 同口径）。 */
function boundRootSessionId(characterId, playthroughId) {
  try {
    const wsFile = join(dshHomeDir(), 'pmp-dsh-tavern', 'play-workspace.json')
    const ws = JSON.parse(readFileSync(wsFile, 'utf8'))
    const rootPath = typeof ws?.rootPath === 'string' ? ws.rootPath : ''
    if (rootPath === '') return null
    const cat = JSON.parse(readFileSync(join(rootPath, 'catalog.json'), 'utf8'))
    const list = Array.isArray(cat?.playthroughs) ? cat.playthroughs : []
    for (const p of list) {
      if (!isPlainObject(p)) continue
      const path = typeof p.path === 'string' ? p.path : ''
      const segs = path.split('/').filter(Boolean)
      if (segs.length < 2) continue
      const ext = isPlainObject(p.ext) && isPlainObject(p.ext.pmpDshTavern) ? p.ext.pmpDshTavern : {}
      const pCh = typeof ext.characterId === 'string' && ext.characterId !== '' ? ext.characterId : segs[0]
      const pPt = segs[segs.length - 2]
      if (pCh !== characterId || pPt !== playthroughId) continue
      if (typeof ext.rootSessionId === 'string' && ext.rootSessionId !== '') return ext.rootSessionId
      return null
    }
    return null
  } catch {
    return null
  }
}

/**
 * 自动收纳的**写入目标**（= 面板绑定的那个「角色-周目」）+ 旧的"哪些会话算本局"的会话 id 集合。
 *
 * ⚠️ ★★ 2026-09-22：**放行判据不再看 `ids`** —— 判据搬到 `decideAutoCollect()`（下面那个纯函数）。
 *   理由：这个集合只装 **周目第一场会话**（catalog 的 `rootSessionId` ∪ `config.root.sessionId`），
 *   而用户实际在玩的是**一路「从这里继续」续接出来的会话**（Tavern `timeline.json` 的 head）
 *   ⇒ 永远不在集合里 ⇒ 每次 `not-bound-session` 跳过（真机事故 2026-09-22 的根因）。
 *   `ids` 与 `boundRootSessionId()` 因此在本文件里**已无消费者**；⛔ 本单**不删**（只改那一处判据，
 *   别顺手重构 —— 留着不改变任何行为）。
 *   `target` 的来源与语义**一字未变**（本单不改它：仍由这里给出 = 面板绑定）。
 */
function autoCollectScope() {
  try {
    const { config } = readConfigFile()
    const ch = typeof config.root?.characterId === 'string' ? config.root.characterId : ''
    const pt = typeof config.root?.playthroughId === 'string' ? config.root.playthroughId : ''
    const ids = new Set()
    if (typeof config.root?.sessionId === 'string' && config.root.sessionId !== '') ids.add(config.root.sessionId)
    if (ch !== '' && pt !== '') {
      const rs = boundRootSessionId(ch, pt)
      if (typeof rs === 'string' && rs !== '') ids.add(rs)
    }
    return { ids, target: ch !== '' && pt !== '' ? { characterId: ch, playthroughId: pt } : null }
  } catch {
    return { ids: new Set(), target: null }
  }
}

/**
 * ★★ 2026-09-22「自动收纳该不该放行」的**纯函数判据**（⛔ 纯：只吃两个入参 —— 不读盘、不看会话、
 * 不碰 config）⇒ 台子可以**直测**这条判据本身，而不是去断言源码字符串。
 *
 * 口径 = **会话优先**（与全栈其余部分同一条）：这条会话**自己解析出来的周目**
 * （`sessionPlaythroughOf()`，读 Tavern 的 `catalog.json` + 各周目 `timeline.json`）
 * == 面板绑定的**目标周目**（`autoCollectScope().target`）⇒ 放行。
 *
 * ★ 为什么改（真机事故 2026-09-22）：旧判据是 `autoCollectScope().ids`（`config.root.sessionId`
 *   ∪ catalog 的 `rootSessionId`）—— 那个集合只装**周目第一场会话**，而用户实际在玩的是**一路
 *   「从这里继续」续接出来的会话**（Tavern `timeline.json` 的 head）⇒ 不在集合里 ⇒ 每次
 *   `not-bound-session` 跳过 ⇒ 摘要出了、周目里却没归档 ⇒ 下游没东西可入。
 *   ⛔ 也**不许**把 `ids` 换成"timeline 里所有会话 id"那种写法：那会绕过"会话优先"这条判据，
 *   两套判据迟早会漂。
 *
 * ★ 安全护栏一条不少：认不出周目的会话（新会话 / 编程会话）仍被拒；属于**另一个**周目的会话仍被拒
 *   （后者正是原来 `not-bound-session` 想防的事）。
 *
 * @param {{characterId?:string,playthroughId?:string}|null} target 目标周目（面板绑定）
 * @param {{characterId?:string,playthroughId?:string}|null} hit 本会话解析出的周目（认不出 ⇒ null）
 * @returns {{allow:true}|{allow:false,reason:string}} 拒绝原因**三条分开写** —— 给用户看的话必须
 *          能区分"没设目标" / "这条会话认不出属于哪个周目" / "这条会话属于另一个周目"。
 */
export function decideAutoCollect(target, hit) {
  const tCh = typeof target?.characterId === 'string' ? target.characterId : ''
  const tPt = typeof target?.playthroughId === 'string' ? target.playthroughId : ''
  // ① 没设目标 ⇒ 原样保留旧文案（用户该看到的是"去设置里选一个「角色-周目」"）。
  if (tCh === '' || tPt === '') {
    return { allow: false, reason: 'no-bound-target（设置里没选「角色-周目」）' }
  }
  const hCh = typeof hit?.characterId === 'string' ? hit.characterId : ''
  const hPt = typeof hit?.playthroughId === 'string' ? hit.playthroughId : ''
  // ② 认不出这条会话的周目 ⇒ **新**文案（旧的 `bound-session-unknown` 只说得清 catalog 那一半，
  //    而这里的事实是"这条会话自己解析不出周目"）。
  if (hCh === '' || hPt === '') {
    return {
      allow: false,
      reason: 'session-playthrough-unknown（这条会话认不出属于哪个周目：Tavern 的 catalog.json 与各周目 '
        + 'timeline.json 里都没有它 —— 新会话，或还没被 Tavern 归入周目的会话）',
    }
  }
  // ③ 是**另一个**周目 ⇒ 两条周目 id 都如实带上（用户要能一眼看出"它跑到哪儿去了"）。
  if (hCh !== tCh || hPt !== tPt) {
    return {
      allow: false,
      reason: 'other-playthrough（这条会话属于另一个周目：本会话 = ' + hCh + '/' + hPt
        + '，目标周目 = ' + tCh + '/' + tPt + '）',
    }
  }
  return { allow: true }
}

/**
 * 自动收纳要用的 Tavern 基址。内部触发**没有 req**，所以：
 *   ① 调试/自检开关 `MT_TAVERN_BASE`（只在显式设置时生效，用来把落库指向一台假 Tavern）；
 *   ② 宿主自己的监听端口 —— `webServer.port` 是 host/webserver 的公开 getter（实际监听端口，
 *      见 packages/host/webserver/src/index.ts:149-151）⇒ 自己调自己，天然同源。
 * 都拿不到 ⇒ null（本轮跳过并**播报** NO_SELF_BASE，⛔ 不猜端口）。
 */
function autoCollectBase(ctx, scope) {
  const fromEnv = typeof process.env.MT_TAVERN_BASE === 'string' ? process.env.MT_TAVERN_BASE.trim() : ''
  if (fromEnv !== '') return fromEnv.replace(/\/+$/, '')
  // ⛔ 每一次访问都必须**各自** try：cordis 的 `scope.webServer` 在没注入时是**抛错**的，
  //   而把它和 `ctx.get(...)` 写在同一个 try 里，会连兜底一起跳过 —— 2026-09-15 沙箱相 B
  //   实测就是这么变成 `NO_SELF_BASE` 的（成功路径当时被 MT_TAVERN_BASE 掩盖着，差点带病上线）。
  const portOf = (svc) => {
    try {
      const p = Number(svc && svc.port)
      return Number.isFinite(p) && p > 0 ? p : null
    } catch {
      return null
    }
  }
  let port = null
  try { port = portOf(scope && scope.webServer) } catch {}
  if (port === null) port = portOf(getService(ctx, 'webServer'))
  if (port === null) {
    try { port = portOf(ctx && ctx.webServer) } catch {}
  }
  return port === null ? null : 'http://127.0.0.1:' + port
}

/** 跑一次自动收纳（异步、绝不抛到调用方；成功/失败都落状态文件）。 */
async function runAutoCollect(ctx, scope, sessionId, log) {
  const at = new Date().toISOString()
  const started = Date.now()
  const { target } = autoCollectScope()
  // ★★ 2026-09-22：放行判据 = **会话优先**（这条会话自己解析出的周目 == 目标周目），
  //   ⛔ 不再是"会话 id 在不在 `autoCollectScope().ids` 里"—— 那只装**周目第一场会话**，
  //   一路「从这里继续」续接出来的会话（timeline 的 head）全被它误杀（真机事故）。
  //   判据本身在 `decideAutoCollect()`（纯函数，台子直测）；这里只把两个原料喂进去。
  const gate = decideAutoCollect(target, sessionPlaythroughOf(sessionId))
  if (!gate.allow) {
    // 不是本目标的会话 —— 记一行"跳过"，但**不算失败**（面板不该为这个报红）。
    // 三条原因分开写（文字在 `decideAutoCollect()` 里）：给用户看的文字必须能区分
    // "没设目标" / "认不出这条会话的周目" / "它是另一个周目的"。
    writeAutoCollectStatus({
      at, ok: true, skipped: true, sessionId: shortSessionId(sessionId), target: target, reason: gate.reason,
    })
    return
  }
  const base = autoCollectBase(ctx, scope)
  if (base === null) {
    writeAutoCollectStatus({
      at, ok: false, code: 'NO_SELF_BASE', sessionId: shortSessionId(sessionId), target,
      message: '拿不到宿主自己的监听地址（webServer.port 不可用），本轮没写任何东西。',
    })
    try { log.warn('[mt] 自动收纳跳过：拿不到宿主监听端口（webServer.port）') } catch {}
    return
  }
  try {
    const { collectOnce } = await import('./collect-scan.js')
    // ★★ 2026-09-22：注入**原始事件装载器**（createRawEventLoader = loadSessionLog 包装），
    // ⛔ 不再是 collectSurfaces —— 区间与模型摘要都要带 `data` 的事件（见该助手头注）。
    const out = await collectOnce(scope, { sessionId, target, auto: true, base, loadRawEvents: createRawEventLoader(scope), instruction: currentCompactionInstruction() })
    const r = isPlainObject(out.result) ? out.result : {}
    const written = Array.isArray(r.written) ? r.written.length : 0
    const archived = Number.isFinite(r.archived) ? r.archived : 0
    writeAutoCollectStatus({
      at, ok: true, sessionId: shortSessionId(sessionId), target, base,
      scanned: Number.isFinite(r.scanned) ? r.scanned : 0,
      archived, written,
      skipped: Array.isArray(r.skipped) ? r.skipped.length : 0,
      warnings: Array.isArray(r.warnings) ? r.warnings.slice(0, 5) : [],
      ms: Date.now() - started,
    })
    if (written > 0) {
      try { log.info(`[mt] 自动收纳：收 ${archived} 段 / 写 ${written} 个文件（${Date.now() - started}ms）`) } catch {}
    }
  } catch (e) {
    const code = e && typeof e.code === 'string' ? e.code : 'AUTO_COLLECT_FAILED'
    const message = String((e && e.message) || e).slice(0, 300)
    writeAutoCollectStatus({ at, ok: false, code, message, sessionId: shortSessionId(sessionId), target, base, ms: Date.now() - started })
    try { log.warn(`[mt] 自动收纳失败（已记入面板播报）：${code} ${message}`) } catch {}
  }
}

/**
 * 压缩成功后等多久再收（毫秒）。
 *
 * 为什么要有这个延迟：`compaction/end` 到达时，宿主**刚**把摘要写进会话日志，
 * 而我们的落库要**回读盘上的会话文件** ⇒ 留几秒余量，避免读到半截。
 * 为什么要有这条触发：手动 `/compact` 不产生 `turn/end`（真机实测），
 * 只靠"轮末"的话，压完就关会话的摘要永远进不了库。
 */
const COMPACT_END_COLLECT_DELAY_MS = 5000

/**
 * 接线：压缩成功 → 延迟收一次；该轮末再兜一次。绝不抛（调用方还会再包一层）。
 * @param deps 自检台注入面：`{ runAutoCollect }` 可替换真正的执行器（只想验"什么时候该跑、
 *             跑几次、归属门"，不想真写盘）；生产路径不传。
 */
export function registerAutoCollect(ctx, log, deps = {}) {
  if (!ctx || typeof ctx.plugin !== 'function') {
    log.warn('[mt] ctx.plugin 不可用，自动收纳未接线')
    return
  }
  const runOnce = typeof deps.runAutoCollect === 'function'
    ? deps.runAutoCollect
    : (scope, sid) => runAutoCollect(ctx, scope, sid, log)
  /** ③ 的延迟：自检台可注入一个小值（真等 5 秒会拖慢全量门），生产走常量。 */
  const compactEndDelayMs = Number.isFinite(deps.compactEndDelayMs)
    ? deps.compactEndDelayMs
    : COMPACT_END_COLLECT_DELAY_MS
  ctx.plugin({
    name: 'dsh-memory-archive:auto-collect',
    // ⛔ 只 inject sessionQuery（必需）；webServer 用 ctx.get 兜底取 —— 硬 inject 会让
    //    没有 webServer 的宿主整条子 fiber 不挂载（自动收纳静默失效），那是更坏的降级。
    inject: ['sessionQuery'],
    apply(scope) {
      const pending = new Set()
      /** ③ 用的延迟器：会话 id → timer（同一个会话只留一个，落地时清）。 */
      const timers = new Map()
      const enabled = () => {
        try { return readConfigFile().config.autoCollect?.enabled !== false } catch { return true }
      }
      /** 真正落库那一脚（三处触发共用；异步、不 await：⛔ 绝不阻塞会话轮次）。 */
      const collect = (sid) => {
        pending.delete(sid)
        if (!enabled()) return
        void Promise.resolve(runOnce(scope, sid)).catch(() => {})
      }
      // ① 压缩发生 ⇒ 只记下"这个会话这一轮压过"（真正落库留到轮末 / 压缩结束）。
      scope.on('session/event', (session, event) => {
        try {
          if (event?.type !== 'compaction/summary') return
          if (!enabled()) return
          const sid = session?.id
          if (typeof sid !== 'string' || sid === '') return
          pending.add(sid)
        } catch {}
      })
      // ③ 压缩**成功**（`compaction/end` 没有 error）⇒ 延迟几秒也收一次。
      //    ★ 为什么必须有它（2026-09-20 真机实测）：**手动 `/compact` 不产生 `turn/end`**
      //      —— 日志里那一串是「compaction/summary → user/message → compaction/end → command/done」，
      //      一条 `turn/end` 都没有 ⇒ 只靠 ② 的话，手动压完就关掉会话，这份摘要**永远不进库**。
      //    延迟是留给宿主把摘要写进会话日志的余量（实测同一次里 summary 在 end 之前，
      //    但读的是**盘上的会话文件**，写盘与事件之间不保证同步）。
      //    失败/取消的压缩到不了这里：pending 只在 `compaction/summary` 时置位，那条事件只在成功时出现。
      scope.on('session/event', (session, event) => {
        try {
          if (event?.type !== 'compaction/end') return
          const err = event?.data?.error
          if (typeof err === 'string' && err !== '') return
          const sid = session?.id
          if (typeof sid !== 'string' || sid === '' || !pending.has(sid)) return
          if (timers.has(sid)) return
          const timer = setTimeout(() => {
            timers.delete(sid)
            if (!pending.has(sid)) return
            collect(sid)
          }, compactEndDelayMs)
          // 别让这个定时器把进程按在活着的状态（宿主退出时不必等它）。
          if (typeof timer.unref === 'function') timer.unref()
          timers.set(sid, timer)
        } catch {}
      })
      // ② 轮末 ⇒ 收一次（异步、不 await：⛔ 绝不阻塞会话轮次）。
      scope.on('session/event', (session, event) => {
        try {
          if (event?.type !== 'turn/end') return
          const sid = session?.id
          if (typeof sid !== 'string' || sid === '' || !pending.has(sid)) return
          collect(sid)
        } catch {}
      })
    },
  })
  log.info('[mt] 自动收纳已接线（压缩成功 → 延迟 '
    + COMPACT_END_COLLECT_DELAY_MS + 'ms 收一次；该轮末再兜一次；只收绑定周目的会话；开关 autoCollect.enabled，默认开）')
}

/**
 * 入口：绝不抛错。webServer 走 inject（服务晚到也能挂上）；
 * 旧版宿主没有 ctx.inject 时退化为 ctx.get 即时挂载。
 */
export function apply(ctx) {
  const log = makeLog(ctx)
  try {
    if (!ctx || typeof ctx !== 'object') return
    // skill 必须在 apply() 调用栈内同步注册（effect 挂 fiber 的硬约束，见模块顶层说明）。
    try {
      registerSkills(ctx, log)
    } catch (e) {
      log.error(`[mt] skill 注册失败（已降级）：${e?.stack || e}`)
    }
    // 记忆回响（D2）接线：⛔ **必须在组装捕获之前注册** —— 同一条 `system-prompt/assemble`
    // 瀑布上，监听器按注册顺序跑：回响先把自己的段填好，捕获后跑才看得到它
    // （反了的话：捕获记下 chars=0，而模型其实收到了内容 ⇒ 查看器与事实不符）。
    try {
      registerEcho(ctx, log)
    } catch (e) {
      log.error(`[mt] 记忆回响接线失败（已降级）：${e?.stack || e}`)
    }
    // 「最近几楼」（mt:lastFloors @10202）：与回响同样的理由 —— **必须在组装捕获之前注册**
    // （同一条 `system-prompt/assemble` 瀑布按注册顺序跑；反了的话捕获会记下 chars=0）。
    try {
      registerLastFloors(ctx, log)
      // 剧情笔记写入（memory_write）+ 记忆库路径段（mt:memoryHome @2 —— ★2026-09-19 用户要求挪到 mt:memoryProtocol 之后）—— 20260919 复活 / 新增。
      registerNoteWriteTool(ctx, log)
      registerMemoryHome(ctx, log)
      // ★ 2026-09-23：死区看守（每轮至多一次比对，只告警不还原）。与 memoryHome 段同一份文档读取，
      //   所以接在它后面 —— 同样必须在组装捕获之前注册（同一条 `system-prompt/assemble` 瀑布）。
      registerDeadzoneWatch(ctx, log)
      // ★ 2026-09-23：按楼层绑定的笔记快照 + 回档跟随（轮末记一份；组装时 + 轮末各判一次回档）。
      //   它**不改任何段**（⛔ 不往上下文里塞东西），但同样挂 `system-prompt/assemble` 那一脚，
      //   所以一并注册在组装捕获之前（顺序对它无所谓，对捕获有所谓：捕获要看到的是段的最终样子）。
      registerFloorSnapshot(ctx, log)
      // ★ 2026-09-24：新周目自动挂 RP 预设（收编原先打在第三方 Tavern 上那处补丁）。
      //   ⛔ 不改段、不碰上面那条瀑布，只是顺手挂在同一段里。
      registerRpPresetAttach(ctx, log)
    } catch (e) {
      log.error(`[mt] 最近几楼接线失败（已降级）：${e?.stack || e}`)
    }
    // 压缩后自动收纳：挂 session/event（compaction/summary → 轮末收一次）。与上面的组装瀑布
    // 不是同一条路，注册顺序无所谓；失败只降级，⛔ 绝不拖垮宿主启动。
    try {
      registerAutoCollect(ctx, log)
    } catch (e) {
      log.error(`[mt] 自动收纳接线失败（已降级）：${e?.stack || e}`)
    }
    // B 流组装捕获（编辑器 v2）：registerSectionsCapture(ctx) 内部用 ctx.plugin 挂一条
    // 自带 inject ['systemPrompt','sessionProjections'] 的子 fiber（cordis 为子 fiber
    // 解析依赖 —— B 模块自述：外层插件 inject 不必硬加这两个服务，缺席也不拖垮本插件；
    // 本插件"服务缺失照常 apply"的硬规则优先）。失败只降级，绝不抛。
    try {
      if (sectionsCapture && typeof sectionsCapture.registerSectionsCapture === 'function') {
        const registered = sectionsCapture.registerSectionsCapture(ctx)
        if (registered) log.info('[mt] 组装捕获已注册（system-prompt/assemble 监听 + C5 落盘 + /sections）')
        else log.warn('[mt] 组装捕获未注册（ctx.plugin 不可用或重复注册），/sections 将只有 inferred 降级')
      } else {
        log.warn(`[mt] sections-capture 不可用，组装捕获未注册（${sectionsCaptureLoadError?.message || sectionsCaptureLoadError}）`)
      }
    } catch (e) {
      log.error(`[mt] 组装捕获注册失败（已降级，不影响宿主启动）：${e?.stack || e}`)
    }
    const mount = (scope) => {
      try {
        registerHttpApi(ctx, scope || {}, log)
      } catch (e) {
        log.error(`[mt] HTTP API 注册失败（已降级）：${e?.stack || e}`)
      }
    }
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], mount)
    } else if (typeof ctx.get === 'function') {
      const webServer = ctx.get('webServer')
      if (webServer !== undefined) mount({ webServer })
    }
    // v3 消费端：① 组合器（默认关；软注入 pmpDshTavernPrompt —— 服务出现才注册）
    //            ② 卡字段摆位（上游解出来的段，位置由我们定 —— 见 registerTavernParts）
    // ⛔ 绝不硬 inject 那个服务：2026-09-16 沙箱实测，硬 inject 它的插件在 Tavern 被卸载后
    //   会让整个 Host 起不来（`1 entry did not activate / pending (waiting for service: …)`）。
    try {
      if (v3Composer && typeof v3Composer.registerV3Composer === 'function') {
        const cfgV3 = (readConfigFile().config.v3 ?? {}).composer ?? {}
        const r = v3Composer.registerV3Composer(ctx, cfgV3, log)
        if (r.registered) log.info(`[mt] v3 消费端已接线：owner=${r.owner}（默认关的开关见 config.v3.composer.enabled）`)
        else log.info(`[mt] v3 消费端未启用（${r.reason || 'disabled'}）—— 装配仍归 Tavern 内置策略`)
      } else {
        log.warn(`[mt] v3-composer 不可用，v3 消费端未接线（${v3ComposerLoadError?.message || v3ComposerLoadError}）`)
      }
      // 卡字段摆位（取代了 2026-09-18/19 的「尾段 + 摘除 + 带外缓存」三件套；用户 2026-09-19 拍板删掉 mt:postHistory）
      try {
        tavernPartsHandle = registerTavernParts(ctx, log)
        if (tavernPartsHandle.installed) log.info('[mt] 卡字段摆位已接线（上游解出来的段，位置由我们定）')
        else log.warn(`[mt] 卡字段摆位未接线（${tavernPartsHandle.reason}）—— 上游的段留在它给的位置`)
      } catch (e) {
        const msg = String((e && e.message) || e)
        tavernPartsHandle = { installed: false, reason: 'threw:' + msg, mode: () => 'unavailable', placedTotal: 0, lastPlaced: null, lastSeen: null, lastGuard: null, lastPhi: null }
        log.warn(`[mt] 卡字段摆位接线失败（已降级）：${msg}`)
      }
      // 后处理提示词「作为玩家消息注入」（2026-09-20，用户拍板默认开）：`agent/pre-step` 追一条 user 消息，
      // 落点 = **玩家消息之后**。⛔ 挂在**顶层 ctx**（子作用域在真机上收不到 agent 事件）。
      try {
        if (phiMessage !== null) {
          phiMessageHandle = phiMessage.registerPhiMessage(ctx, {
            getText: (sid) => {
              const hit = phiTextBySession.get(sid)
              return hit && typeof hit.text === 'string' ? hit.text : ''
            },
            isEnabled: () => phiSwitchEnabled(),
            onInjected: (sid) => {
              if (typeof sid !== 'string' || sid === '') return
              phiInjectedSessions.add(sid)
              while (phiInjectedSessions.size > PHI_SESSION_MAX) {
                const oldest = phiInjectedSessions.values().next().value
                if (oldest === undefined) break
                phiInjectedSessions.delete(oldest)
              }
            },
            log,
          })
          if (phiMessageHandle.installed) log.info('[mt] 后处理提示词注入已接线（每轮第 1 步追加在玩家消息之后；开关 config.phiAsMessage.enabled，默认开）')
          else log.warn(`[mt] 后处理提示词注入未接线（${phiMessageHandle.reason}）—— 它仍只出现在 system 末尾`)
        } else {
          log.warn(`[mt] phi-message 模块不可用，后处理提示词注入未接线（${phiMessageLoadError?.message || phiMessageLoadError}）`)
        }
      } catch (e) {
        const msg = String((e && e.message) || e)
        phiMessageHandle = { installed: false, reason: 'threw:' + msg, injected: 0, last: null, lastSkip: null }
        log.warn(`[mt] 后处理提示词注入接线失败（已降级）：${msg}`)
      }
    } catch (e) {
      log.error(`[mt] v3 消费端接线失败（已降级，不影响宿主启动）：${e?.stack || e}`)
    }
  } catch (e) {
    log.error(`[mt] apply 失败（已降级，不影响宿主启动）：${e?.stack || e}`)
  }
}
