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
  pickVerifiedSystemText,
  recordCredentials,
  resolveSectionsSystemText,
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

// ---------------------------------------------------------------------------
// 新式 system 落点（20260915 实测补）：本版宿主 `request/header` 里**没有 system**
// （`agent-loop/src/agent.ts:562` canonicalHeader 只带 config/adapterDefaults/tools），
// system 正文走 `system/message` 这条 surface 事件 ⇒ 只认 header 的旧路径会永远
// turn-not-found、编辑器"原文"整块死掉。以下四条钉住新路径与它的反证。
// ---------------------------------------------------------------------------
const newStyleEvents = (body) => [
  { seq: 1, type: 'session/start', data: {} },
  { seq: 2, type: 'turn/start', data: { turn: 1 } },
  { seq: 3, type: 'request/header', data: { reason: 'initial', header: { config: { provider: 'p', model: 'm' }, tools: [] } } },
  { seq: 4, type: 'system/message', data: { turn: 1, step: 1, message: { role: 'system', content: body } } },
  { seq: 5, type: 'turn/end', data: { reason: { kind: 'complete' } } },
]
const ctxWith = (events) => ({ get: (n) => (n === 'sessionQuery' ? { readSession: async () => ({ events }) } : undefined) })
const callText = async (events, name = 'harness:identity', sid = SID) => {
  const sends = []
  await handleSectionsTextGet(ctxWith(events), new URL(`http://dsh.local/sections/text?sessionId=${sid}&turn=1&name=${encodeURIComponent(name)}`), (s, p) => sends.push({ s, p }), (s) => s, { warn() {} }, { dir })
  return sends[0]
}

await t('新式 system 落点: header 无 system、只有 system/message ⇒ 端点仍切出该段（逐字相等）', async () => {
  // 正文故意拆成两个文本块：块内拼接必须还原成与捕获同口径的整串
  const half = Math.floor(SYS.length / 2)
  const got = await callText(newStyleEvents([{ type: 'text', text: SYS.slice(0, half) }, { type: 'text', text: SYS.slice(half) }]))
  assert.equal(got.p.ok, true)
  assert.equal(got.p.unavailable, null)
  assert.equal(got.p.text, 'identity-static') // ⛔ 只回被点开那一段
  assert.ok(!JSON.stringify(got.p).includes('tail-正文'))
})

await t('反证（同长度改一字）: system/message 正文被换掉 ⇒ slice-mismatch（⛔ 不靠长度、靠 hash 抓）', async () => {
  const swapped = SYS.slice(0, 3) + (SYS[3] === 'x' ? 'y' : 'x') + SYS.slice(4)
  assert.equal(swapped.length, SYS.length)
  assert.notEqual(swapped, SYS)
  const got = await callText(newStyleEvents([{ type: 'text', text: swapped }]))
  assert.equal(got.p.unavailable, 'slice-mismatch')
  assert.equal(got.p.text, null)
})

await t('反证: 既没有 header.system 也没有 system/message ⇒ turn-not-found（⛔ 不猜正文）', async () => {
  const got = await callText([{ seq: 1, type: 'turn/start', data: { turn: 1 } }, { seq: 2, type: 'turn/end', data: { reason: { kind: 'complete' } } }])
  assert.equal(got.p.unavailable, 'turn-not-found')
  assert.equal(got.p.text, null)
})

await t('分次提交: 同一楼两条 system/message（先前已过时的那条）⇒ 仍切对（候选从后往前试，不硬拼）', async () => {
  const two = newStyleEvents([{ type: 'text', text: '过时的 system（hash 对不上）' }])
  two.splice(4, 0, { seq: 4.5, type: 'system/message', data: { turn: 1, step: 2, message: { role: 'system', content: [{ type: 'text', text: SYS }] } } })
  const got = await callText(two)
  assert.equal(got.p.unavailable, null)
  assert.equal(got.p.text, 'identity-static')
})

await t('行为级: 两段式 —— 装配期只记结构（offset 留空），等 system/message 来了才定位真 offset', async () => {
  const listeners = {}
  // ⚠️ 每个事件要能挂**多个**监听（`session/event` 上既有"接管触发"又有"等最终正文"），
  //    所以存数组并按**注册顺序**跑；`system-prompt/assemble` 还要支持 next() 链（瀑布语义）。
  const on = (ev, fn) => {
    ;(listeners[ev] ??= []).push(fn)
    return () => {}
  }
  const waterfall = async (ev, ...args) => {
    const l = listeners[ev] ?? []
    let i = -1
    const next = async () => { i += 1; if (i >= l.length) return args[0]; return l[i](...args, next) }
    return next()
  }
  const emitAll = (ev, ...args) => { for (const fn of (listeners[ev] ?? [])) { try { fn(...args) } catch {} } }
  const proj = { turn: 7 }
  const fakeScope = {
    on,
    effect: () => {},
    logger: { info() {}, warn() {} },
    systemPrompt: { getSectionOrder: () => undefined },
    sessionProjections: { stateOf: (session, kind) => (kind === 'turnBoundary' ? { lastTurn: proj.turn } : null) },
  }
  const ctx = { plugin: (p) => p, on }
  const plugin = registerSectionsCapture(ctx, { dir })
  plugin.apply(fakeScope)
  const assembleCtx = { agent: { id: 'agent-l', session: { id: 'sess-live' } }, scope: fakeScope }
  const file = join(dir, 'sess-live.jsonl')
  const wait = () => new Promise((r) => setTimeout(r, 120))

  await waterfall('system-prompt/assemble', ASSEMBLY, assembleCtx)
  await wait()
  const f = readAssemblyFile(file)
  assert.equal(f.records.length, 1)
  const rec = f.records[0]
  assert.equal(rec.turn, 7)
  assert.equal(rec.sections[1].chars, 5, '段自身字数照旧（插值后口径）')
  assert.equal(rec.sections[0].hash, hash16('identity-static'), '段自身 hash 照旧')
  // ★★ 装配期**不许**发布位置与整段凭据 —— 这里拿到的是"瀑布返回值"，但 DSH 之后还会做
  //    `complete` 段覆盖 ⇒ 未必等于**最终**系统正文。真位置只能等 `system/message` 来定。
  assert.deepEqual(rec.sections.map((s) => s.offset), [null, null, null, null], '装配期 offset 必须留空')
  assert.deepEqual(rec.sections.map((s) => s.renderedChars), [null, null, null, null])
  assert.deepEqual(rec.sections.map((s) => s.renderedHash), [null, null, null, null])
  assert.equal(rec.finalized, false)
  assert.equal(rec.finalizeReason, 'waiting-final-text')
  assert.equal(rec.listenerMode, 'outermost-return', '最外层 + 读返回值（2026-09-17 判据实验后定案）')

  // 接管（会话事件）—— 与"等最终正文"共用 session/event，两件事都要发生
  emitAll('session/event', { id: 'sess-live' }, { type: 'agent/inbox/spliced' })

  // ★ 反证：楼号对不上的 system/message **不许**用来定位（否则会拿错楼的正文去切）
  emitAll('session/event', { id: 'sess-live' }, { type: 'system/message', data: { turn: 99, message: { content: [{ type: 'text', text: RENDERED }] } } })
  await wait()
  assert.equal(readAssemblyFile(file).records[0].finalized, false, '楼号不符时不许定稿')

  // ★ 反证：正文对不上（这里给一段不是它发出去的正文）⇒ 只记原因，⛔ 不给位置
  emitAll('session/event', { id: 'sess-live' }, { type: 'system/message', data: { turn: 7, message: { content: [{ type: 'text', text: '完全不相干的正文' }] } } })
  await wait()
  const partial = readAssemblyFile(file).records[0]
  assert.equal(partial.finalized, false)
  assert.match(String(partial.finalizeReason), /^locate-/)
  assert.deepEqual(partial.sections.map((s) => s.offset), [null, null, null, null])

  // ★★ 真·定稿：DSH 把**最终**系统正文写进日志 ⇒ 定位出真 offset，并补上整段凭据
  emitAll('session/event', { id: 'sess-live' }, { type: 'system/message', data: { turn: 7, message: { content: [{ type: 'text', text: RENDERED }] } } })
  await wait()
  const done = readAssemblyFile(file).records[0]
  assert.equal(done.finalized, true, '★ 最终正文一到就该定稿')
  assert.equal(done.finalizeReason, 'located')
  assert.deepEqual(done.sections.map((s) => s.offset), [0, 17, null, 24])
  assert.deepEqual(done.sections.map((s) => s.renderedChars), [31, 31, 31, 31])
  assert.equal(done.sections[0].renderedHash, hash16(RENDERED), '★ 整段凭据 = 最终正文的（§9 两道验才过得去）')
  // ★ 反证：那一段在最终正文里**也真的是空的**（空段不占位）⇒ 位置必须如实留空，⛔ 不编 0
  assert.equal(done.sections[2].offset, null, '⛔ 空段不许编出位置')
  // 切片回读：拿定稿的 offset 从最终正文里切，逐字等于该段
  for (const [i, t] of FINAL_TEXTS.entries()) {
    if (t === '') continue
    const s = done.sections[i]
    assert.equal(RENDERED.slice(s.offset, s.offset + s.chars), t)
  }
})

await t('行为级: ★★ 装配期抄的是瀑布**返回值** —— 下游 `await next()` 之后加进去的段必须被记到', async () => {
  const listeners = {}
  const on = (ev, fn) => {
    ;(listeners[ev] ??= []).push(fn)
    return () => {}
  }
  const waterfall = async (ev, ...args) => {
    const l = listeners[ev] ?? []
    let i = -1
    const next = async () => { i += 1; if (i >= l.length) return args[0]; return l[i](...args, next) }
    return next()
  }
  const fakeScope = {
    on,
    effect: () => {},
    logger: { info() {}, warn() {} },
    systemPrompt: { getSectionOrder: () => undefined },
    sessionProjections: { stateOf: (session, kind) => (kind === 'turnBoundary' ? { lastTurn: 11 } : null) },
  }
  const ctx = { plugin: (p) => p, on }
  registerSectionsCapture(ctx, { dir }).apply(fakeScope) // 捕获挂在最外层
  // ★ 模拟 anima：注册在**后面**（内层），`await next()` **之后**才改写并返回 ——
  //   它的产物只沿返回值往上传，所以只有"站在前面 + 看返回值"的人才拿得到。
  const INJECTED = '【记忆】下游注入的正文，入参里根本没有这一段'
  on('system-prompt/assemble', async (a, b, next) => {
    const out = await next()
    return { ...out, sections: [...(out.sections ?? []), { name: 'anima:memory', text: INJECTED }] }
  })
  const file = join(dir, 'sess-outer.jsonl')
  await waterfall('system-prompt/assemble', ASSEMBLY, { agent: { id: 'a', session: { id: 'sess-outer' } }, scope: fakeScope })
  await new Promise((r) => setTimeout(r, 150))
  const rec = readAssemblyFile(file).records[0]
  assert.ok(rec, '该楼必须有记录')
  const anima = rec.sections.find((s) => s.name === 'anima:memory')
  assert.ok(anima, '★ 下游注入的段必须出现在捕获里（靠的是读**返回值**，不是读入参）')
  assert.equal(anima.chars, INJECTED.length, '★ 且用的是**下游改写后**的正文长度')
  assert.equal(anima.hash, hash16(INJECTED))
})

// ---------------------------------------------------------------------------
// ★★ 底本回退（2026-09-18）：本楼宿主**没有重发**系统提示词时，沿用**上一份**正文定界。
// 机制出处：`core/agent-loop/src/runtime-context.ts:94`
//   `if (latest.text === rendered) return []` —— 正文没变就不追加 `system/message`，
//   而 `latest` 取的是 `findLast(node => node.text !== '')`（同文件 :87）。
//   ⇒ **本楼没有 `system/message` ⟺ 本楼发出去的系统正文与上一份逐字节相同。**
// 真机证据：`session-c37c466c` 第 11/13/14 楼没有 `system/message`（1–10、12 楼都有）。
// ---------------------------------------------------------------------------
await t('行为级 ★★ 底本回退: 本楼没有 system/message ⇒ turn/end 拿上一份定界，且**如实标来路**', async () => {
  const listeners = {}
  const on = (ev, fn) => {
    ;(listeners[ev] ??= []).push(fn)
    return () => {}
  }
  const waterfall = async (ev, ...args) => {
    const l = listeners[ev] ?? []
    let i = -1
    const next = async () => { i += 1; if (i >= l.length) return args[0]; return l[i](...args, next) }
    return next()
  }
  const emitAll = (ev, ...args) => { for (const fn of (listeners[ev] ?? [])) { try { fn(...args) } catch {} } }
  let turn = 7
  const fakeScope = {
    on,
    effect: () => {},
    logger: { info() {}, warn() {} },
    systemPrompt: { getSectionOrder: () => undefined },
    sessionProjections: { stateOf: (s, k) => (k === 'turnBoundary' ? { lastTurn: turn } : null) },
  }
  const ctx = { plugin: (p) => p, on }
  registerSectionsCapture(ctx, { dir }).apply(fakeScope)
  const file = join(dir, 'sess-carry.jsonl')
  const wait = () => new Promise((r) => setTimeout(r, 120))
  const rec = (n) => readAssemblyFile(file).records.find((x) => x.turn === n) ?? null
  const sess = { id: 'sess-carry' }

  // 第 7 楼：宿主**重发了**系统提示词 ⇒ 普通路径定稿
  await waterfall('system-prompt/assemble', ASSEMBLY, { agent: { id: 'a', session: sess }, scope: fakeScope })
  emitAll('session/event', sess, { type: 'system/message', data: { turn: 7, message: { content: [{ type: 'text', text: RENDERED }] } } })
  await wait()
  assert.equal(rec(7).finalized, true, '第 7 楼自带正文 ⇒ 正常定稿')
  assert.equal(rec(7).finalizeBasis, 'own', '★ 来路标为「本楼自带」')

  // 第 8 楼：装配了，但**从头到尾没有** system/message
  turn = 8
  await waterfall('system-prompt/assemble', ASSEMBLY, { agent: { id: 'a', session: sess }, scope: fakeScope })
  await wait()
  assert.equal(rec(8).finalized, false, '⛔ 这会儿还不知道宿主发不发 —— 不许提前定稿')
  assert.equal(rec(8).finalizeReason, 'waiting-final-text')
  // ★ 反证：楼号对不上的 system/message **不算**"本楼自带正文" ⇒ 不许借它定稿，
  //   也⛔不许把第 8 楼标成"自带过正文"（否则回退会被白白放弃）
  emitAll('session/event', sess, { type: 'system/message', data: { turn: 99, message: { content: [{ type: 'text', text: RENDERED }] } } })
  await wait()
  assert.equal(rec(8).finalized, false, '楼号不符 ⇒ 不许借它定稿')
  emitAll('session/event', sess, { type: 'turn/end', data: { turn: 8 } })
  await wait()
  const carried = rec(8)
  assert.equal(carried.finalized, true, '★ 该楼结束、始终没有正文 ⇒ 用上一份定稿')
  assert.equal(carried.finalizeBasis, 'carried', '★ 来路必须标成「沿用」')
  assert.equal(carried.carriedFromTurn, 7, '★ 并写清沿用的是哪一楼')
  assert.deepEqual(
    carried.sections.map((s) => s.offset),
    rec(7).sections.map((s) => s.offset),
    '★ 同一份正文 ⇒ 位置与第 7 楼逐字段相同',
  )
  assert.equal(carried.sections[0].renderedHash, hash16(RENDERED), '整段凭据照给（切片端点要靠它两道验）')

  // ★ 读路径也要跟上：第 8 楼在本楼找不到 system/message，端点必须能回退到第 7 楼那份正文
  const sends = []
  const carryEvents = [
    { seq: 1, type: 'turn/start', data: { turn: 7 } },
    { seq: 2, type: 'system/message', data: { turn: 7, step: 1, message: { role: 'system', content: [{ type: 'text', text: RENDERED }] } } },
    { seq: 3, type: 'turn/end', data: { turn: 7 } },
    { seq: 4, type: 'turn/start', data: { turn: 8 } },
    { seq: 5, type: 'turn/end', data: { turn: 8 } },
  ]
  await handleSectionsTextGet(
    ctxWith(carryEvents),
    new URL('http://dsh.local/sections/text?sessionId=sess-carry&turn=8&name=harness%3Aidentity'),
    (s, p) => sends.push({ s, p }),
    (s) => s,
    { warn() {} },
    { dir },
  )
  const got = sends[0]
  assert.equal(got.p.unavailable, null, '★ 本楼没有 system/message 也要切得出（回退到上一份）')
  assert.equal(got.p.text, 'identity-static', '★ 切出来的就是它实际发出去的那一段')
  assert.equal(got.p.finalizeBasis, 'carried', '★ 端点如实转达来路')
  assert.equal(got.p.carriedFromTurn, 7)
})

await t('反证 ★ 会话第一楼就没有 system/message ⇒ 没有「上一份」可沿用，⛔ 不许编位置', async () => {
  const listeners = {}
  const on = (ev, fn) => {
    ;(listeners[ev] ??= []).push(fn)
    return () => {}
  }
  const waterfall = async (ev, ...args) => {
    const l = listeners[ev] ?? []
    let i = -1
    const next = async () => { i += 1; if (i >= l.length) return args[0]; return l[i](...args, next) }
    return next()
  }
  const emitAll = (ev, ...args) => { for (const fn of (listeners[ev] ?? [])) { try { fn(...args) } catch {} } }
  const fakeScope = {
    on,
    effect: () => {},
    logger: { info() {}, warn() {} },
    systemPrompt: { getSectionOrder: () => undefined },
    sessionProjections: { stateOf: (s, k) => (k === 'turnBoundary' ? { lastTurn: 1 } : null) },
  }
  registerSectionsCapture({ plugin: (p) => p, on }, { dir }).apply(fakeScope)
  const sess = { id: 'sess-first' }
  await waterfall('system-prompt/assemble', ASSEMBLY, { agent: { id: 'a', session: sess }, scope: fakeScope })
  emitAll('session/event', sess, { type: 'turn/end', data: { turn: 1 } })
  await new Promise((r) => setTimeout(r, 120))
  const first = readAssemblyFile(join(dir, 'sess-first.jsonl')).records[0]
  assert.equal(first.finalized, false)
  assert.equal(first.finalizeReason, 'waiting-final-text', '★ 没有上一份 ⇒ 如实留白')
  assert.deepEqual(first.sections.map((s) => s.offset), [null, null, null, null], '⛔ 绝不许编位置')
  assert.equal(first.finalizeBasis, undefined)
})

await t('反证 ★ 本楼**自带**正文但定位失败 ⇒ turn/end 不许拿上一份去覆盖它的结论', async () => {
  const listeners = {}
  const on = (ev, fn) => {
    ;(listeners[ev] ??= []).push(fn)
    return () => {}
  }
  const waterfall = async (ev, ...args) => {
    const l = listeners[ev] ?? []
    let i = -1
    const next = async () => { i += 1; if (i >= l.length) return args[0]; return l[i](...args, next) }
    return next()
  }
  const emitAll = (ev, ...args) => { for (const fn of (listeners[ev] ?? [])) { try { fn(...args) } catch {} } }
  let turn = 7
  const fakeScope = {
    on,
    effect: () => {},
    logger: { info() {}, warn() {} },
    systemPrompt: { getSectionOrder: () => undefined },
    sessionProjections: { stateOf: (s, k) => (k === 'turnBoundary' ? { lastTurn: turn } : null) },
  }
  registerSectionsCapture({ plugin: (p) => p, on }, { dir }).apply(fakeScope)
  const file = join(dir, 'sess-ownbad.jsonl')
  const wait = () => new Promise((r) => setTimeout(r, 120))
  const sess = { id: 'sess-ownbad' }
  await waterfall('system-prompt/assemble', ASSEMBLY, { agent: { id: 'a', session: sess }, scope: fakeScope })
  emitAll('session/event', sess, { type: 'system/message', data: { turn: 7, message: { content: [{ type: 'text', text: RENDERED }] } } })
  await wait()
  assert.equal(readAssemblyFile(file).records[0].finalized, true)
  // 第 8 楼：**自带**一条对不上的正文 ⇒ 定位必然失败；turn/end 之后仍须是失败结论
  turn = 8
  await waterfall('system-prompt/assemble', ASSEMBLY, { agent: { id: 'a', session: sess }, scope: fakeScope })
  emitAll('session/event', sess, { type: 'system/message', data: { turn: 8, message: { content: [{ type: 'text', text: '完全不相干的正文' }] } } })
  await wait()
  emitAll('session/event', sess, { type: 'turn/end', data: { turn: 8 } })
  await wait()
  const own = readAssemblyFile(file).records.find((r) => r.turn === 8)
  assert.equal(own.finalized, false)
  assert.match(String(own.finalizeReason), /^locate-/, '★ 该楼自带正文 ⇒ 结论就是它自己的定位结果')
  assert.equal(own.finalizeBasis, undefined, '⛔ 自带正文的楼不许被标成「沿用」')
  assert.deepEqual(own.sections.map((s) => s.offset), [null, null, null, null])
})

await t('★ 定稿失败要能自查: 记下**哪几段**没落位（⛔ 只有名字与计数），且端点如实转达', async () => {
  const listeners = {}
  const on = (ev, fn) => {
    ;(listeners[ev] ??= []).push(fn)
    return () => {}
  }
  const waterfall = async (ev, ...args) => {
    const l = listeners[ev] ?? []
    let i = -1
    const next = async () => { i += 1; if (i >= l.length) return args[0]; return l[i](...args, next) }
    return next()
  }
  const emitAll = (ev, ...args) => { for (const fn of (listeners[ev] ?? [])) { try { fn(...args) } catch {} } }
  const fakeScope = {
    on,
    effect: () => {},
    logger: { info() {}, warn() {} },
    systemPrompt: { getSectionOrder: () => undefined },
    sessionProjections: { stateOf: (s, k) => (k === 'turnBoundary' ? { lastTurn: 3 } : null) },
  }
  registerSectionsCapture({ plugin: (p) => p, on }, { dir }).apply(fakeScope)
  const sess = { id: 'sess-miss' }
  await waterfall('system-prompt/assemble', ASSEMBLY, { agent: { id: 'a', session: sess }, scope: fakeScope })
  // 最终正文里**少了** tail 那一段（另两段逐字都在）
  const partialText = FINAL_TEXTS.filter((t) => t !== '').slice(0, 2).join('\n\n')
  emitAll('session/event', sess, { type: 'system/message', data: { turn: 3, message: { content: [{ type: 'text', text: partialText }] } } })
  await new Promise((r) => setTimeout(r, 150))
  const rec = readAssemblyFile(join(dir, 'sess-miss.jsonl')).records[0]
  assert.equal(rec.finalized, false)
  assert.equal(rec.finalizeReason, 'locate-partial')
  assert.deepEqual(rec.locateMiss, ['tail:notes'], '★ 必须点名没落位的那一段')
  assert.deepEqual(rec.locateCounts, { exact: 2, anchored: 0, total: 3 }, '★ 并给出三类计数')
  assert.deepEqual(rec.locateWhy, { 'tail:notes': 'anchor-miss' }, '★ 还要说清**为什么**（哪一类失败）')
  assert.ok(!JSON.stringify(rec).includes('identity-static'), '⛔ 失败明细里不许夹带正文')

  // 端点也要如实转达（界面靠它把"为什么给不出位置"讲清楚）
  const sends = []
  await handleSectionsTextGet(
    ctxWith([{ seq: 1, type: 'turn/start', data: { turn: 3 } }, { seq: 2, type: 'system/message', data: { turn: 3, message: { content: [{ type: 'text', text: partialText }] } } }]),
    new URL('http://dsh.local/sections/text?sessionId=sess-miss&turn=3&name=harness%3Aidentity'),
    (s, p) => sends.push({ s, p }),
    (s) => s,
    { warn() {} },
    { dir },
  )
  assert.equal(sends[0].p.unavailable, 'no-offset')
  assert.deepEqual(sends[0].p.locateMiss, ['tail:notes'], '★ 端点转达失败明细')
})

await t('★ 宿主重启后（内存空）⇒ 从**会话日志的 surface** 恢复上一份底本，照抄宿主那条判据', async () => {
  const listeners = {}
  const on = (ev, fn) => {
    ;(listeners[ev] ??= []).push(fn)
    return () => {}
  }
  const waterfall = async (ev, ...args) => {
    const l = listeners[ev] ?? []
    let i = -1
    const next = async () => { i += 1; if (i >= l.length) return args[0]; return l[i](...args, next) }
    return next()
  }
  const emitAll = (ev, ...args) => { for (const fn of (listeners[ev] ?? [])) { try { fn(...args) } catch {} } }
  const fakeScope = {
    on,
    effect: () => {},
    logger: { info() {}, warn() {} },
    systemPrompt: { getSectionOrder: () => undefined },
    sessionProjections: { stateOf: (s, k) => (k === 'turnBoundary' ? { lastTurn: 6 } : null) },
  }
  // ★ 模拟"重启后"的宿主：日志的当前 surface 里躺着第 5 楼那条 system/message
  const log = new Map([
    [1, { type: 'system/message', data: { turn: 5, message: { content: [{ type: 'text', text: RENDERED }] } } }],
  ])
  const sess = { id: 'sess-logprev', surface: { nodes: [1] }, eventAt: (seq) => log.get(seq) }
  registerSectionsCapture({ plugin: (p) => p, on }, { dir }).apply(fakeScope)
  await waterfall('system-prompt/assemble', ASSEMBLY, { agent: { id: 'a', session: sess }, scope: fakeScope })
  emitAll('session/event', sess, { type: 'turn/end', data: { turn: 6 } })
  await new Promise((r) => setTimeout(r, 150))
  const rec = readAssemblyFile(join(dir, 'sess-logprev.jsonl')).records[0]
  assert.equal(rec.finalized, true, '★ 内存里没有，但日志里有 ⇒ 照样能定稿')
  assert.equal(rec.finalizeBasis, 'carried')
  assert.equal(rec.carriedFromTurn, 5, '★ 沿用的是日志里第 5 楼那一份')
  assert.deepEqual(rec.sections.map((s) => s.offset), [0, 17, null, 24])

  // ★ 反证：surface 里那条是**空的** ⇒ 等于没有上一份，⛔ 不许编位置
  const log2 = new Map([[1, { type: 'system/message', data: { turn: 5, message: { content: [{ type: 'text', text: '' }] } } }]])
  const sess2 = { id: 'sess-logempty', surface: { nodes: [1] }, eventAt: (seq) => log2.get(seq) }
  const fs2 = { ...fakeScope, sessionProjections: { stateOf: (s, k) => (k === 'turnBoundary' ? { lastTurn: 6 } : null) } }
  registerSectionsCapture({ plugin: (p) => p, on }, { dir }).apply(fs2)
  await waterfall('system-prompt/assemble', ASSEMBLY, { agent: { id: 'a', session: sess2 }, scope: fs2 })
  emitAll('session/event', sess2, { type: 'turn/end', data: { turn: 6 } })
  await new Promise((r) => setTimeout(r, 150))
  const rec2 = readAssemblyFile(join(dir, 'sess-logempty.jsonl')).records[0]
  assert.equal(rec2.finalized, false)
  assert.equal(rec2.finalizeReason, 'waiting-final-text', '★ 日志里那份是空的 ⇒ 等于没有，如实留白')
  assert.deepEqual(rec2.sections.map((s) => s.offset), [null, null, null, null])
})

// ---------- 2026-09-20：底本必须是"捕获认过的那一份"（/sections/system） ----------
// 用户报障（原文）：「以上是没抓到的字段。很抽象，都是些字段碎片。我觉得算bug」。
// 真机根因：面板把**捕获的 offset** 切在**另一条路取来的** system 上（该楼 header 那一刻的正文），
//   而捕获定稿用的是同一楼另一条 `system/message` ⇒ 两份同长不同文，补集全是错位的渣。
await t('SYS1 pickVerifiedSystemText：两道验（长度 + sha256）都对得上才认；⛔ 长度相同内容不同 ⇒ 不认', () => {
  const h = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16)
  const a = 'x'.repeat(100)
  const b = 'y'.repeat(100)
  assert.equal(pickVerifiedSystemText([a], 100, h(a)), a, '凭据对得上就该认')
  // ★ 反证（真机就是这个坑）：两份**长度相等、内容不同** —— 只认凭据对得上的那一份
  assert.equal(pickVerifiedSystemText([b, a], 100, h(a)), a, '同长不同文时必须挑凭据对的那份')
  assert.equal(pickVerifiedSystemText([b], 100, h(a)), null, '⛔ 同长但内容不符 ⇒ 不认（就是这一条挡住了错位切片）')
  assert.equal(pickVerifiedSystemText([a], 100, ''), null, '没凭据 ⇒ 不认')
  assert.equal(pickVerifiedSystemText([a], 0, h(a)), null, '凭据长度非法 ⇒ 不认')
  assert.equal(pickVerifiedSystemText('not-an-array', 100, h(a)), null, '畸形输入 ⇒ 不认、不抛')
})

await t('SYS2 recordCredentials：只认"非空段 + 带整段凭据"的那一条（⛔ 0 字段/缺凭据都不算）', () => {
  assert.equal(recordCredentials({ sections: [{ chars: 0, renderedChars: 100, renderedHash: 'h' }] }), null, '0 字段不占位 ⇒ 不能当凭据来源')
  assert.equal(recordCredentials({ sections: [{ chars: 5 }] }), null, '只有字数没有整段凭据 ⇒ 不算')
  assert.deepEqual(
    recordCredentials({ sections: [{ chars: 5 }, { chars: 7, renderedChars: 100, renderedHash: 'ab' }] }),
    { renderedChars: 100, renderedHash: 'ab' },
  )
  assert.equal(recordCredentials({}), null)
  assert.equal(recordCredentials(null), null)
})

await t('SYS3 resolveSectionsSystemText：三种"拿不到"各报各的（⛔ 不端半份、不近似）', async () => {
  const r1 = await resolveSectionsSystemText({}, 'session-sys-nope', 1, { dir })
  assert.equal(r1.ok, true)
  assert.equal(r1.unavailable, 'no-capture-record')
  assert.equal(r1.text, null)
  const sid = 'session-sys'
  const base = { turn: 1, capturedAt: 'x', sections: [{ name: 'a', chars: 5, renderedChars: 100, renderedHash: 'h' }] }
  compactWrite(join(dir, `${sid}.jsonl`), [{ ...base, finalized: false, finalizeReason: 'waiting-final-text' }], 10)
  const r2 = await resolveSectionsSystemText({}, sid, 1, { dir })
  assert.equal(r2.unavailable, 'not-finalized', '没定稿 ⇒ 段上根本没有可信 offset，底本无从谈起')
  assert.equal(r2.text, null)
  compactWrite(join(dir, `${sid}.jsonl`), [{ ...base, finalized: true, finalizeBasis: 'own' }], 10)
  const r3 = await resolveSectionsSystemText({}, sid, 1, { dir })
  assert.equal(r3.unavailable, 'session-query-unavailable', '定稿了但读不到日志 ⇒ 如实说，⛔ 不拿别的正文凑')
  assert.equal(r3.text, null)
  assert.equal(r3.renderedChars, 100, '拿不到也要把凭据带出来（界面据此说清"差在哪儿"）')
})

console.log(`PASS ${PASS.length}: ${PASS.join(' | ')}`)
if (FAIL.length) {
  console.log(`FAIL ${FAIL.length}: ${FAIL.join(' | ')}`)
  rmSync(work, { recursive: true, force: true })
  process.exit(1)
}
console.log('ALL PASS')
rmSync(work, { recursive: true, force: true })
