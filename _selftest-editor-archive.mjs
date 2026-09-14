#!/usr/bin/env node
/**
 * dsh-memory-archive · 编辑器「已归档会话」自检（20260914 M4 单；M5 单追加 11–14：主面板列表）
 * 用法：node _selftest-editor-archive.mjs
 *
 * 服务半侧：真 createHandler（lib/prompt-viewer.js）挂临时 http server，假 source + 可换的
 * archivedProvider —— 不启动 DSH。客户端半侧：假 react（照 _selftest-prompt-map.mjs：
 * 必须用 createElement 调组件，直接调函数组件会因 hooks=null 抛）+ exports.__editorArchive
 * （⛔ 不碰 __internals —— 既有台子对它做了恰好 15 键 deepEqual 断言）。覆盖：
 *   1. /api/sessions 行带 archived（true/false/null，字段名冻结）+ 信封 archive:{known,archivedCount}
 *   2. ★★反证A（缓存不烤位）：同一 30 秒 TTL 窗口内两次调用之间换 provider ⇒ 第二次跟变；
 *      「烤进缓存」的坏变体跑同一条断言必须红
 *   3. ★★反证B（未知 ≠ 未归档）：provider 抛错 / {known:false} / 没传 ⇒ 全行 archived:null、
 *      known:false、archivedCount:0；null 折成 false 的坏变体必须红
 *   4. /api/sessions/resolve 与 /api/session 也带位
 *   5. 客户端默认隐藏已归档行 + 顶部开关「显示已归档（N）」
 *   6. 开关打开：归档行回来、置灰、「已归档」徽标、原序保持
 *   7. ★★反证C（选中项）：选中的已归档会话在开关关闭时仍可见可读；漏掉豁免的坏变体必须红
 *   8. 客户端 known:false ⇒ 一条不隐藏 +「归档状态不可用（已按普通会话显示）」
 *   9. 详情页提示「该会话已归档（日志仍在，内容照常可读）」（archived:true 才出现，null 不猜）
 *  10. 合并不写源行（缓存行对象冻结也不抛、源行不 gain archived 键）——位只活在响应里
 *  —— 20260914 M5 单（记忆库主面板 /dsh-memory-archive/api/sessions 也认归档位）——
 *  11. /api/sessions 每行 archived ∈ {true,false}（与注册表逐 id 对上）+ 信封 archive:{known,archivedCount}
 *  12. ★★反证A（titlesCache 不烤位）：同一 handler、同一 30 秒 titles 缓存窗口内换注册表
 *      ⇒ 第二次 archived/archivedCount 跟变（位逐请求现取，绝不烤进 titles 投影缓存）
 *  13. ★★反证B（未知 ≠ 未归档）：注册表 getter 抛错 / ids 非数组 / 服务缺席 ⇒ 全行 null、
 *      known:false、archivedCount:0；titles=0 快路径同样带位
 *  14. 客户端 SessionRootPicker（选根下拉）：默认不隐藏（1 归档 + 2 普通 ⇒ 3 个 option 全在）、
 *      归档行【已归档】徽标 + 置灰 + title 说明；known:false ⇒ 一行不标 +「归档状态不可用」小字
 *  —— 20260914 M6 单（/config 根回显 + 头部「当前根已归档」提示）——
 *  15. /config 投影回 root：未配置 ⇒ root===null（⛔ 不编空串）；PUT 后 GET 原样回显；清空 ⇒ null
 *  16. 客户端不回弹：config.root 回显 ⇒ select 停在已存根；root=null ⇒ 回落占位项
 *  17. rootArchiveHint 文案：会话根+已知+已归档 ⇒ 一句话；未知/未归档/工作区根 ⇒ null（只提示口径）
 */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(path.join(here, 'lib', 'client.js'), 'utf8')

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

// ---------- 假 react（与 _selftest-prompt-map.mjs 同一套） ----------
function makeFakeReact() {
  let hooks = null
  let idx = 0
  let preset = null
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
  }
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
function collectText(node, out) {
  if (node == null || typeof node === 'boolean') return out
  if (Array.isArray(node)) { node.forEach((x) => collectText(x, out)); return out }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (typeof node === 'object') collectText(node.rendered !== undefined ? node.rendered : (node.props && node.props.children), out)
  return out
}
function visibleText(tree) { return collectText(tree, []).join('\n') }

// ---------- 客户端加载（假 window.__ModuleLoader__ 接住 factory） ----------
const win = { __ModuleLoader__: { load(def) { win.__def = def } } }
globalThis.window = win
const fakeReact = makeFakeReact()
;(0, eval)(clientSrc)
assert.ok(win.__def, 'client factory 未被接住')
const mod = win.__def.factory(() => fakeReact)
const ViewerSessionList = mod.__editorArchive && mod.__editorArchive.ViewerSessionList
assert.ok(typeof ViewerSessionList === 'function', '缺 exports.__editorArchive.ViewerSessionList')
// M5：选根下拉（SessionRootPicker）——旧代码没有这个出口，缺 ⇒ 只让 14 组红，不炸整台
const SessionRootPicker = mod.__editorArchive && mod.__editorArchive.SessionRootPicker
// M6：头部「当前根已归档」提示的纯文案函数
const rootArchiveHint = mod.__editorArchive && mod.__editorArchive.rootArchiveHint

// ---------- 服务半侧工装：假 source + 临时 http server ----------
const NOW = new Date().toISOString()
/** 假 fs 索引行（⚠ 故意不带 archived 键：位必须由 api 层现取现合并）。 */
const BASE_ROWS = [
  { id: 's-archived', workspace: 'ws', sizeBytes: 10, mtimeMs: 300 },
  { id: 's-normal-b', workspace: 'ws', sizeBytes: 20, mtimeMs: 200 },
  { id: 's-normal-c', workspace: 'ws', sizeBytes: 30, mtimeMs: 100 },
]
function fakeSource(rows) {
  return {
    listSessions: async () => rows.map((r) => ({ ...r })),
    resolveSessions: async (ids) => {
      const m = new Map(rows.map((r) => [r.id, r]))
      return ids.filter((id) => m.has(id)).map((id) => ({ ...m.get(id), mtime: NOW, title: 't-' + id, requests: 1 }))
    },
    sessionDetail: async (id) => {
      const r = rows.find((x) => x.id === id)
      return r ? { row: r, parsed: { title: 't-' + id, meta: {}, requests: [] } } : null
    },
    scanIndex: () => rows,
    forget: () => {},
  }
}
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({ url: 'http://127.0.0.1:' + port, close: () => new Promise((r) => server.close(r)) })
    })
  })
}
async function getJson(base, p) {
  const res = await fetch(base + p)
  return { status: res.status, body: await res.json() }
}
const { createHandler } = await import('file://' + path.join(here, 'lib', 'prompt-viewer.js').replace(/\\/g, '/'))

console.log('== _selftest-editor-archive.mjs · 编辑器「已归档会话」自检 ==')

// ---------- 1：行带归档位 + 信封 ----------
await check('★1 /api/sessions：每行 archived ∈ {true,false,null}（与 provider 逐 id 对上）+ 信封 {known:true,archivedCount}', async () => {
  let calls = 0
  const provider = () => { calls++; return { known: true, ids: ['s-archived'] } }
  const srv = await startServer(createHandler({ archivedProvider: provider }, fakeSource(BASE_ROWS)))
  try {
    const { body } = await getJson(srv.url, '/api/sessions')
    assert.equal(body.ok, true, 'ok:false')
    assert.deepEqual(body.archive, { known: true, archivedCount: 1 }, '信封不对：' + JSON.stringify(body.archive))
    const bits = Object.fromEntries(body.sessions.map((r) => [r.id, r.archived]))
    assert.deepEqual(bits, { 's-archived': true, 's-normal-b': false, 's-normal-c': false }, '行归档位不对：' + JSON.stringify(bits))
    for (const r of body.sessions) assert.ok(r.archived === true || r.archived === false, 'archived 必须是布尔（字段名冻结）')
    assert.equal(calls, 1, 'provider 没有按请求现取')
  } finally { await srv.close() }
})

// ---------- 2：★★反证A（缓存不烤位） ----------
/** 同一条「换 provider 第二次必须跟变」断言 —— 绿版喂真 handler，红版喂烤进缓存的坏路径。 */
async function expectSwapFollows(listFn) {
  let ids = ['s-archived']
  const provider = () => ({ known: true, ids: ids })
  const first = await listFn(provider)
  assert.equal(first.find((r) => r.id === 's-normal-b').archived, false, '第一次：b 应为 false')
  ids = ['s-archived', 's-normal-b']            // ★ 同一 30 秒 TTL 窗口内改掉假 provider
  const second = await listFn(provider)
  assert.equal(second.find((r) => r.id === 's-normal-b').archived, true, '第二次：b 必须跟变 true（位没被烤进缓存）')
}
await check('★★2 反证A（缓存不烤位）绿：30 秒窗口内两次 /api/sessions 之间换 provider ⇒ 第二次 archived 跟变、信封 archivedCount 跟变', async () => {
  const srv = await startServer(createHandler({}, fakeSource(BASE_ROWS)))
  try {
    await expectSwapFollows(async (provider) => {
      const handler = createHandler({ archivedProvider: provider }, fakeSource(BASE_ROWS))
      const srv2 = await startServer(handler)
      try { return (await getJson(srv2.url, '/api/sessions')).body.sessions } finally { await srv2.close() }
    })
    // 每次请求都重建 handler 也绿 —— 再验证同一个 handler 内换 provider（真 30 秒 TTL 同窗）
    let ids = ['s-archived']
    const src = fakeSource(BASE_ROWS)
    const handler = createHandler({ archivedProvider: () => ({ known: true, ids }) }, src)
    const srv3 = await startServer(handler)
    try {
      const b1 = (await getJson(srv3.url, '/api/sessions')).body
      ids = ['s-archived', 's-normal-b']
      const b2 = (await getJson(srv3.url, '/api/sessions')).body
      assert.equal(b2.sessions.find((r) => r.id === 's-normal-b').archived, true, '同一 handler 内第二次没跟变')
      assert.equal(b2.archive.archivedCount, 2, '信封 archivedCount 没跟变：' + JSON.stringify(b2.archive))
      assert.equal(b1.sessions.find((r) => r.id === 's-normal-b').archived, false, '第一次就变了？时序错了')
    } finally { await srv3.close() }
  } finally { await srv.close() }
})
await check('★★2 反证A 红：把位烤进「扫描缓存」的坏变体（listSessions 只在首调解析归档位）跑同一条断言必须抛 —— 证明断言不是橡皮图章', async () => {
  // 坏变体：归档位在 listSessions（≈scanIndex 缓存层）里被一次性烤死 —— 正是任务书点名的写法
  let ids = ['s-archived']
  let baked = null
  const brokenSource = {
    listSessions: async () => {
      if (!baked) baked = BASE_ROWS.map((r) => ({ ...r, archived: ids.includes(r.id) }))
      return baked.map((r) => ({ ...r }))
    },
  }
  const bakeList = async (provider) => (await brokenSource.listSessions()).map((r) => ({ ...r }))
  await assert.rejects(() => expectSwapFollows(bakeList), /必须跟变/, '烤进缓存的坏实现竟通过了跟变断言')
})

// ---------- 3：★★反证B（未知 ≠ 未归档） ----------
await check('★★3 反证B（未知 ≠ 未归档）绿：provider 抛错 / {known:false} / 没传 ⇒ 全行 archived===null、known:false、archivedCount:0', async () => {
  const variants = {
    'provider 抛错': () => { throw new Error('registry not ready') },
    'known:false': () => ({ known: false, ids: [] }),
    '形状不对': () => ({ nonsense: 1 }),
    '返回 undefined': () => undefined,
  }
  for (const [label, provider] of Object.entries(variants)) {
    const srv = await startServer(createHandler({ archivedProvider: provider }, fakeSource(BASE_ROWS)))
    try {
      const { body } = await getJson(srv.url, '/api/sessions')
      assert.deepEqual(body.archive, { known: false, archivedCount: 0 }, '[' + label + '] 信封不对：' + JSON.stringify(body.archive))
      for (const r of body.sessions) assert.equal(r.archived, null, '[' + label + '] ' + r.id + ' archived 应为 null（未知），实际 ' + r.archived)
    } finally { await srv.close() }
  }
  const srvNone = await startServer(createHandler({}, fakeSource(BASE_ROWS)))
  try {
    const { body } = await getJson(srvNone.url, '/api/sessions')
    assert.equal(body.archive.known, false, '没传 provider 也必须 known:false')
    for (const r of body.sessions) assert.equal(r.archived, null, '没传 provider：' + r.id + ' 应为 null')
  } finally { await srvNone.close() }
})
await check('★★3 反证B 红：把未知折成「未归档」（null→false）的坏变体跑同一条 null 断言必须抛', () => {
  const foldUnknownToFalse = (bits) => bits.map((b) => (b === null ? false : b))   // 坏变体
  const bits = foldUnknownToFalse([null, null])
  assert.throws(() => { for (const b of bits) assert.equal(b, null, 'archived 应为 null（未知）') }, /应为 null/, 'null→false 折叠竟通过了未知断言')
})

// ---------- 4：另两个出口 ----------
await check('★4 /api/sessions/resolve 与 /api/session 也带归档位（known:true ⇒ true/false；未知 ⇒ null）', async () => {
  const srv = await startServer(createHandler({ archivedProvider: () => ({ known: true, ids: ['s-archived'] }) }, fakeSource(BASE_ROWS)))
  try {
    const res = (await getJson(srv.url, '/api/sessions/resolve?ids=s-archived,s-normal-b')).body
    assert.equal(res.archive.known, true, 'resolve 信封缺 known')
    assert.equal(res.sessions.find((r) => r.id === 's-archived').archived, true, 'resolve 归档行应为 true')
    assert.equal(res.sessions.find((r) => r.id === 's-normal-b').archived, false, 'resolve 普通行应为 false')
    const det = (await getJson(srv.url, '/api/session?id=s-archived')).body
    assert.equal(det.ok, true, 'detail ok:false')
    assert.equal(det.archived, true, 'detail 归档行应为 true')
    const det2 = (await getJson(srv.url, '/api/session?id=s-normal-b')).body
    assert.equal(det2.archived, false, 'detail 普通行应为 false')
  } finally { await srv.close() }
  const srvU = await startServer(createHandler({ archivedProvider: () => { throw new Error('x') } }, fakeSource(BASE_ROWS)))
  try {
    const det = (await getJson(srvU.url, '/api/session?id=s-archived')).body
    assert.equal(det.archived, null, '未知 ⇒ detail archived 应为 null')
    const res = (await getJson(srvU.url, '/api/sessions/resolve?ids=s-archived')).body
    assert.equal(res.sessions[0].archived, null, '未知 ⇒ resolve 行应为 null')
  } finally { await srvU.close() }
})

// ---------- 5–8：客户端（ViewerSessionList，hook #3 = showArchived） ----------
const NAME_IDX = { charNames: {}, byPlaythrough: {}, byRootSession: {} }
const CLIENT_ROWS = [
  { id: 'n1', workspace: 'ws', sizeBytes: 1, mtime: NOW, title: '普通一', requests: 2, archived: false },
  { id: 'a1', workspace: 'ws', sizeBytes: 2, mtime: NOW, title: '已归档甲', requests: 3, archived: true },
  { id: 'a2', workspace: 'ws', sizeBytes: 3, mtime: NOW, title: '已归档乙', requests: 4, archived: true },
  { id: 'n2', workspace: 'ws', sizeBytes: 4, mtime: NOW, title: '普通二', requests: 5, archived: false },
]
const READY = { status: 'ready', items: CLIENT_ROWS, error: null, archive: { known: true, archivedCount: 2 } }
function renderList(state, selectedId, preset) {
  fakeReact.__setPreset(preset ? { ViewerSessionList: preset } : null)
  try {
    return fakeReact.createElement(ViewerSessionList, {
      state, hostById: null, hostError: null, selectedId: selectedId || '', onSelect: () => {},
      onRefresh: () => {}, nameIdx: NAME_IDX, width: 300,
    })
  } finally { fakeReact.__setPreset(null) }
}
const rowNodes = (tree) => collectNodes(tree, (n) => n.props && n.props.className === 'dma-row', [])
const rowIds = (tree) => rowNodes(tree).map((n) => n.props.key)

await check('★5 客户端默认隐藏：archived===true 的行不渲染（可见 2/4），顶部开关文案「显示已归档（2）」', () => {
  const tree = renderList(READY, '')
  assert.deepEqual(rowIds(tree), ['n1', 'n2'], '默认视图不该有归档行：' + rowIds(tree).join(','))
  const text = visibleText(tree)
  assert.ok(text.includes('显示已归档（2）'), '开关文案缺 N=2：' + text.slice(0, 200))
  assert.equal(text.includes('已归档甲'), false, '归档行标题不该出现在默认视图')
  assert.ok(text.includes('共 4 个 · 显示 2 个'), '计数行没反映隐藏')
})
await check('★6 开关打开（hook #3=true）：归档行回来、置灰（opacity）、「已归档」徽标、原序保持（n1,a1,a2,n2）', () => {
  const tree = renderList(READY, '', { 3: true })
  assert.deepEqual(rowIds(tree), ['n1', 'a1', 'a2', 'n2'], '打开后必须原序全显：' + rowIds(tree).join(','))
  const arch = rowNodes(tree).filter((n) => n.props['data-arch'] === '1')
  assert.deepEqual(arch.map((n) => n.props.key), ['a1', 'a2'], '归档行没打 data-arch 标')
  for (const n of arch) {
    assert.equal(n.props.style.opacity, 0.55, n.props.key + ' 没置灰')
    assert.ok(n.props.children, '行缺内容')
  }
  const badges = collectNodes(tree, (n) => n.props && n.props['data-arch-badge'] === '1', [])
  assert.equal(badges.length, 2, '「已归档」徽标数不对：' + badges.length)
  assert.ok(visibleText(tree).includes('隐藏已归档（2）'), '打开态开关文案不对')
})
await check('★★7 反证C（选中项）绿：选中的已归档会话（a1）在开关关闭时仍可见（data-sel=1），另一个归档行（a2）照藏', () => {
  const tree = renderList(READY, 'a1', null)
  assert.deepEqual(rowIds(tree), ['n1', 'a1', 'n2'], '选中已归档会话必须保持可见，且只多出这一行：' + rowIds(tree).join(','))
  const sel = rowNodes(tree).filter((n) => n.props['data-sel'] === '1')
  assert.equal(sel.length, 1, '选中行没标 data-sel')
  assert.equal(sel[0].props.key, 'a1', '可见的选中行不是 a1')
  assert.equal(sel[0].props['data-arch'], '1', '选中行应是归档行')
})
await check('★★7 反证C 红：漏掉「选中豁免」的坏谓词跑同一条可见断言必须抛', () => {
  const brokenHide = (row, ctx) => ctx.known && row.archived === true && !ctx.show   // 坏变体：没有 row.id !== selectedId
  const a1 = CLIENT_ROWS.find((r) => r.id === 'a1')
  assert.throws(() => {
    assert.equal(brokenHide(a1, { known: true, show: false, selectedId: 'a1' }), false, '选中的已归档行必须豁免')
  }, /必须豁免/, '漏豁免的坏谓词竟通过了选中项断言')
})
await check('★8 客户端 known:false：一条不隐藏（4/4 全显）+「归档状态不可用（已按普通会话显示）」小字；信封缺失同样全显', () => {
  const unknown = { status: 'ready', items: CLIENT_ROWS.map((r) => ({ ...r, archived: null })), error: null, archive: { known: false, archivedCount: 0 } }
  const t1 = renderList(unknown, '')
  assert.deepEqual(rowIds(t1), ['n1', 'a1', 'a2', 'n2'], '未知时一条都不许隐藏：' + rowIds(t1).join(','))
  assert.ok(visibleText(t1).includes('归档状态不可用（已按普通会话显示）'), '缺「归档状态不可用」小字')
  assert.equal(visibleText(t1).includes('显示已归档'), false, '未知时不应出现归档开关（没东西可藏）')
  const noEnvelope = { status: 'ready', items: CLIENT_ROWS.map((r) => ({ ...r, archived: null })), error: null, archive: null }
  const t2 = renderList(noEnvelope, '')
  assert.deepEqual(rowIds(t2), ['n1', 'a1', 'a2', 'n2'], '信封缺失（旧服务端）同样一条不许隐藏')
})

// ---------- 9：详情页提示（整个 AgentEditorPanel 真渲染） ----------
await check('★9 详情页顶部提示：「该会话已归档（日志仍在，内容照常可读）」只在 detail.archived===true 出现；null 不猜', () => {
  const registered = []
  mod.apply({ slots: { inject(_n, fn) { return fn() }, register(meta, comp) { registered.push({ meta, comp }); return comp } } })
  const editor = registered.find((r) => r.meta.id === 'agent-editor')
  assert.ok(editor, 'agent-editor 席位缺失')
  const sessionsReady = { status: 'ready', items: CLIENT_ROWS, error: null, archive: { known: true, archivedCount: 2 } }
  const detail = (archived) => ({ status: 'ready', meta: {}, requests: [], error: null, archived })
  const renderPanel = (archived) => {
    fakeReact.__setPreset({ AgentEditorButton: { 0: true }, AgentEditorPanel: { 2: sessionsReady, 6: detail(archived) } })
    try { return fakeReact.createElement(editor.comp, { wide: true }) } finally { fakeReact.__setPreset(null) }
  }
  const withHint = visibleText(renderPanel(true))
  assert.ok(withHint.includes('该会话已归档（日志仍在，内容照常可读）'), '归档提示没出现在详情区')
  const noHint = visibleText(renderPanel(null))
  assert.equal(noHint.includes('该会话已归档'), false, 'archived=null（未知）时不得谎称已归档')
})

// ---------- 10：合并不写源行（位只活在响应里，不回写缓存行） ----------
await check('★10 合并不写源行：缓存行对象即使被冻结也不抛、源行不 gain archived 键（位不进索引缓存的结构性证明）', async () => {
  const frozen = Object.freeze(BASE_ROWS.map((r) => Object.freeze({ ...r })))
  const src = fakeSource(frozen)
  const srv = await startServer(createHandler({ archivedProvider: () => ({ known: true, ids: ['s-archived'] }) }, src))
  try {
    const { body } = await getJson(srv.url, '/api/sessions')
    assert.equal(body.sessions.find((r) => r.id === 's-archived').archived, true, '冻结行场景下归档位丢了')
    for (const r of src.scanIndex()) assert.equal('archived' in r, false, '源缓存行被写入了 archived 键（烤进缓存）')
    assert.equal('archived' in frozen[0], false, '冻结源行被写入了 archived 键')
  } finally { await srv.close() }
})

// ===========================================================================
// 20260914 M5 单：记忆库主面板 /dsh-memory-archive/api/sessions 也认归档位
// 服务半侧走【真 apply(ctx)】+ 假 webServer 捕获 prefix handler + 真 HTTP（不是纯函数自检）；
// 客户端半侧直测 SessionRootPicker（选根下拉）。★ 展示口径与编辑器故意不同：默认不隐藏。
// ===========================================================================
const m5Home = mkdtempSync(path.join(here, '_editor-archive-m5-home-'))   // 隔离配置读（必须在 import lib/index.js 之前）
process.env.DSH_HOME = m5Home
const { apply } = await import('file://' + path.join(here, 'lib', 'index.js').replace(/\\/g, '/'))

/** 假宿主：可换的 workspaceRegistry + 假 sessionQuery；返回 /dsh-memory-archive/api 的 prefix handler。 */
function makeM5Host() {
  const captured = []
  let registry = { archivedSessionIds: ['s-arch'] }          // ★ 可换：setRegistry 改这个
  let failRegistryGet = null                                  // ★ 可换：只让 workspaceRegistry 的解析抛（service 解析路径坏）
  let listCalls = 0                                           // 数 listSessions 调用次数：证 titles 缓存真的命中
  const webServer = { register: (def) => { captured.push(def); return () => {} } }
  const sq = {
    listSessions: async () => {
      listCalls++
      return [
        { header: { id: 's-arch', createdAt: '2026-09-14T00:00:03Z', cwd: 'C:\\w\\a' } },
        { header: { id: 's-b', createdAt: '2026-09-14T00:00:02Z' } },
        { header: { id: 's-c', createdAt: '2026-09-14T00:00:01Z' } },
      ]
    },
    // allSettled 形状（session-query 真形状，见 index.js extractTitleMap 注释）
    readTitleSnapshots: async (ids) => ids.map((id) => ({
      sessionId: id, status: 'fulfilled', value: { session: {}, title: { title: 't-' + id, updatedAt: '2026-09-14T00:09:00Z' } },
    })),
  }
  const ctx = {
    get(name) {
      if (name === 'workspaceRegistry' && failRegistryGet) throw new Error(failRegistryGet)
      if (name === 'webServer') return webServer
      if (name === 'sessionQuery') return sq
      if (name === 'workspaceRegistry') return registry
      return undefined
    },
    workspaceRegistry: null,   // 故意只走 ctx.get 这条路（另一条路同函数兜底，M4 已验）
    inject(_deps, fn) { fn({ webServer }) },
    effect(fn) { return fn() },
    logger: { info() { }, warn() { }, error() { } },
  }
  apply(ctx)
  const def = captured.find((d) => d && d.path === '/dsh-memory-archive/api')
  assert.ok(def && typeof def.handler === 'function', 'apply 后没捕到 /dsh-memory-archive/api 的 prefix 注册')
  return {
    handler: def.handler,
    sq,
    setRegistry: (next) => { registry = next },
    breakRegistryGet: (msg) => { failRegistryGet = msg },
    get listCallsCount() { return listCalls },
  }
}

const m5Rows = (body) => Object.fromEntries(body.sessions.map((r) => [r.sessionId, r.archived]))

await check('★11 /api/sessions?titles=1：每行 archived ∈ {true,false}（与注册表逐 id 对上）+ 信封 archive:{known:true,archivedCount}，原字段（sessionId/title/updatedAt/cwd/origin）原样保留', async () => {
  const host = makeM5Host()
  const srv = await startServer(host.handler)
  try {
    const { status, body } = await getJson(srv.url, '/dsh-memory-archive/api/sessions?titles=1')
    assert.equal(status, 200, 'status:' + status)
    assert.equal(body.ok, true, 'ok:false')
    assert.deepEqual(body.archive, { known: true, archivedCount: 1 }, '信封不对：' + JSON.stringify(body.archive))
    assert.deepEqual(m5Rows(body), { 's-arch': true, 's-b': false, 's-c': false }, '行归档位与注册表对不上：' + JSON.stringify(m5Rows(body)))
    for (const r of body.sessions) {
      assert.ok(r.archived === true || r.archived === false, r.sessionId + ' archived 不是布尔：' + r.archived)
      assert.equal('title' in r && 'updatedAt' in r && 'cwd' in r && 'origin' in r, true, r.sessionId + ' 原字段丢了')
    }
    assert.equal(body.sessions.find((r) => r.sessionId === 's-arch').title, 't-s-arch', 'title 投影丢了')
  } finally { await srv.close() }
})

await check('★★12 反证C（titlesCache 不烤位）绿：同一 handler、同一 titles 缓存窗口内换注册表 ⇒ 第二次 archived/archivedCount 跟变；且第二次 listSessions 没再跑（确证位不是重投影算出来的）', async () => {
  const host = makeM5Host()
  const srv = await startServer(host.handler)
  try {
    const b1 = (await getJson(srv.url, '/dsh-memory-archive/api/sessions?titles=1')).body
    assert.deepEqual(m5Rows(b1), { 's-arch': true, 's-b': false, 's-c': false }, '第一次位就不对')
    host.setRegistry({ archivedSessionIds: ['s-arch', 's-b'] })     // ★ 同一 TTL 窗口内改掉归档来源
    const b2 = (await getJson(srv.url, '/dsh-memory-archive/api/sessions?titles=1')).body
    assert.equal(host.listCallsCount, 1, '第二次竟重跑了 listSessions？没走到 titles 缓存，证据失效')
    assert.equal(b2.sessions.find((r) => r.sessionId === 's-b').archived, true, 's-b 必须跟变 true（位被烤进 titles 缓存了？）')
    assert.equal(b2.sessions.find((r) => r.sessionId === 's-c').archived, false, 's-c 不该被牵连')
    assert.deepEqual(b2.archive, { known: true, archivedCount: 2 }, '信封 archivedCount 没跟变：' + JSON.stringify(b2.archive))
    assert.equal(b2.sessions.find((r) => r.sessionId === 's-b').title, 't-s-b', '缓存命中行连 title 都丢了？')
  } finally { await srv.close() }
})
await check('★★12 反证C 红：把位烤进 titles 投影的坏变体跑同一条跟变断言必须抛 —— 证明断言不是橡皮图章', async () => {
  // 坏变体：位在第一次投影时被一次性烤死（正是任务书点名的写法）
  let ids = ['s-arch']
  let baked = null
  const bakeList = async () => {
    if (!baked) baked = ['s-arch', 's-b', 's-c'].map((id) => ({ ok: true, row: { sessionId: id, archived: ids.includes(id) } }))
    return baked
  }
  const swapFollows = async () => {
    const first = await bakeList()
    assert.equal(first.find((r) => r.row.sessionId === 's-b').row.archived, false, '第一次：b 应为 false')
    ids = ['s-arch', 's-b']
    const second = await bakeList()
    assert.equal(second.find((r) => r.row.sessionId === 's-b').row.archived, true, '第二次：b 必须跟变 true（位没被烤进缓存）')
  }
  await assert.rejects(() => swapFollows(), /必须跟变/, '烤进缓存的坏实现竟通过了跟变断言')
})

await check('★★13 反证B（未知 ≠ 未归档）绿：注册表 getter 抛错 / ids 非数组 / ctx.get 全抛 ⇒ 全行 archived===null、known:false、archivedCount:0；titles=0 快路径同样带位', async () => {
  const variants = {
    'registry getter 抛错': (host) => host.setRegistry({ get archivedSessionIds() { throw new Error('registry mid-reload') } }),
    'ids 非数组': (host) => host.setRegistry({ archivedSessionIds: 'nope' }),
    'registry 缺键': (host) => host.setRegistry({}),
    'ctx.get(registry) 抛错': (host) => host.breakRegistryGet('service lookup exploded'),
  }
  for (const [label, setup] of Object.entries(variants)) {
    const host = makeM5Host()
    setup(host)
    const srv = await startServer(host.handler)
    try {
      const { body } = await getJson(srv.url, '/dsh-memory-archive/api/sessions?titles=1')
      assert.deepEqual(body.archive, { known: false, archivedCount: 0 }, '[' + label + '] 信封不对：' + JSON.stringify(body.archive))
      for (const r of body.sessions) assert.equal(r.archived, null, '[' + label + '] ' + r.sessionId + ' 应为 null（未知），实际 ' + r.archived)
      const fast = (await getJson(srv.url, '/dsh-memory-archive/api/sessions')).body   // titles=0 快路径
      assert.deepEqual(fast.archive, { known: false, archivedCount: 0 }, '[' + label + '] 快路径信封不对')
      for (const r of fast.sessions) assert.equal(r.archived, null, '[' + label + '] 快路径 ' + r.sessionId + ' 应为 null')
    } finally { await srv.close() }
  }
  const host = makeM5Host()
  const srv = await startServer(host.handler)
  try {
    const fast = (await getJson(srv.url, '/dsh-memory-archive/api/sessions')).body   // 已知注册表 + 快路径：同样逐 id 带位
    assert.deepEqual(m5Rows(fast), { 's-arch': true, 's-b': false, 's-c': false }, 'titles=0 快路径归档位不对：' + JSON.stringify(m5Rows(fast)))
    assert.deepEqual(fast.archive, { known: true, archivedCount: 1 }, '快路径信封不对：' + JSON.stringify(fast.archive))
  } finally { await srv.close() }
})
await check('★★13 反证B 红：把未知折成「未归档」（null→false）的坏变体跑同一条 null 断言必须抛', () => {
  const foldUnknownToFalse = (bits) => bits.map((b) => (b === null ? false : b))   // 坏变体
  const bits = foldUnknownToFalse([null, null])
  assert.throws(() => { for (const b of bits) assert.equal(b, null, 'archived 应为 null（未知）') }, /应为 null/, 'null→false 折叠竟通过了未知断言')
})

// ---------- 14：客户端 SessionRootPicker（选根下拉：默认不隐藏 + 徽标；与编辑器故意不同） ----------
const PICKER_ROWS = [
  { sessionId: 'r-arch', title: '已归档甲', updatedAt: 3, archived: true },
  { sessionId: 'r-b', title: '普通乙', updatedAt: 2, archived: false },
  { sessionId: 'r-c', title: null, updatedAt: 1, archived: false },
]
function renderPicker(items, archiveKnown, config) {
  assert.ok(typeof SessionRootPicker === 'function', '缺 exports.__editorArchive.SessionRootPicker（旧代码没有 M5 出口）')
  fakeReact.__setPreset({ SessionRootPicker: [{ status: 'ready', items, archiveKnown, error: null }, { busy: false, error: null }] })
  try {
    return fakeReact.createElement(SessionRootPicker, { config: config || null, reload: () => { }, nameIdx: NAME_IDX, onPick: () => { } })
  } finally { fakeReact.__setPreset(null) }
}
const pickerOptions = (tree) => collectNodes(tree, (n) => n.$$element === 'option' && n.props && n.props.value, [])
  .filter((n) => n.props.value !== '')   // 去掉占位项

await check('★14 选根下拉默认不隐藏：1 归档 + 2 普通 ⇒ 3 个 option 全在（⛔ 不是 2）；归档行【已归档】徽标 + 置灰 + title 写明口径；普通行不受牵连', () => {
  const tree = renderPicker(PICKER_ROWS, true)
  const opts = pickerOptions(tree)
  assert.deepEqual(opts.map((n) => n.props.value), ['r-arch', 'r-b', 'r-c'], '选根列表必须原序全显（归档会话照样能当根）：' + opts.map((n) => n.props.value).join(','))
  const arch = opts.find((n) => n.props.value === 'r-arch')
  assert.equal(arch.props['data-arch'], '1', '归档行没打 data-arch 标')
  assert.ok(collectText(arch, []).join('').startsWith('【已归档】'), '归档行缺【已归档】徽标：' + collectText(arch, []).join(''))
  assert.equal(arch.props.style && arch.props.style.color, '#999999', '归档行没置灰')
  assert.ok(String(arch.props.title).includes('archivedSessionIds') && String(arch.props.title).includes('日志仍在、内容照常可读'), '归档行 title 没写明口径：' + arch.props.title)
  assert.ok(String(arch.props.title).includes('r-arch'), '归档行 title 丢了完整 id')
  for (const n of opts.filter((x) => x.props.value !== 'r-arch')) {
    assert.equal(n.props['data-arch'], '0', n.props.value + ' 普通行被误标')
    assert.equal(collectText(n, []).join('').includes('【已归档】'), false, n.props.value + ' 普通行被误打徽标')
  }
  assert.equal(visibleText(tree).includes('归档状态不可用'), false, 'known:true 时不应出现「不可用」小字')
})
await check('★★14 反证B（客户端）：known:false ⇒ 一行都不标（3 个 option 全在但无徽标无置灰）+「归档状态不可用（已按普通会话显示）」小字；信封缺失（archiveKnown:false）同口径', () => {
  const unknown = PICKER_ROWS.map((r) => ({ ...r, archived: r.archived === true ? null : r.archived }))
  const t1 = renderPicker(unknown, false)
  const opts1 = pickerOptions(t1)
  assert.equal(opts1.length, 3, '未知时一条都不许隐藏')
  for (const n of opts1) {
    assert.equal(n.props['data-arch'], '0', n.props.value + ' 未知时被标了')
    assert.equal(collectText(n, []).join('').includes('【已归档】'), false, n.props.value + ' 未知时被打了徽标')
  }
  assert.ok(visibleText(t1).includes('归档状态不可用（已按普通会话显示）'), '缺「归档状态不可用」小字')
  const t2 = renderPicker(unknown, false)   // 信封缺失在客户端同样折进 archiveKnown:false
  assert.ok(visibleText(t2).includes('归档状态不可用（已按普通会话显示）'), '信封缺失同口径')
})
await check('★★14 反证 红：「默认隐藏归档行」的坏变体跑同一条 3/3 全显断言必须抛 —— 钉死「不许加默认过滤」', () => {
  const hideArchivedByDefault = (rows) => rows.filter((r) => r.archived !== true)   // 坏变体：编辑器口径误搬到选根列表
  assert.throws(() => {
    assert.equal(hideArchivedByDefault(PICKER_ROWS).length, PICKER_ROWS.length, '选根列表不许默认隐藏归档行（归档会话照样能当根）')
  }, /不许默认隐藏/, '默认隐藏的坏变体竟通过了全显断言')
})

// ===========================================================================
// 20260914 M6 单：/config 根回显 + 面板头部「当前根已归档」提示
// ===========================================================================
async function putJson(base, p, body) {
  const res = await fetch(base + p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}

await check('★15 /config 根回显：未配置 ⇒ root===null（反证B 服务半侧，⛔ 不编空串/对象占位）；PUT root 后 GET 原样回显；清空（空串归一成 null）⇒ root 回 null', async () => {
  const host = makeM5Host()
  const srv = await startServer(host.handler)
  try {
    const c0 = (await getJson(srv.url, '/dsh-memory-archive/api/config')).body
    assert.equal('root' in c0, true, '投影里连 root 键都没有（M6 前 API 少一个字段）')
    assert.equal(c0.root, null, '未配置必须回 null：' + JSON.stringify(c0.root))
    const put = await putJson(srv.url, '/dsh-memory-archive/api/config', { root: { sessionId: 's-arch', characterId: null, playthroughId: null } })
    assert.equal(put.body.ok, true, 'PUT root 失败：' + JSON.stringify(put.body))
    const c1 = (await getJson(srv.url, '/dsh-memory-archive/api/config')).body
    assert.deepEqual(c1.root, { sessionId: 's-arch', characterId: null, playthroughId: null }, '回显不是原样：' + JSON.stringify(c1.root))
    await putJson(srv.url, '/dsh-memory-archive/api/config', { root: { sessionId: '', characterId: null, playthroughId: null } })
    const c2 = (await getJson(srv.url, '/dsh-memory-archive/api/config')).body
    assert.equal(c2.root, null, '清空后必须回 null：' + JSON.stringify(c2.root))
  } finally { await srv.close() }
})

await check('★16 保存后不回弹（客户端半侧）：config.root 回显 ⇒ select 停在已存根（value=根 id，不落占位项）；root=null ⇒ 回落占位项（value=\'\'）', () => {
  const withRoot = renderPicker(PICKER_ROWS, true, { rootMode: 'session', root: { sessionId: 'r-b', characterId: null, playthroughId: null } })
  const sel1 = collectNodes(withRoot, (n) => n.$$element === 'select', [])[0]
  assert.ok(sel1, '没渲染出 select')
  assert.equal(sel1.props.value, 'r-b', '保存后下拉必须停在已存的根（回弹 = /config 没回 root）：' + JSON.stringify(sel1.props.value))
  const noRoot = renderPicker(PICKER_ROWS, true, null)
  const sel2 = collectNodes(noRoot, (n) => n.$$element === 'select', [])[0]
  assert.equal(sel2.props.value, '', 'root=null 必须回落「选择一条会话」占位项（不许 undefined/别的）')
})

await check('★17 rootArchiveHint 文案（只提示口径）：会话根+已知+已归档 ⇒ 一句话；未知/未归档/工作区根 ⇒ null（反证A 文案半侧）', () => {
  assert.equal(typeof rootArchiveHint, 'function', '缺 exports.__editorArchive.rootArchiveHint（旧代码没有 M6 出口）')
  assert.equal(rootArchiveHint({ mode: 'session', known: true, archived: true }), '该根会话已归档（日志仍在、内容照常可读）', '正向文案不对')
  assert.equal(rootArchiveHint({ mode: 'session', known: false, archived: true }), null, '未知（known:false）一条提示都不许有')
  assert.equal(rootArchiveHint({ mode: 'session', known: true, archived: false }), null, '未归档不许提示')
  assert.equal(rootArchiveHint({ mode: 'workspace', known: true, archived: true }), null, '工作区根不在本提示范围')
  assert.equal(rootArchiveHint(null), null, '状态缺席必须安全')
})
await check('★17 反证 红：不看 known、只看 archived 的坏文案函数跑同一条 null 断言必须抛 —— 证明断言不是橡皮图章', () => {
  const broken = (s) => (s && s.mode === 'session' && s.archived === true) ? '该根会话已归档（日志仍在、内容照常可读）' : null   // 坏变体：漏看 known
  assert.throws(() => {
    assert.equal(broken({ mode: 'session', known: false, archived: true }), null, '未知（known:false）时一条提示都不许有')
  }, /不许有/, '漏看 known 的坏实现竟通过了未知断言')
})

console.log('== 汇总：' + pass + ' 通过 / ' + fails.length + ' 失败 ==')
try { rmSync(m5Home, { recursive: true, force: true }) } catch { }   // 清掉临时 DSH_HOME，不污染 git status
if (fails.length > 0) {
  console.log('失败项：\n  - ' + fails.join('\n  - '))
  process.exit(1)
}
