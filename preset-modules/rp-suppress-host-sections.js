/**
 * rp-suppress-host-sections —— 在 roleplay preset 作用域里**遮蔽四段「宿主给编码 agent 的定位文字」**。
 *
 * ## 为什么（2026-09-15 用户拍板：「那两个没有就去掉」「应装尽装」）
 * 实测这几段对扮演毫无用处，还会把工程语境混进来：
 *   · `harness:source`（332 字）—— `packages/boot/app-boot/src/index.ts:854-861`：把**本机检出路径**告诉模型，
 *     并说"这份检出只用于检视/扩展 DSH 本身"。RP 既不需要，又是本地路径外露。
 *   · `app:web-surface`（991 字）—— `packages/bundle/web-app/src/index.ts:135-146`：GUI 地址、"this page/this GUI" 的指代、
 *     没有 DOM/截图上下文、HMR/重建契约、"别另起服务"。全是给编码 agent 的定位。
 *   · `context:file-reference`（0–343 字）—— `packages/context/file-reference-local/src/index.ts:66-73`：
 *     它的 `text` 是函数，**该 agent 没有 `read` 工具时就是空串**。RP 工具面被 `rp-tool-scope` 收窄 ⇒ 现在必然为空；
 *     这里再遮蔽一次，是为了「将来有人往 RP 工具面加 `read` 也不会把它带回来」（用户第 1 条的原话：不注册）。
 *   · `ui:deliverable-file-references`（299 字）—— `packages/client/ui-deliverables/src/index.ts:27`：
 *     要求模型**点名本轮创建/修改的主要文件**并写成 Markdown 行内代码。编码工作流专属，RP 没有可交付文件的概念。
 *
 * ## 机制（有上游源码为证）
 * `systemPrompt.section()` 的契约（`packages/core/system-prompt/src/index.ts:440-444`）：
 *   「**作用域内的同名段遮蔽全局段**；同一层内重复与非有限 order 才抛。」
 * RP 预设本身就是作用域（`story-anchor` / `rp-tool-scope` 都挂在这儿），
 * 而这几段是**全局层**注册的（web-app bundle / system-prompt / file-reference-local / ui-deliverables）
 * ⇒ 在本作用域注册同名段 + `text: ''` = **遮蔽**，不是撞车。
 *
 * ⚠️ 为什么不是「注销」：上游**没有**注销别人注册的段的 API —— `section()` 只返回**自己那次**注册的 disposer。
 *    遮蔽是唯一能做、且被官方注释明确支持的路径。被遮蔽的段在装配里仍是**一行 0 字**，
 *    而 `renderPrompt` 只拼非空段（同文件 :263-268）⇒ **它一个字都不会进 system**。
 *    （面板侧**不折叠、不隐藏**这一行 —— 用户 2026-09-16 口径：它占了一个 order，字段要照给，
 *     解释写进注释：来源 DSH 官方 + 作用 + RP 已禁用 ⇒ 占位但不会出现具体内容；
 *     `lib/client.js` 里只对它加一个灰标「RP 遮蔽」，且仅当它**确实 0 字**时加。
 *     两侧名单必须一致：本模块 `DEFAULT_SECTIONS` ↔ 客户端 `PM_HOST_ORIENT` ↔ `PM_SECTION_NOTES`。）
 *
 * ## 失败模式：**绝不抛**
 * 本模块抛异常 = preset 挂不上 = 用户开不了周目。整段包 `try/catch`，
 * 出错只大声写日志并**保留现状**（不遮蔽，RP 仍能用）。
 *
 * @module rp-suppress-host-sections
 */

/** Cordis 插件名。 */
export const name = 'rp-suppress-host-sections'

/** 需要提示词注册表（缺了 cordis 就不会调 apply ⇒ 天然安全）。 */
export const inject = ['systemPrompt']

/**
 * 默认遮蔽清单：`name` = 运行时真段名；`order` = 它在 `SECTION_ORDERS` 里的安置名。
 * 遮蔽时**用同一个 order**，这样它在装配里的位置不变（只是内容变空）——不制造顺序漂移。
 */
const DEFAULT_SECTIONS = [
  { name: 'harness:source', order: 'HARNESS_SOURCE' },
  { name: 'app:web-surface', order: 'WEB_SURFACE' },
  { name: 'context:file-reference', order: 'FILE_REFERENCE' },
  // 2026-09-16 追加（用户第 2 条）：`ui-deliverables` 的静态段 —— 要求模型点名本轮创建/修改的文件、
  // 写成 Markdown 行内代码（`packages/client/ui-deliverables/src/index.ts:27`）。**编码工作流专属**，
  // RP 里没有可交付文件的概念 ⇒ 同样遮蔽。
  { name: 'ui:deliverable-file-references', order: 'DELIVERABLE_FILE_REFERENCES' },
]

/** 只接受 `{name:string, orderName?:string}` 形状的额外条目（config.sections）。 */
function normalizeExtra(list) {
  const out = []
  if (!Array.isArray(list)) return out
  for (const it of list) {
    if (!it || typeof it !== 'object') continue
    const sectionName = typeof it.name === 'string' ? it.name.trim() : ''
    if (sectionName === '') continue
    const orderName = typeof it.orderName === 'string' ? it.orderName.trim() : ''
    out.push(orderName === '' ? { name: sectionName } : { name: sectionName, order: orderName })
  }
  return out
}

/**
 * 挂载入口。绝不抛：出错只写日志并保留现状。
 * @param {object} ctx - preset 作用域内的 cordis 上下文
 * @param {{sections?:Array<{name:string,orderName?:string}>}} [config] - 可选追加遮蔽项
 */
export function apply(ctx, config = {}) {
  const info = (m) => { try { ctx?.logger?.info?.(String(m)) } catch {} }
  const warn = (m) => { try { ctx?.logger?.warn?.(String(m)) } catch {} }
  try {
    const prompt = ctx && ctx.systemPrompt
    if (!prompt || typeof prompt.section !== 'function') {
      warn('[rp-suppress] systemPrompt 不可用 ⇒ 跳过遮蔽（RP 照常可用）')
      return
    }
    const list = DEFAULT_SECTIONS.concat(normalizeExtra(config && config.sections))
    const seen = new Set()
    const done = []
    const skipped = []
    for (const item of list) {
      // ⛔ 同一层里重复注册会抛（官方契约那句 "duplicates within one layer ... throw"）⇒ 按名去重，默认项优先。
      if (seen.has(item.name)) { skipped.push(item.name + '（重复，已跳过）'); continue }
      seen.add(item.name)
      let order = 0
      if (typeof item.order === 'string' && typeof prompt.getSectionOrder === 'function') {
        try {
          const resolved = prompt.getSectionOrder(item.order)
          if (Number.isFinite(resolved)) order = resolved
        } catch { /* 安置名不认识 ⇒ 退回 0，不抛 */ }
      }
      // 单条失败**不拖累其余**（整体 try/catch 只兜住"意外"，这里兜住"这一条"）
      try {
        // 用 ctx.effect 包住 ⇒ 随本作用域释放（与 story-anchor 同款写法）
        ctx.effect(() => prompt.section({ name: item.name, order, text: '' }))
        done.push(item.name + '@' + String(order))
      } catch (e) {
        skipped.push(item.name + '（注册失败：' + String(e && e.message ? e.message : e) + '）')
      }
    }
    info(`[rp-suppress] 已在 RP 作用域遮蔽 ${done.length} 段（内容置空，不进 system）：${done.join('、')}`)
    if (skipped.length > 0) warn(`[rp-suppress] 跳过 ${skipped.length} 项：${skipped.join('、')}`)
  } catch (e) {
    warn(`[rp-suppress] 遮蔽失败，保留现状（RP 照常可用）：${e && e.stack ? e.stack : e}`)
  }
}
