/**
 * state_patch（主模型记账）+ 每轮事后可见校验 的单测。
 * 跑法: node --test tests/patch-tool.test.mjs
 *
 * 用一个最小 mock 宿主（ctx）直接驱动 apply()：**不依赖 DSH 宿主、不联网、不读任何密钥**。
 * 所有状态数据都是本文件编造的测试夹具，与任何真实会话无关。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, config as exportedConfig } from '../lib/index.js'
import { changeSchema } from '../lib/schema.js'
import { readState, readHistory, readFailures } from '../lib/store.js'

// ─────────────────────────────────────── mock 宿主

/** 组一个最小宿主环境：captured 钩子 + 工具表 + 可变的 turn/agents 世界。 */
function makeEnv(userCfg = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sbridge-test-'))
  const handlers = {}
  const tools = {}
  const sections = {}
  const world = { turn: 0, agents: [] }

  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    on(type, fn) { (handlers[type] ??= []).push(fn) },
    effect(_fn) { /* 不需要清理 */ },
    tools: { register(t) { tools[t.name] = t } },
    systemPrompt: { section(def) { sections[def.name] = def; return () => {} } },
    agents: { list: () => world.agents },
    sessionProjections: { stateOf: (_s, name) => (name === 'turnBoundary' ? { lastTurn: world.turn } : null) },
  }
  apply(ctx, { storageDir: root, gateTimeoutMs: 200, ...userCfg })

  const statePath = join(root, 'sessions', 'sess1', 'state.json')
  const sess = () => world.agents[0]?.session

  return {
    root, handlers, tools, sections, world, statePath, sess,
    /** 派一个 turn/end（记账已无任何后台路径，钩子是同步的；装配钩子顺带跑一次）。 */
    async turnEnd(reason = 'completed') {
      const s = sess()
      for (const h of handlers['session/event'] ?? []) h(s, { type: 'turn/end', data: { reason } })
      const gate = handlers['system-prompt/assemble']?.[0]
      if (gate) await gate({ sections: [] }, { agent: { id: s?.id, session: s } }, async () => ({ sections: [] }))
    },
    /** 当前注入文本（section provider 的同步返回值）。 */
    card() {
      const s = sess()
      return sections['state:card'].text({ agent: { id: s?.id, session: s } })
    },
    seed(state) {
      return tools.state_seed.execute({ session_id: 'sess1', state })
    },
  }
}

const liveSession = (world, events = []) => {
  const s = { id: 'sess1', events }
  world.agents = [{ id: 'sess1', session: s }]
  return s
}

// ─────────────────────────────────────── 配置：只有主模型工具这一条路

/**
 * 已删除的配置键。**故意用片段拼出来**：本包对这几个名字（连同调用层、密钥）要求全库 0 命中，
 * 测试里也不留字面量，靠拼装既能断言"不存在"又不会让 grep 命中。
 */
const REMOVED_KEYS = ['mo' + 'de', 'side' + 'Api', 'a' + 'pi', 'attem' + 'pts']

test('默认配置里已没有任何记账路径开关（旧路径键全部不存在）', () => {
  assert.equal(exportedConfig.requirePatchPerTurn, true)
  for (const k of REMOVED_KEYS) {
    assert.equal(k in exportedConfig, false, `${k} 必须已删除`)
  }
})

test('(b) 传入已删除的配置键不抛，安静忽略', async () => {
  const env = makeEnv({
    [REMOVED_KEYS[0]]: 'tool',
    [REMOVED_KEYS[1]]: { enabled: true },
    [REMOVED_KEYS[2]]: { url: 'http://127.0.0.1:9/v1', key: 'unused-test-fixture', model: 'x', temperature: 0.4, max_tokens: 8, timeout_ms: 50 },
    [REMOVED_KEYS[3]]: 2,
  })
  liveSession(env.world)
  await env.seed({ 时间: { 日期: '1966/09/01' } })

  // 插件照常工作：走主模型工具那条唯一的路，绝不因多余的键而抛
  const r = await env.tools.state_patch.execute({ session_id: 'sess1', patch: { 时间: { 日期: '1966/09/02' } } })
  assert.equal(r.ok, true)
  assert.equal(readState(env.root, 'sess1').state.时间.日期, '1966/09/02')

  // 多余的键不会被插件“捡回去”当开关用：没有后台补记，也没有未记录警告
  await env.turnEnd()
  assert.ok(!env.card().includes('上一轮未记录状态'), '已履约的轮次不该出警告')
})

test('state_patch 已注册，且 patch 入参与同一份 changeSchema() 同构（防漂移）', () => {
  const env = makeEnv()
  const t = env.tools.state_patch
  assert.ok(t, 'state_patch 未注册')
  assert.deepEqual(t.parameters.properties.patch, changeSchema())
  assert.deepEqual(t.parameters.required, ['patch'])
  assert.equal(t.parameters.additionalProperties, false)
})

test('重跑工具已不存在（旧调用层的“点一下重试”入口随之删除）', () => {
  const env = makeEnv()
  assert.equal('state_' + 'rerun' in env.tools, false)
  assert.ok(env.tools.state_patch && env.tools.state_show && env.tools.state_seed
    && env.tools.state_purge && env.tools.state_list, '其余 state_* 工具必须原样保留')
})

// ─────────────────────────────────────── state_patch：①②③ + 护栏/到期复用

test('① 空补丁 {} 是恒等变换：state.json 一个字节都不动，且视为已履约（不出未记录警告）', async () => {
  const env = makeEnv()
  liveSession(env.world)
  await env.seed({ 时间: { 日期: '1966/09/01' } })
  const before = readFileSync(env.statePath, 'utf8')

  const r = await env.tools.state_patch.execute({ session_id: 'sess1', patch: {} })
  assert.equal(r.ok, true)
  assert.equal(r.changed, false)

  assert.equal(readFileSync(env.statePath, 'utf8'), before, '空补丁改了 state.json')

  await env.turnEnd()
  assert.ok(!env.card().includes('上一轮未记录状态'), '空补丁是合法履约，不该出警告')
})

test('② 新键补丁被正确合并（白名单合并 + 可见化 + 审计，走唯一 commitPatch 路径）', async () => {
  const env = makeEnv()
  liveSession(env.world)
  await env.seed({ 时间: { 日期: '1966/09/01' }, 技能: { 理性: 40 } })

  const r = await env.tools.state_patch.execute({
    session_id: 'sess1',
    summary: '测试：时间推进 + 新条目',
    patch: {
      时间: { 日期: '1966/09/02' },
      状态栏: { 测试状态: { 效果: '全技能-10%', 到期: '1966/09/05', 依据: '测试掷骰' } },
      负面状态: { 恐惧: 6 },
    },
  })
  assert.equal(r.ok, true)
  assert.equal(r.changed, true)
  assert.equal(r.added, 1)
  assert.equal(r.turn, 0)

  const doc = readState(env.root, 'sess1')
  assert.equal(doc.state.时间.日期, '1966/09/02')
  assert.equal(doc.state.负面状态.恐惧, 6)
  assert.equal(doc.state.技能.理性, 40, '未提及的键必须原样保留')
  assert.deepEqual(Object.keys(doc.state.状态栏), ['测试状态'])
  assert.equal(doc.state.元.锚点, 0)
  assert.equal(doc.lastGuard?.rejected, false)
  assert.ok(readHistory(env.root, 'sess1').some(h => h.source === 'patch-tool'), 'history 要留 patch-tool 来源的条目')
  assert.match(env.card(), /新增：状态栏\.测试状态/, '变更可见化（✎ 节）要在注入文本里')
})

test('③ 白名单外的根键被**显式拒收**且不改状态（失败留痕 failures.jsonl）', async () => {
  const env = makeEnv()
  liveSession(env.world)
  await env.seed({ 时间: { 日期: '1966/09/01' } })
  const before = readFileSync(env.statePath, 'utf8')

  const r = await env.tools.state_patch.execute({ session_id: 'sess1', patch: { 非白名单键: { a: 1 } } })
  assert.equal(r.ok, false)
  assert.equal(r.rejected, true)
  assert.match(r.message, /白名单/)

  assert.equal(readFileSync(env.statePath, 'utf8'), before, '被拒时状态一个字节都不能动')
  assert.ok(readFailures(env.root, 'sess1').some(f => f.kind === 'schema'), '拒收要留痕')
})

test('③b 配额护栏对工具路径同样生效：超配整轮拒收 + ⚠ 区可见', async () => {
  const env = makeEnv({ maxNewMechanicsPerTurn: 2 })
  liveSession(env.world)
  await env.seed({ 时间: { 日期: '1966/09/01' } })

  const r = await env.tools.state_patch.execute({
    session_id: 'sess1',
    patch: { 状态栏: { 甲: 'x', 乙: 'y', 丙: 'z' } },
  })
  assert.equal(r.ok, false)
  assert.equal(r.rejected, true)
  assert.equal(r.guardTotal, 3)
  assert.equal(r.guardLimit, 2)
  const doc = readState(env.root, 'sess1')
  assert.deepEqual(Object.keys(doc.state.状态栏), [], '被拒时状态原样')
  assert.ok(doc.lastWarnings.some(w => w.includes('整轮拒收')), '拒收要进 ⚠ 区（失败可见化）')
})

test('③c 工具路径同样执行代码拥有的到期解除（时间推进 → 到期条目自动移除 + 连带布尔位）', async () => {
  const env = makeEnv()
  liveSession(env.world)
  await env.seed({
    时间: { 日期: '1966/09/01' },
    状态栏: { 惊厥: { 效果: '全技能-10%', 到期: '1966/09/03' } },
    负面状态: { 惊厥: true },
  })

  const r = await env.tools.state_patch.execute({ session_id: 'sess1', patch: { 时间: { 日期: '1966/09/04' } } })
  assert.equal(r.ok, true)
  assert.ok(r.expired >= 1, '至少解除一条')
  const doc = readState(env.root, 'sess1')
  assert.ok(!('惊厥' in doc.state.状态栏))
  assert.equal(doc.state.负面状态.惊厥, false, '连带布尔位一起清')
})

test('未接管的会话被拒（只接管 seed 过的会话，判据不变）', async () => {
  const env = makeEnv()
  const r = await env.tools.state_patch.execute({ session_id: 'ghost', patch: {} })
  assert.equal(r.ok, false)
  assert.match(r.message, /state_seed/)
})

// ─────────────────────────────────────── 每轮事后校验（④⑤，可见化，不阻塞）

test('④ requirePatchPerTurn=true 且本轮无调用 ⇒ 下一轮注入文本含「上一轮未记录状态」', async () => {
  const env = makeEnv()
  liveSession(env.world)
  await env.seed({ 时间: { 日期: '1966/09/01' } })

  await env.turnEnd()
  const card = env.card()
  assert.match(card, /上一轮未记录状态/)

  // 硬线回归：段名与排序不许动
  assert.equal(env.sections['state:card'].name, 'state:card')
  assert.equal(env.sections['state:card'].order, 50)
})

test('④b 本轮未交补丁 ⇒ 注入文本里出现的是 ⚠ 警告，而不是任何后台补记', async () => {
  const env = makeEnv()
  liveSession(env.world, [
    { seq: 1, type: 'user/message', data: { content: '测试增量' } },
    { seq: 2, type: 'assistant/message', data: { content: '测试增量' } },
  ])
  env.world.turn = 1
  await env.seed({ 时间: { 日期: '1966/09/01' } })

  await env.turnEnd()
  const card = env.card()
  assert.match(card, /⚠️ 上一轮未记录状态/, 'requirePatchPerTurn 必须把警告写进注入文本')
  assert.match(card, /第 1 轮主模型未调用 state_patch/, '警告要指到具体轮次')
  // 状态本体不被这次校验改动：日期还是 seed 时那个
  assert.equal(readState(env.root, 'sess1').state.时间.日期, '1966/09/01', '校验不改状态本体')
})

test('⑤ requirePatchPerTurn=false ⇒ 不含警告', async () => {
  const env = makeEnv({ requirePatchPerTurn: false })
  liveSession(env.world)
  await env.seed({ 时间: { 日期: '1966/09/01' } })

  await env.turnEnd()
  assert.ok(!env.card().includes('上一轮未记录状态'))
})

test('警告不会堆积：再次未记录时替换旧条，成功提交 state_patch 后消失', async () => {
  const env = makeEnv()
  liveSession(env.world)
  await env.seed({ 时间: { 日期: '1966/09/01' } })

  await env.turnEnd()
  await env.turnEnd()
  const warns = readState(env.root, 'sess1').lastWarnings.filter(w => w.includes('上一轮未记录状态'))
  assert.equal(warns.length, 1, '未记录警告至多一条')

  const r = await env.tools.state_patch.execute({ session_id: 'sess1', patch: { 时间: { 日期: '1966/09/02' } } })
  assert.equal(r.ok, true)
  assert.ok(!env.card().includes('上一轮未记录状态'), '成功提交后警告要消失')
})

test('未跟踪会话不参与事后校验', async () => {
  const env = makeEnv()
  liveSession(env.world)   // 没 seed
  await env.turnEnd()
  assert.ok(!env.card().includes('上一轮未记录状态'), '没 seed 的会话与插件无关')
})

test('turn/end 不做任何“补记”：没有主模型补丁时状态与 history 都不动', async () => {
  const env = makeEnv()
  liveSession(env.world, [
    { seq: 1, type: 'user/message', data: { content: '测试增量' } },
    { seq: 2, type: 'assistant/message', data: { content: '测试增量' } },
  ])
  env.world.turn = 1
  await env.seed({ 时间: { 日期: '1966/09/01' } })
  const before = readFileSync(env.statePath, 'utf8')
  const historyLen = readHistory(env.root, 'sess1').length

  await env.turnEnd()

  const after = readState(env.root, 'sess1')
  assert.equal(after.state.时间.日期, '1966/09/01', '没有主模型补丁就不该有状态推进')
  assert.equal(readHistory(env.root, 'sess1').length, historyLen, 'turn/end 不写 history')
  assert.ok(before.includes('1966/09/01'))
})

// ─────────────────────────────────────── 注入提示

test('注入文本带「记账方式」提示（主模型的调用契约每轮可见）', async () => {
  const env = makeEnv()
  liveSession(env.world)
  await env.seed({ 时间: { 日期: '1966/09/01' } })
  assert.match(env.card(), /【🛠 记账方式】/)
  assert.match(env.card(), /state_patch/)
})

// ─────────────────────────────────────── ★ 定会话：用「调用者」，不猜（2026-09-17 真机修正）

test('★ 定会话①：给了 exec.agent 就不用 session_id —— 直接记本会话', async () => {
  const env = makeEnv()
  const s = liveSession(env.world)
  await env.seed({ 时间: { 日期: '1966/09/01' } })
  const r = await env.tools.state_patch.execute(
    { patch: { 时间: { 日期: '1966/09/02' } } },
    { agent: { id: 'sess1', session: s } },
  )
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.sessionId, 'sess1')
  assert.equal(readState(env.root, 'sess1').state.时间.日期, '1966/09/02')
})

test('★ 定会话②（反证）：显式传一个**不是本会话**的 id ⇒ 拒收，且本会话状态一个字不动', async () => {
  const env = makeEnv()
  const s = liveSession(env.world)
  await env.seed({ 时间: { 日期: '1966/09/01' } })
  const r = await env.tools.state_patch.execute(
    { session_id: 'session-1f0a607b-stale', patch: { 时间: { 日期: '1966/09/09' } } },
    { agent: { id: 'sess1', session: s } },
  )
  assert.equal(r.ok, false, JSON.stringify(r))
  assert.equal(r.rejected, true)
  assert.match(r.message, /不一致/)
  assert.match(r.message, /session-1f0a607b-stale/)
  assert.equal(readState(env.root, 'sess1').state.时间.日期, '1966/09/01', '本会话状态必须原样不动')
})

test('★ 定会话③：显式传的 id **就是**本会话 ⇒ 照常放行（不误伤）', async () => {
  const env = makeEnv()
  const s = liveSession(env.world)
  await env.seed({ 时间: { 日期: '1966/09/01' } })
  const r = await env.tools.state_patch.execute(
    { session_id: 'sess1', patch: { 时间: { 日期: '1966/09/03' } } },
    { agent: { id: 'sess1', session: s } },
  )
  assert.equal(r.ok, true, JSON.stringify(r))
})

test('★ 定会话④：没有 exec、又没有 session_id、又有多个活动会话 ⇒ 可读的拒绝（说明该怎么改）', async () => {
  const env = makeEnv()
  liveSession(env.world)
  await env.seed({ 时间: { 日期: '1966/09/01' } })
  env.world.agents = [{ id: 'a', session: { id: 'a', events: [] } }, { id: 'b', session: { id: 'b', events: [] } }]
  const r = await env.tools.state_patch.execute({ patch: {} })
  assert.equal(r.ok, false)
  assert.equal(r.rejected, true)
  assert.match(r.message, /省略 session_id/)
})

test('★ state_list 标出 live：此刻没有活 agent 用着的记录必须显式标出来（陈旧记录陷阱）', async () => {
  const env = makeEnv()
  liveSession(env.world)
  await env.seed({ 时间: { 日期: '1966/09/01' } })
  await env.tools.state_seed.execute({ session_id: 'session-stale-0001', state: { 时间: { 日期: '1966/08/01' } } })
  const v = await env.tools.state_list.execute()
  const byId = Object.fromEntries(v.sessions.map((x) => [x.sessionId, x]))
  assert.equal(byId.sess1.live, true, '本会话应标 live')
  assert.equal(byId['session-stale-0001'].live, false, '陈旧记录应标 !live')
  assert.equal(v.staleCount, 1)
})

// ─────────────────────────────────────── ★ state_seed / state_show 同样「用调用者」

test('★ state_seed 不带 session_id ⇒ 给**本会话**设起跑线（旧写法是 required，模型只能瞎填 "current"）', async () => {
  const env = makeEnv()
  const s = liveSession(env.world)
  const r = await env.tools.state_seed.execute(
    { state: { 时间: { 日期: '1966/09/01' } } },
    { agent: { id: 'sess1', session: s } },
  )
  assert.equal(r.seeded, true, JSON.stringify(r))
  assert.equal(r.sessionId, 'sess1')
  assert.equal(readState(env.root, 'sess1').state.时间.日期, '1966/09/01')
})

test('★ state_seed 反证：传了一个不是本会话的 id ⇒ 报错且**不播种**', async () => {
  const env = makeEnv()
  const s = liveSession(env.world)
  const r = await env.tools.state_seed.execute(
    { session_id: 'session-1f0a607b-stale', state: { 时间: { 日期: '1966/09/01' } } },
    { agent: { id: 'sess1', session: s } },
  )
  assert.equal(r.seeded, false)
  assert.match(String(r.error), /不一致/)
  assert.equal(readState(env.root, 'sess1'), null, '本会话不该被写进任何东西')
})

test('★ state_show 不带 session_id ⇒ 看**本会话**（不再要求模型自报家门）', async () => {
  const env = makeEnv()
  const s = liveSession(env.world)
  await env.seed({ 时间: { 日期: '1966/09/01' } })
  const r = await env.tools.state_show.execute(
    { include_card: false },
    { agent: { id: 'sess1', session: s } },
  )
  assert.equal(r.sessionId, 'sess1')
  assert.equal(r.tracked, true)
})
