/**
 * tavern-field-plan —— **上游 Tavern 解出来的每个卡字段，摆到哪个位置**（纯逻辑，唯一真相源）。
 *
 * ## 为什么要我们摆（用户 2026-09-19 口径）
 *   「上游没有指定 order 或什么东西，这就是让位给我们，让我们设置注入位置」
 * 上游 `tavern-loader` 把「预设 + 卡字段 + 世界书」展开成若干
 * `pmp-dsh-tavern:part:NNNN:<kind>:<field>` 段（`profile-loader.js` 的 `appendCharacterFallbacks` 等），
 * 这些段**不带 order**，只按数组序就地插在它自己 profile 槽位上；而 DSH 渲染 system 用的是
 * **段表数组顺序**（真机实证：搬动数组位置，正文里的位置就跟着动）⇒ **位置由我们定**。
 *
 * ## 字段清单从哪来（⛔ 不靠"我看见过哪些"）
 *   全部抄自上游源码，逐条能指到行：
 *   · 卡字段八个 —— `profile-loader.js:550-559` 的 `fallbacks` 列表：
 *     `systemPrompt / description / personality / scenario / messageExample / postHistoryInstructions / greeting / depthPrompt`
 *     （另有 `{{description}}` 这类宏命中时按同名字段再提一份，`:428-430`）；
 *   · 用户人设 —— `:391` `body.userSource = () => source('user', user, 'description', …)` ⇒ `user:description`；
 *   · 世界书 —— `:579` `source('worldbook', null, 'content', …)` ⇒ `worldbook:content`；
 *   · 预设条目 —— `:397` `source('preset', preset, 'prompts/<n>/content', …)`（段名里 `/` 被上游换成 `_`）；
 *   · 无来源段 —— 上游 `namedParts()` 的兜底 `generated:header`。
 *   ⛔ `creatorNotes` / `characterBook`（卡内嵌世界书）**不在**这份清单里：上游一个只进界面、一个交给世界书模块
 *     （`specs` 与 `卡字段对照表.md` 都写着"永不进 prompt"/"交给世界书模块"）⇒ 我们不编这两个字段的注释。
 *
 * ## 位置（order）怎么定
 *   照 SillyTavern 的**默认顺序**排（`02-方案设计` 与本仓库 `lib/card-sections.js` 的 CARD_SECTION_PLAN 同源）：
 *   main → worldInfoBefore → charDescription → charPersonality → scenario → worldInfoAfter →
 *   dialogueExamples → 对话历史 → postHistoryInstructions。
 *   两个字段在 DSH 里**没有对应槽位**（上游自己都报了诊断），只能近似，注释里逐条写明：
 *   · `character:greeting`（上游诊断 `CHARACTER_GREETING_REFERENCE`：*style reference, not an assistant history message*）
 *     —— ST 里它是**历史的第一条**；我们把它摆在**系统末尾、历史之前**（离历史最近的那个合法位置）。
 *   · `character:depthPrompt`（上游诊断 `CHARACTER_DEPTH_APPROXIMATE`）—— ST 按"距历史末尾的深度"插；
 *     我们摆在卡字段之后、历史之前。
 *   · `character:postHistoryInstructions`（上游诊断 `CHARACTER_PHI_APPROXIMATE`）—— ST 在**历史之后**；
 *     我们摆在**全文最后**（10203），这就是"后处理提示词"该有的效果。
 *
 * @module dsh-memory-archive/tavern-field-plan
 * @license CC-BY-NC-4.0
 */

export const TAVERN_FIELD_PLAN_VERSION = 1

/** 我们这一侧给 part 段派的 order 空间（⛔ 别碰别的插件的：0/1/2 是我们自己的、45+ 是别人的）。 */
export const PART_ORDER_BASE = 10
/** 后处理提示词的目标 order —— 必须是**全文最后**（> persona-suffix 10200 > mt:lastFloors 10202）。 */
export const PHI_PART_ORDER = 10203
/** 开场白的目标 order —— 系统末尾、历史之前（在 10100 的宿主段之后、10200 的 persona 槽之前）。 */
export const GREETING_PART_ORDER = 10150

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v) => (typeof v === 'string' ? v : '')

/**
 * 字段计划表（顺序 = 我们希望它们在 system 里的先后）。
 * 每条注释一句话（用户 2026-09-20 手改后给的口径，原文照录）：
 * 点名"它是什么字段" + 它的意义 + 它在 ST 里一般放哪儿；⛔ 不再写 order 数字与机制细节。
 */
export const TAVERN_FIELD_PLAN = Object.freeze([
  {
    key: 'character:systemPrompt', order: 10, st: 'main（系统提示词）',
    note: '**由 dsh-tavern 解算的角色卡字段** —— `system_prompt`，即系统提示词，在 ST 中位于提示词最前方，用于覆盖可能的原始提示词。',
  },
  {
    key: 'user:description', order: 11, st: 'Persona Description（用户人设）',
    note: '玩家角色的人设，说明 `{{user}}` 是谁、什么身份、和角色什么关系；通常并入系统提示区，也可能作为独立条目放在角色卡字段之前。',
  },
  {
    key: 'character:description', order: 12, st: 'charDescription（角色描述）',
    note: '**由 dsh-tavern 解算的角色卡字段** —— `description`，即对角色的描述 —— 外貌/身份/背景的正文，一般是角色卡里最主要的一段。',
  },
  {
    key: 'character:personality', order: 13, st: 'charPersonality（性格）',
    note: '**由 dsh-tavern 解算的角色卡字段** —— `personality`，即性格摘要，一句话式的性格与口吻基调，常与 description 互补。',
  },
  {
    key: 'character:scenario', order: 14, st: 'scenario（情境）',
    note: '**由 dsh-tavern 解算的角色卡字段** —— `scenario`，即情境/设定，定义故事发生在什么场面里（时间地点、双方处境）。',
  },
  {
    key: 'worldbook:content', order: 15, st: 'worldInfoAfter（世界书·后置）/ worldInfoBefore（前置）',
    note: '世界书条目，按关键词触发设定补充；dsh-tavern 把「描述前/场景后」两批压缩进同一字段名。',
  },
  {
    key: 'character:messageExample', order: 16, st: 'dialogueExamples（示例对话）',
    note: '示例对话，用几轮对话示范文风、称呼和说话方式；是样板，不是实际对话历史。',
  },
  {
    key: 'character:depthPrompt', order: 17, st: 'depth prompt（作者注 Author\'s Note）',
    note: '作者注/深度提示词，临时追加气氛或走向；原本按深度插进历史中间，近似放在卡字段之后、历史之前。',
  },
  {
    key: 'generated:header', order: 18, st: '（没有对应的 ST 槽位）',
    note: '上游生成并推入的文本，没有来源文档；不是卡字段也不是世界书，位置按「卡字段之后」摆并标明。',
  },
  {
    key: 'preset:prompts_', order: 19, st: '预设 prompt_order（Tavern 预设自己的条目）',
    note: '**由 dsh-tavern 解算的角色卡字段** —— 提示词条目；角色卡字段的位置由这些条目的槽位决定。',
  },
  {
    key: 'character:greeting', order: GREETING_PART_ORDER, st: 'first_mes（历史的第一条）',
    note: '角色开场白，不是提示词，是角色先说的第一段话，也当说话样板；DSH 放在系统末尾、历史之前，并注明别原样抄。',
  },
  {
    key: 'character:postHistoryInstructions', order: PHI_PART_ORDER, st: 'post-history instructions（历史之后）',
    note: '**由 dsh-tavern 解算的角色卡字段** —— 后处理提示词，角色卡作者放在最后的收尾指令，一般用于强调写作纪律、放置破甲提示词；DSH 目前不支持放在 user 信息后，只能近似放在 system 最后。',
  },
])

/** 覆盖不了字段名时的**兜底**条目（⛔ 不编意义与 ST 位置：那两条我们确实不知道）。 */
export const TAVERN_FIELD_FALLBACK = Object.freeze({
  key: '*', order: 20, st: null,
  note: '**由上游 dsh-tavern 解算的段**（这个字段名我们的表里还没有）　·　'
    + '**意义**：⛔ 不认识 ⇒ 不编（表里每一条都会写全三件事：① 它是什么字段 ② 它的意义 ③ 它在 ST 里一般放在哪）　·　'
    + '**ST 位置**：⛔ 同样不编 —— 认不出字段名就无从判断它的 ST 槽位；我们只把它摆在**卡字段之后**，不占别的插件的位置',
})

/**
 * 开场白那句"这是样板、别照抄"的说明 —— 做成**我们自己的一段**插在开场白前面。
 *
 * ★ 起因（2026-09-19 用户报障「开场白内容没能正确加载」）：真机会话里模型把卡的开场白
 *   **原样抄进了回复**，连 `<div style="border-radius:16px;…">` 那串 HTML/CSS 一起吐出来 ——
 *   因为上游只把它当"风格参考"塞在 system 里（它自己的诊断就叫 `CHARACTER_GREETING_REFERENCE`：
 *   *style reference, not an assistant history message*），而模型看见一段像开场白的文本，
 *   自然就当成"该我说的话"。DSH 又没有"预置历史"的槽位，所以我们至少得**把话说明白**。
 *
 * ⛔ **别改开场白自己的正文**（第一版就是把说明**拼进它的 text** 的，踩了坑）：组装捕获靠
 *   "段正文的字数/哈希"把每一段锚定到最终提示词里；我们一改，那一段就对不上、在捕获里**整个消失**
 *   ⇒ 面板上表现为"未抓到（未认领）1,284 字"（用户当场发现的）。⇒ 说明**另起一段**
 *   （`mt:greetingNotice`）插在开场白**前面**，开场白正文一字不动。
 */
export const GREETING_NOTICE_NAME = 'mt:greetingNotice'
/** 说明段的 order：紧挨着开场白（开场白是 10150）。 */
export const GREETING_NOTICE_ORDER = GREETING_PART_ORDER - 1
/** 说明段的正文（固定文案）。 */
export const GREETING_NOTICE_TEXT = '【上游说明 · 开场白样板】\n'
  + '紧接着的那一段是本局选中的**开场白样板**（ST 的 `first_mes`）：它是**已经发生过**的开场，也是角色怎么说话的样板 —— '
  + '⛔ 不要把它原样复制进你的回复、⛔ 不要输出其中的 HTML/CSS 标签，按它定下的基调与文风接着演。'

/** 造那段说明（合成段：带名字与 order，正文固定；⛔ 不碰开场白自己的正文）。 */
export function greetingNoticeSection() {
  return { name: GREETING_NOTICE_NAME, order: GREETING_NOTICE_ORDER, text: GREETING_NOTICE_TEXT }
}

/**
 * 从段名里认字段（纯函数）。名字形状：`pmp-dsh-tavern:part:NNNN:<kind>:<field>`。
 * @returns {{key:string, index:string, kind:string, field:string}|null}
 */
export function parseTavernPart(name) {
  const m = /^pmp-dsh-tavern:part:(\d{4}):([A-Za-z0-9_.-]+):(.+)$/.exec(str(name))
  if (m === null) return null
  return { index: m[1], kind: m[2], field: m[3], key: m[2] + ':' + m[3] }
}

/** 查这个字段的计划（⛔ 查不到就返回兜底条，绝不返回 null —— 每条 part 都得有位置和注释）。 */
export function planForField(key) {
  const k = str(key)
  if (k === '') return TAVERN_FIELD_FALLBACK
  for (const entry of TAVERN_FIELD_PLAN) {
    if (entry.key === k) return entry
    // 预设条目是 `preset:prompts_<n>_content` 这种按序号变化的键 ⇒ 前缀命中
    if (entry.key.endsWith('_') && k.startsWith(entry.key)) return entry
  }
  return TAVERN_FIELD_FALLBACK
}

/**
 * 已知段的 order（**兜底骨架**）。
 *
 * ★★ 为什么需要这张表（2026-09-19 沙箱实测踩到）：**装配期的段表里，非 part 段的 `order` 是拿不到的**
 *   —— 真机/沙箱两处都打印成 `—`（那些数字要等宿主**装配之后**的那一趟才写到记录里）。
 *   于是"按 order 找插入点"这条路的判据是空的：所有段看起来都是 `+∞` ⇒ part 全被插到**最前面**（实测）。
 *   ⇒ 改成本表：认得出名字的用这里的 order，`tool:` 一族按量级（真机 1010–2800），认不出的**继承前一个**。
 *   ⚠️ 表里的数字来自真机捕获（`lib/card-sections.js` 的 HARD_RESERVED_ORDERS / 面板注释同源）——
 *     只用来**定位**，不是替宿主下判断。
 */
export const SECTION_ORDER_HINTS = Object.freeze({
  'harness:identity': -1000,
  'deployment:persona-prefix': 0,
  'deployment:persona': 0,
  'mt:memoryProtocol': 1,
  'mt:memoryHome': 2,
  'rp:policy': 45,
  'state:card': 50,
  'dma:echo': 54,
  'anima:memory': 55,
  'rp:storyAnchor': 56,
  'plan:policy': 500,
  'context:file-reference': 900,
  'ui:deliverable-file-references': 9000,
  'harness:source': 10000,
  'app:web-surface': 10100,
  'deployment:persona-suffix': 10200,
  'rp:firstRound': 10201,
  'mt:lastFloors': 10202,
})
/** `tool:*` 一族的量级（真机 1010–2800）：落在卡字段之后、宿主固定段之前。 */
export const TOOL_SECTION_ORDER_HINT = 1500

/** 这一段"相当于"第几位：段上真给了 order 就用真的；否则查表；再否则**继承前一个**。 */
function effectiveOrder(prev, section) {
  if (isObj(section) && typeof section.order === 'number') return section.order
  const name = str(isObj(section) ? section.name : '')
  if (SECTION_ORDER_HINTS[name] !== undefined) return SECTION_ORDER_HINTS[name]
  if (name.startsWith('tool:')) return TOOL_SECTION_ORDER_HINT
  return prev
}

/**
 * 按计划给 part 段**派 order 并把它们摆到目标位置**（纯函数）。
 *
 * ★ 为什么不能只写 order：DSH 渲染 system 用的是**段表数组顺序**（沙箱实证：搬数组位置，正文位置跟着走）
 *   ⇒ 想要位置真的变，必须**改数组**；`order` 一并写上，是为了让捕获与面板能如实显示"我们把它摆在第几位"。
 * ★ 相对顺序怎么定：非 part 段**原地不动**（⛔ 不整体重排，免得动到别人的段），每个 part 插到
 *   "第一个**有效 order** 更大的段"之前（有效 order 见 `effectiveOrder`：真 order → 查表 → 继承前一个）；
 *   part 之间按目标 order 稳定排序（同 order 的多条世界书保持上游给的先后）。
 *
 * @param {unknown} sections 装配期的段表
 * @returns {{sections:Array, placed:Array<{name:string, order:number, key:string}>, fallback:number}}
 */
export function placeTavernParts(sections) {
  const list = Array.isArray(sections) ? sections : []
  const parts = []
  const rest = []
  for (const s of list) {
    const parsed = parseTavernPart(isObj(s) ? s.name : null)
    if (parsed === null) { rest.push(s); continue }
    parts.push({ section: s, parsed, plan: planForField(parsed.key) })
  }
  if (parts.length === 0) return { sections: list, placed: [], fallback: 0 }
  // 非 part 段的"有效 order"（用于定位；⛔ 不改它们）
  const restOrders = []
  let prev = -Infinity
  for (const s of rest) { prev = effectiveOrder(prev, s); restOrders.push(prev) }
  const sorted = parts.slice().sort((a, b) => a.plan.order - b.plan.order)
  // ⚠️ 用"条目数组"而不是两个平行数组：插一个 part 之后下标会整体后移，平行数组当场错位（踩过）
  const entries = rest.map((s, i) => ({ section: s, order: restOrders[i] }))
  const placed = []
  let fallback = 0
  for (const { section, parsed, plan } of sorted) {
    if (plan.key === '*') fallback += 1
    const next = isObj(section) ? { ...section, order: plan.order } : section
    let at = entries.length
    for (let i = 0; i < entries.length; i += 1) {
      const o = typeof entries[i].order === 'number' ? entries[i].order : Number.POSITIVE_INFINITY
      if (o > plan.order) { at = i; break }
    }
    // 开场白：在它**前面**插一段我们自己的说明（⛔ 不动开场白正文 —— 改它会让捕获锚不上、那段整个消失）
    // 幂等：段表里已经有我们的说明段时不再插第二份（万一同一个数组被摆两次）
    let noticeInserted = false
    if (parsed.key === 'character:greeting' && !entries.some((e) => str(isObj(e.section) ? e.section.name : '') === GREETING_NOTICE_NAME)) {
      entries.splice(at, 0, { section: greetingNoticeSection(), order: GREETING_NOTICE_ORDER })
      noticeInserted = true
    }
    entries.splice(noticeInserted ? at + 1 : at, 0, { section: next, order: plan.order })
    placed.push({ name: str(isObj(section) ? section.name : ''), order: plan.order, key: parsed.key })
  }
  return { sections: entries.map((e) => e.section), placed, fallback }
}

/** 面板/日志要的一句摘要（⛔ 只出计数与键名，不出正文）。 */
export function describePlacement(placed) {
  const arr = Array.isArray(placed) ? placed : []
  if (arr.length === 0) return '没有上游解出来的段'
  return arr.map((p) => `${p.key}→${p.order}`).join('、')
}

/**
 * 把**后处理指令那一份 part 整个摘掉**（2026-09-20 用户口径：「…postHistoryInstructions 字段还是出现了」）。
 *
 * 用途：它改从「玩家消息之后」注入之后（`lib/phi-message.js` 的 `agent/pre-step`），system 里这份就不该再出现 ——
 *   ⛔ 注意**不是"清空"**：清空之后段还在，面板上照样是一行 0 字的段，用户看到的还是"这个字段出现了"。
 * ⛔ 只摘 `character:postHistoryInstructions`（别的字段一律不动）；认不出的段原样留着。
 * @returns {{sections: Array, dropped: number}} —— 没摘到任何段时**返回入参那个数组本身**（⛔ 不白造新数组）
 */
export function dropPostHistoryPart(sections) {
  const list = Array.isArray(sections) ? sections : []
  const kept = []
  let dropped = 0
  for (const s of list) {
    const parsed = parseTavernPart(isObj(s) ? s.name : null)
    if (parsed !== null && parsed.key === 'character:postHistoryInstructions') { dropped += 1; continue }
    kept.push(s)
  }
  return { sections: dropped > 0 ? kept : list, dropped }
}

export default {
  TAVERN_FIELD_PLAN_VERSION, PART_ORDER_BASE, PHI_PART_ORDER, GREETING_PART_ORDER,
  GREETING_NOTICE_NAME, GREETING_NOTICE_ORDER, GREETING_NOTICE_TEXT, greetingNoticeSection,
  TAVERN_FIELD_PLAN, TAVERN_FIELD_FALLBACK, parseTavernPart, planForField, placeTavernParts, describePlacement,
  dropPostHistoryPart,
  SECTION_ORDER_HINTS, TOOL_SECTION_ORDER_HINT,
}
