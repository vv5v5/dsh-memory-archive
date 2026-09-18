/**
 * summarize 残余面自检（2026-09-18 撤侧路之后）。
 *
 * 侧路（「扫归档原文 → 总结」两步端点 + 自发 HTTP 调模型）已整体拆除，本台只测留下来的三块：
 *   ① 解析纯函数（extractJson / normalizeSummaryItem / parseSummaryOutput / buildSummaryMessages）；
 *   ② 回声拒收 looksLikePromptEcho（消费方在压缩链：collect-scan，那里的联动在 _selftest-collect-scan.mjs）；
 *   ③ 清空总结 resetSummaries（运维口：只清摘要、不调模型；备份 → 清空 → index 只留 import-*）；
 *   ④ ★反证（验收 4）：源码里侧路符号零残留，/summarize/reset 仍在。
 *
 * 假 tavern（内存文件系统），零网络、零模型调用。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { resetSummaries, buildSummaryMessages, parseSummaryOutput, extractJson, looksLikePromptEcho } from './lib/summarize.js'
import { buildRpCompactionBackend } from './lib/mt-compaction.js'

let pass = 0
let fail = 0
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${extra ? '  ' + extra : ''}`)
  if (ok) pass += 1
  else fail += 1
}

const TARGET = { characterId: 'c1', playthroughId: 'p1' }
const ARCHIVE = 'c1/p1/archive'

function makeTavern({ floors = 45, index = null, manifest = null, brokenIndex = false } = {}) {
  const files = new Map()
  const dirs = new Set()
  for (let n = 0; n < floors; n++) {
    files.set(`${ARCHIVE}/floors/${String(n).padStart(4, '0')}.json`, JSON.stringify({
      _floor: n, is_user: n % 2 === 1, is_system: false,
      name: n % 2 === 1 ? '甲' : '乙',
      mes: `第${n}楼正文：她在暗格里摸到一枚鳞片。`,
    }))
  }
  if (brokenIndex) files.set(`${ARCHIVE}/summaries/index.json`, '{这不是 JSON')
  else if (index) files.set(`${ARCHIVE}/summaries/index.json`, JSON.stringify(index, null, 2))
  if (manifest) files.set(`${ARCHIVE}/manifest.json`, JSON.stringify(manifest, null, 2))
  const notFound = () => { const e = new Error('not found'); e.code = 'TAVERN_HTTP_404'; return e }
  return {
    files, dirs,
    async list(rel) {
      const names = [...files.keys()].filter((k) => k.startsWith(rel + '/')).map((k) => k.slice(rel.length + 1)).filter((n) => !n.includes('/'))
      if (names.length === 0 && ![...files.keys()].some((k) => k.startsWith(rel + '/'))) throw notFound()
      return { list: names }
    },
    async read(rel) { if (!files.has(rel)) throw notFound(); return { content: files.get(rel) } },
    async write(rel, content) { files.set(rel, content) },
    async mkdir(rel) { dirs.add(rel) },
  }
}

const INDEX_BASE = { schemaVersion: 1, kind: 'dsh-tavern-l2-summaries', updatedAt: '2026-09-16T00:00:00.000Z', entries: [] }
const importEntry = { id: 'import-abc12345', file: 'import-abc12345.md', fromFloor: 0, toFloor: 253, createdAt: '2026-09-16T00:00:00.000Z', chars: 194 }

// ─────────────────────────── ① 解析兜底（纯函数，照 anima 的口径）

{
  check('① 代码栏 JSON 能抓出来', JSON.stringify(extractJson('```json\n[{"summary":"甲"}]\n```')) === '[{"summary":"甲"}]')
  check('① 没有代码栏也能靠括号配平抓出来', JSON.stringify(extractJson('前言 [{"summary":"乙"}] 后语')) === '[{"summary":"乙"}]')
  const p1 = parseSummaryOutput('```json\n[{"summary":"丙","tags":{"important":true}}]\n```')
  check('① 解析：summary + tags 都拿到', p1.ok === true && p1.items[0].text === '丙' && p1.items[0].tags.join() === 'Important' && p1.usedJson === true)
  const p1b = parseSummaryOutput('[{"summary":"甲","tags":{"vibe":"Angst"}},{"summary":"乙","tags":{"important":true}}]')
  check('① 多条：全都收下（anima 是一批多条切片）', p1b.items.length === 2 && p1b.items[1].text === '乙' && p1b.items[1].tags.join() === 'Important', JSON.stringify(p1b.items.map((x) => x.text)))
  const p2 = parseSummaryOutput('模型直接写了一段中文摘要，没有 JSON。')
  check('① 纯文本兜底：当成一条收下、tags 空', p2.ok === true && p2.items.length === 1 && p2.items[0].text.startsWith('模型直接') && p2.items[0].tags.length === 0 && p2.usedJson === false)
  const p3 = parseSummaryOutput('   ')
  check('① 空输出 ⇒ ok=false（不给空摘要）', p3.ok === false)
}

// ─────────────────────────── ② 摘要回声拒收（2026-09-18；压缩链在 collect-scan 侧联动）

{
  // ★ 真机那条回声的**原话**（向量库 `sum_s-0000-0019.md` 的正文）：它是**指令自身的碎片**。
  const REAL_ECHO = 'Do NOT use time/location change if the narrative is contiguous.\nPrevent Emotion Bias (e.g., Romantic vs. Sexual). Use narrative EVIDENCE, not feelings.'
  // 机制检查用**自造**的多行指令（⛔ 仓库源码里不写任何真实提示词原文）
  const INSTR = [
    'Summarize the following roleplay transcript segment by segment.',
    'Do not split a segment when the narrative is contiguous.',
    'Prefer narrative evidence over emotional judgements.',
    'Return raw JSON array only, keys in English, prose in Chinese.',
  ].join('\n')

  const window3 = INSTR.split('\n').slice(0, 3).join('\n')
  check('② 机制锚：把指令自己的连续 3 行当输出 ⇒ 必须判成回声', looksLikePromptEcho(window3, INSTR) === true, JSON.stringify(window3.slice(0, 50)))

  // ★ 真锚：真实的归档指令就活在**生成器产出**那段源码文本里（见 lib/mt-compaction.js 文件头）
  //   ⇒ 从里面取一段连续窗口当"回声"，必须判出来。不写死任何提示词原文。
  try {
    const src = buildRpCompactionBackend()
    const srcLines = String(src).split('\n').map((l) => l.trim()).filter((l) => l.length >= 20)
    if (srcLines.length >= 6) {
      const win = srcLines.slice(10, 13).join('\n')
      check('② ★真锚：从**生成器产出**（真指令文本所在处）截的连续 3 行 ⇒ 必须判成回声',
        looksLikePromptEcho(win, String(src)) === true, JSON.stringify(win.slice(0, 50)))
    } else {
      console.log('[SKIP] ② 真锚：生成器产出里挑不出够长的行窗口 —— ⛔ 不算通过，只是测不了')
    }
  } catch (e) {
    console.log('[SKIP] ② 真锚：生成器不可用（' + String(e?.message ?? e).slice(0, 60) + '）—— ⛔ 不算通过，只是测不了')
  }

  const pEcho = parseSummaryOutput(window3, { instruction: INSTR })
  check('② ★反证：纯文本回声 ⇒ ok=false、items 空、echo=true（⛔ 一个字节都不许落盘）',
    pEcho.ok === false && pEcho.items.length === 0 && pEcho.echo === true, JSON.stringify(pEcho))

  // 回声被包成**合法** JSON（模型偶尔这么干）⇒ 走 items 那条路，同样必须拒
  const pEchoJson = parseSummaryOutput(JSON.stringify([{ summary: window3, tags: { vibe: 'Serious' } }]), { instruction: INSTR })
  check('② ★反证：回声包成合法 JSON 也要拒（不能只防纯文本那条路）',
    pEchoJson.ok === false && pEchoJson.items.length === 0, JSON.stringify(pEchoJson))

  // 回声包成**坏** JSON（抽不出 items ⇒ 走纯文本兜底那条路）⇒ 也不能漏
  const brokenJson = '```json\n[{' + window3 + ']}'
  const pEchoBroken = parseSummaryOutput(brokenJson, { instruction: INSTR })
  check('② ★反证：坏 JSON 里的回声同样拒（纯文本兜底那条路也上了闸）',
    pEchoBroken.ok === false && pEchoBroken.items.length === 0 && pEchoBroken.echo === true, JSON.stringify(pEchoBroken).slice(0, 120))

  const GOOD = '1966年9月1日 上午：顾筱潋在一个陌生的旅馆房间醒来，失去记忆；她用犬齿刺破下唇，用血充当口红。\n之后她把公民证与旧围巾装进皮箱，门外的脚步声打断了她的行动。'
  const pGood = parseSummaryOutput(GOOD, { instruction: INSTR })
  check('② ★反证：正常中文摘要不受影响（别把真摘要误杀）',
    pGood.ok === true && pGood.items.length === 1 && pGood.items[0].text.startsWith('1966年'), JSON.stringify(pGood).slice(0, 120))
  const pGoodJson = parseSummaryOutput('[{"summary":"' + GOOD.split('\n')[0] + '","tags":{"vibe":"Suspense"}}]', { instruction: INSTR })
  check('② ★反证：正常 JSON 摘要不受影响', pGoodJson.ok === true && pGoodJson.items[0].tags.join() === 'Suspense')

  const pNoInstr = parseSummaryOutput(REAL_ECHO)
  check('② 兼容：不给 instruction ⇒ 回声闸门不生效（拿不到指令就只按结构判，不瞎猜）', pNoInstr.ok === true && pNoInstr.items.length === 1)
  check('② 畸形输入不抛', looksLikePromptEcho(null, INSTR) === false && looksLikePromptEcho(REAL_ECHO, null) === false)
}

// ─────────────────────────── 消息构造的最小形状

{
  const m = buildSummaryMessages({ floors: [{ floor: 0, name: 'A', mes: '甲', isUser: false }], instruction: 'I' })
  check('无破限/无前文 ⇒ [system(指令), user(正文)]', m.length === 2 && m[0].role === 'system' && m[1].role === 'user' && m[0].content === 'I', JSON.stringify(m.map((x) => x.role)))
  const m2 = buildSummaryMessages({ floors: [{ floor: 0, name: 'A', mes: '甲' }], instruction: 'I', jailbreak: 'J', previousSummary: 'P' })
  check('有破限+有前文 ⇒ system 里破限+指令、user 里前文+正文', m2.length === 2 && m2[0].content.includes('J') && m2[0].content.includes('I')
    && m2[1].content.includes('<previous_summary>') && m2[1].content.includes('<text_to_summarize>'), JSON.stringify(m2.map((x) => x.role)))
}

// ─────────────────────────── ③ 清空总结（运维口：只清摘要、不调模型）

{
  const tavern = makeTavern({
    floors: 20,
    index: {
      ...INDEX_BASE,
      entries: [
        importEntry,
        { id: 's-0000-0019-1', file: 's-0000-0019-1.md', fromFloor: 0, toFloor: 19, chars: 10, tags: ['Angst'] },
        { id: 's-0020-0039-1', file: 's-0020-0039-1.md', fromFloor: 20, toFloor: 39, chars: 10, tags: [] },
      ],
    },
    manifest: { schemaVersion: 1, summaries: { count: 2, writer: 'x' } },
  })
  tavern.files.set(`${ARCHIVE}/summaries/s-0000-0019-1.md`, '第一条旧摘要正文')
  tavern.files.set(`${ARCHIVE}/summaries/s-0020-0039-1.md`, '第二条旧摘要正文')

  // ① dryRun 零写入
  const dry = await resetSummaries({ target: TARGET, dryRun: true }, { tavern })
  check('③ dryRun：报出要清几条、零写入', dry.ok === true && dry.dryRun === true && dry.content === 2
    && tavern.files.get(`${ARCHIVE}/summaries/s-0000-0019-1.md`) === '第一条旧摘要正文', JSON.stringify({ content: dry.content }))

  // ② 真清：备份在、正文被清空、index 只留 import-*、manifest count 跟着改
  const out = await resetSummaries({ target: TARGET }, { tavern })
  check('③ 清空：报告 cleared=2 / backupFiles=2', out.ok === true && out.cleared === 2 && out.backupFiles === 2,
    JSON.stringify({ cleared: out.cleared, backup: out.backupFiles }))
  check('③ 备份正文在（可恢复）', tavern.files.get(`${out.backupRel}/s-0000-0019-1.md`) === '第一条旧摘要正文'
    && tavern.files.get(`${out.backupRel}/s-0020-0039-1.md`) === '第二条旧摘要正文', out.backupRel)
  check('③ 原文件被清空（tavern 无删除接口 ⇒ 清空是最干净处置）',
    tavern.files.get(`${ARCHIVE}/summaries/s-0000-0019-1.md`) === '' && tavern.files.get(`${ARCHIVE}/summaries/s-0020-0039-1.md`) === '')
  const idx = JSON.parse(tavern.files.get(`${ARCHIVE}/summaries/index.json`))
  check('③ index 只留 import-*', idx.entries.length === 1 && idx.entries[0].id === importEntry.id, JSON.stringify(idx.entries.map((e) => e.id)))
  check('③ manifest 的 summaries.count 跟着改成保留数',
    JSON.parse(tavern.files.get(`${ARCHIVE}/manifest.json`)).summaries.count === 1)
  check('③ 原文楼层一个都没动', tavern.files.has(`${ARCHIVE}/floors/0000.json`))

  // ③ 清完再清 ⇒ 如实说"没有内容摘要可清"
  const again = await resetSummaries({ target: TARGET }, { tavern })
  check('③ 再清一次：reason 说明没有可清的（不假装干了活）', again.ok === true && /没有内容摘要可清/.test(String(again.reason)), String(again.reason))
}

{
  // ④ 备份失败 ⇒ **不清那一条**（宁可不干净，也不丢内容）
  const tavern = makeTavern({
    floors: 5,
    index: { ...INDEX_BASE, entries: [importEntry, { id: 's-0000-0004-1', file: 's-0000-0004-1.md', fromFloor: 0, toFloor: 4, chars: 5 }] },
  })
  tavern.files.set(`${ARCHIVE}/summaries/s-0000-0004-1.md`, '要被保护的正文')
  tavern.write = async (rel, content) => {
    if (rel.includes('_backup-summaries-')) throw new Error('备份写盘失败（模拟）')
    tavern.files.set(rel, content)
  }
  const out = await resetSummaries({ target: TARGET }, { tavern })
  check('③★ 备份失败 ⇒ 那条不清（正文还在）、失败计数与原因都在',
    out.ok === false && out.failed === 1 && tavern.files.get(`${ARCHIVE}/summaries/s-0000-0004-1.md`) === '要被保护的正文',
    JSON.stringify({ ok: out.ok, failed: out.failed, results: out.results }))
}

// ─────────────────────────── ④ ★反证（验收 4）：侧路零残留、reset 仍在

{
  const here = dirname(fileURLToPath(import.meta.url))
  const libDir = join(here, 'lib')
  const sources = readdirSync(libDir).filter((n) => n.endsWith('.js')).map((n) => ({
    name: n,
    text: readFileSync(join(libDir, n), 'utf8'),
  }))
  const banned = ['callSummaryModel', 'DEFAULT_SUMMARY_API_URL', "'/summarize/plan'", "'/summarize/apply'"]
  for (const needle of banned) {
    const hits = sources.filter((s) => s.text.includes(needle)).map((s) => s.name)
    check(`④ ★反证：lib/ 源码里不再出现 ${needle}`, hits.length === 0, hits.join('、'))
  }
  const idxSrc = sources.find((s) => s.name === 'index.js')
  check('④ /summarize/reset 端点仍在（运维口不该被顺手删掉）',
    !!idxSrc && idxSrc.text.includes("'/summarize/reset': ['POST']"), '')
  check('④ summarize.js 不再 import 任何模型调用（模块内无 fetch 调用）',
    !!sources.find((s) => s.name === 'summarize.js') && !sources.find((s) => s.name === 'summarize.js').text.includes('fetch('), '')
  // 面板侧：两步入口的 URL 也不许再有（client.js 也在 lib/ 下，已被上面覆盖；这里把话挑明）
  const cliSrc = sources.find((s) => s.name === 'client.js')
  check('④ 面板不再请求 plan/apply 两条侧路（只剩 reset 与 retrieval/test）',
    !!cliSrc && cliSrc.text.includes("HOST_API_BASE + '/summarize/reset'")
    && !cliSrc.text.includes("'/summarize/plan'")
    && !cliSrc.text.includes("'/summarize/apply'"), '')
  // 压缩链消费回声判据的接线在位（T5 的静态锚）
  const scanSrc = sources.find((s) => s.name === 'collect-scan.js')
  check('④ 回声判据的消费方已接到压缩链（collect-scan import + prompt-echo 播报）',
    !!scanSrc && scanSrc.text.includes("from './summarize.js'") && scanSrc.text.includes('prompt-echo'), '')
  assert.ok(true)
}

console.log(fail === 0 ? `\n★ summarize 残余面：全过（${pass} 条）` : `\n✖ ${fail} 条没过（通过 ${pass}）`)
process.exit(fail === 0 ? 0 : 3)
