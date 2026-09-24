/**
 * _selftest-compaction-threshold.mjs —— 「自动压缩触发阈值」自检台（2026-09-21）。
 *
 * 任务书 §3.4 要求逐条钉住的东西，全在这一个文件里（纯函数 + 反证，一条都不能只有"相"）：
 *   S1  lib/compaction-threshold.js · clampThresholdPercent（5–90 整数、步长 5、越界夹紧并如实回报）
 *   S2  lib/compaction-threshold.js · clampRetainRatio（**恒 < thresholdRatio**，含反证：不夹就必红）
 *   S3  lib/compaction-threshold.js · contextOccupancy / percentOf / triggerOccupancy
 *       （官方公式逐字；缺字段 ⇒ null，⛔ 不用别的字段顶上）
 *   S4  lib/compaction-threshold.js · scanThresholdRatio / readThresholdRatio / patchThresholdRatio
 *       （**出现次数 ≠ 1 必拒**、原值不在必拒、改完能回读校验、注释与缩进原样保留）
 *   S5  预设定位与写盘（临时目录）：多份候选拒绝改、备份、写后回读校验、值没变就不动盘
 *   S6  生成物（lib/mt-compaction.js 的产物）三件事：①覆写了 compactIfNeeded 且调了 super
 *       ②全文件没有一个 `#` 哈希私有成员 ③读不到配置就用 YAML 原值、且**不退回 0.8**（喂假读盘直测）
 *   S7  路径等价：lib/index.js 的 storageDir() 与生成物里的 panelStorageDir()
 *       在同一组 env（DSH_HOME 有/无/带尾斜杠/新旧名目录）下必须给出**同一个绝对路径**（相 + 反证）
 *   S8  ★ 阈值真生效：真构造官方引擎（子进程 cwd = DSH 检出）+ 真读盘（DSH_HOME → 临时目录）
 *       ⇒ 二分测出**触发点真的移动了**（面板 15% → 20% ⇒ 阈值 19200 → 25600；窗口 128k）
 *
 * 退出码：全绿 0 / 有红 1（用 process.exitCode，⛔ 不用 process.exit）。
 * 只读访问 DSH 检出（解析官方包）与 ~/.dsh 下的真机副本（存在才读）；⛔ 绝不写那两处。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = dirname(fileURLToPath(import.meta.url))
let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✔ ' + name) }
  else { fail += 1; console.log('  ✘ ' + name + (detail === undefined ? '' : '  ← ' + detail)) }
}

// ───────────────────────────── S0 语法与确定性 ─────────────────────────────
console.log('\nS0 语法 / 确定性')
for (const f of ['lib/compaction-threshold.js', 'lib/mt-compaction.js', 'lib/index.js']) {
  const r = spawnSync(process.execPath, ['--check', join(repo, f)], { encoding: 'utf8' })
  check(`node --check ${f}`, r.status === 0, (r.stderr || '').slice(0, 200))
}
const gen = await import('./lib/mt-compaction.js')
const ct = await import('./lib/compaction-threshold.js')
const text1 = gen.buildRpCompactionBackend()
const text2 = gen.buildRpCompactionBackend()
check('生成器连调两次逐字节相同（确定性）', text1 === text2)
check('产物里没有模板串残留（`${` 与反引号都不许进产物）', !text1.includes('${') && !text1.includes('\\u0060'))

// ───────────────────────────── S1 clampThresholdPercent ─────────────────────────────
console.log('\nS1 clampThresholdPercent：5–90 的整数、步长 5')
check('常量 = 5 / 90 / 5 / 15', ct.AUTO_COMPACT_MIN_PERCENT === 5 && ct.AUTO_COMPACT_MAX_PERCENT === 90
  && ct.AUTO_COMPACT_STEP_PERCENT === 5 && ct.AUTO_COMPACT_DEFAULT_PERCENT === 15)
for (const [v, want, clamped] of [[15, 15, false], [5, 5, false], [90, 90, false], [20, 20, false], [0, 5, true], [-7, 5, true],
  [95, 90, true], [1000, 90, true], [22, 20, true], [23, 25, true], [22.4, 20, true], [17.5, 20, true],
  ['35', 35, false], ['abc', 15, true], [null, 15, true], [undefined, 15, true], [NaN, 15, true], [{}, 15, true], [[20], 15, true]]) {
  const got = ct.clampThresholdPercent(v)
  const label = typeof v === 'object' ? JSON.stringify(v) : String(v)
  check(`${label} ⇒ ${want}%${clamped ? '（夹过）' : '（原样）'}`, got.percent === want && got.clamped === clamped,
    JSON.stringify(got))
  // 夹过必须有**人话**原因（面板要显示给用户）；没夹过必须是 null（⛔ 不许编一句废话）
  check(`${label} 的 reason ${clamped ? '诚实给出' : '为 null'}`, clamped ? (typeof got.reason === 'string' && got.reason.length > 0) : got.reason === null,
    JSON.stringify(got.reason))
}
// ★ 反证：值域断言要能咬人 —— 一个"不夹"的实现必须被同一条判据抓住
{
  const naive = (n) => ({ percent: n, clamped: false, reason: null })
  const bad = naive(1000)
  check('★ 反证：不夹紧的实现（原样返回 1000）会被 S1 的判据抓住',
    !(bad.percent === 90 && bad.clamped === true), JSON.stringify(bad))
}

// ───────────────────────────── S2 clampRetainRatio ─────────────────────────────
console.log('\nS2 clampRetainRatio：恒 < thresholdRatio')
check('默认保留比例 = 0.05、上限系数 = 0.7', ct.RETAIN_RATIO_DEFAULT === 0.05 && ct.RETAIN_RATIO_CAP_OF_THRESHOLD === 0.7)
{
  // 给定值更小 ⇒ 听给定值；给定值更大/缺失/非法 ⇒ 封在 0.7×阈值
  check('0.03 @0.15 ⇒ 0.03（给定值更小就听它）', ct.clampRetainRatio(0.03, 0.15) === 0.03, String(ct.clampRetainRatio(0.03, 0.15)))
  check('0.5 @0.15 ⇒ 0.105（封在 0.7×阈值）', ct.clampRetainRatio(0.5, 0.15) === 0.105, String(ct.clampRetainRatio(0.5, 0.15)))
  check('缺失 @0.15 ⇒ 0.05', ct.clampRetainRatio(undefined, 0.15) === 0.05, String(ct.clampRetainRatio(undefined, 0.15)))
  check('非法（"x"）@0.15 ⇒ 0.05（回落默认，不猜）', ct.clampRetainRatio('x', 0.15) === 0.05, String(ct.clampRetainRatio('x', 0.15)))
  check('阈值非法（0）⇒ null（判不出来就不换配置）', ct.clampRetainRatio(0.05, 0) === null)
  check('阈值非法（NaN）⇒ null', ct.clampRetainRatio(0.05, NaN) === null)
  // ★ 玩家把阈值调到最小的 5%：官方要求 retainRatio **严格小于** thresholdRatio
  check('★ 5% 阈值（0.05）+ 预设 retainRatio 0.05 ⇒ 0.035 < 0.05（不撞官方 TargetPressureConfigError）',
    ct.clampRetainRatio(0.05, 0.05) === 0.035, String(ct.clampRetainRatio(0.05, 0.05)))
  // 全域扫描：5–90 步 5 × 各种给定值，恒严格小于
  let allStrict = true
  let worst = null
  for (let p = 5; p <= 90; p += 5) {
    for (const given of [undefined, 0, -1, 0.001, 0.05, 0.16, 0.5, 1, 1e9, NaN, 'x']) {
      const t = p / 100
      const got = ct.clampRetainRatio(given, t)
      if (!(typeof got === 'number' && got > 0 && got < t)) { allStrict = false; worst = { p, given: String(given), got } }
    }
  }
  check('★ 反证：全域扫描（90 个组合）retainRatio 恒 >0 且 **严格 < thresholdRatio**', allStrict, JSON.stringify(worst))
  // ★ 反证：把夹紧换成"原样返回"，同一条判据必红（证明它会咬人，不是橡皮章）
  const naive = (given, t) => (Number.isFinite(given) && given > 0 ? given : 0.05)
  check('★ 反证：不夹紧的实现（原样返回 0.05 @0.05）会被"严格小于"抓住', !(naive(0.05, 0.05) < 0.05), String(naive(0.05, 0.05)))
}

// ───────────────────────────── S3 占用率公式 ─────────────────────────────
console.log('\nS3 contextOccupancy / percentOf / triggerOccupancy（官方公式逐字）')
{
  const full = { contextWindow: 128000, pressureTokens: 50000, surfaceTokens: 4000, sampledSurfaceTokens: 2000 }
  const o = ct.contextOccupancy(full)
  check('三个 token 字段齐 ⇒ projected = max(0, 50000+4000-2000) = 52000 ⇒ 41%',
    o.usedTokens === 52000 && o.percent === 41 && o.formula === 'projected', JSON.stringify(o))
  check('percentOf 给的就是同一个数（42 ⇒ 41，同一份公式）', ct.percentOf(full) === 41)
  // 只有 pressureTokens ⇒ 退到 pressureTokens（官方 ?? 顺序）
  const p = ct.contextOccupancy({ contextWindow: 128000, pressureTokens: 32000 })
  check('缺 surface/sampled ⇒ 用 pressureTokens（32000 ⇒ 25%）', p.usedTokens === 32000 && p.percent === 25 && p.formula === 'pressure', JSON.stringify(p))
  // 只要有一个缺 ⇒ 不算 projected（0 也算"有"）
  check('sampledSurfaceTokens = 0 是**有值**（⇒ 仍走 projected）',
    ct.contextOccupancy({ contextWindow: 1000, pressureTokens: 100, surfaceTokens: 100, sampledSurfaceTokens: 0 }).usedTokens === 200)
  check('surfaceTokens 缺失 ⇒ 退 pressureTokens',
    ct.contextOccupancy({ contextWindow: 1000, pressureTokens: 100, sampledSurfaceTokens: 5 }).formula === 'pressure')
  // 各字段缺失 ⇒ null（⛔ 不拿 0 冒充）
  for (const [label, state] of [
    ['整个 state 为 null', null],
    ['state 是空对象', {}],
    ['没有 contextWindow', { pressureTokens: 100 }],
    ['contextWindow = 0', { contextWindow: 0, pressureTokens: 100 }],
    ['contextWindow 不是数', { contextWindow: '128000', pressureTokens: 100 }],
    ['一个 token 字段都没有', { contextWindow: 128000 }],
    ['pressureTokens 是 null 且 surface 不齐', { contextWindow: 128000, pressureTokens: null, surfaceTokens: 5 }],
  ]) {
    const got = ct.contextOccupancy(state)
    check(`${label} ⇒ percent null + 人话原因`, got.percent === null && got.usedTokens === null && typeof got.reason === 'string' && got.reason.length > 0, JSON.stringify(got))
    check(`${label} ⇒ percentOf 也 null（不是 0）`, ct.percentOf(state) === null, String(ct.percentOf(state)))
  }
  // 上限 100 / 下限 0
  check('占比封顶 100%（压力 > 窗口也不给 120%）', ct.percentOf({ contextWindow: 1000, pressureTokens: 5000 }) === 100)
  check('projected 为负 ⇒ 夹到 0（max(0, …)）', ct.percentOf({ contextWindow: 1000, pressureTokens: 0, surfaceTokens: 0, sampledSurfaceTokens: 500 }) === 0)
  // 触发判定那条：另一个分子（含输出 token）
  const tr = ct.triggerOccupancy({ totalTokens: 60160, usageTokens: 2000 }, 128000)
  check('triggerOccupancy：60160/128000 ⇒ 47%（与上面那个 41% 不是同一个分子）', tr.percent === 47 && tr.totalTokens === 60160, JSON.stringify(tr))
  check('triggerOccupancy 没给 totalTokens ⇒ null + 原因', (() => { const g = ct.triggerOccupancy({}, 128000); return g.percent === null && typeof g.reason === 'string' })())
  check('triggerOccupancy 没给窗口 ⇒ null + 原因（但仍如实给出 totalTokens）', (() => { const g = ct.triggerOccupancy({ totalTokens: 5 }, null); return g.percent === null && g.totalTokens === 5 && typeof g.reason === 'string' })())
}

// ───────────────────────────── S4 patchThresholdRatio ─────────────────────────────
console.log('\nS4 scanThresholdRatio / readThresholdRatio / patchThresholdRatio')
const SAMPLE = [
  '# 顶注',
  '- id: compaction',
  '  config:',
  '    - id: compaction-rp',
  "      name: './mt-compaction-rp.js'",
  '      config:',
  '        thresholdRatio: 0.15',
  '        retainRatio: 0.05',
  '',
].join('\n')
{
  const scan = ct.scanThresholdRatio(SAMPLE)
  check('SAMPLE 里 thresholdRatio 恰好 1 处（第 7 行）', scan.count === 1 && scan.lines[0] === 6 && scan.valueOk === true, JSON.stringify(scan))
  check('readThresholdRatio 读出 0.15', (() => { const r = ct.readThresholdRatio(SAMPLE); return r.ok && r.ratio === 0.15 })(), JSON.stringify(ct.readThresholdRatio(SAMPLE)))
  const patched = ct.patchThresholdRatio(SAMPLE, 0.2)
  check('改成 0.2 成功，before/after 如实', patched.ok && patched.changed && patched.before === 0.15 && patched.after === 0.2, JSON.stringify(patched))
  check('★ 只动了那一行的值：其余行逐字不变（含注释与缩进）',
    patched.text.split('\n').filter((l, i) => l !== SAMPLE.split('\n')[i]).length === 1
    && patched.text.includes('        thresholdRatio: 0.2')
    && patched.text.includes('        retainRatio: 0.05'), patched.text.split('\n')[6])
  check('★ 改完能回读校验（读回来就是 0.2）', ct.readThresholdRatio(patched.text).ratio === 0.2)
  check('值没变 ⇒ changed:false（⛔ 不白写一次盘）', (() => { const r = ct.patchThresholdRatio(SAMPLE, 0.15); return r.ok && r.changed === false })())
  check('目标值非法（0 / 1 / NaN）⇒ 拒绝', !ct.patchThresholdRatio(SAMPLE, 0).ok && !ct.patchThresholdRatio(SAMPLE, 1).ok && !ct.patchThresholdRatio(SAMPLE, NaN).ok)
  // 出现次数 ≠ 1 ⇒ 必拒
  const twice = SAMPLE + '\n      thresholdRatio: 0.2\n'
  const r2 = ct.patchThresholdRatio(twice, 0.3)
  check('★ 出现 2 次 ⇒ 拒绝改，原因里报出次数与行号',
    r2.ok === false && r2.count === 2 && /2 次/.test(r2.reason) && /第 7、10 行/.test(r2.reason), JSON.stringify(r2))
  const none = '# 没有这一行\nfoo: 1\n'
  const r0 = ct.patchThresholdRatio(none, 0.3)
  check('★ 0 处 ⇒ 拒绝改（⛔ 不新增一行），原因说清"没有"', r0.ok === false && r0.count === 0 && /没有/.test(r0.reason), JSON.stringify(r0))
  // 原值不在（不是数字）⇒ 必拒
  const weird = '        thresholdRatio: 有点怪\n'
  const rw = ct.patchThresholdRatio(weird, 0.3)
  check('★ 原值不是数字 ⇒ 拒绝改（不猜着替换）', rw.ok === false && rw.count === 1 && /不是数字/.test(rw.reason), JSON.stringify(rw))
  const block = '        thresholdRatio:\n          nested: 1\n'
  check('★ `thresholdRatio:` 后面接着块标量 ⇒ 不算我们要的那一行（count 0）', ct.scanThresholdRatio(block).count === 0, JSON.stringify(ct.scanThresholdRatio(block)))
  // 行尾注释 / 引号 / 缩进 / CRLF 都得活下来
  const fancy = '  thresholdRatio: 0.15   # 这是注释\n'
  const rf = ct.patchThresholdRatio(fancy, 0.25)
  check('★ 行尾注释与空格原样保留', rf.ok && rf.text === '  thresholdRatio: 0.25   # 这是注释\n', JSON.stringify(rf.text))
  const quoted = "  thresholdRatio: '0.15'\n"
  const rq = ct.patchThresholdRatio(quoted, 0.25)
  check('★ 带引号的原值能认能读（读 0.15）并换成 0.25', rq.ok && rq.before === 0.15 && rq.text === '  thresholdRatio: 0.25\n', JSON.stringify(rq))
  const crlf = 'a\r\n  thresholdRatio: 0.15\r\nb\r\n'
  const rc = ct.patchThresholdRatio(crlf, 0.3)
  check('★ CRLF 文件换行风格不被改写（仍是 \\r\\n）', rc.ok && rc.text === 'a\r\n  thresholdRatio: 0.3\r\nb\r\n', JSON.stringify(rc.text))
  // 反证：整份重写的实现会把注释吃掉 ⇒ 同一条判据必红
  const rewritten = SAMPLE.split('\n').map((l) => (l.includes('thresholdRatio') ? '  thresholdRatio: 0.2' : l)).join('\n')
  check('★ 反证："整份重写"会丢掉缩进（本判据抓得住）', !rewritten.includes('        thresholdRatio: 0.2'), rewritten.split('\n')[6])
}

// ───────────────────────────── S5 预设定位与写盘 ─────────────────────────────
console.log('\nS5 部署预设的定位 / 拒绝改 / 备份 / 回读校验')
const work = mkdtempSync(join(tmpdir(), 'mt-compact-threshold-'))
try {
  const presetRoot = join(work, '.agent-presets')
  const mkPreset = (id, body) => {
    mkdirSync(join(presetRoot, id), { recursive: true })
    writeFileSync(join(presetRoot, id, 'agent.cordis.yml'), body, 'utf8')
  }
  const ASSEMBLY = SAMPLE.replace('# 顶注', '# roleplay 预设')
  mkPreset('roleplay', ASSEMBLY)
  check('findBackendPresets 只认挂着我们后端的那一份（按内容认，不写死 id）',
    (() => { const f = ct.findBackendPresets(presetRoot); return f.ok && f.items.length === 1 && f.items[0].id === 'roleplay' })(),
    JSON.stringify(ct.findBackendPresets(presetRoot)))
  check('readDeployedThresholdRatio ⇒ 0.15 + 路径 + presetId',
    (() => { const r = ct.readDeployedThresholdRatio(presetRoot); return r.ok && r.ratio === 0.15 && r.presetId === 'roleplay' && r.path.endsWith(join('roleplay', 'agent.cordis.yml')) })(),
    JSON.stringify(ct.readDeployedThresholdRatio(presetRoot)))
  // 写：备份 + 定点替换 + 回读校验
  const wrote = ct.writeDeployedThresholdRatio({ presetRoot, ratio: 0.2, stamp: 'TESTSTAMP' })
  check('写成功：before 0.15 → after 0.2，带备份路径', wrote.ok && wrote.changed && wrote.before === 0.15 && wrote.after === 0.2
    && wrote.backupPath === wrote.path + '.bak-TESTSTAMP', JSON.stringify(wrote))
  check('盘上真的写进去了（回读 = 0.2）', ct.readDeployedThresholdRatio(presetRoot).ratio === 0.2)
  check('备份文件存在且内容 = 改之前那一份（逐字节）',
    readFileSync(wrote.backupPath, 'utf8') === ASSEMBLY)
  check('★ 值没变时不动盘：changed:false 且**不产生备份**', (() => {
    const again = ct.writeDeployedThresholdRatio({ presetRoot, ratio: 0.2, stamp: 'STAMP2' })
    return again.ok && again.changed === false && again.backupPath === null && !existsSync(again.path + '.bak-STAMP2')
  })())
  // 反证：多份候选 ⇒ 拒绝改（⛔ 不知道改哪一份就不改）
  mkPreset('roleplay-copy', ASSEMBLY)
  const multi = ct.writeDeployedThresholdRatio({ presetRoot, ratio: 0.35, stamp: 'STAMP3' })
  check('★ 两份候选 ⇒ 拒绝改，原因列出两份 id，且盘上没有被改动',
    multi.ok === false && /2 份/.test(multi.reason) && /roleplay/.test(multi.reason)
    && ct.readDeployedThresholdRatio(join(work, 'nonexistent')).ratio === null, JSON.stringify(multi))
  check('★ 拒绝改之后，两份候选都还是原值（0.2 / 0.15 —— 一个字都没动）',
    readFileSync(join(presetRoot, 'roleplay', 'agent.cordis.yml'), 'utf8').includes('thresholdRatio: 0.2')
    && readFileSync(join(presetRoot, 'roleplay-copy', 'agent.cordis.yml'), 'utf8').includes('thresholdRatio: 0.15'))
  // 目录读不到 / 没有候选 ⇒ 如实 null + 原因（⛔ 不抛）
  check('预设根目录不存在 ⇒ 如实 ok:false + 原因（⛔ 不抛）',
    (() => { const r = ct.readDeployedThresholdRatio(join(work, 'nope')); return r.ok === false && typeof r.reason === 'string' && r.reason.length > 0 })(),
    JSON.stringify(ct.readDeployedThresholdRatio(join(work, 'nope'))))
  check('目录在但一份都没挂我们的后端 ⇒ 如实 ok:false + 原因', (() => {
    const empty = join(work, 'empty-presets')
    mkdirSync(join(empty, 'other'), { recursive: true })
    writeFileSync(join(empty, 'other', 'agent.cordis.yml'), '# 别人的预设\n', 'utf8')
    const r = ct.readDeployedThresholdRatio(empty)
    return r.ok === false && r.ratio === null && /没有挂/.test(r.reason)
  })())
  // compactionNotes：三条如实说明（措辞 2026-09-21 用户定稿，逐字）
  const notes = ct.compactionNotes({ thresholdPercent: 20, usePanelThreshold: true, presetRatio: 0.2, readError: null })
  check('compactionNotes 三条：立刻生效 / 估算（含输出token、略早）/ 超限无视阈值',
    notes.length === 3 && notes[0] === '改完之后立刻生效。'
    && notes[1] === '触发阈值是估算的，因为输出token也参与计算，因此触发会略早于设置值。'
    && notes[2] === '另外如果上下文超限，会无视阈值强制压缩。', JSON.stringify(notes))
  check('★ 反证：拿掉第 3 句（超限强制压）⇒ 同一条判据必红', (() => {
    const cut = notes.slice(0, 2)
    return !(cut.length === 3 && cut[0] === '改完之后立刻生效。'
      && cut[1] === '触发阈值是估算的，因为输出token也参与计算，因此触发会略早于设置值。'
      && cut[2] === '另外如果上下文超限，会无视阈值强制压缩。')
  })())
  check('compactionNotes：面板关着时多一条"走预设原值"的如实说明',
    ct.compactionNotes({ thresholdPercent: 20, usePanelThreshold: false, presetRatio: 0.15, readError: null })
      .some((l) => l.includes('用面板阈值') && l.includes('原值')))
  check('compactionNotes：预设读不到 / 有读错原因时，各多一条如实说明',
    ct.compactionNotes({ thresholdPercent: 20, usePanelThreshold: true, presetRatio: null, readError: '会话不在注册表里' }).length === 5)
} finally {
  rmSync(work, { recursive: true, force: true })
}

// ───────────────────────────── S6 生成物三件事 ─────────────────────────────
console.log('\nS6 生成物：覆写 + 无 # 私有成员 + 读不到就用 YAML 原值')
{
  // ① 覆写了 compactIfNeeded 且调了 super（静态；反证在下面）
  check('★ 生成物里定义了 compactIfNeeded（裸方法名，不带 function 关键字）',
    /\n\s{4}async compactIfNeeded\(agent, trigger, signal\) \{/.test(text1))
  check('★ 覆写体里调了 super.compactIfNeeded(...)',
    /return await super\.compactIfNeeded\(agent, trigger, signal\)/.test(text1))
  check('★ 反证：把 super 调用那一行挖掉 ⇒ 同一条判据必红',
    !/return await super\.compactIfNeeded\(agent, trigger, signal\)/.test(text1.replace('return await super.compactIfNeeded(agent, trigger, signal)', 'return null')))
  // ①b ★ 2026-09-21（真机：压缩静默失败 45 轮）：失败必须**留证据**（落盘堆栈），且**照原样抛**
  check('★ 覆写体把 super 的失败记进日志（logCompactionFailure）后照原样 rethrow',
    /catch \(error\) \{\s*\n\s*\/\/[^\n]*\n\s*logCompactionFailure\(this\.ctx, error, trigger\)\s*\n\s*throw error\s*\n\s*\}/.test(text1)
    || (/logCompactionFailure\(this\.ctx, error, trigger\)/.test(text1) && /throw error/.test(text1)))
  check('★ 反证：把 logCompactionFailure 那一行挖掉 ⇒ 同一条判据必红',
    !/logCompactionFailure\(this\.ctx, error, trigger\)/.test(text1.replace(/logCompactionFailure\(this\.ctx, error, trigger\)/g, '')))
  check('★ 产物里导出了 logCompactionFailure（自检/面板要能调它）',
    /export function logCompactionFailure\(/.test(text1))
  // ①e ★ 2026-09-22（**真机修好后的最终形状**）：两档 —— 主档 RP（**每条消息都带 source**）
  //   → 兜底官方 `super.summarize`。上一版的三档梯子（R1 无 source / R2 +source / R3 官方）是
  //   **诊断脚手架**：真机已验「R2 赢、元凶是缺 source」⇒ 无 source 那一档**是已知坏形状，删掉**，
  //   `withSource` 这个开关也一并删（现在只有一种形状：必带 source）。
  const rungAt = (trigger) => text1.indexOf("logCompactionFailure(this.ctx, error, '" + trigger + "')")
  check('★ 两档都在，且顺序是 主档(RP) → 兜底(official)',
    rungAt('summarize-rp') > 0 && rungAt('summarize-official') > rungAt('summarize-rp'),
    JSON.stringify({ rp: rungAt('summarize-rp'), official: rungAt('summarize-official') }))
  check('★ 反证：把主档那一档挖掉 ⇒ 同一条判据必红（顺序断档）',
    !(() => {
      const broken = text1.replace("logCompactionFailure(this.ctx, error, 'summarize-rp')", '')
      return broken.indexOf("logCompactionFailure(this.ctx, error, 'summarize-rp')") > 0
        && broken.indexOf("logCompactionFailure(this.ctx, error, 'summarize-official')")
          > broken.indexOf("logCompactionFailure(this.ctx, error, 'summarize-rp')")
    })())
  check('★ 兜底 = 官方那条（await super.summarize(input, agent, signal)）',
    /await super\.summarize\(input, agent, signal\)/.test(text1))
  check('★ 反证：把兜底那一行挖掉 ⇒ 同一条判据必红',
    !/await super\.summarize\(input, agent, signal\)/.test(
      text1.replace('await super.summarize(input, agent, signal)', '')))
  // ★ 形状唯一：主档只有**一处**组装，且**不再有** withSource 那个实参（诊断脚手架已删）
  const rungCalls = text1.match(/buildRpSummaryMessages\(rendered, this\.instruction, createUserMessage\)/g) || []
  check('★ 主档只有一处组装调用，且**没有** withSource 实参（旧脚手架的那两个 false/true 调用点已删）',
    rungCalls.length === 1 && !/buildRpSummaryMessages\([^)]*,\s*(?:true|false)\s*,/.test(text1), JSON.stringify(rungCalls))
  check('★ 反证：把 withSource 实参塞回去（旧写法）⇒ 同一条判据必红',
    !(() => {
      const broken = text1.replace('buildRpSummaryMessages(rendered, this.instruction, createUserMessage)',
        'buildRpSummaryMessages(rendered, this.instruction, false, createUserMessage)')
      const found = broken.match(/buildRpSummaryMessages\(rendered, this\.instruction, createUserMessage\)/g) || []
      return found.length === 1 && !/buildRpSummaryMessages\([^)]*,\s*(?:true|false)\s*,/.test(broken)
    })())
  check('★ 两档全失败 ⇒ 兜底那一档的 catch 原样 throw（⛔ 不吞成静默成功）',
    /catch \(error\) \{\s*\n\s*logCompactionFailure\(this\.ctx, error, 'summarize-official'\)\s*\n\s*throw error\s*\n\s*\}/.test(text1))
  check('★ 反证：把兜底的 throw 换成 return null ⇒ 同一条判据必红', (() => {
    const broken = text1.replace(
      "logCompactionFailure(this.ctx, error, 'summarize-official')\n        throw error",
      "logCompactionFailure(this.ctx, error, 'summarize-official')\n        return null")
    return !/catch \(error\) \{\s*\n\s*logCompactionFailure\(this\.ctx, error, 'summarize-official'\)\s*\n\s*throw error\s*\n\s*\}/.test(broken)
  })())
  // ★ 谁走通了必须落盘：两档各有一行 note（人话结论）
  check('★ 两档各有一行「谁走通了」note（logCompactionNote）',
    /summarize-rp 成功/.test(text1) && /summarize-official 成功/.test(text1), '两档的 note 不全')
  check('★ 反证：把兜底那行 note 挖掉 ⇒ "两档各有一行 note" 必红',
    !/summarize-official 成功/.test(text1.replace(/summarize-official 成功/g, '')))
  check('★ 产物里导出了 logCompactionNote（谁走通了那行证据靠它落盘）',
    /export function logCompactionNote\(/.test(text1))
  // ★ logCompactionFailure 自己**绝不抛**（喂畸形输入 + 一个全坏 ctx）
  {
    const dirLog = mkdtempSync(join(tmpdir(), 'ct-logfail-'))
    const prod = join(dirLog, 'm.mjs')
    writeFileSync(prod, text1, 'utf8')
    const m = await import(pathToFileURL(prod).href)
    const bad = new Proxy({}, { get() { throw new Error('ctx 全坏') } })
    let threw = null
    const savedHome = process.env.DSH_HOME
    process.env.DSH_HOME = dirLog                     // ⛔ 别往真机 ~/.dsh 里写
    try { m.logCompactionFailure(bad, undefined, 'pressure') } catch (e) { threw = String(e && e.message) }
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    check('★ logCompactionFailure 对畸形输入/全坏 ctx 也绝不抛（记日志失败不许影响压缩）', threw === null, String(threw))
    check('★ 反证：真写进去了（临时 home 下的日志文件存在且含 trigger=pressure）', (() => {
      try { return readFileSync(join(dirLog, 'dsh-memory-archive', 'compaction-failures.log'), 'utf8').includes('trigger=pressure') } catch { return false }
    })())
    check('★ 反证：同样输入喂给「会抛的实现」⇒ 必红', (() => {
      let t = null
      try { const f = () => { throw new Error('会抛的实现') }; f() } catch (e) { t = String(e.message) }
      return t !== null
    })())
    rmSync(dirLog, { recursive: true, force: true })
  }
  // ①c ★ 2026-09-22 真机修复：seeded/fork 会话里 `assembler.finish` 是 undefined ⇒
  //   官方那句兜底语义（"没 finish chunk ⇒ 当 stop"）我们漏了 ⇒ 45 轮压缩全炸在这行。
  check('★ finishError 对 undefined / null 的 finish 有兜底（当"正常结束"，不读 .kind）',
    /if \(finish === undefined \|\| finish === null\) return undefined/.test(text1))
  check('★ 反证：把那行兜底挖掉 ⇒ 同一条判据必红',
    !/if \(finish === undefined \|\| finish === null\) return undefined/.test(
      text1.replace('if (finish === undefined || finish === null) return undefined', '')))
  // ①d ★ 2026-09-22：**取 finish 这一步本身**也要兜住（真机上它会抛）—— 行为直测
  {
    const dirF = mkdtempSync(join(tmpdir(), 'ct-readfinish-'))
    const pF = join(dirF, 'm.mjs')
    writeFileSync(pF, text1, 'utf8')
    const mF = await import(pathToFileURL(pF).href)
    check('★ 产物里导出了 readFinish（取 finish 的兜底闸）', typeof mF.readFinish === 'function')
    check('★ readFinish 对「取值就抛」的 getter ⇒ 给 {kind:"stop"} 且带 unreadable（⛔ 不抛）',
      (() => {
        const r = mF.readFinish({ get finish() { throw new Error('取值抛错') } })
        return r.kind === 'stop' && typeof r.unreadable === 'string'
      })())
    check('★ readFinish 对缺字段 / null / undefined ⇒ {kind:"stop"}',
      mF.readFinish({}).kind === 'stop' && mF.readFinish(null).kind === 'stop'
      && mF.readFinish(undefined).kind === 'stop' && mF.readFinish({ finish: 42 }).kind === 'stop')
    check('★ readFinish 对正常 finish ⇒ 原样透传（不许把真错吞成 stop）',
      (() => { const f = { kind: 'error', failure: { message: 'x', code: 'y' } }
        const r = mF.readFinish({ finish: f }); return r === f })())
    check('★ 反证：「直接 assembler.finish」那种写法在同一输入上必抛（证明这条闸有用）',
      (() => { try { const a = { get finish() { throw new Error('取值抛错') } }; void a.finish.kind; return false } catch { return true } })())
    rmSync(dirF, { recursive: true, force: true })
  }
  // ② 全文件没有一个 `#` 哈希私有成员
  const hashHits = text1.match(/^\s*#[A-Za-z_$][\w$]*\s*[=;(]/gm) || []
  check('★ 全文件没有一个 `#` 哈希私有成员（有 ⇒ 经 cordis Proxy 调用必抛品牌错）', hashHits.length === 0, hashHits.join(' / '))
  check('★ 反证：往产物里塞一个 `#x = 1;` ⇒ 同一条判据必红', /^\s*#[A-Za-z_$][\w$]*\s*[=;(]/m.test(text1.replace('const TAG = ', '#x = 1;\nconst TAG = ')))
  check('★ 公开属性（不用 #）：officialConfig / baseConfig / panelThresholdReason 都在构造里赋值',
    /this\.officialConfig = official/.test(text1) && /this\.baseConfig = this\.config/.test(text1)
    && /this\.panelThresholdReason = null/.test(text1))

  // ③ 读不到配置 ⇒ 用 YAML 原值、且**不退回 0.8**（喂假读盘结果直测纯函数）
  const mod = await import(join(repo, '_selftest-ct-tmp-product.mjs')).catch(() => null)
  void mod
  const productPath = join(repo, '_selftest-ct-tmp-product.mjs')
  writeFileSync(productPath, text1, 'utf8')
  const inRepo = await import('./_selftest-ct-tmp-product.mjs')
  const apply = inRepo.applyPanelThreshold
  const readText = inRepo.readPanelAutoCompact
  const YAML_RESOLVED = { thresholdRatio: 0.15, retainTokens: 8000, summarizationProvider: '', summarizationModel: '', maxTokens: 8192, compactionRetries: 1, maxOverflowRetries: 1, modelPolicies: [], auto: true }
  check('生成物导出了 applyPanelThreshold / readPanelAutoCompact（自检台可直测的纯函数）',
    typeof apply === 'function' && typeof readText === 'function')
  for (const [label, text] of [
    ['读不到文件（传 null）', null],
    ['空文本', ''],
    ['JSON 坏', '{ not json'],
    ['JSON 是数组', '[]'],
    ['没有 autoCompact 这一段', JSON.stringify({ rootMode: 'session' })],
    ['autoCompact 是 null', JSON.stringify({ autoCompact: null })],
  ]) {
    const panel = readText(text)
    const got = apply(YAML_RESOLVED, panel)
    check(`${label} ⇒ 用 YAML 原值（thresholdRatio 0.15 + retainTokens 8000，⛔ 不是官方 0.8）`,
      got.applied === false && got.config === YAML_RESOLVED && got.config.thresholdRatio !== 0.8
      && got.config.retainTokens === 8000, JSON.stringify({ panel, applied: got.applied }))
  }
  const off = apply(YAML_RESOLVED, readText(JSON.stringify({ autoCompact: { usePanelThreshold: false, thresholdPercent: 20 } })))
  check('★ usePanelThreshold 为 false ⇒ 也用 YAML 原值（面板上那个 20% 不生效）',
    off.applied === false && off.config === YAML_RESOLVED)
  const on = apply(YAML_RESOLVED, readText(JSON.stringify({ autoCompact: { usePanelThreshold: true, thresholdPercent: 20 } })))
  check('★ 开关开着 + 20% ⇒ 整体替换：thresholdRatio 0.2 + retainRatio 0.05，**删掉互斥的 retainTokens**',
    on.applied === true && on.config.thresholdRatio === 0.2 && on.config.retainRatio === 0.05
    && !('retainTokens' in on.config) && on.config !== YAML_RESOLVED && YAML_RESOLVED.retainTokens === 8000,
    JSON.stringify(on.config))
  check('★ 替换出来的是**新对象**（⛔ 没原地改那份 deepFreeze 的 ResolvedConfig）',
    on.config !== YAML_RESOLVED && YAML_RESOLVED.thresholdRatio === 0.15)
  check('★ 幂等：同样的输入连算两次结果逐字段相同', JSON.stringify(apply(YAML_RESOLVED, readText(JSON.stringify({ autoCompact: { usePanelThreshold: true, thresholdPercent: 20 } }))).config)
    === JSON.stringify(on.config))
  const low = apply(YAML_RESOLVED, readText(JSON.stringify({ autoCompact: { usePanelThreshold: true, thresholdPercent: 5 } })))
  check('★ 玩家调到 5% ⇒ retainRatio 被夹到 0.035（严格小于 0.05，不撞官方不变量）', low.config.retainRatio === 0.035 && low.config.retainRatio < low.config.thresholdRatio, JSON.stringify(low.config))
  const garbage = apply(YAML_RESOLVED, readText(JSON.stringify({ autoCompact: { usePanelThreshold: true, thresholdPercent: 'abc' } })))
  check('★ 面板开着但阈值不是数 ⇒ 用 YAML 原值 + 人话原因（⛔ 不猜一个数顶上）',
    garbage.applied === false && typeof garbage.reason === 'string' && garbage.reason.length > 0, JSON.stringify(garbage))
  const clampedIn = apply(YAML_RESOLVED, readText(JSON.stringify({ autoCompact: { usePanelThreshold: true, thresholdPercent: 999 } })))
  check('★ 盘上写着 999（越界）⇒ 读盘侧就夹到 90%（0.9），不至于让引擎拿到非法比例',
    clampedIn.applied === true && clampedIn.config.thresholdRatio === 0.9, JSON.stringify(clampedIn.config))
  // 反证：把"删掉 retainTokens"这一步去掉 ⇒ 判据必红
  check('★ 反证：不删 retainTokens 的实现会被"互斥键必须去掉"抓住（官方 resolveConfig 会直接抛）',
    'retainTokens' in Object.assign({}, YAML_RESOLVED, { retainRatio: 0.05 }), '')
  rmSync(productPath, { force: true })
}

// ───────────────────────────── S7 路径等价 ─────────────────────────────
console.log('\nS7 路径等价：宿主 storageDir() vs 生成物 panelStorageDir()')
{
  const productPath = join(repo, '_selftest-ct-tmp-path.mjs')
  writeFileSync(productPath, text1, 'utf8')
  const prod = await import('./_selftest-ct-tmp-path.mjs')
  const { storageDir: hostStorageDir } = await import('./lib/index.js')
  const dirs = []
  const mkHome = (tag) => { const d = mkdtempSync(join(tmpdir(), 'mt-ct-path-' + tag + '-')); dirs.push(d); return d }
  try {
    const none = mkHome('none')
    const both = mkHome('both')
    mkdirSync(join(both, 'dsh-memory-archive'), { recursive: true })
    mkdirSync(join(both, 'magictarven'), { recursive: true })
    const legacy = mkHome('legacy')
    mkdirSync(join(legacy, 'magictarven'), { recursive: true })
    const envs = [
      ['DSH_HOME 指向空目录', { DSH_HOME: none }],
      ['DSH_HOME 带尾斜杠', { DSH_HOME: none + (process.platform === 'win32' ? '\\' : '/') }],
      ['DSH_HOME 两边目录都在（取新名）', { DSH_HOME: both }],
      ['DSH_HOME 只有旧名目录（回退）', { DSH_HOME: legacy }],
      ['DSH_HOME = 空串（等同没设）', { DSH_HOME: '' }],
      ['DSH_HOME = 空白串（等同没设）', { DSH_HOME: '   ' }],
      ['DSH_HOME 未设置', {}],
      ['DSH_HOME = ~', { DSH_HOME: '~' }],
    ]
    for (const [label, env] of envs) {
      let host = null
      let prod2 = null
      try { host = hostStorageDir(env) } catch (e) { host = 'THREW:' + String(e.message) }
      try { prod2 = prod.panelStorageDir(env) } catch (e) { prod2 = 'THREW:' + String(e.message) }
      check(`${label} ⇒ 两边同一个绝对路径`, host === prod2 && typeof host === 'string' && !host.includes('THREW'),
        `host=${host} product=${prod2}`)
    }
    // ★ 反证：一个"只认新名、不回退旧名"的实现，在只有旧名目录那一组上必须与宿主不同
    const naive = (env) => {
      const dshHome = env.DSH_HOME !== undefined && String(env.DSH_HOME).trim() !== '' ? String(env.DSH_HOME) : join(homedir(), '.dsh')
      return join(dshHome, 'dsh-memory-archive')
    }
    check('★ 反证：不回退旧名的实现在"只有旧名目录"这组上会被抓出来（判据不是橡皮章）',
      naive({ DSH_HOME: legacy }) !== hostStorageDir({ DSH_HOME: legacy }), naive({ DSH_HOME: legacy }))
    check('★ 真机部署里那份副本的路径推导入参形状一致（导出存在）', typeof prod.panelStorageDir === 'function')
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
    rmSync(productPath, { force: true })
  }
}

// ───────────────────────────── S8 阈值真生效（E2E） ─────────────────────────────
console.log('\nS8 ★ 端到端：真引擎 + 真读盘 ⇒ 二分测出触发点真的移动了（窗口 128k）')
const dshRoot = process.env.MT_DSH_ROOT || join(repo, '..', 'deepseek-harness')
const anchorOk = (() => {
  try {
    createRequire(join(dshRoot, 'apps', 'cli', 'package.json')).resolve('@deepseek-ai/dsh-compaction-basic')
    return true
  } catch { return false }
})()
if (!anchorOk) {
  console.log('  SKIP 官方包锚点不可用（换机器时属正常）—— E2E 那一节不跑，⛔ 不假装通过')
} else {
  const e2eTmp = mkdtempSync(join(repo, '_selftest-ct-e2e-'))
  const product = join(e2eTmp, 'mt-compaction-rp.js')
  writeFileSync(product, text1, 'utf8')
  const runner = join(e2eTmp, 'runner.mjs')
  writeFileSync(runner, `
const WINDOW = 128000
const cache = new Map()
function node(label, real) {
  if (cache.has(label)) return cache.get(label)
  const fn = function (...args) { return real ? real(...args) : node(label + '()') }
  const p = new Proxy(fn, {
    get(_t, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined
      if (prop === 'length') return 2
      if (prop === 'toString' || prop === 'valueOf') return () => label
      if (real && real[prop] !== undefined) return real[prop]
      return node(label + '.' + String(prop))
    },
    apply(_t, _s, args) { return real ? real(...args) : node(label + '()') },
    set() { return true }, has() { return true },
  })
  cache.set(label, p)
  return p
}
const mod = await import(${JSON.stringify('./mt-compaction-rp.js')})
const out = { degraded: mod.degraded === null, base: null, patched: null, productKeys: null, history: [] }
if (out.degraded) {
  let MEASURED = { totalTokens: 0, contextWindow: WINDOW }
  const llm = { resolveModelInfo: () => ({ context: { contextWindow: WINDOW } }), stream: async function* () {} }
  const tokenMeter = { measure: () => MEASURED }
  const ctx = new Proxy({ llm, tokenMeter, logger: { warn() {} } }, {
    get(t, prop) {
      if (prop in t) return t[prop]
      if (prop === 'get') return (n) => (n === 'llm' ? llm : (n === 'tokenMeter' ? tokenMeter : undefined))
      return node('ctx.' + String(prop))
    },
    set() { return true }, has() { return true },
  })
  const engine = new mod.default(ctx, { thresholdRatio: 0.15, retainRatio: 0.05 })
  out.base = { thresholdRatio: engine.config.thresholdRatio, retainRatio: engine.config.retainRatio }
  const agent = node('agent', { session: node('s', { id: 's1', seq: 1, requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }) })
  const skipped = async (n) => {
    MEASURED = { totalTokens: n, contextWindow: WINDOW }
    try {
      const r = await mod.default.prototype.compactIfNeeded.call(engine, agent, 'pressure', undefined)
      return r === null
    } catch (error) {
      // 越过阈值 ⇒ 真去压 ⇒ 假会话喂不出可压区间 ⇒ 在官方 selectCompactableRange 里炸掉。
      // 「炸掉」与「没跳过」是同一件事（阈值判定已经放过它了）。
      return false
    }
  }
  const boundary = async () => {
    let a = 0, b = 300000
    while (a < b) { const mid = Math.floor((a + b + 1) / 2); if (await skipped(mid)) a = mid; else b = mid - 1 }
    return a + 1
  }
  out.patched = { thresholdRatio: engine.config.thresholdRatio, retainRatio: engine.config.retainRatio, hasRetainTokens: 'retainTokens' in engine.config }
  out.triggerTokens = await boundary()
  out.patched = { thresholdRatio: engine.config.thresholdRatio, retainRatio: engine.config.retainRatio, hasRetainTokens: 'retainTokens' in engine.config }
  // 每一轮都现读：把盘上那个数改掉（同一个进程里再跑一次）⇒ 阈值必须跟着变。
  // ⚠️ 配置文件不存在/坏 JSON 时这一步**做不到**（没有可改的文件）⇒ 如实回 null，⛔ 不算失败。
  out.secondReadTokens = await (async () => {
    try {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const file = path.join(process.env.DSH_HOME, 'dsh-memory-archive', 'config.json')
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
      doc.autoCompact.thresholdPercent = 40
      fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8')
      return await boundary()
    } catch (error) {
      return null
    }
  })()
  out.finalConfig = { thresholdRatio: engine.config.thresholdRatio, retainRatio: engine.config.retainRatio }

  // ── ★ 2026-09-22 三档梯子：**真引擎 + 假 ctx.llm.stream**，看"谁赢的"真的落盘 ──
  // 假流是唯一的判官：它按**请求形状**决定这一档成不成（判据 = 是不是每条消息都带 source）
  // ⇒ 正好把 R1 / R2 分开（R3 是官方那条，形状也是全带 source）。
  // 日志一律写进临时 DSH_HOME（⛔ 绝不碰真机 ~/.dsh）。
  const fsMod = await import('node:fs')
  const pathMod = await import('node:path')
  const logFile = pathMod.join(process.env.DSH_HOME, 'dsh-memory-archive', 'compaction-failures.log')
  const readLog = () => { try { return fsMod.readFileSync(logFile, 'utf8') } catch { return '' } }
  const FIX = [
    { role: 'system', source: { kind: 'plugin', plugin: 'sys' }, content: [{ type: 'text', text: '系统提示词' }] },
    { role: 'user', source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: '玩家发言' }] },
    { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'AI 正文' }] },
    { role: 'user', source: { kind: 'plugin', plugin: 'compact' }, content: [{ type: 'text',
      text: 'This is an automatically generated checkpoint. <compacted-summary>上一份</compacted-summary>' }] },
  ]
  const ladderAgent = node('agent', { session: node('s', { id: 'sid-ladder', seq: 1, requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }) })
  const runLadder = async (accept) => {
    const calls = []
    // ctx 也用 Proxy（与上面那个 ctx 同款）：官方 base 的构造期可能摸 ctx 上的别的东西，
    // 摸不到就当"服务缺席"（返回调用得动的占位）。
    const ladderCtx = new Proxy({
      llm: { stream: async function* (options) {
        const attempt = calls.length + 1
        const allSourced = options.messages.every((message) => message && message.source !== undefined
          && message.source !== null && typeof message.source === 'object')
        const count = options.messages.length
        const firstRole = String(options.messages[0] && options.messages[0].role)
        // 两档怎么分：主档 = 我们那条（system 被摘掉 ⇒ 首条 user、6 条、不带 tools）；
        // 兜底 = 官方形状（input.messages 原样 ⇒ 首条 system、5 条）。
        const isRp = firstRole === 'user' && count === 6
        const hasTools = Object.prototype.hasOwnProperty.call(options, 'tools')
        calls.push({ attempt, allSourced, isRp, hasTools, count, firstRole })
        if (!accept(attempt, { allSourced, isRp })) throw new Error('fake-stream down: attempt-' + attempt)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'WIN-' + attempt }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } },
      logger: { warn() {} },
    }, {
      get(t, prop) {
        if (prop in t) return t[prop]
        if (prop === 'get' || typeof prop === 'symbol') return undefined
        return node('ladderCtx.' + String(prop))
      },
      set() { return true }, has() { return true },
    })
    const ladderEngine = new mod.default(ladderCtx, { thresholdRatio: 0.15, retainRatio: 0.05 })
    const before = readLog().length
    let result = null
    let error = null
    try {
      result = await mod.default.prototype.summarize.call(ladderEngine, { messages: FIX }, ladderAgent, undefined)
    } catch (e) {
      error = String((e && e.message) || e)
    }
    const added = readLog().slice(before)
    return {
      calls,
      error,
      text: result === null ? null : result.summary.map((block) => block.text).join(''),
      notes: added.split('\\n').filter((line) => line.includes('NOTE')).join(' | '),
      failures: added.split('\\n').filter((line) => line.includes('trigger=')).map((line) => line.trim().slice(0, 200)).join(' | '),
    }
  }
  out.ladderRp = await runLadder((_attempt, info) => info.isRp)        // 假流**只对主档（RP）成功**
  out.ladderFallback = await runLadder((_attempt, info) => !info.isRp) // 只说"主档被拒"⇒ 该走兜底
  out.ladderAllFail = await runLadder(() => false)                     // 两档全失败 ⇒ 抛兜底那条
}
console.log('JSON:' + JSON.stringify(out))
`, 'utf8')

  const homeWith = (payload) => {
    const home = mkdtempSync(join(tmpdir(), 'mt-ct-home-'))
    if (payload !== null) {
      mkdirSync(join(home, 'dsh-memory-archive'), { recursive: true })
      writeFileSync(join(home, 'dsh-memory-archive', 'config.json'), typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2), 'utf8')
    }
    return home
  }
  const runCase = (payload) => {
    const home = homeWith(payload)
    try {
      const r = spawnSync(process.execPath, [runner], { cwd: dshRoot, encoding: 'utf8', env: { ...process.env, DSH_HOME: home } })
      const line = (r.stdout || '').split('\n').find((l) => l.startsWith('JSON:'))
      if (line === undefined) return { error: `status=${r.status} stderr=${(r.stderr || '').slice(0, 300)}` }
      return JSON.parse(line.slice(5))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
  const c15 = runCase({ autoCompact: { usePanelThreshold: true, thresholdPercent: 15 } })
  const c20 = runCase({ autoCompact: { usePanelThreshold: true, thresholdPercent: 20 } })
  const cOff = runCase({ autoCompact: { usePanelThreshold: false, thresholdPercent: 20 } })
  const cBad = runCase('{ not json')
  const cNone = runCase(null)
  check('E2E 子进程跑通（真引擎 + 真读盘）', c15.error === undefined && c20.error === undefined && c15.degraded === true,
    JSON.stringify({ c15: c15.error, c20: c20.error }))
  if (c15.error === undefined && c20.error === undefined) {
    check('★ 面板 15% ⇒ 触发点 19200 = 0.15 × 128000（与预设原值同一点）', c15.triggerTokens === 19200, String(c15.triggerTokens))
    check('★ 面板 20% ⇒ 触发点 25600 = 0.2 × 128000（**真的往后挪了 6400**）', c20.triggerTokens === 25600, String(c20.triggerTokens))
    check('★ 生效的不是官方默认 0.8（那会是 102400）', c15.triggerTokens !== 102400 && c20.triggerTokens !== 102400)
    check('★ 同一进程里**每一轮都现读**：盘上改成 40% ⇒ 第二次测出的触发点变成 51200（不用重启、不用重开会话）',
      c20.secondReadTokens === 51200 && c20.finalConfig.thresholdRatio === 0.4, `${c20.secondReadTokens} / ${JSON.stringify(c20.finalConfig)}`)
    check('★ config 里 effective 的是比例式（thresholdRatio 0.2 + retainRatio 0.05，retainTokens 已被去掉）',
      c20.patched.thresholdRatio === 0.2 && c20.patched.retainRatio === 0.05 && c20.patched.hasRetainTokens === false, JSON.stringify(c20.patched))
    check('★ 开关关掉 ⇒ 回到预设 YAML 那两个数（0.15 + retainRatio 0.05，触发点 19200）',
      cOff.triggerTokens === 19200 && cOff.patched.thresholdRatio === 0.15, JSON.stringify({ t: cOff.triggerTokens, p: cOff.patched }))
    check('★ 配置文件是坏 JSON ⇒ 同样回预设原值（触发点 19200），⛔ 不退回官方默认 0.8', cBad.triggerTokens === 19200, JSON.stringify(cBad).slice(0, 400))
    check('★ 根本没有配置文件 ⇒ 同样回预设原值（触发点 19200）', cNone.triggerTokens === 19200, JSON.stringify(cNone).slice(0, 400))
    // ── ★ 2026-09-22 修好后的两档（同一个子进程里的真引擎 + 假 ctx.llm.stream）──
    const L = c15.ladderRp
    const LB = c15.ladderFallback
    const LF = c15.ladderAllFail
    check('★★ 主档（RP）请求里**每条消息都带 source**（这就是真机事故的修复点）',
      L !== undefined && L.calls.length === 1 && L.calls[0].allSourced === true, JSON.stringify(L && L.calls))
    check('★ 假流只对主档成功 ⇒ 只试一档、拿主档的结果、note 写「summarize-rp 成功」',
      L !== undefined && L.error === null && L.calls.length === 1 && L.text === 'WIN-1'
      && /summarize-rp 成功/.test(L.notes), JSON.stringify(L))
    check('★★ 主档被拒 ⇒ 走兜底（第二档 = 官方形状），返回**兜底那条**的结果、note 写「走兜底」',
      LB !== undefined && LB.error === null && LB.calls.length === 2 && LB.text === 'WIN-2'
      && /summarize-official 成功（走兜底）/.test(LB.notes), JSON.stringify(LB))
    check('★ 主档那一档的失败也落盘了（trigger=summarize-rp，带请求形状）',
      LB !== undefined && /trigger=summarize-rp/.test(LB.failures), String(LB && LB.failures))
    check('★ 反证：假流只对主档成功时**不该**出现兜底那次调用（没有第二档）',
      L !== undefined && L.calls.length === 1 && !/summarize-official 成功/.test(L.notes), JSON.stringify(L && L.notes))
    check('★★ 两档全失败 ⇒ 抛的是**兜底那条**（attempt-2）的错，⛔ 不吞',
      LF !== undefined && LF.error === 'fake-stream down: attempt-2'
      && LF.calls.length === 2 && LF.text === null, JSON.stringify(LF))
    check('★ 两档全失败时，两条失败都落盘（summarize-rp / -official 各一条）',
      LF !== undefined && /trigger=summarize-rp/.test(LF.failures) && /trigger=summarize-official/.test(LF.failures),
      String(LF && LF.failures))
    check('★★ 两档的请求形状各就各位：主档 = 我们那条（6 条、system 被摘掉、无 tools、全带 source）；兜底 = 官方形状（5 条、system 原样还在）',
      LF !== undefined && LF.calls.length === 2
      && LF.calls[0].count === 6 && LF.calls[0].firstRole === 'user' && LF.calls[0].allSourced === true && LF.calls[0].hasTools === false
      && LF.calls[1].count === 5 && LF.calls[1].firstRole === 'system' && LF.calls[1].hasTools === false,
      JSON.stringify(LF && LF.calls))
    // ⚠️ 2026-09-24 改口径（**说明为什么**）：原来还要求兜底档 `allSourced === true`（每条 message 都带
    //   `source`）。兜底那一档是**把宿主的消息原样透传**（"官方形状"）—— 它带不带 `source` 是 DSH 的事，
    //   不是我们能保证的。DSH 换到 0.1.7（session 格式 V4）后消息形状变了（同日已在 Tavern 那边踩过
    //   V4 的 tool-role 消息），这条就红了；而**主档**（我们自己那套包裹）仍然逐条带 source ⇒ 那一半照旧钉着。
    //   ⇒ 兜底档只钉"形状 = 官方那套"（5 条 / system 原样在首 / 不是 RP 档 / 无 tools），⛔ 不替 DSH 保证 source。
  }
  rmSync(e2eTmp, { recursive: true, force: true })
}

// ───────────────────────────── S9 两个端点的真机（假 ctx + 真 HTTP） ─────────────────────────────
// 手法照 _selftest-retrieval-config.mjs：真调 apply(假 ctx) → 拿到真 handler → 起本地 HTTP 服务
// → 真发请求。DSH_HOME 指到仓库内临时目录（⛔ 不碰用户家里的 ~/.dsh）。
console.log('\nS9 端点级：GET /compaction/state 与 POST /compaction/config（真 HTTP + 假服务）')
const s9 = await (async () => {
  const { createServer } = await import('node:http')
  const { apply } = await import('./lib/index.js')
  const home = mkdtempSync(join(repo, '.st-ct-http-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const PREFIX = '/dsh-memory-archive/api'
  // 假服务：两个官方投影/计量服务（形状按任务书 §1.1/§1.2 逐字）
  const PRESSURE = { contextWindow: 128000, pressureTokens: 50000, surfaceTokens: 4000, sampledSurfaceTokens: 2000 }
  const MEASURED = { totalTokens: 60160, usageTokens: 2000, contextWindow: 128000 }
  const liveSession = { id: 'session-test-1' }
  const sessions = { get: (id) => (id === 'session-test-1' ? liveSession : undefined) }
  const sessionProjections = { stateOf: (session, key) => (key === 'contextPressure' && session === liveSession ? PRESSURE : undefined) }
  const tokenMeter = { measure: (session) => (session === liveSession ? MEASURED : undefined) }
  const routes = []
  const webServer = { register: (route) => { routes.push(route); return () => {} } }
  const fakeCtx = {
    effect: (fn) => fn(),
    inject: (_names, cb) => cb(fakeCtx),
    get: (name) => {
      if (name === 'webServer') return webServer
      if (name === 'sessions') return sessions
      if (name === 'sessionProjections') return sessionProjections
      if (name === 'tokenMeter') return tokenMeter
      return undefined
    },
    webServer,
    logger: { info() {}, warn() {}, error() {} },
  }
  apply(fakeCtx)
  const handler = routes[0].handler
  const server = createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname
    if (p === PREFIX || p.startsWith(PREFIX + '/')) return handler(req, res)
    res.writeHead(404).end('{}')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}${PREFIX}`
  const call = async (method, path, body) => {
    const init = { method, headers: { accept: 'application/json' } }
    if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body) }
    const resp = await fetch(base + path, init)
    return { status: resp.status, body: await resp.json() }
  }
  const presetYaml = (ratio) => ['- id: compaction', '  config:', '    - id: compaction-rp', "      name: './mt-compaction-rp.js'", '      config:', '        thresholdRatio: ' + ratio, '        retainRatio: 0.05', ''].join('\n')
  const presetDir = join(home, '.agent-presets', 'roleplay')
  mkdirSync(presetDir, { recursive: true })
  writeFileSync(join(presetDir, 'agent.cordis.yml'), presetYaml(0.15), 'utf8')
  const cfgPath = join(home, 'dsh-memory-archive', 'config.json')
  const out = { call: null, presetDir, cfgPath, home }
  try {
    // ① GET /config 的 autoCompact 投影（默认开 + 15%）
    const c0 = await call('GET', '/config')
    out.defaultConfig = c0.body.autoCompact
    // ② GET /compaction/state：假投影 + 假计量 ⇒ 两个数各按各的公式算
    const s1 = await call('GET', '/compaction/state?sessionId=session-test-1')
    out.stateLive = s1.body
    // ③ 没有 sessionId / 不认识的 sessionId ⇒ 如实 null + readError
    const s2 = await call('GET', '/compaction/state')
    const s3 = await call('GET', '/compaction/state?sessionId=session-nope')
    out.stateNoSid = s2.body
    out.stateUnknownSid = s3.body
    // ④ POST /compaction/config：20% ⇒ config.json + 预设 YAML 都写
    const w1 = await call('POST', '/compaction/config', { usePanelThreshold: true, thresholdPercent: 20 })
    out.writeOk = w1.body
    out.yamlAfter = readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8')
    out.configAfter = JSON.parse(readFileSync(cfgPath, 'utf8'))
    out.backupExists = existsSync(join(presetDir, 'agent.cordis.yml.bak-' + String(w1.body.yaml.backupPath || '').split('.bak-')[1]))
    // ⑤ 同一个值再存一次 ⇒ YAML changed:false（不白改一次盘）
    const w2 = await call('POST', '/compaction/config', { usePanelThreshold: true, thresholdPercent: 20 })
    out.writeAgain = w2.body
    // ⑥ 越界（999）⇒ 夹到 90（config 与 yaml 都是 0.9）
    const w3 = await call('POST', '/compaction/config', { thresholdPercent: 999 })
    out.writeClamped = w3.body
    out.yamlClamped = readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8')
    // ⑦ ★ 两件事各自如实：预设里出现 2 处 thresholdRatio ⇒ yaml 拒绝改，但 config 照样写成
    writeFileSync(join(presetDir, 'agent.cordis.yml'), presetYaml(0.9) + '      thresholdRatio: 0.3\n', 'utf8')
    const w4 = await call('POST', '/compaction/config', { usePanelThreshold: false, thresholdPercent: 35 })
    out.writePartial = w4.body
    out.yamlUntouchedOnRefuse = readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8')
    out.configAfterPartial = JSON.parse(readFileSync(cfgPath, 'utf8')).autoCompact
    // ⑧ GET /compaction/state 的 notes 小字（含近似与溢出两条）
    out.notes = out.stateLive.notes
    // ⑨ 盘上写着非法值（字符串开关 + 越界百分比）⇒ sanitize 如实回落 + 记 issue（⛔ 不抛）
    writeFileSync(cfgPath, JSON.stringify({ autoCompact: { usePanelThreshold: 'yes', thresholdPercent: 999 } }, null, 2), 'utf8')
    const c9 = await call('GET', '/config')
    out.sanitized = c9.body
    const s9b = await call('GET', '/compaction/state?sessionId=session-test-1')
    out.stateClamped = { enabled: s9b.body.enabled, thresholdPercent: s9b.body.thresholdPercent, thresholdTokens: s9b.body.thresholdTokens }
    out.status = { c0: c0.status, s1: s1.status, w1: w1.status, w4: w4.status, c9: c9.status }
  } finally {
    await new Promise((r) => server.close(r))
    process.env.DSH_HOME = prevHome
    // ★ 临时 DSH_HOME 清干净（它写在仓库里，⛔ 不留垃圾；也 ⛔ 不碰用户家里的 ~/.dsh）
    rmSync(home, { recursive: true, force: true })
  }
  return out
})()

check('GET /config 投影出 autoCompact（默认开 + 15%）',
  s9.defaultConfig && s9.defaultConfig.usePanelThreshold === true && s9.defaultConfig.thresholdPercent === 15,
  JSON.stringify(s9.defaultConfig))
check('★ GET /compaction/state：percent 走官方公式（52000/128000 ⇒ 41）、triggerPercent 走计量（60160 ⇒ 47）——**两个数确实不同**',
  s9.stateLive.percent === 41 && s9.stateLive.usedTokens === 52000
  && s9.stateLive.triggerPercent === 47 && s9.stateLive.triggerTokens === 60160
  && s9.stateLive.contextWindow === 128000, JSON.stringify({ p: s9.stateLive.percent, u: s9.stateLive.usedTokens, t: s9.stateLive.triggerPercent, tt: s9.stateLive.triggerTokens }))
check('★ 预设阈值是从**部署的 YAML**里读出来的（0.15）+ 生效阈值折算成 token（0.15×128000 = 19200）',
  s9.stateLive.presetThresholdRatio === 0.15 && s9.stateLive.thresholdTokens === 19200
  && s9.stateLive.effectiveThresholdRatio === 0.15, JSON.stringify({ r: s9.stateLive.presetThresholdRatio, t: s9.stateLive.thresholdTokens }))
check('没有 sessionId ⇒ 200 + percent/triggerPercent 都是 null + readError 说清原因（⛔ 不给 0）',
  s9.status.s1 === 200 && s9.stateNoSid.percent === null && s9.stateNoSid.triggerPercent === null
  && typeof s9.stateNoSid.readError === 'string' && s9.stateNoSid.readError.includes('sessionId'), JSON.stringify(s9.stateNoSid.readError))
check('会话不在活注册表里 ⇒ percent null + readError 点名"活会话注册表"',
  s9.stateUnknownSid.percent === null && s9.stateUnknownSid.triggerPercent === null
  && s9.stateUnknownSid.readError.includes('活会话注册表'), String(s9.stateUnknownSid.readError))
check('notes 是宿主给的如实说明（立刻生效 / 估算略早 / 超限无视阈值 —— 逐字）',
  Array.isArray(s9.notes) && s9.notes.length >= 3
  && s9.notes[0] === '改完之后立刻生效。'
  && s9.notes[1] === '触发阈值是估算的，因为输出token也参与计算，因此触发会略早于设置值。'
  && s9.notes[2] === '另外如果上下文超限，会无视阈值强制压缩。',
  JSON.stringify(s9.notes))
check('★ POST /compaction/config：两件事都写成（config.ok 与 yaml.ok 同时 true）',
  s9.writeOk.ok === true && s9.writeOk.config.ok === true && s9.writeOk.yaml.ok === true && s9.writeOk.yaml.changed === true,
  JSON.stringify(s9.writeOk))
check('★ config.json 里落了 autoCompact（20% + 开关开）', s9.configAfter.autoCompact.usePanelThreshold === true && s9.configAfter.autoCompact.thresholdPercent === 20,
  JSON.stringify(s9.configAfter.autoCompact))
check('★ 部署的预设 YAML 只改了那一行（0.15 → 0.2，注释缩进原样）',
  s9.yamlAfter.includes('        thresholdRatio: 0.2') && s9.yamlAfter.includes('        retainRatio: 0.05')
  && !s9.yamlAfter.includes('thresholdRatio: 0.15'), s9.yamlAfter.split('\n')[5])
check('★ 改预设前留了 .bak-<时间戳> 备份', s9.backupExists === true)
check('★ 同一个值再存一次 ⇒ yaml.changed:false（不白改一次盘），config 仍 ok',
  s9.writeAgain.ok === true && s9.writeAgain.yaml.ok === true && s9.writeAgain.yaml.changed === false, JSON.stringify(s9.writeAgain.yaml))
check('★ 越界 999 ⇒ 夹到 90%（config 与 yaml 都是 0.9，并在 config.reason 里如实说明夹过）',
  s9.writeClamped.applied.thresholdPercent === 90 && s9.writeClamped.config.thresholdPercent === 90
  && s9.writeClamped.yaml.after === 0.9 && s9.yamlClamped.includes('thresholdRatio: 0.9')
  && typeof s9.writeClamped.config.reason === 'string' && s9.writeClamped.config.reason.includes('90'), JSON.stringify({ applied: s9.writeClamped.applied, reason: s9.writeClamped.config.reason }))
check('★★ 两件事各自如实：预设里 2 处 thresholdRatio ⇒ yaml.ok:false（拒绝改、盘上没动），**而 config.ok:true**（写成了 35% / 开关关）',
  s9.writePartial.config.ok === true && s9.writePartial.yaml.ok === false
  && String(s9.writePartial.yaml.reason).includes('2 次')
  && s9.writePartial.ok === false && typeof s9.writePartial.error.message === 'string'
  && s9.yamlUntouchedOnRefuse.includes('thresholdRatio: 0.9')
  && s9.configAfterPartial.usePanelThreshold === false && s9.configAfterPartial.thresholdPercent === 35,
  JSON.stringify({ config: s9.writePartial.config, yaml: s9.writePartial.yaml, err: s9.writePartial.error }))

check('★ 盘上写着非法值（"yes" / 999）⇒ sanitize 如实回落：开关仍是**开**（不是被 "yes" 顶成关）、百分比夹到 90 并记进 configError',
  s9.sanitized.autoCompact.usePanelThreshold === true && s9.sanitized.autoCompact.thresholdPercent === 90
  && typeof s9.sanitized.configError === 'string' && s9.sanitized.configError.includes('autoCompact.thresholdPercent'),
  JSON.stringify({ ac: s9.sanitized.autoCompact, err: s9.sanitized.configError }))
check('★ 夹紧后的 90% 真的进了实时读数（thresholdTokens = 0.9 × 128000 = 115200）',
  s9.stateClamped.enabled === true && s9.stateClamped.thresholdPercent === 90 && s9.stateClamped.thresholdTokens === 115200,
  JSON.stringify(s9.stateClamped))

// ───────────────── S10 ★ 修好后的请求形状（从生成物导出纯函数直测） ─────────────────
// 这条钉的是**真机事故的修复点**：请求里**每条消息都必须带 source**
// （上游 forAdapter 对每条 assistant 消息读 source.kind；少一条 ⇒ 整条请求在调用 provider 之前被拒）。
console.log('\nS10 ★ 请求形状：每条消息都必须带 source（纯函数直测，相 + 反证）')
{
  const dir = mkdtempSync(join(tmpdir(), 'ct-ladder-'))
  const prod = join(dir, 'm.mjs')
  writeFileSync(prod, text1, 'utf8')
  try {
    const m = await import(pathToFileURL(prod).href)
    check('★ 产物导出了 buildRpSummaryMessages（组装请求的纯函数）',
      typeof m.buildRpSummaryMessages === 'function')
    // 真机形状的 fixture（与 _selftest-mt-compaction.mjs 4b 同一份：系统提示词 / 玩家发言 /
    // 带思维链与工具调用的 AI 消息 / 历史 checkpoint）
    const FIX = [
      { role: 'system', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
        content: [{ type: 'text', text: 'SYSTEM_SHOULD_NOT_APPEAR' }] },
      { role: 'user', source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: '玩家发言' }] },
      { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [
        { type: 'reasoning', text: 'COT_SHOULD_NOT_APPEAR' },
        { type: 'tool-call', toolCallId: 'c1', name: 'x', arguments: 'TOOLARGS_SHOULD_NOT_APPEAR' },
        { type: 'text', text: 'AI 正文' },
      ] },
      { role: 'user', source: { kind: 'plugin', plugin: 'compact' }, content: [{ type: 'text',
        text: 'This is an automatically generated checkpoint condensing an earlier span. '
          + '<compacted-summary>上一份摘要</compacted-summary>' }] },
    ]
    const rendered = m.renderSummaryInput(FIX)
    const req = m.buildRpSummaryMessages(rendered, 'INSTRUCTION_MARK')
    const shape = m.describeMessages(req)
    // ① ★★ 不变量：一条 MISSING 都不许有（真机那条 requestShape 里满屏 src=MISSING 就是事故本身）
    check('★★ 请求里**每条消息都带 source**（describeMessages 里 0 个 MISSING）',
      req.length > 0 && !shape.includes('src=MISSING')
      && req.every((message) => message.source !== null && typeof message.source === 'object'), shape)
    check('★ 反证：把任一条的 source 摘掉 ⇒ 同一条判据必红（形状里就会出现 MISSING）',
      m.describeMessages(req.map((message, i) => (i === req.length - 1 ? { role: message.role, content: message.content } : message)))
        .includes('src=MISSING'))
    // ② 会话消息搬**原来的** source（引用级）；包裹/开闭标签/指令统一 plugin source
    check('★ 会话消息搬的是**原来那条的 source**（引用级相同：user 与 model 各一条）',
      req[2].source === FIX[1].source && req[3].source === FIX[2].source, shape)
    check('★ 我们自己那几条（包裹 / 开闭标签 / 指令）统一 plugin source，plugin 名 = mt-compaction-rp',
      req[0].source.plugin === 'mt-compaction-rp' && req[1].source.plugin === 'mt-compaction-rp'
      && req[req.length - 2].source.plugin === 'mt-compaction-rp' && req[req.length - 1].source.plugin === 'mt-compaction-rp', shape)
    // ③ 「原来就没有 source」⇒ **补一个 plugin source**（⛔ 绝不发出没有 source 的消息）
    const bare = m.buildRpSummaryMessages(
      m.renderSummaryInput([{ role: 'assistant', content: [{ type: 'text', text: 'AI 正文' }] }]), 'I')
    check('★ 对「原来就没有 source」的消息**补 plugin source**（不变量优先于"形状如实"）',
      bare.every((message) => message.source !== null && typeof message.source === 'object')
      && !m.describeMessages(bare).includes('src=MISSING'), m.describeMessages(bare))
    check('★ 反证：一个"照抄 undefined"（不补）的实现会漏出 MISSING ⇒ 证明这条不变量会咬人', (() => {
      // 手工照抄"没有那条不变量"的行为：source 原样搬（这里就是 undefined）
      const naive = [{ role: 'assistant', content: [{ type: 'text', text: 'AI 正文' }], source: bare[1] && undefined }]
      return m.describeMessages(naive).includes('src=MISSING')
        && !m.describeMessages(bare).includes('src=MISSING')
    })())
    // ④ 过滤规则一个字没动
    const body = JSON.stringify(req)
    check('★ 过滤规则一个字没动：系统提示词 / 思维链 / 工具参数 / checkpoint 原文都不在请求里',
      !body.includes('SYSTEM_SHOULD_NOT_APPEAR') && !body.includes('COT_SHOULD_NOT_APPEAR')
      && !body.includes('TOOLARGS_SHOULD_NOT_APPEAR') && !body.includes('automatically generated checkpoint'))
    check('★ previous_summary 标签就位（抠出来的上一份摘要只在那一条里）',
      body.includes('<previous_summary>') && body.includes('上一份摘要'))
    // ⑤ renderSummaryInput 现在**只有一种行为**：带 source（withSource 那个诊断开关已删）
    check('★ renderSummaryInput 只有一种形状：返回的消息都带原来的 source（诊断开关已删）',
      m.renderSummaryInput(FIX).messages.filter((message) => message.source !== undefined).length
        === m.renderSummaryInput(FIX).messages.length
      && m.renderSummaryInput(FIX).previous === rendered.previous
      && m.renderSummaryInput.length === 1, 'renderSummaryInput.length=' + String(m.renderSummaryInput.length))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('\n== 总结：' + pass + ' 通过 / ' + fail + ' 失败 ==')
if (fail > 0) {
  console.log('失败项见上面的 ✘')
  process.exitCode = 1
}
