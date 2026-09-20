// ---------------------------------------------------------------------------
// memory-write —— RP「剧情笔记」写入的**纯逻辑核心**（20260919 复活版）。
//
// ## 为什么又回来了（2026-09-19 用户口径）
// 前一版把它整块退役了（当时 RP 预设换成社区版，记忆靠**官方** read/write/edit 维护）。
// 现在 RP 预设**回档到我们自己的、带工具遮蔽的那一份** —— 那份的工具面里 `read` 是我们自建的
// **只读**工具、`glob`/`grep` 也只读，**根本没有写工具** ⇒ "让 agent 维护笔记"物理上做不到。
//
// ⛔ **不能挂官方 `dsh-tool-fs`**：它一个包同时注册 read/read_image/write/edit（没有"只开读"的
//    config），而 `restrict()` 管不到预设自己注册的工具 ⇒ 实测连带多出 write/edit。
//
// ⛔ **也不能走宿主沙箱那条路**（用户 2026-09-19 的原话：「当初那么绕是因为 tavern 有收回，不能写」）：
//   绑了周目的 RP 会话里 Tavern 会把沙箱钉成 **read-only**，并有一个按**工具名**拦
//   write/edit/str_replace_editor/bash/pwsh/run_code/web_fetch 的守卫（`rp-mode.js` 的
//   `RP_MUTATING_TOOL_NAMES`，拦到就**取消这个 agent**）⇒ 走 `ctx.fs` 的写会被沙箱拒，
//   走我们自己的 `node:fs` 才落得下去。
//   ★ 本工具名 `memory_write` **不**在那个名单里（那是上游给"通用写工具"列的），所以不会被它拦。
//
// ## 落点（★ 一个周目一份）
// `<周目目录>/.roleplay-memory/` —— 周目目录由宿主按**本会话解析出的周目**算（会话优先、配置兜底，
// 与面板/检索同一条链），⛔ 绝不由模型给绝对路径。相对路径的裁决用 `./rel-path-jail.js`
// （它管"是不是安全相对路径"），本模块管"该不该写、写多少"。
//
// @license CC-BY-NC-4.0 (Attribution-NonCommercial 4.0 International)
// ---------------------------------------------------------------------------

/** 工具名（唯一真相；预设的 keep 名单与提示词里都写它）。 */
export const MEMORY_WRITE_TOOL = 'memory_write'
/** 记忆库目录名（与面板那档读的、社区预设写的**同一个名字**）。 */
export const MEMORY_WRITE_DIR = '.roleplay-memory'
/** 单次写入的字符上限（默认；可在配置里改）。 */
export const MEMORY_WRITE_MAX_CHARS = 20000
/** 写入模式。 */
export const MEMORY_WRITE_MODES = Object.freeze(['overwrite', 'append'])

/**
 * 沙箱三态 —— 与上游 `tavern-loader/src/rp-mode.js` 的 `SANDBOX_MODES` **同一套取值**
 * （那边也是 `read-only` / `workspace-write` / `danger-full-access`，走官方的 `sandbox/mode` 会话事件）。
 */
export const SANDBOX_MODES = Object.freeze(['read-only', 'workspace-write', 'danger-full-access'])

/**
 * 从会话事件里折出**当前沙箱模式**（**最后一个**有效的 `sandbox/mode` 胜出）。
 * ⚠️ 口径与上游 `rp-mode.js` 的 `foldSandboxMode` 同源（也是"最后一个有效值胜出"）——
 *   那一段只有六行，宁可本包自带一份，也⛔ 不去 import 上游包的内部路径（跨包深引用一升级就断）。
 * @returns {'read-only'|'workspace-write'|'danger-full-access'|null} 一条都没有 ⇒ null（⛔ 不猜）
 */
export function foldSandboxMode(events) {
  let mode = null
  if (!Array.isArray(events)) return mode
  for (const ev of events) {
    if (ev === null || typeof ev !== 'object' || ev.type !== 'sandbox/mode') continue
    const m = ev.data && typeof ev.data === 'object' ? ev.data.mode : undefined
    if (typeof m === 'string' && SANDBOX_MODES.includes(m)) mode = m
  }
  return mode
}

/**
 * **尊重沙箱**（2026-09-20 用户口径：「尊重，tarven里有关沙箱的设置」）。
 *
 * 背景：本工具的写盘走插件自己的 `node:fs`，**绕得过**宿主的沙箱（那是刻意的，见文件头）——
 *   所以"只读"这件事必须**由我们自己认账**，否则 RP 里被钉成只读的会话照样能落盘。
 *
 * 判据：**明确是 `read-only` ⇒ 拒写**；其余（`workspace-write` / `danger-full-access` / 认不出）放行，
 *   交给下面那几道自家裁决（rel-path-jail + 开关 + 单次字数）继续把关。
 * ⚠️ "认不出就放行"是刻意的：没有 `sandbox/mode` 事件的会话（非 RP、老日志）没有"只读"可言，
 *   ⛔ 不许因为"认不出"就把"让 agent 维护笔记"这件事整个停掉。
 * @returns {{allow:boolean, reason:'sandbox-ok'|'sandbox-read-only'}}
 */
export function sandboxDecision(mode) {
  if (mode === 'read-only') return { allow: false, reason: 'sandbox-read-only' }
  return { allow: true, reason: 'sandbox-ok' }
}

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 开关读取（纯函数）。★ 只认插件 config 的 `{ memoryWrite: { enabled, maxChars } }`；
 * 严格 `=== true` 才算开（缺字段/字符串 "true"/1 一律关 —— 与 lastFloors 同款口径）。
 *
 * @param {unknown} configJson
 * @returns {{ enabled: boolean, maxChars: number }}
 */
export function readMemoryWriteSwitch(configJson) {
  const off = { enabled: false, maxChars: MEMORY_WRITE_MAX_CHARS }
  if (!isRecord(configJson)) return off
  const mw = configJson.memoryWrite
  if (!isRecord(mw)) return off
  const raw = mw.maxChars
  const maxChars = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 200), 200000) : MEMORY_WRITE_MAX_CHARS
  return { enabled: mw.enabled === true, maxChars }
}

/**
 * 写入判据（纯函数，自检直测）。真值表见 `_selftest-memory-write.mjs`：
 *   enabled !== true           ⇒ { write:false, reason:'switch-off' }
 *   relPath 空 / 非字符串      ⇒ { write:false, reason:'no-path' }
 *   text 空 / 非字符串         ⇒ { write:false, reason:'empty-text' }
 *   超预算                     ⇒ { write:false, reason:'over-budget', chars }（⛔ **不**截断硬写）
 *   mode 不认识                ⇒ { write:false, reason:'bad-mode' }
 *   其余                       ⇒ { write:true,  reason:'ok', mode, chars }
 *
 * ⛔ 超预算**拒收**而不是"截断后写"：笔记是一段完整的东西，写半截比不写更坏
 *   （模型会以为记下了）。超了就让它**自己拆成两次写**，理由如实回给它。
 *
 * @param {{ enabled?: unknown, relPath?: unknown, text?: unknown, maxChars?: unknown, mode?: unknown }} input
 */
export function decideNoteWrite(input) {
  const i = input ?? {}
  if (i.enabled !== true) return { write: false, reason: 'switch-off' }
  if (typeof i.relPath !== 'string' || i.relPath.trim() === '') return { write: false, reason: 'no-path' }
  if (typeof i.text !== 'string' || i.text.trim() === '') return { write: false, reason: 'empty-text' }
  const mode = i.mode === undefined || i.mode === '' ? 'overwrite' : i.mode
  if (!MEMORY_WRITE_MODES.includes(mode)) return { write: false, reason: 'bad-mode' }
  const maxChars = Number.isFinite(i.maxChars) ? Math.trunc(i.maxChars) : MEMORY_WRITE_MAX_CHARS
  if (i.text.length > maxChars) return { write: false, reason: 'over-budget', chars: i.text.length, maxChars }
  return { write: true, reason: 'ok', mode, chars: i.text.length }
}
