/**
 * _selftest-session-playthrough.mjs —— 「会话 → 周目」的自检（纯函数 + 真机锚 + 端点三组）
 *
 * 它服务的是面板的**跟随当前会话**（用户口径 2026-09-19「点开记忆库要自动跳转到对应周目」）：
 * 打开面板 ⇒ 问宿主"这个会话属于哪个周目"（`GET /playthrough/for-session`）⇒ 查到就把**绑定**
 * 改过去（改绑定而不是只改显示 ⇒ 面板读的、面板里收纳写的、后台自动收纳口径全都对得上）。
 *
 * ★ 不写用户家里的 ~/.dsh：DSH_HOME 指到 <repo>/_selftest-home-spt，测完删掉。
 * ★ 不发真网络请求：只打本进程起的 http 服务。
 * ⚠️ 与 dsh-anima-rag 的 `lib/session-playthrough.js` 是同一套判据的两份实现 —— 那边也有台子。
 */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { apply } from './lib/index.js'
import {
  playthroughIdOf, characterIdOf, rootSessionIdOf, sessionIdsOfTimeline,
  buildSessionIndex, resolveForSession,
} from './lib/session-playthrough.js'

const HOME = resolve('_selftest-home-spt')
const WS = resolve('_selftest-ws-spt')
const PREFIX = '/dsh-memory-archive/api'
const PT_A = 'playthrough-aaaa-1111'
const PT_B = 'playthrough-bbbb-2222'
const CHAR_A = 'char-aaaa'
const CHAR_B = 'char-bbbb'
const S_ROOT_A = 'session-root-a'
const S_BRANCH_A = 'session-branch-a'
const S_ROOT_B = 'session-root-b'

process.env.DSH_HOME = HOME
rmSync(HOME, { recursive: true, force: true })
rmSync(WS, { recursive: true, force: true })

let pass = 0
let fail = 0
const check = (label, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${cond ? '' : '  ← ' + String(extra)}`)
}

// ───────── ① 形状解析（⛔ 畸形一律不抛、不猜）─────────
{
  check('① playthroughIdOf：优先 id；没有则从 path 倒数第二段取（含反斜杠）',
    playthroughIdOf({ id: PT_A }) === PT_A
    && playthroughIdOf({ path: 'C/' + PT_B + '/timeline.json' }) === PT_B
    && playthroughIdOf({ path: 'C\\' + PT_B + '\\timeline.json' }) === PT_B,
    playthroughIdOf({ path: 'C\\' + PT_B + '\\timeline.json' }))
  check('① characterIdOf：优先 ext 字段，退从 path 首段', (() => {
    const a = characterIdOf({ ext: { pmpDshTavern: { characterId: CHAR_A } }, path: 'x/' + PT_A + '/timeline.json' })
    const b = characterIdOf({ path: CHAR_B + '/' + PT_B + '/timeline.json' })
    return a === CHAR_A && b === CHAR_B
  })())
  check('① ★反证：畸形输入一律空串（null/数字/缺字段/段不够）', (() => {
    for (const v of [null, undefined, 'x', 1, {}, { path: '' }, { path: 'timeline.json' }, { id: '   ' }]) {
      if (playthroughIdOf(v) !== '' || characterIdOf(v) !== '' || rootSessionIdOf(v) !== '') return false
    }
    return true
  })())
  const tl = { head: { sessionId: S_BRANCH_A }, nodes: [{ variants: [{ sessionId: S_ROOT_A }, {}, null] }, null] }
  const ids = [...sessionIdsOfTimeline(tl)]
  check('① sessionIdsOfTimeline：head ∪ 各 variants（坏条目跳过）',
    ids.length === 2 && ids.includes(S_ROOT_A) && ids.includes(S_BRANCH_A), JSON.stringify(ids))
  check('① ★反证：timeline 畸形 ⇒ 空集且不抛', (() => {
    for (const v of [null, [], 'x', {}, { nodes: 'no' }, { head: {} }]) if (sessionIdsOfTimeline(v).size !== 0) return false
    return true
  })())
}

// ───────── ② 索引与解析 ─────────
{
  const rows = [
    { entry: { id: PT_A, ext: { pmpDshTavern: { characterId: CHAR_A, rootSessionId: S_ROOT_A } } }, timeline: { head: { sessionId: S_BRANCH_A }, nodes: [] } },
    { entry: { id: PT_B, path: CHAR_B + '/' + PT_B + '/timeline.json' }, timeline: { head: { sessionId: S_ROOT_B }, nodes: [] } },
  ]
  const idx = buildSessionIndex(rows)
  check('② 索引：根会话与分支会话都进来，且各自归对的周目',
    idx.map.get(S_ROOT_A) === PT_A && idx.map.get(S_BRANCH_A) === PT_A && idx.map.get(S_ROOT_B) === PT_B
    && idx.conflicts.length === 0, JSON.stringify({ sessions: idx.map.size, conflicts: idx.conflicts }))
  check('② byId：周目 → { characterId }（解析要拿它拼 `<角色>/<周目>`）',
    idx.byId.get(PT_A)?.characterId === CHAR_A && idx.byId.get(PT_B)?.characterId === CHAR_B,
    JSON.stringify([...idx.byId.entries()]))
  check('② resolveForSession：命中 ⇒ source=session 且带 characterId',
    JSON.stringify(resolveForSession(idx, S_ROOT_A)) === JSON.stringify({ characterId: CHAR_A, playthroughId: PT_A, source: 'session' }),
    JSON.stringify(resolveForSession(idx, S_ROOT_A)))
  check('② ★反证：不认识这个会话 ⇒ source=none（⛔ 端点**不**替你回落配置绑定，事实归事实）', (() => {
    const miss = resolveForSession(idx, 'session-nobody')
    const empty = resolveForSession(idx, '')
    const noIdx = resolveForSession(null, S_ROOT_A)
    return miss.source === 'none' && miss.playthroughId === ''
      && empty.source === 'none' && noIdx.source === 'none'
  })())
  check('② ★冲突：同会话属两周目 ⇒ 先到者胜 + conflicts 如实列出',
    (() => {
      const c = buildSessionIndex([
        { entry: { id: PT_A }, timeline: { head: { sessionId: S_ROOT_B } } },
        { entry: { id: PT_B }, timeline: { head: { sessionId: S_ROOT_B } } },
      ])
      return c.map.get(S_ROOT_B) === PT_A && c.conflicts.length === 1 && c.conflicts[0] === S_ROOT_B
    })())
}

// ───────── ③ 真机锚：真实 catalog + 两个 timeline ─────────
{
  const REAL_ROOT = 'D:/apps/dsh-tarven'
  const REAL_CATALOG = join(REAL_ROOT, 'catalog.json')
  if (existsSync(REAL_CATALOG)) {
    let entries = []
    try { entries = JSON.parse(readFileSync(REAL_CATALOG, 'utf8'))?.playthroughs ?? [] } catch { entries = [] }
    const rows = entries.map((entry) => {
      let timeline = null
      try { timeline = JSON.parse(readFileSync(join(REAL_ROOT, String(entry.path ?? '')), 'utf8')) } catch { timeline = null }
      return { entry, timeline }
    })
    const idx = buildSessionIndex(rows)
    const pairs = entries.map((e) => ({ id: playthroughIdOf(e), char: characterIdOf(e), root: rootSessionIdOf(e) })).filter((x) => x.id !== '')
    check('③ ★真机锚：每条周目都解析出 id，且它的 rootSessionId 映射回它自己',
      pairs.length > 0 && pairs.every((x) => x.root === '' || idx.map.get(x.root) === x.id),
      JSON.stringify(pairs.map((x) => ({ id: x.id, root: x.root, got: idx.map.get(x.root) }))))
    const withRoot = pairs.find((x) => x.root !== '')
    check('③ ★真机锚：拿真根会话解析 ⇒ source=session 且 characterId 也在',
      withRoot !== undefined && (() => {
        const r = resolveForSession(idx, withRoot.root)
        return r.source === 'session' && r.playthroughId === withRoot.id && r.characterId !== ''
      })(),
      withRoot === undefined ? '(catalog 里没有 rootSessionId)' : JSON.stringify(resolveForSession(idx, withRoot.root)))
    console.log(`  · 真机索引：${pairs.length} 个周目 / ${idx.map.size} 条会话 / 冲突 ${idx.conflicts.length}`)
  } else {
    console.log(`[SKIP] ③ 真机锚：这台机器上没有 ${REAL_CATALOG}`)
  }
}

// ───────── ④ 端点：GET /playthrough/for-session ─────────
{
  // 夹具：假工作区（catalog + timeline）+ play-workspace.json 指过去
  mkdirSync(join(HOME, 'dsh-memory-archive'), { recursive: true })
  writeFileSync(join(HOME, 'dsh-memory-archive', 'config.json'), JSON.stringify({ schemaVersion: 1 }))
  mkdirSync(join(HOME, 'pmp-dsh-tavern'), { recursive: true })
  writeFileSync(join(HOME, 'pmp-dsh-tavern', 'play-workspace.json'), JSON.stringify({ schemaVersion: 1, rootPath: WS }))
  mkdirSync(join(WS, CHAR_A, PT_A), { recursive: true })
  writeFileSync(join(WS, 'catalog.json'), JSON.stringify({
    playthroughs: [{
      id: PT_A,
      path: `${CHAR_A}/${PT_A}/timeline.json`,
      ext: { pmpDshTavern: { characterId: CHAR_A, rootSessionId: S_ROOT_A } },
    }],
  }))
  writeFileSync(join(WS, CHAR_A, PT_A, 'timeline.json'), JSON.stringify({ head: { sessionId: S_BRANCH_A }, nodes: [] }))

  const routes = []
  const webServer = { register: (route) => { routes.push(route); return () => {} } }
  const ctx = {
    effect: (fn) => fn(),
    inject: (_n, cb) => cb(ctx),
    get: (name) => (name === 'webServer' ? webServer : undefined),
    webServer,
  }
  apply(ctx)
  const route = routes.find((r) => r.path === PREFIX)
  const server = createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname
    if (p === PREFIX || p.startsWith(PREFIX + '/')) return route.handler(req, res)
    res.writeHead(404); res.end('{}')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}${PREFIX}`
  const q = async (qs) => {
    const res = await fetch(base + '/playthrough/for-session' + qs)
    const text = await res.text()
    let data = null
    try { data = JSON.parse(text) } catch { /* 留 null */ }
    return { status: res.status, data, text }
  }
  try {
    const hit = await q('?sessionId=' + encodeURIComponent(S_BRANCH_A))
    check('④ 命中（分支会话也算数）：ok + source=session + characterId/playthroughId 都对',
      hit.status === 200 && hit.data?.ok === true && hit.data.source === 'session'
      && hit.data.characterId === CHAR_A && hit.data.playthroughId === PT_A, hit.text.slice(0, 220))
    const miss = await q('?sessionId=session-nobody')
    check("④ ★反证：不认识的会话 ⇒ source='none'（面板据此**保持原绑定**，⛔ 不瞎跳）",
      miss.data?.ok === true && miss.data.source === 'none' && miss.data.playthroughId === '', miss.text.slice(0, 200))
    const noId = await q('')
    check('④ ★反证：缺 sessionId ⇒ 如实报缺（不是拿空串去查）',
      noId.data?.ok === false && noId.data?.error?.code === 'FOR_SESSION_NO_ID', noId.text.slice(0, 160))
    const leaked = hit.text.includes(WS) || hit.text.includes('timeline.json')
    check('④ ★反证：响应里不含任何路径（只回 id 与判词）', leaked === false, hit.text.slice(0, 200))
    // 没绑工作区根 ⇒ 如实报"读不到 catalog"，⛔ 不假装 source:none
    writeFileSync(join(HOME, 'pmp-dsh-tavern', 'play-workspace.json'), JSON.stringify({ schemaVersion: 1, rootPath: resolve('_no-such-ws') }))
    const noCatalog = await q('?sessionId=' + encodeURIComponent(S_BRANCH_A))
    check('④ ★反证：catalog 读不到 ⇒ ok:false + FOR_SESSION_NO_CATALOG（⛔ 不假装成"这会话没有周目"）',
      noCatalog.data?.ok === false && noCatalog.data?.error?.code === 'FOR_SESSION_NO_CATALOG', noCatalog.text.slice(0, 200))
  } finally {
    await new Promise((r) => server.close(r))
  }
}

rmSync(HOME, { recursive: true, force: true })
rmSync(WS, { recursive: true, force: true })

console.log(`\n── ${pass} 通过 / ${fail} 失败 ──`)
process.exitCode = fail === 0 ? 0 : 1
