/**
 * A2 自检台：lib/collect-scan.js —— 行为级；手搓 Map + 临时台账目录，零宿主、零 Tavern、零 LLM。
 * 运行：node _selftest-collect-scan.mjs（结束自动删掉自建临时目录）。
 * 第 1/5/6 条的反证（故意改坏 collect-scan.js 一行 ⇒ 必须变红）由运行者手工执行并留档。
 * 隐私：fixture 全是明显假的占位正文；自检输出/台账/collect-scan.js 三处对 fixture 前 12 字零命中（第 8 条锁死）。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findShadowRegions,
  regionContentHash,
  buildRegionSummary,
  mapRegionToFloors,
  readLedger,
  writeLedger,
  planScan,
  applyScan,
  scanConstants,
} from './lib/collect-scan.js'

const here = dirname(fileURLToPath(import.meta.url))
const workRoot = mkdtempSync(join(here, '.st-tmp-')) // 只落在仓库内，finally 里删干净

const outBuf = []
function out(line) {
  outBuf.push(line)
  process.stdout.write(line + '\n')
}
let pass = 0
let fail = 0
function check(id, label, cond, detail) {
  if (cond) pass++
  else fail++
  out(`${cond ? 'PASS' : 'FAIL'} ${id} ${label}${cond ? '' : '  ← ' + String(detail)}`)
}

const sha = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex')

// —— 合成 fixture（占位正文；第 8 条要证明它绝不漏进 collect-scan.js / 台账 / 本自检输出）——
const FIX = [
  '甲甲甲甲甲甲甲甲甲甲甲甲占位正文零',
  '乙乙乙乙乙乙乙乙乙乙乙乙占位正文一',
  '丙丙丙丙丙丙丙丙丙丙丙丙current不该被扫',
  '丁丁丁丁丁丁丁丁丁丁丁丁占位正文二',
  '戊戊戊戊戊戊戊戊戊戊戊戊logonly不该被扫',
  '己己己己己己己己己己己己占位正文三',
  '庚庚庚庚庚庚庚庚庚庚庚庚占位正文四',
]
const FIX12 = FIX[0].slice(0, 12)

try {
  // ═══ 1. 区间切分 ═══════════════════════════════════════════════════════
  const bySeq = new Map([
    [0, { surface: 'shadowed', text: FIX[0], type: 'user/message' }],
    [1, { surface: 'shadowed', text: FIX[1], type: 'assistant/message' }],
    [2, { surface: 'current', text: FIX[2], type: 'user/message' }],
    [3, { surface: 'shadowed', text: FIX[3], type: 'assistant/message' }],
    [4, { surface: 'log-only', text: FIX[4], type: 'tool/result' }],
    [5, { surface: 'shadowed', text: FIX[5], type: 'user/message' }],
    [6, { surface: 'shadowed', text: FIX[6], type: 'assistant/message' }],
  ])
  const regions = findShadowRegions(bySeq)
  check('1a', '恰好 3 个 region', regions.length === 3, `得到 ${regions.length}`)
  check(
    '1b',
    '区间 [0,1][3,3][5,6]',
    JSON.stringify(regions.map((r) => [r.fromSeq, r.toSeq])) === JSON.stringify([[0, 1], [3, 3], [5, 6]]),
    JSON.stringify(regions.map((r) => [r.fromSeq, r.toSeq])),
  )
  check('1c', 'region 内没有 current/log-only/null', regions.every((r) => r.docs.every((d) => d.surface === 'shadowed')))
  check('1d', '文档数 2/1/2', regions.map((r) => r.docs.length).join('/') === '2/1/2', regions.map((r) => r.docs.length).join('/'))

  // ═══ 2. contentHash 可复算 ═════════════════════════════════════════════
  const h1 = regionContentHash(regions[0])
  const h1b = regionContentHash(regions[0])
  check('2a', '同输入两次相同且是 64 位十六进制', h1 === h1b && /^[0-9a-f]{64}$/.test(h1))
  const shuffled = { ...regions[0], docs: [...regions[0].docs].reverse() }
  check('2b', 'seq 顺序打乱 ⇒ 哈希必须不同', regionContentHash(shuffled) !== h1)
  check('2c', '哈希等于口径直算值（\\n 拼接 sha256）', h1 === sha(FIX[0] + '\n' + FIX[1]))

  // ═══ 3. 映射：tool/result 不单独成楼 ═══════════════════════════════════
  const r3 = {
    regionId: 'r3',
    fromSeq: 0,
    toSeq: 2,
    docs: [
      { seq: 0, surface: 'shadowed', text: '楼正文AAA', type: 'assistant/message' },
      { seq: 1, surface: 'shadowed', text: '工具输出BBB', type: 'tool/result' },
      { seq: 2, surface: 'shadowed', text: '楼正文CCC', type: 'assistant/message' },
    ],
  }
  const m3 = mapRegionToFloors(r3, 0)
  check('3a', '楼数只算 2', m3.floors.length === 2, `得到 ${m3.floors.length}`)
  check('3b', 'tool 正文并进前一条楼（\\n 接）', m3.floors[0].text === '楼正文AAA' + '\n' + '工具输出BBB', JSON.stringify(m3.floors[0].text))
  check('3c', '第二条楼独立', m3.floors[1].text === '楼正文CCC')
  check(
    '3d',
    'name 恒（来自会话）/ is_system 恒 false / is_user 按 type',
    m3.floors.every((f) => f.name === '（来自会话）' && f.isSystem === false && f.isUser === false),
  )

  // ═══ 4. 楼号起点 ═══════════════════════════════════════════════════════
  const r4 = {
    regionId: 'r4',
    fromSeq: 0,
    toSeq: 2,
    docs: [
      { seq: 0, surface: 'shadowed', text: '楼一', type: 'user/message' },
      { seq: 1, surface: 'shadowed', text: '楼二', type: 'assistant/message' },
      { seq: 2, surface: 'shadowed', text: '楼三', type: 'user/message' },
    ],
  }
  const m4 = mapRegionToFloors(r4, 6)
  check('4a', 'startFloor=6 喂 3 楼 ⇒ 楼号 6,7,8', m4.floors.map((f) => f.floor).join(',') === '6,7,8', m4.floors.map((f) => f.floor).join(','))
  check('4b', 'nextFloor=9', m4.nextFloor === 9, `得到 ${m4.nextFloor}`)

  // ═══ 5. 幂等（核心）═══════════════════════════════════════════════════
  function makeFakeCollect() {
    const calls = { planCollect: 0, applyCollect: 0 }
    let tavernWrites = 0
    // ★★ 假后端**复刻 A1 的准入规则**（这一条是从 403 那件事学来的：假服务不复刻真服务的规则，
    //   自检台就是在骗自己）。这里维护一份「假磁盘」，并有**真正的写前重核**：
    //   · planCollect 记下**当时** index/manifest 的 sha；
    //   · applyCollect 先核对 subPlan.expectedRevisions 与假磁盘，不一致 ⇒ 抛 COLLECT_REVISION_CHANGED；
    //   · 每次真写之后 index/manifest 的 sha 会变 —— 这正是「多区间只落得下第 1 个」那个真 bug 的机制。
    const disk = { index: null, manifest: null }
    const shaOf = (n) => sha('v' + n)
    return {
      calls,
      getTavernWrites: () => tavernWrites,
      getDisk: () => ({ ...disk }),
      collect: {
        async planCollect(request) {
          calls.planCollect++
          const willWrite = request.floors.map((f) => ({
            path: `archive/${request.characterId}/${request.playthroughId}/floors/${String(f.floor).padStart(4, '0')}.json`,
            bytes: f.text.length,
            sha256: sha(f.text),
          }))
          // ★ 摘要路径按楼号区间区分（照 A1 真后端的 `s-<from>-<to>.md` 口径）。
          //   ⛔ 不能三个区间都写同一个路径 —— 那样 applyScan 按路径去重后会把它们并成一条，
          //   断言就会看到 written=6 而不是 8（20260914 实测踩到）。
          const pad4 = (n) => String(n).padStart(4, '0')
          const floors = request.floors
          const summaryPath = `archive/${request.characterId}/${request.playthroughId}/summaries/s-${pad4(floors[0].floor)}-${pad4(floors[floors.length - 1].floor)}.md`
          willWrite.push({ path: summaryPath, bytes: request.summary.text.length, sha256: sha(request.summary.text) })
          const expectedRevisions = {
            [`archive/${request.characterId}/${request.playthroughId}/summaries/index.json`]: disk.index,
            [`archive/${request.characterId}/${request.playthroughId}/manifest.json`]: disk.manifest,
          }
          // 这里的 planId 是对的：它是 A1 planCollect 子计划的一次性令牌（可消费），
          // 不是 scan 对外的 planHash 指纹 —— 两个名字语义不同，别「统一」它。
          return { planId: 'fake-' + calls.planCollect, willWrite, willUpdate: [], expectedRevisions }
        },
        async applyCollect(subPlan, opts) {
          calls.applyCollect++
          // ★ 写前重核（复刻 A1）：调用方覆盖合并规则也照抄（只收 null / 字符串）
          const expected = { ...(subPlan.expectedRevisions || {}) }
          if (opts && opts.expectedRevisions && typeof opts.expectedRevisions === 'object') {
            for (const [k, v] of Object.entries(opts.expectedRevisions)) if (v === null || typeof v === 'string') expected[k] = v
          }
          const conflicts = []
          for (const [path, want] of Object.entries(expected)) {
            const have = path.endsWith('index.json') ? disk.index : path.endsWith('manifest.json') ? disk.manifest : null
            if (want !== have) conflicts.push({ path, expected: want, actual: have })
          }
          if (conflicts.length > 0) {
            const e = new Error('有 ' + conflicts.length + ' 个目标文件在 plan 之后被改过（乐观锁拒绝写入）')
            e.code = 'COLLECT_REVISION_CHANGED'
            e.conflicts = conflicts
            throw e
          }
          for (const w of subPlan.willWrite) tavernWrites++ // 模拟真写一个文件
          // 真写之后 index / manifest 变了（这就是让下一区间的旧快照失效的那一步）
          disk.index = shaOf(tavernWrites + ':index')
          disk.manifest = shaOf(tavernWrites + ':manifest')
          return { written: subPlan.willWrite.map((w) => ({ ...w })), readBack: subPlan.willWrite.map((w) => ({ path: w.path, ok: true })) }
        },
      },
    }
  }
  const dep5 = makeFakeCollect()
  const dsh5 = mkdtempSync(join(workRoot, 'dsh5-'))
  const input5 = { sessionId: 'sess-selftest', target: { characterId: 'charT', playthroughId: 'ptT' } }
  const deps5 = { loadSurfaces: async () => bySeq, maxExistingFloor: async () => 5, collect: dep5.collect, dshHome: dsh5 }
  const plan5 = await planScan(input5, deps5)
  check('5a', '规划含 3 个 region 且全部 alreadyArchived=false', plan5.regions.length === 3 && plan5.regions.every((r) => r.alreadyArchived === false))
  check(
    '5b',
    '楼号接在现有最大楼 5 后：[6,7][8][9,10]',
    JSON.stringify(plan5.regions.filter((r) => !r.skipped).map((r) => [r.floorFrom, r.floorTo])) === JSON.stringify([[6, 7], [8, 8], [9, 10]]),
    JSON.stringify(plan5.regions.map((r) => [r.floorFrom, r.floorTo])),
  )
  // ★ 台子要能**扛住**被测代码抛错并如实报红：修复前 applyScan 会在第 2 个区间抛
  //   COLLECT_REVISION_CHANGED，如果让它冒出去，整个自检台会在这里崩掉、后面的断言全跑不到
  //   —— 那反证就变成「崩了」而不是「红了」，看不出是哪条锁住了 bug。（20260914 反证时实测到的。）
  let r1 = null
  let r1err = null
  try { r1 = await applyScan(plan5, { dshHome: dsh5, collect: dep5.collect }) } catch (e) { r1err = e }
  const writesAfter1 = dep5.getTavernWrites()
  const appliesAfter1 = dep5.calls.applyCollect
  const plansAfter1 = dep5.calls.planCollect
  check('5c', '第一轮 archived=3、台账已更新', !r1err && r1.archived === 3 && r1.ledgerUpdated === true,
    r1err ? `★ 抛错 ${r1err.code}` : `archived=${r1 && r1.archived}`)
  // ★★ 多区间修复的反证锚点（20260914）：
  //   修复前 planScan 一次算好 3 个子计划，它们的 expectedRevisions 都是**扫描那一刻**的快照；
  //   第 1 个区间一落库就把 index/manifest 改了 ⇒ 从第 2 个区间起写前重核必红。
  //   反证做法：把 lib/collect-scan.js 里 `const subPlan = await replanForRegion(region)` 换回
  //   `region.collectPlan` ⇒ **本条必须变红**（抛 COLLECT_REVISION_CHANGED）；
  //   换回来即复绿。现成的反证脚本：`产物\memory-tools\_proof-reverse-multiregion.mjs`
  //   （它跑前跑后都会还原，最后复绿 —— 已实跑）。
  //   写成 8 = 5 个楼层（[6,7]=2 + [8]=1 + [9,10]=2）+ 3 条区间摘要。
  check('5c2', '★ 多区间：3 个区间**全部**落库（不是只落第 1 个）',
    !r1err && r1.archived === 3 && r1.written.length === 8,
    r1err ? `★ 抛错 ${r1err.code}（修复前就是在第 2 个区间崩的）` : `archived=${r1 && r1.archived} written=${r1 && r1.written.length}（期望 8 = 5 楼 + 3 摘要）`)

  let r2 = null
  if (!r1err) { try { r2 = await applyScan(plan5, { dshHome: dsh5, collect: dep5.collect }) } catch (e) { r1err = e } }
  check('5d', '第二轮 archived=0', !!r2 && r2.archived === 0, r2 ? `archived=${r2.archived}` : '（5c 失败，无法评估）')
  check('5e', '第二轮 skipped[0].reason=already-archived（共 3 条）', !!r2 && r2.skipped.length === 3 && r2.skipped.every((s) => s.reason === 'already-archived'), r2 ? JSON.stringify(r2.skipped) : '（5c 失败，无法评估）')
  check('5f', '假 Tavern write 调用次数不变', !!r2 && dep5.getTavernWrites() === writesAfter1, `${dep5.getTavernWrites()} vs ${writesAfter1}`)
  check('5g', 'applyCollect 次数不变', !!r2 && dep5.calls.applyCollect === appliesAfter1, `${dep5.calls.applyCollect} vs ${appliesAfter1}`)
  let plan5b = null
  try { plan5b = await planScan(input5, deps5) } catch (e) { /* 留空，下面报红 */ }
  // ★ 5h 的口径修正（20260914）：原来拿 `calls.planCollect === appliesAfter1` 当「重扫没生成子计划」的代理，
  //   那只是**数字巧合**成立（3==3）；修复后 applyScan 会为每个区间现取计划（这正是修复本身），
  //   代理就失真了。改成直接量「重扫这一步**新增**了几次 planCollect」，意图不变、也不再靠巧合。
  check('5h', '重扫 alreadyArchived 全 true（只认台账哈希）且**重扫这一步**不再生成落库子计划',
    !!plan5b && plan5b.regions.every((r) => r.alreadyArchived === true) && dep5.calls.planCollect === plansAfter1 && plan5b.regions.every((r) => r.skipped && r.skipped.reason === 'already-archived'),
    `planCollect ${dep5.calls.planCollect} vs ${plansAfter1}`)
  const ledgerRaw5 = readFileSync(join(dsh5, 'magictarven', 'collect-ledger.json'), 'utf8')
  const ledger5 = JSON.parse(ledgerRaw5)
  check('5i', '台账 3 条、键全是 64 位哈希、只有哈希/计数/路径字段', Object.keys(ledger5.regions).length === 3 && Object.keys(ledger5.regions).every((k) => /^[0-9a-f]{64}$/.test(k)) && Object.values(ledger5.regions).every((v) => JSON.stringify(Object.keys(v)) === JSON.stringify(['archivedAt', 'target', 'floorFrom', 'floorTo', 'chars', 'paths'])))

  // ★ 命名收口（A2 review）：scan 对外只有 planHash —— 规划指纹（scanplan-<16hex>），
  //   与 A1 /collect/plan 的一次性令牌 planId 语义不同；返回对象里出现 planId 键即违规
  //   （反证：把 lib/collect-scan.js 里 planHash 改名回 planId ⇒ 本条必须变红）。
  check(
    '5j',
    'planScan/applyScan 返回都没有 planId 键；planHash 是 scanplan-<16hex> 且 apply 原样回显',
    !('planId' in plan5) && !('planId' in r1) && /^scanplan-[0-9a-f]{16}$/.test(plan5.planHash) && r1.planHash === plan5.planHash,
    JSON.stringify({ planKeys: Object.keys(plan5).filter((k) => k === 'planId' || k === 'planHash'), planHash: plan5.planHash, applyKeys: Object.keys(r1).filter((k) => k === 'planId' || k === 'planHash') }),
  )

  // ═══ 6. 台账坏文件 ═════════════════════════════════════════════════════
  const dsh6 = mkdtempSync(join(workRoot, 'dsh6-'))
  mkdirSync(join(dsh6, 'magictarven'), { recursive: true })
  const BROKEN = '{{{not-json-at-all'
  writeFileSync(join(dsh6, 'magictarven', 'collect-ledger.json'), BROKEN, 'utf8')
  const r6 = readLedger(dsh6) // 不许抛
  check('6a', 'readLedger 不抛 + 当空台账', r6.ledger && r6.ledger.schemaVersion === 1 && Object.keys(r6.ledger.regions).length === 0)
  check('6b', '给 warning', typeof r6.warning === 'string' && r6.warning.length > 0)
  writeLedger(dsh6, r6.ledger)
  const baks = readdirSync(join(dsh6, 'magictarven')).filter((n) => n.startsWith('collect-ledger.json.bak-'))
  check('6c', '坏文件已先备份成 .bak-* 且内容原样', baks.length === 1 && readFileSync(join(dsh6, 'magictarven', baks[0]), 'utf8') === BROKEN, `baks=${JSON.stringify(baks)}`)
  const r6b = readLedger(dsh6)
  check('6d', '新台账生效（无 warning、空 regions）', r6b.warning === null && Object.keys(r6b.ledger.regions).length === 0)

  // ═══ 7. too-big：单 region 超限只跳过它，别的照常 ══════════════════════
  const bigBySeq = new Map()
  for (let i = 0; i < 4; i++) bigBySeq.set(i, { surface: 'shadowed', text: '大区占位楼' + i, type: 'user/message' })
  bigBySeq.set(4, { surface: 'current', text: '分隔', type: 'user/message' })
  bigBySeq.set(10, { surface: 'shadowed', text: '小区占位楼A', type: 'user/message' })
  const dep7 = makeFakeCollect()
  const dsh7 = mkdtempSync(join(workRoot, 'dsh7-'))
  const plan7 = await planScan(
    { sessionId: 's7', target: { characterId: 'c7', playthroughId: 'p7' }, maxFloorsPerRegion: 1 },
    { loadSurfaces: async () => bigBySeq, maxExistingFloor: async () => null, collect: dep7.collect, dshHome: dsh7 },
  )
  check('7a', '4 楼 region 进 skipped：too-big + COLLECT_REGION_TOO_BIG', plan7.skipped.some((s) => s.regionId === 'region-0-3' && s.reason === 'too-big' && s.code === 'COLLECT_REGION_TOO_BIG'), JSON.stringify(plan7.skipped))
  const small = plan7.regions.find((r) => r.regionId === 'region-10-10')
  check('7b', '其它 region 照常处理（1 楼、楼号从 0 起）', small && !small.skipped && small.floorCount === 1 && small.floorFrom === 0, JSON.stringify(small && { skipped: small.skipped, floorCount: small.floorCount }))
  const a7 = await applyScan(plan7, { dshHome: dsh7, collect: dep7.collect })
  check('7c', '只落了小区：archived=1、台账 1 条', a7.archived === 1 && Object.keys(readLedger(dsh7).ledger.regions).length === 1)

  // ═══ 8. 隐私自证：fixture 前 12 字在三处零命中 ═════════════════════════
  const scanSrc = readFileSync(join(here, 'lib', 'collect-scan.js'), 'utf8')
  check('8a', 'fixture 前 12 字不在 lib/collect-scan.js', !scanSrc.includes(FIX12))
  check('8b', 'fixture 前 12 字与全文都不在台账文件', !ledgerRaw5.includes(FIX12) && FIX.every((f) => !ledgerRaw5.includes(f)))
  const respShape = JSON.stringify({
    regions: plan5.regions.map(({ floors, summary, collectPlan, ...pub }) => pub),
    willWrite: plan5.willWrite,
    willUpdate: plan5.willUpdate,
    skipped: plan5.skipped,
    warnings: plan5.warnings,
  })
  check('8c', 'fixture 前 12 字不在 scan 响应形状里', !respShape.includes(FIX12))

  // ═══ 9. 零 LLM ═════════════════════════════════════════════════════════
  check('9a', 'collect-scan.js 无 llm / stream( 痕迹', !scanSrc.includes('llm') && !scanSrc.includes('stream('))
  check('9b', 'scanConstants 冻结且三个阈值正确', Object.isFrozen(scanConstants) && scanConstants.maxFloorsPerRegion === 200 && scanConstants.regionSummaryChars === 2000 && scanConstants.regionSummaryPerFloor === 80)
  const sum6 = buildRegionSummary(regions[0])
  check('9c', '摘要 = 各楼前 80 字 \\n 连接 + 后缀（含楼数），总长 ≤2000', sum6.text === FIX[0] + '\n' + FIX[1] + '（合成/自动收纳，共 2 楼）' && sum6.text.length <= scanConstants.regionSummaryChars, JSON.stringify(sum6.text))

  // ═══ 10. D1（20260915 追加）：模型摘要优先归档，机械条目降级为兜底 ══════
  // 事件 fixture 全是占位字段（隐私铁律：正文只许假占位串）。事件真实字段名
  // （compactionId/summary/shadowedSeqs/shadowedTokenCount/provider/model）由
  // collect-scan.normalizeSummaryEventDoc 按官方 compaction-basic 源码逐字对齐。
  // ★ 反证锚点（运行者手工执行并留档）：把 lib/collect-scan.js selectModelSummary 的
  //   `if (covering.length > 1)` 分支改成「返回 covering[0] 当模型摘要」⇒ 10d 必须变红；
  //   还原后复绿。
  const MS_TEXT = '模型摘要占位甲甲占位乙乙占位丙丙（假）'
  const MS_TAGS_LINE = '\ntags: {"vibe":"Suspense","special":[],"important":true}'
  const mkSummaryDoc = (eventSeq, seqs, text, tagsLine) => ({
    seq: eventSeq,
    type: 'compaction/summary',
    data: {
      compactionId: 'cp-' + eventSeq,
      provider: 'prov-x',
      model: 'model-x',
      shadowedTokenCount: 123,
      shadowedSeqs: seqs,
      summary: [{ type: 'text', text: text + (tagsLine || '') }],
    },
  })
  const bySeqD1 = new Map([
    [0, { surface: 'shadowed', text: FIX[0], type: 'user/message' }],
    [1, { surface: 'shadowed', text: FIX[1], type: 'assistant/message' }],
    [2, { surface: 'shadowed', text: FIX[3], type: 'user/message' }],
  ])
  const regionsD1 = findShadowRegions(bySeqD1)
  const inputD1 = { sessionId: 'sess-d1', target: { characterId: 'charD1', playthroughId: 'ptD1' } }
  const depsD1 = (events, withLoader = true) => ({
    loadSurfaces: async () => bySeqD1,
    maxExistingFloor: async () => null,
    collect: makeFakeCollect().collect,
    dshHome: mkdtempSync(join(workRoot, 'd1-')),
    ...(withLoader ? { loadSummaryEvents: async () => events } : {}),
  })
  const regionOf = (plan) => plan.regions.find((r) => !r.skipped)

  // ① 唯一覆盖 ⇒ model-summary，正文逐字等于事件 summary + 元数据 + tags 收编
  const p10a = await planScan(inputD1, depsD1([mkSummaryDoc(9, [0, 1, 2], MS_TEXT, MS_TAGS_LINE)]))
  const r10a = regionOf(p10a)
  check('10a', '唯一覆盖 ⇒ kind=model-summary 且正文逐字等于事件里的那份',
    r10a && r10a.summaryKind === 'model-summary' && r10a.summary && r10a.summary.text === MS_TEXT + MS_TAGS_LINE,
    JSON.stringify(r10a && { kind: r10a.summaryKind, head: (r10a.summary && r10a.summary.text || '').slice(0, 12) }))
  check('10b', '事件元数据进 summary.meta（compactionId/model/provider/shadowedTokenCount/eventSeq）',
    r10a && r10a.summary && isMetaEq(r10a.summary.meta, { kind: 'model-summary', compactionId: 'cp-9', provider: 'prov-x', model: 'model-x', shadowedTokenCount: 123, eventSeq: 9, tags: ['Suspense', 'Important'] }),
    JSON.stringify(r10a && r10a.summary && r10a.summary.meta))
  check('10c', 'tags 行收编成扁平枚举数组 [Suspense, Important]（大小写归一 + Important 收编）',
    r10a && r10a.summary && r10a.summary.meta && JSON.stringify(r10a.summary.meta.tags) === JSON.stringify(['Suspense', 'Important']),
    JSON.stringify(r10a && r10a.summary && r10a.summary.meta && r10a.summary.meta.tags))

  // ② 两条事件都覆盖同一区间 ⇒ 回落机械条目 + ambiguous-coverage（正文=机械截断，逐字）
  const p10d = await planScan(inputD1, depsD1([mkSummaryDoc(9, [0, 1, 2], MS_TEXT), mkSummaryDoc(10, [0, 1, 2, 3], MS_TEXT)]))
  const r10d = regionOf(p10d)
  check('10d', '覆盖不唯一 ⇒ mechanical + 正文与机械口径逐字相同 + warnings 含 ambiguous-coverage',
    r10d && r10d.summaryKind === 'mechanical' && r10d.summaryFallback === 'ambiguous-coverage'
      && r10d.summary.text === buildRegionSummary(regionsD1[0]).text
      && p10d.warnings.some((w) => w.includes('ambiguous-coverage')),
    JSON.stringify(r10d && { kind: r10d.summaryKind, why: r10d.summaryFallback }))

  // ③ 无任何 summary 事件（纯机械路径）⇒ mechanical，正文与改动前逐字相同（固定 fixture）
  const p10e = await planScan(inputD1, depsD1([]))
  const r10e = regionOf(p10e)
  check('10e', '无事件 ⇒ mechanical + 正文=buildRegionSummary 逐字（改动前行为不变）+ no-model-summary',
    r10e && r10e.summaryKind === 'mechanical' && r10e.summary.text === buildRegionSummary(regionsD1[0]).text
      && p10e.warnings.some((w) => w.includes('no-model-summary')),
    JSON.stringify(r10e && { kind: r10e.summaryKind, same: r10e.summary.text === buildRegionSummary(regionsD1[0]).text }))

  // ④ 模型摘要正文为空 ⇒ 回落 + no-model-summary（空串与空块数组两种都算空）
  const p10f = await planScan(inputD1, depsD1([{ seq: 9, type: 'compaction/summary', data: { compactionId: 'cp-9', shadowedSeqs: [0, 1, 2], summary: [] } }]))
  const r10f = regionOf(p10f)
  const p10f2 = await planScan(inputD1, depsD1([mkSummaryDoc(9, [0, 1, 2], '', '')]))
  const r10f2 = regionOf(p10f2)
  check('10f', '模型摘要为空（空块/空串）⇒ mechanical + warnings 含 no-model-summary',
    r10f && r10f.summaryKind === 'mechanical' && r10f.summaryFallback === 'no-model-summary'
      && r10f2 && r10f2.summaryKind === 'mechanical' && r10f2.summaryFallback === 'no-model-summary'
      && p10f.warnings.some((w) => w.includes('no-model-summary')),
    JSON.stringify([r10f, r10f2].map((r) => r && { kind: r.summaryKind, why: r.summaryFallback })))

  // ⑤ tags 没给 ⇒ 空数组 + tags-empty；给错 ⇒ 词表外的剔除（tags-partial），词表内的留下
  const p10g = await planScan(inputD1, depsD1([mkSummaryDoc(9, [0, 1, 2], MS_TEXT, '')]))
  const r10g = regionOf(p10g)
  check('10g', '模型没给 tags ⇒ meta.tags=[] + warnings 含 tags-empty',
    r10g && r10g.summaryKind === 'model-summary' && JSON.stringify(r10g.summary.meta.tags) === '[]'
      && p10g.warnings.some((w) => w.includes('tags-empty')),
    JSON.stringify({ tags: r10g && r10g.summary.meta.tags }))
  const p10h = await planScan(inputD1, depsD1([mkSummaryDoc(9, [0, 1, 2], MS_TEXT, '\ntags: {"vibe":"Nope","special":["Daily","占位外","Daily"],"important":"x"}')]))
  const r10h = regionOf(p10h)
  check('10h', 'tags 给错 ⇒ 只留词表内 [Daily] + warnings 含 tags-partial（⛔ 不编）',
    r10h && r10h.summaryKind === 'model-summary' && JSON.stringify(r10h.summary.meta.tags) === JSON.stringify(['Daily'])
      && p10h.warnings.some((w) => w.includes('tags-partial')),
    JSON.stringify({ tags: r10h && r10h.summary.meta.tags }))

  // ⑥ deps 不注入 loadSummaryEvents ⇒ 全机械 + plan 级 warning（路径不可用要如实说）
  const p10i = await planScan(inputD1, depsD1(null, false))
  const r10i = regionOf(p10i)
  check('10i', '未注入 loadSummaryEvents ⇒ mechanical + plan 级 warning 点名 loadSummaryEvents',
    r10i && r10i.summaryKind === 'mechanical' && p10i.warnings.some((w) => w.includes('loadSummaryEvents')),
    JSON.stringify(p10i.warnings))

  // ⑦ 隐私：模型摘要占位正文不出现在 warnings（正文不出网，与既有第 8 条同纪律）
  check('10j', '模型摘要正文不在 plan.warnings 里',
    ![p10a, p10d, p10e, p10f, p10g, p10h, p10i].some((p) => p.warnings.some((w) => w.includes(MS_TEXT))),
    'warnings 泄漏正文')
  function isMetaEq(meta, want) {
    return JSON.stringify(meta) === JSON.stringify(want)
  }
} finally {
  // 8d 的判定必须在全部输出之后做：自检自己的输出也不能带 fixture 前 12 字
  check('8d', 'fixture 前 12 字不在自检输出里', !outBuf.join('\n').includes(FIX12))
  out(`── ${pass} 通过 / ${fail} 失败 ──`)
  rmSync(workRoot, { recursive: true, force: true })
}
process.exitCode = fail === 0 ? 0 : 1
