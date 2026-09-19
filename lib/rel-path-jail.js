/**
 * rel-path-jail —— 「相对路径裁决」纯逻辑（校验 + 解析，⛔ 零文件系统依赖）。
 *
 * ## 为什么它还在（2026-09-19 从 memory-write.js 抽出来）
 * 原先这份裁决是给 `memory_write` 工具用的（模型交内容、我们落盘）。**那个工具已整块退役**
 * （用户口径「记忆库写入也可以摘除，包括代码和描述」）。
 * 但**读侧还用它**：`GET /playthrough/rp-memory`（面板「剧情大纲」那一档）要靠它过滤
 * 记忆库目录里的文件名单与校验 `?file=` ⇒ 只读得到那一个目录里的普通文本文件，
 * 不是任意文件读入口 ⇒ 裁决本身不能跟着写侧一起删。
 *
 * ⇒ 所以这里只留**共享的裁决**，写侧特有的东西（工具名 / 扩展名白名单以外的写入模式 /
 *   字数预算 `decideWrite` / 计划 `planWrite`）随工具一起删掉了。
 *
 * 立场照旧：**拒收，绝不"清洗后放行"**。越界（绝对路径、盘符、UNC、`..` / `.` 段、空段、
 * 非法字符、扩展名不在表、Windows 保留设备名、超长）一律原样打回并给人话 reason；
 * 反斜杠 `\` 只做**归一成 `/`** 这一种归一，归一之后照样要过全部检查。
 *
 * @license CC-BY-NC-4.0 (Attribution-NonCommercial 4.0 International)
 * 仅限个人学习与非商业用途；禁止闭源商用或转为付费插件/服务。
 */

// 唯一的依赖：path（纯字符串运算）。⛔ 不引 node:fs —— 读写都是调用方的事。
import { resolve as resolvePath, sep } from 'node:path'

/** 允许的扩展名（小写比较）。⛔ 不在这个表里的一律拒收。 */
export const ALLOWED_EXTENSIONS = ['.md', '.txt', '.json', '.yaml', '.yml']

/** 允许扩展名的人话清单（reject reason 里要列出来）。 */
const EXT_HINT = ALLOWED_EXTENSIONS.join(' / ')

/**
 * ★ Windows **保留设备名**（2026-09-19 由验收方的对抗性探针发现并补上）。
 *
 * 为什么必须拒：`CON` / `NUL` / `COM1` … 在 Windows 上**带任何扩展名仍然是设备名**
 * （`CON.md` 也是）。放行的话，写它会打向设备而不是落一个文件；读它同理拿不到文件。
 *
 * 判定口径：**任一段**取第一个 `.` 之前的部分（大小写不敏感）落在表里 ⇒ 拒。
 */
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

/**
 * 校验一个**相对路径**（纯函数，不碰文件系统）。
 *
 * 规则（全部"拒收"，每条独立 reason）：
 *   - 必须是非空字符串（trim 后判空；空白串打回）；
 *   - 反斜杠归一成分隔符 `/`（归一 ≠ 清洗：归一后照样过下面全部检查）；
 *   - ⛔ 绝对路径（以 `/` 开头 / 盘符前缀如 `C:`）、UNC（双斜杠开头）；
 *   - ⛔ 任何 `..` 段、`.` 段、空段；
 *   - ⛔ Windows 保留设备名段（`CON` / `NUL` / `COM1` … 带扩展名也算）；
 *   - ⛔ NUL 或任何 ASCII 控制字符（0x00–0x1f）；
 *   - ⛔ Windows 非法字符 `: * ? " < > |`；
 *   - ⛔ 段首/段尾带空白（内部空格合法 —— "我的 笔记.md" 没问题）；
 *   - ⛔ 扩展名不在 ALLOWED_EXTENSIONS（没有扩展名也算不在，reason 列出允许表）；
 *   - ⛔ 归一后段数 > 8、任一段长 > 120、总长 > 240。
 *
 * @param {unknown} relPath - 待校验的相对路径
 * @returns {{ok:true, relPath:string} | {ok:false, reason:string}}
 */
export function validateRelPath(relPath) {
  if (typeof relPath !== 'string') return { ok: false, reason: 'relPath 必须是字符串' }
  if (relPath.trim() === '') return { ok: false, reason: 'relPath 不能为空（或全是空白）' }
  for (const ch of relPath) {
    if (ch.codePointAt(0) <= 0x1f) return { ok: false, reason: 'relPath 含 NUL 或其他 ASCII 控制字符' }
  }
  // 反斜杠归一：这是**归一**不是清洗 —— 归一之后下面每一条照样要过。
  const norm = relPath.replaceAll('\\', '/')
  if (/^[a-zA-Z]:(\/|$)/.test(norm)) return { ok: false, reason: 'relPath 是绝对路径：带了盘符前缀（如 C:），不许越出目标目录' }
  if (norm.startsWith('//')) return { ok: false, reason: 'relPath 是 UNC 路径（双斜杠开头），不许指向共享目录' }
  if (norm.startsWith('/')) return { ok: false, reason: 'relPath 是绝对路径（以 / 开头），只收相对路径' }
  if (/[:*?"<>|]/.test(norm)) return { ok: false, reason: 'relPath 含 Windows 非法字符（: * ? " < > |）' }
  const segs = norm.split('/')
  for (const s of segs) {
    if (s === '') return { ok: false, reason: 'relPath 里有空段（连续分隔符或结尾带分隔符）' }
    if (s === '.') return { ok: false, reason: 'relPath 里有 "." 段（请写具体子路径）' }
    if (s === '..') return { ok: false, reason: 'relPath 里有 ".." 段（不许越出目标目录）' }
    const baseName = s.split('.')[0].toLowerCase()
    if (WINDOWS_RESERVED.has(baseName)) {
      return { ok: false, reason: 'relPath 有 Windows 保留设备名段（' + baseName + '），读写都会打向设备而不是文件' }
    }
    if (s.length > 120) return { ok: false, reason: 'relPath 有段超过 120 字符' }
    if (s !== s.trim()) return { ok: false, reason: 'relPath 有段首或段尾带空白' }
  }
  if (segs.length > 8) return { ok: false, reason: 'relPath 层级太深：超过 8 层' }
  if (norm.length > 240) return { ok: false, reason: 'relPath 总长超过 240 字符' }
  const last = segs[segs.length - 1]
  const dot = last.lastIndexOf('.')
  if (dot <= 0) return { ok: false, reason: 'relPath 没有扩展名（允许：' + EXT_HINT + '）' }
  const ext = last.slice(dot).toLowerCase()
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return { ok: false, reason: 'relPath 的扩展名 ' + ext + ' 不在允许表里（允许：' + EXT_HINT + '）' }
  }
  return { ok: true, relPath: norm }
}

/**
 * 把相对路径解析成**夹在 baseDir 之内**的绝对路径。
 *
 * 先过 validateRelPath（不过原样打回），再做一次兜底：path.resolve 的结果必须以
 * path.resolve(baseDir) + 分隔符为前缀，否则按"解析后越出目标目录"拒收。
 * ★ 这条兜底是纵深防御：正常情况下 validateRelPath 已经拦住了所有越界形态，
 *   它防的是"将来有人放宽了路径检查 / 平台解析口径变化"这类回归。
 *
 * @param {unknown} baseDir - 目标目录的绝对路径
 * @param {unknown} relPath - 相对路径
 * @returns {{ok:true, absPath:string, relPath:string} | {ok:false, reason:string}}
 */
export function resolveUnderDir(baseDir, relPath) {
  if (typeof baseDir !== 'string' || baseDir.trim() === '') {
    return { ok: false, reason: 'baseDir 必须是非空字符串' }
  }
  const v = validateRelPath(relPath)
  if (!v.ok) return v
  const base = resolvePath(baseDir)
  const abs = resolvePath(baseDir, v.relPath)
  if (!abs.startsWith(base + sep)) {
    return { ok: false, reason: '解析后越出目标目录（兜底拦截：解析结果不在 baseDir 之内）' }
  }
  return { ok: true, absPath: abs, relPath: v.relPath }
}

export default { validateRelPath, resolveUnderDir, ALLOWED_EXTENSIONS }
