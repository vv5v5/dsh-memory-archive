import { readFileSync, writeFileSync } from 'node:fs'
const p = 'D:/apps/deepseek/dsh-memory-archive/lib/client.js'
let s = readFileSync(p, 'utf8')
// ① 替换 PM_TAVERN_FIELD_NOTES 整块（含注释头）
const gen = readFileSync('D:/apps/deepseek/dsh-memory-archive/_tmp-client-table.txt', 'utf8').replace(/\n$/, '')
const startMark = '      // ★★ 2026-09-19（用户口径，原文）：'
const endMark = '      // 段名**前缀**兜底注释（精确表没有时的第二层；仍认不出的才写「未收录」）。'
const a = s.indexOf(startMark); const b = s.indexOf(endMark)
if (a < 0 || b < 0 || b < a) throw new Error('锚点①没找到 a=' + a + ' b=' + b)
s = s.slice(0, a) + gen + '\n' + s.slice(b)
// ② 前缀表里删掉 part 那条（含它上面的注释块）
let L = s.split('\n')
const iEntry = L.findIndex((x) => x.includes("['pmp-dsh-tavern:part:',"))
if (iEntry < 0) throw new Error('锚点②没找到')
let iStart = iEntry
while (iStart > 0 && /^\s*\/\/ /.test(L[iStart - 1])) iStart -= 1
let iEnd = iEntry
while (iEnd < L.length && L[iEnd].replace(/\r$/, '').trim() !== ']') iEnd += 1
console.log('② 删行', iStart + 1, '→', iEnd + 1)
L.splice(iStart, iEnd - iStart + 1)
s = L.join('\n')
// ③ pmSectionNote 改用 pmTavernFieldPlan（⛔ 用正则容忍 CRLF：这个文件里有混行的换行）
const re = /\s*const part = \/\^pmp-dsh-tavern:part:\d\+:\(\.\+\)\$\/\.exec\(key\)[\s\S]{0,320}?return byField\r?\n(\s*)\}/
if (!re.test(s)) throw new Error('锚点③没找到')
s = s.replace(re, `\n        const part = /^pmp-dsh-tavern:part:\d+:(.+)$/.exec(key)
        if (part !== null) {
          // ★ 2026-09-19：逐字段注释来自**摆位表**（PM_TAVERN_FIELD_PLAN，镜像 lib/tavern-field-plan.js）
          const entry = pmTavernFieldPlan(part[1])
          if (entry !== null && typeof entry.note === 'string' && entry.note !== '') return entry.note
        }`)
writeFileSync(p, s)
console.log('残留 NOTes =', (s.match(/PM_TAVERN_FIELD_NOTES/g) || []).length, '| PLAN =', (s.match(/TavernFieldPlan|PM_TAVERN_FIELD_PLAN/g) || []).length)
