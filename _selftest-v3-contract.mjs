// _selftest-v3-contract.mjs —— lib/v3-contract.js 的行为级自检台（纯函数，不碰宿主）。
//
// 口径照项目惯例：每条断言带**反证** —— 不光看"该判对时判对了"，还要看"形状不认识时**没有**乱猜"。
// 本台子里的两份 capabilities 都是**真样本**：
//   · COMPOSER_CAPS 抄自 2026-09-17 真机 `GET /pmp-dsh-tavern/api/v3/capabilities`
//   · TRACE_CAPS   抄自上游 `codex/trace-api-v3` 的 `packages/tavern-loader/src/prompt-trace-api.js`
// 退出码：全绿 0 / 有红 1（用 process.exitCode，⛔ 不用 process.exit）。
import {
  V3_CONTRACT_VERSION, V3_ROOT, TAVERN_PLUGIN_ID, PART_SECTION_PREFIX, PROFILE_SECTION,
  COMPOSER_SERVICE, TRACE_CONTRACT_ID,
  CONTRACT_TRACE, CONTRACT_COMPOSER, CONTRACT_ABSENT, CONTRACT_UNKNOWN,
  detectV3Contract, contractInfo, v3Paths, parsePartSectionName, fieldChars,
  projectSources, projectAssemblyIndex, projectAssemblyRecord, pickSectionText,
  PHI_PART_FIELD, isPhiPartSection, stripPhiParts,
} from './lib/v3-contract.js'

let pass = 0
let fail = 0
function check(id, label, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✔ ${id} ${label}`) }
  else { fail += 1; console.log(`  ✘ ${id} ${label}${detail === undefined ? '' : '  ← ' + detail}`) }
}

// ───────────────────────────── 真样本 ─────────────────────────────
/** 真机 2026-09-17：composer 合同。 */
const COMPOSER_CAPS = {
  ok: true, apiVersion: 3, service: 'pmpDshTavernPrompt', modes: ['builtin', 'external'],
  lifetime: 'persistent-session-preference', composers: ['dsh-memory-archive'],
  maxSourceBytes: 16777216, maxProfileBytes: 524288, maxSections: 64,
  synchronous: true, arbitraryMessageDepth: false,
}
/** 上游 trace 分支：prompt-trace-api.js 里 capabilities 的原样字段。 */
const TRACE_CAPS = {
  ok: true, apiVersion: 3, contract: 'prompt-trace-primitives', sourceMapping: 'section-contributors',
  currentSources: true, historicalAssemblies: true, composerRegistry: false,
  officialSections: true, arbitraryMessageDepth: false, maxSourceBytes: 16777216,
  storage: { kind: 'bounded-assembly-snapshots', maxRecords: 256, maxRecordBytes: 2097152, maxTotalBytes: 16777216 },
}

// ───────────────────────────── C1 常量 ─────────────────────────────
console.log('\nC1 常量与路径')
check('C1a', '版本是正整数', Number.isInteger(V3_CONTRACT_VERSION) && V3_CONTRACT_VERSION > 0)
check('C1b', '根路径与 Tavern 的 API_V3 一致', V3_ROOT === `/${TAVERN_PLUGIN_ID}/api/v3`, V3_ROOT)
check('C1c', ':part: 前缀 = 插件 id + ":part:"', PART_SECTION_PREFIX === `${TAVERN_PLUGIN_ID}:part:`, PART_SECTION_PREFIX)
check('C1d', 'profile 段名 = 插件 id + ":profile"', PROFILE_SECTION === `${TAVERN_PLUGIN_ID}:profile`, PROFILE_SECTION)
check('C1e', '★ 反证：:part: 前缀**不是** profile 段名的前缀（两者不能互相误吞）',
  !PROFILE_SECTION.startsWith(PART_SECTION_PREFIX) && !PART_SECTION_PREFIX.startsWith(PROFILE_SECTION))

// ───────────────────────────── C2 合同判定 ─────────────────────────────
console.log('\nC2 detectV3Contract')
{
  const t = detectV3Contract(TRACE_CAPS)
  check('C2a', '真样本 trace ⇒ trace', t.contract === CONTRACT_TRACE && t.known === true, JSON.stringify(t))
  const c = detectV3Contract(COMPOSER_CAPS)
  check('C2b', '真样本 composer ⇒ composer', c.contract === CONTRACT_COMPOSER && c.known === true, JSON.stringify(c))
  check('C2c', '★ 反证：两份真样本判出的合同**必须不同**（这正是当初静默谎报的根因）', t.contract !== c.contract)

  // 前瞻：contract 字符串将来变了，但 composerRegistry:false + officialSections:true 还在
  const future = { ok: true, apiVersion: 4, composerRegistry: false, officialSections: true, contract: 'prompt-trace-v4-whatever' }
  check('C2d', '★ 前瞻：contract 字符串换了但自述否认注册表 ⇒ 仍判 trace',
    detectV3Contract(future).contract === CONTRACT_TRACE, JSON.stringify(detectV3Contract(future)))

  // 自相矛盾：一边否认注册表一边自称有 composers ⇒ 按保守当 composer
  const liar = { ok: true, composerRegistry: false, officialSections: true, composers: ['x'] }
  check('C2e', '★ 反证：自相矛盾（否认注册表却又列出 composers）⇒ 保守判 composer，不判 trace',
    detectV3Contract(liar).contract === CONTRACT_COMPOSER, JSON.stringify(detectV3Contract(liar)))

  // 只有 service 字段（旧合同的老版本可能没有 composers/modes）
  check('C2f', '只有 service 字段 ⇒ composer',
    detectV3Contract({ ok: true, service: COMPOSER_SERVICE }).contract === CONTRACT_COMPOSER)
  check('C2g', '只有 modes 数组 ⇒ composer',
    detectV3Contract({ ok: true, modes: ['builtin', 'external'] }).contract === CONTRACT_COMPOSER)

  // unknown：形状不认识
  const weird = { ok: true, apiVersion: 3, someNewThing: 'yes' }
  const u = detectV3Contract(weird)
  check('C2h', '★ 反证：认不出的形状 ⇒ unknown 且 known:false（⛔ 不猜成任意一套）',
    u.contract === CONTRACT_UNKNOWN && u.known === false, JSON.stringify(u))

  // absent：读不到
  for (const [label, v] of [['undefined', undefined], ['null', null], ['字符串', 'nope'], ['数组', []], ['ok:false', { ok: false, error: 'not found' }]]) {
    const got = detectV3Contract(v)
    check('C2i.' + label, `形状「${label}」⇒ absent 且 known:false 且不抛`,
      got.contract === CONTRACT_ABSENT && got.known === false, JSON.stringify(got))
  }
  check('C2j', '判词非空（面板要显示"为什么这么判"）',
    [detectV3Contract(TRACE_CAPS), detectV3Contract(COMPOSER_CAPS), u].every((r) => typeof r.reason === 'string' && r.reason.length > 0))
}

// ───────────────────────────── C3 contractInfo ─────────────────────────────
console.log('\nC3 contractInfo：只有判得准的时候才敢说"可用/不可用"')
{
  const t = contractInfo(CONTRACT_TRACE)
  check('C3a', 'trace ⇒ 组合器不可用、尾部段服务不可用、模式不可切',
    t.known === true && t.composerUsable === false && t.tailServiceUsable === false && t.modeSwitchable === false, JSON.stringify(t))
  const c = contractInfo(CONTRACT_COMPOSER)
  check('C3b', 'composer ⇒ 三项都可用',
    c.known === true && c.composerUsable === true && c.tailServiceUsable === true && c.modeSwitchable === true, JSON.stringify(c))
  for (const k of [CONTRACT_ABSENT, CONTRACT_UNKNOWN]) {
    const i = contractInfo(k)
    check('C3c.' + k, `★ 反证：${k} ⇒ 三项一律 null（值域是 true/false/null，"读不到"绝不等于"失效"）`,
      i.known === false && i.composerUsable === null && i.tailServiceUsable === null && i.modeSwitchable === null, JSON.stringify(i))
  }
  check('C3d', '真样本判词交叉核对：trace 的 detail 必须点名 composerRegistry，composer 的必须点名 external',
    contractInfo(CONTRACT_TRACE).detail.includes('composerRegistry') && contractInfo(CONTRACT_COMPOSER).detail.includes('external'))
}

// ───────────────────────────── C4 端点路径 ─────────────────────────────
console.log('\nC4 v3Paths：两套合同的端点**不通用**')
{
  const sid = 'session-abc'
  check('C4a', 'capabilities 只有一条路径（两套共用）', v3Paths.capabilities() === `${V3_ROOT}/capabilities`, v3Paths.capabilities())
  check('C4b', 'composer 的 sources 走 prompt-sources',
    v3Paths.sources(CONTRACT_COMPOSER, sid) === `${V3_ROOT}/sessions/${sid}/prompt-sources`, String(v3Paths.sources(CONTRACT_COMPOSER, sid)))
  check('C4c', 'trace 的 sources 走 sources',
    v3Paths.sources(CONTRACT_TRACE, sid) === `${V3_ROOT}/sessions/${sid}/sources`, String(v3Paths.sources(CONTRACT_TRACE, sid)))
  check('C4d', '★ 反证：同一个会话，两套合同的 sources 路径**必须不同**（拼错就是 404 静默）',
    v3Paths.sources(CONTRACT_COMPOSER, sid) !== v3Paths.sources(CONTRACT_TRACE, sid))
  check('C4e', 'mode 只有 composer 有；trace ⇒ null',
    typeof v3Paths.mode(CONTRACT_COMPOSER, sid) === 'string' && v3Paths.mode(CONTRACT_TRACE, sid) === null)
  check('C4f', 'assemblies 只有 trace 有；composer ⇒ null',
    typeof v3Paths.assemblies(CONTRACT_TRACE, sid) === 'string' && v3Paths.assemblies(CONTRACT_COMPOSER, sid) === null)
  check('C4g', 'trace 的单条详情路径', v3Paths.assemblyRecord(CONTRACT_TRACE, sid, 'rec-1') === `${V3_ROOT}/sessions/${sid}/assemblies/rec-1`)
  check('C4h', '★ 反证：缺 sessionId / recordId 一律 null（⛔ 不拼出半个 URL）',
    v3Paths.sources(CONTRACT_TRACE, '') === null && v3Paths.assemblies(CONTRACT_TRACE, '') === null
    && v3Paths.assemblyRecord(CONTRACT_TRACE, sid, '') === null && v3Paths.assemblyRecord(CONTRACT_TRACE, '', 'r') === null)
  check('C4i', 'sessionId 会被 URL 编码',
    v3Paths.sources(CONTRACT_TRACE, 'a b/c') === `${V3_ROOT}/sessions/a%20b%2Fc/sources`, String(v3Paths.sources(CONTRACT_TRACE, 'a b/c')))
}

// ───────────────────────────── C5 :part: 段名解析 ─────────────────────────────
console.log('\nC5 parsePartSectionName')
{
  const real = [
    ['pmp-dsh-tavern:part:0000:generated:header', 0, 'generated', 'header'],
    ['pmp-dsh-tavern:part:0003:character:description', 3, 'character', 'description'],
    ['pmp-dsh-tavern:part:0007:preset:prompts_0_content', 7, 'preset', 'prompts_0_content'],
    ['pmp-dsh-tavern:part:0011:worldbook:content', 11, 'worldbook', 'content'],
  ]
  for (const [name, ord, kind, field] of real) {
    const p = parsePartSectionName(name)
    check('C5a.' + ord, `真名 ${name} ⇒ ordinal/kind/field`,
      p !== null && p.ordinal === ord && p.kind === kind && p.field === field, JSON.stringify(p))
  }
  check('C5b', '★ 反证：profile 段名**不是** :part: 段 ⇒ null', parsePartSectionName(PROFILE_SECTION) === null, String(parsePartSectionName(PROFILE_SECTION)))
  check('C5c', '★ 反证：我们自己的段名不是 :part: 段 ⇒ null',
    [ 'state:card', 'anima:memory', 'mt:lastFloors', 'mt:postHistory', 'rp:firstRound' ].every((n) => parsePartSectionName(n) === null))
  check('C5d', '★ 反证：别的插件的同名族不误吞（前缀必须精确是 pmp-dsh-tavern）',
    parsePartSectionName('other-plugin:part:0000:character:description') === null)
  for (const bad of ['', null, undefined, 'pmp-dsh-tavern:part:', 'pmp-dsh-tavern:part:abcd:x:y', 'pmp-dsh-tavern:part:0001:', 'pmp-dsh-tavern:part:0001']) {
    let got
    try { got = parsePartSectionName(bad) } catch (e) { got = 'THREW:' + e.message }
    check('C5e.' + String(bad), `畸形「${String(bad)}」⇒ null 且不抛`, got === null, String(got))
  }
  // 只切第一个冒号的证据
  const colon = parsePartSectionName('pmp-dsh-tavern:part:0002:character:a:b')
  check('C5f', '★ field 里含冒号时只切第一个（field = "a:b"，不是 "a"）',
    colon !== null && colon.kind === 'character' && colon.field === 'a:b', JSON.stringify(colon))
  const noField = parsePartSectionName('pmp-dsh-tavern:part:0009:generated')
  check('C5g', '只有 kind 没有 field ⇒ 不抛，field 为空串', noField !== null && noField.field === '' && noField.kind === 'generated', JSON.stringify(noField))
  check('C5h', '★ sanitized 标记：带 field 的为 true（上游把非 [A-Za-z0-9_.:-] 换成了 _，不可逆）',
    parsePartSectionName('pmp-dsh-tavern:part:0003:character:description').sanitized === true)
}

// ───────────────────────────── C6 fieldChars ─────────────────────────────
console.log('\nC6 fieldChars')
{
  const data = {
    systemPrompt: 'abc', description: 'de', personality: '', scenario: 'xy',
    messageExample: 'mm', postHistoryInstructions: 'p', firstMessage: 'hi',
    alternateGreetings: ['g1', 'g222'], name: '甲',
  }
  const got = fieldChars(data)
  const keys = got.map((f) => f.key)
  check('C6a', '七个字段里空串的那个被跳过', !keys.includes('personality') && keys.includes('description'), JSON.stringify(keys))
  check('C6b', '字数取 characters 口径', got.find((f) => f.key === 'systemPrompt').chars === 3)
  check('C6c', 'alternateGreetings 给合并字数 + 条数（"g1"+"g222" = 6 字 / 2 条）',
    got.find((f) => f.key === 'alternateGreetings').chars === 6 && got.find((f) => f.key === 'alternateGreetings').count === 2,
    JSON.stringify(got.find((f) => f.key === 'alternateGreetings')))
  check('C6d', '★ 反证：非字符串字段不猜（数字 42 不当成 2 个字）', fieldChars({ description: 42 }).length === 0)
  check('C6e', '★ 反证：畸形输入不抛且回空数组', [null, undefined, 'x', [], 1].every((v) => { try { return fieldChars(v).length === 0 } catch { return false } }))
}

// ───────────────────────────── C7 projectSources ─────────────────────────────
console.log('\nC7 projectSources：两套合同的 sources 形状一致，共用一个投影')
{
  /** 按上游 prompt-trace-api.js 的 getSources() 组装的真形状（合成数据，无真实角色）。 */
  const mkSources = () => ({
    schemaVersion: 3, sessionId: 'session-abc', countUnit: 'unicode-code-points', revision: 'deadbeefdeadbeef',
    selection: { presetId: 'p1', characterCardId: 'c1', userId: 'u1', character: { preferCharacterPostHistory: false }, rp: { active: true } },
    worldBookSelection: { explicitIds: ['w1'], userBoundIds: [], presetBoundIds: ['w2'], characterBoundIds: ['w3'], effectiveIds: ['w1', 'w2', 'w3'], duplicateIds: ['w3'] },
    documents: { character: { id: 'c1', name: '甲', data: { postHistoryInstructions: 'ZZphiZZ', description: 'ZZdescZZ' } }, user: { id: 'u1', data: { name: '乙' } }, preset: null, worldBooks: [] },
    greeting: { requestedIndex: 0, effectiveIndex: 1, text: '开场白', semantics: 'first-turn-reference' },
    fieldLengths: { '/character/data/description': { characters: 4, utf16Units: 4, utf8Bytes: 4 } },
    suggestedCallConfig: { temperature: 0.8 },
  })
  const p = projectSources(mkSources())
  check('C7a', '卡名 / 卡 id / revision / 计数单位都取到',
    p.cardName === '甲' && p.cardId === 'c1' && p.revision === 'deadbeefdeadbeef' && p.countUnit === 'unicode-code-points', JSON.stringify({ n: p.cardName, r: p.revision }))
  check('C7b', '开场给 requested/effective/semantics/chars 四件',
    p.greeting.requestedIndex === 0 && p.greeting.effectiveIndex === 1 && p.greeting.chars === 3 && p.greeting.semantics === 'first-turn-reference', JSON.stringify(p.greeting))
  check('C7c', '世界书六个计数各自独立', p.worldBooks.effective === 3 && p.worldBooks.duplicate === 1 && p.worldBooks.userBound === 0, JSON.stringify(p.worldBooks))
  check('C7d', 'fieldLengths 只给条数（面板要的是"有没拿到"，不是逐条）', p.fieldLengthKeys === 1)
  check('C7e', 'preset 选中但文档为 null ⇒ 不抛', p.presetId === 'p1')
  // 用哨兵串而不是 'desc'/'phi'：投影里合法地存在 label:'description' 这类字样，
  // 拿子串判会把"标签里有 desc"误当成"把正文泄出去了"。哨兵串只可能来自正文。
  check('C7f', '★ 反证：**不把卡字段正文交给面板**（哨兵串一个都出现不了）',
    !Object.prototype.hasOwnProperty.call(p, 'documents') && !JSON.stringify(p).includes('ZZdescZZ') && !JSON.stringify(p).includes('ZZphiZZ'),
    JSON.stringify(Object.keys(p)))
  check('C7g', '★ 反证：畸形输入 ⇒ null 且不抛', [null, undefined, 'x', []].every((v) => { try { return projectSources(v) === null } catch { return false } }))

  // ── presetMode：replace 看守**唯一确定性**的判据（⛔ 不用"段变少了"那种启发式）──
  check('C7h', 'preset 是 null（没选预设）⇒ **append** 而不是 null（照上游口径：没预设时有效模式就是 append）',
    p.presetMode === 'append', String(p.presetMode))
  check('C7i', 'preset.systemPromptMode === "replace" ⇒ replace', (() => {
    const s = mkSources(); s.documents.preset = { id: 'p1', systemPromptMode: 'replace' }
    return projectSources(s).presetMode === 'replace'
  })())
  check('C7j', 'preset 选了但没写 systemPromptMode ⇒ append（照上游口径兜底）', (() => {
    const s = mkSources(); s.documents.preset = { id: 'p1' }
    return projectSources(s).presetMode === 'append'
  })())
  check('C7k', '★ 反证：documents 里**没有** preset 这个键 ⇒ null（读不到就是读不到，⛔ 不猜成 append）', (() => {
    const s = mkSources(); delete s.documents.preset
    return projectSources(s).presetMode === null
  })())
}

// ───────────────────────────── C8 projectAssemblyIndex ─────────────────────────────
console.log('\nC8 projectAssemblyIndex：实时记录与 legacy 适配记录要分得开')
{
  const index = {
    ok: true, sessionId: 'session-abc',
    storage: { kind: 'bounded-assembly-snapshots', maxRecords: 256, maxRecordBytes: 2097152, maxTotalBytes: 16777216 },
    records: [
      { schemaVersion: 3, id: 'legacy:7', sessionId: 'session-abc', turn: 7, step: 0, attempt: 1, recordedAt: 1000, status: 'legacy-metadata-only', contentStatus: 'legacy-metadata-only' },
      { schemaVersion: 3, id: 'rec-1', sessionId: 'session-abc', turn: 8, step: 0, attempt: 1, recordedAt: 2000, status: 'request-observed', contentStatus: 'available', sectionCount: 12 },
    ],
  }
  const out = projectAssemblyIndex(index)
  check('C8a', '两条都在、按原序', out.records.length === 2 && out.records[0].id === 'legacy:7' && out.records[1].id === 'rec-1')
  check('C8b', 'legacy 被标出来', out.records[0].legacy === true && out.records[1].legacy === false)
  check('C8c', '★ 反证：legacy 的 sectionCount 是 **null** 而不是 0（0 会被读成"采到了但零段"）',
    out.records[0].sectionCount === null && out.records[1].sectionCount === 12, JSON.stringify(out.records.map((r) => r.sectionCount)))
  check('C8d', 'storage 原样带出（面板要显示容量）', out.storage.maxRecords === 256 && out.total === 2)
  check('C8e', '★ 反证：畸形 ⇒ null 且不抛', [null, undefined, 'x'].every((v) => { try { return projectAssemblyIndex(v) === null } catch { return false } }))
  check('C8f', '空索引是合法的成功（不是错误）', projectAssemblyIndex({ ok: true, records: [], storage: {} }).records.length === 0)
  check('C8g', 'maxRecords 截断只丢**最旧**的',
    projectAssemblyIndex({ ok: true, records: index.records }, { maxRecords: 1 }).records[0].id === 'rec-1')
}

// ───────────────────────────── C9 projectAssemblyRecord ─────────────────────────────
console.log('\nC9 projectAssemblyRecord：段级元数据 vs 段正文')
{
  const record = {
    schemaVersion: 3, id: 'rec-1', sessionId: 'session-abc', turn: 8, step: 0, attempt: 1, recordedAt: 2000,
    status: 'request-observed', contentStatus: 'available', sourceMapping: 'section-contributors',
    sections: [
      { name: 'pmp-dsh-tavern:part:0000:character:description', index: 0, text: '正文甲', characters: 3, utf16Units: 3, utf8Bytes: 9, hash: 'h0', provenance: 'section-contributors', offsetUtf16: 0, sources: [{ kind: 'character', field: 'description', resourceId: 'c1', relationship: 'input', characters: 3 }] },
      { name: 'state:card', index: 1, text: '正文乙', characters: 3, hash: 'h1', provenance: 'unknown', offsetUtf16: 5, sources: [] },
    ],
    contexts: [{ name: 'x', text: 'c' }],
    delivery: { stage: 'llm/stream', provider: 'p', model: 'm', toolNames: ['skill', 'web_search'], assemblyVerified: false, systemMessageIndex: null, logCutSeq: 41, sessionVersion: 3 },
    systemMessages: ['系统全文不该被投影出去'],
  }
  const meta = projectAssemblyRecord(record)
  check('C9a', '段数与上下文档数', meta.sections.length === 2 && meta.sectionTotal === 2 && meta.contextCount === 1)
  check('C9b', ':part: 段被解析出 kind/field', meta.sections[0].part !== null && meta.sections[0].part.kind === 'character' && meta.sections[0].part.field === 'description', JSON.stringify(meta.sections[0].part))
  check('C9c', '非 :part: 段 part 为 null（我们的 state:card 不会被误认）', meta.sections[1].part === null)
  check('C9d', '来源投影保留 kind/field/resourceId/relationship',
    meta.sections[0].sources.length === 1 && meta.sections[0].sources[0].resourceId === 'c1' && meta.sections[0].sources[0].relationship === 'input')
  check('C9e', 'delivery 带 provider/model/toolNames（工具面终于有正规来源）',
    meta.delivery.provider === 'p' && meta.delivery.model === 'm' && meta.delivery.toolNames.join(',') === 'skill,web_search', JSON.stringify(meta.delivery))
  check('C9f', '★ 反证：**默认不投影段正文**（投影里出现不了"正文甲"）', !JSON.stringify(meta).includes('正文甲') && !JSON.stringify(meta).includes('正文乙'))
  check('C9g', '★ 反证：**不投影 systemMessages 全文**', !JSON.stringify(meta).includes('系统全文'))
  check('C9h', '★ 反证：assemblyVerified 为 false 时如实为 false（⛔ 不把"没核对上"说成核对上了）',
    meta.delivery.assemblyVerified === false && meta.delivery.systemMessageIndex === null)
  check('C9i', '显式 includeText 才带正文', (() => {
    const withText = projectAssemblyRecord(record, { includeText: true })
    return withText.sections[0].text === '正文甲' && withText.sections[1].text === '正文乙'
  })())
  check('C9j', '★ 反证：omitted-size-limit 时 textAvailable 为 false（超限没正文就说没有）',
    projectAssemblyRecord({ ...record, contentStatus: 'omitted-size-limit' }).textAvailable === false)
  check('C9k', '★ 反证：畸形 ⇒ null 且不抛', [null, undefined, 'x'].every((v) => { try { return projectAssemblyRecord(v) === null } catch { return false } }))
}

// ───────────────────────────── C10 pickSectionText ─────────────────────────────
console.log('\nC10 pickSectionText：按需取正文，越界不猜')
{
  const record = { sections: [{ index: 0, name: 'a', text: '甲' }, { index: 1, name: 'b' }, { index: 2, name: 'c', text: '丙' }] }
  check('C10a', '取得到 index=0 那段', pickSectionText(record, 0) === '甲')
  check('C10b', 'index=2 那段', pickSectionText(record, 2) === '丙')
  check('C10c', '★ 反证：text 不是字符串 ⇒ null（不是空串 —— 空串会假装"有正文但是空的"）', pickSectionText(record, 1) === null)
  for (const bad of [-1, 3, 999, 1.5, NaN, Infinity, '0', null, undefined]) {
    check('C10d.' + String(bad), `越界/非法索引「${String(bad)}」⇒ null`, pickSectionText(record, bad) === null)
  }
  check('C10e', '★ 反证：畸形 record ⇒ null 且不抛', [null, undefined, 'x', {}].every((v) => { try { return pickSectionText(v, 0) === null } catch { return false } }))

  // ★★ 这条是 2026-09-17 沙箱实测踩到的真坑：上游"先编号、再滤掉空段" ⇒ 落盘数组里
  //    `index` **不连续**（实测 0..10、14..32、34）。按下标取会**取错段**甚至越界。
  const gapped = { sections: [
    { index: 0, name: 'x', text: 'X0' },
    { index: 14, name: 'y', text: 'Y14' },   // 数组下标 1，但 index=14
    { index: 34, name: 'mt:postHistory', text: '尾部' },
  ] }
  check('C10f', '★ 有缺口时按 index 找得到（index=14 在数组下标 1）', pickSectionText(gapped, 14) === 'Y14')
  check('C10g', '★ 有缺口时 index=34 找得到（数组只有 3 个元素）', pickSectionText(gapped, 34) === '尾部')
  check('C10h', '★ 反证：按下标取会取错的那一格 —— index=1 是**不存在**的 ⇒ null（⛔ 不许拿数组下标顶替）',
    pickSectionText(gapped, 1) === null)
  check('C10i', '★ 反证：index=2 也不存在 ⇒ null', pickSectionText(gapped, 2) === null)
}

// ───────────────────────────── C11 PHI 段识别与摘除（T7） ─────────────────────────────
console.log('\nC11 isPhiPartSection / stripPhiParts')
{
  check('C11a', '常量就是卡里那个驼峰键', PHI_PART_FIELD === 'postHistoryInstructions', PHI_PART_FIELD)
  check('C11b', '认出 Tavern 展开的 PHI 段', isPhiPartSection({ name: 'pmp-dsh-tavern:part:0006:character:postHistoryInstructions' }) === true)
  check('C11c', '★ 反证：别的卡字段段**不**误判', [
    'pmp-dsh-tavern:part:0000:generated:header',
    'pmp-dsh-tavern:part:0001:character:systemPrompt',
    'pmp-dsh-tavern:part:0002:character:description',
    'pmp-dsh-tavern:part:0007:character:depthPrompt',
  ].every((n) => isPhiPartSection({ name: n }) === false))
  check('C11d', '★ 反证：我们自己的段、别的插件的段都不误判',
    ['mt:postHistory', 'mt:lastFloors', 'state:card', 'rp:policy', 'harness:source'].every((n) => isPhiPartSection({ name: n }) === false))
  check('C11e', '★ 记录已知边界：经预设 jailbreak 注入的 PHI 段名会是 preset:… ⇒ **认不出来**（不许假装认得）',
    isPhiPartSection({ name: 'pmp-dsh-tavern:part:0011:preset:prompts_3_content' }) === false)
  check('C11f', '★ 反证：畸形输入不抛、一律 false', [null, undefined, {}, [], 3, 'x'].every((v) => { try { return isPhiPartSection(v) === false } catch { return false } }))

  const secs = [
    { name: 'harness:identity', text: 'a' },
    { name: 'pmp-dsh-tavern:part:0006:character:postHistoryInstructions', text: 'phi', characters: 90 },
    { name: 'mt:postHistory', text: 'ours', characters: 90 },
  ]
  const r = stripPhiParts(secs)
  check('C11g', '摘掉那一份，留下别的（含我们自己的尾段）', r.kept.length === 2 && r.removed.length === 1
    && r.kept.some((s) => s.name === 'mt:postHistory') && r.kept.some((s) => s.name === 'harness:identity'), JSON.stringify(r.removed))
  check('C11h', '摘除清单带名字与字数（供面板如实报告）', r.removed[0].name.endsWith('character:postHistoryInstructions') && r.removed[0].characters === 90)
  check('C11i', '★ 反证：没有 PHI 段时**一个都不摘**（⛔ 不许顺手删别人的东西）', (() => {
    const r2 = stripPhiParts([{ name: 'a' }, { name: 'mt:postHistory' }])
    return r2.kept.length === 2 && r2.removed.length === 0
  })())
  check('C11j', '★ 反证：畸形输入不抛，回 {kept:[], removed:[]}', [null, undefined, 'x', {}].every((v) => { try { const x = stripPhiParts(v); return x.kept.length === 0 && x.removed.length === 0 } catch { return false } }))
}

console.log(`\n── ${pass} 通过 / ${fail} 失败 ──`)
process.exitCode = fail === 0 ? 0 : 1
