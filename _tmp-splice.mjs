import { readFileSync, writeFileSync } from 'node:fs'
const p = 'D:/apps/deepseek/dsh-memory-archive/lib/client.js'
let s = readFileSync(p, 'utf8')
const gen = readFileSync('D:/apps/deepseek/dsh-memory-archive/_tmp-client-table.txt', 'utf8').replace(/\n$/, '')

// ① 替换整块 PM_TAVERN_FIELD_NOTES（含它上面那段注释头）
const startMark = '      // ★★ 2026-09-19（用户口径，原文）：'
const endMark = '      // 段名**前缀**兜底注释（精确表没有时的第二层；仍认不出的才写「未收录」）。'
const a = s.indexOf(startMark)
const b = s.indexOf(endMark)
if (a < 0 || b < 0 || b < a) throw new Error('锚点没找到 a=' + a + ' b=' + b)
s = s.slice(0, a) + gen + '\n' + s.slice(b)

// ② 前缀兜底表里删掉 pmp-dsh-tavern:part: 那条（现在由 PM_TAVERN_FIELD_PLAN 逐字段负责）
const pfStart = s.indexOf("        // ★ 2026-09-19 补（用户口径：「dsht 的注入没有管理和写注释」）")
const pfEnd = s.indexOf("      ]\n      function pmSectionNote(name) {")
if (pfStart < 0 || pfEnd < 0) throw new Error('前缀表锚点没找到')
s = s.slice(0, pfStart) + s.slice(pfEnd)

// ③ pmSectionNote 改用 pmTavernFieldPlan
s = s.replace(
  `        const part = /^pmp-dsh-tavern:part:\d+:(.+)$/.exec(key)
        if (part !== null) {
          const byField = PM_TAVERN_FIELD_NOTES[part[1]]
          if (typeof byField === 'string' && byField !== '') return byField
        }`,
  `        const part = /^pmp-dsh-tavern:part:\d+:(.+)$/.exec(key)
        if (part !== null) {
          const entry = pmTavernFieldPlan(part[1])
          if (entry !== null && typeof entry.note === 'string' && entry.note !== '') return entry.note
        }`,
)
writeFileSync(p, s)
console.log('已替换；残留 PM_TAVERN_FIELD_NOTES 出现次数 =', (s.match(/PM_TAVERN_FIELD_NOTES/g) || []).length)
console.log('PM_TAVERN_FIELD_PLAN 出现次数 =', (s.match(/PM_TAVERN_FIELD_PLAN/g) || []).length)
