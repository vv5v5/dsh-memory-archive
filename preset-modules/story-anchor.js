/**
 * story-anchor —— `roleplay` preset 的 **A1 叙事锚点**段（`section()`，order 56）。
 *
 * ## 它解决什么
 * 长会话一旦被压缩，最近的正文会被折叠掉，「现在在哪、几点、还有什么没回收」
 * 就丢了。状态卡（order 50）只给**数值**，Anima（order 55）只给**过去**。
 * 锚点补的是**此刻的坐标**：场景 / 故事内时间 / 进行中 / 未回收伏笔，≤400 字。
 *
 * ## 为什么挂在 preset 里而不是 profile 里
 * 本文件是 `roleplay` preset 的一行（`name: './story-anchor.js'`）。
 * preset 是**会话级**作用域 ⇒ 这个段只对**显式选了 roleplay preset 的会话**存在。
 * 用户的编程会话（standard preset）连这一行都不会加载 —— 这是结构性隔离，
 * 不是靠名单/开关。
 *
 * ## 三条硬约束（都有源码依据，别改）
 * 1. **用 `section()`，不用 `systemPrompt.context()`**：`context()` 是 durable
 *    user-role 快照，文本一变就 `session.append('user/message')`
 *    （`agent-loop/src/agent.ts:291-293`）⇒ 每轮往历史里塞一条。
 * 2. **不用 `agent/pre-step`**：它改写的 `messages` 同样会被逐条 append 进
 *    **durable 历史**。这条**本会话实测过**：在 pre-step 里给第一条消息追加一个标记串，
 *    会话日志的 `user/message` 事件里就真的出现了那个标记
 *    （session-01b9b393-…，seq 7）。
 * 3. **`section()` 的 provider 是同步的**，只能返回缓存值；异步生成放在
 *    `session/event` 的 `turn/end` 里 fire-and-forget（照 `dsh-state-bridge` 的做法）。
 *
 * ## 数据与失败模式
 *   · 锚点正文由**独立的一次侧路 LLM 调用**生成，配置在
 *     `<storageDir>/config.json`（`{ api: { url, model, key, ... } }`）。
 *   · **没有配置 / 调用失败 / 超时 / 返回不是合法 JSON** ⇒ **保留上一份锚点**，
 *     一份都不生成时**完全不注入**（失败关闭，绝不产生空段或编造内容）。
 *   · 锚点按会话持久化在 `<storageDir>/sessions/<sessionId>.json`，重启不丢。
 *
 * @module story-anchor
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cordis 插件名。 */
export const name = 'story-anchor'

/** 需要提示词注册表。 */
export const inject = ['systemPrompt']

/** 段名与顺序：紧跟 Anima（55）之后，是 system 块里**最靠后**的一段。 */
const SECTION_NAME = 'rp:storyAnchor'
const SECTION_ORDER = 56

/** 注入正文的硬上限（能力设计 §2.6 预算：≤400 字）。 */
const MAX_ANCHOR_CHARS = 400

/** 默认存储根：`$DSH_HOME/story-anchor`。 */
function defaultStorageDir() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'story-anchor')
}

/** 默认 L1 状态根（与 `dsh-state-bridge` 的 `storageDir` 对齐，只读它的 state.json）。 */
function defaultL1Dir() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'l1-state')
}

const DEFAULTS = {
  storageDir: defaultStorageDir(),
  l1StateDir: defaultL1Dir(),
  /** 送给侧路 LLM 的最近正文条数（只取 assistant 消息）。 */
  recentMessages: 3,
  /** 每轮最多送多少字符正文。 */
  maxInputChars: 6000,
  /** 攒够几条 assistant 消息才开始生成（避免开局就烧调用）。 */
  minMessages: 2,
}

/** 每会话内存态。 */
const state = new Map()

/** 每会话最近若干条 assistant 正文（供 turn/end 时生成锚点）。 */
const recent = new Map()

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function loadPersisted(dir, sessionId) {
  const file = join(dir, 'sessions', `${sessionId}.json`)
  const parsed = readJson(file)
  if (parsed === undefined || typeof parsed !== 'object') return undefined
  return parsed
}

function persist(dir, sessionId, document) {
  try {
    const target = join(dir, 'sessions')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, `${sessionId}.json`), `${JSON.stringify(document, null, 1)}\n`, 'utf8')
  } catch {
    // 持久化失败不影响注入：内存态照常用。
  }
}

/** 抽一段消息里的纯文本。 */
function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks.map((block) => (block?.type === 'text' ? block.text ?? '' : '')).join('').trim()
}

/** 截断到 n 个字符，超出加省略号。 */
function clip(text, n) {
  return text.length <= n ? text : `${text.slice(0, n - 1)}…`
}

/**
 * 这个字段是不是「什么都没说」。
 *
 * ★ 实测踩过两次坑，所以名单比想象的长：
 *   ① 冒烟第一次：模型老实回 `{"scene":"地点未知，在场者未知，正在发生什么未知"}` —— 结构合法、语义为零；
 *   ② 真周目第三次：注入了 `场景：无场景信息` —— 它不含「未知」，是另一个形状的占位词。
 * 直接注入就是在系统提示词里塞废话、还占预算。所以：
 * **含下列任一标记的字段一律当空处理，宁可不注入。**
 *
 * ⚠️ 刻意**不**把裸「无」放进名单 —— 那样会误杀「无声的走廊」这类正常描写。
 * 只放**多字组合**（无场景/无信息/…）。
 */
const UNKNOWN_MARKERS = [
  '未知', '不详', '无法确定', '未能确定', '尚未确定', '不确定',
  '未提供', '未获取', '未提及', '未说明', '无场景', '无具体', '无信息', '无内容', '无数据',
  '待补充', '待定', '暂无',
  'n/a', 'unknown', 'null', 'none',
]

function isUnknown(text) {
  const value = text.trim()
  if (value === '') return true
  const lowered = value.toLowerCase()
  return UNKNOWN_MARKERS.some((marker) => lowered.includes(marker))
}

// 纯函数导出：给单测用（`产物\memory-tools\_test-story-anchor.mjs`）。
// 导出它们不影响插件行为 —— Cordis 只读 `name` / `inject` / `apply`。
export { isUnknown, renderAnchor, storyTimeFromL1 }

/**
 * 从 L1 状态原子取「故事内时间」的权威值（只读，读不到就返回 undefined）。
 * @param l1StateDir - L1 存储根。
 * @param sessionId - 会话 id。
 * @returns 形如 `1966/09/02 白昼-下午（阴）` 的一行，或 undefined。
 */
function storyTimeFromL1(l1StateDir, sessionId) {
  const atom = readJson(join(l1StateDir, 'sessions', sessionId, 'state.json'))
  const time = atom?.state?.时间
  if (time === undefined || typeof time !== 'object') return undefined
  const parts = [time.日期, time.阶段].filter((value) => typeof value === 'string' && value !== '')
  if (parts.length === 0) return undefined
  const weather = typeof time.天气 === 'string' && time.天气 !== '' ? `（${time.天气}）` : ''
  return `${parts.join(' ')}${weather}`
}

/** 把结构化锚点渲染成 §2.6 的注入模板。 */
function renderAnchor(anchor, fallbackTime) {
  const rawTime = typeof anchor?.time === 'string' ? anchor.time.trim() : ''
  const time = rawTime !== '' && !isUnknown(rawTime) ? rawTime : fallbackTime
  const rawScene = typeof anchor?.scene === 'string' ? anchor.scene.trim() : ''
  const scene = isUnknown(rawScene) ? '' : rawScene
  const keep = (list) => (Array.isArray(list) ? list : [])
    .filter((item) => typeof item === 'string' && !isUnknown(item))
    .map((item) => item.trim())
  const ongoing = keep(anchor?.ongoing)
  const threads = keep(anchor?.threads)
  if (scene === '' && ongoing.length === 0 && threads.length === 0 && time === undefined) return ''

  const lines = [
    '<storyAnchor>',
    '[IMPORTANT: This is the CURRENT story position. Unlike <recalledMemories>, this IS current. Use it to keep continuity of scene, time, and open threads.]',
  ]
  if (scene !== '') lines.push(`场景：${scene}`)
  if (time !== undefined) lines.push(`故事内时间：${time}`)
  if (ongoing.length > 0) lines.push(`进行中：${ongoing.slice(0, 3).join('；')}`)
  if (threads.length > 0) lines.push(`未决伏笔：${threads.slice(0, 3).join('；')}`)
  lines.push('</storyAnchor>')
  return clip(lines.join('\n'), MAX_ANCHOR_CHARS)
}

/** 给侧路 LLM 的指令。要求严格 JSON，方便解析。 */
const INSTRUCTION = [
  '你在为一个中文角色扮演会话维护一份「当前坐标」小抄。它每轮都会被塞进系统提示词，',
  '用来在长对话被折叠后仍保住「现在在哪、几点、还有什么没回收」。',
  '',
  '只输出一个 JSON 对象，不要任何前后语、不要代码块围栏。字段固定：',
  '{',
  '  "scene": "地点 + 在场者 + 正在发生什么，1-2 句，≤60 字",',
  '  "time": "故事内时间，形如 1966/09/02 白昼-下午（阴）；拿不准就给 null",',
  '  "ongoing": ["1-3 条当前正在进行的目标/任务，每条 ≤20 字"],',
  '  "threads": ["0-3 条还没回收的伏笔，每条 ≤20 字"]',
  '}',
  '',
  '规则：',
  '- 用中文；专有名词、数字、物品名逐字照抄，不要改写、不要"整理"。',
  '- scene 写**此刻**的位置与在场者，不要复述剧情经过。',
  '- threads 只列**确实还没回收**的；已经了结的不要写。',
  '- **不知道就写 null 或空数组** —— 绝对不要写「未知」「不详」「不确定」这类占位词，',
  '  那段会被整段丢掉，写它等于白写。',
].join('\n')

/**
 * 调一次侧路 LLM，产出新的锚点对象。
 * @returns 结构化锚点，或 undefined（未配置 / 失败 / 超时 / 非法 JSON）。
 */
async function generateAnchor(api, previous, recentText) {
  if (api === undefined || typeof api.url !== 'string' || typeof api.key !== 'string') return undefined
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort() }, Math.max(1000, api.timeout_ms ?? 60000))
  try {
    const user = [
      previous === undefined ? '（还没有小抄，这是第一份）' : `上一份小抄：\n${JSON.stringify(previous)}`,
      '',
      '最近的正文（由旧到新）：',
      recentText,
    ].join('\n')
    const response = await fetch(api.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${api.key}` },
      body: JSON.stringify({
        model: api.model ?? 'deepseek-ai/DeepSeek-V3.2',
        temperature: api.temperature ?? 0.4,
        max_tokens: api.max_tokens ?? 800,
        messages: [
          { role: 'system', content: INSTRUCTION },
          { role: 'user', content: user },
        ],
      }),
      signal: controller.signal,
    })
    if (!response.ok) return undefined
    const payload = await response.json()
    const raw = payload?.choices?.[0]?.message?.content
    if (typeof raw !== 'string') return undefined
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end <= start) return undefined
    const parsed = JSON.parse(raw.slice(start, end + 1))
    if (parsed === null || typeof parsed !== 'object') return undefined
    return parsed
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * 挂载叙事锚点段。
 * @param ctx - preset 常驻挂载的 scope context。
 * @param config - `{ storageDir?, l1StateDir?, recentMessages?, maxInputChars?, minMessages? }`。
 */
export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const api = readJson(join(cfg.storageDir, 'config.json'))?.api
  const inflight = new Set()

  const anchorTextFor = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return ''
    let entry = state.get(sessionId)
    if (entry === undefined) {
      const persisted = loadPersisted(cfg.storageDir, sessionId)
      entry = { anchor: persisted?.anchor, turn: persisted?.turn }
      state.set(sessionId, entry)
    }
    if (entry?.anchor === undefined) return ''
    return renderAnchor(entry.anchor, storyTimeFromL1(cfg.l1StateDir, sessionId))
  }

  // ── 段注册：provider 同步，只回缓存（异步生成在下面）────────────────────
  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: (context) => {
      try {
        return anchorTextFor(context?.agent?.id)
      } catch (error) {
        console.error('[story-anchor] section provider 异常：', error)
        return ''
      }
    },
  }), 'story-anchor.section()')

  const refresh = (sessionId, turn) => {
    if (typeof sessionId !== 'string' || sessionId === '' || inflight.has(sessionId)) return
    const history = recent.get(sessionId) ?? []
    if (history.length < cfg.minMessages) return
    if (api === undefined) return
    inflight.add(sessionId)
    const previous = state.get(sessionId)?.anchor
    const text = clip(history.slice(-cfg.recentMessages).join('\n\n---\n\n'), cfg.maxInputChars)
    generateAnchor(api, previous, text)
      .then((anchor) => {
        if (anchor === undefined) return
        const entry = state.get(sessionId) ?? {}
        entry.anchor = anchor
        entry.turn = turn
        entry.at = new Date().toISOString()
        state.set(sessionId, entry)
        persist(cfg.storageDir, sessionId, entry)
      })
      .catch(() => { /* generateAnchor 自己吞异常；这里只是兜底 */ })
      .finally(() => { inflight.delete(sessionId) })
  }

  // ── 事件：攒正文 + 每轮末刷新锚点（fire-and-forget）─────────────────────
  ctx.on('session/event', (session, event) => {
    try {
      const sessionId = session?.header?.id
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (event?.type === 'assistant/message') {
        const text = textOf(event.data?.message?.content)
        if (text === '') return
        const history = recent.get(sessionId) ?? []
        history.push(text)
        // 只留够生成用的尾部，避免长会话把内存吃满。
        if (history.length > cfg.recentMessages * 2) history.splice(0, history.length - cfg.recentMessages * 2)
        recent.set(sessionId, history)
        return
      }
      if (event?.type !== 'turn/end') return
      // ⚠️ 绝不在这里 await / 同步 append（会重入），所以刷新是纯 fire-and-forget。
      refresh(sessionId, event.data?.turn)
    } catch (error) {
      console.error('[story-anchor] session/event 处理异常：', error)
    }
  })

  if (api === undefined) {
    console.log(`[story-anchor] 已挂载（order ${SECTION_ORDER}），但未找到 ${join(cfg.storageDir, 'config.json')} 的 api 配置 ⇒ 只做持久化锚点的注入，不生成新的`)
  } else {
    console.log(`[story-anchor] 已挂载（order ${SECTION_ORDER}），侧路模型 ${api.model ?? '(默认)'}`)
  }
}
