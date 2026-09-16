/**
 * dsh-state-bridge —— 角色状态记账 + 注入。
 *
 * 记账只有**一条**路：每轮由主模型在思维链里直接调用 `state_patch` 工具提交增量补丁。
 * 白名单合并 / 配额护栏 / 公式重算 / 到期解除全部由代码独占（`commitPatch` 是唯一的合并落盘路径）。
 * 每 turn/end 只做**事后可见校验**（`requirePatchPerTurn`，不阻塞），不改状态、不调任何模型。
 *
 * ## 它补的是哪一块
 *
 * 闭环四段里 ②注入 / ③渲染 / ④分支回滚 生态里都有现成件，**只有 ①「每轮增量重算角色状态」
 * 是缺口**（两次独立核实：3408 插件关键词搜索命中 0；GLM 35 个候选的 README 级选型）。
 * 本插件只写这一块，其余复用。
 *
 * ## 挂点与依据
 *
 * | 钩子 | 位置 | 为什么 |
 * |---|---|---|
 * | `session/event` 过滤 `turn/end` | `session/src/index.ts:74`；`turn/end` 声明 `session/src/types.ts:224-232` | **唯一覆盖全部收尾原因**的钩子（completed/blocked/error/abort 都走 `finally`，`agent-loop/src/agent.ts:325-331`）。fire-and-forget，**监听器内不能同步 `session.append`**（`session/src/index.ts:622-624`）—— 我们只写文件，规避 |
 * | `systemPrompt.section()` | `system-prompt/src/index.ts:432` | 每次装配求值（`:583`）→ 状态永远在场。**provider 同步**，只能返回缓存值 |
 * | `'system-prompt/assemble'` | `system-prompt/src/index.ts:19-31, 601-604` | async、返回值权威 → 有界 await 后**改写 `assembly.sections`** |
 *
 * ⚠️ **不使用** `agent/pre-step`：它改写的 `messages` 会被 `agent.ts:291-293` 逐条
 * `session.append('user/message', …)` —— 那是**写历史**，用它注入会把状态每轮累积进历史。
 *
 * ⚠️ **不新增 session 事件类型**（见 `store.js` 顶部说明）。
 */
import { changeSchema, allowedChangeKeys, KNOWLEDGE, NEG_BOOL } from './schema.js'
import { normalizeStatus, mergeStatus, diffMechanics, enforceDerivedValues, clone } from './state.js'
import { sweepExpired } from './expiry.js'
import { renderStateCard, estimateTokens } from './render.js'
import {
  stateRoot, readState, writeState, readBaseline, writeBaseline, appendHistory,
  appendAudit, appendFailure, listSessions, purgeSession, ensureDir,
} from './store.js'

export const name = 'dsh-state-bridge'
export const inject = ['tools', 'systemPrompt']

const VERSION = '0.2.0'
const SECTION_NAME = 'state:card'

const DEFAULTS = {
  /** 总开关。关掉后钩子仍注册但不做任何事。 */
  enabled: true,
  /**
   * 每轮事后校验：turn/end 检查该轮**有没有** state_patch 调用，
   * 没有则把「⚠️ 上一轮未记录状态」写进下一轮注入文本的 ⚠ 区（可见化，不阻塞、不改状态本体）。默认 true。
   */
  requirePatchPerTurn: true,
  /**
   * 单轮新增机制条目配额。超过则**整轮拒收**并留痕。
   * 治用户痛点「角色吓了一跳，他记了临时恐惧」—— 阈值触发人工复核，不是判定对错。0 = 关闭。
   */
  maxNewMechanicsPerTurn: 2,
  /**
   * 装配期门闩的等待预算（毫秒）。记账现在完全由主模型在生成过程中同步调用 `state_patch` 完成 ——
   * 生成结束前状态已落盘，装配期**没有**任何在途后台记账可等，所以本项当前恒为直通；
   * 保留它是为了配置接口稳定（`gateTimeoutMs: 8000` 与 0 行为一致，都绝不阻塞主对话）。
   */
  gateTimeoutMs: 8000,
  /** 注入文本在 system prompt 里的排序位（DSH Tavern 用 10 和 45，我们排在它们之后）。 */
  injectionOrder: 50,
  /** 本轮的增量文本上限（字）。 */
  deltaMaxChars: 6000,
  /** 只接管这些 sessionId；为空 = 接管所有**已 seed** 的会话。 */
  sessionAllowlist: [],
  /** 存储根目录；留空 = <DSH_HOME>/l1-state。 */
  storageDir: '',
  /** 是否把 `summary`（主模型的变更依据自述）也注入（可见化，治"无中生有"）。 */
  injectSummary: true,
}

const log = (ctx, ...a) => ctx?.logger?.info?.(`[state-bridge]`, ...a)
const warn = (ctx, ...a) => ctx?.logger?.warn?.(`[state-bridge]`, ...a)

export function apply(ctx, rawConfig) {
  const cfg = { ...DEFAULTS, ...(rawConfig ?? ctx?.config ?? {}) }
  const root = stateRoot({ dir: cfg.storageDir })
  ensureDir(root)

  /** sessionId → 最近一次渲染好的文本（provider 必须同步返回，所以只读内存/文件） */
  const cache = new Map()
  /** sessionId → 在途后台记账任务。**恒空** —— 记账已无任何后台路径（见下方装配期门闩）。 */
  const inflight = new Map()
  /** sessionId → 自上次 turn/end 起主模型有没有调用过 state_patch（事后校验用） */
  const patchSeen = new Map()

  /**
   * 随状态卡注入的「记账方式」提示 —— 主模型每轮都能看到自己的调用契约。
   */
  const PATCH_TOOL_HINT =
    '每轮回复结束前调用 state_patch 提交本轮状态增量：patch 只写有变化的键；本轮确实无变化就传 {}'
    + '（合法答案，不要硬凑）。新增 状态栏/技能修正/临时恐惧 条目必须在 summary 里给出依据（哪一句/哪次掷骰）；'
    + '带时限的条目写成 { 效果, 到期: "YYYY/MM/DD", 依据 }，到期由代码自动解除，不要自己删。'

  // ─────────────────────────────────────── 缓存与渲染

  function loadDoc(sessionId) {
    if (cache.has(sessionId)) return cache.get(sessionId)
    const doc = readState(root, sessionId)
    cache.set(sessionId, doc)
    return doc
  }

  function isTracked(sessionId) {
    if (cfg.sessionAllowlist?.length) return cfg.sessionAllowlist.includes(sessionId)
    const doc = loadDoc(sessionId)
    if (doc?.state) return true
    return Boolean(readBaseline(root, sessionId))
  }

  /**
   * 渲染注入文本。**纯同步** —— 它会被 section 的 provider 每轮调用。
   * @param turn 可选：当前 turn（用于卡片头"DSH 第 N 轮"）
   */
  function renderFor(sessionId, turn) {
    const doc = loadDoc(sessionId)
    if (!doc?.state) return ''
    const state = normalizeStatus(doc.state)
    const sweep = sweepExpired(state, { today: state.时间?.日期, phase: state.时间?.阶段 })
    return renderStateCard(state, {
      turn: turn ?? doc.anchor?.turn ?? null,
      expired: doc.lastExpired ?? sweep.expired,
      pending: doc.lastPending?.length ? doc.lastPending : sweep.pending,
      unparseable: sweep.unparseable,
      diff: doc.lastDiff ?? null,
      summary: cfg.injectSummary ? (doc.lastSummary ?? '') : '',
      warnings: doc.lastWarnings ?? [],
      usageHint: PATCH_TOOL_HINT,
    })
  }

  /** 取当前会话的 turn（读 turnBoundary 投影；拿不到返回 null）。 */
  function observedTurnFor(session) {
    try {
      const b = ctx.sessionProjections?.stateOf?.(session, 'turnBoundary')
      return typeof b?.lastTurn === 'number' ? b.lastTurn : null
    } catch { return null }
  }

  function eventsOf(session) {
    const e = session?.events
    return Array.isArray(e) ? e : []
  }

  // ─────────────────────────────────────── 合并与落盘（核心）

  /** 失败：保留旧状态，但把"失败"写进注入文本（失败可见化）。 */
  function writeFailure(sessionId, doc, turn, message) {
    warn(ctx, message)
    if (!doc?.state) return { ok: false, reason: 'no-state-to-keep', message }
    appendHistory(root, sessionId, { turn, at: new Date().toISOString(), failed: true, message })
    writeState(root, sessionId, {
      anchor: doc.anchor,
      state: doc.state,
      render: doc.render ?? null,
      summary: doc.lastSummary ?? '',
      expired: doc.lastExpired ?? [],
      pending: doc.lastPending ?? [],
      warnings: [...(doc.lastWarnings ?? []), `⚠ ${message}`].slice(-4),
      guard: doc.lastGuard ?? null,
      diff: null,   // 本轮没有成功变更，[✎] 一节应当消失
    })
    cache.delete(sessionId)
    return { ok: false, reason: 'kept-old-state', message }
  }

  /**
   * ★ 唯一的合并/落盘路径：主模型的 `state_patch` 工具只从这里过。
   * 白名单校验合并（mergeStatus）、配额护栏、公式重算（enforceDerivedValues）、
   * 到期解除（sweepExpired）、变更可见化（diffMechanics）全部只此一份 —— 任何入口都不许绕过、不许另写。
   *
   * @param opts.doc    落盘的当前状态记录（readState 的结果）
   * @param opts.from   合并基座（工具传 doc.state）
   * @param opts.prev   diff 基线（可见化用，工具传 doc.state）
   * @param opts.patch  增量补丁（只描述有变化的键）
   * @param opts.summary 变更依据自述（注入 ✎ 节 + 审计）
   * @param opts.turn/seq  锚点（活会话缺失时会传已落盘锚点兜底）
   * @returns ok=true 带 { turn, expired, diff, warnings, chars }；ok=false 带 { rejected?, reason, message }
   */
  function commitPatch(sessionId, { doc, from, prev, patch, summary = '', turn = null, seq = null, source = 'unknown' }) {
    const base = from ?? doc?.state
    if (!base) return { ok: false, reason: 'no-state', message: '该会话还没有状态（先 state_seed）' }
    const prevStatus = prev ?? base

    // 白名单校验合并 + 配额护栏（超限整轮拒收，保留旧状态）
    const merged = mergeStatus(base, patch, { maxNewMechanicsPerTurn: cfg.maxNewMechanicsPerTurn })
    if (merged.rejected) {
      appendFailure(root, sessionId, { kind: 'guard', turn, guard: merged.guard, summary })
      const message = `本轮新增机制条目 ${merged.guard.total} 条 > 上限 ${merged.guard.limit}，整轮拒收（保留旧状态）`
      writeFailure(sessionId, doc, turn, message)
      return { ok: false, rejected: true, reason: 'guard', message, guard: merged.guard }
    }
    if (merged.errs.length) appendFailure(root, sessionId, { kind: 'constraint', turn, errs: merged.errs })

    // 代码重算可推导的值（知识级/IP、密氛下限），再由代码拥有到期解除
    const derived = enforceDerivedValues(merged.status)
    const sweep = sweepExpired(derived.status, { today: derived.status.时间?.日期, phase: derived.status.时间?.阶段 })
    for (const e of sweep.expired) appendAudit(root, sessionId, { kind: 'expired', turn, ...e })

    const diff = diffMechanics(prevStatus, derived.status)
    const guard = { ...merged.guard, rejected: false }
    derived.status.元 = { ...(derived.status.元 ?? {}), 锚点: turn ?? null, 更新于: new Date().toISOString() }

    const warnings = merged.errs.length ? [`本轮约束纠正：${merged.errs.join('；')}`] : []
    const text = renderStateCard(derived.status, {
      turn, expired: sweep.expired, pending: sweep.pending, unparseable: sweep.unparseable,
      diff, summary: cfg.injectSummary ? summary : '', warnings,
    })

    writeState(root, sessionId, {
      anchor: { turn, seq, at: new Date().toISOString() },
      state: derived.status,
      render: { chars: text.length, tokens: estimateTokens(text) },
      summary, expired: sweep.expired, pending: sweep.pending,
      warnings, guard, diff,
    })
    appendHistory(root, sessionId, { turn, seq, at: new Date().toISOString(), source, state: derived.status })
    cache.delete(sessionId)   // 下次注入从磁盘重读
    return { ok: true, turn, expired: sweep.expired.length, diff, warnings, chars: text.length }
  }

  // ─────────────────────────────── patch-tool 模式：每轮事后校验（可见化，不阻塞）

  /** 警告行的判定标记：state_patch 成功提交后按它把旧警告从 ⚠ 区摘掉，任何时刻至多一条。 */
  const PATCH_MISS_MARK = '上一轮未记录状态'

  /**
   * 该轮没有 state_patch 调用 → 把「⚠️ 上一轮未记录状态」写进注入文本（照"失败可见化"风格）。
   * 只改 warnings，不动状态本体、不写 failed 历史、绝不阻塞 —— 校验是给人看得见的，不是闸门。
   */
  function markPatchMiss(sessionId, turn) {
    try {
      const doc = readState(root, sessionId)
      if (!doc?.state) return
      const msg = `⚠️ ${PATCH_MISS_MARK}：第 ${turn ?? '?'} 轮主模型未调用 state_patch，注入的仍是第 ${doc.anchor?.turn ?? '?'} 轮的旧状态`
      const kept = (doc.lastWarnings ?? []).filter(w => !String(w).includes(PATCH_MISS_MARK))
      writeState(root, sessionId, {
        anchor: doc.anchor, state: doc.state, render: doc.render ?? null,
        summary: doc.lastSummary ?? '', expired: doc.lastExpired ?? [], pending: doc.lastPending ?? [],
        warnings: [...kept, msg].slice(-4), guard: doc.lastGuard ?? null, diff: doc.lastDiff ?? null,
      })
      cache.delete(sessionId)
      warn(ctx, msg)
    } catch (e) {
      warn(ctx, 'patch-miss 标记异常', e?.message ?? String(e))
    }
  }

  /** 当前状态的人可读简摘（只含数值/计数，给模型与人快速核对用）。 */
  function stateBrief(status) {
    const s = normalizeStatus(status)
    const neg = s.负面状态 ?? {}
    const flags = NEG_BOOL.filter(k => neg[k] === true)
    const knSum = KNOWLEDGE.reduce((acc, k) => acc + (s.知识?.[k]?.级 ?? 0), 0)
    return [
      `日期 ${s.时间?.日期 || '?'}`,
      `躯体 ${s.基本?.躯体?.当前 ?? '?'}/${s.基本?.躯体?.上限 ?? '?'}`,
      `密氛 ${s.基本?.密氛?.当前 ?? '?'}/${s.基本?.密氛?.上限 ?? '?'}`,
      `恐惧 ${neg.恐惧 ?? 0}`,
      `布尔位 ${flags.length ? flags.join('/') : '无'}`,
      `状态栏 ${Object.keys(s.状态栏 ?? {}).length}`,
      `技能修正 ${Object.keys(s.技能修正 ?? {}).length}`,
      `物品栏 ${Object.keys(s.物品栏 ?? {}).length}`,
      `知识等级和 ${knSum}`,
    ].join('｜')
  }

  // ─────────────────────────────────────── 钩子 ①：turn/end → 每轮事后可见校验

  /**
   * ⚠️ 这里**不能** await，也**不能**同步 session.append（会重入 throw）。
   * 本监听器只读事件、只写状态文件，所以安全。
   */
  ctx.on('session/event', (session, event) => {
    try {
      if (!cfg.enabled) return
      if (event?.type !== 'turn/end') return
      const sessionId = session?.id
      if (!sessionId || !isTracked(sessionId)) return

      // 主模型负责记账，这里只做**事后可见校验**：不阻塞、不改状态本体、不调任何模型
      const hadPatch = patchSeen.get(sessionId) === true
      patchSeen.set(sessionId, false)
      if (hadPatch) return
      if (cfg.requirePatchPerTurn) markPatchMiss(sessionId, observedTurnFor(session))
    } catch (e) {
      warn(ctx, 'session/event 监听异常', e?.message ?? String(e))
    }
  })

  // ─────────────────────────────────────── 钩子 ②：注入（同步 provider）

  const sectionDispose = ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: cfg.injectionOrder,
    text: (context) => {
      try {
        if (!cfg.enabled) return ''
        const agent = context?.agent
        if (!agent?.id) return ''
        return renderFor(agent.id, observedTurnFor(agent.session))
      } catch (e) {
        warn(ctx, 'section provider 异常', e?.message ?? String(e))
        return ''
      }
    },
  })
  ctx.effect?.(() => sectionDispose)

  // ─────────────────────────────────────── 钩子 ③：装配期（直通，绝不阻塞）

  /**
   * ⚠️ 关键顺序事实（源码验证）：`system-prompt/src/index.ts:590-599` 先求值 section provider，
   * `:601-604` 才跑这个 waterfall。所以在这里 await **不会**让 provider 拿到新值 ——
   * 必须**自己改写 `assembly.sections`**。
   *
   * 记账由主模型在生成过程中直接 `state_patch` 完成，装配期已无任何在途后台任务可等（`inflight` 恒空），
   * 因此这里退化为直通：立刻用最新落盘状态重渲染一次注入段，**不留任何等待**。
   */
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const out = await next()
    try {
      if (!cfg.enabled) return out
      const sessionId = context?.agent?.id
      if (!sessionId) return out
      const task = inflight.get(sessionId)
      if (task) {
        // 兜底路径已不存在；保留这段只为万一将来出现真正在途的任务时有界等待，超时即放行
        await Promise.race([
          Promise.resolve(task.promise ?? null).catch(() => {}),
          new Promise(r => setTimeout(r, cfg.gateTimeoutMs)),
        ])
      }

      const turn = observedTurnFor(context.agent.session)
      const fresh = renderFor(sessionId, turn)
      if (!fresh) return out
      const sections = (out.sections ?? []).map(s => (s.name === SECTION_NAME ? { ...s, text: fresh } : s))
      if (!sections.some(s => s.name === SECTION_NAME)) sections.push({ name: SECTION_NAME, order: cfg.injectionOrder, text: fresh })
      return { ...out, sections }
    } catch (e) {
      warn(ctx, 'assemble 注入段刷新异常', e?.message ?? String(e))
      return out
    }
  })

  // ─────────────────────────────────────── 宿主级工具（给人 / 给我用，RP 模式外）

  const ok = (v) => v

  ctx.tools.register({
    name: 'state_list',
    description: '列出被状态插件接管过的会话（状态插件 = 主模型每轮调 state_patch 记账）。含是否已 seed、锚点轮次、状态日期。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object', additionalProperties: false, required: ['storageRoot', 'count', 'sessions'],
        properties: {
          storageRoot: { type: 'string' },
          count: { type: 'integer' },
          sessions: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['sessionId', 'seeded', 'hasState'],
              properties: {
                sessionId: { type: 'string' }, seeded: { type: 'boolean' }, hasState: { type: 'boolean' },
                anchorTurn: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                stateDate: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                updatedAt: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              },
            },
          },
        },
      },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute() {
      const sessions = listSessions(root).map(s => ({
        sessionId: s.sessionId, seeded: s.seeded, hasState: s.hasState,
        anchorTurn: s.anchorTurn ?? null, stateDate: s.stateDate ?? null, updatedAt: s.updatedAt ?? null,
      }))
      return ok({ storageRoot: root, count: sessions.length, sessions })
    },
  })

  ctx.tools.register({
    name: 'state_show',
    description: '看某个会话的当前状态、状态卡渲染文本、最近失败与审计（**不返回审计里的正文**，只给计数）。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['session_id'],
      properties: { session_id: { type: 'string' }, include_card: { type: 'boolean' } },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        required: ['sessionId', 'tracked', 'chars', 'tokens', 'failures'],
        properties: {
          sessionId: { type: 'string' }, tracked: { type: 'boolean' },
          chars: { type: 'integer' }, tokens: { type: 'integer' },
          anchorTurn: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          stateDate: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          lastSummary: { type: 'string' },
          card: { type: 'string' },
          failures: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.card || JSON.stringify(v, null, 2) }],
    },
    async execute(args) {
      const sessionId = String(args.session_id)
      const doc = readState(root, sessionId)
      const card = args.include_card === false ? '' : (renderFor(sessionId, doc?.anchor?.turn ?? null) || '(无状态)')
      return {
        sessionId,
        tracked: Boolean(doc?.state) || Boolean(readBaseline(root, sessionId)),
        chars: card.length, tokens: estimateTokens(card),
        anchorTurn: doc?.anchor?.turn ?? null,
        stateDate: doc?.state?.时间?.日期 ?? null,
        lastSummary: doc?.lastSummary ?? '',
        card,
        failures: (doc?.lastWarnings ?? []).map(String),
      }
    },
  })

  ctx.tools.register({
    name: 'state_seed',
    description:
      '给某个会话设起跑线状态（**只有 seed 过的会话才会被状态插件接管**）。'
      + '可从文件读，也可直接给 JSON 对象。不会覆盖已有状态，除非 overwrite=true。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['session_id'],
      properties: {
        session_id: { type: 'string' },
        from_file: { type: 'string', description: 'JSON 文件路径（其 state 字段或整个对象作为状态）' },
        state: { type: 'object', description: '直接给状态对象（与 from_file 二选一）' },
        overwrite: { type: 'boolean' },
        note: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        required: ['sessionId', 'seeded', 'chars'],
        properties: {
          sessionId: { type: 'string' }, seeded: { type: 'boolean' }, chars: { type: 'integer' },
          note: { type: 'string' }, error: { type: 'string' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args) {
      const sessionId = String(args.session_id)
      const existing = readState(root, sessionId)
      if (existing?.state && args.overwrite !== true) {
        return { sessionId, seeded: false, chars: 0, error: '已有状态，需 overwrite=true 才能覆盖' }
      }
      let state = args.state ?? null
      let src = 'inline'
      if (!state && args.from_file) {
        const { readFileSync } = await import('node:fs')
        const raw = JSON.parse(readFileSync(String(args.from_file), 'utf8'))
        state = raw?.state ?? raw
        src = String(args.from_file)
      }
      if (!state || typeof state !== 'object') {
        return { sessionId, seeded: false, chars: 0, error: '必须给 state 或 from_file' }
      }
      const normalized = normalizeStatus(clone(state))
      writeBaseline(root, sessionId, { state: normalized, source: src, note: args.note ?? '' })
      writeState(root, sessionId, { anchor: { turn: null, seq: null, at: new Date().toISOString() }, state: normalized, warnings: [] })
      appendHistory(root, sessionId, { turn: 0, at: new Date().toISOString(), source: 'seed', state: normalized })
      appendAudit(root, sessionId, { kind: 'seed', source: src })
      cache.delete(sessionId)
      const card = renderFor(sessionId, null)
      return { sessionId, seeded: true, chars: card.length, note: `已 seed（来源 ${src}）；此后该会话的 turn/end 会被记账` }
    },
  })

  // ─────────────────────────────────────── 主模型写入口：state_patch（patch-tool 模式的主路径）

  /** 从 state_patch 入参里定目标会话：显式 session_id > 唯一活动会话。定不了返回 null。 */
  function resolvePatchSession(args) {
    const asked = String(args?.session_id ?? '').trim()
    if (asked) return asked
    try {
      const ids = [...new Set((ctx.agents?.list?.() ?? []).filter(a => a?.id && a?.session).map(a => a.id))]
      if (ids.length === 1) return ids[0]
    } catch { /* ignore */ }
    return null
  }

  /** state_patch 的 turn/seq 取法：优先活会话的投影与事件流，退回已落盘锚点（离线场景可审计可回放）。 */
  function patchTurnSeq(sessionId, doc) {
    try {
      const live = (ctx.agents?.list?.() ?? []).find(a => a?.id === sessionId)
      if (live?.session) {
        const events = eventsOf(live.session)
        return {
          turn: observedTurnFor(live.session) ?? doc?.anchor?.turn ?? null,
          seq: events.length ? events[events.length - 1].seq : (doc?.anchor?.seq ?? null),
        }
      }
    } catch { /* ignore */ }
    return { turn: doc?.anchor?.turn ?? null, seq: doc?.anchor?.seq ?? null }
  }

  ctx.tools.register({
    name: 'state_patch',
    description:
      '【状态记账·每轮必做】把本轮对话**实际发生**的角色状态变化，以增量补丁并入当前状态（跑团状态闭环的第①环）。'
      + 'patch 只写有变化的键，根键结构：元/时间/基本/负面状态/技能/技能修正/知识/技艺/物品栏/秘史物品/特质/别称/血欲期/状态栏；'
      + '未变化的键一律省略 = 保留现值；本轮确实无事发生时 patch 传 {}（合法答案，禁止为了交差硬凑条目）。'
      + '自由容器（状态栏/物品栏/技能修正/特质等）删键把值设为 null。'
      + '只录入已实际结算的机制效果（有掷骰/明确扣减/明确裁定）；纯情绪、心理描写不记。'
      + '带时限的条目写成 { 效果, 到期: "YYYY/MM/DD", 依据 } —— 到期由代码自动解除，你不要自己删。'
      + '合并、白名单校验、配额护栏全部由代码执行：非法键或超配额会被整轮拒收，返回值会说明原因与当前状态简摘。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['patch'],
      properties: {
        session_id: { type: 'string', description: '目标会话；缺省且恰有一个活动会话时自动选定' },
        patch: changeSchema(),
        summary: { type: 'string', maxLength: 400, description: '本轮状态变更的依据说明（对话中的哪一句 / 哪次掷骰）' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        required: ['sessionId', 'ok', 'changed', 'message', 'brief'],
        properties: {
          sessionId: { type: 'string' },
          ok: { type: 'boolean' },
          changed: { type: 'boolean' },
          rejected: { type: 'boolean' },
          turn: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          added: { type: 'integer' },
          removed: { type: 'integer' },
          expired: { type: 'integer' },
          guardTotal: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          guardLimit: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          errs: { type: 'array', items: { type: 'string' } },
          message: { type: 'string' },
          brief: { type: 'string' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: `${v.message}\n当前状态简摘：${v.brief}` }],
    },
    async execute(args) {
      const finish = (sessionId, extra) => ({
        sessionId, ok: false, changed: false, rejected: false, turn: null,
        added: 0, removed: 0, expired: 0, guardTotal: null, guardLimit: null, errs: [], ...extra,
      })
      const patch = args?.patch
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return finish('', { rejected: true, message: 'patch 必须是对象（本轮无变化就传 {}）', brief: '' })
      }
      const sessionId = resolvePatchSession(args)
      if (!sessionId) {
        return finish('', { rejected: true, message: '无法确定目标会话：请显式传 session_id（或确保当前恰有一个活动会话）', brief: '' })
      }
      const doc = readState(root, sessionId)
      if (!isTracked(sessionId) || !doc?.state) {
        return finish(sessionId, { rejected: true, message: '该会话还没被状态插件接管：先 state_seed 设起跑线，之后才能 state_patch', brief: '' })
      }

      const { turn, seq } = patchTurnSeq(sessionId, doc)
      // 从这里起任何 state_patch 尝试都算"本轮履行过记账义务"（成败另说；失败有自己的可见化渠道）
      patchSeen.set(sessionId, true)

      // 白名单根键校验：合并层之外的键在门口**显式拒收**（而不是静默丢弃），状态原样不动
      const allowed = allowedChangeKeys()
      const illegal = Object.keys(patch).filter(k => !allowed.includes(k))
      if (illegal.length) {
        appendFailure(root, sessionId, { kind: 'schema', turn, illegal })
        return finish(sessionId, { rejected: true, turn,
          message: `patch 含白名单之外的根键：${illegal.join('、')}（合法键：${allowed.join('/')}）。本轮拒收，状态未改动`, brief: stateBrief(doc.state) })
      }

      // 空补丁 = 恒等变换：确认收到即可，不写盘、不动锚点
      if (Object.keys(patch).length === 0) {
        appendAudit(root, sessionId, { reason: 'patch-tool', turn, mode: 'patch-tool', ok: true, patch: '{}', summary: args.summary ?? '', deltaChars: 0 })
        return finish(sessionId, { ok: true, changed: false, turn,
          message: '本轮无状态变化（空补丁 {}，恒等确认，未改任何数据）', brief: stateBrief(doc.state) })
      }

      // ★ 走唯一的合并路径 commitPatch（白名单合并/护栏/公式重算/到期解除），不另写一套
      const done = commitPatch(sessionId, {
        doc, from: doc.state, prev: doc.state, patch,
        summary: args.summary ?? '', turn, seq, source: 'patch-tool',
      })
      if (!done.ok) {
        return finish(sessionId, { rejected: done.rejected === true, turn,
          guardTotal: done.guard?.total ?? null, guardLimit: done.guard?.limit ?? null,
          message: done.message, brief: stateBrief(doc.state) })
      }
      appendAudit(root, sessionId, { reason: 'patch-tool', turn, mode: 'patch-tool', ok: true,
        patch: JSON.stringify(patch).slice(0, 4000), summary: args.summary ?? '', deltaChars: 0 })
      return finish(sessionId, { ok: true, changed: true, turn,
        added: done.diff.added.length, removed: done.diff.removed.length, expired: done.expired, errs: done.warnings,
        message: `已并入状态（第 ${turn ?? '?'} 轮）：新增 ${done.diff.added.length}、移除 ${done.diff.removed.length}、自动解除 ${done.expired} 条`
          + (done.warnings.length ? `；约束纠正：${done.warnings.join('；')}` : ''),
        brief: stateBrief(readState(root, sessionId)?.state ?? doc.state) })
    },
  })

  ctx.tools.register({
    name: 'state_purge',
    description: '清掉某个会话的全部状态插件产物（state/history/audit/failures/baseline）。不可逆，用于回滚。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['session_id'],
      properties: { session_id: { type: 'string' } },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false, required: ['sessionId', 'removed'],
        properties: { sessionId: { type: 'string' }, removed: { type: 'integer' } },
      },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args) {
      const sessionId = String(args.session_id)
      const removed = purgeSession(root, sessionId)
      cache.delete(sessionId)
      return { sessionId, removed }
    },
  })

  log(ctx, `${VERSION} ready — root=${root} requirePatch=${cfg.requirePatchPerTurn} 配额=${cfg.maxNewMechanicsPerTurn}`)
}

export const config = { ...DEFAULTS }
export const version = VERSION
