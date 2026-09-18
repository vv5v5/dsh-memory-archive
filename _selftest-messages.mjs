#!/usr/bin/env node
/**
 * dsh-memory-archive · 消息数据面自检（20260913 A 单）
 * 用法：node _selftest-messages.mjs
 *
 * 覆盖契约 C2（GET /api/messages）与 part=messages 的行形状：
 *   1. ★分页：默认返回最后 N 条（自动定位最新楼）；from/limit 显式分页时 index 保持全表绝对下标
 *   2. ★行形状：index/seq/turn/role/preview/chars/isToolResult/isCompacted 逐字段
 *   3. ★preview 只放首行截断（⛔ 不把全文塞进列表）；chars 是全文长度
 *   4. ★特殊行：tool/result → role:'tool' + isToolResult:true；compaction/summary → isCompacted:true，
 *      且被它 shadowedSeqs 遮蔽的旧行不再出现（被压缩的行已不在模型历史里，不冒充"真实行"）
 *   5. turn = 行 seq 所在楼的楼号（楼外且在首楼之前 → 归第 1 楼；无楼 → 0）
 *   6. 空会话：total:0、messages:[]、latestIndex:null（W0 增量 2）
 *   7. 解析失败形状（W0 增量 1）：ok:false + error.code='session-parse-failed'，与空会话可区分
 *   8. part=messages 响应带 count + messages 行数组（W0 增量 5 的补充字段）
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

function ev(type, seq, time, data) { return { type, seq, time, data } }

/** 3 楼 10 行 + 1 次压缩：压缩摘要遮蔽第 1 楼的两行。 */
function messyEvents() {
  return [
    ev('turn/start', 10, 1000, { turn: 1 }),
    ev('user/message', 11, 1010, { content: '第一条\n第二行不该出现在 preview' }),
    ev('assistant/message', 12, 1020, { message: { content: '回答一' } }),
    ev('user/message', 13, 1030, { content: '会被压缩掉的消息一' }),
    ev('assistant/message', 14, 1040, { message: { content: '会被压缩掉的回答二' } }),
    ev('turn/end', 15, 1050, { turn: 1, reason: { kind: 'completed' } }),
    ev('turn/start', 20, 2000, { turn: 2 }),
    ev('user/message', 21, 2010, { content: '二楼问题' }),
    ev('assistant/message', 22, 2020, { message: { content: '二楼回答' } }),
    ev('tool/result', 23, 2030, { message: { content: '工具结果：ok' } }),
    ev('compaction/summary', 24, 2040, { summary: '[压缩摘要] 前情提要', shadowedSeqs: [13, 14] }),
    ev('assistant/message', 25, 2050, { message: { content: '收尾' } }),
    ev('turn/end', 26, 2060, { turn: 2, reason: { kind: 'completed' } }),
    ev('turn/start', 30, 3000, { turn: 3 }),
    ev('user/message', 31, 3010, { content: '三楼问题' }),
    ev('turn/end', 32, 3020, { turn: 3, reason: { kind: 'completed' } }),
  ]
}

function fakeSource(eventsById) {
  return {
    sessionDetail: async (id) => {
      if (!(id in eventsById)) return null
      const make = eventsById[id]
      if (make === 'THROW') throw new Error('日志解不开（模拟坏文件）')
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

await check('总数/最新下标 + 被压缩遮蔽的行不出现（13/14 被 shadowedSeqs 剔除，摘要行 isCompacted:true）', async () => {
  await withServer(fakeSource({ s: messyEvents }), async (base) => {
    const { body } = await getJson(base, '/api/messages?id=s')
    assert.equal(body.ok, true)
    assert.equal(body.total, 8, '10 行 - 2 行被压缩遮蔽 + 1 行压缩摘要')
    assert.equal(body.latestIndex, 7)
    const seqs = body.messages.map((m) => m.seq)
    assert.ok(!seqs.includes(13) && !seqs.includes(14), '被遮蔽的行必须消失')
    const comp = body.messages.find((m) => m.seq === 24)
    assert.equal(comp.isCompacted, true)
    const tool = body.messages.find((m) => m.seq === 23)
    assert.equal(tool.role, 'tool')
    assert.equal(tool.isToolResult, true)
  })
})
await check('默认返回最后 N 条（limit=3 ⇒ index 5..7，绝对下标），from/limit 显式分页', async () => {
  await withServer(fakeSource({ s: messyEvents }), async (base) => {
    const tail = (await getJson(base, '/api/messages?id=s&limit=3')).body
    assert.deepEqual(tail.messages.map((m) => m.index), [5, 6, 7])
    assert.equal(tail.messages[0].seq, 24)
    const page = (await getJson(base, '/api/messages?id=s&from=1&limit=2')).body
    assert.deepEqual(page.messages.map((m) => m.index), [1, 2])
    assert.equal(page.messages[0].seq, 12)
    assert.equal(page.total, 8, 'total 恒为全表总数')
  })
})
await check('preview 只放首行截断，chars 是全文长度', async () => {
  await withServer(fakeSource({ s: messyEvents }), async (base) => {
    const { body } = await getJson(base, '/api/messages?id=s')
    const first = body.messages.find((m) => m.seq === 11)
    assert.equal(first.preview, '第一条')
    assert.ok(!first.preview.includes('第二行'), '⛔ 不许把全文塞进 preview')
    assert.equal(first.chars, '第一条\n第二行不该出现在 preview'.length)
    assert.equal(first.role, 'user')
    assert.equal(first.isToolResult, false)
  })
})
await check('turn 归属：楼内行取所在楼；压缩摘要行归它所在的楼', async () => {
  await withServer(fakeSource({ s: messyEvents }), async (base) => {
    const { body } = await getJson(base, '/api/messages?id=s')
    assert.equal(body.messages.find((m) => m.seq === 21).turn, 2)
    assert.equal(body.messages.find((m) => m.seq === 31).turn, 3)
    assert.equal(body.messages.find((m) => m.seq === 24).turn, 2)
  })
})
await check('空会话：total:0、messages:[]、latestIndex:null（W0 增量 2）', async () => {
  await withServer(fakeSource({ empty: () => [] }), async (base) => {
    const { body } = await getJson(base, '/api/messages?id=empty')
    assert.equal(body.ok, true)
    assert.equal(body.total, 0)
    assert.deepEqual(body.messages, [])
    assert.equal(body.latestIndex, null)
  })
})
await check('解析失败：ok:false + error.code=session-parse-failed + total:0 + latestIndex:null（与空会话可区分）', async () => {
  await withServer(fakeSource({ bad: 'THROW', empty: () => [] }), async (base) => {
    const { body } = await getJson(base, '/api/messages?id=bad')
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'session-parse-failed')
    assert.equal(body.latestIndex, null)
    const empty = await getJson(base, '/api/messages?id=empty')
    assert.notEqual(body.ok, empty.body.ok, '失败与空必须可区分（-2 ≠ 0 的精神）')
  })
})
await check('part=messages 带 count + messages 行数组（W0 增量 5）', async () => {
  await withServer(fakeSource({ s: messyEvents }), async (base) => {
    const { body } = await getJson(base, '/api/part?id=s&turn=2&part=messages')
    assert.equal(body.ok, true)
    assert.equal(body.turn, 2)
    assert.ok(body.count >= 4)
    assert.ok(Array.isArray(body.messages) && body.messages.length === body.count)
    assert.ok(body.messages.every((m) => 'seq' in m && 'role' in m && 'preview' in m && 'chars' in m && 'isToolResult' in m && 'isCompacted' in m))
  })
})
await check('★ 甲（2026-09-18）：part=messages&seq= ⇒ 只回那一条的**原样**对象；⛔ 不许拿拼装结果冒充、不许给没落位的 seq', async () => {
  await withServer(fakeSource({ s: messyEvents }), async (base) => {
    const { body } = await getJson(base, '/api/part?id=s&turn=2&part=messages&seq=22')
    assert.equal(body.ok, true)
    assert.equal(body.seq, 22)
    assert.equal(body.role, 'assistant')
    // ★ 原样：日志里 assistant 那条的 message 对象就该逐字回来（role + content 都在）
    assert.deepEqual(body.message, { role: 'assistant', content: '二楼回答' }, '原样对象不对：' + JSON.stringify(body.message))
    assert.ok(/原样/.test(body.messageSource) && /wire JSON/.test(body.messageSource), '来源必须写清"是日志原样、不是 wire JSON"：' + body.messageSource)
    // ★ 被压缩遮蔽的行（seq 13/14）已不在模型历史里 ⇒ 如实报没有（⛔ 不许捞回来）
    const shadowed = await getJson(base, '/api/part?id=s&turn=2&part=messages&seq=13')
    assert.equal(shadowed.body.ok, false, '被压缩遮蔽的行不许再捞出来：' + JSON.stringify(shadowed.body))
    // 但**压缩摘要那一条本身**在历史里（它就是取代前史的那条 user 消息）⇒ 取得到，且带 isCompacted
    const summaryRow = await getJson(base, '/api/part?id=s&turn=2&part=messages&seq=24')
    assert.equal(summaryRow.body.ok, true, '摘要那条应该取得到')
    assert.equal(summaryRow.body.isCompacted, true, '摘要那条要如实标 isCompacted')
    assert.equal(summaryRow.body.message._event, 'compaction/summary', '压缩摘要不是消息 ⇒ 如实标它的事件类型')
    const gone = await getJson(base, '/api/part?id=s&turn=1&part=messages&seq=22')
    assert.equal(gone.body.ok, false, '第 1 楼发不出 seq=22 ⇒ 必须如实报没有')
    const bad = await getJson(base, '/api/part?id=s&turn=2&part=messages&seq=abc')
    assert.equal(bad.body.ok, false, 'seq 不是整数 ⇒ ok:false')
  })
})
await check('参数卫兵：limit=0 / from=-1 / 缺 id ⇒ ok:false 且不抛', async () => {
  await withServer(fakeSource({ s: messyEvents }), async (base) => {
    for (const q of ['/api/messages?id=s&limit=0', '/api/messages?id=s&from=-1', '/api/messages', '/api/messages?id=nope']) {
      const { body } = await getJson(base, q)
      assert.equal(body.ok, false, q)
      assert.equal(typeof body.error, 'string', q)
    }
  })
})

console.log(`\nsummary: ${pass} passed, ${fails.length} failed :: _selftest-messages`)
if (fails.length > 0) {
  console.log('failed: ' + fails.join(' | '))
  process.exitCode = 1
}
