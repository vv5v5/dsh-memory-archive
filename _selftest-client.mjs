#!/usr/bin/env node
/**
 * magictarven · lib/client.js 自检（任务书 §5，v4.1 A 单版）
 * 用法：node _selftest-client.mjs
 *
 * 第 1 步（node --check）在命令行单独跑；本脚本覆盖：
 *   第 2 步：假 window.__ModuleLoader__ 接住 factory + 假 react + 假 ctx 真调 apply()
 *            —— ★ 席位恰好 2 个（都是 sidebar.footer.action，id 集合 = {memory-archive,
 *               agent-editor}，v5 P0 契约）、settings.section 为零、exports.__internals 存在、
 *               真名解析纯函数三级回退、★ 工作区名解析 / 空会话过滤 / 相对时间 / system
 *               分段注释（§2.6 逐字）、面板各视图真渲染、模板卡片真渲染、Agent 编辑器面板真渲染。
 *   第 3 步：宿主 API 契约静态核对（根路径 + rest 全在表内）+ v4.1 静态核对
 *            （完整视图拼装/截断标注/分块渲染、12 条版块注释逐字在源码、双席位 id）。
 *   第 4 步（D 单）：parseMarkdown 纯函数逐项断言 + 健壮性（畸形输入不抛）+ 静态断言
 *            （无 dangerouslySetInnerHTML；md 只用于正文不用于 system/tools/完整/状态；
 *            源列表无「会话搜索」、仍有 摘要/原文/状态；「阅读源」标签不再出现；
 *            CSS 兼容备忘两处逐字）。
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

console.log('== _selftest-client.mjs · magictarven 客户端自检（v4） ==')

// ---------- 第 2 步：真加载 ----------
const win = { __ModuleLoader__: { load(def) { win.__def = def } } }
globalThis.window = win

const fakeReact = makeFakeReact()
let mod = null

await check('ModuleLoader.load 被接住（顶层 IIFE 真执行），id=magictarven，factory 是函数', () => {
  ;(0, eval)(src)
  assert.ok(win.__def, 'load() 未被调用 —— 顶层 IIFE 没执行')
  assert.equal(win.__def.id, 'magictarven')
  assert.equal(typeof win.__def.factory, 'function')
})

await check('factory(require) 真执行并返回 module.exports（只 require react）', () => {
  mod = win.__def.factory((name) => {
    assert.equal(name, 'react')
    return fakeReact
  })
  assert.ok(mod && typeof mod === 'object')
})

await check("exports.name === 'magictarven'；apply 是函数；inject 是数组", () => {
  assert.equal(mod.name, 'magictarven')
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

await check('★ D 单：apply(fakeCtx) 不抛；搜索类阅读源已删 ⇒ 不再取 sessions 能力，inject 恰好 ["slots"]', () => {
  mod.apply(ctxLike)
  assert.equal(gotNames.includes('sessions'), false, 'sessions 能力已随搜索类阅读源移除，不该再 ctx.get')
  assert.deepEqual(mod.inject, ['slots'])
})

await check('★ v5 P0 契约：恰好注册 2 个席位，id 集合 = {memory-archive, agent-editor}，都是 sidebar.footer.action', () => {
  assert.equal(registeredList.length, 2, '席位数不是 2：' + registeredList.length)
  const ids = registeredList.map((r) => r.meta.id).sort()
  assert.deepEqual(ids, ['agent-editor', 'memory-archive'])
  for (const r of registeredList) {
    assert.equal(r.meta.name, 'sidebar.footer.action', '席位 ' + r.meta.id + ' 不是 sidebar.footer.action')
  }
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

// ---------- v4.1 A 单：工作区名解析 / 空会话过滤 / 相对时间 / 分组 / system 分段注释 ----------
// ⚠️ 这里用**合成路径**（/home/dev/... 与 C:/work/...）而不是本机真实路径：
//    本文件是要提交进公开仓库的，写进真实路径会被上架闸门的泄露扫描命中（已经命中过一次）。
await check('★ workspaceLabelFromCwd：取最后一段（正/反斜杠都认；坏输入给空串）', () => {
  assert.equal(itn.workspaceLabelFromCwd('/home/dev/projects/dsh-tarven配置区'), 'dsh-tarven配置区')
  assert.equal(itn.workspaceLabelFromCwd('C:/work/我的项目'), '我的项目')
  assert.equal(itn.workspaceLabelFromCwd('C:\\work\\我的项目'), '我的项目')
  assert.equal(itn.workspaceLabelFromCwd(null), '')
  assert.equal(itn.workspaceLabelFromCwd(''), '')
  assert.equal(itn.workspaceLabelFromCwd(42), '')
})

await check('★ decodeWorkspaceSlug：--D-apps-dsh-tarven~914D~7F6E~533A-- 解码后含「配置区」（~XXXX 十六进制转义 → 字符）', () => {
  const dec = itn.decodeWorkspaceSlug('--D-apps-dsh-tarven~914D~7F6E~533A--')
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
    { id: 's1', workspace: '--D-apps-dsh-tarven~914D~7F6E~533A--', mtime: t2 },
    { id: 's2', workspace: '--D-apps-dsh-tarven~914D~7F6E~533A--', mtime: t1 },
    { id: 's3', workspace: '--ws-b--', mtime: t3 },
  ]
  const cwdOf = new Map([['s1', '/home/dev/projects/dsh-tarven配置区']])
  const groups = itn.groupSessionsByWorkspace(items, (id) => (cwdOf.has(id) ? cwdOf.get(id) : null))
  assert.equal(groups.length, 2)
  assert.equal(groups[0].slug, '--D-apps-dsh-tarven~914D~7F6E~533A--', '组间没按最近 mtime 倒序')
  assert.equal(groups[0].label, 'dsh-tarven配置区')
  assert.equal(groups[0].resolved, true)
  assert.deepEqual(groups[0].rows.map((r) => r.row.id), ['s2', 's1'], '组内没按 mtime 倒序')
  assert.equal(groups[1].label, 'ws-b')
  assert.equal(groups[1].resolved, false)
  const g2 = itn.groupSessionsByWorkspace(items, () => null)
  assert.equal(g2[0].resolved, false, 'cwd 全拿不到却标了已解析 —— 会假装真名')
  assert.ok(g2[0].label.includes('dsh-tarven'), 'slug 解码降级失效: ' + g2[0].label)
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
const viewerBtn = registeredList[1].comp     // 席位 2：agent-editor（Agent 编辑器，v5 P0 由 prompt-viewer 升格）
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

await check('★ v5 P0 独立入口 agent-editor：窄屏「词」、宽屏「Agent 编辑器」、title=Agent 编辑器 · 组成 / 每次请求 / 可写项', () => {
  const narrow = fakeReact.createElement(viewerBtn, { wide: false })
  const wide = fakeReact.createElement(viewerBtn, { wide: true })
  const sn = JSON.stringify(narrow)
  const sw = JSON.stringify(wide)
  assert.ok(sn.includes('词'), '窄态没有短字符「词」')
  assert.ok(sw.includes('Agent 编辑器'), '宽态没有「Agent 编辑器」')
  assert.ok(
    sn.includes('Agent 编辑器 · 组成 / 每次请求 / 可写项')
    && sw.includes('Agent 编辑器 · 组成 / 每次请求 / 可写项'),
    'title 属性缺失（新契约：Agent 编辑器 · 组成 / 每次请求 / 可写项）',
  )
})

await check('★ v5 P0 编辑器面板（独立浮层）：三块在（组成/每次请求/可写项）、顶栏三徽标、Skill 区、检测按钮、⛶/✕ 独立', () => {
  fakeReact.__setPreset({ AgentEditorButton: { 0: true } })
  try {
    const tree = fakeReact.createElement(viewerBtn, { wide: true })
    const s = JSON.stringify(tree)
    assert.ok(s.includes('Agent 编辑器'), '面板标题缺失')
    assert.ok(s.includes('当前 preset：'), '顶栏缺「当前 preset：」')
    assert.ok(s.includes('正在读取 preset…'), '组成块不在')
    assert.ok(s.includes('正在扫描会话列表…'), '每次请求块·左栏会话列表不在')
    assert.ok(s.includes('← 先选一个会话'), '每次请求块·中栏请求列表不在')
    assert.ok(s.includes('← 再选一次请求（第 N 次）'), '每次请求块·右栏部件视图不在')
    for (const t of ['system', 'tools', 'inventory', '消息流', '完整']) assert.ok(s.includes(t), '缺版块 tab: ' + t)
    assert.ok(s.includes('4 类 knob（当前值 · 一致性 · 写入入口）'), '可写项块不在')
    assert.ok(s.includes('Skill：启用「RP agent 优化」'), 'Skill 区开关不在')
    assert.ok(s.includes('生成 / 修复 RP agent'), '检测按钮不在')
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
    assert.ok(s.includes('当前根：影子 / 1周目'), '顶栏没有当前根人话名')
    for (const t of ['提示词', '⚙ 设置', '⛶', '✕']) assert.ok(s.includes(t), '顶栏缺按钮: ' + t)
    assert.equal(s.includes('根：会话') || s.includes('根：工作区'), false, '顶栏还残留常驻根模式单选')
    // D 单更新：「阅读源」标签已撤掉；源只剩 摘要/原文/状态（搜索类源已移除）——用渲染断言（tab 按钮标签）
    const srcTabs = []
    collectNodes(tree, (n) => n.props && typeof n.props.onClick === 'function' && typeof n.props.children === 'string', srcTabs)
    const srcLabels = srcTabs.map((n) => n.props.children)
    for (const t of ['摘要', '原文', '状态']) assert.ok(srcLabels.includes(t), '缺阅读源 tab: ' + t + '（实有: ' + srcLabels.join(',') + '）')
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
    assert.ok(s.includes('会话事件'), '会话模式缺「会话事件」源')
    assert.equal(s.includes('会话搜索'), false, '「会话搜索」源应已移除（D 单）')
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
    for (const t of ['摘要', '原文', '状态']) assert.ok(s.includes(t), '缺阅读源: ' + t)
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

await check('★ 压缩指令子页：解释逐字在、textarea(≥12行,初值=current)、按钮行齐、参考默认折叠、诚实提示在；展开见官方原文+出处', () => {
  fakeReact.__setPreset(templatesPreset('compaction', {
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

await check('★ 收纳占位子页：custom 徽标「自定义」+ 逐字解释 + 两条诚实提示 + 变量说明', () => {
  fakeReact.__setPreset(templatesPreset('placeholder', {
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
await check('★ API 根路径常量恰好是 /magictarven/api；Tavern 通路恰好是既定 URL', () => {
  const m = src.match(/const HOST_API_BASE = '([^']+)'/)
  assert.ok(m, '未找到 HOST_API_BASE 常量')
  assert.equal(m[1], '/magictarven/api')
  const m2 = src.match(/const TAVERN_API_BASE = '([^']+)'/)
  assert.ok(m2, '未找到 TAVERN_API_BASE 常量')
  assert.equal(m2[1], '/pmp-dsh-tavern/api/v2/workspace/files')
})

await check('★ 用到的宿主 rest 全在表内（含 /templates 与 v5 的 /agent·/agent/detect），且全部用到（prompt 数据面在另一条核对）', () => {
  const TABLE = [
    ['GET', '/config'],
    ['PUT', '/config'],
    ['POST', '/config/test'],
    ['GET', '/sessions'],
    ['GET', '/session/events'],
    ['GET', '/agent'],
    ['GET', '/agent/detect'],
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

await check('★ 提示词数据面在位：PROMPT_API_BASE=/magictarven/prompt，五个 rest 全用到', () => {
  const m = src.match(/const PROMPT_API_BASE = '([^']+)'/)
  assert.ok(m, '未找到 PROMPT_API_BASE 常量')
  assert.equal(m[1], '/magictarven/prompt')
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

// ---------- v4.1 A 单：静态核对 ----------
await check('★ v5 P0 双席位在源码里：memory-archive + agent-editor，都是 sidebar.footer.action 注册', () => {
  assert.ok(src.includes("{ name: 'sidebar.footer.action', id: 'memory-archive' }"), '缺 memory-archive 席位')
  assert.ok(src.includes("{ name: 'sidebar.footer.action', id: 'agent-editor' }"), '缺 agent-editor 席位')
  assert.equal(src.includes("id: 'prompt-viewer'"), false, '旧席位 prompt-viewer 应已改名 agent-editor')
})

await check('★ 完整视图：三个 /api/part 各取一次、复制全文、截断必须显式标注「已截断，原 N 字符」', () => {
  for (const t of ["'&part=system'", "'&part=tools'", "'&part=messages'", '复制全文', '已截断，原 ', 'clipInfo']) {
    assert.ok(src.includes(t), '缺: ' + t)
  }
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
    'L1 状态卡：由副 LLM 每轮记账的当前状态（数值/分组/到期），让模型不必从正文里重算。',
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

await check('★ D 单静态：无 dangerouslySetInnerHTML；md 只用于正文（摘要/原文/事件/messages 视图），system/tools/完整/状态 保持原样', () => {
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
  // ⛔ 原样侧：messages 的 md 只经 ViewerMessagesBody 这一个入口；system/tools/完整/状态 一律不用 md
  const part = fnBody('PromptPartView')
  assert.ok(part.includes('ViewerMessagesBody'), 'messages 视图应经 ViewerMessagesBody')
  assert.equal(part.includes('MarkdownBody'), false, 'PromptPartView 里不得直接用 MarkdownBody（只能经 messages 入口）')
  assert.equal(fnBody('FullPromptView').includes('MarkdownBody'), false, '完整视图是原样 prompt，不许 md 化')
  assert.equal(fnBody('FullPromptView').includes('ViewerMessagesBody'), false, '完整视图不许用 messages 的 md 入口')
  assert.equal(fnBody('StateFlow').includes('MarkdownBody'), false, '状态源是 JSON，保持等宽原样')
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
    for (const t of ['摘要', '原文', '状态']) assert.ok(text.includes(t), '缺阅读源: ' + t)
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

// ---------- v5 P0→修复单 v2：Agent 编辑器静态核对（§五.2：断言改成三态新契约，⛔ 不许删） ----------
await check('★ 可写项块三态文案逐字：Skill 两段（规格 §五）+ 「刷新后需重新勾选」+ 预览底部一行 + 可写/只读(官方语义)/未知/读取中', () => {
  for (const t of [
    '启用后，AI 助手会按「RP agent 优化原则」帮你调整这个 RP agent（只动由本插件生成、位于沙箱内的那个 preset）。',
    '风险提示：改动会写入你的 agent preset 文件（每次应用前会自动备份，可一键回滚）。未启用时本编辑器只读。',
    '勾选只保存在本界面（组件内 state，不落任何本地存储）；刷新后需重新勾选。',
    '本版只做检测与预览，不会写入任何文件。',
    '可写（应用前自动备份；改完需新开会话或重启才完全生效）',
    '随部署附带，不可修改（agent-preset/read-only）',
    '读不到 preset，先修数据面',
    '正在读取可写性…',
    'Agent 编辑器 · 组成 / 每次请求 / 可写项',
  ]) assert.ok(src.includes(t), '缺逐字文案: ' + t)
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

await check('★ 可写项块三态渲染（修复单 v2 §五.2）：读取中⇒禁用+如实理由；可写⇒三按钮启用；只读⇒禁用+官方语义；未知⇒禁用+可读理由；Skill 勾选框是 checkbox', () => {
  const collectBtns = (tree, pred, out) => collectNodes(tree, (n) => n.$$element === 'button' && n.props && pred(n), out)
  const agentReady = (writable) => ({
    status: 'ready',
    data: {
      preset: { id: writable == null ? null : 'roleplay', name: null, trust: writable == null ? null : (writable ? 'user' : 'deployment'), writable: writable == null ? null : writable },
      sections: [],
      compaction: {},
    },
  })
  // 态 1 · 读取中（默认 loading）：三按钮禁用，理由 = 正在读取可写性…（如实，无过期承诺）
  fakeReact.__setPreset({ AgentEditorButton: { 0: true } })
  try {
    const tree = fakeReact.createElement(viewerBtn, { wide: true })
    const disabled = []
    collectBtns(tree, (n) => n.props.disabled === true && n.props.title === '正在读取可写性…', disabled)
    assert.ok(disabled.length >= 3, '读取中态：禁用按钮（预览差异/应用/回滚）不足 3 个: ' + disabled.length)
    const boxes = []
    collectNodes(tree, (n) => n.$$element === 'input' && n.props && n.props.type === 'checkbox', boxes)
    assert.equal(boxes.length, 1, 'Skill 勾选框应恰好 1 个')
    assert.equal(boxes[0].props.checked, false, 'Skill 勾选默认应为关')
  } finally { fakeReact.__setPreset(null) }
  // 态 2 · 可写（preset.writable === true）⇒ 三按钮 disabled === false（P2 起的真实契约，必须断言到）
  fakeReact.__setPreset({ AgentEditorButton: { 0: true }, AgentEditorPanel: { 15: agentReady(true) } })
  try {
    const tree = fakeReact.createElement(viewerBtn, { wide: true })
    const enabled = []
    collectBtns(tree, (n) => !n.props.disabled && ['预览差异', '应用', '回滚'].includes(String(n.props.children)), enabled)
    assert.ok(enabled.length >= 3, '可写态：启用的三按钮（预览差异/应用/回滚）不足 3 个: ' + enabled.length)
  } finally { fakeReact.__setPreset(null) }
  // 态 3 · 只读（writable === false）⇒ 三按钮禁用 + 官方语义理由（agent-preset/read-only）
  fakeReact.__setPreset({ AgentEditorButton: { 0: true }, AgentEditorPanel: { 15: agentReady(false) } })
  try {
    const tree = fakeReact.createElement(viewerBtn, { wide: true })
    const disabled = []
    collectBtns(tree, (n) => n.props.disabled === true && n.props.title === '随部署附带，不可修改（agent-preset/read-only）', disabled)
    assert.ok(disabled.length >= 3, '只读态：禁用按钮不足 3 个: ' + disabled.length)
  } finally { fakeReact.__setPreset(null) }
  // 态 4 · 未知（读不到 preset）⇒ 三按钮禁用 + 可读理由（不猜）
  fakeReact.__setPreset({ AgentEditorButton: { 0: true }, AgentEditorPanel: { 15: agentReady(null) } })
  try {
    const tree = fakeReact.createElement(viewerBtn, { wide: true })
    const disabled = []
    collectBtns(tree, (n) => n.props.disabled === true && n.props.title === '读不到 preset，先修数据面', disabled)
    assert.ok(disabled.length >= 3, '未知态：禁用按钮不足 3 个: ' + disabled.length)
  } finally { fakeReact.__setPreset(null) }
})

await check('★ v5 P0 宿主侧（lib/index.js）：ENDPOINTS 恰好新增 /agent 与 /agent/detect 两条 GET；6 条事实口径在；agent 函数体零写盘调用', () => {
  const hostSrc = readFileSync(path.join(here, 'lib', 'index.js'), 'utf8')
  assert.ok(hostSrc.includes("'/agent': ['GET']"), 'ENDPOINTS 缺 /agent')
  assert.ok(hostSrc.includes("'/agent/detect': ['GET']"), 'ENDPOINTS 缺 /agent/detect')
  for (const t of [
    '创作即复制',
    'agent-presets/README.zh.md:173',
    'system-prompt/src/index.ts:601-610',
    'mcp-chrome',
    'compaction 整块必留',
    '本版只做检测与预览，不会写入任何文件。',
  ]) assert.ok(hostSrc.includes(t), '宿主缺 6 条事实口径: ' + t)
  const fnSlice = (name) => {
    const i = hostSrc.indexOf('async function ' + name + '(')
    assert.ok(i >= 0, '缺函数 ' + name)
    const j = hostSrc.indexOf('\nasync function ', i + 10)
    const k = hostSrc.indexOf('\n// ---', i + 10)
    const ends = [j, k].filter((x) => x > i)
    return hostSrc.slice(i, ends.length ? Math.min(...ends) : hostSrc.length)
  }
  for (const name of ['handleAgentGet', 'handleAgentDetect']) {
    const body = fnSlice(name)
    for (const bad of ['writeFileSync', 'mkdirSync', 'renameSync', 'chmodSync']) {
      assert.equal(body.includes(bad), false, name + ' 函数体出现写盘调用 ' + bad + '（违反零写入）')
    }
  }
})

await check('★ v5 P0 skill 文档：skill/RP-AGENT-OPTIMIZATION.md 存在，8 条原则齐全（每条带出处小节）', () => {
  const doc = readFileSync(path.join(here, 'skill', 'RP-AGENT-OPTIMIZATION.md'), 'utf8')
  for (const t of [
    '## 原则 1 · 注入只走「不写历史」的两条缝',
    '## 原则 2 · 压缩只在 `summarize()` 一个钩子上扩展；遮蔽必须精确覆盖',
    '## 原则 3 · 占位行必须带该段关键词',
    '## 原则 4 · 各段 order 的真实分布（不许另造）',
    '## 原则 5 · ★「可回捞」不等于「可回滚」',
    '## 原则 6 · ★ 不设 `persona.complete: true`',
    '## 原则 7 · ⛔ 不许删工具说明',
    '## 原则 8 · 改完的生效方式：`recompose`，拿不到就明说',
    "trust === 'user'",
    'agent-preset/read-only',
  ]) assert.ok(doc.includes(t), 'skill 文档缺: ' + t)
})

console.log('== 总结：' + pass + ' 通过 / ' + fails.length + ' 失败 ==')
if (fails.length > 0) {
  console.log('失败项：' + fails.join('；'))
  process.exit(1)
}
