// ---------------------------------------------------------------------------
// card-sections —— Plan B：**由本插件**把角色卡字段注册成 system 段落（默认关闭）。
//
// ## 为什么默认关闭（这是本模块最重要的设计决定）
// builtin 模式下，上游 `pmp-dsh-tavern` 已经把卡字段装进它自己的 `pmp-dsh-tavern:profile`
// （真机实测 order 10、8558 字）。我们再注册一份 ⇒ **双重注入**，模型会看到两份互相矛盾的设定。
// 所以：`enabled !== true` 时**一段都不注册**（并回一句可读原因），启用时若检测到 Tavern 可达也**明确警告**。
//
// ## 与上游/别的插件的 order 边界（⛔ 一律不占）
//   10  pmp-dsh-tavern:profile（上游卡字段窗）
//   45  rp:policy（上游）
//   50  state:card / 55 anima:memory / 56 rp:storyAnchor（别的插件）
//   60  dma:settings（本插件既有，RP 预设包里的设置段）
//   9900 STRUCTURED_OUTPUT / 9950 dma:rules（本插件既有的静态核心规则，钉死不动）
// ⇒ 本模块用的位：10–14 / 20 / 30 / 40 / 9948 / 9949。**9949 是我们能靠后的极限**：
//   9950 被「静态核心规则」占着且那是一条已装机的既有约束（market 验收 D46b 断言过），不挪。
//
// ## 两条 ST 语义在 DSH 里**没有对应槽位**，只能近似（必须如实标注，见 cardsection honesty）
//   `post-history-instructions`：ST 里在历史之后、迟于玩家消息；DSH 的 system 是一个整块，
//      能把段落放在玩家消息**之后**的机制不存在（消息流里能落的只有一次性 user 消息投影，
//      而且投在玩家消息**之前**）。⇒ 取 system 尾部 9949，并标「近似」。
//      上游自己也是这么做的，且标了 `CHARACTER_PHI_APPROXIMATE`（*not strictly after chat history*）。
//   `depth-prompt`：ST 里是按距历史末尾的深度插入；DSH 不暴露任意深度插入
//      （上游诊断 `CHARACTER_DEPTH_APPROXIMATE`）。⇒ 取 9948，并标「近似」。
//   `greeting-reference`：用户决定**本插件不注册**（开场白由记忆库那侧管理）⇒ 本模块里**没有**这一段。
//
// 零依赖、纯函数式装配 + 一个注册函数；不读盘、不联网。
// ---------------------------------------------------------------------------

/** 计划版本：装配结果变了就 +1（自检台钉住它）。 */
export const CARD_SECTIONS_VERSION = 1

/**
 * **硬保留** order —— 无论什么模式都**一律不占**（别的插件的、我们既有的、官方尾段的）。
 * 出处：真机捕获（`session-c724926f` 的段表）与 market 验收 D46b（`dma:rules` 钉在 9950）。
 */
export const HARD_RESERVED_ORDERS = Object.freeze([
  { order: 45, owner: 'rp:policy（上游）' },
  { order: 50, owner: 'state:card（dsh-state-bridge）' },
  { order: 54, owner: 'dma:echo（本插件 · 记忆回响 D2）' },
  { order: 55, owner: 'anima:memory（dsh-anima-rag）' },
  { order: 56, owner: 'rp:storyAnchor' },
  { order: 60, owner: 'dma:settings（本插件既有）' },
  { order: 900, owner: 'context:file-reference' },
  { order: 9000, owner: 'ui:deliverable-file-references' },
  { order: 9900, owner: 'STRUCTURED_OUTPUT' },
  { order: 9950, owner: 'dma:rules（本插件既有静态核心规则）' },
])

/**
 * **有条件可用**的 order —— 上游那一窗。
 * ★ 这一条是本模块的核心语义：**10 只有在"上游已停止注入卡字段"时才空出来**，
 *   而那正是 Plan B 的前提（builtin 下 10 被 `pmp-dsh-tavern:profile` 占着，我们绝不能占 ⇒ 否则双重注入）。
 *   ⇒ 冲突检查与注册都必须带 `tavernProfileActive`：它为 true 时**硬拒绝**，不是软警告。
 */
export const CONDITIONAL_ORDERS = Object.freeze([
  { order: 10, owner: 'pmp-dsh-tavern:profile（上游卡字段窗）', freeWhen: '上游已停止注入该段（Plan B 的前提）' },
])

/** 兼容旧名：全部保留位（硬 + 有条件）。 */
export const RESERVED_ORDERS = Object.freeze([...HARD_RESERVED_ORDERS, ...CONDITIONAL_ORDERS])

/**
 * 段落计划：一个语义单元一段。
 * `st` = 对应的 SillyTavern 标记名（我们不改 ST 的语义，只是把它落到 DSH 的 order 上）；
 * `honesty` 非空 ⇒ 这一段在 DSH 里是**近似**，界面必须如实标注。
 */
export const CARD_SECTION_PLAN = Object.freeze([
  { id: 'system-prompt', name: 'dma:card:system-prompt', order: 10, st: 'system-prompt', label: '角色卡 · 主提示词' },
  { id: 'description', name: 'dma:card:description', order: 11, st: 'description', label: '角色卡 · 描述' },
  { id: 'personality', name: 'dma:card:personality', order: 12, st: 'personality', label: '角色卡 · 性格' },
  { id: 'scenario', name: 'dma:card:scenario', order: 13, st: 'scenario', label: '角色卡 · 场景' },
  { id: 'mes-example', name: 'dma:card:mes-example', order: 14, st: 'message-example', label: '角色卡 · 示例对话' },
  { id: 'user-persona', name: 'dma:user:persona-description', order: 20, st: 'persona-description', label: '用户人设' },
  { id: 'lore-before', name: 'dma:lore:before', order: 30, st: '(worldInfoBefore)', label: '世界书 · 前置命中' },
  { id: 'lore-after', name: 'dma:lore:after', order: 40, st: '(worldInfoAfter)', label: '世界书 · 后置命中' },
  {
    id: 'depth-prompt', name: 'dma:card:depth-prompt', order: 9948, st: 'depth-prompt', label: '角色卡 · 深度提示',
    honesty: '近似：ST 按"距历史末尾的深度"插入，DSH 不暴露任意深度插入（上游诊断 CHARACTER_DEPTH_APPROXIMATE）',
  },
  {
    id: 'post-history-instructions', name: 'dma:card:post-history-instructions', order: 9949, st: 'post-history-instructions', label: '角色卡 · 历史后指令',
    honesty: '近似：ST 里它在历史之后、迟于玩家消息；DSH 的 system 是整块，没有"玩家消息之后"的槽位，只能放 system 尾部（上游同样如此，并标 CHARACTER_PHI_APPROXIMATE）',
  },
])

/** 字段键 → 计划项（供调用方按字段名喂正文）。 */
export const FIELD_TO_SECTION = Object.freeze(
  Object.fromEntries(CARD_SECTION_PLAN.map((s) => [s.id, s])),
)

/**
 * 检查计划有没有撞上保留位，或自己内部重复。
 * @param {object} [opts]
 * @param {boolean} [opts.tavernProfileActive] - 上游那一窗此刻**是否仍在注入**（true ⇒ order 10 不可用）。
 *   ⛔ 这个参数不能省着猜：它是"会不会双重注入"的唯一判据。
 * @returns {{ order: number, name: string, owner: string }[]} 冲突清单（空 = 干净）
 */
export function detectOrderCollisions(plan = CARD_SECTION_PLAN, opts = {}) {
  const tavernActive = opts.tavernProfileActive === true
  const reserved = tavernActive
    ? [...HARD_RESERVED_ORDERS, ...CONDITIONAL_ORDERS]
    : [...HARD_RESERVED_ORDERS]
  const problems = []
  const seen = new Map()
  for (const s of plan) {
    if (seen.has(s.order)) problems.push({ order: s.order, name: s.name, owner: `与计划内 ${seen.get(s.order)} 同序` })
    else seen.set(s.order, s.name)
    const hit = reserved.find((r) => r.order === s.order)
    if (hit !== undefined) problems.push({ order: s.order, name: s.name, owner: hit.owner })
  }
  return problems
}

/**
 * 按计划把「有正文的字段」装成可注册的段落表。
 * ⛔ 空字段**不注册那一段**（与上游一致：不要往 system 里塞空段）。
 * @param {{ fields?: Record<string,string>, persona?: string, loreBefore?: string, loreAfter?: string }} input
 * @returns {{ name: string, order: number, text: string, meta: object }[]}
 */
export function buildCardSections(input = {}) {
  const fields = input.fields !== null && typeof input.fields === 'object' ? input.fields : {}
  const source = {
    'system-prompt': fields['system-prompt'],
    'description': fields['description'],
    'personality': fields['personality'],
    'scenario': fields['scenario'],
    'mes-example': fields['mes-example'],
    'depth-prompt': fields['depth-prompt'],
    'post-history-instructions': fields['post-history-instructions'],
    'user-persona': input.persona,
    'lore-before': input.loreBefore,
    'lore-after': input.loreAfter,
  }
  const out = []
  for (const s of CARD_SECTION_PLAN) {
    const text = typeof source[s.id] === 'string' ? source[s.id].trim() : ''
    if (text === '') continue
    out.push({
      name: s.name,
      order: s.order,
      text,
      meta: {
        st: s.st,
        label: s.label,
        honesty: s.honesty ?? null,
        // ★ 我们的注入来源必须可自证：不是上游那一窗
        owner: 'dsh-memory-archive（Plan B，本插件注册）',
      },
    })
  }
  return out
}

/**
 * 把段落注册进 DSH 的 systemPrompt（官方签名 `section({name, order, text})`）。
 *
 * ⛔ 默认关闭：`options.enabled !== true` 时**一段都不注册**，只回可读原因。
 * ⚠️ 启用时若调用方告知 Tavern 可达 ⇒ 回一条警告（可能在双重注入），由调用方决定要不要记日志。
 *
 * @param {object} ctx - cordis 上下文（需要 `systemPrompt.section` 与可选的 `effect`）
 * @param {object} options - `{ enabled, tavernProfileActive, fields, persona, loreBefore, loreAfter, tavernReachable }`
 *   ★ `tavernProfileActive === true` ⇒ **硬拒绝**（上游仍在注入那一窗，我们注册就是双重注入）；
 *     它是 Plan B 的前提判据，⛔ 不许用"Tavern 装了没有"来代替（装了 ≠ 在注入）。
 * @returns {{ ok: boolean, refusedReason: string|null, registered: string[], disposers: Function[], warning: string|null }}
 */
export function registerCardSections(ctx, options = {}) {
  const refused = (reason) => ({ ok: false, refusedReason: reason, registered: [], disposers: [], warning: null })

  if (options.enabled !== true) {
    return refused('未启用：本插件默认不改写 system 的卡字段区（builtin 下上游已在注入，再注册就是双重注入）')
  }
  if (options.tavernProfileActive === true) {
    return refused('上游的 pmp-dsh-tavern:profile（order 10）此刻仍在注入卡字段 ⇒ 拒绝注册，避免双重注入。'
      + '先让它停（v3 的 external 模式，或上游侧关掉注入）再来开这个开关。')
  }
  const systemPrompt = ctx?.systemPrompt
  if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') {
    return refused('宿主没有 systemPrompt.section 服务（这个宿主版本或这个装载路径不提供官方注册面）')
  }

  const collisions = detectOrderCollisions(CARD_SECTION_PLAN, { tavernProfileActive: false })
  if (collisions.length > 0) {
    return refused(`计划撞上保留 order：${collisions.map((c) => `${c.order}(${c.name} ↔ ${c.owner})`).join('、')}`)
  }

  const sections = buildCardSections(options)
  const registered = []
  const disposers = []
  for (const section of sections) {
    const dispose = systemPrompt.section({ name: section.name, order: section.order, text: section.text })
    registered.push(section.name)
    disposers.push(typeof dispose === 'function' ? dispose : () => {})
  }

  const warning = options.tavernReachable === true && registered.length > 0
    ? '检测到上游 Tavern 可达：若它的 pmp-dsh-tavern:profile 仍在注入卡字段，将出现**双重注入**。'
      + '只在确认它已停止注入（或走 v3 的 external 模式）时才启用本开关。'
    : null

  return { ok: true, refusedReason: null, registered, disposers, warning }
}

export default registerCardSections
