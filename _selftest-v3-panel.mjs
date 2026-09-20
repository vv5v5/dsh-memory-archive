#!/usr/bin/env node
/**
 * _selftest-v3-panel.mjs —— v3 面板「数据 ⇒ 可渲染行」的纯函数自检（`__v3.v3DigestLines`）。
 *
 * 为什么只测纯函数：组件里的取数/按钮走的是既有 apiGet/mutateJson 通路（那些已被
 * _selftest-client.mjs 的写守卫覆盖）；这里要钉的是**口径**——不可用就说不可用、
 * 没 sessionId 就说没给、卡片正文不进面板、缺字段不编。
 *
 * 用法：node _selftest-v3-panel.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(here, 'lib', 'client.js'), 'utf8')

let pass = 0
const fails = []
function check(name, fn) {
  try { fn(); pass++; console.log('[PASS] ' + name) } catch (e) { fails.push(name); console.log('[FAIL] ' + name + ' :: ' + String((e && e.message) || e)) }
}

// 最小假 react（与 _selftest-prompt-map.mjs 同款：createElement 足够，hook 只登记不执行）
function makeFakeReact() {
  const createElement = (type, props) => {
    const rest = Array.prototype.slice.call(arguments, 2)
    const p = Object.assign({}, props || {})
    if (rest.length === 1) p.children = rest[0]
    else if (rest.length > 1) p.children = rest
    return { $$element: typeof type === 'function' ? type.name : String(type), props: p }
  }
  return {
    createElement,
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useRef: (v) => ({ current: v }),
    useEffect: () => {},
    useLayoutEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
}

const win = { __ModuleLoader__: { load(def) { win.__def = def } } }
globalThis.window = win
;(0, eval)(src)
const mod = win.__def.factory(() => makeFakeReact())
const v3 = mod.__v3
const lines = v3.v3DigestLines
const text = (d) => lines(d).map((l) => l.label + '=' + l.value).join(' | ')

console.log('== _selftest-v3-panel.mjs · v3 面板纯函数自检 ==')

await check('前置：__v3 出口存在且是函数；__internals 键集合未被本单改动', () => {
  assert.equal(typeof v3, 'object')
  assert.equal(typeof v3.v3DigestLines, 'function')
  assert.equal(typeof v3.V3Panel, 'function')
})

await check('① Tavern 没有 v3（404）⇒ 明说"这台没有 v3"，⛔ 不装作可用', () => {
  const d = { ok: false, error: { code: 'TAVERN_V3_UNAVAILABLE', message: '这台 Tavern 没有 v3（`/api/v3/*` 404）' }, tavern: { reachable: false, status: 404 } }
  const out = lines(d)
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'error')
  assert.match(out[0].value, /没有 v3/)
  assert.doesNotMatch(text(d), /可达/)
})

await check('② 正常投影：capabilities + 组合器 + 上限 + 本会话 mode 都摊成行', () => {
  const d = {
    ok: true,
    tavern: { reachable: true, status: 200 },
    capabilities: { apiVersion: 3, modes: ['builtin', 'external'], composers: ['dsh-memory-archive'], maxSections: 64, maxProfileBytes: 524288, synchronous: true },
    composer: { enabled: true, owner: 'dsh-memory-archive', registered: true, servicePresent: true, owners: ['dsh-memory-archive'], needsHostRestart: false, note: '已注册' },
    mode: { mode: 'external', owner: 'dsh-memory-archive', available: true, revision: 'abc123' },
    sources: {
      cardId: 'card-1', cardName: '验收卡😀', revision: 'deadbeefdeadbeefdeadbeef', countUnit: 'characters',
      greeting: { requestedIndex: 0, effectiveIndex: 2, semantics: 'first-turn-reference', chars: 23 },
      fields: [{ key: 'description', label: 'description', chars: 18 }, { key: 'systemPrompt', label: 'system-prompt', chars: 22 }],
      worldBooks: { effective: 1, characterBound: 1, userBound: 0, duplicate: 0 },
      suggestedCallConfig: {}, fieldLengthKeys: 42,
    },
  }
  const t = text(d)
  assert.match(t, /apiVersion 3/)
  assert.match(t, /已注册 \["dsh-memory-archive"\]/)
  assert.match(t, /段 ≤ 64/)
  assert.match(t, /mode=external · owner=dsh-memory-archive · available=true/)
  assert.match(t, /验收卡😀/)
  assert.match(t, /序号 2（请求 0）/)
  assert.match(t, /description=18 · system-prompt=22/)
  assert.match(t, /revision deadbeefdeadbeef…/)
  assert.match(t, /（上游没给）/, 'suggestedCallConfig 空时要说"没给"')
})

await check('③ 缺 sessionId ⇒ 明说"未给"，⛔ 不假装读到了 mode', () => {
  const d = { ok: true, tavern: { reachable: true, status: 200 }, capabilities: { apiVersion: 3 }, composer: { enabled: false, owner: 'dsh-memory-archive', owners: [] }, mode: null, sources: null }
  const t = text(d)
  assert.match(t, /未给 sessionId/)
  assert.doesNotMatch(t, /mode=/)
})

await check('④ 反证：卡片正文**不进面板**（只给字数/序号；正文请走 Tavern 自己的界面）', () => {
  const d = {
    ok: true, tavern: { status: 200 }, capabilities: { apiVersion: 3 }, composer: { owners: [] }, mode: { mode: 'builtin', owner: null, available: true },
    sources: {
      cardId: 'card-1', cardName: 'NAME', greeting: { effectiveIndex: 0, semantics: 's', chars: 5 },
      fields: [{ key: 'description', label: 'description', chars: 3 }], worldBooks: {}, suggestedCallConfig: {}, revision: 'r',
      // ⛔ 故意塞进来：即使宿主哪天多回了正文，面板的取值也必须是"只挑它认识的那几个键"
      description: '这是卡片正文，不该出现', data: { description: '这是卡片正文，不该出现' },
    },
  }
  const t = text(d)
  assert.doesNotMatch(t, /这是卡片正文/, '⛔ 卡片正文漏进面板了')
  assert.match(t, /description=3/)
})

await check('⑤ 形状不对（null/字符串/数组）⇒ 一行"取不到"，⛔ 不抛', () => {
  for (const bad of [null, undefined, 'x', 3, []]) {
    const out = lines(bad)
    assert.ok(Array.isArray(out) && out.length >= 1, '形状不对时至少给一行')
    assert.equal(out[0].kind, 'error')
  }
})

await check('⑥ 读不到 mode / sources ⇒ 各给一行 error，且都带原因码（⛔ 不空白）', () => {
  const d = {
    ok: true, tavern: { reachable: true, status: 200 }, capabilities: { apiVersion: 3 }, composer: { owners: [], enabled: false },
    mode: null, modeError: { code: 'MODE_READ_FAILED', status: 500, message: 'x' },
    sources: null, sourcesError: { code: 'SOURCES_READ_FAILED', status: 500, message: 'y' },
  }
  const out = lines(d)
  const modeLine = out.find((l) => l.label === '本会话装配')
  const srcLine = out.find((l) => l.label === '来源快照')
  assert.equal(modeLine.kind, 'error')
  assert.match(modeLine.value, /MODE_READ_FAILED/)
  assert.equal(srcLine.kind, 'error')
  assert.match(srcLine.value, /SOURCES_READ_FAILED/)
})

await check('⑦ 配置说启用但进程没注册 ⇒ 必须给"要重启宿主"的醒目行（⛔ 不许显示成已生效）', () => {
  const d = { ok: true, tavern: { status: 200 }, capabilities: { apiVersion: 3 }, composer: { enabled: true, owner: 'dsh-memory-archive', registered: false, owners: [], needsHostRestart: true, note: '配置说启用，但本进程里没注册上' }, mode: null, sources: null }
  const warn = lines(d).find((l) => l.kind === 'warn')
  assert.ok(warn, '缺 warn 行')
  assert.match(warn.value, /重启宿主/)
})

// ───────────────────────────── trace 合同（2026-09-17 上游换合同） ─────────────────────────────
const alines = v3.assemblyLines

await check('⑧ trace 合同 ⇒ 必须说清"组合器/切模式这两条路不存在"，⛔ 不给"重启宿主"那种无效指引', () => {
  const d = {
    ok: true, tavern: { reachable: true, status: 200 },
    contract: { id: 'trace', known: true, reason: "capabilities.contract === 'prompt-trace-primitives'", label: 'trace（只读补集）', detail: '这台 Tavern 用的是 prompt-trace 合同（capabilities 自述 composerRegistry:false）…', composerUsable: false, tailServiceUsable: false, modeSwitchable: false },
    capabilities: { apiVersion: 3, contract: 'prompt-trace-primitives', composerRegistry: false, officialSections: true, sourceMapping: 'section-contributors' },
    composer: { enabled: true, owner: 'dsh-memory-archive', usable: false, registered: false, owners: [], needsHostRestart: false, note: '这条路在这台 Tavern 上**不存在**：trace 合同没有组合器注册表。⛔ 与配置无关，**重启也不会变好**。' },
    parts: { registered: true, armed: false, reason: 'ok', planLoaded: true, planVersion: 1, placedTotal: 7, lastPlaced: { placed: [{ key: 'character:postHistoryInstructions', order: 10203 }], fallback: 0 }, lastSeen: { total: 27, parts: 7, placed: 7, fallback: 0 } },
    replaceGuard: { presetMode: 'append', ourSections: ['state:card'], atRisk: false, note: '预设是 append 模式 ⇒ Tavern 不会滤掉我们的段' },
    mode: null, sources: null,
    assemblies: { ok: true, sessionId: 's', total: 2, storage: { maxRecords: 256 }, records: [{ id: 'legacy:7', legacy: true, turn: 7, step: 0, sectionCount: null, status: 'legacy-metadata-only' }, { id: 'r1', legacy: false, turn: 8, step: 0, sectionCount: 12, status: 'request-observed' }] },
  }
  const t = text(d)
  assert.match(t, /v3 合同=trace（只读补集）/)
  assert.match(t, /组合器=这条路在这台 Tavern 上不存在/)
  assert.doesNotMatch(t, /重启宿主/, '⛔ trace 合同下不许再给"重启宿主"——那是无效指引')
  // ★ 2026-09-19：`末尾段` 行**退役**（mt:postHistory 已删）⇒ 换成「卡字段摆位」那一行
  assert.doesNotMatch(t, /末尾段=/, '⛔ 尾段已退役，不该再有末尾段行')
  assert.match(t, /卡字段摆位=/, '缺「卡字段摆位」行')
  assert.match(t, /历史装配=2 条 \/ 上限 256/)
  assert.match(t, /段数 12/)
  // 反证：mode 字段是 null（trace 合同宿主根本不给它），所以不该出现 mode 行
  assert.doesNotMatch(t, /mode=/)
})

await check('⑨ ★ replace 看守：atRisk 时必须出**醒目**行（warn），且点名我们哪几段会被整批滤掉', () => {
  const base = { ok: true, tavern: { status: 200 }, capabilities: { apiVersion: 3 }, composer: { usable: true, owners: [] }, mode: null, sources: null }
  const risky = Object.assign({}, base, {
    contract: { id: 'composer', known: true, label: 'composer（可接管）', detail: 'd', composerUsable: true, tailServiceUsable: true, modeSwitchable: true },
    replaceGuard: { presetMode: 'replace', ourSections: ['state:card', 'anima:memory'], atRisk: true, note: '⚠ 预设的 systemPromptMode = **replace** ⇒ Tavern 只保留它自己的段…会被**整批滤掉**：state:card、anima:memory' },
  })
  const line = lines(risky).find((l) => l.label === '⚠ 装配模式')
  assert.ok(line, '缺 replace 警告行')
  assert.equal(line.kind, 'warn')
  assert.match(line.value, /replace/)
  assert.match(line.value, /state:card/)
  // 反证：append 时**不该**是 warn，也不该带 ⚠ 前缀
  const calm = Object.assign({}, risky, { replaceGuard: { presetMode: 'append', ourSections: [], atRisk: false, note: '预设是 append 模式 ⇒ Tavern 不会滤掉我们的段' } })
  const calmLine = lines(calm).find((l) => l.label === '装配模式')
  assert.ok(calmLine, 'append 时也该有一行事实')
  assert.notEqual(calmLine.kind, 'warn')
})

await check('⑨b ★★ 看守改版（2026-09-18）：以**直接观察**为主 —— 一个都不在才喊危险；缺一部分只如实报', () => {
  const base = { ok: true, tavern: { status: 200 }, capabilities: { apiVersion: 3 }, composer: { usable: true, owners: [] }, mode: null, sources: null }
  const mk = (rg) => Object.assign({}, base, { contract: { id: 'trace', known: true, label: 'trace（只读补集）', detail: 'd', composerUsable: false, tailServiceUsable: false, modeSwitchable: false }, replaceGuard: rg })

  // ① 观察：我们 7 段一个都不在那一轮装配里 ⇒ 醒目的 ⚠ 行
  const gone = mk({ basis: 'observed', presetMode: null, ourSections: ['state:card', 'mt:postHistory'], observed: true, total: 30, present: [], missing: ['state:card', 'mt:postHistory'], partial: false, atRisk: true,
    note: '⚠ 这一轮装配（共 30 段）里**我们自己的段一个都没有**：state:card、mt:postHistory ⇒ 极可能是预设的 systemPromptMode = replace 把非 Tavern 段整批滤掉了（预设模式读不到，这里是直接观察的结论）。' })
  const warnLine = lines(gone).find((l) => l.label === '⚠ 装配模式')
  assert.ok(warnLine, '全缺时必须出 ⚠ 行')
  assert.equal(warnLine.kind, 'warn')
  assert.match(warnLine.value, /一个都没有/)
  assert.match(warnLine.value, /replace/)

  // ② 观察：全在 ⇒ 一行事实、不是 warn
  const all = mk({ basis: 'none', presetMode: null, ourSections: ['state:card'], observed: true, total: 30, present: ['state:card'], missing: [], partial: false, atRisk: false,
    note: '这一轮装配（共 30 段）里我们 1 段**全在** ⇒ 没有被滤' })
  const okLine = lines(all).find((l) => l.label === '装配模式')
  assert.ok(okLine, '全在时也该有一行事实')
  assert.notEqual(okLine.kind, 'warn')
  assert.match(okLine.value, /全在/)

  // ③ 观察：缺一部分 ⇒ 如实报缺了谁，但⛔ 不许升级成 warn（可能只是某插件没启用）
  const part = mk({ basis: 'none', presetMode: null, ourSections: ['state:card', 'anima:memory'], observed: true, total: 30, present: ['anima:memory'], missing: ['state:card'], partial: true, atRisk: false,
    note: '这一轮装配（共 30 段）里我们缺了 state:card（在的有 1 段）—— 可能只是某个插件没启用（例如 state:card 属 state-bridge），不一定是被滤；换 preset 模式时留意这几段。' })
  const partLine = lines(part).find((l) => l.label === '装配模式')
  assert.ok(partLine, '缺一部分时也要有一行')
  assert.notEqual(partLine.kind, 'warn', '⛔ 缺一部分不是危险信号，不许渲染成 warn')
  assert.match(partLine.value, /缺了 state:card/)

  // ④ ★ 反证（真机踩到过的那一档）：**presetMode=append 是正向判据**，没有观察也该给"不会滤"的判词，
  //    ⛔ 不许退化成"无法判定" —— 那会把已知的安全说成未知（真机 2026-09-18 实测到）。
  const appendNoObs = mk({ basis: 'preset', presetMode: 'append', ourSections: ['state:card'], observed: false, total: null, present: [], missing: [], partial: false, atRisk: false,
    note: '预设是 append 模式 ⇒ Tavern **不会**滤掉我们的段（这一轮的段表还没观察到；下一轮 RP 后会有直接观察）' })
  const appendLine = lines(appendNoObs).find((l) => l.label === '装配模式')
  assert.ok(appendLine, 'append 时也要有一行')
  assert.notEqual(appendLine.kind, 'warn')
  assert.match(appendLine.value, /不会/)
  assert.doesNotMatch(appendLine.value, /无法判定/, '⛔ 已知安全不许说成"无法判定"')
})

await check('⑩ ★ 合同认不准 ⇒ 明确警告"下面的状态一律不可信，⛔ 别按它做判断"', () => {
  const d = {
    ok: true, tavern: { status: 200 },
    contract: { id: 'unknown', known: false, reason: 'capabilities 形状既不像 composer 也不像 trace —— 不猜', label: '合同形状不认识', detail: '上游可能又改了', composerUsable: null, tailServiceUsable: null, modeSwitchable: null },
    capabilities: { apiVersion: 3 }, composer: { usable: null, owners: [], enabled: false, note: '无法判定：没读到 v3 capabilities' }, mode: null, sources: null,
  }
  const out = lines(d)
  const c = out.find((l) => l.label === 'v3 合同')
  assert.equal(c.kind, 'warn', '认不准必须是 warn')
  assert.ok(out.find((l) => l.label === '⚠ 提醒'), '缺"别信下面的状态"这条提醒')
  const cm = out.find((l) => l.label === '组合器')
  assert.equal(cm.kind, 'warn')
  assert.match(cm.value, /无法判定/)
})

await check('⑩b ★ 卡字段摆位必须可见：接线/未接线都要说清，且报出"上游解出几段、我们摆了几段"', () => {
  const base = { ok: true, tavern: { status: 200 }, capabilities: { apiVersion: 3 }, composer: { usable: false, owners: [] }, mode: null, sources: null }
  const on = Object.assign({}, base, {
    parts: {
      registered: true, armed: false, reason: 'ok', planLoaded: true, planVersion: 1, placedTotal: 7,
      lastPlaced: { placed: [{ key: 'character:description', order: 12 }, { key: 'character:postHistoryInstructions', order: 10203 }], fallback: 0 },
      lastSeen: { total: 27, parts: 7, placed: 7, fallback: 0, summary: 'x' },
    },
  })
  const onLine = lines(on).find((l) => l.label === '卡字段摆位')
  assert.ok(onLine, '缺「卡字段摆位」行')
  assert.notEqual(onLine.kind, 'warn')
  assert.match(onLine.value, /已接线/)
  assert.match(onLine.value, /累计摆 7 段/)
  assert.match(onLine.value, /上轮 7 个上游段，摆了 7 个/)
  assert.match(onLine.value, /character:description→12/, '摆位摘要要逐字段给出"' + '字段→order' + '"')
  // 反证：没接线 ⇒ warn，并说清后果（上游的段留在它给的位置）
  const off = Object.assign({}, base, { parts: { registered: false, armed: false, reason: 'threw:boom', planLoaded: true, placedTotal: 0, lastPlaced: null, lastSeen: null } })
  const offLine = lines(off).find((l) => l.label === '卡字段摆位')
  assert.equal(offLine.kind, 'warn')
  assert.match(offLine.value, /未接线/)
  assert.match(offLine.value, /threw:boom/)
  // 反证：摆位表模块没加载 ⇒ 要显式说（那是"位置全都不管了"）
  const noPlan = Object.assign({}, base, { parts: { registered: false, armed: true, reason: 'plan-module-missing', planLoaded: false, placedTotal: 0 } })
  assert.match(lines(noPlan).find((l) => l.label === '卡字段摆位').value, /⚠ 摆位表模块没加载/)
  // 反证：有字段没进表 ⇒ 如实报个数（⛔ 不许静默走兜底）
  const fb = Object.assign({}, base, {
    parts: { registered: true, armed: false, reason: 'ok', planLoaded: true, placedTotal: 3, lastPlaced: { placed: [], fallback: 2 }, lastSeen: { total: 20, parts: 3, placed: 3, fallback: 2 } },
  })
  assert.match(lines(fb).find((l) => l.label === '卡字段摆位').value, /2 个字段没进表/)
})

await check('⑩c ★ 摆位 armed（等第一个会话事件）是**正常待启用**，⛔ 不许渲染成警告', () => {
  const base = { ok: true, tavern: { status: 200 }, capabilities: { apiVersion: 3 }, composer: { usable: false, owners: [] }, mode: null, sources: null }
  const armed = Object.assign({}, base, { parts: { registered: false, armed: true, reason: 'armed', planLoaded: true, placedTotal: 0, lastPlaced: null, lastSeen: null } })
  const armedLine = lines(armed).find((l) => l.label === '卡字段摆位')
  assert.ok(armedLine, '缺「卡字段摆位」行')
  assert.notEqual(armedLine.kind, 'warn', '⛔ armed 被渲染成警告了（那会把正常待启用说成故障）')
  assert.match(armedLine.value, /待启用/)
  // 反证：真没接线时**必须**是 warn
  const off = Object.assign({}, base, { parts: { registered: false, armed: false, reason: 'install-module-missing', planLoaded: true, placedTotal: 0 } })
  const offLine = lines(off).find((l) => l.label === '卡字段摆位')
  assert.equal(offLine.kind, 'warn')
  assert.match(offLine.value, /未接线/)
})

// ───────────────────────────── assemblyLines（单条装配记录） ─────────────────────────────
await check('⑪ assemblyLines：段级明细摊成行，:part: 段给出来源归属', () => {
  const rec = {
    id: 'r1', turn: 8, step: 0, attempt: 1, recordedAt: 1758000000000, status: 'request-observed', contentStatus: 'available', sourceMapping: 'section-contributors',
    sections: [
      { index: 0, name: 'pmp-dsh-tavern:part:0003:character:description', characters: 120, provenance: 'section-contributors', offsetUtf16: 0, sources: [{ kind: 'character', field: 'description' }], part: { ordinal: 3, kind: 'character', field: 'description', sanitized: true } },
      { index: 1, name: 'state:card', characters: 614, provenance: 'unknown', offsetUtf16: 124, sources: [], part: null },
    ],
    sectionTotal: 2, contextCount: 0,
    delivery: { stage: 'llm/stream', provider: 'deepseek', model: 'deepseek-chat', toolNames: ['skill', 'web_search'], assemblyVerified: true, systemMessageIndex: 0, logCutSeq: 41, sessionVersion: 3 },
  }
  const t = alines(rec).map((l) => l.label + '=' + l.value).join(' | ')
  assert.match(t, /turn 8 · step 0 · attempt 1/)
  assert.match(t, /工具 2 个（skill, web_search）/, '工具名终于有正规来源')
  assert.match(t, /✅ 候选正文唯一匹配到第 0 条系统消息/)
  assert.match(t, /卡字段 character:description/)
  assert.match(t, /贡献者 character:description/)
  assert.match(t, /state:card · 614 字/)
})

await check('⑫ ★ 反证：assemblyVerified=false 时必须警告 offset 不能当实际位置用，且**不显示** offset', () => {
  const rec = {
    turn: 1, step: 1, attempt: 1, status: 'assembled', contentStatus: 'available',
    sections: [{ index: 0, name: 'a', characters: 5, provenance: 'unknown', offsetUtf16: 999, sources: [] }],
    delivery: { stage: 'llm/stream', assemblyVerified: false, systemMessageIndex: null },
  }
  const out = alines(rec)
  const v = out.find((l) => l.label === '装配核对')
  assert.equal(v.kind, 'warn')
  assert.match(v.value, /未获证明/)
  assert.doesNotMatch(v.value, /可定位/)
  const t = out.map((l) => l.label + '=' + l.value).join(' | ')
  assert.doesNotMatch(t, /@999/, '⛔ 没核对上就不许显示 offset —— 那会被当成实际位置')
})

await check('⑬ ★ 反证：assemblyLines 只摊它认识的键 —— 段正文（哨兵）一个都进不来', () => {
  const rec = {
    turn: 1, step: 0, attempt: 1, status: 'request-observed', contentStatus: 'available',
    sections: [{ index: 0, name: 'x', characters: 6, provenance: 'unknown', text: 'ZZ正文哨兵ZZ', sources: [] }],
    systemMessages: ['ZZ系统全文哨兵ZZ'],
    delivery: { assemblyVerified: true, systemMessageIndex: 0 },
  }
  const t = alines(rec).map((l) => l.label + '=' + l.value).join(' | ')
  assert.doesNotMatch(t, /ZZ正文哨兵ZZ/, '⛔ 段正文漏进面板了')
  assert.doesNotMatch(t, /ZZ系统全文哨兵ZZ/, '⛔ 系统全文漏进面板了')
})

await check('⑭ assemblyLines：空段/无投递/畸形都如实说，且不抛', () => {
  const empty = alines({ turn: 1, step: 0, contentStatus: 'omitted-size-limit', sections: [], delivery: null })
  const t = empty.map((l) => l.label + '=' + l.value).join(' | ')
  assert.match(t, /0 段/, '空段要说 0 段')
  assert.match(t, /⛔ 空不等于"没注入"/, '空段必须澄清语义')
  assert.match(t, /没有 observed 投递信息/)
  for (const bad of [null, undefined, 'x', 3, []]) {
    const out = alines(bad)
    assert.ok(Array.isArray(out) && out.length >= 1)
    assert.equal(out[0].kind, 'error')
  }
})

console.log('\n== 汇总：' + pass + ' 通过 / ' + fails.length + ' 失败 ==')
if (fails.length > 0) { console.log('失败项：\n  - ' + fails.join('\n  - ')); process.exit(1) }
