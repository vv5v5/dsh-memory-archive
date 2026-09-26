/**
 * _selftest-floor-diff.mjs —— 「楼层**改动下钻**」那一单的宿主半侧自检（20260925）。
 *
 * 用户口径（逐字）：「**开一个下钻，直接显示具体改动的字段，写改了哪些可以说完全没用**」
 * ＋（同一单里那一条）「**插件自己按时间编一个序号，不论实际seq**，这样反而符合直觉，序号最大的就是最新生成的」。
 *
 * 三节（都按项目惯例：**相 + 反证成对**，⛔ 不只做源码字符串断言）：
 *   A 纯逻辑层（`lib/floor-snapshot.js` 直测，⛔ 不碰文件系统）：
 *     行级 diff 的每一条口径 —— 两侧同文 ⇒ **空 diff**；加一行 / 删一行各一相；`\r\n` 与结尾换行
 *     **不算改**；上下文行数与中间那段`…跳过 N 行`的省略标记；三种截断（行数 / 字节 / 单行超长）
 *     都**如实标 `truncated`**；`diffFloorFiles` 的六种 `kind`（changed / same / absent / not-target /
 *     deadzone / unreadable）逐相。
 *   B 端点（**真 HTTP**，走真 `apply()` 接线）：`GET /playthrough/rp-memory/floors/diff`
 *     —— 缺省 = 比"时间上紧随其前的那一条"（按 `ordinal` 口径，由**宿主**挑）；`against` / `againstVariant`
 *     显式指定；最早的那一条 ⇒ `against:null` ＋ 可读原因（⛔ 不是错误）；认不出 ⇒ `ok:false` ＋ 可读原因；
 *     ⛔ **纯只读**（整棵记忆库目录逐字节没动）；死区那一份**必须标出来**；超长 `truncated` 如实。
 *   C 两种「对齐」回执的**序号**口径（用户口径「**改成：当前记忆从【序号】改为【序号】**」）：
 *     真 HTTP 打 `POST …/floors/pending/settle` —— `'full'` / `'number'` 各一相、**旧值认不出 ⇒ 不写 0**
 *     那一相（⛔ 不许出现「序号 0」），并钉住"那句里不再出现『楼』"。
 *
 * ★ 全部夹具都在**临时目录**里（`_selftest-home-floordiff` / `_selftest-ws-floordiff`），测完删掉；
 * ⛔ 全程不碰真机（`<用户目录>/.dsh`）、⛔ 不碰用户的 RP 工作区。
 */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
// ★ `__setFloorWatch` / `__disposeFloorWatch`：注入**假 watcher**，好在台子里确定性地喂一次"时间线动了"
//   （F 那一节要证明**推给浮层的那一帧**里也带着那三个序号；⛔ 不靠真 fs.watch 的时序）。
import { apply, __setFloorWatch, __disposeFloorWatch, __floorSseStats, __floorSseLastFrame } from './lib/index.js'
import * as fl from './lib/floor-snapshot.js'
import floorDfl from './lib/floor-snapshot.js'
import * as dz from './lib/deadzone.js'

const ROOT = resolve('.')
const HOME = join(ROOT, '_selftest-home-floordiff')
const WS = join(ROOT, '_selftest-ws-floordiff')
const PREFIX = '/dsh-memory-archive/api'
const PT = join(WS, 'ch', 'pt')
const MEM = '.roleplay-memory'
const PT_MEM = join(PT, MEM)
const SESSION = 'sess-floordiff-1'

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

// ── 夹具 ────────────────────────────────────────────────────────────────────
const NODES = ['qa-1-1-aaa', 'qa-2-2-bbb', 'qa-3-3-ccc']
const VAR = (id) => 'variant-' + id
const nodeOf = (id, i) => ({
  id, kind: 'qa',
  adoptedVariantId: VAR(id),
  variants: [{ id: VAR(id), sessionId: SESSION, startEventId: i + 1, endEventId: i + 1, ext: {} }],
})
let timelineWrites = 0
function writeTimeline(headId, ids = NODES) {
  timelineWrites += 1
  const nodes = ids.map((id, i) => nodeOf(id, i))
  mkdirSync(PT, { recursive: true })
  writeFileSync(join(PT, 'timeline.json'), JSON.stringify({
    head: headId === null ? {} : { sessionId: SESSION, nodeId: headId, variantId: VAR(headId) },
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
}
const writeMem = (name, text) => { mkdirSync(PT_MEM, { recursive: true }); writeFileSync(join(PT_MEM, name), text) }
const snapshotDir = () => join(PT_MEM, fl.FLOOR_DIR_NAME)
const indexPath = () => join(snapshotDir(), fl.FLOOR_INDEX_NAME)
const indexRaw = () => { try { return readFileSync(indexPath(), 'utf8') } catch { return null } }
const indexOf = () => fl.readIndex(PT_MEM).index
/** 整棵记忆库目录的"指纹"（**逐字节**：文件名 + 内容哈希）—— "纯只读"那条判据用它。 */
const memTree = () => {
  const out = []
  const walk = (dir, rel) => {
    let names = []
    try { names = readdirSync(dir).sort() } catch { return }
    for (const n of names) {
      const p = join(dir, n)
      const r = rel === '' ? n : rel + '/' + n
      let st = null
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) { out.push(r + '/'); walk(p, r); continue }
      out.push(r + ':' + String(st.size) + ':' + dz.sha256Hex(readFileSync(p, 'utf8')))
    }
  }
  walk(PT_MEM, '')
  return out
}
/** 写一份楼层条目（形状 = `planRecord` 出来的那一份；⛔ 不手搓字段名）。 */
const rec = (name, text, changed, delta = null) => ({
  name,
  sha256: text === null ? null : dz.sha256Hex(text),
  bytes: text === null ? null : Buffer.byteLength(text, 'utf8'),
  changed,
  delta,
})
/** 把这几份正文落成 blob（内容寻址；⛔ 同 sha 只落一份）。 */
function putBlobs(texts) {
  for (const t of texts) if (typeof t === 'string') fl.writeBlob(PT_MEM, dz.sha256Hex(t), t)
}
/** 手工给一份死区文档（走真模块的裁决，⛔ 不手搓 JSON 形状）。 */
function writeDeadzones(pairs) {
  let doc = dz.emptyDoc()
  for (const [file, text] of pairs) {
    const r = dz.decideToggle(doc, { action: 'add', file, sha256: dz.sha256Hex(text), text, at: 'T' })
    if (r.ok !== true) throw new Error('夹具失败：' + r.message)
    doc = r.doc
  }
  dz.writeDocFile(PT_MEM, doc)
}
const readMem = (name) => { try { return readFileSync(join(PT_MEM, name), 'utf8') } catch { return null } }

// ── 三份正文（第 1 / 2 / 3 版）──────────────────────────────────────────────
const NOTE_1 = '# 笔记\n第一段\n第二段\n第三段\n'
const NOTE_2 = '# 笔记\n第一段\n第二段\n第三段\n第四段（新加的一行）\n'
const NOTE_3 = '# 笔记\n' + Array.from({ length: 500 }, (_, i) => '第 ' + String(i + 1) + ' 段').join('\n') + '\n'
const IDX_1 = '# 索引\n同样的内容\n'
const IDX_3 = '# 索引\n换过的内容\n'
const STATE_1 = '# 状态\nv1\n'
/** ★ 与 `STATE_1` **逐字一样、只有换行风格不同**（CRLF）—— "CRLF 不算改"那条口径的相。 */
const STATE_1_CRLF = STATE_1.replace(/\n/g, '\r\n')
const WORLD_1 = '# 世界观\n一个世界\n'
const CHARS_1 = '# 角色\n甲\n'
const CHARS_2 = '# 角色\n甲\n乙（又来了一个）\n'

// ── 假 watcher（★ 20260925：`__setFloorWatch` 注入；台子靠它**确定性**喂一次"时间线动了"）────────
const watchers = []
function makeFakeWatch() {
  return (dir, listener) => {
    const w = {
      dir, listener, closed: false,
      on() { return w },
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

// ── 假 ctx（能驱动真实的 apply()：端点在场）─────────────────────────────────
const routes = []
const listeners = []
const logs = { info: [], warn: [], error: [] }
const webServer = { register: (route) => { routes.push(route); return () => {} } }
function makeScope(pluginName) {
  return {
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on: (event, fn) => { listeners.push({ event, fn, who: pluginName }); return () => {} },
    systemPrompt: { section: (s) => { logs.info.push('section:' + String(s && s.name)); return () => {} } },
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
mkdirSync(WS, { recursive: true })
writeConfig()
writeTavern()
// ⚠️ 记忆库与楼层清单要**先**摆好：接线那一刻（`scope.effect`）就会按"面板绑定的周目"建第一条 watcher，
//   那一刻若认不出落点 ⇒ **不盯**（`ensureFloorWatch` 安静退出）⇒ 后面喂事件就没人接。
writeFloors()
// ★ 注入假 watcher（**必须在 apply() 之前** —— 接线那一刻就要用它建第一条 watcher）
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
  if (body !== undefined) { init.headers = { 'content-type': 'application/json' }; init.body = JSON.stringify(body) }
  const resp = await fetch(base + path, init)
  const text = await resp.text()
  let data = null
  try { data = JSON.parse(text) } catch { /* 非 JSON 就留 null */ }
  return { status: resp.status, data, text }
}
const diffOf = (nodeId, variantId, extra = '') => call('GET',
  '/playthrough/rp-memory/floors/diff?nodeId=' + encodeURIComponent(nodeId) + '&variantId=' + encodeURIComponent(variantId) + extra)
const lineOf = (files, name) => (Array.isArray(files) ? files.find((f) => f.name === name) : null)

/** 摆好三份楼层快照（第 1 / 2 / 3 版）＋ 记忆库现文；返回每一条的键。 */
function writeFloors() {
  rmSync(PT_MEM, { recursive: true, force: true })
  mkdirSync(PT_MEM, { recursive: true })
  for (const [n, t] of Object.entries({ 'notes.md': NOTE_1, 'index.md': IDX_1, 'state.md': STATE_1, 'characters.md': CHARS_1, 'world.md': WORLD_1 })) writeMem(n, t)
  putBlobs([NOTE_1, NOTE_2, NOTE_3, IDX_1, IDX_3, STATE_1, STATE_1_CRLF, WORLD_1, CHARS_1, CHARS_2])
  const files = (pairs) => fl.FLOOR_FILES.map((n) => {
    const p = pairs[n]
    return p === undefined ? rec(n, null, false, null) : rec(n, p[0], p[1], p[2] === undefined ? null : p[2])
  })
  const floors = [
    // 序号 1（最早）：五份都在
    {
      nodeId: NODES[0], variantId: VAR(NODES[0]), seq: 1, at: '2026-09-20T10:00:00.000Z', updatedAt: '2026-09-20T10:00:00.000Z',
      files: files({ 'notes.md': [NOTE_1, true], 'index.md': [IDX_1, true], 'state.md': [STATE_1, true], 'characters.md': [CHARS_1, true], 'world.md': [WORLD_1, true] }),
    },
    // 序号 2：notes 加了一行；index **逐字节一样**；state **只有换行风格不同（CRLF）**；characters 变了；world 这一版没有
    {
      nodeId: NODES[1], variantId: VAR(NODES[1]), seq: 2, at: '2026-09-21T10:00:00.000Z', updatedAt: '2026-09-21T10:00:00.000Z',
      files: files({
        'notes.md': [NOTE_2, true], 'index.md': [IDX_1, false], 'state.md': [STATE_1_CRLF, false],
        'characters.md': [CHARS_2, true], 'world.md': [null, true],
      }),
    },
    // 序号 3（最新）：notes 整段换过（超长 ⇒ 截断那一相）；index 变了
    {
      nodeId: NODES[2], variantId: VAR(NODES[2]), seq: 3, at: '2026-09-22T10:00:00.000Z', updatedAt: '2026-09-22T10:00:00.000Z',
      files: files({
        'notes.md': [NOTE_3, true], 'index.md': [IDX_3, true], 'state.md': [STATE_1_CRLF, false],
        'characters.md': [CHARS_2, false], 'world.md': [WORLD_1, true],
      }),
    },
  ]
  fl.writeIndex(PT_MEM, {
    schemaVersion: fl.FLOOR_SCHEMA_VERSION, updatedAt: '2026-09-22T10:00:00.000Z',
    last: { nodeId: NODES[2], variantId: VAR(NODES[2]), seq: 3, at: '2026-09-22T10:00:00.000Z' },
    floors, pending: null,
  })
  writeTimeline(NODES[2])
}
/** 只留两条、`last` 指着第 1 条（回执那两节用；也顺手把 pending 摆上）。 */
function writeTwoFloors(pending, last) {
  rmSync(PT_MEM, { recursive: true, force: true })
  mkdirSync(PT_MEM, { recursive: true })
  for (const [n, t] of Object.entries({ 'notes.md': NOTE_1, 'index.md': IDX_1, 'state.md': STATE_1 })) writeMem(n, t)
  putBlobs([NOTE_1, IDX_1, STATE_1])
  const mk = (nodeId, i, at) => ({
    nodeId, variantId: VAR(nodeId), seq: i + 1, at, updatedAt: at,
    files: fl.FLOOR_FILES.map((n) => rec(n, n === 'world.md' ? null : (n === 'notes.md' ? NOTE_1 : n === 'index.md' ? IDX_1 : STATE_1), true)),
  })
  fl.writeIndex(PT_MEM, {
    schemaVersion: fl.FLOOR_SCHEMA_VERSION, updatedAt: '2026-09-22T10:00:00.000Z',
    last: last === undefined
      ? { nodeId: NODES[0], variantId: VAR(NODES[0]), seq: 1, at: '2026-09-20T10:00:00.000Z' }
      : last,
    floors: [mk(NODES[0], 0, '2026-09-20T10:00:00.000Z'), mk(NODES[1], 1, '2026-09-21T10:00:00.000Z')],
    pending,
  })
  writeTimeline(NODES[2])
}
const pendingTo = (nodeId, seq, targets) => Object.assign({
  fromNodeId: NODES[2], fromVariantId: VAR(NODES[2]), fromSeq: 3,
  toNodeId: nodeId, toVariantId: VAR(nodeId), toSeq: seq,
  archiveNodeId: NODES[2], archiveVariantId: VAR(NODES[2]), archiveSeq: 3,
  targetNodeId: '', targetVariantId: '', targetSeq: null,
  why: 'back', source: 'self', at: '2026-09-22T11:00:00.000Z',
}, targets ?? {})

try {
  // ═════════════════════════════════════════════════════════════════════════
  sect('A 纯逻辑层：行级 diff（lib/floor-snapshot.js 直测，⛔ 不碰文件系统）')

  check('A1 两侧同文 ⇒ **空 diff**（added 0 / removed 0 / lines []）；只差 `\\r\\n` ⇒ 也算同文；结尾那一个换行同理',
    (() => {
      const same = fl.diffTextLines({ before: '甲\n乙\n', after: '甲\n乙\n' })
      const crlf = fl.diffTextLines({ before: '甲\n乙\n', after: '甲\r\n乙\r\n' })
      const tail = fl.diffTextLines({ before: '甲\n乙\n', after: '甲\n乙' })
      const cr = fl.diffTextLines({ before: '甲\n乙\n', after: '甲\r乙\r' })
      const empty = fl.diffTextLines({ before: '', after: '' })
      const none = fl.diffTextLines({})
      return same.added === 0 && same.removed === 0 && same.lines.length === 0 && same.same === true && same.changed === false
        && crlf.added === 0 && crlf.removed === 0 && crlf.lines.length === 0
        && tail.added === 0 && tail.removed === 0 && tail.lines.length === 0
        && cr.added === 0 && cr.removed === 0
        && empty.added === 0 && empty.lines.length === 0
        && none.added === 0 && none.lines.length === 0
        // 归一那两下就是"CRLF 与结尾换行当同一件事"的**唯一落点**（⛔ 别在别处再归一一次）
        && fl.normalizeDiffText('甲\r\n乙\r\n') === '甲\n乙'
        && fl.normalizeDiffText('甲\n') === '甲'
        && fl.diffLinesOf('') .length === 0 && fl.diffLinesOf('甲\n乙').join(',') === '甲,乙'
        // ★ 反证：不归一（直接拿原文比）⇒ 上面那条"CRLF 算同文"必红
        && '甲\n乙\n' !== '甲\r\n乙\r\n'
    })())

  check('A2 加一行 / 删一行各一相：增删各自如实计数，且**改动那两行**连上下文一起给出来',
    (() => {
      const add = fl.diffTextLines({ before: '甲\n乙\n丙\n', after: '甲\n乙\n新\n丙\n' })
      const del = fl.diffTextLines({ before: '甲\n乙\n丙\n', after: '甲\n丙\n' })
      const addOk = add.added === 1 && add.removed === 0 && add.changed === true
        && add.lines.filter((l) => l.t === '+').length === 1 && add.lines.filter((l) => l.t === '+')[0].text === '新'
        && add.lines.filter((l) => l.t === '-').length === 0
      const delOk = del.added === 0 && del.removed === 1
        && del.lines.filter((l) => l.t === '-').length === 1 && del.lines.filter((l) => l.t === '-')[0].text === '乙'
        && del.lines.filter((l) => l.t === '+').length === 0
      // 上下文：三条短文件 ⇒ 全都带出来了（`' '` 那些是上下文，⛔ 不是"改了"）
      const ctxOk = add.lines.some((l) => l.t === ' ' && l.text === '甲') && add.lines.some((l) => l.t === ' ' && l.text === '丙')
      return addOk && delOk && ctxOk
    })())

  check('A3 上下文与省略：改动之外的远处那段**不吐出来**，中间折成一条 `@` 省略标记；`context` 可调',
    (() => {
      const before = Array.from({ length: 40 }, (_, i) => 'L' + String(i + 1))
      const after = before.slice()
      after[19] = 'L20 改过'      // 第一处改动（前后都有没变的那一大段）
      after[34] = 'L35 改过'      // 第二处改动 ⇒ 两处之间那一大段应当折成**一条**省略标记
      const d = fl.diffTextLines({ before: before.join('\n'), after: after.join('\n') })
      const marks = d.lines.filter((l) => l.t === '@')
      const head = d.lines.filter((l) => l.t === ' ' && l.text === 'L1')
      const ctx = d.lines.filter((l) => l.t === ' ')
      const d0 = fl.diffTextLines({ before: before.join('\n'), after: after.join('\n'), context: 0 })
      return d.added === 2 && d.removed === 2 && d.truncated === false
        && marks.length === 2 && marks[0].text.includes('跳过') && marks[1].text.includes('跳过')
        && marks[0].text.includes('16') && marks[1].text.includes('8')    // 开头的 16 行、两处之间的 8 行
        && head.length === 0                                             // ★ 开头那 16 行没吐出来（只给上下文）
        && ctx.length === 12                                             // 两处改动各留前后 3 行（默认 FLOOR_DIFF_CONTEXT = 3）
        && d0.lines.filter((l) => l.t === ' ').length === 0               // `context:0` ⇒ 一行上下文都不给
        && fl.FLOOR_DIFF_CONTEXT === 3
        // ★ 反证：把 `context` 当成"无穷大"（全给出来）⇒ 上面"开头那 16 行没吐出来"必红
        && fl.diffTextLines({ before: before.join('\n'), after: after.join('\n'), context: 100 })
          .lines.filter((l) => l.t === ' ').length === 38
    })())

  check('A4 截断三样（行数 / 字节 / 单行超长）都**如实标 `truncated`**，且 `total` 说的是"本该有多少行"（⛔ 不静默给一半）',
    (() => {
      // ① 行数：整份换掉 ⇒ 改动行数远超上限
      const many = fl.diffTextLines({
        before: '', after: Array.from({ length: fl.FLOOR_DIFF_MAX_LINES + 50 }, (_, i) => 'x' + String(i)).join('\n'),
      })
      // ② 单行超长：一行 5000 字
      const longLine = fl.diffTextLines({ before: '甲\n', after: '甲\n' + '很'.repeat(5000) + '\n' })
      // ③ 常量本身（面板/文档要跟它对得上）
      return many.truncated === true && many.lines.length === fl.FLOOR_DIFF_MAX_LINES && many.total > many.lines.length
        && many.added === fl.FLOOR_DIFF_MAX_LINES + 50
        && longLine.truncated === true && longLine.lines.some((l) => l.text.length === fl.FLOOR_DIFF_LINE_MAX_CHARS)
        && fl.FLOOR_DIFF_MAX_LINES === 400 && fl.FLOOR_DIFF_MAX_BYTES === 48 * 1024 && fl.FLOOR_DIFF_LINE_MAX_CHARS === 400
        // ★ 反证：把"行数上限"当没有（不看 truncated）⇒ 上面第一条必红
        && (many.lines.length < many.total) === true
    })())

  check('A5 `diffFloorFiles` 六种 `kind` 逐相：changed / same / absent / not-target / deadzone / unreadable（⛔ 读不出来绝**不**画成"没改动"）',
    (() => {
      const T = { name: 'T' }
      const texts = { aa: '甲\n乙\n', bb: '甲\n乙\n丙\n', cc: '甲\n乙\n', dd: '甲\n乙\n丙\n' }
      const keep = new Map(Object.entries(texts))
      const textOf = (sha) => (keep.has(sha) ? keep.get(sha) : null)
      const target = {
        nodeId: 'n2', variantId: 'v2',
        files: [
          { name: 'notes.md', sha256: 'bb', bytes: 9, changed: true },        // 与 before 不同 ⇒ changed
          { name: 'index.md', sha256: 'aa', bytes: 6, changed: false },       // 两侧同文 ⇒ same
          { name: 'state.md', sha256: null, bytes: null, changed: false },    // 这一条没有它 ⇒ absent
          { name: 'characters.md', sha256: 'dd', bytes: 9, changed: true },   // 有死区 ⇒ deadzone（+ diff 照给）
          { name: 'world.md', sha256: '不在 blob 里', bytes: 9, changed: true }, // 读不出来 ⇒ unreadable
          { name: 'rulebook.md', sha256: 'aa', bytes: 6, changed: false },    // 不在那 5 份里 ⇒ not-target
        ],
      }
      const before = {
        nodeId: 'n1', variantId: 'v1',
        files: [
          { name: 'notes.md', sha256: 'aa', bytes: 6 }, { name: 'index.md', sha256: 'aa', bytes: 6 },
          { name: 'characters.md', sha256: 'aa', bytes: 6 }, { name: 'world.md', sha256: 'aa', bytes: 6 },
          { name: 'rulebook.md', sha256: 'aa', bytes: 6 },
        ],
      }
      const r = fl.diffFloorFiles({ target, base: before, textOf, deadFiles: ['characters.md'] })
      const g = (n) => lineOf(r.files, n)
      return r.files.length === 6
        && g('notes.md').kind === 'changed' && g('notes.md').added === 1 && g('notes.md').removed === 0
        && g('index.md').kind === 'same' && g('index.md').lines.length === 0
        && g('state.md').kind === 'absent' && g('state.md').reason !== '' && g('state.md').added === 0
        && g('characters.md').kind === 'deadzone' && g('characters.md').reason.includes('死区')
        && g('characters.md').added === 1                              // 死区那一份的 diff **照给**（"爱做不做"，这里做了）
        && g('world.md').kind === 'unreadable' && g('world.md').reason !== '' && g('world.md').lines.length === 0
        && g('rulebook.md').kind === 'not-target' && g('rulebook.md').reason !== ''
        && r.added === 2 && r.removed === 0 && r.truncated === false
        // ★ 那 5 份的名单顺序在前（⛔ 不按清单顺序漂）
        && r.files.slice(0, 5).map((f) => f.name).join(',') === fl.FLOOR_FILES.join(',')
        // ★ 反证：把"读不出来"折成"没改动"（`textOf` 读不到就当成空串）⇒ 上面那条必红
        && fl.diffFloorFiles({ target, base: before, textOf: (s) => textOf(s) ?? '', deadFiles: ['characters.md'] })
          .files.find((f) => f.name === 'world.md').kind === 'changed'
        // 没有比的那一条 / 认不出的 target ⇒ 空数组（调用方如实说"没有可比的"）
        && fl.diffFloorFiles({ target, base: null, textOf }).files.length === 0
        && fl.diffFloorFiles({ target: null, base: before, textOf }).files.length === 0
    })())

  check('A6 这一族也在**导出清单**里（具名 + `export default`；⛔ 漏一个名字就是"没接线"）',
    typeof fl.diffTextLines === 'function' && typeof fl.diffFloorFiles === 'function'
    && typeof fl.normalizeDiffText === 'function' && typeof fl.diffLinesOf === 'function'
    && typeof floorDfl.diffTextLines === 'function' && typeof floorDfl.diffFloorFiles === 'function'
    && (() => {
      const mod = readFileSync(join(ROOT, 'lib', 'floor-snapshot.js'), 'utf8')
      const dflt = mod.slice(mod.indexOf('export default {'))
      return dflt.includes('diffTextLines') && dflt.includes('diffFloorFiles')
        // ★ 反证：把默认导出里那行挖掉 ⇒ 这条必红
        && (() => {
          const dug = mod.replace('normalizeDiffText, diffLinesOf, diffTextLines, diffFloorFiles,', '')
          return !dug.slice(dug.indexOf('export default {')).includes('diffFloorFiles')
        })()
    })())

  // ═════════════════════════════════════════════════════════════════════════
  sect('B 端点（真 HTTP）：GET …/floors/diff');

  {
    writeFloors()
    // ── 相①：缺省 = 比"时间上紧随其前的那一条"（序号 2 vs 序号 1）───────────────────
    const d2 = await diffOf(NODES[1], VAR(NODES[1]))
    check('B1 ★ 缺省 = 比**时间上紧接着它的前一条**（宿主按 `ordinal` 自己挑，⛔ 面板不挑）',
      d2.status === 200 && d2.data.ok === true
      && d2.data.floor !== null && d2.data.floor.ordinal === 2 && d2.data.floor.seq === 2
      && d2.data.against !== null && d2.data.against.nodeId === NODES[0] && d2.data.against.ordinal === 1
      && d2.data.againstSource === 'prev'
      && String(d2.data.message).includes('序号 2') && String(d2.data.message).includes('序号 1')
      && Array.isArray(d2.data.files) && d2.data.files.length === 5
      && Array.isArray(d2.data.deadFiles) && d2.data.deadzonesReadable === true,
      JSON.stringify([d2.status, d2.data && d2.data.message, d2.data && d2.data.against]))
    check('B1b ★★ 逐份逐行都是**真内容**（增行/删行；⛔ 不是"改了哪几份"那句话）',
      (() => {
        const n = lineOf(d2.data.files, 'notes.md')
        const i = lineOf(d2.data.files, 'index.md')
        const s = lineOf(d2.data.files, 'state.md')
        const w = lineOf(d2.data.files, 'world.md')
        const c = lineOf(d2.data.files, 'characters.md')
        return n.kind === 'changed' && n.added === 1 && n.removed === 0
          && n.lines.some((l) => l.t === '+' && l.text === '第四段（新加的一行）')
          && i.kind === 'same' && i.lines.length === 0 && i.added === 0 && i.removed === 0
          // ★ `state.md` 两侧**只有换行风格不同**（盘上那份是 CRLF）⇒ 必须算"逐字节一样"
          && s.kind === 'same' && s.lines.length === 0
          && w.kind === 'absent' && w.reason !== '' && w.lines.length === 0
          && c.kind === 'changed' && c.added === 1 && c.lines.some((l) => l.t === '+' && l.text.includes('乙（又来了一个）'))
      })(), JSON.stringify(d2.data.files.map((f) => f.name + ':' + f.kind + ':+' + String(f.added) + '/-' + String(f.removed))))
    // ── 相②：超长那一份 ⇒ `truncated` 如实 ────────────────────────────────────────
    const d3 = await diffOf(NODES[2], VAR(NODES[2]))
    check('B2 ★ 最新那一条（序号 3 vs 序号 2）：超长那一份**如实说"截断了"**（`total` > 给出来的行数），端点也带 `truncated`',
      d3.status === 200 && d3.data.ok === true && d3.data.floor.ordinal === 3 && d3.data.against.ordinal === 2
      && d3.data.truncated === true
      && (() => {
        const n = lineOf(d3.data.files, 'notes.md')
        return n.truncated === true && n.total > n.lines.length && n.lines.length > 0 && n.added > 0
      })(), JSON.stringify([d3.data.truncated, (lineOf(d3.data.files, 'notes.md') || {}).total]))
    // ── 相③：最早的那一条 ⇒ **不是错误**：`against:null` ＋ 一句人话 ────────────────────
    const d1 = await diffOf(NODES[0], VAR(NODES[0]))
    check('B3 ★ 最早的那一条：`ok:true` + `against:null` + 一句"没有可比的"（⛔ 不画成"没改动"、⛔ 也不报成错）',
      d1.status === 200 && d1.data.ok === true && d1.data.floor.ordinal === 1
      && d1.data.against === null && Array.isArray(d1.data.files) && d1.data.files.length === 0
      && String(d1.data.message).includes('最早的一条') && String(d1.data.message).includes('没有可比的'),
      JSON.stringify([d1.status, d1.data && d1.data.message]))
    // ── 相④：`against` 显式指定（"跟任意一条比"那个口子）─────────────────────────────
    const named = await diffOf(NODES[2], VAR(NODES[2]), '&against=' + encodeURIComponent(NODES[0]) + '&againstVariant=' + encodeURIComponent(VAR(NODES[0])))
    check('B4 ★ `against` / `againstVariant` 显式给：就比那一条（`againstSource:"named"`，那句人话也照实说是"你指定的"）',
      named.status === 200 && named.data.ok === true
      && named.data.against !== null && named.data.against.nodeId === NODES[0] && named.data.against.ordinal === 1
      && named.data.againstSource === 'named'
      && String(named.data.message).includes('你指定的')
      // 不带 `againstVariant` 时取那一楼的**第一条**（"跟任意一条比"的口子）
      && (await diffOf(NODES[2], VAR(NODES[2]), '&against=' + encodeURIComponent(NODES[0]))).data.against.nodeId === NODES[0],
      JSON.stringify([named.status, named.data && named.data.message]))
    // ── 相⑤：认不出 / 认不出的 `against` ⇒ `ok:false` ＋ **可读原因**（⛔ 不许静默）──────
    const noFloor = await diffOf('不在清单里', 'v9')
    const noAgainst = await diffOf(NODES[2], VAR(NODES[2]), '&against=不在清单里')
    const self = await diffOf(NODES[2], VAR(NODES[2]), '&against=' + encodeURIComponent(NODES[2]) + '&againstVariant=' + encodeURIComponent(VAR(NODES[2])))
    const noId = await call('GET', '/playthrough/rp-memory/floors/diff')
    check('B5 ★ 认不出（清单里没有这一条 / `against` 指的那条不在 / 跟它自己比 / 压根没带 nodeId）⇒ `ok:false` ＋ **可读原因**',
      noFloor.status === 200 && noFloor.data.ok === false && String(noFloor.data.error.message).length > 5
      && noAgainst.data.ok === false && String(noAgainst.data.error.message).includes('不在楼层清单里')
      && self.data.ok === false && String(self.data.error.message).includes('自己')
      && noId.data.ok === false && String(noId.data.error.message).includes('nodeId'),
      JSON.stringify([noFloor.data.error && noFloor.data.error.code, noAgainst.data.error && noAgainst.data.error.code, self.data.error && self.data.error.code, noId.data.error && noId.data.error.code]))
    // ── 相⑥：死区那一份**必须标出来** ──────────────────────────────────────────────
    writeDeadzones([['characters.md', CHARS_2]])
    const withZone = await diffOf(NODES[1], VAR(NODES[1]))
    const zoneRow = lineOf(withZone.data.files, 'characters.md')
    check('B6 ★ 有死区的那一份 ⇒ `kind:"deadzone"` ＋ 一句"按块合并"（⛔ 不许假装它跟别的一样）',
      withZone.status === 200 && withZone.data.ok === true && withZone.data.deadzonesReadable === true
      && Array.isArray(withZone.data.deadFiles) && withZone.data.deadFiles.includes('characters.md')
      && zoneRow.kind === 'deadzone' && zoneRow.reason.includes('按块合并'),
      JSON.stringify([zoneRow.kind, zoneRow.reason]))
    // 死区数据读坏 ⇒ `deadzonesReadable:false`（面板据此说"标记可能不全"，⛔ 不许当"都没有死区"）
    writeFileSync(join(PT_MEM, dz.DEADZONE_FILE_NAME), '{ 这不是 JSON')
    const zoneBad = await diffOf(NODES[1], VAR(NODES[1]))
    check('B6b ★ 死区数据**读不出来** ⇒ `deadzonesReadable:false`（⛔ 不许静默当成"哪份都没死区"）',
      zoneBad.data.ok === true && zoneBad.data.deadzonesReadable === false && zoneBad.data.deadFiles.length === 0)
    // ── 相⑦：**纯只读**（整棵记忆库目录逐字节没动；⚠️ 指纹要在下面那几脚**之前**现取）──
    const beforeRead = memTree()
    await diffOf(NODES[1], VAR(NODES[1]))
    await diffOf(NODES[2], VAR(NODES[2]))
    await diffOf(NODES[0], VAR(NODES[0]))
    await diffOf('不在清单里', 'v9')
    check('B7 ★★ 这几脚**纯只读**：整棵记忆库目录（含我们那份清单）逐字节没动',
      JSON.stringify(memTree()) === JSON.stringify(beforeRead),
      JSON.stringify([beforeRead.length, memTree().length]))
    check('B7b ★ 端点只认 GET（写方法 ⇒ 405；⛔ 不给它留任何写面）',
      (await call('POST', '/playthrough/rp-memory/floors/diff', {})).status === 405)
  }

  // ═════════════════════════════════════════════════════════════════════════
  sect("C 两种「对齐」回执的**序号**口径（用户口径「改成：当前记忆从【序号】改为【序号】」）")

  {
    // ── 相①：`mode:'full'`（对齐楼层）⇒ `当前记忆从【序号 A】改为【序号 B】` ──────────────
    writeFloors()
    writeTwoFloors(pendingTo(NODES[2], 3))
    const full = await call('POST', '/playthrough/rp-memory/floors/pending/settle', { mode: 'full' })
    check("C1 ★ 「对齐楼层」（`mode:'full'`）：回执 = `当前记忆从【序号 1】改为【序号 3】`（A = 一脚之前指针那一行、B = 这一脚之后）",
      full.status === 200 && full.data.ok === true && full.data.changed === true && full.data.mode === 'full'
      && full.data.beforeOrdinal === 1 && full.data.settledOrdinal === 3
      && String(full.data.message) === '当前记忆从【序号 1】改为【序号 3】',
      JSON.stringify([full.status, full.data && full.data.message, full.data && full.data.beforeOrdinal, full.data && full.data.settledOrdinal]))
    check('C1b ★ 那句话里**不再出现「楼」**、也⛔ 不复述"那 5 份一个字节都没写"（用户点名删过这类说明）',
      !String(full.data.message).includes('楼') && !String(full.data.message).includes('一个字节'),
      JSON.stringify(full.data.message))
    // ── 相②：`mode:'number'`（只对齐楼号）⇒ 只把指针从【序号 A】改为【序号 B】… ──────────
    writeTwoFloors(pendingTo(NODES[0], 1))
    const num = await call('POST', '/playthrough/rp-memory/floors/pending/settle', { mode: 'number' })
    check("C2 ★ 「只对齐楼号」（`mode:'number'`）：回执 = `只把指针从【序号 1】改为【序号 1】（这一条先不长快照，下一轮会自然记上）`",
      num.status === 200 && num.data.ok === true && num.data.changed === true && num.data.mode === 'number'
      && String(num.data.message) === '只把指针从【序号 1】改为【序号 1】（这一条先不长快照，下一轮会自然记上）'
      && !String(num.data.message).includes('楼'),
      JSON.stringify([num.status, num.data && num.data.message]))
    // ── 相③：**旧值认不出 ⇒ 不写 0**（没有旧指针那一相）──────────────────────────────
    writeTwoFloors(pendingTo(NODES[2], 3), null)
    const noOld = await call('POST', '/playthrough/rp-memory/floors/pending/settle', { mode: 'full' })
    check('C3 ★★ 旧值认不出（压根没有旧指针）⇒ 如实说 `当前记忆改为【序号 3】` —— ⛔ **不编 0**、⛔ 不写成"从【序号 0】"',
      noOld.status === 200 && noOld.data.ok === true
      && noOld.data.beforeOrdinal === null && noOld.data.settledOrdinal === 3
      && String(noOld.data.message) === '当前记忆改为【序号 3】'
      && !String(noOld.data.message).includes('序号 0') && !String(noOld.data.message).includes('从【序号'),
      JSON.stringify([noOld.data.beforeOrdinal, noOld.data.message]))
    // ── 相④：`mode:'number'` 时**那一行本来就有才是"拿得到"**；拿不到 ⇒ 如实"序号未知" ────
    writeTwoFloors(pendingTo(NODES[2], 3), null)
    const numUnknown = await call('POST', '/playthrough/rp-memory/floors/pending/settle', { mode: 'number' })
    check('C4 ★ 「只对齐楼号」那一脚**不记新行** ⇒ 那一行不在清单里时序号拿不到 ⇒ 如实写「序号未知」（⛔ 不编 0）',
      numUnknown.status === 200 && numUnknown.data.ok === true && numUnknown.data.settledOrdinal === null
      && String(numUnknown.data.message).includes('【序号未知】') && !String(numUnknown.data.message).includes('序号 0'),
      JSON.stringify([numUnknown.data.settledOrdinal, numUnknown.data.message]))
    // ── 相⑤：反证 —— 这条回执**不是**老口径（老那句里有"第 N 楼"与"那 5 份一个字节都没写"）────
    check('C5 ★ 反证：老口径那句（「已『对齐楼层』（就地登记）：档案就地认成第 N 楼…⛔ 那 5 份笔记的正文一个字节都没写」）**一个字都不在了**',
      (() => {
        const mod = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
        // 老那句里两个不可能再出现的片段（"就地认成"与"只把账对齐了"）
        return !mod.includes('档案就地认成') && !mod.includes('只把账对齐了')
          // ★ 而新口径那句在源码里逐字在（两半：有旧值与没旧值）
          && mod.includes('? `当前记忆改为${toSeat}`')
          && mod.includes(': `当前记忆从${fromSeat}改为${toSeat}`')
      })())
  }

  // ═════════════════════════════════════════════════════════════════════════
  sect('F 推给浮层的那一帧（SSE）：`pendingOrdinals` 也搭过去（浮层标题按它说「序号 N」）')

  {
    // 现场：站在第 3 楼建立基线（`seen ← 第 3 楼`）⇒ 退回第 1 楼 ⇒ 喂一次 watcher 事件。
    writeFloors()
    writeTimeline(NODES[2])
    await call('POST', '/playthrough/rp-memory/floors/scan', {})       // 建基线（那一脚会写 seen 与那条 pending）
    await call('POST', '/playthrough/rp-memory/floors/pending/ack', {})// 把提示收掉（下一脚才好重新判成 fork）
    // 连一条 SSE（★ 只为"有一个订阅者" —— 判据读的是**推出去的那一帧本身**，见下）
    //   ⚠️ 2026-09-25 改法（复核那一单）：原先是"客户端收帧"来验的。实测记在这里，⛔ 不是随口：
    //     宿主侧确实把那一帧写给了在连的那一个订阅者（临时探针读数：`wrote id=1 bytes=534`、
    //     `subscribers:1`、`pushed=1`），但**这条台子的假服务器 + undici 客户端**在那条流上
    //     只收到过 hello 那一块（隔离验过：两段式写 + 同一套头，在最小例子里两块都收得到
    //     ⇒ 是这条台子链路的怪癖）。所以判据改成读 `__floorSseLastFrame()`：**确定性**、
    //     钉的还是同一件事（"推给浮层的那一帧里带着三个序号"），⛔ 不靠跨进程流式的时序。
    const ctl = new AbortController()
    const resp = await fetch(`${base}/playthrough/rp-memory/floors/events`, { signal: ctl.signal })
    const reader = resp.body.getReader()
    const hello = await reader.read()                                   // 认下这条连接真的接上了
    writeTimeline(NODES[0])                                             // ★ 剧情退回第 1 楼（不碰任何端点）
    const fed = feed('timeline.json')
    await new Promise((r) => setTimeout(r, 900))                        // 去抖 300ms + 异步那一脚
    const fork = __floorSseLastFrame()
    const view = (await call('GET', '/playthrough/rp-memory/floors')).data
    check('F1 ★ 推出去的那一帧里除了 `pending`，还带着**三个序号** `pendingOrdinals`（浮层标题按它说「序号 N」）',
      fed >= 1 && watchers.length > 0 && hello.done !== true && __floorSseStats().subscribers === 1
      && fork !== null && typeof fork.pending === 'object' && fork.pending !== null
      && fork.pendingOrdinals !== null && typeof fork.pendingOrdinals === 'object'
      && view.pendingOrdinals !== null
      && JSON.stringify(fork.pendingOrdinals) === JSON.stringify(view.pendingOrdinals)
      // 此刻清单里三条（第 1 楼 = 序号 1、第 2 楼 = 序号 2、第 3 楼 = 序号 3）
      // ⇒ from = 3（剧情之前站的）、to = 1（现在站的）、archive = 3（档案停在的那一条）
      && fork.pendingOrdinals.from === 3 && fork.pendingOrdinals.to === 1 && fork.pendingOrdinals.archive === 3
      // ⛔ 那三个键**不在** `pending` 里（那条账逐字照投影 —— 与盘上那条一致是硬判据）
      && fork.pending.fromOrdinal === undefined && fork.pending.toOrdinal === undefined
      && view.pending.fromOrdinal === undefined,
      JSON.stringify({ fork: fork && fork.pendingOrdinals, view: view.pendingOrdinals }))
    try { ctl.abort() } catch { /* 已经断了 */ }
    await new Promise((r) => setTimeout(r, 200))
  }

  // ═════════════════════════════════════════════════════════════════════════
  sect('E 纪律静态核对（这一单只加了一条**只读**端点；⛔ 不碰别的）')

  {
    const mod = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
    const seg = mod.slice(mod.indexOf('function handleRpMemoryFloorDiff('), mod.indexOf('function floorsView('))
    check('E1 ★ 那条端点在**具名处理函数**里，而且**只读**：不出现任何写盘调用',
      seg.length > 0
      && !/writeFileSync|renameSync|mkdirSync|writeIndex|writeBlob|settlePending|restoreFloor|syncFloor|writeSeenHead/.test(seg)
      && seg.includes('readIndex') && seg.includes('readBlob'),
      seg.length === 0 ? '找不到那段' : '')
    check('E2 ★ 端点表与路由都接了（`/floors/diff` 只认 GET）',
      mod.includes("'/playthrough/rp-memory/floors/diff': ['GET'],")
      && mod.includes("if (rest === '/playthrough/rp-memory/floors/diff') return handleRpMemoryFloorDiff(send, url)"))
    check('E3 ★ 这一单没碰别的端点：那几条老端点的表项逐字未动',
      mod.includes("'/playthrough/rp-memory/floors': ['GET'],")
      && mod.includes("'/playthrough/rp-memory/floors/scan': ['POST'],")
      && mod.includes("'/playthrough/rp-memory/floors/events': ['GET'],")
      && mod.includes("'/playthrough/rp-memory/floors/restore': ['POST'],")
      && mod.includes("'/playthrough/rp-memory/floors/pending/settle': ['POST'],")
      && mod.includes("'/playthrough/rp-memory/floors/pending/ack': ['POST'],"))
    check('E4 ★ 判据仍在纯函数里（⛔ 端点里没有自己写一份 diff 算法）',
      !seg.includes('while (') && !seg.includes('for (let i') && seg.includes('diffFloorFiles'))
    check('E5 ★ 临时目录清干净（这一档的台子不留垃圾）',
      (() => { rmSync(HOME, { recursive: true, force: true }); rmSync(WS, { recursive: true, force: true }); return !existsSync(HOME) && !existsSync(WS) })())
  }

  console.log(`\n== 总结：${pass} 通过 / ${failed} 失败 ==`)
  if (failed > 0) console.log('失败项见上面 ✘ 那几行。')
} finally {
  // ★ 先拆掉生产那条 watcher（它会把事件循环吊住 —— 与 `_selftest-floor-watch` 同款收尾）。
  try { __disposeFloorWatch() } catch { /* 拆不掉也只能算了 */ }
  try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections() } catch { /* 老 node */ }
  await new Promise((r) => server.close(r))
  rmSync(HOME, { recursive: true, force: true })
  rmSync(WS, { recursive: true, force: true })
}
process.exit(failed > 0 ? 1 : 0)
