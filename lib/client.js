/**
 * dsh-memory-archive —— 客户端半侧（浏览器 bundle）v4 第一单「阅读优先 UI + 真名解析」
 *
 * 格式：factory 形式 CJS，由 DSH 的 `window.__ModuleLoader__` 加载
 *   （react 在平台 seed 表内，所以**不需要构建**；无 JSX，全 React.createElement，别名 e）。
 * 暴露：`exports.apply` / `exports.inject` / `exports.name`，
 *   另有 `exports.__internals`（仅供自检脚本直接调用内部纯函数，不对外承诺稳定）。
 * 注册恰好 **1 个**席位：`sidebar.footer.action`（list；owner props {wide}）—— 侧边栏齿轮按钮，
 *   打开插件自己的完整面板。v4 仍不注册任何设置页席位。
 *
 * 面板（阅读优先）：
 *   · 尺寸放大到 min(1280px,96vw) × min(860px,92vh)；⛶ 可切全屏（inset:0 / 100vw / 100vh / 直角）。
 *   · 顶栏 = 当前根的人话名（点击进设置）+ 提示词 + ⚙设置 + ⛶ + ✕ + 宿主 API 小圆点（悬停说明）。
 *     ★ v3 顶栏常驻的「根模式」单选已撤掉，只活在设置视图里。
 *   · 视图状态 view = 'read' | 'prompts' | 'settings'：
 *     read = 阅读源 tabs + 连续阅读区（同一滚动区；键盘 PgUp/PgDn/空格/Home/End；Esc 先退全屏再关面板）；
 *     prompts = 提示词区三子页：每次请求（吸收自 dsh-prompt-viewer 的三栏 UI）+ 压缩指令 + 收纳占位；
 *     settings = 次级视图：根模式单选 / 根选择（真名下拉）/ API 设置 / 诊断 + 「← 返回阅读」。
 *
 * 阅读源（随根模式变化，只显示可用的；默认源无数据自动退到下一个可用源并在顶部说明）：
 *   工作区模式：摘要（默认）/ 原文 / 状态 / 会话搜索；
 *     摘要 = summaries/index.json 顺序 + 滚动窗口 ≤2 顺序取正文，首尾相接渲染成一篇长文
 *           （>60 篇先渲染 60 篇 + 「加载后 20 篇」；保留前端子串过滤；每篇有「复制本篇」）；
 *     原文 = 一次 ?list=floors 拿楼号上限（失败退 visibility.json 键数），顺序懒加载
 *           （一次只取一个文件、最多预取 1 个）；visibility[sent===false] 的楼层标「未发给模型」；
 *           常驻工具条：跳到楼号 / 首楼 / 末楼 / 上一楼 / 下一楼；
 *     状态 = state/current.json 美化展示。
 *   会话模式：会话事件（默认）/ 会话搜索；
 *     事件 = limit=200 & offset 递增，滚到底自动追加；surface 如实标记（null 什么都不标）；
 *     大会话首次加载可能约 8 秒 —— 显式提示。
 *   Tavern 不可达：阅读区给可读原因；自动退到根会话事件（拿得到 rootSessionId 时）或会话搜索。
 *
 * 真名解析（本单核心）：
 *   工作区根 catalog.json（Tavern 同源直读，content 为字符串需 JSON.parse）提供
 *   角色名 / 周目标题 / rootSessionId（周目↔会话的桥）；catalog 失败再试归档 manifest.json 的
 *   target 兜底映射。纯函数 buildCatalogIndex / shortId / labelCharacter / labelPlaythrough /
 *   labelSession 实现三级回退：session.title → 周目目录（`角色 · 周目`）→ 短 ID（8 位 + …）。
 *   ★ 界面任何地方都不显示完整 UUID / 完整 sessionId：完整值只进 title 悬停属性，配「复制」按钮；
 *   ★ 第 2、3 级回退在界面上如实标来源徽标（来自周目目录 / 无标题），不假装是标题；
 *   ★ 解析结果按页面会话缓存（CATALOG_CACHE），失败也缓存原因，换根/刷新才重取；
 *     catalog 不可读时退回短 ID 并显示红字原因（带 code），不许崩、不许白屏。
 *
 * 提示词区（v4 第二单）：
 *   「每次请求」= 吸收 dsh-prompt-viewer 的三栏内容区（左会话列表 / 中每次请求 composition 摘要 /
 *   右部件全文 + 子串高亮 + 复制），数据面根换成 /dsh-memory-archive/prompt；原插件的外壳与席位
 *   注册一律不带进来。保留其纪律：列表首刷只扫目录（title:'' / requests:-1 是未解析哨兵，0 是
 *   「解析过、确实没有请求」的真值）、空闲批量 resolve（每批 ≤10、每次进子页/刷新列表累计硬上限
 *   TITLE_FILL_CAP=20 个、requestIdleCallback 排程、子页不活跃/刷新/卸载即中断不再排下一批）、
 *   AbortController、失败降级可读红字绝不抛出；会话标题过 labelSession。
 *   「压缩指令」「收纳占位」= 模板编辑卡片：一行状态（custom 徽标 + 字符数）/ 逐字解释（规格 §2）/
 *   多行 textarea（初值 = current）/ 保存·恢复内置默认·复制·载入内置默认 / 折叠「官方原文参考」+
 *   出处说明 / 诚实提示。数据面 GET·PUT /api/templates：body 只带要改的键，null/空串 = 恢复内置默认；
 *   响应 = 写后回读的同形状，只信回读（保存/恢复后文本框同步成回读值）；400 CONFIG_INVALID → 可读红字。
 *
 * 宿主 API（根路径 /dsh-memory-archive/api，与宿主半侧契约逐字对齐）：
 *   GET  /health      → {ok,webServer,sessionQuery,storageDirWritable,tavernReachable}
 *   GET  /config      → {ok,rootMode,api:{url,model},keySet,keyHint,storageDir,configPath,configError}
 *   PUT  /config      → 同形状写回；api.key 省略/空=保留，"__CLEAR__"=清空
 *   POST /config/test → 测连通（httpStatus/elapsedMs/replyPreview，或 error.code）
 *   GET  /sessions?titles=1 → {ok,sessions:[{sessionId,title,updatedAt}]}（★ 必须带 titles=1：默认快路径 title 一律 null）
 *   GET  /session/events?sessionId=&limit=&offset= → {ok,total,events:[…]}（宿主 limit 上限 200）
 *   ★ 密钥绝不回显：输入框初值恒空、type=password，placeholder 只用 keySet/keyHint；密钥不落任何本地持久存储。
 *   ★ /config 可能不含 root 字段：所有 root 相关展示在缺失时退化（自动发现 / 已选项本地记忆 / 占位）。
 *
 * 纪律（沿用 v2/v3）：所有网络/解析失败降级为界面可读红字（带 code）绝不抛出；
 * 组件卸载/切源/切根/关面板一律 AbortController 取消在飞请求；除一次 ?list= 目录列举外不并发扫目录；
 * 样式只用内联 style + Canvas/CanvasText 系统色。
 */

window.__ModuleLoader__.load({
  id: 'dsh-memory-archive',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    return (() => {
      const React = require('react')
      const e = React.createElement

      const TAVERN_API_BASE = '/pmp-dsh-tavern/api/v2/workspace/files'
      const HOST_API_BASE = '/dsh-memory-archive/api'
      const PROMPT_API_BASE = '/dsh-memory-archive/prompt'   // 吸收自 dsh-prompt-viewer 的数据面（宿主半侧 ./prompt-viewer.js）
      const EVENT_PAGE_SIZE = 200        // 宿主 /session/events 的 limit 上限就是 200
      const SUMMARY_INIT_LIMIT = 60      // 摘要先渲染前 60 篇（大归档保护）
      const SUMMARY_MORE_STEP = 20       // 「加载后 20 篇」
      const SUMMARY_CONCURRENCY = 2      // 摘要正文顺序预取的滚动窗口上限
      const SCROLL_BOTTOM_MARGIN = 80    // 距底部多少像素内触发续读
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      const MONO = 'ui-monospace, Menlo, Consolas, monospace'

      // ---------- 样式（内联 + 系统色，不写死主题色） ----------
      const inputStyle = {
        padding: '6px 8px', fontSize: 13, background: 'Canvas', color: 'CanvasText',
        border: '1px solid color-mix(in srgb, CanvasText 30%, transparent)', borderRadius: 6,
      }
      const itemStyle = {
        padding: '6px 8px', cursor: 'pointer', fontSize: 12, lineHeight: 1.5, borderRadius: 6,
        border: '1px solid color-mix(in srgb, CanvasText 12%, transparent)',
      }
      const btnStyle = {
        cursor: 'pointer', fontSize: 12, padding: '4px 10px', background: 'Canvas', color: 'CanvasText',
        border: '1px solid color-mix(in srgb, CanvasText 30%, transparent)', borderRadius: 6,
      }
      const miniBtnStyle = {
        cursor: 'pointer', fontSize: 11, padding: '1px 6px', background: 'transparent', color: 'CanvasText',
        border: '1px solid color-mix(in srgb, CanvasText 25%, transparent)', borderRadius: 4,
      }
      const selectStyle = {
        fontSize: 11, maxWidth: 220, padding: '2px 4px', background: 'Canvas', color: 'CanvasText',
        border: '1px solid color-mix(in srgb, CanvasText 30%, transparent)', borderRadius: 6,
      }
      const flowPreStyle = {
        margin: 0, padding: 10, fontFamily: MONO, fontSize: 12.5, lineHeight: 1.7,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        background: 'Canvas', color: 'CanvasText',
        border: '1px solid color-mix(in srgb, CanvasText 12%, transparent)', borderRadius: 6,
      }
      const errorStyle = { fontSize: 12, color: 'crimson' }
      const okStyle = { fontSize: 12, color: 'green' }
      const dimStyle = { fontSize: 11, opacity: 0.55 }
      const colFillStyle = { display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minHeight: 0 }
      const statusAreaStyle = {
        display: 'flex', flexDirection: 'column', gap: 4,
        borderTop: '1px solid color-mix(in srgb, CanvasText 15%, transparent)', paddingTop: 6,
      }
      // 面板外壳：居中大浮层（v4：阅读优先，放大到 1280×860）
      const backdropStyle = {
        position: 'fixed', inset: 0, zIndex: 999, background: 'rgba(0,0,0,.35)',
      }
      const shellStyle = {
        position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
        width: 'min(1280px, 96vw)', height: 'min(860px, 92vh)',
        display: 'flex', flexDirection: 'column', gap: 8, padding: 12, boxSizing: 'border-box',
        background: 'Canvas', color: 'CanvasText',
        boxShadow: '0 8px 24px rgba(0,0,0,.35)', borderRadius: 10, overflow: 'hidden', zIndex: 1000,
      }
      const shellFullStyle = {
        position: 'fixed', inset: 0, width: '100vw', height: '100vh',
        display: 'flex', flexDirection: 'column', gap: 8, padding: 12, boxSizing: 'border-box',
        background: 'Canvas', color: 'CanvasText', overflow: 'hidden', zIndex: 1000, borderRadius: 0,
      }
      const headerStyle = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flex: 'none' }
      const cardStyle = {
        display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', borderRadius: 8,
        border: '1px solid color-mix(in srgb, CanvasText 15%, transparent)',
      }
      const sectionTitleStyle = { fontSize: 13, fontWeight: 700 }
      const scrollColStyle = {
        flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, paddingRight: 2,
      }
      const fieldLabelStyle = { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12 }
      const rowLabelStyle = { fontSize: 12, opacity: 0.75, minWidth: 150, flex: 'none' }
      const monoDimStyle = { fontFamily: MONO, fontSize: 11, opacity: 0.8, wordBreak: 'break-all' }
      // 连续阅读区的滚动容器（键盘滚动就绑在它上面；各阅读源共用）
      const readScrollStyle = {
        flex: 1, minHeight: 0, overflowY: 'auto', outline: 'none',
        display: 'flex', flexDirection: 'column', gap: 10, paddingRight: 2,
      }
      const dimBadgeStyle = {
        fontSize: 11, opacity: 0.7, borderRadius: 4, padding: '0 4px',
        border: '1px solid color-mix(in srgb, CanvasText 25%, transparent)',
      }
      const warnBadgeStyle = {
        fontSize: 11, color: 'crimson', borderRadius: 4, padding: '0 4px',
        border: '1px solid color-mix(in srgb, crimson 45%, transparent)',
      }
      // 提示词区·每次请求（吸收自 dsh-prompt-viewer）：三栏布局与专用样式
      const columnsStyle = { display: 'flex', gap: 8, flex: 1, minHeight: 0 }
      const colSessionStyle = Object.assign({}, colFillStyle, { width: 200, flexShrink: 0 })
      const colTurnStyle = Object.assign({}, colFillStyle, { width: 250, flexShrink: 0 })
      const colPartStyle = Object.assign({}, colFillStyle, { flex: 1, minWidth: 0 })
      const selectedStyle = { background: 'color-mix(in srgb, CanvasText 10%, transparent)' }
      const promptPreStyle = {
        margin: 0, padding: 8, flex: 1, minHeight: 0, overflowY: 'auto',
        fontFamily: MONO, fontSize: 12, lineHeight: 1.6,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        background: 'Canvas', color: 'CanvasText',
        border: '1px solid color-mix(in srgb, CanvasText 12%, transparent)', borderRadius: 6,
      }
      const toolRowStyle = {
        padding: '4px 8px', fontSize: 12, lineHeight: 1.5, borderRadius: 6,
        border: '1px solid color-mix(in srgb, CanvasText 12%, transparent)',
        display: 'flex', justifyContent: 'space-between', gap: 8,
      }
      const markStyle = { background: 'Highlight', color: 'HighlightText', borderRadius: 2 }
      const promptListStyle = { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }
      // 模板编辑卡片：解释文案 / 诚实提示 / textarea
      const explainStyle = {
        fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap',
        background: 'color-mix(in srgb, CanvasText 4%, Canvas)', color: 'CanvasText',
        border: '1px solid color-mix(in srgb, CanvasText 12%, transparent)', borderRadius: 6, padding: '8px 10px',
      }
      const honestStyle = {
        fontSize: 12, color: 'crimson', lineHeight: 1.6, whiteSpace: 'pre-wrap',
        background: 'color-mix(in srgb, crimson 7%, Canvas)',
        border: '1px solid color-mix(in srgb, crimson 35%, transparent)', borderRadius: 6, padding: '6px 8px',
      }
      const templateAreaStyle = {
        width: '100%', boxSizing: 'border-box', minHeight: 260, resize: 'vertical',
        padding: 8, fontFamily: MONO, fontSize: 12.5, lineHeight: 1.6,
        background: 'Canvas', color: 'CanvasText',
        border: '1px solid color-mix(in srgb, CanvasText 30%, transparent)', borderRadius: 6,
      }

      // ---------- 工具 ----------
      function pad4(n) { return String(n).padStart(4, '0') }

      function errText(error) {
        const message = String((error && error.message) || error || '未知错误')
        const code = error && error.code ? ' [' + String(error.code) + ']' : ''
        return message + code
      }

      function formatTime(value) {
        if (typeof value !== 'string' || value === '') return ''
        const t = Date.parse(value)
        return Number.isFinite(t) ? new Date(t).toLocaleString() : value
      }

      // 复制到剪贴板：优先 clipboard API，失败退 textarea+execCommand；再失败抛带 code 的错（界面红字）
      function copyText(text) {
        return Promise.resolve().then(() => {
          if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            return navigator.clipboard.writeText(text)
          }
          const err = new Error('剪贴板 API 不可用')
          err.code = 'COPY_FAIL'
          throw err
        }).catch((error) => {
          try {
            const ta = document.createElement('textarea')
            ta.value = text
            ta.setAttribute('readonly', '')
            ta.style.position = 'fixed'
            ta.style.opacity = '0'
            document.body.appendChild(ta)
            ta.select()
            const ok = document.execCommand('copy')
            document.body.removeChild(ta)
            if (!ok) throw error
          } catch (fallbackError) {
            const err = new Error('剪贴板不可用，复制失败')
            err.code = 'COPY_FAIL'
            throw err
          }
        })
      }

      // ---------- 网络（同源；失败一律 throw 带 code 的 Error，绝不抛出到界面外） ----------
      async function requestJson(url, signal) {
        let res
        try {
          res = await fetch(url, { headers: { accept: 'application/json' }, signal })
        } catch (error) {
          if (error && error.name === 'AbortError') throw error
          const err = new Error('网络请求失败：' + String((error && error.message) || error))
          err.code = 'NETWORK'
          throw err
        }
        let data = null
        try { data = await res.json() } catch (error) { data = null }
        if (!res.ok) {
          const err = new Error((data && data.error && data.error.message) || 'HTTP ' + res.status)
          err.code = (data && data.error && data.error.code) || ('HTTP_' + res.status)
          err.payload = data
          throw err
        }
        if (!data || data.ok !== true) {
          const err = new Error((data && data.error && data.error.message) || '接口返回异常')
          err.code = (data && data.error && data.error.code) || 'BAD_PAYLOAD'
          err.payload = data
          throw err
        }
        return data
      }

      // PUT/POST 变体（宿主配置写回、连接测试）；body 为 undefined 时不带请求体
      async function mutateJson(url, method, body, signal) {
        let res
        try {
          const init = { method: method, headers: { accept: 'application/json' }, signal }
          if (body !== undefined) {
            init.headers['content-type'] = 'application/json'
            init.body = JSON.stringify(body)
          }
          res = await fetch(url, init)
        } catch (error) {
          if (error && error.name === 'AbortError') throw error
          const err = new Error('网络请求失败：' + String((error && error.message) || error))
          err.code = 'NETWORK'
          throw err
        }
        let data = null
        try { data = await res.json() } catch (error) { data = null }
        if (!res.ok) {
          const err = new Error((data && data.error && data.error.message) || 'HTTP ' + res.status)
          err.code = (data && data.error && data.error.code) || ('HTTP_' + res.status)
          err.payload = data
          throw err
        }
        if (!data || data.ok !== true) {
          const err = new Error((data && data.error && data.error.message) || '接口返回异常')
          err.code = (data && data.error && data.error.code) || 'BAD_PAYLOAD'
          err.payload = data
          throw err
        }
        return data
      }

      async function listDir(rel, signal) {
        const data = await requestJson(TAVERN_API_BASE + '?list=' + encodeURIComponent(rel || ''), signal)
        const list = Array.isArray(data.list) ? data.list : []
        // 服务端实际返回 {path, type}（path 为相对 posix 路径）；兼容 {name} 形状
        return list.map((entry) => {
          const p = typeof entry.path === 'string' ? entry.path : ''
          const name = typeof entry.name === 'string' && entry.name !== ''
            ? entry.name
            : (p.split('/').pop() || p)
          return { name: name, type: entry.type === 'dir' ? 'dir' : 'file' }
        })
      }

      async function readFileText(rel, signal) {
        const data = await requestJson(TAVERN_API_BASE + '?path=' + encodeURIComponent(rel), signal)
        if (typeof data.content !== 'string') {
          const err = new Error('文件内容不是文本')
          err.code = 'BAD_PAYLOAD'
          throw err
        }
        return data.content
      }

      function parseJsonOr(raw, message) {
        try { return JSON.parse(raw) } catch (error) {
          const err = new Error(message)
          err.code = 'BAD_JSON'
          throw err
        }
      }

      // ---------- 真名解析（纯函数，可被自检直接调用；契约冻结，勿改形状） ----------
      // catalog.json 形状：{playthroughs:[{id,title,lastOpenedAt,ext:{pmpDshTavern:{
      //   characterId,characterName,rootSessionId,playthroughNumber,autoTitle }}}]}
      function buildCatalogIndex(catalogJson) {
        let src = catalogJson
        if (typeof catalogJson === 'string') {
          try { src = JSON.parse(catalogJson) } catch (error) {
            const err = new Error('catalog.json 不是合法 JSON')
            err.code = 'BAD_JSON'
            throw err
          }
        }
        const index = { charNames: {}, byPlaythrough: {}, byRootSession: {} }
        const list = src && typeof src === 'object' && Array.isArray(src.playthroughs) ? src.playthroughs : []
        for (const p of list) {
          if (!p || typeof p !== 'object') continue
          const pid = typeof p.id === 'string' ? p.id : ''
          if (pid === '') continue
          const ext = p.ext && p.ext.pmpDshTavern && typeof p.ext.pmpDshTavern === 'object' ? p.ext.pmpDshTavern : {}
          const charId = typeof ext.characterId === 'string' ? ext.characterId : ''
          const charName = typeof ext.characterName === 'string' ? ext.characterName : ''
          const title = typeof p.title === 'string' ? p.title : ''
          const number = typeof ext.playthroughNumber === 'number' ? ext.playthroughNumber : null
          const rootSessionId = typeof ext.rootSessionId === 'string' ? ext.rootSessionId : ''
          const lastOpenedAt = typeof p.lastOpenedAt === 'string' ? p.lastOpenedAt : ''
          if (charId !== '' && charName !== '' && !index.charNames[charId]) index.charNames[charId] = charName
          if (!index.byPlaythrough[pid]) {
            index.byPlaythrough[pid] = {
              title: title, number: number, charId: charId, charName: charName,
              rootSessionId: rootSessionId, lastOpenedAt: lastOpenedAt,
            }
          }
          if (rootSessionId !== '' && !index.byRootSession[rootSessionId]) {
            index.byRootSession[rootSessionId] = {
              characterName: charName, playthroughTitle: title,
              playthroughNumber: number, playthroughId: pid,
            }
          }
        }
        return index
      }

      const EMPTY_NAME_INDEX = { charNames: {}, byPlaythrough: {}, byRootSession: {} }

      // catalog 不可读时的兜底：用归档自己记录的 manifest.target 补「会话↔周目」映射（拿不到名字，仅映射）
      function mergeManifestHint(index, manifest) {
        const t = manifest && manifest.target && typeof manifest.target === 'object' ? manifest.target : null
        if (!t) return index
        const out = {
          charNames: Object.assign({}, index.charNames),
          byPlaythrough: Object.assign({}, index.byPlaythrough),
          byRootSession: Object.assign({}, index.byRootSession),
        }
        const pid = typeof t.playthroughId === 'string' ? t.playthroughId : ''
        const sid = typeof t.rootSessionId === 'string' ? t.rootSessionId : ''
        const cid = typeof t.characterId === 'string' ? t.characterId : ''
        if (pid !== '' && !out.byPlaythrough[pid]) {
          out.byPlaythrough[pid] = { title: '', number: null, charId: cid, charName: '', rootSessionId: sid, lastOpenedAt: '' }
        }
        if (sid !== '' && pid !== '' && !out.byRootSession[sid]) {
          out.byRootSession[sid] = { characterName: '', playthroughTitle: '', playthroughNumber: null, playthroughId: pid }
        }
        return out
      }

      // 短 ID：8 字符 + …（界面唯一允许的 id 形态；完整值只进 title / 复制）
      function shortId(value) {
        return String(value == null ? '' : value).slice(0, 8) + '…'
      }

      function labelCharacter(charId, index) {
        const hit = index && index.charNames ? index.charNames[charId] : null
        if (typeof hit === 'string' && hit !== '') return hit
        return shortId(charId)
      }

      // opts.short：不带「最后打开」后缀（顶栏等紧凑处用）；默认带（契约形状）
      function labelPlaythrough(playthroughId, index, opts) {
        const info = index && index.byPlaythrough ? index.byPlaythrough[playthroughId] : null
        let base
        if (info && typeof info.title === 'string' && info.title !== '') base = info.title
        else if (info && typeof info.number === 'number') base = String(info.number) + '周目'
        else base = shortId(playthroughId)
        if (opts && opts.short) return base
        const t = info && typeof info.lastOpenedAt === 'string' ? formatTime(info.lastOpenedAt) : ''
        return t ? base + ' · 最后打开 ' + t : base
      }

      // 三级回退（顺序不许变）：1) session.title  2) 周目目录 `角色 · 周目`  3) 短 ID
      function labelSession(session, index) {
        const sid = session && typeof session.sessionId === 'string' ? session.sessionId : ''
        const title = session && typeof session.title === 'string' ? session.title.trim() : ''
        if (title !== '') return { text: title, source: 'title' }
        const hit = sid !== '' && index && index.byRootSession ? index.byRootSession[sid] : null
        if (hit) {
          const parts = []
          if (typeof hit.characterName === 'string' && hit.characterName !== '') parts.push(hit.characterName)
          if (typeof hit.playthroughTitle === 'string' && hit.playthroughTitle !== '') parts.push(hit.playthroughTitle)
          if (parts.length > 0) return { text: parts.join(' · '), source: 'playthrough' }
        }
        return { text: shortId(sid), source: 'id' }
      }

      // 第 2、3 级回退的来源徽标（如实标注，不假装是标题）
      function sourceBadge(source) {
        if (source === 'playthrough') {
          return { text: '来自周目目录', title: '会话本身没有标题，名字由工作区周目目录（catalog.json）解析而来' }
        }
        if (source === 'id') {
          return { text: '无标题', title: '没有会话标题，也没有周目目录映射，只能显示短 ID（完整值可复制）' }
        }
        return null
      }

      // catalog.json 解析缓存（页面会话级）：成功/失败都缓存（失败带原因），换根/刷新/重试才重取
      const CATALOG_CACHE = { done: false, index: EMPTY_NAME_INDEX, error: null }
      async function getCatalogIndex(signal, force) {
        if (CATALOG_CACHE.done && !force) return CATALOG_CACHE
        CATALOG_CACHE.done = false
        CATALOG_CACHE.error = null
        try {
          const raw = await readFileText('catalog.json', signal)
          const parsed = parseJsonOr(raw, 'catalog.json 不是合法 JSON')
          CATALOG_CACHE.index = buildCatalogIndex(parsed)
          CATALOG_CACHE.done = true
        } catch (error) {
          if (error && error.name === 'AbortError') throw error
          CATALOG_CACHE.index = buildCatalogIndex(null)
          CATALOG_CACHE.error = errText(error)
          CATALOG_CACHE.done = true
        }
        return CATALOG_CACHE
      }

      // Tavern 工作区归档自动发现（不写死 id；逐级探测，失败目录跳过）。
      // 返回 { found:[{charId, plays:[playthroughId]}], characterId, playthroughId }
      async function discoverWorkspaces(signal) {
        const aborted = () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          err.code = 'ABORTED'
          return err
        }
        const rootEntries = await listDir('', signal)
        const charIds = rootEntries
          .filter((en) => en.type === 'dir' && UUID_RE.test(en.name))
          .map((en) => en.name).sort()
        if (charIds.length === 0) {
          const err = new Error('工作区根目录下未发现 character 目录（uuid 形状）')
          err.code = 'NO_ARCHIVE'
          throw err
        }
        const found = []
        for (let ci = 0; ci < charIds.length; ci++) {
          const charId = charIds[ci]
          let entries = []
          try { entries = await listDir(charId, signal) } catch (error) {
            if (signal.aborted) throw error
            continue
          }
          const plays = []
          for (let pi = 0; pi < entries.length; pi++) {
            const en = entries[pi]
            if (en.type !== 'dir' || en.name.indexOf('playthrough-') !== 0) continue
            try {
              const inner = await listDir(charId + '/' + en.name, signal)
              if (inner.some((x) => x.type === 'dir' && x.name === 'archive')) plays.push(en.name)
            } catch (error) {
              if (signal.aborted) throw error
            }
          }
          if (plays.length > 0) found.push({ charId: charId, plays: plays })
          if (signal.aborted) throw aborted()
        }
        if (found.length === 0) {
          const err = new Error('character 目录下未发现带 archive/ 的 playthrough')
          err.code = 'NO_ARCHIVE'
          throw err
        }
        const first = found[0]
        let chosen = first.plays[0]
        if (first.plays.length > 1) {
          // 默认选 summaries/index.json updatedAt 最新的周目（小文件探测，失败不致命）
          const probes = []
          for (let i = 0; i < first.plays.length; i++) {
            const p = first.plays[i]
            let at = ''
            try {
              const raw = await readFileText(first.charId + '/' + p + '/archive/summaries/index.json', signal)
              const parsed = parseJsonOr(raw, 'bad index')
              if (parsed && typeof parsed.updatedAt === 'string') at = parsed.updatedAt
            } catch (error) { at = '' }
            probes.push({ p: p, at: at })
            if (signal.aborted) throw aborted()
          }
          probes.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
          chosen = probes[0].p
        }
        return { found: found, characterId: first.charId, playthroughId: chosen }
      }

      // ---------- 小组件：复制按钮 / 来源徽标 / surface 徽标 ----------
      function CopyBtn({ value, label }) {
        const [msg, setMsg] = React.useState('')
        const timerRef = React.useRef(null)
        React.useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])
        const doCopy = (ev) => {
          ev.stopPropagation()
          copyText(String(value == null ? '' : value)).then(
            () => setMsg('已复制'),
            () => setMsg('复制失败 [COPY_FAIL]'),
          )
          if (timerRef.current) clearTimeout(timerRef.current)
          timerRef.current = setTimeout(() => setMsg(''), 1800)
        }
        return e('span', { style: { display: 'inline-flex', gap: 4, alignItems: 'baseline' }, onClick: (ev) => ev.stopPropagation() },
          e('button', { style: miniBtnStyle, onClick: doCopy, title: '复制完整值到剪贴板' }, label || '复制'),
          msg ? e('span', { style: msg.indexOf('失败') !== -1 ? { fontSize: 11, color: 'crimson' } : dimStyle }, msg) : null,
        )
      }

      // surface 如实标记（不许猜）：current → 在上下文中；shadowed → 已被移出上下文；
      // log-only → 不上上下文；null → 什么都不标。
      function SurfaceBadge({ surface }) {
        if (surface === 'current') return e('span', { style: { fontSize: 11, color: 'green' } }, '· 在上下文中')
        if (surface === 'shadowed') return e('span', { style: { fontSize: 11, color: 'darkorange', fontWeight: 700 } }, '· 已被移出上下文')
        if (surface === 'log-only') return e('span', { style: { fontSize: 11, opacity: 0.5 } }, '· 不上上下文')
        return null
      }

      // ---------- 阅读源·摘要（工作区）：索引顺序 + 滚动窗口 ≤2 顺序取正文 → 一篇长文 ----------
      function SummariesFlow({ archivePath, scrollBind, reportLoad }) {
        const [state, setState] = React.useState({ status: 'loading', entries: [], error: '' })
        const [filter, setFilter] = React.useState('')
        const [limit, setLimit] = React.useState(SUMMARY_INIT_LIMIT)
        const bodiesRef = React.useRef({})   // i -> string | null(失败)；undefined=未加载
        const [, bump] = React.useState(0)
        const runRef = React.useRef(0)

        React.useEffect(() => {
          const controller = new AbortController()
          bodiesRef.current = {}
          runRef.current++
          setState({ status: 'loading', entries: [], error: '' })
          setLimit(SUMMARY_INIT_LIMIT)
          if (!archivePath) { setState({ status: 'idle', entries: [], error: '' }); return }
          ;(async () => {
            const raw = await readFileText(archivePath + '/summaries/index.json', controller.signal)
            const parsed = parseJsonOr(raw, 'summaries/index.json 不是合法 JSON')
            if (controller.signal.aborted) return
            const entries = (Array.isArray(parsed && parsed.entries) ? parsed.entries : []).slice()
            entries.sort((a, b) => ((a && a.fromFloor) || 0) - ((b && b.fromFloor) || 0))
            setState({ status: 'ready', entries: entries, error: '' })
            if (entries.length === 0) reportLoad(false, 'index.json 里没有 entries')
          })().catch((error) => {
            if (controller.signal.aborted) return
            setState({ status: 'error', entries: [], error: errText(error) })
            reportLoad(false, errText(error))
          })
          return () => { controller.abort(); runRef.current++ }
        }, [archivePath])

        // 正文顺序预取：两个 worker 按序号抢占推进（滚动窗口 ≤ SUMMARY_CONCURRENCY），只取到当前渲染上限
        React.useEffect(() => {
          if (state.status !== 'ready') return
          const controller = new AbortController()
          const myRun = ++runRef.current
          const target = Math.min(limit, state.entries.length)
          const cursor = { i: 0 }
          const worker = async () => {
            while (myRun === runRef.current && !controller.signal.aborted) {
              const i = cursor.i++
              if (i >= target) return
              if (bodiesRef.current[i] !== undefined) continue
              const entry = state.entries[i]
              if (!entry || typeof entry.file !== 'string' || entry.file === '') {
                bodiesRef.current[i] = null
                bump((x) => x + 1)
                continue
              }
              try {
                const body = await readFileText(archivePath + '/summaries/' + entry.file, controller.signal)
                if (myRun !== runRef.current || controller.signal.aborted) return
                bodiesRef.current[i] = body
              } catch (error) {
                if (controller.signal.aborted || myRun !== runRef.current) return
                bodiesRef.current[i] = null
              }
              bump((x) => x + 1)
            }
          }
          const workers = []
          for (let w = 0; w < SUMMARY_CONCURRENCY; w++) workers.push(worker())
          return () => { controller.abort() }
        }, [state.status, state.entries, limit, archivePath])

        const renderPiece = (i, entry, body) => {
          const superseded = typeof entry.supersededBy === 'string' && entry.supersededBy !== ''
          const head = '第 ' + String(entry.fromFloor != null ? entry.fromFloor : '?') + '–' + String(entry.toFloor != null ? entry.toFloor : '?') + ' 楼'
            + (typeof entry.chars === 'number' ? ' · ' + entry.chars + ' 字' : '')
            + (entry.createdAt ? ' · ' + formatTime(entry.createdAt) : '')
          return e('div', { key: 'p' + i, style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            e('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', borderBottom: '1px solid color-mix(in srgb, CanvasText 15%, transparent)', paddingBottom: 4 } },
              e('span', { style: { fontWeight: 700, fontSize: 12 }, title: String(entry.id || '') + (entry.model ? ' · ' + entry.model : '') }, head),
              superseded ? e('span', { style: dimBadgeStyle, title: '新条目：' + String(entry.supersededBy) }, '已更新') : null,
              entry.partial ? e('span', { style: dimBadgeStyle }, '部分覆盖') : null,
              e('span', { style: { flex: 1 } }),
              e(CopyBtn, { value: typeof body === 'string' ? body : '', label: '复制本篇' }),
            ),
            typeof body === 'string' ? e('pre', { style: flowPreStyle }, body)
              : body === null ? e('div', { style: errorStyle }, '本篇正文读取失败')
                : e('div', { style: dimStyle }, '正文加载中…'),
          )
        }

        const q = filter.trim().toLowerCase()
        const shownTotal = Math.min(limit, state.entries.length)
        const pieces = []
        let loadedCount = 0
        for (let i = 0; i < shownTotal; i++) {
          if (typeof bodiesRef.current[i] === 'string') loadedCount++
          const entry = state.entries[i]
          if (!entry) continue
          const body = bodiesRef.current[i]
          if (q !== '') {
            const inId = String(entry.id || '').toLowerCase().indexOf(q) !== -1
            const inBody = typeof body === 'string' && body.toLowerCase().indexOf(q) !== -1
            if (!inId && !inBody) continue
          }
          pieces.push(renderPiece(i, entry, body))
        }

        return e('div', { style: colFillStyle },
          e('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', flex: 'none' } },
            e('input', {
              id: 'dma-summary-filter', name: 'dma-summary-filter',
              'aria-label': '按 id 或摘要正文过滤已加载摘要',
              style: Object.assign({}, inputStyle, { flex: 1, minWidth: 160 }),
              placeholder: '过滤：id 或摘要正文（子串，只作用于已加载正文）…',
              value: filter, onChange: (ev) => setFilter(ev.target.value),
            }),
            e('span', { style: dimStyle },
              '共 ' + state.entries.length + ' 篇 · 显示 ' + pieces.length + ' 篇 · 正文已加载 ' + loadedCount + '/' + shownTotal),
          ),
          state.status === 'loading' && e('div', { style: dimStyle }, '正在读取摘要索引…'),
          state.status === 'idle' && e('div', { style: dimStyle }, '（等待归档）'),
          state.status === 'error' && e('div', { style: errorStyle }, '摘要索引读取失败：' + state.error),
          e('div', Object.assign({}, scrollBind), pieces,
            state.status === 'ready' && shownTotal < state.entries.length
              ? e('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flex: 'none', paddingBottom: 6 } },
                e('button', { style: btnStyle, onClick: () => setLimit(limit + SUMMARY_MORE_STEP) }, '加载后 20 篇'),
                e('span', { style: dimStyle }, '还有 ' + (state.entries.length - shownTotal) + ' 篇未加载'),
              )
              : null),
        )
      }

      // ---------- 阅读源·原文（工作区）：一次列举楼号上限，顺序懒加载（一次一个文件，最多预取 1 个） ----------
      function FloorsFlow({ archivePath, scrollBind, reportLoad }) {
        const store = React.useRef({ archivePath: null, nums: [], numSet: null, vis: {}, loaded: {}, max: -1, busy: false })
        const [ui, setUi] = React.useState({ metaStatus: 'loading', metaNote: '', floorErr: '', loadingMsg: '', cursor: 0, input: '0' })
        const [, bump] = React.useState(0)
        const ctlRef = React.useRef(null)
        const anchors = React.useRef({})

        async function ensureUpTo(target) {
          const st = store.current
          const controller = ctlRef.current
          if (!controller || st.busy) return
          st.busy = true
          try {
            for (let n = st.max + 1; n <= target; n++) {
              if (controller.signal.aborted) return
              if (!st.numSet || !st.numSet.has(n)) continue
              setUi((s) => ({ ...s, loadingMsg: '正在加载第 ' + n + ' 楼…', floorErr: '' }))
              const raw = await readFileText(st.archivePath + '/floors/' + pad4(n) + '.json', controller.signal)
              const parsed = parseJsonOr(raw, '楼层文件不是合法 JSON')
              if (controller.signal.aborted) return
              st.loaded[n] = parsed
              st.max = n
              bump((x) => x + 1)
            }
          } catch (error) {
            if (!controller.signal.aborted) setUi((s) => ({ ...s, floorErr: errText(error) }))
          } finally {
            st.busy = false
            if (!controller.signal.aborted) setUi((s) => ({ ...s, loadingMsg: '' }))
          }
        }

        React.useEffect(() => {
          const controller = new AbortController()
          ctlRef.current = controller
          store.current = { archivePath: archivePath, nums: [], numSet: null, vis: {}, loaded: {}, max: -1, busy: false }
          anchors.current = {}
          setUi({ metaStatus: 'loading', metaNote: '', floorErr: '', loadingMsg: '', cursor: 0, input: '0' })
          if (!archivePath) { setUi({ metaStatus: 'idle', metaNote: '', floorErr: '', loadingMsg: '', cursor: 0, input: '0' }); return }
          ;(async () => {
            const signal = controller.signal
            // 楼号上限：一次 ?list= 目录列举（唯一允许的目录列举）；失败退 visibility.json 键数量，再失败为 0
            let nums = []
            let note = ''
            try {
              const entries = await listDir(archivePath + '/floors', signal)
              if (signal.aborted) return
              nums = entries
                .filter((en) => en.type === 'file')
                .map((en) => { const m = /^(\d+)\.json$/i.exec(en.name); return m ? parseInt(m[1], 10) : -1 })
                .filter((n) => n >= 0)
            } catch (error) {
              if (signal.aborted) return
              note = 'floors 目录列举失败（' + errText(error) + '），退回 visibility.json 的楼号表'
            }
            let vis = {}
            try {
              const rawVis = await readFileText(archivePath + '/visibility.json', signal)
              const parsedVis = parseJsonOr(rawVis, 'visibility.json 不是合法 JSON')
              if (signal.aborted) return
              vis = parsedVis && typeof parsedVis.floors === 'object' && parsedVis.floors ? parsedVis.floors : {}
              if (nums.length === 0) {
                nums = Object.keys(vis).map((k) => parseInt(k, 10)).filter((n) => Number.isFinite(n) && n >= 0)
                if (note === '') note = 'floors 目录列举不可用，楼号上限来自 visibility.json'
              }
            } catch (error) {
              if (signal.aborted) return
              if (note === '') note = 'visibility.json 读不到（楼层不标「未发给模型」）：' + errText(error)
            }
            nums.sort((a, b) => a - b)
            const st = store.current
            st.nums = nums
            st.numSet = new Set(nums)
            st.vis = vis
            setUi((s) => ({ ...s, metaStatus: 'ready', metaNote: note }))
            if (nums.length === 0) {
              setUi((s) => ({ ...s, metaStatus: 'error', metaNote: 'floors 目录与 visibility.json 都拿不到楼号' }))
              reportLoad(false, 'floors 目录与 visibility.json 都拿不到楼号')
              return
            }
            await ensureUpTo(nums[0])
          })().catch((error) => {
            if (controller.signal.aborted) return
            setUi((s) => ({ ...s, metaStatus: 'error', metaNote: errText(error) }))
            reportLoad(false, errText(error))
          })
          return () => { controller.abort(); ctlRef.current = null }
        }, [archivePath])

        const jumpTo = (n) => {
          const st = store.current
          if (!Number.isFinite(n) || n < 0) { setUi((s) => ({ ...s, floorErr: '楼号要是 ≥0 的数字' })); return }
          if (!st.numSet || !st.numSet.has(n)) {
            const range = st.nums.length ? st.nums[0] + '–' + st.nums[st.nums.length - 1] : '无'
            setUi((s) => ({ ...s, floorErr: '没有第 ' + n + ' 楼（可用范围：' + range + '）' }))
            return
          }
          setUi((s) => ({ ...s, cursor: n, input: String(n), floorErr: '' }))
          const controller = ctlRef.current
          ;(async () => {
            await ensureUpTo(n)
            if (controller && controller.signal.aborted) return
            setTimeout(() => {
              const el = anchors.current[n]
              if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start' })
            }, 60)
          })()
        }

        const maybeLoadNext = () => {
          const st = store.current
          const el = scrollBind && scrollBind.ref ? scrollBind.ref.current : null
          if (!el) return
          // 只在内容真的溢出、且滚到接近底部时续读（内容不满一屏时用「下一楼」按钮，防连锁拉全量）
          if (el.scrollHeight <= el.clientHeight + 4) return
          if (el.scrollTop + el.clientHeight < el.scrollHeight - SCROLL_BOTTOM_MARGIN) return
          const next = st.nums.find((n) => n > st.max)
          if (next !== undefined) ensureUpTo(next)
        }

        const onScroll = () => maybeLoadNext()

        const step = (delta) => {
          const st = store.current
          if (st.nums.length === 0) return
          let i = st.nums.indexOf(ui.cursor)
          if (i === -1) i = 0
          i = Math.max(0, Math.min(st.nums.length - 1, i + delta))
          jumpTo(st.nums[i])
        }

        const st = store.current
        const first = st.nums.length > 0 ? st.nums[0] : undefined
        const last = st.nums.length > 0 ? st.nums[st.nums.length - 1] : undefined
        const blocks = []
        for (const n of st.nums) {
          if (n > st.max) break
          const data = st.loaded[n]
          if (!data) continue
          const role = String(data._role || (data.is_user ? 'user' : 'assistant'))
          const vRec = st.vis[n]
          const notSent = !!(vRec && vRec.sent === false)
          blocks.push(e('div', { key: 'f' + n, ref: (el) => { anchors.current[n] = el }, style: { display: 'flex', flexDirection: 'column', gap: 4, flex: 'none' } },
            e('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', borderBottom: '1px solid color-mix(in srgb, CanvasText 15%, transparent)', paddingBottom: 4 } },
              e('span', { style: { fontWeight: 700, fontSize: 12 } }, '第 ' + n + ' 楼'),
              e('span', { style: { fontSize: 12, opacity: 0.8 } }, role),
              data.name ? e('span', { style: { fontSize: 12, opacity: 0.8 } }, String(data.name)) : null,
              data.send_date ? e('span', { style: { fontSize: 11, opacity: 0.6 } }, formatTime(data.send_date)) : null,
              notSent ? e('span', { style: { fontSize: 11, color: 'darkorange', fontWeight: 700 } }, '未发给模型') : null,
            ),
            typeof data.mes === 'string'
              ? e('pre', { style: flowPreStyle }, data.mes)
              : e('div', { style: dimStyle }, '（该楼层没有 mes 字段）'),
          ))
        }
        const loadedCount = Object.keys(st.loaded).length

        return e('div', { style: colFillStyle },
          // 常驻工具条（在阅读区之上，不随滚动消失）
          e('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', flex: 'none' } },
            e('input', {
              id: 'dma-floor-jump', name: 'dma-floor-jump',
              'aria-label': '输入楼号，回车跳到该楼',
              style: Object.assign({}, inputStyle, { width: 80 }),
              value: ui.input, placeholder: '楼号',
              onChange: (ev) => setUi((s) => ({ ...s, input: ev.target.value })),
              onKeyDown: (ev) => { if (ev.key === 'Enter') jumpTo(parseInt(ui.input, 10)) },
            }),
            e('button', { style: btnStyle, onClick: () => jumpTo(parseInt(ui.input, 10)) }, '跳到楼号'),
            e('button', { style: btnStyle, disabled: first === undefined, onClick: () => jumpTo(first) }, '首楼'),
            e('button', { style: btnStyle, disabled: last === undefined, onClick: () => jumpTo(last) }, '末楼'),
            e('button', { style: btnStyle, disabled: st.nums.length === 0, onClick: () => step(-1) }, '← 上一楼'),
            e('button', { style: btnStyle, disabled: st.nums.length === 0, onClick: () => step(1) }, '下一楼 →'),
            e('span', { style: dimStyle },
              '已加载 ' + loadedCount + '/' + st.nums.length + ' 楼' + (ui.loadingMsg ? ' · ' + ui.loadingMsg : '')),
          ),
          ui.metaStatus === 'loading' && e('div', { style: dimStyle }, '正在读取 floors 目录…'),
          ui.metaStatus === 'idle' && e('div', { style: dimStyle }, '（等待归档）'),
          ui.metaStatus === 'error' && e('div', { style: errorStyle }, '楼号目录读取失败：' + ui.metaNote),
          ui.metaNote && ui.metaStatus === 'ready' ? e('div', { style: dimStyle }, ui.metaNote) : null,
          ui.floorErr ? e('div', { style: errorStyle }, ui.floorErr) : null,
          st.nums.length === 0 && ui.metaStatus === 'ready'
            ? e('div', { style: dimStyle }, '该归档没有楼层文件') : null,
          e('div', Object.assign({}, scrollBind, { onScroll: onScroll }), blocks),
        )
      }

      // ---------- 阅读源·状态（工作区）：state/current.json 美化展示（v3 逻辑原样保留） ----------
      function StateFlow({ archivePath, scrollBind }) {
        const [state, setState] = React.useState({ status: 'loading', text: '', error: '' })
        React.useEffect(() => {
          const controller = new AbortController()
          setState({ status: 'loading', text: '', error: '' })
          if (!archivePath) { setState({ status: 'idle', text: '', error: '' }); return }
          ;(async () => {
            const raw = await readFileText(archivePath + '/state/current.json', controller.signal)
            const parsed = parseJsonOr(raw, 'state/current.json 不是合法 JSON')
            if (controller.signal.aborted) return
            setState({ status: 'ready', text: JSON.stringify(parsed, null, 2), error: '' })
          })().catch((error) => {
            if (controller.signal.aborted) return
            setState({ status: 'error', text: '', error: errText(error) })
          })
          return () => controller.abort()
        }, [archivePath])
        return e('div', { style: colFillStyle },
          state.status === 'loading' && e('div', { style: dimStyle }, '正在读取 state/current.json…'),
          state.status === 'idle' && e('div', { style: dimStyle }, '（等待归档）'),
          state.status === 'error' && e('div', { style: errorStyle }, '读取失败：' + state.error),
          state.status === 'ready'
            ? e('div', Object.assign({}, scrollBind), e('pre', { style: flowPreStyle }, state.text))
            : null,
        )
      }

      // ---------- 阅读源·会话事件（会话模式）：limit=200 连续追加，滚到底自动取下一页 ----------
      function EventsFlow({ sessionId, nameIdx, scrollBind, reportLoad }) {
        const [state, setState] = React.useState({ status: 'loading', events: [], total: 0, error: '' })
        const [filter, setFilter] = React.useState('')
        const [openSeq, setOpenSeq] = React.useState(null)
        const ctlRef = React.useRef(null)
        const busyRef = React.useRef(false)

        React.useEffect(() => {
          const controller = new AbortController()
          ctlRef.current = controller
          setState({ status: 'loading', events: [], total: 0, error: '' })
          ;(async () => {
            const url = HOST_API_BASE + '/session/events?sessionId=' + encodeURIComponent(sessionId)
              + '&limit=' + EVENT_PAGE_SIZE + '&offset=0'
            const data = await requestJson(url, controller.signal)
            if (controller.signal.aborted) return
            setState({
              status: 'ready',
              events: Array.isArray(data.events) ? data.events : [],
              total: typeof data.total === 'number' ? data.total : 0,
              error: '',
            })
          })().catch((error) => {
            if (controller.signal.aborted) return
            setState({ status: 'error', events: [], total: 0, error: errText(error) })
            reportLoad(false, errText(error))
          })
          return () => { controller.abort(); ctlRef.current = null }
        }, [sessionId])

        React.useEffect(() => {
          if (state.status === 'ready' && state.events.length === 0) reportLoad(false, '该会话没有事件')
        }, [state.status, state.events.length])

        const loadMore = () => {
          const controller = ctlRef.current
          if (!controller || busyRef.current || state.status !== 'ready') return
          if (state.total > 0 && state.events.length >= state.total) return
          busyRef.current = true
          const offset = state.events.length
          ;(async () => {
            const url = HOST_API_BASE + '/session/events?sessionId=' + encodeURIComponent(sessionId)
              + '&limit=' + EVENT_PAGE_SIZE + '&offset=' + String(offset)
            const data = await requestJson(url, controller.signal)
            if (controller.signal.aborted) return
            const seen = {}
            state.events.forEach((ev) => { if (ev && typeof ev.seq === 'number') seen[ev.seq] = true })
            const fresh = (Array.isArray(data.events) ? data.events : [])
              .filter((ev) => !(ev && typeof ev.seq === 'number' && seen[ev.seq]))
            setState((s) => ({
              ...s, status: 'ready', events: s.events.concat(fresh),
              total: typeof data.total === 'number' ? data.total : s.total, error: '',
            }))
          })().catch((error) => {
            if (controller.signal.aborted) return
            setState((s) => ({ ...s, error: errText(error) }))
          }).finally(() => { busyRef.current = false })
        }

        const onScroll = () => {
          const el = scrollBind && scrollBind.ref ? scrollBind.ref.current : null
          if (!el) return
          if (el.scrollHeight > el.clientHeight + 4
            && el.scrollTop + el.clientHeight >= el.scrollHeight - SCROLL_BOTTOM_MARGIN) loadMore()
        }

        const ls = labelSession({ sessionId: sessionId, title: null }, nameIdx)
        const badge = sourceBadge(ls.source)
        const q = filter.trim().toLowerCase()
        const visible = q === ''
          ? state.events
          : state.events.filter((ev) => {
            const hay = (String((ev && ev.text) || '') + '\n' + String((ev && ev.role) || '') + '\n' + String((ev && ev.type) || '')).toLowerCase()
            return hay.indexOf(q) !== -1
          })

        return e('div', { style: colFillStyle },
          e('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', flex: 'none' } },
            e('input', {
              id: 'dma-event-filter', name: 'dma-event-filter',
              'aria-label': '按正文/角色/类型过滤已加载行',
              style: Object.assign({}, inputStyle, { flex: 1, minWidth: 160 }),
              placeholder: '前端过滤：正文/角色/类型 子串（只作用于已加载行）…',
              value: filter, onChange: (ev) => setFilter(ev.target.value),
            }),
            e('button', {
              style: btnStyle,
              disabled: state.status !== 'ready' || (state.total > 0 && state.events.length >= state.total),
              onClick: loadMore,
            }, '加载更多'),
            e('span', { style: dimStyle },
              state.total > 0 ? '已加载 ' + state.events.length + ' / ' + state.total + ' 条' : ''),
          ),
          e('div', { style: { display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap', flex: 'none' } },
            e('span', { style: { fontSize: 12, fontWeight: 700 } }, '会话事件 · ' + ls.text),
            badge ? e('span', { style: dimBadgeStyle, title: badge.title }, badge.text) : null,
            e(CopyBtn, { value: sessionId, label: '复制会话 ID' }),
          ),
          state.status === 'loading' && e('div', { style: { fontSize: 12, opacity: 0.85 } },
            '正在加载会话事件…（较大的会话首次加载可能需要约 8 秒，请稍候）'),
          state.status === 'error' && e('div', { style: errorStyle }, '会话事件读取失败：' + state.error),
          state.status === 'ready' && state.events.length === 0 && e('div', { style: dimStyle }, '该会话没有事件'),
          state.status === 'ready' && state.events.length > 0 && visible.length === 0 && e('div', { style: dimStyle }, '没有匹配过滤条件的行'),
          e('div', Object.assign({}, scrollBind, { onScroll: onScroll }),
            visible.map((ev, i) => {
              const seq = ev && typeof ev.seq === 'number' ? ev.seq : null
              const open = seq !== null && openSeq === seq
              return e('div', {
                key: seq !== null ? String(seq) : 'i' + String(i),
                style: itemStyle,
                onClick: () => { if (seq !== null) setOpenSeq(open ? null : seq) },
              },
                e('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 12 } },
                  e('span', { style: { fontFamily: MONO, opacity: 0.65 } }, seq !== null ? '#' + String(seq) : '#?'),
                  e('span', { style: { fontWeight: 700 } }, String((ev && ev.role) || '?')),
                  e('span', { style: { opacity: 0.6, fontSize: 11 } }, formatTime(ev && ev.time)),
                  e('span', { style: { opacity: 0.6, fontSize: 11 } }, String((ev && ev.type) || '')),
                  e(SurfaceBadge, { surface: ev ? ev.surface : null }),
                ),
                open && e('pre', { style: flowPreStyle }, String((ev && ev.text) || '')),
              )
            })),
        )
      }

      // ---------- 阅读源·会话搜索（与根模式无关，走平台 ctx.get('sessions').search；行名过 labelSession） ----------
      function SearchFlow({ sessions, nameIdx, onClose, scrollBind }) {
        const [query, setQuery] = React.useState('')
        const [state, setState] = React.useState({ status: 'idle', items: [], hasMore: false, message: '' })

        React.useEffect(() => {
          const q = query.trim()
          if (q === '') { setState({ status: 'idle', items: [], hasMore: false, message: '' }); return }
          const controller = new AbortController()
          setState((s) => ({ ...s, status: 'loading' }))
          // 去抖 300ms；AbortController 取消上一次（与原生侧边栏搜索同款）
          const timer = setTimeout(() => {
            sessions.search(q, controller.signal).then((result) => {
              if (controller.signal.aborted) return
              if (result.ok) {
                setState({ status: 'ready', items: result.value.items, hasMore: result.value.hasMore, message: '' })
              } else {
                setState({ status: 'error', items: [], hasMore: false, message: (result.error && result.error.message) || '搜索失败' })
              }
            }).catch((error) => {
              if (controller.signal.aborted) return
              setState({ status: 'error', items: [], hasMore: false, message: String((error && error.message) || error) })
            })
          }, 300)
          return () => { clearTimeout(timer); controller.abort() }
        }, [query, sessions])

        const openSession = (sessionId) => { sessions.open(sessionId); if (onClose) onClose() }

        return e('div', { style: colFillStyle },
          e('input', {
            id: 'dma-session-search', name: 'dma-session-search',
            'aria-label': '搜索历史会话正文',
            style: inputStyle, autoFocus: true, placeholder: '搜索历史会话正文…（中文需 ≥3 字）',
            value: query, onChange: (ev) => setQuery(ev.target.value),
          }),
          state.status === 'loading' && e('div', { style: { fontSize: 12, opacity: 0.7 } }, '正在搜索会话历史…'),
          state.status === 'error' && e('div', { style: errorStyle }, '搜索失败：' + state.message),
          state.status === 'ready' && state.items.length === 0 && e('div', { style: { fontSize: 12, opacity: 0.7 } },
            '无结果（提示：中文查询需 ≥3 字；2 字词在索引里命中必为 0）'),
          e('div', Object.assign({}, scrollBind),
            state.items.map((item) => {
              const sid = String((item && item.sessionId) || '')
              const ls = labelSession({
                sessionId: sid,
                title: item && typeof item.title === 'string' ? item.title : null,
              }, nameIdx)
              const badge = sourceBadge(ls.source)
              return e('div', { key: sid, style: itemStyle, onClick: () => openSession(sid), title: sid },
                e('div', { style: { display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' } },
                  e('span', { style: { fontWeight: 700, fontSize: 12 } }, ls.text),
                  badge ? e('span', { style: dimBadgeStyle, title: badge.title }, badge.text) : null,
                  e(CopyBtn, { value: sid, label: '复制会话 ID' }),
                ),
                e('div', { style: { opacity: 0.85, fontSize: 12 } }, String((item && item.snippet) || '')),
              )
            })),
          state.status === 'ready' && state.hasMore && e('div', { style: { fontSize: 11, opacity: 0.6 } },
            '结果未完（上限 ' + String(sessions.searchResultLimit) + ' 条），请把关键词写具体些'),
        )
      }

      // ---------- 阅读区：源 tabs（只显示可用的）+ 默认源自适应 + 连续滚动区 + 键盘 ----------
      function computeSources(mode, tavernOk, eventsSessionId) {
        if (mode === 'session') {
          const list = []
          if (eventsSessionId) list.push(['events', '会话事件'])
          list.push(['search', '会话搜索'])
          return list
        }
        if (!tavernOk) {
          // Tavern 不可达：工作区归档读不到；若拿得到根会话 ID（目录缓存/manifest），退到会话事件
          const list = []
          if (eventsSessionId) list.push(['events', '会话事件'])
          list.push(['search', '会话搜索'])
          return list
        }
        return [['summaries', '摘要'], ['floors', '原文'], ['state', '状态'], ['search', '会话搜索']]
      }

      function readKeyDown(ev, scrollRef, esc) {
        if (ev.key === 'Escape') { ev.preventDefault(); esc(); return }
        if (ev.ctrlKey || ev.metaKey || ev.altKey) return
        const t = ev.target
        if (t && t !== scrollRef.current && t.tagName && /INPUT|TEXTAREA|SELECT/.test(t.tagName)) return
        const el = scrollRef.current
        if (!el) return
        const page = Math.max(120, el.clientHeight * 0.85)
        if (ev.key === 'PageDown') { el.scrollBy({ top: page }); ev.preventDefault() }
        else if (ev.key === 'PageUp') { el.scrollBy({ top: -page }); ev.preventDefault() }
        else if (ev.key === ' ') { el.scrollBy({ top: ev.shiftKey ? -page : page }); ev.preventDefault() }
        else if (ev.key === 'Home') { el.scrollTop = 0; ev.preventDefault() }
        else if (ev.key === 'End') { el.scrollTop = el.scrollHeight; ev.preventDefault() }
      }

      function ReadArea({ mode, tavernOk, healthStatus, archivePath, eventsSessionId, nameIdx, catalogError, sessions, onClose, fullscreen, setFullscreen }) {
        const [active, setActive] = React.useState(null)
        const [notice, setNotice] = React.useState('')
        const scrollRef = React.useRef(null)
        const fallen = React.useRef({ done: false })

        const sources = computeSources(mode, tavernOk, eventsSessionId)
        const defaultKey = sources.length > 0 ? sources[0][0] : null
        const cur = active && sources.some((s) => s[0] === active) ? active : defaultKey

        const esc = () => { if (fullscreen) setFullscreen(false); else onClose() }
        const scrollBind = {
          ref: scrollRef, tabIndex: 0, style: readScrollStyle,
          onKeyDown: (ev) => readKeyDown(ev, scrollRef, esc),
        }

        // 默认源没有数据 ⇒ 自动退到下一个可用源，并在顶部说明（只退一次；手动选择不触发）
        const makeReport = (key) => (ok, reason) => {
          if (ok || fallen.current.done || key !== defaultKey) return
          fallen.current.done = true
          const i = sources.findIndex((s) => s[0] === key)
          const next = sources[i + 1]
          if (next) {
            setNotice('默认源「' + sources[i][1] + '」没有数据（' + String(reason || '未知原因') + '）· 已切到「' + next[1] + '」')
            setActive(next[0])
          } else {
            setNotice('默认源「' + sources[i][1] + '」没有数据：' + String(reason || '未知原因'))
          }
        }

        const banners = []
        if (mode === 'workspace' && !tavernOk) {
          banners.push(e('div', { key: 'tav', style: errorStyle },
            'Tavern（pmp-dsh-tavern）不可达：工作区归档（摘要/原文/状态）读不到。'
            + (eventsSessionId ? '已退到根会话的「会话事件」。' : '根会话 ID 也拿不到，只剩「会话搜索」。')))
        }
        if (healthStatus === 'error' && mode === 'workspace') {
          banners.push(e('div', { key: 'host', style: dimStyle },
            '宿主 API 不可用：已按工作区模式阅读（不依赖宿主）；配置功能见 ⚙ 设置。'))
        }
        if (mode === 'session' && !eventsSessionId) {
          banners.push(e('div', { key: 'noroot', style: errorStyle }, '尚未选择根会话：请到 ⚙ 设置里选择。'))
        }
        if (catalogError) {
          banners.push(e('div', { key: 'cat', style: errorStyle }, '名字目录（catalog.json）不可读，名字退回短 ID：' + catalogError))
        }

        let content
        if (cur === 'summaries') {
          content = e(SummariesFlow, { archivePath: archivePath, scrollBind: scrollBind, reportLoad: makeReport('summaries') })
        } else if (cur === 'floors') {
          content = e(FloorsFlow, { archivePath: archivePath, scrollBind: scrollBind, reportLoad: makeReport('floors') })
        } else if (cur === 'state') {
          content = e(StateFlow, { archivePath: archivePath, scrollBind: scrollBind })
        } else if (cur === 'events') {
          content = e(EventsFlow, { sessionId: eventsSessionId, nameIdx: nameIdx, scrollBind: scrollBind, reportLoad: makeReport('events') })
        } else {
          content = e(SearchFlow, { sessions: sessions, nameIdx: nameIdx, onClose: onClose, scrollBind: scrollBind })
        }

        return e('div', { style: colFillStyle },
          e('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', flex: 'none', alignItems: 'center' } },
            e('span', { style: dimStyle }, '阅读源：'),
            sources.map((pair) => e('button', {
              key: pair[0],
              style: Object.assign({}, btnStyle, { opacity: cur === pair[0] ? 1 : 0.55, fontWeight: cur === pair[0] ? 700 : 400 }),
              onClick: () => setActive(pair[0]),
            }, pair[1]))),
          banners,
          notice ? e('div', { style: { fontSize: 12, color: 'darkorange' } }, notice) : null,
          e('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } }, content),
        )
      }

      // =====================================================================
      // 提示词区（v4 第二单）：三子页 —— 每次请求 / 压缩指令 / 收纳占位
      // =====================================================================
      const PART_TABS = [['system', 'system'], ['tools', 'tools'], ['inventory', 'inventory'], ['messages', '消息流']]
      const HIGHLIGHT_LIMIT = 2000   // 高亮命中上限：超大文本 + 高频词时避免渲染出几十万节点

      // P0 内存修复：宿主 /api/sessions/resolve 对每个 id 都走完整解析（与点开看详情同一条路径），
      // 实测单会话解析在宿主堆里瞬时驻留 126~186MB；整表全补（真机 73 个会话）会把宿主推向 OOM。
      const TITLE_FILL_CAP = 20     // 空闲补标题硬上限：每次进入子页/刷新列表后最多 resolve 这么多个，超出的行保持「无标题」降级显示
      const TITLE_FILL_BATCH = 10   // 每批请求的 id 数（沿用原 ≤10 的节流）

      function formatBytes(n) {
        return Number.isFinite(n) ? Math.round(n / 1024) + ' KB' : ''
      }

      // 在已加载文本里做子串高亮（大小写不敏感，纯前端）
      function highlight(text, query) {
        const q = String(query == null ? '' : query).trim()
        if (q === '' || typeof text !== 'string') return text
        const lower = text.toLowerCase()
        const needle = q.toLowerCase()
        const out = []
        let from = 0
        for (;;) {
          const i = lower.indexOf(needle, from)
          if (i < 0) { out.push(text.slice(from)); break }
          if (i > from) out.push(text.slice(from, i))
          out.push(e('mark', { key: out.length, style: markStyle }, text.slice(i, i + needle.length)))
          from = i + needle.length
          if (out.length / 2 >= HIGHLIGHT_LIMIT) {
            out.push('…（高亮命中超过 ' + HIGHLIGHT_LIMIT + ' 处，余下部分未标色）' + text.slice(from))
            break
          }
        }
        return out
      }

      // requests < 0 是宿主半侧的「尚未解析」哨兵（title:'' 同理）；0 是「解析过、确实没有请求」的真值
      function isUnparsed(s) {
        return !!(s && typeof s.requests === 'number' && s.requests < 0)
      }

      // ---------- 子页 A·左栏：会话列表（首刷只扫目录；标题过 labelSession 三级回退） ----------
      function PromptSessionList({ state, selectedId, onSelect, onRefresh, nameIdx }) {
        const [filter, setFilter] = React.useState('')
        const q = filter.trim().toLowerCase()
        const rowLabel = (s) => labelSession({
          sessionId: s.id,
          title: isUnparsed(s) || typeof s.title !== 'string' || s.title === '' ? null : s.title,
        }, nameIdx)
        const items = state.items.filter((s) =>
          q === '' || (String(s.title) + ' ' + String(s.id) + ' ' + String(s.workspace)).toLowerCase().indexOf(q) !== -1)
        return e('div', { style: colSessionStyle },
          e('div', { style: { display: 'flex', gap: 4 } },
            e('input', {
              id: 'dma-prompt-session-filter', name: 'dma-prompt-session-filter',
              'aria-label': '按标题/id/工作区过滤会话列表',
              style: Object.assign({}, inputStyle, { flex: 1, minWidth: 0 }), placeholder: '过滤：标题 / id / 工作区',
              value: filter, onChange: (ev) => setFilter(ev.target.value),
            }),
            e('button', { style: btnStyle, title: '重新扫描会话列表', onClick: onRefresh }, '↻')),
          state.status === 'loading' && e('div', { style: dimStyle }, '正在扫描会话列表…'),
          state.status === 'error' && e('div', { style: errorStyle }, '会话列表加载失败：' + state.error),
          state.status === 'ready' && e('div', { style: dimStyle },
            '共 ' + state.items.length + ' 个 · 命中 ' + items.length + ' 个'),
          e('div', { style: promptListStyle },
            items.map((s) => {
              const ls = rowLabel(s)
              return e('div', {
                key: s.id,
                style: Object.assign({}, itemStyle, s.id === selectedId ? selectedStyle : null),
                onClick: () => onSelect(s.id),
                title: String(s.id) + ' · ' + String(s.workspace),
              },
                e('div', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  highlight(ls.text, filter)),
                e('div', { style: { display: 'flex', gap: 6, opacity: 0.5, fontSize: 11 } },
                  e('span', null, formatTime(s.mtime)),
                  e('span', null, formatBytes(s.sizeBytes)),
                  e('span', null, isUnparsed(s) ? '…' : String(s.requests) + ' 次请求')))
            })),
          state.status === 'ready' && items.length === 0 && e('div', { style: dimStyle }, '没有匹配的会话'),
        )
      }

      // ---------- 子页 A·中栏：该会话每一次模型请求的 composition 摘要 ----------
      function PromptRequestList({ detail, selectedTurn, onSelect }) {
        if (detail.status === 'idle') return e('div', { style: colTurnStyle }, e('div', { style: dimStyle }, '← 先选一个会话'))
        if (detail.status === 'loading') return e('div', { style: colTurnStyle }, e('div', { style: dimStyle }, '正在解析会话…'))
        if (detail.status === 'error') {
          return e('div', { style: colTurnStyle }, e('div', { style: errorStyle }, '会话解析失败：' + detail.error))
        }
        const meta = detail.meta || {}
        const presetNote = meta.effectivePreset && meta.effectivePreset !== meta.agentPreset ? '（中途切换，实际生效）' : ''
        return e('div', { style: colTurnStyle },
          e('div', { style: { fontSize: 11, opacity: 0.7, wordBreak: 'break-all' } },
            'preset: ' + (meta.effectivePreset || '-') + presetNote),
          e('div', { style: dimStyle },
            detail.requests.length === 0
              ? '★ 这个会话没有 request/header（没跑过模型请求）'
              : '共 ' + detail.requests.length + ' 次模型请求'),
          e('div', { style: promptListStyle },
            detail.requests.map((r) => e('div', {
              key: r.index,
              style: Object.assign({}, itemStyle, r.index === selectedTurn ? selectedStyle : null),
              onClick: () => onSelect(r.index),
              title: 'seq=' + r.seq + ' · ' + r.provider + '/' + r.model,
            },
              e('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 6 } },
                e('span', { style: { fontWeight: 700 } }, '#' + r.index + ' · ' + (r.reason || '?')),
                e('span', { style: { opacity: 0.6 } }, String(r.maxTokens == null ? '-' : r.maxTokens))),
              e('div', { style: { opacity: 0.75 } }, r.provider + '/' + r.model + ' · effort=' + (r.reasoningEffort || '-')),
              e('div', { style: { opacity: 0.75 } },
                'system ' + r.systemChars + ' 字 · tools ' + r.toolCount + ' 个 / ' + r.toolChars + ' 字'),
              (r.marks || []).length > 0 && e('div', { style: { opacity: 0.6, fontSize: 11 } }, '检出: ' + r.marks.join('  ')),
            ))),
        )
      }

      // ---------- 子页 A·右栏：tools 列表 / inventory 分组 / 部件 tabs + 搜索高亮 + 复制 ----------
      function PromptToolsListView({ tools, query }) {
        return e('div', { style: promptListStyle },
          tools.map((t) => e('div', { key: t.name, style: toolRowStyle },
            e('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              highlight(t.name, query)),
            e('span', { style: { opacity: 0.6, flexShrink: 0 } }, String(t.chars) + ' 字'))),
        )
      }

      function groupToolsByPrefix(tools) {
        const groups = new Map()
        for (const t of tools) {
          const i = t.name.indexOf('__')
          const prefix = i >= 0 ? t.name.slice(0, i + 2) + '*' : t.name
          const g = groups.get(prefix) || { prefix: prefix, count: 0, chars: 0, names: [] }
          g.count += 1
          g.chars += t.chars
          g.names.push(t.name)
          groups.set(prefix, g)
        }
        return Array.from(groups.values()).sort((a, b) => b.chars - a.chars)
      }

      function PromptInventoryView({ tools, query }) {
        const [expanded, setExpanded] = React.useState(() => new Set())
        const groups = groupToolsByPrefix(tools)
        const totalChars = tools.reduce((n, t) => n + t.chars, 0)
        const toggle = (prefix) => setExpanded((prev) => {
          const next = new Set(prev)
          if (next.has(prefix)) next.delete(prefix)
          else next.add(prefix)
          return next
        })
        return e('div', { style: promptListStyle },
          e('div', { style: dimStyle }, '合计 ' + tools.length + ' 个 / ' + totalChars + ' 字 · 点分组展开看名字'),
          groups.map((g) => {
            const pct = totalChars > 0 ? Math.round((g.chars / totalChars) * 100) : 0
            const open = expanded.has(g.prefix)
            return e('div', { key: g.prefix, style: Object.assign({}, itemStyle, { cursor: 'pointer' }), onClick: () => toggle(g.prefix) },
              e('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } },
                e('span', { style: { fontWeight: 700 } }, highlight(g.prefix, query)),
                e('span', { style: { opacity: 0.6, flexShrink: 0 } },
                  g.count + ' 个 / ' + g.chars + ' 字 / ' + pct + '%')),
              open && e('div', { style: { marginTop: 4, opacity: 0.75, fontSize: 11, wordBreak: 'break-all' } },
                g.names.length <= 12
                  ? g.names.join(', ')
                  : g.names.slice(0, 10).join(', ') + ', …（共 ' + g.names.length + ' 个）'),
            )
          }),
        )
      }

      function PromptPartView({ sessionId, turn, part, setPart, state, query, setQuery, onCopy }) {
        if (!sessionId || !turn) {
          return e('div', { style: colPartStyle }, e('div', { style: dimStyle }, '← 再选一次请求（第 N 次）'))
        }
        const text = state.status === 'ready' && state.data && typeof state.data.text === 'string' ? state.data.text : null
        const tools = state.status === 'ready' && state.data && Array.isArray(state.data.tools) ? state.data.tools : null
        return e('div', { style: colPartStyle },
          e('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' } },
            PART_TABS.map((pair) => e('button', {
              key: pair[0],
              style: Object.assign({}, btnStyle, { opacity: part === pair[0] ? 1 : 0.55, fontWeight: part === pair[0] ? 700 : 400 }),
              onClick: () => setPart(pair[0]),
            }, pair[1])),
            e('span', { style: { flex: 1 } }),
            e('button', { style: btnStyle, onClick: onCopy, title: '复制当前部件全文' }, '复制'),
          ),
          e('input', {
            id: 'dma-viewer-search', name: 'dma-viewer-search',
            'aria-label': '在当前请求已加载文本里搜索',
            style: inputStyle, placeholder: '在当前已加载文本里搜索（子串高亮，纯前端）…',
            value: query, onChange: (ev) => setQuery(ev.target.value),
          }),
          state.status === 'loading' && e('div', { style: dimStyle }, '正在加载 #' + turn + ' 的 ' + part + ' …'),
          state.status === 'error' && e('div', { style: errorStyle }, '加载失败：' + state.error),
          state.status === 'ready' && text !== null && e('pre', { style: promptPreStyle }, highlight(text, query)),
          state.status === 'ready' && tools !== null && (part === 'inventory'
            ? e(PromptInventoryView, { tools: tools, query: query })
            : e(PromptToolsListView, { tools: tools, query: query })),
          state.status === 'ready' && text === '' && e('div', { style: dimStyle }, '（该部件为空）'),
        )
      }

      // ---------- 子页 A 主体（吸收自 dsh-prompt-viewer 的内容区；外壳与席位一律不带进来） ----------
      function PerRequestView({ nameIdx }) {
        const [sessions, setSessions] = React.useState({ status: 'loading', items: [], error: null })
        const [sessionId, setSessionId] = React.useState('')
        const [detail, setDetail] = React.useState({ status: 'idle', meta: null, requests: [], error: null })
        const [turn, setTurn] = React.useState(0)
        const [part, setPart] = React.useState('system')
        const [partState, setPartState] = React.useState({ status: 'idle', data: null, error: null })
        const [query, setQuery] = React.useState('')
        const [note, setNote] = React.useState('')
        const [health, setHealth] = React.useState({ status: 'loading', n: null, error: '' })

        // 0) 数据面健康（尽力而为：失败只影响这一行，列表有自己的错误态）
        React.useEffect(() => {
          const controller = new AbortController()
          requestJson(PROMPT_API_BASE + '/health', controller.signal).then((data) => {
            if (controller.signal.aborted) return
            setHealth({ status: 'ready', n: typeof data.sessions === 'number' ? data.sessions : null, error: '' })
          }).catch((error) => {
            if (controller.signal.aborted) return
            setHealth({ status: 'error', n: null, error: errText(error) })
          })
          return () => controller.abort()
        }, [])

        // 1) 会话列表：首刷只扫目录不解析（title:'' / requests:-1 = 未解析哨兵）
        const sessionsAbort = React.useRef(null)
        const resolveSentRef = React.useRef(0)   // 本轮（进子页/刷新列表）已排程补标题的个数；到 TITLE_FILL_CAP 即停
        const loadSessions = React.useCallback((refresh) => {
          if (sessionsAbort.current) sessionsAbort.current.abort()
          resolveSentRef.current = 0   // 列表重新扫描 = 补标题预算重置一轮
          const controller = new AbortController()
          sessionsAbort.current = controller
          setSessions((s) => ({ ...s, status: 'loading', error: null }))
          requestJson(PROMPT_API_BASE + '/api/sessions' + (refresh ? '?refresh=1' : ''), controller.signal).then((data) => {
            if (controller.signal.aborted) return
            setSessions({ status: 'ready', items: Array.isArray(data.sessions) ? data.sessions : [], error: null })
          }).catch((error) => {
            if (controller.signal.aborted) return
            setSessions({ status: 'error', items: [], error: errText(error) })
          })
        }, [])

        React.useEffect(() => {
          loadSessions(false)
          return () => { if (sessionsAbort.current) sessionsAbort.current.abort() }
        }, [loadSessions])

        // 2) 会话详情（只在选中时拉）；拿到 title/requests 后回填左栏那一行
        const mergeRow = React.useCallback((id, title, requests) => {
          setSessions((s) => {
            if (s.status !== 'ready') return s
            let changed = false
            const items = s.items.map((it) => {
              if (it.id !== id) return it
              changed = true
              return Object.assign({}, it, { title: title, requests: requests })
            })
            return changed ? Object.assign({}, s, { items: items }) : s
          })
        }, [])

        React.useEffect(() => {
          if (!sessionId) return undefined
          const controller = new AbortController()
          setDetail({ status: 'loading', meta: null, requests: [], error: null })
          setTurn(0)
          requestJson(PROMPT_API_BASE + '/api/session?id=' + encodeURIComponent(sessionId), controller.signal).then((data) => {
            if (controller.signal.aborted) return
            const requests = Array.isArray(data.requests) ? data.requests : []
            setDetail({ status: 'ready', meta: data.meta || {}, requests: requests, error: null })
            setTurn(requests.length > 0 ? 1 : 0)
            mergeRow(sessionId, typeof data.title === 'string' ? data.title : '', requests.length)
          }).catch((error) => {
            if (controller.signal.aborted) return
            setDetail({ status: 'error', meta: null, requests: [], error: errText(error) })
            setTurn(0)
          })
          return () => controller.abort()
        }, [sessionId, mergeRow])

        // 3) 空闲批量补标题（P0 内存收紧版）：宿主侧 /resolve 对每个 id 都走完整解析，所以每轮
        //    「进子页/刷新列表」只补 TITLE_FILL_CAP 个 —— 按列表顺序取前面的行，每批 ≤TITLE_FILL_BATCH 个；
        //    预算用尽就不再排下一批，未补的行保持「无标题」降级显示（可接受的降级）。
        //    子页不活跃（切子页/关面板/组件卸载）时本组件随之卸载，effect 清理既取消在飞请求也取消排程，
        //    组件不在就不会再排下一批。失败仍是尽力而为：保持未解析态，绝不抛。
        React.useEffect(() => {
          if (sessions.status !== 'ready') return undefined
          const pending = sessions.items.filter((s) => isUnparsed(s)).map((s) => s.id)
          if (pending.length === 0) return undefined
          const remaining = TITLE_FILL_CAP - resolveSentRef.current
          if (remaining <= 0) return undefined   // 预算用尽：停止补标题
          const batch = pending.slice(0, Math.min(TITLE_FILL_BATCH, remaining))   // 列表顺序靠前的行优先
          const controller = new AbortController()
          const schedule = window.requestIdleCallback || ((cb) => setTimeout(cb, 120))
          const cancel = window.cancelIdleCallback || ((h) => clearTimeout(h))
          const handle = schedule(() => {
            if (controller.signal.aborted) return
            resolveSentRef.current += batch.length
            requestJson(PROMPT_API_BASE + '/api/sessions/resolve?ids=' + encodeURIComponent(batch.join(',')), controller.signal)
              .then((data) => {
                if (controller.signal.aborted) return
                for (const row of Array.isArray(data.sessions) ? data.sessions : []) {
                  mergeRow(row.id, String(row.title == null ? '' : row.title), typeof row.requests === 'number' ? row.requests : 0)
                }
              })
              .catch(() => {
                // 补标题是尽力而为：网络抖动/会话坏都保持未解析态，不打扰用户、绝不抛
              })
          })
          return () => { cancel(handle); controller.abort() }
        }, [sessions.items, mergeRow])

        // 4) 部件全文（只在选中轮次后拉）
        React.useEffect(() => {
          if (!sessionId || !turn) return undefined
          const controller = new AbortController()
          setPartState({ status: 'loading', data: null, error: null })
          requestJson(
            PROMPT_API_BASE + '/api/part?id=' + encodeURIComponent(sessionId) + '&turn=' + String(turn) + '&part=' + encodeURIComponent(part),
            controller.signal,
          ).then((data) => {
            if (controller.signal.aborted) return
            setPartState({ status: 'ready', data: data, error: null })
          }).catch((error) => {
            if (controller.signal.aborted) return
            setPartState({ status: 'error', data: null, error: errText(error) })
          })
          return () => controller.abort()
        }, [sessionId, turn, part])

        const copyCurrent = () => {
          const data = partState.status === 'ready' ? partState.data : null
          if (!data) return
          const text = typeof data.text === 'string'
            ? data.text
            : (Array.isArray(data.tools)
              ? data.tools.map((t) => t.name + '  (' + t.chars + ' 字)').join('\n')
              : '')
          if (text === '') return
          copyText(text).then(
            () => setNote('已复制 ' + text.length + ' 字符'),
            () => setNote('复制失败 [COPY_FAIL]'),
          )
        }

        const refreshSessions = () => { setNote(''); loadSessions(true) }

        const detailMeta = detail.status === 'ready' ? detail.meta : null
        const statusLine = [
          sessions.status === 'ready' ? '会话 ' + sessions.items.length + ' 个' : null,
          detail.status === 'ready' ? (detail.requests.length > 0 ? '轮次 ' + (turn || '-') + '/' + detail.requests.length : '无模型请求') : null,
          sessionId && turn ? '部件 ' + part : null,
          note,
        ].filter(Boolean).join(' · ')

        return e('div', { style: colFillStyle },
          health.status === 'ready' ? e('div', { style: dimStyle }, '数据面可用 · 宿主侧共 ' + health.n + ' 个会话') : null,
          health.status === 'loading' ? e('div', { style: dimStyle }, '正在探测提示词数据面…') : null,
          health.status === 'error' ? e('div', { style: errorStyle }, '提示词数据面不可用：' + health.error + '（下方列表如有报错以其为准）') : null,
          e('div', { style: columnsStyle },
            e(PromptSessionList, { state: sessions, selectedId: sessionId, onSelect: setSessionId, onRefresh: refreshSessions, nameIdx: nameIdx }),
            e(PromptRequestList, { detail: detail, selectedTurn: turn, onSelect: setTurn }),
            e(PromptPartView, {
              sessionId: sessionId, turn: turn, part: part, setPart: setPart,
              state: partState, query: query, setQuery: setQuery, onCopy: copyCurrent,
            }),
          ),
          e('div', { style: statusAreaStyle },
            e('span', { style: dimStyle }, statusLine || '就绪'),
            detailMeta && e('span', {
              style: Object.assign({}, dimStyle, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }),
              title: String(detailMeta.cwd || ''),
            }, 'cwd: ' + (detailMeta.cwd || '-')
              + (detailMeta.effectivePreset ? ' · preset: ' + detailMeta.effectivePreset : '')),
            sessionId ? e(CopyBtn, { value: sessionId, label: '复制会话 ID' }) : null,
          ),
        )
      }

      // ---------- 子页 B/C：模板编辑卡片（★ 解释文案逐字来自规格 §2，不许改写、不许精简） ----------
      const COMPACTION_EXPLAIN = [
        '【这段提示词是干什么的】',
        'DSH 每轮把旧内容移出上下文时，会先让模型把「即将离开上下文的那段历史」写成一份 checkpoint，',
        '这份 checkpoint 顶替原文留在原位。这段文本就是给模型的那条指令 —— 它决定 checkpoint 里留下什么、丢掉什么。',
        '',
        '· 官方默认（compaction-basic）是一段硬编码的英文工程模板，是为编程会话写的',
        '  （Primary Request and Intent / Files and Code / Next Step …），而且它没有任何配置键。',
        '· 角色扮演的历史不是给工程师读的：它的用途是日后被检索找回，所以需要的是',
        '  「时间跨度 / 地点 / 涉及角色 / 关键事件 / 未回收的伏笔」，并要求专有名词与数值逐字照抄。',
        '· 官方源码里明确留了唯一的扩展点 —— 覆盖摘要器的 summarize() 一个钩子',
        '  （原话：Override this sole hook for a template or remote summarizer）。',
        '  压力阈值、保留策略、token 计量、/compact、溢出恢复全部继承官方。',
        '',
        '【怎么让它生效】',
        '把这段文本填进 agent preset 里压缩后端的 customInstruction（留空 = 用该后端内置模板）；',
        'summaryLanguage 控制中英文（auto / zh / en）。本插件只保存这段文本本身，不改 DSH 的任何文件。',
        '',
        '【为什么不会污染编程模式】',
        '角色扮演用的压缩后端在自己的 isolate realm 里注册同名的 compaction 服务，与标准 preset 的实例互相看不见；',
        'standard preset 的组装文件一个字都没改。',
        '',
        '【一个性能讲究】',
        '这条指令是作为最后一条 user 消息追加的，会话自己的 system / tools / 消息排在它前面',
        '⇒ 这次辅助调用是上一次真实请求的前缀延长，provider 的 KV cache 被复用，而不是被击穿。',
      ].join('\n')

      const COMPACTION_NOTICES = '⚠️ 保存只是把这段文本存进本插件配置；要真正生效，需要把它填进对应的 preset 配置。'

      const PLACEHOLDER_EXPLAIN = [
        '【这段提示词是干什么的】',
        '内容被「收纳」（移出上下文）之后，那一处不是空白 —— 模型在原位看到的是一段固定前言 + 归档正文，',
        '被 <compacted-summary> 标签包起来（官方 frameSummary() 就是这么拼的）。',
        '这段前言负责告诉模型三件事：',
        '  ① 这是自动生成的归档，不是你写的东西；',
        '  ② 把里面的内容当作既成背景，在它之上继续，不要重述；',
        '  ③ 不要对这段归档本身作出回应（不评论、不感谢、不回答），直接从后面的消息继续。',
        '',
        '【为什么占位行里要带关键词】',
        '世界书条目靠「关键词在上下文里出现过」触发，而扫描的正是压缩之后的 surface',
        '⇒ 老楼被替换成占位行之后，它的关键词就不再参与触发了。',
        '所以占位行要带上该楼段的关键词（这也是「专有名词逐字照抄」那条规则的硬理由）。',
      ].join('\n')

      const PLACEHOLDER_NOTICES = [
        '⚠️ 本插件目前还没有实现收纳执行器：这段文本现在是待用的配置位，保存它不会改变任何 DSH 行为。',
        '⚠️ 官方 compaction 那条路上的前言写死在官方代码里（frameSummary），改不了；这里改的是本插件将来自己做收纳时用的前言。',
      ].join('\n')

      const PLACEHOLDER_VARS = '可用变量：{from} 起始楼号 · {to} 结束楼号 · {cast} 涉及角色 —— 真正执行收纳时替换。'
      const REF_SOURCE_LINE = '来源：DSH 官方 compaction-basic（MIT，Copyright (c) 2026 DeepSeek）'

      function TemplateCard({ templateKey }) {
        const meta = templateKey === 'placeholder'
          ? { title: '收纳占位', explain: PLACEHOLDER_EXPLAIN, refField: 'officialPreamble', notices: PLACEHOLDER_NOTICES, vars: PLACEHOLDER_VARS }
          : { title: '压缩指令', explain: COMPACTION_EXPLAIN, refField: 'officialCompaction', notices: COMPACTION_NOTICES, vars: null }
        const [load, setLoad] = React.useState({ status: 'loading', data: null, error: '' })
        const [draft, setDraft] = React.useState('')
        const [save, setSave] = React.useState({ busy: false, error: '', ok: '' })
        const [refOpen, setRefOpen] = React.useState(false)
        const [tick, setTick] = React.useState(0)
        const loadCtl = React.useRef(null)
        const actCtl = React.useRef(null)
        React.useEffect(() => () => {
          if (loadCtl.current) loadCtl.current.abort()
          if (actCtl.current) actCtl.current.abort()
        }, [])

        React.useEffect(() => {
          const controller = new AbortController()
          loadCtl.current = controller
          setLoad({ status: 'loading', data: null, error: '' })
          ;(async () => {
            const data = await requestJson(HOST_API_BASE + '/templates', controller.signal)
            if (controller.signal.aborted) return
            const t = data.templates && data.templates[templateKey]
            if (!t || typeof t.current !== 'string') {
              const err = new Error('模板数据形状不对（缺 templates.' + templateKey + '.current）')
              err.code = 'BAD_PAYLOAD'
              throw err
            }
            setLoad({ status: 'ready', data: data, error: '' })
            setDraft(t.current)
          })().catch((error) => {
            if (controller.signal.aborted) return
            setLoad({ status: 'error', data: null, error: errText(error) })
          })
          return () => { controller.abort(); loadCtl.current = null }
        }, [templateKey, tick])

        // 保存（字符串）/ 恢复内置默认（null）：body 只带这一个键；
        // 成功响应 = 宿主写后回读的同形状 —— 只信回读，文本框同步成回读值
        const act = (value, okText) => {
          if (actCtl.current) actCtl.current.abort()
          const controller = new AbortController()
          actCtl.current = controller
          setSave({ busy: true, error: '', ok: '' })
          ;(async () => {
            const body = {}
            body[templateKey] = value
            const data = await mutateJson(HOST_API_BASE + '/templates', 'PUT', body, controller.signal)
            if (controller.signal.aborted) return
            const t = data.templates && data.templates[templateKey]
            if (!t || typeof t.current !== 'string') {
              const err = new Error('写后回读的形状不对（缺 templates.' + templateKey + '.current）')
              err.code = 'BAD_PAYLOAD'
              throw err
            }
            setLoad({ status: 'ready', data: data, error: '' })
            setDraft(t.current)
            setSave({ busy: false, error: '', ok: okText })
          })().catch((error) => {
            if (controller.signal.aborted) return
            setSave({ busy: false, error: errText(error), ok: '' })
          })
        }

        const tpl = load.status === 'ready' && load.data && load.data.templates ? load.data.templates[templateKey] : null
        const statusBits = tpl
          ? (tpl.custom
            ? [e('span', { key: 's0', style: dimStyle }, '当前：'),
              e('span', { key: 's1', style: warnBadgeStyle, title: '宿主配置里存了自定义文本（非内置默认）' }, '自定义')]
            : [e('span', { key: 's0', style: dimStyle }, '当前：内置默认')]
          ).concat([e('span', { key: 's2', style: dimStyle }, '· ' + tpl.current.length + ' 字符')])
          : null
        const head = e('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
          e('strong', { style: sectionTitleStyle }, meta.title),
          statusBits,
        )

        if (load.status === 'loading') {
          return e('div', { style: cardStyle }, head, e('div', { style: dimStyle }, '正在读取提示词模板…'))
        }
        if (load.status === 'error' || !load.data || !load.data.templates || !load.data.templates[templateKey]) {
          // ★ 宿主 API 不可用/形状不对：可读红字 + 重试；不出假输入框
          return e('div', { style: cardStyle }, head,
            e('div', { style: errorStyle }, '提示词模板读取失败：' + (load.error || '未知错误')),
            e('div', null, e('button', { style: btnStyle, onClick: () => setTick((x) => x + 1) }, '重试')),
          )
        }

        const t = load.data.templates[templateKey]
        const referenceText = load.data.reference && typeof load.data.reference[meta.refField] === 'string'
          ? load.data.reference[meta.refField]
          : ''
        return e('div', { style: cardStyle },
          head,
          e('div', { style: explainStyle }, meta.explain),
          e('textarea', {
            id: 'dma-template-' + templateKey, name: 'dma-template-' + templateKey,
            'aria-label': templateKey === 'compaction' ? '压缩指令模板（可编辑）' : '收纳占位模板（可编辑）',
            style: templateAreaStyle, rows: 14, spellCheck: false,
            value: draft, onChange: (ev) => setDraft(ev.target.value),
            placeholder: '模板文本（保存空串 = 恢复内置默认）',
          }),
          e('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
            e('button', { style: btnStyle, disabled: save.busy, onClick: () => act(draft, '已保存，并已按宿主回读同步') },
              save.busy ? '保存中…' : '保存'),
            e('button', {
              style: btnStyle, disabled: save.busy,
              title: '把该键存为 null 恢复内置默认；成功后文本框同步成回读值',
              onClick: () => act(null, '已恢复内置默认（文本框已同步成回读值）'),
            }, '恢复内置默认'),
            e('button', {
              style: btnStyle,
              onClick: () => {
                copyText(draft).then(
                  () => setSave((s) => ({ ...s, ok: '已复制文本框内容', error: '' })),
                  () => setSave((s) => ({ ...s, error: '复制失败 [COPY_FAIL]', ok: '' })),
                )
              },
            }, '复制'),
            e('button', {
              style: btnStyle, disabled: save.busy || typeof t.builtin !== 'string',
              title: '把内置默认填进文本框（不保存，可先改再存）',
              onClick: () => setDraft(typeof t.builtin === 'string' ? t.builtin : ''),
            }, '载入内置默认'),
          ),
          save.ok ? e('div', { style: okStyle }, save.ok) : null,
          save.error ? e('div', { style: errorStyle }, save.error) : null,
          meta.vars ? e('div', { style: dimStyle }, meta.vars) : null,
          e('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            e('button', {
              style: Object.assign({}, miniBtnStyle, { alignSelf: 'flex-start' }),
              onClick: () => setRefOpen((v) => !v),
            }, refOpen ? '官方原文参考 ▴' : '官方原文参考 ▾'),
            refOpen && e('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              e('pre', { style: promptPreStyle }, referenceText || '（宿主没有返回官方原文）'),
              e('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
                e('span', { style: dimStyle }, REF_SOURCE_LINE),
                e(CopyBtn, { value: referenceText, label: '复制原文' })),
            ),
          ),
          e('div', { style: honestStyle }, meta.notices),
        )
      }

      // ---------- 提示词区容器：三子页 tab + 返回阅读（切子页即卸载，AbortController 随清理触发） ----------
      function PromptsView({ nameIdx, onBack }) {
        const [tab, setTab] = React.useState('requests')
        const tabBtn = (key, label) => e('button', {
          key: key,
          style: Object.assign({}, btnStyle, { opacity: tab === key ? 1 : 0.55, fontWeight: tab === key ? 700 : 400 }),
          onClick: () => setTab(key),
        }, label)
        return e('div', { style: colFillStyle },
          e('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', flex: 'none' } },
            tabBtn('requests', '每次请求'),
            tabBtn('compaction', '压缩指令'),
            tabBtn('placeholder', '收纳占位'),
            e('span', { style: { flex: 1 } }),
            e('button', { style: btnStyle, onClick: onBack }, '← 返回阅读'),
          ),
          e('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
            tab === 'requests'
              ? e(PerRequestView, { nameIdx: nameIdx })
              : e('div', { style: scrollColStyle }, e(TemplateCard, { key: tab, templateKey: tab })),
          ),
        )
      }

      // ---------- 设置视图 A：根模式单选（只活在这里；工作区在 Tavern 不可达时置灰 + 原因） ----------
      function RootModePicker({ config, health, saveMode, modeBusy, modeError }) {
        const current = config && config.rootMode === 'workspace' ? 'workspace' : 'session'
        const tavernBad = !!(health && health.tavernReachable === false)
        const radio = (mode, label, desc, disabled, reason) => e('label', {
          style: { display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 12, lineHeight: 1.5, opacity: disabled ? 0.5 : 1 },
        },
          e('input', {
            type: 'radio', name: 'dsh-memory-archive-root-mode',
            id: 'dma-root-mode-' + mode, 'aria-label': '根模式单选：' + label,
            checked: current === mode, disabled: disabled || modeBusy,
            onChange: () => { if (!disabled) saveMode(mode) },
          }),
          e('span', null,
            e('strong', null, label),
            e('span', { style: { opacity: 0.75 } }, ' —— ' + desc),
            reason ? e('div', { style: errorStyle }, reason) : null),
        )
        return e('div', { style: cardStyle },
          e('div', { style: sectionTitleStyle }, '根模式'),
          radio('session', '会话', '手动选一条 DSH 会话当根；原版 DSH 纯净环境即可用，零额外依赖。', false, null),
          radio('workspace', '工作区', '根是 Tavern 工作区里某个周目的 archive/；需要已安装 pmp-dsh-tavern。',
            tavernBad, tavernBad ? '未检测到 pmp-dsh-tavern（本模式需要它）' : null),
          modeBusy ? e('div', { style: dimStyle }, '正在保存根模式…') : null,
          modeError ? e('div', { style: errorStyle }, '根模式保存失败：' + modeError) : null,
        )
      }

      // ---------- 设置视图 B：会话根选择（下拉显示真名 + 来源徽标；完整 id 只在 title） ----------
      function SessionRootPicker({ config, reload, nameIdx, onPick }) {
        const [state, setState] = React.useState({ status: 'loading', items: [], error: null })
        const [save, setSave] = React.useState({ busy: false, error: null })
        const saveCtl = React.useRef(null)
        React.useEffect(() => () => { if (saveCtl.current) saveCtl.current.abort() }, [])

        React.useEffect(() => {
          const controller = new AbortController()
          ;(async () => {
            const data = await requestJson(HOST_API_BASE + '/sessions?titles=1', controller.signal)
            if (controller.signal.aborted) return
            setState({ status: 'ready', items: Array.isArray(data.sessions) ? data.sessions : [], error: null })
          })().catch((error) => {
            if (controller.signal.aborted) return
            setState({ status: 'error', items: [], error: errText(error) })
          })
          return () => controller.abort()
        }, [])

        // ★ /config 可能不返回 root：取不到当前选择时退化成占位项
        const current = config && config.root && typeof config.root.sessionId === 'string' ? config.root.sessionId : ''
        const items = state.status === 'ready' ? state.items : []
        const hasCurrent = items.some((s) => String(s && s.sessionId) === current)
        const optionLabel = (s) => {
          const ls = labelSession(s, nameIdx)
          const badge = ls.source === 'playthrough' ? '（来自周目目录）' : ls.source === 'id' ? '（无标题）' : ''
          return ls.text + badge
        }
        const pick = (sid) => {
          if (!sid || sid === current) return
          if (saveCtl.current) saveCtl.current.abort()
          const controller = new AbortController()
          saveCtl.current = controller
          setSave({ busy: true, error: null })
          onPick(sid)
          ;(async () => {
            await mutateJson(HOST_API_BASE + '/config', 'PUT',
              { root: { sessionId: sid, characterId: null, playthroughId: null } }, controller.signal)
            await reload()
            if (controller.signal.aborted) return
            setSave({ busy: false, error: null })
          })().catch((error) => {
            if (controller.signal.aborted) return
            setSave({ busy: false, error: errText(error) })
          })
        }

        return e('div', { style: cardStyle },
          e('div', { style: sectionTitleStyle }, '根会话'),
          state.status === 'loading' && e('div', { style: dimStyle }, '正在加载会话列表…'),
          state.status === 'error' && e('div', { style: errorStyle }, '会话列表加载失败：' + state.error),
          state.status === 'ready' && e('select', {
            id: 'dma-session-select', name: 'dma-session-select',
            'aria-label': '选择根会话',
            style: Object.assign({}, selectStyle, { maxWidth: '100%', fontSize: 12 }),
            value: current, disabled: save.busy, onChange: (ev) => pick(ev.target.value),
            title: current || '选择一条会话作为记忆库的根',
          },
            e('option', { value: '' }, current ? '—— 重新选择根会话 ——' : '—— 选择一条会话 ——'),
            current && !hasCurrent && e('option', { key: '__current__', value: current }, '（当前会话不在列表里）'),
            items.map((s) => e('option', {
              key: String(s && s.sessionId), value: String(s && s.sessionId),
              title: String((s && s.sessionId) || ''),
            }, optionLabel(s)))),
          save.busy && e('div', { style: dimStyle }, '正在保存根会话…'),
          save.error && e('div', { style: errorStyle }, '根会话保存失败：' + save.error),
          state.status === 'ready' && items.length === 0 && e('div', { style: dimStyle }, '宿主没有返回任何会话'),
        )
      }

      // ---------- 设置视图 B：工作区根选择（复用面板级自动发现，真名下拉；结果写进配置 root） ----------
      function WorkspaceRootPicker({ disc, nameIdx, reload, onPick }) {
        const [save, setSave] = React.useState({ busy: false, error: null })
        const saveCtl = React.useRef(null)
        React.useEffect(() => () => { if (saveCtl.current) saveCtl.current.abort() }, [])

        const commit = (characterId, playthroughId) => {
          if (!characterId || !playthroughId) return
          if (saveCtl.current) saveCtl.current.abort()
          const controller = new AbortController()
          saveCtl.current = controller
          setSave({ busy: true, error: null })
          onPick(characterId, playthroughId)
          ;(async () => {
            await mutateJson(HOST_API_BASE + '/config', 'PUT',
              { root: { sessionId: null, characterId: characterId, playthroughId: playthroughId } }, controller.signal)
            await reload()
            if (controller.signal.aborted) return
            setSave({ busy: false, error: null })
          })().catch((error) => {
            if (controller.signal.aborted) return
            setSave({ busy: false, error: errText(error) })
          })
        }

        const cur = disc.found.find ? disc.found.find((f) => f.charId === disc.characterId) : null
        const plays = cur ? cur.plays : []
        return e('div', { style: cardStyle },
          e('div', { style: sectionTitleStyle }, '工作区根（自动发现）'),
          disc.status === 'loading' && e('div', { style: dimStyle }, '正在发现 Tavern 工作区里的归档…'),
          disc.status === 'error' && e('div', { style: errorStyle }, '归档发现失败：' + disc.error),
          disc.status === 'ready' && e('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
            e('select', {
              id: 'dma-character-select', name: 'dma-character-select',
              'aria-label': '选择工作区角色（根）',
              style: selectStyle, value: disc.characterId || '', disabled: save.busy,
              onChange: (ev) => {
                const f = disc.found.find((x) => x.charId === ev.target.value)
                commit(ev.target.value, f && f.plays[0])
              },
              title: disc.characterId || '',
            },
              disc.found.map((f) => e('option', { key: f.charId, value: f.charId, title: f.charId },
                labelCharacter(f.charId, nameIdx)))),
            plays.length > 0 && e('select', {
              id: 'dma-playthrough-select', name: 'dma-playthrough-select',
              'aria-label': '选择周目（根）',
              style: selectStyle, value: disc.playthroughId || '', disabled: save.busy,
              onChange: (ev) => commit(disc.characterId, ev.target.value),
              title: disc.playthroughId || '',
            },
              plays.map((p) => e('option', { key: p, value: p, title: p }, labelPlaythrough(p, nameIdx)))),
          ),
          save.busy && e('div', { style: dimStyle }, '正在保存工作区根…'),
          save.error && e('div', { style: errorStyle }, '工作区根保存失败：' + save.error),
        )
      }

      // ---------- 设置视图 C：API 设置（url/model/key + 保存/测试/清除；密钥纪律与 v3 一字不变） ----------
      function ApiSettings({ config, reload }) {
        const savedUrl = config && config.api && typeof config.api.url === 'string' ? config.api.url : ''
        const savedModel = config && config.api && typeof config.api.model === 'string' ? config.api.model : ''
        const keySet = !!(config && config.keySet)
        const keyHint = config && typeof config.keyHint === 'string' ? config.keyHint : null

        const [url, setUrl] = React.useState(savedUrl)
        const [model, setModel] = React.useState(savedModel)
        const [key, setKey] = React.useState('')
        const [act, setAct] = React.useState('')
        const [msg, setMsg] = React.useState(null)
        const ctl = React.useRef(null)
        React.useEffect(() => () => { if (ctl.current) ctl.current.abort() }, [])

        // 保存/清除后的回读结果（config 引用变化）覆盖本地草稿；密钥输入框永远清空、绝不回显
        React.useEffect(() => { setUrl(savedUrl); setModel(savedModel); setKey('') }, [config])

        function runPut(kind, body, okText) {
          if (ctl.current) ctl.current.abort()
          const controller = new AbortController()
          ctl.current = controller
          setAct(kind)
          setMsg(null)
          ;(async () => {
            await mutateJson(HOST_API_BASE + '/config', 'PUT', body, controller.signal)
            await reload()
            if (controller.signal.aborted) return
            setAct('')
            setMsg({ ok: true, text: okText })
          })().catch((error) => {
            if (controller.signal.aborted) return
            setAct('')
            setMsg({ ok: false, text: errText(error) })
          })
        }

        function doSave() {
          // body 只带改动的字段；key 留空 = 不修改（宿主约定）
          const api = {}
          if (url !== savedUrl) api.url = url
          if (model !== savedModel) api.model = model
          if (key !== '') api.key = key
          if (Object.keys(api).length === 0) { setMsg({ ok: true, text: '没有需要保存的改动' }); return }
          runPut('save', { api: api }, '已保存，并已回读配置同步界面')
        }
        function doClear() {
          runPut('clear', { api: { key: '__CLEAR__' } }, '已清除密钥，并已回读配置同步界面')
        }
        function doTest() {
          if (ctl.current) ctl.current.abort()
          const controller = new AbortController()
          ctl.current = controller
          setAct('test')
          setMsg(null)
          ;(async () => {
            const data = await mutateJson(HOST_API_BASE + '/config/test', 'POST', undefined, controller.signal)
            if (controller.signal.aborted) return
            setAct('')
            const bits = []
            if (data && typeof data.httpStatus === 'number') bits.push('HTTP ' + String(data.httpStatus))
            if (data && typeof data.elapsedMs === 'number') bits.push(String(data.elapsedMs) + 'ms')
            if (data && typeof data.replyPreview === 'string' && data.replyPreview !== '') bits.push('回复：' + data.replyPreview)
            setMsg({ ok: true, text: '测试成功' + (bits.length > 0 ? ' · ' + bits.join(' · ') : '') })
          })().catch((error) => {
            if (controller.signal.aborted) return
            setAct('')
            const bits = []
            const payload = error && error.payload
            if (payload && typeof payload.httpStatus === 'number') bits.push('HTTP ' + String(payload.httpStatus))
            if (payload && typeof payload.elapsedMs === 'number') bits.push(String(payload.elapsedMs) + 'ms')
            setMsg({ ok: false, text: '测试失败' + (bits.length > 0 ? '（' + bits.join(' · ') + '）' : '') + '：' + errText(error) })
          })
        }

        return e('div', { style: cardStyle },
          e('div', { style: sectionTitleStyle }, 'API 设置（用户自配）'),
          e('label', { style: fieldLabelStyle }, '接口地址',
            e('input', { id: 'dma-api-url', name: 'dma-api-url', 'aria-label': 'API baseURL', style: inputStyle, value: url, placeholder: 'API baseURL', onChange: (ev) => setUrl(ev.target.value) })),
          e('label', { style: fieldLabelStyle }, '模型',
            e('input', { id: 'dma-api-model', name: 'dma-api-model', 'aria-label': '模型名', style: inputStyle, value: model, placeholder: '模型名', onChange: (ev) => setModel(ev.target.value) })),
          e('label', { style: fieldLabelStyle }, '密钥',
            e('input', {
              id: 'dma-api-key', name: 'dma-api-key', 'aria-label': '密钥（只写不读）',
              style: inputStyle, type: 'password', value: key, autoComplete: 'new-password',
              placeholder: keySet ? '已保存（' + (keyHint || '****') + '）· 留空则不修改' : '未设置',
              onChange: (ev) => setKey(ev.target.value),
            })),
          e('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
            e('button', { style: btnStyle, onClick: doSave, disabled: act !== '' }, act === 'save' ? '保存中…' : '保存'),
            e('button', { style: btnStyle, onClick: doTest, disabled: act !== '' }, act === 'test' ? '正在测试…（可能需要数十秒）' : '测试连接'),
            e('button', { style: btnStyle, onClick: doClear, disabled: act !== '' || !keySet }, act === 'clear' ? '清除中…' : '清除密钥'),
          ),
          msg ? e('div', { style: msg.ok ? okStyle : errorStyle }, msg.text) : null,
          e('div', { style: dimStyle }, '密钥只写不读：宿主不返回密钥内容，只返回是否已设置（keySet）与尾 4 位提示。'),
        )
      }

      // ---------- 设置视图 D：诊断（+ 名字目录状态） ----------
      function healthRow(label, ok, okText, badText) {
        return e('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 } },
          e('span', { style: rowLabelStyle }, label),
          ok === true ? e('span', { style: okStyle }, okText || '正常')
            : ok === false ? e('span', { style: errorStyle }, badText || '异常')
              : e('span', { style: dimStyle }, '未知'),
        )
      }

      function DiagnosticsView({ health, config, catalog }) {
        const cfg = config || {}
        return e('div', { style: cardStyle },
          e('div', { style: sectionTitleStyle }, '诊断'),
          health
            ? e('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              healthRow('宿主 API（webServer）', health.webServer),
              healthRow('会话查询（sessionQuery）', health.sessionQuery, '可用', '不可用'),
              healthRow('配置目录可写（storageDirWritable）', health.storageDirWritable, '可写', '不可写'),
              healthRow('Tavern 可达（tavernReachable）', health.tavernReachable, '可达', '不可达'),
            )
            : e('div', { style: errorStyle }, '宿主 API 不可用，诊断信息拿不到'),
          e('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 } },
            e('span', { style: rowLabelStyle }, '名字目录（catalog.json）'),
            catalog && catalog.status === 'ready' && !catalog.error
              ? e('span', { style: okStyle }, '已解析')
              : catalog && catalog.error
                ? e('span', { style: errorStyle }, '不可读：' + catalog.error)
                : e('span', { style: dimStyle }, '未知')),
          e('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 } },
            e('span', { style: rowLabelStyle }, '存储目录（只读）'),
            e('span', { style: monoDimStyle }, String(cfg.storageDir || '-'))),
          e('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 } },
            e('span', { style: rowLabelStyle }, '配置文件（只读）'),
            e('span', { style: monoDimStyle }, String(cfg.configPath || '-'))),
          cfg.configError
            ? e('div', { style: Object.assign({}, errorStyle, { fontWeight: 700 }) }, '配置告警：' + String(cfg.configError))
            : null,
        )
      }

      // ---------- 设置视图容器（宿主不可用时不出假输入框；顶部「← 返回阅读」） ----------
      function SettingsView({ host, saveMode, modeSave, reload, nameIdx, catalog, disc, onPickWorkspace, onPickSession, onBack }) {
        const head = e('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flex: 'none' } },
          e('button', { style: btnStyle, onClick: onBack }, '← 返回阅读'),
          e('strong', { style: sectionTitleStyle }, '设置'),
        )
        let body
        if (host.healthStatus === 'loading') {
          body = e('div', { style: dimStyle }, '正在检测宿主 API…')
        } else if (host.healthStatus === 'error') {
          body = e('div', { style: colFillStyle },
            e('div', { style: Object.assign({}, errorStyle, { fontWeight: 700 }) }, '宿主 API 不可用（记忆库配置功能受限）'),
            e('div', { style: errorStyle }, '原因：' + host.healthError),
            e('div', { style: dimStyle }, '配置功能需要宿主机半侧的 HTTP API（可能因宿主版本较旧或插件未重启而缺失）。阅读区的「工作区模式」不依赖宿主 API，照常可用。'),
            e('button', { style: btnStyle, onClick: reload }, '重试'),
          )
        } else if (host.configStatus === 'loading') {
          body = e('div', { style: dimStyle }, '正在读取配置…')
        } else if (host.configStatus === 'error' || !host.config) {
          body = e('div', { style: colFillStyle },
            e('div', { style: errorStyle }, '配置读取失败：' + (host.configError || '未知错误')),
            e('button', { style: btnStyle, onClick: reload }, '重试'),
          )
        } else {
          const cfg = host.config
          const cfgMode = cfg.rootMode === 'workspace' ? 'workspace' : 'session'
          body = e('div', { style: scrollColStyle },
            e(RootModePicker, {
              config: cfg, health: host.health, saveMode: saveMode,
              modeBusy: modeSave.busy, modeError: modeSave.error,
            }),
            cfgMode === 'session'
              ? e(SessionRootPicker, { config: cfg, reload: reload, nameIdx: nameIdx, onPick: onPickSession })
              : e(WorkspaceRootPicker, { disc: disc, nameIdx: nameIdx, reload: reload, onPick: onPickWorkspace }),
            e(ApiSettings, { config: cfg, reload: reload }),
            e(DiagnosticsView, { health: host.health, config: cfg, catalog: catalog }),
          )
        }
        return e('div', { style: colFillStyle },
          head,
          e('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } }, body),
        )
      }

      // ---------- 面板底部状态行：归档路径 / 根会话（人话名 + 复制完整值；原始值在 title） ----------
      function RootStatusLine({ mode, wsChar, wsPlay, sessId, archivePath, nameIdx, disc, catalogError }) {
        const bits = []
        if (mode === 'workspace') {
          if (disc.status === 'loading') bits.push(e('span', { key: 'l', style: dimStyle }, '正在发现归档…'))
          if (disc.status === 'error') bits.push(e('span', { key: 'e', style: errorStyle }, '归档不可用：' + disc.error))
          if (archivePath) {
            const text = labelCharacter(wsChar, nameIdx) + ' / ' + labelPlaythrough(wsPlay, nameIdx, { short: true }) + ' / archive'
            bits.push(e('span', { key: 'p', style: dimStyle, title: archivePath }, '路径：' + text))
            bits.push(e(CopyBtn, { key: 'c', value: archivePath, label: '复制路径' }))
          }
        } else if (sessId) {
          const ls = labelSession({ sessionId: sessId, title: null }, nameIdx)
          const badge = sourceBadge(ls.source)
          bits.push(e('span', { key: 'p', style: dimStyle, title: sessId }, '根会话：' + ls.text))
          if (badge) bits.push(e('span', { key: 'b', style: dimBadgeStyle, title: badge.title }, badge.text))
          bits.push(e(CopyBtn, { key: 'c', value: sessId, label: '复制会话 ID' }))
        } else {
          bits.push(e('span', { key: 'p', style: dimStyle }, '根会话：未选择'))
        }
        if (catalogError) bits.push(e('span', { key: 'cat', style: errorStyle }, '名字目录不可读：' + catalogError))
        return e('div', { style: statusAreaStyle },
          e('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 11 } }, bits),
        )
      }

      // ---------- 面板主体：顶栏（当前根人话名 + 提示词/设置/全屏/关闭）+ 视图切换 ----------
      function ArchivePanel({ sessions, onClose }) {
        const [view, setView] = React.useState('read')                 // 'read' | 'prompts' | 'settings'
        const [fullscreen, setFullscreen] = React.useState(false)
        const [host, setHost] = React.useState({
          healthStatus: 'loading', health: null, healthError: '',
          configStatus: 'loading', config: null, configError: '',
        })
        const [modeSave, setModeSave] = React.useState({ busy: false, error: null })
        const [disc, setDisc] = React.useState({ status: 'loading', error: '', found: [], characterId: null, playthroughId: null })
        const [catalog, setCatalog] = React.useState({ status: 'loading', index: EMPTY_NAME_INDEX, error: '' })
        const [tick, setTick] = React.useState(0)
        const [pickedSessionId, setPickedSessionId] = React.useState('')
        const actionCtl = React.useRef(null)
        React.useEffect(() => () => { if (actionCtl.current) actionCtl.current.abort() }, [])

        async function loadAll(signal) {
          // 首次显示加载态；已成功过则静默刷新（避免保存后的回读造成整块闪烁）
          setHost((s) => ({ ...s, healthStatus: s.health ? 'ready' : 'loading', healthError: '' }))
          setHost((s) => ({ ...s, configStatus: s.config ? 'ready' : 'loading', configError: '' }))
          const healthJob = (async () => {
            const health = await requestJson(HOST_API_BASE + '/health', signal)
            if (signal.aborted) return
            setHost((s) => ({ ...s, healthStatus: 'ready', health: health, healthError: '' }))
          })().catch((error) => {
            if (signal.aborted) return
            setHost((s) => ({ ...s, healthStatus: 'error', health: null, healthError: errText(error) }))
          })
          const configJob = (async () => {
            const config = await requestJson(HOST_API_BASE + '/config', signal)
            if (signal.aborted) return
            setHost((s) => ({ ...s, configStatus: 'ready', config: config, configError: '' }))
          })().catch((error) => {
            if (signal.aborted) return
            setHost((s) => ({ ...s, configStatus: 'error', config: null, configError: errText(error) }))
          })
          await Promise.all([healthJob, configJob])
        }

        function runAction(fn) {
          if (actionCtl.current) actionCtl.current.abort()
          const controller = new AbortController()
          actionCtl.current = controller
          return fn(controller.signal)
        }
        function reload() {
          return runAction(async (signal) => {
            await loadAll(signal)
            if (signal.aborted) return
            setTick((t) => t + 1)   // 触发 catalog / 归档发现的强制刷新
          })
        }

        React.useEffect(() => {
          const controller = new AbortController()
          loadAll(controller.signal)
          return () => controller.abort()
        }, [])

        function saveMode(mode) {
          runAction(async (signal) => {
            setModeSave({ busy: true, error: null })
            try {
              await mutateJson(HOST_API_BASE + '/config', 'PUT', { rootMode: mode }, signal)
              await loadAll(signal)
              if (signal.aborted) return
              setModeSave({ busy: false, error: null })
            } catch (error) {
              if (signal.aborted) return
              setModeSave({ busy: false, error: errText(error) })
              // 失败后回读一次，把界面纠偏回宿主的实际状态
              loadAll(signal)
            }
          })
        }

        const tavernOk = !(host.health && host.health.tavernReachable === false)

        // 真名解析：catalog.json（Tavern）按页面会话缓存；失败也缓存原因，重试/刷新才重取
        React.useEffect(() => {
          if (!tavernOk) {
            setCatalog({ status: 'error', index: EMPTY_NAME_INDEX, error: 'Tavern 不可达，读不到 catalog.json' })
            return
          }
          const controller = new AbortController()
          setCatalog((s) => ({ ...s, status: CATALOG_CACHE.done && !CATALOG_CACHE.error ? 'ready' : 'loading' }))
          ;(async () => {
            const res = await getCatalogIndex(controller.signal, !!CATALOG_CACHE.error)
            if (controller.signal.aborted) return
            setCatalog({ status: 'ready', index: res.index, error: res.error || '' })
          })().catch((error) => {
            if (controller.signal.aborted) return
            setCatalog({ status: 'error', index: EMPTY_NAME_INDEX, error: errText(error) })
          })
          return () => controller.abort()
        }, [tavernOk, tick])

        // 工作区归档自动发现（读区与设置里的工作区根下拉共用同一份结果）
        React.useEffect(() => {
          if (!tavernOk) {
            setDisc({ status: 'error', error: 'Tavern 不可达：无法自动发现工作区归档', found: [], characterId: null, playthroughId: null })
            return
          }
          const controller = new AbortController()
          setDisc((s) => ({ ...s, status: 'loading', error: '' }))
          ;(async () => {
            const res = await discoverWorkspaces(controller.signal)
            if (controller.signal.aborted) return
            setDisc({ status: 'ready', error: '', found: res.found, characterId: res.characterId, playthroughId: res.playthroughId })
          })().catch((error) => {
            if (controller.signal.aborted) return
            setDisc({ status: 'error', error: errText(error), found: [], characterId: null, playthroughId: null })
          })
          return () => controller.abort()
        }, [tavernOk, tick])

        // 当前根（/config 可能不含 root 字段 ⇒ 配置缺失时用自动发现 / 本次已选记忆退化）
        const cfgReady = host.configStatus === 'ready' && !!host.config
        const mode = cfgReady ? (host.config.rootMode === 'workspace' ? 'workspace' : 'session') : 'workspace'
        const cfgRoot = cfgReady && host.config.root && typeof host.config.root === 'object' ? host.config.root : null
        const wsChar = (cfgRoot && typeof cfgRoot.characterId === 'string' && cfgRoot.characterId) || disc.characterId || null
        const wsPlay = (cfgRoot && typeof cfgRoot.playthroughId === 'string' && cfgRoot.playthroughId) || disc.playthroughId || null
        const sessId = mode === 'session'
          ? ((cfgRoot && typeof cfgRoot.sessionId === 'string' && cfgRoot.sessionId) || pickedSessionId)
          : ''
        const nameIdx = catalog.index
        const playInfo = wsPlay && nameIdx.byPlaythrough ? nameIdx.byPlaythrough[wsPlay] : null
        const archivePath = mode === 'workspace' && wsChar && wsPlay ? wsChar + '/' + wsPlay + '/archive' : null
        // 工作区模式也能借目录里的 rootSessionId 桥看「会话事件」（Tavern 不可达时的退路）
        const eventsSessionId = mode === 'session' ? sessId : String((playInfo && playInfo.rootSessionId) || '')

        // catalog 失败时的兜底：用归档 manifest.target 补映射（拿不到名字，仅会话↔周目映射）
        React.useEffect(() => {
          if (!archivePath || catalog.status !== 'ready' || !catalog.error) return
          const controller = new AbortController()
          ;(async () => {
            const raw = await readFileText(archivePath + '/manifest.json', controller.signal)
            const parsed = parseJsonOr(raw, 'manifest.json 不是合法 JSON')
            if (controller.signal.aborted) return
            setCatalog((s) => ({ ...s, index: mergeManifestHint(s.index, parsed) }))
          })().catch(() => {})   // 兜底失败保持安静：顶部已有 catalog 红字
          return () => controller.abort()
        }, [archivePath, catalog.status, catalog.error])

        // 顶栏的当前根人话名（第 2/3 级回退如实带徽标；完整值只进 title）
        let rootText = ''
        let rootTitle = ''
        let rootBadge = null
        let rootWarn = false
        if (mode === 'session') {
          if (sessId) {
            const ls = labelSession({ sessionId: sessId, title: null }, nameIdx)
            rootText = ls.text
            rootBadge = sourceBadge(ls.source)
            rootTitle = sessId
          } else {
            rootText = '未选择根会话'
            rootTitle = '到 ⚙ 设置里选择根会话'
            rootWarn = true
          }
        } else if (wsChar && wsPlay) {
          const charResolved = !!(nameIdx.charNames && nameIdx.charNames[wsChar])
          const playResolved = !!(playInfo && (playInfo.title || typeof playInfo.number === 'number'))
          rootText = labelCharacter(wsChar, nameIdx) + ' / ' + labelPlaythrough(wsPlay, nameIdx, { short: true })
          rootTitle = wsChar + ' / ' + wsPlay
          if (!charResolved || !playResolved) {
            rootBadge = { text: '目录缺失', title: 'catalog.json 没给出真名，显示的是短 ID（完整值可复制）' }
            rootWarn = true
          }
        } else {
          rootText = '工作区根未就绪'
          rootTitle = disc.status === 'loading' ? '正在发现归档…' : (disc.error || '到 ⚙ 设置里选择工作区根')
          rootWarn = true
        }

        const dot = host.healthStatus === 'ready'
          ? e('span', { style: { fontSize: 12, color: 'green' }, title: '宿主 API 已连接' }, '●')
          : host.healthStatus === 'loading'
            ? e('span', { style: { fontSize: 12, opacity: 0.6 }, title: '宿主 API 检测中…' }, '●')
            : e('span', {
              style: { fontSize: 12, color: 'crimson' },
              title: '宿主 API 不可用：' + (host.healthError || '未知原因') + '（配置功能受限；工作区阅读不依赖宿主）',
            }, '●')
        const viewBtn = (v) => Object.assign({}, btnStyle, { opacity: view === v ? 1 : 0.6, fontWeight: view === v ? 700 : 400 })

        return e('div', Object.assign({}, backdropStyle, { onClick: fullscreen ? undefined : onClose }),
          e('div', { style: fullscreen ? shellFullStyle : shellStyle, onClick: (ev) => ev.stopPropagation() },
            // 顶栏：★ 没有根模式单选（它只活在设置视图里）
            e('div', { style: headerStyle },
              e('strong', { style: { fontSize: 14 } }, '记忆库'),
              e('button', {
                style: Object.assign({}, btnStyle, { background: 'transparent', border: 'none', fontWeight: 700, fontSize: 13 }),
                onClick: () => setView('settings'), title: rootTitle,
              }, '当前根：' + rootText),
              rootBadge ? e('span', { style: rootWarn ? warnBadgeStyle : dimBadgeStyle, title: rootBadge.title }, rootBadge.text) : null,
              cfgReady && host.config.configError
                ? e('span', { style: errorStyle, title: String(host.config.configError) }, '⚠')
                : null,
              e('div', { style: { flex: 1 } }),
              dot,
              e('button', { style: viewBtn('prompts'), onClick: () => setView(view === 'prompts' ? 'read' : 'prompts'), title: '提示词（每次请求 / 压缩指令 / 收纳占位）' }, '提示词'),
              e('button', { style: viewBtn('settings'), onClick: () => setView('settings'), title: '设置（根模式 / 根选择 / API / 诊断）' }, '⚙ 设置'),
              e('button', { style: btnStyle, onClick: () => setFullscreen((v) => !v), title: fullscreen ? '退出全屏' : '全屏' }, '⛶'),
              e('button', { style: btnStyle, onClick: onClose, title: '关闭面板' }, '✕'),
            ),
            e('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
              view === 'read'
                ? e(ReadArea, {
                  key: mode + '|' + (archivePath || '') + '|' + (mode === 'session' ? sessId : ''),
                  mode: mode, tavernOk: tavernOk, healthStatus: host.healthStatus,
                  archivePath: archivePath, eventsSessionId: eventsSessionId,
                  nameIdx: nameIdx, catalogError: catalog.error,
                  sessions: sessions, onClose: onClose,
                  fullscreen: fullscreen, setFullscreen: setFullscreen,
                })
                : view === 'prompts'
                  ? e(PromptsView, { nameIdx: nameIdx, onBack: () => setView('read') })
                  : e(SettingsView, {
                    host: host, saveMode: saveMode, modeSave: modeSave, reload: reload,
                    nameIdx: nameIdx, catalog: catalog, disc: disc,
                    onPickWorkspace: (c, p) => setDisc((s) => ({ ...s, characterId: c, playthroughId: p })),
                    onPickSession: (sid) => setPickedSessionId(sid),
                    onBack: () => setView('read'),
                  }),
            ),
            view === 'read' && e(RootStatusLine, {
              mode: mode, wsChar: wsChar, wsPlay: wsPlay, sessId: sessId,
              archivePath: archivePath, nameIdx: nameIdx, disc: disc, catalogError: catalog.error,
            }),
          ),
        )
      }

      /** 唯一入口：侧边栏齿轮按钮（面板挂在这上面） */
      function apply(ctx) {
        const sessions = ctx.get('sessions')

        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'memory-archive' },
          function MemoryArchiveButton(props) {
            const [open, setOpen] = React.useState(false)
            return e('div', { style: { position: 'relative' } },
              e('button', {
                title: '记忆库 · 阅读与设置', 'aria-label': '记忆库 · 阅读与设置',
                onClick: () => setOpen((v) => !v),
                style: {
                  cursor: 'pointer', fontSize: props.wide ? 12 : 15, padding: '4px 8px',
                  background: 'transparent', color: 'CanvasText', border: 'none', borderRadius: 6,
                },
              }, props.wide ? '记忆库' : '⚙'),
              open && e(ArchivePanel, { sessions: sessions, onClose: () => setOpen(false) }),
            )
          },
        ))
      }

      exports.apply = apply
      // 注入名单：
      //   'slots'    —— 注册侧边栏 `sidebar.footer.action` 席位（插件唯一入口：齿轮按钮 + 完整面板）
      //   'sessions' —— 阅读源「会话搜索」用 ctx.get('sessions') 的 search/open（与根模式无关）
      exports.inject = ['slots', 'sessions']
      exports.name = 'dsh-memory-archive'

      // 仅供自检脚本直接调用内部纯函数；不对外承诺稳定，随时可能变化。
      exports.__internals = {
        buildCatalogIndex: buildCatalogIndex,
        shortId: shortId,
        labelCharacter: labelCharacter,
        labelPlaythrough: labelPlaythrough,
        labelSession: labelSession,
        pad4: pad4,
      }

      return module.exports
    })()
  },
})
