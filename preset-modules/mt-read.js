/**
 * mt-read —— `roleplay` preset 的**只读文件工具**（`read`）。
 *
 * ## 为什么要有它（2026-09-18 实测得出的结论）
 * 官方 standard / ptc / cordis 三个预设都挂了 `@deepseek-ai/dsh-tool-fs` 来提供 `read`；
 * 我们 roleplay 预设原先没有 ⇒ RP 局里**没有读工具**。
 * 直接挂官方包**不行**：`dsh-tool-fs` 一个包**同时**注册 `read` / `read_image` / `write` / `edit`，
 * 没有"只开读"的 config；而 `restrict()` **管不到预设自己注册的工具**
 * （DSH 源码：`restrict()` 只收窄 **global** 工具，"scoped registrations remain visible"，
 * 名单里点 scope-local 的名字**直接抛错**）。实测挂上后工具面 12 → 16，多出 `write` + `edit`；
 * 且当时 `sandbox/mode = workspace-write`（**不是**只读）⇒ **真能落盘**，是安全回归。
 * ⇒ 所以：**我们只注册 `read` 一个，一个写工具都不注册。**
 *
 * ## 为什么它能安全地读（关键）
 * 走的是 **`ctx.fs` 服务**（`resolve` + `readText`），不是 `node:fs`
 * ⇒ **沙箱的路径牢笼与只读策略照旧生效**，不是绕过去裸读盘。
 * `fs` 不可用 ⇒ **不注册**（降级），绝不自己开一条后门。
 *
 * ## 注册形态
 * `ctx.tools.register({ name, description, parameters, output: { schema, render }, execute })`
 * —— 与 `state-bridge` 的 `state_patch` **同款纯对象**（`state-bridge/lib/index.js:579`）
 * ⇒ ⛔ **不需要** `defineTool`，本模块**不 import 任何 `@deepseek-ai/*`**（消除解析风险）。
 *
 * ## ★★ 调用契约（2026-09-19 真机踩出来，别删）
 * · `ctx.fs.resolve(path, opts)` 是**异步**的 ⇒ **必须 await**；漏了 await 会在下一句
 *   `readText` 里炸成「The "path" argument must be of type string... Received undefined」。
 * · 相对路径**必须带上会话工作目录**：`opts.cwd = exec.agent.session.header.cwd`
 *   （官方 `sessionCwd()` 读的就是这一处）。不传 ⇒ 解析不了相对路径，报上面同一个错。
 * · 症状很能骗人：**工具面里明明有 `read`，一调就报错**。所以这两条有专门的真机验脚本
 *   `产物/memory-tools/_verify-mt-read-exec.mjs`（只验工具面是验不出来的）。
 *
 * ## 与官方 `read` 的对齐（照抄数值，别乱改）
 * `limit` 默认并封顶 **2000 行** · 单行 **2000 字符** · 单次 **50 KiB** · 段 order **1100**
 * （官方 `READ_LIMIT` / `READ_MAX_LINE_LENGTH` / `READ_MAX_BYTES` / `SectionOrders.TOOL_READ`）。
 * 输出信封与页脚文案也逐字对齐官方 `formatReadOutput` ⇒ 模型在别处见过的格式在这里一样。
 *
 * ## 纪律
 * · ⛔ **注册期绝不抛**：本模块抛 = 预设挂不上 = 用户开不了周目。整段包 try/catch，出错只 warn 并降级。
 * · `execute` 内部**照官方一样抛**（参数非法 / 越界）—— 那是"一次工具调用失败"，DSH 会把它变成
 *   模型可见的错误结果，与注册失败是两回事。
 * · ⛔ 不注册任何写工具；⛔ 不碰 `node:fs`。
 *
 * @module mt-read
 * @license CC-BY-NC-4.0
 */

/** Cordis 插件名（仅用于日志/自述）。 */
export const name = 'mt-read'

/** 需要工具注册表与文件系统服务；缺任一个 cordis 就不调 apply（天然安全）。 */
export const inject = ['tools', 'fs']

/** 工具名（⛔ 唯一真相；`Scoped tools shadow globals` ⇒ 预设作用域注册不会与全局冲突）。 */
export const READ_TOOL_NAME = 'read'

/** 段名与位置：与官方 `tool:read` 同名同位（RP 里官方那段不存在，不冲突）。 */
export const READ_SECTION_NAME = 'tool:read'
export const READ_SECTION_ORDER = 1100

/** 官方数值（⛔ 别改：模型的行为预期是按这套档位建立的）。 */
export const DEFAULT_LIMIT = 2000
export const MAX_LINE_LENGTH = 2000
export const MAX_BYTES = 50 * 1024

/** 默认描述与默认段文本（用户口径：描述要能逐个配 ⇒ 这两个都是**默认值**，可被 config 覆盖）。 */
export const DEFAULT_DESCRIPTION = 'Read a UTF-8 text file and return line-numbered content.'
export const DEFAULT_SECTION_TEXT =
  'Use the read tool — not shell commands like cat — to inspect text files. '
  + 'Results include line numbers. Use offset and limit to continue reading large files.'

/** 参数描述里的 limit 默认值要与实际一致（照官方：描述里嵌 caps.limit）。 */
function filePathParamDesc() { return 'Path to read, resolved by the filesystem backend.' }

/**
 * 把 config 归一成实际生效的一组值（纯函数）。
 * @param {{description?:string, sectionText?:string, limit?:number}} [config]
 * @returns {{description:string, sectionText:string, limit:number}}
 */
export function resolveReadConfig(config = {}) {
  const cfg = config && typeof config === 'object' ? config : {}
  const str = (v, d) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : d)
  const limit = Number.isFinite(cfg.limit) && cfg.limit > 0 ? Math.trunc(cfg.limit) : DEFAULT_LIMIT
  return { description: str(cfg.description, DEFAULT_DESCRIPTION), sectionText: str(cfg.sectionText, DEFAULT_SECTION_TEXT), limit }
}

/** 正整数解析（照官方 `parsePositiveInteger`：非正整数一律拒）。 */
function parsePositiveInteger(value, label) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(label + ' must be a positive integer')
  }
  return value
}

/**
 * 解析 `read` 的参数（纯函数；非法就抛，照官方）。
 * @param {{file_path?:unknown, offset?:unknown, limit?:unknown}} args
 * @param {number} [maxLimit]
 * @returns {{filePath:string, offset:number, limit:number}}
 */
export function parseReadArgs(args, maxLimit = DEFAULT_LIMIT) {
  const a = args && typeof args === 'object' ? args : {}
  if (typeof a.file_path !== 'string' || a.file_path.trim() === '') {
    throw new Error('file_path must be a non-empty string')
  }
  const offset = a.offset === undefined ? 1 : parsePositiveInteger(a.offset, 'offset')
  const limit = a.limit === undefined ? maxLimit : parsePositiveInteger(a.limit, 'limit')
  if (limit > maxLimit) throw new Error('limit must be less than or equal to ' + maxLimit)
  return { filePath: a.file_path, offset, limit }
}

/** 超长行的截断标注（逐字对齐官方 `truncateLine`：截断要**看得见**，不是无声切片）。 */
export function truncateLine(line, maxLineLength) {
  return line.length > maxLineLength
    ? line.substring(0, maxLineLength) + '... (line truncated to ' + maxLineLength + ' chars)'
    : line
}

/**
 * 把整份文本切成带行号的窗口（纯函数）。
 *
 * ⛔ 行数口径照官方：**末尾换行不产生额外空行**（官方按 "\n" 逐行 flush，末尾若缓冲为空就不再 flush）。
 * ⛔ `offset` 越界 ⇒ **抛** —— 但官方有一个例外：**空文件 + offset===1 不抛**（返回空窗口）。
 *   见官方 `finish()`：`... && !(acc.totalLines === 0 && request.offset === 1)`。
 *   这个例外很别扭，但**照抄**：模型对空文件的读不该变成一次报错。
 *
 * @param {string} text
 * @param {{offset:number, limit:number, maxLineLength?:number, maxBytes?:number}} req
 * @returns {{offset:number, lines:{number:number,text:string}[], totalLines:number, truncatedByBytes:boolean}}
 */
export function windowLines(text, req) {
  const maxLineLength = Number.isFinite(req?.maxLineLength) ? req.maxLineLength : MAX_LINE_LENGTH
  const maxBytes = Number.isFinite(req?.maxBytes) ? req.maxBytes : MAX_BYTES
  const raw = String(text).split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop()
  const totalLines = raw.length
  const lines = []
  let outputBytes = 0
  let truncatedByBytes = false
  for (let i = 0; i < totalLines; i += 1) {
    const number = i + 1
    if (truncatedByBytes || number < req.offset || lines.length >= req.limit) continue
    const body = truncateLine(raw[i], maxLineLength)
    // 字节口径照官方：非首行要算上那个换行符
    const size = Buffer.byteLength(body, 'utf8') + (lines.length > 0 ? 1 : 0)
    if (outputBytes + size > maxBytes) { truncatedByBytes = true; continue }
    outputBytes += size
    lines.push({ number, text: body })
  }
  if (!truncatedByBytes && req.offset > totalLines && !(totalLines === 0 && req.offset === 1)) {
    throw new Error('offset ' + req.offset + ' is out of range (total ' + totalLines + ' lines)')
  }
  return { offset: req.offset, lines, totalLines, truncatedByBytes }
}

/**
 * 渲染成模型可见的信封（逐字对齐官方 `formatReadOutput`）。
 * @param {string} displayPath
 * @param {{offset:number, lines:{number:number,text:string}[], totalLines:number, truncatedByBytes?:boolean}} outcome
 * @returns {string}
 */
export function formatReadOutput(displayPath, outcome) {
  const last = outcome.lines.length > 0 ? outcome.lines[outcome.lines.length - 1].number : null
  const endLine = last === null ? Math.max(0, outcome.offset - 1) : last
  let footer
  if (outcome.truncatedByBytes === true) {
    footer = '(Output capped. Showing lines ' + outcome.offset + '-' + endLine + '. Use offset=' + (endLine + 1) + ' to continue.)'
  } else if (endLine < outcome.totalLines) {
    footer = '(Showing lines ' + outcome.offset + '-' + endLine + ' of ' + outcome.totalLines + '. Use offset=' + (endLine + 1) + ' to continue.)'
  } else {
    footer = '(End of file - total ' + outcome.totalLines + ' lines)'
  }
  const body = outcome.lines.length > 0
    ? outcome.lines.map((l) => l.number + ': ' + l.text).join('\n') + '\n\n' + footer
    : footer
  return '<path>' + displayPath + '</path>\n<type>file</type>\n<content>\n' + body + '\n</content>'
}

/**
 * 挂载入口：注册 `read` 工具（+ 一条同名的 tool 段，照官方）。
 * @param {object} ctx - preset 作用域内的 cordis 上下文
 * @param {{description?:string, sectionText?:string, limit?:number}} [config]
 * @returns {{registered:boolean, reason?:string, limit?:number, descriptionChars?:number}}
 */
export function apply(ctx, config = {}) {
  const warn = (m) => { try { ctx?.logger?.warn?.(String(m)) } catch { /* 日志失败不影响挂载 */ } }
  const info = (m) => { try { ctx?.logger?.info?.(String(m)) } catch { /* 同上 */ } }
  try {
    if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
      warn('[mt-read] tools 服务不可用 ⇒ 不注册 read（RP 照常可用，只是没有读工具）')
      return { registered: false, reason: 'no-tools' }
    }
    const fs = ctx.fs
    if (!fs || typeof fs.resolve !== 'function' || typeof fs.readText !== 'function') {
      warn('[mt-read] fs 服务不可用 ⇒ 不注册 read（⛔ 不用 node:fs 兜底：那会绕过沙箱的路径牢笼）')
      return { registered: false, reason: 'no-fs' }
    }
    const cfg = resolveReadConfig(config)

    ctx.tools.register({
      name: READ_TOOL_NAME,
      description: cfg.description,
      parameters: {
        type: 'object', additionalProperties: false, required: ['file_path'],
        properties: {
          file_path: { type: 'string', description: filePathParamDesc() },
          offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
          limit: { type: 'number', description: 'Maximum number of lines to return. Defaults to ' + cfg.limit + '.' },
        },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          required: ['path', 'offset', 'lines', 'totalLines'],
          properties: {
            path: { type: 'string' },
            offset: { type: 'integer' },
            lines: {
              type: 'array',
              items: {
                type: 'object', additionalProperties: false,
                required: ['number', 'text'],
                properties: { number: { type: 'integer' }, text: { type: 'string' } },
              },
            },
            totalLines: { type: 'integer' },
          },
        },
        render: (args, value) => {
          // 照官方：`truncatedByBytes` **不进 schema**，在 render 里由 args+value 重算。
          const input = parseReadArgs(args, cfg.limit)
          const lastLine = value.lines.length > 0 ? value.lines[value.lines.length - 1].number : null
          const endLine = lastLine === null ? Math.max(0, value.offset - 1) : lastLine
          const truncatedByBytes = value.lines.length < input.limit && endLine < value.totalLines
          return [{
            type: 'text',
            text: formatReadOutput(value.path, {
              offset: value.offset, lines: value.lines, totalLines: value.totalLines,
              ...(truncatedByBytes ? { truncatedByBytes: true } : {}),
            }),
          }]
        },
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const input = parseReadArgs(args, cfg.limit)
        // ★★ 两个真机踩出来的坑（2026-09-19，`_verify-mt-read-exec.mjs`）：
        //   ① `fs.resolve` 是**异步**的（返回 Promise）—— 不 await 的话 `target` 是个 Promise，
        //      下一句 `readText` 会在里面 `path.resolve(undefined)` 炸成
        //      「The "path" argument must be of type string... Received undefined」。
        //   ② 相对路径**必须带上会话工作目录**才能解析：官方 `sessionCwd()` 读的就是
        //      `exec.agent.session.header.cwd`。不传 ⇒ `opts.cwd` 为 undefined ⇒ 同样炸上面那一条。
        //   ⛔ 这两条都是"工具面里明明有 read、一调就报错"的静默陷阱，别删注释。
        const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
          ? exec.agent.session.header.cwd : undefined
        const target = await fs.resolve(input.filePath, {
          ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
          ...(exec && exec.signal !== undefined ? { signal: exec.signal } : {}),
        })
        const text = await fs.readText(target, exec && exec.signal)
        const win = windowLines(text, { offset: input.offset, limit: input.limit })
        const display = target && typeof target.displayPath === 'string' ? target.displayPath : input.filePath
        return { path: display, offset: win.offset, lines: win.lines, totalLines: win.totalLines }
      },
    })

    if (ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
      ctx.effect(() => ctx.systemPrompt.section({
        name: READ_SECTION_NAME, order: READ_SECTION_ORDER, text: cfg.sectionText,
      }))
    } else {
      warn('[mt-read] systemPrompt 不可用 ⇒ read 工具照常注册，只是少了那段使用提示')
    }

    info('[mt-read] 已注册只读 read 工具（limit 默认 ' + cfg.limit + '；⛔ 不注册任何写工具）')
    return { registered: true, limit: cfg.limit, descriptionChars: cfg.description.length }
  } catch (e) {
    warn('[mt-read] 注册失败，跳过 read 工具（RP 照常可用）：' + (e && e.stack ? e.stack : e))
    return { registered: false, reason: 'threw' }
  }
}

export default {
  name, inject, apply, resolveReadConfig, parseReadArgs, windowLines, formatReadOutput,
  READ_TOOL_NAME, READ_SECTION_NAME, READ_SECTION_ORDER, DEFAULT_LIMIT, MAX_LINE_LENGTH, MAX_BYTES,
  DEFAULT_DESCRIPTION, DEFAULT_SECTION_TEXT,
}
