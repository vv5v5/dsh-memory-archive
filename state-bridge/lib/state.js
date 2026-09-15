/**
 * 状态结构与合并。
 *
 * `emptyStatus` / `mergeMap` / `mergeStatus` 是 `状态系统v1.js:101-193` 的**忠实移植**
 * —— GLM 的通读分析（`产物\glm\answers\…状态系统v1.js….md` §6）判定这三者
 * 是"只依赖纯 JS、与新宿主无关"的易移植层。逐行对照过，注释里标了原行号。
 *
 * 本轮新增的三样东西（都服务于用户的实际痛点）：
 *   ① `guardNewMechanics` —— 单轮新增机制条目配额，超限**整轮拒收**（治"乱记/无中生有"）
 *   ② 计时条目的**结构化到期**在 `expiry.js` 里清扫（治"惊厥不会自动解除"）
 *   ③ `diffMechanics` —— 算出本轮新增/移除了哪些机制条目，供注入文本做**可见化**
 *
 * ⚠️ 保真原则：凡是 ST 已有语义的地方，**行为必须一致**，否则阶段 1 的产物和
 * ST 侧现役数据会漂移。新增的只有 `errs` 之外的 `guard` 与 `diff` 字段，不改旧语义。
 */
import {
  SKILLS, KNOWLEDGE, NEG_BOOL, NEG_ARRAYS, NEG_ARRAY_CAP, FREE_MAPS, ROOT_KEYS, IP_THRESHOLDS,
} from './schema.js'

const clone = (o) => JSON.parse(JSON.stringify(o ?? null))

/** 数值兜底。照搬 `状态系统v1.js:135` —— ⚠️ 类型不符时**静默返回旧值**。 */
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// ─────────────────────────────────────── emptyStatus（:101-120）

/** 空骨架。键顺序即渲染顺序。 */
export function emptyStatus() {
  const skills = {}
  for (const s of SKILLS) skills[s] = 0
  const knowledge = {}
  for (const k of KNOWLEDGE) knowledge[k] = { 级: 0, IP: 0 }
  return {
    元: { 锚点: null, 更新于: '' },
    时间: { 日期: '', 阶段: '', 天气: '' },
    基本: { 躯体: { 当前: 60, 上限: 60 }, 密氛: { 当前: 5, 下限: 0, 上限: 50 } },
    负面状态: {
      恐惧: 0, 疲劳: false, 惊厥: false, 饥饿: false, 重伤未愈: false,
      临时恐惧: [], 永久创伤: [], 特殊: {},
    },
    技能: skills,
    技能修正: {},
    知识: knowledge,
    技艺: {},
    物品栏: {},
    秘史物品: {},
    特质: {},
    别称: {},
    血欲期: { 当前状态: '', 下次窗口: '' },
    状态栏: {},
  }
}

/**
 * 补齐缺失的根键**与嵌套子键**（旧数据可能没有后加的键），不改已有值。
 *
 * 为什么必须递归：ST 现役数据里 `时间` 可能只有 `日期`，`基本.密氛` 可能没有 `下限`
 * （`下限` 是后加的字段，`:154-155` 专门为它做了兜底）。只补根键会让渲染层到处判 undefined。
 */
export function normalizeStatus(s) {
  const base = emptyStatus()
  const out = isPlainObject(s) ? clone(s) : clone(base)

  for (const k of ROOT_KEYS) if (!(k in out)) out[k] = clone(base[k])

  // 元：只补骨架里有的两个元信息键（姓名/种族"缺失"是有意义的，表示剧情未给出）
  if (!isPlainObject(out.元)) out.元 = clone(base.元)
  for (const k of ['锚点', '更新于']) if (!(k in out.元)) out.元[k] = base.元[k]

  // 时间
  if (!isPlainObject(out.时间)) out.时间 = clone(base.时间)
  for (const k of ['日期', '阶段', '天气']) if (typeof out.时间[k] !== 'string') out.时间[k] = base.时间[k]

  // 基本（含后加的 密氛.下限）
  if (!isPlainObject(out.基本)) out.基本 = clone(base.基本)
  for (const grp of ['躯体', '密氛']) {
    if (!isPlainObject(out.基本[grp])) out.基本[grp] = clone(base.基本[grp])
    for (const [k, v] of Object.entries(base.基本[grp])) {
      if (typeof out.基本[grp][k] !== 'number') out.基本[grp][k] = v
    }
  }

  // 负面状态
  if (!isPlainObject(out.负面状态)) out.负面状态 = clone(base.负面状态)
  if (typeof out.负面状态.恐惧 !== 'number') out.负面状态.恐惧 = 0
  for (const k of NEG_BOOL) if (typeof out.负面状态[k] !== 'boolean') out.负面状态[k] = false
  for (const k of NEG_ARRAYS) if (!Array.isArray(out.负面状态[k])) out.负面状态[k] = []
  if (!isPlainObject(out.负面状态.特殊)) out.负面状态.特殊 = {}

  // 血欲期
  if (!isPlainObject(out.血欲期)) out.血欲期 = clone(base.血欲期)
  for (const k of ['当前状态', '下次窗口']) if (typeof out.血欲期[k] !== 'string') out.血欲期[k] = ''

  // 自由容器：只保证是对象
  for (const k of FREE_MAPS) if (!isPlainObject(out[k])) out[k] = {}

  // 技能 / 知识白名单
  if (!isPlainObject(out.技能)) out.技能 = {}
  for (const k of SKILLS) if (typeof out.技能[k] !== 'number') out.技能[k] = 0
  if (!isPlainObject(out.知识)) out.知识 = {}
  for (const k of KNOWLEDGE) {
    if (!isPlainObject(out.知识[k])) out.知识[k] = { 级: 0, IP: 0 }
    if (typeof out.知识[k].级 !== 'number') out.知识[k].级 = 0
    if (typeof out.知识[k].IP !== 'number') out.知识[k].IP = 0
  }

  return out
}

// ─────────────────────────────────────── mergeMap（:125-131）

/**
 * 自由容器的**键级合并**：null = 删键；缺键 = 保留现值；有值 = 写入。
 * 非对象 / 数组的 src 直接忽略（照搬 `:126-127`）。
 */
export function mergeMap(dst, src) {
  if (src === null || src === undefined) return dst
  if (typeof src !== 'object' || Array.isArray(src)) return dst
  const o = { ...(dst || {}) }
  for (const [k, v] of Object.entries(src)) { if (v === null) delete o[k]; else o[k] = v }
  return o
}

// ─────────────────────────────────────── 配额护栏（本轮新增）

/**
 * 数出**本轮新增的机制类条目**。
 *
 * 为什么需要：用户报「角色可能吓了一跳，他记了角色收到了临时恐惧」。
 * 提示词里其实写了准入规则（状态栏"纯情绪/心理描写若无机制效果禁止入内"），
 * 但那是**判断题**，模型判不准。所以加一道**代码侧配额**：超过阈值就整轮拒收 + 留痕，
 * 而不是静默接受。阈值触发的是**人工复核**，不是判定对错。
 *
 * 注意：这**不是**要卡死合理变更 —— 一轮里同时"中恐惧 + 受伤 + 获得物品"是可能的。
 * 默认 2，可配；0 或负数 = 关闭该护栏。
 */
export function countNewMechanics(cur, parsed) {
  const out = { 状态栏: [], 技能修正: [], 临时恐惧: [] }
  for (const key of ['状态栏', '技能修正']) {
    const before = cur?.[key] ?? {}
    const patch = parsed?.[key]
    if (!isPlainObject(patch)) continue
    for (const [k, v] of Object.entries(patch)) {
      // null = 删除，不算新增；已存在的键 = 修改，不算新增
      if (v !== null && !(k in before)) out[key].push(k)
    }
  }
  const beforeFear = Array.isArray(cur?.负面状态?.临时恐惧) ? cur.负面状态.临时恐惧 : []
  const patchFear = parsed?.负面状态?.临时恐惧
  if (Array.isArray(patchFear)) {
    // 补丁是"整数组替换"语义（照搬 :162），所以只把**不在旧数组里**的算新增
    for (const x of patchFear) if (!beforeFear.includes(x)) out.临时恐惧.push(String(x))
  }
  const total = out.状态栏.length + out.技能修正.length + out.临时恐惧.length
  return { ...out, total }
}

// ─────────────────────────────────────── 可见化（本轮新增）

/** 列出某容器新增/移除的键名，供注入文本做"本轮变更可见化"。 */
export function diffMechanics(cur, next) {
  const added = [], removed = []
  for (const key of ['状态栏', '技能修正', '特质', '秘史物品']) {
    const a = cur?.[key] ?? {}, b = next?.[key] ?? {}
    for (const k of Object.keys(b)) if (!(k in a)) added.push(`${key}.${k}`)
    for (const k of Object.keys(a)) if (!(k in b)) removed.push(`${key}.${k}`)
  }
  const fa = new Set(cur?.负面状态?.临时恐惧 ?? [])
  const fb = new Set(next?.负面状态?.临时恐惧 ?? [])
  for (const x of fb) if (!fa.has(x)) added.push(`临时恐惧.${x}`)
  for (const x of fa) if (!fb.has(x)) removed.push(`临时恐惧.${x}`)
  return { added, removed }
}

// ─────────────────────────────────────── mergeStatus（:132-193）

/**
 * 白名单 schema 校验合并。
 *
 * @param cur     当前状态（会被深拷贝，不改原对象）
 * @param parsed  副模型产出的**增量补丁**（未提及的键保留现值）
 * @param opts.allowIpDrop            允许知识 IP 下降（仅手动编辑器用；副 API 链路强制只增不减）
 * @param opts.maxNewMechanicsPerTurn 单轮新增机制条目上限；>0 时超限整轮拒收
 * @returns {{ status, errs, guard, rejected }}
 *   - `status`   合并后的状态（被拒时 = cur 原样）
 *   - `errs`     被自动纠正的约束违规（照搬 ST 的 `errs`，是"失败可见化"的抓手）
 *   - `guard`    配额护栏的观测结果（无论是否拒收都给，便于留痕）
 *   - `rejected` true = 本轮被护栏拒收，未写入任何变更
 */
export function mergeStatus(cur, parsed, opts = {}) {
  const out = normalizeStatus(cur)
  const errs = []
  const guard = { limit: opts.maxNewMechanicsPerTurn ?? 0, ...countNewMechanics(cur, parsed), rejected: false }

  // ★ 护栏：超限则整轮拒收（保留旧状态），符合 F2 的 quarantine 语义（隔离本轮，不阻塞前台）
  if (guard.limit > 0 && guard.total > guard.limit) {
    guard.rejected = true
    return { status: out, errs, guard, rejected: true }
  }

  if (!isPlainObject(parsed)) return { status: out, errs, guard, rejected: false }

  // 元身份（开放版：副 API 可从剧情回填姓名/种族；空值视为"剧情未给出"不覆盖）
  if (isPlainObject(parsed.元)) {
    out.元 = out.元 || {}
    if (typeof parsed.元.姓名 === 'string' && parsed.元.姓名.trim()) out.元.姓名 = parsed.元.姓名.trim()
    if (typeof parsed.元.种族 === 'string' && parsed.元.种族.trim()) out.元.种族 = parsed.元.种族.trim()
  }

  // 时间
  if (isPlainObject(parsed.时间)) {
    for (const k of ['日期', '阶段', '天气']) if (typeof parsed.时间[k] === 'string') out.时间[k] = parsed.时间[k]
  }

  // 基本
  if (isPlainObject(parsed.基本)) {
    for (const key of ['躯体', '密氛']) {
      const src = parsed.基本[key], dst = out.基本[key]
      if (isPlainObject(src)) {
        dst.当前 = num(src.当前, dst.当前)
        dst.上限 = num(src.上限, dst.上限)
      }
    }
  }
  // 密氛下限：合并后兜底为数值（旧数据无此字段视为 0），然后**当前不得低于下限**（必须在当前值合并之后）
  const mi = out.基本.密氛
  mi.下限 = Math.max(0, num(parsed.基本?.密氛?.下限, mi.下限 ?? 0))
  if (mi.当前 < mi.下限) mi.当前 = mi.下限

  // 负面状态
  const neg = parsed.负面状态
  if (isPlainObject(neg)) {
    for (const k of NEG_BOOL) if (typeof neg[k] === 'boolean') out.负面状态[k] = neg[k]
    out.负面状态.恐惧 = Math.max(0, num(neg.恐惧, out.负面状态.恐惧))
    for (const k of NEG_ARRAYS) {
      if (Array.isArray(neg[k])) out.负面状态[k] = neg[k].map(String).slice(0, NEG_ARRAY_CAP)
    }
    if (isPlainObject(neg.特殊)) out.负面状态.特殊 = mergeMap(out.负面状态.特殊, neg.特殊)
  }

  // 技能（白名单数值，钳 0..99）
  if (isPlainObject(parsed.技能)) {
    for (const k of SKILLS) {
      const v = num(parsed.技能[k], undefined)
      if (v !== undefined) out.技能[k] = Math.max(0, Math.min(99, v))
    }
  }

  // 自由键值对象（键级合并）
  for (const k of FREE_MAPS) out[k] = mergeMap(out[k], parsed[k])

  // 知识（12 门白名单，级 0-5，IP≥0；副 API 链路强制 IP 只增不减）
  if (isPlainObject(parsed.知识)) {
    for (const k of KNOWLEDGE) {
      const v = parsed.知识[k]
      if (isPlainObject(v)) {
        const oldIp = out.知识[k].IP
        let newIp = Math.max(0, num(v.IP, oldIp))
        if (!opts.allowIpDrop && newIp < oldIp) {
          newIp = oldIp
          errs.push(`知识.${k}.IP 被扣减，已保留原值`)
        }
        out.知识[k] = { 级: Math.max(0, Math.min(5, num(v.级, out.知识[k].级))), IP: newIp }
      }
    }
  }

  // 血欲期
  if (isPlainObject(parsed.血欲期)) {
    for (const k of ['当前状态', '下次窗口']) if (typeof parsed.血欲期[k] === 'string') out.血欲期[k] = parsed.血欲期[k]
  }

  return { status: out, errs, guard, rejected: false }
}

// ─────────────────────────────────────── 代码侧的公式护栏（本轮新增）

/**
 * 用**代码**重算那些能从别的字段推出来的值，而不是指望模型算对。
 *
 * 目前只做两条**无歧义**的：
 *   - 知识 `级` 由 `IP` 按阈值表推出（`schema.js:IP_THRESHOLDS`）—— 消除"级/IP 不符"
 *   - `密氛.当前` 不得低于 `下限`
 * 躯体上限那类含"修正"来源的公式**不做**（修正项无法从状态里推），只做**异常检测**并报 errs。
 *
 * @returns {{ status, fixes, warnings }}
 */
export function enforceDerivedValues(status) {
  const out = normalizeStatus(status)
  const fixes = [], warnings = []

  for (const k of KNOWLEDGE) {
    const ent = out.知识[k]
    const want = IP_THRESHOLDS.filter(t => ent.IP >= t).length - 1
    if (want >= 0 && ent.级 !== want) {
      fixes.push(`知识.${k}: IP ${ent.IP} → 级 ${ent.级} 修正为 Lv${want}`)
      ent.级 = want
    }
  }

  const mi = out.基本.密氛
  if (mi.当前 < mi.下限) {
    fixes.push(`密氛.当前 ${mi.当前} < 下限 ${mi.下限}，已抬到下限`)
    mi.当前 = mi.下限
  }

  // 异常检测（只报不改）：躯体上限变化但体质/力量没动，说明要么有"上限修正"来源、要么算错了
  const 体质 = out.技能.体质, 力量 = out.技能.力量
  const 推导 = Math.floor((体质 + 力量) / 2)
  const 修正 = out.基本.躯体.上限 - 推导
  if (修正 !== 0) warnings.push(`躯体上限 ${out.基本.躯体.上限} = (体质${体质}+力量${力量})/2 + 修正${修正}`)

  return { status: out, fixes, warnings }
}

export { num, clone, isPlainObject }
