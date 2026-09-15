#!/usr/bin/env node
/**
 * _selftest-system-v3.mjs —— 「查看器能不能看到该楼发给模型的 system 正文」（2026-09-15 真机第二批）。
 *
 * ## 真机症状（用户原话）
 * 「查看器还是没有实现全可读，比如最新的一楼，**字段抓到了，但是还是不给看上下文**」
 *
 * ## 根因（实测日志形状，见产物里的 `_probe-v3-system-shape`）
 * v3 起 `request/header` 的 `data.header` 只剩 `{config, adapterDefaults, tools}` —— **没有 system**；
 * system 正文搬到了独立的 `system/message` 事件（`{turn, step, message:{role,content:[{type:'text',text}]}}`）。
 * `sections-capture.js` 早就按这条轴取了（`systemCandidatesForTurn`），
 * 但 `prompt-viewer.js` 只读 `header.system` ⇒ 这一版宿主上**永远是空串**。
 *
 * ## 这台自检钉住的口径
 *   ① v3 形状：同楼 `system/message` 拼出的正文能被 `part=system` 与 `turns.systemChars` 看到
 *   ② 反证（bug 本身）：fixture 的 `request/header` **确实没有** system 字段 ⇒ 旧读法只可能是 0 字符
 *   ③ 老形状优先：header 自带 system 时用它，不去叠加同楼 system/message（不许两处都算）
 *   ④ 跨楼不许串：第 2 楼取到的是第 2 楼的 system，不是第 1 楼的
 *   ⑤ 同楼多条：`parts` 如实记 2，正文按 `\n\n` 拼（不假装是一条）
 *   ⑥ 只有上一楼有 ⇒ 来源标成 `system/message(prev-turn)`（**不许**冒充成这一楼发的）
 *   ⑦ 两处都没有 ⇒ `chars:0` + `systemSource:null`（如实未知，⛔ 不编）
 * 全程真 HTTP（临时会话根 + 注入 readLog），不是纯函数自检。
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

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

const WS = '--tmp-ws--'
const S_V3 = 'session-aaaa1111-0000-0000-0000-000000000001'
const S_OLD = 'session-aaaa1111-0000-0000-0000-000000000002'
const S_NONE = 'session-aaaa1111-0000-0000-0000-000000000003'
const S_PREV = 'session-aaaa1111-0000-0000-0000-000000000004'

const ev = (type, seq, time, data) => ({ type, seq, time, data })
/** v3 的 system 正文事件（形状照真日志）。 */
const sysMsg = (seq, turn, text) => ev('system/message', seq, seq * 10, { turn, step: 1, message: { role: 'system', content: [{ type: 'text', text }], source: { kind: 'plugin' }, id: `sys-${seq}` } })
/** v3 的 request/header（**没有** system 字段 —— 这是真机形状）。 */
const v3Header = (seq, reason = 'initial') => ev('request/header', seq, seq * 10, { header: { config: { provider: 'deepseek', model: 'dsh' }, adapterDefaults: { maxTokens: 8192 }, tools: [{ name: 't1' }] }, reason })
/** 老形状的 request/header（自带 system）。 */
const oldHeader = (seq, system) => ev('request/header', seq, seq * 10, { header: { system, tools: [], config: {} }, reason: 'initial' })

const A = '第一楼的系统提示词（v3 存在 system/message 里）'
const B1 = '第二楼的系统提示词·第一段'
const B2 = '第二楼的系统提示词·第二段（楼内二次提交）'
const OLD = '老形状：header 自带的系统提示词'
const PREV = '上一楼留下的系统提示词'

function session(id, events) { return { id, events } }

const SESSIONS = {
  // ① v3：两楼各带 system/message；第 2 楼是**两条**
  [S_V3]: [
    ev('turn/start', 1, 10, { turn: 1 }),
    sysMsg(2, 1, A),
    v3Header(3),
    ev('user/message', 4, 40, { content: [{ type: 'text', text: '第一楼' }] }),
    ev('assistant/message', 5, 50, { message: { content: [{ type: 'text', text: '答 1' }] } }),
    ev('turn/end', 6, 60, { turn: 1, reason: { kind: 'completed' } }),
    ev('turn/start', 7, 70, { turn: 2 }),
    sysMsg(8, 2, B1),
    v3Header(9),
    ev('user/message', 10, 100, { content: [{ type: 'text', text: '第二楼' }] }),
    ev('assistant/message', 11, 110, { message: { content: [{ type: 'text', text: '答 2a' }] } }),
    ev('turn/end', 12, 120, { turn: 2, reason: { kind: 'completed' } }),
    ev('turn/start', 13, 130, { turn: 3 }),
    sysMsg(14, 3, '第三楼第一段'),
    v3Header(15),
    sysMsg(16, 3, B2),          // 楼内二次提交（在 header 之后：按 seq 规则**不该**进第 3 楼这条 header）
    ev('user/message', 17, 170, { content: [{ type: 'text', text: '第三楼' }] }),
    ev('turn/end', 18, 180, { turn: 3, reason: { kind: 'completed' } }),
  ],
  // ② 老形状：header 自带 system，同时同楼还有一条 system/message ⇒ 必须用 header 那条
  [S_OLD]: [
    ev('turn/start', 1, 10, { turn: 1 }),
    sysMsg(2, 1, '同楼 system/message（不该被用）'),
    oldHeader(3, OLD),
    ev('user/message', 4, 40, { content: [{ type: 'text', text: '老形状' }] }),
    ev('turn/end', 5, 50, { turn: 1, reason: { kind: 'completed' } }),
  ],
  // ③ 两处都没有 ⇒ 未知
  [S_NONE]: [
    ev('turn/start', 1, 10, { turn: 1 }),
    v3Header(2),
    ev('user/message', 3, 30, { content: [{ type: 'text', text: '无 system' }] }),
    ev('turn/end', 4, 40, { turn: 1, reason: { kind: 'completed' } }),
  ],
  // ④ 只有上一楼有 system ⇒ 本楼回退，来源要标 prev-turn
  [S_PREV]: [
    ev('turn/start', 1, 10, { turn: 1 }),
    sysMsg(2, 1, PREV),
    v3Header(3),
    ev('user/message', 4, 40, { content: [{ type: 'text', text: '一' }] }),
    ev('turn/end', 5, 50, { turn: 1, reason: { kind: 'completed' } }),
    ev('turn/start', 6, 60, { turn: 2 }),
    v3Header(7),               // 第 2 楼自己没有 system/message
    ev('user/message', 8, 80, { content: [{ type: 'text', text: '二' }] }),
    ev('turn/end', 9, 90, { turn: 2, reason: { kind: 'completed' } }),
  ],
}

const ROOT = mkdtempSync(path.join(tmpdir(), 'mt-sysv3-'))
for (const id of Object.keys(SESSIONS)) {
  const dir = path.join(ROOT, WS, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
}
const readLog = async (id) => {
  if (!(id in SESSIONS)) throw new Error(`session "${id}" not found`)
  return { meta: { cwd: 'C:\\rp-demo', agentPreset: 'roleplay' }, events: SESSIONS[id] }
}

// ⚠️ storageDir 指到临时目录：省略 = 用真机插件存储，自检就会碰用户的常驻集/投影（⛔ 不许）。
const handler = pv.createHandler({ sessionsRoot: ROOT, storageDir: path.join(ROOT, 'storage'), readLog })
async function withServer(fn) {
  const server = http.createServer(handler)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}/dsh-memory-archive/prompt`
  try {
    return await fn(base)
  } finally {
    await new Promise((r) => server.close(r))
  }
}
const getJson = async (base, p) => {
  const res = await fetch(base + p)
  return { status: res.status, body: await res.json() }
}

try {
  // ---------- ② 先钉死"旧读法必然为空"这个反证（fixture 形状即真机形状） ----------
  await check('②反证：v3 的 request/header 确实**没有** system 字段 ⇒ 只读 header 的旧实现只可能是 0 字符', () => {
    for (const s of [SESSIONS[S_V3], SESSIONS[S_NONE], SESSIONS[S_PREV]]) {
      const headers = s.filter((e) => e.type === 'request/header')
      assert.ok(headers.length > 0, 'fixture 必须有 header')
      for (const h of headers) {
        assert.equal(Object.hasOwn(h.data.header, 'system'), false, 'v3 header 不该带 system（带了这题就不成立）')
        assert.equal(String(h.data.header.system ?? '').length, 0)
      }
    }
  })

  // ---------- ① v3 形状：正文看得见了 ----------
  await check('①v3：第 1 楼 part=system 给出 system/message 的正文，来源=system/message', async () => {
    await withServer(async (base) => {
      const { body } = await getJson(base, `/api/part?id=${S_V3}&turn=1&part=system`)
      assert.equal(body.ok, true)
      assert.equal(body.text, A)
      assert.equal(body.chars, A.length)
      assert.equal(body.systemSource, 'system/message')
      assert.equal(body.systemParts, 1)
    })
  })

  await check('①b v3：/api/turns 里该楼的 systemChars 是真长度（用户说的「字段」）', async () => {
    await withServer(async (base) => {
      const { body } = await getJson(base, `/api/turns?id=${S_V3}`)
      assert.equal(body.ok, true)
      assert.equal(body.turns[0].systemChars, A.length)
      assert.equal(body.turns[0].requestLogged, true)
    })
  })

  await check('①c v3：/api/session 的 requests 摘要里 systemChars 也为真（列表页那列）', async () => {
    await withServer(async (base) => {
      const { body } = await getJson(base, `/api/session?id=${S_V3}`)
      assert.equal(body.ok, true)
      const first = body.requests[0]
      // ⚠️ 出口形状：`/api/session` 的 requests 元素**就是 head 本体**（`sessionApi` 里 map(r => r.head)）。
      assert.equal(first.systemChars, A.length)
      assert.equal(first.systemSource, 'system/message')
    })
  })

  // ---------- ④ 跨楼不串 ----------
  await check('④第 2 楼取到的是第 2 楼的 system（不是第 1 楼的）', async () => {
    await withServer(async (base) => {
      const { body } = await getJson(base, `/api/part?id=${S_V3}&turn=2&part=system`)
      assert.equal(body.text, B1)
      assert.notEqual(body.text, A)
      assert.equal(body.systemSource, 'system/message')
    })
  })

  // ---------- ⑤ 同楼多条：如实记 2 ----------
  await check('⑤第 3 楼 header 之后的那条不算进本楼（按 seq 规则），仍只算 header 之前那条', async () => {
    await withServer(async (base) => {
      const { body } = await getJson(base, `/api/part?id=${S_V3}&turn=3&part=system`)
      assert.equal(body.text, '第三楼第一段')
      assert.equal(body.systemParts, 1, 'header 之后的 system/message 不该算进这条 header')
    })
  })

  // ---------- ③ 老形状优先 ----------
  await check('③老形状：header 自带 system ⇒ 用它，来源=header，且不叠加同楼 system/message', async () => {
    await withServer(async (base) => {
      const { body } = await getJson(base, `/api/part?id=${S_OLD}&turn=1&part=system`)
      assert.equal(body.text, OLD)
      assert.equal(body.systemSource, 'header')
      assert.equal(body.systemParts, 1)
      assert.doesNotMatch(body.text, /不该被用/)
    })
  })

  // ---------- ⑥ 跨楼回退要标出来 ----------
  await check('⑥本楼没有 system ⇒ 回退上一楼，来源标 system/message(prev-turn)（不许冒充本楼）', async () => {
    await withServer(async (base) => {
      const { body } = await getJson(base, `/api/part?id=${S_PREV}&turn=2&part=system`)
      assert.equal(body.text, PREV)
      assert.equal(body.systemSource, 'system/message(prev-turn)')
    })
  })

  // ---------- ⑦ 两处都没有 ⇒ 如实未知 ----------
  await check('⑦两处都没有 ⇒ chars:0 + systemSource:null（如实未知，不编正文）', async () => {
    await withServer(async (base) => {
      const { body } = await getJson(base, `/api/part?id=${S_NONE}&turn=1&part=system`)
      assert.equal(body.ok, true, '有 header 就说有 header；只是 system 未知')
      assert.equal(body.chars, 0)
      assert.equal(body.text, '')
      assert.equal(body.systemSource, null)
      assert.equal(body.systemParts, 0)
    })
  })

  // ---------- ⑧ 与 sections-capture 同轴：楼号归堆（同一条 system/message 不许串到别楼） ----------
  await check('⑧按楼归堆：第 1 楼看 A、第 2 楼看 B1、第 3 楼看「第三楼第一段」，三条互不相同', async () => {
    await withServer(async (base) => {
      const seen = []
      for (const t of [1, 2, 3]) {
        const { body } = await getJson(base, `/api/part?id=${S_V3}&turn=${t}&part=system`)
        seen.push(body.text)
      }
      assert.deepEqual(seen, [A, B1, '第三楼第一段'])
    })
  })
} finally {
  try { rmSync(ROOT, { recursive: true, force: true }) } catch {}
}

console.log(`\n${pass} PASS / ${fails.length} FAIL`)
if (fails.length > 0) {
  console.log('失败项：\n  - ' + fails.join('\n  - '))
  // ⛔ 不要用 process.exit(1)：Windows 上带未决句柄强退会触发 libuv 断言噪声
  //    （`!(handle->flags & UV_HANDLE_CLOSING)`）。设 exitCode 让 Node 自己退。
  process.exitCode = 1
}
