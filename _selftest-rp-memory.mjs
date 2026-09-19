/**
 * _selftest-rp-memory.mjs —— 「角色扮演记忆库」只读出口（GET /playthrough/rp-memory）的宿主半侧自检
 *
 * 为什么单独一台：这是**第一个**要读 Tavern 的 `play-workspace.json` 的台子（`rootPlaythroughDir()`
 * 同时读插件 config 与 Tavern 的工作区文件）—— 夹具得一次写全，不然锚不到周目目录。
 *
 * ★ 不写用户家里的 ~/.dsh：DSH_HOME 指到 <repo>/_selftest-home-rpmem，测完删掉。
 * ★ 不发真网络请求：只打本进程起的 http 服务。
 * ★ 读的是**磁盘上的假记忆库**（临时工作区），⛔ 全程不碰任何真实预设 / 真实周目。
 */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { apply } from './lib/index.js'

const ROOT = resolve('.')
const HOME = join(ROOT, '_selftest-home-rpmem')
const WS = join(ROOT, '_selftest-ws-rpmem')
const PREFIX = '/dsh-memory-archive/api'
const PT_DIR = join(WS, 'ch', 'pt') // rootPlaythroughDir() = <rootPath>/<characterId>/<playthroughId>
const MEM = '.roleplay-memory'
const SENTINEL = 'RPMEM-PROBE-STORY-9f3a'

process.env.DSH_HOME = HOME

let failed = 0
let pass = 0
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log(`PASS ${name}`) } else {
    failed += 1
    console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`)
  }
}

// ── 夹具 ────────────────────────────────────────────────────────────────────
const writeConfig = () => {
  mkdirSync(join(HOME, 'dsh-memory-archive'), { recursive: true })
  writeFileSync(join(HOME, 'dsh-memory-archive', 'config.json'), JSON.stringify({
    schemaVersion: 1,
    rootMode: 'workspace',
    root: { sessionId: null, characterId: 'ch', playthroughId: 'pt' },
  }))
}
const writeWorkspace = () => {
  mkdirSync(join(HOME, 'pmp-dsh-tavern'), { recursive: true })
  writeFileSync(join(HOME, 'pmp-dsh-tavern', 'play-workspace.json'), JSON.stringify({ schemaVersion: 1, rootPath: WS }))
}
const dropWorkspace = () => rmSync(join(HOME, 'pmp-dsh-tavern', 'play-workspace.json'), { force: true })
const rmMem = (base) => rmSync(join(base, MEM), { recursive: true, force: true })
/** 造一份记忆库；files = { 'index.md': '正文', … } */
const makeMem = (base, files) => {
  rmMem(base)
  mkdirSync(join(base, MEM), { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(base, MEM, name), text)
}
const PT_MEM = join(PT_DIR, MEM)
const WS_MEM = join(WS, MEM)
const snapshot = (dir) => readFileSync(join(dir, 'story.md'), 'utf8')

const four = {
  'index.md': '# 索引\r\n最近：开场\n',
  'story.md': `## 第1章 测试\r\n${SENTINEL}\r\n`,
  'characters.md': '# 角色\n- 影子\n',
  'world.md': '# 世界\n- 现代都市\n',
}

rmSync(HOME, { recursive: true, force: true })
rmSync(WS, { recursive: true, force: true })
writeConfig()
writeWorkspace()
mkdirSync(WS, { recursive: true })

// ── 起服务 ──────────────────────────────────────────────────────────────────
const routes = []
const webServer = { register: (route) => { routes.push(route); return () => {} } }
const makeCtx = () => {
  const ctx = {
    effect: (fn) => fn(),
    inject: (_names, cb) => cb(ctx),
    get: (name) => (name === 'webServer' ? webServer : undefined),
    webServer,
  }
  apply(ctx)
  // ⚠️ 插件会注册**多条**路由（API 前缀、提示词前缀、宿主代理…）—— 按 path 取，别取第 0 条或最后一条
  return routes.find((r) => r.path === PREFIX) ?? routes[0]
}
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
  return { status: resp.status, data, text }
}

try {
  // ── T1 只有周目目录有 ⇒ 命中它；清单不带正文 ──────────────────────────────
  makeMem(PT_DIR, four)
  {
    const r = await call('GET', '/playthrough/rp-memory')
    check('T1 只有周目目录有 ⇒ base=playthrough、四行清单、index.md 在、bytes 与磁盘一致',
      r.status === 200 && r.data?.ok === true && r.data.base === 'playthrough' &&
      Array.isArray(r.data.files) && r.data.files.length === 4 &&
      r.data.files.find((f) => f.name === 'index.md')?.exists === true &&
      r.data.files.find((f) => f.name === 'index.md')?.bytes === statSync(join(PT_MEM, 'index.md')).size,
      JSON.stringify(r.data).slice(0, 300))
    check('T1b ★ 清单响应里**一个字节正文都没有**（哨兵串不在响应里）', r.text.includes(SENTINEL) === false)
    check('T1c 清单响应里不含绝对路径', r.text.includes(WS.replace(/\\/g, '\\\\')) === false && r.text.includes(WS) === false)
  }

  // ── T2 只有工作区根有（真机实际形态）⇒ 命中它 + sharedHint ────────────────
  rmMem(PT_DIR)
  makeMem(WS, four)
  {
    const r = await call('GET', '/playthrough/rp-memory')
    check('T2 只有工作区根有 ⇒ base=workspace-root、sharedHint=true（多周目共用的提示要出现）',
      r.status === 200 && r.data?.ok === true && r.data.base === 'workspace-root' && r.data.sharedHint === true,
      JSON.stringify(r.data).slice(0, 300))
  }

  // ── T3 两处都有 ⇒ 周目目录赢，且另一处如实报存在 ──────────────────────────
  makeMem(PT_DIR, { 'index.md': '# 周目目录那份\n' })
  {
    const r = await call('GET', '/playthrough/rp-memory')
    const cands = r.data?.candidates ?? []
    check('T3 两处都在 ⇒ 稳定选周目目录；candidates 两项都如实 exists=true',
      r.data?.base === 'playthrough' && cands.length === 2 && cands.every((c) => c.exists === true),
      JSON.stringify(r.data).slice(0, 300))
  }
  rmMem(WS)
  rmMem(PT_DIR)

  // ── T4 两处都没有 ⇒ 空态（200 + ok:false + exists:false） ─────────────────
  {
    const r = await call('GET', '/playthrough/rp-memory')
    check('T4 两处都没有 ⇒ HTTP 200 + ok:false + RP_MEMORY_MISSING + exists:false（灰字空态，不是报错）',
      r.status === 200 && r.data?.ok === false && r.data?.exists === false &&
      r.data?.error?.code === 'RP_MEMORY_MISSING' && Array.isArray(r.data?.candidates),
      JSON.stringify(r.data).slice(0, 300))
  }

  // ── T5 没有 Tavern 工作区文件 ⇒ RP_MEMORY_NO_PLAYTHROUGH ──────────────────
  dropWorkspace()
  {
    const r = await call('GET', '/playthrough/rp-memory')
    check('T5 拿不到 play-workspace.json ⇒ RP_MEMORY_NO_PLAYTHROUGH（拿不到就说拿不到，不猜）',
      r.data?.ok === false && r.data?.error?.code === 'RP_MEMORY_NO_PLAYTHROUGH',
      JSON.stringify(r.data).slice(0, 200))
  }
  writeWorkspace()

  // ── T6 正文逐字节一致（含 CRLF 不被吞） ───────────────────────────────────
  makeMem(WS, four)
  const onDisk = snapshot(WS_MEM)
  {
    const r = await call('GET', '/playthrough/rp-memory?file=story.md')
    check('T6 ?file=story.md ⇒ 正文与磁盘逐字节一致（CRLF 原样）、chars/bytes 如实',
      r.data?.ok === true && r.data.file?.text === onDisk &&
      r.data.file.chars === onDisk.length && r.data.file.truncated === false &&
      r.data.file.originalChars === onDisk.length,
      JSON.stringify({ chars: r.data?.file?.chars, len: onDisk.length }).slice(0, 200))
  }

  // ── T7 ★ 安全反证：路径类名字一律拒收；合法但不在目录里的 ⇒ FILE_MISSING；全程不夹带 ──
  writeFileSync(join(WS, 'secret.md'), 'TOP-SECRET-RPMEM')
  {
    const bad = ['../secret.md', '..%2Fsecret.md', 'C:\\secret.md', 'CON.md', '.hidden.md', '../../etc/passwd']
    const missing = ['其他.md', 'secret.md', 'nope.md']
    let ok = true
    let leaked = false
    for (const p of bad) {
      const r = await call('GET', '/playthrough/rp-memory?file=' + p)
      if (r.data?.error?.code !== 'RP_MEMORY_BAD_FILE') { ok = false; console.log('   ✗ 该拒没收: ' + p + ' -> ' + JSON.stringify(r.data?.error)) }
      if (r.text.includes('TOP-SECRET') || r.text.includes('passwd') || r.text.includes(WS)) leaked = true
    }
    for (const p of missing) {
      const r = await call('GET', '/playthrough/rp-memory?file=' + p)
      if (r.data?.error?.code !== 'RP_MEMORY_FILE_MISSING') { ok = false; console.log('   ✗ 该说没有却说别的: ' + p + ' -> ' + JSON.stringify(r.data?.error)) }
      if (r.text.includes('TOP-SECRET')) leaked = true // ★ 目录外那份 secret.md 的内容一个字节都不许进来
    }
    check('T7 ★ 越界/保留名/点开头 ⇒ RP_MEMORY_BAD_FILE；合法名但不在目录里 ⇒ RP_MEMORY_FILE_MISSING；不夹带、不回显、不含绝对路径', ok && !leaked)
  }

  // ── T8 目录里有什么就列什么（不再固定四行）；目录外的同名文件读不到 ────────
  makeMem(WS, { 'index.md': '# 只有索引\n' })
  {
    const r = await call('GET', '/playthrough/rp-memory')
    check('T8 目录里只有 index.md ⇒ 清单就 1 项（不再凑四行）',
      r.data?.ok === true && r.data.files.length === 1 && r.data.files[0].name === 'index.md',
      JSON.stringify(r.data).slice(0, 200))
  }

  // ── T16 ★ 目录里多出来的文件要看得见；子目录/别的扩展名不列 ────────────────
  makeMem(WS, four)
  writeFileSync(join(WS_MEM, 'notes.md'), '# 额外笔记\nRPMEM-NOTES\n')
  writeFileSync(join(WS_MEM, 'world.bin'), 'binary-ish')
  mkdirSync(join(WS_MEM, 'subdir'), { recursive: true })
  writeFileSync(join(WS_MEM, 'subdir', 'deep.md'), '# 子目录里的\n')
  {
    const r = await call('GET', '/playthrough/rp-memory')
    const names = (r.data?.files ?? []).map((f) => f.name)
    check('T16 ★ 目录里实际有的都列（含 notes.md）；子目录与 .bin 不列、只计入 skipped',
      r.data?.ok === true && names.includes('notes.md') && !names.includes('world.bin') &&
      !names.includes('subdir') && r.data.skipped === 2,
      JSON.stringify({ names, skipped: r.data?.skipped }).slice(0, 220))
    const one = await call('GET', '/playthrough/rp-memory?file=notes.md')
    check('T16b 列出来的就能读（notes.md 正文取到）', one.data?.ok === true && String(one.data.file?.text).includes('RPMEM-NOTES'))
    // 偏好顺序：预设那四份在前（index 打头），其余按名字在后
    check('T16c 排序：预设那四份在前且 index 打头，额外的排在后面',
      names[0] === 'index.md' && names.indexOf('story.md') < names.indexOf('notes.md'),
      JSON.stringify(names))
  }

  // ── T9 截断如实标注（不把标注写进正文） ───────────────────────────────────
  makeMem(WS, { 'story.md': 'x'.repeat(200001) })
  {
    const r = await call('GET', '/playthrough/rp-memory?file=story.md')
    check('T9 超上限 ⇒ truncated=true、originalChars=磁盘真实长度、chars=交付长度，且正文里没有夹带标注',
      r.data?.file?.truncated === true && r.data.file.originalChars === 200001 &&
      r.data.file.chars === 200000 && r.data.file.text.includes('已截断') === false,
      JSON.stringify({ t: r.data?.file?.truncated, o: r.data?.file?.originalChars, c: r.data?.file?.chars }))
  }

  // ── T10 ★ 只读反证：请求前后文件与目录逐字节未变 ──────────────────────────
  makeMem(WS, four)
  {
    const before = readFileSync(join(WS_MEM, 'story.md'), 'utf8')
    const beforeStat = statSync(join(WS_MEM, 'story.md'))
    await call('GET', '/playthrough/rp-memory')
    await call('GET', '/playthrough/rp-memory?file=story.md')
    const after = readFileSync(join(WS_MEM, 'story.md'), 'utf8')
    const afterStat = statSync(join(WS_MEM, 'story.md'))
    check('T10 ★ 只读：两次请求后那份文件的字节与 mtime 逐项未变', before === after && beforeStat.mtimeMs === afterStat.mtimeMs)
  }
  // T10b 源码级反证：处理器体内一个写/删 API 都不许出现
  {
    const src = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
    const sig = src.indexOf('async function handleRpMemory(')
    const end = src.indexOf('\n}\n', sig)
    const body = sig >= 0 ? src.slice(sig, end) : ''
    const writey = (body.match(/writeFileSync|appendFileSync|mkdirSync|rmSync|renameSync|unlinkSync|chmodSync|createWriteStream/g) || [])
    check('T10b ★ 反证（源码）：handleRpMemory 体内零写/删/建 API', body.length > 500 && writey.length === 0, writey.join(','))
  }

  // ── T12 `.roleplay-memory` 是个文件 ⇒ 当"没有"，不许抛 ────────────────────
  rmMem(WS)
  writeFileSync(WS_MEM, 'not a dir')
  {
    const r = await call('GET', '/playthrough/rp-memory')
    check('T12 .roleplay-memory 是文件而不是目录 ⇒ 当作没有（RP_MEMORY_MISSING），不抛不 500',
      r.status === 200 && r.data?.error?.code === 'RP_MEMORY_MISSING', JSON.stringify(r.data).slice(0, 200))
  }
  rmSync(WS_MEM, { force: true })

  // ── T14 方法口径（ENDPOINTS 只许 GET） ────────────────────────────────────
  {
    const r = await call('POST', '/playthrough/rp-memory', {})
    check('T14 POST ⇒ 405（只读出口只许 GET）', r.status === 405, String(r.status))
  }

  // ── T15 接线唯一性：ENDPOINTS 与分发行各恰好 1 处 ────────────────────────
  {
    const src = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
    const table = (src.match(/'\/playthrough\/rp-memory': \['GET'\]/g) || []).length
    const dispatch = (src.match(/rest === '\/playthrough\/rp-memory'/g) || []).length
    check('T15 接线唯一：ENDPOINTS 条目 1 处、分发行 1 处', table === 1 && dispatch === 1, `table=${table} dispatch=${dispatch}`)
  }
} finally {
  await new Promise((r) => server.close(r))
  rmSync(HOME, { recursive: true, force: true })
  rmSync(WS, { recursive: true, force: true })
  if (existsSync(HOME) || existsSync(WS)) console.log('⚠️ 沙箱没清干净：' + HOME + ' / ' + WS)
}

console.log('== 总结：' + pass + ' 通过 / ' + failed + ' 失败 ==')
if (failed > 0) process.exit(1)
