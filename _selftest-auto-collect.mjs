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
 *   5) 归属门：绑定周目 ≠ 本会话 ⇒ 不收，且状态文件记成「跳过」而**不是失败**；
 *   6) 不同会话各自成批（A 的 pending 不会顺手把 B 也收了）；
 *   7) 失败播报：执行器抛错 ⇒ 状态文件 ok:false + code + message（面板顶栏读它）；
 *   8) GET 侧读得到（readAutoCollectStatus 的落盘/回读形状）。
 *
 * ⚠ 本台用**临时 DSH_HOME**（自建自删），⛔ 不碰真机 home。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
writeCfg({ autoCollect: { enabled: true }, root: { sessionId: null, characterId: 'charA', playthroughId: 'ptA' } })

const mod = await import('file:///' + repo + '/lib/index.js')
const { registerAutoCollect } = mod
check('registerAutoCollect 已导出（自检注入面）', typeof registerAutoCollect === 'function')

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
  writeCfg({ autoCollect: { enabled: false }, root: { sessionId: null, characterId: 'charA', playthroughId: 'ptA' } })
  const h = harness()
  h.fire('compaction/summary', 'sid-off')
  h.fire('turn/end', 'sid-off')
  check('4a 开关关掉 ⇒ 一次都不收', h.calls.length === 0, JSON.stringify(h.calls))
  // 再打开 ⇒ 恢复
  writeCfg({ autoCollect: { enabled: true }, root: { sessionId: null, characterId: 'charA', playthroughId: 'ptA' } })
  const h2 = harness()
  h2.fire('compaction/summary', 'sid-on')
  h2.fire('turn/end', 'sid-on')
  check('4b 打开后恢复', h2.calls.length === 1, JSON.stringify(h2.calls))
}

// 4c/4d…) ★ 压缩成功后延迟收一次（2026-09-20 新增：手动 /compact 不产生 turn/end）
//   真机实测那一串是「compaction/summary → user/message → compaction/end → command/done」，
//   一条 turn/end 都没有 ⇒ 只靠轮末的话，手动压完就关会话 = 这份摘要永远不进库。
{
  writeCfg({ autoCollect: { enabled: true }, root: { sessionId: null, characterId: 'charA', playthroughId: 'ptA' } })
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

// 5/6/7) 真执行器（不注入替身）跑一遍：验归属门 + 跳过/失败怎么落状态文件
{
  writeCfg({ autoCollect: { enabled: true }, root: { sessionId: null, characterId: 'charA', playthroughId: 'ptA' } })
  const listeners = []
  const ctxNoRun = { plugin: (p) => { p.apply({ on: (ev, fn) => { if (ev === 'session/event') listeners.push(fn); return () => {} } }); return p }, get: () => null }
  registerAutoCollect(ctxNoRun, { warn() {}, info() {}, error() {} })
  const fireReal = (type, sid) => { for (const fn of listeners) fn({ id: sid }, { type, data: {} }) }

  // 5) 归属门：charA/ptA 是绑定的，但磁盘上没有 catalog.json、config 也没 sessionId
  //    ⇒ 允许集合为空 ⇒ 记「跳过」（不是失败）
  rmSync(join(storageDir, 'auto-collect.json'), { force: true })
  fireReal('compaction/summary', 'session-不属于绑定周目')
  fireReal('turn/end', 'session-不属于绑定周目')
  await new Promise((r) => setTimeout(r, 300))
  const skipped = statusOf()
  check('5a 归属门拦下：状态记成跳过', skipped !== null && skipped.skipped === true, JSON.stringify(skipped))
  check('5b ★ 跳过**不算失败**（面板不该为这个报红）', skipped?.ok === true, JSON.stringify(skipped?.ok))
  check('5c 跳过原因可读且**说到点子上**（认不出绑定会话 ≠ 这会话不属于该周目）',
    typeof skipped?.reason === 'string' && skipped.reason.includes('bound-session-unknown'), String(skipped?.reason))
  check('5d 跳过时一个字都没写盘（没有 floors 目录）', !spawnSync(process.execPath, ['-e', 'process.exit(require("fs").existsSync(process.argv[1])?1:0)', join(home, 'ws')], { encoding: 'utf8' }).status)
}

// 7) 失败播报：把 sessionId 绑进 config.root（过归属门），但 Tavern 基址不可用 ⇒ 执行器必然失败
{
  writeCfg({ autoCollect: { enabled: true }, root: { sessionId: 'session-bound-1', characterId: 'charA', playthroughId: 'ptA' } })
  rmSync(join(storageDir, 'auto-collect.json'), { force: true })
  delete process.env.MT_TAVERN_BASE
  const listeners = []
  const ctxNoRun = { plugin: (p) => { p.apply({ on: (ev, fn) => { if (ev === 'session/event') listeners.push(fn); return () => {} } }); return p }, get: () => null }
  registerAutoCollect(ctxNoRun, { warn() {}, info() {}, error() {} })
  const fireReal = (type, sid) => { for (const fn of listeners) fn({ id: sid }, { type, data: {} }) }
  fireReal('compaction/summary', 'session-bound-1')
  fireReal('turn/end', 'session-bound-1')
  await new Promise((r) => setTimeout(r, 800))
  const failed = statusOf()
  check('7a ★ 失败被如实记下（ok:false）——失败不许静默', failed !== null && failed.ok === false, JSON.stringify(failed))
  check('7b ★ 带可读 code（面板顶栏红标显示它）', typeof failed?.code === 'string' && failed.code !== '', String(failed?.code))
  // 无 sessionQuery ⇒ collectOnce 抛 SESSION_QUERY_UNAVAILABLE（宿主没挂这个服务时的真实表现）
  // 或无法取基址 ⇒ NO_SELF_BASE。两种都是"如实失败"，这里只要求 code 属于"说得通"的那几个。
  check('7c code 说得通（SESSION_QUERY_UNAVAILABLE / NO_SELF_BASE / TAVERN_*）',
    ['SESSION_QUERY_UNAVAILABLE', 'NO_SELF_BASE', 'SCAN_INVALID'].includes(failed?.code) || String(failed?.code).startsWith('TAVERN_'),
    String(failed?.code))
  check('7d 状态里有时间与目标（播报要能说清什么时候、对哪个周目）',
    typeof failed?.at === 'string' && failed?.target?.characterId === 'charA' && failed?.target?.playthroughId === 'ptA',
    JSON.stringify({ at: failed?.at, target: failed?.target }))
}

rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS (_selftest-auto-collect)' : `\nFAIL ${failures}`)
process.exit(failures === 0 ? 0 : 3)
