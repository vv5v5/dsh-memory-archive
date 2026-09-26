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
//      档案还停在哪一楼"），面板档顶弹一条**显著**横幅 ＋ 一条**常驻状态行**，给**三颗**动作
//      （★ 2026-09-25 口径：那一排就这三件；"把档案退回"**不在这排里**了 —— 那个动作仍然在
//      **楼层清单每一行的「回到这一楼」**里，走 `restoreFloor`）：
//        · 「**对齐楼层**」⇒ `settlePending(mode:'full')`（＝从前的"就地登记 / 保持现状"）—— **不动正文**：
//          把**当下盘上那 5 份**的现文记成"剧情现在站的这一楼"那一份快照，并把 `last` 锚到它；
//        · 「**只对齐楼号**」⇒ ★ 2026-09-25 新增：`settlePending(mode:'number')` —— 只把 `last` 锚到
//          当前这一楼（⛔ 不记快照、⛔ 不写 blob、⛔ 不新增楼层行）—— **不动正文**；
//        · 「**不处理**」（＋ ✕，同一个动作）⇒ `…/floors/pending/ack`：清掉那条提示 ＋ `seen ← head`。
//      ⚠️ 「把档案退回第 N 楼」⇒ `restoreFloor`（`kind:'manual'` —— 与从前的"自动跟随"**同一份**
//      `runRestore`：恢复前先给"当下"再存一份快照，可撤销，并**如实播报**）—— **动正文**；
//      它现在只从**楼层清单每一行**那颗「回到这一楼」进（那一排本单一个字都没动）。
//      ⚠️ 为什么「对齐楼层 / 只对齐楼号」**必须**顺手锚 `last`（这是踩出来的，⛔ 别改回去）：记录侧只认
//      first/same/forward —— 判到"剧情在档案后面"那一支**够不到记录侧**。老口径下这不是问题，
//      因为判到回档就 `runRestore` 把 `last` 挪回目标楼、下一轮立刻变 `same`；改手动挡之后
//      `last` 原地不动 ⇒ ① 从回档点往后玩的**整段都不再记快照**（面板楼层数不涨）；② 每推到一个
//      "有快照、序号仍小于 `last`"的楼，target 变了 ⇒ **又弹一条横幅**。就地登记这两条一起治掉，
//      语义也对：跟 Tavern 一致 —— 回档之后那段历史就是没有了，"保持现状"＝认下这个新起点。
//      ⚠️ 面板上那条"静默写盘"的路已经**拆掉**：回档**永不**自己动笔记（老的"自动跟随"见 git 历史）。
//   ③ **与「死区」不矛盾**（见下）。④ 用户在面板里**直接编辑**过的文件 ⇒ 该楼层的快照**跟着刷新**
//      （用户自己改的当然算这一楼的样子，⛔ 不许因为"和记录不符"就被回档冲掉）。
//   ⑤ ★★ **2026-09-24 收尾：提示的判据从「档案 vs 剧情」换成「开 fork」**（用户原话：「回档我没看到有横幅。」
//      ＋「**开 fork 时（回档）前台弹提示**」）。真机现场（2026-09-24）：档案 `last` = 第 34 楼、剧情 `head` =
//      第 38 楼 ⇒ 老判据（`decideRollback`：只有"剧情退到**档案后面**"才算回档）恒为 `forward` ⇒ **横幅这辈子
//      不弹** —— 因为用户的用法是"**剧情回档 → 手动把档案也退回去**"，档案**总在剧情后面**。
//      ⇒ 新判据 `decideFork`：**「开 fork」= 剧情站的楼，比我们上次认过的那个位置退了回去（或同一楼换了一支）**，
//      与"档案在哪一楼"**无关**。基准叫 **`seen`**（"上次认过的剧情位置"，存在宿主那边的簿记文件里，见 `lib/index.js`）：
//        · 剧情**往前走**（head 在 seen 后面）⇒ `seen` **自动跟上**（`seen ← head`）；
//        · 剧情**退回去 / 同一楼换支** ⇒ **开 fork** ⇒ 记一条 `pending`、面板弹横幅；**`seen` 不动**（所以横幅挂得住）；
//        · 用户点了「对齐楼层」「只对齐楼号」「不处理」⇒ **算认过了** ⇒ `seen ← head`。
//      ⚠️ 判据**只此一处**（纯函数 `decideFork`）—— ⛔ 调用方不许自己判（与 `decideRollback` 同一条纪律）。
//      ⚠️ `decideRollback` **照旧**留着：它决定的**不是"要不要提示"，而是"有没有一份可以退回"**（`target`）。
//        没有可退回的那一份是**正常状态**（⛔ 不许编一个目标出来）—— 那时横幅照弹；★ 2026-09-25 起那一排
//        **不给**「把档案退回」那颗按钮（它只在**楼层清单每一行**的「回到这一楼」那边），`target` 因此只剩
//        回执/日志那一处用途。
//      ⚠️ 顺带治掉一个时序洞：检测原先只在轮边界（组装那一脚 / 轮末那一脚）跑 ⇒ 回档之后**没发消息、直接开面板看**
//        的那一次检测根本没发生 ⇒ 面板开档时走 `POST …/floors/scan` 现补一次（见 `lib/index.js` 那两条端点）。
//
// ## ⑥ ★★ 2026-09-25 收尾（用户口径两条，逐字）——
//   「**插件自己按时间编一个序号，不论实际seq，这样反而符合直觉，序号最大的就是最新生成的**」
//   「**开一个下钻，直接显示具体改动的字段，写改了哪些可以说完全没用**」
//   ⇒ 两件事都落在**展示**这一层，⛔ 一条判据都没动：
//     · **`ordinal`**（`ordinalOrderOf` / `ordinalMapOf` / `ordinalOfFloor`）—— 面板上那个「序号 N」。
//       把这一周目**全部**楼层行按**记录时间**（行上的 `at`）**升序**编号 `1..N`（`N` = 最新）；
//       并列用既有那个确定性次序（`nodeId` → `variantId` → `at`）破；老记录照样进编号；
//       `at` 认不出 ⇒ 排最后、序号如实为 `null`（面板写「序号未知」，⛔ 不编 0）。
//       ⚠️ **Tavern 那个 `seq` 一个字节都不许改语义**（判 fork / 对齐 / 状态文件全还靠它）——
//       两件事各管一段：`seq` 是"在时间线里第几楼"，`ordinal` 是"这是第几版笔记"。
//     · **行级 diff**（`diffTextLines` / `diffFloorFiles`，纯函数）—— 那一行那颗「看改动 ▸」下钻要的
//       **真内容**：增行 / 删行 ＋ 一点点上下文，`\r\n` 与结尾换行当同一件事，超长按行数/字节/单行三个
//       上限截断并如实标 `truncated`；正文读不出来 ⇒ `kind:'unreadable'`（⛔ 绝不画成"没改动"）。
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

/**
 * 空清单（还没有任何楼层 —— 这是**正常空态**，不是错误）。
 * ★ 2026-09-24：`pending` 也在这里给成 **`null`**（不是"没有这个键"）—— 否则"文件还不存在"那条路
 *   （`readIndex` 走 `emptyIndex()`）读出来的 `pending` 是 **`undefined`**，与"有清单但没待处理"时的
 *   `null` **形状不一致**：判据里 `p === null` 会漏判，台子那条 `beforePending === null` 也会假红。
 */
export function emptyIndex() {
  return { schemaVersion: FLOOR_SCHEMA_VERSION, updatedAt: null, last: null, pending: null, floors: [] }
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
 * ★★ **`seen`**（"上次认过的剧情位置"）归一 —— 形状与 `normalizePending` 的 `from*` 那半边一样：
 * `{nodeId, variantId, seq, at}`；`nodeId` 认不出 ⇒ `null`（认不出的基准当**没有基线**，⛔ 不猜）。
 *
 * ⚠️ 存哪儿不归这个模块管：宿主把它落在**我们自己的簿记文件** `<storageDir>/floor-head.json` 的
 *   `byPlaythrough[周目id]` 里（⛔ 不塞进周目目录的 `index.json` —— 那是用户的账）。
 */
export function normalizeSeen(raw) {
  if (!isObj(raw)) return null
  const nodeId = str(raw.nodeId)
  if (nodeId === '') return null
  return {
    nodeId,
    variantId: str(raw.variantId),
    seq: numOrNull(raw.seq),
    at: typeof raw.at === 'string' && raw.at !== '' ? raw.at : null,
  }
}

/**
 * ★★ **待处理那一条**（2026-09-24 新口径：判到回档**只提示、不写盘**）归一。
 * 认不出（"剧情现在站在哪一楼"读不出来）⇒ `null`。字段就是"面板那条横幅 + 手动恢复那一脚"要用的那几个：
 *   · `from*`    = 判到**开 fork** 那一刻**剧情之前站的那一楼**（`seen`，"上次认过的位置"）；
 *   · `to*`      = 那一刻**剧情现在站在哪一楼**（时间线的 `head` ＝ "回档到"的那一楼）；
 *   · `archive*` = ★ 那一刻**档案停在哪一楼**（清单里的 `last`）—— 横幅要**如实说出来**，⛔ 不拿 from 冒充；
 *   · `target*`  = **要写回的那一份快照** —— ★ **可以没有**（"没有可退回的那一份"是正常状态：目标在剧情后面、
 *     或那一楼那一支没记过、或根本没有快照）⇒ 那时三个字段都是空/`null`，⛔ **不许编一个**；
 *   · `targetKey` = `floorKeyOf(target)`；**没有 target 时** = `floorKeyOf(head)` —— "**同一次 fork**"的判据就是它。
 *
 * ⚠️ 认得出的判据是 **`toNodeId`**（2026-09-24 起）：`target*` 允许缺，`to*` 才是"这条提示说的是哪一楼"。
 */
export function normalizePending(raw) {
  if (!isObj(raw)) return null
  const toNodeId = str(raw.toNodeId)
  if (toNodeId === '') return null
  const toVariantId = str(raw.toVariantId)
  const targetNodeId = str(raw.targetNodeId)
  // ★ 没有 target（`targetNodeId` 空）⇒ `targetSeq` 一并为 `null`：免得面板拿一个楼号去画"退回第 N 楼"那颗
  //   按钮，而那一份根本不存在（那种按钮点下去只会 404）。
  const targetSeq = targetNodeId === '' ? null : numOrNull(raw.targetSeq)
  return {
    fromNodeId: str(raw.fromNodeId), fromVariantId: str(raw.fromVariantId), fromSeq: numOrNull(raw.fromSeq),
    toNodeId, toVariantId, toSeq: numOrNull(raw.toSeq),
    archiveNodeId: str(raw.archiveNodeId), archiveVariantId: str(raw.archiveVariantId), archiveSeq: numOrNull(raw.archiveSeq),
    targetNodeId, targetVariantId: str(raw.targetVariantId), targetSeq,
    why: raw.why === 'variant' ? 'variant' : 'back',
    source: raw.source === 'prev' ? 'prev' : 'self',
    targetKey: str(raw.targetKey) !== ''
      ? str(raw.targetKey)
      : (targetNodeId !== '' ? floorKeyOf(targetNodeId, str(raw.targetVariantId)) : floorKeyOf(toNodeId, toVariantId)),
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
 * 开 fork（`fork.kind === 'fork'`）      ⇒ 记 / 更新那一条（"同一次 fork"＝同一个 targetKey ⇒ ⛔ 不刷 at）
 * 其它（same / forward / 认不出版序 / 没 head / 没基线）⇒ 剧情已经不在"开 fork"那个位置上了
 *                                        ⇒ 那条提示过期：没有 ⇒ **一个字节都不写**；有 ⇒ **清掉**
 * ```
 *
 * ⚠️ 2026-09-24 收尾改口径：触发的判据从 `decision.kind === 'rollback'`（档案 vs 剧情）换成
 *   **`fork.kind === 'fork'`**（剧情 vs `seen`）—— 老判据在真机上恒为 `forward`（见文件头 ⑤），横幅不弹。
 *   `decision` 现在只回答一件事：**有没有一份可以退回**（`target`）。⛔ 没有就**不编**（三个 `target*` 留空）。
 * ⚠️ 为什么"清掉"这一支也要写盘：那条横幅说的是"剧情在第 X 楼、档案停在第 Y 楼"，
 *   剧情一旦离开"开 fork"那个位置，这句话就成了假的 —— 留着比清掉更危险（⛔ 不许挂一条假提示）。
 *   ⚠️ 反过来说：**判不出先后（`unknown-order`）也照清**（本单拍板：这一刻那条提示已经无从核实 ⇒ 宁可清掉，
 *     也不挂一条可能是假的；清掉的只是**我们自己的提示**，⛔ 那 5 份一个字节都不碰）。
 *
 * @param {{ index:object, head:object|null, seen:object|null, fork:object, decision:object, seq:number|null, at:string }} o
 * @returns {{ pending:object|null, changed:boolean, reason:string }} `changed:false` ⇒ 调用方**不写盘**。
 */
export function planPending(o) {
  const index = isObj(o?.index) ? o.index : {}
  const cur = pendingOf(index)
  if (str(o?.fork?.kind) !== 'fork') {
    if (cur === null) return { pending: null, changed: false, reason: 'none' }
    return { pending: null, changed: true, reason: 'stale' }
  }
  const seen = normalizeSeen(o?.seen)
  const head = isObj(o?.head) ? o.head : null
  const decision = isObj(o?.decision) ? o.decision : {}
  // ★ 只有真判到"能退回哪一份"时才给 target（`decideRollback` 认成 rollback ⇒ 它自己已经挑好了那一份）。
  const target = decision.kind === 'rollback' && isObj(decision.target) ? decision.target : null
  const last = isObj(index.last) ? index.last : null
  const next = normalizePending({
    fromNodeId: str(seen?.nodeId), fromVariantId: str(seen?.variantId), fromSeq: numOrNull(seen?.seq),
    toNodeId: str(head?.nodeId), toVariantId: str(head?.variantId), toSeq: numOrNull(o?.seq),
    archiveNodeId: str(last?.nodeId), archiveVariantId: str(last?.variantId), archiveSeq: numOrNull(last?.seq),
    targetNodeId: target === null ? '' : str(target.nodeId),
    targetVariantId: target === null ? '' : str(target.variantId),
    targetSeq: target === null ? null : numOrNull(target.seq),
    why: o?.fork?.why, source: decision.source,
    targetKey: target === null
      ? floorKeyOf(head?.nodeId, head?.variantId)
      : floorKeyOf(target.nodeId, target.variantId),
    at: typeof o?.at === 'string' ? o.at : null,
  })
  // ★ **幂等**：同一次 fork 每一轮都会被判到（组装 + 轮末各一次）⇒ 同一个 targetKey **不刷 `at`**
  //   （否则就是"每轮写盘"——用户口径里最不许的一条）；那次 fork 的落点变了才更新那一条。
  const same = cur !== null && cur.targetKey === next.targetKey
  if (same) next.at = cur.at
  return {
    pending: next,
    changed: cur === null || JSON.stringify(cur) !== JSON.stringify(next),
    reason: same ? 'mark-same' : 'mark',
  }
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

// ---------------------------------------------------------------------------
// ①b ★★ 2026-09-25（用户口径，逐字）：「**插件自己按时间编一个序号，不论实际seq，这样反而符合直觉，
//     序号最大的就是最新生成的**」 ⇒ **`ordinal`**（面板上那个「序号 N」）。
//
// 为什么不拿 Tavern 的 `seq`：用户原话「**不要楼号了，基本没用，只标序号**」—— `seq` 是
//   `nodes[]` 里的**位置**，回档 / 换支 / 同一楼多支之后，它跟"这几份笔记是哪一版"根本对不上号
//   （用户回档到很早以前时，`seq` 小的一行反而是**最新记的**那一版）。⇒ 面板要的是"哪一版更新"，
//   而那个的真凭据是**记录时间**（行上的 `at`）。
//
// ⚠️ 两件事各管一段，⛔ 谁都别替谁（这是本单最容易踩坏的一条）：
//   · `seq`     —— **照旧一个字节都不许改语义**：判 fork / 对齐 / 状态文件还全靠它；
//   · `ordinal` —— **纯展示**：把这一周目**全部**楼层行按记录时间**升序**编号 `1..N`（`N` = 最新）。
//
// 编号规则（判据**只此一处**；⛔ 面板与别的调用方不许自己排、不许自己编一个号）：
//   · 认得出 `at` 的行 ⇒ 按 `(at, nodeId, variantId)` **升序**编号 `1..N`；
//   · **并列**（`at` 相同）⇒ 用既有那个确定性次序（`nodeId` → `variantId` → `at`）破并列
//     ⇒ ⛔ 不出现两行同号（键 = `(nodeId, variantId)`，清单本身就按这个键去重）；
//   · **老记录**（`legacy`，只有 nodeId）**照样进编号**（按它自己的 `at` —— 它也是"记过的一版"）；
//   · `at` 认不出（没有 / 不是时间戳形状 / 解析不出来）⇒ 排在最后，**序号如实为 `null`** ——
//     面板照实写「序号未知」，⛔ **不编一个 0 出来**（用户口径里点过名的两条之一）。
// ---------------------------------------------------------------------------

/**
 * `at` 的毫秒数（认不出 ⇒ `null`）。
 * ⚠️ 只认形如 `2026-09-25T…` 的**时间戳字符串** —— ⛔ 不拿 `Date.parse` 去猜自由文本
 *   （`Date.parse('2026-9-5')` 在多数引擎里是能过的，那等于把"随便一段字"也当时间）。
 */
export function floorAtMillis(at) {
  const s = str(at)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s)) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

/**
 * 楼层行的**确定性次序**（`nodeId` → `variantId` → `at`）—— 破并列用的那一份，⛔ 不拿 `seq`。
 * （与旧版清单排序里那三级回退**同源**，只是把第一级的 `seq` 换成了时间口径。）
 */
export function compareFloorOrder(a, b) {
  const na = str(a?.nodeId)
  const nb = str(b?.nodeId)
  if (na !== nb) return na.localeCompare(nb)
  const va = str(a?.variantId)
  const vb = str(b?.variantId)
  if (va !== vb) return va.localeCompare(vb)
  return str(a?.at).localeCompare(str(b?.at))
}

/**
 * 楼层行的**序号次序**（**升序**：最老的在前、最新的是最后一条）。
 * @param {Array<object>} floors 清单里那些行（`normalizeIndex().floors` 的同一份）
 * @returns {Array<{floor:object, ordinal:number|null}>}
 *   `ordinal` = `1..N`（`N` = 最新）；认不出 `at` 的行排在**最后**、`ordinal` 如实为 `null`。
 */
export function ordinalOrderOf(floors) {
  const timed = []
  const untimed = []
  for (const f of Array.isArray(floors) ? floors : []) {
    if (!isObj(f)) continue
    const t = floorAtMillis(f.at)
    if (t === null) untimed.push(f)
    else timed.push({ floor: f, t })
  }
  timed.sort((a, b) => (a.t - b.t) || compareFloorOrder(a.floor, b.floor))
  untimed.sort(compareFloorOrder)
  const out = timed.map((x, i) => ({ floor: x.floor, ordinal: i + 1 }))
  for (const f of untimed) out.push({ floor: f, ordinal: null })
  return out
}

/**
 * 楼层行 → **`ordinal`**（键 = `floorKeyOf(nodeId, variantId)`；认不出 `at` 的那几行 ⇒ 值 `null`）。
 * ⚠️ `has()` 为 `false`（这一条不在清单里）与值为 `null`（在、但没时间）是**两件事**，
 *   但两者对面板都是同一句话：**「序号未知」**（⛔ 都不许编 0）—— 见 `ordinalOfFloor`。
 */
export function ordinalMapOf(floors) {
  const map = new Map()
  for (const x of ordinalOrderOf(floors)) map.set(floorKeyOf(x.floor.nodeId, x.floor.variantId), x.ordinal)
  return map
}

/** 查一条的 `ordinal`（**不在清单里 / 认不出时间** ⇒ `null` = 未知 —— ⛔ 不编 0）。 */
export function ordinalOfFloor(row, ordinals) {
  if (!(ordinals instanceof Map)) return null
  const k = floorKeyOf(row?.nodeId, row?.variantId)
  return ordinals.get(k) ?? null
}

// ---------------------------------------------------------------------------
// ①c ★★ 2026-09-25（用户口径，逐字）：「**开一个下钻，直接显示具体改动的字段，写改了哪些可以说
//     完全没用**」 ⇒ 楼层行那颗「**看改动 ▸**」要的是**真内容**（增行 / 删行，带一点点上下文），
//     ⛔ 不是"改了哪几份（±字节）"那句话。
//
// 纪律（都是踩出来的，⛔ 别"顺手"改）：
//   · **纯函数**、⛔ 不碰文件系统（正文由调用方读好喂进来）—— 台子才能不起服务器就测它；
//   · `\r\n` 与**结尾那一个换行**当同一件事（⛔ 别让 CRLF 差异造出一整屏"全变了"）；
//   · 两侧同文 ⇒ **空 diff**（`added:0, removed:0, lines:[]`）；
//   · 超长要**截断**（行数 / 字节 / 单行长度三个上限，见下面那几个常量）＋ **如实标 `truncated`**
//     （⛔ 不许"悄悄只给一半"）；
//   · 读不出来 ⇒ `kind:'unreadable'` ＋ 一句可读的 `reason`（⛔ **绝不**画成"没改动"）。
// ---------------------------------------------------------------------------

/** diff 的**上下文行数**（每条改动前后各留几行 —— 看得见落点，又不至于把整份文件搬出来）。 */
export const FLOOR_DIFF_CONTEXT = 3
/** 每份文件最多吐**多少行**（含上下文与省略标记）—— 超了截断并在响应里如实标出来。 */
export const FLOOR_DIFF_MAX_LINES = 400
/** 每份文件最多吐**多少字节**（按行累计估）—— 与行数上限**取先到者**。 */
export const FLOOR_DIFF_MAX_BYTES = 48 * 1024
/** **单行**最多吐多少字符（超长的行截断 ＋ 标 `truncated`，⛔ 不让一行几千字撑爆响应与版面）。 */
export const FLOOR_DIFF_LINE_MAX_CHARS = 400
/** LCS 表的**格子上限**（`|a|×|b|` 超了退化成"整段重写"）—— 仍然走同一套上下文/截断口径。 */
export const FLOOR_DIFF_MAX_CELLS = 1000000

/**
 * 正文归一：`\r\n` / `\r` ⇒ `\n`，并**去掉结尾那一个换行**。
 * ★ 这两下就是"CRLF 与结尾换行当同一件事"那条口径的**唯一落点**（⛔ 别在别处再归一一次）。
 */
export function normalizeDiffText(text) {
  const s = typeof text === 'string' ? text : ''
  return s.replace(/\r\n?/g, '\n').replace(/\n$/, '')
}

/** 一份正文的**行数组**（归一之后按 `\n` 切；空正文 ⇒ `[]` —— ⛔ 不是 `['']`）。 */
export function diffLinesOf(text) {
  const s = normalizeDiffText(text)
  return s === '' ? [] : s.split('\n')
}

/** 两个行数组的 LCS 逐行动作（`{t,text}`；⛔ 只在 `diffTextLines` 里用）。 */
function lcsOps(a, b) {
  const n = a.length
  const m = b.length
  const w = m + 1
  const dp = new Int32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j]
        ? dp[(i + 1) * w + (j + 1)] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: ' ', text: a[i] }); i++; j++ }
    else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) { ops.push({ t: '-', text: a[i] }); i++ }
    else { ops.push({ t: '+', text: b[j] }); j++ }
  }
  while (i < n) { ops.push({ t: '-', text: a[i] }); i++ }
  while (j < m) { ops.push({ t: '+', text: b[j] }); j++ }
  return ops
}

/**
 * ★★ **行级 diff**（增 / 删 / 同，**带 N 行上下文**）—— 纯函数，⛔ 不碰文件系统。
 *
 * @param {{ before?:string|null, after?:string|null, context?:number }} o
 *   `before` = 要跟它比的那一份（`null` / 缺省 = 那时还没有这一份 ⇒ 当**空正文**）；
 *   `after` = 这一份；`context` = 上下文行数（缺省 `FLOOR_DIFF_CONTEXT`）。
 * @returns {{
 *   added:number, removed:number, changed:boolean, same:boolean,
 *   lines:Array<{t:'+'|'-'|' '|'@', text:string}>, truncated:boolean, total:number,
 * }}
 *   · `added` / `removed` = **真账**（截断前就有多少行增/删 —— 面板据此说"共 N 行改动"）；
 *   · `lines` = 改动附近的那些行（`'+'` 增 / `'-'` 删 / `' '` 上下文 / `'@'` = **省略标记**，
 *     表示"这里跳过了 N 行没变"—— 中间那段没变的不吐出来，免得"改一行吐一整份"）；
 *   · `total` = 过滤后**本该**有多少行（`lines.length` < `total` ⇒ `truncated:true`，只给了前一段）；
 *   · 两侧同文 ⇒ `added:0 removed:0 lines:[] truncated:false`（**空 diff**）。
 */
export function diffTextLines(o) {
  const before = typeof o?.before === 'string' ? o.before : ''
  const after = typeof o?.after === 'string' ? o.after : ''
  const ctx = Number.isFinite(o?.context) && o.context >= 0 ? Math.floor(o.context) : FLOOR_DIFF_CONTEXT
  const ops = diffOpList(diffLinesOf(before), diffLinesOf(after))
  let added = 0
  let removed = 0
  for (const op of ops) {
    if (op.t === '+') added += 1
    else if (op.t === '-') removed += 1
  }
  if (added === 0 && removed === 0) {
    return { added: 0, removed: 0, changed: false, same: true, lines: [], truncated: false, total: 0 }
  }
  return Object.assign({ added, removed, changed: true, same: false }, clipDiffOps(ops, ctx))
}

/** 逐行动作表（先削掉两侧的公共前后缀，再对中间那段做 LCS；太大就退化成"整段重写"）。 */
function diffOpList(a, b) {
  const n = a.length
  const m = b.length
  let p = 0
  while (p < n && p < m && a[p] === b[p]) p += 1
  let s = 0
  while (s < n - p && s < m - p && a[n - 1 - s] === b[m - 1 - s]) s += 1
  const am = a.slice(p, n - s)
  const bm = b.slice(p, m - s)
  const ops = []
  for (let i = 0; i < p; i++) ops.push({ t: ' ', text: a[i] })
  // ⚠️ 削完之后中间那段还太大 ⇒ **不硬算 LCS**（那是几十 MB 的表）：整段重写，
  //   交给下面那套上下文/截断口径如实收尾（⛔ 绝不静默给个错的）。
  if (am.length * bm.length <= FLOOR_DIFF_MAX_CELLS) {
    for (const op of lcsOps(am, bm)) ops.push(op)
  } else {
    for (const l of am) ops.push({ t: '-', text: l })
    for (const l of bm) ops.push({ t: '+', text: l })
  }
  for (let i = 0; i < s; i++) ops.push({ t: ' ', text: a[n - s + i] })
  return ops
}

/** 只留"改动附近 `ctx` 行"，中间没变的折成一条 `'@'` 省略标记；再按行数/字节/单行长度截断。 */
function clipDiffOps(ops, ctx) {
  const keep = new Array(ops.length).fill(false)
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].t === ' ' || ops[i].t === '@') continue
    const from = Math.max(0, i - ctx)
    const to = Math.min(ops.length - 1, i + ctx)
    for (let k = from; k <= to; k++) keep[k] = true
  }
  const full = []
  let gap = 0
  /** 中间被跳过的那些行折成**一条** `'@'` 省略标记（⛔ 不吐出来 —— 否则"改一行"会变成"吐一整份"）。 */
  const flushGap = () => { if (gap > 0) { full.push({ t: '@', text: `这里跳过 ${gap} 行没变` }); gap = 0 } }
  for (let i = 0; i < ops.length; i++) {
    if (keep[i]) { flushGap(); full.push(ops[i]) } else gap += 1
  }
  // ⚠️ 结尾那一截没变的**不留**省略标记（读者已经看到最后一条改动了，再挂一句"跳过 N 行"只是噪声）。
  // 截断：行数上限、字节上限取**先到者**；单行超长也截（三样都进同一个 `truncated` 旗）。
  let truncated = false
  const lines = []
  let bytes = 0
  for (const op of full) {
    if (lines.length >= FLOOR_DIFF_MAX_LINES) { truncated = true; break }
    let text = op.text
    if (text.length > FLOOR_DIFF_LINE_MAX_CHARS) {
      text = text.slice(0, FLOOR_DIFF_LINE_MAX_CHARS)
      truncated = true
    }
    const cost = text.length + 1
    if (bytes + cost > FLOOR_DIFF_MAX_BYTES) { truncated = true; break }
    bytes += cost
    lines.push({ t: op.t, text })
  }
  return { lines, truncated, total: full.length }
}

/**
 * ★★ **一份楼层 vs 另一份的逐文件改动**（纯函数：正文由调用方读好喂进来，⛔ 不碰文件系统）。
 *
 * @param {{
 *   target:object|null, base:object|null,
 *   textOf:(sha:string)=>string|null,
 *   deadFiles?:Array<string>|Set<string>, context?:number,
 * }} o
 *   · `target` = **要展开的那一条**（`null` ⇒ 认不出 ⇒ 空数组）；
 *   · `base`   = **跟它比的那一条**（`null` = 没有可比的前一条 ⇒ 也返回空数组 ——
 *     这一件事由调用方那一层如实说"这是最早的一条，没有可比的"）；
 *   · `textOf(sha)` = 读一份正文（⛔ 读不到返回 `null` ⇒ `kind:'unreadable'`，
 *     **绝不许**当成"这一楼是空的"）；
 *   · `deadFiles` = 哪几份里**有死区**（唯一判据仍是 `.dma-deadzones.json`）。
 * @returns {{ files:Array<object>, truncated:boolean, added:number, removed:number }}
 *   每份的形状：`{ name, kind, added, removed, lines, truncated, total, reason, sha256, baseSha256 }`；
 *   `kind` ∈ `'changed'｜'same'｜'absent'｜'not-target'｜'deadzone'｜'unreadable'`（**逐条如实**：
 *   `absent` = 这一条当时没有这一份；`not-target` = 不在那 5 份里；`deadzone` = 有死区、恢复时按块合并；
 *   `unreadable` = 正文读不出来 —— ⛔ 这一种**不许**画成"没改动"）。
 */
export function diffFloorFiles(o) {
  const target = isObj(o?.target) ? o.target : null
  if (target === null) return { files: [], truncated: false, added: 0, removed: 0 }
  const base = isObj(o?.base) ? o.base : null
  // ⚠️ **没有可比的那一条**（最早的那一条）⇒ 空数组：这一件事由**调用方**如实说
  //   （"这是最早的一条，没有可比的"）—— ⛔ 不在这里折成"每一份都是全新增行"（那不是用户要看的东西）。
  if (base === null) return { files: [], truncated: false, added: 0, removed: 0 }
  const textOf = typeof o?.textOf === 'function' ? o.textOf : () => null
  const dead = o?.deadFiles instanceof Set
    ? o.deadFiles
    : new Set((Array.isArray(o?.deadFiles) ? o.deadFiles : []).map((x) => str(x)))
  const ctx = Number.isFinite(o?.context) && o.context >= 0 ? Math.floor(o.context) : FLOOR_DIFF_CONTEXT
  const recOf = (row, name) => {
    const list = Array.isArray(row?.files) ? row.files : []
    return list.find((x) => isObj(x) && str(x.name) === name) ?? null
  }
  const names = []
  const push = (n) => { const s = str(n); if (s !== '' && !names.includes(s)) names.push(s) }
  for (const n of FLOOR_FILES) push(n)
  for (const row of [target, base]) for (const f of Array.isArray(row?.files) ? row.files : []) push(f?.name)
  const files = []
  let anyTruncated = false
  let added = 0
  let removed = 0
  for (const name of names) {
    const t = recOf(target, name)
    const b = recOf(base, name)
    const shaT = t === null ? null : str(t.sha256) || null
    const shaB = b === null ? null : str(b.sha256) || null
    const row = {
      name,
      kind: 'same',
      added: 0, removed: 0, lines: [], truncated: false, total: 0,
      reason: '', sha256: shaT, baseSha256: shaB,
    }
    if (!isFloorFile(name)) {
      row.kind = 'not-target'
      row.reason = '不在那 5 份里（模型维护的那几份之外的文件不记快照）'
    } else if (t === null || shaT === null) {
      // 这一条里**没有**这一份（那一楼当时还没有它 / 记的时候读不到）⇒ 如实标，⛔ 不当成"空文件"。
      row.kind = 'absent'
      row.reason = '这一条当时没有这一份'
    } else {
      const isDead = dead.has(name)
      const afterText = textOf(shaT)
      const beforeText = shaB === null ? '' : textOf(shaB)
      if (afterText === null || beforeText === null) {
        // ★ 读不出来：⛔ 不许画成"没改动"（那样用户会以为这一份没问题）。
        row.kind = 'unreadable'
        row.reason = afterText === null ? '这一条的正文读不出来' : '要比的那一条的正文读不出来'
      } else {
        const d = diffTextLines({ before: beforeText, after: afterText, context: ctx })
        row.kind = isDead ? 'deadzone' : (d.changed ? 'changed' : 'same')
        if (isDead) row.reason = '这一份有死区 ⇒ 恢复时按块合并（死区那几段保留盘上现况、不会被回档改动）'
        row.added = d.added
        row.removed = d.removed
        row.lines = d.lines
        row.truncated = d.truncated
        row.total = d.total
        if (d.truncated) anyTruncated = true
      }
    }
    added += row.added
    removed += row.removed
    files.push(row)
  }
  return { files, truncated: anyTruncated, added, removed }
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
 * ★★ **这一次算不算「开 fork」**（纯函数；判据**只此一处**，⛔ 调用方不许自己判）。
 *
 * 用户口径（2026-09-24）：「**开 fork 时（回档）前台弹提示**」。
 * **「开 fork」= 剧情站的楼，比我们上次认过的那个位置（`seen`）退了回去（或同一楼换了一支）** ——
 * 与"档案（那 5 份的账）在哪一楼"**无关**（老判据 `decideRollback` 就是错在这一点上：见文件头 ⑤）。
 *
 * ```
 * head 认不出（nodeId 空）                    ⇒ no-head        （安静：还没有楼层可言）
 * 还没有 seen（第一次见 / 簿记文件丢了）       ⇒ no-seen        （★ **建立基线**，⛔ 不算 fork）
 * 同一楼同一支                                ⇒ same
 * 同一楼**换了支**（两边都知道变体）           ⇒ fork（why:variant） （swipe 重 roll / 在该楼另开一支）
 * head 在 nodes[] 里比 seen **靠前**          ⇒ fork（why:back）    （★ 用户要提示的那一件事）
 * head 不比 seen 靠前                         ⇒ forward          （往前走；⛔ 不算 fork）
 * 两边有一个在 nodes[] 里找不到位置            ⇒ unknown-order    （⛔ 保守：什么都不动）
 * ```
 *
 * ⚠️ 三条刻意的口径（都写在这儿，免得后人"顺手"改）：
 *   · **只看位置**（`seqOf` 给的是 `nodes[]` 里的序号）+ **变体**，⛔ 不拿时间戳猜（与 `decideRollback` 同款）。
 *   · 有一边**不知道变体**（老记录 / 时间线没给）⇒ **不当成换支**（保守：那一楼还是那一楼）——
 *     与 `decideRollback` 同一条纪律；那时按位置比 ⇒ 同一楼 ⇒ `forward`（`seen` 自动跟上，自愈）。
 *   · `seen` **只会往前**（调用方的纪律）：`forward` / `no-seen` ⇒ `seen ← head`；`fork` ⇒ **`seen` 不动**
 *     （基准停在"上次认过的位置"，横幅才挂得住）；用户点了「对齐楼层 / 只对齐楼号 / 不处理」⇒ 算认过了 ⇒ `seen ← head`。
 *
 * @param {{ head:object|null, seen:object|null, seqOf:(nodeId:string)=>number|null }} o
 * @returns {{ kind:'no-head'|'no-seen'|'same'|'fork'|'forward'|'unknown-order', why:'back'|'variant'|null }}
 */
export function decideFork(o) {
  const head = isObj(o?.head) ? o.head : null
  const headId = str(head?.nodeId)
  if (headId === '') return { kind: 'no-head', why: null }
  const seen = normalizeSeen(o?.seen)
  if (seen === null) return { kind: 'no-seen', why: null }
  const headVar = str(head?.variantId)
  if (headId === seen.nodeId) {
    if (headVar === seen.variantId) return { kind: 'same', why: null }
    if (headVar !== '' && seen.variantId !== '') return { kind: 'fork', why: 'variant' }
    // 有一边不知道变体 ⇒ ⛔ 不判"换支"（保守）—— 落到下面按位置比（同一楼 ⇒ forward ⇒ seen 自动跟上）。
  }
  const seqOf = typeof o?.seqOf === 'function' ? o.seqOf : () => null
  const headSeq = seqOf(headId)
  const seenSeq = seqOf(seen.nodeId)
  if (headSeq === null || seenSeq === null) return { kind: 'unknown-order', why: null }
  if (headSeq < seenSeq) return { kind: 'fork', why: 'back' }
  return { kind: 'forward', why: null }
}

/**
 * ★★ **这一轮该不该回档**（纯函数；判据全在这一处）。
 *
 * ⚠️ ★ 2026-09-24 收尾：**"要不要提示"已经改由 `decideFork` 回答**（剧情 vs `seen`）—— 本函数现在只回答
 *   **"有没有一份可以退回"**（`rollback` + `target`；没有 ⇒ `back-no-snapshot` 等，那时横幅照弹、只是没有那颗按钮）。
 *   它**照旧**按"档案 vs 剧情"判（`last` 那一楼），⛔ 一个字都没改 —— 老的那套判据在"剧情退到档案后面"时仍然对，
 *   只是**不再是提示的触发条件**（真机上它恒为 `forward`，那正是横幅不弹的根因）。
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
// ③ 一次「楼同步」的编排（判**开 fork** → **只记一条待处理** → 记录）
//
// 三个调用时机（同一份编排，⛔ 不三处各写一遍）：
//   · `mode:'watch'` —— 挂 `system-prompt/assemble`（**每轮至多一次**，排到本轮之外再跑）：
//     判 fork、记那一跳待处理（★ 2026-09-24 起**不恢复** —— 那 5 份一个字节都不写）。
//   · `mode:'turn'`  —— 挂 `session/event` 的 `turn/end` / `compaction/end`：判 fork + **记录**
//     （"每轮模型的改动都留一份"）。
//   · ★ 2026-09-24 收尾新增：面板**开档时**（`POST …/floors/scan`）也走一次 `'watch'` ——
//     补掉"回档之后没发消息、直接开面板看"那个时序洞（那一刻轮边界那一脚根本没发生）。
//   ⚠️ 三处都跑不重复：判到同一次 fork（同一个 targetKey）⇒ `planPending` 判为没变化、**不写盘**。
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
 *   `{ memoryDir, mode:'watch'|'turn', head, seen, seq, seqOf, prevOf, at, stamp, zones }`
 *   · `seen` = **"上次认过的剧情位置"**（`{nodeId, variantId, seq, at}`；认不出 ⇒ `null`）—— 宿主从
 *     `<storageDir>/floor-head.json` 现读现喂（⛔ 这个模块不认识那个文件，也不知道它存哪儿）。
 *     ★★ **"开 fork"的判据就是它**（`decideFork`）；调用方**只**按回执里的 `receipt.fork.kind` 更新它。
 *   · `zones` = 死区数据里那几条（`./deadzone.js` 的 `doc.zones`）或 **`null` = 死区数据读不出来**
 *     （⇒ 恢复整次不做；记录侧不看死区数据）。
 * @returns {object} 回执（`kind` / `wrote` / `record` / `pre` / `restore` / `notes` / **`fork`**）
 *   ★ `kind` 现在按 **fork** 报（`fork:'fork'` ⇒ `'rollback'`；`'no-seen'` ⇒ `'first'`；其余同名）——
 *     它就是面板/日志/状态文件那句人话（"最近一次回档"）的判据：**只有真开了 fork 才会说"检测到回档"**。
 *   ★ `decision`（`decideRollback`）只用来挑"退回哪一份"，它的 kind 不再当回执的 kind。
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
  const seen = normalizeSeen(o?.seen)
  const seqOf = typeof o?.seqOf === 'function' ? o.seqOf : () => null
  // ★★ 两个判据**都算**（⛔ 不两处各判一遍、⛔ 也不许调用方自己判）：
  //   · `fork`     —— 决定**要不要提示**（剧情 vs `seen`；用户口径「开 fork 时前台弹提示」）；
  //   · `decision` —— 决定**有没有一份可以退回**（档案 vs 剧情；目标只是横幅上那颗按钮的参数）。
  const fork = decideFork({ head, seen, seqOf })
  const decision = decideRollback({ head, last: index.last, floors: index.floors, seqOf, prevOf: o?.prevOf })

  // ★★ 2026-09-24 改口径（用户拍板「**不要做跟随楼层的功能，先做手动挡**」）：
  //   开 fork **只往清单里记一条待处理**（`pending`）—— ⛔ 那 5 份**一个字节都不写**、
  //   ⛔ 也不调 `restoreFloor`，写盘那一脚由**人在面板上点**（`restoreFloor`，唯一写入口）。
  //   判据（记 / 更新 / 清 / 一个字都不动）全在纯函数 `planPending` 里，⛔ 这里不自己判。
  const mark = planPending({ index, head, seen, fork, decision, seq: o?.seq ?? null, at })
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
    // ★ 这一脚的判据本身（宿主按它更新 `seen`：`forward`/`no-seen` ⇒ `seen ← head`，其余不动）。
    fork,
    pending: mark.pending, pendingChanged: mark.changed,
    why: fork.why ?? null, source: decision.source ?? null,
    prevNodeId: decision.prevNodeId ?? null, legacyAtHead: decision.legacyAtHead === true,
    // ★ 判据那一层的三个楼号（回执文案说"从第几楼退到第几楼、档案停在第几楼"用）
    headSeq: numOrNull(decision.seq), lastSeq: numOrNull(decision.lastSeq),
    archiveSeq: numOrNull(index.last?.seq),
  }
  const seat = (n) => (Number.isFinite(n) ? String(n) : '?')

  // ★★ 开 fork 那一支：**只是提示**（面板横幅 + 日志各一处，别的一律不动）。
  //   ⛔ 一个字节的笔记都不写；⛔ 记录侧也够不到（`record: null`）。
  if (fork.kind === 'fork') {
    const p = mark.pending
    if (mark.changed && p !== null) {
      const branch = (v) => (typeof v === 'string' && v !== '' ? v : '不知道哪一支')
      // 文案口径（用户口径：「开 fork 时前台弹提示」）：说清 **剧情刚从第 X 楼退到第 Y 楼** ＋
      // **档案停在 第 Z 楼** ＋ 要不要把档案也退回去 / 怎么对齐由你点。⚠️ 回档那一支**没有** `restore` 可读。
      const pre = p.why === 'variant'
        ? '检测到第 ' + seat(p.toSeq) + ' 楼换了变体（swipe 重 roll：' + branch(p.fromVariantId) + ' → ' + branch(p.toVariantId)
          + '；剧情刚从第 ' + seat(p.fromSeq) + ' 楼退到第 ' + seat(p.toSeq) + ' 楼）'
        : '检测到回档到第 ' + seat(p.toSeq) + ' 楼（剧情刚从第 ' + seat(p.fromSeq) + ' 楼退到第 ' + seat(p.toSeq) + ' 楼）'
      // ★ 2026-09-25：那一排只有「对齐楼层 / 只对齐楼号 / 不处理」三颗 —— **退回那条路**在
      //   楼层清单每一行的「回到这一楼」里（`…/floors/restore`），所以这里如实指向它。
      const noTarget = p.targetNodeId === ''
        ? '；这一次没有可退回的那一份（那是**正常状态**，⛔ 不编一个目标；要把档案退回去请到楼层清单里点那一行的「回到这一楼」）'
        : '；要退回第 ' + seat(p.targetSeq) + ' 楼得由人到楼层清单里点那一行的「回到这一楼」'
      notes.push(pre + '，档案停在 第 ' + seat(p.archiveSeq) + ' 楼'
        + ' —— 只记一条待处理、那 5 份一个字节都没写' + noTarget)
    }
    return Object.assign({ kind: 'rollback', at, wrote, record: null, pre: null, restore: null, notes }, extras)
  }

  // 记录侧（只有"轮末"那一脚记；watch 那一脚看到 first/same/forward 时**什么都不做**）。
  //   ⛔ 判据照旧只认 `first` / `same` / `forward`（那是**档案那一侧**的口径，本单一个字都没改）。
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
  // ★ 回执的 kind 按 **fork** 报（`no-seen` ⇒ `first`：还没有基线，与"还没有 last"是同一件事的两半）。
  const kind = fork.kind === 'no-seen' ? 'first' : fork.kind
  return Object.assign({ kind, at, wrote, record, pre: null, restore: null, notes }, extras)
}

/**
 * ★★ **「对齐」那一脚是哪种模式**（★ 2026-09-25 新口径；判据**只此一处**，⛔ 调用方不许自己认）：
 *   · 没给（键不在 / `undefined` / `null`）⇒ **`'full'`**（缺省，行为与从前**完全一致**）；
 *   · 认得的就那两个：`'full'`（＝「对齐楼层」：记快照 + 锚 `last` + 清待处理）／
 *     `'number'`（＝「只对齐楼号」：**只**锚 `last` + 清待处理）；
 *   · 其余（含空串、别的字、别的类型）⇒ **`null` = 认不出** ⇒ 调用方**拒**（端点回 400）、
 *     ⛔ **不许悄悄按 `'full'` 跑**（那会替用户记下一份他没那么点的快照）。
 */
export function settleModeOf(v) {
  if (v === undefined || v === null) return 'full'
  return v === 'full' || v === 'number' ? v : null
}

/**
 * ★★ **「对齐楼层 / 只对齐楼号」那一族（就地登记）** —— 2026-09-24 用户口径：
 * 跟 Tavern 一致，回档之后那段历史就是没有了（★ 2026-09-25 起这一族是**两颗按钮**：
 * 「对齐楼层」/「只对齐楼号」；「不处理」不在这儿 —— 它走 `…/floors/pending/ack`）。
 *
 * 两种 **`mode`**（★ 2026-09-25 加的第二颗按钮；判据见 `settleModeOf`）：
 *
 * | mode | 面板上那颗 | 做什么 | 动正文吗 |
 * |---|---|---|---|
 * | `'full'`（缺省） | 「**对齐楼层**」（＝从前的「保持现状 / 档案对齐到第 N 楼」） | ① 把**当下盘上那 5 份**的现文记成 **(目标那一楼, 那一支)** 的快照（`planRecord` 算条目 + 落 blob + `upsertFloor`）② `last` 锚到那一支 ③ 清掉那条待处理 | ⛔ 一个字都不写 |
 * | `'number'` | 「**只对齐楼号**」 | **只写清单**：`last ← pending.to*` ＋ `pending: null`；⛔ 不调 `planRecord`、⛔ 不写 blob、⛔ **不 upsert 楼层行** | ⛔ 一个字都不写 |
 *
 * 其余判据（两种模式**一模一样**，⛔ 一个字都没改）：认不出"剧情站在哪一楼" ⇒ 拒改（`no-head`）；
 * 没有待处理那条那一支 ⇒ `no-pending`（安静）；已经指着这一支 ⇒ `already-aligned`（⛔ 不空写）。
 *
 * ⚠️ ★ `'number'` 之后**那一楼没有快照**（清单里不长新行）⇒ `baseFloorOf` 会是 `null` ⇒
 *   下一轮轮末记录时会把那 5 份**全量**记成那一楼的快照（`changed` 全 `true`）—— 那是**要的**：
 *   **"楼号先对上，内容等下一轮自然记上"**（⛔ 别"顺手"在这里也记一份）。
 *
 * **目标那一楼从哪儿来**（★ 2026-09-24 收尾补的那条路）：
 *   · 有那条待处理 ⇒ 用它记下的 `to*`（判到 fork 那一刻剧情站的楼）；
 *   · **没有**（面板档顶那条**常驻状态行**上那颗「档案对齐到第 N 楼」—— 用户"不处理"过之后就不是 fork 了）
 *     ⇒ 用调用方现给的 **`o.head`**（当前剧情站的楼）。⚠️ 由**宿主**现读时间线喂进来，⛔ 面板不自己推。
 *
 * ⛔ **那 5 份正文一个字节都不写**（只读它们）、⛔ 不碰会话/归档/Tavern。
 *
 * ⚠️ 为什么 `'full'` 的①必须做、⛔ 别改成"只挪 `last`"：账上写"第 N 楼的样子"就得真是盘上这份 ——
 *   只挪指针会让后面回档到第 N 楼时恢复出**第一遍玩时那份**（跟盘上的现况对不上）。
 *   ★ 而 `'number'` **恰恰就是**"只挪指针"那一支 —— 那是**用户点名的另一件事**（他要"楼号先对上、
 *   内容等下一轮自然记上"），⛔ 与上面那条不矛盾：两者是**两颗按钮**，⛔ 谁也替不了谁。
 * ⚠️ 为什么两种模式都要挪 `last`（这是本函数存在的理由）：记录侧只认 first/same/forward；`last` 不跟着走
 *   ⇒ 判据每一轮都还判"回档" ⇒ ① 之后整段都不记快照、② 每推一楼重弹一条横幅。见文件头 ②。
 *
 * @param {string} memoryDir 记忆库目录
 * @param {{ at?:string, head?:object|null, seq?:number|null, mode?:'full'|'number' }} o
 *   `head` = **没有待处理时**要就地对齐到的那一楼；`mode` = 见上（缺省 `'full'`）
 * @returns {{ ok:boolean, changed:boolean, settled:object|null, mode:string|null, reason:string }}
 *   `settled` = 对齐到了哪一支（`{nodeId, variantId, seq}`）；`mode` = 这一脚是哪种模式（认不出 ⇒ `null`，
 *   那时 `ok:false`）；`changed:false` ⇒ 盘上没动过。
 */
export function settlePending(memoryDir, o) {
  const dir = typeof memoryDir === 'string' ? memoryDir : ''
  const mode = settleModeOf(o?.mode)
  const miss = (reason) => ({ ok: false, changed: false, settled: null, mode, reason })
  if (dir === '') return miss('no-dir')
  // ⛔ 认不出的 `mode` ⇒ 拒（半个字节都不动）—— 端点在更前面回 400，这里是**内核**那一层的那道闸。
  if (mode === null) return miss('bad-mode')
  const read = readIndex(dir)
  if (read.error !== null) return miss(read.error)
  const cur = pendingOf(read.index)
  const head = isObj(o?.head) ? o.head : null
  const headId = str(head?.nodeId)
  // ★ 目标那一楼：有待处理 ⇒ 用它记下的 to*（那条横幅说的就是它）；没有 ⇒ 用现给的 head（常驻状态行那颗按钮）。
  const goal = cur !== null
    ? { nodeId: str(cur.toNodeId), variantId: str(cur.toVariantId), seq: numOrNull(cur.toSeq) }
    : (headId === '' ? null : { nodeId: headId, variantId: str(head?.variantId), seq: numOrNull(o?.seq) })
  if (goal === null || goal.nodeId === '') {
    // ⛔ 认不出"剧情站在哪一楼"⇒ 拒改（半个字节都不动）。
    return cur === null ? { ok: true, changed: false, settled: null, mode, reason: 'no-pending' } : miss('no-head')
  }
  // ★ 已经就地对齐在这一支上了 ⇒ 没什么可登记的（⛔ 不空写一遍清单 —— 那颗按钮连点两下也不该写两次）。
  const lastNow = isObj(read.index.last) ? read.index.last : null
  if (cur === null && lastNow !== null && str(lastNow.nodeId) === goal.nodeId && str(lastNow.variantId) === goal.variantId) {
    return {
      ok: true, changed: false, mode, reason: 'already-aligned',
      settled: { nodeId: goal.nodeId, variantId: goal.variantId, seq: numOrNull(lastNow.seq) },
    }
  }
  const at = typeof o?.at === 'string' && o.at !== '' ? o.at : new Date().toISOString()
  const nodeId = goal.nodeId
  const settled = { nodeId, variantId: goal.variantId, seq: goal.seq }
  // ★ **只对齐楼号**（`mode:'number'`）：**只写清单** —— `last` 挪到这一楼那一支 + 清掉待处理。
  //   ⛔ 不调 `planRecord`、⛔ 不写 blob、⛔ 不 `upsertFloor`（那一楼**先不长出新行**；
  //   内容等下一轮轮末那一脚自然记上 —— 见上面的 ⚠️ 语义提醒）。
  if (mode === 'number') {
    writeIndex(dir, {
      schemaVersion: FLOOR_SCHEMA_VERSION, updatedAt: at,
      last: { nodeId, variantId: settled.variantId, seq: settled.seq, at },
      floors: read.index.floors,
      pending: null,
    })
    return { ok: true, changed: true, settled, mode, reason: '' }
  }
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
  return { ok: true, changed: true, settled, mode, reason: '' }
}

export default {
  FLOOR_DIR_NAME, FLOOR_INDEX_NAME, FLOOR_SCHEMA_VERSION, FLOOR_FILES,
  isFloorFile, blobNameOf, emptyIndex, normalizeFileRec, normalizeFloor, normalizeIndex,
  floorKeyOf, isLegacyFloor, isRestorableFloor, normalizePending, normalizeSeen, pendingOf, planPending,
  floorsOfNode, floorOf, floorOfVariant, baseFloorOf, lastRestorableFloorOfNode, upsertFloor,
  headOf, nodeOrderOf, seqMapOf, seqOfNode, prevNodeOf,
  // ★ 2026-09-25：**插件自己编的序号**（`ordinal`）＋ 楼层改动下钻的行级 diff（两族都是纯逻辑）
  floorAtMillis, compareFloorOrder, ordinalOrderOf, ordinalMapOf, ordinalOfFloor,
  FLOOR_DIFF_CONTEXT, FLOOR_DIFF_MAX_LINES, FLOOR_DIFF_MAX_BYTES, FLOOR_DIFF_LINE_MAX_CHARS, FLOOR_DIFF_MAX_CELLS,
  normalizeDiffText, diffLinesOf, diffTextLines, diffFloorFiles,
  decideFork, decideRollback, planRecord, missingBlobs, rawSpans, mergeDeadzoneBlocks, planRestore, rankMemoryHomes,
  fileChangeText, floorChangeText,
  snapshotPaths, readIndex, writeIndex, indexExists, blobExists, writeBlob, readBlob,
  readFloorTargets, hasAnyFloorFile, writeRestoredFile, restoreFloor, syncFloor, settlePending, settleModeOf,
}
