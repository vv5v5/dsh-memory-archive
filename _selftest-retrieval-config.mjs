/**
 * 「向量检索 API」（retrieval.*）配置面自检（20260918）。
 *
 * 覆盖（对应任务书验收 2 与 T1/T2）：
 *   ① ★★反证（验收 2）：publicConfig（GET/PUT /config 投影）**没有 retrieval.key 键**，
 *      且整个响应 JSON.stringify 之后搜不到喂进去的假 key（sk-TESTKEY-DO-NOT-USE）；
 *   ② 配置四处联动：defaultConfig（无配置文件 ⇒ 默认）、sanitizeConfig（类型不对回落 + issue）、
 *      mergeConfig（PUT 校验：类型错/协议错 ⇒ 400；__CLEAR__ 清密钥）、publicConfig（keySet/keyHint）；
 *   ③ PUT 写盘回读：url/model/rerankModel 落盘、key 落盘但投影只回 keySet/尾 4 位；
 *   ④ /retrieval/test（★ 20260920 起**两个模型各测一次**）：两个都没配全 ⇒ 可读 400 且**一个请求都不发**；
 *      对两个**各自独立**的本地假端点（embeddings / rerank）各打一次最小请求 ⇒ 各报 HTTP 码 + 耗时
 *      （向量另给维度、重排另给返回条数）；重排地址粘完整 `…/rerank` 不重复拼；重排两项留空 ⇒ 沿用向量那套
 *      （向后兼容）；两个 key 都只进请求头、响应里绝不出现。
 *
 * ★ 不写用户家里的 ~/.dsh：DSH_HOME 指到仓库内临时目录，finally 里删干净。
 * ★ 本台只用**假 key**（sk-TESTKEY-DO-NOT-USE，字面量自造），不读任何环境变量、不碰真密钥。
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { apply } from './lib/index.js'

const HOME = mkdtempSync(join(resolve('.'), '.st-tmp-retrieval-'))
process.env.DSH_HOME = HOME
const PREFIX = '/dsh-memory-archive/api'
const FAKE_KEY = 'sk-TESTKEY-DO-NOT-USE' // 自造假 key（验收 2 指定口径）；只进临时目录，finally 删除
const CONFIG_FILE = join(HOME, 'dsh-memory-archive', 'config.json')

let failed = false
function check(name, cond, extra) {
  if (cond) console.log(`PASS ${name}`)
  else {
    failed = true
    console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`)
  }
}

// —— 起插件（照 _selftest-host.mjs 的假 ctx 契约）——
const routes = []
const webServer = { register: (route) => { routes.push(route); return () => {} } }
const ctx = {
  effect: (fn) => fn(),
  inject: (_names, cb) => cb(ctx),
  get: (name) => (name === 'webServer' ? webServer : undefined),
  webServer,
}
apply(ctx)
const handler = routes[0].handler

const server = createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname
  if (p === PREFIX || p.startsWith(PREFIX + '/')) return handler(req, res)
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'no route' } }))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}${PREFIX}`

async function call(method, path, bodyObj) {
  const resp = await fetch(base + path, {
    method,
    headers: bodyObj !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: bodyObj !== undefined ? JSON.stringify(bodyObj) : undefined,
  })
  const text = await resp.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: resp.status, json, text }
}

try {
  // ───────── ① 无配置文件 ⇒ defaultConfig 的 retrieval 投影 ─────────
  {
    const r = await call('GET', '/config')
    const ret = r.json && r.json.retrieval
    check('① 无配置 ⇒ retrieval 投影是全默认、keySet=false', r.status === 200 && !!ret
      && ret.url === '' && ret.model === '' && ret.rerankModel === '' && ret.keySet === false && ret.keyHint === null,
      r.text.slice(0, 200))
    // ★ 2026-09-20：重排那套也是空默认，且"没在沿用"（没有向量密钥可沿用）
    check('① 重排三件套默认全空；rerankKeySet=false、rerankKeyInherited=false',
      ret.rerankUrl === '' && ret.rerankKeySet === false && ret.rerankKeyHint === null && ret.rerankKeyInherited === false,
      JSON.stringify({ rerankUrl: ret.rerankUrl, rrKeySet: ret.rerankKeySet, rrInherited: ret.rerankKeyInherited }))
    check('① 默认投影没有 retrieval.key 键', !!ret && !('key' in ret), JSON.stringify(ret && Object.keys(ret)))
  }

  // ───────── ② PUT：四个字段都能写；key 只回 keySet/keyHint ─────────
  {
    const put = await call('PUT', '/config', {
      retrieval: { url: 'https://api.example.invalid/v1', model: 'emb-model-x', rerankModel: 'rerank-model-x', key: FAKE_KEY },
    })
    const ret = put.json && put.json.retrieval
    check('② PUT 四字段 ⇒ 200，投影回 url/model/rerankModel',
      put.status === 200 && ret && ret.url === 'https://api.example.invalid/v1' && ret.model === 'emb-model-x' && ret.rerankModel === 'rerank-model-x',
      put.text.slice(0, 240))
    check('② keySet=true + keyHint 只露尾 4 位', !!ret && ret.keySet === true && ret.keyHint === '…-USE', JSON.stringify(ret))
    // ★ 2026-09-20：只填了向量那把 key ⇒ 重排**正在沿用**它。投影必须如实说"沿用"，
    //   ⛔ 不许显示成"重排已单独保存"（那会让用户以为重排有独立密钥）。
    check('② 重排密钥留空 ⇒ rerankKeySet=true（有 key 可用）且 rerankKeyInherited=true（用的是向量那把）',
      !!ret && ret.rerankKeySet === true && ret.rerankKeyInherited === true && ret.rerankKeyHint === '…-USE',
      JSON.stringify(ret))
    // ★★反证（验收 2 本体）：整个响应序列化之后搜不到假 key
    check('②★ 反证：PUT 响应全文不含假 key', !put.text.includes(FAKE_KEY), '泄漏！')
    const get = await call('GET', '/config')
    check('②★ 反证（验收 2）：GET /config 投影没有 retrieval.key 键，且全文不含假 key',
      get.status === 200 && get.json.retrieval && !('key' in get.json.retrieval) && !get.text.includes(FAKE_KEY),
      'keys=' + JSON.stringify(get.json.retrieval && Object.keys(get.json.retrieval)))
    // 盘上确实落了（否则"面板能存"是假的）；断言用布尔，不把 key 打进输出
    const disk = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    check('② key 落盘（布尔断言，不回显）', disk.retrieval && disk.retrieval.key === FAKE_KEY)
  }

  // ───────── ③ mergeConfig 校验：类型/协议错 ⇒ 400；__CLEAR__ 清密钥 ─────────
  {
    const badType = await call('PUT', '/config', { retrieval: { url: 123 } })
    check('③ url 类型错 ⇒ 400 CONFIG_INVALID', badType.status === 400 && badType.json.error.code === 'CONFIG_INVALID', badType.text.slice(0, 160))
    const badProto = await call('PUT', '/config', { retrieval: { url: 'ftp://x/v1' } })
    check('③ url 协议错 ⇒ 400（必须 http/https）', badProto.status === 400 && /http/.test(badProto.json.error.message || ''), badProto.text.slice(0, 160))
    const badObj = await call('PUT', '/config', { retrieval: 'not-an-object' })
    check('③ retrieval 非对象 ⇒ 400', badObj.status === 400, badObj.text.slice(0, 160))
    const cleared = await call('PUT', '/config', { retrieval: { key: '__CLEAR__' } })
    check('③ __CLEAR__ 清密钥 ⇒ keySet=false、keyHint=null，且响应不含假 key',
      cleared.status === 200 && cleared.json.retrieval.keySet === false && cleared.json.retrieval.keyHint === null
      && !cleared.text.includes(FAKE_KEY), cleared.text.slice(0, 200))
    const disk = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    check('③ 盘上 key 已清成空串', disk.retrieval.key === '')
  }

  // ───────── ④ sanitizeConfig：类型不对一律回落默认 + 记 issue（绝不抛） ─────────
  {
    writeFileSync(CONFIG_FILE, JSON.stringify({
      schemaVersion: 1,
      retrieval: { url: 42, model: null, rerankModel: ['x'], key: { bad: true }, keep: '未知键丢弃' },
    }), 'utf8')
    const r = await call('GET', '/config')
    const ret = r.json && r.json.retrieval
    check('④ retrieval 字段类型错 ⇒ 全回落默认 + configError 点名 retrieval（不抛）',
      r.status === 200 && ret && ret.url === '' && ret.model === '' && ret.rerankModel === '' && ret.keySet === false
      && typeof r.json.configError === 'string' && r.json.configError.includes('retrieval'),
      String(r.json.configError).slice(0, 200))
    const retKeys = Object.keys((JSON.parse(r.text)).retrieval || {})
    // ★ 2026-09-20：「向量」页签的「参与检索」开关要读当前态 ⇒ 投影多一维 `chatEnabled`（5 键 → 6 键）；
    //   同日再拆「两个模型各一套接口」⇒ 投影又多 4 维（rerankUrl / rerankKeySet / rerankKeyHint / rerankKeyInherited）。
    //   本条**本意**是"未知键不许漏进投影"（keep 仍在下面被排除），不是钉死某个数 —— 但键集要**逐个列出来**钉住。
    check('④ 未知键（keep）不进投影（sanitize 只认已知字段；投影恰好 10 键）',
      JSON.stringify(retKeys) === JSON.stringify(['url', 'model', 'rerankUrl', 'rerankModel', 'keySet', 'keyHint', 'rerankKeySet', 'rerankKeyHint', 'rerankKeyInherited', 'chatEnabled']),
      JSON.stringify(retKeys))
    // ★★反证：投影里**不许**出现任何 `*key` 原文键（两组密钥都只写不读）
    check('④★ 反证：投影里没有任何 key 原文键（只有 keySet/keyHint 一族）',
      retKeys.every((k) => !/(^|_)key$/.test(k)), JSON.stringify(retKeys))
    // 开关必须是**布尔**（面板拿它渲染开关状态，⛔ 不包对象、不给三态）
    check('④ chatEnabled 投影为布尔（缺省配置 ⇒ true）',
      typeof ret.chatEnabled === 'boolean' && ret.chatEnabled === true,
      String(ret.chatEnabled))
    writeFileSync(CONFIG_FILE, JSON.stringify({ schemaVersion: 1, retrieval: ['not', 'an', 'object'] }), 'utf8')
    const r2 = await call('GET', '/config')
    check('④ retrieval 整个不是对象 ⇒ 回落默认 + issue',
      r2.status === 200 && r2.json.retrieval.url === '' && String(r2.json.configError).includes('retrieval'),
      String(r2.json.configError).slice(0, 160))
    // 恢复一份干净的（后面 /retrieval/test 用）
    writeFileSync(CONFIG_FILE, JSON.stringify({
      schemaVersion: 1,
      retrieval: { url: '', model: '', rerankModel: '', key: '' },
    }), 'utf8')
  }

  // ───────── ⑤ /retrieval/test：缺字段给可读原因 ─────────
  {
    const r0 = await call('POST', '/retrieval/test', {})
    check('⑤ 缺 url/model ⇒ 400 可读（点名「向量检索 API」卡）',
      r0.status === 400 && r0.json.error.code === 'CONFIG_INCOMPLETE' && r0.json.error.message.includes('向量检索 API'),
      r0.text.slice(0, 200))
    await call('PUT', '/config', { retrieval: { url: 'https://api.example.invalid/v1', model: 'emb-model-x' } })
    const r1 = await call('POST', '/retrieval/test', {})
    check('⑤ 缺密钥 ⇒ 400 可读（提示先在卡里保存密钥）',
      r1.status === 400 && /密钥/.test(r1.json.error.message || ''), r1.text.slice(0, 200))
  }

  // ───────── ⑥ /retrieval/test：**两个模型各打一次**（本地假端点全链路） ─────────
  {
    // 两个**各自独立**的假端点（两个端口）—— 这正是这次拆接口要证的：两个模型可以落在不同服务商上。
    const seen = { embed: [], rerank: [] }
    const mkServer = (kind) => createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        seen[kind].push({ path: req.url, auth: req.headers.authorization || null, body: Buffer.concat(chunks).toString('utf8') })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(kind === 'embed'
          ? JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] })
          : JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }))
      })
    })
    const embSrv = mkServer('embed')
    const rrSrv = mkServer('rerank')
    await new Promise((r) => embSrv.listen(0, '127.0.0.1', r))
    await new Promise((r) => rrSrv.listen(0, '127.0.0.1', r))
    const embUrl = `http://127.0.0.1:${embSrv.address().port}/v1`
    const rrUrl = `http://127.0.0.1:${rrSrv.address().port}/v1`

    // ⑥-1 两个模型各一套地址/密钥（分属两个端口）⇒ 都通，且**各打各的**
    await call('PUT', '/config', { retrieval: {
      url: embUrl, model: 'emb-model-x', key: FAKE_KEY,
      rerankUrl: rrUrl, rerankModel: 'rr-model-x', rerankKey: FAKE_KEY,
    } })
    const r = await call('POST', '/retrieval/test', {})
    check('⑥ 两个模型各一套接口 ⇒ ok=true、各报一行（向量给维度、重排给返回条数）',
      r.status === 200 && r.json.ok === true
      && r.json.embedding && r.json.embedding.httpStatus === 200 && r.json.embedding.dims === 4
      && r.json.rerank && r.json.rerank.httpStatus === 200 && r.json.rerank.results === 1
      && typeof r.json.message === 'string' && r.json.message.includes('向量模型') && r.json.message.includes('重排模型'),
      r.text.slice(0, 300))
    check('⑥ 向量请求打在 <向量接口地址>/embeddings、input 是一个词',
      seen.embed.length === 1 && seen.embed[0].path === '/v1/embeddings'
      && JSON.parse(seen.embed[0].body).input === 'ping' && JSON.parse(seen.embed[0].body).model === 'emb-model-x',
      JSON.stringify(seen.embed.map((x) => x.path)))
    check('⑥★ 重排请求打在**自己的**那个地址的 /rerank 上，形状逐字对齐 anima 的 fetchRerank',
      seen.rerank.length === 1 && seen.rerank[0].path === '/v1/rerank'
      && (() => { const b = JSON.parse(seen.rerank[0].body); return b.model === 'rr-model-x' && b.query === 'ping' && Array.isArray(b.documents) && b.documents.length === 1 })(),
      JSON.stringify(seen.rerank.map((x) => x.path)))
    check('⑥ 两个 key 都只进请求头（Bearer），响应里绝不出现',
      seen.embed[0].auth === 'Bearer ' + FAKE_KEY && seen.rerank[0].auth === 'Bearer ' + FAKE_KEY && !r.text.includes(FAKE_KEY),
      'auth=' + (seen.embed[0].auth ? 'Bearer ***' : 'null'))

    // ⑥-2 重排地址粘的是**完整 `…/rerank`** ⇒ 不许再拼一次（拼两次会变成 `…/rerank/rerank` ⇒ 永远不通）
    await call('PUT', '/config', { retrieval: { rerankUrl: rrUrl + '/rerank' } })
    const rFull = await call('POST', '/retrieval/test', {})
    check('⑥★ 重排地址已以 /rerank 结尾 ⇒ 请求路径仍是 /v1/rerank（⛔ 不拼成 /rerank/rerank）',
      rFull.json.ok === true && seen.rerank.length === 2 && seen.rerank[1].path === '/v1/rerank',
      JSON.stringify(seen.rerank.map((x) => x.path)))

    // ⑥-3 ★ 向后兼容：重排地址/密钥**都留空** ⇒ 沿用向量那个地址 + '/rerank' 与同一把 key
    //      （= 改版前的行为；老配置的测试结论必须一字不变）
    //      ⚠️ 清密钥要用 `__CLEAR__`，⛔ 不是空串 —— 宿主约定「空串 = 保留原有」（本台子第一版就踩了：
    //         写 `''` 没清掉，于是"沿用"根本没被验到，反证全靠运气）。
    await call('PUT', '/config', { retrieval: { rerankUrl: '', rerankModel: 'rr-model-x', rerankKey: '__CLEAR__' } })
    const before = seen.embed.length
    const rCompat = await call('POST', '/retrieval/test', {})
    // 两个探针**都**打在向量那个服务器上（向量打 /embeddings、重排打它的 /rerank）⇒ 该数组 +2
    const last = seen.embed[seen.embed.length - 1]
    check('⑥★ 兼容：重排地址留空 ⇒ 走**向量那个地址** + /rerank，密钥沿用向量那把',
      rCompat.json.ok === true && seen.embed.length === before + 2 && last.path === '/v1/rerank'
      && last.auth === 'Bearer ' + FAKE_KEY,
      JSON.stringify({ paths: seen.embed.map((x) => x.path), n: seen.embed.length }))

    // ⑥-4 清掉向量那把 key（重排在沿用 ⇒ 一起没了）⇒ 两个都没配全 ⇒ 400，且**一个请求都不发**
    await call('PUT', '/config', { retrieval: { key: '__CLEAR__' } })
    const nE = seen.embed.length
    const nR = seen.rerank.length
    const r2 = await call('POST', '/retrieval/test', {})
    check('⑥ 密钥被清之后 ⇒ 400 可读（点名密钥），不再拿空 key 打端点',
      r2.status === 400 && r2.json.error.code === 'CONFIG_INCOMPLETE' && /密钥/.test(r2.json.error.message),
      r2.text.slice(0, 200))
    check('⑥★ 那次 400 **一个请求都没发**（两个端点计数都没变）',
      seen.embed.length === nE && seen.rerank.length === nR, JSON.stringify({ e: seen.embed.length, r: seen.rerank.length }))

    embSrv.close()
    rrSrv.close()
  }

  // ───────── ⑦ 网络失败 ⇒ HTTP 200 + ok:false + 可读原因（测不通不是服务器错误） ─────────
  {
    await call('PUT', '/config', { retrieval: {
      url: 'http://127.0.0.1:9/v1', model: 'emb-model-x', key: FAKE_KEY,
      rerankUrl: 'http://127.0.0.1:9/v1', rerankModel: 'rr-model-x', rerankKey: FAKE_KEY,
    } })
    const r = await call('POST', '/retrieval/test', {})
    check('⑦ 两个端点都连不上 ⇒ 200 + ok:false + NETWORK_ERROR/TIMEOUT + 汇总里两个模型各说各的',
      r.status === 200 && r.json.ok === false && ['NETWORK_ERROR', 'TIMEOUT'].includes(r.json.error.code)
      && /向量模型/.test(r.json.error.message || '') && /重排模型/.test(r.json.error.message || ''),
      r.text.slice(0, 240))
    check('⑦ 各自都给了 elapsedMs（哪怕拿不到 HTTP 码）',
      r.json.embedding && typeof r.json.embedding.elapsedMs === 'number'
      && r.json.rerank && typeof r.json.rerank.elapsedMs === 'number',
      JSON.stringify({ e: r.json.embedding && r.json.embedding.elapsedMs, r: r.json.rerank && r.json.rerank.elapsedMs }))
    check('⑦ 失败响应里也不含假 key', !r.text.includes(FAKE_KEY))
  }

  // ───────── ⑧ 静态锚：面板卡与端点接线在位 ─────────
  {
    const clientSrc = readFileSync(resolve('lib', 'client.js'), 'utf8')
    const idxSrc = readFileSync(resolve('lib', 'index.js'), 'utf8')
    check('⑧ 面板卡请求 /retrieval/test；卡标题是「向量检索 API」',
      clientSrc.includes("HOST_API_BASE + '/retrieval/test'") && clientSrc.includes("'向量检索 API'"))
    check('⑧ 端点表有 /retrieval/test；旧卡的三处 dma-api-* 输入框 id 已不在面板源码里',
      idxSrc.includes("'/retrieval/test': ['POST']") && !clientSrc.includes("'dma-api-url'") && !clientSrc.includes("'dma-api-key'"))
    check('⑧ publicConfig 源码里 retrieval 投影不含 key 原文（keySet/keyHint 之外无它）',
      /retrieval:\s*\{[^}]*keySet:[^}]*keyHint:[^}]*\}/s.test(idxSrc) && !/retrieval:\s*\{[^}]*\bkey:\s*config/s.test(idxSrc))
  }
} finally {
  server.close()
  rmSync(HOME, { recursive: true, force: true })
}

console.log(failed ? '\n✖ retrieval 配置面：有 FAIL' : '\n★ retrieval 配置面：全过')
process.exit(failed ? 3 : 0)
