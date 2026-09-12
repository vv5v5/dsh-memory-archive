/**
 * _selftest-host-v5-mem.mjs —— P0 内存修复后的宿主半侧回归自检。
 * 用假 ctx 真调 apply()：断言仍然【恰好 2 条路由】且 path 不变（注册逻辑没被改坏），
 * 并各真打一次 GET /health 证明两条 handler 活着。
 * ★ DSH_HOME 指向仓库内临时目录，绝不碰 ~/.dsh；测完即删。
 */
import http from 'node:http'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(fileURLToPath(import.meta.url))
const home = join(repo, '_selftest-home-v5')

let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`PASS ${name}`)
  else {
    failures++
    console.log(`FAIL ${name}${detail ? ' —— ' + detail : ''}`)
  }
}

// ---- 0) 隔离 DSH_HOME（必须在 import lib/index.js 之前）----
rmSync(home, { recursive: true, force: true })
mkdirSync(join(home, 'sessions'), { recursive: true })
process.env.DSH_HOME = home
check('DSH_HOME 指向仓库内临时目录', resolve(home).startsWith(resolve(repo)), home)
check('DSH_HOME 不在用户家目录', !resolve(home).startsWith(resolve(homedir())))

const { apply } = await import('./lib/index.js')

// ---- 1) 假 ctx 真跑 apply()：恰好 2 条路由、path 不变 ----
const routes = []
const logs = []
const fakeWebServer = {
  register(route) {
    routes.push(route)
    return () => {
      const i = routes.indexOf(route)
      if (i >= 0) routes.splice(i, 1)
    }
  },
}
const fakeEffect = (fn) => fn()
const fakeCtx = {
  get(name) {
    return name === 'webServer' ? fakeWebServer : undefined
  },
  inject(_deps, cb) {
    cb({ webServer: fakeWebServer, effect: fakeEffect })
  },
  effect: fakeEffect,
  logger: {
    info: (m) => logs.push(['info', String(m)]),
    warn: (m) => logs.push(['warn', String(m)]),
    error: (m) => logs.push(['error', String(m)]),
  },
}

try {
  apply(fakeCtx)
  check('apply(fakeCtx) 不抛', true)
} catch (e) {
  check('apply(fakeCtx) 不抛', false, String(e))
}

check('同步断言：恰好注册 2 条路由', routes.length === 2, `实际 ${routes.length}；日志：${JSON.stringify(logs.filter(([l]) => l !== 'info'))}`)
check(
  '路由1 = prefix /dsh-memory-archive/api',
  routes[0]?.kind === 'prefix' && routes[0]?.path === '/dsh-memory-archive/api',
  JSON.stringify(routes[0]?.path),
)
check(
  '路由2 = prefix /dsh-memory-archive/prompt',
  routes[1]?.kind === 'prefix' && routes[1]?.path === '/dsh-memory-archive/prompt',
  JSON.stringify(routes[1]?.path),
)
check(
  '两条 handler 都是函数',
  typeof routes[0]?.handler === 'function' && typeof routes[1]?.handler === 'function',
)

// ---- 2) 服务缺失仍可用：ctx.get 全空 ⇒ apply 不抛 ----
try {
  apply({ get: () => undefined, logger: fakeCtx.logger })
  check('ctx.get(webServer)=undefined 时 apply 不抛', true)
} catch (e) {
  check('ctx.get(webServer)=undefined 时 apply 不抛', false, String(e))
}

// ---- 3) 两条路由各真打一次 /health（临时 node:http 服务器）----
if (routes.length === 2) {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://t').pathname
    if (p.startsWith('/dsh-memory-archive/prompt')) return routes[1].handler(req, res)
    return routes[0].handler(req, res)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const request = (path) =>
    new Promise((resolveP, rejectP) => {
      http
        .get({ host: '127.0.0.1', port, path }, (rs) => {
          const chunks = []
          rs.on('data', (c) => chunks.push(c))
          rs.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            let json = null
            try {
              json = JSON.parse(text)
            } catch {}
            resolveP({ status: rs.statusCode, json, text })
          })
        })
        .on('error', rejectP)
    })
  try {
    const r1 = await request('/dsh-memory-archive/api/health')
    check('GET /api/health → 200 ok:true（契约未变）', r1.status === 200 && r1.json?.ok === true, `${r1.status} ${r1.text.slice(0, 120)}`)
    const r2 = await request('/dsh-memory-archive/prompt/health')
    check('GET /prompt/health → 200 ok:true（契约未变）', r2.status === 200 && r2.json?.ok === true, `${r2.status} ${r2.text.slice(0, 120)}`)
    const r3 = await request('/dsh-memory-archive/api/unknown-path')
    check('GET /api/未知路径 → 404 NOT_FOUND（降级语义未变）', r3.status === 404 && r3.json?.error?.code === 'NOT_FOUND', `${r3.status}`)
  } finally {
    server.closeAllConnections?.()
    await Promise.race([new Promise((r) => server.close(r)), new Promise((r) => setTimeout(r, 1500))])
    rmSync(home, { recursive: true, force: true })
  }
}

check('临时 DSH_HOME 已删除', !existsSync(home))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
