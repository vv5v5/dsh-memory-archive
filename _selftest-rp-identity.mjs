#!/usr/bin/env node
/**
 * _selftest-rp-identity.mjs —— 身份段改写模块（preset-modules/rp-identity.js）的自检。
 *
 * 为什么单独一个台：它**改写**而不是置空宿主段 —— 一旦写歪，整局的"它以为自己在干什么"就歪了，
 * 而且它踩过一个会让整轮失败的坑（文本里带 `{{名字}}`）。所以两条反证都要钉住。
 * 用法：node _selftest-rp-identity.mjs
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(path.join(here, 'preset-modules', 'rp-identity.js')))

let pass = 0
const fails = []
function check(name, fn) {
  try { fn(); pass++; console.log('[PASS] ' + name) } catch (e) { fails.push(name); console.log('[FAIL] ' + name + ' :: ' + String((e && e.message) || e)) }
}
console.log('== _selftest-rp-identity.mjs · 身份段改写自检 ==')

/** 假 ctx：记录注册过的段与日志，effect 立即执行（与 rp-suppress 自检同款）。 */
function fakeCtx({ order = -1000, throwOnSection = false, sectionThrows = false } = {}) {
  const sections = []
  const logs = { info: [], warn: [] }
  return {
    sections,
    logs,
    ctx: {
      logger: { info: (m) => logs.info.push(String(m)), warn: (m) => logs.warn.push(String(m)) },
      effect: (fn) => fn(),
      systemPrompt: {
        section: (spec) => {
          if (sectionThrows) throw new Error('上游契约变了')
          sections.push(spec)
          return () => {}
        },
        getSectionOrder: (name) => {
          if (throwOnSection) throw new Error('不认识的安置名')
          assert.equal(name, 'HARNESS_IDENTITY', 'order 安置名应为 HARNESS_IDENTITY')
          return order
        },
      },
    },
  }
}

check('① 正向：注册同名 harness:identity，order 取 HARNESS_IDENTITY（-1000），文本是用户那句原文', () => {
  const f = fakeCtx()
  const r = mod.apply(f.ctx, {})
  assert.equal(r.registered, true)
  assert.equal(r.order, -1000)
  assert.equal(f.sections.length, 1)
  assert.equal(f.sections[0].name, 'harness:identity')
  assert.equal(f.sections[0].order, -1000)
  assert.equal(f.sections[0].text, 'You are an AI agent made for role-playing games.')
  assert.equal(r.chars, mod.DEFAULT_TEXT.length, '报告的字数必须等于实际文本长度（用常量算，⛔ 不写死数字）')
  assert.ok(f.logs.info.some((m) => /已把身份句换成/.test(m)), '要留一条 info 日志（换了没换可查）')
})

check('② 可配置：config.text 覆盖默认句；config.extra 追加在后面（两段之间空一行）', () => {
  const f = fakeCtx()
  mod.apply(f.ctx, { text: '你是跑团里的叙述者。', extra: '第二段。' })
  assert.equal(f.sections[0].text, '你是跑团里的叙述者。\n\n第二段。')
  const f2 = fakeCtx()
  mod.apply(f2.ctx, { text: '   ' })   // 只有空白 ⇒ 视为没给
  assert.equal(f2.sections[0].text, mod.DEFAULT_TEXT)
})

check('③ ★ 反证/护栏：文本里带 `{{名字}}` ⇒ **拒绝注册**（DSH 会判 unknown/malformed 并让整轮失败），身份句保持原样 + 告警', () => {
  const f = fakeCtx()
  const r = mod.apply(f.ctx, { text: 'You are {{model}} for role-play.' })
  assert.equal(r.registered, false)
  assert.equal(r.reason, 'prompt-variable-in-text')
  assert.equal(f.sections.length, 0, '⛔ 不该注册出任何段')
  assert.ok(f.logs.warn.some((m) => /拒绝注册/.test(m)), '要留 warn')
  // 反证：把判据放宽（允许变量）⇒ 这条判据必须能红
  const loose = (t) => false || /\{\{[^{}]*\}\}/.test(t)
  assert.equal(loose('You are {{model}} for role-play.'), true, '反证失败：判据本身不成立')
})

check('④ 绝不抛：systemPrompt 缺席 / order 抛 / section 抛 ⇒ 都只降级 + 不抛', () => {
  const r1 = mod.apply({ logger: { warn: () => {}, info: () => {} } }, {})
  assert.equal(r1.registered, false)
  assert.equal(r1.reason, 'no-system-prompt')
  const f2 = fakeCtx({ throwOnSection: true })
  const r2 = mod.apply(f2.ctx, {})
  assert.equal(r2.registered, true, '认不出安置名要退回 -1000 继续注册')
  assert.equal(f2.sections[0].order, -1000)
  const f3 = fakeCtx({ sectionThrows: true })
  const r3 = mod.apply(f3.ctx, {})
  assert.equal(r3.registered, false)
  assert.equal(r3.reason, 'threw')
  assert.ok(f3.logs.warn.some((m) => /改写失败/.test(m)))
})

check('⑤ 导出面：name / inject 合规（inject 恰好 systemPrompt），默认句与用户原文逐字一致', () => {
  assert.equal(mod.name, 'rp-identity')
  assert.deepEqual(mod.inject, ['systemPrompt'])
  assert.equal(mod.DEFAULT_TEXT, 'You are an AI agent made for role-playing games.')
  assert.equal(mod.resolveIdentityText({}), mod.DEFAULT_TEXT)
})

console.log('\n== 汇总：' + pass + ' 通过 / ' + fails.length + ' 失败 ==')
if (fails.length > 0) { console.log('失败项：\n  - ' + fails.join('\n  - ')); process.exit(1) }
