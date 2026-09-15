// 自检台 · 常驻会话 + 预热缓存（20260915 查看器提速的服务端半边）
//
// 行为级、**不需要宿主**：临时目录当 sessionsRoot/storageDir；解析栈故意指向不存在的 runtime
// ⇒ 预热必然失败，这正好用来证明「失败被如实记录、不抛、且**读路径绝不解析**」。
// 反证是真·变体测试：把 lib/prompt-viewer.js 按锚点做文本替换、写成临时模块再 import。
//
// 隐私：只用假 id / 空文件，⛔ 不碰任何真会话。
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import http from 'node:http'

const HERE = dirname(fileURLToPath(import.meta.url))
const PV_PATH = join(HERE, 'lib', 'prompt-viewer.js')

let pass = 0
let fail = 0
function p(id, title, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  PASS ${id} ${title}${extra ? ' —— ' + extra : ''}`)
  } else {
    fail++
    console.log(`  FAIL ${id} ${title}${extra ? ' —— ' + extra : ''}`)
  }
}

// ---- 临时台面 --------------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), 'dma-resident-'))
const sessionsRoot = join(root, 'sessions')
const storageDir = join(root, 'storage')
function makeSession(ws, id) {
  const dir = join(sessionsRoot, ws, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.jsonl.zstd'), Buffer.alloc(8))
}
mkdirSync(storageDir, { recursive: true })
makeSession('ws-a', 'sess-aaaa')
makeSession('ws-a', 'sess-bbbb')
makeSession('ws-b', 'sess-cccc')

const BOGUS_RUNTIME = join(root, 'no-such-runtime', 'node_modules', '@deepseek-ai', 'dsh')

/** 变体加载：对 lib/prompt-viewer.js 做文本替换 → 临时模块 → import（文件名唯一，避开 ESM 缓存）。
 *  ★ 变体**必须写在 lib/ 里**：prompt-viewer.js 有相对 import（`./mem-budget.js`），
 *   写到系统临时目录会让那条相对路径解析不到（实测 ERR_MODULE_NOT_FOUND）。
 *  ★ import 完立刻删掉：ESM 已缓存模块，删文件不影响本次运行，也不留垃圾。 */
let variantSeq = 0
async function loadVariant(replacements) {
  let text = readFileSync(PV_PATH, 'utf8')
  for (const [from, to] of replacements) {
    if (!text.includes(from)) throw new Error(`变体锚点找不到（自检台要维护）：${from.slice(0, 60)}`)
    text = text.replace(from, to)
  }
  const file = join(HERE, 'lib', `_pv-variant-${++variantSeq}.mjs`)
  writeFileSync(file, text, 'utf8')
  try {
    return await import(pathToFileURL(file).href)
  } finally {
    rmSync(file, { force: true })
  }
}

const base = await import(pathToFileURL(PV_PATH).href)

function newSource(overrides = {}) {
  return base.createSessionSource({
    sessionsRoot,
    storageDir,
    runtimeDsh: BOGUS_RUNTIME,
    residentRefreshMs: 0,       // 自检里不起定时器
    ...overrides,
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 1) 配置解析 ----------------------------------------------------------
console.log('== 1) 配置 ==')
const cfg = base.resolveConfig({ storageDir, sessionsRoot })
p('C1', 'residentFile 落在传入的 storageDir 下', cfg.residentFile === join(storageDir, 'resident.json'), cfg.residentFile)
const cfgDefault = base.resolveConfig({ sessionsRoot })
p('C2', '不传 storageDir ⇒ 回落 <DSH_HOME>/dsh-memory-archive/resident.json',
  cfgDefault.residentFile.endsWith(join('dsh-memory-archive', 'resident.json')), cfgDefault.residentFile)
p('C3', 'residentMax / residentRefreshMs 有默认值且可被夹', cfg.residentMax === 20 && cfg.residentRefreshMs === 60000,
  `max=${cfg.residentMax} refresh=${cfg.residentRefreshMs}`)

// ---- 2) 读路径绝不解析、绝不建文件 ----------------------------------------
console.log('== 2) 读路径（GET 侧）==')
const s1 = newSource()
const r0 = s1.getResident()
p('R1', '空常驻集 ⇒ ok + sessions:[]', r0.ok === true && Array.isArray(r0.sessions) && r0.sessions.length === 0)
p('R2', '★ 读一次**不建**常驻集文件（读路径是纯读）', !existsSync(join(storageDir, 'resident.json')))
p('R3', '读响应带 refreshMs/max/stats（面板能显示"多久刷一次"）',
  r0.refreshMs === 0 && r0.max === 20 && typeof r0.stats?.warmed === 'number')

// ---- 3) 改集：去重 + 上限 + 落盘 -----------------------------------------
console.log('== 3) 改集 ==')
const s2 = newSource()
const set1 = s2.setResident(['sess-aaaa', 'sess-bbbb', 'sess-aaaa', '', '  '])
p('S1', '去重 + 丢空串', set1.ids.join(',') === 'sess-aaaa,sess-bbbb', set1.ids.join(','))
p('S2', '未预热的都在 pending 里', set1.pending.length === 2)
p('S3', '改集后**落了盘**且形状是 {version,ids,rows}',
  (() => { try { const j = JSON.parse(readFileSync(join(storageDir, 'resident.json'), 'utf8')); return j.version === 1 && Array.isArray(j.ids) && j.ids.length === 2 && typeof j.rows === 'object' } catch { return false } })())
const many = Array.from({ length: 25 }, (_, i) => `sess-x${String(i).padStart(2, '0')}`)
const set2 = s2.setResident(many)
p('S4', '★ 上限 residentMax 生效（25 进 ⇒ 只留 20）', set2.ids.length === 20, `len=${set2.ids.length}`)
const set3 = s2.setResident(['sess-cccc'])
p('S5', '改小之后旧投影/待办不残留', set3.ids.join(',') === 'sess-cccc' && set3.queued.filter((x) => x !== 'sess-cccc').length === 0)

// ---- 4) 预热失败必须如实记录、不抛 ---------------------------------------
console.log('== 4) 预热（runtime 故意不可用）==')
const s3 = newSource()
s3.setResident(['sess-aaaa'])
await sleep(400)
const afterWarm = s3.getResident()
const row = afterWarm.sessions[0]
p('W1', '★ 预热失败 ⇒ requests=-2（失败哨兵）且 readError 带原因，**不是** 0/-1 冒充',
  row.requests === -2 && row.readError !== null, `requests=${row.requests}`)
p('W2', '失败被计数（stats.failed>0），且**不抛**（走到这里就说明没抛）', afterWarm.stats.failed > 0, JSON.stringify(afterWarm.stats))
p('W3', '失败后仍不阻塞读：再读一次依旧 ok 且返回该行', s3.getResident().ok === true)
p('W4', '落盘里也带着这次（预热结果会持久化）',
  JSON.parse(readFileSync(join(storageDir, 'resident.json'), 'utf8')).rows['sess-aaaa'] !== undefined)

// ---- 5) 坏文件：当空集、不抛、不覆盖 --------------------------------------
console.log('== 5) 坏常驻集文件 ==')
const badDir = join(root, 'storage-bad')
mkdirSync(badDir, { recursive: true })
writeFileSync(join(badDir, 'resident.json'), '{ 这不是 JSON', 'utf8')
const s4 = base.createSessionSource({ sessionsRoot, storageDir: badDir, runtimeDsh: BOGUS_RUNTIME, residentRefreshMs: 0 })
let badThrew = false
let badResident = null
try { badResident = s4.getResident() } catch { badThrew = true }
p('B1', '★ 坏文件 ⇒ 当空集、**不抛**', badThrew === false && badResident?.ids.length === 0)
p('B2', '坏文件**不被覆盖**（读路径不写盘）', readFileSync(join(badDir, 'resident.json'), 'utf8') === '{ 这不是 JSON')

// ---- 6) 反证：真·变体测试 -------------------------------------------------
console.log('== 6) 反证（变体必须红）==')

// 反证一：把「上限生效」那行改坏 ⇒ S4 变红
{
  const variant = await loadVariant([['if (clean.length >= cfg.residentMax) break', 'if (false) break']])
  const sv = variant.createSessionSource({ sessionsRoot, storageDir: join(root, 'storage-v1'), runtimeDsh: BOGUS_RUNTIME, residentRefreshMs: 0 })
  const out = sv.setResident(many)
  p('M-S4', '反证：去掉上限 ⇒ 25 个全留住（S4 会红）', out.ids.length === 25, `len=${out.ids.length}`)
}

// 反证二：把坏文件的 catch 改成 rethrow ⇒ B1 变红（抛出来）
{
  const variant = await loadVariant([[`      if (error?.code !== 'ENOENT') {
        console.warn(\`[dsh-memory-archive] 常驻集文件读不了（当空集，不覆盖）：\${error?.message || error}\`)
      }`, '      throw error']])
  const sv = variant.createSessionSource({ sessionsRoot, storageDir: badDir, runtimeDsh: BOGUS_RUNTIME, residentRefreshMs: 0 })
  let threw = false
  try { sv.getResident() } catch { threw = true }
  p('M-B1', '反证：坏文件改为抛出 ⇒ 读路径炸掉（B1 会红）', threw === true)
}

// ---- 7) HTTP 端点：读路径绝不触发解析 ------------------------------------
console.log('== 7) HTTP 端点 ==')
{
  const calls = { getResident: 0, setResident: [], resolveSessions: 0, listSessions: 0 }
  const fakeSource = {
    scanIndex: () => [],
    listSessions: async () => { calls.listSessions++; return [] },
    resolveSessions: async (ids) => { calls.resolveSessions++; return ids.map((id) => ({ id, title: '', requests: 0, readError: null })) },
    sessionDetail: async () => null,
    forget: () => {},
    stop: async () => {},
    getResident: () => {
      calls.getResident++
      return { ok: true, ids: ['sess-aaaa'], sessions: [{ id: 'sess-aaaa', requests: 3, title: 'T', readError: null }], pending: [], queued: [], stats: {}, lastWarmAt: null, lastRefreshAt: null, refreshMs: 60000, max: 20 }
    },
    setResident: (ids) => { calls.setResident.push(ids); return { ok: true, ids, sessions: [], pending: [], queued: [], stats: {}, refreshMs: 60000, max: 20 } },
  }
  const handler = base.createHandler({ webPath: '/dsh-memory-archive/prompt' }, fakeSource)
  const server = http.createServer((req, res) => { void handler(req, res) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const baseUrl = `http://127.0.0.1:${port}/dsh-memory-archive/prompt`
  // ★ 用 http.request({agent:false}) 而不是 fetch：Node 24 + Windows 下用 fetch 会在**退出时**
  //   撞 libuv 断言（UV_HANDLE_CLOSING）⇒ 断言全绿却 exit≠0。这个坑本项目踩过两次。
  const call = (method, path, payload) => new Promise((resolveCall) => {
    const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload), 'utf8')
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/dsh-memory-archive/prompt' + path,
      method,
      agent: false,
      headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { text += c })
      res.on('end', () => {
        let body = null
        try { body = JSON.parse(text) } catch {}
        resolveCall({ status: res.statusCode, body })
      })
    })
    req.on('error', (error) => resolveCall({ status: 0, body: { ok: false, error: String(error?.message || error) } }))
    if (data) req.write(data)
    req.end()
  })
  const get = (path) => call('GET', path)
  const post = (path, payload) => call('POST', path, payload)
  void baseUrl

  const g = await get('/api/resident')
  p('H1', 'GET /api/resident ⇒ 200 + 常驻行', g.status === 200 && g.body.ok === true && g.body.sessions.length === 1)
  p('H2', '★ GET 常驻**没有**触发任何解析（resolveSessions 调用数 = 0）', calls.resolveSessions === 0, `resolve=${calls.resolveSessions}`)
  p('H3', 'GET 也不去扫全量列表（listSessions 调用数 = 0）', calls.listSessions === 0, `list=${calls.listSessions}`)
  p('H4', '响应带归档位信封（与 /api/sessions 同口径）', g.body.archive && typeof g.body.archive.known === 'boolean')

  const po = await post('/api/resident', { ids: ['sess-cccc'] })
  p('H5', 'POST /api/resident ⇒ 200 且入参被转交 setResident', po.status === 200 && calls.setResident.length === 1 && calls.setResident[0].join(',') === 'sess-cccc')

  const bad = await post('/api/resident', { ids: 'not-an-array' })
  p('H6', 'POST 非法 ids（字符串）⇒ 当作空集，**不抛**', bad.status === 200 && calls.setResident[1].length === 0)

  const stillWorks = await get('/api/sessions')
  p('H7', '既有的 /api/sessions 仍可用（全部会话那条路没被砍）', stillWorks.status === 200 && stillWorks.body.ok === true && calls.listSessions === 1)

  server.close()
}

// ---- 汇总 -----------------------------------------------------------------
console.log(`\n—— 汇总 ——\n  PASS ${pass} / FAIL ${fail}`)
rmSync(root, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
