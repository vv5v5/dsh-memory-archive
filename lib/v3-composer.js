/**
 * v3 消费端（外部组合器）—— 我们作为 **Tavern 提示词管理器** 的那一半。
 *
 * ## 这是什么
 * Tavern 2.3.0 候选（`codex/prompt-composition-api-v3` @ `92d5924`）给出 v3 合同：
 * 外部管理器经 Cordis 服务 `pmpDshTavernPrompt.registerComposer({id, compose})` 注册一个**同步**组合器；
 * 某会话被显式切成 `mode: external` 后，**Tavern 默认 profile 正文不再产生**，改由我们的 `compose`
 * 产出命名 system 段。段名最终是 `pmp-dsh-tavern:external:<owner>:<id>`。
 *
 * ## 本模块的边界（诚实口径，别当成"完整 ST 排序器"）
 * 上游的示例自己不称完整排序器；我们这份同样**只做文档写死的那部分**：
 *   · 卡字段（systemPrompt / description / personality / scenario / messageExample / postHistoryInstructions）
 *   · 本轮命中的世界书条目（`<st-world-info>`）
 *   · 首轮开场（仅当 `runtime.greetingReferenceApplies` 为真）
 * **不做**：ST 的完整 marker/宏策略、`prompt_order` 重排、深度注入的精确插入位（`depth_prompt` 目前
 * 作为独立段出现在尾部，而不是"插进历史第 N 条"）、正则作用域、世界书的 token 预算裁剪。
 * ⇒ 所以它**默认关闭**（`v3.composer.enabled=false`）；打开意味着"用我们这份装配替换 Tavern 的内置装配"，
 *   是**能力升级**而不是修 bug（今天那些需求靠 `pmp-dsh-tavern:profile` + `/api/v1/traces` 已经够用）。
 *
 * ## 契约纪律（照抄上游合同的硬要求）
 *   · `compose` **同步**、快、**不联网**、不写 selection、不递归编译；
 *   · 段数 ≤ 64（`capabilities.maxSections`），本文只产出个位数段；
 *   · ⛔ 绝不 `await`、绝不读文件/网络 —— 需要的东西全在 `sources` / `runtime` 里；
 *   · 字段缺失 ⇒ 略过该段（⛔ 不吐空标签、不编内容）。
 *
 * ## 为什么不硬 `inject: ['pmpDshTavernPrompt']`
 * 2026-09-16 沙箱实测：硬 inject 这个服务的插件，在 Tavern 被卸载后会让**整个 Host 起不来**
 * （`dsh: plugin tree failed to load: 1 entry did not activate / pending (waiting for service: pmpDshTavernPrompt)`）。
 * 所以本模块走 `ctx.inject(['pmpDshTavernPrompt'], …)`（**软**注入：服务出现才回调），
 * Tavern 缺席时我们照常跑、只是不注册组合器。
 *
 * @module dsh-memory-archive/v3-composer
 */

/** 我们的 owner id（会出现在最终段名 `pmp-dsh-tavern:external:<owner>:<id>` 里，须匹配 `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$`）。 */
export const DEFAULT_OWNER = 'dsh-memory-archive'

/** 组合器产出的段 id（最终段名后缀），顺序即注入顺序。 */
export const SECTION_IDS = [
  'character-system',
  'character-description',
  'character-personality',
  'character-scenario',
  'message-example',
  'world-info',
  'post-history',
  'opening',
  'provenance',
]

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v) => (typeof v === 'string' ? v : '')
const asArray = (v) => (Array.isArray(v) ? v : [])

/** 条目键的宽松取值：字符串原样、数字转串、其余空串。
 *  ⚠️ 现场教训：runtime 里 `entryId` 可能是**数字** `1`，而 `str()` 对数字返回空串 ⇒ 查表静默失败。 */
function keyOf(v) {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return ''
}

/**
 * 世界书条目查找表：**同时**按 `id` 全名与 `uid` 裸号建索引。
 *
 * ⚠️ 现场教训（2026-09-16 沙箱）：审计里的 `decisions[].entryId` 是**裸 uid**（例如 `"1"` 或数字 `1`），
 * 而 `runtime.loreEntries[].id` 是**全名**（`character:<cardId>:embedded-world-book:1`）——
 * 只按全名查会**一条都命中不了**，而且不报错（静默少注入，正是最难发现的那种）。
 * ⇒ 两个键都收（数字也收成串）；查不到再拿 `resourceId + ':' + key` 兜一次。
 */
function loreIndex(runtime) {
  const map = new Map()
  for (const e of asArray(runtime?.loreEntries)) {
    if (!isObj(e)) continue
    const full = keyOf(e.id)
    if (full !== '') map.set(full, e)
    for (const k of [keyOf(e.uid), keyOf(e.entryUid), keyOf(e.entryId)]) {
      if (k !== '' && !map.has(k)) map.set(k, e)
    }
  }
  return map
}

/**
 * ★ 把 ST 宏处理成「DSH 不会当变量解」的文本 —— **这一条是踩出来的，不是想出来的**。
 *
 * 现场：2026-09-16 沙箱里第一次让我们的组合器接管，整轮直接失败，DSH 报：
 *   `unknown prompt variable "{{user}}" in section "pmp-dsh-tavern:external:dsh-memory-archive:message-example";
 *    registered variables: provider, model, cwd`
 * 根因（DSH 源码 `packages/core/system-prompt/src/index.ts:180-183, 319-356`）：
 *   · 段文本里的 `{{name}}` 会被**插值**；`GROUP_AT = /^\{\{([^{}]*)\}\}/`、`VARIABLE_NAME = /^[a-z][a-z0-9_]*$/`；
 *   · 名字不合规 ⇒ throw「malformed」；名字合规但没注册 ⇒ throw「unknown」；**只有 `{{` 后面再也找不到 `}}` 才算普通文本**；
 *   · 宿主注册的变量只有 `provider` / `model` / `cwd`。
 * 而 Tavern 把**卡原文**原样交给我们（内置路线是 Tavern 自己先过一遍宏）⇒ **宏必须由组合器负责**：
 *   1) 能解的解：`{{char}}`/`{{user}}`（及常见别名）取自 `runtime.macroContext`；
 *   2) 解不了的**中和**：去掉花括号只留名字（`{{random}}` → `random`），⛔ 不是删掉整个词；
 *   3) 畸形嵌套（`{{a{{b}}}}` 这类正则吃不到的）兜底把花括号拆开成 `{ {` / `} }`。
 *
 * @returns {{text:string, expanded:string[], neutralized:string[]}}
 */
export function neutralizePromptVariables(text, macroContext) {
  const src = str(text)
  const mc = isObj(macroContext) ? macroContext : {}
  const expanded = []
  const neutralized = []
  const ALIAS = { char: 'character', charname: 'character', user: 'user', username: 'user', persona: 'user' }
  let out = src.replace(/\{\{([^{}]*)\}\}/g, (whole, inner) => {
    const name = String(inner).trim()
    const key = name.toLowerCase()
    const mapped = ALIAS[key]
    if (mapped !== undefined) {
      // 认得出的宏（char/user/persona…）：有值就展开，**没值就照内置那样留空** —— ⛔ 不漏出字面词
      const val = mc[mapped]
      expanded.push(name)
      return typeof val === 'string' ? val : ''
    }
    neutralized.push(name)
    return name
  })
  // 兜底：畸形嵌套剩下的 `{{ … }}`（DSH 会判 malformed）⇒ 把花括号拆开，彻底不构成变量
  if (out.includes('{{') && out.includes('}}')) {
    out = out.split('{{').join('{ {').split('}}').join('} }')
    neutralized.push('(malformed)')
  }
  return { text: out, expanded, neutralized }
}

/**
 * 本轮**实际命中**的世界书条目（不是"候选"）。
 *
 * 为什么这么取：`runtime.loreEntries` 实测是**候选集**（不过触发词的轮次里它同样是全部条目），
 * 真正的 include/reject 判定在 `runtime.worldBookAudit.resources[].decisions[]` 里。
 * ⛔ 判定读不出来时**宁可少注入**：退回候选集会让"没触发的条目"也进提示词（与内置行为不符）。
 * 例外：如果整份审计都读不到（老版本/形状变了），才退回候选集并**在 provenance 里如实标注**，
 * 免得界面显示"世界书已按命中注入"而其实只是全塞。
 */
export function selectLoreEntries(runtime) {
  const index = loreIndex(runtime)
  const resources = asArray(runtime?.worldBookAudit?.resources)
  const included = []
  let sawDecisions = false
  for (const res of resources) {
    const resourceId = str(res?.resource?.id)
    for (const d of asArray(res?.decisions)) {
      if (!isObj(d)) continue
      sawDecisions = true
      const decision = str(d.decision)
      const isIncluded = decision === 'included' || d.included === true
      if (!isIncluded) continue
      const key = keyOf(d.entryId) || keyOf(d.id) || keyOf(d.uid)
      const entry = index.get(key)
        ?? (resourceId !== '' && key !== '' ? index.get(resourceId + ':' + key) : undefined)
      if (entry) included.push(entry)
      else if (typeof d.content === 'string' && d.content !== '') {
        // 只有审计给了正文、候选表里找不到时：用审计的这条（并把 entryName 也带上，便于 provenance）
        included.push({ id: resourceId !== '' && key !== '' ? resourceId + ':' + key : key, uid: key, content: d.content, position: str(d.appliedPosition) || str(d.requestedPosition) || 'after' })
      } else {
        // ⛔ 既没候选正文、审计也没给正文：**不猜**，但要记下来（否则就是静默少注入）
        included.push({ id: key, uid: key, content: '', position: 'after', unresolved: true })
      }
    }
  }
  if (sawDecisions) return { entries: included.filter((e) => !e.unresolved), unresolved: included.filter((e) => e.unresolved).length, basis: 'decisions' }
  const fallback = asArray(runtime?.loreEntries).filter(isObj)
  return { entries: fallback, unresolved: 0, basis: 'candidates' }
}

/**
 * 记一段（name 非空 + text 非空才产出；⛔ 不吐空段）。
 *
 * ⚠️ **段对象只许有 `{id, text}` 两个键** —— 现场教训（2026-09-16 沙箱）：
 *   上游 `prompt-composition.js:224-226` 对每个段做 `Object.keys(section).some(k => !['id','text'].includes(k))`
 *   检查，多一个键就 `422 OUTPUT_INVALID / "Sections require unique ids and text"`（报错文案完全没提"多键"这件事，
 *   我是靠读它源码才定位到的）。所以注释性信息一律进 `meta.notes`，⛔ 不挂在段上。
 */
function push(list, notes, id, text, note) {
  const t = str(text)
  if (t === '') return
  list.push({ id, text: t })
  if (note !== undefined) notes[id] = String(note)
}

/**
 * 纯函数：`sources`/`runtime` ⇒ `{ sections }`（**同步**，无副作用，可单测）。
 * @param {object} args
 * @param {object} args.sources - v3 sources 快照（形状见 docs/PROMPT_API_V3.md）
 * @param {object} args.runtime - v3 runtime
 * @param {object} [args.config] - 本模块配置（marker / owner / version / echoSuggestedCallConfig）
 * @returns {{sections:Array<{id:string,text:string}>, callConfig?:object, meta:object}}
 */
export function buildComposition(args) {
  // ⚠️ 不能写成 `({sources, runtime, config} = {})`：默认值只兜 `undefined`，显式传 `null` 会在解构处抛。
  //   compose 是**宿主调用**的（Tavern 侧），任何形状都可能进来 ⇒ 这里一律先兜成对象。
  const a = isObj(args) ? args : {}
  const sources = a.sources
  const runtime = a.runtime
  const config = a.config
  const cfg = isObj(config) ? config : {}
  const src = isObj(sources) ? sources : {}
  const rt = isObj(runtime) ? runtime : {}
  const sel = isObj(src.selection) ? src.selection : {}
  const selChar = isObj(sel.character) ? sel.character : {}
  const docs = isObj(src.documents) ? src.documents : {}
  const character = isObj(docs.character) ? docs.character : null
  const data = character && isObj(character.data) ? character.data : {}
  const greeting = isObj(src.greeting) ? src.greeting : {}
  const lore = selectLoreEntries(rt)

  const sections = []
  const notes = {}
  const omit = new Set(asArray(cfg.omitFields).map(String))
  const mc = isObj(rt.macroContext) ? rt.macroContext : {}
  const seenMacros = { expanded: [], neutralized: [] }
  /** 所有**卡派生**文本都过一遍宏处理（含开场与世界书条目）—— 不过就会让整轮失败（见 neutralizePromptVariables 的现场记录）。 */
  const safe = (value) => {
    const r = neutralizePromptVariables(value, mc)
    for (const k of ['expanded', 'neutralized']) for (const n of r[k]) if (!seenMacros[k].includes(n)) seenMacros[k].push(n)
    return r.text
  }

  // 1) 卡字段（顺序照内置 profile 的观感：system → 描述三件套 → 示例 → 世界书 → 后置 → 开场）
  if (selChar.preferCharacterSystemPrompt !== false && !omit.has('systemPrompt')) {
    push(sections, notes, 'character-system', wrap('st-character-field', { name: 'system-prompt' }, safe(data.systemPrompt)))
  }
  if (!omit.has('description')) push(sections, notes, 'character-description', wrap('st-character-field', { name: 'description' }, safe(data.description)))
  if (!omit.has('personality')) push(sections, notes, 'character-personality', wrap('st-character-field', { name: 'personality' }, safe(data.personality)))
  if (!omit.has('scenario')) push(sections, notes, 'character-scenario', wrap('st-character-field', { name: 'scenario' }, safe(data.scenario)))
  if (!omit.has('messageExample')) push(sections, notes, 'message-example', wrap('st-character-field', { name: 'message-example' }, safe(data.messageExample)))

  // 2) 世界书：只放**本轮命中**的条目（见 selectLoreEntries 的口径说明）
  if (!omit.has('worldInfo') && lore.entries.length > 0) {
    const blocks = lore.entries
      .map((e) => wrap('st-world-info', { entry: str(e.id), position: str(e.position) || 'after' }, safe(e.content)))
      .filter((t) => t !== null)
    if (blocks.length > 0) {
      sections.push({ id: 'world-info', text: blocks.join('\n\n') })
      notes['world-info'] = '世界书命中 ' + blocks.length + ' 条（判定依据：' + lore.basis + '）'
    }
  }

  // 3) 卡的后置指令
  if (selChar.preferCharacterPostHistory !== false && !omit.has('postHistoryInstructions')) {
    push(sections, notes, 'post-history', wrap('st-character-field', { name: 'post-history-instructions' }, safe(data.postHistoryInstructions)))
  }

  // 4) 开场：**只在首轮**给（`runtime.greetingReferenceApplies` 为真时）
  if (!omit.has('opening') && rt.greetingReferenceApplies === true) {
    push(sections, notes, 'opening', wrap('st-character-field', { name: 'greeting-reference' }, safe(greeting.text)))
  }

  // 5) 一行来源标记（默认开）：让"这段是谁装的"在**看请求原文**时一眼可辨；不写正文、只有版本号
  if (cfg.marker !== false) {
    const bits = ['owner=' + (str(cfg.owner) || DEFAULT_OWNER), 'v=' + String(cfg.version ?? 1)]
    if (lore.basis === 'candidates') bits.push('worldInfo=candidates(未读到命中判定)')
    if (lore.unresolved > 0) bits.push('worldInfo-unresolved=' + lore.unresolved)
    if (rt.greetingReferenceApplies === true) bits.push('opening=first-turn')
    // 宏处理结果也如实写一行：既证明"宏是我们处理的"，也让"被中和了几个"看得见
    if (seenMacros.expanded.length > 0) bits.push('macros=' + seenMacros.expanded.join(','))
    if (seenMacros.neutralized.length > 0) bits.push('macros-neutralized=' + seenMacros.neutralized.length)
    push(sections, notes, 'provenance', '[external-composition ' + bits.join(' ') + ']')
  }

  const out = { sections, meta: { loreBasis: lore.basis, loreCount: lore.entries.length, unresolvedLore: lore.unresolved || 0, macros: seenMacros, notes: notes, fields: SECTION_IDS.filter((id) => sections.some((s) => s.id === id)) } }

  // `callConfig`：默认**不回传**（上游合同两种都合法；这是"推荐回传还是省略"那一问未定前的保守选择）
  const suggested = isObj(src.suggestedCallConfig) ? src.suggestedCallConfig : {}
  if (cfg.echoSuggestedCallConfig === true && Object.keys(suggested).length > 0) out.callConfig = suggested
  return out
}

/** 小工具：产出 `<tag attr="v">正文</tag>`；正文为空 ⇒ null（调用方过滤）。 */
function wrap(tag, attrs, text) {
  const t = str(text)
  if (t === '') return null
  const a = Object.entries(isObj(attrs) ? attrs : {})
    .filter(([, v]) => str(v) !== '')
    .map(([k, v]) => ' ' + k + '="' + String(v).replace(/"/g, '&quot;') + '"')
    .join('')
  return '<' + tag + a + '>\n' + t + '\n</' + tag + '>'
}

/**
 * 注册（**软**注入：Tavern 不在就不注册，⛔ 不拖垮宿主启动）。
 * @param {object} ctx - Cordis 上下文
 * @param {object} config - { enabled, owner, marker, echoSuggestedCallConfig, version }
 * @param {{info?:Function,warn?:Function,error?:Function}} [log]
 * @returns {{registered:boolean, reason?:string, owner?:string, dispose?:Function}}
 */
export function registerV3Composer(ctx, config, log) {
  const cfg = isObj(config) ? config : {}
  const info = (m) => { try { log?.info?.(String(m)) } catch {} }
  const warn = (m) => { try { log?.warn?.(String(m)) } catch {} }
  const owner = str(cfg.owner) || DEFAULT_OWNER
  if (cfg.enabled !== true) return { registered: false, reason: 'disabled' }
  if (typeof owner !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(owner)) {
    warn(`[mt] v3 组合器 owner 名不合法，未注册：${JSON.stringify(owner)}`)
    return { registered: false, reason: 'bad-owner' }
  }
  const mount = () => {
    const service = typeof ctx?.get === 'function' ? ctx.get('pmpDshTavernPrompt') : ctx?.pmpDshTavernPrompt
    if (!service || typeof service.registerComposer !== 'function') {
      warn('[mt] pmpDshTavernPrompt 不可用 ⇒ 不注册 v3 组合器（我们照常工作，只是不接管装配）')
      return
    }
    try {
      const dispose = service.registerComposer({
        id: owner,
        compose: ({ sources, runtime }) => {
          const built = buildComposition({ sources, runtime, config: Object.assign({}, cfg, { owner }) })
          return built.callConfig === undefined ? { sections: built.sections } : { sections: built.sections, callConfig: built.callConfig }
        },
      })
      info(`[mt] v3 组合器已注册：owner=${owner}（段序 ${SECTION_IDS.join(' → ')}）`)
      if (typeof ctx?.effect === 'function') ctx.effect(() => () => { try { dispose?.() } catch {} })
      return dispose
    } catch (e) {
      // 注册失败只降级：⛔ 不让它把宿主启动带下去
      warn(`[mt] v3 组合器注册失败（已降级）：${String((e && e.message) || e)}`)
    }
  }
  if (typeof ctx?.inject === 'function') {
    ctx.inject(['pmpDshTavernPrompt'], mount)
    return { registered: true, owner, deferred: true }
  }
  mount()
  return { registered: true, owner }
}
