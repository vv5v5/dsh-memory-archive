// ---------------------------------------------------------------------------
// floor-snapshot —— 「**按楼层绑定**的笔记快照 + 回档跟随」的**纯逻辑内核**（20260923）。
//
// ## 为什么有它（用户 2026-09-23 原话）
// 「**能不能做按楼层绑定管理的功能，也就是每轮模型修改都记录，能自动跟随回档**」。
// 三件事：① 每轮把模型对周目笔记的改动**记一份**；② 每一份**绑在"楼层"上**（不是绑时间、
// 不是绑会话轮次）；③ 玩家**回档**（swipe 重 roll / 回到上一楼 / 换分支）时，笔记**自动跟着回去**。
//
// ## 锚 = 时间线的**节点 + 变体**（真机逐字查实，⛔ 不猜）
// `<Tavern 工作区>/<角色>/<周目>/timeline.json`：
//   `nodes[]` 每项 = **一楼**（`qa-<起事件>-<止事件>-<uuid>`），一次 swipe 重 roll = 同一节点多出一个
//   **变体**（`variants[]`，`adoptedVariantId` 是当前用的那支）；`head = {sessionId,nodeId,variantId}`
//   就是**当前站在哪一楼、哪一支**。⇒ 回档 = head 往回走 —— **可检测**。
//   ⚠️ 判据 = `head.nodeId` 与「新楼层在 `nodes` 里的**位置**」比前后（**⛔ 不用时间戳猜**）
//      ＋ **变体**（★ 2026-09-23 用户拍板：**同一楼换变体（swipe 重 roll）也算回档**）：
//      快照按 `(nodeId, variantId)` 记，换变体时恢复到"**这一支**"的快照。
//   · 老数据兼容：清单里**只有 nodeId、没有 variantId** 的条目 ⇒ 如实当作"这一楼不知道是哪一支"
//     （读得出来、只用于显示；⛔ **不许**拿它冒充某一支的快照去恢复 —— 见 `isRestorableFloor`）。
//
// ## 四条口径（用户拍板，⛔ 谁都不许"顺手做全"）
//   ① **只快照"模型维护的那几份"**：`notes.md` / `index.md` / `state.md` / `characters.md` / `world.md`
//      （唯一真相 = `FLOOR_FILES`）。作者预置那几份（`rulebook.md` / `世界观-*.md` / `大纲-*.md` /
//      `*示例.txt` / 开场白…）**一个字都不动** —— 回档**永不**自动改它们。
//   ② ★★ **2026-09-24 改口径（用户原话）**：「**不要做跟随楼层的功能，先做手动挡**，开 fork 时（回档）
//      **前台弹提示，让用户手动回退剧情档案**。做**更显著的更改表示**」。
//      ⇒ 判到回档**只提示、⛔ 那 5 份一个字节都不写**：往清单里记一条 `pending`（"剧情到了哪一楼、
//      档案还停在哪一楼"），面板档顶弹一条**显著**横幅，给**两个**动作：
//        · 「把档案退回第 N 楼」⇒ `restoreFloor`（`kind:'manual'` —— 与从前的"自动跟随"**同一份**
//          `runRestore`：恢复前先给"当下"再存一份快照，可撤销，并**如实播报**）—— **动正文**；
//        · 「保持现状」⇒ `settlePending`（★ 2026-09-24 用户口径「**就地登记**」）—— **不动正文**：
//          把**当下盘上那 5 份**的现文记成"剧情现在站的这一楼"那一份快照，并把 `last` 锚到它。
//      ⚠️ 为什么「保持现状」**必须**顺手锚 `last`（这是踩出来的，⛔ 别改回去）：记录侧只认
//      first/same/forward —— 判到"剧情在档案后面"那一支**够不到记录侧**。老口径下这不是问题，
//      因为判到回档就 `runRestore` 把 `last` 挪回目标楼、下一轮立刻变 `same`；改手动挡之后
//      `last` 原地不动 ⇒ ① 从回档点往后玩的**整段都不再记快照**（面板楼层数不涨）；② 每推到一个
//      "有快照、序号仍小于 `last`"的楼，target 变了 ⇒ **又弹一条横幅**。就地登记这两条一起治掉，
//      语义也对：跟 Tavern 一致 —— 回档之后那段历史就是没有了，"保持现状"＝认下这个新起点。
//      ⚠️ 面板上那条"静默写盘"的路已经**拆掉**：回档**永不**自己动笔记（老的"自动跟随"见 git 历史）。
//   ③ **与「死区」不矛盾**（见下）。④ 用户在面板里**直接编辑**过的文件 ⇒ 该楼层的快照**跟着刷新**
//      （用户自己改的当然算这一楼的样子，⛔ 不许因为"和记录不符"就被回档冲掉）。
//
// ## ★ 与「死区」（`./deadzone.js`）的关系 —— 这两件事**不打架**，各管一段
//   · 死区管的是**模型**：哪几段模型不许改写（⛔ 死区那半边**永不**自动还原，只告警）。
//   · 回档是**我们**按楼层快照恢复，而且**只恢复 `FLOOR_FILES` 那 5 份**、⛔ 绝不碰作者预置。
//   · ★ 2026-09-23 用户拍板（改口径）：**按块合并**（`mergeDeadzoneBlocks`），不再是"整份跳过" ——
//     同一份文件里：**快照里的非死区块照快照写**、**快照里的死区块保留盘上现况那一块**
//     （⛔ 一个字节都不动它）。这样 `index.md` 的「最近进展」能回档，而作者划的那几段永远不受影响。
//     判据**只有一处**：`.dma-deadzones.json` + `deadzone.js` 的 `splitBlocks`/`locateZone`
//     （先 sha、再首行）—— ⛔ 本模块不另立一份判据、⛔ 不改 `deadzone.js` 的对外语义。
//   · 盘上**找不到**那个死区块（用户自己删了）⇒ **不补回**（⛔ 不许把死区内容擅自写回去），如实播报。
//   · 死区数据**读不出来**（文件在、但不是合法 JSON）⇒ 死区名单/判据**未知** ⇒ **整次恢复不做**
//     （⛔ 宁可不动，也不赌"这份不在死区里"）—— fail-closed 照旧。
//
// ## 存哪儿（`<记忆库目录>/.dma-floor-snapshots/`，点开头、我们自己的名字，⛔ 不用 `.md`/`.txt`）
//   · `index.json` —— **只放清单**：`(楼层, 变体)` → 那 5 份各自的 `{name, sha256, bytes, changed, delta}`；
//     ＋ ★ 2026-09-24：`pending`（判到回档时记的那一条**待处理**，⛔ 不写正文）。
//     ⛔ **绝不把正文塞进 index.json**（那样每楼一份全文，几百楼就爆）。
//   · `<sha256>` —— 正文**内容寻址**一份一个文件（同内容只存一份，天然去重；⛔ 永不删）。
//   跟笔记同一处：用户会连目录一起拷到别的周目（与 `.dma-deadzones.json` 同一条纪律）。
//
// @license CC-BY-NC-4.0 (Attribution-NonCommercial 4.0 International)
// 仅限个人学习与非商业用途；禁止闭源商用或转为付费插件/服务。
// ---------------------------------------------------------------------------

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { locateZone, sha256Hex, splitBlocks, writeWithBackup } from './deadzone.js'

/** 快照目录名（点开头 ⇒ 面板清单/社区预设都不会当笔记读它，也不会列它）。 */
export const FLOOR_DIR_NAME = '.dma-floor-snapshots'
/** 清单文件名（**只有它**进那个目录的"结构"，其余都是内容寻址的正文）。 */
export const FLOOR_INDEX_NAME = 'index.json'
export const FLOOR_SCHEMA_VERSION = 1

/**
 * ★★ **能记 / 能恢复的就这 5 份**（唯一真相；⛔ 别在任何别处再写一遍这张表）。
 * 顺序 = 面板与日志里的展示顺序，也是 `planRecord` / `planRestore` 的遍历顺序。
 */
export const FLOOR_FILES = Object.freeze(['notes.md', 'index.md', 'state.md', 'characters.md', 'world.md'])

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (v) => (typeof v === 'string' ? v : '')
const numOrNull = (v) => (Number.isFinite(v) ? v : null)

// ---------------------------------------------------------------------------
// ① 纯逻辑（自检台直接吃这一层，⛔ 不碰文件系统）
// ---------------------------------------------------------------------------

/** 这一份是不是"模型维护的那几份"（★ 判据的唯一一处：记录、恢复、面板标注全走它）。 */
export function isFloorFile(name) {
  return typeof name === 'string' && FLOOR_FILES.includes(name)
}

/** 正文 blob 的文件名 = 它的 sha256（内容寻址；⛔ 不加扩展名 —— 免得被当笔记列出来）。 */
export function blobNameOf(sha) {
  return typeof sha === 'string' ? sha : ''
}

/** 空清单（还没有任何楼层 —— 这是**正常空态**，不是错误）。 */
export function emptyIndex() {
  return { schemaVersion: FLOOR_SCHEMA_VERSION, updatedAt: null, last: null, floors: [] }
}

/**
 * 一条文件记录归一（认不出 ⇒ `null`，调用方丢弃这一条）。
 * ★ `delta`（比上一份 + 几字节）只在"上一份也有它、且两边都读得到字节数"时才有值，其余 `null`
 *   —— ⛔ 不许编一个 0 出来冒充"没变"。
 */
export function normalizeFileRec(raw) {
  if (!isObj(raw)) return null
  const name = str(raw.name)
  if (!isFloorFile(name)) return null
  const sha = typeof raw.sha256 === 'string' && raw.sha256 !== '' ? raw.sha256 : null
  return {
    name,
    sha256: sha,
    bytes: sha === null ? null : numOrNull(raw.bytes),
    changed: raw.changed === true,
    delta: numOrNull(raw.delta),
  }
}

/** 一层楼归一（`nodeId` 是锚，缺它或文件表读不出来 ⇒ `null`）。 */
export function normalizeFloor(raw) {
  if (!isObj(raw)) return null
  const nodeId = str(raw.nodeId)
  if (nodeId === '') return null
  const files = []
  for (const f of Array.isArray(raw.files) ? raw.files : []) {
    const n = normalizeFileRec(f)
    if (n !== null) files.push(n)
  }
  return {
    nodeId,
    variantId: str(raw.variantId),
    seq: numOrNull(raw.seq),
    at: typeof raw.at === 'string' ? raw.at : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : (typeof raw.at === 'string' ? raw.at : null),
    files,
  }
}

/** ★ 快照的键 = `(楼层, 变体)`（唯一一处拼法；记录/查找/覆盖全走它）。 */
export function floorKeyOf(nodeId, variantId) {
  return str(nodeId) + '\u0000' + str(variantId)
}

/**
 * ★★ **待处理那一条**（2026-09-24 新口径：判到回档**只提示、不写盘**）归一。
 * 认不出（没有"退回哪儿"）⇒ `null`。字段就是"面板那条横幅 + 手动恢复那一脚"要用的那几个：
 *   · `from*`   = 判到回档那一刻**档案停在哪**（清单里的 `last`）；
 *   · `to*`     = 那一刻**剧情站到哪**（时间线的 `head` ＝ "回档到"的那一楼）；
 *   · `target*` = **要写回的那一份快照**（`source:'prev'`（退回"进这一楼之前"）时与上面两个都不同）；
 *   · `targetKey` = `floorKeyOf(target)` —— "**同一次回档**"的判据就是它（`settlePending` 也拿它比）。
 */
export function normalizePending(raw) {
  if (!isObj(raw)) return null
  const targetNodeId = str(raw.targetNodeId)
  if (targetNodeId === '') return null
  const targetVariantId = str(raw.targetVariantId)
  return {
    fromNodeId: str(raw.fromNodeId), fromVariantId: str(raw.fromVariantId), fromSeq: numOrNull(raw.fromSeq),
    toNodeId: str(raw.toNodeId), toVariantId: str(raw.toVariantId), toSeq: numOrNull(raw.toSeq),
    targetNodeId, targetVariantId, targetSeq: numOrNull(raw.targetSeq),
    why: raw.why === 'variant' ? 'variant' : 'back',
    source: raw.source === 'prev' ? 'prev' : 'self',
    targetKey: str(raw.targetKey) !== '' ? str(raw.targetKey) : floorKeyOf(targetNodeId, targetVariantId),
    at: typeof raw.at === 'string' && raw.at !== '' ? raw.at : null,
  }
}

/** 清单里那条**待处理**（没有 / 认不出 ⇒ `null`）。 */
export function pendingOf(index) {
  return normalizePending(isObj(index) ? index.pending : null)
}

/**
 * ★ 老条目（**只有 nodeId、没有 variantId**）= "这一楼**不知道是哪一支**"：
 * 读得出来、只用于显示；⛔ **不许**拿它冒充某一支的快照去恢复。
 */
export function isLegacyFloor(f) {
  return isObj(f) && str(f.nodeId) !== '' && str(f.variantId) === ''
}

/** ★ 这一条**能不能拿来恢复**（老条目只读不恢复；这一句就是那条纪律的唯一落点）。 */
export function isRestorableFloor(f) {
  return isObj(f) && str(f.nodeId) !== '' && str(f.variantId) !== ''
}

/**
 * 清单归一（认不出的楼层一律丢弃；同一 `(nodeId, variantId)` 只留**最后**一条）。
 * ★ 2026-09-24：`pending`（待处理那一条）也一起归一 —— 写清单是**整份替换**，
 *   漏带这个字段就等于每写一次把它抹掉（横幅会自己弹回来）。
 */
export function normalizeIndex(raw) {
  const floors = []
  const at = new Map()
  if (isObj(raw) && Array.isArray(raw.floors)) {
    for (const f of raw.floors) {
      const n = normalizeFloor(f)
      if (n === null) continue
      const key = floorKeyOf(n.nodeId, n.variantId)
      const i = at.get(key)
      if (i === undefined) { at.set(key, floors.length); floors.push(n) }
      else floors[i] = n
    }
  }
  const lastRaw = isObj(raw) ? raw.last : null
  const lastId = isObj(lastRaw) ? str(lastRaw.nodeId) : ''
  return {
    schemaVersion: FLOOR_SCHEMA_VERSION,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
    last: lastId === '' ? null : {
      nodeId: lastId,
      variantId: str(lastRaw.variantId),
      seq: numOrNull(lastRaw.seq),
      at: typeof lastRaw.at === 'string' ? lastRaw.at : null,
    },
    pending: normalizePending(isObj(raw) ? raw.pending : null),
    floors,
  }
}

/**
 * ★★ **这一次「楼同步」该怎么处置那条待处理**（纯函数；判据只此一处，⛔ 调用方不许自己判）。
 *
 * ```
 * 判到回档（rollback）                 ⇒ 记 / 更新那一条（"同一次回档"＝同一个 targetKey ⇒ ⛔ 不刷 at）
 * same / forward                      ⇒ 剧情已经不在"检测到回档"那个位置上了 ⇒ 清掉（提示过期了）
 * 其它（认不出版序 / 没 head / 清单坏） ⇒ **一个字节都不动**（fail-closed 照旧）
 * ```
 *
 * ⚠️ 为什么"清掉"这一支也要写盘：那条横幅说的是"剧情在第 X 楼、档案停在第 Y 楼"，
 *   剧情一旦离开那个位置，这句话就成了假的 —— 留着比清掉更危险（⛔ 不许挂一条假提示）。
 *
 * @param {{ index:object, head:object|null, decision:object, seq:number|null, at:string }} o
 * @returns {{ pending:object|null, changed:boolean, reason:string }} `changed:false` ⇒ 调用方**不写盘**。
 */
export function planPending(o) {
  const index = isObj(o?.index) ? o.index : {}
  const cur = pendingOf(index)
  const kind = str(o?.decision?.kind)
  const quiet = { pending: cur, changed: false, reason: 'quiet' }
  if (kind === 'unknown-order' || kind === 'no-head' || kind === 'index-error') return quiet
  if (kind === 'rollback') {
    const target = isObj(o?.decision?.target) ? o.decision.target : null
    if (target === null) return quiet
    const key = floorKeyOf(target.nodeId, target.variantId)
    const last = isObj(index.last) ? index.last : null
    const head = isObj(o?.head) ? o.head : null
    const next = normalizePending({
      fromNodeId: str(last?.nodeId), fromVariantId: str(last?.variantId), fromSeq: numOrNull(last?.seq),
      toNodeId: str(head?.nodeId), toVariantId: str(head?.variantId), toSeq: numOrNull(o?.seq),
      targetNodeId: str(target.nodeId), targetVariantId: str(target.variantId), targetSeq: numOrNull(target.seq),
      why: o?.decision?.why, source: o?.decision?.source,
      targetKey: key, at: typeof o?.at === 'string' ? o.at : null,
    })
    // ★ **幂等**：同一次回档每一轮都会被判到（组装 + 轮末各一次）⇒ 同一个 targetKey **不刷 `at`**
    //   （否则就是"每轮写盘"——用户口径里最不许的一条）；目标变了才更新那一条。
    const same = cur !== null && cur.targetKey === next.targetKey
    if (same) next.at = cur.at
    return {
      pending: next,
      changed: cur === null || JSON.stringify(cur) !== JSON.stringify(next),
      reason: same ? 'mark-same' : 'mark',
    }
  }
  if (cur === null) return { pending: null, changed: false, reason: 'none' }
  const headKey = floorKeyOf(o?.head?.nodeId, o?.head?.variantId)
  const stillThere = headKey === floorKeyOf(cur.toNodeId, cur.toVariantId)
  if (kind === 'same' || !stillThere) return { pending: null, changed: true, reason: 'stale' }
  return { pending: cur, changed: false, reason: 'keep' }
}

/** 某一楼的全部条目（**任意变体**，清单顺序 = 记账顺序）—— 展示与"前一楼最后一条"用。 */
export function floorsOfNode(index, nodeId) {
  const id = str(nodeId)
  if (id === '') return []
  return (Array.isArray(index?.floors) ? index.floors : []).filter((f) => f.nodeId === id)
}

/** 找某一楼**第一条**条目（任意变体）—— ⛔ 只给展示与夹具，恢复一律走 `floorOfVariant`。 */
export function floorOf(index, nodeId) {
  return floorsOfNode(index, nodeId)[0] ?? null
}

/**
 * ★★ 找 **`(N, V)` 这一支**的条目（**逐字相等**，空 `variantId` 也算一个键）。
 * ⚠️ 区分两件事：这一条**在不在**（本函数）与"能不能拿它恢复"（`isRestorableFloor`）。
 */
export function floorOfVariant(index, nodeId, variantId) {
  const id = str(nodeId)
  if (id === '') return null
  const key = floorKeyOf(id, variantId)
  return (Array.isArray(index?.floors) ? index.floors : []).find((f) => floorKeyOf(f.nodeId, f.variantId) === key) ?? null
}

/** 上次记录那一楼那一支的条目（`last` 指到的那一条；认不出 ⇒ `null`）。 */
export function baseFloorOf(index) {
  return floorOfVariant(index, index?.last?.nodeId, index?.last?.variantId)
}

/**
 * 某一楼**最后记过的那一条能恢复的快照**（清单顺序里的最后一条；老条目跳过）。
 * ★ 语义 = "**退回进这一楼之前**的样子"用的那一份（见 `decideRollback` 的第 b 步）。
 */
export function lastRestorableFloorOfNode(index, nodeId) {
  const list = floorsOfNode(index, nodeId).filter(isRestorableFloor)
  return list.length === 0 ? null : list[list.length - 1]
}

/** 把一条楼层记录放进清单（同一 `(nodeId, variantId)` ⇒ **就地替换**，其余顺序不动）。 */
export function upsertFloor(floors, floor) {
  const list = Array.isArray(floors) ? floors.slice() : []
  const key = floorKeyOf(floor?.nodeId, floor?.variantId)
  const i = list.findIndex((f) => floorKeyOf(f?.nodeId, f?.variantId) === key)
  if (i === -1) list.push(floor)
  else list[i] = floor
  return list
}

/** 时间线的 head（`{nodeId, variantId, sessionId}`；认不出 ⇒ `null`）。 */
export function headOf(timeline) {
  if (!isObj(timeline)) return null
  const head = isObj(timeline.head) ? timeline.head : null
  const nodeId = head === null ? '' : str(head.nodeId)
  if (nodeId === '') return null
  return { nodeId, variantId: str(head.variantId), sessionId: str(head.sessionId) }
}

/**
 * 时间线里 `nodes[]` 的**顺序**（一楼一个 id，从前往后）。
 * 畸形条目跳过；同一 `nodeId` 出现多次 ⇒ **先到者胜**（后到的重影不覆盖真实位置）。
 */
export function nodeOrderOf(timeline) {
  const order = []
  const seen = new Set()
  if (!isObj(timeline)) return order
  for (const node of Array.isArray(timeline.nodes) ? timeline.nodes : []) {
    if (!isObj(node)) continue
    const id = str(node.id)
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    order.push(id)
  }
  return order
}

/** 节点 → **楼层序号**（`nodes[]` 里的**位置** + 1，从 1 数 —— 重复/畸形条目也占位，⛔ 不压缩编号）。 */
export function seqMapOf(timeline) {
  const map = new Map()
  if (!isObj(timeline)) return map
  const nodes = Array.isArray(timeline.nodes) ? timeline.nodes : []
  nodes.forEach((node, i) => {
    if (!isObj(node)) return
    const id = str(node.id)
    if (id === '' || map.has(id)) return      // 同一 id 出现多次 ⇒ 先到者胜（重影不覆盖真实位置）
    map.set(id, i + 1)
  })
  return map
}

/** 节点在 `nodes[]` 里的位置（1 起）；不在里面 ⇒ `null`（⛔ 不猜一个数出来）。 */
export function seqOfNode(seqMap, nodeId) {
  const id = str(nodeId)
  if (id === '' || !(seqMap instanceof Map)) return null
  const seq = seqMap.get(id)
  return Number.isFinite(seq) ? seq : null
}

/**
 * **紧邻前一楼**（`nodes[]` 里 `N` 的前一个节点 id；`N` 是第一条 / 不在里面 ⇒ `null`）。
 * ★ 给"**退回进这一楼之前**的样子"用（见 `decideRollback` 的第 b 步）—— ⛔ 不拿时间戳猜。
 */
export function prevNodeOf(order, nodeId) {
  const id = str(nodeId)
  if (id === '' || !Array.isArray(order)) return null
  const i = order.indexOf(id)
  return i > 0 ? order[i - 1] : null
}

/**
 * ★★ **这一轮该不该回档**（纯函数；判据全在这一处）。
 *
 * ```
 * head 认不出 / head.nodeId 空            ⇒ no-head          （安静跳过：首轮还没楼层）
 * 还没有 last（我们一次都没记过）          ⇒ first            （记一份就好，⛔ 不回档）
 * 同一楼同一支                            ⇒ same             （没回档；⛔ 一个字节都不写）
 * 同一楼**换了变体**（swipe 重 roll）      ⇒ rollback（why:variant）
 * head 在 nodes[] 里**比 last 靠前**      ⇒ rollback（why:back）
 * head 在 nodes[] 里**不比 last 靠前**    ⇒ forward          （往前走；⛔ 不回档）
 * 两边有一个在 nodes[] 里找不到位置        ⇒ unknown-order    （⛔ 保守：什么都不动）
 * ```
 *
 * ★ **判定为回档之后**按这个顺序取快照（用户口径，⛔ 顺序不许换）：
 *   a) **`(N,V)` 自己有快照** ⇒ 用它（"回到我们记过的这一支"）；
 *   b) 没有（新变体 / 没记过）⇒ 用**紧邻前一楼**（`nodes` 里 `N` 的前一个）**最后一条**快照
 *      —— 语义 = **退回"进这一楼之前"的样子**（这一楼要重演，它那支的场记不该留在笔记里）；
 *   c) 连前一楼也没有（就是第一楼）⇒ **什么都不动** + 如实播报（`back-no-snapshot`）。
 *
 * ⚠️ 四条刻意的口径（都写在这儿，免得后人"顺手"改）：
 *   · **只用位置判前后**（`seqOf` 给的是 `nodes[]` 里的序号）—— ⛔ 不用时间戳：真机上时间戳会因
 *     导入/迁移/手改而乱，位置才是"哪一楼在前面"的事实。
 *   · **同一楼换变体算回档**（★ 2026-09-23 用户拍板）：快照按 `(N,V)` 记，换支时恢复到**这一支**的。
 *     两边只要有一边不知道变体（老记录）⇒ **不当成换变体**（保守：那一楼还是那一楼）。
 *   · 老条目（只有 nodeId）**只读不恢复**：第 a 步只认 `isRestorableFloor` 的条目。
 *   · `unknown-order`（认不出版序）⇒ **绝不动**：分不清"回档"还是"往前走"时，动笔记比不动更危险。
 *
 * @param {{ head:object|null, last:object|null, floors:Array, seqOf:(nodeId:string)=>number|null, prevOf?:(nodeId:string)=>string|null }} o
 * @returns {{ kind:string, target:object|null, source:'self'|'prev'|null, why:'back'|'variant'|null,
 *            seq:number|null, lastSeq:number|null, prevNodeId:string|null, legacyAtHead:boolean }}
 */
export function decideRollback(o) {
  const head = isObj(o?.head) ? o.head : null
  const floorId = str(head?.nodeId)
  const holder = { floors: Array.isArray(o?.floors) ? o.floors : [] }
  const seqOf = typeof o?.seqOf === 'function' ? o.seqOf : () => null
  const prevOf = typeof o?.prevOf === 'function' ? o.prevOf : () => null
  const headVar = str(head?.variantId)
  const lastVar = str(o?.last?.variantId)
  /** 这一楼有没有"只有 nodeId 的老记录"（回执据此如实说一句"老记录不能拿来恢复"）。 */
  const legacyAtHead = floorsOfNode(holder, floorId).some(isLegacyFloor)
  const idle = { target: null, source: null, why: null, seq: null, lastSeq: null, prevNodeId: null, legacyAtHead }
  const done = (kind, extra) => Object.assign({ kind }, idle, extra ?? {})
  if (floorId === '') return done('no-head')
  const lastId = str(o?.last?.nodeId)
  if (lastId === '') return done('first')
  const seq = seqOf(floorId)
  const lastSeq = seqOf(lastId)

  if (floorId === lastId) {
    // 两边都知道变体、且不一样 ⇒ 同一楼换了变体（swipe）⇒ 回档。
    // 有一边不知道变体（老记录）⇒ 不对着变体判（保守：那一楼还是那一楼）。
    if (headVar === '' || lastVar === '' || headVar === lastVar) return done('same', { seq, lastSeq })
    return resolveRollback({ holder, floorId, headVar, seq, lastSeq, prevNodeId: prevOf(floorId), why: 'variant', legacyAtHead })
  }
  if (seq === null || lastSeq === null) return done('unknown-order', { seq, lastSeq })
  if (seq >= lastSeq) return done('forward', { seq, lastSeq })
  return resolveRollback({ holder, floorId, headVar, seq, lastSeq, prevNodeId: prevOf(floorId), why: 'back', legacyAtHead })
}

/** 回档的目标那一份（**第 a 步 → 第 b 步 → 第 c 步**；顺序不许换）。 */
function resolveRollback(o) {
  const { holder, floorId, headVar, seq, lastSeq, prevNodeId, why, legacyAtHead } = o
  const self = floorOfVariant(holder, floorId, headVar)
  if (isRestorableFloor(self)) {
    return { kind: 'rollback', target: self, source: 'self', why, seq, lastSeq, prevNodeId, legacyAtHead }
  }
  const prev = lastRestorableFloorOfNode(holder, prevNodeId)
  if (prev !== null) {
    return { kind: 'rollback', target: prev, source: 'prev', why, seq, lastSeq, prevNodeId, legacyAtHead }
  }
  return { kind: 'back-no-snapshot', target: null, source: null, why, seq, lastSeq, prevNodeId, legacyAtHead }
}

/**
 * ★★ **该不该记**（纯函数）：拿这 5 份的现文与**参考那一份**（`base` = 上次记录的那一楼）逐份比 sha。
 *
 * 一模一样 ⇒ `changed:false`（⛔ 一个字节都不写、⛔ 不刷 index 的时间戳 —— 这是用户口径里最要紧的一条：
 * 不许每轮写盘）。有变化 ⇒ 给出**这一楼该有的清单条目** + 需要落盘的正文。
 *
 * ⚠️ 参考基**必须是"上次记录的那一楼"**（`index.last` 指到的那份），不是"head 那一楼已有的那份"：
 *   往前走时 head 那一楼往往**还没有**条目（新的），而"绕回去又往前"时它**有**旧条目
 *   —— 拿旧条目当基会把"被恢复成的样子"误记成那一楼的样子（把真快照冲掉）。
 *
 * ⚠️ `blobs` 给的是**这 5 份里读得到的全部正文**（不只是变化的那几份）：落盘那一层只写盘上**还没有**的
 *   （内容寻址 ⇒ 同内容只存一份），顺便自愈"某份 blob 被误删"—— 不然回档时会缺正文。
 *
 * @param {{ head:object|null, seq:number|null, at:string, fileTexts:Record<string,string|null>, base:object|null }} o
 * @returns {{ changed:boolean, reason:string, floor:object, blobs:Array }} `changed:false` 时 `floor/blobs` 也在
 *   （给自检台看"算出来的清单长什么样"），调用方**只认 changed**。
 */
export function planRecord(o) {
  const head = isObj(o?.head) ? o.head : null
  const nodeId = str(head?.nodeId)
  const at = typeof o?.at === 'string' && o.at !== '' ? o.at : null
  const fileTexts = isObj(o?.fileTexts) ? o.fileTexts : {}
  const baseFiles = new Map()
  for (const f of Array.isArray(o?.base?.files) ? o.base.files : []) {
    const n = normalizeFileRec(f)
    if (n !== null) baseFiles.set(n.name, n)
  }
  const files = []
  const blobs = []
  let changedAny = false
  for (const name of FLOOR_FILES) {
    const text = typeof fileTexts[name] === 'string' ? fileTexts[name] : null
    const sha = text === null ? null : sha256Hex(text)
    const bytes = text === null ? null : Buffer.byteLength(text, 'utf8')
    const prev = baseFiles.get(name) ?? null
    const prevSha = prev === null ? null : prev.sha256
    const changed = prevSha !== sha
    if (changed) changedAny = true
    const delta = changed && sha !== null && prevSha !== null && Number.isFinite(prev.bytes) ? bytes - prev.bytes : null
    files.push({ name, sha256: sha, bytes, changed, delta })
    if (sha !== null && text !== null) blobs.push({ sha256: sha, text, bytes })
  }
  // ⚠️ `nodeId` 空 ⇒ 认不出楼层：清单条目照给（自检台要看），但**判为没变化**（调用方据此不写）。
  const ok = nodeId !== '' && at !== null
  return {
    changed: ok && changedAny,
    reason: nodeId === '' ? 'no-head' : (at === null ? 'no-at' : (changedAny ? 'ok' : 'no-change')),
    floor: {
      nodeId, variantId: str(head?.variantId), seq: numOrNull(o?.seq), at,
      updatedAt: at, files,
    },
    blobs,
  }
}

/** 盘上还没有的那几份正文（内容寻址的真去重：同 sha 只落一份）。 */
export function missingBlobs(blobs, has) {
  const out = []
  const seen = new Set()
  for (const b of Array.isArray(blobs) ? blobs : []) {
    const sha = str(b?.sha256)
    if (sha === '' || seen.has(sha)) continue
    seen.add(sha)
    if (typeof has === 'function' && has(sha) === true) continue
    out.push(b)
  }
  return out
}

/**
 * 一份文本的**块边界**（与 `deadzone.splitBlocks` **逐块对齐**：同一分块判据 = 空行分块）。
 * `{start, bodyEnd}`：块正文 = `text.slice(start, bodyEnd)`（**逐字节取原文**，⛔ 不归一换行
 * —— 盘上是 CRLF 就照 CRLF 写回去）；块自己的换行与块间的空行都留在**分隔段**里。
 */
export function rawSpans(text) {
  const s = typeof text === 'string' ? text : ''
  const spans = []
  let head = -1
  let bodyEnd = -1
  const flush = () => { if (head !== -1) { spans.push({ start: head, bodyEnd }); head = -1; bodyEnd = -1 } }
  const re = /\r\n|\r|\n/g
  let from = 0
  let m = re.exec(s)
  for (;;) {
    const lineEnd = m === null ? s.length : m.index
    const next = m === null ? null : m.index + m[0].length
    if (s.slice(from, lineEnd).trim() === '') flush()
    else { if (head === -1) head = from; bodyEnd = lineEnd }
    if (m === null) break
    from = next
    m = re.exec(s)
  }
  flush()
  return spans
}

/**
 * ★★ **死区按块合并**（纯函数；★ 2026-09-23 用户拍板改的口径，取代上一版的"整份跳过"）。
 *
 * 用户原话：「死区块保留现状（你/模型写的都不动），同一份文件里**其余部分照快照回滚**。
 * 这样 `index.md` 的「最近进展」能回档，而你那两节规则永远不受影响。」
 *
 * 判据**只有一处**：`./deadzone.js` 的 `splitBlocks`（空行分块）与 `locateZone`（先 sha、再首行）
 * —— ⛔ 本模块不另立一份判据、⛔ 不改 `deadzone.js` 的对外语义。
 *
 * 逐块：
 *   · 快照里的**非死区块** ⇒ 照快照写（原文逐字节，含它自己的换行风格）；
 *   · 快照里的**死区块** ⇒ 取**盘上现况**那一块（`state` 是 `ok` 或 `changed` 都算"这一段还在"）；
 *   · 盘上**找不到**那条死区（用户自己删了）⇒ **不补回**（⛔ 不许把死区内容写回去）+ 如实报；
 *   · 盘上**有**、快照里没有的死区 ⇒ 也不能让这次整份覆盖带走它 ⇒ 补在**末尾** + 如实报
 *     （位置无从得知 —— 按块派生的顺序里它没有落点）。
 *
 * @param {{ snapText:string, nowText:string|null, zones:Array }} o
 *   `nowText` = 盘上现况（读不到 ⇒ `null`：那么每条死区都"找不到"⇒ 不补回）。
 * @returns {{ text:string, kept:Array<string>, dropped:Array<string>, appended:Array<string> }}
 *   `kept`/`dropped`/`appended` 装的是那几段的**首行摘要**（给人看；⛔ 正文不进回执）。
 */
export function mergeDeadzoneBlocks(o) {
  const snapText = typeof o?.snapText === 'string' ? o.snapText : ''
  const nowText = typeof o?.nowText === 'string' ? o.nowText : null
  const zones = (Array.isArray(o?.zones) ? o.zones : []).filter((z) => isObj(z))
  const kept = []
  const dropped = []
  const appended = []
  if (zones.length === 0) return { text: snapText, kept, dropped, appended }
  const snapSpans = rawSpans(snapText)
  const snapBlocks = splitBlocks(snapText)
  const nowBlocks = nowText === null ? null : splitBlocks(nowText)
  const nowSpans = nowText === null ? [] : rawSpans(nowText)
  const aligned = (spans, blocks) => spans.length === blocks.length
  const bodyOf = (text, spans, blocks, i) => (aligned(spans, blocks) && i >= 0 && i < spans.length
    ? text.slice(spans[i].start, spans[i].bodyEnd)
    : blocks[i].text)
  /** 这条死区在**快照**里的块下标（`null` = 快照里没有这一段的落点）。 */
  const inSnap = new Map()
  /** 这条死区在**盘上现况**里的块下标（`null` = 盘上找不到这一段）。 */
  const onDisk = new Map()
  for (const z of zones) {
    const a = locateZone(z, snapBlocks)
    inSnap.set(z, a.state === 'missing' ? null : a.blockIndex)
    const b = locateZone(z, nowBlocks)
    onDisk.set(z, b.state === 'missing' || b.state === 'missing-file' ? null : b.blockIndex)
  }
  const picked = new Map()   // 快照块下标 → zone（一条死区一块；先到者胜）
  const usedZone = new Set()
  const usedDisk = new Set()
  for (const z of zones) {
    const i = inSnap.get(z)
    if (i === null || picked.has(i) || usedZone.has(z)) continue
    picked.set(i, z)
    usedZone.add(z)
  }
  const parts = []
  const push = (s) => { if (s !== '') parts.push(s) }
  if (snapSpans.length === 0) {
    push(snapText)
  } else {
    // 逐块走快照；`pending` = 这一块**之前**那一段空白（引子/分隔，逐字节照快照）。
    // ⚠️ 死区块被整块跳过时，它**自己那一段空白也不留**（并入下一块的分隔）⇒ ⛔ 不凭空多出空行。
    let pending = snapText.slice(0, snapSpans[0].start)
    let droppedSince = false
    for (let i = 0; i < snapSpans.length; i++) {
      const zone = picked.get(i)
      let body = null
      if (zone === undefined) {
        body = bodyOf(snapText, snapSpans, snapBlocks, i)              // 非死区块 ⇒ 照快照写
      } else {
        const j = onDisk.get(zone)
        if (j === null || usedDisk.has(j)) {
          dropped.push(str(zone.firstLine))                            // 盘上找不到 ⇒ 不补回
        } else {
          usedDisk.add(j)
          kept.push(str(zone.firstLine))
          body = bodyOf(nowText, nowSpans, nowBlocks, j)                // 死区块 ⇒ 保留盘上现况那一块
        }
      }
      if (body !== null) {
        if (droppedSince && parts.length === 0) pending = ''            // 文件开头连着被删 ⇒ 不留空行
        push(pending)
        push(body)
        droppedSince = false
      } else {
        droppedSince = true
      }
      pending = i + 1 < snapSpans.length
        ? snapText.slice(snapSpans[i].bodyEnd, snapSpans[i + 1].start)
        : snapText.slice(snapSpans[i].bodyEnd)
    }
    push(pending)                                                       // 文件尾部（原样）
  }
  // 盘上有、快照里没有的死区：别让它被这次整份覆盖带走（位置无从得知 ⇒ 补在末尾，如实报）。
  const extras = []
  for (const z of zones) {
    if (usedZone.has(z)) continue
    const j = onDisk.get(z)
    if (j === null || usedDisk.has(j)) continue
    usedDisk.add(j)
    usedZone.add(z)
    appended.push(str(z.firstLine))
    extras.push(bodyOf(nowText, nowSpans, nowBlocks, j))
  }
  if (extras.length > 0) {
    const tail = parts.length > 0 && !parts[parts.length - 1].endsWith('\n') ? '\n\n' : '\n'
    parts.push(tail + extras.join('\n\n'))
  }
  return { text: parts.join(''), kept, dropped, appended }
}

/**
 * ★★ **恢复到哪一份**（纯函数）：把目标楼层那一份清单翻成"要写哪几份、写什么"，逐份裁决。
 *
 * 五条硬纪律（用户口径，⛔ 一条都不许松）：
 *   · **只认 `FLOOR_FILES`** —— 清单里混进别的名字（手改过的文档）⇒ `not-target` 跳过、⛔ 不写；
 *   · ★ **死区文件按块合并**（`mergeDeadzoneBlocks`，见上）⇒ `deadzone` 那一条如实报
 *     （语义 = "该文件有死区、已按块合并"，⛔ **不再是**"整份跳过"）；
 *   · 那一楼**本来就没有**这份（`sha256:null`）⇒ `absent-then` 跳过（⛔ **不删**现盘上那份：
 *     回档恢复不删任何东西）；
 *   · **写之前逐份比 sha**：现盘内容与目标那一份**逐字节相同** ⇒ `unchanged` 跳过（⛔ 不空写）；
 *   · 正文找不到（blob 被误删）⇒ `no-content` 跳过并**如实**报出去（⛔ 不许静默少写一份）。
 *
 * @param {{ floor:object, fileTexts:Record<string,string|null>, blobTexts:Record<string,string|null>, zones:Array|null }} o
 *   `zones` = 死区数据里那几条（`./deadzone.js` 的 `doc.zones`）；**`null` / 不传 = 判据未知**
 *   ⇒ 整次恢复不做（fail-closed，见文件头第 ③ 条 —— ⛔ 不许因为调用方忘了带就变成"那就整份写"）。
 * @returns {{ writes:Array, skipped:Array, blocked:string|null }}
 */
export function planRestore(o) {
  const floor = normalizeFloor(o?.floor)
  if (floor === null) return { writes: [], skipped: [], blocked: 'no-floor' }
  if (o?.zones === null || o?.zones === undefined) return { writes: [], skipped: [], blocked: 'deadzones-unreadable' }
  const zones = (Array.isArray(o?.zones) ? o.zones : []).filter((z) => isObj(z) && str(z.file) !== '')
  const now = isObj(o?.fileTexts) ? o.fileTexts : {}
  const blobs = isObj(o?.blobTexts) ? o.blobTexts : {}
  const writes = []
  const skipped = []
  for (const f of floor.files) {
    if (!isFloorFile(f.name)) { skipped.push({ name: f.name, reason: 'not-target' }); continue }
    if (f.sha256 === null) { skipped.push({ name: f.name, reason: 'absent-then' }); continue }
    const text = blobs[f.sha256]
    if (typeof text !== 'string') { skipped.push({ name: f.name, reason: 'no-content' }); continue }
    const cur = typeof now[f.name] === 'string' ? now[f.name] : null
    const mine = zones.filter((z) => str(z.file) === f.name)
    if (mine.length === 0) {
      if (cur !== null && sha256Hex(cur) === f.sha256) { skipped.push({ name: f.name, reason: 'unchanged' }); continue }
      writes.push({ name: f.name, sha256: f.sha256, text, bytes: Buffer.byteLength(text, 'utf8'), merged: false })
      continue
    }
    // ★ 这一份里有死区 ⇒ 逐块合并（非死区块照快照、死区块保留盘上现况那一块）。
    const merged = mergeDeadzoneBlocks({ snapText: text, nowText: cur, zones: mine })
    const note = {
      name: f.name, reason: 'deadzone',
      kept: merged.kept, dropped: merged.dropped, appended: merged.appended,
    }
    if (cur !== null && merged.text === cur) {
      // 合并之后与盘上现况**逐字节**一样 ⇒ 一个字节都不写（⛔ 不空写）。
      skipped.push(Object.assign({}, note, { merged: false }))
      continue
    }
    writes.push({
      name: f.name, sha256: sha256Hex(merged.text), text: merged.text,
      bytes: Buffer.byteLength(merged.text, 'utf8'), merged: true,
    })
    skipped.push(Object.assign({}, note, { merged: true }))
  }
  return { writes, skipped, blocked: null }
}

/**
 * 记忆库候选链里**该用哪一处**（纯函数）。
 *
 * 与读侧那条链（`resolveRpMemoryDir`：候选链里**第一个存在的目录**赢）的差别只有一个，但很要紧：
 * 那一处是**展示**口径，而快照/恢复要**写** —— 必须先认"**笔记与我们的数据在哪一处**"，
 * 否则会把快照写进一个空目录、而恢复时写的又不是模型在读的那一份（两处真相）。
 *
 * 打分：**有那 5 份里任一份**（+4）> **有我们的清单**（+2）> **有死区数据**（+1）；同分取候选链**靠前**的。
 * 一个候选都不是目录 ⇒ `null`（调用方安静跳过；⛔ 绝不替谁建目录）。
 *
 * @param {Array<{base:string, label:string, dir:string, hasNotes?:boolean, hasIndex?:boolean, hasDeadzone?:boolean, isDir?:boolean}>} cands
 * @returns {{ hit:object|null, score:number }}
 */
export function rankMemoryHomes(cands) {
  const list = Array.isArray(cands) ? cands : []
  let hit = null
  let score = -1
  for (const c of list) {
    if (!isObj(c) || c.isDir !== true) continue
    const s = (c.hasNotes === true ? 4 : 0) + (c.hasIndex === true ? 2 : 0) + (c.hasDeadzone === true ? 1 : 0)
    if (s > score) { hit = c; score = s }
  }
  return { hit, score }
}

/** 一份文件的"改了哪几份"人话（日志与回执用）。 */
export function fileChangeText(rec) {
  if (!isObj(rec)) return ''
  const name = str(rec.name)
  if (name === '') return ''
  if (rec.sha256 === null) return name + '（这一楼没有这份）'
  if (!Number.isFinite(rec.delta)) return name + '（' + String(rec.bytes) + ' 字节）'
  const d = rec.delta
  return name + '（' + (d >= 0 ? '+' : '') + String(d) + ' 字节）'
}

/** 一层楼的"改了哪几份"整句（只有真变化的那几份；一块都没有 ⇒ 空串）。 */
export function floorChangeText(floor) {
  const changed = (Array.isArray(floor?.files) ? floor.files : []).filter((f) => f.changed === true)
  return changed.map(fileChangeText).filter((s) => s !== '').join('、')
}

// ---------------------------------------------------------------------------
// ② 落盘（薄薄一层：读/写清单与正文 + 恢复时那一脚原子写）
// ---------------------------------------------------------------------------

/** 快照目录与清单的绝对路径（⛔ 只拼路径，不建目录）。 */
export function snapshotPaths(memoryDir) {
  const dir = join(memoryDir, FLOOR_DIR_NAME)
  return { dir, index: join(dir, FLOOR_INDEX_NAME) }
}

/**
 * 读清单。
 * @returns {{index:object, error:null|'unreadable'|'corrupt', exists:boolean}}
 *   文件不在 ⇒ 正常空态（`error:null / exists:false`）；**在但读不出来 / 不是合法 JSON ⇒ 如实报错**
 *   （⛔ 不许折成"没有快照" —— 那会让"回到这一楼"整个消失还不出声）。
 */
export function readIndex(memoryDir) {
  if (typeof memoryDir !== 'string' || memoryDir === '') return { index: emptyIndex(), error: null, exists: false }
  let raw
  try {
    raw = readFileSync(snapshotPaths(memoryDir).index, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return { index: emptyIndex(), error: null, exists: false }
    return { index: emptyIndex(), error: 'unreadable', exists: true }
  }
  try {
    return { index: normalizeIndex(JSON.parse(raw)), error: null, exists: true }
  } catch {
    return { index: emptyIndex(), error: 'corrupt', exists: true }
  }
}

/** 写清单（临时文件 + rename，与 `deadzone.writeDocFile` 同款原子写法）。 */
export function writeIndex(memoryDir, index) {
  const { dir, index: finalPath } = snapshotPaths(memoryDir)
  mkdirSync(dir, { recursive: true })
  const tmpPath = finalPath + '.tmp'
  writeFileSync(tmpPath, JSON.stringify(normalizeIndex(index), null, 2) + '\n', 'utf8')
  renameSync(tmpPath, finalPath)
  return finalPath
}

/** 这一处有没有我们的清单（只看在不在，**不解析** —— 判"哪一处才是本局的数据"用）。 */
export function indexExists(memoryDir) {
  if (typeof memoryDir !== 'string' || memoryDir === '') return false
  try { return statSync(snapshotPaths(memoryDir).index).isFile() } catch { return false }
}

/** 这份正文在盘上有没有（内容寻址 ⇒ 判断就是"这个 sha 的文件在不在"）。 */
export function blobExists(memoryDir, sha) {
  const name = blobNameOf(sha)
  if (name === '') return false
  try { return statSync(join(snapshotPaths(memoryDir).dir, name)).isFile() } catch { return false }
}

/** 写一份正文（临时文件 + rename；同 sha 已经在 ⇒ **不重写**）。 */
export function writeBlob(memoryDir, sha, text) {
  const name = blobNameOf(sha)
  if (name === '' || typeof text !== 'string') return { ok: false, reason: 'bad-blob' }
  if (blobExists(memoryDir, name)) return { ok: true, bytes: Buffer.byteLength(text, 'utf8'), existed: true }
  const { dir } = snapshotPaths(memoryDir)
  try {
    mkdirSync(dir, { recursive: true })
    const finalPath = join(dir, name)
    const tmpPath = finalPath + '.tmp'
    writeFileSync(tmpPath, text, 'utf8')
    renameSync(tmpPath, finalPath)
    return { ok: true, bytes: Buffer.byteLength(text, 'utf8'), existed: false }
  } catch (e) {
    return { ok: false, reason: String(e?.code || e?.message || e) }
  }
}

/** 读一份正文（⛔ 读不到就如实说读不到 —— 绝不拿空串冒充"这一楼是空的"）。 */
export function readBlob(memoryDir, sha) {
  const name = blobNameOf(sha)
  if (name === '') return { text: null, error: 'bad-sha' }
  try {
    return { text: readFileSync(join(snapshotPaths(memoryDir).dir, name), 'utf8'), error: null }
  } catch (e) {
    return { text: null, error: e && e.code === 'ENOENT' ? 'missing' : 'unreadable' }
  }
}

/** 读那 5 份的现文（读不到 ⇒ `null`，⛔ 别喂空串冒充"空文件"）。 */
export function readFloorTargets(memoryDir, names = FLOOR_FILES) {
  const out = {}
  for (const name of Array.isArray(names) ? names : FLOOR_FILES) {
    if (!isFloorFile(name)) continue
    try { out[name] = readFileSync(join(memoryDir, name), 'utf8') } catch { out[name] = null }
  }
  return out
}

/** 这 5 份里现盘上有哪几份（判"这一处是不是模型在写笔记的地方"用；⛔ 一个字节正文都不读）。 */
export function hasAnyFloorFile(memoryDir) {
  for (const name of FLOOR_FILES) {
    try { if (statSync(join(memoryDir, name)).isFile()) return true } catch { /* 不在就试下一份 */ }
  }
  return false
}

/**
 * **恢复那一脚**：把一份正文写回记忆库（⛔ 只写这 5 份里的名字）。
 *
 * 纪律（照 `deadzone.js` 那套）：
 *   · 文件**在** ⇒ 先备份 `<文件>.bak-<时间戳>`（复制留档，⛔ 绝不销毁）+ 写后回读校验（`writeWithBackup`）；
 *   · 文件**不在**（用户在盘外删过）⇒ 直接落一份（没有东西可备份；回执里 `created:true` 如实说）。
 * @returns {{ok:boolean, backup:string|null, created:boolean, bytes:number, reason:string}}
 */
export function writeRestoredFile(memoryDir, name, text, stamp) {
  if (!isFloorFile(name)) return { ok: false, backup: null, created: false, bytes: 0, reason: '不是那 5 份里的文件（拒写）' }
  if (typeof text !== 'string') return { ok: false, backup: null, created: false, bytes: 0, reason: '没有正文（拒写）' }
  const abs = join(memoryDir, name)
  let exists = false
  try { exists = statSync(abs).isFile() } catch { exists = false }
  if (exists) {
    const r = writeWithBackup(abs, text, stamp)
    return r.ok
      ? { ok: true, backup: r.backupPath, created: false, bytes: r.bytes, reason: '' }
      : { ok: false, backup: r.backupPath, created: false, bytes: 0, reason: r.reason }
  }
  try {
    writeFileSync(abs, text, 'utf8')
    const back = readFileSync(abs, 'utf8')
    if (back !== text) return { ok: false, backup: null, created: true, bytes: 0, reason: '写后回读校验不一致' }
    return { ok: true, backup: null, created: true, bytes: Buffer.byteLength(text, 'utf8'), reason: '' }
  } catch (e) {
    return { ok: false, backup: null, created: false, bytes: 0, reason: `写盘失败（${e?.code || e?.message || e}）` }
  }
}

// ---------------------------------------------------------------------------
// ③ 一次「楼同步」的编排（判回档 → **只记一条待处理** → 记录）
//
// 两个调用时机（同一份编排，⛔ 不两处各写一遍）：
//   · `mode:'watch'` —— 挂 `system-prompt/assemble`（**每轮至多一次**，排到本轮之外再跑）：
//     判回档、记那一跳待处理（★ 2026-09-24 改口径后**不恢复** —— 那 5 份一个字节都不写）。
//   · `mode:'turn'`  —— 挂 `session/event` 的 `turn/end` / `compaction/end`：判回档 + **记录**
//     （"每轮模型的改动都留一份"）。
//   ⚠️ 两处都跑不重复：判到同一次回档（同一个 targetKey）⇒ `planPending` 判为没变化、**不写盘**。
// ---------------------------------------------------------------------------

/**
 * ★★ **恢复那一脚**（★ 2026-09-24 起**只有面板「回到这一楼 / 把档案退回第 N 楼」**走它：
 * `kind` 恒为 `'manual'` —— 回档那一侧已改"手动挡"，⛔ 不再自己写那 5 份）。
 * 这一步是**那 5 份唯一的写入口**，⛔ 别处不许再开一个。
 *
 * 三步（顺序不许换）：
 *   ① **先给"当下"再存一份快照**（挂在"回档前"这个位置 = `last` 那一楼那一支，**可撤销**）；
 *   ② 把目标那一份的那几份**写回**去（逐份比 sha ⇒ 一样的跳过；写用原子写 + 写前备份；
 *      其中有死区的文件**按块合并** ⇒ 见 `planRestore`）；
 *   ③ `last` **跟到"恢复的那一份"**（`target` 自己的 `(N,V)`）。⚠️ 这一步非做不可：不跟的话下一轮
 *      还会把它判成"又一次回档" ⇒ 写盘循环。★ 一个微妙处：`source==='prev'`（退回进楼前）时
 *      `last` 跟的是**前一楼那一支** —— 这正是"这一楼要重演"，下一轮 head 在那楼上会判 `forward`
 *      并如实记下这一支的新样子。
 *      ⚠️ 但有哪一份**写失败**、或**整次被挡住**（死区数据读不出来）⇒ `last` **留在原地**
 *      （下一轮重试；⛔ 绝不"部分成功当全成功"，⛔ 也绝不"什么都没做当已经跟上了"）。
 *
 * @param {object} o `{ memoryDir, index, target, kind, source, why, head, seq, at, stamp, zones }`
 */
function runRestore(o) {
  const { memoryDir, index, target, kind } = o
  const at = typeof o?.at === 'string' && o.at !== '' ? o.at : new Date().toISOString()
  const notes = []
  const fileTexts = readFloorTargets(memoryDir)
  // ① 先给"当下"再存一份（⛔ 一模一样就不写 —— "不许每轮写盘"那条纪律在这儿同样成立）。
  const pre = planRecord({ head: index.last, seq: index.last?.seq ?? null, at, fileTexts, base: baseFloorOf(index) })
  let preWrote = false
  let floors = index.floors
  if (pre.changed) {
    for (const b of missingBlobs(pre.blobs, (sha) => blobExists(memoryDir, sha))) writeBlob(memoryDir, b.sha256, b.text)
    floors = upsertFloor(floors, pre.floor)
    preWrote = true
    notes.push('恢复前先把当下存了一份（第 ' + String(pre.floor.seq ?? '?') + ' 楼）：' + (floorChangeText(pre.floor) || '（无变化）'))
  }
  // ② 恢复目标那一份：正文从内容寻址的 blob 里取（哪几份要写由 `planRestore` 逐份裁决）。
  const need = (Array.isArray(target?.files) ? target.files : []).filter((f) => typeof f.sha256 === 'string' && f.sha256 !== '')
  const blobTexts = {}
  for (const f of need) if (!(f.sha256 in blobTexts)) blobTexts[f.sha256] = readBlob(memoryDir, f.sha256).text
  const plan = planRestore({ floor: target, fileTexts, blobTexts, zones: o?.zones })
  const stamp = typeof o?.stamp === 'string' && o.stamp !== '' ? o.stamp : at
  const moved = []
  const failed = []
  for (const w of plan.writes) {
    const r = writeRestoredFile(memoryDir, w.name, w.text, stamp)
    if (r.ok) moved.push({ name: w.name, sha256: w.sha256, bytes: r.bytes, backup: r.backup, created: r.created, merged: w.merged === true })
    else failed.push({ name: w.name, reason: r.reason })
  }
  // ③ `last` 跟到"恢复的那一份"（有写失败 ⇒ 留在原地，下一轮重来）。
  //   ★ 被挡住（死区数据读不出来）时**也留在原地**：那一脚"整次不做"= 状态也**不许前进**，
  //     否则下一轮 `head === last` 会被判成 `same`，而笔记还是旧内容 ⇒ 记录侧会拿它**盖掉**目标那一份
  //     （把回档的目标毒掉）。留在原地 ⇒ 下一轮还判回档、还试一次（回执有指纹门，不会刷屏）。
  let wrote = preWrote || moved.length > 0
  const seq = numOrNull(target.seq)
  // ③★ 2026-09-24：这一脚**成功**（一份都没失败、也没被死区挡住）⇒ 顺手清掉那条待处理
  //   （人在面板上点了「把档案退回第 N 楼」＝那条提示已经处理掉了）。
  //   ⛔ 没成功（有失败 / 被挡住）就**不清** —— 横幅该还在，下一轮还得重试。
  const done = failed.length === 0 && plan.blocked === null
  const clearedPending = done && pendingOf(index) !== null
  const keptPending = done ? null : pendingOf(index)
  if (done) {
    const last = { nodeId: target.nodeId, variantId: str(target.variantId), seq, at }
    // ⛔ 已经指着这一份、这次也没写别的东西 ⇒ **不重写清单**（手动点同一楼时别空刷一遍时间戳）。
    //   ⚠️ 唯一的例外是 `clearedPending`：那一次是**状态真的变了**（清掉待处理），⛔ 不落盘就等于没清。
    if (preWrote || clearedPending
      || index.last?.nodeId !== last.nodeId || index.last?.variantId !== last.variantId
      || index.last?.seq !== last.seq || index.last?.at === null) {
      writeIndex(memoryDir, {
        schemaVersion: FLOOR_SCHEMA_VERSION, updatedAt: at, last, floors,
        pending: keptPending,
      })
      wrote = true
    }
  } else if (preWrote) {
    writeIndex(memoryDir, {
      schemaVersion: FLOOR_SCHEMA_VERSION, updatedAt: at, last: index.last, floors,
      pending: keptPending,
    })
  }
  return {
    kind, at, wrote, pre: preWrote ? pre.floor : null, floors, record: null, notes,
    // ★ 2026-09-24：这一脚顺带清没清那条待处理（清过 ⇒ 上面的横幅该消失了）。
    pending: keptPending, pendingChanged: clearedPending,
    // 判据那一层的如实补充（回执/面板据此说清"为什么恢复 / 用的是哪一份"）。
    source: str(o?.source) === '' ? null : str(o?.source),
    why: str(o?.why) === '' ? null : str(o?.why),
    prevNodeId: str(o?.prevNodeId) === '' ? null : str(o?.prevNodeId),
    legacyAtHead: o?.legacyAtHead === true,
    restore: {
      target, seq, from: index.last,
      // ★ `headSeq` / `headVariantId` = 回档那一刻 head **站**在哪一楼哪一支（与 `seq` / `target.variantId`
      //   = 恢复用的那一份**不同** —— 只有 "退回进楼前"（source==='prev'）时才分得开）。
      //   回执/面板要说清"哪一楼/哪一支 → 恢复到哪一份"就得用它。
      headSeq: numOrNull(o?.seq),
      headVariantId: str(o?.head?.variantId),
      source: str(o?.source) === '' ? null : str(o?.source),
      why: str(o?.why) === '' ? null : str(o?.why),
      prevNodeId: str(o?.prevNodeId) === '' ? null : str(o?.prevNodeId),
      moved, skipped: plan.skipped, failed, blocked: plan.blocked,
      resolved: failed.length === 0,
    },
  }
}

/**
 * ★★ **面板「回到这一楼」/「把档案退回第 N 楼」**（手动 —— ★ 2026-09-24 起**这是那 5 份唯一的写入口**：
 * 回档那一侧只记一条待处理，⛔ 再不自己动笔）。
 * ⛔ 只认清单里真有的 `(nodeId, variantId)`（没有 ⇒ `no-snapshot`，**一个字节都不写**）；
 * ⛔ **老条目（只有 nodeId、不知道哪一支）拒恢复** ⇒ `legacy-no-restore`（一个字节都不写）。
 */
export function restoreFloor(o) {
  const memoryDir = typeof o?.memoryDir === 'string' ? o.memoryDir : ''
  const notes = []
  if (memoryDir === '') return { kind: 'no-dir', wrote: false, record: null, pre: null, restore: null, notes }
  const read = readIndex(memoryDir)
  if (read.error !== null) return { kind: 'index-error', error: read.error, wrote: false, record: null, pre: null, restore: null, notes }
  const target = floorOfVariant(read.index, o?.nodeId, o?.variantId)
  if (target === null) return { kind: 'no-snapshot', wrote: false, record: null, pre: null, restore: null, notes }
  if (!isRestorableFloor(target)) return { kind: 'legacy-no-restore', target, wrote: false, record: null, pre: null, restore: null, notes }
  return runRestore({
    memoryDir, index: read.index, target, kind: 'manual',
    source: 'self', why: null, head: o?.head, at: o?.at, stamp: o?.stamp, zones: o?.zones,
  })
}

/**
 * @param {object} o
 *   `{ memoryDir, mode:'watch'|'turn', head, seq, seqOf, prevOf, at, stamp, zones }`
 *   · `zones` = 死区数据里那几条（`./deadzone.js` 的 `doc.zones`）或 **`null` = 死区数据读不出来**
 *     （⇒ 恢复整次不做；记录侧不看死区数据）。
 * @returns {object} 回执（`kind` / `wrote` / `record` / `pre` / `restore` / `notes`）
 */
export function syncFloor(o) {
  const memoryDir = typeof o?.memoryDir === 'string' ? o.memoryDir : ''
  const mode = o?.mode === 'turn' ? 'turn' : 'watch'
  const at = typeof o?.at === 'string' && o.at !== '' ? o.at : new Date().toISOString()
  const notes = []
  if (memoryDir === '') return { kind: 'no-dir', wrote: false, record: null, pre: null, restore: null, notes }
  const read = readIndex(memoryDir)
  if (read.error !== null) return { kind: 'index-error', error: read.error, wrote: false, record: null, pre: null, restore: null, notes }
  const index = read.index
  const head = isObj(o?.head) ? o.head : null
  const seqOf = typeof o?.seqOf === 'function' ? o.seqOf : () => null
  const decision = decideRollback({ head, last: index.last, floors: index.floors, seqOf, prevOf: o?.prevOf })

  // ★★ 2026-09-24 改口径（用户拍板「**不要做跟随楼层的功能，先做手动挡**」）：
  //   判到回档 **只往清单里记一条待处理**（`pending`）—— ⛔ 那 5 份**一个字节都不写**、
  //   ⛔ 也不调 `restoreFloor`，写盘那一脚由**人在面板上点**（`restoreFloor`，唯一写入口）。
  //   判据（记 / 更新 / 清 / 一个字都不动）全在纯函数 `planPending` 里，⛔ 这里不自己判。
  const mark = planPending({ index, head, decision, seq: o?.seq ?? null, at })
  let wrote = false
  if (mark.changed) {
    writeIndex(memoryDir, {
      schemaVersion: FLOOR_SCHEMA_VERSION, updatedAt: at, last: index.last, floors: index.floors,
      pending: mark.pending,
    })
    wrote = true
  }
  // 判据那一层的如实补充（回执/面板据此说清"为什么没动 / 用的是哪一份 / 那条待处理是什么"）。
  const extras = {
    pending: mark.pending, pendingChanged: mark.changed,
    why: decision.why ?? null, source: decision.source ?? null,
    prevNodeId: decision.prevNodeId ?? null, legacyAtHead: decision.legacyAtHead === true,
    // ★ 判据那一层的两个楼号（回执文案说"从第几楼 → 第几楼"用；回档那一支没有 `restore` 可读）
    headSeq: numOrNull(decision.seq), lastSeq: numOrNull(decision.lastSeq),
  }
  const seat = (n) => (Number.isFinite(n) ? String(n) : '?')

  if (decision.kind === 'rollback') {
    // ⛔ 一个字节的笔记都不写：这一支**只是提示**（面板横幅 + 日志各一处，别的一律不动）。
    const p = mark.pending
    if (mark.changed && p !== null) {
      notes.push('检测到回档（第 ' + seat(p.fromSeq) + ' 楼 → 第 ' + seat(p.toSeq) + ' 楼）：'
        + '只记一条待处理、那 5 份一个字节都没写；要退回第 ' + seat(p.targetSeq) + ' 楼得由人在面板上点')
    }
    return Object.assign({ kind: 'rollback', at, wrote, record: null, pre: null, restore: null, notes }, extras)
  }

  // 记录侧（只有"轮末"那一脚记；watch 那一脚看到 first/same/forward 时**什么都不做**）。
  let record = null
  if (mode === 'turn' && (decision.kind === 'first' || decision.kind === 'same' || decision.kind === 'forward')) {
    const fileTexts = readFloorTargets(memoryDir)
    const plan = planRecord({ head, seq: o?.seq ?? null, at, fileTexts, base: baseFloorOf(index) })
    if (plan.changed) {
      for (const b of missingBlobs(plan.blobs, (sha) => blobExists(memoryDir, sha))) writeBlob(memoryDir, b.sha256, b.text)
      const floors = upsertFloor(index.floors, plan.floor)
      const last = { nodeId: plan.floor.nodeId, variantId: plan.floor.variantId, seq: plan.floor.seq, at }
      writeIndex(memoryDir, {
        schemaVersion: FLOOR_SCHEMA_VERSION, updatedAt: at, last, floors,
        pending: mark.pending,
      })
      wrote = true
      record = { floor: plan.floor, changed: plan.floor.files.filter((f) => f.changed === true).map((f) => f.name) }
      notes.push('记下第 ' + String(plan.floor.seq ?? '?') + ' 楼：' + (floorChangeText(plan.floor) || '（无变化）'))
    } else {
      record = { floor: plan.floor, changed: [] }
    }
  }
  return Object.assign({ kind: decision.kind, at, wrote, record, pre: null, restore: null, notes }, extras)
}

/**
 * ★★ **面板「保持现状」＝就地登记**（2026-09-24 用户口径：跟 Tavern 一致，回档之后那段历史就是没有了）。
 *
 * 做三件事（顺序不许换）：
 *   ① 把**当下盘上那 5 份**的现文记成 **(pending.toNodeId, pending.toVariantId)** 那一支的快照
 *      （`planRecord` 算条目 + 落 blob + `upsertFloor`）—— 语义：**"剧情现在站的这一楼，档案就长这样"**；
 *   ② `last` 锚到那一支（＝ 档案就地对齐到当前这一楼）；
 *   ③ 清掉那条待处理。
 *
 * ⛔ **那 5 份正文一个字节都不写**（只读它们）、⛔ 不碰会话/归档/Tavern。
 *
 * ⚠️ 为什么①必须做、⛔ 别改成"只挪 `last`"：账上写"第 N 楼的样子"就得真是盘上这份 ——
 *   只挪指针会让后面回档到第 N 楼时恢复出**第一遍玩时那份**（跟盘上的现况对不上）。
 * ⚠️ 为什么②必须做（这是本函数存在的理由）：记录侧只认 first/same/forward；`last` 不跟着走
 *   ⇒ 判据每一轮都还判"回档" ⇒ ① 之后整段都不记快照、② 每推一楼重弹一条横幅。见文件头 ②。
 *
 * @returns {{ ok:boolean, changed:boolean, settled:object|null, reason:string }}
 *   `settled` = 登记成了哪一支（`{nodeId, variantId, seq}`）；`changed:false` ⇒ 盘上没动过。
 */
export function settlePending(memoryDir, o) {
  const dir = typeof memoryDir === 'string' ? memoryDir : ''
  const miss = (reason) => ({ ok: false, changed: false, settled: null, reason })
  if (dir === '') return miss('no-dir')
  const read = readIndex(dir)
  if (read.error !== null) return miss(read.error)
  const cur = pendingOf(read.index)
  if (cur === null) return { ok: true, changed: false, settled: null, reason: 'no-pending' }
  const nodeId = str(cur.toNodeId)
  if (nodeId === '') return miss('no-head')   // 那条待处理自己就认不出"剧情站在哪一楼" ⇒ 拒改
  const at = typeof o?.at === 'string' && o.at !== '' ? o.at : new Date().toISOString()
  const settled = { nodeId, variantId: str(cur.toVariantId), seq: numOrNull(cur.toSeq) }
  // ① 把盘上现文记成这一支那一份（⛔ 只读；`planRecord` 这里只用来算条目与正文，`changed` 不看）
  const plan = planRecord({
    head: { nodeId, variantId: settled.variantId }, seq: settled.seq, at,
    fileTexts: readFloorTargets(dir), base: baseFloorOf(read.index),
  })
  for (const b of missingBlobs(plan.blobs, (sha) => blobExists(dir, sha))) writeBlob(dir, b.sha256, b.text)
  // ② + ③ 一次性落盘（整份替换：`last` / `floors` / `pending` 三样一起给全）
  writeIndex(dir, {
    schemaVersion: FLOOR_SCHEMA_VERSION, updatedAt: at,
    last: { nodeId, variantId: settled.variantId, seq: settled.seq, at },
    floors: upsertFloor(read.index.floors, plan.floor),
    pending: null,
  })
  return { ok: true, changed: true, settled, reason: '' }
}

export default {
  FLOOR_DIR_NAME, FLOOR_INDEX_NAME, FLOOR_SCHEMA_VERSION, FLOOR_FILES,
  isFloorFile, blobNameOf, emptyIndex, normalizeFileRec, normalizeFloor, normalizeIndex,
  floorKeyOf, isLegacyFloor, isRestorableFloor, normalizePending, pendingOf, planPending,
  floorsOfNode, floorOf, floorOfVariant, baseFloorOf, lastRestorableFloorOfNode, upsertFloor,
  headOf, nodeOrderOf, seqMapOf, seqOfNode, prevNodeOf,
  decideRollback, planRecord, missingBlobs, rawSpans, mergeDeadzoneBlocks, planRestore, rankMemoryHomes,
  fileChangeText, floorChangeText,
  snapshotPaths, readIndex, writeIndex, indexExists, blobExists, writeBlob, readBlob,
  readFloorTargets, hasAnyFloorFile, writeRestoredFile, restoreFloor, syncFloor, settlePending,
}
