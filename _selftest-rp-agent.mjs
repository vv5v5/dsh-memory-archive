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
 *   10)（修复单 v2 补）针对「生成物本身」的断言：真跑路径 F 取出 rp-tool-scope.js ⇒
 *      node --check（子进程退出码 0）/ 导出形状能被 cordis 解析（registry.ts:222-228 口径）/
 *      用 schemas( 不用 list( / 无 ALLOW、deny 构造用 RESERVED_TRANSPORT / 订阅 tools/change +
 *      applying 重入保护 / 喂会抛的假 ctx 不抛 / 行为级：真跑 apply 后 deny 不含 run_code 且含
 *      mcp__chrome__take_screenshot / 反向对照：tools.list( 与 ALLOW 文本被校验器抓到。
 *   12)（补·裁定 A）第二拍行为断言：订阅 tools/change 后 MCP 晚注册 ⇒ 手动触发回调 ⇒
 *      回调不抛、restrict 恰 +1、新 deny 更长且含 mcp__chrome__navigate_page、仍不含 run_code；
 *      第二次 restrict 之前第一次的 dispose 已被调用（先撤后 apply）；restrict 内部同步 emit
 *      tools/change 不引发递归（重入保护）；正向对照：一次触发 ⇒ 回调恰跑一次。
 *   11)（修复单 v2 补）TOCTOU：applyToPreset 与 restoreFromBackup 注入 _fault:'recheck' ⇒
 *      都 ok:false CONCURRENT_MODIFICATION 且零写入（文件逐字节未变 + .dma-backup/ 条数不变）；
 *      dryRun 检测到并发修改时 ok:true 但 recheck.ok=false 且计划如实报告。
 */
import http from 'node:http'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

// ---- 10) v5 修复单 v2 补：针对「生成物本身」的断言 + TOCTOU（写前重核） ----
// ★ 为什么必须有（本项目的核心教训，别删这段注释）：P1a 交付时「全部台子都绿」，但生成器是
// 坏的 —— 因为没有任何一条断言碰过生成出来的那份脚本（本文件此前全文没有 generatePreset /
// schemas / checkToolScopeContract 字样）。不是假阳性，是覆盖空洞 ⇒ 下面把生成物真的取出来、
// 落到临时目录、真的检查它（⛔ 不许只检查「模板字符串里有没有某个词」这种自欺）。
{
  // —— ① 取生成物：临时根上真跑一次路径 F（fake copy 模仿官方 agentPresets.copy）——
  const genId = 'roleplay-dsh'
  const genDir = join(presetsRoot, genId)
  const fakeCopy = async () => {
    mkdirSync(genDir, { recursive: true })
    writeFileSync(join(genDir, 'agent.cordis.yml'), COMPOSITION, 'utf8')
    writeFileSync(join(genDir, 'preset.yml'), 'name: 角色扮演（记忆库）\n', 'utf8')
  }
  const gen = await rp.generatePreset({ service: { copy: fakeCopy }, presetsRoot, presetId: genId, displayName: '角色扮演（记忆库）' })
  const scopePath = join(genDir, 'rp-tool-scope.js')
  check('① 路径 F 生成 ok 且 rp-tool-scope.js 已落盘（生成物真的取出来了）', gen.ok === true && existsSync(scopePath), JSON.stringify(gen).slice(0, 200))
  const scopeText = readFileSync(scopePath, 'utf8')

  // —— ② node --check 生成物：真的子进程，断言退出码 0，stderr 带进失败详情 ——
  const { spawnSync } = await import('node:child_process')
  const chk = spawnSync(process.execPath, ['--check', scopePath], { encoding: 'utf8' })
  check('② 生成物 node --check 通过（退出码 0）', chk.status === 0, `status=${chk.status} stderr=${String(chk.stderr || '').slice(0, 300)}`)

  // —— ③ 导出形状能被 cordis 解析 ——
  // 依据（逐字）：vendor/cordis/src/registry.ts:222-228 的 resolve() 只认「函数」或
  // 「带 .apply 函数的对象」（isApplicable 见 :8-10）⇒ activate/deactivate 之类根本挂不上。
  const mod = await import(pathToFileURL(scopePath).href)
  check('③ 导出形状 = 函数或带 .apply 的对象（cordis registry.ts:222-228 口径）',
    typeof mod === 'function' || (mod && typeof mod.apply === 'function'),
    'typeof mod=' + typeof mod + ' typeof mod.apply=' + String(mod && typeof mod.apply))
  const applyFn = typeof mod === 'function' ? mod : mod.apply

  // —— ④ 用 schemas 不用 list。⚠ 只对【生成物文本】断言 —— 校验器 rp-agent.js 里那两处
  //      tools.list( 是故意的违例模式，别把自己坑了。——
  check('④ 生成物枚举用 tools.schemas( 且不含 tools.list(', scopeText.includes('tools.schemas(') && !scopeText.includes('tools.list('))

  // —— ⑤ 白名单真的退役：无 ALLOW / config.allow；deny 构造用 RESERVED_TRANSPORT ——
  check('⑤ 生成物无 ALLOW / config.allow，deny 构造用 RESERVED_TRANSPORT',
    !scopeText.includes('ALLOW') && !scopeText.includes('config.allow') && /deny\s*=\s*[\s\S]{0,200}RESERVED_TRANSPORT/.test(scopeText))

  // —— ⑥⑦ 订阅 tools/change（兜 mcp 晚注册）+ applying 重入保护（restrict 自身会 emit）——
  check('⑥⑦ 生成物订阅 tools/change 且有 applying 重入保护', scopeText.includes('tools/change') && /\bapplying\b/.test(scopeText))

  // —— ⑧ 喂一个会抛的假 ctx ⇒ 断言不抛（「绝不抛」那条的可执行证据）——
  let threw8 = null
  try {
    applyFn({ tools: { schemas() { throw new Error('boom') } } }, {})
  } catch (e) {
    threw8 = e
  }
  check('⑧ apply({ schemas(){throw boom} }) 不抛', threw8 === null, String(threw8 && threw8.message))

  // —— ⑨ 行为级证据：记账假 ctx 跑真 apply ⇒ deny 不含 run_code、含 mcp__chrome__take_screenshot ——
  // ★ 这条最有价值：证明「遮罩真的会挡掉 chrome」，而不是只看文本。
  const restrictCalls = []
  const behaviorCtx = {
    tools: {
      schemas() {
        return ['run_code', 'anvil_query', 'mcp__chrome__take_screenshot']
      },
      restrict(body) {
        restrictCalls.push(body && body.deny)
      },
    },
  }
  let threw9 = null
  try {
    applyFn(behaviorCtx, {})
  } catch (e) {
    threw9 = e
  }
  const lastDeny = restrictCalls.length ? restrictCalls[restrictCalls.length - 1] : null
  check('⑨ 行为级：真跑 apply 后 deny 不含 run_code 且含 mcp__chrome__take_screenshot',
    threw9 === null && Array.isArray(lastDeny) && !lastDeny.includes('run_code') && lastDeny.includes('mcp__chrome__take_screenshot'),
    `throws=${String((threw9 && threw9.message) || 'null')} deny=${JSON.stringify(lastDeny)} calls=${JSON.stringify(restrictCalls)}`)
  console.log('   [info] ⑨ deny 实际内容 = ' + JSON.stringify(lastDeny))

  // —— ⑩ 反向对照：故意违例的脚本文本必须被校验器抓到（防「校验器永远返回 ok」——否则它可能压根没检查）——
  const badList = rp.checkToolScopeContract('const t = tools.list()\nexport function apply(ctx, config) {}\n')
  const badAllow = rp.checkToolScopeContract("const ALLOW = ['anima_query']\nexport function apply(ctx, config) {}\n")
  const goodOne = rp.checkToolScopeContract(scopeText)
  check('⑩-1 tools.list( 文本 ⇒ checkToolScopeContract ok:false 且含 USES_TOOLS_LIST',
    badList.ok === false && badList.violations.some((v) => v.code === 'USES_TOOLS_LIST'), JSON.stringify(badList.violations))
  check('⑩-2 ALLOW = [...] 文本 ⇒ ok:false 且含 HAS_ALLOWLIST',
    badAllow.ok === false && badAllow.violations.some((v) => v.code === 'HAS_ALLOWLIST'), JSON.stringify(badAllow.violations))
  check('⑩-3 对照组：生成物本身过校验器（ok:true 零违例）', goodOne.ok === true && goodOne.violations.length === 0, JSON.stringify(goodOne.violations))

  // —— ⑫ 第二拍：tools/change 晚注册 ⇒ 重算（行为级；裁定 A 的落地）。文本里写了「订阅」
  //      不等于回调真的会重算 —— 「订阅了但回调逻辑坏了」只在 MCP 插件晚启动时才发作。
  //      假 ctx 全程记账：schemas() 可变（模拟 MCP 晚注册）、restrict() 记 deny + 返回 disposer
  //      并在内部同步 emit tools/change（官方行为，同时把重入保护一起锁了）。
  {
    // ★ 用「新模块实例」跑本节：生成物是模块级 state（applying/lastKey/liftLast），生产里
    // 每个 preset 目录各一份独立实例；这里若复用 ⑨ 那次 import，⑨ 留下的 lastKey 指纹会把
    // 第一拍误判成「无变化」而跳过（那是 memo 在正确工作，不是 bug）。cache-bust 一次即可。
    const modFresh = await import(pathToFileURL(scopePath).href + '?second-beat')
    const applyFresh = typeof modFresh === 'function' ? modFresh : modFresh.apply
    const changeHandlers = []
    const restrictCalls = [] // { deny, seenDisposes }：seenDisposes = 这次 restrict 时已被调用过的 dispose 数
    let disposeCount = 0
    let handlerFired = 0
    let emitCount = 0
    let emitting = false
    const emitChange = () => {
      if (emitting) return
      emitting = true
      try {
        for (const h of changeHandlers.slice()) {
          emitCount++
          if (emitCount > 50) throw new Error('recursion guard：emit 超 50 次（重入保护失效）')
          h()
        }
      } finally {
        emitting = false
      }
    }
    const beatCtx = {
      tools: {
        names: ['run_code', 'anvil_query', 'mcp__chrome__take_screenshot'],
        schemas() {
          return this.names.slice()
        },
        restrict(body) {
          const deny = (body && body.deny) || []
          restrictCalls.push({ deny, seenDisposes: disposeCount })
          const dispose = () => {
            disposeCount++
          }
          emitChange() // 模拟官方：restrict() 自身会通知 tools/change（同步）
          return dispose
        },
        on(type, fn) {
          // 记账：type==='tools/change' 的 handler 都收着（可能被订阅多次），包一层计数
          if (type === 'tools/change') changeHandlers.push(() => {
            handlerFired++
            fn()
          })
          return () => {}
        },
      },
    }
    // 第一拍：真跑 apply ⇒ 一次订阅、一次 restrict，deny1 不含 run_code
    applyFresh(beatCtx, {})
    const deny1 = restrictCalls[0] && restrictCalls[0].deny
    check('⑫-1 第一拍：恰 1 次订阅、恰 1 次 restrict，deny1 = 全局 − run_code',
      changeHandlers.length === 1 && restrictCalls.length === 1 && Array.isArray(deny1)
      && !deny1.includes('run_code') && deny1.includes('mcp__chrome__take_screenshot'),
      `handlers=${changeHandlers.length} restrictCalls=${restrictCalls.length} deny1=${JSON.stringify(deny1)}`)
    // 第二拍（本单核心）：MCP 晚注册补进 navigate_page ⇒ 手动触发订阅的回调 ⇒ 必须重算
    beatCtx.tools.names.push('mcp__chrome__navigate_page')
    let threwBeat2 = null
    handlerFired = 0 // 只数这次手动触发（含被 applying 挡住的重入调用）
    const restrictBefore = restrictCalls.length
    try {
      for (const h of changeHandlers) h()
    } catch (e) {
      threwBeat2 = e
    }
    const deny2 = restrictCalls[restrictCalls.length - 1] && restrictCalls[restrictCalls.length - 1].deny
    // 正向对照（规格第 6 条）：一次触发 ⇒ 回调确实跑了（handlerFired ≥1）且【生效的重算恰一次】
    //（restrict 恰 +1 —— restrict 内部同步 emit 引起的额外 handler 调用全被 applying 挡住，不再产生 restrict）
    check('⑫-2 第二拍：回调不抛、回调确实被收集并运行、生效重算恰一次（restrict 恰 +1）',
      threwBeat2 === null && handlerFired >= 1 && restrictCalls.length === restrictBefore + 1,
      `throws=${String((threwBeat2 && threwBeat2.message) || 'null')} handlerFired=${handlerFired} restrictCalls=${restrictCalls.length}（前 ${restrictBefore}）`)
    check('⑫-3 新 deny 比第一次长、含 mcp__chrome__navigate_page、仍不含 run_code',
      Array.isArray(deny2) && deny2.length > deny1.length && deny2.includes('mcp__chrome__navigate_page') && !deny2.includes('run_code'),
      `deny1=${JSON.stringify(deny1)} deny2=${JSON.stringify(deny2)}`)
    console.log('   [info] ⑫ deny 前后 = ' + JSON.stringify(deny1) + ' -> ' + JSON.stringify(deny2))
    // 先撤后 apply：第二次 restrict 之前，第一次的 dispose 已被调用（否则限制按层越堆越多）
    check('⑫-4 先撤上一次：第二次 restrict 时 dispose 恰已被调用 1 次',
      restrictCalls.length === 2 && restrictCalls[1].seenDisposes === 1 && disposeCount === 1,
      `seenDisposes=${JSON.stringify(restrictCalls.map((c) => c.seenDisposes))} disposeCount=${disposeCount}`)
    // 重入保护：restrict 内部同步 emit 的那几次全被 applying 挡住 ⇒ 总次数有限（2 次）而非爆炸
    check('⑫-5 重入保护：emit-inside-restrict 未引发递归（restrict 总数有限、emit 被 applying 挡住）',
      restrictCalls.length === 2 && emitCount <= 50 && emitCount >= 1,
      `restrictCalls=${restrictCalls.length} emitCount=${emitCount}`)
  }

  // —— ⑪ TOCTOU（写前重核）：用现成的 _fault:'recheck' 注入口；两处都要有 + 零写入证据 ——
  //   零写入 = 目标文件逐字节未变 + .dma-backup/ 条数不变（证明重核发生在备份之前，不留半截）。
  const targetFile = join(rpDir, 'agent.cordis.yml')
  const beforeText = readFileSync(targetFile, 'utf8')
  const beforeBackups = readdirSync(backupDir).length
  const r1 = rp.applyToPreset({ presetsRoot, presetId: 'roleplay', trust: 'user', customInstruction: '不该被写进去的值', memoryArchiveRoot: null, _fault: 'recheck' })
  check('TOCTOU：applyToPreset 重核不过 ⇒ ok:false CONCURRENT_MODIFICATION（写前重核）',
    r1.ok === false && r1.code === 'CONCURRENT_MODIFICATION' && String(r1.message).includes('写前重核'), JSON.stringify({ ok: r1.ok, code: r1.code }))
  check('TOCTOU：applyToPreset 零写入（文件逐字节未变 + .dma-backup/ 条数不变）',
    readFileSync(targetFile, 'utf8') === beforeText && readdirSync(backupDir).length === beforeBackups,
    `backups ${beforeBackups} -> ${readdirSync(backupDir).length}`)

  const someBackup = readdirSync(backupDir)[0]
  const r2 = rp.restoreFromBackup({ presetsRoot, presetId: 'roleplay', trust: 'user', backupFile: someBackup, _fault: 'recheck' })
  check('TOCTOU：restoreFromBackup 重核不过 ⇒ ok:false CONCURRENT_MODIFICATION（两处都要有）',
    r2.ok === false && r2.code === 'CONCURRENT_MODIFICATION' && String(r2.message).includes('写前重核'), JSON.stringify({ ok: r2.ok, code: r2.code }))
  check('TOCTOU：restoreFromBackup 零写入（同上两证）',
    readFileSync(targetFile, 'utf8') === beforeText && readdirSync(backupDir).length === beforeBackups,
    `backups ${beforeBackups} -> ${readdirSync(backupDir).length}`)

  const d = rp.applyToPreset({ presetsRoot, presetId: 'roleplay', trust: 'user', customInstruction: INSTRUCTION, memoryArchiveRoot: null, dryRun: true, _fault: 'recheck' })
  check('TOCTOU：dryRun 检测到并发修改 ⇒ ok:true 但 recheck.ok=false 且计划如实报告（§四.5）',
    d.ok === true && d.dryRun === true && d.recheck && d.recheck.ok === false && d.plan.join('\n').includes('并发修改'), JSON.stringify({ recheck: d.recheck }))
  check('TOCTOU：dryRun 依旧零写入',
    readFileSync(targetFile, 'utf8') === beforeText && readdirSync(backupDir).length === beforeBackups)
}

// ---- 清理 ----
rmSync(baseTmp, { recursive: true, force: true })
check('临时根已删除', !existsSync(baseTmp))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
