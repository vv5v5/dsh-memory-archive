#!/usr/bin/env node
/**
 * 自检台：lib/phi-message.js —— 后处理提示词「作为玩家消息注入」（2026-09-20 用户拍板：默认开）。
 *
 * 用户口径（原文）：「多就多吧，没招了。我现在的后处理提示词也就388个字。应该能顶」
 *   +「注意做好清洗，提示词查看器不抓这个字段做楼层，也不被记忆库收录」。
 *
 * 本台子只测**纯逻辑与接线形状**（注入决定 / 消息形状 / pre-step 合并 / 绝不抛）：
 *   · 真机行为（放进请求、落进日志）在宿主侧验；
 *   · 两处清洗的台子分别在 _selftest-messages.mjs（查看器）与 _selftest-collect-scan.mjs（归档）。
 */
import assert from 'node:assert/strict'
import {
  PHI_MESSAGE_PLUGIN_ID, PHI_MESSAGE_FORM, PHI_MESSAGE_MARK,
  wrapPhiText, phiUserMessage, shouldInjectPhi, registerPhiMessage,
} from './lib/phi-message.js'

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

await t('P1 wrapPhiText：包一层标记（⛔ 裸发会被模型当成玩家发言）；空文本 ⇒ 空串', () => {
  assert.equal(wrapPhiText(''), '')
  assert.equal(wrapPhiText('   '), '')
  assert.equal(wrapPhiText(null), '')
  const out = wrapPhiText('  测试文本  ')
  assert.ok(out.startsWith(PHI_MESSAGE_MARK), '开头必须是那行标记：' + out.slice(0, 40))
  assert.ok(out.endsWith('测试文本'), '正文原样保留（trim 掉首尾空白）：' + out)
})

await t('P2 phiUserMessage：形状与宿主 createUserMessage 逐字一致（id/role/content/source）', () => {
  const m = phiUserMessage('甲')
  assert.equal(m.role, 'user', '必须是 user 角色（只有它能落在玩家消息之后）')
  assert.equal(typeof m.id, 'string')
  assert.ok(m.id.length >= 8, 'id 必须是一枚真 id（宿主 createMessage 也是 randomUUID）')
  assert.deepEqual(Object.keys(m).sort(), ['content', 'id', 'role', 'source'], '字段集不许漂：' + JSON.stringify(Object.keys(m)))
  assert.equal(m.source.kind, 'plugin', '⛔ 必须是 plugin —— 两边清洗都按这个结构性判据认人')
  assert.equal(m.source.plugin, PHI_MESSAGE_PLUGIN_ID)
  assert.equal(m.source.form, PHI_MESSAGE_FORM)
  assert.equal(m.content.length, 1)
  assert.equal(m.content[0].type, 'text')
  assert.ok(m.content[0].text.includes('甲'))
  // 每次一枚新 id（宿主也是 randomUUID）—— 同一条文本注两次不该是同一条消息
  assert.notEqual(phiUserMessage('甲').id, phiUserMessage('甲').id)
})

await t('P3 shouldInjectPhi 真值表：开着 + 有正文 + 第 1 步 ⇒ 注；其余一律不注（各报各的原因）', () => {
  assert.deepEqual(shouldInjectPhi({ enabled: true, step: 1, text: '正文' }), { inject: true, reason: 'ok' })
  assert.equal(shouldInjectPhi({ enabled: false, step: 1, text: '正文' }).reason, 'switch-off')
  assert.equal(shouldInjectPhi({ enabled: true, step: 1, text: '   ' }).reason, 'no-text')
  assert.equal(shouldInjectPhi({ enabled: true, step: 1, text: null }).reason, 'no-text')
  // ⛔ 只在第 1 步：后面的步骤历史里已经有这一条了，再注就是重复
  assert.equal(shouldInjectPhi({ enabled: true, step: 2, text: '正文' }).reason, 'not-first-step')
  assert.equal(shouldInjectPhi({}).inject, false, '畸形入参 ⇒ 不注、不抛')
})

await t('P4 registerPhiMessage：prepend 挂 pre-step、先走 next() 再往 decision.messages 末尾追加', async () => {
  const listeners = []
  const ctx = { on: (name, fn, opts) => { listeners.push({ name, fn, opts }) } }
  const h = registerPhiMessage(ctx, { getText: () => '正文', isEnabled: () => true })
  assert.equal(h.installed, true)
  assert.equal(listeners.length, 1)
  assert.equal(listeners[0].name, 'agent/pre-step')
  assert.equal(listeners[0].opts.prepend, true, '官方 time-context 同款：抢在最外层')
  const base = { kind: 'enter', messages: [{ id: 'u1', role: 'user' }] }
  let nextCalled = 0
  const out = await listeners[0].fn({ agent: { session: { id: 's1' } }, step: 1 }, () => { nextCalled += 1; return Promise.resolve(base) })
  assert.equal(nextCalled, 1, '必须先走 next()（不改变链上其它人的结果）')
  assert.equal(out.messages.length, 2)
  assert.equal(out.messages[0].id, 'u1', '原有消息一条不许动')
  assert.equal(out.messages[1].source.kind, 'plugin')
  assert.equal(out.messages[1].source.plugin, PHI_MESSAGE_PLUGIN_ID)
  assert.equal(h.injected, 1)
})

await t('P5 ★ 反证：关掉 / 拿不到正文 / 不是第 1 步 ⇒ **一条都不加**（decision 原样返回）', async () => {
  const mk = (deps) => {
    const listeners = []
    registerPhiMessage({ on: (n, fn, o) => listeners.push({ fn, o }) }, deps)
    return listeners[0].fn
  }
  const base = { kind: 'enter', messages: [{ id: 'u1' }] }
  for (const deps of [
    { getText: () => '正文', isEnabled: () => false },   // 开关关
    { getText: () => '', isEnabled: () => true },        // 没正文
  ]) {
    const out = await mk(deps)({ agent: { session: { id: 's1' } }, step: 1 }, () => Promise.resolve(base))
    assert.equal(out, base, '不该动 decision：' + JSON.stringify(deps))
  }
  const out2 = await mk({ getText: () => '正文', isEnabled: () => true })({ agent: { session: { id: 's1' } }, step: 2 }, () => Promise.resolve(base))
  assert.equal(out2.messages.length, 1, '非第 1 步不许注')
})

await t('P6 ★ 反证：畸形/没有 agent/decision 不是 enter ⇒ 原样透传，⛔ 绝不抛', async () => {
  const listeners = []
  registerPhiMessage({ on: (n, fn) => listeners.push(fn) }, { getText: () => '正文', isEnabled: () => true })
  const fn = listeners[0]
  const rejected = { kind: 'reject' }
  assert.equal(await fn({ agent: null, step: 1 }, () => Promise.resolve(rejected)), rejected, 'reject 决定照旧透传')
  const weird = { kind: 'enter' }   // 没有 messages 数组
  const out = await fn({ step: 1 }, () => Promise.resolve(weird))
  assert.equal(out.kind, 'enter')
  assert.equal(Array.isArray(out.messages), true, '缺 messages ⇒ 补成只有我们那一条（不许抛）')
  assert.equal(out.messages.length, 1)
  // next() 抛 ⇒ 照常往外抛（注入通道不得改变组装行为）
  let threw = false
  try { await fn({ step: 1 }, () => { throw new Error('boom') }) } catch { threw = true }
  assert.equal(threw, true, 'next() 的异常必须照常抛出')
})

await t('P7 接线失败必降级：ctx 没有 on() ⇒ installed:false + 如实给原因（⛔ 不抛）', () => {
  assert.equal(registerPhiMessage(null, {}).installed, false)
  assert.equal(registerPhiMessage({}, {}).reason, 'no-on')
  assert.equal(registerPhiMessage(undefined, {}).installed, false)
})

console.log(`PASS ${PASS.length}: ${PASS.join(' | ')}`)
if (FAIL.length) {
  console.log(`FAIL ${FAIL.length}: ${FAIL.join(' | ')}`)
  process.exit(1)
}
console.log('ALL PASS')
