// _selftest-last-floors.mjs —— lib/last-floors.js 的行为级自检台（纯函数，不碰宿主）。
//
// 口径照项目惯例：每条断言带**反证**（不能只看"该注入时注入了"，还要看"不该注入时一个字都没有"）。
// 退出码：全绿 0 / 有红 1（用 process.exitCode，⛔ 不用 process.exit —— undici 句柄在场时会被顶成 0xC0000409）。
import {
  LAST_FLOORS_VERSION, LAST_FLOORS_SECTION_NAME, LAST_FLOORS_ORDER,
  DEFAULT_LAST_FLOORS_COUNT, DEFAULT_LAST_FLOORS_MAX_CHARS, LAST_FLOORS_PREAMBLE,
  readSwitch, pickRecentFloors, renderRecentFloors, decideInject, findOrderConflicts,
} from './lib/last-floors.js'

let pass = 0
let fail = 0
function check(id, label, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✔ ${id} ${label}`) }
  else { fail += 1; console.log(`  ✘ ${id} ${label}${detail === undefined ? '' : '  ← ' + detail}`) }
}

/** 造一批楼层（升序）。 */
const mk = (n, { fill = '字' } = {}) =>
  Array.from({ length: n }, (_, i) => ({ floor: i, text: fill.repeat(20), name: '甲', isUser: i % 5 === 0 }))

// ───────────────────────────── L1 常量 ─────────────────────────────
console.log('\nL1 常量与位置')
check('L1a', '版本是正整数', Number.isInteger(LAST_FLOORS_VERSION) && LAST_FLOORS_VERSION > 0)
check('L1b', '段名是 mt:lastFloors', LAST_FLOORS_SECTION_NAME === 'mt:lastFloors', LAST_FLOORS_SECTION_NAME)
check('L1c', 'order = 10202（倒数第二）', LAST_FLOORS_ORDER === 10202, LAST_FLOORS_ORDER)
check('L1d', '★ 反证：order 必须 > rp:firstRound 的 10201', LAST_FLOORS_ORDER > 10201)
check('L1e', '★ 反证：order 必须 < mt:postHistory 的 10203（后处理提示词留在最后）', LAST_FLOORS_ORDER < 10203)
check('L1f', '默认值合理', DEFAULT_LAST_FLOORS_COUNT === 8 && DEFAULT_LAST_FLOORS_MAX_CHARS === 3000)
check('L1g', '前言含"已经发生过"与"承接"两个硬说明',
  LAST_FLOORS_PREAMBLE.includes('已经发生过') && LAST_FLOORS_PREAMBLE.includes('承接'))

// ───────────────────────────── L2 开关（严格） ─────────────────────────────
console.log('\nL2 readSwitch：只在严格 true 时开')
const OFF_SHAPES = [
  ['undefined', undefined], ['null', null], ['数组', []], ['字符串', 'x'], ['数字', 1],
  ['空对象', {}], ['lastFloors 是 null', { lastFloors: null }], ['lastFloors 是数组', { lastFloors: [] }],
  ['enabled 缺', { lastFloors: {} }], ['enabled = "true"', { lastFloors: { enabled: 'true' } }],
  ['enabled = 1', { lastFloors: { enabled: 1 } }], ['enabled = false', { lastFloors: { enabled: false } }],
]
for (const [label, v] of OFF_SHAPES) {
  let got
  try { got = readSwitch(v) } catch (e) { got = { enabled: 'THREW:' + e.message } }
  check('L2.' + label, `形状「${label}」⇒ 关且不抛`, got.enabled === false, JSON.stringify(got))
}
check('L2.on', 'enabled:true ⇒ 开', readSwitch({ lastFloors: { enabled: true } }).enabled === true)

console.log('\nL2b 数值键：非法的回落默认、越界的夹住')
{
  const d = readSwitch({ lastFloors: { enabled: true } })
  check('L2b-1', '缺 count/maxChars ⇒ 用默认', d.count === 8 && d.maxChars === 3000, JSON.stringify(d))
  const s = readSwitch({ lastFloors: { enabled: true, count: '9', maxChars: '4000' } })
  check('L2b-2', '字符串数字 ⇒ 回落默认（不猜）', s.count === 8 && s.maxChars === 3000, JSON.stringify(s))
  const c = readSwitch({ lastFloors: { enabled: true, count: 0, maxChars: 1 } })
  check('L2b-3', '过小 ⇒ 夹到下界', c.count === 1 && c.maxChars === 200, JSON.stringify(c))
  const h = readSwitch({ lastFloors: { enabled: true, count: 1e9, maxChars: 1e9 } })
  check('L2b-4', '过大 ⇒ 夹到上界', h.count === 200 && h.maxChars === 60000, JSON.stringify(h))
  const f = readSwitch({ lastFloors: { enabled: true, count: 6.7, maxChars: 2500.9 } })
  check('L2b-5', '小数 ⇒ 截断取整', f.count === 6 && f.maxChars === 2500, JSON.stringify(f))
}

// ───────────────────────────── L3 选楼 ─────────────────────────────
console.log('\nL3 pickRecentFloors')
check('L3a', '非数组 ⇒ []', Array.isArray(pickRecentFloors(null, 3)) && pickRecentFloors(null, 3).length === 0)
check('L3b', '空数组 ⇒ []', pickRecentFloors([], 3).length === 0)
check('L3c', 'count 0 ⇒ []', pickRecentFloors(mk(10), 0).length === 0)
check('L3d', 'count 负数 ⇒ []', pickRecentFloors(mk(10), -5).length === 0)
check('L3e', '★ 取的是**最后** N 楼', JSON.stringify(pickRecentFloors(mk(10), 3).map((f) => f.floor)) === '[7,8,9]',
  JSON.stringify(pickRecentFloors(mk(10), 3).map((f) => f.floor)))
check('L3f', '★ 返回仍是**升序**（时间顺序）', (() => {
  const r = pickRecentFloors(mk(10), 4).map((f) => f.floor)
  return r.every((v, i, a) => i === 0 || a[i - 1] < v)
})())
check('L3g', 'count 超过总数 ⇒ 全给', pickRecentFloors(mk(4), 99).length === 4)
check('L3h', '★ 剔掉形状不对的（无楼号 / 非对象）', (() => {
  const r = pickRecentFloors([{ floor: 1, text: 'a' }, null, { text: 'b' }, { floor: 'x', text: 'c' }, { floor: 2, text: 'd' }], 9)
  return r.length === 2 && r[0].floor === 1 && r[1].floor === 2
})())
check('L3i', 'text 非字符串 ⇒ 空串（不猜）', pickRecentFloors([{ floor: 1, text: 42 }], 1)[0].text === '')

// ───────────────────────────── L4 渲染 ─────────────────────────────
console.log('\nL4 renderRecentFloors')
const sample = [
  { floor: 0, text: '开场白', name: '甲', isUser: false },
  { floor: 1, text: '我说的话', name: '甲', isUser: true },
  { floor: 2, text: '叙事', name: '', isUser: false },
]
{
  check('L4a', '空输入 ⇒ 空串（宿主不注入空段）', renderRecentFloors([], {}) === '' && renderRecentFloors(null, {}) === '')
  const out = renderRecentFloors(sample, { maxChars: 3000 })
  check('L4b', '有壳', out.startsWith('<recentFloors>') && out.endsWith('</recentFloors>'))
  check('L4c', '含前言', out.includes(LAST_FLOORS_PREAMBLE))
  check('L4d', '玩家楼标「你」', out.includes('] 你：我说的话'), out.split('\n').find((l) => l.includes('我说的话')))
  check('L4e', '非玩家楼用 name', out.includes('] 甲：开场白'))
  check('L4f', 'name 缺失 ⇒ 「叙事」', out.includes('] 叙事：叙事'))
  check('L4g', '楼号补零到 4 位', out.includes('[楼 0000]') && out.includes('[楼 0002]'))
  const idx = (s) => out.split('\n').findIndex((l) => l === s)
  check('L4h', '★ 顺序是旧→新（时间顺序）', idx('[楼 0000] 甲：开场白') < idx('[楼 0002] 叙事：叙事'))
  check('L4i', '★ 反证：没超预算时**不**出现省略标注', !out.includes('已省略'))
}

// ───────────────────────────── L5 预算（反证） ─────────────────────────────
console.log('\nL5 超预算 ⇒ 丢最旧的、留最新的、如实标注')
{
  const big = Array.from({ length: 40 }, (_, i) => ({ floor: i, text: 'X'.repeat(100), name: '甲', isUser: false }))
  const out = renderRecentFloors(big, { maxChars: 800 })
  check('L5a', '有省略标注且写明丢了几楼', /更早的 \d+ 楼/.test(out), out.split('\n').slice(-2).join(' | '))
  check('L5b', '★ 最新那楼一定在', out.includes('[楼 0039]'))
  check('L5c', '★ 最旧那楼一定不在', !out.includes('[楼 0000]'))
  const keptFloor = Math.max(...[...out.matchAll(/\[楼 (\d+)\]/g)].map((m) => Number(m[1])))
  check('L5d', '★ 保留的确实是尾部连续段', keptFloor === 39, String(keptFloor))
  const tiny = renderRecentFloors(big, { maxChars: 200 })
  check('L5e', '★ 反证：一楼都装不下 ⇒ 空串（不吐半个壳）', tiny === '', JSON.stringify(tiny.slice(0, 80)))
}

// ───────────────────────────── L6 决策真值表 ─────────────────────────────
console.log('\nL6 decideInject 真值表')
{
  const floors = mk(3)
  const text = 'X'
  const rows = [
    ['L6a', { enabled: false, isFirstTurn: true, floors, text }, false, 'switch-off'],
    ['L6b', { enabled: true, isFirstTurn: false, floors, text }, false, 'has-history'],
    ['L6c', { enabled: true, isFirstTurn: true, floors: [], text }, false, 'no-floors'],
    ['L6d', { enabled: true, isFirstTurn: true, floors, text: '' }, false, 'empty-render'],
    ['L6e', { enabled: true, isFirstTurn: true, floors, text }, true, 'first-turn'],
  ]
  for (const [id, input, wantInject, wantReason] of rows) {
    const got = decideInject(input)
    check(id, `${wantReason} ⇒ inject=${wantInject}`, got.inject === wantInject && got.reason === wantReason, JSON.stringify(got))
  }
  check('L6f', '★ 反证：undefined 输入不抛且判不注入', (() => {
    const g = decideInject(undefined)
    return g.inject === false && g.reason === 'switch-off'
  })())
  check('L6g', '★ 反证：有真历史时**任何**情形都不注入', (() => {
    for (const enabled of [true, false]) {
      for (const t of ['', 'X']) {
        if (decideInject({ enabled, isFirstTurn: false, floors, text: t }).inject) return false
      }
    }
    return true
  })())
}

// ───────────────────────────── L7 看守 ─────────────────────────────
console.log('\nL7 findOrderConflicts')
{
  const OURS = [LAST_FLOORS_SECTION_NAME, 'mt:postHistory', 'rp:firstRound']
  check('L7a', '非数组 ⇒ []', findOrderConflicts(null, 10202, OURS).length === 0)
  check('L7b', '★ 反证：我们自己的 mt:postHistory@10203 **不算**冲突',
    findOrderConflicts([{ name: 'mt:postHistory', order: 10203 }], 10202, OURS).length === 0)
  check('L7c', '★ 外来段 ≥ 10202 ⇒ 报', (() => {
    const h = findOrderConflicts([{ name: 'someone:else', order: 10202 }], 10202, OURS)
    return h.length === 1 && h[0].name === 'someone:else'
  })())
  check('L7d', '外来段 < 10202 ⇒ 不报', findOrderConflicts([{ name: 'someone:else', order: 10201 }], 10202, OURS).length === 0)
  check('L7e', '无 order / 坏条目 ⇒ 跳过不抛',
    findOrderConflicts([{ name: 'a' }, null, { name: 'b', order: 'x' }], 10202, OURS).length === 0)
  check('L7f', 'ourOrder 非数 ⇒ 不放炮', findOrderConflicts([{ name: 'a', order: 99999 }], NaN, OURS).length === 0)
}

// ───────────────────────────── L8 端到端拼装 ─────────────────────────────
console.log('\nL8 端到端：readSwitch → pick → render → decide')
{
  const cfg = { lastFloors: { enabled: true, count: 3, maxChars: 3000 } }
  const sw = readSwitch(cfg)
  const floors = mk(10)
  const picked = pickRecentFloors(floors, sw.count)
  const text = renderRecentFloors(picked, { maxChars: sw.maxChars })
  const d = decideInject({ enabled: sw.enabled, isFirstTurn: true, floors, text })
  check('L8a', '整链通：注入且拿到 3 楼', d.inject === true && picked.length === 3, JSON.stringify({ d, n: picked.length }))
  check('L8b', '★ 反证：同一套配置把 isFirstTurn 翻成 false ⇒ 一个字都不注', (() => {
    const d2 = decideInject({ enabled: sw.enabled, isFirstTurn: false, floors, text })
    return d2.inject === false
  })())
  check('L8c', '★ 反证：开关关 ⇒ 一个字都不注', (() => {
    const off = readSwitch({ lastFloors: { enabled: false, count: 3 } })
    return decideInject({ enabled: off.enabled, isFirstTurn: true, floors, text }).inject === false
  })())
}

console.log(`\n── ${pass} 通过 / ${fail} 失败 ──`)
process.exitCode = fail === 0 ? 0 : 1
