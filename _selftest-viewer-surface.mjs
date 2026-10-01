#!/usr/bin/env node
/**
 * _selftest-viewer-surface.mjs —— 钉住「查看器认 surfaceOp，且**认的是事件根那一层**」。
 *
 * 为什么要有它（2026-09-30 真机）：
 *   插件用 `session.append('user/message', msg, { surfaceOp: { op:'replace', startSeq, endSeq } })`
 *   把上一轮自己注入的消息**换掉**。宿主把这份意图写在**事件根**上
 *   （`packages/core/session/src/index.ts:742-748`：`{type, seq, time, data, ...surfaceMetadataSnapshot}`），
 *   而查看器原来只读 `ev.data.surfaceOp` ⇒ **面板看不见替换**：原件照旧被画成活行，
 *   于是"模型只收到一份、面板却列出多份" ⇒ 用户验收时判定"还是没修好"（这是个**看错**，不是没修）。
 *
 * 判据（每条都是行为断言，外加一条 source pin）：
 *   A 根层 surfaceOp.replace ⇒ 被顶掉的那条**不在** rows 里（替换件在）
 *   B `data` 层的旧形状也认（向后兼容，⛔ 不许为修 A 而把 B 弄坏）
 *   C ★反证：**没有** surfaceOp ⇒ 两条都在（证明"消失"确实是那件 op 造成的，不是别的原因）
 *   D source pin：源码必须从根读（`ev?.surfaceOp ?? ev?.data?.surfaceOp`）—— 退回 data-only 必红
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { buildConversation } from './lib/prompt-viewer.js'

const here = path.dirname(fileURLToPath(import.meta.url))
let pass = 0
const fails = []
const check = (label, fn) => {
  try { fn(); pass++ } catch (e) { fails.push(`${label} —— ${e.message}`) }
}

const user = (seq, text, surface) => ({
  seq, time: seq, type: 'user/message',
  data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
  ...(surface === undefined ? {} : surface),
})
const seqsOf = (events) => buildConversation(events).rows.map((r) => r.seq)

check('A 根层 surfaceOp.replace ⇒ 被顶掉的不在 rows（替换件在）', () => {
  const rows = seqsOf([
    user(1, 'old lore'),
    user(2, 'new lore', { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 }, sourceEventSeqs: [1] }),
  ])
  assert.deepEqual(rows, [2])
})

check('B data 层的旧形状也认（向后兼容）', () => {
  const rows = seqsOf([
    user(1, 'old lore'),
    { seq: 2, time: 2, type: 'user/message', data: { content: [{ type: 'text', text: 'new lore' }], source: { kind: 'user' }, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } } },
  ])
  assert.deepEqual(rows, [2])
})

check('C ★反证：没有 surfaceOp ⇒ 两条都在', () => {
  assert.deepEqual(seqsOf([user(1, 'old lore'), user(2, 'new lore')]), [1, 2])
})

check('C2 ★反证咬合：区间不止一条时，整段被顶掉', () => {
  const rows = seqsOf([
    user(1, 'a'), user(2, 'b'), user(3, 'c'),
    user(4, 'merged', { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 }, sourceEventSeqs: [1, 2] }),
  ])
  assert.deepEqual(rows, [3, 4])
})

check('D source pin：必须从事件根读（⛔ 不许只读 data）', () => {
  const src = readFileSync(path.join(here, 'lib', 'prompt-viewer.js'), 'utf8')
  assert.ok(src.includes('ev?.surfaceOp ?? ev?.data?.surfaceOp'), '循环顶部那处没从根读')
  assert.ok(src.includes('ev.surfaceOp ?? ev.data?.surfaceOp'), 'tool/result 那处没从根读')
  assert.equal(/const sop = ev\?\.data\?\.surfaceOp$/.test(src.replace(/\r/g, '')), false, '又退回 data-only 了')
})

console.log(`\n—— ${pass} 通过 / ${fails.length} 失败 ——`)
for (const f of fails) console.log('  ✖ ' + f)
process.exitCode = fails.length === 0 ? 0 : 1
