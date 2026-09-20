#!/usr/bin/env node
/**
 * 自检台：**状态子系统已剥离**（2026-09-20）—— 防回流。
 *
 * 用户口径（原话）：「现在开始改状态系统。整个剥离我们原本的写的状态工具。
 *   现在的状态由周目笔记维护」。
 *
 * 剥离的是：`state-bridge` 子包（`state:card` 段 + `state_list/state_show/state_seed/state_patch/state_purge`
 * 五个工具）+ 它在**两级**（宿主面 cordis.patch.yml、RP 预设 agent.cordis.yml）的挂载。
 * 替代：状态改由周目笔记 `<周目>/.roleplay-memory/state.md` 维护（模型用 `memory_write` 写）。
 *
 * ⛔ 这个台子存在的唯一理由：**别让它悄悄长回来**（挂载、工具白名单、段名册三处最容易漏）。
 * ⚠️ 注释里的历史叙述（"原来是 X"）**不算违规** —— 所以这里只钉**代码位置**，不做全文禁词。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const PASS = []
const FAIL = []
const t = (name, fn) => {
  try {
    fn()
    PASS.push(name)
  } catch (e) {
    FAIL.push(`${name}: ${e?.message || e}`)
  }
}
const read = (p) => readFileSync(p, 'utf8')

t('S1 子包本体已归档：`state-bridge/` 不在，`_removed-state-bridge-20260920/` 在（代码还在，只是不挂）', () => {
  assert.equal(existsSync(path.join(here, 'state-bridge')), false, '⛔ state-bridge/ 又回来了？')
  const arch = path.join(here, '_removed-state-bridge-20260920')
  assert.equal(existsSync(arch), true, '归档目录不见了（是不是被误删）')
  assert.equal(existsSync(path.join(arch, 'lib', 'index.js')), true, '归档里该留着原实现')
  assert.equal(existsSync(path.join(arch, 'REMOVED.md')), true, '归档里该有一份"为什么剥离 + 怎么复活"')
})

t('S2 `package.json`：不再导出/打包 state-bridge（⛔ 导出指向缺失文件会让装载炸）', () => {
  const pkg = JSON.parse(read(path.join(here, 'package.json')))
  assert.equal(pkg.exports['./state-bridge'], undefined, '⛔ exports 里还有 ./state-bridge')
  assert.equal((pkg.files || []).includes('state-bridge'), false, '⛔ files 里还打包 state-bridge')
})

t('S3 `cordis.patch.yml`（宿主面）：没有 state-bridge 挂载块', () => {
  const yml = read(path.join(here, 'cordis.patch.yml'))
  assert.equal(/^\s*-?\s*id:\s*state-bridge\s*$/m.test(yml), false, '⛔ 宿主面还挂着 state-bridge')
  assert.equal(yml.includes("'dsh-memory-archive/state-bridge'"), false, '⛔ 还写着子路径引用')
})

t('S4 `lib/index.js`：段名册里没有 state:card（留着会让 replace 看守永远报"缺失"）', () => {
  const src = read(path.join(here, 'lib', 'index.js'))
  const m = /const OUR_SECTION_NAMES = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(src)
  assert.ok(m, '没找到 OUR_SECTION_NAMES')
  assert.equal(m[1].includes('state:card'), false, '⛔ 段名册里还有 state:card：' + m[1])
  assert.equal(m[1].includes('rp:storyAnchor'), false, '⛔ story-anchor 暂时不注册，名册里不该还期待它')
})

t('S5 `preset-modules/rp-tool-scope.js`：保留名单里没有 state_*（工具都不存在了）', () => {
  const src = read(path.join(here, 'preset-modules', 'rp-tool-scope.js'))
  const keep = /const DEFAULT_KEEP_PATTERNS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(src)
  assert.ok(keep, '没找到 DEFAULT_KEEP_PATTERNS')
  assert.equal(/state_/.test(keep[1]), false, '⛔ 保留名单里还有 state_*：' + keep[1])
  const drop = /const DEFAULT_DROP_PATTERNS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(src)
  assert.ok(drop, '没找到 DEFAULT_DROP_PATTERNS')
  assert.equal(/state_purge/.test(drop[1]), false, '⛔ 排除名单里还有 state_purge')
})

t('S6 面板：`state:card` 只作"已退役"的历史识别保留（⛔ 不再当预期存在的段）', () => {
  const src = read(path.join(here, 'lib', 'client.js'))
  const miss = /const PROMPT_MAP_MISSING_KEYS = \[([^\]]*)\]/.exec(src)
  assert.ok(miss, '没找到 PROMPT_MAP_MISSING_KEYS')
  assert.equal(miss[1].includes('stateCard'), false, '⛔ 还在期待 state:card 出现')
  assert.equal(miss[1].includes('storyAnchor'), false, '⛔ 还在期待 story-anchor 出现')
  // 识别与注释**保留**（老捕获里还有那一行）—— 注释里必须带"已退役"字样
  assert.ok(src.includes('【已退役 · 2026-09-20】'), '老捕获那两行的注释该标"已退役"')
})

t('S7 预设（若本机有）：两级挂载都没了，且正文改指 `state.md`', () => {
  const preset = 'C:/Users/w/.dsh/.agent-presets/roleplay/agent.cordis.yml'
  if (!existsSync(preset)) return // 别的机器上没这份预设 ⇒ 跳过（⛔ 不假装测过）
  const yml = read(preset)
  assert.equal(/^- id: state-bridge\s*$/m.test(yml), false, '⛔ 预设里还挂着 state-bridge')
  assert.equal(/^- id: story-anchor\s*$/m.test(yml), false, '⛔ 预设里还挂着 story-anchor（口径是"暂时不注册"）')
  assert.ok(yml.includes('state.md'), '预设正文该指向周目笔记的 state.md')
})

t('S8 四个 state_* 工具名不再出现在**任何** lib/ 源码里（⛔ 防回流；注释提及不算）', () => {
  const dir = path.join(here, 'lib')
  const bad = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.js')) continue
    const src = read(path.join(dir, f))
    // 只查"当成工具名在用"的位置：register 名字、白名单、字符串字面量里的工具名调用面
    for (const tool of ['state_patch', 'state_seed', 'state_show', 'state_list', 'state_purge']) {
      const re = new RegExp(`(register\\(\\{[^}]*name:\\s*'${tool}'|'${tool}'\\s*[,)\]])`)
      if (re.test(src)) bad.push(f + ' → ' + tool)
    }
  }
  assert.deepEqual(bad, [], '这些文件还在代码位置引用已剥离的工具名：' + bad.join('、'))
})

console.log(`PASS ${PASS.length}: ${PASS.join(' | ')}`)
if (FAIL.length) {
  console.log(`FAIL ${FAIL.length}: ${FAIL.join(' | ')}`)
  process.exit(1)
}
console.log('ALL PASS')
