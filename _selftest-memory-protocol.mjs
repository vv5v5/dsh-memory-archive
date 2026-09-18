#!/usr/bin/env node
/**
 * _selftest-memory-protocol.mjs —— `preset-modules/memory-protocol.js` 行为级自检（纯函数 + 假 ctx）。
 *
 * 跑法：node _selftest-memory-protocol.mjs   （⛔ 不碰 ~/.dsh、⛔ 不联网、⛔ 不碰真预设）
 *
 * 这台子钉的是 **D13 那条约定的守门**，不是"文本好不好"：
 *   ① 默认文本**必须是空的** —— 一旦在模块里塞了草稿，"没填"就长得像"填了"，守门作废；
 *   ② 空文本 ⇒ 段照注册（占位可见）**但**必须写一条显眼 warn（含"占位未填"）；
 *   ③ 非空 ⇒ 段文本**逐字**等于配置给的文本（⛔ 不加料）；
 *   ④ 带 `{{…}}` 的文本 ⇒ **拒绝注册**（DSH 会当提示词变量、整轮失败）并告警；
 *   ⑤ 服务缺失 / 抛错 ⇒ 一律降级，**绝不抛**（模块抛 = 预设挂不上 = 开不了周目）；
 *   ⑥ order 默认 1、可覆盖；
 *   ⑦ 隐私：本自检输出里不许出现任何真实会话/角色内容（本文件全程只用合成夹具）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const mp = await import(pathToFileURL(join(HERE, 'preset-modules', 'memory-protocol.js')).href)

let pass = 0
const fails = []
function check(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name) } catch (e) { fails.push(name); console.log('  FAIL ' + name + ' :: ' + String((e && e.message) || e)) }
}
const eq = (a, b, m) => { if (a !== b) throw new Error((m || '') + ' 期望 ' + JSON.stringify(b) + '，实得 ' + JSON.stringify(a)) }
const ok = (v, m) => { if (!v) throw new Error(m || '断言为假') }

/** 假 ctx：记录注册了哪些段（含文本与 order）+ 收集日志。 */
function fakeCtx({ noPrompt = false, throwOnSection = false } = {}) {
  const sections = []
  const logs = { info: [], warn: [] }
  const ctx = {
    logger: { info: (m) => logs.info.push(String(m)), warn: (m) => logs.warn.push(String(m)) },
    // ⚠️ 照真宿主建模：`ctx.effect(cb)` **同步执行 cb**，cb 抛的错会往上冒（不吞）。
    //    先前这里写成"吞掉"，于是 ⑥ 的"注册抛错"根本没传到 apply —— 那是假件错了，不是模块错了。
    effect: (fn) => fn(),
  }
  if (!noPrompt) {
    ctx.systemPrompt = {
      section: (s) => { if (throwOnSection) throw new Error('（自检注入）注册炸了'); sections.push(s); return () => {} },
    }
  }
  return { ctx, sections, logs }
}

console.log('== _selftest-memory-protocol.mjs · 记忆检索协议条款（D13 前置）==')

// ── ① 默认必须是**空**：这是守门的前提 ────────────────────────────────────────
check('① 默认文本为空（占位）—— 模块里⛔ 不许塞草稿，否则"没填"长得像"填了"', () => {
  eq(mp.DEFAULT_TEXT, '', 'DEFAULT_TEXT 必须是空串')
  eq(mp.resolveProtocolText(), '', '不传 config 就该是空')
  eq(mp.resolveProtocolText({}), '', '空 config 就该是空')
  ok(mp.isPlaceholder() === true, 'isPlaceholder() 该为 true')
  ok(mp.isPlaceholder({ text: '   ' }) === true, '全空白也算没填')
})

// ── ② 文本解析（纯函数）──────────────────────────────────────────────────────
check('② resolveProtocolText：text 优先 / 两头空白去掉 / extra 追加在后面 / 畸形入参不抛', () => {
  eq(mp.resolveProtocolText({ text: '  该查就查。  ' }), '该查就查。', '两头空白该去掉')
  eq(mp.resolveProtocolText({ text: 'A', extra: 'B' }), 'A\n\nB', 'extra 该以空行追加')
  eq(mp.resolveProtocolText({ text: '   ', extra: 'B' }), 'B', 'text 空时 extra 单独成立')
  eq(mp.resolveProtocolText({ text: 42, extra: null }), '', '非字符串一律当空')
  eq(mp.resolveProtocolText(null), '', 'null 不抛')
  ok(mp.isPlaceholder({ text: 'A' }) === false, '有文本就不是占位了')
})

// ── ③ 空文本 ⇒ 段照注册 + 必须告警 ─────────────────────────────────────────
check('③ 空文本：段**照注册**（位置占住、面板可见「空」），并且写一条含「占位未填」的 warn', () => {
  const { ctx, sections, logs } = fakeCtx()
  const r = mp.apply(ctx, {})
  ok(r.registered === true, '空文本也要注册（占位得看得见）')
  eq(r.placeholder, true, '该如实标 placeholder')
  eq(r.chars, 0, 'chars 该是 0')
  eq(sections.length, 1, '该注册一个段')
  eq(sections[0].name, 'mt:memoryProtocol', '段名不对')
  eq(sections[0].text, '', '空文本段该是空串')
  eq(sections[0].order, 1, '默认 order 该是 1')
  const warned = logs.warn.join('\n')
  ok(/占位未填/.test(warned), '缺「占位未填」告警：' + warned)
  ok(/anima/.test(warned) && /注入/.test(warned), '告警要写清"别把 anima 每轮注入关掉"：' + warned)
})

// ── ④ 非空 ⇒ 逐字，不加料 ──────────────────────────────────────────────────
check('④ 有文本：段文本**逐字**等于配置给的（⛔ 不加前缀/后缀/换行），并如实报字数', () => {
  const text = '第一行。\n第二行：该查就查。'
  const { ctx, sections, logs } = fakeCtx()
  const r = mp.apply(ctx, { text })
  eq(r.registered, true, '该注册')
  eq(r.placeholder, false, '不该标占位')
  eq(r.chars, text.length, '字数不对')
  eq(sections[0].text, text, '段文本必须逐字等于 config.text')
  ok(/已注册/.test(logs.info.join('\n')), '该有一条 info 记录')
  eq(logs.warn.length, 0, '有文本时不该有 warn：' + logs.warn.join(' / '))
})

// ── ⑤ 带 {{…}} ⇒ 拒绝注册（否则整轮失败）────────────────────────────────────
check('⑤ ★ 文本含 `{{…}}` ⇒ **拒绝注册** + 告警（DSH 会当提示词变量让整轮失败）—— 且⛔ 不清洗', () => {
  const { ctx, sections, logs } = fakeCtx()
  const r = mp.apply(ctx, { text: '你是 {{char}} 的记忆。' })
  eq(r.registered, false, '带变量必须拒绝')
  eq(r.reason, 'prompt-variable-in-text', '原因码不对')
  eq(sections.length, 0, '⛔ 不许注册（哪怕清洗过的版本也不行）')
  ok(/变量/.test(logs.warn.join('\n')), '该告警说明理由')
})

// ── ⑥ 降级：绝不抛 ─────────────────────────────────────────────────────────
check('⑥ 服务缺失 / 注册抛错 ⇒ 降级返回，**绝不抛**（模块抛 = 预设挂不上 = 开不了周目）', () => {
  const a = mp.apply(fakeCtx({ noPrompt: true }).ctx, { text: 'X' })
  eq(a.registered, false, '没 systemPrompt 该降级')
  eq(a.reason, 'no-system-prompt', '原因码不对')
  const b = mp.apply(fakeCtx({ throwOnSection: true }).ctx, { text: 'X' })
  eq(b.registered, false, '注册抛错该降级')
  eq(b.reason, 'threw', '原因码不对')
  let threw = null
  try { mp.apply(null, { text: 'X' }); mp.apply(undefined); mp.apply({}, null) } catch (e) { threw = e }
  eq(threw, null, '任何畸形 ctx/config 都不许抛：' + (threw && threw.message))
})

// ── ⑦ order 可覆盖 ─────────────────────────────────────────────────────────
check('⑦ order 默认 1；config.order 可覆盖（且非数就回落默认）', () => {
  eq(mp.MEMORY_PROTOCOL_ORDER, 1, '常量该是 1')
  const withOrder = fakeCtx()
  mp.apply(withOrder.ctx, { text: 'X', order: 42 })
  eq(withOrder.sections[0].order, 42, 'order 该被覆盖')
  const junk = fakeCtx()
  mp.apply(junk.ctx, { text: 'X', order: 'abc' })
  eq(junk.sections[0].order, 1, 'order 非数该回落 1')
})

// ── ⑧ 常量与包内副本 ───────────────────────────────────────────────────────
check('⑧ 段名带本仓库自建段的 `mt:` 前缀；源文件里⛔ 不出现任何真实会话内容', () => {
  eq(mp.SECTION_NAME, 'mt:memoryProtocol', '段名不对')
  const src = readFileSync(join(HERE, 'preset-modules', 'memory-protocol.js'), 'utf8')
  ok(src.includes("export const name = 'memory-protocol'"), 'name 导出没了')
  eq(/<\?xml|<recalledMemories>|阿柠|影子/.test(src), false, '源文件里不该有真实会话/角色内容')
})

console.log(`\n== 汇总：${pass} 通过 / ${fails.length} 失败 ==`)
if (fails.length > 0) { console.log('失败项：\n  - ' + fails.join('\n  - ')); process.exit(1) }
