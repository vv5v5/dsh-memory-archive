/**
 * 「开机即挂会排到上游」的通用解法 —— **延迟挂载 + 哨兵退位**。
 *
 * ## 问题（2026-09-17 两处实测撞到同一件事）
 * cordis 的**瀑布事件按监听注册顺序跑**。而我们插件顶层只 `inject = ['skills']`，
 * Tavern 是 `['systemPrompt','sessionController','workspaceController','directoryPickerController']`，
 * anima 之类也要等它们各自的服务 ⇒ **它们激活更晚、注册更晚 ⇒ 我们开机即挂的监听永远排在最上游**。
 * 后果实测：
 *   · `mt:postHistory` 的 PHI 去重（T7）**一个 `:part:` 段都看不见**（Tavern 还没展开）；
 *   · 组装捕获抓到的是**注入前的半成品** —— `anima:memory` / 世界书是**在下游 await 检索后
 *     改写 `out.sections`** 加进去的，我们抓不到 ⇒ `renderedChars/renderedHash` 与最终系统消息对不上
 *     ⇒ 查看器"点开看正文"永远 `slice-mismatch`（"内容不可用（校验未通过）"）。
 *
 * ## 解法
 * 第一个 `session/event` 时**追加**一份真正干活的监听。那一刻所有插件都已激活并注册完
 * （会话事件一定在插件激活之后），所以新追加的排在最后 = **下游**；
 * 它又一定在**本轮装配之前**（`agent/inbox/spliced` 就在装配前）⇒ **不漏首轮**。
 *
 * ## 为什么要"哨兵退位"而不是干脆晚点挂
 * 万一某个宿主**从不派发** `session/event`，晚挂就等于**这个功能静默消失**（比排在上游更糟）。
 * 所以做法是：**开机先挂一个哨兵**（老行为），在第一个会话事件时再追加真正那个；
 * 哨兵一旦发现"真正那个已就位"就**只透传**（`next()`），不再重复干活。
 *   · 有会话事件 ⇒ 干活的是下游版（正确）；哨兵空转。
 *   · 没有会话事件 ⇒ 哨兵继续干活（退化成老行为，⛔ 不静默失效）。
 *
 * @module dsh-memory-archive/deferred-install
 * @license CC-BY-NC-4.0
 */

export const DEFERRED_INSTALL_VERSION = 1

/**
 * 给某个瀑布事件挂一个"延迟到下游"的监听。
 *
 * @param {object} o
 * @param {(event:string, listener:Function) => any} o.on - 注册函数（`scope.on` / `ctx.on`）
 * @param {Function} o.run - 真正干活的回调 `(first, second, next) => Promise<any>`
 * @param {string} [o.target] - 要监听的事件名（默认 `system-prompt/assemble`）
 * @param {string} [o.trigger] - 触发"追加下游版"的事件名（默认 `session/event`）
 * @param {{warn?:Function}} [o.log]
 * @returns {{mode:() => string, takenOver:() => boolean, dispose:() => void}}
 *   `mode()` ∈ `'upstream-sentinel'`（还没被接管）| `'downstream'`（下游版已就位）
 */
export function makeDeferredAssembleListener(o) {
  const on = typeof o?.on === 'function' ? o.on : null
  const run = typeof o?.run === 'function' ? o.run : null
  const target = typeof o?.target === 'string' && o.target !== '' ? o.target : 'system-prompt/assemble'
  const trigger = typeof o?.trigger === 'string' && o.trigger !== '' ? o.trigger : 'session/event'
  const warn = (m) => { try { o?.log?.warn?.(String(m)) } catch {} }
  const disposers = []
  let takenOver = false

  if (on === null || run === null) {
    warn('[mt] 延迟挂载：缺少 on 或 run ⇒ 未挂任何监听')
    return { mode: () => 'unavailable', takenOver: () => false, dispose: () => {} }
  }

  const add = (listener) => {
    try {
      const d = on(target, listener)
      if (typeof d === 'function') disposers.push(d)
    } catch (e) {
      warn(`[mt] 延迟挂载：注册 ${target} 监听失败（已降级）：${String((e && e.message) || e)}`)
    }
  }

  // ① 哨兵：开机就挂（老行为）。一旦下游版就位，它只透传。
  add(async (a, b, next) => {
    if (takenOver === true) return next()
    return run(a, b, next)
  })

  // ② 第一个会话事件时才追加真正那个 ⇒ 它排在所有插件之后 = 下游。
  try {
    const d = on(trigger, () => {
      if (takenOver === true) return
      takenOver = true
      add(async (a, b, next) => run(a, b, next))
    })
    if (typeof d === 'function') disposers.push(d)
  } catch (e) {
    warn(`[mt] 延迟挂载：注册 ${trigger} 失败 ⇒ ${target} 监听会一直留在上游（退化成老行为）：${String((e && e.message) || e)}`)
  }

  return {
    mode: () => (takenOver ? 'downstream' : 'upstream-sentinel'),
    takenOver: () => takenOver === true,
    dispose: () => { for (const d of disposers) { try { d() } catch {} } },
  }
}

export default { makeDeferredAssembleListener, DEFERRED_INSTALL_VERSION }
