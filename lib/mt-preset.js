// ---------------------------------------------------------------------------
// mt-preset：「一键生成本插件自带的 RP 预设」（任务书 20260913）。
//
// 它做什么：buildRpPreset() 在内存里拼出一整套预设文件（纯文本，不落盘）；
// provisionRpPreset() 把这套文件按本插件既有的「四步写入纪律」落成一个新 preset 目录；
// removeRpPreset() 把它先备份再整个删掉。配套端点：/agent/provision（GET 计划 / POST 真建 /
// DELETE 备份后删除）。
//
// 铁律一（与机器无关）：agent.cordis.yml 的每一行 name 只许是三类 ——
//   ① `./` 相对路径（文件随预设目录发布 ⇒ DSH 的 classifyRowSpecifier 判 'preset'，
//      解析基准是预设自己的目录，换机器也能用）；
//   ② `cordis:` 内建组（不解析）；
//   ③ 官方 `@deepseek-ai/dsh-*` 裸包名（从宿主 app 包那一层都解析得到，实测四件齐全）。
//   ⛔ 零绝对路径、零第三方插件名（anima-rag / state-bridge / dsh-compaction-rp 都不许出现）。
//   自检台 _selftest-provision.mjs 对这条做硬断言（第 2 条），并用 DSH 自己的 scanRoot()
//   反证（第 7 条：broken === undefined 才算健康）。
//
// 铁律二：preset id 固定 'roleplay-mt' —— 既过本插件白名单（前缀 roleplay + 目录里有
//   dma-binding.json），又不撞用户已有的 roleplay。
//
// 铁律三：绝不覆盖。目标目录已存在 ⇒ PROVISION_EXISTS 拒绝，一个字节都不动。
//
// 单一事实源：注入模块 = rp-agent 的 buildInjectModule()；工具面 = rp-agent 的
//   RP_TOOL_SCOPE_JS；压缩后端 = mt-compaction 的 buildRpCompactionBackend()；绑定字段口径
//   = rp-agent 的 BINDING_SCHEMA_VERSION / MANAGED_BY；归档指令 = index.js 传入的
//   compactionInstruction（面板模板，内置回退 BUILTIN_COMPACTION_ZH）。本文件不另写任何一份。
//
// 确定性：buildRpPreset 同参数连调两次逐字节相同（无时间戳/随机数 —— dma-binding.json 因此
//   不带 updatedAt；既有的 writeBinding 会带，两者都能过 readBinding/白名单，落盘格式兼容）。
// ---------------------------------------------------------------------------

import {
  accessSync, closeSync, constants, cpSync, existsSync, fsyncSync, mkdirSync,
  openSync, readFileSync, renameSync, readdirSync, rmSync, statSync, writeSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { buildRpCompactionBackend, RP_COMPACTION_FILE_NAME } from './mt-compaction.js'
import {
  buildInjectModule, INJECT_FILE_NAME, RP_TOOL_SCOPE_JS, checkToolScopeContract,
  resolvePresetsRoot, BINDING_FILE_NAME, BINDING_SCHEMA_VERSION, MANAGED_BY,
} from './rp-agent.js'

/** 预设 id（铁律二：固定值；既过本插件白名单，又不撞用户已有的 roleplay）。 */
export const MT_PRESET_ID = 'roleplay-mt'

/** 组成文件名（DSH 官方约定，照 agent-presets/src/discovery.ts 的 COMPOSITION_FILE）。 */
const COMPOSITION_FILE_NAME = 'agent.cordis.yml'
const METADATA_FILE_NAME = 'preset.yml'

/** 默认显示名（preset.yml 的 name = 新会话选择器里显示的那个）。 */
const DEFAULT_DISPLAY_NAME = '角色扮演 · dsh-memory-archive'

/** 默认 RP 身份（persona 段 config.text：落 system 最前）。 */
const DEFAULT_PERSONA_TEXT = `你是一场中文长篇角色扮演的叙事者，也是故事世界本身。

你的职责与边界：
- 扮演世界里的一切：场景、时间、天气、路人、对手，全部由你描绘与扮演。
- 玩家的角色只属于玩家：绝不替玩家角色做决定、说话或行动。玩家输入含糊时，先用一两句把场面写实，然后停下来等玩家出手。
- 用中文演出，对白与动作分开写；一次只推进一小步，给玩家留出反应的空间。
- 保持既定事实：人名、地名、数字、物品与已发生的剧情逐字沿用，不擅自改写或遗忘；新增设定必须与旧设定兼容。
- 不跳出故事评价剧情，不提及"设定""预设""提示词""上下文"这类幕后词汇。`

/** 工具结果修剪的默认值（照 DSH 官方 standard 预设的同款数值）。 */
const PRUNER_DEFAULTS = { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }

function fail(code, message, extra) {
  return Object.assign({ ok: false, code, message }, extra || {})
}

/** 块标量（|-）：整段按 indent 缩进；行内制表符与 \r 先清掉（YAML 块标量不许 tab）。 */
function blockScalar(text, indent) {
  const pad = ' '.repeat(indent)
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  return lines
    .map((line) => (line.length === 0 ? '' : pad + line.replace(/\t/g, '    ')))
    .join('\n')
}

function sha256(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

/**
 * 生成一整套预设文件（纯文本，不落盘）。
 * @param {object} opts
 *   compactionInstruction 必填非空 —— 归档指令，调用方（index.js）从面板模板取
 *                         （自定义优先，内置回退 BUILTIN_COMPACTION_ZH），本文件绝不另写一份。
 *   personaText / displayName / memoryArchiveRoot 可选覆盖。
 * @returns {{ ok:true, presetId, displayName, files:[{name,text}], notes:[string] }} 或 fail()
 */
export function buildRpPreset(opts = {}) {
  const o = opts || {}
  const instruction = o.compactionInstruction
  if (typeof instruction !== 'string' || instruction.trim() === '') {
    return fail('BAD_COMPACTION_INSTRUCTION', '缺归档指令（compactionInstruction 必须是非空字符串，单一事实源在调用方）')
  }
  const personaText = typeof o.personaText === 'string' && o.personaText.trim() !== '' ? o.personaText : DEFAULT_PERSONA_TEXT
  const displayName = typeof o.displayName === 'string' && o.displayName.trim() !== '' ? o.displayName.trim() : DEFAULT_DISPLAY_NAME
  const memoryArchiveRoot = typeof o.memoryArchiveRoot === 'string' && o.memoryArchiveRoot !== '' ? o.memoryArchiveRoot : null

  // 六件套（顺序无关，内容即事实）：
  const compactionBackend = buildRpCompactionBackend()   // mt-compaction-rp.js（本插件自带压缩后端）
  const injectModule = buildInjectModule()               // dma-rp-inject.js（规则书 + 核心规则注入）
  const toolScope = RP_TOOL_SCOPE_JS                     // rp-tool-scope.js（工具面收窄）
  const bindingText = JSON.stringify(
    {
      schemaVersion: BINDING_SCHEMA_VERSION,
      presetId: MT_PRESET_ID,
      memoryArchiveRoot,
      managedBy: MANAGED_BY,
    },
    null,
    2,
  ) + '\n'

  // 组成（agent.cordis.yml）—— 顺序很重要：persona 落 system 最前；注入段在身份之后；
  // 压缩组收尾（组内 isolate 与官方 standard 预设同款）。每一行 name 都在铁律一的三类白名单里。
  const composition = [
    '# 由 dsh-memory-archive 插件一键生成的 RP 预设。',
    '# 组成里的 name 只有三类：./ 相对路径（文件随本目录发布，换机器也能用）、',
    '# cordis: 内建组、官方 @deepseek-ai/dsh-* 包名 —— 零绝对路径、零第三方插件名。',
    '',
    '# 身份段：落在 system 最前。',
    "- id: persona",
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    '    text: |-',
    blockScalar(personaText, 6),
    '',
    '# 工具面收窄：deny = 全部全局工具 − run_code（受保护传输层绝不进 deny）。',
    '- id: rp-tool-scope',
    "  name: './rp-tool-scope.js'",
    '',
    '# 规则书（dma:settings，order 60）+ 核心规则（dma:rules，order 9950，system 压轴）的注入段。',
    '# 预设暂未内置规则书文件（dma-rp-pack.md）：段会挂上但内容为空；想加就在',
    '# 「Agent 编辑器 → 生成 / 修复 RP agent → ⑦ 按 pack 更新 agent」贴一份规则书（目标选本预设）。',
    '- id: dma-rp-inject',
    "  name: './dma-rp-inject.js'",
    '  config:',
    "    packFile: './dma-rp-pack.md'",
    '    settingsOrder: 60',
    '    rulesOrder: 9950',
    '    settingsEnabled: true',
    '    rulesEnabled: true',
    '    thinkMode: analysis',
    '',
    '# 压缩组：本插件自带的中文 RP 压缩后端（随目录落地，与机器无关）+ 官方 /compact 命令',
    '# + 工具结果修剪。compaction-basic 读 toolResultPrune 走 ctx.get，所以修剪器必须同组。',
    '- id: compaction',
    '  name: cordis:group',
    '  group: true',
    '  isolate:',
    '    compaction: true',
    '    toolResultPruner: true',
    '  config:',
    '    - id: compaction-rp',
    "      name: './mt-compaction-rp.js'",
    '      config:',
    '        customInstruction: |-',
    blockScalar(instruction, 10),
    '    - id: command-compact',
    "      name: '@deepseek-ai/dsh-command-compact'",
    '    - id: tool-result-pruner',
    "      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
    '      config:',
    '        thresholdChars: ' + String(PRUNER_DEFAULTS.thresholdChars),
    '        headChars: ' + String(PRUNER_DEFAULTS.headChars),
    '        tailChars: ' + String(PRUNER_DEFAULTS.tailChars),
    '',
  ].join('\n')

  // 显示元数据（照 DSH renderPresetMetadata 口径：只有 name / description 两个键，缺省不写空键）。
  const metadata = [
    'name: ' + displayName,
    'description: dsh-memory-archive 插件一键生成的中文角色扮演预设：自带身份、工具收窄、规则注入与本插件的中文归档压缩后端，文件随目录发布、换机器也能用。',
    '',
  ].join('\n')

  const files = [
    { name: COMPOSITION_FILE_NAME, text: composition },
    { name: METADATA_FILE_NAME, text: metadata },
    { name: RP_COMPACTION_FILE_NAME, text: compactionBackend },
    { name: INJECT_FILE_NAME, text: injectModule },
    { name: 'rp-tool-scope.js', text: toolScope },
    { name: BINDING_FILE_NAME, text: bindingText },
  ]

  // 给界面看的如实说明（⛔ 不许说"全自动配好一切"）。
  const notes = [
    '不含记忆检索（anima）与状态机（state-bridge）—— 那些是独立插件，另装后自己往这个预设里加行',
    '压缩后端是本插件自带的，已随预设目录落地，换机器也能用',
    '还没放规则书（pack）：注入段已挂上但没有内容；想要就在「按 pack 更新 agent」贴一份（目标选本预设）',
  ]

  return { ok: true, presetId: MT_PRESET_ID, displayName, files, notes }
}

/** 目录可写探测（只读判断：能 stat + access W_OK 就当可写；Windows 上 access 不完全可靠，如实标注口径）。 */
function rootWritable(root) {
  const probe = existsSync(root) ? root : dirname(root)
  try {
    accessSync(probe, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** 生成计划（GET /agent/provision 与 dryRun 共用；零写入）。 */
export function provisionPlan(opts = {}) {
  const o = opts || {}
  if (typeof o.presetsRoot !== 'string' || o.presetsRoot === '') {
    return fail('BAD_PRESETS_ROOT', '缺 presetsRoot（写入根，由 resolvePresetsRoot 解析）')
  }
  const preset = o.preset && o.preset.ok ? o.preset : buildRpPreset(o)
  if (!preset.ok) return preset
  const root = resolve(o.presetsRoot)
  const dir = join(root, preset.presetId)
  let exists = false
  try {
    exists = statSync(dir).isDirectory()
  } catch {}
  return {
    ok: true,
    presetId: preset.presetId,
    displayName: preset.displayName,
    presetsRoot: root,
    presetDir: dir,
    exists,
    rootExists: existsSync(root),
    rootWritable: rootWritable(root),
    files: preset.files.map((f) => ({ name: f.name, bytes: Buffer.byteLength(f.text, 'utf8'), sha256: sha256(f.text) })),
    notes: preset.notes,
  }
}

/** 原子写一个文件（tmp → 全量 → fsync → rename），随后逐字节回读校验由调用方做。 */
function atomicWrite(file, text) {
  const tmp = file + '.tmp-' + process.pid
  const buf = Buffer.from(text, 'utf8')
  const fh = openSync(tmp, 'w')
  try {
    let off = 0
    while (off < buf.length) off += writeSync(fh, buf, off, buf.length - off)
    fsyncSync(fh)
  } finally {
    closeSync(fh)
  }
  renameSync(tmp, file)
}

/** 递归快照：相对路径 → sha256（落盘前后比对、删除前备份比对都用它）。 */
function treeSha(dir, prefix = '') {
  const out = {}
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const ent of entries) {
    const rel = prefix === '' ? ent.name : prefix + '/' + ent.name
    const full = join(dir, ent.name)
    if (ent.isDirectory()) Object.assign(out, treeSha(full, rel))
    else {
      try {
        out[rel] = createHash('sha256').update(readFileSync(full)).digest('hex')
      } catch {}
    }
  }
  return out
}

/**
 * 真落盘：四步写入纪律 —— 先算后写 → 写前重核（TOCTOU：mkdir 前再 stat 一次）→
 * tmp + rename 原子写 → 逐字节回读校验；任何一步不一致 ⇒ 自动回滚 = 把本次新建的整个
 * 目录删掉（新目录里没有别人的东西，整体删除就是干净的回滚）。
 * @param {object} opts presetsRoot / preset（buildRpPreset 产物，缺省现场现算）/ dryRun
 * @returns 计划（dryRun）或 { ok, presetId, presetDir, files:[{name,bytes,sha256}] }
 */
export function provisionRpPreset(opts = {}) {
  const o = opts || {}
  if (typeof o.presetsRoot !== 'string' || o.presetsRoot === '') {
    return fail('BAD_PRESETS_ROOT', '缺 presetsRoot（写入根）')
  }
  const preset = o.preset && o.preset.ok ? o.preset : buildRpPreset(o)
  if (!preset.ok) return preset
  const dryRun = o.dryRun === true
  const root = resolve(o.presetsRoot)
  const dir = join(root, preset.presetId)

  // ---- 写入前置自检（写盘之前）：工具面契约照 generatePreset 同款，错误级 ----
  const contract = checkToolScopeContract(RP_TOOL_SCOPE_JS, { generated: true })
  if (!contract.ok) {
    return fail(
      'TOOL_SCOPE_CONTRACT',
      '生成物的工具面脚本没过契约自检（未写盘）：'
        + contract.violations.map((v) => v.code + '（' + v.detail + '）').join('；'),
      { violations: contract.violations },
    )
  }
  // 铁律三的第一次检查 + dryRun 出口（此刻零写入）
  if (statDir(dir)) {
    return fail('PROVISION_EXISTS', '目标目录已存在，拒绝覆盖（一个字节都没动）：' + dir, { presetDir: dir })
  }
  const plan = provisionPlan({ presetsRoot: root, preset })
  if (!plan.ok) return plan
  if (dryRun) {
    return Object.assign({}, plan, { dryRun: true, note: 'dryRun：以上是计划，一个字节都没写。' })
  }

  // ---- 真写 ----
  try {
    mkdirSync(root, { recursive: true })
  } catch (e) {
    return fail('ROOT_UNWRITABLE', '预设根目录建不出来（' + root + '）：' + String((e && e.message) || e))
  }
  // 写前重核（TOCTOU）：mkdir 前一刻目标仍不许存在
  if (statDir(dir)) {
    return fail('PROVISION_EXISTS', '目标目录在写入前一刻出现了（别的进程先建了？），拒绝覆盖：' + dir, { presetDir: dir })
  }
  try {
    mkdirSync(dir)
  } catch (e) {
    return fail('PROVISION_MKDIR_FAILED', '建预设目录失败：' + String((e && e.message) || e))
  }
  const written = []
  for (const f of preset.files) {
    const target = join(dir, f.name)
    try {
      atomicWrite(target, f.text)
    } catch (e) {
      return rollbackNewDir(dir, 'PROVISION_WRITE_FAILED', '写 ' + f.name + ' 失败：' + String((e && e.message) || e))
    }
    // 逐字节回读校验
    let back = null
    try {
      back = readFileSync(target)
    } catch {}
    if (!back || Buffer.compare(back, Buffer.from(f.text, 'utf8')) !== 0) {
      return rollbackNewDir(dir, 'PROVISION_VERIFY_FAILED', f.name + ' 回读校验不过（写进去的与读出来的不一致）')
    }
    written.push({ name: f.name, bytes: Buffer.byteLength(f.text, 'utf8'), sha256: sha256(f.text) })
  }
  // 终检：六个文件都在（多一个少一个都不行）
  const onDisk = treeSha(dir)
  if (Object.keys(onDisk).length !== preset.files.length) {
    return rollbackNewDir(dir, 'PROVISION_VERIFY_FAILED', '落盘后文件数不对（期望 ' + preset.files.length + '，实际 ' + Object.keys(onDisk).length + '）')
  }
  return {
    ok: true,
    dryRun: false,
    presetId: preset.presetId,
    presetDir: dir,
    displayName: preset.displayName,
    files: written,
    notes: preset.notes,
    rolledBack: false,
    errors: [],
  }
}

function statDir(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** 新建目录的自动回滚 = 整目录删除（里面只有我们刚写的文件）。删除本身失败要如实报。 */
function rollbackNewDir(dir, code, message) {
  let removed = false
  let removeError = null
  try {
    rmSync(dir, { recursive: true, force: true })
    removed = !statDir(dir)
  } catch (e) {
    removeError = String((e && e.message) || e)
  }
  return fail(code, message
    + ' —— 已自动回滚（新建目录整体删除'
    + (removed ? '完成' : '失败' + (removeError ? '：' + removeError : ''))
    + '，盘上不留半截状态）', { rolledBack: true, presetDir: dir })
}

/**
 * 删除分支：先整体备份（cpSync 到 <root>/.dma-provision-backup/<stamp>-<id>/ 并逐字节比对）
 * 再删目录。只删"我们自己生成的那套"：目录里必须有本插件的 dma-binding.json 且 managedBy 对得上，
 * 否则拒绝（PROVISION_NOT_OURS）—— 别人的 preset 一个字节都不许动。
 */
export function removeRpPreset(opts = {}) {
  const o = opts || {}
  if (typeof o.presetsRoot !== 'string' || o.presetsRoot === '') {
    return fail('BAD_PRESETS_ROOT', '缺 presetsRoot')
  }
  const presetId = typeof o.presetId === 'string' ? o.presetId.trim() : MT_PRESET_ID
  if (!/^[a-z0-9][a-z0-9-]*$/.test(presetId)) return fail('BAD_PRESET_ID', 'presetId 形状不对：' + JSON.stringify(presetId))
  const root = resolve(o.presetsRoot)
  const dir = join(root, presetId)
  if (!statDir(dir)) {
    return fail('PROVISION_NOT_FOUND', '要删的预设目录不存在：' + dir)
  }
  // 只删自己的：绑定文件必须存在且 managedBy 是本插件
  let binding = null
  try {
    binding = JSON.parse(readFileSync(join(dir, BINDING_FILE_NAME), 'utf8'))
  } catch {}
  if (!binding || binding.managedBy !== MANAGED_BY) {
    return fail('PROVISION_NOT_OURS', '「' + presetId + '」目录里没有本插件的 dma-binding.json（或 managedBy 不对）——不是这套生成的，拒绝删除')
  }
  const beforeSha = treeSha(dir)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = join(root, '.dma-provision-backup', stamp + '-' + presetId)
  if (o.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      presetId,
      presetDir: dir,
      backupDir,
      files: Object.keys(beforeSha).sort().map((name) => ({ name })),
      note: 'dryRun：以上是删除计划（先备份到 ' + backupDir + ' 再删目录），一个字节都没写。',
    }
  }
  // 备份：整目录拷贝 + 逐字节比对，比对不过就不删
  try {
    mkdirSync(dirname(backupDir), { recursive: true })
    cpSync(dir, backupDir, { recursive: true })
  } catch (e) {
    return fail('PROVISION_BACKUP_FAILED', '备份失败（未删除）：' + String((e && e.message) || e))
  }
  const backupSha = treeSha(backupDir)
  const mismatch = Object.keys(beforeSha).filter((k) => backupSha[k] !== beforeSha[k])
  if (mismatch.length > 0) {
    return fail('PROVISION_BACKUP_FAILED', '备份内容比对不过（' + mismatch.join('、') + '）—— 未删除，原目录原样保留')
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (e) {
    return fail('PROVISION_REMOVE_FAILED', '删除失败（备份在 ' + backupDir + '，可手动恢复）：' + String((e && e.message) || e))
  }
  if (statDir(dir)) {
    return fail('PROVISION_REMOVE_FAILED', '删除后目录仍在（' + dir + '）—— 如实报错')
  }
  return {
    ok: true,
    dryRun: false,
    presetId,
    presetDir: dir,
    removed: true,
    backup: { dir: backupDir, files: Object.keys(beforeSha).sort() },
    note: '已先备份后删除；要恢复就把备份目录原样拷回原位。',
  }
}

// 写入根的解析与 rp-agent 同源（env 可注入），这里再导出一份给 index.js 用。
export { resolvePresetsRoot }
