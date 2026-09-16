/**
 * B2 · 导入落库（`POST /import/apply`）—— 把「导入」从"只出计划"推进到"真写进周目归档"。
 *
 * 为什么单独一个模块（而不是塞进 import-formats.js）：`import-formats.js` 的硬保证是
 * **零写入**（自检台有一条结构性反证：那个文件里不许出现 write/mkdir 调用）。落库必然要写，
 * 所以那半边必须住在别处 —— 本模块就是那半边，且它自己**不重写写入器**，而是把计划交给
 * A1（`collect.js`）的 `planCollect` + `applyCollect`：目录创建、逐文件读回实证、
 * 索引双读乐观锁、manifest 增量、失败时如实附 partial —— 全部复用同一套。
 *
 * 三道闸（每一道都是"宁可拒写，也不写错"）：
 *   ① **预览即合同**：调用方必须把 `POST /import/plan` 拿到的 `willWrite`（path+sha256）
 *      原样回传（`body.preview`）。落库前重算一遍计划，逐条比 —— 对不上就 `IMPORT_PLAN_STALE`，
 *      **一个字节都不写**。这条抓的是"你确认之后归档又变了"（新楼层会让楼号整体后移）。
 *   ② **两个写手的字节约定交叉核对**：A1 打算写的每个文件，其 sha256 必须等于 import 预览里的值。
 *      这条不是形式主义 —— 20260915 之前 A1 的 `floorDocText` 与 import 的 `floorBodyText`
 *      就差一个尾换行，靠这条当场变红（`IMPORT_WRITER_MISMATCH`），而不是"写进去但没人认得"。
 *   ③ **0 楼不落库**：没有可导入楼层时直接拒（⛔ 不给索引写一条"声称收了 N 楼"却没有楼层的假台账）。
 *
 * 隐私：计划里带正文的那半（`buildImportPlan(...).internal`）只在本模块内部流转，
 * ⛔ 绝不出 HTTP 响应；响应里只有路径、计数、sha256 与 A1 的读回实证。
 */
import { buildImportPlan, readImportJsonBody } from './import-formats.js'
import { planCollect, applyCollect, observeArchive, tavernForRequest } from './collect.js'

function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function applyError(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

function errBody(code, message) {
  return { ok: false, error: { code, message } }
}

/** 预览指纹归一成 `[{path, sha256}]`；形状不对 ⇒ IMPORT_PREVIEW_REQUIRED（不猜、不宽容）。 */
export function readPreview(preview) {
  if (!isRecord(preview) || !Array.isArray(preview.willWrite)) {
    throw applyError(
      'IMPORT_PREVIEW_REQUIRED',
      '缺 preview：请把 POST /import/plan 的结果原样回传为 { planId, hash, willWrite:[{path,sha256}] } —— 落库必须"所见即所写"',
    )
  }
  const out = []
  for (const w of preview.willWrite) {
    if (!isRecord(w) || typeof w.path !== 'string' || w.path === '' || typeof w.sha256 !== 'string' || w.sha256 === '') {
      throw applyError('IMPORT_PREVIEW_REQUIRED', 'preview.willWrite 每项必须是 {path, sha256} 且都非空')
    }
    out.push({ path: w.path, sha256: w.sha256 })
  }
  if (out.length === 0) throw applyError('IMPORT_PREVIEW_REQUIRED', 'preview.willWrite 是空的（没有东西可落）')
  return out
}

/** 逐条比 path+sha256（**顺序也算**）：任何一处不同 ⇒ 抛（调用方给 409，一个字节都不写）。 */
export function assertNoDrift(previewed, planned, code, why) {
  if (previewed.length !== planned.length) {
    throw applyError(code, why + '：预览里 ' + previewed.length + ' 个文件，重算出来是 ' + planned.length + ' 个')
  }
  for (let i = 0; i < previewed.length; i++) {
    if (previewed[i].path !== planned[i].path || previewed[i].sha256 !== planned[i].sha256) {
      throw applyError(
        code,
        why + '：第 ' + (i + 1) + ' 个文件对不上（预览 ' + previewed[i].path + ' ↔ 重算 ' + planned[i].path + '）',
      )
    }
  }
}

/**
 * 真落库。`deps.tavern` 必须是**可写**客户端（list/read/write/mkdir）；`deps.now` 可注入时钟。
 * @param input 与 `/import/plan` 同一份输入 + `preview`（预览指纹）
 * @returns `applyCollect` 的结果 + 本批次的标识（planId/hash/楼号区间/路径）
 */
export async function applyImport(input, deps = {}) {
  const tavern = deps ? deps.tavern : null
  if (!isRecord(tavern) || typeof tavern.read !== 'function' || typeof tavern.write !== 'function') {
    throw applyError('IMPORT_TAVERN_UNREACHABLE', '缺可用的 Tavern client（deps.tavern 需要 list/read/write/mkdir）')
  }
  const previewed = readPreview(isRecord(input) ? input.preview : null)

  // ① 重算计划（零写入）。这一趟同时拿到正文（internal）—— ⛔ 只在服务端内存里。
  let built
  try {
    built = await buildImportPlan(input, { tavern })
  } catch (e) {
    // 源读不到时看**底层原因**：Tavern 不可达 / 5xx ⇒ 报"连不上"（用户才知道该去查服务，不是查文件）。
    const cause = e && typeof e.causeCode === 'string' ? e.causeCode : ''
    if (cause === 'TAVERN_UNREACHABLE' || /^TAVERN_HTTP_5\d\d$/.test(cause)) {
      throw applyError('IMPORT_TAVERN_UNREACHABLE', String((e && e.message) || e))
    }
    throw applyError(e && e.code ? e.code : 'IMPORT_INVALID', String((e && e.message) || e))
  }
  const { plan, internal } = built

  // ② 预览即合同：重算结果必须与预览逐条相同。
  assertNoDrift(previewed, plan.willWrite, 'IMPORT_PLAN_STALE',
    '这份计划在你确认之后变了（多半是归档里又多了楼层 ⇒ 楼号会整体后移）—— 请重新 plan 再确认')

  // ③ 0 楼不落库。
  if (internal.floors.length === 0) {
    throw applyError(
      'IMPORT_NO_TURNS',
      '这份记录里没有可导入的楼层'
      + (internal.summaryText !== null ? '（只有开场白）' : '')
      + '；请确认源文件，或把 keepHidden 打开再试',
    )
  }

  // ④ 组装 A1 计划。索引/manifest/乐观锁/读回实证全走 A1 那一套（⛔ 本模块不自己写文件）。
  const overwrite = isRecord(input) && input.overwrite === true
  const target = internal.target
  let observed
  try {
    // ★ summaryPaths：把「将要写的那个摘要文件」的当前指纹一并观察 —— 覆盖重导同一份源时
    //   planId 相同 ⇒ summaries/import-XXXX.md 已存在，planCollect 的期望值必须等于它的真身 sha，
    //   否则写前重核会把「本来就存在」误判成「plan 之后被改过」⇒ 409 乐观锁（2026-09-16 实测）。
    observed = await observeArchive(tavern, target, { overwrite, floors: internal.floors, summaryPaths: [internal.summaryRel] })
  } catch (e) {
    throw applyError('IMPORT_TAVERN_UNREACHABLE', String((e && e.message) || e))
  }
  let collectPlan
  try {
    collectPlan = planCollect(
      {
        target,
        range: { fromFloor: internal.start, toFloor: internal.endFloor },
        floors: internal.floors,
        summary: { id: plan.planId, text: internal.summaryText, model: null },
        overwrite,
      },
      { observed, now: deps.now },
    )
  } catch (e) {
    // COLLECT_TARGET_UNKNOWN / COLLECT_FLOOR_CONFLICT / COLLECT_SUMMARY_EXISTS / COLLECT_INDEX_BROKEN
    // 一律原样带上 code 上抛（端点层据此给 400/409，语义不吞）。
    throw applyError(e && e.code ? e.code : 'IMPORT_PLAN_FAILED', String((e && e.message) || e))
  }

  // ⑤ 两个写手的字节约定交叉核对（详见文件头闸②）。
  const byPath = new Map((collectPlan.willWrite || []).map((w) => [w.path, w.sha256]))
  for (const p of previewed) {
    if (!byPath.has(p.path)) {
      throw applyError('IMPORT_WRITER_MISMATCH', '归档写入器不会写这个文件：' + p.path + '（已拒绝写入）')
    }
    if (byPath.get(p.path) !== p.sha256) {
      throw applyError(
        'IMPORT_WRITER_MISMATCH',
        '同一个目标文件在两个写入器下字节不同：' + p.path + ' —— 落库口径分叉，已拒绝写入（这是代码问题，不是你的操作问题）',
      )
    }
  }

  // ⑥ 真落库（每写一个立刻从 Tavern 读回实证；失败如实抛 partial）。
  const result = await applyCollect(collectPlan, { tavern, now: deps.now })
  return {
    ...result,
    planId: plan.planId,
    hash: plan.hash,
    format: plan.format,
    floors: internal.floors.length,
    floorRange: { from: internal.start, to: internal.endFloor },
    archiveRel: internal.archiveRel,
    summaryRel: internal.summaryRel,
  }
}

/**
 * POST /import/apply —— 200 = 落库结果（written/readBack/warnings）；400 = 输入或 Tavern 问题；
 * 409 = 计划漂移 / 归档被别人改了 / 楼层或摘要已存在（都**没写**）；500 = 真写失败（**附 partial**）。
 * 日志只打 planId/计数，绝不打正文。
 */
export async function handleImportApply(ctx, req, send, log, deps = {}) {
  void ctx
  let body
  try {
    body = await readImportJsonBody(req, deps)
  } catch (e) {
    return send(400, errBody(e.code || 'IMPORT_INVALID', String((e && e.message) || e)))
  }
  let tavern
  try {
    tavern = tavernForRequest(req, deps)
  } catch (e) {
    return send(400, errBody('IMPORT_TAVERN_UNREACHABLE', String((e && e.message) || e)))
  }
  try {
    const result = await applyImport(body, { tavern, now: deps.now })
    if (log && typeof log.info === 'function') {
      try {
        log.info(
          '[mt] /import/apply：planId=' + result.planId
          + ' floors=' + result.floors
          + ' written=' + result.written.length
          + ' warnings=' + result.warnings.length,
        )
      } catch {}
    }
    return send(200, result)
  } catch (e) {
    const code = (e && e.code) || 'IMPORT_APPLY_FAILED'
    const partial = Array.isArray(e.collectPartial) ? e.collectPartial : []
    const written = Array.isArray(e.collectWritten) ? e.collectWritten : []
    const readBack = Array.isArray(e.collectReadBack) ? e.collectReadBack : []
    const warnings = Array.isArray(e.collectWarnings) ? e.collectWarnings : []
    const payload = { ...errBody(code, String((e && e.message) || e)), partial, written, readBack, warnings }
    if (code === 'IMPORT_PLAN_STALE'
      || code === 'COLLECT_REVISION_CHANGED'
      || code === 'COLLECT_FLOOR_CONFLICT'
      || code === 'COLLECT_SUMMARY_EXISTS') {
      return send(409, { ...payload, conflicts: Array.isArray(e.conflicts) ? e.conflicts : [] })
    }
    if (code === 'IMPORT_TAVERN_UNREACHABLE' || code.startsWith('TAVERN_')) {
      return send(400, errBody('IMPORT_TAVERN_UNREACHABLE', String((e && e.message) || e)))
    }
    if (code === 'IMPORT_PREVIEW_REQUIRED'
      || code === 'IMPORT_INVALID'
      || code === 'IMPORT_NO_TURNS'
      || code === 'IMPORT_SOURCE_UNREADABLE'
      || code === 'IMPORT_FORMAT_UNSUPPORTED'
      || code === 'IMPORT_TOO_LARGE'
      || code === 'IMPORT_TOO_MANY_TURNS'
      || code === 'IMPORT_WRITER_MISMATCH'
      || code === 'COLLECT_TARGET_UNKNOWN'
      || code === 'COLLECT_INDEX_BROKEN') {
      return send(400, payload)
    }
    return send(500, payload)
  }
}
