/**
 * _selftest-tavern-field-plan.mjs —— `lib/tavern-field-plan.js` 自检台。
 *
 * 钉四件事：
 *   ① 字段清单**来自上游源码**（八个卡字段 + user/worldbook/preset/generated），一条不漏；
 *   ② 每条注释都写全用户要的三件事：① 固定开头 ② 意义 ③ ST 位置（⛔ 兜底条不许编后两条）；
 *   ③ 位置：PHI 排**最后**、开场白在 persona 槽之前、卡字段按 ST 的默认先后；
 *   ④ ★ 反证：认不出的字段名**照样有位置和注释**（兜底），畸形输入不抛，且非 part 段**原地不动**。
 *
 * 用法：node _selftest-tavern-field-plan.mjs
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(here, 'lib', 'tavern-field-plan.js')).href)

let pass = 0
const fails = []
function check(name, fn) {
  try { fn(); pass++; console.log('[PASS]', name) } catch (e) { fails.push({ name, e }); console.log('[FAIL]', name, '::', e.message) }
}

console.log('== _selftest-tavern-field-plan.mjs · 上游卡字段的位置计划 ==')

// ---------------------------------------------------------------- P1 字段清单
check('P1 ★ 字段清单覆盖上游**全部**能解出来的字段（抄自 profile-loader.js 的 fallbacks + userSource/worldbook/preset/generated）', () => {
  const keys = mod.TAVERN_FIELD_PLAN.map((e) => e.key)
  for (const need of [
    'character:systemPrompt', 'character:description', 'character:personality', 'character:scenario',
    'character:messageExample', 'character:postHistoryInstructions', 'character:greeting', 'character:depthPrompt',
    'user:description', 'worldbook:content', 'preset:prompts_', 'generated:header',
  ]) {
    assert.ok(keys.includes(need), '缺字段：' + need)
  }
  assert.equal(new Set(keys).size, keys.length, '字段键重复')
})
check('P1b ★ 反证：上游**不会**注入的字段名不许编进表里（creatorNotes / characterBook / firstMessage 都只是我们自己的叫法）', () => {
  const keys = mod.TAVERN_FIELD_PLAN.map((e) => e.key)
  for (const bad of ['character:creatorNotes', 'character:characterBook', 'character:firstMessage', 'character:alternateGreetings']) {
    assert.ok(!keys.includes(bad), '这张卡不该有 ' + bad + '（上游不注入它）')
  }
})

// ---------------------------------------------------------------- P2 每条注释一句话（用户 2026-09-20 手改口径）
check('P2 每条注释一句话：点名"它是什么字段" + 12 条各不相同（⛔ 复制同一句就红）；st 短标签还在', () => {
  // 每条必须点到的关键词 = 那个字段在对用户说话时的名字（缺了就说明注释没写清它是谁）
  const MUST = {
    'character:systemPrompt': 'system_prompt',
    'user:description': '人设',
    'character:description': 'description',
    'character:personality': 'personality',
    'character:scenario': 'scenario',
    'worldbook:content': '世界书',
    'character:messageExample': '示例对话',
    'character:depthPrompt': '深度提示词',
    'generated:header': '没有来源文档',
    'preset:prompts_': '提示词条目',
    'character:greeting': '开场白',
    'character:postHistoryInstructions': '后处理提示词',
  }
  const notes = []
  for (const e of mod.TAVERN_FIELD_PLAN) {
    assert.ok(typeof e.note === 'string' && e.note.length > 15, e.key + ' 的注释太短/没有：' + e.note)
    assert.ok(e.note.includes(MUST[e.key]), e.key + ' 的注释没写清它是什么（缺「' + MUST[e.key] + '」）：' + e.note)
    assert.ok(typeof e.st === 'string' && e.st !== '', e.key + ' 缺 st 短标签（面板要用）')
    notes.push(e.note)
  }
  assert.equal(new Set(notes).size, notes.length, '有字段的注释是同一句（没按字段分别写）')
})
check('P2c ★★ 摘除后处理指令那一份：整个摘掉（⛔ 不是清空）；只摘它、认不出的照旧留着', () => {
  const secs = [
    { name: 'harness:identity', text: 'A' },
    { name: 'pmp-dsh-tavern:part:0001:character:postHistoryInstructions', text: '破甲词' },
    { name: 'pmp-dsh-tavern:part:0000:character:systemPrompt', text: 'B' },
    { name: 'pmp-dsh-tavern:part:0002:character:description', text: 'C' },
  ]
  const r = mod.dropPostHistoryPart(secs)
  assert.equal(r.dropped, 1, '摘掉 1 段')
  assert.equal(r.sections.some((s) => String(s.name).includes('postHistoryInstructions')), false,
    '那个字段**不在**结果里（⛔ 不是留一条 0 字的）：' + JSON.stringify(r.sections.map((s) => s.name)))
  assert.deepEqual(r.sections.map((s) => s.name), [
    'harness:identity',
    'pmp-dsh-tavern:part:0000:character:systemPrompt',
    'pmp-dsh-tavern:part:0002:character:description',
  ], '别的段一段不少、顺序不变')
  // ★ 反证：没有它 ⇒ 返回**入参那个数组本身**（⛔ 不白造新数组）；畸形输入不抛
  const noPhi = [{ name: 'harness:identity', text: 'A' }]
  const r2 = mod.dropPostHistoryPart(noPhi)
  assert.equal(r2.dropped, 0)
  assert.equal(r2.sections, noPhi, '★ 反证：没摘到 ⇒ 原样返回同一个数组')
  assert.equal(mod.dropPostHistoryPart(null).dropped, 0, '★ 反证：非数组输入不抛')
})

check('P2b ★ 反证：兜底条**不许编**意义与 ST 位置（不认识就得说不知道）', () => {
  const fb = mod.TAVERN_FIELD_FALLBACK
  assert.ok(fb.note.includes('由上游 dsh-tavern 解算的'), '兜底也要有固定开头')
  assert.ok(fb.note.includes('不编'), '兜底必须写明"不编"：' + fb.note)
  assert.equal(fb.st, null, '兜底没有 ST 槽位可标 ⇒ 必须是 null，不许编一个')
})

// ---------------------------------------------------------------- P3 位置
check('P3 ★ 位置：PHI 排最后（> persona-suffix 10200 与 mt:lastFloors 10202）；开场白在 persona 槽之前；卡字段按 ST 先后', () => {
  const byKey = Object.fromEntries(mod.TAVERN_FIELD_PLAN.map((e) => [e.key, e.order]))
  assert.equal(byKey['character:postHistoryInstructions'], mod.PHI_PART_ORDER)
  assert.ok(mod.PHI_PART_ORDER > 10202 && mod.PHI_PART_ORDER > 10200, 'PHI 必须排在所有已知尾段之后')
  assert.ok(byKey['character:greeting'] > 10100 && byKey['character:greeting'] < 10200, '开场白：宿主段之后、persona 槽之前')
  assert.ok(byKey['user:description'] < byKey['character:description'], '用户人设该在角色描述之前')
  assert.ok(byKey['character:systemPrompt'] < byKey['user:description'], '系统提示词最前')
  assert.ok(byKey['character:description'] < byKey['character:personality'], 'description → personality')
  assert.ok(byKey['character:personality'] < byKey['character:scenario'], 'personality → scenario')
  assert.ok(byKey['character:scenario'] < byKey['character:messageExample'], 'scenario → 示例对话')
  assert.ok(byKey['character:messageExample'] < byKey['character:depthPrompt'], '示例对话 → 深度提示')
  assert.ok(byKey['character:depthPrompt'] < byKey['character:greeting'], '卡字段都在开场白之前')
})
check('P3b ★ 反证：我们派的 order **不占**别的插件的槽位（0/1/2 是我们的、45+ 是别人的）', () => {
  const reserved = [0, 1, 2, 45, 50, 54, 55, 56, 900, 1400, 1500, 2000, 9000, 10000, 10100, 10200, 10201, 10202]
  for (const e of mod.TAVERN_FIELD_PLAN) assert.ok(!reserved.includes(e.order), e.key + ' 撞了别人占的 order ' + e.order)
})

// ---------------------------------------------------------------- P4 解析与摆放
check('P4 parseTavernPart：认出真机段名；⛔ 认不出（profile 段、别的插件段、空）⇒ null', () => {
  const p = mod.parseTavernPart('pmp-dsh-tavern:part:0002:character:postHistoryInstructions')
  assert.deepEqual({ index: p.index, kind: p.kind, field: p.field, key: p.key },
    { index: '0002', kind: 'character', field: 'postHistoryInstructions', key: 'character:postHistoryInstructions' })
  for (const bad of ['pmp-dsh-tavern:profile', 'harness:identity', '', null, undefined, 42, 'pmp-dsh-tavern:part:2:x:y']) {
    assert.equal(mod.parseTavernPart(bad), null, '不该认出：' + String(bad))
  }
})
check('P4b planForField：已知字段给计划；预设条目按前缀命中；⛔ 认不出给兜底（不返回 null）', () => {
  assert.equal(mod.planForField('character:greeting').order, mod.GREETING_PART_ORDER)
  assert.equal(mod.planForField('preset:prompts_3_content').key, 'preset:prompts_') // 序号在变，前缀命中
  assert.equal(mod.planForField('character:someNewField').key, '*')
  assert.equal(mod.planForField('').key, '*')
})

check('P4c placeTavernParts：给每个 part 派 order 并按目标位置插进段表；**非 part 段原地不动**', () => {
  const sec = (name, order, text = 'x') => ({ name, order, text, chars: text.length })
  const input = [
    sec('harness:identity', -1000),
    sec('deployment:persona-prefix', 0),
    sec('pmp-dsh-tavern:part:0000:character:systemPrompt', undefined, 'kp'),
    sec('pmp-dsh-tavern:part:0001:character:description', undefined, 'desc'),
    sec('rp:policy', 45),
    sec('pmp-dsh-tavern:part:0002:character:postHistoryInstructions', undefined, 'PHI'),
    sec('tool:grep', 1500),
  ]
  const r = mod.placeTavernParts(input)
  const order = r.sections.map((s) => (s && s.name ? s.name : '?'))
  assert.deepEqual(order, [
    'harness:identity', 'deployment:persona-prefix',
    'pmp-dsh-tavern:part:0000:character:systemPrompt',
    'pmp-dsh-tavern:part:0001:character:description',
    'rp:policy', 'tool:grep',
    'pmp-dsh-tavern:part:0002:character:postHistoryInstructions',
  ], '摆位结果不对：' + order.join(' , '))
  const phi = r.sections[r.sections.length - 1]
  assert.equal(phi.order, mod.PHI_PART_ORDER, '搬过去的 part 要写上 order（面板/捕获靠它显示位置）')
  assert.deepEqual(r.placed.map((p) => p.key),
    ['character:systemPrompt', 'character:description', 'character:postHistoryInstructions'])
})
check('P4d ★★ 开场白：说明**另起一段**插在它前面（⛔ 绝不改开场白正文 —— 改它会让捕获锚不上、那段整个消失）', () => {
  const GREET = '<div style="x">你好</div>'
  const r = mod.placeTavernParts([{ name: 'pmp-dsh-tavern:part:0005:character:greeting', text: GREET, order: undefined }])
  assert.deepEqual(r.sections.map((s) => s.name), [mod.GREETING_NOTICE_NAME, 'pmp-dsh-tavern:part:0005:character:greeting'],
    '说明段必须在开场白**前面**：' + r.sections.map((s) => s.name).join(' | '))
  assert.equal(r.sections[1].text, GREET, '★ 开场白正文必须一字不动（改它会让捕获对不上、那一段整个消失）')
  assert.ok(r.sections[0].text.includes('不要把它原样复制'), '说明要写清"别照抄"')
  assert.equal(r.sections[0].order, mod.GREETING_NOTICE_ORDER)
  assert.equal(r.sections[1].order, mod.GREETING_PART_ORDER)
  // 幂等：把摆过的数组再摆一次，不许插第二份说明
  const again = mod.placeTavernParts(r.sections)
  assert.equal(again.sections.filter((s) => s.name === mod.GREETING_NOTICE_NAME).length, 1, '⛔ 不幂等：跑两次会插两份说明')
  // ★ 反证：没有开场白时就**不该**凭空多出说明段
  const noGreet = mod.placeTavernParts([{ name: 'pmp-dsh-tavern:part:0000:character:systemPrompt', text: 'kp', order: undefined }])
  assert.equal(noGreet.sections.some((s) => s.name === mod.GREETING_NOTICE_NAME), false, '⛔ 没有开场白却插了说明段')
})
check('P4e ★ 反证：没有 part 段 ⇒ **原样返回同一个数组**（不重排别人的段）；畸形输入不抛', () => {
  const input = [{ name: 'harness:identity', order: -1000 }, { name: 'rp:policy', order: 45 }]
  const r = mod.placeTavernParts(input)
  assert.equal(r.sections, input, '没有 part 时不许动数组')
  assert.equal(r.placed.length, 0)
  for (const bad of [null, undefined, 'x', 42, {}, [null, 42, 'x']]) {
    const rr = mod.placeTavernParts(bad)
    assert.ok(Array.isArray(rr.sections), '畸形输入要返回数组：' + String(bad))
    assert.equal(rr.placed.length, 0)
  }
})
check('P4f ★ 多条世界书：同 order，保持上游给的先后（稳定）', () => {
  const r = mod.placeTavernParts([
    { name: 'pmp-dsh-tavern:part:0003:worldbook:content', text: '甲', order: undefined },
    { name: 'pmp-dsh-tavern:part:0004:worldbook:content', text: '乙', order: undefined },
  ])
  assert.deepEqual(r.sections.map((s) => s.text), ['甲', '乙'], '同 order 的多条世界书顺序不许乱')
})
check('P4g ★ 反证：认不出的字段名也照样摆（兜底 order）并且计数报出来', () => {
  const r = mod.placeTavernParts([{ name: 'pmp-dsh-tavern:part:0009:character:brandNewField', text: 'x', order: undefined }])
  assert.equal(r.sections.length, 1)
  assert.equal(r.sections[0].order, mod.TAVERN_FIELD_FALLBACK.order)
  assert.equal(r.fallback, 1, '兜底命中数要报出来（面板要能说"有 N 个字段没进表"）')
})
check('P4h describePlacement：给出 `字段→order` 摘要（⛔ 不出正文）', () => {
  const s = mod.describePlacement([{ name: 'a', order: 12, key: 'character:description' }])
  assert.ok(s.includes('character:description→12'), s)
  assert.equal(mod.describePlacement([]), '没有上游解出来的段')
})

check('P4i ★★ 反证（沙箱实测踩到的真坑）：**段上没有 order** 时也必须摆对位置（⛔ 不许全插到最前面）', () => {
  // 真机/沙箱实测：装配期的段表里，非 part 段的 `order` 是 `—`（数字要等宿主装配之后那一趟才有）。
  // 第一版按 `section.order` 找插入点 ⇒ 所有段都看着像 +∞ ⇒ part 全被插到**最前面**。
  const sec = (name, text = 'x') => ({ name, text, chars: text.length })   // ⛔ 故意不给 order
  const r = mod.placeTavernParts([
    sec('harness:identity'), sec('deployment:persona-prefix'), sec('mt:memoryProtocol'), sec('mt:memoryHome'),
    sec('pmp-dsh-tavern:part:0000:character:systemPrompt', 'kp'),
    sec('rp:policy'), sec('state:card'),
    sec('pmp-dsh-tavern:part:0002:character:postHistoryInstructions', 'PHI'),
    sec('tool:grep'),
    sec('deployment:persona-suffix'), sec('mt:lastFloors'),
  ])
  const names = r.sections.map((s) => s.name)
  assert.equal(names[0], 'harness:identity', '★ 头一段必须还是 identity（不是被 part 顶掉）：' + names.join(' , '))
  assert.deepEqual(names, [
    'harness:identity', 'deployment:persona-prefix', 'mt:memoryProtocol', 'mt:memoryHome',
    'pmp-dsh-tavern:part:0000:character:systemPrompt',
    'rp:policy', 'state:card', 'tool:grep',
    'deployment:persona-suffix', 'mt:lastFloors',
    'pmp-dsh-tavern:part:0002:character:postHistoryInstructions',
  ], '摆位结果不对：' + names.join(' , '))
  assert.equal(names[names.length - 1], 'pmp-dsh-tavern:part:0002:character:postHistoryInstructions', 'PHI 必须是最后一段')
})

console.log(`\n== 汇总：${pass} 通过 / ${fails.length} 失败 ==`)
if (fails.length > 0) {
  console.log('失败项：')
  for (const f of fails) console.log('  -', f.name, '::', f.e.message)
  process.exitCode = 1
}
