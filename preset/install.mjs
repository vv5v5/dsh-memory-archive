#!/usr/bin/env node
/**
 * install.mjs —— 把**本仓库里这份 RP 预设**铺到 DSH 的预设目录（默认 dry-run）。
 *
 * ## 它为什么存在
 * DSH 的 Agent 预设是**文件系统型**的：想用它，就得在 `<DSH_HOME>/.agent-presets/<id>/`
 * 里有一份 `agent.cordis.yml` + 它引用的那些 `./x.js`。而预设**不能**随插件自动生效
 * （本插件 2026-09-19 起退役了"写预设"那条线）⇒ 这条命令就是那一步：**你明确敲了才写**。
 *
 * ## ★ 文件清单从哪来：**装配文件自己**
 * 要铺哪些文件 = `agent.cordis.yml` 里所有 `name: './x.js'` 的出现处（现扫）。
 * 于是"清单"只有一份，⛔ 不会出现"YAML 引用了但没铺"或"铺了但 YAML 没引用"的漂移。
 *   · `./x.js` ⇒ 从本仓库 `preset-modules/x.js` 拷
 *   · `./mt-compaction-rp.js` ⇒ **现场生成**（`lib/mt-compaction.js` 的 `buildRpCompactionBackend()`），
 *     它不在 `preset-modules/` 里（那份产物故意不进仓库，免得与生成器漂移）
 *
 * ## 用法
 *   node preset/install.mjs                     # 只查（dry-run，默认）：打印会写什么、写到哪
 *   node preset/install.mjs --apply             # 真写
 *   node preset/install.mjs --apply --id=my-rp   # 换个预设目录名（默认 roleplay）
 *   node preset/install.mjs --apply --force      # 已存在且内容不同的文件：先备份再覆盖（默认也是备份，--force 只是不提问）
 *
 * ⚠️ 它**只写预设目录**里那几个文件；⛔ 不碰 `~/.dsh` 里别的东西、⛔ 不碰你的 profile、
 *    ⛔ 不重启任何东西。已存在且**内容不同**的文件会先备份成 `<名字>.bak-<时间戳>`（⛔ 不静默覆盖）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url)) // …/preset
const REPO = join(HERE, '..')
const ASSEMBLY = 'agent.cordis.yml'
/** 由生成器产出的那个文件名（不拷 `preset-modules/`，现场生成）。 */
const GENERATED = 'mt-compaction-rp.js'

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const idArg = argv.find((a) => a.startsWith('--id='))
const ID = idArg === undefined ? 'roleplay' : idArg.slice('--id='.length)

const dshHome = String(process.env.DSH_HOME || '').trim() !== '' ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
const TARGET = join(dshHome, '.agent-presets', ID)

/** 装配文件里所有 `./x.js` 引用（去重、保序）—— 这就是要铺的文件清单。 */
function referencedFiles() {
  const text = readFileSync(join(HERE, ASSEMBLY), 'utf8')
  const out = []
  for (const m of text.matchAll(/name:\s*'(\.\/[^']+)'/g)) {
    const name = m[1].slice(2)
    if (!out.includes(name)) out.push(name)
  }
  return out
}

/** 每个目标文件的内容（读不到就抛 —— 缺料要立刻知道，⛔ 不许铺出半份预设）。 */
async function contentOf(name) {
  if (name === GENERATED) {
    const mod = await import(pathToFileURL(join(REPO, 'lib', 'mt-compaction.js')).href)
    return mod.buildRpCompactionBackend()
  }
  return readFileSync(join(REPO, 'preset-modules', name), 'utf8')
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const files = [ASSEMBLY, 'preset.yml', ...referencedFiles()]

console.log(`仓库   ${REPO}`)
console.log(`预设目录 ${TARGET}${existsSync(TARGET) ? '（已存在）' : '（不存在，会创建）'}`)
console.log(`${APPLY ? '★ --apply：会写盘' : '（dry-run：只查不写）'}\n`)

let planned = 0
let backups = 0
let unchanged = 0
for (const name of files) {
  let body
  try {
    body = name === ASSEMBLY || name === 'preset.yml'
      ? readFileSync(join(HERE, name), 'utf8')
      : await contentOf(name)
  } catch (e) {
    console.error(`✗ 缺料：${name} —— ${String(e?.message || e).slice(0, 160)}`)
    process.exitCode = 1
    continue
  }
  const dest = join(TARGET, name)
  const exists = existsSync(dest)
  const same = exists && readFileSync(dest, 'utf8') === body
  const state = !exists ? '新增' : same ? '一致（跳过）' : '内容不同（先备份再覆盖）'
  console.log(`  ${state.padEnd(22)} ${name}  ${Buffer.byteLength(body, 'utf8')} 字节`)
  if (same) { unchanged += 1; continue }
  planned += 1
  if (!APPLY) continue
  mkdirSync(TARGET, { recursive: true })
  if (exists) {
    copyFileSync(dest, `${dest}.bak-${stamp}`)
    backups += 1
  }
  writeFileSync(dest, body, 'utf8')
}

if (!APPLY) {
  console.log(`\n  ${files.length} 个文件：一致 ${unchanged} / 待写 ${planned}`)
  if (planned > 0) console.log('  要真写：加 --apply')
} else {
  console.log(`\n  ✔ 已铺 ${TARGET}`)
  console.log(`    写入 ${planned} 个（其中备份 ${backups} 个旧文件为 .bak-${stamp}）`)
  console.log('  ★ 生效方式：**新开一条会话**并在预设列表里选它（已在跑的会话不会变）。')
}
