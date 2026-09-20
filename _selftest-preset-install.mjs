#!/usr/bin/env node
/**
 * _selftest-preset-install.mjs —— 「自带的 RP 预设」这条线的自检台（`preset/` + `install.mjs`）。
 *
 * 为什么要有它（这套东西的两个真风险）：
 *   ① **清单漂移**：装配 YAML 引用了 `./x.js`，而仓库里没有这个文件（或反过来）⇒ 铺出来的预设**缺料**、
 *      而且是在用户机器上才炸。⇒ 判据：**要铺的文件清单 = 装配 YAML 里现扫**（本台子断言两者同源）。
 *   ② **静默覆盖**：用户自己已经有一份同名预设，铺盘把它盖了。⇒ 判据：dry-run 零写入；`--apply` 对
 *      "已存在且内容不同"的文件**先备份**（本台子逐条验）。
 *
 * 全程在临时 DSH_HOME 里跑，⛔ 不碰真机 `~/.dsh`；临时目录测完即删。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(fileURLToPath(import.meta.url))
const tmp = mkdtempSync(join(repo, '_selftest-preset-tmp-'))
const home = join(tmp, 'home')
mkdirSync(home, { recursive: true })

let pass = 0
let fail = 0
const check = (label, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${cond ? '' : '  ← ' + String(extra)}`)
}

const YAML = readFileSync(join(repo, 'preset', 'agent.cordis.yml'), 'utf8')
const refs = [...YAML.matchAll(/name:\s*'(\.\/[^']+)'/g)].map((m) => m[1].slice(2))
const GENERATED = 'mt-compaction-rp.js'

// ── ① 清单同源：装配引用的每个 ./x.js 都必须拿得到料 ──────────────────────────
check('① 装配里至少引用了 5 个 ./x.js（形状没漂）', refs.length >= 5, `扫到 ${refs.length} 个`)
const missing = refs.filter((n) => n !== GENERATED && !existsSync(join(repo, 'preset-modules', n)))
check('① ★ 每个 ./ 引用都能在 preset-modules/ 里找到（缺一个 ⇒ 铺出来的预设是残的）',
  missing.length === 0, JSON.stringify(missing))
check('① ★ 生成物 mt-compaction-rp.js 被装配引用，且**不在** preset-modules/（免得与生成器漂移）',
  refs.includes(GENERATED) && !existsSync(join(repo, 'preset-modules', GENERATED)))
check('① 装配/预设元数据/README 都在 preset/',
  ['agent.cordis.yml', 'preset.yml', 'README.md', 'install.mjs'].every((f) => existsSync(join(repo, 'preset', f))))

// ── ② 发布版：装配里不许有机器的绝对路径 ────────────────────────────────────
{
  // ⚠️ 盘符路径的判据要**排除 URL**：`https://api...` 里也有 `s:/`，朴素正则会把它当盘符路径（本台子第一版就踩了
  //   —— 假阳性把 `https://api.siliconflow.cn/v1` 报成机器路径）。用 lookbehind 要求前面不是字母数字。
  const DRIVE_PATH = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s'"]*/g
  const hits = [...YAML.matchAll(DRIVE_PATH)].map((m) => m[0])
  check('② ★ 装配里零机器路径（`C:/Users/…`、盘符路径一律不许有 —— 发布版要能换机器）',
    hits.length === 0, JSON.stringify(hits.slice(0, 3)))
  check('② 反证：装配里**故意**放一个盘符路径就该被判出来', 'C:\\Users\\x'.match(DRIVE_PATH) !== null)
  check('② 反证（假阳性）：https URL 不该被判成盘符路径',
    'https://api.siliconflow.cn/v1'.match(DRIVE_PATH) === null)
}

// ── ③ dry-run 零写入 ────────────────────────────────────────────────────────
const run = (args) => spawnSync(process.execPath, [join(repo, 'preset', 'install.mjs'), ...args], {
  cwd: repo, encoding: 'utf8', env: { ...process.env, DSH_HOME: home },
})
const snap = () => {
  const out = []
  const walk = (d) => {
    if (!existsSync(d)) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(p.slice(home.length) + ':' + readFileSync(p, 'utf8').length)
    }
  }
  walk(home)
  return out.sort().join('|')
}
{
  const before = snap()
  const r = run([])
  const after = snap()
  check('③ dry-run 退出码 0', r.status === 0, String(r.stderr || '').slice(0, 200))
  check('③ ★ dry-run 零写入（调用前后快照逐字节相比）', before === after, `${before} → ${after}`)
  check('③ dry-run 会列出"要写哪些文件"（含目标目录）', r.stdout.includes('dry-run') && r.stdout.includes('待写'), '')
}

// ── ④ --apply：铺出来的东西与仓库逐字节一致 ─────────────────────────────────
const TARGET = join(home, '.agent-presets', 'roleplay')
{
  const r = run(['--apply'])
  check('④ --apply 退出码 0', r.status === 0, String(r.stderr || '').slice(0, 200))
  const want = ['agent.cordis.yml', 'preset.yml', ...refs]
  const got = existsSync(TARGET) ? readdirSync(TARGET).filter((f) => !f.includes('.bak-')) : []
  check('④ ★ 铺出来的文件清单 = 装配引用 + 两个元数据文件（一个不多一个不少）',
    JSON.stringify([...got].sort()) === JSON.stringify([...want].sort()), JSON.stringify(got))
  let bad = []
  for (const f of want) {
    if (!existsSync(join(TARGET, f))) { bad.push(f + ':缺'); continue }
    const src = f === 'agent.cordis.yml' || f === 'preset.yml'
      ? join(repo, 'preset', f)
      : join(repo, 'preset-modules', f)
    if (f === GENERATED) continue // 生成物与之比的是生成器输出，下一条单独验
    if (readFileSync(src, 'utf8') !== readFileSync(join(TARGET, f), 'utf8')) bad.push(f + ':不一致')
  }
  check('④ ★ 每个铺出来的文件都与仓库源逐字节一致', bad.length === 0, JSON.stringify(bad))
  // 生成物：与"现场调生成器"的结果比
  const gen = await import('./lib/mt-compaction.js')
  check('④ ★ mt-compaction-rp.js 与生成器输出一致（现场比）',
    readFileSync(join(TARGET, GENERATED), 'utf8') === gen.buildRpCompactionBackend())
}

// ── ⑤ 覆盖前先备份（用户自己那份不许被静默盖掉）──────────────────────────────
{
  const victim = join(TARGET, 'rp-identity.js')
  writeFileSync(victim, '// 用户自己改过的版本\n', 'utf8')
  const r = run(['--apply'])
  const baks = readdirSync(TARGET).filter((f) => f.startsWith('rp-identity.js.bak-'))
  check('⑤ ★ 内容不同 ⇒ 先备份成 .bak-<时间戳>（⛔ 不静默覆盖）', baks.length === 1, JSON.stringify(baks))
  check('⑤ ★ 备份里是被覆盖掉的**旧内容**（不是新内容）',
    baks.length === 1 && readFileSync(join(TARGET, baks[0]), 'utf8') === '// 用户自己改过的版本\n')
  check('⑤ 覆盖后主文件回到仓库那份', readFileSync(victim, 'utf8') === readFileSync(join(repo, 'preset-modules', 'rp-identity.js'), 'utf8'))
  check('⑤ 再跑一次：内容已一致 ⇒ 不再新增备份', (() => {
    const n = readdirSync(TARGET).filter((f) => f.includes('.bak-')).length
    run(['--apply'])
    return readdirSync(TARGET).filter((f) => f.includes('.bak-')).length === n
  })(), '')
}

// ── ⑥ 反证：装配里引用一个不存在的模块 ⇒ installer 必须非 0 退出（缺料要炸）────
{
  const fake = join(tmp, 'fake')
  mkdirSync(fake, { recursive: true })
  cpSync(join(repo, 'preset'), join(fake, 'preset'), { recursive: true })
  cpSync(join(repo, 'preset-modules'), join(fake, 'preset-modules'), { recursive: true })
  cpSync(join(repo, 'lib'), join(fake, 'lib'), { recursive: true })
  const bad = readFileSync(join(fake, 'preset', 'agent.cordis.yml'), 'utf8')
    .replace("name: './mt-read.js'", "name: './no-such-module.js'")
  writeFileSync(join(fake, 'preset', 'agent.cordis.yml'), bad, 'utf8')
  const r = spawnSync(process.execPath, [join(fake, 'preset', 'install.mjs'), '--apply'], {
    cwd: fake, encoding: 'utf8', env: { ...process.env, DSH_HOME: join(tmp, 'home2') },
  })
  check('⑥ ★ 反证：装配引用了不存在的模块 ⇒ installer 非 0 退出（⛔ 不铺半份预设）',
    r.status !== 0 && /缺料/.test(r.stdout + r.stderr), `status=${r.status} out=${(r.stdout || '').slice(-120)}`)
}

rmSync(tmp, { recursive: true, force: true })
check('临时目录已删除', !existsSync(tmp))

console.log(`\n── ${pass} 通过 / ${fail} 失败 ──`)
process.exitCode = fail === 0 ? 0 : 1
