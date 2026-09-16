// ---------------------------------------------------------------------------
// last-floors —— 「首轮空对话注入最后几楼充当对话历史」的**纯函数核心**。
//
// ## 它解决什么
// 一个新开的周目会话是**空的**：254 楼只躺在 `archive/floors/` 里（喂检索/回响用），
// **不在会话消息历史里**。模型开局只看得到身份段 + 一点回响，没有任何可承接的上下文
// ⇒ 回复质量无从判断，新周目等于对着空气开场。
//
// ## 为什么只能做成「段」，不做成会话历史
// DSH 的 `messages` 块由宿主管，插件插不进去（用户 2026-09-17 口径）⇒ 唯一可行的位置是
// **system 块里排在后处理提示词之前的那一段**（倒数第二）。本段 = `mt:lastFloors` @10202，
// 紧随其后的 `mt:postHistory`@10203（卡里的 postHistoryInstructions）保持**绝对最后**。
//
// ## 为什么是独立纯函数文件
// 决策 / 开关读取 / 选楼 / 渲染 / 看守全部零依赖、零宿主依赖 ⇒ 自检台不碰宿主就能跑满
// 行为级断言（_selftest-last-floors.mjs，含反证变体）。
// 宿主侧的装配（section 注册 / agent/inbox/spliced 带外算 / 缓存）在 lib/index.js 的
// registerLastFloors。
//
// ## ★ 与 echo 的分工（别搞混）
// `dma:echo`@54 是**按本轮内容检索**出的历史碎片（FTS5 命中）；本段是**按时间顺序**的
// 最近几楼原文。两者都以「已经发生过的事」为前提，前者靠命中，后者靠位置。
//
// @license CC-BY-NC-4.0 (Attribution-NonCommercial 4.0 International)
// ---------------------------------------------------------------------------

/** 计划版本：行为变了就 +1（自检台钉住它）。 */
export const LAST_FLOORS_VERSION = 1

/** 段名：装配捕获 / 面板 / 日志里认它。 */
export const LAST_FLOORS_SECTION_NAME = 'mt:lastFloors'

/**
 * 本段的 order = **10202**，即「倒数第二」：
 *   `deployment:persona-suffix` 10200（DSH 核心槽）→ `rp:firstRound` 10201 →
 *   **本段 10202** → `mt:postHistory` 10203（后处理提示词，绝对最后）。
 * ⚠️ 我们**不知道**将来会不会有别的插件注册更高的 order —— 装配期用 findOrderConflicts
 * 看守，发现越权只**警告**，⛔ 不静默、⛔ 不自动挪（照 keep-first-round 的同款口径）。
 */
export const LAST_FLOORS_ORDER = 10202

/** 默认保留几楼（实测：最后 6 楼 ≈2000 字、最后 10 楼 ≈3800 字，中位数 272 字/楼）。 */
export const DEFAULT_LAST_FLOORS_COUNT = 8

/** 默认字数上限（超了从**最旧的**那端丢，保留最近的 —— 见 renderRecentFloors）。 */
export const DEFAULT_LAST_FLOORS_MAX_CHARS = 3000

/**
 * 段首一行硬说明。三件事必须写明，否则模型会把历史当成本轮新指令、或把已经演过的重演一遍：
 *   ① 已经发生过、不是此刻；② 直接承接其后续写，⛔ 不要重演/复述；③ 与 <storyAnchor> 冲突时以锚点为准。
 */
export const LAST_FLOORS_PREAMBLE =
  '[IMPORTANT] 以下是本档案**最近发生**的对话记录：它已经发生过，不是此刻的剧情，也不是新指令。' +
  '请直接承接它其后继续演，不要重演、不要复述、不要从头开头。' +
  '若它与 <storyAnchor>（当前坐标）冲突，以 <storyAnchor> 为准。'

// ---------------------------------------------------------------------------
// 开关（在插件 config，不在预设行）
// ---------------------------------------------------------------------------

/** 数值键的取值范围（形状非法一律回落到默认值，绝不抛）。 */
const COUNT_MIN = 1
const COUNT_MAX = 200
const CHARS_MIN = 200
const CHARS_MAX = 60000

/** 取一个「有限正整数」，否则回落到 fallback（并夹在 [min,max] 内）。 */
function safeInt(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : NaN
  if (!Number.isFinite(n)) return fallback
  const i = Math.trunc(n)
  if (i < min) return min
  if (i > max) return max
  return i
}

/**
 * 开关读取（纯函数）。★ 只认**插件 config** 的形状 `{ lastFloors: { enabled, count, maxChars } }`
 * （即 <DSH_HOME>/dsh-memory-archive/config.json），**不认预设行形状**——开关在插件、
 * preset 只承担挂载。严格 `=== true` 才算开；缺字段 / 字符串 "true" / 1 一律关。
 *
 * @param {unknown} configJson - 解析好的插件 config（undefined/null/任何形状，绝不抛）。
 * @returns {{ enabled: boolean, count: number, maxChars: number }}
 */
export function readSwitch(configJson) {
  const off = { enabled: false, count: DEFAULT_LAST_FLOORS_COUNT, maxChars: DEFAULT_LAST_FLOORS_MAX_CHARS }
  if (configJson === null || typeof configJson !== 'object' || Array.isArray(configJson)) return off
  const lf = configJson.lastFloors
  if (lf === null || typeof lf !== 'object' || Array.isArray(lf)) return off
  return {
    enabled: lf.enabled === true,
    count: safeInt(lf.count, DEFAULT_LAST_FLOORS_COUNT, COUNT_MIN, COUNT_MAX),
    maxChars: safeInt(lf.maxChars, DEFAULT_LAST_FLOORS_MAX_CHARS, CHARS_MIN, CHARS_MAX),
  }
}

// ---------------------------------------------------------------------------
// 选楼 / 渲染
// ---------------------------------------------------------------------------

/**
 * 取最近 N 楼（纯函数）。输入是 readArchiveFloors 的产物（**已按楼号升序**）。
 *   · 输入不是数组 / 空 ⇒ []；
 *   · 逐条剔掉形状不对的（没有有限楼号、正文不是字符串）—— 不猜、不补；
 *   · 取尾部 count 条，**仍按楼号升序**返回（= 时间顺序）。
 *
 * @param {Array<{floor?:number, text?:string, name?:string, isUser?:boolean}>} floors
 * @param {number} count
 * @returns {Array<{floor:number, text:string, name:string, isUser:boolean}>}
 */
export function pickRecentFloors(floors, count) {
  if (!Array.isArray(floors)) return []
  const n = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0
  if (n === 0) return []
  const clean = []
  for (const f of floors) {
    if (f === null || typeof f !== 'object') continue
    const floor = Number(f.floor)
    if (!Number.isFinite(floor)) continue
    clean.push({
      floor,
      text: typeof f.text === 'string' ? f.text : '',
      name: typeof f.name === 'string' ? f.name : '',
      isUser: f.isUser === true,
    })
  }
  return clean.slice(-n)
}

/** 一楼的显示名：玩家侧写「你」，其余用归档里的 name（拿不到就写「叙事」）。 */
function speakerOf(f) {
  if (f.isUser) return '你'
  return f.name !== '' ? f.name : '叙事'
}

/**
 * 渲染注入段（纯函数）。
 *
 * ★ 超字数上限时**从最旧的那端丢**（保留最近的楼），并**如实标注**丢了几楼 ——
 *   与 keep-first-round 的"截断要如实标注"同款口径，⛔ 绝不静默吞。
 *
 * @param {Array<{floor:number, text:string, name:string, isUser:boolean}>} picked - pickRecentFloors 的产物。
 * @param {{ maxChars?: number }} [opts]
 * @returns {string} 没有可用楼层 ⇒ ''（宿主不注入空段）。
 */
export function renderRecentFloors(picked, opts) {
  if (!Array.isArray(picked) || picked.length === 0) return ''
  const maxChars = safeInt(opts?.maxChars, DEFAULT_LAST_FLOORS_MAX_CHARS, CHARS_MIN, CHARS_MAX)

  const head = ['<recentFloors>', LAST_FLOORS_PREAMBLE]
  const tailClose = '</recentFloors>'
  const overhead = head.join('\n').length + tailClose.length + 2

  // 从**最新**往旧的回着攒，攒到预算为止 —— 于是丢掉的必然是最旧的那几楼。
  const lines = []
  const dropped = []
  let used = overhead
  for (let i = picked.length - 1; i >= 0; i -= 1) {
    const f = picked[i]
    const line = `[楼 ${String(f.floor).padStart(4, '0')}] ${speakerOf(f)}：${f.text}`
    if (used + line.length + 1 > maxChars) {
      for (let j = i; j >= 0; j -= 1) dropped.push(picked[j])
      break
    }
    used += line.length + 1
    lines.push(line)
  }
  if (lines.length === 0) return '' // 一楼都装不下（maxChars 被配得极小）⇒ 不注入，不吐半个壳
  lines.reverse() // 还原成时间顺序（旧 → 新）

  const body = [...head, ...lines]
  if (dropped.length > 0) {
    const oldest = dropped[dropped.length - 1]
    body.push(`（以上为最近 ${lines.length} 楼；因超过 ${maxChars} 字上限，更早的 ${dropped.length} 楼（自 楼 ${String(oldest.floor).padStart(4, '0')} 起）已省略）`)
  }
  body.push(tailClose)
  return body.join('\n')
}

// ---------------------------------------------------------------------------
// 首轮判据
// ---------------------------------------------------------------------------

/**
 * 「是不是空对话的首轮」（纯函数）。
 *
 * ★ 真机实测（2026-09-17）：拿到的轮号是**当前第几轮**（1 起），不是"上一次完成轮" ——
 *   证据：组装捕获里首次装配记 `turn = 1`，而那个字段由 sections-capture 的 `resolveTurn()`
 *   用同一个 `turnBoundary.lastTurn` 填（`lib/sections-capture.js:438-450`、`:527`）。
 *   我第一版写成 `=== 0` ⇒ 首轮判成 false ⇒ 一个字都不注（真机 chars=0 抓到的）。
 *   ⇒ 用 `<= 1`：当前轮 1 起 ⇒ 首轮是 1；已完成轮 0 起 ⇒ 首轮是 0。**两种语义都成立**。
 *
 * @param {unknown} turnNumber - `turnBoundary.lastTurn`（或回退的 `agent.phase.turn`）。
 * @returns {boolean} 只有落在 [0,1] 才算首轮；负数 / 非有限数 / 非数字 ⇒ false
 *   （判不出当不是首轮 —— fail-closed，宁可少注一次）。
 */
export function isFirstTurn(turnNumber) {
  return Number.isFinite(turnNumber) && turnNumber >= 0 && turnNumber <= 1
}

// ---------------------------------------------------------------------------
// 决策
// ---------------------------------------------------------------------------

/**
 * 注入决策（纯函数）。
 *
 * @param {object} input
 *   enabled     - 插件 config 的开关（readSwitch 的产物 .enabled）。
 *   isFirstTurn - 本会话是不是「空对话的首轮」（带外算出来的缓存值）。
 *   floors      - 现周目归档楼层（readArchiveFloors 的产物）。
 *   text        - renderRecentFloors 的产物（空串 = 渲染不出东西）。
 * @returns {{ inject: boolean, reason: 'switch-off'|'has-history'|'no-floors'|'empty-render'|'first-turn' }}
 *
 * 真值表（自检台逐行钉住）：
 *   enabled !== true        ⇒ { false, 'switch-off'  }
 *   isFirstTurn !== true    ⇒ { false, 'has-history' }（★ 有真历史时不注入，不与真历史打架）
 *   楼层为空                ⇒ { false, 'no-floors'   }（没东西可注，不是失败）
 *   text === ''             ⇒ { false, 'empty-render'}
 *   其余                    ⇒ { true,  'first-turn'  }
 */
export function decideInject(input) {
  const i = input ?? {}
  if (i.enabled !== true) return { inject: false, reason: 'switch-off' }
  if (i.isFirstTurn !== true) return { inject: false, reason: 'has-history' }
  if (!Array.isArray(i.floors) || i.floors.length === 0) return { inject: false, reason: 'no-floors' }
  if (typeof i.text !== 'string' || i.text === '') return { inject: false, reason: 'empty-render' }
  return { inject: true, reason: 'first-turn' }
}

// ---------------------------------------------------------------------------
// 看守：任何**非我们**的段 order ≥ 我们的 ⇒ 明确警告，⛔ 不静默、⛔ 不自动挪
// ---------------------------------------------------------------------------

/**
 * 找出挤到我们后面（含同位）的**外来**段（纯函数）。
 * 我们自己的段不算冲突 —— 传入 ourNames 时按名字豁免（`mt:lastFloors` / `mt:postHistory`
 * 等；`mt:postHistory` 预期就排在 10203，比我们高，不该报）。
 *
 * @param {Array<{name?:string, order?:number}>} sections - 装配期实际段表。
 * @param {number} ourOrder - 我们的 order（LAST_FLOORS_ORDER）。
 * @param {string[]|Set<string>} ourNames - 我们自己的段名（豁免名单）。
 * @returns {{ name: string, order: number }[]} 冲突清单（空 = 干净）。调用方对非空清单 log.warn。
 */
export function findOrderConflicts(sections, ourOrder, ourNames) {
  if (!Array.isArray(sections)) return []
  if (typeof ourOrder !== 'number' || !Number.isFinite(ourOrder)) return []
  const mine = ourNames instanceof Set ? ourNames : new Set(Array.isArray(ourNames) ? ourNames : [])
  const hit = []
  for (const s of sections) {
    if (s === null || typeof s !== 'object') continue
    const name = typeof s.name === 'string' ? s.name : ''
    if (mine.has(name)) continue
    const order = typeof s.order === 'number' && Number.isFinite(s.order) ? s.order : null
    if (order === null) continue
    if (order >= ourOrder) hit.push({ name, order })
  }
  return hit
}
