/**
 * _selftest-mt-compaction.mjs —— lib/mt-compaction.js 生成物的自检台。
 *
 * 覆盖（对应任务 7 条）：
 *   1) 生成物能被真加载（写临时目录 → import() → 拿到类）
 *   2) 它是官方引擎的子类（子进程 cwd=DSH 检出，让「宿主锚点」真解析官方包，比原型链）
 *   3) 只覆盖 summarize()：summarize 是 own，官方其它方法全部继承
 *   4) resolveInstruction 语义：非空整段替换 / zh 追加中文 / en 追加英文 / auto 不追加
 *   5) 确定性：连调两次生成器逐字节相同
 *   6) 反证：全部解析锚点打断（子进程 argv[1] 指向不存在路径 + cwd=空目录 + 删 NODE_PATH）
 *      ⇒ import 不抛、degraded 如实报告、占位类能安全实例化。不许跳过。
 *   7) 临时目录用完清掉
 *
 * ★ 只读访问 DSH 检出（解析官方包），绝不写它；不碰 ~/.dsh。DSH 检出定位：
 *   环境变量 MT_DSH_ROOT 优先，否则取仓库的兄弟目录 ../deepseek-harness。
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = dirname(fileURLToPath(import.meta.url))
const tmp = mkdtempSync(join(repo, '_selftest-mt-tmp-'))
const bare = mkdtempSync(join(repo, '_selftest-mt-bare-'))

let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`PASS ${name}`)
  else {
    failures++
    console.log(`FAIL ${name}${detail ? ' —— ' + detail : ''}`)
  }
}

// ---- 0) 生成器本身先过 node --check（守门）----
const checkGen = spawnSync(process.execPath, ['--check', join(repo, 'lib', 'mt-compaction.js')], { encoding: 'utf8' })
check('node --check lib/mt-compaction.js 退出码 0', checkGen.status === 0, `status=${checkGen.status} ${checkGen.stderr?.slice(0, 200)}`)

// ---- 5) 确定性：连调两次逐字节相同 ----
const { buildRpCompactionBackend, RP_COMPACTION_FILE_NAME } = await import('./lib/mt-compaction.js')
const text1 = buildRpCompactionBackend()
const text2 = buildRpCompactionBackend()
check(
  '生成器连调两次逐字节相同（确定性）',
  Buffer.compare(Buffer.from(text1, 'utf8'), Buffer.from(text2, 'utf8')) === 0,
  `长度 ${text1.length} vs ${text2.length}`,
)
check('产物约定文件名常量 = mt-compaction-rp.js', RP_COMPACTION_FILE_NAME === 'mt-compaction-rp.js', String(RP_COMPACTION_FILE_NAME))

// ---- 1) 生成物能被真加载（写临时目录 → import()）----
const productPath = join(tmp, RP_COMPACTION_FILE_NAME)
writeFileSync(productPath, text1, 'utf8')

const realConsoleError = console.error
const degradedLogs = []
console.error = (...args) => degradedLogs.push(args.map(String).join(' '))
let mod
let importThrew = null
try {
  mod = await import(pathToFileURL(productPath).href)
} catch (e) {
  importThrew = e
} finally {
  console.error = realConsoleError
}
check('生成物 import() 不抛异常（import 期绝不抛 = preset 挂得上的前提）', importThrew === null, importThrew ? String(importThrew) : '')
check('import() 拿到类（default 是 function）', importThrew === null && typeof mod?.default === 'function', `typeof=${typeof mod?.default}`)
check('模块元数据 name/inject/LANGUAGES 就位',
  mod?.name === 'mt-compaction-rp'
  && JSON.stringify(mod?.inject) === JSON.stringify(['llm', 'tokenMeter', 'sessions'])
  && JSON.stringify(mod?.LANGUAGES) === JSON.stringify(['auto', 'zh', 'en']),
  `name=${mod?.name} inject=${JSON.stringify(mod?.inject)}`)

// 本仓 cwd 解析不到官方包 ⇒ 这次 in-repo import 应走降级（大声 console.error + degraded 导出）。
const degradedInRepo = mod?.degraded
check(
  'in-repo import（锚点全打不开官方包）如实降级：degraded 非 null 且报出两个包名与每条锚点原因',
  degradedInRepo !== null
    && String(degradedInRepo.reason).includes('@deepseek-ai/dsh-compaction-basic')
    && String(degradedInRepo.reason).includes('@deepseek-ai/dsh-llm')
    && String(degradedInRepo.reason).includes('  - '),
  `degraded=${JSON.stringify(degradedInRepo)?.slice(0, 200)}`,
)
check('降级时大声 console.error（import 期唯一发声渠道）', degradedLogs.length > 0, `捕获 ${degradedLogs.length} 条`)

// ---- 4) resolveInstruction 指令解析语义 ----
const ri = mod.resolveInstruction
check('resolveInstruction 非空 customInstruction + auto ⇒ 整段替换、一字不增', ri('MY RULE', 'auto', true) === 'MY RULE', JSON.stringify(ri('MY RULE', 'auto', true)))
check('resolveInstruction 非空 + zh ⇒ 追加中文提示', ri('MY RULE', 'zh', true) === 'MY RULE\n\n（输出用中文。）', JSON.stringify(ri('MY RULE', 'zh', true)))
check('resolveInstruction 非空 + en ⇒ 追加英文提示', ri('MY RULE', 'en', true) === 'MY RULE\n\n(Write the output in English.)', JSON.stringify(ri('MY RULE', 'en', true)))
const builtinZh = ri('', 'auto', true)
const builtinZhFaithless = ri('', 'auto', false)
const builtinEn = ri('', 'en', true)
check('resolveInstruction 空 + auto ⇒ 内置中文 RP 模板（含时间跨度/未回收伏笔节）',
  builtinZh.includes('## 时间跨度') && builtinZh.includes('## 未回收的伏笔') && builtinZh.includes('## 关键事件'),
  builtinZh.slice(0, 60))
check('resolveInstruction 空 + en ⇒ 内置英文模板（Time span/Open threads）',
  builtinEn.includes('## Time span') && builtinEn.includes('## Open threads'), builtinEn.slice(0, 60))
check('faithful 开关真实生效（逐字照抄 vs 轻度转写是两份不同模板）', builtinZh !== builtinZhFaithless)

// ---- 2)+3) 官方包真解析：子进程 cwd=DSH 检出，让生成物自己的「宿主锚点」策略真命中 ----
const dshRoot = process.env.MT_DSH_ROOT || join(repo, '..', 'deepseek-harness')
const anchorOk = (() => {
  try {
    createRequire(join(dshRoot, 'apps', 'cli', 'package.json')).resolve('@deepseek-ai/dsh-compaction-basic')
    return true
  } catch {
    return false
  }
})()
check('DSH 检出定位成功且官方包可由 <检出>/apps/cli/package.json 锚点解析（只读）', anchorOk, `dshRoot=${dshRoot}`)

const fullWrapper = join(tmp, '_mt-full-runner.mjs')
writeFileSync(
  fullWrapper,
  `// 满载运行器：cwd = DSH 检出。生成物按自己的锚点策略（argv[1] 失败 → cwd 锚点命中）拿官方包。
const out = { threw: null }
try {
  const mod = await import('./${RP_COMPACTION_FILE_NAME}')
  const { createRequire } = await import('node:module')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const req = createRequire(join(process.cwd(), 'apps', 'cli', 'package.json'))
  const basic = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-compaction-basic')).href)
  const Proto = mod.default.prototype
  const officialProto = basic.default.prototype
  const own = Object.getOwnPropertyNames(Proto)
  const officialMethods = ['_registerAutomaticCompaction', 'compactIfNeeded', 'compactRegion', 'compactNow', 'regionDependencies']
  out.degraded = mod.degraded
  out.className = mod.default.name
  out.officialClassName = basic.default.name
  out.protoParentName = Object.getPrototypeOf(Proto) === officialProto
  out.ownNames = own
  out.summarizeOwn = Object.prototype.hasOwnProperty.call(Proto, 'summarize')
  out.officialNotOwn = officialMethods.filter((m) => !Object.prototype.hasOwnProperty.call(Proto, m))
  out.officialInherited = officialMethods.filter((m) => typeof Proto[m] === 'function')
} catch (e) {
  out.threw = String((e && e.stack) || e)
}
console.log('JSON:' + JSON.stringify(out))
`,
  'utf8',
)
let full = null
if (anchorOk) {
  const r = spawnSync(process.execPath, [fullWrapper], { cwd: dshRoot, encoding: 'utf8' })
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('JSON:'))
  try {
    full = JSON.parse(line.slice(5))
  } catch {}
  if (!full) check('满载子进程输出可解析', false, `status=${r.status} stdout=${(r.stdout || '').slice(0, 200)} stderr=${(r.stderr || '').slice(0, 300)}`)
}
if (full) {
  check('满载 import 不抛（官方包在锚点下真拿到）', full.threw === null, String(full.threw || '').slice(0, 300))
  check('满载 degraded === null（正常挂载，未降级）', full.degraded === null, JSON.stringify(full.degraded)?.slice(0, 200))
  check('★ 原型链：RpCompactionEngine.prototype 的父原型就是官方 BasicCompactionEngine.prototype',
    full.protoParentName === true, `generated=${full.className} official=${full.officialClassName}`)
  check('★ 只覆盖 summarize()：summarize 是自己定义的（prototype 上的 own 属性）', full.summarizeOwn === true, `own=${JSON.stringify(full.ownNames)}`)
  check('★ 官方其余方法一个都没被遮蔽（全部不是 own）', Array.isArray(full.officialNotOwn) && full.officialNotOwn.length === 5, JSON.stringify(full.officialNotOwn))
  check('官方其余方法经原型链可达（继承真实生效）', Array.isArray(full.officialInherited) && full.officialInherited.length === 5, JSON.stringify(full.officialInherited))
}

// ---- 5b) 宿主 loader 同款 CJS 转译（沙箱实战 bug 回归：esbuild format=cjs 不支持顶层 await）----
// preset 目录里的 .js 会被宿主 loader 用 esbuild 转成 CJS 再执行；产物里只要有一个顶层
// await / import.meta 就 Transform failed = preset 挂不上。esbuild 从 DSH 检出解析（只读）；
// 找不到 esbuild 就退到静态禁令（仍然必须过，只是证据弱一档）。
const staticBanOk = !text1.includes('import.meta') && !/\bimport\s*\(/.test(text1) && !/^await\b/m.test(text1)
let esbuild = null
try {
  const { readdirSync } = await import('node:fs')
  const esbRoot = join(dshRoot, 'node_modules')
  const versions = readdirSync(join(esbRoot, '.pnpm'))
    .filter((d) => d.startsWith('esbuild@'))
    .sort()
  if (versions.length > 0) {
    esbuild = createRequire(join(esbRoot, '.pnpm', versions[versions.length - 1], 'node_modules', 'esbuild', 'package.json'))('esbuild')
  }
} catch {}
if (esbuild) {
  try {
    const r = await esbuild.transform(text1, { loader: 'js', format: 'cjs' })
    check('宿主同款 CJS 转译（esbuild format=cjs）成功 —— 顶层 await 类 bug 的回归门', typeof r.code === 'string' && r.code.length > 0)
  } catch (e) {
    check('宿主同款 CJS 转译（esbuild format=cjs）成功 —— 顶层 await 类 bug 的回归门', false, String(e.message).slice(0, 200))
  }
} else {
  check('CJS 转译静态禁令（无 import.meta / 无动态 import / 无顶层 await；esbuild 不可用退静态）', staticBanOk)
}

// ---- 6) 反证：全部锚点打断 ⇒ import 不抛 + 如实降级 ----
// 模拟手法（子进程）：① process.argv[1] 改指向不存在的宿主入口（最优锚点先死于 ENOENT）；
// ② spawn cwd = 一个真实存在但【空】的临时目录（<cwd>/apps/cli、<cwd>/packages/... 与
//    cwd 兜底全部解析不到官方包）；③ 删掉 NODE_PATH，堵死裸说明符的最后一条路。
const badWrapper = join(tmp, '_mt-bad-anchor-runner.mjs')
writeFileSync(
  badWrapper,
  `// 断锚运行器：argv[1] 先改成语义上不存在的路径，再 import 生成物。
process.argv[1] = 'Q:\\\\__definitely_not_here__\\\\host.mjs'
const out = { threw: null }
try {
  const mod = await import('./${RP_COMPACTION_FILE_NAME}')
  out.degraded = mod.degraded
  out.hasDefault = typeof mod.default
  out.defaultName = mod.default && mod.default.name
  let instanceOk = true
  let instanceErr = ''
  try {
    // 降级占位类必须能被 loader 安全实例化（构造绝不抛）。
    new mod.default({ logger: { warn() {} } })
  } catch (e) {
    instanceOk = false
    instanceErr = String(e)
  }
  out.instanceOk = instanceOk
  out.instanceErr = instanceErr
  out.resolveInstructionStillWorks = (() => {
    try {
      return mod.resolveInstruction('', 'auto', true).includes('## 时间跨度')
    } catch {
      return false
    }
  })()
} catch (e) {
  out.threw = String((e && e.stack) || e)
}
console.log('JSON:' + JSON.stringify(out))
`,
  'utf8',
)
const bareEnv = { ...process.env }
delete bareEnv.NODE_PATH
const bad = spawnSync(process.execPath, [badWrapper], { cwd: bare, encoding: 'utf8', env: bareEnv })
let badOut = null
try {
  badOut = JSON.parse((bad.stdout || '').split('\n').find((l) => l.startsWith('JSON:')).slice(5))
} catch {}
if (!badOut) {
  check('断锚子进程输出可解析', false, `status=${bad.status} stdout=${(bad.stdout || '').slice(0, 200)} stderr=${(bad.stderr || '').slice(0, 300)}`)
} else {
  check('★ 反证：全部锚点打断后 import 仍不抛（否则用户 preset 挂不上）', badOut.threw === null && bad.status === 0, `threw=${String(badOut.threw || '').slice(0, 200)} status=${bad.status}`)
  check('★ 反证：degraded 如实报告两个包都拿不到，且每条锚点原因在案',
    badOut.degraded !== null
      && String(badOut.degraded.reason).includes('@deepseek-ai/dsh-compaction-basic')
      && String(badOut.degraded.reason).includes('@deepseek-ai/dsh-llm')
      && String(badOut.degraded.reason).includes('__definitely_not_here__'),
    JSON.stringify(badOut.degraded)?.slice(0, 300))
  check('★ 反证：降级导出仍是能被安全实例化的类（构造不抛）', badOut.hasDefault === 'function' && badOut.instanceOk === true, `hasDefault=${badOut.hasDefault} err=${badOut.instanceErr}`)
  check('★ 反证：降级不吞纯函数导出（resolveInstruction 降级下照常可用）', badOut.resolveInstructionStillWorks === true)
}

// ---- 7) 临时目录清掉 ----
rmSync(tmp, { recursive: true, force: true })
rmSync(bare, { recursive: true, force: true })
check('临时目录已删除', !existsSync(tmp) && !existsSync(bare), `${tmp} ${bare}`)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
