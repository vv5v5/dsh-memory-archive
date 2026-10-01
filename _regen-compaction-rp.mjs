// 重新生成 RP 压缩后端产物并铺两处部署点。
// ★ 2026-09-30 加后处理：主管平衡扫描的「反斜杠字面量」在产物里一律换成
//   String.fromCharCode(92)——模板串会吃一层反斜杠（\\\\→\\→\ 的深度地狱），
//   产物里的反斜杠字面量深度永远对不齐 ⇒ 干脆零字面量（fromCharCode 运行时算）。
//   当前已知一处：主管平衡扫描的 esc 判定 `ch === '\\'`。
import { writeFileSync, readFile } from 'node:fs'
import { buildRpCompactionBackend } from './lib/mt-compaction.js'
const targets = [
  'C:/Users/w/.dsh/profiles/web/preset-modules/mt-compaction-rp.js',
  'C:/Users/w/.dsh/.agent-presets/roleplay/mt-compaction-rp.js',
]
const RAW = buildRpCompactionBackend()
// 后处理：把「主管平衡扫描 esc 判定」的反斜杠字面量换成 fromCharCode（模板串吃一层后的
// 产物里无论剩几个反斜杠深度，统一替换成无字面量形式）。
const FIXED = RAW.replace("ch === '\\\\') esc = true", "ch === String.fromCharCode(92)) esc = true")
  .replace("ch === '\\') esc = true", "ch === String.fromCharCode(92)) esc = true")
for (const t of targets) {
  writeFileSync(t, FIXED, 'utf8')
  console.log('written:', t)
}
// 自验：产物 import 不炸 + 关键标记在场
const ok = await import('file://' + targets[0]).then(() => true, (e) => { console.error('产物 import 失败:', e.message); return false })
if (!ok) process.exit(2)
console.log('自验通过（import OK）· esc 判定已 fromCharCode 化:', FIXED.includes("ch === String.fromCharCode(92)) esc = true"))
