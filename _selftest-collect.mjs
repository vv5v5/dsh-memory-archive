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

/** 从假服务盘上读当前归档现状（planCollect 的 observed 口径）。 */
function observe(fake, root, floorNos) {
  const idxText = fake.files.has(idxPathOf(root)) ? fake.files.get(idxPathOf(root)) : null
  const manText = fake.files.has(manPathOf(root)) ? fake.files.get(manPathOf(root)) : null
  const floorShas = new Map()
  for (const i of floorNos) {
    const p = floorPathOf(root, i)
    if (fake.files.has(p)) floorShas.set(i, sha(fake.files.get(p)))
  }
  return {
    targetKnown: true,
    existingFloors: new Set(floorNos.filter((i) => fake.files.has(floorPathOf(root, i)))),
    floorShas,
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
