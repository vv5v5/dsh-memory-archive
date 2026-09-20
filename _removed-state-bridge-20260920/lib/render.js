/**
 * 状态 → 注入文本。
 *
 * 卡片格式**沿用阶段 1 的产物**（`产物\l1-state\state-card.md`，已与 ST 自渲染交叉验证过：
 * 躯体 55/60｜密氛 15/12 一致），只把"ST 第 N 楼"换成"DSH 第 N 轮"，并新增三节：
 *   · 【⏱ 到期与解除】   —— 代码解除了什么 / 什么在等条件（治"惊厥不会自动解除"的可见化）
 *   · 【✎ 本轮状态变更】 —— 新增/移除了哪些机制条目（治"乱记"的可见化）
 *   · 【📋 本轮依据】     —— 主模型自报的 summary（让"无中生有"可审计）
 *
 * ⚠️ 这个函数必须是**纯同步**的：它会被 `systemPrompt.section()` 的 provider 每轮调用，
 * 而 provider 是同步的（`system-prompt/src/index.ts:590-599`）—— 内部不能 await。
 */
import { NEG_BOOL, KNOWLEDGE, SKILLS, TIMED_MAPS, EXPIRY_KEYS, CONDITION_KEYS, EXPIRY_PHASE_KEYS } from './schema.js'

const str = (v, d = '') => (v === null || v === undefined || v === '' ? d : String(v))

/** 计时条目的值可能是 string（旧）或 object（新）—— 统一渲染成一行可读文本。 */
export function formatTimedValue(v) {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'object') {
    const eff = v.效果 ?? v.修正 ?? ''
    const bits = []
    const due = EXPIRY_KEYS.map(k => v[k]).find(x => x)
    const duePhase = EXPIRY_PHASE_KEYS.map(k => v[k]).find(x => x)
    const cond = CONDITION_KEYS.map(k => v[k]).find(x => x)
    const why = v.依据
    if (due) bits.push(`到期 ${due}${duePhase ? ' ' + duePhase : ''}`)
    if (cond) bits.push(`条件：${cond}`)
    if (why) bits.push(`依据：${why}`)
    return bits.length ? `${eff}（${bits.join('；')}）` : String(eff)
  }
  return String(v)
}

/**
 * 渲染一个自由容器。
 * @param o         容器内容
 * @param container 容器名 —— **必须传**，因为"值是不是计时条目"取决于容器，
 *                  而不是取决于条目名（第一版这里写错了，拿条目名去比对容器名）。
 */
const listOf = (o, container) => {
  const ks = Object.keys(o ?? {})
  if (!ks.length) return '（无）'
  const timed = TIMED_MAPS.includes(container)
  return ks.map(k => {
    const v = o[k]
    if (timed) return `${k}（${formatTimedValue(v)}）`
    return typeof v === 'string' ? `${k}（${v}）` : `${k}（${JSON.stringify(v)}）`
  }).join(' / ')
}

/**
 * 渲染注入文本。
 *
 * @param status  当前状态（**已过 sweepExpired**）
 * @param opts.turn        当前 turn 号
 * @param opts.expired     sweepExpired().expired
 * @param opts.pending     sweepExpired().pending
 * @param opts.unparseable sweepExpired().unparseable
 * @param opts.diff        diffMechanics() 的结果
 * @param opts.summary     主模型自报的本轮依据
 * @param opts.warnings    其它告警（失败、护栏拒收等），逐行追加到 ⚠ 区
 * @param opts.includeSkills true 时附上 20 项技能的能力档位文案（默认 false，阶段 1 卡片也没带）
 * @param opts.usageHint   记账方式提示（可选）。patch-tool 模式由注入层传主模型的调用契约；
 *                         不传则完全不渲染 —— 与阶段 1 卡片逐字节对齐的调用方不受影响
 */
export function renderStateCard(status, opts = {}) {
  const s = status
  if (!s || typeof s !== 'object') return ''

  const L = []
  const 时间 = s.时间 ?? {}, 元 = s.元 ?? {}, 基本 = s.基本 ?? {}, 负面 = s.负面状态 ?? {}
  const 技能 = s.技能 ?? {}, 知识 = s.知识 ?? {}, 血欲期 = s.血欲期 ?? {}

  const 躯体当前 = 基本.躯体?.当前, 躯体上限 = 基本.躯体?.上限
  const 密氛当前 = 基本.密氛?.当前, 密氛下限 = 基本.密氛?.下限, 密氛上限 = 基本.密氛?.上限
  const 恐惧 = typeof 负面.恐惧 === 'number' ? 负面.恐惧 : 0
  const 实际上限 = typeof 密氛上限 === 'number' ? 密氛上限 - 恐惧 : null

  const anchor = opts.turn !== undefined && opts.turn !== null ? `｜DSH 第 ${opts.turn} 轮` : ''
  L.push(`【当前状态】截至 ${str(时间.日期, '?')} ${str(时间.阶段, '?')}${时间.天气 ? `（${时间.天气}）` : ''}${anchor}`)
  L.push('')
  const nm = String(元.姓名 ?? '').trim()
  const race = String(元.种族 ?? '').trim()
  L.push(`身份：${nm ? (race ? `${nm}（${race}）` : nm) : '（未定）'}`)

  if (躯体当前 !== undefined || 密氛当前 !== undefined) {
    const note = 实际上限 !== null ? `，实际上限 ${实际上限}（= ${密氛上限} − 恐惧 ${恐惧}）` : ''
    L.push(`躯体：${躯体当前 ?? '?'}/${躯体上限 ?? '?'}　密氛：${密氛当前 ?? '?'}/${密氛上限 ?? '?'}（下限 ${密氛下限 ?? '?'}${note}）`)
  }

  // 负面状态摘要
  const neg = []
  if (恐惧 > 0) neg.push(`恐惧 ${恐惧}`)
  for (const k of NEG_BOOL) if (负面[k] === true) neg.push(k)
  for (const k of ['临时恐惧', '永久创伤']) {
    if (Array.isArray(负面[k]) && 负面[k].length) neg.push(`${k}[${负面[k].length}]`)
  }
  if (负面.特殊 && Object.keys(负面.特殊).length) neg.push(`特殊{${Object.keys(负面.特殊).length}}`)
  L.push(`负面状态：${neg.length ? neg.join('、') : '（无）'}`)

  if (Object.keys(s.技能修正 ?? {}).length) L.push(`技能修正：${listOf(s.技能修正, '技能修正')}`)
  L.push(`血欲期：${str(血欲期.当前状态, '未至')}${血欲期.下次窗口 ? `（下次 ${血欲期.下次窗口}）` : ''}`)

  // 知识 + 秘史检定修正
  let 等级和 = 0
  const kn = KNOWLEDGE.map(k => {
    const e = 知识[k] ?? { 级: 0, IP: 0 }
    等级和 += e.级 ?? 0
    return `${k} Lv${e.级 ?? 0}(${e.IP ?? 0}IP)`
  })
  L.push(`知识（12）：${kn.join(' · ')}　→ 秘史检定修正 +${等级和}`)
  L.push(`技能（20）：${SKILLS.map(k => `${k}${技能[k] ?? 0}`).join(' ')}`)

  L.push(`物品栏（${Object.keys(s.物品栏 ?? {}).length}）：${listOf(s.物品栏, '物品栏')}`)
  if (Object.keys(s.秘史物品 ?? {}).length) L.push(`秘史物品（${Object.keys(s.秘史物品).length}）：${listOf(s.秘史物品, '秘史物品')}`)
  L.push(`特质（${Object.keys(s.特质 ?? {}).length}）：${listOf(s.特质, '特质')}`)
  if (Object.keys(s.技艺 ?? {}).length) L.push(`技艺（${Object.keys(s.技艺).length}）：${listOf(s.技艺, '技艺')}`)
  if (Object.keys(s.别称 ?? {}).length) L.push(`别称（${Object.keys(s.别称).length}）：${listOf(s.别称, '别称')}`)
  if (Object.keys(s.状态栏 ?? {}).length) L.push(`状态栏（${Object.keys(s.状态栏).length}）：${listOf(s.状态栏, '状态栏')}`)

  // ── ⚠ 生效机制（沿用阶段 1 的推导，措辞照搬）
  const W = []
  if (恐惧 >= 12) W.push(`恐惧 ${恐惧} ≥ 12：**已达精神崩溃阈值** —— 须裁定（永久心理创伤 / 当场惊厥 / 强制退场）`)
  else if (恐惧 >= 5) W.push(`恐惧 ${恐惧} ≥ 5：今晚入梦掷骰承受 1 惩罚骰`)
  if (恐惧 > 0 && 实际上限 !== null) W.push(`恐惧 ${恐惧} 使密氛实际上限降为 ${实际上限}`)
  if (实际上限 !== null && 实际上限 <= 0) W.push(`密氛实际上限 ≤ 0：**与秘史断连**（不再入梦），直至恐惧降至 4 以下`)
  if (typeof 躯体当前 === 'number' && 躯体当前 < 20) W.push(`躯体 ${躯体当前} < 20：入睡时须体质检定，失败随机一项身体技能永久 −1D10`)
  if (typeof 密氛当前 === 'number' && typeof 密氛上限 === 'number' && 密氛当前 > 密氛上限) {
    const over = 密氛当前 - 密氛上限
    W.push(`密氛超上限 ${over} 点：所有判定加 ${Math.min(3, Math.floor(over / 5)) || 1} 个惩罚骰（上限 3 个）`)
  }
  if (负面.疲劳 === true) W.push(`疲劳：专注类技能承受惩罚骰，直至 ≥6 小时完整睡眠`)
  if (负面.惊厥 === true) W.push(`惊厥：1 天内所有技能 −10（已写入 技能修正）`)
  if (负面.饥饿 === true) W.push(`饥饿：所有体力检定惩罚骰；连续两日未进食额外 −1D6 躯体/日`)
  if (负面.重伤未愈 === true) W.push(`重伤未愈：所有身体技能 1 惩罚骰`)
  if (Array.isArray(负面.临时恐惧) && 负面.临时恐惧.length) W.push(`临时恐惧 ${负面.临时恐惧.length} 项：${负面.临时恐惧.join('、')}`)
  if (Array.isArray(负面.永久创伤) && 负面.永久创伤.length) W.push(`永久创伤 ${负面.永久创伤.length} 项：持续影响，需长期治疗或秘史仪式`)
  if (str(血欲期.当前状态).includes('经期')) W.push(`血欲期（经期中）：抑制吸血冲动的意志检定承受 1 惩罚骰`)
  if (typeof 密氛当前 === 'number') {
    const band = 密氛当前 <= 20 ? '日常、灰暗（无额外规则）'
      : 密氛当前 <= 40 ? '奇异符号、扭曲场景'
        : 密氛当前 <= 60 ? '触及秘史边界，混沌梦追加意志检定'
          : 密氛当前 <= 80 ? '可能进入漫宿边缘（入梦意志检定，失败 1D6 恐惧）'
            : '坠入漫宿（必触发意志检定，失败 1D12 恐惧+永久创伤；醒来密氛永久 +1D4）'
    W.push(`密氛 ${密氛当前} → 梦境基调：${band}`)
  }
  for (const w of opts.warnings ?? []) W.push(w)

  L.push('')
  L.push('【⚠ 本轮生效机制】')
  L.push(W.length ? W.map(x => '- ' + x).join('\n') : '- （无特殊机制）')

  // ── ⏱ 到期与解除（代码拥有的那部分，必须让 KP 看见）
  const expired = opts.expired ?? []
  const pending = opts.pending ?? []
  const unparseable = opts.unparseable ?? []
  if (expired.length || pending.length || unparseable.length) {
    L.push('')
    L.push('【⏱ 到期与解除】')
    for (const e of expired) L.push(`- ✔ 已自动解除：${e.container}.${e.key}（${e.reason}）—— 本轮起不再生效`)
    for (const p of pending) L.push(`- ⏳ 待确认解除：${p.container}.${p.key}（条件：${p.condition}）—— 需叙事确认条件满足后方可移除`)
    for (const u of unparseable) L.push(`- ⚠ 时限条目缺可读到期日：${u.container}.${u.key} —— 下一轮记账时请补成 { 效果, 到期 } 结构`)
  }

  // ── ✎ 本轮变更可见化（治「乱记」：多记一条立刻看得见）
  const diff = opts.diff
  if (diff && (diff.added?.length || diff.removed?.length)) {
    L.push('')
    L.push('【✎ 本轮状态变更】')
    if (diff.added?.length) L.push(`- 新增：${diff.added.join('、')}`)
    if (diff.removed?.length) L.push(`- 移除：${diff.removed.join('、')}`)
    if (opts.summary) L.push(`- 主模型自述依据：${opts.summary}`)
  }

  // ── 🛠 记账方式（仅 patch-tool 模式传入；提醒主模型每轮在思维链里提交 state_patch）
  if (opts.usageHint) {
    L.push('')
    L.push(`【🛠 记账方式】${String(opts.usageHint)}`)
  }

  return L.join('\n')
}

/** 估算 token（中文字符 ≈ 0.42 token 的经验值，仅供预算参考）。 */
export const estimateTokens = (text) => Math.round(String(text ?? '').length / 2.6)
