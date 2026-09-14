#!/usr/bin/env node
/**
 * B 流自检台：lib/sections-capture.js 的落盘与 C4 数据访问面（单元级，不依赖宿主）。
 * 行为级证据（真跑一轮 + 反证 A/B/C + 切片回读）在沙箱 3101 上另行实测，见 M1 报告。
 * 跑法：node _selftest-sections.mjs（全部断言通过输出 ALL PASS）。
 *
 * 20260914 M1 单增量：① chars/hash 改为**插值后**口径（与实际发出的 system 同口径，
 * 原断言里没有依赖旧口径的计算值，fixture 均为静态读数，故无需改写，只新增）；
 * ② offset（0 字段记 null）+ renderedChars/renderedHash 自校验；③ /sections/text 端点
 * （resolveSectionText + sliceSectionByHeader + handleSectionsTextGet，含反证 A/B/C）。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import {
  resolveSections,
  readAssemblyFile,
  registerSectionsCapture,
  sectionOrderKey,
  compactWrite,
  buildRecord,
  computeSectionsLayout,
  resolveSectionText,
  sliceSectionByHeader,
  handleSectionsTextGet,
  storageDir,
  PLUGIN_DIR_NAME,
  LEGACY_DIR_NAMES,
} from './lib/sections-capture.js'
import { storageDir as hostStorageDir } from './lib/index.js'

const work = mkdtempSync(join(tmpdir(), 'mt-sections-'))
const dir = join(work, 'assembly')
mkdirSync(dir, { recursive: true })
const PASS = []
const FAIL = []
const t = async (name, fn) => {
  try {
    await fn()
    PASS.push(name)
  } catch (e) {
    FAIL.push(`${name}: ${e?.message || e}`)
  }
}
const hash16 = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 16)

// ── 存储目录解析：新名 / 旧名回退 / 两份实现不许漂移（2026-09-14 改名回 `dsh-memory-archive`） ──
await t('★ 存储目录：新名目录优先，两个都在时用新名', () => {
  const home = mkdtempSync(join(tmpdir(), 'mt-dir-both-'))
  mkdirSync(join(home, PLUGIN_DIR_NAME), { recursive: true })
  mkdirSync(join(home, LEGACY_DIR_NAMES[0]), { recursive: true })
  const got = storageDir({ DSH_HOME: home })
  assert.equal(got, join(home, PLUGIN_DIR_NAME), `两个都在时应取新名目录，实取 ${got}`)
  assert.equal(hostStorageDir({ DSH_HOME: home }), got, '两份 storageDir 解析结果不一致（漂移）')
  rmSync(home, { recursive: true, force: true })
})
await t('★ 存储目录：只有旧名目录时回退读它（老用户不会"数据消失"）', () => {
  const home = mkdtempSync(join(tmpdir(), 'mt-dir-legacy-'))
  mkdirSync(join(home, LEGACY_DIR_NAMES[0]), { recursive: true })
  const got = storageDir({ DSH_HOME: home })
  assert.equal(got, join(home, LEGACY_DIR_NAMES[0]), `只有旧名目录时应回退，实取 ${got}`)
  assert.equal(hostStorageDir({ DSH_HOME: home }), got, '两份 storageDir 解析结果不一致（漂移）')
  rmSync(home, { recursive: true, force: true })
})
await t('★ 存储目录：两个都没有 ⇒ 返回新名路径（不创建目录，也不猜）', () => {
  const home = mkdtempSync(join(tmpdir(), 'mt-dir-none-'))
  const got = storageDir({ DSH_HOME: home })
  assert.equal(got, join(home, PLUGIN_DIR_NAME), `无目录时应给新名路径，实取 ${got}`)
  assert.equal(hostStorageDir({ DSH_HOME: home }), got, '两份 storageDir 解析结果不一致（漂移）')
  rmSync(home, { recursive: true, force: true })
})

const LINE = JSON.stringify({
  turn: 2,
  capturedAt: '2026-09-13T11:02:05.000Z',
  agentId: 'agent-x',
  sections: [
    { name: 'harness:identity', order: -1000, chars: 48, hash: '0f1e2d3c4b5a6978', mutability: 'static', mutabilityBasis: 'definition' },
    { name: 'deployment:persona', order: 0, chars: 4010, hash: '1a2b3c4d5e6f7081', mutability: 'static', mutabilityBasis: 'definition' },
  ],
  contexts: [{ name: 'sandbox:policy', chars: 232 }],
  tools: [{ name: 'pwsh', chars: 4419, hash: 'aabbccdd00112233' }],
})
const LINE1 = LINE.replace('"turn":2', '"turn":1')

await t('resolveSections: 无记录 ⇒ inferred（不抛）', async () => {
  const r = await resolveSections('no-such-session', 1, { dir })
  assert.equal(r.ok, true)
  assert.equal(r.source, 'inferred')
  assert.equal(r.capturedAt, null)
  assert.equal(r.inferred.reason, 'no-capture-record')
  assert.deepEqual(r.sections, [])
})
await t('resolveSections: captured ⇒ C4 逐字段形状', async () => {
  writeFileSync(join(dir, 'session-cap.jsonl'), `${JSON.stringify({ v: 1, kind: 'dsh-memory-archive-assembly' })}\n${LINE1}\n${LINE}\n`, 'utf8')
  const r = await resolveSections('session-cap', 2, { dir })
  assert.equal(r.ok, true)
  assert.equal(r.source, 'captured')
  assert.equal(r.turn, 2)
  assert.equal(r.capturedAt, '2026-09-13T11:02:05.000Z')
  assert.equal(r.sections[0].name, 'harness:identity')
  assert.equal(r.sections[0].order, -1000)
  assert.equal(r.sections[0].chars, 48)
  assert.equal(r.sections[0].hash, '0f1e2d3c4b5a6978')
  assert.equal(r.sections[0].mutability, 'static')
  assert.equal(r.sections[0].mutabilityBasis, 'definition')
  assert.deepEqual(r.contexts, [{ name: 'sandbox:policy', chars: 232 }])
  assert.equal(r.tools[0].name, 'pwsh')
  assert.equal(r.tools[0].chars, 4419)
})
await t('resolveSections: turn 缺省 ⇒ 最新楼', async () => {
  const r = await resolveSections('session-cap', undefined, { dir })
  assert.equal(r.turn, 2)
})
await t('resolveSections: 同一楼多记录 ⇒ 最后一次为准', async () => {
  const later = LINE.replace('"capturedAt":"2026-09-13T11:02:05.000Z"', '"capturedAt":"2026-09-13T11:09:09.000Z"').replace('deployment:persona', 'renamed:persona')
  writeFileSync(join(dir, 'session-cap.jsonl'), `${JSON.stringify({ v: 1, kind: 'dsh-memory-archive-assembly' })}\n${LINE}\n${later}\n`, 'utf8')
  const r = await resolveSections('session-cap', 2, { dir })
  assert.equal(r.sections[1].name, 'renamed:persona')
})
await t('resolveSections: 不存在的楼号 ⇒ inferred(no-capture-record)', async () => {
  const r = await resolveSections('session-cap', 9, { dir })
  assert.equal(r.source, 'inferred')
  assert.equal(r.inferred.reason, 'no-capture-record')
})
await t('容错: schema 版本不认识 ⇒ inferred(schema-version-unknown)，不抛', async () => {
  writeFileSync(join(dir, 'session-oldver.jsonl'), `${JSON.stringify({ v: 99, kind: 'dsh-memory-archive-assembly' })}\n${LINE}\n`, 'utf8')
  const r = await resolveSections('session-oldver', 1, { dir })
  assert.equal(r.source, 'inferred')
  assert.equal(r.inferred.reason, 'schema-version-unknown')
})
await t('容错: 单行乱码 ⇒ 跳过坏行，好行照常（不抛）', async () => {
  writeFileSync(join(dir, 'session-corrupt.jsonl'), `${JSON.stringify({ v: 1, kind: 'dsh-memory-archive-assembly' })}\n{not json at all}\n${LINE}\n`, 'utf8')
  const r = await resolveSections('session-corrupt', 2, { dir })
  assert.equal(r.source, 'captured')
  assert.equal(r.sections[0].name, 'harness:identity')
})
await t('容错: 整个文件是乱码 ⇒ inferred（不抛）', async () => {
  writeFileSync(join(dir, 'session-garbage.jsonl'), 'complete garbage\n\n\n', 'utf8')
  const r = await resolveSections('session-garbage', 1, { dir })
  assert.equal(r.source, 'inferred')
  assert.equal(r.inferred.reason, 'schema-version-unknown')
})
await t('容错: sessionId 为空 ⇒ ok:false(bad-request)', async () => {
  const r = await resolveSections('', 1, { dir })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'bad-request')
})
await t('sectionOrderKey: 命名约定转换', () => {
  assert.equal(sectionOrderKey('harness:identity'), 'HARNESS_IDENTITY')
  assert.equal(sectionOrderKey('tool:pwsh'), 'TOOL_PWSH')
  assert.equal(sectionOrderKey('tools:sdk'), 'TOOLS_SDK')
  assert.equal(sectionOrderKey('weird name'), null)
})
await t('registerSectionsCapture: 假 ctx 安全不抛；同一 ctx 幂等', () => {
  assert.equal(registerSectionsCapture(null), null)
  assert.equal(registerSectionsCapture({}), null)
  const calls = []
  const ctx = { plugin: (p) => calls.push(p) }
  registerSectionsCapture(ctx, { dir })
  registerSectionsCapture(ctx, { dir })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].inject, ['systemPrompt', 'sessionProjections'])
  assert.equal(typeof calls[0].apply, 'function')
})
await t('结构性反证: 模块不含名单/标记子串式段识别', () => {
  const src = readFileSync(new URL('./lib/sections-capture.js', import.meta.url), 'utf8')
  for (const banned of ['PROMPT_MAP_MARKS', 'PROMPT_MAP_DEFS', 'PROMPT_MAP_MISSING', '@deepseek-ai/dsh-persona', '人设段']) {
    assert.ok(!src.includes(banned), `不得包含 ${banned}`)
  }
})
await t('有界前置: 260 楼大文件读取不抛、行数正确', () => {
  const rows = [JSON.stringify({ v: 1, kind: 'dsh-memory-archive-assembly' })]
  for (let turn = 1; turn <= 260; turn += 1) rows.push(LINE.replace('"turn":2', `"turn":${turn}`))
  writeFileSync(join(dir, 'session-big.jsonl'), rows.join('\n') + '\n', 'utf8')
  const f = readAssemblyFile(join(dir, 'session-big.jsonl'))
  assert.equal(f.records.length, 260)
})
await t('有界（C5）: compactWrite 260 楼 ⇒ 文件裁到最近 200 楼；同楼后写覆盖先写', () => {
  const p = join(dir, 'session-trim.jsonl')
  const records = []
  for (let turn = 1; turn <= 260; turn += 1) records.push(JSON.parse(LINE.replace('"turn":2', `"turn":${turn}`)))
  records.push(JSON.parse(LINE.replace('"turn":2', '"turn":260').replace('"agentId":"agent-x"', '"agentId":"agent-last"')))
  compactWrite(p, records, 200)
  const f = readAssemblyFile(p)
  assert.equal(f.version, 1)
  assert.equal(f.records.length, 200)
  assert.equal(f.records[0].turn, 61) // 260-200+1
  assert.equal(f.records[199].turn, 260)
  assert.equal(f.records[199].agentId, 'agent-last') // 同楼：最后一次组装为准
})

// ---------------------------------------------------------------------------
// 20260914 M1 单：插值后口径 + offset + 自校验（§3.1/§3.2/§3.3）
// ---------------------------------------------------------------------------

// 插值后各段：'identity-static'(15) / '人设：阿织'(5，插值前 7) / ''(0) / 'tail-正文'(6)
// rendered = 15 + 2 + 5 + 2 + 7 = 31；offsets = [0, 17, null, 24]
const VARS = { who: '阿织', empty: '' }
const ASSEMBLY = {
  sections: [
    { name: 'harness:identity', text: 'identity-static' },
    { name: 'persona:core', text: '人设：{{who}}' },
    { name: 'empty:after', text: '{{empty}}' },
    { name: 'tail:notes', text: 'tail-正文' },
  ],
  variables: VARS,
}
const FINAL_TEXTS = ['identity-static', '人设：阿织', '', 'tail-正文']
const RENDERED = FINAL_TEXTS.filter((s) => s.length > 0).join('\n\n')

await t('computeSectionsLayout: rendered/offsets/长度自洽（官方口径）', () => {
  const l = computeSectionsLayout(FINAL_TEXTS)
  assert.equal(l.ok, true)
  assert.equal(l.rendered, RENDERED)
  assert.equal(l.rendered.length, 31)
  assert.deepEqual(l.offsets, [0, 17, null, 24])
  // 长度自洽恒等式（§3.3.2）：Σchars + 2×(非空段数−1) === rendered.length
  const sum = FINAL_TEXTS.reduce((n, s) => n + s.length, 0)
  assert.equal(sum + 2 * 2, l.rendered.length)
})
await t('反证 A（红）: offset 故意 +1 ⇒ computeSectionsLayout 必须抓（offset-mismatch）', () => {
  const good = computeSectionsLayout(FINAL_TEXTS)
  assert.equal(good.ok, true)
  const tampered = [...good.offsets]
  tampered[1] = tampered[1] + 1 // 某段 offset +1
  const bad = computeSectionsLayout(FINAL_TEXTS, tampered)
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'offset-mismatch')
  // 空段位置被编成 0 也必须红（0 是"第一段"的合法位置，编 0 会切错）
  const zeroed = [...good.offsets]
  zeroed[2] = 0
  assert.equal(computeSectionsLayout(FINAL_TEXTS, zeroed).reason, 'offset-mismatch')
})
await t('buildRecord（§3.1）: chars/hash 取插值后文本；renderedChars/renderedHash 记录在案', () => {
  const rec = buildRecord(ASSEMBLY, { agent: { id: 'agent-t' } }, null, {})
  const secs = rec.sections
  assert.deepEqual(secs.map((s) => s.chars), [15, 5, 0, 7]) // 旧口径 persona:core 会是 7
  assert.deepEqual(secs.map((s) => s.hash), FINAL_TEXTS.map((s) => hash16(s)))
  assert.equal(rec.sections[1].renderedChars, 31)
  assert.equal(rec.sections[1].renderedHash, hash16(RENDERED))
})
await t('buildRecord（§3.2/反证 C）: offset 累加；插值后 0 字的段 offset=null（⛔ 不是 0）', () => {
  const rec = buildRecord(ASSEMBLY, { agent: { id: 'agent-t' } }, null, {})
  const byName = Object.fromEntries(rec.sections.map((s) => [s.name, s]))
  assert.equal(byName['harness:identity'].offset, 0) // 第一段：0 是合法位置
  assert.equal(byName['persona:core'].offset, 17)
  assert.equal(byName['empty:after'].offset, null)
  assert.notEqual(byName['empty:after'].offset, 0)
  assert.equal(byName['empty:after'].chars, 0)
  assert.equal(byName['tail:notes'].offset, 24) // 空段不占位：offset 不受影响
})
await t('切片回读（单元版）: rendered.slice(offset, offset+chars) 逐字等于该段插值后文本', () => {
  const rec = buildRecord(ASSEMBLY, { agent: { id: 'agent-t' } }, null, {})
  for (const s of rec.sections) {
    if (s.chars === 0) continue
    assert.equal(RENDERED.slice(s.offset, s.offset + s.chars), FINAL_TEXTS[rec.sections.indexOf(s)])
  }
})
await t('反证 B（红）: 含 {{变量}} 的段若用插值前长度，切片对不上（证明 §3.1 必要）', () => {
  const rec = buildRecord(ASSEMBLY, { agent: { id: 'agent-t' } }, null, {})
  const persona = rec.sections[1]
  const rawLen = '人设：{{who}}'.length // 7 = 旧口径会记的 chars
  assert.notEqual(rawLen, persona.chars)
  const oldSlice = RENDERED.slice(persona.offset, persona.offset + rawLen)
  assert.notEqual(oldSlice, '人设：阿织') // 旧口径切出来带着分隔符的脏文本
  assert.ok(oldSlice.startsWith('人设：阿织\n\n')) // 旧口径的错位形态（尾巴吃到下一段）
})
await t('buildRecord: 未知变量 ⇒ 插值失败如实降级（offset 全 null + 原因，不写真凭据）', () => {
  const rec = buildRecord(
    { sections: [{ name: 'a:x', text: 'A{{nope}}' }, { name: 'b:y', text: 'B' }], variables: {} },
    { agent: { id: 'agent-t' } },
    null,
    {},
  )
  for (const s of rec.sections) {
    assert.equal(s.offset, null)
    assert.equal(s.offsetUnavailableReason, 'interpolate-failed')
    assert.equal(s.renderedChars, undefined)
    assert.equal(s.renderedHash, undefined)
  }
  assert.equal(rec.sections[1].chars, 1) // 保底按原文量，不抛
})
await t('resolveSections: offset/renderedChars/renderedHash 原样透传（契约 §4 别丢字段）', async () => {
  const rec = buildRecord(ASSEMBLY, { agent: { id: 'agent-t' } }, null, {})
  rec.turn = 3
  writeFileSync(
    join(dir, 'session-pass.jsonl'),
    `${JSON.stringify({ v: 1, kind: 'dsh-memory-archive-assembly' })}\n${JSON.stringify(rec)}\n`,
    'utf8',
  )
  const r = await resolveSections('session-pass', 3, { dir })
  assert.equal(r.source, 'captured')
  assert.deepEqual(r.sections.map((s) => s.offset), [0, 17, null, 24])
  assert.equal(r.sections[0].renderedChars, 31)
  assert.equal(r.sections[0].renderedHash, hash16(RENDERED))
  // 旧记录（无这些字段）⇒ 原样缺省，不编造
  writeFileSync(join(dir, 'session-old.jsonl'), `${JSON.stringify({ v: 1, kind: 'dsh-memory-archive-assembly' })}\n${LINE}\n`, 'utf8')
  const old = await resolveSections('session-old', 2, { dir })
  assert.equal(old.sections[0].offset, null)
  assert.equal(old.sections[0].renderedChars, undefined)
})

// ---------------------------------------------------------------------------
// §9 /sections/text：resolveSectionText + sliceSectionByHeader + handleSectionsTextGet
// ---------------------------------------------------------------------------

const SID = 'sess-text'
const REC = buildRecord(ASSEMBLY, { agent: { id: 'agent-t' } }, null, {})
REC.turn = 1
const SYS = RENDERED // 该楼 header.system（= 自拼 rendered 的同口径文本）
const writeCapture = (name, record) =>
  writeFileSync(join(dir, `${name}.jsonl`), `${JSON.stringify({ v: 1, kind: 'dsh-memory-archive-assembly' })}\n${JSON.stringify(record)}\n`, 'utf8')
writeCapture(SID, REC)

await t('resolveSectionText: 无记录 ⇒ no-capture-record（不抛）', async () => {
  const r = await resolveSectionText('sess-absent', 1, 'harness:identity', { dir })
  assert.equal(r.ok, true)
  assert.equal(r.unavailable, 'no-capture-record')
  assert.equal(r.source, null)
})
await t('resolveSectionText: 楼号不存在 ⇒ turn-not-found', async () => {
  const r = await resolveSectionText(SID, 9, 'harness:identity', { dir })
  assert.equal(r.unavailable, 'turn-not-found')
})
await t('resolveSectionText: 段名不存在 ⇒ ok:false(no-such-section)', async () => {
  const r = await resolveSectionText(SID, 1, 'nope:missing', { dir })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'no-such-section')
})
await t('resolveSectionText: 0 字段（offset=null）⇒ no-offset；name/sessionId 缺 ⇒ bad-request', async () => {
  const r = await resolveSectionText(SID, 1, 'empty:after', { dir })
  assert.equal(r.unavailable, 'no-offset')
  assert.equal(r.section.offset, null)
  const bad1 = await resolveSectionText('', 1, 'x', { dir })
  assert.equal(bad1.error.code, 'bad-request')
  const bad2 = await resolveSectionText(SID, 1, '', { dir })
  assert.equal(bad2.error.code, 'bad-request')
})
await t('resolveSectionText: 凭据（renderedChars/renderedHash）缺失 ⇒ slice-mismatch（不盲切）', async () => {
  const stripped = JSON.parse(JSON.stringify(REC))
  for (const s of stripped.sections) {
    delete s.renderedChars
    delete s.renderedHash
  }
  writeCapture('sess-nocred', stripped)
  const r = await resolveSectionText('sess-nocred', 1, 'persona:core', { dir })
  assert.equal(r.unavailable, 'slice-mismatch')
})
await t('sliceSectionByHeader: 凭据相等才切，切出逐字相等；整段对不上 ⇒ slice-mismatch', () => {
  const persona = REC.sections.find((s) => s.name === 'persona:core')
  const good = sliceSectionByHeader(persona, SYS)
  assert.equal(good.unavailable, undefined)
  assert.equal(good.text, '人设：阿织')
  const badLen = sliceSectionByHeader(persona, SYS + '!')
  assert.equal(badLen.unavailable, 'slice-mismatch')
  const badHash = sliceSectionByHeader(persona, SYS.slice(0, -1) + '?')
  assert.equal(badHash.unavailable, 'slice-mismatch')
})
const fakeEvents = () => [
  { seq: 1, type: 'session/start', data: {} },
  { seq: 2, type: 'turn/start', data: { turn: 1 } },
  { seq: 3, type: 'request/header', data: { reason: 'turn', header: { system: SYS, config: { provider: 'p', model: 'm' } } } },
  { seq: 4, type: 'session/prompt', data: { text: 'hi' } },
  { seq: 5, type: 'turn/end', data: { reason: { kind: 'complete' } } },
]

await t('端点反证（DoD 8）: 捕获记录的 offset 被改错一位 ⇒ 端点给 slice-mismatch（整段凭据对、单段哈希红）', async () => {
  const tampered = JSON.parse(JSON.stringify(REC))
  const target = tampered.sections.find((s) => s.name === 'persona:core')
  target.offset += 1
  writeCapture('sess-tamper', tampered)
  const sends = []
  const send = (status, payload) => sends.push({ status, payload })
  const ctx = { get: (n) => (n === 'sessionQuery' ? { readSession: async () => ({ events: fakeEvents() }) } : undefined) }
  await handleSectionsTextGet(ctx, new URL(`http://dsh.local/sections/text?sessionId=sess-tamper&turn=1&name=persona:core`), send, (s) => s, { warn() {} }, { dir })
  assert.equal(sends.length, 1)
  assert.equal(sends[0].payload.unavailable, 'slice-mismatch')
  assert.equal(sends[0].payload.text, null)
})

await t('handleSectionsTextGet: 正常路径 ⇒ 只回被点开的那一段（文本逐字相等）', async () => {
  const sends = []
  const send = (status, payload) => sends.push({ status, payload })
  const ctx = { get: (n) => (n === 'sessionQuery' ? { readSession: async () => ({ events: fakeEvents() }) } : undefined) }
  await handleSectionsTextGet(ctx, new URL(`http://dsh.local/sections/text?sessionId=${SID}&turn=1&name=harness:identity`), send, (s) => s, { warn() {} }, { dir })
  assert.equal(sends.length, 1)
  assert.equal(sends[0].status, 200)
  const p = sends[0].payload
  assert.equal(p.ok, true)
  assert.equal(p.unavailable, null)
  assert.equal(p.source, 'captured')
  assert.equal(p.offset, 0)
  assert.equal(p.chars, 15)
  assert.equal(p.text, 'identity-static') // ⛔ 整段 system 绝不出现在响应里
  assert.ok(!JSON.stringify(p).includes('tail-正文'))
})
await t('handleSectionsTextGet: 缺参数/坏 turn ⇒ 400 bad-request', async () => {
  const sends = []
  const send = (status, payload) => sends.push({ status, payload })
  await handleSectionsTextGet({}, new URL('http://dsh.local/sections/text'), send, (s) => s, { warn() {} }, { dir })
  await handleSectionsTextGet({}, new URL('http://dsh.local/sections/text?sessionId=x'), send, (s) => s, { warn() {} }, { dir })
  await handleSectionsTextGet({}, new URL('http://dsh.local/sections/text?sessionId=x&name=y&turn=abc'), send, (s) => s, { warn() {} }, { dir })
  assert.deepEqual(sends.map((s) => s.status), [400, 400, 400])
  assert.ok(sends.every((s) => s.payload.error.code === 'bad-request'))
})
await t('handleSectionsTextGet: sessionQuery 缺席 ⇒ 503（不抛、不降级成猜）', async () => {
  const sends = []
  const send = (status, payload) => sends.push({ status, payload })
  await handleSectionsTextGet({}, new URL(`http://dsh.local/sections/text?sessionId=${SID}&turn=1&name=harness:identity`), send, (s) => s, { warn() {} }, { dir })
  assert.equal(sends[0].status, 503)
  assert.equal(sends[0].payload.error.code, 'SESSION_QUERY_UNAVAILABLE')
})
await t('handleSectionsTextGet: 楼在日志里找不到（无 turn/start）⇒ turn-not-found', async () => {
  const sends = []
  const send = (status, payload) => sends.push({ status, payload })
  const ctx = { get: (n) => (n === 'sessionQuery' ? { readSession: async () => ({ events: [{ seq: 1, type: 'session/start', data: {} }] }) } : undefined) }
  await handleSectionsTextGet(ctx, new URL(`http://dsh.local/sections/text?sessionId=${SID}&turn=1&name=harness:identity`), send, (s) => s, { warn() {} }, { dir })
  assert.equal(sends[0].payload.unavailable, 'turn-not-found')
  assert.equal(sends[0].payload.text, null)
})

await t('行为级: 假 scope 走完 registerSectionsCapture → assemble 瀑布 → 落盘带 offset', async () => {
  const listeners = {}
  const fakeScope = {
    on: (ev, fn) => {
      listeners[ev] = fn
      return () => {}
    },
    effect: () => {},
    logger: { info() {}, warn() {} },
    systemPrompt: { getSectionOrder: () => undefined },
    sessionProjections: { stateOf: (session, kind) => (kind === 'turnBoundary' ? { lastTurn: 7 } : null) },
  }
  const ctx = { plugin: (p) => p }
  const plugin = registerSectionsCapture(ctx, { dir })
  plugin.apply(fakeScope)
  const next = () => 'next'
  await listeners['system-prompt/assemble'](ASSEMBLY, { agent: { id: 'agent-l', session: { id: 'sess-live' } }, scope: fakeScope }, next)
  await new Promise((r) => setTimeout(r, 120)) // 写队列异步化：给落盘一个事件循环
  const f = readAssemblyFile(join(dir, 'sess-live.jsonl'))
  assert.equal(f.records.length, 1)
  const rec = f.records[0]
  assert.equal(rec.turn, 7)
  assert.deepEqual(rec.sections.map((s) => s.offset), [0, 17, null, 24])
  assert.equal(rec.sections[1].chars, 5) // 插值后口径
  assert.equal(rec.sections[0].renderedHash, hash16(RENDERED))
})

console.log(`PASS ${PASS.length}: ${PASS.join(' | ')}`)
if (FAIL.length) {
  console.log(`FAIL ${FAIL.length}: ${FAIL.join(' | ')}`)
  rmSync(work, { recursive: true, force: true })
  process.exit(1)
}
console.log('ALL PASS')
rmSync(work, { recursive: true, force: true })
