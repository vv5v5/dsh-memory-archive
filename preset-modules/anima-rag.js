/**
 * anima-rag —— 预设目录内的**薄壳**：让 `dsh-anima-rag` 这一行随预设目录走，而不是写死一条机器专属路径。
 *
 * ## 为什么需要它（本仓"可发布"的唯一障碍）
 * 预设行的 `name:` 只有两种形态能用：官方**裸包名**，或**相对本文件的** `./x.js`。
 * 裸包名只对 **harness 基**（`$DSH_HOME/profiles/node_modules`）下的包成立
 * （`preset/agent-presets/src/mount.ts:73-85` + `discovery.ts:158-160`）；而 `dsh-anima-rag`
 * 不是装在那儿的 —— 它是**某个 profile**（例如 `profiles/web`）的依赖，链接落在
 * `$DSH_HOME/profiles/<profile>/node_modules/` 下。所以历史版本只能写死一条**指向作者机器上那个
 * 包文件**的绝对路径（一串盘符 + 用户目录 + `/profiles/web/node_modules/dsh-anima-rag/lib/index.js`），
 * 仓库因此**搬到别的机器就挂不上**。
 *
 * 本文件把那条路径换成一个**运行期解析**的相对模块：宿主加载本文件时，按下面的锚点链找到
 * 真正装着 `dsh-anima-rag` 的那个 profile，同步 `require` 到它，再把它的导出**原样**转出去。
 * cordis 挂到的与"直挂那条绝对路径"**是同一个模块实例**（同一条绝对路径 = 同一个模块缓存条目）。
 *
 * ## 锚点链（⛔ 不写死任何路径，全部从运行环境推）
 *   1. `process.env.DSH_HOME`（宿主会带）→ 在其下枚举 `profiles/*`
 *   2. `~/.dsh`（`os.homedir()` 推出来；与本仓其它模块同款约定，见 `keep-first-round.js`）
 * 每个候选目录按两条判据打分（确定性：同级按目录名排序取第一个）：
 *   · **declared**：`<profile>/package.json` 的 `dependencies` 里写了 `dsh-anima-rag`；
 *   · **resolvable**：以该目录为锚点 `require.resolve('dsh-anima-rag')` 成功。
 * 取「declared + resolvable」→「仅 resolvable」。一条都没有 ⇒ **大声抛错**
 * （⛔ 不静默降级：宁可这一行挂不上、让人当场看见并去装插件，也不要悄悄少一个插件 ——
 * 记忆检索静默消失是这套设计里最难发现、也最贵的一种失败）。
 *
 * ## 三件不能踩的事（都有实测来源）
 * 1. 预设目录里的 .js 会被宿主 loader 用 **esbuild 转成 CJS** 再执行 ⇒ 本文件⛔ 不许顶层
 *    `await`、⛔ 不许 `import.meta`、⛔ 不许动态 `import()`（任意一条 = Transform failed =
 *    preset 挂不上）。解析一律走 `createRequire(...)` 的**同步** `require()`。
 *    真包是 ESM（`"type":"module"`，入口 `lib/index.js`）⇒ 靠 Node ≥22.13 的 `require(esm)` 同步拿到
 *    （本仓 `engines.node` = `>=22.13`，真包的 engines 也是这么写的）。
 * 2. 行上的 `config:`（`data.*` 三个根、`chatCollections`、`kb`…）**原样**由宿主传给被挂插件；
 *    本文件不碰它、不补默认值、不改键名 —— 它只是把 `apply` 原样转出去，config 照旧流进去。
 * 3. 转出去的是**真包自己的导出**（`name` / `inject` / `apply` / `config` / `version` + 默认导出），
 *    ⛔ 这里不重新实现任何逻辑：薄壳一旦长胖，行为就会与真包漂移（那比绝对路径更糟）。
 *
 * ## 自检
 * `resolveAnimaRag()` / `pickPlugin()` / `candidateHomes()` 都是**纯函数**并已导出 ——
 * 派单的静态验收直接拿它们跑（见仓库 README「已知限制」与派单报告）。
 *
 * @module anima-rag
 * @license CC-BY-NC-4.0
 */

import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 日志/报错用的前缀（与其它预设模块同一套观感）。 */
const TAG = 'anima-rag'

/** 要解析的真包名。 */
const SPECIFIER = 'dsh-anima-rag'

/**
 * 候选 DSH 根（纯函数）：`$DSH_HOME` 优先，其次 `~/.dsh`；空串/重复一律剔掉。
 * @param {Record<string, unknown>} [env] - 环境变量表（默认 `process.env`）。
 * @param {string} [homeDir] - 家目录（默认 `os.homedir()`）。
 * @returns {string[]} 依次尝试的根目录。
 */
export function candidateHomes(env = {}, homeDir = homedir()) {
  const seen = []
  const push = (value) => {
    if (typeof value !== 'string') return
    const trimmed = value.trim()
    if (trimmed === '') return
    if (seen.includes(trimmed)) return
    seen.push(trimmed)
  }
  push(env.DSH_HOME)
  push(join(homeDir, '.dsh'))
  return seen
}

/**
 * `<profile>/package.json` 的 `dependencies` 里是否声明了 `dsh-anima-rag`（纯函数，读不到 ⇒ false）。
 * @param {string} packageJsonPath - 该 profile 的 package.json 路径。
 * @returns {boolean}
 */
export function declaresDependency(packageJsonPath) {
  try {
    if (!existsSync(packageJsonPath)) return false
    const doc = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    const deps = doc && typeof doc.dependencies === 'object' && doc.dependencies !== null ? doc.dependencies : {}
    return Object.prototype.hasOwnProperty.call(deps, SPECIFIER)
  } catch {
    return false
  }
}

/** 失败原因只留第一行（多行堆栈塞进日志没人看）。 */
function firstLine(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.split('\n')[0]
}

/**
 * 在某个候选目录下解析真包（同步）。**不抛**：失败如实回原因。
 * @param {string} dir - 候选目录（profile 根，或 `profiles/node_modules` 这类）。
 * @returns {{ok: true, path: string} | {ok: false, error: string}}
 */
function tryResolveAt(dir) {
  // createRequire 的锚点只需要是个绝对路径字符串（文件不必存在）：
  // 解析从「锚点所在目录」开始向上找 node_modules —— 于是 <dir>/node_modules 与
  // <dir>/../node_modules（= harness 基）都在候选里。
  const anchor = join(dir, 'package.json')
  try {
    return { ok: true, path: createRequire(anchor).resolve(SPECIFIER) }
  } catch (error) {
    return { ok: false, error: firstLine(error) }
  }
}

/**
 * 在运行环境里定位真包（纯函数 + 同步 IO，**不抛**；拿不到时返回带完整原因清单的失败记录）。
 *
 * 判据（对每个候选目录各算一次）：
 *   · declared   = `<dir>/package.json` 的 dependencies 含 dsh-anima-rag
 *   · resolvable = 以 `<dir>` 为锚点能 resolve 到 dsh-anima-rag
 * 排序：declared+resolvable > resolvable-only；同档按目录名升序（确定性）。
 *
 * @param {{env?: Record<string, unknown>, homeDir?: string, profilesOf?: (root: string) => string[]}} [options]
 * @returns {{ok: true, home: string, dir: string, name: string, path: string, declared: boolean}
 *          | {ok: false, tried: Array<{root: string, note: string, dirs: Array<{name: string, declared: boolean, resolvable: boolean, error?: string}>}>}}
 */
export function resolveAnimaRag(options = {}) {
  const env = options.env ?? (typeof process !== 'undefined' ? process.env : {})
  const homeDir = options.homeDir ?? homedir()
  const tried = []

  for (const root of candidateHomes(env, homeDir)) {
    const profilesDir = join(root, 'profiles')
    let names = []
    try {
      if (!existsSync(profilesDir) || !statSync(profilesDir).isDirectory()) {
        tried.push({ root, note: '没有 profiles 目录', dirs: [] })
        continue
      }
      names = readdirSync(profilesDir)
        .filter((name) => !name.startsWith('.'))
        .filter((name) => {
          try {
            return statSync(join(profilesDir, name)).isDirectory()
          } catch {
            return false
          }
        })
        .sort()
    } catch (error) {
      tried.push({ root, note: '读 profiles 目录失败：' + firstLine(error), dirs: [] })
      continue
    }

    const dirs = names.map((name) => {
      const dir = join(profilesDir, name)
      const declared = declaresDependency(join(dir, 'package.json'))
      const resolved = tryResolveAt(dir)
      return resolved.ok
        ? { name, dir, declared, resolvable: true, path: resolved.path }
        : { name, dir, declared, resolvable: false, error: resolved.error }
    })
    tried.push({ root, note: '枚举了 ' + names.length + ' 个候选目录', dirs })

    const hit = dirs
      .filter((entry) => entry.resolvable)
      .sort((a, b) => (Number(b.declared) - Number(a.declared)) || a.name.localeCompare(b.name))[0]
    if (hit !== undefined) {
      return { ok: true, home: root, dir: hit.dir, name: hit.name, path: hit.path, declared: hit.declared }
    }
  }
  return { ok: false, tried }
}

/**
 * 把失败记录摊成一段可读、可照做的报错文本（每条原因原样在案，⛔ 不吞）。
 * @param {ReturnType<typeof resolveAnimaRag>} result - `resolveAnimaRag()` 的失败记录。
 * @returns {string}
 */
export function describeFailure(result) {
  const lines = [
    TAG + ': 找不到 ' + SPECIFIER + ' —— 预设里 anima-rag 这一行挂不上。',
    '  为什么会这样：' + SPECIFIER + ' 是**某个 profile 的依赖**，不是 harness 基（$DSH_HOME/profiles/node_modules）里的包，',
    '  所以裸包名不可用、本仓也不写死机器路径 —— 只能在运行期按锚点链找它。',
    '  锚点链试过这些根：',
  ]
  for (const attempt of result.tried) {
    lines.push('  · root=' + attempt.root + ' → ' + attempt.note)
    for (const dir of attempt.dirs) {
      lines.push(
        '      - profiles/' + dir.name + '：declared=' + (dir.declared ? 'yes' : 'no')
        + ' resolvable=' + (dir.resolvable ? 'yes' : 'no')
        + (dir.resolvable ? '' : '（' + dir.error + '）'),
      )
    }
  }
  lines.push(
    '  怎么修（任选一条）：',
    '    ① 把插件装进你正在用的那个 profile（下面尖括号换成你的 profile 名，例如 web），然后开**新会话**：',
    '         cd "$DSH_HOME/profiles/<你的 profile>" && npm i ' + SPECIFIER,
    '    ② 不用这个插件：把 agent.cordis.yml 里 anima-rag 那一行（id+name）注释掉或删掉。',
    '  详见 README「依赖」一节。',
  )
  return lines.join('\n')
}

/**
 * 从真包导出里挑出插件实体（纯函数）—— 认三种形态，认不出就抛（⛔ 不静默少挂一个插件）：
 *   A. 命名导出形态：`{ name, inject, apply, config, version }`（`dsh-anima-rag` 0.1.0 就是这种）
 *   B. 默认导出是函数：`default(ctx, config)`
 *   C. 默认导出是对象且带 `apply`
 * @param {Record<string, unknown>} mod - `require()` 拿到的模块导出。
 * @returns {{name: unknown, inject: unknown, apply: Function, config: unknown, version: unknown, entity: unknown}}
 */
export function pickPlugin(mod) {
  const ns = mod !== null && typeof mod === 'object' ? mod : {}
  const fallback = ns.default
  const entity = fallback !== undefined && fallback !== null ? fallback : ns
  const fromEntity = entity !== null && typeof entity === 'object' ? entity : {}
  const apply =
    typeof ns.apply === 'function' ? ns.apply
      : typeof fallback === 'function' ? fallback
        : typeof fromEntity.apply === 'function' ? fromEntity.apply
          : undefined
  if (typeof apply !== 'function') {
    throw new Error(
      TAG + ': ' + SPECIFIER + ' 的导出形态不认识 —— 没有 `apply`，也没有函数型默认导出。'
      + '导出键：[' + Object.keys(ns).join(', ') + ']。⛔ 不在薄壳里替它实现挂载逻辑（那会让行为与真包漂移）。',
    )
  }
  const pick = (key) => (ns[key] !== undefined ? ns[key] : fromEntity[key])
  return { name: pick('name'), inject: pick('inject'), apply, config: pick('config'), version: pick('version'), entity }
}

// ─────────────────────────── 以下在加载本文件时同步执行 ───────────────────────────

const found = resolveAnimaRag()
if (!found.ok) {
  // 先大声写日志再抛：宿主就算只留一行 stderr，也能看见完整原因。
  const message = describeFailure(found)
  console.error('[' + TAG + '] ★★★ ' + message)
  throw new Error(message)
}

const loaded = (() => {
  try {
    // 用**解析出来的绝对路径** require（与宿主直挂时是同一条路径 ⇒ 同一个模块实例/缓存条目）。
    return { ok: true, mod: createRequire(join(found.dir, 'package.json'))(found.path) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
  }
})()

if (!loaded.ok) {
  const detail = [
    TAG + ': 找到 ' + SPECIFIER + ' 了（' + found.path + '），但 require 失败。',
    '  为什么可能：真包是 ESM，Node 的 require(esm) 撑不住**顶层 await**；或它自己的依赖没装全。',
    '  原始错误：' + firstLine(loaded.error),
    '  怎么修：cd "…/profiles/' + found.name + '" && npm i ' + SPECIFIER + '（把它的依赖补全）后开新会话。',
  ].join('\n')
  console.error('[' + TAG + '] ★★★ ' + detail)
  throw new Error(detail)
}

const plugin = pickPlugin(loaded.mod)

/** 一行的挂载日志：证明"用哪条判据、找到了哪个 profile、挂的是哪个文件"。 */
console.log(
  '[' + TAG + '] 已解析到 ' + SPECIFIER + '：' + found.path
  + '（root=' + found.home + '，profile=' + found.name + '，判据=' + (found.declared ? 'declared+resolvable' : 'resolvable') + '）',
)

// 真包的导出，原样转出（键名、值、以及"默认导出"的选择都与源包一致）。
export const name = plugin.name
export const inject = plugin.inject
export const apply = plugin.apply
export const config = plugin.config
export const version = plugin.version
export default plugin.entity
