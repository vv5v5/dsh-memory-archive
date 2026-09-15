/**
 * patch-tool 模式单测：state_patch 工具、每轮事后校验（可见化）、配置开关、旧副 API 路径保留。
 * 跑法: node --test tests/patch-tool.test.mjs
 *
 * 用一个最小 mock 宿主（ctx）直接驱动 apply()：不依赖 DSH 宿主、不联网 ——
 * 副 API 路径用桩 fetch 喂标准的 submit_state_patch 工具调用响应。
 * 所有状态数据都是本文件编造的测试夹具，与任何真实会话无关。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, config as exportedConfig } from '../lib/index.js'
import { buildToolSchema } from '../lib/schema.js'
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
  const auditPath = join(root, 'sessions', 'sess1', 'audit.jsonl')
  const sess = () => world.agents[0]?.session

  return {
    root, handlers, tools, sections, world, statePath, auditPath, sess,
    /** 派一个 turn/end，并借装配门闩有界等待在途副 API 任务落地。 */
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

/** 桩 fetch：喂一个标准的 submit_state_patch 工具调用响应；返回还原函数。 */
function fakeFetch(change, summary = '测试依据') {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true, status: 200, text: async () => '',
    json: async () => ({
      choices: [{
        finish_reason: 'tool_calls',
        message: { tool_calls: [{ type: 'function', function: { name: 'submit_state_patch', arguments: JSON.stringify({ summary, change }) } }] },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  })
  return () => { globalThis.fetch = original }
}

const auditOf = (env) => (existsSync(env.auditPath) ? readFileSync(env.auditPath, 'utf8') : '')

// ─────────────────────────────────────── 配置开关（新默认）

test('新默认：mode=patch-tool、sideApi.enabled=false、requirePatchPerTurn=true', () => {
  assert.equal(exportedConfig.mode, 'patch-tool')
  assert.equal(exportedConfig.sideApi?.enabled, false)
  assert.equal(exportedConfig.requirePatchPerTurn, true)
})

test('state_patch 已注册，且 patch 入参与 submit_state_patch 的 change 完全同构（同一生成器）', () => {
  const env = makeEnv()
  const t = env.tools.state_patch
  assert.ok(t, 'state_patch 未注册')
  assert.deepEqual(
    t.parameters.properties.patch,
    buildToolSchema().function.parameters.properties.change,
    '两处必须出自同一个 changeSchema()，不许各写一份',
  )
  assert.deepEqual(t.parameters.required, ['patch'])
  assert.equal(t.parameters.additionalProperties, false)
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

test('② 新键补丁被正确合并（白名单合并 + 可见化 + 审计，走与副 API 相同的路径）', async () => {
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

// ─────────────────────────────────────── 副 API：默认关、兜底开、旧路径完整保留

test('patch-tool 默认（sideApi 关）⇒ turn/end 不触发任何副 API 调用，只走可见校验', async () => {
  const env = makeEnv()
  const s = liveSession(env.world, [
    { seq: 1, type: 'user/message', data: { content: '测试增量' } },
    { seq: 2, type: 'assistant/message', data: { content: '测试增量' } },
  ])
  env.world.turn = 1
  await env.seed({ 时间: { 日期: '1966/09/01' } })
  const auditBefore = auditOf(env)

  await env.turnEnd()
  assert.equal(auditOf(env), auditBefore, 'audit 无新条目 = 副 API 没被调')
  assert.match(env.card(), /上一轮未记录状态/, '这轮走的是可见校验路径')
  void s
})

test('patch-tool + sideApi.enabled ⇒ 主模型没交补丁的轮次由副 API **兜底**补记，且不出未记录警告', async () => {
  const env = makeEnv({
    mode: 'patch-tool', sideApi: { enabled: true },
    api: { key: 'test-key', url: 'http://127.0.0.1:9/v1' }, attempts: 1,
  })
  liveSession(env.world, [
    { seq: 1, type: 'user/message', data: { content: '测试增量' } },
    { seq: 2, type: 'assistant/message', data: { content: '测试增量' } },
  ])
  env.world.turn = 1
  await env.seed({ 时间: { 日期: '1966/09/01' } })

  const restore = fakeFetch({ 时间: { 日期: '1966/09/02' } })
  try { await env.turnEnd() } finally { restore() }

  assert.equal(readState(env.root, 'sess1').state.时间.日期, '1966/09/02', '兜底补记生效')
  assert.ok(!env.card().includes('上一轮未记录状态'), '兜底成功 → 不出警告')
})

test('旧路径保留：mode=tool + sideApi.enabled=true ⇒ turn/end 照旧副 API 强制工具调用，且注入文本无 patch-tool 提示', async () => {
  const env = makeEnv({
    mode: 'tool', sideApi: { enabled: true },
    api: { key: 'test-key', url: 'http://127.0.0.1:9/v1' }, attempts: 1,
  })
  liveSession(env.world, [
    { seq: 1, type: 'user/message', data: { content: '测试增量' } },
    { seq: 2, type: 'assistant/message', data: { content: '测试增量' } },
  ])
  env.world.turn = 1
  await env.seed({ 时间: { 日期: '1966/09/01' } })

  const restore = fakeFetch({ 时间: { 日期: '1966/09/09' } })
  try { await env.turnEnd() } finally { restore() }

  assert.equal(readState(env.root, 'sess1').state.时间.日期, '1966/09/09')
  assert.ok(!env.card().includes('记账方式'), '旧模式注入文本与 v0.1 对齐（无 usageHint）')
})

test('旧路径默认不再自动跑：mode=tool 但未开 sideApi.enabled ⇒ turn/end 不调副 API、也不做 patch-miss 校验', async () => {
  const env = makeEnv({ mode: 'tool' })
  liveSession(env.world, [
    { seq: 1, type: 'user/message', data: { content: '测试增量' } },
    { seq: 2, type: 'assistant/message', data: { content: '测试增量' } },
  ])
  env.world.turn = 1
  await env.seed({ 时间: { 日期: '1966/09/01' } })
  const auditBefore = auditOf(env)

  await env.turnEnd()
  assert.equal(auditOf(env), auditBefore, 'sideApi.enabled=false 时旧路径不跑')
  assert.ok(!env.card().includes('上一轮未记录状态'), '旧模式没有 patch-miss 校验（记账责任在副 API）')
})

// ─────────────────────────────────────── 注入提示与相关工具

test('patch-tool 模式的注入文本带「记账方式」提示（主模型的调用契约每轮可见）', async () => {
  const env = makeEnv()
  liveSession(env.world)
  await env.seed({ 时间: { 日期: '1966/09/01' } })
  assert.match(env.card(), /【🛠 记账方式】/)
  assert.match(env.card(), /state_patch/)
})

test('state_rerun 在副 API 关闭时给出明确指引（不偷偷调 API）', async () => {
  const env = makeEnv()
  const r = await env.tools.state_rerun.execute({ session_id: 'sess1' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /state_patch/)
})
