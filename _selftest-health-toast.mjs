#!/usr/bin/env node
/**
 * 自检台：记忆库报错的**前台提示**（2026-09-30，用户口径「给记忆库报错加前台提示」）。
 *
 * 链路：`healthEvent()` 落盘之后 ⇒ `healthSseFrame(event)` 造一帧（error/warn 都推，畸形不推）⇒
 * 那条**唯一的** SSE（`floors/events`）广播 `type:'health'` ⇒ 侧边栏常驻按钮（真机不卸载）收帧弹 toast；
 * 「查看故障」⇒ 开面板直落故障档（ArchivePanel 新增 `initialView`）。
 *
 * 覆盖面：
 *   · healthSseFrame 真值表（error/warn 归一、没话不推、畸形不抛）+ ★反证（无门槛退化版必与真版不同）；
 *   · 假 react 真渲染按钮组件：toast 在场/不在场、两颗按钮的 setState 都真读得回（__peek）；
 *   · source pin：client 处理 `health` 帧、index 推帧、ArchivePanel 吃 initialView、旧帧类型判据没被放宽。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { healthSseFrame } from './lib/health.js'

const HERE = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')
const CLIENT_SRC = readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8')
const INDEX_SRC = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8')

const PASS = []
const FAIL = []
const t = async (name, fn) => {
  try {
    await fn()
    PASS.push(name)
  } catch (e) {
    FAIL.push(`${name}: ${e?.message || e}`)
  }
}

// ── ① healthSseFrame 真值表 ──

await t('H1 error 事件 ⇒ 一帧 health（severity 归一与 pushEvent 同口径；hint/message 截断）', () => {
  const frame = healthSseFrame({ source: 'supervisor', severity: 'error', code: 'gave-up', message: '主管连续失败', hint: 'x'.repeat(400) })
  assert.equal(frame.type, 'health')
  assert.equal(frame.event.severity, 'error')
  assert.equal(frame.event.source, 'supervisor')
  assert.equal(frame.event.code, 'gave-up')
  assert.equal(frame.event.message, '主管连续失败')
  assert.equal(frame.event.hint.length, 300, 'hint 按层里的口径截到 300')
})

await t('H2 warn 事件也推（前台提示不分家；severity 非 error 一律 warn）', () => {
  const frame = healthSseFrame({ source: 'supervisor', severity: 'warn', code: 'inject-failed', message: '简报注入失败' })
  assert.equal(frame.event.severity, 'warn')
  // 畸形 severity ⇒ 归一成 warn，不抛
  const frame2 = healthSseFrame({ source: 's', severity: '爆炸', message: 'm' })
  assert.equal(frame2.event.severity, 'warn')
})

await t('H3 ★没有可给人看的话 / 畸形入参 ⇒ null（⛔ 不推空壳打扰）', () => {
  assert.equal(healthSseFrame({ source: 's', severity: 'error', message: '   ' }), null)
  assert.equal(healthSseFrame({ source: 's', severity: 'error' }), null)
  assert.equal(healthSseFrame(null), null)
  assert.equal(healthSseFrame('error'), null)
  assert.equal(healthSseFrame(undefined), null)
})

await t('H4 ★反证：把门槛拆掉的退化版必须与真版不同答案（否则 H3 是永真判据）', () => {
  const degraded = (event) => ({ type: 'health', event: event && typeof event === 'object' ? event : {} })
  const good = healthSseFrame(null)
  assert.notDeepEqual(good, degraded(null), '退化版与真版同答案 ⇒ H3 根本没在设防')
  assert.notDeepEqual(healthSseFrame({ source: 's', message: '' }), degraded({ source: 's', message: '' }))
})

// ── ② 客户端：假 react 真渲染按钮组件 ──

const win = { __ModuleLoader__: { load(def) { win.__def = def } } }
globalThis.window = win
const fakeReact = makeFakeReact()
win.document = { getElementById: () => null, addEventListener() {}, removeEventListener() {}, body: { style: {} }, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }) }
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
win.getSelection = () => null
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
try { globalThis.navigator = { userAgent: 'test' } } catch { /* Node 24 只读 */ }
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }), headers: new Map() })

function makeFakeReact() {
  let hooks = null
  let idx = 0
  let preset = null
  function begin(name) { hooks = { states: [], name }; idx = 0 }
  function useState(init) {
    const i = idx++
    if (!(i in hooks.states)) {
      const perComp = preset && preset[hooks.name]
      hooks.states[i] = perComp && i in perComp ? perComp[i] : (typeof init === 'function' ? init() : init)
    }
    const set = (v) => { hooks.states[i] = typeof v === 'function' ? v(hooks.states[i]) : v }
    return [hooks.states[i], set]
  }
  function useRef(v) {
    const i = idx++
    if (!(i in hooks.states)) hooks.states[i] = { current: v }
    return hooks.states[i]
  }
  const useEffect = () => { idx++ }
  const useLayoutEffect = () => { idx++ }
  const useCallback = (fn) => { idx++; return fn }
  const useMemo = (fn) => { idx++; return fn() }
  function createElement(type, props) {
    const rest = Array.prototype.slice.call(arguments, 2)
    const p = {}
    if (props) for (const k in props) p[k] = props[k]
    if (rest.length === 1) p.children = rest[0]
    else if (rest.length > 1) p.children = rest
    if (typeof type === 'function') {
      const savedH = hooks
      const savedI = idx
      begin(type.name || '(anon)')
      let rendered
      try { rendered = type(p) } finally { hooks = savedH; idx = savedI }
      return { $$component: type.name || '(anon)', props: p, rendered }
    }
    return { $$element: String(type), props: p }
  }
  return {
    createElement, useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo,
    __setPreset(p) { preset = p },
    __begin(name) { begin(name) },
    __peek() { return hooks },
  }
}

function collectNodes(node, pred, out = []) {
  if (node == null || typeof node === 'boolean') return out
  if (Array.isArray(node)) { node.forEach((x) => collectNodes(x, pred, out)); return out }
  if (typeof node === 'object') {
    if (pred(node)) out.push(node)
    const child = node.rendered !== undefined ? node.rendered : (node.props && node.props.children)
    return collectNodes(child, pred, out)
  }
  return out
}

function collectText(node, out = []) {
  if (node == null || typeof node === 'boolean') return out
  if (Array.isArray(node)) { node.forEach((x) => collectText(x, out)); return out }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (typeof node === 'object') collectText(node.rendered !== undefined ? node.rendered : (node.props && node.props.children), out)
  return out
}

// 真加载 client.js（与 _render-health-r2 同一套壳）
;(0, eval)(CLIENT_SRC)
const clientMod = win.__def.factory((name) => { if (name === 'react') return fakeReact; throw new Error('unexpected require: ' + name) })
const registeredList = []
clientMod.apply({
  get: (name) => (name === 'sessions' ? [] : null),
  slots: {
    inject(slotName, fn) { return fn() },
    register(meta, comp) { registeredList.push({ meta, comp }); return comp },
  },
})
const buttonComp = registeredList[0].comp

const TOAST_EVENT = { source: 'supervisor', severity: 'error', code: 'gave-up', message: '主管连续失败 3 次，放弃该楼的收纳', hint: '检查 supervisor.model 通道' }

function renderButton(toastState) {
  fakeReact.__setPreset({ MemoryArchiveButton: { 0: false, 1: null, 2: null, 3: toastState, 4: null } })
  fakeReact.__begin('MemoryArchiveButton')
  return buttonComp({ wide: true, sessions: [] })
}

const findByText = (tree, text) => collectNodes(tree, (n) => typeof n.props?.onClick === 'function' && String(n.props.children) === text, [])[0] ?? null

await t('H5 有 health 帧 ⇒ toast 在场（消息/hint/来源都画出来）；没有 ⇒ 一个字都不渲染', () => {
  const tree = renderButton(TOAST_EVENT)
  const text = collectText(tree).join('\n')
  assert.ok(text.includes('⚠ 记忆库错误'), '没有错误标题：' + text.slice(0, 200))
  assert.ok(text.includes('supervisor') && text.includes('gave-up'), '来源/故障码没画：')
  assert.ok(text.includes('主管连续失败 3 次'), '消息没画：')
  assert.ok(text.includes('↳ 检查 supervisor.model 通道'), 'hint 没画：')
  const empty = renderButton(null)
  assert.equal(collectText(empty).join('\n').includes('查看故障'), false, '没有事件时不许渲染空壳')
})

await t('H6 「查看故障」⇒ open=true + 初始档=health + toast 清掉（state 真读得回）', () => {
  const tree = renderButton(TOAST_EVENT)
  const btn = findByText(tree, '查看故障')
  assert.ok(btn, '找不到「查看故障」按钮')
  btn.props.onClick()
  const st = fakeReact.__peek()
  assert.equal(st.states[0], true, '面板必须被打开')
  assert.equal(st.states[4], 'health', '初始档必须是故障档')
  assert.equal(st.states[3], null, '点看之后 toast 要退场')
})

await t('H7 「知道了」⇒ 只清 toast（不开面板）；主按钮入口不携带初始档', () => {
  const tree = renderButton(TOAST_EVENT)
  const ack = findByText(tree, '知道了')
  assert.ok(ack, '找不到「知道了」按钮')
  ack.props.onClick()
  const st = fakeReact.__peek()
  assert.equal(st.states[3], null, 'toast 没清掉')
  assert.equal(st.states[0], false, '知道了不许开面板')
  // 主按钮（记忆库/⚙）入口：openView 归 null（默认档，不直落故障）
  const tree2 = renderButton(null)
  const main = collectNodes(tree2, (n) => typeof n.props?.onClick === 'function' && (String(n.props.children) === '记忆库' || String(n.props.children) === '⚙'), [])[0]
  assert.ok(main, '找不到入口按钮')
  main.props.onClick()
  assert.equal(fakeReact.__peek().states[4], null, '主按钮入口不许带 initialView')
})

await t('H8 warn 帧 ⇒ 警告样式的标题（与 error 区分）', () => {
  const tree = renderButton({ source: 'supervisor', severity: 'warn', code: 'inject-failed', message: '简报注入失败', hint: '' })
  const text = collectText(tree).join('\n')
  assert.ok(text.includes('⚠ 记忆库警告'), 'warn 没按警告标题画：' + text.slice(0, 200))
  assert.ok(!text.includes('↳'), '空 hint 不许渲染箭头行')
})

// ── ③ source pin（含反证） ──

await t('H9 ★source pin：三处接线都在，旧帧判据没被放宽', () => {
  assert.ok(CLIENT_SRC.includes("type === 'health'"), 'client 不认 health 帧')
  assert.ok(/type !== 'fork' && type !== 'hello'/.test(CLIENT_SRC), 'fork/hello 判据被放宽了（⛔ 前向兼容的口子不能开）')
  assert.ok(INDEX_SRC.includes('health.healthSseFrame'), 'healthEvent 没造前台帧')
  assert.ok(INDEX_SRC.includes('floorSseHub(null).push(frame)'), 'healthEvent 没把帧推上那条唯一的 SSE')
  assert.ok(/initialView === 'string' && initialView !== '' \? initialView : 'read'/.test(CLIENT_SRC.replace(/\n/g, ' ').replace(/\s+/g, ' ')) || CLIENT_SRC.includes("initialView : 'read'"), 'ArchivePanel 不吃 initialView')
})

console.log(`\n── ${PASS.length} 通过 / ${FAIL.length} 失败 ──`)
if (FAIL.length > 0) { console.log('失败：\n' + FAIL.join('\n')); process.exitCode = 1 }
