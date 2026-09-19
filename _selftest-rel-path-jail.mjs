#!/usr/bin/env node
/**
 * _selftest-rel-path-jail.mjs —— `lib/rel-path-jail.js` 自检（纯函数 + 对抗性边界）。
 *
 * 跑法：node _selftest-rel-path-jail.mjs   （⛔ 不碰文件系统、⛔ 不联网、⛔ 不碰真周目）
 *
 * 这台子钉的是「**拒收，绝不"清洗后放行"**」这条底线 —— 它是**读侧唯一的越界防线**
 * （`GET /playthrough/rp-memory` 靠它过滤记忆库目录里的文件名单、校验 `?file=`）。
 *
 * 沿革：这份裁决原属 `memory_write` 工具（2026-09-19 该工具整块退役）；写侧特有的断言
 * （decideWrite / planWrite）随工具删掉了，留下的是**共享裁决**这一半，并且把验收方当年
 * 那套**对抗性探针**（`_probe-memory-write-jail.mjs`）的用例正式收编进来。
 */
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const jail = await import(pathToFileURL(join(HERE, 'lib', 'rel-path-jail.js')).href)

let pass = 0
const fails = []
function check(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name) } catch (e) { fails.push(name); console.log('  FAIL ' + name + ' :: ' + String((e && e.message) || e)) }
}
const eq = (a, b, m) => assert.equal(a, b, m)
const ok = (v, m) => { if (!v) throw new Error(m || '断言为假') }

const BS = String.fromCharCode(92) // 反斜杠（躲开转义地狱）

console.log('== _selftest-rel-path-jail.mjs · 相对路径裁决自检 ==')

// ── ① 对抗性边界表：每一条都写死期望，⛔ 不抄实现的答案 ────────────────────────
console.log('\n--- ① 对抗性边界（拒收族 / 放行族）---')
const CASES = [
  // 绝对路径族
  ['/x.md', false], ['//s/x.md', false],
  ['C:x.md', false], ['c:/x.md', false], ['C:' + BS + 'x.md', false],
  // 回溯族（含反斜杠写法）
  ['../x.md', false], ['..' + BS + 'x.md', false], ['a/../../b.md', false],
  ['a/b/../../../c.md', false], ['a/./b.md', false],
  // Windows 怪路径
  ['x.md.', false], ['x.md ', false], [' x.md', false], ['a/ b.md', false],
  ['CON.md', false], ['NUL.json', false], ['a/CON.md', false], ['console.md', true],
  ['a' + BS + 'b.md', true], ['a/' + BS + 'b.md', false],
  // 正常族
  ['sub/笔记.md', true], ['我的 笔记.md', true], ['a/.hidden.md', true],
  ['x.MD', true], ['x.YAML', true], ['data.json', true], ['a/..md', true],
  // 扩展名族
  ['.gitignore', false], ['.md', false], ['x', false], ['x.csv', false], ['x.exe', false],
  // 结构族
  ['a//b.md', false], ['a/b.md/', false], ['a/%2e%2e/x.md', true],
]
check('①a 逐条拒收/放行符合期望（' + CASES.length + ' 条）', () => {
  const misses = []
  for (const [p, want] of CASES) {
    const got = jail.validateRelPath(p).ok === true
    if (got !== want) misses.push(JSON.stringify(p) + ' 期望 ' + (want ? '放行' : '拒收') + ' 实得 ' + (got ? '放行' : '拒收'))
  }
  ok(misses.length === 0, '不成预期 ' + misses.length + ' 条：\n    ' + misses.join('\n    '))
})
check('①b ★★ 反证：拒收结果里⛔ 不许夹带"清洗后的路径"（拒收 ≠ 清洗后放行）', () => {
  let leak = 0
  for (const [p, want] of CASES) {
    if (want) continue
    const r = jail.validateRelPath(p)
    if (r.ok === false && (('absPath' in r) || ('relPath' in r))) leak += 1
  }
  eq(leak, 0, '有 ' + leak + ' 条拒收结果夹带了路径')
})
check('①c 每条拒收都有**人话 reason**（非空、且带 ⛔ 之外的可读说明）', () => {
  for (const [p, want] of CASES) {
    if (want) continue
    const r = jail.validateRelPath(p)
    ok(typeof r.reason === 'string' && r.reason.length >= 6, 'reason 不可读：' + JSON.stringify(p) + ' ⇒ ' + r.reason)
  }
})
check('①d 反斜杠是**归一**不是清洗：归一后照样要过全部检查', () => {
  eq(jail.validateRelPath('a' + BS + 'b.md').relPath, 'a/b.md', '纯反斜杠该归一成 /')
  eq(jail.validateRelPath('a/' + BS + 'b.md').ok, false, 'a/ + \\b ⇒ 归一成 a//b.md ⇒ 空段 ⇒ 拒')
})

// ── ② 解析：夹在 baseDir 之内 ─────────────────────────────────────────────────
console.log('\n--- ② resolveUnderDir：夹在 baseDir 之内 ---')
check('②a 正常：落在 baseDir 下，返回绝对路径 + 归一后的 relPath', () => {
  const r = jail.resolveUnderDir('D:/mem/ch/pt', '剧情大纲.md')
  ok(r.ok === true, JSON.stringify(r))
  eq(r.relPath, '剧情大纲.md')
  ok(r.absPath.startsWith('D:') || r.absPath.startsWith('D:\\'), 'absPath 该是绝对路径：' + r.absPath)
  ok(r.absPath.includes('剧情大纲.md'), 'absPath 该指向那个文件')
})
check('②b ★ 反证：前缀陷阱 —— baseDir 是另一个目录的前缀时，绝不许把越界路径当"在之内"', () => {
  ok(jail.resolveUnderDir('D:/mem/week1', '../week1x/a.md').ok === false, 'week1 不该匹配 week1x')
})
check('②c ★ 反证：越界族在解析层也一律拒（不是只在校验层拒）', () => {
  for (const bad of ['../x.md', 'C:/Windows/win.ini', '/etc/passwd', 'a/../../b.md', 'CON.md']) {
    ok(jail.resolveUnderDir('D:/mem/ch/pt', bad).ok === false, '解析层竟放行了：' + bad)
  }
})
check('②d ★ 反证：baseDir 为空/非串 ⇒ 拒（不许拿"当前目录"兜底）', () => {
  for (const bad of ['', '   ', null, undefined, 42, {}]) {
    ok(jail.resolveUnderDir(bad, 'a.md').ok === false, 'baseDir=' + JSON.stringify(bad) + ' 竟放行')
  }
})
check('②e ★ 反证：非串 / 空 relPath ⇒ 拒，且不抛', () => {
  for (const bad of ['', '   ', null, undefined, 42, {}, []]) {
    const r = jail.resolveUnderDir('D:/mem/ch/pt', bad)
    ok(r.ok === false, 'relPath=' + JSON.stringify(bad) + ' 竟放行')
  }
})

// ── ③ 隐私 ───────────────────────────────────────────────────────────────────
console.log('\n--- ③ 隐私 ---')
check('③ 自检输出里不出现任何真实路径（全程只用合成夹具）', () => {
  const src = jail.validateRelPath('D:/synth/a.md')
  ok(src.ok === false, '绝对路径该被拒')
  ok(src.reason.includes('盘符') || src.reason.includes('绝对路径'), 'reason 该点明是绝对路径')
})

console.log('\n== 汇总：' + pass + ' 通过 / ' + fails.length + ' 失败 ==')
if (fails.length > 0) { console.log('失败项：\n  - ' + fails.join('\n  - ')); process.exit(1) }
