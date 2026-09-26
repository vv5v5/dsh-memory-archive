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
// ## ★ 20260925：**自记标记 ＋ 段模式**（用户口径：「**加一个准则，ai自己生成的内容需要标记。**」＋
//    「另外，它现在并没有删除内容的工具是吗」）
// 后一问的答：删除的手段**早就有**（`replace` ＋ `text:''`，见 `MEMORY_WRITE_MODES`），
//   **问题是它的形状** —— 上一版要求 `find` 是原文里**逐字的一小段**（找不到／出现多次一律拒收），
//   于是"删掉上一轮那一段"实际要求模型**把上一整段逐字抄进 `find`**：抄错一个字符就被拒。
//   真机现场（某周目 `index.md`）：模型一轮加一段 `## 最近进展（更新）`、堆了 **50 份**，
//   「导演笔记」**0** 次 —— 它不是偷懒，是在绕开一个它做不到的动作。
//   ⇒ 这一版加**段模式**：`find` 的**第一行**给标记行（可再带上紧跟的那个标题行指定是哪一段）⇒
//   **整段换／整段删**（"删掉上一轮那版"从此是**一行**的事）。定位与边界见 `locateSelfMarkSegment`。
// 前一问的答：`NOTE_SELF_MARK`（`〔AI 自记〕`）——"哪几段是我自己写的"从此一眼可认。
//   **为什么必须独占一行**：段模式是**按行**认标记的（整行 trim 后等于它才算标记行），
//   夹在行中间（如 `- 〔AI 自记〕…`）就不算 ⇒ 那一脚退回逐字模式（唯一性子串那套判据照旧）。
//
// @license CC-BY-NC-4.0 (Attribution-NonCommercial 4.0 International)
// ---------------------------------------------------------------------------

/** 工具名（唯一真相；预设的 keep 名单与提示词里都写它）。 */
export const MEMORY_WRITE_TOOL = 'memory_write'
/** 记忆库目录名（与面板那档读的、社区预设写的**同一个名字**）。 */
export const MEMORY_WRITE_DIR = '.roleplay-memory'
/**
 * ★ 20260925：**AI 自记标记**（唯一真相常量）—— `〔AI 自记〕`。
 *
 * 形状（字面**一个字符都不许改**）：**独占一行**，**紧贴**在它那一节的标题**上面**
 * （行里还夹着别的字 ⇒ 不算标记行 —— 段模式按行认它，见 `locateSelfMarkSegment`）。
 *
 * ① 它同时写在 **persona §5** 的那句话里（预设正文那一半不由本文件管）；
 * ② 两处"字面逐字一致"的判据钉在 `_selftest-preset-persona.mjs`；
 * ③ ⛔ **别在别处再写一遍这个字面** —— 要引用就 `import { NOTE_SELF_MARK }`（重打一遍迟早两处不一致）。
 *    （工具描述那一份就是这么来的：`lib/index.js` 只 import 它，源码里没有第二个副本 ——
 *    `_selftest-memory-write.mjs` 的 ★M⑧b / ★E7 把这两头都钉住。）
 */
export const NOTE_SELF_MARK = '〔AI 自记〕'
/** 单次写入的字符上限（默认；可在配置里改）。 */
export const MEMORY_WRITE_MAX_CHARS = 20000

/**
 * ★★ 2026-09-26（收纳升级，用户口径「升级」）：notes.md **保养线的硬触发**。
 * persona §5 那条「`notes.md` 超过约 6000 字 ⇒ 最早场记压成一行、伏笔移进 world.md」是**软规则**
 * （真机十周目 3 天就堆到 13010 字，模型没理它）⇒ 升两级：
 *   ① `memory_write` 回执（写完那一刻模型最听得进去）；
 *   ② `mt:memoryHome` 段尾（**每轮**装配都点名，直到它真把字数压下去）。
 * 线值与 persona §5 同源：**6000 字**（⛔ 别改这里不改 persona，两处说的是同一条线）。
 */
export const NOTES_MAINTENANCE_LIMIT_CHARS = 6000
/** 过线 ⇒ 返回**点名催收纳**的一句；没过 ⇒ 空串（纯函数：字数由调用方喂，自检台直测）。 */
export function notesMaintenanceHint(chars) {
  const n = Number(chars)
  if (!Number.isFinite(n) || n < NOTES_MAINTENANCE_LIMIT_CHARS) return ''
  return '⚠ notes.md 现 ' + Math.round(n) + ' 字，已过保养线 ' + NOTES_MAINTENANCE_LIMIT_CHARS
    + ' 字 ⇒ 本轮就按 §5 收纳：把最早场记压成一行留在原位，伏笔移进 world.md 的「未解伏笔」。'
}
/**
 * 写入模式。
 * ★ 20260924 加 **`replace`**（用户口径：「预设问题。ai 目前**不会删掉过时的 index 和 note 信息**」
 *   ＋「**告诉 ai：每轮都更新的记录，更新下一轮时删除上一轮**」）。
 *   为什么必须加这一项：`append` 只会往末尾加（**越堆越长**），`overwrite` 是**整份替换**
 *   （一覆盖，作者写在同一份 `index.md` 里的规则、准则、目录就**整段没了**）⇒
 *   模型想"把上一轮那段删掉"**无路可走**。`replace` 只换 `find` 指到的那一小段。
 * ★ 20260925：`replace` 的 **`text` 留空（空串）= 把 `find` 指到的那一段整个删掉**（"纯删除"）——
 *   否则"整段不要了"还得把**前后相邻的行**也抄进 `find`、再在 `text` 里**原样留回来**：
 *   别扭，而且多抄一遍就多一次抄错的机会。（`overwrite` / `append` 的空文本照旧拒收，见 `decideNoteWrite`。）
 */
export const MEMORY_WRITE_MODES = Object.freeze(['overwrite', 'append', 'replace'])

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
 *   text 非字符串              ⇒ { write:false, reason:'empty-text' }
 *   text 空 / 纯空白           ⇒ { write:false, reason:'empty-text' } —— ★ **只有 `replace` 例外**（见下）
 *   超预算（`text` 长于 `maxChars`）⇒ { write:false, reason:'over-budget', chars, maxChars }（⛔ **不**截断硬写）
 *   mode 不认识                ⇒ { write:false, reason:'bad-mode' }
 *   其余                       ⇒ { write:true,  reason:'ok', mode, chars }
 *
 * ★ 20260925：「空文本」这道闸**按 mode 分开** —— 用户口径是「**告诉 ai：每轮都更新的记录，更新下一轮时
 *   删除上一轮**」，而"整段不要了"得让它**删得掉**（上一版模型要删一段，得把相邻的行也抄进 `find`、
 *   再在 `text` 里原样留回来：别扭，且多抄一遍就多一次抄错的机会）。一句话：**`replace` 的空文本 = 纯删除**。
 *   ⛔ **别"顺手统一"成一种口径** —— 三种 mode 的"空"根本不是一回事：
 *     · `overwrite` 空 = 把**整份文件**清空 ⇒ 不可逆地丢内容（作者预置的那部分也一起没）⇒ **拒**；
 *     · `append` 空 = 往末尾加个空 ⇒ **什么都没写** ⇒ **拒**；
 *     · `replace` 空 = 只把 `find` 指到的那一段剪掉 ⇒ **放行**（要的就是它）。
 *   ⚠️ 非字符串（undefined / 数字 / 对象）一律当"没有正文"⇒ 照旧拒（⛔ 不替模型把"没给 / 给错类型"猜成空）。
 *
 * ⛔ 超预算**拒收**而不是"截断后写"：笔记是一段完整的东西，写半截比不写更坏
 *   （模型会以为记下了）。判据只有这一条 ——「`text` 比 `maxChars` 长」，**三种 mode 一视同仁**：
 *   ★ 20260926 核过（用户口径「到上限时自动提示需要优化」）—— `replace` 的 `text` **也**受这个上限管，
 *     ⛔ 但它**不妨碍瘦身**：闸看的是 **`text` 的长度**，不是结果文件的长度（也不是 `find` 的长度）
 *     ⇒「把一大段 `replace` 成一小段」永远放行（哪怕那份文件本身早已远超上限）。本单没动它，只钉住。
 * ⛔ 撞上限时给模型的**不再是**"拆成两次写"（那只会让笔记更长 —— 笔记长胖正是撞上限的成因）：
 *   回执由 `lib/index.js` 的 `noteOverBudgetText` 写成一次明确的**"该优化了"** ——
 *   数字（这一段 N / 上限 M）＋ 为什么（该"每轮替换、只留最新"的那几段在长胖）＋ **三件可照做的动作**，
 *   顺序说死：**先优化、再写**。
 *
 * @param {{ enabled?: unknown, relPath?: unknown, text?: unknown, maxChars?: unknown, mode?: unknown }} input
 */
export function decideNoteWrite(input) {
  const i = input ?? {}
  if (i.enabled !== true) return { write: false, reason: 'switch-off' }
  if (typeof i.relPath !== 'string' || i.relPath.trim() === '') return { write: false, reason: 'no-path' }
  const mode = i.mode === undefined || i.mode === '' ? 'overwrite' : i.mode
  // ★ 20260925：**空文本这一道按 mode 分开**（`replace` 不再被它拦）——
  //   ⛔ 不许写成"空文本一律拒"（那样"纯删除"就没了），也⛔ 不许写成"一律放行"
  //   （`overwrite` + 空 = 清空整份、`append` + 空 = 空写，那两条必须继续拒）。
  if (typeof i.text !== 'string' || (mode !== 'replace' && i.text.trim() === '')) {
    return { write: false, reason: 'empty-text' }
  }
  if (!MEMORY_WRITE_MODES.includes(mode)) return { write: false, reason: 'bad-mode' }
  const maxChars = Number.isFinite(i.maxChars) ? Math.trunc(i.maxChars) : MEMORY_WRITE_MAX_CHARS
  if (i.text.length > maxChars) return { write: false, reason: 'over-budget', chars: i.text.length, maxChars }
  return { write: true, reason: 'ok', mode, chars: i.text.length }
}

/** 行尾的换行（含 CRLF 那个 `\r`）不算"这一行的内容" ⇒ 认标记 / 比限定行都用同一把尺子。 */
const lineBody = (line) => (line.endsWith('\r') ? line.slice(0, -1) : line)

/**
 * 标题行判据 —— 本单给的口径是 `/^#{1,6}\s/`；这里作用在**去掉行首缩进之后**的行上：
 * 带缩进的标题照样算标题（⛔ 不认它 ⇒ 会把作者那一整节吃进段里 —— 宁可少吃，不许多吃）。
 */
const isHeadingLine = (body) => /^#{1,6}\s/.test(body.trim())

/** `find` 的**第一行**（`\n` 之前那一段，两端 trim 后）**整行等于**标记 ⇒ 这一脚走**段模式**。 */
function isSelfMarkFind(find) {
  const nl = find.indexOf('\n')
  return lineBody(nl < 0 ? find : find.slice(0, nl)).trim() === NOTE_SELF_MARK
}

/**
 * 按行切（**带每行在原文里的偏移**）—— 段模式定位用。
 * `body` 不含行尾换行；`end` 含行尾那个换行（末行没有换行时 = 文末）。
 */
function splitLines(text) {
  const lines = []
  let start = 0
  for (;;) {
    const nl = text.indexOf('\n', start)
    lines.push({
      start,
      end: nl < 0 ? text.length : nl + 1,
      body: lineBody(nl < 0 ? text.slice(start) : text.slice(start, nl)),
    })
    if (nl < 0) break
    start = nl + 1
  }
  return lines
}

/**
 * ★ 20260925 **段模式**：`find` 的第一行是**标记行** ⇒ 认"标记那一整段"。
 *
 * 怎么定位（口径写死，⛔ 不猜）：
 *   · 按行扫现文，**整行 trim 后等于标记**的那些行才算标记行（行里夹着别的字**不算**）；
 *   · `find` 里标记行**之后**那些**非空行**是"限定行"（模型通常给紧跟的那个标题行，如 `## 最近进展`）——
 *     拿它在**多段并存**时唯一指定一段：这些行要**逐字**匹配紧随其后的那些行
 *     （空行两边都不参与分辨：段的边界本来就跳过空行；行首缩进/行尾空白不算字）；对不上 ⇒ 这一段不算命中；
 *   · 命中的**段数**：0 ⇒ `find-missing`；≥2 ⇒ `find-ambiguous`（沿用现有 reason 名，⛔ 不新造）。
 *
 * 段的边界（★ 本单的核心口径）：
 *   从那一行标记起
 *     → 跳过紧跟的空行
 *     → 若紧接着是标题行（`/^#{1,6}\s/`）⇒ 它是段头的一部分，一起吃掉
 *     → 往后吃到：下一个标记行 ／ 下一个标题行 ／ 文件末（三者取先到者）**之前**为止
 *   ⛔ 段里**不含**结尾那个标题行（那是别人的段头）⇒ 作者写的那几节一个字节都不会被吃掉。
 *
 * 示例（`find` = 标记行 ＋ `## 当前时间地点`）：从第二段那行标记起，吃掉它的标题行与正文
 *   （连它后面那个空行），停在 `## 作者的维护要求`（作者那节）**之前** —— 那节连同它的标题原样留着。
 *
 * @param {string} current 现文（调用方已保证是字符串）
 * @param {string} find 走段模式的 `find`（第一行是标记行）
 * @returns {{ hit:'one', start:number, end:number }|{ hit:'zero' }|{ hit:'many' }}
 *   `hit:'one'` 时 `[start, end)` 就是**被换掉的那一整段**（`text:''` ⇒ 整段删）。
 */
function locateSelfMarkSegment(current, find) {
  const lines = splitLines(current)
  const marks = []
  for (let n = 0; n < lines.length; n += 1) if (lines[n].body.trim() === NOTE_SELF_MARK) marks.push(n)
  if (marks.length === 0) return { hit: 'zero' }
  // "限定行" = `find` 里标记行之后的**非空行**（空行全丢：段边界本来就跳过空行 ⇒ 拿它当限定没有分辨力）
  const qualifier = splitLines(find).slice(1).map((l) => l.body.trim()).filter((s) => s !== '')
  const matches = (li) => {
    if (qualifier.length === 0) return true
    let k = 0
    for (let n = li + 1; n < lines.length && k < qualifier.length; n += 1) {
      if (lines[n].body.trim() === '') continue
      if (lines[n].body.trim() !== qualifier[k]) return false     // 逐字比（缩进/行尾空白不算字）
      k += 1
    }
    return k === qualifier.length
  }
  const hitLines = marks.filter(matches)
  if (hitLines.length === 0) return { hit: 'zero' }
  if (hitLines.length > 1) return { hit: 'many' }
  const li = hitLines[0]
  // 段头：标记行 → 跳过紧跟的空行 → 紧挨着的那个标题行也算段头（一起吃掉）
  let head = li + 1
  while (head < lines.length && lines[head].body.trim() === '') head += 1
  const eatHead = head < lines.length && isHeadingLine(lines[head].body)
  // 段的结尾：下一个标记行 ／ 下一个标题行 ／ 文件末（三者取先到者）—— 不含那行本身
  let end = current.length
  for (let n = eatHead ? head + 1 : li + 1; n < lines.length; n += 1) {
    if (lines[n].body.trim() === NOTE_SELF_MARK || isHeadingLine(lines[n].body)) { end = lines[n].start; break }
  }
  return { hit: 'one', start: lines[li].start, end }
}

/**
 * ★ 20260924：「**这一脚到底写什么**」的裁决（纯函数 —— ⛔ 不碰文件系统，两个入参给全就能算）。
 *
 * 口径（用户拍板）：**一份文件里，「作者预置的那部分」一个字都不许动；「你自己写的那部分」可以增、改、删。**
 * `replace` 就是"删掉过时那段"的手段：给**原文里逐字的一小段**（`find`）+ 新文本（`text`），
 * 只把那一小段换成新文本。⛔ **指不准一律拒收**（找不到 / 出现多次），**绝不猜** ——
 * "替换第一处"就是猜，猜错一次就把作者写的东西换掉了。
 *
 * 真值表（见 `_selftest-memory-write.mjs` 的 ★R / ★D 那两节）：
 *   replace：`find` 空 / 非字符串            ⇒ { ok:false, reason:'no-find' }
 *            `current === null`（文件不在）  ⇒ { ok:false, reason:'no-file' }（⛔ 新建不走 replace）
 *            `find` 出现 0 次                ⇒ { ok:false, reason:'find-missing' }
 *            `find` 出现 ≥2 次               ⇒ { ok:false, reason:'find-ambiguous' }（⛔ 不许"替换第一处"）
 *            正好 1 次                       ⇒ { ok:true, next:<那一处换成 text 之后的全文>, backup:true }
 *            ★ `text` 空串（20260925）       ⇒ **纯删除**：`next` = 把那一处**剪掉**的全文（上面那几条判据一字不变）
 *   ★ 20260925 **段模式**（`find` 的第一行就是标记行，见 `NOTE_SELF_MARK`）—— 判据与边界见
 *     `locateSelfMarkSegment`，**reason 名沿用上面那几个**（⛔ 不新造）：
 *            `find` 的第一行 = 标记行     ⇒ 认"标记那一整段"（不是那一小段字面）
 *            找不到那一段 / 限定行对不上 ⇒ { ok:false, reason:'find-missing' }
 *            命中 ≥2 段                   ⇒ { ok:false, reason:'find-ambiguous' }
 *            正好 1 段                    ⇒ { ok:true, next:<那一整段换成 text>, backup:true, replacedChars:段长 }
 *            `text` 空串                  ⇒ **整段删**（与"纯删除"同一条口径）
 *   overwrite ⇒ { ok:true, next:text, backup: current !== null }（**已存在**才要备份 —— 见下）
 *   append    ⇒ { ok:true, next:(current ?? '') + text, backup:false }（只往后加，不丢旧文）
 *   其余      ⇒ { ok:false, reason:'bad-mode' }
 *
 * ★ 20260925：**`replace` 的 `text` 允许是空串** —— 空串 = 把 `find` 指到的那一小段**整个剪掉**（"纯删除"）。
 *   这是**只有 `replace` 才有的**口径：`overwrite` 空文本（= 清空整份）与 `append` 空文本（= 什么都没写）
 *   由 `decideNoteWrite` 那道**按 mode 分开**的闸拒收，**根本到不了这里**。
 *   ⛔ 所以本函数里**不许**加"空文本一律拒"一道闸 —— 加了"删除"这个手段就没了。
 *
 * **为什么 overwrite / replace 要 `backup:true`**：它们**动的是已存在的文件**，而覆盖是**不可逆**的
 * （这一脚从前直接 `writeFileSync`，覆盖错了捞不回来）。真值 `backup` 的落实在 `applyNoteWrite`。
 * ⚠️ 新建（`current === null`）⇒ `backup:false`：没有旧文可备份，⛔ 不凭空造一份 `.bak-`。
 * ⚠️ `replacedChars` 只用于**如实播报**（替换掉多少字符 / 整份换掉多长 / **删掉那一段多长**），⛔ 不参与任何裁决。
 *
 * @param {{ current?: string|null, mode?: string, find?: unknown, text?: unknown }} input
 *   `current` = 现文（文件不存在 ⇒ `null`）。
 * @returns {{ ok:boolean, reason:string, next:string|null, backup:boolean, replacedChars:number }}
 */
export function planNoteWrite(input) {
  const i = input ?? {}
  const current = typeof i.current === 'string' ? i.current : null
  const text = typeof i.text === 'string' ? i.text : ''
  const mode = i.mode === undefined || i.mode === '' ? 'overwrite' : i.mode
  const no = (reason) => ({ ok: false, reason, next: null, backup: false, replacedChars: 0 })
  if (mode === 'replace') {
    const find = i.find
    // ⚠️ 纯空白 = 空（与 `decideNoteWrite` 的 path/text 同款口径）：`'   '` 当不了"原文里逐字的一小段"，
    //   当 find 用只会在现文里撞不到、给出一个含糊的 `find-missing` ⇒ 直接按"没给 find"拒。
    if (typeof find !== 'string' || find.trim() === '') return no('no-find')
    if (current === null) return no('no-file')
    // ★ 20260925：**段模式** —— `find` 的第一行就是那个标记行（`NOTE_SELF_MARK`）⇒ 认"标记那一整段"
    //   （怎么定位、边界在哪，全在 `locateSelfMarkSegment` 的注释里）。⛔ 第一行不是标记行 ⇒
    //   **一个字都不变**地走下面那套逐字模式（含"重叠出现算两处"那个 `at + 1` 的算法）。
    if (isSelfMarkFind(find)) {
      const seg = locateSelfMarkSegment(current, find)
      if (seg.hit !== 'one') return no(seg.hit === 'many' ? 'find-ambiguous' : 'find-missing')
      // `text` = **整段新内容**（模型要把它自己的标记行也写进去）；空串 ⇒ **整段删** —— 与"纯删除"
      // 是同一条口径（`decideNoteWrite` 已经把 `overwrite`/`append` 的空文本拦下了）⇒
      // ⛔ 别在这里另加一道"空文本拒收"（加了"整段删"就没了）。
      return {
        ok: true, reason: 'ok', backup: true, replacedChars: seg.end - seg.start,
        next: current.slice(0, seg.start) + text + current.slice(seg.end),
      }
    }
    const at = current.indexOf(find)
    if (at < 0) return no('find-missing')
    // ⛔ 多义 ⇒ 拒：出现 ≥2 次时，换哪一处都是**猜**（含**重叠**出现 —— 所以从 `at + 1` 再找一次，
    //   而不是从 `at + find.length`：`aaa` 里的 `aa` 也算两处）。
    if (current.indexOf(find, at + 1) >= 0) return no('find-ambiguous')
    // ★ 20260925：`text` 在这条路上**允许是空串** —— 空串 = 把这一小段**整个剪掉**（"纯删除"）。
    //   （`text` 不是字符串时上面那行已按空串算 —— 既有归一化，本单没动；"非字符串 ⇒ 拒"那道闸
    //   在 `decideNoteWrite`，⛔ 不在这一层。）
    return {
      ok: true, reason: 'ok', backup: true, replacedChars: find.length,
      next: current.slice(0, at) + text + current.slice(at + find.length),
    }
  }
  if (mode === 'overwrite') {
    return { ok: true, reason: 'ok', next: text, backup: current !== null, replacedChars: current === null ? 0 : current.length }
  }
  if (mode === 'append') {
    return { ok: true, reason: 'ok', next: (current ?? '') + text, backup: false, replacedChars: 0 }
  }
  return no('bad-mode')
}

/**
 * ★ 20260924：**落盘那一脚**（薄薄一层，依赖注入 ⇒ 台子能拿**真 fs** 在临时目录里跑真盘面；
 * 照 `lib/floor-snapshot.js` 的 `writeRestoredFile` 那种写法，⛔ 不另写一份备份实现）。
 *
 * - `backup === true` ⇒ 走 `io.writeWithBackup`（**先备份成 `<名>.bak-<stamp>` 再写**，写后回读校验）。
 *   接线那一脚喂的是 `lib/deadzone.js` 现成的那一个（`deadzone.writeWithBackup`）—— ⛔ 别自己再写一份。
 * - 其余（`backup === false`：新建 / append）⇒ 直接 `io.writeFileSync`（没有旧文可丢）。
 *
 * ⚠️ **`stamp` 里不许出现冒号**（Windows 文件名不允许）⇒ 调用方用 `deadzone.stampNow()` 那种形式；
 *   万一给了带冒号的戳，备份会退回"备份失败 ⇒ 一个字都没改"（失败即拒，⛔ 不会静默裸写）。
 * ⚠️ `next` 恒为**整份现文**（append 的拼接在 `planNoteWrite` 里就做完了）⇒ 这里只有"写全文"一条路；
 *   `io` 里那个 `appendFileSync` 是**接线那一侧**的 fs 面（形状给全），本函数不用它。
 *
 * @param {{ absPath?:unknown, next?:unknown, backup?:unknown, stamp?:unknown, io?:object }} input
 * @returns {{ ok:boolean, backupPath:string|null, bytes:number, reason:string }}
 */
export function applyNoteWrite(input) {
  const i = input ?? {}
  const io = i.io ?? {}
  const absPath = typeof i.absPath === 'string' ? i.absPath : ''
  const bad = (reason) => ({ ok: false, backupPath: null, bytes: 0, reason })
  if (absPath === '') return bad('没有落点路径（拒写）')
  if (typeof i.next !== 'string') return bad('没有正文（拒写）')
  if (i.backup === true) {
    if (typeof io.writeWithBackup !== 'function') {
      return bad('备份写盘（deadzone.writeWithBackup）不可用 ⇒ 拒写 —— 覆盖不可逆，⛔ 不裸写')
    }
    const r = io.writeWithBackup(absPath, i.next, i.stamp)
    if (r && r.ok === true) return { ok: true, backupPath: r.backupPath, bytes: r.bytes, reason: '' }
    return { ok: false, backupPath: (r && r.backupPath) ?? null, bytes: 0, reason: (r && r.reason) || '写盘失败（未说明原因）' }
  }
  if (typeof io.writeFileSync !== 'function') return bad('写盘函数不可用（拒写）')
  try {
    io.writeFileSync(absPath, i.next, 'utf8')
    return { ok: true, backupPath: null, bytes: Buffer.byteLength(i.next, 'utf8'), reason: '' }
  } catch (e) {
    return bad(`写盘失败（${e?.code || e?.message || e}）`)
  }
}
