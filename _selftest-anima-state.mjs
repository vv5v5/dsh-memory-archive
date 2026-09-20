/**
 * _selftest-anima-state.mjs —— 「后台收纳状态」只读出口（GET /anima/ingest-state）的宿主半侧自检
 *
 * 它读 dsh-anima-rag 落的 `<DSH_HOME>/dsh-anima-rag/ingest-state.json`（两个插件之间走文件交接，
 * 与 auto-collect.json 同款）。面板的 shell.overlay 提示条靠它显示"正在收纳当前会话"。
 *
 * ★ 不写用户家里的 ~/.dsh：DSH_HOME 指到 <repo>/_selftest-home-anima，测完删掉。
 * ★ 不发真网络请求：只打本进程起的 http 服务。
 */
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { apply } from './lib/index.js'

const HOME = resolve('_selftest-home-anima')
const PREFIX = '/dsh-memory-archive/api'
const STATE_FILE = join(HOME, 'dsh-anima-rag', 'ingest-state.json')

process.env.DSH_HOME = HOME
rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, 'dsh-memory-archive'), { recursive: true })
writeFileSync(join(HOME, 'dsh-memory-archive', 'config.json'), JSON.stringify({ schemaVersion: 1 }))

let pass = 0
let fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`PASS ${name}`) } else {
    fail += 1
    console.log(`FAIL ${name}${extra === undefined ? '' : '  ← ' + String(extra)}`)
  }
}

const routes = []
const webServer = { register: (route) => { routes.push(route); return () => {} } }
const ctx = {
  effect: (fn) => fn(),
  inject: (_names, cb) => cb(ctx),
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
const get = async () => {
  const res = await fetch(base + '/anima/ingest-state')
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch { /* 留 null */ }
  return { status: res.status, data, text }
}

try {
  // ① 文件还没有 ⇒ ok + state:null（正常态，不是错误）
  {
    const r = await get()
    check('① 状态文件不存在 ⇒ HTTP 200 + ok:true + state:null（提示条据此不显示）',
      r.status === 200 && r.data?.ok === true && r.data?.state === null, r.text.slice(0, 200))
  }
  // ② 收纳中 ⇒ running:true + 白名单字段
  {
    mkdirSync(join(HOME, 'dsh-anima-rag'), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify({
      running: true, startedAt: 111, sessionId: 'session-x', playthroughId: 'playthrough-y',
      characterId: 'char-z', pending: 7, dir: 'D:/SECRET/PATH', 乱塞: 'whatever',
    }))
    const r = await get()
    const s = r.data?.state
    check('② 收纳中：running=true 且 startedAt/pending/playthroughId 如实投影',
      r.data?.ok === true && s?.running === true && s?.startedAt === 111 && s?.pending === 7 && s?.playthroughId === 'playthrough-y',
      JSON.stringify(s))
    check('② ★反证：只投影白名单字段 —— 原始文件里的 `dir`/`乱塞` 一个字都不许进响应（⛔ 不吐路径）',
      r.text.includes('SECRET') === false && r.text.includes('乱塞') === false && s?.dir === undefined, r.text.slice(0, 200))
  }
  // ③ 跑完 ⇒ running:false + 结果字段
  {
    writeFileSync(STATE_FILE, JSON.stringify({ running: false, finishedAt: 222, inserted: 3, failed: 1, skipped: null }))
    const r = await get()
    const s = r.data?.state
    check('③ 跑完：running=false、finishedAt/inserted/failed 如实给',
      s?.running === false && s?.finishedAt === 222 && s?.inserted === 3 && s?.failed === 1, JSON.stringify(s))
  }
  // ④ ★反证：字段类型不对 ⇒ 一律 null/空串（⛔ 不把 "true"/1 当布尔、不猜）
  {
    writeFileSync(STATE_FILE, JSON.stringify({ running: 'true', startedAt: '111', pending: '7', error: 42 }))
    const r = await get()
    const s = r.data?.state
    check('④ ★反证：坏类型不猜（running 只认严格 true；数字位给 null；error 给 null）',
      s?.running === false && s?.startedAt === null && s?.pending === null && s?.error === null, JSON.stringify(s))
  }
  // ⑤ ★反证：文件不是 JSON ⇒ 如实报读失败（⛔ 不假装"没有状态"）
  {
    writeFileSync(STATE_FILE, '{not json')
    const r = await get()
    check('⑤ ★反证：文件坏掉 ⇒ ok:false + ANIMA_STATE_READ_FAILED（不假装成空态）',
      r.data?.ok === false && r.data?.error?.code === 'ANIMA_STATE_READ_FAILED', r.text.slice(0, 200))
  }
} finally {
  await new Promise((r) => server.close(r))
  rmSync(HOME, { recursive: true, force: true })
}

console.log(`\n── ${pass} 通过 / ${fail} 失败 ──`)
process.exitCode = fail === 0 ? 0 : 1
