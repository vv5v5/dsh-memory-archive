#!/usr/bin/env node
/**
 * dsh-memory-archive · 提示词装配地图自检（20260913 E 单）
 * 用法：node _selftest-prompt-map.mjs
 *
 * 照 _selftest-client.mjs 的既有方式：假 window.__ModuleLoader__ 接住 factory + 假 react，
 * 走纯新增的 exports.__promptMap 出口（⛔ 不碰 __internals——既有台子对它的键集合做了恰好
 * 15 个的 deepEqual 断言）。覆盖任务规格的 9 条：
 *   1. 组件能渲染（喂假数据不抛 + 数出三个框）
 *   2. ★三色分类正确（红/黄/蓝各≥1，且已知段没有错分）—— 实数写进报告
 *   3. ★★可变性标注（两轮中文本变了的段 ⇒ 每轮；没变且无已知类型 ⇒ 静态·实测；两轮拿不到 ⇒ 未知）
 *   4. ★三框都在（[system] / [tools] / [messages] 标题都渲染）
 *   5. ★悬停提示有内容（每块都有提示数据；红块提示含「影响所有/影响每一轮」后果文案）
 *   6. ★灰虚线不被说成不存在（缺 anima:memory ⇒ 该块标「未检出」，不是从图上消失）
 *   7. ★反证 A：tools 喂空数组 ⇒ [tools] 框仍在（内容「未检出」），不是整个框消失
 *   8. ★反证 B：把某块颜色故意喂错 ⇒ 第 2 条的断言会红（证明它不是橡皮图章）
 *   9. 确定性（同一份假数据渲染两次，元素结构一致）
 * 另加两条护栏：A. 面板集成真渲染（Agent 编辑器浮层里能看到装配地图、空闲态不抛）；
 *              B. PromptMap 取数 effect 确实挂在 [sessionId, turn] 上（选中态变了会重取）。
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

// ---------- 假 react（与 _selftest-client.mjs 同一套：useState 可按「组件名→hook 序号」预设；
//            useEffect 只登记不执行，因此不会发任何网络请求） ----------
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
const fmtN = (n) => Number.isFinite(n) ? String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : String(n)

console.log('== _selftest-prompt-map.mjs · dsh-memory-archive 提示词装配地图自检 ==')

// ---------- 真加载（假 window.__ModuleLoader__ 接住 factory） ----------
const win = { __ModuleLoader__: { load(def) { win.__def = def } } }
globalThis.window = win
const fakeReact = makeFakeReact()

await check('前置：factory 真执行；exports.__promptMap 存在且五个成员是函数；__internals 键集合未被本单改动（仍 15 个）', () => {
  ;(0, eval)(src)
  assert.ok(win.__def, 'load() 未被调用')
  const mod = win.__def.factory(() => fakeReact)
  const pm = mod.__promptMap
  assert.ok(pm, '缺 exports.__promptMap（本单的自检出口）')
  for (const k of ['buildPromptMapData', 'pmSplitSystem', 'judgePmMutability', 'PromptMapView', 'PromptMap']) {
    assert.equal(typeof pm[k], 'function', '__promptMap.' + k + ' 不是函数')
  }
  assert.deepEqual(Object.keys(mod.__internals).sort(),
    [
      'buildCatalogIndex', 'clipInfo', 'decodeWorkspaceSlug', 'groupSessionsByWorkspace',
      'hiddenSessionReason', 'labelCharacter', 'labelPlaythrough', 'labelSession', 'pad4',
      'parseMarkdown', 'relativeTime', 'shortId', 'splitMessagesText', 'splitSystemSections',
      'workspaceLabelFromCwd',
    ])
})

const pm = win.__def.factory(() => fakeReact).__promptMap

// ---------- 假数据（可控：把任务规格点名的标记都塞进一份 system 全文） ----------
const SYS_FULL = [
  'You are an AI agent powered by DeepSeek Harness. 你在 DSH 里，检出目录在……',
  '@deepseek-ai/dsh-persona 你是「示例角色」的扮演者，说话克制……',
  'dsh-tavern preset 段：ST 预设归一化后的内容（身份与文风来自这里）……',
  'rp:policy RP 模式策略：高风险操作被锁……',
  'state:card 【当前状态】HP=80/80 · 位置：废墟……',
  'anima:memory <recalledMemories>第一轮检索出的摘录……</recalledMemories>',
  '## 工具引导（tool-bash / tool-web 的使用纪律）',
  'dma:rules 核心规则：绝不替玩家做决定……',
].join('\n\n')
const MSG_FULL = [
  '── [seq 1] user ──\n<compacted-summary> 已被压缩的那段历史的占位行',
  '── [seq 2] assistant ──\n（角色开场白……）',
  '── [seq 3] user ──\n玩家输入……',
  '── [seq 4] assistant ──\n角色回应……',
].join('\n\n')
const TOOLS_FULL = [{ name: 'tool__bash', chars: 1200 }, { name: 'read__fs', chars: 800 }]

function findBlock(data, key) {
  for (const box of data.boxes) for (const b of box.blocks) if (b.key === key) return b
  return null
}
function expectColors(data, expected, tag) {
  for (const [key, color] of Object.entries(expected)) {
    const b = findBlock(data, key)
    assert.ok(b, '[' + tag + '] 缺块 ' + key)
    assert.equal(b.color, color, '[' + tag + '] ' + key + ' 应为 ' + color + '，实际 ' + b.color)
  }
}
function renderMap(data, state) {
  return fakeReact.createElement(pm.PromptMapView, {
    data: data,
    state: state || { status: 'ready', data: data, error: '' },
  })
}

// ---------- 1 + 4：组件能渲染、三个框都在 ----------
const data1 = pm.buildPromptMapData({ systemText: SYS_FULL, tools: TOOLS_FULL, messagesText: MSG_FULL })
let tree1 = null
await check('★1+4 组件能渲染：喂假数据不抛；[system]/[上下文]/[tools]/[messages] 四个框标题都在（20260914 第二次返工起 contexts 独立成盒，恰 4 框）', () => {
  tree1 = renderMap(data1)
  const boxes = collectNodes(tree1, (n) => n.props && n.props['data-pm'] === 'box', [])
  assert.equal(boxes.length, 4, '框数不是 4：' + boxes.length)
  const text = visibleText(tree1)
  assert.ok(text.includes('[system]'), '缺 [system] 框标题')
  assert.ok(text.includes('[上下文] 运行上下文快照'), '缺 [上下文] 框标题')
  assert.ok(text.includes('独立字段，不在 system 里'), '缺 [上下文] 独立字段口径')
  assert.ok(text.includes('[tools]'), '缺 [tools] 框标题')
  assert.ok(text.includes('[messages]'), '缺 [messages] 框标题')
  // 顶栏三个小计都在（拿得到的给实数；期望值从数据本身算，不写死字数千位）
  assert.ok(text.includes('system ' + fmtN(data1.totals.systemChars) + ' 字'), '缺 system 总字数小计')
  assert.ok(text.includes('2 个 / ' + fmtN(data1.totals.toolChars) + ' 字'), '缺工具个数与总字数小计')
  assert.ok(text.includes('4 条'), '缺 messages 条数小计')
})

// ---------- 2：三色分类正确（实数进报告） ----------
await check('★2 三色分类正确：红/黄/蓝各≥1，已知段逐一对色无错分（错分即红）', () => {
  expectColors(data1, {
    identity: 'red', persona: 'red', preset: 'red', rpPolicy: 'red', dmaRules: 'red',
    stateCard: 'yellow', anima: 'yellow',
    toolGuide: 'blue',
    worldbook: 'gray', 'storyAnchor-missing': 'gray', 'dmaSettings-missing': 'gray',
  }, '三色')
  // 反向：蓝区里不许混进红/黄的已知段（工具引导必须是蓝，state:card 必须是黄……逐段再核对一遍）
  const sysBox = data1.boxes.find((b) => b.id === 'system')
  const wrong = sysBox.blocks.filter((b) => !b.dashed && !{
    identity: 'red', persona: 'red', preset: 'red', rpPolicy: 'red', dmaRules: 'red',
    stateCard: 'yellow', anima: 'yellow', toolGuide: 'blue',
  }[b.key])
  assert.deepEqual(wrong.map((b) => b.key), [], 'system 框有错分/漏判的已检出段')
  const n = { red: 0, yellow: 0, blue: 0, gray: 0 }
  for (const box of data1.boxes) for (const b of box.blocks) n[b.color]++
  console.log('       [实数] 三色分类：红 ' + n.red + ' · 黄 ' + n.yellow + ' · 蓝 ' + n.blue + ' · 灰(含虚线) ' + n.gray)
  assert.ok(n.red >= 1 && n.yellow >= 1 && n.blue >= 1, '三色没有同时出现：' + JSON.stringify(n))
})

// ---------- 3：★★可变性标注 ----------
const T1 = SYS_FULL.replace('第一轮检索出的摘录', '第一轮检索出的摘录（A）') + '\n\n<compacted-summary> checkpoint 段（两轮相同）'
const T2 = SYS_FULL.replace('第一轮检索出的摘录', '第二轮检索出的摘录（B·变了）') + '\n\n<compacted-summary> checkpoint 段（两轮相同）'
await check('★★3 可变性标注：两轮中文本变了的段（anima）⇒ 每轮·实测；没变且无已知类型的段（compacted）⇒ 静态·实测；两轮拿不到 ⇒ 未知', () => {
  const d2 = pm.buildPromptMapData({ systemText: T2, prevSystemText: T1, tools: TOOLS_FULL, messagesText: MSG_FULL })
  const anima = findBlock(d2, 'anima')
  assert.equal(anima.mut, 'per-turn', '变了段应判每轮，实际 ' + anima.mut)
  assert.equal(anima.mutBasis, 'measured', '变了段应是实测口径')
  const ckpt = findBlock(d2, 'compacted')
  assert.equal(ckpt.mut, 'static', '没变且无已知类型应判静态（实测），实际 ' + ckpt.mut)
  assert.equal(ckpt.mutBasis, 'measured', '没变段应是实测口径')
  const d3 = pm.buildPromptMapData({ systemText: T2, tools: TOOLS_FULL, messagesText: MSG_FULL })
  assert.equal(findBlock(d3, 'compacted').mut, 'unknown', '两轮拿不到应标未知，不许猜成静态')
  // 已知类型不受单轮限制：preset(10)/rp:policy(45) 官方 text 是函数 ⇒ 每轮；dma:rules ⇒ 静态
  assert.equal(findBlock(d3, 'preset').mut, 'per-turn')
  assert.equal(findBlock(d3, 'rpPolicy').mut, 'per-turn')
  assert.equal(findBlock(d3, 'dmaRules').mut, 'static')
})

// ---------- 5：悬停提示有内容 ----------
await check('★5 悬停提示有内容：每块都挂了提示数据；红块的提示含「影响所有/影响每一轮」后果文案；黄块写「只影响这一轮」', () => {
  const rows = collectNodes(tree1, (n) => n.props && n.props['data-pm'] === 'row', [])
  assert.ok(rows.length >= 10, '行数异常少：' + rows.length)
  const noTip = rows.filter((r) => !r.props.title || String(r.props.title).trim() === '')
  assert.deepEqual(noTip.map((r) => r.props['data-pm-color']), [], '有块没挂提示数据')
  const redRows = rows.filter((r) => r.props['data-pm-color'] === 'red')
  assert.ok(redRows.length >= 1, '红行缺失')
  const badRed = redRows.filter((r) => !(r.props.title.includes('影响所有') || r.props.title.includes('影响每一轮')))
  assert.deepEqual(badRed.map((r) => r.props.title.slice(0, 30)), [], '红块提示缺后果文案')
  const yellowRows = rows.filter((r) => r.props['data-pm-color'] === 'yellow')
  const badYellow = yellowRows.filter((r) => !r.props.title.includes('只影响这一轮'))
  assert.deepEqual(badYellow.map((r) => r.props.title.slice(0, 30)), [], '黄块提示缺「只影响这一轮」文案')
  // 提示里要有 order / 谁注入 / 字数三个要素（抽 identity 与 tool 行核对）
  const idRow = rows.find((r) => String(r.props.title).startsWith('harness identity'))
  assert.ok(idRow && idRow.props.title.includes('order') && idRow.props.title.includes('谁注入') && idRow.props.title.includes('实际字数'), 'identity 提示缺要素')
})

// ---------- 6：灰虚线不被说成不存在 ----------
await check('★6 缺 anima:memory ⇒ 该块仍以灰虚线「未检出」出现在图上，不是消失', () => {
  const sysNoAnima = SYS_FULL.split('\n\n').filter((s) => !s.includes('anima:memory')).join('\n\n')
  const d = pm.buildPromptMapData({ systemText: sysNoAnima, tools: TOOLS_FULL, messagesText: MSG_FULL })
  const b = findBlock(d, 'anima-missing')
  assert.ok(b, 'anima 未检出占位块消失了（被说成不存在）')
  assert.equal(b.dashed, true, '未检出块应是虚线')
  assert.equal(b.color, 'gray', '未检出块应是灰色')
  assert.ok(b.sub.includes('未检出') && b.tip.includes('未检出'), '未检出块没写「未检出」')
  const tree = renderMap(d)
  assert.ok(visibleText(tree).includes('未检出'), '渲染层没把「未检出」画出来')
})

// ---------- 7：★反证 A —— tools 空数组，框仍在 ----------
await check('★7 反证 A：part=tools 喂成空数组 ⇒ [tools] 框仍在（内容「未检出」），不是整个框消失', () => {
  const d = pm.buildPromptMapData({ systemText: SYS_FULL, tools: [], messagesText: MSG_FULL })
  assert.equal(d.boxes.length, 4, '框数变了')
  const toolsBox = d.boxes.find((b) => b.id === 'tools')
  assert.ok(toolsBox, '[tools] 框消失')
  assert.ok(toolsBox.blocks.some((b) => b.dashed && b.sub.includes('未检出')), '[tools] 框空数组时没标「未检出」')
  const tree = renderMap(d)
  assert.ok(visibleText(tree).includes('[tools]'), '渲染层 [tools] 标题消失')
  assert.ok(visibleText(tree).includes('未检出（本会话没有工具定义）'), '渲染层没给出未检出说明')
  // 工具行还要有名字与每项字数（正常数据下）
  assert.ok(findBlock(data1, 'tool:tool__bash').chars === 1200, '工具行缺每项字数')
})

// ---------- 8：★反证 B —— 故意喂错颜色，第 2 条必须会红 ----------
await check('★8 反证 B：把某块颜色故意断错 ⇒ 第 2 条的断言真的会抛（不是橡皮图章）', () => {
  assert.throws(() => expectColors(data1, { stateCard: 'red' }, '反证B'), /应为 red，实际 yellow/,
    '把 stateCard 断成 red 竟然没抛 —— 分类断言是橡皮图章')
  assert.throws(() => expectColors(data1, { toolGuide: 'yellow' }, '反证B'), /应为 yellow，实际 blue/,
    '把 toolGuide 断成 yellow 竟然没抛')
})

// ---------- 9：确定性 ----------
await check('9 确定性：同一份假数据渲染两次，元素结构逐字一致', () => {
  const a = JSON.stringify(renderMap(data1))
  const b = JSON.stringify(renderMap(data1))
  assert.equal(a, b, '两次渲染结构不一致')
  const d2a = JSON.stringify(pm.buildPromptMapData({ systemText: SYS_FULL, tools: TOOLS_FULL, messagesText: MSG_FULL }))
  const d2b = JSON.stringify(pm.buildPromptMapData({ systemText: SYS_FULL, tools: TOOLS_FULL, messagesText: MSG_FULL }))
  assert.equal(d2a, d2b, '同一份输入两次 buildPromptMapData 结果不一致')
})

// ---------- 10 + 11（20260914 M2 · A8 用户拍板改版）：messages 框 = 「对话历史 · N 条」定位入口
//            + 只留真实检出的特殊行（checkpoint / role=tool）。旧「首轮开场（greeting）」行按用户决定
//            从 messages 框移除（普通历史不再占版面）—— 开场判据随之退役，这两条改验新契约。
const MSG_OPENING = [
  '── [seq 1] assistant ──\n（这里是开场白 greeting……）',
  '── [seq 2] user ──\n玩家输入……',
].join('\n\n')
await check('★10 A8 改版：messages 框顶「对话历史 · N 条」定位入口（条数=真实切出的条数）；特殊行只留真实检出的 checkpoint / role=tool，普通 user/assistant 行不再出现', () => {
  const d = pm.buildPromptMapData({ systemText: SYS_FULL, tools: TOOLS_FULL, messagesText: MSG_OPENING })
  const box = d.boxes.find((b) => b.id === 'messages')
  assert.equal(box.count, 2, 'messages 框条数（locator 用）不是 2：' + box.count)
  assert.equal(findBlock(d, 'opening'), null, '旧「首轮开场」块应已按 A8 移除')
  assert.equal(findBlock(d, 'msgUser'), null, '普通 user 行不该再占版面')
  assert.equal(findBlock(d, 'msgAsst'), null, '普通 assistant 行不该再占版面')
  const tree = renderMap(d, { status: 'ready', data: d, error: '' })
  const loc = collectNodes(tree, (n) => n.props && n.props['data-pm'] === 'locator', [])
  assert.equal(loc.length, 1, '定位入口行缺失')
  assert.ok(visibleText(loc[0]).includes('对话历史 · 2 条'), '定位行文案不对：' + visibleText(loc[0]))
  // MSG_OPENING 没有 checkpoint/tool 特殊行 ⇒ messages 框除定位行外没有普通行
  const boxNode = collectNodes(tree, (n) => n.props && n.props['data-pm'] === 'box' && n.props['data-pm-box'] === 'messages', [])[0]
  const rows = collectNodes(boxNode, (n) => n.props && n.props['data-pm'] === 'row', [])
  assert.deepEqual(rows.map((r) => r.props['data-pm-dashed']), [], '没有特殊行时 messages 框不该再画普通历史行')
  // 渲染层：条数确实画出来（在定位行文案里，上面已断言）
  assert.ok(visibleText(boxNode).includes('对话历史 · 2 条'), '渲染层定位行缺条数')
})
await check('★11 A8 反证：checkpoint / role=tool 只有真实检出才出现行 —— MSG_FULL（含 compacted 无 tool）⇒ 只出 checkpoint 行、无 tool 行；messages=null ⇒ 如实「取不到」一行；空串 ⇒ 0 条且无行', () => {
  const d = pm.buildPromptMapData({ systemText: SYS_FULL, tools: TOOLS_FULL, messagesText: MSG_FULL })
  const ckpt = findBlock(d, 'msgCkpt')
  assert.ok(ckpt && !ckpt.dashed && ckpt.label.includes('×1'), 'checkpoint 特殊行缺失或计数不对')
  assert.equal(findBlock(d, 'msgTool'), null, '没有 role=tool 时不该有 tool 行（旧的灰虚线占位一并移除）')
  const dNull = pm.buildPromptMapData({ systemText: SYS_FULL, tools: TOOLS_FULL, messagesText: null })
  const missing = findBlock(dNull, 'messagesMissing')
  assert.ok(missing && missing.dashed && missing.tip.includes('取不到'), 'messages 取不到 ⇒ 必须如实给一行「取不到」，不许空白')
  const dEmpty = pm.buildPromptMapData({ systemText: SYS_FULL, tools: TOOLS_FULL, messagesText: '' })
  assert.equal(dEmpty.boxes.find((b) => b.id === 'messages').count, 0, '空 messages ⇒ 条数如实 0')
  assert.equal(findBlock(dEmpty, 'messagesMissing'), null, '空串不是取不到，不该标取不到')
  // 切不开（形状变了）⇒ 仍按整段如实标注
  const dRaw = pm.buildPromptMapData({ systemText: SYS_FULL, tools: TOOLS_FULL, messagesText: '没有分隔行的一段话' })
  const raw = findBlock(dRaw, 'messagesRaw')
  assert.ok(raw && raw.dashed && raw.chars === '没有分隔行的一段话'.length, '形状变了 ⇒ 整段如实标注缺失')
})

// ---------- 12（20260913 三级导航改版）：轮次胶囊删除 + 状态行 + 行级下钻带块 ----------
const REQ_FIXTURE = [
  { index: 1, seq: 11, provider: 'p', model: 'm', reasoningEffort: 'high', maxTokens: 1, systemChars: 10, toolCount: 2, toolChars: 30, marks: [] },
  { index: 2, seq: 12, provider: 'p', model: 'm', reasoningEffort: 'high', maxTokens: 1, systemChars: 12, toolCount: 2, toolChars: 30, marks: ['x'] },
]
await check('★12 三级导航：★DOM 无轮次胶囊（无 dma-turn、无 #N 可点按钮）；状态行「第 2 / 3 楼」只是显示；依据来源角标（captured）；下钻回调收到 (boxId, block)，虚线块不可点', () => {
  const drilled = []
  const tree = fakeReact.createElement(pm.PromptMapView, {
    data: data1, state: { status: 'ready', data: data1, error: '' },
    sessionId: 'session-abcdef0123456789', turn: 2, turnsCount: 3,
    source: 'captured', onDrill: (boxId, block) => drilled.push([boxId, block]),
  })
  const text = visibleText(tree)
  // ★ 反证（任务书 DoD 6）：轮次胶囊/步进器不许再出现 —— 「共 N 次模型请求」与 #N 按钮都是旧交互
  assert.equal(text.includes('次模型请求'), false, '「共 N 次模型请求」不该再出现（旧轮次条）')
  const turnBtns = collectNodes(tree, (n) => n.$$element === 'button' && /^#\d+$/.test(String(n.props.children)), [])
  assert.equal(turnBtns.length, 0, 'DOM 里还有 #N 轮次按钮（dma-turn 等价物）')
  const turnClass = collectNodes(tree, (n) => n.props && String(n.props.className || '').includes('dma-turn'), [])
  assert.equal(turnClass.length, 0, 'DOM 里还有 dma-turn 元素')
  // 状态行：第 N / M 楼 + 会话短 id；它是纯显示（span，不是 button）
  const floor = collectNodes(tree, (n) => n.props && n.props['data-pm'] === 'status-floor', [])
  assert.equal(floor.length, 1, '状态行缺失')
  assert.ok(String(floor[0].props.children).includes('第 2 / 3 楼'), '状态行不含「第 2 / 3 楼」：' + floor[0].props.children)
  assert.notEqual(floor[0].$$element, 'button', '状态行不许是可点按钮（步进器回潮）')
  // 依据来源：captured ⇒ 「依据：组装捕获」角标
  const badge = collectNodes(tree, (n) => n.props && n.props['data-pm'] === 'source-badge', [])
  assert.equal(badge.length, 1, 'captured 依据角标缺失')
  assert.ok(visibleText(badge[0]).includes('组装捕获'), '依据角标文案不对')
  // 行级下钻：非虚线块可点，且回调拿到 (boxId, block)；虚线块不可点
  const rows = collectNodes(tree, (n) => n.props && n.props['data-pm'] === 'row', [])
  const clickable = rows.filter((r) => r.props['data-pm-click'] === '1')
  const dashed = rows.filter((r) => r.props['data-pm-dashed'] === '1')
  assert.ok(clickable.length >= 1, '非虚线块应可下钻')
  for (const r of clickable) assert.equal(typeof r.props.onClick, 'function', '可下钻块没挂 onClick')
  for (const r of dashed) assert.equal(r.props.onClick, undefined, '虚线块不该可点')
  clickable[0].props.onClick()
  assert.equal(drilled.length, 1, '下钻回调没触发')
  assert.equal(typeof drilled[0][0], 'string', '下钻回调第一参（boxId）缺失')
  assert.ok(drilled[0][1] && typeof drilled[0][1] === 'object' && drilled[0][1].key, '下钻回调第二参（block）缺失 —— L3 抽屉需要段元数据')
  // 反证 D：不传 onDrill ⇒ 没有任何行可点（下钻回调没接线时不能假装能点）
  const tree2 = fakeReact.createElement(pm.PromptMapView, { data: data1, state: { status: 'ready', data: data1, error: '' } })
  const rows2 = collectNodes(tree2, (n) => n.props && n.props['data-pm'] === 'row', [])
  assert.equal(rows2.filter((r) => r.props['data-pm-click'] === '1').length, 0, '没传 onDrill 时不该有可点行')
})

// ---------- 12b（20260913）：★反证 —— 轮次条只要加回去断言必须红 ----------
await check('★12b 反证：把旧轮次条数据（requests）喂给新组件也渲染不出胶囊 —— 证明删除是实现级的，不是数据缺省', () => {
  const tree = fakeReact.createElement(pm.PromptMapView, {
    data: data1, state: { status: 'ready', data: data1, error: '' },
    requests: REQ_FIXTURE, turn: 2, onTurn: () => {}, onDrill: () => {},
  })
  const turnBtns = collectNodes(tree, (n) => n.$$element === 'button' && /^#\d+$/.test(String(n.props.children)), [])
  assert.equal(turnBtns.length, 0, '旧 props 竟然还能渲染出轮次按钮 —— 胶囊没删干净')
  assert.equal(visibleText(tree).includes('次模型请求'), false, '旧「共 N 次模型请求」还在')
})

// ---------- 13（20260913 → 20260914 M2 A6 横幅口径）：诚实口径 —— inferred / fallback 必须明示 ----------
await check('★13 诚实口径（A6 横幅）：source=inferred ⇒ 横幅「无捕获记录 · 以下为文本推断」+ 原因；fallback ⇒ 带「捕获端点不可用」；captured ⇒ 横幅「本楼结构来自组装捕获」且不许出现推断横幅', () => {
  const mk = (source) => fakeReact.createElement(pm.PromptMapView, {
    data: data1, state: { status: 'ready', data: data1, error: '' },
    turn: 1, turnsCount: 3, source: source,
  })
  const badges = (tree, key) => collectNodes(tree, (n) => n.props && n.props['data-pm'] === key, [])
  const bannerOf = (tree, key) => collectNodes(tree, (n) => n.props && n.props['data-pm'] === key && n.props['data-pm-banner'] === '1', [])
  const inf = bannerOf(mk('inferred'), 'inferred-badge')
  assert.equal(inf.length, 1, 'inferred 没有明示横幅')
  assert.ok(visibleText(inf[0]).includes('无捕获记录 · 以下为文本推断'), 'inferred 横幅文案不对：' + visibleText(inf[0]))
  const fb = bannerOf(mk('fallback'), 'inferred-badge')
  assert.equal(fb.length, 1, 'fallback 没有明示横幅')
  assert.ok(visibleText(fb[0]).includes('捕获端点不可用'), 'fallback 横幅缺「端点不可用」说明')
  assert.equal(bannerOf(mk('captured'), 'inferred-badge').length, 0, 'captured 不该挂推断横幅')
  const cap = bannerOf(mk('captured'), 'source-badge')
  assert.equal(cap.length, 1, 'captured 该挂「组装捕获」横幅')
  assert.ok(visibleText(cap[0]).includes('本楼结构来自组装捕获'), 'captured 横幅文案不对：' + visibleText(cap[0]))
  assert.equal(badges(mk(null), 'inferred-badge').length, 0, '没传 source（纯文本推断数据）不该冒充 captured')
})

// ---------- 14（20260913）：C4 数据层 buildMapFromSections（真相源） ----------
const C4_CAPTURED = {
  ok: true, source: 'captured', capturedAt: '2026-09-13T11:02:05.000+08:00', turn: 2,
  sections: [
    { name: 'harness:identity', order: -1000, chars: 48, hash: 'a1', mutability: 'static', mutabilityBasis: 'definition' },
    { name: 'roleplay:policy', order: 45, chars: 2981, hash: 'a2', mutability: 'per-turn', mutabilityBasis: 'definition' },
    { name: 'mystery:section', order: null, chars: 10, hash: null, mutability: 'unknown', mutabilityBasis: 'unknown' },
  ],
  contexts: [{ name: 'sandbox:policy', chars: 312 }],
  tools: [{ name: 'pwsh', chars: 4419 }, { name: 'tool_browser', chars: 3329 }],
}
const MSG_FULL_L2 = '── [seq 1] user ──\n玩家输入……\n\n── [seq 2] assistant ──\n角色回应……'
await check('★14 C4 数据层：真段名进 [system] 框（static=红 / per-turn=黄 / unknown=灰实线）；contexts 进独立 [上下文] 框（20260914 返工：⛔ 不再混进 system）；tools 蓝；mutabilityBasis 进提示；source/capturedAt 透传', () => {
  const d = pm.buildMapFromSections(C4_CAPTURED, { messagesText: MSG_FULL_L2 })
  assert.deepEqual(d.boxes.map((b) => b.id), ['system', 'contexts', 'tools', 'messages'], '框结构变了')
  const sys = d.boxes[0].blocks
  assert.deepEqual(sys.map((b) => b.label), ['harness:identity', 'roleplay:policy', 'mystery:section'], '段名不是运行时真名（或混进了 contexts）')
  assert.equal(sys[0].color, 'red', 'static 段应为红')
  assert.equal(sys[1].color, 'yellow', 'per-turn 段应为黄')
  assert.equal(sys[2].color, 'gray', 'unknown 段应为灰')
  for (const b of sys) assert.equal(b.dashed, false, '捕获段不许是虚线（不是未检出）')
  // 20260914 返工：contexts 不进 [system] 框，进独立 [上下文] 框
  const ctxBox = d.boxes.find((b) => b.id === 'contexts')
  assert.equal(ctxBox.blocks[0].label, 'sandbox:policy', 'contexts 没进独立 [上下文] 框')
  assert.equal(ctxBox.blocks[0].key, 'ctx:sandbox:policy', 'contexts 块 key 不对')
  const tools = d.boxes[2].blocks
  assert.equal(tools.length, 2, '工具行数不对')
  for (const b of tools) assert.equal(b.color, 'blue', '工具行应为蓝')
  assert.ok(sys[1].tip.includes('header-equal') || sys[1].tip.includes('段定义'), 'mutabilityBasis 没进悬停提示')
  assert.equal(d.source, 'captured', 'source 没透传')
  assert.ok(d.capturedAt, 'capturedAt 没透传')
  // ★ system 小计 = 只算 sections（⛔ 不含 contexts）：48+2981+10 = 3,039，312 是 contexts 的
  assert.equal(d.totals.systemChars, 48 + 2981 + 10, 'system 小计混入了 contexts（应为 3,039，实测 ' + d.totals.systemChars + '）')
  assert.equal(d.totals.contextCount, 1, 'contexts 段数不对')
  assert.equal(d.totals.contextChars, 312, 'contexts 字数不对')
  assert.equal(d.totals.toolCount, 2, 'toolCount 不对')
})

// ---------- 15（20260913）：★反证 —— inferred 的 C4 不许标成捕获 ----------
await check('★15 反证：C4 source=inferred ⇒ 数据层 source 仍是 inferred、块 mut=unknown 灰、inferred.message 透传（不许把推断说成捕获）', () => {
  const C4_INFERRED = {
    ok: true, source: 'inferred', capturedAt: null, turn: 2,
    inferred: { reason: 'no-capture-record', message: '该楼没有组装捕获记录（fixture）' },
    sections: [{ name: 'identity', order: null, chars: 48, hash: null, mutability: 'unknown', mutabilityBasis: 'unknown' }],
    contexts: [], tools: [],
  }
  const d = pm.buildMapFromSections(C4_INFERRED, { messagesText: null })
  assert.equal(d.source, 'inferred', 'inferred 被标成了别的')
  assert.equal(d.capturedAt, null, 'inferred 不该有 capturedAt')
  assert.ok(d.inferred && d.inferred.message.includes('没有组装捕获记录'), '降级说明没透传')
  const b = d.boxes[0].blocks[0]
  assert.equal(b.mut, 'unknown', '推断段可变性应未知')
  assert.equal(b.color, 'gray', '推断段应为灰')
  assert.equal(b.dashed, false, '推断段是检出的（有名字有字数），不该是虚线 —— 虚线是「未检出」')
  // 渲染层：inferred 必须带明示横幅（A6 口径：无捕获记录 · 以下为文本推断）
  const tree = fakeReact.createElement(pm.PromptMapView, { data: d, state: { status: 'ready', data: d, error: '' }, turn: 2, turnsCount: 3 })
  const banners = collectNodes(tree, (n) => n.props && n.props['data-pm'] === 'inferred-badge' && n.props['data-pm-banner'] === '1', [])
  assert.equal(banners.length, 1, '渲染层没把「无捕获记录」横幅画出来')
  assert.ok(visibleText(tree).includes('以下为文本推断'), '渲染层没把「以下为文本推断」画出来')
  assert.ok(visibleText(banners[0]).includes('no-capture-record'), '推断原因（reason）没明示在横幅上')
})

// ---------- 16（20260913；20260914 M10 按用户口径改：**只列玩家发的那条**） ----------
await check('★16 L2 消息定位：只列玩家发的那条（source.kind==="user"）；注入的 user 行默认不列、可一键显示', () => {
  // 三种 source.kind 的形状照真机实测：user=玩家自己发的 / plugin=插件注入（运行上下文快照）/ skill-catalog=技能目录
  const MESSAGES = {
    status: 'ready',
    data: {
      ok: true, total: 4, latestIndex: 3,
      counts: { player: 2, injected: 1, unknownUser: 0, assistant: 1, tool: 0, compacted: 0 },
      messages: [
        { index: 0, seq: 16, turn: 1, role: 'user', preview: '开始吧', chars: 3, isToolResult: false, isCompacted: false, sourceKind: 'user', playerTyped: true },
        { index: 1, seq: 18, turn: 1, role: 'assistant', preview: '好的', chars: 2, isToolResult: false, isCompacted: false, sourceKind: null, playerTyped: null },
        { index: 2, seq: 520, turn: 2, role: 'user', preview: 'Current runtime context.', chars: 474, isToolResult: false, isCompacted: false, sourceKind: 'plugin', sourcePlugin: '@deepseek-ai/dsh-system-prompt', playerTyped: false },
        { index: 3, seq: 1188, turn: 3, role: 'user', preview: '继续推进', chars: 13, isToolResult: false, isCompacted: false, sourceKind: 'user', playerTyped: true },
      ],
    },
    error: '',
  }
  fakeReact.__setPreset({ MessageLocatorPanel: { 0: MESSAGES } })
  let located = null
  try {
    const tree = fakeReact.createElement(pm.MessageLocatorPanel, {
      sessionId: 'session-abcdef0123456789', turn: 2,
      onClose: () => {}, onLocate: (n) => { located = n },
    })
    const text = visibleText(tree)
    assert.ok(text.includes('消息定位'), 'L2 标题缺失')
    // 默认视图：只有玩家发的那两条（第 1 楼、第 3 楼）；注入行与 assistant 行都不列
    const rows = collectNodes(tree, (n) => n.props && n.props['data-l2-row'] != null, [])
    assert.equal(rows.length, 2, '默认只该列玩家发的那两条，实得 ' + rows.length)
    assert.deepEqual(rows.map((r) => r.props['data-l2-turn']), ['1', '3'], '行的楼号不对')
    assert.ok(text.includes('第 1 楼') && text.includes('第 3 楼'), '行上缺「第 N 楼」')
    assert.equal(text.includes('Current runtime context.'), false, '注入行不许出现在默认视图里')
    assert.ok(text.includes('共 2 条你发的消息'), '计数文案应为「共 2 条你发的消息」：' + text.slice(0, 120))
    // 注入行不藏事实：有一键开关，且写明"不是你发的"
    assert.ok(text.includes('显示注入行（1 条）'), '缺注入行开关：' + text.slice(0, 160))
    assert.ok(text.includes('不是你发的'), '开关旁必须写明是谁发的')
    rows[1].props.onClick()
    assert.equal(located, 3, '点第 3 楼的消息 ⇒ onLocate(3) 没触发')
    // 打开开关 ⇒ 注入行回来，且顺序按 index
    fakeReact.__setPreset({ MessageLocatorPanel: { 0: MESSAGES, 1: true } })
    const tree2 = fakeReact.createElement(pm.MessageLocatorPanel, {
      sessionId: 'session-abcdef0123456789', turn: 2, onClose: () => {}, onLocate: () => {},
    })
    const rows2 = collectNodes(tree2, (n) => n.props && n.props['data-l2-row'] != null, [])
    assert.deepEqual(rows2.map((r) => r.props['data-l2-turn']), ['1', '2', '3'], '打开开关后应按原序含注入行')
    assert.ok(visibleText(tree2).includes('Current runtime context.'), '打开开关后注入行必须可见')
    assert.ok(visibleText(tree2).includes('隐藏注入行（1 条）'), '开关文案应变成「隐藏」')
  } finally { fakeReact.__setPreset(null) }
})
await check('★16b L2 拿不到 source.kind（老宿主/形状变了）⇒ 一条都不过滤，并如实说明', () => {
  const MSGS = {
    status: 'ready', error: '',
    data: {
      ok: true, total: 2, latestIndex: 1,
      messages: [
        { index: 0, seq: 16, turn: 1, role: 'user', preview: '开始吧', chars: 3, isToolResult: false, isCompacted: false },
        { index: 1, seq: 526, turn: 2, role: 'assistant', preview: '好的', chars: 2, isToolResult: false, isCompacted: false },
      ],
    },
  }
  fakeReact.__setPreset({ MessageLocatorPanel: { 0: MSGS } })
  try {
    const tree = fakeReact.createElement(pm.MessageLocatorPanel, {
      sessionId: 's-1', turn: 1, onClose: () => {}, onLocate: () => {},
    })
    const rows = collectNodes(tree, (n) => n.props && n.props['data-l2-row'] != null, [])
    assert.equal(rows.length, 1, '拿不到 kind 时按全部 user 行显示（assistant 仍不列）')
    assert.ok(visibleText(tree).includes('这一版宿主没给 source.kind'), '必须如实说明判据缺失')
  } finally { fakeReact.__setPreset(null) }
})

// ---------- 护栏 A：面板集成真渲染（Agent 编辑器浮层里看得到装配地图，空闲态不抛） ----------
await check('护栏 A：Agent 编辑器面板真渲染（空闲态）不抛，且能看到「提示词装配地图」一列', () => {
  const mod = win.__def.factory(() => fakeReact)
  const registered = []
  mod.apply({
    slots: {
      inject(_n, fn) { return fn() },
      register(meta, comp) { registered.push({ meta, comp }); return comp },
    },
  })
  const editor = registered.find((r) => r.meta.id === 'agent-editor')
  assert.ok(editor, 'agent-editor 席位缺失')
      fakeReact.__setPreset({ AgentEditorButton: { 0: true } })
  try {
    const tree = fakeReact.createElement(editor.comp, { wide: true })
    assert.ok(visibleText(tree).includes('提示词装配地图'), '面板里看不到装配地图')
    assert.ok(visibleText(tree).includes('← 选会话后自动装配'), '空闲态提示缺失')
    assert.equal(visibleText(tree).includes('dma-turn'), false, '面板里不该再有轮次胶囊类名')
  } finally { fakeReact.__setPreset(null) }
})

// ---------- 护栏 B：取数 effect 挂在 [sessionId, turn] 上 ----------
await check('护栏 B：PromptMap 的取数 effect 依赖 [sessionId, turn]（选中会话/轮次变了会重取），且取 C4 段结构（真相源）与 part 各段', () => {
  const src2 = pm.PromptMap.toString()
  assert.ok(src2.includes("'/api/part?id='"), 'PromptMap 没取 part 数据')
  assert.ok(src2.includes("'/sections?sessionId='"), 'PromptMap 没取 C4 段结构（真相源）')
  assert.ok(/\[sessionId, turn\]/.test(src2), 'effect 依赖不是 [sessionId, turn]')
  assert.ok(src2.includes("turn > 1") && src2.includes("'&part=system'"), '没有取上一轮 system（降级路径的实测可变性没了数据来源）')
  assert.ok(src2.includes('buildMapFromSections') && src2.includes('buildPromptMapData'), '没有 C4 优先 + 文本推断降级两条路径')
})

// ============================================================
// 20260914 M2「直观展示构成 + 点开看注释 + 实际正文」新增台（任务书 A/B/§9）
// ============================================================

// ---------- 17（A1）：★比例条与字数成正比 + 右侧百分比 ----------
await check('★17 A1 比例条：每个有字数的检出块都有 data-pm=bar（宽度%数据在 data-pm-bar-w）+ 右侧百分比；两块 bar 的宽度比 ≈ 字数比（0.5% 容差）', () => {
  const tree = renderMap(data1)
  const bars = collectNodes(tree, (n) => n.props && n.props['data-pm'] === 'bar', [])
  assert.ok(bars.length >= 3, '比例条数量异常少：' + bars.length)
  for (const bar of bars) {
    const w = parseFloat(bar.props['data-pm-bar-w'])
    assert.ok(Number.isFinite(w) && w >= 0 && w <= 100, 'bar 宽度数据不是百分比：' + bar.props['data-pm-bar-w'])
  }
  const pcts = collectNodes(tree, (n) => n.props && n.props['data-pm'] === 'bar-pct', [])
  assert.equal(pcts.length, bars.length, '百分比标注与条数不一致')
  // 找字数最大的两块：宽度比 ≈ 字数比（同框分母相同，直接比 bar-w）
  const info = bars.map((bar) => {
    const key = bar.props['data-pm-for']
    const b = findBlock(data1, key)
    return { w: parseFloat(bar.props['data-pm-bar-w']), chars: b && typeof b.chars === 'number' ? b.chars : null }
  }).filter((x) => x.chars > 0)
  info.sort((a, b) => b.chars - a.chars)
  const [big, small] = info
  const ratioW = big.w / small.w
  const ratioC = big.chars / small.chars
  console.log('       [实数] 比例条：最大 ' + big.chars + ' 字→' + big.w + '%，次大 ' + small.chars + ' 字→' + small.w + '%，宽度比 ' + ratioW.toFixed(3) + ' vs 字数比 ' + ratioC.toFixed(3))
  assert.ok(Math.abs(ratioW - ratioC) / ratioC < 0.005, '比例条宽度比 ' + ratioW + ' 偏离字数比 ' + ratioC + ' 超过 0.5%')
})

// ---------- 18（A2）：★顺序脊（order 数值 + 头/中/尾） ----------
await check('★18 A2 顺序脊：每行带 data-pm=spine（order 数值 + 头/中/尾）；-1000⇒头、10⇒中、9900⇒尾；无数值 order 如实「—」', () => {
  assert.equal(pm.pmPosTag(-1000), '头', '负 order 该是头')
  assert.equal(pm.pmPosTag(10), '中', '小正数该是中')
  assert.equal(pm.pmPosTag(9900), '尾', '≥1000 该是尾')
  assert.equal(pm.pmPosTag(null), null, '无数值不给位置词（不猜）')
  // ★ 分界钉死在真机样本上（派单方 20260914 复核：900 与 1010 是全部捕获记录里唯一的 order 空档）
  assert.equal(pm.pmPosTag(-1000), '头', '真机样本 -1000（harness:identity）该是头')
  assert.equal(pm.pmPosTag(900), '中', '真机样本 900（context:file-reference）该是中 —— 900/1010 空档之前')
  assert.equal(pm.pmPosTag(1010), '尾', '真机样本 1010（tool:pwsh）该是尾 —— 900/1010 空档之后；改这条常量前先读 pmPosTag 上的分布注释')
  assert.equal(pm.pmPosTag(9000), '尾', '真机样本 9000（ui:deliverable-file-references）该是尾')
  // data1 里没有 order≥1000 的检出段 —— 补一段 STRUCTURED_OUTPUT（9900，system 尾部固定段）
  const dTail = pm.buildPromptMapData({ systemText: SYS_FULL + '\n\nSTRUCTURED_OUTPUT 输出约定（fixture 补尾段）', tools: TOOLS_FULL, messagesText: MSG_FULL })
  const tree = renderMap(dTail)
  const spines = collectNodes(tree, (n) => n.props && n.props['data-pm'] === 'spine', [])
  assert.ok(spines.length >= 10, '顺序脊数量异常少：' + spines.length)
  const byText = (txt) => spines.filter((s) => String(s.props.children).includes(txt))
  assert.ok(byText('-1000').some((s) => s.props['data-pm-pos'] === '头'), '-1000 没标头')
  assert.ok(byText('9900').some((s) => s.props['data-pm-pos'] === '尾'), '9900 没标尾')
  assert.ok(byText('10').some((s) => s.props['data-pm-pos'] === '中'), '10 没标中')
  assert.ok(spines.some((s) => String(s.props.children) === '—'), '无数值 order 的行该显示 —')
})

// ---------- 19（A3）：★复合段折叠标「复合 · 未展开」 ----------
await check('★19 A3 复合段：`<插件id>:profile` 形状 ⇒ 块 composite=true + 行上「复合段」徽标（M12 起不再写「未展开」）；普通段没有', () => {
  assert.equal(pm.isPmCompositeName('dsh-tavern:profile'), true, 'dsh-tavern:profile 该判复合')
  assert.equal(pm.isPmCompositeName('harness:identity'), false, 'identity 不是复合段')
  assert.equal(pm.isPmCompositeName('profile'), false, '没有插件 id 前缀的不算')
  const d = pm.buildMapFromSections({
    ok: true, source: 'captured', capturedAt: 'x', turn: 1,
    sections: [
      { name: 'dsh-tavern:profile', order: 10, chars: 5200, hash: 'h', mutability: 'per-turn', mutabilityBasis: 'definition' },
      { name: 'harness:identity', order: -1000, chars: 48, hash: 'h', mutability: 'static', mutabilityBasis: 'definition' },
    ], contexts: [], tools: [],
  }, { messagesText: null })
  assert.equal(findBlock(d, 'sec:dsh-tavern:profile').composite, true, '复合段没标 composite')
  assert.equal(findBlock(d, 'sec:harness:identity').composite, false, '普通段被误标 composite')
  const tree = fakeReact.createElement(pm.PromptMapView, { data: d, state: { status: 'ready', data: d, error: '' } })
  const badges = collectNodes(tree, (n) => n.props && n.props['data-pm'] === 'composite-badge', [])
  assert.equal(badges.length, 1, '复合徽标数量不对：' + badges.length)
  assert.ok(visibleText(badges[0]).includes('复合段'), '复合徽标文案不对（M12：只写「复合段」，不再说「未展开」）')
  assert.equal(visibleText(badges[0]).includes('未展开'), false, 'M12：徽标不许再说「未展开」（点开就有原始记录+实际正文）')
})

// ---------- 20（A4）：静态/每轮徽标 + 依据 ----------
await check('★20 A4 徽标带依据：C4 definition ⇒ 「静态·注册定义 / 每轮·注册定义」；header-equal ⇒ 「header相等」；文本推断 known/measured ⇒ 「已知类型 / 实测」', () => {
  assert.equal(pm.pmBasisLabel('definition'), '注册定义', 'definition 短词不对')
  assert.equal(pm.pmBasisLabel('header-equal'), 'header相等', 'header-equal 短词不对')
  assert.equal(pm.pmBasisLabel('measured'), '实测', 'measured 短词不对')
  assert.equal(pm.pmBasisLabel('known'), '已知类型', 'known 短词不对')
  assert.equal(pm.pmBasisLabel(null), '', '没有依据不给词（不编）')
  const tree = fakeReact.createElement(pm.PromptMapView, {
    data: pm.buildMapFromSections(C4_CAPTURED, { messagesText: MSG_FULL_L2 }),
    state: { status: 'ready', data: null, error: '' },
  })
  const badges = collectNodes(tree, (n) => n.props && n.props['data-pm'] === 'mutbadge', [])
  const texts = badges.map((b) => String(b.props['data-pm-mutbadge']))
  assert.ok(texts.includes('static·注册定义'), '缺「静态·注册定义」徽标：' + texts.join(','))
  assert.ok(texts.includes('per-turn·注册定义'), '缺「每轮·注册定义」徽标')
  // 文本推断路径的实测口径：同会话两轮比对（anima 变了 ⇒ 每轮·实测；compacted 没变 ⇒ 静态·实测）
  const T1 = SYS_FULL.replace('第一轮检索出的摘录', '第一轮检索出的摘录（A）') + '\n\n<compacted-summary> checkpoint 段（两轮相同）'
  const T2 = SYS_FULL.replace('第一轮检索出的摘录', '第二轮检索出的摘录（B·变了）') + '\n\n<compacted-summary> checkpoint 段（两轮相同）'
  const d2 = pm.buildPromptMapData({ systemText: T2, prevSystemText: T1, tools: TOOLS_FULL, messagesText: MSG_FULL })
  const tree2 = fakeReact.createElement(pm.PromptMapView, { data: d2, state: { status: 'ready', data: d2, error: '' } })
  const badges2 = collectNodes(tree2, (n) => n.props && n.props['data-pm'] === 'mutbadge', [])
  const texts2 = badges2.map((b) => String(b.props['data-pm-mutbadge']))
  assert.ok(texts2.includes('per-turn·实测'), '缺「每轮·实测」徽标：' + texts2.join(','))
  assert.ok(texts2.includes('static·实测'), '缺「静态·实测」徽标')
})

// ---------- 21（A5）：空段 = 极细线 + 「空」 ----------
await check('★21 A5 空段：chars=0 ⇒ 块 empty=true、行 data-pm-empty=1 + 「空」标、比例条宽 0；和「未检出」虚线明确区分', () => {
  const C4_EMPTY = {
    ok: true, source: 'captured', capturedAt: 'x', turn: 1,
    sections: [{ name: 'context:file-reference', order: 900, chars: 0, hash: 'e3b0c44298fc1c14', mutability: 'per-turn', mutabilityBasis: 'definition' }],
    contexts: [], tools: [],
  }
  const d = pm.buildMapFromSections(C4_EMPTY, { messagesText: null })
  const emptyBlock = findBlock(d, 'sec:context:file-reference')
  assert.ok(emptyBlock, '空段块缺失')
  assert.equal(emptyBlock.empty, true, 'chars=0 该标 empty')
  assert.equal(emptyBlock.dashed, false, '空段是检出的（字数为 0），不该是虚线')
  const tree = fakeReact.createElement(pm.PromptMapView, { data: d, state: { status: 'ready', data: d, error: '' } })
  const emptyRows = collectNodes(tree, (n) => n.props && n.props['data-pm-empty'] === '1', [])
  assert.equal(emptyRows.length, 1, '空段行数不对：' + emptyRows.length)
  assert.ok(visibleText(emptyRows[0]).includes('空'), '空段行没标「空」')
  const bar = collectNodes(emptyRows[0], (n) => n.props && n.props['data-pm'] === 'bar', [])[0]
  // 全框只有空段（无可比字数）⇒ 不画比例条（画一条 0% 的条反而误导）；若画了必须为 0 宽
  if (bar) assert.equal(parseFloat(bar.props['data-pm-bar-w']), 0, '空段比例条宽该为 0')
  // 混合框里：空段与有字数段并存 ⇒ 空段的条必须出现且为 0 宽（长度成正比的退化情形）
  const C4_MIX = {
    ok: true, source: 'captured', capturedAt: 'x', turn: 1,
    sections: [
      { name: 'harness:identity', order: -1000, chars: 48, hash: 'h', mutability: 'static', mutabilityBasis: 'definition' },
      { name: 'context:file-reference', order: 900, chars: 0, hash: 'e3b0c44298fc1c14', mutability: 'per-turn', mutabilityBasis: 'definition' },
    ],
    contexts: [], tools: [],
  }
  const dMix = pm.buildMapFromSections(C4_MIX, { messagesText: null })
  const treeMix = fakeReact.createElement(pm.PromptMapView, { data: dMix, state: { status: 'ready', data: dMix, error: '' } })
  const mixRows = collectNodes(treeMix, (n) => n.props && n.props['data-pm-empty'] === '1', [])
  assert.equal(mixRows.length, 1, '混合框空段行缺失')
  const mixBar = collectNodes(mixRows[0], (n) => n.props && n.props['data-pm'] === 'bar', [])[0]
  assert.ok(mixBar && parseFloat(mixBar.props['data-pm-bar-w']) === 0, '混合框里空段该有 0 宽比例条')
})

// ---------- 22（A6）：★来源横幅已在 ★13/★15 验 —— 这里补数据层透传的 inferred 原因 ----------
await check('★22 A6 补充：buildMapFromSections 把 c4.inferred.reason 原样透传（横幅显示原因用），不许改写/丢失', () => {
  const C4 = { ok: true, source: 'inferred', capturedAt: null, turn: 2,
    inferred: { reason: 'turn-not-found', message: '没有这一楼的捕获记录（fixture）' },
    sections: [], contexts: [], tools: [] }
  const d = pm.buildMapFromSections(C4, {})
  assert.equal(d.inferred.reason, 'turn-not-found', 'reason 没透传')
  assert.equal(d.inferred.message, '没有这一楼的捕获记录（fixture）', 'message 没透传')
})

// ---------- 23（A7，20260914 返工改四框）：各框占比 ----------
// 真机案例数字（派单方实测）：Σ sections = 1,938、contexts = 233+153 = 386，错误实现曾把小计报成 2,324。
const C4_CTX = {
  ok: true, source: 'captured', capturedAt: '2026-09-14T10:00:00.000+08:00', turn: 2,
  sections: [
    { name: 'harness:identity', order: -1000, chars: 48, hash: 'h1', mutability: 'static', mutabilityBasis: 'definition' },
    { name: 'deployment:persona', order: 0, chars: 268, hash: 'h2', mutability: 'static', mutabilityBasis: 'definition' },
    { name: 'roleplay:policy', order: 45, chars: 1622, hash: 'h3', mutability: 'per-turn', mutabilityBasis: 'definition' },
    { name: 'context:file-reference', order: 900, chars: 0, hash: 'h4', mutability: 'per-turn', mutabilityBasis: 'definition' },
  ],
  contexts: [
    { name: 'sandbox:policy', chars: 233 },
    { name: 'approval:policy', chars: 153 },
  ],
  tools: [],
}
await check('★23 M11：占比**并进小计那一行**（跟在各自字数后），★ 不再有单独一行「四框占比」；拿不到字数就不给占比（⛔ 不写 0%）', () => {
  const subOf = (tree) => collectNodes(tree, (n) => n.props && n.props['data-pm'] === 'subtotal', [])[0]
  const tree = renderMap(data1)
  const sub = subOf(tree)
  assert.ok(sub, '小计行缺失')
  const text = visibleText(sub)
  assert.ok(/^小计：system [\d,]+ 字（[\d.]+%） \| 上下文 未知 \| 工具 [\d,]+ 个 \/ [\d,]+ 字（[\d.]+%） \| 消息 [\d,]+ 条/.test(text),
    '小计行格式不对（应「|」分段 + 占比跟在各自字数后；上下文/消息字数拿不到时不给占比）：' + text)
  assert.equal(collectNodes(tree, (n) => n.props && n.props['data-pm'] === 'box-pcts', []).length, 0, 'M11：单独的「四框占比」行该没有了')
  // messages 取不到（null）⇒ 不显示占比，别的框照常
  const dNull = pm.buildPromptMapData({ systemText: SYS_FULL, tools: TOOLS_FULL, messagesText: null })
  const tree2 = fakeReact.createElement(pm.PromptMapView, { data: dNull, state: { status: 'ready', data: dNull, error: '' } })
  const text2 = visibleText(subOf(tree2))
  assert.ok(text2.includes('消息 未知'), 'messages 字数拿不到该如实未知：' + text2)
  // 捕获路径：上下文有字数 ⇒ 占比出数（C4_CTX：1,938/386/0/4）；空 tools 数组是「已知 0」⇒ 0%（不是未知、也不是不给）
  const dCtx = pm.buildMapFromSections(C4_CTX, { messagesText: 'abcd' })
  const tree3 = fakeReact.createElement(pm.PromptMapView, { data: dCtx, state: { status: 'ready', data: dCtx, error: '' } })
  const text3 = visibleText(subOf(tree3))
  assert.ok(/上下文 2 段 \/ 386 字（[\d.]+%） \| 工具 0 个 \/ 0 字（0%）/.test(text3), '捕获路径占比不对：' + text3)
  assert.ok(/消息 (未知|[\d,]+ 条)/.test(text3), '捕获路径消息计数该如实（有就给数、没有就未知）：' + text3)
  assert.ok(text3.includes('（合计 '), '末尾该给合计：' + text3)
})

// ---------- 24（A8）：messages 定位入口接线 ----------
await check('★24 A8 接线：传 onOpenLocator ⇒ 定位行可点且回调触发；不传 ⇒ 不可点（data-pm-loc-open=0）', () => {
  let opened = 0
  const mk = (onOpen) => fakeReact.createElement(pm.PromptMapView, {
    data: data1, state: { status: 'ready', data: data1, error: '' },
    onOpenLocator: onOpen,
  })
  const loc = collectNodes(mk(() => { opened++ }), (n) => n.props && n.props['data-pm'] === 'locator', [])[0]
  assert.equal(loc.props['data-pm-loc-open'], '1', '接了回调的定位行该可点')
  loc.props.onClick()
  assert.equal(opened, 1, '点定位行没触发 onOpenLocator')
  const loc2 = collectNodes(mk(undefined), (n) => n.props && n.props['data-pm'] === 'locator', [])[0]
  assert.equal(loc2.props['data-pm-loc-open'], '0', '没接回调不该假装可点')
  assert.equal(loc2.props.onClick, undefined, '没接回调不该挂 onClick')
})

// ---------- 25（B/§9）：★取值链五种口径（纯函数直测） ----------
await check('★25 B 取值链：text 非空⇒「来源：记忆库路径切片 [off, len]」；no-offset⇒「该段内容不可用（未记录位置）」；slice-mismatch⇒「内容不可用（校验未通过）」；no-capture-record⇒醒目「文本推断 · 边界可能不准」；网络失败⇒「内容取不到：<原因>」—— ⛔ 不许空白', () => {
  const okResp = { ok: true, sessionId: 's', turn: 2, name: 'n', offset: 4166, chars: 2981, source: 'captured', text: '正文', unavailable: null }
  let st = pm.pmSectionTextState(okResp, '')
  assert.equal(st.kind, 'text', '正常 text 该走 text 口径')
  assert.equal(st.footer, '来源：记忆库路径切片 [4166, 2981]', '页脚不对：' + st.footer)
  assert.equal(st.text, '正文', '正文丢了')
  st = pm.pmSectionTextState({ ok: true, text: '', offset: 9, chars: 0, unavailable: null }, '')
  assert.equal(st.kind, 'text', '空段（text=""）也是取到了 —— 页脚给 [9, 0]')
  assert.ok(st.footer.includes('[9, 0]'), '空段页脚不对：' + st.footer)
  st = pm.pmSectionTextState({ ok: true, text: null, offset: null, chars: 2981, unavailable: 'no-offset' }, '')
  assert.equal(st.kind, 'no-offset', 'no-offset 口径不对')
  assert.equal(st.footer, '该段内容不可用（未记录位置）', 'no-offset 页脚不对：' + st.footer)
  assert.equal(st.text, null, 'no-offset 绝不许带正文')
  st = pm.pmSectionTextState({ ok: true, text: null, unavailable: 'slice-mismatch' }, '')
  assert.equal(st.footer, '内容不可用（校验未通过）', 'slice-mismatch 页脚不对：' + st.footer)
  st = pm.pmSectionTextState({ ok: true, text: null, source: 'inferred', unavailable: 'no-capture-record' }, '')
  assert.equal(st.footer, '文本推断 · 边界可能不准', 'no-capture-record 页脚不对：' + st.footer)
  assert.equal(st.emphasis, true, '文本推断必须醒目（emphasis）')
  st = pm.pmSectionTextState(null, '网络请求失败：ECONNREFUSED')
  assert.equal(st.kind, 'error', '网络失败该走 error 口径')
  assert.ok(st.footer.startsWith('内容取不到：') && st.footer.includes('ECONNREFUSED'), '网络失败页脚不对：' + st.footer)
  st = pm.pmSectionTextState({ ok: true, text: null, unavailable: 'turn-not-found' }, '')
  assert.ok(st.footer.includes('turn-not-found') && st.footer !== '', '契约外的 unavailable 码要如实带码显示，不空白')
})

// ---------- 26（B）：抽屉体渲染 = 段头 + 徽标 + 注释（未收录）+ 正文 + 页脚；复合段页脚 ----------
// 20260914 M7：可见文字里的「依据…」/mutWhy/「如实展示，不编」退到悬停 title —— 信息留着，元话去掉。
await check('★26 B 抽屉体：段名/order/字数/徽标（只留 [每轮]，依据进 title）/注释齐备；表外段名注释位「未收录（注释表未收录）」；正文来自 state.text；复合段页脚含「复合段内部需 Tavern 接口」；取不到时正文区不出现任何编造内容', () => {
  const sec = { label: 'roleplay:policy', order: 45, chars: 2981, mut: 'per-turn', mutBasis: 'definition', mutWhy: '判断依据：段定义（运行时 PromptSection.text 是否函数）—— 最权威口径', composite: false }
  const body = pm.pmSectionDrawerBody(sec, { kind: 'text', footer: '来源：记忆库路径切片 [4166, 2981]', text: '（fixture）RP 模式策略段正文……' }, '')
  const text = visibleText(body)
  assert.ok(text.includes('roleplay:policy') && text.includes('order 45') && text.includes('2,981 字'), '段头三要素缺失：' + text.slice(0, 120))
  assert.ok(text.includes('[每轮]'), '可变性徽标缺失（M7 后可见只留 [每轮]）')
  assert.ok(!text.includes('依据'), 'M7：抽屉可见文字不许再有「依据…」（出处该在悬停 title 里）：' + text.slice(0, 160))
  const mutLine = collectNodes(body, (n) => n.props && n.props['data-l3'] === 'mut-line', [])[0]
  assert.ok(mutLine && String(mutLine.props.title || '').includes('（依据：注册定义）') && String(mutLine.props.title).includes('段定义（运行时'),
    'M7：出处信息（依据+mutWhy）必须留在 mut-line 的悬停 title 里 —— 信息留着：' + (mutLine && String(mutLine.props.title || '').slice(0, 80)))
  assert.ok(text.includes('注释：') && text.includes('RP 模式策略段'), '已收录段该出注释')
  assert.ok(text.includes('（fixture）RP 模式策略段正文……'), '正文没画出来')
  assert.ok(text.includes('来源：记忆库路径切片 [4166, 2981]'), '页脚没画出来')
  // 未收录段名：注释位「未收录（注释表未收录）」，正文/页脚照常，绝不编一句
  const secX = { label: 'mystery:unknown-section', order: null, chars: 10, mut: 'unknown', mutBasis: 'unknown', mutWhy: null, composite: false }
  const bodyX = pm.pmSectionDrawerBody(secX, { kind: 'text', footer: '来源：记忆库路径切片 [0, 10]', text: 'abc' }, '')
  const textX = visibleText(bodyX)
  assert.ok(textX.includes('注释：未收录（注释表未收录）'), '表外段名注释位该写「未收录（注释表未收录）」：' + textX)
  assert.ok(!textX.includes('如实展示，不编') && !textX.includes('这个段名'), 'M7：未收录注释不许再带「如实展示，不编」类自证赘文：' + textX)
  assert.ok(textX.includes('mystery:unknown-section'), '真段名必须照常显示')
  // ★ M12（20260914 用户拍板）：「复合段…本图不展开内部结构」与页脚那句「复合段内部需 Tavern 接口」**都不许再有** ——
  //   用户要求「不要因为过大不展开」：抽屉现在先给**原始记录 JSON**、再给**实际正文**，没有"不展开"这回事了。
  const secC = Object.assign({}, sec, { label: 'dsh-tavern:profile', composite: true })
  const bodyC = pm.pmSectionDrawerBody(secC, { kind: 'text', footer: '来源：记忆库路径切片 [152, 5200]', text: '（fixture）复合段正文' }, '')
  const textC = visibleText(bodyC)
  assert.equal(textC.includes('不展开'), false, 'M12：抽屉里不许再有「不展开」的说法：' + textC.slice(0, 160))
  assert.equal(textC.includes('复合段内部需 Tavern 接口'), false, 'M12：页脚那句 Tavern 替代话术该没了')
  assert.ok(textC.includes('（fixture）复合段正文'), 'M12：复合段的实际正文必须照常画出来')
  // 取不到（no-offset）：正文区只出现口径文案，没有任何编造正文（DoD 10 的渲染层）
  const bodyN = pm.pmSectionDrawerBody(sec, { kind: 'no-offset', footer: '该段内容不可用（未记录位置）', text: null }, '')
  const missNode = collectNodes(bodyN, (n) => n.props && n.props['data-l3-missing'] === '1', [])
  assert.equal(missNode.length, 1, '取不到时缺「不可用」标示区')
  assert.equal(visibleText(missNode[0]), '该段内容不可用（未记录位置）', '不可用区文案不对：' + visibleText(missNode[0]))
  const bodyNText = visibleText(bodyN)
  assert.ok(!bodyNText.includes('（fixture）RP 模式策略段正文'), '取不到时绝不许把旧正文留在界面（会误当成该段内容）')
  // 醒目（inferred）：文案带 ★ 且走 emphasis 样式
  const bodyI = pm.pmSectionDrawerBody(sec, { kind: 'inferred', footer: '文本推断 · 边界可能不准', text: null, emphasis: true }, '')
  const missI = collectNodes(bodyI, (n) => n.props && n.props['data-l3-missing'] === '1', [])[0]
  assert.ok(visibleText(missI).startsWith('★ 文本推断 · 边界可能不准'), '文本推断该醒目（★ + 口径）：' + visibleText(missI))
})

// ---------- 27（B）：端点接线 —— SectionTextPanel 只打 /dsh-memory-archive/api/sections/text（从宿主注册前缀推出），不拉 system 不自己切 ----------
await check('★27 B 端点接线（20260914 返工单改版）：正文端点由 HOST_API_BASE 推出 = /dsh-memory-archive/api/sections/text；⛔ 全文禁现错串 /dsh-memory-archive/sections/text；前缀字面量只许 HOST_API_BASE 定义一处 —— 否则判「正文端点路径与宿主注册前缀不一致」', () => {
  const src2 = readFileSync(path.join(here, 'lib', 'client.js'), 'utf8')
  const panel = pm.SectionTextPanel.toString()
  assert.ok(panel.includes("SECTIONS_API_BASE + '/sections/text?sessionId='"),
    'SectionTextPanel 没从 SECTIONS_API_BASE 推正文端点 —— 正文端点路径与宿主注册前缀不一致（真路径 /dsh-memory-archive/api/sections/text）')
  assert.ok(panel.includes('encodeURIComponent(name)'), '段名没编码进 URL')
  assert.ok(/\[sessionId, turn, name, isCtx\]/.test(panel), '取数 effect 依赖不是 [sessionId, turn, name, isCtx]（M12 加了上下文分支）')
  assert.ok(panel.includes('pmSectionTextState'), '取数结果没走冻结的口径映射函数')
  assert.ok(!panel.includes("'&part=system'"), '单段抽屉不许拉整段 system（§9 硬线）')
  // ★ 防漂移一：错串 /dsh-memory-archive/sections/text 全文禁止（代码与注释都不许留 —— 真机实测它 404）
  const wrong = []
  let w = -1
  while ((w = src2.indexOf('/dsh-memory-archive/sections/text', w + 1)) !== -1) wrong.push(src2.slice(0, w).split('\n').length)
  assert.deepEqual(wrong, [],
    '正文端点路径与宿主注册前缀不一致：出现错串 /dsh-memory-archive/sections/text（行 ' + wrong.join(',') + '）—— 真路径是 /dsh-memory-archive/api/sections/text（宿主 API_PREFIX + ENDPOINTS 注册名 /sections/text）')
  // ★ 防漂移二：前缀字面量 '/dsh-memory-archive/api' 全文只许出现一次（HOST_API_BASE 定义处），其余一律引用常量
  const baseDefs = []
  let b = -1
  while ((b = src2.indexOf("'/dsh-memory-archive/api'", b + 1)) !== -1) baseDefs.push(src2.slice(0, b).split('\n').length)
  assert.equal(baseDefs.length, 1,
    '正文端点路径与宿主注册前缀不一致：前缀字面量 /dsh-memory-archive/api 出现 ' + baseDefs.length + ' 处（行 ' + baseDefs.join(',') + '）—— 只许 HOST_API_BASE 定义一处，路径只能从常量推')
  assert.ok(/const SECTIONS_API_BASE = HOST_API_BASE/.test(src2), 'SECTIONS_API_BASE 必须直接引用 HOST_API_BASE（不许手写第二个前缀字面量）')
  assert.ok(src2.includes("HOST_API_BASE = '/dsh-memory-archive/api'"), 'HOST_API_BASE 定义缺失（宿主注册前缀的常量源）')
  // PromptMap 主数据面依旧保留 part=system（降级路径 + L2 用），这个不许丢
  const srcMap = pm.PromptMap.toString()
  assert.ok(srcMap.includes("'&part=system'"), '主数据面的 part=system 不该被误删（降级路径要用）')
})

// ---------- 28（反证 · fixture 域）：三条反证与 DoD 10 的数据源可在夹具域构造 ----------
await check('★28 夹具反证源：/sections/text 夹具支持 failcase=no-offset / mismatch / nocapture / netfail（字段名与 §9 冻结契约一致），复合段夹具会话在列', () => {
  const src2 = readFileSync(path.join(here, 'lib', 'client.js'), 'utf8')
  assert.ok(src2.includes("unavailable: 'no-offset'"), '夹具缺 no-offset 反证源')
  assert.ok(src2.includes("unavailable: 'slice-mismatch'"), '夹具缺 slice-mismatch 反证源')
  assert.ok(src2.includes("unavailable: 'no-capture-record'"), '夹具缺 no-capture-record 反证源')
  assert.ok(src2.includes("'fixture-session-composite'") && src2.includes('dsh-tavern:profile'), '复合段夹具会话缺失')
  assert.ok(src2.includes('GET /dsh-memory-archive/api/sections/text'), '新端点路径注释/常量缺失（真路径 /dsh-memory-archive/api/sections/text）')
})

// ---------- 29（派单方 20260914 小活 A）：★机械断言 —— __pmTextFailcase 全局只活在夹具域 ----------
await check('★29 夹具反证钩子作用域：window.__pmTextFailcase 在 client.js 里的出现点全部落在 editorV2FixtureLookup 函数体（大括号配对定界）之内；apiGet 的夹具分支之前有 editorV2FixtureMode() 前置判断 —— 否则判「全局泄漏到生产路径」', () => {
  const src2 = readFileSync(path.join(here, 'lib', 'client.js'), 'utf8')
  // 定位 editorV2FixtureLookup 函数体：从函数名后第一个 { 起做大括号配对
  const fnAt = src2.indexOf('function editorV2FixtureLookup(')
  assert.ok(fnAt >= 0, 'editorV2FixtureLookup 缺失，无法判定作用域')
  let depth = 0
  let fnEnd = -1
  for (let i = src2.indexOf('{', fnAt); i < src2.length; i++) {
    if (src2[i] === '{') depth++
    else if (src2[i] === '}') { depth--; if (depth === 0) { fnEnd = i; break } }
  }
  assert.ok(fnEnd > fnAt, 'editorV2FixtureLookup 函数体定界失败')
  // 定界自检：函数体内确有夹具分支的标志性串，函数体之后才是 apiGet
  assert.ok(src2.slice(fnAt, fnEnd).includes("'/dsh-memory-archive/api/sections/text'"), '定界异常：夹具分支（真路径字面量）不在函数体内（配对被字符串大括号干扰）')
  const apiAt = src2.indexOf('async function apiGet(')
  assert.ok(apiAt > fnEnd, 'apiGet 应在 editorV2FixtureLookup 之后定义（定界异常）')
  // 断言 1：__pmTextFailcase 的每个出现点（含注释引用）都在函数体内；出了函数体 = 全局泄漏到生产路径
  let at = -1
  let inside = 0
  const leakLines = []
  while ((at = src2.indexOf('__pmTextFailcase', at + 1)) !== -1) {
    if (at > fnAt && at < fnEnd) inside++
    else leakLines.push(src2.slice(0, at).split('\n').length)
  }
  assert.ok(inside >= 2, '夹具域内丢了 __pmTextFailcase 的注释/读取（应至少 2 处：行内注释 + failcase 读取）')
  assert.deepEqual(leakLines, [], 'window.__pmTextFailcase 全局泄漏到生产路径：出现在 editorV2FixtureLookup 函数体之外（行号 ' + leakLines.join(',') + '）—— 生产路径绝不许读这个全局')
  // 断言 2：apiGet 开头必须先 editorV2FixtureMode() 判断才允许进夹具分支（查 apiGet 定义后 300 字符内）
  const apiHead = src2.slice(apiAt, apiAt + 300)
  assert.ok(/if \(!editorV2FixtureMode\(\)\) return requestJson/.test(apiHead),
    'apiGet 夹具分支缺 editorV2FixtureMode() 前置判断 —— 全局泄漏到生产路径：非夹具模式必须直接走真端点 requestJson')
  // 断言 3：editorV2FixtureLookup 的调用点唯一且就在 apiGet 夹具分支里（防旁路）
  const callSites = []
  let c = -1
  while ((c = src2.indexOf('editorV2FixtureLookup(', c + 1)) !== -1) {
    if (c !== fnAt + 'function '.length) callSites.push(src2.slice(0, c).split('\n').length) // 排除定义行本身
  }
  assert.equal(callSites.length, 1, 'editorV2FixtureLookup 调用点应只有 apiGet 夹具分支一处，实际：行 ' + callSites.join(',') + '（多余调用 = 全局泄漏到生产路径的旁路）')
  const callLine = src2.slice(0, src2.indexOf('editorV2FixtureLookup(', src2.indexOf('async function apiGet('))).split('\n').length
  const modeLine = src2.slice(0, src2.indexOf('editorV2FixtureMode()', src2.indexOf('async function apiGet('))).split('\n').length
  assert.ok(modeLine < callLine, 'editorV2FixtureMode() 判断必须出现在 editorV2FixtureLookup() 调用之前（行 ' + modeLine + ' vs ' + callLine + '）')
})

// ---------- 30（20260914 第二次返工）：★contexts 不是 system —— 独立 [上下文] 盒 + system 小计只算 sections ----------
// 真机证据（派单方实测）：renderPrompt 只拼 sections（system-prompt/src/index.ts:263-268）；
// contexts 走 renderContextSnapshot（同文件 :275-291）拼成一条独立消息（首行 Current runtime context…）。
// C4_CTX 夹具在 ★23 前定义（数字照抄真机案例）。
await check('★30 contexts≠system：system 小计 === Σ sections.chars（1,938，⛔ 不含 contexts 的 386）；contexts 不在 [system] 盒、在独立 [上下文] 盒（2/2 检出）；[system] 检出计数只数 sections（4/4）', () => {
  const d = pm.buildMapFromSections(C4_CTX, { messagesText: null })
  // ① 小计口径：system 只算 sections
  assert.equal(d.totals.systemChars, 1938, 'system 小计必须 = Σ sections.chars = 1,938（实测是 ' + d.totals.systemChars + '）—— ⛔ 不许把 contexts 混进来')
  assert.notEqual(d.totals.systemChars, 1938 + 386, 'system 小计混入了 contexts（2,324 = 1,938 + 386）—— 这就是真机上的硬错')
  assert.equal(d.totals.contextCount, 2, 'contexts 段数不对')
  assert.equal(d.totals.contextChars, 386, 'contexts 字数不对（233+153=386）')
  // ② contexts 不在 [system] 盒；在独立 [上下文] 盒
  assert.equal(d.boxes.map((b) => b.id).join(','), 'system,contexts,tools,messages', '四盒结构不对：' + d.boxes.map((b) => b.id).join(','))
  const sysBox = d.boxes.find((b) => b.id === 'system')
  const ctxBox = d.boxes.find((b) => b.id === 'contexts')
  assert.deepEqual(sysBox.blocks.filter((b) => b.key.indexOf('ctx:') === 0).map((b) => b.key), [],
    'contexts 淗进了 [system] 盒（ctx:* 块出现在 system 框）—— renderPrompt 只拼 sections，contexts 是独立消息')
  assert.deepEqual(ctxBox.blocks.filter((b) => !b.dashed).map((b) => b.label), ['sandbox:policy', 'approval:policy'], '[上下文] 盒内容不对')
  // ③ [system] 检出计数只数 sections（4 段，其中 1 个空段照旧「空」）；[上下文] 自己数自己的（2/2）
  assert.equal(sysBox.blocks.filter((b) => !b.dashed).length, 4, '[system] 盒块数应只含 4 个 sections')
  assert.equal(findBlock(d, 'sec:context:file-reference').empty, true, '空段规则不许变（0 字照旧「空」）')
  // ④ 渲染层：盒标题口径 + 检出计数 + 小计行
  const tree = fakeReact.createElement(pm.PromptMapView, { data: d, state: { status: 'ready', data: d, error: '' } })
  const text = visibleText(tree)
  const ctxBoxNode = collectNodes(tree, (n) => n.props && n.props['data-pm'] === 'box' && n.props['data-pm-box'] === 'contexts', [])[0]
  assert.ok(ctxBoxNode, '[上下文] 盒没渲染')
  assert.ok(visibleText(ctxBoxNode).includes('运行上下文快照') && visibleText(ctxBoxNode).includes('独立字段，不在 system 里'), '[上下文] 盒标题缺口径')
  assert.ok(visibleText(ctxBoxNode).includes('独立消息') && visibleText(ctxBoxNode).includes('Current runtime context'), '[上下文] 盒缺「作为一条独立消息发出（首行 Current runtime context…），见 [messages]」口径')
  assert.ok(visibleText(ctxBoxNode).includes('2/2 检出'), '[上下文] 检出计数不对')
  const sysBoxNode = collectNodes(tree, (n) => n.props && n.props['data-pm'] === 'box' && n.props['data-pm-box'] === 'system', [])[0]
  assert.ok(visibleText(sysBoxNode).includes('4/4 检出'), '[system] 检出计数应只数 sections（4/4）：' + visibleText(sysBoxNode).split('\n')[0])
  // M11：小计行改成「|」分段 + 占比跟在各自字数后面（上下文 386 不再是 system 的一部分）
  assert.ok(/小计：system 1,938 字（[\d.]+%） \| 上下文 2 段 \/ 386 字（[\d.]+%）/.test(text),
    '小计行口径不对：' + (text.split('\n').find((l) => l.includes('小计')) || '').slice(0, 120))
  // ⑤ 分隔符口径进 system 格 title：Σ + (非空段数-1)×2 = 官方 renderPrompt 长度（1,938 + 2×2 = 1,942）
  assert.equal(d.totals.systemNonEmpty, 3, '非空 sections 数不对（空段 context:file-reference 不计位）')
  const sysSpan = collectNodes(tree, (n) => n.props && typeof n.props.title === 'string' && n.props.title.includes('只算 sections'), [])[0]
  assert.ok(sysSpan, 'system 小计格缺分隔符口径 title')
  assert.ok(sysSpan.props.title.includes("1,938 + 2×2 个 '\\n\\n' = 1,942"), '分隔符公式不对：' + sysSpan.props.title)
})

// ---------- 31（派单方 20260914 M7）：★去掉依据/口径赘文 —— 可见文字零元话，出处退悬停 title，data-* 原样 ----------
// 口径（任务书 §0）：信息留着，元话去掉。§3 的诚实降级文案一个不许删（反向断言防删过头）。
await check('★31 M7 去赘文：地图与抽屉的可见文字不再出现「依据：/·注册定义/判断依据/最权威口径/如实展示，不编」；出处仍在悬停 title 与 data-pm-mutbadge（自检台契约不动）；§3 诚实降级文案仍在', () => {
  // ① 地图（捕获路径）：行徽标可见只留 静态/★每轮/未知
  const dCap = pm.buildMapFromSections(C4_CAPTURED, { messagesText: MSG_FULL_L2 })
  const tree = fakeReact.createElement(pm.PromptMapView, { data: dCap, state: { status: 'ready', data: dCap, error: '' } })
  const mapText = visibleText(tree)
  for (const bad of ['·注册定义', '·header相等', '依据：', '判断依据', '最权威口径', '如实展示，不编']) {
    assert.ok(!mapText.includes(bad), 'M7：地图可见文字出现赘文「' + bad + '」')
  }
  // data-pm-mutbadge（自检台靠它断言）与 title（悬停出处）原样保留 —— ⛔ 都不许动
  const badge = collectNodes(tree, (n) => n.props && n.props['data-pm'] === 'mutbadge' && n.props['data-pm-mutbadge'] === 'static·注册定义', [])[0]
  assert.ok(badge, 'data-pm-mutbadge 属性不许动（static·注册定义 必须还在）')
  assert.ok(String(badge.props.title).includes('（依据：注册定义）'), '出处信息必须留在徽标悬停 title 里：' + String(badge.props.title).slice(0, 80))
  // ② 真实链路进抽屉：buildMapFromSections 产出的块 → 抽屉可见文字零元话，出处进 mut-line title
  const block = dCap.boxes[0].blocks.find((b) => b.label === 'roleplay:policy')
  assert.ok(block, '捕获块缺失')
  assert.ok(block.mutWhy.includes('段定义（运行时 PromptSection.text 是否函数）'), 'M7：mutWhy 该保留出处信息：' + block.mutWhy)
  assert.ok(!block.mutWhy.includes('判断依据') && !block.mutWhy.includes('最权威口径'), 'M7：mutWhy 文案该洗掉元话：' + block.mutWhy)
  const body = pm.pmSectionDrawerBody(block, { kind: 'text', footer: '来源：记忆库路径切片 [4166, 2981]', text: 'x' }, '')
  const bodyText = visibleText(body)
  for (const bad of ['依据', '判断依据', '最权威口径', '如实展示', '不编', '口径']) {
    assert.ok(!bodyText.includes(bad), 'M7：抽屉可见文字出现赘文「' + bad + '」：' + bodyText.slice(0, 160))
  }
  const mutLine = collectNodes(body, (n) => n.props && n.props['data-l3'] === 'mut-line', [])[0]
  assert.ok(mutLine && String(mutLine.props.title || '').includes('段定义（运行时'), 'M7：mutWhy 出处必须留在抽屉 mut-line 的悬停 title 里')
  // ③ 反向断言（防删过头）：§3 的诚实降级文案必须仍然在
  const stN = pm.pmSectionTextState({ ok: true, text: null, offset: null, chars: 10, unavailable: 'no-offset' }, '')
  assert.equal(stN.footer, '该段内容不可用（未记录位置）', '⛔ §3 诚实降级文案不许删')
  const bodyN = pm.pmSectionDrawerBody(block, stN, '')
  assert.ok(visibleText(bodyN).includes('该段内容不可用（未记录位置）'), '§3「该段内容不可用（未记录位置）」必须仍渲染')
  assert.ok(bodyText.includes('来源：记忆库路径切片') || visibleText(body).includes('来源：记忆库路径切片'), '§3「来源：记忆库路径切片」必须仍渲染')
  const stI = pm.pmSectionTextState({ ok: true, text: null, source: 'inferred', unavailable: 'no-capture-record' }, '')
  assert.equal(stI.footer, '文本推断 · 边界可能不准', '§3「文本推断 · 边界可能不准」不许删')
  const treeFb = renderMap(data1)
  // ★ M10（20260914 用户拍板）：行内那串口径自证（「未检出…不把它说成不存在」）**必须不再出现** ——
  //   它没有消失，而是**搬到了 `?` 事实说明书**里讲一次（由 _selftest-editor-nav.mjs ★4 锁住：
  //   说明书必须含「未检出（…）」≠ 不存在）。这里同时钉住两头：行内没了、说明书有。
  assert.equal(visibleText(treeFb).includes('不把它说成不存在'), false, 'M10：行内口径自证该删掉（改到 ? 说明书里讲）')
  assert.ok(visibleText(treeFb).includes('未检出'), 'M10：行内仍要如实写「未检出（…）」—— 只是不再附一长串道理')
  const guideText = (win.__def.factory(() => fakeReact).__editorNav
    ? win.__def.factory(() => fakeReact).__editorNav.editorHelpSections().map((s) => s.lines.join('\n')).join('\n')
    : '')
  assert.ok(guideText.includes('≠ 不存在'), 'M10：诚实边界必须仍在 —— 只是搬到了 ? 说明书里')
})

// ---------- 31（20260914 结构性修复）：归属文案里**不许出现 order 数字** ----------
// 为什么非有这条：WHO_* 常量同时喂给「文本推断路径」（SYS_SECTION_DEFS —— 那条路**没有 order 数据**）
// 与「装配地图图例」（PROMPT_MAP_DEFS —— 图例自带 order/orderNum，数字校对过）。
// 把数字写进共享文案 ⇒ 推断路径会"继承"一个具体数字，于是漂了：
// 真人踩到 —— harness identity 的归属写成 `order ≈ -100`，而真机捕获是 **-1000**。
// ⇒ 归属只说"谁"；**数字一律来自捕获**，没有捕获就写"未知（按文本推断）"。
await check('★31 归属文案里零 order 数字：WHO_* 常量不得含「order/≈ + 数字」（数字只能来自捕获）', () => {
  const srcWho = readFileSync(path.join(here, 'lib', 'client.js'), 'utf8')
  const lines = srcWho.split('\n')
  const offenders = []
  for (let i = 0; i < lines.length; i++) {
    const m = /const\s+WHO_[A-Z_]+\s*=\s*(['"])(.*?)\1/.exec(lines[i])
    if (m === null) continue
    if (/order\s*[≈~]?\s*-?\d|≈\s*-?\d/.test(m[2])) offenders.push(`第 ${i + 1} 行：${m[2]}`)
  }
  assert.equal(offenders.length, 0,
    '归属文案里出现了 order 数字（必须来自捕获数据，不能手写）：\n    ' + offenders.join('\n    '))
  // ★ 反证：这把尺子必须量得出**当年那个错串**，否则它只是橡皮图章
  assert.ok(/order\s*[≈~]?\s*-?\d/.test('DSH 核心（harness identity，order ≈ -100）'),
    '反证失败：这把尺子量不出旧的错串（≈-100），说明它拦不住这类漂移')
})

// ---------- 32（20260914）：归属**按段名前缀**认 + 两条"近似"标注 ----------
// 为什么非有：以前"谁注册的"既有手写常量表、又有捕获里的通用话术，手写那份漂过
// （identity 的 order 写成 ≈-100）。现在归属只有一个来源 —— **段名本身**。
await check('★32 归属按前缀认：dma:*=本插件、pmp-dsh-tavern*=上游、harness:*=DSH 核心、认不出=null（⛔ 不猜）', () => {
  const pm = win.__def.factory(() => fakeReact).__promptMap ?? {}
  const own = pm.pmSectionOwner
  assert.equal(typeof own, 'function', 'pmSectionOwner 没导出给自检台')
  assert.ok(own('dma:card:description').includes('本插件'), 'dma:* 应认成本插件注册')
  assert.ok(own('pmp-dsh-tavern:profile').includes('pmp-dsh-tavern'), 'pmp-dsh-tavern* 应认成上游')
  assert.ok(own('rp:policy').includes('pmp-dsh-tavern'), 'rp:* 应认成上游的 RP 策略段')
  assert.ok(own('harness:identity').includes('DSH 核心'), 'harness:* 应认成 DSH 核心')
  assert.ok(own('tool:pwsh').includes('DSH 核心'), 'tool:* 应认成 DSH 核心')
  assert.equal(own('who-knows:whatever'), null, '认不出的前缀必须返回 null（⛔ 不许猜一个归属出来）')
  // ★ 与 ★31 同一条纪律：这张新表里也不许出现 order 数字（数字一律来自捕获）
  const bad = (pm.PM_SECTION_OWNERS ?? []).filter(([, label]) => /order\s*[≈~]?\s*-?\d|≈\s*-?\d/.test(String(label)))
  assert.deepEqual(bad, [], '前缀归属表里出现了 order 数字：' + JSON.stringify(bad))
})

await check('★32 两条"近似"如实标注：PHI 与 depth 各有 honesty，普通卡字段没有', () => {
  const pm = win.__def.factory(() => fakeReact).__promptMap ?? {}
  const h = pm.pmSectionHonesty
  assert.equal(typeof h, 'function', 'pmSectionHonesty 没导出给自检台')
  const phi = h('dma:card:post-history-instructions')
  const dep = h('dma:card:depth-prompt')
  assert.ok(typeof phi === 'string' && phi.includes('近似') && phi.includes('玩家消息'),
    'PHI 的标注必须点明"DSH 没有玩家消息之后的槽位"：' + phi)
  assert.ok(typeof dep === 'string' && dep.includes('近似') && dep.includes('深度'), 'depth 的标注要点明深度插入：' + dep)
  assert.equal(h('dma:card:description'), null, '普通卡字段不该有"近似"标注')
  // ★ 反证：标注缺失时，同一条判据必须红（证明它不是空跑）
  const stripped = () => null // 模拟"有人把 PHI 的标注删了"
  assert.throws(() => {
    const v = stripped()
    if (!(typeof v === 'string' && v.includes('近似'))) throw new Error('PHI 缺"近似"标注')
  }, /近似/, '反证失败：标注缺失时这条判据没红')
})

console.log('== 汇总：' + pass + ' 通过 / ' + fails.length + ' 失败 ==')
if (fails.length > 0) {
  console.log('失败项：\n  - ' + fails.join('\n  - '))
  process.exit(1)
}
