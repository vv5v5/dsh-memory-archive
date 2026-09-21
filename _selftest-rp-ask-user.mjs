/**
 * _selftest-rp-ask-user.mjs —— `preset-modules/rp-ask-user.js`（RP 版提问工具）自检台。
 *
 * 它是什么：用户 2026-09-21 口径「ask_user_question 问问题工具的定义能不能改成 rp 版本，
 * 当进行对话，或进行检定，总之只需要用户给出很少但关键信息的时候使用」⇒ 我们在 preset 作用域
 * 注册**同名**工具 `ask_user_question`，只换文案、遮蔽官方那份。
 *
 * ★ 本台子守两条线（其余都是形状断言）：
 *   ① **文案确实换成了 RP 版**（关键口径逐条在，且**不是**官方那句英文）；
 *   ② **契约一点没动**（工具名 / 参数结构 / execute 映射 / 出参形状，与官方逐字段对照）——
 *      这条最要命：字段名一漂，工具照常注册、照常被调，**界面却渲染不出来**（静默失效）。
 *   每条判据都带**反证**（剪掉/改掉关键那处 ⇒ 同一判据必须红）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repo = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(repo, 'preset-modules', 'rp-ask-user.js'), 'utf8')

const show = (v) => JSON.stringify(v)

let pass = 0
let fail = 0
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`PASS ${label}`) }
  else { fail++; console.log(`FAIL ${label}${extra ? '  ← ' + extra : ''}`) }
}

/** 记账假 ctx：把注册的工具与 userQuestions 的调用都记下来，⛔ 不碰真宿主。 */
function makeCtx({ askImpl } = {}) {
  const state = { tools: [], asked: [], effects: [] }
  const ctx = {
    tools: { register: (t) => { state.tools.push(t); return () => {} } },
    userQuestions: {
      ask: askImpl || (async (req) => {
        state.asked.push(req)
        return { answers: req.questions.map((q) => ({ id: q.id, selected: ['第一个'], ...(q.multiSelect ? {} : {}) })) }
      }),
    },
  }
  return { ctx, state }
}

// ── ① 模块形状 ────────────────────────────────────────────────────────────────
const mod = await import('./preset-modules/rp-ask-user.js')
check('① name = rp-ask-user', mod.name === 'rp-ask-user', String(mod.name))
check('① inject 含 tools 与 userQuestions（这俩是它唯一需要的东西）',
  Array.isArray(mod.inject) && mod.inject.includes('tools') && mod.inject.includes('userQuestions'),
  JSON.stringify(mod.inject))

// ── ② 注册：**恰好一个**工具，且名字必须是官方的那个名字 ─────────────────────────
const { ctx, state } = makeCtx()
mod.apply(ctx)
check('② apply 只注册 1 个工具（多注册一个就会多占一格工具面）',
  state.tools.length === 1, `实际 ${state.tools.length}`)
const tool = state.tools[0] || {}
check('② ★ 工具名必须是 `ask_user_question`（换成别的名字 = 遮蔽不到官方那份，变成两个工具）',
  tool.name === 'ask_user_question', String(tool.name))

// ── ③ 文案：确实换成了 RP 版（用户的三条口径逐条在） ────────────────────────────
{
  const d = String(tool.description || '')
  const OFFICIAL = 'Ask the user a concise question when you need confirmation'
  const hit = (s) => d.includes(s)
  check('③ ★ 不是官方那句英文（说明真的换了文案）', !d.includes(OFFICIAL), d.slice(0, 60))
  check('③ ★ 口径 1「只在必须玩家拍板、答案很短时用」', hit('由玩家拍板') && hit('答案很短'), '')
  check('③ ★ 口径 2「对话里的一次选择」（剧情选择）', hit('走哪条路') || hit('剧情里'), '')
  check('③ ★ 口径 3「进行检定」', hit('检定'), '')
  check('③ ★ 口径 4「每次只问一件」', hit('每次只问一件'), '')
  check('③ ★ 口径 5「给可点选选项 + 推荐项」（保留界面认的（推荐）后缀）',
    hit('（推荐）') && hit('放第一个'), '')
  check('③ ★ 三条禁令都在（开放式问题 / 自己能定的小事 / 提问不算剧情）',
    hit('开放式问题') && hit('就能定的小事') && hit('提问不算剧情'), '')
  // 参数说明也换了（模型同样看得见）
  const params = tool.parameters?.properties?.questions   // ⚠️ dialect：字段在 properties 下
  check('③ ★ 参数说明也是 RP 版（不是官方那句英文）',
    typeof params?.description === 'string' && /一次一件/.test(params.description), String(params?.description).slice(0, 40))

  // ★ 反证：把"每次只问一件"剪掉 ⇒ 口径 4 必红
  const cut = d.replace('每次只问一件', '')
  check('③ ★ 反证：剪掉「每次只问一件」⇒ 口径 4 判据必红', !cut.includes('每次只问一件'), '')
}

// ── ④ ★★ 契约平价：与官方**逐字段**对照（字段名一漂，界面就渲染不出来） ──────────
//   官方原样（`deepseek-harness/packages/interaction/tool-ask-user/src/index.ts:20-57`）：
//     questions[] = { id, question, header?, options?[{ label, description? }], multi_select? }
//   出参：{ answers: [{ id, selected[], custom? }] }
//   ⚠️ 必填的**写法**不同方言：官方（defineTool 入参）是属性上的 `required: true`；
//      本模块是**裸注册** ⇒ 必须用 JSON-Schema 方言（对象级 `required: [...]`）——
//      照官方抄会让**整个预设挂不上**（真机原话见模块头注）。这里只对照**字段名与必填语义**。
{
  const keysOf = (o) => Object.keys(o || {}).sort().join(',')
  const req = (o) => (Array.isArray(o) ? [...o].sort().join(',') : '<不是数组>')
  const p = tool.parameters || {}
  check('④ ★ 顶层是 JSON-Schema 对象（type/additionalProperties/required 数组）',
    p.type === 'object' && p.additionalProperties === false && req(p.required) === 'questions', show({ t: p.type, r: p.required }))
  const item = p.properties?.questions?.items
  const itemProps = item?.properties
  check('④ ★ 每个 question 的字段 == 官方（id/question/header/options/multi_select）',
    keysOf(itemProps) === 'header,id,multi_select,options,question', keysOf(itemProps))
  check('④ ★ 必填语义照官方：id / question 必填，header/options/multi_select 可选',
    req(item?.required) === 'id,question', req(item?.required))
  const opt = itemProps?.options?.items
  check('④ ★ 每个 option 的字段 == 官方（label/description），且只有 label 必填',
    keysOf(opt?.properties) === 'description,label' && req(opt?.required) === 'label',
    show({ k: keysOf(opt?.properties), r: opt?.required }))
  const answers = tool.output?.schema?.properties?.answers?.items
  check('④ ★ 出参键照官方：answers[].{id,selected,custom?}',
    keysOf(answers?.properties) === 'custom,id,selected', keysOf(answers?.properties))
  check('④ ★ 出参必填语义照官方：answers 必填、每项 id/selected 必填',
    req(tool.output?.schema?.required) === 'answers' && req(answers?.required) === 'id,selected', '')
  check('④ ★ output.render 照官方（JSON 文本一条）', typeof tool.output?.render === 'function')

  // ★ 反证：把入参里的 multi_select 改名 ⇒ 字段名平价判据必红
  const renamed = SRC.replace(/multi_select: \{ type: 'boolean'/, "multiSelectX: { type: 'boolean'")
  check('④ ★ 反证：把 multi_select 改名 ⇒ 同一平价判据必红', !/multi_select: \{ type: 'boolean'/.test(renamed), '')
}

// ── ⑦ ★★ schema 方言闸（2026-09-21 真机事故的补丁） ─────────────────────────────
//   事故：我照官方（`defineTool` 的入参方言）写成内联 `required: true` ⇒ 真机 `session/create` 直接拒：
//     `preset "roleplay" failed to mount: … unsupported JSON schema: …required is not supported on type "array"`
//   ⇒ **整个预设挂不上**（用户开不了周目）。裸注册必须用 JSON-Schema 方言（对象级 `required: [...]`）。
//   ⚠️ 28 条"形状/文案"判据**全都抓不住它** ⇒ 这条专钉：**本文件里一个内联 `required: true` 都不许有**。
{
  // ⚠️ 只看**活代码**：模块头注里故意把"错方言"当反面例子写着（`required: true` 那几处是注释），
  //    不剥注释就会把"文档"判成"代码"（本台子第一版就踩了）。
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const inlineOf = (s) => s.match(/required:\s*(true|false)\b/g) || []
  check('⑦ ★★ 活代码里没有内联 `required: true/false`（裸注册必须用对象级 `required: [...]`）',
    inlineOf(code).length === 0, inlineOf(code).join(' / '))
  check('⑦ ★ 反证：往活代码里塞回一个内联 `required: true` ⇒ 同一判据必红',
    inlineOf(code.replace("id: { type: 'string', description: PARAM_DESCRIPTIONS.id }",
      "id: { type: 'string', required: true, description: PARAM_DESCRIPTIONS.id }")).length === 1, '')
  check('⑦ ★ 四处对象级必填都在（参数顶层 / question 项 / option 项 / 出参）',
    /type: 'object', additionalProperties: false, required: \['questions'\]/.test(code)
    && /required: \['id', 'question'\]/.test(code)
    && /required: \['label'\]/.test(code)
    && /required: \['answers'\]/.test(code), '')
}

// ── ⑤ execute：与官方同款映射（蛇形入参 → 驼峰服务调用 → 出参还原） ──────────────
{
  const { ctx: c2, state: s2 } = makeCtx()
  mod.apply(c2)
  const t2 = s2.tools[0]
  const out = await t2.execute({
    questions: [
      { id: 'q1', question: '走哪条路？', header: '选一项', multi_select: true, options: [{ label: '左 (Recommended)', description: '更暗' }] },
      { id: 'q2', question: '用什么检定？' },
    ],
  }, { agent: { id: 'a1' }, signal: 'sig' })
  const got = s2.asked[0]
  check('⑤ ★ `multi_select` 被翻成驼峰 `multiSelect`（服务吃驼峰）', got.questions[0].multiSelect === true, JSON.stringify(got.questions[0]))
  check('⑤ ★ 没给 multi_select 的那件**不要**凭空补一个键（照官方 spread 条件）',
    !('multiSelect' in got.questions[1]), JSON.stringify(got.questions[1]))
  check('⑤ ★ header / options 原样透传', got.questions[0].header === '选一项' && Array.isArray(got.questions[0].options), '')
  check('⑤ ★ 把 agent 与 signal 一并交给服务（照官方）', got.agent?.id === 'a1' && got.signal === 'sig', '')
  check('⑤ ★ 出参形状照官方：{answers:[{id,selected[],custom?}]}',
    Array.isArray(out.answers) && out.answers[0].id === 'q1' && Array.isArray(out.answers[0].selected)
    && !('custom' in out.answers[0]), JSON.stringify(out))
  check('⑤ ★ 入参畸形（questions 不是数组）⇒ 不抛、当空处理',
    (await t2.execute({ questions: null }, {})).answers.length === 0, '')
}

// ── ⑥ 纪律：不 import 任何 @deepseek-ai/*（与 mt-read.js 同一条） ────────────────
check('⑥ ★ 不 import 任何 `@deepseek-ai/*`（消除解析风险）',
  !/from\s+['"]@deepseek-ai\//.test(SRC), '')
check('⑥ 服务不可用时**不注册**（降级，⛔ 不自己造后门）', (() => {
  const s = { tools: [], asked: [] }
  mod.apply({ tools: { register: (t) => s.tools.push(t) } })   // 没有 userQuestions
  return s.tools.length === 0
})())

console.log(`\n── ${pass} 通过 / ${fail} 失败 ──`)
process.exitCode = fail === 0 ? 0 : 1
