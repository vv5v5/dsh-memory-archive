#!/usr/bin/env node
/**
 * 自检台 · 20260915：loadSessionLog（活会话注册表优先 → sessionQuery.readSession 退路）。
 *
 * ## 为什么要有它
 * 上游 readSession（session-query/src/index.ts:183-196 → core/session/src/index.ts:599-600）
 * 对 seeded 会话（fork 周目，本机 24 条）只要有自己的事件就必抛
 * `seeded session constructor seed must equal its inherited prefix` ⇒ /api/sections/text、
 * /api/sections/raw、/api/editor/diagnostics、/api/session/events 全 500。
 * 修法：五个调用点统一改走 loadSessionLog —— 先试 ctx.sessions.get(id).snapshotEvents()
 * （同上游 corpus.ts:297-303 snapshotLive() 的取法，不做 seed 校验），readSession 只当退路。
 *
 * ## 覆盖面
 * ★1 活会话命中 ⇒ via='live'（sq.readSession 抛 seeded 错也不影响）；★2 反证：旧路径（无
 * ctx.sessions）真的会抛 seeded 错（不是我假装通过）；★3 反证：snapshotEvents() 给空数组
 * ⛔ 不许当命中，必须落到 readSession；★4 无 ctx.sessions + readSession 正常 ⇒ 与改动前
 * extractEvents 抽取逐条相同；★5 旧宿主形状（sessions.get 不是函数 / 无 ctx）不抛、走②；
 * ★6 防"只改一半"：两个源文件里 `.readSession(` 只许出现在助手内部（调用点为零）。
 * 外加：★7 活会话优先于 readSession（不只当退路用）；★8 snapshotEvents 抛异常也只当没命中。
 *
 * 用法：`node _selftest-load-session-log.mjs`（在仓库根跑）
 */

import { readFileSync } from 'node:fs'
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

const { loadSessionLog } = await import('file://' + path.join(here, 'lib', 'index.js').replace(/\\/g, '/'))
assert.equal(typeof loadSessionLog, 'function', 'lib/index.js 必须导出 loadSessionLog')

const SEED_ERR = () => new Error('seeded session constructor seed must equal its inherited prefix')

/** 假 sq：readSession 按需抛 seeded 错 / 正常返回；记录调用次数。 */
function fakeSq({ throwsSeeded = false, snapshot = null } = {}) {
  let calls = 0
  return {
    get calls() { return calls },
    async readSession() {
      calls++
      if (throwsSeeded) throw SEED_ERR()
      return snapshot
    },
  }
}
const e1 = { seq: 1, type: 'turn/start', data: { turn: 1 } }
const e2 = { seq: 2, type: 'request/header', data: { header: { system: 'SYS' } } }
const liveSession = {
  header: { id: 's' },
  snapshotEvents() { return [e1, e2] },
}

await check('★1 活会话命中：snapshotEvents 给 2 条、readSession 抛 seeded 错 ⇒ via=live、events 逐条相同、session=live.header', async () => {
  const ctx = { sessions: { get: (id) => (id === 's' ? liveSession : null) } }
  const sq = fakeSq({ throwsSeeded: true })
  const loaded = await loadSessionLog(ctx, sq, 's')
  assert.equal(loaded.via, 'live')
  assert.equal(loaded.events.length, 2)
  assert.deepEqual(loaded.events, [e1, e2])
  assert.deepEqual(loaded.session, { id: 's' }, '① 必须 session=live.header')
  assert.equal(sq.calls, 0, '活会话命中时 ⛔ 不许再碰 readSession')
})

await check('★2 反证：ctx 无 sessions、readSession 抛 seeded 错 ⇒ loadSessionLog 必须真的抛（message 含 inherited prefix，证明旧路径确实会失败）', async () => {
  const sq = fakeSq({ throwsSeeded: true })
  await assert.rejects(
    () => loadSessionLog({}, sq, 'session-2521b7e1'),
    (e) => /inherited prefix/.test(String(e?.message)),
    '必须把 readSession 的 seeded 错原样抛出来，⛔ 不许吞掉后返回空数组冒充成功',
  )
})

await check('★3 反证：snapshotEvents() 给空数组 ⇒ 不算命中，必须落到 via=readSession（⛔ 不把空当成功）', async () => {
  const empty = { header: { id: 's' }, snapshotEvents() { return [] } }
  const ctx = { sessions: { get: () => empty } }
  const snap = { session: { id: 's' }, events: [e1] }
  const sq = fakeSq({ snapshot: snap })
  const loaded = await loadSessionLog(ctx, sq, 's')
  assert.equal(loaded.via, 'readSession', '空数组必须视为没命中')
  assert.equal(sq.calls, 1, '必须真的退回 readSession')
  assert.deepEqual(loaded.events, [e1])
})

await check('★4 ctx.sessions=undefined + readSession 正常 ⇒ via=readSession，events 与改动前 extractEvents 抽取逐条相同（两种快照形状）', async () => {
  const a = { session: { id: 's', agentPreset: 'rp' }, events: [e1, e2] }
  const sqA = fakeSq({ snapshot: a })
  const la = await loadSessionLog({ sessions: undefined }, sqA, 's')
  assert.equal(la.via, 'readSession')
  assert.deepEqual(la.events, [e1, e2], '{session,events} 形状：events 必须原样')
  assert.equal(la.session, a.session, '② 必须 session=snapshot.session（形状不变）')
  const b = [e1, e2] // extractEvents 的数组形状
  const sqB = fakeSq({ snapshot: b })
  const lb = await loadSessionLog(undefined, sqB, 's')
  assert.equal(lb.via, 'readSession')
  assert.deepEqual(lb.events, [e1, e2])
  assert.equal(lb.session, undefined, '数组形状没有 session，不许编')
})

await check('★5 旧宿主形状：sessions.get 不是函数 ⇒ 不抛、走②（ctx={} / sessions={} / get 是字符串 三种都探一遍）', async () => {
  const snap = { session: { id: 's' }, events: [e1] }
  for (const ctx of [{}, { sessions: {} }, { sessions: { get: 'nope' } }]) {
    const sq = fakeSq({ snapshot: snap })
    const loaded = await loadSessionLog(ctx, sq, 's')
    assert.equal(loaded.via, 'readSession', '探测失败必须静默走②，ctx=' + JSON.stringify(ctx))
    assert.equal(sq.calls, 1)
  }
})

await check('★6 防"只改一半"：两源文件里 `.readSession(` 只许在 loadSessionLog 助手内部（index.js ≤1 且位置在助手内；sections-capture.js = 0）', () => {
  const idxSrc = readFileSync(path.join(here, 'lib', 'index.js'), 'utf8')
  const capSrc = readFileSync(path.join(here, 'lib', 'sections-capture.js'), 'utf8')
  const marker = 'export async function loadSessionLog'
  const mi = idxSrc.indexOf(marker)
  assert.ok(mi > 0, 'index.js 里找不到 loadSessionLog 助手')
  const idxMatches = [...idxSrc.matchAll(/\.readSession\(/g)].map((m) => m.index)
  assert.ok(idxMatches.length <= 1, 'index.js 里 .readSession( 出现 ' + idxMatches.length + ' 次（≤1：只许助手内部那一处）')
  for (const at of idxMatches) {
    assert.ok(at > mi, 'index.js 的 .readSession( 出现在 loadSessionLog 之前（还有调用点没换）')
  }
  const capMatches = [...capSrc.matchAll(/\.readSession\(/g)]
  assert.equal(capMatches.length, 0, 'sections-capture.js 不许再出现 .readSession(（调用点必须全换）: ' + capMatches.map((m) => capSrc.slice(Math.max(0, m.index - 40), m.index + 20)).join(' | '))
  // 接线必须真实存在：三个出口都经 sessionLogOf 复用 index.js 的助手
  const uses = [...capSrc.matchAll(/await sessionLogOf\(/g)].length
  assert.ok(uses >= 3, 'sections-capture.js 三个出口都应走 sessionLogOf（实得 ' + uses + ' 处）')
  assert.ok(capSrc.includes("import('./index.js')"), 'sections-capture.js 必须从 index.js 取 loadSessionLog')
})

await check('★7 活会话优先：readSession 明明能成功也必须走 live（①是首选，不是兜底）', async () => {
  const ctx = { sessions: { get: () => liveSession } }
  const sq = fakeSq({ snapshot: { session: { id: 'other' }, events: [{ seq: 99 }] } })
  const loaded = await loadSessionLog(ctx, sq, 's')
  assert.equal(loaded.via, 'live')
  assert.equal(sq.calls, 0)
  assert.deepEqual(loaded.events, [e1, e2], '必须给活会话的事件，不是 readSession 的')
})

await check('★8 snapshotEvents 抛异常 ⇒ 只当没命中，退回 readSession（探测路径⛔ 不许把异常往外冒）', async () => {
  const bomb = { header: { id: 's' }, snapshotEvents() { throw new Error('registry blew up') } }
  const ctx = { sessions: { get: () => bomb } }
  const sq = fakeSq({ snapshot: { session: { id: 's' }, events: [e1] } })
  const loaded = await loadSessionLog(ctx, sq, 's')
  assert.equal(loaded.via, 'readSession')
  assert.deepEqual(loaded.events, [e1])
})

console.log(`\n== 汇总：${pass} 通过 / ${fail} 失败 ==`)
process.exit(fail === 0 ? 0 : 1)
