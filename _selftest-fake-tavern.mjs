/**
 * 自检台共用的**假 Tavern**（HTTP 层复刻真契约，⛔ 不是"顺手的假对象"）。
 *
 * 为什么值得单独抽出来：A1（收纳落库）与 B2（导入落库）走的是**同一套** Tavern HTTP 面，
 * 两边的自检台各写一份假服务，迟早一份"更宽容"——于是某一边的 bug 被假服务掩盖。
 * 这里复刻的关键点：
 *   · 变更方法（非 GET/HEAD/OPTIONS）必须带 Origin 且 host === Host，否则 403
 *     （照 tavern-loader/src/api-security.js:119-123 的同源规则）；
 *   · 响应形状照真安全层：`{ok:false, code:'…'}` 平铺 code / 文件面 `{ok:false, error:{code}}`；
 *   · 目录与文件分开记（`files` / `dirs`），list 只列直接子项，目录不存在给 404
 *     ⇒ "targetKnown / floors 列不到"这些分支才测得真。
 *
 * 用法：`const fake = createFakeTavern(); await fake.start(); … fake.base … await fake.stop()`。
 */
import { createServer } from 'node:http'

export function createFakeTavern() {
  const files = new Map() // relPath -> string
  const dirs = new Set()
  const requests = [] // 假服务收到的每个请求 {method,url,host,origin} —— 同源纪律逐条断言用
  let putCount = 0
  let armedAt = null
  let failRelN = null
  let tamperWatch = null // { path, nth, mutator, seen } —— 第 nth 次 GET 该路径时落一次篡改

  function listDir(prefix) {
    const norm = prefix.replace(/\/+$/, '')
    if (files.has(norm)) return { err: 400 }
    const pref = norm === '' ? '' : norm + '/'
    const kids = new Map()
    for (const key of [...files.keys(), ...dirs.keys()]) {
      if (!key.startsWith(pref)) continue
      const rest = key.slice(pref.length)
      const seg = rest.split('/')[0]
      const full = pref + seg
      kids.set(full, { path: full, type: dirs.has(full) || rest.includes('/') ? 'dir' : 'file' })
    }
    if (norm !== '' && !dirs.has(norm) && kids.size === 0) return { err: 404 }
    return { list: [...kids.values()].sort((x, y) => (x.path < y.path ? -1 : 1)) }
  }

  const server = createServer((req, res) => {
    requests.push({ method: String(req.method || ''), url: req.url, host: req.headers.host || null, origin: req.headers.origin || null })
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const respond = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(obj))
      }
      try {
        // ★ 刻意复刻 secureTavernApi 的同源规则（见文件头）。
        const m = String(req.method || 'GET').toUpperCase()
        if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') {
          let same = false
          try {
            same = typeof req.headers.origin === 'string' && req.headers.origin !== ''
              && new URL(req.headers.origin).host === (req.headers.host || null)
          } catch {}
          if (!same) return respond(403, { ok: false, code: 'TAVERN_API_ORIGIN_FORBIDDEN' })
        }
        const u = new URL(req.url, 'http://fake')
        if (u.pathname === '/pmp-dsh-tavern/api/v2/workspace/files') {
          const list = u.searchParams.get('list')
          const p = u.searchParams.get('path')
          if (req.method === 'GET' && list !== null) {
            const r = listDir(list)
            if (r.err) return respond(r.err, { ok: false, error: { code: r.err === 404 ? 'PLAY_PATH_NOT_FOUND' : 'PLAY_PATH_INVALID' } })
            return respond(200, { ok: true, list: r.list })
          }
          if (req.method === 'GET') {
            if (tamperWatch && p === tamperWatch.path) {
              tamperWatch.seen++
              if (tamperWatch.seen === tamperWatch.nth) {
                files.set(p, tamperWatch.mutator(files.get(p))) // 模拟并发写入者恰好在此刻落盘
              }
            }
            if (!files.has(p)) return respond(404, { ok: false, error: { code: 'PLAY_FILE_NOT_FOUND' } })
            return respond(200, { ok: true, path: p, content: files.get(p) })
          }
          if (req.method === 'PUT') {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            putCount++
            if (failRelN !== null && putCount - armedAt === failRelN) {
              return respond(500, { ok: false, error: { code: 'PLAY_INJECTED_500' } })
            }
            files.set(p, String(body.content ?? ''))
            return respond(200, { ok: true, path: p })
          }
        }
        if (u.pathname === '/pmp-dsh-tavern/api/v2/workspace/dirs' && req.method === 'POST') {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          if (files.has(body.path)) return respond(409, { ok: false, error: { code: 'PLAY_PATH_CONFLICT' } })
          dirs.add(body.path)
          return respond(200, { ok: true, path: body.path })
        }
        respond(404, { ok: false, error: { code: 'PLAY_NOT_FOUND' } })
      } catch (e) {
        respond(500, { ok: false, error: { code: 'FAKE_BUG', message: String((e && e.message) || e) } })
      }
    })
  })

  return {
    files,
    dirs,
    requests,
    port: 0,
    base: '',
    putCountOf() {
      return putCount
    },
    armFailPut(n) {
      armedAt = putCount
      failRelN = n
    },
    disarm() {
      failRelN = null
    },
    armTamperGet(path, nth, mutator) {
      tamperWatch = { path, nth, mutator, seen: 0 }
    },
    disarmTamper() {
      tamperWatch = null
    },
    async start() {
      await new Promise((res) => server.listen(0, '127.0.0.1', res))
      this.port = server.address().port
      this.base = 'http://127.0.0.1:' + this.port
    },
    async stop() {
      try {
        server.closeAllConnections()
      } catch {}
      await new Promise((res) => server.close(res))
    },
  }
}
