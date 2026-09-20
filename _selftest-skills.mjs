/**
 * _selftest-skills.mjs —— 宿主半侧 skill 注册（lib/index.js apply → registerSkills）的自检台。
 *
 * 覆盖（2026-09-20 重塑后：**只剩一个 skill**）：
 *   ① register 被调 **1** 次，name = `rp-assistant` 且符合 kebab-case（^[a-z0-9][a-z0-9-]*$）
 *   ② description 与 content 都非空，content 长度 > 500（真把包内 .md 全文带上）
 *   ③ `rp-assistant` 人可见（`invocation.userInvocable !== false`，进 / 列表）
 *   ④ disposer 真经 ctx.effect 挂上：effect 被调 1 次，执行后 disposed 增加
 *   ④b ★ 资料基准目录：`resourceBase = {kind:'directory', path: <…>/skill/rp-assistant}`
 *      —— 有了它，正文里写的相对路径（`../README.md`、`refs/*.md`）模型才读得到
 *   ⑤ 反证：正文文件读不到（复制树到临时目录、删掉唯一的 SKILL.md）
 *      ⇒ apply() 不抛、0 注册、warn 点名它
 *   ⑥ exports.inject 含 'skills'
 *
 * ★ 全程用记账假 ctx，不碰真实宿主；临时目录测完即删。
 */
import { cpSync, existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = dirname(fileURLToPath(import.meta.url))
const tmp = mkdtempSync(join(repo, '_selftest-skills-tmp-'))
process.env.DSH_HOME = tmp // 隔离：绝不碰 ~/.dsh

let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`PASS ${name}`)
  else {
    failures++
    console.log(`FAIL ${name}${detail ? ' —— ' + detail : ''}`)
  }
}

function makeAccountingCtx() {
  const state = {
    registered: [],
    effects: [],
    disposed: 0,
    logs: { warn: [], error: [], info: [] },
  }
  const ctx = {
    skills: {
      register(skill) {
        state.registered.push(skill)
        return () => {
          state.disposed++
        }
      },
    },
    // 照 cordis 语义记账：effect 立即执行 fn，并持有其【返回值】作为 disposer
    // （registerHttpApi 的既有写法就是 effect 回调执行后返回 disposer）。
    effect(fn, label) {
      const dispose = fn()
      state.effects.push({ label: String(label ?? ''), dispose })
      return dispose
    },
    logger: {
      info: (m) => state.logs.info.push(String(m)),
      warn: (m) => state.logs.warn.push(String(m)),
      error: (m) => state.logs.error.push(String(m)),
    },
  }
  return { ctx, state }
}

// ---- ⑥ + ①②③④：真调 apply(fakeCtx) ----
const mod = await import('./lib/index.js')
check("exports.inject 含 'skills'", Array.isArray(mod.inject) && mod.inject.includes('skills'), JSON.stringify(mod.inject))
check('lib/client.js 的 inject 未被波及（仍是 [slots]，从导入侧旁证）', mod.inject.length === 1, JSON.stringify(mod.inject))

const { ctx, state } = makeAccountingCtx()
let applyThrew = null
try {
  mod.apply(ctx)
} catch (e) {
  applyThrew = e
}
check('apply(fakeCtx) 不抛', applyThrew === null, String(applyThrew))

const names = state.registered.map((s) => s.name)
check('① register 被调 **1** 次（2026-09-20 起只剩一个通用 skill）',
  state.registered.length === 1, `实际 ${state.registered.length}：${JSON.stringify(names)}`)
check('① name = rp-assistant（沿用旧名，内容是新的：通用 + 带资料）',
  JSON.stringify(names) === JSON.stringify(['rp-assistant']),
  JSON.stringify(names))
check('① name 符合 ^[a-z0-9][a-z0-9-]*$', names.every((n) => /^[a-z0-9][a-z0-9-]*$/.test(n)), JSON.stringify(names))
check('② description 非空', state.registered.every((s) => typeof s.description === 'string' && s.description.trim().length > 0))
check('② content 非空且长度 > 500（正文是包内 .md 全文）',
  state.registered.every((s) => typeof s.content === 'string' && s.content.length > 500),
  state.registered.map((s) => `${s.name}:${(s.content || '').length}`).join(', '))
check('② whenToUse 给了（人可见、要能被路由到）',
  typeof state.registered[0].whenToUse === 'string' && state.registered[0].whenToUse.length > 0)
check('★ description 开头就是中文名「RP 助手」（name 放不下中文 ⇒ 靠 description 首段露脸）',
  state.registered[0].description.startsWith('RP 助手'),
  state.registered[0].description.slice(0, 40))
check('★ 重塑后不该再注册旧的两个 name（列表里不许再出现第二个助手 / 知识库）',
  !names.includes('character-card-assistant') && !names.includes('config-assistant') && !names.includes('config-kb'),
  JSON.stringify(names))
check('③ RP 助手的 invocation.userInvocable 不是 false（可出现在 / 列表）',
  state.registered[0].invocation?.userInvocable !== false)

// ---- ④b ★ 资料基准目录（2026-09-20 新加）----
// 为什么非有这条不可：正文 §六 用**相对路径**指向三份资料（`../README.md`、`refs/*.md`）。
// 官方渲染只有在 `resourceBase.kind === 'directory'` 时才会告诉模型「基准目录是哪个」
// （`packages/skill/skill/src/index.ts:187-201`）；漏了它 ⇒ 模型按相对路径读**读不到**，
// 而且**注册与列表都照常**（静默失效）。
{
  const rb = state.registered[0].resourceBase
  check('④b resourceBase = {kind:directory, path:…/skill/rp-assistant}',
    rb !== undefined && rb.kind === 'directory'
    && typeof rb.path === 'string' && /[\\/]skill[\\/]rp-assistant$/.test(rb.path),
    JSON.stringify(rb))
  check('④b 基准目录真的存在，且三份资料都在里面（否则模型按相对路径读会扑空）',
    rb !== undefined && existsSync(join(rb.path, 'SKILL.md'))
    && existsSync(join(rb.path, 'refs', 'dsh-internals.md'))
    && existsSync(join(rb.path, 'refs', 'dsh-tavern.md'))
    && existsSync(join(rb.path, 'refs', 'dsh-anima-rag.md'))
    && existsSync(join(rb.path, '..', '..', 'README.md')), // 正文里的 ../README.md = 包根 README
    String(rb && rb.path))
}

// ---- ★ DSH **加载期**的必填字段契约 ----
// 照抄官方校验：packages/skill/skill/src/index.ts:759-768
//   if (typeof name !== 'string') throw 'loaded skill name must be a string'
//   … description / whenToUse? / source / provider / content / path? 同理
// 为什么非有这条不可：**漏字段时注册不报错、`/` 列表照常出现**，只有真去「加载」才抛。
// 2026-09-13 的事故就是这样：registerSkills 漏了 `source`（它是 SkillRegistration 从
// SkillSummary 继承来的必填项），于是两个 skill 在列表里都看得见、一点就报
//   loaded skill "rp-agent-optimization" source must be a string
// —— 当时的台子只记了「register 被调了几次」，没校验对象形状，所以整个放了过去。
// 这条就是那次事故的补丁；以后 DSH 若收紧契约，请同步这里（行号见上）。
function loadShapeErrors(s) {
  const errs = []
  if (typeof s.name !== 'string') errs.push('name')
  if (typeof s.description !== 'string') errs.push('description')
  if (s.whenToUse !== undefined && typeof s.whenToUse !== 'string') errs.push('whenToUse')
  if (typeof s.source !== 'string') errs.push('source') // ← 事故那一项
  if (s.provider !== undefined && typeof s.provider !== 'string') errs.push('provider')
  if (typeof s.content !== 'string') errs.push('content')
  if (s.path !== undefined && typeof s.path !== 'string') errs.push('path')
  return errs
}
for (const s of state.registered) {
  const errs = loadShapeErrors(s)
  check(`★ 加载期必填字段齐（${s.name}）`, errs.length === 0, errs.length ? '缺/类型错：' + errs.join(', ') : '')
}
check("★ source 取值 = 'runtime'（apply() 里注册的运行时技能；SkillSource 的合法字面量之一）",
  state.registered.every((s) => s.source === 'runtime'),
  JSON.stringify(state.registered.map((s) => s.source)))
// ★ 反证：证明上面这条断言**能红**，不是橡皮图章
check('★ 反证：去掉 source 的对象必须被这条断言判为不齐',
  loadShapeErrors({ name: 'x', description: 'y', content: 'z' }).includes('source'))
check('★ 反证：source 传成非字符串（对象）也必须被判为不齐',
  loadShapeErrors({ name: 'x', description: 'y', content: 'z', source: { v: 1 } }).includes('source'))

check('④ disposer 经 ctx.effect 挂上：effect 被调恰好 1 次、带标签、返回值是可调用的 disposer',
  state.effects.length === 1
  && state.effects.every((e) => e.label.includes('skill') && typeof e.dispose === 'function'),
  JSON.stringify(state.effects.map((e) => e.label)))
check('④ 挂上后（未卸载）disposed 仍为 0', state.disposed === 0, String(state.disposed))
for (const e of state.effects) e.dispose()
check('④ 卸载：调用 effect 持有的 disposer ⇒ disposed 增加 1', state.disposed === 1, String(state.disposed))

// ---- ⑤ 反证：正文读不到 ⇒ apply 不抛、0 注册、warn 点名 ----
// ★ 只剩一个 skill 之后，"读不到 ⇒ 跳过、其余照常" 这条不再成立（没有"其余"了）；
//   现在要证的是更硬的半边：**降级不许拖垮 apply**，且**不许悄悄装个空壳**。
mkdirSync(join(tmp, 'lib'), { recursive: true })
cpSync(join(repo, 'lib', 'index.js'), join(tmp, 'lib', 'index.js'))
cpSync(join(repo, 'skill', 'rp-assistant'), join(tmp, 'skill', 'rp-assistant'), { recursive: true })
unlinkSync(join(tmp, 'skill', 'rp-assistant', 'SKILL.md')) // 只删正文，资料留着（资料不是注册期读的）

const mod2 = await import(pathToFileURL(join(tmp, 'lib', 'index.js')).href)
const ctx2 = makeAccountingCtx()
let apply2Threw = null
try {
  mod2.apply(ctx2.ctx)
} catch (e) {
  apply2Threw = e
}
const names2 = ctx2.state.registered.map((s) => s.name)
check('⑤ 反证：apply() 不抛（读盘失败只降级）', apply2Threw === null, String(apply2Threw))
check('⑤ 反证：读不到正文 ⇒ **0 注册**（⛔ 不许注册空壳）',
  names2.length === 0, JSON.stringify(names2))
check('⑤ 反证：跳过时有 log.warn 且点名该 skill',
  ctx2.state.logs.warn.some((m) => m.includes('rp-assistant') && m.includes('跳过')),
  JSON.stringify(ctx2.state.logs.warn))
check('⑤ 反证：没有任何 disposer 被挂上（没注册就不该挂）', ctx2.state.effects.length === 0, String(ctx2.state.effects.length))

// ---- 收尾：临时目录清掉 ----
rmSync(tmp, { recursive: true, force: true })
check('临时目录已删除', !existsSync(tmp), tmp)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
