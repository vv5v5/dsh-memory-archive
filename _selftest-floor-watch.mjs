/**
 * _selftest-floor-watch.mjs —— 「**主机侧盯时间线** + **SSE 推浏览器**（回档 → 立刻弹）」的自检
 * （20260924 单：用户口径「还需要一个 dsh 的弹窗 提示，最好是从**上方弹出**的那种」＋
 *  「**不能在回档操作之后立刻弹吗，检测 tarven**」）。
 *
 * 本单两件事，各自只有一处实现：
 *   ① `lib/floor-watch.js` —— **纯逻辑内核**：盯**目录**（⛔ 不盯文件：Windows 上"写完改名"很常见）、
 *      按**文件名**过滤、**去抖**、**不抛**（盯不住 ⇒ 空 dispose + 如实 warn 一条）；
 *   ② `lib/index.js` —— 接线：`fs.watch`（可注入）+ 判到**开 fork** 就推一帧给**我们自己的 SSE 端点**
 *      `GET …/floors/events`（连上先发 `hello`、25 秒注释心跳、订阅者上限 8、断开即摘、卸载全关）。
 *
 * 五节（都按项目惯例：**相 + 反证成对**，⛔ 不只做源码字符串断言）：
 *   A 纯逻辑：`debounce`（窗内连喂只回调一次 / 窗后再喂再来一次 / cancel / 不抛）；
 *   B `watchTimeline`（**假 watcher + 真目录**）：只认那个文件名（反证：把过滤那一步挖掉必红）· 去抖 ·
 *     dispose 幂等且真的关掉 watcher · **盯不住的失败姿态**（目录不存在 / 权限不足 ⇒ 空 dispose + 一条
 *     如实日志）· 异步 `error` 事件不把宿主搞挂 · ★ 真 `fs.watch` 冒烟（生产那条路在这台机器上真的通）；
 *   C **真 HTTP**（照本仓那段"真 HTTP + 真钩子"的做法：假 ctx 驱动真 `apply()` + 真 `createServer`）：
 *     连上第一帧就是 `hello` 且那条 `pending` 与同一刻 `/floors` 里那条**逐字一致**；挂两条连接推一次 ⇒
 *     **两条都收到**（反证：只推第一个 ⇒ 本相必红）；断开即摘（反证：不摘 ⇒ 数得出幽灵订阅者）；
 *     上限 8 ⇒ 第 9 条如实 503 + 一句人话；⛔ 这一整段跑完**清单文件一个字节都没动**（sha + mtime 都不动）；
 *   D **端到端**：夹具里改 `timeline.json` 造一次"剧情退回去"（假 watcher 喂事件）⇒ 订阅者收到
 *     `{type:'fork'}` **且** `/floors` 里那条 pending 也真的在（两处**同源**）；改成"剧情往前走" ⇒
 *     **不推**（⛔ 把"只在 `fork.kind === 'fork'` 才推"挖掉 ⇒ 本相必红 —— 台子紧接着又推得出一帧，
 *     证明那份安静是真的安静、不是通道死了）；
 *   E 静态纪律：⛔ 不轮询/不定时器（SSE 那个 25 秒心跳是**注释帧**）· ⛔ 端点纯推送不写盘 ·
 *     ⛔ 不碰上游 Tavern 一行代码（只**读**它写的那个文件名）· 接线随卸载拆掉。
 *
 * ★ 全部夹具都在**临时目录**里（`_selftest-home-fwatch` / `_selftest-ws-fwatch` / `_selftest-fwatch-tmp`），
 *   测完删掉；⛔ 全程不碰真机（`C:\Users\w\.dsh`）、⛔ 不碰用户的 RP 工作区（`D:\apps\dsh-tarven`）。
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, watch as fsWatchReal, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { apply, __setFloorWatch, __floorSseStats, __disposeFloorWatch } from './lib/index.js'
import * as fw from './lib/floor-watch.js'
import * as fl from './lib/floor-snapshot.js'

const ROOT = resolve('.')
const HOME = join(ROOT, '_selftest-home-fwatch')
const WS = join(ROOT, '_selftest-ws-fwatch')
const PREFIX = '/dsh-memory-archive/api'
const PT = join(WS, 'ch', 'pt')
const PT_MEM = join(PT, '.roleplay-memory')
const SESSION = 'sess-fwatch-1'
const TMP = join(ROOT, '_selftest-fwatch-tmp')   // 纯逻辑那一节用的真临时目录
const EVENTS_PATH = '/playthrough/rp-memory/floors/events'

process.env.DSH_HOME = HOME

let pass = 0
let failed = 0
function check(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  ✔ ${label}`) } else {
    failed += 1
    console.log(`  ✘ ${label}${extra === undefined ? '' : '  ← ' + extra}`)
  }
}
const sect = (t) => console.log(`\n${t}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 一直等到 `fn()` 为真（或超时）—— 事件那条链是异步的，⛔ 不拿固定 sleep 赌。 */
async function waitFor(fn, ms = 5000, step = 25) {
  const t0 = Date.now()
  for (;;) {
    let v = false
    try { v = fn() === true } catch { v = false }
    if (v) return true
    if (Date.now() - t0 > ms) return false
    await sleep(step)
  }
}

// ── 夹具 ────────────────────────────────────────────────────────────────────
const NODES = ['qa-1-1-aaa', 'qa-2-2-bbb', 'qa-3-3-ccc', 'qa-4-4-ddd', 'qa-5-5-eee']
const VAR = (id, k = 1) => 'variant-' + id + (k === 1 ? '' : '-v' + k)
const VARIANTS_OF = (id) => [VAR(id), VAR(id, 2)]
const nodeOf = (id, i, variants) => ({
  id, kind: 'qa',
  adoptedVariantId: variants[variants.length - 1],
  variants: variants.map((v) => ({ id: v, sessionId: SESSION, startEventId: i + 1, endEventId: i + 1, ext: {} })),
})
/** ⚠️ `ext.pad` 每写一次长一个字符：读侧按 `路径|mtime|size` 缓存，同一毫秒里连写两次才不吃旧缓存。 */
let timelineWrites = 0
function writeTimeline(headId, ids = NODES, headVariant = null) {
  timelineWrites += 1
  const nodes = ids.map((id, i) => nodeOf(id, i, VARIANTS_OF(id)))
  mkdirSync(PT, { recursive: true })
  writeFileSync(join(PT, 'timeline.json'), JSON.stringify({
    head: headId === null
      ? {}
      : { sessionId: SESSION, nodeId: headId, variantId: headVariant === null ? VAR(headId) : headVariant },
    nodes,
    ext: { pad: 'x'.repeat(timelineWrites) },
  }))
}
const writeConfig = () => {
  mkdirSync(join(HOME, 'dsh-memory-archive'), { recursive: true })
  writeFileSync(join(HOME, 'dsh-memory-archive', 'config.json'), JSON.stringify({
    schemaVersion: 1,
    rootMode: 'workspace',
    root: { sessionId: null, characterId: 'ch', playthroughId: 'pt' },
  }))
}
const writeTavern = () => {
  mkdirSync(join(HOME, 'pmp-dsh-tavern'), { recursive: true })
  writeFileSync(join(HOME, 'pmp-dsh-tavern', 'play-workspace.json'), JSON.stringify({ schemaVersion: 1, rootPath: WS }))
  mkdirSync(WS, { recursive: true })
  writeFileSync(join(WS, 'catalog.json'), JSON.stringify({
    playthroughs: [{
      id: 'pt', path: 'ch/pt/timeline.json',
      ext: { pmpDshTavern: { characterId: 'ch', rootSessionId: SESSION } },
    }],
  }))
  writeTimeline(NODES[0])
}
const writeMem = (name, text) => { mkdirSync(PT_MEM, { recursive: true }); writeFileSync(join(PT_MEM, name), text) }
const seenPath = () => join(HOME, 'dsh-memory-archive', 'floor-head.json')
const indexPath = () => join(PT_MEM, fl.FLOOR_DIR_NAME, fl.FLOOR_INDEX_NAME)
/** 清单那份文件的"动没动过"指纹（sha256 + mtime + size）——那条 SSE **一个字节都不许写**就靠它判）。 */
function indexStamp() {
  try {
    const text = readFileSync(indexPath(), 'utf8')
    const st = statSync(indexPath())
    return { sha: createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16), mtime: st.mtimeMs, size: st.size }
  } catch { return { sha: '(没有)', mtime: 0, size: 0 } }
}
const floorDoc = () => { try { return JSON.parse(readFileSync(indexPath(), 'utf8')) } catch { return null } }
const pendingOnDisk = () => {
  const doc = floorDoc()
  return doc === null || doc.pending === undefined ? null : doc.pending
}
/** 清空夹具（记忆库整块删、时间线重写、`seen` 那份簿记清掉 —— 每个夹具从"第一次见"开始）。 */
function reset(files = {}, headId = NODES[0]) {
  rmSync(PT_MEM, { recursive: true, force: true })
  mkdirSync(PT_MEM, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeMem(name, text)
  writeTimeline(headId)
  rmSync(seenPath(), { force: true })
}

// ── ★ 假 watcher（注入进 index.js 的那一格；台子靠它**直接喂事件**）─────────────────────────
const watchers = []
/** 造一个假 `fs.watch`（签名与真的一样：`(dir, listener) => watcher`）。 */
function makeFakeWatch() {
  return (dir, listener) => {
    const w = {
      dir, listener, closed: false, handlers: {},
      on(event, fn) { w.handlers[event] = fn; return w },
      close() { w.closed = true },
    }
    watchers.push(w)
    return w
  }
}
/** 喂一个事件给**所有还活着的** watcher（真 `fs.watch` 的回调形状：(eventType, filename)）。 */
function feed(filename, eventType = 'change') {
  let n = 0
  for (const w of watchers) {
    if (w.closed) continue
    n += 1
    try { w.listener(eventType, filename) } catch { /* 台子里绝不抛 */ }
  }
  return n
}
const liveWatchers = () => watchers.filter((w) => w.closed !== true)
const newestWatcher = () => watchers[watchers.length - 1]

// ── 假 ctx（能驱动真的 `apply()`：钩子 + 两条路由都在场）──────────────────────────────────
const routes = []
const listeners = []
const logs = { info: [], warn: [], error: [] }
const webServer = { register: (route) => { routes.push(route); return () => {} } }
function makeScope(pluginName) {
  return {
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on: (event, fn) => { listeners.push({ event, fn, who: pluginName }); return () => {} },
    systemPrompt: { section: () => () => {} },
  }
}
function makeCtx() {
  const ctx = {
    effect: (fn) => fn(),
    inject: (_names, cb) => cb(ctx),
    get: (name) => (name === 'webServer' ? webServer : undefined),
    webServer,
    plugin: (spec) => { spec.apply(makeScope(spec.name)) },
    on: (event, fn) => { listeners.push({ event, fn, who: 'ctx' }); return () => {} },
    logger: {
      info: (m) => logs.info.push(String(m)),
      warn: (m) => logs.warn.push(String(m)),
      error: (m) => logs.error.push(String(m)),
    },
  }
  apply(ctx)
  return routes.find((r) => r.path === PREFIX) ?? routes[0]
}

rmSync(HOME, { recursive: true, force: true })
rmSync(WS, { recursive: true, force: true })
rmSync(TMP, { recursive: true, force: true })
mkdirSync(WS, { recursive: true })
mkdirSync(TMP, { recursive: true })
writeConfig()
writeTavern()
reset({ 'notes.md': '# 笔记\n开局\n', 'index.md': '# 索引\n开局\n' })
// ★ 注入假 watcher（**必须在 apply() 之前** —— 接线那一刻（scope.effect）就要用它建第一条 watcher）
__setFloorWatch(makeFakeWatch())
const route = makeCtx()
const server = createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname
  if (p === PREFIX || p.startsWith(PREFIX + '/')) return route.handler(req, res)
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: false }))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}${PREFIX}`

async function call(method, path, body) {
  const init = { method }
  if (body !== undefined) { init.headers = { 'content-type': 'application/json' }; init.body = typeof body === 'string' ? body : JSON.stringify(body) }
  const resp = await fetch(base + path, init)
  const text = await resp.text()
  let data = null
  try { data = JSON.parse(text) } catch { /* 非 JSON 就留 null */ }
  return { status: resp.status, data, text, headers: resp.headers }
}
const floorsView = async () => (await call('GET', '/playthrough/rp-memory/floors')).data

/**
 * SSE 客户端（只用 node 自带的 `fetch` 流）：逐帧读 `data:` 行；注释帧（`:` 开头）单独数。
 * `waitFrames(n)` 等到收到 n 帧（超时给 false）。
 */
async function openSse(path = EVENTS_PATH) {
  const controller = new AbortController()
  const sess = { controller, status: 0, headers: null, frames: [], comments: 0, body: '', closed: false, error: null, raw: '' }
  const resp = await fetch(base + path, { signal: controller.signal })
  sess.status = resp.status
  sess.headers = resp.headers
  if (resp.status !== 200) {
    sess.body = await resp.text()
    sess.closed = true
    return sess
  }
  const reader = resp.body.getReader()
  const dec = new TextDecoder()
  ;(async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        sess.raw += dec.decode(value, { stream: true })
        let i = sess.raw.indexOf('\n\n')
        while (i !== -1) {
          const chunk = sess.raw.slice(0, i)
          sess.raw = sess.raw.slice(i + 2)
          if (chunk.startsWith(':')) sess.comments += 1
          else {
            const line = chunk.split('\n').find((l) => l.startsWith('data: '))
            if (line !== undefined) {
              try { sess.frames.push(JSON.parse(line.slice(6))) } catch { sess.frames.push({ __badFrame: line }) }
            }
          }
          i = sess.raw.indexOf('\n\n')
        }
      }
    } catch (e) { sess.error = e }
    sess.closed = true
  })()
  sess.close = () => { try { controller.abort() } catch { /* 已经断了 */ } }
  sess.waitFrames = (n, ms = 6000) => waitFor(() => sess.frames.length >= n, ms)
  return sess
}

const opened = []
async function openSseTracked() {
  const s = await openSse()
  opened.push(s)
  return s
}

try {
  // ═════════════════════════════════════════════════════════════════════════
  sect('0 台子自证（这几条不成立的话，下面全白测）')

  check('0a 假 watcher 在接线那一刻就挂上了，盯的是**时间线的目录**（⛔ 不是那个文件）',
    liveWatchers().length === 1 && liveWatchers()[0].dir === PT,
    `watchers=${JSON.stringify(watchers.map((w) => ({ dir: w.dir, closed: w.closed })))}`)
  const postEvents = await call('POST', EVENTS_PATH, {})
  check('0b 那条端点登记在表里且**只认 GET**（POST ⇒ 405 + "只接受 GET"）',
    postEvents.status === 405 && String(postEvents.text).includes('只接受 GET'), `status=${postEvents.status} body=${postEvents.text.slice(0, 120)}`)
  check('0c 场地就绪：记忆库与时间线都在', existsSync(PT_MEM) && existsSync(join(PT, 'timeline.json')))

  // ═════════════════════════════════════════════════════════════════════════
  sect('A 纯逻辑：debounce（窗内只回调一次 · 窗后再喂再来一次 · cancel · ⛔ 不抛）')

  {
    let calls = 0
    let lastArgs = null
    const d = fw.debounce((...a) => { calls += 1; lastArgs = a }, 40)
    d('a'); d('b'); d('c')                        // 窗内连喂 3 次
    await sleep(120)
    check('A1 窗内连喂 3 次 ⇒ **只回调 1 次**（用的是最后一次那份参数）', calls === 1 && lastArgs[0] === 'c',
      `calls=${calls} args=${JSON.stringify(lastArgs)}`)
    d('d')                                        // 窗后再喂
    await sleep(120)
    check('A2 窗后再喂 ⇒ **再回调一次**', calls === 2 && lastArgs[0] === 'd', `calls=${calls}`)
    // ★ 反证（对着 A1）：同款逻辑但**不去抖**（每次喂都跑）⇒ A1 必红
    let rawCalls = 0
    const raw = (fn) => (...a) => fn(...a)
    const rd = raw(() => { rawCalls += 1 })
    rd(); rd(); rd()
    await sleep(60)
    check('A3 反证：**不去抖**的同款逻辑 ⇒ 3 次喂 = 3 次回调（说明 A1 咬的是"只回调一次"这件事）',
      rawCalls === 3, `rawCalls=${rawCalls}`)
    const before = calls
    const d2 = fw.debounce(() => { calls += 1 }, 40)
    d2(); d2.cancel()
    await sleep(120)
    check('A4 `cancel()`：还没到点的那一拍被掐掉（⛔ 不许"已经拆掉了还回调一下"）', calls === before, `calls=${calls}`)
    let threw = false
    try {
      fw.debounce(null, -5)('x')
      await sleep(20)
      fw.debounce(() => { throw new Error('boom') }, 0)()
      await sleep(30)
    } catch { threw = true }
    check('A5 坏输入 / 回调里抛异常，都**不往外抛**（定时器里抛出去＝未捕获异常，能把宿主搞挂）', threw === false)
  }

  // ═════════════════════════════════════════════════════════════════════════
  sect('B watchTimeline（**假 watcher + 真目录**）：只认那个文件名 · 去抖 · dispose 幂等 · 盯不住也不抛')

  {
    const log = { warns: [], warn(m) { log.warns.push(String(m)) } }
    let fired = 0
    const dispose = fw.watchTimeline(TMP, { watch: makeFakeWatch(), onChange: () => { fired += 1 }, log, debounceMs: 30 })
    const w = newestWatcher()
    check('B0 盯的是传进来的那个**目录**（`watch(dir, …)` —— ⛔ 不盯单个文件）', w.dir === TMP, `dir=${w.dir}`)
    w.listener('change', 'timeline.json')
    await sleep(120)
    check('B1 写 `timeline.json` ⇒ 触发一次', fired === 1, `fired=${fired}`)
    w.listener('change', 'timeline.json'); w.listener('change', 'timeline.json'); w.listener('rename', 'timeline.json')
    await sleep(140)
    check('B2 窗内连喂 3 个事件（一次保存的 create+change+rename 那种）⇒ **只触发一次**', fired === 2, `fired=${fired}`)
    const before = fired
    w.listener('change', 'catalog.json'); w.listener('change', 'notes.md'); w.listener('rename', 'index.json')
    await sleep(140)
    check('B3 写**别的文件**（catalog.json / notes.md / index.json）⇒ **一次都不触发**', fired === before, `fired=${fired}`)
    // ★ 反证（对着 B3）：把"按文件名过滤"那一步**挖掉**（同款逻辑照抄一遍，只少那一行）⇒ 写别的文件也会触发
    let dugFired = 0
    const dugWatch = makeFakeWatch()
    const dugW = dugWatch(TMP, () => { dugFired += 1 })   // ⚠️ 这一版**故意不过滤**（回调里不判 filename）
    dugW.listener('change', 'timeline.json')
    await sleep(60)
    const dugAfterTimeline = dugFired
    dugW.listener('change', 'catalog.json')
    await sleep(60)
    check('B4 反证：**不过滤文件名**的同款实现 ⇒ 写 catalog.json 也会触发（说明 B3 咬的正是那一张过滤）',
      dugAfterTimeline === 1 && dugFired === 2, `timeline=${dugAfterTimeline} all=${dugFired}`)
    dugW.close()
    // ⚠️ 文件名给不出来（有些平台/某些事件不给）⇒ **也算一次**（宁可多跑一趟去抖后的检测，⛔ 不许漏回档）
    w.listener('change', undefined)
    await sleep(120)
    check('B5 文件名是空 / `undefined` ⇒ **也算一次**（宁可多跑一趟，⛔ 不许漏掉回档）', fired === before + 1, `fired=${fired}`)
    dispose()
    check('B6 `dispose()` 真的**关掉了 watcher**（⛔ 不留野 watcher —— 热重载会重建）', w.closed === true)
    const afterDispose = fired
    w.listener('change', 'timeline.json')
    await sleep(140)
    check('B7 `dispose()` 之后再喂 ⇒ **没有回调**', fired === afterDispose, `fired=${fired}`)
    let dbl = false
    try { dispose(); dispose() } catch { dbl = true }
    check('B8 `dispose()` 调两次不炸（幂等）', dbl === false)

    // ── 盯不住的**失败姿态**（这是本单要如实写进报告的那一条）
    const badLog = { warns: [], warn(m) { badLog.warns.push(String(m)) } }
    const eperm = new Error('EPERM: operation not permitted')
    eperm.code = 'EPERM'
    const empty = fw.watchTimeline('不存在的目录', { watch: () => { throw eperm }, onChange: () => {}, log: badLog })
    check('B9 盯不住（watch 抛 EPERM）⇒ 返回一个**空 dispose**，⛔ 一个字节都不抛', typeof empty === 'function')
    let dbl2 = false
    try { empty(); empty() } catch { dbl2 = true }
    check('B10 空 dispose 也幂等（调两次不炸）', dbl2 === false)
    check('B11 盯不住时**如实 warn 一条**（⛔ 不许静默：要说清"现在只能靠轮末 / 开面板发现"）',
      badLog.warns.length === 1 && badLog.warns[0].includes('只能靠轮末') && badLog.warns[0].includes('EPERM'),
      JSON.stringify(badLog.warns))
    // 真 `fs.watch` 的失败姿态：目录不存在 ⇒ fs.watch 自己就抛（生产口子实测）
    const realLog = { warns: [], warn(m) { realLog.warns.push(String(m)) } }
    const noDir = join(TMP, '真的不存在')
    const emptyReal = fw.watchTimeline(noDir, { watch: fsWatchReal, onChange: () => {}, log: realLog })
    check('B12 真 `fs.watch` 盯**不存在的目录** ⇒ 同样走"空 dispose + 一条如实日志"（日志里有 errno）',
      typeof emptyReal === 'function' && realLog.warns.length === 1 && /ENOENT|EPERM|EACCES/.test(realLog.warns[0]),
      `warns=${JSON.stringify(realLog.warns)}`)
    let dbl3 = false
    try { emptyReal(); emptyReal() } catch { dbl3 = true }
    check('B13 真失败那条路的空 dispose 也幂等', dbl3 === false)

    // 异步 `error` 事件：不接的话在 Node 里就是**未捕获异常**（能把宿主搞挂）
    let crashed = false
    const onUncaught = () => { crashed = true }
    process.once('uncaughtException', onUncaught)
    const errLog = { warns: [], warn(m) { errLog.warns.push(String(m)) } }
    const disposeErr = fw.watchTimeline(TMP, { watch: makeFakeWatch(), onChange: () => {}, log: errLog })
    const we = newestWatcher()
    try { if (typeof we.handlers.error === 'function') we.handlers.error(new Error('watch 挂了')) } catch { crashed = true }
    await sleep(30)
    disposeErr()
    process.removeListener('uncaughtException', onUncaught)
    check('B14 监视器异步 `error` 事件被接住（⛔ 未捕获的 error 会把宿主搞挂）+ 如实 warn 一条',
      crashed === false && errLog.warns.length === 1 && errLog.warns[0].includes('监视器出错'), JSON.stringify(errLog.warns))

    // ★ 真 `fs.watch` 冒烟：生产那条路（真 watcher + 真写文件）在这台机器上真的通
    const smokeDir = join(TMP, 'smoke')
    mkdirSync(smokeDir, { recursive: true })
    let smoked = 0
    const disposeSmoke = fw.watchTimeline(smokeDir, { watch: fsWatchReal, onChange: () => { smoked += 1 }, debounceMs: 40, log })
    writeFileSync(join(smokeDir, 'timeline.json'), '{"head":{}}')
    const okSmoke = await waitFor(() => smoked >= 1, 6000)
    disposeSmoke()
    check('B15 ★ 真 `fs.watch` 冒烟：真写一次 `timeline.json` ⇒ 真的回调了（生产那条路在这台机器上通）',
      okSmoke === true, `smoked=${smoked}`)
    let smokedOther = 0
    const disposeSmoke2 = fw.watchTimeline(smokeDir, { watch: fsWatchReal, onChange: () => { smokedOther += 1 }, debounceMs: 40, log })
    writeFileSync(join(smokeDir, 'catalog.json'), '{"x":1}')
    await sleep(1500)
    disposeSmoke2()
    check('B16 反证（对着 B15）：真 watcher 写**别的文件** ⇒ 一次都没回调', smokedOther === 0, `smokedOther=${smokedOther}`)
  }

  // ═════════════════════════════════════════════════════════════════════════
  sect('C 真 HTTP：连上先 `hello` · 两条连接都收到 · 断开即摘 · 上限 8 · ⛔ 端点不写盘')

  {
    // 先造一个"开 fork"的现场：站到第 3 楼（建立基线）⇒ 退回第 1 楼 ⇒ 用面板那一脚把那条 pending 落到盘上
    writeTimeline(NODES[2])
    await call('POST', '/playthrough/rp-memory/floors/scan', {})
    writeTimeline(NODES[0])
    const scan = await call('POST', '/playthrough/rp-memory/floors/scan', {})
    check('C0 场地就绪：`/floors` 里那条**待处理**已经在（hello 要拿它对齐）',
      scan.data && scan.data.pending !== null && scan.data.pending !== undefined && scan.data.pending.toSeq === 1,
      JSON.stringify(scan.data && scan.data.pending))

    const stampBefore = indexStamp()
    const s1 = await openSse()
    const ct = String(s1.headers.get('content-type'))
    const cc = String(s1.headers.get('cache-control'))
    const conn = String(s1.headers.get('connection')).toLowerCase()
    check('C1 连上 ⇒ 200 + `text/event-stream` + `no-cache` + `x-accel-buffering: no`（connection 给了就得是 keep-alive）',
      s1.status === 200 && ct.includes('text/event-stream') && cc.includes('no-cache')
      && s1.headers.get('x-accel-buffering') === 'no' && (conn === '' || conn.includes('keep-alive')),
      `status=${s1.status} headers=${JSON.stringify(Object.fromEntries(s1.headers.entries()))}`)
    const gotHello = await s1.waitFrames(1)
    check('C2 **第一帧就是 `hello`**（帧格式 `data: <JSON>\\n\\n`，只用默认 message 事件）',
      gotHello && s1.frames[0] && s1.frames[0].type === 'hello', JSON.stringify(s1.frames))
    const view = await floorsView()
    check('C3 `hello` 里的 `pending` 与同一刻 `/floors` 里那条**逐字一致**（⛔ 不许两处各拼一份）',
      JSON.stringify(s1.frames[0].pending) === JSON.stringify(view.pending),
      `hello=${JSON.stringify(s1.frames[0].pending)} floors=${JSON.stringify(view.pending)}`)
    check('C3b `hello` 还带着现状那两样（`head` / `last`，与 `/floors` 同一份拼装）',
      JSON.stringify(s1.frames[0].head) === JSON.stringify(view.head)
      && JSON.stringify(s1.frames[0].last) === JSON.stringify(view.last),
      `head=${JSON.stringify(s1.frames[0].head)} last=${JSON.stringify(s1.frames[0].last)}`)
    check('C4 订阅者数如实：此刻 = 1', __floorSseStats().subscribers === 1, JSON.stringify(__floorSseStats()))

    // ★ 两条连接 ⇒ 喂一次 fs.watch ⇒ **两条都收到**
    const s2 = await openSseTracked()
    const got2Hello = await s2.waitFrames(1)
    check('C5 第二条连接也以 `hello` 开场 · 订阅者 = 2',
      got2Hello && s2.frames[0].type === 'hello' && __floorSseStats().subscribers === 2,
      JSON.stringify(__floorSseStats()))
    // ⛔ 纯连接那一段（连上 / hello / 第二条连接）跑完：清单 sha + mtime + size **都不动**
    //   ⚠️ 判据只圈**端点自己的动作** —— 下面 C6/C9 那两脚是**喂 watcher**（那是检测，本来就该写账），
    //     不在这条判据的范围里（用户口径：这条端点"纯推送、不写任何东西"）。
    const stampPure = indexStamp()
    check('C6 ⛔ 光连上来看（连两条 + 两帧 `hello` + `/floors`）**一个字节都没写**清单（sha + mtime + size 都不动）',
      stampBefore.sha === stampPure.sha && stampBefore.mtime === stampPure.mtime && stampBefore.size === stampPure.size,
      `before=${JSON.stringify(stampBefore)} after=${JSON.stringify(stampPure)}`)
    const n1 = s1.frames.length
    const n2 = s2.frames.length
    writeTimeline(NODES[1])      // 剧情再退一楼（第 3 ⇒ 第 1 ⇒ 第 2 楼）
    const fed = feed('timeline.json')
    const both = await waitFor(() => s1.frames.length > n1 && s2.frames.length > n2, 6000)
    check("C7 fs.watch 那一脚推一次 ⇒ **两条连接都收到** `{type:'fork'}`（⛔ 不是只推第一个）",
      fed >= 1 && both && s1.frames[n1] && s1.frames[n1].type === 'fork' && s2.frames[n2] && s2.frames[n2].type === 'fork',
      `fed=${fed} f1=${JSON.stringify(s1.frames[n1])} f2=${JSON.stringify(s2.frames[n2])}`)
    check('C7b 那一帧的形状 = `{type, pending, at}`（字段名是定死的，客户端按它判）',
      s1.frames[n1] && typeof s1.frames[n1].pending === 'object' && s1.frames[n1].pending !== null
      && typeof s1.frames[n1].at === 'string' && s1.frames[n1].at !== '',
      JSON.stringify(s1.frames[n1]))
    check('C7c 那一帧里的 `pending` 也是从**那一份拼装**里取出来的（与盘上那条逐字一致）',
      JSON.stringify(s1.frames[n1].pending) === JSON.stringify(pendingOnDisk()),
      `frame=${JSON.stringify(s1.frames[n1].pending)} disk=${JSON.stringify(pendingOnDisk())}`)
    // 断开即摘（反证：不摘 ⇒ 台子能在集合里数出"幽灵订阅者"）
    s1.close()
    const removed = await waitFor(() => __floorSseStats().subscribers === 1, 4000)
    check('C8 客户端断开（fetch abort ⇒ 服务端 `close`）⇒ 订阅者集合**摘掉了**（1 条）',
      removed === true, JSON.stringify(__floorSseStats()))
    // 反证（对着 C7）：**只推第一个**的那种实现 ⇒ 关掉第一条之后，剩下的那条再也收不到东西
    const n2b = s2.frames.length
    writeTimeline(NODES[0])
    feed('timeline.json')
    const stillAlive = await waitFor(() => s2.frames.length > n2b, 6000)
    check('C9 反证（对着 C7）：**剩下的那条**照样收到新帧 ⇒ 实现是"推给所有订阅者"，⛔ 不是"只推第一个"',
      stillAlive === true, `frames=${s2.frames.length}（原 ${n2b}）`)
    s2.close()
    const cleared = await waitFor(() => __floorSseStats().subscribers === 0, 4000)
    check('C10 两条都断开 ⇒ 订阅者集合回到 0（⛔ 一条幽灵都不许剩）', cleared === true, JSON.stringify(__floorSseStats()))

    // ★ 上限 8：第 9 条如实 503 + 一句人话（⛔ 不许静默丢弃）
    const stampBeforeCap = indexStamp()
    const many = []
    for (let i = 0; i < 8; i += 1) many.push(await openSse())
    check('C11 挂满 8 条 ⇒ 8 条都进得来（订阅者 = 8）',
      many.every((s) => s.status === 200) && __floorSseStats().subscribers === 8,
      `statuses=${JSON.stringify(many.map((s) => s.status))} subs=${__floorSseStats().subscribers}`)
    const over = await openSse()
    const overBody = String(over.body)
    check('C12 第 9 条 ⇒ **如实 503 + 一句人话**（⛔ 不许静默丢弃）',
      over.status === 503 && overBody.includes('挂满了') && overBody.includes('刷新'),
      `status=${over.status} body=${overBody.slice(0, 160)}`)
    for (const s of many) s.close()
    const backToZero = await waitFor(() => __floorSseStats().subscribers === 0, 4000)
    check('C13 全断开 ⇒ 回到 0', backToZero === true, JSON.stringify(__floorSseStats()))

    // ⛔ 满员那一段（8 连 + 第 9 条被拒 + 全断开）跑完：清单仍然**一个字节都没动**
    const stampAfterCap = indexStamp()
    check('C14 ⛔ 满员那一段（含被拒的第 9 条与全断开）也**一个字节都没写**清单',
      stampBeforeCap.sha === stampAfterCap.sha && stampBeforeCap.mtime === stampAfterCap.mtime
      && stampBeforeCap.size === stampAfterCap.size,
      `before=${JSON.stringify(stampBeforeCap)} after=${JSON.stringify(stampAfterCap)}`)
  }

  // ═════════════════════════════════════════════════════════════════════════
  sect('D 端到端：夹具里改 timeline.json（假 watcher 喂事件）⇒ 订阅者收到 fork 且 /floors 里那条真在')

  {
    reset({ 'notes.md': '# 笔记\nv1\n', 'index.md': '# 索引\nv1\n' })
    writeTimeline(NODES[2])
    await call('POST', '/playthrough/rp-memory/floors/scan', {})   // 建立基线（seen ← 第 3 楼）
    const baseView = await floorsView()
    check('D0 基线：第 3 楼站定（`head.seq = 3`），且**没有**待处理那条',
      baseView !== null && baseView.head && baseView.head.seq === 3 && (baseView.pending === null || baseView.pending === undefined),
      JSON.stringify({ head: baseView && baseView.head, pending: baseView && baseView.pending }))

    const sess = await openSseTracked()
    await sess.waitFrames(1)
    const n0 = sess.frames.length

    // ── 相：剧情**退回去** ⇒ 推一帧 fork，且 `/floors` 里那条 pending 也真的在（两处同源）
    writeTimeline(NODES[0])
    const fedBack = feed('timeline.json')
    const gotFork = await waitFor(() => sess.frames.length > n0, 6000)
    const forkFrame = sess.frames[n0]
    check("D1 夹具改 `timeline.json`（退到第 1 楼）+ 假 watcher 喂事件 ⇒ 订阅者收到 `{type:'fork'}`",
      fedBack >= 1 && gotFork === true && forkFrame !== undefined && forkFrame.type === 'fork',
      `fed=${fedBack} frames=${JSON.stringify(sess.frames.slice(n0))}`)
    const afterView = await floorsView()
    check('D2 那一帧里的 `pending` 与 `/floors` 里那条**同一份**（两处同源：都来自清单里那条待处理）',
      JSON.stringify(forkFrame.pending) === JSON.stringify(afterView.pending)
      && afterView.pending !== null && afterView.pending !== undefined && afterView.pending.toSeq === 1,
      `frame=${JSON.stringify(forkFrame.pending)} floors=${JSON.stringify(afterView.pending)}`)
    check("D3 那一帧说的是\"剧情**刚从**第 3 楼**退到**第 1 楼\"（判据是 `decideFork` —— ⛔ 与档案在哪一楼无关）",
      forkFrame.pending.fromSeq === 3 && forkFrame.pending.toSeq === 1 && forkFrame.pending.why === 'back',
      JSON.stringify(forkFrame.pending))
    check('D4 盘上那条待处理也真的落了（fs.watch 这一脚除了推帧，也真的把账记下来）',
      pendingOnDisk() !== null && pendingOnDisk().toSeq === 1, JSON.stringify(pendingOnDisk()))
    check('D4b ⛔ 那一脚**不动正文**：那 5 份笔记的正文逐字没变（判据：文件内容还是夹具写的那份）',
      readFileSync(join(PT_MEM, 'notes.md'), 'utf8') === '# 笔记\nv1\n'
      && readFileSync(join(PT_MEM, 'index.md'), 'utf8') === '# 索引\nv1\n',
      'notes.md / index.md 被改过了')

    // ── 反证：剧情**往前走** ⇒ **不推**（把"只在 fork.kind === 'fork' 才推"挖掉 ⇒ 本相必红）
    const n1 = sess.frames.length
    writeTimeline(NODES[4])                 // 往前走到第 5 楼（对 seen 来说是 forward）
    feed('timeline.json')
    await sleep(1000)                       // 给足一轮（去抖 300ms + 检测）
    check("D5 改成\"剧情往前走\" ⇒ **不推** fork（`fork.kind === 'forward'` 那一支不进推送）",
      sess.frames.length === n1, `frames=${JSON.stringify(sess.frames.slice(n1))}`)
    // ── 灵敏度自证（对着 D5）：同一条通道紧接着**又**推得出来 ⇒ D5 的安静不是"通道死了"
    writeTimeline(NODES[0])
    feed('timeline.json')
    const gotAgain = await waitFor(() => sess.frames.length > n1, 6000)
    check('D6 灵敏度自证（对着 D5）：紧接着再退一次 ⇒ **又推到一帧** ⇒ D5 的安静是真的安静，不是通道死了',
      gotAgain === true && sess.frames[n1] !== undefined && sess.frames[n1].type === 'fork',
      `frames=${JSON.stringify(sess.frames.slice(n1))}`)

    // ── 反证（对着 D1/D4）：动的是**目录里别的文件** ⇒ 既不推、盘上那条也一个字不改
    const docBefore = JSON.stringify(floorDoc())
    writeFileSync(join(PT, 'catalog.json'), '{"playthroughs":[]}')
    feed('catalog.json')
    await sleep(800)
    check('D7 反证：喂的是**别的文件名**（目录里的 `catalog.json`）⇒ 既不推帧、盘上那条待处理也一个字没改',
      sess.frames.length === n1 + 1 && JSON.stringify(floorDoc()) === docBefore,
      `frames=${sess.frames.length} changed=${JSON.stringify(floorDoc()) !== docBefore}`)
    sess.close()
    await waitFor(() => __floorSseStats().subscribers === 0, 4000)
    // 场地复原（`catalog.json` 被上面那条反证改写过了）
    writeTavern()
  }

  // ═════════════════════════════════════════════════════════════════════════
  sect('E 静态纪律：⛔ 不轮询/不定时器 · ⛔ 端点纯推送不写盘 · ⛔ 不碰 Tavern 一行代码')

  {
    // ★ 2026-09-25：切片前把行尾归一成 `\n` —— 那份文件的**行尾是混的**（有的行 CRLF、有的 LF），
    //   而下面 `fnBody` 靠 `'\n}\n'` 找函数尾 ⇒ 一旦某次编辑把某一段整片变成 CRLF，切片就会一路切到
    //   文件尾（于是"纯只读"那类断言会看到别处的写盘调用、**误报红**）。归一之后与行尾无关。
    const idxSrc = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8').replace(/\r\n/g, '\n')
    const watchSrc = readFileSync(join(ROOT, 'lib', 'floor-watch.js'), 'utf8')
    /** 取一个模块级函数体（从签名到第一个顶格 `}`）——静态核对用。 */
    const fnBody = (s, name) => {
      const i = s.indexOf('function ' + name + '(')
      if (i < 0) return ''
      const j = s.indexOf('\n}\n', i)
      return j < 0 ? s.slice(i) : s.slice(i, j)
    }
    const endpointBody = fnBody(idxSrc, 'handleRpMemoryFloorsEvents')
    const kickBody = fnBody(idxSrc, 'floorWatchKick')
    check('E0 找到那两处实现（切片有效）', endpointBody.length > 200 && kickBody.length > 200,
      `endpoint=${endpointBody.length} kick=${kickBody.length}`)
    check('E1 帧格式：`data: ` + JSON.stringify + `\\n\\n` 两种都在（hello 与推送帧）',
      endpointBody.includes("res.write('data: ' + JSON.stringify(") && endpointBody.includes("'\\n\\n')"))
    check('E2 心跳是**注释帧**（`:\\n\\n`）且间隔 25 秒（⛔ 不拿 JSON 帧刷屏、⛔ 不是轮询）',
      /FLOOR_SSE_HEARTBEAT_MS = 25 \* 1000/.test(idxSrc) && idxSrc.includes("res.write(':\\n\\n')"),
      `心跳间隔=${/FLOOR_SSE_HEARTBEAT_MS = (\S+)/.exec(idxSrc)?.[1]} 注释帧=${idxSrc.includes("res.write(':\\n\\n')")}`)
    check('E3 订阅者上限默认 8，超了**如实 503 + 一句人话**（⛔ 不许静默丢弃）',
      /FLOOR_SSE_MAX_SUBSCRIBERS = 8/.test(idxSrc) && endpointBody.includes('503') && endpointBody.includes('挂满了'))
    check("E4 断开即摘：`res.on('close')` ⇒ 从集合里删（⛔ 不许越挂越多）",
      endpointBody.includes("res.on('close', onClose)") && endpointBody.includes('hub.remove(sub)'))
    check('E5 随卸载全关 + 清空集合（热重载不留悬挂连接、不留幽灵订阅者）',
      /dispose\(\) \{[\s\S]{0,400}subs\.clear\(\)/.test(idxSrc) && idxSrc.includes('disposeSse()'))
    check('E6 watch 由**调用方注入**（生产 = node:fs 的 watch；台子才能用假 watcher 喂事件）',
      watchSrc.includes("typeof o.watch === 'function' ? o.watch : null") && idxSrc.includes('watch: floorWatchImpl'))
    check('E7 ⛔ 即时检测那条路上**没有轮询**：floor-watch.js 里只有去抖那一只 setTimeout，没有 setInterval',
      watchSrc.includes('setTimeout(') === true && watchSrc.includes('setInterval(') === false)
    check('E8 ⛔ 那条端点**纯推送不写盘**：处理函数体里没有任何写盘动作',
      /writeFileSync|mkdirSync|renameSync|appendFileSync|unlinkSync/.test(endpointBody) === false)
    check('E9 ⛔ 不碰上游 Tavern 一行代码：没有往它的工作区写的调用（只读它写的那个文件名）',
      /(writeFileSync|appendFileSync|unlinkSync|mkdirSync|renameSync)\([^)]*rootPath/.test(idxSrc) === false)
    check('E10 接线随卸载拆掉（`scope.effect` 的 dispose 里调 `disposeFloorWatch()` —— 热重载不留野 watcher）',
      idxSrc.includes("'floor-watch.dispose()'") && idxSrc.includes('disposeFloorWatch()'))
    check('E11 盯的是**面板绑定那一个**周目（`floorHomeBound()`，与 `/floors` 同源；⛔ 本单不做多周目同时盯）',
      /function ensureFloorWatch\(log\) \{[\s\S]{0,600}floorHomeBound\(\)/.test(idxSrc))
    check('E12 模块缺席照旧安全降级：floor-watch.js 加载失败只是**不接线**（warn 一条 + 退成"轮末/开面板才发现"）',
      idxSrc.includes('floorWatchLoadError') && idxSrc.includes('即时检测（盯时间线）未接线'))
    check('E13 ⛔ 回档那一脚不写正文：`floorWatchKick` 只调 `floorSyncAt` 与 `floorsView`（没有恢复/写正文那一族）',
      kickBody.includes("floorSyncAt(home, 'watch', log)") && kickBody.includes('floorsView(home)')
      && /restoreFloor|runRestore|writeRestoredFile/.test(kickBody) === false,
      kickBody.slice(0, 200))
  }

  // ═════════════════════════════════════════════════════════════════════════
  sect('F 收尾：订阅者全清 · 野 watcher 归零')

  check('F1 台子跑完：SSE 订阅者 = 0（⛔ 不留幽灵订阅者）', __floorSseStats().subscribers === 0, JSON.stringify(__floorSseStats()))
  check('F2 生产那条 watcher 还活着，且**整段跑下来就一条**（幂等：连连接、连喂事件都不重建）',
    liveWatchers().length === 1 && liveWatchers()[0].dir === PT,
    JSON.stringify(watchers.map((w) => ({ dir: w.dir, closed: w.closed }))))
} finally {
  for (const s of opened) {
    try { s.close() } catch { /* 已经断了 */ }
  }
  try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections() } catch { /* 老 node */ }
  await new Promise((r) => server.close(r))
  // ★ 2026-09-25（收尾纪律）：这一脚与 `_selftest-floor-snapshot.mjs` 同款 —— 生产那条 watcher 拆掉
  //   （本台子给它的是**假件**、不吊事件循环，但照着"⛔ 不留野 watcher"那条纪律，收尾一律拆干净；
  //   `dispose()` 幂等，调两次不炸）。F2 那两条断言在这之前已经跑完了。
  try { __disposeFloorWatch() } catch { /* 拆不掉也只能算了 */ }
  rmSync(HOME, { recursive: true, force: true })
  rmSync(WS, { recursive: true, force: true })
  rmSync(TMP, { recursive: true, force: true })
}

console.log(`\n== 总结：${pass} 通过 / ${failed} 失败 ==`)
if (failed > 0) process.exit(1)
