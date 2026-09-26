// _selftest-memory-write.mjs —— lib/memory-write.js 的纯逻辑自检（⛔ 不碰真机、不碰周目）。
//
// 每组都带**反证**：不能只看"该写时写了"，还要看"开关关/空文本/超预算/坏模式时**一个字都不写**"。
//
// ★ 20260924 单（用户口径：「预设问题。ai 目前**不会删掉过时的 index 和 note 信息**」＋
//   「**告诉 ai：每轮都更新的记录，更新下一轮时删除上一轮**」）：新增 **`mode:'replace'`**
//   —— 给原文里逐字的一小段 + 新文本，只换那一小段；指不准（找不到 / 出现多次）**一律拒收**。
//   本台子加三节：★R = `planNoteWrite` 的**五相 + 反证**；★I = `applyNoteWrite` 的**三条真 IO**；
//   ★E = **端到端**（真 `apply()` + 真工具 `execute()`，连 enum / `find` / 描述一起钉）。
// ★ 20260925 单（收尾，用户拍板「**加手段吧**」）：`replace` 下 **`text` 留空 = 把 `find` 指到的那一段
//   **整个删掉**（"纯删除"）** —— 免得"删掉一整段"还得把相邻的行也抄进 `find`、再在 `text` 里原样留回来。
//   加一节 ★D（纯删除的**相 + 反证** ＋ 三种 mode 的空文本口径**并排**钉住），★I / ★E 各补真盘面 / 真工具。
//   ⚠️ ★I / ★E 是**唯二碰盘**的两节，夹具全在 `os.tmpdir()` 下的一次性目录里（★E 还临时改
//   `DSH_HOME` 与 Tavern 工作区指向）—— ⛔ 绝不落在周目目录 / 真机上，跑完各自删掉。
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from './lib/index.js'
import {
  MEMORY_WRITE_TOOL, MEMORY_WRITE_DIR, MEMORY_WRITE_MAX_CHARS, MEMORY_WRITE_MODES, NOTE_SELF_MARK,
  NOTES_MAINTENANCE_LIMIT_CHARS, notesMaintenanceHint,
  SANDBOX_MODES, readMemoryWriteSwitch, decideNoteWrite, foldSandboxMode, sandboxDecision,
  planNoteWrite, applyNoteWrite,
} from './lib/memory-write.js'
// ★I 那三条用的**真** `writeWithBackup`：与 lib/index.js 接线时喂进去的是**同一份**
//   （`deadzone.js` 的；⛔ 不在这里另写一份备份实现 —— 那就不是"接线那一脚真能用"了）。
import * as dz from './lib/deadzone.js'

let pass = 0
let fail = 0
const check = (label, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${cond ? '' : '  ← ' + String(extra)}`)
}

// ★ 20260925 单：**AI 自记标记**的字面 —— 本台子里只引用这一处（★M / ★I5 / ★E7 的判据全用它）。
//   **唯一真相是 `lib/memory-write.js` 的 `NOTE_SELF_MARK`**（★M⑧ 钉住"它就是那个字面"）；
//   persona §5 那一处一致不一致，由 `_selftest-preset-persona.mjs` 钉。
const MARK_M = NOTE_SELF_MARK

check('① 常量：工具名 memory_write、目录 .roleplay-memory（与社区预设同名）、模式三种', (() => {
  return MEMORY_WRITE_TOOL === 'memory_write' && MEMORY_WRITE_DIR === '.roleplay-memory'
    && JSON.stringify(MEMORY_WRITE_MODES) === JSON.stringify(['overwrite', 'append', 'replace'])
    && MEMORY_WRITE_MAX_CHARS === 20000
})())

// ───────── ② 开关（严格 true 才开；坏形状一律关且不抛）─────────
{
  const OFF = [undefined, null, [], 'x', 1, {}, { memoryWrite: null }, { memoryWrite: [] },
    { memoryWrite: {} }, { memoryWrite: { enabled: 'true' } }, { memoryWrite: { enabled: 1 } },
    { memoryWrite: { enabled: false } }]
  let allOff = true
  for (const v of OFF) {
    let got
    try { got = readMemoryWriteSwitch(v) } catch { got = { enabled: 'THREW' } }
    if (got.enabled !== false) { allOff = false; console.log('   ✗ 该关却没关：', JSON.stringify(v), JSON.stringify(got)) }
  }
  check('② 开关：坏形状/字符串 true/1/enabled:false ⇒ 一律关，且不抛', allOff)
  check('② 开关：enabled:true ⇒ 开', readMemoryWriteSwitch({ memoryWrite: { enabled: true } }).enabled === true)
  check('② 开关：maxChars 非法 ⇒ 回落默认；越界 ⇒ 夹住；小数 ⇒ 取整', (() => {
    const a = readMemoryWriteSwitch({ memoryWrite: { enabled: true, maxChars: 'x' } }).maxChars
    const b = readMemoryWriteSwitch({ memoryWrite: { enabled: true, maxChars: 1 } }).maxChars
    const c = readMemoryWriteSwitch({ memoryWrite: { enabled: true, maxChars: 1e9 } }).maxChars
    const d = readMemoryWriteSwitch({ memoryWrite: { enabled: true, maxChars: 5000.7 } }).maxChars
    return a === MEMORY_WRITE_MAX_CHARS && b === 200 && c === 200000 && d === 5000
  })())
}

// ───────── ③ 判据真值表 ─────────
{
  const ok = { enabled: true, relPath: 'notes.md', text: '一段笔记' }
  const rows = [
    ['③ switch-off：开关关 ⇒ 不写（⛔ 即便参数齐全）', { ...ok, enabled: false }, 'switch-off'],
    ['③ no-path：路径空/纯空白/非字符串 ⇒ 不写', { ...ok, relPath: '   ' }, 'no-path'],
    ['③ no-path：路径不是字符串 ⇒ 不写（⛔ 不 String 化）', { ...ok, relPath: 42 }, 'no-path'],
    ['③ empty-text：空文本/纯空白 ⇒ 不写（⛔ 不写空文件）', { ...ok, text: '\n  \n' }, 'empty-text'],
    ['③ bad-mode：不认识的状态 ⇒ 不写（⛔ 不回落成覆盖写）', { ...ok, mode: 'prepend' }, 'bad-mode'],
    ['③ over-budget：超预算 ⇒ **拒收**（⛔ 不截断硬写）', { ...ok, text: 'x'.repeat(MEMORY_WRITE_MAX_CHARS + 1) }, 'over-budget'],
    ['③ ok：参数齐全 ⇒ 写，默认模式 overwrite', ok, 'ok'],
    ['③ ok：append 显式给 ⇒ 按 append', { ...ok, mode: 'append' }, 'ok'],
    ['③ ok：replace 显式给 ⇒ 按 replace（★20260924 新增那一项）', { ...ok, mode: 'replace', find: '一段' }, 'ok'],
    ['③ ok：mode 空串 ⇒ 当默认 overwrite', { ...ok, mode: '' }, 'ok'],
  ]
  for (const [label, input, wantReason] of rows) {
    const got = decideNoteWrite(input)
    const wantWrite = wantReason === 'ok'
    check(label, got.write === wantWrite && got.reason === wantReason, JSON.stringify(got))
  }
  check('③ 边界反证：正好等于预算 ⇒ 放行；多一字符 ⇒ 拒收（判据是 > 不是 >=）', (() => {
    const exact = decideNoteWrite({ ...ok, text: 'x'.repeat(MEMORY_WRITE_MAX_CHARS), maxChars: MEMORY_WRITE_MAX_CHARS })
    const over = decideNoteWrite({ ...ok, text: 'x'.repeat(MEMORY_WRITE_MAX_CHARS + 1), maxChars: MEMORY_WRITE_MAX_CHARS })
    return exact.write === true && over.write === false && over.reason === 'over-budget' && over.chars === MEMORY_WRITE_MAX_CHARS + 1
  })())
  check('③ ★反证：undefined/空对象 ⇒ 一律不写且不抛', (() => {
    const a = decideNoteWrite(undefined)
    const b = decideNoteWrite({})
    return a.write === false && a.reason === 'switch-off' && b.write === false && b.reason === 'switch-off'
  })())
}

// ───────── ★R（20260924 单）：`planNoteWrite` —— 「只换那一小段，指不准一律拒收」─────────
//   口径（任务书 §2）：一份文件里「作者预置的那部分」一个字都不许动；「模型自己写的那部分」可以增、改、删。
//   模型清理自己的过时段落 ⇒ 用 `replace`：给**原文里逐字的一小段** + 新文本，**只替换那一小段**。
//   ⛔ 指不准（找不到 / 出现多次）**一律拒收**，**绝不猜**（"替换第一处"就是猜）。
{
  const AUTHOR = '## 【必须遵守的核心规则】\n- 作者写的规则：一个字都不许动'
  const STALE = '第 3 场：两人在码头分手（**旧**）'
  const TAIL = '## 下次续写提示\n从码头的雨夜接着写'
  const CUR = [AUTHOR, '', '## 最近进展', STALE, '', TAIL].join('\n')
  const FRESH = '第 4 场：天亮后各自回城（**新**）'

  // ① 相：find 正好出现 1 次 ⇒ 落地，且**只动那一处**
  const p1 = planNoteWrite({ current: CUR, mode: 'replace', find: STALE, text: FRESH })
  check('★R① replace（find 唯一）⇒ ok，next 里那一处真的被换掉、旧文不再出现',
    p1.ok === true && p1.reason === 'ok' && p1.next.includes(FRESH) === true && p1.next.includes(STALE) === false,
    JSON.stringify(p1).slice(0, 200))
  check('★R①★ 别处**一个字没变**（作者那两段逐字还在；全文 = 原文只挖掉 find、原位塞进新文本）',
    (() => {
      const at = CUR.indexOf(STALE)
      const want = CUR.slice(0, at) + FRESH + CUR.slice(at + STALE.length)
      return p1.next === want && p1.next.includes(AUTHOR) === true && p1.next.includes(TAIL) === true
        && p1.next.length === CUR.length - STALE.length + FRESH.length
    })(), JSON.stringify(p1.next).slice(0, 200))
  check('★R①★★ 覆盖前**必须备份**（replace 动了已存在的文件 ⇒ backup:true；替换掉的字符数照实报）',
    p1.backup === true && p1.replacedChars === STALE.length)

  // ② 相：find 在现文里找不到 ⇒ 拒收
  const p2 = planNoteWrite({ current: CUR, mode: 'replace', find: '第 9 场：根本没写过的一句', text: FRESH })
  check('★R② find 找不到 ⇒ 拒收（⛔ 不猜、⛔ 不新建）', p2.ok === false && p2.reason === 'find-missing',
    JSON.stringify(p2).slice(0, 200))

  // ③ 相：find 出现 2 次 ⇒ 拒收（多义）；★反证：把"≥2 次 ⇒ 拒"挖掉改成"替换第一处" ⇒ 本相必红
  const TWICE = '## 最近进展\n同样一句\n\n## 上次进展\n同样一句\n'
  const p3 = planNoteWrite({ current: TWICE, mode: 'replace', find: '同样一句', text: '换成新的' })
  check('★R③ find 出现 2 次 ⇒ 拒收（**多义不猜** —— 换哪一处都是猜）',
    p3.ok === false && p3.reason === 'find-ambiguous', JSON.stringify(p3).slice(0, 200))
  check('★R③反证：把"≥2 次 ⇒ 拒"挖掉、改成"替换第一处"（上一版最省事的写法）⇒ 上面那条必红',
    (() => {
      const wrong = (cur, find) => cur.indexOf(find) >= 0     // ← 挖掉"多义检查"之后的判据：找到就动手
      return wrong(TWICE, '同样一句') === true && p3.ok === false
    })())

  // ④ 相：find 空 / 非字符串 ⇒ 拒收
  const p4 = [undefined, '', '   ', 42, null, {}].map((find) => planNoteWrite({ current: CUR, mode: 'replace', find, text: FRESH }))
  check('★R④ find 空 / 纯空白 / 非字符串 ⇒ 拒收（reason:no-find；⛔ 不拿空串当 find）',
    p4.every((r) => r.ok === false && r.reason === 'no-find'), JSON.stringify(p4).slice(0, 200))

  // ⑤ 相：文件还不存在 ⇒ 拒收（⛔ 新建不走 replace —— 没有"原文"可指）
  const p5 = planNoteWrite({ current: null, mode: 'replace', find: STALE, text: FRESH })
  check('★R⑤ current === null（文件不在）⇒ 拒收（reason:no-file；⛔ replace 不是新建手段）',
    p5.ok === false && p5.reason === 'no-file', JSON.stringify(p5).slice(0, 200))

  // 另外两种模式的形状（备份语义就在这几条上：覆盖**已存在**的才要备份；追加/新建不备份）
  const ow = planNoteWrite({ current: CUR, mode: 'overwrite', text: FRESH })
  const owNew = planNoteWrite({ current: null, mode: 'overwrite', text: FRESH })
  const ap = planNoteWrite({ current: CUR, mode: 'append', text: FRESH })
  const apNew = planNoteWrite({ current: null, mode: 'append', text: FRESH })
  check('★R⑥ overwrite ⇒ next = text；**已存在 ⇒ backup:true**（整份被换掉，replacedChars = 原文全长）',
    ow.ok === true && ow.next === FRESH && ow.backup === true && ow.replacedChars === CUR.length)
  check('★R⑥b overwrite 但文件不在（新建）⇒ backup:false（没有旧文可备份，⛔ 不凭空造一份 .bak-）',
    owNew.ok === true && owNew.next === FRESH && owNew.backup === false && owNew.replacedChars === 0)
  check('★R⑥c append ⇒ next = 现文 + text，**不备份**（只往后加，不丢旧文）',
    ap.ok === true && ap.next === CUR + FRESH && ap.backup === false && ap.replacedChars === 0
    && apNew.ok === true && apNew.next === FRESH && apNew.backup === false)
  check('★R⑧ 坏模式 ⇒ 拒收（reason:bad-mode；⛔ 不回落成覆盖写）',
    planNoteWrite({ current: CUR, mode: 'prepend', text: FRESH }).reason === 'bad-mode'
    && planNoteWrite({ current: CUR, mode: '', text: FRESH }).reason === 'ok'
    && planNoteWrite({ current: CUR, text: FRESH }).mode === undefined)
  check('★R⑨ 纯函数：认不出的入参也算得出来、⛔ 不抛（`current` 非字符串 ⇒ 当"文件不在"）',
    planNoteWrite(undefined).ok === true && planNoteWrite(undefined).reason === 'ok'   // ⇒ 默认模式 = overwrite
    && planNoteWrite({}).ok === true && planNoteWrite({}).next === ''
    && planNoteWrite({ current: 42, mode: 'overwrite', text: 'x' }).ok === true
    && planNoteWrite({ current: 42, mode: 'overwrite', text: 'x' }).backup === false
    && planNoteWrite({ current: 42, mode: 'replace', find: 'x', text: 'y' }).reason === 'no-file',
    JSON.stringify([planNoteWrite(undefined), planNoteWrite({ current: 42, mode: 'replace', find: 'x', text: 'y' })]).slice(0, 200))
}

// ───────── ★D（20260925 单）：`replace` + `text:''` = **纯删除那一段** ─────────
//   用户口径（收尾拍板）：「**加手段吧**」。上一单交付的写法里，模型想删掉一整段，得把**前后相邻的行**
//   也写进 `find`、再在 `text` 里**原样留回来** —— 别扭，而且多抄一遍就多一次抄错的机会。
//   现在：`replace` 下 `text` 留空 = 把 `find` 指到的那一小段**整个剪掉**（"纯删除"）。
//   ★ 这道"空文本"的闸**按 mode 分开**（⛔ 别"顺手统一"成一种口径）：`overwrite` 空 ⇒ 拒、
//     `append` 空 ⇒ 拒、`replace` 空 ⇒ 放行 —— ★D③ 把三条**并排**钉在一起。
//   相 / 反证 / 口径分叉都在这一节：★D① 是相、★D② 是它的反证、★D③ 是并排那三条 + 反证。
{
  const AUTHOR_D = '## 【必须遵守的核心规则】\n- 作者写的规则：一个字都不许动'
  const STALE_D = '第 3 场：两人在码头分手（**旧**）'
  const TAIL_D = '## 下次续写提示\n从码头的雨夜接着写'
  const CUR_D = [AUTHOR_D, '', '## 最近进展', STALE_D, '', TAIL_D].join('\n')
  const CUT_AT = CUR_D.indexOf(STALE_D)
  const WANT_CUT = CUR_D.slice(0, CUT_AT) + CUR_D.slice(CUT_AT + STALE_D.length)

  // ① 相（**整条链**：闸 → 计划）：`replace` + `text:''` 既过得了 `decideNoteWrite`，又真的只剪那一小段
  //   ⚠️ 两层的活不一样：**拦空文本的闸在 `decideNoteWrite`**（20260925 单改的就是它），
  //     `planNoteWrite` 本来就把 `text` 原样拼进去（空串 ⇒ 剪掉）。所以相要**两层一起**看。
  const dec = decideNoteWrite({ enabled: true, relPath: 'index.md', mode: 'replace', find: STALE_D, text: '' })
  const del = planNoteWrite({ current: CUR_D, mode: 'replace', find: STALE_D, text: '' })
  check('★D① replace + text:\'\'（纯删除）⇒ **整条链放行**：decide 说"写"（reason:ok / chars:0）'
    + '且 plan 的 next **逐字等于**"把 find 那一段剪掉"（⛔ 不是清空、⛔ 不是整份重写）',
    dec.write === true && dec.reason === 'ok' && dec.chars === 0
    && del.ok === true && del.reason === 'ok' && del.next === WANT_CUT,
    JSON.stringify({ dec, del }).slice(0, 240))
  check('★D①★ 别处**一个字没变**：作者那段与"下次续写提示"逐字还在，那一段整段没了（长度 = 原文 − find 那一段）',
    del.next.includes(AUTHOR_D) === true && del.next.includes(TAIL_D) === true
    && del.next.includes(STALE_D) === false && del.next.length === CUR_D.length - STALE_D.length,
    JSON.stringify(del.next).slice(0, 200))
  check('★D①★★ 删除前**照样先备份**（replace 恒 backup:true；删掉多少字符照实报）—— ⛔ 删除也要可撤销',
    del.backup === true && del.replacedChars === STALE_D.length)

  // ② 反证：把"replace 允许空"挖掉（回到上一版那道**不分 mode**的闸：空文本一律拒收）⇒ ★D① 那一相必红
  check('★D②反证：把"replace 允许空"挖掉（回到上一版那道**不分 mode**的闸：空文本一律拒收）⇒ ★D① 必红',
    (() => {
      const legacyGate = (text) => (typeof text !== 'string' || text.trim() === '')   // ← 上一版：不分 mode
      // 旧闸下这一脚**在闸上就被拒**（根本到不了 plan）⇒ ★D① 那条"整条链放行"必红；
      // 现闸下它一路走到底、给出"剪掉那一段"的 next ⇒ 差别**只在闸那一处**（正是本单改的那一处）。
      const legacyVerdict = legacyGate('') ? 'rejected' : 'passed'
      return legacyVerdict === 'rejected' && dec.write === true && del.ok === true && del.next === WANT_CUT
    })())

  // ③ ★口径分叉：**同一份夹具 + 同一个 `text:''`**，三种 mode 的裁决并排（`decideNoteWrite` 那道闸）
  const gateArgs = { enabled: true, relPath: 'index.md', text: '' }
  const gOver = decideNoteWrite({ ...gateArgs, mode: 'overwrite' })
  const gApp = decideNoteWrite({ ...gateArgs, mode: 'append' })
  const gRep = decideNoteWrite({ ...gateArgs, mode: 'replace' })
  check('★D③ ★口径分叉（三条并排，同一份夹具）：`overwrite` + text:\'\' ⇒ **拒**、`append` + text:\'\' ⇒ **拒**、'
    + '`replace` + text:\'\' ⇒ **放行**（⛔ 免得以后有人"顺手统一"成一种口径）',
    gOver.write === false && gOver.reason === 'empty-text'
    && gApp.write === false && gApp.reason === 'empty-text'
    && gRep.write === true && gRep.reason === 'ok' && gRep.mode === 'replace' && gRep.chars === 0,
    JSON.stringify([gOver, gApp, gRep]))
  check('★D③反证：把三种口径"顺手统一"（一律拒 ⇒ replace 那条红；一律放行 ⇒ 另两条红）⇒ ★D③ 必红',
    (() => {
      const w = [gOver.write, gApp.write, gRep.write]
      const allReject = w.every((x) => x === false)   // 统一成"空文本一律拒"（上一版）
      const allPass = w.every((x) => x === true)      // 统一成"空文本一律放行"
      return allReject === false && allPass === false && gRep.write === true && gRep.chars === 0
    })())
  check('★D④ `replace` 的 `text` **必须是字符串**（空串才算"留空"）：undefined / 42 / null / {} ⇒ 照旧拒'
    + '（reason:empty-text）—— ⛔ 不替模型把"没给 / 给错类型"猜成空',
    [undefined, 42, null, {}].every((t) => {
      const r = decideNoteWrite({ ...gateArgs, mode: 'replace', text: t })
      return r.write === false && r.reason === 'empty-text'
    }))
  check('★D⑤ 两层分工：`planNoteWrite` 那一层**不分 mode**地"非字符串 / 没给 ⇒ 当空串"（既有归一化，本单没动）'
    + '⇒ replace 下也是纯删；**拦非字符串的活是 `decideNoteWrite` 那道闸**（★D④）',
    planNoteWrite({ current: CUR_D, mode: 'replace', find: STALE_D }).next === WANT_CUT
    && planNoteWrite({ current: CUR_D, mode: 'replace', find: STALE_D, text: undefined }).next === WANT_CUT)
}

// ───────── ★M（20260925 单）：**自记标记 ＋ 段模式** —— `find` 给标记行 ⇒ 认"那一整段"─────────
//   用户口径（逐字）：「**加一个准则，ai自己生成的内容需要标记。**」＋「另外，它现在并没有删除内容的工具是吗」。
//   第二问的答：**有**（`replace` ＋ `text:''`），但**形状**不对 —— 上一版要求 `find` 是原文里**逐字的一小段**，
//   "删掉上一轮那一段"实际要求模型**把上一整段逐字抄进 `find`**，抄错一个字符就被拒。
//   真机现场（某周目 `index.md`）：模型一轮加一段 `## 最近进展（更新）`、堆了 **50 份**，
//   「导演笔记」**0** 次 —— 它不是偷懒，是在绕开一个它做不到的动作。
//   ⇒ 这一节钉住新形状：**标记行独占一行**（`〔AI 自记〕`），`find` 的**第一行**是它 ⇒ **整段换 / 整段删**；
//     `find` 里再带上紧跟的那个标题行 ⇒ **多段并存**时指定是哪一段。
//   ⛔ 段的边界不含结尾那个标题行（那是别人的段头）⇒ 作者写的那几节一个字节都不会被吃掉。
{
  const MARK = MARK_M      // ← 实现落地后就是 `NOTE_SELF_MARK` 本身（两者一致由 ★M⑧ 钉住）
  /**
   * 取 `plan` 算出来的全文；**被拒时是 `''`** —— ⛔ 拒收时 `next` 是 `null`，
   * 直接 `.includes(...)` 会把台子**摔死**（要的是 FAIL，不是崩溃：见 ★E5c 那条的口径）。
   */
  const nx = (r) => (typeof r?.next === 'string' ? r.next : '')
  // 夹具照任务书的 worked example（缩到两段，够钉边界了）：
  //   段一 `## 最近进展` ─ 段二 `## 当前时间地点` ─ 末尾一节**作者写的**（⛔ 一个字节都不许被吃掉）。
  //   期望值一律写成"这几块拼起来"（⛔ 不是另写一份实现再算一遍 —— 那样错了会一起错）。
  const SEG1 = [MARK, '## 最近进展', '- 第三场：A 把料压在透辉石处', ''].join('\n') + '\n'
  const SEG2 = [MARK, '## 当前时间地点', '2066 年 · 9 月 23 日 · 黄昏 19:37', ''].join('\n') + '\n'
  const TAIL = '## 作者的维护要求\n- 只写已发生的事\n'
  const CUR = SEG1 + SEG2 + TAIL
  const FIND2 = MARK + '\n## 当前时间地点'

  // ① 相：`find` = 标记行 ＋ 紧跟的标题行 ⇒ 换掉**那一整段**（标记行＋标题＋正文），结尾那个标题行原样留着
  const NEW2 = [MARK, '## 当前时间地点', '2066 年 · 9 月 24 日 · 清晨 06:10', ''].join('\n') + '\n'
  const rep = planNoteWrite({ current: CUR, mode: 'replace', find: FIND2, text: NEW2 })
  check('★M① 段模式（换）：`find` = 标记行＋紧跟的标题行 ⇒ 只换掉"标记行＋那一行标题＋它的正文"，'
    + '结尾那个标题行（`## 作者的维护要求`）原样留着',
    rep.ok === true && rep.reason === 'ok' && rep.next === SEG1 + NEW2 + TAIL
    && nx(rep).includes(TAIL) === true, JSON.stringify(rep).slice(0, 240))
  check('★M①★ 别处**一个字没变**：段一逐字还在、作者那节逐字还在（⛔ 段里不含结尾那个标题行）；'
    + '替换掉的字符数照实报 = 被换掉那一段的长度',
    nx(rep).includes(SEG1) === true && rep.backup === true && rep.replacedChars === SEG2.length,
    JSON.stringify({ at: nx(rep).indexOf(SEG1), replacedChars: rep.replacedChars, want: SEG2.length }))

  // ② 反证（★M①/③ 那一对的核心）：把"段的结尾边界"（下一个**标题行**也算边界）挖掉
  //    ⇒ 只剩"下一个标记行"这一条 ⇒ 会把作者那一整节也吃掉 ⇒ 上面"逐字节等于"必红。
  const del = planNoteWrite({ current: CUR, mode: 'replace', find: FIND2, text: '' })
  check('★M② 段模式（删）：`text:\'\'` ⇒ **整段删** —— 前后一个字节都没多删（逐字节等于"把那一整段剪掉"）',
    del.ok === true && del.next === SEG1 + TAIL && del.backup === true && del.replacedChars === SEG2.length,
    JSON.stringify(del).slice(0, 240))
  check('★M②反证：把"段的结尾边界"挖掉（只认下一个**标记行** ⇒ 上一版最省事的写法）⇒ ★M② 那条"逐字节等于"必红'
    + '（它会把作者那一节连标题一起吃掉）',
    (() => {
      const naiveNext = CUR.slice(0, CUR.indexOf(SEG2)) + CUR.slice(CUR.length)   // ← 只在下一个标记行停；本夹具后面没有标记行 ⇒ 一路吃到文末
      return naiveNext !== del.next && naiveNext.includes('作者的维护要求') === false
        && nx(del).includes('作者的维护要求') === true
    })(), JSON.stringify(del.next).slice(0, 240))
  check('★M②反证（同一处的另一面）：段尾边界松一格（把结尾那个标题行也吃进段里）⇒ 同样必红'
    + '（作者那节的标题会没掉，只剩正文）',
    (() => {
      const naiveEatHead = CUR.slice(0, CUR.indexOf(SEG2)) + CUR.slice(CUR.indexOf(TAIL) + '## 作者的维护要求\n'.length)
      return naiveEatHead !== del.next && naiveEatHead.includes('## 作者的维护要求') === false
        && nx(del).includes('## 作者的维护要求') === true
    })())

  // ③ 相：**四段并存**（真机形状：`index.md` 里那几段各自带标记）⇒ 指定其中一段，**其余三段一个字不变**
  const A4 = [MARK, '## 最近进展', '- 第三场：A 把料压在透辉石处', ''].join('\n') + '\n'
  const B4 = SEG2
  const C4 = [MARK, '## 下次续写提示', '从码头的雨夜接着写', ''].join('\n') + '\n'
  const D4 = [MARK, '## 导演笔记', '- 底层的设局者还没露面', ''].join('\n') + '\n'
  const FOUR = A4 + B4 + C4 + D4 + TAIL
  const del4 = planNoteWrite({ current: FOUR, mode: 'replace', find: MARK + '\n## 导演笔记', text: '' })
  check('★M③ 四段并存 ⇒ 指定「导演笔记」那一段：只它没了，其余三段（最近进展／当前时间地点／下次续写提示）'
    + '与作者那节**逐字**还在（逐字节等于手工剪出来的那份）',
    del4.ok === true && del4.next === A4 + B4 + C4 + TAIL && nx(del4).includes(A4) === true
    && nx(del4).includes(C4) === true && del4.replacedChars === D4.length,
    JSON.stringify(del4).slice(0, 240))
  const rep4 = planNoteWrite({ current: FOUR, mode: 'replace', find: MARK + '\n## 下次续写提示', text: [MARK, '## 下次续写提示', '从白天的官道接着写', ''].join('\n') + '\n' })
  check('★M③b 同上（换那一段）：只有「下次续写提示」那一段变，另外三段与作者那节逐字不动',
    rep4.ok === true && rep4.next === A4 + B4 + [MARK, '## 下次续写提示', '从白天的官道接着写', ''].join('\n') + '\n' + D4 + TAIL,
    JSON.stringify(rep4.next).slice(0, 240))
  check('★M③反证：**不看** `find` 里那一行标题（只认"第一处标记行"）⇒ 上面两条必红'
    + '（`find` 写着「导演笔记」，动手的却是「最近进展」那一段）',
    (() => {
      const wrongAt = FOUR.indexOf(MARK)                       // ← 拿第一处标记行就动手
      const wrongDel = FOUR.slice(0, wrongAt) + FOUR.slice(wrongAt + A4.length)
      return wrongDel === B4 + C4 + D4 + TAIL && wrongDel !== del4.next
        && wrongDel.includes(A4) === false && nx(del4).includes(A4) === true
    })())

  // ④ 相：标记**夹在行中间**（`〔AI 自记〕 ## 最近进展` / `- 〔AI 自记〕`）⇒ **不算**标记行
  //    ⇒ 走逐字模式、照旧唯一性子串裁决（⛔ 不是"看见字面就当段模式"）
  //    ⚠️ 那两处"行中间的标记"由 `MARK` 拼出来（台子里⛔ 不再多写一份字面）。
  const INLINE1 = MARK + ' ## 最近进展'
  const INLINE2 = '- ' + MARK
  const REAL1 = [MARK, '## 最近进展', '- 第一场：雨夜', ''].join('\n') + '\n'
  const MIX = REAL1
    + '## 作者的一节（举例子用的）\n'
    + '- 例如：' + INLINE1 + ' 就是**行中间**的写法，不算标记行\n'
    + '- 又例如：' + INLINE2 + ' 也不独占一行\n'
    + '\n'
  const mix1 = planNoteWrite({ current: MIX, mode: 'replace', find: INLINE1, text: '（换掉的是行中间那一段，不是真标记段）' })
  check('★M④ 标记夹在行中间（`' + INLINE1 + '`，行里还有别的字）⇒ **不算**标记行 ⇒ 走**逐字模式**：'
    + '换掉的正好是那一小段字面（`replacedChars` = 它的长度），真的那一段标记段**一字未动**',
    mix1.ok === true && mix1.replacedChars === INLINE1.length
    && mix1.next === MIX.slice(0, MIX.indexOf(INLINE1)) + '（换掉的是行中间那一段，不是真标记段）' + MIX.slice(MIX.indexOf(INLINE1) + INLINE1.length)
    && nx(mix1).includes(REAL1) === true, JSON.stringify(mix1).slice(0, 240))
  const mix2 = planNoteWrite({ current: MIX, mode: 'replace', find: INLINE2, text: '（行首那个 `- ` 也让它不算标记行）' })
  check('★M④b 同上（`' + INLINE2 + '`：行首有 `- `）⇒ 照旧逐字模式（`replacedChars` = 它的长度，不是段长）',
    mix2.ok === true && mix2.replacedChars === INLINE2.length && nx(mix2).includes(REAL1) === true,
    JSON.stringify(mix2).slice(0, 240))
  check('★M④反证：把"**整行** trim 后等于标记"松成"**含**标记"（`find.includes(MARK)`）⇒ ★M④ 必红：'
    + '那两条会被当成段模式，去换真的那一段（`replacedChars` 变成段长、真段也没了）',
    (() => {
      const loose = INLINE1.includes(MARK) && INLINE2.includes(MARK)   // ← 松掉的判据：行里含标记就算
      return loose === true && mix1.replacedChars !== REAL1.length && mix2.replacedChars !== REAL1.length
    })())

  // ⑤ 反证：`find` 只给标记行、而文件里有 4 处 ⇒ **多义 ⇒ 拒**（⛔ 不许"替换第一处"）
  const amb = planNoteWrite({ current: FOUR, mode: 'replace', find: MARK, text: 'x' })
  check('★M⑤反证：`find = \'' + MARK + '\'` 而文件里有 4 处 ⇒ **find-ambiguous**（沿用现有 reason 名，⛔ 不新造；'
    + '`next` 必须是 null —— ⛔ 不许"替换第一处"）',
    amb.ok === false && amb.reason === 'find-ambiguous' && amb.next === null, JSON.stringify(amb).slice(0, 200))
  check('★M⑤反证（同一处的另一面）：把"多义 ⇒ 拒"挖掉、改成"换第一处"⇒ 上面那条必红',
    (() => {
      const wrong = (cur, find) => cur.indexOf(find) >= 0      // ← 挖掉多义检查：找到就动手
      return wrong(FOUR, MARK) === true && amb.ok === false
    })())

  // ⑥ 反证：标记行后面直接是**文件末** ⇒ 段 = 标记行本身（不炸、不吐空）
  const EOF1 = '## 作者\n- 只写已发生的事\n\n' + MARK
  const atEof = planNoteWrite({ current: EOF1, mode: 'replace', find: MARK, text: '' })
  check('★M⑥反证：标记行后面直接是**文件末** ⇒ 段＝**标记行本身**（不炸、不吐空）：正好剪掉那一行、'
    + '前面那一节逐字还在，`replacedChars` = 标记行的长度（⛔ 不是 0）',
    atEof.ok === true && atEof.next === '## 作者\n- 只写已发生的事\n\n' && atEof.replacedChars === MARK.length,
    JSON.stringify(atEof).slice(0, 200))
  const only = planNoteWrite({ current: MARK, mode: 'replace', find: MARK, text: '' })
  const onlyPut = planNoteWrite({ current: MARK, mode: 'replace', find: MARK, text: MARK + '\n## 新段\n正文\n' })
  check('★M⑥b 同上（整份就只有那一行标记）：删 ⇒ 空文（`ok` 仍为 true、`replacedChars` = 标记行长度）；'
    + '给 `text` ⇒ 就是整段新内容（标记行不算"没有段"）',
    only.ok === true && only.next === '' && only.replacedChars === MARK.length
    && onlyPut.ok === true && onlyPut.next === MARK + '\n## 新段\n正文\n',
    JSON.stringify({ only, onlyPut }).slice(0, 240))

  // ⑦ 反证：文件里**一处标记都没有** / 标记后面那一行对不上 ⇒ find-missing
  const noMark = planNoteWrite({ current: TAIL, mode: 'replace', find: MARK, text: 'x' })
  check('★M⑦反证：文件里**一处标记都没有** ⇒ find-missing（⛔ 不许凭空造一段）',
    noMark.ok === false && noMark.reason === 'find-missing', JSON.stringify(noMark).slice(0, 200))
  const misTitle = planNoteWrite({ current: FOUR, mode: 'replace', find: MARK + '\n## 不存在的标题', text: 'x' })
  check('★M⑦b 标记行找到了、但它后面跟的不是 `find` 里写的那一行 ⇒ **find-missing**'
    + '（⛔ 不许"对不上就当第一段" —— 那正是会误删别人内容的那一脚）',
    misTitle.ok === false && misTitle.reason === 'find-missing', JSON.stringify(misTitle).slice(0, 200))

  // ⑧ 相：常量与"两处一致"
  check('★M⑧（相）常量：`NOTE_SELF_MARK` 就是 persona §5 里写的那个字面（逐字，一个字符都不许改）',
    MARK === '〔AI 自记〕', JSON.stringify(MARK))
  const hostSrcM = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8')
  check('★M⑧b ★唯一真相：`lib/index.js` 里的标记**只从常量来**（引用 `NOTE_SELF_MARK`、⛔ 没把字面重打一遍）—— '
    + '重打一遍就迟早两处不一致（persona §5 那一处一致不一致由 `_selftest-preset-persona.mjs` 钉）',
    hostSrcM.includes('NOTE_SELF_MARK') && hostSrcM.includes(MARK) === false,
    `引用=${hostSrcM.includes('NOTE_SELF_MARK')} 重打=${hostSrcM.includes(MARK)}`)

  // ⑨ 逐字模式那几条判据**一个字都没动**（本单只**加**了一条"第一行是标记行"的分岔）：
  //   重叠出现照旧算两处（`aa` 在 `aaa` 里 ⇒ 两处 ⇒ find-ambiguous）；不是标记行开头的 find 照旧走逐字模式。
  const overlap = planNoteWrite({ current: 'aaa', mode: 'replace', find: 'aa', text: 'X' })
  const plain = planNoteWrite({ current: 'X\n- 第 2 轮：天亮\nY\n', mode: 'replace', find: '第 2 轮：天亮', text: '第 3 轮：回城' })
  check('★M⑨ 逐字模式照旧：重叠出现算两处（`aa` 在 `aaa` 里 ⇒ find-ambiguous，`at + 1` 那套算法没动）；'
    + '不是标记行开头的 `find` 照旧逐字替换（段模式**没有**把它挤掉）',
    overlap.ok === false && overlap.reason === 'find-ambiguous'
    && plain.ok === true && plain.next === 'X\n- 第 3 轮：回城\nY\n',
    JSON.stringify({ overlap, plain }).slice(0, 240))
}

// ───────── ★U（20260926 单）：**撞单次上限 ⇒ "该优化了"** ＋ `replace` 的**瘦身**那一路 ─────────
//   用户口径（逐字）：「重新设计下记忆写入功能，改为**到上限时自动提示需要优化**。同步**轻量化提示词**」。
//   病根：上一版撞上限只回一句「拆成两次写」—— 那只会让笔记**更长**（笔记长胖正是撞上限的成因）。
//   ★ 本单**只改文案与给模型的下一步动作**：判据一个字没动（`over-budget` 仍是"`text` 超 `maxChars` ⇒ 拒收"，
//     ⛔ 不新造阈值、⛔ 不改上限数值、⛔ 不加自动压缩/自动删除）。
//   ★U① 钉"闸不分 mode ＋ 上限只有一个来源"；★U② 钉「**瘦身本来就过得了**」—— 回执里那三条出路
//   （`replace` 成空 / 最早场记压成一行 / `index.md` 按骨架整段换掉）落地时每一脚都要走它；
//   ★ 任务书 §2.3 追问的就是这一路：`replace` 的 `text` **也**受同一个上限管，但那**不妨碍**瘦身 ——
//     闸看的是 `text` 的**长度**，⛔ 不是结果文件的长度，也不是 `find` 的长度。
//   ⚠️ 回执那段**字面**（三件事都在不在、顺序是不是"先优化、再写"）由真工具那一侧钉：★E9 / ★E9b / ★E9c。
{
  const LONG = 'x'.repeat(501)
  const gOver = decideNoteWrite({ enabled: true, relPath: 'notes.md', mode: 'overwrite', text: LONG, maxChars: 500 })
  const gApp = decideNoteWrite({ enabled: true, relPath: 'notes.md', mode: 'append', text: LONG, maxChars: 500 })
  const gRep = decideNoteWrite({ enabled: true, relPath: 'notes.md', mode: 'replace', find: 'x', text: LONG, maxChars: 500 })
  check('★U① ★闸**不分 mode**：同一份上限（500）下 501 字符的 `text`，overwrite / append / replace 一律 over-budget'
    + '（⛔ 没给 replace 开小门），且数字照给（chars / maxChars）—— `replace` 的 `text` 也受同一个上限管',
    [gOver, gApp, gRep].every((r) => r.write === false && r.reason === 'over-budget'
      && r.chars === 501 && r.maxChars === 500), JSON.stringify([gOver, gApp, gRep]))
  check('★U①b 边界仍按**配置给的那个数**算（正好 500 ⇒ 放行、501 ⇒ 拒）：⛔ 没新造阈值、⛔ 没改默认值',
    decideNoteWrite({ enabled: true, relPath: 'notes.md', text: 'x'.repeat(500), maxChars: 500 }).write === true
    && decideNoteWrite({ enabled: true, relPath: 'notes.md', text: 'x'.repeat(501), maxChars: 500 }).write === false
    && readMemoryWriteSwitch({ memoryWrite: { enabled: true } }).maxChars === MEMORY_WRITE_MAX_CHARS
    && MEMORY_WRITE_MAX_CHARS === 20000)
  check('★U①反证：给 `replace` 开一道小门（"replace 不算预算"那种最顺手的写法）⇒ ★U① 必红',
    (() => {
      const withDoor = (mode) => (mode === 'replace' ? 'passed' : 'over-budget')   // ← 挖掉"一视同仁"
      return withDoor('replace') === 'passed' && gRep.reason === 'over-budget' && gRep.write === false
    })())

  // ★★ 瘦身：`find` 指到**远超上限**的一大段、`text` 只给一小段（"把过时的那一大段换掉"）。
  //   ⚠️ 夹具里另有一节**作者的**大段（30000 字，⛔ 谁也不许动它）—— 有它，落地后的文件才**仍然**远超上限，
  //     ★U②b 那条"闸看的是 `text` 不是结果文件长度"才有分辨力（否则文件会跟着瘦下去，等于没验）。
  const BIG = '第 3 场：' + 'x'.repeat(30000)
  const AUTHOR_BIG = 'y'.repeat(30000)
  const CUR_U = ['## 作者的一大节', AUTHOR_BIG, '', '## 最近进展', BIG, '', '## 下次续写提示', '从码头接着写', ''].join('\n')
  const SLIM = '第 4 场：天亮后各自回城'
  const decU = decideNoteWrite({ enabled: true, relPath: 'index.md', mode: 'replace', find: BIG, text: SLIM, maxChars: 20000 })
  const planU = planNoteWrite({ current: CUR_U, mode: 'replace', find: BIG, text: SLIM })
  const nxU = typeof planU.next === 'string' ? planU.next : ''
  check('★U② ★**瘦身本来就过得了**（用户口径「把一整段换成更短的一段」）：`find` 指到三万字那一大段、'
    + '`text` 只给一小段 ⇒ 闸放行；plan 落地后那一大段没了、**别处逐字还在**（含作者那一大节）',
    decU.write === true && decU.reason === 'ok' && planU.ok === true
    && nxU.length === CUR_U.length - BIG.length + SLIM.length && nxU.length < CUR_U.length
    && nxU.includes(AUTHOR_BIG) === true && nxU.includes(BIG) === false,
    JSON.stringify({ decU, len: nxU.length, want: CUR_U.length - BIG.length + SLIM.length }))
  check('★U②b 闸看的是 `text` 的长度，⛔ **不是结果文件的长度**：上面那一脚落地后文件仍有 ' + nxU.length
    + ' 字符（≫ 上限 20000，因为作者那一大节还在）⇒ 这正是"瘦身永远放行"的原因（⛔ 别哪天顺手改成"看文件总长"）',
    nxU.length > 20000 && decU.write === true && decU.chars === SLIM.length)
  check('★U②反证：把闸改成"看结果文件总长"（那一版最省事的写法）⇒ ★U② 必红（瘦身会被它拒掉）',
    (() => {
      const fileLenGate = (curLen, findLen, textLen, max) => curLen - findLen + textLen > max   // ← 挖掉"只看 text"
      return fileLenGate(CUR_U.length, BIG.length, SLIM.length, 20000) === true && decU.write === true
    })())
  check('★U②c 同一个上限：`text` 一旦**超过**上限（把 `find` 那一大段原样抄回去当 text）⇒ 照旧拒收'
    + '（⛔ 不为"瘦身"放宽判据 —— 瘦身过得了是因为 `text` 短，不是因为 mode 是 replace）',
    decideNoteWrite({ enabled: true, relPath: 'index.md', mode: 'replace', find: BIG, text: BIG, maxChars: 20000 }).reason === 'over-budget')
}

// ───────── ★I（20260924 单 ＋ 20260925 单）：`applyNoteWrite` 的**四条真 IO**（临时目录里跑真 fs）─────────
//   三条来自 20260924 单（覆盖写 / 定点替换 / 拒收零变化），★I4 来自 20260925 单（`replace` + `text:''`
//   ＝**纯删除**那一脚也走同一条落盘路、也先备份）。
//   ⛔ 不碰周目、⛔ 不碰真机：夹具全在 `os.tmpdir()` 下一个一次性目录里，跑完删掉。
//   `io` 喂的**就是接线那一脚喂的三件**（`deadzone.writeWithBackup` + `node:fs` 的写函数）。
{
  const TMP = mkdtempSync(join(tmpdir(), 'dma-memory-write-'))
  const io = { writeWithBackup: dz.writeWithBackup, writeFileSync, appendFileSync }
  /** 备份名 = `<文件>.bak-<stamp>` ⇒ 只认带 `.bak-` 的那些。★ 2026-09-26（收纳）：落点改 `.bak/` 子目录。 */
  const baks = () => { try { return readdirSync(join(TMP, '.bak')).filter((n) => n.includes('.bak-')) } catch { return [] } }
  try {
    // 一：覆盖写已存在的文件 ⇒ 盘上多出一个 `.bak-`，内容是**旧文逐字节**
    const p1 = join(TMP, 'index.md')
    const OLD = '# 旧文\n- 作者的一段\n'
    const NEW = '# 整份换掉\n- 新的一段\n'
    writeFileSync(p1, OLD, 'utf8')
    const plan1 = planNoteWrite({ current: OLD, mode: 'overwrite', text: NEW })
    const r1 = applyNoteWrite({ absPath: p1, next: plan1.next, backup: plan1.backup, stamp: dz.stampNow(), io })
    check('★I1 覆盖写 ⇒ 先备份再写：盘上多出一个 `.bak-`，内容 = 旧文**逐字节**',
      r1.ok === true && baks().length === 1 && readFileSync(p1, 'utf8') === NEW
      && readFileSync(join(TMP, '.bak', baks()[0]), 'utf8') === OLD && r1.backupPath === join(TMP, '.bak', baks()[0]),
      JSON.stringify({ r1, files: readdirSync(TMP) }).slice(0, 240))
    check('★I1b 备份名里**没有冒号**（Windows 文件名不许有 `:`）—— 所以时间戳用 `deadzone.stampNow()` 那种形式',
      baks().length === 1 && baks()[0].includes(':') === false && baks()[0].startsWith('index.md.bak-'))

    // 二：replace 走真盘面 ⇒ 文件里那一小段被换掉，别的逐字节没变
    const p2 = join(TMP, 'notes.md')
    const CUR2 = '## 最近进展\n第 3 场：码头分手（**旧**）\n\n## 下次续写提示\n从码头接着写\n'
    const FIND2 = '第 3 场：码头分手（**旧**）'
    const FRESH2 = '第 4 场：天亮后回城（**新**）'
    writeFileSync(p2, CUR2, 'utf8')
    const plan2 = planNoteWrite({ current: CUR2, mode: 'replace', find: FIND2, text: FRESH2 })
    const r2 = applyNoteWrite({ absPath: p2, next: plan2.next, backup: plan2.backup, stamp: dz.stampNow(), io })
    const after2 = readFileSync(p2, 'utf8')
    check('★I2 replace ⇒ 盘上那一小段被换掉、别处一字未动（`.bak-` 里是改前那一份）',
      r2.ok === true && after2.includes(FRESH2) === true && after2.includes(FIND2) === false
      && after2 === CUR2.replace(FIND2, FRESH2) && after2.includes('## 下次续写提示\n从码头接着写')
      && readFileSync(join(TMP, '.bak', baks().filter((n) => n.startsWith('notes.md.bak-'))[0]), 'utf8') === CUR2,
      JSON.stringify({ r2, after2 }).slice(0, 240))

    // 三：指不准 ⇒ 拒收 ⇒ **一个字节都没写**（连 `.bak-` 都没有）
    //   接线那一脚的形状：先 plan，`!ok` ⇒ 抛可读错误（正常路径**根本不会**调到 `applyNoteWrite`）。
    //   ⚠️ 这里特意留着"万一 plan 竟然判 ok 就照样写"那一支：那样盘上就**会**变 ⇒ 上面那条断言**必红**
    //     （不是靠"我们没调它"来假装没写）。
    const p3 = join(TMP, 'state.md')
    writeFileSync(p3, CUR2, 'utf8')
    const filesBefore = readdirSync(TMP).sort()
    const badPlan = planNoteWrite({ current: CUR2, mode: 'replace', find: '原文里没有的一段', text: FRESH2 })
    if (badPlan.ok) applyNoteWrite({ absPath: p3, next: badPlan.next, backup: badPlan.backup, stamp: dz.stampNow(), io })
    check('★I3 拒收 ⇒ 盘上**零变化**：文件逐字节没变、也没多出任何 `.bak-`',
      badPlan.ok === false && readFileSync(p3, 'utf8') === CUR2
      && JSON.stringify(readdirSync(TMP).sort()) === JSON.stringify(filesBefore),
      JSON.stringify(readdirSync(TMP)).slice(0, 240))
    check('★I3b 反证（同一条的另一面）：同一次调用若**换了唯一的那一段**就一定会写盘 ⇒ 上面"没写"不是因为它压根不写',
      (() => {
        const good = planNoteWrite({ current: CUR2, mode: 'replace', find: FIND2, text: FRESH2 })
        return good.ok === true && good.next !== CUR2
      })())

    // 四（★20260925 单）：`replace` + `text:''` = 纯删除 —— 真盘面上那一小段**被剪掉**、别处一字未动，
    //   而且**照样先备份**（`.bak-` 里是删前逐字节）⇒ 删错了捞得回来。
    const p4 = join(TMP, 'rounds.md')
    const CUR4 = '## 每轮一记\n第 1 轮：在码头\n第 2 轮：天亮\n第 3 轮：回城\n'
    const FIND4 = '第 2 轮：天亮\n'
    const WANT4 = '## 每轮一记\n第 1 轮：在码头\n第 3 轮：回城\n'
    writeFileSync(p4, CUR4, 'utf8')
    const plan4 = planNoteWrite({ current: CUR4, mode: 'replace', find: FIND4, text: '' })
    const r4 = applyNoteWrite({ absPath: p4, next: plan4.next, backup: plan4.backup, stamp: dz.stampNow(), io })
    const bak4 = baks().filter((n) => n.startsWith('rounds.md.bak-'))
    check('★I4 replace + text:\'\' ⇒ 盘上那一小段被**剪掉**、前后两行逐字还在（不是清空、不是整份重写）；'
      + '`.bak-` 里是**删前**那一份 ⇒ 删除也可撤销',
      r4.ok === true && plan4.backup === true && readFileSync(p4, 'utf8') === WANT4
      && bak4.length === 1 && readFileSync(join(TMP, '.bak', bak4[0]), 'utf8') === CUR4,
      JSON.stringify({ r4, after: readFileSync(p4, 'utf8'), baks: baks() }).slice(0, 240))

    // 五（★20260925 单）：**段模式**走真盘面 —— 删掉「当前时间地点」那一整段（连它后面那个空行），
    //   「最近进展」那一段与**作者那一节**逐字节还在；`.bak-` 里是**删前**逐字节 ⇒ 删错了捞得回来。
    const p5 = join(TMP, 'index-seg.md')
    const SEG1_I = [MARK_M, '## 最近进展', '- 第三场：A 把料压在透辉石处', ''].join('\n') + '\n'
    const SEG2_I = [MARK_M, '## 当前时间地点', '2066 年 · 9 月 23 日 · 黄昏 19:37', ''].join('\n') + '\n'
    const TAIL_I = '## 作者的维护要求\n- 只写已发生的事\n'
    const SEGFILE = SEG1_I + SEG2_I + TAIL_I
    writeFileSync(p5, SEGFILE, 'utf8')
    const plan5 = planNoteWrite({ current: SEGFILE, mode: 'replace', find: MARK_M + '\n## 当前时间地点', text: '' })
    const r5 = applyNoteWrite({ absPath: p5, next: plan5.next, backup: plan5.backup, stamp: dz.stampNow(), io })
    const bak5 = baks().filter((n) => n.startsWith('index-seg.md.bak-'))
    check('★I5 段模式（真盘面，`text:\'\'`）：那一整段被剪掉、作者那一节与上一段**逐字节**还在'
      + '（= 手工剪出来的那份）；`.bak-` 里是**删前**逐字节',
      r5.ok === true && plan5.backup === true && readFileSync(p5, 'utf8') === SEG1_I + TAIL_I
      && plan5.replacedChars === SEG2_I.length && bak5.length === 1
      && readFileSync(join(TMP, '.bak', bak5[0]), 'utf8') === SEGFILE,
      JSON.stringify({ r5, after: readFileSync(p5, 'utf8'), baks: baks() }).slice(0, 240))
  } finally {
    rmSync(TMP, { recursive: true, force: true })
  }
}


// ───────── ★E（20260924 单 ＋ 20260925 单）：端到端 —— 真 `apply()` + 真工具 `execute()` ─────────
//   ★R/★D/★I 测的是**纯逻辑 + 落盘那一脚**；这一节测**接线**：模型手里那个 `memory_write`
//   到底长什么样（enum / `find` / 描述 —— "面板/模型看得到的那一份"），以及它**真跑起来**之后
//   盘上发生什么（替换、**纯删除**、备份、拒收时零变化）。⛔ 不碰真机：`DSH_HOME` 与 Tavern 工作区
//   都指到 `os.tmpdir()` 下的一次性目录（与 `_selftest-deadzone.mjs` 那套夹具同款），跑完删掉。
{
  const TMP_E = mkdtempSync(join(tmpdir(), 'dma-memory-write-e2e-'))
  const HOME = join(TMP_E, 'home')
  const WS = join(TMP_E, 'ws')
  const PT = join(WS, 'ch', 'pt')
  const MEM = join(PT, '.roleplay-memory')
  const SESSION = 'sess-note-1'
  const AUTHOR2 = '## 【必须遵守的核心规则】\n- 作者写的规则：一个字都不许动'
  const IDX = [AUTHOR2, '', '## 最近进展', '第 3 场：码头分手（**旧**）', '', '## 下次续写提示', '从码头的雨夜接着写'].join('\n') + '\n'
  const NEWP = '第 4 场：天亮后各自回城（**新**）'
  const memFile = (n) => join(MEM, n)
  const baksIn = (dir) => { try { return readdirSync(join(dir, '.bak')).filter((n) => n.includes('.bak-')) } catch { return [] } }
  try {
    process.env.DSH_HOME = HOME
    mkdirSync(join(HOME, 'dsh-memory-archive'), { recursive: true })
    writeFileSync(join(HOME, 'dsh-memory-archive', 'config.json'), JSON.stringify({
      schemaVersion: 1, rootMode: 'workspace', root: { sessionId: null, characterId: 'ch', playthroughId: 'pt' },
    }))
    mkdirSync(join(HOME, 'pmp-dsh-tavern'), { recursive: true })
    writeFileSync(join(HOME, 'pmp-dsh-tavern', 'play-workspace.json'), JSON.stringify({ schemaVersion: 1, rootPath: WS }))
    mkdirSync(WS, { recursive: true })
    writeFileSync(join(WS, 'catalog.json'), JSON.stringify({
      playthroughs: [{ id: 'pt', path: 'ch/pt/timeline.json', ext: { pmpDshTavern: { characterId: 'ch', rootSessionId: SESSION } } }],
    }))
    mkdirSync(PT, { recursive: true })
    writeFileSync(join(PT, 'timeline.json'), JSON.stringify({ head: { sessionId: SESSION }, nodes: [] }))
    mkdirSync(MEM, { recursive: true })
    writeFileSync(memFile('index.md'), IDX, 'utf8')

    // 记账假 ctx：把注册进来的工具收下来（照 `_selftest-deadzone.mjs` 的最小 ctx，够 `apply()` 跑完）。
    const tools = []
    const webServer = { register: () => () => {} }
    const ctx = {
      effect: (fn) => fn(),
      inject: (_names, cb) => { cb(ctx); return () => {} },
      get: (name) => (name === 'webServer' ? webServer : undefined),
      webServer,
      plugin: (spec) => { spec.apply({ effect: (fn) => fn(), on: () => () => {}, systemPrompt: { section: () => () => {} } }) },
      on: () => () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      tools: { register: (t) => { tools.push(t); return () => {} } },
    }
    apply(ctx)
    const tool = tools.find((t) => t.name === 'memory_write')
    check('★E1 真接线：`apply()` 之后 `memory_write` 注册上了（缺它 ⇒ 后面几条无从谈起）',
      tool !== undefined && typeof tool.execute === 'function')
    if (tool === undefined) throw new Error('memory_write 没注册上')

    // ① 模型看得到的那一份：mode 的 enum 认到 replace、`find` 参数在、描述把三种模式说清
    const props = tool.parameters?.properties ?? {}
    check('★E1b ★ enum 三档（★ 模型看到的就是这一份；少了 replace ⇒ 本单的手段它够不着）',
      JSON.stringify(props.mode?.enum) === JSON.stringify(['overwrite', 'append', 'replace']),
      JSON.stringify(props.mode).slice(0, 160))
    check('★E1c ★ `find` 参数在 + 参数表只认这两个新名字（path / text / mode / find）',
      props.find?.type === 'string' && typeof props.find.description === 'string'
      && JSON.stringify(Object.keys(props).sort()) === JSON.stringify(['find', 'mode', 'path', 'text']),
      JSON.stringify(Object.keys(props)))
    check('★E1d 描述里把三种模式说全（overwrite 说"会先自动留一份备份"、replace 说"逐字"与"会被拒收"）',
      tool.description.includes('overwrite') && tool.description.includes('append') && tool.description.includes('replace')
      && tool.description.includes('先自动留一份备份') && tool.description.includes('逐字')
      && tool.description.includes('会被拒收'), String(tool.description).slice(0, 300))
    // ★E1e（20260925 单）：新手段**必须写在模型看得到的那一份里** —— 工具描述 ＋ `text` 参数说明
    //   （⛔ 不写 ⇒ "把过时那段删掉"这件事它不会想到有这条路 ⇒ 本单白做）。
    check('★E1e ★（20260925）"`replace` 时 `text` 留空 = 把那一整段删掉"写在**模型看得到的那一份**里（描述 ＋ text 参数）',
      tool.description.includes('留空') && tool.description.includes('整个删掉')
      && String(props.text?.description).includes('留空'),
      JSON.stringify({ desc: String(tool.description).slice(0, 300), text: props.text?.description }).slice(0, 400))

    const exec = { agent: { session: { id: SESSION, snapshotEvents: () => [] } } }
    const callTool = async (args) => {
      try { return { out: await tool.execute(args, exec) } } catch (e) { return { err: String(e?.message || e) } }
    }

    // ② replace 走真工具 ⇒ 盘上那一小段被换掉、作者那两段逐字还在、`.bak-` 里是改前那份
    const r2 = await callTool({ path: 'index.md', mode: 'replace', find: '第 3 场：码头分手（**旧**）', text: NEWP })
    const after2 = readFileSync(memFile('index.md'), 'utf8')
    check('★E2 真工具 replace：文件里那一小段被换掉、别处一字未动；回执照实报 mode 与替换字符数',
      r2.out !== undefined && r2.out.mode === 'replace' && r2.out.replacedChars === '第 3 场：码头分手（**旧**）'.length
      && after2 === IDX.replace('第 3 场：码头分手（**旧**）', NEWP)
      && after2.startsWith(AUTHOR2) && after2.includes('## 下次续写提示\n从码头的雨夜接着写'),
      JSON.stringify(r2).slice(0, 240))
    check('★E2b ★ 动过已存在的文件 ⇒ 备份在盘上，内容是**改前逐字节**（不可逆这件事真拆掉了）',
      baksIn(MEM).length === 1 && readFileSync(join(MEM, '.bak', baksIn(MEM)[0]), 'utf8') === IDX
      && baksIn(MEM)[0].includes(':') === false, JSON.stringify(readdirSync(MEM)))

    // ③ 拒收：找不到 / 多义 ⇒ 工具**抛可读错误**（照做就能改对），且盘上**零变化**
    const beforeFiles = readdirSync(MEM).sort()
    const beforeText = readFileSync(memFile('index.md'), 'utf8')
    const r3a = await callTool({ path: 'index.md', mode: 'replace', find: '第 9 场：根本没写过的一句', text: 'x' })
    check('★E3 找不到 ⇒ 拒收，理由点明"先 read 一遍"（⛔ 不是 `拒写：find-missing` 这种黑话）',
      typeof r3a.err === 'string' && r3a.err.includes('没找到') && r3a.err.includes('read'),
      String(r3a.err).slice(0, 200))
    const r3b = await callTool({ path: 'index.md', mode: 'replace', find: '## ', text: 'x' })
    check('★E3b 多义 ⇒ 拒收，理由说清"出现了几次"（`## ` 在现文里 3 次）并要它"给长一点、能唯一确定的一段"',
      typeof r3b.err === 'string' && r3b.err.includes('出现了 3 次') && r3b.err.includes('唯一确定'),
      String(r3b.err).slice(0, 200))
    const r3c = await callTool({ path: 'notes.md', mode: 'replace', find: '随便', text: 'x' })
    check('★E3c replace 指到**不存在**的文件 ⇒ 拒收，并告诉它"新建请用 overwrite"',
      typeof r3c.err === 'string' && r3c.err.includes('已存在') && r3c.err.includes('overwrite'),
      String(r3c.err).slice(0, 200))
    check('★E3d ★ 三次拒收之后盘上**零变化**：文件逐字节没变、一份 `.bak-` 都没多、也没多出 notes.md',
      readFileSync(memFile('index.md'), 'utf8') === beforeText
      && JSON.stringify(readdirSync(MEM).sort()) === JSON.stringify(beforeFiles),
      JSON.stringify(readdirSync(MEM)))
    check('★E3e ★反证（同一条的另一面）：`find` 指对了就一定会写盘 ⇒ 上面"没写"不是因为它压根不写',
      readFileSync(memFile('index.md'), 'utf8').includes(NEWP))

    // ④ overwrite / append 那一侧照旧（老行为不许被这一单改坏；新建不产生 `.bak-`）
    const r4 = await callTool({ path: 'notes.md', mode: 'append', text: '## 第 1 场\n开场\n' })
    check('★E4 append 到**不存在**的文件 ⇒ 新建（盘上没有旧文 ⇒ ⛔ 不凭空造 `.bak-`）',
      r4.out !== undefined && readFileSync(memFile('notes.md'), 'utf8') === '## 第 1 场\n开场\n'
      && baksIn(MEM).length === 1, JSON.stringify(readdirSync(MEM)))
    const r5 = await callTool({ path: 'notes.md', mode: 'overwrite', text: '## 第 2 场\n重写\n' })
    check('★E4b overwrite 已存在的文件 ⇒ 先备份再写（`.bak-` 现在是两份，且新的那份 = 上一版逐字节）',
      r5.out !== undefined && baksIn(MEM).length === 2
      && baksIn(MEM).some((n) => readFileSync(join(MEM, '.bak', n), 'utf8') === '## 第 1 场\n开场\n')
      && readFileSync(memFile('notes.md'), 'utf8') === '## 第 2 场\n重写\n', JSON.stringify(readdirSync(MEM)))

    // ⑤（★20260925 单）`replace` + `text:''`（纯删除）走**真工具** ⇒ 那一行被删掉、别处一字未动、
    //    `.bak-` 是删前那份，回执照实报"删掉 N 字符"（⛔ 不是"替换掉 N 字符，0 字符"那种读不通的话）。
    const STATE = '## 每轮一记\n第 1 轮：在码头\n第 2 轮：天亮\n第 3 轮：回城\n'
    const DEL_LINE = '第 2 轮：天亮\n'
    const STATE_WANT = '## 每轮一记\n第 1 轮：在码头\n第 3 轮：回城\n'
    writeFileSync(memFile('state.md'), STATE, 'utf8')
    const rDel = await callTool({ path: 'state.md', mode: 'replace', find: DEL_LINE, text: '' })
    check('★E5 真工具 replace + text:\'\'（纯删除）：那一行被删掉、前后两行逐字还在；'
      + '回执 mode=replace / chars=0 / replacedChars=那一段长度',
      rDel.out !== undefined && rDel.out.mode === 'replace' && rDel.out.chars === 0
      && rDel.out.replacedChars === DEL_LINE.length
      && readFileSync(memFile('state.md'), 'utf8') === STATE_WANT,
      JSON.stringify(rDel).slice(0, 240))
    check('★E5b ★ 删除**也先备份**：`.bak-` 里是删前逐字节（"不可逆"这件事在删这一脚上同样拆掉了）',
      baksIn(MEM).some((n) => n.startsWith('state.md.bak-') && readFileSync(join(MEM, '.bak', n), 'utf8') === STATE),
      JSON.stringify(readdirSync(MEM)))
    check('★E5c 回执那行字说得对（"删掉 N 字符"；⛔ 不写"替换掉 N 字符，0 字符"）',
      (() => {
        // ⚠️ 上一条拒收时 `rDel.out` 是 undefined ⇒ 这一条**只判 FAIL、不许把台子摔死**
        if (typeof tool.output?.render !== 'function' || rDel.out === undefined) return false
        const blocks = tool.output.render({ path: 'state.md', mode: 'replace', text: '' }, rDel.out)
        const text = Array.isArray(blocks) ? blocks.map((b) => b?.text ?? '').join('') : ''
        return text.includes('删掉') && text.includes(String(rDel.out.replacedChars))
          && text.includes('replace') && text.includes('state.md')
      })(),
      JSON.stringify(rDel.out === undefined ? rDel : tool.output.render({ path: 'state.md', mode: 'replace', text: '' }, rDel.out)))

    // ⑥ 工具那一道闸的另一半（同一份夹具 + 同一个 `text:''`）：`overwrite` / `append` **照旧拒**，
    //    且**盘上零变化**（一个字节都没写、也没多出 `.bak-`）。
    const filesBefore6 = readdirSync(MEM).sort()
    const textBefore6 = readFileSync(memFile('state.md'), 'utf8')
    const eOver = await callTool({ path: 'state.md', mode: 'overwrite', text: '' })
    const eApp = await callTool({ path: 'state.md', mode: 'append', text: '' })
    check('★E6 ★口径分叉（工具那一侧）：`overwrite` + text:\'\' / `append` + text:\'\' ⇒ 都**抛错**，'
      + '理由点出"text 不能空"并指一条出路（要删那一段就用 replace 留空）',
      typeof eOver.err === 'string' && eOver.err.includes('不能空') && eOver.err.includes('replace')
      && typeof eApp.err === 'string' && eApp.err.includes('不能空') && eApp.err.includes('replace'),
      JSON.stringify([eOver, eApp]).slice(0, 240))
    check('★E6b 那两次拒收之后盘上**零变化**：文件逐字节没变、也没多出 `.bak-`',
      readFileSync(memFile('state.md'), 'utf8') === textBefore6
      && JSON.stringify(readdirSync(MEM).sort()) === JSON.stringify(filesBefore6),
      JSON.stringify(readdirSync(MEM)))

    // ⑦（★20260925 单）**标记字面**在"模型看得到的那一份"里逐字就是常量本身（钉住"两处一致"的这一处：
    //   另一处是 persona §5，由 `_selftest-preset-persona.mjs` 钉；`lib/index.js` 只 import、⛔ 不重打字面）。
    check('★E7 ★（20260925）标记字面在**模型看得到的那一份**里逐字就是 `NOTE_SELF_MARK`（工具描述 ＋ `find` 参数说明）',
      tool.description.includes(MARK_M) && String(props.find?.description).includes(MARK_M),
      JSON.stringify({ find: String(props.find?.description).slice(0, 240), descTail: String(tool.description).slice(-260) }).slice(0, 420))

    // ⑧（★20260925 单）**段模式**走**真工具** ⇒ 那一整段被换掉/删掉，别的段与作者那节一字未动；
    //   多义（`find` 只给标记行、盘上两段）⇒ 照旧**拒收**（理由说清"出现了 2 次"、盘上零变化）。
    const SEG_E = MARK_M + '\n## 最近进展\n- 第三场：A 把料压在透辉石处\n\n'
      + MARK_M + '\n## 当前时间地点\n2066 年 · 9 月 23 日 · 黄昏 19:37\n\n'
      + '## 作者的维护要求\n- 只写已发生的事\n'
    const SEG1_E = SEG_E.slice(0, SEG_E.indexOf(MARK_M, 1))
    const SEG2_E = SEG_E.slice(SEG_E.indexOf(MARK_M, 1), SEG_E.indexOf('## 作者的维护要求'))
    const filesBefore7 = readdirSync(MEM).sort()
    writeFileSync(memFile('rounds.md'), SEG_E, 'utf8')
    const rAmb = await callTool({ path: 'rounds.md', mode: 'replace', find: MARK_M, text: 'x' })
    check('★E8 真工具（段模式的多义）：`find` 只给标记行、盘上有**两段** ⇒ 拒收，理由说清"出现了 2 次"'
      + '并要它"给长一点"（模型照做就能改对）',
      typeof rAmb.err === 'string' && rAmb.err.includes('出现了 2 次') && rAmb.err.includes('唯一确定'),
      String(rAmb.err).slice(0, 240))
    check('★E8b 那一次拒收之后盘上**零变化**（逐字节没变、没多出 `.bak-`）',
      readFileSync(memFile('rounds.md'), 'utf8') === SEG_E
      && readdirSync(MEM).filter((n) => n.includes('.bak-')).length === filesBefore7.filter((n) => n.includes('.bak-')).length,
      JSON.stringify(readdirSync(MEM)))
    const rSeg = await callTool({ path: 'rounds.md', mode: 'replace', find: MARK_M + '\n## 当前时间地点', text: '' })
    check('★E8c 真工具（段模式，`text:\'\'` 整段删）：只有「当前时间地点」那一段被删（连它后面那个空行）、'
      + '「最近进展」那段与**作者那节**逐字节还在；回执 mode=replace / chars=0 / replacedChars=那一段长度',
      rSeg.out !== undefined && rSeg.out.mode === 'replace' && rSeg.out.chars === 0
      && rSeg.out.replacedChars === SEG2_E.length
      && readFileSync(memFile('rounds.md'), 'utf8') === SEG1_E + '## 作者的维护要求\n- 只写已发生的事\n',
      JSON.stringify(rSeg).slice(0, 240))
    check('★E8d ★ 段模式**也先备份**：`.bak-` 里是**删前**逐字节（"不可逆"这件事在这一脚上同样拆掉了）',
      baksIn(MEM).some((n) => n.startsWith('rounds.md.bak-') && readFileSync(join(MEM, '.bak', n), 'utf8') === SEG_E),
      JSON.stringify(readdirSync(MEM)))

    // ⑨（★20260926 单）**撞单次上限** ⇒ 回执（工具抛的那句话）必须把**三件事**说全，顺序是"先优化、再写"。
    //   用户口径（逐字）：「重新设计下记忆写入功能，改为**到上限时自动提示需要优化**。同步**轻量化提示词**」。
    //   ① 撞的是哪个上限（这一段 N 字符 / 单次上限 M）；② 为什么该优化（笔记在长胖 / 那几段该"每轮替换、只留最新"）；
    //   ③ 怎么优化（可照做的三件：`replace` ＋ `text:''` / 最早场记压成一行、伏笔挪 `world.md` / `index.md` 按骨架整段换掉）。
    //   ⚠️ 判据写成一个小函数 `overFacts()`：★E9 拿**真回执**算、★E9b 拿**被剪过的副本**再算一遍 ——
    //     证明它会咬人（不是形状断言：剪掉"怎么优化"那一段，同一条必红）。
    const filesBefore9 = readdirSync(MEM).sort()
    const textBefore9 = readFileSync(memFile('rounds.md'), 'utf8')
    const CH = MEMORY_WRITE_MAX_CHARS + 1
    const rOver = await callTool({ path: 'rounds.md', mode: 'append', text: 'x'.repeat(CH) })
    const overMsg = typeof rOver.err === 'string' ? rOver.err : ''
    const overFacts = (m) => ({
      num: m.includes(`这一段 ${CH} 字符`) && m.includes(`超过单次上限 ${MEMORY_WRITE_MAX_CHARS}`),
      why: m.includes('笔记在长胖') && m.includes('每轮替换、只留最新'),
      how: m.includes("mode:'replace'") && m.includes("text:''") && m.includes('把 `find` 指到的那一段整个删掉')
        && m.includes('world.md') && m.includes('压成**一行**留在原位')
        && m.includes('index.md') && m.includes('骨架') && m.includes('整段换掉'),
      order: m.indexOf('先优化') > 0 && m.indexOf('拆成两次写') > m.indexOf('先优化'),
    })
    const f9 = overFacts(overMsg)
    check('★E9 ★（20260926）撞单次上限 ⇒ 回执把**三件事**说全：①数字（这一段 N 字符 / 单次上限 M）'
      + '②为什么（笔记在长胖 / 那几段该"每轮替换、只留最新"）③怎么优化（`replace`＋`text:\'\'` / 最早场记压成一行、'
      + '伏笔挪 `world.md` / `index.md` 按骨架整段换掉）—— ⛔ 不再是干巴巴一句"超了"',
      f9.num && f9.why && f9.how, JSON.stringify({ f9, msg: overMsg.slice(0, 420) }))
    check('★E9b ★顺序口径：**先优化、再写** —— "拆成两次写"若出现，必须排在"先优化"**之后**'
      + '（⛔ 不许再把它当第一出路：拆两次只会让笔记更长）',
      f9.order, JSON.stringify({ atFirst: overMsg.indexOf('先优化'), atSplit: overMsg.indexOf('拆成两次写') }))
    check('★E9c 反证：把"怎么优化"那一段剪掉 ⇒ ★E9 **必红**；拿**上一版那句**（只给"拆成两次写"）来算 ⇒ 同样必红'
      + '（三件事里少一件就不算数）',
      (() => {
        const cut = overMsg.slice(0, overMsg.indexOf('① 过时的条目'))
        const old = `这一段 ${CH} 字符，超过单次上限 ${MEMORY_WRITE_MAX_CHARS} ⇒ 请拆成两次写（⛔ 不会截断硬写）`
        const fc = overFacts(cut)
        const fo = overFacts(old)
        return overMsg.indexOf('① 过时的条目') > 0 && fc.num === true && fc.how === false
          && fo.num === true && fo.why === false && fo.how === false && fo.order === false
          && (fc.num && fc.why && fc.how) === false && (fo.num && fo.why && fo.how) === false
      })(), JSON.stringify({ i: overMsg.indexOf('① 过时的条目') }))
    check('★E9d ★ 模型看得到的那一份（工具描述 ＋ `text` 参数）把"撞上限"指向**优化**，'
      + '⛔ 不再写"拆成两次写"（那一句只留在**回执**里，且排在"先优化"之后 = 最后一档退路）',
      tool.description.includes('该优化') && String(props.text?.description).includes('该优化')
      && tool.description.includes('会被拒收')
      && tool.description.includes('拆成两次写') === false
      && String(props.text?.description).includes('拆成两次写') === false,
      JSON.stringify({ descTail: String(tool.description).slice(-200), text: props.text?.description }))
    check('★E9e ★ 这一次拒收**盘上零变化**：文件逐字节没变、没多出 `.bak-`、也没多出别的文件',
      overMsg !== '' && overMsg.includes('拒收')
      && readFileSync(memFile('rounds.md'), 'utf8') === textBefore9
      && JSON.stringify(readdirSync(MEM).sort()) === JSON.stringify(filesBefore9),
      JSON.stringify(readdirSync(MEM)))
  } finally {
    rmSync(TMP_E, { recursive: true, force: true })
  }
}

// ───────── ★ 尊重沙箱（2026-09-20 用户口径：「尊重，tarven里有关沙箱的设置」）─────────
//   本工具的写盘走自家 node:fs（绕得过宿主沙箱）⇒ "只读"必须由我们自己认账。
{
  check('★S1 沙箱三态与上游同源（read-only / workspace-write / danger-full-access）',
    JSON.stringify(SANDBOX_MODES) === JSON.stringify(['read-only', 'workspace-write', 'danger-full-access']))

  const ev = (mode) => ({ type: 'sandbox/mode', data: { mode } })
  check('★S2 foldSandboxMode：**最后一个**有效值胜出（中间被改回来也算）', (() => {
    return foldSandboxMode([ev('read-only'), ev('workspace-write')]) === 'workspace-write'
      && foldSandboxMode([ev('workspace-write'), ev('read-only')]) === 'read-only'
  })())
  check('★S3 foldSandboxMode：认不出的取值忽略；一条都没有 / 畸形输入 ⇒ null（⛔ 不猜）', (() => {
    return foldSandboxMode([ev('nonsense'), ev('read-only')]) === 'read-only'
      && foldSandboxMode([{ type: 'sandbox/mode', data: {} }]) === null
      && foldSandboxMode([{ type: 'turn/start' }]) === null
      && foldSandboxMode([]) === null && foldSandboxMode(null) === null && foldSandboxMode('x') === null
  })())

  check('★S4 sandboxDecision：**只读 ⇒ 拒写**；其余（含认不出）⇒ 放行', (() => {
    const ro = sandboxDecision('read-only')
    const ww = sandboxDecision('workspace-write')
    const df = sandboxDecision('danger-full-access')
    const un = sandboxDecision(null)
    return ro.allow === false && ro.reason === 'sandbox-read-only'
      && ww.allow === true && df.allow === true && un.allow === true
      && un.reason === 'sandbox-ok'
  })())
  // ★ 反证：认不出就**放行**是刻意的（老日志/非 RP 会话没有"只读"可言）——
  //   若哪天有人把它改成"认不出就拒"，这一条会红。
  check('★S5 反证：认不出（null）⇒ 放行，⛔ 不许改成"认不出就拒"', sandboxDecision(null).allow === true)

  // ★S6 接线（源码级）：工具的执行体里**确实**先折沙箱、再落盘；且拒写发生在 mkdir/write 之前。
  //   ⚠️ 20260924 单改过落盘那一脚（`writeFileSync(target.absPath, args.text, 'utf8')` 整段退役 ⇒
  //      改成 读现文 → `planNoteWrite` → `applyNoteWrite`）⇒ 这一条跟着钉**新**的那一脚，
  //      **意图不变**：沙箱那一判据必须排在**真的动盘**之前（拒写时一个字节都不落）。
  const hostSrc = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8')
  const foldAt = hostSrc.indexOf('memoryWrite.foldSandboxMode(sessionEventsOf(')
  const planAt = hostSrc.indexOf('memoryWrite.planNoteWrite(')
  const applyAt = hostSrc.indexOf('memoryWrite.applyNoteWrite(')
  check('★S6 接线：先 foldSandboxMode(sessionEventsOf(…)) 再 planNoteWrite 再 applyNoteWrite（顺序不许反）',
    foldAt > 0 && planAt > foldAt && applyAt > planAt, `foldAt=${foldAt} planAt=${planAt} applyAt=${applyAt}`)
  check('★S6b 接线：写盘只有 `applyNoteWrite` 这一处（⛔ 别在 execute 里再直接 writeFileSync/appendFileSync 落一次）',
    applyAt > 0 && hostSrc.includes("writeFileSync(target.absPath") === false
    && hostSrc.includes('appendFileSync(target.absPath') === false)
  check('★S7 接线：拒写时点名怎么恢复（RP 模式 / /rp off），⛔ 不说"绕过"',
    hostSrc.includes('/rp off') && hostSrc.includes('RP 模式（高风险锁定）'))

  // ★S8（20260924 单 §4）：`replace` 在**面板/模型看得到的那一份**里真的出现了 ——
  //   enum + 工具描述 + `find` 参数，缺一个模型就用不上这个手段（而这是本单的全部意义）。
  const enumAt = hostSrc.indexOf("enum: ['overwrite', 'append', 'replace']")
  check('★S8 工具接线：mode 的 enum 认到 replace（★ 模型看得到的那一份）', enumAt > 0)
  check('★S8b 工具接线：`find` 参数在（replace 专用），且描述里点名"逐字"与"拒收"',
    hostSrc.includes('find: {') && hostSrc.includes('逐字') && hostSrc.includes('出现多次会被拒收'),
    `find=${hostSrc.includes('find: {')}`)
  check('★S8c 工具接线：拒收理由翻成人话（找不到 ⇒ 先 read；多义 ⇒ 给长一点、能唯一确定的一段）',
    hostSrc.includes('没找到') && hostSrc.includes('先 read') && hostSrc.includes('唯一确定'))

  // ★★S9（2026-09-26 收纳升级，用户口径「升级」）：notes.md 过保养线 ⇒ **点名催收纳**。
  //   两级：① memory_write 回执尾（写完那一刻模型最听得进去）；② `mt:memoryHome` 段尾每轮现算。
  //   线值与 persona §5 同源（6000 字）；⛔ 判据别两头都要——换位置就换读法（备份收纳同日踩过）。
  check('★S9 线值与 persona §5 同源（6000 字）', NOTES_MAINTENANCE_LIMIT_CHARS === 6000)
  check('★S9a 没过线 ⇒ 空串（不噪声）',
    notesMaintenanceHint(0) === '' && notesMaintenanceHint(5999) === '' && notesMaintenanceHint(Number.NaN) === '')
  check('★S9b 过线（含正好 6000）⇒ 字数、出处线值、怎么收纳都点名',
    notesMaintenanceHint(6000).includes('6000') && notesMaintenanceHint(6000).includes('收纳')
      && notesMaintenanceHint(6000).includes('最早场记压成一行')
      && notesMaintenanceHint(6000).includes('world.md')
      && notesMaintenanceHint(13010).includes('13010'))
  {
    const judge = (s) => s.includes('notesMaintenanceFor(sid),')
      && s.includes('function notesMaintenanceFor(')
      && s.includes("readFileSync(join(home.dir, 'notes.md'), 'utf8').length")
    check('★S9c 注入接线：`mt:memoryHome` 段尾挂上 notesMaintenanceFor（每轮现算 notes.md 字数）', judge(hostSrc))
    check('★S9c ★反证：把段尾挂载那行挖掉 ⇒ 判据必红', judge(hostSrc.split('notesMaintenanceFor(sid),').join('')) === false)
    check('★S9d 回执接线：output schema 声明 maintenanceHint + render 非空才带尾巴',
      hostSrc.includes("maintenanceHint: { type: 'string' }")
      && hostSrc.includes("value.maintenanceHint ? '\\n' + value.maintenanceHint : ''"))
  }
}

console.log(`\n── ${pass} 通过 / ${fail} 失败 ──`)
process.exitCode = fail === 0 ? 0 : 1
