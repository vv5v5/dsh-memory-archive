#!/usr/bin/env node
/**
 * _selftest-v3-tail.mjs —— 尾部段（lib/v3-tail.js）自检。
 *
 * 它要钉住五件事：① 纯函数的取值口径（哪几种情况必须为空）；② order 必须排在已知所有段之后；
 * ③ 段函数**自己**从装配 context 取会话（⛔ 不许改回"在装配瀑布里刷缓存"——真机实测那会永远为空）；
 * ④ 文本一定经过宏/变量处理（否则 DSH 会让整轮失败）；⑤ 非本局为空、任何失败都只降级不抛。
 * 用法：node _selftest-v3-tail.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(path.join(here, 'lib', 'v3-tail.js')))

let pass = 0
const fails = []
function check(name, fn) {
  try { fn(); pass++; console.log('[PASS] ' + name) } catch (e) { fails.push(name); console.log('[FAIL] ' + name + ' :: ' + String((e && e.message) || e)) }
}
async function checkAsync(name, fn) {
  try { await fn(); pass++; console.log('[PASS] ' + name) } catch (e) { fails.push(name); console.log('[FAIL] ' + name + ' :: ' + String((e && e.message) || e)) }
}
console.log('== _selftest-v3-tail.mjs · v3 尾部段自检 ==')

/** 真实形状的 sources 夹具（值全合成）。 */
function makeSources(over = {}) {
  return Object.assign({
    schemaVersion: 3,
    sessionId: 'session-1',
    selection: { presetId: null, characterCardId: 'card-1', userId: null, worldBookIds: [], character: { greetingIndex: 0, preferCharacterSystemPrompt: true, preferCharacterPostHistory: true }, rp: { active: true } },
    documents: {
      character: { id: 'card-1', name: '验收卡😀', data: { name: '验收卡😀', postHistoryInstructions: '每次回复不超过两句。' } },
      user: { id: 'user-1', data: { name: '旅人' } },
      preset: null, worldBooks: [],
    },
    greeting: { requestedIndex: 0, effectiveIndex: 0, text: '开场。', semantics: 'first-turn-reference' },
    revision: 'rev-1',
  }, over)
}

// ---------------------------------------------------------------- ① 纯函数口径
check('① 纯函数：有卡且字段非空 ⇒ 产出带标签的文本；四种"该为空"的情况各给一个可读 reason', () => {
  const ok = mod.tailTextFromSources(makeSources())
  assert.equal(ok.reason, 'ok')
  assert.match(ok.text, /^<st-character-field name="post-history-instructions">\n每次回复不超过两句。\n<\/st-character-field>$/)
  assert.equal(ok.chars, '每次回复不超过两句。'.length)
  assert.equal(mod.tailTextFromSources(null).reason, 'no-sources')
  assert.equal(mod.tailTextFromSources({ selection: {}, documents: {} }).reason, 'no-card')
  const pref = makeSources(); pref.selection.character.preferCharacterPostHistory = false
  assert.equal(mod.tailTextFromSources(pref).reason, 'prefer-off', '用户把"用卡的后处理"关掉时不许注入')
  const empty = makeSources(); empty.documents.character.data.postHistoryInstructions = '   '
  assert.equal(mod.tailTextFromSources(empty).reason, 'empty')
  for (const r of [mod.tailTextFromSources(null), mod.tailTextFromSources(pref), mod.tailTextFromSources(empty)]) assert.equal(r.text, '', '该为空时必须空')
})

check('①b ★ 宏/变量必须处理：`{{char}}`/`{{user}}` 用卡与用户名展开，解不了的中和 —— ⛔ 输出里不许残留 `{{…}}`', () => {
  const s = makeSources()
  s.documents.character.data.postHistoryInstructions = '{{char}} 与 {{user}}：保持简短。{{random}}'
  const r = mod.tailTextFromSources(s)
  assert.match(r.text, /验收卡😀 与 旅人：保持简短。/)
  assert.doesNotMatch(r.text, /\{\{[^{}]*\}\}/, '⛔ 残留 {{…}} ⇒ DSH 会判 unknown/malformed 并让整轮失败')
  assert.match(r.text, /random/, '解不了的宏保留名字（不是整词删掉）')
  assert.ok(r.macros.expanded.includes('char') && r.macros.expanded.includes('user'))
  assert.ok(r.macros.neutralized.includes('random'))
  // 反证：不做处理时原样带 {{…}}
  const raw = s.documents.character.data.postHistoryInstructions
  assert.match(raw, /\{\{[^{}]*\}\}/, '反证夹具本身不对')
})

check('①c 畸形嵌套也拆开（DSH 对它是 malformed 而不是普通文本）', () => {
  const s = makeSources()
  s.documents.character.data.postHistoryInstructions = '前 {{a{{b}}}} 后'
  const r = mod.tailTextFromSources(s)
  assert.doesNotMatch(r.text, /\{\{[^{}]*\}\}/)
  assert.match(r.text, /\{ \{/)
})

// ---------------------------------------------------------------- ② 注册与 order
function makeCtx({ service, sessionId = 'session-1' } = {}) {
  const captured = { plugins: [], sections: [], hooks: {} }
  const ctx = {
    get: (n) => (n === 'pmpDshTavernPrompt' ? service : undefined),
    plugin: (p) => {
      captured.plugins.push(p)
      const scope = {
        effect: (fn) => fn(),
        systemPrompt: { section: (s) => { captured.sections.push(s); return () => {} } },
        on: (evt, fn) => { captured.hooks[evt] = fn },
      }
      p.apply(scope)
    },
  }
  return { ctx, captured, sessionId }
}

check('② 默认 order = 10203 —— 必须排在 `deployment:persona-suffix`(10200)、`rp:firstRound`(10201) 与 `mt:lastFloors`(10202) 之后', () => {
  assert.equal(mod.DEFAULT_TAIL_ORDER, 10203)
  assert.ok(mod.DEFAULT_TAIL_ORDER > 10202, '⛔ 排在 mt:lastFloors 之前就不叫"最后"了')
  const { ctx, captured } = makeCtx({ service: { getSources: () => makeSources() } })
  const r = mod.registerV3Tail(ctx, { enabled: true }, { info: () => {}, warn: () => {} })
  assert.equal(r.registered, true)
  assert.equal(captured.sections.length, 1)
  assert.equal(captured.sections[0].name, 'mt:postHistory')
  assert.equal(captured.sections[0].order, 10203)
  assert.equal(typeof captured.sections[0].text, 'function', '文本必须是函数（DSH 装配时逐段调用它）')
})

check('②b ★⛔ 回归护栏：**不许**挂 `system-prompt/assemble` 瀑布去刷文本', () => {
  // 这是我第一版的设计，真机端到端实测**永远是空段**：DSH（system-prompt/src/index.ts）
  // 在 :595-603 就把每个段的 text 结算完了，:617 才跑 waterfall ⇒ 瀑布里写缓存只慢一轮生效。
  // 段文本只能靠**段函数自己的入参** context 拿 sessionId（同文件 :599 把 context 原样递进来）。
  const { ctx, captured } = makeCtx({ service: { getSources: () => makeSources() } })
  mod.registerV3Tail(ctx, { enabled: true }, { info: () => {}, warn: () => {} })
  assert.equal(captured.hooks['system-prompt/assemble'], undefined,
    '⛔ 又在瀑布里刷文本了 —— 那一段会永远为空（真机实测过）')
  // 源码级反证：模块里根本不该出现那个事件名
  const src = readFileSync(path.join(here, 'lib', 'v3-tail.js'), 'utf8')
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
    /system-prompt\/assemble/, '⛔ 源码里还留着瀑布接线（注释里提它是允许的）')
})

await checkAsync('③ ★ 段函数自取会话：装配那一刻按 context 算，第一次调用就该有文本（不靠任何前置 hook）', async () => {
  const service = { getSources: (sid) => (sid === 'session-1' ? makeSources() : { selection: {}, documents: {} }) }
  const { ctx, captured } = makeCtx({ service })
  mod.registerV3Tail(ctx, { enabled: true }, { info: () => {}, warn: () => {} })
  const section = captured.sections[0]
  const ctxOf = (sid) => ({ agent: { session: { id: sid } } })
  // ★ 核心：**没有任何前置调用**，直接问段函数要文本
  assert.match(section.text(ctxOf('session-1')), /每次回复不超过两句/,
    '⛔ 第一次调用就必须是本局的卡字段（这正是瀑布版做不到的地方）')
  // 另一个会话（没卡）⇒ 空（不串场、也绝不留上一局）
  assert.equal(section.text(ctxOf('session-2')), '', '⛔ 别的会话不许拿到上一局的文本')
  // 没有 sessionId / context 畸形 ⇒ 空，且不抛
  assert.equal(section.text({}), '')
  assert.equal(section.text(undefined), '')
  assert.equal(section.text(null), '')
  assert.equal(section.text({ agent: {} }), '')
  // getSources 抛 ⇒ 不抛出去、且为空
  const bad = makeCtx({ service: { getSources: () => { throw new Error('tavern 挂了') } } })
  const rb = mod.registerV3Tail(bad.ctx, { enabled: true }, { info: () => {}, warn: () => {} })
  assert.equal(bad.captured.sections[0].text(ctxOf('session-1')), '', '取数失败 ⇒ 段为空（不是留着旧值）')
  assert.match(String(rb.status().reason), /sources-threw/, '失败原因要如实记进诊断投影（⛔ 不静默）')
  // 轮换会话：同一次接线里换一局，文本跟着换（无缓存 ⇒ 不会串）
  assert.match(section.text(ctxOf('session-1')), /每次回复不超过两句/)
  assert.equal(section.text(ctxOf('session-2')), '')
  assert.match(section.text(ctxOf('session-1')), /每次回复不超过两句/, '切回来还在（不是一次性）')
})

check('④ 开关与降级：默认不启用；ctx.plugin 缺席/抛错 ⇒ 只降级不抛（后处理仍留在组合器那一块）', () => {
  const calls = []
  const { ctx, captured } = makeCtx({ service: null })
  assert.equal(mod.registerV3Tail(ctx, {}).registered, false, '默认必须不启用')
  assert.equal(captured.plugins.length, 0, '没启用就不该挂子插件')
  const r2 = mod.registerV3Tail({ get: () => undefined }, { enabled: true }, { warn: () => {} })
  assert.equal(r2.registered, false)
  assert.equal(r2.reason, 'no-ctx-plugin')
  const r3 = mod.registerV3Tail({ plugin: () => { throw new Error('上游契约变了') }, get: () => undefined }, { enabled: true }, { warn: (m) => calls.push(m) })
  assert.equal(r3.registered, false)
  assert.equal(r3.reason, 'plugin-failed')
  assert.ok(calls.some((m) => /尾部段接线失败/.test(m)))
})

check('⑤ Tavern 缺席（没有 pmpDshTavernPrompt）⇒ 段照挂但永远为空，且不抛', () => {
  const { ctx, captured } = makeCtx({ service: undefined })
  const r = mod.registerV3Tail(ctx, { enabled: true }, { info: () => {}, warn: () => {} })
  assert.equal(r.registered, true, '段注册本身不依赖 Tavern')
  assert.equal(captured.sections.length, 1)
  assert.equal(captured.sections[0].text({ agent: { session: { id: 'session-1' } } }), '', '没有服务 ⇒ 空')
  assert.match(String(r.status().reason), /no-tavern-service/, '原因要如实进诊断（⛔ 不静默）')
  assert.equal(r.status().enabled, true)
})

// ─────────── 第二条入口：已渲染正文（2026-09-18 上游删 /sources 之后）
{
  check('已渲染正文 ⇒ 外壳与 tailTextFromSources 逐字同款', () => {
    const a = mod.tailTextFromRendered('每次回复不超过两句。', { tag: 'st-character-field', label: 'post-history-instructions' })
    const b = mod.tailTextFromSources(makeSources(), { tag: 'st-character-field', dataKey: 'postHistoryInstructions', label: 'post-history-instructions' })
    assert.equal(a.text, b.text, '⛔ 两条入口必须产出同一个壳（否则同一份内容两种样子）')
  })
  check('★ 反证：空/空白 ⇒ 不给段（reason=empty-rendered，⛔ 不吐半个段）', () => {
    for (const v of ['', '   ', null, undefined, 42]) {
      const r = mod.tailTextFromRendered(v, {})
      assert.equal(r.text, '')
      assert.equal(r.reason, 'empty-rendered')
    }
  })
  check('★ 反证：残留的 {{user}} / 未知变量要被中和（⛔ 不许原样透传 —— DSH 会判未解析变量、让整轮失败）', () => {
    const r = mod.tailTextFromRendered('你好 {{user}} 以及 {{未知词}}', {})
    assert.equal(r.text.includes('{{'), false, '⛔ 不许把 {{…}} 原样送出去')
    assert.equal(r.text.includes('}}'), false)
  })
}

console.log('\n== 汇总：' + pass + ' 通过 / ' + fails.length + ' 失败 ==')
if (fails.length > 0) { console.log('失败项：\n  - ' + fails.join('\n  - ')); process.exit(1) }
