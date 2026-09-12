/**
 * _selftest-rp-inject.mjs —— v5 P1b-2a 自检：注入模块生成物 + pack 落地（挂载行 + persona）。
 * ★ 全程 mkdtemp 临时根 + 假的 agent.cordis.yml（带注释 / persona 段 / 嵌套挂载行）；
 *   ⛔ 不碰真机 ~/.dsh；不把 presetsRoot 指向任何真机/Junction 目录。测完即删。
 *
 * 断言清单（任务书 §六 逐条）：
 *   1) 生成物 dma-rp-inject.js：node --check（子进程退出码 0）+ 导出形状能被 cordis 解析
 *      （registry.ts:222-228 口径：typeof mod === 'function' || typeof mod.apply === 'function'）
 *   2) 记账假 ctx：注册 dma:settings(60) 与 dma:rules(9950)，段文本与 pack 里逐字相等
 *   3) 喂会抛的假 ctx ⇒ apply 不抛
 *   4) 加一行不冲掉别人的行：原行与注释逐行还在、只新增、persona.text 被替换、complete 未被设
 *   5) 回读校验：能从写后的文本按 YAML 语义读回挂载行与 persona
 *   6) _fault 注入回读不一致 ⇒ 自动回滚、文件回原样、新建的两个文件被清掉（零残留）
 *   7) 开关生效：settingsEnabled:false ⇒ 不注册 dma:settings；rulesOrder 改值 ⇒ order 跟着变
 *   8) 幂等：二次 apply 不重复挂载，只更新开关值
 *   附：dryRun 零写入 + persona 改前/改后；HTTP POST /agent/pack/apply（dryRun/真写/坏 pack 一律 200）。
 */
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

// ---- 0) 隔离（必须在 import lib/index.js 之前设 DSH_HOME）----
const baseTmp = mkdtempSync(join(repo, '_rp-inject-selftest-'))
const home = join(baseTmp, 'home')
const presetsRoot = join(home, '.agent-presets')
process.env.DSH_HOME = home
check('隔离：临时根在仓库内、不在家目录', resolve(baseTmp).startsWith(resolve(repo)) && !resolve(baseTmp).startsWith(resolve(homedir())))

const rp = await import('./lib/rp-agent.js')

// ---- 1) 假 agent.cordis.yml：带注释 + persona（两行式）+ 嵌套挂载行 + 尾注释 ----
const COMPOSITION = [
  '# ============================================================',
  '# roleplay —— 角色扮演 preset（P1b-2a 自检用；注释必须逐行保全）',
  '# ============================================================',
  'cordis:assembly:',
  '  version: 1',
  '  sections:',
  '    - cordis:group',
  '      id: persona',
  '      # —— 旧 persona（将被 IDENTITY 替换的那段）——',
  '      config:',
  '        - id: persona-kp',
  '          text: |',
  '            你是本次跑团的 KP（游戏主持人），负责推进剧情与裁定。',
  '            保持悬疑、神秘的氛围，文风现代。',
  '    - cordis:group',
  '      id: rp',
  '      config:',
  '        # 工具面收窄（preset scope）',
  '        - id: rp-tool-scope',
  '          mount: rp-tool-scope',
  '    - cordis:group',
  '      id: compaction',
  '      config:',
  '        - id: compaction-rp',
  '          name: compaction-basic',
  '          config:',
  '            thresholdRatio: 0.75',
  '  # 尾注释：也应该原样保全',
  '',
].join('\n')
const ORIGINAL = COMPOSITION

const SETTINGS_BODY = [
  '',
  '世界：近未来都市，无电子信息技术。',
  '',
  '  核心数值：',
  '    躯体 —— 等同生命；密氛 —— 越高越危险。',
  '',
].join('\n')
const POST_BODY = '无论发生什么，出戏的边界不可越过；数值单列。'
const IDENTITY = '你是一位沉稳的跑团主持人（KP），带玩家走进设定。'
const PACK = [
  'RP-AGENT-PACK v1',
  '',
  '## META',
  'name: 测试角色',
  'sourceCard: card-test-0001.json',
  'identity: ' + IDENTITY,
  'thinkMode: analysis',
  'readFields: data.systemPrompt(6732)',
  'missing: personality(0)',
  'decisions: NONE',
  'cardHash: 0123456789abcdef',
  '',
  '## SETTINGS',
  SETTINGS_BODY,
  '## TONE',
  'KEEP',
  '',
  '## OPENING',
  '（开门。雨声。）你来晚了。',
  '',
  '## POST',
  POST_BODY,
  '',
  '## CONFLICTS',
  'NONE',
  '',
].join('\n')
const SETTINGS_VERBATIM = SETTINGS_BODY.replace(/^\n/, '').replace(/\s+$/, '')
const POST_VERBATIM = POST_BODY

// 造 preset（白名单：roleplay）
const presetDir = join(presetsRoot, 'roleplay')
mkdirSync(presetDir, { recursive: true })
writeFileSync(join(presetDir, 'agent.cordis.yml'), ORIGINAL, 'utf8')
writeFileSync(join(presetDir, 'preset.yml'), 'name: 角色扮演\n', 'utf8')

// ---- 2) dryRun：零写入 + persona 改前/改后 ----
{
  const before = readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8')
  const r = rp.applyPackToPreset({ presetsRoot, presetId: 'roleplay', trust: 'user', packText: PACK, dryRun: true })
  check('dryRun ok:true + 计划 + persona 改前/改后', r.ok === true && r.dryRun === true && Array.isArray(r.plan)
    && r.persona && r.persona.written === true && r.persona.before.includes('你是本次跑团的 KP')
    && r.persona.after === IDENTITY, JSON.stringify(r).slice(0, 300))
  check('dryRun 零写入（组合文件未动；两个新文件未出现）',
    readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8') === before
    && !existsSync(join(presetDir, 'dma-rp-inject.js')) && !existsSync(join(presetDir, 'dma-rp-pack.md')))
}

// ---- 3) 真写：三处落盘 + 不冲掉别人的行 + persona 替换 + complete 未设 ----
{
  const r = rp.applyPackToPreset({ presetsRoot, presetId: 'roleplay', trust: 'user', packText: PACK })
  check('真写 ok:true（注入模块 + pack 留档 + 挂载 + persona）', r.ok === true && r.mount === 'created', JSON.stringify(r).slice(0, 240))
  const after = readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8')

  const origLines = ORIGINAL.split('\n')
  const afterLines = after.split('\n')
  // persona 的旧正文两行会被 IDENTITY 替换（§二 的既定动作），其余每一行都必须原样还在
  const replacedOld = origLines.filter((l) => l.includes('你是本次跑团的 KP') || l.includes('保持悬疑、神秘的氛围'))
  const mustRemain = origLines.filter((l) => !replacedOld.includes(l))
  check('④-① 原有的行与注释逐行还在（persona 旧正文按 §二 被替换，其余全在）',
    mustRemain.every((l) => afterLines.includes(l)))
  const added = afterLines.filter((l) => !origLines.includes(l))
  const mountTrimmed = ['- id: dma-rp-inject', "name: './dma-rp-inject.js'", 'packFile: "./dma-rp-pack.md"', 'settingsOrder: 60', 'rulesOrder: 9950', 'settingsEnabled: true', 'rulesEnabled: true', 'thinkMode: analysis']
  check('④-② 只新增了我们自己的行：persona 新正文 1 行 + 挂载块 8 行（config: 行与原文件第 9 行同文，不重复计入）',
    added.length === 9 && added.includes('            ' + IDENTITY)
      && mountTrimmed.every((t) => added.some((l) => l.trim() === t)),
    JSON.stringify(added))
  check('④-③ persona 的 text 被替换为 IDENTITY 且 complete 未被设',
    after.includes(IDENTITY) && !after.includes('你是本次跑团的 KP') && !/complete\s*:\s*true/.test(after))
  check('④-④ 挂载块落在最外层列表（缩进 4），不是嵌套 config 里',
    after.includes("    - id: dma-rp-inject") && !after.includes('            - id: dma-rp-inject'))

  // 回读（YAML 语义 = 逐行结构）：挂载行 + persona 可解析
  check('⑤ 回读：能按结构读回挂载行与 persona 新文本',
    afterLines.some((l) => l.trim() === '- id: dma-rp-inject')
      && afterLines.some((l) => l.trim() === "name: './dma-rp-inject.js'")
      && after.includes('          text: |')
      && after.includes('            ' + IDENTITY))

  // pack 留档逐字
  check('③ pack 原文逐字落盘（dma-rp-pack.md === packText）',
    readFileSync(join(presetDir, 'dma-rp-pack.md'), 'utf8') === PACK)

  // ---- 生成物断言 ----
  const injectPath = join(presetDir, 'dma-rp-inject.js')
  const chk = spawnSync(process.execPath, ['--check', injectPath], { encoding: 'utf8' })
  check('① node --check 生成物（退出码 0）', chk.status === 0, `status=${chk.status} stderr=${String(chk.stderr || '').slice(0, 200)}`)
  // 导出形状能被 cordis 解析（registry.ts:222-228：resolve() 只认函数或带 .apply 的对象；isApplicable:8-10）
  const mod = await import(pathToFileURL(injectPath).href)
  check('① 导出形状 = 函数或带 .apply 的对象（cordis 口径）', typeof mod === 'function' || (mod && typeof mod.apply === 'function'))

  // ---- 记账假 ctx：段名 / order / 文本逐字 ----
  const registered = []
  const makeRecordingCtx = (schemaImpl) => ({
    systemPrompt: {
      section(s) {
        registered.push({ name: s.name, order: s.order, text: s.text })
        return () => {}
      },
      ...(schemaImpl ? { schemas: schemaImpl } : {}),
    },
  })
  registered.length = 0
  mod.apply(makeRecordingCtx(), { packFile: './dma-rp-pack.md' })
  const settings = registered.find((s) => s.name === 'dma:settings')
  const rules = registered.find((s) => s.name === 'dma:rules')
  check('② 记账假 ctx：注册 dma:settings(60) + dma:rules(9950)，文本与 pack 逐字相等',
    registered.length === 2 && settings && settings.order === 60 && settings.text === SETTINGS_VERBATIM
      && rules && rules.order === 9950 && rules.text === POST_VERBATIM,
    JSON.stringify(registered.map((s) => ({ name: s.name, order: s.order, len: (s.text || '').length }))))

  // ---- 绝不抛 ----
  let threw = null
  try {
    mod.apply({ systemPrompt: { section() { throw new Error('boom') } }, log: { warn: () => {} } }, { settingsText: 'S', rulesText: 'R' })
  } catch (e) {
    threw = e
  }
  check('③ 喂会抛的假 ctx ⇒ apply 不抛（绝不抛）', threw === null, String(threw && threw.message))

  // ---- 开关生效 ----
  registered.length = 0
  mod.apply(makeRecordingCtx(), { settingsText: 'S', rulesText: 'R', settingsEnabled: false, rulesOrder: 9000 })
  check('⑦ 开关生效：settingsEnabled:false ⇒ 不注册 dma:settings；rulesOrder:9000 ⇒ order 跟着变',
    registered.length === 1 && registered[0].name === 'dma:rules' && registered[0].order === 9000,
    JSON.stringify(registered))
}

// ---- 4) 幂等：二次 apply 不重复挂载，只更新开关值 ----
{
  const beforeMount = (readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8').match(/- id: dma-rp-inject/g) || []).length
  const r2 = rp.applyPackToPreset({ presetsRoot, presetId: 'roleplay', trust: 'user', packText: PACK, switches: { rulesEnabled: false } })
  const after = readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8')
  const afterMount = (after.match(/- id: dma-rp-inject/g) || []).length
  check('⑧ 幂等：二次 apply 挂载行不重复（仍 1 处），mount=updated', r2.ok === true && r2.mount === 'updated' && beforeMount === 1 && afterMount === 1)
  check('⑧ 幂等：开关值按本次更新（rulesEnabled: false 进了挂载块）', after.includes('rulesEnabled: false'))
}

// ---- 5) 回滚：_fault 注入回读不一致 ⇒ 自动回滚 + 零残留 ----
{
  const before = readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8')
  const backupsBefore = existsSync(join(presetDir, '.dma-backup')) ? readdirSync(join(presetDir, '.dma-backup')).length : 0
  const rf = rp.applyPackToPreset({ presetsRoot, presetId: 'roleplay', trust: 'user', packText: PACK, switches: { settingsOrder: 77 }, _fault: 'verify' })
  check('⑥ fault 注入 ⇒ ok:false VERIFY_FAILED + rolledBack:true', rf.ok === false && rf.code === 'VERIFY_FAILED' && rf.rolledBack === true, JSON.stringify({ ok: rf.ok, code: rf.code }))
  check('⑥ 组合文件回到原样（逐字节）', readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8') === before)
  check('⑥ 零残留：本次新建的两个文件已被清掉（之前那对仍在）',
    existsSync(join(presetDir, 'dma-rp-inject.js')) === true // 第一次真写创建的仍在
      && readFileSync(join(presetDir, 'dma-rp-pack.md'), 'utf8') === PACK
      && (readdirSync(join(presetDir, '.dma-backup')).length >= backupsBefore))
}

// ---- 6) 拒绝面：CONFLICTS / 坏 pack / 无 identity ----
{
  const conflictsPack = PACK.replace('## CONFLICTS\nNONE', '## CONFLICTS\n开场要不要换？（问题/建议/影响）')
  const rC = rp.applyPackToPreset({ presetsRoot, presetId: 'roleplay', trust: 'user', packText: conflictsPack })
  check('拒绝面：CONFLICTS 非 NONE ⇒ PACK_HAS_CONFLICTS（不写盘）', rC.ok === false && rC.code === 'PACK_HAS_CONFLICTS')
  const rBad = rp.applyPackToPreset({ presetsRoot, presetId: 'roleplay', trust: 'user', packText: 'not a pack' })
  check('拒绝面：坏 pack ⇒ PACK_INVALID', rBad.ok === false && rBad.code === 'PACK_INVALID')
  const noIdentity = PACK.split('\n').filter((l) => !l.startsWith('identity:')).join('\n')
  const rNI = rp.applyPackToPreset({ presetsRoot, presetId: 'roleplay', trust: 'user', packText: noIdentity, dryRun: true })
  check('拒绝面：pack 无 identity ⇒ persona 不写（written:false，如实报告）', rNI.ok === true && rNI.persona.written === false && rNI.persona.written === false)
}

// ---- 7) HTTP 集成：POST /agent/pack/apply 一律 200、错误放 body ----
{
  mkdirSync(join(home, 'dsh-memory-archive'), { recursive: true })
  writeFileSync(join(home, 'dsh-memory-archive', 'config.json'), JSON.stringify({ schemaVersion: 1, rootMode: 'session', root: { sessionId: 's1' }, api: { url: '', model: '', key: '' }, prompts: { compaction: null, placeholder: null } }), 'utf8')
  const { apply } = await import('./lib/index.js')
  const routes = []
  const fakeCtx = {
    get: (name) => (name === 'webServer' ? { register: (r) => (routes.push(r), () => {}) } : undefined),
    inject: (_deps, cb) => cb({ webServer: { register: (r) => (routes.push(r), () => {}) }, effect: (fn) => fn() }),
    effect: (fn) => fn(),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  apply(fakeCtx)
  check('HTTP：apply 后恰好 2 条 prefix 路由', routes.length === 2, String(routes.length))
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
    const d = await call('POST', '/dsh-memory-archive/api/agent/pack/apply', { presetId: 'roleplay', packText: PACK, dryRun: true })
    check('HTTP dryRun：200 + ok:true + plan + persona', d.status === 200 && d.json.ok === true && Array.isArray(d.json.plan) && d.json.persona.written === true)
    const bad = await call('POST', '/dsh-memory-archive/api/agent/pack/apply', { presetId: 'roleplay', packText: 'junk' })
    check('HTTP 坏 pack：200 + ok:false PACK_INVALID', bad.status === 200 && bad.json.ok === false && bad.json.error.code === 'PACK_INVALID')
    const empty = await call('POST', '/dsh-memory-archive/api/agent/pack/apply', { presetId: 'roleplay' })
    check('HTTP 缺 packText：200 + ok:false BAD_REQUEST', empty.status === 200 && empty.json.ok === false && empty.json.error.code === 'BAD_REQUEST')
    const get = await call('GET', '/dsh-memory-archive/api/agent/pack/apply')
    check('HTTP GET ⇒ 405（ENDPOINTS 口径）', get.status === 405)
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
