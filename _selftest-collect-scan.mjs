/**
 * A2 自检台：lib/collect-scan.js —— 行为级；手搓**原始事件**（带 data 的 SessionEvent 形状）
 * + 临时台账目录，零宿主、零真 Tavern、零 LLM。
 * 运行：node _selftest-collect-scan.mjs（结束自动删掉自建临时目录）。
 *
 * ★★ 2026-09-22「一次压缩一段」：本台子随口径一起改了数据形状 —— 喂进去的不再是
 *   `Map<seq,{surface,text,type}>`（宿主 collectSurfaces 的检索文档形状），而是**原始事件数组**
 *   （`{seq,type,surface,data}`，字段名照派单任务书 §1 与 lib/prompt-viewer.js 的真机实测）。
 *   第 13 节是任务书 §3 要求的六对（相 + 反证），反证一律**真的把旧写法改回去跑一遍**
 *   （拷一份 lib 到临时目录 → 只改那一处 → import 那份副本）⇒ 同一套夹具下必红。
 *   第 12 节（20260922 手动/HTTP 那条路的 base）是同样的手法，跑**真 HTTP 的假 Tavern**
 *   （`_selftest-fake-tavern.mjs`，契约级）做端到端 —— 基线仍然是零宿主、零真 Tavern。
 * 隐私：fixture 全是明显假的占位正文；自检输出/台账/collect-scan.js 三处对 fixture 前 12 字零命中（第 8 条锁死）。
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  findShadowRegionsFromEvents,
  regionContentHash,
  buildRegionSummary,
  mapRegionToFloors,
  readLedger,
  writeLedger,
  planScan,
  applyScan,
  scanConstants,
  selectModelSummary,
  normalizeReplacementEventDoc,
  routeTavernBase,
  reqLikeFromBase,
  makeA1Tavern,
  collectOnce,
  handleCollectScan,
  handleCollectAuto,
} from './lib/collect-scan.js'
import { createFakeTavern } from './_selftest-fake-tavern.mjs'
import { TAG_VOCABULARY } from './lib/ami-tags.js'

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

// ═══ 原始事件的小工厂（真机字段名；正文一律占位串）═══════════════════════════════════
// 形状依据（逐字，不是猜的）：
//   · user/message      ⇒ `{role:'user', content:[…], source:{kind,…}}`（prompt-viewer 真机实测）
//   · assistant/message ⇒ `{message:{role:'assistant', content:[…]}}`（思维链在 reasoning 块里）
//   · tool/call·result  ⇒ 同上 message 形状
//   · compaction/*      ⇒ data 直接是负载（compactionId/summary/shadowedSeqs/…，任务书 §1-⑦）
//   · surface 只有 'current' / 'shadowed' / 'log-only'
const ev = (seq, type, data, surface = 'shadowed') => ({ sessionId: 'sess-x', seq, type, time: seq, surface, data })
const USER = (seq, text, sourceKind, surface) =>
  ev(seq, 'user/message', { role: 'user', content: [{ type: 'text', text }], ...(sourceKind === null || sourceKind === undefined ? {} : { source: { kind: sourceKind } }) }, surface)
const ASST = (seq, blocks, surface) => ev(seq, 'assistant/message', { message: { role: 'assistant', content: blocks } }, surface)
const TEXT = (t) => ({ type: 'text', text: t })
const REASON = (t) => ({ type: 'reasoning', text: t })
const TOOLCALL_BLOCK = (t) => ({ type: 'text', text: t }, { type: 'tool-call', toolCallId: 'c-' + t.length, name: 'memory_write', arguments: '{"占位":1}' })
const TOOL_CALL_EV = (seq, text) => ev(seq, 'tool/call', { message: { role: 'assistant', content: [TOOLCALL_BLOCK(text)[0], TOOLCALL_BLOCK(text)[1]] } })
const TOOL_RESULT_EV = (seq, text) => ev(seq, 'tool/result', { message: { role: 'tool', content: [TEXT(text)] } })
/** 压缩的**替换事件**：shadowedRange 故意 start > end（官方那是「面位置跨度」不是数字区间，§1-⑦）。 */
const SUMMARY_EV = (seq, seqs, summaryText, extra) =>
  ev(seq, 'compaction/summary', {
    compactionId: 'cp-' + seq, provider: 'prov-x', model: 'model-x', shadowedTokenCount: 123,
    shadowedSeqs: seqs,
    shadowedRange: { start: Math.max(...seqs) * 10, end: Math.min(...seqs) * 10 },
    ...(summaryText === null ? {} : { summary: [TEXT(summaryText)] }),
    ...(extra || {}),
  }, 'current')
const PRUNE_EV = (seq, seqs) =>
  ev(seq, 'compaction/prune', {
    shadowedSeqs: seqs, shadowedRange: { start: Math.max(...seqs) * 10, end: Math.min(...seqs) * 10 }, shadowedTokenCount: 99,
  }, 'current')
/** 紧跟替换事件之后的那条 user/message = 官方英文 checkpoint 前言（不是玩家消息）。*/
const CHECKPOINT_EV = (seq, text) => USER(seq, text, null, 'current')

const T_REASON = '思维链占位串（⛔ 不该进楼）'
const T_TOOLCALL = '工具调用占位串（⛔ 不该进楼）'
const T_TOOLRESULT = '工具结果占位串（⛔ 不该进楼）'
const T_PLUGIN = '【占位】插件注入的后处理提示词（⛔ 不是玩家发言）'
const T_SKILL = '技能清单占位串（⛔ 不是玩家发言）'
const T_CHECKPOINT = 'This is an automatically generated checkpoint condensing an earlier span of the conversation (占位，⛔ 不是玩家消息).'
const MS13 = '模型摘要占位甲甲占位乙乙占位丙丙（假）'

/** 第 13 节的基础夹具：一次 compaction/summary + 紧随其后的英文 checkpoint（非连续 shadowedSeqs）。*/
function events13() {
  return [
    USER(0, FIX[0], 'user'),
    ASST(1, [REASON(T_REASON), TEXT(FIX[1])]),
    TOOL_CALL_EV(2, T_TOOLCALL),
    TOOL_RESULT_EV(3, T_TOOLRESULT),
    USER(4, T_PLUGIN, 'plugin'),
    ASST(5, [REASON(T_REASON), TOOLCALL_BLOCK(T_TOOLCALL)[1]]), // 全是工具调用/思维链块 ⇒ 取不到正文 ⇒ 不成楼
    USER(6, T_SKILL, 'skill-catalog', 'current'), // ⛔ 不在 shadowedSeqs 里（它正是"不连续"的那一段空隙）
    USER(7, FIX[3], 'user'),
    ASST(8, [TEXT(FIX[5])]),
    SUMMARY_EV(9, [0, 1, 2, 3, 4, 5, 7, 8], MS13),
    CHECKPOINT_EV(10, T_CHECKPOINT),
  ]
}
/** 13 的续接：再来一次替换（prune），把 checkpoint 与它后面的真对话一起遮蔽 ⇒ checkpoint 落进区间。*/
function events13b() {
  return [
    ...events13(),
    USER(11, FIX[6], 'user'),
    ASST(12, [TEXT(FIX[4])]),
    PRUNE_EV(13, [10, 11, 12]),
  ]
}
/** 13 的全 tool 区间：一条替换，遮的全是 tool/result ⇒ 0 楼。*/
function events13c() {
  return [
    USER(0, FIX[0], 'user', 'current'),
    TOOL_RESULT_EV(1, T_TOOLRESULT),
    TOOL_RESULT_EV(2, T_TOOLRESULT),
    SUMMARY_EV(3, [1, 2], MS13),
  ]
}

/** 只取正文（自检侧的断言助手）：区间的楼正文数组。 */
const floorsOf = (region, startFloor = 0) => mapRegionToFloors(region, startFloor).floors.map((f) => f.text)

try {
  // ═══ 1. 区间切分：**一条替换 = 一个区间**（判据 = 替换事件自带的 shadowedSeqs）═══════
  const regions13 = findShadowRegionsFromEvents(events13())
  check('1a', '★ 一条 compaction/summary ⇒ **恰好 1 个区间**（⛔ 不再按相邻 seq 切）', regions13.length === 1, `得到 ${regions13.length}`)
  check('1b', '区间 id/跨度 = region-0-8（min/max 只用于标识，docs 顺序是面顺序）',
    regions13[0] && regions13[0].regionId === 'region-0-8' && regions13[0].fromSeq === 0 && regions13[0].toSeq === 8,
    JSON.stringify(regions13[0] && { id: regions13[0].regionId, from: regions13[0].fromSeq, to: regions13[0].toSeq }))
  check('1c', '★ 区间里的 seq 集合 = 该事件自己的 shadowedSeqs（8 个，缺 6 就是缺 6）',
    regions13[0] && regions13[0].docs.map((d) => d.seq).join(',') === '0,1,2,3,4,5,7,8',
    JSON.stringify(regions13[0] && regions13[0].docs.map((d) => d.seq)))
  check('1d', '★ docs 顺序 = **面顺序**（⛔ 不排序）：给乱序 shadowedSeqs ⇒ 原样保留',
    (() => {
      const rs = findShadowRegionsFromEvents([...events13(), SUMMARY_EV(20, [5, 1, 3], MS13)])
      const r = rs[1]
      return r && r.docs.map((d) => d.seq).join(',') === '5,1,3' && r.regionId === 'region-1-5'
    })(), '')
  check('1e', '⛔ 没有替换事件 ⇒ 0 区间（区间不再由 surface 状态推出）',
    findShadowRegionsFromEvents([USER(0, FIX[0], 'user'), ASST(1, [TEXT(FIX[1])])]).length === 0, '')
  // ★ 反证锚点（第 13 节会**真跑**一遍旧写法）：旧判据「相邻 seq 即归一段」在同一夹具上给出 2 个区间。
  //   这里先把"同一夹具、旧判据、只看 seq 相邻"的答案算出来（纯算术，不碰源码），第 13 节拿它做对照。
  const adjacentRunsOf = (region) => {
    const seqs = [...new Set(region.docs.map((d) => d.seq))].sort((a, b) => a - b)
    let runs = 0
    for (let i = 0; i < seqs.length; i++) if (i === 0 || seqs[i] !== seqs[i - 1] + 1) runs += 1
    return runs
  }
  check('1f', '⚠️ 反证锚点：同一夹具按「相邻即归一段」算 = **2** 个区间（新判据 = 1）',
    adjacentRunsOf(regions13[0]) === 2, `得到 ${adjacentRunsOf(regions13[0])}`)

  // ═══ 2. contentHash 可复算 ═════════════════════════════════════════════
  const h1 = regionContentHash(regions13[0])
  const h1b = regionContentHash(regions13[0])
  check('2a', '同输入两次相同且是 64 位十六进制', h1 === h1b && /^[0-9a-f]{64}$/.test(h1))
  const shuffled = { ...regions13[0], docs: [...regions13[0].docs].reverse() }
  check('2b', 'seq 顺序打乱 ⇒ 哈希必须不同', regionContentHash(shuffled) !== h1)
  check('2c', '哈希等于口径直算值（docs 正文按 \\n 拼接 sha256，顺序 = 面顺序）',
    h1 === sha(regions13[0].docs.map((d) => d.text).join('\n')), '')

  // ═══ 3. 映射：工具事件既不单独成楼、也不并进前一条楼 ══════════════════════
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
  check('3b', '★ tool/result 的正文**不并进**前一条楼（2026-09-22 收紧：工具不是对话）',
    m3.floors[0].text === '楼正文AAA' && m3.floors[1].text === '楼正文CCC', JSON.stringify(m3.floors.map((f) => f.text)))
  check('3c', '第二条楼独立', m3.floors[1].text === '楼正文CCC')
  check(
    '3d',
    'name 恒（来自会话）/ is_system 恒 false / is_user 按 type',
    m3.floors.every((f) => f.name === '（来自会话）' && f.isSystem === false && f.isUser === false),
  )
  const r3b = {
    regionId: 'r3b',
    fromSeq: 0,
    toSeq: 2,
    docs: [
      { seq: 0, surface: 'shadowed', text: FIX[0], type: 'user/message' },
      { seq: 1, surface: 'shadowed', text: '全是工具调用块（取不到正文）', type: 'compaction/summary' },
      { seq: 2, surface: 'shadowed', text: '别的机制正文', type: 'request/header' },
    ],
  }
  check('3e', '其余类型照旧并入前一条楼（\\n 接）—— 只有 user/assistant 成楼、tool 被排除',
    mapRegionToFloors(r3b, 0).floors[0].text === FIX[0] + '\n' + '全是工具调用块（取不到正文）' + '\n' + '别的机制正文',
    JSON.stringify(mapRegionToFloors(r3b, 0).floors[0].text))

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

  // ═══ 4′. 清洗②（2026-09-20 用户口径：「也不被记忆库收录」）═══════════════════
  //   插件注入的 user 消息（本插件的后处理提示词、技能清单、官方运行上下文快照）**不是对话**
  //   ⇒ ⛔ 既不成楼、也不并进前一条楼。判据是**结构性的 `source.kind`**（真机三种取值：
  //   'user' 玩家 / 'plugin' 插件 / 'skill-catalog' 技能目录）——⛔ 不是文本前缀、⛔ 不是正则。
  const r5 = {
    regionId: 'r5',
    fromSeq: 0,
    toSeq: 4,
    docs: [
      { seq: 0, surface: 'shadowed', text: '玩家说', type: 'user/message', sourceKind: 'user' },
      { seq: 1, surface: 'shadowed', text: '角色答', type: 'assistant/message', sourceKind: null },
      { seq: 2, surface: 'shadowed', text: '【角色卡的后处理指令 · 由插件注入，不是玩家发言】破甲词', type: 'user/message', sourceKind: 'plugin' },
      { seq: 3, surface: 'shadowed', text: '技能清单正文', type: 'user/message', sourceKind: 'skill-catalog' },
      { seq: 4, surface: 'shadowed', text: '玩家又说', type: 'user/message', sourceKind: 'user' },
    ],
  }
  const m5 = mapRegionToFloors(r5, 0)
  check('4c', '★ 插件注入的 user 消息（plugin · skill-catalog）**都不是楼**', m5.floors.length === 3, `楼数 ${m5.floors.length}（期望 3：玩家/角色/玩家）`)
  check('4d', '★ 它们的正文**不许并进**前一条楼', m5.floors.every((f) => !f.text.includes('破甲词') && !f.text.includes('技能清单正文')), JSON.stringify(m5.floors.map((f) => f.text)))
  check('4e', '★ 工具事件（tool/result）也不再并进前一条楼（旧口径是"照旧并进"，本单收紧）',
    m5.floors[1].text === '角色答', JSON.stringify(m5.floors[1].text))
  check('4f', '楼号连续、只数真楼', m5.floors.map((f) => f.floor).join(',') === '0,1,2' && m5.nextFloor === 3, m5.floors.map((f) => f.floor).join(',') + ' / next=' + m5.nextFloor)
  // ★ 反证：kind 缺失（老日志）⇒ **照旧当楼**（那可能是真玩家消息，⛔ 不许因为"认不出"就丢掉）
  const r5b = { regionId: 'r5b', fromSeq: 0, toSeq: 0, docs: [{ seq: 0, surface: 'shadowed', text: '老的玩家消息', type: 'user/message' }] }
  check('4g', '★ 反证：kind 缺失 ⇒ 照旧成楼（不静默丢真消息）', mapRegionToFloors(r5b, 0).floors.length === 1, '')

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
          // ★ 2026-09-22「摘要按段切片」：假后端照 A1 的**两条路**走 —— 单份（老路）落
          //   `s-<from>-<to>.md`（口径与改造前逐字一致）；`summaries`（N 份）**每份按各自的 id
          //   落一个文件**（A1 的 summaryPathOf 就是这个口径：id 带 `-N` 后缀 ⇒ 落点自然分开）。
          const summaryDocs = Array.isArray(request.summaries) && request.summaries.length > 0
            ? request.summaries.map((s) => ({
                path: `archive/${request.characterId}/${request.playthroughId}/summaries/${s.id}.md`,
                text: s.text,
              }))
            : [{
                path: `archive/${request.characterId}/${request.playthroughId}/summaries/s-${pad4(floors[0].floor)}-${pad4(floors[floors.length - 1].floor)}.md`,
                text: request.summary.text,
              }]
          for (const d of summaryDocs) willWrite.push({ path: d.path, bytes: d.text.length, sha256: sha(d.text) })
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
  // 三次压缩 ⇒ 三个区间（每次压缩后面都跟着它自己的 checkpoint 替换节点 ⇒ 那条**不成楼**）
  const events5 = [
    USER(0, FIX[0], 'user'),
    ASST(1, [TEXT(FIX[1])]),
    SUMMARY_EV(2, [0, 1], '模型摘要占位一（假）'),
    CHECKPOINT_EV(3, T_CHECKPOINT),
    USER(4, FIX[3], 'user'),
    ASST(5, [TEXT(FIX[5])]),
    SUMMARY_EV(6, [3, 4, 5], '模型摘要占位二（假）'),
    CHECKPOINT_EV(7, T_CHECKPOINT),
    USER(8, FIX[6], 'user'),
    SUMMARY_EV(9, [7, 8], '模型摘要占位三（假）'),
  ]
  const dep5 = makeFakeCollect()
  const dsh5 = mkdtempSync(join(workRoot, 'dsh5-'))
  const input5 = { sessionId: 'sess-selftest', target: { characterId: 'charT', playthroughId: 'ptT' } }
  const deps5 = { loadRawEvents: async () => ({ events: events5 }), maxExistingFloor: async () => 5, collect: dep5.collect, dshHome: dsh5 }
  const plan5 = await planScan(input5, deps5)
  check('5a', '规划含 3 个 region 且全部 alreadyArchived=false', plan5.regions.length === 3 && plan5.regions.every((r) => r.alreadyArchived === false))
  check(
    '5b',
    '★ checkpoint 替换节点不成楼：楼号接在现有最大楼 5 后 = [6,7][8,9][10]',
    JSON.stringify(plan5.regions.filter((r) => !r.skipped).map((r) => [r.floorFrom, r.floorTo])) === JSON.stringify([[6, 7], [8, 9], [10, 10]]),
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
  //   `region.collectPlan` ⇒ **本条必须变红**（抛 COLLECT_REVISION_CHANGED）；换回来即复绿。
  //   写成 8 = 5 个楼层（[6,7]=2 + [8,9]=2 + [10]=1）+ 3 条区间摘要。
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
  const events7 = [
    USER(0, '大区占位楼0', 'user'),
    USER(1, '大区占位楼1', 'user'),
    USER(2, '大区占位楼2', 'user'),
    USER(3, '大区占位楼3', 'user'),
    SUMMARY_EV(4, [0, 1, 2, 3], '模型摘要占位（假）'),
    CHECKPOINT_EV(5, T_CHECKPOINT),
    USER(6, '小区占位楼A', 'user'),
    SUMMARY_EV(7, [6], '模型摘要占位（假）'),
  ]
  const dep7 = makeFakeCollect()
  const dsh7 = mkdtempSync(join(workRoot, 'dsh7-'))
  const plan7 = await planScan(
    { sessionId: 's7', target: { characterId: 'c7', playthroughId: 'p7' }, maxFloorsPerRegion: 1 },
    { loadRawEvents: async () => ({ events: events7 }), maxExistingFloor: async () => null, collect: dep7.collect, dshHome: dsh7 },
  )
  check('7a', '4 楼 region 进 skipped：too-big + COLLECT_REGION_TOO_BIG', plan7.skipped.some((s) => s.regionId === 'region-0-3' && s.reason === 'too-big' && s.code === 'COLLECT_REGION_TOO_BIG'), JSON.stringify(plan7.skipped))
  const small = plan7.regions.find((r) => r.regionId === 'region-6-6')
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

  // ═══ 9. 零 LLM / 机械兜底公式（逐字节不变）═════════════════════════════
  check('9a', 'collect-scan.js 无 llm / stream( 痕迹', !scanSrc.includes('llm') && !scanSrc.includes('stream('))
  check('9b', 'scanConstants 冻结且三个阈值正确', Object.isFrozen(scanConstants) && scanConstants.maxFloorsPerRegion === 200 && scanConstants.regionSummaryChars === 2000 && scanConstants.regionSummaryPerFloor === 80)
  const sum6 = buildRegionSummary(regions13[0])
  check('9c', '机械条目 = 各楼前 80 字 \\n 连接 + 后缀（含楼数），总长 ≤2000（⛔ 公式一字未动）',
    sum6.text === FIX[0] + '\n' + FIX[1].slice(0, 80) + '\n' + FIX[3] + '\n' + FIX[5] + '（合成/自动收纳，共 4 楼）' && sum6.text.length <= scanConstants.regionSummaryChars,
    JSON.stringify(sum6.text))

  // ═══ 10. D1（20260915 追加，2026-09-22 改取法）：区间自带的模型摘要优先归档 ═══
  // ★ 摘要来源变了：不再「另走一次 filterEvents 扫谁覆盖了这段 seq」，而是**区间自己那条替换事件**
  //   的 `data.summary`（区间 ↔ 替换事件 1:1）。原因码枚举一个字没变。
  // ★ 事件 fixture 全是占位字段（隐私铁律：正文只许假占位串）。事件真实字段名
  //   （compactionId/summary/shadowedSeqs/shadowedTokenCount/provider/model）由
  //   normalizeReplacementEventDoc 按官方 compaction-basic 源码逐字对齐。
  const MS_TEXT = '模型摘要占位甲甲占位乙乙占位丙丙（假）'
  const MS_TAGS_LINE = '\ntags: {"vibe":"Suspense","special":[],"important":true}'
  const bySum = (text, tagsLine) => SUMMARY_EV(9, [0, 1, 2], text + (tagsLine || ''))
  const eventsD1 = [USER(0, FIX[0], 'user'), ASST(1, [TEXT(FIX[1])]), USER(2, FIX[3], 'user'), bySum(MS_TEXT, MS_TAGS_LINE), CHECKPOINT_EV(10, T_CHECKPOINT)]
  const regionsD1 = findShadowRegionsFromEvents(eventsD1)
  const inputD1 = { sessionId: 'sess-d1', target: { characterId: 'charD1', playthroughId: 'ptD1' } }
  const depsD1 = (events, extra) => ({
    loadRawEvents: async () => ({ events }),
    maxExistingFloor: async () => null,
    collect: makeFakeCollect().collect,
    dshHome: mkdtempSync(join(workRoot, 'd1-')),
    ...(extra || {}),
  })
  const regionOf = (plan) => plan.regions.find((r) => !r.skipped)

  // ① 区间自带模型摘要 ⇒ model-summary，正文逐字等于事件里那份 + 元数据 + tags 收编
  const p10a = await planScan(inputD1, depsD1(eventsD1))
  const r10a = regionOf(p10a)
  check('10a', '★ 区间自带模型摘要 ⇒ kind=model-summary 且正文逐字等于事件里的那份',
    r10a && r10a.summaryKind === 'model-summary' && r10a.summary && r10a.summary.text === MS_TEXT + MS_TAGS_LINE,
    JSON.stringify(r10a && { kind: r10a.summaryKind, head: (r10a.summary && r10a.summary.text || '').slice(0, 12) }))
  check('10b', '事件元数据进 summary.meta（compactionId/model/provider/shadowedTokenCount/eventSeq）',
    r10a && r10a.summary && isMetaEq(r10a.summary.meta, { kind: 'model-summary', compactionId: 'cp-9', provider: 'prov-x', model: 'model-x', shadowedTokenCount: 123, eventSeq: 9, tags: ['Suspense', 'Important'] }),
    JSON.stringify(r10a && r10a.summary && r10a.summary.meta))
  check('10c', 'tags 行收编成扁平枚举数组 [Suspense, Important]（大小写归一 + Important 收编）',
    r10a && r10a.summary && r10a.summary.meta && JSON.stringify(r10a.summary.meta.tags) === JSON.stringify(['Suspense', 'Important']),
    JSON.stringify(r10a && r10a.summary && r10a.summary.meta && r10a.summary.meta.tags))

  // ② 同一段 seq 集合被**两条替换事件**声称 ⇒ 覆盖不唯一 ⇒ 回落机械条目 + ambiguous-coverage（正文逐字）
  const p10d = await planScan(inputD1, depsD1([...eventsD1, bySum(MS_TEXT, ''), ev(11, 'compaction/summary', { compactionId: 'cp-11', shadowedSeqs: [0, 1, 2], summary: [TEXT(MS_TEXT)], provider: 'prov-x', model: 'model-x', shadowedTokenCount: 123 }, 'current')]))
  const r10d = regionOf(p10d)
  check('10d', '覆盖不唯一（同一段 seq 被两条替换声称）⇒ mechanical + 正文与机械口径逐字相同 + warnings 含 ambiguous-coverage',
    r10d && r10d.summaryKind === 'mechanical' && r10d.summaryFallback === 'ambiguous-coverage'
      && r10d.summary.text === buildRegionSummary(regionsD1[0]).text
      && p10d.warnings.some((w) => w.includes('ambiguous-coverage')),
    JSON.stringify(r10d && { kind: r10d.summaryKind, why: r10d.summaryFallback }))

  // ③ compaction/prune 的区间（官方那一段没有模型摘要）⇒ mechanical + 正文=buildRegionSummary 逐字
  const eventsPrune = [USER(0, FIX[0], 'user'), ASST(1, [TEXT(FIX[1])]), PRUNE_EV(2, [0, 1])]
  const regionsPrune = findShadowRegionsFromEvents(eventsPrune)
  const p10e = await planScan(inputD1, depsD1(eventsPrune))
  const r10e = regionOf(p10e)
  check('10e', 'prune 区间 ⇒ mechanical + 正文=buildRegionSummary 逐字（机械公式与旧版一致）+ no-model-summary',
    r10e && r10e.summaryKind === 'mechanical' && r10e.summary.text === buildRegionSummary(regionsPrune[0]).text
      && p10e.warnings.some((w) => w.includes('no-model-summary')),
    JSON.stringify(r10e && { kind: r10e.summaryKind, same: r10e.summary.text === buildRegionSummary(regionsPrune[0]).text }))

  // ④ 模型摘要正文为空 ⇒ 回落 + no-model-summary（空块数组与空文本块两种都算空）
  const p10f = await planScan(inputD1, depsD1([USER(0, FIX[0], 'user'), ev(9, 'compaction/summary', { compactionId: 'cp-9', shadowedSeqs: [0], summary: [] }, 'current')]))
  const r10f = regionOf(p10f)
  const p10f2 = await planScan(inputD1, depsD1([USER(0, FIX[0], 'user'), ev(9, 'compaction/summary', { compactionId: 'cp-9', shadowedSeqs: [0], summary: [{ type: 'text', text: '' }], provider: 'prov-x', model: 'model-x', shadowedTokenCount: 1 }, 'current')]))
  const r10f2 = regionOf(p10f2)
  check('10f', '模型摘要为空（空块/空串）⇒ mechanical + warnings 含 no-model-summary',
    r10f && r10f.summaryKind === 'mechanical' && r10f.summaryFallback === 'no-model-summary'
      && r10f2 && r10f2.summaryKind === 'mechanical' && r10f2.summaryFallback === 'no-model-summary'
      && p10f.warnings.some((w) => w.includes('no-model-summary')),
    JSON.stringify([r10f, r10f2].map((r) => r && { kind: r.summaryKind, why: r.summaryFallback })))

  // ⑤ tags 没给 ⇒ 空数组 + tags-empty；给错 ⇒ 词表外的剔除（tags-partial），词表内的留下
  const p10g = await planScan(inputD1, depsD1([USER(0, FIX[0], 'user'), ASST(1, [TEXT(FIX[1])]), USER(2, FIX[3], 'user'), bySum(MS_TEXT, '')]))
  const r10g = regionOf(p10g)
  check('10g', '模型没给 tags ⇒ meta.tags=[] + warnings 含 tags-empty',
    r10g && r10g.summaryKind === 'model-summary' && JSON.stringify(r10g.summary.meta.tags) === '[]'
      && p10g.warnings.some((w) => w.includes('tags-empty')),
    JSON.stringify({ tags: r10g && r10g.summary.meta.tags }))
  const p10h = await planScan(inputD1, depsD1([USER(0, FIX[0], 'user'), ASST(1, [TEXT(FIX[1])]), USER(2, FIX[3], 'user'), bySum(MS_TEXT, '\ntags: {"vibe":"Nope","special":["Daily","占位外","Daily"],"important":"x"}')]))
  const r10h = regionOf(p10h)
  check('10h', 'tags 给错 ⇒ 只留词表内 [Daily] + warnings 含 tags-partial（⛔ 不编）',
    r10h && r10h.summaryKind === 'model-summary' && JSON.stringify(r10h.summary.meta.tags) === JSON.stringify(['Daily'])
      && p10h.warnings.some((w) => w.includes('tags-partial')),
    JSON.stringify({ tags: r10h && r10h.summary.meta.tags }))

  // ⑥ deps 不注入 loadRawEvents ⇒ **可读地抛**（⛔ 不假装 0 区间、⛔ 不静默回落机械条目）
  let p10iErr = null
  try { await planScan(inputD1, { maxExistingFloor: async () => null, collect: makeFakeCollect().collect, dshHome: mkdtempSync(join(workRoot, 'd1-')) }) }
  catch (e) { p10iErr = e }
  check('10i', '★ 未注入 loadRawEvents ⇒ SCAN_INVALID 且点名 loadRawEvents（⛔ 不假装"0 区间"）',
    !!p10iErr && p10iErr.code === 'SCAN_INVALID' && String(p10iErr.message).includes('loadRawEvents'),
    JSON.stringify({ code: p10iErr && p10iErr.code, message: p10iErr && p10iErr.message }))
  // ⑥′ 空事件数组（真的没有压缩）⇒ 0 区间、无 skipped、无机械条目 —— 机械兜底不再是常态
  const p10i2 = await planScan(inputD1, depsD1([USER(0, FIX[0], 'user')]))
  check('10i2', '★ 没有压缩事件 ⇒ scanned=0、无机械条目（"机械兜底是常态"的时代结束）',
    p10i2.scanned === 0 && p10i2.regions.length === 0 && p10i2.skipped.length === 0,
    JSON.stringify({ scanned: p10i2.scanned, regions: p10i2.regions.length }))

  // ⑦ 隐私：模型摘要占位正文不出现在 warnings（正文不出网，与既有第 8 条同纪律）
  check('10j', '模型摘要正文不在 plan.warnings 里',
    ![p10a, p10d, p10e, p10f, p10g, p10h].some((p) => p.warnings.some((w) => w.includes(MS_TEXT))),
    'warnings 泄漏正文')
  function isMetaEq(meta, want) {
    return JSON.stringify(meta) === JSON.stringify(want)
  }

  // ═══ 11. 回声闸门（20260918 自总结侧路搬进来）══════════════════════════
  // 模型把**压缩指令原文**当摘要回吐 ⇒ 该区间拒收模型正文、回落机械条目 + warnings 大声播报。
  // 指令用**自造**占位行（⛔ 仓库源码不写任何真实提示词原文）；「当前生效指令从哪来」的
  // 接线（templates.compaction.current）由宿主侧自检锁死，这里只锁 collect-scan 行为本身。
  const ECHO_INSTR = [
    '归档指令占位第零行：逐段总结正文。',
    '归档指令占位第一行：连续叙事不许切开。',
    '归档指令占位第二行：只记录证据，不下抽象结论。',
    '归档指令占位第三行：只输出原始 JSON 数组。',
  ].join('\n')
  const ECHO_TEXT = ECHO_INSTR.split('\n').slice(0, 3).join('\n')
  const GOOD_ZH = '1966年9月1日 上午：她在陌生的旅馆房间醒来，记忆一片空白；她把一枚鳞片与旧围巾收进皮箱，门外的脚步声打断了她的动作。'
  const echoEvents = [USER(0, FIX[0], 'user'), ASST(1, [TEXT(FIX[1])]), USER(2, FIX[3], 'user'), bySum(ECHO_TEXT, ''), CHECKPOINT_EV(10, T_CHECKPOINT)]

  // ① 单元直测：selectModelSummary 带 instruction ⇒ prompt-echo
  const selEcho = selectModelSummary(findShadowRegionsFromEvents(echoEvents)[0], { instruction: ECHO_INSTR })
  check('11a', '★反证：回声正文 + 指令 ⇒ mechanical + reason=prompt-echo',
    selEcho.kind === 'mechanical' && selEcho.reason === 'prompt-echo', JSON.stringify(selEcho))

  // ② 端到端：planScan 喂回声事件 + 指令 ⇒ 机械条目 + 大声播报
  const p11a = await planScan(inputD1, depsD1(echoEvents, { instruction: ECHO_INSTR }))
  const r11a = regionOf(p11a)
  check('11b', '★反证：回声 ⇒ 该区间回落机械条目 + summaryFallback=prompt-echo',
    r11a && r11a.summaryKind === 'mechanical' && r11a.summaryFallback === 'prompt-echo',
    JSON.stringify(r11a && { kind: r11a.summaryKind, why: r11a.summaryFallback }))
  check('11c', '★反证：warnings 里有 prompt-echo 播报（⛔ 不许静默跳过）',
    p11a.warnings.some((w) => w.includes('prompt-echo') && w.includes('拒收')),
    JSON.stringify(p11a.warnings))

  // ③ 误杀检查：正常中文摘要 + 同一份指令 ⇒ 照常采用 model-summary
  const p11b = await planScan(inputD1, depsD1([USER(0, FIX[0], 'user'), ASST(1, [TEXT(FIX[1])]), USER(2, FIX[3], 'user'), bySum(GOOD_ZH, ''), CHECKPOINT_EV(10, T_CHECKPOINT)], { instruction: ECHO_INSTR }))
  const r11b = regionOf(p11b)
  check('11d', '★反证：正常中文摘要不许误杀（采用模型正文，逐字）',
    r11b && r11b.summaryKind === 'model-summary' && r11b.summary.text === GOOD_ZH,
    JSON.stringify(r11b && { kind: r11b.summaryKind, head: (r11b.summary && r11b.summary.text || '').slice(0, 12) }))

  // ④ 拿不到指令（未注入）⇒ 只按结构判：不给出 echo 判定（如实降级，⛔ 不瞎猜）
  const p11c = await planScan(inputD1, depsD1(echoEvents))
  const r11c = regionOf(p11c)
  check('11e', '未注入指令 ⇒ 闸门不判 echo（只按结构判，model-summary 照旧）',
    r11c && r11c.summaryKind === 'model-summary' && !p11c.warnings.some((w) => w.includes('prompt-echo')),
    JSON.stringify(r11c && { kind: r11c.summaryKind }))

  // ⑤ 接线锚（静态）：collectOnce 的 deps 确实把 instruction 传进 planScan
  check('11f', '静态：collect-scan 的 deps.instruction 透传在位',
    scanSrc.includes("instruction: typeof instruction === 'string' ? instruction : ''"),
    'collect-scan.js 缺 deps.instruction 透传')

  // ═══ 12. ★ 20260922：手动/HTTP 那条路的 Tavern 基址（`base`）════════════════════
  //
  //   真机事故（逐字证据在派单任务书 §1）：`POST /collect/scan`（干跑）返回
  //   `{"ok":false,"error":{"code":"TAVERN_UNREACHABLE","message":"Tavern 工作区请求失败：fetch failed"}}`，
  //   而同一个 URL 换 `/collect/targets`（A1）是好的、同一个地址 curl 也是 200。
  //   代码上的差：自动那条路（lib/index.js）**传了** base，HTTP 路由（runCollectRoute）**没传**
  //   ⇒ 内核推不出基址 ⇒ A1 的兜底分支给出 `http://127.0.0.1`（**没有端口**）⇒ 打 80 端口。
  //
  //   这一节四层，每条都能直测（⛔ 不是源码字符串断言）：
  //     ① 路由那一步（routeTavernBase：真 A1 取法）—— 相「Host ⇒ 基址」/ 相「socket.localPort 兜底」
  //     ② 内核那一步（reqLikeFromBase → makeA1Tavern）—— **假 backend 把 `createTavernClient({baseUrl})`
  //        的入参记下来断言**（客户端用真 A1 的，只有入参被记账 ⇒ 不是"顺手的假对象"）
  //     ③ 端到端：真路由（handleCollectScan/handleCollectAuto）+ 真 A1 客户端 + **真 HTTP 的假 Tavern**
  //     ④ 反证：把 base 那一行挖掉（旧写法）+ 内核的收紧改回旧写法 ⇒ ①②③ 必红，且红出的形态
  //        与真机那条 `fetch failed` 对得上
  const a1 = await import('./lib/collect.js') // 真 A1：取法与客户端都用真的，只把入参记下来
  const spyBackend = (recorded) => ({
    tavernBaseFromReq: a1.tavernBaseFromReq,
    createTavernClient: (opts) => { recorded.push(opts); return a1.createTavernClient(opts) },
  })
  /** 内核那一步的合成：base → 合成 req → 客户端（把 createTavernClient 的入参记进 recorded）。 */
  const baseToClient = (recorded, base) => makeA1Tavern(spyBackend(recorded), reqLikeFromBase(base))

  // ── ① 相 1：路由收到 `Host: 127.0.0.1:3080` ⇒ 传给客户端的基址 == http://127.0.0.1:3080 ──
  //    ⚠️ socket.localPort 故意给 9999（本机没服务）：证明取法是 **Host 优先**，⛔ 不是"随便挑一个"。
  //    反证（§3-3）：把 base 那一行挖掉 ⇒ 基址变 `http://127.0.0.1`（无端口）⇒ **本条必红**（见 12i/12j）。
  {
    const rec = []
    const base = await routeTavernBase({ headers: { host: '127.0.0.1:3080' }, socket: { localPort: 9999 } })
    baseToClient(rec, base)
    check('12a', '★ 相：Host=127.0.0.1:3080 ⇒ createTavernClient 的 baseUrl 逐字等于 http://127.0.0.1:3080',
      base === 'http://127.0.0.1:3080' && rec.length === 1 && rec[0].baseUrl === 'http://127.0.0.1:3080',
      JSON.stringify({ base, baseUrl: rec[0] && rec[0].baseUrl }))
    check('12b', '★ 相：Host 优先于 socket.localPort（兜底那条没被用上）',
      String(rec[0] && rec[0].baseUrl) === 'http://127.0.0.1:3080', String(rec[0] && rec[0].baseUrl))
  }

  // ── ② 相 2：Host 缺失、但 socket.localPort = 3080 ⇒ `http://127.0.0.1:3080`（A1 的老口径，照抄别改）──
  {
    const rec = []
    const base = await routeTavernBase({ headers: {}, socket: { localPort: 3080 } })
    baseToClient(rec, base)
    check('12c', '★ 相：没有 Host 头 ⇒ 用 socket.localPort 兜底 ⇒ http://127.0.0.1:3080（A1 老口径照抄）',
      base === 'http://127.0.0.1:3080' && rec[0].baseUrl === 'http://127.0.0.1:3080',
      JSON.stringify({ base, baseUrl: rec[0] && rec[0].baseUrl }))
  }

  // ── 相 3：自动收纳那条路给的 base（`http://127.0.0.1:<webServer.port>`）照旧被接受（无回归）──
  {
    const rec = []
    baseToClient(rec, 'http://127.0.0.1:3112')
    check('12d', '★ 相：自动收纳给的 base（http://127.0.0.1:<port>）照旧被接受 —— 收紧契约没伤到另一条路',
      rec[0].baseUrl === 'http://127.0.0.1:3112', String(rec[0] && rec[0].baseUrl))
  }

  // ── ③ 端到端：真路由 + 真 A1 客户端 + 真 HTTP 的假 Tavern ─────────────────────
  //   真机形状：同一个宿主既是面板端点、又是 Tavern 工作区面。请求头的 Host 指到假 Tavern 的端口
  //   ⇒ 插件必须**打到那个端口**才可能出 plan（打到 80 = 真机那个 fetch failed）。
  //   ⚠️ DSH_HOME 指到临时目录：这条链会读台账（干跑只读不写）—— ⛔ 绝不碰真机 home。
  const CHAR12 = 'char-scan-base-0001'
  const PT12 = 'playthrough-scan-base-0001'
  const fake12 = createFakeTavern()
  await fake12.start()
  fake12.files.set('catalog.json', JSON.stringify({
    schemaVersion: 1,
    playthroughs: [{
      id: PT12,
      path: `${CHAR12}/${PT12}/timeline.json`,
      ext: { pmpDshTavern: { characterId: CHAR12, rootSessionId: 'session-12' } },
    }],
  }) + '\n')
  // ★ 2026-09-22：注入面换成**原始事件**（一次压缩 = 一个区间 ⇒ 这里 1 个区间 / 2 楼）。
  const events12 = [USER(0, FIX[0], 'user'), ASST(1, [TEXT(FIX[1])], 'shadowed'), SUMMARY_EV(9, [0, 1], MS_TEXT)]
  const ctx12 = {
    get: (name) => (name === 'sessionQuery' ? { readSession: async () => ({}), filterEvents: async () => [] } : null),
  }
  /** 假 req：只要 `headers.host` / `socket.localPort` / 可 for-await 的 body —— 与真 IncomingMessage 同形。 */
  const mkReq12 = (host, localPort, bodyObj) => {
    const raw = Buffer.from(JSON.stringify(bodyObj), 'utf8')
    return {
      headers: host === undefined ? {} : { host, 'content-type': 'application/json' },
      socket: { localPort },
      async *[Symbol.asyncIterator]() { yield raw },
    }
  }
  const body12 = { sessionId: 'session-12', target: { characterId: CHAR12, playthroughId: PT12 } }
  const loadEvents12 = async () => ({ events: events12 })
  const log12 = { warn() {} }
  process.env.DSH_HOME = mkdtempSync(join(workRoot, 'dsh12-'))
  {
    const sent = []
    await handleCollectScan(ctx12, mkReq12('127.0.0.1:' + fake12.port, 9999, body12),
      (status, body) => sent.push({ status, body }), log12, loadEvents12, '')
    check('12e', '★★ 端到端：/collect/scan 干跑**出 plan**（真机那次的症状是 fetch failed）',
      sent.length === 1 && sent[0].status === 200 && sent[0].body.ok === true
      && Array.isArray(sent[0].body.regions) && sent[0].body.regions.some((r) => r.floorCount === 2),
      JSON.stringify(sent.map((s) => ({ status: s.status, ok: s.body && s.body.ok, error: s.body && s.body.error }))))
    check('12f', '★★ 端到端：Tavern 请求真的打到 Host 指的那个端口（同源）—— 打到 80 就是真机那个 fetch failed',
      fake12.requests.length > 0 && fake12.requests.every((r) => r.host === '127.0.0.1:' + fake12.port),
      JSON.stringify({ n: fake12.requests.length, hosts: [...new Set(fake12.requests.map((r) => r.host))] }))
  }
  // /collect/auto（面板的「收进归档」/补收）走的是同一个 runCollectRoute ⇒ base 也必须是它
  {
    const sent = []
    await handleCollectAuto(ctx12, mkReq12('127.0.0.1:' + fake12.port, 9999, body12),
      (status, body) => sent.push({ status, body }), log12, loadEvents12, '')
    check('12g', '★★ 端到端：/collect/auto 规划+落库也通（archived=1，写进假 Tavern）',
      sent.length === 1 && sent[0].status === 200 && sent[0].body.ok === true && sent[0].body.archived === 1,
      JSON.stringify(sent.map((s) => ({ status: s.status, ok: s.body && s.body.ok, archived: s.body && s.body.archived, error: s.body && s.body.error }))))
  }

  // ── ④ 反证（§3-3）：把 base 那一行挖掉（旧写法）+ 内核的收紧改回旧写法 ⇒ 上面三条必红 ──
  //   做法照 `_selftest-auto-collect.mjs` 第 9 节：拷一份 lib 到临时目录、只改那两处、import 那份副本，
  //   喂**同一套夹具**跑同一条链。⛔ 不改本仓的 lib（改的是副本），跑完删掉。
  {
    const tmp12 = mkdtempSync(join(tmpdir(), 'dma-scan-base-revert-'))
    cpSync(join(here, 'lib'), join(tmp12, 'lib'), { recursive: true })
    writeFileSync(join(tmp12, 'package.json'), JSON.stringify({ type: 'module' }) + '\n', 'utf8')
    const p12 = join(tmp12, 'lib', 'collect-scan.js')
    // ★ 2026-09-25（收尾单 §3）：往下这些副本手术的针里都带 `\n`（行尾敏感）—— 副本一旦混进 CRLF 段，
    //   针就永远失配 ⇒ replace 静默无效、"就位"断言误红。读入一律先归一成 `\n`（针与判据一字未动）。
    let src12 = readFileSync(p12, 'utf8').replace(/\r\n/g, '\n') // ★ 行尾归一（同 16/17 节那几处）
    const before12 = src12
    src12 = src12
      // 旧写法①：路由**不传 base**（真机上漏的就是这一行）
      .replace('    const base = await routeTavernBase(req)\n', '')
      .replace('      auto: auto === true,\n      base,\n      loadRawEvents,', '      auto: auto === true,\n      loadRawEvents,')
      // 旧写法②：内核拿不到 base 时静默退化成 `null` ⇒ A1 兜底分支给出 `http://127.0.0.1`（无端口）
      .replace('  const reqLike = reqLikeFromBase(base)',
        "  const reqLike = typeof base === 'string' && base !== '' ? { headers: { host: base.replace(/^https?:\\/\\//, '') } } : null")
    check('12h', '反证夹具就位：副本里那两处确实改回旧写法（⛔ 原文件一字未动）',
      src12 !== before12 && !src12.includes('  const reqLike = reqLikeFromBase(base)')
      && !src12.includes('    const base = await routeTavernBase(req)\n') && src12.includes("typeof base === 'string' && base !== ''")
      && readFileSync(join(here, 'lib', 'collect-scan.js'), 'utf8').includes('  const reqLike = reqLikeFromBase(base)'), '')
    writeFileSync(p12, src12, 'utf8')
    const old12 = await import(pathToFileURL(p12).href)

    // 反证 A：旧写法下 reqLike === null ⇒ 基址退化成 http://127.0.0.1（**没有端口**）⇒ 打 80 端口
    const recOld = []
    old12.makeA1Tavern(spyBackend(recOld), null)
    console.log('    · 旧写法 reqLike=null ⇒ createTavernClient({baseUrl:' + JSON.stringify(recOld[0] && recOld[0].baseUrl) + '})')
    check('12i', '★★ 反证：旧写法基址退化成 http://127.0.0.1（**无端口**）⇒ 打 80 端口',
      recOld[0] && recOld[0].baseUrl === 'http://127.0.0.1', String(recOld[0] && recOld[0].baseUrl))
    check('12j', '★★ 反证：§3-1 那条判据在旧写法下**必红**（同一个断言：baseUrl === http://127.0.0.1:3080 ⇒ false）',
      recOld[0] && recOld[0].baseUrl !== 'http://127.0.0.1:3080', String(recOld[0] && recOld[0].baseUrl))

    // 反证 B：旧写法走同一条端到端链路 ⇒ 不再是 plan，而是没头没脑的失败
    const sentOld = []
    await old12.handleCollectScan(ctx12, mkReq12('127.0.0.1:' + fake12.port, 9999, body12),
      (status, body) => sentOld.push({ status, body }), log12, loadEvents12, '')
    console.log('    · 旧写法走真 HTTP ⇒ ' + JSON.stringify(sentOld[0] && { status: sentOld[0].status, error: sentOld[0].body && sentOld[0].body.error }))
    check('12k', '★★ 反证：旧写法端到端**不是 plan**（形态与真机那条对得上：TAVERN_UNREACHABLE / fetch failed）',
      sentOld.length === 1 && sentOld[0].body && sentOld[0].body.ok === false
      && /TAVERN_UNREACHABLE|TAVERN_HTTP_|TAVERN_BAD_SHAPE/.test(String(sentOld[0].body.error && sentOld[0].body.error.code)),
      JSON.stringify(sentOld[0] && sentOld[0].body))
    check('12l', '★★ 反证：旧写法那条错误里**没有一个字**指出"基址推不出来" —— 这就是"失败形态不可读"本身',
      !String(sentOld[0] && sentOld[0].body && sentOld[0].body.error && sentOld[0].body.error.message).includes('推不出宿主自己的地址'), '')
    rmSync(tmp12, { recursive: true, force: true })
    check('12m', '副本已删（⛔ 不给仓库留垃圾）', !existsSync(tmp12), '')
  }

  // ── ⑤ 反证（§3-4）：base 拿不到 ⇒ **可读错误 SCAN_BASE_UNKNOWN**，⛔ 不拿 http://127.0.0.1 去连 ──
  {
    const codes = []
    for (const bad of [undefined, null, '', '   ', 'http://127.0.0.1', 'https://localhost', 'http://127.0.0.1:0', 'http://127.0.0.1:70000']) {
      try { reqLikeFromBase(bad); codes.push('(没抛)') } catch (e) { codes.push(e.code) }
    }
    check('12n', '★ 反证：base 拿不到 / 只剩主机名 / 端口越界 ⇒ 一律 SCAN_BASE_UNKNOWN（8 种入参）',
      codes.every((c) => c === 'SCAN_BASE_UNKNOWN'), JSON.stringify(codes))
    let badMsg = ''
    try { reqLikeFromBase('http://127.0.0.1') } catch (e) { badMsg = String(e.message) }
    check('12o', '★ 反证：文案说清"推不出宿主自己的地址 / 本轮没连 Tavern"（⛔ 不是 fetch failed）',
      badMsg.includes('推不出宿主自己的地址') && badMsg.includes('本轮没连 Tavern') && !badMsg.includes('fetch failed'), badMsg)
    // 内核那一层：不给 base ⇒ 直接可读地抛（⛔ 不往下走去连 Tavern）
    let kernErr = null
    try {
      await collectOnce(ctx12, { sessionId: 'session-12', target: { characterId: CHAR12, playthroughId: PT12 } })
    } catch (e) { kernErr = e }
    check('12p', '★ 反证：内核拿不到 base ⇒ SCAN_BASE_UNKNOWN（⛔ 不拿 http://127.0.0.1 去连、不报 fetch failed）',
      !!kernErr && kernErr.code === 'SCAN_BASE_UNKNOWN' && !String(kernErr.message).includes('fetch failed'),
      JSON.stringify({ code: kernErr && kernErr.code, message: kernErr && kernErr.message }))
    // 路由那一层：请求里既没有 Host、也没有 localPort ⇒ 503 + 同一句话（HTTP 响应也是人话）
    const sentNoBase = []
    await handleCollectScan(ctx12, mkReq12(undefined, undefined, body12),
      (status, body) => sentNoBase.push({ status, body }), log12, loadEvents12, '')
    console.log('    · 推不出地址时路由的响应 ⇒ ' + JSON.stringify(sentNoBase[0]))
    check('12q', '★ 反证：路由响应 503 + SCAN_BASE_UNKNOWN（面板上是一句人话，⛔ 不是 fetch failed）',
      sentNoBase.length === 1 && sentNoBase[0].status === 503 && sentNoBase[0].body && sentNoBase[0].body.error
      && sentNoBase[0].body.error.code === 'SCAN_BASE_UNKNOWN'
      && sentNoBase[0].body.error.message.includes('推不出宿主自己的地址'),
      JSON.stringify(sentNoBase[0] && sentNoBase[0].body))
  }
  await fake12.stop()

  // ═══ 13. ★★ 任务书 §3 的六对（相 + 反证）—— 反证**真把旧写法改回去跑一遍** ══════════
  //
  //   反证手法（与第 12 节④同款，是本仓的既有做法）：把 lib 拷到临时目录 → 只改那一处 →
  //   `import` 那份副本 → 喂**同一套夹具**。⛔ 本仓的 lib 一字未动（下面的 13h 锁死这一点）。
  const reverted13 = mkdtempSync(join(tmpdir(), 'dma-scan-regions-revert-'))
  cpSync(join(here, 'lib'), join(reverted13, 'lib'), { recursive: true })
  writeFileSync(join(reverted13, 'package.json'), JSON.stringify({ type: 'module' }) + '\n', 'utf8')
  const revertedFloor13 = mkdtempSync(join(tmpdir(), 'dma-scan-floor-revert-'))
  cpSync(join(here, 'lib'), join(revertedFloor13, 'lib'), { recursive: true })
  writeFileSync(join(revertedFloor13, 'package.json'), JSON.stringify({ type: 'module' }) + '\n', 'utf8')
  {
    // ── 反证夹具 A：把分段判据改回「seq 相邻即归一段」（旧 findShadowRegions 逐字照抄）──
    const pR = join(reverted13, 'lib', 'collect-scan.js')
    let srcR = readFileSync(pR, 'utf8')
    const beforeR = srcR
    srcR = srcR.replace('  const regions = findShadowRegionsFromEvents(rawEvents)',
      '  const regions = legacyRegionsForProof(legacyBySeqOfProof(rawEvents))')
    srcR += `
// ⛔⛔ 反证专用（**只注入到副本里**）：2026-09-22 之前的分段判据，逐字照抄当时那份实现 ——
//   「surface === 'shadowed' 且 seq 相邻（seq === cur.toSeq + 1）即归一段」。
function legacyRegionsForProof(bySeq) {
  if (!(bySeq instanceof Map)) return []
  const seqs = []
  for (const [seq, v] of bySeq) {
    if (typeof seq !== 'number' || !Number.isFinite(seq)) continue
    if (!v || v.surface !== 'shadowed') continue
    seqs.push(seq)
  }
  seqs.sort((a, b) => a - b)
  const regions = []
  let cur = null
  for (const seq of seqs) {
    const v = bySeq.get(seq)
    const doc = {
      seq, surface: 'shadowed',
      text: typeof v.text === 'string' ? v.text : '',
      type: typeof v.type === 'string' ? v.type : null,
      sourceKind: null, // 便宜路径的文档结构上没有 source.kind（这正是守卫恒假的原因）
    }
    if (cur && seq === cur.toSeq + 1) { cur.toSeq = seq; cur.docs.push(doc) }
    else { cur = { regionId: '', fromSeq: seq, toSeq: seq, docs: [doc] }; regions.push(cur) }
  }
  for (const r of regions) r.regionId = 'region-' + r.fromSeq + '-' + r.toSeq
  return regions
}
function legacyBySeqOfProof(events) {
  const m = new Map()
  for (const evv of events) {
    if (!evv || typeof evv.seq !== 'number') continue
    m.set(evv.seq, {
      surface: typeof evv.surface === 'string' ? evv.surface : null,
      text: typeof evv.text === 'string' ? evv.text : (typeof evv.data === 'object' && evv.data !== null && typeof evv.data.text === 'string' ? evv.data.text : ''),
      type: typeof evv.type === 'string' ? evv.type : null,
    })
  }
  return m
}
`
    check('13a', '反证夹具 A 就位：副本的**分段判据**已改回旧写法（⛔ 原文件一字未动）',
      srcR !== beforeR && srcR.includes('legacyRegionsForProof(legacyBySeqOfProof(rawEvents))')
      && readFileSync(join(here, 'lib', 'collect-scan.js'), 'utf8').includes('const regions = findShadowRegionsFromEvents(rawEvents)'), '')
    writeFileSync(pR, srcR, 'utf8')
    const rev13 = await import(pathToFileURL(pR).href)

    // ── 对 1（相）：一次 compaction/summary（非连续 shadowedSeqs + 中间夹着 tool/call·tool/result·
    //    插件注入的 user/message）+ 紧随其后的英文 checkpoint ⇒ **1 个区间**，且楼里只有真对话 ──
    const regionsNew = findShadowRegionsFromEvents(events13())
    const floorsNew = floorsOf(regionsNew[0])
    check('13b', '① 相：那段真实形状的事件 ⇒ **恰好 1 个区间**', regionsNew.length === 1, `得到 ${regionsNew.length}`)
    check('13c', '① 相：区间的楼里**只有真对话**（4 楼 = 玩家/角色/玩家/角色；工具·插件·思维链·memory_write 一个都不在）',
      floorsNew.length === 4 && JSON.stringify(floorsNew) === JSON.stringify([FIX[0], FIX[1], FIX[3], FIX[5]])
      && !floorsNew.some((t) => t.includes(T_TOOLCALL) || t.includes(T_TOOLRESULT) || t.includes(T_PLUGIN) || t.includes(T_REASON) || t.includes('memory_write')),
      JSON.stringify(floorsNew))
    // ① 反证：同一夹具喂**旧判据**的副本 ⇒ 多区间（本条断言必红）
    const revPlan = await rev13.planScan(input5, { loadRawEvents: async () => ({ events: events13() }), maxExistingFloor: async () => null, collect: makeFakeCollect().collect, dshHome: mkdtempSync(join(workRoot, 'r13-')) })
    console.log('    · ① 反证：旧判据在同一夹具上 ⇒ ' + revPlan.regions.length + ' 个区间（' + revPlan.regions.map((r) => r.regionId).join(' / ') + '）')
    check('13d', '① ★反证：旧判据「相邻即归一段」在同一夹具上产出**多**区间 ⇒ 「恰好 1 个区间」那条断言必红',
      revPlan.regions.length === 2 && revPlan.regions.length === adjacentRunsOf(regionsNew[0]) && revPlan.regions.length !== regionsNew.length,
      `旧判据得到 ${revPlan.regions.length}（1f 的算术对照 = ${adjacentRunsOf(regionsNew[0])}；新判据 ${regionsNew.length}）`)

    // ── 对 2（相）：同一条 compaction/summary 的 data.summary ⇒ 条目正文 = 那份模型摘要文本 ──
    const p13 = await planScan(inputD1, depsD1(events13().slice(0, 10))) // 0..9：含 summary 本身，不含它后面的 checkpoint
    const r13 = regionOf(p13)
    check('13e', '② 相：条目正文 = 那次压缩自己的模型摘要文本，summaryKind=model-summary',
      r13 && r13.summaryKind === 'model-summary' && r13.summary.text === MS13 && r13.summary.meta.compactionId === 'cp-9',
      JSON.stringify(r13 && { kind: r13.summaryKind, text: r13.summary && r13.summary.text }))
    // ② 反证：把输入换成**便宜路径的文档形状**（`{sessionId,seq,type,time,surface,text}`，没有 data）
    //   ⇒ (a) 新代码**连压缩都看不见**（0 区间）；(b) 喂旧判据副本 ⇒ 区间还在，但摘要**必然回落**
    //   no-model-summary（= 真机 §1-① 的 208/208 全部 mechanical —— "为什么不能走那条便宜路"钉死）。
    const docShape = events13().map((e) => ({ sessionId: e.sessionId, seq: e.seq, type: e.type, time: e.time, surface: e.surface, text: FIX[1] }))
    const regionsDoc = findShadowRegionsFromEvents(docShape)
    const revPlanDoc = await rev13.planScan(input5, { loadRawEvents: async () => ({ events: docShape }), maxExistingFloor: async () => null, collect: makeFakeCollect().collect, dshHome: mkdtempSync(join(workRoot, 'r13b-')) })
    console.log('    · ② 反证：文档形状 ⇒ 新代码 ' + regionsDoc.length + ' 区间；旧判据 ' + revPlanDoc.regions.length + ' 区间 / '
      + JSON.stringify([...new Set(revPlanDoc.regions.map((r) => r.summaryKind + ':' + (r.summaryFallback || '-')))]))
    check('13f', '② ★反证：(a) 文档形状（无 data）⇒ 新代码 0 区间（压缩的 shadowedSeqs 取不到）',
      regionsDoc.length === 0, `得到 ${regionsDoc.length}`)
    check('13g', '② ★反证：(b) 同一份文档形状喂旧判据 ⇒ 区间还在，但**每一条**都回落 mechanical/no-model-summary（真机 §1-① 的形态）',
      revPlanDoc.regions.length > 0 && revPlanDoc.regions.every((r) => r.summaryKind === 'mechanical' && r.summaryFallback === 'no-model-summary'),
      JSON.stringify(revPlanDoc.regions.map((r) => [r.summaryKind, r.summaryFallback])))
    check('13h', '★ 本轮反证全程没有碰过本仓的 lib（原文件里两条判据都还在）',
      readFileSync(join(here, 'lib', 'collect-scan.js'), 'utf8').includes('const regions = findShadowRegionsFromEvents(rawEvents)')
      && readFileSync(join(here, 'lib', 'collect-scan.js'), 'utf8').includes('    if (doc.replacementNode === true) continue'), '')

    // ── 对 3（相）：compaction/prune（有 shadowedSeqs、无 summary）⇒ 仍出 1 个区间，机械兜底 + 原因码 ──
    const regionsB = findShadowRegionsFromEvents(events13b())
    const p13b = await planScan(inputD1, depsD1(events13b()))
    const pruneRegion = p13b.regions.find((r) => r.regionId === 'region-10-12')
    check('13i', '③ 相：prune ⇒ 仍出区间（2 条替换 = 2 个区间），它的摘要是 mechanical + no-model-summary + 大声播报',
      regionsB.length === 2 && pruneRegion && pruneRegion.summaryKind === 'mechanical'
      && pruneRegion.summaryFallback === 'no-model-summary'
      && p13b.warnings.some((w) => w.includes('compaction/prune')),
      JSON.stringify(pruneRegion && { kind: pruneRegion.summaryKind, why: pruneRegion.summaryFallback }))

    // ── 对 4（相）：插件注入（source.kind === 'plugin'）⇒ **不出楼** ──
    check('13j', '④ 相：插件注入的 user/message 不成楼、正文也不并进前一条楼',
      !floorsNew.some((t) => t.includes(T_PLUGIN)), JSON.stringify(floorsNew))
    // ── 对 5（相）：全是 tool/result 的区间 ⇒ 0 楼 ⇒ skipped 的 empty（原因码沿用）──
    const p13c = await planScan(inputD1, depsD1(events13c()))
    check('13k', '⑤ 相：全 tool/result 的区间 ⇒ floorCount=0 ⇒ skipped.reason=empty + COLLECT_REGION_EMPTY',
      p13c.regions.length === 1 && p13c.regions[0].floorCount === 0
      && p13c.skipped.length === 1 && p13c.skipped[0].reason === 'empty' && p13c.skipped[0].code === 'COLLECT_REGION_EMPTY',
      JSON.stringify({ regions: p13c.regions.map((r) => r.floorCount), skipped: p13c.skipped }))
    // ── 对 6（相/反证）：紧跟 summary 的那条 user/message（英文 checkpoint 前言）**不出楼** ──
    const pruneFloors = mapRegionToFloors(regionsB[1], 0).floors.map((f) => f.text)
    check('13l', '⑥ 相：紧跟 summary 的英文 checkpoint 前言**不出楼**（它的区间里只剩两条真对话）',
      pruneFloors.length === 2 && JSON.stringify(pruneFloors) === JSON.stringify([FIX[6], FIX[4]])
      && !pruneFloors.some((t) => t.includes('automatically generated checkpoint')),
      JSON.stringify(pruneFloors))

    // ── 反证夹具 B：把 mapRegionToFloors 里那两条排除判据挖掉（同一份副本，另拷一份）──
    const pF = join(revertedFloor13, 'lib', 'collect-scan.js')
    let srcF = readFileSync(pF, 'utf8').replace(/\r\n/g, '\n') // ★ 2026-09-25：行尾归一 —— 针里带 \n，CRLF 段必失配（判据一字未动）
    const beforeF = srcF
    srcF = srcF.replace('    if (doc.replacementNode === true) continue\n', '')
      .replace('    if (isInjectedUserMessage(doc)) continue\n', '')
      .replace('    if (TOOL_TYPES.includes(type)) continue\n', '')
    check('13m', '反证夹具 B 就位：副本里三条排除判据已挖掉（⛔ 原文件一字未动）',
      srcF !== beforeF && !srcF.includes('    if (doc.replacementNode === true) continue')
      && !srcF.includes('    if (isInjectedUserMessage(doc)) continue') && !srcF.includes('    if (TOOL_TYPES.includes(type)) continue')
      && readFileSync(join(here, 'lib', 'collect-scan.js'), 'utf8').includes('    if (TOOL_TYPES.includes(type)) continue'), '')
    writeFileSync(pF, srcF, 'utf8')
    const revF = await import(pathToFileURL(pF).href)
    const floorsRev = revF.mapRegionToFloors(revF.findShadowRegionsFromEvents(events13())[0], 0).floors.map((f) => f.text)
    console.log('    · ④/⑥ 反证：挖掉排除判据 ⇒ 楼 = ' + JSON.stringify(floorsRev.map((t) => t.slice(0, 10))))
    check('13n', '④ ★反证：挖掉插件注入的 skip ⇒ 它的正文必成楼（本条断言：楼里没有插件正文 ⇒ 旧写法下必红）',
      floorsRev.some((t) => t.includes(T_PLUGIN)) && !floorsNew.some((t) => t.includes(T_PLUGIN)), '旧写法下插件注入没成楼？')
    check('13o', '①★反证：挖掉工具事件的 skip ⇒ tool 的正文必并进楼（新写法下不并）',
      floorsRev.some((t) => t.includes(T_TOOLCALL) || t.includes(T_TOOLRESULT))
      && !floorsNew.some((t) => t.includes(T_TOOLCALL) || t.includes(T_TOOLRESULT)), '旧写法下工具正文没并进楼？')
    const floorsRevB = revF.mapRegionToFloors(revF.findShadowRegionsFromEvents(events13b())[1], 0).floors.map((f) => f.text)
    check('13p', '⑥ ★反证：挖掉替换节点的排除 ⇒ 英文 checkpoint 前言必成楼（本条断言：它不在楼里 ⇒ 旧写法下必红）',
      floorsRevB.some((t) => t.includes('automatically generated checkpoint'))
      && !pruneFloors.some((t) => t.includes('automatically generated checkpoint')), '旧写法下 checkpoint 没成楼？')
  }

  // ═══ 14. 真实形状夹具：一次压缩（208 段 / 279 seq）跑完整 planScan —— 前 / 后对照 ═══
  //
  //   夹具**按任务书 §1-① 的真机读数复刻结构**（合成数据，不是真机会话）：一次 compaction/summary 的
  //   shadowedSeqs 共 279 个、min 9 / max 1068，其中 shadowed 段有 **208** 段（宽度 138×1 + 69×2 + 1×3）；
  //   段间的空隙是**未被遮蔽**的 slot（真机那条会话就是这样 ⇒ 旧判据把一次压缩切成 208 段）。
  //   改造前（旧判据 + 便宜路径的文档形状）= 208 区间 / 全部 mechanical（真机 §1-① 实测同形）；
  //   改造后（新判据 + 原始事件）= 2 个区间（1 条 summary + 1 条 prune），其中 1 条 model-summary。
  //   ★★ 2026-09-22 本单：这份模型摘要按**真机那份的形状**造 —— 模型回的不是一段纯文本，而是
  //   **结构化 JSON**（`[{"summary":散文,"tags":{vibe,special,important}},…]`）；美化 + 标签化之后
  //   落盘的才是散文 + 非空 tags（改造前的真机形态 = 正文就是这份 JSON、tags 空 + tags-empty）。
  const MS14_JSON = '[{"summary":"第1天 清晨: 真机形状夹具的甲段散文（假）","tags":{"vibe":"Serious","special":[],"important":false}},{"summary":"第2天 深夜: 真机形状夹具的乙段散文（假）","tags":{"vibe":"Romantic","special":["Important"],"important":true}}]'
  const MS14_TEXT = '第1天 清晨: 真机形状夹具的甲段散文（假）\n第2天 深夜: 真机形状夹具的乙段散文（假）'
  const MS14_TAGS = ['Serious', 'Romantic', 'Important']
  function buildRealShapeShadowSeqs() {
    const widths = []
    for (let i = 0; i < 138; i++) widths.push(1)
    for (let i = 0; i < 69; i++) widths.push(2)
    widths.push(3)
    const runs = widths.length // 208
    const total = widths.reduce((a, b) => a + b, 0) // 279
    const gapCount = runs - 1 // 207
    let extra = (1068 - 9 + 1) - total - gapCount // 574 个多余 slot，摊到各段之间的空隙里
    const gaps = []
    for (let i = 0; i < gapCount; i++) {
      const share = Math.floor(extra / (gapCount - i))
      gaps.push(1 + share)
      extra -= share
    }
    const seqs = []
    let cur = 9
    for (let i = 0; i < runs; i++) {
      for (let k = 0; k < widths[i]; k++) seqs.push(cur + k)
      cur += widths[i]
      if (i < runs - 1) cur += gaps[i]
    }
    return seqs
  }
  function buildRealShapeEvents(asDocs = false) {
    const shadowed = new Set(buildRealShapeShadowSeqs())
    const list = []
    for (let seq = 0; seq <= 8; seq++) list.push(USER(seq, '机制占位串' + seq, seq % 3 === 0 ? 'plugin' : null, 'current'))
    let n = 0
    for (let seq = 9; seq <= 1068; seq++) {
      if (!shadowed.has(seq)) { list.push(USER(seq, '未被遮蔽的占位串' + seq, 'user', 'current')); continue }
      const k = n++
      const surface = 'shadowed'
      // 密度照真机那 279 个被遮蔽节点的构成：机制楼（工具/插件注入/技能清单/纯工具调用消息）约占 1/5，
      // 其余是真对话 —— 于是「一次压缩」落成的楼数在 maxFloorsPerRegion(200) 之下（真机 214 楼里 44 条是机制）
      if (k % 7 === 3) list.push(TOOL_CALL_EV(seq, T_TOOLCALL))
      else if (k % 7 === 6) list.push(TOOL_RESULT_EV(seq, T_TOOLRESULT))
      else if (k % 13 === 5) list.push(USER(seq, T_PLUGIN, 'plugin', surface))
      else if (k % 17 === 9) list.push(USER(seq, T_SKILL, 'skill-catalog', surface))
      else if (k % 23 === 11) list.push(ASST(seq, [REASON(T_REASON), TOOLCALL_BLOCK(T_TOOLCALL)[1]], surface)) // 全是工具调用块 ⇒ 不成楼
      else if (k % 2 === 0) list.push(USER(seq, '剧情占位（玩家）' + k, 'user', surface))
      else list.push(ASST(seq, [TEXT('剧情占位（角色）' + k)], surface))
    }
    list.push(SUMMARY_EV(1069, [...shadowed], MS14_JSON))
    list.push(CHECKPOINT_EV(1070, T_CHECKPOINT))
    for (let seq = 1071; seq <= 1100; seq++) {
      if (seq % 7 === 0) list.push(TOOL_RESULT_EV(seq, T_TOOLRESULT))
      else if (seq % 2 === 0) list.push(USER(seq, 'prune 段占位（玩家）' + seq, 'user'))
      else list.push(ASST(seq, [TEXT('prune 段占位（角色）' + seq)]))
    }
    list.push(PRUNE_EV(1101, [...Array(1101 - 1070).keys()].map((i) => 1070 + i)))
    for (let seq = 1102; seq <= 1110; seq++) list.push(USER(seq, '当前面占位串' + seq, 'user', 'current'))
    if (!asDocs) return list
    // 便宜路径的文档形状（`buildSessionEventSearchDocuments` 的产物：**没有 data**）
    return list.map((e) => ({ sessionId: 'sess-14', seq: e.seq, type: e.type, time: e.time, surface: e.surface, text: FIX[1] }))
  }
  {
    const dshA = mkdtempSync(join(workRoot, 'dshA-'))
    const planNew = await planScan(input5, { loadRawEvents: async () => ({ events: buildRealShapeEvents() }), maxExistingFloor: async () => null, collect: makeFakeCollect().collect, dshHome: dshA })
    const byKind = {}
    for (const r of planNew.regions) byKind[r.summaryKind + (r.summaryFallback ? ':' + r.summaryFallback : '')] = (byKind[r.summaryKind + (r.summaryFallback ? ':' + r.summaryFallback : '')] || 0) + 1
    out('    · 改造后（新判据 + 原始事件）：' + planNew.scanned + ' 个区间 / ' + JSON.stringify(byKind)
      + '；楼数 ' + planNew.regions.map((r) => r.floorCount).join('+') + '；warnings ' + planNew.warnings.length + ' 条')
    out('    · 改造后区间：' + planNew.regions.map((r) => r.regionId + '(' + r.summaryKind + ')').join(' / '))
    check('14a', '★ 改造后：区间数 = 压缩次数（1 条 summary + 1 条 prune = 2），且一条 model-summary、一条 prune 回落',
      planNew.scanned === 2
      && planNew.regions.filter((r) => r.summaryKind === 'model-summary').length === 1
      && planNew.regions.filter((r) => r.summaryFallback === 'no-model-summary').length === 1,
      JSON.stringify(planNew.regions.map((r) => [r.regionId, r.summaryKind, r.summaryFallback])))
    const bigRegion = planNew.regions[0]
    check('14b', '★ 改造后：那一次压缩 = **一个** region-9-1068（docCount = 279 = shadowedSeqs 个数）',
      bigRegion.regionId === 'region-9-1068' && bigRegion.docCount === 279,
      JSON.stringify({ id: bigRegion.regionId, docCount: bigRegion.docCount }))
    const bigFloors = mapRegionToFloors(findShadowRegionsFromEvents(buildRealShapeEvents())[0], 0).floors.map((f) => f.text)
    check('14c', '★ 改造后：楼里只有真对话（工具·插件注入·checkpoint 与思维链一个都不在）',
      !bigFloors.some((t) => t.includes(T_TOOLCALL) || t.includes(T_TOOLRESULT) || t.includes(T_PLUGIN) || t.includes(T_REASON) || t.includes('automatically generated checkpoint')),
      JSON.stringify(bigFloors.filter((t) => t.includes('占位串')).slice(0, 3)))
    check('14d', '★ 改造后：模型摘要是那一份（**美化后的散文**，不是 80 字截断桩、也不是 JSON 原文）',
      bigRegion.summaryKind === 'model-summary' && bigRegion.summary.text === MS14_TEXT,
      JSON.stringify(bigRegion.summary && bigRegion.summary.text.slice(0, 20)))
    check('14g', '★ 改造后：那份摘要的 tags 非空（各段并集、词表内）= [Serious, Romantic, Important]',
      JSON.stringify(bigRegion.summary.meta.tags) === JSON.stringify(MS14_TAGS)
      && !planNew.warnings.some((w) => w.includes('tags-empty')),
      JSON.stringify({ tags: bigRegion.summary.meta.tags, w: planNew.warnings.filter((w) => w.includes('tags-')) }))
    check('14h', '★ 改造后：真机形状夹具的归档正文里**没有** JSON 外壳（"summary" / { / [ / "tags" 一个都没有）',
      !bigRegion.summary.text.includes('"summary"') && !bigRegion.summary.text.includes('{')
      && !bigRegion.summary.text.includes('[') && !bigRegion.summary.text.includes('"tags"'),
      JSON.stringify(bigRegion.summary.text.slice(0, 60)))
    // ── 改造前：同一份会话的**文档形状**喂**旧判据**的副本（这就是真机那 208 个区间怎么来的）──
    const rev14 = await import(pathToFileURL(join(reverted13, 'lib', 'collect-scan.js')).href)
    const planOld = await rev14.planScan(input5, { loadRawEvents: async () => ({ events: buildRealShapeEvents(true) }), maxExistingFloor: async () => null, collect: makeFakeCollect().collect, dshHome: mkdtempSync(join(workRoot, 'dshB-')) })
    const oldRunsInBigSpan = planOld.regions.filter((r) => r.toSeq <= 1068).length
    const oldLive = planOld.regions.filter((r) => !r.skipped)
    out('    · 改造前（旧判据 + 文档形状）：' + planOld.scanned + ' 个区间（其中 ' + oldRunsInBigSpan + ' 段来自那一次压缩）'
      + '；摘要来源 ' + JSON.stringify([...new Set(oldLive.map((r) => r.summaryKind + '/' + r.summaryFallback))])
      + '；' + oldLive.length + ' 段有楼 / 其余 ' + (planOld.scanned - oldLive.length) + ' 段被跳过')
    out('    · 改造前前几个区间：' + planOld.regions.slice(0, 4).map((r) => r.regionId + '(楼' + r.floorCount + ')').join(' / '))
    check('14e', '★ 改造前（同一夹具 + 旧判据 + 文档形状）：那一次压缩被切成 **208** 段、每条都 mechanical/no-model-summary（真机 §1-① 同形）',
      oldRunsInBigSpan === 208
      && oldLive.length > 0 && oldLive.every((r) => r.summaryKind === 'mechanical' && r.summaryFallback === 'no-model-summary'),
      JSON.stringify({ scanned: planOld.scanned, bigSpanRuns: oldRunsInBigSpan, kinds: [...new Set(oldLive.map((r) => r.summaryKind + ':' + r.summaryFallback))] }))
  }
  rmSync(reverted13, { recursive: true, force: true })
  rmSync(revertedFloor13, { recursive: true, force: true })
  check('14f', '反证副本已删（⛔ 不给仓库留垃圾）', !existsSync(reverted13) && !existsSync(revertedFloor13), '')

  // ═══ 15. 接线：lib/index.js 的 createRawEventLoader（loadSessionLog 包装）═══════════════
  //   ① 行为：喂一个**活注册表**（ctx.sessions.get(id).snapshotEvents()）⇒ 装载器给出的就是带 data 的
  //      原始事件，且**同一条事件**能直接喂出区间、插件注入守卫**真的有牙**（这就是本单换注入面的目的）；
  //   ② 反证：宿主没挂 sessionQuery ⇒ **抛**（⛔ 绝不返回空数组冒充"这会话没内容"）；
  //   ③ 接线锚（静态）：三条调用点确实传的是 createRawEventLoader（行为在 ①② 已直测）。
  {
    const idx = await import(pathToFileURL(join(here, 'lib', 'index.js')).href)
    check('15a', 'lib/index.js 导出 createRawEventLoader', typeof idx.createRawEventLoader === 'function', typeof idx.createRawEventLoader)
    const fixture15 = events13()
    const ctx15 = {
      sessions: { get: (id) => (id === 'sess-15' ? { snapshotEvents: () => fixture15, header: { id: 'sess-15' } } : undefined) },
      get: (name) => (name === 'sessionQuery' ? {} : undefined),
    }
    const loaded = await idx.createRawEventLoader(ctx15)('sess-15')
    check('15b', '★ 装载器给出**带 data 的原始事件**（via=live ⇒ loadSessionLog 的活注册表那条路）',
      loaded && Array.isArray(loaded.events) && loaded.events.length === fixture15.length && loaded.via === 'live'
      && typeof loaded.events[9].data === 'object' && loaded.events[9].data !== null && Array.isArray(loaded.events[9].data.shadowedSeqs),
      JSON.stringify({ via: loaded && loaded.via, n: loaded && loaded.events && loaded.events.length }))
    const regions15 = findShadowRegionsFromEvents(loaded.events)
    const floors15 = floorsOf(regions15[0])
    check('15c', '★ 接线后同样的判据：1 个区间 / 楼里只有真对话 / 插件注入被挡在楼外',
      regions15.length === 1 && floors15.length === 4 && !floors15.some((t) => t.includes(T_PLUGIN)),
      JSON.stringify({ regions: regions15.length, floors: floors15.length }))
    let err15 = null
    try { await idx.createRawEventLoader({ get: () => undefined })('sess-15') } catch (e) { err15 = e }
    check('15d', '★反证：宿主没挂 sessionQuery ⇒ **抛**（⛔ 不返回空数组冒充"没有内容"）',
      !!err15 && String(err15.message).includes('sessionQuery'), JSON.stringify(err15 && err15.message))
    const idxSrc = readFileSync(join(here, 'lib', 'index.js'), 'utf8')
    check('15e', '接线锚（静态）：/collect/scan · /collect/auto 两条分派行与自动收纳钩子都传 createRawEventLoader',
      (idxSrc.match(/createRawEventLoader\(/g) || []).length >= 4 // 1 处定义 + 3 处调用
      && idxSrc.includes("m.handleCollectScan(ctx, req, send, log, createRawEventLoader(ctx), currentCompactionInstruction())")
      && idxSrc.includes("m.handleCollectAuto(ctx, req, send, log, createRawEventLoader(ctx), currentCompactionInstruction())")
      && idxSrc.includes('loadRawEvents: createRawEventLoader(scope)'),
      String((idxSrc.match(/createRawEventLoader\(/g) || []).length))
  }

  // ═══ 16. ★★ 任务书 §3 的五对：摘要**美化**（JSON → 散文）+ tags **标签化** ═══════════════
  //
  //   真机症状（任务书 §1-①，逐字）：归档正文落的就是模型那份 JSON（外壳/键名/花括号全在里面），
  //   而 tags 一个字都没收（两条摘要都记了 tags-empty）—— 因为这份 tags 是**逐段嵌在 JSON 里的
  //   对象**，而旧取法 extractTagsLine 找的是「正文**末尾**的 `tags:` 行」。
  //   反证手法同第 12/13 节：拷 lib 到临时目录 → 只改那一处 → import 副本 → 喂**同一套夹具**；
  //   ⛔ 本仓的 lib 一字未动（16n 锁死）。夹具全是占位散文（⛔ 无真实提示词原文/会话正文）。
  const MS_JSON = '[{"summary":"甲段散文","tags":{"vibe":"Serious","special":[],"important":false}},{"summary":"乙段散文","tags":{"vibe":"Romantic","special":["Important"],"important":true}}]'
  const MS_JSON_PREFIX = '[{"summary":"第1天 清晨: 甲段散文","tags":{"vibe":"Serious","special":[],"important":false}}]'
  const MS_PROSE = '1966年9月1日 上午：她在陌生的旅馆房间醒来（占位散文，不是 JSON）。'
  const MS_PROSE_TAGS = '甲段散文（占位）\ntags: {"vibe":"Angst","special":[],"important":false}'
  const MS_HALF_JSON = '[{"summary": '
  const MS_NONSENSE = '[{"summary":"甲段散文","tags":{"vibe":"Serious","special":["Nonsense"],"important":false}}]'
  const MS_ALL_EMPTY = '[{"summary":"甲段散文","tags":{"vibe":"","special":[],"important":false}}]'
  /** 一份夹具：**一次压缩**（模型原文 = 传进来的那份）+ 两条真对话 ⇒ 1 个区间。 */
  const eventsMs = (summaryText) => [USER(0, FIX[0], 'user'), ASST(1, [TEXT(FIX[1])]), SUMMARY_EV(9, [0, 1], summaryText)]
  const planOfSummary = (summaryText) => planScan(inputD1, depsD1(eventsMs(summaryText)))
  const tagsOf = (r) => (r && r.summary && r.summary.meta ? r.summary.meta.tags : null)
  const rvText16 = mkdtempSync(join(tmpdir(), 'dma-scan-beauty-text-'))
  const rvTags16 = mkdtempSync(join(tmpdir(), 'dma-scan-beauty-tags-'))
  const rvDrop16 = mkdtempSync(join(tmpdir(), 'dma-scan-beauty-drop-'))
  const rvOld16 = mkdtempSync(join(tmpdir(), 'dma-scan-beauty-old-'))
  for (const d of [rvText16, rvTags16, rvDrop16, rvOld16]) {
    cpSync(join(here, 'lib'), join(d, 'lib'), { recursive: true })
    writeFileSync(join(d, 'package.json'), JSON.stringify({ type: 'module' }) + '\n', 'utf8')
  }
  {
    // ── 反证副本 A（对 1）：**美化那一步**换成"直接用模型原文"（= 旧写法：text 就是 raw）──
    const pA = join(rvText16, 'lib', 'collect-scan.js')
    let sA = readFileSync(pA, 'utf8').replace(/\r\n/g, '\n') // ★ 2026-09-25：行尾归一 —— 针里带 \n，CRLF 段必失配（判据一字未动）
    const bA = sA
    sA = sA.replace('    text: beauty.text,\n', '    text: raw,\n')
    check('16a0', '反证副本 A 就位：美化那一步已换成"直接用模型原文"（⛔ 原文件一字未动）',
      sA !== bA && sA.includes('    text: raw,\n')
      && readFileSync(join(here, 'lib', 'collect-scan.js'), 'utf8').replace(/\r\n/g, '\n').includes('    text: beauty.text,\n'), '')
    writeFileSync(pA, sA, 'utf8')
    // ── 反证副本 B（对 2）：tags 收编换成**老路** extractTagsLine（= 2026-09-22 之前的取法）──
    const pB = join(rvTags16, 'lib', 'collect-scan.js')
    let sB = readFileSync(pB, 'utf8').replace(/\r\n/g, '\n') // ★ 2026-09-25：行尾归一 —— 针里带 \n，CRLF 段必失配（判据一字未动）
    const bB = sB
    sB = sB
      .replace('    tags: beauty.tags,\n    warnings: beauty.warnings,\n',
        '    tags: legacyTagsForProof(raw).tags,\n    warnings: legacyTagsForProof(raw).warnings,\n')
    sB += `
// ⛔⛔ 反证专用（**只注入到副本里**）：2026-09-22 之前的 tags 取法 —— 从**正文末尾**找 \`tags:\` 行，
//   逐字照抄当时 planScan 里那一段（改的只是"取哪儿"：老路拿的是**模型原文**）。
function legacyTagsForProof(text) {
  const extracted = extractTagsLine(text)
  if (!extracted.found) {
    return { tags: [], warnings: ['模型摘要没有可解析的 tags 行，tags 按空数组归档（tags-empty）'] }
  }
  const verdict = validateTags(extracted.parsed)
  return {
    tags: flattenTags(verdict.tags),
    warnings: verdict.ok ? [] : ['tags 有收编不进的值（已剔除），只归档词表内的部分（tags-partial）'],
  }
}
`
    check('16b0', '反证副本 B 就位：tags 收编已换回老路 extractTagsLine（⛔ 原文件一字未动）',
      sB !== bB && sB.includes('legacyTagsForProof(raw).tags') && !sB.includes('    tags: beauty.tags,\n')
      && readFileSync(join(here, 'lib', 'collect-scan.js'), 'utf8').replace(/\r\n/g, '\n').includes('    tags: beauty.tags,\n'), '')
    writeFileSync(pB, sB, 'utf8')
    // ── 反证副本 C（对 3）：fail-open 换成"解析不出就**丢** / 就**回落机械**"（假设的错写法）──
    const pC = join(rvDrop16, 'lib', 'collect-scan.js')
    let sC = readFileSync(pC, 'utf8').replace(/\r\n/g, '\n') // ★ 2026-09-25：行尾归一 —— 针里带 \n，CRLF 段必失配（判据一字未动）
    const bC = sC
    sC = sC
      .replace("  if (beauty.echo === true) return { kind: 'mechanical', reason: 'prompt-echo' }\n",
        "  if (beauty.echo === true || beauty.text === '') return { kind: 'mechanical', reason: 'no-model-summary' }\n")
      .replace("    text: String(raw ?? ''),\n", "    text: '',\n")
    check('16c0', '反证副本 C 就位：fail-open 已换成"解析不出就丢/就回落机械"（⛔ 原文件一字未动）',
      sC !== bC && sC.includes("if (beauty.echo === true || beauty.text === '')") && sC.includes("    text: '',\n")
      && readFileSync(join(here, 'lib', 'collect-scan.js'), 'utf8').replace(/\r\n/g, '\n').includes("  if (beauty.echo === true) return { kind: 'mechanical', reason: 'prompt-echo' }\n"), '')
    writeFileSync(pC, sC, 'utf8')
    // ── 反证副本 D（任务书 §6-3 的"改造前"）：**两条旧写法合成** —— 正文直接用模型原文
    //    （副本 A 那一处）+ tags 走老路 extractTagsLine（副本 B 那一处）= 本单开工前的真机形态 ──
    const pD = join(rvOld16, 'lib', 'collect-scan.js')
    let sD = readFileSync(pD, 'utf8').replace(/\r\n/g, '\n') // ★ 2026-09-25：行尾归一 —— 针里带 \n，CRLF 段必失配（判据一字未动）
    const bD = sD
    sD = sD
      .replace('    text: beauty.text,\n', '    text: raw,\n')
      .replace('    tags: beauty.tags,\n    warnings: beauty.warnings,\n',
        '    tags: legacyTagsForProof(raw).tags,\n    warnings: legacyTagsForProof(raw).warnings,\n')
    sD += sB.slice(sB.indexOf('\n// ⛔⛔ 反证专用')) // 复用副本 B 里那段老路实现（同一份文本）
    check('16d0', '反证副本 D 就位：两条旧写法都已合成（正文=原文 + tags 走老路）',
      sD !== bD && sD.includes('    text: raw,\n') && sD.includes('legacyTagsForProof(raw).tags')
      && readFileSync(join(here, 'lib', 'collect-scan.js'), 'utf8').includes('const beauty = beautifyModelSummary(raw, { instruction })'), '')
    writeFileSync(pD, sD, 'utf8')
    const revText16 = await import(pathToFileURL(pA).href)
    const revTags16 = await import(pathToFileURL(pB).href)
    const revDrop16 = await import(pathToFileURL(pC).href)
    const revOld16 = await import(pathToFileURL(pD).href)

    // ── 对 1（相｜美化）：真机形状 ⇒ 正文 = 各段散文 '\n' 连接；⛔ 一个 JSON 外壳字节都不落 ──
    //   ★ 相与反证共用**同一个谓词**（noJsonShell）⇒ "旧写法下必红"是字面意义上的必红。
    const noJsonShell = (t) => typeof t === 'string' && t !== ''
      && !t.includes('"summary"') && !t.includes('{') && !t.includes('[') && !t.includes('"tags"')
    // ── 对 2 的那条断言（相/反证共用）──
    const WANT_TAGS = ['Serious', 'Romantic', 'Important']
    const tagsOk = (t) => JSON.stringify(t) === JSON.stringify(WANT_TAGS)
    // ── 对 3 的那条断言（相/反证共用）──
    const failOpenOk = (r, raw) => !!r && r.summaryKind === 'model-summary' && r.summary.text === raw
    const p1 = await planOfSummary(MS_JSON)
    const r1 = regionOf(p1)
    const t1 = r1 && r1.summary ? r1.summary.text : ''
    check('16a', '① 相｜美化：真机形状的模型原文（两段 JSON）⇒ 正文 = 「甲段散文\\n乙段散文」',
      t1 === '甲段散文\n乙段散文', JSON.stringify(t1))
    check('16b', '① 相｜美化：⛔ 正文里不许有 JSON 外壳（"summary" / { / [ / "tags" 一个都没有）',
      noJsonShell(t1), JSON.stringify(t1.slice(0, 40)))
    const p1b = await planOfSummary(MS_JSON_PREFIX)
    const r1b = regionOf(p1b)
    check('16c', '① 相｜美化：item 自带的**分段前缀**（「第1天 清晨: 」）原样保留、⛔ 不再包一层',
      r1b && r1b.summary.text === '第1天 清晨: 甲段散文', JSON.stringify(r1b && r1b.summary.text))
    // ① 反证：同一夹具喂"正文直接用模型原文"的副本 ⇒ **同一个谓词** noJsonShell 必红
    const p1v = await revText16.planScan(inputD1, depsD1(eventsMs(MS_JSON)))
    const r1v = regionOf(p1v)
    const t1v = r1v && r1v.summary ? r1v.summary.text : ''
    out('    · ① 反证：正文直接用模型原文 ⇒ 正文 = ' + JSON.stringify(t1v.slice(0, 44)) + '…')
    check('16d', '① ★反证：正文直接用模型原文 ⇒ noJsonShell(旧正文) = false ⇒ 16b 必红',
      t1v.includes('"summary"') && t1v.includes('{') && t1v.includes('[') && noJsonShell(t1v) === false,
      JSON.stringify({ oldHasShell: t1v.slice(0, 60), noJsonShell_old: noJsonShell(t1v), noJsonShell_new: noJsonShell(t1) }))

    // ── 对 2（相｜标签化）：各段 tags 收编后合并去重（并集，首次出现顺序）──
    const p2 = await planOfSummary(MS_JSON)
    const r2 = regionOf(p2)
    const tags2 = tagsOf(r2)
    check('16e', '② 相｜标签化：tags = 各段并集 [Serious, Romantic, Important]（去重 + 首次出现顺序）',
      tagsOk(tags2), JSON.stringify(tags2))
    check('16f', '② 相｜标签化：tags 全在冻结词表内（10 vibe + Important），且**没有** tags-empty',
      Array.isArray(tags2) && tags2.every((t) => TAG_VOCABULARY.includes(t))
      && !p2.warnings.some((w) => w.includes('tags-empty')), JSON.stringify({ tags: tags2, w: p2.warnings }))
    // ② 反证：同一夹具喂"tags 走老路 extractTagsLine"的副本 ⇒ **同一个谓词** tagsOk 必红（且必是 [] + tags-empty）
    const p2v = await revTags16.planScan(inputD1, depsD1(eventsMs(MS_JSON)))
    const r2v = regionOf(p2v)
    const tags2v = tagsOf(r2v)
    out('    · ② 反证：老路（找正文末尾的 tags: 行）⇒ tags = ' + JSON.stringify(tags2v)
      + '；tags-* 播报 ' + JSON.stringify(p2v.warnings.filter((w) => w.includes('tags-'))))
    check('16g', '② ★反证：老路在同一夹具上 tags 必为 []、出现 tags-empty ⇒ tagsOk(旧 tags) = false ⇒ 16e 必红',
      JSON.stringify(tags2v) === '[]' && p2v.warnings.some((w) => w.includes('tags-empty')) && tagsOk(tags2v) === false,
      JSON.stringify({ old: tags2v, tagsOk_old: tagsOk(tags2v), tagsOk_new: tagsOk(tags2) }))

    // ── 对 3（相｜fail-open 纯散文）：正文原样（⛔ 不丢、⛔ 不回落机械），tags 走老路 ──
    const p3 = await planOfSummary(MS_PROSE)
    const r3 = regionOf(p3)
    check('16h', '③ 相｜fail-open（纯散文）：正文**原样**落盘、kind 仍 model-summary（⛔ 不丢、⛔ 不回落机械）+ 如实 warning',
      failOpenOk(r3, MS_PROSE) && p3.warnings.some((w) => w.includes('summary-plain')),
      JSON.stringify(r3 && { kind: r3.summaryKind, text: r3.summary.text.slice(0, 24) }))
    const p3b = await planOfSummary(MS_PROSE_TAGS)
    const r3b = regionOf(p3b)
    check('16i', '③ 相｜fail-open：tags 走**老路**（正文末尾的 `tags:` 行照样收得进，⛔ 老路没删）',
      r3b && JSON.stringify(tagsOf(r3b)) === JSON.stringify(['Angst']), JSON.stringify(tagsOf(r3b)))
    // ③ 反证：把 fail-open 改成"解析不出就丢/就回落机械" ⇒ **同一个谓词** failOpenOk 必红
    const p3v = await revDrop16.planScan(inputD1, depsD1(eventsMs(MS_PROSE)))
    const r3v = regionOf(p3v)
    // ⚠️ 这里**不许打印正文**：副本回落机械条目（= 由夹具楼正文合成的），打印它就等于把 fixture
    //    前 12 字写进自检输出（8d 会红）—— 只报事实（还是不是原文 / 正文长度）。
    const shape3v = r3v && r3v.summary
      ? { kind: r3v.summaryKind, why: r3v.summaryFallback, bytes: Buffer.byteLength(r3v.summary.text, 'utf8'), sameAsRaw: r3v.summary.text === MS_PROSE }
      : r3v
    out('    · ③ 反证：fail-open 改成"解析不出就丢/就回落机械" ⇒ ' + JSON.stringify(shape3v))
    check('16j', '③ ★反证：改成"丢/回落机械" ⇒ failOpenOk(旧结果) = false ⇒ 16h 必红',
      failOpenOk(r3v, MS_PROSE) === false, JSON.stringify(shape3v))

    // ── 对 4（相｜fail-open 坏 JSON）：半个 JSON ⇒ 正文逐字原样（⛔ 一个字节都没丢）+ 如实 warning ──
    const p4 = await planOfSummary(MS_HALF_JSON)
    const r4 = regionOf(p4)
    check('16k', '④ 相｜fail-open（坏 JSON）：正文**逐字**等于模型原文（含尾部空格，字节数一致）+ 如实 warning',
      r4 && r4.summary.text === MS_HALF_JSON
      && Buffer.byteLength(r4.summary.text, 'utf8') === Buffer.byteLength(MS_HALF_JSON, 'utf8')
      && p4.warnings.some((w) => w.includes('summary-plain')),
      JSON.stringify({ text: r4 && r4.summary.text, bytes: r4 && Buffer.byteLength(r4.summary.text, 'utf8') }))

    // ── 对 5（相｜词表外 / 全空）：剔除 + tags-partial；全空 ⇒ tags-empty（沿用）──
    const p5 = await planOfSummary(MS_NONSENSE)
    const r5 = regionOf(p5)
    check('16l', '⑤ 相｜词表外的 tag（special:["Nonsense"]）⇒ 剔除并播报 tags-partial，词表内的留下',
      r5 && JSON.stringify(tagsOf(r5)) === JSON.stringify(['Serious'])
      && p5.warnings.some((w) => w.includes('tags-partial')), JSON.stringify(tagsOf(r5)))
    const p5b = await planOfSummary(MS_ALL_EMPTY)
    const r5b = regionOf(p5b)
    check('16m', '⑤ 相｜全空（vibe:"" special:[] important:false）⇒ tags=[] + tags-empty（沿用现枚举）',
      r5b && JSON.stringify(tagsOf(r5b)) === '[]' && p5b.warnings.some((w) => w.includes('tags-empty')),
      JSON.stringify({ tags: tagsOf(r5b), w: p5b.warnings }))

    // ── §6-3：**真机形状夹具**（第 14 节那份：279 seq / 一次压缩 + 一次 prune）跑一遍 planScan
    //    改造前 / 改造后对照 —— 改造前喂副本 D（正文=原文 + tags 走老路），改造后喂本仓的 lib。
    //    ⚠️ 只打印两边的**事实**（正文长度、是否含 JSON 外壳、tags），⛔ 不打印楼正文（8d 会红）。──
    const realEvents = () => buildRealShapeEvents()
    const afterPlan = await planScan(inputD1, depsD1(realEvents()))
    const afterRegion = afterPlan.regions.find((r) => r.summaryKind === 'model-summary')
    const beforePlan = await revOld16.planScan(inputD1, depsD1(realEvents()))
    const beforeRegion = beforePlan.regions.find((r) => r.summaryKind === 'model-summary')
    const shapeOfSummary = (plan, r) => (r && r.summary
      ? {
        bytes: Buffer.byteLength(r.summary.text, 'utf8'),
        hasJsonShell: String(r.summary.text).includes('"summary"'),
        tags: r.summary.meta ? r.summary.meta.tags : null,
        tagsWarn: plan.warnings.filter((w) => w.includes('tags-')),
      }
      : null)
    const beforeShape = shapeOfSummary(beforePlan, beforeRegion)
    const afterShape = shapeOfSummary(afterPlan, afterRegion)
    out('    · §6-3 改造前（真机形状夹具，正文=模型原文 + tags 走老路）：' + JSON.stringify(beforeShape))
    out('    · §6-3 改造后（同一夹具，同一份 lib）：' + JSON.stringify(afterShape))
    check('16p', '★ §6-3 改造前：真机形状夹具 ⇒ 正文是那份 JSON（含 "summary"）、tags=[] 且播报 tags-empty',
      !!beforeShape && beforeShape.hasJsonShell === true && JSON.stringify(beforeShape.tags) === '[]'
      && beforeShape.tagsWarn.some((w) => w.includes('tags-empty')),
      JSON.stringify(beforeShape))
    check('16q', '★ §6-3 改造后：同一夹具 ⇒ 正文是散文（⛔ 无 JSON 外壳）、tags 非空 = [Serious, Romantic, Important]',
      !!afterShape && afterShape.hasJsonShell === false && JSON.stringify(afterShape.tags) === JSON.stringify(MS14_TAGS)
      && afterShape.bytes < beforeShape.bytes,
      JSON.stringify(afterShape))

    // ── 本轮反证全程没碰本仓的 lib（四条锚点都在原文件里）──
    const nowSrc16 = readFileSync(join(here, 'lib', 'collect-scan.js'), 'utf8')
    check('16n', '★ 本轮反证全程没有碰过本仓的 lib（四条锚点都还在原文件里）',
      nowSrc16.includes('const beauty = beautifyModelSummary(raw, { instruction })')
      && nowSrc16.includes('    text: beauty.text,\n') && nowSrc16.includes('    tags: beauty.tags,\n')
      && nowSrc16.includes("    text: String(raw ?? ''),\n") && nowSrc16.includes('const legacy = tagsLineOf(raw)'), '')
  }
  for (const d of [rvText16, rvTags16, rvDrop16, rvOld16]) rmSync(d, { recursive: true, force: true })
  check('16o', '反证副本已删（⛔ 不给仓库留垃圾）',
    ![rvText16, rvTags16, rvDrop16, rvOld16].some((d) => existsSync(d)), '')

  // ═══ 17. ★★ 2026-09-22 第二单（任务书 §3 的六对）：归档摘要**按段切片** ══════════════════════
  //
  //   用户口径（逐字）：「摘要没做切分吗，我看到是一大段一条。但内部是有分段的。这回影响向量检索吗」
  //   —— **影响**，而且这正是旧管线做过的事：检索的粒度就是「**一个摘要文件 = 一条切片**」
  //   （anima 的 autoIngestOnce 整文件一条、⛔ 入库侧不切块）。真机 mt-0000-0167.md 是 1690 字一条、
  //   内部 45 个叙事段 ⇒ 45 段挤成一个向量点（语义被平均掉）、命中就灌 1690 字、再长还会撞
  //   embedding 的长度上限。本单要的：结构化那一路**一个叙事段 = 一条摘要条目**（一条 `.md` +
  //   `index.json` 一条 entry），每段带**它自己的** tags；机械兜底与 fail-open 两路照旧一条。
  //
  //   这一节每条都走**真链路**：collectOnce（真接线）→ planScan/applyScan → A1（真 lib/collect.js）
  //   → **真 HTTP 的假 Tavern** ⇒ 断言的是 `index.json` 里**真实追加了几条**、`.md` 里**逐字**是什么
  //   （⛔ 不是源码字符串断言）。反证一律：拷 lib 到临时目录 → 只改那一处（旧写法）→ import 副本 →
  //   喂**同一套夹具**（本仓 lib 一字未动，17v 锁死）。夹具全是占位散文（⛔ 无真实提示词/会话正文）。
  const CHAR17 = 'char-slices-0001'
  const SL_PT = (tag) => 'pt-slices-' + tag
  /** 三段散文合计 **1690 字**（对齐真机 mt-0000-0167.md 那条 1690 字的读数）。 */
  const slProse = (day, phase, len) => {
    const head = `第${day}天 ${phase}: `
    return head + '占位散文'.repeat(300).slice(0, Math.max(0, len - head.length))
  }
  const SL1 = slProse(1, '清晨', 563)
  const SL2 = slProse(2, '深夜', 563)
  const SL3 = slProse(3, '傍晚', 564)
  const SL_PROSE_TOTAL = Array.from(SL1 + SL2 + SL3).length // 1690
  const slJson = (proses, vibes) =>
    JSON.stringify(proses.map((p, i) => ({ summary: p, tags: { vibe: vibes[i], special: [], important: false } })))
  const SL_VIBES3 = ['Serious', 'Romantic', 'Suspense']
  const SL_JSON3 = slJson([SL1, SL2, SL3], SL_VIBES3)
  const SL_JSON1 = slJson([SL1], ['Serious'])
  const SL_PLAIN = '没解析成结构化条目的整篇原文（占位散文；改造前这一整篇会落成一条）'
  /** 每案一段**各自的**对话正文：台账 contentHash 只认正文 ⇒ 各案互不幂等冲突（真机同理）。 */
  const slEvents = (tag, summaryText, prune) => {
    const head = [USER(0, '切片段落占位（玩家）-' + tag, 'user'), ASST(1, [TEXT('切片段落占位（角色）-' + tag)])]
    return prune ? [...head, PRUNE_EV(9, [0, 1])] : [...head, SUMMARY_EV(9, [0, 1], summaryText)]
  }
  const SL_CASES = ['three', 'one', 'plain', 'prune', 'revert-join', 'revert-union', 'revert-replan']
  const fake17 = createFakeTavern()
  await fake17.start()
  fake17.files.set('catalog.json', JSON.stringify({
    schemaVersion: 1,
    playthroughs: SL_CASES.map((tag) => ({
      id: SL_PT(tag),
      path: `${CHAR17}/${SL_PT(tag)}/timeline.json`,
      ext: { pmpDshTavern: { characterId: CHAR17, rootSessionId: 'session-17-' + tag } },
    })),
  }) + '\n')
  const dsh17 = mkdtempSync(join(workRoot, 'dsh17-'))
  const ctx17 = { get: (name) => (name === 'sessionQuery' ? { readSession: async () => ({}), filterEvents: async () => [] } : null) }
  /** 真链路跑一次（`mod` 可换成反证副本 ⇒ 同一条链、同一套夹具）。
   *  返回 `{ result, warnings }`：⚠️ planScan 的播报（no-model-summary / tags-* / 段级回落…）只出现在
   *  **plan.warnings** 里，applyScan 的 result.warnings 只有台账那几条 —— 断言要看前者。 */
  const runSl = async (mod, tag, summaryText, dshHome, prune) => {
    const out = await mod.collectOnce(ctx17, {
      sessionId: 'session-17-' + tag,
      target: { characterId: CHAR17, playthroughId: SL_PT(tag) },
      auto: true,
      base: fake17.base,
      loadRawEvents: async () => ({ events: slEvents(tag, summaryText, prune === true) }),
      dshHome,
    })
    return { result: out.result, warnings: (out.plan && Array.isArray(out.plan.warnings) ? out.plan.warnings : []).slice() }
  }
  const slDir = (tag) => `${CHAR17}/${SL_PT(tag)}/archive/summaries/`
  const slIndex = (tag) => {
    try {
      return JSON.parse(fake17.files.get(slDir(tag) + 'index.json'))
    } catch {
      return { entries: [] }
    }
  }
  const slBodies = (tag) => (slIndex(tag).entries || []).map((e) => fake17.files.get(slDir(tag) + e.file) ?? null)
  const slFloorFiles = (tag) =>
    [...fake17.files.keys()].filter((p) => p.startsWith(`${CHAR17}/${SL_PT(tag)}/archive/floors/`) && p.endsWith('.json'))
  /** 该案每一次 PUT 的路径 → 次数（「楼层只写一遍」的证据：真 HTTP 的请求流水）。 */
  const slPuts = (tag) => {
    const pre = `${CHAR17}/${SL_PT(tag)}/archive/`
    const m = new Map()
    for (const r of fake17.requests) {
      if (String(r.method).toUpperCase() !== 'PUT') continue
      let p = null
      try {
        p = new URL(r.url, 'http://fake').searchParams.get('path')
      } catch {}
      if (typeof p !== 'string' || !p.startsWith(pre)) continue
      m.set(p, (m.get(p) || 0) + 1)
    }
    return m
  }
  const slNoShell = (t) =>
    typeof t === 'string' && t !== '' && !t.includes('"summary"') && !t.includes('{') && !t.includes('[') && !t.includes('"tags"')
  /** §3-1 的判据（相与反证**共用这一个**）：3 条 entry、每份正文逐字是那一段、⛔ 没有 JSON 外壳。 */
  const slSliced = (tag) => {
    const ents = slIndex(tag).entries || []
    const bodies = slBodies(tag)
    return ents.length === 3
      && ents.map((e) => e.file).join(',') === 'mt-0000-0001-1.md,mt-0000-0001-2.md,mt-0000-0001-3.md'
      && JSON.stringify(bodies) === JSON.stringify([SL1, SL2, SL3])
      && bodies.every(slNoShell)
  }
  /** §3-3 的判据（**段级** tags）：三条 entry 的 tags 各是那一段自己的（⛔ 不是并集）。 */
  const slSegTags = (tag) =>
    JSON.stringify((slIndex(tag).entries || []).map((e) => e.tags)) === JSON.stringify([['Serious'], ['Romantic'], ['Suspense']])
  const slShape = (tag) => ({
    entries: (slIndex(tag).entries || []).map((e) => [e.file, Array.from(String(fake17.files.get(slDir(tag) + e.file) ?? '')).length, e.tags ?? null]),
    bodiesBytes: slBodies(tag).map((t) => Buffer.byteLength(String(t), 'utf8')),
  })
  // ── 四个反证副本（⛔ 只改副本；每条锚点唯一，改完立刻自证"确实改了"）──
  const rv17 = {
    join: mkdtempSync(join(tmpdir(), 'dma-scan-slice-join-')),
    union: mkdtempSync(join(tmpdir(), 'dma-scan-slice-union-')),
    replan: mkdtempSync(join(tmpdir(), 'dma-scan-slice-replan-')),
    guard: mkdtempSync(join(tmpdir(), 'dma-scan-slice-guard-')),
  }
  for (const d of Object.values(rv17)) {
    cpSync(join(here, 'lib'), join(d, 'lib'), { recursive: true })
    writeFileSync(join(d, 'package.json'), JSON.stringify({ type: 'module' }) + '\n', 'utf8')
  }
  {
    // 对 1 的反证：落盘改回**拼成一条**（本单开工前的写法：一次只提交一份摘要）——
    //   两处一起改回（提交处 + applyScan 的现取计划），否则 apply 的现取计划会把它救回来。
    const pA = join(rv17.join, 'lib', 'collect-scan.js')
    let sA = readFileSync(pA, 'utf8').replace(/\r\n/g, '\n') // ★ 2026-09-25：行尾归一 —— 那根针是跨三行的模板串，CRLF 段必失配（判据一字未动）
    const bA = sA
    sA = sA
      .replace(`      ...(Array.isArray(entry.summaries) && entry.summaries.length > 0
        ? { summaries: entry.summaries }
        : { summary: entry.summary }),`, '      summary: entry.summary,')
      .replace('        ...(segments !== null ? { summaries: segments } : { summary: region.summary }),', '        summary: region.summary,')
    check('17a0', '对 1 反证副本就位：落盘已改回「拼成一条」（⛔ 原文件一字未动）',
      sA !== bA && sA.includes('      summary: entry.summary,') && sA.includes('        summary: region.summary,')
      && readFileSync(join(here, 'lib', 'collect-scan.js'), 'utf8').includes('{ summaries: entry.summaries }'), '')
    writeFileSync(pA, sA, 'utf8')
    // 对 3 的反证：tags 改回**各段并集**（本单开工前的写法：一个区间一份，tags 自然是并集）
    const pB = join(rv17.union, 'lib', 'collect-scan.js')
    let sB = readFileSync(pB, 'utf8')
    const bB = sB
    sB = sB.replace('tags: s.tags, meta: { ...sel.meta, tags: s.tags }', 'tags: sel.tags, meta: { ...sel.meta, tags: sel.tags }')
    check('17b0', '对 3 反证副本就位：段级 tags 已改回「各段并集」（⛔ 原文件一字未动）',
      sB !== bB && sB.includes('tags: sel.tags, meta: { ...sel.meta, tags: sel.tags }')
      && readFileSync(join(here, 'lib', 'collect-scan.js'), 'utf8').includes('tags: s.tags, meta: { ...sel.meta, tags: s.tags }'), '')
    writeFileSync(pB, sB, 'utf8')
    // 对 4 的反证：applyScan 的**现取计划**丢掉段（只带 region.summary）⇒ 落库时静默缩回 1 份
    const pC = join(rv17.replan, 'lib', 'collect-scan.js')
    let sC = readFileSync(pC, 'utf8')
    const bC = sC
    sC = sC.replace('        ...(segments !== null ? { summaries: segments } : { summary: region.summary }),', '        summary: region.summary,')
    check('17c0', '对 4 反证副本就位：现取计划已丢段（⛔ 原文件一字未动）',
      sC !== bC && sC.includes('        summary: region.summary,')
      && readFileSync(join(here, 'lib', 'collect-scan.js'), 'utf8').includes('{ summaries: segments }'), '')
    writeFileSync(pC, sC, 'utf8')
    // 对 6 的反证：把「summary 与 summaries 只能给一个」的守卫挖掉 ⇒ 会**静默挑一个**
    const pD = join(rv17.guard, 'lib', 'collect.js')
    let sD = readFileSync(pD, 'utf8').replace(/\r\n/g, '\n') // ★ 2026-09-25：行尾归一 —— 针里带 \n，CRLF 段必失配（判据一字未动）
    const bD = sD
    sD = sD.replace('  if (isPlainObject(input.summary)) bad(SUMMARIES_BOTH_MSG)\n', '')
    check('17d0', '对 6 反证副本就位：两路并存的守卫已挖掉（⛔ 原文件一字未动）',
      sD !== bD && !sD.includes('bad(SUMMARIES_BOTH_MSG)')
      && readFileSync(join(here, 'lib', 'collect.js'), 'utf8').includes('bad(SUMMARIES_BOTH_MSG)'), '')
    writeFileSync(pD, sD, 'utf8')
  }
  try {
    const revJoin = await import(pathToFileURL(join(rv17.join, 'lib', 'collect-scan.js')).href)
    const revUnion = await import(pathToFileURL(join(rv17.union, 'lib', 'collect-scan.js')).href)
    const revReplan = await import(pathToFileURL(join(rv17.replan, 'lib', 'collect-scan.js')).href)
    const revGuard = await import(pathToFileURL(join(rv17.guard, 'lib', 'collect.js')).href)

    // ── 追 1 相：三段结构化 ⇒ index.json **追加 3 条**，文件 mt-<from>-<to>-1/2/3.md，各是那一段 ──
    const r3 = await runSl({ collectOnce }, 'three', SL_JSON3, dsh17)
    out('    · 17 改造后（3 段结构化，真链路）：' + JSON.stringify(slShape('three')))
    out('    · 17 三段散文合计 ' + SL_PROSE_TOTAL + ' 字；拼成一条时那一条 = ' + Array.from(SL1 + '\n' + SL2 + '\n' + SL3).length + ' 字（含两个换行）')
    check('17a', '① 相｜3 段 ⇒ index.json 追加 **3 条** entry、文件 mt-0000-0001-1/2/3.md、正文各是**那一段**（⛔ 无 JSON 外壳、⛔ 没挤在一条里）',
      slSliced('three') && r3.result.archived === 1, JSON.stringify(slShape('three')))
    check('17b', '① 相｜每份 `.md` 的字数 = 该段的字数（563/563/564）、三份不重不漏 = 1690 字',
      JSON.stringify(slBodies('three').map((t) => Array.from(t).length)) === JSON.stringify([563, 563, 564])
      && Array.from(slBodies('three').join('')).length === SL_PROSE_TOTAL,
      JSON.stringify(slBodies('three').map((t) => Array.from(t).length)))
    //   反证：同一套夹具喂「拼成一条」的副本 ⇒ 同一条判据 slSliced 必红
    const rJoin = await runSl(revJoin, 'revert-join', SL_JSON3, mkdtempSync(join(workRoot, 'dsh17-join-')))
    out('    · 17 改造前（副本 A：拼成一条）：' + JSON.stringify(slShape('revert-join')) + '；archived=' + rJoin.result.archived)
    check('17c', '① ★反证：落盘改回「拼成一条」⇒ 条目数 = 1（一条 1692 字）⇒ ① 的判据 slSliced 必红',
      (slIndex('revert-join').entries || []).length === 1 && slSliced('revert-join') === false
      && slBodies('revert-join')[0] === SL1 + '\n' + SL2 + '\n' + SL3,
      JSON.stringify(slShape('revert-join')))

    // ── 追 2 相：只有**一段** ⇒ 文件名**不带**后缀（mt-<from>-<to>.md），条目仍只有 1 条 ──
    const r1 = await runSl({ collectOnce }, 'one', SL_JSON1, dsh17)
    check('17d', '② 相｜只有一段 ⇒ 文件名**不带**后缀（mt-0000-0001.md）、条目 1 条、正文是那一段',
      r1.result.archived === 1 && (slIndex('one').entries || []).length === 1
      && slIndex('one').entries[0].file === 'mt-0000-0001.md' && slBodies('one')[0] === SL1,
      JSON.stringify(slShape('one')))

    // ── 追 3 相：tags 是**段级**的（⛔ 不是并集）──
    check('17e', '③ 相｜tags 段级：三条 entry 各是那一段自己的 [Serious] / [Romantic] / [Suspense]',
      slSegTags('three'), JSON.stringify((slIndex('three').entries || []).map((e) => e.tags)))
    //   反证：tags 改回**并集**的副本 ⇒ 第 2 段那条断言必红
    await runSl(revUnion, 'revert-union', SL_JSON3, mkdtempSync(join(workRoot, 'dsh17-union-')))
    out('    · 17 反证（副本 B：tags 并集）：' + JSON.stringify((slIndex('revert-union').entries || []).map((e) => e.tags)))
    check('17f', '③ ★反证：tags 改回「各段并集」⇒ 三条 entry 的 tags 全变成 [Serious, Romantic, Suspense] ⇒ ③ 的判据 slSegTags 必红',
      slSegTags('revert-union') === false
      && JSON.stringify((slIndex('revert-union').entries || []).map((e) => e.tags))
        === JSON.stringify([['Serious', 'Romantic', 'Suspense'], ['Serious', 'Romantic', 'Suspense'], ['Serious', 'Romantic', 'Suspense']]),
      JSON.stringify((slIndex('revert-union').entries || []).map((e) => e.tags)))

    // ── 追 4 相：楼层只写一遍（真 HTTP 的 PUT 流水 + 楼号不重复）＋ 现取计划也带全段 ──
    const puts3 = slPuts('three')
    const floorPuts = [...puts3.entries()].filter(([p]) => p.includes('/archive/floors/'))
    const summaryPuts = [...puts3.entries()].filter(([p]) => p.includes('/archive/summaries/') && p.endsWith('.md'))
    check('17g', '④ 相｜一次调用：楼层**每个路径只 PUT 一次**（2 楼 = 2 个 PUT，没有重复写同一楼）',
      floorPuts.length === 2 && floorPuts.every(([, n]) => n === 1) && slFloorFiles('three').length === 2
      && !r3.warnings.some((w) => w.includes('重复')),
      JSON.stringify({ floorPuts, files: slFloorFiles('three'), warnings: r3.warnings.filter((w) => w.includes('重复')) }))
    check('17h', '④ 相｜一次调用：摘要正文 **3 个路径各 PUT 一次**（N 份 = N 个文件，⛔ 不是写 N 遍同一份）',
      summaryPuts.length === 3 && summaryPuts.every(([, n]) => n === 1),
      JSON.stringify(summaryPuts))
    //   反证：现取计划丢段的副本 ⇒ apply 时静默缩回 1 份（最坏的一种 bug：计划看着对、落库少写）
    const rReplan = await runSl(revReplan, 'revert-replan', SL_JSON3, mkdtempSync(join(workRoot, 'dsh17-replan-')))
    out('    · 17 反证（副本 C：现取计划丢段）：' + JSON.stringify(slShape('revert-replan')) + '；archived=' + rReplan.result.archived)
    check('17i', '④ ★反证：现取计划丢段 ⇒ 落库静默缩回 1 份 ⇒ ① 的判据 slSliced 必红',
      (slIndex('revert-replan').entries || []).length === 1 && slSliced('revert-replan') === false,
      JSON.stringify(slShape('revert-replan')))

    // ── 追 5 相：fail-open 与机械兜底两路**照旧一条**（没有"段"可分，⛔ 不硬造分段）──
    const rPlain = await runSl({ collectOnce }, 'plain', SL_PLAIN, dsh17)
    check('17j', '⑤ 相｜fail-open（解析不出的原文）⇒ 条目数 = 1、正文是**整篇原文**（⛔ 不硬造分段）',
      rPlain.result.archived === 1 && (slIndex('plain').entries || []).length === 1
      && slIndex('plain').entries[0].file === 'mt-0000-0001.md' && slBodies('plain')[0] === SL_PLAIN,
      JSON.stringify(slShape('plain')))
    const rPrune = await runSl({ collectOnce }, 'prune', null, dsh17, true)
    check('17k', '⑤ 相｜机械兜底（compaction/prune 区间，官方那一段本来就没有模型摘要）⇒ 条目数 = 1',
      rPrune.result.archived === 1 && (slIndex('prune').entries || []).length === 1
      && slIndex('prune').entries[0].file === 'mt-0000-0001.md'
      && rPrune.warnings.some((w) => w.includes('no-model-summary')),
      JSON.stringify({ shape: slShape('prune'), warnings: rPrune.warnings.filter((w) => w.includes('no-model-summary')) }))

    // ── 追 6 反证：同时传 summary 与 summaries ⇒ COLLECT_INVALID（⛔ 不许静默挑一个）──
    const a1 = await import('./lib/collect.js')
    const bothBody = {
      target: { characterId: 'char-slices-a1', playthroughId: 'pt-slices-a1' },
      range: { fromFloor: 0, toFloor: 1 },
      floors: [{ floor: 0, isUser: true, isSystem: false, mes: '占位楼正文', name: '（来自会话）' }, { floor: 1, isUser: false, isSystem: false, mes: '占位楼正文二', name: '（来自会话）' }],
      summary: { text: '单份摘要占位' },
      summaries: [{ id: 'mt-0000-0001-1', text: '段一份摘要占位' }, { id: 'mt-0000-0001-2', text: '段二份摘要占位' }],
    }
    const observed17 = { targetKnown: true, existingFloors: new Set(), floorShas: new Map(), summaryShas: new Map(), index: { exists: false }, manifest: { exists: false } }
    let bothErr = null
    try {
      a1.planCollect(bothBody, { observed: observed17 })
    } catch (e) {
      bothErr = e
    }
    let bothValidErr = null
    try {
      a1.validatePlanInput(bothBody)
    } catch (e) {
      bothValidErr = e
    }
    let guardPlan = null
    try {
      guardPlan = revGuard.planCollect(bothBody, { observed: observed17 })
    } catch (e) {
      guardPlan = { threw: e.code }
    }
    out('    · 17 反证（副本 D：守卫挖掉）⇒ ' + JSON.stringify(guardPlan && (guardPlan.willWrite ? { willWrite: guardPlan.willWrite.length, summaries: (guardPlan.summaries || []).length } : guardPlan)))
    check('17l', '⑥ 反证｜同时传 summary 与 summaries ⇒ COLLECT_INVALID（planCollect 与 validatePlanInput 两处都拒，⛔ 不猜）',
      !!bothErr && bothErr.code === 'COLLECT_INVALID' && !!bothValidErr && bothValidErr.code === 'COLLECT_INVALID',
      JSON.stringify({ plan: bothErr && bothErr.code, validate: bothValidErr && bothValidErr.code }))
    check('17m', '⑥ ★反证：挖掉守卫 ⇒ 不再报错、**静默挑一个**（summaries 赢了，summary 被丢）⇒ ⑥ 的断言必红',
      !!guardPlan && !guardPlan.threw && Array.isArray(guardPlan.summaries),
      JSON.stringify(guardPlan && (guardPlan.willWrite ? { willWrite: guardPlan.willWrite.length } : guardPlan)))

    // ── 本轮反证全程没碰本仓的 lib（四条锚点都还在原文件里）──
    const nowSrc17 = readFileSync(join(here, 'lib', 'collect-scan.js'), 'utf8')
    const nowA1Src17 = readFileSync(join(here, 'lib', 'collect.js'), 'utf8')
    check('17v', '★ 本轮反证全程没有碰过本仓的 lib（四条锚点都还在原文件里）',
      nowSrc17.includes('{ summaries: entry.summaries }') && nowSrc17.includes('{ summaries: segments }')
      && nowSrc17.includes('tags: s.tags, meta: { ...sel.meta, tags: s.tags }')
      && nowA1Src17.includes('bad(SUMMARIES_BOTH_MSG)'), '')
  } finally {
    await fake17.stop()
  }
  for (const d of Object.values(rv17)) rmSync(d, { recursive: true, force: true })
  check('17w', '反证副本已删（⛔ 不给仓库留垃圾）', !Object.values(rv17).some((d) => existsSync(d)), '')

  // ═══ 18. 逐段的字节上限（区间级的旧判据**退役**，⛔ 不许两套判据并存）═══════════════════════
  //   §2.2：每段各自判 MODEL_SUMMARY_MAX_BYTES（1 MiB）；某一段超限 ⇒ **那一段**如实回落机械条目 +
  //   播报 model-summary-too-big（其余段照常落散文与段级 tags）。⛔ 不再"整条拼起来超限就整条回落"
  //   —— 那正是把 N 段挤成一条的老口径。判据只算一次（selectModelSummary），planScan 只照结果落盘。
  const BIG_SEG = 'X'.repeat(1024 * 1024 + 8) // 比单文件上限（1 MiB）多几个字节
  const SMALL_SEG = '第2天 深夜: 小段占位散文（假）'
  const SL_BIG_JSON = JSON.stringify([
    { summary: BIG_SEG, tags: { vibe: 'Serious', special: [], important: false } },
    { summary: SMALL_SEG, tags: { vibe: 'Romantic', special: [], important: false } },
  ])
  const bigEvents = [USER(0, FIX[0], 'user'), ASST(1, [TEXT(FIX[1])]), SUMMARY_EV(9, [0, 1], SL_BIG_JSON)]
  const bigRegion = findShadowRegionsFromEvents(bigEvents)[0]
  {
    const selBig = selectModelSummary(bigRegion, {})
    check('18a', '相｜逐段判：第 1 段超 1 MiB、第 2 段没超 ⇒ 区间**不整体回落**（kind 仍 model-summary，两段各自带 tooBig）',
      selBig.kind === 'model-summary' && Array.isArray(selBig.segments) && selBig.segments.length === 2
      && selBig.segments[0].tooBig === true && selBig.segments[1].tooBig === false,
      JSON.stringify(selBig.kind === 'model-summary' ? selBig.segments.map((s) => s.tooBig) : selBig))
    const pBig = await planScan(inputD1, depsD1(bigEvents))
    const rBig = regionOf(pBig)
    const mechBig = buildRegionSummary(bigRegion).text
    check('18b', '相｜那一段的正文换成**机械条目正文**（tags/meta 留空 = 老机械条目的形状），其余段照常落散文 + 段级 tags',
      rBig && Array.isArray(rBig.summaries) && rBig.summaries.length === 2
      && rBig.summaries[0].text === mechBig && rBig.summaries[0].meta === null && JSON.stringify(rBig.summaries[0].tags) === '[]'
      && rBig.summaries[1].text === SMALL_SEG && JSON.stringify(rBig.summaries[1].meta.tags) === JSON.stringify(['Romantic']),
      JSON.stringify(rBig && rBig.summaries && rBig.summaries.map((s) => [Array.from(s.text).length, s.meta === null ? null : s.meta.tags])))
    check('18c', '相｜如实播报 model-summary-too-big（点名是**第 1 段**，⛔ 不静默、⛔ 不整条丢）',
      pBig.warnings.some((w) => w.includes('model-summary-too-big') && w.includes('第 1 段')),
      JSON.stringify(pBig.warnings.filter((w) => w.includes('too-big'))))
    // 反证：把逐段判据换回**区间级那一条**（本单开工前的写法）⇒ 整条回落 mechanical ⇒ 18a/18b 必红
    const rvBig = mkdtempSync(join(tmpdir(), 'dma-scan-slice-toobig-'))
    cpSync(join(here, 'lib'), join(rvBig, 'lib'), { recursive: true })
    writeFileSync(join(rvBig, 'package.json'), JSON.stringify({ type: 'module' }) + '\n', 'utf8')
    const pBigRev = join(rvBig, 'lib', 'collect-scan.js')
    let sBigRev = readFileSync(pBigRev, 'utf8')
    const bBigRev = sBigRev
    sBigRev = sBigRev.replace(
      "  if (segments.length > 0 && segments.every((s) => s.tooBig)) return { kind: 'mechanical', reason: 'model-summary-too-big' }",
      "  if (Buffer.byteLength(beauty.text, 'utf8') > MODEL_SUMMARY_MAX_BYTES) return { kind: 'mechanical', reason: 'model-summary-too-big' }",
    )
    check('18d', '反证副本就位：逐段判据已换回**区间级**那一条（⛔ 原文件一字未动）',
      sBigRev !== bBigRev && sBigRev.includes("if (Buffer.byteLength(beauty.text, 'utf8') > MODEL_SUMMARY_MAX_BYTES)")
      && readFileSync(join(here, 'lib', 'collect-scan.js'), 'utf8').includes('segments.every((s) => s.tooBig)'), '')
    writeFileSync(pBigRev, sBigRev, 'utf8')
    const revBig = await import(pathToFileURL(pBigRev).href)
    const selBigRev = revBig.selectModelSummary(bigRegion, {})
    const pBigRevPlan = await revBig.planScan(inputD1, depsD1(bigEvents))
    const rBigRev = regionOf(pBigRevPlan)
    out('    · 18 改造前（副本：区间级判据）⇒ selectModelSummary.kind=' + selBigRev.kind
      + '（' + selBigRev.reason + '）；区间摘要 kind=' + rBigRev.summaryKind + '/' + rBigRev.summaryFallback
      + '；segments=' + (Array.isArray(rBigRev.summaries) ? rBigRev.summaries.length : '无'))
    check('18e', '★ 反证：区间级判据下**整条**回落 mechanical/model-summary-too-big、没有段可分 ⇒ 18a/18b 必红',
      selBigRev.kind === 'mechanical' && selBigRev.reason === 'model-summary-too-big'
      && rBigRev.summaryKind === 'mechanical' && rBigRev.summaryFallback === 'model-summary-too-big'
      && !Array.isArray(rBigRev.summaries),
      JSON.stringify({ kind: selBigRev.kind, reason: selBigRev.reason, plan: [rBigRev.summaryKind, rBigRev.summaryFallback], segs: Array.isArray(rBigRev.summaries) }))
    rmSync(rvBig, { recursive: true, force: true })
    check('18f', '反证副本已删（⛔ 不给仓库留垃圾）', !existsSync(rvBig), '')
  }

} finally {
  // 8d 的判定必须在全部输出之后做：自检自己的输出也不能带 fixture 前 12 字
  check('8d', 'fixture 前 12 字不在自检输出里', !outBuf.join('\n').includes(FIX12))
  out(`── ${pass} 通过 / ${fail} 失败 ──`)
  rmSync(workRoot, { recursive: true, force: true })
}process.exitCode = fail === 0 ? 0 : 1
