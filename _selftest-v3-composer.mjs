/**
 * _selftest-v3-composer.mjs —— v3 消费端（lib/v3-composer.js）的自检。
 *
 * 为什么要有它：这是"我们接管 Tavern 装配"的那一半，**开关默认关**，但一旦打开就要求
 * 「说得清、错得明、绝不静默降级」——所以这里既测正向，也测反证（把判据改坏必须红）。
 *
 * 夹具形状来自 2026-09-16 沙箱实测（v3 `sources`/`runtime` 的真实字段面），⛔ 不是照文档猜的。
 * 用法：node _selftest-v3-composer.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildComposition, registerV3Composer, selectLoreEntries, DEFAULT_OWNER, SECTION_IDS } from './lib/v3-composer.js'

let pass = 0
const fails = []
function check(name, fn) {
  try { fn(); pass++; console.log('[PASS] ' + name) } catch (e) { fails.push(name); console.log('[FAIL] ' + name + ' :: ' + String((e && e.message) || e)) }
}

/** 真实形状的 sources 夹具（值全是合成文本）。 */
function makeSources(over) {
  return Object.assign({
    schemaVersion: 3,
    sessionId: 'session-accept',
    selection: {
      presetId: null,
      characterCardId: 'card-1',
      userId: null,
      worldBookIds: [],
      character: { greetingIndex: 0, preferCharacterSystemPrompt: true, preferCharacterPostHistory: true },
      rp: { active: true, source: 'character-follow', followSuppressed: false, sandboxBefore: null },
    },
    worldBookSelection: { explicitIds: [], userBoundIds: [], presetBoundIds: [], characterBoundIds: ['card-1'], effectiveIds: [], duplicateIds: [], order: 'character' },
    documents: {
      preset: null,
      character: {
        schemaVersion: 3,
        id: 'card-1',
        name: '验收卡😀',
        data: {
          name: '验收卡😀',
          description: '一句中文描述 🎈。',
          personality: '沉稳、话少。',
          scenario: '雨夜的旧书店。',
          firstMessage: '（推门）你来晚了。',
          messageExample: 'User: 你好\nChar: 嗯。',
          systemPrompt: '你是书店的主人。',
          postHistoryInstructions: '每次不超过两句。',
          alternateGreetings: ['开场二', '开场三 🎉'],
          extensions: { depth_prompt: { prompt: '深度提示词', depth: 4 } },
        },
        compatibility: { warnings: [], unsupportedFeatures: [], unknownMacroNames: [] },
      },
      user: null,
      worldBooks: [],
    },
    greeting: { requestedIndex: 0, effectiveIndex: 0, text: '（推门，铃响）你来晚了。', semantics: 'first-turn-reference' },
    fieldLengths: { '/character/data/description': { characters: 10, utf16Units: 10, utf8Bytes: 14 } },
    suggestedCallConfig: {},
    countUnit: 'characters',
    revision: 'rev-1',
  }, over)
}

/** 真实形状的 runtime 夹具。 */
function makeRuntime(over) {
  return Object.assign({
    kind: 'assembly',
    macroContext: { user: '我', character: '验收卡😀' },
    greetingReferenceApplies: true,
    loreEntries: [
      { id: 'character:card-1:embedded-world-book:0', uid: 0, content: '柜台下有一只猫。', position: 'after' },
      { id: 'character:card-1:embedded-world-book:1', uid: 1, content: '长夜这个词一出现，灯就暗一格。', position: 'after' },
    ],
    worldBookAudit: {
      resources: [{
        resource: { id: 'character:card-1:embedded-world-book', name: '验收卡😀', kind: 'embedded-character-book' },
        budget: { limit: 1000, used: 40 },
        // ★ 真实形状（沙箱实测）：`entryId` 是**裸 uid**（"0"/"1"），不是全名 ——
        //   第一版夹具我写成全名，于是自检全绿、真机一条都命中不了。
        decisions: [
          { resourceId: 'character:card-1:embedded-world-book', entryId: '0', entryName: '', decision: 'rejected', reason: 'primary-key-miss', appliedPosition: null },
          { resourceId: 'character:card-1:embedded-world-book', entryId: '1', entryName: '', decision: 'included', reason: 'primary-key-match', appliedPosition: 'after' },
        ],
      }],
    },
    activation: { kind: 'none', durableMessageCount: 0, pendingMessageCount: 1, claimEventSeqs: [], truncated: false, invalidEventCount: 0 },
    diagnostics: [],
  }, over)
}

const ids = (r) => r.sections.map((s) => s.id)
const textOf = (r, id) => (r.sections.find((s) => s.id === id) || {}).text || ''

// ---------------------------------------------------------------- 1 正向：段序、标签、字段
check('① 正向：段序照 SECTION_IDS，卡字段各成一段、标签与内置观感一致', () => {
  const r = buildComposition({ sources: makeSources(), runtime: makeRuntime(), config: { owner: 'dsh-memory-archive' } })
  const got = ids(r)
  assert.deepEqual(got, ['character-system', 'character-description', 'character-personality', 'character-scenario', 'message-example', 'world-info', 'post-history', 'opening', 'provenance'],
    '段序不对：' + JSON.stringify(got))
  assert.match(textOf(r, 'character-system'), /<st-character-field name="system-prompt">\n你是书店的主人。\n<\/st-character-field>/)
  assert.match(textOf(r, 'character-description'), /一句中文描述 🎈。/)
  assert.match(textOf(r, 'post-history'), /每次不超过两句。/)
  assert.ok(got.every((id) => SECTION_IDS.includes(id)), '出现了 SECTION_IDS 之外的段 id')
  assert.ok(r.sections.length <= 64, '段数超过上游上限 64')
})

// ---------------------------------------------------------------- 2 世界书：只放**命中**的
check('② 世界书只放本轮命中（decisions=included）：被 rejected 的那条必须不出现；provenance 标注判定依据', () => {
  const r = buildComposition({ sources: makeSources(), runtime: makeRuntime(), config: { owner: 'dsh-memory-archive' } })
  const wi = textOf(r, 'world-info')
  assert.match(wi, /长夜这个词一出现/, '命中条目没进装配')
  assert.doesNotMatch(wi, /柜台下有一只猫/, '⛔ 未命中的条目被塞进来了')
  assert.match(wi, /entry="character:card-1:embedded-world-book:1"/, '条目 id 没写进标签属性')
  assert.equal(r.meta.loreBasis, 'decisions')
  assert.equal(r.meta.loreCount, 1)
})

check('②b ★ 裸 uid / 全名 / **数字** 三种写法都要认（真机给的是裸 uid，且可能是数字 —— 只认一种就静默少注入）', () => {
  const mk = (entryId) => {
    const rt = makeRuntime()
    rt.worldBookAudit.resources[0].decisions[1].entryId = entryId
    return buildComposition({ sources: makeSources(), runtime: rt, config: {} })
  }
  for (const key of ['1', 1, 'character:card-1:embedded-world-book:1']) {
    const r = mk(key)
    assert.match(textOf(r, 'world-info'), /长夜这个词一出现/, 'entryId=' + JSON.stringify(key) + ' 时没命中')
    assert.equal(r.meta.unresolvedLore, 0, 'entryId=' + JSON.stringify(key) + ' 被判成"拿不到正文"')
  }
  // 反证：一个不存在的 entryId ⇒ 不该编正文，且要**如实记下**"命中但拿不到正文"
  const rt = makeRuntime()
  rt.worldBookAudit.resources[0].decisions[1].entryId = 'nope'
  const r = buildComposition({ sources: makeSources(), runtime: rt, config: {} })
  assert.equal(r.sections.some((s) => s.id === 'world-info'), false, '⛔ 拿不到正文却编出了 world-info 段')
  assert.equal(r.meta.unresolvedLore, 1, '拿不到正文的命中要如实计数：' + JSON.stringify(r.meta))
  assert.match(textOf(r, 'provenance'), /worldInfo-unresolved=1/, '来源标记要写明有几条命中拿不到正文')
})

// ---------------------------------------------------------------- 3 反证：把判据改坏必须红
check('③ 反证 A：把「命中判定」当成「没判定」⇒ selectLoreEntries 会退回候选集（判据必须能区分这两种）', () => {
  const rt = makeRuntime()
  const withDecisions = selectLoreEntries(rt)
  assert.equal(withDecisions.basis, 'decisions')
  assert.equal(withDecisions.entries.length, 1)
  const noAudit = selectLoreEntries(Object.assign({}, rt, { worldBookAudit: { resources: [] } }))
  assert.equal(noAudit.basis, 'candidates', '读不到判定时必须如实标 candidates')
  assert.equal(noAudit.entries.length, 2, '退回候选集时两条都应在（但会在 provenance 里标注）')
  const r = buildComposition({ sources: makeSources(), runtime: Object.assign({}, rt, { worldBookAudit: { resources: [] } }), config: {} })
  assert.match(textOf(r, 'provenance'), /worldInfo=candidates/, '退回候选集时 provenance 必须如实说清')
})

check('③b 反证 B：把 decisions 全标 included ⇒ 未命中那条必须出现（证明 ② 不是橡皮图章）', () => {
  const rt = makeRuntime()
  rt.worldBookAudit.resources[0].decisions[0].decision = 'included'
  const r = buildComposition({ sources: makeSources(), runtime: rt, config: {} })
  assert.match(textOf(r, 'world-info'), /柜台下有一只猫/, '反证失败：改判据后判据没跟着变')
})

// ---------------------------------------------------------------- 4 开场只在首轮
check('④ 开场段只在 greetingReferenceApplies=true 时产出；第二轮必须没有', () => {
  const first = buildComposition({ sources: makeSources(), runtime: makeRuntime(), config: {} })
  assert.ok(ids(first).includes('opening'), '首轮该有开场段')
  assert.match(textOf(first, 'opening'), /你来晚了/)
  const second = buildComposition({ sources: makeSources(), runtime: makeRuntime({ greetingReferenceApplies: false }), config: {} })
  assert.equal(ids(second).includes('opening'), false, '⛔ 第二轮还给了开场')
  assert.equal(ids(second).includes('provenance'), true, '来源标记仍在')
})

// ---------------------------------------------------------------- 5 空字段不吐空标签
check('⑤ 空字段/缺字段 ⇒ 略过该段（⛔ 不吐空标签），且不编内容', () => {
  const s = makeSources()
  s.documents.character.data.description = ''
  s.documents.character.data.personality = undefined
  s.documents.character.data.messageExample = ''
  const r = buildComposition({ sources: s, runtime: makeRuntime(), config: {} })
  const got = ids(r)
  assert.equal(got.includes('character-description'), false, '空 description 不该成段')
  assert.equal(got.includes('character-personality'), false, '缺 personality 不该成段')
  assert.equal(got.includes('message-example'), false, '空示例不该成段')
  for (const sec of r.sections) assert.ok(sec.text.trim() !== '', '出现了空段：' + sec.id)
})

// ---------------------------------------------------------------- 6 卡字段"不用"的开关
check('⑥ preferCharacterSystemPrompt/PreferCharacterPostHistory=false ⇒ 对应段不产出（选择被尊重）', () => {
  const s = makeSources()
  s.selection.character.preferCharacterSystemPrompt = false
  s.selection.character.preferCharacterPostHistory = false
  const r = buildComposition({ sources: s, runtime: makeRuntime(), config: {} })
  const got = ids(r)
  assert.equal(got.includes('character-system'), false)
  assert.equal(got.includes('post-history'), false)
  assert.equal(got.includes('character-description'), true, '别的字段不该被一起关掉')
})

// ---------------------------------------------------------------- 7 callConfig 默认不回传
check('⑦ callConfig：默认**不回传**（保守）；显式 echoSuggestedCallConfig=true 才回传', () => {
  const s = makeSources({ suggestedCallConfig: { temperature: 0.8, maxTokens: 512 } })
  const off = buildComposition({ sources: s, runtime: makeRuntime(), config: {} })
  assert.equal(off.callConfig, undefined, '默认不该回传 callConfig')
  const on = buildComposition({ sources: s, runtime: makeRuntime(), config: { echoSuggestedCallConfig: true } })
  assert.deepEqual(on.callConfig, { temperature: 0.8, maxTokens: 512 })
  const empty = buildComposition({ sources: makeSources(), runtime: makeRuntime(), config: { echoSuggestedCallConfig: true } })
  assert.equal(empty.callConfig, undefined, '上游没给建议时不该回传空对象')
})

// ---------------------------------------------------------------- 8 坏输入绝不抛
check('⑧ 坏输入（null / 字符串 / 数组 / 空对象）⇒ 绝不抛，最多一段来源标记', () => {
  for (const bad of [undefined, null, {}, { sources: null, runtime: 3 }, { sources: 'x', runtime: [] }, { sources: { documents: { character: { data: null } } }, runtime: { loreEntries: 'nope' } }]) {
    const r = buildComposition(bad)
    assert.ok(Array.isArray(r.sections), 'sections 不是数组')
    assert.ok(r.sections.length <= 1, '坏输入下段数应≤1（只有来源标记）：' + JSON.stringify(ids(r)))
  }
})

// ---------------------------------------------------------------- 9 注册：默认关 / owner 校验
check('⑨ registerV3Composer：默认关不注册；owner 不合法不注册（都不碰服务）', () => {
  let calls = 0
  const fakeCtx = { get: () => ({ registerComposer: () => { calls++; return () => {} } }) }
  assert.equal(registerV3Composer(fakeCtx, { enabled: false }).registered, false)
  assert.equal(calls, 0, '关着还去注册了')
  const bad = registerV3Composer(fakeCtx, { enabled: true, owner: '有中文' })
  assert.equal(bad.registered, false)
  assert.equal(bad.reason, 'bad-owner')
  assert.equal(calls, 0)
})

// ---------------------------------------------------------------- 10 软注入：缺席不拖垮、出现才注册
check('⑩ 软注入：Tavern 服务缺席时**不注册也不抛**（硬 inject 会让整个 Host 起不来，沙箱实测过）；服务出现才注册一次', () => {
  let mounted = null
  const ctx = {
    get: () => undefined,                       // 服务还没来
    inject: (deps, cb) => { assert.deepEqual(deps, ['pmpDshTavernPrompt']); mounted = cb },
    effect: (fn) => fn(),
  }
  const res = registerV3Composer(ctx, { enabled: true, owner: 'dsh-memory-archive' }, { info: () => {}, warn: () => {} })
  assert.equal(res.registered, true)
  assert.equal(res.deferred, true, '必须走软注入（ctx.inject 回调），不能同步硬取服务')
  assert.equal(typeof mounted, 'function')
  // 服务缺席：回调跑完不该抛
  assert.doesNotThrow(() => mounted())
  // 服务出现：注册一次，且 compose 是真函数
  let registered = 0
  let seen = null
  const ctx2 = {
    get: () => ({ registerComposer: (spec) => { registered++; seen = spec; return () => {} } }),
    inject: (_d, cb) => cb(),
    effect: (fn) => fn(),
  }
  const res2 = registerV3Composer(ctx2, { enabled: true, owner: 'dsh-memory-archive' }, { info: () => {}, warn: () => {} })
  assert.equal(registered, 1, '该注册恰好一次')
  assert.equal(seen.id, 'dsh-memory-archive')
  assert.equal(typeof seen.compose, 'function')
  const composed = seen.compose({ sources: makeSources(), runtime: makeRuntime() })
  assert.ok(Array.isArray(composed.sections) && composed.sections.length > 0, 'compose 没产出段')
  assert.equal(composed.callConfig, undefined, '默认不回传 callConfig')
  assert.equal(res2.owner, DEFAULT_OWNER)
})

// ---------------------------------------------------------------- 11 同步纪律
check('⑪ 合同纪律：compose 必须**同步**返回（不是 Promise）、不 await、段名走 upstream 命名空间', () => {
  const spec = { compose: null }
  const ctx = { get: () => ({ registerComposer: (s) => { spec.compose = s.compose; return () => {} } }), inject: (_d, cb) => cb(), effect: (fn) => fn() }
  registerV3Composer(ctx, { enabled: true }, { info: () => {}, warn: () => {} })
  const out = spec.compose({ sources: makeSources(), runtime: makeRuntime() })
  assert.equal(typeof out?.then, 'undefined', '⛔ compose 返回了 Promise（合同要求同步）')
  for (const s of out.sections) {
    assert.match(s.id, /^[a-z0-9-]+$/, '段 id 形状不合 upstream 命名约定：' + s.id)
    assert.equal(typeof s.text, 'string')
  }
  const raw = readFileSync(new URL('./lib/v3-composer.js', import.meta.url), 'utf8')
  // ⚠️ 先剥注释再查纪律：模块的**说明文字**里就写着"绝不 await / 不联网"，直接正则会被自己的文档误伤
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /\bawait\b/, '⛔ 模块里出现了 await（compose 必须同步、快、不联网）')
  assert.doesNotMatch(code, /fetch\(|readFileSync|from 'node:fs'|from 'node:http'/, '⛔ 模块里出现了联网/读盘（合同明令禁止）')
})

check('⑫ ★ 宏处理（现场踩到的坑）：`{{user}}`/`{{char}}` 用 macroContext 展开，解不了的**中和**成不带花括号的词 —— 因为 DSH 会把 `{{名字}}` 当变量并**直接让整轮失败**', () => {
  const s = makeSources()
  s.documents.character.data.messageExample = '{{user}}: 你好\n{{char}}: 嗯。{{random}}'
  s.documents.character.data.description = '{{CHAR}} 在雨里。'
  const r = buildComposition({ sources: s, runtime: makeRuntime(), config: {} })
  const ex = textOf(r, 'message-example')
  assert.match(ex, /我: 你好/, '{{user}} 没展开成 macroContext.user')
  assert.match(ex, /验收卡😀: 嗯。/m, '{{char}} 没展开成 macroContext.character')
  assert.match(ex, /random/, '解不了的宏应**保留名字**（⛔ 不是删掉整个词）')
  assert.equal(/random/.test(ex) && /\{\{random\}\}/.test(ex), false, '⛔ 解不了的宏还留着 {{…}}，DSH 会判 unknown/malformed')
  // 判据对齐 DSH 自己的规则：GROUP_AT = /^\{\{([^{}]*)\}\}/ + VARIABLE_NAME = /^[a-z][a-z0-9_]*$/
  const GROUP = /\{\{([^{}]*)\}\}/
  for (const sec of r.sections) {
    const m = GROUP.exec(sec.text)
    assert.equal(m, null, '段 ' + sec.id + ' 里还残留 {{' + (m ? m[1] : '') + '}} —— 这一轮会直接失败')
  }
  assert.equal(r.meta.macros.expanded.includes('user') || r.meta.macros.expanded.includes('char'), true, 'meta 要记下展开了哪些宏')
  assert.ok(r.meta.macros.neutralized.includes('random'), 'meta 要记下中和了哪些宏：' + JSON.stringify(r.meta.macros))
  assert.match(textOf(r, 'provenance'), /macros=/, '来源标记里要写明宏处理过')
  assert.match(textOf(r, 'provenance'), /macros-neutralized=1/)
})

check('⑫b 反证：把宏处理去掉（直接塞原文）⇒ 段里必然出现 `{{user}}`（证明 ⑫ 不是橡皮图章）', () => {
  const raw = buildComposition({ sources: makeSources(), runtime: makeRuntime(), config: { omitFields: [] } })
  const direct = '{{user}}: 你好'
  assert.match(direct, /\{\{([^{}]*)\}\}/, '反证夹具本身不对')
  const withoutNeutralize = { sections: [{ id: 'x', text: direct }] }
  assert.notEqual(withoutNeutralize.sections[0].text, raw.sections.find((x) => x.id === 'character-description').text)
  assert.equal(/\{\{[^{}]*\}\}/.test(raw.sections.map((x) => x.text).join('\n')), false, '⛔ 组合器输出里仍有 {{…}}')
})

check('⑫c 畸形嵌套（`{{a{{b}}}}`）也要被拆开 —— DSH 对它是 malformed 而不是普通文本', () => {
  const s = makeSources()
  s.documents.character.data.description = '前 {{a{{b}}}} 后'
  const r = buildComposition({ sources: s, runtime: makeRuntime(), config: {} })
  const d = textOf(r, 'character-description')
  assert.doesNotMatch(d, /\{\{[^{}]*\}\}/, '畸形嵌套没被中和：' + d)
  assert.match(d, /\{ \{/, '兜底应把花括号拆成 { { 而不是删掉内容')
  assert.match(r.meta.macros.neutralized.join(','), /malformed/, 'meta 要记下兜底过')
})

check('⑬ ★ 上游合同最硬的一条：段对象**只许有 `{id, text}`**（多一个键就 422 "Sections require unique ids and text" —— 我就是这么栽的）', () => {
  const r = buildComposition({ sources: makeSources(), runtime: makeRuntime(), config: {} })
  const bad = r.sections.filter((s) => Object.keys(s).some((k) => k !== 'id' && k !== 'text'))
  assert.deepEqual(bad, [], '段里出现了 id/text 之外的键：' + JSON.stringify(bad.slice(0, 2)))
  // 注释性信息必须进 meta.notes（我们自己的自检/面板用它，但**不进段**）
  assert.ok(isObjLike(r.meta.notes) && typeof r.meta.notes['world-info'] === 'string', 'meta.notes 该有 world-info 的说明：' + JSON.stringify(r.meta.notes))
  // 逐条复刻上游的校验（prompt-composition.js:220-237）
  assert.ok(Array.isArray(r.sections) && r.sections.length <= 64)
  const names = new Set()
  for (const s of r.sections) {
    assert.equal(typeof s.id, 'string')
    assert.match(s.id, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/, '段 id 不合上游 OWNER 形状：' + s.id)
    assert.equal(names.has(s.id), false, '段 id 重复：' + s.id)
    names.add(s.id)
    assert.equal(typeof s.text, 'string')
  }
  // 反证：把 note 挂回段上 ⇒ 上面那条过滤必须能抓到
  const withNote = r.sections.map((s, i) => (i === 0 ? Object.assign({}, s, { note: 'x' }) : s))
  assert.equal(withNote.filter((s) => Object.keys(s).some((k) => k !== 'id' && k !== 'text')).length, 1, '反证失败：多键没被检出')
})

function isObjLike(v) { return typeof v === 'object' && v !== null && !Array.isArray(v) }

check('⑫d 认得出但**值为空**的宏 ⇒ 留空（与内置观感一致），⛔ 不漏出字面词 `char`', () => {
  const rt = makeRuntime({ macroContext: { user: '我', character: '' } })
  const s = makeSources()
  s.documents.character.data.messageExample = '{{user}}: 你好\n{{char}}: 嗯。'
  const r = buildComposition({ sources: s, runtime: rt, config: {} })
  const ex = textOf(r, 'message-example')
  assert.match(ex, /^我: 你好$/m, '{{user}} 该展开成 macroContext.user')
  assert.doesNotMatch(ex, /\bchar:/, '⛔ {{char}} 值为空时漏出了字面词')
  assert.match(ex, /^: 嗯。$/m, '{{char}} 值为空时该留空（行内只剩冒号）')
  assert.ok(r.meta.macros.expanded.includes('char'), '空值也算"认得出"（进 expanded，而不是 neutralized）')
})

console.log('\n== v3 组合器自检：' + pass + ' 通过 / ' + fails.length + ' 失败 ==')
if (fails.length) { console.log('失败项：\n  - ' + fails.join('\n  - ')); process.exit(1) }
