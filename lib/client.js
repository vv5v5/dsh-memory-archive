/**
 * dsh-memory-archive —— 客户端半侧（浏览器 bundle）v4.1 A 单「入口拆分 + 查看器对齐 DSH + 完整提示词 + 版块注释」
 *   + B 单「阅读区排版（ST 风格消息块）+ 编辑功能备注（只备注、不实现）」
 *   + C 单「点击反馈 + 分隔 + 辨识度（克制）」：内联 style 表达不了 :hover/:active/:focus-visible/:disabled，
 *     改为注入一个 <style id="dma-styles">（只注入一次、幂等），所有选择器都带 dma- 前缀类名，
 *     绝不命中 DSH 自有界面；颜色只用系统色（Canvas/ButtonFace/CanvasText/GrayText/ButtonBorder/Highlight），
 *     color-mix 只用 color-mix(in srgb, CanvasText N%, Canvas) 形式；B 单排版数字与 A 单功能一律未动。
 *   + D 单「正文 Markdown 基础美化 + CSS 兼容备忘 + 阅读源行微调」：
 *     parseMarkdown 纯函数（挂 __internals）+ MarkdownBody（每块 useMemo 解析一次；只构造 React 元素，
 *     无第三方 md 库、不经过 innerHTML 注入（React 无 HTML 注入属性）、任何输入不抛、畸形输入降级原样文本）；
 *     排版仍守 B 单硬指标（正文 16px / 行高 1.75，标题 ≤ 正文 1.35 倍，代码块 14px 等宽）；
 *     CSS 兼容只记备忘不实现（设置视图逐字一行 + CHANGELOG「计划中」+ 样式常量旁 TODO）；
 *     阅读源撤掉标签、删除搜索类阅读源（那一行就是一条干净的切换栏）。
 *
 * 格式：factory 形式 CJS，由 DSH 的 `window.__ModuleLoader__` 加载
 *   （react 在平台 seed 表内，所以**不需要构建**；无 JSX，全 React.createElement，别名 e）。
 * 暴露：`exports.apply` / `exports.inject` / `exports.name`，
 *   另有 `exports.__internals`（仅供自检脚本直接调用内部纯函数，不对外承诺稳定）。
 * 注册恰好 **2 个**席位（v4.1 契约变更：同一个插件占两席，id 必须不同）——
 *   都是 `sidebar.footer.action`（list；owner props {wide}）：
 *   1) id `memory-archive` —— 「记忆库」齿轮：阅读 / 提示词模板（压缩指令+收纳占位）/ 设置。
 *      ★ 每次请求查看器已从本面板拆出（v4 里它曾混在提示词块里）；仍不注册任何设置页席位。
 *   2) id `agent-editor`（v5 P0：由 prompt-viewer 升格）—— 「Agent 编辑器」：窄屏显示 `词`，
 *      title `Agent 编辑器 · 组成 / 每次请求 / 可写项`。独立浮层（自己的开合状态 / ✕ /
 *      AbortController），三块 + 两区：组成（preset 段/插件/order + 注释）/ 每次请求
 *      （原查看器整体搬入，一块不丢）/ 可写项（本版只读展示 + 一致性）/ Skill 区（组件内
 *      state，不落任何本地存储）/ 「生成 / 修复 RP agent」检测与预览（不落盘）。
 *      ⛔ v5 P0 零写入：不写任何 preset 文件、不建备份目录。
 *
 * 提示词查看器（v4.1）：
 *   · 会话列表与 DSH 侧边栏的工作区逻辑一致：分组标题「工作区」→ 工作区名（14px）→
 *     会话行（标题 14px + 相对时间 12px 右对齐）→ 超出折叠成「展开其余 N 个会话」（每组默认 8 条）；
 *     组内按 mtime 倒序、组间按组内最近 mtime 倒序；选中行高亮。
 *   · 工作区真名：宿主 /sessions 每行带 cwd（SessionHeader 来的），按 sessionId join 后取
 *     cwd 最后一个路径段（就是 DSH 侧边栏显示的那个名字）；拿不到 cwd 就解码项目 slug
 *     并标「（未解析出路径）」—— 不许假装真名。
 *   · 空会话：requests===0（解析过、确实没有请求）与 origin==='subagent'（子会话）默认隐藏；
 *     ★ requests===-1（未解析）不算空，照常显示。列表底部一行小结可切换 全部/仅有效。
 *   · 「完整」视图：把一次请求模型实际收到的全部内容按 system → tools → messages 顺序拼成
 *     一条长滚动（数据 = 现有三个 /api/part 各取一次，不需要新接口）。顶部给总字符数与各段
 *     占比 + 复制全文；★ 被宿主截断时显式标「已截断，原 N 字符」；★ 大文本按 2000 字符切块 +
 *     content-visibility:auto 渲染，绝不把 40 万字符塞进一个 <pre>。
 *   · 版块注释：完整视图与部件视图里每个版块标题旁一行浅色小字（title 悬停看全文），
 *     逐字来自规格 §2.6 的 12 行表；认不出的段写「未能识别归属」，storyAnchor 照原样标
 *     「归属待确认」。
 *
 * 面板（记忆库，阅读优先）：
 *   · 尺寸放大到 min(1280px,96vw) × min(860px,92vh)；⛶ 可切全屏（inset:0 / 100vw / 100vh / 直角）。
 *   · B 单排版：阅读区正文列 min(880px,100%) 水平居中、左右内边距 28px；楼层/摘要 = ST 风格消息块
 *     （极浅底色块 + 12px 浅色块头：楼号·角色·时间·字数·徽标），正文 16px / 行高 1.75 / 段间距 0.65em /
 *     块间距 14px；等宽内容（状态/提示词全文）ui-monospace 14px / 1.65；查看器四视图同一套指标。
 *     编辑功能只加备注不实现（设置视图一行小字 + 阅读区 TODO），没有新增任何写归档代码路径。
 *   · 顶栏 = 当前根的人话名（点击进设置）+ 提示词 + ⚙设置 + ⛶ + ✕ + 宿主 API 小圆点（悬停说明）。
 *     ★ v3 顶栏常驻的「根模式」单选已撤掉，只活在设置视图里。
 *   · 视图状态 view = 'read' | 'templates' | 'settings'：
 *     read = 阅读源 tabs + 连续阅读区（同一滚动区；键盘 PgUp/PgDn/空格/Home/End；Esc 先退全屏再关面板）；
 *     templates = 提示词模板两子页：压缩指令 + 收纳占位（「每次请求」已在 v4.1 拆去独立查看器）；
 *     settings = 次级视图：根模式单选 / 根选择（真名下拉）/ API 设置 / 诊断 + 「← 返回阅读」。
 *
 * 阅读源（随根模式变化，只显示可用的；默认源无数据自动退到下一个可用源并在顶部说明）：
 *   工作区模式：摘要（默认）/ 原文 / 状态；
 *     摘要 = summaries/index.json 顺序 + 滚动窗口 ≤2 顺序取正文，首尾相接渲染成一篇长文
 *           （>60 篇先渲染 60 篇 + 「加载后 20 篇」；保留前端子串过滤；每篇有「复制本篇」）；
 *     原文 = 一次 ?list=floors 拿楼号上限（失败退 visibility.json 键数），顺序懒加载
 *           （一次只取一个文件、最多预取 1 个）；visibility[sent===false] 的楼层标「未发给模型」；
 *           常驻工具条：跳到楼号 / 首楼 / 末楼 / 上一楼 / 下一楼；
 *     状态 = state/current.json 美化展示（JSON ⇒ 保持等宽原样，不 md 化）。
 *   会话模式：会话事件（默认）；
 *     事件 = limit=200 & offset 递增，滚到底自动追加；surface 如实标记（null 什么都不标）；
 *     大会话首次加载可能约 8 秒 —— 显式提示。
 *   Tavern 不可达：阅读区给可读原因；自动退到根会话事件（拿得到 rootSessionId 时）。
 *   ★ v4.1 D 单：搜索类阅读源已整体移除（玩家侧检索用浏览器 Ctrl+F 即可，面板里不留入口）；
 *     「阅读源」标签也撤掉了，那一行就是一条干净的切换栏。
 *   ★ v4.1 D 单：散文正文（摘要 / 原文楼层 mes / 会话事件正文）走基础 Markdown 渲染
 *     （parseMarkdown 纯函数挂 __internals；只支持标题/粗斜/行内码/围栏/列表/引用/分隔线/
 *     链接只显文本；任何输入不抛）；查看器 messages 视图每条消息正文同款；
 *     ⛔ system / tools / inventory / 完整 视图保持等宽原样 —— 那是喂给模型的原样 prompt，
 *     md 化会让人误判它「长这样」。
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
 * 提示词查看器（v4 第二单吸收，v4.1 A 单拆成独立入口并对齐 DSH）：
 *   数据面根是 /dsh-memory-archive/prompt；原插件的外壳与席位注册一律不带进来，两处入口
 *   各自独立开合。保留其纪律：列表首刷只扫目录（title:'' / requests:-1 是未解析哨兵，0 是
 *   「解析过、确实没有请求」的真值）、空闲批量 resolve（每批 ≤10、每次进入查看器/刷新列表累计硬上限
 *   TITLE_FILL_CAP=20 个、requestIdleCallback 排程、面板不活跃/刷新/卸载即中断不再排下一批）、
 *   AbortController、失败降级可读红字绝不抛出；会话标题过 labelSession。
 *   「压缩指令」「收纳占位」（记忆库面板内的模板子页）= 模板编辑卡片：一行状态（custom 徽标 + 字符数）/
 *   逐字解释（规格 §2）/ 多行 textarea（初值 = current）/ 保存·恢复内置默认·复制·载入内置默认 /
 *   折叠「官方原文参考」+ 出处说明 / 诚实提示。数据面 GET·PUT /api/templates：body 只带要改的键，
 *   null/空串 = 恢复内置默认；响应 = 写后回读的同形状，只信回读（保存/恢复后文本框同步成回读值）；
 *   400 CONFIG_INVALID → 可读红字。
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
      // v4.1 查看器：每组默认显示的会话行数（超出折叠成「展开其余 N 个会话」）
      const GROUP_ROW_LIMIT = 8
      // v4.1 完整视图：大文本按块渲染的块大小（§2.4 硬要求：不许把 40 万字符塞进一个 <pre>）
      const FULL_CHUNK_CHARS = 2000
      // 部件视图：文本超过这个长度也走分块渲染（同样不吃整段 <pre>）
      const PART_BIG_TEXT_CHARS = 20000
      // ---------- v4.1 B 单：阅读区排版常量（验收按浏览器 computed style 量，硬指标见规格 §2.1） ----------
      const READ_COL_WIDTH = 'min(880px, 100%)' // 正文列宽：880px 舒适行宽，窄屏自动全宽
      const READ_PAD_X = 28                     // 阅读区左右内边距（≥24）
      const BODY_FONT_SIZE = 16                 // 正文字号（15–16）
      const BODY_LINE_HEIGHT = 1.75             // 正文行高（≥1.7）
      const BODY_PARA_GAP = '0.65em'            // 段间距（≥0.6em）
      const BLOCK_GAP = 14                      // 块间距（≥12）
      const MONO_FONT_SIZE = 14                 // 等宽字号（状态/提示词全文）
      const MONO_LINE_HEIGHT = 1.65             // 等宽行高（≥1.6）
      const SMALL_FONT_SIZE = 12                // 小字：时间/字数/徽标/块头（≥12，颜色浅于正文）

      // ---------- v5 P0：Agent 编辑器（入口二升格，本版只读） ----------
      // Skill 区两段文案与预览底部一行逐字来自任务规格 §五，不许改写、不许精简。
      const AGENT_ENTRY_TITLE = 'Agent 编辑器 · 组成 / 每次请求 / 可写项'
      const SKILL_LINE = '启用后，AI 助手会按「RP agent 优化原则」帮你调整这个 RP agent（只动由本插件生成、位于沙箱内的那个 preset）。'
      const SKILL_RISK = '风险提示：改动会写入你的 agent preset 文件（每次应用前会自动备份，可一键回滚）。未启用时本编辑器只读。'
      const SKILL_NOTE = '勾选只保存在本界面（组件内 state，不落任何本地存储）；刷新后需重新勾选。'
      const DETECT_FOOTER = '本版只做检测与预览，不会写入任何文件。写入走下方 [应用]：先干跑预览（零写入），确认后才真落盘（自动备份 + 回读校验 + 不一致自动回滚）。'
      // v5 P2 可写项块三态文案（规格 §二.2.2 的官方语义口径）：
      //   可写 = preset.writable === true；只读 = 随部署附带；未知 = 读不到 preset（不猜）。
      // ★ KNOB_LOADING_TITLE：仅在「正在读取 preset…」的瞬态渲染，值逐字沿用 P0 的
      //   'P2 才实现写入' —— 冻结的 v5 P0 验收台 _selftest-client.mjs 对 loading 渲染做
      //   disabled+title 逐字断言（⛔ 本单不许改验收台）；数据一到就切下方三态，本值不再出现。
      const KNOB_LOADING_TITLE = 'P2 才实现写入'
      const KNOB_WRITABLE_NOTE = '可写（应用前自动备份；改完需新开会话或重启才完全生效）'
      const KNOB_READONLY_TITLE = '随部署附带，不可修改（agent-preset/read-only）'
      const KNOB_UNKNOWN_TITLE = '读不到 preset，先修数据面'
      // v5 P1a：真落盘 + 联动。/apply 与 /backups 挂在 /agent 之下（拆开拼，宿主 rest 表口径不变）。
      const AGENT_API = HOST_API_BASE + '/agent'
      // §4.3 逐字口径：任一侧缺依赖时的指引（不是报错），宿主响应与本地判断共用这句。
      const ROOT_MISSING_GUIDANCE = '记忆库还没有根（没有选定会话或周目归档）。点这里选一个根，或先「生成 / 修复 RP agent」。'

      // ---------- 样式（内联静态形状 + 系统色，不写死主题色）----------
      // C 单：cursor / background / color / opacity 这类「要随交互态变化」的属性一律交给注入的
      // dma-styles（见 DMA_CSS），内联只留静态形状（字号/内边距/边框）——内联优先级会压住 :hover/:disabled。
      const inputStyle = {
        padding: '6px 8px', fontSize: 13, background: 'Canvas', color: 'CanvasText',
        border: '1px solid color-mix(in srgb, CanvasText 30%, transparent)', borderRadius: 6,
      }
      const itemStyle = {
        padding: '6px 8px', fontSize: 12, lineHeight: 1.5, borderRadius: 6,
        border: '1px solid color-mix(in srgb, CanvasText 12%, transparent)',
      }
      const btnStyle = {
        fontSize: 12, padding: '4px 10px',
        border: '1px solid color-mix(in srgb, CanvasText 30%, transparent)', borderRadius: 6,
      }
      const miniBtnStyle = {
        fontSize: SMALL_FONT_SIZE, padding: '1px 6px',
        border: '1px solid color-mix(in srgb, CanvasText 15%, transparent)', borderRadius: 4,
      }
      const selectStyle = {
        fontSize: SMALL_FONT_SIZE, maxWidth: 220, padding: '2px 4px', background: 'Canvas', color: 'CanvasText',
        border: '1px solid color-mix(in srgb, CanvasText 30%, transparent)', borderRadius: 6,
      }
      const flowPreStyle = {
        margin: 0, padding: '12px 14px', fontFamily: MONO, fontSize: MONO_FONT_SIZE, lineHeight: MONO_LINE_HEIGHT,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        background: 'color-mix(in srgb, CanvasText 4%, Canvas)', color: 'CanvasText', borderRadius: 8,
      }
      // v5 P2 ③：提案式差异的改前/改后小块（应用卡确认视图与可写项块的「预览差异」共用）
      const diffPreStyle = {
        margin: 0, padding: '4px 6px', fontFamily: MONO, fontSize: SMALL_FONT_SIZE, lineHeight: 1.5,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 120, overflowY: 'auto',
        background: 'color-mix(in srgb, CanvasText 4%, Canvas)', borderRadius: 6,
      }
      const errorStyle = { fontSize: 12, color: 'crimson' }
      const okStyle = { fontSize: 12, color: 'green' }
      const warnStyle = { fontSize: 12, color: 'DarkGoldenrod' }
      // C 单：次要文字/时间/空态/加载态统一 GrayText（比正文弱、明暗自适应）
      const dimStyle = { fontSize: SMALL_FONT_SIZE, color: 'GrayText' }
      const colFillStyle = { display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minHeight: 0 }
      const statusAreaStyle = {
        display: 'flex', flexDirection: 'column', gap: 4,
        borderTop: '1px solid ButtonBorder', paddingTop: 6,
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
      // C 单：顶栏 ↔ 内容区的分隔（1px ButtonBorder，记忆库面板与查看器共用一套）
      const headerStyle = {
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flex: 'none',
        borderBottom: '1px solid ButtonBorder', paddingBottom: 8,
      }
      const cardStyle = {
        display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', borderRadius: 8,
        border: '1px solid color-mix(in srgb, CanvasText 15%, transparent)',
      }
      // C 单：小标题 13px + GrayText（规格硬要求：字号小于正文、颜色弱于正文）
      const sectionTitleStyle = { fontSize: 13, fontWeight: 700, color: 'GrayText' }
      const scrollColStyle = {
        flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, paddingRight: 2,
      }
      const fieldLabelStyle = { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12 }
      const rowLabelStyle = { fontSize: 12, opacity: 0.75, minWidth: 150, flex: 'none' }
      const monoDimStyle = { fontFamily: MONO, fontSize: SMALL_FONT_SIZE, opacity: 0.8, wordBreak: 'break-all' }
      // 连续阅读区的滚动容器（键盘滚动就绑在它上面；各阅读源共用）；
      // B 单：左右内边距 = READ_PAD_X（≥24），内容在容器里再经 readColStyle 居中限宽
      const readScrollStyle = {
        flex: 1, minHeight: 0, overflowY: 'auto', outline: 'none',
        display: 'flex', flexDirection: 'column', padding: '4px ' + READ_PAD_X + 'px 16px',
      }
      // B 单：ST 风格消息块 = 极浅底色（块间区分在「浅分隔线 / 极浅底色」二选一里选了底色，不再描边）
      // + 一行浅色小字段头 + 大号正文；块与块的间距由正文列的 gap（BLOCK_GAP ≥12）提供
      const msgBlockStyle = {
        background: 'color-mix(in srgb, CanvasText 4%, Canvas)', borderRadius: 8,
        padding: '10px 14px 12px', display: 'flex', flexDirection: 'column', gap: 6,
      }
      const msgHeadStyle = {
        display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap',
        fontSize: SMALL_FONT_SIZE, color: 'GrayText',
      }
      // C 单：徽标统一一套 12px 浅色胶囊（ButtonFace 底 + ButtonBorder 边 + 999 圆角），
      // 覆盖 未发给模型 / 来自周目目录 / 无标题 / 自定义 / 内置默认。
      const badgeCapsuleStyle = {
        fontSize: SMALL_FONT_SIZE, color: 'CanvasText', borderRadius: 999, padding: '0 8px',
        background: 'ButtonFace', border: '1px solid ButtonBorder',
      }
      // 「未发给模型」（visibility.json 的 sent === false）：同套胶囊，只加粗以示提醒
      const notSentBadgeStyle = Object.assign({}, badgeCapsuleStyle, { fontWeight: 700 })
      // 正文列：min(880px,100%) 水平居中（B 单硬指标）；readColFlexStyle 给查看器右栏里仍要撑满滚动的包装用
      const readColStyle = {
        flex: 'none', width: READ_COL_WIDTH, margin: '0 auto',
        display: 'flex', flexDirection: 'column', gap: BLOCK_GAP,
      }
      const readColFlexStyle = {
        flex: 1, minHeight: 0, width: READ_COL_WIDTH, margin: '0 auto',
        display: 'flex', flexDirection: 'column',
      }
      const dimBadgeStyle = badgeCapsuleStyle
      const warnBadgeStyle = {
        fontSize: SMALL_FONT_SIZE, color: 'crimson', borderRadius: 999, padding: '0 8px',
        background: 'color-mix(in srgb, crimson 8%, Canvas)',
        border: '1px solid color-mix(in srgb, crimson 40%, transparent)',
      }
      // v5 P0：正向徽标（已生效 / 一致 / 可写）—— 同套胶囊，绿色字
      const okBadgeStyle = Object.assign({}, badgeCapsuleStyle, { color: 'green' })
      // 提示词区·每次请求（吸收自 dsh-prompt-viewer）：三栏布局与专用样式
      const columnsStyle = { display: 'flex', gap: 8, flex: 1, minHeight: 0 }
      // C 单：查看器三栏之间的竖分隔线（1px ButtonBorder）
      const colSessionStyle = Object.assign({}, colFillStyle, { width: 200, flexShrink: 0, borderRight: '1px solid ButtonBorder', paddingRight: 8 })
      const colTurnStyle = Object.assign({}, colFillStyle, { width: 250, flexShrink: 0, borderRight: '1px solid ButtonBorder', paddingRight: 8 })
      const colPartStyle = Object.assign({}, colFillStyle, { flex: 1, minWidth: 0 })
      // C 单：选中态不再用内联底色（改 data-sel + Highlight/HighlightText，见 DMA_CSS），selectedStyle 已废
      const promptPreStyle = {
        margin: '0 auto', padding: '10px 12px', flex: 1, minHeight: 0, overflowY: 'auto',
        width: READ_COL_WIDTH,
        fontFamily: MONO, fontSize: MONO_FONT_SIZE, lineHeight: MONO_LINE_HEIGHT,
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

      // ---------- D 单备忘：CSS 兼容（只记备忘，不实现 —— 见 CHANGELOG「计划中（未实现）」与设置视图逐字备注）----------
      // TODO（CSS 兼容，将来要做必须先定三件事）：
      //   1) 注入点 —— 用户自定义样式以什么形式、什么时机插进来（现在只有一个幂等的 <style id="dma-styles">）；
      //   2) 命名空间 —— 沿用现有 dma- 前缀，用户选择器必须限定在该命名空间内，绝不命中 DSH 自有界面；
      //   3) 与 DSH 主题变量的映射 —— 现在只用系统色关键字（Canvas/CanvasText/ButtonFace/ButtonBorder/
      //      Highlight），要支持 DSH 主题变量覆盖需要一张「系统色 ⇔ DSH 主题 token」的映射表。
      // 当前刻意不做：不读取任何用户 CSS 文件、不暴露任何样式配置项（阅读保持只读、零样式入口）。

      // ---------- C 单：交互态样式注入（路线 2：<style id="dma-styles">，只注入一次、幂等）----------
      // 内联 style 表达不了 :hover/:active/:focus-visible/:disabled，这里集中用类名选择器表达。
      // ★ 硬约束自查：下面每一个选择器都以 .dma- 开头（没有任何裸元素/属性选择器会命中 DSH 自有界面）；
      // ★ 不引外部 CSS / 字体 / 图片 / @import；颜色只用系统色关键字 + 允许形式的 color-mix。
      const DMA_STYLE_ID = 'dma-styles'
      const DMA_CSS = [
        // 基础态（cursor/底色/文字色从这里来，内联不再写这些，避免压住交互态）
        '.dma-btn { cursor: pointer; background: Canvas; color: CanvasText; }',
        '.dma-row { cursor: pointer; }',
        '.dma-click { cursor: pointer; }',
        '.dma-mini { background: transparent; opacity: .72; }',
        '.dma-entry { background: transparent; }',
        '.dma-tab { opacity: .62; }',
        // 悬停：ButtonFace 底（可见但不抢眼）
        '.dma-btn:hover { background: ButtonFace; }',
        '.dma-mini:hover { background: ButtonFace; opacity: 1; }',
        '.dma-tab:hover { background: ButtonFace; opacity: 1; }',
        '.dma-row:hover { background: ButtonFace; }',
        // 按下：比悬停更强一档（低透明度正文色再叠一层 + 内阴影）
        '.dma-btn:active { background: color-mix(in srgb, CanvasText 14%, Canvas); box-shadow: inset 0 1px 2px color-mix(in srgb, CanvasText 18%, Canvas); }',
        // 键盘焦点环（Tab 走一遍看得出焦点在哪）
        '.dma-btn:focus-visible, .dma-row:focus-visible, .dma-radio:focus-visible { outline: 2px solid Highlight; outline-offset: 1px; }',
        // 选中态（全局统一一套）：Highlight 底 + HighlightText 字（放在 :hover 之后，选中行悬停不丢选中色）
        '.dma-row[data-sel="1"] { background: Highlight; color: HighlightText; }',
        '.dma-tab[data-sel="1"] { opacity: 1; background: Highlight; color: HighlightText; font-weight: 700; }',
        // 禁用：灰 + not-allowed（放最后，压过悬停/选中）
        '.dma-btn:disabled { opacity: .5; cursor: not-allowed; background: Canvas; box-shadow: none; }',
        '.dma-btn:disabled:hover, .dma-btn:disabled:active { background: Canvas; box-shadow: none; }',
      ].join('\n')

      // 只注入一次（幂等）：已有同 id 元素就不再插；没有 document（自检环境）就静默跳过，绝不抛
      function ensureDmaStyles() {
        try {
          if (typeof document === 'undefined' || !document || typeof document.getElementById !== 'function') return
          if (document.getElementById(DMA_STYLE_ID)) return
          const el = document.createElement('style')
          el.id = DMA_STYLE_ID
          el.textContent = DMA_CSS
          document.head.appendChild(el)
        } catch (error) { /* 注入失败降级为无交互态，绝不抛 */ }
      }

      // ---------- 工具 ----------
      function pad4(n) { return String(n).padStart(4, '0') }

      // 长值截断展示（应用卡里压缩指令 from→to 用；只影响显示，不影响写入内容）
      function clipText(text, max) {
        const s = String(text == null ? '' : text)
        return s.length <= max ? s : s.slice(0, max) + '…（共 ' + s.length + ' 字符）'
      }

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

      // ---------- 小组件：区块小标题 / 复制按钮（带短暂反馈）/ 来源徽标 / surface 徽标 ----------
      // C 单：区块小标题 —— 12px GrayText，字号小于正文、颜色弱于正文
      function SectionLabel({ text }) {
        return e('div', { style: { fontSize: SMALL_FONT_SIZE, color: 'GrayText', fontWeight: 600, letterSpacing: '0.02em' } }, text)
      }

      // C 单：复制成功给一次短暂反馈 —— 按钮文案临时变「已复制」，约 1.2s 复原；不弹 alert、不挡视线。
      // onCopy 返回 Promise：成功才闪「已复制」，失败交给既有红字行显示。
      function CopyFeedbackBtn({ label, onCopy, disabled, title }) {
        const [flash, setFlash] = React.useState(false)
        const timerRef = React.useRef(null)
        React.useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])
        const run = () => {
          Promise.resolve().then(onCopy).then(() => setFlash(true), () => {})
          if (timerRef.current) clearTimeout(timerRef.current)
          timerRef.current = setTimeout(() => setFlash(false), 1200)
        }
        return e('button', {
          className: 'dma-btn', style: btnStyle, disabled: disabled, title: title, onClick: run,
        }, flash ? '已复制' : (label || '复制'))
      }

      function CopyBtn({ value, label }) {
        const [flash, setFlash] = React.useState('')   // '' | 'ok' | 'fail'
        const timerRef = React.useRef(null)
        React.useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])
        const doCopy = (ev) => {
          ev.stopPropagation()
          copyText(String(value == null ? '' : value)).then(
            () => setFlash('ok'),
            () => setFlash('fail'),
          )
          if (timerRef.current) clearTimeout(timerRef.current)
          timerRef.current = setTimeout(() => setFlash(''), 1200)
        }
        return e('span', { style: { display: 'inline-flex', gap: 4, alignItems: 'baseline' }, onClick: (ev) => ev.stopPropagation() },
          e('button', {
            className: 'dma-btn dma-mini', style: miniBtnStyle, onClick: doCopy, title: '复制完整值到剪贴板',
          }, flash === 'ok' ? '已复制' : (label || '复制')),
          flash === 'fail' ? e('span', { style: { fontSize: SMALL_FONT_SIZE, color: 'crimson' } }, '复制失败 [COPY_FAIL]') : null,
        )
      }

      // surface 如实标记（不许猜）：current → 在上下文中；shadowed → 已被移出上下文；
      // log-only → 不上上下文；null → 什么都不标。
      function SurfaceBadge({ surface }) {
        if (surface === 'current') return e('span', { style: { fontSize: SMALL_FONT_SIZE, color: 'green' } }, '· 在上下文中')
        if (surface === 'shadowed') return e('span', { style: { fontSize: SMALL_FONT_SIZE, color: 'darkorange', fontWeight: 700 } }, '· 已被移出上下文')
        if (surface === 'log-only') return e('span', { style: { fontSize: SMALL_FONT_SIZE, opacity: 0.5 } }, '· 不上上下文')
        return null
      }

      // ---------- v4.1 D 单：正文 Markdown 基础美化（纯函数解析 + React 元素渲染） ----------
      // 只支持规格给的最小集合：#/##/### 标题、**粗**/__粗__、*斜*/_斜_、`行内代码`、``` 围栏代码块、
      // -/*/+ 与 1. 列表（2 空格一层嵌套）、> 引用、---/***/___ 分隔线、[文本](url) 只显文本（url 进
      // title，不导航不弹窗）。⛔ 不做表格/脚注/内联 HTML；⛔ 不引第三方 md 库、不经过 innerHTML 注入、
      // 不 eval —— 一律构造 React 元素。
      // ★ 应用范围（刻意收窄）：摘要正文 / 原文楼层正文（mes）/ 会话事件正文 / 查看器 messages 视图每条消息。
      //   ⛔ 绝不用于 system / tools / inventory / 完整 视图与任何提示词原文 —— 那是喂给模型的原样 prompt，
      //   md 化会让人误判它「长这样」；它们继续等宽原样显示。状态源是 JSON，也保持等宽。
      // ★ 任何输入都不许抛：未闭合围栏、落单 **、空串、非字符串、超长单行一律降级成原样文本。
      // ★ 性能：每个文本块经 MarkdownBody 的 React.useMemo 解析一次（摘要区实测 31 块），
      //   不在每次 render 重解析；超大文本沿用既有分块策略（PART_BIG_TEXT_CHARS / ChunkedText）。

      // 行内解析：{t:'text'|'b'|'i'|'bi'|'code'|'a', s, href?}。
      // 多趟替换（行内代码 → 链接 → 粗 → 斜体），命中片段换成 \u0000 序号占位符暂存；各趟的内容
      // 字符类都排除 \u0000 与界定符，保证占位符不嵌套、已解析片段不被重扫。落单 ** / 配不上的
      // 记法不匹配 ⇒ 原样保留（这就是「畸形输入降级」）。** 在 * 之前匹配，所以 **粗** 不会被配成两个斜体。
      function parseInlineMarkdown(input) {
        const stash = []
        const stashSpan = (span) => { stash.push(span); return '\u0000' + (stash.length - 1) + '\u0000' }
        let s = typeof input === 'string' ? input : ''
        s = s.replace(/`([^`\u0000\n]+)`/g, (m, code) => stashSpan({ t: 'code', s: code }))
        s = s.replace(/\[([^\]\u0000\n]+)\]\(([^)\u0000\n]*)\)/g, (m, label, href) => {
          const url = href.trim()
          if (url === '') return m   // 空 url：降级原样
          return stashSpan({ t: 'a', s: label, href: url })
        })
        s = s.replace(/\*\*\*([^\u0000*]+)\*\*\*/g, (m, x) => stashSpan({ t: 'bi', s: x }))
        s = s.replace(/\*\*([^\u0000*]+)\*\*/g, (m, x) => stashSpan({ t: 'b', s: x }))
        s = s.replace(/__([^_\u0000]+)__/g, (m, x) => stashSpan({ t: 'b', s: x }))
        s = s.replace(/\*([^\u0000*\n]+)\*/g, (m, x) => stashSpan({ t: 'i', s: x }))
        // _斜体_：开头不得是字母/数字（snake_case 不误配），结尾也不得是字母/数字
        s = s.replace(/(^|[^\w])_([^_\u0000\n]+)_(?!\w)/g, (m, pre, x) => pre + stashSpan({ t: 'i', s: x }))
        const out = []
        const parts = s.split(/\u0000(\d+)\u0000/g)
        for (let i = 0; i < parts.length; i++) {
          if (i % 2 === 0) { if (parts[i] !== '') out.push({ t: 'text', s: parts[i] }) }
          else out.push(stash[Number(parts[i])] || { t: 'text', s: '' })
        }
        return out
      }

      // 块解析（纯函数，对外暴露为 __internals.parseMarkdown）：
      //   {kind:'h1'|'h2'|'h3', spans} / {kind:'p', spans} / {kind:'ul'|'ol', items:[{level, num?, spans}]}
      //   {kind:'quote', lines:[spans,…]} / {kind:'code', lang, text} / {kind:'hr'}
      // 未闭合围栏不猜：整段按原样文本输出（含 ``` 行本身）。
      function parseMarkdownBlocks(text) {
        const lines = text.split('\n')
        const blocks = []
        const isBlank = (l) => l.trim() === ''
        const HR_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/
        const UL_RE = /^(\s*)([-*+])\s+(.*)$/
        const OL_RE = /^(\s*)(\d{1,9})\.\s+(.*)$/
        let i = 0
        while (i < lines.length) {
          const line = lines[i]
          if (isBlank(line)) { i++; continue }
          const fence = /^\s{0,3}```\s*(\S*)\s*$/.exec(line)
          if (fence) {
            const body = []
            let closed = false
            i++
            while (i < lines.length) {
              if (/^\s{0,3}```\s*$/.test(lines[i])) { closed = true; i++; break }
              body.push(lines[i]); i++
            }
            if (closed) blocks.push({ kind: 'code', lang: fence[1] || '', text: body.join('\n') })
            else blocks.push({ kind: 'p', spans: [{ t: 'text', s: line + (body.length ? '\n' + body.join('\n') : '') }] })
            continue
          }
          if (HR_RE.test(line)) { blocks.push({ kind: 'hr' }); i++; continue }
          const head = /^\s{0,3}(#{1,3})\s+(.+?)\s*$/.exec(line)
          if (head) { blocks.push({ kind: 'h' + head[1].length, spans: parseInlineMarkdown(head[2]) }); i++; continue }
          if (/^\s{0,3}>/.test(line)) {
            const qlines = []
            while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
              qlines.push(lines[i].replace(/^\s{0,3}>\s?/, '')); i++
            }
            blocks.push({ kind: 'quote', lines: qlines.map(parseInlineMarkdown) })
            continue
          }
          const mu = UL_RE.exec(line)
          const mo = OL_RE.exec(line)
          if (mu || mo) {
            const ordered = !!mo
            const items = []
            while (i < lines.length) {
              const l = lines[i]
              if (isBlank(l)) break
              const u2 = UL_RE.exec(l)
              const o2 = OL_RE.exec(l)
              if (ordered ? !o2 : !u2) break
              const mm = ordered ? o2 : u2
              const indent = mm[1].replace(/\t/g, '  ').length
              const item = { level: Math.min(3, Math.floor(indent / 2)), spans: parseInlineMarkdown(mm[3]) }
              if (ordered) item.num = parseInt(mm[2], 10)
              items.push(item)
              i++
            }
            blocks.push({ kind: ordered ? 'ol' : 'ul', items: items })
            continue
          }
          const plines = [line]
          i++
          while (i < lines.length && !isBlank(lines[i])
            && !/^\s{0,3}```/.test(lines[i]) && !HR_RE.test(lines[i])
            && !/^\s{0,3}#{1,3}\s+/.test(lines[i]) && !/^\s{0,3}>/.test(lines[i])
            && !UL_RE.test(lines[i]) && !OL_RE.test(lines[i])) {
            plines.push(lines[i]); i++
          }
          blocks.push({ kind: 'p', spans: parseInlineMarkdown(plines.join('\n')) })
        }
        return blocks
      }

      // 对外纯函数（挂 __internals.parseMarkdown）：包一层兜底 —— 「任何输入都不许抛」是硬约束，
      // 正常实现不该走到 catch，宁可多一道保险：异常时降级成单段原样文本。
      function parseMarkdown(input) {
        const raw = typeof input === 'string' ? input : (input == null ? '' : String(input))
        try {
          return parseMarkdownBlocks(raw)
        } catch (error) {
          return [{ kind: 'p', spans: [{ t: 'text', s: raw }] }]
        }
      }

      // D 单排版：标题可略大但 ≤ 正文 1.35 倍（16 × 1.35 = 21.6 ⇒ h1=21）；代码块 14px 等宽 1.6（B 单常量）
      const MD_HEADING_FONT_SIZE = { h1: 21, h2: 18, h3: 16 }
      const MD_UL_BULLETS = ['•', '◦', '▪']

      function renderMarkdownSpans(spans, keyBase) {
        const arr = Array.isArray(spans) ? spans : []
        return arr.map((sp, i) => {
          const key = keyBase + '-' + i
          const text = sp && typeof sp.s === 'string' ? sp.s : ''
          if (sp && sp.t === 'b') return e('strong', { key: key }, text)
          if (sp && sp.t === 'i') return e('em', { key: key }, text)
          if (sp && sp.t === 'bi') return e('strong', { key: key, style: { fontStyle: 'italic' } }, text)
          if (sp && sp.t === 'code') {
            return e('code', {
              key: key,
              style: { fontFamily: MONO, fontSize: '0.9em', background: 'ButtonFace', borderRadius: 4, padding: '0 4px' },
            }, text)
          }
          if (sp && sp.t === 'a') {
            // 链接只显文本：url 放 title 悬停；不渲染 <a>，面板里绝不导航/弹窗
            return e('span', {
              key: key, title: String(sp.href || ''),
              style: { textDecoration: 'underline', textDecorationStyle: 'dashed', textUnderlineOffset: 2, cursor: 'help' },
            }, text)
          }
          return text
        })
      }

      // 散文正文渲染入口：每个文本块 useMemo 解析一次；
      // 正文 16px / 行高 1.75 / 段间距 0.65em / 块间距 BLOCK_GAP（B 单硬指标不动），正文用比例字体（不套等宽）
      function MarkdownBody({ text }) {
        const srcText = typeof text === 'string' ? text : ''
        const blocks = React.useMemo(() => parseMarkdown(srcText), [srcText])
        return e('div', { style: { fontSize: BODY_FONT_SIZE, lineHeight: BODY_LINE_HEIGHT, color: 'CanvasText' } },
          blocks.map((b, i) => {
            const key = 'md' + i
            const first = i === 0
            if (b.kind === 'hr') {
              return e('hr', { key: key, style: { border: 'none', borderTop: '1px solid ButtonBorder', margin: '0.7em 0' } })
            }
            if (b.kind === 'code') {
              return e('pre', {
                key: key,
                style: {
                  margin: first ? 0 : '0.65em 0 0', padding: '8px 10px',
                  fontFamily: MONO, fontSize: MONO_FONT_SIZE, lineHeight: MONO_LINE_HEIGHT,
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  background: 'color-mix(in srgb, CanvasText 4%, Canvas)', color: 'CanvasText', borderRadius: 6,
                },
              }, typeof b.text === 'string' ? b.text : '')
            }
            if (b.kind === 'h1' || b.kind === 'h2' || b.kind === 'h3') {
              return e('div', {
                key: key,
                style: {
                  fontSize: MD_HEADING_FONT_SIZE[b.kind] || BODY_FONT_SIZE, fontWeight: 700,
                  lineHeight: 1.35, color: 'CanvasText', marginTop: first ? 0 : '0.9em',
                },
              }, renderMarkdownSpans(b.spans, key))
            }
            if (b.kind === 'quote') {
              return e('div', {
                key: key,
                style: {
                  borderLeft: '3px solid ButtonBorder', paddingLeft: 10, color: 'GrayText',
                  marginTop: first ? 0 : BODY_PARA_GAP,
                },
              }, (Array.isArray(b.lines) ? b.lines : []).map((spans, j) => e('div', {
                key: key + 'l' + j, style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
              }, renderMarkdownSpans(spans, key + 'l' + j))))
            }
            if (b.kind === 'ul' || b.kind === 'ol') {
              return e('div', { key: key, style: { marginTop: first ? 0 : BODY_PARA_GAP } },
                (Array.isArray(b.items) ? b.items : []).map((item, j) => e('div', {
                  key: key + 'i' + j,
                  style: { display: 'flex', gap: 6, paddingLeft: (item.level || 0) * 22, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
                },
                  e('span', { style: { flex: 'none', opacity: 0.75 } },
                    b.kind === 'ol'
                      ? String(item.num != null ? item.num : j + 1) + '.'
                      : MD_UL_BULLETS[Math.min(item.level || 0, MD_UL_BULLETS.length - 1)]),
                  e('span', null, renderMarkdownSpans(item.spans, key + 'i' + j)))))
            }
            return e('div', {
              key: key,
              style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: first ? 0 : BODY_PARA_GAP },
            }, renderMarkdownSpans(b.spans, key))
          }),
        )
      }

      // ---------- 阅读源·摘要（工作区）：索引顺序 + 滚动窗口 ≤2 顺序取正文 → 一篇长文 ----------
      // TODO（编辑功能 —— 直接修改摘要正文/楼层正文/状态档案 —— 尚未实现，见 CHANGELOG「计划中（未实现）」；
      //  设置视图里有面向用户的逐字备注）：不先做，是因为写入会改归档文件，必须先定
      //  「改哪一份真相源（archive/ 还是会话日志）」与回滚策略；在此之前阅读区保持只读，
      //  本文件因此没有任何写归档/写工作区文件的代码路径（唯一写入仍是宿主半侧的插件自身配置与模板）。
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
          const head = '摘要 · 第 ' + String(entry.fromFloor != null ? entry.fromFloor : '?') + '–' + String(entry.toFloor != null ? entry.toFloor : '?') + ' 楼'
            + (typeof entry.chars === 'number' ? ' · ' + fmtChars(entry.chars) + ' 字' : '')
            + (entry.createdAt ? ' · ' + formatTime(entry.createdAt) : '')
          return e('div', { key: 'p' + i, style: msgBlockStyle },
            e('div', { style: msgHeadStyle },
              e('span', { style: { fontWeight: 700 }, title: String(entry.id || '') + (entry.model ? ' · ' + entry.model : '') }, head),
              superseded ? e('span', { style: dimBadgeStyle, title: '新条目：' + String(entry.supersededBy) }, '已更新') : null,
              entry.partial ? e('span', { style: dimBadgeStyle }, '部分覆盖') : null,
              e('span', { style: { flex: 1 } }),
              e(CopyBtn, { value: typeof body === 'string' ? body : '', label: '复制本篇' }),
            ),
            typeof body === 'string' ? e(MarkdownBody, { text: body })
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
          e('div', Object.assign({}, scrollBind),
            e('div', { style: readColStyle }, pieces,
              state.status === 'ready' && shownTotal < state.entries.length
                ? e('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flex: 'none', paddingBottom: 6 } },
                  e('button', { className: 'dma-btn', style: btnStyle, onClick: () => setLimit(limit + SUMMARY_MORE_STEP) }, '加载后 20 篇'),
                  e('span', { style: dimStyle }, '还有 ' + (state.entries.length - shownTotal) + ' 篇未加载'),
                )
                : null)),
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
          const mesChars = typeof data.mes === 'string' ? data.mes.length : null
          blocks.push(e('div', { key: 'f' + n, ref: (el) => { anchors.current[n] = el }, style: msgBlockStyle },
            e('div', { style: msgHeadStyle },
              e('span', { style: { fontWeight: 700 } }, '第 ' + n + ' 楼'),
              e('span', null, role),
              data.name ? e('span', null, String(data.name)) : null,
              data.send_date ? e('span', null, formatTime(data.send_date)) : null,
              mesChars !== null ? e('span', null, fmtChars(mesChars) + ' 字') : null,
              notSent ? e('span', { style: notSentBadgeStyle }, '未发给模型') : null,
            ),
            typeof data.mes === 'string'
              ? e(MarkdownBody, { text: data.mes })
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
            e('button', { className: 'dma-btn', style: btnStyle, onClick: () => jumpTo(parseInt(ui.input, 10)) }, '跳到楼号'),
            e('button', { className: 'dma-btn', style: btnStyle, disabled: first === undefined, onClick: () => jumpTo(first) }, '首楼'),
            e('button', { className: 'dma-btn', style: btnStyle, disabled: last === undefined, onClick: () => jumpTo(last) }, '末楼'),
            e('button', { className: 'dma-btn', style: btnStyle, disabled: st.nums.length === 0, onClick: () => step(-1) }, '← 上一楼'),
            e('button', { className: 'dma-btn', style: btnStyle, disabled: st.nums.length === 0, onClick: () => step(1) }, '下一楼 →'),
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
          e('div', Object.assign({}, scrollBind, { onScroll: onScroll }),
            e('div', { style: readColStyle }, blocks)),
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
            ? e('div', Object.assign({}, scrollBind), e('div', { style: readColStyle },
              e('pre', { style: flowPreStyle }, state.text)))
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
              className: 'dma-btn',
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
            e('div', { style: readColStyle },
              visible.map((ev, i) => {
                const seq = ev && typeof ev.seq === 'number' ? ev.seq : null
                const open = seq !== null && openSeq === seq
                return e('div', {
                  key: seq !== null ? String(seq) : 'i' + String(i),
                  className: 'dma-row',
                  style: itemStyle,
                  onClick: () => { if (seq !== null) setOpenSeq(open ? null : seq) },
                },
                  e('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', fontSize: SMALL_FONT_SIZE } },
                    e('span', { style: { fontFamily: MONO, opacity: 0.65 } }, seq !== null ? '#' + String(seq) : '#?'),
                    e('span', { style: { fontWeight: 700 } }, String((ev && ev.role) || '?')),
                    e('span', { style: { opacity: 0.6 } }, formatTime(ev && ev.time)),
                    e('span', { style: { opacity: 0.6 } }, String((ev && ev.type) || '')),
                    e(SurfaceBadge, { surface: ev ? ev.surface : null }),
                  ),
                  open && e(MarkdownBody, { text: String((ev && ev.text) || '') }),
                )
              }))),
        )
      }

      // ---------- 阅读区：源 tabs（只显示可用的）+ 默认源自适应 + 连续滚动区 + 键盘 ----------
      // D 单：搜索类阅读源已整体移除（玩家侧检索用浏览器 Ctrl+F 即可，面板里不留入口）——
      // 会话模式只剩会话事件；工作区模式 摘要/原文/状态；Tavern 不可达时退根会话事件，拿不到就无源可读
      function computeSources(mode, tavernOk, eventsSessionId) {
        if (mode === 'session') {
          return eventsSessionId ? [['events', '会话事件']] : []
        }
        if (!tavernOk) {
          // Tavern 不可达：工作区归档读不到；若拿得到根会话 ID（目录缓存/manifest），退到会话事件
          return eventsSessionId ? [['events', '会话事件']] : []
        }
        return [['summaries', '摘要'], ['floors', '原文'], ['state', '状态']]
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

      function ReadArea({ mode, tavernOk, healthStatus, archivePath, eventsSessionId, nameIdx, catalogError, onClose, fullscreen, setFullscreen }) {
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
            + (eventsSessionId ? '已退到根会话的「会话事件」。' : '根会话 ID 也拿不到，暂无可读内容；到 ⚙ 设置选好根会话后可看「会话事件」。')))
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
        if (sources.length === 0) {
          banners.push(e('div', { key: 'nosrc', style: dimStyle }, '没有可用的阅读源。'))
        }

        let content = null
        if (cur === 'summaries') {
          content = e(SummariesFlow, { archivePath: archivePath, scrollBind: scrollBind, reportLoad: makeReport('summaries') })
        } else if (cur === 'floors') {
          content = e(FloorsFlow, { archivePath: archivePath, scrollBind: scrollBind, reportLoad: makeReport('floors') })
        } else if (cur === 'state') {
          content = e(StateFlow, { archivePath: archivePath, scrollBind: scrollBind })
        } else if (cur === 'events') {
          content = e(EventsFlow, { sessionId: eventsSessionId, nameIdx: nameIdx, scrollBind: scrollBind, reportLoad: makeReport('events') })
        }
        // D 单：搜索类源已删 —— 没有可用源时 content 为 null，上面已有可读说明

        return e('div', { style: colFillStyle },
          // D 单：撤掉「阅读源」标签并重调这一行的间距（tab 间距 4→6、行首留 2px 光学对齐、
          // 与下方分隔线的距离 6→8）—— 现在是一整条正常的切换栏，不再像少了半截；
          // 切换条 ↔ 阅读区之间仍是 1px ButtonBorder 分隔线
          e('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', flex: 'none', alignItems: 'center', borderBottom: '1px solid ButtonBorder', padding: '0 0 8px 2px' } },
            sources.map((pair) => e('button', {
              key: pair[0],
              className: 'dma-btn dma-tab',
              'data-sel': cur === pair[0] ? '1' : '0',
              style: btnStyle,
              onClick: () => setActive(pair[0]),
            }, pair[1]))),
          banners,
          notice ? e('div', { style: { fontSize: 12, color: 'darkorange' } }, notice) : null,
          e('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } }, content),
        )
      }

      // =====================================================================
      // 提示词区（v4 第二单吸收；v4.1 起每次请求查看器为独立入口）：PART_TABS 见上方 PartTabs 处
      // =====================================================================
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

      // =====================================================================
      // v4.1 A 单：工作区名解析 / 空会话过滤 / 相对时间 / 版块注释（纯函数，可被自检直接调用）
      // =====================================================================

      // 工作区真名 = cwd 的最后一个路径段（这就是 DSH 侧边栏显示的那个名字）；
      // Windows 反斜杠与 POSIX 斜杠都认；拿不到给 ''（调用方降级去解码 slug）。
      function workspaceLabelFromCwd(cwd) {
        if (typeof cwd !== 'string') return ''
        const s = cwd.trim()
        if (s === '') return ''
        const parts = s.split(/[\\/]+/).filter((p) => p !== '' && p !== ':')
        return parts.length > 0 ? parts[parts.length - 1] : ''
      }

      // 项目 slug 解码：~XXXX（4 位十六进制 = 一个 UTF-16 码元）→ 对应字符，去掉首尾 --。
      // slug 里的单个 - 无法区分「路径分隔符」和「名字里的连字符」，按原样保留（不许假装真名）。
      function decodeWorkspaceSlug(slug) {
        if (typeof slug !== 'string') return ''
        let s = slug
        if (s.startsWith('--')) s = s.slice(2)
        if (s.endsWith('--')) s = s.slice(0, -2)
        return s.replace(/~([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      }

      // 空会话过滤（纯函数）：requests===0 = 解析过、确实没有任何请求 ⇒ 'empty'；
      // origin==='subagent' ⇒ 'subagent'；★ requests===-1（未解析）不算空 ⇒ null，必须照常显示。
      function hiddenSessionReason(row) {
        if (!row || typeof row !== 'object') return null
        if (row.origin === 'subagent') return 'subagent'
        if (row.requests === 0) return 'empty'
        return null
      }

      // 相对时间（DSH 侧边栏口径）：2分钟 / 1小时 / 15小时 / 3天；nowMs 仅供自检注入，缺省取当前时间。
      function relativeTime(value, nowMs) {
        const t = typeof value === 'number' ? value : Date.parse(String(value == null ? '' : value))
        if (!Number.isFinite(t)) return ''
        const now = Number.isFinite(nowMs) ? nowMs : Date.now()
        const sec = Math.max(0, Math.floor((now - t) / 1000))
        if (sec < 60) return '刚刚'
        const min = Math.floor(sec / 60)
        if (min < 60) return min + '分钟'
        const hr = Math.floor(min / 60)
        if (hr < 24) return hr + '小时'
        const day = Math.floor(hr / 24)
        if (day < 30) return day + '天'
        const mon = Math.floor(day / 30)
        if (mon < 12) return mon + '个月'
        return Math.floor(mon / 12) + '年'
      }

      // 会话行按工作区分组（与 DSH 侧边栏一致）：组内 mtime 倒序、组间按组内最近 mtime 倒序。
      // cwdLookup(id) → cwd 字符串 | null：任一会话解析出 cwd ⇒ 组名取其最后一段（resolved=true）；
      // 全组都拿不到 ⇒ 组名 = slug 解码 + resolved=false（界面上如实标「未解析出路径」）。
      function groupSessionsByWorkspace(items, cwdLookup) {
        const withTime = (Array.isArray(items) ? items : []).map((row) => {
          const mtimeMs = row && typeof row.mtime === 'string' ? Date.parse(row.mtime) : NaN
          return { row: row, mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : 0 }
        })
        withTime.sort((a, b) => b.mtimeMs - a.mtimeMs)
        const groups = new Map()
        for (const it of withTime) {
          const slug = String((it.row && it.row.workspace) || '')
          let g = groups.get(slug)
          if (!g) {
            g = { slug: slug, label: '', resolved: false, mtimeMs: it.mtimeMs, rows: [] }
            groups.set(slug, g)
          }
          g.rows.push(it)
          if (it.mtimeMs > g.mtimeMs) g.mtimeMs = it.mtimeMs
          if (!g.resolved && typeof cwdLookup === 'function') {
            const label = workspaceLabelFromCwd(cwdLookup(String(it.row && it.row.id)))
            if (label !== '') {
              g.label = label
              g.resolved = true
            }
          }
        }
        const out = []
        for (const g of groups.values()) {
          if (!g.resolved) g.label = decodeWorkspaceSlug(g.slug) || g.slug || '（未知工作区）'
          out.push(g)
        }
        out.sort((a, b) => b.mtimeMs - a.mtimeMs)
        return out
      }

      // 宿主 /api/part 截断标记识别（prompt-viewer.js 的 clipText 在文末追加「…（已截断，原 N 字符）」）。
      // 识别到就剥掉标记、返回原文长度 —— 界面上要显式标注，不许假装完整。
      const CLIP_RE = /…（已截断，原 (\d+) 字符）$/
      function clipInfo(text) {
        if (typeof text !== 'string') return { text: '', truncated: false, original: null }
        const m = CLIP_RE.exec(text)
        if (m) return { text: text.slice(0, text.length - m[0].length), truncated: true, original: Number(m[1]) }
        return { text: text, truncated: false, original: null }
      }

      // 千分位（确定性写法，不依赖宿主 locale）
      function fmtChars(n) {
        return Number.isFinite(n) ? String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : String(n)
      }

      // ---------- 版块注释（规格 §2.6 的 12 行表：谁注入 + order + 作用，逐字使用，不许改写） ----------
      const NOTE_IDENTITY = 'DSH 核心注入的 agent 身份与环境说明：告诉模型它在 DSH 里、检出目录在哪、GUI 上下文与行为纪律。恒定注入，永远排在最前。'
      const NOTE_PERSONA = '部署/agent 配置里的人设与定位（这个 agent 是谁、怎么说话）。'
      const NOTE_PRESET = '当前所选预设的固定段：ST 预设归一化后的系统提示内容（身份与文风主要来自这里）。'
      const NOTE_RP_POLICY = 'RP 模式策略段。默认只说明“高风险操作被锁”，不是扮演身份；身份与文风仍来自 preset / 角色卡。'
      const NOTE_STATE_CARD = 'L1 状态卡：由副 LLM 每轮记账的当前状态（数值/分组/到期），让模型不必从正文里重算。'
      const NOTE_ANIMA = 'L2 检索记忆：从历史里检索出来的摘录（<recalledMemories>）与近场历史（<immediateHistory>）。只对 RP 会话注入。'
      const NOTE_TOOL_GUIDE = '工具的使用说明与纪律，和下面 tools 里的定义配套。'
      const NOTE_COMPACTED = '被压缩出上下文的那段历史（checkpoint）。前言由官方 frameSummary() 拼出，作用是告诉模型“这是既成背景，别复述”。'
      const NOTE_TOOLS = '这次请求可用的工具定义（名字 + 参数 schema）。几十个属于正常量级。'
      const NOTE_MESSAGES = '真实历史轮次；其中可能夹着 durable 注入的快照（例如 context() 的每轮快照）。'
      const NOTE_ST_CHAR = '角色卡字段（SillyTavern 格式）在 system 里的落点。'
      const NOTE_STORY_ANCHOR = '（归属待确认）疑似剧情锚点相关注入；没查到确定的注入方，先如实标注。'
      const NOTE_UNKNOWN = '未能识别归属（未匹配到已知注入点）'

      const WHO_IDENTITY = 'DSH 核心（harness identity，order ≈ -100）'
      const WHO_PERSONA = 'DSH 核心（Agent/deployment persona，order ≈ 0）'
      const WHO_PRESET = 'pmp-dsh-tavern（order 10）'
      const WHO_RP_POLICY = 'pmp-dsh-tavern（order 45）'
      const WHO_STATE_CARD = 'dsh-state-bridge（order 50）'
      const WHO_ANIMA = 'dsh-anima-rag（order 55）'
      const WHO_TOOL_GUIDE = 'DSH 核心（order 100–199）'
      const WHO_COMPACTED = 'DSH 官方 compaction（compaction-basic）'
      const WHO_TOOLS = 'DSH 核心'
      const WHO_MESSAGES = '会话本身'
      const WHO_ST_CHAR = 'pmp-dsh-tavern'
      const WHO_STORY_ANCHOR = '归属待确认'

      // system 段里的已知注入点（怎么认出来 = 标记子串，与宿主半侧 MARKS 同源）
      const SYS_SECTION_DEFS = [
        { key: 'identity', label: 'system 开头 · harness identity', who: WHO_IDENTITY, note: NOTE_IDENTITY,
          markers: ['You are an AI agent powered by DeepSeek Harness', 'harness:identity'] },
        // 部署级人设没有独立标记：按 order 位置认（紧随 identity 之后的那一段，见 splitSystemSections）
        { key: 'persona', label: '部署级人设（deployment persona）', who: WHO_PERSONA, note: NOTE_PERSONA, markers: [] },
        { key: 'preset', label: 'dsh-tavern preset', who: WHO_PRESET, note: NOTE_PRESET, markers: ['dsh-tavern preset'] },
        { key: 'rpPolicy', label: 'rp:policy', who: WHO_RP_POLICY, note: NOTE_RP_POLICY, markers: ['rp:policy'] },
        { key: 'stateCard', label: 'state:card', who: WHO_STATE_CARD, note: NOTE_STATE_CARD, markers: ['state:card', '【当前状态】'] },
        { key: 'anima', label: 'anima:memory', who: WHO_ANIMA, note: NOTE_ANIMA, markers: ['anima:memory', '<recalledMemories>', '<immediateHistory>'] },
        // 工具引导（order 100–199）没有固定标记：只认未识别段里提及 tool/工具 的顶层标题（启发式，宁缺勿猜）
        { key: 'toolGuide', label: '工具引导段', who: WHO_TOOL_GUIDE, note: NOTE_TOOL_GUIDE, markers: [] },
        { key: 'compacted', label: '压缩 checkpoint（<compacted-summary>）', who: WHO_COMPACTED, note: NOTE_COMPACTED, markers: ['<compacted-summary>'] },
        { key: 'stChar', label: '角色卡字段（st-character-field）', who: WHO_ST_CHAR, note: NOTE_ST_CHAR, markers: ['st-character-field'] },
        { key: 'storyAnchor', label: 'storyAnchor', who: WHO_STORY_ANCHOR, note: NOTE_STORY_ANCHOR, markers: ['storyAnchor'] },
      ]
      const UNKNOWN_SECTION = { key: 'unknown', label: 'system（未识别）', who: '', note: NOTE_UNKNOWN }

      function sectionDefOf(key) {
        for (const d of SYS_SECTION_DEFS) {
          if (d.key === key) return d
        }
        return null
      }

      // 把 system 全文按已知注入点切段，每段给 {label, who, note, text}：
      //   · 每个标记子串的位置就是段边界；连续命中同一注入点只开一段。
      //   · identity 之前的残余并进 identity 段（规格：恒定注入，永远排在最前，前面不该有别的东西）。
      //   · 紧随 identity 的未识别段 ⇒ 部署级人设（order 0，位置认）。
      //   · 末尾：最后一个标记所在块（空行分隔）结束之后剩下的非空白内容单独成 unknown 段
      //     —— 不能因为最后一段没有后续标记就被吞掉；空行/纯空白不算一段。
      //   · 其余未识别段：标题提及 tool/工具 才算工具引导，否则如实标「未能识别归属」，不许编。
      function splitSystemSections(text) {
        if (typeof text !== 'string' || text === '') return []
        const hits = []
        for (const def of SYS_SECTION_DEFS) {
          for (const mk of def.markers) {
            let i = text.indexOf(mk)
            while (i !== -1) {
              hits.push({ index: i, key: def.key })
              i = text.indexOf(mk, i + mk.length)
            }
          }
        }
        if (hits.length === 0) return [Object.assign({ text: text }, UNKNOWN_SECTION)]
        hits.sort((a, b) => a.index - b.index)
        const bounds = []
        for (const h of hits) {
          const last = bounds.length > 0 ? bounds[bounds.length - 1] : null
          if (last && last.key === h.key) continue
          bounds.push(h)
        }
        const sections = []
        for (let i = 0; i < bounds.length; i++) {
          const start = i === 0 ? 0 : bounds[i].index
          const end = i + 1 < bounds.length ? bounds[i + 1].index : text.length
          sections.push({ key: bounds[i].key, text: text.slice(start, end) })
        }
        // 末尾裁切：最后一个标记自己所在的块结束（第一个空行）之后若还剩非空白内容，
        // 剩余部分单独成 unknown 段；尾部是纯空白则不凭空造段。
        const lastStart = bounds[bounds.length - 1].index
        const brk = /\n\s*\n/.exec(text.slice(lastStart))
        if (brk) {
          let ts = lastStart + brk.index
          while (ts < text.length && /\s/.test(text[ts])) ts++
          if (ts < text.length) {
            sections[sections.length - 1].text = text.slice(lastStart, lastStart + brk.index)
            sections.push({ key: 'unknown', text: text.slice(ts) })
          }
        }
        const idAt = sections.findIndex((s) => s.key === 'identity')
        if (idAt >= 0 && sections[idAt + 1] && sections[idAt + 1].key === 'unknown') {
          sections[idAt + 1].key = 'persona'
        }
        for (const s of sections) {
          if (s.key === 'unknown' && /(^|\n)#{1,2}\s+[^\n]*(tool|工具)[^\n]*(\n|$)/i.test(s.text)) {
            s.key = 'toolGuide'
          }
        }
        return sections.map((s) => {
          const def = sectionDefOf(s.key)
          return def ? Object.assign({}, def, { text: s.text }) : Object.assign({ text: s.text }, UNKNOWN_SECTION)
        })
      }

      // messages 全文（宿主拼装形如 `── [seq N] role ──\n正文`）按条切开；形状变了返回 null（调用方整段渲染）
      function splitMessagesText(text) {
        if (typeof text !== 'string' || text === '') return null
        const re = /^── \[seq ([^\]]*)\] (user|assistant) ──$/gm
        const marks = []
        let m
        while ((m = re.exec(text)) !== null) {
          marks.push({ start: m.index, end: re.lastIndex, seq: m[1], role: m[2] })
        }
        if (marks.length === 0) return null
        const out = []
        if (marks[0].start > 0) out.push({ seq: null, role: null, text: text.slice(0, marks[0].start) })
        for (let i = 0; i < marks.length; i++) {
          const end = i + 1 < marks.length ? marks[i + 1].start : text.length
          out.push({ seq: marks[i].seq, role: marks[i].role, text: text.slice(marks[i].end, end) })
        }
        return out
      }

      // ---------- 大文本分块渲染（§2.4 硬要求）：2000 字符一块 + content-visibility:auto ----------
      function ChunkedText({ text, query }) {
        const src = typeof text === 'string' ? text : ''
        const chunks = []
        for (let i = 0; i < src.length; i += FULL_CHUNK_CHARS) {
          chunks.push(src.slice(i, i + FULL_CHUNK_CHARS))
        }
        if (chunks.length === 0) chunks.push('')
        return e('div', {
          style: {
            fontFamily: MONO, fontSize: MONO_FONT_SIZE, lineHeight: MONO_LINE_HEIGHT,
            width: READ_COL_WIDTH, margin: '0 auto',
          },
        },
          chunks.map((c, i) => e('div', {
            key: String(i),
            style: {
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              contentVisibility: 'auto',
              containIntrinsicSize: 'auto ' + String(Math.max(24, Math.ceil(c.length / 70) * 24)) + 'px',
            },
          }, query ? highlight(c, query) : c)),
        )
      }

      // ---------- messages 视图（部件）：每条消息正文走基础 Markdown（★ md 在查看器里的唯一入口） ----------
      // 宿主拼装形如 `── [seq N] role ──\n正文`；拆开后每条消息正文 md 渲染（应用范围见 parseMarkdown 注释）。
      // ⛔ system / tools / inventory / 完整 视图不经这里 —— 那是喂给模型的原样 prompt，保持等宽原样。
      // 带搜索词时退回等宽分块高亮（搜索要保住子串高亮能力）；单条超大文本沿用分块策略（不整段塞 <pre>）。
      function ViewerMessagesBody({ text, query }) {
        const blocks = splitMessagesText(typeof text === 'string' ? text : '')
        if (!blocks) {
          // 形状变了（没有消息分隔标记）：按原样整段渲染，不猜
          return e(ChunkedText, { text: typeof text === 'string' ? text : '', query: query })
        }
        return e('div', { style: { display: 'flex', flexDirection: 'column', gap: BLOCK_GAP } },
          blocks.map((b, i) => {
            const body = typeof b.text === 'string' ? b.text.replace(/^\n/, '') : ''
            const big = body.length > PART_BIG_TEXT_CHARS
            return e('div', { key: String(i), style: msgBlockStyle },
              e('div', { style: msgHeadStyle },
                e('span', { style: { fontWeight: 700 } },
                  '[' + (b.role || '?') + ']' + (b.seq !== null && b.seq !== undefined ? ' · seq ' + b.seq : '')),
              ),
              query || big
                ? e(ChunkedText, { text: body, query: query })
                : e(MarkdownBody, { text: body }),
            )
          }))
      }

      // 版块注释：标题旁一行浅色小字（§2.6）；title 悬停看全文（谁注入 + order + 作用）
      function SectionNote({ label, who, note }) {
        return e('span', {
          style: { fontSize: SMALL_FONT_SIZE, opacity: 0.55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
          title: (who ? '谁注入：' + who + '。' : '') + '作用：' + note,
        }, (label ? label + ' —— ' : '') + note)
      }

      // 部件视图 / 完整视图共用的版块 tabs（v4.1：新增「完整」）
      // ★ tab 常驻：未选中请求的初始态也要渲染出来（置灰禁用）——「完整」视图必须可达。
      const PART_TABS = [['system', 'system'], ['tools', 'tools'], ['inventory', 'inventory'], ['messages', '消息流'], ['full', '完整']]
      function PartTabs({ part, setPart, disabled }) {
        const off = !!disabled
        return e('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' } },
          PART_TABS.map((pair) => e('button', {
            key: pair[0],
            className: 'dma-btn dma-tab',
            'data-sel': part === pair[0] ? '1' : '0',
            disabled: off,
            title: off ? '先选一次请求，再切换版块' : undefined,
            style: btnStyle,
            onClick: () => setPart(pair[0]),
          }, pair[1])))
      }

      // ---------- 子页 A·左栏：会话列表（工作区分组，与 DSH 侧边栏逻辑一致） ----------
      // 首刷只扫目录；标题过 labelSession 三级回退；requests===0 / origin==='subagent' 默认隐藏
      // （-1 未解析不算空）；每组默认 8 条，超出折叠成「展开其余 N 个会话」。
      function ViewerSessionList({ state, hostById, hostError, selectedId, onSelect, onRefresh, nameIdx }) {
        const [filter, setFilter] = React.useState('')
        const [expanded, setExpanded] = React.useState(() => new Set())
        const [showAll, setShowAll] = React.useState(false)
        const q = filter.trim().toLowerCase()
        const joinOf = (row) => {
          const hit = hostById ? hostById.get(String(row.id)) : null
          return hit || null
        }
        const reasonOf = (row) => hiddenSessionReason({ requests: row.requests, origin: (joinOf(row) || {}).origin })
        let nEmpty = 0
        let nSub = 0
        for (const row of state.items) {
          const r = reasonOf(row)
          if (r === 'empty') nEmpty++
          else if (r === 'subagent') nSub++
        }
        const kept = showAll ? state.items : state.items.filter((row) => reasonOf(row) === null)
        const filtered = q === ''
          ? kept
          : kept.filter((row) => {
            const j = joinOf(row) || {}
            const hay = (String(row.title) + ' ' + String(row.id) + ' ' + String(row.workspace) + ' ' + String(j.cwd || '')).toLowerCase()
            return hay.indexOf(q) !== -1
          })
        const groups = groupSessionsByWorkspace(filtered, (id) => {
          const hit = hostById ? hostById.get(String(id)) : null
          return hit && typeof hit.cwd === 'string' ? hit.cwd : null
        })
        const rowLabel = (s) => labelSession({
          sessionId: s.id,
          title: isUnparsed(s) || typeof s.title !== 'string' || s.title === '' ? null : s.title,
        }, nameIdx)
        const toggleGroup = (slug) => setExpanded((prev) => {
          const next = new Set(prev)
          if (next.has(slug)) next.delete(slug)
          else next.add(slug)
          return next
        })
        return e('div', { style: colSessionStyle },
          e('div', { style: { display: 'flex', gap: 4 } },
            e('input', {
              id: 'dma-viewer-session-filter', name: 'dma-viewer-session-filter',
              'aria-label': '按标题/id/工作区路径过滤会话列表',
              style: Object.assign({}, inputStyle, { flex: 1, minWidth: 0 }), placeholder: '过滤：标题 / id / 工作区',
              value: filter, onChange: (ev) => setFilter(ev.target.value),
            }),
            e('button', { className: 'dma-btn', style: btnStyle, title: '重新扫描会话列表', onClick: onRefresh }, '↻')),
          state.status === 'loading' && e('div', { style: dimStyle }, '正在扫描会话列表…'),
          state.status === 'error' && e('div', { style: errorStyle }, '会话列表加载失败：' + state.error),
          state.status === 'ready' && e('div', { style: dimStyle },
            '共 ' + state.items.length + ' 个 · 显示 ' + filtered.length + ' 个'),
          e('div', { style: promptListStyle },
            state.status === 'ready' && e(SectionLabel, { text: '会话' }),
            state.status === 'ready' && hostError && e('div', { style: dimStyle },
              '宿主 /sessions 不可用（' + hostError + '）：工作区名从 slug 解码，子会话识别不可用'),
            groups.map((g) => {
              const open = expanded.has(g.slug)
              const shown = open ? g.rows : g.rows.slice(0, GROUP_ROW_LIMIT)
              // C 单：工作区分组之间（组顶部 1px ButtonBorder）、分组标题 ↔ 会话行（标题下 1px ButtonBorder）
              return e('div', { key: g.slug, style: { display: 'flex', flexDirection: 'column', gap: 2, borderTop: '1px solid ButtonBorder', paddingTop: 4 } },
                e('div', {
                  style: { fontSize: 14, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', borderBottom: '1px solid ButtonBorder', paddingBottom: 3 },
                  title: g.resolved
                    ? '工作区名来自该组会话 cwd 的最后一个路径段'
                    : 'cwd 不可得：这是项目 slug 解码的结果，不是已确认的真名',
                }, g.label + (g.resolved ? '' : '（未解析出路径）')),
                shown.map((it) => {
                  const s = it.row
                  const ls = rowLabel(s)
                  const r = reasonOf(s)
                  return e('div', {
                    key: s.id,
                    className: 'dma-row',
                    'data-sel': s.id === selectedId ? '1' : '0',
                    style: Object.assign({}, itemStyle, { display: 'flex', gap: 8, alignItems: 'baseline' }),
                    onClick: () => onSelect(s.id),
                    title: String(s.id) + (g.resolved ? '' : ' · ' + String(s.workspace)),
                  },
                    e('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 } },
                      highlight(ls.text, filter)),
                    r === 'subagent' ? e('span', { style: dimBadgeStyle }, '子') : null,
                    r === 'empty' ? e('span', { style: dimBadgeStyle }, '空') : null,
                    e('span', { style: { fontSize: 12, opacity: 0.6, flexShrink: 0 } }, relativeTime(s.mtime)),
                  )
                }),
                g.rows.length > GROUP_ROW_LIMIT ? e('button', {
                  className: 'dma-btn dma-mini',
                  style: Object.assign({}, miniBtnStyle, { alignSelf: 'flex-start', fontSize: 12 }),
                  onClick: () => toggleGroup(g.slug),
                }, open ? '收起' : '展开其余 ' + (g.rows.length - GROUP_ROW_LIMIT) + ' 个会话') : null,
              )
            }),
            state.status === 'ready' && filtered.length === 0 && e('div', { style: dimStyle }, '没有匹配的会话'),
          ),
          state.status === 'ready' && (nEmpty > 0 || nSub > 0) && e('button', {
            className: 'dma-btn dma-mini',
            style: Object.assign({}, miniBtnStyle, { flex: 'none' }),
            title: '空会话 = 解析过但一次模型请求都没有（requests=0）；子会话 = origin=subagent；'
              + '未解析（requests=-1）不算空，照常显示',
            onClick: () => setShowAll((v) => !v),
          }, '已隐藏 ' + nEmpty + ' 个空会话 / ' + nSub + ' 个子会话' + (showAll ? '（点击只看有效）' : '（点击显示全部）')),
        )
      }

      // ---------- 子页 A·中栏：该会话每一次模型请求的 composition 摘要 ----------
      function PromptRequestList({ detail, selectedTurn, onSelect }) {
        const label = e(SectionLabel, { text: '请求' })
        if (detail.status === 'idle') return e('div', { style: colTurnStyle }, label, e('div', { style: dimStyle }, '← 先选一个会话'))
        if (detail.status === 'loading') return e('div', { style: colTurnStyle }, label, e('div', { style: dimStyle }, '正在解析会话…'))
        if (detail.status === 'error') {
          return e('div', { style: colTurnStyle }, label, e('div', { style: errorStyle }, '会话解析失败：' + detail.error))
        }
        const meta = detail.meta || {}
        const presetNote = meta.effectivePreset && meta.effectivePreset !== meta.agentPreset ? '（中途切换，实际生效）' : ''
        return e('div', { style: colTurnStyle },
          label,
          e('div', { style: { fontSize: SMALL_FONT_SIZE, opacity: 0.7, wordBreak: 'break-all' } },
            'preset: ' + (meta.effectivePreset || '-') + presetNote),
          e('div', { style: dimStyle },
            detail.requests.length === 0
              ? '★ 这个会话没有 request/header（没跑过模型请求）'
              : '共 ' + detail.requests.length + ' 次模型请求'),
          e('div', { style: promptListStyle },
            detail.requests.map((r) => e('div', {
              key: r.index,
              className: 'dma-row',
              'data-sel': r.index === selectedTurn ? '1' : '0',
              style: itemStyle,
              onClick: () => onSelect(r.index),
              title: 'seq=' + r.seq + ' · ' + r.provider + '/' + r.model,
            },
              e('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 6 } },
                e('span', { style: { fontWeight: 700 } }, '#' + r.index + ' · ' + (r.reason || '?')),
                e('span', { style: { opacity: 0.6 } }, String(r.maxTokens == null ? '-' : r.maxTokens))),
              e('div', { style: { opacity: 0.75 } }, r.provider + '/' + r.model + ' · effort=' + (r.reasoningEffort || '-')),
              e('div', { style: { opacity: 0.75 } },
                'system ' + r.systemChars + ' 字 · tools ' + r.toolCount + ' 个 / ' + r.toolChars + ' 字'),
              (r.marks || []).length > 0 && e('div', { style: { opacity: 0.6, fontSize: SMALL_FONT_SIZE } }, '检出: ' + r.marks.join('  ')),
            ))),
        )
      }

      // ---------- 子页 A·右栏：tools 列表 / inventory 分组 / 部件 tabs + 注释 + 搜索高亮 + 复制 ----------
      function PromptToolsListView({ tools, query }) {
        return e('div', { style: promptListStyle },
          tools.map((t) => e('div', { key: t.name, style: toolRowStyle },
            e('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              highlight(t.name, query)),
            e('span', { style: { opacity: 0.6, flexShrink: 0 } }, String(t.chars) + ' 字'))),
        )
      }

      // v4.1：每个版块标题旁一行注释（§2.6 逐字）；超长文本走分块渲染，不再整段塞 <pre>。
      function PromptPartView({ sessionId, turn, part, setPart, state, query, setQuery, onCopy }) {
        if (!sessionId || !turn) {
          // 初始态：版块 tab 常驻（置灰禁用），排版空态可见；右栏只给提示不发请求。
          return e('div', { style: colPartStyle },
            e(SectionLabel, { text: '部件' }),
            e(PartTabs, { part: part, setPart: setPart, disabled: true }),
            e('div', { style: dimStyle }, '← 再选一次请求（第 N 次）'))
        }
        const text = state.status === 'ready' && state.data && typeof state.data.text === 'string' ? state.data.text : null
        const tools = state.status === 'ready' && state.data && Array.isArray(state.data.tools) ? state.data.tools : null
        const toolNote = (part === 'tools' || part === 'inventory')
          ? e(SectionNote, { label: 'tools 清单', who: WHO_TOOLS, note: NOTE_TOOLS })
          : null
        const msgNote = part === 'messages' ? e(SectionNote, { label: 'messages 流', who: WHO_MESSAGES, note: NOTE_MESSAGES }) : null
        // system 部件视图：把已识别的注入段逐条列出（label + 一句话注释，悬停看谁注入 + order）
        const sysSections = part === 'system' && typeof text === 'string' && text !== '' ? splitSystemSections(text) : []
        // D 单：messages 视图 = 每条消息正文走基础 Markdown（★ 只经 ViewerMessagesBody 这一个入口）；
        // system / tools / inventory 保持等宽原样（喂给模型的原样 prompt，md 化会误导）
        const textBody = typeof text !== 'string' ? null
          : part === 'messages'
            ? e(ViewerMessagesBody, { text: text, query: query })
            : (text.length > PART_BIG_TEXT_CHARS
              ? e(ChunkedText, { text: text, query: query })
              : e('pre', { style: promptPreStyle }, highlight(text, query)))
        return e('div', { style: colPartStyle },
          e(SectionLabel, { text: '部件' }),
          e('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' } },
            e(PartTabs, { part: part, setPart: setPart }),
            e('span', { style: { flex: 1 } }),
            e(CopyFeedbackBtn, { label: '复制', title: '复制当前部件全文', onCopy: onCopy }),
          ),
          e('input', {
            id: 'dma-viewer-search', name: 'dma-viewer-search',
            'aria-label': '在当前请求已加载文本里搜索',
            style: inputStyle, placeholder: '在当前已加载文本里搜索（子串高亮，纯前端）…',
            value: query, onChange: (ev) => setQuery(ev.target.value),
          }),
          state.status === 'loading' && e('div', { style: dimStyle }, '正在加载 #' + turn + ' 的 ' + part + ' …'),
          state.status === 'error' && e('div', { style: errorStyle }, '加载失败：' + state.error),
          state.status === 'ready' && toolNote,
          state.status === 'ready' && msgNote,
          state.status === 'ready' && sysSections.length > 0 && e('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
            e('div', { style: dimStyle }, '检出 ' + sysSections.length + ' 段（悬停看谁注入 + order）：'),
            sysSections.map((sec, i) => e(SectionNote, {
              key: String(i), label: sec.label + '（' + fmtChars(sec.text.length) + ' 字符）', who: sec.who, note: sec.note,
            }))),
          state.status === 'ready' && textBody,
          state.status === 'ready' && tools !== null && e('div', { style: readColFlexStyle },
            part === 'inventory'
              ? e(PromptInventoryView, { tools: tools, query: query })
              : e(PromptToolsListView, { tools: tools, query: query })),
          state.status === 'ready' && text === '' && e('div', { style: dimStyle }, '（该部件为空）'),
        )
      }

      // ---------- 完整视图（v4.1）：一次请求模型实际收到的全部内容，按 system → tools → messages 拼成一条长滚动 ----------
      // 数据 = 现有三个 /api/part 各取一次（不需要新接口）。截断显式标注；大文本分块渲染。
      function buildFullPlainText(d) {
        const parts = []
        if (d.system) {
          parts.push('===== system =====\n' + d.system.text
            + (d.system.truncated ? '\n（已截断，原 ' + fmtChars(d.system.original) + ' 字符）' : ''))
        }
        if (d.tools) {
          parts.push('===== tools（' + d.tools.length + ' 个）=====\n'
            + d.tools.map((t) => String(t.name) + '  (' + String(t.chars) + ' 字符)').join('\n'))
        }
        if (d.messages) {
          parts.push('===== messages =====\n' + d.messages.text
            + (d.messages.truncated ? '\n（已截断，原 ' + fmtChars(d.messages.original) + ' 字符）' : ''))
        }
        return parts.join('\n\n')
      }

      function FullPromptView({ sessionId, turn, part, setPart, state, onCopyFull }) {
        if (!sessionId || !turn) {
          // 初始态同样把 tab 常驻渲染（置灰禁用）：「完整」入口在空态就要可见。
          return e('div', { style: colPartStyle },
            e(SectionLabel, { text: '部件' }),
            e(PartTabs, { part: part, setPart: setPart, disabled: true }),
            e('div', { style: dimStyle }, '← 再选一次请求（第 N 次）'))
        }
        const tabsRow = e('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' } },
          e(PartTabs, { part: part, setPart: setPart }),
          e('span', { style: { flex: 1 } }),
          e(CopyFeedbackBtn, {
            label: '复制全文', disabled: state.status !== 'ready',
            title: '把 system / tools / messages 全文按顺序复制到剪贴板',
            onCopy: onCopyFull,
          }),
        )
        if (state.status === 'loading') {
          return e('div', { style: colPartStyle }, e(SectionLabel, { text: '部件' }), tabsRow,
            e('div', { style: dimStyle }, '正在取 #' + turn + ' 的 system / tools / messages 三段（各一次请求）…'))
        }
        if (state.status === 'error') {
          return e('div', { style: colPartStyle }, e(SectionLabel, { text: '部件' }), tabsRow,
            e('div', { style: errorStyle }, '完整视图加载失败：' + state.error))
        }
        const d = state.data || {}
        const sys = d.system || null
        const tools = d.tools || null
        const msg = d.messages || null
        const sysLen = sys ? sys.text.length : 0
        const msgLen = msg ? msg.text.length : 0
        const toolsCount = tools ? tools.length : 0
        const toolsChars = tools ? tools.reduce((n, t) => n + (typeof t.chars === 'number' ? t.chars : 0), 0) : 0
        const total = sysLen + msgLen + toolsChars
        const pct = (n) => (total > 0 ? Math.round((n / total) * 100) : 0)
        const truncBadge = (info) => info && info.truncated
          ? e('span', {
            style: warnBadgeStyle,
            title: '宿主对单段全文有 400000 字符上限，超出部分没有取回来 —— 这里不是完整原文',
          }, '已截断，原 ' + fmtChars(info.original) + ' 字符')
          : null
        const sections = sys ? splitSystemSections(sys.text) : []
        const msgBlocks = msg ? splitMessagesText(msg.text) : null
        const sysPart = e('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: 'none' } },
          e('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
            e('span', { style: { fontWeight: 700, fontSize: 13 } },
              '① system 段（' + fmtChars(sysLen) + ' 字符）'),
            truncBadge(sys)),
          sys
            ? sections.map((sec, i) => e('div', { key: String(i), style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              e('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
                e('span', { style: { fontWeight: 700, fontSize: 12 } },
                  '· ' + sec.label + '（' + fmtChars(sec.text.length) + ' 字符）'),
                e(SectionNote, { label: '', who: sec.who, note: sec.note })),
              e(ChunkedText, { text: sec.text })))
            : e('div', { style: errorStyle }, 'system 段取不到（见顶部错误行）'))
        const toolsPart = e('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: 'none' } },
          e('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
            e('span', { style: { fontWeight: 700, fontSize: 13 } },
              '② tools 清单（' + toolsCount + ' 个 / ' + fmtChars(toolsChars) + ' 字符）'),
            e(SectionNote, { label: '', who: WHO_TOOLS, note: NOTE_TOOLS })),
          tools
            ? e(PromptToolsListView, { tools: tools, query: '' })
            : e('div', { style: errorStyle }, 'tools 清单取不到（见顶部错误行）'))
        const msgPart = e('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: 'none' } },
          e('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
            e('span', { style: { fontWeight: 700, fontSize: 13 } },
              '③ messages（' + (msgBlocks ? msgBlocks.length + ' 条' : '整段') + ' / ' + fmtChars(msgLen) + ' 字符）'),
            truncBadge(msg),
            e(SectionNote, { label: '', who: WHO_MESSAGES, note: NOTE_MESSAGES })),
          msg
            ? (msgBlocks
              ? msgBlocks.map((b, i) => e('div', { key: String(i), style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                e('div', { style: { fontSize: 12, fontWeight: 700, opacity: 0.8 } },
                  '[' + (b.role || '?') + ']' + (b.seq !== null && b.seq !== undefined ? ' (seq ' + b.seq + ')' : '')),
                e(ChunkedText, { text: b.text })))
              : e(ChunkedText, { text: msg.text }))
            : e('div', { style: errorStyle }, 'messages 段取不到（见顶部错误行）'))
        return e('div', { style: colPartStyle },
          e(SectionLabel, { text: '部件' }),
          tabsRow,
          state.status === 'ready' && state.error && e('div', { style: errorStyle }, '部分内容取不到：' + state.error),
          e('div', { style: dimStyle },
            '共 ' + fmtChars(total) + ' 字符 · system ' + pct(sysLen) + '% / tools ' + pct(toolsChars) + '% / messages ' + pct(msgLen) + '%'
            + '（按模型实际收到的顺序拼装；messages 为宿主提供的整段历史）'),
          e('div', { style: promptListStyle },
            e('div', { style: readColStyle }, sysPart, toolsPart, msgPart)),
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
            return e('div', { key: g.prefix, className: 'dma-row', style: itemStyle, onClick: () => toggle(g.prefix) },
              e('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } },
                e('span', { style: { fontWeight: 700 } }, highlight(g.prefix, query)),
                e('span', { style: { opacity: 0.6, flexShrink: 0 } },
                  g.count + ' 个 / ' + g.chars + ' 字 / ' + pct + '%')),
              open && e('div', { style: { marginTop: 4, opacity: 0.75, fontSize: SMALL_FONT_SIZE, wordBreak: 'break-all' } },
                g.names.length <= 12
                  ? g.names.join(', ')
                  : g.names.slice(0, 10).join(', ') + ', …（共 ' + g.names.length + ' 个）'),
            )
          }),
        )
      }

      // ---------- v5 P0：组成块（preset 的段/插件/order 清单 + 一句注释；拿不到给可读原因，不白屏） ----------
      // 数据 = 宿主 GET /api/agent 的 sections（宿主侧按 v4 的 12 条注释口径标注）。
      // 可折叠：给中间的「每次请求」三栏腾地方。
      function CompositionBlock({ agent }) {
        const [open, setOpen] = React.useState(true)
        const toggleBtn = e('button', {
          className: 'dma-btn dma-mini', style: Object.assign({}, miniBtnStyle, { flex: 'none' }),
          onClick: () => setOpen((v) => !v), title: open ? '收起组成块（给每次请求腾地方）' : '展开组成块',
        }, open ? '▾ 组成' : '▸ 组成')
        if (!open) {
          return e('div', { style: colSessionStyle }, toggleBtn,
            e('div', { style: dimStyle }, '（已收起）'))
        }
        const sections = agent.status === 'ready' && agent.data && Array.isArray(agent.data.sections)
          ? agent.data.sections
          : null
        return e('div', { style: Object.assign({}, colSessionStyle, { width: 250 }) },
          e('div', { style: { display: 'flex', gap: 4, alignItems: 'center', flex: 'none' } }, toggleBtn),
          e('div', { style: Object.assign({}, dimStyle, { flex: 'none' }) }, '该 preset 的段 / 插件 / order'),
          agent.status === 'loading' && e('div', { style: dimStyle }, '正在读取 preset…'),
          agent.status === 'error' && e('div', { style: errorStyle }, 'preset 组成读取失败：' + agent.error),
          agent.status === 'ready' && e('div', { style: promptListStyle },
            sections && sections.length === 0 && e('div', { style: dimStyle }, '未检出任何已知段/插件'),
            (sections || []).map((sec, i) => e('div', {
              key: String(i),
              style: { display: 'flex', flexDirection: 'column', gap: 1, paddingBottom: 4, borderBottom: '1px solid color-mix(in srgb, CanvasText 8%, transparent)' },
              title: String(sec.source || '') ? '来源：' + String(sec.source) : undefined,
            },
              e('div', { style: { display: 'flex', gap: 6, alignItems: 'baseline' } },
                e('span', { style: { fontSize: 12, fontWeight: 700, wordBreak: 'break-all' } }, String(sec.name || '?')),
                e('span', { style: { fontFamily: MONO, fontSize: SMALL_FONT_SIZE, opacity: 0.7, flexShrink: 0 } }, String(sec.order == null ? '' : sec.order))),
              e('span', {
                style: { fontSize: SMALL_FONT_SIZE, opacity: 0.55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
                title: String(sec.note || ''),
              }, String(sec.note || '')),
            ))),
          agent.status === 'ready' && agent.data && typeof agent.data.error === 'string' && agent.data.error
            ? e('div', { style: dimStyle }, agent.data.error)
            : null,
        )
      }

      // ---------- v5 P2：可写项块（4 类 knob 当前值 + 一致性 + 写入入口） ----------
      // P1a 已让检测视图的 ⑤ 应用卡真写入；本块补上同一套入口，消除 P1a 留下的自相矛盾
      //（面板旧文案声称写入要等下一版，而应用卡已能真写）。三态（规格 §二.2.2，拿不到就如实说，不猜）：
      //   preset.writable === true  → 三按钮解禁：预览差异 = 本块内 dryRun（零写入，含 ③ 逐行 diff）；
      //                               应用/回滚 = 切到检测视图的 ⑤ 应用卡 / ⑥ 备份卡（同一条流：先干跑再确认）。
      //   preset.writable === false → 按钮禁用，理由 = 官方语义 agent-preset/read-only。
      //   读不到 preset             → 按钮禁用，理由 = 读不到 preset，先修数据面。
      // 「正在读取 preset…」的瞬态沿用 P0 渲染（含 KNOB_LOADING_TITLE 逐字）—— 冻结验收台
      // _selftest-client.mjs 对 loading 渲染做 disabled+title 逐字断言。
      // ⛔ 一致性判定保持 P0 的实现（宿主 /agent 的 consistent 字段），这里只渲染，不改逻辑。
      function KnobsPanel({ agent, onOpenDetect }) {
        const [open, setOpen] = React.useState(true)
        const [tpl, setTpl] = React.useState({ status: 'loading', data: null, error: '' })
        // v5 P2：块内「预览差异」（dryRun 零写入计划 + 逐行 diff），hook 序号 #2
        const [diffPlan, setDiffPlan] = React.useState({ status: 'idle', data: null, error: '' })
        React.useEffect(() => {
          const controller = new AbortController()
          requestJson(HOST_API_BASE + '/templates', controller.signal).then((data) => {
            if (controller.signal.aborted) return
            setTpl({ status: 'ready', data: data, error: '' })
          }).catch((error) => {
            if (controller.signal.aborted) return
            setTpl({ status: 'error', data: null, error: errText(error) })
          })
          return () => controller.abort()
        }, [])
        const toggleBtn = e('button', {
          className: 'dma-btn dma-mini', style: Object.assign({}, miniBtnStyle, { flex: 'none' }),
          onClick: () => setOpen((v) => !v), title: open ? '收起可写项块' : '展开可写项块',
        }, open ? '▾ 可写项' : '▸ 可写项')
        if (!open) {
          return e('div', { style: colTurnStyle }, toggleBtn,
            e('div', { style: dimStyle }, '（已收起）'))
        }
        const comp = agent.status === 'ready' && agent.data && agent.data.compaction && typeof agent.data.compaction === 'object'
          ? agent.data.compaction
          : null
        const sections = agent.status === 'ready' && agent.data && Array.isArray(agent.data.sections)
          ? agent.data.sections
          : []
        const hasState = sections.some((s) => String(s.name || '').indexOf('state:card') !== -1)
        const hasAnima = sections.some((s) => String(s.name || '').indexOf('anima:memory') !== -1)
        const tplComp = tpl.status === 'ready' && tpl.data && tpl.data.templates && tpl.data.templates.compaction
          ? tpl.data.templates.compaction
          : null
        const tplPh = tpl.status === 'ready' && tpl.data && tpl.data.templates && tpl.data.templates.placeholder
          ? tpl.data.templates.placeholder
          : null
        const panelTextOf = (t) => t == null
          ? '未知（模板读取失败）'
          : (t.custom ? '自定义（' + String(t.current ? t.current.length : 0) + ' 字符）' : '内置默认')
        const consistentBadge = (consistent) => consistent === true
          ? e('span', { key: 'c', style: okBadgeStyle, title: '面板当前文本与 preset 实际值相同' }, '一致 ✓')
          : consistent === false
            ? e('span', { key: 'c', style: warnBadgeStyle, title: '★ 面板里的值与 preset 实际值不同 —— 面板改了也不会生效；可在下方「应用」或检测视图的 ⑤ 应用卡把面板模板真写入 preset' }, '不一致 ✗')
            : e('span', { key: 'c', style: dimBadgeStyle, title: '拿不到 preset 实际值，无法比对 —— 如实显示未知，不猜' }, '未知')
        const knobRow = (title, panelVal, presetVal, consNode, note) => e('div', {
          key: title,
          style: { display: 'flex', flexDirection: 'column', gap: 2, paddingBottom: 5, borderBottom: '1px solid color-mix(in srgb, CanvasText 8%, transparent)' },
        },
          e('div', { style: { display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' } },
            e('span', { style: { fontSize: 12, fontWeight: 700 } }, title),
            consNode),
          e('div', { style: dimStyle }, '面板值：' + panelVal),
          e('div', { style: dimStyle }, 'preset 实际值：' + presetVal),
          note ? e('div', { style: dimStyle, title: note }, note) : null,
        )
        // §4.2 逐字口径：压缩指令那栏要显示「面板值 vs preset 实际值：一致 / 不一致（面板改了也不会生效）」，
        // 两个值都在上方两行给全；未知时如实说读不到，不猜。
        const compConsistencyLine = comp && comp.consistent === true
          ? '面板值 vs preset 实际值：一致'
          : comp && comp.consistent === false
            ? '面板值 vs preset 实际值：不一致（面板改了也不会生效）——可在「生成 / 修复 RP agent」的应用卡里把面板模板真写入 preset'
            : '面板值 vs preset 实际值：未知（preset 实际值读不到，无法比对）'
        const compNote = compConsistencyLine + (comp && typeof comp.note === 'string' && comp.note ? '　' + comp.note : '')
        // ---- v5 P2 写入入口的三态判定（拿不到一律如实禁用，不猜）----
        const presetInfo = agent.status === 'ready' && agent.data && agent.data.preset && typeof agent.data.preset === 'object'
          ? agent.data.preset
          : null
        const presetId = presetInfo && typeof presetInfo.id === 'string' ? presetInfo.id : ''
        const writable = presetInfo ? presetInfo.writable : null
        const canWrite = writable === true && presetId !== ''
        const disabledTitle = writable === false ? KNOB_READONLY_TITLE : KNOB_UNKNOWN_TITLE
        const stateNote = writable === true
          ? KNOB_WRITABLE_NOTE
          : writable === false
            ? '只读：随部署附带，不可修改（agent-preset/read-only）。'
            : '可写性：未知 —— 读不到 preset，先修数据面。'
        // 预览差异：本块内 dryRun（零写入），计划 + 逐行 diff 就地显示
        const onPreviewDiff = () => {
          if (!canWrite || diffPlan.status === 'loading') return
          setDiffPlan({ status: 'loading', data: null, error: '' })
          const url = AGENT_API + '/apply'
          mutateJson(url, 'POST', { presetId: presetId, dryRun: true })
            .then((data) => setDiffPlan({ status: 'ready', data: data, error: '' }))
            .catch((error) => {
              const payload = error && error.payload && typeof error.payload === 'object' ? error.payload : null
              const hint = payload && typeof payload.hint === 'string' && payload.hint ? '（' + payload.hint + '）' : ''
              setDiffPlan({ status: 'error', data: null, error: errText(error) + hint })
            })
        }
        const diffData = diffPlan.status === 'ready' && diffPlan.data && typeof diffPlan.data === 'object' ? diffPlan.data : null
        const diffLine = diffData && diffData.diff && diffData.diff.line != null ? diffData.diff : null
        const diffBlock = diffPlan.status === 'idle' ? null
          : diffPlan.status === 'loading' ? e('div', { style: dimStyle }, '正在出零写入计划…')
          : diffPlan.status === 'error' ? e('div', { style: errorStyle }, '预览差异失败：' + diffPlan.error)
          : e('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, flex: 'none', minWidth: 0 } },
            e('div', { style: Object.assign({}, dimStyle, { fontWeight: 700 }) }, '以下为提案（零写入）；点「应用」才会落盘'),
            (diffData && Array.isArray(diffData.plan) ? diffData.plan : []).map((p, i) =>
              e('div', { key: String(i), style: { fontSize: SMALL_FONT_SIZE, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, '· ' + String(p))),
            diffLine
              ? e('div', { style: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 } },
                e('div', { style: { fontSize: SMALL_FONT_SIZE, fontWeight: 700 } }, '第 ' + diffLine.line + ' 行 · 改前'),
                e('div', { style: diffPreStyle }, diffLine.before === '' ? '（原值：空字符串——记忆库压缩指令此前完全没生效）' : diffLine.before),
                e('div', { style: { fontSize: SMALL_FONT_SIZE, fontWeight: 700 } }, '第 ' + diffLine.line + ' 行 · 改后'),
                e('div', { style: diffPreStyle }, diffLine.after))
              : null,
            e('div', null, e('button', {
              className: 'dma-btn dma-mini', style: miniBtnStyle,
              onClick: () => setDiffPlan({ status: 'idle', data: null, error: '' }), title: '收起这份预览（只是收起，不影响任何文件）',
            }, '收起预览')),
          )
        // 操作行三态：loading 瞬态沿用 P0 渲染（冻结验收台逐字断言）；ready 后按可写性解禁/禁用
        const actionRow = agent.status !== 'ready'
          ? e('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', flex: 'none' } },
            e('button', { className: 'dma-btn', style: btnStyle, disabled: true, title: KNOB_LOADING_TITLE }, '预览差异'),
            e('button', { className: 'dma-btn', style: btnStyle, disabled: true, title: KNOB_LOADING_TITLE }, '应用'),
            e('button', { className: 'dma-btn', style: btnStyle, disabled: true, title: KNOB_LOADING_TITLE }, '回滚'),
          )
          : canWrite
            ? e('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', flex: 'none' } },
              e('button', {
                className: 'dma-btn', style: btnStyle, disabled: diffPlan.status === 'loading',
                title: '先出零写入计划（备份到哪、改哪一行），不写任何文件', onClick: onPreviewDiff,
              }, '预览差异'),
              e('button', {
                className: 'dma-btn', style: btnStyle,
                title: '到 ⑤ 应用卡走同一条流：先干跑（零写入）→ 确认后才真落盘（应用前自动备份）',
                onClick: () => { if (typeof onOpenDetect === 'function') onOpenDetect(presetId) },
              }, '应用'),
              e('button', {
                className: 'dma-btn', style: btnStyle,
                title: '到 ⑥ 备份卡：从任一备份回滚（先干跑出计划，确认后才写；回滚前会先把当前文件再备份一次）',
                onClick: () => { if (typeof onOpenDetect === 'function') onOpenDetect(presetId) },
              }, '回滚'),
            )
            : e('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', flex: 'none' } },
              e('button', { className: 'dma-btn', style: btnStyle, disabled: true, title: disabledTitle }, '预览差异'),
              e('button', { className: 'dma-btn', style: btnStyle, disabled: true, title: disabledTitle }, '应用'),
              e('button', { className: 'dma-btn', style: btnStyle, disabled: true, title: disabledTitle }, '回滚'),
            )
        return e('div', { style: Object.assign({}, colTurnStyle, { width: 270 }) },
          e('div', { style: { display: 'flex', gap: 4, alignItems: 'center', flex: 'none' } }, toggleBtn),
          e('div', { style: Object.assign({}, dimStyle, { flex: 'none' }) },
            agent.status === 'ready' ? '4 类 knob（当前值 · 一致性 · 写入入口）' : '4 类 knob（本版只读展示）'),
          knobRow('压缩指令',
            panelTextOf(tplComp),
            comp ? (comp.presetInstruction === 'set' ? '已写入 customInstruction' : comp.presetInstruction === 'absent' ? '压缩块没写 customInstruction（用后端内置）' : '未知') : '未知',
            consistentBadge(comp ? comp.consistent : null),
            compNote),
          knobRow('收纳占位',
            panelTextOf(tplPh),
            '—（收纳执行器未接线，preset 无对应值）',
            consistentBadge(null),
            '本插件尚未实现收纳执行器：这段模板是待用的配置位。'),
          knobRow('注入 order · maxChars',
            '未提供（本版仍不可调）',
            (hasState || hasAnima)
              ? '组成里检出 ' + (hasState ? 'state:card(50) ' : '') + (hasAnima ? 'anima:memory(55)' : '')
              : '未知（这些注入由插件在运行时挂载，preset 文件里看不到）',
            consistentBadge(null),
            null),
          knobRow('记忆 · 状态开关',
            '未提供（本版仍不可调）',
            (hasState || hasAnima) ? '检出相关注入引用' : '未知',
            consistentBadge(null),
            null),
          actionRow,
          e('div', { style: dimStyle },
            agent.status === 'ready' ? stateNote : '正在读取 preset 可写性…'),
          diffBlock,
        )
      }

      // ---------- v5 P1a：应用卡（真写入 = 先干跑零写入，确认后才落盘）+ 备份卡（只读） ----------
      // 状态全部在 AgentEditorPanel（applyCtl 传入），本组件无 hooks；失败降级绝不抛。
      function ApplyCard({ d, applyCtl }) {
        const apply = applyCtl.apply
        const candidates = Array.isArray(d.candidates) ? d.candidates : []
        const writable = candidates.filter((c) => c && c.writable === true)
        const rootInfo = d.memoryRoot && typeof d.memoryRoot === 'object' ? d.memoryRoot : {}
        const selected = apply.presetId || (writable.length === 1 ? String(writable[0].id) : '')
        const target = writable.find((c) => String(c.id) === String(selected)) || null
        const head = e('div', { style: sectionTitleStyle }, '⑤ 应用（真写入 · 先干跑再确认）')
        if (writable.length === 0) {
          return e('div', { style: cardStyle }, head,
            e('div', { style: dimStyle }, '没有可应用的候选 —— 要 trust=user 的 RP preset 才能写（随部署附带的 preset 官方语义只读）。'))
        }
        const selectRow = writable.length > 1
          ? e('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
            e('label', { htmlFor: 'dma-agent-apply-target', style: { fontSize: 12 } }, '目标 preset'),
            e('select', {
              id: 'dma-agent-apply-target', className: 'dma-click', style: selectStyle,
              value: selected,
              onChange: (ev) => applyCtl.onSelectPreset(ev.target.value),
            }, writable.map((c) => e('option', { key: String(c.id), value: String(c.id) },
              String(c.id) + (c.name ? '（' + String(c.name) + '）' : '')))))
          : null
        const targetLine = target
          ? e('div', { style: dimStyle },
            '压缩指令：' + (target.hasCompactionInstruction === false ? '未写入（应用后记忆库模板才会生效）' : '已有 customInstruction（应用会用面板模板覆盖它）')
            + ' · 可写：是' + (target.name ? ' · 显示名：' + String(target.name) : ''))
          : null
        const rootLine = rootInfo.configured === false
          ? e('div', { style: warnStyle }, ROOT_MISSING_GUIDANCE)
          : null
        const dangerBtn = Object.assign({}, btnStyle, { color: 'Canvas', background: 'crimson', borderColor: 'crimson', fontWeight: 700 })
        let body = null
        if (apply.phase === 'idle' || apply.phase === 'plan-loading' || apply.phase === 'writing') {
          const label = apply.phase === 'plan-loading' ? '正在干跑（零写入）…'
            : apply.phase === 'writing' ? '正在写入（备份 → 原子写 → 回读校验）…' : null
          body = e('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            apply.phase === 'idle'
              ? e('button', {
                className: 'dma-btn', style: dangerBtn, disabled: !target,
                title: '先出零写入计划（备份到哪、改哪一行），不写任何文件',
                onClick: () => applyCtl.onDryRun(selected),
              }, '① 先干跑（零写入）')
              : null,
            label ? e('span', { style: dimStyle }, label) : null,
            apply.phase === 'idle' && apply.error ? e('span', { style: errorStyle }, '上一次失败：' + apply.error) : null,
          )
        } else if (apply.phase === 'confirm') {
          const plan = apply.plan && Array.isArray(apply.plan.plan) ? apply.plan.plan : []
          // v5 P2 ③：逐行提案（dryRun 返回的 diff 只增字段；旧宿主没有就整体不渲染，绝不白屏）
          const diff = apply.plan && apply.plan.diff && apply.plan.diff.line != null ? apply.plan.diff : null
          body = e('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            e('div', { style: { fontSize: 12, fontWeight: 700 } }, '干跑计划（此刻还没有写任何文件）：'),
            plan.map((p, i) => e('div', { key: String(i), style: { fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, '· ' + String(p))),
            diff
              ? e('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                e('div', { style: { fontSize: 12, fontWeight: 700 } }, '以下为提案（零写入）；点「应用」才会落盘'),
                e('div', { style: { fontSize: 12, fontWeight: 700 } }, '第 ' + diff.line + ' 行 · 改前'),
                e('div', { style: diffPreStyle }, diff.before === '' ? '（原值：空字符串——记忆库压缩指令此前完全没生效）' : diff.before),
                e('div', { style: { fontSize: 12, fontWeight: 700 } }, '第 ' + diff.line + ' 行 · 改后'),
                e('div', { style: diffPreStyle }, diff.after))
              : null,
            apply.plan && apply.plan.guidance ? e('div', { style: warnStyle }, apply.plan.guidance) : null,
            e('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              e('button', {
                className: 'dma-btn', style: dangerBtn,
                title: '真落盘：备份 → 原子写 → 回读校验 → 不一致自动回滚',
                onClick: () => applyCtl.onConfirm(),
              }, '② 确认写入（真落盘）'),
              e('button', { className: 'dma-btn', style: btnStyle, onClick: applyCtl.onCancel, title: '放弃本次应用' }, '取消'),
            ),
          )
        } else if (apply.phase === 'done') {
          const r = apply.result && typeof apply.result === 'object' ? apply.result : null
          if (r && r.ok === true && r.dryRun !== true) {
            const appliedList = Array.isArray(r.applied) ? r.applied : []
            body = e('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
              e('div', { style: okStyle }, '✓ 已写入 preset（回读校验通过，注释逐行保全）'),
              appliedList.map((a, i) => e('div', { key: String(i), style: { fontSize: 12, lineHeight: 1.6, wordBreak: 'break-word' } },
                String(a.file) + ' · ' + String(a.field) + '：' + String(a.from) + ' → 「' + clipText(String(a.to), 160) + '」')),
              r.backup && r.backup.dir
                ? e('div', { style: dimStyle, title: String(r.backup.dir) }, '备份：' + String(r.backup.dir) + '（' + (Array.isArray(r.backup.files) ? r.backup.files.join('、') : '') + '）')
                : null,
              r.binding
                ? e('div', { style: dimStyle },
                  r.binding.written === true
                    ? '绑定：dma-binding.json 已写（memoryArchiveRoot = ' + String(r.binding.memoryArchiveRoot == null ? 'null（还没选根）' : r.binding.memoryArchiveRoot) + '）'
                    : '绑定：dma-binding.json 未能写入' + (r.binding.error ? '：' + String(r.binding.error) : ''))
                : null,
              r.recompose ? e('div', { style: dimStyle }, '生效方式：' + String(r.recompose.note)) : null,
              r.guidance ? e('div', { style: warnStyle }, r.guidance) : null,
              e('div', { style: { fontSize: 13, fontWeight: 700 } }, '→ ' + String(r.nextStep || '')),
              e('div', null, e('button', { className: 'dma-btn', style: btnStyle, onClick: applyCtl.onCancel, title: '收起本卡（可再检测试）' }, '完成')),
            )
          } else {
            const hint = r && typeof r.hint === 'string' && r.hint ? '（提示：' + r.hint + '）' : ''
            body = e('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              e('div', { style: errorStyle }, '写入失败：' + apply.error + hint),
              apply.rolledBack ? e('div', { style: warnStyle }, '已自动回滚：原文件已用备份原样恢复，没有半截状态。') : null,
              e('div', null, e('button', { className: 'dma-btn', style: btnStyle, onClick: applyCtl.onCancel }, '返回')),
            )
          }
        }
        return e('div', { style: cardStyle }, head, selectRow, targetLine, rootLine, body)
      }

      // v5 P2 ①：备份卡解禁 [回滚] —— 每条备份都能回滚，但必须走「干跑出计划 → 确认 → 写」
      // 三步（⛔ 不许点一下直接写）。回滚由宿主 POST /agent/rollback 完成：回滚前会先把
      // 当前文件再备份一次 ⇒ 回滚本身可再回滚。列表本身仍只读（不改不删任何备份文件）。
      function BackupsCard({ applyCtl }) {
        const backups = applyCtl.backups
        const rb = applyCtl.rollback
        const rows = backups.status === 'ready' && backups.data && Array.isArray(backups.data.backups)
          ? backups.data.backups.slice(0, 10)
          : []
        const rbBusy = rb && (rb.phase === 'plan-loading' || rb.phase === 'writing')
        let rbBody = null
        if (rb && rb.phase === 'plan-loading') {
          rbBody = e('div', { style: dimStyle }, '正在出回滚计划（零写入）…')
        } else if (rb && rb.phase === 'confirm') {
          const plan = rb.plan && Array.isArray(rb.plan.plan) ? rb.plan.plan : []
          rbBody = e('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            e('div', { style: { fontSize: 12, fontWeight: 700 } }, '回滚计划（此刻还没有写任何文件）：'),
            plan.map((p, i) => e('div', { key: String(i), style: { fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, '· ' + String(p))),
            rb.plan && rb.plan.guidance ? e('div', { style: warnStyle }, rb.plan.guidance) : null,
            e('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              e('button', {
                className: 'dma-btn', style: Object.assign({}, btnStyle, { color: 'Canvas', background: 'crimson', borderColor: 'crimson', fontWeight: 700 }),
                title: '真回滚：先把当前文件再备份一次 → 原子写 → 逐字节回读校验 → 不过自动恢复',
                onClick: applyCtl.onRollbackConfirm,
              }, '确认回滚'),
              e('button', { className: 'dma-btn', style: btnStyle, onClick: applyCtl.onRollbackCancel, title: '放弃本次回滚' }, '取消'),
            ),
          )
        } else if (rb && rb.phase === 'writing') {
          rbBody = e('div', { style: dimStyle }, '正在回滚（先备份当前文件 → 原子写 → 逐字节回读校验）…')
        } else if (rb && rb.phase === 'done') {
          const r = rb.result && typeof rb.result === 'object' ? rb.result : null
          if (r && r.ok === true) {
            rbBody = e('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              e('div', { style: okStyle }, '✓ 已从 ' + String(r.restoredFrom && r.restoredFrom.name ? r.restoredFrom.name : rb.file) + ' 回滚'),
              r.backup && r.backup.file
                ? e('div', { style: dimStyle, title: String(r.backup.file) }, '回滚前的当前文件已先备份到：' + String(r.backup.file) + '（回滚本身可再回滚）')
                : null,
              r.recompose ? e('div', { style: dimStyle }, '生效方式：' + String(r.recompose.note)) : null,
              e('div', { style: warnStyle }, '需新开会话或重启才完全生效（现有会话仍用旧内容）。'),
              e('div', null, e('button', { className: 'dma-btn', style: btnStyle, onClick: applyCtl.onRollbackCancel, title: '收起（备份列表已自动刷新）' }, '完成')),
            )
          } else {
            const hint = r && typeof r.hint === 'string' && r.hint ? '（提示：' + r.hint + '）' : ''
            rbBody = e('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              e('div', { style: errorStyle }, '回滚失败：' + rb.error + hint),
              rb.rolledBack ? e('div', { style: warnStyle }, '已自动回滚，原文件未变。') : null,
              e('div', null, e('button', { className: 'dma-btn', style: btnStyle, onClick: applyCtl.onRollbackCancel }, '返回')),
            )
          }
        }
        return e('div', { style: cardStyle },
          e('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            e('div', { style: sectionTitleStyle }, '⑥ 备份列表（只读，最多 10 条）'),
            e('button', {
              className: 'dma-btn dma-mini', style: miniBtnStyle, title: '重新读一遍 .dma-backup/',
              onClick: applyCtl.onRetryBackups,
            }, '↻')),
          backups.status === 'loading' ? e('div', { style: dimStyle }, '正在读备份目录…') : null,
          backups.status === 'error' ? e('div', { style: errorStyle }, '备份列表读不到：' + backups.error) : null,
          backups.status === 'ready' && rows.length === 0
            ? e('div', { style: dimStyle }, '还没有备份 —— 应用写入后，每次改动前的原文件都会按时间戳留在这里。')
            : null,
          rows.map((b) => e('div', { key: String(b.file), style: itemStyle },
            e('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 12 } },
              e('span', { style: { fontFamily: MONO, wordBreak: 'break-all' } }, String(b.file)),
              e('span', { style: dimStyle }, formatTime(b.mtime) + ' · ' + String(b.bytes) + ' 字节'),
              e('button', {
                className: 'dma-btn dma-mini', style: miniBtnStyle, disabled: !!rbBusy,
                title: '先干跑出回滚计划（零写入）：确认后才会把这份备份盖回 agent.cordis.yml；回滚前会先把当前文件再备份一次',
                onClick: () => applyCtl.onRollbackDryRun(String(b.file)),
              }, '回滚')))),
          rbBody,
        )
      }

      // ---------- v5 P0：检测与预览视图（「生成 / 修复 RP agent」的只读产物展示，不落盘） ----------
      // 数据 = 宿主 GET /api/agent/detect；6 条事实在宿主侧逐条给出（本组件只渲染）。
      // v5 P1a：底部新增 ⑤ 应用卡（真写入，先干跑）与 ⑥ 备份卡（只读）；检测本身仍零写入。
      function DetectReport({ state, onBack, onRetry, skillOn, applyCtl }) {
        const head = e('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flex: 'none', flexWrap: 'wrap' } },
          e('button', { className: 'dma-btn', style: btnStyle, onClick: onBack, title: '回到编辑器三块视图' }, '← 返回编辑器'),
          e('strong', { style: sectionTitleStyle }, '生成 / 修复 RP agent · 检测与预览'),
          e('button', { className: 'dma-btn dma-mini', style: miniBtnStyle, onClick: onRetry, title: '重新只读检测' }, '↻ 重新检测'),
          skillOn
            ? e('span', { style: okBadgeStyle, title: SKILL_NOTE }, 'Skill 已勾选（仅本界面）')
            : e('span', { style: dimBadgeStyle, title: SKILL_NOTE }, 'Skill 未勾选'),
        )
        if (state.status === 'idle' || state.status === 'loading') {
          return e('div', { style: colFillStyle }, head, e('div', { style: dimStyle }, '正在只读检测…'))
        }
        if (state.status === 'error') {
          return e('div', { style: colFillStyle }, head,
            e('div', { style: errorStyle }, '检测失败：' + state.error),
            e('div', { style: dimStyle }, '宿主 /api/agent/detect 不可用（可能宿主半侧是旧版）。本编辑器其余功能不受影响。'))
        }
        const d = state.data && typeof state.data === 'object' ? state.data : {}
        const candidates = Array.isArray(d.candidates) ? d.candidates : []
        const rootInfo = d.memoryRoot && typeof d.memoryRoot === 'object' ? d.memoryRoot : {}
        const missing = Array.isArray(d.missing) ? d.missing : []
        const preview = d.preview && typeof d.preview === 'object' ? d.preview : {}
        const facts = Array.isArray(preview.createOrFix) ? preview.createOrFix : []
        return e('div', { style: colFillStyle },
          head,
          e('div', { style: scrollColStyle },
            e('div', { style: cardStyle },
              e('div', { style: sectionTitleStyle }, '① 候选（用户自带 trust=user 的 RP preset）'),
              candidates.length === 0
                ? e('div', { style: dimStyle }, '没有候选 —— 还没有用户自带的 RP preset（~/.dsh/.agent-presets/ 为空或不可读）')
                : candidates.map((c, i) => e('div', { key: String(c.id || i), style: itemStyle },
                  e('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline', fontSize: 12 } },
                    e('span', { style: { fontWeight: 700, fontFamily: MONO } }, String(c.id || '?')),
                    c.name ? e('span', { style: dimStyle, title: 'preset.yml 的 name = 新会话选项里显示的那个' }, '显示名：' + String(c.name)) : null,
                    c.writable === true
                      ? e('span', { style: okBadgeStyle }, '可写')
                      : e('span', { style: warnBadgeStyle, title: 'trust !== user ⇒ 官方语义只读（agent-preset/read-only）' }, '只读'),
                    c.bound === true
                      ? e('span', { style: okBadgeStyle, title: '压缩指令已写入 + 记忆库根已配置' }, '已绑记忆库')
                      : e('span', { style: dimBadgeStyle, title: '绑定口径：压缩指令已写入 + 记忆库根已配置' }, '未绑全'),
                  ),
                  e('div', { style: dimStyle },
                    '压缩指令：' + (c.hasCompactionInstruction === true ? '已写入 customInstruction' : c.hasCompactionInstruction === false ? '未写入' : '未知')
                    + ' · 工具行：' + String(c.riskyToolRows || '未知')),
                ))),
            e('div', { style: cardStyle },
              e('div', { style: sectionTitleStyle }, '② 记忆库根'),
              e('div', { style: { fontSize: 12 } },
                '已配置：' + (rootInfo.configured === true ? '是' : rootInfo.configured === false ? '否' : '未知')
                + ' · 可解析：' + (rootInfo.resolvable === true ? '是' : rootInfo.resolvable === false ? '否' : '未知')
                + ' · 模式：' + String(rootInfo.mode || '未知')),
              rootInfo.detail ? e('div', { style: dimStyle }, String(rootInfo.detail)) : null,
            ),
            e('div', { style: cardStyle },
              e('div', { style: sectionTitleStyle }, '③ 缺什么'),
              missing.length === 0 ? e('div', { style: okStyle }, '（没检出缺失项）') : null,
              e('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                missing.map((m, i) => e('div', { key: String(i), style: { fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, '· ' + String(m)))),
            ),
            e('div', { style: cardStyle },
              e('div', { style: sectionTitleStyle }, '④ 生成 / 修复预览（逐条事实，来自第一轮调研）'),
              e('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                facts.map((f, i) => e('div', { key: String(i), style: { fontSize: 12, lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, String(f)))),
              preview.backupPlan ? e('div', { style: dimStyle }, String(preview.backupPlan)) : null,
              skillOn
                ? e('div', { style: dimStyle }, '已勾选 Skill：随包原则文档 skill/RP-AGENT-OPTIMIZATION.md 会成为 AI 助手的操作原则（下方 ⑤ 应用卡已具备真写入：先干跑，确认后才落盘）。')
                : null,
            ),
            e(ApplyCard, { d: d, applyCtl: applyCtl }),
            e(BackupsCard, { applyCtl: applyCtl }),
            e('div', { style: honestStyle }, DETECT_FOOTER),
          ),
        )
      }

      // ---------- Agent 编辑器主体（v5 P0：独立入口「agent-editor」的浮层内容；席位与外壳见 AgentEditorButton） ----------
      // hook 序号（自检假 react 注入口径）：0 fullscreen · 1 health · 2 sessions · 3 hostRows ·
      // 4 nameIdx · 5 sessionId · 6 detail · 7 turn · 8 part · 9 partState · 10 fullState ·
      // 11 query · 12 note · 13 sessionsAbort(ref) · 14 resolveSentRef(ref) ·
      // 15 agent · 16 detect · 17 detectTick · 18 skillOn ·
      // 19 apply（P1a 应用流）· 20 backups（P1a 备份列表）· 21 backupsTick ·
      // 22 rollback（P2 备份卡回滚流：idle → plan-loading → confirm → writing → done）
      function AgentEditorPanel({ onClose }) {
        const [fullscreen, setFullscreen] = React.useState(false)
        const [health, setHealth] = React.useState({ status: 'loading', n: null, error: '' })
        const [sessions, setSessions] = React.useState({ status: 'loading', items: [], error: null })
        const [hostRows, setHostRows] = React.useState({ status: 'loading', byId: null, error: null })
        const [nameIdx, setNameIdx] = React.useState(EMPTY_NAME_INDEX)
        const [sessionId, setSessionId] = React.useState('')
        const [detail, setDetail] = React.useState({ status: 'idle', meta: null, requests: [], error: null })
        const [turn, setTurn] = React.useState(0)
        const [part, setPart] = React.useState('system')
        const [partState, setPartState] = React.useState({ status: 'idle', data: null, error: null })
        const [fullState, setFullState] = React.useState({ status: 'idle', data: null, error: null })
        const [query, setQuery] = React.useState('')
        const [note, setNote] = React.useState('')
        const sessionsAbort = React.useRef(null)
        const resolveSentRef = React.useRef(0)   // 本轮（进查看器/刷新列表）已排程补标题的个数；到 TITLE_FILL_CAP 即停
        // v5 P0 新增（hook 序号 15–18）：/api/agent 只读数据、检测预览开关与结果、Skill 勾选。
        // ★ skillOn 只改组件内 state：本项目禁一切本地持久存储，界面上如实标注「刷新后需重新勾选」。
        const [agent, setAgent] = React.useState({ status: 'loading', data: null, error: '' })
        const [detect, setDetect] = React.useState({ open: false, status: 'idle', data: null, error: '' })
        const [detectTick, setDetectTick] = React.useState(0)
        const [skillOn, setSkillOn] = React.useState(false)
        // v5 P1a（hook 序号 19–21）：应用流（idle → plan-loading → confirm → writing → done）、
        // 备份列表、备份刷新信号。全部组件内 state，不落任何本地存储。
        const [apply, setApply] = React.useState({ phase: 'idle', presetId: null, plan: null, result: null, error: '', rolledBack: false })
        const [backups, setBackups] = React.useState({ status: 'idle', data: null, error: '' })
        const [backupsTick, setBackupsTick] = React.useState(0)
        // v5 P2（hook 序号 22）：备份卡回滚流。与应用流同纪律：必须干跑计划 → 确认两步，⛔ 不许点一下直接写。
        const [rollback, setRollback] = React.useState({ phase: 'idle', presetId: null, file: null, plan: null, result: null, error: '', rolledBack: false })

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

        // 0b) 宿主 /sessions join 表：cwd ⇒ 工作区真名、origin ⇒ 子会话识别。
        //     失败降级：工作区名退回 slug 解码（标「未解析出路径」）、子会话识别不可用，绝不抛。
        React.useEffect(() => {
          const controller = new AbortController()
          requestJson(HOST_API_BASE + '/sessions', controller.signal).then((data) => {
            if (controller.signal.aborted) return
            const byId = new Map()
            for (const row of Array.isArray(data.sessions) ? data.sessions : []) {
              if (row && typeof row.sessionId === 'string' && !byId.has(row.sessionId)) {
                byId.set(row.sessionId, {
                  cwd: typeof row.cwd === 'string' ? row.cwd : null,
                  origin: typeof row.origin === 'string' ? row.origin : null,
                })
              }
            }
            setHostRows({ status: 'ready', byId: byId, error: null })
          }).catch((error) => {
            if (controller.signal.aborted) return
            setHostRows({ status: 'ready', byId: null, error: errText(error) })
          })
          return () => controller.abort()
        }, [])

        // 0c) 真名目录（尽力而为）：会话标题三级回退要用；读不到就退短 ID，不影响查看器其它功能
        React.useEffect(() => {
          const controller = new AbortController()
          getCatalogIndex(controller.signal, !!CATALOG_CACHE.error).then((res) => {
            if (controller.signal.aborted) return
            setNameIdx(res.index)
          }).catch(() => {})
          return () => controller.abort()
        }, [])

        // 1) 会话列表：首刷只扫目录不解析（title:'' / requests:-1 = 未解析哨兵）
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

        // 5) 完整视图（part='full'）：现有三个 /api/part 各取一次，客户端按
        //    system → tools → messages（模型实际收到的顺序）拼装；单段失败不拖垮其它段。
        React.useEffect(() => {
          if (!sessionId || !turn || part !== 'full') return undefined
          const controller = new AbortController()
          setFullState({ status: 'loading', data: null, error: null })
          const base = PROMPT_API_BASE + '/api/part?id=' + encodeURIComponent(sessionId) + '&turn=' + String(turn)
          const out = { system: null, tools: null, messages: null }
          const errs = []
          const jobs = [
            requestJson(base + '&part=system', controller.signal).then((d) => {
              out.system = clipInfo(typeof d.text === 'string' ? d.text : '')
            }).catch((error) => {
              if (controller.signal.aborted) throw error
              errs.push('system：' + errText(error))
            }),
            requestJson(base + '&part=tools', controller.signal).then((d) => {
              out.tools = Array.isArray(d.tools) ? d.tools : []
            }).catch((error) => {
              if (controller.signal.aborted) throw error
              errs.push('tools：' + errText(error))
            }),
            requestJson(base + '&part=messages', controller.signal).then((d) => {
              out.messages = clipInfo(typeof d.text === 'string' ? d.text : '')
            }).catch((error) => {
              if (controller.signal.aborted) throw error
              errs.push('messages：' + errText(error))
            }),
          ]
          Promise.all(jobs).then(() => {
            if (controller.signal.aborted) return
            if (out.system === null && out.tools === null && out.messages === null) {
              setFullState({ status: 'error', data: null, error: errs.join('；') || '三段都取不到' })
            } else {
              setFullState({ status: 'ready', data: out, error: errs.length > 0 ? errs.join('；') : null })
            }
          }).catch((error) => {
            if (controller.signal.aborted) return
            setFullState({ status: 'error', data: null, error: errText(error) })
          })
          return () => controller.abort()
        }, [sessionId, turn, part])

        // 6) v5 P0：/api/agent（当前 preset + 组成 + 压缩一致性）。随 sessionId 变化重取：
        //    没选会话时服务端如实给 null（界面显示「未知」），绝不猜；拿不到服务 → error 态可读红字。
        React.useEffect(() => {
          const controller = new AbortController()
          setAgent({ status: 'loading', data: null, error: '' })
          requestJson(HOST_API_BASE + '/agent' + (sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : ''), controller.signal)
            .then((data) => {
              if (controller.signal.aborted) return
              setAgent({ status: 'ready', data: data, error: '' })
            })
            .catch((error) => {
              if (controller.signal.aborted) return
              setAgent({ status: 'error', data: null, error: errText(error) })
            })
          return () => controller.abort()
        }, [sessionId])

        // 7) v5 P0：检测与预览（打开时取一次；「↻ 重新检测」用 detectTick 触发）。只读端点。
        React.useEffect(() => {
          if (!detect.open) return undefined
          const controller = new AbortController()
          setDetect((s) => ({ ...s, status: 'loading', error: '' }))
          requestJson(HOST_API_BASE + '/agent/detect', controller.signal)
            .then((data) => {
              if (controller.signal.aborted) return
              setDetect((s) => ({ ...s, status: 'ready', data: data, error: '' }))
            })
            .catch((error) => {
              if (controller.signal.aborted) return
              setDetect((s) => ({ ...s, status: 'error', data: null, error: errText(error) }))
            })
          return () => controller.abort()
        }, [detect.open, detectTick])

        // 8) v5 P1a：备份列表（检测视图打开且有可应用候选时拉取；↻/写入后用 backupsTick 重取）。
        //    只读端点；失败只降级本卡（可读红字），绝不抛。
        //    v5 P2：目标推导提升为 backupsTargetId（应用卡与备份卡回滚共用同一套选择逻辑）。
        const detectReadyData = detect.status === 'ready' && detect.data && typeof detect.data === 'object' ? detect.data : null
        const writableIds = detectReadyData && Array.isArray(detectReadyData.candidates)
          ? detectReadyData.candidates.filter((c) => c && c.writable === true).map((c) => String(c.id))
          : []
        const backupsTargetId = apply.presetId != null && writableIds.includes(String(apply.presetId))
          ? String(apply.presetId)
          : (writableIds.length === 1 ? writableIds[0] : null)
        React.useEffect(() => {
          if (!detect.open || !detectReadyData) return undefined
          const target = backupsTargetId
          if (!target) {
            setBackups({ status: 'ready', data: { backups: [] }, error: '' })
            return undefined
          }
          const controller = new AbortController()
          setBackups((s) => ({ ...s, status: 'loading', error: '' }))
          requestJson(AGENT_API + '/backups?presetId=' + encodeURIComponent(target), controller.signal)
            .then((data) => {
              if (controller.signal.aborted) return
              setBackups({ status: 'ready', data: data, error: '' })
            })
            .catch((error) => {
              if (controller.signal.aborted) return
              setBackups({ status: 'error', data: null, error: errText(error) })
            })
          return () => controller.abort()
        }, [detect.open, detectReadyData, backupsTargetId, backupsTick])

        // 9) v5 P1a：应用流（⚠ 必须经过干跑计划 → 确认两步，⛔ 不许点一下直接写）。
        //    mutateJson 遇 ok:false 会 throw 且带 payload —— 失败原因/hint/rolledBack 从 payload 读。
        const applyCtl = {
          apply: apply,
          backups: backups,
          onSelectPreset: (id) => setApply({ phase: 'idle', presetId: id, plan: null, result: null, error: '', rolledBack: false }),
          onDryRun: (id) => {
            setApply({ phase: 'plan-loading', presetId: id, plan: null, result: null, error: '', rolledBack: false })
            const url = AGENT_API + '/apply'
            mutateJson(url, 'POST', { presetId: id, dryRun: true })
              .then((data) => {
                setApply((s) => (s.phase === 'plan-loading' ? { ...s, phase: 'confirm', plan: data } : s))
              })
              .catch((error) => {
                const payload = error && error.payload && typeof error.payload === 'object' ? error.payload : null
                const hint = payload && typeof payload.hint === 'string' && payload.hint ? '（' + payload.hint + '）' : ''
                setApply((s) => (s.phase === 'plan-loading' ? { ...s, phase: 'idle', error: errText(error) + hint } : s))
              })
          },
          onConfirm: () => {
            const presetId = apply.presetId
            if (!presetId) return
            setApply((s) => ({ ...s, phase: 'writing', error: '', rolledBack: false }))
            const url = AGENT_API + '/apply'
            mutateJson(url, 'POST', { presetId: presetId, dryRun: false })
              .then((data) => {
                setApply((s) => ({ ...s, phase: 'done', result: data, error: '', rolledBack: false }))
                setBackupsTick((x) => x + 1)
                setDetectTick((x) => x + 1) // 重跑只读检测，刷新「已绑记忆库」等徽标
              })
              .catch((error) => {
                const payload = error && error.payload && typeof error.payload === 'object' ? error.payload : null
                setApply((s) => ({
                  ...s,
                  phase: 'done',
                  result: payload,
                  error: errText(error),
                  rolledBack: !!(payload && payload.rolledBack === true),
                }))
                setBackupsTick((x) => x + 1)
              })
          },
          onCancel: () => setApply({ phase: 'idle', presetId: apply.presetId, plan: null, result: null, error: '', rolledBack: false }),
          onRetryBackups: () => setBackupsTick((x) => x + 1),
        }
        // v5 P2 ①：备份卡回滚流并入同一个 ctl（干跑出计划 → 确认 → 写；纪律与应用流一致）。
        // mutateJson 遇 ok:false 会 throw 且带 payload —— 可读原因 / hint / rolledBack 从 payload 读。
        applyCtl.rollback = rollback
        applyCtl.onRollbackDryRun = (file) => {
          if (!backupsTargetId) {
            const msg = '找不到可回滚的 preset（没有可写候选）——先「生成 / 修复 RP agent」'
            setRollback({ phase: 'done', presetId: null, file: file, plan: null, result: { ok: false, error: { code: 'NO_TARGET', message: msg } }, error: msg, rolledBack: false })
            return
          }
          setRollback({ phase: 'plan-loading', presetId: backupsTargetId, file: file, plan: null, result: null, error: '', rolledBack: false })
          const url = AGENT_API + '/rollback'
          mutateJson(url, 'POST', { presetId: backupsTargetId, backupFile: file, dryRun: true })
            .then((data) => {
              setRollback((s) => (s.phase === 'plan-loading' ? { ...s, phase: 'confirm', plan: data } : s))
            })
            .catch((error) => {
              const payload = error && error.payload && typeof error.payload === 'object' ? error.payload : null
              const hint = payload && typeof payload.hint === 'string' && payload.hint ? '（' + payload.hint + '）' : ''
              setRollback((s) => (s.phase === 'plan-loading'
                ? { ...s, phase: 'done', result: payload, error: errText(error) + hint, rolledBack: !!(payload && payload.rolledBack === true) }
                : s))
            })
        }
        applyCtl.onRollbackConfirm = () => {
          const presetId = rollback.presetId
          const file = rollback.file
          if (!presetId || !file) return
          setRollback((s) => ({ ...s, phase: 'writing', error: '', rolledBack: false }))
          const url = AGENT_API + '/rollback'
          mutateJson(url, 'POST', { presetId: presetId, backupFile: file, dryRun: false })
            .then((data) => {
              setRollback((s) => ({ ...s, phase: 'done', result: data, error: '', rolledBack: false }))
              setBackupsTick((x) => x + 1)
              setDetectTick((x) => x + 1) // 回滚改变了 agent.cordis.yml ⇒ 重跑只读检测，刷新一致性徽标
            })
            .catch((error) => {
              const payload = error && error.payload && typeof error.payload === 'object' ? error.payload : null
              setRollback((s) => ({
                ...s,
                phase: 'done',
                result: payload,
                error: errText(error),
                rolledBack: !!(payload && payload.rolledBack === true),
              }))
              setBackupsTick((x) => x + 1)
            })
        }
        applyCtl.onRollbackCancel = () => setRollback({ phase: 'idle', presetId: rollback.presetId, file: null, plan: null, result: null, error: '', rolledBack: false })
        // v5 P2 ②：可写项块的「应用 / 回滚」切到检测视图（⑤ 应用卡 / ⑥ 备份卡都在那里），
        // 并把当前 preset 预选为应用目标 —— 仍走同一条「先干跑再确认」的流。
        const openDetectFor = (presetId) => {
          if (presetId) setApply({ phase: 'idle', presetId: String(presetId), plan: null, result: null, error: '', rolledBack: false })
          setDetect((s) => ({ ...s, open: true }))
        }

        const copyCurrent = () => {
          const data = partState.status === 'ready' ? partState.data : null
          if (!data) return Promise.reject(new Error('没有可复制的内容'))
          const text = typeof data.text === 'string'
            ? data.text
            : (Array.isArray(data.tools)
              ? data.tools.map((t) => t.name + '  (' + t.chars + ' 字)').join('\n')
              : '')
          if (text === '') return Promise.reject(new Error('没有可复制的内容'))
          return copyText(text).then(
            () => setNote('已复制 ' + text.length + ' 字符'),
            () => setNote('复制失败 [COPY_FAIL]'),
          )
        }

        const copyFull = () => {
          const data = fullState.status === 'ready' ? fullState.data : null
          if (!data) return Promise.reject(new Error('没有可复制的内容'))
          const text = buildFullPlainText(data)
          if (text === '') return Promise.reject(new Error('没有可复制的内容'))
          return copyText(text).then(
            () => setNote('已复制全文 ' + text.length + ' 字符'),
            () => setNote('复制失败 [COPY_FAIL]'),
          )
        }

        const refreshSessions = () => { setNote(''); loadSessions(true) }

        const detailMeta = detail.status === 'ready' ? detail.meta : null
        const statusLine = [
          sessions.status === 'ready' ? '会话 ' + sessions.items.length + ' 个' : null,
          detail.status === 'ready' ? (detail.requests.length > 0 ? '轮次 ' + (turn || '-') + '/' + detail.requests.length : '无模型请求') : null,
          sessionId && turn ? (part === 'full' ? '完整视图' : '部件 ' + part) : null,
          note,
        ].filter(Boolean).join(' · ')

        const presetInfo = agent.status === 'ready' && agent.data && agent.data.preset && typeof agent.data.preset === 'object'
          ? agent.data.preset
          : null
        const presetId = presetInfo && typeof presetInfo.id === 'string' && presetInfo.id !== '' ? presetInfo.id : null
        const trustBadge = agent.status !== 'ready'
          ? null
          : (!presetInfo || presetInfo.trust == null)
            ? e('span', { style: dimBadgeStyle, title: '拿不到 preset 的 trust 信息 —— 如实显示未知，不猜' }, '未知')
            : presetInfo.trust === 'user'
              ? e('span', { style: okBadgeStyle, title: 'trust=user：用户自带（~/.dsh/.agent-presets/），可写' }, '用户自带·可写')
              : e('span', { style: warnBadgeStyle, title: '随部署附带的 preset 官方语义只读（agent-preset/read-only）' }, '随部署附带·只读')
        const activeBadge = agent.status !== 'ready'
          ? null
          : (agent.data && agent.data.active === true)
            ? e('span', { style: okBadgeStyle, title: 'preset 取自该会话自带事实（agent-preset 选择记录）' }, '✓ 已生效')
            : e('span', { style: warnBadgeStyle, title: '拿不到「该会话用哪个 preset」的事实 —— 如实显示未知，不猜' }, '⚠ 未知')

        return e('div', Object.assign({}, backdropStyle, { onClick: fullscreen ? undefined : onClose }),
          e('div', { style: fullscreen ? shellFullStyle : shellStyle, onClick: (ev) => ev.stopPropagation() },
            // 顶栏（v5 P0）：标题 + 当前 preset + 可写性/生效徽标 + ⛶/✕（拿不到数据一律「未知」，不许猜）
            e('div', { style: headerStyle },
              e('strong', { style: { fontSize: 14 } }, 'Agent 编辑器'),
              e('span', {
                style: { fontSize: 12, fontFamily: MONO, wordBreak: 'break-all' },
                title: presetId
                  ? '当前会话所用的 agent preset id：' + presetId
                  : '未知：先在中间栏选一个会话，从它的自带事实读 preset；拿不到就是未知，不猜',
              }, '当前 preset：' + (presetId || '未知')),
              trustBadge,
              activeBadge,
              health.status === 'ready' ? e('span', { style: dimStyle }, '· 数据面可用 · 宿主侧共 ' + health.n + ' 个会话') : null,
              health.status === 'loading' ? e('span', { style: dimStyle }, '· 正在探测提示词数据面…') : null,
              health.status === 'error' ? e('span', { style: errorStyle, title: health.error + '（下方列表如有报错以其为准）' }, '· 提示词数据面不可用') : null,
              e('div', { style: { flex: 1 } }),
              e('button', { className: 'dma-btn', style: btnStyle, onClick: () => setFullscreen((v) => !v), title: fullscreen ? '退出全屏' : '全屏' }, '⛶'),
              e('button', { className: 'dma-btn', style: btnStyle, onClick: onClose, title: '关闭 Agent 编辑器（组成 / 每次请求 / 可写项）' }, '✕'),
            ),
            // 主体（v5 P0）：三块并排 —— 组成 | 每次请求（原查看器整体搬入，能力一块不丢） | 可写项；
            // 点「生成 / 修复 RP agent」后整块切成检测与预览视图（同样只读）。
            detect.open
              ? e(DetectReport, {
                state: detect,
                onBack: () => setDetect((s) => ({ ...s, open: false })),
                onRetry: () => setDetectTick((x) => x + 1),
                skillOn: skillOn,
                applyCtl: applyCtl,
              })
              : e('div', { style: columnsStyle },
                e(CompositionBlock, { agent: agent }),
                e(ViewerSessionList, {
                  state: sessions, hostById: hostRows.byId, hostError: hostRows.error,
                  selectedId: sessionId, onSelect: setSessionId, onRefresh: refreshSessions, nameIdx: nameIdx,
                }),
                e(PromptRequestList, { detail: detail, selectedTurn: turn, onSelect: setTurn }),
                part === 'full'
                  ? e(FullPromptView, {
                    sessionId: sessionId, turn: turn, part: part, setPart: setPart,
                    state: fullState, onCopyFull: copyFull,
                  })
                  : e(PromptPartView, {
                    sessionId: sessionId, turn: turn, part: part, setPart: setPart,
                    state: partState, query: query, setQuery: setQuery, onCopy: copyCurrent,
                  }),
                e(KnobsPanel, { agent: agent, onOpenDetect: openDetectFor }),
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
            // Skill 区（v5 P0）：开关只改组件内 state（不落任何本地存储）；右侧按钮只做检测与预览
            e('div', { style: { display: 'flex', gap: 12, alignItems: 'flex-start', flex: 'none', borderTop: '1px solid ButtonBorder', paddingTop: 8 } },
              e('label', { className: 'dma-click', style: { display: 'flex', gap: 8, alignItems: 'flex-start', flex: 1, minWidth: 0 } },
                e('input', {
                  id: 'dma-skill-toggle', name: 'dma-skill-toggle', type: 'checkbox',
                  'aria-label': '启用「RP agent 优化」',
                  checked: skillOn, style: { marginTop: 2, flexShrink: 0 },
                  onChange: (ev) => setSkillOn(ev.target.checked),
                }),
                e('span', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
                  e('span', { style: { fontSize: 12, fontWeight: 700 } }, 'Skill：启用「RP agent 优化」'),
                  e('span', { style: dimStyle }, SKILL_LINE),
                  e('span', { style: { fontSize: SMALL_FONT_SIZE, color: 'crimson' } }, SKILL_RISK),
                  e('span', { style: dimStyle }, SKILL_NOTE),
                ),
              ),
              e('button', {
                className: 'dma-btn', style: Object.assign({}, btnStyle, { flexShrink: 0 }),
                title: '检测与预览（只读）→ ⑤ 应用卡可真写入：先干跑零写入，确认后才落盘（自动备份 + 回读校验 + 不一致自动回滚）',
                onClick: () => setDetect((s) => ({ ...s, open: true })),
              }, '生成 / 修复 RP agent'),
            ),
          ),
        )
      }

      /** 独立入口「agent-editor」（v5 P0 由 prompt-viewer 升格）：侧边栏按钮（窄屏「词」），浮层与记忆库面板各自独立开合 */
      function AgentEditorButton(props) {
        const [open, setOpen] = React.useState(false)
        return e('div', { style: { position: 'relative' } },
          e('button', {
            className: 'dma-btn dma-entry',
            title: AGENT_ENTRY_TITLE,
            'aria-label': AGENT_ENTRY_TITLE,
            onClick: () => { ensureDmaStyles(); setOpen((v) => !v) },
            style: { fontSize: props.wide ? 12 : 14, padding: '4px 8px', border: 'none', borderRadius: 6 },
          }, props.wide ? 'Agent 编辑器' : '词'),
          open && e(AgentEditorPanel, { onClose: () => setOpen(false) }),
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
              e('span', { key: 's1', style: dimBadgeStyle, title: '宿主配置里存了自定义文本（非内置默认）' }, '自定义')]
            : [e('span', { key: 's0', style: dimBadgeStyle, title: '宿主配置未存自定义文本，正在使用内置默认' }, '当前：内置默认')]
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
            e('div', null, e('button', { className: 'dma-btn', style: btnStyle, onClick: () => setTick((x) => x + 1) }, '重试')),
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
            e('button', { className: 'dma-btn', style: btnStyle, disabled: save.busy, onClick: () => act(draft, '已保存，并已按宿主回读同步') },
              save.busy ? '保存中…' : '保存'),
            e('button', {
              className: 'dma-btn', style: btnStyle, disabled: save.busy,
              title: '把该键存为 null 恢复内置默认；成功后文本框同步成回读值',
              onClick: () => act(null, '已恢复内置默认（文本框已同步成回读值）'),
            }, '恢复内置默认'),
            e(CopyFeedbackBtn, {
              label: '复制', title: '复制文本框内容到剪贴板',
              onCopy: () => copyText(draft).then(
                () => setSave((s) => ({ ...s, ok: '已复制文本框内容', error: '' })),
                () => setSave((s) => ({ ...s, error: '复制失败 [COPY_FAIL]', ok: '' })),
              ),
            }),
            e('button', {
              className: 'dma-btn', style: btnStyle, disabled: save.busy || typeof t.builtin !== 'string',
              title: '把内置默认填进文本框（不保存，可先改再存）',
              onClick: () => setDraft(typeof t.builtin === 'string' ? t.builtin : ''),
            }, '载入内置默认'),
          ),
          save.ok ? e('div', { style: okStyle }, save.ok) : null,
          save.error ? e('div', { style: errorStyle }, save.error) : null,
          meta.vars ? e('div', { style: dimStyle }, meta.vars) : null,
          e('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            e('button', {
              className: 'dma-btn dma-mini',
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

      // ---------- 提示词模板容器（记忆库面板内）：两子页 tab + 返回阅读 ----------
      // v4.1：「每次请求」查看器已拆成独立入口 prompt-viewer，这里只剩模板两子页。
      function TemplatesView({ onBack }) {
        const [tab, setTab] = React.useState('compaction')
        const tabBtn = (key, label) => e('button', {
          key: key,
          className: 'dma-btn dma-tab',
          'data-sel': tab === key ? '1' : '0',
          style: btnStyle,
          onClick: () => setTab(key),
        }, label)
        return e('div', { style: colFillStyle },
          e(SectionLabel, { text: '提示词模板' }),
          e('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', flex: 'none' } },
            tabBtn('compaction', '压缩指令'),
            tabBtn('placeholder', '收纳占位'),
            e('span', { style: { flex: 1 } }),
            e('button', { className: 'dma-btn', style: btnStyle, onClick: onBack }, '← 返回阅读'),
          ),
          e('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
            e('div', { style: scrollColStyle }, e(TemplateCard, { key: tab, templateKey: tab })),
          ),
        )
      }

      // ---------- 设置视图 A：根模式单选（只活在这里；工作区在 Tavern 不可达时置灰 + 原因） ----------
      function RootModePicker({ config, health, saveMode, modeBusy, modeError }) {
        const current = config && config.rootMode === 'workspace' ? 'workspace' : 'session'
        const tavernBad = !!(health && health.tavernReachable === false)
        const radio = (mode, label, desc, disabled, reason) => e('label', {
          className: 'dma-click',
          style: { display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 12, lineHeight: 1.5, opacity: disabled ? 0.5 : 1 },
        },
          e('input', {
            type: 'radio', name: 'dsh-memory-archive-root-mode', className: 'dma-radio',
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
            e('button', { className: 'dma-btn', style: btnStyle, onClick: doSave, disabled: act !== '' }, act === 'save' ? '保存中…' : '保存'),
            e('button', { className: 'dma-btn', style: btnStyle, onClick: doTest, disabled: act !== '' }, act === 'test' ? '正在测试…（可能需要数十秒）' : '测试连接'),
            e('button', { className: 'dma-btn', style: btnStyle, onClick: doClear, disabled: act !== '' || !keySet }, act === 'clear' ? '清除中…' : '清除密钥'),
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
          e('button', { className: 'dma-btn', style: btnStyle, onClick: onBack }, '← 返回阅读'),
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
            e('button', { className: 'dma-btn', style: btnStyle, onClick: reload }, '重试'),
          )
        } else if (host.configStatus === 'loading') {
          body = e('div', { style: dimStyle }, '正在读取配置…')
        } else if (host.configStatus === 'error' || !host.config) {
          body = e('div', { style: colFillStyle },
            e('div', { style: errorStyle }, '配置读取失败：' + (host.configError || '未知错误')),
            e('button', { className: 'dma-btn', style: btnStyle, onClick: reload }, '重试'),
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
          // v4.1 B 单：编辑功能只加备注、不实现（逐字文案来自规格 §三）——没有新增任何写归档代码路径
          e('div', { style: dimStyle }, '待实现（已记录）：编辑功能 —— 直接修改摘要正文、楼层正文与状态档案。当前版本只读。'),
          // v4.1 D 单：CSS 兼容同样只记备忘、不实现（逐字文案来自 D 单规格 §三.1）
          e('div', { style: dimStyle }, '待实现（已记录）：CSS 兼容 —— 支持自定义 CSS / DSH 主题变量覆盖。当前只用系统色与内联样式，尚未支持用户自定义 CSS。'),
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
          e('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', fontSize: SMALL_FONT_SIZE } }, bits),
        )
      }

      // ---------- 面板主体：顶栏（当前根人话名 + 提示词/设置/全屏/关闭）+ 视图切换 ----------
      function ArchivePanel({ onClose }) {
        const [view, setView] = React.useState('read')                 // 'read' | 'templates' | 'settings'（查看器已在 v4.1 拆出本面板）
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

        return e('div', Object.assign({}, backdropStyle, { onClick: fullscreen ? undefined : onClose }),
          e('div', { style: fullscreen ? shellFullStyle : shellStyle, onClick: (ev) => ev.stopPropagation() },
            // 顶栏：★ 没有根模式单选（它只活在设置视图里）
            e('div', { style: headerStyle },
              e('strong', { style: { fontSize: 14 } }, '记忆库'),
              e('button', {
                className: 'dma-btn dma-entry',
                style: { border: 'none', fontWeight: 700, fontSize: 13 },
                onClick: () => setView('settings'), title: rootTitle,
              }, '当前根：' + rootText),
              rootBadge ? e('span', { style: rootWarn ? warnBadgeStyle : dimBadgeStyle, title: rootBadge.title }, rootBadge.text) : null,
              cfgReady && host.config.configError
                ? e('span', { style: errorStyle, title: String(host.config.configError) }, '⚠')
                : null,
              e('div', { style: { flex: 1 } }),
              dot,
              e('button', {
                className: 'dma-btn dma-tab', 'data-sel': view === 'templates' ? '1' : '0',
                onClick: () => setView(view === 'templates' ? 'read' : 'templates'), title: '提示词模板（压缩指令 / 收纳占位）；查看模型收到的原文请用侧边栏的独立入口',
              }, '提示词模板'),
              e('button', {
                className: 'dma-btn dma-tab', 'data-sel': view === 'settings' ? '1' : '0',
                onClick: () => setView('settings'), title: '设置（根模式 / 根选择 / API / 诊断）',
              }, '⚙ 设置'),
              e('button', { className: 'dma-btn', style: btnStyle, onClick: () => setFullscreen((v) => !v), title: fullscreen ? '退出全屏' : '全屏' }, '⛶'),
              e('button', { className: 'dma-btn', style: btnStyle, onClick: onClose, title: '关闭面板' }, '✕'),
            ),
            e('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
              view === 'read'
                ? e(ReadArea, {
                  key: mode + '|' + (archivePath || '') + '|' + (mode === 'session' ? sessId : ''),
                  mode: mode, tavernOk: tavernOk, healthStatus: host.healthStatus,
                  archivePath: archivePath, eventsSessionId: eventsSessionId,
                  nameIdx: nameIdx, catalogError: catalog.error,
                  onClose: onClose,
                  fullscreen: fullscreen, setFullscreen: setFullscreen,
                })
                : view === 'templates'
                  ? e(TemplatesView, { onBack: () => setView('read') })
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

      /** 入口：侧边栏两个席位（v4.1 契约：同插件两席，id 必须不同；都是 sidebar.footer.action） */
      function apply(ctx) {
        // D 单：搜索类阅读源已整体移除 ⇒ 不再注入/使用 sessions 能力，inject 名单只剩 'slots'

        // 席位 1：记忆库（阅读 / 提示词模板 / 设置）
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'memory-archive' },
          function MemoryArchiveButton(props) {
            const [open, setOpen] = React.useState(false)
            return e('div', { style: { position: 'relative' } },
              e('button', {
                className: 'dma-btn dma-entry',
                title: '记忆库 · 阅读与设置', 'aria-label': '记忆库 · 阅读与设置',
                onClick: () => { ensureDmaStyles(); setOpen((v) => !v) },
                style: { fontSize: props.wide ? 12 : 15, padding: '4px 8px', border: 'none', borderRadius: 6 },
              }, props.wide ? '记忆库' : '⚙'),
              open && e(ArchivePanel, { onClose: () => setOpen(false) }),
            )
          },
        ))

        // 席位 2：Agent 编辑器（v5 P0 由「提示词查看器」升格；独立浮层：组成 / 每次请求 / 可写项
        //   + Skill 区 + 「生成 / 修复 RP agent」检测与预览。本版只读，零写入。）
        // 组件本体是模块级的 AgentEditorButton（提升后此处直接引用）。
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'agent-editor' },
          AgentEditorButton,
        ))
      }

      exports.apply = apply
      // 注入名单：
      //   'slots'    —— 注册侧边栏 `sidebar.footer.action` 席位 ×2（记忆库齿轮 + Agent 编辑器）
      //   ★ v4.1 D 单：'sessions' 已随搜索类阅读源一并移除（玩家侧检索用浏览器 Ctrl+F 即可）
      exports.inject = ['slots']
      exports.name = 'dsh-memory-archive'

      // 仅供自检脚本直接调用内部纯函数；不对外承诺稳定，随时可能变化。
      exports.__internals = {
        buildCatalogIndex: buildCatalogIndex,
        shortId: shortId,
        labelCharacter: labelCharacter,
        labelPlaythrough: labelPlaythrough,
        labelSession: labelSession,
        pad4: pad4,
        // v4.1：工作区名解析 / 空会话过滤 / 相对时间 / 分组 / system 分段注释
        workspaceLabelFromCwd: workspaceLabelFromCwd,
        decodeWorkspaceSlug: decodeWorkspaceSlug,
        hiddenSessionReason: hiddenSessionReason,
        relativeTime: relativeTime,
        groupSessionsByWorkspace: groupSessionsByWorkspace,
        splitSystemSections: splitSystemSections,
        splitMessagesText: splitMessagesText,
        clipInfo: clipInfo,
        // v4.1 D 单：正文 Markdown 解析（纯函数；块形状 {kind:'h1'|'h2'|'h3'|'p'|'ul'|'ol'|'quote'|'code'|'hr', …}）
        parseMarkdown: parseMarkdown,
      }

      return module.exports
    })()
  },
})
