/**
 * _selftest-auto-collect.mjs —— 「压缩后自动收纳」（lib/index.js 的 registerAutoCollect）自检台。
 *
 * 验的是**什么时候该跑、跑几次、归属门、开关、失败播报**，不真写盘（执行器用注入的替身）。
 * 端到端的真压缩验收在 `产物\memory-tools\_verify-auto-collect-live.mjs`（真宿主 + 真压缩 + 假 Tavern）。
 *
 * 覆盖：
 *   1) 一轮里压多次 ⇒ 只在轮末收**一次**（批处理）；
 *   2) 没压缩的轮末 ⇒ 不收（不许每轮都扫）；
 *   3) 压缩 → 轮末 → 再轮末 ⇒ 只收一次（pending 用完即弃）；
 *   4) 开关关掉 ⇒ 压缩了也不收（且轮末也不收）；
 *   5) ★★ **归属门（2026-09-22 起 = 会话优先）**：四类会话的放行/拒绝矩阵 —— 真夹具
 *      （假 Tavern 工作区：catalog.json + 两个周目的 timeline.json）+ **真执行器**；
 *   6) ★ 判据本身 = 纯函数 `decideAutoCollect()`（lib/index.js 导出）**直测**：矩阵 + 边界 + 反证；
 *   7) 失败播报：过了门但写不成 ⇒ 状态文件 ok:false + code + message（面板顶栏读它）；
 *   8) 状态文件形状（面板 `GET /auto-collect` 读的就是它）：字段齐、会话 id 截短、不含正文；
 *   9) ★ **反证**：把判据**真·改回**旧写法（`ids.has(sessionId)`，改的是一份 lib 副本再 import）
 *      ⇒ 矩阵第 2 条（续接会话）**必红**（证明这条判据会咬人）。
 *
 * ⚠ 本台用**临时 DSH_HOME**（自建自删），⛔ 不碰真机 home。
 * ★ 5/9 的夹具 id 抄的是**真机事故现场的形状**（2026-09-22：用户在玩的是「从这里继续」续接出来的
 *   会话，而目标周目是同一个）—— 那条会话就是第 2 类，也就是本单要修的那一类。
 */
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

let failures = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond || detail === '' ? '' : ' —— ' + detail}`)
  if (!cond) failures++
}

const repo = 'D:/apps/deepseek/dsh-memory-archive'
for (const f of ['lib/index.js', 'lib/collect-scan.js']) {
  const r = spawnSync(process.execPath, ['--check', join(repo, f)], { encoding: 'utf8' })
  check(`node --check ${f}`, r.status === 0, String(r.stderr || '').slice(0, 200))
}

// ---- 临时 home：配置与状态文件都落在这里 ----
const home = mkdtempSync(join(tmpdir(), 'dma-autocollect-'))
process.env.DSH_HOME = home
const storageDir = join(home, 'dsh-memory-archive')
mkdirSync(storageDir, { recursive: true })
const cfgPath = join(storageDir, 'config.json')
const writeCfg = (obj) => writeFileSync(cfgPath, JSON.stringify(obj) + '\n', 'utf8')

// ---- 假 Tavern 工作区（5/7/9 用）：真机事故现场的 id 形状 ----
const WS = join(home, 'ws')                                   // 工作区根（play-workspace.json 指过来）
const CHAR_A = '70a0502d-b4e9-472f-8d5a-1c7b32b2e7ac'         // 用户在玩的那位角色
const PT_A = 'playthrough-f2d3547f-75ca-4328-af74-fb3e39bb8527' // 目标周目（面板绑定的那个）
const S_ROOT_A = 'session-8f20049b-1b1e-4a2c-9d3f-0f1a2b3c4d5e' // 该周目的**第一场**（catalog 的 rootSessionId）
const S_CONT_A = 'session-4c737d46-57bc-42fe-8df5-248cb9a62e1f'  // ★ 用户实际在玩的：续接出来的（timeline 的 head）
const S_NOBODY = 'session-9f9f9f9f-1111-2222-3333-444444444444'  // 认不出周目（新会话 / 编程会话）
const CHAR_B = 'char-bbbb-0000-1111-2222-333333333333'
const PT_B = 'playthrough-bbbb-9999-8888-7777-666666666666'
const S_CONT_B = 'session-bbbbbbbb-1111-2222-3333-444444444444'  // 属于**另一个**周目
/** 建夹具：catalog（两条周目）+ 各周目 timeline（root/续接都在里面）。 */
function writeWorkspace(rootPath) {
  mkdirSync(join(rootPath, CHAR_A, PT_A), { recursive: true })
  mkdirSync(join(rootPath, CHAR_B, PT_B), { recursive: true })
  writeFileSync(join(rootPath, 'catalog.json'), JSON.stringify({
    schemaVersion: 1,
    playthroughs: [
      { id: PT_A, path: `${CHAR_A}/${PT_A}/timeline.json`, ext: { pmpDshTavern: { characterId: CHAR_A, rootSessionId: S_ROOT_A } } },
      { id: PT_B, path: `${CHAR_B}/${PT_B}/timeline.json`, ext: { pmpDshTavern: { characterId: CHAR_B, rootSessionId: 'session-root-b' } } },
    ],
  }) + '\n', 'utf8')
  // ★ 关键形状：root 只在 nodes[].variants[] 里，**head 是续接出来的那条**（真机就是这样）。
  writeFileSync(join(rootPath, CHAR_A, PT_A, 'timeline.json'),
    JSON.stringify({ nodes: [{ variants: [{ sessionId: S_ROOT_A }, { sessionId: 'session-old-a' }] }], head: { sessionId: S_CONT_A } }) + '\n', 'utf8')
  writeFileSync(join(rootPath, CHAR_B, PT_B, 'timeline.json'),
    JSON.stringify({ nodes: [], head: { sessionId: S_CONT_B } }) + '\n', 'utf8')
}
function writePlayWorkspace(rootPath) {
  mkdirSync(join(home, 'pmp-dsh-tavern'), { recursive: true })
  writeFileSync(join(home, 'pmp-dsh-tavern', 'play-workspace.json'),
    JSON.stringify({ schemaVersion: 1, rootPath }) + '\n', 'utf8')
}
writeWorkspace(WS)
writePlayWorkspace(WS)
// 目标 = 面板绑定的那个「角色-周目」；`sessionId: null`（真机就是这么一份：rootMode='workspace'）
writeCfg({ autoCollect: { enabled: true }, root: { sessionId: null, characterId: CHAR_A, playthroughId: PT_A } })

const mod = await import('file:///' + repo + '/lib/index.js')
const { registerAutoCollect, decideAutoCollect } = mod
check('registerAutoCollect 已导出（自检注入面）', typeof registerAutoCollect === 'function')
check('★ decideAutoCollect 已导出（判据纯函数，台子直测）', typeof decideAutoCollect === 'function')

/** 假 cordis：抓下子 fiber 的 scope，并返回两个 session/event 监听器。 */
function harness({ enabled = true, run, delay } = {}) {
  const calls = []
  const listeners = []
  const scope = {
    on(ev, fn) { if (ev === 'session/event') listeners.push(fn); return () => {} },
  }
  const ctx = { plugin: (p) => { p.apply(scope); return p }, get: () => null }
  registerAutoCollect(ctx, { warn() {}, info() {}, error() {} }, {
    runAutoCollect: (sc, sid) => {
      calls.push(sid)
      if (run) return run(sc, sid)
      return Promise.resolve()
    },
    // ③ 的延迟：生产 5 秒，自检台注入小值（真等 5 秒会拖慢全量门）。
    ...delay === undefined ? {} : { compactEndDelayMs: delay },
  })
  const fire = (type, sid, data) => { for (const fn of listeners) fn({ id: sid }, { type, data: data ?? {} }) }
  return { calls, fire, listeners, enabled }
}

const statusOf = () => {
  try { return JSON.parse(readFileSync(join(storageDir, 'auto-collect.json'), 'utf8')) } catch { return null }
}
/** 轮询等状态文件落地（触发是 `void Promise.resolve(...)`，不 await ⇒ 只能等）。 */
const waitFor = async (fn, ms = 3000) => {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) return null
    await new Promise((r) => setTimeout(r, 20))
  }
}

// 1) 一轮里压多次 ⇒ 轮末只收一次
{
  const h = harness()
  h.fire('compaction/summary', 'sid-1')
  h.fire('compaction/summary', 'sid-1')
  h.fire('compaction/summary', 'sid-1')
  check('1a 压缩阶段不立刻收（pending 而已）', h.calls.length === 0, JSON.stringify(h.calls))
  h.fire('turn/end', 'sid-1')
  check('1b ★ 轮末收**一次**（三次压缩不重复收）', h.calls.length === 1 && h.calls[0] === 'sid-1', JSON.stringify(h.calls))
  h.fire('turn/end', 'sid-1')
  check('1c 再一个轮末 ⇒ 不再收（pending 用完即弃）', h.calls.length === 1, JSON.stringify(h.calls))
}

// 2) 没压缩的轮末 ⇒ 不收
{
  const h = harness()
  h.fire('turn/end', 'sid-2')
  h.fire('turn/end', 'sid-2')
  check('2a 没压缩过的轮末一次都不收', h.calls.length === 0, JSON.stringify(h.calls))
}

// 3) 两个会话各自成批
{
  const h = harness()
  h.fire('compaction/summary', 'sid-A')
  h.fire('compaction/summary', 'sid-B')
  h.fire('turn/end', 'sid-A')
  check('3a A 的轮末只收 A', h.calls.length === 1 && h.calls[0] === 'sid-A', JSON.stringify(h.calls))
  h.fire('turn/end', 'sid-B')
  check('3b B 的轮末只收 B', h.calls.length === 2 && h.calls[1] === 'sid-B', JSON.stringify(h.calls))
}

// 4) 开关关掉 ⇒ 压缩了也不收
{
  writeCfg({ autoCollect: { enabled: false }, root: { sessionId: null, characterId: CHAR_A, playthroughId: PT_A } })
  const h = harness()
  h.fire('compaction/summary', 'sid-off')
  h.fire('turn/end', 'sid-off')
  check('4a 开关关掉 ⇒ 一次都不收', h.calls.length === 0, JSON.stringify(h.calls))
  // 再打开 ⇒ 恢复
  writeCfg({ autoCollect: { enabled: true }, root: { sessionId: null, characterId: CHAR_A, playthroughId: PT_A } })
  const h2 = harness()
  h2.fire('compaction/summary', 'sid-on')
  h2.fire('turn/end', 'sid-on')
  check('4b 打开后恢复', h2.calls.length === 1, JSON.stringify(h2.calls))
}

// 4c/4d…) ★ 压缩成功后延迟收一次（2026-09-20 新增：手动 /compact 不产生 turn/end）
//   真机实测那一串是「compaction/summary → user/message → compaction/end → command/done」，
//   一条 turn/end 都没有 ⇒ 只靠轮末的话，手动压完就关会话 = 这份摘要永远不进库。
{
  writeCfg({ autoCollect: { enabled: true }, root: { sessionId: null, characterId: CHAR_A, playthroughId: PT_A } })
  const h = harness({ delay: 30 })
  h.fire('compaction/summary', 'sid-ce')
  h.fire('compaction/end', 'sid-ce', {})
  check('4c 压缩成功那一刻不立刻收（是延迟，不是同步）', h.calls.length === 0, JSON.stringify(h.calls))
  await new Promise((r) => setTimeout(r, 150))
  check('4d ★ 延迟到点 ⇒ 收了一次（手动压缩也能落库）',
    h.calls.length === 1 && h.calls[0] === 'sid-ce', JSON.stringify(h.calls))
  h.fire('turn/end', 'sid-ce')
  check('4e 之后真有轮末也不重复收（pending 已用掉）', h.calls.length === 1, JSON.stringify(h.calls))

  // 4f 反证：压缩**失败**（end 带 error）⇒ 延迟到了也不许收
  const h2 = harness({ delay: 30 })
  h2.fire('compaction/summary', 'sid-fail')
  h2.fire('compaction/end', 'sid-fail', { error: 'Receiver must be an instance of class RpCompactionEngine' })
  await new Promise((r) => setTimeout(r, 150))
  check('4f ★ 反证：压缩失败（end 带 error）⇒ 不收', h2.calls.length === 0, JSON.stringify(h2.calls))

  // 4g 轮末先到 ⇒ 延迟那一脚不再补收（同一次压缩只落一次库）
  const h3 = harness({ delay: 80 })
  h3.fire('compaction/summary', 'sid-both')
  h3.fire('compaction/end', 'sid-both', {})
  h3.fire('turn/end', 'sid-both')
  await new Promise((r) => setTimeout(r, 200))
  check('4g ★ 轮末先收 ⇒ 延迟器不再补收（一次压缩只落一次）', h3.calls.length === 1, JSON.stringify(h3.calls))

  // 4h 没压缩过的会话：光有 compaction/end 不许收（判据仍然是 compaction/summary 那一笔）
  const h4 = harness({ delay: 30 })
  h4.fire('compaction/end', 'sid-none', {})
  await new Promise((r) => setTimeout(r, 150))
  check('4h 反证：没压过（没有 summary）⇒ 光 end 不收', h4.calls.length === 0, JSON.stringify(h4.calls))
}

// ─────────────────────────────────────────────────────────────────────────────
// 5) 归属门（2026-09-22 起 = **会话优先**）：四类会话的放行/拒绝矩阵
//
//    ★ 为什么这条是本单的核心：旧判据是"会话 id 在不在 `autoCollectScope().ids` 里"，而那个集合
//      只装**周目第一场会话** ⇒ 用户一路「从这里继续」续接出来的会话（timeline 的 head）每次都被
//      `not-bound-session` 跳过 ⇒ 摘要压出来了、周目里却没归档。判据改成"这条会话**自己解析出来的
//      周目** == 目标周目" ⇒ 续接会话进得来，而认不出周目的 / 属于别的周目的**照旧被拒**。
//
//    判"放行"的观测口：过了门 ⇒ 会往下走到取基址那一步（自检台没有 webServer ⇒ 状态是
//    `ok:false, code:'NO_SELF_BASE'`，**没有** `skipped`）；被拒 ⇒ `skipped:true` + `reason`。
//    两个跑的都是**真执行器**（不注入替身），读的也是**真夹具文件**。
// ─────────────────────────────────────────────────────────────────────────────
delete process.env.MT_TAVERN_BASE   // 钉死"拿不到基址"，让放行/拒绝的观测口是确定的
const startReal = (sid, api = { registerAutoCollect }) => {
  rmSync(join(storageDir, 'auto-collect.json'), { force: true })
  const listeners = []
  const ctx = {
    plugin: (p) => { p.apply({ on: (ev, fn) => { if (ev === 'session/event') listeners.push(fn); return () => {} } }); return p },
    get: () => null,
  }
  api.registerAutoCollect(ctx, { warn() {}, info() {}, error() {} })
  for (const fn of listeners) {
    fn({ id: sid }, { type: 'compaction/summary', data: {} })
    fn({ id: sid }, { type: 'turn/end', data: {} })
  }
  return waitFor(statusOf)
}
const allowed = (st) => st !== null && st.skipped !== true
const matrix = {}
{
  const rows = [
    ['①catalog 的 rootSessionId（原行为）', S_ROOT_A, true],
    ['②★ 续接会话（timeline 的 head，本单要修的）', S_CONT_A, true],
    ['③认不出周目（新会话 / 编程会话）', S_NOBODY, false],
    ['④属于另一个周目', S_CONT_B, false],
  ]
  for (const [name, sid, wantAllow] of rows) {
    const st = await startReal(sid)
    matrix[sid] = st
    // 证据逐条落屏（报告要抄的"每条测试输出"就是这一行）
    console.log(`    · ${name} [${sid}] ⇒ ${allowed(st) ? '放行（往下走到取基址：' + String(st?.code) + '）' : '拒绝（' + String(st?.reason) + '）'}`)
    check(`5 ★ ${name} ⇒ ${wantAllow ? '放行' : '被拒'}`,
      allowed(st) === wantAllow,
      JSON.stringify({ skipped: st?.skipped, reason: st?.reason, code: st?.code }))
  }
  // 三条拒绝原因**文字分开**（给用户看的话必须能区分）
  check('5a ★ ①/② 放行后走的是取基址那一步（不是 skipped）',
    allowed(matrix[S_ROOT_A]) && allowed(matrix[S_CONT_A]) && matrix[S_CONT_A].code === 'NO_SELF_BASE',
    JSON.stringify({ root: matrix[S_ROOT_A]?.code, cont: matrix[S_CONT_A]?.code }))
  check('5b ★ ③ 认不出 ⇒ 新文案 session-playthrough-unknown（⛔ 不再是只说 catalog 的 bound-session-unknown）',
    String(matrix[S_NOBODY]?.reason).includes('session-playthrough-unknown')
    && !String(matrix[S_NOBODY]?.reason).includes('bound-session-unknown'), String(matrix[S_NOBODY]?.reason))
  check('5c ★ ④ 属于另一个周目 ⇒ 新文案 other-playthrough，且**两边周目 id 都带上**',
    String(matrix[S_CONT_B]?.reason).includes('other-playthrough')
    && String(matrix[S_CONT_B]?.reason).includes(CHAR_B) && String(matrix[S_CONT_B]?.reason).includes(PT_B)
    && String(matrix[S_CONT_B]?.reason).includes(CHAR_A) && String(matrix[S_CONT_B]?.reason).includes(PT_A),
    String(matrix[S_CONT_B]?.reason))
  check('5d ★ 三条拒绝文案**互不相同**（用户要能区分"没设目标" / "认不出" / "是另一个周目"）',
    new Set([decideAutoCollect(null, null).reason, decideAutoCollect({ characterId: CHAR_A, playthroughId: PT_A }, null).reason,
      decideAutoCollect({ characterId: CHAR_A, playthroughId: PT_A }, { characterId: CHAR_B, playthroughId: PT_B }).reason]).size === 3, '')
  check('5e 跳过时**一个字都没写进周目目录**（不是失败，也不碰档案）',
    !existsSync(join(WS, CHAR_A, PT_A, 'archive')) && !existsSync(join(WS, CHAR_B, PT_B, 'archive')), '')
  check('5f ★ 被拒的那两条 **不算失败**（ok:true ⇒ 面板不该为它们报红）',
    matrix[S_NOBODY]?.ok === true && matrix[S_CONT_B]?.ok === true,
    JSON.stringify({ nobody: matrix[S_NOBODY]?.ok, other: matrix[S_CONT_B]?.ok }))

  // 5g 没绑工作区根（读不到 catalog）⇒ 也归"认不出"那一类（同一句话，⛔ 不编造）
  writePlayWorkspace(join(home, 'no-such-ws'))
  const noCat = await startReal(S_CONT_A)
  check('5g ★ 读不到 catalog ⇒ 同样算"认不出周目"（同一句话；⛔ 不因为读不到就放行）',
    noCat?.skipped === true && String(noCat.reason).includes('session-playthrough-unknown'), String(noCat?.reason))
  writePlayWorkspace(WS)
  const back = await startReal(S_CONT_A)
  check('5h 工作区根放回来 ⇒ 续接会话又放行（夹具没被这一步弄坏）', allowed(back), JSON.stringify(back))
}

// ─────────────────────────────────────────────────────────────────────────────
// 6) 判据纯函数直测（`decideAutoCollect`）：矩阵 + 边界 + 反证
//    ★ 抽成纯函数就是为了这一步：直测判据本身，而不是去断言源码字符串。
// ─────────────────────────────────────────────────────────────────────────────
{
  const T = { characterId: CHAR_A, playthroughId: PT_A }
  const D = (t, h) => decideAutoCollect(t, h)
  check('6a 相：hit == target ⇒ 放行', D(T, { characterId: CHAR_A, playthroughId: PT_A }).allow === true, '')
  check('6b 相：放行时不带 reason（调用方只读被拒那条的 reason）',
    D(T, { characterId: CHAR_A, playthroughId: PT_A }).reason === undefined, '')
  check('6c ★ 反证：hit 是 null ⇒ 拒（认不出周目）',
    D(T, null).allow === false && D(T, null).reason.includes('session-playthrough-unknown'), D(T, null).reason)
  check('6d ★ 反证：hit 只有 characterId 没有 playthroughId（半截）⇒ 也拒（⛔ 不半信半疑地放行）',
    D(T, { characterId: CHAR_A }).allow === false && D(T, { characterId: CHAR_A, playthroughId: '' }).allow === false, '')
  check('6e ★ 反证：周目同、角色不同 ⇒ 拒（两半都要对得上）',
    D(T, { characterId: CHAR_B, playthroughId: PT_A }).reason.includes('other-playthrough'),
    D(T, { characterId: CHAR_B, playthroughId: PT_A }).reason)
  check('6f ★ 反证：target 空 / null / 半截 ⇒ no-bound-target（原样保留旧文案）',
    D(null, { characterId: CHAR_A, playthroughId: PT_A }).reason.includes('no-bound-target')
    && D({}, { characterId: CHAR_A, playthroughId: PT_A }).reason.includes('no-bound-target')
    && D({ characterId: CHAR_A }, { characterId: CHAR_A, playthroughId: PT_A }).reason.includes('no-bound-target'), '')
  check('6g ★ 优先级：target 与 hit **都**空 ⇒ 报 no-bound-target（用户先要看到的是"去设置里选"）',
    D(null, null).reason.includes('no-bound-target'), D(null, null).reason)
  check('6h ★ 反证：**旧判据**（只认 `ids.has(sessionId)`）在这四类上判错第 2 类 —— 它把续接会话拒了',
    (() => {
      const legacyIds = new Set([S_ROOT_A])   // 旧 autoCollectScope().ids：config.root.sessionId(null) ∪ catalog 的 rootSessionId
      const legacy = (sid) => legacyIds.has(sid)
      return legacy(S_ROOT_A) === true && legacy(S_CONT_A) === false
        && allowed(matrix[S_ROOT_A]) === true && allowed(matrix[S_CONT_A]) === true
    })(), '续接会话：旧判据 false / 新判据放行')
}

// 7) 失败播报：过了门、但拿不到宿主基址 ⇒ 必然 NO_SELF_BASE（ok:false + code + message）
{
  // ★ 口径变更的说明（2026-09-22）：旧台子这里靠"把 sessionId 写进 config.root.sessionId"过门，
  //   而门改成会话优先之后，过门靠的是**这条会话自己解析得出目标周目** ⇒ 用夹具里的续接会话。
  rmSync(join(storageDir, 'auto-collect.json'), { force: true })
  const st = await startReal(S_CONT_A)
  check('7a ★ 失败被如实记下（ok:false）——失败不许静默', st !== null && st.ok === false, JSON.stringify(st))
  check('7b ★ 带可读 code（面板顶栏红标显示它）', typeof st?.code === 'string' && st.code !== '', String(st?.code))
  // 自检台没有 webServer、MT_TAVERN_BASE 已删 ⇒ 这一步是**确定**的 NO_SELF_BASE
  // （旧台子这里只能写成"属于说得通的那几个"，因为过门的会话拿不到时会先撞别的错）。
  check('7c ★ 过门后卡在取基址 ⇒ code = NO_SELF_BASE（确定，不再是"几个之一"）', st?.code === 'NO_SELF_BASE', String(st?.code))
  check('7d 状态里有时间与目标（播报要能说清什么时候、对哪个周目）',
    typeof st?.at === 'string' && st?.target?.characterId === CHAR_A && st?.target?.playthroughId === PT_A,
    JSON.stringify({ at: st?.at, target: st?.target }))
}

// 8) 状态文件形状（面板 `GET /auto-collect` 读的就是它）
{
  const st = matrix[S_NOBODY]
  check('8a 跳过那条：字段齐（at/ok/skipped/sessionId/target/reason）',
    typeof st?.at === 'string' && st?.ok === true && st?.skipped === true
    && typeof st?.sessionId === 'string' && st?.target !== null && typeof st?.reason === 'string',
    JSON.stringify(st))
  check('8b ★ 会话 id **截短**落盘（状态文件不该是又一份会话清单）',
    st?.sessionId === S_NOBODY.slice(0, 18) + '…', String(st?.sessionId))
  check('8c ★ 状态里不含**工作区路径**、也不含正文（判词是一行，不是内容转储）',
    // ⚠️ 判词里**允许**出现 `catalog.json` / `timeline.json` 这类**文件名**（它是在告诉用户去哪儿找过），
    //    禁的是**真实路径**与正文 ⇒ 只钉这两条，别把"说了哪个文件"也一起禁掉。
    !JSON.stringify(st).includes(WS) && st?.message === undefined && String(st?.reason).length < 200, JSON.stringify(st))
}

// ─────────────────────────────────────────────────────────────────────────────
// 9) ★ 反证（真·回改）：把判据改回**旧写法**（`ids.has(sessionId)`）⇒ 矩阵第 2 条必红
//
//   做法：把 `lib/` 整份拷到临时目录，只把那两处改回旧写法，再 import 那份副本、喂**同一套夹具**
//   跑同一个矩阵 ⇒ ①③④ 不变、**②必红**。⛔ 不改本仓的 lib（改的是副本），跑完删掉。
// ─────────────────────────────────────────────────────────────────────────────
{
  const tmp = mkdtempSync(join(tmpdir(), 'dma-revert-'))
  cpSync(join(repo, 'lib'), join(tmp, 'lib'), { recursive: true })
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ type: 'module' }) + '\n', 'utf8')
  const p = join(tmp, 'lib', 'index.js')
  let src = readFileSync(p, 'utf8')
  const before = src
  src = src.replace('const { target } = autoCollectScope()', 'const { ids, target } = autoCollectScope()')
    .replace('const gate = decideAutoCollect(target, sessionPlaythroughOf(sessionId))',
      "const gate = { allow: ids.has(sessionId), reason: 'not-bound-session（这个会话不属于绑定的周目）' }")
  check('9a 反证夹具就位：副本里那两处确实改回旧写法（原文件一字未动）',
    src !== before && !src.includes('decideAutoCollect(target, sessionPlaythroughOf(sessionId))')
    && readFileSync(join(repo, 'lib', 'index.js'), 'utf8').includes('decideAutoCollect(target, sessionPlaythroughOf(sessionId))'), '')
  writeFileSync(p, src, 'utf8')
  const old = await import(pathToFileURL(p).href)
  const oldMatrix = {}
  for (const sid of [S_ROOT_A, S_CONT_A, S_NOBODY, S_CONT_B]) oldMatrix[sid] = await startReal(sid, old)
  for (const sid of [S_ROOT_A, S_CONT_A, S_NOBODY, S_CONT_B]) {
    console.log(`    · 旧判据 [${sid}] ⇒ ${allowed(oldMatrix[sid]) ? '放行（' + String(oldMatrix[sid]?.code) + '）' : '拒绝（' + String(oldMatrix[sid]?.reason) + '）'}`)
  }
  check('9b ★ 反证①：旧写法下 **catalog 的 rootSessionId 仍放行**（回归项没被冤枉）',
    allowed(oldMatrix[S_ROOT_A]), JSON.stringify({ skipped: oldMatrix[S_ROOT_A]?.skipped, code: oldMatrix[S_ROOT_A]?.code }))
  check('9c ★★ 反证②：旧写法下 **续接会话被拒** ⇒ 这就是真机事故（第 5 节能放行它，靠的正是本单改的那一处判据）',
    allowed(oldMatrix[S_CONT_A]) === false && oldMatrix[S_CONT_A]?.skipped === true,
    JSON.stringify({ skipped: oldMatrix[S_CONT_A]?.skipped, reason: oldMatrix[S_CONT_A]?.reason }))
  check('9d ★ 反证③：旧写法下 ③④ 也被拒（护栏两条判据都拦得住 ⇒ 改判据没有放松护栏）',
    allowed(oldMatrix[S_NOBODY]) === false && allowed(oldMatrix[S_CONT_B]) === false, '')
  rmSync(tmp, { recursive: true, force: true })
  check('9e 副本已删（⛔ 不给仓库留垃圾）', !existsSync(tmp), '')
}

rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS (_selftest-auto-collect)' : `\nFAIL ${failures}`)
process.exit(failures === 0 ? 0 : 3)
