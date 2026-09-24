/**
 * rp-preset-attach.js —— 让**新周目**自动挂上我们的 RP 预设（默认 `roleplay`）。
 *
 * ## 为什么要有它（它替掉了打在第三方 Tavern 上的那一处补丁）
 * Tavern 每次「与 XX 新开周目」= 让 DSH 新建一条会话，而它**从不点名用哪套预设**
 * （`git grep agentPreset` 在 Tavern 2.4.1 里零命中）⇒ DSH 用自己的默认值 `standard`
 * ⇒ 新周目没有 RP 人设、没有 RP 工具面。原先靠往 Tavern 里打一处改动（建会话那一刻点名）兜，
 * 代价是**每次上游发版都要 rebase 一次 fork**。用户 2026-09-24 拍板：收进我们自己的插件。
 *
 * ## 怎么做到的（用的都是 DSH 的**公开**缝，不是猴补丁）
 *   · `ctx.on('agent/created', ({agent}))` —— DSH 每建一个 agent 都会发（`agent-presets`
 *     自己就用它做告警），载荷里的 `agent` 带 `cwd`。
 *   · `agentPresets.select(agent, id)` —— DSH 的**远程方法**（DSH 自带的「预设」面板点一下
 *     走的就是它）。它会**重新组装** agent（`swap()` → `recompose()`），所以人设**能进提示词**，
 *     不是"建完再贴一张标签"。
 *   · ⚠️ 它有一条硬限制：会话**开过一轮就锁死**（`agent-preset/locked`：“its agent preset is
 *     fixed”）。新建周目到玩家发第一条之间是空的，所以我们来得及；但**抢不到就如实报**，
 *     绝不假装成功（玩家仍可在 DSH 预设面板里手动选）。
 *
 * ## 判据从哪来（⛔ 不新造配置面，全部复用 Tavern 自己的状态）
 *   · **哪条会话算周目会话** = 它的 `cwd` 落在 Tavern 自己记的「角色扮演工作区根」里面
 *     （`<Tavern 存储>/play-workspace.json` 的 `rootPath`）。
 *   · **切到哪个预设** = `<Tavern 存储>/agent-preset.json` 的 `agentPreset`
 *     （就是用户现在那个文件；**删掉它 = 整个功能关掉**，与从前一模一样）。
 *   两个文件每次现读 ⇒ 增/改/删都不用重启宿主。
 *
 * ## 纪律
 *   · 只读 Tavern 那两个 json；⛔ 不写任何文件。
 *   · 每条会话最多动一次（按 sessionId 去重）。
 *   · 全程**绝不抛**：监听器同步返回、异步活自己吃掉异常 —— DSH 的 `agent/created` 里
 *     **同步监听器抛错会否决发布**，我们绝不能让自己的错变成"会话建不出来"。
 */
import { readFileSync } from 'node:fs'

/** 路径规范化：`\` 与 `/` 等价、折叠重复分隔符、去末尾分隔符、Windows 下大小写不敏感。 */
export function normalizeFsPath(p) {
  if (typeof p !== 'string') return ''
  return p.trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * `cwd` 是不是**就在** `root` 里（含 root 自身）。
 *
 * ⚠️ 必须**按路径分量**比，⛔ 不能用 `startsWith`：`D:\apps\dsh-tarven配置区` 的字符串前缀里
 * 就有 `D:\apps\dsh-tarven` —— 前缀比会把**运维区**的会话也当成周目会话。（同类坑在派单守卫
 * 那里已经吃过一次，见任务 #69。）
 */
export function isPathUnderRoot(cwd, root) {
  const c = normalizeFsPath(cwd)
  const r = normalizeFsPath(root)
  if (c === '' || r === '') return false
  return c === r || c.startsWith(r + '/')
}

/**
 * `agent-preset.json` 的取值规则（与旧补丁逐条一致：吃 BOM、trim、拒绝越界 id）。
 * @returns `{ id, why }`；取不到可用 id 时 `id` 为 null，`why` 说明原因（只为日志）。
 */
export function parseAgentPreset(raw) {
  if (typeof raw !== 'string') return { id: null, why: 'not-a-file' }
  let parsed
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch {
    return { id: null, why: 'bad-json' }
  }
  const id = parsed?.agentPreset
  if (typeof id !== 'string' || id.trim() === '') return { id: null, why: 'empty' }
  const value = id.trim()
  // 这个 id 会变成 `<dshHome>/.agent-presets/<id>/` 的目录名 ⇒ 拒绝能跑出去的写法。
  if (value.includes('/') || value.includes('\\') || value.includes('..') || value.startsWith('.')) {
    return { id: null, why: 'unsafe-id' }
  }
  return { id: value, why: null }
}

/**
 * 判据（纯函数）：这条新建的会话该不该被切到点名预设。
 *
 * @param cwd - 新会话的工作目录（`agent.cwd`，可能 undefined）。
 * @param rootPath - Tavern 记的角色扮演工作区根（读不到就传 null）。
 * @param presetId - 点名文件给出的预设 id（没有就传 null）。
 * @param currentPreset - 这条会话**当前**的预设（会话头里那个，可能 undefined）。
 * @returns `{ action: 'select'|'skip', reason, preset }`；reason 只为日志，六个取值：
 *          `no-config` / `no-rp-workspace` / `no-cwd` / `not-rp-workspace` / `already` / `rp-workspace`。
 */
export function decideRpPresetAttach({ cwd, rootPath, presetId, currentPreset }) {
  if (typeof presetId !== 'string' || presetId === '') return { action: 'skip', reason: 'no-config', preset: null }
  if (typeof rootPath !== 'string' || rootPath === '') return { action: 'skip', reason: 'no-rp-workspace', preset: null }
  if (typeof cwd !== 'string' || cwd === '') return { action: 'skip', reason: 'no-cwd', preset: null }
  if (!isPathUnderRoot(cwd, rootPath)) return { action: 'skip', reason: 'not-rp-workspace', preset: null }
  if (currentPreset === presetId) return { action: 'skip', reason: 'already', preset: presetId }
  return { action: 'select', reason: 'rp-workspace', preset: presetId }
}

/** Tavern 存储目录 = `<DSH_HOME | ~/.dsh>/pmp-dsh-tavern`（与 Tavern 自己的落点一致）。 */
export function tavernStorageDir(dshHome) {
  return String(dshHome).replace(/[\\/]+$/, '') + '/pmp-dsh-tavern'
}

/** 读文本文件：读不到/不是字符串 ⇒ null（⛔ 不猜、不抛）。 */
export function readTextOrNull(file, readFile) {
  try {
    const raw = readFile(file)
    return typeof raw === 'string' ? raw : (Buffer.isBuffer(raw) ? raw.toString('utf8') : null)
  } catch {
    return null
  }
}

/** 点名文件 ⇒ `{ id, why }`。 */
export function readIntendedPreset(tavernDir, readFile) {
  return parseAgentPreset(readTextOrNull(`${tavernDir}/agent-preset.json`, readFile))
}

/** Tavern 记的角色扮演工作区根；读不到 ⇒ null。 */
export function readRpWorkspaceRoot(tavernDir, readFile) {
  const raw = readTextOrNull(`${tavernDir}/play-workspace.json`, readFile)
  if (raw === null) return null
  try {
    const v = JSON.parse(raw.replace(/^\uFEFF/, ''))
    return typeof v?.rootPath === 'string' && v.rootPath !== '' ? v.rootPath : null
  } catch {
    return null
  }
}

/**
 * 挂上「新周目自动挂 RP 预设」。照本仓既有看守的写法：小插件 + `apply(scope)` + 绝不抛。
 *
 * @param ctx - 宿主 ctx（要有 `plugin`）。
 * @param opts.log - 日志（`{info,warn,error}`）。
 * @param opts.dshHome - `<DSH_HOME | ~/.dsh>`，用来拼 Tavern 存储目录。
 * @param opts.readFile - 同步读文件（默认 `fs.readFileSync(f,'utf8')`；台子注入假的）。
 * @param opts.getService - `(scope, name) => 服务 | undefined`（默认用 `scope.get`；调用方传仓里的 `getService`）。
 * @returns `{ installed, reason? }`
 */
export function registerRpPresetAttach(ctx, { log, dshHome, readFile = (f) => readFileSync(f, 'utf8'), getService } = {}) {
  if (!ctx || typeof ctx.plugin !== 'function') {
    log?.warn?.('[mt] ctx.plugin 不可用，新周目挂预设未接线')
    return { installed: false, reason: 'no-ctx-plugin' }
  }
  if (typeof dshHome !== 'string' || dshHome === '') {
    log?.warn?.('[mt] 拿不到 DSH_HOME，新周目挂预设未接线')
    return { installed: false, reason: 'no-dsh-home' }
  }
  const dir = tavernStorageDir(dshHome)
  const seen = new Set() // sessionId ⇒ 这条已经处理过（⛔ 不许重复组装）
  const readService = typeof getService === 'function'
    ? getService
    : (scope, name) => { try { return scope?.get?.(name) } catch { return undefined } }

  ctx.plugin({
    name: 'dsh-memory-archive:rp-preset-attach',
    apply(scope) {
      scope.on('agent/created', ({ agent } = {}) => {
        // ⚠️ **同步返回**：DSH 里同步监听器抛错会否决 agent 发布 —— 我们绝不能让自己的错
        //    变成"会话建不出来"。异步活自己吃掉异常。
        try {
          const sid = agent?.session?.id ?? agent?.id ?? null
          if (typeof sid !== 'string' || sid === '' || seen.has(sid)) return
          seen.add(sid)
          void attach(scope, agent, sid).catch(() => {})
        } catch { /* 绝不外抛 */ }
      })
    },
  })

  async function attach(scope, agent, sid) {
    try {
      const preset = readIntendedPreset(dir, readFile)
      const rootPath = readRpWorkspaceRoot(dir, readFile)
      const currentPreset = agent?.session?.header?.agentPreset
      const cwd = agent?.cwd ?? agent?.session?.header?.cwd ?? null
      const verdict = decideRpPresetAttach({ cwd, rootPath, presetId: preset.id, currentPreset })
      if (verdict.action !== 'select') return
      const svc = readService(scope, 'agentPresets')
      if (svc === undefined || svc === null || typeof svc.select !== 'function') {
        log?.warn?.(`[mt] agentPresets 服务不可用 ⇒ 新周目没能挂上 ${verdict.preset}（${sid}）`)
        return
      }
      await svc.select(agent, verdict.preset)
      log?.info?.(`[mt] 新周目已挂预设 ${verdict.preset}（${sid}，cwd=${cwd}）`)
    } catch (e) {
      // 如实报，绝不静默：最可能的一种就是"抢晚了"（会话已经开演 ⇒ agent-preset/locked）。
      const detail = e?.code ?? e?.status ?? (e instanceof Error ? e.message : String(e))
      log?.warn?.(`[mt] 新周目挂预设失败（${sid}）：${detail} —— 玩家仍可在 DSH 预设面板里手动选`)
    }
  }

  return { installed: true }
}
