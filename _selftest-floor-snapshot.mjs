/**
 * _selftest-floor-snapshot.mjs —— 「**按楼层绑定**的笔记快照 + 回档跟随」的宿主半侧自检
 * （20260923 单：用户口径「能不能做按楼层绑定管理的功能，也就是每轮模型修改都记录，能自动跟随回档」；
 *  ★ 20260923 **补单**改了**两处口径**：快照锚 `nodeId` → **`(nodeId, variantId)`**（swipe 也算回档）、
 *  死区从"整份跳过" → **按块合并** —— 本台子按新口径钉，改过口径的那几条在注释里写明为什么改）。
 *
 * 五条主线（都按项目惯例：**相 + 反证成对**，⛔ 不只做源码字符串断言）：
 *   A 纯逻辑层（`lib/floor-snapshot.js` 直测：判该不该记 / 该不该回 / 恢复到哪一份 / 按块合并怎么合）；
 *   B 补单 §2 八对（**本单的新口径**：变体级记录 · 换变体也算回档 · 退回进楼前 · 前进不回档 ·
 *     死区按块合并（两个反证） · 死区读不出来整次不做 · 老条目只读不恢复 · 预置一律不碰）；
 *   C 上一单那八对（回归；改过口径的两条已按新口径改写，注释里写了为什么）；
 *   D 接线纪律 —— 走**真 HTTP** 与**真钩子**（假 ctx 驱动真 `apply()`）：每轮至多一次 / 不占本轮时间 /
 *     轮末才记 / 不刷屏 / 手动恢复与自动跟随**共用同一份** / 有哪一份写不进去就**如实**；
 *   E 纪律静态核对：只写那 5 份 + 我们自己的目录（⛔ 死区被判据约束、⛔ 预置、⛔ 会话/归档/Tavern 一个不碰）。
 *
 * ★ 全部夹具都在**临时目录**里（`_selftest-home-floor` / `_selftest-ws-floor`），测完删掉；
 * ⛔ 全程不碰真机（`C:\Users\w\.dsh`）、⛔ 不碰用户的 RP 工作区（`D:\apps\dsh-tarven`）。
 */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { apply } from './lib/index.js'
import * as fl from './lib/floor-snapshot.js'
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
const backups = () => readdirSync(PT_MEM).filter((n) => n.includes('.bak-')).sort()
/** 清空一个夹具：记忆库整块删掉（含我们的快照目录与 .bak），时间线重写。 */
function reset(files = {}, headId = NODES[0]) {
  rmSync(PT_MEM, { recursive: true, force: true })
  mkdirSync(PT_MEM, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeMem(name, text)
  writeTimeline(headId)
  return { files }
}
/** 死区那几条数据（与接线那一层 `floorDeadZones` **同一口径**：读不出来 ⇒ `null`）。 */
const zonesNow = () => {
  const r = dz.readDocFile(PT_MEM)
  return r.error !== null ? null : r.doc.zones
}
/**
 * 直接跑一次「楼同步」（与生产同一条 `syncFloor`；判据那一层用）。
 * `opts.prevOf` 可覆盖"紧邻前一楼"那一步（反证用：不给它 ⇒ 等于把 (b) 支挖掉）。
 */
function sync(mode = 'turn', opts = {}) {
  const timeline = JSON.parse(readFileSync(join(PT, 'timeline.json'), 'utf8'))
  const head = opts.head === undefined ? fl.headOf(timeline) : opts.head
  const seqMap = fl.seqMapOf(timeline)
  const order = fl.nodeOrderOf(timeline)
  return fl.syncFloor({
    memoryDir: PT_MEM, mode, head,
    seq: fl.seqOfNode(seqMap, head === null ? '' : head.nodeId),
    seqOf: (id) => fl.seqOfNode(seqMap, id),
    prevOf: opts.prevOf === undefined ? (id) => fl.prevNodeOf(order, id) : opts.prevOf,
    at: opts.at === undefined ? '2026-09-23T10:00:00.000Z' : opts.at,
    stamp: '2026-09-23T10-00-00-000Z',
    zones: opts.zones === undefined ? zonesNow() : opts.zones,
  })
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

  // ═════════════════════════════════════════════════════════════════════════
  sect('B 补单 §2 八对（本单新口径：变体级快照 + 死区按块合并）')

  // ── 对 1：相｜变体级记录（同一 nodeId 两支各记一条，互不覆盖）────────────────
  {
    reset(V1)
    sync('turn')                            // 第 1 楼第 1 支
    writeTimeline(NODES[1])
    putFiles(V2)
    sync('turn')                            // 第 2 楼第 1 支
    // ★ swipe：同一楼换到第 2 支（没记过 ⇒ 退回进楼前 = 第 1 楼那一份）
    writeTimeline(NODES[1], NODES, VAR(NODES[1], 2))
    const rSwap = sync('turn')
    const afterRestore = readMem('notes.md')
    putFiles(V2B)                           // 第 2 支里模型重跑出来的样子
    const rRec = sync('turn')               // head=(2,V2) vs last=(1,V1) ⇒ 前进 ⇒ 记 (2,V2)
    const two = fl.floorsOfNode(indexOf(), NODES[1])
    const shaOf = (f) => f.files.find((x) => x.name === 'notes.md').sha256
    check('§2-1相 ★ 同一 nodeId 两支变体各记一条（`(N,V1)` / `(N,V2)`），互不覆盖（各自的 sha 都在）',
      two.length === 2
      && two[0].variantId === VAR(NODES[1]) && two[1].variantId === VAR(NODES[1], 2)
      && shaOf(two[0]) === dz.sha256Hex(V2['notes.md'])
      && shaOf(two[1]) === dz.sha256Hex(V2B['notes.md'])
      && shaOf(two[0]) !== shaOf(two[1])
      && rSwap.kind === 'rollback' && rSwap.restore.source === 'prev' && afterRestore === V1['notes.md']
      && rRec.kind === 'forward' && rRec.record !== null && rRec.record.changed.includes('notes.md'),
      JSON.stringify([two.map((f) => f.variantId), rSwap.kind, rRec.kind]))
  }

  // ── 对 2：相｜换变体也算回档；(N,V) 自己有快照 ⇒ 用它 ────────────────────────
  //   反证：把判据改回上一版的"只看 nodeId" ⇒ 同一夹具下判成 same、不触发恢复 ⇒ 必红
  {
    reset(V1)
    sync('turn')                            // (1,V1)
    writeTimeline(NODES[1]); putFiles(V2); sync('turn')      // (2,V1)
    writeTimeline(NODES[1], NODES, VAR(NODES[1], 2)); sync('turn')   // swipe ⇒ 退回进楼前
    putFiles(V2B); sync('turn')             // 记 (2,V2)
    const lastBefore = indexOf().last
    const notesBefore = readMem('notes.md')
    writeTimeline(NODES[1], NODES, VAR(NODES[1]))   // ★ 再 swipe 回第 1 支（(2,V1) 有快照）
    const r = sync('turn')
    check('§2-2相 ★ 同一楼换变体（swipe）也算回档：`(N,V1)` 自己有快照 ⇒ 恢复到**这一支**那一份',
      r.kind === 'rollback' && r.why === 'variant' && r.restore.source === 'self'
      && r.restore.target.nodeId === NODES[1] && r.restore.target.variantId === VAR(NODES[1])
      && readMem('notes.md') === V2['notes.md'] && notesBefore === V2B['notes.md']
      && r.restore.moved.some((m) => m.name === 'notes.md'),
      JSON.stringify([r.kind, r.why, r.restore && r.restore.source]))
    check('§2-2反证 ★ 把判据改回"只看 nodeId"（上一版）⇒ 同一夹具下判成 same、**不触发恢复** ⇒ 上面那条断言必红',
      (() => {
        // ← 上一版那一条判据（逐字）：`head.nodeId === last.nodeId ⇒ same`
        const oldJudge = (h, l) => (h.nodeId === l.nodeId ? 'same' : '其它')
        const headsNow = { nodeId: NODES[1], variantId: VAR(NODES[1], 2) }
        const withOld = oldJudge(headsNow, lastBefore)
        // 同一夹具下：按老判据＝什么都不做 ⇒ 盘上留着 V2 支那份（≠ V1 支那一份） ⇒ "恢复到 (N,V1)"必红
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
    check('§2-3相 ★ 新变体没记过 ⇒ 退回"进这一楼之前"的样子（用紧邻前一楼**最后一条**快照）',
      r.kind === 'rollback' && r.why === 'variant' && r.restore.source === 'prev'
      && r.restore.target.nodeId === NODES[0] && r.restore.target.variantId === VAR(NODES[0])
      && readMem('notes.md') === V1['notes.md'] && r.restore.headSeq === 2 && r.restore.seq === 1,
      JSON.stringify([r.kind, r.restore && r.restore.source, readMem('notes.md')]))
    // ★ 反证：同一夹具**重放**一遍，但把"紧邻前一楼"那一步挖掉（`prevOf` 不给 ⇒ 上一版
    //   的 `back-no-snapshot` 口径）⇒ 笔记停在模型写的那份，"退回进楼前"必红。
    const dug = runFixture({ prevOf: () => null })
    check('§2-3反证 ★ 把 (b) 支挖掉（不给"紧邻前一楼"）⇒ 同一夹具下"笔记回到进楼前"必红',
      dug.kind === 'back-no-snapshot' && dug.wrote === false
      && readMem('notes.md') === '# 笔记\n第 2 楼第 1 支之后模型又写了\n'
      && readMem('notes.md') !== V1['notes.md'], JSON.stringify([dug.kind, dug.wrote]))
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
    check('§2-4相c ★ 组装那一脚（watch）看到前进 ⇒ 同样一个字节都不写（恢复侧只在"回档"时动）',
      r3.kind === 'forward' && r3.wrote === false && indexRaw() === raw1)
  }

  // ── 对 5：相｜死区按块合并；两个反证（"照快照整份写" / 上一版的"整份跳过"）都咬人 ──
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
    const beforeRestore = readMem('index.md')
    const r = sync('turn')
    const diskAfter = readMem('index.md')
    const sk = r.restore.skipped.find((s) => s.name === 'index.md')
    check('§2-5相 ★ 死区按块合并：死区块 A 逐字节等于**盘上现况**（模型写的），非死区块 B 等于**快照**（第 1 楼的）',
      sk !== undefined && sk.reason === 'deadzone' && sk.merged === true && sk.kept.length === 1
      && diskAfter === A2 + '\n\n' + B1 + '\n'
      && diskAfter.startsWith(A2) && !diskAfter.includes('- 不许替玩家做决定（作者写的）')
      && readMem('notes.md') === V1['notes.md']
      && r.restore.moved.some((m) => m.name === 'index.md' && m.merged === true),
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
    const r = sync('turn')
    check('§2-6反证 ★ 死区数据坏掉（判据未知）⇒ **整次恢复不做**：那 5 份逐字节没变',
      r.restore !== null && r.restore.blocked === 'deadzones-unreadable'
      && r.restore.moved.length === 0 && r.restore.failed.length === 0 && r.wrote === false
      && JSON.stringify(fiveNow()) === JSON.stringify(before) && indexRaw() === beforeIdx,
      JSON.stringify([r.restore && r.restore.blocked, r.wrote]))
    check('§2-6反证b ★ `last` **不前进**（留在原地）⇒ 下一轮还判回档、还试一次（⛔ 不拿"什么都没做"当"已经跟上了"）',
      indexOnDisk().last.nodeId === NODES[2] && indexOnDisk().last.variantId === VAR(NODES[2]))
    check('§2-6反证c ★ 回执如实说（"不敢恢复、笔记保持原样"）—— 接线那一层同样（C7c 走真钩子）',
      r.kind === 'rollback' && r.restore.blocked === 'deadzones-unreadable' && r.notes.length === 0)
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
    const r = sync('turn')
    check('§2-7相b ★ 回档到这一楼 ⇒ **不拿老条目当快照**（那一支没记过、连前一楼也没有 ⇒ 什么都不动，如实说）',
      r.kind === 'back-no-snapshot' && r.wrote === false && r.legacyAtHead === true
      && readMem('notes.md') === before && readMem('notes.md') !== LEGACY_TEXT
      && indexOnDisk().last.variantId === VAR(NODES[2]), JSON.stringify([r.kind, r.legacyAtHead]))
    const m = fl.restoreFloor({ memoryDir: PT_MEM, nodeId: NODES[1], variantId: '', zones: [], at: 'T2', stamp: 'stamp2' })
    check('§2-7相c ★ 面板手动恢复点到老条目 ⇒ 拒（`legacy-no-restore`，一个字节都不写）',
      m.kind === 'legacy-no-restore' && m.wrote === false && readMem('notes.md') === before)
    const m2 = fl.restoreFloor({ memoryDir: PT_MEM, nodeId: NODES[1], variantId: VAR(NODES[1]), zones: [], at: 'T2', stamp: 'stamp2' })
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
    const after = Object.fromEntries(Object.keys(PRESET).map((n) => [n, readMem(n)]))
    check('§2-8相 ★ 任何一次恢复里，预置那几份（rulebook / 大纲 / 示例.txt）逐字节不变',
      after['rulebook.md'] === '# 作者预置 · 规则书\n模型改的\n'   // 模型改的**照旧留着**（我们既没碰、也没"还原"它）
      && after['大纲-甲.md'] === PRESET['大纲-甲.md'] && after['幻蕊示例.txt'] === PRESET['幻蕊示例.txt']
      && r.kind === 'rollback' && r.restore.moved.every((m) => fl.isFloorFile(m.name))
      && indexOf().floors.every((f) => f.files.every((x) => fl.isFloorFile(x.name)))
      && blobs().every((n) => n !== dz.DEADZONE_FILE_NAME))
  }

  // ═════════════════════════════════════════════════════════════════════════
  sect('C 上一单那八对（回归；改过口径的两条已按新口径改写 —— 注释里写了为什么）')

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
    sync('turn')                       // 回档到第 1 楼（last 跟到第 1 楼）
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
    const r = sync('turn')
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

  // ── C-4：相｜回档把 5 份写回那一份；反证｜把恢复那一步挖掉 ⇒ 必红 ────────────
  {
    reset(V1)
    sync('turn')                       // 第 1 楼
    writeTimeline(NODES[2])
    putFiles(V3)
    sync('turn')                       // 第 3 楼（往前走）
    writeTimeline(NODES[0])            // ★ 回档到第 1 楼
    const r = sync('turn')
    check('C-4相 ★ head 回到存过快照的前面某一楼 ⇒ 那 5 份被写回那一份的样子（逐字节）',
      r.kind === 'rollback' && r.wrote === true
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
    const r = sync('turn')
    const n3 = fl.floorOfVariant(indexOf(), NODES[2], VAR(NODES[2]))
    const n3notes = n3.files.find((f) => f.name === 'notes.md')
    check('C-5相 ★ 回档发生时，"当下"那一份快照也在（挂在回档前那一份上，逐字节是刚变过的样子）',
      r.pre !== null && r.pre.nodeId === NODES[2] && r.pre.variantId === VAR(NODES[2])
      && n3notes.sha256 === dz.sha256Hex(LATEST['notes.md'])
      && fl.readBlob(PT_MEM, n3notes.sha256).text === LATEST['notes.md'])
    const back = fl.restoreFloor({ memoryDir: PT_MEM, nodeId: NODES[2], variantId: VAR(NODES[2]), zones: [], at: 'T2', stamp: 'stamp2' })
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
    const r = sync('turn')
    check('C-6反证 ★ 回档恢复后：rulebook / 大纲 逐字节没变（不在那 5 份里 ⇒ 一个都不许被写）',
      readMem('rulebook.md') === CHANGED['rulebook.md'] && readMem('大纲-甲.md') === CHANGED['大纲-甲.md']
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
    check('C-7相 ★ 回到没有快照的楼层 ⇒ 退回"进这一楼之前"（用第 1 楼那一份），如实说用的是哪一份',
      r.kind === 'rollback' && r.restore.source === 'prev' && r.restore.seq === 1 && r.restore.headSeq === 2
      && readMem('notes.md') === V1['notes.md'] && readMem('index.md') === V1['index.md']
      && before2.notes !== V1['notes.md'],
      JSON.stringify([r.kind, r.restore && r.restore.source, r.restore && r.restore.seq]))
    check('C-7反证 ★ 那一楼**也没有被"顺手记一份"**（拿第 4 楼的内容冒充第 2 楼会毒掉以后的回档）',
      fl.floorsOfNode(indexOf(), NODES[1]).length === 0
      && indexOnDisk().last.nodeId === NODES[0] && before2.notes !== V1['notes.md'])
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
    check('C-8相c ★ 后来回档回这一支 ⇒ 恢复的是**用户自己改过**的那份（决定④的落点）',
      back.kind === 'rollback' && readMem('notes.md') === MINE
      && back.restore.moved.some((m) => m.name === 'notes.md'))
  }

  // ═════════════════════════════════════════════════════════════════════════
  sect('D 接线（真 HTTP + 真钩子：轮末才记 / 回档跟随 / 面板走端点 / 不碰别的）')

  check('D1 ★ 两条钩子都在场（组装时那条 + 轮末那条），且注册在同一个插件里',
    assembleFns().length >= 1 && eventFns().length >= 1
    && listeners.some((l) => l.who === 'dsh-memory-archive:floor-snapshot' && l.event === 'session/event')
    && listeners.some((l) => l.who === 'dsh-memory-archive:floor-snapshot' && l.event === 'system-prompt/assemble'))

  {
    // 组装那一脚：回档跟随 —— 既**不占本轮时间**，又能在本轮之内把笔记换回去
    reset(V1)
    sync('turn')                       // 第 1 楼
    writeTimeline(NODES[2])
    putFiles(V3)
    sync('turn')                       // 第 3 楼
    writeTimeline(NODES[0])            // 回档到第 1 楼（还没人处理）
    const atNext = await drive(7, { snap: () => readMem('notes.md') })
    check('D2 ★ 真接线｜这一轮的恢复**不占本轮时间**：调 next() 那一刻笔记还是旧的，让出事件循环之后才换回去',
      atNext === V3['notes.md'] && readMem('notes.md') === V1['notes.md'], JSON.stringify([atNext]))
    check('D2b ★ 回档跟随如实播报（日志一条，含"哪一楼 → 哪一楼 + 恢复了哪几份 + 预置没动"）',
      floorLogs().some((m) => m.includes('检测到回档到第 1 楼') && m.includes('已把笔记恢复到第 1 楼的样子')
        && m.includes('notes.md') && m.includes('预置那几份没动')
        && !m.includes('第 第') && !m.includes('楼 楼')), JSON.stringify(floorLogs().slice(-2)))
    check('D2c ★ 面板那句「最近一次自动回档跟随」有料可读（状态文件如实落盘，带变体）',
      statusDoc() !== null && statusDoc().kind === 'rollback' && statusDoc().to.seq === 1
      && statusDoc().to.variantId === VAR(NODES[0])
      && Array.isArray(statusDoc().restored) && statusDoc().restored.includes('notes.md')
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
    reset(V1)
    sync('turn')                       // 第 1 楼
    writeTimeline(NODES[1]); putFiles(V2); sync('turn')   // 第 2 楼
    writeTimeline(NODES[1], NODES, VAR(NODES[1], 2))      // ★ swipe 到第 2 支
    putFiles({ 'notes.md': '# 笔记\n第 2 支重 roll 出来的\n' })
    await drive(31)
    check('D4 ★ 真接线｜同一楼 swipe（换变体）⇒ 组装那一脚就把笔记退回"进这一楼之前"（第 1 楼那一份）',
      readMem('notes.md') === V1['notes.md']
      && String(statusDoc().message).includes('换了变体')
      && statusDoc().to.seq === 1 && statusDoc().why === 'variant'
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
    reset(V1)
    sync('turn')                       // 第 1 楼
    writeTimeline(NODES[3]); putFiles(V3); sync('turn')   // 第 4 楼（第 2、3 楼没记过）
    writeTimeline(NODES[1])            // ★ 回到第 2 楼（它没有快照）
    putFiles({ 'notes.md': '# 笔记\n第 4 楼之后模型又写了\n' })
    await drive(41)
    check('D4b ★ 真接线｜回到没有快照的楼层 ⇒ 退回"进这一楼之前"，那句把"回档到第 2 楼"与"用的是第 1 楼那一份"都说了',
      readMem('notes.md') === V1['notes.md']
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
    check('D6 ★ GET /floors：每一支给序号/变体/时间/改了哪几份（+几字节）/当前那一支高亮，且只列记过的',
      v.ok === true && v.floors.length === 2
      && v.floors.map((f) => f.seq).join(',') === '1,3'
      && cur.length === 1 && cur[0].seq === 3 && cur[0].variantId === VAR(NODES[2])
      && v.head.seq === 3 && v.head.variantId === VAR(NODES[2]) && v.orderKnown === true
      && v.last.variantId === VAR(NODES[2]) && v.lastFloorSeq === 3
      && Array.isArray(v.targets) && v.targets.length === 5
      && v.floors.every((f) => f.legacy === false)
      && Array.isArray(v.legacyFloors) && v.legacyFloors.length === 0
      // 第 1 楼那三份是"第一次出现"⇒ 没有基数（delta 如实为 null）；第 3 楼那三份都有 +N 字节
      && v.floors[0].changed.length === 3 && v.floors[0].changed.every((c) => c.delta === null)
      && v.floors[1].changed.length === 3 && v.floors[1].changed.every((c) => Number.isFinite(c.delta))
      && v.floors[1].changed.some((c) => c.name === 'notes.md'), JSON.stringify([v.floors.map((f) => f.seq), v.floors[0].changed, v.floors[1].changed]))
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
    // ★ 死区（真文档）在接线那一层的两条：按块合并 / 数据坏掉 ⇒ 整次不做
    const CORE2 = '## 【核心规则】\n- 不许改这段'
    reset({ 'notes.md': V1['notes.md'], 'index.md': `${CORE2}\n\n# 索引\nv1\n` })
    writeDeadzones([['index.md', CORE2]])
    await fireEvent('turn/end')        // 第 1 楼（接线那一层自己读死区文档）
    writeTimeline(NODES[2])
    writeMem('index.md', `${CORE2}\n\n# 索引\n模型改的\n`)
    writeMem('notes.md', '# 笔记\n模型改的\n')
    await fireEvent('turn/end')        // 第 3 楼
    writeTimeline(NODES[0])            // 回档
    await fireEvent('turn/end')
    check('D8 ★ 接线那一层（读真文档）：死区那一份按块合并 —— index.md 的非死区块回到第 1 楼',
      readMem('index.md') === `${CORE2}\n\n# 索引\nv1\n` && readMem('notes.md') === V1['notes.md'])
    check('D8b ★ 状态文件把"按块合并"如实带上（⛔ 不再是"整份跳过"那种会误导的话）',
      statusDoc() !== null && Array.isArray(statusDoc().skipped)
      && statusDoc().skipped.some((s) => s.name === 'index.md' && s.reason === 'deadzone' && s.merged === true)
      && String(statusDoc().message).includes('死区')
      && String(statusDoc().message).includes('按块合并')
      && String(statusDoc().message).includes('保留盘上现况'), JSON.stringify(statusDoc().skipped))
    // ★ 死区数据坏掉 ⇒ 判据未知 ⇒ 整次恢复不做（⛔ 宁可不动）。走**真钩子**（接线那一层自己读文档）
    writeFileSync(join(PT_MEM, dz.DEADZONE_FILE_NAME), '{ 这不是 JSON')
    writeTimeline(NODES[2])
    writeMem('notes.md', '# 笔记\n第 3 楼又改了\n')
    await fireEvent('turn/end')        // 记第 3 楼（记录侧不看死区数据）
    writeTimeline(NODES[0])            // 回档到第 1 楼
    writeMem('notes.md', '# 笔记\n回档前那一刻\n')
    const lastBefore = indexOnDisk().last
    await fireEvent('turn/end')
    check('D8c ★ 死区数据坏掉（判据未知）⇒ 整次恢复不做 + 如实播报（⛔ 宁可不动，⛔ 不静默）',
      readMem('notes.md') === '# 笔记\n回档前那一刻\n'
      && statusDoc() !== null && statusDoc().blocked === 'deadzones-unreadable'
      && String(statusDoc().message).includes('死区数据读不出来')
      && floorLogs().some((m) => m.includes('死区数据读不出来')),
      JSON.stringify(statusDoc()))
    check('D8d ★ 被挡住时 `last` **不前进**（下一轮还判回档、还试一次；⛔ 不拿"什么都没做"当"已经跟上"）',
      indexOnDisk().last.nodeId === lastBefore.nodeId
      && indexOnDisk().last.variantId === lastBefore.variantId
      && readMem('notes.md') === '# 笔记\n回档前那一刻\n',
      JSON.stringify(lastBefore))
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
      const start = idx.indexOf('「**按楼层绑定**的笔记快照 + 回档跟随」的接线')
      const end = idx.indexOf('GET /playthrough/for-session', start)
      const floorBlock = idx.slice(start, end)
      const writes = floorBlock.match(/writeFileSync\([^,)]*/g) || []
      return start > 0 && end > start
        && !modCode.includes('timeline.json')                 // 本模块连时间线都不认识（读在接线那一层）
        && writes.length > 0 && writes.every((w) => w.includes('tmpPath'))
        && !/copyFileSync|unlinkSync|rmSync\(/.test(floorBlock)   // ⛔ 不删、不改名任何东西
        && !/writeFileSync\([^\n]*(timeline|catalog|play-workspace)/.test(idx)
    })())

  check('E4 ★ 判据只有一处：死区那套只在 `lib/deadzone.js`（floor-snapshot 只调用，⛔ 不另立一份）',
    (() => {
      const mod = readFileSync(join(ROOT, 'lib', 'floor-snapshot.js'), 'utf8')
      // 只 import 它的四个出口（sha256Hex / writeWithBackup / splitBlocks / locateZone）
      return /import \{ locateZone, sha256Hex, splitBlocks, writeWithBackup \} from '\.\/deadzone\.js'/.test(mod)
        && !/DEADZONE_FILE_NAME|readDocFile|decideToggle|normalizeDoc/.test(mod)
        // 死区那几条数据只有接线那一层读（`floorDeadZones`），而且**原样喂**给 planRestore
        && /function floorDeadZones\(dir\)/.test(readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8'))
    })())
} finally {
  await new Promise((r) => server.close(r))
  rmSync(HOME, { recursive: true, force: true })
  rmSync(WS, { recursive: true, force: true })
  if (existsSync(HOME) || existsSync(WS)) console.log('⚠️ 沙箱没清干净：' + HOME + ' / ' + WS)
}

console.log(`\n== 总结：${pass} 通过 / ${failed} 失败 ==`)
// ⛔ 不用 process.exit（undici 句柄在场时会被顶成 0xC0000409）；退出码走 process.exitCode。
process.exitCode = failed === 0 ? 0 : 1
