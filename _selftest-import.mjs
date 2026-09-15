/**
 * _selftest-import.mjs —— 聊天导入格式适配器 + 计划端点（lib/import-formats.js）自检台。
 *
 * ★ 隐私自证：本台的 fixture 全部在运行时【拼装合成】（源文件里只有碎片，没有成句正文），
 *   结尾把每句合成正文的前 12 字拿去搜 —— 自检输出（缓冲的每一行 console.log）与两个
 *   源文件（lib/import-formats.js / _selftest-import.mjs）必须零命中。
 *
 * 覆盖（任务书 §4.3 八条 + 反证）：
 *   1) 格式识别：两种样本各判对；散文 ⇒ null。反证：把 IMPORT_FORMATS[0].detect 换成
 *      「永远 true」⇒ 散文被误判成第一种（红）⇒ 还原后恢复 null。
 *   2) jsonl 解析：1 行头 + 5 行消息（2 行 is_system:true、1 行缺 is_system 键）
 *      ⇒ turns=5、hidden=2、visible=3（缺键算可见）。
 *   3) qa 顺序与角色：roles 交替 user/assistant、index 连续从 0。
 *   4) 畸形输入不抛：非法 JSON / qa 非数组 / qa[i].user 缺失 / jsonl 中间坏行
 *      ⇒ 全给结构化 IMPORT_INVALID 且进程不崩。反证：同样的输入喂给「摘掉守卫」的
 *      裸管道 ⇒ 4 个全崩（证明守卫是承重墙）。
 *   5) 上限：maxTurns=3 喂 5 行 ⇒ IMPORT_TOO_MANY_TURNS；maxBytes=10 喂大文本
 *      ⇒ IMPORT_TOO_LARGE（且先查大小再 parse）。
 *   6) sourceHash 真在算：同文本两次相同、且等于独立用 node:crypto 算的 sha256；
 *      改一字节 ⇒ 变。反证：若是常量桩，与独立 sha256 的等值断言必红。
 *   7) ⛔ 零写入：假 tavern 的 write/mkdir 计数必须为 0（write/mkdir 一被调就抛
 *      ZERO_WRITE_GUARD 并计数）。
 *   8) 隐私自证（见文件头）。
 *   附加：planImport 的楼号接续/缺目录从 0/keepHidden/keepGreeting/同哈希批次提醒/
 *   source.path 走 read/IMPORT_SOURCE_UNREADABLE/IMPORT_FORMAT_UNSUPPORTED/
 *   validateImportInput 的穿越与二选一拒绝；楼层内容形状 = Tavern 真机 5 键
 *   （_floor/is_user/is_system/mes/name：Object.keys().sort() 恰等断言 + 多键反证 + 哈希对账）。
 *
 * ★ 本台零网络、零落盘（除 node --check 子进程；临时目录一个都不建）。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(fileURLToPath(import.meta.url))
const SRC_MODULE = join(repo, 'lib', 'import-formats.js')
const SRC_SELFTEST = join(repo, '_selftest-import.mjs')

// ---- 输出缓冲（第 8 条隐私自证要用：连自检自己的输出一起搜） ----
const OUT = []
const origLog = console.log
console.log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ')
  OUT.push(line)
  origLog(line)
}

let failures = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond || detail === '' ? '' : ' —— ' + detail}`)
  if (!cond) failures++
}

// ---- 0) 守门：两个涉改文件先过 node --check ----
for (const f of ['lib/import-formats.js', 'lib/index.js']) {
  const r = spawnSync(process.execPath, ['--check', join(repo, f)], { encoding: 'utf8' })
  check(`node --check ${f} 退出码 0`, r.status === 0, `status=${r.status} ${(r.stderr || '').slice(0, 160)}`)
}

const imp = await import('./lib/import-formats.js')
const { IMPORT_FORMATS, detectFormat, normalizeImport, planImport, validateImportInput, importConstants } = imp

// ---- 合成 fixture（隐私：碎片拼装，源文件里没有成句正文） ----
const W1 = '导入自检', W2 = '合成正文', W3 = '样例楼层', W4 = '占位话术'
const mk = (tag) => [W1, W2, W3, W4, tag].join('-') // 每句 ≥12 字且互不相同
const M = [mk('甲'), mk('乙'), mk('丙'), mk('丁'), mk('戊')]
const U1 = mk('问一'), A1 = mk('答一'), U2 = mk('问二'), A2 = mk('答二')
const GREET = [W1, W3, '开场'].join('-')

const header = { character_name: 'SELFTEST_CHAR', chat_metadata: { version: 1 }, user_name: 'SELFTEST_USER' }
// 5 行消息：2 行 is_system:true（第 1、4 行）、1 行缺 is_system 键（第 3 行）⇒ hidden=2 visible=3
const msgRows = [
  { mes: M[0], is_user: true, is_system: true, name: 'SELFTEST_USER', send_date: '2026-01-01T00:00:01' },
  { mes: M[1], is_user: false, is_system: false, name: 'SELFTEST_CHAR', send_date: '2026-01-01T00:00:02' },
  { mes: M[2], is_user: false, name: 'SELFTEST_CHAR' }, // 缺 is_system ⇒ 可见
  { mes: M[3], is_user: true, is_system: true, name: 'SELFTEST_USER', send_date: '2026-01-01T00:00:04' },
  { mes: M[4], is_user: false, is_system: false, name: 'SELFTEST_CHAR', send_date: '2026-01-01T00:00:05' },
]
const JSONL_TEXT = [JSON.stringify(header), ...msgRows.map((r) => JSON.stringify(r))].join('\n')
const JSONL_CRLF = [JSON.stringify(header), ...msgRows.map((r) => JSON.stringify(r))].join('\r\n')
const TAVERN_DOC = {
  schemaVersion: 1,
  source: { kind: 'selftest', note: 'synthetic' },
  greeting: GREET,
  qa: [{ user: U1, assistant: A1 }, { user: U2, assistant: A2 }],
}
const TAVERN_TEXT = JSON.stringify(TAVERN_DOC, null, 2)
const PROSE = ['这段只是普通散文', '不是JSON', '更不是jsonl'].join('，') + '。'

// ---- 1) 格式识别 + 反证 ----
check('1a tavern 样本判为 tavern-import-context', detectFormat(TAVERN_TEXT) === 'tavern-import-context', detectFormat(TAVERN_TEXT))
check('1b jsonl 样本判为 sillytavern-jsonl', detectFormat(JSONL_TEXT) === 'sillytavern-jsonl', detectFormat(JSONL_TEXT))
check('1c 散文判为 null（不猜）', detectFormat(PROSE) === null, String(detectFormat(PROSE)))
check('1d 交叉：minified tavern JSON 不会被当成 jsonl（无 mes+is_user 行）', IMPORT_FORMATS[1].detect(JSON.stringify(TAVERN_DOC)) === false)
check('1e 交叉：jsonl 整体不是合法 JSON，判不进 tavern', IMPORT_FORMATS[0].detect(JSONL_TEXT) === false)
{
  const orig = IMPORT_FORMATS[0].detect
  try {
    IMPORT_FORMATS[0].detect = () => true // 反证：改成「永远返回第一个」
    const broken = detectFormat(PROSE)
    check('1f 反证：detect 换成「永远第一个」后散文被误判（红）——证明 1c 的 null 来自真判别', broken === 'tavern-import-context', String(broken))
  } finally {
    IMPORT_FORMATS[0].detect = orig
  }
  check('1g 还原后散文恢复 null', detectFormat(PROSE) === null, String(detectFormat(PROSE)))
}

// ---- 2) jsonl 解析：计数与 hidden 口径 ----
{
  const n = normalizeImport(JSONL_TEXT)
  check('2a turns=5', n.turns.length === 5 && n.sourceMeta.turns === 5, JSON.stringify(n.sourceMeta))
  check('2b hidden=2 visible=3（缺 is_system 键算可见）', n.sourceMeta.hidden === 2 && n.sourceMeta.visible === 3, JSON.stringify(n.sourceMeta))
  check('2c lines=6（非空行：1 头 + 5 消息）', n.sourceMeta.lines === 6, String(n.sourceMeta.lines))
  check('2d 第 3 行（缺键）确实 visible、第 1 行确实 hidden', n.turns[2].hidden === false && n.turns[0].hidden === true)
  check('2e role 按 is_user：true→user / false→assistant', n.turns[0].role === 'user' && n.turns[1].role === 'assistant' && n.turns[4].role === 'assistant')
  check('2f name/time 带入（有则带）', n.turns[0].name === 'SELFTEST_USER' && n.turns[0].time === '2026-01-01T00:00:01' && n.turns[2].time === undefined)
  check('2g CRLF 行尾同样可解析（真 ST 导出常见）', (() => { const c = normalizeImport(JSONL_CRLF); return c.sourceMeta.turns === 5 && c.sourceMeta.hidden === 2 })())
  check('2h format 字段与 schemaVersion', n.format === 'sillytavern-jsonl' && n.schemaVersion === 1)
}

// ---- 3) qa 顺序与角色 ----
{
  const n = normalizeImport(TAVERN_TEXT)
  check('3a qa[2] 展开为 4 轮', n.turns.length === 4 && n.sourceMeta.turns === 4, String(n.turns.length))
  check('3b role 交替 user/assistant', JSON.stringify(n.turns.map((t) => t.role)) === JSON.stringify(['user', 'assistant', 'user', 'assistant']), JSON.stringify(n.turns.map((t) => t.role)))
  check('3c index 连续从 0', n.turns.every((t, i) => t.index === i))
  check('3d 楼楼可见（tavern 无隐藏概念）', n.turns.every((t) => t.hidden === false))
  check('3e greeting 保留为 string', n.greeting === GREET && typeof n.greeting === 'string')
  const n2 = normalizeImport(JSON.stringify({ ...TAVERN_DOC, greeting: null }))
  check('3f greeting=null ⇒ 字段缺席（冻结形状 greeting?:string）', !('greeting' in n2))
}

// ---- 4) 畸形输入不抛 + 反证（摘掉守卫必崩） ----
{
  const badTavernInvalidJson = '{"schemaVersion":1, "qa":[' // 断尾
  const badTavernQaNotArray = JSON.stringify({ schemaVersion: 1, qa: 'nope' })
  const badTavernUserMissing = JSON.stringify({ schemaVersion: 1, qa: [{ assistant: A1 }] })
  const badJsonlMidLine = [JSON.stringify(header), JSON.stringify(msgRows[0]), '{broken json', JSON.stringify(msgRows[1])].join('\n')
  const cases = [
    ['非法 JSON', badTavernInvalidJson],
    ['qa 非数组', badTavernQaNotArray],
    ['qa[i].user 缺失/非 string', badTavernUserMissing],
    ['jsonl 中间一行坏 JSON', badJsonlMidLine],
  ]
  for (const [name, text] of cases) {
    let threw = null
    try {
      normalizeImport(text)
    } catch (e) {
      threw = e
    }
    check(`4 ${name} ⇒ 结构化 IMPORT_INVALID 且进程不崩`, threw !== null && threw.code === 'IMPORT_INVALID', threw ? String(threw.code) : '没抛')
  }
  // 反证：同样的输入喂给「摘掉守卫」的裸管道 ⇒ 全崩（证明不是橡皮图章）
  const unsafeTavern = (text) => JSON.parse(text).qa.map((e) => e.user.length + e.assistant.length)
  const unsafeJsonl = (text) => text.split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => JSON.parse(l).mes.length)
  const rawCrashes = [
    ['非法 JSON', () => unsafeTavern(badTavernInvalidJson)],
    ['qa 非数组', () => unsafeTavern(badTavernQaNotArray)],
    ['qa[i].user 缺失', () => unsafeTavern(badTavernUserMissing)],
    ['jsonl 坏行', () => unsafeJsonl(badJsonlMidLine)],
  ].map(([name, fn]) => {
    let crashed = false
    try { fn() } catch { crashed = true }
    return { name, crashed }
  })
  check('4 反证：摘掉守卫后 4 个畸形输入全崩（裸 JSON.parse / 裸 .map）', rawCrashes.every((c) => c.crashed), JSON.stringify(rawCrashes))
  console.log(`INFO 反证明细：${rawCrashes.map((c) => c.name + '=' + (c.crashed ? '崩' : '没崩')).join('，')}`)
}

// ---- 5) 上限 ----
{
  const tooMany = (() => { try { normalizeImport(JSONL_TEXT, { maxTurns: 3 }); return null } catch (e) { return e } })()
  check('5a maxTurns=3 喂 5 行 ⇒ IMPORT_TOO_MANY_TURNS', tooMany !== null && tooMany.code === 'IMPORT_TOO_MANY_TURNS', String(tooMany && tooMany.code))
  const big = 'x'.repeat(4096)
  const tooLarge = (() => { try { normalizeImport(big, { maxBytes: 10 }); return null } catch (e) { return e } })()
  check('5b maxBytes=10 喂大文本 ⇒ IMPORT_TOO_LARGE（先查大小再 parse）', tooLarge !== null && tooLarge.code === 'IMPORT_TOO_LARGE', String(tooLarge && tooLarge.code))
  const tavernTooMany = (() => { try { normalizeImport(TAVERN_TEXT, { maxTurns: 3 }); return null } catch (e) { return e } })()
  check('5c tavern maxTurns=3 喂 qa[2]（=4 轮）⇒ IMPORT_TOO_MANY_TURNS', tavernTooMany !== null && tavernTooMany.code === 'IMPORT_TOO_MANY_TURNS', String(tavernTooMany && tavernTooMany.code))
  const proseErr = (() => { try { normalizeImport(PROSE); return null } catch (e) { return e } })()
  check('5d 散文走 normalizeImport ⇒ IMPORT_INVALID', proseErr !== null && proseErr.code === 'IMPORT_INVALID', String(proseErr && proseErr.code))
}

// ---- 6) sourceHash + 反证 ----
{
  const a = normalizeImport(JSONL_TEXT).sourceHash
  const b = normalizeImport(JSONL_TEXT).sourceHash
  const flipped = normalizeImport(JSONL_TEXT.replace(mk('甲'), mk('甲') + '!')).sourceHash
  const independent = createHash('sha256').update(JSONL_TEXT, 'utf8').digest('hex')
  check('6a 同文本两次 hash 相同', a === b)
  check('6b 改一字节 ⇒ hash 变', a !== flipped)
  check('6c hash 是 64 位 hex', /^[0-9a-f]{64}$/.test(a))
  check('6d 反证：hash 与独立 node:crypto 的 sha256 逐字相等（常量桩必红）', a === independent, a.slice(0, 12) + ' vs ' + independent.slice(0, 12))
}

// ---- 7) ⛔ 零写入 + 计划器行为 ----
const TARGET = { characterId: 'selftestchar0001', playthroughId: 'playthrough-selftest0001' }
function fakeTavern({ floors = null, files = {} } = {}) {
  const calls = { list: 0, read: 0, write: 0, mkdir: 0 }
  return {
    calls,
    async list(rel) {
      calls.list++
      if (floors && rel === floors.rel) return { ok: true, list: floors.names.map((n) => ({ path: rel + '/' + n, type: 'file' })) }
      return { ok: false }
    },
    async read(rel) {
      calls.read++
      if (Object.prototype.hasOwnProperty.call(files, rel)) return { ok: true, text: files[rel] }
      return { ok: false }
    },
    async write() { calls.write++; throw new Error('ZERO_WRITE_GUARD') },
    async mkdir() { calls.mkdir++; throw new Error('ZERO_WRITE_GUARD') },
  }
}
// ★ 路径口径：与 A1（collect.js 的 catalogTarget）一致 = characterId + '/' + playthroughId 逐字。
//   真机 playthroughId 自带 `playthrough-` 前缀（目录名），所以这里**不再**额外拼前缀。
//   下面 7s 就是钉这条的反证：以前模块多拼一次，测试也跟着多拼一次，于是两边一起错。
const ARCHIVE_REL = TARGET.characterId + '/' + TARGET.playthroughId + '/archive'
const floorsRel = ARCHIVE_REL + '/floors'
const hash8 = normalizeImport(JSONL_TEXT).sourceHash.slice(0, 8)
{
  const ft = fakeTavern({ floors: { rel: floorsRel, names: [] } })
  const plan = await planImport({ source: { text: JSONL_TEXT }, target: TARGET }, { tavern: ft })
  check('7s 路径口径 = characterId/playthroughId 逐字（⛔ 不许出现 playthrough-playthrough-）',
    plan.willWrite.every((w) => w.path.startsWith(ARCHIVE_REL + '/')) && !plan.willWrite.some((w) => w.path.includes('playthrough-playthrough-')),
    plan.willWrite[0].path)
}
{
  const ft = fakeTavern({ floors: { rel: floorsRel, names: ['0000.json', '0001.json', '0005.json'] } })
  const plan = await planImport({ source: { text: JSONL_TEXT }, target: TARGET }, { tavern: ft })
  check('7a plan ok 且 planId=import-<hash8>', plan.ok === true && plan.planId === 'import-' + hash8, JSON.stringify(plan.planId))
  check('7b 楼号从现存最大(0005)+1=0006 起', plan.willWrite.length === 6 && plan.willWrite[0].path === floorsRel + '/0006.json' && plan.willWrite[4].path === floorsRel + '/0010.json', JSON.stringify(plan.willWrite.map((w) => w.path)))
  check('7c 末条是批次摘要 summaries/import-<hash8>.md', plan.willWrite[5].path.endsWith('/archive/summaries/import-' + hash8 + '.md'), plan.willWrite[5].path)
  check('7d willWrite 每条只有 path/bytes/sha256（无正文）', plan.willWrite.every((w) => JSON.stringify(Object.keys(w)) === JSON.stringify(['path', 'bytes', 'sha256']) && w.bytes > 0 && /^[0-9a-f]{64}$/.test(w.sha256)))
  check('7e ★ 零写入：write 与 mkdir 调用次数都是 0', ft.calls.write === 0 && ft.calls.mkdir === 0, JSON.stringify(ft.calls))
  check('7f list/read 被用过（IO 只走注入面）', ft.calls.list >= 1 && ft.calls.read >= 1, JSON.stringify(ft.calls))
  check('7g firstTurnPreview 只有 role/chars，无正文', JSON.stringify(Object.keys(plan.firstTurnPreview)) === JSON.stringify(['role', 'chars']) && plan.firstTurnPreview.chars === M[0].length, JSON.stringify(plan.firstTurnPreview))
  check('7h stats：turns=5 hidden=2 visible=3 greeting=false', plan.stats.turns === 5 && plan.stats.hidden === 2 && plan.stats.visible === 3 && plan.stats.greeting === false, JSON.stringify(plan.stats))
  check('7i warnings 不含正文（只有判定词与路径）', Array.isArray(plan.warnings) && plan.warnings.every((w) => typeof w === 'string'))
}
{
  const ft = fakeTavern({ floors: null }) // 目录不存在
  const plan = await planImport({ source: { text: JSONL_TEXT }, target: TARGET }, { tavern: ft })
  check('7j floors 目录不存在 ⇒ 从 0000 起 + FROM_ZERO warning，不抛', plan.ok === true && plan.willWrite[0].path.endsWith('/floors/0000.json') && plan.warnings.some((w) => w.startsWith('IMPORT_FLOORS_FROM_ZERO')), JSON.stringify(plan.warnings))
}
{
  const summaryRel = ARCHIVE_REL + '/summaries/import-' + hash8 + '.md'
  const ft = fakeTavern({ floors: { rel: floorsRel, names: [] }, files: { [summaryRel]: '# 旧批次占位（合成）' } })
  const plan = await planImport({ source: { text: JSONL_TEXT }, target: TARGET }, { tavern: ft })
  check('7k 同哈希批次已存在 ⇒ IMPORT_BATCH_EXISTS warning', plan.warnings.some((w) => w.startsWith('IMPORT_BATCH_EXISTS')), JSON.stringify(plan.warnings))
}
{
  const ft = fakeTavern({ floors: { rel: floorsRel, names: ['0009.json'] } })
  const plan = await planImport({ source: { text: JSONL_TEXT }, target: TARGET, keepHidden: false }, { tavern: ft })
  check('7l keepHidden=false ⇒ 弃 2 隐藏楼、3 楼照排（00010 起于 0009+1）', plan.willWrite.length === 4 && plan.willWrite[0].path.endsWith('/floors/0010.json'), JSON.stringify(plan.willWrite.map((w) => w.path)))
  check('7m 有 IMPORT_HIDDEN_DROPPED warning', plan.warnings.some((w) => w.startsWith('IMPORT_HIDDEN_DROPPED')), JSON.stringify(plan.warnings))
}
{
  const ft = fakeTavern({ floors: { rel: floorsRel, names: [] } })
  const plan = await planImport({ source: { text: TAVERN_TEXT }, target: TARGET }, { tavern: ft })
  check('7n tavern 计划：4 楼 + 1 摘要，greeting=true', plan.willWrite.length === 5 && plan.stats.turns === 4 && plan.stats.greeting === true, JSON.stringify(plan.stats))
  const ft2 = fakeTavern({ floors: { rel: floorsRel, names: [] } })
  const plan2 = await planImport({ source: { text: TAVERN_TEXT }, target: TARGET, keepGreeting: false }, { tavern: ft2 })
  check('7o keepGreeting=false ⇒ greeting=false + DROPPED warning', plan2.stats.greeting === false && plan2.warnings.some((w) => w.startsWith('IMPORT_GREETING_DROPPED')), JSON.stringify(plan2.warnings))
}
{
  const srcRel = TARGET.characterId + '/imports/selftest-source.jsonl'
  const ft = fakeTavern({ floors: { rel: floorsRel, names: [] }, files: { [srcRel]: JSONL_TEXT } })
  const plan = await planImport({ source: { path: srcRel }, target: TARGET }, { tavern: ft })
  check('7p source.path 走注入 read ⇒ 同一计划（同 hash8）', plan.ok === true && plan.planId === 'import-' + hash8, JSON.stringify(plan.planId))
  const ftBad = fakeTavern({})
  const unreadable = await planImport({ source: { path: 'no/such/file.jsonl' }, target: TARGET }, { tavern: ftBad }).then(() => null, (e) => e)
  check('7q 源读不到 ⇒ IMPORT_SOURCE_UNREADABLE', unreadable !== null && unreadable.code === 'IMPORT_SOURCE_UNREADABLE', String(unreadable && unreadable.code))
  const mismatch = await planImport({ format: 'tavern-import-context', source: { text: JSONL_TEXT }, target: TARGET }, { tavern: fakeTavern({}) }).then(() => null, (e) => e)
  check('7r 声明格式与识别结果不符 ⇒ IMPORT_FORMAT_UNSUPPORTED', mismatch !== null && mismatch.code === 'IMPORT_FORMAT_UNSUPPORTED', String(mismatch && mismatch.code))
}
{
  const bads = [
    ['format 不认识', { format: 'plaintext', source: { text: 'x' }, target: TARGET }],
    ['path 与 text 二选一冲突', { source: { path: 'a', text: 'b' }, target: TARGET }],
    ['两个都没给', { source: {}, target: TARGET }],
    ['绝对路径', { source: { path: 'C:/x.jsonl' }, target: TARGET }],
    ['.. 穿越', { source: { path: 'a/../b.jsonl' }, target: TARGET }],
    ['characterId 穿越', { source: { text: PROSE }, target: { characterId: '../evil', playthroughId: 'p1' } }],
    ['keepGreeting 非 boolean', { source: { text: PROSE }, target: TARGET, keepGreeting: 'yes' }],
    ['顶层不是对象', 'not-an-object'],
  ]
  let allBad = true
  for (const [name, input] of bads) {
    const v = validateImportInput(input)
    if (!(v.ok === false && v.code === 'IMPORT_INVALID')) { allBad = false; console.log('INFO 7s 明细：' + name + ' ⇒ ' + JSON.stringify(v)) }
  }
  check('7s validateImportInput：8 种坏入参全部 IMPORT_INVALID 拒绝', allBad)
  const v = validateImportInput({ source: { text: 'x' }, target: TARGET })
  check('7t 缺省值：format=auto、keepGreeting/keepHidden=true', v.ok === true && v.value.format === 'auto' && v.value.keepGreeting === true && v.value.keepHidden === true, JSON.stringify(v.value))
  check('7u importConstants 冻结且两种格式在册', Object.isFrozen(importConstants) && Object.isFrozen(importConstants.formats) && JSON.stringify(importConstants.formats) === JSON.stringify(IMPORT_FORMATS.map((f) => f.id)))
  check('7v maxBytes=8MiB / maxTurns=5000', importConstants.maxBytes === 8 * 1024 * 1024 && importConstants.maxTurns === 5000)
}

// ---- 7w~7z2 楼层内容形状：Tavern 真机 5 键（恰等断言 + 多键反证 + 哈希对账） ----
{
  // ★ 默认 sort 是码元序：'_'(0x5F) < 'u'，is_system 排在 is_user 前 —— 两边都过 .sort() 才是集合恰等
  const FLOOR_KEYS = ['_floor', 'is_user', 'is_system', 'mes', 'name'].sort()
  const body = imp.floorBodyText(6, { role: 'user', text: 'SELFTEST_MES_X', hidden: true, name: 'SELFTEST_NM_X' })
  const obj = JSON.parse(body)
  const keys = Object.keys(obj).sort()
  check('7w ★ 楼层内容键集合 Object.keys().sort() 恰为 5 键（多/少一键必红）',
    JSON.stringify(keys) === JSON.stringify(FLOOR_KEYS), JSON.stringify(keys))
  check('7x 5 键取值映射：_floor/is_user/is_system/mes/name', obj._floor === 6 && obj.is_user === true && obj.is_system === true && obj.mes === 'SELFTEST_MES_X' && obj.name === 'SELFTEST_NM_X', JSON.stringify([obj._floor, obj.is_user, obj.is_system, obj.mes === 'SELFTEST_MES_X', obj.name]))
  const noName = JSON.parse(imp.floorBodyText(0, { role: 'assistant', text: 'SELFTEST_MES_X', hidden: false }))
  check('7y name 缺失 ⇒ 写空串（不塞别的）；role/hidden 落成 is_user/is_system', noName.name === '' && noName.is_user === false && noName.is_system === false)
  const extra = JSON.parse(body)
  extra.zz_extra = 1
  check('7z 反证：多塞一个键 ⇒ 键集合 ≠ 5 键（断言必红，非橡皮图章）',
    JSON.stringify(Object.keys(extra).sort()) !== JSON.stringify(FLOOR_KEYS), JSON.stringify(Object.keys(extra).sort()))
  // 哈希对账：willWrite 每条楼层 sha256/bytes 都等于 floorBodyText 重建值 ⇒ 计划里的楼真是这 5 键形状
  const turns = normalizeImport(JSONL_TEXT).turns
  const ft = fakeTavern({ floors: { rel: floorsRel, names: [] } })
  const plan = await planImport({ source: { text: JSONL_TEXT }, target: TARGET }, { tavern: ft })
  const rebuilt = turns.map((t, i) => imp.floorBodyText(i, t))
  const tie = rebuilt.every((b, i) =>
    createHash('sha256').update(b, 'utf8').digest('hex') === plan.willWrite[i].sha256
    && Buffer.byteLength(b, 'utf8') === plan.willWrite[i].bytes)
  check('7z2 willWrite 楼层 sha256/bytes 与 floorBodyText 重建值逐条相等（内容即 5 键形状）',
    plan.willWrite.length === rebuilt.length + 1 && tie)
}

// ---- 8) 隐私自证：合成正文前 12 字在输出与两个源文件里零命中 ----
{
  const needles = [...M, U1, A1, U2, A2, GREET].map((t) => t.slice(0, 12))
  const outText = OUT.join('\n')
  const srcModule = readFileSync(SRC_MODULE, 'utf8')
  const srcSelftest = readFileSync(SRC_SELFTEST, 'utf8')
  const hits = []
  for (const nd of needles) {
    if (outText.includes(nd)) hits.push('输出含 ' + JSON.stringify(nd))
    if (srcModule.includes(nd)) hits.push('import-formats.js 含 ' + JSON.stringify(nd))
    if (srcSelftest.includes(nd)) hits.push('_selftest-import.mjs 含 ' + JSON.stringify(nd))
  }
  check('8 ★ 隐私自证：8 句合成正文的前 12 字在 自检输出/模块/自检台 三处零命中', hits.length === 0, hits.join('；'))
  console.log('INFO 隐私口径：needle 只取前 12 字且只比对命中与否，needle 本身不打印')
}

// ---- 收尾 ----
console.log(failures === 0 ? 'ALL PASS (_selftest-import)' : `FAILED: ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
