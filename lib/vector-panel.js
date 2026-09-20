/**
 * vector-panel —— 「向量」页签的**宿主半侧**：只读状态快照 + 写一张请求单。
 *
 * ## 为什么这里只有"读状态"和"写字条"，没有真正的动作实现
 * 真正拥有向量库的是 `dsh-anima-rag`，它**按会话挂载**（roleplay 预设里），引擎/账本/入库实现
 * 全在它 `apply()` 的闭包里 —— 宿主平面（本插件，挂在 profile 上、有 webServer）拿不到。
 * 而"入库"这件事**只能有一份实现**（否则就是我们反复消灭的"两份真相"）。所以本模块只做两件事：
 *   ① 读 anima 落的**状态快照** `vector-info.json`（+ 回执 `panel-result.json`）；
 *   ② 面板点动作时写一张**请求单** `panel-request.json`，anima 在它下一脚（每轮装配都会跑的
 *      `kickAutoIngest`）取走执行，再把回执写回来。三张文件都在 `<DSH_HOME>/dsh-anima-rag/`。
 *
 * ## ⚠️ 常量是**逐字复制**的，不是 import 来的
 * 两个包各自部署（跨包没法共享模块）⇒ 照抄一份常量，并靠自检台盯漂移
 * （`_selftest-vector-panel.mjs`：逐字比对两边源码）。来源：
 * `dsh-anima-rag/lib/panel-request.js`（anima 侧那份是唯一定义处）。⛔ 改任何一条都要两边同时改。
 *
 * ## 路径基准
 * `<DSH_HOME>/dsh-anima-rag/`；`DSH_HOME` 环境变量优先，否则 `homedir()/.dsh`
 * （与 `lib/index.js` 的 `dshHomeDir()` 同一套约定，⛔ 不另造）。
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** 面板能请求的动作（⛔ 白名单：不认识的 action 一律拒绝，不猜）。与 anima 侧逐字一致。 */
export const PANEL_ACTIONS = ['ingest-now', 'rebuild', 'delete-vector', 'delete-bm25']

/** 动作的中文短名（面板与 anima 日志共用同一份措辞）。与 anima 侧逐字一致。 */
export const PANEL_ACTION_LABELS = {
  'ingest-now': '立即入库',
  'rebuild': '重建（向量 + BM25）',
  'delete-vector': '删除向量库',
  'delete-bm25': '删除 BM25 库',
}

export const PANEL_REQUEST_FILE = 'panel-request.json'
export const PANEL_RESULT_FILE = 'panel-result.json'
export const VECTOR_INFO_FILE = 'vector-info.json'
/** 删库不是"销毁"：anima 一律改名成这个前缀 + 时间戳留档（本模块只用来显示，不参与删除）。 */
export const PANEL_REMOVED_PREFIX = 'removed-'

/** 动作名是否认识（白名单唯一判据；`makeRequest` / `writeRequest` 都走它）。 */
export function isKnownAction(action) {
  return typeof action === 'string' && PANEL_ACTIONS.includes(action)
}

/**
 * DSH 根目录（`<DSH_HOME>` 那个值，⛔ 不是用户主目录）。
 *
 * `homeDir` 显式给了就用它（自检台/测试注入临时目录走这条）；否则 `env.DSH_HOME` 优先、
 * 再退 `homedir()/.dsh` —— 与 `lib/index.js` 的 `dshHomeDir()` 逐字同口径，防两处漂移。
 */
function dshHomeOf(homeDir) {
  if (typeof homeDir === 'string' && homeDir.trim() !== '') return resolve(homeDir)
  const configured = process.env.DSH_HOME
  const base =
    configured !== undefined && String(configured).trim() !== ''
      ? String(configured)
      : join(homedir(), '.dsh')
  return resolve(base)
}

/** anima 的三张文件所在的目录。 */
function animaDirOf(homeDir) {
  return join(dshHomeOf(homeDir), 'dsh-anima-rag')
}

/**
 * 读一份 JSON；**任何**失败（不存在 / 不是 JSON / 权限）都返回 null，⛔ 绝不抛。
 *
 * ★ 为什么不区分"没有"与"坏了"：这两者对面板是同一件事 —— 拿不到可信的快照就如实说
 *   "还没有快照"，而不是把一个半截对象当快照渲染。诊断信息由 anima 那边负责（它才是写方）。
 */
function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** 只认普通对象（数组/字符串/数字都不是一份能用的快照）。 */
function plainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 读向量的 <vectorRoot>/<collectionId>/index.json：`items.length` 就是条数（vectra 的形状）。 */
function readVectorStat(indexPath) {
  let st
  try {
    st = statSync(indexPath)
  } catch {
    return { exists: false, count: null, mtime: null }
  }
  // 库在、但 items 读不出来 ⇒ 如实给 count:null（⛔ 不猜成 0：0 条与"读不到"是两回事）
  const doc = readJsonSafe(indexPath)
  const count = Array.isArray(doc?.items) ? doc.items.length : null
  return { exists: true, count, mtime: st.mtimeMs }
}

/** 读 BM25 的 <bm25Root>/<collectionId>.json：只 stat（那文件可能几十 MB，⛔ 不为一个字节数去 parse）。 */
function readBm25Stat(filePath) {
  try {
    const st = statSync(filePath)
    return { exists: true, bytes: st.size, mtime: st.mtimeMs }
  } catch {
    return { exists: false, bytes: null, mtime: null }
  }
}

/**
 * 读面板要的一切。
 *
 * @param {{homeDir?: string}} [opts] - `homeDir` = DSH 根目录（缺省由 env/homedir 推，见 `dshHomeOf`）。
 * @returns {{ok: true, info: object|null, result: object|null, live: object, staleMs: number|null}}
 *   · `info`   = `vector-info.json` 原样（anima 写的状态快照；没有/坏 ⇒ null）
 *   · `result` = `panel-result.json`（动作回执；没有/坏 ⇒ null）
 *   · `live`   = 用 `info.dataRoots` **现算**的易变项 —— 快照天然会过期，而"库里现在几条"
 *                必须问盘，⛔ 不能拿快照里的旧数字当现状：
 *                `{vector:{exists,count,mtime}, bm25:{exists,bytes,mtime}, ingestState}`。
 *                有快照但数据根缺/空 ⇒ `exists:false`（定位不到这个库就当它没有，⛔ 不编 0——
 *                面板会把 ⚠缺失 摆出来，出路是重建/立即入库让 anima 重写快照）；
 *                **info 整个缺席** ⇒ `vector`/`bm25` 为 null（连集合名都没有，说"库不存在"反而是编，
 *                面板走"还没有快照"空状态）。
 *   · `staleMs` = 快照落后现在多久（`info.at` 不是数字或缺席 ⇒ null）。
 */
export function readVectorState({ homeDir } = {}) {
  const dir = animaDirOf(homeDir)
  const rawInfo = readJsonSafe(join(dir, VECTOR_INFO_FILE))
  const rawResult = readJsonSafe(join(dir, PANEL_RESULT_FILE))
  const info = plainObject(rawInfo) ? rawInfo : null
  const result = plainObject(rawResult) ? rawResult : null
  // ingest-state.json 与快照无关地"现读"（它是 anima 每轮都在写的活跃文件，快照里的那份是旧拷贝）
  const rawIngest = readJsonSafe(join(dir, 'ingest-state.json'))

  const dataRoots = plainObject(info?.dataRoots) ? info.dataRoots : null
  const collectionId = typeof info?.collectionId === 'string' && info.collectionId !== '' ? info.collectionId : ''
  const str = (v) => (typeof v === 'string' && v !== '' ? v : '')
  let vector = null
  let bm25 = null
  if (info !== null && collectionId !== '') {
    // ★ 快照在、集合名也在，但数据根缺字段/是空串 ⇒ 这个库**定位不到**，如实当"不存在"
    //   （exists:false，count/bytes 保持 null ⛔ 不编 0——"0 条"与"找不到"是两回事）。
    //   ⛔ 只有 info 整个缺席才回 null：那时连集合名都没有，断言"库不存在"就是编。
    const roots = plainObject(dataRoots) ? dataRoots : {}
    const vectorRoot = str(roots.vectorRoot)
    const bm25Root = str(roots.bm25Root)
    vector = vectorRoot !== '' ? readVectorStat(join(vectorRoot, collectionId, 'index.json')) : { exists: false, count: null, mtime: null }
    bm25 = bm25Root !== '' ? readBm25Stat(join(bm25Root, collectionId + '.json')) : { exists: false, bytes: null, mtime: null }
  }

  const at = typeof info?.at === 'number' && Number.isFinite(info.at) ? info.at : null
  return {
    ok: true,
    info,
    result,
    live: { vector, bm25, ingestState: rawIngest },
    staleMs: at === null ? null : Math.max(0, Date.now() - at),
  }
}

/**
 * 造一张请求单（形状与 anima 侧 `parsePanelRequest` 对得上：认识的 action + 有 id）。
 * 不认识的 action ⇒ null（⛔ 不构造半张单子让 anima 去猜）。
 */
export function makeRequest({ action, note = '' } = {}) {
  if (!isKnownAction(action)) return null
  return { version: 1, id: randomUUID(), action, note: String(note ?? ''), at: Date.now() }
}

/**
 * 把请求单原子写到 `<DSH_HOME>/dsh-anima-rag/panel-request.json`。
 *
 * 原子写 = 先写 `.tmp-<pid>` 再 rename（照本仓 `writeConfigFile` 的写法）—— anima 可能正好在
 * 同一毫秒读这张单子，⛔ 绝不能让它读到半截 JSON。`<pid>` 后缀让多进程并存时互不踩对方的临时文件。
 *
 * @returns {object|null} 写成功的请求单；action 不认识 ⇒ null（⛔ 不写盘）。
 *   IO 失败**如实抛**（调用方给 500），⛔ 不吞成 null —— 那会和"action 不认识"混成同一个 400。
 */
export function writeRequest({ homeDir, action, note = '' } = {}) {
  const req = makeRequest({ action, note })
  if (req === null) return null
  const dir = animaDirOf(homeDir)
  mkdirSync(dir, { recursive: true })
  const finalPath = join(dir, PANEL_REQUEST_FILE)
  const tmpPath = finalPath + '.tmp-' + process.pid
  writeFileSync(tmpPath, JSON.stringify(req, null, 2) + '\n', 'utf8')
  renameSync(tmpPath, finalPath)
  return req
}
