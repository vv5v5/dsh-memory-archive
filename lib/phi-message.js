/**
 * phi-message —— 把卡的**后处理提示词**（`post_history_instructions`）作为**玩家消息之后的一条注入**
 * 再发一份（2026-09-20 用户拍板：开关**默认开**）。
 *
 * ## 为什么要有它（用户口径）
 *   ST 里它的原生位置是**对话历史之后**；而 DSH 的 system 是一个整块 ⇒ 上游只能近似放进 system 中段
 *   （它自己的诊断 `CHARACTER_PHI_APPROXIMATE` 原话：*not strictly after chat history*）。
 *   我们把它摆到 system **全文最后**（order 10203）—— 但那仍然是"system 的末尾"：请求里它后面紧跟
 *   tools 字段与整段对话历史，离玩家那句话很远。用户要的是**离玩家消息最近**。
 *   DSH 里唯一能到那个位置的通路是 `agent/pre-step` 的 `decision.messages`
 *   （官方 `time-context` / `tmux-context` / 运行上下文快照都走它）——
 *   宿主 `packages/core/agent-loop/src/agent.ts:373-375`：
 *     `session.append('user/message', message, { surfaceOp: 'append' })`。
 *
 * ## 代价（用户已知并接受：「多就多吧，没招了」）
 *   **它进会话日志、是 durable 的**：每轮一份，进历史、也进官方压缩摘要（token 每轮多一份）。
 *   DSH **没有**"只在请求里、不进日志"的通道 —— 请求 = 会话日志的纯函数（它自己的可重建性 Agent Note），
 *   `llm/stream` 那条水位线的请求体是 deep-frozen 的，监听器只能读不能改。
 *
 * ## 清洗（用户口径：「注意做好清洗」）—— 三处，⛔ 缺一不可
 *   ① **在对话历史里给出并标红**（用户 2026-09-20 修正口径，原话：「但这一字段在对话历史里需要给出
 *      并标红」）：⛔ **不隐藏** —— 逐行带 `sourcePlugin`，由面板把那一条标红 + 挂注释
 *      （注释文字见 `lib/client.js` 的 `PM_NOTE_PHI_INJECT`）。同时记得它**不是玩家打的字**
 *      （`playerTyped:false`），计数里归 `injected`；
 *   ② **归档不收录**：`collect-scan.js` 的 `mapRegionToFloors` 不许把 plugin 注入的 user 消息当楼
 *      （⛔ 既不成楼、也不并进前一条楼）——它的正文不该进档案，更不该进摘要与向量库；
 *   ③ **system 里那份不再重复**：注入跑通一次之后，把上游那份 part 的正文清空（段还在、位置还在，
 *      只是不再出第二份正文）⇒ 同一个东西全世界只有一份。
 *   三处判据统一用**结构性的** `source.kind` / `source.plugin`（⛔ 不猜文本前缀、⛔ 不看字数）。
 *
 * @module dsh-memory-archive/phi-message
 * @license CC-BY-NC-4.0
 */

import { randomUUID } from 'node:crypto'

/** 注入来源标识（写进 `message.source.plugin`；查看器/归档两侧都按它认人）。 */
export const PHI_MESSAGE_PLUGIN_ID = 'dsh-memory-archive'

/** `message.source.form`：与官方 `'snapshot'` 同族，标明这是**插件注入的成段文本**。 */
export const PHI_MESSAGE_FORM = 'phi'

/**
 * 注入正文外那层标记。⛔ **必须有**：裸发一段卡作者的指令，模型会把它当成**玩家说的话**
 * （那是角色扮演里最糟的一种误读）。标记只占一行，说明"这是什么、谁发的"。
 */
export const PHI_MESSAGE_MARK = '【角色卡的后处理指令 · 由插件注入，不是玩家发言】'

/**
 * 尾部注入的**交付计划**（纯函数，自检台直测；tavern fork 的 `planRuntimeLoreSurfaceOp` 同款，
 * 2026-09-30 叠加修复——主管简报 / index-state 注脚 / PHI 三处共用）。
 *
 * 返回交给 `session.append('user/message', message, intent)` 的 surface 意图：
 *   · 记着上一轮的 seq、且它**还在当前 surface 上** ⇒ `{ op:'replace', startSeq, endSeq }`
 *     ⇒ **新节点占它的位置、它从请求面消失**（= shadowed；日志一条不删）。
 *   · 否则（首轮 / 那条被压缩掉 / 拿不到 nodes）⇒ `'append'`。
 *     ⚠️ 必须退回 append：replace 的 startSeq/endSeq **必须是当前 surface 上的节点**，
 *     拿一个已被 shadowed 的旧 seq 去 replace 会被宿主拒掉。
 */
export function planTailSurfaceOp({ previousSeq, surfaceNodes } = {}) {
  const nodes = Array.isArray(surfaceNodes) ? surfaceNodes : null
  const replaceable = nodes !== null && Number.isSafeInteger(previousSeq) && nodes.includes(previousSeq)
  return replaceable
    ? { surfaceOp: { op: 'replace', startSeq: previousSeq, endSeq: previousSeq }, sourceEventSeqs: [previousSeq] }
    : { surfaceOp: 'append' }
}

/** 清扫占位消息的 `source.form`（自己认自己；⛔ 不在清扫白名单里 ⇒ 幂等，重跑不会清自己）。 */
export const TAIL_RESIDUE_CLEANUP_FORM = 'tail-residue-cleanup'

/** 清扫占位消息的正文（一个字都不多说：它唯一的职责是占住被回收节点的位置）。 */
export const TAIL_RESIDUE_CLEANUP_MARK = '〔旧注入已回收〕'

/**
 * 清扫占位消息（手术清扫与首楼认领共用；form 不在任何白名单 ⇒ 幂等，重跑/重扫不会碰它）。
 */
export function tailResidueCleanupMessage(newId) {
  return {
    id: typeof newId === 'string' && newId !== '' ? newId : randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: TAIL_RESIDUE_CLEANUP_MARK }],
    source: { kind: 'plugin', plugin: PHI_MESSAGE_PLUGIN_ID, form: TAIL_RESIDUE_CLEANUP_FORM },
  }
}

/**
 * 首楼认领的**底账**（2026-09-30，fork/重启自愈）：注入器在**没有自记 seq** 时（进程首楼 /
 * fork 出来的新会话），从 `session.snapshotEvents()` 读出自己 form 在表面上的最新一条
 * （= 认领目标：本楼交付直接 replace 它，孤儿不再叠加）与更旧的旧节点（= 清扫目标：逐条占位换下）。
 * 拿不到事件 / 表面上没有自己的节点 ⇒ **null**（调用方退回普通 append，⛔ 不编目标）。
 */
export function tailOwnFormState(session, form) {
  try {
    if (!session || typeof form !== 'string' || form === '') return null
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
    if (!Array.isArray(events) || events.length === 0) return null
    const formBySeq = new Map()
    const charsBySeq = new Map()
    for (const ev of events) {
      const msg = ev?.type === 'user/message' ? ev?.data : ev?.data?.message
      const f = msg?.source?.form
      const seq = Number(ev?.seq)
      if (typeof f !== 'string' || f === '' || !Number.isSafeInteger(seq)) continue
      formBySeq.set(seq, f)
      const text = Array.isArray(msg?.content) ? msg.content.map((b) => (b?.type === 'text' ? String(b.text ?? '') : '')).join('') : ''
      charsBySeq.set(seq, text.length)
    }
    if (formBySeq.size === 0) return null
    const nodes = session.surface && Array.isArray(session.surface.nodes)
      ? session.surface.nodes.map(Number).filter(Number.isSafeInteger)
      : []
    if (nodes.length === 0) return null
    const plan = planTailResidueCleanup({ nodes, formBySeq, charsBySeq, forms: [form] })
    return { stale: plan.targets, newest: plan.kept.length > 0 ? plan.kept[plan.kept.length - 1] : null, charsBySeq }
  } catch {
    return null
  }
}

/**
 * 旧注入存量的**清扫计划**（纯函数，自检台直测；2026-09-30 用户拍板的手术清扫）。
 *
 * 背景：修复前的尾部注入已作为真历史事件落盘（真机一个会话 100 条 / ~57.5 万字还在请求面上）；
 * 宿主 surface replace 按**位置区间**遮蔽（`surface.ts` shadowedSeqs = 区间内全部节点），
 * 旧注入与剧情楼交错 ⇒ 区间清扫必然误伤正文。唯一外科做法：**逐条**微型 replace——
 * 每条旧注入节点配一条 ~10 字占位消息占住它的位置，旧文从请求面消失（日志一条不删）。
 *
 * `nodes` = `session.surface.nodes`（**活节点**全集，表面顺序旧→新）；`formBySeq`/`charsBySeq`
 * 由调用方从 `snapshotEvents()` 造（seq → source.form / 正文长度）。每个白名单 form 只保留
 * 最新 `keepPerForm` 条（= 各注入器的活交付），其余全数列为清扫目标。
 * 幂等：占位消息的 form 不在白名单 ⇒ 重跑目标为空。
 */
export function planTailResidueCleanup({ nodes, formBySeq, charsBySeq, forms, keepPerForm = 1 } = {}) {
  const seqs = Array.isArray(nodes) ? nodes.filter((s) => Number.isSafeInteger(s)) : []
  const formOf = formBySeq instanceof Map ? formBySeq : new Map()
  const charsOf = charsBySeq instanceof Map ? charsBySeq : new Map()
  const want = Array.isArray(forms) ? forms : []
  const keep = Number.isSafeInteger(keepPerForm) && keepPerForm >= 0 ? keepPerForm : 1
  const byForm = new Map()
  for (const seq of seqs) {
    const form = formOf.get(seq)
    if (!want.includes(form)) continue
    if (!byForm.has(form)) byForm.set(form, [])
    byForm.get(form).push(seq)
  }
  const targets = []
  const kept = []
  let residueChars = 0
  for (const list of byForm.values()) {
    const cut = Math.max(0, list.length - keep)
    for (const seq of list.slice(0, cut)) {
      targets.push(seq)
      residueChars += Number(charsOf.get(seq) ?? 0)
    }
    // 每组保留的那几条（表面顺序；单 form 场景 kept[0] = 首楼认领的替换目标）
    kept.push(...list.slice(cut))
  }
  return { targets, kept, residueChars }
}

/** 包一层标记（空文本 ⇒ 空串，调用方据此判"这一轮没得注"）。 */
export function wrapPhiText(text) {
  const body = String(text == null ? '' : text).trim()
  if (body === '') return ''
  return PHI_MESSAGE_MARK + '\n' + body
}

/**
 * 造一条 user 消息。
 * 形状与宿主 `createUserMessage` 逐字一致（`{id, role:'user', content, source}`，
 * `createMessage` 只是补一个 `randomUUID()` 再 deepFreeze）——⛔ 不 import 宿主包：
 * 本插件运行时只依赖 cordis 服务，别的一条 `@deepseek-ai/*` 依赖都不引（Tavern 同款做法）。
 */
export function phiUserMessage(text, id) {
  const body = wrapPhiText(text)
  return {
    id: typeof id === 'string' && id !== '' ? id : randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: body }],
    source: { kind: 'plugin', plugin: PHI_MESSAGE_PLUGIN_ID, form: PHI_MESSAGE_FORM },
  }
}

/**
 * 这一轮该不该注入（纯函数，自检台直测）。
 * ⛔ 只在**每轮第 1 步**注（后续步的历史里已经有这一条了）；⛔ 没有正文就不注。
 * ⚠️ **不按内容去重**（用户口径「多就多吧」）：每轮都要有**新的一份落在玩家消息之后** ——
 *   按内容去重的话它只会出现一次，之后位置越漂越远，等于一条普通历史消息（那就白做了）。
 */
export function shouldInjectPhi({ enabled, step, text }) {
  if (enabled !== true) return { inject: false, reason: 'switch-off' }
  if (typeof text !== 'string' || text.trim() === '') return { inject: false, reason: 'no-text' }
  if (step !== 1) return { inject: false, reason: 'not-first-step' }
  return { inject: true, reason: 'ok' }
}

/**
 * 挂 `agent/pre-step`（**顶层 ctx**，与组装捕获同一处；子作用域在真机上收不到 agent 事件）。
 *
 * 语义（照抄官方 `time-context` 的写法）：先 `await next()` 拿默认决定，再把本条摆在**消息序列最后**
 * （玩家消息之后）。
 * ★ 2026-09-30（叠加修复，tavern fork 同款）：优先**直写会话 + surface 替换**
 *   （`session.append('user/message', msg, planTailSurfaceOp(…))`）——记着上一轮自己那条的 seq、
 *   且它还在 surface 上 ⇒ replace（请求面永远只留最新一份，日志一条不删）；
 *   ⛔ 不再往 `decision.messages` 追加（那条路会被 agent-loop 逐条 append 成**新的**历史事件
 *   ⇒ 只加不减、逐楼累积），**只有**拿不到会话 / append 抛错时才退回那条老路
 *   （宁可叠加，也不静默丢内容；退回必须留痕）。
 * ⛔ 任何异常都不许影响这一轮：拿不到/形状不对 ⇒ 原样返回 `next()` 的结果。
 *
 * @param {object} ctx 顶层插件上下文
 * @param {{ getText: (sessionId:string)=>string, isEnabled: ()=>boolean, log?: object }} deps
 */
export function registerPhiMessage(ctx, deps = {}) {
  const getText = typeof deps.getText === 'function' ? deps.getText : () => ''
  const isEnabled = typeof deps.isEnabled === 'function' ? deps.isEnabled : () => false
  const onInjected = typeof deps.onInjected === 'function' ? deps.onInjected : () => {}
  const log = deps.log ?? null
  const handle = { installed: false, reason: 'not-attempted', injected: 0, last: null, lastSkip: null }
  // 上一轮自己那条的 seq（`session.surface.nodes` 只给 seq、认不出是哪条 ⇒ 自己记；仅进程内，不持久化）
  const tailSeqBySession = new Map()
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.on !== 'function') {
    handle.reason = 'no-on'
    return handle
  }
  try {
    ctx.on('agent/pre-step', async (payload, next) => {
      // ⛔ `next()` 的异常照常往外抛：注入通道不得改变组装/步进行为
      const decision = await next()
      try {
        if (decision === null || typeof decision !== 'object' || decision.kind !== 'enter') return decision
        const sid = payload?.agent?.session?.id
        const text = getText(typeof sid === 'string' ? sid : '')
        const v = shouldInjectPhi({ enabled: isEnabled(), step: payload?.step, text })
        if (v.inject !== true) {
          handle.lastSkip = { at: Date.now(), reason: v.reason }
          return decision
        }
        const message = phiUserMessage(text)
        const session = payload?.agent?.session
        let out
        if (session && typeof session.append === 'function') {
          const key = typeof session.id === 'string' && session.id !== '' ? session.id : (typeof sid === 'string' ? sid : '')
          let prev = tailSeqBySession.get(key)
          // ★ 首楼认领（fork/重启自愈，与简报/index 尾注同款）：没有自记 seq ⇒ 自己 form 的最新一条
          //   当替换目标，更旧的逐条占位换下。
          if (!Number.isSafeInteger(prev)) {
            const own = tailOwnFormState(session, PHI_MESSAGE_FORM)
            if (own !== null && (own.stale.length > 0 || own.newest !== null)) {
              for (const stale of own.stale) {
                try {
                  session.append('user/message', tailResidueCleanupMessage(), { surfaceOp: { op: 'replace', startSeq: stale, endSeq: stale }, sourceEventSeqs: [stale] })
                } catch { /* 一条扫不掉就算了 */ }
              }
              if (own.newest !== null) prev = own.newest
              try { console.log('[mt] phi 首楼认领: 换下 ' + own.stale.length + ' 条旧节点 / 认领 seq=' + String(prev)) } catch {}
            }
          }
          try {
            const nodes = session.surface ? session.surface.nodes : null
            const mode = Number.isSafeInteger(prev) && Array.isArray(nodes) && nodes.includes(prev) ? 'replace' : 'append'
            const appended = session.append('user/message', message, planTailSurfaceOp({
              previousSeq: prev,
              surfaceNodes: nodes,
            }))
            if (Number.isSafeInteger(appended?.seq)) tailSeqBySession.set(key, appended.seq)
            try { console.log('[mt] phi 尾部交付: prev=' + String(prev) + ' ⇒ ' + mode + ' seq=' + String(appended?.seq)) } catch {}
            out = decision          // ⛔ 不塞 decision.messages（那条路 = 新增历史事件 = 累积）
          } catch (e) {
            // append 抛错（宿主拒了 replace 之类）⇒ 退回 decision.messages：宁可叠加，也不静默丢内容。
            try { log?.warn?.(`[mt] phi 尾部交付 session.append 失败，退回 decision.messages：${e?.message || e}`) } catch {}
            const messages = Array.isArray(decision.messages) ? decision.messages : []
            out = { ...decision, messages: [...messages, message] }
          }
        } else {
          try { log?.warn?.('[mt] phi 拿不到 session.append ⇒ 退回 decision.messages（本轮叠加）') } catch {}
          const messages = Array.isArray(decision.messages) ? decision.messages : []
          out = { ...decision, messages: [...messages, message] }
        }
        handle.injected += 1
        handle.last = { at: Date.now(), sessionId: sid ?? null, step: payload?.step ?? null, chars: text.length }
        onInjected(typeof sid === 'string' ? sid : '')
        return out
      } catch {
        return decision
      }
    }, { prepend: true })
    handle.installed = true
    handle.reason = 'ok'
  } catch (e) {
    handle.reason = 'install-failed'
    try { log?.warn?.(`[mt] 后处理提示词注入接线失败（已降级）：${e?.message || e}`) } catch {}
  }
  return handle
}

export default {
  PHI_MESSAGE_PLUGIN_ID, PHI_MESSAGE_FORM, PHI_MESSAGE_MARK,
  wrapPhiText, phiUserMessage, shouldInjectPhi, planTailSurfaceOp,
  TAIL_RESIDUE_CLEANUP_FORM, TAIL_RESIDUE_CLEANUP_MARK, tailResidueCleanupMessage, planTailResidueCleanup, tailOwnFormState, registerPhiMessage,
}
