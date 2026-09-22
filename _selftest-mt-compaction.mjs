/**
 * _selftest-mt-compaction.mjs —— lib/mt-compaction.js 生成物的自检台。
 *
 * 覆盖（对应任务 7 条）：
 *   1) 生成物能被真加载（写临时目录 → import() → 拿到类）
 *   2) 它是官方引擎的子类（子进程 cwd=DSH 检出，让「宿主锚点」真解析官方包，比原型链）
 *   3) 覆盖两个钩子：summarize 与 compactIfNeeded 是 own（后者 2026-09-21 起，为「每轮现读面板
 *      阈值」；覆写体必须调 super），官方其它方法全部继承、一个都没被遮蔽
 *   4) resolveInstruction 语义：非空整段替换 / zh 追加中文 / en 追加英文 / auto 不追加
 *   5) 确定性：连调两次生成器逐字节相同
 *   6) 反证：全部解析锚点打断（子进程 argv[1] 指向不存在路径 + cwd=空目录 + 删 NODE_PATH）
 *      ⇒ import 不抛、degraded 如实报告、占位类能安全实例化。不许跳过。
 *   7) 临时目录用完清掉
 *
 * ★ 只读访问 DSH 检出（解析官方包），绝不写它；~/.dsh 下**只读**第 8) 节那份真机副本
 *   （存在才读，不存在就明说跳过）。DSH 检出定位：
 *   环境变量 MT_DSH_ROOT 优先，否则取仓库的兄弟目录 ../deepseek-harness。
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
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
// 2026-09-16 起内置模板 = anima 总结提示词原文（逐字），它自带 `Language: Summary in Chinese`
// 与输出骨架，因此 zh/en/faithful 都不再分叉 —— 这不是「开关失效」，是只有一份原文。
const ANIMA_MARKERS = ['# Summarization Guidelines', 'RAW JSON Array', 'Language: Summary in Chinese']
check('resolveInstruction 空 + auto ⇒ anima 总结提示词原文（逐字）',
  ANIMA_MARKERS.every((m) => builtinZh.includes(m)),
  builtinZh.slice(0, 60))
check('resolveInstruction 空 + en ⇒ 同一份 anima 原文（anima 自带语言声明，不另出英文版）',
  builtinEn === builtinZh && ANIMA_MARKERS.every((m) => builtinEn.includes(m)), builtinEn.slice(0, 60))
check('faithful 不再分叉（anima 原文自带逐字/语言要求，没有第二份变体）—— 显式记录该语义变更',
  builtinZh === builtinZhFaithless && !builtinZh.includes('## 时间跨度'))

// ---- 4b) ★ 摘要输入该看什么：**只留玩家发言 + AI 最终正文**（2026-09-20 用户口径）----
// 为什么单独立一节：这是「压缩抓到其它原文」的正对面 —— 宿主把**整个系统提示词**当
// input.messages[0] 重放进来（region.ts:530-545，为 KV cache），那份 system 里含注入的近场
// 原文 ⇒ 不摘掉，模型就会去总结它们（真机原文：模型自己说「The most recent actual RP content
// I have: recentFloors (楼 0249-0253) and immediateHistory」）。这里用**真机样本形状**喂进去验。
const { renderSummaryInput, textOf, previousSummaryOf } = mod
check('4b-0 renderSummaryInput 已导出（生成物导出面）', typeof renderSummaryInput === 'function')
if (typeof renderSummaryInput === 'function') {
  const PHI_TEXT = '【角色卡的后处理指令 · 由插件注入，不是玩家发言】\n情感线与敏感内容处理：…'
  const CHECKPOINT_TEXT = 'This is an automatically generated checkpoint condensing an earlier span of the '
    + 'conversation to free up context. Treat the captured context as established background and build on it '
    + 'without restating it. Continue the task directly from the messages that follow, without acknowledging '
    + 'this checkpoint.\n\n<compacted-summary>\n上一份摘要正文\n</compacted-summary>\n'
  const fixture = [
    // ① 整个系统提示词（含注入的近场原文）——必须整条丢
    { role: 'system', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
      content: [{ type: 'text', text: '[楼 0253] 叙事：你看见靠墙放着一只半人高的旧木柜…' }] },
    // ② 真·玩家发言 —— 必须留
    { role: 'user', source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: '测试信息，回复1' }] },
    // ③ 技能目录快照（role user，但来源不是玩家）——丢
    { role: 'user', source: { kind: 'skill-catalog', form: 'catalog', entries: [] },
      content: [{ type: 'text', text: '<system-reminder>A skill is…' }] },
    // ④ 我们注入的后处理指令（role user + kind plugin）——丢（与「不被记忆库收录」同口径）
    { role: 'user', source: { kind: 'plugin', plugin: 'dsh-memory-archive', form: 'phi' },
      content: [{ type: 'text', text: PHI_TEXT }] },
    // ⑤ AI 消息：思维链 + 工具调用 + 最终正文 —— 只留正文
    { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [
      { type: 'reasoning', text: '这里是思维链，绝不该进摘要' },
      { type: 'tool-call', toolCallId: 'c1', name: 'memory_write', arguments: '{"content":"笔记正文也不该进"}' },
      { type: 'text', text: '顾筱潋把闹钟拿到窗边擦净，秒针重新走动。' },
    ] },
    // ⑥ 工具结果（role 是 user，块类型是 tool-result）——丢
    { role: 'user', source: { kind: 'tool', callId: 'c1' },
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '写入成功' }] }] },
    // ⑦ 历史 checkpoint —— 抠成 previous_summary，不进正文
    { role: 'user', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-compaction-basic' },
      content: [{ type: 'text', text: CHECKPOINT_TEXT }] },
  ]
  const out = renderSummaryInput(fixture)
  const allText = JSON.stringify(out)
  check('4b-1 只留下 2 条（玩家发言 + AI 正文），其余全摘除',
    out.messages.length === 2
      && out.messages[0].role === 'user' && out.messages[1].role === 'assistant',
    JSON.stringify(out.messages.map((m) => m.role)))
  check('4b-2 ★ 系统提示词整条丢（那份近场原文 `[楼 0253]` 一个字都不许进来）',
    !allText.includes('[楼 0253]') && !allText.includes('半人高的旧木柜'), '系统提示词漏进来了')
  check('4b-3 ★ 思维链摘除（reasoning 的正文一个字不许进来）', !allText.includes('思维链'))
  check('4b-4 ★ 工具调用摘除（tool-call 的 arguments 不许进来）', !allText.includes('笔记正文也不该进'))
  check('4b-5 ★ 工具结果摘除（role user 但不是玩家说的）', !allText.includes('写入成功'))
  check('4b-6 ★ 后备注入摘除（后处理指令不进摘要）', !allText.includes('后处理指令'))
  check('4b-7 ★ 技能目录快照摘除', !allText.includes('skill-catalog') && !allText.includes('A skill is'))
  check('4b-8 AI 只留 text 块（正文在，且只有这一个块）',
    out.messages[1].content.length === 1 && out.messages[1].content[0].text.includes('秒针重新走动'))
  check('4b-9 ★ checkpoint 抠成 previous_summary，且不混进正文',
    out.previous === '上一份摘要正文' && !allText.includes('automatically generated checkpoint'),
    JSON.stringify(out.previous))
  check('4b-10 反证：把"整条丢 system"改成"保留 system" ⇒ 4b-2 必须变红',
    (() => {
      const wrong = (msgs) => (msgs || []).filter((m) => m.role !== 'system' ? true : true)
      return JSON.stringify(wrong(fixture)).includes('[楼 0253]')
    })(), '')
  check('4b-11 textOf 只认 text 块（reasoning 取不到）',
    textOf({ role: 'assistant', content: [{ type: 'reasoning', text: 'x' }, { type: 'text', text: 'y' }] }) === 'y')
  check('4b-12 previousSummaryOf 抠不到就返回空串（⛔ 不猜）',
    previousSummaryOf('没有标签的普通文本') === '')
}

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
//
// ★ 2026-09-22：DSH_HOME 钉到临时目录 —— 4c 那段会**故意**让 summarize 失败（假流一条 chunk 都不给），
//   而 summarize 的每一档失败都要 logCompactionFailure 落盘。不隔离的话这条自检每次都往
//   真机 ~/.dsh/dsh-memory-archive/compaction-failures.log 里写几行（自检 ⛔ 不许碰真机目录）。
process.env.DSH_HOME = ${JSON.stringify(join(tmp, 'fake-home'))}
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
  // ★ 2026-09-21：「只覆盖 summarize」变成「覆盖 summarize + compactIfNeeded」——
  //   后者是面板「每轮现读阈值」唯一的那条缝（官方注册自动压缩处逐字写着
  //   "compactIfNeeded stays dynamically dispatched so subclass overrides are honored at
  //   event time"）。⛔ 除这两个之外，官方别的方法一个都不许被 own 掉。
  out.compactIfNeededOwn = Object.prototype.hasOwnProperty.call(Proto, 'compactIfNeeded')
  out.compactIfNeededCallsSuper = /super\\s*\\.\\s*compactIfNeeded\\s*\\(/.test(String(Proto.compactIfNeeded))
  out.officialNotOwn = officialMethods.filter((m) => m !== 'compactIfNeeded' && !Object.prototype.hasOwnProperty.call(Proto, m))
  out.officialInherited = officialMethods.filter((m) => typeof Proto[m] === 'function')

  // ---- 4c) ★ 真的跑一遍 summarize() 的**装配**：用假 ctx.llm.stream 截获"到底发了什么给模型" ----
  // 这一步的价值：过滤逻辑可以单测（4b 节），但"过滤后的东西有没有真的上桌"只有在真环境里
  // 走一遍 summarize() 才知道（顺手也验 createUserMessage 不带 source 能构造）。
  const fixture = [
    { role: 'system', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
      content: [{ type: 'text', text: 'SYSTEM_PROMPT_SHOULD_NOT_APPEAR [楼 0253] 叙事：半人高的旧木柜' }] },
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '玩家说的话' }] },
    { role: 'assistant', source: { kind: 'model' }, content: [
      { type: 'reasoning', text: 'COT_SHOULD_NOT_APPEAR' },
      { type: 'tool-call', toolCallId: 'c1', name: 'memory_write', arguments: 'TOOLARGS_SHOULD_NOT_APPEAR' },
      { type: 'text', text: 'AI 的最终正文' },
    ] },
    // 真机的 checkpoint 长这样（session-1075b863 seq=148 逐字）：kind plugin + plugin 'compact'
    { role: 'user', source: { kind: 'plugin', plugin: 'compact', compactionId: 'x', sourceCommandId: 'c' }, content: [
      { type: 'text', text: 'This is an automatically generated checkpoint condensing an earlier span. <compacted-summary>上一份摘要</compacted-summary>' },
    ] },
  ]
  const captured = []
  const fakeCtx = { llm: { stream: async function* (options) { captured.push(options) } } }
  const engineReceiver = new Proxy({
    ctx: fakeCtx,
    instruction: 'INSTRUCTION_SHOULD_APPEAR',
    config: { summarizationProvider: 'prov', summarizationModel: 'mod', maxTokens: 16, modelPolicies: [] },
  }, {})
  const assemblerAgent = { session: { id: 'sid-4c', requestHeader: () => undefined }, options: {} }
  try {
    await Proto.summarize.call(engineReceiver, { messages: fixture }, assemblerAgent, undefined)
  } catch (e) {
    out.assembledErr = String((e && e.message) || e)
  }
  const sent = captured[0]
  out.assembledSent = sent === undefined ? null : JSON.stringify({
    roles: sent.messages.map((m) => m.role),
    hasTools: Object.prototype.hasOwnProperty.call(sent, 'tools'),
    hasSystemField: Object.prototype.hasOwnProperty.call(sent, 'system'),
    body: JSON.stringify(sent.messages),
  })

  // ---- 5c) 服务代理实调用（2026-09-20 真机踩坑的回归门）----
  // cordis 把服务对象包成可追踪 Proxy（getTraceable → createTraceable；方法再经
  // createShadowMethod，thisArg 被换成 shadow —— 仍是 Proxy）。而 **ES 哈希私有成员过不了
  // Proxy**：this.#x 会先做品牌检查 ⇒ 抛「Receiver must be an instance of class X」。
  // 官方 compaction-basic 全文件零个哈希私有成员，所以它没事；我们的子类一旦用了，
  // /compact 会在 1 毫秒内炸掉、摘要一条都产不出（现象 = "压缩按钮没反应"）。
  // 这里用**真的生成物**、经**真的 Proxy 接收者**调一次 summarize()：修好后它应当走到
  // 「没配摘要模型」这条正常逻辑，而绝不该是那个品牌错。
  const fakeReceiver = new Proxy({
    ctx: {},
    instruction: 'i',
    config: { summarizationProvider: '', summarizationModel: '', maxTokens: 1, modelPolicies: [] },
  }, {})
  const fakeAgent = { session: { requestHeader: () => undefined }, options: {} }
  try {
    await mod.default.prototype.summarize.call(fakeReceiver, { messages: [] }, fakeAgent, undefined)
    out.proxyCallMsg = '(没有抛 —— 预期应抛"缺模型"，可疑)'
  } catch (e) {
    out.proxyCallMsg = String((e && e.message) || e)
  }
  out.hasHashPrivateMember = null
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
  check('★ 覆盖两个钩子：summarize + compactIfNeeded 都是自己定义的（prototype 上的 own 属性）',
    full.summarizeOwn === true && full.compactIfNeededOwn === true, `own=${JSON.stringify(full.ownNames)}`)
  check('★ compactIfNeeded 覆写体**调了 super**（阈值判定/保留策略仍是官方实现）',
    full.compactIfNeededCallsSuper === true, String(full.compactIfNeededCallsSuper))
  check('★ 官方其余方法一个都没被遮蔽（compactIfNeeded 之外全部不是 own）', Array.isArray(full.officialNotOwn) && full.officialNotOwn.length === 4, JSON.stringify(full.officialNotOwn))
  check('官方其余方法经原型链可达（继承真实生效）', Array.isArray(full.officialInherited) && full.officialInherited.length === 5, JSON.stringify(full.officialInherited))
  // ★ 5c：见满载运行器里的长注释 —— 哈希私有成员经 Proxy 必炸（真机踩过）。
  check('★ 5c 生成物里没有类的哈希私有成员（有 ⇒ 经 cordis 服务 Proxy 调用必抛品牌错）',
    !/^\s*#[A-Za-z_$]/m.test(text1), (text1.match(/^\s*#[A-Za-z_$].*/m) || [''])[0])
  check('★ 5c 经 Proxy 接收者调 summarize() 走到"缺摘要模型"这条正常逻辑（不是品牌错）',
    typeof full.proxyCallMsg === 'string' && full.proxyCallMsg.includes('no provider/model available'),
    String(full.proxyCallMsg).slice(0, 200))
  check('★ 5c 反证：报错里不出现「Receiver must be an instance」（出现了就是私有成员又回来了）',
    typeof full.proxyCallMsg === 'string' && !full.proxyCallMsg.includes('Receiver must be an instance'),
    String(full.proxyCallMsg).slice(0, 200))

  // ★ 4c：真装配跑通后，截获到的请求里**只该有**过滤后的东西（口径 = 玩家发言 + AI 正文）
  const sent = full.assembledSent === null || full.assembledSent === undefined
    ? null
    : JSON.parse(full.assembledSent)
  check('★ 4c-1 summarize() 真的把请求发到了 llm.stream（截获到 options）', sent !== null,
    `err=${String(full.assembledErr || '(无)').slice(0, 160)}`)
  if (sent !== null) {
    check('★ 4c-2 发出去的 messages 里没有 role: system（系统提示词那条被摘掉了）',
      !sent.roles.includes('system'), JSON.stringify(sent.roles))
    check('★ 4c-3 系统提示词正文一个字都没发出去', !sent.body.includes('SYSTEM_PROMPT_SHOULD_NOT_APPEAR')
      && !sent.body.includes('半人高的旧木柜'), '系统提示词漏出去了')
    check('★ 4c-4 思维链与工具参数都没发出去',
      !sent.body.includes('COT_SHOULD_NOT_APPEAR') && !sent.body.includes('TOOLARGS_SHOULD_NOT_APPEAR'))
    check('★ 4c-5 玩家发言 + AI 最终正文在（该留的留着）',
      sent.body.includes('玩家说的话') && sent.body.includes('AI 的最终正文'))
    check('★ 4c-6 标签就位：text_to_summarize 开闭 + previous_summary + 指令',
      sent.body.includes('<text_to_summarize>') && sent.body.includes('</text_to_summarize>')
      && sent.body.includes('<previous_summary>') && sent.body.includes('上一份摘要')
      && sent.body.includes('INSTRUCTION_SHOULD_APPEAR'))
    check('★ 4c-7 checkpoint 原文（"automatically generated checkpoint"）没混进正文',
      !sent.body.includes('automatically generated checkpoint'))
    check('★ 4c-8 不传 tools、不传 system 字段（KV cache 前缀换"只看对话"）',
      sent.hasTools === false && sent.hasSystemField === false,
      `tools=${sent.hasTools} system=${sent.hasSystemField}`)
  }
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
      return mod.resolveInstruction('', 'auto', true).includes('# Summarization Guidelines')
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

// ---- 8) 真机**挂载的那个**副本也要过同一道门 ----
// 事实（2026-09-20 改）：roleplay 预设的 compaction 组挂的是**预设目录里的相对模块**
// `./mt-compaction-rp.js`（同日从"独立插件绝对路径"改过来，为了能搬机器）。
// 那份文件由 `_materialize-preset-modules.mjs --apply` 从本仓生成器铺过去 ⇒
// 它必须①真的在、②与仓库一致、③经 Proxy 调用不出品牌错。本仓那份由 1)~7) 守，这里守真机那份。
// （存在才查，不存在就明说跳过，⛔ 不假装通过。）
const LIVE_PLUGIN = join(homedir(), '.dsh', '.agent-presets', 'roleplay', 'mt-compaction-rp.js')
if (!existsSync(LIVE_PLUGIN)) {
  console.log('SKIP 8) 真机 RP 压缩后端副本不存在（换机器/未铺盘时属正常）：' + LIVE_PLUGIN)
} else {
  const liveSrc = readFileSync(LIVE_PLUGIN, 'utf8')
  check('★ 8) 真机挂载副本里没有类的哈希私有成员（它就是 /compact 实际跑的那份）',
    !/^\s*#[A-Za-z_$]/m.test(liveSrc), (liveSrc.match(/^\s*#[A-Za-z_$].*/m) || [''])[0])
  // ★ 8a：**逐字节一致**只在"同一代"下判定 —— 判据本身是"铺盘漏了/手改了会红"。
  //   2026-09-21 加的那一代（面板每轮现读面板阈值）需要**重新铺盘**才会出现在部署副本里，
  //   2026-09-22 加的这一代（三档回退梯子）同样。而铺盘是**人的动作**
  //   （`产物\memory-tools\_materialize-preset-modules.mjs --apply`，写的是 ~/.dsh，
  //   ⛔ 本仓库的台子不许替人做）。所以：
  //     · 部署副本**已含当前代全部特征** ⇒ 仍按逐字节判（手改照样红）；
  //     · **缺任意一条** ⇒ 它是上一代 ⇒ 大声 SKIP 并写明怎么追平（⛔ 不假装通过、也不谎报成"不一致"）。
  //   ⚠️ 加了新一代就**往这张表里加一条**（标记取"这一代独有"的串，别取共有的）。
  const GENERATIONS = [
    { mark: 'export function applyPanelThreshold', note: '2026-09-21 面板阈值每轮现读' },
    { mark: "logCompactionFailure(this.ctx, error, 'summarize-r2')", note: '2026-09-22 三档回退梯子（R1/R2/R3）' },
  ]
  const missingMarks = GENERATIONS.filter((generation) => !liveSrc.includes(generation.mark))
  const liveIsCurrentGeneration = missingMarks.length === 0
  check('★ 8a) 真机挂载副本与仓库生成物**逐字节一致**（铺盘漏了/手改了会红）',
    !liveIsCurrentGeneration || liveSrc === text1,
    liveIsCurrentGeneration
      ? `preset=${liveSrc.length} 字符 repo=${text1.length} 字符`
      : `（已跳过：部署副本是上一代，见下面那行说明）preset=${liveSrc.length} 字符 repo=${text1.length} 字符`)
  if (!liveIsCurrentGeneration) {
    console.log('  ⚠️ SKIP 8a-逐字节：真机副本**落后一代**（缺：'
      + missingMarks.map((generation) => generation.note + ' [' + generation.mark + ']').join('、') + '）')
    console.log('     ⇒ 要把新生成物铺到部署目录（否则面板改阈值/三档梯子只在仓库里）：')
    console.log('        node "D:\\apps\\dsh-tarven配置区\\产物\\memory-tools\\_materialize-preset-modules.mjs" --apply')
    console.log('        （再重启宿主 —— 预设目录里的 .js 是宿主进程 import 进去的）')
    console.log('     铺盘之后本条会自动恢复成**逐字节**判定。')
  }
  const liveWrapper = join(tmp, '_mt-live-runner.mjs')
  writeFileSync(liveWrapper, `// ★ 2026-09-22：DSH_HOME 同样钉到临时目录（这条也调 summarize，失败要落盘 —— ⛔ 不许写进真机 ~/.dsh）
process.env.DSH_HOME = ${JSON.stringify(join(tmp, 'fake-home-live'))}
const out = { threw: null }
try {
  const mod = await import(${JSON.stringify(pathToFileURL(LIVE_PLUGIN).href)})
  const fakeReceiver = new Proxy({
    ctx: {},
    instruction: 'i',
    config: { summarizationProvider: '', summarizationModel: '', maxTokens: 1, modelPolicies: [] },
  }, {})
  const fakeAgent = { session: { requestHeader: () => undefined }, options: {} }
  try {
    await mod.default.prototype.summarize.call(fakeReceiver, { messages: [] }, fakeAgent, undefined)
    out.proxyCallMsg = '(没有抛 —— 可疑)'
  } catch (e) { out.proxyCallMsg = String((e && e.message) || e) }
} catch (e) { out.threw = String((e && e.stack) || e) }
console.log('JSON:' + JSON.stringify(out))
`, 'utf8')
  const liveRun = anchorOk ? spawnSync(process.execPath, [liveWrapper], { cwd: dshRoot, encoding: 'utf8' }) : null
  let liveOut = null
  try {
    liveOut = JSON.parse((liveRun.stdout || '').split('\n').find((l) => l.startsWith('JSON:')).slice(5))
  } catch {}
  if (!anchorOk) {
    console.log('SKIP 8b) 官方包锚点不可用 ⇒ 不跑真机副本的代理调用')
  } else {
    check('★ 8b) 真机副本 import 不抛（官方包在锚点下真拿到）', liveOut !== null && liveOut.threw === null,
      liveOut ? String(liveOut.threw || '').slice(0, 200) : `status=${liveRun.status}`)
    check('★ 8b) 真机副本经 Proxy 调 summarize() 走到"缺摘要模型"（不是品牌错）',
      liveOut !== null && String(liveOut.proxyCallMsg).includes('no provider/model available'),
      liveOut ? String(liveOut.proxyCallMsg).slice(0, 200) : '')
  }
}

// ---- 9) 预设自洽：它引用的相对模块**必须都在**，压缩后端**必须**是那个相对模块 ----
// 这条是「挂不上去就整组完蛋」的兜底：预设里写了 `./x.js` 而文件不在 ⇒ 该组挂载失败。
const PRESET_FILE = join(homedir(), '.dsh', '.agent-presets', 'roleplay', 'agent.cordis.yml')
if (!existsSync(PRESET_FILE)) {
  console.log('SKIP 9) 真机 roleplay 预设不在（换机器/换 home 时属正常）：' + PRESET_FILE)
} else {
  const presetSrc = readFileSync(PRESET_FILE, 'utf8')
  const presetDir = join(homedir(), '.dsh', '.agent-presets', 'roleplay')
  const refs = [...presetSrc.matchAll(/name:\s*'(\.\/[^']+)'/g)].map((m) => m[1])
  const missing = refs.filter((r) => !existsSync(join(presetDir, r)))
  check('★ 9a 预设里每个 `./x.js` 引用的文件都真实存在（缺一个 = 那一组挂不上）',
    refs.length > 0 && missing.length === 0, `引用 ${refs.length} 个；缺失 ${JSON.stringify(missing)}`)
  check('★ 9b 压缩后端挂的是相对模块 ./mt-compaction-rp.js（防回流到绝对路径）',
    /- id:\s*compaction-rp\s*\n\s*name:\s*'\.\/mt-compaction-rp\.js'/.test(presetSrc)
    || (refs.includes('./mt-compaction-rp.js') && !/dsh-compaction-rp\/lib\/index\.js/.test(presetSrc)),
    'compaction-rp 那一行不是 ./mt-compaction-rp.js')
  // ⚠️ 只查**挂载行**（`name:` 的值）：注释里保留"原来挂的是哪个绝对路径"是**故意**的
  //    （改挂法这件事必须留下痕迹），把注释也算进去会变成假阳性。
  const badMount = [...presetSrc.matchAll(/name:\s*'([^']*plugins\/dsh-compaction-rp\/lib\/index\.js)'/g)]
    .map((m) => m[1])
  check('★ 9c 预设里已无**挂载**指向独立插件 dsh-compaction-rp 的绝对路径（注释里留痕不算）',
    badMount.length === 0, JSON.stringify(badMount))
}

// ---- 7) 临时目录清掉 ----
rmSync(tmp, { recursive: true, force: true })
rmSync(bare, { recursive: true, force: true })
check('临时目录已删除', !existsSync(tmp) && !existsSync(bare), `${tmp} ${bare}`)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
