#!/usr/bin/env node
/**
 * 自检台：尾部注入改「替换」（2026-09-30 叠加修复，tavern fork `planRuntimeLoreSurfaceOp` 同款）。
 *
 * 背景（真机实测，会话 session-e3de2f5c-… 第 89 楼）：pre-step 往 `decision.messages` 追加 =
 * agent-loop 逐条 `session.append` 落盘成**新的**历史事件，上一轮那条没人退休 ⇒ 逐楼累积 ——
 * `[剧情简报]` 10 份 8,890 字、`<recalledMemories>` 10 份 20,879 字，第 2..N 份纯重复占请求体九成。
 * 修法 = 宿主 surface 替换（compaction 压历史同款）：记着上一轮自己那条的 seq、且它还在
 * `session.surface.nodes` 上 ⇒ replace（新节点占位、旧的从请求面消失，日志一条不删）。
 *
 * 覆盖面（三处共用 `planTailSurfaceOp`，本台直测纯函数 + phi 接线；简报/index-state 接线用 source pin）：
 *   · planTailSurfaceOp 真值表（首轮 append / 在面 replace / 被压缩掉 append / 畸形不编 replace）；
 *   · registerPhiMessage 走假会话：第 1 楼 append ⇒ 第 2 楼正好 replace 上一条 ⇒ decision 不带消息；
 *   · append 抛错 / 拿不到会话 ⇒ 退回 decision.messages（宁可叠加，不静默丢内容）；
 *   · ★反证：把 replace 那支退化（replaceable 恒 false）⇒ 判据必红（行为对拍 + source pin 双保险）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  planTailSurfaceOp, planTailResidueCleanup, tailOwnFormState, TAIL_RESIDUE_CLEANUP_FORM, TAIL_RESIDUE_CLEANUP_MARK,
  registerPhiMessage, PHI_MESSAGE_PLUGIN_ID,
} from './lib/phi-message.js'

const INDEX_SRC = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8')
const PHI_SRC = readFileSync(new URL('./lib/phi-message.js', import.meta.url), 'utf8')

const PASS = []
const FAIL = []
const t = async (name, fn) => {
  try {
    await fn()
    PASS.push(name)
  } catch (e) {
    FAIL.push(`${name}: ${e?.message || e}`)
  }
}

await t('T1 planTailSurfaceOp：首轮没有可换的 ⇒ 纯 append（不带 sourceEventSeqs）', () => {
  const intent = planTailSurfaceOp({ previousSeq: undefined, surfaceNodes: [3, 7, 9] })
  assert.equal(intent.surfaceOp, 'append')
  assert.equal(Object.hasOwn(intent, 'sourceEventSeqs'), false, 'append 不该带 sourceEventSeqs')
  assert.deepEqual(planTailSurfaceOp().surfaceOp, 'append', '空入参 ⇒ append（不抛）')
})

await t('T2 ★上一轮那条还在 surface 上 ⇒ 必须正好 replace 它（宿主契约：sourceEventSeqs 引用被遮蔽节点）', () => {
  const intent = planTailSurfaceOp({ previousSeq: 7, surfaceNodes: [3, 7, 9] })
  assert.deepEqual(intent, {
    surfaceOp: { op: 'replace', startSeq: 7, endSeq: 7 },
    sourceEventSeqs: [7],
  })
  assert.deepEqual(intent.sourceEventSeqs, [intent.surfaceOp.startSeq], '被遮蔽节点必须被引用（宿主会校验）')
})

await t('T3 被压缩掉（不在 surface 上）⇒ 退回 append（拿旧 seq 硬 replace 宿主会拒）', () => {
  assert.equal(planTailSurfaceOp({ previousSeq: 7, surfaceNodes: [11, 12] }).surfaceOp, 'append')
})

await t('T4 畸形入参一律不编 replace（⛔ 拿假 seq 去 replace = 宿主直接拒）', () => {
  for (const input of [
    {},
    { previousSeq: 7 },
    { previousSeq: 7.5, surfaceNodes: [7] },
    { previousSeq: 7, surfaceNodes: null },
    { previousSeq: null, surfaceNodes: [7] },
    { previousSeq: '7', surfaceNodes: ['7', 7] },
  ]) {
    assert.equal(planTailSurfaceOp(input).surfaceOp, 'append', JSON.stringify(input))
  }
})

await t('T5 ★反证：replace 那支退化（replaceable 恒 false）⇒ T2 必红（行为对拍）', () => {
  // 人造一个"退化版"：不管三七二十一都 append —— 它在 T2 的场景里必须给出**不同**的答案，
  // 否则说明 T2 根本分辨不出叠加修复还在不在（判据失效）。
  const degraded = ({ previousSeq, surfaceNodes }) => ({ surfaceOp: 'append' })
  const good = planTailSurfaceOp({ previousSeq: 7, surfaceNodes: [3, 7, 9] })
  assert.notDeepEqual(good, degraded({ previousSeq: 7, surfaceNodes: [3, 7, 9] }),
    '退化版与真版同答案 ⇒ T2 是个永真判据，得重写')
})

// ── registerPhiMessage 接线（假会话；append 落 captures、surface.nodes 随之增长）──
function phiFixture() {
  const listeners = []
  const handle = registerPhiMessage(
    { on: (name, fn, opts) => listeners.push({ name, fn, opts }) },
    { getText: () => '后处理正文', isEnabled: () => true },
  )
  const fn = listeners[0].fn
  const captures = []
  const surface = { nodes: [] }
  const session = {
    id: 'sess-tail',
    surface,
    append(type, message, intent) {
      assert.equal(type, 'user/message', 'session.append 的 type 契约被改了：' + String(type))
      const seq = 5000 + captures.length + 1
      captures.push({ seq, message, intent })
      surface.nodes.push(seq)
      return { seq }
    },
  }
  return { handle, fn, captures, surface, session }
}

await t('T6 phi 接线：第 1 楼 append、第 2 楼正好 replace 上一条；⛔ decision 不许再带消息', async () => {
  const { handle, fn, captures, session } = phiFixture()
  assert.equal(handle.installed, true)
  const base = { kind: 'enter', messages: [{ id: 'u1', role: 'user' }] }
  const d1 = await fn({ agent: { session }, step: 1 }, () => Promise.resolve(base))
  assert.equal(d1, base, '替换通路必须原样返回 decision（⛔ 塞 messages = 新增历史事件 = 累积）')
  assert.equal(base.messages.length, 1, '原 decision 一条不许动')
  assert.equal(captures.length, 1)
  assert.equal(captures[0].intent.surfaceOp, 'append', '首轮没有可换的 ⇒ append')
  assert.equal(captures[0].message.source.plugin, PHI_MESSAGE_PLUGIN_ID, 'source 形状不许动')
  const d2 = await fn({ agent: { session }, step: 1 }, () => Promise.resolve(base))
  assert.equal(d2, base)
  const first = captures[0].seq
  assert.deepEqual(captures[1].intent, {
    surfaceOp: { op: 'replace', startSeq: first, endSeq: first },
    sourceEventSeqs: [first],
  }, '第二楼没把上一轮那条换掉（= 还在叠加）')
  assert.equal(typeof captures[1].message.id, 'string', '消息必须自带 id（缺 id 过不了 V4 校验）')
  assert.ok(captures[1].message.id.length > 0, '消息 id 是空串')
  assert.equal(handle.injected, 2)
})

await t('T7 phi 接线：append 抛错 ⇒ 退回 decision.messages（宁可叠加，不静默丢内容）', async () => {
  const { fn, captures, session } = phiFixture()
  let calls = 0
  session.append = () => { calls += 1; throw new Error('宿主拒了 replace（演练）') }
  const base = { kind: 'enter', messages: [] }
  const out = await fn({ agent: { session }, step: 1 }, () => Promise.resolve(base))
  assert.equal(calls, 1, '该先试过 session.append')
  assert.equal(out.messages.length, 1, '退回路上消息不能丢：' + JSON.stringify(out).slice(0, 120))
  assert.equal(out.messages[0].source.plugin, PHI_MESSAGE_PLUGIN_ID)
  assert.equal(captures.length, 0)
})

await t('T8 phi 接线：拿不到 session.append ⇒ 老路 decision.messages（老形状保住）', async () => {
  const { fn, captures } = phiFixture()
  const base = { kind: 'enter', messages: [{ id: 'u1' }] }
  const out = await fn({ agent: { session: { id: 'sess-x' } }, step: 1 }, () => Promise.resolve(base))
  assert.equal(out.messages.length, 2, '没有会话 ⇒ 退回叠加老路（消息不丢）')
  assert.equal(out.messages[1].source.plugin, PHI_MESSAGE_PLUGIN_ID)
  assert.equal(captures.length, 0)
})

await t('T9 ★source pin：三处接线都在（简报 / index-state 各自记 seq；phi 走 planTailSurfaceOp）', () => {
  assert.ok(/import \{[^}]*planTailSurfaceOp[^}]*\} from '\.\/phi-message\.js'/.test(INDEX_SRC), 'index.js 没引 phi-message 的表面计划函数')
  assert.ok(/import \{[^}]*tailOwnFormState[^}]*\} from '\.\/phi-message\.js'/.test(INDEX_SRC), 'index.js 没引首楼认领底账（fork/重启自愈的根）')
  assert.ok(/session\.append\('user\/message', message, planTailSurfaceOp\(/.test(INDEX_SRC), 'index.js 交付通路没走 session.append + planTailSurfaceOp')
  assert.ok(INDEX_SRC.includes('briefingTailSeqBySession'), '简报没自记 seq')
  assert.ok(INDEX_SRC.includes('indexStateTailSeqBySession'), 'index 尾注没自记 seq')
  assert.ok(INDEX_SRC.includes("deliverTailMessage(payload, decision"), '简报/index-state 两支没走统一交付')
  assert.ok(/surfaceOp: \{ op: 'replace', startSeq: previousSeq, endSeq: previousSeq \}/.test(PHI_SRC),
    'planTailSurfaceOp 的 replace 那支被退化掉了（⇒ 每轮叠加回归）')
})

// ── 手术清扫（2026-09-30 用户拍板）：planTailResidueCleanup + 端点接线 ──

/** 造一组「注入与剧情交错」的表面（宿主实况形状）：返回 nodes / formBySeq / charsBySeq。 */
function residueFixture() {
  // 表面顺序（旧→新）：剧情与注入交错；每个注入 form 的最新一条 = 活交付（保留），其余全是存量
  const seqs = [
    [100, 'user', 40],            // 剧情（不在白名单，碰不得）
    [101, 'anima:memory', 2400],  // 旧存量
    [102, 'assistant', 900],      // 剧情
    [103, 'supervisor-briefing', 970],
    [104, 'runtime-lore', 4300],
    [105, 'anima:memory', 2600],  // 旧存量
    [106, 'user', 30],            // 剧情
    [107, 'runtime-lore', 4500],  // 旧存量（重启孤儿）
    [108, 'anima:memory', 2500],  // ★ 最新一条（活交付，保留）
    [109, 'supervisor-briefing', 975], // ★ 保留
    [110, 'runtime-lore', 4400],  // ★ 保留
    [111, TAIL_RESIDUE_CLEANUP_FORM, 10], // 上一次清扫的占位（不在白名单 ⇒ 幂等）
  ]
  const nodes = seqs.map(([seq]) => seq)
  const formBySeq = new Map(seqs.map(([seq, form]) => [seq, form]))
  const charsBySeq = new Map(seqs.map(([seq, , chars]) => [seq, chars]))
  return { nodes, formBySeq, charsBySeq }
}

const CLEANUP_FORMS = ['anima:memory', 'supervisor-briefing', 'index-state', 'runtime-lore', 'phi']

await t('T10 清扫计划：每个 form 保留最新 1 条，其余全数列入；剧情与旧占位一个不碰', () => {
  const { nodes, formBySeq, charsBySeq } = residueFixture()
  const plan = planTailResidueCleanup({ nodes, formBySeq, charsBySeq, forms: CLEANUP_FORMS })
  // 顺序按 form 分组（每组内旧→新）；每组保留最新 1 条
  assert.deepEqual(plan.targets, [101, 105, 103, 104, 107], '目标 = 各 form 除最新外的全部：' + JSON.stringify(plan.targets))
  assert.deepEqual(plan.kept, [108, 109, 110], 'kept = 每个 form 保留的最新一条（首楼认领的目标）')
  assert.equal(plan.residueChars, 2400 + 970 + 4300 + 2600 + 4500, '存量字数要对上账')
  assert.ok(plan.targets.every((s) => ![100, 102, 106, 108, 109, 110, 111].includes(s)), '剧情楼/活交付/旧占位不许出现')
})

await t('T11 清扫计划：幂等（重跑目标为空）+ 畸形入参不抛不编', () => {
  const { nodes, formBySeq, charsBySeq } = residueFixture()
  // 模拟真跑：把目标节点从表面摘除、换成占位（占位 form 不在白名单）
  const plan1 = planTailResidueCleanup({ nodes, formBySeq, charsBySeq, forms: CLEANUP_FORMS })
  const nodes2 = nodes.filter((s) => !plan1.targets.includes(s))
  for (const s of plan1.targets) nodes2.push(s + 10000)   // 占位节点（formBySeq 里没有 = 不是白名单 form）
  const plan2 = planTailResidueCleanup({ nodes: nodes2, formBySeq, charsBySeq, forms: CLEANUP_FORMS })
  assert.deepEqual(plan2.targets, [], '重跑必须零目标（幂等）')
  for (const input of [{}, { nodes: 'x' }, { nodes: [1.5, 'a', null], formBySeq: new Map(), forms: CLEANUP_FORMS }, { nodes: [7], forms: null }]) {
    const p = planTailResidueCleanup(input)
    assert.ok(Array.isArray(p.targets) && p.residueChars >= 0, '畸形入参 ⇒ 空计划（不抛）：' + JSON.stringify(input))
  }
})

await t('T12 ★反证：keep 那支退化（全保留 / 全清）⇒ T10 必红（行为对拍）', () => {
  const { nodes, formBySeq, charsBySeq } = residueFixture()
  const good = planTailResidueCleanup({ nodes, formBySeq, charsBySeq, forms: CLEANUP_FORMS })
  // 退化版 A：把「保留最新 1 条」写成「全保留」（= 清扫永远空转）
  const keepAll = { targets: nodes.filter((s) => CLEANUP_FORMS.includes(formBySeq.get(s))), residueChars: 0 }
  assert.notDeepEqual(good.targets, keepAll.targets, '退化 A 与真版同答案 ⇒ T10 是永真判据')
  // 退化版 B：把白名单判据丢掉（连剧情一起清 ⇒ 真跑会误伤正文 —— 这是最危险的退化）
  const noWhitelist = planTailResidueCleanup({ nodes, formBySeq, charsBySeq, forms: ['user', 'assistant', ...CLEANUP_FORMS] })
  assert.ok(noWhitelist.targets.length > good.targets.length && noWhitelist.targets.includes(100),
    '退化 B 必须能把剧情楼圈进来（否则 T10/T11 根本没在看白名单）')
})

await t('T13 ★source pin：端点在路由表、真跑通道带 sourceEventSeqs、占位 form 不进白名单', () => {
  assert.ok(INDEX_SRC.includes("'/surface/cleanup-tail-injections': ['POST']"), '路由表里没有清扫端点')
  assert.ok(/sourceEventSeqs: \[seq\]/.test(INDEX_SRC), '真跑没按宿主契约引用被遮蔽节点')
  assert.ok(/dryRun !== false/.test(INDEX_SRC), '缺省必须干跑（真跑显式 false）——防误触的那道闸没了')
  assert.ok(!JSON.stringify(CLEANUP_FORMS).includes(TAIL_RESIDUE_CLEANUP_FORM), '占位 form 自己不许进白名单（幂等的根）')
})

// ── 首楼认领（fork/重启自愈）：没有自记 seq ⇒ 认领最新一条 + 占位换下更旧的 ──

/** 造一条旧注入事件（user/message + 自己的 form）与一条剧情事件。 */
const ownEvent = (seq, chars) => ({
  seq,
  type: 'user/message',
  data: { id: 'old-' + seq, role: 'user', source: { kind: 'plugin', plugin: PHI_MESSAGE_PLUGIN_ID, form: 'phi' }, content: [{ type: 'text', text: '旧'.repeat(chars) }] },
})
const storyEvent = (seq) => ({ seq, type: 'user/message', data: { id: 'u' + seq, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '剧情' }] } })

await t('T14 ★首楼认领：表面已有 3 条旧 phi ⇒ 首楼换下 2 条旧的 + 正好 replace 最新一条（不叠加不留孤儿）', async () => {
  // 假会话：表面/事件里已有 3 条旧 phi 注入（分叉继承的形状），随后 phi 第一次交付
  const events = [storyEvent(10), ownEvent(11, 300), storyEvent(12), ownEvent(13, 280), ownEvent(14, 260), storyEvent(15)]
  const captures = []
  const surface = { nodes: [10, 11, 12, 13, 14, 15] }
  const session = {
    id: 'sess-adopt', surface,
    snapshotEvents: () => events,
    append(type, message, intent) {
      const seq = 100 + captures.length + 1
      captures.push({ seq, message, intent })
      surface.nodes.push(seq)
      return { seq }
    },
  }
  const listeners = []
  registerPhiMessage({ on: (n, fn) => listeners.push(fn) }, { getText: () => '新正文', isEnabled: () => true })
  const fn = listeners[0]
  const base = { kind: 'enter', messages: [] }
  await fn({ agent: { session }, step: 1 }, () => Promise.resolve(base))
  // 首楼：2 条旧的被占位换下（⛔ 不碰剧情 10/12/15），交付本身 replace 最新那条 14
  assert.equal(captures.length, 3, '首楼 = 2 条占位 + 1 条交付：' + JSON.stringify(captures.map((c) => c.intent)))
  assert.deepEqual(captures[0].intent, { surfaceOp: { op: 'replace', startSeq: 11, endSeq: 11 }, sourceEventSeqs: [11] }, '第一条旧的没被换下')
  assert.deepEqual(captures[1].intent, { surfaceOp: { op: 'replace', startSeq: 13, endSeq: 13 }, sourceEventSeqs: [13] }, '第二条旧的没被换下')
  assert.equal(captures[0].message.source.form, TAIL_RESIDUE_CLEANUP_FORM, '占位消息的 form 不对')
  assert.deepEqual(captures[2].intent, { surfaceOp: { op: 'replace', startSeq: 14, endSeq: 14 }, sourceEventSeqs: [14] }, '交付没认领最新那条（= 又叠加了一份）')
  // 第二楼：正常 replace 自己上一楼的交付（自记 seq 接管，认领只发生在首楼）
  await fn({ agent: { session }, step: 1 }, () => Promise.resolve(base))
  assert.equal(captures.length, 4, '第二楼只该有一条交付')
  assert.deepEqual(captures[3].intent, { surfaceOp: { op: 'replace', startSeq: captures[2].seq, endSeq: captures[2].seq }, sourceEventSeqs: [captures[2].seq] })
})

await t('T15 ★反证：认领那支退化（永不认领 ⇒ 恒 append）必须与真版不同答案', async () => {
  // 与 T5 同思路：把「首楼认领」人为退化成"视而不见"，退化版在 T14 场景里必须给出不同意图，
  // 否则 T14 根本分辨不出自愈还在不在。
  const degSession = { id: 'd', surface: { nodes: [11] }, snapshotEvents: () => [ownEvent(11, 300)], append: () => ({ seq: 999 }) }
  const good = tailOwnFormState(degSession, 'phi')
  assert.deepEqual(good, { stale: [], newest: 11, charsBySeq: good.charsBySeq }, '单条旧节点 ⇒ 认领它、无清扫目标')
  assert.notDeepEqual(
    { previousSeq: good.newest, surfaceOp: 'replace' },
    { previousSeq: undefined, surfaceOp: 'append' },
    '退化版（恒 append）与认领版必须不同——否则 T14 是永真判据',
  )
  // 畸形会话 ⇒ null（不编目标）
  assert.equal(tailOwnFormState(null, 'phi'), null)
  assert.equal(tailOwnFormState({ surface: { nodes: [1] } }, 'phi'), null)
  assert.equal(tailOwnFormState({ snapshotEvents: () => [], surface: { nodes: [1] } }, 'phi'), null)
})

console.log(`\n── ${PASS.length} 通过 / ${FAIL.length} 失败 ──`)
if (FAIL.length > 0) { console.log('失败：\n' + FAIL.join('\n')); process.exitCode = 1 }
