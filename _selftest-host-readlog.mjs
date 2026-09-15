#!/usr/bin/env node
/**
 * _selftest-host-readlog.mjs —— 「查看器怎么读会话日志」这条链的行为级自检（2026-09-15 真机 bug）。
 *
 * ## 为什么要单独一台自检
 * 真机症状：宿主迁到 **v3** 日志（`session.v3.jsonl.zstd`）之后，查看器
 *   · 只带 v3 文件的会话 → `session "…" not found`（实测 v3-only 6/6 全军覆没）
 *   · 同时带旧文件的会话 → 读到**迁移前的冻结快照**（「最新会话不显示新一轮」）
 * 根因：查看器原先自建一个私有 persistence 栈，按 `<DSH_HOME>/runtime` 里的包名 require ——
 * 那份是 **0.1.2-rc.1**，只认 `session.jsonl.zstd`。
 * 修法：宿主侧读取器（`readLog`）注入，走宿主进程里那个 persistence 实例。
 *
 * ## 这台自检要钉住的三件事（缺一条都算没修好）
 *   ① 注入了 `readLog` ⇒ 用它，且**不再碰私有栈**（runtimeDsh 指到不存在的目录也必须过）
 *   ② 没注入 ⇒ 如实走私有栈并**失败**（反证：不能假装成功、不能返回 0 楼）
 *   ③ 读取器抛错 ⇒ 响应是 `ok:false` + `session-parse-failed`（⛔ 不许折成"0 楼"）
 * 全程真 fs（临时会话根）+ 真 HTTP（node:http + fetch），不是纯函数自检。
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
const SID = 'session-11111111-2222-3333-4444-555555555555'
const OTHER = 'session-99999999-8888-7777-6666-555555555555'

/** 临时会话根：两个会话，**只有 v3 文件**（就是真机上读不到的那种）。 */
function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'mt-readlog-'))
  for (const id of [SID, OTHER]) {
    const dir = path.join(root, WS, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
  }
  return root
}

const ev = (type, seq, time, data) => ({ type, seq, time, data })
/** 两会话、各 2 楼、带真标题事件（形状照真日志：data.title / data.messageSeqs / data.source）。 */
const EVENTS = {
  [SID]: [
    ev('session/title', 1, 100, { title: '示例角色 · 演示周目', messageSeqs: [2], source: { kind: 'auto' } }),
    ev('turn/start', 2, 110, { turn: 1 }),
    ev('request/header', 3, 120, { header: { system: 'S'.repeat(100), tools: [], config: { provider: 'deepseek', model: 'dsh' } }, reason: 'initial' }),
    ev('user/message', 4, 130, { content: '第一楼' }),
    ev('assistant/message', 5, 140, { message: { content: '第一楼的回答' } }),
    ev('turn/end', 6, 150, { turn: 1, reason: { kind: 'completed' } }),
    ev('turn/start', 7, 200, { turn: 2 }),
    ev('user/message', 8, 210, { content: '第二楼（迁移之后新加的）' }),
    ev('assistant/message', 9, 220, { message: { content: '第二楼的回答' } }),
    ev('turn/end', 10, 230, { turn: 2, reason: { kind: 'completed' } }),
  ],
  [OTHER]: [
    ev('request/header', 1, 100, { header: { system: 'X', tools: [], config: {} }, reason: 'initial' }),
    ev('turn/start', 2, 110, { turn: 1 }),
    ev('user/message', 3, 120, { content: '别的会话' }),
    ev('turn/end', 4, 130, { turn: 1, reason: { kind: 'completed' } }),
  ],
}

/** 注入读取器 + 一个**不存在的** runtimeDsh：只要还碰私有栈，就必炸。
 *  ⚠️ `storageDir` 必须指到临时目录：省略它 = 用真机插件存储（`<DSH_HOME>/dsh-memory-archive`），
 *  自检里的 `POST /api/resident` 会**覆写真机常驻集**（2026-09-15 踩过：把 fixture id 写进了用户的 resident.json）。 */
function handlerWith(readLog, rawExtra = {}) {
  return pv.createHandler({
    sessionsRoot: ROOT,
    storageDir: path.join(ROOT, 'storage'),
    runtimeDsh: path.join(ROOT, 'no-such-runtime-dir'),
    ...rawExtra,
    ...(readLog === undefined ? {} : { readLog }),
  })
}

async function withServer(handler, fn) {
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

const ROOT = makeRoot()
const calls = []
const goodReader = async (id) => {
  calls.push(id)
  if (!(id in EVENTS)) throw new Error(`session "${id}" not found`)
  return { meta: { cwd: 'C:\\rp-demo', agentPreset: 'roleplay' }, events: EVENTS[id] }
}

try {
  // ---------- ① 注入读取器：用它，且完全不碰私有栈 ----------
  await check('①注入 readLog：v3-only 会话读得出来（turns=2 / latest=2），且只认注入的那份', async () => {
    await withServer(handlerWith(goodReader), async (base) => {
      const { status, body } = await getJson(base, `/api/turns?id=${SID}`)
      assert.equal(status, 200)
      assert.equal(body.ok, true, 'ok 必须为 true（读不出来要如实 false，不许 0 楼）')
      assert.equal(body.turns.length, 2)
      assert.equal(body.latest, 2)
    })
    assert.deepEqual(calls, [SID], 'readLog 必须被以会话 id 调用一次')
  })

  await check('①b 真标题来自 session/title（不是消息正文冒充）+ meta 来自注入读取器', async () => {
    await withServer(handlerWith(goodReader), async (base) => {
      const { body } = await getJson(base, `/api/session?id=${SID}`)
      assert.equal(body.ok, true)
      assert.equal(body.title, '示例角色 · 演示周目')
      assert.equal(body.meta.cwd, 'C:\\rp-demo')
      assert.equal(body.meta.effectivePreset, 'roleplay')
    })
  })

  await check('①c 同一会话的新一轮（第 2 楼）在响应里可见，startedAt 是第 2 楼的时间', async () => {
    await withServer(handlerWith(goodReader), async (base) => {
      const { body } = await getJson(base, `/api/turns?id=${SID}`)
      const last = body.turns[body.turns.length - 1]
      assert.equal(last.turn, 2)
      assert.equal(new Date(last.startedAt).getTime(), 200)
    })
  })

  // ---------- ② 反证：没有读取器 ⇒ 私有栈（指到不存在的目录）必失败，不许假装成功 ----------
  await check('②反证：不注入 readLog ⇒ 真失败（HTTP 里 ok:false），绝不返回 0 楼冒充"没内容"', async () => {
    await withServer(handlerWith(undefined), async (base) => {
      const { status, body } = await getJson(base, `/api/turns?id=${SID}`)
      assert.equal(status, 200, '契约：解析失败也是 200 + ok:false（不是 500）')
      assert.equal(body.ok, false, '没注入读取器 + 私有栈不可用 ⇒ 必须如实失败')
      assert.equal(body.error?.code, 'session-parse-failed')
      assert.deepEqual(body.turns, [])
      assert.equal(body.latest, 0)
    })
  })

  // ---------- ③ 读取器抛错 ⇒ 如实透传原因，不吞、不折成 0 ----------
  await check('③读取器抛 not found ⇒ error.message 逐字透传（用户看得见真原因）', async () => {
    const reader = async (id) => { throw new Error(`session "${id}" not found`) }
    await withServer(handlerWith(reader), async (base) => {
      const { body } = await getJson(base, `/api/turns?id=${SID}`)
      assert.equal(body.ok, false)
      assert.match(body.error.message, /not found/)
      assert.match(body.error.message, new RegExp(SID))
    })
  })

  await check('③b 读取器抛「日志为空」⇒ 同一形状的 ok:false（不许两类失败混成一种）', async () => {
    const reader = async () => ({ meta: {}, events: [] })
    await withServer(handlerWith(reader), async (base) => {
      const { body } = await getJson(base, `/api/turns?id=${SID}`)
      assert.equal(body.ok, false)
      assert.equal(body.error.code, 'session-parse-failed')
      assert.match(body.error.message, /为空或不可读/)
    })
  })

  // ---------- ④ 多会话：读取器只按被问的那个 id 调，绝不串会话 ----------
  await check('④两个会话各读各的：问 OTHER 时读取器只收到 OTHER', async () => {
    calls.length = 0
    await withServer(handlerWith(goodReader), async (base) => {
      const { body } = await getJson(base, `/api/turns?id=${OTHER}`)
      assert.equal(body.ok, true)
      assert.equal(body.latest, 1)
    })
    assert.deepEqual(calls, [OTHER], '⛔ 不许把上一个会话的事件当成这一个的')
  })

  // ---------- ⑤ resident 投影：注入路径下 requests 计数是真的（旧口径会冻结在迁移前） ----------
  await check('⑤resident 投影在注入路径下口径为真：requests=1（第 2 楼只有 1 条 header）', async () => {
    const body = await withServer(handlerWith(goodReader), async (base) => {
      const post = await fetch(`${base}/api/resident`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [SID] }),
      })
      assert.equal(post.status, 200)
      // 预热是后台串行的 ⇒ 轮询到该行解析出来（最多 5 秒）
      const deadline = Date.now() + 5000
      let payload = null
      while (Date.now() < deadline) {
        const got = await getJson(base, '/api/resident')
        const row = (got.body.sessions || []).find((s) => s.id === SID)
        if (row && row.requests >= 0) { payload = row; break }
        await new Promise((r) => setTimeout(r, 100))
      }
      return payload
    })
    assert.ok(body, 'resident 行必须在 5 秒内热出来')
    assert.equal(body.requests, 1, 'requests 必须是**读取器给出的**那份日志算出来的')
    assert.equal(body.title, '示例角色 · 演示周目')
  })

  // ---------- ⑥ 生产注入点确实存在（index.js 真的传了 readLog） ----------
  await check('⑥反证：lib/index.js 的 promptViewerFactory 调用里确实带了 readLog', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(path.join(here, 'lib', 'index.js'), 'utf8')
    assert.match(src, /readLog:\s*createHostSessionReader\(ctx\)/, '⛔ 生产路径必须注入读取器，否则真机还是读不到 v3')
    assert.match(src, /export function createHostSessionReader/, '⛔ 读取器工厂必须导出（查看器靠它注入）')
    assert.match(src, /via: 'persistence-open'/, '⛔ 宿主持久化读句柄这条路必须存在')
  })
} finally {
  try { rmSync(ROOT, { recursive: true, force: true }) } catch {}
}

console.log(`\n${pass} PASS / ${fails.length} FAIL`)
if (fails.length > 0) {
  console.log('失败项：\n  - ' + fails.join('\n  - '))
  process.exit(1)
}
