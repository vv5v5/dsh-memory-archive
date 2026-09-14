/**
 * _selftest-card-sections.mjs —— Plan B（本插件注册卡字段段）的自检台。
 *
 * 覆盖（对应设计文档《设计-卡字段段注册与order》§5 的判据）：
 *   ① 计划的 name / order 逐条正确，且**零冲突**（不撞上游与别的插件的保留位）
 *   ② 默认**不注册**（builtin 下上游已在注入 ⇒ 再注册就是双重注入）
 *   ③ 空字段不注册那一段（不往 system 里塞空段）
 *   ④ `post-history-instructions` 落在 system 尾部且带"近似"标注；`depth-prompt` 同理
 *   ⑤ `greeting-reference` **不在计划里**（用户决定本插件不注册，开场白归记忆库）
 *   ⑥ 真注册：假 ctx 捕获 `section({name, order, text})` 调用，逐段核对
 *   ⑦ 启用 + 上游可达 ⇒ 明确警告"可能双重注入"；不可达 ⇒ 无警告
 *   ⑧ 反证四条：撞保留位必须报红 / 改计划必须被断言抓住 / 无服务必须拒绝且不抛 / 塞回 greeting 必须红
 */
import assert from 'node:assert/strict'
import {
  CARD_SECTIONS_VERSION,
  CARD_SECTION_PLAN,
  HARD_RESERVED_ORDERS,
  CONDITIONAL_ORDERS,
  detectOrderCollisions,
  buildCardSections,
  registerCardSections,
} from './lib/card-sections.js'

let pass = 0
const fails = []
function t(name, fn) {
  try { fn(); pass++; console.log(`PASS ${name}`) } catch (e) { fails.push(`${name}: ${e?.message || e}`); console.log(`FAIL ${name} —— ${e?.message || e}`) }
}

const FIELDS = {
  'system-prompt': '（夹具）主提示词正文',
  'description': '（夹具）描述正文',
  'personality': '（夹具）性格正文',
  'post-history-instructions': '（夹具）历史后指令',
  'depth-prompt': '（夹具）深度提示',
}

/** 假 ctx：记账注册调用（官方签名 name/order/text）。 */
function fakeCtx() {
  const state = { sections: [], disposed: 0 }
  return {
    state,
    ctx: {
      systemPrompt: {
        section(section) {
          state.sections.push(section)
          return () => { state.disposed++ }
        },
      },
    },
  }
}

// ── ① 计划本身 ────────────────────────────────────────────────────────────────
t('★① Plan B 前提（上游已停止注入）下，计划零冲突', () => {
  const c = detectOrderCollisions(CARD_SECTION_PLAN, { tavernProfileActive: false })
  assert.deepEqual(c, [], `撞了：${JSON.stringify(c)}`)
})
t('★① 反证：上游仍在注入时，同一份计划必须报"撞 10"（order 10 是有条件可用的）', () => {
  const c = detectOrderCollisions(CARD_SECTION_PLAN, { tavernProfileActive: true })
  assert.ok(c.length > 0 && c.some((x) => x.order === 10), `没抓住：${JSON.stringify(c)}`)
  assert.ok(c.some((x) => x.owner.includes('pmp-dsh-tavern')), '冲突归属没点名上游')
})
t('★① 硬保留位无论什么模式都不许占（清单一律与计划零重叠）', () => {
  const ours = new Set(CARD_SECTION_PLAN.map((s) => s.order))
  const bad = HARD_RESERVED_ORDERS.filter((r) => ours.has(r.order))
  assert.deepEqual(bad, [], `占了硬保留位：${JSON.stringify(bad)}`)
  assert.equal(CONDITIONAL_ORDERS.length, 1, '有条件可用的位应当只有上游那一窗')
})
t('① 段名一律用本插件前缀 dma:（不占上游 pmp-dsh-tavern:* 命名空间）', () => {
  for (const s of CARD_SECTION_PLAN) {
    assert.ok(s.name.startsWith('dma:'), `${s.name} 没用 dma: 前缀`)
    assert.ok(!s.name.startsWith('pmp-dsh-tavern:'), `${s.name} 占了上游命名空间`)
  }
})
t('① 卡字段 7 段齐全（ST 的 7 个标记名都在计划里）', () => {
  const sts = CARD_SECTION_PLAN.map((s) => s.st)
  for (const want of ['system-prompt', 'description', 'personality', 'scenario', 'message-example', 'post-history-instructions', 'depth-prompt']) {
    assert.ok(sts.includes(want), `缺字段 ${want}`)
  }
})
t('① 版本号在位（装配结果一变就必须 +1）', () => assert.equal(CARD_SECTIONS_VERSION, 1))

// ── ② 默认不注册 ──────────────────────────────────────────────────────────────
t('★② 默认（enabled 缺省）一段都不注册，并回可读原因', () => {
  const { ctx, state } = fakeCtx()
  const r = registerCardSections(ctx, { fields: FIELDS })
  assert.equal(r.ok, false)
  assert.equal(state.sections.length, 0, '默认关闭却注册了段落')
  assert.ok(typeof r.refusedReason === 'string' && r.refusedReason.includes('双重注入'), `原因不可读：${r.refusedReason}`)
})
t('② enabled:false 同样不注册', () => {
  const { ctx, state } = fakeCtx()
  const r = registerCardSections(ctx, { enabled: false, fields: FIELDS })
  assert.equal(r.ok, false)
  assert.equal(state.sections.length, 0)
})

t('★② 上游仍在注入（tavernProfileActive:true）⇒ 硬拒绝，并点明双重注入', () => {
  const { ctx, state } = fakeCtx()
  const r = registerCardSections(ctx, { enabled: true, tavernProfileActive: true, fields: FIELDS })
  assert.equal(r.ok, false)
  assert.equal(state.sections.length, 0, '上游还在注入却注册了段落')
  assert.ok(String(r.refusedReason).includes('双重注入'), `原因不可读：${r.refusedReason}`)
})

// ── ③ 空字段不注册 ────────────────────────────────────────────────────────────
t('③ 只喂 3 个字段 ⇒ 只注册 3 段（不塞空段）', () => {
  const { ctx, state } = fakeCtx()
  const r = registerCardSections(ctx, {
    enabled: true,
    tavernProfileActive: false,
    fields: { 'description': '只有描述', 'personality': '   ', 'scenario': '只有场景' },
  })
  assert.equal(r.ok, true)
  assert.equal(state.sections.length, 2, `实际注册 ${state.sections.length} 段：${r.registered}`)
  assert.deepEqual(r.registered.sort(), ['dma:card:description', 'dma:card:scenario'])
})

// ── ④ PHI / depth：落在尾部且带"近似" ──────────────────────────────────────────
t('★④ post-history-instructions 在 system 尾部（9949）、且带"近似"标注', () => {
  const phi = CARD_SECTION_PLAN.find((s) => s.id === 'post-history-instructions')
  assert.equal(phi.order, 9949, `PHI order 应为 9949，实为 ${phi.order}`)
  assert.ok(typeof phi.honesty === 'string' && phi.honesty.includes('近似'), 'PHI 缺"近似"标注')
  assert.ok(phi.honesty.includes('玩家消息'), 'PHI 的标注必须点明"DSH 没有玩家消息之后的槽位"')
})
t('④ PHI 的 order 严格小于本插件既有的静态规则段（9950 不挪）', () => {
  const phi = CARD_SECTION_PLAN.find((s) => s.id === 'post-history-instructions')
  assert.ok(phi.order < 9950, 'PHI 不能顶掉 9950 的静态核心规则段')
})
t('④ depth-prompt 带"近似"标注（DSH 无任意深度插入）', () => {
  const d = CARD_SECTION_PLAN.find((s) => s.id === 'depth-prompt')
  assert.ok(typeof d.honesty === 'string' && d.honesty.includes('近似') && d.honesty.includes('深度'))
})

// ── ⑤ greeting-reference 不在计划里 ───────────────────────────────────────────
t('★⑤ greeting-reference 不在计划里（本插件不注册开场白；由记忆库那侧管）', () => {
  const hit = CARD_SECTION_PLAN.filter((s) => s.st.includes('greeting') || s.id.includes('greeting'))
  assert.equal(hit.length, 0, `计划里还有 greeting 段：${JSON.stringify(hit.map((s) => s.name))}`)
})

// ── ⑥ 真注册：逐段核对官方签名 ────────────────────────────────────────────────
t('★⑥ 真注册：假 ctx 收到的 name/order/text 与计划逐条一致', () => {
  const { ctx, state } = fakeCtx()
  const r = registerCardSections(ctx, { enabled: true, tavernProfileActive: false, fields: FIELDS, persona: '（夹具）用户人设', loreBefore: '（夹具）前置世界书' })
  assert.equal(r.ok, true)
  const byName = new Map(state.sections.map((s) => [s.name, s]))
  assert.equal(state.sections.length, 7, `应注册 7 段（5 卡字段 + 人设 + 前置世界书），实为 ${state.sections.length}`)
  for (const s of CARD_SECTION_PLAN) {
    const got = byName.get(s.name)
    if (got === undefined) continue
    assert.equal(got.order, s.order, `${s.name} 的 order 不符`)
    assert.equal(typeof got.text, 'string', `${s.name} 的 text 应为字符串（静态段）`)
    assert.ok(!('complete' in got), `${s.name} 不该声明 complete（那会顶掉整段 system）`)
  }
  // 顺序必须与 order 升序一致（DSH 按 order 升序拼接）
  const orders = state.sections.map((s) => s.order)
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b), `注册顺序非升序：${orders}`)
})
t('⑥ 注册返回值给出 disposer，调用不抛（可卸载）', () => {
  const { ctx, state } = fakeCtx()
  const r = registerCardSections(ctx, { enabled: true, tavernProfileActive: false, fields: FIELDS })
  assert.equal(r.disposers.length, r.registered.length)
  for (const d of r.disposers) d()
  assert.equal(state.disposed, r.registered.length)
})

// ── ⑦ 双重注入警告 ────────────────────────────────────────────────────────────
t('★⑦ 启用 + 上游可达 ⇒ 明确警告"可能双重注入"', () => {
  const { ctx } = fakeCtx()
  const r = registerCardSections(ctx, { enabled: true, tavernProfileActive: false, fields: FIELDS, tavernReachable: true })
  assert.ok(typeof r.warning === 'string' && r.warning.includes('双重注入'), `没给出警告：${r.warning}`)
})
t('⑦ 启用但上游不可达 ⇒ 无警告', () => {
  const { ctx } = fakeCtx()
  const r = registerCardSections(ctx, { enabled: true, tavernProfileActive: false, fields: FIELDS, tavernReachable: false })
  assert.equal(r.warning, null)
})

// ── ⑧ 反证 ────────────────────────────────────────────────────────────────────
t('★⑧ 反证：把某段 order 改成 45（rp:policy 的位）⇒ 必须报冲突', () => {
  const bad = CARD_SECTION_PLAN.map((s) => (s.id === 'description' ? { ...s, order: 45 } : s))
  const c = detectOrderCollisions(bad)
  assert.ok(c.length > 0 && c.some((x) => x.order === 45 && x.owner.includes('rp:policy')), `没抓住：${JSON.stringify(c)}`)
})
t('★⑧ 反证：计划内两段同 order ⇒ 必须报重复', () => {
  const bad = CARD_SECTION_PLAN.map((s) => (s.id === 'personality' ? { ...s, order: 11 } : s))
  const c = detectOrderCollisions(bad)
  assert.ok(c.some((x) => String(x.owner).includes('同序')), `没抓住重复：${JSON.stringify(c)}`)
})
t('★⑧ 反证：把 greeting 塞回计划 ⇒ 断言必须红（证明 ⑤ 不是空跑）', () => {
  const withGreeting = [...CARD_SECTION_PLAN, { id: 'greeting', name: 'dma:card:greeting', order: 15, st: 'greeting-reference', label: '开场白' }]
  const hit = withGreeting.filter((s) => s.st.includes('greeting'))
  assert.equal(hit.length, 1, '反证样本没构造对')
  // 真正要证明的是：⑤ 那条断言在"有人塞回来"时会红 —— 这里用同一条谓词复算
  assert.throws(() => { if (hit.length !== 0) throw new Error('计划里还有 greeting 段') }, /greeting/)
})
t('★⑧ 反证：宿主没有 systemPrompt.section ⇒ 拒绝且不抛', () => {
  const r = registerCardSections({}, { enabled: true, fields: FIELDS })
  assert.equal(r.ok, false)
  assert.ok(String(r.refusedReason).includes('systemPrompt'), `原因应点明缺服务：${r.refusedReason}`)
})
t('★⑧ 反证：buildCardSections 对空/非字符串输入不生成段（不把 undefined 变成 "undefined"）', () => {
  const out = buildCardSections({ fields: { 'description': null, 'personality': 42 }, persona: undefined })
  assert.equal(out.length, 0, `不该生成段：${JSON.stringify(out.map((s) => s.name))}`)
})
t('⑧ 有条件可用的位只有"上游那一窗"这一条，且它不在硬保留清单里', () => {
  assert.equal(CONDITIONAL_ORDERS.length, 1)
  assert.equal(CONDITIONAL_ORDERS[0].order, 10)
  assert.equal(HARD_RESERVED_ORDERS.some((r) => r.order === 10), false)
})

console.log(`\n== 总结：${pass} 通过 / ${fails.length} 失败 ==`)
if (fails.length > 0) { for (const f of fails) console.log('   ' + f); process.exit(1) }
console.log('ALL PASS')
