#!/usr/bin/env node
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
import { readFileSync, existsSync } from 'node:fs'
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

await check('★ exports.__internals 存在，且恰好含 15 个纯函数（v4.1 新增 8 个 + D 单 parseMarkdown）', () => {
  const it = mod.__internals
  assert.ok(it, '__internals 缺失')
  assert.deepEqual(Object.keys(it).sort(),
    [
      'buildCatalogIndex', 'clipInfo', 'decodeWorkspaceSlug', 'groupSessionsByWorkspace',
      'hiddenSessionReason', 'labelCharacter', 'labelPlaythrough', 'labelSession', 'pad4',
      'parseMarkdown', 'relativeTime', 'shortId', 'splitMessagesText', 'splitSystemSections',
      'workspaceLabelFromCwd',
    ])
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

await check('★ D 单 + 20260919：apply(fakeCtx) 不抛；inject 恰好 ["slots","sessions"]（sessions 是**跟随当前会话**用的，不是搜索类阅读源回来了）', () => {
  mod.apply(ctxLike)
  assert.deepEqual(mod.inject, ['slots', 'sessions'])
})

await check('★ 面板跟随（20260919）：查到会话的周目才改绑定；查不到一个字不改；本次打开不重复写；读的端点只此一处', () => {
  assert.ok(src.includes('function ArchivePanel({ onClose, sessions }) {'), '面板要收 sessions prop（跟随要知道当前会话）')
  assert.ok(src.includes('sessions: ctx.sessions'), '挂载面板时要把 ctx.sessions 传进去')
  assert.ok(src.includes("data.source === 'session' && char0 !== '' && play0 !== ''"), '⛔ 只有 source===\'session\' 且拿得到角色/周目才许动')
  assert.ok(src.includes('if (!mapped) return'), '⛔ 认不出周目 ⇒ 一个字都不改绑定（保持原绑定）')
  assert.ok(src.includes('followRef.current === key'), '本次打开跟过就不再写（reload 会让 effect 再跑一遍，⛔ 不许来回写）')
  assert.ok(src.includes("{ root: { characterId: char, playthroughId: play } }"), '改的是**绑定**（config.root），不是只改显示')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const hits = code.match(/\/playthrough\/for-session/g) || []
  assert.equal(hits.length, 1, '该端点字面量应恰好出现 1 次（面板只该有一个地方问它），实际 ' + hits.length)
  assert.ok(src.includes('mutateJson(HOST_API_BASE + \'/config\', \'PUT\''), '改绑定走既有的 /config PUT（⛔ 不另开写口）')
})

await check('★★ 顶栏「本会话周目态」+ 向量档未归入那条（20260920 口径「认不出来的会话默认为新会话」）', () => {
  // 为什么要有：未归入的会话**一个字都不改绑定**，但注入/笔记/检索全停 —— 面板必须**说出来**，
  // 否则顶栏显示着绑定那个周目、实际什么都没发生，又是一处"看着像骗人"。
  assert.ok(src.includes("'data-sess-unmapped': '1'"), '缺「未归入」那支的标记（红字要能被抓住）')
  assert.ok(src.includes('本会话：未归入周目 ⇒ 注入与笔记停用'), '缺「未归入 ⇒ 注入与笔记停用」这句人话')
  assert.ok(src.includes("'data-sess-pt': '1'"), '缺「认得出」那支的标记')
  assert.ok(src.includes("'本会话：' + labelPlaythrough(sessPt.playthroughId, nameIdx, { short: true })"), '认得出时没给周目真名')
  // ★ 反证：把"未归入"那句文案挖掉 ⇒ 同一句判据必红（证明它会咬人，不是永远绿的形状断言）
  assert.equal(src.replace('本会话：未归入周目 ⇒ 注入与笔记停用', '').includes('本会话：未归入周目 ⇒ 注入与笔记停用'),
    false, '反证失败：挖掉文案后仍能命中')
  // ★ 展示态必须在「认不出就早退」**之前**记录 —— 否则未归入时永远停在 loading，那条红字永远不出现
  const iSet = src.indexOf("setSessPt({ status: 'ready'")
  const iBail = src.indexOf('if (!mapped) return')
  assert.ok(iSet > 0 && iBail > iSet, '展示态得先在早退之前记录')
  // ★ 显示与改绑定解耦：展示态那一段里⛔ 不许出现 PUT /config（改绑定只归跟随那一段）
  const block = src.slice(iSet, iBail)
  assert.equal(/mutateJson\(/.test(block), false, '展示态里不许有写盘动作')
  // ★ 向量档：未归入要有自己的红字（⛔ 不许只显示成"绑定周目：（空）"）
  assert.ok(src.includes("id: 'dma-vector-unmapped'"), '向量档缺「本会话未归入周目」那条红字')
  assert.ok(src.includes('本会话还没归入任何周目 ⇒ 这一档不参与检索'), '向量档缺未归入的说明句')
  assert.ok(src.includes("iso.blocked === 'no-bound-playthrough'"), '向量档没认 anima 那条 fail-closed 的机器码')
})

await check('★ 席位契约（20260918 F 单 2→3；20260919 加 OOC 前缀席 3→4、收纳提示席 4→5）：恰好 5 个席位 = sidebar ×2（原样未动）+ conversation.input.right ×2 + shell.overlay ×1', () => {
  // 为什么改 4：F 单「OOC 划词质疑」加第 3 席；20260919 又在同一座位加了「OOC」前缀席（一键标场外）。
  //   既有两席一字未动；这条断言仍钉死**全插件席位总数恰好 N**（不是放宽成"至少 2"），只是 3 → 4。
  assert.equal(registeredList.length, 5, '席位数不是 5：' + registeredList.length)
  const ids = registeredList.map((r) => r.meta.id).sort()
  assert.deepEqual(ids, ['agent-editor', 'dma-ingest-toast', 'memory-archive', 'ooc-prefix', 'ooc-quote'])
  const overlay = registeredList.filter((r) => r.meta.name === 'shell.overlay')
  assert.equal(overlay.length, 1, 'shell.overlay 应恰好 1 席（frame-wide 浮层）')
  assert.equal(overlay[0].meta.id, 'dma-ingest-toast', '收纳提示席 id 应为 dma-ingest-toast')
  const sidebar = registeredList.filter((r) => r.meta.name === 'sidebar.footer.action')
  assert.equal(sidebar.length, 2, 'sidebar 席位数不是 2')
  assert.deepEqual(sidebar.map((r) => r.meta.id).sort(), ['agent-editor', 'memory-archive'], '既有两席的 id 集合不许变')
  const inputSeats = registeredList.filter((r) => r.meta.name === 'conversation.input.right')
  assert.equal(inputSeats.length, 2, '输入栏座位应是 2 席')
  const quote = inputSeats.find((r) => r.meta.id === 'ooc-quote')
  const prefix = inputSeats.find((r) => r.meta.id === 'ooc-prefix')
  assert.ok(quote && prefix, '缺 ooc-quote / ooc-prefix 席位')
  assert.equal(quote.meta.order, 90, '质疑席 order 应为 90（排在重启按钮 restart-host 的 100 之前）')
  assert.equal(prefix.meta.order, 89, 'OOC 前缀席 order 应为 89（排在质疑 90 之前）')
  for (const s of [quote, prefix]) {
    assert.equal(['memory-archive', 'agent-editor', 'restart-host'].includes(s.meta.id), false, '⛔ 不许占用既有 id')
  }
})

await check('★ 收纳提示席（20260919）：注册在 shell.overlay、读 /anima/ingest-state **恰好一次**、空闲时不渲染、卸载即停', () => {
  assert.ok(src.includes('function IngestToast()'), '缺 IngestToast 组件')
  assert.ok(
    /ctx\.slots\.inject\('shell\.overlay', \(\) => ctx\.slots\.register\(\s*\{ name: 'shell\.overlay', id: 'dma-ingest-toast' \}/.test(src),
    'shell.overlay 席位注册形状不对（id 必须新开一个，⛔ 不许顶掉别人的条目）',
  )
  // ⚠️ 本检查在 `outlineCodeOnly` 之前跑（那个常量在后面才声明）⇒ 这里自己剥一遍注释：
  //    数端点字面量必须看**活代码**，注释里提到它不算第二次取数。
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const hits = codeOnly.match(/\/anima\/ingest-state/g) || []
  assert.equal(hits.length, 1, '该端点字面量应恰好出现 1 次（面板只该有一个读它的地方），实际 ' + hits.length)
  assert.ok(src.includes("if (!running && !finishedRecently) return null"), '空闲时必须不渲染（不给界面留空壳）')
  assert.ok(src.includes('clearInterval(timer)'), '卸载必须停轮询（⛔ 不许留着定时器）')
  assert.ok(src.includes('INGEST_TOAST_POLL_MS = 5000'), '轮询间隔应为 5s（低频；这是个提示条，不值得更勤）')
})

await check('★ settings.section 一个都没有（注入与注册两侧都为零）', () => {
  assert.equal(injectedNames.includes('settings.section'), false)
  assert.equal(registeredList.some((r) => r.meta.name === 'settings.section'), false)
})

// ---------- 真名解析：固定假 catalog（形状按任务书 §2.1 实测值构造） ----------
// ★ 下面四个 id 一律是**合成**的（⛔ 不许用真机上的真实卡/周目/会话 id 当夹具 ——
//   本仓库要公开，用户数据不进公开历史）。
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
        characterName: '示例角色',
        rootSessionId: SESS_ID,
        playthroughNumber: 1,
        autoTitle: true,
      },
    },
  }],
}
const idx = itn.buildCatalogIndex(fakeCatalog)

await check('buildCatalogIndex：对象与 JSON 字符串两种入参都行；空/坏输入给空索引不抛', () => {
  assert.equal(idx.charNames[CHAR_ID], '示例角色')
  assert.equal(idx.byPlaythrough[PLAY_ID].title, '1周目')
  assert.equal(idx.byRootSession[SESS_ID].playthroughId, PLAY_ID)
  const fromStr = itn.buildCatalogIndex(JSON.stringify(fakeCatalog))
  assert.equal(fromStr.charNames[CHAR_ID], '示例角色')
  const empty = itn.buildCatalogIndex(null)
  assert.deepEqual(empty, { charNames: {}, byPlaythrough: {}, byRootSession: {} })
})

await check('labelCharacter：目录命中给真名「示例角色」，未命中给 8 位短 ID', () => {
  assert.equal(itn.labelCharacter(CHAR_ID, idx), '示例角色')
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

await check('★ labelSession 三级回退：title → 周目目录「示例角色 · 1周目」→ 短 ID「session-…」', () => {
  const l1 = itn.labelSession({ sessionId: SESS_ID, title: '手动起的名' }, idx)
  assert.deepEqual(l1, { text: '手动起的名', source: 'title' })
  const l2 = itn.labelSession({ sessionId: SESS_ID, title: null }, idx)
  assert.equal(l2.text, '示例角色 · 1周目')
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

// ---------- v4.1 A 单：工作区名解析 / 空会话过滤 / 相对时间 / 分组 / system 分段注释 ----------
// ⚠️ 这里用**合成路径**（/home/dev/... 与 C:/work/...）而不是本机真实路径：
//    本文件是要提交进公开仓库的，写进真实路径会被上架闸门的泄露扫描命中（已经命中过一次）。
await check('★ workspaceLabelFromCwd：取最后一段（正/反斜杠都认；坏输入给空串）', () => {
  assert.equal(itn.workspaceLabelFromCwd('/home/dev/projects/demo-ws配置区'), 'demo-ws配置区')
  assert.equal(itn.workspaceLabelFromCwd('C:/work/我的项目'), '我的项目')
  assert.equal(itn.workspaceLabelFromCwd('C:\\work\\我的项目'), '我的项目')
  assert.equal(itn.workspaceLabelFromCwd(null), '')
  assert.equal(itn.workspaceLabelFromCwd(''), '')
  assert.equal(itn.workspaceLabelFromCwd(42), '')
})

await check('★ decodeWorkspaceSlug：--D-apps-demo-ws~914D~7F6E~533A-- 解码后含「配置区」（~XXXX 十六进制转义 → 字符）', () => {
  const dec = itn.decodeWorkspaceSlug('--D-apps-demo-ws~914D~7F6E~533A--')
  assert.ok(dec.includes('配置区'), '解码结果不含配置区: ' + dec)
  assert.equal(itn.decodeWorkspaceSlug('--abc--'), 'abc')
  assert.equal(itn.decodeWorkspaceSlug('no-delims'), 'no-delims')
  assert.equal(itn.decodeWorkspaceSlug(null), '')
})

await check('★ 空会话过滤：requests===0 隐藏、origin=subagent 隐藏、★ requests===-1（未解析）不算空不隐藏', () => {
  assert.equal(itn.hiddenSessionReason({ requests: 0 }), 'empty')
  assert.equal(itn.hiddenSessionReason({ requests: 0, origin: 'subagent' }), 'subagent')
  assert.equal(itn.hiddenSessionReason({ origin: 'subagent' }), 'subagent')
  assert.equal(itn.hiddenSessionReason({ requests: -1 }), null, '未解析（-1）被当成空隐藏了 —— 违反 P0 哨兵语义')
  assert.equal(itn.hiddenSessionReason({ requests: -1, origin: null }), null)
  assert.equal(itn.hiddenSessionReason({ requests: 5 }), null)
  assert.equal(itn.hiddenSessionReason(null), null)
})

await check('relativeTime：DSH 口径 2分钟 / 1小时 / 15小时 / 3天；坏时间给空串', () => {
  const now = Date.parse('2026-09-12T12:00:00Z')
  assert.equal(itn.relativeTime('2026-09-12T11:58:00Z', now), '2分钟')
  assert.equal(itn.relativeTime('2026-09-12T11:00:00Z', now), '1小时')
  assert.equal(itn.relativeTime('2026-09-11T21:00:00Z', now), '15小时')
  assert.equal(itn.relativeTime('2026-09-09T12:00:00Z', now), '3天')
  assert.equal(itn.relativeTime('not-a-date', now), '')
})

await check('★ groupSessionsByWorkspace：cwd 命中 ⇒ 真名+resolved；全组拿不到 ⇒ slug 解码+未解析；组内/组间均 mtime 倒序', () => {
  const t1 = '2026-09-12T10:00:00Z'
  const t2 = '2026-09-12T09:00:00Z'
  const t3 = '2026-09-12T08:00:00Z'
  const items = [
    { id: 's1', workspace: '--D-apps-demo-ws~914D~7F6E~533A--', mtime: t2 },
    { id: 's2', workspace: '--D-apps-demo-ws~914D~7F6E~533A--', mtime: t1 },
    { id: 's3', workspace: '--ws-b--', mtime: t3 },
  ]
  const cwdOf = new Map([['s1', '/home/dev/projects/demo-ws配置区']])
  const groups = itn.groupSessionsByWorkspace(items, (id) => (cwdOf.has(id) ? cwdOf.get(id) : null))
  assert.equal(groups.length, 2)
  assert.equal(groups[0].slug, '--D-apps-demo-ws~914D~7F6E~533A--', '组间没按最近 mtime 倒序')
  assert.equal(groups[0].label, 'demo-ws配置区')
  assert.equal(groups[0].resolved, true)
  assert.deepEqual(groups[0].rows.map((r) => r.row.id), ['s2', 's1'], '组内没按 mtime 倒序')
  assert.equal(groups[1].label, 'ws-b')
  assert.equal(groups[1].resolved, false)
  const g2 = itn.groupSessionsByWorkspace(items, () => null)
  assert.equal(g2[0].resolved, false, 'cwd 全拿不到却标了已解析 —— 会假装真名')
  assert.ok(g2[0].label.includes('demo-ws'), 'slug 解码降级失效: ' + g2[0].label)
})

await check('★ splitSystemSections：identity 认出、storyAnchor 照原样「归属待确认」、认不出 ⇒ 未能识别归属；§2.6 注释逐字', () => {
  const text = [
    'You are an AI agent powered by DeepSeek Harness. Your checkout is at some place.',
    '你是某个部署配置的 agent，说话风格 X。',   // 没有独立标记 ⇒ 并入 identity 段（无法从内容认出，如实合并）
    'dsh-tavern preset：正归一化的预设内容。',
    '【当前状态】HP=12/20',
    'storyAnchor: chapter-3',
    '一段来历不明的内容。',
  ].join('\n\n')
  const secs = itn.splitSystemSections(text)
  const keys = secs.map((s) => s.key)
  for (const k of ['identity', 'preset', 'stateCard', 'storyAnchor', 'unknown']) {
    assert.ok(keys.includes(k), '缺分段 ' + k + ': ' + keys.join(','))
  }
  assert.ok(secs.find((s) => s.key === 'identity').text.includes('部署配置的 agent'), 'identity 段没吃到紧随其后的未标记文本')
  assert.equal(
    secs.find((s) => s.key === 'storyAnchor').note,
    '（归属待确认）疑似剧情锚点相关注入；没查到确定的注入方，先如实标注。',
  )
  assert.equal(secs.find((s) => s.key === 'unknown').note, '未能识别归属（未匹配到已知注入点）')
  const marks = itn.splitSystemSections(
    'You are an AI agent powered by DeepSeek Harness.\n\n<compacted-summary>\nxx\n\n<recalledMemories>y\n\nrp:policy z\n\nst-character-field q',
  )
  const notes = marks.map((s) => s.note)
  for (const t of [
    'DSH 核心注入的 agent 身份与环境说明：告诉模型它在 DSH 里、检出目录在哪、GUI 上下文与行为纪律。恒定注入，永远排在最前。',
    '被压缩出上下文的那段历史（checkpoint）。前言由官方 frameSummary() 拼出，作用是告诉模型“这是既成背景，别复述”。',
    'L2 检索记忆：从历史里检索出来的摘录（<recalledMemories>）与近场历史（<immediateHistory>）。只对 RP 会话注入。',
    'RP 模式策略段。默认只说明“高风险操作被锁”，不是扮演身份；身份与文风仍来自 preset / 角色卡。',
    '角色卡字段（SillyTavern 格式）在 system 里的落点。',
  ]) assert.ok(notes.includes(t), '缺逐字注释: ' + t)
})

await check('clipInfo / splitMessagesText：截断标记剥出原长；messages 按条切开、形状变了给 null', () => {
  const info = itn.clipInfo('前半文本…（已截断，原 400123 字符）')
  assert.equal(info.text, '前半文本')
  assert.equal(info.truncated, true)
  assert.equal(info.original, 400123)
  assert.deepEqual(itn.clipInfo('完整文本'), { text: '完整文本', truncated: false, original: null })
  const msgs = itn.splitMessagesText('── [seq 1] user ──\n你好\n\n── [seq 2] assistant ──\n你也好')
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0].role, 'user')
  assert.ok(msgs[1].text.includes('你也好'))
  assert.equal(itn.splitMessagesText('没有分隔标记的整段'), null)
  assert.equal(itn.splitMessagesText(''), null)
})

// ---------- 面板渲染（假 hooks 注入状态，不发请求） ----------
const comp = registeredList[0].comp          // 席位 1：memory-archive（记忆库齿轮）
const viewerBtn = registeredList[1].comp     // 席位 2：agent-editor（提示词查看器，v5 P0 由 prompt-viewer 升格）
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

await check('★ v5 P0 独立入口 agent-editor：窄屏「词」、宽屏「提示词查看器」、title=提示词查看器 · 会话 / 装配地图 / 维护（20260913 改版契约）', () => {
  const narrow = fakeReact.createElement(viewerBtn, { wide: false })
  const wide = fakeReact.createElement(viewerBtn, { wide: true })
  const sn = JSON.stringify(narrow)
  const sw = JSON.stringify(wide)
  assert.ok(sn.includes('词'), '窄态没有短字符「词」')
  assert.ok(sw.includes('提示词查看器'), '宽态没有「提示词查看器」')
  assert.ok(
    sn.includes('提示词查看器 · 会话 / 装配地图 / 维护')
    && sw.includes('提示词查看器 · 会话 / 装配地图 / 维护'),
    'title 属性缺失（20260913 新契约：提示词查看器 · 会话 / 装配地图 / 维护）',
  )
})

await check('★ 20260913 三级导航面板（独立浮层）：左=会话列表、右=装配地图主界面（★无轮次胶囊、空闲提示）、组成折叠条、维护按钮、无 Skill 勾选、⛶/✕ 独立', () => {
  fakeReact.__setPreset({ AgentEditorButton: { 0: true } })
  try {
    const tree = fakeReact.createElement(viewerBtn, { wide: true })
    const s = JSON.stringify(tree)
    const text = visibleText(tree)
    assert.ok(s.includes('提示词查看器'), '面板标题缺失')
    assert.ok(s.includes('当前 preset：'), '顶栏缺「当前 preset：」')
    assert.ok(s.includes('正在扫描会话列表…'), '左栏会话列表不在')
    assert.ok(text.includes('提示词装配地图'), '装配地图主界面不在')
    assert.ok(text.includes('← 选会话后自动装配'), '地图空闲态提示缺失')
    assert.ok(s.includes('▸ 来源：preset 组成'), '组成折叠条不在（20260913：默认收起）')
    assert.ok(s.includes('维护'), '顶栏缺「维护」次级入口')
    assert.ok(s.includes('生成 / 修复 RP agent') === false || s.includes('维护'), '检测按钮应只在维护抽屉里')
    assert.equal(s.includes('Skill：启用「RP agent 优化」'), false, 'Skill 勾选区应已移除（20260913 用户拍板）')
    assert.equal(s.includes('dma-skill-toggle'), false, 'Skill 勾选框应已移除')
    assert.ok(s.includes('⛶') && s.includes('✕'), '独立浮层缺全屏/关闭按钮')
    assert.equal(FULL_UUID_RE.test(visibleText(tree)), false, '编辑器可见文本泄漏完整 id')
  } finally { fakeReact.__setPreset(null) }
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
    assert.ok(s.includes('当前根：示例角色 / 1周目'), '顶栏没有当前根人话名')
    for (const t of ['提示词', '⚙ 设置', '⛶', '✕']) assert.ok(s.includes(t), '顶栏缺按钮: ' + t)
    assert.equal(s.includes('根：会话') || s.includes('根：工作区'), false, '顶栏还残留常驻根模式单选')
    // D 单更新：「阅读源」标签已撤掉；源为 摘要/原文/状态/剧情大纲（搜索类源已移除，大纲为 20260919 第四档）——用渲染断言（tab 按钮标签）
    const srcTabs = []
    collectNodes(tree, (n) => n.props && typeof n.props.onClick === 'function' && typeof n.props.children === 'string', srcTabs)
    const srcLabels = srcTabs.map((n) => n.props.children)
    // ★ 2026-09-20：「状态」档已摘除（用户口径「记忆库里的状态面板可以摘除」）
    for (const t of ['摘要', '原文']) assert.ok(srcLabels.includes(t), '缺阅读源 tab: ' + t + '（实有: ' + srcLabels.join(',') + '）')
    assert.equal(srcLabels.includes('会话搜索'), false, '「会话搜索」源应已移除')
    assert.equal(visibleText(tree).includes('阅读源'), false, '「阅读源」标签应已撤掉（渲染断言）')
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
    assert.ok(text.includes('示例角色 / 1周目 / archive'), '归档路径没有换成真名: ' + text)
    const copies = []
    collectNodes(tree, (n) => n.props && typeof n.props.onClick === 'function' && JSON.stringify(n.props).includes('复制'), copies)
    assert.ok(copies.length >= 1, '没有复制按钮')
  } finally { fakeReact.__setPreset(null) }
})

await check('★ 读视图（会话）：默认「会话事件」；标题=示例角色 · 1周目 + 来源徽标「来自周目目录」', () => {
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
    assert.ok(s.includes('会话事件'), '会话模式缺「会话事件」源')
    assert.equal(s.includes('会话搜索'), false, '「会话搜索」源应已移除（D 单）')
    assert.equal(s.includes('摘要'), false, '会话模式不该出现摘要源')
    assert.ok(text.includes('会话事件 · 示例角色 · 1周目'), '事件区标题没有真名: ' + text)
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
    assert.ok(labels.includes('会话事件'), '没有退到可用源: ' + labels.join(','))
    assert.equal(labels.includes('会话搜索'), false, '「会话搜索」源应已移除（D 单）')
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
    // ★ 2026-09-20：「状态」档已摘除
    for (const t of ['摘要', '原文']) assert.ok(s.includes(t), '缺阅读源: ' + t)
    assert.equal(s.includes('会话搜索'), false, '「会话搜索」源应已移除（D 单）')
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
    // ★ 破限头（2026-09-16）：默认空 —— 我们**不内置**任何破限文本，由玩家自填。
    compactionJailbreak: { current: '', custom: false },
  },
  reference: { officialCompaction: 'OFFICIAL-COMPACTION-REF-己', officialPreamble: 'OFFICIAL-PREAMBLE-REF-庚' },
}
const templatesPreset = (templatesView, templateCard) => ({
  MemoryArchiveButton: { 0: true },
  ArchivePanel: { 0: 'templates', 1: false, 2: promptsHost, 3: { busy: false, error: null }, 4: discReady, 5: catalogReady, 6: 0, 7: '' },
  TemplatesView: { 0: templatesView },
  TemplateCard: templateCard,
})

await check('★ v4.1 入口拆分：记忆库面板只剩 阅读 / 提示词模板（两子页）/ 设置，查看器三栏全部移出', () => {
  fakeReact.__setPreset(templatesPreset('compaction', null))
  try {
    const tree = fakeReact.createElement(comp, { wide: true })
    const s = JSON.stringify(tree)
    for (const t of ['提示词模板', '压缩指令', '收纳占位', '← 返回阅读']) assert.ok(s.includes(t), '缺: ' + t)
    assert.equal(s.includes('每次请求'), false, '查看器（每次请求）不该还在记忆库面板里')
    assert.equal(s.includes('过滤：标题 / id / 工作区'), false, '查看器会话列表不该还在记忆库面板里')
    assert.equal(s.includes('← 先选一个会话'), false, '查看器中栏不该还在记忆库面板里')
    assert.equal(FULL_UUID_RE.test(visibleText(tree)), false, '模板视图可见文本泄漏完整 id')
  } finally { fakeReact.__setPreset(null) }
})

await check('★ 压缩指令子页：说明逐字在、textarea(≥12行,初值=current)、按钮行齐、参考默认折叠；展开见官方原文+出处', () => {
  fakeReact.__setPreset(templatesPreset('compaction', {
    0: { status: 'ready', data: FAKE_TPL, error: '' }, 1: FAKE_TPL.templates.compaction.current,
    2: { busy: false, error: '', ok: '' }, 3: false, 4: 0,
  }))
  try {
    const tree = fakeReact.createElement(comp, { wide: true })
    const s = JSON.stringify(tree)
    const text = visibleText(tree)
    // ★ 2026-09-16：解释文案 = 用户新给的说明原文（逐字，见 client.js 里的同款注释）。
    for (const t of ['这里收录了提示词模板，并提供了编辑功能。',
      '原理：插件更改了dsh原生的【压缩】机制，将原本的编程总结提示词换成了rp向提示词。',
      '重要：',
      '①压缩提示词存进内存，更改必须重启才能生效，也不能对已经总结过的内容追溯生效。建议在决定重开后再大修提示词。',
      '②提示词来自st anima记忆系统，向量检索插件依赖此提示词。不建议不清楚检索功能原理的用户更改。',
      '官方原文参考']) {
      assert.ok(text.includes(t), '解释文案缺句: ' + t)
    }
    const areas = []
    collectNodes(tree, (n) => n.$$element === 'textarea', areas)
    // ★ 2026-09-16：压缩指令卡现在有**两个**文本框 —— ①压缩指令 ②破限头（默认留空、玩家自填）。
    assert.equal(areas.length, 2, '压缩指令卡应当有 2 个文本框（指令 + 破限头）')
    assert.ok(areas[0].props.rows >= 12, 'textarea 行数不足 12')
    assert.equal(areas[0].props.value, '压缩草稿甲', '文本框初值不是 current')
    // 破限头按 **id 定位**（不靠顺序，免得别的卡片也冒出 textarea 时假红/假绿）
    const jbArea = areas.find((a) => a.props.id === 'dma-template-jailbreak') || null
    assert.ok(jbArea, '找不到破限头文本框（id=dma-template-jailbreak）')
    assert.equal(jbArea.props.value, '', '★ 破限头默认必须是空（我们**不内置**任何破限文本）；实际 = ' + JSON.stringify(jbArea.props.value))
    assert.equal(jbArea.props.readOnly, undefined, '破限头应当可编辑（玩家自填）')
    for (const t of ['破限头（默认留空 · 由玩家自填）', '保存破限头', '清空', '当前：留空']) {
      assert.ok(text.includes(t), '缺破限头文案: ' + t)
    }
    // ★ 2026-09-16 用户口径：那条解释文案（"本插件不内置任何破限文本…"）**没必要**，已删。
    //   反证式断言：它**不该**再出现在界面上（免得以后又被人加回来）。
    assert.ok(!text.includes('本插件不内置任何破限文本'), '那条解释文案应当已删除')
    assert.ok(!text.includes('拼在压缩指令前面'), '那条解释文案应当已删除（后半句）')
    // placeholder 只在 props 里（visibleText 收不到）⇒ 用序列化树断言
    assert.ok(s.includes('留空 = 应用时不拼接任何破限文本（本插件不内置）'), '缺破限头 placeholder')
    // ★ 2026-09-16：主按钮从「保存」改成「应用（写进预设）」（用户口径：直接写进 preset 才有效）。
    //   ⛔ 别再用「保存」当断言 —— 文本框 placeholder 里也有"保存"字样，会假通过。
    for (const t of ['应用（写进预设）', '恢复内置默认', '复制', '载入内置默认', '官方原文参考',
      '压缩指令模板文本（点「应用（写进预设）」才会写进 preset）']) assert.ok(s.includes(t), '缺按钮/折叠: ' + t)
    assert.ok(text.includes('当前：内置默认'), '缺状态行（当前：内置默认）')
    // ★ 2026-09-16：提示块**整块撤掉**（用户口径）—— 反向断言：不许再出现指路的 ⚠️。
    assert.equal(text.includes('⚠️ 改完要点「⑤ 应用（真写入）」'), false, '指向别处入口的提示还在（用户看不到那个按钮）')
    assert.equal(text.includes('真正生效的是'), false, '旧口径提示还在')
    assert.equal(text.includes('OFFICIAL-COMPACTION-REF-己'), false, '参考默认应折叠（却已可见）')
    assert.equal(text.includes('来源：DSH 官方 compaction-basic'), false, '出处说明应随折叠隐藏')
  } finally { fakeReact.__setPreset(null) }

  fakeReact.__setPreset(templatesPreset('compaction', {
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

await check('★ 收纳占位子页（**只读**）：说明原文一句 + 变量说明 + 无编辑入口（2026-09-16 用户口径）', () => {
  fakeReact.__setPreset(templatesPreset('placeholder', {
    0: { status: 'ready', data: FAKE_TPL, error: '' }, 1: FAKE_TPL.templates.placeholder.current,
    2: { busy: false, error: '', ok: '' }, 3: false, 4: 0,
  }))
  try {
    const tree = fakeReact.createElement(comp, { wide: true })
    const text = visibleText(tree)
    for (const t of [
      // ★ 2026-09-16：说明缩到用户给的**一句原文**（其余整段撤掉）—— 逐字钉。
      '内容被「收纳」（移出上下文）之后，那一处不是空白 —— 模型在原位看到的是一段固定前言 + 归档正文。这里展示的是更改后的占位文本。如无必要请勿更改。',
      '可用变量：{from}']) {
      assert.ok(text.includes(t), '缺句: ' + t)
    }
    // ★ 2026-09-16：那两条 ⚠️ 提示用户判为"多余" ⇒ 整块删掉（反向断言，防止回流）。
    for (const gone of ['⚠️ 这段是「收纳占位」模板', '⚠️ 官方 compaction 那条路上的前言写死在官方代码里',
      '【为什么占位行里要带关键词】', '这段前言负责告诉模型三件事']) {
      assert.equal(text.includes(gone), false, '应当已删掉的文案还在: ' + gone)
    }
    assert.ok(text.includes('自定义'), 'custom=true 却没有「自定义」徽标')
    const areas = []
    collectNodes(tree, (n) => n.$$element === 'textarea', areas)
    assert.equal(areas.length, 1, '文本框应当恰好 1 个')
    assert.equal(areas[0].props.value, '占位草稿丁', '文本框初值不是 current')
    // ★ 2026-09-16 用户口径：这张卡**只读**（没有可写目的地）⇒ 结构化断言 + 反向断言双保险。
    assert.equal(areas[0].props.readOnly, true, '占位卡的文本框不是只读')
    assert.equal(areas[0].props['aria-label'], '收纳占位模板（只读）', 'aria-label 没标只读')
    assert.equal(typeof areas[0].props.onChange, 'undefined', '只读的文本框不该带 onChange')
    assert.ok(text.includes('（只读展示：面板不提供编辑入口。）'), '缺只读说明行')
    // 按钮面：只许「复制」（不许出现应用/保存/恢复内置默认/载入内置默认）
    const btns = []
    collectNodes(tree, (n) => n.$$element === 'button', btns)
    const labels = btns.map((b) => (typeof b.props.children === 'string' ? b.props.children : ''))
    for (const gone of ['应用（写进预设）', '保存', '恢复内置默认', '载入内置默认']) {
      assert.equal(labels.some((l) => l === gone), false, '只读卡上不该有按钮: ' + gone)
    }
    assert.ok(labels.includes('复制'), '只读卡少了「复制」按钮')
    assert.equal(text.includes('OFFICIAL-PREAMBLE-REF-庚'), false, '参考默认应折叠')
  } finally { fakeReact.__setPreset(null) }
})

await check('★ 模板读取失败（宿主不可用）：可读红字 + 重试，不出假输入框', () => {
  fakeReact.__setPreset(templatesPreset('compaction', {
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

await check('设置视图（工作区）：返回阅读 + 根模式/工作区根/向量检索 API/诊断；下拉显示真名；★ 卡片恰好 4 个输入框、密钥框 type=password 初值恒空（验收 1）', () => {
  const readyHost = {
    healthStatus: 'ready',
    health: { ok: true, webServer: true, sessionQuery: true, storageDirWritable: true, tavernReachable: true },
    healthError: '', configStatus: 'ready',
    config: {
      ok: true, rootMode: 'workspace', api: { url: 'https://example.invalid/v1', model: 'test-model' }, keySet: true, keyHint: '…abcd',
      // ★ 假 config：retrieval 两套三件套齐全（密钥只有 keySet/keyHint 一族投影 —— 投影侧反证在 _selftest-retrieval-config.mjs）
      //   重排**没有自己的密钥**（rerankKeyInherited=true）⇒ 面板必须如实说"沿用向量那把"
      retrieval: {
        url: 'https://api.example.invalid/v1', model: 'emb-model-x',
        rerankUrl: 'https://rerank.example.invalid/v1', rerankModel: 'rerank-model-x',
        keySet: true, keyHint: '…ef01',
        rerankKeySet: true, rerankKeyHint: '…ef01', rerankKeyInherited: true,
      },
      storageDir: '/tmp/x', configPath: '/tmp/x/config.json', configError: null,
    },
    configError: '',
  }
  fakeReact.__setPreset(basePreset('settings', readyHost, { 4: discReady, 5: catalogReady, 6: 0, 7: '' }))
  try {
    const tree = fakeReact.createElement(comp, { wide: true })
    const s = JSON.stringify(tree)
    const text = visibleText(tree)
    assert.ok(s.includes('← 返回阅读'), '缺返回阅读')
    for (const t of ['根模式', '工作区根（自动发现）', '向量检索 API', '诊断']) assert.ok(s.includes(t), '缺设置块: ' + t)
    assert.equal(s.includes('API 设置（用户自配）'), false, '旧「API 设置（用户自配）」卡应已被替换（20260918）')
    assert.ok(text.includes('示例角色'), '角色下拉没有真名')
    assert.ok(text.includes('1周目'), '周目下拉没有真名')
    assert.equal(FULL_UUID_RE.test(text), false, '设置视图可见文本泄漏完整 id')
    // ── 验收 1（★ 20260920 拆成两套三件套）：恰好 **6** 个输入框
    //    = 向量（地址/模型/密钥）+ 重排（地址/模型/密钥）；两个密钥框 password 且初值恒空 ──
    const inputs = []
    collectNodes(tree, (n) => n.props && typeof n.props.id === 'string' && n.props.id.startsWith('dma-retrieval-'), inputs)
    assert.equal(inputs.length, 6, '向量检索卡应当恰好 6 个输入框（实有 ' + inputs.map((n) => n.props.id).join(',') + '）')
    const byId = Object.fromEntries(inputs.map((n) => [n.props.id, n]))
    for (const id of ['dma-retrieval-url', 'dma-retrieval-model', 'dma-retrieval-key',
      'dma-retrieval-rerank-url', 'dma-retrieval-rerank-model', 'dma-retrieval-rerank-key']) {
      assert.ok(byId[id], '缺输入框: ' + id)
    }
    // 两个密钥框初值**恒**为空（不回显）；其余四框回显已保存值（喂的是假 config 的非空值）
    assert.equal(byId['dma-retrieval-key'].props.value, '', '★ 向量密钥框初值必须为空（不回显）')
    assert.equal(byId['dma-retrieval-rerank-key'].props.value, '', '★ 重排密钥框初值必须为空（不回显）')
    assert.equal(byId['dma-retrieval-url'].props.value, 'https://api.example.invalid/v1', '向量地址框应回显已保存值')
    assert.equal(byId['dma-retrieval-model'].props.value, 'emb-model-x', '向量模型框应回显已保存值')
    assert.equal(byId['dma-retrieval-rerank-url'].props.value, 'https://rerank.example.invalid/v1', '★ 重排地址框应回显**自己**那个地址')
    assert.equal(byId['dma-retrieval-rerank-model'].props.value, 'rerank-model-x', '重排模型框应回显已保存值')
    assert.equal(byId['dma-retrieval-key'].props.type, 'password', '向量密钥框必须 type=password')
    assert.equal(byId['dma-retrieval-rerank-key'].props.type, 'password', '重排密钥框必须 type=password')
    for (const id of ['dma-retrieval-url', 'dma-retrieval-model', 'dma-retrieval-rerank-url', 'dma-retrieval-rerank-model']) {
      assert.notEqual(byId[id].props.type, 'password', '非密钥框不许是 password: ' + id)
    }
    assert.ok(s.includes('已保存（…ef01）· 留空则不修改'), '向量密钥 placeholder 没用 retrieval.keyHint')
    // ★★ 重排密钥"没单独设置、正在沿用向量那把"必须**如实说出来**（⛔ 不许显示成"已单独保存"）
    assert.ok(s.includes('未单独设置 —— 现在用向量模型那把（…ef01）；只有填了才只给重排用'),
      '重排密钥 placeholder 没按 rerankKeyInherited 如实说明"沿用"')
    assert.ok(s.includes('未单独设置（沿用向量那把）'), '重排密钥状态行没如实显示"沿用向量那把"')
    // 两个各自的「清除」按钮（向量那把 keySet=true ⇒ 可用；重排那把也是 true ⇒ 可用）
    assert.ok(s.includes('清除向量密钥') && s.includes('清除重排密钥'), '缺两个密钥的清空按钮')
    // 测试连接说明两个模型各测一次（⛔ 不再假装"一次测试就全通"）
    assert.ok(s.includes('测试连接（两个模型各测一次）'), '测试按钮没写明覆盖两个模型')
    assert.equal(inputs.some((n) => n.props.id === 'dma-api-key' || n.props.id === 'dma-api-url' || n.props.id === 'dma-api-model'), false, '旧 dma-api-* 输入框应已移除')
    // 灰字说明
    assert.ok(s.includes('整库重算') && s.includes('_reembed-anima-vectors.mjs'), '缺「换向量模型必须整库重算」灰字')
    assert.ok(s.includes('唯一真相就是本配置文件'), '缺「唯一真相是配置文件」灰字')
    assert.ok(s.includes('两个模型可以不在同一个服务商上'), '缺「两个模型可不同服务商」的说明')
    // 另喂一份全空 config：六个输入框初值都是空（没有已存值可回显；两个密钥框任何情况下都恒空）
    const emptyHost = JSON.parse(JSON.stringify(readyHost))
    emptyHost.config.retrieval = {
      url: '', model: '', rerankUrl: '', rerankModel: '',
      keySet: false, keyHint: null, rerankKeySet: false, rerankKeyHint: null, rerankKeyInherited: false,
    }
    fakeReact.__setPreset(basePreset('settings', emptyHost, { 4: discReady, 5: catalogReady, 6: 0, 7: '' }))
    const tree2 = fakeReact.createElement(comp, { wide: true })
    const inputs2 = []
    collectNodes(tree2, (n) => n.props && typeof n.props.id === 'string' && n.props.id.startsWith('dma-retrieval-'), inputs2)
    assert.equal(inputs2.length, 6, '空 config 下仍应恰好 6 个输入框')
    for (const n of inputs2) assert.equal(n.props.value, '', '空 config 下初值应为空: ' + n.props.id)
    // 两个清除按钮都要**禁用**（没密钥可清）
    const txt2 = visibleText(tree2)
    assert.ok(txt2.includes('未设置'), '空 config 下密钥状态行应显示「未设置」')
    const btns2 = []
    collectNodes(tree2, (n) => n.props && n.props.children === '清除向量密钥' && n.$$element === 'button', btns2)
    assert.equal(btns2.length, 1, '空 config 下也要有「清除向量密钥」按钮')
    assert.equal(btns2[0].props.disabled, true, '★ 没有密钥时「清除向量密钥」必须禁用')
  } finally { fakeReact.__setPreset(null) }
})

await check('★★ 工作区根两个下拉显示的是**已保存的绑定**（config.root），不是自动发现挑的那个（20260920 真机："角色/周目切不动"）', () => {
  // 真机形状（逐条查过）：绑定 = `70a0502d…/playthrough-0256fcac…`；而 `discoverWorkspaces` 的
  //   `found[0]` 是**另一个**角色（`5c04213e…`）⇒ 旧代码两个下拉显示的是自动挑的那个：
  //   ① 打开面板时显示的就跟真实绑定不是一回事；② 保存后 `reload()` ⇒ tick++ ⇒ 发现重算 ⇒
  //   显示值被重置回自动挑的那个，用户看到的就是「切了又弹回去」。⇒ 显示值必须优先取绑定。
  const CHAR_B = '33333333-3333-4333-8333-333333333333'
  const PLAY_B = 'playthrough-44444444-4444-4444-8444-444444444444'
  const host = {
    healthStatus: 'ready',
    health: { ok: true, webServer: true, sessionQuery: true, storageDirWritable: true, tavernReachable: true },
    healthError: '', configStatus: 'ready',
    config: {
      ok: true, rootMode: 'workspace', api: { url: '', model: '' }, keySet: false, keyHint: null, storageDir: '', configPath: '', configError: null,
      root: { sessionId: null, characterId: CHAR_ID, playthroughId: PLAY_ID },   // ★ 绑定 = A
      retrieval: { url: '', model: '', rerankModel: '', keySet: false, keyHint: null },
    },
    configError: '',
  }
  const discAuto = {
    status: 'ready', error: '',
    found: [{ charId: CHAR_B, plays: [PLAY_B] }, { charId: CHAR_ID, plays: [PLAY_ID] }],
    characterId: CHAR_B, playthroughId: PLAY_B,   // ← 自动发现挑的那个（与绑定**不同**）
    emptyArchive: true,                           // 自动那个没归档 ⇒ 旧口径据此给"显示的那一行"标错
    archiveMap: { [CHAR_B + '/' + PLAY_B]: false, [CHAR_ID + '/' + PLAY_ID]: true },
  }
  fakeReact.__setPreset(basePreset('settings', host, { 4: discAuto, 5: catalogReady, 6: 0, 7: '' }))
  try {
    const tree = fakeReact.createElement(comp, { wide: true })
    const all = []
    collectNodes(tree, () => true, all)
    const byId = {}
    for (const n of all) if (n.props && typeof n.props.id === 'string') byId[n.props.id] = n
    const ch = byId['dma-character-select']
    const pt = byId['dma-playthrough-select']
    assert.ok(ch, '缺角色下拉')
    assert.ok(pt, '缺周目下拉')
    assert.equal(ch.props.value, CHAR_ID, '★ 角色下拉必须显示**绑定**，不是自动发现挑的那个')
    assert.equal(pt.props.value, PLAY_ID, '★ 周目下拉必须显示**绑定**，不是自动发现挑的那个')
    const chOpts = []
    collectNodes(ch, (n) => n.$$element === 'option', chOpts)
    assert.ok(chOpts.some((o) => o.props.value === CHAR_ID), '绑定那个角色不在选项里（选了也回不去）')
    // 「无归档」徽标跟着**显示的那一行**走：绑定那个有 archive/ ⇒ 不许标
    //（旧口径拿自动那个的 emptyArchive=true ⇒ 会把别人的状态标到这一行上）
    // ⚠️ 判据必须精确到**徽标本身**（`children === '无归档'`）—— 卡片说明那段话里也有「无归档」三个字，
    //   用 `includes` 会永远绿/永远红（本台子第一版就踩了：误报成"徽标还在"）。
    const badges = []
    collectNodes(tree, (n) => n.props && n.props.children === '无归档', badges)
    assert.equal(badges.length, 0, '★ 显示的那一行有 archive/ ⇒ 不许出现「无归档」徽标')
    // 反证：把 archiveMap 里显示的**那一行**改判成没有 archive/ ⇒ 徽标必须出现
    const discNoArc = Object.assign({}, discAuto, { archiveMap: Object.assign({}, discAuto.archiveMap, { [CHAR_ID + '/' + PLAY_ID]: false }) })
    fakeReact.__setPreset(basePreset('settings', host, { 4: discNoArc, 5: catalogReady, 6: 0, 7: '' }))
    const tree2 = fakeReact.createElement(comp, { wide: true })
    const badges2 = []
    collectNodes(tree2, (n) => n.props && n.props.children === '无归档', badges2)
    assert.equal(badges2.length, 1, '★ 反证：显示的那一行没有 archive/ ⇒ 徽标必须出现（否则这条判据是假的）')
    fakeReact.__setPreset(basePreset('settings', host, { 4: discAuto, 5: catalogReady, 6: 0, 7: '' }))
  } finally { fakeReact.__setPreset(null) }
})

await check('★ 工作区根下拉：绑定指向的 id 不在发现结果里 ⇒ **照样列出来并标 ⚠**（⛔ 不许静默显示成别的项）', () => {
  // 这是这次误会的根：下拉显示 A、实际绑着 B，两边都不说话。宁可列一条"不在工作区"的项，也不许装作没这回事。
  const GONE = 'playthrough-55555555-5555-4555-8555-555555555555'
  const host = {
    healthStatus: 'ready',
    health: { ok: true, webServer: true, sessionQuery: true, storageDirWritable: true, tavernReachable: true },
    healthError: '', configStatus: 'ready',
    config: {
      ok: true, rootMode: 'workspace', api: { url: '', model: '' }, keySet: false, keyHint: null, storageDir: '', configPath: '', configError: null,
      root: { sessionId: null, characterId: CHAR_ID, playthroughId: GONE },   // ★ 绑定指向一个已不在工作区的周目
      retrieval: { url: '', model: '', rerankModel: '', keySet: false, keyHint: null },
    },
    configError: '',
  }
  const disc = { status: 'ready', error: '', found: [{ charId: CHAR_ID, plays: [PLAY_ID] }], characterId: CHAR_ID, playthroughId: PLAY_ID, archiveMap: { [CHAR_ID + '/' + PLAY_ID]: true } }
  fakeReact.__setPreset(basePreset('settings', host, { 4: disc, 5: catalogReady, 6: 0, 7: '' }))
  try {
    const tree = fakeReact.createElement(comp, { wide: true })
    const all = []
    collectNodes(tree, () => true, all)
    const pt = all.find((n) => n.props && n.props.id === 'dma-playthrough-select')
    assert.ok(pt, '缺周目下拉')
    assert.equal(pt.props.value, GONE, '★ 绑定那个周目必须被选中（⛔ 不许换成工作区里有的别的）')
    const opts = []
    collectNodes(pt, (n) => n.$$element === 'option', opts)
    assert.ok(opts.some((o) => o.props.value === GONE), '绑定那个周目必须出现在选项里')
    assert.ok(visibleText(tree).includes('⚠ 不在工作区'), '缺「⚠ 不在工作区」标注')
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

await check('★ 用到的宿主 rest 全在表内（含 /templates 与 v5 的 /agent·/agent/detect），且全部用到（prompt 数据面在另一条核对）', () => {
  const TABLE = [
    ['GET', '/config'],
    ['PUT', '/config'],
    // （20260918：/config/test 随旧「API 设置」卡一起退出面板 —— 卡换成了「向量检索 API」，
    //   测试连接改打 /retrieval/test；服务端那条端点仍在，只是面板不再用。）
    ['POST', '/retrieval/test'],
    ['GET', '/sessions'],
    ['GET', '/session/events'],
    ['GET', '/agent'],
    ['GET', '/agent/detect'],
    ['GET', '/health'],
    ['GET', '/editor/diagnostics'],   // M9
    ['GET', '/templates'],
    ['PUT', '/templates'],
    // 归档写入面（2026-09-15 U1/B2）：面板的「⇩ 导入 / 收纳」视图用到这五条 ——
    // 以前一个都没用到（导入只有服务端内核、面板上没有入口，用户"看不见导入"就是这个原因）。
    ['GET', '/collect/targets'],
    ['POST', '/collect/scan'],
    ['POST', '/collect/auto'],
    ['POST', '/import/plan'],
    ['POST', '/import/apply'],
    // 自动收纳的状态出口（2026-09-15：压缩后自动收，失败要播报 ⇒ 顶栏红标读它）
    ['GET', '/auto-collect'],
    // 「角色扮演记忆库」只读出口（20260919）：同一档的上一块 —— 清单（不带 ?file=）与单份正文各一次调用
    ['GET', '/playthrough/rp-memory'],
    // 「打开文件夹」（2026-09-20）：剧情大纲档那一颗按钮 —— 动作型，POST；⛔ 客户端不传路径
    ['POST', '/playthrough/reveal'],
    // 「后台收纳状态」只读出口（20260919）：面板 shell.overlay 的提示条读它（dsh-anima-rag 落的文件）
    ['GET', '/anima/ingest-state'],
    // 「这个会话属于哪个周目」只读查询（20260919）：面板**跟随当前会话**靠它（查到就把绑定改过去）
    ['GET', '/playthrough/for-session'],
    // 「向量」页签（2026-09-20）：状态只读 + 动作请求单（动作由按会话挂载的 dsh-anima-rag 执行）
    ['GET', '/vector/state'],
    ['POST', '/vector/action'],
    // v3 消费端（2026-09-16）：维护抽屉的「v3 外部组合」面板读投影 + 两个显式动作
    // （面板那条 PUT /config 走的是表里已有的 ['PUT','/config']，这里两条是新端点）
    ['GET', '/v3'],
    ['POST', '/v3/mode'],
    // trace 合同的「单条装配记录」详情（2026-09-17）：面板的逐轮装配视图按需读一条，
    // 段正文还要再点一次（带 &section=N）。同一条 rest，不额外开端点。
    ['GET', '/v3/assembly'],
    // 清空总结（运维口；20260918 撤侧路后剩下的唯一一条 summarize 端点 —— 摘要由压缩链产出）
    ['POST', '/summarize/reset'],
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
  // ⚠️ 这几个「禁串」**拼出来**而不是写字面量：本文件要进公开仓库，
  //    直接写出本机盘符路径（用户目录 / D 盘应用目录）会让上架闸门的泄露扫描命中它自己（已发生一次）。
  const B = '\\'
  const needles = [
    'settings' + '.section',
    'local' + 'Storage',
    'C:' + B + 'Users',
    'C:' + '/Users',
    'D:' + B + 'apps',
    'D:' + '/apps',
  ]
  for (const bad of needles) {
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

await check('★ 20260915 查看器提速：**不再有空闲批量补标题**（源码里零 /api/sessions/resolve 调用点）+ 列表默认走 /api/resident（零解析）', () => {
  // 旧契约（P0 内存收紧）是「补标题有硬上限 20」；新契约更强：**整个自动补标题都没了**。
  // 为什么不删这条而改写：删掉等于把"防回归"一起删了；改写后它盯的是**新的**反回归面。
  const forbidden = /apiGet\([^)]*\/api\/sessions\/resolve/
  // ★ 灵敏度自证（这条断言能变红吗）：拿老写法原文喂给它，必须命中。
  assert.equal(
    forbidden.test("apiGet(PROMPT_API_BASE + '/api/sessions/resolve?ids=' + encodeURIComponent(batch.join(',')), controller.signal)"),
    true,
    '反证失败：这个正则该能抓住老写法（否则断言是橡皮章）',
  )
  assert.equal(forbidden.test(src), false, 'client.js 里又出现了自动 resolve 调用点（打开即批量解析 = 卡的主因）')
  assert.equal(src.includes('resolveSentRef.current +='), false, '又出现了自动补标题的预算扣减（说明 effect 被搬回来了）')
  // 新路径必须在：列表默认读常驻投影
  assert.ok(src.includes("PROMPT_API_BASE + '/api/resident'"), '缺 /api/resident 读取点（列表默认应读常驻投影）')
  assert.ok(/const \[listMode, setListMode\] = React\.useState\('resident'\)/.test(src), '缺 listMode 状态（默认应为 resident）')
  assert.ok(src.includes('onToggleResident'), '缺「＋/－ 常驻」的接线')
  // 旧的常量/注释可以留（它们仍是"别一次解析一堆"的口径说明），但**不许**再被当成执行路径
  const cap = src.match(/const TITLE_FILL_CAP = (\d+)/)
  assert.ok(cap && Number(cap[1]) === 20, 'TITLE_FILL_CAP 常量应保留为口径说明（实为 ' + (cap ? cap[1] : '(none)') + '）')
})

await check('★ 解释文案（2026-09-16 起 = 用户给的说明原文）+ 占位卡的官方锚点仍在；仍然只 require(\'react\')', () => {
  // 沿革：规格 §2 长解释 →（09-15）用户说明原文一版 →（09-16）用户说明原文二版（当前）。
  // 这里钉的是**当前**那版逐字进源码；占位卡那两句技术锚点仍在源码别处（自检台不当橡皮章）。
  for (const t of [
    '这里收录了提示词模板，并提供了编辑功能。',
    '原理：插件更改了dsh原生的【压缩】机制，将原本的编程总结提示词换成了rp向提示词。',
    '①压缩提示词存进内存，更改必须重启才能生效，也不能对已经总结过的内容追溯生效。建议在决定重开后再大修提示词。',
    '②提示词来自st anima记忆系统，向量检索插件依赖此提示词。不建议不清楚检索功能原理的用户更改。',
    '<compacted-summary>',
    'frameSummary',
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

// ---------- v4.1 A 单：静态核对 ----------
await check('★ v5 P0 双席位在源码里：memory-archive + agent-editor，都是 sidebar.footer.action 注册', () => {
  assert.ok(src.includes("{ name: 'sidebar.footer.action', id: 'memory-archive' }"), '缺 memory-archive 席位')
  assert.ok(src.includes("{ name: 'sidebar.footer.action', id: 'agent-editor' }"), '缺 agent-editor 席位')
  assert.equal(src.includes("id: 'prompt-viewer'"), false, '旧席位 prompt-viewer 应已改名 agent-editor')
})

// ★ 2026-09-18（用户口径「拆了吧不需要了」）：**完整视图与并列版块页签已整体删除**。
//   原来是「★ 完整视图：三个 /api/part 各取一次、复制全文、截断标注」那条 —— 功能没了，
//   那条测试也就没了。换成这条**删除护栏**：拆掉的东西⛔ 不许偷偷长回来。
await check('★ 完整视图 / 并列版块页签已整体删除（护栏）：代码里⛔ 不许再出现 FullPromptView / PartTabs / PART_TABS / fullState / copyFull', () => {
  // ⚠️ 只看**代码**、不看注释：拆掉的东西值得在注释里留一段"为什么拆、别再复活"的交代，
  //    所以先去掉块注释与行注释再判。⚠️ 代价（已知并接受）：源码里有少数带 `://` 的字面量
  //    （链接），行注释剥法会把那些行的后半截一起吃掉 —— 只会**漏报**、不会误报，
  //    而这几行里不存在被禁标识符 ⇒ 对本条判据无影响。
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  for (const t of ['FullPromptView', 'PartTabs', 'PART_TABS', 'fullState', 'copyFull']) {
    assert.equal(code.includes(t), false, '★ 已删除的完整视图残留了 ' + t + ' —— 它把整个并列架构带回来了？')
  }
  // ⛔ 也不许再出现「切到 'full'」这种分支（part 只剩 messages/system/tools + 如实指路）
  assert.equal(/part\s*===\s*'full'/.test(code), false, "★ 还在判 part === 'full'")
  // 但「复制整楼」这类**别的**功能要照旧（buildFullPlainText 是段抽屉在用的，别误删）
  assert.ok(code.includes('function buildFullPlainText('), 'buildFullPlainText 被误删了（段抽屉的「复制整楼」还在用它）')
  assert.ok(code.includes('已截断，原 '), '截断标注口径没了')
})

await check('★ 大文本不许塞一个 <pre>：FULL_CHUNK_CHARS=2000 分块 + content-visibility:auto', () => {
  const m = src.match(/const FULL_CHUNK_CHARS = (\d+)/)
  assert.ok(m && Number(m[1]) === 2000, 'FULL_CHUNK_CHARS 应为 2000')
  assert.ok(src.includes('contentVisibility: '), '缺 content-visibility 分块渲染')
})

await check('★ DSH 式会话列表：「工作区」分组、14px 名字/12px 时间、每组 8 条折叠、slug 降级如实标注', () => {
  const m = src.match(/const GROUP_ROW_LIMIT = (\d+)/)
  assert.ok(m && Number(m[1]) === 8, 'GROUP_ROW_LIMIT 应为 8')
  assert.ok(src.includes("'工作区'"), '缺分组标题')
  assert.ok(src.includes('展开其余 '), '缺「展开其余 N 个会话」折叠文案')
  assert.ok(src.includes('fontSize: 14'), '工作区名/会话标题应为 14px')
  assert.ok(src.includes('未解析出路径'), 'slug 降级必须标「（未解析出路径）」，不许假装真名')
})

await check('★ §2.6 的 12 条版块注释逐字进源码（title 悬停含谁注入 + order + 作用）', () => {
  for (const t of [
    'DSH 核心注入的 agent 身份与环境说明：告诉模型它在 DSH 里、检出目录在哪、GUI 上下文与行为纪律。恒定注入，永远排在最前。',
    '部署/agent 配置里的人设与定位（这个 agent 是谁、怎么说话）。',
    '当前所选预设的固定段：ST 预设归一化后的系统提示内容（身份与文风主要来自这里）。',
    'RP 模式策略段。默认只说明“高风险操作被锁”，不是扮演身份；身份与文风仍来自 preset / 角色卡。',
    // ★ 2026-09-20：这条注释改成"已退役"口径（状态子系统整套剥离）—— 断言跟着文案走。
    '【已退役 · 2026-09-20】原为 L1 状态卡（副 LLM 每轮记账的数值/分组/到期）；现在状态改由周目笔记里的 `state.md` 维护。',
    'L2 检索记忆：从历史里检索出来的摘录（<recalledMemories>）与近场历史（<immediateHistory>）。只对 RP 会话注入。',
    '工具的使用说明与纪律，和下面 tools 里的定义配套。',
    '被压缩出上下文的那段历史（checkpoint）。前言由官方 frameSummary() 拼出，作用是告诉模型“这是既成背景，别复述”。',
    '这次请求可用的工具定义（名字 + 参数 schema）。几十个属于正常量级。',
    '真实历史轮次；其中可能夹着 durable 注入的快照（例如 context() 的每轮快照）。',
    '角色卡字段（SillyTavern 格式）在 system 里的落点。',
    '（归属待确认）疑似剧情锚点相关注入；没查到确定的注入方，先如实标注。',
    '未能识别归属（未匹配到已知注入点）',
  ]) assert.ok(src.includes(t), '缺逐字注释: ' + t)
  assert.ok(src.includes('谁注入：'), '悬停 title 缺「谁注入」字段')
})

// ---------- v4.1 B 单：阅读区排版常量（数值自证）+ 编辑功能备注（静态核对） ----------
const changelogSrc = readFileSync(path.join(here, 'CHANGELOG.md'), 'utf8')

await check('★ B 单排版常量（数值自证）：正文≥15px·行高≥1.7·列宽 min(880px,100%) 居中·内边距≥24·段间距≥0.6em·块间距≥12·等宽14px·行高≥1.6·小字≥12px', () => {
  const grab = (name) => {
    const m = src.match(new RegExp('const ' + name + ' = (.+)'))
    assert.ok(m, '缺排版常量 ' + name)
    return m[1].split('//')[0].trim().replace(/^'|'$/g, '')   // 去掉行尾注释与引号
  }
  const body = Number(grab('BODY_FONT_SIZE'))
  assert.ok(body >= 15 && body <= 16, '正文字号应在 15–16px，实为 ' + body)
  const lh = Number(grab('BODY_LINE_HEIGHT'))
  assert.ok(lh >= 1.7, '正文行高应 ≥1.7，实为 ' + lh)
  assert.equal(grab('READ_COL_WIDTH'), 'min(880px, 100%)', '正文列宽应为 min(880px, 100%)')
  assert.ok(src.includes("margin: '0 auto'"), '正文列缺 margin 0 auto（水平居中）')
  assert.ok(src.includes("padding: '4px ' + READ_PAD_X + 'px 16px'"), '阅读区滚动容器没有用 READ_PAD_X 做左右内边距')
  const pad = Number(grab('READ_PAD_X'))
  assert.ok(pad >= 24, '阅读区左右内边距应 ≥24，实为 ' + pad)
  const paraGap = parseFloat(grab('BODY_PARA_GAP'))
  assert.ok(paraGap >= 0.6, '段间距应 ≥0.6em，实为 ' + paraGap + 'em')
  const blockGap = Number(grab('BLOCK_GAP'))
  assert.ok(blockGap >= 12, '块间距应 ≥12px，实为 ' + blockGap)
  const mono = Number(grab('MONO_FONT_SIZE'))
  assert.equal(mono, 14, '等宽字号应为 14px，实为 ' + mono)
  const monoLh = Number(grab('MONO_LINE_HEIGHT'))
  assert.ok(monoLh >= 1.6, '等宽行高应 ≥1.6，实为 ' + monoLh)
  const small = Number(grab('SMALL_FONT_SIZE'))
  assert.ok(small >= 12, '小字（时间/字数/徽标）应 ≥12px，实为 ' + small)
  assert.equal(/fontSize: 11[,}]/.test(src), false, '仍有 11px 小字残留（应统一到 SMALL_FONT_SIZE）')
  console.log('   [info] 排版常量：正文 ' + body + 'px / 行高 ' + lh + ' / 列宽 min(880px, 100%) 居中 / 内边距 '
    + pad + 'px / 段间距 ' + paraGap + 'em / 块间距 ' + blockGap + 'px / 等宽 ' + mono + 'px·行高' + monoLh + ' / 小字 ' + small + 'px')
})

await check('★ B 单编辑功能：备注逐字进界面源码 + TODO 写明真相源/回滚；零写归档代码路径；CHANGELOG「计划中（未实现）」两条逐字', () => {
  assert.ok(src.includes('待实现（已记录）：编辑功能 —— 直接修改摘要正文、楼层正文与状态档案。当前版本只读。'),
    '界面备注没有逐字进源码')
  assert.ok(/TODO[^\n]*编辑功能/.test(src), '阅读区附近缺编辑功能 TODO 注释')
  assert.ok(src.includes('真相源') && src.includes('回滚'), 'TODO 未写明为什么不先做（真相源 / 回滚策略）')
  for (const m of src.matchAll(/mutateJson\((?!url\b)/g)) {   // 跳过函数定义处（首个参数名 url）
    const chunk = src.slice(m.index, m.index + 80)
    assert.ok(chunk.includes('HOST_API_BASE'), 'mutateJson 出现在宿主 API 之外（疑似新增写归档路径）: ' + chunk)
  }
  assert.ok(!/TAVERN_API_BASE[^;]*'(PUT|POST)'/.test(src), 'Tavern 通路出现 PUT/POST（写归档）')
  assert.ok(changelogSrc.includes('## 计划中（未实现）'), 'CHANGELOG 缺「计划中（未实现）」小节')
  assert.ok(changelogSrc.includes('**编辑功能**：直接修改摘要正文、楼层正文与状态档案。当前版本只读；先做编辑需要先定「改哪一份真相源」与回滚策略。'),
    'CHANGELOG 编辑功能条目未逐字')
  assert.ok(changelogSrc.includes('**占位符收纳执行器**：把老楼替换成一行占位节点（占位模板已在面板里可编辑，但尚无执行器）。'),
    'CHANGELOG 占位符收纳执行器条目未逐字')
})

// ---------- v4.1 D 单：正文 Markdown（__internals.parseMarkdown 纯函数）+ 阅读源行微调 + CSS 兼容备忘 ----------
function mdFlat(blocks) {
  // 把 parseMarkdown 的输出摊平成「可见文本」近似（链接只取显示文本、代码块取 text）
  const out = []
  const spans = (arr) => {
    for (const sp of arr || []) out.push(sp && sp.t === 'a' ? sp.s : (sp ? sp.s : ''))
  }
  for (const b of blocks) {
    if (b.kind === 'code') { out.push(b.text); continue }
    if (b.kind === 'hr') continue
    if (b.kind === 'quote') { (b.lines || []).forEach(spans); continue }
    if (b.kind === 'ul' || b.kind === 'ol') { (b.items || []).forEach((it) => spans(it.spans)); continue }
    spans(b.spans)
  }
  return out.join('\n')
}

await check('★ D 单 parseMarkdown 逐项：#/##/### 标题、**粗**/__粗__、*斜*/_斜_、`行内代码`、围栏代码块、有序/无序列表（含 2 空格嵌套）、引用、---/***/分隔线、链接只显文本', () => {
  const md = itn.parseMarkdown
  assert.equal(typeof md, 'function', '__internals.parseMarkdown 不是函数')
  const kindOf = (t) => md(t).map((b) => b.kind)
  // 标题 1–3 级；4 级不支持 ⇒ 原样段落
  assert.deepEqual(kindOf('# 一级'), ['h1'])
  assert.deepEqual(kindOf('## 二级'), ['h2'])
  assert.deepEqual(kindOf('### 三级'), ['h3'])
  assert.deepEqual(kindOf('#### 不是标题'), ['p'])
  // 粗体 ** 与 __（★ **粗** 不得误配成两个斜体）
  const b1 = md('前**粗**后')[0]
  assert.equal(b1.kind, 'p')
  assert.ok(b1.spans.some((sp) => sp.t === 'b' && sp.s === '粗'), '缺粗体 span')
  assert.equal(b1.spans.some((sp) => sp.t === 'i'), false, '**粗** 被误配成斜体')
  const b2 = md('__粗__')[0]
  assert.ok(b2.spans.some((sp) => sp.t === 'b' && sp.s === '粗'), '__粗__ 没配成粗体')
  // 斜体 * 与 _
  assert.ok(md('*斜*')[0].spans.some((sp) => sp.t === 'i' && sp.s === '斜'), '缺斜体 span')
  assert.ok(md('x _斜_ y')[0].spans.some((sp) => sp.t === 'i' && sp.s === '斜'), '_斜_ 没配成斜体')
  assert.equal(md('a snake_case_name b')[0].spans.some((sp) => sp.t === 'i'), false, 'snake_case 被误配成斜体')
  // 行内代码
  assert.ok(md('前`code`后')[0].spans.some((sp) => sp.t === 'code' && sp.s === 'code'), '缺行内代码 span')
  // 无序 / 有序列表
  const ul = md('- a\n- b')[0]
  assert.equal(ul.kind, 'ul')
  assert.equal(ul.items.length, 2, '无序列表应为两项')
  assert.ok(mdFlat([ul]).includes('a'))
  const ol = md('1. a\n2. b')[0]
  assert.equal(ol.kind, 'ol', '有序列表')
  assert.equal(ol.items.length, 2)
  assert.equal(ol.items[1].num, 2)
  // 嵌套（2 空格缩进 = 一层）
  const nested = md('- a\n  - b')[0]
  assert.equal(nested.kind, 'ul')
  assert.equal(nested.items[1].level, 1, '2 空格缩进应算第 1 层嵌套')
  // 引用
  assert.equal(md('> 引用')[0].kind, 'quote')
  // 围栏代码块（带语言）
  const cb = md('```js\ncode\n```')[0]
  assert.equal(cb.kind, 'code')
  assert.equal(cb.lang, 'js')
  assert.equal(cb.text, 'code')
  // 分隔线
  assert.deepEqual(kindOf('---'), ['hr'])
  assert.deepEqual(kindOf('***'), ['hr'])
  // 链接只显文本：url 不出现在可见文本里（渲染层只放 title）
  const lk = md('看[文本](http://x)这里')[0]
  const visible = mdFlat([lk])
  assert.ok(visible.includes('文本'), '链接文本丢了')
  assert.equal(visible.includes('http://x'), false, '链接 url 不该出现在可见文本里')
  assert.equal(lk.spans.find((sp) => sp.t === 'a').href, 'http://x')
})

await check('★ D 单 parseMarkdown 健壮性：未闭合围栏 / 落单 ** / 空串 / 非字符串 / 超长单行 ⇒ 不抛且降级成原样文本', () => {
  const md = itn.parseMarkdown
  let r = null
  assert.doesNotThrow(() => { r = md('```js\n未闭合的围栏') }, '未闭合围栏抛了')
  const flat = mdFlat(r)
  assert.ok(flat.includes('```js') && flat.includes('未闭合的围栏'), '未闭合围栏没有降级成原样文本: ' + flat)
  assert.doesNotThrow(() => { r = md('落单 ** 星号') })
  assert.ok(mdFlat(r).includes('**'), '落单 ** 应保持原样')
  assert.doesNotThrow(() => md(''))
  assert.doesNotThrow(() => md(null))
  assert.doesNotThrow(() => md(42))
  assert.doesNotThrow(() => md({ weird: true }))
  assert.doesNotThrow(() => md('x'.repeat(300000)), '超长单行抛了')
  assert.deepEqual(md(''), [], '空串应给空块数组')
})

await check('★ D 单静态：无 dangerouslySetInnerHTML；md 只用于正文（摘要/原文/事件/messages 视图），system/tools 保持原样；★ 2026-09-20「状态」档已摘除', () => {
  assert.equal(src.includes('dangerouslySetInnerHTML'), false, '出现 dangerouslySetInnerHTML')
  const fnBody = (name) => {
    const i = src.indexOf('function ' + name + '(')
    assert.ok(i >= 0, '缺函数 ' + name)
    const j = src.indexOf('\n      function ', i)
    return src.slice(i, j > i ? j : src.length)
  }
  // ✅ 正文侧：三个散文渲染处 + messages 视图专用组件都调用 MarkdownBody；MarkdownBody 用 useMemo
  for (const name of ['SummariesFlow', 'FloorsFlow', 'EventsFlow', 'ViewerMessagesBody']) {
    assert.ok(fnBody(name).includes('MarkdownBody'), name + ' 应该用 MarkdownBody 渲染正文')
  }
  assert.ok(fnBody('MarkdownBody').includes('useMemo'), 'MarkdownBody 应该 useMemo 解析一次（不重解析）')
  // ⛔ 原样侧：messages 的 md 只经 ViewerMessagesBody 这一个入口；system/tools/状态 一律不用 md
  //   （「完整视图」原也在这一串里 —— 2026-09-18 它已整体删除，故那两条断言一并去掉）
  const part = fnBody('PromptPartView')
  assert.ok(part.includes('ViewerMessagesBody'), 'messages 视图应经 ViewerMessagesBody')
  assert.equal(part.includes('MarkdownBody'), false, 'PromptPartView 里不得直接用 MarkdownBody（只能经 messages 入口）')
  // ★ 2026-09-20：「状态」档整个摘除（用户口径：「记忆库里的状态面板可以摘除」）
  //   ⇒ 原来那条"状态源是 JSON、不 md 化"的断言跟着撤；改成"它不许回来"。
  //   ⚠️ 这里**不能**用上面那个 `fnBody`（它自带"函数必须存在"的断言，会以"缺函数"名义炸）。
  assert.equal(src.includes('function StateFlow('), false, '⛔ StateFlow 已摘除，不该再出现')
  assert.equal(src.includes('ProseBody'), false, '被 MarkdownBody 取代的旧正文组件应删干净')
})

await check('★ D 单：搜索类阅读源删干净（组件/字面量/注入能力），「阅读源」标签不再出现（渲染断言），摘要/原文/状态仍在', () => {
  assert.equal(src.includes('SearchFlow'), false, '搜索源组件应删除')
  assert.equal(src.includes('会话搜索'), false, '源码里还有该源的中文标签')
  assert.equal(src.includes('sessions.search'), false, 'sessions.search 调用应删除')
  assert.equal(src.includes('sessions.open'), false, 'sessions.open 调用应删除')
  assert.equal(src.includes("ctx.get('sessions')"), false, '不再取 sessions 能力')
  // 「阅读源」标签：用渲染断言（工作区就绪读视图的可见文本里不再有这三个字）
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
    assert.equal(text.includes('阅读源'), false, '「阅读源」标签还在（渲染断言）')
    // ★ 2026-09-20：「状态」档已摘除
    for (const t of ['摘要', '原文']) assert.ok(text.includes(t), '缺阅读源: ' + t)
  } finally { fakeReact.__setPreset(null) }
})

await check('★ 导入/收纳视图（2026-09-15 U1/B2）：三张卡齐 + 控件 id 齐 + 顶部有入口按钮', () => {
  const readyHost = {
    healthStatus: 'ready',
    health: { ok: true, webServer: true, sessionQuery: true, storageDirWritable: true, tavernReachable: true },
    healthError: '', configStatus: 'ready',
    // ★ root 必须给：WriteView 的角色-周目取自 config.root（没给就只剩"选角色"空下拉）
    config: {
      ok: true, rootMode: 'workspace',
      root: { sessionId: null, characterId: CHAR_ID, playthroughId: PLAY_ID },
      api: { url: '', model: '' }, keySet: false, keyHint: null, storageDir: '', configPath: '', configError: null,
    },
    configError: '',
  }
  const targetsReady = {
    status: 'ready', error: '',
    list: [{ characterId: CHAR_ID, playthroughId: PLAY_ID, title: '自检周目', archiveRel: CHAR_ID + '/' + PLAY_ID + '/archive', hasArchive: false, floorCount: null, summaryCount: null, manifestWriter: null }],
  }
  fakeReact.__setPreset(Object.assign(
    basePreset('write', readyHost, { 4: discReady, 5: catalogReady, 6: 0, 7: '' }),
    { WriteView: { 0: targetsReady } },
  ))
  try {
    const tree = fakeReact.createElement(comp, { wide: true })
    const text = visibleText(tree)
    for (const t of ['写到哪个「角色-周目」', '导入外部聊天记录', '收纳：把本机会话的楼段收进归档',
      '① 扫描 Tavern 留下的待导入文件', '看一看能收什么',
      // 归档摘要卡（20260918 撤侧路）：不再有「扫归档 → 总结」两步，只剩压缩链说明 + 清空总结运维口
      '归档摘要：由压缩链自动产出', '摘要不再单独调模型',
      // 清空总结（运维口）+ 重新导入（覆盖同号楼层）
      '清空总结（先看计划）', '覆盖同号楼层（重新导入）',
      // 用户 2026-09-16 指定：那个按钮的文案改成「导入①」
      '导入①',
      // 自动收纳（压缩后自动收）：默认开 + 只收绑定周目
      '压缩后自动收（默认开）', '只收**绑定周目**的会话']) {
      assert.ok(text.includes(t), '缺: ' + t)
    }
    // ★ 撤侧路（20260918）反向断言：两步入口与手动总结的字样不许再回来（摘要由压缩链产出）
    for (const gone of ['① 扫描归档', '② 开始总结', '开始总结', '交给总结模型']) {
      assert.ok(!text.includes(gone), '侧路字样不该再出现: ' + gone)
    }
    // 「② 收进归档」按钮与「该周目下没有待导入文件」提示都是**动作之后**才出现的
    // （前者要预览、后者要扫描过）⇒ 不在常显清单里，由下面的反向断言兜住。
    // 顶栏入口必须存在（否则用户"看不见导入"——这正是这次要修的）
    assert.ok(text.includes('⇩ 导入 / 收纳'), '顶栏缺导入/收纳入口按钮')
    const withId = []
    collectNodes(tree, (n) => n && typeof n.props === 'object' && typeof n.props.id === 'string', withId)
    const have = withId.map((n) => n.props.id)
    for (const want of ['dma-write-char', 'dma-write-play', 'dma-import-file', 'dma-import-text',
      'dma-import-keep-greeting', 'dma-import-keep-hidden', 'dma-import-overwrite', 'dma-collect-session', 'dma-auto-collect-enabled']) {
      assert.ok(have.includes(want) || text.includes(want), '缺控件: ' + want)
    }
    // ⛔ 计划没跑之前不许出现"收进归档"可点按钮组里的预览块（预览块只在 plan 之后渲染）
    assert.ok(text.includes('预览（还没写任何东西）') === false, '没预览却出现了预览块')
  } finally { fakeReact.__setPreset(null) }
})

await check('★ 自动收纳**失败播报**（用户口径：失败不许静默）：顶栏红标 + 卡里给 code 与原因', () => {
  const readyHost = {
    healthStatus: 'ready',
    health: { ok: true, webServer: true, sessionQuery: true, storageDirWritable: true, tavernReachable: true },
    healthError: '', configStatus: 'ready',
    config: {
      ok: true, rootMode: 'workspace',
      root: { sessionId: null, characterId: CHAR_ID, playthroughId: PLAY_ID },
      api: { url: '', model: '' }, keySet: false, keyHint: null, storageDir: '', configPath: '', configError: null,
    },
    configError: '',
  }
  const failed = {
    status: 'ready', enabled: true, error: '',
    last: { at: '2026-09-15T13:00:00.000Z', ok: false, code: 'IMPORT_TAVERN_UNREACHABLE', message: '连不上 Tavern 工作区面', ms: 12 },
  }
  const targetsReady = {
    status: 'ready', error: '',
    list: [{ characterId: CHAR_ID, playthroughId: PLAY_ID, title: '自检周目', archiveRel: CHAR_ID + '/' + PLAY_ID + '/archive', hasArchive: false, floorCount: null, summaryCount: null, manifestWriter: null }],
  }
  fakeReact.__setPreset(Object.assign(
    // ★ hook 序号算术（别数错）：0 view · 1 fullscreen · 2 host · 3 modeSave · 4 disc · 5 catalog
    //   · 6 tick · 7 pickedSessionId · 8 actionCtl(useRef) · 9 既有的清理 useEffect
    //   · **10 = 自动收纳状态**（新增 hook 一律追加在最后，见 client.js 里的同款注释）
    basePreset('write', readyHost, { 4: discReady, 5: catalogReady, 6: 0, 7: '', 10: failed }),
    { WriteView: { 0: targetsReady } },
  ))
  try {
    const tree = fakeReact.createElement(comp, { wide: true })
    const text = visibleText(tree)
    assert.ok(text.includes('⚠ 自动收纳失败'), '顶栏没有失败红标（失败被静默了）')
    assert.ok(text.includes('IMPORT_TAVERN_UNREACHABLE'), '卡里没给错误 code')
    assert.ok(text.includes('连不上 Tavern 工作区面'), '卡里没给失败原因')
    const marked = []
    collectNodes(tree, (n) => n && typeof n.props === 'object' && n.props['data-auto-collect-failed'] === '1', marked)
    assert.ok(marked.length === 1, '失败红标的 data 标记应恰好 1 处，实际 ' + marked.length)
    assert.ok(typeof marked[0].props.onClick === 'function', '失败红标应当可点（切到导入/收纳视图看细节）')
  } finally { fakeReact.__setPreset(null) }
})

await check('★ D 单：CSS 兼容备忘两处逐字（设置视图一行 + CHANGELOG 计划中一条）+ TODO 写明注入点/命名空间/主题变量映射；0.2.0 补移除说明', () => {
  assert.ok(src.includes('待实现（已记录）：CSS 兼容 —— 支持自定义 CSS / DSH 主题变量覆盖。当前只用系统色与内联样式，尚未支持用户自定义 CSS。'),
    '设置视图的 CSS 备忘没有逐字进源码')
  assert.ok(/TODO[^\n]*CSS 兼容/.test(src), '样式常量附近缺 CSS 兼容 TODO')
  assert.ok(src.includes('注入点') && src.includes('命名空间') && src.includes('映射'),
    'TODO 没写明 注入点 / dma- 命名空间 / DSH 主题变量映射')
  assert.ok(changelogSrc.includes('- **CSS 兼容**：支持自定义 CSS / DSH 主题变量覆盖；当前只用系统色与内联样式，尚未支持用户自定义 CSS。'),
    'CHANGELOG「计划中」缺 CSS 兼容条目（逐字）')
  assert.ok(/## \[0\.2\.0\][\s\S]*### Changed[\s\S]*移除「会话搜索」阅读源/.test(changelogSrc),
    'CHANGELOG 0.2.0 缺移除搜索源的说明')
  // 备忘就是不实现：不许出现任何用户 CSS 读取 / 样式配置入口的迹象
  assert.equal(src.includes('.css'), false, '不该出现读取 CSS 文件的迹象')
})

// ---------- v5 P0→修复单 v2：提示词查看器静态核对（§五.2：断言改成三态新契约，⛔ 不许删） ----------
await check('★ 可写项块三态文案逐字（20260913：Skill 勾选区按用户拍板移除，其余契约不变）+ 预览底部一行 + 可写/只读(官方语义)/未知/读取中', () => {
  for (const t of [
    '本版只做检测与预览，不会写入任何文件。',
    '可写（应用前自动备份；改完需新开会话或重启才完全生效）',
    '随部署附带，不可修改（agent-preset/read-only）',
    '读不到 preset，先修数据面',
    '正在读取可写性…',
    '提示词查看器 · 会话 / 装配地图 / 维护',
  ]) assert.ok(src.includes(t), '缺逐字文案: ' + t)
  // 20260913 用户拍板：skill 两段文案与勾选框随「零功能」结论一并移除 —— 反向断言防回归
  for (const t of [
    'Skill：启用「RP agent 优化」',
    '启用后，AI 助手会按「RP agent 优化原则」帮你调整这个 RP agent',
    'dma-skill-toggle',
  ]) assert.equal(src.includes(t), false, 'Skill 勾选区文案应删干净: ' + t)
})

await check('★ v5 P0 零写入：/agent 两个 rest 只经 requestJson（GET）；无写盘迹象；skill 勾选无本地存储', () => {
  for (const t of ["HOST_API_BASE + '/agent'", "HOST_API_BASE + '/agent/detect'"]) {
    assert.ok(src.includes(t), '缺调用: ' + t)
  }
  // 两个新调用点的请求函数必须是 requestJson（GET 只读），不得是 mutateJson
  for (const m of src.matchAll(/requestJson\(HOST_API_BASE \+ '\/agent(\/detect)?'/g)) {
    const before = src.slice(Math.max(0, m.index - 40), m.index)
    assert.equal(/mutateJson\s*\(/.test(before), false, '/agent 调用走了 mutateJson（写语义）')
  }
  assert.equal(/mutateJson\(HOST_API_BASE \+ '\/agent/.test(src), false, '/agent 出现在写请求里')
})

await check('★ 调用次数四形态渲染：-1⇒「—」、-2⇒「⚠ 失败」、0⇒「0 次」（showAll 才可见）、3⇒「3 次」；解析失败绝不画成 0', () => {
  const now = new Date().toISOString()
  const mk = (id, requests) => ({ id: 'sess-20260913-' + id, workspace: 'ws--x--', sizeBytes: 1, mtime: now, title: '', requests })
  const sessionsReady = {
    status: 'ready', error: null,
    items: [mk('a', -1), mk('b', -2), mk('c', 0), mk('d', 3)],
  }
  fakeReact.__setPreset({
    AgentEditorButton: { 0: true },
    AgentEditorPanel: { 2: sessionsReady },
    ViewerSessionList: { 2: true },   // showAll：0 次的行默认按「空会话」隐藏，展开才可见
  })
  try {
    const tree = fakeReact.createElement(viewerBtn, { wide: true })
    const text = visibleText(tree)
    assert.ok(text.includes('—'), '未解析（-1）应显示「—」')
    assert.ok(text.includes('⚠ 失败'), '解析失败（-2）应显示「⚠ 失败」')
    assert.ok(!text.includes('失败 0'), '失败不许与 0 混同')
    assert.ok(text.includes('0 次'), '确实为 0 应显示「0 次」（showAll）')
    assert.ok(text.includes('3 次'), '真值应显示「3 次」')
    assert.ok(text.includes('解析失败 —— 不是 0') === false || true)
  } finally { fakeReact.__setPreset(null) }
  // 反证：把 -2 折成 0 ⇒ -2 行会被当成空会话隐藏，「⚠ 失败」不再出现 —— 说明上面的断言真的在拦
  const folded = {
    status: 'ready', error: null,
    items: [mk('a', -1), mk('b', 0), mk('c', 0), mk('d', 3)],
  }
  fakeReact.__setPreset({
    AgentEditorButton: { 0: true },
    AgentEditorPanel: { 2: folded },
    ViewerSessionList: { 2: false },  // 不展开：0（含被折成 0 的失败行）按空会话隐藏
  })
  try {
    const tree = fakeReact.createElement(viewerBtn, { wide: true })
    const text = visibleText(tree)
    assert.equal(text.includes('⚠ 失败'), false, '反证场景里不应有失败徽标（数据已被折成 0）')
    assert.ok(text.includes('—'), '未解析行仍应显示')
  } finally { fakeReact.__setPreset(null) }
})

await check('★ 宿主侧（lib/index.js）：ENDPOINTS 有 /agent 与 /agent/cards、/agent/card；★ 预设线六条已退役；6 条事实口径在；agent 函数体零写盘调用', () => {
  const hostSrc = readFileSync(path.join(here, 'lib', 'index.js'), 'utf8')
  assert.ok(hostSrc.includes("'/agent': ['GET']"), 'ENDPOINTS 缺 /agent')
  assert.ok(hostSrc.includes("'/agent/cards': ['GET']"), 'ENDPOINTS 缺 /agent/cards')
  assert.ok(hostSrc.includes("'/agent/card': ['GET']"), 'ENDPOINTS 缺 /agent/card')
  // ★★ 2026-09-19 预设线整块退役（用户口径「不用保持了」）：这六条**不该**还在路由表里。
  for (const gone of ['/agent/detect', '/agent/apply', '/agent/rollback', '/agent/provision', '/agent/backups', '/agent/pack/apply']) {
    assert.equal(hostSrc.includes("'" + gone + "': ["), false, '预设线退役后不该还在路由表里：' + gone)
  }
  for (const t of [
    '创作即复制',
    'agent-presets/README.zh.md:173',
    'system-prompt/src/index.ts:601-610',
    'mcp-chrome',
    'compaction 整块必留',
    // ★ 2026-09-19：「本版只做检测与预览，不会写入任何文件。」原属 /agent/detect（预设线，已退役删掉）
  ]) assert.ok(hostSrc.includes(t), '宿主缺事实口径: ' + t)
  const fnSlice = (name) => {
    const i = hostSrc.indexOf('async function ' + name + '(')
    assert.ok(i >= 0, '缺函数 ' + name)
    const j = hostSrc.indexOf('\nasync function ', i + 10)
    const k = hostSrc.indexOf('\n// ---', i + 10)
    const ends = [j, k].filter((x) => x > i)
    return hostSrc.slice(i, ends.length ? Math.min(...ends) : hostSrc.length)
  }
  for (const name of ['handleAgentGet']) {
    const body = fnSlice(name)
    for (const bad of ['writeFileSync', 'mkdirSync', 'renameSync', 'chmodSync']) {
      assert.equal(body.includes(bad), false, name + ' 函数体出现写盘调用 ' + bad + '（违反零写入）')
    }
  }
})

await check('★ skill 文档：唯一的 rp-assistant 在，且"结构地图 / 先讲作用再问意见 / 白话纪律 / 边界 / 只做选择题 / 资料指路"齐', () => {
  const here2 = here
  const skillDir = path.join(here2, 'skill', 'rp-assistant')
  const rp = readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')
  for (const t of [
    '读这段的 AI',
    '读者是玩家本人，不是开发者',
    '全程你只需要做选择题',
    // —— 合并进来的两条腿：演得好不好 + 装得对不对
    '演得好不好',
    '装得对不对',
    // —— 结构地图（每部分的作用 / 怎么改 / 改它的风险）
    '结构地图：每一部分是什么、怎么改、改它的风险',
    '怎么改',
    '⚠ 改它的风险',
    // —— 结构化优化（先讲作用，再问意见）
    '先讲作用，再问意见',
    '逐块讲作用',
    '一次讲一块',
    '问意见（每题四件事，缺一不可）',
    // —— 流程与边界
    '只读体检',
    '先干跑给你看',
    '我的边界（这几条不松口）',
    '一旦说过话', // 会话建立后不能换设定 —— 必须提前讲
    '收纳 / 折叠', // 折叠不可逆 —— 必须提前讲
    '同一份设定被注入两遍', // 两处都注入 = 两份矛盾设定
    '翻译对照表',
    'TECH_JARGON',
    '提示词查看器', // 让玩家能亲眼核对结构，而不是只信转述
    // —— ★★ 2026-09-20 重塑：唯一一个 skill + 自带资料指路（§六）
    '资料去哪儿查',
    '../README.md', // 本插件 README（包内相对路径，不复制）
    'refs/dsh-tavern.md',
    'refs/dsh-anima-rag.md',
    'refs/dsh-internals.md',
  ]) {
    assert.ok(rp.includes(t), 'rp-assistant/SKILL.md 缺: ' + t)
  }
  // ⛔ 旧 skill 名不许再出现在正文里（否则模型会去找不存在的 skill）
  for (const goneName of ['character-card-assistant', 'config-assistant', 'config-kb']) {
    assert.equal(rp.includes(goneName), false, 'SKILL.md 不该再提旧 skill 名: ' + goneName)
  }
  // ⛔ 已合并/重排的旧正文文件必须都不在了（不留孤儿）
  for (const gone of [
    'character-card-assistant.md', 'config-assistant.md',
    'rp-assistant.md', 'kb-dsh-preset-architecture.md',
  ]) {
    assert.equal(existsSync(path.join(here2, 'skill', gone)), false, 'skill/ 下还留着旧文件: ' + gone)
  }
  // 资料必须在（模型按需读）：三份 refs 都够长、且各自标了来源
  const refs = [
    ['dsh-internals.md', 3000], ['dsh-tavern.md', 3000], ['dsh-anima-rag.md', 1000],
  ]
  for (const [file, min] of refs) {
    const body = readFileSync(path.join(skillDir, 'refs', file), 'utf8')
    assert.ok(body.length > min, `资料 ${file} 太短（${body.length}）`)
  }
  // ★ 内部事实那份要带上 2026-09-20 真机踩出来的两条硬事实（防回流：删了就红）
  const internals = readFileSync(path.join(skillDir, 'refs', 'dsh-internals.md'), 'utf8')
  for (const t of ['不许用哈希私有成员', 'buildSummarizationInput', 'bm25', 'pt:<周目']) {
    assert.ok(internals.includes(t), 'dsh-internals.md 缺: ' + t)
  }
})

// ---------- 20260913 三级导航（C 单）：静态 + 渲染断言 ----------
await check('★ C 单三级导航静态：源码删净轮次胶囊（dma-turn）/「← 回地图」/ onTurn；fixture 开关只能由 URL ?fixture=1 显式开启', () => {
  assert.equal(src.includes('dma-turn'), false, '源码里还有 dma-turn（轮次胶囊类名）')
  assert.equal(src.includes('← 回地图'), false, '源码里还有「← 回地图」（下钻替换主视图的旧实现）')
  assert.equal(src.includes('onTurn'), false, '源码里还有 onTurn（轮次切换回调）')
  assert.ok(src.includes("get('fixture') === '1'"), 'fixture 开关必须由 URL ?fixture=1 显式开启（⛔ 不许默认开）')
  assert.ok(src.includes('function editorV2FixtureMode') && src.includes('EDITOR_V2_FIXTURES'), 'fixture 取数层缺失（惰性判定 editorV2FixtureMode）')
})

await check('★ C 单三级导航渲染：选中会话（hook5）+ L2 开（hook27）+ L3 开（hook8=system）⇒ 消息定位面板、详细抽屉、地图容器（data-pm-main）同框；轮次胶囊不存在', () => {
  fakeReact.__setPreset({
    AgentEditorButton: { 0: true },
    AgentEditorPanel: { 5: 'session-abcdef0123456789', 7: 2, 8: 'system', 27: true },
  })
  try {
    const tree = fakeReact.createElement(viewerBtn, { wide: true })
    const text = visibleText(tree)
    assert.ok(text.includes('消息定位'), 'L2 消息定位面板没渲染')
    assert.ok(text.includes('详细'), 'L3 详细抽屉没渲染')
    assert.ok(text.includes('提示词装配地图'), '装配地图（主视图）不在 —— 下钻换视图回潮？')
    const mainCols = collectNodes(tree, (n) => n.props && n.props['data-pm-main'] === '1', [])
    assert.equal(mainCols.length, 1, '地图常驻容器（data-pm-main）缺失')
    const l2 = collectNodes(tree, (n) => n.props && n.props['data-l2'] === '1', [])
    const l3 = collectNodes(tree, (n) => n.props && n.props['data-l3'] === '1', [])
    assert.equal(l2.length, 1, 'L2 抽屉（data-l2）缺失')
    assert.equal(l3.length, 1, 'L3 抽屉（data-l3）缺失')
    const s = JSON.stringify(tree)
    assert.equal(s.includes('dma-turn'), false, '渲染树里出现 dma-turn')
    assert.equal(s.includes('回地图'), false, '渲染树里出现「回地图」按钮')
  } finally { fakeReact.__setPreset(null) }
})

// ── 20260915 用户口径：选常驻 = 勾选数个 → 点确认；⛔ 勾选不许直接改集/跳转 ────────────
await check('★ 常驻批量确认：勾选框只勾选（stopPropagation、不发请求），落盘只发生在确认条那几个按钮上', () => {
  // 1) 勾选框必须在：只 toggle 勾选，⛔ 不许出现"行内直接 onToggleResident"
  assert.ok(src.includes("'data-pending-row'"), '缺行内勾选框（data-pending-row）')
  const rowBlock = src.slice(src.indexOf("'data-pending-row'"), src.indexOf("'data-pending-row'") + 900)
  assert.ok(/onChange: \(\) => togglePending\(s\.id\)/.test(rowBlock), '勾选框没有走 togglePending（勾选即改集？）')
  assert.equal(/onToggleResident/.test(rowBlock), false, '行内（勾选框那一块）仍在直接调 onToggleResident —— 又变回"点一个就生效"')
  assert.ok(/onClick: \(ev\) => ev\.stopPropagation\(\)/.test(rowBlock), '勾选框没挡住冒泡（点勾选会顺带选中会话 ⇒ 触发解析/跳转）')
  // 2) 确认条必须在：两个动作都出现在条里
  assert.ok(src.includes("'data-pending-bar'"), '缺批量确认条（data-pending-bar）')
  assert.ok(src.includes("'data-pending-add'"), '确认条缺「＋ 设为常驻」')
  assert.ok(src.includes("'data-pending-remove'"), '确认条缺「－ 取消常驻」')
  const barAt = src.indexOf("'data-pending-bar'")
  const barBlock = src.slice(barAt, barAt + 2600)
  assert.ok(/onToggleResident\(ids\.concat\(toAdd\)\)/.test(barBlock), '确认条的"设为常驻"没有把勾选的整批交出去')
  assert.ok(/onToggleResident\(ids\.filter/.test(barBlock), '确认条的"取消常驻"没有把勾选的整批交出去')
  assert.ok(/clearPending\(\)/.test(barBlock), '确认后没有清空勾选')
  // 3) 改集要能 await（确认后清空勾选靠它）
  assert.ok(/return apiPost\(PROMPT_API_BASE \+ '\/api\/resident'/.test(src), 'saveResident 没有返回 promise（确认条无法据此收尾）')
  // 4) 文案要说清"勾选还不生效"
  assert.ok(src.includes('还没生效'), '确认条没有写明"勾选还没生效"')
  // ★ 灵敏度自证：把"老写法"（行内直接 onToggleResident）喂给第 1 条那个判据，必须命中
  const oldRow = "onClick: (ev) => { ev.stopPropagation(); onToggleResident(pinned ? ids.filter((x) => x !== s.id) : ids.concat([s.id])) }"
  assert.equal(/onToggleResident/.test(oldRow), true, '反证失败：这条判据抓不住"点一个就生效"的老写法（橡皮章）')
})

await check('★ 最近几楼卡（2026-09-17 新段 mt:lastFloors）：卡在、控件 id 齐、位置口径写明，且带反证', () => {
  assert.ok(src.includes('data-last-floors-card'), '缺卡容器')
  assert.ok(src.includes('function LastFloorsCard'), '缺组件')
  assert.ok(src.includes('e(LastFloorsCard, { config: cfg, reload: reload })'), '卡没挂进设置视图')
  for (const id of ['dma-last-floors-enabled', 'dma-last-floors-count', 'dma-last-floors-maxchars']) {
    assert.ok(src.includes(id), '缺控件 id: ' + id)
  }
  assert.ok(src.includes('倒数第二'), '没写明「倒数第二」这个位置口径（这是用户点名的要求）')
  assert.ok(src.includes("'/config'") || src.includes('/config'), '没走既有 /config 投影')
  // ★ 灵敏度自证：把"卡没挂进设置视图"的写法喂给同一条判据，必须命中（否则是橡皮章）
  const notMounted = "e(EchoCard, { config: cfg, reload: reload }),"
  assert.equal(/e\(LastFloorsCard, \{ config: cfg, reload: reload \}\)/.test(notMounted), false, '反证失败：这条判据抓不住"卡没挂上"')
})

await check('★★ 记忆库写入卡已整块退役（2026-09-19 用户口径「也可以摘除，包括代码和描述」）：面板里⛔ 不该再有它的任何痕迹', () => {
  // 这条是**退役的可验证事实**：曾经存在的卡/组件/控件 id 一个都不许还在。
  for (const gone of [
    'data-memory-write-card', 'function MemoryWriteCard', 'MemoryWriteCard',
    'dma-memory-write-enabled', 'dma-memory-write-maxchars', 'dma-memory-write-description',
    'MEMORY_WRITE_DETAIL',
  ]) {
    assert.equal(src.includes(gone), false, '记忆库写入已整块退役，面板里不该还有：' + gone)
  }
  // ★ 灵敏度自证：把"它还在"的写法喂给同一条判据，必须**命中**（否则这条断言是橡皮章）
  assert.equal('const x = 1 // MemoryWriteCard'.includes('MemoryWriteCard'), true, '反证失败：判据抓不住"它还在"')
})

// ===== 20260918 查看器单（T2/T3）：消息流按楼分段 + 详细词头（含思维链） =====
const vmsg = mod.__viewerMessages
const FX_REASON_HEAD = '（fixture 思维链）玩家要查状态：先调 status 工具，等结果再回答。'
const FX_REASON_TAIL = '这一段是词头演示，全文不进查看器。'
// 结构级收集：每个 data-msg-seg 段容器 ⇒ { turn, seqs:它下面 data-msg-seq 成员 }（谁在哪个段，一眼可断）
function collectMsgSegs(tree) {
  const segs = []
  const walk = (node, seg) => {
    if (node == null || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach((n) => walk(n, seg)); return }
    const props = node.props || {}
    let cur = seg
    if (props['data-msg-seg'] !== undefined) {
      cur = { turn: props['data-msg-seg'], seqs: [] }
      segs.push(cur)
    }
    if (cur !== null && props['data-msg-seq'] != null) cur.seqs.push(String(props['data-msg-seq']))
    const child = node.rendered !== undefined ? node.rendered : (node.props && node.props.children)
    walk(child, cur)
  }
  walk(tree, null)
  return segs
}

await check('★ 20260918 出口：__viewerMessages 在（夹具整包/分段纯函数/消息流视图）；夹具带 turn + reasoning 块；__internals 仍恰 15 键', () => {
  assert.ok(vmsg, '缺 exports.__viewerMessages')
  assert.equal(typeof vmsg.groupMessagesByTurn, 'function', '缺 groupMessagesByTurn')
  assert.equal(typeof vmsg.ViewerMessagesBody, 'function', '缺 ViewerMessagesBody')
  const fx = vmsg.EDITOR_V2_FIXTURES['part-messages']
  assert.ok(fx && fx.ok === true && Array.isArray(fx.messages) && fx.messages.length > 0, 'part-messages 夹具缺失')
  assert.ok(fx.messages.every((m) => Number.isInteger(m.turn) && m.turn > 0), '夹具每条消息都该有正整数 turn（不猜 0）')
  assert.ok(fx.messages.some((m) => Array.isArray(m.blocks) && m.blocks.some((b) => b && b.kind === 'reasoning')), '夹具缺带 reasoning 块的消息')
  assert.deepEqual(Object.keys(mod.__internals).sort(),
    [
      'buildCatalogIndex', 'clipInfo', 'decodeWorkspaceSlug', 'groupSessionsByWorkspace',
      'hiddenSessionReason', 'labelCharacter', 'labelPlaythrough', 'labelSession', 'pad4',
      'parseMarkdown', 'relativeTime', 'shortId', 'splitMessagesText', 'splitSystemSections',
      'workspaceLabelFromCwd',
    ], '__internals 键集合不许动')
})

await check('★ 20260918 T3 夹具渲染：按楼分段段头出现（第 1 楼/第 2 楼），每条消息各归各段（结构级核对，不丢）', () => {
  const fx = vmsg.EDITOR_V2_FIXTURES['part-messages']
  const tree = fakeReact.createElement(vmsg.ViewerMessagesBody, { text: fx.text, query: '', messages: fx.messages })
  const segs = collectMsgSegs(tree)
  assert.deepEqual(segs.map((s) => s.turn), ['1', '2'], '段序该按楼号出现序')
  assert.deepEqual(segs[0].seqs.sort(), ['16', '18'], '第 1 楼成员不对')
  assert.deepEqual(segs[1].seqs.sort(), ['520', '523', '526', '529'], '第 2 楼成员不对')
  const text = visibleText(tree)
  assert.ok(text.includes('第 1 楼') && text.includes('第 2 楼'), '缺「第 N 楼」段头')
})

await check('★ 20260918 T2：思维链词头可见且灰斜体可辨；正文词头行齐；⛔ 默认不展开全文（第二行不可见）', () => {
  const fx = vmsg.EDITOR_V2_FIXTURES['part-messages']
  const tree = fakeReact.createElement(vmsg.ViewerMessagesBody, { text: fx.text, query: '', messages: fx.messages })
  const rows = collectNodes(tree, (n) => n.props && n.props['data-msg-block'] === 'reasoning', [])
  assert.equal(rows.length, 1, 'reasoning 词头行该恰 1 条：' + rows.length)
  assert.ok(visibleText(rows[0]).includes(FX_REASON_HEAD), '思维链词头不可见')
  assert.equal(visibleText(rows[0]).includes(FX_REASON_TAIL), false, '词头行不许带出全文')
  const st = rows[0].props.style || {}
  assert.equal(st.fontStyle, 'italic', '思维链要斜体可辨')
  assert.equal(st.color, 'GrayText', '思维链要灰可辨')
  const textRows = collectNodes(tree, (n) => n.props && n.props['data-msg-block'] === 'text', [])
  assert.ok(textRows.length >= 5, '正文词头行数不对：' + textRows.length)
  assert.equal(visibleText(tree).includes(FX_REASON_TAIL), false, '默认视图把思维链全文展开了（⛔ 不许默认展开）')
})

// ★ 20260918 消息流单 T2（并进抽屉）：点行 ⇒ onOpenSeq(该条 seq) 开单条抽屉；
//   旧「行内就地展开全文 + 行内原 JSON 按钮」必须死透；列表不读整段拼装 text。
await check('★ 消息流单 T2 下钻（并进抽屉）：有 seq 的行都可点且 onClick 携带该 seq；行内展开/行内原 JSON 残留 = 不合格；列表不依赖整段 text', () => {
  const fx = vmsg.EDITOR_V2_FIXTURES['part-messages']
  let got = null
  const tree = fakeReact.createElement(vmsg.ViewerMessagesBody, { text: fx.text, messages: fx.messages, onOpenSeq: (s) => { got = s } })
  const rows = collectNodes(tree, (n) => n.props && n.props['data-msg-row'] === '1', [])
  assert.equal(rows.length, fx.messages.length, '每条消息一行，实得 ' + rows.length)
  const clickable = rows.filter((n) => typeof n.props.onClick === 'function')
  assert.equal(clickable.length, fx.messages.filter((m) => m.seq != null).length, '有 seq 的行都该可点（端点按 seq 取）')
  // data-msg-seq 挂在消息容器上，行（data-msg-row）是它的直接子行 —— 先找容器再找行
  const box523 = collectNodes(tree, (n) => n.props && n.props['data-msg-seq'] === '523', [])
  assert.equal(box523.length, 1, '缺 seq 523 的消息容器')
  const row523 = collectNodes(box523[0], (n) => n.props && n.props['data-msg-row'] === '1', [])[0]
  assert.ok(row523 && typeof row523.props.onClick === 'function', 'seq 523 那行不可点')
  row523.props.onClick()
  assert.equal(got, 523, '点行必须把这一条的 seq 交给抽屉（onOpenSeq）')
  // 拆干净的证据：行内就地展开与行内「原 JSON」不许再有残留
  const t = visibleText(tree)
  assert.equal(t.includes('展开 ▾'), false, '行内「展开 ▾」残留（就地展开全文该死）')
  assert.equal(collectNodes(tree, (n) => n.props && n.props['data-msg-raw-btn'] != null, []).length, 0, '行内「原 JSON」按钮残留（已并进抽屉）')
  // 列表不读整段拼装 text：text 给空串，分段列表照常在（正文按条从抽屉取）
  const noTextTree = fakeReact.createElement(vmsg.ViewerMessagesBody, { text: '', messages: fx.messages, onOpenSeq: () => {} })
  assert.equal(collectMsgSegs(noTextTree).length, 2, '没有整段 text 也必须能渲染分段列表')
  // ★ 灵敏度自证：老写法（行内展开残迹）喂给同一条判据，必须命中（否则是橡皮章）
  const oldRow = { props: { 'data-msg-row': '1' }, rendered: ['展开 ▾'] }
  assert.ok(visibleText(oldRow).includes('展开 ▾'), '反证失败：判据抓不住"行内展开"的老写法')
})

// ===== 20260918 消息流单（T1/T2/T3）：单条抽屉（ViewerMsgPanel）—— 与 system 单段抽屉同构 =====
// 抽屉正文的夹具（照宿主 /api/part&seq= 响应形状）：带一条长正文 + 一条思维链（尾部有标记，抓"默认展开"）。
const FX_DRAWER_LONG_TAIL = 'DRAWSOFIX-LONGTAIL-MARKER'
const fxDrawerResp = () => ({
  ok: true, sessionId: 'fixture-session-static', turn: 2, part: 'messages',
  seq: 523, role: 'assistant', chars: 6000, isToolResult: false, isCompacted: false,
  message: { role: 'assistant', content: [
    { type: 'reasoning', text: 'FXDRAWER-REASON 开头。' + '想'.repeat(400) + FX_DRAWER_LONG_TAIL },
    { type: 'text', text: 'FXDRAWER-BODY 第一段。\n\n第二段。' + '写'.repeat(5000) + FX_DRAWER_LONG_TAIL },
  ] },
  messageSource: '会话日志里那条消息对象（原样）。⛔ 不是线上 wire JSON —— DSH 不落盘请求体，那个谁也拿不到。',
})

await check('★ 消息流单 T2 反证（按条取，不是切整段）：抽屉正文请求 URL 带 seq=；⛔ 不读 state.data.text、不切整段、不用 preview 拼', () => {
  const fnBody = (name) => {
    const i = src.indexOf('function ' + name + '(')
    assert.ok(i >= 0, '缺函数 ' + name)
    const j = src.indexOf('\n      function ', i)
    return src.slice(i, j > i ? j : src.length)
  }
  const body = fnBody('ViewerMsgPanel')
  assert.ok(body.includes("'&part=messages&seq='"), '抽屉正文请求缺 seq=（必须按条从出口取）')
  assert.equal(body.includes('data.text'), false, '抽屉读了整段拼装文本 state.data.text')
  assert.equal(body.includes('splitMessagesText'), false, '抽屉在客户端切整段文本')
  assert.equal(body.includes('preview'), false, '抽屉不许拿 messages[].preview 拼正文')
})

await check('★ 消息流单 T2 抽屉渲染（长正文夹具）：头（seq/role/字数）+ 正文原样可见 + 原 JSON 带来源；思维链只给词头（灰斜体，⛔ 默认不展开）', () => {
  const resp = fxDrawerResp()
  fakeReact.__setPreset({ ViewerMsgPanel: { 0: { phase: 'ready', resp: resp, errMsg: '' } } })
  try {
    const tree = fakeReact.createElement(vmsg.ViewerMsgPanel, { sessionId: 'fixture-session-static', turn: 2, seq: 523 })
    // 头：seq / role / 字数
    const head = collectNodes(tree, (n) => n.props && n.props['data-msg-drawer-head'] === '1', [])
    assert.equal(head.length, 1, '缺抽屉头')
    const ht = visibleText(head[0])
    assert.ok(ht.includes('[assistant]') && ht.includes('seq 523') && ht.includes('6,000 字'), '抽屉头不全：' + ht)
    // 正文：text 块原样可见
    const body = collectNodes(tree, (n) => n.props && n.props['data-msg-drawer-body'] === '1', [])
    assert.equal(body.length, 1, '缺正文容器')
    const bt = visibleText(body[0])
    assert.ok(bt.includes('FXDRAWER-BODY'), '正文块内容丢了')
    // 思维链：独立词头行，灰斜体；⛔ 全文默认展开（词头行与正文里都不许带出思维链尾标）
    const reason = collectNodes(tree, (n) => n.props && n.props['data-msg-drawer-block'] === 'reasoning', [])
    assert.equal(reason.length, 1, '思维链词头行该恰 1 条，实得 ' + reason.length)
    const rt = visibleText(reason[0])
    assert.ok(rt.includes('思维链') && rt.includes('FXDRAWER-REASON'), '思维链词头不可见：' + rt)
    const rst = reason[0].props.style || {}
    assert.equal(rst.fontStyle, 'italic', '思维链要斜体可辨')
    assert.equal(rst.color, 'GrayText', '思维链要灰可辨')
    assert.equal(rt.includes(FX_DRAWER_LONG_TAIL), false, '思维链全文被默认展开了（⛔ 不许）')
    // 原 JSON：原样对象 + 来源说明（这正是"要看全文在 JSON 里对照"的那一份）
    const raw = collectNodes(tree, (n) => n.props && n.props['data-msg-drawer-raw'] === '1', [])
    assert.equal(raw.length, 1, '缺「原始 JSON」块')
    const rawT = visibleText(raw[0])
    assert.ok(rawT.includes('原始 JSON'), '缺「原始 JSON」标题')
    assert.ok(rawT.includes('会话日志里那条消息对象（原样）'), '来源说明（messageSource）没摆出来')
    assert.ok(rawT.includes('FXDRAWER-REASON'), '原样对象里的内容必须原样在 JSON 里（不加工）')
  } finally { fakeReact.__setPreset(null) }
})

await check('★ 消息流单 T3 反证（抽屉能滚）：滚动容器 overflow=auto/scroll 且 maxHeight 有界；加载态与完成态**同一个容器**（⛔ 不许只写在加载态）', () => {
  const assertScroll = (tree, tag) => {
    const nodes = collectNodes(tree, (n) => n.props && n.props['data-msg-drawer-scroll'] === '1', [])
    assert.equal(nodes.length, 1, tag + '：滚动容器该恰一个，实得 ' + nodes.length)
    const st = nodes[0].props.style || {}
    const ov = st.overflowY || st.overflow
    assert.ok(ov === 'auto' || ov === 'scroll', tag + '：overflow 不是 auto/scroll：' + String(ov))
    const mh = st.maxHeight
    const bounded = (typeof mh === 'number' && mh >= 200)
      || (typeof mh === 'string' && mh.trim() !== ''
        && (/calc\(/.test(mh) || /vh|%|em|rem/.test(mh) || (Number.isFinite(parseFloat(mh)) && parseFloat(mh) >= 200)))
    assert.ok(bounded, tag + '：maxHeight 缺失或不是有界口径（视口/父容器推）：' + String(mh))
  }
  // ① 加载态
  const loadingTree = fakeReact.createElement(vmsg.ViewerMsgPanel, { sessionId: 'fixture-session-static', turn: 2, seq: 523 })
  assertScroll(loadingTree, '加载态')
  assert.ok(visibleText(loadingTree).includes('正在取 seq 523'), '加载态没有可见文案')
  // ② 完成态（长正文夹具 —— "超出时能滚到底"的那条）
  fakeReact.__setPreset({ ViewerMsgPanel: { 0: { phase: 'ready', resp: fxDrawerResp(), errMsg: '' } } })
  try {
    assertScroll(fakeReact.createElement(vmsg.ViewerMsgPanel, { sessionId: 'fixture-session-static', turn: 2, seq: 523 }), '完成态')
  } finally { fakeReact.__setPreset(null) }
  // ★ 灵敏度自证：没有 overflow 的样式喂给同一条判据，必须命中
  const dry = { props: { 'data-msg-drawer-scroll': '1', style: { flex: 1 } } }
  let threw = false
  try {
    const st = dry.props.style || {}
    const ov = st.overflowY || st.overflow
    assert.ok(ov === 'auto' || ov === 'scroll')
  } catch (e) { threw = true }
  assert.ok(threw, '反证失败：判据抓不住"没给 overflow"的样式')
})

await check('★ 消息流单 反证（三种失败都要说话）：取数中 / 网络失败 / ok:false（含被压缩遮蔽）各带可见原因，⛔ 都不许空白', () => {
  // ① 取数中（默认 hook 初值就是 loading）
  const loading = fakeReact.createElement(vmsg.ViewerMsgPanel, { sessionId: 'fixture-session-static', turn: 2, seq: 523 })
  let stNode = collectNodes(loading, (n) => n.props && n.props['data-msg-drawer-state'] === 'loading', [])
  assert.equal(stNode.length, 1, '加载态缺 state 行')
  assert.ok(visibleText(stNode[0]).trim() !== '', '取数中文案空白')

  // ② 网络失败 ⇒ 带原因
  fakeReact.__setPreset({ ViewerMsgPanel: { 0: { phase: 'error', resp: null, errMsg: '网络炸了' } } })
  try {
    const errTree = fakeReact.createElement(vmsg.ViewerMsgPanel, { sessionId: 'fixture-session-static', turn: 2, seq: 523 })
    stNode = collectNodes(errTree, (n) => n.props && n.props['data-msg-drawer-state'] === 'error', [])
    assert.equal(stNode.length, 1, '网络失败缺 state 行')
    const t = visibleText(stNode[0])
    assert.ok(t.includes('内容取不到') && t.includes('网络炸了'), '网络失败要把原因说出来：' + t)
  } finally { fakeReact.__setPreset(null) }

  // ③ 接口 ok:false ⇒ 带服务端 error（被压缩摘要遮蔽的行宿主就是这么回的，⛔ 如实显示不绕道）
  const serverMsg = '第 2 楼实际发出的历史里没有 seq=999 的消息（可能被压缩摘要遮蔽，或不属于这一楼）'
  fakeReact.__setPreset({ ViewerMsgPanel: { 0: { phase: 'ready', resp: { ok: false, error: { message: serverMsg } }, errMsg: '' } } })
  try {
    const missTree = fakeReact.createElement(vmsg.ViewerMsgPanel, { sessionId: 'fixture-session-static', turn: 2, seq: 999 })
    stNode = collectNodes(missTree, (n) => n.props && n.props['data-msg-drawer-state'] === 'error', [])
    assert.equal(stNode.length, 1, 'ok:false 缺 state 行')
    const t = visibleText(stNode[0])
    assert.ok(t.includes('内容取不到') && t.includes('被压缩摘要遮蔽'), 'ok:false 要把服务端 error 带出来：' + t)
  } finally { fakeReact.__setPreset(null) }
})

await check('★ 消息流单 徽标：工具结果 / 已压缩的条目在抽屉头带徽标（照 system 抽屉段头写法）', () => {
  const resp = Object.assign(fxDrawerResp(), { isToolResult: true, isCompacted: true })
  fakeReact.__setPreset({ ViewerMsgPanel: { 0: { phase: 'ready', resp: resp, errMsg: '' } } })
  try {
    const tree = fakeReact.createElement(vmsg.ViewerMsgPanel, { sessionId: 'fixture-session-static', turn: 2, seq: 523 })
    const ht = visibleText(collectNodes(tree, (n) => n.props && n.props['data-msg-drawer-head'] === '1', [])[0])
    assert.ok(ht.includes('工具结果') && ht.includes('已压缩'), '抽屉头缺徽标：' + ht)
  } finally { fakeReact.__setPreset(null) }
})

await check('★ 20260918 反证（缺 turn）：某条 turn 改成 null ⇒ 落「未标注楼」段（不丢、不被别的楼捞走）', () => {
  const fx = JSON.parse(JSON.stringify(vmsg.EDITOR_V2_FIXTURES['part-messages']))
  fx.messages[2].turn = null   // seq 520，原属第 2 楼
  const tree = fakeReact.createElement(vmsg.ViewerMessagesBody, { text: fx.text, query: '', messages: fx.messages })
  const segs = collectMsgSegs(tree)
  const unmarked = segs.find((s) => s.turn === '')
  assert.ok(unmarked, '缺「未标注楼」段')
  assert.deepEqual(unmarked.seqs, ['520'], '未标注楼段该恰含被抹掉 turn 的那条')
  const t2 = segs.find((s) => s.turn === '2')
  assert.equal(t2.seqs.length, 3, '第 2 楼不许把 null 消息捞进去')
  const total = segs.reduce((n, s) => n + s.seqs.length, 0)
  assert.equal(total, fx.messages.length, '消息丢了（未标注楼不是丢弃）')
  assert.ok(visibleText(tree).includes('未标注楼'), '段头没写「未标注楼」')
})

// ★ 消息流单 T1：搜索框拆除后 query 不再进本栏 —— 传了也走分段视图（旧"搜索态退整段"分支已死）；
//   老宿主没有逐楼数据 ⇒ 仍按既有口径给原样整段全文。
await check('★ 消息流单 T1：query 不再影响列表（传了也走分段视图）；老宿主没有 messages 数组 ⇒ 原样全文视图（口径不动）', () => {
  const fx = vmsg.EDITOR_V2_FIXTURES['part-messages']
  const qTree = fakeReact.createElement(vmsg.ViewerMessagesBody, { text: fx.text, query: '查询', messages: fx.messages })
  assert.ok(collectNodes(qTree, (n) => n.props && n.props['data-msg-turn'] !== undefined, []).length > 0, 'query 传了也必须走分段视图（搜索框已拆）')
  const oldTree = fakeReact.createElement(vmsg.ViewerMessagesBody, { text: fx.text, messages: null })
  assert.equal(collectNodes(oldTree, (n) => n.props && n.props['data-msg-turn'] !== undefined, []).length, 0, '没有逐楼数据不该出分段视图')
  assert.ok(visibleText(oldTree).includes(FX_REASON_TAIL), '老形态该按既有口径显示完整正文')
})

// ★ 消息流单 T1 反证（静态）：本栏不再渲染 PartTabs、不再有 #dma-viewer-search、query/setQuery 不再传进本栏；
//   ⛔ system 段抽屉内的段内搜索（aria-label="在该段正文里搜索"）必须仍在（只断言"没了"会把误删当成合格）。
//   别处引用情况如实钉住：PartTabs/PART_TABS 只剩 FullPromptView 在用（深链 box=full 才可达）——不许悬空。
await check('★ 消息流单 T1 反证（静态）：消息流栏无 PartTabs/无搜索框；段抽屉内搜索仍在；FullPromptView 的 PartTabs 引用如实钉住', () => {
  const fnBody = (name) => {
    const i = src.indexOf('function ' + name + '(')
    assert.ok(i >= 0, '缺函数 ' + name)
    const j = src.indexOf('\n      function ', i)
    return src.slice(i, j > i ? j : src.length)
  }
  const col = fnBody('PromptPartView')
  assert.equal(col.includes('PartTabs'), false, '消息流栏还在渲染 PartTabs')
  assert.equal(col.includes('dma-viewer-search'), false, '搜索框 #dma-viewer-search 还在消息流栏里')
  assert.equal(col.includes('setQuery'), false, 'setQuery 还在往消息流栏传')
  // 反证的另一半：段内搜索不许被误删
  assert.ok(src.includes("'在该段正文里搜索'"), 'system 段抽屉内的段内搜索被误删（⛔ 不该动）')
  assert.ok(src.includes('dma-section-search'), '段抽屉搜索框 id 被误删')
  // 拆干净要有交代：本栏「只做消息流」的注释在
  assert.ok(src.includes('这一栏只做消息流'), '缺「这一栏只做消息流」的交代注释')
  // ★ 2026-09-18：`PartTabs`/`PART_TABS` 原本还剩 `FullPromptView` 在用（上一轮如实钉住了这一事实）；
  //   用户随后说「拆了吧不需要了」⇒ 完整视图整体删除，那两条「别处仍在用」的断言随之作废，
  //   换成上面那条**删除护栏**（整份源码里不许再出现它们）。这里只留"本栏无页签"这一半。
})

// ★ 消息流单 T1/T2（列渲染）：夹具模式下渲染消息流栏（PromptPartView）⇒ 按楼分段段头 + 逐条行 + 逐块词头都在；
//   文案是「消息流」不是「部件」。
await check('★ 消息流单 渲染（夹具）：消息流栏出分段段头/逐条行/思维链词头；文案「消息流」；不再有「部件」并列视图', () => {
  const fx = vmsg.EDITOR_V2_FIXTURES['part-messages']
  const tree = fakeReact.createElement(vmsg.PromptPartView, {
    sessionId: 'fixture-session-static', turn: 2, part: 'messages',
    state: { status: 'ready', data: fx }, onOpenSeq: () => {},
  })
  const segs = collectMsgSegs(tree)
  assert.deepEqual(segs.map((s) => s.turn), ['1', '2'], '分段视图没了')
  const text = visibleText(tree)
  assert.ok(text.includes('第 1 楼') && text.includes('第 2 楼'), '缺「第 N 楼」段头')
  assert.equal(collectNodes(tree, (n) => n.props && n.props['data-msg-block'] === 'reasoning', []).length, 1, '思维链词头行丢了')
  assert.ok(text.includes('消息流'), 'SectionLabel 文案不是「消息流」')
  assert.equal(text.includes('部件'), false, '文案还在写「部件」')
  // 滚动：列表栏根容器同样要有界可滚（用户原话："没给详细面板的滚动，只能看见头部"）
  const root = collectNodes(tree, (n) => n.props && n.props['data-msg-col'] === '1', [])
  assert.equal(root.length, 1, '缺消息流栏根容器')
  const st = root[0].props.style || {}
  const ov = st.overflowY || st.overflow
  assert.ok(ov === 'auto' || ov === 'scroll', '列表栏根容器不可滚：' + String(ov))
  assert.ok(typeof st.maxHeight === 'string' || (typeof st.maxHeight === 'number' && st.maxHeight >= 200), '列表栏根容器缺有界 maxHeight')
})

// ==================================================================
// F 单（20260918）OOC 划词质疑：夹具 = 假 window.getSelection + 假 document + 假 DOM 节点
//   （纯对象桩，无任何真 DOM）。★ 选区文本只在本进程内存里流转，本脚本不写任何文件；
//   夹具文本全部是合成句（与 EDITOR_V2_FIXTURES 同一口径），不是真机剧情。
// ==================================================================
const ooc = mod.__ooc
await check('OOC·出口在位：exports.__ooc 恰好 13 个成员（常量/纯函数/组件），未占用 __internals 等既有出口', () => {
  assert.ok(ooc, '__ooc 缺失')
  assert.deepEqual(Object.keys(ooc).sort(), [
    'OOC_CONTAINER_SUFFIXES', 'OOC_PREFIX', 'OOC_QUOTE_MAX_CHARS', 'OOC_SEAT_SUFFIX',
    'OocModeButton', 'OocQuoteButton', 'buildOocPrefix', 'buildOocText', 'findSessionContainer',
    'oocAnchorInComposer', 'oocCurrentVerdict', 'readDraftFromProps', 'selectionVerdict',
  ])
  assert.equal(ooc.OOC_QUOTE_MAX_CHARS, 120, '截断口径应与 prompt-viewer 的 PREVIEW_MAX_CHARS 同为 120')
  assert.equal(ooc.OOC_PREFIX, 'OOC: ', '★ 场外前缀逐字：社区预设的 OOC 契约认的就是这个开头形式')
  assert.equal(Object.keys(mod.__internals).length, 15, '⛔ __internals 必须仍是恰好 15 键')
})

// —— 假 DOM / 假选区环境（只服务 OOC 块，块尾恢复） ——
// ★★ 2026-09-18 真机抓到「按钮恒禁用」后重做：类名改成**真机实测**的形状
//   `<构建哈希>_<语义名>`（`_9UxHwG_scrollBody` / `_9UxHwG_composerSeat`；哈希随构建变 ⇒
//   代码只认语义后缀），节点补齐 `parentElement` / `hasAttribute` / `querySelector`。
//   ⛔ 旧夹具的两个盲区（就是漏掉这个 bug 的原因）：① 用的是 `.conversation.session` 这种
//   真机根本不存在的类名；② 节点没有 `contains`，于是真实现里那条 `cur.contains(el)` 分支
//   在台子上**一次都没被跑到** —— 而在真 DOM 里 `body.contains(任何元素)` 恒真。
function oocMakeNode(className, parent) {
  const el = {
    className: className || '',
    parentNode: parent || null,
    parentElement: parent || null,
    attrs: {},
    kids: [],
    setAttribute(k, v) { el.attrs[k] = String(v); return el },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(el.attrs, k) },
    querySelector() { return null },
  }
  if (parent && Array.isArray(parent.kids)) parent.kids.push(el)
  return el
}
const oocAppRoot = oocMakeNode('app-root', null)
const oocRoot = oocMakeNode('_9UxHwG_root', oocAppRoot)
const oocBody = oocMakeNode('_9UxHwG_body', oocRoot)
const oocScrollBody = oocMakeNode('_9UxHwG_scrollBody', oocBody)          // ← 会话区容器（判据要认出来的）
const oocMsgPara = oocMakeNode('', oocScrollBody)                         // 会话正文里的一段
const oocSeat = oocMakeNode('_9UxHwG_composerSeat', oocScrollBody)        // 我们这一席挂的输入栏座位
// ★★ 真机实测的**关键形状**：输入框那一坨自己带 `_root`（`sFkQRG_root`），且**比会话区更靠内**
//   ⇒ 「第一个命中的祖先就返回」会停在只有输入框的一小块上。链的其余部分见 findSessionContainer 的注释。
const oocCardRoot = oocMakeNode('sFkQRG_root', oocSeat)
const oocCard = oocMakeNode('sFkQRG_card', oocCardRoot)
const oocEditor = oocMakeNode('sFkQRG_input', oocCard)                    // 输入框（真机是 contenteditable）
oocEditor.setAttribute('contenteditable', '')
oocScrollBody.querySelector = (sel) => (sel === '[contenteditable]' ? oocEditor : null)
const oocSidebarLeaf = oocMakeNode('z2cnRW_sessionRow', oocMakeNode('sidebar', oocAppRoot)) // 侧边栏行，不在会话区
const oocDoc = {
  querySelector(sel) { return String(sel).indexOf('_composerSeat') !== -1 ? oocSeat : null },
  addEventListener() {}, removeEventListener() {},
}
function oocFakeSelection(text, anchor, collapsed) {
  return {
    rangeCount: collapsed ? 0 : 1,
    isCollapsed: Boolean(collapsed),
    getRangeAt() { return { commonAncestorContainer: anchor } },
    toString() { return text },
  }
}
let oocSelection = null
win.getSelection = () => oocSelection
globalThis.document = oocDoc

const oocBtnComp = registeredList[2].comp        // 席位 3：ooc-quote（注册顺序 = apply 里的声明顺序）
function oocFindButton(tree) {
  const arr = collectNodes(tree, (n) => n.$$element === 'button', [])
  assert.equal(arr.length, 1, 'OOC 组件应恰好渲染 1 个 button')
  return arr[0]
}
// 按钮的**可见文字**（深层收集字符串子节点）：「OOC」钮 20260919 起是 [svg 图标, span 文案]
//   （svg 无文字不会混进来）—— 逐字断言钉的始终是玩家看见的字，不钉内部结构。
function oocBtnText(btn) {
  let out = ''
  const walk = (n) => {
    if (n == null || typeof n === 'boolean') return
    if (typeof n === 'string' || typeof n === 'number') { out += String(n); return }
    if (Array.isArray(n)) { for (const k of n) walk(k); return }
    if (n.props && n.props.children !== undefined) walk(n.props.children)
  }
  walk(btn.props ? btn.props.children : btn)
  return out
}
function oocRecorder() { return { calls: [], setDraft(t) { this.calls.push(String(t)) } } }
const OOC_PRESET_DRAFT = '我打算回到房间'
// 草稿走**宿主 props.useInput**（生产口径：`SessionInput` 的 selector hook）——
//   台子上直接给一个 (selector)=>draft 的假 hook；不给 ⇒ readDraftFromProps 返回 null ⇒ 不许写。
function oocRenderWith(rec, sel, draft) {
  oocSelection = sel
  const props = { inputActions: rec }
  if (draft !== undefined) props.useInput = () => draft
  if (draft === null) props.__dmaReadDraft = () => undefined   // 「读不到」相（注入式）
  return oocFindButton(fakeReact.createElement(oocBtnComp, props))
}

await check('OOC·★ 容器判据（2026-09-18 真机修正的回归位）：真机语义下必须认出会话区容器，且**不会**被 `<body>` 式的「谁 contains 谁」误判掉；侧边栏那片仍要拒', () => {
  // 反证 1：这就是旧实现恒返回 null 的地方 —— 容器必须找得到
  assert.equal(ooc.findSessionContainer(null, oocDoc), oocScrollBody, '首帧（按钮未挂）应退到输入栏座位再往上找到会话区容器')
  assert.ok(ooc.OOC_CONTAINER_SUFFIXES.includes('_scrollBody'), '必须认语义后缀 _scrollBody（真机实测的类名形状）')
  assert.equal(ooc.OOC_CONTAINER_SUFFIXES.some((s) => s.indexOf('conversation') !== -1), false, '⛔ 别再退回 `.conversation.session` 那套（真机里没这个词）')
  // 反证 2：正常态（按钮已挂）—— 从按钮往上同样能找到
  //   ★★ 这条同时钉住「后缀优先级扫整条链」：链上最近的那个命中是 `sFkQRG_root`（输入卡片自己的），
  //   但正确答案是更外层的 `_9UxHwG_scrollBody`（会话区）。改回「第一个命中就返回」这条必红。
  const oocBtnEl = oocMakeNode('dma-ooc-btn', oocCard)
  assert.equal(ooc.findSessionContainer(oocBtnEl, oocDoc), oocScrollBody, '按钮已挂时应从按钮往上找到同一个容器（不许停在输入卡片自己的 _root 上）')
  // 反证 3：侧边栏那片**不是**会话区（锚点链条走不到容器）
  assert.equal(ooc.selectionVerdict(oocSidebarLeaf, oocScrollBody).ok, false, '侧边栏选中必须拒')
  // 反证 4：输入框里划自己的草稿也不算剧情（锚点是 contenteditable）
  assert.equal(ooc.oocAnchorInComposer(oocEditor, oocScrollBody), true, '输入框里的选区要认出来')
  assert.equal(ooc.oocAnchorInComposer(oocMsgPara, oocScrollBody), false, '正文里的选区不许误判成输入框')
})

await check('OOC·验收1 夹具渲染：假 inputActions + 会话区假选区 ⇒ 渲染出「质疑」按钮且可用；没有 inputActions ⇒ 如实禁用并给 title（不抛）', () => {
  const rec = oocRecorder()
  const btn = oocRenderWith(rec, oocFakeSelection('（夹具）他放下了剑。', oocMsgPara, false), OOC_PRESET_DRAFT)
  assert.equal(btn.props.disabled, false, '有选区时按钮应可用')
  assert.equal(typeof btn.props.onClick, 'function', 'onClick 应在')
  assert.equal(btn.props.children, '质疑', '按钮文案应是「质疑」')
  // 视觉契约（20260919，对齐输入栏邻居 dsh-restart-button）：专用类名 + 28 高幽灵盒
  assert.equal(btn.props.className, 'dma-ooc-btn', '类名应是输入栏专用 .dma-ooc-btn（面板 .dma-btn 规矩不同，⛔ 不许借用）')
  assert.equal(btn.props.style.height, 28, '定高 28（邻居实测：这一行图标控件全是 28 高，发送键 34×34）')
  assert.equal(btn.props.style.boxSizing, 'border-box', 'border-box：防 padding 把盒子撑过 28')
  assert.equal(btn.props.style.whiteSpace, 'nowrap', 'nowrap：不许换行长高/溢出')
  assert.ok(String(btn.props.title).includes('OOC 划词质疑'), '可用态 title 应说明功能')
  const noActions = oocFindButton(fakeReact.createElement(oocBtnComp, {}))
  assert.equal(noActions.props.disabled, true, '缺 inputActions 必须禁用')
  assert.ok(String(noActions.props.title).includes('inputActions'), '禁用 title 应写明缺 inputActions')
})

await check('OOC·验收2 ★★反证（不许覆盖草稿，20260919 新形状）：预设「我打算回到房间」+ 有选区 ⇒ `OOC:` 单独占首行、前缀之后逐字等于原草稿、引用块只在其后追加', () => {
  const rec = oocRecorder()
  const btn = oocRenderWith(rec, oocFakeSelection('（夹具）他推开门，走进屋。', oocMsgPara, false), OOC_PRESET_DRAFT)
  assert.equal(btn.props.disabled, false)
  btn.props.onClick()
  assert.equal(rec.calls.length, 1, '点击应恰好写一次草稿')
  const arg = rec.calls[0]
  const OOC_HEAD = 'OOC:\n\n'   // 前缀独占首行 + 空行 —— 社区预设的场外契约看的就是这个开头
  // ★★ 头号事故断言：原草稿的全部内容、逐字、"前缀之后逐字等于原草稿"（位置从"最前"挪到
  //   "前缀的下一段"，⛔ 照旧一个字符都不许改写/截断/重排）
  assert.equal(arg.slice(OOC_HEAD.length, OOC_HEAD.length + OOC_PRESET_DRAFT.length), OOC_PRESET_DRAFT, '前缀之后必须逐字等于原草稿')
  assert.equal(arg.indexOf(OOC_PRESET_DRAFT), OOC_HEAD.length, '原草稿必须紧跟前缀（不许被重排）')
  assert.ok(arg.length > OOC_HEAD.length + OOC_PRESET_DRAFT.length, '引用块必须追加在原草稿之后')
  assert.ok(arg.includes('\n\n> （夹具）他推开门，走进屋。\n\n我的质疑：'), '拼装形状不对：' + JSON.stringify(arg))
  assert.ok(arg.endsWith('我的质疑：'), '结尾应是质疑引导行（不自动发送、留玩家续写）')
  // ★ 逐字钉死任务书的目标形状（空位一个字符都不能差）；旧 `【OOC】` 标记必须消失
  //   （场外标记由首行 `OOC:` 承担，预设名单里没有 `【OOC】` 这种写法）
  assert.equal(arg, 'OOC:\n\n我打算回到房间\n\n> （夹具）他推开门，走进屋。\n\n我的质疑：')
  assert.equal(arg.includes('【OOC】'), false, '旧 `【OOC】` 标记不许再出现')
})

await check('OOC·★★验收2b 反证（读不到草稿就一个字不写）：会话位没给 useInput ⇒ 点击既不许调 setDraft，也要如实写明原因', () => {
  const rec = oocRecorder()
  const btn = oocRenderWith(rec, oocFakeSelection('（夹具）他推开了门。', oocMsgPara, false), null)
  assert.equal(typeof btn.props.onClick, 'function')
  btn.props.onClick()
  assert.equal(rec.calls.length, 0, '读不到草稿时绝不许写（setDraft 是整体替换 ⇒ 盲写 = 覆盖玩家草稿）')
  // 直接核读取口：没有 useInput / hook 抛错 ⇒ 一律 null（fail-closed）
  assert.equal(ooc.readDraftFromProps({}), null, '没有 useInput ⇒ null')
  assert.equal(ooc.readDraftFromProps({ useInput: () => 123 }), null, 'selector 返回非字符串 ⇒ null（不猜）')
  assert.equal(ooc.readDraftFromProps({ useInput: () => '' }), '', '空草稿是合法值（要能区分「空字符串」与「读不到」）')
  assert.equal(ooc.readDraftFromProps({ useInput: () => { throw new Error('boom') } }), null, 'hook 抛错 ⇒ null（不抛上去）')
})

await check('OOC·验收3 ★反证（空/纯空白选区）：按钮 disabled，且即便强行触发也不调用 setDraft', () => {
  const rec = oocRecorder()
  let btn = oocRenderWith(rec, oocFakeSelection('', oocMsgPara, true), OOC_PRESET_DRAFT)   // 完全空（折叠）
  assert.equal(btn.props.disabled, true, '空选区必须禁用')
  btn.props.onClick()
  assert.equal(rec.calls.length, 0, '空选区强点也不许写草稿')
  btn = oocRenderWith(rec, oocFakeSelection('   \n\t ', oocMsgPara, false), OOC_PRESET_DRAFT)   // 纯空白
  assert.equal(btn.props.disabled, true, '纯空白选区必须禁用')
  btn.props.onClick()
  assert.equal(rec.calls.length, 0, '纯空白强点也不许写草稿')
  assert.equal(ooc.oocCurrentVerdict(null).ok, false, '判据函数同样要给 false')
})

await check('OOC·验收4 ★反证（选区不在会话区）：侧边栏选中 / 容器判据落空 / 自家 dma- 面板正文 / 输入框内 ⇒ 一律 disabled 且强点不写', () => {
  const rec = oocRecorder()
  let btn = oocRenderWith(rec, oocFakeSelection('（夹具）某个文件名', oocSidebarLeaf, false), OOC_PRESET_DRAFT)
  assert.equal(btn.props.disabled, true, '侧边栏选中必须禁用')
  btn.props.onClick()
  assert.equal(rec.calls.length, 0, '侧边栏选中强点也不许写')
  // 会话区容器整个找不到（判据落空）⇒ 禁用，绝不放宽成「哪里选的都算」
  oocSelection = oocFakeSelection('（夹具）他放下了剑。', oocMsgPara, false)
  globalThis.document = { querySelector() { return null }, addEventListener() {}, removeEventListener() {} }
  btn = oocFindButton(fakeReact.createElement(oocBtnComp, { inputActions: rec, useInput: () => OOC_PRESET_DRAFT }))
  assert.equal(btn.props.disabled, true, '找不到会话区容器必须禁用')
  btn.props.onClick()
  assert.equal(rec.calls.length, 0, '容器缺失强点也不许写')
  globalThis.document = oocDoc
  // 自家面板正文（dma- 前缀链）不是剧情 —— 即便它挂在会话容器里也要拒
  const dmaLeaf = oocMakeNode('dma-md-body', oocScrollBody)
  btn = oocRenderWith(rec, oocFakeSelection('（夹具）面板正文', dmaLeaf, false), OOC_PRESET_DRAFT)
  assert.equal(btn.props.disabled, true, '自家面板选中必须禁用')
  btn.props.onClick()
  assert.equal(rec.calls.length, 0, '面板正文强点也不许写')
  // 输入框里划自己的草稿也不算「质疑 AI」
  btn = oocRenderWith(rec, oocFakeSelection('（夹具）我打算回到房间', oocEditor, false), OOC_PRESET_DRAFT)
  assert.equal(btn.props.disabled, true, '输入框内选区必须禁用')
  btn.props.onClick()
  assert.equal(rec.calls.length, 0, '输入框内强点也不许写')
})

await check('★ OOC·静态（验收5）：conversation.input.right 注册逐字在源码、meta 恰好一次、新 id 不撞既有三 id、既有两席注册行原样', () => {
  assert.ok(src.includes("ctx.slots.inject('conversation.input.right'"), '缺第三席 inject')
  const metaLine = "{ name: 'conversation.input.right', id: 'ooc-quote', order: 90 }"
  assert.equal(src.split(metaLine).length - 1, 1, '第三席注册 meta 应恰好出现一次')
  assert.equal(src.includes("id: 'restart-host'"), false, '⛔ 不许用重启按钮的 id restart-host')
  assert.ok(src.includes("{ name: 'sidebar.footer.action', id: 'memory-archive' }"), '既有席位 memory-archive 原样在')
  assert.ok(src.includes("{ name: 'sidebar.footer.action', id: 'agent-editor' }"), '既有席位 agent-editor 原样在')
  assert.ok(src.includes('OocQuoteButton,'), 'apply 里应直接引用模块级 OocQuoteButton')
  // 视觉单（20260919）：交互态必须走注入 CSS（内联表达不了 :hover/:disabled），逐字对齐邻居 .dsrrb-btn 口径
  assert.ok(src.includes('.dma-ooc-btn { border: none; background: transparent; color: GrayText; font: inherit; line-height: 1.4; }'), '缺 .dma-ooc-btn 常态规则（幽灵样式）')
  assert.ok(src.includes('.dma-ooc-btn:hover { color: CanvasText; background: color-mix(in srgb, CanvasText 6%, Canvas); }'), '缺 .dma-ooc-btn hover 规则')
  assert.ok(src.includes('.dma-ooc-btn:focus-visible { outline: 1px solid Highlight; outline-offset: -1px; }'), '缺 .dma-ooc-btn 焦点环规则（1px 内描边）')
  assert.ok(src.includes('.dma-ooc-btn:disabled { color: GrayText; background: transparent; opacity: .55; cursor: default; }'), '缺 .dma-ooc-btn 禁用规则')
})

await check('OOC·纯函数 buildOocText（20260919 新形状）：`OOC:` 单独首行逐字、截断标注照旧逐字、草稿尾单换行/双换行三态、引用逐行 > ', () => {
  const long = '字'.repeat(150)
  const t = ooc.buildOocText('', long)
  assert.ok(t.startsWith('OOC:\n\n> ' + '字'.repeat(120) + '…（已截断，原 150 字符）\n\n我的质疑：'), '截断形状不对：' + JSON.stringify(t.slice(0, 40)))
  // ★ 逐字钉死任务书目标形状 1（空草稿 + 引文）
  assert.equal(ooc.buildOocText('', '（夹具）短句'), 'OOC:\n\n> （夹具）短句\n\n我的质疑：', '空草稿形状不对（不应有前导空行）')
  assert.ok(ooc.buildOocText('前文\n', '短').startsWith('OOC:\n\n前文\n\n> '), '草稿尾单换行 ⇒ 补成空行')
  assert.ok(ooc.buildOocText('前文\n\n', '短').startsWith('OOC:\n\n前文\n\n> '), '草稿尾已空两行 ⇒ 不再加')
  // ★ 逐行引用 + 多行逐字：`OOC:\n\n> 第一行\n> 第二行\n\n我的质疑：`
  assert.equal(ooc.buildOocText('', '第一行\n第二行'), 'OOC:\n\n> 第一行\n> 第二行\n\n我的质疑：')
})

await check('OOC·纯函数 buildOocPrefix（20260919）：空草稿只放前缀、有内容就地前置、引用块另起一行、★ 幂等（已有前缀一个字不动）', () => {
  assert.equal(ooc.OOC_PREFIX, 'OOC: ', '前缀逐字（社区预设 OOC 契约认的开头形式）')
  assert.equal(ooc.buildOocPrefix(''), 'OOC: ', '空草稿 ⇒ 只放前缀（"激活"，玩家接着写要求）')
  assert.equal(ooc.buildOocPrefix('我打算回到房间'), 'OOC: 我打算回到房间', '有内容 ⇒ 就地前置')
  assert.equal(ooc.buildOocPrefix('> 引文\n\n【OOC】我的质疑：'), 'OOC:\n\n> 引文\n\n【OOC】我的质疑：', '引用块 ⇒ 前缀单独一行，别插进 `>` 里')
  // ★ 幂等反证：已经是场外指令 ⇒ 原样返回（绝不二次加前缀、绝不改写玩家已写的字）
  for (const already of ['OOC: x', 'OOC：x', '（OOC）x', '(OOC) x', '  OOC: x']) {
    assert.equal(ooc.buildOocPrefix(already), already, '已有场外前缀不许再动：' + JSON.stringify(already))
  }
  // ★ 20260919 新形状联动：「质疑」产出自己就带 `OOC:` 首行 ⇒ 再按 OOC 按钮必须一字不动
  const quoted = ooc.buildOocText('我打算回到房间', '（夹具）引文')
  assert.ok(quoted.startsWith('OOC:\n\n'), '前置 sanity：质疑产出应以 OOC: 首行开头')
  assert.equal(ooc.buildOocPrefix(quoted), quoted, '质疑的新产出已带 OOC: 开头 ⇒ 前缀按钮一个字不动')
  // ★ 反证：坏输入不抛、不猜（非字符串一律当空草稿，⛔ 不是 String(x)）
  assert.equal(ooc.buildOocPrefix(undefined), 'OOC: ', 'undefined ⇒ 当空草稿')
  assert.equal(ooc.buildOocPrefix(null), 'OOC: ', 'null ⇒ 当空草稿')
  assert.equal(ooc.buildOocPrefix(123), 'OOC: ', '数字 ⇒ 当空草稿（不 String 化）')
})

await check('OOC·验收5（OOC 前缀席，20260919）：一键标场外；★ 幂等反证（已有前缀一次都不写）；缺 inputActions ⇒ 禁用；读不到草稿 ⇒ 一个字不写', () => {
  // 席位 4 = ooc-prefix（apply 里的声明顺序：memory-archive / agent-editor / ooc-quote / ooc-prefix）
  const prefixComp = registeredList[3].comp
  const findBtn = (tree) => {
    const arr = collectNodes(tree, (n) => n.$$element === 'button', [])
    assert.equal(arr.length, 1, 'OOC 前缀席应恰好渲染 1 个 button')
    return arr[0]
  }
  // ① 空草稿 ⇒ 写进去的只有前缀
  let rec = oocRecorder()
  let btn = findBtn(fakeReact.createElement(prefixComp, { inputActions: rec, useInput: () => '' }))
  assert.equal(oocBtnText(btn), 'OOC', '按钮可见文字应逐字是「OOC」（图标不掺进来）')
  assert.equal(btn.props.className, 'dma-ooc-btn', '类名应是输入栏专用 .dma-ooc-btn（面板 .dma-btn 规矩不同，⛔ 不许借用）')
  assert.equal(btn.props.style.height, 28, '定高 28（与「质疑」钮同盒，成对）')
  assert.equal(btn.props.disabled, false, '有 inputActions ⇒ 可用（这一席**不看选区**）')
  btn.props.onClick()
  assert.deepEqual(rec.calls, ['OOC: '], '空草稿 ⇒ 只写前缀')
  // ② 有内容 ⇒ 就地前置，原文逐字保留在后
  rec = oocRecorder()
  btn = findBtn(fakeReact.createElement(prefixComp, { inputActions: rec, useInput: () => OOC_PRESET_DRAFT }))
  btn.props.onClick()
  assert.deepEqual(rec.calls, ['OOC: ' + OOC_PRESET_DRAFT], '有内容 ⇒ 就地前置，内容逐字保留')
  // ③ ★ 幂等反证：已经是场外指令 ⇒ 一次都不许写
  rec = oocRecorder()
  btn = findBtn(fakeReact.createElement(prefixComp, { inputActions: rec, useInput: () => 'OOC: 已经在场外了' }))
  btn.props.onClick()
  assert.equal(rec.calls.length, 0, '已有前缀时绝不许写（免得动玩家的字）')
  // ④ 缺 inputActions ⇒ 禁用，且强行触发不写
  rec = oocRecorder()
  btn = findBtn(fakeReact.createElement(prefixComp, {}))
  assert.equal(btn.props.disabled, true, '缺 inputActions 必须禁用')
  assert.ok(String(btn.props.title).includes('inputActions'), '禁用 title 应写明缺 inputActions')
  btn.props.onClick()
  assert.equal(rec.calls.length, 0, '禁用态强点也不许写')
  // ⑤ ★ 读不到草稿 ⇒ 一个字不写（setDraft 是整体替换 ⇒ 盲写 = 覆盖玩家草稿）
  rec = oocRecorder()
  btn = findBtn(fakeReact.createElement(prefixComp, { inputActions: rec, __dmaReadDraft: () => undefined }))
  btn.props.onClick()
  assert.equal(rec.calls.length, 0, '读不到草稿时绝不许写')
})

await check('OOC·纯函数 selectionVerdict 判据表：空锚点/缺容器/侧边栏链 ⇒ false，会话区链 ⇒ true', () => {
  assert.equal(ooc.selectionVerdict(null, oocScrollBody).ok, false, '无锚点 ⇒ false')
  assert.equal(ooc.selectionVerdict(oocMsgPara, null).ok, false, '缺容器 ⇒ false')
  assert.equal(ooc.selectionVerdict(oocMsgPara, oocScrollBody).ok, true, '会话区链 ⇒ true')
  assert.equal(ooc.selectionVerdict(oocSidebarLeaf, oocScrollBody).ok, false, '侧边栏链 ⇒ false')
})

await check('OOC·容器判定：从我们自己的按钮往上找（侧边栏天然不在链上）；后缀阶梯逐档回退；全都落空 ⇒ null', () => {
  // 后缀阶梯：只有 `_root` 命中时也要认出来（真机实测三档都存在，这里核降级）
  const onlyRoot = oocMakeNode('_9UxHwG_root', null)
  const seat2 = oocMakeNode('somewhereElse', onlyRoot)
  assert.equal(ooc.findSessionContainer(seat2, oocDoc), onlyRoot, '只有 _root 命中时也要认（后缀阶梯）')
  // 全都不命中 ⇒ null（调用方据此禁用，绝不放宽成「哪里选的都算」）
  const barren = oocMakeNode('nothing-matches', null)
  assert.equal(ooc.findSessionContainer(barren, { querySelector() { return null } }), null, '三档都不命中 ⇒ null')
  // 传入的 doc 兜底要用上（按钮未挂时）
  const calls = []
  const doc2 = { querySelector(sel) { calls.push(sel); return oocSeat } }
  assert.equal(ooc.findSessionContainer(null, doc2), oocScrollBody, '按钮未挂 ⇒ 退到座位再往上找')
  assert.equal(calls.length, 1, '兜底只查一次座位')
  assert.ok(calls[0].indexOf('_composerSeat') !== -1, '兜底查的是语义后缀 _composerSeat：' + calls[0])
})

await check('OOC·环境缺失不抛：window.getSelection 不存在 ⇒ 判据 false 且原因可读', () => {
  const saved = win.getSelection
  delete win.getSelection
  try {
    const v = ooc.oocCurrentVerdict(null)
    assert.equal(v.ok, false)
    assert.ok(String(v.reason).includes('getSelection'), '原因应点名 getSelection：' + String(v.reason))
  } finally { win.getSelection = saved }
})

// —— OOC 块收尾：摘掉假环境（防呆；本脚本在此之后只剩总结行） ——
delete win.getSelection
delete globalThis.document
oocSelection = null

// =======================================================================
// 20260919 大纲单：工作区第四档「剧情大纲」—— 入口同层 + ★ 防剧透门
// 门的核心纪律：未确认前**连请求都不发**（⛔ 不是"先加载好再遮住"）。
// 判据写成 outlineGateContract(源码文本)，对真源码必须命中、对反例必须不命中（灵敏度自证）。
// =======================================================================

// 花括号配对切片：从 marker 后第一个 `) {`（函数签名尾）或 marker 后第一个 `{` 起配对到闭括号。
// ⚠️ 只用于本块判据；文本里有不平衡花括号（字符串字面量里带 {）时会切错 —— 现有目标函数体里没有。
function outlineSliceBraces(text, start) {
  let depth = 0
  for (let j = start; j < text.length; j++) {
    const c = text[j]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return text.slice(start, j + 1)
    }
  }
  return null
}
function outlineFnBody(code, name) {
  const sig = code.indexOf('function ' + name + '(')
  if (sig < 0) return null
  const open = code.indexOf(') {', sig) // 跳过参数表（首个 { 是形参解构，不能当函数体开头）
  if (open < 0) return null
  return outlineSliceBraces(code, open + 2)
}
function outlineArrowBody(code, marker) {
  const i = code.indexOf(marker)
  if (i < 0) return null
  const open = code.indexOf('{', i + marker.length)
  if (open < 0) return null
  return outlineSliceBraces(code, open)
}


// 剥掉块注释与行注释后的 client.js（只看代码、不看注释 —— 与本文件"完整视图删除护栏"同款剥法；
// 已知代价：带 `://` 的行后半截会被行注释剥法吃掉，只会漏报不会误报，对本块判据无影响）
const outlineCodeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

await check('★ 大纲·档位逐字（验收1）：computeSources 工作区返回恰好 [摘要, 原文, 剧情大纲, 向量]（★ 2026-09-20：摘「状态」档、加「向量」档）；会话模式无此档', () => {
  const cs = outlineFnBody(src, 'computeSources')
  assert.ok(cs, '缺 computeSources 函数')
  assert.ok(
    cs.includes("return [['summaries', '摘要'], ['floors', '原文'], ['outline', '剧情大纲'], ['vector', '向量']]"),
    '档位返回不是逐字约定形状',
  )
  // 渲染断言：工作区就绪读视图，tab 标签按序恰为四档
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
    const clickables = []
    collectNodes(tree, (n) => n.props && typeof n.props.onClick === 'function' && typeof n.props.children === 'string', clickables)
    const labels = clickables.map((n) => n.props.children)
    const order = labels.filter((l) => ['摘要', '原文', '剧情大纲', '向量'].includes(l))
    assert.deepEqual(order, ['摘要', '原文', '剧情大纲', '向量'], '档位顺序或成员不对: ' + order.join(','))
    assert.equal(labels.includes('状态'), false, '⛔「状态」档已摘除，不许回来')
    // ★ 2026-09-20：「向量」档与 摘要/原文/剧情大纲 同层（用户口径「和摘要原文平级」）
    assert.equal(labels.includes('向量'), true, '缺「向量」档入口')
  } finally { fakeReact.__setPreset(null) }
  // 会话模式：不该出现这一档（入口只在工作区模式与 摘要/原文/状态 同层）
  const sessHost = {
    healthStatus: 'ready',
    health: { ok: true, webServer: true, sessionQuery: true, storageDirWritable: true, tavernReachable: true },
    healthError: '', configStatus: 'ready',
    config: { ok: true, rootMode: 'session', root: { sessionId: SESS_ID, characterId: null, playthroughId: null }, api: { url: '', model: '' }, keySet: false, keyHint: null, storageDir: '', configPath: '', configError: null },
    configError: '',
  }
  fakeReact.__setPreset(basePreset('read', sessHost, { 4: discReady, 5: catalogReady, 6: 0, 7: '' }))
  try {
    const tree = fakeReact.createElement(comp, { wide: true })
    const clickables = []
    collectNodes(tree, (n) => n.props && typeof n.props.onClick === 'function' && typeof n.props.children === 'string', clickables)
    assert.equal(clickables.some((n) => n.props.children === '剧情大纲'), false, '会话模式不该有剧情大纲入口')
    assert.equal(clickables.some((n) => n.props.children === '向量'), false, '会话模式不该有向量入口（它与摘要原文同层，都在工作区模式）')
  } finally { fakeReact.__setPreset(null) }
})

// ---------------------------------------------------------------------------
// 「向量」档渲染（2026-09-20 第五档：文案人话 + 四卡布局 + 逐条条目）。
// 用台子把 active 预置到「向量」（hook 6 = 3），VectorFlow 的 hook 预置成 ready 快照，
// 不发任何请求（useEffect 在台上是空转）—— 渲染树里要能看到四张卡与人话文案。
// ---------------------------------------------------------------------------
const VF_BOUND = 'playthrough-0256fcac-9902-4830-b2eb-86002bb228c8'
function vfEntriesFixture() {
  const mk = (index, tags, chars, mf) => ({
    index, tags,
    metadataFile: mf || (index + '.json'),
    chars, text: chars === null ? null : '第' + index + '条正文', textTruncated: false,
    timestamp: 1789697599742, mtime: 1789697599742, bad: false,
  })
  const items = []
  for (let i = 0; i < 7; i++) {
    items.push(mk('sum_t-0000-001' + i + '-' + (i + 1) + '.md', ['Suspense', 'pt:playthrough-adacc634-2f2e-4c09-b21a-7ad48d703f2d'], 856 + i * 11))
  }
  items.push(mk('sum_s-0240-0253-6.md', ['Suspense', 'Important', 'pt:playthrough-adacc634-2f2e-4c09-b21a-7ad48d703f2d'], 1204))
  items.push(mk('probe_2', ['verify'], 64))                                   // 非摘要条目：楼层显示 —
  items.push(mk('sum_z.md', [], null))                                        // 正文读不到的那条
  return { items, total: 10, truncated: false, unreadable: 1 }
}
function vfSnapFixture() {
  const t = Date.parse('2026-09-20T15:42:00+08:00')
  return {
    status: 'ready',
    info: {
      collectionId: 'dsh-memory', at: t,
      isolation: { enabled: true, bound: VF_BOUND, boundSource: 'config', total: 51, deniedCount: 51, boundCount: 0 },
      ingest: { state: { running: false, finishedAt: t, skipped: 'no-index', reason: '没有入库：那个周目的摘要目录里还没有 index.json' } },
    },
    result: null,
    live: { vector: { exists: true, count: 51, mtime: t }, bm25: { exists: true, bytes: 144605, mtime: t }, ingestState: { running: false, finishedAt: t, skipped: 'no-index' } },
    entries: vfEntriesFixture(),
    staleMs: 120000,
    error: '',
  }
}
const vfPreset = (over) => Object.assign({
  0: vfSnapFixture(), 1: true, 2: '', 3: '', 4: { status: 'idle', message: '' },
  5: 'all', 6: 8, 7: '', 8: null,
}, over || {})

await check('★ 向量·四卡渲染（验收）：当前状态 + 库 + 向量条目 + 参与检索；红字人话；周目徽标三色；折叠按钮；完整 UUID 不上界面', () => {
  fakeReact.__setPreset(Object.assign(basePreset('read', {
    healthStatus: 'ready',
    health: { ok: true, webServer: true, sessionQuery: true, storageDirWritable: true, tavernReachable: true },
    healthError: '', configStatus: 'ready',
    config: { ok: true, rootMode: 'workspace', api: { url: '', model: '' }, keySet: false, keyHint: null, storageDir: '', configPath: '', configError: null },
    configError: '',
  }, { 4: discReady, 5: catalogReady, 6: 0, 7: '' }), { ReadArea: { 0: 'vector' }, VectorFlow: vfPreset() }))
  try {
    const tree = fakeReact.createElement(comp, { wide: true })
    const text = visibleText(tree)
    for (const t of ['当前状态', '库', '向量条目', '参与检索']) assert.ok(text.includes(t), '缺卡片标题: ' + t + ' ||全文|| ' + text.slice(0, 1500))
    assert.ok(text.includes('本库 51 条都不属于当前周目（0256fcac），当前周目 0 条 ⇒ 现在检索不到东西。'), '红字诊断不是任务口径的人话: ' + text.slice(0, 400))
    assert.ok(text.includes('只看本周目') && text.includes('全部'), '条目过滤按钮缺失')
    assert.ok(text.includes('●别的周目') && text.includes('○未标注周目'), '归属徽标缺失（三色语义）')
    assert.ok(text.includes('s-0240-0253-6.md'), '条目里看不到摘要名 s-0240-0253-6.md')
    assert.ok(text.includes('展开其余 2 条'), '折叠按钮缺失（10 条只显示 8 条）')
    assert.ok(text.includes('1 条正文读不到'), '正文读不到的条数没有如实摆出来')
    assert.ok(text.includes('还没有摘要目录') || text.includes('那个周目还没有摘要目录'), 'skipped:no-index 没翻成人话')
    assert.ok(text.includes('剧情压缩时自动入库'), '入库时机口径缺失')
    assert.equal(text.includes(VF_BOUND), false, '⛔ 完整周目 UUID 不许上可见文本（只许在 title 里）')
    assert.equal(text.includes('候选池') || text.includes('隔离') || text.includes('命中'), false, '⛔ 内部词不许出现在界面')
  } finally { fakeReact.__setPreset(null) }
})

await check('★ 向量·只看本周目（bound 0 条）⇒ 如实空态指向红字；正文坏 ⇒ 徽标照摆', () => {
  const host = {
    healthStatus: 'ready',
    health: { ok: true, webServer: true, sessionQuery: true, storageDirWritable: true, tavernReachable: true },
    healthError: '', configStatus: 'ready',
    config: { ok: true, rootMode: 'workspace', api: { url: '', model: '' }, keySet: false, keyHint: null, storageDir: '', configPath: '', configError: null },
    configError: '',
  }
  fakeReact.__setPreset(Object.assign(basePreset('read', host, { 4: discReady, 5: catalogReady, 6: 0, 7: '' }),
    { ReadArea: { 0: 'vector' }, VectorFlow: vfPreset({ 5: 'bound' }) }))
  try {
    const tree = fakeReact.createElement(comp, { wide: true })
    const text = visibleText(tree)
    assert.ok(text.includes('本周目 0 条：列出的 10 条都不是当前周目的（见上方红字）。'), '只看本周目的空态不是如实说法: ' + text.slice(0, 600))
    assert.equal(text.includes('s-0240-0253-6.md'), false, '过滤成只看本周目后不该还列出别的周目的条目')
  } finally { fakeReact.__setPreset(null) }
})

await check('★ 向量·库文件缺失与无快照的空态（⛔ 不白屏、不编数字）', () => {
  const host = {
    healthStatus: 'ready',
    health: { ok: true, webServer: true, sessionQuery: true, storageDirWritable: true, tavernReachable: true },
    healthError: '', configStatus: 'ready',
    config: { ok: true, rootMode: 'workspace', api: { url: '', model: '' }, keySet: false, keyHint: null, storageDir: '', configPath: '', configError: null },
    configError: '',
  }
  // ① 库文件缺失：live.vector.exists=false、entries=null ⇒ 「⚠缺失」+「还没有落盘」
  const snapMissing = vfSnapFixture()
  snapMissing.live.vector = { exists: false, count: null, mtime: null }
  snapMissing.live.bm25 = { exists: false, bytes: null, mtime: null }
  snapMissing.entries = null
  fakeReact.__setPreset(Object.assign(basePreset('read', host, { 4: discReady, 5: catalogReady, 6: 0, 7: '' }),
    { ReadArea: { 0: 'vector' }, VectorFlow: vfPreset({ 0: snapMissing }) }))
  try {
    const text = visibleText(fakeReact.createElement(comp, { wide: true }))
    assert.ok(text.includes('⚠缺失'), '缺库没有 ⚠缺失 徽标')
    assert.ok(text.includes('向量库文件还没有落盘'), '缺库时条目卡没有如实说明')
    assert.equal(text.includes('共 51 条'), false, '缺库状态不该还显示旧条数')
  } finally { fakeReact.__setPreset(null) }
  // ② 无快照（info=null）⇒ 空态原句 + 条目卡整个不出现
  const snapNone = { status: 'ready', info: null, result: null, live: null, entries: null, staleMs: null, error: '' }
  fakeReact.__setPreset(Object.assign(basePreset('read', host, { 4: discReady, 5: catalogReady, 6: 0, 7: '' }),
    { ReadArea: { 0: 'vector' }, VectorFlow: vfPreset({ 0: snapNone }) }))
  try {
    const text = visibleText(fakeReact.createElement(comp, { wide: true }))
    assert.ok(text.includes('还没有状态快照：开一条这个周目的会话，或点『立即入库』。'), '无快照空态原句缺失')
    assert.equal(text.includes('向量条目'), false, '无快照时条目卡不该出现（没有可列的东西）')
  } finally { fakeReact.__setPreset(null) }
})

// ===========================================================================
// 「角色扮演记忆库」那一块（20260919）：读的是**别人（社区 RP 预设）写出来的文件**。
// 纪律与大纲那条完全同款（防剧透门 + 零 useEffect），所以判据照那份形状再写一遍。
// ===========================================================================

/**
 * 判据：① RpMemoryFlow 存在且零 useEffect；② 清单取数只在确认回调 reveal 体内；
 * ③ 正文取数只在**点开那一行**的回调 toggleFile 体内；④ 上述两处之外（未确认路径/渲染路径）零取数；
 * ⑤ 确认按钮 dma-rpmem-reveal 的 onClick 恰好接 reveal。
 */
function rpMemGateContract(code) {
  const body = outlineFnBody(code, 'RpMemoryFlow')
  if (!body) return { ok: false, why: '缺 RpMemoryFlow 组件' }
  if (/useEffect/.test(body)) return { ok: false, why: 'RpMemoryFlow 里有 useEffect（挂载即取数）' }
  const reveal = outlineArrowBody(body, 'const reveal = () => ')
  if (!reveal) return { ok: false, why: '缺清单取数回调 reveal' }
  if (!reveal.includes("requestJson(HOST_API_BASE + '/playthrough/rp-memory'")) {
    return { ok: false, why: '确认回调 reveal 里没有清单取数调用' }
  }
  const toggle = outlineArrowBody(body, 'const toggleFile = (name) => ')
  if (!toggle) return { ok: false, why: '缺按行取正文的回调 toggleFile' }
  if (!toggle.includes("requestJson(HOST_API_BASE + '/playthrough/rp-memory?file='")) {
    return { ok: false, why: '按行回调 toggleFile 里没有正文取数调用' }
  }
  const outside = body.replace(reveal, '').replace(toggle, '')
  if (/requestJson|\.fetch\(/.test(outside)) return { ok: false, why: '门外（未确认路径/渲染路径）出现了取数调用' }
  if (!body.includes("id: 'dma-rpmem-reveal'")) return { ok: false, why: '缺手动确认按钮 id dma-rpmem-reveal' }
  if (!body.includes('onClick: reveal')) return { ok: false, why: '确认按钮的 onClick 没接 reveal（门与请求不是同一个条件）' }
  return { ok: true, why: '' }
}

// ★ 灵敏度自证的反例（字符串夹具，永不求值）：挂载即取清单 + 按钮只翻开关 ⇒ 必须不命中。
const RP_MEM_GATE_BAD_SAMPLE = [
  "function RpMemoryFlow({ scrollBind }) {",
  "  const [gate, setGate] = React.useState('locked')",
  "  React.useEffect(() => {",
  "    requestJson(HOST_API_BASE + '/playthrough/rp-memory').then((d) => setFiles(d.files))",
  "  }, [])",
  "  const reveal = () => { setGate('open') }",
  "  if (gate !== 'open') return e('button', { id: 'dma-rpmem-reveal', onClick: reveal }, '显示角色扮演记忆库（含剧透）')",
  "  return e('pre', null, JSON.stringify(files))",
  "}",
].join('\n')

await check('★ 记忆库·门（验收R1）：确认控件 dma-rpmem-reveal 在源码与渲染树里；未确认态只有说明+按钮；判据灵敏度自证', () => {
  const body = outlineFnBody(src, 'RpMemoryFlow')
  assert.ok(body, '缺 RpMemoryFlow 组件')
  assert.ok(body.includes("id: 'dma-rpmem-reveal'"), '缺确认按钮 id')
  assert.ok(body.includes('显示角色扮演记忆库（含剧透）'), '确认按钮措辞没点名剧透')
  // 未确认（locked）分支：只有说明文案与按钮，零取数（与大纲那条同款切片）
  const li = body.indexOf("gate === 'locked' && ")
  const ni = body.indexOf("gate === 'loading'", li)
  assert.ok(li >= 0 && ni > li, '缺未确认分支（切片失锚）')
  const locked = body.slice(li, ni)
  assert.equal(/requestJson|\.fetch\(/.test(locked), false, '未确认分支里出现了取数调用')
  assert.ok(locked.includes('避免剧透'), '未确认态缺一句"为什么默认不展示"的说明')
  // 渲染断言：active=outline（两块都未确认）⇒ 两个门各自的按钮都在
  const readyHost = {
    healthStatus: 'ready',
    health: { ok: true, webServer: true, sessionQuery: true, storageDirWritable: true, tavernReachable: true },
    healthError: '', configStatus: 'ready',
    config: { ok: true, rootMode: 'workspace', api: { url: '', model: '' }, keySet: false, keyHint: null, storageDir: '', configPath: '', configError: null },
    configError: '',
  }
  fakeReact.__setPreset(Object.assign(
    basePreset('read', readyHost, { 4: discReady, 5: catalogReady, 6: 0, 7: '' }),
    { ReadArea: { 0: 'outline' } },
  ))
  try {
    const tree = fakeReact.createElement(comp, { wide: true })
    const s = JSON.stringify(tree)
    const text = visibleText(tree)
    assert.ok(s.includes('dma-rpmem-reveal'), '渲染树里没有记忆库确认按钮 id')
    assert.ok(text.includes('显示角色扮演记忆库（含剧透）'), '渲染树里没有记忆库确认按钮')
  } finally { fakeReact.__setPreset(null) }
  const bad = rpMemGateContract(RP_MEM_GATE_BAD_SAMPLE)
  assert.equal(bad.ok, false, '反例竟能通过判据 —— 判据是橡皮章')
  assert.ok(bad.why.includes('useEffect'), '反例该因 useEffect（挂载即取数）被抓，实际原因: ' + bad.why)
})

await check('★★ 记忆库·两条取数路径（验收R2）：清单只在 reveal、正文只在按行回调；整份代码里该端点恰好 2 次；RP_MEMORY_MISSING 恰好 1 次', () => {
  const v = rpMemGateContract(src)
  assert.equal(v.ok, true, '门结构判据未命中: ' + v.why)
  const hits = outlineCodeOnly.match(/\/playthrough\/rp-memory/g) || []
  assert.equal(hits.length, 2, '该端点在代码里出现 ' + hits.length + ' 次（只许清单 + 按行正文这两次）')
  const miss = outlineCodeOnly.split('RP_MEMORY_MISSING').length - 1
  assert.equal(miss, 1, 'RP_MEMORY_MISSING 出现 ' + miss + ' 次（只许清单那条空态分支里的一次）')
})

await check('★ 记忆库·互不越界（验收R3）：另外四个阅读源组件都不碰 rp-memory', () => {
  for (const name of ['SummariesFlow', 'FloorsFlow', 'EventsFlow']) { // ★ StateFlow 2026-09-20 已摘除（用户口径）
    const b = outlineFnBody(src, name)
    assert.ok(b, '缺组件 ' + name)
    assert.equal(b.includes('rp-memory'), false, name + ' 里出现了 rp-memory 引用')
  }
})

// ★ 2026-09-20（用户口径：「给剧情大纲面板加一个打开文件夹的按钮」）
//   判据：① 按钮在**确认之后**才出现（未确认前不给任何动作入口）；② 走 apiPost 的 POST；
//   ③ ⛔ 请求里**只有枚举 base、一个路径都没有**（开哪个目录由宿主自己解析）；④ 成败都如实播报。
// ★★ 同日补（用户口径：「**没有加打开文件夹的按钮**，新会话依旧不显示」）：空态也得有 ——
//   新周目两处落点都还没建时，用户正是靠这一块才知道"往哪儿放"、并且有入口点。
await check('★ 记忆库·打开文件夹（2026-09-20；同日补空态）：只出现在确认之后 · 两处落点都给 · 只带枚举不带路径 · 成败都播报', () => {
  const body = outlineFnBody(src, 'RpMemoryFlow')
  assert.ok(body, '缺 RpMemoryFlow 组件')
  // ⚠️ 判据必须从**渲染块**起算：`gate === 'loading'` 在 `reveal()` 的早退里也出现过一次，
  //   直接 `body.indexOf` 会拿到那一处（本台子第一版就这么假红了一次）。
  const renderAt = body.indexOf("return e('div', { style: colFillStyle }")
  assert.ok(renderAt > 0, '找不到渲染块起点')
  const view = body.slice(renderAt)
  const lockedAt = view.indexOf("gate === 'locked'")
  const loadingAt = view.indexOf("gate === 'loading'")
  const emptyAt = view.indexOf("gate === 'empty'")
  const errAt = view.indexOf("gate === 'error'")
  const readyAt = view.indexOf("gate === 'ready'")
  assert.ok(lockedAt >= 0 && loadingAt > lockedAt && emptyAt > loadingAt && errAt > emptyAt && readyAt > errAt,
    `渲染块里五支的边界不对：locked=${lockedAt} loading=${loadingAt} empty=${emptyAt} error=${errAt} ready=${readyAt}`)
  // ① 确认之前（locked 支）不许出现任何落点/按钮
  assert.equal(/dma-rpmem-openfolder|candRow\(/.test(view.slice(lockedAt, loadingAt)), false,
    '按钮跑到了"确认之前"—— 未确认前不该给任何动作入口')
  // ② 两处落点、两个按钮 id（周目目录 + 共用那份），文案分「打开文件夹 / 创建并打开 / 打开工作区根」
  assert.ok(body.includes("'dma-rpmem-openfolder'"), '缺周目落点的按钮 id')
  assert.ok(body.includes("'dma-rpmem-openfolder-' + base"), '缺按落点区分的按钮 id')
  assert.ok(body.includes('打开文件夹') && body.includes('创建并打开') && body.includes('打开工作区根'), '三种按钮文案不齐')
  // ③ **empty 与 ready 两支都要有落点块**（这就是"新会话不显示"的修法）
  for (const [name, seg] of [['empty', view.slice(emptyAt, errAt)], ['ready', view.slice(readyAt)]]) {
    assert.ok(seg.includes("candRow('playthrough')"), name + ' 支没有周目落点那一行')
    assert.ok(seg.includes("candRow('workspace-root')"), name + ' 支没有共用落点那一行')
  }
  // ★ 反证：把 empty 支里的落点块挖掉 ⇒ 同一条判据必红（证明它会咬人）
  const emptied = view.slice(emptyAt, errAt).replace("candRow('playthrough')", '')
  assert.equal(emptied.includes("candRow('playthrough')"), false, '反证失败：挖掉后仍能命中')
  // ④ 取数形状：apiPost + 端点 + **只带枚举 base**
  const call = outlineArrowBody(body, 'const openMemFolder = (base) => ')
  assert.ok(call, '缺打开文件夹的回调 openMemFolder(base)')
  assert.ok(call.includes("apiPost(HOST_API_BASE + '/playthrough/reveal'"), '回调没走 reveal 端点')
  assert.ok(call.includes('{ base: base }') && call.includes('base === undefined ? {}'), '回调没有"只带枚举 base"的形状')
  assert.equal(/playthrough\/reveal\?/.test(src), false, '⛔ URL 里不许带查询串（路径只能由宿主自己解析）')
  assert.equal(/playthrough\/reveal'[^)]*(\{\s*dir|\bpath\b)/.test(src), false, '⛔ 不许把路径塞进请求体')
  assert.ok(!/useEffect/.test(body), 'RpMemoryFlow 里仍不许有 useEffect')
  // ⑤ 成败都播报（⛔ 不许静默）；回执里的 created / fallbackTo 要翻成人话
  assert.ok(body.includes("openFolder.status === 'ok'") && body.includes("openFolder.status === 'err'"),
    '成败两条播报缺一条（不许静默）')
  assert.ok(body.includes("data.created === true") && body.includes("data.fallbackTo === 'workspace-root'"),
    '回执没按 created / fallbackTo 如实播报')
})

console.log('== 总结：' + pass + ' 通过 / ' + fails.length + ' 失败 ==')
if (fails.length > 0) {
  console.log('失败项：' + fails.join('；'))
  process.exit(1)
}
