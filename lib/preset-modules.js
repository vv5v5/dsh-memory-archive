/**
 * preset-modules.js —— 包内收编的两个 preset 级模块（story-anchor.js / rp-tool-scope.js）
 * 的「生成器写面」：把包内逐字节副本幂等写进指定预设目录（独立模块，零 npm 依赖，
 * 不 import 本插件的其它 lib —— 变体自检要把本文件拷去临时目录单跑）。
 *
 * 背景：这两个模块原先只活在 ~/.dsh/.agent-presets/roleplay/，无版本、无备份；
 * 现已逐字节收编进 <包根>/preset-modules/（package.json files 已带上，随包发版）。
 * 本文件只负责「安全落盘」；要不要把它接进 provision/服务端点，是调用方的后续决定。
 * 自检台：_selftest-preset-modules.mjs（全程临时目录，不碰真预设）。
 *
 * 纪律照抄 rp-agent.js（四步写入，一个不省）：
 *   ① 写前 sha256 比对：包内副本与盘上现有内容相同 ⇒ 跳过（不动字节、不动 mtime、
 *      不产备份）—— 这就是幂等的全部；
 *   ② 不同 ⇒ 先备份 <presetDir>/.dma-backup/<名>.<时间戳>（与 rp-agent 的 BACKUP_DIR_NAME
 *      同一个目录，避免两套备份位；只备份要改的那几个文件）；
 *   ③ 原子写（tmp-<pid> → 全量 → fsync → rename；⛔ 不许直接 writeFile 盖原文件）；
 *   ④ 写后回读逐字节比对（Buffer.compare，不是字符串比对 —— BOM/编码差异逃不掉）；
 *   ⑤ 任何一步不符 ⇒ 报冲突并【停下】：后续文件一个都不写，已写的用备份原样盖回
 *     （原来就没有的文件删掉），绝不留半截状态；
 *   ⑥ 换代触发（选项A，20260915 拍板）：真的写了文件（changed >= 1）才 touch 组成文件
 *      （agent.cordis.yml，compositionFile 可配，仅认纯文件名）—— 读原 buffer 原样写回
 *      （tmp → fsync → rename；⛔ 不重新序列化、不动注释/换行），写前写后 sha256 必须相等
 *      且 mtime 必须变化，任一不满足 ⇒ 报冲突停下，⛔ 不重试、不猜；全部 skip ⇒ 一个字节
 *      都不动（连 touch 都不许——白 touch = 白漏一代 mount + 一份 watcher，官方语义被替代
 *      的世代永不回收）；组成文件不存在 ⇒ 不崩、touched:false + warning，⛔ 绝不顺手创建。
 *      ★ 时效如实标注（GENERATION_NOTE）：换代码只在**新会话**生效；已在跑的会话留在旧代。
 *        「换代码是否真被下一代会话重挂（ESM 缓存是否 cache-bust）」本轮未在真机验证。
 *
 * ⛔ 预设目录路径由调用方传入（参数或既有 resolvePresetsRoot 的产物），本文件不解析、
 *   不写死任何家目录绝对路径；目标目录不存在 ⇒ PRESET_DIR_NOT_FOUND 拒绝
 *   （建预设目录是 provisionRpPreset 的职责，本写面不越界）。
 *
 * @license CC-BY-NC-4.0 (Attribution-NonCommercial 4.0 International)
 * 仅限个人学习与非商业用途；含 DeepSeek Harness 派生部分（MIT）时该部分保留 MIT。
 */

import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 包内副本目录名（相对包根；package.json 的 files 必须带上它，否则发版丢文件）。 */
export const PRESET_MODULES_DIR_NAME = 'preset-modules'

/** 收编的两个模块（文件名即落盘名；与 agent.cordis.yml 里的 ./ 相对路径行同名）。 */
export const PRESET_MODULE_NAMES = ['story-anchor.js', 'rp-tool-scope.js']

/**
 * 第三个模块（20260915「保留第一轮问答」单）：落盘走**同一条**写面（sha256 / 幂等 /
 * .dma-backup / 回读比对），但**不进默认清单** —— `_selftest-preset-modules.mjs`（禁改）的
 * ④ 断言 `every(action==='overwrite')` 钉住了默认清单恰好两件 ⇒ 第三件由调用方经
 * `opts.moduleNames` 显式带上（全量清单 = PRESET_MODULE_NAMES_ALL）。
 */
export const KEEP_FIRST_ROUND_MODULE_NAME = 'keep-first-round.js'

/**
 * 第四个模块（2026-09-18，D13 前置）：**记忆检索协议条款的落点**（`memory-protocol.js`）。
 *
 * 它不产出任何文本（条款正文由预设的 `config.text` 提供，默认空）—— 落在预设里只是**占住那个位置**，
 * 让"什么时候该调 anima_query"这句话有个正式的家；条款写没写，由模块自己在启动日志里如实报
 * （空 ⇒ 一条显眼 warn）。与 keep-first-round 一样**不进默认清单**（默认两件被自检钉死），
 * 由调用方经 `opts.moduleNames` 显式带上。
 */
export const MEMORY_PROTOCOL_MODULE_NAME = 'memory-protocol.js'

/** 全量模块清单（含 keep-first-round 与 memory-protocol）：调用方用 `moduleNames: PRESET_MODULE_NAMES_ALL` 选择。 */
export const PRESET_MODULE_NAMES_ALL = Object.freeze([...PRESET_MODULE_NAMES, KEEP_FIRST_ROUND_MODULE_NAME, MEMORY_PROTOCOL_MODULE_NAME])

/**
 * keep-first-round 的**挂载行片段**（纯函数，只产出行文本）。
 * ⛔ 本文件绝不写 ~/.dsh 下的任何文件 —— 这段文本由调用方/面板插进预设的 agent.cordis.yml；
 * 插进去后由 provisionRpPreset/provisionPresetModules 负责把 `./keep-first-round.js` 落到预设目录。
 * 形状与 mt-preset 生成挂载行同款（铁律一：name 只许 ./ 相对路径 / cordis: / 官方包名）。
 * 开关**不在**这一行里 —— 在插件 config（keepFirstRound.enabled），本行只承担挂载（D9-5）。
 *
 * @returns {string} 三行文本（注释 + `- id: keep-first-round` + `  name: './keep-first-round.js'`）
 */
export function keepFirstRoundMountLine() {
  return [
    '# 保留第一轮问答（DeepSeek 思维模式专用）：开关在插件 config（keepFirstRound.enabled），本行只承担挂载。',
    '- id: keep-first-round',
    "  name: './keep-first-round.js'",
  ].join('\n')
}

/** 备份目录名：与 rp-agent.js 的 BACKUP_DIR_NAME 同名同义（同一个 .dma-backup/）。 */
export const BACKUP_DIR_NAME = '.dma-backup'

/** 组成文件名（DSH 官方约定，同 mt-preset/rp-agent；opts.compositionFile 可覆盖，仅认纯文件名）。 */
export const COMPOSITION_FILE_NAME = 'agent.cordis.yml'

/** 换代时效的如实标注（调用方必须原样展示；⛔ 不许把「已 touch」说成「已生效」）。 */
export const GENERATION_NOTE = '换代码只在**新会话**生效；已在跑的会话留在旧代'

// ---------------------------------------------------------------------------
// 小工具（全部返回对象，不把异常抛给调用方）
// ---------------------------------------------------------------------------

function fail(code, message, extra) {
  return Object.assign({ ok: false, code, message }, extra || {})
}

/** 时间戳（与 rp-agent 的 nowStamp 同口径：<yyyymmdd>-<hhmmss>-<mmm>）。 */
function nowStamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return (
    String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) +
    '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '-' + p(d.getMilliseconds(), 3)
  )
}

function sha256Of(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/** 原子写 Buffer：tmp-<pid> → 全量 → fsync → rename。⛔ 不许直接 writeFile 盖原文件。 */
function atomicWrite(file, buf) {
  const tmp = file + '.tmp-' + process.pid
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

// ---------------------------------------------------------------------------
// 包内副本（单一事实源：<包根>/preset-modules/ 下的逐字节副本）
// ---------------------------------------------------------------------------

/**
 * 包内副本目录解析：显式参数优先（自检/多环境注入用），缺省 = 相对本文件上溯一层的
 * <包根>/preset-modules。⛔ 不写死任何绝对路径。
 */
export function resolveModulesDir(explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return resolve(explicit)
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url))) // lib/ 的上一层 = 包根
  return join(packageRoot, PRESET_MODULES_DIR_NAME)
}

/**
 * 读包内副本清单：每个模块给 { name, path, buf, bytes, sha256 }。
 * 任何一个读不到 ⇒ ok:false（随包发版的文件缺失是发布事故，如实报、不猜）。
 */
export function loadPresetModules(modulesDir, names = PRESET_MODULE_NAMES) {
  const dir = resolveModulesDir(modulesDir)
  const modules = []
  for (const name of names) {
    const path = join(dir, name)
    let buf = null
    try {
      buf = readFileSync(path)
    } catch {}
    if (buf === null) {
      return fail('MODULE_SOURCE_MISSING', '包内副本读不到：' + path + '（发版丢了 files 里的 ' + PRESET_MODULES_DIR_NAME + '/ ？）')
    }
    modules.push({ name, path, buf, bytes: buf.length, sha256: sha256Of(buf) })
  }
  return { ok: true, dir, modules }
}

/** 数 <presetDir>/.dma-backup/ 下的条目（目录不存在 = 0 个；自检台用）。 */
export function listBackupEntries(presetDir) {
  try {
    return readdirSync(join(presetDir, BACKUP_DIR_NAME))
  } catch {
    return []
  }
}

/** 备份：旧内容写到 <presetDir>/.dma-backup/<名>.<时间戳>（只备份要改的那几个文件）。 */
function backupModuleFile(presetDir, name, oldBuf, stamp) {
  const backupDir = join(presetDir, BACKUP_DIR_NAME)
  mkdirSync(backupDir, { recursive: true })
  const path = join(backupDir, name + '.' + stamp)
  atomicWrite(path, oldBuf)
  return { dir: backupDir, path, name: name + '.' + stamp }
}

// ---------------------------------------------------------------------------
// 幂等写面
// ---------------------------------------------------------------------------

/**
 * 把包内副本幂等写进预设目录（dryRun 与真写共用本函数，零写入走 dryRun 分支）。
 *
 * @param {object} opts
 *   presetDir   必填 —— 预设目录（调用方传入；⛔ 本文件不猜、不写死任何绝对路径）
 *   modulesDir  可选 —— 包内副本目录（缺省 = <包根>/preset-modules，相对本文件解析）
 *   moduleNames 可选 —— 要落盘的模块名清单（缺省 = PRESET_MODULE_NAMES 原两件，行为不变；
 *                 要带上 keep-first-round 就传 PRESET_MODULE_NAMES_ALL）
 *   dryRun      true ⇒ 一个字节都不写，只回「将要做什么」（create / skip / overwrite + 备份落点）
 *   _fault      ★ 自检专用：'verify' 模拟回读不一致（测自动回滚 + 停下不写后续文件），其余值忽略
 *
 * @returns 计划（dryRun）或 { ok, results:[{name, action, bytes, sha256, backup}] }；
 *          失败返回 { ok:false, code, message, ... }，且后续文件一个都没写。
 */
export function provisionPresetModules(opts = {}) {
  const o = opts || {}
  if (typeof o.presetDir !== 'string' || o.presetDir.trim() === '') {
    return fail('BAD_PRESET_DIR', '缺 presetDir（预设目录由调用方传入，本文件不猜路径）')
  }
  const dir = resolve(o.presetDir)
  let st = null
  try {
    st = statSync(dir)
  } catch {}
  if (!st || !st.isDirectory()) {
    return fail('PRESET_DIR_NOT_FOUND', '预设目录不存在：' + dir + '（建目录是 provisionRpPreset 的职责，本写面不越界）')
  }
  const loaded = loadPresetModules(
    o.modulesDir,
    Array.isArray(o.moduleNames) && o.moduleNames.length > 0 ? o.moduleNames : PRESET_MODULE_NAMES,
  )
  if (!loaded.ok) return loaded
  const compositionFile =
    typeof o.compositionFile === 'string' && o.compositionFile.trim() !== '' ? o.compositionFile : COMPOSITION_FILE_NAME
  if (compositionFile.includes('/') || compositionFile.includes('\\') || compositionFile.includes('..') || compositionFile.includes(':')) {
    return fail('BAD_COMPOSITION_FILE', 'compositionFile 只允许纯文件名（不许含 / \\ .. :，防目录穿越）：' + JSON.stringify(compositionFile))
  }

  const dryRun = o.dryRun === true
  const stamp = nowStamp()
  const results = []

  for (const mod of loaded.modules) {
    const target = join(dir, mod.name)
    let onDisk = null
    try {
      onDisk = readFileSync(target)
    } catch {}
    const same = onDisk !== null && sha256Of(onDisk) === mod.sha256
    const action = onDisk === null ? 'create' : (same ? 'skip' : 'overwrite')

    if (dryRun) {
      results.push({
        name: mod.name,
        action,
        bytes: mod.bytes,
        sha256: mod.sha256,
        backup: action === 'overwrite' ? join(dir, BACKUP_DIR_NAME, mod.name + '.' + stamp) : null,
      })
      continue
    }

    // ---- ① 写前 sha256 比对：相同 ⇒ 跳过（不动字节、不动 mtime、不产备份）＝幂等 ----
    if (onDisk !== null && sha256Of(onDisk) === mod.sha256) {
      results.push({ name: mod.name, action: 'skip', bytes: mod.bytes, sha256: mod.sha256, backup: null })
      continue
    }

    // ---- ② 不同 ⇒ 先备份（只备份要改的文件；备份失败 ⇒ 原文件未被碰，停下如实报）----
    let backup = null
    if (onDisk !== null) {
      try {
        backup = backupModuleFile(dir, mod.name, onDisk, stamp)
      } catch (e) {
        return fail(
          'BACKUP_FAILED',
          '备份 ' + mod.name + ' 失败（原文件未被改动，后续文件一个都没写）：' + String((e && e.message) || e),
          { name: mod.name, results },
        )
      }
    }

    // ---- ③ 原子写 ----
    try {
      atomicWrite(target, mod.buf)
    } catch (e) {
      return fail(
        'WRITE_FAILED',
        '原子写 ' + mod.name + ' 失败（原文件未被 rename 碰过）：' + String((e && e.message) || e),
        { name: mod.name, backup, results },
      )
    }

    // ---- ④ 回读逐字节比对（Buffer.compare，逃不过 BOM/编码差异）----
    let readBack = null
    try {
      readBack = readFileSync(target)
    } catch {}
    let verifyBad = null
    if (o._fault === 'verify') verifyBad = '（自检注入）模拟回读不一致'
    else if (readBack === null || Buffer.compare(readBack, mod.buf) !== 0) verifyBad = '回读与包内副本逐字节不一致'

    // ---- ⑤ 不符 ⇒ 报冲突并停下：该文件用备份盖回（原来没有就删掉），后续文件一个都不写 ----
    if (verifyBad) {
      let rolledBack = false
      let rollbackError = null
      try {
        if (backup && onDisk !== null) {
          atomicWrite(target, onDisk)
          rolledBack = Buffer.compare(readFileSync(target), onDisk) === 0
        } else {
          rmSync(target, { force: true })
          rolledBack = !existsSync(target)
        }
      } catch (e) {
        rollbackError = String((e && e.message) || e)
      }
      return fail(
        'VERIFY_FAILED',
        mod.name + ' 回读校验不过（' + verifyBad + '）—— 已停下，后续文件一个都没写' +
          (rolledBack ? '；该文件已回滚，盘上不留半截状态' : '；回滚也失败了：' + (rollbackError || '未知')),
        { name: mod.name, rolledBack, backup, results },
      )
    }

    results.push({
      name: mod.name,
      action,
      bytes: mod.bytes,
      sha256: mod.sha256,
      backup: backup ? backup.path : null,
    })
  }

  // ---- ⑥ 换代触发（选项A）：只在真的写了文件时 touch 组成文件（byte-identical touch）----
  const changed = results.filter((r) => r.action !== 'skip').length
  const warnings = []
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      presetDir: dir,
      modulesDir: loaded.dir,
      results,
      wouldTouch: changed >= 1,
      generationNote: GENERATION_NOTE,
      warnings,
      errors: [],
    }
  }
  const compositionPath = join(dir, compositionFile)
  let touched = false
  if (changed < 1) {
    // 全部 skip ⇒ 一个字节都不动（连 touch 都不许）：白 touch = 白漏一代 mount + 一份 watcher
    //（官方语义：被替代的世代永不回收，preset/agent-presets/README.zh.md:176）
  } else if (o.touchComposition === false) {
    warnings.push('touchComposition:false —— 本次有写入但未触发组成文件换代（调用方显式关闭）')
  } else {
    let original = null
    let mtimeBefore = Number.NaN
    try {
      original = readFileSync(compositionPath)
      mtimeBefore = statSync(compositionPath).mtimeMs
    } catch {}
    if (original === null) {
      // ⛔ 绝不顺手创建：没有组成文件就没有「换代」可言，如实报告了事
      warnings.push('组成文件不存在（' + compositionPath + '）—— 本次写入未触发换代（不 touch、不创建）')
    } else {
      const shaBefore = sha256Of(original)
      const touchOriginal = Buffer.from(original) // 回滚留底（touch 写的就是这份字节）
      try {
        atomicWrite(compositionPath, original)
      } catch (e) {
        return fail(
          'TOUCH_WRITE_FAILED',
          'touch ' + compositionFile + ' 失败（模块已写入，保持原样未回滚）：' + String((e && e.message) || e),
          { touched: false, results, warnings },
        )
      }
      let after = null
      let mtimeAfter = Number.NaN
      try {
        after = readFileSync(compositionPath)
        mtimeAfter = statSync(compositionPath).mtimeMs
      } catch {}
      const shaSame = after !== null && sha256Of(after) === shaBefore
      const mtimeChanged = mtimeAfter !== mtimeBefore
      if (!shaSame) {
        // sha 不等 = 内容被写坏：用留底原样盖回（是清场，不是重试 touch），然后停下如实报
        let rolledBack = false
        try {
          atomicWrite(compositionPath, touchOriginal)
          rolledBack = sha256Of(readFileSync(compositionPath)) === shaBefore
        } catch {}
        return fail(
          'TOUCH_VERIFY_FAILED',
          'touch 后 sha256 与写前不一致（内容被动过）—— 停下、不重试、不猜',
          { touched: false, rolledBack, results, warnings },
        )
      }
      if (!mtimeChanged) {
        return fail(
          'TOUCH_VERIFY_FAILED',
          'touch 后 mtime 没变（文件系统时间戳精度不足？）—— 停下、不重试、不猜（内容本身未变）',
          { touched: false, results, warnings },
        )
      }
      touched = true
    }
  }
  return {
    ok: true,
    dryRun,
    presetDir: dir,
    modulesDir: loaded.dir,
    results,
    touched,
    generationNote: GENERATION_NOTE,
    warnings,
    errors: [],
  }
}
