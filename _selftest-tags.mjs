/**
 * _selftest-tags.mjs —— lib/ami-tags.js（D4 标签枚举与归一）自检台。纯函数、零 IO。
 * 运行：node _selftest-tags.mjs
 * 隐私：本台只处理标签枚举值，不碰任何会话/摘要/角色卡内容。
 *
 * ★ 反证（由运行者手工执行并留档）：把 lib/ami-tags.js 的 canonicalTag 里大小写归一
 *   （VOCAB_LOWER / toLowerCase 兜底）删掉，只留精确命中 ⇒ 断言 2 必须变红；
 *   还原后复绿。
 */
import {
  VIBE_TAGS,
  TAG_VOCABULARY,
  IMPORTANT_TAG,
  normalizeTags,
  validateTags,
  flattenTags,
  extractTagsLine,
} from './lib/ami-tags.js'

let pass = 0
let fail = 0
function check(id, label, cond, detail) {
  if (cond) pass++
  else fail++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${id} ${label}${cond ? '' : '  ← ' + String(detail)}`)
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ═══ 1. 枚举冻结、唯一 ═══════════════════════════════════════════════════
check('1a', 'VIBE_TAGS 冻结', Object.isFrozen(VIBE_TAGS), String(Object.isFrozen(VIBE_TAGS)))
check('1b', 'VIBE_TAGS 逐字等于 anima 实测枚举（10 个，顺序一致）',
  eq(VIBE_TAGS, ['Daily', 'Wholesome', 'Comedy', 'Conflict', 'Action', 'Angst', 'Suspense', 'Romantic', 'Sexual', 'Serious']),
  JSON.stringify(VIBE_TAGS))
check('1c', 'VIBE_TAGS 无重复', new Set(VIBE_TAGS).size === VIBE_TAGS.length, String(VIBE_TAGS.length))
check('1d', 'TAG_VOCABULARY 冻结且 = 10 vibe + Important（11 个词表值）',
  Object.isFrozen(TAG_VOCABULARY) && TAG_VOCABULARY.length === 11 && TAG_VOCABULARY[10] === 'Important',
  JSON.stringify(TAG_VOCABULARY))
check('1e', 'IMPORTANT_TAG 常量逐字 = Important', IMPORTANT_TAG === 'Important', String(IMPORTANT_TAG))

// ═══ 2. 大小写归一（反证锚点：删掉 canonicalTag 的大小写兜底 ⇒ 本条变红）═══
const n1 = normalizeTags('important')
const n2 = normalizeTags('IMPORTANT')
const n3 = normalizeTags('Important')
check('2a', "normalizeTags('important'/'IMPORTANT'/'Important') 归一到同一值",
  eq(n1, ['Important']) && eq(n2, ['Important']) && eq(n3, ['Important']),
  JSON.stringify([n1, n2, n3]))
check('2b', 'vibe 同样大小写不敏感（suspense → Suspense）', eq(normalizeTags('suspense'), ['Suspense']), JSON.stringify(normalizeTags('suspense')))

// ═══ 3. 枚举外剔除 + 去重 ═══════════════════════════════════════════════
check('3a', '词表外的值被剔除、词表内保留、重复去重',
  eq(normalizeTags(['Wholesome', 'Nope', 'daily', 'Wholesome']), ['Wholesome', 'Daily']),
  JSON.stringify(normalizeTags(['Wholesome', 'Nope', 'daily', 'Wholesome'])))
check('3b', '非字符串/空串/空数组 ⇒ []', eq(normalizeTags([1, null, '']), []) && eq(normalizeTags(''), []) && eq(normalizeTags(42), []) && eq(normalizeTags(undefined), []))

// ═══ 4. validateTags：不抛、问题如实、安全空值 ══════════════════════════
let v4 = null
try {
  v4 = validateTags({ vibe: 'Nope' })
} catch (e) {
  v4 = { threw: String(e) }
}
check('4a', "validateTags({vibe:'Nope'}) 报问题、tags.vibe=null、不抛",
  v4 && !v4.threw && v4.ok === false && v4.problems.includes('vibe-not-in-enum') && v4.tags.vibe === null && eq(v4.tags.special, []) && v4.tags.important === false,
  JSON.stringify(v4))
check('4b', '非对象输入给安全空值 + 问题（不抛）',
  (() => { const v = validateTags(null); return v.ok === false && v.problems.includes('tags-not-an-object') && v.tags.vibe === null })())
check('4c', 'special 词表外剔除并计数、important 非布尔按 false + 问题',
  (() => {
    const v = validateTags({ vibe: 'action', special: ['Daily', 'Whatever'], important: 'yes' })
    return v.tags.vibe === 'Action' && eq(v.tags.special, ['Daily']) && v.tags.important === false
      && v.problems.includes('special-items-dropped:1') && v.problems.includes('important-not-a-boolean')
  })())
check('4d', '全对 ⇒ ok:true 且零问题', (() => { const v = validateTags({ vibe: 'Serious', special: [], important: false }); return v.ok === true && v.problems.length === 0 })())

// ═══ 5. flattenTags：结构化 → 扁平词表数组 ══════════════════════════════
check('5a', 'vibe+important 进扁平数组（Important 收编）',
  eq(flattenTags({ vibe: 'Action', special: [], important: true }), ['Action', 'Important']),
  JSON.stringify(flattenTags({ vibe: 'Action', special: [], important: true })))
check('5b', 'special 里的词表值一并收编、去重',
  eq(flattenTags({ vibe: null, special: ['Conflict', 'conflict'], important: false }), ['Conflict']))
check('5c', '全空 ⇒ []（⛔ 不编）', eq(flattenTags({ vibe: null, special: [], important: false }), []) && eq(flattenTags(null), []))

// ═══ 6. extractTagsLine：末行 tags 行解析（含围栏/全角冒号容错）══════════
const body = '归档条目占位正文（假，不属任何会话）'
check('6a', '标准末行 tags 行命中并解析',
  (() => { const r = extractTagsLine(body + '\ntags: {"vibe":"Suspense","special":[],"important":true}'); return r.found && r.parsed && r.parsed.vibe === 'Suspense' && r.parsed.important === true })())
check('6b', '代码围栏包裹的末行也命中',
  (() => { const r = extractTagsLine(body + '\n```json\ntags：{"vibe":"Daily","special":[],"important":false}\n```'); return r.found && r.parsed.vibe === 'Daily' })())
check('6c', '没有 tags 行 ⇒ found:false（⛔ 不猜）', extractTagsLine(body).found === false && extractTagsLine('').found === false)
check('6d', '中间行的 tags 样文本不算（只看末尾 4 个非空行）',
  (() => { const r = extractTagsLine('tags: {"vibe":"Daily","special":[],"important":false}\n\n\n\n\n\n' + body + '\n尾占位\n尾占位\n尾占位\n尾占位\n尾占位'); return r.found === false })())

console.log(`── ${pass} 通过 / ${fail} 失败 ──`)
process.exitCode = fail === 0 ? 0 : 1
