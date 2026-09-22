/**
 * compaction-threshold —— 「自动压缩触发阈值」的**纯逻辑**（宿主半侧 + 自检台共用）。
 *
 * ## 它解决什么
 * 面板让玩家以 **DSH 自带的那个上下文百分比**为单位，选「到多少 % 自动压缩」；改完要
 * ①正在玩的这一场下一轮就生效（`mt-compaction-rp.js` 每轮现读 `config.json`）、
 * ②同时写进**部署的预设 YAML** 的 `thresholdRatio`，让新周目也吃到同一个数。
 * 这个模块装的是那两件事里**能拿纯函数测**的部分（本项目 house style：逻辑进模块、台子直测）。
 *
 * ## 四件纯函数（自检台逐条钉）
 *   · `contextOccupancy` / `percentOf` —— 官方占用率公式（逐字同款，见下）；
 *   · `clampThresholdPercent`       —— 5–90 步长 5，越界夹紧**并如实回报夹了**；
 *   · `clampRetainRatio`            —— 保证 `retainRatio < thresholdRatio` **恒成立**；
 *   · `patchThresholdRatio`         —— 只改一行 `thresholdRatio:`，**出现次数 ≠ 1 必拒**。
 *
 * ## ★ 两处"必须与别人一致"的东西（都有自检台钉漂移）
 * ① **百分比公式**：与 DSH 官方客户端 `ui-conversation/src/client/context-occupancy.ts:21` 逐字同款。
 *    宿主投影单元 `contextPressure` 给的字段是 `{ contextWindow?, pressureTokens?, surfaceTokens,
 *    sampledSurfaceTokens?, claim? }` —— ⚠️ **没有 `projectedTokens`**（那是"线上视图"才算的），
 *    所以照官方同一条公式自己算：
 *      projectedTokens = max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens)
 *      usedTokens      = projectedTokens ?? pressureTokens
 *      percent         = min(100, round(usedTokens / contextWindow * 100))
 *    ⛔ 差一个字段就如实 null，绝不用别的字段顶上。
 * ② **预设定位**：`<DSH_HOME>/.agent-presets/<id>/agent.cordis.yml`，与本插件其它地方
 *    （`lib/index.js` 的 `agentPresetsRootDir()`）同一套推导 —— 本模块只**收根目录**，
 *    不在自己这里再造一份 DSH_HOME 解析。
 *
 * ## 为什么不碰官方包
 * ⛔ 客户端不许自己算百分比、不许直连官方内部接口；宿主侧也只读**公开的两个服务**
 * （`sessionProjections` 的 `contextPressure` 投影、`tokenMeter.measure`）——
 * 那两个与官方引擎算的是**不同的分子**（见 `contextOccupancy` 与 `triggerOccupancy` 的注释）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 面板阈值的合法区间与步长（任务口径：5–90 的整数、步长 5）。 */
export const AUTO_COMPACT_MIN_PERCENT = 5
export const AUTO_COMPACT_MAX_PERCENT = 90
export const AUTO_COMPACT_STEP_PERCENT = 5
/** 默认值 = 15%（与预设 YAML 里 `thresholdRatio: 0.15` 同一个数 ⇒ 装上就是原来那个行为）。 */
export const AUTO_COMPACT_DEFAULT_PERCENT = 15

/**
 * `retainRatio` 的兜底与上限（任务口径 §3.2-3）：
 *   · 预设 YAML 没给 `retainRatio` ⇒ 用 0.05（对原 `retainTokens: 8000` 的**行为近似**，
 *     在 160k 窗口下 0.05×160k = 8000 **恰好等价**；窗口更小则保留得更少）；
 *   · 上限 = `thresholdRatio × 0.7` ⇒ `retainRatio < thresholdRatio` **恒成立**，
 *     玩家把阈值调到 5% 也不会撞官方的 `retainRatio must be less than thresholdRatio`。
 */
export const RETAIN_RATIO_DEFAULT = 0.05
export const RETAIN_RATIO_CAP_OF_THRESHOLD = 0.7

/** 部署的预设里，挂我们压缩后端的那一行（用它认"这份预设是不是吃面板阈值的"）。 */
export const PRESET_BACKEND_MARKER = 'mt-compaction-rp.js'
export const PRESET_ASSEMBLY_FILE = 'agent.cordis.yml'
/** 部署预设的目录名（`<DSH_HOME>/.agent-presets`）—— 与官方 slug 一致。 */
export const PRESET_DIR_NAME = '.agent-presets'

/** 夹紧/归一后给一句人话（null = 没动过，原样收下）。 */
function ratioText(value) {
  return Number(Number(value).toFixed(4)).toString()
}

/**
 * 把任意输入收成「5–90 的整数、步长 5」，并**如实回报动没动过**。
 *
 * 口径（照本项目 sanitize 的既有风格）：⛔ 不抛。越界夹到最近边界，非法（非数字/NaN）
 * 回落默认值 15 —— 但**每一条都写进 `reason`**，调用方要能把这句话显示给用户。
 *
 * @param {unknown} value - 盘上/请求体里的原始值。
 * @returns {{percent: number, clamped: boolean, reason: string|null}} 收下后的整数 + 是否被夹过 + 人话原因。
 */
export function clampThresholdPercent(value) {
  const raw = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN)
  if (!Number.isFinite(raw)) {
    return {
      percent: AUTO_COMPACT_DEFAULT_PERCENT,
      clamped: true,
      reason: `阈值不是数字（${JSON.stringify(value)}），已回落默认 ${AUTO_COMPACT_DEFAULT_PERCENT}%`,
    }
  }
  // 步长 5：先取整、再对齐到最近的 5 的倍数（round，不是 floor —— 20.1 该归 20、22.5 归 25）
  const aligned = Math.round(raw / AUTO_COMPACT_STEP_PERCENT) * AUTO_COMPACT_STEP_PERCENT
  const percent = Math.min(AUTO_COMPACT_MAX_PERCENT, Math.max(AUTO_COMPACT_MIN_PERCENT, aligned))
  if (percent === raw) return { percent, clamped: false, reason: null }
  return {
    percent,
    clamped: true,
    reason: `${raw}% 不在 ${AUTO_COMPACT_MIN_PERCENT}–${AUTO_COMPACT_MAX_PERCENT}% 的 ${AUTO_COMPACT_STEP_PERCENT}% 步长上，已夹到 ${percent}%`,
  }
}

/**
 * 读取处夹紧保留比例：`retainRatio = min(给定值, thresholdRatio × 0.7)`。
 *
 * 为什么必须有它：官方 `resolveConfig` 的不变量是 **`retainRatio` 必须严格小于
 * `thresholdRatio`**（实测报错原文：`retainRatio (0.05) must be less than the resolved
 * thresholdRatio (0.05)`），玩家把面板阈值调到 5% 就一定会踩到。夹紧后 `retainRatio`
 * 恒 `< thresholdRatio`（给定值更小就听给定值，否则封在 0.7×阈值），且**与窗口无关**。
 *
 * @param {unknown} retainRatio - 预设 YAML 里的 `retainRatio`（缺失/非法 ⇒ 用 0.05）。
 * @param {unknown} thresholdRatio - 本次生效的 `thresholdRatio`。
 * @returns {number|null} 收下后的比例；`thresholdRatio` 本身不合法（≤0/非有限）⇒ null（判不出来就不猜）。
 */
export function clampRetainRatio(retainRatio, thresholdRatio) {
  const t = typeof thresholdRatio === 'number' ? thresholdRatio : Number(thresholdRatio)
  if (!Number.isFinite(t) || t <= 0) return null
  const raw = typeof retainRatio === 'number' ? retainRatio : Number(retainRatio)
  const want = Number.isFinite(raw) && raw > 0 ? raw : RETAIN_RATIO_DEFAULT
  // 四舍五入到 6 位：只为去掉浮点尾巴（0.05 × 0.7 = 0.034999999999999996 这种），
  // ⛔ 不影响"严格小于"—— 0.7×t 与 t 之间至少差 0.3t（面板最小 5% ⇒ 差 0.015）。
  const out = Math.round(Math.min(want, t * RETAIN_RATIO_CAP_OF_THRESHOLD) * 1e6) / 1e6
  return out > 0 && out < t ? out : null
}

/** 一个"数"是不是真数（投影字段可能是 null / undefined / 字符串 —— 一律不认）。 */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 官方占用率（**DSH 面板上那个百分比**）—— 逐字照官方客户端的公式与 `??` 顺序。
 *
 * ⚠️ 分子**不含输出 token**（是 prompt 侧压力）；真正被拿去比阈值的是另一个数
 * （`triggerOccupancy` 那条），面板必须两个都显示。
 *
 * @param {object} state - `contextPressure` 投影的状态（缺字段一律如实 null，⛔ 不顶替）。
 * @returns {{percent: number|null, usedTokens: number|null, formula: 'projected'|'pressure'|null, reason: string|null}}
 */
export function contextOccupancy(state) {
  const s = state !== null && typeof state === 'object' ? state : {}
  const window = num(s.contextWindow)
  const pressure = num(s.pressureTokens)
  const surface = num(s.surfaceTokens)
  const sampled = num(s.sampledSurfaceTokens)
  if (window === null || window <= 0) {
    return { percent: null, usedTokens: null, formula: null, reason: '投影里没有 contextWindow，算不出百分比' }
  }
  // 「两个都齐才算得出来」：surfaceTokens 与 sampledSurfaceTokens 必须都是数（0 也算数）
  const projected = surface !== null && sampled !== null ? Math.max(0, (pressure ?? 0) + surface - sampled) : null
  const used = projected ?? pressure
  if (used === null) {
    return { percent: null, usedTokens: null, formula: null, reason: '投影里既没有 pressureTokens，也凑不齐 surfaceTokens/sampledSurfaceTokens' }
  }
  return {
    percent: Math.max(0, Math.min(100, Math.round((used / window) * 100))),
    usedTokens: used,
    formula: projected === null ? 'pressure' : 'projected',
    reason: null,
  }
}

/** 只取百分比（官方那一个）—— 算不出来就是 null，⛔ 不拿 0 冒充。 */
export function percentOf(state) {
  return contextOccupancy(state).percent
}

/**
 * 「真正被拿去比阈值的那个数」的占比 = `tokenMeter.measure(session).totalTokens / contextWindow`。
 *
 * ⚠️ 与 `contextOccupancy` **不是同一个分子**：`totalTokens` 含输出 token（usageTokens），
 * 还可能退化成启发式估算；`contextOccupancy` 那条不含。所以面板两个都显示，不许只给一个
 * 让人以为是同一个数（任务书 §1.2 的硬要求）。
 *
 * @param {unknown} measured - `TokenMeter.measure(session)` 的返回（取 `.totalTokens`）。
 * @param {unknown} contextWindow - 窗口大小（与百分比那条**同一个来源**）。
 * @returns {{percent: number|null, totalTokens: number|null, reason: string|null}}
 */
export function triggerOccupancy(measured, contextWindow) {
  const m = measured !== null && typeof measured === 'object' ? measured : {}
  const total = num(m.totalTokens)
  const window = num(contextWindow)
  if (total === null) return { percent: null, totalTokens: null, reason: 'tokenMeter.measure 没给出 totalTokens' }
  if (window === null || window <= 0) return { percent: null, totalTokens: total, reason: '没有 contextWindow，算不出触发判定占比' }
  return {
    percent: Math.max(0, Math.min(100, Math.round((total / window) * 100))),
    totalTokens: total,
    reason: null,
  }
}

/** 从一行 YAML 里认出 `thresholdRatio:`（允许缩进、允许行尾注释、允许引号）。 */
const THRESHOLD_KEY_RE = /^([ \t]*)thresholdRatio([ \t]*):([ \t]*)(.*)$/

/** 剥掉值里可能带的引号与行尾注释，返回 { token, tail }（tail = 数值之后原样保留的那截）。 */
function splitValue(rest) {
  let i = 0
  while (i < rest.length && (rest[i] === ' ' || rest[i] === '\t')) i++
  const lead = rest.slice(0, i)
  const body = rest.slice(i)
  const quote = body[0] === '"' || body[0] === "'" ? body[0] : ''
  let end = 0
  if (quote !== '') {
    const close = body.indexOf(quote, 1)
    end = close < 0 ? body.length : close + 1
  } else {
    const m = /^[^\s#]+/.exec(body)
    end = m ? m[0].length : 0
  }
  const token = quote !== '' ? body.slice(1, end - 1) : body.slice(0, end)
  return { lead, token, tail: body.slice(end) }
}

/**
 * 数出一份 YAML 里 `thresholdRatio:` 的出现处，并解析每一处的原值。
 *
 * 「先数出现次数」是写盘那条路的**硬要求**（⛔ 绝不猜着替换）：0 处 = 这份预设不吃阈值、
 * 多处 = 我们不知道改哪一处 ⇒ 两条都必须**拒绝改**并如实回报。
 *
 * @param {unknown} yamlText - 预设 `agent.cordis.yml` 的全文。
 * @returns {{count: number, lines: number[], values: Array<number|null>, valueOk: boolean, reason: string|null}}
 */
export function scanThresholdRatio(yamlText) {
  if (typeof yamlText !== 'string' || yamlText === '') {
    return { count: 0, lines: [], values: [], valueOk: false, reason: '预设文本为空（读不到或不是文件）' }
  }
  const rows = yamlText.split(/\r?\n/)
  const lines = []
  const values = []
  let valueOk = true
  for (let i = 0; i < rows.length; i++) {
    const m = THRESHOLD_KEY_RE.exec(rows[i])
    if (m === null) continue
    if (m[4].trim() === '' || m[4].trim() === '|' || m[4].trim() === '>') continue // `thresholdRatio:` 后面没值 = 不是我们要的那一行
    lines.push(i)
    const token = splitValue(m[4]).token
    const n = token === '' ? NaN : Number(token)
    if (Number.isFinite(n)) values.push(n)
    else {
      values.push(null)
      valueOk = false
    }
  }
  const reason = lines.length === 0
    ? '这份预设里没有 `thresholdRatio:`'
    : (valueOk ? null : '`thresholdRatio:` 的原值不是数字 —— 不猜着替换')
  return { count: lines.length, lines, values, valueOk, reason }
}

/**
 * 读一份 YAML 的 `thresholdRatio`（只读，给端点 `presetThresholdRatio` 用）。
 * @returns {{ok: boolean, ratio: number|null, count: number, reason: string|null}}
 */
export function readThresholdRatio(yamlText) {
  const scan = scanThresholdRatio(yamlText)
  if (scan.count !== 1 || !scan.valueOk) return { ok: false, ratio: null, count: scan.count, reason: scan.reason }
  return { ok: true, ratio: scan.values[0], count: 1, reason: null }
}

/**
 * 点改 `thresholdRatio` —— **保注释的定点替换**（照 `lib/rp-agent.js` 的既有纪律）。
 *
 * 五条纪律（每条都有反证在自检台里）：
 *   ① **先数出现次数**：≠1 ⇒ 拒绝改（`ok:false`），原因写清楚是 0 处还是多处；
 *   ② 原值必须是**数字**：不是数字（含 `thresholdRatio:` 后面接了块标量）⇒ 拒绝改 —— ⛔ 不猜；
 *   ③ 只改那一行的值，**行尾注释与缩进原样保留**；
 *   ④ 返回**新文本**（不落盘 —— 落盘/备份/回读校验在 `writeThresholdRatio` 里做）；
 *   ⑤ `before`/`after` 如实回报（值没变就 `changed:false`）。
 *
 * @param {string} yamlText - 原文。
 * @param {number} ratio - 目标 `thresholdRatio`（= 面板百分比 / 100）。
 * @returns {{ok: boolean, changed: boolean, text: string|null, count: number, before: number|null, after: number|null, reason: string|null}}
 */
export function patchThresholdRatio(yamlText, ratio) {
  const scan = scanThresholdRatio(yamlText)
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
    return { ok: false, changed: false, text: null, count: scan.count, before: null, after: null, reason: `目标 thresholdRatio (${JSON.stringify(ratio)}) 不是 0–1 之间的数` }
  }
  if (scan.count === 0) {
    return { ok: false, changed: false, text: null, count: 0, before: null, after: null, reason: '这份预设里没有 `thresholdRatio:` —— ⛔ 不新增，请先确认挂的是哪一个压缩后端' }
  }
  if (scan.count > 1) {
    return { ok: false, changed: false, text: null, count: scan.count, before: null, after: null, reason: `这份预设里 \`thresholdRatio:\` 出现了 ${scan.count} 次（第 ${scan.lines.map((n) => n + 1).join('、')} 行）—— 不知道改哪一处，拒绝改` }
  }
  if (!scan.valueOk) {
    return { ok: false, changed: false, text: null, count: 1, before: null, after: null, reason: '`thresholdRatio:` 的原值不是数字 —— 不猜着替换（请手改）' }
  }
  const before = scan.values[0]
  const next = ratioText(ratio)
  const rows = yamlText.split(/\r?\n/)
  const line = rows[scan.lines[0]]
  const m = THRESHOLD_KEY_RE.exec(line)
  const { tail } = splitValue(m[4])
  rows[scan.lines[0]] = `${m[1]}thresholdRatio${m[2]}:${m[3]}${next}${tail}`
  const text = rows.join(yamlText.includes('\r\n') ? '\r\n' : '\n')
  return { ok: true, changed: before !== Number(next), text, count: 1, before, after: Number(next), reason: null }
}

/**
 * 找出**部署的预设**里挂了我们压缩后端的那几份（`<presetRoot>/<id>/agent.cordis.yml` 含
 * `mt-compaction-rp.js`）。
 *
 * 为什么不写死预设 id：预设目录名是玩家自己起的（`install.mjs --id=`），本插件也不是预设的
 * 所有者 ⇒ 按**内容**认（谁挂了我们那份后端，谁才吃面板阈值）。⛔ 只读，不建目录。
 *
 * @param {string} presetRoot - `<DSH_HOME>/.agent-presets`（由调用方解析，本模块不猜）。
 * @returns {{ok: boolean, items: Array<{id: string, path: string, text: string}>, reason: string|null}}
 */
export function findBackendPresets(presetRoot) {
  let ids = []
  try {
    ids = readdirSync(presetRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch (error) {
    return { ok: false, items: [], reason: `预设根目录读不到（${error?.code || error?.message || error}）：${presetRoot}` }
  }
  const items = []
  const unreadable = []
  for (const id of ids) {
    const path = join(presetRoot, id, PRESET_ASSEMBLY_FILE)
    if (!existsSync(path)) continue
    let text = null
    try {
      text = readFileSync(path, 'utf8')
    } catch (error) {
      unreadable.push(`${id}（${error?.code || error?.message || error}）`)
      continue
    }
    if (text.includes(PRESET_BACKEND_MARKER)) items.push({ id, path, text })
  }
  items.sort((a, b) => a.id.localeCompare(b.id))
  return {
    ok: true,
    items,
    reason: unreadable.length > 0 ? `有预设读不到：${unreadable.join('、')}` : null,
  }
}

/**
 * 读**部署的预设**里那份 `thresholdRatio`（端点 `presetThresholdRatio` 的唯一来源）。
 *
 * 候选恰好 1 份 ⇒ 读它；0 份/多份 ⇒ 如实 null + 人话原因（⛔ 不从"我们仓库里那份"顶上去，
 * 因为**生效的是部署的那份**）。
 *
 * @param {string} presetRoot - `<DSH_HOME>/.agent-presets`。
 * @returns {{ok: boolean, ratio: number|null, count: number, path: string|null, presetId: string|null, candidates: number, reason: string|null}}
 */
export function readDeployedThresholdRatio(presetRoot) {
  const found = findBackendPresets(presetRoot)
  if (!found.ok) {
    return { ok: false, ratio: null, count: 0, path: null, presetId: null, candidates: 0, reason: found.reason }
  }
  if (found.items.length === 0) {
    return {
      ok: false, ratio: null, count: 0, path: null, presetId: null, candidates: 0,
      reason: `部署的预设里没有挂 ${PRESET_BACKEND_MARKER} 的那一份（${presetRoot}）—— 读不到预设阈值`,
    }
  }
  if (found.items.length > 1) {
    return {
      ok: false, ratio: null, count: 0, path: null, presetId: null, candidates: found.items.length,
      reason: `有 ${found.items.length} 份预设都挂着 ${PRESET_BACKEND_MARKER}（${found.items.map((x) => x.id).join('、')}）—— 不知道哪一份在用，不猜`,
    }
  }
  const item = found.items[0]
  const read = readThresholdRatio(item.text)
  return {
    ok: read.ok,
    ratio: read.ratio,
    count: read.count,
    path: item.path,
    presetId: item.id,
    candidates: 1,
    reason: read.reason,
  }
}

/**
 * 把面板百分比**写进部署的预设 YAML**：数出现次数 → 备份 → 定点替换 → **回读校验**。
 *
 * 硬要求（任务书 §3.1-3）逐条落在这里：
 *   · 出现次数 ≠ 1 ⇒ **拒绝改**并如实回报（⛔ 绝不猜着替换）；
 *   · 改前备份成 `<文件>.bak-<时间戳>`（⛔ 不静默覆盖）；
 *   · **写后回读校验** —— 读回来再剖一次，对不上 ⇒ 如实报错**并保留备份**。
 *
 * @param {{presetRoot: string, ratio: number, stamp?: string}} options - 预设根、目标比例、备份时间戳（注入以便自检可复现）。
 * @returns {{ok: boolean, changed: boolean, path: string|null, backupPath: string|null, presetId: string|null, before: number|null, after: number|null, reason: string|null}}
 */
export function writeDeployedThresholdRatio(options) {
  const presetRoot = options && options.presetRoot
  const ratio = options && options.ratio
  const stamp = options && typeof options.stamp === 'string' && options.stamp !== ''
    ? options.stamp
    : new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const miss = (reason, extra) => Object.assign(
    { ok: false, changed: false, path: null, backupPath: null, presetId: null, before: null, after: null, reason },
    extra ?? {},
  )
  if (typeof presetRoot !== 'string' || presetRoot === '') return miss('没有预设根目录（宿主里拿不到 .agent-presets 的位置）')
  const found = findBackendPresets(presetRoot)
  if (!found.ok) return miss(found.reason)
  if (found.items.length === 0) {
    return miss(`部署的预设里没有挂 ${PRESET_BACKEND_MARKER} 的那一份（${presetRoot}）—— ⛔ 不新建、不猜路径`)
  }
  if (found.items.length > 1) {
    return miss(`有 ${found.items.length} 份预设都挂着 ${PRESET_BACKEND_MARKER}（${found.items.map((x) => x.id).join('、')}）—— 不知道改哪一份，拒绝改`)
  }
  const item = found.items[0]
  const patched = patchThresholdRatio(item.text, ratio)
  const base = { path: item.path, presetId: item.id, before: patched.before, after: patched.after }
  if (!patched.ok) return miss(patched.reason, base)
  if (!patched.changed) {
    return Object.assign({ ok: true, changed: false, backupPath: null, reason: null }, base)
  }
  const backupPath = `${item.path}.bak-${stamp}`
  try {
    mkdirSync(presetRoot, { recursive: true })
    copyFileSync(item.path, backupPath)
    writeFileSync(item.path, patched.text, 'utf8')
  } catch (error) {
    return miss(`写预设失败（${error?.code || error?.message || error}）—— 备份 ${backupPath} 保留在原地`, Object.assign({ backupPath }, base))
  }
  // ★ 回读校验：读回盘上那一份、再按同一套解析剖一次；对不上 ⇒ 如实报错并**保留备份**
  let reread = null
  try {
    reread = readThresholdRatio(readFileSync(item.path, 'utf8'))
  } catch (error) {
    return miss(`写后回读失败（${error?.code || error?.message || error}）—— 备份 ${backupPath} 保留在原地`, Object.assign({ backupPath }, base))
  }
  if (!reread.ok || reread.ratio !== patched.after) {
    return miss(
      `写后回读校验不一致（盘上读到 ${reread.ratio === null ? 'null' : reread.ratio}，期望 ${patched.after}）—— 备份 ${backupPath} 保留在原地`,
      Object.assign({ backupPath }, base),
    )
  }
  return Object.assign({ ok: true, changed: true, backupPath, reason: null }, base)
}

/**
 * 面板要显示的**如实说明**（三条：生效时机 / 估算与"略早" / 溢出旁路；异常态再各追加一条）。
 *
 * 措辞纪律（用户 2026-09-21 定稿，逐字）：触发阈值是**估算**的（含输出 token 的那个数也参与计算）
 * ⇒ 实际会比设置值**略早**；另外上下文超限会**无视阈值**强制压。⛔ 不许写成"等价"。
 *
 * @param {{thresholdPercent: number, usePanelThreshold: boolean, presetRatio: number|null, readError: string|null}} ctx - 当前生效的口径。
 * @returns {string[]} 每行一句，客户端直接显示。
 */
export function compactionNotes(ctx) {
  const c = ctx !== null && typeof ctx === 'object' ? ctx : {}
  const notes = []
  notes.push('改完之后立刻生效。')
  notes.push('触发阈值是估算的，因为输出token也参与计算，因此触发会略早于设置值。')
  notes.push('另外如果上下文超限，会无视阈值强制压缩。')
  if (c.usePanelThreshold === false) {
    notes.push('当前**没有**用面板阈值 ⇒ 走预设 YAML 里的原值（面板上那个数只是记着，不生效）。')
  }
  if (c.presetRatio === null || c.presetRatio === undefined) {
    notes.push('预设阈值读不到（部署的预设里没找到那一行 / 有多份候选）—— 新周目吃什么数无法确认。')
  }
  if (typeof c.readError === 'string' && c.readError !== '') {
    notes.push('实时读数没拿到：' + c.readError)
  }
  return notes
}
