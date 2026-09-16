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

console.log('\n== 汇总：' + pass + ' 通过 / ' + fails.length + ' 失败 ==')
if (fails.length > 0) { console.log('失败项：\n  - ' + fails.join('\n  - ')); process.exit(1) }
