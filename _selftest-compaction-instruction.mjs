/**
 * _selftest-compaction-instruction.mjs —— D4 内置 RP 归档指令（mt-compaction.js）自检台。
 * 运行：node _selftest-compaction-instruction.mjs
 * 覆盖：① 指令含逐字照抄条款 + tags 结构、⛔ 不含 anima 的三个外部标签占位；
 *       ② zh/en 两条非空且长度合理；③ resolveInstruction 既有语义未破坏；
 *       ④ 生成器本身仍然确定性 + 可过 node --check。
 * 隐私：只断言指令的条款名与结构关键字，不落任何会话/摘要/角色卡内容。
 *
 * ★ 反证（由运行者手工执行并留档）：把 lib/mt-compaction.js 里 zh 模板的 faithful 规则行
 *   `'- 用**中文**写。保留原文里的专有名词、数字、物品名，逐字照抄，不要"整理"。'`
 *   注释掉（或删掉「逐字照抄」四字）⇒ 断言 1a 必须变红；还原后复绿。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildRpCompactionBackend, RP_COMPACTION_FILE_NAME } from './lib/mt-compaction.js'

const here = dirname(fileURLToPath(import.meta.url))
// resolveInstruction 只在【生成物】里导出（生成器本身只导出 buildRpCompactionBackend /
// RP_COMPACTION_FILE_NAME）——与 _selftest-mt-compaction.mjs 同款：落盘生成物再 import。
const tmpDir = mkdtempSync(join(here, '.st-ci-tmp-'))
const productPath = join(tmpDir, RP_COMPACTION_FILE_NAME)
writeFileSync(productPath, buildRpCompactionBackend(), 'utf8')
const realConsoleError = console.error
console.error = () => {} // in-repo import 必走降级路径，大声日志与本台无关，吞掉
let product
try {
  product = await import(pathToFileURL(productPath).href)
} finally {
  console.error = realConsoleError
}

let pass = 0
let fail = 0
function check(id, label, cond, detail) {
  if (cond) pass++
  else fail++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${id} ${label}${cond ? '' : '  ← ' + String(detail)}` )
}

const resolveInstruction = product.resolveInstruction
check('0a', '生成物导出 resolveInstruction（function）', typeof resolveInstruction === 'function', String(typeof resolveInstruction))

const zh = resolveInstruction('', 'auto', true) // auto ⇒ 中文内置模板
const zhFaithless = resolveInstruction('', 'auto', false)
const en = resolveInstruction('', 'en', true)

// ═══ 1. 与 anima「总结提示词」**逐字对齐**（2026-09-16 用户口径）═══════════════
// 沿革：旧版是我们自己写的「历史归档条目」+ 中文五节结构（zh/en 两版、faithful 两档）。
// 现在**只有一份**：anima 原文（人的文件/anima_summary_prompts_*.json 第 11 条「总结提示词」，4068 字）。
check('1a', '指令开头 = anima 原文首行（逐字）',
  zh.startsWith('# Summarization Guidelines'), JSON.stringify(zh.slice(0, 40)))
check('1b', 'anima 的顶级小节都在（逐字）',
  ['Target: Create a high-density NARRATIVE CHRONICLE', '## MACRO Plot Progression', '## Segmentation Strategy',
    '## Writing Logic', '## Style', '# Tagging Rules (PER Segment)', '# Format', '# Critical Review'].every((h) => zh.includes(h)),
  '缺节：' + ['Target: Create a high-density NARRATIVE CHRONICLE', '## MACRO Plot Progression', '## Segmentation Strategy',
    '## Writing Logic', '## Style', '# Tagging Rules (PER Segment)', '# Format', '# Critical Review'].filter((h) => !zh.includes(h)).join(' / '))
check('1c', 'anima 的关键准则句逐字在内（合并优先 / 最小密度 / 只在大触发时切 / Show-Don\'t-Tell / 时间前缀）',
  zh.includes('Aggressive Merging') && zh.includes('Minimum Density') && zh.includes('Sustained Vibe Shift')
    && zh.includes("Show, Don't Tell") && zh.includes('2025/12/11 深夜'),
  JSON.stringify({ merge: zh.includes('Aggressive Merging'), density: zh.includes('Minimum Density'), split: zh.includes('Sustained Vibe Shift') }))
check('1d', 'anima 的标签口径逐字在内（10 个 vibe + special 事件/健康 + important 布尔 + RAW JSON Array）',
  zh.includes('[Daily]') && zh.includes('[Wholesome]') && zh.includes('[Comedy]') && zh.includes('[Conflict]')
    && zh.includes('[Action]') && zh.includes('[Angst]') && zh.includes('[Suspense]') && zh.includes('[Romantic]')
    && zh.includes('[Sexual]') && zh.includes('[Serious]')
    && zh.includes('[Halloween]') && zh.includes('[Period]') && zh.includes('[Sick]')
    && zh.includes('"vibe"') && zh.includes('"special"') && zh.includes('"important"')
    && zh.includes('RAW JSON Array'),
  'anima 标签口径缺失')
check('1e', '★ 只有一份指令：auto/zh/en × faithful 四组合**返回同一份文本**（旧版那种 zh/en + faithful 两档已退役）',
  zh === resolveInstruction('', 'en', true) && zh === resolveInstruction('', 'auto', false) && zh === resolveInstruction('', 'zh', true),
  JSON.stringify({ zhLen: zh.length, enLen: en.length, zhFaithlessLen: zhFaithless.length }))
check('1f', '⛔ 生成物**不含 anima 的「破限」那条**（用户口径：破限头不由我们内置，界面留空由玩家自填）',
  (() => { const t = buildRpCompactionBackend(); return !t.includes('It is now 2055') && !t.includes('ethical review standards of the past are outdated') })(),
  '生成物里出现了 anima 破限文本')
// 1g/1g2 —— 标签口径（2026-09-20 改）
//   旧口径是「我们的代码不依赖任何外部包装层」⇒ 三个标签名只许出现在 anima 原文里。
//   新口径（用户原话：「检查一下目前这三个块都包含了什么内容」+「只传最终生成的文本和 user
//   信息，不传思维链」）：**我们要自己把 `<text_to_summarize>` / `<previous_summary>` 造出来**
//   —— 指令里点名的标签必须真实存在，否则模型会去总结别处的文本（真机踩过，见验收单〇之十六）。
//   仍然**不提供** `<basic_info>`（我们手里没有静态背景块）与 `<new_text_to_summarize>`
//   （那是 anima 指令里的**笔误**写法，真实标签是 `<text_to_summarize>`）。
{
  const t = buildRpCompactionBackend()
  const constStart = t.indexOf('const ANIMA_SUMMARY_INSTRUCTION')
  const fnStart = t.indexOf('function rpArchiveInstruction')
  const located = constStart >= 0 && fnStart >= 0
  const outside = located ? t.slice(0, constStart) + t.slice(fnStart) : t // 常量之外 = 我们的代码
  check('1g', '⛔ 我们**不提供** `<basic_info>` / `<new_text_to_summarize>`（后者是 anima 指令里的笔误写法）',
    located && !outside.includes('<basic_info>') && !outside.includes('<new_text_to_summarize>'),
    located ? '我们的代码里出现了不该有的标签' : '常量/函数定位失败')
  check('1g2', '★ 引擎**自己**产出两个标签：`<text_to_summarize>` 字面量 + previous_summary 标签名',
    located && outside.includes('<text_to_summarize>') && outside.includes("wrapped('previous_summary'"),
    located ? '引擎没造标签（指令点名的东西就不存在了）' : '常量/函数定位失败')
}
check('1h', '语言口径由 anima 原文自带（Language: Summary in Chinese），⛔ 不再靠我们追加语言提示',
  zh.includes('Language: Summary in Chinese'), '缺语言口径行')
// ★ 用户口径（2026-09-16）：anima 的「破限」**不由我们内置**（界面留空、玩家自填，规避法律风险）
//   ⇒ 整仓源码里都不许出现那条破限文本；破限头字段的默认值必须是空。
check('1i', '⛔ 仓库源码里**没有** anima 的破限文本（我们只留空字段，不内置）',
  (() => {
    const files = ['lib/mt-compaction.js', 'lib/index.js', 'lib/client.js']
    const bad = files.filter((f) => {
      try { return readFileSync(join(here, f), 'utf8').includes('It is now 2055') } catch { return false }
    })
    return bad.length === 0
  })(),
  '有文件包含破限文本')

// ═══ 2. 长度合理（anima 原文 4068 字；给区间而不是硬编码，anima 更新时不必改这里）═══
check('2a', 'zh 指令长度落在 anima 量级（3500–5000 字符）', zh.length >= 3500 && zh.length <= 5000, String(zh.length))
check('2b', 'en 指令与 zh 逐字相同（同一份）', en === zh, `en=${en.length}`)

// ═══ 3. resolveInstruction 既有语义未破坏（与 _selftest-mt-compaction 同口径）══
check('3a', '非空 customInstruction 仍整段替换 / zh/en 追加提示不变',
  resolveInstruction('MY RULE', 'auto', true) === 'MY RULE'
    && resolveInstruction('MY RULE', 'zh', true) === 'MY RULE\n\n（输出用中文。）'
    && resolveInstruction('MY RULE', 'en', true) === 'MY RULE\n\n(Write the output in English.)',
  '语义漂移')

// ═══ 4. 生成器纪律未破坏 ════════════════════════════════════════════════
const t1 = buildRpCompactionBackend()
const t2 = buildRpCompactionBackend()
check('4a', '生成器连调两次逐字节相同（确定性）', Buffer.compare(Buffer.from(t1), Buffer.from(t2)) === 0, `${t1.length} vs ${t2.length}`)
const chk = spawnSync(process.execPath, ['--check', join(here, 'lib', 'mt-compaction.js')], { encoding: 'utf8' })
check('4b', 'node --check lib/mt-compaction.js 退出码 0', chk.status === 0, String(chk.stderr || '').slice(0, 160))
check('4c', '产物约定文件名未被改动', RP_COMPACTION_FILE_NAME === 'mt-compaction-rp.js', String(RP_COMPACTION_FILE_NAME))

rmSync(tmpDir, { recursive: true, force: true })
check('4d', '临时目录已删除', !existsSync(tmpDir), tmpDir)

console.log(`── ${pass} 通过 / ${fail} 失败 ──`)
process.exitCode = fail === 0 ? 0 : 1
