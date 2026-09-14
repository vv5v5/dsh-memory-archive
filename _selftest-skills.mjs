/**
 * _selftest-skills.mjs —— 宿主半侧 skill 注册（lib/index.js apply → registerSkills）的自检台。
 *
 * 覆盖（对应任务 6 条）：
 *   ① register 被调 3 次，三个 name 正确且符合 kebab-case（^[a-z0-9][a-z0-9-]*$）
 *   ② description 与 content 都非空，content 长度 > 500（真把包内 .md 全文带上）
 *   ③ 第三个 skill 的 invocation.userInvocable === false（不进 / 列表），另外两个不是 false
 *   ④ disposer 真经 ctx.effect 挂上：effect 被调 ≥3 次，逐个执行后 disposed 增加
 *   ⑤ 反证：让一个正文文件读不到（复制树到临时目录、删掉其中一个 .md）
 *      ⇒ apply() 不抛、只跳过那一个、其余仍注册
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
check('① register 被调 2 次（合并后：RP 助手 + 知识库）', state.registered.length === 2, `实际 ${state.registered.length}：${JSON.stringify(names)}`)
check('① 两个 name 正确且顺序 = defs 声明序',
  JSON.stringify(names) === JSON.stringify(['rp-assistant', 'config-kb']),
  JSON.stringify(names))
check('① name 全部符合 ^[a-z0-9][a-z0-9-]*$', names.every((n) => /^[a-z0-9][a-z0-9-]*$/.test(n)), JSON.stringify(names))
check('② description 全部非空', state.registered.every((s) => typeof s.description === 'string' && s.description.trim().length > 0))
check('② content 非空且长度 > 500（正文是包内 .md 全文）',
  state.registered.every((s) => typeof s.content === 'string' && s.content.length > 500),
  state.registered.map((s) => `${s.name}:${(s.content || '').length}`).join(', '))
check('② whenToUse：人可见那个给了、只给模型的那个可缺省',
  typeof state.registered[0].whenToUse === 'string' && state.registered[0].whenToUse.length > 0)
check('★ description 开头就是中文名「RP 助手」（name 放不下中文 ⇒ 靠 description 首段露脸）',
  state.registered[0].description.startsWith('RP 助手'),
  state.registered[0].description.slice(0, 40))
check('★ 合并后不该再注册旧的两个 name（否则 / 列表里会出现三个重复的助手）',
  !names.includes('character-card-assistant') && !names.includes('config-assistant'),
  JSON.stringify(names))
check('③ 第二个 invocation = { modelInvocable: true, userInvocable: false }',
  JSON.stringify(state.registered[1].invocation) === JSON.stringify({ modelInvocable: true, userInvocable: false }),
  JSON.stringify(state.registered[1].invocation))
check('③ RP 助手的 invocation.userInvocable 不是 false（可出现在 / 列表）',
  state.registered[0].invocation?.userInvocable !== false)

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

check('④ disposer 经 ctx.effect 挂上：effect 被调恰好 2 次、带标签、返回值是可调用的 disposer',
  state.effects.length === 2
  && state.effects.every((e) => e.label.includes('skill') && typeof e.dispose === 'function'),
  JSON.stringify(state.effects.map((e) => e.label)))
check('④ 挂上后（未卸载）disposed 仍为 0', state.disposed === 0, String(state.disposed))
for (const e of state.effects) e.dispose()
check('④ 卸载：逐个调用 effect 持有的 disposer ⇒ disposed 增加 2', state.disposed === 2, String(state.disposed))

// ---- ⑤ 反证：正文读不到 ⇒ apply 不抛、跳过那一个、其余照常 ----
mkdirSync(join(tmp, 'lib'), { recursive: true })
mkdirSync(join(tmp, 'skill'), { recursive: true })
cpSync(join(repo, 'lib', 'index.js'), join(tmp, 'lib', 'index.js'))
for (const f of ['rp-assistant.md', 'kb-dsh-preset-architecture.md']) {
  cpSync(join(repo, 'skill', f), join(tmp, 'skill', f))
}
const missing = join(tmp, 'skill', 'rp-assistant.md')
unlinkSync(missing) // 只让这一个读不到

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
check('⑤ 反证：读不到的那一个被跳过、另一个照常注册',
  JSON.stringify(names2.sort()) === JSON.stringify(['config-kb']),
  JSON.stringify(names2))
check('⑤ 反证：跳过时有 log.warn 且点名该 skill',
  ctx2.state.logs.warn.some((m) => m.includes('rp-assistant') && m.includes('跳过')),
  JSON.stringify(ctx2.state.logs.warn))
check('⑤ 反证：剩下那个的 disposer 仍经 effect 挂上', ctx2.state.effects.length === 1, String(ctx2.state.effects.length))

// ---- 收尾：临时目录清掉 ----
rmSync(tmp, { recursive: true, force: true })
check('临时目录已删除', !existsSync(tmp), tmp)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
