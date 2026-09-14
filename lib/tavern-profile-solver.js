// ---------------------------------------------------------------------------
// tavern-profile-solver —— 「外部模式」的 DSH 侧前半：把复合段 pmp-dsh-tavern:profile
// **解算回字段级**。
//
// ## 为什么需要它
// DSH 的请求里，这一段只是**一整条字符串**（`system-prompt/assemble` 交出的 section.text），
// 装配地图只能记它的 name/order/chars/offset ⇒ 在界面上是个黑盒。而它的内部其实是**自带标签的**：
// 上游 `tavern-loader` 拼它时用的是固定块格式（出处逐条见下），所以"还原成字段"是**可解算**的，
// 不是猜。
//
// ## 构造规格（上游源码原文，本文件只解不拼）
//   packages/tavern-loader/src/profile-loader.js
//     :426  systemText = [...header, ...body].filter(Boolean).join('\n\n')   ← 块间分隔就是 \n\n
//     :479  profileHeader  →  首行 `[dsh-tavern profile]`，随后 preset-name/-id、character-name/-id、user-name/-id
//     :497  promptBlock    →  `<st-prompt identifier="…" role="…">\n正文\n</st-prompt>`
//     :501  characterBlock →  `<st-character-field name="…">\n正文\n</st-character-field>`
//     :506  userBlock      →  `<st-user-field name="persona-description">\n正文\n</st-user-field>`
//     :578  loreText       →  `<st-world-info entry="…" position="before|after">\n正文\n</st-world-info>`
//     :511  compileMarker  →  marker 名 → 字段/标签映射：charDescription→description、charPersonality→personality、
//                            scenario→scenario、dialogueExamples→message-example；
//                            personaDescription|userDescription|userPersona→user 字段；
//                            worldInfoBefore/After→世界书；chatHistory→**有意不注入**（DSH 自己管历史）
//     :557  appendCharacterFallbacks → 未被 marker 吃掉的字段按 system-prompt / description / personality /
//                            scenario / message-example / post-history-instructions / greeting-reference /
//                            depth-prompt 的顺序补在后面
//     :590  applyOriginal  →  ★ **盲区来源**：卡字段正文会被塞进预设的 main/jailbreak 正文里
//                            （替换 `{{original}}`），**外面没有标签** ⇒ 光看这段文本推不出边界
//   packages/tavern-loader/src/index.js
//     :445  注册 name='pmp-dsh-tavern:profile'、order=10、text = systemText + 导入上下文（两句 join '\n\n'）
//     :177  import-context-runtime 交出的那一坨是 `<imported-playthrough-context trust="untrusted" sha256="…">…`
//
// ## 纪律（本模块的全部价值就在这几条）
// 1. **只认标签**：认不出的内容一律进 `unknown-*`，⛔ 绝不按"看起来像"去归到某个字段。
// 2. **不变量自校验**：`已归属 + 分隔符 + 未归属 === 总长`。算不平就 `ok:false` 并如实说哪里不平 ——
//    ⛔ 不许"差不多就行"地吐出一份看着漂亮的结果。
// 3. **已知盲区要主动说**：main/jailbreak 里被拼进去的卡字段正文，光靠标签**看不见**。
//    只有调用方把字段原文（外部模式的只读接口 `GET /pmp-dsh-tavern/api/v1/card-fields`）喂进来，
//    本模块才会做**逐字包含**检查并给出位置；⛔ 不做模糊匹配、不猜近似。
// 4. **零依赖、零写入、纯函数**：不读盘、不联网、不改任何东西。
// 5. **隐私**：`header` 只回**键名与值长**，不回值（角色名/用户名词是用户内容）。
// ---------------------------------------------------------------------------

/** 解算结果的结构版本（消费方按它判兼容）。 */
export const TAVERN_PROFILE_SOLVER_VERSION = 1

/** 完整头（有卡/有世界书时）的首行标记 —— 上游 profile-loader.js:480 原文。 */
export const TAVERN_PROFILE_MARKER = '[dsh-tavern profile]'

/**
 * 只-preset 快路径的首行标记 —— 上游 profile-compiler.js:38 原文。
 * ★ 这条路径下 profile 段**只有**这一段头 + `<st-prompt>` 块（没有卡字段、没有世界书），
 *   所以解算器必须也认它，否则会把整段头当成"未归属文本"。
 */
export const TAVERN_PRESET_ONLY_MARKER = '[dsh-tavern selected preset]'

/** 两种头各自的合法键（逐条照抄上游：profile-loader.js:481-493 / profile-compiler.js:39-40）。 */
const HEADER_KEYS_BY_MARKER = Object.freeze({
  [TAVERN_PROFILE_MARKER]: new Set(['preset-name', 'preset-id', 'character-name', 'character-id', 'user-name', 'user-id']),
  [TAVERN_PRESET_ONLY_MARKER]: new Set(['name', 'id']),
})

/** 标签 → 块种类。 */
const BLOCK_KINDS = Object.freeze({
  'st-prompt': 'preset-prompt',
  'st-character-field': 'character-field',
  'st-user-field': 'user-field',
  'st-world-info': 'world-info',
  'imported-playthrough-context': 'imported-context',
})

/**
 * 标签里的 name → SillyTavern 标准字段名（上游 :516 / :558 的映射，逐条照抄）。
 * ★ 键是**标签上写的** name，值是**字段身份**（与上游 card-fields 只读接口的字段名对齐）。
 */
const CHARACTER_TAG_TO_FIELD = Object.freeze({
  'system-prompt': 'system_prompt',
  description: 'description',
  personality: 'personality',
  scenario: 'scenario',
  'message-example': 'mes_example',
  'post-history-instructions': 'post_history_instructions',
  'greeting-reference': 'greeting_reference',
  'depth-prompt': 'depth_prompt',
})

/** 追问「这个字段该由谁接管」时，这 7 个才是上游外部模式交出的卡字段（其余是旁支）。 */
export const TAVERN_CARD_FIELDS = Object.freeze([
  'description', 'personality', 'scenario', 'mes_example',
  'system_prompt', 'post_history_instructions', 'depth_prompt',
])

/** XML 属性反转义（上游 escapeAttribute 的逆：& < > "）。 */
function unescapeAttribute(value) {
  return String(value)
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

/** 从一行开标签里取属性；⛔ 不做 HTML 解析，只抓 `name="value"`。 */
function parseAttributes(openTagText) {
  const attrs = {}
  for (const m of openTagText.matchAll(/([a-zA-Z][a-zA-Z0-9_-]*)="([^"]*)"/gu)) {
    attrs[m[1]] = unescapeAttribute(m[2])
  }
  return attrs
}

/**
 * 从 `from` 起找该块的收尾标签。
 * 构造式是 `开标签\n正文\n收标签` 且块后紧跟 `\n\n`（或到串尾），所以只认"行首 + 后面是 \n\n 或串尾"的收尾标签 ——
 * 正文里若恰好出现同名字符串，不会被误当收尾。找不到 ⇒ 交给调用方如实标未闭合，⛔ 不猜。
 * @returns {{ index: number, end: number } | null} index = 收尾标签起点，end = 收尾标签之后的位置
 */
function findClose(src, from, tagName) {
  const needle = `</${tagName}>`
  let at = src.indexOf(needle, from)
  while (at !== -1) {
    const lineStart = at === 0 || src[at - 1] === '\n'
    const after = at + needle.length
    const tailOk = after >= src.length || src.startsWith('\n\n', after)
    if (lineStart && tailOk) return { index: at, end: after }
    at = src.indexOf(needle, at + 1)
  }
  return null
}

/** 解析头部；⛔ 只回键名与值长，不回值。 */
function parseHeader(chunk, marker) {
  const allowed = HEADER_KEYS_BY_MARKER[marker] ?? new Set()
  const lines = chunk.split('\n')
  const keys = []
  const unknownLines = []
  for (const raw of lines.slice(1)) {
    const line = raw.trim()
    if (line === '') continue
    const at = line.indexOf(':')
    const key = at === -1 ? '' : line.slice(0, at).trim()
    if (key !== '' && allowed.has(key)) keys.push({ key, valueChars: line.slice(at + 1).trim().length })
    else unknownLines.push({ lineChars: line.length })
  }
  return { present: true, marker, keys, unknownLines }
}

/** 首行是哪个已知标记（不是就 null）。 */
function knownMarkerOf(firstLine) {
  const head = String(firstLine).trimStart()
  for (const marker of Object.keys(HEADER_KEYS_BY_MARKER)) {
    if (head.startsWith(marker)) return marker
  }
  return null
}

/**
 * 独立复算解算结果的不变量 —— **供消费方与自检台独立核对**，不信任 `result.ok`。
 * 判据：每个 part 的 offset 单调、互不重叠、`offset + chars` 不越界；`Σ chars + 分隔符 === chars`。
 * @param {object} result - `solveTavernProfile` 的返回
 * @returns {string[]} 问题清单（空数组 = 平）
 */
export function verifyTavernProfileSolution(result) {
  const problems = []
  if (result === null || typeof result !== 'object') return ['结果不是对象']
  const parts = Array.isArray(result.parts) ? result.parts : null
  if (parts === null) return ['result.parts 不是数组']
  const total = Number(result.chars)
  if (!Number.isFinite(total)) return ['result.chars 不是有限数']
  let cursor = 0
  let sum = 0
  for (const p of parts) {
    const off = Number(p.offset)
    const len = Number(p.chars)
    if (!Number.isFinite(off) || !Number.isFinite(len) || len < 0) { problems.push(`part#${p.index} 的 offset/chars 不是合法非负数`); continue }
    if (off < cursor) problems.push(`part#${p.index} 与前一块重叠或乱序（offset=${off} < 期望 ${cursor}）`)
    if (off + len > total) problems.push(`part#${p.index} 越过串尾（${off}+${len} > ${total}）`)
    cursor = off + len
    sum += len
  }
  const sep = Number(result.separators?.chars ?? 0)
  if (sum + sep !== total) problems.push(`不守恒：Σpart ${sum} + 分隔符 ${sep} = ${sum + sep} ≠ 总长 ${total}`)
  return problems
}

/**
 * 把 `pmp-dsh-tavern:profile` 段的正文解算成块与字段。
 * @param {string} text - 该段的正文（与 DSH 请求里逐字一致的那份）。
 * @param {object} [options]
 * @param {number|null} [options.sectionOffset] - 该段在「整楼 system 全文」里的起点；给了就额外回绝对位置，⛔ 不给就为 null（不是 0）。
 * @param {Record<string,string>} [options.fieldTexts] - 外部模式只读接口交出的卡字段原文；给了才做逐字定位。
 * @returns {object} 解算结果（结构见文件末尾的 `solveTavernProfile` 注释）
 */
export function solveTavernProfile(text, options = {}) {
  const src = typeof text === 'string' ? text : ''
  const sectionOffset = Number.isFinite(options.sectionOffset) ? Number(options.sectionOffset) : null
  const fieldTexts = options.fieldTexts !== null && typeof options.fieldTexts === 'object' ? options.fieldTexts : null

  /** @type {object[]} */
  const parts = []
  const warnings = []
  const blindSpots = []
  let separatorChars = 0
  let pos = 0

  const abs = (offset) => (sectionOffset === null ? null : sectionOffset + offset)

  // ── ① 头部块（首行标记 + 键值行；到第一个 \n\n 为止） ──────────────────────
  let header = { present: false, marker: null, keys: [], unknownLines: [] }
  {
    const firstBreak = src.indexOf('\n\n')
    const chunkEnd = firstBreak === -1 ? src.length : firstBreak
    const chunk = src.slice(0, chunkEnd)
    const marker = knownMarkerOf(chunk)
    if (marker !== null) {
      header = parseHeader(chunk, marker)
      parts.push({
        index: parts.length, kind: 'header', tagName: null, offset: 0, chars: chunk.length,
        absoluteOffset: abs(0), innerOffset: 0, innerChars: chunk.length, closed: true,
      })
      pos = chunkEnd
      for (const u of header.unknownLines) {
        warnings.push({ code: 'header-line-unrecognized', message: `头部有 1 行不认识的键（${u.lineChars} 字符）⇒ 未归入任何键，⛔ 不猜` })
      }
    } else {
      warnings.push({ code: 'header-absent', message: `这段不以 ${TAVERN_PROFILE_MARKER} 或 ${TAVERN_PRESET_ONLY_MARKER} 开头 ⇒ 可能不是 Tavern profile 段（或上游改了头格式），头部按"没有"记` })
    }
  }

  // ── ② 逐块扫描 ─────────────────────────────────────────────────────────────
  while (pos < src.length) {
    // 分隔符：块间一律 \n\n（上游 join('\n\n')）；不吞别的空白，免得把内容算成结构。
    if (src.startsWith('\n\n', pos)) { separatorChars += 2; pos += 2; continue }

    const openAt = pos
    if (src[openAt] !== '<') {
      // 认不出结构 ⇒ 未归属；一直吃到下一个「块边界」（\n\n 之后紧跟 '<st-' 或 '<imported-'）或串尾。
      let end = src.length
      for (let i = openAt; i + 4 <= src.length; i++) {
        if (!src.startsWith('\n\n<', i)) continue
        const after = i + 3
        const rest = src.slice(after)
        if (/^<st-[a-z-]+[ >]/.test(rest) || rest.startsWith('<imported-')) { end = i; break }
      }
      const chunk = src.slice(openAt, end)
      const tagGuess = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(chunk)
      parts.push({
        index: parts.length, kind: tagGuess ? 'unknown-tag' : 'unknown-text',
        tagName: tagGuess ? tagGuess[1] : null, offset: openAt, chars: chunk.length,
        absoluteOffset: abs(openAt), innerOffset: openAt, innerChars: chunk.length, closed: false,
      })
      warnings.push({
        code: tagGuess ? 'unknown-tag' : 'unstructured-text',
        message: tagGuess
          ? `第 ${parts.length} 块用了本模块不认识的标签 <${tagGuess[1]}>（${chunk.length} 字符）⇒ 原样保留为未归属，⛔ 不猜它是哪个字段`
          : `第 ${parts.length} 块没有标签头（${chunk.length} 字符）⇒ 未归属，⛔ 不猜`,
      })
      pos = end
      continue
    }

    const lineEnd = src.indexOf('\n', openAt)
    const openLine = src.slice(openAt, lineEnd === -1 ? src.length : lineEnd)
    const tagMatch = /^<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*)?>$/.exec(openLine.trim())
    if (!tagMatch) {
      // 形如 `<something>` 但不合开标签语法 ⇒ 未归属，逐字保留。
      const end = lineEnd === -1 ? src.length : lineEnd
      const chunk = src.slice(openAt, end)
      parts.push({
        index: parts.length, kind: 'unknown-tag', tagName: null, offset: openAt, chars: chunk.length,
        absoluteOffset: abs(openAt), innerOffset: openAt, innerChars: chunk.length, closed: false,
      })
      warnings.push({ code: 'open-tag-unparsable', message: `第 ${parts.length} 块的开标签行读不出标签名（${chunk.length} 字符）⇒ 未归属` })
      pos = end
      continue
    }

    const tagName = tagMatch[1]
    const kind = BLOCK_KINDS[tagName] ?? null
    const attrs = parseAttributes(openLine.trim())
    const innerStart = lineEnd === -1 ? src.length : lineEnd + 1
    const close = kind === null ? null : findClose(src, innerStart, tagName)

    // 块内容 = 开标签行 + \n + 正文 + \n + 收标签（与上游一致的形状）
    let blockEnd
    let innerEnd
    let closed
    if (close === null) {
      blockEnd = src.length
      innerEnd = src.length
      closed = false
      if (kind !== null) {
        warnings.push({
          code: 'block-unclosed',
          message: `第 ${parts.length + 1} 块 <${tagName}> 找不到与其匹配的收尾标签（构造式要求收尾标签独占行首、其后是空行或串尾）⇒ 标为未闭合并吃到串尾，⛔ 不猜结尾`,
        })
      }
    } else {
      innerEnd = close.index
      blockEnd = close.end
      closed = true
    }
    // 收标签前上游会写一个 \n（正文与收标签之间的那个换行）
    const innerChars = Math.max(0, innerEnd - innerStart - (closed ? 1 : 0))

    // ★ 假阴性防线：若本块"正文"里出现了**行首的另一个块开标签**，那多半不是真嵌套，而是
    //   某个收尾标签缺失/写错，于是本块把下一块吞了进来。上游不会嵌套块（body 是平铺 push 的），
    //   所以这里必须把这件事**说出来** —— ⛔ 不许静默吞并（那会让"未闭合"这条判据永远测不出来）。
    if (kind !== null && closed) {
      const region = src.slice(innerStart, innerEnd)
      const nested = []
      // `^` 覆盖"块正文第一行就是开标签"，`\n<` 覆盖其后的行首；两者都是"行首"。
      for (const m of region.matchAll(/(?:^|\n)<(st-[a-z-]+|imported-playthrough-context)[ >]/gu)) nested.push(m[1])
      if (nested.length > 0) {
        warnings.push({
          code: 'nested-open-inside-block',
          message: `第 ${parts.length + 1} 块 <${tagName}> 的正文里出现了行首开标签 ${[...new Set(nested)].map((t) => `<${t}>`).join('、')} ⇒ 上游不嵌套块，这通常是**某个收尾标签缺失或写错**、本块把下一块吞了进来。本模块按"文本事实"把这段算作本块正文，并把这件事说出来，⛔ 不替上游补标签。`,
        })
      }
    }

    const part = {
      index: parts.length,
      kind: kind ?? 'unknown-tag',
      tagName,
      offset: openAt,
      chars: blockEnd - openAt,
      absoluteOffset: abs(openAt),
      innerOffset: innerStart,
      innerChars,
      closed,
      // 各类块的"来源身份"：只放结构字段，⛔ 不放正文
      ...(attrs.identifier === undefined ? {} : { presetIdentifier: attrs.identifier }),
      ...(attrs.role === undefined ? {} : { role: attrs.role }),
      ...(attrs.name === undefined ? {} : { tagNameAttr: attrs.name }),
      ...(attrs.entry === undefined ? {} : { worldInfoEntry: attrs.entry }),
      ...(attrs.position === undefined ? {} : { worldInfoPosition: attrs.position }),
      ...(attrs.trust === undefined ? {} : { trust: attrs.trust }),
      ...(attrs.sha256 === undefined ? {} : { sourceSha256: attrs.sha256 }),
    }
    if (kind === 'character-field') {
      const field = CHARACTER_TAG_TO_FIELD[attrs.name ?? '']
      if (field === undefined) {
        warnings.push({ code: 'character-field-unknown-name', message: `第 ${part.index + 1} 块的卡字段标签 name="${attrs.name ?? ''}" 不在上游映射里 ⇒ 未归入任何字段，⛔ 不猜` })
      } else {
        part.field = field
      }
    }
    if (kind === 'world-info') {
      const p = attrs.position
      if (p !== 'before' && p !== 'after') {
        warnings.push({ code: 'world-info-position-unexpected', message: `第 ${part.index + 1} 块的世界书条目 position="${p ?? ''}" 不是 before/after ⇒ 原样记，不推断` })
      }
    }
    if (kind === null) {
      warnings.push({ code: 'unknown-tag', message: `第 ${part.index + 1} 块用了本模块不认识的标签 <${tagName}>（${part.chars} 字符）⇒ 原样保留为未归属` })
    }
    parts.push(part)
    pos = blockEnd
  }

  // ── ③ 已知盲区：main/jailbreak 的 override 拼接 ────────────────────────────
  const presetIds = parts.filter((p) => p.kind === 'preset-prompt').map((p) => p.presetIdentifier)
  const hasFieldTag = (name) => parts.some((p) => p.kind === 'character-field' && p.tagNameAttr === name)
  if (presetIds.includes('main') && !hasFieldTag('system-prompt')) {
    blindSpots.push({
      code: 'system-prompt-may-be-spliced-into-main',
      message: '预设里有 main 段、但没有独立的 <st-character-field name="system-prompt"> 块：上游在 main 的正文里用 {{original}} 把卡字段 system_prompt 拼了进去（profile-loader.js:590 applyOriginal）——**拼进去的正文外面没有标签**，光看这段文本推不出边界。要定位就喂 fieldTexts（外部模式只读接口 GET /pmp-dsh-tavern/api/v1/card-fields）。',
    })
  }
  if (presetIds.includes('jailbreak') && !hasFieldTag('post-history-instructions')) {
    blindSpots.push({
      code: 'post-history-instructions-may-be-spliced-into-jailbreak',
      message: '同理：jailbreak 段可能已被拼入卡字段 post_history_instructions（无标签可辨），给了 fieldTexts 才能逐字定位。',
    })
  }

  // ── ④ 可选：拿字段原文做**逐字**定位（只做精确包含，⛔ 不模糊匹配） ─────────
  const fieldTextMatch = []
  if (fieldTexts !== null) {
    for (const [field, rawText] of Object.entries(fieldTexts)) {
      const needle = typeof rawText === 'string' ? rawText : ''
      const trimmed = needle.trim()
      if (trimmed === '') { fieldTextMatch.push({ field, chars: 0, found: null, note: '字段为空 ⇒ 无从定位' }); continue }
      const at = src.indexOf(needle)
      const atTrimmed = at === -1 ? src.indexOf(trimmed) : at
      const hit = at === -1 ? atTrimmed : at
      const hitChars = at === -1 ? trimmed.length : needle.length
      if (hit === -1) {
        fieldTextMatch.push({ field, chars: hitChars, found: false, note: '这段正文里逐字没找到 ⇒ 它没进这一段（或已被宏渲染改过字面）' })
        continue
      }
      const owner = parts.find((p) => p.offset <= hit && hit < p.offset + p.chars) ?? null
      fieldTextMatch.push({
        field, chars: hitChars, found: true, offset: hit, absoluteOffset: abs(hit),
        insidePartIndex: owner === null ? null : owner.index,
        insidePartKind: owner === null ? null : owner.kind,
        exact: at !== -1,
      })
    }
  }

  // ── ⑤ 归并 + 不变量自校验 ──────────────────────────────────────────────────
  const attributedChars = parts.reduce((a, p) => a + p.chars, 0)
  const separatorCharsTotal = separatorChars

  const byField = {}
  for (const field of [...TAVERN_CARD_FIELDS, 'greeting_reference']) {
    const tagged = parts.filter((p) => p.field === field)
    const spliced = fieldTextMatch.filter((m) => m.field === field && m.found === true && m.insidePartKind === 'preset-prompt')
    if (tagged.length === 0 && spliced.length === 0) continue
    byField[field] = {
      parts: tagged.map((p) => p.index),
      taggedChars: tagged.reduce((a, p) => a + p.chars, 0),
      splicedInPresetChars: spliced.reduce((a, m) => a + m.chars, 0),
      tagNames: [...new Set(tagged.map((p) => p.tagNameAttr))],
    }
  }

  const sources = {
    header: parts.filter((p) => p.kind === 'header').length,
    presetPrompt: parts.filter((p) => p.kind === 'preset-prompt').length,
    characterField: parts.filter((p) => p.kind === 'character-field').length,
    userField: parts.filter((p) => p.kind === 'user-field').length,
    worldInfo: parts.filter((p) => p.kind === 'world-info').length,
    importedContext: parts.filter((p) => p.kind === 'imported-context').length,
    unknown: parts.filter((p) => p.kind === 'unknown-tag' || p.kind === 'unknown-text').length,
  }

  const result = {
    ok: true,
    version: TAVERN_PROFILE_SOLVER_VERSION,
    chars: src.length,
    sectionOffset,
    parts,
    separators: { count: Math.max(0, parts.length - 1), chars: separatorCharsTotal },
    coverage: {
      attributedChars,
      separatorChars: separatorCharsTotal,
      unattributedChars: parts.filter((p) => p.kind === 'unknown-tag' || p.kind === 'unknown-text').reduce((a, p) => a + p.chars, 0),
      // `ratio` = 被块归属的比例（分隔符不算）；`accountedRatio` = 连分隔符也算进去的比例。
      // 两个都给，是因为"全是有标签的块"时前者天然 < 1（块之间那些空行不是块）—— 只给一个数容易被误读。
      ratio: src.length === 0 ? 1 : Number((attributedChars / src.length).toFixed(4)),
      accountedRatio: src.length === 0 ? 1 : Number(((attributedChars + separatorCharsTotal) / src.length).toFixed(4)),
    },
    header,
    sources,
    byField,
    blindSpots,
    fieldTextMatch,
    warnings,
  }

  const partProblems = verifyTavernProfileSolution(result)
  if (partProblems.length > 0) {
    for (const p of partProblems) result.warnings.push({ code: 'internal-invariant', message: p })
    result.ok = false
  }
  return result
}

export default solveTavernProfile
