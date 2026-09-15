#!/usr/bin/env node
/**
 * _selftest-keep-first-round.mjs —— 「保留第一轮问答（DeepSeek 思维模式专用）」行为级自检。
 *
 * 跑法：node _selftest-keep-first-round.mjs   （全程临时目录，⛔ 不碰 ~/.dsh，⛔ 不联网）
 *
 * 覆盖（任务书 §6，一条不省）：
 *   R1  仍在 surface ⇒ 不注入（正断言 + 反证：去掉"仍在 ⇒ 跳过"⇒ 红）
 *   R2  已 shadowed ⇒ 注入原文，逐字等于 fixture（正断言 + 反证：换成摘要文本 ⇒ 红）
 *   R3  判定失败/未知 ⇒ 照注入 fail-open（正断言 + 反证：改 fail-closed ⇒ 红）
 *   R4  第一轮起点 = 官方可压起点 firstIdx（正断言 + 反证：改成"第一个 turn/start"⇒ 红）
 *   R5  protectSeqs 含第一轮全部 seq（正断言 + 反证：丢一个 seq ⇒ 红）
 *   R6  DMA_RECORD_HEAD 走槽位 +1，槽位缺失才回落并标 fallback（正断言 + 反证：主路径硬编码 58 ⇒ 红）
 *   R7  开关来自插件 config 真值表 4 组（正断言 + 反证：改成读预设行 ⇒ 红）
 *   R8  隐私：fixture 前 12 字在 自检输出 / 模块 / 自检台 三处零命中（无需求红）
 *   另：两份纯函数副本（lib 核心 / preset 模块内联）跑同一条套件防漂移；
 *       伪宿主 ctx 走一遍 apply()（provider 级 R1/R2/开关/order/看守）；
 *       写面（三件套落盘/幂等/备份）与挂载行纯函数。
 * 反证是真·变体测试：把 lib/keep-first-round.js 按锚点做文本替换、写成临时模块再 import
 * —— 变体若意外变绿，本自检以 FAIL 收场（🔴 本身是被断言的预期结果）。
 */

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))

// ---- 输出捕获（R8：自检输出里不许出现 fixture 前 12 字）--------------------------------
const ALL_OUTPUT = []
for (const level of ['log', 'warn', 'error']) {
  const orig = console[level].bind(console)
  console[level] = (...args) => {
    const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a) ?? String(a))).join(' ')
    ALL_OUTPUT.push(line)
    orig(...args)
  }
}

// ---- 计数器与报告小工具 ----------------------------------------------------------------
let pass = 0
let failCount = 0
const redEvidence = []
function check(id, desc, cond, detail) {
  if (cond) {
    pass++
    console.log('  PASS ' + id + ' ' + desc)
  } else {
    failCount++
    console.log('  FAIL ' + id + ' ' + desc + (detail ? ' —— ' + detail : ''))
  }
}

// ---- 夹具（运行时合成；⛔ 任何真实会话/角色卡内容都不进本文件）--------------------------
const FIX_ID = 'KFR-' + Math.random().toString(36).slice(2, 8).toUpperCase() + '-FIX'
const FIXTURE_OPENING = FIX_ID + '（合成开场白夹具，非真实会话）' + '帷幕缓缓拉开。'.repeat(3)
const FIXTURE_REPLY = FIX_ID + '（合成开场回复夹具，非真实会话）' + '幕布升起，灯光暗下。'.repeat(3)
const FIXTURE_FIRST_ROUND = FIXTURE_OPENING + '\n' + FIXTURE_REPLY
const FIXTURE_PREFIX12 = FIXTURE_FIRST_ROUND.slice(0, 12)

function mkNode(seq, type, surface, text) {
  return { seq, type, surface, text }
}
/** 标准会话面：system 开头 + 两轮问答；第二轮已 shadowed（不影响第一轮判定）。 */
const NODES = [
  mkNode(0, 'system/message', 'current', '合成 system 设定（官方保护的位置 0）'),
  mkNode(1, 'user/message', 'current', FIXTURE_OPENING),
  mkNode(2, 'assistant/message', 'current', FIXTURE_REPLY),
  mkNode(3, 'turn/end', 'current', ''),
  mkNode(4, 'user/message', 'shadowed', '第二轮用户消息（第一轮区间之外）'),
  mkNode(5, 'assistant/message', 'shadowed', '第二轮回复（第一轮区间之外）'),
  mkNode(6, 'turn/end', 'shadowed', ''),
]
/** 无前置 system 的会话面：firstIdx 应为 0。 */
const NODES_NO_SYS = [
  mkNode(0, 'user/message', 'current', FIXTURE_OPENING),
  mkNode(1, 'assistant/message', 'current', FIXTURE_REPLY),
  mkNode(2, 'turn/end', 'current', ''),
]
/** 开场问候在第一个 turn/start 之前（方案 §1：应一并算进第一轮）。 */
const NODES_ALT = [
  mkNode(0, 'system/message', 'current', 'sys'),
  mkNode(1, 'assistant/message', 'current', '开场问候（turn/start 之前，官方口径应并入第一轮）'),
  mkNode(2, 'turn/start', 'current', ''),
  mkNode(3, 'user/message', 'current', '玩家第一条'),
  mkNode(4, 'assistant/message', 'current', '回复'),
  mkNode(5, 'turn/end', 'current', ''),
]
const ALL_CURRENT = new Map([
  [1, { surface: 'current' }],
  [2, { surface: 'current' }],
  [3, { surface: 'current' }],
])
const SEQ1_SHADOWED = new Map([
  [1, { surface: 'shadowed' }],
  [2, { surface: 'current' }],
  [3, { surface: 'current' }],
])

// ---- 变体加载（文本替换 → 临时模块 → import；文件名唯一避开 ESM 缓存）------------------
const LIB_SRC = readFileSync(join(ROOT, 'lib', 'keep-first-round.js'), 'utf8')
async function loadVariant(mutatedSrc, tag) {
  const f = join(tmpdir(), 'dma-kfr-mutant-' + tag + '-' + Math.random().toString(36).slice(2) + '.mjs')
  writeFileSync(f, mutatedSrc)
  try {
    return await import(pathToFileURL(f).href)
  } finally {
    rmSync(f, { force: true })
  }
}
function mutateLib(anchor, replacement, tag) {
  if (!LIB_SRC.includes(anchor)) throw new Error('反证' + tag + '锚点漂移（源码改了，自检锚点要同步）：' + anchor)
  return LIB_SRC.replace(anchor, replacement)
}

// 被测模块（真身 ×2）：lib 纯函数核心 + preset 模块内联副本
const core = await import('./lib/keep-first-round.js')
const mod = await import('./preset-modules/keep-first-round.js')

// ---- 同一条行为级套件，跑在两份副本上（谁漂移谁红）--------------------------------------
function runPureSuite(K, tag) {
  const p = (id, desc, cond, detail) => check(tag + '-' + id, desc, cond, detail)

  // R6：order 解析
  const rSlot = K.resolveRecordHeadOrder(() => 10200)
  p('R6a', '槽位 10200 ⇒ order 10201 且 source=slot', rSlot.order === 10201 && rSlot.source === 'slot' && rSlot.slot === 10200, JSON.stringify(rSlot))
  const rMiss = K.resolveRecordHeadOrder(() => undefined)
  p('R6b', '槽位 undefined ⇒ 兜底 10201 且如实标 fallback', rMiss.order === 10201 && rMiss.source === 'fallback' && rMiss.slot === null, JSON.stringify(rMiss))
  const rThrow = K.resolveRecordHeadOrder(() => { throw new Error('宿主没有这个槽') })
  p('R6c', '槽位抛错 ⇒ 兜底 + fallback', rThrow.order === 10201 && rThrow.source === 'fallback', JSON.stringify(rThrow))
  const rJunk = K.resolveRecordHeadOrder(() => '10200')
  p('R6d', '槽位返回非数 ⇒ 兜底 + fallback', rJunk.source === 'fallback' && rJunk.order === 10201, JSON.stringify(rJunk))

  // R4：第一轮区间起点 = 官方可压起点
  const range = K.firstRoundRange(NODES)
  p('R4a', '首节点 system/message ⇒ firstIdx=1，终点=第 1 个 turn/end(seq3)', range !== null && range.startIdx === 1 && range.endIdx === 3, JSON.stringify(range))
  const rangeNoSys = K.firstRoundRange(NODES_NO_SYS)
  p('R4b', '无前置 system ⇒ firstIdx=0', rangeNoSys !== null && rangeNoSys.startIdx === 0 && rangeNoSys.endIdx === 2, JSON.stringify(rangeNoSys))
  const noEnd = K.firstRoundRange(NODES.slice(0, 3))
  p('R4c', '没有 turn/end ⇒ null（第一轮还没结束）', noEnd === null, JSON.stringify(noEnd))
  p('R4d', '开场问候（turn/start 之前）并入第一轮', (() => {
    const r = K.firstRoundRange(NODES_ALT)
    return r !== null && r.startIdx === 1 && r.endIdx === 5
  })(), JSON.stringify(K.firstRoundRange(NODES_ALT)))

  // R5：protectSeqs
  p('R5a', 'protectSeqs = 第一轮全部 seq（1,2,3）', JSON.stringify(K.firstRoundProtectSeqs(NODES)) === '[1,2,3]', JSON.stringify(K.firstRoundProtectSeqs(NODES)))
  p('R5b', '第二轮的 seq 不在清单里（4,5,6 不出现）', !K.firstRoundProtectSeqs(NODES).some((s) => s >= 4), JSON.stringify(K.firstRoundProtectSeqs(NODES)))
  p('R5c', 'ALT 面 = [1,2,3,4,5]（问候在内）', JSON.stringify(K.firstRoundProtectSeqs(NODES_ALT)) === '[1,2,3,4,5]', JSON.stringify(K.firstRoundProtectSeqs(NODES_ALT)))
  p('R5d', '没有完整第一轮 ⇒ []', JSON.stringify(K.firstRoundProtectSeqs(NODES.slice(0, 3))) === '[]', JSON.stringify(K.firstRoundProtectSeqs(NODES.slice(0, 3))))

  // R2 素材：原文逐字
  p('R2a', 'firstRoundText 逐字等于 fixture（两楼 \n 连接）', K.firstRoundText(NODES) === FIXTURE_FIRST_ROUND, 'len=' + K.firstRoundText(NODES).length)
  p('R2b', '没有区间 ⇒ 空串', K.firstRoundText(NODES.slice(0, 3)) === '', 'len=' + K.firstRoundText(NODES.slice(0, 3)).length)

  // R1/R2/R3：决策真值表
  p('R1a', '全 current ⇒ 不注入', (() => { const d = K.decideFirstRound({ enabled: true, seqs: [1, 2, 3], bySeq: ALL_CURRENT }); return d.inject === false && d.reason === 'still-on-surface' })(), JSON.stringify(K.decideFirstRound({ enabled: true, seqs: [1, 2, 3], bySeq: ALL_CURRENT })))
  p('R2c', '任一 shadowed ⇒ 注入', (() => { const d = K.decideFirstRound({ enabled: true, seqs: [1, 2, 3], bySeq: SEQ1_SHADOWED }); return d.inject === true && d.reason === 'shadowed' })(), JSON.stringify(K.decideFirstRound({ enabled: true, seqs: [1, 2, 3], bySeq: SEQ1_SHADOWED })))
  p('R3a', 'bySeq 不可得（null）⇒ 照注入（fail-open）', (() => { const d = K.decideFirstRound({ enabled: true, seqs: [1, 2, 3], bySeq: null }); return d.inject === true && d.reason === 'unreadable' })(), JSON.stringify(K.decideFirstRound({ enabled: true, seqs: [1, 2, 3], bySeq: null })))
  p('R3b', 'bySeq 缺条目（未知 surface）⇒ 照注入', (() => { const d = K.decideFirstRound({ enabled: true, seqs: [1, 2, 3], bySeq: new Map([[1, { surface: 'current' }]]) }); return d.inject === true && d.reason === 'unknown-surface' })(), JSON.stringify(K.decideFirstRound({ enabled: true, seqs: [1, 2, 3], bySeq: new Map([[1, { surface: 'current' }]]) })))
  p('D1', '开关关 ⇒ 不注入（优先级最高）', (() => { const d = K.decideFirstRound({ enabled: false, seqs: [1], bySeq: SEQ1_SHADOWED }); return d.inject === false && d.reason === 'switch-off' })(), JSON.stringify(K.decideFirstRound({ enabled: false, seqs: [1], bySeq: SEQ1_SHADOWED })))
  p('D2', '没有完整第一轮 ⇒ 不注入（no-first-round）', (() => { const d = K.decideFirstRound({ enabled: true, seqs: [], bySeq: ALL_CURRENT }); return d.inject === false && d.reason === 'no-first-round' })(), JSON.stringify(K.decideFirstRound({ enabled: true, seqs: [], bySeq: ALL_CURRENT })))

  // R7：开关只认插件 config
  p('R7a', 'config: keepFirstRound.enabled=true ⇒ 开', K.readSwitch({ keepFirstRound: { enabled: true } }) === true, String(K.readSwitch({ keepFirstRound: { enabled: true } })))
  p('R7b', 'config: enabled=false ⇒ 关', K.readSwitch({ keepFirstRound: { enabled: false } }) === false, String(K.readSwitch({ keepFirstRound: { enabled: false } })))
  p('R7c', 'config: 缺 keepFirstRound ⇒ 关（默认关）', K.readSwitch({}) === false && K.readSwitch(null) === false && K.readSwitch(undefined) === false, '')
  p('R7d', 'config: 非布尔（"true"/1）⇒ 关（严格 === true）', K.readSwitch({ keepFirstRound: { enabled: 'true' } }) === false && K.readSwitch({ keepFirstRound: { enabled: 1 } }) === false, '')
  p('R7e', '★ 预设行形状（modules[]）不认 ⇒ 关', K.readSwitch({ modules: [{ id: 'keep-first-round', config: { enabled: true } }] }) === false, String(K.readSwitch({ modules: [{ id: 'keep-first-round', config: { enabled: true } }] })))

  // R2 渲染：前言 + 原文 + 截断如实标注
  const rendered = K.renderPinnedOpening(FIXTURE_FIRST_ROUND)
  p('R2d', '渲染含 <pinnedOpening> 标签与一行前言', rendered.startsWith('<pinnedOpening>\n') && rendered.endsWith('</pinnedOpening>') && rendered.includes(K.PINNED_OPENING_PREAMBLE), 'head=' + rendered.slice(0, 16))
  p('R2e', '渲染逐字包含 fixture 原文', rendered.includes(FIXTURE_FIRST_ROUND), 'contains=' + String(rendered.includes(FIXTURE_FIRST_ROUND)))
  p('R2f', '空串/非字符串 ⇒ 不渲染', K.renderPinnedOpening('') === '' && K.renderPinnedOpening(undefined) === '', '')
  const long = '字'.repeat(8500)
  const clipped = K.renderPinnedOpening(long)
  p('H1', '超 8000 字 ⇒ 截断并如实标注「已截断」', clipped.includes('已截断') && clipped.length < long.length, 'len=' + clipped.length)

  // 看守
  const usurpers = K.findOrderUsurpers(
    [{ name: 'other:late', order: 10500 }, { name: K.KEEP_FIRST_ROUND_SECTION_NAME, order: 99999 }, { name: 'ok:early', order: 56 }, { name: 'noOrder' }],
    10201,
    K.KEEP_FIRST_ROUND_SECTION_NAME,
  )
  p('G1', '看守：非我们的段 order ≥ 我们的 ⇒ 恰好点名 other:late@10500', usurpers.length === 1 && usurpers[0].name === 'other:late' && usurpers[0].order === 10500, JSON.stringify(usurpers))
  p('G2', '看守：不咬自己、容忍形状残缺', K.findOrderUsurpers(null, 10201, 'x').length === 0 && K.findOrderUsurpers([], 10201, 'x').length === 0, '')

  // surfaceNodesFromDocs：log-only 剔除 + 排序 + surface 不猜
  const nodesFromDocs = K.surfaceNodesFromDocs([
    { seq: 3, type: 'turn/end', surface: 'current', text: '' },
    { seq: 1, type: 'user/message', surface: 'current', text: 'a' },
    { seq: 2, type: 'tool/result', surface: 'log-only', text: 'b' },
    { seq: 4, surface: 'weird', text: 'c' },
  ])
  p('N1', 'log-only 剔除、seq 升序、未知 surface ⇒ null（不猜成 current）', JSON.stringify(nodesFromDocs.map((n) => [n.seq, n.surface])) === '[[1,"current"],[3,"current"],[4,null]]', JSON.stringify(nodesFromDocs.map((n) => [n.seq, n.surface])))
}

console.log('== 纯函数套件 · lib/keep-first-round.js（唯一事实源）==')
runPureSuite(core, 'lib')
console.log('== 纯函数套件 · preset-modules/keep-first-round.js（内联副本防漂移）==')
runPureSuite(mod, 'mod')

// ---- 伪宿主：apply() 一遍（provider 级 R1/R2/开关/order/看守/日志标注）------------------
console.log('== 伪宿主 apply() · provider 级 ==')
function makeFakeCtx({ slotOrder = 10200, sq = null, sectionList = null, exposeSections = false } = {}) {
  const registered = []
  const handlers = {}
  const sp = {
    section: (def) => { registered.push(def); return () => {} },
  }
  if (slotOrder !== null) sp.getSectionOrder = () => slotOrder
  if (exposeSections) sp.sections = () => sectionList
  return { registered, handlers, ctx: { systemPrompt: sp, effect: (fn) => fn(), on: (ev, fn) => { handlers[ev] = fn }, get: (svc) => (svc === 'sessionQuery' ? sq : null) } } }
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms))

const homeA = mkdtempSync(join(tmpdir(), 'dma-kfr-homeA-'))
const cfgDirA = join(homeA, 'dsh-memory-archive')
mkdirSync(cfgDirA, { recursive: true })
const cfgFileA = join(cfgDirA, 'config.json')
writeFileSync(cfgFileA, JSON.stringify({ keepFirstRound: { enabled: true } }) + '\n', 'utf8')
const DOCS = NODES.map((n) => ({ ...n })) // fakeSq 的会话面（可变，模拟 compaction）
const fakeSq = { filterEvents: async () => DOCS }
const hostA = makeFakeCtx({ sq: fakeSq })
try {
  mod.apply(hostA.ctx, { dshHome: homeA, refreshTimeoutMs: 1500 })
  const sec = hostA.registered[0]
  check('P1', '段已注册：name=rp:firstRound、order=10201（槽位 10200+1）', sec.name === 'rp:firstRound' && sec.order === 10201, JSON.stringify({ name: sec.name, order: sec.order }))
  check('P2', '日志如实标注来源=官方槽位', ALL_OUTPUT.some((l) => l.includes('来源：官方槽位 DEPLOYMENT_PERSONA_SUFFIX=10200 + 1')), '')
  const provider = sec.text
  check('P3', '还没刷新 ⇒ 无缓存 ⇒ 不注入', provider({ agent: { id: 's1' } }) === '', '')
  hostA.handlers['session/event']({ header: { id: 's1' } }, { type: 'turn/end' })
  await tick()
  check('P4', 'R1·provider：第一轮仍全部 current ⇒ 不注入', provider({ agent: { id: 's1' } }) === '', '')
  DOCS[1].surface = 'shadowed' // 官方压缩吃掉第一轮的 user 楼
  hostA.handlers['session/event']({ header: { id: 's1' } }, { type: 'turn/end' })
  await tick()
  const out2 = provider({ agent: { id: 's1' } })
  check('P5', 'R2·provider：已 shadowed ⇒ 注入，且逐字含 fixture 原文', out2.includes('<pinnedOpening>') && out2.includes(FIXTURE_FIRST_ROUND), 'contains=' + String(out2.includes(FIXTURE_FIRST_ROUND)))
  writeFileSync(cfgFileA, JSON.stringify({ keepFirstRound: { enabled: false } }) + '\n', 'utf8')
  check('P6', '开关改 config（不改预设/不重启）⇒ provider 下一轮即停', provider({ agent: { id: 's1' } }) === '', '')
  writeFileSync(cfgFileA, JSON.stringify({ keepFirstRound: { enabled: true } }) + '\n', 'utf8')
  check('P7', '开关改回 ⇒ 下一轮恢复注入（仍逐字）', provider({ agent: { id: 's1' } }).includes(FIXTURE_FIRST_ROUND), '')
  rmSync(cfgFileA)
  check('P8', 'config 文件没了 ⇒ 默认关 ⇒ 不注入', provider({ agent: { id: 's1' } }) === '', '')
} finally {
  rmSync(homeA, { recursive: true, force: true })
}

// 兜底值日志 + 看守日志（各自独立的伪宿主）
const homeB = mkdtempSync(join(tmpdir(), 'dma-kfr-homeB-'))
try {
  const hostB = makeFakeCtx({ slotOrder: null }) // 宿主没有 getSectionOrder
  mod.apply(hostB.ctx, { dshHome: homeB })
  check('P9', '槽位缺席 ⇒ order=兜底 10201 且日志如实标注「兜底值」', hostB.registered[0].order === 10201 && ALL_OUTPUT.some((l) => l.includes('来源：兜底值')), JSON.stringify({ order: hostB.registered[0].order }))
} finally {
  rmSync(homeB, { recursive: true, force: true })
}
const hostC = makeFakeCtx({ exposeSections: true, sectionList: [{ name: 'someone:late', order: 10500 }, { name: 'rp:firstRound', order: 10201 }] })
mod.apply(hostC.ctx, { dshHome: mkdtempSync(join(tmpdir(), 'dma-kfr-homeC-')) })
check('P10', '看守·apply 级：非我们的段 order ≥ 我们的 ⇒ 明确 warn「已被顶掉」', ALL_OUTPUT.some((l) => l.includes('聊天记录区开头已被顶掉') && l.includes('someone:late@10500')), '')

// ---- 反证（R1–R7：变体必须变红；变体若绿 ⇒ 本自检 FAIL）--------------------------------
console.log('== 反证（真·变体测试，🔴 是预期结果）==')
async function expectRed(id, desc, variantSrc, tag, assertFn) {
  try {
    const V = await loadVariant(variantSrc, tag)
    let held
    try {
      held = assertFn(V) === true
    } catch (e) {
      held = 'throw: ' + String((e && e.message) || e)
    }
    const red = held === false
    check(id, desc, red, '变体下正断言结果=' + String(held) + '（期望 false=红）')
    if (red) redEvidence.push('反证' + tag + '红证：变体导入后正断言变红（' + id + '）')
  } catch (e) {
    failCount++
    console.log('  FAIL ' + id + ' ' + desc + ' —— 变体加载失败：' + String((e && e.message) || e))
  }
}

await expectRed('M-R1', '反证R1：去掉"仍在 ⇒ 跳过"（改成照注入）⇒ R1 红',
  mutateLib("  return { inject: false, reason: 'still-on-surface' }", "  return { inject: true, reason: 'still-on-surface' } // 反证R1", 'R1'),
  'R1',
  (V) => V.decideFirstRound({ enabled: true, seqs: [1, 2, 3], bySeq: ALL_CURRENT }).inject === false)

await expectRed('M-R2', '反证R2：注入内容换成摘要文本 ⇒ R2 红',
  mutateLib('  const body = within ? text : text.slice(0, PINNED_OPENING_MAX_CHARS)', "  const body = '（摘要：开场原文已被收进摘要）' // 反证R2", 'R2'),
  'R2',
  (V) => V.renderPinnedOpening(FIXTURE_FIRST_ROUND).includes(FIXTURE_FIRST_ROUND))

await expectRed('M-R3', '反证R3：fail-open 改 fail-closed ⇒ R3 红',
  mutateLib("  if (!(i.bySeq instanceof Map)) return { inject: true, reason: 'unreadable' }", "  if (!(i.bySeq instanceof Map)) return { inject: false, reason: 'unreadable' } // 反证R3", 'R3'),
  'R3',
  (V) => V.decideFirstRound({ enabled: true, seqs: [1, 2, 3], bySeq: null }).inject === true)

await expectRed('M-R4', '反证R4：起点改成"第一个 turn/start" ⇒ R4 红',
  mutateLib("  const firstIdx = nodes[0]?.type === 'system/message' ? 1 : 0", "  const firstIdx = Math.max(0, nodes.findIndex((n) => n?.type === 'turn/start')) // 反证R4", 'R4'),
  'R4',
  (V) => { const r = V.firstRoundRange(NODES_ALT); return r !== null && r.startIdx === 1 && V.firstRoundProtectSeqs(NODES_ALT).includes(1) })

await expectRed('M-R5', '反证R5：protectSeqs 丢掉一个 seq ⇒ R5 红',
  mutateLib('    if (typeof seq === \'number\' && Number.isFinite(seq)) seqs.push(seq)', '    if (typeof seq === \'number\' && Number.isFinite(seq) && seq !== 3) seqs.push(seq) // 反证R5', 'R5'),
  'R5',
  (V) => JSON.stringify(V.firstRoundProtectSeqs(NODES)) === '[1,2,3]')

await expectRed('M-R6', '反证R6：主路径硬编码 58 ⇒ R6 红',
  mutateLib("  if (slot !== null) return { order: slot + 1, source: 'slot', slot }", "  return { order: 58, source: 'slot', slot: null } // 反证R6：主路径硬编码", 'R6'),
  'R6',
  (V) => { const r = V.resolveRecordHeadOrder(() => 10200); return r.order === 10201 && r.source === 'slot' && r.slot === 10200 })

await expectRed('M-R7', '反证R7：开关改成读预设行 ⇒ R7 红',
  mutateLib('  return kfr.enabled === true', "  const mods = Array.isArray(configJson && configJson.modules) ? configJson.modules : []\n  const row = mods.find((m) => m && m.id === 'keep-first-round')\n  return Boolean(row && row.config && row.config.enabled === true) // 反证R7：改读预设行", 'R7'),
  'R7',
  (V) => V.readSwitch({ keepFirstRound: { enabled: true } }) === true)

// ---- 写面与挂载行（lib/preset-modules.js）----------------------------------------------
console.log('== 写面 · lib/preset-modules.js ==')
const pm = await import('./lib/preset-modules.js')
const ml = pm.keepFirstRoundMountLine().split('\n')
check('W1', '挂载行：恰好三行（注释 + id 行 + name 行）', ml.length === 3 && ml[0].startsWith('#') && ml[1] === '- id: keep-first-round' && ml[2] === "  name: './keep-first-round.js'", JSON.stringify(ml))
check('W2', '清单：默认两件不变 + 全量三件含 keep-first-round.js', pm.PRESET_MODULE_NAMES.length === 2 && pm.PRESET_MODULE_NAMES_ALL.length === 3 && pm.PRESET_MODULE_NAMES_ALL[2] === 'keep-first-round.js', JSON.stringify(pm.PRESET_MODULE_NAMES_ALL))
check('W3', '包内第三副本存在且可读（随包发版）', (() => { try { return readFileSync(join(ROOT, 'preset-modules', 'keep-first-round.js')).length > 0 } catch { return false } })(), '')

const dirW = mkdtempSync(join(tmpdir(), 'dma-kfr-write-'))
try {
  const r1 = pm.provisionPresetModules({ presetDir: dirW, moduleNames: pm.PRESET_MODULE_NAMES_ALL })
  check('W4', '三件首次写入全是 create 且 ok', r1.ok === true && r1.results.length === 3 && r1.results.every((x) => x.action === 'create'), JSON.stringify((r1.results || []).map((x) => x.name + ':' + x.action)))
  let byteSame = true
  for (const name of pm.PRESET_MODULE_NAMES_ALL) {
    const pkg = readFileSync(join(ROOT, 'preset-modules', name))
    const onDisk = readFileSync(join(dirW, name))
    if (Buffer.compare(pkg, onDisk) !== 0) byteSame = false
  }
  check('W5', '三件盘上逐字等于包内副本', byteSame, '')
  const backupNames = () => {
    try {
      return readdirSync(join(dirW, '.dma-backup'))
    } catch {
      return []
    }
  }
  const backupsBefore = backupNames()
  const r2 = pm.provisionPresetModules({ presetDir: dirW, moduleNames: pm.PRESET_MODULE_NAMES_ALL })
  check('W6', '幂等：第二次全 skip、touched:false、零新增备份', r2.ok === true && r2.results.every((x) => x.action === 'skip') && r2.touched === false && backupNames().length === backupsBefore.length, JSON.stringify((r2.results || []).map((x) => x.name + ':' + x.action)))
  const target = join(dirW, 'keep-first-round.js')
  const oldBuf = Buffer.from('// 自检夹具：用户手改过的旧内容\n', 'utf8')
  writeFileSync(target, oldBuf)
  const r3 = pm.provisionPresetModules({ presetDir: dirW, moduleNames: pm.PRESET_MODULE_NAMES_ALL })
  const backupDir = join(dirW, '.dma-backup')
  const keptBackups = backupNames().filter((f) => f.startsWith('keep-first-round.js.'))
  const backupOk = keptBackups.length === backupsBefore.length + 1 && (() => {
    try { return Buffer.compare(readFileSync(join(backupDir, keptBackups[keptBackups.length - 1])), oldBuf) === 0 } catch { return false }
  })()
  check('W7', '用户手改 ⇒ 先备份（与旧内容逐字相等）再覆盖成包内副本', r3.ok === true && r3.results.find((x) => x.name === 'keep-first-round.js')?.action === 'overwrite' && backupOk && Buffer.compare(readFileSync(target), readFileSync(join(ROOT, 'preset-modules', 'keep-first-round.js'))) === 0, JSON.stringify({ action: r3.results?.find((x) => x.name === 'keep-first-round.js')?.action, backups: keptBackups }))
  const dirDefault = mkdtempSync(join(tmpdir(), 'dma-kfr-default-'))
  const rDefault = pm.provisionPresetModules({ presetDir: dirDefault })
  check('W8', '默认清单仍是两件（既有自检台契约不破）', rDefault.ok === true && rDefault.results.length === 2, JSON.stringify((rDefault.results || []).map((x) => x.name)))
  rmSync(dirDefault, { recursive: true, force: true })
} finally {
  rmSync(dirW, { recursive: true, force: true })
}

// ---- R8：隐私（最后跑，扫全程输出）------------------------------------------------------
console.log('== R8 · 隐私 ==')
const moduleSrc = readFileSync(join(ROOT, 'preset-modules', 'keep-first-round.js'), 'utf8')
const selfSrc = readFileSync(join(ROOT, '_selftest-keep-first-round.mjs'), 'utf8')
const libSrc = readFileSync(join(ROOT, 'lib', 'keep-first-round.js'), 'utf8')
const inModule = moduleSrc.includes(FIXTURE_PREFIX12)
const inSelf = selfSrc.includes(FIXTURE_PREFIX12)
const inLib = libSrc.includes(FIXTURE_PREFIX12)
const inOutput = ALL_OUTPUT.some((line) => line.includes(FIXTURE_PREFIX12))
check('R8', '夹具前 12 字在 模块/自检台/lib 核心/自检输出 四处零命中（长度与布尔才可出镜）', !inModule && !inSelf && !inLib && !inOutput, JSON.stringify({ inModule, inSelf, inLib, inOutput }))

// ---- 汇总 ------------------------------------------------------------------------------
console.log('\n—— 汇总 ——')
console.log('PASS ' + pass + ' / FAIL ' + failCount)
for (const line of redEvidence) console.log(line)
console.log(failCount === 0 ? '自检台：全绿（含 R1–R7 七条反证的红）' : '自检台：有红，见上')
process.exit(failCount === 0 ? 0 : 1)
