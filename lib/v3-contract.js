/**
 * v3 合同识别与投影 —— **纯逻辑，零宿主依赖**（可被自检台直测）。
 *
 * ## 为什么需要它（2026-09-17）
 * 上游 Tavern 有**两套互不相容的 v3**，外观上都是 `/pmp-dsh-tavern/api/v3/*`：
 *
 * · **composer 合同**（`codex/prompt-composition-api-v3` @ `92d5924`，我们真机现在跑的）
 *   有组合器注册表 + Cordis 服务 `pmpDshTavernPrompt`；可按会话切 `external` 接管装配。
 *   端点：`capabilities` / `sessions/:id/prompt-mode` / `sessions/:id/prompt-sources`。
 *
 * · **trace 合同**（`codex/trace-api-v3` @ `d195134`，未发布，**取代**上面那套）
 *   `composerRegistry:false`，**没有**那个服务；只有只读补集，官方装配段是公开扩展点。
 *   端点：`capabilities` / `sessions/:id/sources` / `sessions/:id/assemblies[/:recordId]`。
 *
 * ⛔ 两套的 `capabilities` 字段面**不重叠**，但**都不带版本号能直接判**：
 *   旧的回 `{service:'pmpDshTavernPrompt', modes:[…], composers:[…]}`；
 *   新的回 `{contract:'prompt-trace-primitives', composerRegistry:false, officialSections:true}`。
 *   判错的后果不是报错、是**静默谎报**（旧代码把新合同的"没有 composers 字段"读成
 *   "配置说启用但没注册上 ⇒ 重启宿主"，把用户指向一个根本不存在的修复动作）。
 *   ⇒ 所以判定要单独成模块、要前瞻、要有反证。
 *
 * ## 纪律
 * · ⛔ **不猜**：形状不认识就回 `unknown`，并把 `known:false` 一路带到面板上如实显示；
 * · ⛔ **不抛**：任何输入都返回结构化结果（面板/宿主按字段判，不靠 try/catch 兜）；
 * · ⛔ 本模块**只做投影与判定，不发请求、不读盘、不缓存正文**（运输层在调用方）。
 *
 * @module dsh-memory-archive/v3-contract
 * @license CC-BY-NC-4.0
 */

export const V3_CONTRACT_VERSION = 1

/** v3 根路径（与 Tavern `packages/identity.js` 的 `API_V3` 一致）。 */
export const V3_ROOT = '/pmp-dsh-tavern/api/v3'
/** Tavern 的插件 id（段名前缀、也是 `PROFILE_SECTION` 的前缀）。 */
export const TAVERN_PLUGIN_ID = 'pmp-dsh-tavern'
/** 官方装配段名里"每块来源"那一族的前缀：`pmp-dsh-tavern:part:0000:character:description`。 */
export const PART_SECTION_PREFIX = TAVERN_PLUGIN_ID + ':part:'
/** 导入上下文段名（trace 合同下它**只剩导入上下文**，卡字段已搬去 `:part:` 段）。 */
export const PROFILE_SECTION = TAVERN_PLUGIN_ID + ':profile'
/** compose 合同的 Cordis 服务名（trace 合同**不再 provide** 它）。 */
export const COMPOSER_SERVICE = 'pmpDshTavernPrompt'
/** trace 合同 `capabilities.contract` 的期望值。 */
export const TRACE_CONTRACT_ID = 'prompt-trace-primitives'
/** PHI（卡的后处理指令）在卡里的字段名 —— 也是 Tavern 的 `:part:` 名字里那一截。 */
export const PHI_PART_FIELD = 'postHistoryInstructions'

/** 合同种类。 */
export const CONTRACT_TRACE = 'trace'
export const CONTRACT_COMPOSER = 'composer'
export const CONTRACT_ABSENT = 'absent'
export const CONTRACT_UNKNOWN = 'unknown'

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v) => (typeof v === 'string' ? v : '')
const int = (v) => (Number.isSafeInteger(v) ? v : null)

/**
 * 判定这份 `capabilities` 属于哪套合同。
 *
 * 判定顺序是**刻意的**（每一条都有反证在自检台里）：
 *   ① 显式 `contract` 字符串 —— 最权威，但**它会变**，所以不是唯一判据；
 *   ② 显式 `composerRegistry === false` ——「我明确否认有注册表」，比"没这个字段"强得多；
 *      ⚠️ 但若它同时又自称有 `composers`（自相矛盾），不采信本条，落到 ③ 当 composer 处理；
 *   ③ 旧合同的三个正向标志（`composers` 数组 / `service` / `modes` 数组）—— 任一命中即 composer；
 *   ④ 其余一律 `unknown`（⛔ 不猜成任意一套）。
 *
 * @param {unknown} capabilities - `GET {V3_ROOT}/capabilities` 的响应体
 * @returns {{contract:string, known:boolean, reason:string}}
 */
export function detectV3Contract(capabilities) {
  if (!isObj(capabilities)) {
    return { contract: CONTRACT_ABSENT, known: false, reason: '读不到 capabilities（没拿到或形状不是对象）' }
  }
  if (capabilities.ok === false) {
    return { contract: CONTRACT_ABSENT, known: false, reason: 'capabilities 自称 ok:false' }
  }
  const claimsComposers = Array.isArray(capabilities.composers)

  if (capabilities.contract === TRACE_CONTRACT_ID) {
    return { contract: CONTRACT_TRACE, known: true, reason: `capabilities.contract === '${TRACE_CONTRACT_ID}'` }
  }
  if (capabilities.composerRegistry === false && capabilities.officialSections === true && !claimsComposers) {
    return {
      contract: CONTRACT_TRACE,
      known: true,
      reason: 'capabilities 自述 composerRegistry:false + officialSections:true（前瞻判据：不依赖 contract 字符串的具体取值）',
    }
  }
  if (claimsComposers) {
    return { contract: CONTRACT_COMPOSER, known: true, reason: `capabilities.composers 是数组（${capabilities.composers.length} 个）` }
  }
  if (capabilities.service === COMPOSER_SERVICE) {
    return { contract: CONTRACT_COMPOSER, known: true, reason: `capabilities.service === '${COMPOSER_SERVICE}'` }
  }
  if (Array.isArray(capabilities.modes)) {
    return { contract: CONTRACT_COMPOSER, known: true, reason: `capabilities.modes 是数组（${capabilities.modes.length} 个）` }
  }
  return {
    contract: CONTRACT_UNKNOWN,
    known: false,
    reason: 'capabilities 形状既不像 composer 合同也不像 trace 合同 —— 不猜',
  }
}

/**
 * 这份合同对我们各项功能意味着什么（面板如实显示的文案源）。
 *
 * ⚠️ 关键口径：`absent` / `unknown` 下**不能说"我们的功能失效了"** —— 读不到 capabilities
 * 可能是网络抖动、也可能 Tavern 根本没装，而此时那个 Cordis 服务**也许仍在**。
 * ⇒ 只有 `known:true` 的两种合同才敢断言"某某可用/不可用"。
 *
 * @param {string} contract
 * @returns {{label:string, detail:string, known:boolean, composerUsable:boolean|null, tailServiceUsable:boolean|null, modeSwitchable:boolean|null}}
 */
export function contractInfo(contract) {
  switch (contract) {
    case CONTRACT_TRACE:
      return {
        label: 'trace（只读补集）',
        detail: '这台 Tavern 用的是 prompt-trace 合同（capabilities 自述 composerRegistry:false）：只读 sources / assemblies，**没有**组合器注册表，也**不再提供** pmpDshTavernPrompt 服务。',
        known: true,
        composerUsable: false,
        tailServiceUsable: false,
        modeSwitchable: false,
      }
    case CONTRACT_COMPOSER:
      return {
        label: 'composer（可接管）',
        detail: '这台 Tavern 用的是 prompt-composition 合同：有组合器注册表与 pmpDshTavernPrompt 服务，可按会话切 external 接管装配。',
        known: true,
        composerUsable: true,
        tailServiceUsable: true,
        modeSwitchable: true,
      }
    case CONTRACT_ABSENT:
      return {
        label: '无 v3（或读不到）',
        detail: '读不到 v3 capabilities：可能这台 Tavern 没有 v3（2.2.0 及更早），也可能只是这一次没读通。**不能据此判断**下面的组合器/尾部段是否可用。',
        known: false,
        composerUsable: null,
        tailServiceUsable: null,
        modeSwitchable: null,
      }
    default:
      return {
        label: '合同形状不认识',
        detail: 'capabilities 的形状既不像 composer 合同也不像 trace 合同。上游可能又改了 —— ⛔ 这里不猜，请人工核对上游文档后再决定走哪条路。',
        known: false,
        composerUsable: null,
        tailServiceUsable: null,
        modeSwitchable: null,
      }
  }
}

/** v3 各端点的**相对**路径构造器（⛔ 只拼串，不发请求）。trace 合同没有的端点返回 null。 */
export const v3Paths = Object.freeze({
  capabilities: () => `${V3_ROOT}/capabilities`,
  /** composer 合同：读/写本会话的装配模式。trace 合同没有它。 */
  mode: (contract, sessionId) => (contract === CONTRACT_COMPOSER && str(sessionId) !== ''
    ? `${V3_ROOT}/sessions/${encodeURIComponent(sessionId)}/prompt-mode` : null),
  /** 当前来源快照。两套合同都有，但**路径不同**（`prompt-sources` vs `sources`）。 */
  sources: (contract, sessionId) => {
    if (str(sessionId) === '') return null
    if (contract === CONTRACT_COMPOSER) return `${V3_ROOT}/sessions/${encodeURIComponent(sessionId)}/prompt-sources`
    if (contract === CONTRACT_TRACE) return `${V3_ROOT}/sessions/${encodeURIComponent(sessionId)}/sources`
    return null
  },
  /** trace 合同独有：历史装配索引 / 单条详情。 */
  assemblies: (contract, sessionId) => (contract === CONTRACT_TRACE && str(sessionId) !== ''
    ? `${V3_ROOT}/sessions/${encodeURIComponent(sessionId)}/assemblies` : null),
  assemblyRecord: (contract, sessionId, recordId) => (contract === CONTRACT_TRACE && str(sessionId) !== '' && str(recordId) !== ''
    ? `${V3_ROOT}/sessions/${encodeURIComponent(sessionId)}/assemblies/${encodeURIComponent(recordId)}` : null),
})

/**
 * 解析官方装配段名里的 `:part:` 那一族。
 *
 * 上游 `packages/tavern-loader/src/assembly-parts.js` 的 `namedParts()` 生成：
 *   `${PLUGIN_ID}:part:${序号补零4位}:${kind}:${field}`
 * 其中 `kind:field` 取自**该段第一个来源**（`primary.kind` / `primary.field`），且整体过了一遍
 * `.replace(/[^A-Za-z0-9_.:-]/g, '_')`。⇒ 字段里的路径分隔符 `/` 会变成 `_`
 * （例：`prompts/0/content` ⇒ `preset:prompts_0_content`）。
 *
 * ⚠️ 切分只切**第一个**冒号：`field` 里理论上仍可能含 `:`（`:` 在允许字符集内），
 *    用 `split(':')` 取后两段会把这种字段名切坏。
 *
 * @param {unknown} name
 * @returns {{ordinal:number, kind:string, field:string, sanitized:boolean}|null} 不是 `:part:` 段则 null
 */
export function parsePartSectionName(name) {
  const s = str(name)
  if (s === '' || !s.startsWith(PART_SECTION_PREFIX)) return null
  const rest = s.slice(PART_SECTION_PREFIX.length)
  const firstColon = rest.indexOf(':')
  if (firstColon <= 0) return null
  const ordinalText = rest.slice(0, firstColon)
  if (!/^\d+$/.test(ordinalText)) return null
  const tail = rest.slice(firstColon + 1)
  if (tail === '') return null
  const secondColon = tail.indexOf(':')
  if (secondColon <= 0) return { ordinal: Number(ordinalText), kind: tail, field: '', sanitized: false }
  return {
    ordinal: Number(ordinalText),
    kind: tail.slice(0, secondColon),
    field: tail.slice(secondColon + 1),
    // `field` 含 `_` 但那可能本来就是 `_`（不可逆），所以只标"可能被清洗过"，⛔ 不假装能还原
    sanitized: true,
  }
}

/**
 * 卡字段字数：三口径里取 `characters`（= 界面里最直观的那个）；⛔ 不猜缺的字段。
 * （从 `lib/index.js` 的 `v3FieldChars` 原样搬来，两套合同共用。）
 */
export function fieldChars(data) {
  const d = isObj(data) ? data : {}
  const out = []
  for (const [key, label] of [
    ['systemPrompt', 'system-prompt'],
    ['description', 'description'],
    ['personality', 'personality'],
    ['scenario', 'scenario'],
    ['messageExample', 'message-example'],
    ['postHistoryInstructions', 'post-history-instructions'],
    ['firstMessage', 'first-message'],
  ]) {
    const v = d[key]
    if (typeof v === 'string' && v !== '') out.push({ key, label, chars: v.length })
  }
  const alts = Array.isArray(d.alternateGreetings) ? d.alternateGreetings : []
  if (alts.length > 0) out.push({ key: 'alternateGreetings', label: 'alternate-greetings', chars: alts.join('').length, count: alts.length })
  return out
}

/**
 * 把 `sources`（两套合同的形状**一致**，trace 只多一个 `sessionId`）投影成面板要的摘要。
 *
 * ⛔ **只回投影，不把 `documents.*.data` 原文交给面板** —— 这是我们既有的口径
 *    （要看卡正文去 Tavern 自己的界面）。整字段正文走 trace 合同的 `assemblies` 那条路，按需取。
 *
 * @param {unknown} sources
 * @returns {object|null} 形状不符时 null
 */
export function projectSources(sources) {
  if (!isObj(sources)) return null
  const s = sources
  const sel = isObj(s.selection) ? s.selection : {}
  const docs = isObj(s.documents) ? s.documents : {}
  const ch = isObj(docs.character) ? docs.character : null
  const data = ch && isObj(ch.data) ? ch.data : {}
  const greeting = isObj(s.greeting) ? s.greeting : {}
  const wbs = isObj(s.worldBookSelection) ? s.worldBookSelection : {}
  // ★ 预设的装配模式：Tavern 的 `replace` 会把装配**过滤成只留它自己的段**（profile / :part: / rp:policy），
  //   我们那七段会被整批滤掉且不报错 ⇒ 这是 replace 看守**唯一确定性**的判据（⛔ 不用启发式）。
  //   口径照上游 `profile-loader.js`：`preset?.systemPromptMode === 'replace' ? 'replace' : 'append'`
  //   ⇒ **没选预设时有效模式就是 append**（不是"不知道"）；只有 `documents` 里**根本没有 preset 这个键**时
  //   才算读不到（那时返回 null，调用方如实显示"读不到"，⛔ 不猜）。
  const presetKnown = Object.prototype.hasOwnProperty.call(docs, 'preset')
  const presetMode = presetKnown
    ? (isObj(docs.preset) && docs.preset.systemPromptMode === 'replace' ? 'replace' : 'append')
    : null
  return {
    schemaVersion: s.schemaVersion ?? null,
    revision: typeof s.revision === 'string' ? s.revision : null,
    countUnit: typeof s.countUnit === 'string' ? s.countUnit : null,
    presetMode,
    cardId: typeof sel.characterCardId === 'string' ? sel.characterCardId : null,
    cardName: ch && typeof ch.name === 'string' ? ch.name : null,
    presetId: sel.presetId ?? null,
    userId: sel.userId ?? null,
    rp: isObj(sel.rp) ? sel.rp : null,
    greeting: {
      requestedIndex: greeting.requestedIndex ?? null,
      effectiveIndex: greeting.effectiveIndex ?? null,
      semantics: typeof greeting.semantics === 'string' ? greeting.semantics : null,
      chars: typeof greeting.text === 'string' ? greeting.text.length : 0,
    },
    fields: fieldChars(data),
    worldBooks: {
      explicit: Array.isArray(wbs.explicitIds) ? wbs.explicitIds.length : 0,
      userBound: Array.isArray(wbs.userBoundIds) ? wbs.userBoundIds.length : 0,
      presetBound: Array.isArray(wbs.presetBoundIds) ? wbs.presetBoundIds.length : 0,
      characterBound: Array.isArray(wbs.characterBoundIds) ? wbs.characterBoundIds.length : 0,
      effective: Array.isArray(wbs.effectiveIds) ? wbs.effectiveIds.length : 0,
      duplicate: Array.isArray(wbs.duplicateIds) ? wbs.duplicateIds.length : 0,
    },
    suggestedCallConfig: isObj(s.suggestedCallConfig) ? s.suggestedCallConfig : {},
    fieldLengthKeys: isObj(s.fieldLengths) ? Object.keys(s.fieldLengths).length : 0,
  }
}

/**
 * trace 合同：历史装配**索引**的投影（⛔ 不带段正文、不带 `systemMessages`）。
 *
 * 索引里的行有**两种来源**：我们的实时记录（带 `sectionCount`）和上游把旧 v1 记录
 * 适配过来的 `legacy:*`（带 `status:'legacy-metadata-only'`，**没有** `sectionCount`）。
 * ⇒ 两者都要如实区分，不能让 legacy 看起来像"我们采到了"。
 *
 * @param {unknown} indexJson
 * @param {{maxRecords?:number}} [opts]
 * @returns {{ok:boolean, sessionId:string|null, storage:object|null, records:Array, total:number}|null}
 */
export function projectAssemblyIndex(indexJson, opts = {}) {
  if (!isObj(indexJson)) return null
  const raw = Array.isArray(indexJson.records) ? indexJson.records : []
  const cap = Number.isSafeInteger(opts.maxRecords) && opts.maxRecords > 0 ? opts.maxRecords : 256
  const records = raw.slice(-cap).map((r) => {
    const row = isObj(r) ? r : {}
    const id = str(row.id)
    return {
      id,
      legacy: id.startsWith('legacy:'),
      turn: int(row.turn),
      step: int(row.step),
      attempt: int(row.attempt),
      status: str(row.status) || null,
      contentStatus: str(row.contentStatus) || null,
      recordedAt: int(row.recordedAt) ?? (typeof row.recordedAt === 'number' ? row.recordedAt : null),
      sectionCount: int(row.sectionCount),
    }
  })
  return {
    ok: true,
    sessionId: typeof indexJson.sessionId === 'string' ? indexJson.sessionId : null,
    storage: isObj(indexJson.storage) ? indexJson.storage : null,
    records,
    total: raw.length,
  }
}

/**
 * trace 合同：单条装配记录的投影。
 *
 * 默认**只出段级元数据**（名字 / 序号 / 字数 / 哈希 / 来源 / 偏移），⛔ 不出段正文。
 * 要看正文由调用方显式 `includeText:true` **按需**再取一次 —— 与上游自己的 Trace 页面同款
 * （"列表不加载正文、详情按需读取"）。
 *
 * ⚠️ `delivery.assemblyVerified` 只有在上游**唯一**匹配到一整条系统消息时才为 true；
 *    为 false 时 `offsetUtf16` **不能**当作"在实际系统消息里的位置"。这个区分要一路带到面板上。
 *
 * @param {unknown} record
 * @param {{includeText?:boolean, maxSections?:number}} [opts]
 * @returns {object|null}
 */
export function projectAssemblyRecord(record, opts = {}) {
  if (!isObj(record)) return null
  const withText = opts.includeText === true
  const cap = Number.isSafeInteger(opts.maxSections) && opts.maxSections > 0 ? opts.maxSections : 256
  const rawSections = Array.isArray(record.sections) ? record.sections : []
  const sections = rawSections.slice(0, cap).map((s, i) => {
    const row = isObj(s) ? s : {}
    const name = str(row.name)
    const part = parsePartSectionName(name)
    const srcs = Array.isArray(row.sources) ? row.sources : []
    return {
      index: int(row.index) ?? i,
      name,
      part,
      characters: int(row.characters),
      utf16Units: int(row.utf16Units),
      utf8Bytes: int(row.utf8Bytes),
      hash: str(row.hash) || null,
      provenance: str(row.provenance) || 'unknown',
      offsetUtf16: int(row.offsetUtf16),
      sources: srcs.map((x) => {
        const o = isObj(x) ? x : {}
        return {
          kind: str(o.kind) || null,
          field: str(o.field) || null,
          resourceId: typeof o.resourceId === 'string' ? o.resourceId : null,
          relationship: str(o.relationship) || null,
          characters: int(o.characters),
        }
      }),
      ...(withText ? { text: typeof row.text === 'string' ? row.text : null } : {}),
    }
  })
  const d = isObj(record.delivery) ? record.delivery : null
  return {
    id: str(record.id) || null,
    sessionId: str(record.sessionId) || null,
    turn: int(record.turn),
    step: int(record.step),
    attempt: int(record.attempt),
    recordedAt: int(record.recordedAt),
    status: str(record.status) || null,
    contentStatus: str(record.contentStatus) || null,
    sourceMapping: str(record.sourceMapping) || null,
    sections,
    sectionTotal: rawSections.length,
    contextCount: Array.isArray(record.contexts) ? record.contexts.length : 0,
    delivery: d === null ? null : {
      stage: str(d.stage) || null,
      provider: typeof d.provider === 'string' ? d.provider : null,
      model: typeof d.model === 'string' ? d.model : null,
      toolNames: Array.isArray(d.toolNames) ? d.toolNames.filter((t) => typeof t === 'string') : [],
      // ⛔ 不投影 systemMessages（那是系统提示词全文）
      systemMessageCount: Array.isArray(record.systemMessages) ? record.systemMessages.length : 0,
      assemblyVerified: d.assemblyVerified === true,
      systemMessageIndex: int(d.systemMessageIndex),
      logCutSeq: int(d.logCutSeq),
      sessionVersion: d.sessionVersion ?? null,
    },
    textAvailable: record.contentStatus === 'available' && rawSections.length > 0,
  }
}

/**
 * 按需取**单段正文**（trace 合同的 `/assemblies/:recordId` 已经带了全文，这里只是切片）。
 *
 * ⚠️ **按段自己的 `index` 字段找，不按数组下标**（2026-09-17 沙箱实测踩到）：
 *    上游的 `AssemblyRecorder` 是"先给每段编号、再把空段的记录滤掉"⇒ 落盘的 `sections` 数组里
 *    **`index` 是不连续的**（实测 0..10、14..32、34），于是"数组下标"和"`index`"能差好几格。
 *    面板给用户看的是 `index`，请求也就传它 ⇒ 早先按下标取会**取错段**（甚至越界报"没正文"）。
 * ⛔ 找不到（或越界 / 非字符串）一律 null，不猜、不截断。
 *
 * @param {unknown} record - **原始**记录（不是 `projectAssemblyRecord` 的输出）
 * @param {unknown} index - 段自己的 `index` 字段值
 * @returns {string|null}
 */
export function pickSectionText(record, index) {
  if (!isObj(record) || !Number.isSafeInteger(index) || index < 0) return null
  const list = Array.isArray(record.sections) ? record.sections : []
  const s = list.find((x) => isObj(x) && x.index === index)
  if (!isObj(s)) return null
  return typeof s.text === 'string' ? s.text : null
}

/**
 * 这一段是不是**卡的后处理指令**（PHI）被 Tavern 展开出来的那个 `:part:` 段？
 *
 * 用途：T7 的重复注入修复 —— trace 合同下 Tavern 的 builtin 装配**总会**产一份 PHI，
 * 而我们的 `mt:postHistory` @10203 又产一份 ⇒ 同一轮系统提示词里出现两次。
 * 上游把每个卡字段展开成独立段，所以这里可以**按名字精确摘除**，不用做字符串手术。
 *
 * ⚠️ **已知覆盖不到的一种**（照实记，别当成已解决）：PHI 若经预设 `jailbreak` 的 `{{original}}`
 *    注入，那一段在 `namedParts()` 里取的是**第一个**来源 ⇒ 名字会是 `preset:…`，
 *    名字里看不出它是 PHI。那种情况本函数**认不出来**（自检台里有反证钉住这个边界）。
 *
 * @param {unknown} section - 官方 `{name,text}` 段（或捕获记录里的同形对象）
 * @returns {boolean}
 */
/**
 * 看守（**直接观察版**，2026-09-18）：这一轮的段表里，**我们自己的段在不在**。
 *
 * ## 它替代什么
 * 原来那个 replace 看守是**间接读配置**：从 `/sources` 读预设的 `systemPromptMode`，
 * 若为 `replace` ⇒ Tavern 只保留它自己的段，我们那 7 段会被整批滤掉。
 * ⚠️ 上游在 `b0b0b7b` 里**删掉了 `/sources`** ⇒ 在 trace 合同下那条路就瞎了（只能"无法判定"）。
 *
 * ## 为什么"直接观察"更强
 * 装配期 DSH 会为**每一个已注册的段**求值并放进 `assembly.sections`（**空段也在**，`text: ''`）。
 * ⇒ 「我们的段在不在段表里」是**每一轮都能直接看见**的事实，比读配置更硬：
 *   它不仅抓 replace 过滤，连"因为别的原因（插件没挂上、作用域不同）导致段没了"一并抓到。
 *
 * ⚠️ 判据的边界（⛔ 不猜、不喊狼来了）：
 *   · `wholesale`（**全缺**）才是 `atRisk` 的强信号 —— 一个都没进段表 = 整批被滤/没挂上；
 *   · `partial`（缺一部分）单独报出来但不升级为 atRisk —— 可能只是某个插件没启用
 *     （例如 `state:card` 属 state-bridge、`anima:memory` 属 anima），那是**配置事实，不是危险**；
 *   · 段表为空/拿不到 ⇒ `observed: false`（还没观察到一轮装配），⛔ 不据此下结论。
 *
 * @param {unknown} sections 装配期的段表（`{name, text}`）
 * @param {readonly string[]} ourNames 我们自己的段名清单
 * @returns {{observed:boolean, total:number, present:string[], missing:string[], wholesale:boolean, partial:boolean}}
 */
export function guardFromSections(sections, ourNames) {
  const list = Array.isArray(sections) ? sections : []
  const names = (Array.isArray(ourNames) ? ourNames : []).filter((n) => str(n) !== '')
  if (list.length === 0 || names.length === 0) {
    return { observed: false, total: list.length, present: [], missing: [], wholesale: false, partial: false }
  }
  const have = new Set()
  for (const s of list) {
    const n = str(isObj(s) ? s.name : '')
    if (n !== '') have.add(n)
  }
  const present = names.filter((n) => have.has(n))
  const missing = names.filter((n) => !have.has(n))
  return {
    observed: true,
    total: list.length,
    present,
    missing,
    wholesale: present.length === 0,
    partial: present.length > 0 && missing.length > 0,
  }
}

/**
 * 取出 PHI `:part:` 段的**已渲染正文**（纯函数）。
 *
 * ★ 为什么需要它（2026-09-18 沙箱实测）：上游在 `b0b0b7b` 里删掉了 `GET /sessions/:id/sources`
 *   （404、无别名），而 tail 段（`mt:postHistory` @10203）在 trace 合同下原本靠**带外抓那个端点**
 *   才能拿到卡的后处理指令。实测后果不是"段空"，而是**这条卡字段整条从请求里消失**
 *   （`d195134` 上 1 次 → `0408457` 上 0 次）：Tavern 产的那份被我们摘掉，我们那份又没正文。
 *
 *   而那段正文**并没有丢** —— 就在我们本来就要摘掉的那一段里（`assembly.sections[].text`，
 *   装配期已渲染）。⇒ 摘之前先把它读出来，喂给带外缓存，尾段照旧同步读。
 *   ⛔ 不新增上游依赖、不复制 v1 的资源读取合同；而且顺着上游"别再复制一套来源读取"的意图。
 *
 * @param {unknown} sections 装配期的段表（`{name, text}`）
 * @returns {string|null} 第一段**非空**的 PHI 正文；没有 ⇒ null（⛔ 不猜、不返回空串冒充）
 */
export function phiSectionText(sections) {
  for (const s of (Array.isArray(sections) ? sections : [])) {
    if (!isPhiPartSection(s)) continue
    const t = str(isObj(s) ? s.text : '')
    if (t.trim() !== '') return t
  }
  return null
}

export function isPhiPartSection(section) {
  const p = parsePartSectionName(isObj(section) ? section.name : null)
  return p !== null && p.field === PHI_PART_FIELD
}

/**
 * 把 PHI 的那些 `:part:` 段从段表里摘掉。**纯函数**，返回新数组 + 摘了什么（供如实报告）。
 * ⛔ 只摘**认出来的**那些；认不出的原样留着（宁可重复一次，也不误删别人的段）。
 *
 * @param {unknown} sections
 * @returns {{kept:Array, removed:Array<{name:string, characters:number|null}>}}
 */
export function stripPhiParts(sections) {
  const list = Array.isArray(sections) ? sections : []
  const kept = []
  const removed = []
  for (const s of list) {
    if (isPhiPartSection(s)) {
      removed.push({
        name: isObj(s) ? str(s.name) : '',
        characters: Number.isSafeInteger(isObj(s) ? s.characters : null) ? s.characters : null,
      })
      continue
    }
    kept.push(s)
  }
  return { kept, removed }
}

export default { detectV3Contract, contractInfo, v3Paths, parsePartSectionName, fieldChars, phiSectionText, guardFromSections, projectSources, projectAssemblyIndex, projectAssemblyRecord, pickSectionText }
