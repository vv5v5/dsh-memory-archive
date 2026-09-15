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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

// ═══ 1. 条款与结构 ═══════════════════════════════════════════════════════
// 反证锚点：「逐字照抄，不要"整理"」只出现在 faithful 规则行里 —— 注释掉该行本条必红。
check('1a', 'zh 指令含逐字照抄条款（faithful 规则行）',
  zh.includes('逐字照抄，不要"整理"'), zh.slice(0, 60))
check('1b', 'zh 指令保留既有结构（时间跨度/地点/涉及角色/关键事件/未回收的伏笔）',
  ['## 时间跨度', '## 地点', '## 涉及角色', '## 关键事件', '## 未回收的伏笔'].every((h) => zh.includes(h)),
  '缺节：' + ['时间跨度', '地点', '涉及角色', '关键事件', '未回收的伏笔'].filter((n) => !zh.includes('## ' + n)).join('/'))
check('1c', 'zh 指令含 anima 准则条款（时间前缀 / Show-Don\'t-Tell / 防过度切分 / important 判据）',
  zh.includes('前缀') && zh.includes('谁做了什么') && zh.includes('一个连续片段') && zh.includes('不可逆'),
  JSON.stringify({ 前缀: zh.includes('前缀'), 只写事实: zh.includes('谁做了什么'), 防切分: zh.includes('一个连续片段'), 不可逆: zh.includes('不可逆') }))
check('1d', 'zh 指令结尾要求 tags 结构（{vibe, special, important}）+ 10 个 vibe 枚举',
  zh.includes('tags: {"vibe"') && zh.includes('"special"') && zh.includes('"important":false')
    && zh.includes('Daily') && zh.includes('Suspense') && zh.includes('Serious'),
  'tags 结构缺失：' + String(!zh.includes('tags: {"vibe"')))
check('1e', 'en 指令同构（verbatim 条款 + Time span/Open threads + tags 结构）',
  en.includes('verbatim; do not rewrite them') && en.includes('## Time span') && en.includes('## Open threads')
    && en.includes('tags: {"vibe"') && en.includes('IRREVERSIBLE'),
  'en tags/verbatim 缺失')
check('1f', '⛔ 整份生成物不含 anima 的三个外部标签占位（自包含，不依赖它家包装层）',
  (() => { const t = buildRpCompactionBackend(); return !t.includes('<basic_info>') && !t.includes('<previous_summary>') && !t.includes('<text_to_summarize>') })(),
  '生成物里出现了外部标签名')
check('1g', 'faithful 开关仍真实生效（两份模板不同；faithless 版保留轻度转写条款）',
  zh !== zhFaithless && zhFaithless.includes('可轻度转写') && zhFaithless.includes('tags: {"vibe"'),
  'faithful 两份相同或 faithless 缺 tags')

// ═══ 2. 两条语言路径非空且长度合理（anima 原准则约 600–800 token 的量级）═══
check('2a', 'zh 指令非空且长度合理（600–6000 字符）', zh.length >= 600 && zh.length <= 6000, String(zh.length))
check('2b', 'en 指令非空且长度合理（600–6000 字符）', en.length >= 600 && en.length <= 6000, String(en.length))

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
