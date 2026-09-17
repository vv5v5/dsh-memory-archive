// _selftest-deferred-install.mjs —— lib/deferred-install.js 的行为级自检（假 hub，不碰宿主）。
//
// 要钉住的是三件事，缺一条就会出事：
//   ① **只跑一次**：哨兵透传 + 下游版干活，绝不允许同一个瀑布调用里跑两遍（那会重复落盘/重复告警）；
//   ② **不漏首轮**：第一个会话事件之后、本轮装配之前就位；
//   ③ 反证：**没有会话事件时不许失效** —— 哨兵要继续干活（⛔ 否则功能静默消失，比排在上游更糟）。
import assert from 'node:assert/strict'
import { DEFERRED_INSTALL_VERSION, makeDeferredAssembleListener } from './lib/deferred-install.js'

let pass = 0
const fails = []
function check(name, fn) {
  try { fn(); pass++; console.log('[PASS] ' + name) } catch (e) { fails.push(name); console.log('[FAIL] ' + name + ' :: ' + String((e && e.message) || e)) }
}
console.log('== _selftest-deferred-install.mjs · 延迟挂载自检 ==')

/** 假 hub：按**注册顺序**跑监听，并支持 `next()` 链（模拟 cordis 瀑布）。 */
function makeHub() {
  const listeners = new Map()
  return {
    on(event, fn) {
      const l = listeners.get(event) ?? []
      l.push(fn)
      listeners.set(event, l)
      return () => { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1) }
    },
    async emit(event, ...args) {
      const l = [...(listeners.get(event) ?? [])]
      let i = -1
      const next = async () => { i += 1; if (i >= l.length) return 'FINAL'; return l[i](...args, next) }
      return next()
    },
    count(event) { return (listeners.get(event) ?? []).length },
  }
}

check('D1 版本是正整数', () => assert.ok(Number.isInteger(DEFERRED_INSTALL_VERSION) && DEFERRED_INSTALL_VERSION > 0))
check('D2 ★ 反证：缺 on/run ⇒ 不抛、mode=unavailable、dispose 安全', () => {
  for (const bad of [undefined, {}, { on: () => {} }, { run: () => {} }, { on: 1, run: 2 }]) {
    const r = makeDeferredAssembleListener(bad)
    assert.equal(r.mode(), 'unavailable')
    assert.equal(r.takenOver(), false)
    r.dispose()
  }
})

check('D3 会话事件之前：哨兵干活，mode=upstream-sentinel', () => {
  const hub = makeHub()
  let calls = 0
  const r = makeDeferredAssembleListener({ on: hub.on.bind(hub), run: async (a, b, next) => { calls += 1; return next() } })
  assert.equal(r.mode(), 'upstream-sentinel')
  return (async () => {
    await hub.emit('system-prompt/assemble', 'A', 'B')
    assert.equal(calls, 1, '哨兵该干一次活')
  })()
})

check('D4 ★★ 关键：会话事件之后，**同一个瀑布调用只跑一次**（哨兵透传、下游版干活）', async () => {
  const hub = makeHub()
  const order = []
  const r = makeDeferredAssembleListener({
    on: hub.on.bind(hub),
    run: async (a, b, next) => { order.push('run'); return next() },
  })
  await hub.emit('session/event', { id: 's1' }, { type: 'agent/inbox/spliced' })
  assert.equal(r.takenOver(), true)
  assert.equal(r.mode(), 'downstream')
  order.length = 0
  await hub.emit('system-prompt/assemble', 'A', 'B')
  assert.deepEqual(order, ['run'], '⛔ 跑了两遍（哨兵没退位）—— 会重复落盘/重复告警')
})

check('D5 ★ 下游版确实**排在最后**（= 看得见其它插件在下游加的东西）', async () => {
  const hub = makeHub()
  const seq = []
  // 模拟"其它插件"（激活更早？不 —— 它们更晚注册，这里模拟它们在哨兵之后注册）
  const r = makeDeferredAssembleListener({ on: hub.on.bind(hub), run: async (a, b, next) => { seq.push('ours'); return next() } })
  await hub.emit('session/event', {}, {})
  hub.on('system-prompt/assemble', async (a, b, next) => { seq.push('later-plugin'); return next() })
  await hub.emit('system-prompt/assemble', 'A', 'B')
  assert.deepEqual(seq, ['ours', 'later-plugin'])
  assert.equal(r.takenOver(), true)
})

check('D6 ★ 反证：**从不派发会话事件**时，哨兵继续干活（⛔ 不许静默失效）', async () => {
  const hub = makeHub()
  let calls = 0
  const r = makeDeferredAssembleListener({ on: hub.on.bind(hub), run: async (a, b, next) => { calls += 1; return next() } })
  for (let i = 0; i < 3; i++) await hub.emit('system-prompt/assemble', 'A', 'B')
  assert.equal(calls, 3, '哨兵必须每次都干活')
  assert.equal(r.mode(), 'upstream-sentinel')
  assert.equal(r.takenOver(), false)
})

check('D7 ★ 反证：多次会话事件**只追加一次**下游版（不许越挂越多）', () => {
  const hub = makeHub()
  const r = makeDeferredAssembleListener({ on: hub.on.bind(hub), run: async (a, b, next) => next() })
  const before = hub.count('system-prompt/assemble')
  for (let i = 0; i < 5; i++) hub.emit('session/event', {}, {})
  assert.equal(hub.count('system-prompt/assemble'), before + 1, '⛔ 追加了不止一次')
  assert.equal(r.takenOver(), true)
})

check('D8 ★ 反证：on 抛错时只降级、不抛出去（注册失败也不能拖垮插件）', () => {
  const boom = () => { throw new Error('上游契约变了') }
  const r = makeDeferredAssembleListener({ on: boom, run: async () => {} })
  assert.equal(r.takenOver(), false)
  r.dispose()
  // 只有 session/event 挂不上时也一样
  let n = 0
  const half = (ev) => { n += 1; if (ev === 'session/event') throw new Error('no event'); return () => {} }
  const r2 = makeDeferredAssembleListener({ on: half, run: async () => {} })
  assert.equal(r2.mode(), 'upstream-sentinel')
  assert.ok(n >= 1)
})

check('D9 dispose 把两个监听都摘掉', async () => {
  const hub = makeHub()
  let calls = 0
  const r = makeDeferredAssembleListener({ on: hub.on.bind(hub), run: async (a, b, next) => { calls += 1; return next() } })
  await hub.emit('session/event', {}, {})
  const nBefore = hub.count('system-prompt/assemble') + hub.count('session/event')
  assert.ok(nBefore >= 3, '应有 哨兵 + 下游版 + 触发监听')
  r.dispose()
  assert.equal(hub.count('system-prompt/assemble'), 0)
  assert.equal(hub.count('session/event'), 0)
  await hub.emit('system-prompt/assemble', 'A', 'B')
  assert.equal(calls, 0, '摘掉之后不该再跑')
})

console.log('\n== 汇总：' + pass + ' 通过 / ' + fails.length + ' 失败 ==')
if (fails.length > 0) { console.log('失败项：\n  - ' + fails.join('\n  - ')); process.exit(1) }
