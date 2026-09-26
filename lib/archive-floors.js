// ---------------------------------------------------------------------------
// archive-floors —— 读一份**周目归档楼层目录**（`archive/floors/`）：只读，绝不写。
//
// 从 `lib/echo-index.js` 里搬出来的（2026-09-26，T3「摘掉 fts5」）：
// 那个文件整体是「记忆回响 D2」的 FTS5(trigram) 引擎，回响这一格已由 `dsh-anima-rag` 的
// **语义检索**接管 ⇒ FTS5 那一套（建表 / 入库 / 抽候选 / df 筛 / MATCH 查询 / `echo-index.db`）
// **整块退役、文件已删**。但**读归档楼层**这件事还有两个活着的调用方：
//   · `mt:lastFloors`（最近几楼，`lib/last-floors.js`）—— 把最近 N 楼原文注入 `<recentFloors>`；
//   · `mt:memoryHome` / 楼层跟随那几处（`rootFloorsDir` + 本函数）。
// ⇒ 只把这一件**纯读盘**的事留下来，单独一个模块（比塞回 index.js 里更好被自检台钉住）。
//
// 按真文件键名取：`_floor`（楼号）、`mes`（正文）。坏文件跳过、不中断（一楼的坏 JSON 不该
// 让整段"最近几楼"消失）。返回 [{ floor, text }]，按楼号升序。
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 从磁盘读一份归档楼层目录（archive/floors/）。
 * @param {string} floorsDir 归档楼层目录的绝对路径。
 * @returns {Array<{floor:number,text:string}>} 按楼号升序；目录不存在/读不到 ⇒ 空数组。
 */
export function readArchiveFloors(floorsDir) {
  const out = []
  let files = []
  try {
    files = readdirSync(floorsDir).filter((f) => f.endsWith('.json')).sort()
  } catch {
    return out
  }
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(join(floorsDir, f), 'utf8'))
      const floor = Number(j?._floor)
      if (!Number.isFinite(floor)) continue
      out.push({ floor, text: typeof j?.mes === 'string' ? j.mes : '' })
    } catch {}
  }
  out.sort((a, b) => a.floor - b.floor)
  return out
}
