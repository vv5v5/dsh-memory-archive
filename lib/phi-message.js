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
 * 语义（照抄官方 `time-context` 的写法）：先 `await next()` 拿默认决定，再往 `decision.messages`
 * 末尾**追加** —— 于是它落在**本步请求的消息序列最后**（玩家消息之后）。
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
        const messages = Array.isArray(decision.messages) ? decision.messages : []
        handle.injected += 1
        handle.last = { at: Date.now(), sessionId: sid ?? null, step: payload?.step ?? null, chars: text.length }
        onInjected(typeof sid === 'string' ? sid : '')
        return { ...decision, messages: [...messages, phiUserMessage(text)] }
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
  wrapPhiText, phiUserMessage, shouldInjectPhi, registerPhiMessage,
}
