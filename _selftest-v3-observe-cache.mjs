/**
 * _selftest-v3-observe-cache.mjs —— `lib/v3-observe-cache.js` 自检台。
 *
 * 钉四件事：① 存了能取、空/畸形不存不抛；② TTL（含时钟倒退）；③ 有界 + LRU；
 * ④ ★ 反证：**只出计数与年龄，不出内容**（这条观察将来会长字段，别把正文漏进诊断投影）。
 *
 * 用法：node _selftest-v3-observe-cache.mjs
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(here, 'lib', 'v3-observe-cache.js')).href)

let pass = 0
const fails = []
function check(name, fn) {
  try { fn(); pass++; console.log('[PASS]', name) } catch (e) { fails.push({ name, e }); console.log('[FAIL]', name, '::', e.message) }
}
const mk = (extra = {}) => ({ observed: true, total: 35, present: ['mt:lastFloors'], missing: [], wholesale: false, partial: false, ...extra })

console.log('== _selftest-v3-observe-cache.mjs · 段表观察缓存 ==')

check('C1 存了就能取到；空 id / 非对象不存、不抛', () => {
  const c = mod.createObserveCache()
  assert.equal(c.getObserved('s1'), null, '没存过 ⇒ null')
  assert.equal(c.setObserved('s1', null), false)
  assert.equal(c.setObserved('s1', 'x'), false)
  assert.equal(c.setObserved('s1', 42), false)
  assert.equal(c.setObserved('', mk()), false)
  assert.equal(c.setObserved('s1', mk({ total: 7 })), true)
  assert.equal(c.getObserved('s1').total, 7)
  assert.equal(c.getObserved('s1').observed, true)
})

check('C2 TTL：边界含等号；超过 ⇒ null 并把行丢掉；时钟倒退也当过期', () => {
  let t = 1000
  const c = mod.createObserveCache({ ttlMs: 5000, now: () => t })
  c.setObserved('s1', mk())
  t = 6000
  assert.notEqual(c.getObserved('s1'), null, 'age === ttl 仍有效')
  t = 6001
  assert.equal(c.getObserved('s1'), null, '超过 ttl ⇒ 视为没有')
  assert.equal(c.stats().size, 0, '过期条目要被丢掉（不是每次读都重判）')
  let t2 = 10000
  const c2 = mod.createObserveCache({ ttlMs: 5000, now: () => t2 })
  c2.setObserved('s1', mk())
  t2 = 9999
  assert.equal(c2.getObserved('s1'), null, '★ 时钟倒退 ⇒ 宁可重判，不用"来自未来"的时间戳')
})

check('C3 有界 + LRU；非法 ttl/maxSessions 回落默认', () => {
  const c = mod.createObserveCache({ maxSessions: 3 })
  c.setObserved('s1', mk()); c.setObserved('s2', mk()); c.setObserved('s3', mk())
  assert.notEqual(c.getObserved('s1'), null, '摸一下 s1 ⇒ 刷新 LRU')
  c.setObserved('s4', mk())
  assert.equal(c.stats().size, 3, '容量必须封顶')
  assert.notEqual(c.getObserved('s1'), null, '刚用过的 s1 不该被淘汰')
  assert.equal(c.getObserved('s2'), null, '该被淘汰的是 s2')
  for (const bad of [0, -1, NaN, Infinity, 'x', null]) {
    const cc = mod.createObserveCache({ ttlMs: bad, maxSessions: bad })
    assert.equal(cc.setObserved('s1', mk()), true)
    assert.notEqual(cc.getObserved('s1'), null, 'ttl=' + String(bad) + ' 时仍可用')
    assert.equal(cc.stats().ttlMs, mod.DEFAULT_OBSERVE_TTL_MS)
    assert.equal(cc.stats().maxSessions, mod.DEFAULT_MAX_SESSIONS)
  }
})

check('C4 ★ 反证：stats 只出计数与年龄（尾 6 位会话号），⛔ 不出内容', () => {
  const c = mod.createObserveCache()
  c.setObserved('session-abcdef', mk({ secret: '机密正文ZZZ' }))
  const st = c.stats()
  assert.equal(st.size, 1)
  assert.equal(JSON.stringify(st).includes('机密正文ZZZ'), false, '诊断投影里不许出现内容')
  assert.equal(st.entries[0].session, 'abcdef', '只留尾 6 位')
  assert.ok(Number.isFinite(st.entries[0].ageMs))
})

check('C5 drop / clear 语义', () => {
  const c = mod.createObserveCache()
  c.setObserved('s1', mk()); c.setObserved('s2', mk())
  assert.equal(c.drop('s1'), true)
  assert.equal(c.getObserved('s1'), null)
  assert.equal(c.drop(''), false, '空 id 不抛，返回 false')
  c.clear()
  assert.equal(c.stats().size, 0)
})

console.log(`\n== 汇总：${pass} 通过 / ${fails.length} 失败 ==`)
if (fails.length > 0) {
  console.log('失败项：')
  for (const f of fails) console.log('  -', f.name, '::', f.e.message)
  process.exitCode = 1
}
