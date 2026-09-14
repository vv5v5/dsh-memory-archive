#!/usr/bin/env node
/**
 * 自检台 · M9（20260914）：**深链**（可寻址）、**事实说明书**（`?`）、**结构化诊断**出口。
 *
 * ## 为什么要有这三样
 * 编辑器原来有个共性问题：**"看到的"没法被引用、没法被复现、坏消息是散的。**
 *   · 深链：状态全在内存 ⇒ 没法把"这一楼的这张图"发给别人，也没法复现（验收时只能靠手点）。
 *   · 事实说明书：**判据没处可查** —— 用户两次踩的坑（旧楼为何不可用、contexts 为何不算 system）本质都是这个。
 *   · 结构化诊断：坏消息散在 `no-capture-record` / offset 缺 / 凭据缺 / `session-parse-failed` / `archived:null` 里，
 *     得点开好几处才拼得出"这条会话到底哪儿不对"。
 * 借的是 Archify 的呈现纪律：**稳定码 + 准确对象 + 测量证据 + 真正支持的修法**（⛔ 不写做不到的建议、⛔ 不推断影响）。
 *
 * ## 覆盖
 * 客户端纯函数：深链读/写/往返、说明书内容（必须讲到那几条判据）、诊断响应 ⇒ 界面 chips（按严重度排序 + 证据进 tooltip）。
 * 服务半侧行为级：直接调 `handleEditorDiagnosticsGet`（假 ctx + 假 send + 临时目录 + **用模块自己的 compactWrite 造捕获**）
 *   —— 含三条反证：0 字段段带 offset 必须报错、长度算式对不上必须报错、归档读不到必须说"未知"而不是"未归档"。
 *
 * 用法：`node _selftest-editor-nav.mjs`
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
let pass = 0
let fail = 0
async function check(name, fn) {
  try {
    await fn()
    pass++
    console.log('[PASS] ' + name)
  } catch (error) {
    fail++
    console.log('[FAIL] ' + name + ' :: ' + ((error && error.message) || error))
  }
}

// ---------- 客户端纯函数（假 window.__ModuleLoader__ 接住 factory） ----------
const clientSrc = readFileSync(path.join(here, 'lib', 'client.js'), 'utf8')
const win = { __ModuleLoader__: { load(def) { win.__def = def } } }
globalThis.window = win
const noopReact = {
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useRef: (v) => ({ current: v }), useEffect: () => {}, useLayoutEffect: () => {},
  useCallback: (fn) => fn, useMemo: (fn) => fn(), createElement: () => null,
}
;(0, eval)(clientSrc)
const nav = win.__def.factory(() => noopReact).__editorNav
assert.ok(nav && typeof nav.readHashLink === 'function', '缺 exports.__editorNav')

// ---------- 服务半侧：真模块 + 假 ctx/send ----------
const sc = await import('file://' + path.join(here, 'lib', 'sections-capture.js').replace(/\\/g, '/'))
const DSH_MSG = 'corrupt session log: seq gap in committed region at line 662 (expected 13596, got 13594)'
function fakeCtx(readSession) {
  return { get: (name) => (name === 'sessionQuery' ? { readSession } : undefined) }
}
function callDiag({ ctx, url, options }) {
  let out = null
  const send = (status, payload) => { out = { status, payload } }
  return sc.handleEditorDiagnosticsGet(ctx || fakeCtx(async () => ({ events: [] })), url, send, (m) => m, null, options || {})
    .then(() => out)
}
const codesOf = (payload) => (payload.diagnostics || []).map((d) => d.code)
const diagOf = (payload, code) => (payload.diagnostics || []).find((d) => d.code === code)

await check('★1 readHashLink：只认 sess/turn/box/sec，其余忽略；坏的 turn/box 不当真', () => {
  const l = nav.readHashLink('#sess=session-abc&turn=3&box=system&sec=harness:identity')
  assert.deepEqual(l, { sess: 'session-abc', turn: 3, box: 'system', sec: 'harness:identity' })
  assert.deepEqual(nav.readHashLink('#turn=0'), {}, 'turn=0 不是合法楼号')
  assert.deepEqual(nav.readHashLink('#turn=abc'), {}, '非数字楼号必须忽略')
  assert.deepEqual(nav.readHashLink('#box=whatever'), {}, 'box 只认 system/tools/messages')
  assert.deepEqual(nav.readHashLink('#evil=<script>'), {}, '未知键一律忽略')
  assert.deepEqual(nav.readHashLink(''), {})
  assert.deepEqual(nav.readHashLink(undefined), {})
})
await check('★2 formatHashLink：键序稳定、空状态给空串（⛔ 不留裸 #）', () => {
  assert.equal(nav.formatHashLink({ sess: 's', turn: 2, box: 'tools', sec: 'tool:pwsh' }), '#sess=s&turn=2&box=tools&sec=tool%3Apwsh')
  assert.equal(nav.formatHashLink({ turn: 2, sess: 's' }), '#sess=s&turn=2', '键序必须稳定（先 sess）')
  assert.equal(nav.formatHashLink({}), '')
  assert.equal(nav.formatHashLink(null), '')
})
await check('★3 深链往返自洽：read(format(x)) 与 x 等价（截断到已知键）', () => {
  const x = { sess: 'session-1', turn: 7, box: 'messages', sec: 'some:name' }
  assert.deepEqual(nav.readHashLink(nav.formatHashLink(x)), x)
  const y = { sess: 'session-2' }
  assert.deepEqual(nav.readHashLink(nav.formatHashLink(y)), y)
})
await check('★3b sectionNameOf：地图块（key=sec:<名>）能取回段名；取不到给空串（⛔ 不编）', () => {
  assert.equal(nav.sectionNameOf({ key: 'sec:harness:identity', label: 'harness:identity' }), 'harness:identity')
  assert.equal(nav.sectionNameOf({ name: 'a:b' }), 'a:b')
  assert.equal(nav.sectionNameOf({ key: 'tool:pwsh', label: 'tool:pwsh' }), 'tool:pwsh', '非 sec: 前缀的块用 label 兜底')
  assert.equal(nav.sectionNameOf({ key: 'tool:pwsh' }), '', '只有 key 没有 label/name 时如实给空串（⛔ 不编）')
  assert.equal(nav.sectionNameOf(null), '')
  assert.equal(nav.sectionNameOf({}), '')
})
await check('★4 事实说明书：≥6 节且每节有标题+正文；四条关键判据必须讲到', () => {  const secs = nav.editorHelpSections()
  assert.ok(Array.isArray(secs) && secs.length >= 6, '节数太少：' + secs.length)
  for (const s of secs) {
    assert.ok(typeof s.title === 'string' && s.title !== '', '缺标题')
    assert.ok(Array.isArray(s.lines) && s.lines.length > 0, '节没有正文：' + s.title)
  }
  const all = secs.map((s) => s.lines.join('\n')).join('\n')
  assert.ok(all.includes('Σ(非空段字数) + 2×(非空段数−1)'), '没讲字数口径算式')
  assert.ok(all.includes('contexts') || all.includes('上下文'), '没讲上下文不在 system 里')
  assert.ok(all.includes('≠ 不存在'), '没讲「未检出 ≠ 不存在」')
  assert.ok(all.includes('DSH 自己的') && all.includes('与本插件无关'), '没讲日志读不了是谁的锅')
  assert.ok(all.includes('offset'), '没讲旧楼为什么取不到正文')
  assert.ok(all.includes('#sess='), '没告诉用户深链怎么用')
})
await check('★5 summarizeDiagnostics：健康/坏形状 ⇒ 空；正常 ⇒ 按严重度排序 + counts + 证据进 tooltip', () => {
  assert.deepEqual(nav.summarizeDiagnostics(null).chips, [])
  assert.deepEqual(nav.summarizeDiagnostics({ ok: false }).chips, [])
  const resp = {
    ok: true,
    diagnostics: [
      { code: 'archived', severity: 'info', evidence: { source: 'x' }, supportedFixes: [] },
      { code: 'no-capture-record', severity: 'warn', evidence: { reason: 'no-capture-record' }, supportedFixes: ['捕获只对新回合生效'] },
      { code: 'log-unreadable', severity: 'error', evidence: { message: DSH_MSG, detail: { line: 662, expected: 13596, got: 13594 } }, supportedFixes: ['换一条会话'] },
    ],
  }
  const s = nav.summarizeDiagnostics(resp)
  assert.equal(s.ok, true)
  assert.deepEqual(s.counts, { error: 1, warn: 1, info: 1 })
  assert.deepEqual(s.chips.map((c) => c.code), ['log-unreadable', 'no-capture-record', 'archived'], '必须 error → warn → info')
  assert.ok(s.chips[0].text.startsWith('✖'), 'error 要有记号：' + s.chips[0].text)
  assert.ok(s.chips[0].tip.includes('第 662 行'), 'tooltip 必须带测量证据：' + s.chips[0].tip)
  assert.ok(s.chips[1].tip.includes('可做的事：'), 'tooltip 必须带修法：' + s.chips[1].tip)
})

// ---------- 诊断端点（行为级） ----------
await check('★6 诊断：日志读不了 ⇒ log-unreadable(error) 且带 detail 行号/seq（不许只说"读不了"）', async () => {
  const r = await callDiag({ ctx: fakeCtx(async () => { throw new Error(DSH_MSG) }), url: '/?sessionId=bad-1' })
  assert.equal(r.status, 200)
  const d = diagOf(r.payload, 'log-unreadable')
  assert.ok(d, '缺 log-unreadable：' + codesOf(r.payload).join(','))
  assert.equal(d.severity, 'error')
  assert.deepEqual(d.evidence.detail, { line: 662, expected: 13596, got: 13594 })
  assert.ok(Array.isArray(d.supportedFixes) && d.supportedFixes.length > 0, '必须给"可做的事"')
})
await check('★7 诊断：没捕获 ⇒ no-capture-record(warn)，且说明"旧楼不会自动补"', async () => {
  const dir = mkdtempSync(path.join(here, '_editor-nav-'))
  try {
    const r = await callDiag({ url: '/?sessionId=none-1', options: { dir } })
    const d = diagOf(r.payload, 'no-capture-record')
    assert.ok(d, '缺 no-capture-record：' + codesOf(r.payload).join(','))
    assert.equal(d.severity, 'warn')
    assert.ok(d.supportedFixes.join('').includes('不会自动补'), '修法口径必须写清不会自动补')
  } finally { try { rmSync(dir, { recursive: true, force: true }) } catch {} }
})
await check('★8 诊断：完整捕获（offset+凭据齐、0 字段段 offset=null）⇒ 不报错也不报缺', async () => {
  const dir = mkdtempSync(path.join(here, '_editor-nav-'))
  try {
    const rendered = 'a'.repeat(10) + '\n\n' + 'b'.repeat(4)   // 10 + 2(分隔) + 4 = 16 —— 与逐段算式必须相等
    sc.compactWrite(path.join(dir, 'ok-1.jsonl'), [{
      turn: 1, capturedAt: new Date().toISOString(), agentId: 'ok-1',
      sections: [
        { name: 'a', order: -1000, chars: 10, offset: 0, hash: 'h1', mutability: 'static', mutabilityBasis: 'definition', renderedChars: rendered.length, renderedHash: 'rh' },
        { name: 'empty', order: 500, chars: 0, offset: null, hash: 'h2', mutability: 'per-turn', mutabilityBasis: 'definition', renderedChars: rendered.length, renderedHash: 'rh' },
        { name: 'b', order: 10, chars: 4, offset: 12, hash: 'h3', mutability: 'static', mutabilityBasis: 'definition', renderedChars: rendered.length, renderedHash: 'rh' },
      ],
      contexts: [{ name: 'sandbox:policy', chars: 3 }],
      tools: [{ name: 'pwsh', chars: 100 }],
    }], 200)
    const r = await callDiag({ url: '/?sessionId=ok-1&turn=1', options: { dir } })
    assert.deepEqual(codesOf(r.payload).filter((c) => c === 'offset-missing' || c === 'credentials-missing' || c === 'offset-on-empty-section'), [], '健康捕获不该报这些：' + codesOf(r.payload).join(','))
    assert.equal(r.payload.counts.error, 0, '健康捕获不该有 error：' + JSON.stringify(r.payload.diagnostics))
  } finally { try { rmSync(dir, { recursive: true, force: true }) } catch {} }
})
await check('★9 反证A：0 字段的段带了 offset ⇒ offset-on-empty-section(error)（契约不许破）', async () => {
  const dir = mkdtempSync(path.join(here, '_editor-nav-'))
  try {
    sc.compactWrite(path.join(dir, 'bad-offset.jsonl'), [{
      turn: 1, capturedAt: new Date().toISOString(), agentId: 'bad-offset',
      sections: [
        { name: 'a', order: 0, chars: 5, offset: 0, hash: 'h', mutability: 'static', mutabilityBasis: 'definition', renderedChars: 5, renderedHash: 'rh' },
        { name: 'empty', order: 500, chars: 0, offset: 0, hash: 'h2', mutability: 'static', mutabilityBasis: 'definition', renderedChars: 5, renderedHash: 'rh' },
      ],
    }], 200)
    const r = await callDiag({ url: '/?sessionId=bad-offset&turn=1', options: { dir } })
    const d = diagOf(r.payload, 'offset-on-empty-section')
    assert.ok(d, '必须抓住：' + codesOf(r.payload).join(','))
    assert.equal(d.severity, 'error')
    assert.ok(d.evidence.rule.includes('必须是 null'), '证据里要写清规则')
  } finally { try { rmSync(dir, { recursive: true, force: true }) } catch {} }
})
await check('★10 反证B：长度算式与记录对不上 ⇒ length-arithmetic-mismatch(error)', async () => {
  const dir = mkdtempSync(path.join(here, '_editor-nav-'))
  try {
    sc.compactWrite(path.join(dir, 'bad-len.jsonl'), [{
      turn: 1, capturedAt: new Date().toISOString(), agentId: 'bad-len',
      sections: [
        { name: 'a', order: 0, chars: 5, offset: 0, hash: 'h', mutability: 'static', mutabilityBasis: 'definition', renderedChars: 999, renderedHash: 'rh' },
        { name: 'b', order: 10, chars: 4, offset: 7, hash: 'h2', mutability: 'static', mutabilityBasis: 'definition', renderedChars: 999, renderedHash: 'rh' },
      ],
    }], 200)
    const r = await callDiag({ url: '/?sessionId=bad-len&turn=1', options: { dir } })
    const d = diagOf(r.payload, 'length-arithmetic-mismatch')
    assert.ok(d, '必须抓住：' + codesOf(r.payload).join(','))
    assert.equal(d.evidence.expectedBySections, 11, '5+4+2×(2−1)=11')
    assert.equal(d.evidence.recordedRenderedChars, 999)
  } finally { try { rmSync(dir, { recursive: true, force: true }) } catch {} }
})
await check('★11 反证C：归档读不到 ⇒ archive-unknown(info)，⛔ 不许冒充"未归档"；注册表说归档 ⇒ archived(info)', async () => {
  const noProv = await callDiag({ url: '/?sessionId=s-1' })
  assert.ok(diagOf(noProv.payload, 'archive-unknown'), '没注入 provider 必须说未知')
  const badProv = await callDiag({ url: '/?sessionId=s-1', options: { archivedProvider: () => ({ known: false }) } })
  assert.ok(diagOf(badProv.payload, 'archive-unknown'), '形状不对也必须说未知')
  const yes = await callDiag({ url: '/?sessionId=s-1', options: { archivedProvider: () => ({ known: true, ids: ['s-1'] }) } })
  const d = diagOf(yes.payload, 'archived')
  assert.ok(d && d.severity === 'info', '注册表说归档 ⇒ info')
  assert.equal(diagOf(yes.payload, 'archive-unknown'), undefined, '已知时不该再说未知')
})
await check('★12 缺 sessionId ⇒ 400 bad-request（参数错是客户端的事，不是 200）', async () => {
  const r = await callDiag({ url: '/?turn=1' })
  assert.equal(r.status, 400)
  assert.equal(r.payload.error.code, 'bad-request')
})
await check('★13 反证D：「会话不存在」不许报成「日志读不了」（假指控）', async () => {
  const r = await callDiag({ ctx: fakeCtx(async () => { throw new Error('session "nope-1" not found') }), url: '/?sessionId=nope-1' })
  assert.ok(diagOf(r.payload, 'session-not-found'), '必须给专门的码：' + codesOf(r.payload).join(','))
  assert.equal(diagOf(r.payload, 'log-unreadable'), undefined, '⛔ 不许把"不存在"说成"读不了"')
})

// ---------- 单条工具定义出口 + messages 的 sourceKind（M10，行为级：真 createHandler + 假 source + 真 HTTP） ----------
const http = await import('node:http')
function pvSource(conv) {
  return {
    scanIndex: () => [], listSessions: async () => [], resolveSessions: async () => [],
    sessionDetail: async () => ({ row: { id: 's-1' }, parsed: { title: 't', meta: {}, requests: [], conversation: conv } }),
    forget: () => {},
  }
}
async function withPvServer(source, fn) {
  const { createHandler } = await import('file://' + path.join(here, 'lib', 'prompt-viewer.js').replace(/\\/g, '/'))
  const handler = createHandler({ sessionsRoot: here, webPath: '/pv' }, source)
  const server = http.createServer((req, res) => { Promise.resolve(handler(req, res)).catch(() => {}) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  // ⚠ 用 http.get + agent:false 而不是 fetch：本机 Node 24 在**退出回收** undici 的保活连接时会
  //   触发 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`（0xC0000409）—— 断言全绿但 exit≠0，
  //   会把整台自检台误报成失败（README §四.4 记的同一类"本机 Node 助手不可信"）。
  const getJson = (port, p) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, agent: false }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => { try { resolve(JSON.parse(body)) } catch (e) { reject(e) } })
    })
    req.on('error', reject)
  })
  try {
    const port = server.address().port
    return await fn(async (p) => getJson(port, p))
  } finally { await new Promise((r) => server.close(r)) }
}
const TOOL_ENTRY = { name: 'state_seed', description: '把状态种子写进世界', parameters: { type: 'object', properties: { id: { type: 'string' } } } }
// 夹具照解析器真实形状：清单 `tools:[{name,chars}]`（省内存）+ 原文 `rawTools`（点开看实际文本用）
const convWithTools = (tools, rawTools, rawToolsChars) => ({
  turns: [{ turn: 1, startSeq: 1, endSeq: 90, open: false }],
  rows: [],
  headers: [{
    seq: 50, system: 'S',
    tools: tools.map((t) => ({ name: String(t.name), chars: JSON.stringify(t).length })),
    rawTools: rawTools === undefined ? tools : rawTools,
    rawToolsChars: rawToolsChars === undefined ? JSON.stringify(tools).length : rawToolsChars,
  }],
  headerAvailable: true,
})

await check('★14 /api/tool：只交被点开的那一条（原样 JSON），并说明来源是自带 header 还是沿用上一楼', async () => {
  const tools = [TOOL_ENTRY, { name: 'pwsh', description: 'x', parameters: {} }]
  await withPvServer(pvSource(convWithTools(tools)), async (get) => {
    const j = await get('/pv/api/tool?id=s-1&turn=1&name=state_seed')
    assert.equal(j.ok, true, JSON.stringify(j).slice(0, 200))
    assert.equal(j.name, 'state_seed')
    assert.equal(j.requestLogged, true, '该楼自带 header ⇒ requestLogged:true')
    assert.deepEqual(JSON.parse(j.text), TOOL_ENTRY, '必须是**原样**那一条（不裁剪、不改字段名）')
    assert.equal(j.chars, j.text.length)
    assert.equal(j.text.includes('pwsh'), false, '⛔ 不许把整份工具表也带出来')
  })
})
await check('★15 反证A：该楼没有这个工具名 ⇒ no-such-tool（不是空文本、不是 ok:true）', async () => {
  await withPvServer(pvSource(convWithTools([TOOL_ENTRY])), async (get) => {
    const j = await get('/pv/api/tool?id=s-1&turn=1&name=nope')
    assert.equal(j.ok, false)
    assert.equal(j.error.code, 'no-such-tool')
    assert.ok(String(j.error.message).includes('该楼共 1 个'), '要给出该楼实际有几个：' + j.error.message)
  })
})
await check('★15b 反证A2：原文超上限 ⇒ tool-text-omitted（⛔ 不许截断冒充全文；清单仍在）', async () => {
  await withPvServer(pvSource(convWithTools([TOOL_ENTRY], null, 300000)), async (get) => {
    const j = await get('/pv/api/tool?id=s-1&turn=1&name=state_seed')
    assert.equal(j.ok, false)
    assert.equal(j.error.code, 'tool-text-omitted')
    assert.ok(String(j.error.message).includes('200000'), '必须写明上限：' + j.error.message)
    const inv = await get('/pv/api/part?id=s-1&turn=1&part=tools')
    assert.equal(inv.ok, true, '清单出口不受影响')
    assert.equal(inv.tools.length, 1)
  })
})
await check('★16 反证B：日志读不了 ⇒ /api/tool 也走 session-parse-failed（⛔ 不许折成"没有工具"）', async () => {  const bad = {
    scanIndex: () => [], listSessions: async () => [], resolveSessions: async () => [],
    sessionDetail: async () => { throw new Error(DSH_MSG) }, forget: () => {},
  }
  await withPvServer(bad, async (get) => {
    const j = await get('/pv/api/tool?id=bad-1&turn=1&name=state_seed')
    assert.equal(j.ok, false)
    assert.equal(j.error.code, 'session-parse-failed')
    assert.deepEqual(j.error.detail, { line: 662, expected: 13596, got: 13594 })
  })
})
await check('★17 messages 出口带 sourceKind/playerTyped 与分开的计数（玩家/注入/未知；⛔ 拿不到 kind 不许当玩家）', async () => {
  const conv = Object.assign(convWithTools([]), {
    rows: [
      { seq: 10, time: 1, role: 'user', text: '我发的', chars: 3, sourceKind: 'user', isToolResult: false, isCompacted: false, turn: 1 },
      { seq: 11, time: 2, role: 'user', text: 'Current runtime context.', chars: 24, sourceKind: 'plugin', isToolResult: false, isCompacted: false, turn: 1 },
      { seq: 12, time: 3, role: 'user', text: '技能目录', chars: 4, sourceKind: 'skill-catalog', isToolResult: false, isCompacted: false, turn: 1 },
      { seq: 13, time: 4, role: 'user', text: '来源不明', chars: 4, sourceKind: null, isToolResult: false, isCompacted: false, turn: 1 },
      { seq: 14, time: 5, role: 'assistant', text: '好的', chars: 2, sourceKind: null, isToolResult: false, isCompacted: false, turn: 1 },
    ],
  })
  await withPvServer(pvSource(conv), async (get) => {
    const j = await get('/pv/api/messages?id=s-1')
    assert.deepEqual(j.counts, { player: 1, injected: 2, unknownUser: 1, assistant: 1, tool: 0, compacted: 0 })
    const bySeq = new Map(j.messages.map((m) => [m.seq, m]))
    assert.equal(bySeq.get(10).playerTyped, true)
    assert.equal(bySeq.get(11).playerTyped, false)
    assert.equal(bySeq.get(11).sourceKind, 'plugin')
    assert.equal(bySeq.get(13).playerTyped, false, '⚠ 拿不到 kind 的行**不许**被当成"玩家发的"')
    assert.equal(bySeq.get(13).sourceKind, null)
  })
})

await check('★18 导出注册表（M15）：带顺序的字段清单 —— 按 order 升序、三块分开、未知如实、含正文可选', () => {
  const cap = {
    ok: true, source: 'captured', turn: 7,
    sections: [
      { name: 'ui:deliverable-file-references', order: 9000, chars: 299, offset: 1647, mutability: 'static', mutabilityBasis: 'definition' },
      { name: 'harness:identity', order: -1000, chars: 48, offset: 0, mutability: 'static', mutabilityBasis: 'definition' },
      { name: 'pmp-dsh-tavern:profile', order: 10, chars: 0, offset: null, mutability: 'per-turn', mutabilityBasis: 'definition' },
      { name: 'no-order:field', order: null, chars: 5, offset: null, mutability: 'unknown', mutabilityBasis: 'unknown' },
    ],
    contexts: [{ name: 'sandbox:policy', chars: 233 }, { name: 'approval:policy', chars: 153 }],
    tools: [{ name: 'pwsh', chars: 4419 }, { name: 'read', chars: 156 }],
  }
  const list = nav.buildRegistryText(cap, { sessionId: 'session-xyz', turn: 7 })
  const iId = list.indexOf('`harness:identity`')
  const iProf = list.indexOf('`pmp-dsh-tavern:profile`')
  const iUi = list.indexOf('`ui:deliverable-file-references`')
  const iNo = list.indexOf('`no-order:field`')
  assert.ok(iId > 0 && iProf > iId && iUi > iProf && iNo > iUi, '段没按 order 升序：' + [iId, iProf, iUi, iNo].join(','))
  assert.ok(list.includes('| 未知 | `no-order:field` | 5 | 未知 | 未知 | 未知 |'), '拿不到 order/可变性时必须如实写「未知」')
  assert.ok(list.includes('## 一 system 段（按注入顺序）') && list.includes('## 二 运行上下文') && list.includes('## 三 工具定义'), '三块标题缺失')
  assert.ok(list.includes('| `sandbox:policy` | 233 |'), '上下文行缺失')
  assert.ok(list.includes('| `pwsh` | 4419 |'), '工具行缺失')
  assert.ok(list.includes('粘给 AI') && list.includes('注入顺序'), '缺「喂给 AI / 顺序口径」的提示')
  const withText = nav.buildRegistryText(cap, {
    sessionId: 'session-xyz', turn: 7,
    texts: new Map([['harness:identity', 'You are an AI agent.']]),
  })
  assert.ok(withText.includes('## 四 各段正文'), '含正文时缺第四节')
  assert.ok(withText.includes('```text\nYou are an AI agent.\n```'), '正文没写进导出')
  assert.ok(withText.includes('取不到正文') && withText.includes('不编'), '取不到的段必须如实标注')
})

console.log(`\n== 汇总：${pass} 通过 / ${fail} 失败 ==`)
process.exit(fail === 0 ? 0 : 1)
