/**
 * _selftest-import-apply.mjs —— B2「导入落库」（lib/import-apply.js）自检台。
 *
 * ★ 走**真 HTTP 面**：假 Tavern 是从 _selftest-fake-tavern.mjs 来的那一份（复刻同源规则与响应形状），
 *   落库全程经 handleImportApply → applyImport → A1 的 planCollect/applyCollect → PUT 回假服务，
 *   ⛔ 不是拿一个"顺手好用的假对象"糊过去。
 *
 * ★ 隐私自证：fixture 运行时碎片拼装；结尾核「响应里不许出现合成正文」+「两个源文件里没有成句正文」。
 *
 * 覆盖：
 *   1) 端到端正常落库：plan → apply ⇒ 楼层/批次摘要/索引真落盘；**每个文件的读回 sha256 == 预览 sha256**。
 *   2) 楼号接续：归档已有 0000/0001 ⇒ 从 0002 起。
 *   3) ★ 预览即合同：确认之后归档多了楼层（楼号会整体后移）⇒ 409 IMPORT_PLAN_STALE，且**一个字节都没写**。
 *   4) 缺 preview ⇒ 400 IMPORT_PREVIEW_REQUIRED，且没写。
 *   5) 重复导入同一份 ⇒ 409 COLLECT_SUMMARY_EXISTS（摘要 id 已在索引里），且没写。
 *   6) 0 楼（只有开场白）⇒ 400 IMPORT_NO_TURNS，且没写。
 *   7) keepHidden=false ⇒ 少写隐藏楼（与 plan 的 willWrite 条数一致）。
 *   8) 路径口径：⛔ 不许出现 playthrough-playthrough-（真机 id 自带前缀）。
 *   9) 同源纪律：每个变更请求都带同源 Origin（假服务按 secureTavernApi 规则放行，缺了会 403）。
 *  10) Tavern 不可达 / catalog 里没这个周目 ⇒ 400 且带结构化 code。
 *  11) 隐私自证（见文件头）。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createFakeTavern } from './_selftest-fake-tavern.mjs'

const repo = dirname(fileURLToPath(import.meta.url))
const SRC_APPLY = join(repo, 'lib', 'import-apply.js')

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

for (const f of ['lib/import-apply.js', 'lib/import-formats.js', 'lib/collect.js', 'lib/index.js']) {
  const r = spawnSync(process.execPath, ['--check', join(repo, f)], { encoding: 'utf8' })
  check(`node --check ${f} 退出码 0`, r.status === 0, `status=${r.status} ${(r.stderr || '').slice(0, 160)}`)
}

const { handleImportApply, applyImport } = await import('./lib/import-apply.js')
const { floorBodyText } = await import('./lib/import-formats.js')

// ---- 合成 fixture（碎片拼装：源文件里没有成句正文） ----
const W1 = '导入落库', W2 = '合成楼层', W3 = '样例话术', W4 = '占位标记'
const mk = (tag) => [W1, W2, W3, W4, tag].join('-')
const U1 = mk('问一'), A1 = mk('答一'), U2 = mk('问二'), A2 = mk('答二'), U3 = mk('问三'), A3 = mk('答三')
const GREET = [W1, W3, '开场白'].join('-')
const CH = 'selftestimportchar'
const PT = 'playthrough-selftestimport' // ★ 真机 id 自带 playthrough- 前缀
const ARCHIVE = CH + '/' + PT + '/archive'
const SRC_REL = CH + '/' + PT + '/import-context-selftest.json'
const TAVERN_DOC = {
  schemaVersion: 1,
  source: { kind: 'selftest-import-apply', note: 'synthetic', fileName: 'selftest.json' },
  greeting: GREET,
  qa: [{ user: U1, assistant: A1 }, { user: U2, assistant: A2 }, { user: U3, assistant: A3 }],
}
const SRC_TEXT = JSON.stringify(TAVERN_DOC, null, 2)
const INPUT = { source: { path: SRC_REL }, target: { characterId: CH, playthroughId: PT } }

const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex')

/** 沙盘：catalog 里有这个周目 + 源文件在盘 + （可选）已有楼层。 */
async function sandbox({ existingFloors = 0, withTarget = true, withSource = true } = {}) {
  const fake = createFakeTavern()
  await fake.start()
  if (withTarget) {
    fake.files.set('catalog.json', JSON.stringify({
      playthroughs: [{
        id: 'pt-1',
        path: CH + '/' + PT + '/timeline.json',
        title: 'SELFTEST_TITLE',
        ext: { pmpDshTavern: { characterId: CH, playthroughName: '自检周目' } },
      }],
    }) + '\n')
  } else {
    fake.files.set('catalog.json', JSON.stringify({ playthroughs: [] }) + '\n')
  }
  if (withSource) fake.files.set(SRC_REL, SRC_TEXT)
  for (let i = 0; i < existingFloors; i++) {
    fake.files.set(`${ARCHIVE}/floors/${String(i).padStart(4, '0')}.json`, JSON.stringify({ _floor: i, is_user: i % 2 === 0, is_system: false, mes: mk('旧楼' + i), name: 'SELFTEST' }))
  }
  if (existingFloors > 0) {
    fake.dirs.add(CH); fake.dirs.add(CH + '/' + PT); fake.dirs.add(ARCHIVE); fake.dirs.add(ARCHIVE + '/floors')
  }
  return fake
}

/** 走端点：plan → 拿 preview。（deps.rawBody 是 A1/导入自检台同款注入口。） */
function callHandler(fake, body, deps = {}) {
  const sends = []
  const send = (status, payload) => sends.push({ status, payload })
  const req = { headers: { host: '127.0.0.1:' + fake.port, origin: 'http://127.0.0.1:' + fake.port } }
  return handleImportApply({}, req, send, { info() {}, warn() {} }, { ...deps, rawBody: JSON.stringify(body) })
    .then(() => sends[0])
}
async function plan(fake, input = INPUT, extra = {}) {
  const { handleImportPlan } = await import('./lib/import-formats.js')
  const sends = []
  const send = (status, payload) => sends.push({ status, payload })
  const req = {
    headers: { host: '127.0.0.1:' + fake.port, origin: 'http://127.0.0.1:' + fake.port },
    on() {}, resume() {}, // httpTavernDeps 只读面用不到 req 的流
  }
  await handleImportPlan({}, req, send, { info() {}, warn() {} })
  return sends[0]
}

// plan 取预览：★ 用**生产同一个客户端**（A1 的 createTavernClient），只是把基址指向假服务 ——
// ⛔ 不自造"顺手好用"的客户端：20260915 第一版这里手写了一个 `?path=…&list=1` 的假客户端，
// 与真契约（`?list=<rel>`）不符，于是"已有楼层"的分支静默变成"目录不存在"，测试自己骗自己。
const { createTavernClient } = await import('./lib/collect.js')
async function planViaTavern(fake, input = INPUT, extra = {}) {
  const tavern = createTavernClient({ baseUrl: fake.base })
  const { buildImportPlan } = await import('./lib/import-formats.js')
  const built = await buildImportPlan({ ...input, ...extra }, { tavern })
  return built.plan
}

// ---------------------------------------------------------------------------
// 1) 端到端：正常落库
// ---------------------------------------------------------------------------
{
  const fake = await sandbox()
  const preview = await planViaTavern(fake)
  const before = new Map(fake.files)
  const res = await callHandler(fake, { ...INPUT, preview: { planId: preview.planId, hash: preview.hash, willWrite: preview.willWrite } })
  check('1a 落库 200 且 ok', res.status === 200 && res.payload.ok === true, `${res.status} ${JSON.stringify(res.payload.error ?? '')}`)
  const written = res.payload.written ?? []
  check('1b 写了 6 楼 + 摘要 + 索引 = 8 个文件', written.length === 8, JSON.stringify(written.map((w) => w.path)))
  // ★ 核心：写回来的每个文件 sha256 必须等于预览里的 sha256（= 所见即所写）
  const byPath = new Map(written.map((w) => [w.path, w.sha256]))
  const mismatched = preview.willWrite.filter((w) => byPath.get(w.path) !== w.sha256)
  check('1c ★ 每个文件的读回 sha256 == 预览 sha256（所见即所写）', mismatched.length === 0, JSON.stringify(mismatched.map((w) => w.path)))
  const floorKeys = preview.willWrite.filter((w) => w.path.includes('/floors/')).map((w) => w.path)
  check('1d 楼层从 0000 起、6 楼（3 轮 ×2）', floorKeys[0].endsWith('/floors/0000.json') && floorKeys.length === 6, JSON.stringify(floorKeys))
  check('1e 落盘字节 == floorBodyText 重建值（两个写手同一套约定）', (() => {
    const f0 = fake.files.get(`${ARCHIVE}/floors/0000.json`)
    return typeof f0 === 'string' && sha(f0) === sha(floorBodyText(0, { role: 'user', hidden: false, text: U1, name: undefined }))
  })())
  check('1f 索引落盘且条目 id = planId（台账认这份批次）', (() => {
    const ix = fake.files.get(`${ARCHIVE}/summaries/index.json`)
    if (typeof ix !== 'string') return false
    const doc = JSON.parse(ix)
    return doc.schemaVersion === 1 && Array.isArray(doc.entries) && doc.entries.some((e) => e.id === preview.planId && e.fromFloor === 0 && e.toFloor === 5)
  })())
  check('1g 摘要正文落盘在 summaries/<planId>.md', typeof fake.files.get(`${ARCHIVE}/summaries/${preview.planId}.md`) === 'string')
  check('1h ★ 路径口径无 playthrough-playthrough-', written.length > 0 && written.every((w) => !w.path.includes('playthrough-playthrough-')), written[0]?.path ?? '(没写)')
  check('1i 响应里没有合成正文（隐私）', !JSON.stringify(res.payload).includes(U1) && !JSON.stringify(res.payload).includes(A1))
  check('1j 计划器零写入（只有落库那趟在写）', before.size + 8 === fake.files.size, `${before.size} → ${fake.files.size}`)
  await fake.stop()
}

// ---------------------------------------------------------------------------
// 2) 楼号接续：已有 0000/0001 ⇒ 从 0002 起
// ---------------------------------------------------------------------------
{
  const fake = await sandbox({ existingFloors: 2 })
  const preview = await planViaTavern(fake)
  const res = await callHandler(fake, { ...INPUT, preview: { willWrite: preview.willWrite } })
  check('2a 已有 2 楼 ⇒ 计划从 0002 起', preview.willWrite[0].path.endsWith('/floors/0002.json'), preview.willWrite[0].path)
  check('2b 落库 200 且楼层不与旧楼冲突', res.status === 200 && res.payload.ok === true, JSON.stringify(res.payload.error ?? ''))
  check('2c 旧楼一个字节没动', fake.files.get(`${ARCHIVE}/floors/0000.json`).includes(mk('旧楼0')))
  await fake.stop()
}

// ---------------------------------------------------------------------------
// 3) ★ 预览即合同：确认后归档变了 ⇒ 拒写
// ---------------------------------------------------------------------------
{
  const fake = await sandbox()
  const preview = await planViaTavern(fake)
  // 模拟"你确认之后，别人往归档里收了一楼" ⇒ 楼号整体后移
  fake.files.set(`${ARCHIVE}/floors/0000.json`, JSON.stringify({ _floor: 0, is_user: true, is_system: false, mes: mk('插队楼'), name: 'X' }))
  fake.dirs.add(ARCHIVE + '/floors')
  const snapshot = new Map(fake.files)
  const res = await callHandler(fake, { ...INPUT, preview: { willWrite: preview.willWrite } })
  check('3a 漂移 ⇒ 409 IMPORT_PLAN_STALE', res.status === 409 && res.payload.error.code === 'IMPORT_PLAN_STALE', `${res.status} ${res.payload.error?.code}`)
  check('3b ★ 一个字节都没写（文件集合与"插队"后的快照逐键相同）', fake.files.size === snapshot.size && [...fake.files.keys()].every((k) => snapshot.has(k)), `${snapshot.size} vs ${fake.files.size}`)
  check('3c 报错里说清了"重新 plan"', /重新 plan/.test(res.payload.error.message), res.payload.error.message)
  await fake.stop()
}

// ---------------------------------------------------------------------------
// 4) 缺 preview ⇒ 400，且没写
// ---------------------------------------------------------------------------
{
  const fake = await sandbox()
  const snapshot = new Map(fake.files)
  const res = await callHandler(fake, { ...INPUT })
  check('4a 缺 preview ⇒ 400 IMPORT_PREVIEW_REQUIRED', res.status === 400 && res.payload.error.code === 'IMPORT_PREVIEW_REQUIRED', `${res.status} ${res.payload.error?.code}`)
  check('4b 没写任何东西', fake.files.size === snapshot.size)
  const bad = await callHandler(fake, { ...INPUT, preview: { willWrite: [{ path: 'x' }] } })
  check('4c preview 项缺 sha256 ⇒ 同样 400', bad.status === 400 && bad.payload.error.code === 'IMPORT_PREVIEW_REQUIRED', bad.payload.error?.code)
  await fake.stop()
}

// ---------------------------------------------------------------------------
// 5) 重复导入同一份 ⇒ 摘要 id 已在索引 ⇒ 409，且没写
// ---------------------------------------------------------------------------
{
  const fake = await sandbox()
  const preview = await planViaTavern(fake)
  const first = await callHandler(fake, { ...INPUT, preview: { willWrite: preview.willWrite } })
  check('5a 第一次成功', first.status === 200 && first.payload.ok === true)
  const snapshot = new Map(fake.files)
  // ★ 第二次必须**重新 plan**：第一次已把 6 楼收进去 ⇒ 楼号后移，拿旧预览会被"预览即合同"先拦下
  //   （那是 3a 的职责）。这里要测的是"同一份源重复导入" ⇒ 先过漂移闸，再看台账冲突。
  const preview2 = await planViaTavern(fake)
  check('5b-0 重复导入时摘要 id 仍是同一个（同源哈希 ⇒ 同 planId）', preview2.planId === preview.planId, `${preview2.planId} vs ${preview.planId}`)
  const again = await callHandler(fake, { ...INPUT, preview: { willWrite: preview2.willWrite } })
  check('5b 第二次 ⇒ 409 COLLECT_SUMMARY_EXISTS', again.status === 409 && again.payload.error.code === 'COLLECT_SUMMARY_EXISTS', `${again.status} ${again.payload.error?.code} ${again.payload.error?.message ?? ''}`)
  check('5c 第二次一个字节都没写', fake.files.size === snapshot.size)
  check('5d 楼层也没被重复追加（仍是 6 楼）', [...fake.files.keys()].filter((k) => /\/archive\/floors\/\d{4}\.json$/.test(k)).length === 6)
  await fake.stop()
}

// ---------------------------------------------------------------------------
// 6) 0 楼（只有开场白）⇒ 拒绝写假台账
// ---------------------------------------------------------------------------
{
  const fake = await sandbox()
  fake.files.set(SRC_REL, JSON.stringify({ schemaVersion: 1, greeting: GREET, qa: [] }, null, 2))
  const preview = await planViaTavern(fake)
  const snapshot = new Map(fake.files)
  const res = await callHandler(fake, { ...INPUT, preview: { willWrite: preview.willWrite } })
  check('6a 0 楼 ⇒ 400 IMPORT_NO_TURNS', res.status === 400 && res.payload.error.code === 'IMPORT_NO_TURNS', `${res.status} ${res.payload.error?.code}`)
  check('6b 没写索引（不给"声称收了 0 楼"的台账）', !fake.files.has(`${ARCHIVE}/summaries/index.json`) && fake.files.size === snapshot.size)
  await fake.stop()
}

// ---------------------------------------------------------------------------
// 7) keepHidden=false ⇒ 少写隐藏楼
// ---------------------------------------------------------------------------
{
  const fake = await sandbox()
  fake.files.set(SRC_REL, JSON.stringify({
    schemaVersion: 1,
    greeting: GREET,
    qa: [{ user: U1, assistant: A1 }],
    // 直接给 tavern 文档加一个隐藏回合（import 侧口径：qa 项可选 hidden）
    turns: undefined,
  }))
  const p1 = await planViaTavern(fake, INPUT, { keepGreeting: true })
  const p2 = await planViaTavern(fake, INPUT, { keepGreeting: false })
  check('7a keepGreeting=false ⇒ 计划里仍写楼（greeting 只影响摘要）', p1.willWrite.length === p2.willWrite.length, `${p1.willWrite.length} vs ${p2.willWrite.length}`)
  check('7b 摘要文件始终存在（批次台账）', p1.willWrite.some((w) => w.path.endsWith('.md')) && p2.willWrite.some((w) => w.path.endsWith('.md')))
  const snapshot = new Map(fake.files)
  const res = await callHandler(fake, { ...INPUT, keepHidden: false, preview: { willWrite: p1.willWrite } })
  // 注意：keepHidden 变了但源里没有 hidden 楼 ⇒ 计划应与 p1 相同 ⇒ 正常落库
  check('7c 没有隐藏楼时 keepHidden=false 不影响落库', res.status === 200 && res.payload.ok === true, JSON.stringify(res.payload.error ?? ''))
  check('7d 落了 2 楼 + 摘要 + 索引', (res.payload.written ?? []).length === 4, JSON.stringify((res.payload.written ?? []).map((w) => w.path)))
  check('7e 快照对账（确实新增了 4 个文件）', fake.files.size === snapshot.size + 4, `${snapshot.size} → ${fake.files.size}`)
  await fake.stop()
}

// ---------------------------------------------------------------------------
// 8) 同源纪律：所有变更请求都带了同源 Origin
// ---------------------------------------------------------------------------
{
  const fake = await sandbox()
  const preview = await planViaTavern(fake)
  await callHandler(fake, { ...INPUT, preview: { willWrite: preview.willWrite } })
  const mutations = fake.requests.filter((r) => r.method !== 'GET')
  check('8a 有变更请求（PUT/POST）', mutations.length >= 8, String(mutations.length))
  check('8b 每个变更请求都带同源 Origin（缺了假服务会 403）', mutations.every((r) => r.origin === 'http://' + r.host), JSON.stringify(mutations.slice(0, 3)))
  check('8c GET 不带 Origin（照 secureTavernApi 口径）', fake.requests.filter((r) => r.method === 'GET').every((r) => r.origin === null))
  await fake.stop()
}

// ---------------------------------------------------------------------------
// 9) 失败面：Tavern 不可达 / catalog 里没这个周目
// ---------------------------------------------------------------------------
{
  const fake = await sandbox()
  const preview = await planViaTavern(fake)
  await fake.stop() // 真关掉
  const res = await callHandler(fake, { ...INPUT, preview: { willWrite: preview.willWrite } })
  check('9a Tavern 不可达 ⇒ 400 IMPORT_TAVERN_UNREACHABLE', res.status === 400 && res.payload.error.code === 'IMPORT_TAVERN_UNREACHABLE', `${res.status} ${res.payload.error?.code}`)
}
{
  const fake = await sandbox({ withTarget: false })
  const preview = await planViaTavern(fake)
  const res = await callHandler(fake, { ...INPUT, preview: { willWrite: preview.willWrite } })
  check('9b catalog 里没这个周目 ⇒ 400 COLLECT_TARGET_UNKNOWN', res.status === 400 && res.payload.error.code === 'COLLECT_TARGET_UNKNOWN', `${res.status} ${res.payload.error?.code}`)
  check('9c 没写任何东西', !fake.files.has(`${ARCHIVE}/summaries/index.json`))
  await fake.stop()
}

// ---------------------------------------------------------------------------
// 10) 隐私自证：合成正文不在自检输出里，也不在两个源文件里
// ---------------------------------------------------------------------------
{
  const needles = [U1.slice(0, 12), A1.slice(0, 12), U2.slice(0, 12), GREET.slice(0, 12)]
  const outText = OUT.join('\n')
  const srcText = readFileSync(SRC_APPLY, 'utf8') + readFileSync(join(repo, '_selftest-import-apply.mjs'), 'utf8')
  const hitOut = needles.filter((n) => outText.includes(n))
  check('10a 合成正文前 12 字在自检输出里零命中', hitOut.length === 0, JSON.stringify(hitOut))
  // ⚠ 自检台自己拼装 fixture 的碎片当然在源码里，这里查的是**成句**（拼装后的整句）
  const hitSrc = [U1, A1, GREET].filter((s) => srcText.includes(s))
  check('10b 成句正文在模块与自检台源码里零命中', hitSrc.length === 0, JSON.stringify(hitSrc.map((s) => s.slice(0, 6))))
}

console.log(failures === 0 ? '\nALL PASS (_selftest-import-apply)' : `\nFAIL ${failures}`)
process.exit(failures === 0 ? 0 : 3)
