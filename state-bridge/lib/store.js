/**
 * 状态存储（纯文件）。
 *
 * ## 为什么是文件，而不是 session 事件
 *
 * DSH 的仓库约定是 "Model-visible ⟺ logged"（`方案-L1状态系统迁移.md` §6.6），
 * 按那个约定，注入进 prompt 的状态应该能从 session log 重建 → 需要声明新的 session 事件。
 * **但外部插件做不到**：仓库内新事件必须进 `KNOWN_SESSION_EVENT_TYPES`
 * （`scripts/gen-persistence-catalog.ts` 生成，`verify-persistence-catalog` 门禁），
 * 而 `Session.append` 又没有暴露写 `ignorable` 的参数 → 插件 live append 的新事件是
 * **required-on-read**，老构建读到不认识的事件会**拒绝整个日志**
 * （`session-persistence/src/coordinator.ts:1145-1146`）。
 *
 * 所以本插件**绝不新增 session 事件类型**，状态只落文件。
 * 状态是「session log + baseline + 提示词版本」的确定性函数，且 `audit.jsonl` 留了完整流水，
 * 可重放 —— 这是对该约定的一处**已知、有理由的偏差**。
 *
 * ## 布局
 * ```
 * <DSH_HOME>/l1-state/sessions/<sessionId>/
 *   state.json      当前状态 + 锚点（注入读它）
 *   history.jsonl   每轮一份 {turn, seq, at, state} —— 分支重推导的数据源
 *   audit.jsonl     副 API 每次请求/回复/用量/解析结果（**绝不进 prompt**）
 *   failures.jsonl  失败与护栏拒收记录（"失败可见化"）
 *   baseline.json   起跑线（seed，只读）
 * ```
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, copyFileSync, appendFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const SCHEMA_VERSION = 1

export function stateRoot(opts = {}) {
  if (opts.dir) return opts.dir
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'l1-state')
}

export function sessionDir(root, sessionId) {
  // sessionId 来自宿主，但落盘前仍做一次白名单化，避免路径穿越
  const safe = String(sessionId ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  if (!safe) throw new Error('sessionId 不能为空')
  return join(root, 'sessions', safe)
}

export function paths(root, sessionId) {
  const dir = sessionDir(root, sessionId)
  return {
    dir,
    state: join(dir, 'state.json'),
    history: join(dir, 'history.jsonl'),
    audit: join(dir, 'audit.jsonl'),
    failures: join(dir, 'failures.jsonl'),
    baseline: join(dir, 'baseline.json'),
  }
}

export function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
}

function readJson(p, fallback = null) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback }
}

/** 原子写：先写临时文件再替换（照搬 dsh-glm-bridge 在本机验证过的做法）。 */
function writeJsonAtomic(p, value) {
  ensureDir(join(p, '..'))
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try { unlinkSync(p) } catch { /* 不存在就算了 */ }
  copyFileSync(tmp, p)
  try { unlinkSync(tmp) } catch { /* ignore */ }
}

function readJsonl(p) {
  try {
    return readFileSync(p, 'utf8').split(/\r?\n/).filter(l => l.trim())
      .map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

function appendJsonl(p, value) {
  ensureDir(join(p, '..'))
  appendFileSync(p, `${JSON.stringify(value)}\n`, 'utf8')
}

function trimJsonl(p, keep) {
  if (!keep || keep <= 0) return
  try {
    const lines = readFileSync(p, 'utf8').split(/\r?\n/).filter(l => l.trim())
    if (lines.length <= keep) return
    writeFileSync(p, `${lines.slice(lines.length - keep).join('\n')}\n`, 'utf8')
  } catch { /* ignore */ }
}

// ─────────────────────────────────────── 对外 API

/** 读当前状态记录；不存在返回 null。 */
export function readState(root, sessionId) {
  return readJson(paths(root, sessionId).state)
}

/**
 * 写当前状态记录。
 * @param rec { anchor:{turn,seq,at}, state, render?, summary?, expired?, pending?, warnings? }
 */
export function writeState(root, sessionId, rec) {
  const doc = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'dsh-l1-state',
    sessionId,
    anchor: rec.anchor ?? null,
    updatedAt: new Date().toISOString(),
    state: rec.state,
    render: rec.render ?? null,
    lastSummary: rec.summary ?? '',
    lastExpired: rec.expired ?? [],
    lastPending: rec.pending ?? [],
    lastWarnings: rec.warnings ?? [],
    lastGuard: rec.guard ?? null,
    // ★ 必须落盘：注入路径是"从磁盘重读再渲染"，只算在内存里的话
    // 【✎ 本轮状态变更】这一节永远不会出现在真正注入的 prompt 里（实测踩过）。
    lastDiff: rec.diff ?? null,
  }
  writeJsonAtomic(paths(root, sessionId).state, doc)
  return doc
}

export function readBaseline(root, sessionId) {
  return readJson(paths(root, sessionId).baseline)
}

export function writeBaseline(root, sessionId, { state, source, note }) {
  const doc = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'dsh-l1-state-baseline',
    sessionId,
    seededAt: new Date().toISOString(),
    source: source ?? 'unknown',
    note: note ?? '',
    state,
  }
  writeJsonAtomic(paths(root, sessionId).baseline, doc)
  return doc
}

export function appendHistory(root, sessionId, entry) {
  appendJsonl(paths(root, sessionId).history, entry)
  trimJsonl(paths(root, sessionId).history, 400)
}

/** 按 turn 升序返回历史。 */
export function readHistory(root, sessionId) {
  return readJsonl(paths(root, sessionId).history).sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0))
}

export function appendAudit(root, sessionId, entry) {
  appendJsonl(paths(root, sessionId).audit, { at: new Date().toISOString(), ...entry })
  trimJsonl(paths(root, sessionId).audit, 200)
}

export function readAudit(root, sessionId, limit = 50) {
  const all = readJsonl(paths(root, sessionId).audit)
  return all.slice(Math.max(0, all.length - limit))
}

export function appendFailure(root, sessionId, entry) {
  appendJsonl(paths(root, sessionId).failures, { at: new Date().toISOString(), ...entry })
  trimJsonl(paths(root, sessionId).failures, 200)
}

export function readFailures(root, sessionId, limit = 50) {
  const all = readJsonl(paths(root, sessionId).failures)
  return all.slice(Math.max(0, all.length - limit))
}

/** 列出被接管过的会话（给人看的 `state_list`）。 */
export function listSessions(root) {
  const base = join(root, 'sessions')
  if (!existsSync(base)) return []
  const out = []
  for (const name of readdirSync(base)) {
    const p = paths(root, name)
    const st = existsSync(p.state) ? readJson(p.state) : null
    const seeded = existsSync(p.baseline)
    out.push({
      sessionId: name,
      seeded,
      updatedAt: st?.updatedAt ?? null,
      anchorTurn: st?.anchor?.turn ?? null,
      stateDate: st?.state?.时间?.日期 ?? null,
      hasState: Boolean(st),
      mtime: (() => { try { return statSync(p.dir).mtimeMs } catch { return 0 } })(),
    })
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

/** 清掉某个会话的全部本插件产物（回滚用）。 */
export function purgeSession(root, sessionId) {
  const p = paths(root, sessionId)
  let n = 0
  for (const f of [p.state, p.history, p.audit, p.failures, p.baseline]) {
    if (existsSync(f)) { try { unlinkSync(f); n++ } catch { /* ignore */ } }
  }
  return n
}
