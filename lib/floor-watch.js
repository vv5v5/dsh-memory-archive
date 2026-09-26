// ---------------------------------------------------------------------------
// floor-watch —— 「**主机侧盯 Tavern 写的那个 `timeline.json`**」的**纯逻辑内核**（20260924）。
//
// ## 为什么有它（用户 2026-09-24 原话）
// 「还需要一个 dsh 的弹窗 提示，最好是从**上方弹出**的那种」；追问"什么时候弹"时：
// 「**不能在回档操作之后立刻弹吗，检测 tarven**」。
//
// 卡点（本机查实）：检测原先**只在轮边界**跑（组装那一脚 / 轮末那一脚 / 开面板那一脚）⇒
// 你回档之后**没发消息、也没开面板**，那条提示根本还没被记下来 —— 想"立刻弹"就得**盯着**
// Tavern 落的那个文件（事件驱动），而不是等下一轮。
//
// ## 口径（用户拍板，⛔ 谁都不许"顺手做全"）
//   · ⛔ **不碰上游 Tavern 一行代码**：本模块只**读**它写的目录名，`watch` 由调用方注入
//     （生产端 = `node:fs` 的 `watch`）—— 台子拿**假 watcher** 就能直接喂事件。
//   · ⛔ **不轮询、不定时器**：这一条是**事件**（文件系统给的），不是"每 N 秒问一次"。
//   · ⛔ **不抛**：盯不住（目录不存在 / 权限不足）⇒ 返回一个**空 dispose** 并如实 `log.warn`
//     一条 —— ⛔ 不许静默（静默＝"看着像没事"），⛔ 更不许把插件搞挂（那一档退化成
//     "只能靠轮末 / 开面板发现"）。
//
// ## 两条踩出来的细节（⛔ 别改回去）
//   ① **盯目录，不盯单个文件**：Windows 上"写临时文件再改名"是家常便饭（Tavern 就是原子写），
//      只盯文件的话改名那一刻 watcher 就跟着旧 inode 走了 ⇒ **漏事件**。盯目录 + 回调里按
//      **文件名**过滤，才既不漏也不吵。
//   ② **去抖**：一次保存常有**多个**事件（create + change + rename…）⇒ `debounceMs` 窗内
//      只回调**一次**（否则一次回档会推好几帧、跑好几趟检测）。
//
// @license CC-BY-NC-4.0 (Attribution-NonCommercial 4.0 International)
// 仅限个人学习与非商业用途；禁止闭源商用或转为付费插件/服务。
// ---------------------------------------------------------------------------

/**
 * 周目时间线的文件名。
 * ⚠️ 生产端一般按 `catalog.json` 里那条 `path` 的**basename** 传进来（正常就是它）；
 *   这里给的是缺省值，也是自检台用的那个名字。
 */
export const TIMELINE_FILE_NAME = 'timeline.json'

/** 去抖窗缺省值（毫秒）：一次保存的那几个事件基本都落在几十毫秒里。 */
export const DEFAULT_DEBOUNCE_MS = 300

/**
 * 小工具：**去抖**（纯函数，自检台直测）。
 *
 * 窗内连喂多次 ⇒ 只回调**最后一次**的参数（用的是最后一次那份）；窗后再喂 ⇒ 再回调一次。
 * `wrapped.cancel()` 把**还没到点**的那一次掐掉（`dispose` 用它 —— ⛔ 别让已经拆掉的 watcher
 * 还回调一下）。
 *
 * ⚠️ 回调里**吞掉异常**：定时器里抛出去就是**未捕获异常**（宿主进程级的），
 *   这一条纪律与"⛔ 不把插件搞挂"是同一件事。调用方仍应自己 try 一遍（这里只是最后一道）。
 * ⚠️ `unref()`：这一脚是给宿主用的，⛔ 不许把一个待触发的定时器变成"进程必须等它"。
 *
 * @param {Function} fn 到点后要跑的那件事（⛔ 不是"每次喂都跑"）
 * @param {number} ms 去抖窗（认不出 / 负数 ⇒ 0：下一拍就跑）
 * @returns {Function & { cancel: () => void }}
 */
export function debounce(fn, ms) {
  const wait = Number.isFinite(ms) && ms > 0 ? ms : 0
  const run = typeof fn === 'function' ? fn : () => {}
  let timer = null
  let lastArgs = []
  const wrapped = (...args) => {
    lastArgs = args
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      try { run(...lastArgs) } catch { /* ⛔ 定时器里绝不抛出去（未捕获异常会把宿主搞挂） */ }
    }, wait)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }
  wrapped.cancel = () => {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
    lastArgs = []
  }
  return wrapped
}

/**
 * ★★ **盯一个目录**，里面那个时间线文件一被**写/改名**就回调一次（去抖后）。
 *
 * 判据（⛔ 只此一处）：
 * ```
 * watch 抛（目录不存在 / 权限不足）        ⇒ 空 dispose + log.warn 一条（如实说"现在只能靠轮末/开面板发现"）
 * 事件的文件名 === 那个时间线文件名        ⇒ 算一次
 * 文件名是空（有些平台不给）               ⇒ **也算一次**（宁可多跑一趟去抖后的检测，⛔ 不许漏）
 * 其它文件名                              ⇒ ⛔ 不算（这是本函数唯一的"过滤"判据，挖掉它必红）
 * ```
 *
 * ⚠️ **不读、不解析、不写**那个文件：本模块一个字节都不碰它的内容（判据全在 `floor-snapshot` 那边）。
 *
 * @param {string} dir 要盯的目录（= 那个时间线文件所在的目录，⛔ 不是文件本身）
 * @param {object} o
 *   · `watch`      —— **注入**的 watcher（生产 = `node:fs` 的 `watch`）；缺 ⇒ 空 dispose + warn；
 *   · `onChange`   —— 去抖后回调那一脚（一个参数都不给；异步的写法请调用方自己 `void … .catch()`）；
 *   · `file`       —— 要认的文件名（缺省 `TIMELINE_FILE_NAME`）；
 *   · `debounceMs` —— 去抖窗（缺省 `DEFAULT_DEBOUNCE_MS`）；
 *   · `log`        —— `{warn}`（只有一个方法就够 —— 这里只报"盯不住"这一种情况）。
 * @returns {() => void} `dispose()`：关掉 watcher（**必须** —— 热重载会重建，⛔ 不留野 watcher）
 *   并把还没到点的那一拍掐掉；**幂等**（调两次不炸）。
 */
export function watchTimeline(dir, o) {
  const watchedDir = typeof dir === 'string' ? dir : ''
  const watch = o !== null && typeof o === 'object' && typeof o.watch === 'function' ? o.watch : null
  const onChange = o !== null && typeof o === 'object' && typeof o.onChange === 'function' ? o.onChange : null
  const file = o !== null && typeof o === 'object' && typeof o.file === 'string' && o.file !== ''
    ? o.file
    : TIMELINE_FILE_NAME
  const log = o !== null && typeof o === 'object' ? o.log : null
  const debounceMs = o !== null && typeof o === 'object' ? o.debounceMs : undefined
  /** 空 dispose（**幂等**：什么都没盯上时它也得能被调两次）。 */
  const noop = () => {}
  const warn = (message) => {
    // ⛔ 不许静默：盯不住就得说出来（日志是唯一出口）；也⛔ 不许因为日志组件坏掉而抛。
    try { log?.warn?.(message) } catch { /* 日志失败也不能影响调用方 */ }
  }
  if (watchedDir === '' || watch === null || onChange === null) {
    if (watchedDir !== '' && watch === null) {
      warn('[mt] 楼层快照：没有可用的文件监视器（fs.watch 不可用）⇒ 这一档现在只能靠轮末 / 开面板发现回档')
    }
    return noop
  }
  let watcher = null
  let disposed = false
  const fire = debounce(() => { if (!disposed) onChange() }, debounceMs === undefined ? DEFAULT_DEBOUNCE_MS : debounceMs)
  try {
    watcher = watch(watchedDir, (eventType, filename) => {
      if (disposed) return
      // ⚠️ 文件名是空 ⇒ **也算一次**（有些平台/某些事件不给文件名）；给了就按**那一个名字**过滤。
      if (typeof filename === 'string' && filename !== '' && filename !== file) return
      fire()
    })
  } catch (e) {
    // 目录不存在 / 权限不足 / 平台不支持 …… 一律**降级**：如实说、退成"没有即时检测"，⛔ 不抛。
    warn(`[mt] 楼层快照：盯不住时间线目录（${watchedDir}）⇒ 这一档现在只能靠轮末 / 开面板发现回档：`
      + `${(e && e.message) || e}`)
    return noop
  }
  // ⚠️ 异步的 `error` 事件也**必须**接住：没接的 'error' 在 Node 里是**未捕获异常**（能把宿主搞挂）。
  try {
    if (watcher && typeof watcher.on === 'function') {
      watcher.on('error', (e) => {
        warn(`[mt] 楼层快照：文件监视器出错（${watchedDir}）⇒ 这一档现在只能靠轮末 / 开面板发现回档：`
          + `${(e && e.message) || e}`)
      })
    }
  } catch { /* 接不上就算了：绝不能因此把接线搞砸 */ }
  return () => {
    if (disposed) return
    disposed = true
    fire.cancel()
    try {
      if (watcher && typeof watcher.close === 'function') watcher.close()
    } catch { /* 关不掉也只能算了（下一次接线会重建） */ }
    watcher = null
  }
}

export default { TIMELINE_FILE_NAME, DEFAULT_DEBOUNCE_MS, debounce, watchTimeline }
