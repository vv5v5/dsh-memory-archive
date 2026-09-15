/**
 * ★ 代码拥有「到期解除」。
 *
 * ## 为什么需要这个模块
 *
 * 用户原话：**「状态解除经常出问题，惊厥是持续一天，不会自动解除。」**
 *
 * 根因在 ST 现役实现里看得很清楚 —— 期限只存在于**散文**中，解除只有一句"求模型记得删"：
 *
 * ```js
 * // 状态系统v1.js:36   键结构：期限藏在字符串里
 * 状态栏:   { 状态名: "机制效果 + 解除/持续条件" }
 * 技能修正: { 技能名: "修正内容（来源+期限）" }
 * // :623  注入时的"提示" —— 这不是机制，是请求
 * if (until && s.时间.日期 > until) w.push('惊厥-10%已到期：应移除技能修正中的惊厥条目并清除惊厥解除记录')
 * ```
 *
 * 模型记不住 → 惊厥永远不解除。**这不是提示词能修的，是架构问题：到期必须是代码的职责。**
 *
 * ## 本模块做三件事
 *
 * 1. `sweepExpired(status, {today, phase})` —— 到期的条目**由代码删除**，返回解除了什么
 * 2. 连带解除：`负面状态.惊厥` 这类**布尔位**与 `特殊['惊厥解除']` 这类标记一起清掉
 * 3. `pendingConditions` —— **条件解除**类（"直至 6 小时完整睡眠"）代码判不了，
 *    但**每轮都会列进 `⚠` 区**，不让它沉底（这是对"不会自动解除"的兜底：至少要看得见）
 *
 * ⚠️ 兼容性：ST 现役数据的值是**字符串**（`"全技能-10（期限1天）"`），没有机器可读的到期日期。
 * 这类**扫不掉**，只能进 `unparseable` 被暴露出来 —— 未来轮次会写成结构化形式。
 * 所以本模块是**渐进迁移**的，不是一次切换。
 */
import { TIMED_MAPS, EXPIRY_KEYS, EXPIRY_PHASE_KEYS, CONDITION_KEYS, TIME_PHASES } from './schema.js'

/** `YYYY/MM/DD`、`YYYY-MM-DD`、`YYYY.MM.DD` → 可比较的 `YYYY/MM/DD`；认不出返回 null。 */
export function normalizeDate(v) {
  if (typeof v !== 'string') return null
  const m = v.match(/(\d{4})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{1,2})/)
  if (!m) return null
  const [, y, mo, d] = m
  const p = (s) => String(Number(s)).padStart(2, '0')
  const mm = Number(mo), dd = Number(d)
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null
  return `${y}/${p(mo)}/${p(dd)}`
}

const phaseIndex = (p) => {
  const i = TIME_PHASES.indexOf(p)
  return i < 0 ? -1 : i
}

const firstKey = (obj, keys) => {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return { key: k, value: obj[k] }
  return null
}

/**
 * 从一个计时条目里抽出机器可读信息。
 * 支持两种形态：
 *   · 新：`{ 效果: "全技能-10%", 到期: "1966/09/03", 依据: "..." }`
 *   · 旧：`"全技能-10%（来源：惊厥；期限1天）"` —— 尽力从文本里找日期
 *
 * @returns {{ expiry: string|null, expiryPhase: string|null, condition: string|null,
 *             shape: 'object'|'string', sawTimeHint: boolean }}
 */
export function readExpiry(entry) {
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const e = firstKey(entry, EXPIRY_KEYS)
    const p = firstKey(entry, EXPIRY_PHASE_KEYS)
    const c = firstKey(entry, CONDITION_KEYS)
    return {
      expiry: e ? normalizeDate(String(e.value)) : null,
      expiryPhase: p ? String(p.value) : null,
      condition: c ? String(c.value) : null,
      shape: 'object',
      sawTimeHint: Boolean(e || p || c),
    }
  }
  if (typeof entry !== 'string') {
    return { expiry: null, expiryPhase: null, condition: null, shape: 'other', sawTimeHint: false }
  }
  // 旧字符串形态：尽力找日期，并识别"条件解除"措辞
  const date = normalizeDate(entry)
  const cond = /直至|直到|直到.*为止|解除条件|睡[眠醒]|恢复后|痊愈|治疗/.test(entry) ? entry.trim() : null
  const timeHint = /期限|持续|到期|\d+\s*天|今日|次日夜|一天/.test(entry)
  return { expiry: date, expiryPhase: null, condition: cond, shape: 'string', sawTimeHint: timeHint || Boolean(date) }
}

/** 侧写：某个计时条目被解除时，状态里还有哪些**关联标记**要一起清。 */
const LINKED = [
  { hint: '惊厥', flag: '惊厥', markers: ['惊厥解除'] },
]

function clearLinked(status, hint, expiredLog, reason) {
  for (const link of LINKED) {
    if (!hint.includes(link.hint)) continue
    if (status.负面状态?.[link.flag] === true) {
      status.负面状态[link.flag] = false
      expiredLog.push({ container: '负面状态', key: link.flag, reason: `${reason}（连带布尔位）` })
    }
    for (const mk of link.markers) {
      if (status.负面状态?.特殊 && mk in status.负面状态.特殊) {
        delete status.负面状态.特殊[mk]
        expiredLog.push({ container: '负面状态.特殊', key: mk, reason: `${reason}（连带标记）` })
      }
    }
  }
}

/**
 * 清扫到期条目。
 *
 * @param status 当前状态（**原地修改** —— 调用方自行决定是否先深拷贝）
 * @param opts.today  "YYYY/MM/DD"，当前剧情日期（缺省则只做"无到期信息"的暴露，不删任何东西）
 * @param opts.phase  当前阶段（"白昼-上午" / "白昼-下午" / "夜晚"），用于同日内的更细判定
 * @returns {{ expired: Array, pending: Array, unparseable: Array }}
 *   - `expired`     已由**代码**删除的条目（含连带清理），要写审计 + 在注入里通知 KP
 *   - `pending`     有"条件解除"措辞的条目 —— 代码判不了，每轮列出供 KP 确认
 *   - `unparseable` 看起来有时限、但没有机器可读到期日的旧格式条目 —— 暴露出来促其结构化
 */
export function sweepExpired(status, opts = {}) {
  const today = normalizeDate(opts.today)
  const phase = opts.phase
  const expired = [], pending = [], unparseable = []

  for (const container of TIMED_MAPS) {
    const map = status?.[container]
    if (!map || typeof map !== 'object') continue
    for (const [key, entry] of Object.entries(map)) {
      const info = readExpiry(entry)

      // 条件解除：代码不删，但每轮都要被看见
      if (info.condition && !info.expiry) {
        pending.push({ container, key, condition: info.condition })
        continue
      }

      if (!info.expiry) {
        if (info.sawTimeHint) unparseable.push({ container, key, shape: info.shape, raw: typeof entry === 'string' ? entry.slice(0, 60) : '' })
        continue
      }

      // 日期比较：格式已归一为 YYYY/MM/DD，字典序即时间序
      let due = false
      if (today) {
        if (info.expiry < today) due = true
        else if (info.expiry === today && info.expiryPhase) {
          // 同日：到期阶段已过则算到期
          const pi = phaseIndex(phase), ei = phaseIndex(info.expiryPhase)
          if (pi >= 0 && ei >= 0 && pi > ei) due = true
        }
      }
      if (!due) continue

      delete map[key]
      const reason = `到期 ${info.expiry}${info.expiryPhase ? ' ' + info.expiryPhase : ''}`
      expired.push({ container, key, reason })
      clearLinked(status, key, expired, reason)
    }
  }

  // 兜底：`特殊` 里的解除日已过（ST 旧数据把日期记在这里）
  const sp = status?.负面状态?.特殊
  if (sp && typeof sp === 'object' && today) {
    for (const [k, v] of Object.entries(sp)) {
      const d = normalizeDate(String(v))
      if (!d) continue
      if (d < today && /解除|到期|截止/.test(k)) {
        delete sp[k]
        expired.push({ container: '负面状态.特殊', key: k, reason: `标记日 ${d} 已过` })
        // 键名形如「惊厥解除」→ 把对应布尔位也清掉
        const hint = k.replace(/解除|到期|截止/g, '')
        clearLinked(status, hint, expired, `标记日 ${d} 已过`)
      }
    }
  }

  return { expired, pending, unparseable }
}

/**
 * 生成给 KP 看的「到期通知」文本（注入进 `⚠` 区）。
 * 这是"失败可见化"的一半：解除**发生了**，必须让叙事层知道，否则 KP 会继续按旧状态写。
 */
export function expiryNotice({ expired, pending }) {
  const lines = []
  for (const e of expired) {
    lines.push(`- ✔ 已自动解除：${e.container}.${e.key}（${e.reason}）—— 相关修正已从状态中移除，本轮起不再生效`)
  }
  for (const p of pending) {
    lines.push(`- ⏳ 待确认解除：${p.container}.${p.key}（条件：${p.condition}）—— 需叙事中确认条件满足后移除`)
  }
  return lines
}
