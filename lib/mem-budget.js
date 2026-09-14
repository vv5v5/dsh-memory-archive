/**
 * mem-budget —— 「按字节」限容的小工具（P0 内存修复，2026-09-12 事故的根治件）
 *
 * 事故：宿主 pid 30248 堆 4082/4091 MB 时 `FATAL ERROR: Ineffective mark-compacts
 * near heap limit`。实测单个大会话解析后驻留 ~130–190 MB，而两处缓存只按条数限容、
 * 没有字节上限 ⇒ 最坏 8 × 180 MB ≈ 1.4 GB 直接进堆。
 *
 * 本文件提供两件东西，lib/prompt-viewer.js 与 lib/index.js 共用（不许各写一份）：
 *   - estimateBytes(value)：廉价的结构体体积估算（单次遍历，绝不 JSON.stringify 整个
 *     对象 —— 那会自己再制造一份巨大字符串，反而更吃内存）。
 *   - createByteBudgetedCache({maxEntries, maxBytes})：条数 + 字节双限额的 LRU 缓存；
 *     ★ 单条就超 maxBytes 的 ⇒ 不存（set 返回 false，bytes 不变）—— 这条是本次事故
 *     的核心语义：大会话永远不进缓存，内存因此有硬上界（宁可每次重新解析/重新取）。
 *
 * 零依赖：只用语言内置，无任何 npm 依赖。不挂任何 HTTP 面。
 *
 * @license CC-BY-NC-4.0 (Attribution-NonCommercial 4.0 International)
 * 移植来源：anima-rag (https://github.com/Ellinav/anima-rag) — 作者 Ellinav
 * 仅限个人学习与非商业用途；禁止闭源商用或转为付费插件/服务；不重新分发预置私域数据。
 * 含 DeepSeek Harness 派生部分（MIT, Copyright (c) 2026 DeepSeek）时该部分保留 MIT。
 */

/** 大数组改线性估算的门槛与样本数（§2.4 口径，见 estimateBytes 头注释）。 */
const ARRAY_EXACT_LIMIT = 1024
const ARRAY_SAMPLE_COUNT = 64
/** 遍历节点数硬上限：任何输入下估算成本都有界（~几十 ms 量级），防病态结构拖住宿主。 */
const MAX_VISITS = 1_000_000

/**
 * 廉价估算 value 的驻留字节数（近似值，口径如下）：
 *   - 字符串：`length * 2`（按 UTF-16 码元计；V8 的单字节 ASCII 串会被高估一倍 ——
 *     高估是安全方向：宁可早淘汰，不可放进真实超限的对象）。
 *   - number 8B / boolean 4B / bigint·symbol 16B / null·undefined 0B / function 64B。
 *   - 对象与数组：每个记 64B 头开销；数组另按槽位 +8B/个；对象另按自有可枚举键
 *     计 `key.length * 2 + 8`，再递归值。
 *   - Date/RegExp/Error/Promise 记 64B；Map/Set 记 64B 后递归条目；TypedArray 直接
 *     用 byteLength。
 *   - §2.4 性能口径：★ 超过 ARRAY_EXACT_LIMIT 的大数组【按样本线性估算】—— 等距取
 *     ARRAY_SAMPLE_COUNT 个元素求平均 × length，不做全量递归（479,210 条事件的会话
 *     由此保持 <100ms 量级）；小数组与所有对象仍精确递归。
 *   - 循环引用用 WeakSet 祖先链防炸（进入记、退出删，同一路径不重复下钻）；
 *     遍历节点总数超过 MAX_VISITS 即止（此时结果偏低估 —— 安全方向之外的兜底，
 *     只对病态深/宽结构生效，正常会话数据到不了）。
 * @param {unknown} value - 任意值
 * @returns {number} 估算字节数（≥0 的整数）
 */
export function estimateBytes(value) {
  const ancestors = new WeakSet()
  let total = 0
  let visits = 0

  function visit(v) {
    if (++visits > MAX_VISITS) return
    if (v === null || v === undefined) return
    switch (typeof v) {
      case 'string':
        total += v.length * 2
        return
      case 'number':
        total += 8
        return
      case 'boolean':
        total += 4
        return
      case 'bigint':
      case 'symbol':
        total += 16
        return
      case 'function':
        total += 64
        return
      case 'object':
        break
      default:
        return
    }
    if (ancestors.has(v)) return // 循环引用：不再下钻
    ancestors.add(v)
    try {
      if (Array.isArray(v)) {
        total += 64 + 8 * v.length
        if (v.length > ARRAY_EXACT_LIMIT) {
          // 大数组：等距采样后按「平均每元素字节数 × 元素总数」外推内容字节
          // （线性口径，见头注释）—— 不外推会把几十万条事件的会话低估几个数量级。
          const contentStart = total
          const step = v.length / ARRAY_SAMPLE_COUNT
          for (let i = 0; i < ARRAY_SAMPLE_COUNT; i++) visit(v[Math.floor(i * step)])
          const sampledContent = total - contentStart
          total = contentStart + Math.round((sampledContent / ARRAY_SAMPLE_COUNT) * v.length)
          return
        }
        for (let i = 0; i < v.length; i++) visit(v[i])
        return
      }
      if (v instanceof Date || v instanceof RegExp || v instanceof Error || v instanceof Promise) {
        total += 64
        return
      }
      if (v instanceof Map) {
        total += 64
        for (const [k, val] of v) {
          visit(k)
          visit(val)
        }
        return
      }
      if (v instanceof Set) {
        total += 64
        for (const val of v) visit(val)
        return
      }
      if (ArrayBuffer.isView(v)) {
        total += 64 + (v.byteLength || 0)
        return
      }
      // 普通对象 / 类实例：自有可枚举属性。
      total += 64
      for (const key of Object.keys(v)) {
        total += key.length * 2 + 8
        visit(v[key])
      }
    } finally {
      ancestors.delete(v)
    }
  }

  visit(value)
  return total
}

/**
 * 「条数 + 字节」双限额的进程内 LRU 缓存。
 *
 * 淘汰规则（set 时）：先按 LRU 淘汰到 maxEntries 条以内，再继续淘汰到总字节
 * maxBytes 以内（Map 迭代序 = 插入序，最旧在最前；get 命中会把该键刷新为最新）。
 * ★ 单条 approxBytes > maxBytes ⇒ 完全不存：set 返回 false，size/bytes 均不变。
 *
 * @param {{maxEntries?: number, maxBytes?: number}} options
 *   maxBytes 用 Infinity 表示不限字节；两个参数都做防御性归一。
 * @returns {{
 *   get(key: unknown): unknown,
 *   set(key: unknown, value: unknown): boolean,
 *   delete(key: unknown): boolean,
 *   readonly size: number,
 *   readonly bytes: number,
 *   clear(): void,
 * }}
 *   get 未命中返回 undefined；delete 供 TTL 类调用方在条目过期时立即回收字节
 *   （规格要求的最小形状是 {get,set,size,bytes,clear}，delete 是给 lib/index.js
 *   TTL 逐出用的附加方法）。
 */
export function createByteBudgetedCache({ maxEntries = 8, maxBytes = Infinity } = {}) {
  const entries = Math.max(1, Math.trunc(Number(maxEntries)) || 1)
  const budget = Number(maxBytes)
  const byteLimit = Number.isFinite(budget) ? Math.max(0, budget) : Infinity

  /** Map：key -> { value, bytes }；迭代序即 LRU 序（最旧在最前）。 */
  const map = new Map()
  let totalBytes = 0

  function evictOldest() {
    const oldestKey = map.keys().next().value
    if (oldestKey === undefined) return false
    totalBytes -= map.get(oldestKey).bytes
    map.delete(oldestKey)
    return true
  }

  return {
    /** 读并刷新新近度；未命中返回 undefined。 */
    get(key) {
      const entry = map.get(key)
      if (entry === undefined) return undefined
      map.delete(key)
      map.set(key, entry)
      return entry.value
    },
    /** 写；内部自算 approxBytes。单条超字节上限 ⇒ 不存并返回 false。 */
    set(key, value) {
      const approxBytes = estimateBytes(value)
      if (approxBytes > byteLimit) return false
      const old = map.get(key)
      if (old !== undefined) totalBytes -= old.bytes // 同 key 覆盖：先扣旧值字节
      map.delete(key)
      map.set(key, { value, bytes: approxBytes })
      totalBytes += approxBytes
      while (map.size > entries) evictOldest() // ① 先淘到条数内
      while (totalBytes > byteLimit && map.size > 0) {
        // ② 再淘到字节内。守卫保证单条 ≤ byteLimit，循环必然在清空前停住。
        if (!evictOldest()) break
      }
      return true
    },
    /** 立即逐出并回收字节（TTL 过期用）；键不存在返回 false。 */
    delete(key) {
      const entry = map.get(key)
      if (entry === undefined) return false
      totalBytes -= entry.bytes
      return map.delete(key)
    },
    get size() {
      return map.size
    },
    get bytes() {
      return totalBytes
    },
    clear() {
      map.clear()
      totalBytes = 0
    },
  }
}
