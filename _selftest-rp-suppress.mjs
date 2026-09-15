#!/usr/bin/env node
/**
 * _selftest-rp-suppress.mjs —— RP 遮蔽模块（preset-modules/rp-suppress-host-sections.js）的行为自检。
 *
 * 为什么要有它：这个模块的失效方式**不允许**是"抛异常"（抛 = preset 挂不上 = 用户开不了周目），
 * 也不允许"悄悄不遮蔽"（那用户就白装了）。所以这里钉三件事：
 *   ① 正常路径：对默认三段各注册一次 `text: ''`，且 order 取自 `getSectionOrder`（位置不漂）
 *   ② 坏上下文（没有 systemPrompt / getSectionOrder 抛 / section 抛）：**一律不抛**，只是降级
 *   ③ 可扩展：config.sections 能追加（形状不对的条目被丢掉，不炸）
 * 纯假 ctx，不依赖 DSH（机制层面的"作用域确实遮蔽全局"由上游契约 + 工具目录里的探针证明）。
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(path.join(here, 'preset-modules', 'rp-suppress-host-sections.js')))

let pass = 0
const fails = []
function check(name, fn) {
  try { fn(); pass++; console.log('[PASS] ' + name) } catch (e) { fails.push(name); console.log('[FAIL] ' + name + ' :: ' + String(e && e.message || e)) }
}

/** 假 ctx：记录注册 + 记录日志 + effect 立即执行并记下 disposer。 */
function fakeCtx(opts = {}) {
  const registered = []
  const logs = []
  const disposers = []
  const ctx = {
    logger: { info: (m) => logs.push(['info', String(m)]), warn: (m) => logs.push(['warn', String(m)]) },
    effect: (fn) => { const d = fn(); disposers.push(d); return () => {} },
    systemPrompt: {
      section: (s) => { registered.push(s); if (opts.sectionThrows) throw new Error('section boom'); return () => {} },
      getSectionOrder: (n) => {
        if (opts.orderThrows) throw new Error('order boom')
        const table = { HARNESS_SOURCE: 10000, WEB_SURFACE: 10100, FILE_REFERENCE: 900, DELIVERABLE_FILE_REFERENCES: 9000 }
        return table[n]
      },
    },
  }
  if (opts.noPrompt) delete ctx.systemPrompt
  return { ctx, registered, logs, disposers }
}

check('① 默认四段各注册一次，text 全为空串', () => {
  const { ctx, registered, disposers } = fakeCtx()
  mod.apply(ctx, {})
  const names = registered.map((r) => r.name)
  assert.deepEqual(names.sort(), ['app:web-surface', 'context:file-reference', 'harness:source', 'ui:deliverable-file-references'])
  for (const r of registered) assert.equal(r.text, '', r.name + ' 的 text 必须是空串（遮蔽 = 注册空内容）')
  assert.equal(disposers.length, 4, '每个注册都要有 disposer（随作用域释放）')
})

check('①b order 取自 getSectionOrder（位置不漂：与全局那份同 order ⇒ 只换内容不换位置）', () => {
  const { ctx, registered } = fakeCtx()
  mod.apply(ctx, {})
  const byName = Object.fromEntries(registered.map((r) => [r.name, r.order]))
  assert.equal(byName['harness:source'], 10000)
  assert.equal(byName['app:web-surface'], 10100)
  assert.equal(byName['context:file-reference'], 900)
  assert.equal(byName['ui:deliverable-file-references'], 9000)
})

check('①c 成功要留一条 info 日志（装了没装可查）', () => {
  const { ctx, logs } = fakeCtx()
  mod.apply(ctx, {})
  const info = logs.filter(([lvl]) => lvl === 'info').map(([, m]) => m).join('\n')
  assert.ok(info.includes('harness:source') && info.includes('web-surface') && info.includes('file-reference'), 'info 日志没点名三段：' + info)
})

check('② 坏上下文：没有 systemPrompt ⇒ 不抛 + warn（RP 照常可用）', () => {
  const { ctx, registered, logs } = fakeCtx({ noPrompt: true })
  mod.apply(ctx, {})
  assert.equal(registered.length, 0)
  assert.ok(logs.some(([lvl, m]) => lvl === 'warn' && m.includes('systemPrompt 不可用')), '该有一条 warn')
})

check('②b section() 抛（例如上游契约变了）⇒ **绝不抛出去** + warn', () => {
  const { ctx, logs } = fakeCtx({ sectionThrows: true })
  mod.apply(ctx, {})   // 不抛就是通过
  assert.ok(logs.some(([lvl]) => lvl === 'warn'), '该有 warn')
})

check('②c getSectionOrder 抛 ⇒ 退回 order 0 继续遮蔽（不抛、不放弃）', () => {
  const { ctx, registered } = fakeCtx({ orderThrows: true })
  mod.apply(ctx, {})
  assert.equal(registered.length, 4, 'order 解析失败不该让遮蔽整体失效')
  for (const r of registered) assert.equal(r.order, 0)
})

check('③ config.sections 可追加（默认项优先、同层不重复）；形状不对的条目被丢掉（不炸）', () => {
  const { ctx, registered } = fakeCtx()
  mod.apply(ctx, { sections: [
    { name: 'some:extra-section', orderName: 'WEB_SURFACE' },   // 合法追加
    { name: 'harness:source' },                                  // ⛔ 与默认项重名 ⇒ 必须被去重跳过（同层重复会抛）
    { nope: 1 }, null, 'x', { name: '  ' },                      // 形状不对 ⇒ 丢
  ] })
  const names = registered.map((r) => r.name)
  assert.ok(names.includes('some:extra-section'), '合法追加项没注册')
  assert.equal(registered.length, 5, '该是 默认 4 段 + 追加 1 段（重名那条被去重）：' + JSON.stringify(names))
  assert.equal(names.filter((n) => n === 'harness:source').length, 1, '重名条目去重失败（同层重复会抛）')
  const extra = registered.find((r) => r.name === 'some:extra-section')
  assert.equal(extra.order, 10100, '追加项该用 orderName 解析出的 order')
})

check('④ 反证：把 text 改成非空串 ⇒ 第 ① 条判据必须红（证明它不是橡皮图章）', () => {
  const { ctx, registered } = fakeCtx()
  const original = mod.apply
  // 用真实 apply 注册后，人为把一条改成非空，再跑同一条判据
  original(ctx, {})
  registered[0].text = 'not empty'
  assert.throws(() => {
    for (const r of registered) if (r.text !== '') throw new Error('text 不是空串')
  }, /text 不是空串/, '反证失败：非空串时判据没红')
})

console.log(`\n${pass} PASS / ${fails.length} FAIL`)
if (fails.length > 0) { console.log('失败项：\n  - ' + fails.join('\n  - ')); process.exitCode = 1 }
