/**
 * _selftest-p2-rollback.mjs —— v5 P2「一键回滚」自检（规格书 §五.4 逐条）。
 * ★ 全程在 mkdtemp 的临时根上做（DSH_HOME 指向仓库内临时目录），绝不碰 ~/.dsh；
 *   真机写入由验收方执行。测完即删。
 *
 * 断言清单：
 *   ① 回滚后文件内容 === 备份内容（逐字节）
 *   ② 回滚前「当前文件」被自动备份（.dma-backup/ 里多了一条）
 *   ③ 回滚本身可再回滚（用 ② 那条备份能回到回滚前的状态）
 *   ④ backupFile 传 ../evil.yml、sub/x.yml、不存在的名字 ⇒ 三种都硬拒且零写入
 *   ⑤ trust !== 'user' ⇒ 硬拒；非白名单 id ⇒ 硬拒
 *   ⑥ dryRun:true ⇒ 零写入（前后内容比对 + 备份目录条数不变）
 *   ⑦ 回读校验不一致（_fault:'verify' 注入）⇒ 自动回滚，文件回到操作前内容
 *   附：applyToPreset dryRun 的 ③ 逐行 diff（只增字段）；HTTP 集成 ——
 *      POST /agent/rollback（dryRun 零写入 / 真回滚 / 目录穿越拒绝 / 缺参 / BAD_JSON 一律 200）、
 *      GET /agent/rollback ⇒ 405、既有 /agent/apply 与 /agent/backups 契约不挂。
 */
import http from 'node:http'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(fileURLToPath(import.meta.url))
let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`PASS ${name}`)
  else {
    failures++
    console.log(`FAIL ${name}${detail ? ' —— ' + detail : ''}`)
  }
}

// ---- 0) 隔离：临时根（必须在 import lib/index.js 之前设 DSH_HOME）----
const baseTmp = mkdtempSync(join(repo, '_p2-rollback-selftest-'))
const home = join(baseTmp, 'home')
const presetsRoot = join(home, '.agent-presets')
process.env.DSH_HOME = home
check('临时根在仓库内、不在家目录', resolve(baseTmp).startsWith(resolve(repo)) && !resolve(baseTmp).startsWith(resolve(homedir())), baseTmp)

const rp = await import('./lib/rp-agent.js')

// ---- 1) 造带注释的假 preset（与 _selftest-rp-agent.mjs 同构）----
const COMPOSITION = [
  '# ============================================================',
  '# roleplay —— 角色扮演 preset（P2 回滚自检用）',
  '# 本文件注释约占四成；写入只许碰 customInstruction 那一项。',
  '# ============================================================',
  'cordis:assembly:',
  '  version: 1',
  '  sections:',
  '    - cordis:group',
  '      id: persona',
  '      # —— 7 段 KP 人设（一个字都不改）——',
  '      config:',
  '        - id: persona-kp',
  '          text: |',
  '            你是本次跑团的 KP（游戏主持人），负责推进剧情与裁定。',
  '    - cordis:group',
  '      id: rp',
  '      config:',
  '        - id: rp-tool-scope',
  '          mount: rp-tool-scope',
  '    - cordis:group',
  '      id: compaction',
  '      config:',
  '        - id: compaction-rp',
  '          name: compaction-basic',
  '          config:',
  '            thresholdRatio: 0.75',
  '            retainTokens: 1200',
  "            customInstruction: ''",
  '',
].join('\n')
const ORIGINAL = COMPOSITION
const INSTRUCTION_V1 = '第一版压缩指令：归档历史（P2 回滚自检）。'
const INSTRUCTION_V2 = '第二版压缩指令：换了个写法（P2 回滚自检）。'

function snapshot(dir) {
  const out = new Map()
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, ent.name)
      if (ent.isDirectory()) walk(full)
      else out.set(full, readFileSync(full, 'utf8') + '|' + statSync(full).mtimeMs)
    }
  }
  walk(dir)
  return out
}
function snapEqual(a, b) {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}
function backupNames(backupDir) {
  return readdirSync(backupDir).sort()
}
const compositionPath = () => join(presetsRoot, 'roleplay', 'agent.cordis.yml')
const backupDir = () => join(presetsRoot, 'roleplay', '.dma-backup')

// 造 preset + 两次真写：备份目录里就有了两份备份（b1=原文，b2=第一版状态）
mkdirSync(join(presetsRoot, 'roleplay'), { recursive: true })
writeFileSync(compositionPath(), ORIGINAL, 'utf8')
writeFileSync(join(presetsRoot, 'roleplay', 'preset.yml'), 'name: 角色扮演\n', 'utf8')
const w1 = rp.applyToPreset({ presetsRoot, presetId: 'roleplay', trust: 'user', customInstruction: INSTRUCTION_V1, memoryArchiveRoot: 'session/s-1' })
check('前置：第一次真写 ok', w1.ok === true, JSON.stringify(w1).slice(0, 160))
const stateV1 = readFileSync(compositionPath(), 'utf8')
const w2 = rp.applyToPreset({ presetsRoot, presetId: 'roleplay', trust: 'user', customInstruction: INSTRUCTION_V2, memoryArchiveRoot: 'session/s-1' })
check('前置：第二次真写 ok', w2.ok === true, JSON.stringify(w2).slice(0, 160))
const stateV2 = readFileSync(compositionPath(), 'utf8')
const names = backupNames(backupDir())
check('前置：备份恰 2 份（b1=写前原文，b2=第一版状态）', names.length === 2
  && readFileSync(join(backupDir(), names[0]), 'utf8') === ORIGINAL
  && readFileSync(join(backupDir(), names[1]), 'utf8') === stateV1, names.join(','))
const [B1, B2] = names

// ---- ⑥ dryRun:true 零写入 ----
{
  const before = snapshot(presetsRoot)
  const r = rp.restoreFromBackup({ presetsRoot, presetId: 'roleplay', trust: 'user', backupFile: B1, dryRun: true })
  const planText = r && Array.isArray(r.plan) ? r.plan.join('\n') : ''
  check('⑥ dryRun ok:true + 计划齐（盖回哪个文件 / 当前文件先备份到哪）',
    r.ok === true && r.dryRun === true && Array.isArray(r.plan) && r.plan.length >= 3
    && planText.includes(B1) && planText.includes('.dma-backup') && planText.includes('agent.cordis.yml'),
    JSON.stringify(r).slice(0, 300))
  check('⑥ dryRun 零写入（内容与 mtime 全不变）', snapEqual(before, snapshot(presetsRoot)))
  check('⑥ dryRun 返回形状与 applyToPreset 对齐（restoredFrom/backup/presetDir）',
    r.restoredFrom && r.restoredFrom.name === B1 && r.backup && r.backup.name && r.presetDir && r.presetId === 'roleplay',
    JSON.stringify({ restoredFrom: r.restoredFrom, backup: r.backup }))
}

// ---- ④ 目录穿越 / 非法名 / 不存在的名字 ⇒ 三种都硬拒且零写入 ----
{
  const before = snapshot(presetsRoot)
  for (const [label, bad] of [['../evil.yml', '../evil.yml'], ['sub/x.yml', 'sub/x.yml'], ['不存在的名字', 'agent.cordis.yml.20990101-000000-000']]) {
    const r = rp.restoreFromBackup({ presetsRoot, presetId: 'roleplay', trust: 'user', backupFile: bad })
    check(`④ ${label} ⇒ 硬拒（ok:false + 可读 code）`, r.ok === false && (r.code === 'BAD_BACKUP_NAME' || r.code === 'BACKUP_NOT_FOUND') && typeof r.message === 'string', JSON.stringify(r))
  }
  check('④ 三次拒绝都零写入', snapEqual(before, snapshot(presetsRoot)))
  const r2 = rp.restoreFromBackup({ presetsRoot, presetId: 'roleplay', trust: 'user', backupFile: '..\\evil.yml' })
  check('④ 反斜杠路径（..\\evil.yml）同样硬拒', r2.ok === false && r2.code === 'BAD_BACKUP_NAME', JSON.stringify(r2))
}

// ---- ⑤ trust !== 'user' / 非白名单 id ⇒ 硬拒 ----
{
  const before = snapshot(presetsRoot)
  const r = rp.restoreFromBackup({ presetsRoot, presetId: 'roleplay', trust: 'deployment', backupFile: B1 })
  check('⑤ trust=deployment ⇒ 硬拒 PRESET_READ_ONLY（agent-preset/read-only）', r.ok === false && r.code === 'PRESET_READ_ONLY' && String(r.message).includes('agent-preset/read-only'), JSON.stringify(r))
  check('⑤ trust 拒绝零写入', snapEqual(before, snapshot(presetsRoot)))
  mkdirSync(join(presetsRoot, 'other-rp'), { recursive: true })
  writeFileSync(join(presetsRoot, 'other-rp', 'agent.cordis.yml'), ORIGINAL, 'utf8')
  const before2 = snapshot(presetsRoot)
  const r2 = rp.restoreFromBackup({ presetsRoot, presetId: 'other-rp', trust: 'user', backupFile: B1 })
  check('⑤ 非白名单 id ⇒ 硬拒 PRESET_NOT_WHITELISTED', r2.ok === false && r2.code === 'PRESET_NOT_WHITELISTED', JSON.stringify(r2))
  check('⑤ 白名单拒绝零写入', snapEqual(before2, snapshot(presetsRoot)))
}

// ---- ①② 真回滚：内容逐字节 = 备份；回滚前当前文件被自动备份 ----
{
  const r = rp.restoreFromBackup({ presetsRoot, presetId: 'roleplay', trust: 'user', backupFile: B1 })
  check('① 回滚 ok:true 且 restoredFrom=B1', r.ok === true && r.dryRun === false && r.restoredFrom.name === B1, JSON.stringify(r).slice(0, 240))
  check('① 回滚后文件内容 === 备份内容（逐字节）', readFileSync(compositionPath(), 'utf8') === readFileSync(join(backupDir(), B1), 'utf8'))
  check('① readBack.match === true + errors 空', r.readBack && r.readBack.match === true && Array.isArray(r.errors) && r.errors.length === 0)
  const names3 = backupNames(backupDir())
  const safety = r.backup && r.backup.name
  check('② 回滚前当前文件被自动备份（.dma-backup/ 多一条，且内容 = 回滚前的 V2 状态）',
    names3.length === 3 && safety && safety.startsWith('agent.cordis.yml.')
    && readFileSync(join(backupDir(), safety), 'utf8') === stateV2, names3.join(','))

  // ---- ③ 回滚本身可再回滚：用 ② 那条安全备份回到回滚前状态 ----
  const r3 = rp.restoreFromBackup({ presetsRoot, presetId: 'roleplay', trust: 'user', backupFile: safety })
  check('③ 用安全备份再回滚 ok:true', r3.ok === true, JSON.stringify(r3).slice(0, 200))
  check('③ 文件回到回滚前状态（= V2 状态，逐字节）', readFileSync(compositionPath(), 'utf8') === stateV2)
  check('③ 每次回滚都留下安全备份（现在恰 4 份）', backupNames(backupDir()).length === 4, backupNames(backupDir()).join(','))
}

// ---- ⑦ 回读校验不一致 ⇒ 自动回滚（自检注入 _fault:'verify'）----
{
  const beforeCount = backupNames(backupDir()).length
  const beforeText = readFileSync(compositionPath(), 'utf8')
  const r = rp.restoreFromBackup({ presetsRoot, presetId: 'roleplay', trust: 'user', backupFile: B1, _fault: 'verify' })
  check('⑦ 校验注入 ⇒ ok:false VERIFY_FAILED', r.ok === false && r.code === 'VERIFY_FAILED', JSON.stringify({ ok: r.ok, code: r.code }))
  check('⑦ 报告 rolledBack:true（已自动恢复）', r.rolledBack === true)
  check('⑦ 文件回到操作前内容（逐字节）', readFileSync(compositionPath(), 'utf8') === beforeText)
  check('⑦ 安全备份仍留档（+1）', backupNames(backupDir()).length === beforeCount + 1)
}

// ---- 附：applyToPreset dryRun 的 ③ 逐行 diff（只增字段，既有字段形状不变）----
{
  const before = snapshot(presetsRoot)
  const r = rp.applyToPreset({ presetsRoot, presetId: 'roleplay', trust: 'user', customInstruction: '随便什么新值', dryRun: true })
  check('③ diff 存在且形状 = {line, before, after}', r.ok === true && r.diff && Number.isInteger(r.diff.line) && r.diff.line >= 1
    && typeof r.diff.before === 'string' && typeof r.diff.after === 'string', JSON.stringify(r.diff || {}).slice(0, 200))
  check('③ diff.before 是被改的那行（含 customInstruction），after 是新块（|- 头 + 新值）',
    r.diff.before.includes('customInstruction') && r.diff.after.includes('customInstruction: |-') && r.diff.after.includes('随便什么新值'))
  check('③ diff 之外既有字段形状不变（willApply/plan/binding 还在）', Array.isArray(r.willApply) && Array.isArray(r.plan) && r.binding && typeof r.binding.file === 'string')
  check('③ dryRun 依旧零写入', snapEqual(before, snapshot(presetsRoot)))
}

// ---- HTTP 集成：POST /agent/rollback（一律 200）+ 既有 rest 契约不挂 ----
{
  const { apply } = await import('./lib/index.js')
  const routes = []
  const fakeCtx = {
    get: (name) => (name === 'webServer' ? { register: (r) => (routes.push(r), () => {}) } : undefined),
    inject: (_deps, cb) => cb({ webServer: { register: (r) => (routes.push(r), () => {}) }, effect: (fn) => fn() }),
    effect: (fn) => fn(),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  apply(fakeCtx)
  check('HTTP：apply 后恰好 2 条 prefix 路由（契约未变）', routes.length === 2, String(routes.length))
  const server = http.createServer((req, res) => routes[0].handler(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const call = (method, path, body) =>
    new Promise((resolveP, rejectP) => {
      const data = body === undefined ? null : JSON.stringify(body)
      const req = http.request(
        { host: '127.0.0.1', port, path, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
        (rs) => {
          const chunks = []
          rs.on('data', (c) => chunks.push(c))
          rs.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            let json = null
            try { json = JSON.parse(text) } catch {}
            resolveP({ status: rs.statusCode, json, text })
          })
        },
      )
      req.on('error', rejectP)
      if (data) req.write(data)
      req.end()
    })
  try {
    const before = snapshot(presetsRoot)
    const d = await call('POST', '/dsh-memory-archive/api/agent/rollback', { presetId: 'roleplay', backupFile: B2, dryRun: true })
    check('HTTP dryRun：200 + ok:true + 计划 + 零写入', d.status === 200 && d.json.ok === true && d.json.dryRun === true && Array.isArray(d.json.plan) && snapEqual(before, snapshot(presetsRoot)))

    const names0 = backupNames(backupDir()).length
    const r = await call('POST', '/dsh-memory-archive/api/agent/rollback', { presetId: 'roleplay', backupFile: B2 })
    const afterR = readFileSync(compositionPath(), 'utf8')
    check('HTTP 真回滚：200 + ok:true + 文件内容 = B2（逐字节）', r.status === 200 && r.json.ok === true && r.json.dryRun === false && afterR === readFileSync(join(backupDir(), B2), 'utf8'))
    check('HTTP 真回滚：restoredFrom/backup 齐 + 安全备份落盘（+1）', r.json.restoredFrom && r.json.restoredFrom.name === B2 && r.json.backup && r.json.backup.name && backupNames(backupDir()).length === names0 + 1)
    check('HTTP 真回滚：recompose 拿不到时明说「要新开会话（或重启）」且绝不写「已生效」', r.json.recompose && r.json.recompose.ok === false && r.json.recompose.method === 'unavailable' && String(r.json.recompose.note).includes('新开会话'))
    check('HTTP 真回滚：nextStep 明说需新开会话或重启', typeof r.json.nextStep === 'string' && r.json.nextStep.includes('新开会话'))

    const evil = await call('POST', '/dsh-memory-archive/api/agent/rollback', { presetId: 'roleplay', backupFile: '../evil.yml' })
    check('HTTP 目录穿越：200 + ok:false BAD_BACKUP_NAME（绝不 500）', evil.status === 200 && evil.json.ok === false && evil.json.error.code === 'BAD_BACKUP_NAME')

    const missing = await call('POST', '/dsh-memory-archive/api/agent/rollback', { presetId: 'roleplay' })
    check('HTTP 缺 backupFile：200 + ok:false BAD_REQUEST', missing.status === 200 && missing.json.ok === false && missing.json.error.code === 'BAD_REQUEST')

    const bad = await call('POST', '/dsh-memory-archive/api/agent/rollback', undefined)
    check('HTTP 空体：200 + ok:false（BAD_JSON/BAD_REQUEST）', bad.status === 200 && bad.json.ok === false)

    const get = await call('GET', '/dsh-memory-archive/api/agent/rollback?presetId=roleplay')
    check('HTTP GET /agent/rollback ⇒ 405 METHOD_NOT_ALLOWED（ENDPOINTS 口径）', get.status === 405 && get.json.error.code === 'METHOD_NOT_ALLOWED', `${get.status}`)

    const b = await call('GET', '/dsh-memory-archive/api/agent/backups?presetId=roleplay')
    check('HTTP 既有 /agent/backups 契约不挂：200 + ok:true + 倒序非空', b.status === 200 && b.json.ok === true && b.json.backups.length >= 5 && b.json.backups[0].mtimeMs >= b.json.backups[b.json.backups.length - 1].mtimeMs)

    const a = await call('POST', '/dsh-memory-archive/api/agent/apply', { presetId: 'roleplay', dryRun: true })
    check('HTTP 既有 /agent/apply 契约不挂：200 + ok:true + 计划 + diff 字段', a.status === 200 && a.json.ok === true && Array.isArray(a.json.plan) && a.json.diff && Number.isInteger(a.json.diff.line))
  } finally {
    server.closeAllConnections?.()
    await Promise.race([new Promise((r) => server.close(r)), new Promise((r) => setTimeout(r, 1500))])
  }
}

// ---- 清理 ----
rmSync(baseTmp, { recursive: true, force: true })
check('临时根已删除', !existsSync(baseTmp))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
