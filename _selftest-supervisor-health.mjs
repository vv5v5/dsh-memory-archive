#!/usr/bin/env node
/**
 * _selftest-supervisor-health.mjs —— 钉住 2026-09-30 那两条真机修复（主管连续失败 11 次那一单）。
 *
 * 判据：
 *   A **线程里的 assistant 消息必须带 `source`** —— 否则官方 `LlmService.forAdapter()`
 *     （`packages/llm/llm/src/index.ts:975-985`）`const source = message.source; source.replayState`
 *     直接抛 `Cannot read properties of undefined (reading 'replayState')`（真机连续失败 11 次）。
 *     ★ 反证：把 `source` 那支人为去掉 ⇒ 同一判据必红。
 *   B 形状必须是官方自己剥 replayState 时用的那份：`{kind:'model',provider,model}`，
 *     且**不带 `replayState`**（带了就会被判成"要 replay 的旧消息"，模型一旦对不上就 INVALID_REPLAY_STATE）。
 *   C 健康事件形状与 `lib/health.js` 的 `pushEvent` **逐字段一致**（两处各写一份，必须钉住不许漂移）。
 *   D source pin：`finishError` 必须把**流层原始堆栈**接过来（用户口径「报错太隐蔽」）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { buildRpCompactionBackend, RP_COMPACTION_FILE_NAME } from './lib/mt-compaction.js'
import { pushEvent as healthPush, HEALTH_CAP } from './lib/health.js'

const here = path.dirname(fileURLToPath(import.meta.url))

// ⚠️ 本仓惯例（见 `_selftest-compaction-instruction.mjs`）：`lib/mt-compaction.js` 是**生成器**，
//   正文都在它返回的模板里 ⇒ **导出物只在【生成物】上**，必须先落盘再 import。
const tmpDir = mkdtempSync(path.join(here, '.st-sup-health-'))
const productPath = path.join(tmpDir, RP_COMPACTION_FILE_NAME)
writeFileSync(productPath, buildRpCompactionBackend(), 'utf8')
let product
try {
  product = await import(pathToFileURL(productPath).href)
} finally {
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 临时目录 */ }
}
const { buildSupervisorMessages, healthEventItem, HEALTH_EVENT_CAP } = product
let pass = 0
const fails = []
const check = (label, fn) => {
  try { fn(); pass++ } catch (e) { fails.push(`${label} —— ${e.message}`) }
}

const HISTORY = [
  { role: 'user', content: [{ type: 'text', text: 'u1' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
  { role: 'user', content: [{ type: 'text', text: 'u2' }] },
  { role: 'assistant', capacity: undefined, content: [{ type: 'reasoning', text: 'th' }, { type: 'text', text: 'a2' }] },
]
const build = (over = {}) => buildSupervisorMessages({ system: 'S', history: HISTORY, user: 'U', provider: 'deepseek-official', model: 'deepseek-v4-pro', ...over })

check('A 每条 assistant 都带 source（否则官方 forAdapter 会抛 replayState）', () => {
  for (const m of build()) {
    if (m.role !== 'assistant') continue
    assert.ok(m.source !== undefined && m.source !== null, 'assistant 缺 source：' + JSON.stringify(m).slice(0, 80))
  }
})

check('A2 ★反证：把 source 去掉 ⇒ 同一判据必红（证明它咬的是 source，不是形状巧合）', () => {
  const broken = build().map((m) => (m.role === 'assistant' ? { role: m.role, content: m.content } : m))
  const bad = broken.filter((m) => m.role === 'assistant' && m.source === undefined)
  assert.equal(bad.length, 2, '反证构造失败')
  assert.throws(() => { for (const m of broken) { if (m.role === 'assistant') { const s = m.source; void s.replayState } } },
    /Cannot read properties of undefined/, '这正是真机那句报错')
})

check('B 形状 = {kind:model, provider, model}，且 ⛔ 不带 replayState', () => {
  for (const m of build()) {
    if (m.role !== 'assistant') continue
    assert.deepEqual(m.source, { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    assert.equal(Object.hasOwn(m.source, 'replayState'), false, '不许带 replayState')
  }
})

check('B2 system/user 原样，顺序不变', () => {
  const out = build()
  assert.equal(out.length, HISTORY.length + 2)
  assert.equal(out[0].role, 'system')
  assert.equal(out[1].role, 'user')
  assert.equal(out[out.length - 1].role, 'user')
})

check('B3 空 history ⇒ 只有 system+user，不抛', () => {
  const out = build({ history: [] })
  assert.deepEqual(out.map((m) => m.role), ['system', 'user'])
  assert.deepEqual(build({ history: undefined }).map((m) => m.role), ['system', 'user'])
})

check('C 健康事件形状与 lib/health.js 的 pushEvent 逐字段一致', () => {
  assert.equal(HEALTH_EVENT_CAP, HEALTH_CAP, '容量两处必须同值')
  const ev = { source: 'supervisor', severity: 'error', code: 'collect-failed', message: 'm', hint: 'h' }
  const mine = healthEventItem(ev)
  const theirs = healthPush({ events: [], ackAt: 0 }, ev).events[0]
  for (const k of Object.keys(theirs)) assert.deepEqual(mine[k], theirs[k], '字段 ' + k + ' 漂移')
  assert.deepEqual(Object.keys(mine).sort(), Object.keys(theirs).sort(), '键集合漂移')
})

check('C2 畸形输入不抛、按契约归一（severity 只认 error，其余落 warn；超长截 300）', () => {
  const m = healthEventItem({ severity: 'x', message: 'a'.repeat(500) })
  assert.equal(m.severity, 'warn')
  assert.equal(m.message.length, 300)
  assert.equal(m.source, 'unknown')
})

check('D source pin：finishError 要接住流层的原始堆栈（不许只剩两帧）', () => {
  const src = readFileSync(path.join(here, 'lib', 'mt-compaction.js'), 'utf8')
  assert.match(src, /\[stream stack\]/, '没把流层 stack 接过来')
  assert.match(src, /error\.cause = finish\.failure/, '没留 cause 兜底')
  assert.match(src, /buildSupervisorMessages\(/, '线程消息没走那个纯函数')
  assert.match(src, /pushHealth\(\{/, '主管失败没写健康事件（进不了错误总面板）')
})

console.log(`\n—— ${pass} 通过 / ${fails.length} 失败 ——`)
for (const f of fails) console.log('  ✖ ' + f)
process.exitCode = fails.length === 0 ? 0 : 1
