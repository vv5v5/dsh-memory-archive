#!/usr/bin/env node
/**
 * _selftest-mt-read.mjs —— `preset-modules/mt-read.js` 自检（纯函数 + 假 ctx + 静态锚点）。
 *
 * 跑法：node _selftest-mt-read.mjs   （⛔ 不碰 ~/.dsh、⛔ 不联网、⛔ 不碰真预设、⛔ 不读真文件）
 *
 * 这台子钉的是**"只读"这条底线**，不是"功能多全"：
 *   ① 参数解析非法就抛（照官方语义）；
 *   ② 行窗口口径（末尾换行不产生空行 / offset 越界抛 / 两种截断）；
 *   ③ 输出信封逐字对齐官方（三种页脚）；
 *   ④ ★★ **只注册一个工具，名字必须是 `read`，⛔ 绝不许出现 write / edit** —— 这是本模块存在的全部理由；
 *   ⑤ ★★ **不许走 node:fs、不许 import @deepseek-ai/**（走 fs 服务才受沙箱约束）；
 *   ⑥ 服务缺失 / 注册抛错 ⇒ 一律降级、**绝不抛**（模块抛 = 预设挂不上 = 用户开不了周目）；
 *   ⑦ 描述与段文本可被 config 覆盖（"描述逐个可配"的地基）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC_PATH = join(HERE, 'preset-modules', 'mt-read.js')
const mr = await import(pathToFileURL(SRC_PATH).href)

let pass = 0
const fails = []
function check(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name) } catch (e) { fails.push(name); console.log('  FAIL ' + name + ' :: ' + String((e && e.message) || e)) }
}
async function checkAsync(name, fn) {
  try { await fn(); pass++; console.log('  PASS ' + name) } catch (e) { fails.push(name); console.log('  FAIL ' + name + ' :: ' + String((e && e.message) || e)) }
}
const eq = (a, b, m) => { if (a !== b) throw new Error((m || '') + ' 期望 ' + JSON.stringify(b) + '，实得 ' + JSON.stringify(a)) }
const ok = (v, m) => { if (!v) throw new Error(m || '断言为假') }
const throws = (fn, m) => { let threw = false; try { fn() } catch { threw = true } if (!threw) throw new Error((m || '') + ' —— 本该抛却没抛') }

/** 假 ctx：记录注册了哪些工具 / 段 + 收集日志。 */
function fakeCtx({ noTools = false, noFs = false, noPrompt = false, throwOnRegister = false, readText = async () => 'l1\nl2\nl3\n' } = {}) {
  const tools = []
  const sections = []
  const fsCalls = []
  const logs = { info: [], warn: [] }
  const ctx = {
    logger: { info: (m) => logs.info.push(String(m)), warn: (m) => logs.warn.push(String(m)) },
    effect: (fn) => fn(),
  }
  if (!noTools) {
    ctx.tools = {
      register: (def) => { if (throwOnRegister) throw new Error('（自检注入）注册炸了'); tools.push(def); return () => {} },
    }
  }
  if (!noFs) {
    ctx.fs = {
      // ★ 假件必须**异步**：真机的 `fs.resolve` 返回 Promise。写成同步的话
      //   "漏了 await" 这类 bug 在台子上是绿的、到真机才炸（2026-09-19 真踩过）。
      resolve: async (p, opts) => { fsCalls.push({ p, opts }); return { displayPath: 'D:/fake/' + String(p), processPath: 'D:/fake/' + String(p) } },
      readText,
    }
  }
  if (!noPrompt) ctx.systemPrompt = { section: (s) => { sections.push(s); return () => {} } }
  return { ctx, tools, sections, logs, fsCalls }
}

console.log('== _selftest-mt-read.mjs · RP 只读 read 工具自检 ==')

// ── ① 参数解析 ──────────────────────────────────────────────────────────────
console.log('\n--- ① 参数解析（非法一律抛，照官方）---')
check('①a file_path 缺失 / 空 / 非字符串 ⇒ 抛', () => {
  for (const bad of [{}, { file_path: '' }, { file_path: '   ' }, { file_path: 42 }, { file_path: null }]) {
    throws(() => mr.parseReadArgs(bad), 'file_path=' + JSON.stringify(bad.file_path))
  }
})
check('①b offset / limit 非正整数 ⇒ 抛', () => {
  for (const bad of [0, -1, 1.5, '3', null, NaN]) {
    throws(() => mr.parseReadArgs({ file_path: 'a.txt', offset: bad }), 'offset=' + String(bad))
    throws(() => mr.parseReadArgs({ file_path: 'a.txt', limit: bad }), 'limit=' + String(bad))
  }
})
check('①c ★ 反证：limit 超过上限 ⇒ 抛（不是静默夹到上限）', () => {
  throws(() => mr.parseReadArgs({ file_path: 'a.txt', limit: mr.DEFAULT_LIMIT + 1 }))
  eq(mr.parseReadArgs({ file_path: 'a.txt', limit: mr.DEFAULT_LIMIT }).limit, mr.DEFAULT_LIMIT, '等于上限该放行')
})
check('①d 省略 offset/limit ⇒ 默认 1 / maxLimit', () => {
  const r = mr.parseReadArgs({ file_path: 'a.txt' })
  eq(r.offset, 1); eq(r.limit, mr.DEFAULT_LIMIT)
})
check('①e ★ 反证：file_path 里的空白不被告成"可用" —— 原样返回（解析不替调用方改词）', () => {
  eq(mr.parseReadArgs({ file_path: ' a.txt ' }).filePath, ' a.txt ', '不做 trim（清理由 fs.resolve 负责）')
})

// ── ② 行窗口 ────────────────────────────────────────────────────────────────
console.log('\n--- ② 行窗口口径 ---')
check('②a 基础：行号从 1 起，totalLines 正确', () => {
  const w = mr.windowLines('a\nb\nc', { offset: 1, limit: 10 })
  eq(w.totalLines, 3); eq(w.lines.length, 3)
  eq(w.lines[0].number, 1); eq(w.lines[2].text, 'c')
})
check('②b ★ 反证：末尾换行**不产生额外空行**（官方口径）', () => {
  eq(mr.windowLines('a\nb\n', { offset: 1, limit: 10 }).totalLines, 2, '末尾 \\n 后不该多一行')
  eq(mr.windowLines('a\n\n', { offset: 1, limit: 10 }).totalLines, 2, 'a + 空行 = 2 行')
  eq(mr.windowLines('a\nb', { offset: 1, limit: 10 }).totalLines, 2, '无末尾换行也是 2 行')
})
check('②c ★ 反证：空文件 totalLines=0；offset=1 时**不抛**（官方 finish 的例外：空文件读一次不该变成报错）', () => {
  const w = mr.windowLines('', { offset: 1, limit: 10 })
  eq(w.totalLines, 0); eq(w.lines.length, 0)
  throws(() => mr.windowLines('', { offset: 2, limit: 10 }), '空文件 offset=2 才是真越界')
})
check('②d ★ 反证：offset 超过总行数 ⇒ 抛（不是"返回空"）', () => {
  throws(() => mr.windowLines('a\nb', { offset: 3, limit: 10 }))
})
check('②e offset 生效：从第 2 行起取', () => {
  const w = mr.windowLines('a\nb\nc', { offset: 2, limit: 10 })
  eq(w.lines.length, 2); eq(w.lines[0].number, 2); eq(w.lines[0].text, 'b')
})
check('②f ★ 反证：单行超长 ⇒ 截断**并留下可见标注**（照官方 truncateLine，不是无声切片）', () => {
  const long = 'x'.repeat(5000)
  const w = mr.windowLines(long, { offset: 1, limit: 10, maxLineLength: 100 })
  eq(w.lines[0].text.slice(0, 100), 'x'.repeat(100), '前 100 字符该原样保留')
  ok(w.lines[0].text.includes('(line truncated to 100 chars)'), '该带官方那条标注：' + w.lines[0].text.slice(95))
  eq(w.lines[0].text.length, 100 + '... (line truncated to 100 chars)'.length)
})
check('②g ★ 反证：字节上限触发 ⇒ truncatedByBytes=true（且至少给一行，不空手而归）', () => {
  const big = Array.from({ length: 50 }, (_, i) => 'line' + i + '-' + 'y'.repeat(200)).join('\n')
  const w = mr.windowLines(big, { offset: 1, limit: 1000, maxBytes: 500 })
  eq(w.truncatedByBytes, true)
  ok(w.lines.length >= 1, '至少要给一行')
  ok(w.lines.length < 50, '不该把 50 行全给出去')
})
check('②h CRLF 归一：\\r\\n 不把 \\r 留在行尾', () => {
  const w = mr.windowLines('a\r\nb\r\n', { offset: 1, limit: 10 })
  eq(w.totalLines, 2); eq(w.lines[0].text, 'a')
})

// ── ③ 输出信封 ──────────────────────────────────────────────────────────────
console.log('\n--- ③ 输出信封（逐字对齐官方 formatReadOutput）---')
check('③a 读完 ⇒ End of file 页脚 + 信封形状', () => {
  const t = mr.formatReadOutput('/x/a.txt', { offset: 1, lines: [{ number: 1, text: 'a' }, { number: 2, text: 'b' }], totalLines: 2 })
  eq(t, '<path>/x/a.txt</path>\n<type>file</type>\n<content>\n1: a\n2: b\n\n(End of file - total 2 lines)\n</content>')
})
check('③b 被 limit 截断 ⇒ Showing lines A-B of N + 续读提示', () => {
  const t = mr.formatReadOutput('/x/a.txt', { offset: 1, lines: [{ number: 1, text: 'a' }], totalLines: 9 })
  ok(t.includes('(Showing lines 1-1 of 9. Use offset=2 to continue.)'), '页脚不对：' + t)
})
check('③c 被字节截断 ⇒ Output capped 页脚（优先于 Showing）', () => {
  const t = mr.formatReadOutput('/x/a.txt', { offset: 1, lines: [{ number: 1, text: 'a' }], totalLines: 9, truncatedByBytes: true })
  ok(t.includes('(Output capped. Showing lines 1-1. Use offset=2 to continue.)'), '页脚不对：' + t)
})
check('③d 空窗口 ⇒ 信封里只有页脚（不产生空行堆）', () => {
  const t = mr.formatReadOutput('/x/a.txt', { offset: 0, lines: [], totalLines: 0 })
  eq(t, '<path>/x/a.txt</path>\n<type>file</type>\n<content>\n(End of file - total 0 lines)\n</content>')
})

// ── ④ ★★ 只读底线 ───────────────────────────────────────────────────────────
console.log('\n--- ④ ★★ 只读底线：只注册一个 read，绝不注册写工具 ---')
check('④a 注册了且**只注册了一个**工具', () => {
  const { ctx, tools } = fakeCtx()
  const r = mr.apply(ctx, {})
  eq(r.registered, true)
  eq(tools.length, 1, '工具数量')
  eq(tools[0].name, 'read')
})
check('④b ★★ 反证：注册面里**不许**出现 write / edit / write_image 之类', () => {
  const { ctx, tools } = fakeCtx()
  mr.apply(ctx, {})
  const names = tools.map((t) => t.name)
  for (const bad of ['write', 'edit', 'str_replace_editor', 'write_image', 'bash', 'pwsh']) {
    ok(!names.includes(bad), '⛔ 竟然注册了 ' + bad)
  }
})
check('④c 段：注册了 tool:read @1100（与官方同名同位）', () => {
  const { ctx, sections } = fakeCtx()
  mr.apply(ctx, {})
  eq(sections.length, 1)
  eq(sections[0].name, 'tool:read'); eq(sections[0].order, 1100)
  ok(String(sections[0].text).length > 0)
})
check('④d 有 output.schema + output.render（DSH register 的硬要求）+ execute', () => {
  const { ctx, tools } = fakeCtx()
  mr.apply(ctx, {})
  const t = tools[0]
  eq(typeof t.output?.render, 'function', 'render 必须是函数（register 会校验）')
  eq(t.output?.schema?.type, 'object')
  eq(typeof t.execute, 'function')
  eq(t.parameters?.required?.[0], 'file_path')
})

// ── ⑤ ★★ 静态锚点：不许绕过沙箱 ─────────────────────────────────────────────
console.log('\n--- ⑤ ★★ 静态锚点：走 fs 服务，不许 node:fs / 不许 @deepseek-ai 依赖 ---')
/** 去掉注释再断言 —— 否则文件头里"我们不用 node:fs"这句话会把断言假绿。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
}
check('⑤a ★★ 反证：代码体里不出现 node:fs（绕过沙箱的唯一入口）', () => {
  const body = stripComments(readFileSync(SRC_PATH, 'utf8'))
  ok(!/from\s+['"]node:fs['"]/.test(body), '⛔ 引了 node:fs')
  ok(!/\brequire\(['"]node:fs['"]\)/.test(body), '⛔ require 了 node:fs')
  ok(!/\breadFileSync\b/.test(body), '⛔ 直接用了 readFileSync')
})
check('⑤b ★★ 反证：不 import 任何 @deepseek-ai/*（消除解析风险）', () => {
  const body = stripComments(readFileSync(SRC_PATH, 'utf8'))
  ok(!/from\s+['"]@deepseek-ai\//.test(body), '⛔ 引了 @deepseek-ai/*')
  ok(!/\bdefineTool\b/.test(body), '⛔ 用了 defineTool')
})
check('⑤c ★ 反证（负控）：把 stripComments 拿掉后，上面两条会变红 —— 证明断言不是空转', () => {
  const raw = readFileSync(SRC_PATH, 'utf8')
  ok(/node:fs/.test(raw), '文件头本该提到 node:fs（否则这条负控本身失效）')
})

// ── ⑥ 降级：绝不抛 ──────────────────────────────────────────────────────────
console.log('\n--- ⑥ 降级：服务缺失 / 注册抛错 ⇒ 降级不抛 ---')
check('⑥a tools 缺失 ⇒ 不注册、不抛、有 warn', () => {
  const { ctx, logs } = fakeCtx({ noTools: true })
  const r = mr.apply(ctx, {})
  eq(r.registered, false); eq(r.reason, 'no-tools')
  ok(logs.warn.length >= 1, '该有一条 warn')
})
check('⑥b ★ 反证：fs 缺失 ⇒ **不注册**（⛔ 绝不用 node:fs 兜底），且 warn 里点明理由', () => {
  const { ctx, logs } = fakeCtx({ noFs: true })
  const r = mr.apply(ctx, {})
  eq(r.registered, false); eq(r.reason, 'no-fs')
  ok(logs.warn.join('|').includes('沙箱') || logs.warn.join('|').includes('node:fs'), 'warn 该说明为什么不用 node:fs')
})
check('⑥c ★ 反证：register 抛错 ⇒ 降级返回，⛔ 不往上抛（抛 = 预设挂不上）', () => {
  const { ctx } = fakeCtx({ throwOnRegister: true })
  const r = mr.apply(ctx, {})
  eq(r.registered, false); eq(r.reason, 'threw')
})
check('⑥d systemPrompt 缺失 ⇒ 工具照常注册，只是少一段提示', () => {
  const { ctx, tools, logs } = fakeCtx({ noPrompt: true })
  const r = mr.apply(ctx, {})
  eq(r.registered, true); eq(tools.length, 1)
  ok(logs.warn.length >= 1)
})

// ── ⑦ 可配 ──────────────────────────────────────────────────────────────────
console.log('\n--- ⑦ 描述 / 段文本可配（"描述逐个可配"的地基）---')
check('⑦a 不传 config ⇒ 用默认（默认非空）', () => {
  const c = mr.resolveReadConfig()
  eq(c.description, mr.DEFAULT_DESCRIPTION)
  eq(c.sectionText, mr.DEFAULT_SECTION_TEXT)
  eq(c.limit, mr.DEFAULT_LIMIT)
  ok(c.description.length > 0 && c.sectionText.length > 0)
})
check('⑦b config 覆盖描述 / 段文本 / limit；空白串视为没配', () => {
  const c = mr.resolveReadConfig({ description: ' 我的描述 ', sectionText: '', limit: 123 })
  eq(c.description, '我的描述'); eq(c.sectionText, mr.DEFAULT_SECTION_TEXT); eq(c.limit, 123)
})
check('⑦c ★ 反证：非法 limit（0/负/NaN）⇒ 回落默认，不变成 0 行', () => {
  for (const bad of [0, -5, NaN, 'x', null]) eq(mr.resolveReadConfig({ limit: bad }).limit, mr.DEFAULT_LIMIT, 'limit=' + String(bad))
})
check('⑦d 描述真的进了注册面与段', () => {
  const { ctx, tools, sections } = fakeCtx()
  mr.apply(ctx, { description: 'DESC-X', sectionText: 'SECT-Y' })
  eq(tools[0].description, 'DESC-X')
  eq(sections[0].text, 'SECT-Y')
})

// ── ⑧ 端到端（假 fs）─────────────────────────────────────────────────────────
await checkAsync('⑧ 端到端：execute 走 fs.resolve + fs.readText，返回带行号窗口', async () => {
  const { ctx, tools } = fakeCtx({ readText: async () => 'alpha\nbeta\ngamma\n' })
  mr.apply(ctx, {})
  const out = await tools[0].execute({ file_path: 'note.md', offset: 2, limit: 5 }, {})
  eq(out.totalLines, 3)
  eq(out.lines.length, 2)
  eq(out.lines[0].number, 2); eq(out.lines[0].text, 'beta')
  eq(out.path, 'D:/fake/note.md', '回显该用 fs 解析出的 displayPath')
})
await checkAsync('⑧b ★ 反证：越界读 ⇒ 抛（由 DSH 变成模型可见的工具错误，不是静默空结果）', async () => {
  const { ctx, tools } = fakeCtx({ readText: async () => 'only\n' })
  mr.apply(ctx, {})
  let threw = false
  try { await tools[0].execute({ file_path: 'a', offset: 99 }, {}) } catch { threw = true }
  ok(threw, '越界该抛')
})
await checkAsync('⑧c ★★ 回归（2026-09-19 真机踩过）：相对路径要带会话 cwd —— exec.agent.session.header.cwd 必须传进 fs.resolve', async () => {
  const { ctx, tools, fsCalls } = fakeCtx()
  mr.apply(ctx, {})
  await tools[0].execute({ file_path: 'x.md' }, { agent: { session: { header: { cwd: 'D:/ws' } } } })
  eq(fsCalls.length, 1)
  eq(fsCalls[0].opts?.cwd, 'D:/ws', '⛔ 没把会话 cwd 传给 fs.resolve ⇒ 真机会报 path must be a string')
})
await checkAsync('⑧d ★ 反证（负控）：假件必须是异步的 —— 若 execute 漏了 await，`D:/fake/x.md` 就取不到（证明这条台子抓得住那个 bug）', async () => {
  const { ctx, tools, fsCalls } = fakeCtx()
  mr.apply(ctx, {})
  eq(typeof ctx.fs.resolve, 'function')
  const p = ctx.fs.resolve('probe', {})
  ok(p && typeof p.then === 'function', '假件返回的必须是 Promise（同步假件会让 ⑧ 系列失去意义）')
  await p
  eq(fsCalls.length, 1)
})
await checkAsync('⑧e exec 不带 agent（非 agent 调用）⇒ 不传 cwd、也不抛', async () => {
  const { ctx, tools, fsCalls } = fakeCtx()
  mr.apply(ctx, {})
  const out = await tools[0].execute({ file_path: 'y.md' }, {})
  eq(out.totalLines, 3)
  eq(fsCalls[0].opts?.cwd, undefined, '拿不到 cwd 就不该硬塞一个')
})

console.log('\n== 汇总：' + pass + ' 通过 / ' + fails.length + ' 失败 ==')
if (fails.length > 0) { console.log('失败项：\n  - ' + fails.join('\n  - ')); process.exit(1) }
