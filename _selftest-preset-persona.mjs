/**
 * _selftest-preset-persona.mjs —— 钉住人设里那组**行为边界条款**（模型看得见的原文）。
 *
 * ## 为什么要有它
 * 用户 2026-09-20 口径：「核对一下 evan 的预设，把他的**防 AI 替玩家写设定**的条款加回来」。
 * 核对结果（这次是**真的核过**，不是凭印象）：社区预设 `oliblue-evan/dsh-roleplay-preset`（MIT）的
 * persona 里有这几条，**我们从来没有过**（`git log -S` 与 pre-oliblue 备份都零命中）——
 * 也就是说"加回来"实际是"第一次加"。既然如此，就必须**钉住**：这类条款丢掉是**静默**的
 * （界面照常、不报错，只是模型开始替玩家写戏），谁也发现不了。本台子就是那道保险。
 *
 * ## 钉什么（都是模型看得见的原文片段，⛔ 不是注释）
 *   P1 只演你自己 / 不替玩家操控、不替玩家做决定
 *   P2 轮到玩家的角色 ⇒ 停下等他（宁可留白）
 *   P3 同场演 NPC 时规矩一样
 *   P4 设定以"已确立的那份"为准（可补全留白，但⛔不许篡改/另起一套；冲突以最新最明确为准）
 *   P5 重大剧情转折要先铺垫、不得代替用户决定其角色的行为
 *   P6 笔记那条：⛔ 不许把自己想象的玩家设定写进笔记（下一局会被当成"本来如此"读回来）
 *
 * ★ 每条都带**反证**：把锚点从原文里剪掉 ⇒ 同一句判据必须红（证明它会咬人，不是形状断言）。
 * ★ 还必须验**位置**：这组条款要落在 persona 正文里（`prefix:` 之后、`complete:` 之前）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repo = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(repo, 'preset', 'agent.cordis.yml'), 'utf8')

/**
 * 人设正文的范围：`prefix: |-`（含）之后，到**下一个挂载行**（列 0 的 `- id:`）之前。
 * ⚠️ 别拿 `complete: true` 当结束锚 —— **本预设刻意不用它**（它会在 waterfall 之后覆盖整个 system，
 * 把 Tavern / rp:policy / Anima 那些段全部作废，见 identity 那一节的注释）。块标量里的行都缩进 ≥6 空格
 * ⇒ 列 0 的 `- id:` 只可能是下一个挂载。
 */
const iPrefix = SRC.indexOf('prefix: |-')
const iEnd = SRC.indexOf('\n- id:', iPrefix)
const persona = iPrefix > 0 && iEnd > iPrefix ? SRC.slice(iPrefix, iEnd) : ''

let pass = 0
let fail = 0
const check = (label, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${cond ? '' : '  ← ' + String(extra)}`)
}

check('P0 找得到人设正文（`prefix: |-` → 下一个挂载行）',
  persona.length > 1000, `切出 ${persona.length} 字符`)

/** 一条判据 = 锚点全在 + 剪掉其中一个锚点后必须红。 */
function pin(label, anchors) {
  const hit = (s) => anchors.every((a) => s.includes(a))
  check(`${label}`, hit(persona), anchors.filter((a) => !persona.includes(a)).join(' / ') || '')
  // ★ 反证：逐条剪掉再验 —— 只要有一条锚点是"剪了也不红"的，它就是个假判据
  const dead = anchors.filter((a) => hit(persona.replace(a, '')))
  check(`${label} ★ 反证：剪掉任一锚点 ⇒ 判据必红`,
    anchors.length > 0 && dead.length === 0, dead.join(' / ') || '（无可剪的锚点）')
}

// ⚠️ 锚点必须**唯一**：`不替玩家操控他的角色` 在人设里出现两次（第三节那条 + NPC 那条 "**仍**不替…"）
//    ⇒ 单拿它当锚点，剪掉一次还剩一次，反证不红 = 假判据。取**连写**的那一段才唯一。
pin('P1 ★ 只演你自己：不替玩家操控他的角色、不替玩家做决定',
  ['只演你自己', '不替玩家操控他的角色、不替玩家做决定'])
pin('P2 ★ 轮到玩家的角色 ⇒ 停下等他（宁可留白）', ['就停下等他', '宁可留白'])
pin('P3 ★ 同场演 NPC 时规矩一样（仍不替玩家操控他的角色）', ['仍不替玩家操控他的角色'])
pin('P4 ★ 设定以"已确立的那份"为准（可补全留白，不许篡改 / 另起一套）',
  ['已确立的那份', '合理补全', '篡改', '另起一套', '最新、最明确'])
pin('P5 ★ 重大转折要先铺垫 + 不得代替用户决定其角色的行为',
  ['要先铺垫', '不得代替用户决定其角色的行为'])
pin('P6 ★ 笔记那条：不许把自己想象的玩家设定写进去',
  ['笔记只记', '用户已经定下的事', '替玩家改了设定'])

// ── 位置：这组条款必须在人设正文的**第三节**里（工具与行为边界那一节）────────────
{
  const i3 = persona.indexOf('## 三、')
  const i4 = persona.indexOf('## 四、')
  const inThree = (s) => {
    const a = persona.indexOf('## 三、')
    const b = persona.indexOf('## 四、')
    return a > 0 && b > a && persona.slice(a, b).includes(s)
  }
  check('P7 ★ P1/P2/P3 落在第三节（`## 三、` 与 `## 四、` 之间）—— 与既有的"行为边界"同处一块',
    inThree('只演你自己') && inThree('就停下等他') && inThree('仍不替玩家操控他的角色'),
    `i3=${i3} i4=${i4}`)
  check('P7 ★ 反证：把 P1 的锚点从第三节里剪掉 ⇒ 同一判据必红', (() => {
    const a = persona.indexOf('## 三、')
    const b = persona.indexOf('## 四、')
    return !persona.slice(a, b).replace('只演你自己', '').includes('只演你自己')
  })(), '')
  check('P8 ★ P6（笔记那条）落在第四节（`## 四、` 之后）—— 它管的是**笔记**，不是演出',
    i4 > 0 && persona.slice(i4).includes('替玩家改了设定'), '')
}

// ── P9 ★★ 读侧的周目边界（2026-09-20 真机：新周目开局跑去 glob 了别的周目）──────
//   事故：19周目开局，本局目录里还没有 `state.md` ⇒ 它 `glob **/state.md`，`path` 写的是**周目目录的上一层**
//   （角色目录）⇒ 结果列出 **5 个别的周目** ⇒ 它读了 17周目那份，并照它把本局的 `state.md` 建了出来。
//   用户口径（选了"只改提示词"这一档）：**读也只在本局周目目录里**，本局没有就是"还没有"⇒ 新建，⛔ 不是去别处找。
pin('P9 ★ 读也只在本局周目目录里（第零节）', ['只在本局周目目录里读', '不许去别处找一份来用'])
pin('P9 ★ 读也只在本局周目目录里（工具清单那一条）',
  ['但只能在本局周目目录里用', '不许写成周目目录的上一层', '立刻停手'])
pin('P9 ★ 读也只在本局周目目录里（笔记放置原则那一段）',
  ['读也一样', '每个周目是独立的一局', '按下面的清单新建'])
{
  /** 某个 `## ` 小节内是否含有某句（小节 = 该标题到下一个 `## ` 之间）。 */
  const inSec = (head, s) => {
    const a = persona.indexOf(head)
    if (a < 0) return false
    const b = persona.indexOf('## ', a + head.length)
    return persona.slice(a, b > a ? b : undefined).includes(s)
  }
  check('P10 ★ 三处分别在零 / 三 / 四节里（⛔ 不许只写在一处 —— 一处丢了另两处还能兜住）',
    inSec('## 零、', '只在本局周目目录里读')
    && inSec('## 三、', '但只能在本局周目目录里用')
    && inSec('## 四、', '读也一样'), '')
  check('P10 ★ 反证：把第零节那句剪掉 ⇒ 同一判据必红', !(() => {
    const a = persona.indexOf('## 零、'); const b = persona.indexOf('## 一、')
    return persona.slice(a, b > a ? b : undefined).replace('只在本局周目目录里读', '').includes('只在本局周目目录里读')
  })(), '')
}

console.log(`\n── ${pass} 通过 / ${fail} 失败 ──`)
process.exitCode = fail === 0 ? 0 : 1
