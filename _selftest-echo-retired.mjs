#!/usr/bin/env node
/**
 * _selftest-echo-retired.mjs —— 「fts5/BM25 摘干净」＋「退役要如实体检」的自检（T3，2026-09-26）。
 *
 * ## 为什么有它（用户口径，逐字）
 *   「3 把anima也加入回响吧。**也就是自动触发**」「**fts5目前看用处不大，摘除吧**」
 *   「**我没看到有anima的recall，只看到了fts5注入的，anima字段是空的**」
 *   ＋ 任务书的硬要求：「摘除要**如实体检**（面板那一档要能说出"BM25 已退役"），⛔ 不是静默消失」。
 *
 * ## 判据（每条都带**反证**：把关键那行从源码里挖掉/放回去，判据必须红）
 *   ① 本地 FTS5 引擎**整块没了**：`lib/echo-index.js` / `lib/echo-inject.js` 不存在，
 *      活代码里再无 fts5 / node:sqlite / createEchoInject / echo-index.db；
 *   ② 回响那一条注入**不再注册**：`dma:echo` 不在我们的段名册里、没有 registerEcho；
 *   ③ 面板**如实说**：向量档有「BM25 已退役」那一行、回响卡变成退役说明（且没有开关了）；
 *   ④ 配置面**如实说**：`echo` 段不再解析/不再接受写入，GET 投影回 `retired:true` + 谁来接管。
 *
 * ⛔ 别把"退役"写成"静默消失"：这几条判据钉的正是"说清楚了没有"。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(path.join(here, rel), 'utf8')

/** 剥掉注释 —— 静态断言只看**活代码**（⛔ 别被"已退役"这种说明文字骗过）。 */
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

let pass = 0
const fails = []
function check(name, fn) {
  try { fn(); pass++; console.log('[PASS] ' + name) }
  catch (e) { fails.push(name); console.log('[FAIL] ' + name + ' :: ' + String(e?.message ?? e)) }
}

let apass = 0
const afails = []
async function acheck(name, fn) {
  try { await fn(); apass++; console.log('[PASS] ' + name) }
  catch (e) { afails.push(name); console.log('[FAIL] ' + name + ' :: ' + String(e?.message ?? e)) }
}

const INDEX_SRC = read('lib/index.js')
const CLIENT_SRC = read('lib/client.js')
const INDEX_LIVE = stripComments(INDEX_SRC)
const CLIENT_LIVE = stripComments(CLIENT_SRC)

// ─────────────────────────── ① 本地 FTS5 引擎整块没了 ───────────────────────────
check('① a. `lib/echo-index.js` 与 `lib/echo-inject.js` 两个文件都已删除', () => {
  assert.equal(existsSync(path.join(here, 'lib', 'echo-index.js')), false, 'echo-index.js 还在（FTS5 引擎没摘）')
  assert.equal(existsSync(path.join(here, 'lib', 'echo-inject.js')), false, 'echo-inject.js 还在（回响装配件没摘）')
})

check('① b. `lib/` 下活代码里再无 FTS5 引擎的**承重标识符**（连库/建表/入库/抽词）', () => {
  // ⚠️ 判据只盯**承重标识符**，⛔ 不盯 `fts5` 这三个字本身：退役说明里**必须**能写出
  //    "FTS5 / echo-index.db" 这种名字（那正是"如实体检"的一部分）。
  const NEEDLES = ['node:sqlite', 'DatabaseSync', 'createEchoInject', 'ECHO_DB_FILENAME',
    'extractCandidates', 'filterCandidatesByDf', 'CREATE VIRTUAL TABLE', 'tokenize=']
  const hits = []
  for (const f of readdirSync(path.join(here, 'lib'))) {
    if (!f.endsWith('.js')) continue
    const live = stripComments(readFileSync(path.join(here, 'lib', f), 'utf8'))
    for (const needle of NEEDLES) if (live.includes(needle)) hits.push(`${f}: ${needle}`)
  }
  assert.deepEqual(hits, [], '这些文件里还有 FTS5 那条路的活代码：' + JSON.stringify(hits))
})

check('① c. ★反证：把 FTS5 的建表语句当活代码放回 ⇒ ①b 的判据必须红（证明它不是空跑）', () => {
  const back = stripComments(read('lib/archive-floors.js'))
    + '\nconst sql = "CREATE VIRTUAL TABLE x USING fts5(body, tokenize=\'trigram\')"\n'
  assert.equal(back.includes('CREATE VIRTUAL TABLE'), true, '反证构造失败')
  assert.equal(back.includes('tokenize='), true, '反证构造失败')
})

// ─────────────────────────── ② 回响那一条注入不再注册 ───────────────────────────
check('② a. `dma:echo` 不在我们的段名册里（活代码），且不再有 registerEcho / echoModules', () => {
  const m = /const OUR_SECTION_NAMES = Object\.freeze\(\[([^\]]*)\]\)/.exec(INDEX_LIVE)
  assert.ok(m !== null, '找不到 OUR_SECTION_NAMES（改名了？同步本台子）')
  assert.equal(m[1].includes('dma:echo'), false, 'dma:echo 还在段名册里 ⇒ 回响那一格没退役')
  assert.equal(INDEX_LIVE.includes('registerEcho'), false, 'registerEcho 还在（回响接线没摘）')
  assert.equal(INDEX_LIVE.includes('echoModules'), false, 'echoModules 还在（FTS5 模块还在被加载）')
  assert.equal(INDEX_LIVE.includes('echoRefreshSync'), false, 'echoRefreshSync 还在（回响缓存还在算）')
})

check('② b. ★反证：把 `dma:echo` 放回名册 ⇒ 同一条表达式必须红', () => {
  const back = INDEX_LIVE.replace("'anima:memory', 'rp:firstRound'", "'dma:echo', 'anima:memory', 'rp:firstRound'")
  const m = /const OUR_SECTION_NAMES = Object\.freeze\(\[([^\]]*)\]\)/.exec(back)
  assert.equal(m[1].includes('dma:echo'), true, '反证失败：放回去也没被检出')
})

check('② c. 保留的那一件（读归档楼层）还在、且只有一份实现 —— lastFloors 仍能用', () => {
  assert.equal(existsSync(path.join(here, 'lib', 'archive-floors.js')), true, 'archive-floors.js 不该被一起删掉（mt:lastFloors 还在用）')
  assert.ok(read('lib/archive-floors.js').includes('export function readArchiveFloors'), 'readArchiveFloors 没了')
  assert.ok(INDEX_LIVE.includes('archiveFloors.readArchiveFloors('), 'index.js 没接上 archiveFloors')
  assert.ok(/typeof archiveFloors\.readArchiveFloors !== 'function'/.test(INDEX_LIVE),
    'archiveFloors 的"模块缺席就降级"那道守卫没了（模块加载失败会直接抛）')
})

// ─────────────────────────── ③ 面板如实说（回响卡） ───────────────────────────
// ★ 2026-09-26（当晚补记）：BM25 已按用户拍板**复活**（任务书把「摘 fts5」扩大到 BM25 是口径错误）
//   ⇒ 原 ③a/③b（钉「BM25 已退役」行与动作摘除）**反转**：BM25 活行与两个动作都必须回来；
//   fts5/回响那一格的退役口径不变（③c/③d 照钉）。
check('③ a. ★向量档的 BM25 行回到**活行**（重建/删除动作都在；退役说明行不许再出现）', () => {
  assert.ok(CLIENT_LIVE.includes("libRow('rebuild:bm25', 'BM25'"), '面板没有 BM25 活行')
  assert.ok(CLIENT_LIVE.includes("'delete-bm25': '删除 BM25 库'"), '删除 BM25 库的动作短名不在')
  assert.equal(CLIENT_LIVE.includes('dma-vector-bm25-retired'), false, '「BM25 已退役」说明行还在（BM25 已复活，它不该出现）')
})

check('③ b. 面板照常认 BM25 两个动作（重建:bm25 / 删除 BM25 库）', () => {
  assert.ok(CLIENT_LIVE.includes('rebuild:bm25'), '面板没有"重建 BM25"那组按钮')
  assert.ok(CLIENT_LIVE.includes('delete-bm25'), '面板没有 delete-bm25 动作')
})

check('③ c. ★回响卡变成**退役说明**：有"已由 anima 接管"，且开关（dma-echo-enabled）已摘', () => {
  assert.ok(/已由 anima 接管/.test(CLIENT_LIVE), '回响卡没写"已由 anima 接管"')
  assert.equal(CLIENT_LIVE.includes('dma-echo-enabled'), false, '回响卡还留着那个开关（点下去会 400 —— 比没有更糟）')
  assert.ok(CLIENT_LIVE.includes('dma-echo-retired-detail'), '退役说明的详情块不在（用户看不到"摘了什么/去哪调"）')
  assert.ok(/inject\.echo/.test(CLIENT_LIVE), '没告诉用户"预算去哪配"（inject.echo）')
})

check('③ d. ★反证：把"已由 anima 接管"挖掉 ⇒ ③c 必须红', () => {
  const back = CLIENT_LIVE.replace(/已由 anima 接管/, '')
  assert.equal(/已由 anima 接管/.test(back), false, '反证失败：那句话挖掉后仍被判为存在')
})

// ─────────────────────────── ④ 跨仓契约与配置面 ───────────────────────────
await acheck('④ a. 面板白名单（本仓）与 anima 侧**逐字一致**，且都含 delete-bm25（BM25 已复活）', async () => {
  const mine = await import('./lib/vector-panel.js')
  assert.deepEqual([...mine.PANEL_ACTIONS], ['ingest-now', 'rebuild', 'delete-vector', 'delete-bm25'],
    'PANEL_ACTIONS 与预期不符：' + JSON.stringify(mine.PANEL_ACTIONS))
  assert.deepEqual([...mine.PANEL_DELETE_ACTIONS], ['delete-vector', 'delete-bm25'], '删除动作应有两个库')
  let other = null
  try {
    other = await import('file:///D:/apps/deepseek/dsh-anima-rag/lib/panel-request.js')
  } catch { other = null }
  if (other !== null) {
    assert.deepEqual([...other.PANEL_ACTIONS], [...mine.PANEL_ACTIONS], 'anima 侧 PANEL_ACTIONS 与本仓漂了')
    assert.equal(other.PANEL_ACTION_LABELS.rebuild, mine.PANEL_ACTION_LABELS.rebuild, 'rebuild 的中文短名两边不一致')
  }
})

await acheck('④ b. BM25 复活后不再有「退役事实」导出（BM25_RETIRED 应当不存在）', async () => {
  const mine = await import('./lib/vector-panel.js')
  assert.equal(mine.BM25_RETIRED, undefined, 'BM25_RETIRED 还在导出（BM25 已复活，这个退役事实不该再存在）')
})

await acheck('④ c. 状态快照里 `live.bm25` 回来了（BM25 复活 ⇒ 面板要能读到它的存在性）；`live.retrieval` 照旧在', async () => {
  const mine = await import('./lib/vector-panel.js')
  const st = mine.readVectorState({ homeDir: path.join(here, '_selftest-probe-missing-home') })
  assert.equal(st.ok, true, 'readVectorState 没回 ok（没有快照时也该 ok:true + info:null）')
  assert.ok(Object.prototype.hasOwnProperty.call(st.live, 'bm25'), 'live 里没有 bm25 这一项（BM25 复活后必须有）')
  assert.ok(Object.prototype.hasOwnProperty.call(st.live, 'retrieval'), 'live 里没有 retrieval（读侧故障面板就看不见了）')
})

check('④ d. 配置面：`echo` 段不再解析、不再接受写入，GET 投影**如实说退役**（含谁接管）', () => {
  const live = INDEX_LIVE
  assert.equal(live.includes('ECHO_NUMBER_KEYS'), false, 'ECHO_NUMBER_KEYS 还在（旧配置的 echo 段还在被解析）')
  assert.equal(/config\.echo\.enabled\s*=/.test(live), false, 'sanitize 里还在把 echo.enabled 写进配置')
  // GET /config 投影：retired + 谁接管 + 去哪配预算
  assert.ok(/retired:\s*true/.test(live), 'GET /config 投影没有 retired:true（退役就是静默消失了）')
  assert.ok(live.includes("replacedBy: 'dsh-anima-rag'"), '投影里没写"谁接管了"')
  assert.ok(/configHint:\s*'dsh-anima-rag 的 inject\.echo/.test(live), '投影里没写"预算去哪配"')
  // PUT /config：认得这个键、但明确拒绝并说明
  assert.ok(/patch\.echo !== undefined/.test(live), 'PUT 里连"认得 echo 这个键"都没有（用户会收到一句看不懂的通用错）')
  assert.ok(/已退役（2026-09-26）/.test(INDEX_SRC), 'PUT 的拒绝文案里没写明"已退役"和日期')
})

check('④ e. ★反证：把 `retired: true` 那行挖掉 ⇒ ④d 必须红', () => {
  const back = INDEX_LIVE.replace(/retired:\s*true/, 'enabled: false')
  assert.equal(/retired:\s*true/.test(back), false, '反证失败：挖掉后仍被判为存在')
})

// ⚠️ 同步判据与**异步**判据的失败都要算进退出码（漏了 afails 会让「④」那一组红了还退出 0）。
const allFails = [...fails, ...afails]
console.log(`\n── ${pass + apass} 通过 / ${allFails.length} 失败 ──`)
if (allFails.length > 0) { console.log('失败：' + allFails.join('、')); process.exitCode = 1 }
