/**
 * _selftest-rp-preset-attach.mjs —— 钉住「新周目自动挂 RP 预设」这条链。
 *
 * ## 为什么要有它
 * 这件事以前是**打在第三方 Tavern 上的一处补丁**（每次上游发版都要 rebase）。2026-09-24 用户
 * 拍板收进我们自己的插件 ⇒ 判据进了 `lib/rp-preset-attach.js`。一旦它坏，**现场是静默的**：
 * 周目照样开得出来，只是没有 RP 人设、没有 RP 工具面 —— 玩家要演一轮才发现不对。
 *
 * ## 钉什么
 *   A. 路径判据**按分量**比（`D:\apps\dsh-tarven配置区` 不能被当成 `D:\apps\dsh-tarven` 的子目录）
 *   B. 六种 reason 的取值（谁该切、谁不该切）
 *   C. 点名文件的取值规则（BOM / 坏 JSON / 空 / 越界 id）
 *   D. 接线：真的会在 `agent/created` 时调 `agentPresets.select(agent, 'roleplay')`
 *   E. 绝不抛：服务不在 / 抢晚了（`agent-preset/locked`）⇒ 只记日志
 *   F. 同一会话只动一次
 * ★ 每条都带**反证**：把锚点剪掉/换成错写法 ⇒ 同一判据必须红。
 */
import { registerRpPresetAttach, isPathUnderRoot, normalizeFsPath, decideRpPresetAttach,
  parseAgentPreset, readIntendedPreset, readRpWorkspaceRoot, tavernStorageDir } from './lib/rp-preset-attach.js'

let pass = 0
let fail = 0
const check = (label, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${cond ? '' : '  ← ' + String(extra)}`)
}

// ── A. 路径按分量比 ─────────────────────────────────────────────────────────
{
  check('A1 同根 ⇒ 命中', isPathUnderRoot('D:\\apps\\dsh-tarven', 'D:\\apps\\dsh-tarven') === true)
  check('A2 子目录 ⇒ 命中', isPathUnderRoot('D:\\apps\\dsh-tarven\\char\\play', 'D:\\apps\\dsh-tarven') === true)
  check('A3 兄弟目录（前缀相同）⇒ **不**命中',
    isPathUnderRoot('D:\\apps\\dsh-tarven配置区', 'D:\\apps\\dsh-tarven') === false,
    '这就是 startsWith 会踩的坑')
  check('A4 斜杠/大小写/末尾分隔符差异 ⇒ 仍命中',
    isPathUnderRoot('d:/APPS/dsh-tarven/', 'D:\\apps\\dsh-tarven\\') === true)
  check('A5 空值 ⇒ 不命中', isPathUnderRoot('', 'D:\\x') === false && isPathUnderRoot('D:\\x', '') === false)
  check('A6 normalizeFsPath 折叠重复分隔符', normalizeFsPath('D:\\\\apps//dsh-tarven\\\\') === 'd:/apps/dsh-tarven')

  // ★ 反证：把"按分量比"换成 startsWith ⇒ A3 必须变红
  const naive = (cwd, root) => normalizeFsPath(cwd).startsWith(normalizeFsPath(root))
  check('A ★ 反证：用 startsWith 代替分量比 ⇒ A3 的判据变红',
    naive('D:\\apps\\dsh-tarven配置区', 'D:\\apps\\dsh-tarven') === true, '若这里不是 true，说明反证本身失效')
}

// ── B. 六种 reason ─────────────────────────────────────────────────────────
{
  const base = { cwd: 'D:\\apps\\dsh-tarven\\c\\p', rootPath: 'D:\\apps\\dsh-tarven', presetId: 'roleplay', currentPreset: 'standard' }
  check('B1 周目工作区 + 点名了 + 当前不是它 ⇒ select',
    decideRpPresetAttach(base).action === 'select' && decideRpPresetAttach(base).preset === 'roleplay')
  check('B2 没点名 ⇒ skip/no-config',
    decideRpPresetAttach({ ...base, presetId: null }).reason === 'no-config')
  check('B3 Tavern 没记工作区根 ⇒ skip/no-rp-workspace',
    decideRpPresetAttach({ ...base, rootPath: null }).reason === 'no-rp-workspace')
  check('B4 cwd 认不出 ⇒ skip/no-cwd',
    decideRpPresetAttach({ ...base, cwd: undefined }).reason === 'no-cwd')
  check('B5 不在周目工作区（运维区）⇒ skip/not-rp-workspace',
    decideRpPresetAttach({ ...base, cwd: 'D:\\apps\\dsh-tarven配置区\\产物' }).reason === 'not-rp-workspace')
  check('B6 已经是它 ⇒ skip/already（⛔ 不重复组装）',
    decideRpPresetAttach({ ...base, currentPreset: 'roleplay' }).reason === 'already')

  // ★ 反证：把"只看 cwd 在不在根里"这一步挖掉 ⇒ B5 必红
  const noGuard = (a) => (typeof a.presetId === 'string' && a.presetId !== '' && a.currentPreset !== a.presetId
    ? { action: 'select', reason: 'rp-workspace', preset: a.presetId } : { action: 'skip', reason: 'no-config', preset: null })
  check('B ★ 反证：挖掉"在不在周目工作区"那一步 ⇒ B5 的判据变红',
    noGuard({ ...base, cwd: 'D:\\apps\\dsh-tarven配置区\\产物' }).action === 'select')
}

// ── C. 点名文件的取值规则 ───────────────────────────────────────────────────
{
  check('C1 正常 ⇒ roleplay', parseAgentPreset('{"agentPreset":"roleplay"}').id === 'roleplay')
  check('C2 带 BOM ⇒ 照样解析', parseAgentPreset('\uFEFF{"agentPreset":"roleplay"}').id === 'roleplay')
  check('C3 trim + 前后空格', parseAgentPreset('{ "agentPreset": "  roleplay  " }').id === 'roleplay')
  check('C4 坏 JSON ⇒ null/bad-json', parseAgentPreset('{ nope').why === 'bad-json')
  check('C5 空串 ⇒ null/empty', parseAgentPreset('{"agentPreset":"   "}').why === 'empty')
  check('C6 越界 id（../../etc）⇒ null/unsafe-id', parseAgentPreset('{"agentPreset":"../../etc"}').why === 'unsafe-id')
  check('C7 绝对/相对路径式 id ⇒ 拒', parseAgentPreset('{"agentPreset":"a/b"}').why === 'unsafe-id'
    && parseAgentPreset('{"agentPreset":".hidden"}').why === 'unsafe-id')
  check('C8 不是字符串 ⇒ null', parseAgentPreset(null).why === 'not-a-file')
  // ★ 反证：把"越界拒绝"那一行剪掉 ⇒ C6 必红
  const loose = (raw) => { try { const v = JSON.parse(String(raw).replace(/^\uFEFF/, '')).agentPreset
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : null } catch { return null } }
  check('C ★ 反证：剪掉越界拒绝 ⇒ C6 的判据变红', loose('{"agentPreset":"../../etc"}') === '../../etc')
}

// ── D. 读文件（用假 readFile，不碰真机）──────────────────────────────────────
{
  const dir = tavernStorageDir('C:/home/.dsh')
  check('D0 Tavern 存储目录拼法', dir === 'C:/home/.dsh/pmp-dsh-tavern', dir)
  const files = {
    [`${dir}/agent-preset.json`]: '{"agentPreset":"roleplay"}',
    [`${dir}/play-workspace.json`]: '{"schemaVersion":1,"rootPath":"D:\\\\apps\\\\dsh-tarven"}',
  }
  const rf = (f) => { if (!(f in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e } return files[f] }
  check('D1 读得到点名', readIntendedPreset(dir, rf).id === 'roleplay')
  check('D2 读得到工作区根', readRpWorkspaceRoot(dir, rf) === 'D:\\apps\\dsh-tarven')
  check('D3 文件不在 ⇒ 两个都 null（⛔ 不猜）',
    readIntendedPreset(dir, () => { throw new Error('ENOENT') }).id === null
    && readRpWorkspaceRoot(dir, () => { throw new Error('ENOENT') }) === null)
  check('D4 play-workspace 坏掉 / 没有 rootPath ⇒ null',
    readRpWorkspaceRoot(dir, () => '{ bad') === null
    && readRpWorkspaceRoot(dir, () => '{"schemaVersion":1}') === null)
}

// ── E/F. 接线：假 ctx + 假服务 ──────────────────────────────────────────────
const flush = () => new Promise((r) => setImmediate(r))

function fakeHost({ service } = {}) {
  const listeners = new Map()
  const warns = []
  const infos = []
  const scope = {
    on: (name, fn) => listeners.set(name, fn),
    get: (name) => (name === 'agentPresets' ? service : undefined),
  }
  const ctx = { plugin: (spec) => spec.apply(scope) }
  const log = { info: (m) => infos.push(String(m)), warn: (m) => warns.push(String(m)), error: () => {} }
  return { ctx, log, listeners, warns, infos, scope }
}

function fakeService({ throwOn = null } = {}) {
  const calls = []
  return {
    calls,
    select: async (agent, preset) => {
      calls.push({ sid: agent?.session?.id, preset })
      if (throwOn) { const e = new Error(throwOn.message ?? 'refused'); e.code = throwOn.code; throw e }
      return preset
    },
  }
}

const RP_ROOT = 'D:\\apps\\dsh-tarven'
const mkAgent = ({ cwd, sid, preset }) => ({ cwd, session: { id: sid, header: { agentPreset: preset } } })

// ── E. 周目会话 ⇒ 真的调了 select ───────────────────────────────────────────
{
  const svc = fakeService()
  const host = fakeHost({ service: svc })
  registerRpPresetAttach(host.ctx, {
    log: host.log, dshHome: 'C:/home/.dsh', getService: (s, n) => s.get(n),
    readFile: (f) => {
      if (f.endsWith('agent-preset.json')) return '{"agentPreset":"roleplay"}'
      if (f.endsWith('play-workspace.json')) return JSON.stringify({ rootPath: RP_ROOT })
      throw new Error('ENOENT')
    },
  })
  host.listeners.get('agent/created')({ agent: mkAgent({ cwd: RP_ROOT + '\\char\\play', sid: 's-1', preset: 'standard' }) })
  await flush()
  check('E1 周目工作区的新会话 ⇒ select(agent, roleplay) 恰一次',
    svc.calls.length === 1 && svc.calls[0].preset === 'roleplay' && svc.calls[0].sid === 's-1', JSON.stringify(svc.calls))
  check('E2 成功时记一条 info', host.infos.some((m) => m.includes('新周目已挂预设 roleplay')))
}

// ── F. 运维区会话 ⇒ 一个字节都不动 ──────────────────────────────────────────
{
  const svc = fakeService()
  const host = fakeHost({ service: svc })
  registerRpPresetAttach(host.ctx, {
    log: host.log, dshHome: 'C:/home/.dsh', getService: (s, n) => s.get(n),
    readFile: (f) => (f.endsWith('agent-preset.json') ? '{"agentPreset":"roleplay"}'
      : f.endsWith('play-workspace.json') ? JSON.stringify({ rootPath: RP_ROOT }) : (() => { throw new Error('ENOENT') })()),
  })
  host.listeners.get('agent/created')({ agent: mkAgent({ cwd: 'D:\\apps\\dsh-tarven配置区\\产物', sid: 's-2', preset: 'standard' }) })
  await flush()
  check('F1 运维区（前缀相同）⇒ **不** select', svc.calls.length === 0, JSON.stringify(svc.calls))
  check('F ★ 反证：把路径判据换成 startsWith ⇒ F1 的判据变红',
    normalizeFsPath('D:\\apps\\dsh-tarven配置区\\产物').startsWith(normalizeFsPath(RP_ROOT)))
}

// ── G. 绝不抛：服务不在 / 抢晚了 / 坏文件 ───────────────────────────────────
{
  const host = fakeHost({ service: undefined })
  registerRpPresetAttach(host.ctx, {
    log: host.log, dshHome: 'C:/home/.dsh', getService: (s, n) => s.get(n),
    readFile: (f) => (f.endsWith('agent-preset.json') ? '{"agentPreset":"roleplay"}'
      : f.endsWith('play-workspace.json') ? JSON.stringify({ rootPath: RP_ROOT }) : (() => { throw new Error('ENOENT') })()),
  })
  let threw = null
  try {
    host.listeners.get('agent/created')({ agent: mkAgent({ cwd: RP_ROOT + '\\c', sid: 's-3', preset: 'standard' }) })
    await flush()
  } catch (e) { threw = e }
  check('G1 agentPresets 不在 ⇒ 不抛 + 如实记 warn',
    threw === null && host.warns.some((m) => m.includes('agentPresets 服务不可用')), String(threw) + ' ' + host.warns.join('|'))
}
{
  const svc = fakeService({ throwOn: { code: 'agent-preset/locked' } })
  const host = fakeHost({ service: svc })
  registerRpPresetAttach(host.ctx, {
    log: host.log, dshHome: 'C:/home/.dsh', getService: (s, n) => s.get(n),
    readFile: (f) => (f.endsWith('agent-preset.json') ? '{"agentPreset":"roleplay"}'
      : f.endsWith('play-workspace.json') ? JSON.stringify({ rootPath: RP_ROOT }) : (() => { throw new Error('ENOENT') })()),
  })
  let threw = null
  try {
    host.listeners.get('agent/created')({ agent: mkAgent({ cwd: RP_ROOT + '\\c', sid: 's-4', preset: 'standard' }) })
    await flush()
  } catch (e) { threw = e }
  check('G2 抢晚了（agent-preset/locked）⇒ 不抛 + warn 里带原因与"可手动选"',
    threw === null && host.warns.some((m) => m.includes('agent-preset/locked') && m.includes('手动选')),
    String(threw) + ' ' + host.warns.join('|'))
}
{
  // 点名文件坏 + 两个文件都读不到 ⇒ 静默跳过（不 select、不抛、不刷屏）
  const svc = fakeService()
  const host = fakeHost({ service: svc })
  registerRpPresetAttach(host.ctx, {
    log: host.log, dshHome: 'C:/home/.dsh', getService: (s, n) => s.get(n),
    readFile: () => { throw new Error('ENOENT') },
  })
  let threw = null
  try {
    host.listeners.get('agent/created')({ agent: mkAgent({ cwd: RP_ROOT + '\\c', sid: 's-5', preset: 'standard' }) })
    await flush()
  } catch (e) { threw = e }
  check('G3 两个配置文件都不在 ⇒ 静默（不 select、不抛、不 warn）',
    threw === null && svc.calls.length === 0 && host.warns.length === 0, JSON.stringify(svc.calls) + ' ' + host.warns.join('|'))
}

// ── H. 同一会话只动一次 ─────────────────────────────────────────────────────
{
  const svc = fakeService()
  const host = fakeHost({ service: svc })
  registerRpPresetAttach(host.ctx, {
    log: host.log, dshHome: 'C:/home/.dsh', getService: (s, n) => s.get(n),
    readFile: (f) => (f.endsWith('agent-preset.json') ? '{"agentPreset":"roleplay"}'
      : f.endsWith('play-workspace.json') ? JSON.stringify({ rootPath: RP_ROOT }) : (() => { throw new Error('ENOENT') })()),
  })
  const fire = () => host.listeners.get('agent/created')({ agent: mkAgent({ cwd: RP_ROOT + '\\c', sid: 's-6', preset: 'standard' }) })
  fire(); fire(); fire()
  await flush()
  check('H1 同一 sessionId 触发 3 次 ⇒ 只 select 一次', svc.calls.length === 1, JSON.stringify(svc.calls))
}

// ── I. 不接线的情形也要**如实**（不静默）────────────────────────────────────
{
  const host = fakeHost({ service: fakeService() })
  const r1 = registerRpPresetAttach(host.ctx, { log: host.log, dshHome: '', getService: (s, n) => s.get(n) })
  const r2 = registerRpPresetAttach({}, { log: host.log, dshHome: 'C:/home/.dsh' })
  const r3 = registerRpPresetAttach(host.ctx, { log: host.log, dshHome: 'C:/home/.dsh', getService: (s, n) => s.get(n) })
  check('I1 没 DSH_HOME / 没 ctx.plugin ⇒ installed:false 且都发了 warn',
    r1.installed === false && r2.installed === false && host.warns.length >= 2 && r3.installed === true,
    JSON.stringify([r1, r2, r3]) + ' warns=' + host.warns.length)
}

console.log(`\n── ${pass} 通过 / ${fail} 失败 ──`)
process.exitCode = fail === 0 ? 0 : 1
