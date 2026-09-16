/**
 * 「扫归档原文 → 总结」自检（2026-09-16）。
 *
 * 假 tavern（内存文件系统）+ 假 LLM（可控返回），覆盖：
 *   ① 切区间（rangeSize）与「已覆盖就跳过」；② 消息形状（正文包在 `<text_to_summarize>`、
 *   指令作最后一条 system、说话人前缀）；③ 解析兜底（代码栏 JSON / 无栏 / 纯文本退化）；
 *   ④ tags 映射（`important:true ⇒ Important`）；⑤ 落库形状（**正文不带元信息头**、index 追加、
 *   manifest 增量）；⑥ 上一区间摘要以 `<previous_summary>` 串进来；⑦ 单区间失败不拖垮整批；
 *   ⑧ index 坏了 fail-closed（一个字节都不写）。
 */
import { planSummarize, applySummarize, resetSummaries, buildSummaryMessages, parseSummaryOutput, extractJson } from './lib/summarize.js'

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

const fenced = (obj) => '```json\n' + JSON.stringify(obj) + '\n```'
const llm = (calls, respond) => async (url, opts) => {
  const body = JSON.parse(opts.body)
  calls.push({ url, body })
  const r = respond(calls.length, body)
  if (r && r.__http) return { ok: false, status: r.__http, json: async () => ({ error: { message: r.message || 'boom' } }) }
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: r } }] }) }
}

const INDEX_BASE = { schemaVersion: 1, kind: 'dsh-tavern-l2-summaries', updatedAt: '2026-09-16T00:00:00.000Z', entries: [] }
const importEntry = { id: 'import-abc12345', file: 'import-abc12345.md', fromFloor: 0, toFloor: 253, createdAt: '2026-09-16T00:00:00.000Z', chars: 194 }

// ─────────────────────────── ① 计划

{
  const tavern = makeTavern({ floors: 45 })
  const plan = await planSummarize({ target: TARGET }, { tavern })
  check('① plan 切出 3 个区间（0-19 / 20-39 / 40-44）',
    plan.ranges.length === 3 && plan.ranges[0].fromFloor === 0 && plan.ranges[0].toFloor === 19
    && plan.ranges[1].fromFloor === 20 && plan.ranges[2].toFloor === 44,
    JSON.stringify(plan.ranges))
  check('① 45 楼 ⇒ toSummarize 3 个（都还没总结过）', plan.toSummarize.length === 3, JSON.stringify(plan.toSummarize))
}

{
  // ★ 回归（2026-09-16 真机踩过）：Tavern 的 list 每项是 **`{path, type}`**，不是 `{name, type}`。
  //   只认 `name` 会在真机上数出 0 楼（嘴上说"归档里没有楼层"，而磁盘上明明有 254 个）。
  const t2 = makeTavern({ floors: 25 })
  t2.list = async (rel) => ({
    list: [...t2.files.keys()].filter((k) => k.startsWith(rel + '/')).map((k) => ({ path: k, type: 'file' })),
  })
  const plan2 = await planSummarize({ target: TARGET }, { tavern: t2 })
  check('①★ 回归：list 返回 {path,type} 也能数出楼层（真机就是这个形状）',
    plan2.floorCount === 25 && plan2.ranges.length === 2,
    JSON.stringify({ floors: plan2.floorCount, ranges: plan2.ranges.length }))
}

{
  // 已有一条**内容摘要**覆盖 0-19（外加一条 import 批次清单——它**不算**覆盖）
  const tavern = makeTavern({
    floors: 45,
    index: { ...INDEX_BASE, entries: [importEntry, { id: 's-0000-0019', file: 's-0000-0019.md', fromFloor: 0, toFloor: 19, chars: 500 }] },
  })
  const plan = await planSummarize({ target: TARGET }, { tavern })
  check('① import 批次清单**不算**内容摘要；0-19 那条才算 ⇒ 只剩 2 个区间',
    plan.toSummarize.length === 2 && plan.ranges[0].covered === true && plan.ranges[1].covered === false,
    JSON.stringify(plan.ranges.map((r) => [r.fromFloor, r.toFloor, r.covered])))
}

// ─────────────────────────── ②③④⑤⑥ 执行

{
  const tavern = makeTavern({ floors: 45, manifest: { schemaVersion: 1, summaries: { count: 0 } } })
  const calls = []
  const out = await applySummarize({
    target: TARGET,
    ranges: [{ fromFloor: 0, toFloor: 19 }, { fromFloor: 20, toFloor: 39 }],
    instruction: '【指令】Language: Summary in Chinese',
    jailbreak: '【破限头】',
    api: { url: 'https://x/v1', model: 'm1', key: 'k' },
  }, { tavern, fetchImpl: llm(calls, (i) => fenced([{ summary: `第${i}段摘要`, tags: { vibe: 'Angst', special: null, important: i === 2 } }])) })

  check('② LLM 被调 2 次', calls.length === 2, String(calls.length))
  const m1 = calls[0].body.messages
  // ★ 2026-09-16 真机修正后的形状：**指令在前（system）、正文作最后一条 user**。
  //   照 anima 那个"指令作最后一条 system"的段序，真机上模型会**续写指令本身**而不是做总结。
  check('② 消息 = [system(破限+指令), user(正文)]',
    m1.length === 2 && m1[0].role === 'system' && m1[0].content.includes('【破限头】')
    && m1[0].content.includes('Language: Summary in Chinese')
    && m1[1].role === 'user',
    JSON.stringify(m1.map((m) => m.role)))
  check('② 正文包在 <text_to_summarize> 里且带说话人前缀',
    m1[1].content.startsWith('<text_to_summarize>') && m1[1].content.includes('乙: ') && m1[1].content.includes('甲: ')
    && m1[1].content.trimEnd().endsWith('</text_to_summarize>'), m1[1].content.slice(0, 60))
  check('⑥ 第二次调用把 <previous_summary> 放在**正文外面**（user 消息里、<text_to_summarize> 之前）',
    calls[1].body.messages[1].content.includes('<previous_summary>')
    && calls[1].body.messages[1].content.includes('第1段摘要')
    && calls[1].body.messages[1].content.indexOf('<previous_summary>') < calls[1].body.messages[1].content.indexOf('<text_to_summarize>'),
    calls[1].body.messages[1].content.slice(0, 90))
  check('⑤ 写了两个 md + 追加两条 index', tavern.files.has(`${ARCHIVE}/summaries/s-0000-0019.md`) && tavern.files.has(`${ARCHIVE}/summaries/s-0020-0039.md`))
  const md = tavern.files.get(`${ARCHIVE}/summaries/s-0000-0019.md`)
  check('⑤ 摘要正文**不带元信息头**（避免污染 embedding 切片）', md === '第1段摘要', JSON.stringify(md))
  const idx = JSON.parse(tavern.files.get(`${ARCHIVE}/summaries/index.json`))
  check('⑤ index 追加了 2 条、保留 schemaVersion/kind', idx.entries.length === 2 && idx.schemaVersion === 1 && idx.kind === 'dsh-tavern-l2-summaries')
  check('④ tags 映射：important:true ⇒ Important，vibe 直接收', JSON.stringify(idx.entries[1].tags) === JSON.stringify(['Angst', 'Important']), JSON.stringify(idx.entries[1].tags))
  check('⑤ manifest 增量：summaries.count 0 → 2、writer 记上',
    JSON.parse(tavern.files.get(`${ARCHIVE}/manifest.json`)).summaries.count === 2
    && JSON.parse(tavern.files.get(`${ARCHIVE}/manifest.json`)).summaries.writer === 'dsh-memory-archive/summarize')
  check('执行结果：written=2 failed=0 ok=true', out.written === 2 && out.failed === 0 && out.ok === true, JSON.stringify({ w: out.written, f: out.failed }))

  // ⑨ 再跑一次同一计划 ⇒ 全部 skip、不再调模型
  const calls2 = []
  const out2 = await applySummarize({
    target: TARGET, ranges: [{ fromFloor: 0, toFloor: 19 }],
    instruction: 'x', api: { url: 'https://x/v1', model: 'm1', key: 'k' },
  }, { tavern, fetchImpl: llm(calls2, () => fenced([{ summary: '不该发生' }])) })
  check('⑨ 已覆盖的区间：skip、不调模型、不重复写', calls2.length === 0 && out2.written === 0 && out2.results[0].skipped === 'covered',
    JSON.stringify({ calls: calls2.length, r: out2.results[0] }))
}

// ─────────────────────────── ⑩ 覆盖语义（清掉上一版碎片）

{
  const tavern = makeTavern({
    floors: 20,
    index: { ...INDEX_BASE, entries: [importEntry, { id: 's-0000-0019', file: 's-0000-0019.md', fromFloor: 0, toFloor: 19, chars: 100 }] },
  })
  tavern.files.set(`${ARCHIVE}/summaries/s-0000-0019.md`, '上一版的垃圾正文（应被清掉）')
  const calls = []
  const out = await applySummarize({
    target: TARGET, ranges: [{ fromFloor: 0, toFloor: 19 }], instruction: 'x',
    api: { url: 'https://x/v1', model: 'm1', key: 'k' }, overwrite: true,
  }, { tavern, fetchImpl: llm(calls, () => fenced([{ summary: '新的一段', tags: { vibe: 'Angst' } }, { summary: '新的二段', tags: { important: true } }])) })
  const idx = JSON.parse(tavern.files.get(`${ARCHIVE}/summaries/index.json`))
  check('⑩ 覆盖：旧条目从 index 里摘掉、旧文件被清空（tavern 没有删除接口）',
    !idx.entries.some((e) => e.id === 's-0000-0019') && tavern.files.get(`${ARCHIVE}/summaries/s-0000-0019.md`) === '',
    JSON.stringify(idx.entries.map((e) => e.id)))
  check('⑩ 覆盖：一次两条 ⇒ 各存一条切片（s-0000-0019-1 / -2），tags 各自带走',
    idx.entries.some((e) => e.id === 's-0000-0019-1' && e.tags.join() === 'Angst')
    && idx.entries.some((e) => e.id === 's-0000-0019-2' && e.tags.join() === 'Important'),
    JSON.stringify(idx.entries.map((e) => [e.id, e.tags])))
  check('⑩ 覆盖结果里 removed=1、items=2', out.results[0].removed === 1 && out.results[0].items === 2,
    JSON.stringify({ removed: out.results[0].removed, items: out.results[0].items }))
  check('⑩ import 批次清单**不该**被覆盖清理碰掉', idx.entries.some((e) => e.id === importEntry.id))
}

// ─────────────────────────── ⑦ 单区间失败不拖垮整批

{
  const tavern = makeTavern({ floors: 20, index: { ...INDEX_BASE, entries: [importEntry] } })
  const calls = []
  const out = await applySummarize({
    target: TARGET, ranges: [{ fromFloor: 0, toFloor: 9 }, { fromFloor: 10, toFloor: 19 }],
    instruction: 'x', api: { url: 'https://x/v1', model: 'm1', key: 'k' },
  }, { tavern, fetchImpl: llm(calls, (i) => (i === 1 ? { __http: 500, message: '第一条故意失败' } : fenced([{ summary: '好的' }]))) })
  check('⑦ 第一条失败、第二条照写：failed=1 written=1 ok=false',
    out.failed === 1 && out.written === 1 && out.ok === false, JSON.stringify({ w: out.written, f: out.failed }))
  check('⑦ 失败原因带 code 与 message（不静默）',
    out.results[0].ok === false && String(out.results[0].error).includes('SUMMARIZE_API_HTTP_500') && String(out.results[0].message).includes('第一条故意失败'),
    JSON.stringify(out.results[0]))
  check('⑦ 只有成功那条进了 index', JSON.parse(tavern.files.get(`${ARCHIVE}/summaries/index.json`)).entries.length === 2)
}

// ─────────────────────────── ③ 解析兜底

{
  check('③ 代码栏 JSON 能抓出来', JSON.stringify(extractJson('```json\n[{"summary":"甲"}]\n```')) === '[{"summary":"甲"}]')
  check('③ 没有代码栏也能靠括号配平抓出来', JSON.stringify(extractJson('前言 [{"summary":"乙"}] 后语')) === '[{"summary":"乙"}]')
  const p1 = parseSummaryOutput('```json\n[{"summary":"丙","tags":{"important":true}}]\n```')
  check('③ 解析：summary + tags 都拿到', p1.ok === true && p1.items[0].text === '丙' && p1.items[0].tags.join() === 'Important' && p1.usedJson === true)
  const p1b = parseSummaryOutput('[{"summary":"甲","tags":{"vibe":"Angst"}},{"summary":"乙","tags":{"important":true}}]')
  check('③ 多条：全都收下（anima 是一批多条切片）', p1b.items.length === 2 && p1b.items[1].text === '乙' && p1b.items[1].tags.join() === 'Important', JSON.stringify(p1b.items.map((x) => x.text)))
  const p2 = parseSummaryOutput('模型直接写了一段中文摘要，没有 JSON。')
  check('③ 纯文本兜底：当成一条收下、tags 空', p2.ok === true && p2.items.length === 1 && p2.items[0].text.startsWith('模型直接') && p2.items[0].tags.length === 0 && p2.usedJson === false)
  const p3 = parseSummaryOutput('   ')
  check('③ 空输出 ⇒ ok=false（不给空摘要）', p3.ok === false)
}

// ─────────────────────────── ⑧ index 坏了 fail-closed

{
  const tavern = makeTavern({ floors: 20, brokenIndex: true })
  let threw = null
  try {
    await applySummarize({
      target: TARGET, ranges: [{ fromFloor: 0, toFloor: 9 }],
      instruction: 'x', api: { url: 'https://x/v1', model: 'm1', key: 'k' },
    }, { tavern, fetchImpl: llm([], () => fenced([{ summary: 'x' }])) })
  } catch (e) { threw = e }
  check('⑧ index.json 解析不了 ⇒ 抛 SUMMARIZE_INDEX_BROKEN', threw && threw.code === 'SUMMARIZE_INDEX_BROKEN', String(threw && threw.code))
  check('⑧ fail-closed：一个 md 都没写', [...tavern.files.keys()].every((k) => !k.endsWith('.md')))
}

// ─────────────────────────── 消息构造的最小形状

{
  const m = buildSummaryMessages({ floors: [{ floor: 0, name: 'A', mes: '甲', isUser: false }], instruction: 'I' })
  check('无破限/无前文 ⇒ [system(指令), user(正文)]', m.length === 2 && m[0].role === 'system' && m[1].role === 'user' && m[0].content === 'I', JSON.stringify(m.map((x) => x.role)))
  const m2 = buildSummaryMessages({ floors: [{ floor: 0, name: 'A', mes: '甲' }], instruction: 'I', jailbreak: 'J', previousSummary: 'P' })
  check('有破限+有前文 ⇒ system 里破限+指令、user 里前文+正文', m2.length === 2 && m2[0].content.includes('J') && m2[0].content.includes('I')
    && m2[1].content.includes('<previous_summary>') && m2[1].content.includes('<text_to_summarize>'), JSON.stringify(m2.map((x) => x.role)))
}

// ─────────────────────────── ⑪ 清空总结（补救：预设没调好就重来）

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
  check('⑪ dryRun：报出要清几条、零写入', dry.ok === true && dry.dryRun === true && dry.content === 2
    && tavern.files.get(`${ARCHIVE}/summaries/s-0000-0019-1.md`) === '第一条旧摘要正文', JSON.stringify({ content: dry.content }))

  // ② 真清：备份在、正文被清空、index 只留 import-*、manifest count 跟着改
  const out = await resetSummaries({ target: TARGET }, { tavern })
  check('⑪ 清空：报告 cleared=2 / backupFiles=2', out.ok === true && out.cleared === 2 && out.backupFiles === 2,
    JSON.stringify({ cleared: out.cleared, backup: out.backupFiles }))
  check('⑪ 备份正文在（可恢复）', tavern.files.get(`${out.backupRel}/s-0000-0019-1.md`) === '第一条旧摘要正文'
    && tavern.files.get(`${out.backupRel}/s-0020-0039-1.md`) === '第二条旧摘要正文', out.backupRel)
  check('⑪ 原文件被清空（tavern 无删除接口 ⇒ 清空是最干净处置）',
    tavern.files.get(`${ARCHIVE}/summaries/s-0000-0019-1.md`) === '' && tavern.files.get(`${ARCHIVE}/summaries/s-0020-0039-1.md`) === '')
  const idx = JSON.parse(tavern.files.get(`${ARCHIVE}/summaries/index.json`))
  check('⑪ index 只留 import-*（⇒ 重跑 plan 会把 13 个区间重列出来）',
    idx.entries.length === 1 && idx.entries[0].id === importEntry.id, JSON.stringify(idx.entries.map((e) => e.id)))
  check('⑪ manifest 的 summaries.count 跟着改成保留数',
    JSON.parse(tavern.files.get(`${ARCHIVE}/manifest.json`)).summaries.count === 1)
  check('⑪ 原文楼层一个都没动', tavern.files.has(`${ARCHIVE}/floors/0000.json`))

  // ③ 清完再清 ⇒ 如实说"没有内容摘要可清"
  const again = await resetSummaries({ target: TARGET }, { tavern })
  check('⑪ 再清一次：reason 说明没有可清的（不假装干了活）', again.ok === true && /没有内容摘要可清/.test(String(again.reason)), String(again.reason))
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
  check('⑪★ 备份失败 ⇒ 那条不清（正文还在）、失败计数与原因都在',
    out.ok === false && out.failed === 1 && tavern.files.get(`${ARCHIVE}/summaries/s-0000-0004-1.md`) === '要被保护的正文',
    JSON.stringify({ ok: out.ok, failed: out.failed, results: out.results }))
}

console.log(fail === 0 ? `\n★ 扫归档→总结：全过（${pass} 条）` : `\n✖ ${fail} 条没过（通过 ${pass}）`)
process.exit(fail === 0 ? 0 : 3)
