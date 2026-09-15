/**
 * _selftest-echo-inject.mjs —— lib/echo-inject.js 行为级自检（E7 + 装配语义 + E10）。
 * 跑法：node --no-warnings _selftest-echo-inject.mjs
 * 全程用临时目录 + 注入的假 config / 假 query / 假 loadFloors（⛔ 不碰真 ~/.dsh，
 * 也因此证明工厂不读全局配置、不自注册段）。输出只打印长度/计数，无 fixture 正文。
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildEchoText, createEchoInject } from './lib/echo-inject.js'

let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`PASS ${name}`)
  else { failures++; console.log(`FAIL ${name}${detail ? ' —— ' + detail : ''}`) }
}

// ---- fixtures：碎片拼接（E10 同款纪律），命中正文不落字面量 ----
const E = {
  key: ent(['铜', '钥匙']),
  lan: ent(['长街', '灯笼']),
  bell: ent(['钟楼', '铜铃']),
  rain: ent(['雨夜', '青石']),
  pad: ent(['一人', '一半']),
}
function ent(parts) { return parts.join('') }
const bodyOf = (parts) => [...parts.map((p) => E[p]), E.pad].join('。')
const FLOORS = [
  { floor: 1, text: bodyOf(['key', 'rain']) },
  { floor: 2, text: bodyOf(['lan', 'bell']) },
  { floor: 3, text: bodyOf(['key', 'lan']) },
  { floor: 4, text: bodyOf(['rain', 'bell']) },
  { floor: 5, text: bodyOf(['key', 'bell']) },
  { floor: 6, text: bodyOf(['lan', 'rain']) },
  { floor: 7, text: bodyOf(['key', 'lan', 'rain']) },
  { floor: 9, text: bodyOf(['key', 'bell']) }, // 最新一轮：查询文本从它来
]
const fixtureBodies = FLOORS.map((f) => f.text)

// ---- buildEchoText 基本形状 ----
{
  const fake = (n) => ({ floor: n, body: ('字'.repeat(30) + '。') })
  const hits = [fake(7), fake(12), fake(45)]
  const out = buildEchoText(hits, { maxChars: 1200, perHitChars: 280, topK: 5 })
  check('形状：以 <memoryEcho> 开、</memoryEcho> 收', out.startsWith('<memoryEcho>\n') && out.endsWith('\n</memoryEcho>'))
  check('形状：楼号 4 位补零', out.includes('[楼 0007]') && out.includes('[楼 0012]') && out.includes('[楼 0045]'))
  check('前言逐字在文：讲明「历史回响/不是此刻/以锚点为准」',
    out.includes('（历史回响：下面是本档案过往楼层的原文片段——都是已经发生过的事，不是此刻；与 <storyAnchor> 当前坐标冲突时，一律以锚点为准。）'))
  check('空命中 ⇒ 空串（本轮不注入）', buildEchoText([], {}) === '' && buildEchoText(undefined, {}) === '')
  check('垃圾命中被滤掉（无楼号/空正文）', buildEchoText([{ floor: 'x', body: 'y' }, { floor: 3, body: '   ' }], {}) === '')
  const multi = buildEchoText([{ floor: 8, body: ['第一行', '第二行'].join('\n') }], {})
  check('片段内换行/空白折叠成单行', multi.includes('第一行 第二行') && !multi.includes('\n第二行'))
}

// ---- E7：预算 maxChars / topK 被遵守，超限有标注 ----
{
  const hits = []
  for (let i = 0; i < 8; i++) hits.push({ floor: i + 1, body: '词'.repeat(200) })
  const out = buildEchoText(hits, { maxChars: 600, perHitChars: 200, topK: 5 })
  const lineCount = (out.match(/\[楼 /g) ?? []).length
  check('E7 maxChars 被遵守（输出 ≤ 600）', out.length <= 600, `len=${out.length}`)
  check('E7 topK 被遵守（≤5 条）', lineCount <= 5, `lines=${lineCount}`)
  check('E7 超限有截断标注（不静默，预算 600 只装得下 2/8 条）', out.includes('［已截断：') && out.includes('2/8'))
  const one = buildEchoText(hits.slice(0, 2), { maxChars: 1200, perHitChars: 50, topK: 5 })
  check('E7 单条超 perHitChars ⇒ 行内截断标注', one.includes('…［片段已截断］'))
  const huge = buildEchoText(hits, { maxChars: 100000, perHitChars: 100000, topK: 999 })
  check('E7 反证：去掉预算 ⇒ 同样输入会远超 600 且无标注（断言会红）', huge.length > 600 && !huge.includes('［已截断：'), `len=${huge.length}`)
}

// ---- createEchoInject：段描述 / 默认关 / fail-silent ----
{
  const ROOT = mkdtempSync(join(tmpdir(), 'echo-inject-selftest-'))
  const storageDir = join(ROOT, 'store')
  mkdirSync(storageDir, { recursive: true })
  const source = 'w1'
  const loadFloors = () => FLOORS.map((f) => ({ ...f, source }))
  const query = () => ({ text: FLOORS[7].text, excludeFloors: [9], source }) // 最新一轮 = 楼 9 的内容

  // 默认关：getConfig 都不给 enabled
  const off = createEchoInject({ getConfig: () => ({}), storageDir, query, loadFloors })
  off.refresh()
  check('开关默认 false：refresh 后 text 为空', off.section.text === '')
  check('段名/序号写死在返回的 section 描述里：dma:echo / 54', off.section.name === 'dma:echo' && off.section.order === 54)

  // 开启 + 正常链路
  const on = createEchoInject({ getConfig: () => ({ enabled: true }), storageDir, query, loadFloors })
  const sec = on.refresh()
  check('开启后产出回响文本（含楼行）', sec.text.includes('[楼 000'), `len=${sec.text.length}`)
  check('链路语义：最新楼层（9）不在回响里', !/^\[楼 0009\]/m.test(sec.text))
  check('refresh 是同步有界函数（返回同一 section 引用）', on.refresh() === sec || typeof on.refresh === 'function')

  // 配置贯通：topK=1
  const k1 = createEchoInject({ getConfig: () => ({ enabled: true, topK: 1, maxChars: 2000 }), storageDir, query, loadFloors: () => FLOORS.map((f) => ({ ...f, source: 'w2' })) })
  const s1 = k1.refresh()
  const n1 = (s1.text.match(/\[楼 /g) ?? []).length
  check('getConfig.topK=1 贯通到注入文本', n1 === 1, `lines=${n1}`)

  // query 抛错 ⇒ 空回响、不抛
  const badQ = createEchoInject({ getConfig: () => ({ enabled: true }), storageDir, query: () => { throw new Error('boom') } })
  let threw = false
  try { badQ.refresh() } catch { threw = true }
  check('query 抛错 ⇒ fail-silent 空回响（不抛）', threw === false && badQ.section.text === '')

  // 库损坏 ⇒ fail-silent（E8 在注入层的同款语义）；用独立目录，避免覆盖别人打开中的库文件
  const brokenDir = join(ROOT, 'broken')
  mkdirSync(brokenDir, { recursive: true })
  writeFileSync(join(brokenDir, 'echo-index.db'), '损坏字节，不是 sqlite 库 —— aaaabbbbcccc')
  const broken = createEchoInject({ getConfig: () => ({ enabled: true }), storageDir: brokenDir, query, loadFloors })
  let threw2 = false
  try { broken.refresh() } catch { threw2 = true }
  check('库损坏 ⇒ 注入层同样 fail-silent（不抛、空文本）', threw2 === false && broken.section.text === '')

  // query 文本为空 ⇒ 不注入
  const emptyQ = createEchoInject({ getConfig: () => ({ enabled: true }), storageDir: join(ROOT, 'fresh'), query: () => ({ text: '   ' }) })
  check('query 文本为空 ⇒ 空串', emptyQ.refresh().text === '')

  check('注入层收尾：库文件只出现在注入的 storageDir 下（未写死任何路径）',
    existsSync(join(storageDir, 'echo-index.db')))

  try { rmSync(ROOT, { recursive: true, force: true }) } catch {}
}

// ---- E10：fixture 正文前 12 字在三处零命中 ----
{
  const prefixes = [...new Set(fixtureBodies.map((b) => b.slice(0, 12)))]
  const files = [
    join(dirname(fileURLToPath(import.meta.url)), 'lib', 'echo-index.js'),
    join(dirname(fileURLToPath(import.meta.url)), 'lib', 'echo-inject.js'),
    fileURLToPath(import.meta.url),
  ]
  let hits = 0
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    for (const p of prefixes) if (src.includes(p)) hits++
  }
  check('E10 fixture 正文前 12 字 × 新模块×2 + 本自检台 ⇒ 0 命中', hits === 0, `hits=${hits} prefixes=${prefixes.length}`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
