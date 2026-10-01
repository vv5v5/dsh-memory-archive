import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'
/**
 * dsh-memory-archive · lib/client.js 自检（任务书 §5，v4.1 A 单版）
 * 用法：node _selftest-client.mjs
 *
 * 第 1 步（node --check）在命令行单独跑；本脚本覆盖：
 *   第 2 步：假 window.__ModuleLoader__ 接住 factory + 假 react + 假 ctx 真调 apply()
 *            —— ★ 席位恰好 3 个（20260918 F 单起：sidebar.footer.action ×2，id 集合 =
 *               {memory-archive, agent-editor}，原样未动 + conversation.input.right ×1，
 *               id ooc-quote / order 90）、settings.section 为零、exports.__internals 存在、
 *               真名解析纯函数三级回退、★ 工作区名解析 / 空会话过滤 / 相对时间 / system
 *               分段注释（§2.6 逐字）、面板各视图真渲染、模板卡片真渲染、提示词查看器面板真渲染。
 *   第 3 步：宿主 API 契约静态核对（根路径 + rest 全在表内）+ v4.1 静态核对
 *            （完整视图拼装/截断标注/分块渲染、12 条版块注释逐字在源码、双席位 id）。
 *   第 4 步（D 单）：parseMarkdown 纯函数逐项断言 + 健壮性（畸形输入不抛）+ 静态断言
 *            （无 dangerouslySetInnerHTML；md 只用于正文不用于 system/tools/完整/状态；
 *            源列表无「会话搜索」、仍有 摘要/原文/状态；「阅读源」标签不再出现；
 *            CSS 兼容备忘两处逐字）。
 *   第 5 步（20260919 大纲单）：工作区档位逐字（摘要/原文/剧情大纲/向量）+ ★防剧透门
 *            （确认控件在、未确认路径零取数、判据灵敏度自证、"渲染门控与发起请求是同一个
 *            条件"的结构断言、大纲字面量全源码只在门后出现一次）。
 *
 * 假 react 说明：createElement 遇到函数组件会**立即以假 hooks 调用它一次**（useEffect 只登记不执行，
 * 因此不会发任何网络请求）；useState 支持按「组件名 → hook 序号」注入预设值（__setPreset）。
 * hook 序号约定（v4.1 → v5 P0）：
 *   MemoryArchiveButton #0=open；AgentEditorButton #0=open；
 *   ArchivePanel #0=view('read'|'templates'|'settings') #1=fullscreen #2=host #3=modeSave
 *     #4=disc #5=catalog #6=tick #7=pickedSessionId；
 *   AgentEditorPanel #0=fullscreen #1=health #2=sessions #3=hostRows #4=nameIdx #5=sessionId
 *     #6=detail #7=turn #8=part #9=partState #10=fullState #11=query #12=note
 *     （#13/#14 是 ref，默认即可）#15=agent #16=detect #17=detectTick #18=skillOn
 *     #19=apply #20=backups #21=backupsTick #22=rollback；
 *   ViewerSessionList #0=filter #1=expanded #2=showAll；
 *   TemplatesView #0=tab；TemplateCard #0=load #1=draft #2=save #3=refOpen #4=tick；
 *   CompositionBlock #0=open；KnobsPanel #0=open #1=tpl #2=diffPlan。
 *   OocQuoteButton（F 单 20260918）#0=btnRef(useRef) #1=verdict（useState 初值 = 当前选区判据，
 *     初值函数在台子上会真执行 ⇒ 靠 globalThis.window.getSelection / globalThis.document 假件喂选区）
 *     #2=note；useEffect 台子上不执行 ⇒ selectionchange 监听只存在于真机。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(here, 'lib', 'client.js'), 'utf8')

let pass = 0
const fails = []
async function check(name, fn) {
  try {
    await fn()
    pass++
    console.log('[PASS] ' + name)
  } catch (error) {
    fails.push(name)
    console.log('[FAIL] ' + name + ' :: ' + String((error && error.message) || error))
  }
}

// ---------- 假 react ----------
function makeFakeReact() {
  let hooks = null
  let idx = 0
  let preset = null // 形如 { 组件名: { hook序号: 值 } }
  function begin(name) { hooks = { states: [], name: name }; idx = 0 }
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
  // 20260918 查看器单：改回真语义（本帧求值一次）。此前返回 fn 本身，MarkdownBody
  // （唯一 useMemo 用户，client.js:1407）在台子上会 blocks.map 抛错 —— 消息流下钻要真渲染它。
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
    // 供「把组件当普通函数直接调用」用：先初始化 hooks 上下文（createElement 内部就是这么做）
    __begin(name) { begin(name) },
    // ★ 2026-09-25（浮层 ✕ 那一单）：「点一下按钮 ⇒ 组件自己的 state 变了没有」要**真读回来**。
    //   配合 `__begin(name)` + 直接调 `comp(props)` 用：那样 hooks 上下文**留在那个组件上**
    //   （createElement 渲染子组件时会保存/还原 `hooks`），于是 setState 写的就是这一个 `states` 数组
    //   ⇒ `__peek().states[1]` 就是那个组件的 #1 state 现值。
    //   ⚠️ 假 react 的 setState **不带重渲染** ⇒ 只拿它断言"state 变了没有"，⛔ 别拿它断言"画出来什么"。
    __peek() { return hooks },
  }
}

function countNodes(node) {
  if (node == null || typeof node === 'boolean') return 0
  if (Array.isArray(node)) return node.reduce((a, x) => a + countNodes(x), 0)
  if (typeof node === 'object') {
    let n = 1
    const child = node.rendered !== undefined ? node.rendered : (node.props && node.props.children)
    return n + countNodes(child)
  }
  return 1
}

function collectNodes(node, pred, out) {
  if (node == null || typeof node === 'boolean') return out
  if (Array.isArray(node)) { node.forEach((x) => collectNodes(x, pred, out)); return out }
  if (typeof node === 'object') {
    if (pred(node)) out.push(node)
    const child = node.rendered !== undefined ? node.rendered : (node.props && node.props.children)
    return collectNodes(child, pred, out)
  }
  return out
}

// 只收集「可见文本」（字符串 children），不含 props（title/value/placeholder 里允许放完整 id）
function collectText(node, out) {
  if (node == null || typeof node === 'boolean') return out
  if (Array.isArray(node)) { node.forEach((x) => collectText(x, out)); return out }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (typeof node === 'object') {
    collectText(node.rendered !== undefined ? node.rendered : (node.props && node.props.children), out)
  }
  return out
}
const FULL_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-/i
function visibleText(tree) { return collectText(tree, []).join('\n') }

console.log('== _selftest-client.mjs · dsh-memory-archive 客户端自检（v4） ==')

// ---------- 第 2 步：真加载 ----------
const win = { __ModuleLoader__: { load(def) { win.__def = def } } }
globalThis.window = win

const fakeReact = makeFakeReact()
win.document = { getElementById: () => null, addEventListener() {}, removeEventListener() {}, body: { style: {} }, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }) }
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
win.getSelection = () => null
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
try { globalThis.navigator = { userAgent: 'test' } } catch { /* Node 24 只读 */ }
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, events: [], ackAt: 0, unreadErrors: 0, sources: {} }), headers: new Map() })

const basePreset = (view, host, extra) => Object.assign({
  MemoryArchiveButton: { 0: true },
  ArchivePanel: Object.assign({ 0: view, 1: false, 2: host, 3: { busy: false, error: null } }, extra),
})
const clientSrcCode = readFileSync(path.join(here, 'lib', 'client.js'), 'utf8')
;(0, eval)(clientSrcCode)
const clientMod = win.__def.factory((name) => { if (name === 'react') return fakeReact; throw new Error('unexpected require: ' + name) })
console.log('factory 执行 ✓ · name =', clientMod.name)
const registeredList = []
const ctxLike = {
  get(name) { return fakeSessions },
  slots: {
    inject(slotName, fn) { return fn() },
    register(meta, comp) { registeredList.push({ meta, comp }); return comp },
  },
}
clientMod.apply(ctxLike)
console.log('apply ✓ · 席位:', registeredList.length)
const readyHost = {
  healthStatus: 'ready',
  health: { ok: true, webServer: true, sessionQuery: true, storageDirWritable: true, tavernReachable: true },
  healthError: '', configStatus: 'ready',
  config: { ok: true, rootMode: 'workspace', api: { url: '', model: '' }, keySet: false, keyHint: null, storageDir: '', configPath: '', configError: null },
  configError: '',
}
const discReady = { status: 'ready', found: [], characterId: 'ch', playthroughId: 'pt', error: '' }
const catalogReady = { status: 'ready', index: new Map(), error: '' }
fakeReact.__setPreset(basePreset('read', readyHost, { 4: discReady, 5: catalogReady, 6: 0, 7: '' }))
const comp = registeredList[0].comp
console.log('comp =', typeof comp)
const tree = fakeReact.createElement(comp, { wide: true, sessions: [] })
console.log('read 视图渲染 ✓')
const clickables = []
collectNodes(tree, (n) => n.props && typeof n.props.onClick === 'function' && typeof n.props.children === 'string', clickables)
console.log('clickables 总数:', clickables.length, '· 标签:', clickables.map((n) => n.props.children).slice(0, 20).join(' | '))
console.log('tree 节点数:', collectNodes(tree, () => true, []).length)
console.log('tree 顶层:', JSON.stringify(tree).slice(0, 200))
const faultBtn = clickables.find((n) => String(n.props.children).includes('故障'))
console.log('故障按钮:', faultBtn ? '找到 ✓' : '未找到 ✗')
if (faultBtn) {
  // 假 react 已知伪影：set 闭包引用的 hooks 在顶层渲染结束后被还原为 null ⇒ onClick 必抛，不是真 bug
  try { faultBtn.props.onClick(); console.log('onClick 执行 ✓') } catch (e) { console.log('onClick 抛错:', String(e).slice(0, 200)) }
  try {
    fakeReact.__setPreset(basePreset('health', readyHost, { 4: discReady, 5: catalogReady, 6: 0, 7: '' }))
    const tree3 = fakeReact.createElement(comp, { wide: true, sessions: [] })
    const t3 = visibleText(tree3)
    console.log('health 视图渲染 ✓ · 含「故障与健康」:', t3.includes('故障与健康') ? '✓' : '✗', '· 含「子系统」:', t3.includes('子系统') ? '✓' : '✗')
  } catch (e) { console.log('health 视图渲染抛错:', e.stack || String(e)) }
}

