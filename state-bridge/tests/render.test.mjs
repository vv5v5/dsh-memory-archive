/**
 * 渲染单测：格式、计时条目两形态、新增三节，以及与阶段 1 卡片的对齐。
 * 跑法: node --test tests/render.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { emptyStatus, normalizeStatus, mergeStatus, diffMechanics } from '../lib/state.js'
import { renderStateCard, formatTimedValue, estimateTokens } from '../lib/render.js'
import { sweepExpired } from '../lib/expiry.js'

// 本地真实产物由环境变量给目录（`DMA_L1_STATE_DIR`，里面应有 current.json 与 state-card.md）；
// ⛔ 绝对路径与角色名都不写进仓库 —— 没设变量就整组跳过。
const L1_DIR = process.env.DMA_L1_STATE_DIR ?? ''
const CURRENT = L1_DIR === '' ? '' : join(L1_DIR, 'current.json')
const CARD = L1_DIR === '' ? '' : join(L1_DIR, 'state-card.md')
// ST 聊天 jsonl（用于"50 份真实归档都能渲染"这条）——同样由环境变量给。
const CHAT = process.env.DSH_ST_CHAT ?? ''
const HAS_CHAT = CHAT !== '' && existsSync(CHAT)

test('renderStateCard：空状态也能渲染出两节', () => {
  const t = renderStateCard(emptyStatus(), { turn: 1 })
  assert.match(t, /【当前状态】/)
  assert.match(t, /【⚠ 本轮生效机制】/)
  assert.match(t, /身份：（未定）/)
  assert.match(t, /DSH 第 1 轮/)
  assert.ok(t.length > 100)
})

test('renderStateCard：不传 status 时返回空串（注入层要能安全跳过）', () => {
  assert.equal(renderStateCard(null), '')
  assert.equal(renderStateCard(undefined), '')
})

test('formatTimedValue：旧 string 与新 object 两形态', () => {
  assert.equal(formatTimedValue('全技能-10%（期限1天）'), '全技能-10%（期限1天）')
  assert.equal(formatTimedValue({ 效果: '全技能-10%', 到期: '1966/09/03' }), '全技能-10%（到期 1966/09/03）')
  assert.equal(
    formatTimedValue({ 修正: '-10%', 到期: '1966/09/03', 依据: '楼 253 检定失败' }),
    '-10%（到期 1966/09/03；依据：楼 253 检定失败）',
  )
  assert.equal(formatTimedValue({ 效果: 'x', 条件: '直至睡眠' }), 'x（条件：直至睡眠）')
  assert.equal(formatTimedValue(null), '')
})

test('renderStateCard：计时容器的两种值形态都能渲染', () => {
  const s = emptyStatus()
  s.状态栏 = { 旧式: '惩罚骰（期限1天）', 新式: { 效果: '全技能-10%', 到期: '1966/09/03' } }
  const t = renderStateCard(s, { turn: 5 })
  assert.match(t, /旧式（惩罚骰（期限1天））/)
  assert.match(t, /新式（全技能-10%（到期 1966\/09\/03））/)
})

test('renderStateCard：到期/待确认/变更三节按需出现', () => {
  const s = emptyStatus()
  const t1 = renderStateCard(s, { turn: 2 })
  assert.ok(!t1.includes('【⏱ 到期与解除】'), '没有到期内容时不该出现该节')
  assert.ok(!t1.includes('【✎ 本轮状态变更】'), '没有变更时不该出现该节')

  const t2 = renderStateCard(s, {
    turn: 3,
    expired: [{ container: '状态栏', key: '惊厥', reason: '到期 1966/09/03' }],
    pending: [{ container: '状态栏', key: '疲劳', condition: '直至 6 小时完整睡眠' }],
    unparseable: [{ container: '技能修正', key: '全技能' }],
    diff: { added: ['状态栏.受惊'], removed: ['状态栏.旧伤'] },
    summary: '墓园遇尸，恐惧 +3',
  })
  assert.match(t2, /【⏱ 到期与解除】/)
  assert.match(t2, /✔ 已自动解除：状态栏\.惊厥/)
  assert.match(t2, /⏳ 待确认解除：状态栏\.疲劳/)
  assert.match(t2, /⚠ 时限条目缺可读到期日/)
  assert.match(t2, /【✎ 本轮状态变更】/)
  assert.match(t2, /新增：状态栏\.受惊/)
  assert.match(t2, /移除：状态栏\.旧伤/)
  assert.match(t2, /副模型自述依据：墓园遇尸，恐惧 \+3/)
})

test('renderStateCard：warnings 会进 ⚠ 区', () => {
  const t = renderStateCard(emptyStatus(), { turn: 1, warnings: ['状态记账失败（超时），以下为第 3 轮状态'] })
  assert.match(t, /状态记账失败/)
  assert.match(t, /【⚠ 本轮生效机制】[\s\S]*- 状态记账失败/)
})

test('renderStateCard：恐惧阈值分支（5 / 12）与密氛降限', () => {
  const s = emptyStatus()
  s.基本.密氛 = { 当前: 15, 下限: 5, 上限: 25 }
  s.负面状态.恐惧 = 13
  const t = renderStateCard(s, { turn: 9 })
  assert.match(t, /已达精神崩溃阈值/)
  assert.match(t, /实际上限 12/)
  assert.match(t, /密氛 15 \/ 25|密氛：15\/25/)
})

test('renderStateCard 是纯同步的（provider 每轮调用它，内部不能 await）', () => {
  const r = renderStateCard(emptyStatus(), {})
  assert.equal(typeof r, 'string', '必须直接返回 string，不能是 Promise')
  assert.ok(!(r instanceof Promise))
})

test('estimateTokens：量级合理（1395 字 ≈ 537 token）', () => {
  assert.equal(estimateTokens('x'.repeat(1395)), 537)
})

// ── 与阶段 1 已认可的卡片对齐（真实数据）

const HAS = L1_DIR !== '' && existsSync(CURRENT) && existsSync(CARD)

test('parity: 用真实 current.json 渲染，关键数值与阶段 1 卡片一致', { skip: !HAS && '阶段 1 产物不存在' }, () => {
  const cur = JSON.parse(readFileSync(CURRENT, 'utf8'))
  const state = normalizeStatus(cur.state ?? cur.状态)
  const t = renderStateCard(state, { turn: 253 })

  const 躯体 = state.基本.躯体, 密氛 = state.基本.密氛, 恐惧 = state.负面状态.恐惧
  console.log(`  实测: 躯体 ${躯体.当前}/${躯体.上限}  密氛 ${密氛.当前}/${密氛.上限}  恐惧 ${恐惧}  实际上限 ${密氛.上限 - 恐惧}`)

  // 阶段 1 卡片（state-card.md）里记录的：躯体 55/60｜密氛 15/12
  assert.match(t, new RegExp(`躯体：${躯体.当前}/${躯体.上限}`))
  assert.match(t, new RegExp(`密氛：${密氛.当前}/${密氛.上限}`))
  assert.match(t, new RegExp(`实际上限 ${密氛.上限 - 恐惧}`))
  // 身份/知识/技能：**只在结构上断言**（具体角色名与条目数是本机私有数据，⛔ 不写进仓库）。
  // 想核对具体值就跑本地那份：拿 current.json 与 state-card.md 对比，别把值抄进测试。
  assert.match(t, /身份：./)
  assert.match(t, /知识（\d+）：/)
  assert.match(t, /技能（\d+）：/)
  assert.ok(t.length > 800, `渲染过短，可能丢了内容：${t.length} 字`)
  console.log(`  渲染长度 ${t.length} 字 ≈ ${estimateTokens(t)} token`)
})

test('parity: 阶段 1 卡片里的关键结论在新渲染器里仍然成立', { skip: !HAS && '阶段 1 产物不存在（设 DMA_L1_STATE_DIR 才跑）' }, () => {
  const card = readFileSync(CARD, 'utf8')
  const cur = JSON.parse(readFileSync(CURRENT, 'utf8'))
  const state = normalizeStatus(cur.state ?? cur.状态)
  // 卡片里被交叉验证过的那句（数值从数据现算，⛔ 不把本机数值抄进仓库）
  const 实际上限 = state.基本.密氛.上限 - state.负面状态.恐惧
  assert.match(card, new RegExp(`实际上限[^\\n]*${实际上限}`), '卡片里没有这个实际值上限')
  const t = renderStateCard(state, { turn: 253 })
  assert.match(t, new RegExp(`实际上限 ${实际上限}`), '新渲染器必须复现同一结论')
})

test('parity: 真实归档渲染都不抛错', { skip: !HAS_CHAT && '未设 DSH_ST_CHAT 或文件不存在' }, () => {
  const row0 = JSON.parse(readFileSync(CHAT, 'utf8').split(/\r?\n/).filter(l => l.trim())[0])
  let arch = row0.chat_metadata.variables['状态归档']
  if (arch && !Array.isArray(arch)) arch = Object.values(arch)
  let n = 0, minLen = Infinity, maxLen = 0
  for (const rec of arch.filter(x => x?.状态)) {
    const s = normalizeStatus(rec.状态)
    const r = sweepExpired(s, { today: s.时间.日期 })
    const t = renderStateCard(s, { turn: rec.楼, ...r })
    assert.ok(typeof t === 'string' && t.includes('【当前状态】'), `楼 ${rec.楼} 渲染异常`)
    assert.ok(t.includes('【⚠ 本轮生效机制】'), `楼 ${rec.楼} 缺机制节`)
    minLen = Math.min(minLen, t.length); maxLen = Math.max(maxLen, t.length)
    n++
  }
  console.log(`  ✓ ${n} 份归档渲染通过；长度 ${minLen}–${maxLen} 字（≈ ${estimateTokens(String(minLen))}–${estimateTokens('x'.repeat(maxLen))} token）`)
})

test('集成：merge → sweep → render 全链路（含两形态计时条目）', () => {
  const cur = emptyStatus()
  cur.时间.日期 = '1966/09/02'
  cur.状态栏 = { 惊厥: { 效果: '全技能-10%', 到期: '1966/09/03' } }
  cur.负面状态.惊厥 = true

  // 第 1 步：模型提交一个会过期的补丁
  const patch = { 时间: { 日期: '1966/09/04' }, 状态栏: { 新状态: { 效果: 'x', 条件: '直至痊愈' } } }
  const { status } = mergeStatus(cur, patch)

  // 第 2 步：代码清扫到期
  const sweep = sweepExpired(status, { today: status.时间.日期 })

  // 第 3 步：渲染
  const diff = diffMechanics(cur, status)
  const text = renderStateCard(status, { turn: 2, ...sweep, diff })

  // expired 里会有两条 惊厥：一条是 状态栏 条目本身，一条是连带清掉的布尔位（这是设计行为）
  assert.deepEqual(
    new Set(sweep.expired.map(e => `${e.container}.${e.key}`)),
    new Set(['状态栏.惊厥', '负面状态.惊厥']),
  )
  assert.equal(status.负面状态.惊厥, false, '布尔位连带清掉')
  assert.ok(!('惊厥' in status.状态栏))
  assert.ok(sweep.pending.some(p => p.key === '新状态'))
  assert.match(text, /✔ 已自动解除：状态栏\.惊厥/)
  assert.match(text, /新增：状态栏\.新状态/)
})
