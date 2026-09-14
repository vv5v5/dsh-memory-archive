#!/usr/bin/env node
/**
 * dsh-memory-archive · 轮次数据面自检（20260913 A 单）
 * 用法：node _selftest-turns.mjs
 *
 * 覆盖契约 C1（GET /api/turns）与 C3 语义修正（part=messages 按轮次）：
 *   1. ★★轮次锚点 = turn/start / turn/end：静态会话（只 1 条 request/header）真跑 3 楼
 *      ⇒ turns.length===3、latest===3（排查文档 §0.1 的沙箱实测形状：seq=14/519/1187 → 517/1184/1392）
 *   2. ★第 2/3 楼 requestLogged:false + headerCarried:true + systemChars 照取（carry-forward）
 *   3. ★反证 1：把锚点改回"数 request/header" ⇒ 只会得到 1 ⇒ 第 1 条断言必须红
 *   4. ★part=messages 按轮次：turn=1 与 turn=2 的 text 不同，且第 3 楼包含第 2 楼内容（单调增长）
 *   5. ★反证 2：会话级全文（旧 messagesText 语义，任何楼都一样）≠ 第 2 楼文本 ⇒ 旧实现必须红
 *   6. ★无任何 request/header 的会话：headerAvailable:false、systemChars/toolCount 为 null（不猜）、
 *      part=system 如实 ok:false
 *   7. ★解析失败形状（W0 增量 1）：ok:false + error.code='session-parse-failed' + turns:[] + latest:0
 *      —— 与 0 楼可区分（徽标显「失败」，不许折成 0）
 *   8. 响应形状逐字段核对（seqRange/startedAt/messageCount/turn 等）
 *   9. part=system 的 carried 楼带 mutabilityBasis:'header-equal'（W0 增量 5）
 * 全程走 createHandler 注入假 source + 真 HTTP（node:http + fetch）——不是纯函数自检。
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const pv = await import(pathToFileURL(path.join(here, 'lib', 'prompt-viewer.js')))

let pass = 0
const fails = []
async function check(name, fn) {
  try {
    await fn()
    pass++
    console.log('[PASS] ' + name)
  } catch (error) {
    fails.push(name)
    console.log('[FAIL] ' + name + ' :: ' + String((error && error.message) || error))
  }
}

// ---------- 假事件（字段形状照 harness core/session/src/types.ts；数值照排查 §0.1 沙箱实测） ----------
const SYSTEM_TEXT = 'S'.repeat(1946) // 静态会话：system 1946 字符
function ev(type, seq, time, data) { return { type, seq, time, data } }
/** 静态会话：1 条 header（seq=20 initial）+ 3 对轮次边界 + 各楼消息。 */
function staticSessionEvents() {
  return [
    ev('turn/start', 14, 1000, { turn: 1 }),
    ev('request/header', 20, 1010, { header: { system: SYSTEM_TEXT, tools: [], config: { provider: 'deepseek', model: 'dsh' } }, reason: 'initial' }),
    ev('user/message', 22, 1020, { content: '开始吧' }),
    ev('assistant/message', 30, 1030, { message: { content: '好的' } }),
    ev('user/message', 34, 1040, { content: '继续' }),
    ev('turn/end', 517, 1050, { turn: 1, reason: { kind: 'completed' } }),
    ev('turn/start', 519, 2000, { turn: 2 }),
    ev('user/message', 521, 2010, { content: '第二楼的问题' }),
    ev('assistant/message', 1180, 2020, { message: { content: '第二楼的回答' } }),
    ev('turn/end', 1184, 2030, { turn: 2, reason: { kind: 'completed' } }),
    ev('turn/start', 1187, 3000, { turn: 3 }),
    ev('user/message', 1189, 3010, { content: '第三楼的问题' }),
    ev('assistant/message', 1390, 3020, { message: { content: '第三楼的回答' } }),
    ev('turn/end', 1392, 3030, { turn: 3, reason: { kind: 'completed' } }),
  ]
}

/** 把假事件折成假 source（sessionDetail 直接返回 parsed；形状与真解析一致）。 */
function fakeSource(eventsById) {
  return {
    sessionDetail: async (id) => {
      if (!(id in eventsById)) return null
      const make = eventsById[id]
      if (make === 'THROW') throw new Error('zstd 解不开（模拟坏文件）')
      const conversation = pv.buildConversation(make())
      return { row: { id, workspace: 'ws', path: `x/${id}`, sizeBytes: 1, mtimeMs: 1 }, parsed: { meta: {}, title: 't', requests: [], conversation } }
    },
    forget() {},
    async stop() {},
  }
}

async function withServer(source, fn) {
  const handler = pv.createHandler({}, source)
  const server = http.createServer(handler)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}/dsh-memory-archive/prompt`
  try {
    return await fn(base)
  } finally {
    await new Promise((r) => server.close(r))
  }
}
async function getJson(base, p) {
  const res = await fetch(base + p)
  return { status: res.status, body: await res.json() }
}

// ---------- 1–3：静态会话 3 楼 + carry-forward ----------
await check('C1 静态会话（1 条 header）turns.length===3、latest===3', async () => {
  await withServer(fakeSource({ s: staticSessionEvents }), async (base) => {
    const { body } = await getJson(base, '/api/turns?id=s')
    assert.equal(body.ok, true)
    assert.equal(body.sessionId, 's')
    assert.equal(body.turns.length, 3)
    assert.equal(body.latest, 3)
  })
})
await check('第 1 楼 requestLogged:true、第 2/3 楼 requestLogged:false + headerCarried:true + systemChars 1946', async () => {
  await withServer(fakeSource({ s: staticSessionEvents }), async (base) => {
    const { body } = await getJson(base, '/api/turns?id=s')
    const [t1, t2, t3] = body.turns
    assert.equal(t1.requestLogged, true)
    assert.equal(t1.headerCarried, false)
    assert.equal(t1.systemChars, 1946)
    assert.equal(t1.toolCount, 0)
    for (const t of [t2, t3]) {
      assert.equal(t.requestLogged, false, `第 ${t.turn} 楼应未记 header`)
      assert.equal(t.headerCarried, true, `第 ${t.turn} 楼应 carry-forward`)
      assert.equal(t.systemChars, 1946, `第 ${t.turn} 楼 system 应照取上一条`)
      assert.equal(t.toolCount, 0)
    }
  })
})
await check('★反证 1：数 request/header 的旧锚点只会得 1 ⇒ turns.length===3 的断言必红', async () => {
  const events = staticSessionEvents()
  const headerCount = events.filter((e) => e.type === 'request/header').length
  const conv = pv.buildConversation(events)
  assert.equal(headerCount, 1, '旧锚点给 1（或重启次数），不是 3')
  assert.equal(conv.turns.length, 3)
  assert.notEqual(headerCount, conv.turns.length, '若两者相等，反证不成立')
})
await check('seqRange / startedAt / messageCount 形状', async () => {
  await withServer(fakeSource({ s: staticSessionEvents }), async (base) => {
    const { body } = await getJson(base, '/api/turns?id=s')
    assert.deepEqual(body.turns[0].seqRange, [14, 517])
    assert.deepEqual(body.turns[2].seqRange, [1187, 1392])
    assert.equal(body.turns[0].startedAt, new Date(1000).toISOString())
    assert.equal(body.turns[0].endedAt, new Date(1050).toISOString())
    assert.equal(body.turns[0].messageCount, 3)
    assert.equal(body.turns[1].messageCount, 2)
    assert.equal(body.turns[0].turn, 1)
  })
})

// ---------- 4–5：part=messages 按轮次 ----------
await check('C3 part=messages：turn=1 与 turn=2 不同，第 3 楼包含第 2 楼内容（单调增长）', async () => {
  await withServer(fakeSource({ s: staticSessionEvents }), async (base) => {
    const p = async (n) => (await getJson(base, `/api/part?id=s&turn=${n}&part=messages`)).body
    const m1 = await p(1)
    const m2 = await p(2)
    const m3 = await p(3)
    assert.equal(m1.ok, true)
    assert.notEqual(m1.text, m2.text, '两楼文本不同')
    assert.ok(m3.text.includes(m2.text), '第 3 楼包含第 2 楼内容')
    assert.ok(m3.count > m2.count && m2.count > m1.count, `行数单调增长：${m1.count} < ${m2.count} < ${m3.count}`)
    assert.ok(m2.text.includes('第二楼的问题'))
    assert.ok(!m1.text.includes('第二楼的问题'), '第 1 楼不含第 2 楼的新消息')
  })
})
await check('★反证 2：会话级全文（旧 messagesText 语义）对任何楼都一样 ⇒ turn1≠turn2 断言必红', async () => {
  const conv = pv.buildConversation(staticSessionEvents())
  const sessionLevel = conv.rows.map((r) => `── [seq ${r.seq}] ${r.role} ──\n${r.text}`).join('\n\n')
  const t1 = conv.rows.filter((r) => r.seq <= 517)
  const t2 = conv.rows.filter((r) => r.seq <= 1184)
  const oldStyle1 = t1.map((r) => `── [seq ${r.seq}] ${r.role} ──\n${r.text}`).join('\n\n')
  // 旧实现返回的是 sessionLevel（与 turn 无关）：它会让 turn1 与 turn2 相等。
  assert.equal(sessionLevel, sessionLevel)
  assert.notEqual(sessionLevel, oldStyle1, '若会话级全文等于单楼文本，说明按轮次没生效')
})

// ---------- 6：无 header 会话（W0 增量 3） ----------
await check('无 request/header：headerAvailable:false、systemChars/toolCount null（不猜）、part=system ok:false', async () => {
  const noHeader = () => [
    ev('turn/start', 1, 1000, { turn: 1 }),
    ev('user/message', 2, 1010, { content: 'hi' }),
    ev('turn/end', 3, 1020, { turn: 1, reason: { kind: 'completed' } }),
  ]
  await withServer(fakeSource({ s: noHeader }), async (base) => {
    const { body } = await getJson(base, '/api/turns?id=s')
    assert.equal(body.headerAvailable, false)
    assert.equal(body.turns.length, 1)
    assert.equal(body.turns[0].requestLogged, false)
    assert.equal(body.turns[0].headerCarried, false)
    assert.equal(body.turns[0].systemChars, null)
    assert.equal(body.turns[0].toolCount, null)
    const part = await getJson(base, '/api/part?id=s&turn=1&part=system')
    assert.equal(part.body.ok, false, '不猜：没有 header 就是没有')
  })
})
await check('有 header 时响应不出现 headerAvailable 字段（缺省即 true，W0 约定）', async () => {
  await withServer(fakeSource({ s: staticSessionEvents }), async (base) => {
    const { body } = await getJson(base, '/api/turns?id=s')
    assert.equal('headerAvailable' in body, false)
  })
})

// ---------- 7：解析失败形状（W0 增量 1） ----------
await check('解析失败：ok:false + error.code=session-parse-failed + turns:[]/latest:0（与 0 楼可区分）', async () => {
  await withServer(fakeSource({ bad: 'THROW', empty: () => [] }), async (base) => {
    const { body } = await getJson(base, '/api/turns?id=bad')
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'session-parse-failed')
    assert.deepEqual(body.turns, [])
    assert.equal(body.latest, 0)
    // 对比：真 0 楼（空会话可解析）是 ok:true + turns:[]，两者必须可区分。
    const zero = await getJson(base, '/api/turns?id=empty')
    assert.equal(zero.body.ok, true)
    assert.deepEqual(zero.body.turns, [])
    assert.equal(zero.body.latest, 0)
    assert.notEqual(body.ok, zero.body.ok)
  })
})

// ---------- 8–9：part=system 的 carried 楼字段（W0 增量 5） ----------
await check("part=system carried 楼：mutabilityBasis:'header-equal' + sessionId/turn/chars", async () => {
  await withServer(fakeSource({ s: staticSessionEvents }), async (base) => {
    const { body } = await getJson(base, '/api/part?id=s&turn=2&part=system')
    assert.equal(body.ok, true)
    assert.equal(body.sessionId, 's')
    assert.equal(body.turn, 2)
    assert.equal(body.requestLogged, false)
    assert.equal(body.headerCarried, true)
    assert.equal(body.mutabilityBasis, 'header-equal')
    assert.equal(body.chars, 1946)
    assert.equal(body.text.length, 1946)
  })
})

console.log(`\nsummary: ${pass} passed, ${fails.length} failed :: _selftest-turns`)
if (fails.length > 0) {
  console.log('failed: ' + fails.join(' | '))
  process.exitCode = 1
}
