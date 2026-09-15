/**
 * _selftest-echo-index.mjs —— lib/echo-index.js 行为级自检（E1–E6、E8–E10）。
 * 跑法：node --no-warnings _selftest-echo-index.mjs
 * 存储一律用临时目录（⛔ 不碰真 ~/.dsh）；E9 用真语料（只读）复现实测基线。
 * 隐私：fixture 正文用碎片运行时拼接（无 ≥12 字连续字面量）；输出只打印长度/哈希/计数。
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  extractSegments, extractCandidates, contentHashOf, makeDocKey,
  openEchoIndex, openEchoIndexSafe, searchEchoSafely, readArchiveFloors,
} from './lib/echo-index.js'

let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`PASS ${name}`)
  else { failures++; console.log(`FAIL ${name}${detail ? ' —— ' + detail : ''}`) }
}

// ---- fixtures：实体都由两个碎片拼出（E10：拼接结果绝不成字面量） ----
const ent = (parts) => parts.join('')
const E = {
  key: ent(['铜', '钥匙']),    // 3 字
  lan: ent(['长街', '灯笼']),  // 4 字
  bell: ent(['钟楼', '铜铃']),
  rain: ent(['雨夜', '青石']),
  com: ent(['一人', '一半']),  // 放进全部楼层 → df=9（E3 的超窗样本）
  rare: ent(['琥珀', '色瓶']), // 只在楼 8 → df=1（E3 的孤楼样本）
  tail8: ent(['没署', '名的信']),
  tail9: ent(['他数着', '铜板']),
}
const SPEC = [
  { floor: 1, parts: ['key', 'rain'] },
  { floor: 2, parts: ['lan', 'bell'] },
  { floor: 3, parts: ['key', 'lan'] },
  { floor: 4, parts: ['rain', 'bell'] },
  { floor: 5, parts: ['key', 'bell'] },
  { floor: 6, parts: ['lan', 'rain'] },
  { floor: 7, parts: ['key', 'lan', 'rain'] },
  { floor: 8, parts: ['rare', 'tail8'] },
  { floor: 9, parts: ['key', 'bell', 'tail9'] },
]
const bodyOf = (parts) => [...parts.map((p) => E[p]), E.com].join('。')
const mkDocs = (spec, source) =>
  spec.map((s) => ({ floor: s.floor, text: bodyOf(s.parts), source }))
const docsA = mkDocs(SPEC.slice(0, 8), 't1')
const fixtureBodies = SPEC.map((s) => bodyOf(s.parts))
check('fixture 自检：每条正文 ≥13 字（E10 的前 12 字检查才有牙齿）', fixtureBodies.every((b) => b.length >= 13))

const ROOT = mkdtempSync(join(tmpdir(), 'echo-idx-selftest-'))

// ---- E1：≤2 字候选一律丢 ----
check('E1 长度≤2 的输入 ⇒ 0 候选（默认门槛 3）', extractCandidates('钥匙').length === 0 && extractCandidates('雨').length === 0)
const e1broken = extractCandidates('钥匙', { minLen: 2, maxLen: 2 })
check('E1 反证：门槛放宽到 2 ⇒ 会产出 1 个候选（断言会红）', e1broken.length === 1 && e1broken[0].length === 2, `n=${e1broken.length}`)

// ---- E2：跨标点/换行不取窗口（先切段再滑窗） ----
const e2text = '他抬头。' + E.key + '，' + E.lan + '\n' + E.rain
const e2segs = extractSegments(e2text)
const e2cands = extractCandidates(e2text)
const e2allInside = e2cands.every((c) => e2segs.some((seg) => seg.includes(c)))
check('E2 切段数正确（标点/逗号/换行都是切点）', e2segs.length === 4, `segs=${e2segs.length}`)
check('E2 每个候选都完整落在某一段内（无跨界窗口）', e2allInside && !e2cands.includes('头' + E.key[0]))
const e2brokenSet = new Set()
{
  const stripped = e2text.replace(/[^\u3400-\u9fff\uf900-\ufaffA-Za-z0-9]/g, '')
  for (let i = 0; i + 3 <= stripped.length; i++) e2brokenSet.add(stripped.slice(i, i + 3))
}
check('E2 反证：先剥标点再滑窗 ⇒ 产出跨段窗口（断言会红）', [...e2brokenSet].some((c) => !e2segs.some((seg) => seg.includes(c))))

// ---- E3：df 窗口过滤（默认口径在 E6 用；这里用小窗验证规则本身） ----
{
  const idx = openEchoIndex({ storageDir: join(ROOT, 'e3') })
  idx.ingestFloors(mkDocs(SPEC, 't3'), {})
  const raw = extractCandidates(docsA.map((d) => d.text).join('。'))
  const kept = idx.filterCandidatesByDf(raw, { minDf: 2, maxDf: 5, maxCandidates: 100 })
  const df = idx.candidateDf(raw)
  check('E3 df∈[2,5]：保留中频候选', kept.includes(E.key) && kept.includes('长街灯'), `kept=${kept.length}`)
  check('E3 排除 df=1 的孤楼候选', !kept.includes('琥珀色') && !kept.includes('珀色瓶'))
  check('E3 排除 df=9 的超窗候选', !kept.includes('一人一') && !kept.includes('人一半'))
  check('E3 排序：df 居中（4，中点 3.5）排在 df=5 前面', kept.indexOf('长街灯') < kept.indexOf(E.key))
  const broken = raw.filter((c) => (df.get(c) ?? 0) >= 1)
  check('E3 反证：去掉 df 过滤 ⇒ df=1/df=9 候选都会混入（断言会红）',
    broken.includes('一人一') && broken.includes('琥珀色'))
  idx.close()
}

// ---- E4：增量幂等（同一归档第二遍 0 入库） ----
{
  const idx = openEchoIndex({ storageDir: join(ROOT, 'e4') })
  const first = idx.ingestFloors(docsA, {})
  const second = idx.ingestFloors(docsA, {})
  check('E4 第一遍 inserted=8', first.inserted === 8 && first.replaced === 0, JSON.stringify({ i: first.inserted, r: first.replaced, s: first.skipped }))
  check('E4 第二遍全部 skipped（0 入库 0 替换）', second.inserted === 0 && second.replaced === 0 && second.skipped === 8)
  check('E4 meta 行数不变', idx.metaCount() === 8, `meta=${idx.metaCount()}`)
  const forced = idx.ingestFloors(docsA, { force: true })
  check('E4 反证：去掉哈希比对（force）⇒ 第二遍会整批重写（断言会红）', forced.inserted === 8 && forced.skipped === 0)
  idx.close()
}

// ---- E5：内容变化 ⇒ 同一 docKey 被替换（不是新增） ----
{
  const idx = openEchoIndex({ storageDir: join(ROOT, 'e5') })
  const src = 't5'
  const old5 = { floor: 5, text: bodyOf(['key', 'bell']), source: src }
  const new5 = { floor: 5, text: bodyOf(['key', 'lan']), source: src }
  idx.ingestFloors([old5], {})
  const dk = makeDocKey(src, 5)
  const r = idx.ingestFloors([new5], {})
  check('E5 变更 ⇒ replaced=1 / inserted=0', r.replaced === 1 && r.inserted === 0)
  check('E5 同一 docKey 在 FTS 里仍只有 1 行', idx.rowVersions(dk) === 1, `rows=${idx.rowVersions(dk)}`)
  check('E5 meta 行数不涨', idx.metaCount() === 1)
  check('E5 新内容可查、旧内容已不在该楼', idx.search({ candidates: ['长街灯'], source: src }).some((h) => h.floor === 5)
    && idx.search({ candidates: ['楼铜铃'], source: src }).length === 0)
  idx.ingestFloors([{ floor: 5, text: bodyOf(['key', 'rain']), source: src }], { replace: false })
  check('E5 反证：不删旧行 ⇒ 同 docKey 变 2 行（断言会红）', idx.rowVersions(dk) === 2, `rows=${idx.rowVersions(dk)}`)
  idx.close()
}

// ---- E6：排除自身（最新楼层绝不出现在回响里） ----
{
  const idx = openEchoIndex({ storageDir: join(ROOT, 'e6') })
  const docs = mkDocs(SPEC, 't6')
  idx.ingestFloors(docs, {})
  const queryText = docs[8].text // 最新一轮 = 楼 9
  const cands = idx.filterCandidatesByDf(extractCandidates(queryText), { minDf: 2, maxDf: 12, maxCandidates: 12 })
  const good = idx.search({ candidates: cands, excludeFloors: [9], source: 't6', topK: 5 })
  check('E6 结果里没有楼 9', good.every((h) => h.floor !== 9), JSON.stringify(good.map((h) => h.floor)))
  check('E6 共现楼排最前（楼 5 与最新一轮共享两个实体）', good[0]?.floor === 5)
  const bad = idx.search({ candidates: cands, source: 't6', topK: 5 })
  check('E6 反证：去掉排除 ⇒ 楼 9 冲到第一位（断言会红）', bad[0]?.floor === 9, JSON.stringify(bad.map((h) => h.floor)))
  idx.close()
}

// ---- E8：库损坏 ⇒ 空回响、不抛（fail-silent） ----
{
  const dir = join(ROOT, 'e8')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'echo-index.db'), '这不是一个 sqlite 库文件，纯粹是垃圾字节 0123456789')
  const safe = openEchoIndexSafe({ storageDir: dir })
  check('E8 损坏库 ⇒ openEchoIndexSafe 返回 index=null + error（不抛）', safe.index === null && safe.error != null)
  const q = searchEchoSafely(safe.index, { candidates: [E.key], topK: 5 })
  check('E8 查询走安全包装 ⇒ hits=[] 且 failed=true（不抛）', q.hits.length === 0 && q.failed === true)
  let threw = false
  try { openEchoIndex({ storageDir: dir }) } catch { threw = true }
  check('E8 反证：不走安全包装 ⇒ 打开损坏库真的会抛（断言会红）', threw === true)
}

// ---- E9：★ 真语料复现（只读；输出只有聚合数字）----
// 语料路径由环境变量给（本机数据 ⇒ ⛔ 绝对路径不进仓库）；没设就跳过这条。
const CORPUS_FLOORS = process.env.DMA_CORPUS_FLOORS ?? ''
if (CORPUS_FLOORS === '') {
  console.log('E9 跳过：未设 DMA_CORPUS_FLOORS（真语料复现只在装了该语料的机器上跑）')
} else try {
  const floors = readArchiveFloors(CORPUS_FLOORS)
  const totalChars = floors.reduce((n, f) => n + f.text.length, 0)
  const idx = openEchoIndex({ storageDir: join(ROOT, 'e9') })
  const t0 = performance.now()
  const ing = idx.ingestFloors(floors.map((f) => ({ ...f, source: 'corpus' })), {})
  const buildMs = performance.now() - t0
  console.log(`E9 语料：floors=${floors.length}  mes 合计=${totalChars} 字（实测基线：254 楼 / 105,746 字）`)
  console.log(`E9 建索引：${buildMs.toFixed(0)} ms（含入库）；索引体积 ${(idx.indexBytes() / 1024 / 1024).toFixed(2)} MB（基线 ≈1.83 MB）；入库计数 ${JSON.stringify({ i: ing.inserted, s: ing.skipped, e: ing.empty })}`)
  let queries = 0
  let echoed = 0
  let candSum = 0
  const t1 = performance.now()
  for (let i = 0; i < floors.length; i += 10) { // 与实测脚本同款采样：每 10 楼取 1
    const f = floors[i]
    const cands = idx.filterCandidatesByDf(extractCandidates(f.text), { minDf: 2, maxDf: 12, maxCandidates: 3 })
    candSum += cands.length
    for (const c of cands) {
      const r = searchEchoSafely(idx, { candidates: [c], excludeFloors: [f.floor], topK: 5 })
      queries++
      if (r.hits.length > 0) echoed++
    }
  }
  const qMs = performance.now() - t1
  const rate = queries ? (100 * echoed / queries) : 0
  console.log(`E9 查询：采样 ${Math.ceil(floors.length / 10)} 楼 → ${queries} 次单候选查询（共 ${qMs.toFixed(0)} ms）；回声命中率 ${rate.toFixed(1)}%（实测基线 100%，门槛 ≥90%）`)
  check('E9 真语料回声命中率 ≥90%', queries > 0 && rate >= 90, `rate=${rate.toFixed(1)}% queries=${queries}`)
  check('E9 真语料规模与实测基线一致（254 楼）', floors.length === 254, `floors=${floors.length}`)
  idx.close()
} catch (e) {
  check('E9 真语料复现（设了 DMA_CORPUS_FLOORS 却读不到语料 ⇒ 本条红）', false, String(e && e.message ? e.message : e))
}

// ---- E10：fixture 正文前 12 字在三处零命中 ----
{
  const prefixes = [...new Set(fixtureBodies.map((b) => b.slice(0, 12)))]
  const files = [
    join(dirname(fileURLToPath(import.meta.url)), 'lib', 'echo-index.js'),
    join(dirname(fileURLToPath(import.meta.url)), 'lib', 'echo-inject.js'),
    fileURLToPath(import.meta.url),
  ]
  let hits = 0
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    for (const p of prefixes) if (src.includes(p)) hits++
  }
  check('E10 fixture 正文前 12 字 × 新模块×2 + 本自检台 ⇒ 0 命中（自检输出本就只打印计数）', hits === 0, `hits=${hits} prefixes=${prefixes.length}`)
}

try { rmSync(ROOT, { recursive: true, force: true }) } catch {}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
