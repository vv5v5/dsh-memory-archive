/**
 * vector-panel —— 「向量」页签的**宿主半侧**：读状态快照 + 写请求单 +（**删除**当场做完）。
 *
 * ## 为什么这里大多只有"读状态"和"写字条"，而**删除**是例外
 * 真正拥有向量库的是 `dsh-anima-rag`，它**按会话挂载**（roleplay 预设里），引擎/账本/入库实现
 * 全在它 `apply()` 的闭包里 —— 宿主平面（本插件，挂在 profile 上、有 webServer）拿不到。
 * 而"入库"这件事**只能有一份实现**（否则就是我们反复消灭的"两份真相"）。所以本模块做四件事：
 *   ① 读 anima 落的**状态快照** `vector-info.json`（+ 回执 `panel-result.json`）；
 *   ② 面板点「立即入库 / 重建」时写一张**请求单** `panel-request.json`，anima 在它下一脚
 *      （每轮装配都会跑的 `kickAutoIngest`）取走执行，再把回执写回来；
 *   ③ 打开向量库自己的 `index.json` **逐条列举**（摘要名/标签/字数/正文预览，见 `buildVectorEntries`）
 *     —— 同样只读，正文在库目录的 `<uuid>.json` 里，预览最长 VECTOR_ENTRY_TEXT_CAP 字；
 *   ④ ★★ 2026-09-22（用户口径：「是这个流程反直接，直接冻面板 60s，然后告诉我要下一轮？**改成直接删**」）
 *      **两个删除动作在宿主平面当场做完**（`deleteNow`）：删除 = **改名留档**（⛔ 绝不 rm）+ **忘账本**
 *      + 写回执 + 消费同名旧请求单 —— 全是宿主平面能做的事，**不需要引擎**（`deleteNow` 头注有详述）。
 *      ⛔ 只有删除改成立即；「入库 / 重建」仍只能排队（引擎与 embedding 拿不到，⛔ 宿主平面绝不重造）。
 *
 * ## ⚠️ 常量/语义是**逐字复制**的，不是 import 来的
 * 两个包各自部署（跨包没法共享模块）⇒ 照抄一份常量，并靠自检台盯漂移
 * （`_selftest-vector-panel.mjs`：逐字比对两边源码）。来源：
 * `dsh-anima-rag/lib/panel-request.js`（形状/动作名的唯一定义处）与
 * `dsh-anima-rag/lib/index.js` 的 `executePanelAction`（删除语义的唯一定义处：`safeCollectionName` /
 * `removedStamp` / 归档文案 / `forgetFiles` 那套口径）。⛔ 改任何一条都要**两边同时改**，两边行为必须一致。
 *
 * ## 路径基准
 * `<DSH_HOME>/dsh-anima-rag/`；`DSH_HOME` 环境变量优先，否则 `homedir()/.dsh`
 * （与 `lib/index.js` 的 `dshHomeDir()` 同一套约定，⛔ 不另造）。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
/** 删库不是"销毁"：anima 一律改名成这个前缀 + 时间戳留档（本模块的 `planDelete` 同款拼法）。 */
export const PANEL_REMOVED_PREFIX = 'removed-'
/** 入库账本的文件名（与 anima `lib/ingest-maintenance.js` 的 `LEDGER_FILENAME` 逐字一致；落在上面那个目录下）。 */
export const LEDGER_FILE = 'ingest-ledger.json'

/**
 * ★★ 2026-09-22：**不需要 anima 引擎**的那两个动作 —— 删除就是"改名留档 + 忘账本"，
 * 宿主平面自己就能做完（见 `deleteNow`），⛔ 没有理由让面板转 60 秒再告诉用户"要等下一轮"。
 * 其余动作（入库 / 重建）仍只能在 anima 那边跑，⛔ 本模块绝不重造那份实现。
 */
export const PANEL_DELETE_ACTIONS = ['delete-vector', 'delete-bm25']

/**
 * 逐条列举的护栏（任务口径：条数多要能折叠，别一次糊 50 行 —— 前端折叠，这里只防病态大库）：
 * 一次最多吐多少条、每条正文预览最多带多少字（正文全文不进状态接口，预览够"点开看一眼"）。
 */
export const VECTOR_ENTRY_LIMIT = 500
export const VECTOR_ENTRY_TEXT_CAP = 800

/** 动作名是否认识（白名单唯一判据；`makeRequest` / `writeRequest` 都走它）。 */
export function isKnownAction(action) {
  return typeof action === 'string' && PANEL_ACTIONS.includes(action)
}

/** 是不是"当场做完"的那个删除动作（判据只有这一处，⛔ 别在调用方另写一份字面量比较）。 */
export function isDeleteAction(action) {
  return typeof action === 'string' && PANEL_DELETE_ACTIONS.includes(action)
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

/** 非空字符串（否则空串）—— 快照/账本里的字段一律按这个口径取值，⛔ 不猜。 */
function strOr(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : ''
}

// ─────────────────────────── 删除：纯计划 + 同款文案（2026-09-22） ───────────────────────────
//
// ★★ 为什么删除可以不问 anima 的引擎（本单的改判，`lib/vector-panel.js` 头注 ④）：
//   删除就是 **改名留档**（目标 → 目标.removed-<时间戳>）+ **忘账本**（从 ingest-ledger.json 里
//   删掉本会话周目那几个摘要文件名的条目）—— 全在宿主平面做得到。而"入库"要 embedding 与引擎，
//   那份实现只在 anima 的 apply() 闭包里 ⇒ 入库/重建照旧排队。⛔ 两件事都不是"第二套实现"：
//   下面这些函数是把 anima `executePanelAction` 的删除分支**照抄**过来（语义/文案/前缀逐字一致），
//   自检台逐字比对两边源码盯漂移。

/** 集合名归一（逐字照抄 anima `lib/index.js` 的 `safeCollectionName`：vectra 目录名与 BM25 文件名同一套正则）。 */
export function safeCollectionName(id) {
  return String(id).replace(/[^a-zA-Z0-9@\-\._\u4e00-\u9fa5]/g, '_')
}

/** 归档时间戳（逐字照抄 anima `lib/index.js` 的 `stamp`：ISO → 去掉 `:`/`.` 只留到秒）。 */
export function removedStamp(now = Date.now()) {
  return new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

/**
 * 账本候选名单：只收**纯文件名**（账本的键就是 `entries[].file` 那种裸名字）。
 *  · 非字符串 / 空串 ⇒ 丢；
 *  · 带路径分隔符或 `.` / `..` ⇒ **丢**（那种名字永远不可能是账本的键；顺带挡掉"客户端递来一个
 *    路径把我们引到别处"这类形态 —— 本模块的立场与 `rel-path-jail.js` 同款：**拒收，不清洗**）；
 *  · 去重（同一个名字出现两次只算一条）。
 * @returns {string[]} 认识的那部分（顺序即入参顺序）
 */
export function summaryFileNamesOf(files) {
  if (!Array.isArray(files)) return []
  const out = []
  for (const f of files) {
    if (typeof f !== 'string') continue
    const name = f.trim()
    if (name === '' || name === '.' || name === '..') continue
    if (name.includes('/') || name.includes('\\')) continue
    if (!out.includes(name)) out.push(name)
  }
  return out
}

/**
 * ★★★ 纯计划：一次删除动作要做成什么（**不碰文件系统** —— 目标在不在、改名成不成是调用方的事）。
 *
 * @param {{action?: string, dataRoots?: object, collectionId?: string, summaryFiles?: string[]|null,
 *          ledgerEntries?: object|null, now?: number}} p
 *   · `summaryFiles` = 本会话周目的摘要文件名清单（宿主自己读 `archive/summaries/index.json` 得来）；
 *     **null** = 清单读不到（⇒ 一条都不忘，`filesKnown:false`）；`[]` = 那个周目本来就没有摘要。
 *   · `ledgerEntries` = 账本里的 `entries` 对象；**null** = 账本读不到（⇒ `forgetCount:0` 但
 *     `ledgerKnown:false`，调用方必须如实播报"没忘成"而不是"本来就没有"）。
 * @returns {{ok:true, action:string, collectionId:string, safe:string, target:string, dest:string,
 *            forgetFiles:string[], forgetCount:number, filesKnown:boolean, ledgerKnown:boolean}
 *          | {ok:false, reason:string}}
 *   · `target` = 向量库目录 `<vectorRoot>/<safe>` / BM25 文件 `<bm25Root>/<safe>.json`；
 *   · `dest`   = `<target>.removed-<stamp>`（**改名留档，⛔ 绝不 rm**）；
 *   · `forgetCount` = 清单里**真在账本上**的那几条（决定回执文案里那个数字）。
 */
export function planDelete({ action, dataRoots, collectionId, summaryFiles = null, ledgerEntries = null, now = Date.now() } = {}) {
  if (!isDeleteAction(action)) return { ok: false, reason: `不是删除动作：${String(action)}` }
  const id = strOr(collectionId)
  if (id === '') return { ok: false, reason: '状态快照里没有集合名（collectionId）—— ⛔ 不猜路径' }
  const roots = plainObject(dataRoots) ? dataRoots : {}
  const rootKey = action === 'delete-vector' ? 'vectorRoot' : 'bm25Root'
  const root = strOr(roots[rootKey])
  if (root === '') return { ok: false, reason: `状态快照里没有数据根（dataRoots.${rootKey}）—— ⛔ 不猜路径` }
  const safe = safeCollectionName(id)
  // ⛔ BM25 是**一个文件**（`<safe>.json`），向量是**一个目录** —— 别把两者的落点写反（自检台钉了这条）。
  const target = action === 'delete-vector' ? join(root, safe) : join(root, `${safe}.json`)
  const filesKnown = Array.isArray(summaryFiles)
  const forgetFiles = summaryFileNamesOf(summaryFiles)
  const keys = plainObject(ledgerEntries) ? ledgerEntries : null
  const forgetCount = keys === null ? 0 : forgetFiles.filter((f) => Object.prototype.hasOwnProperty.call(keys, f)).length
  return {
    ok: true, action, collectionId: id, safe, target,
    dest: `${target}.${PANEL_REMOVED_PREFIX}${removedStamp(now)}`,
    forgetFiles, forgetCount, filesKnown, ledgerKnown: keys !== null,
  }
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
 * 回执文案（**逐字照抄** anima `executePanelAction` 的两句，⛔ 每次改都要两边一起改）：
 *   · 目标在   ⇒ `已归档为 <归档名>（没删），并忘掉账本 N 条 ⇒ 下次入库会重新长出来`
 *   · 目标不在 ⇒ `本来就不存在（顺手忘掉账本 N 条）`   ← 注意：不在也**照样忘账本**，且 ⛔ 不报失败
 * @param {object} plan - `planDelete` 的产物
 * @param {{exists: boolean, forgotten: number}} p
 */
export function deleteMessage(plan, { exists, forgotten } = {}) {
  const n = Number.isFinite(forgotten) ? forgotten : 0
  if (exists === true) {
    return `已归档为 ${String(plan.dest).split(/[\\/]/).pop()}（没删），并忘掉账本 ${n} 条 ⇒ 下次入库会重新长出来`
  }
  return `本来就不存在（顺手忘掉账本 ${n} 条）`
}

/**
 * 一张回执（**逐字同构** anima `lib/panel-request.js` 的 `makePanelResult`：
 * `{version,id,action,ok,message,counts,at}` —— 面板「最近一次动作」读的就是它，⛔ 键名一个都不许多/少）。
 */
export function makeResult({ id, action, ok, message, counts = null, at = Date.now() }) {
  return {
    version: 1, id: String(id), action: String(action), ok: ok === true,
    message: String(message ?? ''), counts, at,
  }
}

/**
 * 读向量的 <vectorRoot>/<collectionId>/index.json：`items.length` 就是条数（vectra 的形状）。
 * `doc` 原样带回（`buildVectorEntries` 拿它逐条展开；不是数组时条目侧如实回 null）。
 */
function readVectorIndex(indexPath) {
  let st
  try {
    st = statSync(indexPath)
  } catch {
    return { exists: false, count: null, mtime: null, doc: null }
  }
  // 库在、但 items 读不出来 ⇒ 如实给 count:null（⛔ 不猜成 0：0 条与"读不到"是两回事）
  const doc = readJsonSafe(indexPath)
  const count = Array.isArray(doc?.items) ? doc.items.length : null
  return { exists: true, count, mtime: st.mtimeMs, doc }
}

/** 一条条目的正文侧空形状（正文文件读不到时逐字段 null，⛔ 不编 0 字）。 */
function emptyEntryBody() {
  return { chars: null, text: null, textTruncated: false, timestamp: null, mtime: null }
}

/**
 * 读一个条目的正文文件（vectra 形状：`<uuid>.json`，里面有 `text` / `timestamp`）。
 * **任何**失败（缺文件 / 坏 JSON / 没有 text 字段）都只让对应字段保持 null，⛔ 绝不抛、不编数。
 * `mtime` 与 text 无关地单独 stat —— 坏 JSON 时也能给"入库时间"这一个事实。
 */
function readEntryBody(absPath) {
  const out = emptyEntryBody()
  if (typeof absPath !== 'string' || absPath === '') return out
  try {
    out.mtime = statSync(absPath).mtimeMs
  } catch {
    return out
  }
  let doc = null
  try {
    doc = JSON.parse(readFileSync(absPath, 'utf8'))
  } catch {
    return out
  }
  const text = typeof doc?.text === 'string' ? doc.text : null
  if (text !== null) {
    out.chars = text.length
    out.text = text.slice(0, VECTOR_ENTRY_TEXT_CAP)
    out.textTruncated = text.length > VECTOR_ENTRY_TEXT_CAP
  }
  if (typeof doc?.timestamp === 'number' && Number.isFinite(doc.timestamp)) out.timestamp = doc.timestamp
  return out
}

/**
 * 把 index.json 的 `items` 展开成面板要的逐条列表。
 *
 * 每条：`{index, tags, metadataFile, bad, chars, text, textTruncated, timestamp, mtime}`
 *  · `index` = metadata.index（形如 `sum_s-0240-0253-6.md`，去掉 `sum_` 前缀就是摘要文件名 —— 两边的主键）
 *  · `tags`  = metadata.tags 里全是字符串的那部分（`pt:<周目id>` 就是归属周目）
 *  · `chars` = 正文文件里 `text` 的字数；正文读不到 ⇒ null（⛔ 不编 0）
 *  · `bad`   = 这一连 index/tags/metadataFile 一个都没有（读不出名字的残条，面板如实摆出来）
 * 返回：`{items, total, truncated, unreadable}`；`items` 不是数组 ⇒ null（调用方如实说"条目读不到"）。
 * `limit` 只为自检台注入（真跑用 VECTOR_ENTRY_LIMIT 的默认值）。
 */
export function buildVectorEntries(items, { readMeta = readEntryBody, baseDir = '', limit = VECTOR_ENTRY_LIMIT } = {}) {
  if (!Array.isArray(items)) return null
  const capped = items.slice(0, limit)
  let unreadable = 0
  const out = capped.map((it) => {
    if (!plainObject(it)) {
      unreadable++
      return Object.assign({ index: '', tags: [], metadataFile: '', bad: true }, emptyEntryBody())
    }
    const meta = plainObject(it.metadata) ? it.metadata : {}
    const index = typeof meta.index === 'string' ? meta.index : ''
    const tags = Array.isArray(meta.tags) ? meta.tags.filter((t) => typeof t === 'string') : []
    const mf = typeof it.metadataFile === 'string' && it.metadataFile !== '' ? it.metadataFile : ''
    const body = mf !== '' ? readMeta(baseDir !== '' ? join(baseDir, mf) : mf) : emptyEntryBody()
    if (mf !== '' && body.chars === null) unreadable++
    return {
      index,
      tags,
      metadataFile: mf,
      bad: index === '' && tags.length === 0 && mf === '',
      chars: body.chars,
      text: body.text,
      textTruncated: body.textTruncated,
      timestamp: body.timestamp,
      mtime: body.mtime,
    }
  })
  return { items: out, total: items.length, truncated: items.length > capped.length, unreadable }
}

/**
 * 读面板要的一切。
 *
 * @param {{homeDir?: string}} [opts] - `homeDir` = DSH 根目录（缺省由 env/homedir 推，见 `dshHomeOf`）。
 * @returns {{ok: true, info: object|null, result: object|null, entries: object|null, live: object,
 *            staleMs: number|null, deletedAfterInfo: boolean}}
 *   · `info`   = `vector-info.json` 原样（anima 写的状态快照；没有/坏 ⇒ null）
 *   · `result` = `panel-result.json`（动作回执；没有/坏 ⇒ null）
 *   · `entries` = 逐条列举（`buildVectorEntries` 的产物：摘要名/标签/字数/正文预览）——
 *                index.json 打不开或 items 不是数组 ⇒ null（面板如实说"条目读不到"，⛔ 不编空表）；
 *                快照缺席 ⇒ 同样 null（连集合名都没有）。
 *   · `live`   = 用 `info.dataRoots` **现算**的易变项 —— 快照天然会过期，而"库里现在几条"
 *                必须问盘，⛔ 不能拿快照里的旧数字当现状：
 *                `{vector:{exists,count,mtime}, bm25:{exists,bytes,mtime}, ingestState}`。
 *                有快照但数据根缺/空 ⇒ `exists:false`（定位不到这个库就当它没有，⛔ 不编 0——
 *                面板会把 ⚠缺失 摆出来，出路是重建/立即入库让 anima 重写快照）；
 *                **info 整个缺席** ⇒ `vector`/`bm25` 为 null（连集合名都没有，说"库不存在"反而是编，
 *                面板走"还没有快照"空状态）。
 *   · `staleMs` = 快照落后现在多久（`info.at` 不是数字或缺席 ⇒ null）。
 *   · `deletedAfterInfo` = 最近一张回执是不是**删除**、且比快照新（快照是"删之前"的 ⇒ 面板如实标过期）。
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
  let entries = null
  if (info !== null && collectionId !== '') {
    // ★ 快照在、集合名也在，但数据根缺字段/是空串 ⇒ 这个库**定位不到**，如实当"不存在"
    //   （exists:false，count/bytes 保持 null ⛔ 不编 0——"0 条"与"找不到"是两回事）。
    //   ⛔ 只有 info 整个缺席才回 null：那时连集合名都没有，断言"库不存在"就是编。
    const roots = plainObject(dataRoots) ? dataRoots : {}
    const vectorRoot = str(roots.vectorRoot)
    const bm25Root = str(roots.bm25Root)
    if (vectorRoot !== '') {
      const collectionDir = join(vectorRoot, collectionId)
      const idx = readVectorIndex(join(collectionDir, 'index.json'))
      vector = { exists: idx.exists, count: idx.count, mtime: idx.mtime }
      entries = buildVectorEntries(idx.doc?.items, { baseDir: collectionDir })
    } else {
      vector = { exists: false, count: null, mtime: null }
    }
    // ★ bm25 与 vectorRoot **无关**（2026-09-26 修：此前它被塞在 vectorRoot 那个分支里，
    //   vectorRoot 一空 bm25 就保持 null ⇒ 面板那条"BM25 库"行整个消失，而不是如实亮 ⚠缺失）。
    //   两个根是两把独立的钥匙：缺哪把，哪把对应的库就如实 exists:false（bytes 保持 null ⛔ 不编 0）。
    bm25 = bm25Root !== '' ? readBm25Stat(join(bm25Root, collectionId + '.json')) : { exists: false, bytes: null, mtime: null }
  }

  const at = typeof info?.at === 'number' && Number.isFinite(info.at) ? info.at : null
  // ★★「删完不许有两个真相」（本单硬约束）：回执是**宿主自己**写的（当场删除），而快照是 anima 写的、
  //   下一脚才更新 ⇒ 刚删完的那一小段里，快照里的条数/归属统计都是**删之前**的。
  //   判据 = 最近一张回执是删除动作、且它比快照新 ⇒ 面板要如实标"快照过期"，⛔ 不许拿旧条数骗人。
  const resultAt = typeof result?.at === 'number' && Number.isFinite(result.at) ? result.at : null
  const deletedAfterInfo = isDeleteAction(result?.action) && resultAt !== null && (at === null || resultAt >= at)
  return {
    ok: true,
    info,
    result,
    entries,
    live: { vector, bm25, retrieval: plainObject(info?.retrieval) ? info.retrieval : null, ingestState: rawIngest },
    staleMs: at === null ? null : Math.max(0, Date.now() - at),
    deletedAfterInfo,
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

/** 原子写一份 JSON（照 `writeRequest` 的写法：先 `.tmp-<pid>` 再 rename）。 */
function writeJsonAtomic(finalPath, doc) {
  const tmpPath = finalPath + '.tmp-' + process.pid
  writeFileSync(tmpPath, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  renameSync(tmpPath, finalPath)
}

/**
 * 读某个周目的 `archive/summaries/index.json`，取 `entries[].file`（= 账本里的键，anima 同款读法）。
 *
 * ★ 为什么文件名清单**必须宿主自己读**（本单硬约束）：⛔ 不接受客户端递来的名单 —— 那等于让面板
 *   决定"忘掉谁的账本"。客户端只能告诉我们"是哪个周目"，清单由这里从盘上的归档里读。
 * @returns {{ok:true, files:string[]} | {ok:false, reason:string}}
 */
export function readSummaryFileNames(summariesDir) {
  const dir = strOr(summariesDir)
  if (dir === '') return { ok: false, reason: '不知道是哪个周目（没给出摘要目录）' }
  const idxPath = join(dir, 'index.json')
  const doc = readJsonSafe(idxPath)
  if (!plainObject(doc)) return { ok: false, reason: `${idxPath} 读不到或不是合法 JSON` }
  if (!Array.isArray(doc.entries)) return { ok: false, reason: `${idxPath} 里没有 entries 数组` }
  return { ok: true, files: doc.entries.map((e) => (plainObject(e) ? strOr(e.file) : '')).filter((f) => f !== '') }
}

/**
 * 忘掉账本里那几个文件名对应的条目（**只删命中的那几条**，⛔ 绝不整本 clear —— 那会把别的周目的
 * 账本一起清掉，下次那些摘要会被整集重灌；这条教训 anima 那边真机踩过，2026-09-20）。
 *
 * 写回的形状与 anima `createIngestLedger().save()` 逐字同构：`{version, updatedAt, entries}`（原子写）。
 * @returns {{forgotten:number, note:string}} `note` = 非空 ⇒ 出过事（**一条都没忘**或写盘失败），调用方如实播报
 */
function forgetLedgerEntries(ledgerPath, files) {
  const names = summaryFileNamesOf(files)
  if (names.length === 0) return { forgotten: 0, note: '' }
  if (!existsSync(ledgerPath)) {
    return { forgotten: 0, note: `${LEDGER_FILE} 不在（账本还没落盘 / 配了自定义路径）⇒ 一条都没忘` }
  }
  const doc = readJsonSafe(ledgerPath)
  if (!plainObject(doc) || !plainObject(doc.entries)) {
    return { forgotten: 0, note: `${LEDGER_FILE} 读不到或没有 entries ⇒ 一条都没忘` }
  }
  const entries = Object.assign({}, doc.entries)
  let forgotten = 0
  for (const f of names) {
    if (Object.prototype.hasOwnProperty.call(entries, f)) {
      delete entries[f]
      forgotten += 1
    }
  }
  if (forgotten === 0) return { forgotten: 0, note: '' }
  try {
    writeJsonAtomic(ledgerPath, Object.assign({}, doc, {
      version: Number.isFinite(doc.version) ? doc.version : 1,
      updatedAt: new Date().toISOString(),
      entries,
    }))
  } catch (e) {
    // 写盘失败 ⇒ 磁盘**一个字节都没变** ⇒ 如实回 0（⛔ 不许把"内存里删掉了"当成功报出去）
    return { forgotten: 0, note: `账本没改成：${String((e && e.message) || e).slice(0, 120)}（磁盘没动）` }
  }
  return { forgotten, note: '' }
}

/**
 * 消费掉可能躺着的**同名**旧请求单（本单硬约束：删完还留着那张单子 ⇒ anima 下一脚会照它再删一次）。
 * ⛔ 只认 action 完全相同的：别的动作（比如有人手工排的「重建」）一根汗毛都不许动。
 */
function consumeSameActionRequest(dir, action) {
  const reqPath = join(dir, PANEL_REQUEST_FILE)
  const raw = readJsonSafe(reqPath)
  if (!plainObject(raw) || raw.action !== action) return false
  try {
    rmSync(reqPath, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * ★★★ 当场执行一次删除（本单的正面要求：**点了就删**，⛔ 不再排队等下一轮）。
 *
 * 步骤与 anima `executePanelAction` 的删除分支**逐步对齐**（两边行为必须一致）：
 *   ① 读 `vector-info.json` 拿 `dataRoots` + `collectionId`（读不到 ⇒ 可读错误，⛔ 绝不猜路径）；
 *   ② 目标不存在 ⇒ 照 anima 老口径回「本来就不存在（顺手忘掉账本 N 条）」，**仍要忘账本**、⛔ 不报失败；
 *   ③ 存在 ⇒ **改名**成 `<target>.removed-<时间戳>`（⛔ 绝不 rm：改名归档是本仓铁律）；
 *   ④ 忘账本（只忘本会话周目那几个摘要文件名对应的条目）；
 *   ⑤ 回执写进 `panel-result.json`（面板「最近一次动作」读它）；
 *   ⑥ 消费掉同名旧请求单（见 `consumeSameActionRequest`）。
 * ⛔ 本函数**不写** `vector-info.json`（那是 anima 的快照：写它就是我们反复消灭的"两份真相"）；
 *   删完之后快照可能还是旧的 ⇒ 面板靠 `readVectorState().deletedAfterInfo` 如实标过期。
 *
 * @param {{homeDir?:string, action?:string, summariesDir?:string, now?:number}} p
 *   · `summariesDir` = **调用方**（宿主入口，那才有工作区根/catalog 的知识）解出来的
 *     `<rootPath>/<角色>/<周目>/archive/summaries`；解不出就传空串 ⇒ 一条都不忘并如实播报。
 *   · `now` 只为自检台注入（真跑用 Date.now()）。
 * @returns {{ok:true, deleted:true, receipt:object, archived:string|null, requestConsumed:boolean,
 *            ledgerForgotten:number, note:string}
 *          | {ok:false, code:string, message:string, receipt?:object}}
 *   `ok:false` 的三种：`NOT_A_DELETE`（用错函数）/ `VECTOR_INFO_UNAVAILABLE`（快照读不到 ⇒ 没动任何文件）/
 *   `DELETE_PLAN_FAILED`（快照里缺落点）/ `DELETE_FAILED`（改名失败，这时**回执已写**，面板看得到原因）。
 *   `note` 非空 ⇒ 回执没落盘（调用方把它带回响应，⛔ 不静默）。
 */
export function deleteNow({ homeDir, action, summariesDir = '', now = Date.now() } = {}) {
  if (!isDeleteAction(action)) {
    return { ok: false, code: 'NOT_A_DELETE', message: `不是删除动作：${String(action)}（⛔ 入库/重建仍走请求单）` }
  }
  const dir = animaDirOf(homeDir)
  const info = readJsonSafe(join(dir, VECTOR_INFO_FILE))
  if (!plainObject(info)) {
    return {
      ok: false,
      code: 'VECTOR_INFO_UNAVAILABLE',
      message: '读不到向量库的落点（vector-info.json 不在或不是合法 JSON）—— 没动任何文件；'
        + '等 anima 在这个周目跑过一脚（开一次会话 / 点「立即入库」）再试。',
    }
  }
  const summary = readSummaryFileNames(summariesDir)
  const ledgerPath = join(dir, LEDGER_FILE)
  const ledgerDoc = readJsonSafe(ledgerPath)
  const plan = planDelete({
    action,
    dataRoots: info.dataRoots,
    collectionId: info.collectionId,
    summaryFiles: summary.ok ? summary.files : null,
    ledgerEntries: plainObject(ledgerDoc) && plainObject(ledgerDoc.entries) ? ledgerDoc.entries : null,
    now,
  })
  if (plan.ok !== true) return { ok: false, code: 'DELETE_PLAN_FAILED', message: plan.reason }

  const exists = existsSync(plan.target)
  const id = randomUUID()
  // 播报用的补充说明（都只在"真出过事"时非空；正常路径下回执文案与 anima 那两句逐字相同）。
  const notes = []
  if (!summary.ok) notes.push(`没忘账本：${summary.reason} —— 下次入库可能跳过这些摘要`)
  if (exists) {
    try {
      renameSync(plan.target, plan.dest)
    } catch (e) {
      const message = `归档失败：${String((e && e.message) || e).slice(0, 160)}`
      // 归档失败也要留一张回执（失败也是一种事实，⛔ 不许静默）
      const receipt = makeResult({ id, action, ok: false, message, counts: { forgotten: 0 }, at: now })
      try { writeJsonAtomic(join(dir, PANEL_RESULT_FILE), receipt) } catch { /* 回执写不进去也不能改变"归档失败"这个事实 */ }
      return { ok: false, code: 'DELETE_FAILED', message, receipt }
    }
  }
  const forget = forgetLedgerEntries(ledgerPath, plan.forgetFiles)
  if (forget.note !== '') notes.push(forget.note)
  const message = deleteMessage(plan, { exists, forgotten: forget.forgotten })
    + (notes.length > 0 ? `；${notes.join('；')}` : '')
  const receipt = makeResult({ id, action, ok: true, message, counts: { forgotten: forget.forgotten }, at: now })
  let note = ''
  try {
    writeJsonAtomic(join(dir, PANEL_RESULT_FILE), receipt)
  } catch (e) {
    // 回执没落盘 ⇒ 面板「最近一次动作」看不到这次删除 ⇒ 调用方要把这句话带回响应里（⛔ 不静默）
    note = `回执没写成（${PANEL_RESULT_FILE}）：${String((e && e.message) || e).slice(0, 120)}`
  }
  return {
    ok: true,
    deleted: true,
    receipt,
    archived: exists ? plan.dest : null,
    requestConsumed: consumeSameActionRequest(dir, action),
    ledgerForgotten: forget.forgotten,
    note,
  }
}
