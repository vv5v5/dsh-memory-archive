/**
 * 纯逻辑单测：state / expiry / schema。
 * 跑法: node --test tests/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SKILLS, KNOWLEDGE, NEG_BOOL, FREE_MAPS, ROOT_KEYS, IP_THRESHOLDS,
  changeSchema, allowedChangeKeys, keyStructureText, TIMED_MAPS,
} from '../lib/schema.js'
import {
  emptyStatus, normalizeStatus, mergeMap, mergeStatus, countNewMechanics,
  diffMechanics, enforceDerivedValues,
} from '../lib/state.js'
import { normalizeDate, readExpiry, sweepExpired, expiryNotice } from '../lib/expiry.js'

// ─────────────────────────────────────── 单一真相源：防漂移

test('提示词键结构与工具 schema 覆盖同一套键（防漂移）', () => {
  const text = keyStructureText()
  for (const k of SKILLS) assert.ok(text.includes(k), `提示词缺技能 ${k}`)
  for (const k of KNOWLEDGE) assert.ok(text.includes(k), `提示词缺知识 ${k}`)
  for (const k of FREE_MAPS) assert.ok(text.includes(k), `提示词缺自由容器 ${k}`)
  for (const k of ROOT_KEYS) assert.ok(text.includes(k), `提示词缺根键 ${k}`)
})

test('工具 schema 的 change 键是根键的子集，且覆盖全部可写根键', () => {
  const allowed = allowedChangeKeys()
  for (const k of allowed) assert.ok(ROOT_KEYS.includes(k), `schema 出现了非法根键 ${k}`)
  // 元/时间/基本/负面状态/技能/知识/血欲期 + 7 个自由容器 = 14
  assert.equal(allowed.length, ROOT_KEYS.length, `期望覆盖全部根键，实际 ${allowed.length}`)
})

test('schema 是合法 JSON（可序列化、无循环）', () => {
  const s = changeSchema()
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s)
  // change 的 required 必须为空 —— 允许"本轮无事发生"是刻意的合法出口
  assert.equal(s.required, undefined)
  assert.equal(s.additionalProperties, false)
})

test('20 技能 / 12 知识 / 4 布尔位 / 7 自由容器 / 2 计时容器', () => {
  assert.equal(SKILLS.length, 20)
  assert.equal(KNOWLEDGE.length, 12)
  assert.equal(NEG_BOOL.length, 4)
  assert.equal(FREE_MAPS.length, 7)
  assert.deepEqual(TIMED_MAPS, ['技能修正', '状态栏'])
})

// ─────────────────────────────────────── emptyStatus / normalizeStatus

test('emptyStatus 的根键顺序与 ROOT_KEYS 一致（渲染顺序依赖它）', () => {
  assert.deepEqual(Object.keys(emptyStatus()), ROOT_KEYS)
})

test('emptyStatus 的知识/技能都是白名单全量', () => {
  const s = emptyStatus()
  assert.deepEqual(Object.keys(s.技能), SKILLS)
  assert.deepEqual(Object.keys(s.知识), KNOWLEDGE)
  assert.deepEqual(s.知识.刃, { 级: 0, IP: 0 })
})

test('normalizeStatus 补齐缺键但不动已有值', () => {
  const partial = { 时间: { 日期: '1966/09/02' }, 技能: { 理性: 40 }, 知识: { 刃: { 级: 1 } } }
  const n = normalizeStatus(partial)
  assert.equal(n.时间.日期, '1966/09/02')
  assert.equal(n.时间.阶段, '')          // 补齐
  assert.equal(n.技能.理性, 40)          // 保留
  assert.equal(n.技能.意志, 0)           // 补齐
  assert.deepEqual(n.知识.刃, { 级: 1, IP: 0 })  // IP 补齐
  assert.deepEqual(n.知识.焚, { 级: 0, IP: 0 })
})

// ─────────────────────────────────────── mergeMap（照搬 状态系统v1.js:125-131）

test('mergeMap：null 删键 / 缺键保留 / 有值写入 / 数组与非对象忽略', () => {
  const dst = { a: 1, b: 2, c: 3 }
  assert.deepEqual(mergeMap(dst, { a: 9, b: null }), { a: 9, c: 3 })
  assert.deepEqual(mergeMap(dst, {}), dst)
  assert.deepEqual(mergeMap(dst, null), dst)
  assert.deepEqual(mergeMap(dst, [1, 2]), dst)     // 数组忽略
  assert.deepEqual(mergeMap(dst, 'x'), dst)        // 非对象忽略
  // 不改原对象
  assert.deepEqual(dst, { a: 1, b: 2, c: 3 })
})

// ─────────────────────────────────────── mergeStatus 核心语义

test('mergeStatus：未提及的键一律保留（核心规则 1）', () => {
  const cur = emptyStatus()
  cur.技能.理性 = 40
  cur.物品栏 = { 旧皮箱: '深棕色' }
  const { status } = mergeStatus(cur, { 时间: { 日期: '1966/09/03' } })
  assert.equal(status.技能.理性, 40)
  assert.deepEqual(status.物品栏, { 旧皮箱: '深棕色' })
  assert.equal(status.时间.日期, '1966/09/03')
})

test('mergeStatus：自由容器 null 删键', () => {
  const cur = emptyStatus()
  cur.状态栏 = { 坑中幻视: '...', 惊厥: '全技能-10%' }
  const { status } = mergeStatus(cur, { 状态栏: { 惊厥: null } })
  assert.deepEqual(Object.keys(status.状态栏), ['坑中幻视'])
})

test('mergeStatus：技能钳到 0..99，非数值忽略（静默，照搬 ST）', () => {
  const cur = emptyStatus()
  const { status } = mergeStatus(cur, { 技能: { 理性: 120, 意志: -5, 秘史: '25', 法律: 30 } })
  assert.equal(status.技能.理性, 99)
  assert.equal(status.技能.意志, 0)
  assert.equal(status.技能.秘史, 0, '字符串被静默忽略 —— 这正是要靠工具调用消灭的盲区')
  assert.equal(status.技能.法律, 30)
})

test('mergeStatus：知识 IP 只增不减并记 errs（照搬 :183）', () => {
  const cur = emptyStatus()
  cur.知识.刃 = { 级: 1, IP: 5 }
  const { status, errs } = mergeStatus(cur, { 知识: { 刃: { IP: 2 } } })
  assert.equal(status.知识.刃.IP, 5)
  assert.equal(errs.length, 1)
  assert.match(errs[0], /知识\.刃\.IP 被扣减/)

  const ok = mergeStatus(cur, { 知识: { 刃: { IP: 2 } } }, { allowIpDrop: true })
  assert.equal(ok.status.知识.刃.IP, 2)
})

test('mergeStatus：密氛当前不得低于下限（照搬 :154-156）', () => {
  const cur = emptyStatus()
  cur.基本.密氛 = { 当前: 3, 下限: 5, 上限: 50 }
  const { status } = mergeStatus(cur, {})
  assert.equal(status.基本.密氛.当前, 5)
})

test('mergeStatus：恐惧不为负；数组裁到 12 项并字符串化', () => {
  const cur = emptyStatus()
  const many = Array.from({ length: 20 }, (_, i) => `创伤${i}`)
  const { status } = mergeStatus(cur, { 负面状态: { 恐惧: -3, 永久创伤: many } })
  assert.equal(status.负面状态.恐惧, 0)
  assert.equal(status.负面状态.永久创伤.length, 12)
})

test('mergeStatus：元身份空串不覆盖（照搬 :139-140）', () => {
  const cur = emptyStatus()
  cur.元 = { 姓名: '示例角色', 种族: '示例种族' }
  const { status } = mergeStatus(cur, { 元: { 姓名: '   ', 种族: '人' } })
  assert.equal(status.元.姓名, '示例角色', '空串视为"剧情未给出"，不覆盖')
  assert.equal(status.元.种族, '人')
})

test('mergeStatus：元.锚点/更新于 不受补丁影响（提示词禁止模型输出它们）', () => {
  const cur = emptyStatus()
  cur.元 = { 锚点: 253, 更新于: '2026-09-11T00:00:00.000Z', 姓名: '示例角色' }
  const { status } = mergeStatus(cur, { 元: { 锚点: 1, 更新于: 'x', 姓名: '示例角色' } })
  assert.equal(status.元.锚点, 253)
})

// ─────────────────────────────────────── 配额护栏（治「乱记」）

test('countNewMechanics：区分新增 / 修改 / 删除', () => {
  const cur = emptyStatus()
  cur.状态栏 = { 坑中幻视: 'x' }
  const patch = {
    状态栏: { 坑中幻视: 'y', 新状态: 'z' },     // 修改 + 新增
    技能修正: { 全技能: '-10%' },               // 新增
    负面状态: { 临时恐惧: ['墓地'] },            // 新增 1 项
  }
  const r = countNewMechanics(cur, patch)
  assert.deepEqual(r.状态栏, ['新状态'])
  assert.deepEqual(r.技能修正, ['全技能'])
  assert.deepEqual(r.临时恐惧, ['墓地'])
  assert.equal(r.total, 3)
})

test('mergeStatus：新增机制条目超配额 → 整轮拒收，保留旧状态（治「吓了一跳就记临时恐惧」）', () => {
  const cur = emptyStatus()
  const patch = {
    状态栏: { 受惊: '...', 眩晕: '...' },
    负面状态: { 临时恐惧: ['被吓到'] },
  }
  const r = mergeStatus(cur, patch, { maxNewMechanicsPerTurn: 2 })
  assert.equal(r.rejected, true)
  assert.equal(r.guard.total, 3)
  assert.deepEqual(r.status.状态栏, {}, '被拒时状态原样')
  assert.deepEqual(r.status.负面状态.临时恐惧, [])

  // 提到 3 就放行
  const ok = mergeStatus(cur, patch, { maxNewMechanicsPerTurn: 3 })
  assert.equal(ok.rejected, false)
  assert.equal(Object.keys(ok.status.状态栏).length, 2)
})

test('配额护栏默认关闭（limit=0），不影响无护栏调用', () => {
  const cur = emptyStatus()
  const patch = { 状态栏: { a: '1', b: '2', c: '3', d: '4' } }
  assert.equal(mergeStatus(cur, patch).rejected, false)
})

test('diffMechanics：列出本轮新增/移除，供注入做可见化', () => {
  const cur = emptyStatus()
  cur.状态栏 = { 旧: '1' }
  cur.负面状态.临时恐惧 = ['旧惧']
  const next = mergeStatus(cur, { 状态栏: { 旧: null, 新: '2' }, 负面状态: { 临时恐惧: ['新惧'] } }).status
  const d = diffMechanics(cur, next)
  assert.ok(d.added.includes('状态栏.新'))
  assert.ok(d.removed.includes('状态栏.旧'))
  assert.ok(d.added.includes('临时恐惧.新惧'))
  assert.ok(d.removed.includes('临时恐惧.旧惧'))
})

// ─────────────────────────────────────── 公式护栏

test('enforceDerivedValues：知识等级由 IP 推出（消除"级/IP 不符"）', () => {
  const s = emptyStatus()
  s.知识.刃 = { 级: 5, IP: 6 }     // 6 只够 Lv1
  s.知识.焚 = { 级: 0, IP: 36 }    // 36 够 Lv3
  const { status, fixes } = enforceDerivedValues(s)
  assert.equal(status.知识.刃.级, 1)
  assert.equal(status.知识.焚.级, 3)
  assert.equal(fixes.length, 2)
})

test('enforceDerivedValues：阈值边界（5/15/35/70/120）', () => {
  const expect = (ip) => IP_THRESHOLDS.filter(t => ip >= t).length - 1
  assert.equal(expect(0), 0)
  assert.equal(expect(4), 0)
  assert.equal(expect(5), 1)
  assert.equal(expect(14), 1)
  assert.equal(expect(15), 2)
  assert.equal(expect(120), 5)
  assert.equal(expect(999), 5)
})

test('enforceDerivedValues：密氛不低于下限', () => {
  const s = emptyStatus()
  s.基本.密氛 = { 当前: 1, 下限: 5, 上限: 50 }
  const { status, fixes } = enforceDerivedValues(s)
  assert.equal(status.基本.密氛.当前, 5)
  assert.match(fixes[0], /密氛\.当前/)
})

// ─────────────────────────────────────── 到期解除（治「惊厥不会自动解除」）

test('normalizeDate：三种分隔符都能认，非法值返回 null', () => {
  assert.equal(normalizeDate('1966/09/03'), '1966/09/03')
  assert.equal(normalizeDate('1966-9-3'), '1966/09/03')
  assert.equal(normalizeDate('1966.09.03'), '1966/09/03')
  assert.equal(normalizeDate('日期 1966/09/03 夜'), '1966/09/03')
  assert.equal(normalizeDate('没有日期'), null)
  assert.equal(normalizeDate('1966/13/40'), null)
  assert.equal(normalizeDate(undefined), null)
})

test('readExpiry：新对象形态与旧字符串形态', () => {
  const o = readExpiry({ 效果: '全技能-10%', 到期: '1966/09/03', 依据: '检定额定失败' })
  assert.equal(o.shape, 'object')
  assert.equal(o.expiry, '1966/09/03')

  const s = readExpiry('全技能-10%（来源：惊厥；期限至 1966/09/03）')
  assert.equal(s.shape, 'string')
  assert.equal(s.expiry, '1966/09/03')

  const c = readExpiry({ 效果: 'x', 条件: '直至 6 小时完整睡眠' })
  assert.equal(c.condition, '直至 6 小时完整睡眠')
  assert.equal(c.expiry, null)
})

test('sweepExpired：到期条目由代码删除，并连带清掉布尔位与标记', () => {
  const s = emptyStatus()
  s.时间.日期 = '1966/09/04'
  s.状态栏 = {
    惊厥: { 效果: '全技能-10%', 到期: '1966/09/03', 依据: '楼 253' },
    未到期: { 效果: 'x', 到期: '1966/09/10' },
  }
  s.技能修正 = { 全技能: { 修正: '-10%', 到期: '1966/09/03' } }
  s.负面状态.惊厥 = true
  s.负面状态.特殊 = { 惊厥解除: '1966/09/03' }

  const r = sweepExpired(s, { today: '1966/09/04' })

  assert.deepEqual(Object.keys(s.状态栏), ['未到期'], '到期的被删、未到期的留着')
  assert.deepEqual(Object.keys(s.技能修正), [])
  assert.equal(s.负面状态.惊厥, false, '★ 布尔位被连带清掉')
  assert.ok(!('惊厥解除' in s.负面状态.特殊), '★ 标记被连带清掉')
  assert.ok(r.expired.some(e => e.container === '状态栏' && e.key === '惊厥'))
  assert.ok(r.expired.some(e => e.key === '惊厥' && /布尔位/.test(e.reason)))
})

test('sweepExpired：同日按阶段判定', () => {
  const s = emptyStatus()
  s.状态栏 = { 白天状态: { 效果: 'x', 到期: '1966/09/03', 到期阶段: '白昼-上午' } }
  sweepExpired(s, { today: '1966/09/03', phase: '白昼-上午' })
  assert.equal(Object.keys(s.状态栏).length, 1, '同期不算到期')
  sweepExpired(s, { today: '1966/09/03', phase: '夜晚' })
  assert.equal(Object.keys(s.状态栏).length, 0, '已过该阶段 → 到期')
})

test('sweepExpired：条件解除类不删，但进 pending（每轮可见）', () => {
  const s = emptyStatus()
  s.状态栏 = { 疲劳: '惩罚骰，直至 6 小时完整睡眠' }
  const r = sweepExpired(s, { today: '1966/09/04' })
  assert.equal(Object.keys(s.状态栏).length, 1, '代码判不了条件，不能删')
  assert.equal(r.pending.length, 1)
  assert.match(r.pending[0].condition, /睡眠/)
})

test('sweepExpired：旧格式有时限字样但无日期 → 进 unparseable（暴露而非静默）', () => {
  const s = emptyStatus()
  s.技能修正 = { 全技能: '‑10%（来源：惊厥；期限1天）' }
  const r = sweepExpired(s, { today: '1966/09/04' })
  assert.equal(r.unparseable.length, 1)
  assert.equal(Object.keys(s.技能修正).length, 1, '扫不掉就留着，不能瞎删')
})

test('sweepExpired：没有 today 时只做暴露，不删任何东西', () => {
  const s = emptyStatus()
  s.状态栏 = { a: { 效果: 'x', 到期: '1900/01/01' } }
  const r = sweepExpired(s, {})
  assert.equal(Object.keys(s.状态栏).length, 1)
  assert.equal(r.expired.length, 0)
})

test('expiryNotice：产出可读的通知行', () => {
  const lines = expiryNotice({
    expired: [{ container: '状态栏', key: '惊厥', reason: '到期 1966/09/03' }],
    pending: [{ container: '状态栏', key: '疲劳', condition: '直至 6 小时完整睡眠' }],
  })
  assert.equal(lines.length, 2)
  assert.match(lines[0], /已自动解除：状态栏\.惊厥/)
  assert.match(lines[1], /待确认解除/)
})
