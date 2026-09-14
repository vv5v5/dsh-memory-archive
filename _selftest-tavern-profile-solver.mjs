/**
 * _selftest-tavern-profile-solver.mjs —— 「外部模式」DSH 侧解算器（lib/tavern-profile-solver.js）的自检台。
 *
 * ## 为什么夹具必须"按构造式拼"而不是手写
 * 解算器的全部依据是**上游拼这段文本的方式**（块格式 + `\n\n` 分隔 + 收尾标签独占行首）。
 * 如果我手写一段"看起来像"的样本，那只能证明"我能解析我自己编的格式" —— 与真机无关。
 * 所以这里的 `buildProfile()` **逐条照抄**上游的拼法：
 *   profile-loader.js:426 join('\n\n') / :479 profileHeader / :497 promptBlock /
 *   :501 characterBlock / :506 userBlock / :578 loreText / :557 appendCharacterFallbacks 的字段顺序
 *   profile-compiler.js:38 只-preset 快路径的头
 *
 * ## 覆盖
 *   ① 空串 / 只-preset 快路径 / 完整形状 三种输入都能解
 *   ② 每个 part 的 kind、来源身份（identifier / 卡字段名 / 世界书 entry）、offset、chars 精确
 *   ③ 不变量守恒（独立复算函数 verifyTavernProfileSolution 也必须平）
 *   ④ ★ 盲区：main/jailbreak 里的 override 拼接必须是**主动说出**的，且喂了字段原文才逐字定位
 *   ⑤ ★ 反证六条（收尾标签错 / 无标签文本 / 未知标签 / 未闭合 / 字段原文不在里面 / 不变量校验器能红）
 *   ⑥ ★ 隐私：头部值与正文都**不许**出现在结果里（拿唯一哨兵串搜整个序列化结果）
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  solveTavernProfile, verifyTavernProfileSolution,
  TAVERN_PROFILE_MARKER, TAVERN_PRESET_ONLY_MARKER, TAVERN_CARD_FIELDS, TAVERN_PROFILE_SOLVER_VERSION,
} from './lib/tavern-profile-solver.js'

const here = dirname(fileURLToPath(import.meta.url))
let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`PASS ${name}`)
  else {
    failures++
    console.log(`FAIL ${name}${detail ? ' —— ' + detail : ''}`)
  }
}

// ── 上游拼法（逐条照抄；这里只用固定文本，不碰任何真实卡/世界书） ──────────────
const esc = (v) => String(v ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const profileHeader = ({ preset, character, user }) => {
  const lines = [TAVERN_PROFILE_MARKER]
  if (preset) { lines.push(`preset-name: ${preset.name}`); lines.push(`preset-id: ${esc(preset.id)}`) }
  if (character) { lines.push(`character-name: ${character.name}`); lines.push(`character-id: ${esc(character.id)}`) }
  if (user) { lines.push(`user-name: ${user.name}`); lines.push(`user-id: ${esc(user.id)}`) }
  return [lines.join('\n')]
}
const promptBlock = (p, text) => `<st-prompt identifier="${esc(p.identifier)}" role="${esc(p.role)}">\n${text}\n</st-prompt>`
const characterBlock = (name, text) => `<st-character-field name="${name}">\n${text}\n</st-character-field>`
const userBlock = (text) => `<st-user-field name="persona-description">\n${text}\n</st-user-field>`
const loreText = (entries) => entries.map((e) => `<st-world-info entry="${esc(e.id)}" position="${esc(e.position)}">\n${e.content}\n</st-world-info>`).join('\n\n')
const buildProfile = ({ preset, character, user, prompts = [], fields = [], userFields = [], beforeLore = [], afterLore = [], imported = null }) => {
  const body = []
  for (const p of prompts) body.push(promptBlock(p, p.content))
  for (const [name, text] of userFields) body.push(userBlock(text))
  for (const [name, text] of fields) body.push(characterBlock(name, text))
  if (beforeLore.length > 0) body.push(loreText(beforeLore))
  if (afterLore.length > 0) body.push(loreText(afterLore))
  const header = profileHeader({ preset, character, user })
  const parts = [...header, ...body]
  if (imported !== null) parts.push(imported)
  return parts.filter(Boolean).join('\n\n')
}

// ── ① 空串 ────────────────────────────────────────────────────────────────────
{
  const r = solveTavernProfile('')
  check('① 空串：ok 且零块、覆盖度 1', r.ok === true && r.parts.length === 0 && r.coverage.ratio === 1, JSON.stringify(r.coverage))
  check('① 空串：版本号带出来', r.version === TAVERN_PROFILE_SOLVER_VERSION)
}
// ② 只-preset 快路径（上游 compilePresetForDsh：另一种头，只有 st-prompt）
{
  const text = [TAVERN_PRESET_ONLY_MARKER, 'name: 我的预设', 'id: preset-1'].join('\n')
    + '\n\n' + promptBlock({ identifier: 'main', role: 'system' }, '你是主角。')
  const r = solveTavernProfile(text)
  check('② 只-preset 路径的头被认出来（不是未归属文本）',
    r.header.present === true && r.header.marker === TAVERN_PRESET_ONLY_MARKER && r.parts[0].kind === 'header',
    JSON.stringify({ marker: r.header.marker, first: r.parts[0]?.kind }))
  check('② 只-preset 路径的块解出来了', r.sources.presetPrompt === 1 && r.parts[1].presetIdentifier === 'main', JSON.stringify(r.sources))
  check('② 只-preset 路径没有卡字段块（如实为零，而不是编一个）',
    r.sources.characterField === 0 && Object.keys(r.byField).length === 0, JSON.stringify(r.byField))
  check('② 只-preset 路径也会报盲区（有 main 无 system-prompt 标签）',
    r.blindSpots.some((b) => b.code === 'system-prompt-may-be-spliced-into-main'), JSON.stringify(r.blindSpots.map((b) => b.code)))
}

// ── ③ 完整形状：头 + 预设块 + user + 卡字段 + 世界书前后 ────────────────────────
const SENTINEL_NAME = 'ZQX-UNIQUE-CHARACTER-NAME-SENTINEL'
const SENTINEL_BODY = 'ZQX-UNIQUE-BODY-SENTINEL'
const fpBefore = 'BEFORE-LORE-TEXT'
const fpAfter = 'AFTER-LORE-TEXT'
const fpDesc = 'FIELD-DESCRIPTION'
const fpPerson = 'FIELD-PERSONALITY'
const fpGreet = 'FIELD-GREETING-REFERENCE'
const fpUser = 'USER-PERSONA-TOKEN'
const fpSpliced = 'SPLICED-SYSTEM-PROMPT-TOKEN'
const full = buildProfile({
  preset: { name: SENTINEL_NAME, id: 'preset-x' },
  character: { name: SENTINEL_NAME, id: 'char-x' },
  user: { name: 'ZZ', id: 'user-x' },
  prompts: [
    { identifier: 'main', role: 'system', content: `开头。${fpSpliced}结尾。` },
    { identifier: 'worldInfoBefore', role: 'system', content: '' }, // marker：上游会整块换成世界书（这里用后面显式补的 beforeLore 代替）
    { identifier: 'chatHistory', role: 'system', content: '' },
    { identifier: 'jailbreak', role: 'system', content: `收尾。${SENTINEL_BODY}` },
  ].filter((p) => p.content !== ''),
  userFields: [['persona-description', fpUser]],
  fields: [['description', fpDesc], ['personality', fpPerson], ['greeting-reference', fpGreet]],
  beforeLore: [{ id: 'wb-1', position: 'before', content: fpBefore }],
  afterLore: [{ id: 'wb-2', position: 'after', content: fpAfter }, { id: 'wb-3', position: 'after', content: 'AFTER-LORE-2' }],
  imported: `<imported-playthrough-context trust="untrusted" sha256="deadbeef">\n<handling>read-only</handling>\n</imported-playthrough-context>`,
})
const r3 = solveTavernProfile(full, { sectionOffset: 2763 })

check('③ 头部被识别、键名与值长都在（⛔ 不含值）',
  r3.header.present === true && r3.header.marker === TAVERN_PROFILE_MARKER
  && r3.header.keys.some((k) => k.key === 'character-name' && k.valueChars === SENTINEL_NAME.length),
  JSON.stringify(r3.header.keys))
check('③ 块序列正确（预设 2 + 卡字段 3 + user 1 + 世界书 3 + 导入 1 + 头 1）',
  r3.sources.header === 1 && r3.sources.presetPrompt === 2 && r3.sources.characterField === 3
  && r3.sources.userField === 1 && r3.sources.worldInfo === 3 && r3.sources.importedContext === 1 && r3.sources.unknown === 0,
  JSON.stringify(r3.sources))
check('③ 预设块带出 identifier 与 role',
  r3.parts.some((p) => p.kind === 'preset-prompt' && p.presetIdentifier === 'main' && p.role === 'system'),
  JSON.stringify(r3.parts.filter((p) => p.kind === 'preset-prompt').map((p) => [p.presetIdentifier, p.role])))
check('③ 卡字段块映射到 ST 字段名（含 greeting-reference 这类旁支）',
  r3.parts.some((p) => p.kind === 'character-field' && p.tagNameAttr === 'description' && p.field === 'description')
  && r3.parts.some((p) => p.tagNameAttr === 'greeting-reference' && p.field === 'greeting_reference'),
  JSON.stringify(r3.parts.filter((p) => p.kind === 'character-field').map((p) => [p.tagNameAttr, p.field])))
check('③ 世界书带出 entry 与 position，且多条被分成多块',
  JSON.stringify(r3.parts.filter((p) => p.kind === 'world-info').map((p) => [p.worldInfoEntry, p.worldInfoPosition]))
  === JSON.stringify([['wb-1', 'before'], ['wb-2', 'after'], ['wb-3', 'after']]),
  JSON.stringify(r3.parts.filter((p) => p.kind === 'world-info').map((p) => [p.worldInfoEntry, p.worldInfoPosition])))
check('③ 导入上下文是独立一种（不是 unknown）',
  r3.parts.some((p) => p.kind === 'imported-context' && p.trust === 'untrusted' && p.sourceSha256 === 'deadbeef'),
  JSON.stringify(r3.parts.filter((p) => p.kind === 'imported-context')))
check('③ 不变量守恒 + 独立复算也平', r3.ok === true && verifyTavernProfileSolution(r3).length === 0,
  JSON.stringify(verifyTavernProfileSolution(r3)))
check('③ 覆盖度：已归属 + 分隔符 === 总长',
  r3.coverage.attributedChars + r3.coverage.separatorChars === r3.chars,
  JSON.stringify({ ...r3.coverage, chars: r3.chars }))
check('③ 绝对偏移 = sectionOffset + 相对偏移（给了才给）',
  r3.parts.every((p) => p.absoluteOffset === 2763 + p.offset, 2763))
{
  const r = solveTavernProfile(full) // 不给 sectionOffset
  check('③ 没给 sectionOffset 时绝对偏移为 null（⛔ 不是 0）',
    r.parts.every((p) => p.absoluteOffset === null), JSON.stringify(r.parts.slice(0, 2).map((p) => p.absoluteOffset)))
}
check('③ byField 汇总：description 的块与字数对得上',
  r3.byField.description.taggedChars > 0 && r3.byField.description.tagNames.join(',') === 'description'
  && r3.byField.description.parts.length === 1,
  JSON.stringify(r3.byField))
{
  const desc = r3.parts.find((p) => p.tagNameAttr === 'description')
  const inner = full.slice(desc.innerOffset, desc.innerOffset + desc.innerChars)
  check('③ 正文切片逐字等于原串里的那段（innerOffset/innerChars 可信）', inner === fpDesc, JSON.stringify(inner.slice(0, 40)))
}

// ── ③b 没有头（首块就是标签）⇒ 必须如实说"没有头"，⛔ 不许把首块当头部吞掉 ────────────
{
  const noHeader = promptBlock({ identifier: 'main', role: 'system' }, '正文') + '\n\n' + characterBlock('description', '描述')
  const r = solveTavernProfile(noHeader)
  check('③b 没有头 ⇒ header.present=false + 有 header-absent 告警',
    r.header.present === false && r.warnings.some((w) => w.code === 'header-absent'),
    JSON.stringify({ present: r.header.present, warns: r.warnings.map((w) => w.code) }))
  check('③b 没有头时首块仍被正确解出（没被当头部吃掉）',
    r.parts[0].kind === 'preset-prompt' && r.parts[0].presetIdentifier === 'main'
    && r.sources.characterField === 1
    && r.coverage.accountedRatio === 1
    && r.coverage.attributedChars + r.coverage.separatorChars === r.chars,
    JSON.stringify({ first: r.parts[0]?.kind, sources: r.sources, coverage: r.coverage }))
}

// ── ④ 盲区 + 逐字定位（这是"外部模式"的关键：光有标签定位不了被拼进 main 的卡字段） ──
check('④ 未喂字段原文时：main 的拼接必须被当成**盲区**说出来',
  r3.blindSpots.some((b) => b.code === 'system-prompt-may-be-spliced-into-main'),
  JSON.stringify(r3.blindSpots.map((b) => b.code)))
check('④ 未喂字段原文时：不许声称定位到了 system_prompt',
  r3.fieldTextMatch.length === 0 && r3.byField.system_prompt === undefined, JSON.stringify(r3.byField.system_prompt ?? null))
{
  const r = solveTavernProfile(full, {
    fieldTexts: { system_prompt: fpSpliced, description: fpDesc, personality: 'NOT-IN-THIS-TEXT' },
  })
  const sp = r.fieldTextMatch.find((m) => m.field === 'system_prompt')
  const de = r.fieldTextMatch.find((m) => m.field === 'description')
  const pe = r.fieldTextMatch.find((m) => m.field === 'personality')
  check('④ 喂了原文：被拼进 main 的 system_prompt 逐字定位到，并指明它落在哪个块里',
    sp && sp.found === true && sp.exact === true && sp.insidePartKind === 'preset-prompt',
    JSON.stringify(sp))
  check('④ 定位到的位置能切回原文本身',
    sp && full.slice(sp.offset, sp.offset + sp.chars) === fpSpliced, JSON.stringify(sp && full.slice(sp.offset, sp.offset + sp.chars)))
  check('④ 有标签的那一段也照样能定位（落在 character-field 块里）',
    de && de.found === true && de.insidePartKind === 'character-field', JSON.stringify(de))
  check('④ ★ 原文不在这段里 ⇒ 如实说没找到，⛔ 不许近似命中',
    pe && pe.found === false, JSON.stringify(pe))
  check('④ byField 把"拼进去的"与"有标签的"分开记（不许混成一个数）',
    r.byField.system_prompt.splicedInPresetChars === fpSpliced.length
    && r.byField.system_prompt.taggedChars === 0
    && r.byField.description.taggedChars > 0 && r.byField.description.splicedInPresetChars === 0,
    JSON.stringify(r.byField))
}

// ── ⑤ 反证 ────────────────────────────────────────────────────────────────────
{
  // ⑤-1 收尾标签写错 ⇒ ★ 不许静默吞并！
  //   实测过：只改坏一个收尾标签时，findClose 会认到**下一块**的收尾标签，于是本块把下一块吞进来 ——
  //   这时 closed 仍是 true，若不开第二条判据，"未闭合"就永远测不出来（假阴性）。所以要求：
  //   要么 closed:false，要么有 nested-open-inside-block 告警；两条都没有 = 静默吞并 = 红。
  const broken = full.replace('</st-character-field>\n\n<st-character-field name="personality">', '</st-character-fieldX>\n\n<st-character-field name="personality">')
  const r = solveTavernProfile(broken)
  const r0 = solveTavernProfile(full)
  const saysSomething = r.parts.some((p) => p.closed === false)
    || r.warnings.some((w) => w.code === 'nested-open-inside-block' || w.code === 'block-unclosed')
  check('⑤-1 收尾标签写错 ⇒ 必须说出来（未闭合 或 块内出现开标签），⛔ 不许静默吞并',
    saysSomething, JSON.stringify({ closed: r.parts.filter((p) => !p.closed).map((p) => p.tagName), warns: r.warnings.map((w) => w.code) }))
  check('⑤-1 吞并的后果可读：卡字段块数从 3 掉到 2（读者据此知道丢了一块）',
    r0.sources.characterField === 3 && r.sources.characterField === 2,
    JSON.stringify({ before: r0.sources.characterField, after: r.sources.characterField }))
  check('⑤-1 即便吞并，不变量仍守恒（诚实：文本事实被完整记账，不是丢字节）',
    r.ok === true && verifyTavernProfileSolution(r).length === 0, JSON.stringify(verifyTavernProfileSolution(r)))
}
{
  // ⑤-2 无标签文本 ⇒ unknown-text，且**不许**多出任何字段
  const r0 = solveTavernProfile(full)
  const injected = full + '\n\n' + '这段没有任何标签，可能是上游新加的东西。'
  const r = solveTavernProfile(injected)
  check('⑤-2 无标签文本 ⇒ unknown-text 且被点数',
    r.sources.unknown === 1 && r.parts.some((p) => p.kind === 'unknown-text'),
    JSON.stringify({ unknown: r.sources.unknown, kinds: r.parts.map((p) => p.kind) }))
  check('⑤-2 ★ 无标签文本不许让任何字段凭空多出来',
    JSON.stringify(Object.keys(r.byField).sort()) === JSON.stringify(Object.keys(r0.byField).sort()),
    JSON.stringify({ before: Object.keys(r0.byField), after: Object.keys(r.byField) }))
  check('⑤-2 覆盖度仍守恒（未归属也被算进去）',
    r.ok === true && r.coverage.attributedChars + r.coverage.separatorChars === r.chars
    && r.coverage.unattributedChars === '这段没有任何标签，可能是上游新加的东西。'.length,
    JSON.stringify({ ...r.coverage, chars: r.chars }))
}
{
  // ⑤-3 未知标签 ⇒ unknown-tag，不归字段
  const r = solveTavernProfile(full + '\n\n' + '<st-something-new a="b">\n内容\n</st-something-new>')
  const last = r.parts[r.parts.length - 1]
  check('⑤-3 未知标签 ⇒ unknown-tag + 有 warning + 不归任何字段',
    last.kind === 'unknown-tag' && last.tagName === 'st-something-new' && last.field === undefined
    && r.warnings.some((w) => w.code === 'unknown-tag'),
    JSON.stringify({ last: last.kind, warns: r.warnings.map((w) => w.code) }))
}
{
  // ⑤-4 卡字段 name 不在上游映射里 ⇒ 不猜
  const r = solveTavernProfile(full + '\n\n' + characterBlock('some-future-field', 'X'))
  const blk = r.parts[r.parts.length - 1]
  check('⑤-4 不认识的卡字段 name ⇒ 有 warning 且 field 为 undefined',
    blk.kind === 'character-field' && blk.field === undefined
    && r.warnings.some((w) => w.code === 'character-field-unknown-name'),
    JSON.stringify({ kind: blk.kind, field: blk.field ?? null, warns: r.warnings.map((w) => w.code) }))
}
{
  // ⑤-5 ★ 不变量校验器必须能红（否则它只是橡皮图章）
  const r = solveTavernProfile(full)
  const tampered = JSON.parse(JSON.stringify(r))
  tampered.parts[2].chars += 1
  check('⑤-5 反证：人为把某块 chars 改大 ⇒ 独立复算必须报不平',
    verifyTavernProfileSolution(tampered).length > 0, JSON.stringify(verifyTavernProfileSolution(tampered)))
  const dropped = JSON.parse(JSON.stringify(r))
  dropped.separators.chars += 1
  check('⑤-5 反证：人为改分隔符 ⇒ 独立复算必须报不守恒',
    verifyTavernProfileSolution(dropped).some((p) => p.includes('不守恒')), JSON.stringify(verifyTavernProfileSolution(dropped)))
  check('⑤-5 反证：喂垃圾 ⇒ 必须报错而不是静默通过',
    verifyTavernProfileSolution(null).length > 0 && verifyTavernProfileSolution({ parts: 'x', chars: 1 }).length > 0)
}
{
  // ⑤-6 世界书 position 异常 ⇒ 原样记 + 有 warning
  const r = solveTavernProfile(buildProfile({ preset: { name: 'p', id: 'p' }, afterLore: [{ id: 'wb-x', position: 'weird', content: 'X' }] }))
  const wi = r.parts.find((p) => p.kind === 'world-info')
  check('⑤-6 position 不是 before/after ⇒ 原样记 + 有 warning',
    wi.worldInfoPosition === 'weird' && r.warnings.some((w) => w.code === 'world-info-position-unexpected'),
    JSON.stringify({ pos: wi.worldInfoPosition, warns: r.warnings.map((w) => w.code) }))
}

// ── ⑥ ★ 隐私：头部值与正文都不许出现在结果里 ───────────────────────────────────
{
  const serialized = JSON.stringify(r3)
  check('⑥ ★ 结果里不含头部值（角色名哨兵）', !serialized.includes(SENTINEL_NAME), '哨兵出现在结果里')
  check('⑥ ★ 结果里不含正文（正文哨兵）', !serialized.includes(SENTINEL_BODY) && !serialized.includes(fpDesc) && !serialized.includes(fpBefore),
    '正文哨兵出现在结果里')
  check('⑥ ★ 结果里不含字段原文（即使喂了 fieldTexts 做定位，也只回位置不回原文）',
    !JSON.stringify(solveTavernProfile(full, { fieldTexts: { system_prompt: fpSpliced } })).includes(fpSpliced))
  check('⑥ 头部只回键名与值长', r3.header.keys.every((k) => typeof k.key === 'string' && typeof k.valueChars === 'number' && Object.keys(k).length === 2),
    JSON.stringify(r3.header.keys[0]))
}

// ── ⑦ 契约：7 个卡字段名单与上游只读接口对齐（M3 PR 的 card-fields） ────────────
{
  check('⑦ 7 个卡字段名单与 M3 PR 的 card-fields 接口一致',
    JSON.stringify(TAVERN_CARD_FIELDS) === JSON.stringify(['description', 'personality', 'scenario', 'mes_example', 'system_prompt', 'post_history_instructions', 'depth_prompt']),
    JSON.stringify(TAVERN_CARD_FIELDS))
  const src = readFileSync(join(here, 'lib', 'tavern-profile-solver.js'), 'utf8')
  check('⑦ 解算器零依赖 / 零写入（不 import 任何东西、不碰 fs/网络）',
    !/^\s*import\s/m.test(src) && !/require\(/.test(src) && !/readFileSync|writeFileSync|fetch\(/.test(src),
    '源码里出现了 import/require/fs/网络调用')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
