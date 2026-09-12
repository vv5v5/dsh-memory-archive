#!/usr/bin/env node
/**
 * dsh-memory-archive · lib/client.js 自检（任务书 §5，v4 第二单版）
 * 用法：node _selftest-client.mjs
 *
 * 第 1 步（node --check）在命令行单独跑；本脚本覆盖：
 *   第 2 步：假 window.__ModuleLoader__ 接住 factory + 假 react + 假 ctx 真调 apply()
 *            —— 席位恰好 1 个（sidebar.footer.action）、settings.section 为零、
 *               exports.__internals 存在、真名解析纯函数三级回退、面板各视图真渲染、
 *               提示词区三子页（每次请求三栏 / 两个模板卡片）真渲染。
 *   第 3 步：宿主 API 契约静态核对（根路径 + rest 全在表内）+ 第二单静态核对
 *            （sessions?titles=1、真实 session id 零残留、提示词数据面、§2 关键句）。
 *
 * 假 react 说明：createElement 遇到函数组件会**立即以假 hooks 调用它一次**（useEffect 只登记不执行，
 * 因此不会发任何网络请求）；useState 支持按「组件名 → hook 序号」注入预设值（__setPreset）。
 * hook 序号约定（v4）：
 *   MemoryArchiveButton #0=open；
 *   ArchivePanel #0=view #1=fullscreen #2=host #3=modeSave #4=disc #5=catalog #6=tick #7=pickedSessionId；
 *   ReadArea #0=active #1=notice；
 *   PromptsView #0=tab；TemplateCard #0=load #1=draft #2=save #3=refOpen #4=tick。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'

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
  const useMemo = (fn) => { idx++; return fn }
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
let mod = null

await check('ModuleLoader.load 被接住（顶层 IIFE 真执行），id=dsh-memory-archive，factory 是函数', () => {
  ;(0, eval)(src)
  assert.ok(win.__def, 'load() 未被调用 —— 顶层 IIFE 没执行')
  assert.equal(win.__def.id, 'dsh-memory-archive')
  assert.equal(typeof win.__def.factory, 'function')
})

await check('factory(require) 真执行并返回 module.exports（只 require react）', () => {
  mod = win.__def.factory((name) => {
    assert.equal(name, 'react')
    return fakeReact
  })
  assert.ok(mod && typeof mod === 'object')
})

await check("exports.name === 'dsh-memory-archive'；apply 是函数；inject 是数组", () => {
  assert.equal(mod.name, 'dsh-memory-archive')
  assert.equal(typeof mod.apply, 'function')
  assert.ok(Array.isArray(mod.inject))
})

await check('★ exports.__internals 存在，且恰好含 6 个纯函数', () => {
  const it = mod.__internals
  assert.ok(it, '__internals 缺失')
  assert.deepEqual(Object.keys(it).sort(),
    ['buildCatalogIndex', 'labelCharacter', 'labelPlaythrough', 'labelSession', 'pad4', 'shortId'])
  for (const k of Object.keys(it)) assert.equal(typeof it[k], 'function', k + ' 不是函数')
})

const gotNames = []
const injectedNames = []
const registeredList = []
const fakeSessions = {
  searchResultLimit: 30,
  search() { return Promise.resolve({ ok: true, value: { items: [], hasMore: false } }) },
  open() {},
}
const ctxLike = {
  get(name) { gotNames.push(name); return fakeSessions },
  slots: {
    inject(slotName, fn) { injectedNames.push(slotName); return fn() },
    register(meta, comp) { registeredList.push({ meta, comp }); return comp },
  },
}

await check('inject 名单的每个成员在假 ctx 上都有真实载体', () => {
  for (const item of mod.inject) {
    if (item === 'slots') {
      assert.equal(typeof ctxLike.slots.inject, 'function')
      assert.equal(typeof ctxLike.slots.register, 'function')
    } else if (item === 'sessions') {
      assert.equal(typeof ctxLike.get, 'function')
    } else {
      throw new Error('inject 里有假 ctx 不认识的能力: ' + String(item))
    }
  }
})

await check('apply(fakeCtx) 不抛；ctx.get("sessions") 被调用且返回值具备 search/open', () => {
  mod.apply(ctxLike)
  assert.ok(gotNames.includes('sessions'))
  assert.equal(typeof fakeSessions.search, 'function')
  assert.equal(typeof fakeSessions.open, 'function')
})

await check('★ 注册的席位恰好 1 个，且是 sidebar.footer.action', () => {
  assert.equal(registeredList.length, 1)
  assert.equal(registeredList[0].meta.name, 'sidebar.footer.action')
})

await check('★ settings.section 一个都没有（注入与注册两侧都为零）', () => {
  assert.equal(injectedNames.includes('settings.section'), false)
  assert.equal(registeredList.some((r) => r.meta.name === 'settings.section'), false)
})

// ---------- 真名解析：固定假 catalog（形状按任务书 §2.1 实测值构造） ----------
const itn = mod.__internals
const CHAR_ID = '11111111-1111-4111-8111-111111111111'
const PLAY_ID = 'playthrough-22222222-2222-4222-8222-222222222222'
const SESS_ID = 'session-00000000-0000-4000-8000-000000000001'
const OTHER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const fakeCatalog = {
  playthroughs: [{
    id: PLAY_ID,
    path: CHAR_ID + '/' + PLAY_ID + '/timeline.json',
    title: '1周目',
    lastOpenedAt: '2026-09-10T15:06:47.272Z',
    ext: {
      pmpDshTavern: {
        characterId: CHAR_ID,
        characterName: '影子',
        rootSessionId: SESS_ID,
        playthroughNumber: 1,
        autoTitle: true,
      },
    },
  }],
}
const idx = itn.buildCatalogIndex(fakeCatalog)

await check('buildCatalogIndex：对象与 JSON 字符串两种入参都行；空/坏输入给空索引不抛', () => {
  assert.equal(idx.charNames[CHAR_ID], '影子')
  assert.equal(idx.byPlaythrough[PLAY_ID].title, '1周目')
  assert.equal(idx.byRootSession[SESS_ID].playthroughId, PLAY_ID)
  const fromStr = itn.buildCatalogIndex(JSON.stringify(fakeCatalog))
  assert.equal(fromStr.charNames[CHAR_ID], '影子')
  const empty = itn.buildCatalogIndex(null)
  assert.deepEqual(empty, { charNames: {}, byPlaythrough: {}, byRootSession: {} })
})

await check('labelCharacter：目录命中给真名「影子」，未命中给 8 位短 ID', () => {
  assert.equal(itn.labelCharacter(CHAR_ID, idx), '影子')
  assert.equal(itn.labelCharacter(OTHER_ID, idx), 'aaaaaaaa…')
  assert.equal(itn.shortId(OTHER_ID), 'aaaaaaaa…')
})

await check('labelPlaythrough：含「1周目」；默认带「最后打开」；short 不带；未命中给短 ID', () => {
  const full = itn.labelPlaythrough(PLAY_ID, idx)
  assert.ok(full.includes('1周目'), '缺周目标题: ' + full)
  assert.ok(full.includes('最后打开'), '缺最后打开后缀: ' + full)
  assert.equal(itn.labelPlaythrough(PLAY_ID, idx, { short: true }), '1周目')
  assert.equal(itn.labelPlaythrough(OTHER_ID, idx, { short: true }), 'aaaaaaaa…')
  assert.equal(itn.labelPlaythrough('playthrough-99999999-aaaa-bbbb-cccc-dddddddddddd', idx, { short: true }), 'playthro…')
})

await check('★ labelSession 三级回退：title → 周目目录「影子 · 1周目」→ 短 ID「session-…」', () => {
  const l1 = itn.labelSession({ sessionId: SESS_ID, title: '手动起的名' }, idx)
  assert.deepEqual(l1, { text: '手动起的名', source: 'title' })
  const l2 = itn.labelSession({ sessionId: SESS_ID, title: null }, idx)
  assert.equal(l2.text, '影子 · 1周目')
  assert.equal(l2.source, 'playthrough')
  const l3 = itn.labelSession({ sessionId: SESS_ID, title: null }, {})
  assert.equal(l3.text, 'session-…')
  assert.equal(l3.source, 'id')
})

await check('★ 上述解析输出（真名/周目/短 ID 三路）都不含完整 UUID / 完整 sessionId', () => {
  const outs = [
    itn.labelCharacter(CHAR_ID, idx),
    itn.labelCharacter(OTHER_ID, idx),
    itn.labelPlaythrough(PLAY_ID, idx),
    itn.labelSession({ sessionId: SESS_ID, title: null }, idx).text,
    itn.labelSession({ sessionId: SESS_ID, title: null }, {}).text,
    itn.shortId(PLAY_ID),
  ]
  for (const o of outs) assert.equal(FULL_UUID_RE.test(o), false, '输出泄漏完整 id: ' + o)
})

await check('pad4：数字补零到 4 位', () => {
  assert.equal(itn.pad4(0), '0000')
  assert.equal(itn.pad4(7), '0007')
  assert.equal(itn.pad4(253), '0253')
})

// ---------- 面板渲染（假 hooks 注入状态，不发请求） ----------
const comp = registeredList[0].comp
await check('渲染按钮：wide=false 出 ⚙，wide=true 出「记忆库」，title=记忆库 · 阅读与设置', () => {
  const narrow = fakeReact.createElement(comp, { wide: false })
  const wide = fakeReact.createElement(comp, { wide: true })
  const sn = JSON.stringify(narrow)
  const sw = JSON.stringify(wide)
  assert.ok(sn.includes('⚙'), '窄态没有齿轮字符')
  assert.ok(sw.includes('记忆库'), '宽态没有「记忆库」')
  assert.ok(sn.includes('记忆库 · 阅读与设置') && sw.includes('记忆库 · 阅读与设置'), 'title 属性缺失')
  assert.ok(countNodes(wide) > 2)
})

await check('★ 顶层组件（面板）作为普通函数直接调用一次，不抛', () => {
  const readyHost = {
    healthStatus: 'ready',
    health: { ok: true, webServer: true, sessionQuery: true, storageDirWritable: true, tavernReachable: true },
    healthError: '', configStatus: 'ready',
    config: { ok: true, rootMode: 'workspace', api: { url: '', model: '' }, keySet: false, keyHint: null, storageDir: '', configPath: '', configError: null },
    configError: '',
  }
  fakeReact.__setPreset({
    MemoryArchiveButton: { 0: true },
    ArchivePanel: { 0: 'read', 1: false, 2: readyHost, 3: { busy: false, error: null }, 4: { status: 'loading', error: '', found: [], characterId: null, playthroughId: null }, 5: { status: 'loading', index: itn.buildCatalogIndex(null), error: '' }, 6: 0, 7: '' },
  })
  try {
    fakeReact.__begin('MemoryArchiveButton')
    const direct = comp({ wide: true })
    assert.ok(direct && typeof direct === 'object', '普通函数调用没有返回树')
  } finally { fakeReact.__setPreset(null) }
})

// 常用 fixture
const discReady = { status: 'ready', error: '', found: [{ charId: CHAR_ID, plays: [PLAY_ID] }], characterId: CHAR_ID, playthroughId: PLAY_ID }
const catalogReady = { status: 'ready', index: idx, error: '' }
const basePreset = (view, host, extra) => Object.assign({
  MemoryArchiveButton: { 0: true },
  ArchivePanel: Object.assign({ 0: view, 1: false, 2: host, 3: { busy: false, error: null } }, extra),
})

await check('★ 读视图（工作区）：顶栏=当前根人话名+提示词+设置+⛶+✕；★ 没有常驻根模式单选', () => {
  const readyHost = {
    healthStatus: 'ready',
    health: { ok: true, webServer: true, sessionQuery: true, storageDirWritable: true, tavernReachable: true },
    healthError: '', configStatus: 'ready',
    config: { ok: true, rootMode: 'workspace', api: { url: '', model: '' }, keySet: false, keyHint: null, storageDir: '', configPath: '', configError: null },
    configError: '',
  }
  fakeReact.__setPreset(basePreset('read', readyHost, { 4: discReady, 5: catalogReady, 6: 0, 7: '' }))
  try {
    const tree = fakeReact.createElement(comp, { wide: true })
    const s = JSON.stringify(tree)
    assert.ok(s.includes('当前根：影子 / 1周目'), '顶栏没有当前根人话名')
    for (const t of ['提示词', '⚙ 设置', '⛶', '✕']) assert.ok(s.includes(t), '顶栏缺按钮: ' + t)
    assert.equal(s.includes('根：会话') || s.includes('根：工作区'), false, '顶栏还残留常驻根模式单选')
    assert.ok(s.includes('阅读源'), '没有阅读源行')
    for (const t of ['摘要', '原文', '状态', '会话搜索']) assert.ok(s.includes(t), '缺阅读源: ' + t)
    const scrollers = []
    collectNodes(tree, (n) => n.props && n.props.tabIndex === 0 && typeof n.props.onKeyDown === 'function', scrollers)
    assert.ok(scrollers.length >= 1, '阅读区滚动容器没有 tabIndex+onKeyDown（键盘滚动缺失）')
  } finally { fakeReact.__setPreset(null) }
})

await check('★ 界面可见文本零完整 UUID（读视图·工作区）；底行是人话路径 + 复制按钮', () => {
  const readyHost = {
    healthStatus: 'ready',
    health: { ok: true, webServer: true, sessionQuery: true, storageDirWritable: true, tavernReachable: true },
    healthError: '', configStatus: 'ready',
    config: { ok: true, rootMode: 'workspace', api: { url: '', model: '' }, keySet: false, keyHint: null, storageDir: '', configPath: '', configError: null },
    configError: '',
  }
  fakeReact.__setPreset(basePreset('read', readyHost, { 4: discReady, 5: catalogReady, 6: 0, 7: '' }))
  try {
    const tree = fakeReact.createElement(comp, { wide: true })
    const text = visibleText(tree)
    assert.equal(FULL_UUID_RE.test(text), false, '可见文本泄漏完整 id:\n' + text)
    assert.ok(text.includes('影子 / 1周目 / archive'), '归档路径没有换成真名: ' + text)
    const copies = []
    collectNodes(tree, (n) => n.props && typeof n.props.onClick === 'function' && JSON.stringify(n.props).includes('复制'), copies)
    assert.ok(copies.length >= 1, '没有复制按钮')
  } finally { fakeReact.__setPreset(null) }
})

await check('★ 读视图（会话）：默认「会话事件」；标题=影子 · 1周目 + 来源徽标「来自周目目录」', () => {
  const readyHost = {
    healthStatus: 'ready',
    health: { ok: true, webServer: true, sessionQuery: true, storageDirWritable: true, tavernReachable: true },
    healthError: '', configStatus: 'ready',
    config: { ok: true, rootMode: 'session', root: { sessionId: SESS_ID, characterId: null, playthroughId: null }, api: { url: '', model: '' }, keySet: false, keyHint: null, storageDir: '', configPath: '', configError: null },
    configError: '',
  }
  fakeReact.__setPreset(basePreset('read', readyHost, { 4: discReady, 5: catalogReady, 6: 0, 7: '' }))
  try {
    const tree = fakeReact.createElement(comp, { wide: true })
    const s = JSON.stringify(tree)
    const text = visibleText(tree)
    assert.ok(s.includes('会话事件') && s.includes('会话搜索'), '会话模式的源不对')
    assert.equal(s.includes('摘要'), false, '会话模式不该出现摘要源')
    assert.ok(text.includes('会话事件 · 影子 · 1周目'), '事件区标题没有真名: ' + text)
    assert.ok(text.includes('来自周目目录'), '第 2 级回退没标来源徽标')
    assert.equal(FULL_UUID_RE.test(text), false, '可见文本泄漏完整 id')
  } finally { fakeReact.__setPreset(null) }
})

await check('读视图（工作区 + Tavern 不可达）：红字原因 + 源退到 会话事件/会话搜索', () => {
  const downHost = {
    healthStatus: 'ready',
    health: { ok: true, webServer: true, sessionQuery: true, storageDirWritable: true, tavernReachable: false },
    healthError: '', configStatus: 'ready',
    config: { ok: true, rootMode: 'workspace', api: { url: '', model: '' }, keySet: false, keyHint: null, storageDir: '', configPath: '', configError: null },
    configError: '',
  }
  fakeReact.__setPreset(basePreset('read', downHost, { 4: discReady, 5: catalogReady, 6: 0, 7: '' }))
  try {
    const tree = fakeReact.createElement(comp, { wide: true })
    const s = JSON.stringify(tree)
    assert.ok(s.includes('不可达'), '没有可读原因')
    // 只看「阅读源」按钮的实际标签（横幅文案里会提到摘要/原文/状态这几个字，不能拿全文判断）
    const clickables = []
    collectNodes(tree, (n) => n.props && typeof n.props.onClick === 'function' && typeof n.props.children === 'string', clickables)
    const labels = clickables.map((n) => n.props.children)
    assert.ok(labels.includes('会话事件') && labels.includes('会话搜索'), '没有退到可用源: ' + labels.join(','))
    assert.equal(labels.includes('原文'), false, 'Tavern 挂了还显示原文源')
    assert.equal(labels.includes('摘要'), false, 'Tavern 挂了还显示摘要源')
  } finally { fakeReact.__setPreset(null) }
})

await check('读视图（宿主 API 失败）：说明红字在，工作区阅读源照常', () => {
  const errHost = {
    healthStatus: 'error', health: null, healthError: 'HTTP 503 [SESSION_QUERY_UNAVAILABLE] x',
    configStatus: 'error', config: null, configError: '',
  }
  fakeReact.__setPreset(basePreset('read', errHost, { 4: discReady, 5: catalogReady, 6: 0, 7: '' }))
  try {
    const tree = fakeReact.createElement(comp, { wide: true })
    const s = JSON.stringify(tree)
    assert.ok(s.includes('宿主 API 不可用'), '缺宿主不可用说明')
    for (const t of ['摘要', '原文', '状态', '会话搜索']) assert.ok(s.includes(t), '缺阅读源: ' + t)
  } finally { fakeReact.__setPreset(null) }
})

// ---------- v4 第二单：提示词区三子页 ----------
const promptsHost = {
  healthStatus: 'ready',
  health: { ok: true, webServer: true, sessionQuery: true, storageDirWritable: true, tavernReachable: true },
  healthError: '', configStatus: 'ready',
  config: { ok: true, rootMode: 'workspace', api: { url: '', model: '' }, keySet: false, keyHint: null, storageDir: '', configPath: '', configError: null },
  configError: '',
}
const FAKE_TPL = {
  ok: true,
  templates: {
    compaction: { current: '压缩草稿甲', custom: false, builtin: '压缩内置乙', builtinEn: 'EN builtin 丙' },
    placeholder: { current: '占位草稿丁', custom: true, builtin: '占位内置戊' },
  },
  reference: { officialCompaction: 'OFFICIAL-COMPACTION-REF-己', officialPreamble: 'OFFICIAL-PREAMBLE-REF-庚' },
}
const promptsPreset = (promptsView, templateCard) => ({
  MemoryArchiveButton: { 0: true },
  ArchivePanel: { 0: 'prompts', 1: false, 2: promptsHost, 3: { busy: false, error: null }, 4: discReady, 5: catalogReady, 6: 0, 7: '' },
  PromptsView: { 0: promptsView },
  TemplateCard: templateCard,
})

await check('★ 提示词视图：三子页 tab + 返回阅读；默认「每次请求」，查看器三栏 UI 已搬入', () => {
  fakeReact.__setPreset(promptsPreset('requests', null))
  try {
    const tree = fakeReact.createElement(comp, { wide: true })
    const s = JSON.stringify(tree)
    for (const t of ['每次请求', '压缩指令', '收纳占位', '← 返回阅读']) assert.ok(s.includes(t), '缺子页按钮: ' + t)
    assert.equal(s.includes('提示词区（下一单交付'), false, '占位壳还在')
    assert.ok(s.includes('过滤：标题 / id / 工作区'), '左栏会话列表（查看器）没搬进来')
    assert.ok(s.includes('← 先选一个会话'), '中栏请求列表（查看器）没搬进来')
    assert.ok(s.includes('← 再选一次请求（第 N 次）'), '右栏部件视图（查看器）没搬进来')
    assert.equal(FULL_UUID_RE.test(visibleText(tree)), false, '提示词视图可见文本泄漏完整 id')
  } finally { fakeReact.__setPreset(null) }
})

await check('★ 压缩指令子页：解释逐字在、textarea(≥12行,初值=current)、按钮行齐、参考默认折叠、诚实提示在；展开见官方原文+出处', () => {
  fakeReact.__setPreset(promptsPreset('compaction', {
    0: { status: 'ready', data: FAKE_TPL, error: '' }, 1: FAKE_TPL.templates.compaction.current,
    2: { busy: false, error: '', ok: '' }, 3: false, 4: 0,
  }))
  try {
    const tree = fakeReact.createElement(comp, { wide: true })
    const s = JSON.stringify(tree)
    const text = visibleText(tree)
    for (const t of ['【这段提示词是干什么的】', 'Override this sole hook for a template or remote summarizer',
      'isolate realm', 'KV cache', '【怎么让它生效】', 'customInstruction', '【为什么不会污染编程模式】']) {
      assert.ok(text.includes(t), '解释文案缺句: ' + t)
    }
    const areas = []
    collectNodes(tree, (n) => n.$$element === 'textarea', areas)
    assert.equal(areas.length, 1, '文本框应当恰好 1 个')
    assert.ok(areas[0].props.rows >= 12, 'textarea 行数不足 12')
    assert.equal(areas[0].props.value, '压缩草稿甲', '文本框初值不是 current')
    for (const t of ['保存', '恢复内置默认', '复制', '载入内置默认', '官方原文参考']) assert.ok(s.includes(t), '缺按钮/折叠: ' + t)
    assert.ok(text.includes('当前：内置默认'), '缺状态行（当前：内置默认）')
    assert.ok(text.includes('⚠️ 保存只是把这段文本存进本插件配置'), '缺诚实提示')
    assert.equal(text.includes('OFFICIAL-COMPACTION-REF-己'), false, '参考默认应折叠（却已可见）')
    assert.equal(text.includes('来源：DSH 官方 compaction-basic'), false, '出处说明应随折叠隐藏')
  } finally { fakeReact.__setPreset(null) }

  fakeReact.__setPreset(promptsPreset('compaction', {
    0: { status: 'ready', data: FAKE_TPL, error: '' }, 1: FAKE_TPL.templates.compaction.current,
    2: { busy: false, error: '', ok: '' }, 3: true, 4: 0,
  }))
  try {
    const tree = fakeReact.createElement(comp, { wide: true })
    const text = visibleText(tree)
    assert.ok(text.includes('OFFICIAL-COMPACTION-REF-己'), '展开后没有官方原文')
    assert.ok(text.includes('来源：DSH 官方 compaction-basic（MIT，Copyright (c) 2026 DeepSeek）'), '缺出处说明')
  } finally { fakeReact.__setPreset(null) }
})

await check('★ 收纳占位子页：custom 徽标「自定义」+ 逐字解释 + 两条诚实提示 + 变量说明', () => {
  fakeReact.__setPreset(promptsPreset('placeholder', {
    0: { status: 'ready', data: FAKE_TPL, error: '' }, 1: FAKE_TPL.templates.placeholder.current,
    2: { busy: false, error: '', ok: '' }, 3: false, 4: 0,
  }))
  try {
    const tree = fakeReact.createElement(comp, { wide: true })
    const text = visibleText(tree)
    for (const t of ['【这段提示词是干什么的】', '<compacted-summary>', 'frameSummary',
      '【为什么占位行里要带关键词】', '可用变量：{from}',
      '⚠️ 本插件目前还没有实现收纳执行器', '⚠️ 官方 compaction 那条路上的前言写死在官方代码里']) {
      assert.ok(text.includes(t), '缺句: ' + t)
    }
    assert.ok(text.includes('自定义'), 'custom=true 却没有「自定义」徽标')
    const areas = []
    collectNodes(tree, (n) => n.$$element === 'textarea', areas)
    assert.equal(areas.length, 1, '文本框应当恰好 1 个')
    assert.equal(areas[0].props.value, '占位草稿丁', '文本框初值不是 current')
    assert.equal(text.includes('OFFICIAL-PREAMBLE-REF-庚'), false, '参考默认应折叠')
  } finally { fakeReact.__setPreset(null) }
})

await check('★ 模板读取失败（宿主不可用）：可读红字 + 重试，不出假输入框', () => {
  fakeReact.__setPreset(promptsPreset('compaction', {
    0: { status: 'error', data: null, error: 'HTTP 503 [X] 宿主不可用' }, 1: '', 2: { busy: false, error: '', ok: '' }, 3: false, 4: 0,
  }))
  try {
    const tree = fakeReact.createElement(comp, { wide: true })
    const text = visibleText(tree)
    assert.ok(text.includes('提示词模板读取失败'), '缺可读红字')
    assert.ok(text.includes('重试'), '缺重试按钮')
    const areas = []
    collectNodes(tree, (n) => n.$$element === 'textarea', areas)
    assert.equal(areas.length, 0, '失败态不该出文本框（假输入框）')
  } finally { fakeReact.__setPreset(null) }
})

await check('设置视图（工作区）：返回阅读 + 根模式/工作区根/API 设置/诊断；下拉显示真名', () => {
  const readyHost = {
    healthStatus: 'ready',
    health: { ok: true, webServer: true, sessionQuery: true, storageDirWritable: true, tavernReachable: true },
    healthError: '', configStatus: 'ready',
    config: { ok: true, rootMode: 'workspace', api: { url: 'https://example.invalid/v1', model: 'test-model' }, keySet: true, keyHint: '…abcd', storageDir: '/tmp/x', configPath: '/tmp/x/config.json', configError: null },
    configError: '',
  }
  fakeReact.__setPreset(basePreset('settings', readyHost, { 4: discReady, 5: catalogReady, 6: 0, 7: '' }))
  try {
    const tree = fakeReact.createElement(comp, { wide: true })
    const s = JSON.stringify(tree)
    const text = visibleText(tree)
    assert.ok(s.includes('← 返回阅读'), '缺返回阅读')
    for (const t of ['根模式', '工作区根（自动发现）', 'API 设置', '诊断']) assert.ok(s.includes(t), '缺设置块: ' + t)
    assert.ok(text.includes('影子'), '角色下拉没有真名')
    assert.ok(text.includes('1周目'), '周目下拉没有真名')
    assert.equal(FULL_UUID_RE.test(text), false, '设置视图可见文本泄漏完整 id')
    const pwInputs = []
    collectNodes(tree, (n) => n.props && n.props.type === 'password', pwInputs)
    assert.equal(pwInputs.length, 1, '密码输入框应当恰好 1 个')
    assert.equal(pwInputs[0].props.value, '', '★ 密钥输入框初值必须为空（不回显）')
    assert.ok(s.includes('已保存（…abcd）· 留空则不修改'), '密钥 placeholder 没用 keyHint')
  } finally { fakeReact.__setPreset(null) }
})

await check('设置视图（会话）：出现「根会话」块（真名下拉）', () => {
  const readyHost = {
    healthStatus: 'ready',
    health: { ok: true, webServer: true, sessionQuery: true, storageDirWritable: true, tavernReachable: true },
    healthError: '', configStatus: 'ready',
    config: { ok: true, rootMode: 'session', api: { url: '', model: '' }, keySet: false, keyHint: null, storageDir: '', configPath: '', configError: null },
    configError: '',
  }
  fakeReact.__setPreset(basePreset('settings', readyHost, { 4: discReady, 5: catalogReady, 6: 0, 7: '' }))
  try {
    const tree = fakeReact.createElement(comp, { wide: true })
    assert.ok(JSON.stringify(tree).includes('根会话'), '缺根会话块')
  } finally { fakeReact.__setPreset(null) }
})

await check('★ ⛶ 全屏：外壳切 inset/100vw/100vh/直角，且全屏时背景点击不关面板', () => {
  const readyHost = {
    healthStatus: 'ready',
    health: { ok: true, webServer: true, sessionQuery: true, storageDirWritable: true, tavernReachable: true },
    healthError: '', configStatus: 'ready',
    config: { ok: true, rootMode: 'workspace', api: { url: '', model: '' }, keySet: false, keyHint: null, storageDir: '', configPath: '', configError: null },
    configError: '',
  }
  fakeReact.__setPreset(basePreset('read', readyHost, { 1: true, 4: discReady, 5: catalogReady, 6: 0, 7: '' }))
  try {
    const tree = fakeReact.createElement(comp, { wide: true })
    const s = JSON.stringify(tree)
    assert.ok(s.includes('100vw') && s.includes('100vh'), '全屏样式缺失')
    const panels = []
    collectNodes(tree, (n) => n.$$component === 'ArchivePanel', panels)
    assert.equal(panels.length, 1)
    const backdrop = panels[0].rendered
    assert.equal(backdrop.props.onClick, undefined, '全屏时点背景不应关闭面板')
  } finally { fakeReact.__setPreset(null) }

  fakeReact.__setPreset(basePreset('read', readyHost, { 1: false, 4: discReady, 5: catalogReady, 6: 0, 7: '' }))
  try {
    const tree = fakeReact.createElement(comp, { wide: true })
    const s = JSON.stringify(tree)
    assert.ok(s.includes('min(1280px, 96vw)') && s.includes('min(860px, 92vh)'), '面板尺寸不是 1280×860')
    const panels = []
    collectNodes(tree, (n) => n.$$component === 'ArchivePanel', panels)
    assert.equal(typeof panels[0].rendered.props.onClick, 'function', '非全屏时点背景应关闭面板')
  } finally { fakeReact.__setPreset(null) }
})

// ---------- 第 3 步：宿主 API 契约静态核对 ----------
await check('★ API 根路径常量恰好是 /dsh-memory-archive/api；Tavern 通路恰好是既定 URL', () => {
  const m = src.match(/const HOST_API_BASE = '([^']+)'/)
  assert.ok(m, '未找到 HOST_API_BASE 常量')
  assert.equal(m[1], '/dsh-memory-archive/api')
  const m2 = src.match(/const TAVERN_API_BASE = '([^']+)'/)
  assert.ok(m2, '未找到 TAVERN_API_BASE 常量')
  assert.equal(m2[1], '/pmp-dsh-tavern/api/v2/workspace/files')
})

await check('★ 用到的宿主 rest 全在表内（含 /templates），且全部用到（prompt 数据面在另一条核对）', () => {
  const TABLE = [
    ['GET', '/config'],
    ['PUT', '/config'],
    ['POST', '/config/test'],
    ['GET', '/sessions'],
    ['GET', '/session/events'],
    ['GET', '/health'],
    ['GET', '/templates'],
    ['PUT', '/templates'],
  ]
  const found = [...src.matchAll(/HOST_API_BASE \+ '([^']+)'/g)].map((m) => m[1].split('?')[0])
  assert.ok(found.length > 0, '源码里没有任何 HOST_API_BASE + rest 调用')
  const allowed = new Set(TABLE.map(([, rest]) => rest))
  for (const rest of found) assert.ok(allowed.has(rest), '表外 rest: ' + rest)
  for (const rest of allowed) assert.ok(found.includes(rest), '表内路径未使用: ' + rest)
  for (const [method, rest] of TABLE) {
    assert.ok(typeof method === 'string' && rest.startsWith('/'), '表损坏: ' + method + ' ' + rest)
  }
})

await check('★ v4：事件 limit=200（宿主上限），URL 走 limit+offset', () => {
  const m = src.match(/const EVENT_PAGE_SIZE = (\d+)/)
  assert.ok(m, '未找到 EVENT_PAGE_SIZE')
  assert.equal(Number(m[1]), 200, '页长不是 200')
  assert.ok(src.includes("'/session/events?sessionId='"), 'session/events URL 拼法不对')
})

await check('★ v4 常量在位：摘要 60/20/窗口2；面板 1280×860', () => {
  assert.ok(src.includes('const SUMMARY_INIT_LIMIT = 60'))
  assert.ok(src.includes('const SUMMARY_MORE_STEP = 20'))
  assert.ok(src.includes('const SUMMARY_CONCURRENCY = 2'))
  assert.ok(src.includes("width: 'min(1280px, 96vw)'"))
  assert.ok(src.includes("height: 'min(860px, 92vh)'"))
})

await check('源码零 settings.section 字样；无写死绝对路径；不用 localStorage', () => {
  for (const bad of ['settings.section', 'localStorage', 'C:\\Users', 'C:/Users', 'D:\\apps', 'D:/apps']) {
    assert.equal(src.includes(bad), false, '源码出现禁串: ' + bad)
  }
})

await check('密钥契约：__CLEAR__ 约定在，密钥输入是 password，初值恒为空 useState(\'\')', () => {
  assert.ok(src.includes("'__CLEAR__'"))
  assert.ok(src.includes("type: 'password'"))
  assert.ok(src.includes("useState('')"))
})

// ---------- v4 第二单：静态核对（规格 §4.3） ----------
await check('★ §0.1 修复在源码里：GET /sessions 必须带 ?titles=1（会话真名的判据）', () => {
  assert.ok(src.includes("/sessions?titles=1"), '缺 /sessions?titles=1 —— 会话真名根因未修')
})

await check('★ §0.2 自查：client.js 里零 session-<uuid> 字面量（真实与合成都不该有）', () => {
  const hits = src.match(/session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []
  assert.deepEqual(hits, [], '出现 session-<uuid> 字面量: ' + hits.join(', '))
})

await check('★ 提示词数据面在位：PROMPT_API_BASE=/dsh-memory-archive/prompt，五个 rest 全用到', () => {
  const m = src.match(/const PROMPT_API_BASE = '([^']+)'/)
  assert.ok(m, '未找到 PROMPT_API_BASE 常量')
  assert.equal(m[1], '/dsh-memory-archive/prompt')
  const found = [...src.matchAll(/PROMPT_API_BASE \+ '([^']+)'/g)].map((x) => x[1].split('?')[0])
  for (const rest of ['/health', '/api/sessions', '/api/sessions/resolve', '/api/session', '/api/part']) {
    assert.ok(found.includes(rest), 'prompt rest 未使用: ' + rest)
  }
  assert.ok(src.includes("HOST_API_BASE + '/templates'"), '缺 /api/templates 数据面调用')
  assert.equal(src.includes("'/prompt-viewer'"), false, '不许再依赖已退役插件的路径 /prompt-viewer')
})

await check('★ P0 内存收紧：空闲补标题有硬上限 TITLE_FILL_CAP=20，resolve 调用处按上限截断（不再整表轮询）', () => {
  const m = src.match(/const TITLE_FILL_CAP = (\d+)/)
  assert.ok(m, '缺 TITLE_FILL_CAP 常量（每次进子页/刷新列表的补标题硬上限）')
  assert.equal(Number(m[1]), 20, '补标题上限应为 20（OOM 修复口径），实为 ' + (m ? m[1] : '(none)'))
  // resolve 调用处必须带上截断后的 batch，不许直接吃全量 pending（老写法会把 73 个会话全部解析）
  const call = src.match(/\/api\/sessions\/resolve\?ids=' \+ encodeURIComponent\(([A-Za-z_$][\w$]*)/)
  assert.ok(call, '未找到 resolve 调用处')
  assert.notEqual(call[1], 'pending', 'resolve 仍直接吃全量 pending —— 没有按上限截断')
  const decl = new RegExp('const ' + call[1] + ' = pending\\.slice\\(0, Math\\.min\\(')
  assert.ok(decl.test(src), call[1] + ' 不是「pending 按上限截断」得来的')
  assert.ok(/TITLE_FILL_CAP - \w+\.\w+/.test(src), '缺预算扣减（TITLE_FILL_CAP − 已发送数），做不到每轮硬上限')
  assert.ok(src.includes('resolveSentRef'), '缺预算计数 ref（预算须跨批累计、刷新列表才重置）')
  assert.equal(src.includes('pending.slice(0, 10)'), false, '老的全量轮询写法还在')
})

await check('★ §2 解释关键句全部进源码；仍然只 require(\'react\')', () => {
  for (const t of [
    'Override this sole hook for a template or remote summarizer',
    '<compacted-summary>',
    'frameSummary',
    'isolate realm',
    'KV cache',
  ]) assert.ok(src.includes(t), '缺关键句: ' + t)
  const reqs = [...src.matchAll(/require\(([^)]*)\)/g)].map((x) => x[1].trim())
  assert.ok(reqs.length >= 1, '没有任何 require')
  for (const r of reqs) assert.equal(r, "'react'", '出现 react 之外的 require: ' + r)
})

await check('★ a11y：每个表单字段创建点 e(\'input\'/e(\'textarea\'/e(\'select\') 200 字符内都有 id（浏览器自动填充 + 读屏定位）', () => {
  const re = /e\('(input|textarea|select)'/g
  let total = 0
  let withId = 0
  const missing = []
  let m
  while ((m = re.exec(src)) !== null) {
    total++
    const chunk = src.slice(m.index, m.index + 200)
    if (/(^|[^A-Za-z-])id\s*:/.test(chunk)) withId++
    else missing.push('L' + (src.slice(0, m.index).split('\n').length) + '(' + m[1] + ')')
  }
  console.log('   [info] 表单字段调用点 ' + total + ' 个 · 带 id ' + withId + ' 个')
  assert.ok(total > 0, '源码里没找到任何表单字段创建点（检查器自身失效）')
  assert.equal(withId, total, '缺 id 的字段 ' + (total - withId) + '/' + total + ' 个: ' + missing.join('；'))
})

console.log('== 总结：' + pass + ' 通过 / ' + fails.length + ' 失败 ==')
if (fails.length > 0) {
  console.log('失败项：' + fails.join('；'))
  process.exit(1)
}
