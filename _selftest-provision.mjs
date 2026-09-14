/**
 * _selftest-provision.mjs —— 「一键生成 RP 预设」（lib/mt-preset.js + /agent/provision）自检台。
 *
 * 覆盖（对应任务书 8 条）：
 *   1) buildRpPreset() 六个文件都在、都是非空字符串
 *   2) ★★ 可移植性硬断言：agent.cordis.yml 每一行 name: 逐条判类
 *      （cordis: / ./ 开头 / 官方 @deepseek-ai/dsh-* 裸名 / 其它）⇒ 断言「其它」为空
 *      ⇒ 零绝对路径、零第三方包名；并把四类数量打出来
 *   3) 组成里出现 ./mt-compaction-rp.js 与 ./dma-rp-inject.js 与 ./rp-tool-scope.js
 *   4) 确定性：连调两次，六个文件逐字节相同
 *   5) 真落盘往返：临时 DSH_HOME 上真调落盘函数 ⇒ 六文件逐字节落盘；再调 ⇒
 *      PROVISION_EXISTS 被拒且盘上无变化（前后 sha 快照比对）
 *   6) dryRun:true ⇒ 零写入（调用前后整棵临时树 sha 快照一致）
 *   7) 组成能被 DSH 的 scanRoot() 扫到且 broken === undefined —— ★标签改准（20260913）：
 *      scanRoot 只校验「组成里每个插件名能不能解析」（名册健康），不做 apply 级校验；
 *      「名册上健康」≠「真的能挂载」（真机实录：roleplay-mt scanRoot ✓ 但界面切换失败）。
 *   8) 反证：故意塞一行绝对路径 ⇒ 第 2 条的分类断言会红
 *   9) ★★ 真验挂载（方案 B，20260913 起）：用与宿主 loader 同源的两类证据把「真能挂载」
 *      做成可执行断言。（方案 A = 起临时宿主真挂：孤立挂载会因缺 llm/tokenMeter/sessions
 *      等宿主服务而失败，那些失败与生成物质量无关 ⇒ 本台选 B，如实声明证据等级。）
 *      ① 三个 ./x.js 过 esbuild format:'cjs' 同源转译（产物里一个顶层 await / import.meta
 *         = Transform failed = preset 挂不上）；esbuild 从 DSH 检出解析（只读），找不到退静态禁令；
 *      ② inject 覆盖静态扫描：扫每个产物的 ctx.<name> 访问点，与 export const inject = […]
 *         比对 —— 未声明且裸访问 ⇒ 报错（vendor/cordis/src/reflect.ts:144：fiber 链上找不到
 *         服务时，属性访问本身就抛）。cordis 预注册 mixin（ctx.effect / ctx.on / …，
 *         reflect.ts:219-222）豁免；log / logger / events 允许「未声明 + try 守卫」的降级访问
 *        （拿不到就安静放弃），其余名字哪怕包在 try 里也不豁免（守卫只能救日志，救不了功能）。
 *  10) 反证 ×2：删掉 inject 声明 ⇒ ② 会红；塞一行顶层 await ⇒ ① 会红（证明不是橡皮图章）
 *
 * ★ 只读访问 DSH 检出；绝不写它、不碰 ~/.dsh。DSH 检出定位：MT_DSH_ROOT 优先，
 *   否则仓库的兄弟目录 ../deepseek-harness（与本仓库其它自检台同口径）。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = dirname(fileURLToPath(import.meta.url))
const tmp = mkdtempSync(join(repo, '_selftest-provision-tmp-'))
const presetsRoot = join(tmp, '.agent-presets')

let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`PASS ${name}`)
  else {
    failures++
    console.log(`FAIL ${name}${detail ? ' —— ' + detail : ''}`)
  }
}
function shaBuf(buf) {
  return createHash('sha256').update(buf).digest('hex')
}
function treeSha(dir) {
  const out = {}
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name)
    if (ent.isDirectory()) {
      for (const [k, v] of Object.entries(treeSha(full))) out[ent.name + '/' + k] = v
    } else out[ent.name] = shaBuf(readFileSync(full))
  }
  return out
}

// ---- 0) 守门：三个涉改文件先过 node --check ----
for (const f of ['lib/mt-preset.js', 'lib/index.js', 'lib/rp-agent.js', 'lib/client.js']) {
  const r = spawnSync(process.execPath, ['--check', join(repo, f)], { encoding: 'utf8' })
  check(`node --check ${f} 退出码 0`, r.status === 0, `status=${r.status} ${(r.stderr || '').slice(0, 200)}`)
}

const mtPreset = await import('./lib/mt-preset.js')
const INSTRUCTION = '你在为一个中文角色扮演长会话生成「历史归档条目」。（自检台占位指令，实测路径走 index.js 的面板模板）'

// ---- 1) 六个文件都在、都是非空字符串 ----
const built = mtPreset.buildRpPreset({ compactionInstruction: INSTRUCTION })
check('buildRpPreset ok', built.ok === true && built.presetId === 'roleplay-mt', JSON.stringify(built.presetId || built.code))
const expected = ['agent.cordis.yml', 'preset.yml', 'mt-compaction-rp.js', 'dma-rp-inject.js', 'rp-tool-scope.js', 'dma-binding.json']
const names = (built.files || []).map((f) => f.name)
check('六个文件都在', expected.every((n) => names.includes(n)) && built.files.length === 6, names.join(','))
check('每个文件都是非空字符串', built.files.every((f) => typeof f.text === 'string' && f.text.length > 0))
check('notes 至少含任务书要求的两条如实文案',
  built.notes.some((n) => n.includes('anima') && n.includes('state-bridge'))
  && built.notes.some((n) => n.includes('换机器也能用')),
  JSON.stringify(built.notes))

// ---- 2) ★★ 可移植性硬断言：组成里每一行 name: 逐条判类，「其它」必须为空 ----
const OFFICIAL = /^@deepseek-ai\/dsh-[a-z0-9-]+$/
function classifyNames(compositionText) {
  const counts = { cordis: 0, preset: 0, official: 0, other: 0 }
  const others = []
  for (const line of String(compositionText).split('\n')) {
    const m = /^\s*(?:-\s)?name:\s*(.+?)\s*$/.exec(line)
    if (!m) continue
    const name = m[1].replace(/^['"]|['"]$/g, '')
    if (name.startsWith('cordis:')) counts.cordis++
    else if (name.startsWith('./')) counts.preset++
    else if (OFFICIAL.test(name)) counts.official++
    else {
      counts.other++
      others.push(name)
    }
  }
  return { counts, others }
}
const classA = classifyNames(built.files[0].text)
check('★可移植性：name 四类计数（cordis:/./相对/官方dsh-*/其它），「其它」= 0',
  classA.counts.other === 0 && classA.counts.preset >= 3 && classA.counts.cordis >= 1 && classA.counts.official >= 3,
  JSON.stringify(classA))
console.log(`INFO name 分类计数：cordis:内建=${classA.counts.cordis} ./相对路径=${classA.counts.preset} 官方@deepseek-ai/dsh-*=${classA.counts.official} 其它=${classA.counts.other}`)
check('组成里零绝对路径（C:/ 与 / 开头的盘符与绝对形态）',
  !/(?:name:\s*['"]?)?(?:[A-Za-z]:[\\/]|['"]\/)/.test(built.files[0].text.split('\n').filter((l) => /^\s*(?:-\s)?name:/.test(l)).join('\n')))

// ---- 3) 组成里出现三个 ./ 相对引用 ----
const compText = built.files[0].text
check("组成引用 ./mt-compaction-rp.js", compText.includes("'./mt-compaction-rp.js'"))
check("组成引用 ./dma-rp-inject.js", compText.includes("'./dma-rp-inject.js'"))
check("组成引用 ./rp-tool-scope.js", compText.includes("'./rp-tool-scope.js'"))
check('binding 是本插件口径（managedBy + presetId=roleplay-mt）',
  (() => {
    try {
      const b = JSON.parse(built.files.find((f) => f.name === 'dma-binding.json').text)
      return b.managedBy === 'dsh-memory-archive' && b.presetId === 'roleplay-mt'
    } catch {
      return false
    }
  })())

// ---- 4) 确定性：连调两次，六个文件逐字节相同 ----
const built2 = mtPreset.buildRpPreset({ compactionInstruction: INSTRUCTION })
check('确定性：连调两次六个文件逐字节相同',
  built.files.length === built2.files.length
  && built.files.every((f, i) => f.name === built2.files[i].name
    && Buffer.compare(Buffer.from(f.text, 'utf8'), Buffer.from(built2.files[i].text, 'utf8')) === 0))

// ---- 6) dryRun:true ⇒ 零写入（先做：此刻临时根还没建，整棵树 sha 前后一致） ----
const planDry = mtPreset.provisionRpPreset({ presetsRoot, dryRun: true, compactionInstruction: INSTRUCTION })
check('dryRun 返回计划（ok、dryRun:true、六个文件）',
  planDry.ok === true && planDry.dryRun === true && Array.isArray(planDry.files) && planDry.files.length === 6,
  JSON.stringify(planDry.code || ''))
check('dryRun 零写入（临时根整个不存在）', !existsSync(presetsRoot))

// ---- 5) 真落盘往返：真调落盘函数（= POST /agent/provision 的写入面） ----
const r1 = mtPreset.provisionRpPreset({ presetsRoot, compactionInstruction: INSTRUCTION })
check('真落盘 ok，目标目录 = <root>/roleplay-mt', r1.ok === true && r1.presetDir === join(presetsRoot, 'roleplay-mt'), JSON.stringify(r1.code || ''))
check('落盘后六个文件逐字节与内存文本一致',
  r1.ok === true && built.files.every((f) => {
    const back = readFileSync(join(presetsRoot, 'roleplay-mt', f.name))
    return Buffer.compare(back, Buffer.from(f.text, 'utf8')) === 0
  }))
const shaBefore = treeSha(presetsRoot)
const r2 = mtPreset.provisionRpPreset({ presetsRoot, compactionInstruction: INSTRUCTION })
check('重复生成被拒：PROVISION_EXISTS',
  r2.ok === false && r2.code === 'PROVISION_EXISTS', JSON.stringify({ ok: r2.ok, code: r2.code }))
check('被拒后盘上无变化（前后 sha 快照一致）',
  (() => {
    try {
      const shaAfter = treeSha(presetsRoot)
      return JSON.stringify(shaAfter) === JSON.stringify(shaBefore)
    } catch {
      return false
    }
  })())

// 删除分支（顺带覆盖）：dryRun 零写入 → 真删（先备份）→ 目录消失、备份逐字节一致
const shaBeforeDel = treeSha(presetsRoot)
const delPlan = mtPreset.removeRpPreset({ presetsRoot, dryRun: true })
check('删除 dryRun 出计划且零写入',
  delPlan.ok === true && delPlan.dryRun === true && JSON.stringify(treeSha(presetsRoot)) === JSON.stringify(shaBeforeDel))
const del = mtPreset.removeRpPreset({ presetsRoot })
check('删除 ok：目录消失、备份目录存在',
  del.ok === true && del.removed === true && !existsSync(join(presetsRoot, 'roleplay-mt')) && existsSync(del.backup.dir),
  JSON.stringify(del.code || ''))
check('备份内容与删除前逐字节一致',
  (() => {
    try {
      const b = treeSha(del.backup.dir)
      const before = Object.fromEntries(Object.entries(shaBeforeDel)
        .map(([k, v]) => [k.startsWith('roleplay-mt/') ? k.slice('roleplay-mt/'.length) : k, v]))
      return JSON.stringify(b) === JSON.stringify(before)
    } catch {
      return false
    }
  })())

// ---- 7) ★ 组成能被 DSH 接受：重新落盘一份，用 DSH 自己的 scanRoot() 扫（锚点 = apps/cli/）----
const dshRoot = process.env.MT_DSH_ROOT || join(repo, '..', 'deepseek-harness')
const scanModPath = join(dshRoot, 'packages', 'preset', 'agent-presets', 'lib', 'index.js')
if (!existsSync(scanModPath)) {
  check('DSH scanRoot（跳过：找不到编译版 ' + scanModPath + '）', false, '设置 MT_DSH_ROOT 指向 deepseek-harness 检出后重跑')
} else {
  const r7 = mtPreset.provisionRpPreset({ presetsRoot, compactionInstruction: INSTRUCTION })
  check('重落盘 ok（为 scanRoot 准备）', r7.ok === true, JSON.stringify(r7.code || ''))
  const scan = await import(pathToFileURL(scanModPath).href)
  // 锚点必须取 apps/cli 这一层：实测取仓库根会一个包都解析不到（pnpm 只把 workspace 包链进消费者）
  const harnessBase = pathToFileURL(join(dshRoot, 'apps', 'cli')).href.replace(/\/?$/, '/')
  const found = await scan.scanRoot({ path: presetsRoot, trust: 'user' }, harnessBase)
  const mine = found.find((p) => p.id === 'roleplay-mt')
  check('scanRoot 扫到 roleplay-mt', !!mine, JSON.stringify(found.map((p) => p.id)))
  check('★ scanRoot broken === undefined —— 但只证明【名字能解析】（名册健康），不证明【能挂载】：scanRoot 不做 apply 级校验（真机 20260913 实录：scanRoot ✓ 后切换失败；挂载级验证在第 9 节）',
    !!mine && mine.broken === undefined,
    mine ? String(mine.broken) : '未扫到')
  check('scanRoot 读到显示名（preset.yml 生效）', !!mine && typeof mine.name === 'string' && mine.name.length > 0,
    mine ? String(mine.name) : '未扫到')
}

// ---- 8) 反证：故意塞一行绝对路径 ⇒ 第 2 条的分类断言会红 ----
const bad = built.files[0].text + "- id: evil\n  name: 'C:/Users/w/evil.js'\n"
const classB = classifyNames(bad)
check('反证：塞绝对路径后「其它」类会红（other === 1 且命中该行）',
  classB.counts.other === 1 && classB.others[0] === 'C:/Users/w/evil.js', JSON.stringify(classB))
const bad2 = built.files[0].text + "- id: evil2\n  name: 'dsh-anima-rag'\n"
const classC = classifyNames(bad2)
check('反证：塞第三方包名也会红（other === 1 且命中该行）',
  classC.counts.other === 1 && classC.others[0] === 'dsh-anima-rag', JSON.stringify(classC))

// ---- 9) ★★ 真验挂载（方案 B）：转译门 + inject 覆盖扫描 ----
// scanRoot 全绿下漏掉了两个真实缺陷（顶层 await、缺 inject）——本节把「真能挂载」的两类
// 同源证据做成可执行断言。三个 ./x.js 逐个过门。
const fileOf = (n) => built.files.find((f) => f.name === n).text
const THREE_JS = ['rp-tool-scope.js', 'dma-rp-inject.js', 'mt-compaction-rp.js']
function stripComments(t) {
  return t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

// 9-① CJS 转译门（esbuild 从 DSH 检出解析，只读；找不到退静态禁令——证据弱一档但仍然必须过）
let esbuild = null
try {
  const esbVersions = readdirSync(join(dshRoot, 'node_modules', '.pnpm'))
    .filter((d) => d.startsWith('esbuild@'))
    .sort()
  if (esbVersions.length > 0) {
    esbuild = createRequire(join(dshRoot, 'node_modules', '.pnpm', esbVersions[esbVersions.length - 1], 'node_modules', 'esbuild', 'package.json'))('esbuild')
  }
} catch {}
// 静态禁令（esbuild 不可用时退这档，证据弱一档）：无顶层 await、无动态 import；
// import.meta 只对 mt-compaction-rp.js 禁（生成器纪律明文）—— dma-rp-inject.js 的
// import.meta.url 是合法用法（真机 20260913 实录：它过了宿主转译，报错在 apply 层）。
// 先剥注释再扫：生成文件头注释里写着「import.meta」这类字面量不算数。
const staticBan = (text, name) => {
  const t = stripComments(text)
  return !/^\s*await\b/m.test(t) && !/\bimport\s*\(/.test(t)
    && (name !== 'mt-compaction-rp.js' || !t.includes('import.meta'))
}
for (const name of THREE_JS) {
  const text = fileOf(name)
  if (esbuild) {
    try {
      const r = await esbuild.transform(text, { loader: 'js', format: 'cjs' })
      check(`9① 挂载门·CJS 转译（宿主 loader 同源 esbuild format=cjs）通过：${name}`, typeof r.code === 'string' && r.code.length > 0)
    } catch (e) {
      check(`9① 挂载门·CJS 转译（宿主 loader 同源 esbuild format=cjs）通过：${name}`, false, String(e.message).split('\n').slice(0, 4).join(' | '))
    }
  } else {
    check(`9① 挂载门·CJS 转译静态禁令（无顶层 await / 无动态 import / 无 import.meta）：${name}（esbuild 不可用，退静态）`, staticBan(text, name))
  }
}

// 9-② inject 覆盖静态扫描
// 规则（出处都核实过）：
//   · vendor/cordis/src/reflect.ts:144 —— fiber 链上找不到服务时，ctx.<name> 属性访问本身就抛
//     （真机实录：cannot get property "log" without inject ⇒ 整条 entry 挂不上）。
//   · reflect.ts:219-222 —— effect / on / once / parallel / emit / serial / bail / waterfall /
//     plugin / inject / mixin / reflect / runtime / provide / accessor 是 cordis 预注册 mixin，
//     不需要 inject 声明。
//   · log / logger / events —— 允许「未声明 + try 守卫」：这是降级日志 / 后备订阅，
//     拿不到就安静放弃（守卫只能救这类）。其余名字哪怕包在 try 里也算违规：
//     守卫把「挂不上」变成「静默失效」，功能同样没了（沙箱隔离-开发原则：不许静默失效）。
const CORDIS_PRESET_PROPS = new Set([
  'effect', 'on', 'once', 'parallel', 'emit', 'serial', 'bail', 'waterfall',
  'plugin', 'inject', 'mixin', 'reflect', 'runtime', 'provide', 'accessor',
])
const SOFT_NAMES = new Set(['log', 'logger', 'events'])
/** pos 处的访问是否被某层 try { … } 包住（从 pos 向外逐层找未配对的块开启符，看关键字）。 */
function insideTry(t, pos) {
  let depth = 0
  for (let i = pos - 1; i >= 0; i--) {
    const ch = t[i]
    if (ch === '}') depth++
    else if (ch === '{') {
      if (depth === 0) {
        let j = i - 1
        while (j >= 0 && /\s/.test(t[j])) j--
        const w = /([A-Za-z_$][\w$]*)$/.exec(t.slice(0, j + 1))
        if (w && w[1] === 'try') return true
      } else depth--
    }
  }
  return false
}
function scanInjectCoverage(name, text) {
  const t = stripComments(text)
  const decl = /export\s+(?:const|let|var)\s+inject\s*=\s*\[([^\]]*)\]/.exec(t)
  const declared = decl ? [...decl[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]) : null
  const violations = []
  const re = /\bctx\.([A-Za-z_$][\w$]*)/g
  let m
  while ((m = re.exec(t)) !== null) {
    const svc = m[1]
    if (declared && declared.includes(svc)) continue
    if (CORDIS_PRESET_PROPS.has(svc)) continue
    if (SOFT_NAMES.has(svc) && insideTry(t, m.index)) continue
    violations.push(svc + (insideTry(t, m.index) ? '(守卫内·非降级名)' : '(裸访问)'))
  }
  return { declared, violations }
}
const EXPECTED_INJECT = {
  'rp-tool-scope.js': ['tools'],
  'dma-rp-inject.js': ['systemPrompt'],
  'mt-compaction-rp.js': ['llm', 'tokenMeter', 'sessions'],
}
for (const name of THREE_JS) {
  const { declared, violations } = scanInjectCoverage(name, fileOf(name))
  check(`9② 挂载门·inject 声明存在且逐字正确：${name}`,
    JSON.stringify(declared) === JSON.stringify(EXPECTED_INJECT[name]),
    `declared=${JSON.stringify(declared)} expected=${JSON.stringify(EXPECTED_INJECT[name])}`)
  check(`9② 挂载门·ctx 访问点全部被 inject 覆盖（未声明且裸访问 = 0）：${name}`,
    violations.length === 0, JSON.stringify(violations))
}
console.log('INFO inject 覆盖扫描口径：cordis 预注册 mixin 豁免（reflect.ts:219-222）；log/logger/events 允许 try 守卫的降级访问；其余未声明访问一律违规')

// ---- 10) 反证 ×2：两条门都必须会红（证明不是橡皮图章） ----
// 反证 A：删掉 rp-tool-scope.js 的 inject 声明 ⇒ 9② 必须报 ctx.tools 未声明
//（这正是真机 Bug 2 的根因形态：cordis 代理连 ctx.tools 的属性读取都拒绝 ⇒ 收窄静默失效）
{
  const stripped = fileOf('rp-tool-scope.js').replace(/^export const inject = \['tools'\][ \t]*$/m, '')
  const bad = scanInjectCoverage('rp-tool-scope.js', stripped)
  check('反证 A：删掉 inject 声明后 9② 会红（ctx.tools 被判未声明）',
    bad.declared === null && bad.violations.some((v) => v.startsWith('tools')), JSON.stringify({ declared: bad.declared, violations: bad.violations }))
}
// 反证 B：给 mt-compaction-rp.js 塞一行顶层 await ⇒ 9① 必须报 Transform failed
{
  const poisoned = fileOf('mt-compaction-rp.js') + "\nconst _poison = await Promise.resolve('top-level await')\n"
  let threw = null
  if (esbuild) {
    try {
      await esbuild.transform(poisoned, { loader: 'js', format: 'cjs' })
    } catch (e) {
      threw = String(e.message)
    }
    check('反证 B：塞顶层 await 后 9① 会红（esbuild Transform failed）',
      threw !== null && threw.includes('Top-level await'), threw ? threw.split('\n').slice(0, 3).join(' | ') : 'esbuild 竟然没抛')
  } else {
    check('反证 B：塞顶层 await 后静态禁令会红（esbuild 不可用退静态）', !staticBan(poisoned))
  }
}

// ---- 收尾：临时目录清掉 ----
try {
  rmSync(tmp, { recursive: true, force: true })
} catch {}
console.log(failures === 0 ? 'ALL PASS (_selftest-provision)' : `FAILED: ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
