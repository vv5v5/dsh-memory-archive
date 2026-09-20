// _selftest-memory-write.mjs —— lib/memory-write.js 的纯逻辑自检（⛔ 不碰文件系统、不碰宿主）。
//
// 每组都带**反证**：不能只看"该写时写了"，还要看"开关关/空文本/超预算/坏模式时**一个字都不写**"。
import { readFileSync } from 'node:fs'
import {
  MEMORY_WRITE_TOOL, MEMORY_WRITE_DIR, MEMORY_WRITE_MAX_CHARS, MEMORY_WRITE_MODES,
  SANDBOX_MODES, readMemoryWriteSwitch, decideNoteWrite, foldSandboxMode, sandboxDecision,
} from './lib/memory-write.js'

let pass = 0
let fail = 0
const check = (label, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${cond ? '' : '  ← ' + String(extra)}`)
}

check('① 常量：工具名 memory_write、目录 .roleplay-memory（与社区预设同名）、模式两种', (() => {
  return MEMORY_WRITE_TOOL === 'memory_write' && MEMORY_WRITE_DIR === '.roleplay-memory'
    && JSON.stringify(MEMORY_WRITE_MODES) === JSON.stringify(['overwrite', 'append'])
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
  const hostSrc = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8')
  const foldAt = hostSrc.indexOf('memoryWrite.foldSandboxMode(sessionEventsOf(')
  const writeAt = hostSrc.indexOf("writeFileSync(target.absPath, args.text, 'utf8')")
  check('★S6 接线：先 foldSandboxMode(sessionEventsOf(…)) 再 writeFileSync（顺序不许反）',
    foldAt > 0 && writeAt > foldAt, `foldAt=${foldAt} writeAt=${writeAt}`)
  check('★S7 接线：拒写时点名怎么恢复（RP 模式 / /rp off），⛔ 不说"绕过"',
    hostSrc.includes('/rp off') && hostSrc.includes('RP 模式（高风险锁定）'))
}

console.log(`\n── ${pass} 通过 / ${fail} 失败 ──`)
process.exitCode = fail === 0 ? 0 : 1
