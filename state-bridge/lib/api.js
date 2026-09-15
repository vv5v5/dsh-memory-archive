/**
 * 副 API 调用（OpenAI 兼容）+ 解析。
 *
 * `callAPI` 的骨架照搬 `状态系统v1.js:393-417`（AbortController + 超时 + 外部 signal 联动 + usage 记录），
 * 用户决策是"复用 ST 里配好的那套"（SiliconFlow + 现有 key + DeepSeek-V3.2 + temp 0.4），
 * 所以走**原始 fetch** 而不是宿主 `ctx.llm` —— 好处是记账质量与 ST 侧完全可复现。
 *
 * 本文件相对 ST 的两处变化：
 *  ① **双模式**：默认 `tool`（强制工具调用），可退回 `json`（ST 的自由 JSON 路线）
 *  ② 按 F2 的结论收紧重试边界：**只修格式层**，语义层一律拒（`extractJSON` 本来就是格式层修复）
 */
import { buildToolSchema } from './schema.js'

/** 剥掉推理段。照搬 `状态系统v1.js:91`。 */
export const stripThink = (t) => String(t ?? '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim()

/**
 * 容错解析。照搬 `状态系统v1.js:385-391`。
 * ⚠️ 这**只做格式层修复**（剥围栏、取首末花括号、去尾逗号）—— 绝不改语义，
 * 与 F2 的「该修的只有格式层，语义层一律拒」一致。
 */
export function extractJSON(raw) {
  const t = stripThink(raw).replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '')
  try { return JSON.parse(t) } catch { /* 继续降级 */ }
  const s = t.indexOf('{'), e2 = t.lastIndexOf('}')
  if (s !== -1 && e2 > s) {
    try { return JSON.parse(t.slice(s, e2 + 1).replace(/,(\s*[}\]])/g, '$1')) } catch { /* 放弃 */ }
  }
  return null
}

/**
 * 发起一次记账调用。
 *
 * @param opts.api      {url, key, model, temperature, max_tokens, timeout_ms}
 * @param opts.system   记账提示词
 * @param opts.user     【当前状态】+【新对话内容】
 * @param opts.mode     'tool' | 'json'
 * @param opts.signal   外部中止信号
 * @returns {{ ok, mode, patch, summary, raw, usage, error, finishReason, seconds }}
 *          `patch` = 已解析出的增量补丁；解析失败时 ok=false 且 patch=null（**不返回半截数据**）
 */
export async function callAccounting({ api, system, user, mode = 'tool', signal, toolSchema }) {
  const started = Date.now()
  const ctl = new AbortController()
  const timeoutMs = api.timeout_ms ?? 120_000
  const timer = setTimeout(() => ctl.abort(new Error('timeout')), timeoutMs)
  const onAbort = () => ctl.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) ctl.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  const body = {
    model: api.model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: api.temperature ?? 0.4,
    max_tokens: api.max_tokens ?? 4096,
    stream: false,
  }
  if (mode === 'tool') {
    body.tools = [toolSchema ?? buildToolSchema()]
    // 强制调用，且**指定函数名** —— 实测 SiliconFlow/DeepSeek-V3.2 支持（见方案 §9.3）
    body.tool_choice = { type: 'function', function: { name: 'submit_state_patch' } }
  }

  const fail = (error, extra = {}) => ({
    ok: false, mode, patch: null, summary: '', raw: '', usage: null,
    error, finishReason: null, seconds: (Date.now() - started) / 1000, ...extra,
  })

  try {
    const res = await fetch(api.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.key}` },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return fail(`HTTP ${res.status} ${text.slice(0, 200)}`)
    }
    const j = await res.json()
    const ch = j.choices?.[0]
    const usage = j.usage
      ? { 提示词: j.usage.prompt_tokens, 生成: j.usage.completion_tokens, 结束原因: ch?.finish_reason }
      : null
    const seconds = (Date.now() - started) / 1000

    if (mode === 'tool') {
      const tc = ch?.message?.tool_calls?.[0]
      if (!tc) {
        // 没有工具调用 = 显式失败（这正是工具调用路线的价值：失败可见，不会静默）
        return fail('模型没有提交 submit_state_patch 工具调用', {
          raw: String(ch?.message?.content ?? '').slice(0, 500), usage, finishReason: ch?.finish_reason ?? null, seconds,
        })
      }
      if (tc.function?.name !== 'submit_state_patch') {
        return fail(`工具名不符：${tc.function?.name}`, { usage, finishReason: ch?.finish_reason ?? null, seconds })
      }
      let args = null
      try { args = JSON.parse(tc.function?.arguments ?? '') } catch { /* 下面判 */ }
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return fail('工具参数不是合法 JSON 对象', {
          raw: String(tc.function?.arguments ?? '').slice(0, 500), usage, finishReason: ch?.finish_reason ?? null, seconds,
        })
      }
      if (args.change === null || typeof args.change !== 'object' || Array.isArray(args.change)) {
        return fail('工具参数缺少合法的 change 对象', { usage, finishReason: ch?.finish_reason ?? null, seconds })
      }
      return {
        ok: true, mode, patch: args.change, summary: String(args.summary ?? ''),
        raw: tc.function.arguments ?? '', usage, error: null, finishReason: ch?.finish_reason ?? null, seconds,
      }
    }

    // json 模式（ST 路线）
    const raw = ch?.message?.content ?? ''
    const parsed = extractJSON(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('回复无法解析为 JSON 对象', { raw: String(raw).slice(0, 500), usage, finishReason: ch?.finish_reason ?? null, seconds })
    }
    return {
      ok: true, mode, patch: parsed, summary: '', raw: String(raw),
      usage, error: null, finishReason: ch?.finish_reason ?? null, seconds,
    }
  } catch (e) {
    const aborted = ctl.signal.aborted
    return fail(aborted ? `调用被中止（${String(ctl.signal.reason?.message ?? ctl.signal.reason ?? 'signal')}）` : `请求失败: ${e.message}`)
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener?.('abort', onAbort)
  }
}

/**
 * 带重试的记账。**重试只为格式层**（F2：重试救不了幻觉语义）。
 * 语义层的处置在 `mergeStatus` / 配额护栏 / schema 校验，不在这里。
 *
 * 区分两类失败：
 *   · 格式层（没有工具调用 / 参数不是合法 JSON / 解析失败）→ 可重试
 *   · 调用层（HTTP 错误、超时、被中止）→ **不重试**（重试只会再花一次钱）
 */
export async function callAccountingWithRetry(opts) {
  const attempts = Math.max(1, opts.attempts ?? 2)
  const log = []
  let last = null
  for (let i = 0; i < attempts; i++) {
    last = await callAccounting(opts)
    log.push({ attempt: i + 1, ok: last.ok, error: last.error ?? null, seconds: last.seconds })
    if (last.ok) return { ...last, attempts: log }
    if (opts.signal?.aborted) break
    // 调用层失败（HTTP/网络/超时）不重试
    if (/^(HTTP |请求失败|调用被中止)/.test(last.error ?? '')) break
  }
  return { ...(last ?? { ok: false, patch: null, error: 'no attempt ran' }), ok: false, patch: null, attempts: log }
}
