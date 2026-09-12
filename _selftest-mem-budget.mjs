/**
 * _selftest-mem-budget.mjs —— lib/mem-budget.js 真断言（P0 内存修复的独立验收）。
 * 跑法：node _selftest-mem-budget.mjs   （零依赖，只测纯函数）
 */
import { estimateBytes, createByteBudgetedCache } from './lib/mem-budget.js'

let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`PASS ${name}`)
  else {
    failures++
    console.log(`FAIL ${name}${detail ? ' —— ' + detail : ''}`)
  }
}

// ---- 1) estimateBytes：口径与鲁棒性 ----
check("estimateBytes('abc') === 6（UTF-16 口径）", estimateBytes('abc') === 6, String(estimateBytes('abc')))
check('estimateBytes([1,2,3]) > 0', estimateBytes([1, 2, 3]) > 0, String(estimateBytes([1, 2, 3])))
check('estimateBytes(null)/undefined 不炸', estimateBytes(null) === 0 && estimateBytes(undefined) === 0)

const cyclic = { name: 'x'.repeat(10) }
cyclic.self = cyclic
const cycArr = [1, 2]
cycArr.push(cycArr)
const cycBytes = estimateBytes({ a: cyclic, b: cycArr, deep: { back: cyclic } })
check('循环引用不炸、返回有限正数', Number.isFinite(cycBytes) && cycBytes > 0, String(cycBytes))

// 共享祖先（菱形）：走祖先链 WeakSet，不死循环
const shared = { s: 'y'.repeat(20) }
const diamond = { p: shared, q: shared }
check('菱形共享不炸', Number.isFinite(estimateBytes(diamond)) && estimateBytes(diamond) > 0)

// JSON.stringify 未被调用：换成间谍再跑一遍
const origStringify = JSON.stringify
let stringifyCalls = 0
JSON.stringify = function (...args) {
  stringifyCalls++
  return origStringify.apply(JSON, args)
}
try {
  estimateBytes({ a: { b: ['x', 1, true, new Date(0), new Map([['k', 'v']])] } })
} finally {
  JSON.stringify = origStringify
}
check('estimateBytes 不调用 JSON.stringify', stringifyCalls === 0, `被调用 ${stringifyCalls} 次`)

// 大数组：>1024 走采样线性外推 —— 必须能反映真实量级（不许把 180MB 估成 1MB）
const bigEvents = []
for (let i = 0; i < 200_000; i++) {
  bigEvents.push({ seq: i, type: 'user/message', data: { content: [{ type: 'text', text: 'z'.repeat(180) }] } })
}
const t0 = performance.now()
const bigBytes = estimateBytes({ events: bigEvents })
const elapsedMs = performance.now() - t0
const perEvent = 64 + 64 + 8 + 64 + (7 * 2 + 8) + 64 + 8 + 64 + (4 * 2 + 8) + (6 * 2 + 8) + 64 + (4 * 2 + 8) + (4 * 2 + 8) + 360 // 手算 ≈ 每事件 ~740B
check(
  `20 万事件估算 ≈ 真实量级（${Math.round(bigBytes / 1048576)} MB，手算口径 ≈ ${Math.round((bigEvents.length * perEvent) / 1048576)} MB）`,
  bigBytes > bigEvents.length * perEvent * 0.5 && bigBytes < bigEvents.length * perEvent * 2,
  String(bigBytes),
)
check(`20 万事件估算耗时 <100ms（实测 ${elapsedMs.toFixed(1)} ms）`, elapsedMs < 100, `${elapsedMs.toFixed(1)} ms`)

// ---- 2) createByteBudgetedCache：条数 + 字节双限额 ----
const s100 = 'a'.repeat(50) // estimateBytes = 100
const cache = createByteBudgetedCache({ maxEntries: 3, maxBytes: 1000 })
check('新缓存 size===0 && bytes===0', cache.size === 0 && cache.bytes === 0)
for (let i = 0; i < 5; i++) cache.set(`k${i}`, s100 + i) // 各 100 B（字符串拼接长度不变？—— s100+i 长 51 ⇒ 102B，仍在限内）
check('塞 5 条各 ~100B ⇒ size===3（条数 LRU）', cache.size === 3, String(cache.size))
check('塞 5 条各 ~100B ⇒ bytes<=1000（字节限额内）', cache.bytes <= 1000, String(cache.bytes))
check('留下的恰好是最新 3 条', cache.get('k2') !== undefined && cache.get('k3') !== undefined && cache.get('k4') !== undefined)
check('最旧两条已被淘汰', cache.get('k0') === undefined && cache.get('k1') === undefined)

// ★ 事故核心语义：单条超字节上限 ⇒ 不缓存，bytes 不变
const fresh = createByteBudgetedCache({ maxEntries: 3, maxBytes: 1000 })
const rejected = fresh.set('big', 'b'.repeat(2000)) // 2000 B > 1000 B
check('单条 2000B 塞 maxBytes=1000 ⇒ set 返回 false', rejected === false, String(rejected))
check('被拒后 size===0', fresh.size === 0, String(fresh.size))
check('被拒后 bytes===0', fresh.bytes === 0, String(fresh.bytes))
// 拒绝大条目不影响已有小条目
fresh.set('ok1', s100)
const rejected2 = fresh.set('big2', 'c'.repeat(2000))
check('已有 1 条时再拒大条 ⇒ size 仍 1、bytes 仍 ~100', rejected2 === false && fresh.size === 1 && fresh.bytes === estimateBytes(s100), `size=${fresh.size} bytes=${fresh.bytes}`)

// LRU 语义：get 过的键在淘汰中留到最后
const lru = createByteBudgetedCache({ maxEntries: 3, maxBytes: 1000 })
lru.set('a', s100)
lru.set('b', s100)
lru.set('c', s100)
lru.get('a') // 刷新 a 的新近度
lru.set('d', s100) // 应淘汰 b（不是 a）
check('LRU：get(a) 后插入 d ⇒ 淘汰 b、留下 a', lru.get('a') !== undefined && lru.get('b') === undefined, `a=${lru.get('a') !== undefined} b=${lru.get('b') !== undefined}`)
lru.set('e', s100) // 应淘汰 c
check('LRU：再插入 e ⇒ 淘汰 c，a 仍留到最后', lru.get('a') !== undefined && lru.get('c') === undefined && lru.get('d') !== undefined)

// 覆盖写 / 字节压力淘汰 / delete / clear
const cov = createByteBudgetedCache({ maxEntries: 8, maxBytes: 500 })
cov.set('x', 'x'.repeat(50)) // 100B
cov.set('x', 'y'.repeat(100)) // 覆盖为 200B：字节应按新值计，不是累加
check('同 key 覆盖 ⇒ bytes 按新值计（200，不是 300）', cov.bytes === 200, String(cov.bytes))
const press = createByteBudgetedCache({ maxEntries: 8, maxBytes: 1000 })
press.set('p1', 'p'.repeat(200)) // 400B
press.set('p2', 'q'.repeat(200)) // 400B ⇒ 800B
press.set('p3', 'r'.repeat(200)) // 400B ⇒ 总 1200 > 1000 ⇒ 淘到 800
check('字节压力淘汰：3×400B 进 maxBytes=1000 ⇒ 只留 2 条、bytes≤1000', press.size === 2 && press.bytes <= 1000, `size=${press.size} bytes=${press.bytes}`)
check('字节压力淘汰：留下的恰是最新两条', press.get('p1') === undefined && press.get('p2') !== undefined && press.get('p3') !== undefined)
press.delete('p2')
check('delete 回收字节', press.bytes === 400 && press.size === 1, `bytes=${press.bytes} size=${press.size}`)
press.clear()
check('clear 清空', press.size === 0 && press.bytes === 0)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
