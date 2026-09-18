// _selftest-final-text-locate.mjs —— lib/final-text-locate.js 的行为级自检（纯函数）。
//
// 要钉住的核心是**一条**：中间夹着"我们拿不到正文的段"（anima 那种 next() 之后才改写的）时，
// **后面的段仍必须定位正确** —— 这正是"装配期算 offset"永远做不到、而"等最终正文再定位"能做到的事。
import assert from 'node:assert/strict'
import { FINAL_TEXT_LOCATE_VERSION, locateSections, isFullyLocated } from './lib/final-text-locate.js'

let pass = 0
const fails = []
function check(name, fn) {
  try { fn(); pass++; console.log('[PASS] ' + name) } catch (e) { fails.push(name); console.log('[FAIL] ' + name + ' :: ' + String((e && e.message) || e)) }
}
console.log('== _selftest-final-text-locate.mjs · 最终正文定位自检 ==')

/** 按官方口径把段落用 `\n\n` 拼成最终正文。 */
const join = (parts) => parts.join('\n\n')

check('L1 版本是正整数', () => assert.ok(Number.isInteger(FINAL_TEXT_LOCATE_VERSION) && FINAL_TEXT_LOCATE_VERSION > 0))

check('L2 全命中：每段 offset 都指向它在最终正文里的真位置', () => {
  const secs = [{ name: 'a', text: 'AAA' }, { name: 'b', text: 'BBBBB' }, { name: 'c', text: 'CC' }]
  const final = join(['AAA', 'BBBBB', 'CC'])
  const r = locateSections(secs, final)
  assert.equal(r.reason, 'all-matched')
  assert.deepEqual(r.offsets.map((o) => o.offset), [0, 5, 12])
  assert.deepEqual(r.offsets.map((o) => o.chars), [3, 5, 2])
  assert.equal(r.renderedChars, final.length)
  // 切片回读：切出来逐字等于该段
  for (const [i, o] of r.offsets.entries()) assert.equal(final.slice(o.offset, o.offset + o.chars), secs[i].text)
})

check('L3 ★★ 中间夹着"我们没正文的段"（anima 情形）⇒ 后面的段仍定位正确', () => {
  // 我们手里的段表：a 有正文、b 是空的（anima 在我们这儿就是空的）、c 有正文
  const secs = [{ name: 'a', text: 'AAA' }, { name: 'anima:memory', text: '' }, { name: 'c', text: 'CCC' }]
  // 最终正文里 anima 被填上了内容（我们完全不知道它是什么），并且**还多插了别的**
  const final = join(['AAA', '【记忆】很长的一段我们拿不到的内容……', 'CCC'])
  const r = locateSections(secs, final)
  assert.equal(r.reason, 'all-matched', '空段不参与命中率统计')
  assert.equal(final.slice(r.offsets[0].offset, r.offsets[0].offset + r.offsets[0].chars), 'AAA')
  const c = r.offsets[2]
  assert.equal(final.slice(c.offset, c.offset + c.chars), 'CCC', '★ 后面的段不能因为中间的空白而错位')
  assert.ok(c.offset > 20)
})

check('L4 ★ 反证：正文里**没有**的段 ⇒ offset=null（⛔ 不编 0、不拿上一次的位置顶）', () => {
  const secs = [{ name: 'a', text: 'AAA' }, { name: 'gone', text: 'NOT-IN-FINAL' }, { name: 'c', text: 'CCC' }]
  const final = join(['AAA', 'CCC'])
  const r = locateSections(secs, final)
  assert.equal(r.reason, 'partial')
  assert.equal(r.offsets[1].offset, null)
  assert.equal(r.offsets[1].chars, null)
  assert.equal(final.slice(r.offsets[2].offset, r.offsets[2].offset + r.offsets[2].chars), 'CCC')
  assert.equal(isFullyLocated(r), false, '★ 部分命中 ⇒ 不许发布 offset（可能整体错位）')
})

check('L5 ★ 空段跳过、不占位（宿主也不会给 0 字段 offset）', () => {
  const secs = [{ name: 'x', text: '' }, { name: 'a', text: 'AAA' }, { name: 'y', text: '' }]
  const r = locateSections(secs, 'AAA')
  assert.equal(r.offsets[0].offset, null)
  assert.equal(r.offsets[2].offset, null)
  assert.equal(r.total, 1, '只统计非空段')
  assert.equal(r.matched, 1)
  assert.equal(isFullyLocated(r), true)
})

check('L6 ★ 反证：短段在前面**重复出现**时，必须从游标往后找（不吃前面那个）', () => {
  // 'AA' 在正文里出现两次；段序决定它只能落在第二个位置之后
  const secs = [{ name: 'first', text: 'AA/BB/AA' }, { name: 'second', text: 'AA' }]
  const final = 'AA/BB/AA' + '\n\n' + 'AA'
  const r = locateSections(secs, final)
  assert.equal(r.offsets[0].offset, 0)
  assert.equal(r.offsets[1].offset, 10, '★ 必须取后面那个（游标之后），不是开头的重复')
})

check('L7 反证：空正文 / 全空段 / 畸形输入 都不抛，并如实给 reason', () => {
  assert.equal(locateSections([{ text: 'X' }], '').reason, 'no-final-text')
  assert.equal(locateSections([{ text: '' }], 'ABC').reason, 'no-nonempty-section')
  for (const bad of [null, undefined, 'x', 3]) {
    const r = locateSections(bad, 'ABC')
    assert.equal(r.ok, false)
    assert.equal(r.matched, 0)
  }
  const r2 = locateSections([{ text: 'X' }], null)
  assert.equal(r2.reason, 'no-final-text')
  assert.equal(isFullyLocated(null), false)
  assert.equal(isFullyLocated({}), false)
})

check('L8 端到端：装配期段表（含拿不到正文的段）+ 最终正文 ⇒ 真位置', () => {
  // 仿真实形状：前几段 static、中间 anima 空、末尾我们自己的段
  const secs = [
    { name: 'harness:identity', text: 'ID-48' },
    { name: 'deployment:persona-prefix', text: 'PREFIX' },
    { name: 'pmp-dsh-tavern:profile', text: 'PROFILE-7648' },
    { name: 'anima:memory', text: '' },
    { name: 'mt:postHistory', text: 'PHI' },
  ]
  const final = join(['ID-48', 'PREFIX', 'PROFILE-7648', 'ANIMA-FILLED-BY-WATERFALL', 'PHI'])
  const r = locateSections(secs, final)
  assert.equal(isFullyLocated(r), true)
  const phi = r.offsets[4]
  assert.equal(final.slice(phi.offset, phi.offset + phi.chars), 'PHI')
  assert.equal(phi.offset, final.length - 3, '尾段就该在最后')
})

// ───────────────────── 锚点定界：宿主会改写段文本（2026-09-18 真机） ─────────────────────
check('L9 ★★ 段被宿主改写 ⇒ 锚点定界给出正确区间，且内容 = **最终正文的切片**', () => {
  // 真机形状：两边都以 `<recalledMemories>` 开头，第 19 字起分岔
  const ours = '<recalledMemories>我们拿到的那一版内容</recalledMemories>'
  const theirs = '<recalledMemories>宿主实际发出去的、更长的一版内容，和我们那版不是同一份</recalledMemories>'
  const secs = [{ name: 'a', text: 'AAA' }, { name: 'anima:memory', text: ours }, { name: 'c', text: 'CCC' }]
  const final = join(['AAA', theirs, 'CCC'])
  const r = locateSections(secs, final)
  assert.equal(r.reason, 'all-matched', '★ 全部落位（锚点也算）才敢发布')
  assert.equal(r.exact, 2)
  assert.equal(r.anchored, 1)
  assert.equal(isFullyLocated(r), true)
  const o = r.offsets[1]
  assert.equal(o.anchored, true)
  assert.equal(final.slice(o.offset, o.offset + o.chars), theirs, '★ 切出来的必须是**宿主那版**，不是我们手里那版')
  assert.notEqual(o.chars, ours.length, '（我们那版长度不同 ⇒ 旧口径会整楼不发）')
})

check('L10 ★ 反证：锚点**找不到**（毫无共同前缀）⇒ 如实不发，不许硬塞区间', () => {
  const secs = [{ name: 'a', text: 'AAA' }, { name: 'x', text: '完全对不上的一版内容' }, { name: 'c', text: 'CCC' }]
  const final = join(['AAA', '宿主那版和它没有一个字相同', 'CCC'])
  const r = locateSections(secs, final)
  assert.equal(r.offsets[1].offset, null)
  assert.equal(r.reason, 'partial')
  assert.equal(isFullyLocated(r), false)
})

check('L11 ★ 反证：锚点与下一个锚点之间**还夹着未定位的非空段** ⇒ 拆不开，两个都不发', () => {
  const oursA = '<wrap>A我们那版AAA内容AAA</wrap>'
  const oursB = '<wrap>B我们那版BBB内容BBB</wrap>'
  const secs = [
    { name: 'a', text: 'AAA' },
    { name: 'x', text: oursA },
    { name: 'y', text: '这段完全对不上且非空' },
    { name: 'c', text: 'CCC' },
  ]
  const final = join(['AAA', '<wrap>A宿主那版AAA</wrap>', '<wrap>B宿主那版BBB</wrap>', 'CCC'])
  const r = locateSections(secs, final)
  assert.equal(r.offsets[1].offset, null, '⛔ 中间夹着未定位的非空段 ⇒ 拆不开，不许硬切')
  assert.equal(r.offsets[2].offset, null)
})

check('L12 ★ 锚点段在**尾**：终点取正文末尾（且它之后没有别的非空段）', () => {
  const secs = [{ name: 'a', text: 'AAA' }, { name: 'z', text: '<wrap>尾部我们那版</wrap>' }]
  const final = join(['AAA', '<wrap>尾部宿主那版，更长一些</wrap>'])
  const r = locateSections(secs, final)
  assert.equal(r.anchored, 1)
  const o = r.offsets[1]
  assert.equal(final.slice(o.offset, o.offset + o.chars), '<wrap>尾部宿主那版，更长一些</wrap>')
  assert.equal(o.offset + o.chars, final.length, '尾段就该顶到末尾')
})

check('L13 ★ 逐段原因码：四个失败码必须分得开（界面「为什么给不出位置」全靠它）', () => {
  // 四种结局各一例，且**段序要与正文序一致**（blocked 的前提正是"锚点找到了、但后面夹着未定位段"）
  const secs = [
    { name: 'anchored-sec', text: '<wrap>我们那版</wrap>' },           // 共同前缀 10 字（≥ MIN_ANCHOR_CHARS）⇒ 锚点定界成功
    { name: 'exact-sec', text: 'AAA' },                                // 逐字命中
    { name: 'blocked-sec', text: '<wrap>B我们那版BBB</wrap>' },         // 锚点找得到…
    { name: 'miss-sec', text: '这一段的开头正文里根本没有' },             // …但后面夹着这一段 ⇒ 拆不开
    { name: 'tail-sec', text: 'CCC' },
  ]
  const final = join([
    '<wrap>我们那版宿主改写的更长的内容</wrap>',
    'AAA',
    '<wrap>B我们那版BBB宿主尾巴</wrap>',
    '一段完全不相干的东西',
    'CCC',
  ])
  const r = locateSections(secs, final)
  assert.deepEqual(r.reasons, ['anchored', 'exact', 'blocked', 'anchor-miss', 'exact'])
  assert.equal(r.reason, 'partial', '★ 有段没落位 ⇒ 整楼不许发布 offset')
  // 空段不参与定界，如实标 'empty'
  assert.deepEqual(locateSections([{ name: 'e', text: '' }, { name: 'a', text: 'AAA' }], 'AAA').reasons, ['empty', 'exact'])
  assert.deepEqual(locateSections([{ text: '' }], '').reasons, ['empty'])
  // ★ 正文为空（no-final-text）：非空段标 'pending'（= 根本没机会定界），⛔ 不许谎报 exact
  assert.deepEqual(locateSections([{ text: 'X' }], '').reasons, ['pending'])
  // ★ 畸形输入不抛
  assert.doesNotThrow(() => locateSections(null, 'ABC'))
})

console.log('\n== 汇总：' + pass + ' 通过 / ' + fails.length + ' 失败 ==')
if (fails.length > 0) { console.log('失败项：\n  - ' + fails.join('\n  - ')); process.exit(1) }
