/**
 * _selftest-preset-persona.mjs —— 钉住人设里那组**行为边界条款**（模型看得见的原文）。
 *
 * ## 2026-09-29 **大改：写作者 / 维护者双身份剥离**
 * 用户口径：「顶层预设是写作者和维护者双身份……要剥离」「把他升级成主管……既会收，也会用」。
 * ⇒ persona 里的**维护者知识整块退役**（§0 读文件纪律 / §5 收纳纪律 / §4 的 memory_write 教学 /
 *    自记标记 / 删法 / 骨架）——这些搬进了**记忆主管**（收+排期的提示词在 `lib/mt-compaction.js`
 *    生成器，展示副本在 `lib/supervisor.js`）；写作者只剩：看简报 → 演戏 → 导演随记（append）。
 * ⇒ 本台子随之重写：
 *   · **保留**的钉：P1–P8（行为边界）、P9（周目边界）、P12（时间锚）、P13（工序，改为新四步）、
 *     P14（正文）、P15★（格式）、P16（路径）——锚点按新正文换。
 *   · **改口径**的钉：P11（随记 append-only；收纳归主管）；P17/P18 **反向钉**（persona 里
 *     ⛔ 不许再出现标记/删法/骨架/收纳纪律——它们回来说明剥离被回滚），正面判据钉在
 *     `supervisor.js` / `lib/mt-compaction.js`（本台子 ⑥/⑦）。
 *
 * ★ 每条都带**反证**：把锚点从原文里剪掉 ⇒ 同一句判据必须红（证明它会咬人，不是形状断言）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { NOTE_SELF_MARK } from './lib/memory-write.js'

const repo = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(repo, 'preset', 'agent.cordis.yml'), 'utf8')

const iPrefix = SRC.indexOf('prefix: |-')
const iEnd = SRC.indexOf('\n- id:', iPrefix)
const persona = iPrefix > 0 && iEnd > iPrefix ? SRC.slice(iPrefix, iEnd) : ''

let pass = 0
let fail = 0
const check = (label, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${cond ? '' : '  ← ' + String(extra).slice(0, 300)}`)
}

check('P0 找得到人设正文（`prefix: |-` → 下一个挂载行）',
  persona.length > 1000, `切出 ${persona.length} 字符`)

function pin(label, anchors) {
  const hit = (s) => anchors.every((a) => s.includes(a))
  check(`${label}`, hit(persona), anchors.filter((a) => !persona.includes(a)).join(' / ') || '')
  const dead = anchors.filter((a) => hit(persona.replace(a, '')))
  check(`${label} ★ 反证：剪掉任一锚点 ⇒ 判据必红`,
    anchors.length > 0 && dead.length === 0, dead.join(' / ') || '（无可剪的锚点）')
}

// ── P1–P6：行为边界（演出规范，原样保留）──
pin('P1 ★ 只演你自己：不替玩家操控其角色、不替玩家做决定（也不替他写台词、定新动作）',
  ['只演你名下角色', '不替玩家操控其角色、不替玩家做决定 —— 也不替他写台词、不替他定新动作'])
pin('P2 ★ 轮到玩家的角色 ⇒ 停下等他（宁可留白）', [
  '轮到他的角色说与做之处**停下等他**（宁可留白、宁可把镜头挪开）',
  '轮到玩家说做之处**停下等他**——宁可留白、宁可挪开镜头',
])
pin('P3 ★ 同场演 NPC 时规矩一样（仍不替玩家操控其角色）', ['仍不替玩家操控其角色'])
pin('P4 ★ 设定以"已确立的那份"为准（可补全留白，不许篡改 / 另起一套）',
  ['已确立的那份', '合理补全', '篡改', '另起一套', '最新、最明确'])
pin('P5 ★ 重大转折要先铺垫 + 不得代替用户决定其角色的行为',
  ['**重大转折**（死亡、关系巨变、主线推进）先铺垫', '不得代替用户决定其角色的行为'])
pin('P6 ★ 随记那条：不许把自己想象的玩家设定写进去',
  ['别把想象写成事实', '用户已定下的事', '替玩家改设定'])

// ── 位置：条款要落在它该在的节里 ──
const SEC_HEADS = ['## §1', '## §2', '## §3', '## §4', '## §5', '## §6', '## §7']
const secText = (head) => {
  const i = SEC_HEADS.indexOf(head)
  const a = persona.indexOf(head)
  if (i < 0 || a < 0) return ''
  const next = SEC_HEADS[i + 1]
  const b = next ? persona.indexOf(next, a + head.length) : persona.length
  return persona.slice(a, b > a ? b : persona.length)
}
const inSec = (head, s) => secText(head).includes(s)
const inPreamble = (s) => {
  const b = persona.indexOf('## §1')
  return b > 0 && persona.slice(0, b).includes(s)
}
{
  check('P7 ★ P1/P2/P3 落在 §0 开头与 §3（演出规范）里',
    inPreamble('不替玩家操控其角色、不替玩家做决定 —— 也不替他写台词')
    && inSec('## §3', '只演你名下角色')
    && inSec('## §3', '仍不替玩家操控其角色'), '')
  check('P7 ★ 反证：把 P1 的锚点从 §3 里剪掉 ⇒ 同一判据必红',
    !secText('## §3').replace('只演你名下角色', '').includes('只演你名下角色'), '')
  check('P8 ★ P6（随记那条）落在 §5（剧情笔记）—— 它管的是**随记**，不是演出',
    inSec('## §5', '别把想象写成事实') && inSec('## §5', '替玩家改设定'),
    `§5=${inSec('## §5', '别把想象写成事实')}`)
}

// ── P9 ★★ 周目边界（读/写都只在本局周目目录；写作者侧是「随记只进 index.md」）──
pin('P9 ★ 周目边界（§0 —— 段不存在就停手）', [
  '**`<memoryHome>` 段不存在**：本会话未归入周目 ⇒ 如实告知玩家「记忆注入与剧情笔记停用」，让他回 Tavern 重进',
  '新周目**：首楼简报缺失属正常——主管会在首楼后建起档案',
])
pin('P9 ★ 周目边界（§4 路径纪律 ①②③）',
  ['① 只进两处', '⛔ 别的一概不进', '⛔ `path` 不许写成周目目录的**上一层**', '⇒ **立刻停手**'])
pin('P9 ★ 周目边界（§5 —— 一个周目一份，主管维护）',
  ['**一个周目一份**', '⛔ 不写别的周目、不自创路径'])
{
  check('P10 ★ 三处分别在 §0 / §4 / §5 里（⛔ 不许只写在一处）',
    inPreamble('⛔ 不猜路径、⛔ 不写任何文件')
    && inSec('## §4', '① 只进两处')
    && inSec('## §5', '一个周目一份'), '')
  check('P10 ★ 反证：把 §5 那句剪掉 ⇒ 同一判据必红',
    !secText('## §5').replace('一个周目一份', '').includes('一个周目一份'), '')
}

// ── P11（★ 2026-09-29 **随记制改写**）：写作者唯一笔记动作 = 导演随记 append；收纳归主管 ──
//   历史沿革：3周目 overwrite 抹作者规则 → 立「作者的不动/自己的可删」（09-23）→ replace 手段 +
//   「写下一轮删上一轮」（09-24）→ 自记标记/段模式（09-25）→ 只留最近 3 场（09-26）。
//   ★ 今日（09-29）：这一整套**从 persona 退役**、搬进记忆主管（收+排期提示词）；
//     写作者侧只剩 append 随记，⛔ 不许再出现 replace/overwrite 教学（回了就是剥离被回滚）。
{
  pin('P11 ★ 随记制：唯一的笔记动作 = memory_write append 到 index.md 末尾（原话即可）', [
    '你唯一的笔记动作：**导演随记**',
    '`mode:\'append\'`、`path:\'index.md\'`',
    '把**原话**追加到文件末尾',
  ])
  pin('P11 ★★ 收纳归主管：收纳/整理/挪移/建档全是主管的活，写作者⛔ 不做也不通读（定点检索除外）', [
    '**收纳、整理、挪移、建档**全部由**记忆主管**在楼后自动完成',
    '⛔ 不通读它们（当前状态以简报为准',
  ])
  pin('P11 ★ 写作者禁 replace/overwrite（主管独占定点替换；随记只追加）', [
    '主管会把随记折进导演笔记并排期',
    '⛔ 不整理、不归位',
    '导演随记＝你自己的备忘（底层真相、设局者、要铺未铺的线）',
  ])
  // ★ 反正反证：旧的教学字面不许回 persona（它们现在住在 supervisor 提示词里）
  check('P11 ★ 退役确认：persona 里不再有「更新纪律/怎么删/骨架」那套维护教学',
    persona.includes('**怎么删**') === false && persona.includes('写本轮时删掉上一轮那版') === false
      && persona.includes('就只有这两段，照抄') === false,
    '维护教学又回到了 persona')
}

// ── P12 时间锚（开场白第一行；同源改到简报状态行；其余原样）──
{
  pin('P12 ★ 开场白的**第一行就是本局开场的准确时间**（时间锚 = 卡的开场白那一段）', [
    '**时间锚点＝它第一行**',
    '**已作为开场注入上下文，是已演过的第一场。**',
  ])
  pin('P12 ★ 锚点说死 + 往后顺推 + 简报状态行同源', [
    '⛔ 不自编月份／日期／时刻',
    '往后每轮顺推（时刻→时段→日→月）',
    '**必须与它同源**',
  ])
  pin('P12 ★★ 明令禁止把"格式示例"当本局日期（事故原话写进条款里）', [
    '【示例格式，非本局日期】',
  ])
  pin('P12 ★ 卡里没有开场白时的退路（问玩家要时间起点），⛔ 不许凭空编', [
    '卡里也没有 ⇒ 问玩家要时间起点（等他定）',
    '⛔ 不凭空编日期',
  ])
  pin('P12 ★★ 开场白**不重演**：⛔ 不逐字复述、不润色重发（你的第一条正文从它之后接）', [
    '⛔ 不重演、不逐字复述、不润色重发',
  ])
}

// ── P13 工序（★ 2026-09-29 改为新四步：★1 看简报 → ★2 定稿正文 → ★3 导演随记 → ★4 发正文）──
{
  pin('P13 ★ 工序照做（§1 四步：★1 看简报 → ★2 定稿正文 → ★3 导演随记 → ★4 发正文）', [
    '★1 **看简报**',
    '★2 **定稿正文**：把这一轮要演的内容写成定稿',
    '★3 **导演随记**',
    '以已定稿内容为准，⛔ 不因工具返回改写正文',
  ])
  pin('P13 ★★ ①工具结果只作核对、⛔ 不回头改正文；②一轮只做一遍就结束', [
    '一轮只做一遍，做完即结束',
    '⛔ 不回头重估字数、不补写',
  ])
  pin('P13 ★ ③剧透只进导演随记、⛔ 不进 world.md', [
    '⛔ 不写主持人剧透',
  ])
  pin('P13 ★ ④ask_user_question 按卡里的规则判、拿不准就不用', [
    '**`ask_user_question` 用法**——四种场合',
    '⛔ **拿不准就不用**',
  ])
}

// ── P14 「一轮只有一段正文」（原样保留）──
{
  pin('P14 ★★ 正向要求：**每一轮都要在正文里回复**（正文 = 最后那条不带工具调用的消息）', [
    '★4 **发正文**：一条**不带工具调用**的纯文本消息，放在**最后**',
    '**正文**＝一轮里唯一被玩家看见的内容',
  ])
  pin('P14 ★★ 顺序：先跑工具 ⇒ 再发这一段正文（带工具调用的消息算工具步，玩家看不到）', [
    '**工具步**＝带工具调用的消息，玩家不可见，正文不得写在工具步中',
    '带工具调用的消息是「工具步」，玩家看不见 ⇒ 正文不写在里面',
  ])
}

// ── P15★ 格式与尺度不归预设管（原样保留）──
{
  pin('P15★ ★ 格式与尺度：本引擎**不额外设**格式规范或内容边界（格式归角色卡，⛔ 预设不自创硬规则）', [
    '本引擎不额外设格式规范或内容边界',
    '一律以角色卡字段／世界书／作者预置为准',
    '⛔ 不自创硬规则、不套用外部默认',
  ])
}

// ── P16 路径逐字复制（原样保留）──
{
  pin('P16 ★ 路径从 `<memoryHome>` 段**逐字复制**，⛔ 不许凭记忆重打', [
    '★ **逐字复制**',
    '**从那一段整串拷过来**',
    '⛔ 不重打、不改大小写或连字符',
  ])
  pin('P16 ★ 读不到时的正确动作：先 glob 拿确切路径再 read（⛔ 别反复重打）', [
    '先 `glob` 一次拿确切路径',
    '⛔ 不反复重打同一路径、不猜',
  ])
}

// ── P19（2026-09-29 **新增**）：**剧情简报制** —— §0/§1 的核心契约 ──
//   主管每楼注入 [剧情简报]；写作者以它为事实基准；缺失/兜底照常动笔；历史引原话走 anima/grep。
{
  pin('P19 ★ 简报制：动笔只看 [剧情简报]，⛔ 不通读底账（§0）', [
    '每楼开始前，系统已在尾部注入 [剧情简报]',
    '当前状态以简报为准，⛔ 不通读底账',
    '⛔ 不尝试自己读文件补救、不向玩家解释注入机制',
  ])
  pin('P19 ★ 分派：简报有 ⇒ 接着演；缺失/兜底 ⇒ 照常动笔不补救（§1）', [
    '以它为事实基准动笔',
    '照常动笔（兜底就是当前可得的状态）',
    '⛔ 不自己读文件补救',
  ])
  pin('P19 ★ 历史引原话走 anima/grep 定点检索，不通读底账', [
    '用 `anima_query`，或按 §4 用 `grep` 定点检索',
  ])
}

// ── ⑥/⑦ 维护者知识搬家的**正面**判据（persona 里已删 ⇒ 在主管侧必须真在）──
{
  const gen = readFileSync(new URL('./lib/mt-compaction.js', import.meta.url), 'utf8')
  const sup = readFileSync(new URL('./lib/supervisor.js', import.meta.url), 'utf8')
  check('⑥ 收纳纪律在主管提示词里（生成器）：3 场/2500/标记/死区',
    gen.includes('notes.md 只留最近 3 场场记、上限 2500 字')
    && gen.includes('〔AI 自记〕')
    && gen.includes('作者预置段（无〔AI 自记〕标记/死区）一个字节不许动')
    && gen.includes('characters.md 只收**增量**固定特质'),
    '生成器缺主管收纳纪律')
  check('⑦ 展示副本（supervisor.js）与生成器同句（抽 3 句钉漂移）',
    sup.includes('notes.md 只留最近 3 场场记、上限 2500 字')
    && sup.includes('index.md 只动〔AI 自记〕段')
    && sup.includes('宁可漏，不可错'),
    'supervisor.js 展示副本漂移')
  check('⑧ MARK 常量一致性：〔AI 自记〕字面在生成器主管提示词与 memory-write 常量两侧都在',
    NOTE_SELF_MARK === '〔AI 自记〕' && gen.includes(NOTE_SELF_MARK),
    '生成器缺标记字面')
  check('⑨ persona 反向钉：维护者字面不许回流（〔AI 自记〕/只留最近 3 场/怎么删/骨架/state.md 死退路）',
    persona.includes(NOTE_SELF_MARK) === false
      && persona.includes('只留最近 3 场') === false
      && persona.includes('**怎么删**') === false
      && persona.includes('照抄（⛔ 不自己起标题') === false
      && persona.includes('state.md') === false,
    '维护者教学或死文件退路回流 persona')
}

console.log(`\n── ${pass} 通过 / ${fail} 失败 ──`)
process.exitCode = fail === 0 ? 0 : 1
