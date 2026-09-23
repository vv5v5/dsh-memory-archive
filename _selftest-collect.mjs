/**
 * _selftest-collect —— 周目归档写入器（lib/collect.js）行为级自检台
 *
 * 用法：
 *   node _selftest-collect.mjs                 # 全量断言表（全绿才算过）
 *   MUTATE=4|5|6|7|8 node _selftest-collect.mjs  # 反证：给 lib/collect.js 打一个突变，
 *                                              # 对应断言必须【变红】才算反证成立
 *
 * 台子结构：起一个假 Tavern（node:http 绑 127.0.0.1:0，内存文件树，响应形状照
 * dsh-tavern/packages/play/src/workspace.js），被测 handler 经 tavernBaseFromReq(req)
 * 推基址、用真 fetch 打过来 —— 网络路径是真的；body 经 deps.rawBody 注入（生产路径走 req）。
 *
 * ★ 安全层复刻（A9/A10 的根据）：本假服务【故意】复刻 secureTavernApi
 *   （tavern-loader/src/api-security.js:119-123）的同源规则 —— 变更方法（非
 *   GET/HEAD/OPTIONS）必须带与 Host 同源的 Origin，缺失/跨源一律 403
 *   TAVERN_API_ORIGIN_FORBIDDEN。真实环境里忘了带 Origin 的症状是客户端收到
 *   TAVERN_HTTP_403（已在沙箱 3104 的真 Tavern 上实测），楼层/摘要/索引一个字节都写不下去。
 *
 * 隐私纪律（任务书 §0 / DoD 6）：正文全部运行时拼片（J('L','og ',…)），源文件不存在
 * 任何 12 字连续正文片段；输出只含 路径 / 字节数 / sha256 / 判定词。A8 做零命中自证。
 *
 * @license CC-BY-NC-4.0 (Attribution-NonCommercial 4.0 International)
 */

import { createFakeTavern } from './_selftest-fake-tavern.mjs'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

// ---------------------------------------------------------------------------
// 合成正文工厂：运行时拼片，源码零连续片段
// ---------------------------------------------------------------------------

const J = (...xs) => xs.join('')
const ISO0 = '2026-09-14T00:00:00.000Z'
const synMes = (t, i) => J('L', 'og ', t, ' #', String(i).padStart(2, '0'), ' ') + 'w'.repeat(48)
const synSum = (t, a, b) => J('S', 'ummary ', t, ' fl ', String(a), '-', String(b), '. ') + 'k'.repeat(64)
const synTitle = (t) => J('T', 'itle-', t, '-', String(t.charCodeAt(0)))
const synName = (t) => J('N', 'ame', t.toUpperCase())
const sha = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex')
const pad = (i) => String(i).padStart(4, '0')

const KIND = 'dsh-tavern-l2-summaries'
const WRITER = 'magictarven/collect'
const A = 'chara/playthrough-a'
const B = 'charb/playthrough-b'
const CC = 'charc/playthrough-c'
const idxPathOf = (root) => root + '/archive/summaries/index.json'
const manPathOf = (root) => root + '/archive/manifest.json'
const floorPathOf = (root, i) => root + '/archive/floors/' + pad(i) + '.json'
const mdIdOf = (a, b) => 's-' + pad(a) + '-' + pad(b)

/** 供 A7 重建楼层文本（与 collect.js floorDocText 同键序同口径）。 */
const floorText = (f) =>
  JSON.stringify({ _floor: f.floor, is_user: f.isUser === true, is_system: f.isSystem === true, mes: f.mes, name: typeof f.name === 'string' ? f.name : '' })

// ---------------------------------------------------------------------------
// 突变表（反证用）：每条 from 都必须在 lib/collect.js 里【恰好出现一次】
// ---------------------------------------------------------------------------

const MUTATIONS = [
  { n: 4, assertId: 'A4', label: 'plan 的楼层冲突检查被短路', from: 'if (clashes.length > 0 && !overwrite) {', to: 'if (false && clashes.length > 0 && !overwrite) { // MUT4' },
  { n: 5, assertId: 'A5', label: 'apply 索引写前二读比对被短路', from: 'if (rereadSha !== firstSha) {', to: 'if (false && rereadSha !== firstSha) { // MUT5' },
  { n: 6, assertId: 'A6', label: 'applyCollect 的 TTL 检查被短路', from: 'if (now() - plan.createdAt > collectConstants.planTtlMs) {', to: 'if (false && now() - plan.createdAt > collectConstants.planTtlMs) { // MUT6' },
  { n: 7, assertId: 'A7', label: 'written/readBack 记录被禁言（partial 失真）', from: '    written.push(rec)', to: '    if (false) written.push(rec) // MUT7' },
  {
    n: 8, assertId: 'A9', label: 'A10 反证：变更请求不带同源 Origin ⇒ 假服务按 secureTavernApi 规则 403',
    from: "if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') headers.origin = baseOrigin",
    to: 'if (false) headers.origin = baseOrigin // MUT8',
  },
  // ★ 2026-09-22「摘要按段切片」：挖掉「summary 与 summaries 只能给一个」的守卫 ⇒ 两路并存时会
  //   **静默挑一个**（A16 必红）。这条守卫是本单新加的，正是"不猜"的落点。
  {
    n: 9, assertId: 'A16', label: '两路并存（summary + summaries）的守卫被挖掉 ⇒ 静默挑一个',
    from: '  if (isPlainObject(input.summary)) bad(SUMMARIES_BOTH_MSG)\n',
    to: '  // MUT9：守卫被挖掉\n',
  },
]

const MUTATE = process.env.MUTATE ? Number(process.env.MUTATE) : 0

async function loadCollect() {
  if (!MUTATE) return import('./lib/collect.js')
  const m = MUTATIONS.find((x) => x.n === MUTATE)
  if (!m) {
    console.error('MUTATE=' + MUTATE + ' 不在突变表里（可用：' + MUTATIONS.map((x) => x.n).join(',') + '）')
    process.exit(2)
  }
  const src = await readFile(new URL('./lib/collect.js', import.meta.url), 'utf8')
  const hits = src.split(m.from).length - 1
  if (hits !== 1) {
    console.error('突变锚点不唯一（' + hits + ' 处），反证台自身先红了：' + m.label)
    process.exit(2)
  }
  const mutated = src.replace(m.from, m.to)
  const dataUrl = 'data:text/javascript;base64,' + Buffer.from(mutated, 'utf8').toString('base64')
  return import(dataUrl)
}

/** 造「真结构假正文」沙盘：chara 带完整归档（6 楼/1 摘要/索引/manifest/visibility），charb、charc 无归档。 */
function seed(fake) {
  const f = fake.files
  f.set(
    'catalog.json',
    JSON.stringify({
      playthroughs: [A, B, CC].map((root, i) => ({
        id: 'pt-' + 'abc'[i],
        path: root + '/timeline.json',
        title: synTitle('abc'[i]),
        lastOpenedAt: ISO0,
        ext: { pmpDshTavern: { characterId: root.split('/')[0], characterName: synName('abc'[i]), playthroughNumber: i + 1 } },
      })),
    }) + '\n',
  )
  const mdId = mdIdOf(0, 5)
  const mdText = synSum('a', 0, 5)
  for (let i = 0; i <= 5; i++) {
    f.set(floorPathOf(A, i), JSON.stringify({ _floor: i, is_user: i % 2 === 0, is_system: false, mes: synMes('a', i), name: i % 2 === 0 ? synName('u') : synName('a') }))
  }
  f.set(A + '/archive/summaries/' + mdId + '.md', mdText)
  f.set(
    idxPathOf(A),
    JSON.stringify(
      { schemaVersion: 1, kind: KIND, updatedAt: ISO0, entries: [{ id: mdId, file: mdId + '.md', fromFloor: 0, toFloor: 5, createdAt: ISO0, model: 'fixture-model', sourceHash: sha(mdText), chars: Array.from(mdText).length }] },
      null,
      2,
    ) + '\n',
  )
  f.set(
    manPathOf(A),
    JSON.stringify(
      { schemaVersion: 1, kind: 'dsh-tavern-l2-archive', generatedAt: ISO0, summaries: { dir: 'summaries', index: 'summaries/index.json', count: 1, writer: 'fixture-a' } },
      null,
      2,
    ) + '\n',
  )
  f.set(
    A + '/archive/visibility.json',
    JSON.stringify(
      { schemaVersion: 1, kind: 'dsh-tavern-l2-visibility', note: '', rule: '', floors: Object.fromEntries([...Array(6).keys()].map((i) => [String(i), { sent: true, source: 'st:is_system' }])) },
      null,
      2,
    ) + '\n',
  )
}

// ---------------------------------------------------------------------------
// 断言器与沙盘观察
// ---------------------------------------------------------------------------

const results = []
async function check(id, label, fn) {
  try {
    await fn()
    results.push({ id, label, pass: true, note: '' })
  } catch (e) {
    results.push({ id, label, pass: false, note: String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 200) })
  }
}

const fakeReq = (fake) => ({ headers: { host: '127.0.0.1:' + fake.port }, socket: { localPort: fake.port } })

function captor() {
  const cap = { status: 0, body: null }
  const send = (status, body) => {
    cap.status = status
    cap.body = body
  }
  return { send, cap }
}

function floorsBody(root, tag, from, to, extra = {}) {
  const floors = []
  for (let i = from; i <= to; i++) {
    floors.push({ floor: i, isUser: i % 2 === 0, isSystem: false, mes: synMes(tag, i), name: i % 2 === 0 ? synName('u') : synName(tag) })
  }
  return {
    target: { characterId: root.split('/')[0], playthroughId: root.split('/')[1] },
    range: { fromFloor: from, toFloor: to },
    floors,
    summary: { text: synSum(tag, from, to), model: 'syn-model' },
    ...extra,
  }
}

/** 从假服务盘上读当前归档现状（planCollect 的 observed 口径）。
 *  `summaryPaths`（可选）= 将要写的摘要落点（照生产口径 observeArchive 的第 3 参）：覆盖模式下
 *  它可能**已经存在**，期望值必须取它的真身 sha —— ★ 2026-09-22「摘要按段切片」时 N 份都传进来。 */
function observe(fake, root, floorNos, summaryPaths) {
  const idxText = fake.files.has(idxPathOf(root)) ? fake.files.get(idxPathOf(root)) : null
  const manText = fake.files.has(manPathOf(root)) ? fake.files.get(manPathOf(root)) : null
  const floorShas = new Map()
  for (const i of floorNos) {
    const p = floorPathOf(root, i)
    if (fake.files.has(p)) floorShas.set(i, sha(fake.files.get(p)))
  }
  const summaryShas = new Map()
  for (const p of Array.isArray(summaryPaths) ? summaryPaths : []) {
    summaryShas.set(p, fake.files.has(p) ? sha(fake.files.get(p)) : null)
  }
  return {
    targetKnown: true,
    existingFloors: new Set(floorNos.filter((i) => fake.files.has(floorPathOf(root, i)))),
    floorShas,
    summaryShas,
    index: idxText === null ? { exists: false } : { exists: true, doc: JSON.parse(idxText), sha256: sha(idxText) },
    manifest: manText === null ? { exists: false } : { exists: true, doc: JSON.parse(manText), sha256: sha(manText) },
  }
}

// ---------------------------------------------------------------------------
// 断言本体
// ---------------------------------------------------------------------------

async function runAssertions(C, fake) {
  const ctx0 = {}
  const url0 = new URL('http://fake/magictarven/api/collect/x')
  const req0 = fakeReq(fake)
  const tavern = C.createTavernClient({ baseUrl: fake.base })
  const planViaHandler = async (input, deps = {}) => {
    const { send, cap } = captor()
    await C.handleCollectPlan(ctx0, url0, req0, send, { tavern, rawBody: JSON.stringify(input), ...deps })
    return cap
  }
  const applyViaHandler = async (input, deps = {}) => {
    const { send, cap } = captor()
    await C.handleCollectApply(ctx0, url0, req0, send, { tavern, rawBody: JSON.stringify(input), ...deps })
    return cap
  }

  await check('A0', 'index.js 只新增了 collect 分派行与端点表项（逐字在位）', async () => {
    const wiring = await readFile(new URL('./lib/index.js', import.meta.url), 'utf8')
    for (const rest of ['/collect/targets', '/collect/plan', '/collect/apply']) {
      const dispatch = "if (rest === '" + rest + "') return await import('./collect.js')"
      assert.equal(wiring.split(dispatch).length - 1, 1, '分派行应恰好 1 处：' + rest)
      const entry = "  '" + rest + "': ['" + (rest.endsWith('targets') ? 'GET' : 'POST') + "'],"
      assert.equal(wiring.split(entry).length - 1, 1, 'ENDPOINTS 条目应恰好 1 处：' + rest)
    }
  })

  await check('A1', 'targets 发现周目；无归档 ⇒ hasArchive:false 且不抛', async () => {
    const { send, cap } = captor()
    await C.handleCollectTargets(ctx0, url0, req0, send, { tavern })
    assert.equal(cap.status, 200, 'HTTP ' + cap.status)
    assert.equal(cap.body.ok, true, 'ok=' + cap.body.ok)
    const rows = new Map(cap.body.targets.map((t) => [t.characterId + '/' + t.playthroughId, t]))
    const ta = rows.get(A)
    const tb = rows.get(B)
    assert.ok(ta && tb, 'chara/charb 都应在 targets 里（' + rows.size + ' 个）')
    assert.equal(ta.hasArchive, true, 'chara hasArchive=' + ta.hasArchive)
    assert.equal(ta.floorCount, 6, 'chara floorCount=' + ta.floorCount)
    assert.equal(ta.summaryCount, 1, 'chara summaryCount=' + ta.summaryCount)
    assert.equal(ta.manifestWriter, 'fixture-a', 'chara manifestWriter=' + ta.manifestWriter)
    assert.equal(typeof ta.archiveRel, 'string', 'archiveRel 缺失')
    assert.equal(tb.hasArchive, false, 'charb hasArchive=' + tb.hasArchive)
    assert.equal(tb.floorCount, null, 'charb floorCount=' + tb.floorCount)
    assert.equal(tb.summaryCount, null, 'charb summaryCount=' + tb.summaryCount)
  })

  await check('A2', 'dryRun 不发 planId；plan 的字节/sha256 与 apply 后从假服务读回的逐字一致', async () => {
    // dryRun：planId 必须为空（没存）
    const dryCap = await planViaHandler({ ...floorsBody(B, 'b', 0, 2), dryRun: true })
    assert.equal(dryCap.status, 200, 'dryRun HTTP ' + dryCap.status)
    assert.equal(dryCap.body.ok, true, 'dryRun ok=false')
    assert.equal(dryCap.body.planId, null, 'dryRun 的 planId 应为 null')
    assert.equal(dryCap.body.willWrite.length, 5, 'dryRun willWrite 条数')

    // 真 plan
    const planCap = await planViaHandler(floorsBody(B, 'b', 0, 2))
    assert.equal(planCap.status, 200, 'plan HTTP ' + planCap.status + ' ' + JSON.stringify((planCap.body && planCap.body.error) || '').slice(0, 160))
    assert.equal(planCap.body.ok, true, 'plan ok=false')
    const planId = planCap.body.planId
    assert.equal(typeof planId, 'string', 'planId 应为字符串')
    const willWrite = planCap.body.willWrite
    assert.equal(willWrite.length, 5, 'willWrite 条数 ' + willWrite.length)
    const expectPaths = [0, 1, 2].map((i) => floorPathOf(B, i))
    expectPaths.push(B + '/archive/summaries/' + mdIdOf(0, 2) + '.md', idxPathOf(B))
    assert.deepEqual(willWrite.map((w) => w.path).sort(), expectPaths.slice().sort(), 'willWrite 路径不符')
    assert.ok(Object.values(planCap.body.expectedRevisions).every((v) => v === null), '全新归档 expectedRevisions 应全 null')

    // apply（caller 把 plan 给的 expectedRevisions 原样带回）
    const applyCap = await applyViaHandler({ planId, expectedRevisions: planCap.body.expectedRevisions })
    assert.equal(applyCap.status, 200, 'apply HTTP ' + applyCap.status + ' ' + JSON.stringify((applyCap.body && applyCap.body.error) || '').slice(0, 160))
    assert.equal(applyCap.body.ok, true, 'apply ok=false')
    assert.equal(applyCap.body.written.length, 5, 'written 条数')
    for (const w of willWrite) {
      const r = applyCap.body.readBack.find((x) => x.path === w.path)
      assert.ok(r, 'readBack 缺 ' + w.path)
      assert.equal(r.bytes, w.bytes, 'bytes 不一致 ' + w.path + ': ' + r.bytes + ' vs ' + w.bytes)
      assert.equal(r.sha256, w.sha256, 'sha256 不一致 ' + w.path)
    }
  })

  await check('A3', '索引 entries 长度 +1；schemaVersion/kind 保留；原条目原样；visibility 零触碰', async () => {
    const beforeIdxText = fake.files.get(idxPathOf(A))
    const beforeIdx = JSON.parse(beforeIdxText)
    const visBefore = fake.files.get(A + '/archive/visibility.json')
    const plan = C.planCollect(floorsBody(A, 'a', 6, 8), { observed: observe(fake, A, [0, 1, 2, 3, 4, 5, 6, 7, 8]), now: () => Date.now() })
    const result = await C.applyCollect(plan, { tavern, now: () => Date.now() })
    assert.equal(result.ok, true, 'apply ok=false: ' + JSON.stringify((result && result.error) || '').slice(0, 160))
    const afterIdx = JSON.parse(fake.files.get(idxPathOf(A)))
    assert.equal(afterIdx.schemaVersion, beforeIdx.schemaVersion, 'schemaVersion 变了')
    assert.equal(afterIdx.kind, beforeIdx.kind, 'kind 变了')
    assert.equal(afterIdx.entries.length, beforeIdx.entries.length + 1, 'entries 应 +1：' + afterIdx.entries.length)
    assert.deepEqual(afterIdx.entries.slice(0, beforeIdx.entries.length), beforeIdx.entries, '原条目被动过')
    const ne = afterIdx.entries[afterIdx.entries.length - 1]
    assert.equal(ne.id, mdIdOf(6, 8), '新 entry id=' + ne.id)
    assert.equal(ne.file, mdIdOf(6, 8) + '.md', '新 entry file=' + ne.file)
    assert.equal(ne.fromFloor, 6, 'fromFloor=' + ne.fromFloor)
    assert.equal(ne.toFloor, 8, 'toFloor=' + ne.toFloor)
    assert.equal(ne.model, 'syn-model', 'model=' + ne.model)
    assert.equal(ne.sourceHash, sha(synSum('a', 6, 8)), 'sourceHash 应等于摘要正文 sha256')
    assert.equal(ne.chars, Array.from(synSum('a', 6, 8)).length, 'chars=' + ne.chars)
    const manAfter = JSON.parse(fake.files.get(manPathOf(A)))
    assert.equal(manAfter.summaries.count, afterIdx.entries.length, 'manifest.summaries.count=' + manAfter.summaries.count)
    assert.equal(manAfter.summaries.writer, WRITER, 'manifest.summaries.writer=' + manAfter.summaries.writer)
    assert.equal(fake.files.get(A + '/archive/visibility.json'), visBefore, 'visibility.json 被动过（⛔ 本单不该碰）')
  })

  await check('A4', '楼号已存在 ⇒ COLLECT_FLOOR_CONFLICT；overwrite:true 反证 ⇒ 成功', async () => {
    // A3 之后 0..8 都在盘上；range 5..7 全撞
    let threw = null
    try {
      C.planCollect(floorsBody(A, 'a', 5, 7), { observed: observe(fake, A, [0, 1, 2, 3, 4, 5, 6, 7, 8]), now: () => Date.now() })
    } catch (e) {
      threw = e
    }
    assert.ok(threw, '应抛 COLLECT_FLOOR_CONFLICT')
    assert.equal(threw.code, 'COLLECT_FLOOR_CONFLICT', '实际抛的是 ' + threw.code)

    const old0005 = sha(fake.files.get(floorPathOf(A, 5)))
    // tag 换成 'o'：覆盖进来的内容与盘上旧内容不同，才能证明「真的覆盖了」
    const plan2 = C.planCollect(floorsBody(A, 'o', 5, 7, { overwrite: true }), {
      observed: observe(fake, A, [0, 1, 2, 3, 4, 5, 6, 7, 8]),
      now: () => Date.now(),
    })
    const result = await C.applyCollect(plan2, { tavern, now: () => Date.now() })
    assert.equal(result.ok, true, 'overwrite apply 应成功: ' + JSON.stringify((result && result.error) || '').slice(0, 160))
    const rec0005 = result.readBack.find((r) => r.path === floorPathOf(A, 5))
    assert.ok(rec0005, 'readBack 应含 0005')
    assert.notEqual(rec0005.sha256, old0005, '0005 应被覆盖成新内容')
    assert.equal(rec0005.sha256, plan2.willWrite.find((w) => w.path === floorPathOf(A, 5)).sha256, '覆盖后内容应与 plan 一致')
  })

  await check('A5', '索引并发（二读窗口内被偷改）⇒ 409 + partial 如实列出已落盘文件', async () => {
    const ixPath = idxPathOf(A)
    const plan = C.planCollect(floorsBody(A, 'a', 9, 10), { observed: observe(fake, A, [0, 1, 2, 3, 4, 5, 6, 7, 8]), now: () => Date.now() })
    // 模拟并发写入者落在【写前二读的窗口里】：apply 对 index.json 的 GET 序列是
    // ①写前重核 → ⑤首次读 → ⑤二读（第 3 次）—— 在第 3 次时落篡改。
    fake.armTamperGet(ixPath, 3, (text) => {
      const t = JSON.parse(text)
      t.entries.push({ id: 's-9999-9999', file: 's-9999-9999.md', fromFloor: 0, toFloor: 0, createdAt: ISO0, model: null, sourceHash: sha('x'), chars: 1 })
      return JSON.stringify(t, null, 2) + '\n'
    })
    let threw = null
    try {
      await C.applyCollect(plan, { tavern, now: () => Date.now() })
    } catch (e) {
      threw = e
    } finally {
      fake.disarmTamper()
    }
    assert.ok(threw, 'apply 应被双读乐观锁拒绝')
    assert.equal(threw.code, 'COLLECT_REVISION_CHANGED', '实际 ' + threw.code)
    const conflicts = Array.isArray(threw.conflicts) ? threw.conflicts : []
    assert.ok(conflicts.some((c) => c.path === ixPath), 'conflicts 应含 index.json（实际 ' + JSON.stringify(conflicts.map((c) => c.path)) + '）')
    // fail-closed 的诚实纪律：楼层与摘要已经落盘了，partial 必须如实列出，索引绝不能出现
    const partial = Array.isArray(threw.collectPartial) ? threw.collectPartial : []
    assert.deepEqual(
      partial.map((p) => p.path).sort(),
      [floorPathOf(A, 9), floorPathOf(A, 10), A + '/archive/summaries/' + mdIdOf(9, 10) + '.md'].sort(),
      'partial 应恰好是已落盘的 3 个文件（实际 ' + JSON.stringify(partial.map((p) => p.path)) + '）',
    )
    assert.ok(fake.files.get(ixPath).includes('s-9999-9999'), '并发者的篡改应已留在盘上（我们看到的就是它）')
    assert.ok(!fake.files.get(ixPath).includes(mdIdOf(9, 10)), '我们的索引条目绝不能混进去（409 拒写）')
  })

  await check('A6', '过期 plan（等效 TTL=0）⇒ COLLECT_PLAN_EXPIRED 且零写入', async () => {
    const plan = C.planCollect(floorsBody(A, 'a', 11, 12), { observed: observe(fake, A, [0, 1, 2, 3, 4, 5, 6, 7, 8]), now: () => Date.now() })
    const stale = { ...plan, createdAt: Date.now() - C.collectConstants.planTtlMs - 1 }
    let threw = null
    try {
      await C.applyCollect(stale, { tavern, now: () => Date.now() })
    } catch (e) {
      threw = e
    }
    assert.ok(threw, '过期 plan 必须被拒')
    assert.equal(threw.code, 'COLLECT_PLAN_EXPIRED', '实际 ' + threw.code)
    assert.ok(!fake.files.has(floorPathOf(A, 11)) && !fake.files.has(floorPathOf(A, 12)), '过期 plan 一个字节都不该写')
  })

  await check('A7', '写中途失败 ⇒ 抛错且 partial 如实列出已落盘文件', async () => {
    const plan = C.planCollect(floorsBody(CC, 'c', 0, 2), { observed: observe(fake, CC, []), now: () => Date.now() })
    fake.armFailPut(2) // 第 2 个 PUT（floors/0001.json）注入 500
    let threw = null
    try {
      await C.applyCollect(plan, { tavern, now: () => Date.now() })
    } catch (e) {
      threw = e
    } finally {
      fake.disarm()
    }
    assert.ok(threw, '中途 500 必须向上抛')
    assert.equal(threw.code, 'TAVERN_HTTP_500', '实际 ' + threw.code)
    const partial = Array.isArray(threw.collectPartial) ? threw.collectPartial : []
    assert.equal(partial.length, 1, 'partial 应恰好 1 个文件，实际 ' + partial.length + '：' + JSON.stringify(partial.map((p) => p.path)))
    assert.ok(partial[0].path === floorPathOf(CC, 0), 'partial[0]=' + partial[0].path)
    assert.equal(partial[0].sha256, sha(floorText(floorsBody(CC, 'c', 0, 2).floors[0])), 'partial[0] sha256 应等于盘上内容')
    assert.ok(fake.files.has(floorPathOf(CC, 0)), '0000 应已在假服务上')
    assert.ok(!fake.files.has(floorPathOf(CC, 1)), '0001 不该落盘')
    assert.ok(!fake.files.has(floorPathOf(CC, 2)), '0002 不该落盘')
    assert.ok(!fake.files.has(CC + '/archive/summaries/' + mdIdOf(0, 2) + '.md'), '摘要不该落盘')
    assert.ok(!fake.files.has(idxPathOf(CC)), '索引不该落盘（索引没写上=没收）')
  })

  await check('A8', '隐私自证：fixture 正文前 12 字在 collect.js 与本台源码里零命中', async () => {
    const head12 = synMes('a', 0).slice(0, 12)
    const collectSrc = await readFile(new URL('./lib/collect.js', import.meta.url), 'utf8')
    const selfSrc = await readFile(new URL('./_selftest-collect.mjs', import.meta.url), 'utf8')
    assert.equal(collectSrc.includes(head12), false, 'collect.js 命中了 fixture 前 12 字')
    assert.equal(selfSrc.includes(head12), false, 'selftest 源码命中了 fixture 前 12 字')
  })

  await check('A9', 'applyCollect 的每个变更请求都带同源 Origin、GET 不带（假服务按 secureTavernApi 规则放行）', async () => {
    const before = fake.requests.length
    // B 已有 0..2（A2 写的）与索引；overwrite:true 收 3..4 ⇒ 2×mkdir + 2×楼层 + 摘要 + 索引 = 6 个变更
    const plan = C.planCollect(floorsBody(B, 'b', 3, 4, { overwrite: true }), {
      observed: observe(fake, B, [0, 1, 2, 3, 4]),
      now: () => Date.now(),
    })
    const result = await C.applyCollect(plan, { tavern, now: () => Date.now() })
    assert.equal(result.ok, true, 'apply 应成功（同源 Origin 被放行）: ' + JSON.stringify((result && result.error) || '').slice(0, 160))
    const delta = fake.requests.slice(before)
    const muts = delta.filter((r) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method))
    assert.equal(muts.length, 6, '变更请求应恰好 6 个（实际 ' + muts.length + '）：' + JSON.stringify(delta.map((r) => r.method + ' ' + r.url)))
    for (const r of muts) {
      assert.ok(typeof r.origin === 'string' && r.origin !== '', '变更请求缺 Origin：' + r.method + ' ' + r.url)
      let oh = ''
      try { oh = new URL(r.origin).host } catch {}
      assert.equal(oh, r.host, r.method + ' ' + r.url + ' 的 Origin.host=' + oh + ' ≠ Host=' + r.host + '（不同源）')
    }
    const gets = delta.filter((r) => r.method === 'GET')
    assert.ok(gets.length > 0, '读请求样本为空，最小化断言没跑起来')
    for (const g of gets) {
      assert.equal(g.origin, null, 'GET 不该带 Origin（读写面行为最小化）：' + g.url)
    }
  })

  // ---------------------------------------------------------------------------
  // A11/A12：2026-09-16 事故回归 —— 「覆盖重导同一个源」被乐观锁误拦
  //   （真因：expectedRevisions[摘要] 被写死 null，而摘要文件本来就存在）
  // ---------------------------------------------------------------------------

  await check('A11', '覆盖重导：摘要文件已存在 ⇒ 期望值=真身 sha（不再误报乐观锁）；未覆盖 ⇒ 明确拒', async () => {
    const mdPath = A + '/archive/summaries/' + mdIdOf(0, 5) + '.md'
    const body = floorsBody(A, 'a2', 0, 5, { overwrite: true })
    const sp = C.summaryPathOf(body.target, body.summary, body.range)
    assert.equal(sp.path, mdPath, 'summaryPathOf 口径应等于 seed 造的摘要路径（实际 ' + sp.path + '）')

    const obs = await C.observeArchive(tavern, body.target, { overwrite: true, floors: body.floors, summaryPaths: [sp.path] })
    assert.equal(obs.summaryShas.get(sp.path), sha(fake.files.get(mdPath)), 'summaryShas 应取到真身 sha')

    const plan = C.planCollect(body, { observed: obs, now: () => Date.now() })
    assert.equal(plan.expectedRevisions[sp.path], sha(fake.files.get(mdPath)), 'expectedRevisions[摘要] 必须是真身 sha（⛔ 不是 null）')
    assert.ok(plan.warnings.some((w) => w.includes('将被覆盖')), '应有「摘要将被覆盖」warning：' + JSON.stringify(plan.warnings))
    const r = await C.applyCollect(plan, { tavern, now: () => Date.now() })
    assert.equal(r.ok, true, '覆盖重导 apply 应成功（⛔ 不许再抛 COLLECT_REVISION_CHANGED）')
    assert.equal(r.readBack.find((x) => x.path === mdPath).sha256, plan.willWrite.find((w) => w.path === mdPath).sha256, '覆盖后的摘要 sha 应与 plan 一致')

    // 反证：盘上有个**不在索引里**的摘要文件 + 未开覆盖 ⇒ 必须在 plan 阶段就明确拒（而不是 apply 时误报"被改过"）
    const stray = mdIdOf(7, 7)
    fake.files.set(A + '/archive/summaries/' + stray + '.md', synSum('stray', 7, 7))
    const noOv = floorsBody(A, 'a3', 100, 101)
    noOv.summary.id = stray
    const obs2 = await C.observeArchive(tavern, noOv.target, { overwrite: false, floors: noOv.floors, summaryPaths: [C.summaryPathOf(noOv.target, noOv.summary, noOv.range).path] })
    let threw = null
    try { C.planCollect(noOv, { observed: obs2, now: () => Date.now() }) } catch (e) { threw = e }
    assert.ok(threw, '摘要文件已存在且未覆盖 ⇒ 应拒')
    assert.equal(threw.code, 'COLLECT_SUMMARY_EXISTS', '实际抛的是 ' + (threw && threw.code))
    fake.files.delete(A + '/archive/summaries/' + stray + '.md')
  })

  await check('A12', '写前重核分级：目标文件「本来就存在」⇒ 文案说"已存在"（附 reason），不说"被改过"', async () => {
    const body = floorsBody(B, 'b9', 9, 10)
    const plan = C.planCollect(body, { observed: observe(fake, B, []), now: () => Date.now() })
    const p9 = floorPathOf(B, 9)
    fake.files.set(p9, JSON.stringify({ _floor: 9, is_user: true, is_system: false, mes: synMes('zz', 9), name: synName('u') }))
    let threw = null
    try { await C.applyCollect(plan, { tavern, now: () => Date.now() }) } catch (e) { threw = e }
    assert.ok(threw, '应被写前重核拒绝')
    assert.equal(threw.code, 'COLLECT_REVISION_CHANGED', '实际 ' + threw.code)
    const c = (threw.conflicts || []).find((x) => x.path === p9)
    assert.ok(c && c.reason === 'EXISTS', 'conflicts 应带 reason=EXISTS（实际 ' + JSON.stringify(threw.conflicts) + '）')
    assert.ok(/已存在/.test(threw.message), '文案应说"已存在"（实际：' + threw.message + '）')
    assert.ok(!/被改过/.test(threw.message), '⛔ 不该说"被改过"（实际：' + threw.message + '）')
    fake.files.delete(p9)
  })

  // -------------------------------------------------------------------------
  // ★★ 2026-09-22「摘要按段切片」：追加式 `summaries`（一次 N 份，各带自己的 id/落点/meta）
  //   背景（A2 任务书 §1）：检索侧的粒度就是「一个摘要文件 = 一条切片」⇒ 一次压缩的 N 个叙事段
  //   要落成 N 条，而不是挤成一条。⛔ 老路（只给 `summary`）的形状与字节行为一个字都没动
  //   （A2/A3/A11/A12 原样跑绿 + A14 把形状钉死）。
  // -------------------------------------------------------------------------

  /** 一份 `summaries` 夹具：n 段、各自不同的正文/标签（合成占位；⛔ 无真实会话正文）。 */
  const sumBody = (root, from, to, n, extra = {}) => ({
    target: { characterId: root.split('/')[0], playthroughId: root.split('/')[1] },
    range: { fromFloor: from, toFloor: to },
    floors: [...Array(to - from + 1).keys()].map((k) => ({ floor: from + k, isUser: true, isSystem: false, mes: synMes('slice', from + k), name: synName('u') })),
    summaries: [...Array(n).keys()].map((i) => ({
      id: 'mt-' + pad(from) + '-' + pad(to) + '-' + (i + 1),
      text: synSum('seg' + String(i + 1), from, to),
      model: 'syn-model',
      meta: { kind: 'model-summary', tags: ['Tag' + String(i + 1)], eventSeq: 100 + i, shadowedTokenCount: 10 * (i + 1) },
    })),
    ...extra,
  })

  await check('A14', '★ 老路形状钉死：只给 `summary` 的 plan 键集合照旧（⛔ 不多一个 summaries 键）', async () => {
    const plan = C.planCollect(floorsBody(CC, 'c', 0, 2), { observed: observe(fake, CC, []), now: () => Date.now() })
    assert.equal(Object.keys(plan).filter((k) => k === 'summaries').length, 0, '老路 plan 里不该有 summaries 键')
    assert.deepEqual(Object.keys(plan).sort(), [
      'createdAt', 'dryRun', 'entryMeta', 'entryModel', 'expectedRevisions', 'floorDocs', 'hash', 'indexBeforeSha',
      'indexExisted', 'indexPath', 'manifestPath', 'manifestUpdate', 'overwrite', 'range', 'summaryId', 'summaryPath',
      'summaryText', 'target', 'v', 'warnings', 'willUpdate', 'willWrite',
    ], '老路 plan 的键集合变了：' + Object.keys(plan).sort().join(','))
    assert.equal(plan.summaryId, mdIdOf(0, 2), '老路的 summaryId 应是不带后缀的 s-<from>-<to>：' + plan.summaryId)
  })

  await check('A15', '★ 追加式：一次提交 3 份 ⇒ 楼层写一遍 + 索引**追加 3 条** + manifest.count = 3', async () => {
    // 新周目 D：catalog 里补一条 + 预制 archive/manifest.json（真归档都有），索引不存在（本次新建）
    const D = 'chard/playthrough-d'
    const cat = JSON.parse(fake.files.get('catalog.json'))
    cat.playthroughs.push({ id: 'pt-d', path: D + '/timeline.json', title: synTitle('d'), ext: { pmpDshTavern: { characterId: 'chard', characterName: synName('d'), playthroughNumber: 4 } } })
    fake.files.set('catalog.json', JSON.stringify(cat) + '\n')
    fake.files.set(
      manPathOf(D),
      JSON.stringify({ schemaVersion: 1, kind: 'dsh-tavern-l2-archive', generatedAt: ISO0, summaries: { dir: 'summaries', index: 'summaries/index.json', count: 0, writer: 'fixture-d' } }, null, 2) + '\n',
    )
    const body = sumBody(D, 0, 1, 3)
    const plan = C.planCollect(body, { observed: observe(fake, D, []), now: () => Date.now() })
    const segPaths = [1, 2, 3].map((i) => D + '/archive/summaries/mt-0000-0001-' + i + '.md')
    assert.deepEqual(
      plan.willWrite.map((w) => w.path).filter((p) => p.includes('/summaries/')).sort(),
      [...segPaths, idxPathOf(D)].sort(),
      'willWrite 的摘要路径应为 3 份 + 索引：' + JSON.stringify(plan.willWrite.map((w) => w.path)),
    )
    assert.ok(segPaths.every((p) => Object.prototype.hasOwnProperty.call(plan.expectedRevisions, p) && plan.expectedRevisions[p] === null),
      '每份摘要的落点都要登记 expectedRevisions（照现有多份文件的写法，别漏）：' + JSON.stringify(plan.expectedRevisions))
    const result = await C.applyCollect(plan, { tavern, now: () => Date.now() })
    assert.equal(result.ok, true, 'apply ok=false：' + JSON.stringify((result && result.error) || '').slice(0, 160))
    // 每份正文逐字落盘（按 plan 给的 sha 核）+ 楼层只写一遍（3 个摘要文件 + 2 楼 + 索引，没有重复）
    for (const w of plan.willWrite) {
      const r = result.readBack.find((x) => x.path === w.path)
      assert.ok(r, 'readBack 缺 ' + w.path)
      assert.equal(r.sha256, w.sha256, 'sha256 不一致 ' + w.path)
    }
    assert.equal(fake.files.get(segPaths[0]), synSum('seg1', 0, 1), '第 1 份正文应逐字是那一段')
    assert.equal(fake.files.get(segPaths[2]), synSum('seg3', 0, 1), '第 3 份正文应逐字是那一段')
    const after = JSON.parse(fake.files.get(idxPathOf(D)))
    assert.equal(after.entries.length, 3, '索引应追加 3 条：' + after.entries.length)
    assert.deepEqual(after.entries.map((e) => e.id), ['mt-0000-0001-1', 'mt-0000-0001-2', 'mt-0000-0001-3'], '条目顺序/ id 不符：' + JSON.stringify(after.entries.map((e) => e.id)))
    assert.deepEqual(after.entries.map((e) => e.file), ['mt-0000-0001-1.md', 'mt-0000-0001-2.md', 'mt-0000-0001-3.md'], 'file 字段不符')
    assert.ok(after.entries.every((e) => e.fromFloor === 0 && e.toFloor === 1), '各段共用区间的 from/to：' + JSON.stringify(after.entries.map((e) => [e.fromFloor, e.toFloor])))
    assert.ok(after.entries.every((e) => e.model === 'syn-model'), 'model 应各段一致')
    assert.deepEqual(after.entries.map((e) => e.tags), [['Tag1'], ['Tag2'], ['Tag3']], 'tags 应**各段各自**的（⛔ 不是并集）：' + JSON.stringify(after.entries.map((e) => e.tags)))
    assert.deepEqual(after.entries.map((e) => e.eventSeq), [100, 101, 102], 'meta 白名单字段应逐段带上')
    assert.ok(after.entries.every((e) => e.sourceHash === sha(synSum('seg' + (after.entries.indexOf(e) + 1), 0, 1)) && e.kind === 'model-summary'), 'sourceHash/kind 不符')
    const manAfter = JSON.parse(fake.files.get(manPathOf(D)))
    assert.equal(manAfter.summaries.count, 3, 'manifest.count 应 = 追加后的条目数（3）：' + manAfter.summaries.count)
    assert.equal(manAfter.summaries.writer, WRITER, 'manifest.writer=' + manAfter.summaries.writer)
    assert.equal(fake.files.get(floorPathOf(D, 0)).includes('"mes"'), true, '楼层应照常落盘')
  })

  await check('A16', '★ 两路并存（summary + summaries）⇒ COLLECT_INVALID（planCollect 与 validatePlanInput 两处都拒，⛔ 不猜）', async () => {
    const both = { ...floorsBody(CC, 'c', 20, 21), summaries: [{ id: 'mt-0020-0021-1', text: synSum('x', 20, 21) }] }
    let e1 = null
    try { C.planCollect(both, { observed: observe(fake, CC, []), now: () => Date.now() }) } catch (e) { e1 = e }
    assert.ok(e1, 'planCollect 应拒')
    assert.equal(e1.code, 'COLLECT_INVALID', 'planCollect 实际抛 ' + e1.code)
    assert.ok(/只能给一个/.test(e1.message), '文案应说清"只能给一个"：' + e1.message)
    let e2 = null
    try { C.validatePlanInput(both) } catch (e) { e2 = e }
    assert.ok(e2 && e2.code === 'COLLECT_INVALID', 'validatePlanInput 应拒 COLLECT_INVALID，实际 ' + (e2 && e2.code))
  })

  await check('A17', '★ summaries 的落点必须互不相同（缺 id / id 重复 ⇒ COLLECT_INVALID，⛔ 不替你改名）', async () => {
    const dupId = sumBody(CC, 30, 31, 2)
    dupId.summaries[1].id = dupId.summaries[0].id
    let e1 = null
    try { C.validatePlanInput(dupId) } catch (e) { e1 = e }
    assert.ok(e1 && e1.code === 'COLLECT_INVALID', 'id 重复应拒 COLLECT_INVALID，实际 ' + (e1 && e1.code))
    const noId = sumBody(CC, 30, 31, 2)
    for (const s of noId.summaries) delete s.id
    let e2 = null
    try { C.validatePlanInput(noId) } catch (e) { e2 = e }
    assert.ok(e2 && e2.code === 'COLLECT_INVALID', '两份都没 id（缺省落到同一个 s-<from>-<to>.md）应拒，实际 ' + (e2 && e2.code))
    assert.ok(/同一个摘要文件/.test(e2.message), '文案应说清"落点相同"：' + e2.message)
  })

  await check('A18', '★ 逐段判重：某一份的 id 已在索引里 / 某一份的正文已存在 ⇒ COLLECT_SUMMARY_EXISTS（不 overwrite）', async () => {
    const D = 'chard/playthrough-d'
    const stale = D + '/archive/summaries/mt-0000-0001-2.md' // A15 已落盘并在索引里
    const freshPath = D + '/archive/summaries/mt-0002-0003-1.md'
    const body = sumBody(D, 2, 3, 2) // 第 1 份是新的（mt-0002-0003-1），第 2 份故意撞 A15 那条
    body.summaries[1].id = 'mt-0000-0001-2'
    // ① 不观察摘要指纹（= 只比对索引）⇒ 撞在**索引**那一支上
    let e1 = null
    try { C.planCollect(body, { observed: observe(fake, D, []), now: () => Date.now() }) } catch (e) { e1 = e }
    assert.ok(e1, '第 2 份的 id 已在索引里 ⇒ 应拒')
    assert.equal(e1.code, 'COLLECT_SUMMARY_EXISTS', '实际抛 ' + e1.code)
    assert.ok(/mt-0000-0001-2/.test(e1.message), '文案应点名是哪一份：' + e1.message)
    // ② 覆盖模式 ⇒ 照常放行；且**逐份**回归自己的期望值（新的 = null，已存在的 = 真身 sha）
    const plan = C.planCollect({ ...body, overwrite: true }, { observed: observe(fake, D, [], [freshPath, stale]), now: () => Date.now() })
    assert.ok(plan.willWrite.some((w) => w.path === stale), 'overwrite 应照常计划写那一份')
    assert.equal(plan.expectedRevisions[freshPath], null, '新那份的期望值应为 null')
    assert.equal(plan.expectedRevisions[stale], sha(fake.files.get(stale)), '已存在那份的期望值 = 真身 sha')
    // ③ 只观察**文件**那一支：往盘上放一份「索引里没有、但文件在」的摘要（别人写的孤儿文件）
    const orphan = D + '/archive/summaries/mt-0007-0008-1.md'
    fake.files.set(orphan, synSum('orphan', 7, 8))
    const body3 = sumBody(D, 7, 8, 2) // 第 1 份的落点就是那份孤儿文件（索引里没有它）
    let e3 = null
    try {
      C.planCollect(body3, { observed: observe(fake, D, [], [orphan, D + '/archive/summaries/mt-0007-0008-2.md']), now: () => Date.now() })
    } catch (e) {
      e3 = e
    }
    assert.ok(e3 && e3.code === 'COLLECT_SUMMARY_EXISTS' && /mt-0007-0008-1\.md/.test(e3.message),
      '落点已被别的文件占了 ⇒ 应拒并点名（走的是"文件已存在"那一支）：' + JSON.stringify(e3 && [e3.code, e3.message]))
  })
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main() {
  const C = await loadCollect()
  const fake = createFakeTavern()
  await fake.start()
  seed(fake)
  try {
    await runAssertions(C, fake)
  } finally {
    await fake.stop()
  }

  const mutation = MUTATE ? MUTATIONS.find((m) => m.n === MUTATE) : null
  const ordered = mutation ? results.filter((r) => r.id === mutation.assertId) : results
  const labelW = Math.max(...ordered.map((r) => r.label.length), 10)
  console.log('=== _selftest-collect 行为自检 · ' + (mutation ? 'MUTATE=' + MUTATE + '（' + mutation.label + '）' : '全量') + ' · 假Tavern ' + fake.base + ' ===')
  for (const r of ordered) {
    console.log((r.pass ? 'PASS ' : 'RED  ') + r.id.padEnd(3) + ' ' + r.label.padEnd(labelW) + (r.pass ? '' : ' ｜ ' + r.note))
  }
  const green = ordered.filter((r) => r.pass).length
  const red = ordered.length - green

  if (mutation) {
    const hit = ordered.find((r) => r.id === mutation.assertId)
    if (hit && !hit.pass) {
      console.log('反证成立：' + mutation.label + ' ⇒ 断言 ' + mutation.assertId + ' 变红')
      process.exit(0)
    }
    console.log('反证失败：改坏了但 ' + mutation.assertId + ' 仍然绿 —— 台子抓不住这个突变')
    process.exit(1)
  }
  console.log(green + '/' + results.length + ' 绿' + (red ? '，' + red + ' 红' : ''))
  process.exit(red ? 1 : 0)
}

main().catch((e) => {
  console.error('自检台自身崩了：' + ((e && e.stack) || e))
  process.exit(2)
})
