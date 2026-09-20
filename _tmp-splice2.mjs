import { readFileSync, writeFileSync } from 'node:fs'
const p = 'D:/apps/deepseek/dsh-memory-archive/lib/client.js'
let s = readFileSync(p, 'utf8')
const gen = readFileSync('D:/apps/deepseek/dsh-memory-archive/_tmp-client-table.txt', 'utf8').replace(/\n$/, '')

// ① 替换 PM_TAVERN_FIELD_NOTES 整块（含注释头）—— 用它上面那行注释与其后「前缀兜底」注释行做锚
const startMark = '      // ★★ 2026-09-19（用户口径，原文）：'
const endMark = '      // 段名**前缀**兜底注释（精确表没有时的第二层；仍认不出的才写「未收录」）。'
let a = s.indexOf(startMark); let b = s.indexOf(endMark)
if (a < 0 || b < 0 || b < a) throw new Error('锚点①没找到 a=' + a + ' b=' + b)
s = s.slice(0, a) + gen + '\n' + s.slice(b)

// ② 前缀兜底表里删掉 pmp-dsh-tavern:part: 那条（现在由 PM_TAVERN_FIELD_PLAN 逐字段负责）
const L = s.split('\n')
const iEntry = L.findIndex((x) => x.includes("['pmp-dsh-tavern:part:',"))
if (iEntry < 0) throw new Error('锚点②没找到：part 前缀条目')
let iStart = iEntry
while (iStart > 0 && !/^\s*\/\/ /m.test(L[iStart - 1]) === false) { /* 占位，下面用显式条件 */ break }
// 往上吃掉紧邻的注释行（以 `        // ` 开头）
while (iStart > 0 && /^\s*\/\/ /.test(L[iStart - 1])) iStart -= 1
// 往下吃到数组结束的 `      ]`
let iEnd = iEntry
while (iEnd < L.length && L[iEnd].trim() !== ']') iEnd += 1
console.log('② 删行', iStart + 1, '→', iEnd + 1, '：', JSON.stringify(L[iStart]).slice(0, 50), '…', JSON.stringify(L[iEnd]))
L.splice(iStart, iEnd - iStart + 1)
s = L.join('\n')

// ③ pmSectionNote 改用 pmTavernFieldPlan
const before = `        const part = /^pmp-dsh-tavern:part:\d+:(.+)$/.exec(key)
        if (part !== null) {
          const byField = PM_TAVERN_FIELD_NOTES[part[1]]
          if (typeof byField === 'string' && byField !== '') return byField
        }`
const after = `        const part = /^pmp-dsh-tavern:part:\d+:(.+)$/.exec(key)
        if (part !== null) {
          const entry = pmTavernFieldPlan(part[1])
          if (entry !== null && typeof entry.note === 'string' && entry.note !== '') return entry.note
        }`
if (!s.includes(before)) throw new Error('锚点③没找到（pmSectionNote）')
s = s.replace(before, after)
writeFileSync(p, s)
console.log('残留 PM_TAVERN_FIELD_NOTES =', (s.match(/PM_TAVERN_FIELD_NOTES/g) || []).length, '| PM_TAVERN_FIELD_PLAN =', (s.match(/PM_TAVERN_FIELD_PLAN/g) || []).length)
