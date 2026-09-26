/**
 * ami-tags —— anima 标签机制的枚举与归一（D4）。纯函数、零依赖、不联网。
 *
 * 来源与口径（已查实，别重挖）：
 *   - vibe 枚举取自酒馆 anima_memory_system.summary.summary_messages 里那份英文
 *     "Summarization Guidelines" 的 "### Vibe Tag (Select ONE dominant)" 节 —— 逐字 10 个：
 *     Daily / Wholesome / Comedy / Conflict / Action / Angst / Suspense / Romantic / Sexual / Serious。
 *     ⚠️ 任务书三处写「11 选 1」，但真实来源就是 10 个（其任务书 §3 背景自己列的也是这 10 个）；
 *     按「不编造」铁律取 10。第 11 个标签值是 Important —— 它不是 vibe，但与 10 个 vibe 一起
 *     构成检索侧的完整标签词表（切片 tags 入库字段、策略步 labels:['Important']、
 *     echo 续命 important_tags 都认它），故 TAG_VOCABULARY = 10 vibe + Important = 11。
 *   - 归档条目里的 tags 是**扁平字符串数组**（只含词表内的值）：[vibe, ...special, "Important"?]
 *     —— 与检索侧 buildFilter({tags:{$in:[…]}}) 的消费形状一致。
 *
 * 隐私铁律：本模块不碰任何会话/摘要正文，只处理标签值本身。
 */

/** vibe 枚举（10 个，冻结、唯一；选 ONE dominant）。 */
export const VIBE_TAGS = Object.freeze([
  'Daily',
  'Wholesome',
  'Comedy',
  'Conflict',
  'Action',
  'Angst',
  'Suspense',
  'Romantic',
  'Sexual',
  'Serious',
])

/** 不可逆世界状态变更标签（策略步 labels:['Important'] 认的那个字面值）。 */
export const IMPORTANT_TAG = 'Important'

/** 完整标签词表 = 10 vibe + Important（11 个，冻结）。special[] 里的值也按它收编。 */
export const TAG_VOCABULARY = Object.freeze(Object.freeze([...VIBE_TAGS, IMPORTANT_TAG]))

const VOCAB_SET = new Set(TAG_VOCABULARY)
const VIBE_SET = new Set(VIBE_TAGS)
const VOCAB_LOWER = new Map(TAG_VOCABULARY.map((t) => [t.toLowerCase(), t]))

/**
 * 一个字符串 → 词表内的规范写法（大小写不敏感）；词表外给 null。
 * @param {unknown} value
 * @returns {string|null}
 */
export function canonicalTag(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (VOCAB_SET.has(trimmed)) return trimmed
  return VOCAB_LOWER.get(trimmed.toLowerCase()) ?? null
}

/**
 * 标签列表归一：大小写/别名归一 + 只保留词表内 + 去重（保持首次出现顺序）。
 * @param {unknown} raw - 字符串或字符串数组；其它类型给 []。
 * @returns {string[]}
 */
export function normalizeTags(raw) {
  const items = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : []
  const out = []
  const seen = new Set()
  for (const item of items) {
    const tag = canonicalTag(item)
    if (tag === null || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
  }
  return out
}

/**
 * 校验结构化 tags（模型按指令给出的 {vibe, special, important}）。
 * ⛔ 绝不抛、绝不猜：值收编不进就剔除并记 problem；shape 不对就给安全空值 + problem。
 * @param {unknown} raw
 * @returns {{ok: boolean, tags: {vibe: string|null, special: string[], important: boolean}, problems: string[]}}
 */
export function validateTags(raw) {
  if (!isPlainObject(raw)) {
    return { ok: false, tags: { vibe: null, special: [], important: false }, problems: ['tags-not-an-object'] }
  }
  const problems = []
  // vibe：只认 10 个 vibe（Important 不算 vibe）；大小写不敏感。
  let vibe = null
  if (typeof raw.vibe === 'string') {
    const canonical = canonicalTag(raw.vibe)
    if (canonical !== null && VIBE_SET.has(canonical)) vibe = canonical
    else problems.push('vibe-not-in-enum')
  } else {
    problems.push('vibe-not-a-string')
  }
  // special：字符串数组逐个按词表收编；收编不进的剔除并计数。
  let special = []
  if (Array.isArray(raw.special)) {
    const kept = []
    let dropped = 0
    const seen = new Set()
    for (const item of raw.special) {
      const tag = canonicalTag(item)
      if (tag === null) {
        dropped += 1
        continue
      }
      if (seen.has(tag)) continue
      seen.add(tag)
      kept.push(tag)
    }
    if (dropped > 0) problems.push('special-items-dropped:' + dropped)
    special = kept
  } else {
    problems.push('special-not-an-array')
  }
  // important：布尔；缺省/类型不对按 false + problem（默认 false 是 anima 的口径）。
  let important = false
  if (typeof raw.important === 'boolean') important = raw.important
  else problems.push('important-not-a-boolean')
  return { ok: problems.length === 0, tags: { vibe, special, important }, problems }
}

/**
 * 结构化 tags → 归档条目里的扁平数组（只含词表内的值，去重）：
 * [vibe?, ...special, "Important"?]。全空给 []（⛔ 不编）。
 * @param {{vibe: string|null, special: string[], important: boolean}} tags
 * @returns {string[]}
 */
export function flattenTags(tags) {
  if (!isPlainObject(tags)) return []
  const parts = []
  if (typeof tags.vibe === 'string' && tags.vibe !== '') parts.push(tags.vibe)
  if (Array.isArray(tags.special)) parts.push(...tags.special)
  if (tags.important === true) parts.push(IMPORTANT_TAG)
  return normalizeTags(parts)
}

/**
 * 从模型摘要正文末尾找 tags 行并解析（D1 归档时给条目补 tags 用）。
 * 约定格式（指令里要求）：末尾一行 `tags: {"vibe":"…","special":[…],"important":false}`。
 * 容错：容忍 ``` 围栏、全角冒号、裸 JSON 对象（含 "vibe" 键才算命中）。
 * 只从末尾往前最多看 4 个非空行（tags 行在指令里被要求是最后一行；往多了找会误伤正文）。
 * ⛔ 找不到/解析不了给 {found:false, parsed:null}，绝不猜。
 * @param {string} text
 * @returns {{found: boolean, parsed: object|null}}
 */
export function extractTagsLine(text) {
  if (typeof text !== 'string' || text === '') return { found: false, parsed: null }
  const lines = text.split(/\r?\n/)
  const candidates = []
  for (let i = lines.length - 1; i >= 0 && candidates.length < 4; i--) {
    const trimmed = lines[i].trim().replace(/^`+|`+$/g, '').trim()
    if (trimmed !== '') candidates.push(trimmed)
  }
  for (const line of candidates) {
    let jsonText = null
    const tagged = /^tags?\s*[:：]\s*(\{.+\})\s*$/i.exec(line)
    if (tagged) {
      jsonText = tagged[1]
    } else if (/^\{.+\}$/.test(line) && /["']vibe["']\s*:/i.test(line)) {
      jsonText = line // 裸 JSON 对象，且确实像 tags（含 "vibe" 键）才算
    }
    if (jsonText === null) continue
    try {
      const parsed = JSON.parse(jsonText)
      if (isPlainObject(parsed)) return { found: true, parsed }
    } catch {
      // 这一行像 tags 但解析不了：不算命中，继续往前看一行（⛔ 不修文本、不猜）
    }
  }
  return { found: false, parsed: null }
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
