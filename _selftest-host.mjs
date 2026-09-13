/**
 * magictarven 宿主半侧自检（可保留）
 *
 * ★ 不写用户家里的 ~/.dsh：DSH_HOME 指到 <repo>/_selftest-home，测完删掉。
 * ★ 不发真网络请求：/config/test 只测「缺字段 → 400 CONFIG_INCOMPLETE」这条无网络分支。
 * 假 sessionQuery 契约（按上游源码/真环境实测）：
 *   readSession(id) 只吃一个参数、返回全量 {session,events}；filterEvents(id,[]) 空过滤=全量
 *   且带 surface+正文；listEvents(id) 返回 {seq,type,time,surface}；SessionRecord 只有
 *   {header,live,persisted}；readTitleSnapshots(ids) 返回 allSettled 风格数组
 *   {sessionId,status:'fulfilled'|'rejected',value:{session,title?}}，标题在 value.title.title。
 */
import { createServer } from 'node:http'
import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { apply } from './lib/index.js'

const HOME = resolve('_selftest-home')
process.env.DSH_HOME = HOME
const PREFIX = '/magictarven/api'

let failed = false
function check(name, cond, extra) {
  if (cond) console.log(`PASS ${name}`)
  else {
    failed = true
    console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`)
  }
}

function makeCtx(sq) {
  const routes = []
  const webServer = {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
  }
  const ctx = {
    effect: (fn) => fn(),
    inject: (_names, cb) => cb(ctx),
    get: (name) => (name === 'webServer' ? webServer : name === 'sessionQuery' ? sq : undefined),
    webServer,
  }
  apply(ctx)
  return routes[0]
}

// ---- 假数据：120 条事件，surface 按 seq%3 轮转三态 ----
const EVENTS = Array.from({ length: 120 }, (_, i) => ({
  seq: i,
  type: 'message',
  time: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
  role: i % 2 ? 'assistant' : 'user',
  content: `body-${i}`,
}))
const SURF = (i) => (i % 3 === 0 ? 'current' : i % 3 === 1 ? 'shadowed' : 'log-only')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const TITLE_RECORDS = [
  { header: { id: 'sess-A', createdAt: '2026-01-01T00:00:00Z' }, live: true, persisted: true },
  { header: { id: 'sess-B', createdAt: '2026-01-02T00:00:00Z' }, live: false, persisted: true },
  { header: { id: 'sess-C' }, live: true, persisted: false },
]
const realTitleSnaps = () => [
  {
    sessionId: 'sess-A',
    status: 'fulfilled',
    value: {
      session: { id: 'sess-A' },
      title: { title: '标题A', messageSeqs: [0], source: 'auto', eventSeq: 3, updatedAt: 1735689600000 },
    },
  },
  { sessionId: 'sess-B', status: 'rejected', reason: 'boom' },
  { sessionId: 'sess-C', status: 'fulfilled', value: { session: { id: 'sess-C' } } },
]

function mkSq({ delayMs = 0, titleSnaps } = {}) {
  const counters = { read: 0, filter: 0, list: 0, sessions: 0, titleSnapshots: 0 }
  const sq = {
    counters,
    readSession: async (id) => {
      counters.read++
      if (delayMs) await sleep(delayMs)
      return { session: { id }, events: EVENTS.map((e) => ({ ...e })) }
    },
    filterEvents: async (_id, filters) => {
      counters.filter++
      if (delayMs) await sleep(delayMs)
      if (!Array.isArray(filters)) throw new Error('filters must be array')
      return EVENTS.map((e) => ({ seq: e.seq, type: e.type, time: e.time, surface: SURF(e.seq), text: e.content }))
    },
    listEvents: async () => {
      counters.list++
      return EVENTS.map((e) => ({ sessionId: 'x', seq: e.seq, type: e.type, time: e.time, surface: SURF(e.seq) }))
    },
    listSessions: async () => {
      counters.sessions++
      return TITLE_RECORDS.map((r) => ({ ...r, header: { ...r.header } }))
    },
    readTitleSnapshots: async (ids) => {
      counters.titleSnapshots++
      if (titleSnaps) return titleSnaps(ids)
      return []
    },
  }
  return { sq, counters }
}

// ---- 静态自检 ----
const route = makeCtx(undefined)
let okA = true
try {
  apply({ inject: (_n, _cb) => {}, get: () => undefined })
} catch {}
let okB = true
try {
  apply({ get: () => undefined })
} catch {}
check(
  '静态：1条路由 kind=prefix path=/magictarven/api handler=函数；webServer 缺失（两形态）apply 不抛',
  route &&
    route.kind === 'prefix' &&
    route.path === '/magictarven/api' &&
    typeof route.handler === 'function' &&
    okA &&
    okB,
)

// ---- HTTP 真跑 ----
let handler = route.handler
const server = createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname
  if (p === PREFIX || p.startsWith(PREFIX + '/')) return handler(req, res)
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'no route' } }))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}${PREFIX}`

async function call(method, path, bodyObj) {
  const init = { method }
  if (bodyObj !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj)
  }
  const resp = await fetch(base + path, init)
  const text = await resp.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {}
  return { status: resp.status, data, text }
}
const switchTo = (sq) => {
  handler = makeCtx(sq).handler
}

try {
  const h = await call('GET', '/health')
  check(
    'GET /health → 200 webServer=true sessionQuery=false storageDirWritable=true tavernReachable=bool',
    h.status === 200 && h.data?.ok === true && h.data?.webServer === true && h.data?.sessionQuery === false &&
      h.data?.storageDirWritable === true && typeof h.data?.tavernReachable === 'boolean',
  )

  await call('PUT', '/config', { rootMode: 'workspace' })
  await call('PUT', '/config', {
    api: { url: 'https://example.invalid/v1/chat/completions', model: 'test-model', key: 'sk-TEST-abcd1234' },
  })
  const cK = await call('GET', '/config')
  await call('PUT', '/config', { api: { key: '' } })
  const cKeep = await call('GET', '/config')
  await call('PUT', '/config', { api: { key: '__CLEAR__' } })
  const cClear = await call('GET', '/config')
  const cRoot = await call('GET', '/config')
  check(
    "配置回环+密钥语义：workspace 读回；key→keySet=true keyHint=…1234 无原文；''保留；__CLEAR__→false；盘上有 config.json 无 .tmp",
    cRoot.data?.rootMode === 'workspace' && cK.data?.keySet === true && cK.data?.keyHint === '…1234' &&
      !cK.text.includes('sk-TEST-abcd1234') && !('key' in (cK.data?.api || {})) && cKeep.data?.keySet === true &&
      cClear.data?.keySet === false && existsSync(join(HOME, 'magictarven', 'config.json')) &&
      !existsSync(join(HOME, 'magictarven', 'config.json.tmp')),
  )

  const bad1 = await call('PUT', '/config', { rootMode: 'bogus' })
  const bad2 = await call('PUT', '/config', { api: { url: 'ftp://nope' } })
  const bad3 = await call('PUT', '/config', '{not json')
  check(
    '校验：rootMode=bogus / url=ftp:// / 非法JSON → 400 CONFIG_INVALID',
    bad1.status === 400 && bad1.data?.error?.code === 'CONFIG_INVALID' && bad2.status === 400 && bad3.status === 400,
  )
  const t1 = await call('POST', '/config/test')
  check('POST /config/test（key 已清空）→ 400 CONFIG_INCOMPLETE（未发网络请求）', t1.status === 400 && t1.data?.error?.code === 'CONFIG_INCOMPLETE')

  const s503 = await call('GET', '/sessions')
  const e503 = await call('GET', '/session/events?sessionId=x')
  check(
    '无 sessionQuery → /sessions、/session/events 均 503 SESSION_QUERY_UNAVAILABLE（不500不崩）',
    s503.status === 503 && s503.data?.error?.code === 'SESSION_QUERY_UNAVAILABLE' && e503.status === 503 && e503.data?.error?.code === 'SESSION_QUERY_UNAVAILABLE',
  )

  // ① 分页（readSession 单参 → 本地切片）；此时无缓存干扰：每个请求独立 handler
  const pg = makeCtx(mkSq().sq)
  handler = pg.handler
  const p1 = await call('GET', '/session/events?sessionId=pg')
  const p2 = await call('GET', '/session/events?sessionId=pg&limit=50&offset=50')
  const pAll = await call('GET', '/session/events?sessionId=pg&limit=999')
  check(
    '分页：默认50条；limit=50&offset=50 → 50条 total=120 首seq=50 尾seq=99；limit=999 夹200 → 120条不报错',
    p1.data?.total === 120 && p1.data?.events?.length === 50 &&
      p2.data?.total === 120 && p2.data?.events?.length === 50 && p2.data?.events?.[0]?.seq === 50 && p2.data?.events?.[49]?.seq === 99 &&
      pAll.data?.events?.length === 120 && pAll.data?.total === 120,
    JSON.stringify({ p1: p1.data?.events?.length, p2: p2.data?.events?.length, pAll: pAll.data?.events?.length }),
  )

  // ② surface 由 filterEvents(id,[]) 填上
  const surfs = new Set(p2.data.events.map((e) => e.surface))
  check(
    'surface：filterEvents 生效 → current/shadowed/log-only 三态齐全、无 null、正文与 seq 对齐',
    surfs.size === 3 && ['current', 'shadowed', 'log-only'].every((v) => surfs.has(v)) &&
      p2.data.events.every((e) => e.surface !== null && e.text === `body-${e.seq}`),
  )

  // ③ 兜底：filterEvents 抛错 → listEvents join；两者全缺 → surface:null 且条目不少
  switchTo({
    readSession: async (id) => ({ session: { id }, events: EVENTS.map((e) => ({ ...e })) }),
    filterEvents: async () => {
      throw new Error('filterEvents boom')
    },
    listEvents: async () => EVENTS.map((e) => ({ sessionId: 'x', seq: e.seq, type: e.type, time: e.time, surface: SURF(e.seq) })),
  })
  const j1 = await call('GET', '/session/events?sessionId=s1&limit=50&offset=50')
  switchTo({ readSession: async (id) => ({ session: { id }, events: EVENTS.map((e) => ({ ...e })) }) })
  const d1 = await call('GET', '/session/events?sessionId=s1')
  check(
    '兜底：filterEvents抛错→listEvents join surface 无null；两者全缺→surface 全 null、50条 total=120 正文在',
    j1.data?.events?.length === 50 && j1.data.events.every((e) => e.surface === SURF(e.seq) && e.text === `body-${e.seq}`) &&
      d1.data?.total === 120 && d1.data?.events?.length === 50 && d1.data.events.every((e) => e.surface === null && e.text === `body-${e.seq}`),
  )

  // ④ title / updatedAt（真实形状：fulfilled/rejected 混合 + value.title 对象）
  const tt = mkSq({ titleSnaps: realTitleSnaps })
  switchTo(tt.sq)
  const st = await call('GET', '/sessions?titles=1')
  const rows = st.data?.sessions || []
  check(
    'title/updatedAt：fulfilled→value.title.title=标题A、updatedAt=title.updatedAt(数字)；rejected→跳过不覆盖(title=null,updatedAt=createdAt退路)；无title无createdAt→全null',
    st.status === 200 && rows[0]?.sessionId === 'sess-A' && rows[0]?.title === '标题A' && rows[0]?.updatedAt === 1735689600000 &&
      rows[1]?.sessionId === 'sess-B' && rows[1]?.title === null && rows[1]?.updatedAt === '2026-01-02T00:00:00Z' &&
      rows[2]?.sessionId === 'sess-C' && rows[2]?.title === null && rows[2]?.updatedAt === null,
    JSON.stringify(rows),
  )

  // ⑤ /sessions?titles=0 快路径（不碰投影）+ titles=1 的 TTL 缓存
  const tu = mkSq({ titleSnaps: realTitleSnaps })
  switchTo(tu.sq)
  const t0 = Date.now()
  const fast = await call('GET', '/sessions')
  const fastMs = Date.now() - t0
  const fastSnaps = tu.counters.titleSnapshots // 快路径后立刻采样：必须 0 次投影
  const withT = await call('GET', '/sessions?titles=1')
  const withT2 = await call('GET', '/sessions?titles=1')
  check(
    `titles=0：投影 0 次、title/updatedAt 全 null、耗时 ${fastMs}ms(<1500)；titles=1：投影 1 次并解出；再查走 TTL 缓存仍 1 次`,
    fast.status === 200 && fastSnaps === 0 && fastMs < 1500 &&
      (fast.data?.sessions || []).every((s) => s.title === null && s.updatedAt === null) &&
      withT.status === 200 && tu.counters.titleSnapshots === 1 && withT.data?.sessions?.[0]?.title === '标题A' &&
      withT2.status === 200 && tu.counters.titleSnapshots === 1,
    JSON.stringify({ fastMs, fastSnaps, finalSnaps: tu.counters.titleSnapshots }),
  )

  // ⑥ 缓存：同会话两次只 load 1 次；refresh=1 重取；跨会话不串味
  const vc = mkSq()
  switchTo(vc.sq)
  await call('GET', '/session/events?sessionId=c1')
  await call('GET', '/session/events?sessionId=c1')
  const afterHit = { read: vc.counters.read, filter: vc.counters.filter }
  await call('GET', '/session/events?sessionId=c1&refresh=1')
  const afterRefresh = vc.counters.read
  await call('GET', '/session/events?sessionId=c2')
  await call('GET', '/session/events?sessionId=c1')
  check(
    '缓存：同会话两次 load/filterEvents 各只 1 次；refresh=1 → 重取(2次)；换会话各取各的（不串味，共3次load）',
    afterHit.read === 1 && afterHit.filter === 1 && afterRefresh === 2 && vc.counters.read === 3 && vc.counters.filter === 3,
    JSON.stringify({ afterHit, afterRefresh, final: vc.counters }),
  )

  // ⑦ LRU 容量 ≤3：4 个会话连取后，最久未用的被逐出（重载），最近命中的仍在
  const wc = mkSq()
  switchTo(wc.sq)
  for (const id of ['l1', 'l2', 'l3', 'l1', 'l4', 'l2', 'l1']) {
    await call('GET', `/session/events?sessionId=${id}`)
  }
  check(
    'LRU≤3：序列 l1,l2,l3,l1,l4,l2,l1 → load 恰 5 次（l4 挤掉 l2、l2 重取又挤掉 l3 ⇒ 容量恒 ≤3；两次 l1 均命中）',
    wc.counters.read === 5,
    JSON.stringify(wc.counters),
  )

  // ⑧ 缓存提速：首查 ≥1000ms（假 sessionQuery 延迟 1200ms），二查 <300ms
  const xc = mkSq({ delayMs: 1200 })
  switchTo(xc.sq)
  const ms0 = Date.now()
  await call('GET', '/session/events?sessionId=t1&limit=50&offset=50')
  const ms1 = Date.now()
  await call('GET', '/session/events?sessionId=t1&limit=50&offset=50')
  const ms2 = Date.now()
  check(
    `提速：首查 ${ms1 - ms0}ms(≥1000) → 二查 ${ms2 - ms1}ms(<300)，load 只 1 次`,
    ms1 - ms0 >= 1000 && ms2 - ms1 < 300 && xc.counters.read === 1 && xc.counters.filter === 1,
  )

  const nf = await call('GET', '/nope')
  check('未知路径 → 404 NOT_FOUND', nf.status === 404 && nf.data?.error?.code === 'NOT_FOUND')
} finally {
  server.closeAllConnections?.()
  await new Promise((r) => server.close(r))
  rmSync(HOME, { recursive: true, force: true })
  console.log('CLEANUP _selftest-home 已删除')
}

console.log(failed ? 'RESULT: FAIL' : 'RESULT: ALL PASS')
process.exit(failed ? 1 : 0)
