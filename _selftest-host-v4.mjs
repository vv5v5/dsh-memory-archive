/**
 * _selftest-host-v4.mjs —— 记忆库 v4 宿主半侧自检（真跑 apply + 真打 HTTP）。
 *
 * ★ DSH_HOME 指向仓库内临时目录 _selftest-home-v4（测完即删），绝不写 ~/.dsh。
 * ★ 只访问本进程起的 127.0.0.1 临时服务器（/api/health 内部的 tavern 探活也会打到
 *   这台服务器上，属回环请求），不发任何外网请求。
 * ★ 第二条路由必须【同步】注册：apply() 返回时立即断言恰好 2 条（不允许轮询等待 ——
 *   ctx.effect 离开 apply 调用栈后挂不上 fiber，晚注册会静默丢失/留野路由）。
 * ★ 降级分支实证：把 lib/index.js 复制到没有 prompt-viewer.js 的临时目录，
 *   模块顶层 await import 失败 ⇒ factory=null ⇒ apply 只同步注册 1 条 + log.warn。
 */
import http from 'node:http'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = dirname(fileURLToPath(import.meta.url))
const home = join(repo, '_selftest-home-v4')

let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`PASS ${name}`)
  else {
    failures++
    console.log(`FAIL ${name}${detail ? ' —— ' + detail : ''}`)
  }
}

// ---- 0) 隔离的 DSH_HOME（必须在 import lib/index.js 之前设好）----
rmSync(home, { recursive: true, force: true })
mkdirSync(join(home, 'sessions'), { recursive: true })
process.env.DSH_HOME = home
check('DSH_HOME 指向仓库内临时目录', resolve(home).startsWith(resolve(repo)), home)
check('DSH_HOME 不在用户家目录', !resolve(home).startsWith(resolve(homedir())))

const { apply } = await import('./lib/index.js')

// ---- 1) 假 ctx 真跑 apply()：恰好 2 条路由 ----
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

// ★ 同步断言：两条路由必须在 apply() 返回时就已经注册好（不允许「晚一步注册」——
//   ctx.effect 必须在 apply 调用栈内执行；此处故意不轮询、不等待）。
check('同步断言：恰好注册 2 条路由', routes.length === 2, `实际 ${routes.length}；warn/error 日志：${JSON.stringify(logs.filter(([l]) => l !== 'info'))}`)
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

// ---- 2) 降级路径：ctx.get('webServer') 为 undefined 时 apply() 不抛 ----
try {
  apply({ get: () => undefined, logger: fakeCtx.logger })
  check('ctx.get(webServer)=undefined 时 apply 不抛', true)
} catch (e) {
  check('ctx.get(webServer)=undefined 时 apply 不抛', false, String(e))
}

// ---- 3) HTTP 真跑：node:http 临时服务器挂两条 handler ----
if (routes.length !== 2) {
  check('HTTP 阶段（需要 2 条路由）', false, '路由数不足，跳过 HTTP 真跑')
} else {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://t').pathname
    if (p === '/dsh-memory-archive/prompt' || p.startsWith('/dsh-memory-archive/prompt/')) {
      return routes[1].handler(req, res)
    }
    return routes[0].handler(req, res)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  function request(method, path, body) {
    return new Promise((resolveP, rejectP) => {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
      const rq = http.request(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
        },
        (rs) => {
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
        },
      )
      rq.on('error', rejectP)
      if (data) rq.write(data)
      rq.end()
    })
  }

  try {
    let r = await request('GET', '/dsh-memory-archive/api/health')
    check(
      'GET /api/health → 200 ok:true',
      r.status === 200 && r.json?.ok === true,
      `${r.status} ${r.text.slice(0, 140)}`,
    )

    r = await request('GET', '/dsh-memory-archive/prompt/health')
    check(
      'GET /prompt/health → 200 ok:true',
      r.status === 200 && r.json?.ok === true,
      `${r.status} ${r.text.slice(0, 140)}`,
    )

    r = await request('GET', '/dsh-memory-archive/api/templates')
    check('GET /api/templates → 200 ok:true', r.status === 200 && r.json?.ok === true, `${r.status}`)
    check(
      'compaction.builtin 含 anima 原文标记「# Summarization Guidelines」',
      typeof r.json?.templates?.compaction?.builtin === 'string' &&
        r.json.templates.compaction.builtin.includes('# Summarization Guidelines'),
    )
    check(
      'compaction.builtin 是一份「留空破限头」的模板（不含 anima 破限原文）',
      typeof r.json?.templates?.compaction?.builtin === 'string' &&
        !r.json.templates.compaction.builtin.includes('It is now 2055'),
    )
    check(
      'templates.compactionJailbreak 默认空、custom:false（玩家自己填，我们不内置）',
      r.json?.templates?.compactionJailbreak?.current === '' &&
        r.json.templates.compactionJailbreak.custom === false,
      JSON.stringify(r.json?.templates?.compactionJailbreak),
    )
    check(
      'placeholder.builtin 含 {from}',
      typeof r.json?.templates?.placeholder?.builtin === 'string' &&
        r.json.templates.placeholder.builtin.includes('{from}'),
    )
    check(
      'reference.officialPreamble 非空',
      typeof r.json?.reference?.officialPreamble === 'string' &&
        r.json.reference.officialPreamble.length > 0,
    )
    const builtinZh = r.json?.templates?.compaction?.builtin ?? ''

    r = await request('PUT', '/dsh-memory-archive/api/templates', { compaction: 'X' })
    check(
      'PUT {"compaction":"X"} → 200、custom:true、current==="X"',
      r.status === 200 &&
        r.json?.templates?.compaction?.custom === true &&
        r.json?.templates?.compaction?.current === 'X',
      `${r.status} ${r.text.slice(0, 160)}`,
    )

    r = await request('PUT', '/dsh-memory-archive/api/templates', { compaction: null })
    check(
      'PUT {"compaction":null} → custom:false、current===builtin',
      r.status === 200 &&
        r.json?.templates?.compaction?.custom === false &&
        r.json?.templates?.compaction?.current === builtinZh,
      `${r.status}`,
    )

    r = await request('PUT', '/dsh-memory-archive/api/templates', { compaction: 123 })
    check(
      'PUT {"compaction":123} → 400 CONFIG_INVALID',
      r.status === 400 && r.json?.error?.code === 'CONFIG_INVALID',
      `${r.status} ${r.text.slice(0, 140)}`,
    )
  } finally {
    server.closeAllConnections?.()
    await Promise.race([
      new Promise((r) => server.close(r)),
      new Promise((r) => setTimeout(r, 1500)),
    ])
    rmSync(home, { recursive: true, force: true })
  }
}

check('临时 DSH_HOME 已删除', !existsSync(home))

// ---- 4) 降级分支实证：把 lib/index.js 复制到一个没有 prompt-viewer.js 的临时目录 ——
//         模块顶层 await import('./prompt-viewer.js') 必然失败 ⇒ 走 catch ⇒
//         promptViewerFactory=null ⇒ apply() 只同步注册 1 条路由并 log.warn。
//         这证明降级语义是真的可走通，不是注释说说。
const degradeDir = join(repo, '_selftest-degrade-v4')
try {
  rmSync(degradeDir, { recursive: true, force: true })
  mkdirSync(degradeDir, { recursive: true })
  copyFileSync(join(repo, 'lib', 'index.js'), join(degradeDir, 'index.js'))
  const degradeMod = await import(pathToFileURL(join(degradeDir, 'index.js')).href)
  const degradeRoutes = []
  const degradeLogs = []
  const degradeWs = {
    register(route) {
      degradeRoutes.push(route)
      return () => {}
    },
  }
  const degradeCtx = {
    get: (n) => (n === 'webServer' ? degradeWs : undefined),
    inject: (_deps, cb) => cb({ webServer: degradeWs, effect: (fn) => fn() }),
    effect: (fn) => fn(),
    logger: {
      info: (m) => degradeLogs.push(['info', String(m)]),
      warn: (m) => degradeLogs.push(['warn', String(m)]),
      error: (m) => degradeLogs.push(['error', String(m)]),
    },
  }
  try {
    degradeMod.apply(degradeCtx)
    check('降级实证：apply 不抛（prompt-viewer.js 加载失败）', true)
  } catch (e) {
    check('降级实证：apply 不抛（prompt-viewer.js 加载失败）', false, String(e))
  }
  check(
    '降级实证：只同步注册 1 条路由（仅 /api）',
    degradeRoutes.length === 1 && degradeRoutes[0]?.path === '/dsh-memory-archive/api',
    `实际 ${degradeRoutes.length}`,
  )
  check(
    '降级实证：有 warn 日志且提到提示词查看器',
    degradeLogs.some(([lv, m]) => lv === 'warn' && m.includes('提示词查看器')),
    JSON.stringify(degradeLogs.filter(([lv]) => lv !== 'info')),
  )
} finally {
  rmSync(degradeDir, { recursive: true, force: true })
}
check('降级实证临时目录已删除', !existsSync(degradeDir))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
