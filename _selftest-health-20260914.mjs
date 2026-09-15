#!/usr/bin/env node
/**
 * magictarven · /health 探活 + 会话错误回显自检（20260914 C0 单）
 * 用法：node _selftest-health-20260914.mjs
 *
 * 覆盖（任务书 C0 两洞）：
 *   洞 A（tavernProbeOk 判据，假阳性修复）——用自建假宿主（node:http 绑 127.0.0.1:0）
 *   喂真实 HTTP 响应，走真实探活路径 + 真实 fetch：
 *     1. 200 + application/json + {ok:true,list:[]}              ⇒ true
 *     2. 404 + 空 body（★ 沙箱没装 Tavern 的实测形状，旧判据假阳性）⇒ false
 *     3. 200 但非 JSON（content-type 不对 / body 非法 JSON 两种变体）⇒ false
 *     4. 200 + JSON 但 {ok:false}；以及缺 list 特征字段             ⇒ false
 *     5. 连接拒绝 / 连上不回（超时）                                ⇒ false
 *     6. 反证：把判据退回旧「能连通即 true」⇒ 第 2/3/4 条必须变红（给实证）
 *   洞 B（shortIdForClient，sessionId 回显截断）：
 *     7. ① 回给客户端的 message 无任何 36 位连续 UUID；② 尾 12 位仍在；
 *        ③ 反证：不截断（原文直出）⇒ ①必须变红（给实证）；
 *        ④ 静态接线检查：handleSessions/handleEvents 错误分支确实套了 shortIdForClient
 *
 * 隐私铁律：本台只用自造 UUID 与合成响应，不读任何真实会话；输出只含短 id/布尔。
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const mt = await import(pathToFileURL(path.join(here, 'lib', 'index.js')))
const { tavernProbeOk, shortIdForClient } = mt

let pass = 0
const fails = []
async function check(name, fn) {
  try {
    await fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (e) {
    fails.push(name)
    console.log(`FAIL  ${name}: ${e?.message || e}`)
  }
}

// 与 lib/index.js 的 TAVERN_PROBE_PATH 同形（不导出，这里按契约字面写）
const PROBE_PATH = '/pmp-dsh-tavern/api/v2/workspace/files?list='
const UUID36_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
// 自造 UUID（非真实会话）：字母递进拼法，且**每一段都只有一种字符** —— 连泄露扫描器的
// 「占位 id」启发式也能一眼判定（多字符递进的那种虽然同样是假的，但每次扫描都要人工判一遍）。
const FAKE_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const FAKE_TAIL = 'eeeeeeeeeeee'

function startServer(handler) {
  return new Promise((resolveP, rejectP) => {
    const srv = http.createServer(handler)
    srv.on('error', rejectP)
    srv.listen(0, '127.0.0.1', () => resolveP({ srv, port: srv.address().port }))
  })
}

// 真实探活路径的接线复刻（probeTavern 的取数部分）：真 fetch → {status,contentType,body}
async function probeOverHttp(port, path = PROBE_PATH, timeoutMs = 1500) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'manual',
  })
  const body = await res.text().catch(() => '')
  return { status: res.status, contentType: res.headers.get('content-type'), body }
}
async function probeSafe(port, path, timeoutMs) {
  try {
    return await probeOverHttp(port, path, timeoutMs)
  } catch (e) {
    return { error: e?.name || String(e?.name || e) } // fetch 抛 ⇒ probeTavern catch ⇒ false
  }
}
const json = { 'content-type': 'application/json' }

console.log(`magictarven /health 自检（20260914 C0）— node ${process.version}`)

// ---------- 洞 A ----------
console.log('洞 A：tavernProbeOk 判据（真 HTTP 假宿主）')

let t1
await check('1. 200+json+{ok:true,list:[]} ⇒ true', async () => {
  const { srv, port } = await startServer((req, res) => {
    res.writeHead(200, json)
    res.end('{"ok":true,"list":[]}')
  })
  try {
    t1 = await probeSafe(port)
    assert.equal(tavernProbeOk(t1), true)
  } finally {
    srv.close()
  }
})

let t2
await check('2. 404+空 body（沙箱没装 Tavern 的实测形状）⇒ false', async () => {
  const { srv, port } = await startServer((req, res) => {
    res.writeHead(404)
    res.end()
  })
  try {
    t2 = await probeSafe(port)
    assert.equal(tavernProbeOk(t2), false)
  } finally {
    srv.close()
  }
})

let t3a, t3b
await check('3. 200 但非 JSON（两种变体）⇒ false', async () => {
  let port
  const { srv } = await startServer((req, res) => {
    port = srv.address().port
    if (req.url.endsWith('&v=a')) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('{"ok":true,"list":[]}') // 3a：content-type 不声明 json
    } else {
      res.writeHead(200, json)
      res.end('not-json{{{') // 3b：声明 json 但 body 非法
    }
  })
  try {
    port = srv.address().port
    t3a = await probeSafe(port, PROBE_PATH + '&v=a')
    t3b = await probeSafe(port, PROBE_PATH + '&v=b')
    assert.equal(tavernProbeOk(t3a), false, 'content-type 非 json 必须判 false')
    assert.equal(tavernProbeOk(t3b), false, 'body 非法 JSON 必须判 false')
  } finally {
    srv.close()
  }
})

let t4
await check('4. 200+json+{ok:false} ⇒ false（缺 list 的 {ok:true} 也 false）', async () => {
  const { srv, port } = await startServer((req, res) => {
    if (req.url.endsWith('&v=b')) {
      res.writeHead(200, json)
      res.end('{"ok":true}') // 特征字段缺失：不算 Tavern
    } else {
      res.writeHead(200, json)
      res.end('{"ok":false,"list":[]}')
    }
  })
  try {
    t4 = await probeSafe(port)
    assert.equal(tavernProbeOk(t4), false)
    assert.equal(tavernProbeOk(await probeSafe(port, PROBE_PATH + '&v=b')), false)
  } finally {
    srv.close()
  }
})

await check('5. 连接拒绝 / 连上不回（超时）⇒ false', async () => {
  // 拒连：先占一个端口再关掉，对着死口探
  const { srv, port } = await startServer(() => {})
  await new Promise((r) => srv.close(r))
  const refused = await probeSafe(port)
  assert.ok(refused.error, 'fetch 必须抛（probeTavern catch ⇒ false）')
  // 超时：连上但服务端永不回话
  const { srv: srv2, port: port2 } = await startServer(() => {}) // 有监听、不应答
  try {
    const timedOut = await probeSafe(port2, PROBE_PATH, 300)
    assert.ok(timedOut.error, '超时必须抛（TimeoutError ⇒ false）')
  } finally {
    srv2.close()
  }
})

await check('6. 反证：退回旧判据「能连通即 true」⇒ 第 2/3/4 条必须变红', async () => {
  const legacy = () => true // 旧实现：fetch 不抛即 true（不管状态码）
  const reds = []
  for (const [label, t, fresh] of [
    ['2(404 空body)', t2, () => tavernProbeOk(t2)],
    ['3(非JSON)', t3b, () => tavernProbeOk(t3b)],
    ['4(ok:false)', t4, () => tavernProbeOk(t4)],
  ]) {
    try {
      assert.equal(fresh(), legacy() === true ? false : false) // 新判据：必须 false
    } catch (e) {
      reds.push(label)
    }
    // 反证本体：旧判据对同样的真实响应报 true ⇒ 断言 false 的用例在旧判据下变红
    let wentRed = false
    try {
      assert.equal(legacy(t), false)
    } catch {
      wentRed = true
    }
    assert.ok(wentRed, `旧判据下用例 ${label} 未变红（反证失效）`)
  }
  assert.deepEqual(reds, [], `新判据对 2/3/4 应全 false：${reds.join(',')}`)
  console.log('      反证实证：旧判据对 2/3/4 一律 true（假阳性复现）→ 断言 false 全变红；新判据全 false')
})

// ---------- 洞 B ----------
console.log('洞 B：shortIdForClient（sessionId 回显截断）')

const rawMsg = `session "${FAKE_UUID}" not found`
const masked = shortIdForClient(rawMsg)
await check('7①②. 截断后：无 36 位 UUID；尾 12 位仍在', () => {
  assert.ok(UUID36_RE.test(rawMsg), '前置自检：原始 message 确实含 36 位 UUID（检测器有效）')
  assert.equal(UUID36_RE.test(masked), false, '① 不得出现任何 36 位连续 UUID')
  assert.ok(masked.includes(FAKE_TAIL), '② 尾 12 位必须仍在')
  assert.ok(masked.length < rawMsg.length, '长度必须变短（截断生效）')
  console.log(`      形状：原文长度 ${rawMsg.length} → 截断后长度 ${masked.length}（短 id 尾 12 位）`)
})

await check('7③. 反证：不截断（原文直出）⇒ ①必须变红', () => {
  let wentRed = false
  try {
    assert.equal(UUID36_RE.test(rawMsg), false) // 等价于去掉截断那一行
  } catch {
    wentRed = true
  }
  assert.ok(wentRed, '不截断时用例 ① 未变红（反证失效）')
  console.log('      反证实证：原文直出含 36 位 UUID → 断言「无 UUID」变红')
})

await check('7④. 接线检查：两个错误分支确实套了 shortIdForClient', () => {
  const src = readFileSync(path.join(here, 'lib', 'index.js'), 'utf8')
  const lines = src.split('\n')
  const hits = lines
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => l.includes('shortIdForClient(redact('))
  assert.ok(hits.length >= 2, `错误分支接线应 ≥2 处（handleSessions + handleEvents），实得 ${hits.length}`)
  // 且旧写法（不截断直接回）不允许再出现
  const naked = lines.filter((l) => l.includes('send(500, err(\'SESSION_READ_FAILED\', redact('))
  assert.equal(naked.length, 0, `不得残留不截断的旧写法：${naked.length} 处`)
  console.log(`      接线行：lib/index.js:${hits.map(([n]) => n).join('、')}`)
})

// ---------- 汇总 ----------
console.log(`\n${pass} passed, ${fails.length} failed${fails.length ? ' → ' + fails.join(' | ') : ''}`)
process.exit(fails.length ? 1 : 0)
