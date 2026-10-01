// lib/health.js —— 记忆库**健康事件层**的纯逻辑（2026-09-30，用户口径「为全流程加报错」）。
//
// 设计原则（来自 0929-0930 三天排障的教训）：
//   · 失败分流到了「模型看得到」或「日志里躺着」，唯独缺「用户看得到且看得懂」——本层补这一层。
//   · 每条事件必须带 **hint**（影响什么 + 怎么恢复）——恢复动作往往就一句话，没人写下来就没人知道。
//   · ⛔ 报错器自己永不抛错、永不阻塞正文：写失败/读失败一律静默退化为「无事件」。
//
// ⛔ 零本地依赖：只操作本插件 storageDir 下的 health-events.json（自身创建）；
//   其它源（supervisor-state / anima ingest-state / compaction-failures.log）由 index.js 的聚合端点
//   **存在才读、缺失即省略**——新电脑全新安装没有任何本地文件也照常工作。

export const HEALTH_FILE = 'health-events.json'
export const HEALTH_CAP = 50

/**
 * 追加一条健康事件并截断容量。纯函数：返回新对象 { events, ackAt }。
 * 未读判定：at > ackAt（ack 由面板「知道了」按钮写入）。
 */
export function pushEvent(prev, event, cap = HEALTH_CAP) {
  const events = Array.isArray(prev?.events) ? prev.events : []
  const ackAt = Number(prev?.ackAt ?? 0)
  const item = {
    at: Date.now(),
    source: String(event.source ?? 'unknown'),
    severity: event.severity === 'error' ? 'error' : 'warn',
    code: String(event.code ?? ''),
    message: String(event.message ?? '').slice(0, 300),
    hint: String(event.hint ?? '').slice(0, 300),
  }
  const next = { events: [item, ...events].slice(0, cap), ackAt: prev?.ackAt ?? 0 }
  return next
}

/** 未读事件数（at > ackAt 的条数）。 */
export function unreadCount(prev) {
  const events = Array.isArray(prev?.events) ? prev.events : []
  const ackAt = Number(prev?.ackAt ?? 0)
  return events.filter((e) => Number(e.at ?? 0) > ackAt).length
}

/** 全部已读：把 ackAt 推进到最新事件时间。 */
export function ackAll(prev) {
  const events = Array.isArray(prev?.events) ? prev.events : []
  const newest = events.reduce((m, e) => Math.max(m, Number(e.at ?? 0)), 0)
  return { events, ackAt: newest }
}

/**
 * 归一化文本键：去空白后取前 400 字的滚动哈希——近邻重复判定的键形状。
 * （与 anima 侧 near 账同构；此处供健康层去重提示使用。）
 */
export function normalizeKey(text) {
  const s = String(text ?? '').replace(/\s+/g, '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return 'h' + (h >>> 0).toString(36) + '_' + s.length
}

/**
 * 前台提示帧（2026-09-30，用户口径「记忆库报错要前台提示」）：error/warn 事件 ⇒
 * `{ type:'health', event }` 一帧（走那条唯一的 SSE；旧客户端不认 `health` 帧会安静忽略 ⇒ 前向兼容）。
 * 畸形入参 / 没有可给人看的话 ⇒ **null**（调用方不推——⛔ 不推空壳打扰）。
 * severity 与 `pushEvent` 的归一同一口径：非 'error' 一律 'warn'。
 */
export function healthSseFrame(event) {
  if (event === null || typeof event !== 'object') return null
  const message = String(event.message ?? '').trim()
  if (message === '') return null
  const severity = event.severity === 'error' ? 'error' : 'warn'
  const source = String(event.source ?? 'unknown')
  const code = String(event.code ?? '')
  const hint = String(event.hint ?? '').slice(0, 300)
  return { type: 'health', event: { source, severity, code, message: message.slice(0, 300), hint } }
}
