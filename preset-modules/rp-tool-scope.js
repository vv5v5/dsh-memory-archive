/**
 * rp-tool-scope —— 把 roleplay preset 的**全局（profile 层）工具面**收窄成白名单。
 *
 * ## 为什么需要它
 * DSH 有两层作用域（`RP-agent-能力设计…md` §6.1）：
 *   · **profile**（`~/.dsh/profiles/web`）= 宿主级、所有会话共用 ⇒ 它挂的插件
 *     （mcp-chrome 29 个工具、glm-bridge 7 个、anima 2 个、state-bridge 5 个…）
 *     **注册进全局工具表**，每个会话都能看见它们 —— 哪怕 preset 里根本没写这些插件。
 *   · **preset** = 会话级 ⇒ 本文件里没写的行，该会话就没有那些工具。
 * ⇒ 所以「preset 里不写」能剔掉编程工具，**剔不掉 profile 层的**。
 *    剔 profile 层只有一条正路：`ctx.tools.restrict()`。
 *
 * ## restrict 的三条性质（`packages/core/tools/src/index.ts`）
 *   1. 按 scope 的过滤器，`allow`＝只留 / `deny`＝只删；多层限制取**交集**（`:1143-1183`）
 *   2. 只过滤该 scope **继承来的**层（global + 祖先 scope），**不过滤本 scope 自己注册的**
 *      —— 但注意：站在 **agent** 的视角看，preset 那一层是「祖先」⇒ 本 preset 注册的
 *      工具**照样会被这个过滤器管到**（`:1130-1139` 的注释就是在讲这个坑）
 *   3. 必须在**有 scope 的 context** 里调（`:1062-1066`）⇒ 只能在 preset/agent 层用。
 *      本行挂在 preset 的常驻挂载上，其 scope key 就是 `{agentPreset:'roleplay'}`，
 *      而该 preset 的每个 agent 都把 scope 认父到它 ⇒ 限制对**且只对**这些 agent 生效。
 *
 * ## 为什么是 `deny` 而不是 `allow`（重要）
 *   `restrict()` 会校验名单里的名字**必须是已知的全局工具**（`:1079-1083`）：
 *   写错一个名字 = 抛错 = **整个 preset 挂载失败 = 会话起不来**。
 *   · 用 `allow: [...]`：名单必须**手写死**，且它会连本 preset 注册的工具一起挡掉。
 *   · 用 `deny: [...]`：名单可以**从运行时真实存在的全局工具算出来**
 *     ⇒ 不依赖硬编码名字；某个插件没挂上也不会炸。
 *   所以：`deny = 全部全局工具 − 想留的`。
 *
 * ## ★ 为什么要监听 `tools/change` 反复重算
 *   `mcp-chrome` 这类插件是**先 `npx` 起子进程、握手完才注册工具**的
 *   ⇒ 它在**开机后若干秒**才出现在全局表里。
 *   如果 preset 的常驻挂载恰好发生在那之前（重启后马上开周目），
 *   一次性算出来的 `deny` 名单里**没有** mcp 工具 ⇒ 它们会**漏进** RP 的工具面，
 *   而且是**静默**漏进去（工具面看着正常，只是多了 36 个）。
 *   `tools/registry` 每次分层变化都会 `emit('tools/change')`（`tools/src/index.ts:804-807`），
 *   所以这里**订阅它重算**：先撤掉上一次的限制，再按最新的全局表重新 apply
 *   —— 既覆盖晚注册，也不会在层上堆积限制。
 *   重入保护：`restrict()` 自己也会触发 `tools/change`（`scope/src/store.ts:262`），
 *   靠 `applying` 标志挡掉递归。
 *
 * ## 失败模式：**绝不抛**
 *   这一行抛异常 = preset 挂不上 = 用户开不了周目。所以整个流程包在 try/catch 里，
 *   出错只**大声写日志并降级**（工具面不收窄），不让会话起不来。
 *
 * @module rp-tool-scope
 */

/** Cordis 插件名。 */
export const name = 'rp-tool-scope'

/** 需要工具注册表。 */
export const inject = ['tools']

/** PTC 模式保留的传输工具名，`deny` 不允许点名它（`tools/src/index.ts:1076-1078`）。 */
const RESERVED_TRANSPORT = 'run_code'

/**
 * 「额外显式点名要留的全局工具」—— 默认空；正常路径走下面那组**模式**。
 *
 * ⚠️ 2026-09-13 曾把这里当作**唯一**白名单并清空，前提是「anima / state-bridge 已从
 *   profile 层迁进本 preset」。那个前提**没落实**（`dsh-anima-rag` 至今仍是 profile bundle）
 *   ⇒ `deny = 全部全局` 把 `anima_query` / `state_patch` 一并挡掉。详见下面那组模式。
 *   现在这里只作「万一要额外豁免某个全局工具」的入口。
 */
const DEFAULT_ALLOW = []

/**
 * ★ 要**留在** RP 工具面里的全局工具 —— 按**名字模式**匹配（2026-09-17 改）。
 *
 * 为什么从「空白名单（deny = 全部全局）」改成模式匹配：
 *   原来那次改动的前提是「anima / state-bridge 已从 profile 层迁进本 preset」——
 *   前提**没落实**：`dsh-anima-rag` 至今还在 `profiles/web/package.json` 的 bundles 里
 *   （`dsh-memory-archive` 同理，state-bridge 就活在它内部）⇒ 它们的工具**还是全局工具**
 *   ⇒ `deny = 全部全局` 把它们一并挡掉。
 *   真机证据：roleplay 会话的 `request/header.tools` 只有 `skill` / `web_search` 两个，
 *   `anima_query` / `state_patch` 全不在 ⇒ 模型根本调不到 `state_patch`，
 *   于是**从来没记过状态**（`state:card` 116 次全 0 字）；模型自己的思维链也写着
 *   「there's no state_patch tool available in my function list」。
 *
 * ★ 为什么用**模式**而不是手写名字：`restrict()` 会校验名单里的名字必须是**已知的全局工具**，
 *   写错一个 = 抛错 = **整个 preset 挂载失败 = 用户开不了周目**。
 *   而 deny 名单本来就是从**运行时真实全局表**里筛出来的 ⇒ 用模式筛**不点名任何工具**，
 *   插件改名字 / 没挂上都不会炸。
 */
const DEFAULT_KEEP_PATTERNS = Object.freeze([
  /^anima_query$/, // 戏内回忆（检索）
  /^memory_write$/, // 剧情笔记写入（★ 只写本会话周目的 .roleplay-memory/，路径由插件夹死）
])
// ★ 2026-09-20：四个 `state_*` 从保留名单里**去掉**了 —— 状态子系统整套剥离
//   （`state-bridge` 子包归档、预设不再挂它）。现在**状态由周目笔记维护**：
//   落在 `<周目>/.roleplay-memory/state.md`，模型用上面的 `memory_write` 写它。
//   ⛔ 别再把 `state_*` 加回保留名单：那些工具已经不存在了。

/**
 * ★ 明确**排除**：维护型/诊断型工具不进 RP 工具面（2026-09-19 用户口径：
 *   「rp 里用不到的插件也过滤掉，比如 anima_status」）。
 * 它们的活是**维护数据库、回滚、排障**，不是扮演 —— 放进工具面只会诱使模型误调，
 * 还白占 schema 预算。
 * ⛔ 这里用**点名**而不是笼统的 `anima_` 前缀排除：保留名单已经逐条点了名，
 *   排除名单只该是"明确知道 RP 不要"的那几个 —— 免得日后新工具一上线就被前缀误伤。
 * （它们仍在**数据库/维护会话**里可用：那里不是 RP 预设。）
 */
const DEFAULT_DROP_PATTERNS = Object.freeze([
  /^anima_ingest$/, // 维护：把归档灌进向量库
  /^anima_forget$/, // 维护：删记忆
  /^anima_status$/, // 诊断：记忆库/索引状态（RP 里查了也没人能读，只会走戏）
])

/**
 * 把调用方 scope 继承来的全局工具收成白名单。
 * @param ctx - preset 常驻挂载的（有 scope 的）context。
 * @param config - `{ allow?: string[]; logSettleMs?: number }`：
 *   `allow` = **额外**要留下的全局工具名（照旧支持；默认空）；
 *   `logSettleMs` = 日志防抖窗口（毫秒，默认 2500；自检台用它把窗口压到毫秒级）。
 */
export function apply(ctx, config) {
  const explicitAllow = Array.isArray(config?.allow) ? config.allow : DEFAULT_ALLOW
  const allow = new Set(explicitAllow)
  /** 该留吗：显式点名 ∪ 命中保留模式，再减去排除模式。 */
  const shouldKeep = (toolName) =>
    allow.has(toolName)
    || (DEFAULT_KEEP_PATTERNS.some((re) => re.test(toolName)) && !DEFAULT_DROP_PATTERNS.some((re) => re.test(toolName)))
  /** 上一次 `restrict()` 返回的撤销函数；重算前必须先撤，否则限制会在层上越堆越多。 */
  let disposePrevious
  /** 重入保护：`restrict()` 自身会 emit `tools/change`。 */
  let applying = false
  /** 上一次收窄后的「结果指纹」：只在结果真的变了时才算一次变动。 */
  let lastSignature = null
  /** 作用域失效后置位：之后不再做任何事。 */
  let stopped = false
  /** `ctx.on()` 返回的摘除函数（`events.ts:288-301`）。 */
  let off = null

  /**
   * ★★ 2026-09-20（真机：「scope 日志又刷屏了」）—— 打印改成**按稳定态防抖**。
   *
   * 起因：原来只按「全局数/挡掉数/白名单」这个**指纹**去重，可是 **MCP 握手时全局表会一条一条地长**
   * （真机实测 `16 → 44` 一路 +1）⇒ 指纹每次都变 ⇒ 光一条 MCP 的握手就能打出几十行。
   * 现在：指纹变了只**重置计时器**，静下来 `logSettleMs` 之后再打**一行**，并带上这段时间里
   * 全局表摆动过的区间与被折叠的变动次数 —— 既不刷屏，也不隐瞒"它到底涨了多少"。
   * ⚠️ 收窄本身**一点没变**（`restrict()` 该调还是马上调）—— 变的只是**什么时候说话**。
   */
  const settleMs = Number.isFinite(config?.logSettleMs) && config.logSettleMs >= 0 ? config.logSettleMs : 2500
  let settleTimer = null
  let pending = null
  let folded = 0
  let lo = 0
  let hi = 0

  /** 把攒着的那一行打出去（稳定之后 / 收工之前各调一次）。 */
  function flushLog() {
    if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null }
    if (pending === null) return
    const p = pending
    pending = null
    const span = folded > 1 && hi > lo ? `（全局表在这 ${folded} 次变动里从 ${lo} 走到 ${hi}）` : ''
    folded = 0
    console.log(
      `[rp-tool-scope] 全局工具 ${p.globals} 个 → 挡掉 ${p.deny} 个`
      + (p.kept.length > 0 ? `（保留 ${p.kept.join(', ')}）` : '（⚠ 一个都没保留 —— 检查上方保留模式是否还匹配得上）')
      + '；本 preset 自己挂的工具不在此列，不受影响' + span,
    )
  }

  /** 记下这次结果，把打印推迟到"静下来"。 */
  function scheduleLog(globalsN, denyN, kept) {
    pending = { globals: globalsN, deny: denyN, kept: kept }
    folded += 1
    if (folded === 1) { lo = globalsN; hi = globalsN } else { if (globalsN < lo) lo = globalsN; if (globalsN > hi) hi = globalsN }
    if (settleTimer !== null) clearTimeout(settleTimer)
    settleTimer = setTimeout(() => { settleTimer = null; flushLog() }, settleMs)
    // ⛔ 别让一个计时器把宿主拖着不退（有 unref 就用）。
    if (settleTimer !== null && typeof settleTimer.unref === 'function') settleTimer.unref()
  }

  /**
   * 本作用域还活着吗。
   *
   * 判据与 cordis 自己一致：`Fiber.assertActive()` 查的就是 `uid !== null`（`fiber.ts:351-354`），
   * 销毁时 `uid` 被置成 `null`（`fiber.ts:268`）。
   *
   * 拿不到 `fiber` 时**返回 true** —— 宁可多收窄一次，也不能因为读不到存活状态就静默放行全部全局工具。
   */
  function scopeAlive() {
    return ctx.fiber?.uid !== null
  }

  /** 认出「作用域已销毁」这一类框架错误（`CordisError.code`，`fiber.ts:157-173`）。 */
  function isInactiveScope(error) {
    const code = error?.code ?? error?.cause?.code
    if (code === 'INACTIVE_EFFECT') return true
    const message = String(error?.message ?? error ?? '')
    return message.includes('inactive context') || message.includes('INACTIVE_EFFECT')
  }

  /** 收工：摘掉监听，之后不再重算。 */
  function stop(reason) {
    if (stopped) return
    stopped = true
    flushLog()   // ★ 攒着的那一行不丢（收工时补打，并且会顺手清掉计时器）
    try {
      off?.()
    } catch {
      // 摘监听失败无所谓：作用域本来就已经没了。
    }
    off = null
    if (reason) console.log(`[rp-tool-scope] ${reason}`)
  }

  function applyRestriction() {
    if (stopped || applying) return
    if (!scopeAlive()) {
      // 作用域没了 ⇒ 挂在它上面的限制也一起没了，此刻既不该也不能再动它。
      stop('作用域已销毁，停止维护工具面收窄（限制随作用域一起消失）')
      return
    }
    applying = true
    try {
      // 不带 scope 的 `schemas()` = **全局视图**（`tools/src/index.ts:1219-1227`），
      // 正好是 restrict 能点名的那个名字集合。
      const globals = ctx.tools.schemas().map((schema) => schema.name)
      const deny = globals.filter((toolName) => !shouldKeep(toolName) && toolName !== RESERVED_TRANSPORT)
      const kept = globals.filter((toolName) => shouldKeep(toolName))
      disposePrevious?.()
      disposePrevious = undefined
      if (deny.length > 0) disposePrevious = ctx.tools.restrict({ deny })
      const signature = `${globals.length}/${deny.length}/${kept.join(',')}`
      if (signature === lastSignature) return
      lastSignature = signature
      // ⚠️ 别报「留下 N 个」—— 那只是**全局工具里**留下的个数，**不是**本会话的工具面。
      //    实测过一次误导：迁移刚做完时它打印「全局工具 37 个 → 留下 0 个（无），挡掉 37 个」，
      //    看着像灾难，而那一轮模型实收的工具是 **7 个**（anima 2 + state-bridge 5）——
      //    它们是本 preset 自己注册的，压根不在 deny 名单里。
      //    ⇒ 日志只报「全局挡了多少」，并明说本 preset 自己的工具不受影响。
      // ★ 2026-09-20：**不在这里直接打**了 —— 交给 `scheduleLog()` 防抖（MCP 逐条握手会连打几十行）。
      scheduleLog(globals.length, deny.length, kept)
    } catch (error) {
      if (isInactiveScope(error)) {
        // 这不是故障：preset 换代 / 会话收尾时作用域先没了，`restrict()` 自然落不下去。
        // 早先没认这一类，抛出去的 `INACTIVE_EFFECT` 会从 emit 里冒到调用方，打断收尾流程。
        stop('作用域已销毁，停止维护工具面收窄（限制随作用域一起消失）')
        return
      }
      // 真故障才降级：不收窄工具面，但**绝不**让 preset 挂载失败（那会让用户开不了周目）。
      console.error('[rp-tool-scope] 收窄全局工具失败，已降级为「不收窄」：', error)
    } finally {
      applying = false
    }
  }

  // 先订阅再收窄：万一首次收窄就发现作用域没了，`stop()` 还来得及把这次订阅摘掉。
  // 订阅是为了兜住晚注册（MCP 起子进程、握完手才注册工具）。
  off = ctx.on('tools/change', applyRestriction)
  applyRestriction()
}
