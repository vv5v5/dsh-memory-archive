/**
 * _selftest-floor-snapshot.mjs —— 「**按楼层绑定**的笔记快照 + 回档跟随」的宿主半侧自检
 * （20260923 单：用户口径「能不能做按楼层绑定管理的功能，也就是每轮模型修改都记录，能自动跟随回档」；
 *  ★ 20260923 **补单**改了**两处口径**：快照锚 `nodeId` → **`(nodeId, variantId)`**（swipe 也算回档）、
 *  死区从"整份跳过" → **按块合并** —— 本台子按新口径钉，改过口径的那几条在注释里写明为什么改）。
 *
 * ★★ 20260924 **再补一单**（用户原话：「**不要做跟随楼层的功能，先做手动挡**，开 fork 时（回档）
 *  **前台弹提示，让用户手动回退剧情档案**。做**更显著的更改表示**」）⇒ 口径从"判到回档就自动把笔记
 *  写回去"改成"**判到回档只记一条待处理（pending）、那 5 份一个字节都不写**"，写盘只在人点了面板上
 *  那两个按钮之后。两个按钮：**「把档案退回第 N 楼」＝ `restoreFloor`（动正文）**；
 *  **「保持现状」＝ `settlePending`（就地登记 —— ⛔ 不动正文）**。
 *  ★ 20260924 收尾（用户口径：「跟 Tavern 一致 —— 回档之后那段历史就是没有了，记忆回档之后也直接按新的来。
 *  「保持现状」＝就地登记」）：`settlePending` 不能只清 `pending` —— 那样 `last` 停在后面，
 *  记录侧（只认 first/same/forward）**永远够不到** ⇒ ① 之后整段不记快照 ② 每推一楼重弹一条横幅。
 *  所以它必须**顺手把 `last` 锚到当前这一楼**（并把盘上现文记成那一楼那一份）。台子 §3-4 / D10i 钉的就是这个。
 *  改过口径的那几条台子都在注释里写明了为什么改（⛔ 老的没删）。
 *
 * ★★ 20260925 **再补一单**（用户原话：「另外，改一下选项，**1、对齐楼层 2、只对齐楼号 3、不处理**」；
 *  ＋「实测**档案回退弹窗 × 不掉**」；＋ 浮层里那句说明**整段去掉**）⇒ **同一脚多一个 `mode`**：
 *  `'full'`（缺省，＝「对齐楼层」，行为与从前**逐字一样**）／`'number'`（＝「只对齐楼号」：**只**锚 `last` ＋
 *  清 `pending`，⛔ 不记快照、⛔ 不写 blob、⛔ **不新增楼层行**）；`mode` **认不出 ⇒ 400**（⛔ 不许按 full 跑）。
 *  本台子新增那一族：**A16 / A16b**（`settleModeOf` 判据只此一处 ＋ 内核那层也拒）与 **G3a–G3g**
 *  （真 HTTP：`'number'` 零新增行/零新 blob · 下一轮自然记上 · 反证 `'full'` 当场长出新行 · 400 两相 ·
 *  缺省＝`'full'`）。`'full'` 那一侧的老断言**一条没删**（D10f–D10j / §3-4 / G1e–G1f 全在）。
 *
 * 六条主线（都按项目惯例：**相 + 反证成对**，⛔ 不只做源码字符串断言）：
 *   A 纯逻辑层（`lib/floor-snapshot.js` 直测：判该不该记 / 该不该回 / 恢复到哪一份 / 按块合并怎么合）；
 *   B 补单 §2 八对（**本单的新口径**：变体级记录 · 换变体也算回档 · 退回进楼前 · 前进不回档 ·
 *     死区按块合并（两个反证） · 死区读不出来整次不做 · 老条目只读不恢复 · 预置一律不碰）；
 *   C 上一单那八对（回归；改过口径的两条已按新口径改写，注释里写了为什么）；
 *   D 接线纪律 —— 走**真 HTTP** 与**真钩子**（假 ctx 驱动真 `apply()`）：每轮至多一次 / 不占本轮时间 /
 *     轮末才记 / 不刷屏 / 手动恢复与自动跟随**共用同一份** / 有哪一份写不进去就**如实**；
 *   E 纪律静态核对：只写那 5 份 + 我们自己的目录（⛔ 死区被判据约束、⛔ 预置、⛔ 会话/归档/Tavern 一个不碰）；
 *   F 本单 §3 六对（★ 2026-09-24 手动挡：判到回档**盘上零写入** / pending 幂等 / 手动才真写+清 pending /
 *     就地登记之后**记录无缝续上** / 预置与死区一律不碰 / 没有快照的楼层不写任何文件）。
 *
 * ★ 全部夹具都在**临时目录**里（`_selftest-home-floor` / `_selftest-ws-floor`），测完删掉；
 * ⛔ 全程不碰真机（`C:\Users\w\.dsh`）、⛔ 不碰用户的 RP 工作区（`D:\apps\dsh-tarven`）。
 */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { apply, __disposeFloorWatch } from './lib/index.js'
import * as fl from './lib/floor-snapshot.js'
// ★ 2026-09-24 收尾：默认导出那份清单也钉一下（`export default {...}` 漏一个名字是真实会犯的错）。
import floorDfl from './lib/floor-snapshot.js'
import * as dz from './lib/deadzone.js'

const ROOT = resolve('.')
const HOME = join(ROOT, '_selftest-home-floor')
const WS = join(ROOT, '_selftest-ws-floor')
const PREFIX = '/dsh-memory-archive/api'
const PT = join(WS, 'ch', 'pt')          // rootPlaythroughDir() = <rootPath>/<characterId>/<playthroughId>
const MEM = '.roleplay-memory'
const PT_MEM = join(PT, MEM)
const SESSION = 'sess-floor-1'

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
const NODES = ['qa-1-1-aaa', 'qa-2-2-bbb', 'qa-3-3-ccc', 'qa-4-4-ddd', 'qa-5-5-eee']
/** 某一楼第 k 支变体 id（k=1 时不带后缀 —— 与真机 `variant-<uuid>` 同形）。 */
const VAR = (id, k = 1) => 'variant-' + id + (k === 1 ? '' : '-v' + k)
/** 一楼的形状：真机那份（`{id, kind, displayOverride, parentVariantId, adoptedVariantId, variants[]}`）。 */
const nodeOf = (id, i, variants) => ({
  id, kind: 'qa',
  adoptedVariantId: variants[variants.length - 1],
  variants: variants.map((v) => ({ id: v, sessionId: SESSION, startEventId: i + 1, endEventId: i + 1, ext: {} })),
})
const VARIANTS_OF = (id) => [VAR(id), VAR(id, 2)]

/**
 * 写时间线（head = 站哪一楼**哪一支**）。
 * @param {string|null} headId 站在哪一楼
 * @param {string[]} ids `nodes[]` 有哪些楼（默认全部）
 * @param {string|null} headVariant 站在哪一支（默认这楼的第 1 支）
 * ⚠️ `ext.pad` 每写一次长一个字符：**故意让文件大小单调变化** —— 读侧按
 *   `路径|mtime|size` 缓存，同一毫秒里连写两次同一个 head 才不会命中旧缓存（夹具的确定性）。
 */
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
const readMem = (name) => { try { return readFileSync(join(PT_MEM, name), 'utf8') } catch { return null } }
const snapDir = () => join(PT_MEM, fl.FLOOR_DIR_NAME)
const indexPath = () => join(snapDir(), fl.FLOOR_INDEX_NAME)
const indexRaw = () => { try { return readFileSync(indexPath(), 'utf8') } catch { return null } }
const indexOnDisk = () => JSON.parse(indexRaw())
const indexOf = () => fl.readIndex(PT_MEM).index
const blobs = () => { try { return readdirSync(snapDir()).filter((n) => n !== fl.FLOOR_INDEX_NAME).sort() } catch { return [] } }
// ★ 2026-09-26（收纳）：备份改落 `.bak/` 子目录（lib/deadzone.js `backupNameFor`）⇒ 读法跟上。
const backups = () => { try { return readdirSync(join(PT_MEM, '.bak')).filter((n) => n.includes('.bak-')).sort() } catch { return [] } }
/** 清空一个夹具：记忆库整块删掉（含我们的快照目录与 .bak），时间线重写。
 *  ★ 2026-09-24 收尾：`seen` 那份簿记（`floor-head.json`）也清掉 —— 每个夹具从"**第一次见**"开始，
 *  ⛔ 不带着上一个夹具里认过的位置串场（那会让"判成 fork 还是 no-seen"漂开）。 */
function reset(files = {}, headId = NODES[0]) {
  rmSync(PT_MEM, { recursive: true, force: true })
  mkdirSync(PT_MEM, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeMem(name, text)
  writeTimeline(headId)
  rmSync(seenPath(), { force: true })
  return { files }
}
/** 死区那几条数据（与接线那一层 `floorDeadZones` **同一口径**：读不出来 ⇒ `null`）。 */
const zonesNow = () => {
  const r = dz.readDocFile(PT_MEM)
  return r.error !== null ? null : r.doc.zones
}

// ── ★★ 2026-09-24 收尾：`seen`（"上次认过的剧情位置"）那份簿记 ─────────────────────────────
//   ⚠️ 夹具里 `sync()` 是**直接**调 `syncFloor`（绕过钩子），而生产里读/写它的是接线那一层 ⇒ 这里
//   按**与宿主同一份口径**读/写**同一个文件**（`<storageDir>/floor-head.json`）：⛔ 不两处各造一份真相
//   （否则"面板点按钮之后 seen 跟到哪"这类断言会与生产行为漂开 —— 那份文件也是端点写的）。
const seenPath = () => join(HOME, 'dsh-memory-archive', 'floor-head.json')
const seenDoc = () => { try { return JSON.parse(readFileSync(seenPath(), 'utf8')) } catch { return null } }
const seenRaw = () => { try { return readFileSync(seenPath(), 'utf8') } catch { return null } }
/** 这个周目当下记着的 `seen`（认不出 ⇒ `null`；与宿主 `readSeenHead` 同一份归一）。 */
const seenNow = () => {
  const doc = seenDoc()
  const byPt = doc !== null && doc.byPlaythrough !== undefined && typeof doc.byPlaythrough === 'object' && doc.byPlaythrough !== null
    ? doc.byPlaythrough
    : null
  return byPt === null ? null : fl.normalizeSeen(byPt.pt)
}
/** 写 `seen`（★ 照宿主那条纪律：位置三样**一模一样**时**一个字都不写**）。 */
function seenWrite(head, seq) {
  const next = fl.normalizeSeen({ nodeId: head.nodeId, variantId: head.variantId, seq, at: '2026-09-23T10:00:00.000Z' })
  if (next === null) return false
  const prev = seenNow()
  if (prev !== null && prev.nodeId === next.nodeId && prev.variantId === next.variantId && prev.seq === next.seq) return false
  const doc = seenDoc()
  const byPt = doc !== null && doc.byPlaythrough !== undefined && typeof doc.byPlaythrough === 'object' && doc.byPlaythrough !== null
    ? Object.assign({}, doc.byPlaythrough)
    : {}
  byPt.pt = { nodeId: next.nodeId, variantId: next.variantId, seq: next.seq, at: next.at }
  mkdirSync(join(HOME, 'dsh-memory-archive'), { recursive: true })
  writeFileSync(seenPath(), JSON.stringify({ schemaVersion: 1, byPlaythrough: byPt }, null, 2) + '\n', 'utf8')
  return true
}

/**
 * 直接跑一次「楼同步」（与生产同一条 `syncFloor`；判据那一层用）。
 * ★ 2026-09-24 收尾：`seen` 与**宿主 `floorSyncAt` 同一份口径** —— 进来先读那份簿记喂进去，
 *   跑完按回执跟（`forward` / `no-seen` ⇒ `seen ← head`；`same` / `fork` ⇒ 不动）。
 * `opts.seen` 可覆盖"进来读到的那个基准"（反证/夹具用）；`opts.prevOf` 可覆盖"紧邻前一楼"那一步。
 */
function sync(mode = 'turn', opts = {}) {
  const timeline = JSON.parse(readFileSync(join(PT, 'timeline.json'), 'utf8'))
  const head = opts.head === undefined ? fl.headOf(timeline) : opts.head
  const seqMap = fl.seqMapOf(timeline)
  const order = fl.nodeOrderOf(timeline)
  const seq = fl.seqOfNode(seqMap, head === null ? '' : head.nodeId)
  const r = fl.syncFloor({
    memoryDir: PT_MEM, mode, head,
    seen: opts.seen === undefined ? seenNow() : opts.seen,
    seq,
    seqOf: (id) => fl.seqOfNode(seqMap, id),
    prevOf: opts.prevOf === undefined ? (id) => fl.prevNodeOf(order, id) : opts.prevOf,
    at: opts.at === undefined ? '2026-09-23T10:00:00.000Z' : opts.at,
    stamp: '2026-09-23T10-00-00-000Z',
    zones: opts.zones === undefined ? zonesNow() : opts.zones,
  })
  const k = r !== null && r.fork !== undefined && r.fork !== null ? r.fork.kind : null
  if ((k === 'forward' || k === 'no-seen') && head !== null) seenWrite(head, seq)
  return r
}

/** 夹具里"面板点了「对齐 / 退回」"之后手动补那一笔"**用户认过了**"（`seen ← 当前 head`）。
 *  ⚠️ 生产里这一笔是**端点**做的（`floorAcknowledge`）—— 夹具直接调库函数就少了它；
 *  ⛔ 不补的话夹具与生产行为就漂开了（后面那些"开 fork"的判断会跟着错）。 */
function ackManually() {
  const timeline = JSON.parse(readFileSync(join(PT, 'timeline.json'), 'utf8'))
  const head = fl.headOf(timeline)
  if (head === null) return false
  return seenWrite(head, fl.seqOfNode(fl.seqMapOf(timeline), head.nodeId))
}

/**
 * 夹具里的「把档案退回第 N 楼」那一脚 ＝ **生产里那条端点**（`POST …/floors/restore`）：
 * `restoreFloor` ＋（**真做成了才**）"认过了"那一笔。⛔ 失败 / 被死区挡住时**不认**（与端点同款）。
 */
function restoreViaPanel(o) {
  const r = fl.restoreFloor(o)
  const rest = r === null || r === undefined ? null : r.restore
  if (r !== null && r !== undefined && r.kind === 'manual' && rest !== null && rest !== undefined
    && (rest.failed ?? []).length === 0 && (rest.blocked ?? null) === null) ackManually()
  return r
}

/** 夹具里的「档案对齐到第 N 楼」那一脚 ＝ **生产里那条端点**（`POST …/floors/pending/settle`）。 */
function settleViaPanel(o) {
  const r = fl.settlePending(PT_MEM, o)
  if (r !== null && r !== undefined && r.ok === true && r.changed === true) ackManually()
  return r
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
/** 把这 5 份的现文读出来（"一个字节都没变"那种断言用）。 */
const fiveNow = () => Object.fromEntries(fl.FLOOR_FILES.map((n) => [n, readMem(n)]))

const V1 = { 'notes.md': '# 笔记\nv1\n', 'index.md': '# 索引\nv1\n', 'state.md': '# 状态\nv1\n' }
const V2 = { 'notes.md': '# 笔记\nv2 模型又写了一段\n', 'index.md': '# 索引\nv2\n', 'state.md': '# 状态\nv1\n' }
const V3 = { 'notes.md': '# 笔记\nv3\n', 'index.md': '# 索引\nv3\n', 'state.md': '# 状态\nv3\n' }
/** 同一楼**第 2 支**里模型写出来的样子（swipe 之后重跑的那一支）。 */
const V2B = { 'notes.md': '# 笔记\nv2 第 2 支的内容\n', 'index.md': '# 索引\nv2b\n', 'state.md': '# 状态\nv1\n' }
const putFiles = (files) => { for (const [n, t] of Object.entries(files)) writeMem(n, t) }

rmSync(HOME, { recursive: true, force: true })
rmSync(WS, { recursive: true, force: true })
mkdirSync(WS, { recursive: true })

// ── 假 ctx（能驱动真实的 apply()：两条钩子 + 两条端点都在场）─────────────────
const routes = []
const listeners = []   // { event, fn, who }
const sections = []    // 注册进来的段（name/order/text）
const logs = { info: [], warn: [], error: [] }
const webServer = { register: (route) => { routes.push(route); return () => {} } }
function makeScope(pluginName) {
  return {
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on: (event, fn) => { listeners.push({ event, fn, who: pluginName }); return () => {} },
    systemPrompt: { section: (s) => { sections.push(Object.assign({ who: pluginName }, s)); return () => {} } },
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
writeConfig()
writeTavern()
reset(V1)
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
const floorsView = async () => (await call('GET', '/playthrough/rp-memory/floors')).data
const statusFile = () => join(HOME, 'dsh-memory-archive', 'floor-status.json')
const statusAt = () => { try { return JSON.parse(readFileSync(statusFile(), 'utf8')).at } catch { return null } }
const statusDoc = () => { try { return JSON.parse(readFileSync(statusFile(), 'utf8')) } catch { return null } }
const floorLogs = () => logs.info.concat(logs.warn).filter((m) => m.includes('楼层快照'))
/** assemble 监听器（本插件那条）+ 驱动一轮（照 _selftest-deadzone 的 drive()）。 */
const assembleFns = () => listeners.filter((l) => l.event === 'system-prompt/assemble').map((l) => l.fn)
const eventFns = () => listeners.filter((l) => l.event === 'session/event').map((l) => l.fn)
async function drive(turn, opts = {}) {
  const aCtx = { agent: { session: { id: SESSION }, phase: { turn } } }
  let onNext = null
  for (const fn of assembleFns()) {
    let nexted = false
    await fn({ sections: [] }, aCtx, async () => { nexted = true; if (onNext === null) onNext = opts.snap === undefined ? true : opts.snap() })
    if (!nexted) throw new Error('某个 assemble 监听器没有调用 next()')
  }
  await new Promise((r) => setTimeout(r, 60))
  return onNext
}
/** 发一条会话事件（轮末 / 压缩末）。 */
async function fireEvent(type) {
  for (const fn of eventFns()) fn({ id: SESSION }, { type, data: {} })
  await new Promise((r) => setTimeout(r, 60))
}
/** 这份文件名是不是"那 5 份"里的一份（D 节静态核对里给"绝不写别处"用）。 */
const PRESET_NAMES = ['rulebook.md', '大纲-甲.md', '幻蕊示例.txt']

try {
  // ═════════════════════════════════════════════════════════════════════════
  sect('A 纯逻辑层（lib/floor-snapshot.js 直测）')

  check('A1 只认那 5 份：别的名字一律 false（whitelist 是唯一真相）',
    fl.isFloorFile('notes.md') && fl.isFloorFile('index.md') && fl.isFloorFile('state.md')
    && fl.isFloorFile('characters.md') && fl.isFloorFile('world.md')
    && !fl.isFloorFile('rulebook.md') && !fl.isFloorFile('大纲-1.md') && !fl.isFloorFile('世界观-甲.md')
    && !fl.isFloorFile('.dma-deadzones.json') && !fl.isFloorFile('') && !fl.isFloorFile(null)
    && fl.FLOOR_FILES.length === 5)

  check('A2 时间线：head / 楼层序号（`nodes[]` 位置，1 起）/ 紧邻前一楼 / 认不出 ⇒ null',
    (() => {
      const tl = JSON.parse(readFileSync(join(PT, 'timeline.json'), 'utf8'))
      const head = fl.headOf(tl)
      const seq = fl.seqMapOf(tl)
      const order = fl.nodeOrderOf(tl)
      return head.nodeId === NODES[0] && head.variantId === VAR(NODES[0]) && head.sessionId === SESSION
        && fl.seqOfNode(seq, NODES[2]) === 3 && fl.seqOfNode(seq, '不在里面') === null
        && fl.headOf(null) === null && fl.headOf({ head: {} }) === null && fl.headOf({ head: { nodeId: '' } }) === null
        && fl.seqOfNode(fl.seqMapOf({ nodes: [null, { id: 'a' }, { id: 'a' }, { id: 'b' }] }), 'b') === 4
        // ★ 新增：`nodes[]` 顺序 + "紧邻前一楼"（退回进楼前那一步靠它，⛔ 不拿时间戳猜）
        && order.join(',') === NODES.join(',')
        && fl.prevNodeOf(order, NODES[2]) === NODES[1] && fl.prevNodeOf(order, NODES[0]) === null
        && fl.prevNodeOf(order, '不在里面') === null && fl.nodeOrderOf(null).length === 0
    })())

  check('A3 清单归一：认不出的楼层/文件一律丢弃；同一 `(nodeId, variantId)` 只留最后一条；老条目读得出来但标成"不知道哪一支"',
    (() => {
      const idx = fl.normalizeIndex({
        last: { nodeId: 'n1', variantId: 'v1', seq: 1 },
        floors: [
          { nodeId: 'n1', variantId: 'v1', files: [{ name: 'notes.md', sha256: 'aa', bytes: 3, changed: true }, { name: 'rulebook.md', sha256: 'zz' }] },
          { nodeId: '' },
          null,
          // ★ 同一 `(N,V)` 再记一次 ⇒ **覆盖**（与"同一 nodeId 只留最后一条"同款纪律）
          { nodeId: 'n1', variantId: 'v1', files: [{ name: 'notes.md', sha256: 'bb', bytes: 4, changed: true }] },
          // ★ 同一楼**另一支** ⇒ 另一条（互不覆盖）
          { nodeId: 'n1', variantId: 'v2', files: [{ name: 'notes.md', sha256: 'cc', bytes: 5, changed: true }] },
          // ★ 上一版形状的老条目：只有 nodeId ⇒ 读得出来、但不是任何一支
          { nodeId: 'n2', files: [{ name: 'notes.md', sha256: 'dd', bytes: 6, changed: true }] },
        ],
      })
      const n1 = fl.floorsOfNode(idx, 'n1')
      return idx.floors.length === 3 && n1.length === 2
        && n1[0].variantId === 'v1' && n1[0].files.length === 1 && n1[0].files[0].sha256 === 'bb'
        && n1[1].variantId === 'v2' && n1[1].files[0].sha256 === 'cc'
        && idx.last.nodeId === 'n1' && idx.last.variantId === 'v1'
        && fl.floorOfVariant(idx, 'n1', 'v2').files[0].sha256 === 'cc'
        && fl.floorOfVariant(idx, 'n1', 'v9') === null
        && fl.floorOfVariant(idx, 'n2', 'v1') === null                     // ⛔ 老条目不算"某一支"
        && fl.floorOfVariant(idx, 'n2', '').nodeId === 'n2'
        && fl.isLegacyFloor(fl.floorOfVariant(idx, 'n2', '')) === true
        && fl.isRestorableFloor(fl.floorOfVariant(idx, 'n2', '')) === false
        && fl.isRestorableFloor(n1[1]) === true
        && fl.normalizeIndex({ floors: [{ nodeId: 'x', variantId: 'v', files: [{ name: 'notes.md', sha256: null, bytes: null, changed: true }] }] })
          .floors[0].files[0].sha256 === null
    })())

  check('A4 planRecord：空基 ⇒ 有的那几份全 changed；"两边都没有"不算变化；byte 差值如实；条目带 `(nodeId, variantId)`',
    (() => {
      const r = fl.planRecord({ head: { nodeId: 'n1', variantId: 'v9' }, seq: 1, at: 'T', fileTexts: { 'notes.md': 'A', 'index.md': 'B' }, base: null })
      const names = r.floor.files.map((f) => f.name)
      const changed = r.floor.files.filter((f) => f.changed).map((f) => f.name)
      const same = fl.planRecord({ head: { nodeId: 'n1', variantId: 'v9' }, seq: 1, at: 'T', fileTexts: { 'notes.md': 'A', 'index.md': 'B' }, base: r.floor })
      const back = fl.planRecord({ head: { nodeId: 'n2', variantId: 'v1' }, seq: 2, at: 'T', fileTexts: { 'notes.md': 'AB', 'index.md': 'B' }, base: r.floor })
      const md = back.floor.files.find((f) => f.name === 'notes.md')
      const ix = back.floor.files.find((f) => f.name === 'index.md')
      const none = fl.planRecord({ head: { nodeId: 'n3' }, seq: 3, at: 'T', fileTexts: {}, base: null })
      return names.length === 5 && names.join(',') === fl.FLOOR_FILES.join(',')
        && changed.join(',') === 'notes.md,index.md'
        && r.blobs.length === 2 && r.floor.variantId === 'v9'
        && same.changed === false && same.reason === 'no-change'
        && back.changed === true && back.blobs.length === 2
        && md.changed === true && md.delta === 1 && ix.changed === false && ix.delta === null
        && none.changed === false && none.blobs.length === 0      // 5 份一份都没有 ⇒ 别落一份空快照
        && fl.planRecord({ head: null, seq: null, at: 'T', fileTexts: { 'notes.md': 'A' }, base: null }).changed === false
    })())

  check('A5 missingBlobs：同 sha 只算一次、盘上已有的不算（内容寻址的真去重）',
    (() => {
      const list = [{ sha256: 'a', text: '1' }, { sha256: 'a', text: '1' }, { sha256: 'b', text: '2' }]
      const miss = fl.missingBlobs(list, (sha) => sha === 'b')
      return miss.length === 1 && miss[0].sha256 === 'a'
        && fl.missingBlobs(list, () => true).length === 0
    })())

  check('A6 planRestore 逐份裁决：只认那 5 份 / 那一楼没有的不写 / 逐字节一样的不写 / 正文找不到如实报 / **有死区的按块合并**（不再是整份跳过）',
    (() => {
      const A = '## 【核心规则】\n- 作者写的'
      const zone = dz.normalizeZone({ file: 'index.md', text: A, at: 'T' })
      const floor = {
        nodeId: 'n1', variantId: 'v1', seq: 1, at: 'T', files: [
          { name: 'notes.md', sha256: dz.sha256Hex('N'), bytes: 1, changed: true },
          { name: 'index.md', sha256: dz.sha256Hex(A + '\n\n# 索引\nv1\n'), bytes: 1, changed: true },
          { name: 'state.md', sha256: null, bytes: null, changed: true },
          { name: 'characters.md', sha256: dz.sha256Hex('C'), bytes: 1, changed: true },
          { name: 'world.md', sha256: dz.sha256Hex('W'), bytes: 1, changed: true },
        ],
      }
      const plan = fl.planRestore({
        floor,
        // 盘上现况：index.md 的非死区那段被模型改了；characters.md 与目标逐字节一样
        fileTexts: { 'notes.md': 'N', 'index.md': A + '\n\n# 索引\n模型改的\n', 'characters.md': 'C' },
        blobTexts: { [dz.sha256Hex('N')]: 'N', [dz.sha256Hex(A + '\n\n# 索引\nv1\n')]: A + '\n\n# 索引\nv1\n', [dz.sha256Hex('C')]: 'C' },
        zones: [zone],
      })
      const skipped = Object.fromEntries(plan.skipped.map((s) => [s.name, s.reason]))
      const ix = plan.writes.find((w) => w.name === 'index.md')
      return plan.blocked === null
        && plan.writes.length === 1
        && skipped['notes.md'] === 'unchanged' && skipped['state.md'] === 'absent-then'
        && skipped['characters.md'] === 'unchanged' && skipped['world.md'] === 'no-content'
        // ★ index.md 有死区 ⇒ **进 writes**（其余照快照），同时在 skipped 里如实标"按块合并"
        && ix !== undefined && ix.merged === true && ix.text === A + '\n\n# 索引\nv1\n'
        && skipped['index.md'] === 'deadzone'
        && plan.skipped.find((s) => s.name === 'index.md').merged === true
        && plan.skipped.find((s) => s.name === 'index.md').kept.length === 1
        && plan.writes.every((w) => fl.isFloorFile(w.name))
    })())

  check('A6b planRestore：死区**判据未知**（`zones:null` / 干脆不传）⇒ 整次不做（blocked，⛔ 一个字节都不写）',
    (() => {
      const floor = { nodeId: 'n1', variantId: 'v1', files: [{ name: 'notes.md', sha256: dz.sha256Hex('N'), bytes: 1, changed: true }] }
      const r = fl.planRestore({ floor, fileTexts: {}, blobTexts: { [dz.sha256Hex('N')]: 'N' }, zones: null })
      // ⛔ fail-closed：调用方**忘了带** zones 也按"判据未知"走（不许变成"那就整份写"）
      const forgot = fl.planRestore({ floor, fileTexts: {}, blobTexts: { [dz.sha256Hex('N')]: 'N' } })
      return r.blocked === 'deadzones-unreadable' && r.writes.length === 0 && r.skipped.length === 0
        && forgot.blocked === 'deadzones-unreadable' && forgot.writes.length === 0
    })())

  check('A6c mergeDeadzoneBlocks：非死区块照快照（含 CRLF 逐字节）· 死区块取盘上现况 · 找不到不补回 · 盘上有快照没有的保留',
    (() => {
      const A = '## 【核心规则】\r\n- 作者写的'
      const zone = dz.normalizeZone({ file: 'index.md', text: A, at: 'T' })
      // ① 没有死区 ⇒ 逐字节就是快照（⛔ 不归一换行、⛔ 不重排空行）
      const identity = fl.mergeDeadzoneBlocks({ snapText: 'A\r\n\r\n# B\n\n\n尾\n', nowText: 'x', zones: [] })
      // ② 死区块在盘上被改过（首行还在）⇒ **取盘上那一块**；非死区块照**快照**
      const snap = 'A1\r\n\r\n' + A + '\r\n\r\nB1\r\n'                       // A1 + 死区（作者版）+ B1
      const now = 'A1\r\n\r\n## 【核心规则】\r\n- 模型改的\r\n\r\nB3\r\n'      // A1 + 死区（模型版）+ B3
      const kept = fl.mergeDeadzoneBlocks({ snapText: snap, nowText: now, zones: [zone] })
      // ③ 盘上连这一段都没了 ⇒ 不补回（那一块连着它自己的空行一起省掉），其余照快照
      const gone = fl.mergeDeadzoneBlocks({ snapText: snap, nowText: 'A1\r\n\r\nB3\r\n', zones: [zone] })
      // ④ 盘上有、快照里没有 ⇒ 保留（补在末尾）+ 如实报
      const extra = fl.mergeDeadzoneBlocks({ snapText: 'A1\r\n\r\nB1\r\n', nowText: now, zones: [zone] })
      return identity.text === 'A\r\n\r\n# B\n\n\n尾\n' && identity.kept.length === 0
        && kept.text === 'A1\r\n\r\n## 【核心规则】\r\n- 模型改的\r\n\r\nB1\r\n' && kept.kept.length === 1
        && gone.text === 'A1\r\n\r\nB1\r\n' && gone.dropped.length === 1
        && extra.appended.length === 1
        // ★ 补在**末尾**（位置无从得知）：块正文取自盘上那一块，与原文逐字节一致
        && extra.text === 'A1\r\n\r\nB1\r\n\n## 【核心规则】\r\n- 模型改的'
    })(), 'mergeDeadzoneBlocks 的四种情形')

  check('A6d rawSpans：与 `deadzone.splitBlocks` **逐块对齐**，且按它拼回来逐字节等于原文（含 CRLF / 连续空行）',
    (() => {
      const texts = ['# A\r\nline2\r\n\r\n\r\n## B\n\n\n尾\n', '', '   \n\n', 'a\rb\rc', 'x\n']
      return texts.every((t) => {
        const spans = fl.rawSpans(t)
        const blocks = dz.splitBlocks(t)
        if (spans.length !== blocks.length) return false
        const body = (i) => t.slice(spans[i].start, spans[i].bodyEnd)
        // 逐块正文与 `splitBlocks` 的归一文本对得上（只差换行风格）
        for (let i = 0; i < spans.length; i += 1) {
          if (body(i).replace(/\r\n?/g, '\n') !== blocks[i].text) return false
        }
        let out = spans.length === 0 ? t : t.slice(0, spans[0].start)
        for (let i = 0; i < spans.length; i += 1) {
          out += body(i) + t.slice(spans[i].bodyEnd, i + 1 < spans.length ? spans[i + 1].start : t.length)
        }
        return out === t
      })
    })())

  check('A7 rankMemoryHomes：有笔记(+4) > 有我们的清单(+2) > 有死区(+1) > 只是目录；同分取候选链靠前；都不是目录 ⇒ null',
    (() => {
      const a = { base: 'playthrough', dir: 'A', isDir: true, hasNotes: false, hasIndex: true, hasDeadzone: false }
      const b = { base: 'workspace-root', dir: 'B', isDir: true, hasNotes: true, hasIndex: false, hasDeadzone: false }
      const c = { base: 'x', dir: 'C', isDir: true, hasNotes: false, hasIndex: false, hasDeadzone: true }
      return fl.rankMemoryHomes([a, b, c]).hit.dir === 'B'
        && fl.rankMemoryHomes([c, b]).hit.dir === 'B'
        && fl.rankMemoryHomes([{ dir: 'A', isDir: false }, { dir: 'B', isDir: true }]).hit.dir === 'B'
        && fl.rankMemoryHomes([{ dir: 'A', isDir: true }, { dir: 'B', isDir: true }]).hit.dir === 'A'
        && fl.rankMemoryHomes([{ dir: 'A', isDir: false }]).hit === null
        && fl.rankMemoryHomes([]).hit === null
    })())

  check('A8 writeRestoredFile：不是那 5 份 ⇒ 拒（⛔ 一个字节都不写）',
    (() => {
      const r = fl.writeRestoredFile(PT_MEM, 'rulebook.md', '# 作者预置\n', 'stamp')
      return r.ok === false && existsSync(join(PT_MEM, 'rulebook.md')) === false
        && fl.writeRestoredFile(PT_MEM, 'notes.md', 123, 'stamp').ok === false
    })())

  check('A9 decideRollback 真值表（★ 新口径：同一楼换变体也算回档 · 没记过就退回进楼前 · ⛔ 不用时间戳）',
    (() => {
      // 同一份夹具里**故意**让"第 4 楼那份的时间戳比第 1 楼更早** —— 位置说前进、时间戳说回档。
      const floors = [
        { nodeId: 'n4', variantId: 'v1', at: '2026-09-23T08:00:00.000Z', files: [] },
        { nodeId: 'n1', variantId: 'v1', at: '2026-09-23T20:00:00.000Z', files: [] },
        { nodeId: 'n1', variantId: 'v2', at: '2026-09-23T21:00:00.000Z', files: [] },
      ]
      const seqOf = (id) => ({ n1: 1, n2: 2, n4: 4 }[id] ?? null)
      const prevOf = (id) => ({ n2: 'n1', n4: 'n3' }[id] ?? null)
      const d = (o) => fl.decideRollback(Object.assign({ floors, seqOf, prevOf }, o))
      const k = (o) => d(o).kind
      const byStamp = Date.parse(fl.floorOf({ floors }, 'n4').at) < Date.parse(fl.floorOf({ floors }, 'n1').at) ? 'rollback' : 'forward'
      const swap = d({ head: { nodeId: 'n1', variantId: 'v2' }, last: { nodeId: 'n1', variantId: 'v1' } })
      const swapNew = d({ head: { nodeId: 'n1', variantId: 'v3' }, last: { nodeId: 'n1', variantId: 'v1' } })
      const backNoSnap = d({ head: { nodeId: 'n2', variantId: 'v1' }, last: { nodeId: 'n4', variantId: 'v1' } })
      const legacyLast = d({ head: { nodeId: 'n1', variantId: 'v1' }, last: { nodeId: 'n1' } })
      return k({ head: null, last: { nodeId: 'n1' } }) === 'no-head'
        && k({ head: { nodeId: 'n1' }, last: null }) === 'first'
        && k({ head: { nodeId: 'n1', variantId: 'v1' }, last: { nodeId: 'n1', variantId: 'v1' } }) === 'same'
        && k({ head: { nodeId: 'n4' }, last: { nodeId: 'n1' } }) === 'forward'
        && k({ head: { nodeId: 'n1', variantId: 'v1' }, last: { nodeId: 'n4', variantId: 'v1' } }) === 'rollback'
        && k({ head: { nodeId: '不认识' }, last: { nodeId: 'n1' } }) === 'unknown-order'
        && k({ head: { nodeId: 'n1' }, last: { nodeId: '不认识' } }) === 'unknown-order'
        // ★ 新：同一楼换变体 ⇒ 回档；`(N,V2)` 自己有快照 ⇒ 用它（source self）
        && swap.kind === 'rollback' && swap.why === 'variant' && swap.source === 'self' && swap.target.variantId === 'v2'
        // ★ 新：这一支没记过（v3）⇒ 退回进楼前（紧邻前一楼 n2 没有 ⇒ 再没有 ⇒ back-no-snapshot）
        && swapNew.kind === 'back-no-snapshot' && swapNew.why === 'variant'
        // ★ 新：回到前面的楼层（n2）、那一楼没快照 ⇒ 用紧邻前一楼 n1 **最后一条**（v2）
        && backNoSnap.kind === 'rollback' && backNoSnap.source === 'prev' && backNoSnap.target.variantId === 'v2'
        // ★ 连前一楼都没有（就是第一楼 / 认不出前一楼）⇒ 什么都不动（back-no-snapshot）
        && k({ head: { nodeId: 'n2', variantId: 'v1' }, last: { nodeId: 'n4', variantId: 'v1' }, prevOf: () => null }) === 'back-no-snapshot'
        // ★ 有一边不知道变体（老记录）⇒ 不当成"换变体"（保守：那一楼还是那一楼）
        && legacyLast.kind === 'same'
        // ★ 反证（那一对）：同一份夹具，时间戳那套判成"回档"（错的），位置那套判成"前进"（对的）
        && byStamp === 'rollback'
    })())

  // ★ 20260924 新口径：那条**待处理**（`pending`）的纯逻辑 —— 归一 / 记 / 幂等 / 过期清掉。
  //   ★★ 2026-09-24 收尾改口径：触发它的判据从 `decision`（档案 vs 剧情）换成 **`fork`（剧情 vs `seen`）**
  //   （见 A11/A12）；`decision` 现在只负责"**有没有**一份可以退回"。这条钉的是**形状与去重/清理**那一层。
  check('A10 ★ 待处理那条（normalizePending / pendingOf / planPending）：归一 + 幂等（同一次 fork 不刷 at）+ 过期清掉（★ 收尾改口径后已按 fork 触发改写）',
    (() => {
      const raw = {
        fromNodeId: 'n3', fromVariantId: 'v1', fromSeq: 3,
        toNodeId: 'n1', toVariantId: 'v1', toSeq: 1,
        archiveNodeId: 'n2', archiveVariantId: 'v1', archiveSeq: 2,
        targetNodeId: 'n1', targetVariantId: 'v1', targetSeq: 1,
        why: 'variant', source: 'prev', at: 'T1',
      }
      const p = fl.normalizePending(raw)
      const idx = (pending) => ({ last: { nodeId: 'n3', variantId: 'v1', seq: 3 }, floors: [], pending })
      const rb = (target, why = 'back', source = 'self') => ({ kind: 'rollback', target, why, source, seq: 1, lastSeq: 3, prevNodeId: null, legacyAtHead: false })
      const t1 = { nodeId: 'n1', variantId: 'v1', seq: 1 }
      const t2 = { nodeId: 'n2', variantId: 'v1', seq: 2 }
      const head = { nodeId: 'n1', variantId: 'v1' }
      const seen = { nodeId: 'n3', variantId: 'v1', seq: 3 }
      const fork = { kind: 'fork', why: 'back' }
      const okShape = p !== null && p.fromSeq === 3 && p.toSeq === 1 && p.targetSeq === 1 && p.archiveSeq === 2
        && p.why === 'variant' && p.source === 'prev' && p.targetKey === fl.floorKeyOf('n1', 'v1') && p.at === 'T1'
        && fl.normalizePending(null) === null && fl.normalizePending({ nodeId: 'x' }) === null
        && fl.pendingOf({}) === null && fl.pendingOf(null) === null
      const a = fl.planPending({ index: idx(null), head, seen, fork, decision: rb(t1), seq: 1, at: 'T1' })
      const b = fl.planPending({ index: idx(a.pending), head, seen, fork, decision: rb(t1), seq: 1, at: 'T9' })
      const c = fl.planPending({ index: idx(a.pending), head, seen, fork, decision: rb(t2, 'variant', 'self'), seq: 2, at: 'T9' })
      const e1 = fl.planPending({ index: idx(a.pending), head: { nodeId: 'n4', variantId: 'v1' }, seen, fork: { kind: 'forward', why: null }, decision: { kind: 'forward' }, seq: 4, at: 'T9' })
      const e2 = fl.planPending({ index: idx(a.pending), head, seen, fork: { kind: 'same', why: null }, decision: { kind: 'same' }, seq: 1, at: 'T9' })
      const f = fl.planPending({ index: idx(a.pending), head, seen, fork: { kind: 'unknown-order', why: null }, decision: { kind: 'unknown-order' }, seq: null, at: 'T9' })
      return okShape
        && a.changed === true && a.pending.targetKey === fl.floorKeyOf('n1', 'v1') && a.pending.at === 'T1' && a.pending.source === 'self'
        && b.changed === false && b.pending.at === 'T1'
        && c.changed === true && c.pending.targetSeq === 2 && c.pending.at === 'T9'
        && e1.changed === true && e1.pending === null
        && e2.changed === true && e2.pending === null
        // ★ 收尾改口径：判不出先后（unknown-order）⇒ **也照清**（那一刻那条提示已经无从核实 ⇒ 宁可清掉，
        //   ⛔ 不挂一条可能是假的；清掉的只是我们自己的提示，⛔ 那 5 份一个字节都不碰）
        && f.changed === true && f.pending === null
        // ★ 反证（幂等那一句）：把"同一个 targetKey 不刷 at"挖掉（= 每轮都拿新的 at）⇒ 上面 b 那条必红
        && (() => {
          const dugNoIdem = Object.assign({}, a.pending, { at: 'T9' })
          return b.pending.at === a.pending.at && JSON.stringify(dugNoIdem) !== JSON.stringify(a.pending)
        })()
    })())

  // ═════════════════════════════════════════════════════════════════════════
  // ★★ 2026-09-24 收尾新增：**判据换成「开 fork」**（用户原话「回档我没看到有横幅。」「**开 fork 时
  //   （回档）前台弹提示**」）—— 这一族就是本单的核心：判据本身（六相）、真机那个 bug 的**核心反证**、
  //   以及"那条待处理怎么记/怎么清"。
  // ═════════════════════════════════════════════════════════════════════════

  check('A11 ★ decideFork 真值表（六相：no-head / no-seen / same / fork-back / fork-variant / forward / unknown-order）',
    (() => {
      const seqOf = (id) => ({ n1: 1, n2: 2, n4: 4 }[id] ?? null)
      const d = (o) => fl.decideFork(Object.assign({ seqOf }, o))
      const k = (o) => d(o).kind
      const seen2 = { nodeId: 'n2', variantId: 'v1', seq: 2 }
      const back = d({ head: { nodeId: 'n1', variantId: 'v1' }, seen: seen2 })
      const variant = d({ head: { nodeId: 'n2', variantId: 'v2' }, seen: seen2 })
      return k({ head: null, seen: seen2 }) === 'no-head'
        && k({ head: { nodeId: '' }, seen: seen2 }) === 'no-head'
        // ★ 第一次见（没有基线）⇒ **建立基线**，⛔ 不算 fork（本条就是"⛔ 不拿第一次见当回档"那一句）
        && k({ head: { nodeId: 'n1', variantId: 'v1' }, seen: null }) === 'no-seen'
        && k({ head: { nodeId: 'n1', variantId: 'v1' }, seen: undefined }) === 'no-seen'
        && k({ head: { nodeId: 'n2', variantId: '' }, seen: { nodeId: 'n2', variantId: '' } }) === 'same'
        && k({ head: { nodeId: 'n2', variantId: 'v1' }, seen: seen2 }) === 'same'
        // ★ 用户要提示的那一件事：比上次认过的位置**退回去了**
        && back.kind === 'fork' && back.why === 'back'
        // ★ 同一楼换支（swipe 重 roll / 在该楼另开一支）
        && variant.kind === 'fork' && variant.why === 'variant'
        && k({ head: { nodeId: 'n4', variantId: 'v1' }, seen: seen2 }) === 'forward'
        && k({ head: { nodeId: '不认识' }, seen: seen2 }) === 'unknown-order'
        && k({ head: { nodeId: 'n1' }, seen: { nodeId: '不认识' } }) === 'unknown-order'
        // ★ 有一边不知道变体（老记录 / 时间线没给）⇒ ⛔ **不判"换支"**（保守：那一楼还是那一楼）——
        //   按位置比 ⇒ 同一楼 ⇒ forward（`seen` 自动跟上，自愈）
        && k({ head: { nodeId: 'n2', variantId: 'v1' }, seen: { nodeId: 'n2', variantId: '' } }) === 'forward'
        // ★ 反证（"同一楼换支也算 fork"那一条）：把它挖掉（= 只看 nodeId）⇒ 同一份夹具判成 same ⇒ 上面必红
        && (() => {
          const dug = (o) => (o.head.nodeId === o.seen.nodeId ? 'same' : '其它')
          return dug({ head: { nodeId: 'n2', variantId: 'v2' }, seen: seen2 }) === 'same'
            && fl.decideFork({ head: { nodeId: 'n2', variantId: 'v2' }, seen: seen2, seqOf }).kind === 'fork'
        })()
    })(), 'decideFork 的六相（+ 老记录那条保守口径）')

  // ★★★ 本单的**核心反证**：就是真机那个 bug 的复现（⛔ 不是猜的，见任务书 §1 那条实测）。
  check('★★ A12 核心反证（真机 bug 复现）：同一份夹具（seen=第 40 楼 / head=第 38 楼 / index.last=第 34 楼）—— 新判据**必须**判 fork、老判据在同一份夹具上判 forward',
    (() => {
      const seqOf = (id) => ({ 'qa-34': 34, 'qa-38': 38, 'qa-40': 40 }[id] ?? null)
      const head = { nodeId: 'qa-38', variantId: 'v1' }
      const seen = { nodeId: 'qa-40', variantId: 'v1', seq: 40 }
      const last = { nodeId: 'qa-34', variantId: 'v1', seq: 34, at: 'T0' }
      const fork = fl.decideFork({ head, seen, seqOf })
      // 老判据（改口径前就是它决定"弹不弹横幅"）：档案(34) 在剧情(38)**后面** ⇒ 它判 forward ⇒ **横幅这辈子不弹**
      const decision = fl.decideRollback({ head, last, floors: [], seqOf })
      // ★ 两条断言**互斥**：把 `decideFork` 换回 `decideRollback` 当判据 ⇒ "判成 fork"那条必红。
      const plan = fl.planPending({
        index: { last, floors: [], pending: null }, head, seen, fork, decision, seq: 38, at: 'T7',
      })
      return fork.kind === 'fork' && fork.why === 'back'
        && decision.kind === 'forward' && decision.target === null
        && fork.kind !== decision.kind
        // ★ 这一跳照样记一条：from = seen(40) / to = head(38) / archive = last(34)，**没有** target（⛔ 不编）
        && plan.changed === true && plan.pending !== null
        && plan.pending.fromSeq === 40 && plan.pending.toSeq === 38 && plan.pending.archiveSeq === 34
        && plan.pending.targetNodeId === '' && plan.pending.targetSeq === null
        && plan.pending.targetKey === fl.floorKeyOf('qa-38', 'v1')
    })(), '真机 34/38/40 那份夹具（新判据 vs 老判据）')

  check('A13 ★ normalizeSeen / normalizePending 新形状：seen 认不出 ⇒ null；pending 认得出的判据改成 `toNodeId`（`target*` **允许缺**）+ 新增 `archive*`',
    (() => {
      const s = fl.normalizeSeen({ nodeId: 'n1', variantId: 'v', seq: 3, at: 'T' })
      const p = fl.normalizePending({
        fromNodeId: 'n3', fromVariantId: 'v1', fromSeq: 3,
        toNodeId: 'n1', toVariantId: 'v', toSeq: 1,
        archiveNodeId: 'n2', archiveVariantId: 'v1', archiveSeq: 2, why: 'back', at: 'T',
      })
      const noTarget = fl.normalizePending({ toNodeId: 'n1', toVariantId: 'v', toSeq: 1, targetSeq: 9 })
      return s !== null && s.nodeId === 'n1' && s.variantId === 'v' && s.seq === 3 && s.at === 'T'
        && fl.normalizeSeen(null) === null && fl.normalizeSeen({}) === null && fl.normalizeSeen({ nodeId: '' }) === null
        && fl.normalizeSeen({ nodeId: 'n1', at: 5 }).at === null
        // ★ **没有 target 也认得出**（"没有可退回的那一份"是**正常状态**）—— 这就是"判据从 targetNodeId 换成 toNodeId"那一行
        && p !== null && p.targetNodeId === '' && p.targetSeq === null
        && p.fromSeq === 3 && p.toSeq === 1 && p.archiveNodeId === 'n2' && p.archiveSeq === 2
        && p.targetKey === fl.floorKeyOf('n1', 'v')
        // ⛔ 没有 target 的那条：楼号**不许**留着（否则面板会画一颗点不通的「退回第 9 楼」）
        && noTarget !== null && noTarget.targetNodeId === '' && noTarget.targetSeq === null
        // ⛔ 认不出的判据是 `toNodeId`（旧形状那半条 / 空 to ⇒ 整条丢掉）
        && fl.normalizePending({ targetNodeId: 'n1', targetSeq: 1 }) === null
        && fl.normalizePending({ toNodeId: '', targetNodeId: 'n1' }) === null
    })())

  check('★★ A14 planPending 新触发口径：只认 `fork.kind === \'fork\'`（`from*`=seen / `to*`=head / `archive*`=last；没有 target 也记得住；剧情往前走 ⇒ 清掉）',
    (() => {
      const seen = { nodeId: 'n3', variantId: 'v1', seq: 3 }
      const head = { nodeId: 'n1', variantId: 'v1' }
      const last = { nodeId: 'n2', variantId: 'v1', seq: 2, at: 'T0' }
      const idx = (pending) => ({ last, floors: [], pending })
      const fork = { kind: 'fork', why: 'back' }
      const forward = { kind: 'forward', why: null }
      const rb = (target) => ({ kind: 'rollback', target, why: 'back', source: 'self', seq: 1, lastSeq: 2 })
      const t = { nodeId: 'n1', variantId: 'v1', seq: 1 }
      const a = fl.planPending({ index: idx(null), head, seen, fork, decision: rb(t), seq: 1, at: 'T1' })
      const b = fl.planPending({ index: idx(a.pending), head, seen, fork, decision: rb(t), seq: 1, at: 'T9' })
      const noT = fl.planPending({ index: idx(null), head, seen, fork, decision: { kind: 'forward' }, seq: 1, at: 'T1' })
      const gone = fl.planPending({ index: idx(a.pending), head, seen, fork: forward, decision: { kind: 'forward' }, seq: 3, at: 'T9' })
      const none = fl.planPending({ index: idx(null), head, seen, fork: forward, decision: { kind: 'forward' }, seq: 3, at: 'T9' })
      const same = fl.planPending({ index: idx(a.pending), head, seen, fork: { kind: 'same', why: null }, decision: { kind: 'same' }, seq: 1, at: 'T9' })
      return a.changed === true && a.pending !== null
        // ★ from = seen（剧情**退回去之前**站的楼）、to = head（剧情**现在**站的楼）、archive = last（档案停在哪一楼）
        && a.pending.fromNodeId === 'n3' && a.pending.fromSeq === 3
        && a.pending.toNodeId === 'n1' && a.pending.toSeq === 1
        && a.pending.archiveNodeId === 'n2' && a.pending.archiveSeq === 2
        && a.pending.targetSeq === 1 && a.pending.source === 'self' && a.pending.at === 'T1'
        // ★ 幂等：同一次 fork 再判 ⇒ `at` 不变、**一个字节都不写**
        && b.changed === false && b.pending.at === 'T1'
        // ★ 没有可退回的那一份 ⇒ 那条**照样记得住**（⛔ 不许因为没 target 就丢掉整条）
        && noT.changed === true && noT.pending !== null && noT.pending.targetNodeId === ''
        && noT.pending.targetSeq === null && noT.pending.targetKey === fl.floorKeyOf('n1', 'v1')
        // ★ 剧情往前走了 / 认过了 ⇒ 旧的那条被**清掉**；本来就没有 ⇒ 一个字节都不写
        && gone.changed === true && gone.pending === null
        && same.changed === true && same.pending === null
        && none.changed === false && none.pending === null
        // ★ 反证（幂等那一句）：把它挖掉（= 每轮都拿新的 at）⇒ 上面 b 那条必红
        && (() => {
          const dug = Object.assign({}, a.pending, { at: 'T9' })
          return b.pending.at === a.pending.at && JSON.stringify(dug) !== JSON.stringify(a.pending)
        })()
    })(), 'planPending 的新触发口径')

  check('A15 ★ 导出清单：本单新增的两个判据都在（具名导出 + `export default` 那份清单里）',
    typeof fl.decideFork === 'function' && typeof fl.normalizeSeen === 'function'
    && typeof floorDfl.decideFork === 'function' && typeof floorDfl.normalizeSeen === 'function'
    && (() => {
      // ⛔ 两处都不许漏：接线那一层是**按名字**从具名导出取的（漏了就是"没接线"，静默失效）。
      const mod = readFileSync(join(ROOT, 'lib', 'floor-snapshot.js'), 'utf8')
      const dflt = mod.slice(mod.indexOf('export default {'))
      return /export function decideFork\(/.test(mod) && /export function normalizeSeen\(/.test(mod)
        && dflt.includes('decideFork') && dflt.includes('normalizeSeen')
        // ★ 反证：把默认导出那一行挖掉 ⇒ 这条必红（"只写了具名导出、忘了清单"是真实会犯的错）
        && (() => {
          const dug = mod.replace(/decideFork, decideRollback/, 'decideRollback')
          return !dug.slice(dug.indexOf('export default {')).includes('decideFork')
        })()
    })())

  // ★★ 2026-09-25（那一排三颗）：`settleModeOf` —— 「对齐」那一脚是哪种模式的**判据只此一处**。
  //   缺省（没给）⇒ `'full'`（老那一脚的行为，⛔ 一个字节都没改）；认得的只有 `'full'` / `'number'`；
  //   其余一律 `null`（＝认不出）⇒ 端点 400、内核**也**拒（`bad-mode`）—— ⛔ 不许"看不懂就当 full 跑"
  //   （那会替用户记下一份他没点的快照：**两颗按钮**是两件事）。
  check('A16 ★ `settleModeOf` 只认那三个（缺省 / \'full\' / \'number\'），其余一律 `null`（认不出就是认不出）',
    fl.settleModeOf(undefined) === 'full' && fl.settleModeOf(null) === 'full'
    && fl.settleModeOf('full') === 'full' && fl.settleModeOf('number') === 'number'
    && fl.settleModeOf('') === null && fl.settleModeOf('FULL') === null && fl.settleModeOf('half') === null
    && fl.settleModeOf(1) === null && fl.settleModeOf({}) === null && fl.settleModeOf([]) === null
    // 反证：把"认不出 ⇒ null"那支写成"认不出就当 full" ⇒ 这条**必红**
    && (() => {
      const mod = readFileSync(join(ROOT, 'lib', 'floor-snapshot.js'), 'utf8')
      const dug = mod.replace("  return v === 'full' || v === 'number' ? v : null", "  return v === 'full' || v === 'number' ? v : 'full'")
      return !/return v === 'full' \|\| v === 'number' \? v : null/.test(dug)
    })())
  check('A16b ★ 内核那一层也**拒**认不出的 mode（`bad-mode`，`ok:false`）：清单**逐字节没动**（对照组：同一刻的 `\'full\'` 会写盘）',
    (() => {
      reset(V1)
      sync('turn')                                          // 第 1 楼（有清单了）
      writeTimeline(NODES[2]); putFiles(V3); sync('turn')    // 第 3 楼
      writeTimeline(NODES[0])                                // 回档
      const receipt = sync('turn')                           // ⇒ 记一条待处理
      const raw = indexRaw()
      const bad = fl.settlePending(PT_MEM, { at: 'T9', mode: 'half' })
      const sameRaw = indexRaw() === raw                     // ★ 认不出的 mode ⇒ 一个字节都没写
      const full = fl.settlePending(PT_MEM, { at: 'T9', mode: 'full' })   // 对照组：同一刻的 full 会写盘
      return receipt.pending !== null && receipt.pending !== undefined
        && bad.ok === false && bad.changed === false && bad.settled === null
        && bad.mode === null && bad.reason === 'bad-mode' && sameRaw === true
        && full.ok === true && full.changed === true && full.mode === 'full' && indexRaw() !== raw
    })(), '')

  // ★★ 2026-09-25（用户原话，逐字）：「**插件自己按时间编一个序号，不论实际seq，这样反而符合直觉，
  //   序号最大的就是最新生成的**」⇒ 新增那一族 **`ordinal`** 的判据（纯逻辑层，⛔ 一行业务判据都没改）：
  //     ① **升序编号、最大 = 最新**（按行上的 `at`，⛔ 不看 `seq`）；
  //     ② **反证**：拿 `seq` 去编号 ⇒ 同一批数据的号就不一样（下面这一条**必红**）—— 用户点名的那个"屁用没有的楼号"；
  //     ③ **并列**（`at` 相同）用既有那个确定性次序（nodeId → variantId → at）破 ⇒ ⛔ 不出现两行同号；
  //     ④ **老记录**（`legacy`，没有 variant）照样进编号；
  //     ⑤ `at` 认不出 ⇒ 排在**最后**、序号如实 `null`（面板写「序号未知」，⛔ 不编 0）。
  check('A17 ★★ `ordinal`：按记录时间升序编号（最大＝最新）· 并列不乱号 · 老记录照样进 · `at` 认不出 ⇒ 排最后且如实 null（⛔ 不编 0）',
    (() => {
      const row = (nodeId, variantId, at, seq) => ({ nodeId, variantId, at, seq, files: [] })
      // 注意：**故意让 `seq` 与时间反着来** —— 真机就是这个样子（回档之后 `seq` 小的反而是最新记的）。
      const rows = [
        row('n-later', 'v1', '2026-09-25T10:00:00.000Z', 2),
        row('n-earliest', 'v1', '2026-09-23T10:00:00.000Z', 9),
        row('n-legacy', '', '2026-09-24T10:00:00.000Z', 5),   // ★ 老记录（没有 variant）照样进编号
        row('n-untimed', 'v1', null, 1),                        // ★ 认不出时间 ⇒ 排最后、序号 null
        row('n-bad-at', 'v1', '不是时间', 3),
      ]
      const order = fl.ordinalOrderOf(rows)
      const ord = fl.ordinalMapOf(rows)
      const of = (n, v) => fl.ordinalOfFloor({ nodeId: n, variantId: v }, ord)
      // ① + ④：按时间升序 1..3，最新（`n-later`）＝ 3；老记录排第 2
      const numbered = order.filter((x) => Number.isFinite(x.ordinal))
      const tail = order.filter((x) => x.ordinal === null)
      const ascending = order.filter((x) => x.ordinal !== null)
        .every((x, i, all) => i === 0 || all[i - 1].ordinal <= x.ordinal)
      // ⑤：认不出时间的那两条**排在最后**，序号如实 null（⛔ 不是 0）
      const tailOk = tail.length === 2 && tail.every((x) => x.floor.nodeId === 'n-untimed' || x.floor.nodeId === 'n-bad-at')
        && tail.every((x) => x.ordinal === null)
      // ③：并列（`at` 相同）⇒ 用既有那个确定性次序破（nodeId → variantId → at）⇒ 两行不同号
      const tie = fl.ordinalOrderOf([
        row('n-b', 'v1', '2026-09-25T00:00:00.000Z', 1),
        row('n-a', 'v1', '2026-09-25T00:00:00.000Z', 2),
      ]).map((x) => x.floor.nodeId + ':' + String(x.ordinal)).join(',')
      // ② 反证：按 `seq` 编号 ⇒ 号完全不一样（用户说"屁用没有"的就是那个号）⇒ 上面那几条必红
      const bySeq = rows.filter((r) => Number.isFinite(r.seq)).slice().sort((a, b) => a.seq - b.seq)
        .map((r) => r.nodeId)
      const byOrd = order.filter((x) => x.ordinal !== null).map((x) => x.floor.nodeId)
      return fl.FLOOR_FILES.length === 5
        && numbered.length === 3 && ascending === true
        && of('n-earliest', 'v1') === 1 && of('n-legacy', '') === 2 && of('n-later', 'v1') === 3
        && of('n-later', 'v1') === numbered.length                     // ★ 最大 = 最新
        && tailOk === true
        && of('n-untimed', 'v1') === null && of('n-bad-at', 'v1') === null
        && of('不在清单里', 'v1') === null && of('n-later', 'v9') === null   // ⛔ 认不出的键也是 null（不是 0）
        && tie === 'n-a:1,n-b:2'
        && byOrd.join(',') !== bySeq.join(',')                         // ★ 反证：两条路给出的号不一样
        && fl.floorAtMillis('2026-09-25T10:00:00.000Z') > fl.floorAtMillis('2026-09-24T10:00:00.000Z')
        && fl.floorAtMillis(null) === null && fl.floorAtMillis('') === null && fl.floorAtMillis('2026-9-5') === null
        && fl.floorAtMillis(12345) === null
    })(), 'ordinal 那一族')
  check('A17b ★ 序号那一族也在**导出清单**里（具名 + `export default`；⛔ 漏一个名字就是"没接线"）',
    typeof fl.ordinalOrderOf === 'function' && typeof fl.ordinalMapOf === 'function'
    && typeof fl.ordinalOfFloor === 'function' && typeof fl.floorAtMillis === 'function'
    && typeof fl.compareFloorOrder === 'function'
    && typeof floorDfl.ordinalOrderOf === 'function' && typeof floorDfl.ordinalMapOf === 'function'
    && typeof floorDfl.ordinalOfFloor === 'function' && typeof floorDfl.compareFloorOrder === 'function'
    && (() => {
      const mod = readFileSync(join(ROOT, 'lib', 'floor-snapshot.js'), 'utf8')
      const dflt = mod.slice(mod.indexOf('export default {'))
      return dflt.includes('ordinalOrderOf') && dflt.includes('ordinalMapOf') && dflt.includes('ordinalOfFloor')
        // ★ 反证：把默认导出里那几个名字挖掉 ⇒ 这条必红
        && (() => {
          const dug = mod.replace('floorAtMillis, compareFloorOrder, ordinalOrderOf, ordinalMapOf, ordinalOfFloor,', '')
          return !dug.slice(dug.indexOf('export default {')).includes('ordinalMapOf')
        })()
    })())

  // ═════════════════════════════════════════════════════════════════════════
  sect('B 补单 §2 八对（变体级快照 + 死区按块合并；★ 20260924 回档改手动挡后，改口径的那几条已按新口径改写）')

  // ── 对 1：相｜变体级记录（同一 nodeId 两支各记一条，互不覆盖）＋ ★ 20260924 改口径：
  //   swipe 判成回档之后**只记一条待处理、那 5 份逐字节不变**（原来这里断言"自动退回进楼前"）。
  {
    reset(V1)
    sync('turn')                            // 第 1 楼第 1 支（记 (1,V1)）
    writeTimeline(NODES[1])
    putFiles(V2)
    sync('turn')                            // 第 2 楼第 1 支（记 (2,V1)）
    // ★ swipe：同一楼换到第 2 支（没记过 ⇒ 该退回"进楼前" = 第 1 楼那一份）
    writeTimeline(NODES[1], NODES, VAR(NODES[1], 2))
    const fiveBefore = fiveNow()
    const rawBefore = indexRaw()
    const rSwap = sync('turn')
    check('§2-1相 ★ swipe（同一楼换变体）判成回档 ⇒ **只记一条待处理、那 5 份逐字节不变**（⛔ 不自动跟随）',
      rSwap.kind === 'rollback' && rSwap.why === 'variant' && rSwap.restore === null
      && rSwap.pending !== null && rSwap.pending.source === 'prev'
      && rSwap.pending.fromSeq === 2 && rSwap.pending.toSeq === 2 && rSwap.pending.targetSeq === 1
      && JSON.stringify(fiveNow()) === JSON.stringify(fiveBefore)
      && readMem('notes.md') === V2['notes.md']        // 盘上还是模型在第 2 楼第 1 支之后写的那份
      && backups().length === 0
      && indexOf().floors.length === 2 && indexOf().last.nodeId === NODES[1]
      && indexRaw() !== rawBefore, JSON.stringify([rSwap.kind, rSwap.pending && rSwap.pending.source]))
    // ★ 手动那一脚（就是面板横幅上那颗「把档案退回第 1 楼」）⇒ 才真的退回"进这一楼之前"那张
    const back = restoreViaPanel({ memoryDir: PT_MEM, nodeId: NODES[0], variantId: VAR(NODES[0]), zones: [], at: 'T2', stamp: 'stamp2' })
    check('§2-1相b ★ 手动点「把档案退回第 1 楼」⇒ 真写回第 1 楼那份，并清掉那条待处理',
      back.kind === 'manual' && readMem('notes.md') === V1['notes.md'] && readMem('index.md') === V1['index.md']
      && back.pending === null && indexOf().pending === null)
    // ★ 第 2 支里模型重跑出来的样子 ⇒ 这一次是"往前走" ⇒ 记下 (2,V2)（两支各一条、互不覆盖）
    putFiles(V2B)
    const rRec = sync('turn')
    const two = fl.floorsOfNode(indexOf(), NODES[1])
    const shaOf = (f) => f.files.find((x) => x.name === 'notes.md').sha256
    check('§2-1相c ★ 第 2 支往后重演 ⇒ 记下 (2,V2)：同一 nodeId 两支各一条、互不覆盖（各自的 sha 都在）',
      two.length === 2
      && two[0].variantId === VAR(NODES[1]) && two[1].variantId === VAR(NODES[1], 2)
      && shaOf(two[0]) === dz.sha256Hex(V2['notes.md'])
      && shaOf(two[1]) === dz.sha256Hex(V2B['notes.md'])
      && shaOf(two[0]) !== shaOf(two[1])
      // ★ 2026-09-24 收尾改口径：回执的 `kind` 现在按**剧情位置**（fork）报 —— 这一脚剧情**没动**
      //   （刚"退回"过 ⇒ 用户认过这一楼）⇒ `same`；而**记录侧**照旧按档案那一侧判（head 在档案后面
      //   ⇒ forward）⇒ 真记了一份。⛔ 两条都不是错的，是两半各自的判据。
      && rRec.kind === 'same' && rRec.record !== null && rRec.record.changed.includes('notes.md'),
      JSON.stringify([two.map((f) => f.variantId), rSwap.kind, rRec.kind]))
  }

  // ── 对 2：相｜换变体也算回档；(N,V) 自己有快照 ⇒ 那条待处理**指向这一支**；手动点才真写 ────
  //   ★ 20260924 改口径（回档改手动挡）：原来这条断言"判到就自动恢复到 (N,V1)"⇒ 现在拆成两半：
  //     判到回档只记待处理（目标 = (N,V1) 那一支）、那 5 份逐字节不变；写回那一支挪到手动那一脚。
  //   反证：把判据改回上一版的"只看 nodeId" ⇒ 同一夹具下判成 same、**连待处理都不会有** ⇒ 必红
  {
    reset(V1)
    sync('turn')                            // (1,V1)
    writeTimeline(NODES[1]); putFiles(V2); sync('turn')      // (2,V1)
    writeTimeline(NODES[1], NODES, VAR(NODES[1], 2))         // swipe 到第 2 支（没记过）
    sync('turn')                            // ⇒ 待处理（目标 = 第 1 楼那一份）
    const back1 = restoreViaPanel({ memoryDir: PT_MEM, nodeId: NODES[0], variantId: VAR(NODES[0]), zones: [], at: 'T2', stamp: 's2' })
    putFiles(V2B); sync('turn')             // 第 2 支往后重演 ⇒ 记 (2,V2)
    const lastBefore = indexOf().last
    const notesBefore = readMem('notes.md')
    const fiveBefore = fiveNow()
    writeTimeline(NODES[1], NODES, VAR(NODES[1]))   // ★ 再 swipe 回第 1 支（(2,V1) 有快照）
    const r = sync('turn')
    check('§2-2相 ★ 同一楼换变体（swipe）也算回档：待处理指向 `(N,V1)` 那一支（自己有快照），那 5 份逐字节不变',
      r.kind === 'rollback' && r.why === 'variant' && r.restore === null
      && r.pending !== null && r.pending.source === 'self'
      && r.pending.targetNodeId === NODES[1] && r.pending.targetVariantId === VAR(NODES[1])
      && r.pending.targetSeq === 2 && r.pending.fromSeq === 2 && r.pending.toSeq === 2
      && JSON.stringify(fiveNow()) === JSON.stringify(fiveBefore)
      && notesBefore === V2B['notes.md'] && readMem('notes.md') === V2B['notes.md']
      && back1.pending === null,
      JSON.stringify([r.kind, r.why, r.pending && r.pending.source]))
    const m = restoreViaPanel({ memoryDir: PT_MEM, nodeId: NODES[1], variantId: VAR(NODES[1]), zones: [], at: 'T3', stamp: 's3' })
    check('§2-2相b ★ 手动点「把档案退回第 2 楼（这一支）」⇒ 真写回**这一支**那一份（`(N,V1)`）+ 清掉待处理',
      m.kind === 'manual' && readMem('notes.md') === V2['notes.md']
      && m.restore.source === 'self' && m.restore.target.variantId === VAR(NODES[1])
      && m.restore.moved.some((x) => x.name === 'notes.md')
      && indexOf().pending === null, JSON.stringify([m.kind, readMem('notes.md') === V2['notes.md']]))
    check('§2-2反证 ★ 把判据改回"只看 nodeId"（上一版）⇒ 同一夹具下判成 same、**连待处理都不会有** ⇒ 上面那条断言必红',
      (() => {
        // ← 上一版那一条判据（逐字）：`head.nodeId === last.nodeId ⇒ same`
        const oldJudge = (h, l) => (h.nodeId === l.nodeId ? 'same' : '其它')
        const headsNow = { nodeId: NODES[1], variantId: VAR(NODES[1]) }
        const withOld = oldJudge(headsNow, lastBefore)
        // 同一夹具下：按老判据＝什么都不做 ⇒ 盘上留着 V2 支那份（≠ V1 支那一份） ⇒ "待处理指向 (N,V1)"必红
        return withOld === 'same' && notesBefore === V2B['notes.md'] && V2B['notes.md'] !== V2['notes.md']
      })())
  }

  // ── 对 3：相｜新变体退回"进这一楼之前"；反证：把 (b) 支挖掉 ⇒ 必红 ────────────
  {
    const runFixture = (opts) => {
      reset(V1)
      sync('turn')                                            // (1,V1)
      writeTimeline(NODES[1]); putFiles(V2); sync('turn')      // (2,V1)
      writeTimeline(NODES[1], NODES, VAR(NODES[1], 2))         // ★ swipe：新变体（没记过）
      putFiles({ 'notes.md': '# 笔记\n第 2 楼第 1 支之后模型又写了\n' })
      return sync('turn', opts)
    }
    const r = runFixture({})
    check('§2-3相 ★ 新变体没记过 ⇒ 待处理指向"进这一楼之前"（紧邻前一楼**最后一条**快照），那 5 份一个字节都没写',
      r.kind === 'rollback' && r.why === 'variant' && r.restore === null
      && r.pending !== null && r.pending.source === 'prev'
      && r.pending.targetNodeId === NODES[0] && r.pending.targetVariantId === VAR(NODES[0])
      && r.pending.toSeq === 2 && r.pending.targetSeq === 1 && r.headSeq === 2
      && readMem('notes.md') === '# 笔记\n第 2 楼第 1 支之后模型又写了\n',
      JSON.stringify([r.kind, r.pending && r.pending.source, readMem('notes.md')]))
    // ★ 反证：同一夹具**重放**一遍，但把"紧邻前一楼"那一步挖掉（`prevOf` 不给）⇒ 那一跳的
    //   `target*` 变成空 ⇒ **上面那条"待处理指向第 1 楼"必红**（⛔ 目标不许编 —— 那是 `decision` 的那半边）。
    //   ⚠️ 2026-09-24 收尾改口径：**提示照样记**（开 fork 是 `seen` 判的，与有没有 target 无关）——
    //   所以这里断言的是"记下来了、但**没有**可退回的那一份"，不再是老的"连一条都记不出来"。
    const dug = runFixture({ prevOf: () => null })
    check('§2-3反证 ★ 把 (b) 支挖掉（不给"紧邻前一楼"）⇒ 同一夹具下"待处理指向第 1 楼"必红（那条照样记着，但**没有**可退回的那一份）',
      dug.kind === 'rollback' && dug.fork.kind === 'fork'
      && dug.pending !== null && dug.pending.targetNodeId === '' && dug.pending.targetSeq === null
      && readMem('notes.md') === '# 笔记\n第 2 楼第 1 支之后模型又写了\n'
      && readMem('notes.md') !== V1['notes.md'], JSON.stringify([dug.kind, dug.pending && dug.pending.targetSeq]))
  }

  // ── 对 4：相｜正常前进不回档（含"一个字节都不写"）──────────────────────────
  {
    reset(V1)
    sync('turn')
    writeTimeline(NODES[1])
    putFiles(V2)
    const raw0 = indexRaw()
    const r = sync('turn')
    check('§2-4相 ★ head 走到后面的新楼层 ⇒ 不回档（笔记就是模型刚写的样子）、只是又记了一份',
      r.kind === 'forward' && r.restore === null
      && readMem('notes.md') === V2['notes.md'] && readMem('index.md') === V2['index.md']
      && indexRaw() !== raw0 && indexOnDisk().floors.length === 2
      && indexOnDisk().floors[1].variantId === VAR(NODES[1]))
    // ★ 再往前走一楼（模型这一轮**没改**笔记）⇒ 前进 + 一个字节都不写（index 连 at 都不动）
    const raw1 = indexRaw()
    const notes1 = readMem('notes.md')
    writeTimeline(NODES[2])
    const r2 = sync('turn')
    check('§2-4相b ★ 前进、笔记又没变 ⇒ **一个字节都不写**（index 连 `at` 都不动、5 份不动）',
      r2.kind === 'forward' && r2.wrote === false && indexRaw() === raw1
      && readMem('notes.md') === notes1 && indexOnDisk().last.nodeId === NODES[1])
    const r3 = sync('watch')
    check('§2-4相c ★ 组装那一脚（watch）看到"剧情位置没动" ⇒ 同样一个字节都不写（★ 收尾改口径后 kind 按 fork 报 ⇒ `same`）',
      r3.kind === 'same' && r3.wrote === false && indexRaw() === raw1)
  }

  // ── 对 5：相｜死区按块合并（★ 手动那一脚）；两个反证（"照快照整份写" / 上一版的"整份跳过"）都咬人 ──
  //   ★ 20260924 改口径：合并那一脚现在只在**人点了**之后发生 ⇒ 这里先断言"判到回档零写入"，
  //     再用 `restoreFloor` 走合并那一脚（合并语义一个字没变）。
  {
    const A = '## 【必须遵守的核心规则】\n- 不许替玩家做决定（作者写的）'
    const A2 = '## 【必须遵守的核心规则】\n- 模型把这段改了'
    const B1 = '# 最近进展\n第 1 楼：开局'
    const B3 = '# 最近进展\n第 3 楼：模型改的'
    const SNAP_INDEX = A + '\n\n' + B1 + '\n'
    const diskBefore = A2 + '\n\n' + B3 + '\n'
    reset({ 'notes.md': V1['notes.md'], 'index.md': SNAP_INDEX })
    writeDeadzones([['index.md', A]])
    sync('turn')                              // 第 1 楼
    writeTimeline(NODES[2])
    putFiles({ 'notes.md': '# 笔记\n第 3 楼\n', 'index.md': diskBefore })
    sync('turn')                              // 第 3 楼（模型把 A、B **都**改了）
    writeTimeline(NODES[0])                   // ★ 回档到第 1 楼
    const beforePending = readMem('index.md')
    const rAuto = sync('turn')
    check('§2-5相a ★ 判到回档这一下**一个字节都没写**（死区那份也照旧停在盘上现况、只留一条待处理）',
      rAuto.kind === 'rollback' && rAuto.restore === null && rAuto.pending !== null
      && readMem('index.md') === beforePending && readMem('index.md') === diskBefore
      && readMem('notes.md') === '# 笔记\n第 3 楼\n')
    const beforeRestore = readMem('index.md')
    const r = restoreViaPanel({ memoryDir: PT_MEM, nodeId: NODES[0], variantId: VAR(NODES[0]), zones: zonesNow(), at: 'T2', stamp: 's2' })
    const diskAfter = readMem('index.md')
    const sk = r.restore.skipped.find((s) => s.name === 'index.md')
    check('§2-5相 ★ 死区按块合并：死区块 A 逐字节等于**盘上现况**（模型写的），非死区块 B 等于**快照**（第 1 楼的）',
      sk !== undefined && sk.reason === 'deadzone' && sk.merged === true && sk.kept.length === 1
      && diskAfter === A2 + '\n\n' + B1 + '\n'
      && diskAfter.startsWith(A2) && !diskAfter.includes('- 不许替玩家做决定（作者写的）')
      && readMem('notes.md') === V1['notes.md']
      && r.restore.moved.some((m) => m.name === 'index.md' && m.merged === true)
      && r.pending === null,
      JSON.stringify([sk && sk.merged, diskAfter]))
    check('§2-5反证① ★ 把"死区块保留现况"换成"照快照整份写"（上一版没有块合并时的直觉写法）⇒ A 被改回作者版 ⇒ 那条断言必红',
      (() => {
        const snapFloor = fl.floorOfVariant(indexOf(), NODES[0], VAR(NODES[0]))
        const texts = {}
        for (const f of snapFloor.files.filter((x) => typeof x.sha256 === 'string')) texts[f.sha256] = fl.readBlob(PT_MEM, f.sha256).text
        const dugDisk = { 'index.md': beforeRestore }              // 模拟"整份写"的落点
        for (const f of snapFloor.files) if (typeof texts[f.sha256] === 'string') dugDisk[f.name] = texts[f.sha256]
        return dugDisk['index.md'] === SNAP_INDEX                   // ← 老写法：A 被作者的版本盖掉
          && dugDisk['index.md'] !== diskAfter && dugDisk['index.md'] !== A2 + '\n\n' + B1 + '\n'
      })(), '整份写会把模型改过的死区块覆盖掉')
    check('§2-5反证② ★ 把口径改回上一版的"整份跳过"⇒ B 停在模型改的版本（≠ 快照）⇒ 那条断言必红（两种口径都咬人）',
      (() => {
        const v1SkipDisk = beforeRestore                          // ← 上一版：这一份一个字节都不写
        return v1SkipDisk === A2 + '\n\n' + B3 + '\n'
          && v1SkipDisk !== A2 + '\n\n' + B1 + '\n'               // B 回不去 ⇒ "B 等于快照"必红
          && v1SkipDisk.split('\n\n')[0] === A2                   // 而 A 本来就是盘上的（所以上一版"看起来"守住了死区）
      })())
  }

  // ── 对 6：反证｜死区数据读不出来 ⇒ 整次恢复不做（那 5 份逐字节没变 + 如实播报）──
  {
    const A = '## 【核心规则】\n- 作者写的'
    reset({ 'notes.md': V1['notes.md'], 'index.md': A + '\n\n# 索引\nv1\n' })
    writeDeadzones([['index.md', A]])
    sync('turn')
    writeTimeline(NODES[2])
    putFiles({ 'notes.md': '# 笔记\n第 3 楼\n', 'index.md': A + '\n\n# 索引\n模型改的\n' })
    sync('turn')
    writeFileSync(join(PT_MEM, dz.DEADZONE_FILE_NAME), '{ 这不是 JSON')   // ★ 数据坏掉
    writeTimeline(NODES[0])
    const before = fiveNow()
    const beforeIdx = indexRaw()
    // ① 判回档这一下：死区数据坏掉**不影响**"判到回档"（只提示、不写盘）
    const r = sync('turn')
    check('§2-6相 ★ 死区数据坏掉也照样判到回档（只记一条待处理）：那 5 份逐字节没变',
      r.kind === 'rollback' && r.restore === null && r.pending !== null && r.wrote === true
      && JSON.stringify(fiveNow()) === JSON.stringify(before),
      JSON.stringify([r.kind, r.wrote]))
    // ② 手动那一脚：判据未知 ⇒ **整次恢复不做**（fail-closed；⛔ 不许赌"这份不在死区里"）
    const idxBeforeManual = indexRaw()
    const m = restoreViaPanel({ memoryDir: PT_MEM, nodeId: NODES[0], variantId: VAR(NODES[0]), zones: zonesNow(), at: 'T2', stamp: 's2' })
    check('§2-6反证 ★ 死区数据坏掉（判据未知）⇒ 手动那一脚**整次恢复不做**：那 5 份逐字节没变、清单也没动',
      m.restore !== null && m.restore.blocked === 'deadzones-unreadable'
      && m.restore.moved.length === 0 && m.restore.failed.length === 0 && m.wrote === false
      && JSON.stringify(fiveNow()) === JSON.stringify(before) && indexRaw() === idxBeforeManual,
      JSON.stringify([m.restore && m.restore.blocked, m.wrote]))
    check('§2-6反证b ★ `last` **不前进**（留在原地）⇒ 那一档还能重试（⛔ 不拿"什么都没做"当"已经跟上了"）',
      indexOnDisk().last.nodeId === NODES[2] && indexOnDisk().last.variantId === VAR(NODES[2])
      && indexOf().pending !== null)
    check('§2-6反证c ★ 没成功 ⇒ 那条待处理**不清**（横幅该还在，下一轮还能重试）',
      m.pending !== null && m.pendingChanged === false && indexOf().pending !== null
      && beforeIdx !== idxBeforeManual)
  }

  // ── 对 7：相｜老条目（只有 nodeId）只读不恢复 ───────────────────────────────
  {
    reset(V1)
    const LEGACY_TEXT = '# 老记录里的那一段\n'
    const idx = fl.normalizeIndex({
      updatedAt: '2026-09-23T10:00:00.000Z',
      last: { nodeId: NODES[2], variantId: VAR(NODES[2]), seq: 3, at: '2026-09-23T09:00:00.000Z' },
      floors: [
        { nodeId: NODES[2], variantId: VAR(NODES[2]), seq: 3, at: '2026-09-23T09:00:00.000Z', files: [{ name: 'notes.md', sha256: dz.sha256Hex(V3['notes.md']), bytes: 20, changed: true }] },
        // ★ 上一版形状的老条目：只有 nodeId、不知道是哪一支（也**没有**对应的正文 blob）
        { nodeId: NODES[1], seq: 2, at: '2026-09-23T08:00:00.000Z', files: [{ name: 'notes.md', sha256: dz.sha256Hex(LEGACY_TEXT), bytes: 20, changed: true }] },
      ],
    })
    fl.writeIndex(PT_MEM, idx)
    writeTimeline(NODES[1])                    // head = (2, V1)
    const read = fl.readIndex(PT_MEM)
    const legacy = read.index.floors.find((f) => f.nodeId === NODES[1])
    check('§2-7相 ★ 老条目读得出来、如实标成"不知道是哪一支"（只读）',
      read.error === null && legacy !== undefined
      && fl.isLegacyFloor(legacy) === true && fl.isRestorableFloor(legacy) === false
      && read.index.floors.length === 2 && fl.floorsOfNode(read.index, NODES[1]).length === 1)
    const before = readMem('notes.md')
    // ★ 2026-09-24 收尾：基准（`seen`）显式给成"第 3 楼"——这一楼那一份 index 里 `last` 也是第 3 楼
    //   ⇒ 剧情退到第 2 楼 = **开 fork**（判据是剧情 vs `seen`，与档案在哪一楼无关）。
    const r = sync('turn', { seen: { nodeId: NODES[2], variantId: VAR(NODES[2]), seq: 3 } })
    check('§2-7相b ★ 回档到这一楼 ⇒ **不拿老条目当快照**（那一支没记过、连前一楼也没有 ⇒ 没有可退回的那一份；⛔ 笔记一个字节没动）',
      r.kind === 'rollback' && r.fork.kind === 'fork' && r.legacyAtHead === true
      && r.pending !== null && r.pending.targetNodeId === '' && r.pending.targetSeq === null
      && readMem('notes.md') === before && readMem('notes.md') !== LEGACY_TEXT
      && indexOnDisk().last.variantId === VAR(NODES[2]), JSON.stringify([r.kind, r.legacyAtHead, r.pending && r.pending.targetSeq]))
    const m = restoreViaPanel({ memoryDir: PT_MEM, nodeId: NODES[1], variantId: '', zones: [], at: 'T2', stamp: 'stamp2' })
    check('§2-7相c ★ 面板手动恢复点到老条目 ⇒ 拒（`legacy-no-restore`，一个字节都不写）',
      m.kind === 'legacy-no-restore' && m.wrote === false && readMem('notes.md') === before)
    const m2 = restoreViaPanel({ memoryDir: PT_MEM, nodeId: NODES[1], variantId: VAR(NODES[1]), zones: [], at: 'T2', stamp: 'stamp2' })
    check('§2-7相d ★ 连"这一楼这一支"也没有 ⇒ `no-snapshot`（⛔ 不许拿老条目顶替成本支的）',
      m2.kind === 'no-snapshot' && m2.wrote === false && readMem('notes.md') === before)
  }

  // ── 对 8：相｜预置一律不碰（rulebook / 大纲 / *示例.txt 在任何一次恢复里逐字节不变）──
  {
    const PRESET = {
      'rulebook.md': '# 作者预置 · 规则书\n原样\n',
      '大纲-甲.md': '# 作者预置 · 大纲\n原样\n',
      '幻蕊示例.txt': '示例文本\n原样\n',
    }
    reset(Object.assign({}, V1, PRESET))
    sync('turn')
    writeTimeline(NODES[2])
    putFiles(Object.assign({}, V3, { 'rulebook.md': '# 作者预置 · 规则书\n模型改的\n' }))
    sync('turn')
    writeTimeline(NODES[0])
    const r = sync('turn')
    const m = restoreViaPanel({ memoryDir: PT_MEM, nodeId: NODES[0], variantId: VAR(NODES[0]), zones: [], at: 'T2', stamp: 's2' })
    const after = Object.fromEntries(Object.keys(PRESET).map((n) => [n, readMem(n)]))
    check('§2-8相 ★ 判到回档（零写入）与手动恢复两脚之后，预置那几份（rulebook / 大纲 / 示例.txt）逐字节不变',
      after['rulebook.md'] === '# 作者预置 · 规则书\n模型改的\n'   // 模型改的**照旧留着**（我们既没碰、也没"还原"它）
      && after['大纲-甲.md'] === PRESET['大纲-甲.md'] && after['幻蕊示例.txt'] === PRESET['幻蕊示例.txt']
      && r.kind === 'rollback' && r.restore === null && r.pending !== null
      && m.restore.moved.every((x) => fl.isFloorFile(x.name))
      && indexOf().floors.every((f) => f.files.every((x) => fl.isFloorFile(x.name)))
      && blobs().every((n) => n !== dz.DEADZONE_FILE_NAME))
  }

  // ═════════════════════════════════════════════════════════════════════════
  sect('C 上一单那八对（回归；★ 20260924 回档改手动挡后，凡断言"自动写盘"的那几条都拆成"判到只提示 + 手动才写"）')

  // ── C-1：相｜没变就不记；反证｜改一个字符 ⇒ 必写，且只存变化那份的正文 ──────
  {
    reset(V1)
    const r1 = sync('turn')
    const raw1 = indexRaw()
    const blobs1 = blobs()
    const r2 = sync('turn')
    const raw2 = indexRaw()
    check('C-1相 ★ 第一次记一份：5 份都进清单（没内容的记 sha:null），只落有内容那几份的正文',
      r1.record !== null && r1.record.changed.join(',') === 'notes.md,index.md,state.md'
      && indexOnDisk().floors.length === 1 && indexOnDisk().floors[0].files.length === 5
      && blobs1.length === 3 && indexOnDisk().floors[0].seq === 1
      && indexOnDisk().floors[0].variantId === VAR(NODES[0])
      && indexOnDisk().last.nodeId === NODES[0] && indexOnDisk().last.variantId === VAR(NODES[0]), JSON.stringify(blobs1))
    check('C-1相b ★ 同一楼盘同一支、5 份逐字节没变 ⇒ **一个字节都不写**（index 连 at 都不动、blob 数不涨）',
      r2.record !== null && r2.record.changed.length === 0 && r2.wrote === false
      && raw2 === raw1 && blobs().length === blobs1.length, JSON.stringify([r2.wrote, raw2 === raw1]))
    writeMem('notes.md', '# 笔记\nv1!\n')
    const r3 = sync('turn')
    const blobs3 = blobs()
    const entry = indexOnDisk().floors[0]
    const md = entry.files.find((f) => f.name === 'notes.md')
    const ix = entry.files.find((f) => f.name === 'index.md')
    check('C-1反证 ★ 改一个字符 ⇒ 必写一份；且那一份只涉及**变化那几份**的正文（未变的走 sha 引用，blob 只多 1 个）',
      r3.record !== null && r3.record.changed.join(',') === 'notes.md'
      && blobs3.length === blobs1.length + 1
      && blobs3.includes(dz.sha256Hex('# 笔记\nv1!\n'))
      && md.sha256 === dz.sha256Hex('# 笔记\nv1!\n') && md.changed === true && md.delta === 1
      && ix.sha256 === dz.sha256Hex('# 索引\nv1\n') && ix.changed === false
      && blobs3.includes(ix.sha256), JSON.stringify([blobs3.length, blobs1.length]))
  }

  // ── C-2：相｜内容寻址（同内容只落一份正文）────────────────────────────────
  {
    const A = '# 笔记\n同一份内容\n'
    reset({ 'notes.md': A, 'index.md': '# 索引\nA\n' })
    sync('turn')
    const n0 = blobs().length
    writeTimeline(NODES[1])
    writeMem('notes.md', '# 笔记\n另一份\n')
    sync('turn')
    const n1 = blobs().length
    writeTimeline(NODES[2])
    writeMem('notes.md', A)          // ★ 写回与第 1 楼**完全相同**的内容
    sync('turn')
    const n2 = blobs().length
    check('C-2相 ★ 第 3 楼写回与第 1 楼相同的内容 ⇒ 正文只落一份（blob 数不涨），清单里两边 sha 相同',
      n1 === n0 + 1 && n2 === n1
      && indexOnDisk().floors.length === 3
      && fl.floorOfVariant(indexOf(), NODES[2], VAR(NODES[2])).files.find((f) => f.name === 'notes.md').sha256 === dz.sha256Hex(A)
      && fl.floorOfVariant(indexOf(), NODES[0], VAR(NODES[0])).files.find((f) => f.name === 'notes.md').sha256 === dz.sha256Hex(A),
      JSON.stringify([n0, n1, n2]))
  }

  // ── C-3：相｜正常前进不回档；反证｜用时间戳判 ⇒ 同一夹具必误判 ──────────────
  {
    reset(V1)
    sync('turn')                       // 第 1 楼
    writeTimeline(NODES[1])
    putFiles(V2)
    const r3 = sync('turn')
    check('C-3相 ★ head 走到后面的新楼层 ⇒ 不回档、笔记原样（就是模型刚写的样子），只是又记了一份',
      r3.kind === 'forward' && r3.restore === null && readMem('notes.md') === V2['notes.md']
      && indexOnDisk().floors.length === 2 && indexOnDisk().last.nodeId === NODES[1])
    // 反证夹具（真路径造出来，只把两楼记录的时刻**倒过来**）：
    //   1→2→1 之后又走回第 2 楼：head 在第 2 楼、last 在第 1 楼 —— 位置在前，
    //   而"当下"那一楼（第 2 楼）那份的快照是**更早**记的 ⇒ 时间戳那套会误判成"回档"。
    writeTimeline(NODES[0])
    sync('turn')                       // 回档到第 1 楼（★ 改口径后这一步**只提示**：last 不跟）
    // ★ 20260924：要让 `last` 真的回到第 1 楼，得走**手动**那一脚（判到回档自己不写盘）
    restoreViaPanel({ memoryDir: PT_MEM, nodeId: NODES[0], variantId: VAR(NODES[0]), zones: [], at: 'T1b', stamp: 's1b' })
    const idx = indexOnDisk()
    for (const f of idx.floors) {
      const stamp = f.nodeId === NODES[0] ? '2026-09-23T20:00:00.000Z' : '2026-09-23T08:00:00.000Z'
      f.at = stamp; f.updatedAt = stamp
    }
    idx.last.at = '2026-09-23T20:00:00.000Z'
    writeFileSync(indexPath(), JSON.stringify(idx, null, 2))
    writeTimeline(NODES[1])            // 又往前走回第 2 楼（笔记还是第 1 楼那份 —— 前进不恢复）
    const before = { notes: readMem('notes.md'), raw: indexRaw() }
    const tl = JSON.parse(readFileSync(join(PT, 'timeline.json'), 'utf8'))
    const seqOf = (id) => fl.seqOfNode(fl.seqMapOf(tl), id)
    const cur = indexOf()
    const decided = fl.decideRollback({ head: fl.headOf(tl), last: cur.last, floors: cur.floors, seqOf })
    // ★ 时间戳那一套（错误实现）：拿两边记录的时刻比大小
    const byStamp = Date.parse(fl.floorOfVariant(cur, NODES[1], VAR(NODES[1])).at) < Date.parse(fl.floorOfVariant(cur, NODES[0], VAR(NODES[0])).at)
      ? 'rollback' : 'forward'
    // ★ 2026-09-24 收尾：基准（`seen`）显式给成"第 1 楼"—— 这一条钉的是**位置判据**（剧情又往前走回第 2 楼
    //   ⇒ 不回档、什么都不写），⛔ 不掺"这一局历史上认过哪一楼"那一件事。
    const r = sync('turn', { seen: { nodeId: NODES[0], variantId: VAR(NODES[0]), seq: 1 } })
    check('C-3反证 ★ 把"用位置判前后"换成"用时间戳判" ⇒ 同一夹具必误判（红）：位置说前进，时间戳说回档',
      decided.kind === 'forward' && byStamp === 'rollback'
      && r.kind === 'forward' && readMem('notes.md') === before.notes && indexRaw() === before.raw,
      JSON.stringify([decided.kind, byStamp, r.kind]))
    check('C-3反证b ★ 那个误判**会造成真实改动**（按它去恢复第 2 楼，笔记会被换成第 2 楼那份）—— 所以不能用时间戳',
      (() => {
        const t = fl.floorOfVariant(indexOf(), NODES[1], VAR(NODES[1]))
        const blobTexts = {}
        for (const f of t.files.filter((x) => typeof x.sha256 === 'string')) blobTexts[f.sha256] = fl.readBlob(PT_MEM, f.sha256).text
        const plan = fl.planRestore({ floor: t, fileTexts: { 'notes.md': readMem('notes.md') }, blobTexts, zones: [] })
        return plan.writes.length > 0 && plan.writes.some((w) => w.name === 'notes.md' && w.text !== readMem('notes.md'))
      })())
  }

  // ── C-4：相｜手动那一脚把 5 份写回那一份；反证｜把恢复那一步挖掉 ⇒ 必红 ────────────
  //   ★ 20260924 改口径（回档改手动挡）：写盘那一脚从"判到回档就写"挪到"人在面板上点"——
  //     所以这里先断言"判到回档一个字节都没写"，再用 `restoreFloor`（面板那一脚）走真写。
  {
    reset(V1)
    sync('turn')                       // 第 1 楼
    writeTimeline(NODES[2])
    putFiles(V3)
    sync('turn')                       // 第 3 楼（往前走）
    writeTimeline(NODES[0])            // ★ 回档到第 1 楼
    const fiveBefore = fiveNow()
    const rAuto = sync('turn')
    check('C-4相a ★ 判到回档 ⇒ 那 5 份**一个字节都没写**（只记一条待处理）',
      rAuto.kind === 'rollback' && rAuto.restore === null && rAuto.pending !== null
      && JSON.stringify(fiveNow()) === JSON.stringify(fiveBefore)
      && backups().length === 0, JSON.stringify([rAuto.kind, rAuto.wrote]))
    const r = restoreViaPanel({ memoryDir: PT_MEM, nodeId: NODES[0], variantId: VAR(NODES[0]), zones: [], at: 'T2', stamp: 's2' })
    check('C-4相 ★ 手动点「把档案退回第 1 楼」⇒ 那 5 份被写回那一份的样子（逐字节）',
      r.kind === 'manual' && r.wrote === true
      && readMem('notes.md') === V1['notes.md'] && readMem('index.md') === V1['index.md'] && readMem('state.md') === V1['state.md']
      && r.restore.moved.map((m) => m.name).sort().join(',') === 'index.md,notes.md,state.md'
      && backups().length >= 3, JSON.stringify([r.kind, r.restore.moved.map((m) => m.name)]))
    check('C-4相b ★ 写回用**原子写 + 写前备份**（原件改名留档，⛔ 绝不销毁）',
      backups().some((n) => n.startsWith('notes.md.bak-')) && backups().some((n) => n.startsWith('index.md.bak-')))
    check('C-4相c ★ 恢复之后 `last` 跟到恢复的那一份（否则下一轮会被判成又一次回档 ⇒ 写盘循环）',
      indexOnDisk().last.nodeId === NODES[0] && indexOnDisk().last.seq === 1
      && indexOnDisk().last.variantId === VAR(NODES[0]))
    check('C-4反证 ★ 把恢复那一步挖掉 ⇒ 同一夹具下"笔记回到那一份"必红（盘上还是第 3 楼那份）',
      (() => {
        putFiles(V3)   // 重现"回档前"的盘面
        const t = fl.floorOfVariant(indexOf(), NODES[0], VAR(NODES[0]))
        const blobTexts = {}
        for (const f of t.files.filter((x) => typeof x.sha256 === 'string')) blobTexts[f.sha256] = fl.readBlob(PT_MEM, f.sha256).text
        const plan = fl.planRestore({ floor: t, fileTexts: { 'notes.md': readMem('notes.md') }, blobTexts, zones: [] })
        const dug = plan.writes.some((w) => w.name === 'notes.md')   // ← 这一步本该写盘；"挖掉"= 不调用 writeRestoredFile
        return dug === true && readMem('notes.md') === V3['notes.md'] && readMem('notes.md') !== V1['notes.md']
      })())
  }

  // ── C-5：相｜回档前先留一份（可撤销）──────────────────────────────────────
  {
    reset(V1)
    sync('turn')                       // 第 1 楼
    writeTimeline(NODES[2])
    putFiles(V3)
    sync('turn')                       // 第 3 楼
    // ★ 回档**之前**盘上又变过（模型写了、但轮末还没到 / 用户在盘外改的）⇒ 那一份要被留住
    const LATEST = { 'notes.md': '# 笔记\nv3 之后又写了\n', 'index.md': '# 索引\nv3\n', 'state.md': '# 状态\nv3\n' }
    putFiles(LATEST)
    writeTimeline(NODES[0])
    // ★ 20260924 改口径：这一脚现在是**手动**的（判到回档本身不写盘）⇒ 直接用 `restoreFloor`。
    const r = restoreViaPanel({ memoryDir: PT_MEM, nodeId: NODES[0], variantId: VAR(NODES[0]), zones: [], at: 'T2', stamp: 's2' })
    const n3 = fl.floorOfVariant(indexOf(), NODES[2], VAR(NODES[2]))
    const n3notes = n3.files.find((f) => f.name === 'notes.md')
    check('C-5相 ★ 手动恢复发生时，"当下"那一份快照也在（挂在恢复前那一份上，逐字节是刚变过的样子）',
      r.pre !== null && r.pre.nodeId === NODES[2] && r.pre.variantId === VAR(NODES[2])
      && n3notes.sha256 === dz.sha256Hex(LATEST['notes.md'])
      && fl.readBlob(PT_MEM, n3notes.sha256).text === LATEST['notes.md'])
    const back = restoreViaPanel({ memoryDir: PT_MEM, nodeId: NODES[2], variantId: VAR(NODES[2]), zones: [], at: 'T2', stamp: 'stamp2' })
    check('C-5相b ★ 可撤销：点回第 3 楼那一支 ⇒ 笔记回到"回档前那一刻"的样子（⛔ 不是更早那份）',
      back.kind === 'manual' && readMem('notes.md') === LATEST['notes.md']
      && readMem('index.md') === LATEST['index.md'])
  }

  // ── C-6：反证｜预置不碰 + ★ 死区**按块合并**（本单改的口径：不再"整份跳过"）──────
  //   为什么改：上一版"凡是出现在死区文件名单里的文件，回档一律跳过"会把整份 index.md 冻住
  //   （连"最近进展"都回不了档）；用户 2026-09-23 拍板改成"死区那几段保留现状、其余照快照"。
  {
    const CORE = '## 【必须遵守的核心规则】\n- 不许替玩家做决定'
    reset({
      'notes.md': V1['notes.md'], 'index.md': `${CORE}\n\n# 索引\nv1\n`,
      'rulebook.md': '# 作者预置 · 规则书\n原样\n', '大纲-甲.md': '# 作者预置 · 大纲\n原样\n',
    })
    writeDeadzones([['index.md', CORE], ['rulebook.md', '# 作者预置 · 规则书']])
    sync('turn')                       // 第 1 楼（死区那几条由调用方从真文档里读出来喂进去）
    check('C-6 夹具就位：死区文档在场（那两份是"作者的"）',
      existsSync(join(PT_MEM, dz.DEADZONE_FILE_NAME)) && dz.readDocFile(PT_MEM).doc.zones.length === 2)
    const CHANGED = {
      'notes.md': '# 笔记\n模型又写了\n', 'index.md': `${CORE}\n\n# 索引\n模型改的\n`,
      'rulebook.md': '# 作者预置 · 规则书\n模型改的\n', '大纲-甲.md': '# 作者预置 · 大纲\n模型改的\n',
    }
    writeTimeline(NODES[1])
    putFiles(CHANGED)
    sync('turn')                       // 第 2 楼（模型把四份都改了）
    writeTimeline(NODES[0])            // ★ 回档到第 1 楼
    const rAuto = sync('turn')           // ★ 判到回档：只提示、零写入
    // ★ 手动那一脚（面板那颗按钮）：死区判据由接线那一层从**真文档**读出来喂进去
    const r = restoreViaPanel({ memoryDir: PT_MEM, nodeId: NODES[0], variantId: VAR(NODES[0]), zones: zonesNow(), at: 'T2', stamp: 's2' })
    check('C-6反证 ★ 判到回档那一脚 + 手动恢复那一脚之后：rulebook / 大纲 逐字节没变（不在那 5 份里 ⇒ 一个都不许被写）',
      readMem('rulebook.md') === CHANGED['rulebook.md'] && readMem('大纲-甲.md') === CHANGED['大纲-甲.md']
      && rAuto.pending !== null && rAuto.restore === null
      && r.restore.moved.every((m) => fl.isFloorFile(m.name)))
    check('C-6相 ★ index.md 里有死区 ⇒ **按块合并**：非死区那半回到第 1 楼，死区那段保留盘上现况（这里是逐字没变的）',
      readMem('index.md') === `${CORE}\n\n# 索引\nv1\n`
      && r.restore.moved.some((m) => m.name === 'index.md')
      && r.restore.skipped.some((s) => s.name === 'index.md' && s.reason === 'deadzone' && s.merged === true)
      && r.restore.skipped.every((s) => s.reason !== 'deadzone' || s.name !== 'notes.md'))
    check('C-6 相b ★ 死区名单**压不过**"非死区块照快照回档"（这一条就是本单改的口径 —— 上一版这里是"整份跳过"）',
      readMem('index.md').includes('# 索引\nv1\n') && readMem('notes.md') === V1['notes.md'])
    check('C-6反证c ★ 把"只恢复那 5 份"的判据挖掉 ⇒ 必红（无白名单的同款逻辑会把 rulebook.md 也写回去）',
      (() => {
        // 灵敏度自证：手写一份**没有白名单**的恢复裁决（字符串夹具那种"挖掉那一步"的做法）
        const noGuard = (rawFloor, fileTexts, blobTexts) => {
          const out = []
          for (const f of rawFloor.files) {
            const text = blobTexts[f.sha256]
            if (typeof text !== 'string') continue
            if (typeof fileTexts[f.name] === 'string' && dz.sha256Hex(fileTexts[f.name]) === f.sha256) continue
            out.push({ name: f.name, text })
          }
          return out
        }
        const rawFloor = {
          nodeId: NODES[0], variantId: VAR(NODES[0]),
          files: [
            { name: 'rulebook.md', sha256: dz.sha256Hex('# 作者预置 · 规则书\n原样\n'), bytes: 1, changed: true },
            { name: 'notes.md', sha256: dz.sha256Hex(V1['notes.md']), bytes: 1, changed: true },
          ],
        }
        const blobTexts = {
          [dz.sha256Hex('# 作者预置 · 规则书\n原样\n')]: '# 作者预置 · 规则书\n原样\n',
          [dz.sha256Hex(V1['notes.md'])]: V1['notes.md'],
        }
        const wall = noGuard(rawFloor, { 'rulebook.md': CHANGED['rulebook.md'], 'notes.md': '# 笔记\n模型又写了\n' }, blobTexts)
        const real = fl.planRestore({ floor: rawFloor, fileTexts: {}, blobTexts, zones: [] })
        return wall.some((w) => w.name === 'rulebook.md') === true && real.writes.every((w) => w.name !== 'rulebook.md')
      })())
  }

  // ── C-7：★ 改口径｜回到"没有快照的楼层"⇒ 按新口径退回**进这一楼之前** ─────────
  //   为什么改：本单 §1.2 第 3 条 b)（没记过 ⇒ 用紧邻前一楼最后一条 = 退回进楼前）。
  //   反证那一半照旧：**那一轮不许顺手把它记成那一楼的一份**（拿后来的内容冒充会毒掉以后的回档）。
  {
    reset(V1)
    sync('turn')                       // 第 1 楼
    writeTimeline(NODES[3])
    putFiles(V3)
    sync('turn')                       // 第 4 楼（第 2、3 楼没有快照）
    writeTimeline(NODES[1])            // ★ 回档到**没有快照**的第 2 楼
    putFiles({ 'notes.md': '# 笔记\n模型在第 4 楼又写了\n' })
    const before2 = { notes: readMem('notes.md'), idx: readMem('index.md') }
    const r = sync('turn')
    check('C-7相 ★ 回到没有快照的楼层 ⇒ 待处理指向"进这一楼之前"（用第 1 楼那一份），如实说用的是哪一份',
      r.kind === 'rollback' && r.restore === null && r.pending !== null && r.pending.source === 'prev'
      && r.pending.targetSeq === 1 && r.pending.toSeq === 2 && r.headSeq === 2
      && readMem('notes.md') === before2.notes && readMem('notes.md') !== V1['notes.md'],
      JSON.stringify([r.kind, r.pending && r.pending.source, r.pending && r.pending.targetSeq]))
    const m = restoreViaPanel({ memoryDir: PT_MEM, nodeId: NODES[0], variantId: VAR(NODES[0]), zones: [], at: 'T2', stamp: 's2' })
    check('C-7相b ★ 手动点那一脚才真退回"进这一楼之前"（笔记回到第 1 楼那份、`last` 也跟着）',
      m.kind === 'manual' && readMem('notes.md') === V1['notes.md'] && readMem('index.md') === V1['index.md']
      && indexOnDisk().last.nodeId === NODES[0])
    check('C-7反证 ★ 那一楼**也没有被"顺手记一份"**（拿第 4 楼的内容冒充第 2 楼会毒掉以后的回档）',
      fl.floorsOfNode(indexOf(), NODES[1]).length === 0
      && before2.notes !== V1['notes.md'])
  }

  // ── C-8：相｜用户改过就跟着走（且在那一支恢复时用的是用户改过的那份）──────
  {
    reset(V1)
    sync('turn')                       // 第 1 楼
    writeTimeline(NODES[1])
    putFiles(V2)
    sync('turn')                       // 第 2 楼
    const MINE = '# 笔记\nv2 + 我自己加的一段\n'
    const r = await call('POST', '/playthrough/rp-memory/write', {
      file: 'notes.md', text: MINE, sha256: dz.sha256Hex(readMem('notes.md')),
    })
    const n2 = fl.floorOfVariant(indexOf(), NODES[1], VAR(NODES[1]))
    check('C-8相 ★ 面板"直接改"保存某份 ⇒ 该楼层**这一支**的快照跟着刷新（sha/blob/清单三处都跟上）',
      r.status === 200 && r.data.ok === true && r.data.floors && r.data.floors.refreshed === true
      && r.data.floors.seq === 2
      && n2.files.find((f) => f.name === 'notes.md').sha256 === dz.sha256Hex(MINE)
      && fl.readBlob(PT_MEM, dz.sha256Hex(MINE)).text === MINE
      && readMem('notes.md') === MINE, JSON.stringify(r.data && r.data.floors))
    check('C-8相b ★ 保存**不触发任何"恢复"**（盘上就是你刚保存的那份；另外几份一个字节没动）',
      readMem('index.md') === V2['index.md'] && readMem('state.md') === V2['state.md']
      && fl.floorOfVariant(indexOf(), NODES[1], VAR(NODES[1])).files.find((f) => f.name === 'index.md').sha256 === dz.sha256Hex(V2['index.md']))
    writeTimeline(NODES[3])
    putFiles(V3)
    sync('turn')                       // 第 4 楼
    writeTimeline(NODES[1])            // 回档到第 2 楼
    const back = sync('turn')
    check('C-8相c ★ 后来回档回这一支 ⇒ 待处理指向**这一支**（用户自己改过的那份），笔记先不动',
      back.kind === 'rollback' && back.restore === null
      && back.pending !== null && back.pending.targetKey === fl.floorKeyOf(NODES[1], VAR(NODES[1]))
      && readMem('notes.md') === V3['notes.md'],
      JSON.stringify([back.kind, back.pending && back.pending.targetKey]))
    const m = restoreViaPanel({ memoryDir: PT_MEM, nodeId: NODES[1], variantId: VAR(NODES[1]), zones: [], at: 'T3', stamp: 's3' })
    check('C-8相d ★ 手动点「把档案退回第 2 楼」⇒ 恢复的是**用户自己改过**的那份（决定④的落点）',
      m.kind === 'manual' && readMem('notes.md') === MINE
      && m.restore.moved.some((x) => x.name === 'notes.md'))
  }

  // ═════════════════════════════════════════════════════════════════════════
  sect('D 接线（真 HTTP + 真钩子：轮末才记 / 判到回档**只提示** / 手动才写 / 面板走端点 / 不碰别的）')

  check('D1 ★ 两条钩子都在场（组装时那条 + 轮末那条），且注册在同一个插件里',
    assembleFns().length >= 1 && eventFns().length >= 1
    && listeners.some((l) => l.who === 'dsh-memory-archive:floor-snapshot' && l.event === 'session/event')
    && listeners.some((l) => l.who === 'dsh-memory-archive:floor-snapshot' && l.event === 'system-prompt/assemble'))

  {
    // 组装那一脚：判到**开 fork** —— ★ 20260924 改口径（手动挡）后它**只提示**：不占本轮时间、
    //   也不在本轮之内（或之后）写那 5 份；那一跳待处理在本轮之内就记好了。
    //   ★★ 2026-09-24 收尾：前两楼改走**真钩子**（`turn/end`）—— "开 fork"的判据是"剧情 vs `seen`"，
    //   而 `seen` 只有**宿主**会记（`floor-head.json`）⇒ 夹具必须让宿主自己走到那两个位置，
    //   ⛔ 不能再拿直接调 `syncFloor` 的夹具冒充（那样宿主那份簿记还是空的 ⇒ 判成 no-seen、不弹横幅）。
    reset(V1)
    await fireEvent('turn/end')        // 第 1 楼（真钩子记一份 + `seen ← 第 1 楼`）
    writeTimeline(NODES[2])
    putFiles(V3)
    await fireEvent('turn/end')        // 第 3 楼（`seen ← 第 3 楼`）
    writeTimeline(NODES[0])            // 回档到第 1 楼（还没人处理）
    const fiveBefore = fiveNow()
    const atNext = await drive(7, { snap: () => readMem('notes.md') })
    check('D2 ★ 真接线｜判到回档**一个字节都不写**：调 next() 那一刻与让出事件循环之后，笔记都还是第 3 楼那份',
      atNext === V3['notes.md'] && readMem('notes.md') === V3['notes.md']
      && JSON.stringify(fiveNow()) === JSON.stringify(fiveBefore) && backups().length === 0,
      JSON.stringify([atNext]))
    check('D2b ★ 但那条待处理在本轮之内就记好了（组装那一脚就跑完 —— ⛔ 不等轮末）',
      indexOf().pending !== null && indexOf().pending.fromSeq === 3 && indexOf().pending.toSeq === 1
      && indexOf().pending.targetSeq === 1 && indexOf().pending.why === 'back'
      && indexOf().pending.source === 'self' && indexOf().pending.archiveSeq === 3,
      JSON.stringify(indexOf().pending))
    check('D2c ★ 回档只提示、如实播报（日志一条：剧情从哪一楼退到哪一楼 + 档案停在哪一楼 + 一个字节都没写 + 得由人在面板上点）',
      floorLogs().some((m) => m.includes('检测到回档到第 1 楼') && m.includes('剧情刚从第 3 楼退到第 1 楼')
        && m.includes('档案停在第 3 楼')
        && m.includes('一个字节都没写') && m.includes('得由你在面板上点')
        && !m.includes('第 第') && !m.includes('楼 楼')), JSON.stringify(floorLogs().slice(-2)))
    check('D2d ★ 面板那句「最近一次回档」有料可读（状态文件如实落盘：从第 3 楼 → 第 1 楼 + 那条待处理 + 零恢复）',
      statusDoc() !== null && statusDoc().kind === 'rollback'
      && statusDoc().to !== null && statusDoc().to.seq === 1 && statusDoc().to.variantId === VAR(NODES[0])
      && statusDoc().from !== null && statusDoc().from.seq === 3
      && Array.isArray(statusDoc().restored) && statusDoc().restored.length === 0
      && statusDoc().pending !== null && statusDoc().pending.targetSeq === 1
      && statusDoc().playthroughId === 'pt', JSON.stringify(statusDoc()))
    const at1 = statusAt()
    // ★ 同一个 turn 里再驱动两次装配 ⇒ 一次都不再跑（每轮至多一次）
    writeTimeline(NODES[2])            // 换 head（若门坏了 ⇒ 会跑一次"往前走"，不写状态；但下面那条换了不认识的头）
    await drive(7)
    check('D3 ★ 每一轮至多一次：同一 turn 里再驱动装配 ⇒ 不再跑（状态文件一个字节没动）',
      statusAt() === at1, JSON.stringify([at1, statusAt()]))
    writeTimeline('qa-99-99-zzz')
    await drive(7)
    check('D3b ★ 同一 turn 里 head 变了也不跑（门是"这一轮"，⛔ 不是"状态没变"）', statusAt() === at1, JSON.stringify(statusAt()))
    await drive(8)
    check('D3c ★ 换一轮（turn=8）⇒ 门开着，如实播报"认不出先后 ⇒ 不动笔记"（⛔ 不拿时间戳猜）',
      statusAt() !== at1 && statusDoc().kind === 'unknown-order'
      && String(statusDoc().message).includes('认不出'), JSON.stringify(statusDoc()))
    check('D3d ★ 那句播报同一个结果只报一条（⛔ 不每个 step 刷屏）',
      floorLogs().filter((m) => m.includes('认不出它在时间线里的先后')).length === 1,
      String(floorLogs().filter((m) => m.includes('认不出')).length))
  }

  {
    // ★ 真钩子那一层的 swipe：换变体也算回档（组装那一脚就把笔记退回进楼前）
    //   ★★ 收尾：前两楼走**真钩子**（`seen` 只有宿主会记 ⇒ 夹具得让宿主自己走到那两楼）。
    reset(V1)
    await fireEvent('turn/end')                            // 第 1 楼（`seen ← 第 1 楼`）
    writeTimeline(NODES[1]); putFiles(V2)
    await fireEvent('turn/end')                            // 第 2 楼（`seen ← 第 2 楼（第 1 支）`）
    writeTimeline(NODES[1], NODES, VAR(NODES[1], 2))      // ★ swipe 到第 2 支
    putFiles({ 'notes.md': '# 笔记\n第 2 支重 roll 出来的\n' })
    await drive(31)
    check('D4 ★ 真接线｜同一楼 swipe（换变体）⇒ 组装那一脚就记下待处理（指向"进这一楼之前"），笔记一个字节没动',
      readMem('notes.md') === '# 笔记\n第 2 支重 roll 出来的\n'
      && indexOf().pending !== null && indexOf().pending.source === 'prev'
      && indexOf().pending.targetSeq === 1 && indexOf().pending.why === 'variant'
      && String(statusDoc().message).includes('换了变体')
      // ★ 20260924 改口径：状态文件里的 `to` = **剧情站到的那一楼**（不是"要退回哪一份"），
      //   "要退回哪一份"在那条待处理里（`pending.targetSeq`）—— 两者在 swipe 时**不是**同一楼。
      && statusDoc().to.seq === 2 && statusDoc().to.variantId === VAR(NODES[1], 2)
      && statusDoc().pending !== null && statusDoc().pending.targetSeq === 1
      && statusDoc().why === 'variant'
      // ★ "哪一楼 / 哪一支 → 恢复到哪一份"要说得出来（两条变体 id 都在那句里）
      && String(statusDoc().message).includes(VAR(NODES[1]))
      && String(statusDoc().message).includes(VAR(NODES[1], 2))
      && String(statusDoc().message).includes('用的是第 1 楼那一份')
      // ★ 文案不许出现叠字（`seat()` 自己带"第 N 楼" ⇒ 别再外面套一层）
      && !String(statusDoc().message).includes('第 第')
      && !String(statusDoc().message).includes('楼 楼'), JSON.stringify(statusDoc()))
  }

  {
    // ★ 真钩子那一层的"回到前面一个**没有快照**的楼层"：按新口径退回进楼前，那句要说清"从哪一楼回、用的是哪一份"
    //   ★★ 收尾：前两楼走**真钩子**（`seen` 只有宿主会记）⇒ 回到第 2 楼才判得成"开 fork"。
    reset(V1)
    await fireEvent('turn/end')                            // 第 1 楼
    writeTimeline(NODES[3]); putFiles(V3)
    await fireEvent('turn/end')                            // 第 4 楼（第 2、3 楼没记过；`seen ← 第 4 楼`）
    writeTimeline(NODES[1])            // ★ 回到第 2 楼（它没有快照）
    putFiles({ 'notes.md': '# 笔记\n第 4 楼之后模型又写了\n' })
    await drive(41)
    check('D4b ★ 真接线｜回到没有快照的楼层 ⇒ 待处理指向"进这一楼之前"，那句把"回档到第 2 楼"与"用的是第 1 楼那一份"都说了（笔记没动）',
      readMem('notes.md') === '# 笔记\n第 4 楼之后模型又写了\n'
      && indexOf().pending !== null && indexOf().pending.source === 'prev'
      && indexOf().pending.targetSeq === 1 && indexOf().pending.toSeq === 2
      && statusDoc().why === 'back' && statusDoc().source === 'prev'
      && String(statusDoc().message).includes('检测到回档到第 2 楼')
      && String(statusDoc().message).includes('用的是第 1 楼那一份')
      && !String(statusDoc().message).includes('第 第'), JSON.stringify(statusDoc()))
  }

  {
    // 轮末那一脚：记一份（turn/end）+ 压缩那一轮也记（compaction/end）
    reset(V1)
    const n0 = blobs().length
    await fireEvent('turn/end')
    check('D5 ★ 轮末（turn/end）那一脚记一份：清单 + 正文都落盘了（watch 那一脚不记，只有轮末记）',
      existsSync(indexPath()) && indexOnDisk().floors.length === 1 && blobs().length === n0 + 3
      && indexOnDisk().floors[0].variantId === VAR(NODES[0]))
    const raw1 = indexRaw()
    await fireEvent('turn/end')
    check('D5b ★ 再一个轮末、笔记没变 ⇒ 一个字节都不写（⛔ 不许每轮写盘）', indexRaw() === raw1)
    writeMem('notes.md', '# 笔记\nv1 之后模型又写了\n')
    await fireEvent('compaction/end')
    check('D5c ★ 压缩那一轮也记（compaction/end 少一条就会漏掉手动 /compact 那一轮）',
      indexRaw() !== raw1 && indexOnDisk().floors.length === 1
      && fl.floorOfVariant(indexOf(), NODES[0], VAR(NODES[0])).files.find((f) => f.name === 'notes.md').sha256 === dz.sha256Hex('# 笔记\nv1 之后模型又写了\n'))
  }

  {
    // 端点：只读清单（面板要的那几样都在，且判据全在宿主这边）
    reset(V1)
    sync('turn')
    writeTimeline(NODES[2])
    putFiles(V3)
    sync('turn')
    const v = await floorsView()
    const cur = v.floors.filter((f) => f.current)
    // ★★ 2026-09-25 改口径（用户原话「**插件自己按时间编一个序号，不论实际seq**，这样反而符合直觉，
    //   序号最大的就是最新生成的」＋「**不要楼号了……只标序号**」）：
    //   清单**不再按 `seq` 升序**，而是按**新算的 `ordinal`**（按记录时间升序编号、**从大到小**渲染）；
    //   每一行/`head`/`last` 都多带一个 `ordinal`（面板显示的「序号 N」就是它），`seq` **照旧照带**
    //   （判据与锚还用它）。⇒ 老那两条 `floors.map(f => f.seq).join(',') === '1,3'` 与
    //   `floors[0] = 第 1 楼（delta 全 null）` 按新口径改写（⛔ 不是删断言：改成"倒序 + 序号"那一份）。
    check('D6 ★ GET /floors：每一支给序号/变体/时间/改了哪几份（+几字节）/当前那一支高亮，且只列记过的',
      v.ok === true && v.floors.length === 2
      && v.floors.map((f) => f.seq).join(',') === '3,1'                     // ★ 倒序：最新在最上
      && v.floors.map((f) => f.ordinal).join(',') === '2,1'                 // ★ 序号：1..N，N = 最新
      && v.floors.every((f) => Number.isFinite(f.ordinal))
      && cur.length === 1 && cur[0].seq === 3 && cur[0].variantId === VAR(NODES[2]) && cur[0].ordinal === 2
      && v.head.seq === 3 && v.head.variantId === VAR(NODES[2]) && v.head.ordinal === 2 && v.orderKnown === true
      && v.last.variantId === VAR(NODES[2]) && v.lastFloorSeq === 3 && v.last.ordinal === 2
      && v.floors.filter((f) => f.pointer === true).length === 1
      && v.floors.filter((f) => f.pointer === true)[0].seq === 3
      && Array.isArray(v.targets) && v.targets.length === 5
      && v.floors.every((f) => f.legacy === false)
      && Array.isArray(v.legacyFloors) && v.legacyFloors.length === 0
      // 最新那一条（第 3 楼）那三份都有 +N 字节；更早的第 1 楼那三份是"第一次出现"⇒ 没有基数（delta 如实为 null）
      && v.floors[0].changed.length === 3 && v.floors[0].changed.every((c) => Number.isFinite(c.delta))
      && v.floors[1].changed.length === 3 && v.floors[1].changed.every((c) => c.delta === null)
      && v.floors[0].changed.some((c) => c.name === 'notes.md'), JSON.stringify([v.floors.map((f) => f.seq), v.floors.map((f) => f.ordinal), v.floors[0].changed, v.floors[1].changed]))
    check('D6b ★ GET /floors 只读：一个字节都没写（清单与正文逐字节没变）',
      indexOnDisk().floors.length === 2 && readMem('notes.md') === V3['notes.md'])
    const wasRaw = indexRaw()
    await call('GET', '/playthrough/rp-memory/floors')
    check('D6b2 ★ 再读一次还是逐字节一样（⛔ 读端点不刷任何时间戳）', indexRaw() === wasRaw)
    rmSync(PT_MEM, { recursive: true, force: true })   // 记忆库没了 ⇒ 读侧老口径
    const noMem = await call('GET', '/playthrough/rp-memory/floors')
    check('D6c 还没有记忆库 ⇒ 读侧老口径（HTTP 200 + ok:false，⛔ 不抛 500）',
      noMem.status === 200 && noMem.data.ok === false && noMem.data.error.code === 'RP_MEMORY_MISSING')
  }

  {
    // 端点：面板「回到这一楼」（手动触同一份恢复；失败要如实）
    reset(V1)
    sync('turn')
    writeTimeline(NODES[2])
    putFiles(V3)
    sync('turn')
    const tlBefore = readFileSync(join(PT, 'timeline.json'), 'utf8')
    const catBefore = readFileSync(join(WS, 'catalog.json'), 'utf8')
    const bad = await call('POST', '/playthrough/rp-memory/floors/restore', { nodeId: '不认识', variantId: 'v' })
    check('D7 ★ 没有快照的那一楼那一支 ⇒ 404 + 一句人话（⛔ 不静默、⛔ 不装成功）',
      bad.status === 404 && bad.data.ok === false && String(bad.data.error.code).includes('NO_SNAPSHOT'))
    const badBody = await call('POST', '/playthrough/rp-memory/floors/restore', {})
    check('D7b 体里没带 nodeId ⇒ 400（写侧口径）', badBody.status === 400 && badBody.data.ok === false)
    const ok = await call('POST', '/playthrough/rp-memory/floors/restore', { nodeId: NODES[0], variantId: VAR(NODES[0]) })
    check('D7c ★ 手动「回到这一楼」= 同一个恢复函数（笔记回到第 1 楼那一支；回执里有 message 给面板原样画）',
      ok.status === 200 && ok.data.ok === true && readMem('notes.md') === V1['notes.md']
      && ok.data.variantId === VAR(NODES[0])
      && typeof ok.data.message === 'string' && ok.data.message.includes('回到这一楼')
      && ok.data.restored.some((x) => x.name === 'notes.md' && typeof x.backup === 'string'))
    check('D7d ★ 手动那一脚也**不影响会话**（⛔ 不碰 timeline / catalog：两份逐字节没变）',
      readFileSync(join(PT, 'timeline.json'), 'utf8') === tlBefore
      && readFileSync(join(WS, 'catalog.json'), 'utf8') === catBefore)
    // ★ 老条目：体里带这一楼、但没有变体（只有老记录）⇒ 409 + 人话（⛔ 一个字节都不写）
    const idxLegacy = indexOf()
    fl.writeIndex(PT_MEM, {
      schemaVersion: fl.FLOOR_SCHEMA_VERSION, updatedAt: idxLegacy.updatedAt,
      last: idxLegacy.last,
      floors: idxLegacy.floors.concat([{ nodeId: 'qa-9-9-old', seq: 9, at: 'T', files: [{ name: 'notes.md', sha256: dz.sha256Hex('# 老记录\n'), bytes: 5, changed: true }] }]),
    })
    const legacyBefore = readMem('notes.md')
    const legacyCall = await call('POST', '/playthrough/rp-memory/floors/restore', { nodeId: 'qa-9-9-old', variantId: '' })
    check('D7e ★ 老条目只读：端点拒恢复（409 + RP_MEMORY_FLOOR_LEGACY，一个字节都不写）',
      legacyCall.status === 409 && legacyCall.data.ok === false
      && String(legacyCall.data.error.code).includes('LEGACY')
      && readMem('notes.md') === legacyBefore)
    const v2 = await floorsView()
    check('D7f ★ 老条目在清单里如实标出来（`legacy:true` + `legacyFloors` 一句）',
      v2.floors.some((f) => f.nodeId === 'qa-9-9-old' && f.legacy === true && f.current === false)
      && v2.legacyFloors.some((f) => f.nodeId === 'qa-9-9-old'))
    // ★ 部分失败：把其中一份换成目录（写不进去）⇒ 500 + 哪几份没写进去（⛔ 不许部分成功当全成功）
    putFiles(V3)
    unlinkSync(join(PT_MEM, 'notes.md'))
    mkdirSync(join(PT_MEM, 'notes.md'))
    const part = await call('POST', '/playthrough/rp-memory/floors/restore', { nodeId: NODES[0], variantId: VAR(NODES[0]) })
    check('D7g ★ 有哪一份写不进去 ⇒ 500 + 如实列出（其它照旧；⛔ 绝不"部分成功当全成功"）',
      part.status === 500 && part.data.ok === false
      && Array.isArray(part.data.restore.failed) && part.data.restore.failed.some((x) => x.name === 'notes.md' && x.reason)
      && part.data.restore.restored.some((x) => x.name === 'index.md')
      && readMem('index.md') === V1['index.md']
      && String(part.data.error.message).includes('没写进去'), JSON.stringify(part.data.restore && part.data.restore.failed))
    rmSync(join(PT_MEM, 'notes.md'), { recursive: true, force: true })
    writeMem('notes.md', V3['notes.md'])
  }

  {
    // ★★ 2026-09-24 新端点那一对：`GET /floors` 带出那条待处理 + `POST …/floors/pending/settle`（保持现状）
    reset(V1)
    sync('turn')                       // 第 1 楼
    writeTimeline(NODES[2]); putFiles(V3); sync('turn')   // 第 3 楼
    writeTimeline(NODES[0])            // 回档到第 1 楼
    const tlBefore = readFileSync(join(PT, 'timeline.json'), 'utf8')
    const catBefore = readFileSync(join(WS, 'catalog.json'), 'utf8')
    const v0 = await floorsView()
    check('D10 ★ GET /floors：还没判过 ⇒ `pending` 如实为 null（面板据此**不画**横幅）',
      v0.ok === true && v0.pending === null)
    sync('turn')                       // 判到回档 ⇒ 记下那条
    const fiveBefore = fiveNow()
    const v1 = await floorsView()
    check('D10b ★ GET /floors 里那条 pending 字段齐（from*/to*/archive*/target*/why/source/targetKey/at），且仍然**纯只读**',
      v1.ok === true && v1.pending !== null
      && v1.pending.fromNodeId === NODES[2] && v1.pending.fromSeq === 3
      && v1.pending.toNodeId === NODES[0] && v1.pending.toSeq === 1
      // ★ 2026-09-24 收尾：`archive*` = **档案停在哪一楼**（横幅要如实说出来；⛔ 不拿 from 冒充）
      && v1.pending.archiveNodeId === NODES[2] && v1.pending.archiveSeq === 3
      && v1.pending.targetNodeId === NODES[0] && v1.pending.targetSeq === 1
      && v1.pending.why === 'back' && v1.pending.source === 'self'
      && v1.pending.targetKey === fl.floorKeyOf(NODES[0], VAR(NODES[0]))
      && typeof v1.pending.at === 'string' && v1.pending.at !== ''
      && v1.head.seq === 1 && v1.floors.length === 2
      && readFileSync(join(PT, 'timeline.json'), 'utf8') === tlBefore
      && readFileSync(join(WS, 'catalog.json'), 'utf8') === catBefore
      && JSON.stringify(fiveNow()) === JSON.stringify(fiveBefore), JSON.stringify(v1.pending))
    const wasRaw = indexRaw()
    await call('GET', '/playthrough/rp-memory/floors')
    check('D10c ★ 再读一次清单逐字节一样（⛔ 读端点不刷任何时间戳）', indexRaw() === wasRaw)
    // ★ 带一个跟当下那条不一致的 targetKey ⇒ 409（⛔ 绝不"按老目标就地登记"）
    const stale = await call('POST', '/playthrough/rp-memory/floors/pending/settle', { targetKey: '别的目标' })
    check('D10d ★ 体里的 targetKey 与当下那条不一致 ⇒ 409 + 如实说（那条还在原样，一个字节都没动）',
      stale.status === 409 && stale.data.ok === false
      && String(stale.data.error.code).includes('PENDING_STALE')
      && indexOf().pending !== null && indexOf().pending.targetKey === v1.pending.targetKey)
    const badBody = await call('POST', '/playthrough/rp-memory/floors/pending/settle')
    check('D10e ★ 体坏（没带 JSON）⇒ 400（写侧口径，⛔ 不静默）', badBody.status === 400 && badBody.data.ok === false)
    // ★★ 「保持现状」＝**就地登记**（2026-09-24 用户口径：跟 Tavern 一致 —— 回档之后那段历史就按新的算）
    const shaNotesOf = (idx, nodeId) => {
      const row = (idx.floors ?? []).find((f) => f.nodeId === nodeId)
      const rec = row && Array.isArray(row.files) ? row.files.find((x) => x.name === 'notes.md') : null
      return rec ? rec.sha256 : null
    }
    const shaV1 = dz.sha256Hex(V1['notes.md'])
    const shaV3 = dz.sha256Hex(V3['notes.md'])
    const idxBefore = indexOf()
    const dis = await call('POST', '/playthrough/rp-memory/floors/pending/settle', { targetKey: v1.pending.targetKey })
    const idxAfter = indexOf()
    check('D10f ★「保持现状」＝就地登记：`last` 锚到当前这一楼 ＋ 把**盘上现文**记成它的那一份（⛔ 那 5 份正文一个字节都不写）',
      dis.status === 200 && dis.data.ok === true && dis.data.changed === true
      && dis.data.pending === null
      && dis.data.settled !== null && dis.data.settled.nodeId === NODES[0] && dis.data.settled.seq === 1
      && idxAfter.pending === null
      && idxAfter.last?.nodeId === NODES[0] && idxAfter.last?.variantId === VAR(NODES[0]) && idxAfter.last?.seq === 1
      // ★ 核心：这一楼那一行现在记的是**盘上这份**（V3），不是第一遍玩时那份（V1）
      && shaNotesOf(idxBefore, NODES[0]) === shaV1 && shaNotesOf(idxAfter, NODES[0]) === shaV3 && shaV3 !== shaV1
      && JSON.stringify(fiveNow()) === JSON.stringify(fiveBefore)
      && readFileSync(join(PT, 'timeline.json'), 'utf8') === tlBefore, '')
    const v2 = await floorsView()
    check('D10g ★ 就地登记之后：清单里那条没了、当前那一楼如实指到第 1 楼（面板据此不再弹）',
      v2.pending === null && v2.head.seq === 1
      && v2.floors.some((f) => f.nodeId === NODES[0] && f.current === true))
    const raw2 = indexRaw()
    const r3 = sync('turn')            // 就地登记之后：判据不再认成回档
    const r4 = sync('watch')
    check('D10h ★ 就地登记之后判据**不再认成回档**（turn 那一脚 kind=same）、一个字节都不写、也不弹',
      r3.kind === 'same' && r3.pending === null && r3.wrote === false
      && r4.wrote === false && indexOf().pending === null && indexRaw() === raw2,
      JSON.stringify([r3.kind, r3.wrote, r4.wrote]))
    // ★★★ 这一条是**这次改口径的全部理由**：就地登记之后记录侧必须**够得到**。
    //   （只清 pending、不锚 `last` 的那一版会让记录侧停摆 —— 见 §3-4 的反证。）
    putFiles(V2)
    const r5 = sync('turn')
    check('D10i ★★ 就地登记之后**记录无缝续上**：同一楼又改了笔记 ⇒ 真的记了一份（⛔ 不是"只清 pending"那种停摆）',
      r5.kind === 'same' && r5.wrote === true && r5.record !== null
      && Array.isArray(r5.record.changed) && r5.record.changed.includes('notes.md')
      && shaNotesOf(indexOf(), NODES[0]) === dz.sha256Hex(V2['notes.md']),
      JSON.stringify([r5.kind, r5.wrote, r5.record && r5.record.changed]))
    check('D10j ★ 如实播报（「档案对齐到第 N 楼」点下去那一刻记了一条：就地登记 + 锚到哪一楼；⛔ 不静默）',
      logs.info.concat(logs.warn).some((m) => m.includes('档案对齐') && m.includes('就地登记')),
      JSON.stringify(logs.info.concat(logs.warn).slice(-12)))
  }

  {
    // ★ 死区（真文档）在接线那一层的三条：判到回档零写入 / 手动那一脚按块合并 / 数据坏掉 ⇒ 整次不做
    //   ★ 20260924 改口径（手动挡）：写盘那一脚现在只在**人点了**之后发生 ⇒ 走 **真端点** 那一脚。
    const CORE2 = '## 【核心规则】\n- 不许改这段'
    reset({ 'notes.md': V1['notes.md'], 'index.md': `${CORE2}\n\n# 索引\nv1\n` })
    writeDeadzones([['index.md', CORE2]])
    await fireEvent('turn/end')        // 第 1 楼（接线那一层自己读死区文档）
    writeTimeline(NODES[2])
    writeMem('index.md', `${CORE2}\n\n# 索引\n模型改的\n`)
    writeMem('notes.md', '# 笔记\n模型改的\n')
    await fireEvent('turn/end')        // 第 3 楼
    writeTimeline(NODES[0])            // 回档
    const diskBefore = readMem('index.md')
    await fireEvent('turn/end')
    check('D8 ★ 接线那一层（真钩子）：判到回档**一个字节都没写**（死区那份照旧停在盘上现况），只留一条待处理',
      readMem('index.md') === diskBefore && readMem('notes.md') === '# 笔记\n模型改的\n'
      && indexOf().pending !== null && indexOf().pending.targetSeq === 1
      && backups().length === 0, JSON.stringify(indexOf().pending))
    const mOk = await call('POST', '/playthrough/rp-memory/floors/restore', { nodeId: NODES[0], variantId: VAR(NODES[0]) })
    check('D8b ★ 真端点（手动那一脚）：死区那一份按块合并 —— index.md 的非死区块回到第 1 楼 + 待处理清掉',
      mOk.status === 200 && mOk.data.ok === true
      && readMem('index.md') === `${CORE2}\n\n# 索引\nv1\n` && readMem('notes.md') === V1['notes.md']
      && mOk.data.pendingCleared === true && indexOf().pending === null,
      JSON.stringify(mOk.data && mOk.data.pendingCleared))
    check('D8b2 ★ 手动那一脚的回执把"按块合并"如实带上（⛔ 不再是"整份跳过"那种会误导的话）',
      mOk.data.skipped.some((s) => s.name === 'index.md' && s.reason === 'deadzone' && s.merged === true)
      && String(mOk.data.message).includes('死区')
      && String(mOk.data.message).includes('按块合并')
      && String(mOk.data.message).includes('保留盘上现况'), JSON.stringify(mOk.data.skipped))
    // ★ 死区数据坏掉 ⇒ 判据未知 ⇒ **手动那一脚整次不做**（⛔ 宁可不动）；判回档照旧只提示
    writeFileSync(join(PT_MEM, dz.DEADZONE_FILE_NAME), '{ 这不是 JSON')
    writeTimeline(NODES[2])
    writeMem('notes.md', '# 笔记\n第 3 楼又改了\n')
    await fireEvent('turn/end')        // 记第 3 楼（记录侧不看死区数据）
    writeTimeline(NODES[0])            // 回档到第 1 楼
    writeMem('notes.md', '# 笔记\n回档前那一刻\n')
    const lastBefore = indexOnDisk().last
    await fireEvent('turn/end')
    check('D8c ★ 死区数据坏掉（判据未知）⇒ 判到回档照旧只提示、笔记保持原样（⛔ 不静默，⛔ 也不动）',
      readMem('notes.md') === '# 笔记\n回档前那一刻\n'
      && indexOf().pending !== null && indexOf().pending.targetSeq === 1
      && floorLogs().some((m) => m.includes('检测到回档')),
      JSON.stringify(indexOf().pending))
    check('D8d ★ 被挡住时 `last` **不前进**（下一轮还判回档、还试一次；⛔ 不拿"什么都没做"当"已经跟上"）',
      indexOnDisk().last.nodeId === lastBefore.nodeId
      && indexOnDisk().last.variantId === lastBefore.variantId
      && readMem('notes.md') === '# 笔记\n回档前那一刻\n',
      JSON.stringify(lastBefore))
    const mBad = await call('POST', '/playthrough/rp-memory/floors/restore', { nodeId: NODES[0], variantId: VAR(NODES[0]) })
    check('D8e ★ 真端点｜死区数据坏掉 ⇒ 手动那一脚**整次不做** + 如实说"笔记保持原样"（⛔ 一个字节都不写）',
      mBad.status === 200 && mBad.data.ok === true && mBad.data.blocked === 'deadzones-unreadable'
      && mBad.data.unchanged === true
      && String(mBad.data.message).includes('死区数据读不出来')
      && readMem('notes.md') === '# 笔记\n回档前那一刻\n'
      && indexOf().pending !== null, JSON.stringify(mBad.data && mBad.data.blocked))
  }

  {
    // 首轮还没楼层（head 为空）⇒ 安静跳过（⛔ 不写、⛔ 不报错刷屏），但如实记一条日志
    reset(V1)
    rmSync(snapDir(), { recursive: true, force: true })
    writeTimeline(null)
    await fireEvent('turn/end')
    await fireEvent('turn/end')
    const said = floorLogs().filter((m) => m.includes('还没有楼层'))
    check('D9 ★ head 为空 ⇒ 一个字节都不写（连我们的快照目录都不建）',
      existsSync(snapDir()) === false)
    check('D9b ★ 但如实记日志，且**一次就够**（两轮下来只有一条，别每个 step 都记）',
      said.length === 1, JSON.stringify([said.length, floorLogs().slice(-2)]))
  }

  // ═════════════════════════════════════════════════════════════════════════
  sect('F 本单 §3 六对（★ 20260924 改口径：回档改**手动挡** —— 判到只提示、写盘要人点）')

  // ── 对 1：相｜判到回档 ⇒ 盘上零写入；反证｜把那一脚换回 `restoreFloor` ⇒ 同一夹具下必红 ──
  {
    reset(V1)
    sync('turn')                       // 第 1 楼（记一份）
    writeTimeline(NODES[2])
    putFiles(V3)
    sync('turn')                       // 第 3 楼（记一份）
    writeTimeline(NODES[0])            // ★ head 往回走到第 1 楼
    const filesBefore = fiveNow()
    const rawBefore = indexRaw()
    const r = sync('turn')
    check('§3-1相 ★ 判到回档 ⇒ 那 5 份**逐字节不变**（连 .bak 都没有）、且 `pending` 记下了 from/to/target/why/source/targetKey/at',
      r.kind === 'rollback' && r.restore === null
      && JSON.stringify(fiveNow()) === JSON.stringify(filesBefore)
      && backups().length === 0
      && r.pending !== null
      && r.pending.fromNodeId === NODES[2] && r.pending.fromVariantId === VAR(NODES[2]) && r.pending.fromSeq === 3
      && r.pending.toNodeId === NODES[0] && r.pending.toVariantId === VAR(NODES[0]) && r.pending.toSeq === 1
      && r.pending.targetNodeId === NODES[0] && r.pending.targetSeq === 1
      && r.pending.why === 'back' && r.pending.source === 'self'
      && r.pending.targetKey === fl.floorKeyOf(NODES[0], VAR(NODES[0]))
      && typeof r.pending.at === 'string' && r.pending.at !== ''
      && indexOf().pending !== null && indexRaw() !== rawBefore,
      JSON.stringify(r.pending))
    // ★ 反证（**同一夹具**）：把"不写盘"那一行换回**老的自动跟随那一脚**（`restoreFloor` ——
    //   它就是改口径前 `syncFloor` 判到 rollback 时调的那个）⇒ 那 5 份**立刻被改写**、
    //   "逐字节不变"那条断言必红。
    const dug = restoreViaPanel({
      memoryDir: PT_MEM, nodeId: NODES[0], variantId: VAR(NODES[0]),
      zones: [], at: 'T2', stamp: 's2',
    })
    check('§3-1反证 ★ 把那一脚换回 `restoreFloor`（老的"自动跟随"）⇒ 同一夹具下那 5 份**被改写** ⇒ 上面那条"逐字节不变"必红',
      dug.kind === 'manual' && JSON.stringify(fiveNow()) !== JSON.stringify(filesBefore)
      && readMem('notes.md') === V1['notes.md'] && readMem('notes.md') !== V3['notes.md']
      && dug.restore.moved.map((x) => x.name).sort().join(',') === 'index.md,notes.md,state.md',
      JSON.stringify([dug.kind, dug.restore && dug.restore.moved.map((x) => x.name)]))
  }

  // ── 对 2：相｜pending 幂等（同一回档连判 ⇒ at 不变、只有一条；目标换了 ⇒ 更新）────────────
  {
    reset(V1)
    sync('turn')                       // 第 1 楼
    writeTimeline(NODES[1]); putFiles(V2); sync('turn')   // 第 2 楼
    writeTimeline(NODES[2]); putFiles(V3); sync('turn')   // 第 3 楼
    writeTimeline(NODES[0])            // ★ 回档到第 1 楼
    const r1 = sync('turn')
    const raw1 = indexRaw()
    const r2 = sync('turn')            // 同一次回档再判（头还在第 1 楼）
    const r3 = sync('watch')           // 组装那一脚也判到同一次
    check('§3-2相 ★ 同一次回档连判三次（turn + turn + watch）⇒ `at` 不变、只有一条、**一个字节都不写**',
      r1.pending !== null && r2.pending !== null && r3.pending !== null
      && r1.pending.at === r2.pending.at && r2.pending.at === r3.pending.at
      && r1.wrote === true && r2.wrote === false && r3.wrote === false
      && indexRaw() === raw1 && indexOf().floors.length === 3
      && indexOf().pending.targetKey === r1.pending.targetKey,
      JSON.stringify([r1.wrote, r2.wrote, r3.wrote]))
    // 目标变了 ⇒ 更新那一条（回到另一楼 ⇒ 指向**另一份**快照）
    writeTimeline(NODES[1])            // ★ 回到第 2 楼（它有快照 ⇒ 目标 = 第 2 楼那一份）
    const p1 = sync('turn').pending
    writeTimeline(NODES[0])            // ★ 目标变了：回到第 1 楼（目标 = 第 1 楼那一份）
    const r4 = sync('turn', { at: 'T9' })
    const p2 = indexOf().pending
    check('§3-2相b ★ 目标变了 ⇒ 那一条被**更新**（targetKey / to / at 都跟上，还是只有一条）',
      p1 !== null && p2 !== null && p1.targetKey !== p2.targetKey
      && p1.targetSeq === 2 && p2.targetSeq === 1
      && p2.toSeq === 1 && p2.toNodeId === NODES[0]
      && p2.at === 'T9' && r4.pendingChanged === true
      && indexOf().floors.length === 3,
      JSON.stringify([p1.targetKey, p2.targetKey]))
  }

  // ── 对 3：相｜手动那一脚照旧真写 + 清 pending；反证｜把"清 pending"那一步挖掉 ⇒ 必红 ──────
  {
    reset(V1)
    sync('turn')
    writeTimeline(NODES[2]); putFiles(V3); sync('turn')
    writeTimeline(NODES[0])
    const rAuto = sync('turn')
    const rawBefore = indexRaw()
    const m = restoreViaPanel({ memoryDir: PT_MEM, nodeId: NODES[0], variantId: VAR(NODES[0]), zones: [], at: 'T2', stamp: 's2' })
    check('§3-3相 ★ 显式调 `restoreFloor` ⇒ 那 5 份确实被写回 + `pending` 被清',
      rAuto.pending !== null && m.kind === 'manual' && m.pendingChanged === true && m.pending === null
      && readMem('notes.md') === V1['notes.md'] && readMem('index.md') === V1['index.md'] && readMem('state.md') === V1['state.md']
      && indexOf().pending === null
      && backups().length >= 3 && indexRaw() !== rawBefore,
      JSON.stringify([m.kind, m.pending, indexOf().pending]))
    check('§3-3反证 ★ 把"清 pending"那一步挖掉 ⇒ 同一夹具下"pending 被清"必红（横幅会一直挂着）',
      (() => {
        // 挖法：照原样再走一遍同一夹具，但收尾**只把 `last` 跟过去、不清 pending**
        reset(V1)
        sync('turn')
        writeTimeline(NODES[2]); putFiles(V3); sync('turn')
        writeTimeline(NODES[0])
        const keep = sync('turn').pending
        const idx = indexOf()
        fl.writeIndex(PT_MEM, {
          schemaVersion: fl.FLOOR_SCHEMA_VERSION, updatedAt: 'T2',
          last: { nodeId: NODES[0], variantId: VAR(NODES[0]), seq: 1, at: 'T2' },
          floors: idx.floors, pending: keep,
        })
        // 挖掉之后：`last` 照样指着第 1 楼，但那条待处理还在 ⇒ 上面那条必红
        return keep !== null && indexOf().pending !== null && indexOf().last.nodeId === NODES[0]
      })())
  }

  // ── 对 4：相｜「保持现状」＝就地登记（last 锚到当前这一楼 ⇒ 记录侧**够得到**）；反证｜挖掉"锚 last"⇒ 必红 ──
  {
    reset(V1)
    sync('turn')
    writeTimeline(NODES[2]); putFiles(V3); sync('turn')
    writeTimeline(NODES[0])
    const p = sync('turn').pending
    const fiveBefore = fiveNow()
    const d = settleViaPanel({ at: 'T4' })
    const settled = indexOf()
    check('§3-4相 ★「保持现状」＝就地登记：`last` 锚到当前这一楼 ＋ 记成**盘上现文**（⛔ 那 5 份正文逐字节不变）',
      p !== null && d.ok === true && d.changed === true && d.settled !== null
      && d.settled.nodeId === NODES[0] && d.settled.seq === 1
      && settled.pending === null && settled.last.nodeId === NODES[0] && settled.last.seq === 1
      && JSON.stringify(fiveNow()) === JSON.stringify(fiveBefore)
      && readMem('notes.md') === V3['notes.md'],
      JSON.stringify([d.settled, settled.last, settled.pending]))
    // ★★ 记录侧必须**够得到** —— 这才是"就地登记"存在的理由（只清 pending 的那一版会停摆）
    putFiles(V2)
    const r2 = sync('turn')
    const r3 = sync('watch')
    check('§3-4相b ★★ 就地登记之后记录**无缝续上**（同一楼又改了笔记 ⇒ 真记一份），且不再弹',
      r2.kind === 'same' && r2.wrote === true && r2.record !== null
      && Array.isArray(r2.record.changed) && r2.record.changed.includes('notes.md')
      && r3.wrote === false && indexOf().pending === null,
      JSON.stringify([r2.kind, r2.wrote, r2.record && r2.record.changed, r3.wrote]))
    check('§3-4反证 ★ 挖掉"把 last 锚到当前这一楼"那一步（＝只清 pending 的那一版）⇒ **档案那一侧**仍认回档（记录侧够不到）⇒ 相b 必红',
      (() => {
        // 挖法：同一夹具走到同一步，settle 之后**把 `last` 挪回原来那一楼**（模拟"只清 pending"），再走同一脚
        reset(V1)
        sync('turn')
        writeTimeline(NODES[2]); putFiles(V3); sync('turn')
        writeTimeline(NODES[0])
        const dugPending = sync('turn').pending
        settleViaPanel({ at: 'T4' })
        const idx = indexOf()
        fl.writeIndex(PT_MEM, {
          schemaVersion: fl.FLOOR_SCHEMA_VERSION, updatedAt: 'T4',
          last: { nodeId: NODES[2], variantId: VAR(NODES[2]), seq: 3, at: 'T4' },   // ★ 挪回去（= 老写法的行为）
          floors: idx.floors, pending: null,
        })
        putFiles(V2)
        const dug = sync('turn')
        // ★ 2026-09-24 收尾改口径：决定"弹不弹横幅"的现在是 `fork`（这一份夹具里剧情没动 ⇒ `same`）；
        //   这一眼要看的是**档案那一侧**（`decision`）仍然认回档 ⇒ 记录侧够不到 ⇒ `record === null`。
        const tl = JSON.parse(readFileSync(join(PT, 'timeline.json'), 'utf8'))
        const dugIdx = indexOf()
        const dugDecision = fl.decideRollback({
          head: fl.headOf(tl), last: dugIdx.last, floors: dugIdx.floors,
          seqOf: (id) => fl.seqOfNode(fl.seqMapOf(tl), id),
        })
        return dugPending !== null && dug.kind === 'same' && dugDecision.kind === 'rollback' && dug.record === null
      })())
  }

  // ── 对 5：相｜预置/死区一律不碰；反证｜把"只写那 5 份"的判据挖掉 ⇒ 必红 ────────────────
  {
    const PRESET5 = {
      'rulebook.md': '# 作者预置 · 规则书\n原样\n',
      '大纲-乙.md': '# 作者预置 · 大纲\n原样\n',
      '雨示例.txt': '示例文本\n原样\n',
    }
    const CORE = '## 【核心规则】\n- 作者写的'
    reset(Object.assign({ 'notes.md': V1['notes.md'], 'index.md': CORE + '\n\n# 索引\nv1\n' }, PRESET5))
    writeDeadzones([['index.md', CORE]])
    sync('turn')                       // 第 1 楼
    writeTimeline(NODES[2])
    putFiles(Object.assign({}, V3, { 'index.md': CORE + '\n\n# 索引\n模型改的\n', 'rulebook.md': '# 作者预置 · 规则书\n模型改的\n' }))
    sync('turn')                       // 第 3 楼（模型把两份都改了）
    writeTimeline(NODES[0])            // ★ 回档
    const rAuto = sync('turn')
    const m = restoreViaPanel({ memoryDir: PT_MEM, nodeId: NODES[0], variantId: VAR(NODES[0]), zones: zonesNow(), at: 'T2', stamp: 's2' })
    const after5 = Object.fromEntries(Object.keys(PRESET5).map((n) => [n, readMem(n)]))
    check('§3-5相 ★ 判到回档那一脚 + 手动恢复那一脚之后：预置那几份与死区块**逐字节不变**',
      after5['rulebook.md'] === '# 作者预置 · 规则书\n模型改的\n'
      && after5['大纲-乙.md'] === PRESET5['大纲-乙.md'] && after5['雨示例.txt'] === PRESET5['雨示例.txt']
      && readMem('index.md') === CORE + '\n\n# 索引\nv1\n'
      && rAuto.pending !== null && rAuto.restore === null
      && m.restore.moved.every((x) => fl.isFloorFile(x.name))
      && m.restore.skipped.some((s) => s.name === 'index.md' && s.reason === 'deadzone'),
      JSON.stringify(Object.keys(after5).map((n) => n + '=' + JSON.stringify(after5[n]))))
    check('§3-5反证 ★ 把"只写那 5 份"的判据挖掉 ⇒ 无白名单的同款逻辑会把 rulebook.md 也写回去 ⇒ 上面那条必红',
      (() => {
        // 灵敏度自证：手写一份**没有白名单**的恢复裁决（"挖掉那一步"），对比真 `planRestore`
        const noGuard = (rawFloor, fileTexts, blobTexts) => {
          const out = []
          for (const f of rawFloor.files) {
            const text = blobTexts[f.sha256]
            if (typeof text !== 'string') continue
            if (typeof fileTexts[f.name] === 'string' && dz.sha256Hex(fileTexts[f.name]) === f.sha256) continue
            out.push({ name: f.name, text })
          }
          return out
        }
        const rawFloor = {
          nodeId: NODES[0], variantId: VAR(NODES[0]),
          files: [
            { name: 'rulebook.md', sha256: dz.sha256Hex('# 作者预置 · 规则书\n原样\n'), bytes: 1, changed: true },
            { name: 'notes.md', sha256: dz.sha256Hex(V1['notes.md']), bytes: 1, changed: true },
          ],
        }
        const blobTexts = {
          [dz.sha256Hex('# 作者预置 · 规则书\n原样\n')]: '# 作者预置 · 规则书\n原样\n',
          [dz.sha256Hex(V1['notes.md'])]: V1['notes.md'],
        }
        const wall = noGuard(rawFloor, { 'rulebook.md': '# 作者预置 · 规则书\n模型改的\n', 'notes.md': '# 笔记\n模型又写了\n' }, blobTexts)
        const real = fl.planRestore({ floor: rawFloor, fileTexts: {}, blobTexts, zones: [] })
        return wall.some((w) => w.name === 'rulebook.md') === true && real.writes.every((w) => w.name !== 'rulebook.md')
      })())
  }

  // ── 对 6：相｜没有快照的楼层 ⇒ 不写任何文件、只播报（照旧）────────────────────────────
  {
    reset(V1)
    sync('turn')                       // 第 1 楼（有快照）
    writeTimeline(NODES[3]); putFiles(V3); sync('turn')   // 第 4 楼（有快照）
    writeTimeline(NODES[1])            // ★ 回到第 2 楼（**没有快照**；前一楼第 1 楼有）
    const fiveBefore = fiveNow()
    const r = sync('turn')
    check('§3-6相 ★ head 到一个没有快照的楼层 ⇒ 那 5 份**一个字节都不写**（也没有 .bak），只留一条提示',
      r.kind === 'rollback' && r.pending !== null && r.pending.source === 'prev'
      && JSON.stringify(fiveNow()) === JSON.stringify(fiveBefore) && backups().length === 0,
      JSON.stringify([r.kind, r.pending && r.pending.source]))
    const rawBefore = indexRaw()
    const r2 = sync('turn', { prevOf: () => null })
    check('§3-6相b ★ 连前一楼也没有 ⇒ **没有**可退回的那一份：那条提示**照样记着**（面板照弹、只是不给「退回」那颗按钮），那 5 份一个字节都没动',
      r2.kind === 'rollback' && r2.fork.kind === 'fork'
      && r2.pending !== null && r2.pending.targetNodeId === '' && r2.pending.targetSeq === null
      && r2.restore === null && r2.pendingChanged === true
      && JSON.stringify(fiveNow()) === JSON.stringify(fiveBefore),
      JSON.stringify([r2.kind, r2.pending && r2.pending.targetSeq]))
  }

  // ═════════════════════════════════════════════════════════════════════════
  sect('G 本单收尾（★ 开 fork 提示 + 常驻状态行）：真 HTTP + 真钩子的端到端')
  //   用户口径：「回档我没看到有横幅。」「**开 fork 时（回档）前台弹提示**」——这一族钉的就是
  //   ① 面板**开档那一脚**（`POST …/floors/scan`）就能把那条提示带出来（⛔ 不用发消息）；
  //   ② 同一个位置再 scan ⇒ 清单逐字节不变（幂等）；
  //   ③「不处理」（`…/pending/ack` —— ★ 2026-09-25 改的名，语义一个字没动）之后 pending 空、且**我们那份 `floor-head.json` 的 `seen` 跟到了当前 head**；
  //   ④ 真机那个 bug 的现场（档案在剧情**后面**）也照弹 —— 且**没有**可退回的那一份（target 如实为 null）。

  {
    // ① + ② + ③：开面板补检测 / 幂等 / 不处理
    reset(V1)
    await fireEvent('turn/end')        // 第 1 楼（真钩子：记一份 + `seen ← 第 1 楼`）
    writeTimeline(NODES[2]); putFiles(V3)
    await fireEvent('turn/end')        // 第 3 楼（`seen ← 第 3 楼`）
    writeTimeline(NODES[0])            // ★ 回档到第 1 楼 —— **一条消息都不发**
    const fiveBefore = fiveNow()
    const s1 = await call('POST', '/playthrough/rp-memory/floors/scan', {})
    check('G1 ★ 面板开档那一脚（POST /floors/scan）：**不用发消息**就把那条待处理带出来了（横幅有料可画）',
      s1.status === 200 && s1.data.ok === true && s1.data.pending !== null
      && s1.data.pending.fromSeq === 3 && s1.data.pending.toSeq === 1
      && s1.data.pending.archiveSeq === 3 && s1.data.pending.targetSeq === 1
      && s1.data.head !== null && s1.data.head.seq === 1
      && s1.data.last !== null && s1.data.last.seq === 3
      // ⛔ 那一脚**碰都不碰**那 5 份正文（写盘仍只在 …/floors/restore 那一脚）
      && JSON.stringify(fiveNow()) === JSON.stringify(fiveBefore), JSON.stringify(s1.data.pending))
    // ★★ 2026-09-25（用户口径「**不要楼号了……只标序号**」）：面板横幅/浮层标题显示的那三个**序号**
    //   走**旁边**那个新字段 `pendingOrdinals`（`{from,to,archive}`）—— ⚠️ 那三个键**不在** `pending` 里：
    //   那条账要**逐字**照投影（SSE 那一帧与盘上那条逐字一致是硬判据，见 `_selftest-floor-watch` 的 C7c）。
    //   此刻清单里两条（序号 1 = 第 1 楼、序号 2 = 第 3 楼）⇒ from/to/archive 分别是 2 / 1 / 2。
    check('G1a ★★ `pendingOrdinals`：横幅那三个位置是**序号**（`{from,to,archive}`），且**不混进** `pending` 那条账里',
      s1.data.pendingOrdinals !== null && typeof s1.data.pendingOrdinals === 'object'
      && s1.data.pendingOrdinals.from === 2 && s1.data.pendingOrdinals.to === 1 && s1.data.pendingOrdinals.archive === 2
      && s1.data.pending.fromOrdinal === undefined && s1.data.pending.toOrdinal === undefined
      && s1.data.pending.archiveOrdinal === undefined
      && s1.data.floors.find((f) => f.pointer === true).ordinal === 2
      && (() => {
        // ★ 反证：把"序号"折成"楼号"（拿 `*Seq` 当序号给面板）⇒ 上面那条必红（此刻 seq 是 3/1/3，序号是 2/1/2）
        const dug = JSON.parse(JSON.stringify(s1.data.pendingOrdinals))
        dug.from = s1.data.pending.fromSeq
        dug.archive = s1.data.pending.archiveSeq
        return !(dug.from === 2 && dug.archive === 2)
      })(), JSON.stringify([s1.data.pendingOrdinals, s1.data.pending && s1.data.pending.fromSeq]))
    const raw1 = indexRaw()
    const seen1 = seenRaw()
    const s2 = await call('POST', '/playthrough/rp-memory/floors/scan', {})
    check('G1b ★ 同一个位置再 scan 一次 ⇒ 清单**逐字节不变**（幂等，⛔ 不刷时间戳）+ 那份簿记也没动',
      s2.status === 200 && s2.data.pending !== null
      && s2.data.pending.at === s1.data.pending.at
      && indexRaw() === raw1 && seenRaw() === seen1,
      JSON.stringify([indexRaw() === raw1, seenRaw() === seen1]))
    const ack = await call('POST', '/playthrough/rp-memory/floors/pending/ack', {})
    check('G1c ★ 「不处理」（POST …/pending/ack）：那条 pending 空了 ＋ 我们那份 `floor-head.json` 的 `seen` 跟到了当前 head（第 1 楼）＋ ⛔ 不登记（`last` 一动不动）',
      ack.status === 200 && ack.data.ok === true && ack.data.changed === true
      && ack.data.seen !== null && ack.data.seen.nodeId === NODES[0] && ack.data.seen.seq === 1
      && indexOf().pending === null
      && seenNow() !== null && seenNow().nodeId === NODES[0] && seenNow().variantId === VAR(NODES[0]) && seenNow().seq === 1
      && indexOf().last !== null && indexOf().last.nodeId === NODES[2]
      && JSON.stringify(fiveNow()) === JSON.stringify(fiveBefore), JSON.stringify([ack.data.seen, seenNow()]))
    const raw2 = indexRaw()
    const s3 = await call('POST', '/playthrough/rp-memory/floors/scan', {})
    check('G1d ★「不处理」之后再 scan ⇒ **不再弹**（`seen` 已经跟到这一楼了）+ 清单一个字节都没写',
      s3.data.pending === null && indexRaw() === raw2, JSON.stringify(s3.data.pending))
    // ★「档案对齐到第 N 楼」——**面板档顶那条常驻状态行**上那颗按钮走的就是这里（此时**没有**待处理那条）。
    const alignBefore = indexOf()
    const shaNotes = (idx, nodeId) => {
      const row = (idx.floors ?? []).find((f) => f.nodeId === nodeId)
      const rec = row && Array.isArray(row.files) ? row.files.find((x) => x.name === 'notes.md') : null
      return rec ? rec.sha256 : null
    }
    const align = await call('POST', '/playthrough/rp-memory/floors/pending/settle', {})
    check('G1e ★ 常驻状态行那颗「档案对齐到第 N 楼」（**没有**待处理那条时）：就地对齐到当前这一楼 —— `last` 锚到第 1 楼 ＋ 盘上现文记成那一份（⛔ 正文一个字节不写）',
      align.status === 200 && align.data.ok === true && align.data.changed === true
      && align.data.settled !== null && align.data.settled.nodeId === NODES[0] && align.data.settled.seq === 1
      && indexOf().last !== null && indexOf().last.nodeId === NODES[0] && indexOf().last.variantId === VAR(NODES[0])
      && shaNotes(alignBefore, NODES[0]) === dz.sha256Hex(V1['notes.md'])
      && shaNotes(indexOf(), NODES[0]) === dz.sha256Hex(V3['notes.md'])
      && JSON.stringify(fiveNow()) === JSON.stringify(fiveBefore), JSON.stringify(align.data.settled))
    const raw3 = indexRaw()
    const again = await call('POST', '/playthrough/rp-memory/floors/pending/settle', {})
    check('G1f ★ 再点一次（已经对齐了）⇒ **一个字节都不写**（⛔ 不空刷清单；连点两下不该写两次）',
      again.status === 200 && again.data.changed === false && indexRaw() === raw3)
  }

  {
    // ④ ★★ 真机那个 bug 的现场：档案（`last`）在剧情**后面** —— 老判据恒为 forward ⇒ 横幅不弹。
    //   新判据判 fork ⇒ **照样弹**；而"可退回的那一份"**没有**（那半边仍然按档案 vs 剧情判）⇒ target 如实为 null。
    reset(V1)
    await fireEvent('turn/end')        // 第 1 楼（`last` = 第 1 楼）
    writeTimeline(NODES[3]); putFiles(V3)
    await fireEvent('turn/end')        // 第 4 楼（`seen ← 第 4 楼`；`last` = 第 4 楼）
    // ★ 复现用户的用法「剧情回档 → 手动把档案也退回去」：档案被**手动退回**第 1 楼（那一脚的结果就是把 `last` 挪回去）
    fl.writeIndex(PT_MEM, {
      schemaVersion: fl.FLOOR_SCHEMA_VERSION, updatedAt: 'T', floors: indexOf().floors,
      last: { nodeId: NODES[0], variantId: VAR(NODES[0]), seq: 1, at: 'T' }, pending: null,
    })
    writeTimeline(NODES[2])            // ★ 剧情退到第 3 楼（比"上次认过的第 4 楼"退了一楼）
    const fiveBefore = fiveNow()
    const s = await call('POST', '/playthrough/rp-memory/floors/scan', {})
    check('★★ G2 真机现场（档案在剧情后面）也**照样弹**：scan 带出 pending，且**没有**可退回的那一份（⛔ 不编一个目标）',
      s.status === 200 && s.data.pending !== null
      && s.data.pending.fromSeq === 4 && s.data.pending.toSeq === 3
      && s.data.pending.archiveSeq === 1
      && s.data.pending.targetNodeId === '' && s.data.pending.targetSeq === null
      && s.data.last !== null && s.data.last.seq === 1
      && s.data.head !== null && s.data.head.seq === 3
      && JSON.stringify(fiveNow()) === JSON.stringify(fiveBefore), JSON.stringify(s.data.pending))
    check('★★ G2b 那一句人话按新口径说清三件事：**剧情刚从第 4 楼退到第 3 楼** ＋ **档案停在第 1 楼** ＋ 没有可退回的那一份',
      statusDoc() !== null && statusDoc().kind === 'rollback'
      && String(statusDoc().message).includes('检测到回档到第 3 楼')
      && String(statusDoc().message).includes('剧情刚从第 4 楼退到第 3 楼')
      && String(statusDoc().message).includes('档案停在第 1 楼')
      && String(statusDoc().message).includes('没有可退回的那一份')
      && !String(statusDoc().message).includes('第 第')
      && !String(statusDoc().message).includes('楼 楼'), JSON.stringify(statusDoc().message))
  }

  // ═════════════════════════════════════════════════════════════════════════
  sect('G3 ★ 2026-09-25（那一排的三颗）：「只对齐楼号」＝`mode:\'number\'` —— 清单只动 last+pending')

  //   用户口径（逐字）：「另外，改一下选项，**1、对齐楼层 2、只对齐楼号 3、不处理**」。
  //   这一节钉的就是那颗**新按钮**在**真 HTTP + 真钩子**下的样子（判据全在宿主）：
  //     ① 相｜`mode:'number'` ⇒ 清单**只动** `last` + `pending`：楼层行数不变、blob 一个不多、那 5 份逐字不变；
  //     ② 相｜那一楼**没有快照**（`baseFloorOf` 为 null）⇒ **下一轮轮末自然把那 5 份记上**（"楼号先对上"）；
  //     ③ 反证｜把那一脚换成 `mode:'full'`（＝「对齐楼层」那颗）⇒ 那一楼**当场长出新行** ⇒ ①必红；
  //     ④ `mode` 认不出 ⇒ **400**（⛔ 不许悄悄按 `'full'` 跑）＋ 一个字节都没写。
  {
    /** 走到"剧情退到**第 2 楼**（那一楼还没有任何行）、清单里记着那条待处理"这一步。 */
    const toForkAtFloor2 = async () => {
      reset(V1)
      await fireEvent('turn/end')                    // 第 1 楼：记一份（`seen ← 第 1 楼`）
      writeTimeline(NODES[2]); putFiles(V3)
      await fireEvent('turn/end')                    // 第 3 楼：记一份（`seen ← 第 3 楼`）
      writeTimeline(NODES[1])                        // ★ 剧情退到**第 2 楼** —— 那一楼清单里一行都没有
      const s = await call('POST', '/playthrough/rp-memory/floors/scan', {})
      return s.data.pending
    }

    // ── ① 相：`mode:'number'` 只动 `last` + `pending` ────────────────────────────────
    const pNum = await toForkAtFloor2()
    // ★ 盘上现文也换成还没被任何楼记过的 V2 —— 这一脚**照样**一个 blob 都不多（它根本不读那 5 份）
    putFiles(V2)
    const beforeNum = indexOf()
    const blobsBefore = blobs()
    const fiveBefore = fiveNow()
    const num = await call('POST', '/playthrough/rp-memory/floors/pending/settle', { targetKey: pNum.targetKey, mode: 'number' })
    const afterNum = indexOf()
    check('G3a ★ 「只对齐楼号」（`mode:\'number\'`）：清单**只动** `last` + `pending` —— 楼层行数不变、blob 目录一个文件都不多、那 5 份逐字不变',
      num.status === 200 && num.data.ok === true && num.data.changed === true && num.data.mode === 'number'
      && num.data.settled !== null && num.data.settled.nodeId === NODES[1] && num.data.settled.variantId === VAR(NODES[1])
      && afterNum.pending === null
      && afterNum.last !== null && afterNum.last.nodeId === NODES[1] && afterNum.last.variantId === VAR(NODES[1]) && afterNum.last.seq === 2
      && afterNum.floors.length === beforeNum.floors.length
      && JSON.stringify(afterNum.floors) === JSON.stringify(beforeNum.floors)
      && JSON.stringify(blobs()) === JSON.stringify(blobsBefore)
      && JSON.stringify(fiveNow()) === JSON.stringify(fiveBefore),
      JSON.stringify({ status: num.status, mode: num.data.mode, rows: [beforeNum.floors.length, afterNum.floors.length], blobs: [blobsBefore.length, blobs().length], last: afterNum.last }))
    check('G3b ★ 只对齐楼号之后：那一楼**没有**快照（`baseFloorOf` 是 null）—— 语义就是"楼号先对上，内容等下一轮自然记上"',
      fl.baseFloorOf(afterNum) === null
      && fl.floorOfVariant(afterNum, NODES[1], VAR(NODES[1])) === null
      && !afterNum.floors.some((f) => f.nodeId === NODES[1]),
      JSON.stringify(afterNum.floors.map((f) => f.nodeId)))
    // ── ② 相：下一轮轮末那一脚**自然把它记上**（那 5 份全量 ⇒ 盘上有的那几份 changed 全 true）────
    await fireEvent('turn/end')                      // 轮末：判据不再认回档（`last` 已经锚到第 2 楼）⇒ 记录（盘上现文 = V2）
    const recRow = fl.floorOfVariant(indexOf(), NODES[1], VAR(NODES[1]))
    check('G3c ★★ 「内容等下一轮自然记上」：下一轮轮末那一脚把这一楼**记成新行**，且盘上有的那几份 `changed` 全 true（base 是 null ⇒ 全量记）',
      recRow !== null && Array.isArray(recRow.files)
      && recRow.files.some((f) => f.name === 'notes.md' && f.sha256 === dz.sha256Hex(V2['notes.md']))
      && recRow.files.filter((f) => f.sha256 !== null).length > 0
      && recRow.files.filter((f) => f.sha256 !== null).every((f) => f.changed === true)
      && indexOf().last !== null && indexOf().last.nodeId === NODES[1],
      JSON.stringify(recRow && recRow.files.map((f) => [f.name, f.changed, f.sha256 !== null])))

    // ── ③ 反证：同一个夹具，把那一脚换成 `mode:'full'` ⇒ 那一楼**当场长出新行**（①那条"零新增行"必红）──
    const pFull = await toForkAtFloor2()
    putFiles(V2)                                     // 同一份"还没记过的现文"
    const beforeFull = indexOf()
    const blobsBeforeFull = blobs()
    const full = await call('POST', '/playthrough/rp-memory/floors/pending/settle', { targetKey: pFull.targetKey, mode: 'full' })
    const afterFull = indexOf()
    check('G3d ★ 反证：「对齐楼层」（`mode:\'full\'`）在**同一个夹具**上 ⇒ 那一楼**当场长出新行**（＋ 新 blob）—— 所以 G3a 那条"行数不变"咬的正是 `mode`（⛔ 不是橡皮章）',
      full.status === 200 && full.data.mode === 'full' && full.data.changed === true
      && afterFull.floors.length === beforeFull.floors.length + 1
      && fl.floorOfVariant(afterFull, NODES[1], VAR(NODES[1])) !== null
      && blobs().length > blobsBeforeFull.length,
      JSON.stringify({ rows: [beforeFull.floors.length, afterFull.floors.length], blobs: [blobsBeforeFull.length, blobs().length] }))

    // ── ④ `mode` 认不出 ⇒ 400（⛔ 不静默按 full 跑）＋ 一个字节都没写 ─────────────────────
    const p400 = await toForkAtFloor2()
    const rawBefore400 = indexRaw()
    const bad = await call('POST', '/playthrough/rp-memory/floors/pending/settle', { targetKey: p400.targetKey, mode: 'half' })
    check('G3e ★ `mode` 传了认不出的值 ⇒ **400**（⛔ 不许悄悄按 `\'full\'` 跑：那会替用户记下一份他没点的快照）＋ 清单一个字节都没写',
      bad.status === 400 && bad.data.ok === false && String(bad.data.error.code).includes('BAD_MODE')
      && indexRaw() === rawBefore400 && indexOf().pending !== null,
      JSON.stringify({ status: bad.status, code: bad.data && bad.data.error && bad.data.error.code }))
    const emptyMode = await call('POST', '/playthrough/rp-memory/floors/pending/settle', { targetKey: p400.targetKey, mode: '' })
    check('G3f ★ `mode` 是空串也**一样 400**（"认不出"就是认不出 —— ⛔ 不留一个"空串＝full"的后门）',
      emptyMode.status === 400 && indexRaw() === rawBefore400, JSON.stringify({ status: emptyMode.status }))
    // ── ⑤ 老那一脚（体里**不带** `mode`）照旧＝`full`：行为与从前逐字一样（老断言在 D10f/D10h/D10i 那边）──
    const im = await call('POST', '/playthrough/rp-memory/floors/pending/settle', { targetKey: p400.targetKey })
    check('G3g ★ 老那一脚照旧：体里**不带** `mode` ⇒ 缺省就是 `\'full\'`（回执里如实回 `mode:\'full\'`；行为与从前一字不差）',
      im.status === 200 && im.data.ok === true && im.data.mode === 'full' && im.data.changed === true
      && fl.floorOfVariant(indexOf(), NODES[1], VAR(NODES[1])) !== null,
      JSON.stringify({ status: im.status, mode: im.data && im.data.mode }))
  }

  // ═════════════════════════════════════════════════════════════════════════
  sect('E 纪律静态核对（只写那 5 份 + 我们自己的目录）')

  check('E1 ★ 白名单只有一处：lib/floor-snapshot.js 里那 5 个名字只在 FLOOR_FILES 出现一次',
    (() => {
      const mod = readFileSync(join(ROOT, 'lib', 'floor-snapshot.js'), 'utf8')
      const code = mod.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      const counts = ['notes.md', 'index.md', 'state.md', 'characters.md', 'world.md']
        .map((n) => (code.match(new RegExp(n.replace('.', '\\.'), 'g')) || []).length)
      return counts.every((c) => c === 1)
    })(), '白名单被抄了第二份（两张表迟早漂开）')

  check('E2 ★ 只写自己家：lib/floor-snapshot.js 里所有写盘都落在"清单 / 内容寻址正文 / 那 5 份"三处',
    (() => {
      const mod = readFileSync(join(ROOT, 'lib', 'floor-snapshot.js'), 'utf8')
      const writes = mod.match(/writeFileSync\([^\n]*/g) || []
      return writes.length === 3
        && writes.every((w) => /FLOOR_INDEX_NAME|tmpPath|abs/.test(w))
        && /!isFloorFile\(name\)\) return \{ ok: false/.test(mod)
        && /for \(const name of FLOOR_FILES\)/.test(mod)
    })())

  check('E3 ★ 时间线/周目目录**只读**：接线那一块里唯一的写盘是我们自己的状态文件（临时文件 + rename）',
    (() => {
      const mod = readFileSync(join(ROOT, 'lib', 'floor-snapshot.js'), 'utf8')
      const modCode = mod.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      const idx = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
      // ★ 20260924：块头那句话改成了"…+ **回档提示（手动挡）**」的接线" ⇒ 锚跟着改（判据一个字没松）
      const start = idx.indexOf('「**按楼层绑定**的笔记快照 + **回档提示（手动挡）**」的接线')
      const end = idx.indexOf('GET /playthrough/for-session', start)
      const floorBlock = idx.slice(start, end)
      const writes = floorBlock.match(/writeFileSync\([^,)]*/g) || []
      return start > 0 && end > start
        && !modCode.includes('timeline.json')                 // 本模块连时间线都不认识（读在接线那一层）
        && writes.length > 0 && writes.every((w) => w.includes('tmpPath'))
        && !/copyFileSync|unlinkSync|rmSync\(/.test(floorBlock)   // ⛔ 不删、不改名任何东西
        && !/writeFileSync\([^\n]*(timeline|catalog|play-workspace)/.test(idx)
    })())

  check('E5 ★ 手动挡的唯一写入口：`syncFloor` 判到**开 fork**那一支**不许**再出现 `restoreFloor`/`runRestore`/`writeRestoredFile`',
    (() => {
      const mod = readFileSync(join(ROOT, 'lib', 'floor-snapshot.js'), 'utf8')
      const code = mod.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      // ★ 2026-09-24 收尾：那一支的判据从 `decision.kind === 'rollback'` 换成 `fork.kind === 'fork'` ⇒ 锚跟着改
      //   （⛔ 判据一个字没松：回档那一支仍然只记一条 `pending`、不碰那 5 份）。
      const at = code.indexOf("if (fork.kind === 'fork') {")
      const end = code.indexOf('let record = null', at)
      const branch = at < 0 || end <= at ? '' : code.slice(at, end)
      const writes = code.match(/writeRestoredFile\(/g) || []
      // `writeRestoredFile` 只在它自己的定义（export function …）与 runRestore 那一处出现 ⇒ 一共 2 次
      return branch !== ''
        && !/restoreFloor|runRestore|writeRestoredFile|planRestore/.test(branch)
        && /restoreFloor, syncFloor, settlePending/.test(mod)
        && writes.length === 2
        && (code.match(/function runRestore\(/g) || []).length === 1
    })(), '回档那一支又去写盘了（或那 5 份出现了第二个写入口）')

  check('E4 ★ 判据只有一处：死区那套只在 `lib/deadzone.js`（floor-snapshot 只调用，⛔ 不另立一份）',
    (() => {
      const mod = readFileSync(join(ROOT, 'lib', 'floor-snapshot.js'), 'utf8')
      // 只 import 它的四个出口（sha256Hex / writeWithBackup / splitBlocks / locateZone）
      return /import \{ locateZone, sha256Hex, splitBlocks, writeWithBackup \} from '\.\/deadzone\.js'/.test(mod)
        && !/DEADZONE_FILE_NAME|readDocFile|decideToggle|normalizeDoc/.test(mod)
        // 死区那几条数据只有接线那一层读（`floorDeadZones`），而且**原样喂**给 planRestore
        && /function floorDeadZones\(dir\)/.test(readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8'))
    })())

  // ═════════════════════════════════════════════════════════════════════════
  sect('H ★ 2026-09-24（顶部弹窗那一单的**回归**）：新那条 SSE 端点不搅乱老那四条 + 真 fs.watch 的"立刻"')

  // 这一节只钉**回归**（老那四条端点行为照旧 + 新端点在同一条路由表里老老实实）；新功能的
  // 逐条判据在 `_selftest-floor-watch.mjs`（那里有假 watcher 台子，能确定性喂事件）。
  {
    // ── H1 老四条端点照旧（与前面 G 那一节的期望值一致）────────────────────────────
    reset(V1, NODES[2])
    const h0 = await call('POST', '/playthrough/rp-memory/floors/scan', {})     // 建立基线（seen ← 第 3 楼）
    const raw0 = indexRaw()
    const s1 = await call('POST', '/playthrough/rp-memory/floors/scan', {})     // 同一个位置再来一次 ⇒ 幂等
    check('H1 老的 `/floors/scan` 照旧：同一个位置连扫两次 ⇒ 清单逐字节不变（幂等，⛔ 不刷时间戳）',
      h0.status === 200 && s1.status === 200 && indexRaw() === raw0, JSON.stringify([h0.status, s1.status]))
    const g = await call('GET', '/playthrough/rp-memory/floors')
    check('H1b 老的 `GET /floors` 照旧：HTTP 200 + 清单形状（`ok` / `floors[]` / `pending` / `head` 都在）',
      g.status === 200 && g.data.ok === true && Array.isArray(g.data.floors)
      && g.data.pending === null && g.data.head !== null && g.data.head.seq === 3,
      JSON.stringify({ status: g.status, pending: g.data && g.data.pending }))
    // ── H2 新那条端点：登记在表里、只认 GET、且**连上/断开不会搅乱老端点** ──────────────
    const postEvents = await call('POST', '/playthrough/rp-memory/floors/events', {})
    check('H2 新的 `GET /floors/events` 在路由表里且**只认 GET**（POST ⇒ 405 + "只接受 GET"）',
      postEvents.status === 405 && String(postEvents.text).includes('只接受 GET'), `status=${postEvents.status}`)
    const rawBefore = indexRaw()
    const sseCtl = new AbortController()
    const sseResp = await fetch(`${base}/playthrough/rp-memory/floors/events`, { signal: sseCtl.signal })
    const ctype = String(sseResp.headers.get('content-type'))
    const sseReader = sseResp.body.getReader()
    const sseDec = new TextDecoder()
    let sseBuf = ''
    let hello = null
    for (;;) {                                     // 读到第一帧（hello）为止
      const { value, done } = await sseReader.read()
      if (done) break
      sseBuf += sseDec.decode(value, { stream: true })
      const i = sseBuf.indexOf('\n\n')
      if (i === -1) continue
      const line = sseBuf.slice(0, i).split('\n').find((l) => l.startsWith('data: '))
      try { hello = line === undefined ? null : JSON.parse(line.slice(6)) } catch { hello = null }
      break
    }
    check('H2b 连上 ⇒ 200 + `text/event-stream` + **第一帧就是 `hello`**（带现状：`pending` / `head` / `last`）',
      sseResp.status === 200 && ctype.includes('text/event-stream')
      && hello !== null && hello.type === 'hello' && 'pending' in hello && 'head' in hello && 'last' in hello,
      JSON.stringify({ status: sseResp.status, ctype, hello }))
    const flux = await call('GET', '/playthrough/rp-memory/floors')
    check('H2c `hello` 里那条 `pending` 与同一刻 `/floors` 里那条**逐字一致**（⛔ 不两处各拼一份）',
      hello !== null && JSON.stringify(hello.pending) === JSON.stringify(flux.data.pending),
      JSON.stringify({ hello: hello && hello.pending, floors: flux.data.pending }))
    // ★ 2026-09-25：浮层标题要显示的那三个**序号**也搭这一帧过来（`pendingOrdinals`，与 `/floors` 同源）。
    check('H2c2 ★ 同一帧里的 `pendingOrdinals` 与 `/floors` 那份**同一份**（浮层标题按它说「序号 N」；⛔ 不编 0）',
      // 此刻还没有待处理（`pending` 为 null）⇒ 两边都如实是 null（⛔ 不是 {}、更不是编出来的 0）
      hello.pendingOrdinals === null && flux.data.pendingOrdinals === null,
      JSON.stringify({ hello: hello.pendingOrdinals, floors: flux.data.pendingOrdinals }))
    // 客户端断开 ⇒ 服务端 `close` ⇒ 摘掉订阅者。
    // ⚠️ 用 `AbortController`（与 `_selftest-floor-watch.mjs` 那套同一份做法）；⛔ **不调** `body.cancel()`
    //    —— 这一版 node + undici 上那一脚会**把进程顶掉**（无栈、无输出、退出码还好看），本仓踩过一次。
    try { sseCtl.abort() } catch { /* 已经断了 */ }
    await new Promise((r) => setTimeout(r, 250))
    const g2 = await call('GET', '/playthrough/rp-memory/floors')
    check('H2d ⛔ 那条端点**一个字节都没写**（清单逐字不变）+ 老那四条端点行为不变（仍 HTTP 200 + 同一份清单）',
      indexRaw() === rawBefore && g2.status === 200 && JSON.stringify(g2.data.floors) === JSON.stringify(flux.data.floors),
      JSON.stringify({ sameIndex: indexRaw() === rawBefore, status: g2.status }))

    // ── H3 ★ 真 `fs.watch`（这一台机器上真跑）：改 timeline.json ⇒ **不发消息、不开面板**，账自己就记上了
    //   用户口径「**不能在回档操作之后立刻弹吗，检测 tarven**」—— 这一条钉的就是那个"立刻"。
    reset(V1, NODES[2])
    await call('POST', '/playthrough/rp-memory/floors/scan', {})   // 建立基线（seen ← 第 3 楼）
    const beforePending = indexOf().pending
    const fiveBefore = JSON.stringify(fiveNow())
    writeTimeline(NODES[0])                                        // 剧情退回第 1 楼（⚠️ 这一脚**不碰**任何端点）
    let appeared = false
    {
      const t0 = Date.now()
      for (;;) {
        const p = indexOf().pending
        if (p !== null && p !== undefined && p.toSeq === 1) { appeared = true; break }
        if (Date.now() - t0 > 8000) break
        await new Promise((r) => setTimeout(r, 50))
      }
    }
    check('H3 ★★ 真 `fs.watch` 那一脚：夹具改 `timeline.json` ⇒ **不用**调 scan、不用发消息，盘上那条待处理自己就出现了（"立刻"这一半）',
      beforePending === null && appeared === true, JSON.stringify({ before: beforePending, after: indexOf().pending }))
    check('H3b 那一脚**只看不改**：那 5 份正文逐字没变（⛔ 回档不写正文那条口径照旧）',
      JSON.stringify(fiveNow()) === fiveBefore, '正文被改过了')
    // 收尾：把这一节造出来的状态清掉（不影响别的判据）
    reset(V1, NODES[0])
  }
} finally {
  // ★★ 2026-09-24：**先切断还挂着的连接**再关服务器 —— 少了这一行，undici 那两条 keep-alive/流式
  //   socket 会把**事件循环吊住**（本台子结尾故意不调 `process.exit`，见下），于是进程永不退出、
  //   全量门（`spawnSync`）**永久卡住**。同款做法见 `_selftest-floor-watch.mjs` 的收尾。
  // ★ 先拆掉生产那条 watcher（台子收尾必须：它会把事件循环吊住，跑完不退 —— 见实现处注释）。
  try { __disposeFloorWatch() } catch { /* 拆不掉也只能算了 */ }
  try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections() } catch { /* 老 node */ }
  await new Promise((r) => server.close(r))
  rmSync(HOME, { recursive: true, force: true })
  rmSync(WS, { recursive: true, force: true })
  if (existsSync(HOME) || existsSync(WS)) console.log('⚠️ 沙箱没清干净：' + HOME + ' / ' + WS)
}

console.log(`\n== 总结：${pass} 通过 / ${failed} 失败 ==`)
// ⛔ 不用 process.exit（undici 句柄在场时会被顶成 0xC0000409）；退出码走 process.exitCode。
process.exitCode = failed === 0 ? 0 : 1
