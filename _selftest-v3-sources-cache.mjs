#!/usr/bin/env node
/**
 * _selftest-v3-sources-cache.mjs —— v3 来源**带外缓存**（lib/v3-sources-cache.js）自检，
 * 外加**尾部段的三级取数**（服务 / 带外缓存 / 都没有）。
 *
 * 背景（2026-09-17）：上游换合同后，trace 合同**不再提供** Cordis 服务 `pmpDshTavernPrompt`，
 * 而 `mt:postHistory` 的段 provider 必须**同步、不能联网** ⇒ 只能装配之前异步取好、段函数同步读。
 * 这台子要钉住三件事：
 *   ① 缓存本身的口径（过期即视为没有、形状不对不存、有界）；
 *   ② **⛔ 不吃旧数据**：过期 / 时钟倒退 / 形状坏 ⇒ 一律 null，绝不拿旧的假装新鲜；
 *   ③ 尾部段确实会**先问服务、服务不在才问缓存**，且把"这一轮从哪拿的"如实记进诊断。
 *
 * 用法：node _selftest-v3-sources-cache.mjs
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const cache = await import(pathToFileURL(path.join(here, 'lib', 'v3-sources-cache.js')))
const tail = await import(pathToFileURL(path.join(here, 'lib', 'v3-tail.js')))

let pass = 0
const fails = []
function check(name, fn) {
  try { fn(); pass++; console.log('[PASS] ' + name) } catch (e) { fails.push(name); console.log('[FAIL] ' + name + ' :: ' + String((e && e.message) || e)) }
}
console.log('== _selftest-v3-sources-cache.mjs · v3 来源带外缓存自检 ==')

/** 真实形状的 sources 夹具（值全合成，⛔ 无真实角色）。 */
const mkSources = (phi = '每次回复不超过两句。') => ({
  schemaVersion: 3, sessionId: 'session-1', revision: 'rev-1',
  selection: { characterCardId: 'card-1', character: { preferCharacterPostHistory: true } },
  documents: {
    character: { id: 'card-1', name: '验收卡', data: { name: '验收卡', postHistoryInstructions: phi } },
    user: { id: 'user-1', data: { name: '旅人' } }, preset: null, worldBooks: [],
  },
})

// ---------------------------------------------------------------- K1 基本行为
console.log('\n--- K1 基本行为 ---')
check('K1a 存了就能取到（同一个对象）', () => {
  const c = cache.createSourcesCache()
  const s = mkSources()
  assert.equal(c.set('session-1', s), true)
  assert.equal(c.get('session-1'), s)
})
check('K1b ★ 反证：没存过的会话 ⇒ null（不是空对象）', () => {
  const c = cache.createSourcesCache()
  assert.equal(c.get('session-nope'), null)
})
check('K1c ★ 反证：空/非字符串 sessionId 一律不存不取，且不抛', () => {
  const c = cache.createSourcesCache()
  for (const bad of ['', null, undefined, 42, {}, []]) {
    assert.equal(c.set(bad, mkSources()), false, `set(${String(bad)}) 不该成功`)
    assert.equal(c.get(bad), null, `get(${String(bad)}) 该是 null`)
  }
})
check('K1d ★ 反证：形状不对的 sources **不存**（宁可不存，也不存半个）', () => {
  const c = cache.createSourcesCache()
  for (const bad of [null, undefined, 'x', 42, [], true]) {
    assert.equal(c.set('session-1', bad), false, `sources=${String(bad)} 不该存进去`)
    assert.equal(c.get('session-1'), null)
  }
})
check('K1e drop / clear', () => {
  const c = cache.createSourcesCache()
  c.set('session-1', mkSources())
  assert.equal(c.drop('session-1'), true)
  assert.equal(c.get('session-1'), null)
  c.set('session-1', mkSources()); c.set('session-2', mkSources())
  c.clear()
  assert.equal(c.get('session-1'), null); assert.equal(c.get('session-2'), null)
})

// ---------------------------------------------------------------- K2 TTL
console.log('\n--- K2 TTL：过期即视为没有 ---')
check('K2a 未过期 ⇒ 给；**超过** ttl ⇒ null（边界口径：age ≤ ttl 有效，age > ttl 过期）', () => {
  let t = 1000
  const c = cache.createSourcesCache({ ttlMs: 5000, now: () => t })
  c.set('session-1', mkSources())
  t = 5999
  assert.notEqual(c.get('session-1'), null, '还没到期')
  t = 6000
  assert.notEqual(c.get('session-1'), null, 'age === ttl 仍在有效期内（边界含等号）')
  t = 6001
  assert.equal(c.get('session-1'), null, '超过 ttl ⇒ 视为没有（⛔ 不拿旧的假装新鲜）')
  t = 9000
  assert.equal(c.get('session-1'), null, '过期后仍是 null')
})
check('K2b ★ 反证：过期条目已被**丢掉**，不是每次读都重判（stats.size 归零）', () => {
  let t = 0
  const c = cache.createSourcesCache({ ttlMs: 100, now: () => t })
  c.set('session-1', mkSources())
  t = 1000
  assert.equal(c.get('session-1'), null)
  assert.equal(c.stats().size, 0)
})
check('K2c ★ 反证：时钟倒退（age < 0）也当过期 —— 不用"来自未来"的时间戳', () => {
  let t = 10000
  const c = cache.createSourcesCache({ ttlMs: 5000, now: () => t })
  c.set('session-1', mkSources())
  t = 9999 // 倒退 1ms
  assert.equal(c.get('session-1'), null, '倒退 ⇒ 宁可重取')
})
check('K2d 非法 ttl/maxSessions ⇒ 回落到默认（不抛、不变成 0 容量）', () => {
  for (const bad of [0, -1, NaN, Infinity, 'x', null]) {
    const c = cache.createSourcesCache({ ttlMs: bad, maxSessions: bad })
    assert.equal(c.set('session-1', mkSources()), true)
    assert.notEqual(c.get('session-1'), null, `ttl=${String(bad)} 时仍然可用`)
    assert.equal(c.stats().ttlMs, cache.DEFAULT_TTL_MS)
    assert.equal(c.stats().maxSessions, cache.DEFAULT_MAX_SESSIONS)
  }
})

// ---------------------------------------------------------------- K3 有界 + LRU
console.log('\n--- K3 有界与 LRU ---')
check('K3a 超出容量 ⇒ 丢**最久没用**的（⛔ 不无界增长）', () => {
  const c = cache.createSourcesCache({ maxSessions: 3 })
  c.set('s1', mkSources()); c.set('s2', mkSources()); c.set('s3', mkSources())
  assert.equal(c.stats().size, 3)
  c.set('s4', mkSources())
  assert.equal(c.stats().size, 3, '容量必须封顶')
  assert.equal(c.get('s1'), null, '最旧的必须被淘汰')
  assert.notEqual(c.get('s2'), null)
  assert.notEqual(c.get('s4'), null)
})
check('K3b ★ 反证：`get` 命中会刷新 LRU 位置（刚看过的不会被淘汰）', () => {
  const c = cache.createSourcesCache({ maxSessions: 3 })
  c.set('s1', mkSources()); c.set('s2', mkSources()); c.set('s3', mkSources())
  assert.notEqual(c.get('s1'), null, '摸一下 s1 ⇒ 它变成最近使用')
  c.set('s4', mkSources())
  assert.notEqual(c.get('s1'), null, 's1 刚用过，不该被淘汰')
  assert.equal(c.get('s2'), null, '该被淘汰的是 s2')
})
check('K3c ★ 反证：重复 set 同一个 key 不会撑大容量', () => {
  const c = cache.createSourcesCache({ maxSessions: 2 })
  for (let i = 0; i < 10; i++) c.set('s1', mkSources())
  assert.equal(c.stats().size, 1)
})
check('K3d stats 只出计数与年龄，⛔ 不出正文', () => {
  const c = cache.createSourcesCache()
  c.set('session-abcdef', mkSources('机密正文ZZZ'))
  const st = c.stats()
  assert.equal(st.size, 1)
  assert.equal(JSON.stringify(st).includes('机密正文ZZZ'), false, '⛔ 诊断投影里不许出现正文')
  assert.equal(st.entries[0].session, 'abcdef', '只留尾 6 位')
})

// ---------------------------------------------------------------- K4 尾部段三级取数
console.log('\n--- K4 尾部段三级取数：服务 → 带外缓存 → 空 ---')
/** 与 _selftest-v3-tail.mjs 同款的假 ctx 脚手架。 */
function makeCtx({ service } = {}) {
  const captured = { sections: [] }
  const ctx = {
    get: (n) => (n === 'pmpDshTavernPrompt' ? service : undefined),
    plugin: (p) => {
      const scope = {
        effect: (fn) => fn(),
        systemPrompt: { section: (s) => { captured.sections.push(s); return () => {} } },
        on: () => {},
      }
      p.apply(scope)
    },
  }
  return { ctx, captured }
}
const ctxOf = (sid) => ({ agent: { session: { id: sid } } })
const silent = { info: () => {}, warn: () => {} }

check('K4a 服务在 ⇒ 走服务，origin = cordis-service（缓存里有别的也不看）', () => {
  const { ctx, captured } = makeCtx({ service: { getSources: () => mkSources('来自服务') } })
  const r = tail.registerV3Tail(ctx, { enabled: true }, silent, { readSources: () => mkSources('来自缓存') })
  const text = captured.sections[0].text(ctxOf('session-1'))
  assert.match(text, /来自服务/)
  assert.equal(text.includes('来自缓存'), false, '⛔ 服务在的时候不许去读缓存')
  assert.equal(r.status().source, 'cordis-service')
})
check('K4b ★ 服务不在 ⇒ 回落带外缓存，origin = out-of-band-cache（这正是 trace 合同的路径）', () => {
  const cached = mkSources('来自缓存')
  const { ctx, captured } = makeCtx({ service: undefined })
  const r = tail.registerV3Tail(ctx, { enabled: true }, silent, { readSources: (sid) => (sid === 'session-1' ? cached : null) })
  assert.match(captured.sections[0].text(ctxOf('session-1')), /来自缓存/)
  assert.equal(r.status().source, 'out-of-band-cache')
  assert.equal(r.status().reason, 'ok')
})
check('K4c ★ 服务抛异常 ⇒ 也回落缓存（不是直接把这一段判死）', () => {
  const { ctx, captured } = makeCtx({ service: { getSources: () => { throw new Error('tavern 挂了') } } })
  const r = tail.registerV3Tail(ctx, { enabled: true }, silent, { readSources: () => mkSources('兜住了') })
  assert.match(captured.sections[0].text(ctxOf('session-1')), /兜住了/)
  assert.equal(r.status().source, 'out-of-band-cache')
})
check('K4d ★ 反证：两条都没有 ⇒ 空段 + 如实原因，origin 为 null', () => {
  const { ctx, captured } = makeCtx({ service: undefined })
  const r = tail.registerV3Tail(ctx, { enabled: true }, silent, { readSources: () => null })
  assert.equal(captured.sections[0].text(ctxOf('session-1')), '')
  assert.match(String(r.status().reason), /no-tavern-service/)
  assert.equal(r.status().source, null, '⛔ 没拿到就说没拿到')
})
check('K4e ★ 反证：readSources 抛 / 返回畸形 ⇒ 空段，不抛出去、不串场', () => {
  for (const bad of [() => { throw new Error('缓存炸了') }, () => 'x', () => 42, () => []]) {
    const { ctx, captured } = makeCtx({ service: undefined })
    const r = tail.registerV3Tail(ctx, { enabled: true }, silent, { readSources: bad })
    assert.equal(captured.sections[0].text(ctxOf('session-1')), '', '取不到就该空')
    assert.equal(r.status().source, null)
  }
})
check('K4f ★ 反证：不传 deps（老调用方）行为不变 —— 服务不在就是空，不抛', () => {
  const { ctx, captured } = makeCtx({ service: undefined })
  const r = tail.registerV3Tail(ctx, { enabled: true }, silent)
  assert.equal(captured.sections[0].text(ctxOf('session-1')), '')
  assert.match(String(r.status().reason), /no-tavern-service/)
})
check('K4g 端到端：装配前 set、段函数同步读 —— 就是 index.js 的填充器 + provider 的组合', () => {
  const c = cache.createSourcesCache()
  const { ctx, captured } = makeCtx({ service: undefined })
  const r = tail.registerV3Tail(ctx, { enabled: true }, silent, { readSources: (sid) => c.get(sid) })
  // 装配**之前**（填充器做的事）
  assert.equal(captured.sections[0].text(ctxOf('session-1')), '', '还没填 ⇒ 空')
  c.set('session-1', mkSources('填好了'))
  // 装配那一刻（同步读）
  assert.match(captured.sections[0].text(ctxOf('session-1')), /填好了/, '填充器填完 ⇒ provider 同步就读到')
  assert.equal(r.status().source, 'out-of-band-cache')
})

// ------------------------------------- K5 第二个槽：已渲染正文（上游删 /sources 之后的来源）
console.log('\n--- K5 已渲染正文槽（2026-09-18：上游删 /sources ⇒ 尾段改从官方 PHI 段取）---')

check('K5a 存了就能取到；空白/空 id 不存；不抛', () => {
  const c = cache.createSourcesCache()
  assert.equal(c.getRendered('s1'), null, '没存过 ⇒ null')
  assert.equal(c.setRendered('s1', '   '), false, '⛔ 空白不存（宁可不存，也不存半个）')
  assert.equal(c.setRendered('s1', ''), false)
  assert.equal(c.setRendered('', 'x'), false, '空 sessionId 不存')
  assert.equal(c.setRendered('s1', '每次回复不超过两句。'), true)
  assert.equal(c.getRendered('s1'), '每次回复不超过两句。')
})

check('K5b ★★ 反证（修 /sources 删除时最容易踩的那一脚）：只装了 rendered 的行，`get` 取不到时**不许删行**', () => {
  const c = cache.createSourcesCache()
  c.setRendered('s1', '正文在')
  assert.equal(c.get('s1'), null, '没有 sources ⇒ get 给 null')
  // ★ 尾段那条路就是「先 get(sources) 拿不到、再 getRendered」⇒ get 若把行删了，后面就永远空
  assert.equal(c.getRendered('s1'), '正文在', '⛔ get 把行删了 ⇒ rendered 一起丢，这条修法就白修了')
})

check('K5c 两槽互不踩：set(sources) 保留 rendered、setRendered 保留 sources', () => {
  const c = cache.createSourcesCache()
  c.setRendered('s1', '正文')
  c.set('s1', mkSources('来自端点'))
  assert.equal(c.getRendered('s1'), '正文', '⛔ set(sources) 不许把 rendered 冲掉')
  assert.match(String(c.get('s1').documents.character.data.postHistoryInstructions), /来自端点/)
  c.setRendered('s1', '新正文')
  assert.match(String(c.get('s1').documents.character.data.postHistoryInstructions), /来自端点/, '⛔ setRendered 不许把 sources 冲掉')
  assert.equal(c.getRendered('s1'), '新正文')
})

check('K5d ★ 反证：rendered 吃**同一套** TTL（过期即无，不用旧数据假装新鲜）', () => {
  let t = 0
  const c = cache.createSourcesCache({ ttlMs: 1000, now: () => t })
  c.setRendered('s1', '正文')
  t = 1000
  assert.equal(c.getRendered('s1'), '正文', 'age ≤ ttl 有效')
  t = 1001
  assert.equal(c.getRendered('s1'), null, 'age > ttl ⇒ null')
  assert.equal(c.stats().size, 0, '过期条目已被丢掉')
})

check('K5e ★ 反证：rendered 与 sources **共用容量**（⛔ 不做第二套生命周期）', () => {
  const c = cache.createSourcesCache({ maxSessions: 2 })
  c.setRendered('a', 'A')
  c.setRendered('b', 'B')
  c.setRendered('c', 'C')
  assert.equal(c.stats().size, 2, '同一个 Map ⇒ 同一个上限')
  assert.equal(c.getRendered('a'), null, '最久没用的被淘汰')
})

check('K4h ★ 端到端（trace 合同 /sources 没了）：rendered 槽喂进来 ⇒ 尾段照样产出，origin = part-section', () => {
  const c = cache.createSourcesCache()
  const { ctx, captured } = makeCtx({ service: undefined })
  const r = tail.registerV3Tail(ctx, { enabled: true }, silent, {
    readSources: (sid) => c.get(sid), readRenderedPhi: (sid) => c.getRendered(sid),
  })
  assert.equal(captured.sections[0].text(ctxOf('session-1')), '', '还没留档 ⇒ 空')
  c.setRendered('session-1', '（验收）每次回复不超过两句。')
  const text = captured.sections[0].text(ctxOf('session-1'))
  assert.match(text, /每次回复不超过两句。/, '留档之后同步就读到')
  assert.match(text, /<\/st-character-field>\s*$/, '外壳必须与 tailTextFromSources 同一个')
  assert.equal(r.status().source, 'part-section')
})

check('K4i ★ 反证：两槽都有 ⇒ **优先 sources**（端点那条更完整：带卡名/用户名做宏展开）', () => {
  const c = cache.createSourcesCache()
  c.set('session-1', mkSources('来自端点'))
  c.setRendered('session-1', '来自官方段')
  const { ctx, captured } = makeCtx({ service: undefined })
  const r = tail.registerV3Tail(ctx, { enabled: true }, silent, {
    readSources: (sid) => c.get(sid), readRenderedPhi: (sid) => c.getRendered(sid),
  })
  const text = captured.sections[0].text(ctxOf('session-1'))
  assert.match(text, /来自端点/)
  assert.equal(text.includes('来自官方段'), false, '⛔ sources 在时不许用 rendered')
  assert.equal(r.status().source, 'out-of-band-cache')
})

check('K4j ★ 反证：readRenderedPhi 抛 / 畸形 ⇒ 空段且不抛（与 K4e 同款）', () => {
  for (const bad of [() => { throw new Error('炸了') }, () => 42, () => [], () => '']) {
    const { ctx, captured } = makeCtx({ service: undefined })
    const r = tail.registerV3Tail(ctx, { enabled: true }, silent, { readSources: () => null, readRenderedPhi: bad })
    assert.equal(captured.sections[0].text(ctxOf('session-1')), '', '取不到就该空')
    assert.equal(r.status().source, null)
  }
})

console.log('\n== 汇总：' + pass + ' 通过 / ' + fails.length + ' 失败 ==')
if (fails.length > 0) { console.log('失败项：\n  - ' + fails.join('\n  - ')); process.exit(1) }
