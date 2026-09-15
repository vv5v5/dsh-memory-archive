#!/usr/bin/env node
/**
 * _selftest-preset-modules.mjs —— lib/preset-modules.js 幂等写面 + 换代触发（选项A）的行为级自检。
 *
 * 跑法：node _selftest-preset-modules.mjs   （全程临时目录，⛔ 不碰真预设 ~/.dsh）
 *
 * 覆盖：
 *   ① 包内副本与源复制件逐字节相等 + package.json files 带上目录；
 *   ② 首次写入逐字相等；
 *   ③ 幂等：第二次全跳过、不多出备份、mtime 不变；
 *   ④ 内容不同 ⇒ 先备份再覆盖，备份与旧内容逐字相等；
 *   ⑤ 冲突停下：_fault:'verify' ⇒ VERIFY_FAILED、回滚、后续文件没被碰；
 *   ⑥ 全部 skip ⇒ 组成文件一个字节不动（touched:false、mtime/sha 不变）★反证C：永远 touch ⇒ 变红；
 *   ⑦ 有写入 ⇒ touch：sha256 不变、mtime 变、touched:true ★反证D：重新序列化写回 ⇒ 变红；
 *   ⑧ 组成文件不存在 ⇒ 不崩、touched:false + 一条 warning、绝不顺手创建；
 *   ⑨ 反证A：「相同就跳过」改成永远写 ⇒ ③ 变红（红证打印在案）；
 *   ⑩ 反证B：删掉备份那行 ⇒ ④ 变红（红证打印在案）。
 * 反证是真·变体测试：把 lib/preset-modules.js 读出来、按锚点做文本替换、写成临时模块再
 * import —— 变体若意外变绿，本自检以 FAIL 收场（🔴 本身是被断言的预期结果）。
 */

import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
// 源复制件（只读夹具）：路径由环境变量给（本机目录 ⇒ ⛔ 绝对路径不进仓库）；没设就跳过 1c 的逐字节比对。
const SRC_COPIES = process.env.DMA_PRESET_SRC ?? ''
const NAMES = ['story-anchor.js', 'rp-tool-scope.js']
const COMPO = 'agent.cordis.yml'
const COMPOSITION_FIXTURE = '# 自检夹具：手写组成文件（几行注释 + 一个段落，含 LF 换行）\n- id: persona\n  name: cordis:group\n'
const GENERATION_NOTE = '换代码只在**新会话**生效；已在跑的会话留在旧代'

// ---- 计数器与报告小工具 ----
let pass = 0
let failCount = 0
const redEvidence = []
function check(id, desc, cond, detail) {
  if (cond) {
    pass++
    console.log('  PASS ' + id + ' ' + desc)
  } else {
    failCount++
    console.log('  FAIL ' + id + ' ' + desc + (detail ? ' —— ' + detail : ''))
  }
}
function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}
function section(title) {
  console.log('\n== ' + title + ' ==')
}
function freshDir(tag) {
  return mkdtempSync(join(tmpdir(), 'dma-pm-' + tag + '-'))
}
function backupEntries(presetDir) {
  try {
    return readdirSync(join(presetDir, '.dma-backup'))
  } catch {
    return []
  }
}
function statOf(p) {
  return { sha: sha256(readFileSync(p)), mtime: statSync(p).mtimeMs }
}
/** 把组成文件的 mtime 拨早 60 秒：之后任何一次真写（touch）的新 mtime 必然不同，不受时钟精度影响。 */
function setMtimePast(p) {
  const past = new Date(Date.now() - 60000)
  utimesSync(p, past, past)
}
/** 把 lib/preset-modules.js 的文本变体写成临时模块并 import（文件名唯一，避开 ESM 缓存）。 */
async function loadVariant(mutatedSrc, tag) {
  const f = join(tmpdir(), 'dma-pm-mutant-' + tag + '-' + Math.random().toString(36).slice(2) + '.mjs')
  writeFileSync(f, mutatedSrc)
  try {
    return await import(pathToFileURL(f).href)
  } finally {
    rmSync(f, { force: true })
  }
}
/** 夹具：模拟「用户手改过」的旧内容（合成文本，不含任何会话/角色卡内容）。 */
function fixtureEdit(name) {
  return Buffer.from('// 自检夹具：' + name + ' 的旧内容（用户手改过，与包内副本不同）\n')
}
function fileExists(p) {
  try {
    readFileSync(p)
    return true
  } catch {
    return false
  }
}

// ---- 被测模块（真身）----
const pm = await import('./lib/preset-modules.js')
const originalSrc = readFileSync(join(ROOT, 'lib', 'preset-modules.js'), 'utf8')
// 四个变体锚点（与真身源码逐字对齐；对不上就大声失败，绝不让反证静默变绿）
const ANCHOR_SKIP = '    if (onDisk !== null && sha256Of(onDisk) === mod.sha256) {'
const ANCHOR_BACKUP = '        backup = backupModuleFile(dir, mod.name, onDisk, stamp)'
const ANCHOR_GATE = '  if (changed < 1) {'
const ANCHOR_TWRITE = '        atomicWrite(compositionPath, original)'

const tmpDirs = []
try {
  // =========================================================================
  section('① 包内副本 vs 源复制件（sha256 + 逐字节）+ files 字段')
  const pkgJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  check('1a', 'package.json files 含 preset-modules/', Array.isArray(pkgJson.files) && pkgJson.files.includes('preset-modules'))
  const loaded = pm.loadPresetModules()
  check('1b', '包内副本两个都读得到', loaded.ok === true, loaded.message || '')
  if (SRC_COPIES === '') {
    console.log('  跳过 1c：未设 DMA_PRESET_SRC（与源复制件的逐字节比对只在本机跑）')
  } else {
    for (const name of NAMES) {
      const pkg = readFileSync(join(ROOT, 'preset-modules', name))
      const src = readFileSync(join(SRC_COPIES, name))
      const same = Buffer.compare(pkg, src) === 0
      check('1c-' + name, 'sha256 相等且逐字节相等', same && sha256(pkg) === sha256(src), 'pkg=' + sha256(pkg).slice(0, 16) + ' src=' + sha256(src).slice(0, 16))
    }
  }

  // =========================================================================
  section('② 首次写入逐字相等')
  const dir2 = freshDir('first-write')
  tmpDirs.push(dir2)
  const r2 = pm.provisionPresetModules({ presetDir: dir2 })
  check('2a', 'ok:true 且两个都是 create', r2.ok === true && r2.results.every((x) => x.action === 'create'), JSON.stringify(r2.results || r2))
  for (const name of NAMES) {
    const pkg = readFileSync(join(ROOT, 'preset-modules', name))
    let onDisk = null
    try {
      onDisk = readFileSync(join(dir2, name))
    } catch {}
    check('2b-' + name, '盘上逐字等于包内副本', onDisk !== null && Buffer.compare(onDisk, pkg) === 0)
  }

  // =========================================================================
  section('③ 幂等：第二次全跳过、不多出备份、mtime 不变')
  const dir3 = freshDir('idempotent')
  tmpDirs.push(dir3)
  pm.provisionPresetModules({ presetDir: dir3 })
  const mtimeBefore = NAMES.map((n) => statSync(join(dir3, n)).mtimeMs)
  const backupsBefore3 = backupEntries(dir3).length
  const r3 = pm.provisionPresetModules({ presetDir: dir3 })
  const mtimeAfter = NAMES.map((n) => statSync(join(dir3, n)).mtimeMs)
  const backupsAfter3 = backupEntries(dir3).length
  check('3a', '第二次两个都是 skip', r3.ok === true && r3.results.every((x) => x.action === 'skip'), JSON.stringify(r3.results || r3))
  check('3b', '不多出备份', backupsAfter3 === backupsBefore3 && backupsAfter3 === 0, '备份条目 ' + backupsBefore3 + '→' + backupsAfter3)
  check('3c', 'mtime 一个都没动', mtimeBefore.every((v, i) => v === mtimeAfter[i]))

  // =========================================================================
  section('④ 内容不同 ⇒ 先备份再覆盖，备份与旧内容逐字相等')
  const dir4 = freshDir('overwrite')
  tmpDirs.push(dir4)
  const oldContents = new Map(NAMES.map((n) => [n, fixtureEdit(n)]))
  for (const [n, buf] of oldContents) writeFileSync(join(dir4, n), buf)
  const r4 = pm.provisionPresetModules({ presetDir: dir4 })
  check('4a', 'ok:true 且两个都是 overwrite', r4.ok === true && r4.results.every((x) => x.action === 'overwrite'), JSON.stringify(r4.results || r4))
  for (const name of NAMES) {
    const pkg = readFileSync(join(ROOT, 'preset-modules', name))
    const backups = backupEntries(dir4).filter((f) => f.startsWith(name + '.'))
    const covered = backups.length === 1
    const backupText = covered ? readFileSync(join(dir4, '.dma-backup', backups[0])) : null
    const backupMatchesOld = backupText !== null && Buffer.compare(backupText, oldContents.get(name)) === 0
    const onDisk = readFileSync(join(dir4, name))
    check('4b-' + name, '恰好一份备份且与旧内容逐字相等', covered && backupMatchesOld,
      covered ? '备份 sha=' + sha256(backupText).slice(0, 16) : '备份缺失/多份：' + backups.join(','))
    check('4c-' + name, '覆盖后与包内副本逐字相等', Buffer.compare(onDisk, pkg) === 0)
  }

  // =========================================================================
  section('⑤ 冲突停下：回读不符 ⇒ VERIFY_FAILED + 回滚 + 后续文件没被碰')
  const dir5 = freshDir('conflict')
  tmpDirs.push(dir5)
  const old5 = new Map(NAMES.map((n) => [n, fixtureEdit(n)]))
  for (const [n, buf] of old5) writeFileSync(join(dir5, n), buf)
  const r5 = pm.provisionPresetModules({ presetDir: dir5, _fault: 'verify' })
  check('5a', 'ok:false 且 code=VERIFY_FAILED', r5.ok === false && r5.code === 'VERIFY_FAILED', JSON.stringify({ ok: r5.ok, code: r5.code }))
  check('5b', '冲突文件已回滚（与旧内容逐字相等）', r5.rolledBack === true && Buffer.compare(readFileSync(join(dir5, 'story-anchor.js')), old5.get('story-anchor.js')) === 0)
  check('5c', '后续文件（rp-tool-scope.js）没被写、保持旧内容', Buffer.compare(readFileSync(join(dir5, 'rp-tool-scope.js')), old5.get('rp-tool-scope.js')) === 0)
  const dir5b = freshDir('conflict-noexist')
  tmpDirs.push(dir5b)
  const r5b = pm.provisionPresetModules({ presetDir: dir5b, _fault: 'verify' })
  check('5d', '原来没有的文件：冲突后零残留（删掉）', r5b.ok === false && !fileExists(join(dir5b, 'story-anchor.js')), 'story-anchor.js 仍在盘上')

  // =========================================================================
  section('⑥ 全部 skip ⇒ 组成文件一个字节不动（不 touch）+ 反证C：永远 touch ⇒ 变红')
  const dir6 = freshDir('no-touch')
  tmpDirs.push(dir6)
  const comp6 = join(dir6, COMPO)
  writeFileSync(comp6, COMPOSITION_FIXTURE)
  setMtimePast(comp6)
  pm.provisionPresetModules({ presetDir: dir6 }) // 首次写入（changed≥1，会 touch 一次，把模块也铺好）
  setMtimePast(comp6)
  const before6 = statOf(comp6)
  const r6 = pm.provisionPresetModules({ presetDir: dir6 }) // 第二次：全部 skip
  const after6 = statOf(comp6)
  check('6a', '全部 skip ⇒ touched:false', r6.ok === true && r6.touched === false, JSON.stringify({ ok: r6.ok, touched: r6.touched }))
  check('6b', '组成文件 mtime 不变', before6.mtime === after6.mtime)
  check('6c', '组成文件 sha256 不变', before6.sha === after6.sha)
  const r6d = pm.provisionPresetModules({ presetDir: dir6, dryRun: true })
  check('6d', 'dryRun 报 wouldTouch:false（零写入）', r6d.ok === true && r6d.wouldTouch === false)
  // 反证C：把「changed>=1 才 touch」改成永远 touch ⇒ ⑥ 必须变红
  check('6e', '反证C锚点存在（源码没漂移）', originalSrc.includes(ANCHOR_GATE))
  const mutC = originalSrc.replace(ANCHOR_GATE, '  if (false) { // 反证C：永远 touch（真身是 changed>=1 才 touch）')
  const pmC = await loadVariant(mutC, 'always-touch')
  const dir6m = freshDir('mutant-c')
  tmpDirs.push(dir6m)
  const comp6m = join(dir6m, COMPO)
  writeFileSync(comp6m, COMPOSITION_FIXTURE)
  setMtimePast(comp6m)
  pm.provisionPresetModules({ presetDir: dir6m })
  setMtimePast(comp6m)
  const b6m = statOf(comp6m).mtime
  const rc = pmC.provisionPresetModules({ presetDir: dir6m, modulesDir: join(ROOT, 'preset-modules') })
  const a6m = statOf(comp6m).mtime
  check('6f', '反证C下 ⑥ 变红（mtime 变了 / touched≠false）', b6m !== a6m || rc.touched !== false)
  redEvidence.push('反证C红证：全部 skip 时变体仍 touch —— mtime ' + (b6m !== a6m ? '变了（不该变）' : '没变') + '；touched=' + rc.touched + '（真身这两项必须是「没变/false」）')

  // =========================================================================
  section('⑦ 有写入 ⇒ touch：sha256 不变、mtime 变 + 反证D：重新序列化写回 ⇒ 变红')
  const dir7 = freshDir('touch')
  tmpDirs.push(dir7)
  const comp7 = join(dir7, COMPO)
  writeFileSync(comp7, COMPOSITION_FIXTURE)
  setMtimePast(comp7)
  const before7 = statOf(comp7)
  const r7 = pm.provisionPresetModules({ presetDir: dir7 }) // 模块 create ×2 ⇒ touch
  const after7 = statOf(comp7)
  check('7a', 'touched:true', r7.ok === true && r7.touched === true, JSON.stringify({ ok: r7.ok, touched: r7.touched, warnings: r7.warnings }))
  check('7b', '组成文件 sha256 不变（逐字节原样写回）', before7.sha === after7.sha)
  check('7c', '组成文件 mtime 变了', before7.mtime !== after7.mtime)
  check('7d', 'generationNote 原话在', r7.generationNote === GENERATION_NOTE)
  // 反证D：把「原样写回」改成重新序列化（LF→CRLF）⇒ sha256 变 ⇒ ⑦ 必须变红
  check('7e', '反证D锚点存在（源码没漂移）', originalSrc.includes(ANCHOR_TWRITE))
  const mutD = originalSrc.replace(
    ANCHOR_TWRITE,
    "        atomicWrite(compositionPath, Buffer.from(original.toString('utf8').replace(/\\n/g, '\\r\\n'), 'utf8')) // 反证D：重新序列化写回",
  )
  const pmD = await loadVariant(mutD, 'reserialize')
  const dir7m = freshDir('mutant-d')
  tmpDirs.push(dir7m)
  const comp7m = join(dir7m, COMPO)
  writeFileSync(comp7m, COMPOSITION_FIXTURE)
  const rd = pmD.provisionPresetModules({ presetDir: dir7m, modulesDir: join(ROOT, 'preset-modules') })
  const sha7m = statOf(comp7m).sha
  const shaFixture = sha256(Buffer.from(COMPOSITION_FIXTURE))
  check('7f', '反证D下 ⑦ 变红（touched≠true / sha 被改）', !(rd.ok === true && rd.touched === true) || sha7m !== shaFixture)
  redEvidence.push('反证D红证：重新序列化写回 —— ok=' + rd.ok + ' code=' + rd.code + ' touched=' + rd.touched + '（真身场景该是 ok=true/touched=true；sha 守卫当场把它拦下）')

  // =========================================================================
  section('⑧ 组成文件不存在 ⇒ 不崩、touched:false + 一条 warning、绝不顺手创建')
  const dir8 = freshDir('no-comp')
  tmpDirs.push(dir8)
  const r8 = pm.provisionPresetModules({ presetDir: dir8 })
  check('8a', 'ok:true 且 touched:false', r8.ok === true && r8.touched === false, JSON.stringify({ ok: r8.ok, touched: r8.touched }))
  check('8b', '恰好一条 warning（组成文件缺失）', Array.isArray(r8.warnings) && r8.warnings.length === 1, JSON.stringify(r8.warnings))
  check('8c', '没把组成文件创建出来', !existsSync(join(dir8, COMPO)))
  console.log('  样例（⑧ 返回值，路径以 <tmp> 代替）：')
  console.log('  ' + JSON.stringify({ ok: r8.ok, dryRun: false, presetDir: '<tmp>/no-comp…', modulesDir: '<包根>/preset-modules', results: r8.results.map((x) => x.name + ':' + x.action), touched: r8.touched, generationNote: r8.generationNote, warnings: r8.warnings, errors: r8.errors }))

  // =========================================================================
  section('⑨ 反证A：「相同就跳过」改成永远写 ⇒ ③ 必须变红')
  check('9a', '变体A锚点存在（源码没漂移）', originalSrc.includes(ANCHOR_SKIP))
  const mutA = originalSrc.replace(ANCHOR_SKIP, '    if (false) { // 反证A：永远写（真身是 sha256 相同就跳过）')
  const pmA = await loadVariant(mutA, 'always-write')
  const dir9 = freshDir('mutant-a')
  tmpDirs.push(dir9)
  pm.provisionPresetModules({ presetDir: dir9 }) // 先用真身写一遍（内容与包内副本一致）
  const m9a = statSync(join(dir9, 'story-anchor.js')).mtimeMs
  const b9a = backupEntries(dir9).length
  // ★ 变体住在临时目录，按它自己的路径推不出包内副本 ⇒ 显式注入 modulesDir（真身默认解析不受影响）
  const ra = pmA.provisionPresetModules({ presetDir: dir9, modulesDir: join(ROOT, 'preset-modules') })
  const m9b = statSync(join(dir9, 'story-anchor.js')).mtimeMs
  const b9b = backupEntries(dir9).length
  check('9b', '变体A下 ③ 至少一条断言变红', b9b !== b9a || m9a !== m9b || !(ra.ok && ra.results.every((x) => x.action === 'skip')))
  redEvidence.push('反证A红证：action=' + (ra.results || []).map((x) => x.name + ':' + x.action).join(',') + '；备份 ' + b9a + '→' + b9b + '；mtime ' + (m9a !== m9b ? '变了' : '没变'))

  // =========================================================================
  section('⑩ 反证B：删掉备份那行 ⇒ ④ 必须变红')
  check('10a', '变体B锚点存在（源码没漂移）', originalSrc.includes(ANCHOR_BACKUP))
  const mutB = originalSrc.replace(ANCHOR_BACKUP, '        backup = null // 反证B：不备份（真身会先把旧内容备份进 .dma-backup/）')
  const pmB = await loadVariant(mutB, 'no-backup')
  const dir10 = freshDir('mutant-b')
  tmpDirs.push(dir10)
  const old10 = new Map(NAMES.map((n) => [n, fixtureEdit(n)]))
  for (const [n, buf] of old10) writeFileSync(join(dir10, n), buf)
  const rb = pmB.provisionPresetModules({ presetDir: dir10, modulesDir: join(ROOT, 'preset-modules') })
  const backups10 = backupEntries(dir10)
  check('10b', '变体B下 ④「备份与旧内容逐字相等」变红（备份根本没产生）', rb.ok === true && (backups10.length === 0 || (rb.results || []).some((x) => x.backup === null)),
    '备份条目 ' + backups10.length + ' 个；results.backup=' + JSON.stringify((rb.results || []).map((x) => x.backup)))
  redEvidence.push('反证B红证：.dma-backup 条目 = ' + backups10.length + '（期望 ≥2）；覆盖照常发生（ok=true）但旧内容已无备份')
} finally {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
}

console.log('\n—— 汇总 ——')
console.log('PASS ' + pass + ' / FAIL ' + failCount)
for (const line of redEvidence) console.log(line)
console.log(failCount === 0 ? '自检台：全绿（含四条反证的红）' : '自检台：有红，见上')
process.exit(failCount === 0 ? 0 : 1)
