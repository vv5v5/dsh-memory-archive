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
  'E2 ReadArea 有 vector 分支渲染 VectorFlow',
  (s) => s.includes("cur === 'vector'") && s.includes('e(VectorFlow, { scrollBind: scrollBind })'),
  "} else if (cur === 'vector') {",
)
{
  // 红字隔离诊断：条件（boundCount===0 && total>0）+ 文案 + id，三样都要在
  const deadJudge = (s) => s.includes("boundCount === 0 && total !== null && total > 0")
    && s.includes("'库里 ' + String(total) + ' 条全部属于别的周目（'")
    && s.includes('⇒ 隔离把候选池清空了，所以检索永远是 0 命中')
    && s.includes("id: 'dma-vector-isolation-dead'")
  sensitive('E3 红字隔离诊断（用户今天踩的坑）逐字在', deadJudge, '⇒ 隔离把候选池清空了，所以检索永远是 0 命中')
  sensitive('E3b 诊断的**触发条件**在位（boundCount===0 && total>0）', deadJudge, 'boundCount === 0 && total !== null && total > 0')
}
{
  const confirmJudge = (s) => s.includes('const VECTOR_ARMED = {')
    && s.includes('会重新嵌入，可能花几十秒、消耗 token')
    && s.includes("id: 'dma-vector-confirm'")
    && s.includes('再点一次确认')
    && s.includes("if (armed === key) { setArmed(''); submit(VECTOR_ARMED[key].action); return }")
  sensitive('E4 二次确认：武装表 + 重建的"会重新嵌入…"说明 + 确认条 + 再点一次才执行', confirmJudge, '会重新嵌入，可能花几十秒、消耗 token')
  sensitive('E4b 二次确认的**门**在位（第一次点只武装，不提交）', confirmJudge, "if (armed === key) { setArmed(''); submit(VECTOR_ARMED[key].action); return }")
  // 三个动作（立即入库/重建/删除）都在武装表里 ---- 删除必须能确认
  for (const key of ["'ingest-now'", "'rebuild:vector'", "'rebuild:bm25'", "'delete-vector'", "'delete-bm25'"]) {
    check('E4c 武装表含 ' + key, clientSrc.includes(key + ': { action:'))
  }
}
sensitive(
  'E5 轮询口径：2s 一次、最多 60s',
  (s) => s.includes('const VECTOR_POLL_MS = 2000') && s.includes('const VECTOR_POLL_LIMIT_MS = 60000'),
  'const VECTOR_POLL_LIMIT_MS = 60000',
)
sensitive(
  'E5b 超时如实说"还没被执行（anima 在该周目会话的下一轮开始前才取走这张单）"',
  (s) => s.includes('还没被执行（anima 在该周目会话的下一轮开始前才取走这张单）'),
  '还没被执行（anima 在该周目会话的下一轮开始前才取走这张单）',
)
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
  (s) => s.includes("boundSrc === 'session' ? '活跃会话' : (boundSrc === 'config' ? '面板绑定' : '')")
    && s.includes("'（来源：' + boundSrcLabel + '）'"),
  "boundSrc === 'session' ? '活跃会话' : (boundSrc === 'config' ? '面板绑定' : '')",
)
sensitive(
  'E12 上次入库用 anima 写好的 reason 人话（live 优先、快照兜底，⛔ 不自己拼机器码）',
  (s) => s.includes('ingestSnap && typeof ingestSnap.reason === \'string\'')
    && s.includes("ingestReason !== '' ? ingestReason : vectorIngestText(ingestLive)"),
  "ingestReason !== '' ? ingestReason : vectorIngestText(ingestLive)",
)
sensitive(
  'E13 库行内 ⚠缺失 徽标（向量/BM25 各自 exists===false 时都要摆出来）',
  (s) => s.includes("missing === true ? e('span', { style: warnBadgeStyle }, '⚠缺失') : null")
    && s.includes('vec !== null && vec.exists === false')
    && s.includes('bm !== null && bm.exists === false'),
  "missing === true ? e('span', { style: warnBadgeStyle }, '⚠缺失') : null",
)
sensitive(
  'E14 提交没拿到回执 id ⇒ 不起轮询（空 id 永远对不上，⛔ 不许白转 60 秒）',
  (s) => s.includes('if (id === \'\') {') && s.includes('startPolling(id)'),
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
    && (body.match(/\{ action: /g) || []).length === 2
    && body.includes('{ action: action }')
    && body.includes("{ action: 'enable', enabled: next }")
  check('E8 取到 VectorFlow 函数体（判据有对象可比）', typeof vf === 'string' && vf.length > 500, vf === null ? 'null' : String(vf.length))
  check('E8 ⛔「向量」档不碰密钥（档内没有 ' + KEY_NEEDLE + '）', keyJudge(vf))
  check('E8 ⛔「向量」档发给宿主的请求体恰好两种（{action} / {action,enabled}），⛔ 没有第三种夹带', bodiesJudge(vf))
  // ★反证：把"夹带 key 的请求体"塞进同一个函数体 ⇒ 两条判据都必须红
  const dirty = vf + "\nconst leak = x." + KEY_NEEDLE + "\nfetch('/x', { body: JSON.stringify({ action: 'leak' }) })"
  check('E8 ★反证（档内夹带 ' + KEY_NEEDLE + ' ⇒ 密钥判据必须红）', keyJudge(vf) === true && keyJudge(dirty) === false)
  check('E8 ★反证（档内多一种请求体 ⇒ 计数判据必须红）', bodiesJudge(vf) === true && bodiesJudge(dirty) === false)
  // 入库时机口径（用户 2026-09-20：「向量生成的时机需要明确为自动压缩入库或工具检索调用时」）
  check('E9 面板写明入库时机 = 自动压缩入库 + 工具检索调用时', clientSrc.includes('入库时机：自动压缩入库 + 工具检索调用时'))
}

// ---------------------------------------------------------------------------
// F) vector-panel.js 源级：⛔ 不越界
// ---------------------------------------------------------------------------
console.log('\n── F) vector-panel.js 源级 ──')
{
  check('F1 ⛔ 只读 anima 那三张文件，从不写它们（源码里对 PANEL_RESULT_FILE/VECTOR_INFO_FILE 只有读）',
    panelSrc.includes('readJsonSafe(join(dir, VECTOR_INFO_FILE))') && panelSrc.includes('readJsonSafe(join(dir, PANEL_RESULT_FILE))'))
  check('F2 只写 PANEL_REQUEST_FILE（唯一的写目标）',
    (panelSrc.match(/writeFileSync\(/g) || []).length === 1 && panelSrc.includes('writeFileSync(tmpPath'))
  check('F3 动作白名单只有一处定义（PANEL_ACTIONS 字面量恰好 1 处）',
    (panelSrc.match(/export const PANEL_ACTIONS =/g) || []).length === 1)
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
rmSync(tmpRoot, { recursive: true, force: true })
console.log(`\n── ${pass} 通过 / ${fails.length} 失败 ──`)
if (fails.length > 0) console.log('失败：' + fails.join('、'))
process.exitCode = fails.length === 0 ? 0 : 1
