#!/usr/bin/env node
/**
 * 自检台 · M8（20260914）：**日志在 DSH 层读不出来时必须说出原因**。
 *
 * ## 为什么要有它
 * 用户报「编程区看不到东西，怀疑我们这套只能在 RP 预设下跑」。真根因（真机实测）：DSH **自己的**日志解析器
 * （`session-persistence-jsonl` 的 seq 连续性检查）拒绝了那些会话日志 —— 63 条里 12 条，报
 * `corrupt session log: seq gap in committed region at line 662 (expected 13596, got 13594)`。
 * 而我们的面板当时**显示成空的**（`/api/session` 连原因都不给、`/api/part` 直接走兜底字符串），
 * 看起来就像"这条会话什么都没有" ⇒ 用户误判成插件/预设不合。本台把「必须说清谁的锅、在哪一行、影响面」钉死。
 *
 * ## 覆盖面
 * 服务半侧：真 http server + 真 `createHandler` + **假 source**（抛宿主的真实报错原文）⇒ 四条出口的形状；
 *   ★ 两条反证：无行号的新错误也必须报出来（detail=null，⛔ 不编位置）；健康的会话**一个错误字段都不许有**。
 *   ★ 真 source 路径：临时 sessionsRoot 放一个**坏日志文件** ⇒ 走真解析栈，错误不许被吞成"会话不存在"。
 * 客户端：`pmReadFailNotice` 纯函数（那一屏实话的文案与"不编位置"口径）+ 面板接线结构断言。
 *   ★ 行上「⚠ 日志读不了」徽标的**真界面**证据由派单方在真机（3080，12 条坏会话）上复核，见验收文档。
 *
 * 用法：`node _selftest-session-readfail.mjs`（在仓库根跑）
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import http from 'node:http'
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

// ---------- 加载客户端（假 window.__ModuleLoader__ 接住 factory；只需导出面，不用假 react） ----------
const clientSrc = readFileSync(path.join(here, 'lib', 'client.js'), 'utf8')
const win = { __ModuleLoader__: { load(def) { win.__def = def } } }
globalThis.window = win
const noopReact = {
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useRef: (v) => ({ current: v }), useEffect: () => {}, useLayoutEffect: () => {},
  useCallback: (fn) => fn, useMemo: (fn) => fn(),
  createElement: () => null,
}
;(0, eval)(clientSrc)
const mod = win.__def.factory(() => noopReact)
const pmReadFailNotice = mod.__readFail && mod.__readFail.pmReadFailNotice
assert.ok(typeof pmReadFailNotice === 'function', '缺 exports.__readFail.pmReadFailNotice')

// ---------- 服务半侧工装：假 source + 临时 http server ----------
const DSH_MSG = 'corrupt session log: seq gap in committed region at line 662 (expected 13596, got 13594)'
const NO_POS_MSG = 'corrupt session log: unparsable committed event at line 9'

function throwingSource(message) {
  return {
    scanIndex: () => [],
    listSessions: async () => [],
    resolveSessions: async () => [],
    sessionDetail: async () => { throw new Error(message) },
    forget: () => {},
  }
}
function healthySource() {
  const row = { id: 'ok-1', workspace: 'ws', sizeBytes: 5, mtimeMs: 1 }
  return {
    scanIndex: () => [row],
    listSessions: async () => [{ ...row }],
    resolveSessions: async () => [{ ...row, mtime: new Date().toISOString(), title: 'ok', requests: 2 }],
    sessionDetail: async () => ({ row, parsed: { title: 'ok', meta: {}, requests: [], conversation: { turns: [], rows: [], headers: [], headerAvailable: false } } }),
    forget: () => {},
  }
}
function resolveFailSource() {
  const row = { id: 'bad-1', workspace: 'ws', sizeBytes: 9, mtimeMs: 2 }
  return {
    scanIndex: () => [row],
    listSessions: async () => [{ ...row }],
    resolveSessions: async () => [{
      id: row.id, workspace: row.workspace, sizeBytes: row.sizeBytes, mtime: new Date().toISOString(),
      title: '', requests: -2,
      readError: { code: 'session-parse-failed', message: DSH_MSG, detail: { line: 662, expected: 13596, got: 13594 } },
    }],
    sessionDetail: async () => { throw new Error(DSH_MSG) },
    forget: () => {},
  }
}

const { createHandler } = await import('file://' + path.join(here, 'lib', 'prompt-viewer.js').replace(/\\/g, '/'))
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => { Promise.resolve(handler(req, res)).catch(() => {}) })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}
async function withServer(handler, fn) {
  const { server, port } = await startServer(handler)
  try {
    return await fn(port)
  } finally {
    // ★★ 2026-09-24：**先切断还挂着的连接**再关服务器。
    //   少了这一行：undici 的连接池把 socket 留着 ⇒ 本台子结尾那句 `process.exit(...)` 在
    //   **句柄还没收干净**的时候退出 ⇒ Windows 上撞 libuv 断言
    //   `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76`
    //   ⇒ 退出码变成异常值 ⇒ 全量门把它记成失败（"它自己 13/0 却总在门里红"的那个老 flake，根因就在这）。
    try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections() } catch { /* 老 node */ }
    await new Promise((r) => server.close(r))
  }
}
async function get(port, p) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`)
  return res.json()
}
// ⚠ 归档来源必须是**函数**（每次请求现取），不是对象 —— 这是我第一版写错的坑，留在这里当反例。
const ARCH = () => (() => ({ known: true, ids: ['bad-1'] }))

// ---------- 1–4：四条出口都要交代原因 ----------
await check('★1 /api/turns：ok:false + code=session-parse-failed + DSH 原文逐字 + detail{662,13596,13594}（W0 空形状保留）', async () => {
  const handler = createHandler({ sessionsRoot: here, webPath: '/pv', archivedProvider: ARCH() }, throwingSource(DSH_MSG))
  await withServer(handler, async (port) => {
    const j = await get(port, '/pv/api/turns?id=bad-1')
    assert.equal(j.ok, false)
    assert.equal(j.error.code, 'session-parse-failed')
    assert.equal(j.error.message, DSH_MSG, '必须原样交出 DSH 原文（⛔ 不许改写/截断）')
    assert.deepEqual(j.error.detail, { line: 662, expected: 13596, got: 13594 })
    assert.deepEqual(j.turns, [], 'W0 空形状必须保留')
    assert.equal(j.latest, 0)
  })
})
await check('★2 /api/messages：同样带 code/detail（不是 0 条 ≠ 空列表）', async () => {
  const handler = createHandler({ sessionsRoot: here, webPath: '/pv' }, throwingSource(DSH_MSG))
  await withServer(handler, async (port) => {
    const j = await get(port, '/pv/api/messages?id=bad-1')
    assert.equal(j.ok, false)
    assert.equal(j.error.code, 'session-parse-failed')
    assert.deepEqual(j.error.detail, { line: 662, expected: 13596, got: 13594 })
  })
})
await check('★3 /api/session：以前只给 ok:false 不给原因 —— 现在必须给 code/detail，且归档位照旧带上', async () => {
  const handler = createHandler({ sessionsRoot: here, webPath: '/pv', archivedProvider: ARCH() }, throwingSource(DSH_MSG))
  await withServer(handler, async (port) => {
    const j = await get(port, '/pv/api/session?id=bad-1')
    assert.equal(j.ok, false)
    assert.equal(j.error.code, 'session-parse-failed')
    assert.deepEqual(j.error.detail, { line: 662, expected: 13596, got: 13594 })
    assert.equal(j.archived, true, '读不了也不该把归档位丢掉（详情页仍要能提示）')
  })
})
await check('★4 /api/part：以前走兜底字符串（只有 ok:false + error 文本）—— 现在也是结构化错误', async () => {
  const handler = createHandler({ sessionsRoot: here, webPath: '/pv' }, throwingSource(DSH_MSG))
  await withServer(handler, async (port) => {
    const j = await get(port, '/pv/api/part?id=bad-1&turn=1&part=system')
    assert.equal(j.ok, false)
    assert.equal(typeof j.error, 'object', 'error 必须是对象（带 code/detail），不是裸字符串')
    assert.equal(j.error.code, 'session-parse-failed')
    assert.deepEqual(j.error.detail, { line: 662, expected: 13596, got: 13594 })
  })
})

// ---------- 反证 ----------
await check('★5 反证A：报错里没有行号 ⇒ detail=null（⛔ 不编位置），但原因必须照报、不许折成"会话不存在"', async () => {
  const handler = createHandler({ sessionsRoot: here, webPath: '/pv' }, throwingSource(NO_POS_MSG))
  await withServer(handler, async (port) => {
    for (const p of ['/pv/api/turns?id=bad-1', '/pv/api/session?id=bad-1', '/pv/api/part?id=bad-1&turn=1&part=system']) {
      const j = await get(port, p)
      assert.equal(j.ok, false, p)
      assert.equal(j.error.code, 'session-parse-failed', p)
      assert.equal(j.error.detail, null, p + ' 无位置信息时必须 null')
      assert.equal(j.error.message, NO_POS_MSG, p)
      assert.equal(String(j.error.message).includes('会话不存在'), false, p + ' 不许说成"会话不存在"')
    }
  })
})
await check('★6 反证B：健康的会话四条出口全 ok:true，且**一个 error 字段都没有**（不许误伤）', async () => {
  const handler = createHandler({ sessionsRoot: here, webPath: '/pv' }, healthySource())
  await withServer(handler, async (port) => {
    const turns = await get(port, '/pv/api/turns?id=ok-1')
    assert.equal(turns.ok, true)
    assert.equal('error' in turns, false)
    const sess = await get(port, '/pv/api/session?id=ok-1')
    assert.equal(sess.ok, true)
    assert.equal('error' in sess, false)
    const resolve = await get(port, '/pv/api/sessions/resolve?ids=ok-1')
    assert.equal(resolve.ok, true)
    assert.equal(resolve.sessions[0].readError, undefined,
      '假 source 没给 readError ⇒ 接口层⛔ 不许自己编一个（字段归 source 所有）')
  })
})
await check('★6b readError 的归属（结构断言）：成功行显式 null、失败行 readErrorShape —— 都在**会话来源**里，不在接口层', () => {
  const src = readFileSync(path.join(here, 'lib', 'prompt-viewer.js'), 'utf8')
  const i = src.indexOf('async function resolveSessions(ids)')
  assert.ok(i > 0, '找不到 resolveSessions')
  const seg = src.slice(i, i + 1800)
  assert.ok(seg.includes('let readError = null'), '成功行必须显式 readError:null（已知能读 ≠ 没查过）')
  assert.ok(seg.includes('readError = readErrorShape(error)'), '失败行必须带原因')
  assert.ok(/out\.push\(\{[\s\S]*?readError,/.test(seg), 'readError 必须真的进每一行')
})
await check('★7 resolve 出口把 readError 原样带出来（列表行徽标靠它），归档位与 -2 哨兵都不被覆盖', async () => {
  const handler = createHandler({ sessionsRoot: here, webPath: '/pv', archivedProvider: ARCH() }, resolveFailSource())
  await withServer(handler, async (port) => {
    const j = await get(port, '/pv/api/sessions/resolve?ids=bad-1')
    const row = j.sessions[0]
    assert.equal(row.requests, -2, '解析失败哨兵不能被改')
    assert.equal(row.archived, true, '归档位必须还在')
    assert.equal(row.readError.code, 'session-parse-failed')
    assert.deepEqual(row.readError.detail, { line: 662, expected: 13596, got: 13594 })
  })
})

// ---------- 真 source 路径：坏日志文件 ----------
await check('★8 真解析栈：临时 sessionsRoot 里的坏日志 ⇒ 报 session-parse-failed（不是"会话不存在"、不是 ok:true），resolve 行带 readError', async () => {
  const root = mkdtempSync(path.join(here, '_session-readfail-'))
  try {
    const dir = path.join(root, 'ws', 'bad-real')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'session.jsonl.zstd'), Buffer.from('not a zstd log at all\n{"seq":1}\n'))
    const handler = createHandler({ sessionsRoot: root, webPath: '/pv' })
    await withServer(handler, async (port) => {
      const list = await get(port, '/pv/api/sessions')
      assert.equal(list.ok, true, '列表是 fs 扫描，坏文件也必须照常列出（不能消失）')
      assert.equal(list.sessions.length, 1)
      assert.equal(list.sessions[0].requests, -1, '快路径未解析 = -1（不是 0）')
      const turns = await get(port, '/pv/api/turns?id=bad-real')
      assert.equal(turns.ok, false)
      assert.equal(turns.error.code, 'session-parse-failed', '真解析失败必须归到这一码：' + JSON.stringify(turns).slice(0, 200))
      assert.ok(String(turns.error.message).length > 0, '必须带原文')
      assert.equal(String(turns.error.message).includes('会话不存在'), false)
      const resolve = await get(port, '/pv/api/sessions/resolve?ids=bad-real')
      assert.notEqual(resolve.sessions[0].readError, null, '真路径 resolve 也必须带 readError')
      assert.equal(resolve.sessions[0].requests, -2, '真解析失败 = -2 哨兵')
    })
  } finally {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* Windows 上删不掉就留着，不影响判据 */ }
  }
})

// ---------- 客户端纯函数 ----------
await check('★9 pmReadFailNotice：健康/别的错误码 ⇒ null（⛔ 不许对健康会话弹这一屏）', () => {
  assert.equal(pmReadFailNotice(null), null)
  assert.equal(pmReadFailNotice(undefined), null)
  assert.equal(pmReadFailNotice({ code: 'something-else', message: 'x' }), null)
})
await check('★10 pmReadFailNotice：DSH 原文 + 位置 + 谁的锅 + 影响面，四行齐备', () => {
  const n = pmReadFailNotice({ code: 'session-parse-failed', message: DSH_MSG, detail: { line: 662, expected: 13596, got: 13594 } })
  assert.equal(n.head, '该会话的日志在 DSH 层读不出来')
  const all = n.lines.join('\n')
  assert.ok(all.includes('DSH 原文：' + DSH_MSG), '缺原文：' + all)
  assert.ok(all.includes('位置：第 662 行（期望 seq 13596、实得 13594）'), '缺位置：' + all)
  assert.ok(all.includes('与本插件无关'), '必须点明不是插件的锅')
  assert.ok(all.includes('session-persistence-jsonl'), '必须点到是宿主哪个解析器拒绝的')
  assert.ok(all.includes('其它会话不受影响'), '必须给影响面，免得用户以为全坏了')
})
await check('★11 pmReadFailNotice：没有位置时如实说"不编位置"（⛔ 不许编行号）', () => {
  const n = pmReadFailNotice({ code: 'session-parse-failed', message: NO_POS_MSG, detail: null })
  const all = n.lines.join('\n')
  assert.ok(all.includes('DSH 未给出可解析的行号'), '缺"不编位置"口径：' + all)
  assert.equal(/第 \d+ 行/.test(all), false, '⛔ 不许出现编出来的行号：' + all)
  const empty = pmReadFailNotice({ code: 'session-parse-failed' })
  assert.ok(empty.lines[0].includes('没有给出可解析的错误原文'), '连 message 都没有时也要如实说')
})
await check('★12 面板接线（结构断言）：主视图在 turns.status=failed 时用 pmReadFailNotice(turns.parseError) 渲染 data-read-fail 盒', () => {
  const i = clientSrc.indexOf("turns.status === 'failed' ? (() => {")
  assert.ok(i > 0, '主视图里找不到 failed 分支')
  const seg = clientSrc.slice(i, i + 1400)
  assert.ok(seg.includes('pmReadFailNotice(turns.parseError)'), 'failed 分支必须消费 parseError')
  assert.ok(seg.includes("'data-read-fail': '1'"), '必须有 data-read-fail 标记（真界面复核靠它定位）')
  assert.ok(seg.includes('notice.lines.map'), '必须把四行都渲染出来（不是只显示一句）')
  assert.ok(clientSrc.includes("'data-read-fail-badge': '1'"), '列表行必须打「日志读不了」徽标')
})

console.log(`\n== 汇总：${pass} 通过 / ${fail} 失败 ==`)
// ★★ 2026-09-24 改口径（**说明为什么**，不是"把错误藏起来"）：
//   这里原来是 `process.exit(fail === 0 ? 0 : 1)` —— 而本台子起过真 HTTP（`fetch`/undici 连接池）
//   ⇒ **句柄还没收干净就硬退** ⇒ Windows 上撞 libuv 断言
//   `!(handle->flags & UV_HANDLE_CLOSING)`（退出码变成异常值）⇒ 它自己 **13 通过 / 0 失败**，
//   却总在全量门里被记成失败 —— 这个"老 flake"的机制就在这里。
//   改成**与其它台子同一口径**：不硬退，只设 `exitCode`，让事件循环自己空掉（undici 池过期即散）。
//   ⛔ 这不是把失败吞掉：真有断言红了，`exitCode` 一样是 1。
process.exitCode = fail === 0 ? 0 : 1
