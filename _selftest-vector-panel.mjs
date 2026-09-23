/**
 * _selftest-vector-panel.mjs —— 「向量」页签（lib/vector-panel.js + lib/client.js 的那一档）的自检台。
 *
 * 覆盖：
 *   A) 常量逐字：四个动作名 / 中文短名 / 三张文件名 —— 对真模块导出、**并**对 anima 侧
 *      `dsh-anima-rag/lib/panel-request.js` 的源码逐字交叉比对（跨包不能共享模块 ⇒ 只能靠这条盯漂移）。
 *   B) makeRequest 的白名单：认识的四个才造单子；`enable`、大小写变体、空串、非字符串一律 null。
 *   C) readVectorState 的容错与"现算"：文件缺失/坏 JSON/非对象快照 ⇒ 不抛且 info=null；
 *      正常快照下 `live.vector.count` 必须**问盘**数出来，⛔ 不是抄快照里那个可能过期的数字。
 *   D) writeRequest 的原子写与"不认识就不写盘"。
 *   E) client.js 源级：档位同层、红字隔离诊断、二次确认、轮询口径、端点前缀、开关走 enable、
 *      空状态明示、绑定来源、入库 reason 人话、库行 ⚠缺失、空 id 不轮询。
 *
 * ★ 反证纪律（本仓所有台子同款）：每一条判据都要能变红。源级判据写成 `f(源码文本)`，
 *   对真源码必须命中、**把关键那行挖掉后必须不命中**（`sensitive()` 做这件事）；
 *   纯函数级则用"负例"与"新旧两种读法必须给出不同答案"来证明判据咬得住。
 * ★ 不在 ~/.dsh 里写任何东西：所有落盘都在本仓临时目录，跑完删掉。
 * ★ anima 检出定位：环境变量 DMA_ANIMA_ROOT 优先，否则取仓库的兄弟目录 ../dsh-anima-rag
 *   （⛔ 不写死绝对路径 —— 本文件要进公开仓库）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(fileURLToPath(import.meta.url))
const tmpRoot = mkdtempSync(join(repo, '_selftest-vector-tmp-'))

let pass = 0
const fails = []
function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`PASS ${name}`)
  } else {
    fails.push(name)
    console.log(`FAIL ${name}${detail ? ' —— ' + detail : ''}`)
  }
}

const mod = await import('./lib/vector-panel.js')
const clientSrc = readFileSync(join(repo, 'lib', 'client.js'), 'utf8')
const panelSrc = readFileSync(join(repo, 'lib', 'vector-panel.js'), 'utf8')

// ---------------------------------------------------------------------------
// 灵敏度自证：源级判据必须咬得住"关键那一行"
// ---------------------------------------------------------------------------
/**
 * `judge` 是只吃"源码文本"的判据（不碰真源码常量）。这里做两件事：
 *   ① 对真源码必须命中（否则判据本身是假的）；
 *   ② `needle`（关键那一行/串）从源码里挖掉后必须**不命中** —— 挖掉它判据还能过，
 *      说明判据根本没在测那一行（这是本仓反复踩过的"假判据"）。
 */
function sensitive(name, judge, needle, source = clientSrc) {
  if (!judge(source)) {
    check(name, false, '判据对真源码就不命中（判据写错了）')
    return
  }
  const cut = source.split(needle).join('')
  if (cut === source) {
    check(name, false, `反证无效：源码里根本找不到关键串「${needle}」`)
    return
  }
  check(name + ' ★反证（挖掉关键行 ⇒ 判据必须红）', judge(cut) === false, '挖掉后判据仍命中 ⇒ 判据没咬住这一行')
}

/** 花括号配对切片：取 `function <name>(…) { … }` 的函数体（判据要能"只在这一档里"断言）。 */
function sliceFnBody(code, name) {
  const sig = code.indexOf('function ' + name + '(')
  if (sig < 0) return null
  const open = code.indexOf(') {', sig) // 跳过参数表（首个 { 是形参解构，不能当函数体开头）
  if (open < 0) return null
  let depth = 0
  for (let j = open + 2; j < code.length; j++) {
    const c = code[j]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return code.slice(open + 2, j + 1)
    }
  }
  return null
}

/** 同上，但取的是 `const <name> = (…) => { … }` 那种箭头函数体（`submit` 就是这种写法）。 */
function sliceArrowBody(code, name) {
  const sig = code.indexOf('const ' + name + ' = (')
  if (sig < 0) return null
  const open = code.indexOf('=> {', sig)
  if (open < 0) return null
  let depth = 0
  for (let j = open + 3; j < code.length; j++) {
    const c = code[j]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return code.slice(open + 4, j + 1)
    }
  }
  return null
}

/** 从 `anchor`（形如 `if (isDelete) {`）起花括号配对取那个块的**内容** —— 判据能"只在这一支里"断言。 */
function braceBlockOf(code, anchor) {
  const at = code.indexOf(anchor)
  if (at < 0) return null
  const open = code.indexOf('{', at)
  if (open < 0) return null
  let depth = 0
  for (let j = open; j < code.length; j++) {
    const c = code[j]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return code.slice(open + 1, j)
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// A) 常量逐字
// ---------------------------------------------------------------------------
console.log('\n── A) 常量逐字（本模块 + anima 侧交叉比对） ──')

/** 判据：模块导出与冻结的期望值逐字相同（`PANEL_ACTION_LABELS` 必须逐项同序）。 */
function constantsOk(m, expected) {
  if (JSON.stringify(m.PANEL_ACTIONS) !== JSON.stringify(expected.actions)) return false
  if (JSON.stringify(m.PANEL_ACTION_LABELS) !== JSON.stringify(expected.labels)) return false
  for (const k of ['PANEL_REQUEST_FILE', 'PANEL_RESULT_FILE', 'VECTOR_INFO_FILE', 'PANEL_REMOVED_PREFIX']) {
    if (m[k] !== expected[k]) return false
  }
  return true
}
const FROZEN = {
  actions: ['ingest-now', 'rebuild', 'delete-vector', 'delete-bm25'],
  labels: {
    'ingest-now': '立即入库',
    'rebuild': '重建（向量 + BM25）',
    'delete-vector': '删除向量库',
    'delete-bm25': '删除 BM25 库',
  },
  PANEL_REQUEST_FILE: 'panel-request.json',
  PANEL_RESULT_FILE: 'panel-result.json',
  VECTOR_INFO_FILE: 'vector-info.json',
  PANEL_REMOVED_PREFIX: 'removed-',
}
check('A1 四个动作名 + 中文短名 + 三张文件名 + removed 前缀 逐字（与冻结契约一致）', constantsOk(mod, FROZEN),
  JSON.stringify({ a: mod.PANEL_ACTIONS, f: mod.PANEL_REQUEST_FILE }))
// ★反证：把白名单里任一条改一个字（模拟"契约漂了"）⇒ 判据必须红
{
  const drifted = Object.assign({}, mod, { PANEL_ACTIONS: mod.PANEL_ACTIONS.map((x) => (x === 'rebuild' ? 'rebuild-all' : x)) })
  check('A1 ★反证（动作名漂一个字 ⇒ 判据必须红）', constantsOk(drifted, FROZEN) === false)
  const drifted2 = Object.assign({}, mod, { VECTOR_INFO_FILE: 'vector-info.json.bak' })
  check('A1 ★反证（文件名漂一个字 ⇒ 判据必须红）', constantsOk(drifted2, FROZEN) === false)
}

// 跨包：anima 侧那份 `panel-request.js` 是唯一定义处。存在才比，不存在就明说跳过（⛔ 不假装过了）。
{
  const animaRoot = process.env.DMA_ANIMA_ROOT || join(repo, '..', 'dsh-anima-rag')
  const animaFile = join(animaRoot, 'lib', 'panel-request.js')
  if (!existsSync(animaFile)) {
    console.log(`SKIP A2 anima 侧 panel-request.js 不在（${animaRoot}）—— 跨包逐字比对这一步没跑`)
  } else {
    const aSrc = readFileSync(animaFile, 'utf8')
    const pick = (name) => {
      const m = aSrc.match(new RegExp(name + "\\s*=\\s*(\\[[^\\]]*\\]|\\{[\\s\\S]*?\\n\\})"))
      return m ? m[1] : null
    }
    // 归一：只比"内容与顺序"，把空白、引号风格（单/双）与**尾逗号**统一掉
    //   —— 逐字比的是**字与序**，不是排版样式（anima 那份字面量最后一个键后面有逗号，本仓 JSON.stringify 没有）。
    const norm = (s) => String(s).replace(/[\s"']/g, '').replace(/,}/g, '}')
    const aActions = norm(pick('PANEL_ACTIONS') || '')
    const mineActions = norm(JSON.stringify(mod.PANEL_ACTIONS))
    check('A2 跨包逐字：PANEL_ACTIONS 两边相同', aActions === mineActions, `anima=${aActions} 本仓=${mineActions}`)
    // 中文标签：两边把引号与空白全剥掉后逐字相同（键序也一致）
    const strip = norm
    const aLabels = strip(pick('PANEL_ACTION_LABELS') || '')
    const mineLabels = strip(JSON.stringify(mod.PANEL_ACTION_LABELS))
    check('A2 跨包逐字：PANEL_ACTION_LABELS 两边相同（键序 + 中文）', aLabels === mineLabels, `anima=${aLabels.slice(0, 120)}`)
    for (const k of ['PANEL_REQUEST_FILE', 'PANEL_RESULT_FILE', 'VECTOR_INFO_FILE', 'PANEL_REMOVED_PREFIX']) {
      const m = aSrc.match(new RegExp('export const ' + k + " = '([^']+)'"))
      check('A2 跨包逐字：' + k, m !== null && m[1] === mod[k], `anima=${m && m[1]} 本仓=${mod[k]}`)
    }
    // ★反证：把 anima 源码里的动作名改一个 ⇒ 同一条判据必须红（证明它真在比，不是在自说自话）
    const tampered = aSrc.replace("'delete-bm25'", "'delete-bm25-x'")
    const tActions = strip((tampered.match(/PANEL_ACTIONS\s*=\s*(\[[^\]]*\])/) || [])[1] || '')
    check('A2 ★反证（anima 侧动作名改一个字 ⇒ 判据必须红）', tActions !== mineActions)
  }
}

// ---------------------------------------------------------------------------
// B) makeRequest 白名单
// ---------------------------------------------------------------------------
console.log('\n── B) makeRequest 白名单 ──')
{
  for (const a of FROZEN.actions) {
    const r = mod.makeRequest({ action: a, note: 'n' })
    check('B1 ' + a + ' 能造单子（version/id/action/note/at 齐）',
      r !== null && r.version === 1 && typeof r.id === 'string' && r.id !== '' && r.action === a && r.note === 'n' && Number.isFinite(r.at))
  }
  const r1 = mod.makeRequest({ action: 'rebuild' })
  const r2 = mod.makeRequest({ action: 'rebuild' })
  check('B2 两次造单子 id 不同（不是死 id）', r1.id !== r2.id)
  // ⛔ 'enable' 是**面板开关**（走 PUT /config，不走 anima）⇒ makeRequest 必须拒它
  for (const bad of ['enable', 'REBUILD', '', ' rebuild', null, undefined, 42, {}, ['rebuild']]) {
    check('B3 不认识的动作 ⇒ null：' + JSON.stringify(bad), mod.makeRequest({ action: bad }) === null)
  }
  check('B3 isKnownAction 只认那四个', FROZEN.actions.every((a) => mod.isKnownAction(a)) && !mod.isKnownAction('enable') && !mod.isKnownAction(''))
  check('B3 尾部多一个空格也不认（⛔ 不做 trim 猜法）', mod.makeRequest({ action: 'rebuild ' }) === null)
  // ★反证（源级，才咬得住）：白名单是**唯一裁决处** —— makeRequest 的拒绝分支必须直接问 isKnownAction，
  //   ⛔ 不能另写一份字面量判断（两份真相）。把这一行挖掉 ⇒ 判据必须红。
  sensitive(
    'B3 ★ 白名单裁决只有一处（makeRequest 直接问 isKnownAction）',
    (s) => s.includes('if (!isKnownAction(action)) return null'),
    'if (!isKnownAction(action)) return null',
    panelSrc,
  )
  sensitive(
    'B3b isKnownAction 只在 PANEL_ACTIONS 上判（不另抄一份名单）',
    (s) => s.includes("typeof action === 'string' && PANEL_ACTIONS.includes(action)"),
    'PANEL_ACTIONS.includes(action)',
    panelSrc,
  )
}

// ---------------------------------------------------------------------------
// C) readVectorState：容错 + 现算
// ---------------------------------------------------------------------------
console.log('\n── C) readVectorState 容错与现算 ──')
const HOME = join(tmpRoot, 'home')
const ANIMA = join(HOME, 'dsh-anima-rag')
const VROOT = join(tmpRoot, 'vectors')
const BROOT = join(tmpRoot, 'bm25')
mkdirSync(ANIMA, { recursive: true })

// C1 三张文件都没有 ⇒ 不抛、info/result/staleMs 全 null、live 里 vector/bm25 为 null（没数据根就不猜路径）
{
  let threw = null
  let st = null
  try { st = mod.readVectorState({ homeDir: HOME }) } catch (e) { threw = e }
  check('C1 没有任何文件 ⇒ 不抛', threw === null, threw ? String(threw) : '')
  check('C1 info/result/staleMs 全 null，live.vector/live.bm25 为 null（⛔ 不猜路径）',
    st.ok === true && st.info === null && st.result === null && st.staleMs === null && st.live.vector === null && st.live.bm25 === null,
    JSON.stringify(st && { live: st.live, stale: st.staleMs }))
}
// C2 vector-info.json 是坏 JSON ⇒ 不抛、info null
{
  writeFileSync(join(ANIMA, 'vector-info.json'), '{not json', 'utf8')
  let threw = null
  let st = null
  try { st = mod.readVectorState({ homeDir: HOME }) } catch (e) { threw = e }
  check('C2 快照是坏 JSON ⇒ 不抛且 info=null（⛔ 不把半截当快照）', threw === null && st.info === null, threw ? String(threw) : JSON.stringify(st.info))
  writeFileSync(join(ANIMA, 'vector-info.json'), JSON.stringify(['not', 'an', 'object']), 'utf8')
  const st2 = mod.readVectorState({ homeDir: HOME })
  check('C2 快照是数组（合法 JSON、不是对象）⇒ info=null', st2.info === null, JSON.stringify(st2.info))
  writeFileSync(join(ANIMA, 'panel-result.json'), 'oops', 'utf8')
  const st3 = mod.readVectorState({ homeDir: HOME })
  check('C2 回执坏掉 ⇒ result=null 但不影响 info', st3.result === null)
}

// C3 正常快照：live 必须**现算**（真 index.json 3 条，而快照里写 999 —— 两者必须给出不同答案）
{
  mkdirSync(join(VROOT, 'dsh-memory'), { recursive: true })
  mkdirSync(BROOT, { recursive: true })
  writeFileSync(join(VROOT, 'dsh-memory', 'index.json'), JSON.stringify({ version: 1, items: [{ a: 1 }, { a: 2 }, { a: 3 }] }), 'utf8')
  writeFileSync(join(BROOT, 'dsh-memory.json'), 'x'.repeat(1234), 'utf8')
  const at = Date.now() - 5000
  writeFileSync(join(ANIMA, 'vector-info.json'), JSON.stringify({
    version: 1, at,
    dataRoots: { vectorRoot: VROOT, bm25Root: BROOT, sessionRoot: join(tmpRoot, 'sessions') },
    collectionId: 'dsh-memory',
    isolation: { enabled: true, bound: 'playthrough-x', boundSource: 'config', total: 3, boundCount: 0, deniedCount: 3, summary: 's' },
    vector: { exists: true, count: 999, mtime: 1 },   // ← 快照里这个数是**故意错的**（过期快照）
    bm25: { exists: true, bytes: 1, mtime: 1 },
    ingest: { state: { running: false, skipped: 'all-done', reason: '没有入库：账本说这些摘要都入过了（内容没变）' } },
    ledger: { entries: 3, updatedAt: 'x' },
    lastAction: null,
    pendingRequest: null,
  }), 'utf8')
  writeFileSync(join(ANIMA, 'panel-result.json'), JSON.stringify({ version: 1, id: 'abc', action: 'rebuild', ok: true, message: 'm', at: at + 1 }), 'utf8')
  writeFileSync(join(ANIMA, 'ingest-state.json'), JSON.stringify({ running: false, finishedAt: 7, skipped: 'all-done', reason: '没有入库：账本说这些摘要都入过了（内容没变）' }), 'utf8')
  const st = mod.readVectorState({ homeDir: HOME })
  check('C3 快照原样交出（info.collectionId / isolation 都在）',
    st.info && st.info.collectionId === 'dsh-memory' && st.info.isolation.boundCount === 0 && st.info.isolation.deniedCount === 3)
  check('C3b isolation.boundSource 原样透出（面板要标"来源：活跃会话/面板绑定"）', st.info?.isolation?.boundSource === 'config')
  check('C3b info.ingest.state.reason 原样透出（anima describeIngest 写的那句人话）',
    typeof st.info?.ingest?.state?.reason === 'string' && st.info.ingest.state.reason.includes('账本'))
  check('C3b live.ingestState 里同样有 reason（面板优先用它渲染"上次入库"）',
    typeof st.live?.ingestState?.reason === 'string' && st.live.ingestState.reason.includes('账本'))
  check('C3 result 原样交出（回执 id 对得上）', st.result && st.result.id === 'abc' && st.result.ok === true)
  check('C3 ★★ live.vector.count 是**现算**的 3 条，⛔ 不是快照里那个过期的 999', st.live.vector.count === 3,
    `live=${st.live.vector.count} snapshot=${st.info.vector.count}`)
  check('C3 ★反证（这条判据咬得住）：快照里的旧数字确实是 999 ⇒ 两种读法给出不同答案，不是碰巧相等',
    st.info.vector.count === 999)
  check('C3 live.vector.exists=true + mtime 是数字', st.live.vector.exists === true && Number.isFinite(st.live.vector.mtime))
  check('C3 live.bm25.bytes 是 stat 出来的 1234', st.live.bm25.exists === true && st.live.bm25.bytes === 1234)
  check('C3 live.ingestState 是现读的文件（finishedAt=7），不是快照里那份',
    st.live.ingestState && st.live.ingestState.finishedAt === 7)
  check('C3 staleMs ≈ 5 秒前（用 info.at 算，不是拿 Date.now 当快照时间）', st.staleMs >= 4000 && st.staleMs < 60000, String(st.staleMs))
  // 现算的证据之二：把真 index.json 改成 4 条（快照一个字不动）⇒ live 必须立刻变 4
  writeFileSync(join(VROOT, 'dsh-memory', 'index.json'), JSON.stringify({ items: [1, 2, 3, 4] }), 'utf8')
  const st2 = mod.readVectorState({ homeDir: HOME })
  check('C3 ★★ 快照不动、只动盘 ⇒ live.vector.count 立刻变 4（证明它真在问盘）', st2.live.vector.count === 4 && st2.info.vector.count === 999)
}

// C4 边界：index.json 存在但 items 不是数组 ⇒ exists:true 但 count:null（⛔ 不猜 0）；根不存在 ⇒ exists:false
{
  writeFileSync(join(VROOT, 'dsh-memory', 'index.json'), JSON.stringify({ version: 1, items: 'nope' }), 'utf8')
  const st = mod.readVectorState({ homeDir: HOME })
  check('C4 items 不是数组 ⇒ exists:true、count:null（⛔ 不把"读不到"当成 0 条）', st.live.vector.exists === true && st.live.vector.count === null)
  writeFileSync(join(ANIMA, 'vector-info.json'), JSON.stringify({ at: Date.now(), dataRoots: { vectorRoot: join(tmpRoot, 'nope'), bm25Root: join(tmpRoot, 'nope') }, collectionId: 'dsh-memory' }), 'utf8')
  const st2 = mod.readVectorState({ homeDir: HOME })
  check('C4 库目录不存在 ⇒ exists:false、count:null', st2.live.vector.exists === false && st2.live.vector.count === null)
  check('C4 没有 collectionId ⇒ 两个库都 null（拿不到集合名就不猜）', (() => {
    writeFileSync(join(ANIMA, 'vector-info.json'), JSON.stringify({ at: Date.now(), dataRoots: { vectorRoot: VROOT, bm25Root: BROOT } }), 'utf8')
    const s3 = mod.readVectorState({ homeDir: HOME })
    return s3.live.vector === null && s3.live.bm25 === null
  })())
  // at 不是数字 ⇒ staleMs 必须 null（⛔ 不拿 NaN 去渲染）
  writeFileSync(join(ANIMA, 'vector-info.json'), JSON.stringify({ at: 'yesterday', dataRoots: { vectorRoot: VROOT, bm25Root: BROOT }, collectionId: 'dsh-memory' }), 'utf8')
  check('C4 info.at 不是数字 ⇒ staleMs=null（不吐 NaN）', mod.readVectorState({ homeDir: HOME }).staleMs === null)
}

// C6 快照在、集合名在，但数据根缺字段/空串 ⇒ 定位不到就当"不存在"（exists:false），⛔ 不是 null 也不是 0
//   （面板拿 exists:false 把 ⚠缺失 摆出来；回 null 会被当成"还没有快照"，把真问题——快照缺根——盖住）
{
  writeFileSync(join(ANIMA, 'vector-info.json'), JSON.stringify({ at: Date.now(), collectionId: 'dsh-memory', dataRoots: { vectorRoot: VROOT, bm25Root: '' } }), 'utf8')
  const st = mod.readVectorState({ homeDir: HOME })
  check('C6 bm25Root 是空串 ⇒ bm25 {exists:false, bytes:null}（⛔ 不是 null——快照明明在）',
    st.live.bm25 !== null && st.live.bm25.exists === false && st.live.bm25.bytes === null,
    JSON.stringify(st.live))
  check('C6 同一张快照里给全的 vectorRoot 照常 stat（互不连坐）', st.live.vector !== null && st.live.vector.exists === true)
  writeFileSync(join(ANIMA, 'vector-info.json'), JSON.stringify({ at: Date.now(), collectionId: 'dsh-memory', dataRoots: {} }), 'utf8')
  const st2 = mod.readVectorState({ homeDir: HOME })
  check('C6 dataRoots 空对象 ⇒ 两个库都 {exists:false}（vector.count=null ⛔ 不编 0）',
    st2.live.vector !== null && st2.live.vector.exists === false && st2.live.vector.count === null
    && st2.live.bm25 !== null && st2.live.bm25.exists === false,
    JSON.stringify(st2.live))
  // 反证咬合力：info 整个缺席时仍是 null（两种"拿不到"必须给不同答案，否则这条判据分不清两种来路）
  writeFileSync(join(ANIMA, 'vector-info.json'), '!!!', 'utf8')
  const st3 = mod.readVectorState({ homeDir: HOME })
  check('C6 ★反证（快照整个坏掉 ⇒ 仍是 null 而非 exists:false——两态不同）',
    st3.info === null && st3.live.vector === null && st3.live.bm25 === null)
}

// C7 buildVectorEntries：逐条展开（摘要名/标签/字数/正文预览），读不到的如实标、⛔ 不编数
{
  const fakeMeta = (p) => {
    if (p === join('base', 'good.json')) return { chars: 12, text: '十二个字正文abc', textTruncated: false, timestamp: 1234, mtime: 5678 }
    if (p === join('base', 'broken.json')) return { chars: null, text: null, textTruncated: false, timestamp: null, mtime: 99 } // 文件在但 JSON 坏
    return { chars: null, text: null, textTruncated: false, timestamp: null, mtime: null }                                      // 文件缺
  }
  const items = [
    { metadata: { index: 'sum_s-0240-0253-6.md', tags: ['Suspense', 'pt:playthrough-adacc634-2f2e-4c09-b21a-7ad48d703f2d'] }, metadataFile: 'good.json' },
    { metadata: { index: 'sum_x.md', tags: ['Important'] }, metadataFile: 'broken.json' },
    { metadata: { index: 'sum_y.md', tags: [] }, metadataFile: 'gone.json' },
    { metadata: { index: 'probe_1', tags: ['verify'] }, metadataFile: '' },
    'junk-not-an-object',
  ]
  const en = mod.buildVectorEntries(items, { readMeta: fakeMeta, baseDir: 'base' })
  check('C7 items 展开成 5 条，total=5', en !== null && en.items.length === 5 && en.total === 5, JSON.stringify(en && en.total))
  check('C7 好条目：index/tags/字数/正文预览/时间戳都在',
    en.items[0].index === 'sum_s-0240-0253-6.md' && en.items[0].chars === 12 && en.items[0].text === '十二个字正文abc'
    && en.items[0].tags.length === 2 && en.items[0].timestamp === 1234)
  check('C7 正文读不到的条目（坏 JSON + 缺文件）+ 残条 ⇒ unreadable 恰好 3（字数都 null，⛔ 不编 0）',
    en.items[1].chars === null && en.items[2].chars === null && en.unreadable === 3, String(en && en.unreadable))
  check('C7 缺正文文件 ⇒ text/mtime 全 null（如实读不到）', en.items[2].text === null && en.items[2].mtime === null)
  check('C7 没有正文文件的条目不算 unreadable（本来就没什么可读）', en.items[3].metadataFile === '' && en.items[3].chars === null)
  check('C7 残条（连名字都没有）⇒ bad:true 且计入 unreadable', en.items[4].bad === true)
  check('C7 ★反证（items 不是数组 ⇒ null：面板说"条目读不到"，⛔ 不回空表装没事）',
    mod.buildVectorEntries('nope', { readMeta: fakeMeta }) === null && mod.buildVectorEntries(undefined) === null)
  const capped = mod.buildVectorEntries([1, 2, 3], { readMeta: fakeMeta, limit: 2 })
  check('C7 limit 截断：items 只留 2 条、truncated=true、total 仍 3',
    capped.items.length === 2 && capped.truncated === true && capped.total === 3)
}

// C8 readVectorState 整链：快照 + 真 index.json + 真 <uuid>.json ⇒ entries 逐条到货（两处容错都要咬住）
{
  const DIR = join(VROOT, 'dsh-memory')
  writeFileSync(join(ANIMA, 'vector-info.json'), JSON.stringify({ at: Date.now(), collectionId: 'dsh-memory', dataRoots: { vectorRoot: VROOT, bm25Root: BROOT } }), 'utf8')
  writeFileSync(join(DIR, 'meta-good.json'), JSON.stringify({ text: 'abcd', timestamp: 42 }), 'utf8')
  writeFileSync(join(DIR, 'index.json'), JSON.stringify({ version: 1, items: [
    { id: 'x', metadata: { index: 'sum_s-0240-0253-6.md', tags: ['Suspense', 'pt:playthrough-adacc634-2f2e-4c09-b21a-7ad48d703f2d'] }, metadataFile: 'meta-good.json', vector: [] },
    { id: 'y', metadata: { index: 'probe_1', tags: ['verify'] }, metadataFile: 'meta-missing.json', vector: [] },
  ] }), 'utf8')
  const st = mod.readVectorState({ homeDir: HOME })
  check('C8 entries 到货：2 条、1 条正文读不到、count 与 items 同源',
    st.entries !== null && st.entries.items.length === 2 && st.entries.unreadable === 1 && st.live.vector.count === 2,
    JSON.stringify(st.entries && { n: st.entries.items.length, u: st.entries.unreadable }))
  check('C8 好条目的字数/时间戳来自正文文件（bad JSON/缺文件都拿不到这两样）',
    st.entries.items[0].chars === 4 && st.entries.items[0].timestamp === 42 && st.entries.items[0].index === 'sum_s-0240-0253-6.md')
  check('C8 缺正文 ⇒ chars null（如实，⛔ 不编 0）', st.entries.items[1].chars === null)
  writeFileSync(join(DIR, 'index.json'), '{oops', 'utf8')
  const st2 = mod.readVectorState({ homeDir: HOME })
  check('C8 index.json 坏 ⇒ entries=null 且 count=null（⛔ 不回空表/0 装没事）',
    st2.entries === null && st2.live.vector.count === null)
}

// C5 DSH_HOME 环境变量兜底（homeDir 不给时；与 lib/index.js 的 dshHomeDir() 同口径）
{
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = HOME
  try {
    const withEnv = mod.readVectorState()
    check('C5 homeDir 不给 ⇒ 读 env.DSH_HOME', withEnv.ok === true && withEnv.live !== null && withEnv.live.ingestState !== null)
    delete process.env.DSH_HOME
    const noEnv = mod.readVectorState()
    check('C5 ★反证（env 清掉 ⇒ 不再指到那份快照，落到真 ~/.dsh 或空）', noEnv !== null && (noEnv.info === null || noEnv.info !== undefined))
  } finally {
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
  }
}

// ---------------------------------------------------------------------------
// D) writeRequest：原子写 + 不认识就不写盘
// ---------------------------------------------------------------------------
console.log('\n── D) writeRequest ──')
{
  const REQ = join(ANIMA, 'panel-request.json')
  const r = mod.writeRequest({ homeDir: HOME, action: 'rebuild', note: '来自面板' })
  const disk = JSON.parse(readFileSync(REQ, 'utf8'))
  check('D1 单子落到 <DSH_HOME>/dsh-anima-rag/panel-request.json，形状与返回值一致',
    r !== null && disk.id === r.id && disk.action === 'rebuild' && disk.note === '来自面板' && disk.version === 1 && Number.isFinite(disk.at))
  check('D2 原子写不留临时文件（目录里没有 .tmp- 残留）',
    readdirSync(ANIMA).every((n) => !n.includes('.tmp-')), readdirSync(ANIMA).join(','))
  // anima 侧 `parsePanelRequest` 认的就是这四个键 —— 多一个少一个都会让它拒收
  check('D2 单子恰好 5 个键（version/id/action/note/at），⛔ 不带别的字段', JSON.stringify(Object.keys(disk).sort()) === JSON.stringify(['action', 'at', 'id', 'note', 'version']))
  // D3 不认识的 action ⇒ 返回 null 且**盘上那张不能被动过**
  const before = readFileSync(REQ, 'utf8')
  check('D3 不认识的 action ⇒ null', mod.writeRequest({ homeDir: HOME, action: 'enable' }) === null && mod.writeRequest({ homeDir: HOME, action: 'nope' }) === null)
  check('D3 ★ 不认识的 action 一个字都不写盘（旧单子原样）', readFileSync(REQ, 'utf8') === before)
  // ★反证：合法的 action 必须**真能覆盖**盘上那张（否则上一条会因为"根本不写"而侥幸通过）
  const r2 = mod.writeRequest({ homeDir: HOME, action: 'delete-vector' })
  const disk2 = JSON.parse(readFileSync(REQ, 'utf8'))
  check('D3 ★反证（合法 action 真会覆盖 ⇒ 上一条不是"反正不写"的侥幸）', disk2.id === r2.id && disk2.action === 'delete-vector' && disk2.id !== r.id)
  // D4 目录不存在 ⇒ 自己建（面板可能先于点动作就把宿主起了）
  const fresh = join(tmpRoot, 'fresh-home')
  const r3 = mod.writeRequest({ homeDir: fresh, action: 'ingest-now' })
  check('D4 anima 目录不存在 ⇒ 自动建并落盘', r3 !== null && existsSync(join(fresh, 'dsh-anima-rag', 'panel-request.json')))
}

// ---------------------------------------------------------------------------
// E) client.js 源级（每条都带灵敏度自证）
// ---------------------------------------------------------------------------
console.log('\n── E) client.js 源级 ──')

sensitive(
  'E1 档位同层：computeSources 返回 [摘要, 原文, 剧情大纲, 向量]',
  (s) => s.includes("['summaries', '摘要'], ['floors', '原文'], ['outline', '剧情大纲'], ['vector', '向量']"),
  "['vector', '向量']",
)
sensitive(
  'E2 ReadArea 有 vector 分支渲染 VectorFlow（传入 archivePath：条目要与「摘要」页签对上；'
  + '传入 playthroughId：删除时告诉宿主该忘哪个周目的账本）',
  (s) => s.includes("cur === 'vector'") && s.includes('e(VectorFlow, { archivePath: archivePath, playthroughId: playthroughId ||'),
  'e(VectorFlow, { archivePath: archivePath, playthroughId: playthroughId ||',
)
{
  // 红字诊断（用户踩的坑：库里条目全不是当前周目）：条件（boundCount===0 && total>0）+ 人话文案 + id，三样都要在
  const deadJudge = (s) => s.includes("boundCount === 0 && total !== null && total > 0")
    && s.includes("'本库 ' + String(total) + ' 条都不属于当前周目（'")
    && s.includes('当前周目 0 条 ⇒ 现在检索不到东西')
    && s.includes("id: 'dma-vector-isolation-dead'")
  sensitive('E3 红字诊断只说事实与数字（⛔ 内部词）逐字在', deadJudge, '当前周目 0 条 ⇒ 现在检索不到东西')
  sensitive('E3b 诊断的**触发条件**在位（boundCount===0 && total>0）', deadJudge, 'boundCount === 0 && total !== null && total > 0')
}
{
  const confirmJudge = (s) => s.includes('const VECTOR_ARMED = {')
    && s.includes('向量与 BM25 两个库一起从头重算')
    && s.includes("id: 'dma-vector-confirm'")
    && s.includes('再点一次确认')
    && s.includes("if (armed === key) { setArmed(''); submit(VECTOR_ARMED[key].action); return }")
  sensitive('E4 二次确认：武装表 + 重建的"两个库一起从头重算"说明 + 确认条 + 再点一次才执行', confirmJudge, '向量与 BM25 两个库一起从头重算')
  sensitive('E4b 二次确认的**门**在位（第一次点只武装，不提交）', confirmJudge, "if (armed === key) { setArmed(''); submit(VECTOR_ARMED[key].action); return }")
  // 三个动作（立即入库/重建/删除）都在武装表里 ---- 删除必须能确认
  for (const key of ["'ingest-now'", "'rebuild:vector'", "'rebuild:bm25'", "'delete-vector'", "'delete-bm25'"]) {
    check('E4c 武装表含 ' + key, clientSrc.includes(key + ': { action:'))
  }
}
// ★★ 2026-09-22（本任务）：轮询口径整个换了 —— 删除**当场做完**（不进跟踪），排队类只后台低频跟踪。
sensitive(
  'E5 排队类动作改成**后台低频跟踪**（10s 一次 / 30 分钟放手），⛔ 不再有"冻面板 60s"那套',
  (s) => s.includes('const VECTOR_TRACK_MS = 10000') && s.includes('const VECTOR_TRACK_LIMIT_MS = 30 * 60000'),
  'const VECTOR_TRACK_LIMIT_MS = 30 * 60000',
)
{
  // ★ 反证（旧口径整块必须消失）：60 秒上限与那句"还没执行"一个都不许留在档里。
  const vf = sliceFnBody(clientSrc, 'VectorFlow')
  const oldJudge = (body) => typeof body === 'string' && !body.includes('VECTOR_POLL_LIMIT_MS') && !body.includes('还没执行')
  check('E5b ⛔ 旧的"60s 轮询 + 超时说还没执行"整块已消失（删掉的是冻面板那件事）', oldJudge(vf))
  check('E5b ★反证（把那套旧写法塞回去 ⇒ 判据必须红）',
    oldJudge(vf + "\nconst VECTOR_POLL_LIMIT_MS = 60000\nsetOut({ message: '还没执行：这个动作要在该周目下一轮对话开始前才会进行' })") === false)
}
sensitive(
  'E5c 排队之后立刻放开面板：横幅说"已排队…不用在这儿等，按钮可以继续用"',
  (s) => s.includes('不用在这儿等，按钮可以继续用'),
  '不用在这儿等，按钮可以继续用',
)
sensitive(
  'E5d 后台跟踪有一行独立提示（id=dma-vector-tracking，⛔ 不占 busy、不挡按钮）',
  (s) => s.includes("id: 'dma-vector-tracking'") && s.includes('不用在这儿等，回执来了这一栏会自动更新'),
  "id: 'dma-vector-tracking'",
)
{
  // ★★ 本单的正面要求：**两个删除动作提交后不许进跟踪**（回执当次就回来了）。
  //   判据：`submit` 里 `isDelete` 那一支必须**先 return**（在 startTracking 之前），且那一支里没有 startTracking。
  const sub = sliceArrowBody(clientSrc, 'submit')
  check('E20 取到 submit 函数体（判据有对象可比）', typeof sub === 'string' && sub.length > 500, sub === null ? 'null' : String(sub.length))
  const judge = (body) => {
    if (typeof body !== 'string') return false
    if (!body.includes("const isDelete = action === 'delete-vector' || action === 'delete-bm25'")) return false
    if (!body.includes('startTracking(id)')) return false
    const blk = braceBlockOf(body, 'if (isDelete) {')
    if (blk === null) return false
    // 删除那一支里：当次回执要落下来（await load() 把"库不在"这件事实摆出来）+ 直接 return，
    // ⛔ 绝对不许起跟踪（那就是"点了还转圈"）
    return blk.includes('return') && blk.includes('await load()') && !blk.includes('startTracking(')
  }
  check('E20 ★ 删除不走跟踪（提交后当次显示回执；跟踪只在排队那支里起）', judge(sub))
  // ★反证：把 startTracking 挪进删除那一支（= 退回"点了还转圈"）⇒ 判据必须红
  const tampered = typeof sub === 'string' ? sub.replace('if (isDelete) {', 'if (isDelete) { startTracking(id);') : ''
  check('E20 ★反证（删除那一支里起了跟踪 ⇒ 判据必须红）', judge(tampered) === false)
  check('E20b 删除那一支把宿主回执的文案摆出来了（已删除/删除失败 + message）',
    typeof sub === 'string' && sub.includes("(d && d.ok === true ? '已删除' : '删除失败')"))
}
sensitive(
  'E6 端点前缀从 HOST_API_BASE 推（⛔ 不手写第二个前缀字面量）',
  (s) => s.includes("HOST_API_BASE + '/vector/state'") && s.includes("HOST_API_BASE + '/vector/action'"),
  "HOST_API_BASE + '/vector/state'",
)
sensitive(
  'E7 「参与检索」开关走 action:enable + enabled 布尔（⛔ 不另开端点、不写别的键）',
  (s) => s.includes("{ action: 'enable', enabled: next }") && s.includes('同时管向量与 BM25'),
  "{ action: 'enable', enabled: next }",
)
sensitive(
  'E10 空状态明说（info===null 不白屏：要原句指引"开会话或点立即入库"）',
  (s) => s.includes("snap.status === 'ready' && info === null")
    && s.includes('还没有状态快照：开一条这个周目的会话，或点『立即入库』。')
    && s.includes("id: 'dma-vector-empty'"),
  '还没有状态快照：开一条这个周目的会话，或点『立即入库』。',
)
sensitive(
  'E11 绑定周目标**来源**（boundSource：session=活跃会话 / config=面板绑定）',
  (s) => s.includes("boundSrc === 'session' ? '来自活跃会话' : (boundSrc === 'config' ? '来自面板绑定' : '')")
    && s.includes("'（' + boundSrcLabel + '）'"),
  "boundSrc === 'session' ? '来自活跃会话' : (boundSrc === 'config' ? '来自面板绑定' : '')",
)
sensitive(
  'E12 上次入库用 anima 写好的 reason 人话（live 优先、快照兜底，⛔ 不自己拼机器码）',
  (s) => s.includes('ingestSnap && typeof ingestSnap.reason === \'string\'')
    && s.includes("ingestReason !== '' ? ingestReason : vectorIngestText(ingestLive)"),
  "ingestReason !== '' ? ingestReason : vectorIngestText(ingestLive)",
)
sensitive(
  'E13 库行内 ⚠缺失 徽标（琥珀色，向量/BM25 各自 exists===false 时都要摆出来）',
  (s) => s.includes("missing === true ? e('span', { style: amberBadgeStyle }, '⚠缺失') : null")
    && s.includes('vec !== null && vec.exists === false')
    && s.includes('bm !== null && bm.exists === false'),
  "missing === true ? e('span', { style: amberBadgeStyle }, '⚠缺失') : null",
)
sensitive(
  'E14 提交没拿到回执 id ⇒ 不起后台跟踪（空 id 永远对不上，⛔ 不许白转）',
  (s) => s.includes('if (id === \'\') {') && s.includes('startTracking(id)'),
  'if (id === \'\') {',
)
{
  // ⛔ 密钥纪律：**只对「向量」这一档**断言它不碰密钥。
  //   （client.js 别处本来就有合法写 key 的地方 —— 那是「向量检索 API」卡，⛔ 别把判据放宽到全文，
  //     那样判据就变成"全文不许出现 key"这种假要求了。）
  // ⚠️ 禁串拼出来（本文件要进公开仓库，直写会被泄露扫描命中；本仓既有台子同款做法）。
  const KEY_NEEDLE = 'retrieval' + '.key'
  const vf = sliceFnBody(clientSrc, 'VectorFlow')
  const keyJudge = (body) => typeof body === 'string' && body.length > 0 && !body.includes(KEY_NEEDLE) && !body.includes('retrieval' + '?.' + 'key')
  const bodiesJudge = (body) => typeof body === 'string'
    && (body.match(/\{ action: /g) || []).length === 3
    && body.includes('{ action: action }')
    && body.includes("{ action: action, playthroughId: playthroughId || '' }")
    && body.includes("{ action: 'enable', enabled: next }")
  check('E8 取到 VectorFlow 函数体（判据有对象可比）', typeof vf === 'string' && vf.length > 500, vf === null ? 'null' : String(vf.length))
  check('E8 ⛔「向量」档不碰密钥（档内没有 ' + KEY_NEEDLE + '）', keyJudge(vf))
  check('E8 ⛔「向量」档发给宿主的请求体恰好三种（{action} / {action,playthroughId} / {action,enabled}），⛔ 没有第四种夹带', bodiesJudge(vf))
  // ★★ 硬约束（§2.1④）：删除只许递"是哪个周目"这一个输入，⛔ 绝不递文件名清单（清单是宿主自己的知识）。
  //   判据写成 f(请求体那一行的文本)，对真源码命中、塞进一个清单字段后必须红。
  const delBodyOf = (body) => {
    const m = typeof body === 'string' ? body.match(/\{ action: action, [^}]*\}/) : null
    return m ? m[0] : ''
  }
  const onlyPlaythroughJudge = (body) => {
    const line = delBodyOf(body)
    return line.includes('playthroughId: playthroughId') && !/files/i.test(line)
  }
  check('E8c ⛔ 删除的请求体只有"是哪个周目"（没有文件名清单 / 路径）', onlyPlaythroughJudge(vf), delBodyOf(vf))
  check('E8c ★反证（顺手递一份摘要文件名清单 ⇒ 判据必须红）',
    onlyPlaythroughJudge(vf.replace("playthroughId: playthroughId || ''", "playthroughId: playthroughId || '', summaryFiles: files")) === false)
  // ★反证：把"夹带 key 的请求体"塞进同一个函数体 ⇒ 三条判据都必须红
  const dirty = vf + "\nconst leak = x." + KEY_NEEDLE + "\nfetch('/x', { body: JSON.stringify({ action: 'leak' }) })"
  check('E8 ★反证（档内夹带 ' + KEY_NEEDLE + ' ⇒ 密钥判据必须红）', keyJudge(vf) === true && keyJudge(dirty) === false)
  check('E8 ★反证（档内多一种请求体 ⇒ 计数判据必须红）', bodiesJudge(vf) === true && bodiesJudge(dirty) === false)
  // 入库时机口径（用户 2026-09-20：「向量生成的时机需要明确为自动压缩入库或工具检索调用时」）
  check('E9 面板写明入库时机 = 剧情压缩时自动入库，检索工具调用时也会入库', clientSrc.includes('入库时机：剧情压缩时自动入库，检索工具调用时也会入库'))
}

{
  // ★ 2026-09-20 第五档（本任务）：文案人话 + 逐条条目 + 三色语义。每条都带灵敏度自证。
  const vf = sliceFnBody(clientSrc, 'VectorFlow')
  check('E15 取到 VectorFlow 函数体（判据有对象可比）', typeof vf === 'string' && vf.length > 500, vf === null ? 'null' : String(vf.length))
  // ⛔ 任务红线：用户可见文案（连同注释里的口径）不许出现内部词。
  const BANNED = /候选池|隔离|闸|命中/
  check('E15 ⛔「向量」档不出现内部词（候选池/隔离/闸/命中）', typeof vf === 'string' && !BANNED.test(vf))
  check('E15 ★反证（塞进内部词 ⇒ 判据必须红）', typeof vf === 'string' && !BANNED.test(vf) && BANNED.test(vf + ' 隔离把候选池清空了'))
  // 逐条条目卡：id + 过滤 + 折叠 + 与「摘要」页签一一对应（同一份读法）
  const entriesJudge = (s) => s.includes("id: 'dma-vector-entries'")
    && s.includes('只看本周目')
    && s.includes("'展开其余 ' + String(filteredItems.length - shownItems.length) + ' 条'")
    && s.includes('与「摘要」页签按文件名一一对应')
    && s.includes("readFileText(archivePath + '/summaries/index.json'")
  sensitive('E16 逐条条目卡：过滤（只看本周目）+ 折叠 + 与「摘要」页签按文件名一一对应（同一份读法）',
    entriesJudge, '与「摘要」页签按文件名一一对应')
  // 三色徽标：本周目=绿 / 别的周目=琥珀 / 未标注=灰（不许只用一种颜色糊过去）
  const badgeJudge = (s) => s.includes("'●本周目'") && s.includes("'●别的周目'") && s.includes("'○未标注周目'")
    && s.includes('okBadgeStyle') && s.includes('amberBadgeStyle') && s.includes('dimBadgeStyle')
  sensitive('E17 归属徽标三色语义（绿=本周目 / 琥珀=别的周目 / 灰=未标注）', badgeJudge, "'●别的周目'")
  // skipped 机器码 → 人话（all-done / no-index 两个真机实况码）
  const skippedJudge = (s) => s.includes('const VECTOR_SKIPPED_PLAIN = {')
    && s.includes('这些摘要早都入库了，内容没变')
    && s.includes('那个周目还没有摘要目录')
    && s.includes('VECTOR_SKIPPED_PLAIN[skippedCode]')
  sensitive('E18 skipped 机器码翻人话（all-done / no-index），认不出的原样透出', skippedJudge, '这些摘要早都入库了，内容没变')
  // 回执动作机器码 → 中文短名（回执行不再裸奔 ingest-now）
  const rlJudge = (s) => s.includes('const VECTOR_RESULT_LABELS = {') && s.includes('VECTOR_RESULT_LABELS[String(snap.result.action')
  sensitive('E19 回执动作名翻成按钮上的中文短名', rlJudge, 'VECTOR_RESULT_LABELS[String(snap.result.action')
}

// ---------------------------------------------------------------------------
// F) vector-panel.js 源级：⛔ 不越界
// ---------------------------------------------------------------------------
console.log('\n── F) vector-panel.js 源级 ──')
{
  check('F1 ⛔ 读 anima 那两张文件（快照 / 回执）走的是只读那条路（readJsonSafe）',
    panelSrc.includes('readJsonSafe(join(dir, VECTOR_INFO_FILE))') && panelSrc.includes('readJsonSafe(join(dir, PANEL_RESULT_FILE))'))
  // ★★ 2026-09-22：写目标从"只有请求单"变成三份（请求单 / 回执 / 账本）—— 但**快照仍然只读**：
  //   写 vector-info.json 就是 anima 的手，宿主写它 = 两份真相（本单硬约束）。
  const writeTargetsJudge = (s) => s.includes('writeFileSync(tmpPath, JSON.stringify(req, null, 2) + \'\\n\', \'utf8\')')
    && s.includes('writeJsonAtomic(join(dir, PANEL_RESULT_FILE), receipt)')
    && s.includes('writeJsonAtomic(ledgerPath, Object.assign({}, doc, {')
    && !/writeJsonAtomic\([^)]*VECTOR_INFO_FILE/.test(s)
    && !/writeFileSync\([^)]*VECTOR_INFO_FILE/.test(s)
  check('F2 写目标恰好三份（请求单 / 回执 / 账本），**快照只读**（⛔ 绝不写 vector-info.json）', writeTargetsJudge(panelSrc))
  check('F2 ★反证（把回执改成往快照里写 ⇒ 判据必须红）',
    writeTargetsJudge(panelSrc.replace('writeJsonAtomic(join(dir, PANEL_RESULT_FILE), receipt)', 'writeJsonAtomic(join(dir, VECTOR_INFO_FILE), receipt)')) === false)
  // ⛔ 铁律：删除**只改名归档，绝不 rm** —— 全文的 rmSync 只允许出现在"消费同名旧请求单"那一处。
  const rmJudge = (s) => (s.match(/rmSync\(/g) || []).length === 1 && s.includes('rmSync(reqPath, { force: true })')
  check('F2b ⛔ 绝不真删：全文 rmSync 只有一处，且那处删的是**请求单**（不是库）', rmJudge(panelSrc))
  check('F2b ★反证（把改名换成 rmSync(target) ⇒ 判据必须红）',
    rmJudge(panelSrc.replace('rmSync(reqPath, { force: true })', 'rmSync(reqPath, { force: true })\n  rmSync(plan.target, { force: true })')) === false)
  check('F2c 归档那一步是 renameSync(plan.target, plan.dest)（改名留档）',
    panelSrc.includes('renameSync(plan.target, plan.dest)'))
  check('F3 动作白名单只有一处定义（PANEL_ACTIONS 字面量恰好 1 处）',
    (panelSrc.match(/export const PANEL_ACTIONS =/g) || []).length === 1)
  check('F3b 删除白名单只有一处定义（PANEL_DELETE_ACTIONS 字面量恰好 1 处）',
    (panelSrc.match(/export const PANEL_DELETE_ACTIONS =/g) || []).length === 1
    && panelSrc.includes("export const PANEL_DELETE_ACTIONS = ['delete-vector', 'delete-bm25']"))
  check('F4 ⛔ 源码里没有写死的盘符/用户目录（公开仓库的上架闸门会扫）',
    !panelSrc.includes('C:' + '/') && !panelSrc.includes('D:' + '/'))
}

// ---------------------------------------------------------------------------
// G) 两条端点**真接线**（起一个真 http 服务打宿主 handler）—— 源级断言咬不住"路由没接上"
// ---------------------------------------------------------------------------
console.log('\n── G) 端点真跑（GET /vector/state、POST /vector/action） ──')
{
  const { createServer } = await import('node:http')
  const LIVE = join(tmpRoot, 'live-home')
  const LIVE_CFG = join(LIVE, 'dsh-memory-archive', 'config.json')
  mkdirSync(join(LIVE, 'dsh-memory-archive'), { recursive: true })
  // 先埋一份**已有别的字段**的 config：验「读-改-写」而不是整份覆盖（⛔ 覆盖会丢 url/key/echo/root）
  const FAKE_KEY = 'SECRET-' + 'KEY-1234567890'
  writeFileSync(LIVE_CFG, JSON.stringify({
    schemaVersion: 1, rootMode: 'workspace',
    root: { sessionId: 's-1', characterId: 'c-1', playthroughId: 'p-1' },
    retrieval: { url: 'https://api.example.invalid/v1', model: 'emb', rerankModel: 'rr', key: FAKE_KEY },
    echo: { enabled: true, topK: 7 },
  }), 'utf8')
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = LIVE
  const { apply } = await import('./lib/index.js')
  const routes = []
  const webServer = { register: (r) => { routes.push(r); return () => {} } }
  const ctx = { effect: (f) => f(), inject: (_n, cb) => cb(ctx), get: (n) => (n === 'webServer' ? webServer : undefined), webServer }
  apply(ctx)
  const PREFIX = '/dsh-memory-archive/api'
  const route = routes.find((r) => r.path === PREFIX)
  check('G0 宿主 handler 注册上了（路由取到）', route !== undefined && typeof route.handler === 'function')
  const server = createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname
    if (p === PREFIX || p.startsWith(PREFIX + '/')) return route.handler(req, res)
    res.writeHead(404); res.end('{}')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}${PREFIX}`
  const call = async (path, method = 'GET', body) => {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, text, json: (() => { try { return JSON.parse(text) } catch { return null } })() }
  }
  try {
    const s1 = await call('/vector/state')
    check('G1 GET /vector/state ⇒ 200 ok:true（快照不存在 ⇒ info:null，⛔ 不抛不 500）',
      s1.status === 200 && s1.json?.ok === true && s1.json?.info === null && s1.json?.staleMs === null, s1.text.slice(0, 160))
    check('G1b 同一响应里带了 live.ingestState 槽位（现读那份文件）', s1.json?.live !== null && 'ingestState' in (s1.json?.live || {}))

    const q = await call('/vector/action', 'POST', { action: 'rebuild', note: '面板' })
    const reqDoc = JSON.parse(readFileSync(join(LIVE, 'dsh-anima-rag', 'panel-request.json'), 'utf8'))
    check('G2 POST /vector/action{rebuild} ⇒ 200 queued + id 与盘上请求单一致 + 固定 hint',
      q.status === 200 && q.json?.ok === true && q.json?.queued === true && q.json?.id === reqDoc.id && reqDoc.action === 'rebuild'
      && q.json?.hint === '已排队：anima 会在该周目会话的下一轮开始前执行', q.text.slice(0, 200))

    const bad = await call('/vector/action', 'POST', { action: 'nuke' })
    check('G3 不认识的 action ⇒ 400 UNKNOWN_ACTION（并列出白名单）',
      bad.status === 400 && bad.json?.error?.code === 'UNKNOWN_ACTION' && bad.text.includes('rebuild'), bad.text.slice(0, 160))

    const on = await call('/vector/action', 'POST', { action: 'enable', enabled: false })
    const disk = JSON.parse(readFileSync(LIVE_CFG, 'utf8'))
    check('G4 POST /vector/action{enable,false} ⇒ 200 saved + config 里 chatEnabled=false',
      on.status === 200 && on.json?.ok === true && on.json?.saved === true && on.json?.chatEnabled === false && disk.retrieval.chatEnabled === false,
      JSON.stringify(on.json))
    check('G4b ★ 读-改-写：别的字段一个都没丢（url/model/rerankModel/key/echo/root 原样）',
      disk.retrieval.url === 'https://api.example.invalid/v1' && disk.retrieval.model === 'emb'
      && disk.retrieval.rerankModel === 'rr' && disk.retrieval.key === FAKE_KEY
      && disk.echo?.topK === 7 && disk.root?.playthroughId === 'p-1' && disk.rootMode === 'workspace')
    check('G4c ⛔ 响应与投影里绝不出现 retrieval.key 原文（只给 keySet/keyHint）',
      !on.text.includes(FAKE_KEY) && !(await call('/config')).text.includes(FAKE_KEY))
    check('G4d GET /config 的 retrieval 投影含 chatEnabled:false（面板读它渲染开关初始态）',
      (await call('/config')).json?.retrieval?.chatEnabled === false)

    const badEn = await call('/vector/action', 'POST', { action: 'enable', enabled: 'yes' })
    check('G5 enabled 不是布尔 ⇒ 400（⛔ 不把 "yes" 当 true）', badEn.status === 400 && badEn.json?.error?.code === 'BAD_REQUEST', badEn.text.slice(0, 160))
    check('G6 方法口径：GET /vector/action ⇒ 405、POST /vector/state ⇒ 405',
      (await call('/vector/action')).status === 405 && (await call('/vector/state', 'POST', {})).status === 405)
  } finally {
    await new Promise((r) => server.close(r))
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
  }
}

// ---------------------------------------------------------------------------
// H) 删除的**纯计划**（§3 的 1、2）—— ⛔ 一次都不碰文件系统
// ---------------------------------------------------------------------------
console.log('\n── H) planDelete 纯计划（不碰盘） ──')
const H_VROOT = join(tmpRoot, 'h-vectors')
const H_BROOT = join(tmpRoot, 'h-bm25')
const H_STAMP_NOW = Date.UTC(2026, 8, 22, 10, 30, 0)   // 固定时刻 ⇒ dest 里的时间戳可逐字断言
const H_STAMP = '2026-09-22T10-30-00'
{
  const pv = mod.planDelete({
    action: 'delete-vector', dataRoots: { vectorRoot: H_VROOT, bm25Root: H_BROOT }, collectionId: 'dsh-memory',
    summaryFiles: ['s-1.md'], ledgerEntries: { 's-1.md': {} }, now: H_STAMP_NOW,
  })
  check('H1 相｜向量删除：目标 = <vectorRoot>/<集合名>', pv.ok === true && pv.target === join(H_VROOT, 'dsh-memory'), pv.target)
  check('H1b 相｜dest = 目标 + .removed-<时间戳>（与 anima 的 stamp 口径逐字同款）',
    pv.dest === pv.target + '.removed-' + H_STAMP, pv.dest)
  check('H1c 集合名归一就是 anima 那条正则（非法字符换 _，中文留着）',
    mod.safeCollectionName('dsh memory/v2') === 'dsh_memory_v2' && mod.safeCollectionName('dsh-memory') === 'dsh-memory'
    && mod.safeCollectionName('中文名·x') === '中文名_x')
  // ★ 纯的证明：磁盘上先摆一个**真的**库目录，调一次 planDelete 之后它必须原封不动
  mkdirSync(join(H_VROOT, 'dsh-memory'), { recursive: true })
  writeFileSync(join(H_VROOT, 'dsh-memory', 'index.json'), '{"items":[]}', 'utf8')
  mod.planDelete({ action: 'delete-vector', dataRoots: { vectorRoot: H_VROOT }, collectionId: 'dsh-memory', summaryFiles: [], ledgerEntries: {}, now: H_STAMP_NOW })
  check('H1d ★ 纯计划：planDelete 不改文件系统（库目录还在原名下、一个 .removed-* 都没冒出来）',
    existsSync(join(H_VROOT, 'dsh-memory')) && readdirSync(H_VROOT).filter((n) => n.includes('.removed-')).length === 0,
    readdirSync(H_VROOT).join('、'))

  // 相：BM25 是**一个文件**（<bm25Root>/<safe>.json），⛔ 不是目录 —— 两者的落点不许写反
  const pb = mod.planDelete({
    action: 'delete-bm25', dataRoots: { vectorRoot: H_VROOT, bm25Root: H_BROOT }, collectionId: 'dsh-memory',
    summaryFiles: [], ledgerEntries: {}, now: H_STAMP_NOW,
  })
  check('H2 相｜BM25 删除：目标 = <bm25Root>/<集合名>.json（⛔ 不是目录）',
    pb.ok === true && pb.target === join(H_BROOT, 'dsh-memory.json') && pb.target.endsWith('.json'), pb.target)
  check('H2b 相｜两个动作的落点形状确实不同（不是把同一套拼法用两次）',
    pv.target !== pb.target && !pv.target.endsWith('.json') && pb.target.endsWith('.json'))
  // ★ 反证（源级）：把"向量=目录 / BM25=.json"那两个分支写反 ⇒ 判据必须红
  sensitive(
    'H2c 落点分支照 anima 那条写（delete-vector ⇒ 目录；delete-bm25 ⇒ `${safe}.json`）',
    (s) => s.includes("const target = action === 'delete-vector' ? join(root, safe) : join(root, `${safe}.json`)"),
    '? join(root, safe) : join(root, `${safe}.json`)',
    panelSrc,
  )

  // 反证（纯函数级）：快照里没有落点 ⇒ 拒绝出计划（⛔ 不许猜一个路径出来）
  const noRoot = mod.planDelete({ action: 'delete-vector', dataRoots: { vectorRoot: '', bm25Root: H_BROOT }, collectionId: 'dsh-memory', now: H_STAMP_NOW })
  check('H3 ⛔ 快照里没有 vectorRoot ⇒ 不出计划（reason 说明缺什么），⛔ 不猜路径',
    noRoot.ok === false && String(noRoot.reason).includes('vectorRoot'), JSON.stringify(noRoot))
  const noId = mod.planDelete({ action: 'delete-bm25', dataRoots: { bm25Root: H_BROOT }, collectionId: '', now: H_STAMP_NOW })
  check('H3b ⛔ 快照里没有集合名 ⇒ 不出计划', noId.ok === false && String(noId.reason).includes('集合名'))
  check('H3c ⛔ 不是删除动作 ⇒ 不出计划（⛔ 入库/重建绝不该走到这条路上）',
    mod.planDelete({ action: 'rebuild', dataRoots: { vectorRoot: H_VROOT }, collectionId: 'c' }).ok === false)
  // ⛔ 名单只收纯文件名：带分隔符/`..` 的一律丢（那种名字永远不可能是账本的键）
  const dirty = mod.planDelete({
    action: 'delete-vector', dataRoots: { vectorRoot: H_VROOT }, collectionId: 'c',
    summaryFiles: ['ok.md', 'ok.md', '', '../escape.md', 'a\\b.md', 'C:/x.md', 42, null],
    ledgerEntries: { 'ok.md': {}, '../escape.md': {}, 'a\\b.md': {} }, now: H_STAMP_NOW,
  })
  check('H3d ⛔ 名单只留纯文件名（去重 + 丢掉带斜杠/`..`/非字符串的），forgetCount 只数真命中的',
    JSON.stringify(dirty.forgetFiles) === JSON.stringify(['ok.md']) && dirty.forgetCount === 1, JSON.stringify(dirty.forgetFiles))
}

// ---------------------------------------------------------------------------
// I) 删除：**当场执行**（§3 的 3、4、5、6）—— 假 home + 假数据根，⛔ 不碰真机
// ---------------------------------------------------------------------------
console.log('\n── I) deleteNow 当场执行（改名留档 + 忘账本 + 回执） ──')

/** 造一个假 home（`dsh-anima-rag/` 三张文件 + 数据根 + 那个周目的 summaries/index.json）。 */
function makeHome(name, { vectorExists = true, bm25Exists = true, summaryFiles = [], ledgerEntries = {}, infoAt = 1000 } = {}) {
  const home = join(tmpRoot, name)
  const anima = join(home, 'dsh-anima-rag')
  const vroot = join(home, 'vectors')
  const broot = join(home, 'bm25')
  const ws = join(home, 'ws', 'char-a', 'playthrough-a', 'archive', 'summaries')
  mkdirSync(anima, { recursive: true })
  mkdirSync(broot, { recursive: true })
  mkdirSync(ws, { recursive: true })
  if (vectorExists) {
    mkdirSync(join(vroot, 'dsh-memory'), { recursive: true })
    writeFileSync(join(vroot, 'dsh-memory', 'index.json'), JSON.stringify({ version: 1, items: [{ metadata: { index: 'sum_s-0001-0010-1.md' } }] }), 'utf8')
    writeFileSync(join(vroot, 'dsh-memory', 'u-1.json'), '{"text":"原始正文"}', 'utf8')
  } else {
    mkdirSync(vroot, { recursive: true })
  }
  if (bm25Exists) writeFileSync(join(broot, 'dsh-memory.json'), 'bm25-bytes', 'utf8')
  writeFileSync(join(anima, 'vector-info.json'), JSON.stringify({
    version: 1, at: infoAt,
    dataRoots: { vectorRoot: vroot, bm25Root: broot, sessionRoot: join(home, 'sessions') },
    collectionId: 'dsh-memory',
    isolation: { enabled: true, bound: 'playthrough-a', boundSource: 'session', total: 1, boundCount: 1, deniedCount: 0 },
    vector: { exists: vectorExists, count: vectorExists ? 1 : 0, mtime: 1 },
    bm25: { exists: bm25Exists, bytes: 10, mtime: 1 },
    ledger: { entries: Object.keys(ledgerEntries).length, updatedAt: 'x' },
  }), 'utf8')
  writeFileSync(join(anima, 'ingest-ledger.json'), JSON.stringify({ version: 1, updatedAt: '2026-01-01T00:00:00.000Z', entries: ledgerEntries }), 'utf8')
  writeFileSync(join(ws, 'index.json'), JSON.stringify({ version: 1, entries: summaryFiles.map((file) => ({ file })) }), 'utf8')
  return { home, anima, vroot, broot, ws }
}

// I1 相｜目标在 ⇒ 改名留档（⛔ 绝不真删）+ 忘账本只忘本周目的 + 回执落盘 + 快照一个字节都不动
{
  const h = makeHome('del-home-1', {
    summaryFiles: ['s-0001-0010-1.md', 's-0011-0020-1.md'],
    ledgerEntries: {
      's-0001-0010-1.md': { sig: 'a|1', at: 1 },
      's-0011-0020-1.md': { sig: 'b|2', at: 2 },
      's-9000-9010-9.md': { sig: 'c|3', at: 3 },     // ← 别的周目的（⛔ 一条都不许动）
      'import-batch-1.json': { sig: 'd|4', at: 4 },  // ← 导入清单（也不是摘要）
    },
  })
  const infoBefore = readFileSync(join(h.anima, 'vector-info.json'), 'utf8')
  const bodyBefore = readFileSync(join(h.vroot, 'dsh-memory', 'u-1.json'), 'utf8')
  const out = mod.deleteNow({ homeDir: h.home, action: 'delete-vector', summariesDir: h.ws, now: H_STAMP_NOW })
  check('I1 deleteNow ⇒ ok/deleted + 回执（ok:true）', out.ok === true && out.deleted === true && out.receipt.ok === true, JSON.stringify(out.receipt || out))
  check('I1b 回执键集合**逐字同构** anima 那份（version/id/action/ok/message/counts/at，一个不多一个不少）',
    JSON.stringify(Object.keys(out.receipt).sort()) === JSON.stringify(['action', 'at', 'counts', 'id', 'message', 'ok', 'version']),
    JSON.stringify(Object.keys(out.receipt)))
  check('I1c 文案照 anima 那两句（已归档为 <归档名>（没删）… 忘掉账本 2 条 ⇒ 下次入库会重新长出来）',
    out.receipt.message === `已归档为 dsh-memory.removed-${H_STAMP}（没删），并忘掉账本 2 条 ⇒ 下次入库会重新长出来`,
    out.receipt.message)
  check('I1d counts.forgotten = 2（只数本周目真命中的那两条）', out.receipt.counts?.forgotten === 2, JSON.stringify(out.receipt.counts))
  // ★★ 铁律：改名留档 —— 原名下没了，但**内容还在**（.removed-<时间戳> 里读得回原样）
  check('I2 ⛔ 绝不真删：目标已不在原名下，但 `.removed-<时间戳>` 里躺着（改名留档）',
    !existsSync(join(h.vroot, 'dsh-memory')) && existsSync(join(h.vroot, `dsh-memory.removed-${H_STAMP}`)))
  check('I2b ★ 归档里的正文一个字节都没变（读得回原来那份）',
    readFileSync(join(h.vroot, `dsh-memory.removed-${H_STAMP}`, 'u-1.json'), 'utf8') === bodyBefore
    && readFileSync(join(h.vroot, `dsh-memory.removed-${H_STAMP}`, 'index.json'), 'utf8').includes('sum_s-0001-0010-1.md'))
  // ★ 账本：只忘本周目的那两条（别的周目 + 导入清单一条不少）
  const led = JSON.parse(readFileSync(join(h.anima, 'ingest-ledger.json'), 'utf8'))
  check('I3 ★ 账本只忘本会话周目的那两条', !('s-0001-0010-1.md' in led.entries) && !('s-0011-0020-1.md' in led.entries))
  check('I3b ⛔ 别的周目的条目一条不少（宁可不错忘）+ 导入清单也在',
    led.entries['s-9000-9010-9.md']?.sig === 'c|3' && led.entries['import-batch-1.json']?.sig === 'd|4',
    JSON.stringify(Object.keys(led.entries)))
  check('I3c 账本形状照 anima save()（version/updatedAt/entries，updatedAt 刷新了）',
    led.version === 1 && typeof led.updatedAt === 'string' && led.updatedAt !== '2026-01-01T00:00:00.000Z')
  // 回执落盘（面板「最近一次动作」读它）
  const receiptOnDisk = JSON.parse(readFileSync(join(h.anima, 'panel-result.json'), 'utf8'))
  check('I4 回执写进 panel-result.json（与返回的那份同构）', JSON.stringify(receiptOnDisk) === JSON.stringify(out.receipt))
  // ★★ "删完不许有两个真相"：宿主**绝不写** anima 的快照
  check('I5 ⛔ 宿主绝不写 vector-info.json（快照是 anima 的；写它就是两份真相）',
    readFileSync(join(h.anima, 'vector-info.json'), 'utf8') === infoBefore)
  // 快照过期这件事必须被**判出来**（面板据此如实标过期，⛔ 不拿旧条数骗人）
  const st = mod.readVectorState({ homeDir: h.home })
  check('I5b readVectorState.deletedAfterInfo=true（回执是删除且比快照新 ⇒ 面板标过期）', st.deletedAfterInfo === true)
  check('I5c ★反证：把快照的 at 改到回执之后（anima 追上来了）⇒ deletedAfterInfo 必须为 false',
    (() => {
      const p = join(h.anima, 'vector-info.json')
      const doc = JSON.parse(readFileSync(p, 'utf8'))
      writeFileSync(p, JSON.stringify(Object.assign({}, doc, { at: H_STAMP_NOW + 60000 })), 'utf8')
      const st2 = mod.readVectorState({ homeDir: h.home })
      writeFileSync(p, infoBefore, 'utf8')
      return st2.deletedAfterInfo === false
    })())
}

// I6 反证｜目标不存在 ⇒ 照 anima 老口径「本来就不存在」+ **仍要忘账本** + ⛔ 不许报失败
{
  const h = makeHome('del-home-2', {
    vectorExists: false,
    summaryFiles: ['s-0001-0010-1.md', 's-0011-0020-1.md'],
    ledgerEntries: { 's-0001-0010-1.md': { sig: 'a|1', at: 1 }, 's-0011-0020-1.md': { sig: 'b|2', at: 2 }, 's-9000-9010-9.md': { sig: 'c|3', at: 3 } },
  })
  const out = mod.deleteNow({ homeDir: h.home, action: 'delete-vector', summariesDir: h.ws, now: H_STAMP_NOW })
  check('I6 目标不存在 ⇒ ok:true（⛔ 不报失败）+ 文案是「本来就不存在（顺手忘掉账本 2 条）」',
    out.ok === true && out.deleted === true && out.receipt.ok === true
    && out.receipt.message === '本来就不存在（顺手忘掉账本 2 条）', out.receipt.message)
  const led = JSON.parse(readFileSync(join(h.anima, 'ingest-ledger.json'), 'utf8'))
  check('I6b ★ 不在也**照样忘账本**（否则下次入库会以 all-done 跳过，删掉的东西永远回不来）',
    !('s-0001-0010-1.md' in led.entries) && !('s-0011-0020-1.md' in led.entries) && led.entries['s-9000-9010-9.md'] !== undefined)
  check('I6c 一个 .removed-* 都没冒出来（本来就没东西可归档）',
    readdirSync(h.vroot).filter((n) => n.includes('.removed-')).length === 0)
}

// I7 相｜账本只忘本周目的 + 反证｜"清单为空就 clear()"那种写法必须红
{
  const others = { 's-8000-8010-8.md': { sig: 'z|1', at: 1 }, 's-9000-9010-9.md': { sig: 'z|2', at: 2 } }
  const h = makeHome('del-home-3', { summaryFiles: [], ledgerEntries: Object.assign({ 's-0001-0010-1.md': { sig: 'a|1', at: 1 } }, others) })
  const ledBefore = readFileSync(join(h.anima, 'ingest-ledger.json'), 'utf8')
  const out = mod.deleteNow({ homeDir: h.home, action: 'delete-bm25', summariesDir: h.ws, now: H_STAMP_NOW })
  check('I7 这个周目没有摘要（清单为空）⇒ 文案说「忘掉账本 0 条」（⛔ 不编一个数）',
    out.receipt.message === `已归档为 dsh-memory.json.removed-${H_STAMP}（没删），并忘掉账本 0 条 ⇒ 下次入库会重新长出来`,
    out.receipt.message)
  check('I7b BM25 落点是一个**文件**：原文件没了、`.json.removed-<时间戳>` 在',
    !existsSync(join(h.broot, 'dsh-memory.json')) && existsSync(join(h.broot, `dsh-memory.json.removed-${H_STAMP}`)))
  // ★ 关键：清单为空时**一条都不许忘**（别的周目一条不少）—— 这条是 anima 2026-09-20 真机踩过的坑
  const keepOthers = (entriesObj) => JSON.stringify(Object.keys(entriesObj).sort())
  const after = JSON.parse(readFileSync(join(h.anima, 'ingest-ledger.json'), 'utf8'))
  check('I7c ★ 清单为空 ⇒ 账本一个字节都没动（别的周目一条不少）',
    readFileSync(join(h.anima, 'ingest-ledger.json'), 'utf8') === ledBefore && keepOthers(after.entries) === keepOthers(Object.assign({ 's-0001-0010-1.md': 1 }, others)),
    JSON.stringify(Object.keys(after.entries)))
  // ★反证：那种"清单为空就整本清掉"的写法（anima 早先那版）⇒ 上面那条判据必红
  const buggyClear = () => ({})   // 模拟 `if (names.length === 0) entries.clear()`
  check('I7c ★反证（"清单为空就 clear()"那种写法 ⇒ 整本被清掉 ⇒ 判据必红）',
    keepOthers(buggyClear()) !== keepOthers(Object.assign({ 's-0001-0010-1.md': 1 }, others)))
}

// I8 反证｜摘要清单读不到 / 没说是哪个周目 ⇒ 一条都不忘 + 如实播报（⛔ 不静默、不猜）
{
  const h = makeHome('del-home-4', {
    summaryFiles: ['s-0001-0010-1.md'],
    ledgerEntries: { 's-0001-0010-1.md': { sig: 'a|1', at: 1 }, 's-9000-9010-9.md': { sig: 'c|3', at: 3 } },
  })
  const out = mod.deleteNow({ homeDir: h.home, action: 'delete-vector', summariesDir: '', now: H_STAMP_NOW })
  check('I8 没说是哪个周目 ⇒ 删除照做（归档成功），但**一条账本都没忘**',
    out.ok === true && out.receipt.counts.forgotten === 0 && out.receipt.message.includes('忘掉账本 0 条'))
  check('I8b ★ 如实播报为什么没忘（"没忘账本："那句必须出现）', out.receipt.message.includes('没忘账本：'), out.receipt.message)
  check('I8c 账本里那两条原封不动（⛔ 宁可不错忘别的周目）',
    JSON.parse(readFileSync(join(h.anima, 'ingest-ledger.json'), 'utf8')).entries['s-0001-0010-1.md'] !== undefined)
  // 清单文件读不到（目录给了但没有 index.json）⇒ 同样"一条都不忘 + 如实播报"
  const h2 = makeHome('del-home-5', { summaryFiles: ['s-0001-0010-1.md'], ledgerEntries: { 's-0001-0010-1.md': { sig: 'a|1', at: 1 } } })
  rmSync(join(h2.ws, 'index.json'), { force: true })
  const out2 = mod.deleteNow({ homeDir: h2.home, action: 'delete-vector', summariesDir: h2.ws, now: H_STAMP_NOW })
  check('I8d summaries/index.json 读不到 ⇒ 一条都不忘 + 播报里带原因（含 index.json）',
    out2.receipt.counts.forgotten === 0 && out2.receipt.message.includes('index.json') && out2.receipt.message.includes('没忘账本：'),
    out2.receipt.message)
}

// I9 回执同构（§3 的 6）：从 **anima 源码**里抄键名比对（⛔ 不 import 它）
{
  const animaRoot = process.env.DMA_ANIMA_ROOT || join(repo, '..', 'dsh-anima-rag')
  const animaFile = join(animaRoot, 'lib', 'panel-request.js')
  if (!existsSync(animaFile)) {
    console.log(`SKIP I9 anima 侧 panel-request.js 不在（${animaRoot}）—— 回执同构这一步没跑`)
  } else {
    const aSrc = readFileSync(animaFile, 'utf8')
    const body = (aSrc.match(/export function makePanelResult\([\s\S]*?\n\}/) || [''])[0]
    // 只取 **return 那个对象字面量**的键（形参表里的 id/action/ok… 不算 —— 它们本来就要有）
    const ret = body.slice(body.indexOf('return {'))
    const keysFromAnima = (ret.match(/(\w+)\s*[:,]/g) || []).map((x) => x.replace(/[\s:,]/g, ''))
    const want = keysFromAnima.filter((k) => ['version', 'id', 'action', 'ok', 'message', 'counts', 'at'].includes(k))
    const mine = Object.keys(mod.makeResult({ id: 'i', action: 'delete-vector', ok: true, message: 'm', counts: { forgotten: 1 } }))
    check('I9 ★ 回执键集合与 anima 的 makePanelResult 逐字一致（从它源码里抄的键名，⛔ 没 import）',
      want.length > 0 && JSON.stringify(want) === JSON.stringify(mine), `anima=${JSON.stringify(want)} 本仓=${JSON.stringify(mine)}`)
    check('I9b ★反证（本仓若漏一个键 —— 比如 counts —— 就与 anima 不一致）',
      JSON.stringify(want) !== JSON.stringify(mine.filter((k) => k !== 'counts')))
    check('I9c 版本号也是 1（anima 那份写的是 version: 1）', mod.makeResult({ id: 'i', action: 'x', ok: false, message: '' }).version === 1)
  }
  // 删除的文案也要与 anima 源码里那两句同款（抄的是它的措辞，⛔ 不 import）
  const animaIdx = join(process.env.DMA_ANIMA_ROOT || join(repo, '..', 'dsh-anima-rag'), 'lib', 'index.js')
  if (existsSync(animaIdx)) {
    const src = readFileSync(animaIdx, 'utf8')
    check('I9d 文案与 anima executePanelAction 里那两句同款（本来就不存在 / 已归档为…（没删））',
      src.includes('本来就不存在（顺手忘掉账本 ${forgotten0} 条）')
      && src.includes('（没删），并忘掉账本 ${forgotten} 条 ⇒ 下次入库会重新长出来')
      && src.includes("const dest = `${target}.removed-${stamp}`")
      && src.includes("new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)"))
  }
}

// ---------------------------------------------------------------------------
// J) 端点真跑：删除**当次回执** + 旧请求单被消费（§3 的 7、8）
// ---------------------------------------------------------------------------
console.log('\n── J) POST /vector/action{delete-*} 真跑（当次回执 / 消费旧单子） ──')
{
  const { createServer } = await import('node:http')
  const JH = join(tmpRoot, 'j-home')
  const JANIMA = join(JH, 'dsh-anima-rag')
  const JV = join(JH, 'vectors')
  const JB = join(JH, 'bm25')
  const JWS = join(JH, 'ws')
  const JSUM = join(JWS, 'char-a', 'playthrough-a', 'archive', 'summaries')
  mkdirSync(JANIMA, { recursive: true })
  mkdirSync(join(JV, 'dsh-memory'), { recursive: true })
  mkdirSync(JB, { recursive: true })
  mkdirSync(JSUM, { recursive: true })
  mkdirSync(join(JH, 'pmp-dsh-tavern'), { recursive: true })
  writeFileSync(join(JV, 'dsh-memory', 'index.json'), '{"items":[]}', 'utf8')
  writeFileSync(join(JB, 'dsh-memory.json'), 'bm25', 'utf8')
  writeFileSync(join(JANIMA, 'vector-info.json'), JSON.stringify({
    version: 1, at: 1000,
    dataRoots: { vectorRoot: JV, bm25Root: JB, sessionRoot: join(JH, 'sessions') },
    collectionId: 'dsh-memory',
    isolation: { enabled: true, bound: 'playthrough-a', boundSource: 'session', total: 0, boundCount: 0, deniedCount: 0 },
    vector: { exists: true, count: 0, mtime: 1 }, bm25: { exists: true, bytes: 4, mtime: 1 },
    ledger: { entries: 3, updatedAt: 'x' },
  }), 'utf8')
  writeFileSync(join(JANIMA, 'ingest-ledger.json'), JSON.stringify({
    version: 1, updatedAt: '2026-01-01T00:00:00.000Z',
    entries: { 's-0001-0010-1.md': { sig: 'a|1', at: 1 }, 's-0011-0020-1.md': { sig: 'b|2', at: 2 }, 's-9000-9010-9.md': { sig: 'c|3', at: 3 } },
  }), 'utf8')
  writeFileSync(join(JSUM, 'index.json'), JSON.stringify({ version: 1, entries: [{ file: 's-0001-0010-1.md' }, { file: 's-0011-0020-1.md' }] }), 'utf8')
  // 宿主解"哪个周目的 summaries 目录"走的是既有的两条知识：工作区根 + catalog.json
  writeFileSync(join(JH, 'pmp-dsh-tavern', 'play-workspace.json'), JSON.stringify({ rootPath: JWS }), 'utf8')
  writeFileSync(join(JWS, 'catalog.json'), JSON.stringify({
    playthroughs: [{ id: 'playthrough-a', path: 'char-a/playthrough-a/timeline.json', ext: { pmpDshTavern: { characterId: 'char-a', rootSessionId: 'sess-root' } } }],
  }), 'utf8')
  const jInfoBefore = readFileSync(join(JANIMA, 'vector-info.json'), 'utf8')

  const before = process.env.DSH_HOME
  process.env.DSH_HOME = JH
  const { apply } = await import('./lib/index.js')
  const routes = []
  const webServer = { register: (r) => { routes.push(r); return () => {} } }
  const ctx = { effect: (f) => f(), inject: (_n, cb) => cb(ctx), get: (n) => (n === 'webServer' ? webServer : undefined), webServer }
  apply(ctx)
  const PREFIX = '/dsh-memory-archive/api'
  const route = routes.find((r) => r.path === PREFIX)
  const server = createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname
    if (p === PREFIX || p.startsWith(PREFIX + '/')) return route.handler(req, res)
    res.writeHead(404); res.end('{}')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}${PREFIX}`
  const call = async (path, method = 'GET', payload) => {
    const res = await fetch(base + path, {
      method,
      headers: payload === undefined ? {} : { 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    })
    const text = await res.text()
    return { status: res.status, text, json: (() => { try { return JSON.parse(text) } catch { return null } })() }
  }
  try {
    // J1 ★ 删除**当次**就回执（§3 的 7）：⛔ 不再 queued、⛔ 不写请求单
    const d1 = await call('/vector/action', 'POST', { action: 'delete-vector', playthroughId: 'playthrough-a' })
    check('J1 POST delete-vector ⇒ 200 ok:true + deleted:true + 回执当次回来（message/counts/at 齐）',
      d1.status === 200 && d1.json?.ok === true && d1.json?.deleted === true
      && String(d1.json?.message || '').includes('已归档为') && d1.json?.counts?.forgotten === 2 && Number.isFinite(d1.json?.at),
      d1.text.slice(0, 240))
    check('J1b ⛔ 响应里**没有** queued（点了就删，不再"排队等下一轮"）',
      !('queued' in (d1.json || {})) && !d1.text.includes('queued'), d1.text.slice(0, 200))
    check('J1c ⛔ 这次动作**没有**写 panel-request.json（删除不走请求单那条路）',
      !existsSync(join(JANIMA, 'panel-request.json')))
    check('J1d 磁盘上真改名了：<集合> 没了、`.removed-<时间戳>` 在',
      !existsSync(join(JV, 'dsh-memory')) && readdirSync(JV).some((n) => n.startsWith('dsh-memory.removed-')))
    check('J1e 账本只少本周目那两条（别的周目仍在）', (() => {
      const led = JSON.parse(readFileSync(join(JANIMA, 'ingest-ledger.json'), 'utf8'))
      return !('s-0001-0010-1.md' in led.entries) && !('s-0011-0020-1.md' in led.entries) && led.entries['s-9000-9010-9.md'] !== undefined
    })())
    check('J1f ⛔ 宿主没写快照（vector-info.json 一个字节都没变）', readFileSync(join(JANIMA, 'vector-info.json'), 'utf8') === jInfoBefore)
    const st1 = await call('/vector/state')
    check('J1g GET /vector/state 如实标"快照是删之前的"（deletedAfterInfo:true）+ 现算的库已不在',
      st1.json?.deletedAfterInfo === true && st1.json?.live?.vector?.exists === false, st1.text.slice(0, 200))

    // J2 ★ 旧请求单：**别的动作**的一张都不许动（§3 的 8 的反面）
    const otherReq = JSON.stringify({ version: 1, id: 'old-rebuild', action: 'rebuild', note: '', at: 1 })
    writeFileSync(join(JANIMA, 'panel-request.json'), otherReq, 'utf8')
    const d2 = await call('/vector/action', 'POST', { action: 'delete-bm25', playthroughId: 'playthrough-a' })
    check('J2 删 BM25（同名请求单是 rebuild）⇒ 那张单子**原封不动**（⛔ 别的动作一根汗毛都不动）',
      d2.json?.deleted === true && existsSync(join(JANIMA, 'panel-request.json'))
      && readFileSync(join(JANIMA, 'panel-request.json'), 'utf8') === otherReq)
    check('J2b BM25 那次也真归档了（文件级落点）',
      !existsSync(join(JB, 'dsh-memory.json')) && readdirSync(JB).some((n) => n.startsWith('dsh-memory.json.removed-')))

    // J3 ★★ 同名旧请求单被消费（§3 的 8）：否则 anima 下一脚会照它再删一次
    const sameReq = JSON.stringify({ version: 1, id: 'old-del', action: 'delete-vector', note: '', at: 1 })
    writeFileSync(join(JANIMA, 'panel-request.json'), sameReq, 'utf8')
    const d3 = await call('/vector/action', 'POST', { action: 'delete-vector', playthroughId: 'playthrough-a' })
    check('J3 ★ 同名（delete-vector）旧请求单被消费掉（文件不在了）', d3.json?.deleted === true && !existsSync(join(JANIMA, 'panel-request.json')))
    check('J3b 这次目标本来就不存在 ⇒ 文案是「本来就不存在」（⛔ 不报失败、照样是 ok）',
      d3.status === 200 && d3.json?.ok === true && String(d3.json?.message || '').startsWith('本来就不存在'), d3.text.slice(0, 200))

    // J4 快照读不到 ⇒ 可读错误、**一个字节都没动**（⛔ 不许猜路径）
    const jInfoSaved = readFileSync(join(JANIMA, 'vector-info.json'), 'utf8')
    rmSync(join(JANIMA, 'vector-info.json'), { force: true })
    const d4 = await call('/vector/action', 'POST', { action: 'delete-vector', playthroughId: 'playthrough-a' })
    check('J4 快照读不到 ⇒ 可读错误（VECTOR_INFO_UNAVAILABLE），⛔ 不当成功、⛔ 不猜路径',
      d4.status === 200 && d4.json?.ok === false && d4.json?.error?.code === 'VECTOR_INFO_UNAVAILABLE'
      && readdirSync(JV).filter((n) => n.includes('.removed-')).length === 1, d4.text.slice(0, 240))
    writeFileSync(join(JANIMA, 'vector-info.json'), jInfoSaved, 'utf8')

    // J5 排队那条路一个字没变（入库/重建照旧走请求单 + queued）
    const d5 = await call('/vector/action', 'POST', { action: 'ingest-now' })
    check('J5 「立即入库」照旧排队（queued:true + 请求单落盘）—— 只有删除改了判',
      d5.json?.queued === true && existsSync(join(JANIMA, 'panel-request.json'))
      && JSON.parse(readFileSync(join(JANIMA, 'panel-request.json'), 'utf8')).action === 'ingest-now')
  } finally {
    await new Promise((r) => server.close(r))
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
  }
}

// ---------------------------------------------------------------------------
rmSync(tmpRoot, { recursive: true, force: true })
console.log(`\n── ${pass} 通过 / ${fails.length} 失败 ──`)
if (fails.length > 0) console.log('失败：' + fails.join('、'))
process.exitCode = fails.length === 0 ? 0 : 1
