/**
 * _selftest-rp-agent.mjs —— v5 P1a「生成 / 修复 RP agent」真落盘自检。
 * ★ 全程在 mkdtemp 的临时根上做「备份 → 原子写 → 回读校验 → 回滚」全流程；
 *   DSH_HOME 指向仓库内临时目录，绝不碰 ~/.dsh（真机写入由验收方执行）。测完即删。
 *
 * 断言清单（规格书 §九.4 逐条）：
 *   ① 写入后注释仍在（原文件注释行在结果里逐行还在）
 *   ② 写入后 customInstruction 值正确 + dma-binding.json 已建
 *   ③ dryRun:true 零写入（文件内容与 mtime 都不变）
 *   ④ 回读不一致 ⇒ 自动回滚（断言回到原内容）
 *   ⑤ trust !== 'user' ⇒ 硬拒且未写任何文件
 *   ⑥ 白名单外的 presetId ⇒ 硬拒
 *   ⑦ 找不到 customInstruction 键 ⇒ ok:false + 可读原因（不猜位置、不整份重写）
 *   附：HTTP 集成 —— 恰好 2 条路由；POST /agent/apply（dryRun 零写入 / 真写 / 一律 200）；
 *      GET /agent/backups；BAD_JSON / 缺参都 200 + ok:false，绝不 500。
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
const baseTmp = mkdtempSync(join(repo, '_rp-agent-selftest-'))
const home = join(baseTmp, 'home')
const presetsRoot = join(home, '.agent-presets')
process.env.DSH_HOME = home
check('临时根在仓库内', resolve(baseTmp).startsWith(resolve(repo)), baseTmp)
check('临时根不在用户家目录', !resolve(baseTmp).startsWith(resolve(homedir())))

const rp = await import('./lib/rp-agent.js')
check(
  'resolvePresetsRoot(env)：默认 = <DSH_HOME>/.agent-presets；显式 env 可注入',
  rp.resolvePresetsRoot() === resolve(presetsRoot) &&
    rp.resolvePresetsRoot({ DSH_MEMORY_ARCHIVE_PRESETS_ROOT: baseTmp }) === resolve(baseTmp),
  String(rp.resolvePresetsRoot()),
)

// ---- 1) 造带注释的假 preset（结构与本机 roleplay 同构：注释约占四成）----
const COMPOSITION = [
  '# ============================================================',
  '# roleplay —— 角色扮演 preset（手工打磨：7 段 persona / rp-tool-scope / story-anchor）',
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
  '        # 工具面收窄（preset scope）：白名单 anima_query / state_list / state_show',
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
// 与上面同构但没有 customInstruction 键的版本（⑦ 用）
const COMPOSITION_NO_KEY = COMPOSITION
  .split('\n')
  .filter((l) => !l.includes('customInstruction'))
  .join('\n')
// 两处 customInstruction 的版本（多义 ⇒ 保守拒绝）
const COMPOSITION_TWO_KEYS = COMPOSITION.replace(
  '          mount: rp-tool-scope',
  '          mount: rp-tool-scope\n          customInstruction: \'x\'',
)

const INSTRUCTION = [
  '你在为一个中文角色扮演长会话生成「历史归档条目」。这段历史会被移出模型上下文。',
  '',
  '## 时间跨度',
  '## 涉及角色',
  '保留 "专有名词" 与数字逐字照抄；it\'s fine；不要"整理"。',
  '', // 结尾多一个空行 + 换行 ⇒ 写入时应被规整（|- 块语义）
].join('\n')
const INSTRUCTION_NORM = INSTRUCTION.replace(/[\n\t ]+$/, '')

function makePreset(id, compositionText) {
  const dir = join(presetsRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.cordis.yml'), compositionText, 'utf8')
  writeFileSync(join(dir, 'preset.yml'), 'name: 角色扮演\n', 'utf8')
  return dir
}

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

/** 与宿主 P0 提取器同口径：块标量读回 customInstruction。 */
function extractInstruction(text) {
  const m = /^[ \t]*customInstruction\s*:\s*[|>][-+]?\s*(?:#.*)?$/m.exec(text)
  if (!m) return null
  const lines = text.slice(m.index).split(/\r?\n/).slice(1)
  const body = []
  let indent = null
  for (const line of lines) {
    if (line.trim() === '') { body.push(''); continue }
    const cur = line.match(/^[ \t]*/)[0].length
    if (indent === null) { if (cur === 0) break; indent = cur }
    if (cur < indent) break
    body.push(line.slice(indent))
  }
  while (body.length && body[body.length - 1] === '') body.pop()
  return body.length ? body.join('\n') : null
}

const rpDir = makePreset('roleplay', COMPOSITION)
const backupDir = join(rpDir, '.dma-backup')

// ---- ③ dryRun:true 零写入 ----
{
  const before = snapshot(presetsRoot)
  const r = rp.applyToPreset({ presetsRoot, presetId: 'roleplay', trust: 'user', customInstruction: INSTRUCTION, memoryArchiveRoot: 'session/s-1', dryRun: true })
  check('③ dryRun ok:true 且有计划', r.ok === true && r.dryRun === true && Array.isArray(r.plan) && r.plan.length >= 3, JSON.stringify(r).slice(0, 200))
  check('③ dryRun 零写入（内容与 mtime 全不变，连备份目录都没建）', snapEqual(before, snapshot(presetsRoot)) && !existsSync(backupDir))
  check('③ dryRun 计划含备份路径与绑定', String(r.plan.join('\n')).includes('.dma-backup') && r.binding && r.binding.file.endsWith('dma-binding.json'))
}

// ---- ①② 真写：注释保全 + 值正确 + 绑定已建 + 备份在 ----
let afterWrite = null
{
  const before = snapshot(presetsRoot)
  const r = rp.applyToPreset({ presetsRoot, presetId: 'roleplay', trust: 'user', customInstruction: INSTRUCTION, memoryArchiveRoot: 'session/s-1' })
  check('② 真写 ok:true 且 applied 恰 1 项', r.ok === true && r.dryRun === false && r.applied.length === 1)
  afterWrite = readFileSync(join(rpDir, 'agent.cordis.yml'), 'utf8')
  const commentLines = COMPOSITION.split('\n').filter((l) => l.trim().startsWith('#'))
  check('① 注释逐行还在（含中文注释与分隔线）', commentLines.every((l) => afterWrite.includes(l)))
  check('① 其余非注释行也原样保留（thresholdRatio/retainTokens/mount 等）', ['thresholdRatio: 0.75', 'retainTokens: 1200', 'mount: rp-tool-scope', '你是本次跑团的 KP'].every((s) => afterWrite.includes(s)))
  check('② customInstruction 按块标量读回 = 预期值', extractInstruction(afterWrite) === INSTRUCTION_NORM)
  check('② rp.commentsPreserved 判定通过', rp.commentsPreserved(COMPOSITION, afterWrite) === true)
  const binding = JSON.parse(readFileSync(join(rpDir, 'dma-binding.json'), 'utf8'))
  check(
    '② dma-binding.json 已建且字段齐',
    binding.schemaVersion === 1 && binding.presetId === 'roleplay' && binding.memoryArchiveRoot === 'session/s-1'
      && binding.managedBy === 'dsh-memory-archive' && typeof binding.updatedAt === 'string',
    JSON.stringify(binding),
  )
  const backups = readdirSync(backupDir)
  check('② 备份恰 1 份且内容 = 原文', backups.length === 1 && readFileSync(join(backupDir, backups[0]), 'utf8') === COMPOSITION, backups.join(','))
  check('② 原文件之外没有多余改动（绑定 + 备份 + 目标文件，共 3 处新增/变化）', snapshot(presetsRoot).size === before.size + 2)
}

// ---- ④ 回读不一致 ⇒ 自动回滚（自检注入 _fault:'verify'）----
{
  const before = snapshot(presetsRoot)
  const r = rp.applyToPreset({ presetsRoot, presetId: 'roleplay', trust: 'user', customInstruction: '完全不同的值', memoryArchiveRoot: null, _fault: 'verify' })
  check('④ 校验注入 ⇒ ok:false VERIFY_FAILED', r.ok === false && r.code === 'VERIFY_FAILED', JSON.stringify({ ok: r.ok, code: r.code }))
  check('④ 报告 rolledBack:true', r.rolledBack === true)
  check('④ 文件回到原内容（逐字节）', readFileSync(join(rpDir, 'agent.cordis.yml'), 'utf8') === afterWrite)
  check('④ 回滚后备份多留了一份（可追溯）', readdirSync(backupDir).length === 2)
  const snap = snapshot(presetsRoot)
  check('④ 除新增备份外无其他变化', snap.size === before.size + 1)
}

// ---- ⑤ trust !== 'user' ⇒ 硬拒且未写任何文件 ----
{
  const before = snapshot(presetsRoot)
  const r = rp.applyToPreset({ presetsRoot, presetId: 'roleplay', trust: 'deployment', customInstruction: 'x' })
  check('⑤ trust=deployment ⇒ 硬拒 PRESET_READ_ONLY', r.ok === false && r.code === 'PRESET_READ_ONLY' && String(r.message).includes('agent-preset/read-only'), JSON.stringify(r))
  const r2 = rp.applyToPreset({ presetsRoot, presetId: 'standard', trust: 'user', customInstruction: 'x' })
  check('⑤ 部署 preset id（standard）即使 trust 传 user 也硬拒', r2.ok === false && r2.code === 'PRESET_READ_ONLY')
  check('⑤ 未写任何文件', snapEqual(before, snapshot(presetsRoot)))
}

// ---- ⑥ 白名单外的 presetId ⇒ 硬拒 ----
{
  const otherDir = makePreset('other-rp', COMPOSITION)
  const before = snapshot(presetsRoot)
  const r = rp.applyToPreset({ presetsRoot, presetId: 'other-rp', trust: 'user', customInstruction: 'x' })
  check('⑥ 白名单外 id ⇒ 硬拒 PRESET_NOT_WHITELISTED', r.ok === false && r.code === 'PRESET_NOT_WHITELISTED' && String(r.message).includes('白名单'), JSON.stringify(r))
  const r2 = rp.applyToPreset({ presetsRoot, presetId: 'Bad_ID', trust: 'user', customInstruction: 'x' })
  check('⑥ 非法 id 形态 ⇒ BAD_PRESET_ID', r2.ok === false && r2.code === 'BAD_PRESET_ID')
  check('⑥ 未写任何文件', snapEqual(before, snapshot(presetsRoot)))
}

// ---- ⑦ 找不到 customInstruction 键 ⇒ ok:false + 可读原因，不猜位置、不整份重写 ----
{
  const nokeyDir = makePreset('roleplay-nokey', COMPOSITION_NO_KEY)
  // 「生成时登记的 id」：前缀 roleplay + 预先放一份我们的绑定 ⇒ 白名单放行，才轮得到测「键不存在」
  writeFileSync(join(nokeyDir, 'dma-binding.json'), JSON.stringify({ schemaVersion: 1, presetId: 'roleplay-nokey', memoryArchiveRoot: null, updatedAt: new Date().toISOString(), managedBy: 'dsh-memory-archive' }, null, 2) + '\n', 'utf8')
  const before = readFileSync(join(nokeyDir, 'agent.cordis.yml'), 'utf8')
  const r = rp.applyToPreset({ presetsRoot, presetId: 'roleplay-nokey', trust: 'user', customInstruction: INSTRUCTION })
  check('⑦ 键不存在 ⇒ ok:false + 「未找到压缩后端项」', r.ok === false && r.code === 'CUSTOM_INSTRUCTION_MISSING' && String(r.message).includes('未找到压缩后端项'), JSON.stringify(r))
  check('⑦ 文件一个字节没动', readFileSync(join(nokeyDir, 'agent.cordis.yml'), 'utf8') === before)

  const twoDir = makePreset('roleplay-twokeys', COMPOSITION_TWO_KEYS)
  writeFileSync(join(twoDir, 'dma-binding.json'), JSON.stringify({ schemaVersion: 1, presetId: 'roleplay-twokeys', managedBy: 'dsh-memory-archive' }, null, 2), 'utf8')
  const r2 = rp.applyToPreset({ presetsRoot, presetId: 'roleplay-twokeys', trust: 'user', customInstruction: INSTRUCTION })
  check('⑦ 多处 customInstruction ⇒ 保守拒绝（不猜位置）', r2.ok === false && r2.code === 'CUSTOM_INSTRUCTION_AMBIGUOUS', JSON.stringify(r2))
}

// ---- 8) HTTP 集成：路由恰好 2 条；两条新 rest 一律 200；dryRun 零写入；真写全链路 ----
{
  // 配置：选了根（session） ⇒ 真写后绑定的 memoryArchiveRoot 应为 session/<id>
  mkdirSync(join(home, 'dsh-memory-archive'), { recursive: true })
  writeFileSync(
    join(home, 'dsh-memory-archive', 'config.json'),
    JSON.stringify({ schemaVersion: 1, rootMode: 'session', root: { sessionId: 'sess-root-1' }, api: { url: '', model: '', key: '' }, prompts: { compaction: null, placeholder: null } }),
    'utf8',
  )
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
    const d = await call('POST', '/dsh-memory-archive/api/agent/apply', { presetId: 'roleplay', dryRun: true })
    check('HTTP dryRun：200 + ok:true + 计划', d.status === 200 && d.json.ok === true && d.json.dryRun === true && Array.isArray(d.json.plan) && d.json.plan.length >= 3)
    check('HTTP dryRun：零写入', snapEqual(before, snapshot(presetsRoot)))

    const w = await call('POST', '/dsh-memory-archive/api/agent/apply', { presetId: 'roleplay', dryRun: false })
    check('HTTP 真写：200 + ok:true + applied/backup/nextStep 齐', w.status === 200 && w.json.ok === true && w.json.applied.length === 1 && w.json.backup.files.length === 1 && String(w.json.nextStep).includes('新开会话'), w.text.slice(0, 300))
    check('HTTP 真写：recompose 拿不到时明说「要新开会话」且绝不写「已生效」', w.json.recompose && w.json.recompose.ok === false && w.json.recompose.method === 'unavailable' && String(w.json.recompose.note).includes('新开会话'))
    check('HTTP 真写：绑定记下了本次根（session/sess-root-1）', w.json.binding.written === true && w.json.binding.memoryArchiveRoot === 'session/sess-root-1')

    const b = await call('GET', '/dsh-memory-archive/api/agent/backups?presetId=roleplay')
    check('HTTP 备份列表：200 + ok:true + 倒序非空', b.status === 200 && b.json.ok === true && b.json.backups.length >= 3 && b.json.backups[0].mtimeMs >= b.json.backups[b.json.backups.length - 1].mtimeMs)

    const nb = await call('GET', '/dsh-memory-archive/api/agent/backups')
    check('HTTP 备份列表缺参：200 + ok:false BAD_REQUEST', nb.status === 200 && nb.json.ok === false && nb.json.error.code === 'BAD_REQUEST')

    const wlDir = makePreset('unknown-rp', COMPOSITION) // 存在但没登记（无绑定）⇒ 白名单外
    const w2 = await call('POST', '/dsh-memory-archive/api/agent/apply', { presetId: 'unknown-rp', dryRun: false })
    check('HTTP 白名单外：200 + ok:false + 可读原因', w2.status === 200 && w2.json.ok === false && String(w2.json.error.message).includes('白名单'), w2.text.slice(0, 200))

    const bad = await call('POST', '/dsh-memory-archive/api/agent/apply', undefined)
    check('HTTP 空体：200 + ok:false（BAD_JSON/BAD_REQUEST，绝不 500）', bad.status === 200 && bad.json.ok === false, `${bad.status} ${bad.text.slice(0, 120)}`)
  } finally {
    server.closeAllConnections?.()
    await Promise.race([new Promise((r) => server.close(r)), new Promise((r) => setTimeout(r, 1500))])
  }
}

// ---- 9) 路径 F 冒烟（不依赖服务 ⇒ 应给可读 SERVICE_MISSING；本机不走到，只验证拒绝面）----
{
  const g = await rp.generatePreset({ service: null, presetsRoot, presetId: 'roleplay-dsh', displayName: '角色扮演（记忆库）' })
  check('路径 F：agentPresets 服务缺失 ⇒ 可读拒绝（不写任何东西）', g.ok === false && g.code === 'SERVICE_MISSING')
  const g2 = await rp.generatePreset({ service: { copy: async () => {} }, presetsRoot, presetId: 'standard', displayName: 'x' })
  check('路径 F：部署 preset id ⇒ 硬拒', g2.ok === false && g2.code === 'PRESET_READ_ONLY')
}

// ---- 清理 ----
rmSync(baseTmp, { recursive: true, force: true })
check('临时根已删除', !existsSync(baseTmp))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
