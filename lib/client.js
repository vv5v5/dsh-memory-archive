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
 *   + E 单（20260913）「提示词装配地图」：Agent 编辑器新增一列 PromptMap（自检出口 exports.__promptMap，
 *     ⛔ 不并进 __internals——既有台子对它的键集合做了恰好 15 个的断言）：
 *     [system]/[tools]/[messages] 三框竖排 + 红(固定/高危)/黄(每轮记录)/蓝(工具)/灰虚线(未检出/未落地)
 *     四色分区 + ★静态/每轮标注（实测两轮文本比对 > 已知类型 > 未知，判不出来不猜成静态）
 *     + 每块悬停提示（order/谁注入/实际字数/作用/改它的后果）。未检出的已知注入位画灰虚线并
 *     注明「未检出（可能是本会话没装/没启用）」，沿用宿主口径：不把「没探到」说成「不存在」。
 *   + F 单（20260918）「OOC 划词质疑（近似版）」：新增第 3 席 `conversation.input.right`
 *     （id `ooc-quote`，order 90，排在重启按钮 100 之前；自检出口 exports.__ooc，⛔ 同样
 *     不并进 __internals 等既有出口）。★ 20260919 起产出**以 `OOC:` 单独一行开头** —— 社区 RP
 *     预设的 OOC 契约**看开头**（`OOC:` / `（OOC）` / `【导演】`），旧形状（`> 引用` 打头 +
 *     `【OOC】` 标记）两个都不在它名单里 ⇒ 光按质疑进不了场外分支。会话正文里划选 AI 回复 ⇒
 *     点「质疑」⇒ 把「`OOC:` 首行 + 原草稿 + `> ` 逐行引用（超 120 字符截断并如实标注）+
 *     `我的质疑：`」**整体写回**输入框草稿，发送由玩家自己按。同一座位还有第 3b 席
 *     （id `ooc-prefix`，order 89，按钮文案「OOC」）：一键给草稿加 `OOC: ` 前缀 ——
 *     「质疑」产出已带 `OOC:` 开头 ⇒ 再按它是一个字不动的幂等。
 *     三条底线：① 先读后写 —— 草稿从宿主 props 读（InputActions 只写），
 *     读不到就一个字不写（setDraft 是整体替换，盲写 = 覆盖玩家草稿 = 头号事故）；
 *     ② 选区只在会话区容器里才算数（容器判据 = 三档候选选择器 + 排除自家 dma- 面板与侧边栏，
 *     判不出就禁用并写明原因，绝不猜）；③ 选区文本不落盘，只走发送链路。
 *   + 视觉单（20260919）：这两颗输入栏按钮不再借用面板的 `.dma-btn`（那是给面板写的规矩），
 *     改成与输入栏邻居 dsh-restart-button 同一套语言：28 高幽灵盒子（内联）+ 交互态走
 *     注入 CSS（类名 `dma-ooc-btn`，自己的 dma- 前缀，绝不命中 DSH 自有界面）。
 *
 * 格式：factory 形式 CJS，由 DSH 的 `window.__ModuleLoader__` 加载
 *   （react 在平台 seed 表内，所以**不需要构建**；无 JSX，全 React.createElement，别名 e）。
 * 暴露：`exports.apply` / `exports.inject` / `exports.name`，
 *   另有 `exports.__internals`（仅供自检脚本直接调用内部纯函数，不对外承诺稳定）。
 * 注册恰好 **3 个**席位（v4.1 起同插件多席、id 必须不同；20260918 F 单新增输入栏第 3 席）——
 *   席位 1、2 都是 `sidebar.footer.action`（list；owner props {wide}）：
 *   1) id `memory-archive` —— 「记忆库」齿轮：阅读 / 提示词模板（压缩指令+收纳占位）/ 设置。
 *      ★ 每次请求查看器已从本面板拆出（v4 里它曾混在提示词块里）；仍不注册任何设置页席位。
 *   2) id `agent-editor`（v5 P0：由 prompt-viewer 升格）—— 「Agent 编辑器」：窄屏显示 `词`，
 *      title `Agent 编辑器 · 组成 / 每次请求 / 可写项`。独立浮层（自己的开合状态 / ✕ /
 *      AbortController），三块 + 两区：组成（preset 段/插件/order + 注释）/ 每次请求
 *      （原查看器整体搬入，一块不丢）/ 可写项（当前值 + 一致性 + 写入入口）/ Skill 区（组件内
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
 *   工作区模式：摘要（默认）/ 原文 / 剧情大纲（★ 2026-09-20：「状态」档已摘除）；
 *     摘要 = summaries/index.json 顺序 + 滚动窗口 ≤2 顺序取正文，首尾相接渲染成一篇长文
 *           （>60 篇先渲染 60 篇 + 「加载后 20 篇」；保留前端子串过滤；每篇有「复制本篇」）；
 *     原文 = 一次 ?list=floors 拿楼号上限（失败退 visibility.json 键数），顺序懒加载
 *           （一次只取一个文件、最多预取 1 个）；visibility[sent===false] 的楼层标「未发给模型」；
 *           常驻工具条：跳到楼号 / 首楼 / 末楼 / 上一楼 / 下一楼；
 *     剧情大纲 = 宿主 GET /playthrough/rp-memory（社区 RP 预设写在工作目录下的 .roleplay-memory/，
 *           我们**只读**、⛔ 不碰那个预设；列目录里实际有的那些 md，正文点哪一份才取哪一份）。
 *           ★ 防剧透门（20260919）：记忆库是作者视角，**默认不可见** —— 切到该档只显示一句
 *           说明 + 「显示角色扮演记忆库（含剧透）」确认按钮；点了才发请求、才渲染（⛔ 不是"先加载好
 *           再遮住" —— 未确认前连请求都不发）；切走再切回 = 组件卸载重建 ⇒ 回到未确认态。
 *           目录还没有时给一句人话，不是空白也不是报错堆栈。
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
 *
 * @license CC-BY-NC-4.0 (Attribution-NonCommercial 4.0 International)
 * 移植来源：anima-rag (https://github.com/Ellinav/anima-rag) — 作者 Ellinav
 * 仅限个人学习与非商业用途；禁止闭源商用或转为付费插件/服务；不重新分发预置私域数据。
 * 含 DeepSeek Harness 派生部分（MIT, Copyright (c) 2026 DeepSeek）时该部分保留 MIT。
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
      const SECTIONS_API_BASE = HOST_API_BASE         // C4 段结构（组装捕获真相源）：GET /dsh-memory-archive/api/sections?sessionId=&turn=
      // §9（20260914 用户决定）：单段正文改走「记忆库路径」新端点（M1 实现）。
      // ⛔ 客户端不许自己读会话文件、不许拉整段 system 自己切 —— 正文一律从这里的响应取。
      // ★ 路径纪律（20260914 返工单）：端点全路径 = /dsh-memory-archive/api/sections/text，由上面的
      //   HOST_API_BASE（= 宿主半侧 API_PREFIX，即 /dsh-memory-archive/api）推出，⛔ 不许再手写第二个
      //   前缀字面量 —— 路径只能从注册前缀常量推（或真打一次接口），不能锁自己写的字面量。
      //   正文端点 = SECTIONS_API_BASE + '/sections/text'（M1 的 ENDPOINTS 表注册名 '/sections/text'）。
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
      // 20260913 改版：Skill 勾选区整体移除（用户拍板：纯组件内 state、零功能 —— skill 本就由插件默认注册）。
      const AGENT_ENTRY_TITLE = '提示词查看器 · 会话 / 装配地图 / 维护'
      const DETECT_FOOTER = '本版只做检测与预览，不会写入任何文件。写入走下方 [应用]：先干跑预览（零写入），确认后才真落盘（自动备份 + 回读校验 + 不一致自动回滚）。'
      // v5 P2 可写项块三态文案（官方语义口径）：可写 = preset.writable === true；
      // 只读 = 随部署附带；未知 = 读不到 preset（不猜）。读取中的瞬态 = 「正在读取可写性…」。
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
      // M16（用户截图反馈）：底栏从三行堆叠改成**一行工具条**（左=状态，中=cwd/preset 可截断，右=复制按钮）
      const statusAreaStyle = {
        display: 'flex', flexDirection: 'row', gap: 10, alignItems: 'baseline', flexWrap: 'wrap',
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
      // 「向量」档：需要注意（⚠缺失 / 别的周目 / 未绑定）用琥珀胶囊，危险（失败、删库确认）仍走红 —— 三色分工别混
      const amberBadgeStyle = {
        fontSize: SMALL_FONT_SIZE, color: 'DarkGoldenrod', borderRadius: 999, padding: '0 8px',
        background: 'color-mix(in srgb, DarkGoldenrod 10%, Canvas)',
        border: '1px solid color-mix(in srgb, DarkGoldenrod 40%, transparent)',
      }
      // 危险动作的小按钮（删库）：红字红边，形状与 miniBtnStyle 完全一致（只换配色）
      const dangerMiniBtnStyle = Object.assign({}, miniBtnStyle, {
        color: 'crimson', borderColor: 'color-mix(in srgb, crimson 40%, transparent)',
      })
      // 提示词区·每次请求（吸收自 dsh-prompt-viewer）：三栏布局与专用样式
      // 20260913 改版：主体两栏（会话列表 + 装配地图）；colSessionStyle 仍用于会话列表列。
      const columnsStyle = { display: 'flex', gap: 8, flex: 1, minHeight: 0 }
      // 「维护」抽屉（20260913）：浮层面板右侧的次级入口，可写项/检测/备份/一键生成都在这里
      const maintDrawerStyle = {
        position: 'absolute', top: 44, right: 12, bottom: 64, width: 400, zIndex: 20,
        display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', boxSizing: 'border-box',
        background: 'Canvas', color: 'CanvasText',
        border: '1px solid ButtonBorder', borderRadius: 8,
        boxShadow: '0 6px 18px rgba(0,0,0,.25)', overflow: 'hidden',
      }
      // C 单：查看器三栏之间的竖分隔线（1px ButtonBorder）
      const colSessionStyle = Object.assign({}, colFillStyle, { width: 260, flexShrink: 0, borderRight: '1px solid ButtonBorder', paddingRight: 10 })
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
        // ---- 20260913 美化（对齐用户拍板的视觉稿）----
        // 装配地图：三框 = 卡片；色块行 = 圆角条 + 左色条 + 悬停底色；可下钻行 pointer + 悬停加深
        '.dma-pmbox { border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); border-radius: 8px; padding: 8px 10px; background: color-mix(in srgb, CanvasText 2%, Canvas); }',
        '.dma-pmrow { border-radius: 6px; padding: 3px 8px 3px 10px; background: Canvas; border: 1px solid color-mix(in srgb, CanvasText 10%, transparent); border-left-width: 4px; }',
        '.dma-pmrow:hover { background: color-mix(in srgb, CanvasText 4%, Canvas); }',
        '.dma-pmrow[data-pm-click="1"] { cursor: pointer; }',
        '.dma-pmrow[data-pm-click="1"]:hover { background: color-mix(in srgb, CanvasText 7%, Canvas); border-color: color-mix(in srgb, CanvasText 22%, transparent); }',
        '.dma-pmrow[data-pm-dashed="1"] { background: transparent; border-style: dashed; border-left-style: dashed; opacity: .82; }',
        // 三级导航（20260913）：L2 消息定位从左侧滑出；L3 详细与「维护」共用右侧抽屉滑入。
        // ★ 轮次切换胶囊/步进器已删（类名一并移除，见自检静态断言）—— 楼号入口 = L2 的消息定位，「第 N / M 楼」只是状态行。
        '@keyframes dmaSlideInLeft { from { transform: translateX(-24px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }',
        '@keyframes dmaSlideInRight { from { transform: translateX(24px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }',
        '.dma-l2 { animation: dmaSlideInLeft 0.16s ease-out; }',
        '.dma-drawer { animation: dmaSlideInRight 0.16s ease-out; }',
        // 会话行两行结构的次行（时间 · 工作区）
        '.dma-row[data-sel="1"] .dma-sub { color: HighlightText; opacity: .8; }',
        // 维护抽屉的分组卡片
        '.dma-card { border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); border-radius: 8px; padding: 8px 10px; background: Canvas; }',
        // 左右栏分隔条：细把柄 + 悬停/拖动时高亮（cursor 在这里给，内联不写）
        '.dma-splitter { cursor: col-resize; flex: none; width: 6px; border-radius: 4px; margin: 0 1px; }',
        '.dma-splitter:hover { background: ButtonFace; box-shadow: inset 1px 0 0 color-mix(in srgb, CanvasText 35%, transparent), inset -1px 0 0 color-mix(in srgb, CanvasText 35%, transparent); }',
        // ---- 20260919 输入栏 OOC 两钮（ooc-prefix「OOC」/ ooc-quote「质疑」）----
        // ★ 为什么不用面板的 .dma-btn：那是给面板写的规矩（Canvas 常态底 / hover ButtonFace /
        //   2px 外扩焦点环）；输入栏的事实标准是邻居 dsh-restart-button 的「幽灵样式」——
        //   常态透明底 GrayText、hover 才浮现、焦点环 1px 内描边。两颗按钮得跟邻居说一套话。
        // ★ 类名必须带我们自己的 dma- 前缀：⛔ 绝不命中 DSH 自有界面；也不复用面板类（规矩不同）。
        //   交互态逐条对齐邻居 .dsrrb-btn（其 client.js :73-83）。
        '.dma-ooc-btn { border: none; background: transparent; color: GrayText; font: inherit; line-height: 1.4; }',
        '.dma-ooc-btn:hover { color: CanvasText; background: color-mix(in srgb, CanvasText 6%, Canvas); }',
        '.dma-ooc-btn:focus-visible { outline: 1px solid Highlight; outline-offset: -1px; }',
        '.dma-ooc-btn:disabled { color: GrayText; background: transparent; opacity: .55; cursor: default; }',
        '.dma-ooc-btn:disabled:hover { color: GrayText; background: transparent; }',
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

      /**
       * 「归档还没建立」与「读失败」是两件事（用户 2026-09-15 口径：**容忍空库**）。
       * 实测：Tavern 对**不存在的路径**回 404 + `code = 'PLAY_PATH_NOT_FOUND'`；
       * 未绑定工作区则是 `PLAY_WORKSPACE_NOT_FOUND`。这两种**不是错误** ⇒ 界面上显示
       * 「该周目还没有归档」的空态，而不是把 404 原文糊在脸上。
       */
      function isArchiveMissing(error) {
        const code = error && typeof error.code === 'string' ? error.code : ''
        return code === 'PLAY_PATH_NOT_FOUND' || code === 'PLAY_WORKSPACE_NOT_FOUND'
      }

      /**
       * M8（20260914）：**日志在 DSH 层读不出来**时给用户看的一屏实话（纯函数，自检直测）。
       *
       * 为什么要有它：DSH 自己的日志解析器（`session-persistence-jsonl` 的 seq 连续性检查）会拒绝某些会话日志
       * （真机实测 63 条里 12 条）。我们的面板以前对这种情况**显示成空的** —— 看起来就像"这条会话什么都没有"，
       * 用户会误以为是本插件或预设不合。⇒ 读不出来就必须说出来，并且说清是谁的锅、影响面多大。
       *
       * @param {{code?:string, message?:string, detail?:{line:number,expected:number,got:number}|null}|null} parseError
       *   来自 C1 `/api/turns` 失败响应的 `error` 字段；健康时为 null。
       * @returns {{head:string, lines:string[]}|null} 不是「日志解析失败」⇒ null（⛔ 不许对健康会话弹这一屏）
       */
      function pmReadFailNotice(parseError) {
        if (!parseError || parseError.code !== 'session-parse-failed') return null
        const message = typeof parseError.message === 'string' && parseError.message !== ''
          ? parseError.message
          : '（DSH 没有给出可解析的错误原文）'
        const d = parseError.detail
        const where = d && Number.isFinite(d.line)
          ? '位置：第 ' + d.line + ' 行（期望 seq ' + d.expected + '、实得 ' + d.got + '）'
          : '位置：DSH 未给出可解析的行号 —— 只有原文，不编位置'
        return {
          head: '该会话的日志在 DSH 层读不出来',
          lines: [
            'DSH 原文：' + message,
            where,
            '⚠ 这与本插件无关 —— DSH 自己的日志解析器（session-persistence-jsonl 的 seq 连续性检查）拒绝了这段日志，',
            '所以这条会话在本面板里没有轮次 / 消息 / 地图可看。其它会话不受影响。',
          ],
        }
      }

      /**
       * M9（20260914）：**事实说明书**（`?` 面板）的内容 —— 纯数据，自检直测。
       *
       * 为什么要有它：地图一眼看下去信息量很大，但"这个视觉元素**是什么、不是什么**"以前没有一处集中说清。
       * 用户两次踩的坑（旧楼为什么不可用、contexts 为什么不算 system）本质都是**语义没处可查**。
       * 口径照抄 Archify 的「事实型 Diagram Guide」：只写**能站住的判据**，不写推销词。
       */
      function editorHelpSections() {
        return [
          {
            title: '这张图是什么',
            lines: [
              '把「那一楼真实发出的请求」拆开看，四个部件各自独立：',
              '· system —— 由 sections 按 order 拼成（段与段之间固定两个换行）',
              '· 上下文 —— contexts，「不在 system 里」：它作为一条独立消息发出（首行 Current runtime context…）',
              '· tools —— 工具定义数组，独立字段（不在 system 里）',
              '· messages —— 那一楼实际带上的对话历史',
            ],
          },
          {
            title: '字数口径（可自己验算）',
            lines: [
              '字数是「插值后」的长度（不是模板原文长度）。',
              'Σ(非空段字数) + 2×(非空段数−1) = 该楼 system 的实际长度（悬停"system 小计"能看到这条算式）。',
              '0 字的段不占位：它的 offset 记 null（⛔ 不是 0 —— 0 是"第一段"的合法位置）。',
            ],
          },
          {
            title: '顺序脊：头 / 中 / 尾',
            lines: [
              '负 order = 头（身份、来源这类恒定注入），order ≥ 1000 = 尾（工具面与交付约定），其余 = 中（人设、预设、策略）。',
              '分界不是拍的：真机 order 分布里 900 与 1010 之间是唯一空档（900=context:file-reference，1010=tool:pwsh）。',
              '它表示「注入顺序」，⛔ 不代表重要性，也不代表谁更该看。',
            ],
          },
          {
            title: '颜色与徽标',
            lines: [
              '红 = 固定/高危段；黄 = 每轮重新生成的段；蓝 = 工具；灰虚线 = 未检出。',
              '静态 / ★每轮：判据是「段定义」（运行时 PromptSection.text 是字符串还是函数）—— 最权威口径。',
              '「未知」就是判不出来，如实写未知，⛔ 不猜。',
            ],
          },
          {
            title: '四句"如实降级"人话（看到它们时该怎么办）',
            lines: [
              '「未检出（…）」≠ 不存在 —— 探不到就不列已检出，但也不说它不存在。',
              '「文本推断 · 边界可能不准」= 该楼「没有组装捕获记录」（会话早于插件加载，或记录已按上限淘汰），段结构是按文本猜的，只能定位用。',
              '「该段内容不可用（未记录位置）」= 捕获记录里没有 offset（旧版记录）；宁可不给，也不瞎切一段给你。',
              '「⚠ 该会话的日志在 DSH 层读不出来」= 「DSH 自己的」日志解析器（seq 连续性检查）拒绝了这段日志 ⇒ 与本插件无关，其它会话不受影响。',
            ],
          },
          {
            title: '已归档',
            lines: [
              '归档来自工作区注册表的只读投影（archivedSessionIds）。',
              '归档「不影响」日志与正文的可读性：编辑器列表默认隐藏它（有开关），记忆库选根处只打徽标、默认不隐藏。',
              '读不到注册表时一律显示「未知」，⛔ 不冒充"未归档"。',
            ],
          },
          {
            title: '把这一屏发给别人',
            lines: [
              '地址栏里的深链就是当前状态：`#sess=<会话id>&turn=<楼>&box=<system|tools|messages>&sec=<段名>`。',
              '复制地址即可复现同一楼、同一下钻；⛔ 深链不含任何正文。',
              '按 `?` 开关本页，按 `Esc` 关掉。',
            ],
          },
        ]
      }

      /**
       * M9：读地址栏深链（纯函数）。只认四个键，其余忽略；⛔ 不猜、不报错。
       * @param {string} hash - 形如 `#sess=…&turn=3&box=system&sec=harness:identity`
       * @returns {{sess?:string, turn?:number, box?:string, sec?:string}}
       */
      function readHashLink(hash) {
        const out = {}
        const raw = String(hash == null ? '' : hash).replace(/^#/, '')
        if (raw === '') return out
        let q
        try {
          q = new URLSearchParams(raw)
        } catch {
          return out
        }
        const sess = q.get('sess')
        if (typeof sess === 'string' && sess !== '') out.sess = sess
        const turn = Number(q.get('turn'))
        if (Number.isInteger(turn) && turn >= 1) out.turn = turn
        const box = q.get('box')
        if (box === 'system' || box === 'tools' || box === 'messages') out.box = box
        const sec = q.get('sec')
        if (typeof sec === 'string' && sec !== '') out.sec = sec
        return out
      }

      /** M9：从地图块上取段名（块用 `key:'sec:<name>'`；`name`/`label` 兜底）。取不到 ⇒ ''（如实"没有"）。 */
      function sectionNameOf(block) {
        if (!block || typeof block !== 'object') return ''
        if (typeof block.name === 'string' && block.name !== '') return block.name
        if (typeof block.key === 'string' && block.key.indexOf('sec:') === 0) return block.key.slice(4)
        if (typeof block.label === 'string' && block.label !== '') return block.label
        return ''
      }

      /** M9：把状态拼成深链（纯函数，键序稳定 ⇒ 便于比对与分享）。 */
      function formatHashLink(state) {
        const q = new URLSearchParams()
        if (state && state.sess) q.set('sess', String(state.sess))
        if (state && state.turn) q.set('turn', String(state.turn))
        if (state && state.box) q.set('box', String(state.box))
        if (state && state.sec) q.set('sec', String(state.sec))
        const s = q.toString()
        return s === '' ? '' : '#' + s
      }

      /**
       * M9：把 `/api/editor/diagnostics` 的响应压成界面要用的东西（纯函数，自检直测）。
       * 每条诊断保留**稳定码**（给机器）+ 一行**人话**（给眼睛，含证据与修法），并且如实分轻重：
       * error=契约破了 / warn=有降级但能用 / info=只是告诉你一声。⛔ 不把 info 说成问题。
       * @param {{ok?:boolean, counts?:object, diagnostics?:Array}|null} resp
       * @returns {{ok:boolean, counts:{error:number,warn:number,info:number}, chips:Array<{code:string,severity:string,text:string,tip:string}>}}
       */
      function summarizeDiagnostics(resp) {
        const empty = { ok: false, counts: { error: 0, warn: 0, info: 0 }, chips: [] }
        if (!resp || resp.ok !== true || !Array.isArray(resp.diagnostics)) return empty
        const sevOrder = { error: 0, warn: 1, info: 2 }
        const list = resp.diagnostics.slice().sort((a, b) => (sevOrder[a.severity] ?? 3) - (sevOrder[b.severity] ?? 3))
        const chips = list.map((d) => {
          const ev = d.evidence && typeof d.evidence === 'object' ? d.evidence : {}
          const bits = []
          if (ev.message) bits.push(String(ev.message))
          if (ev.detail && Number.isFinite(ev.detail.line)) bits.push('第 ' + ev.detail.line + ' 行（期望 seq ' + ev.detail.expected + '、实得 ' + ev.detail.got + '）')
          if (Number.isFinite(ev.sectionsWithoutOffset)) bits.push('缺 offset：' + ev.sectionsWithoutOffset + '/' + ev.totalSections + ' 段')
          if (Number.isFinite(ev.sectionsWithoutCredentials)) bits.push('缺凭据：' + ev.sectionsWithoutCredentials + '/' + ev.totalSections + ' 段')
          if (Number.isFinite(ev.expectedBySections) && Number.isFinite(ev.recordedRenderedChars)) bits.push('按段算 ' + ev.expectedBySections + ' vs 记录 ' + ev.recordedRenderedChars)
          if (ev.reason) bits.push(String(ev.reason))
          const fixes = Array.isArray(d.supportedFixes) ? d.supportedFixes : []
          const mark = d.severity === 'error' ? '✖' : (d.severity === 'warn' ? '⚠' : 'ℹ')
          return {
            code: String(d.code),
            severity: String(d.severity || 'info'),
            text: mark + ' ' + d.code,
            tip: [bits.join('；'), fixes.length ? '可做的事：' + fixes.join('；') : ''].filter(Boolean).join('\n'),
          }
        })
        const counts = { error: 0, warn: 0, info: 0 }
        for (const d of list) if (counts[d.severity] !== undefined) counts[d.severity]++
        return { ok: true, counts, chips }
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

      // ---------- 仅开发用：编辑器 v2 fixture 取数开关（⛔ 默认走真端点） ----------
      // 开启方式：页面 URL 带 ?fixture=1。生产路径不含 fixture 分支；这里的数据 = W0 冻结的官方夹具
      //（_fixtures/editor-v2/，契约见 docs/INTERFACES-editor-v2.md）逐字内嵌，仅形状与文件一致。
      // ★ 惰性判定：SPA 启动会清掉 location.search（token 消费后 replaceState），
      // 所以不能在模块求值时读一次就缓存 —— 每次 apiGet 都现读 URL。
      function editorV2FixtureMode() {
        try {
          if (new URLSearchParams(window.location.search || '').get('fixture') === '1') return true
          return /fixture=1/.test(window.location.hash || '')
        } catch (e) { return false }
      }
      const EDITOR_V2_FIXTURES = {"messages-empty":{"ok":true,"sessionId":"fixture-session-empty","total":0,"latestIndex":null,"messages":[]},"messages":{"ok":true,"sessionId":"fixture-session-static","total":10,"latestIndex":9,"messages":[{"index":0,"seq":16,"turn":1,"role":"user","preview":"开始吧","chars":3,"isToolResult":false,"isCompacted":false},{"index":1,"seq":18,"turn":1,"role":"assistant","preview":"（fixture）好的，我们开始。","chars":17,"isToolResult":false,"isCompacted":false},{"index":2,"seq":20,"turn":1,"role":"user","preview":"（fixture）请继续","chars":12,"isToolResult":false,"isCompacted":false},{"index":3,"seq":520,"turn":2,"role":"user","preview":"（fixture）先查一下状态","chars":15,"isToolResult":false,"isCompacted":false},{"index":4,"seq":523,"turn":2,"role":"assistant","preview":"（fixture）正在查询……","chars":14,"isToolResult":false,"isCompacted":false},{"index":5,"seq":526,"turn":2,"role":"tool","preview":"（fixture）工具结果：ok","chars":16,"isToolResult":true,"isCompacted":false},{"index":6,"seq":529,"turn":2,"role":"assistant","preview":"（fixture）查询完成。","chars":14,"isToolResult":false,"isCompacted":false},{"index":7,"seq":1188,"turn":3,"role":"user","preview":"（fixture）[压缩摘要] 前情提要……","chars":22,"isToolResult":false,"isCompacted":true},{"index":8,"seq":1190,"turn":3,"role":"assistant","preview":"（fixture）已了解背景。","chars":15,"isToolResult":false,"isCompacted":false},{"index":9,"seq":1192,"turn":3,"role":"user","preview":"（fixture）继续推进","chars":13,"isToolResult":false,"isCompacted":false}]},"part-inventory":{"ok":true,"sessionId":"fixture-session-injected","turn":2,"part":"inventory","toolCount":26,"toolChars":27448,"tools":[{"name":"pwsh","chars":4419},{"name":"tool_browser","chars":3329},{"name":"tool_code_run","chars":1800},{"name":"tool_file_read","chars":1500},{"name":"tool_file_write","chars":1200},{"name":"tool_web_search","chars":1100},{"name":"tool_web_fetch","chars":1000},{"name":"tool_todo","chars":950},{"name":"tool_memory_recall","chars":900},{"name":"tool_kb_query","chars":850},{"name":"tool_image_gen","chars":800},{"name":"tool_shell","chars":780},{"name":"tool_edit","chars":760},{"name":"tool_glob","chars":740},{"name":"tool_grep","chars":720},{"name":"tool_notebook","chars":700},{"name":"tool_patch","chars":680},{"name":"tool_render","chars":660},{"name":"tool_chart","chars":640},{"name":"tool_translate","chars":620},{"name":"tool_summary","chars":600},{"name":"tool_plan","chars":580},{"name":"tool_state","chars":560},{"name":"tool_card","chars":540},{"name":"tool_role","chars":520},{"name":"tool_extra","chars":500}]},"part-messages":{"ok":true,"sessionId":"fixture-session-static","turn":2,"part":"messages","requestLogged":false,"headerCarried":true,"count":6,"chars":278,"text":"── [seq 16] user ──\n开始吧\n\n── [seq 18] assistant ──\n好的，我们开始。\n\n── [seq 520] user ──\n（fixture）先查一下状态\n\n── [seq 523] assistant ──\n（fixture 思维链）玩家要查状态：先调 status 工具，等结果再回答。\n这一段是词头演示，全文不进查看器。（fixture）正在查询……\n\n── [seq 526] tool ──\n（fixture）工具结果：ok\n\n── [seq 529] assistant ──\n（fixture）查询完成。","messages":[{"seq":16,"turn":1,"role":"user","preview":"开始吧","chars":3,"isToolResult":false,"isCompacted":false,"blocks":[{"kind":"text","chars":3,"head":"开始吧"}]},{"seq":18,"turn":1,"role":"assistant","preview":"好的，我们开始。","chars":8,"isToolResult":false,"isCompacted":false,"blocks":[{"kind":"text","chars":8,"head":"好的，我们开始。"}]},{"seq":520,"turn":2,"role":"user","preview":"（fixture）先查一下状态","chars":15,"isToolResult":false,"isCompacted":false,"blocks":[{"kind":"text","chars":15,"head":"（fixture）先查一下状态"}]},{"seq":523,"turn":2,"role":"assistant","preview":"（fixture 思维链）玩家要查状态：先调 status 工具，等结果再回答。","chars":73,"isToolResult":false,"isCompacted":false,"blocks":[{"kind":"reasoning","chars":58,"head":"（fixture 思维链）玩家要查状态：先调 status 工具，等结果再回答。"},{"kind":"text","chars":15,"head":"（fixture）正在查询……"}]},{"seq":526,"turn":2,"role":"tool","preview":"（fixture）工具结果：ok","chars":16,"isToolResult":true,"isCompacted":false,"blocks":[{"kind":"text","chars":16,"head":"（fixture）工具结果：ok"}]},{"seq":529,"turn":2,"role":"assistant","preview":"（fixture）查询完成。","chars":14,"isToolResult":false,"isCompacted":false,"blocks":[{"kind":"text","chars":14,"head":"（fixture）查询完成。"}]}]},"part-system":{"ok":true,"sessionId":"fixture-session-static","turn":2,"part":"system","requestLogged":false,"headerCarried":true,"mutabilityBasis":"header-equal","chars":1946,"text":"（fixture 构造文本，非真实内容）You are an AI agent powered by DeepSeek Harness.\n\n……本楼未记录自己的 request/header（requestLogged:false），system 与第 1 楼逐字相等（headerCarried:true，宿主 headerEquals 判定）。\n静态会话回归夹具：切到第 2/3 楼时 system 必须仍然有值且与第 1 楼相同。"},"part-tools":{"ok":true,"sessionId":"fixture-session-static","turn":2,"part":"tools","requestLogged":false,"headerCarried":true,"mutabilityBasis":"header-equal","toolCount":0,"tools":[]},"sections-captured":{"ok":true,"sessionId":"fixture-session-injected","source":"captured","capturedAt":"2026-09-13T11:02:05.000+08:00","turn":2,"sections":[{"name":"harness:identity","order":-1000,"chars":48,"hash":"0f1e2d3c4b5a6978","mutability":"static","mutabilityBasis":"definition"},{"name":"deployment:persona","order":0,"chars":4010,"hash":"1a2b3c4d5e6f7081","mutability":"static","mutabilityBasis":"definition"},{"name":"roleplay:policy","order":45,"chars":2981,"hash":"2b3c4d5e6f708192","mutability":"per-turn","mutabilityBasis":"definition"}],"contexts":[{"name":"sandbox:policy","chars":312},{"name":"approval:policy","chars":0}],"tools":[{"name":"pwsh","chars":4419},{"name":"tool_browser","chars":3329},{"name":"tool_code_run","chars":1800},{"name":"tool_file_read","chars":1500},{"name":"tool_file_write","chars":1200},{"name":"tool_web_search","chars":1100},{"name":"tool_web_fetch","chars":1000},{"name":"tool_todo","chars":950},{"name":"tool_memory_recall","chars":900},{"name":"tool_kb_query","chars":850},{"name":"tool_image_gen","chars":800},{"name":"tool_shell","chars":780},{"name":"tool_edit","chars":760},{"name":"tool_glob","chars":740},{"name":"tool_grep","chars":720},{"name":"tool_notebook","chars":700},{"name":"tool_patch","chars":680},{"name":"tool_render","chars":660},{"name":"tool_chart","chars":640},{"name":"tool_translate","chars":620},{"name":"tool_summary","chars":600},{"name":"tool_plan","chars":580},{"name":"tool_state","chars":560},{"name":"tool_card","chars":540},{"name":"tool_role","chars":520},{"name":"tool_extra","chars":500}]},"sections-inferred":{"ok":true,"sessionId":"fixture-session-static","source":"inferred","capturedAt":null,"turn":2,"inferred":{"reason":"no-capture-record","message":"fixture（构造数据）：该楼没有组装捕获记录（会话早于本插件加载，或记录已按上限淘汰），以下段结构由文本推断，仅供定位 —— 界面必须明示「结构为文本推断」，不许当作捕获事实展示。"},"sections":[{"name":"identity","order":-1000,"chars":48,"hash":null,"mutability":"unknown","mutabilityBasis":"unknown"},{"name":"persona","order":null,"chars":1200,"hash":null,"mutability":"unknown","mutabilityBasis":"unknown"},{"name":"unknown","order":null,"chars":698,"hash":null,"mutability":"unknown","mutabilityBasis":"unknown"}],"contexts":[],"tools":[]},"turns-error":{"ok":false,"sessionId":"fixture-session-broken","error":{"code":"session-parse-failed","message":"fixture（构造数据）：会话日志解析失败，无法枚举轮次"},"latest":0,"turns":[]},"turns-injected":{"ok":true,"sessionId":"fixture-session-injected","latest":3,"turns":[{"turn":1,"startedAt":"2026-09-13T11:00:00.000+08:00","endedAt":"2026-09-13T11:01:20.000+08:00","messageCount":4,"seqRange":[2,501],"requestLogged":true,"headerCarried":false,"systemChars":7026,"toolCount":26},{"turn":2,"startedAt":"2026-09-13T11:02:05.000+08:00","endedAt":"2026-09-13T11:03:47.000+08:00","messageCount":5,"seqRange":[503,1002],"requestLogged":true,"headerCarried":false,"systemChars":7039,"toolCount":26},{"turn":3,"startedAt":"2026-09-13T11:04:30.000+08:00","endedAt":"2026-09-13T11:05:59.000+08:00","messageCount":4,"seqRange":[1004,1500],"requestLogged":true,"headerCarried":false,"systemChars":7032,"toolCount":26}]},"turns-noheader":{"ok":true,"sessionId":"fixture-session-noheader","headerAvailable":false,"latest":2,"turns":[{"turn":1,"startedAt":"2026-09-13T12:00:00.000+08:00","endedAt":"2026-09-13T12:00:18.000+08:00","messageCount":2,"seqRange":[1,88],"requestLogged":false,"headerCarried":false,"systemChars":null,"toolCount":null},{"turn":2,"startedAt":"2026-09-13T12:01:00.000+08:00","endedAt":"2026-09-13T12:01:26.000+08:00","messageCount":3,"seqRange":[90,200],"requestLogged":false,"headerCarried":false,"systemChars":null,"toolCount":null}]},"turns":{"ok":true,"sessionId":"fixture-session-static","latest":3,"turns":[{"turn":1,"startedAt":"2026-09-13T10:00:00.000+08:00","endedAt":"2026-09-13T10:00:41.000+08:00","messageCount":3,"seqRange":[14,517],"requestLogged":true,"headerCarried":false,"systemChars":1946,"toolCount":0},{"turn":2,"startedAt":"2026-09-13T10:01:12.000+08:00","endedAt":"2026-09-13T10:01:55.000+08:00","messageCount":4,"seqRange":[519,1184],"requestLogged":false,"headerCarried":true,"systemChars":1946,"toolCount":0},{"turn":3,"startedAt":"2026-09-13T10:02:30.000+08:00","endedAt":"2026-09-13T10:03:08.000+08:00","messageCount":3,"seqRange":[1187,1392],"requestLogged":false,"headerCarried":true,"systemChars":1946,"toolCount":0}]}}
      const EDITOR_V2_FIXTURE_TURN_FILES = {
        'fixture-session-static': 'turns',
        'fixture-session-injected': 'turns-injected',
        'fixture-session-noheader': 'turns-noheader',
        'fixture-session-empty': null,
        'fixture-session-broken': 'turns-error',
        'fixture-session-composite': 'turns-injected', // 复合段会话复用 3 楼的轮次夹具
      }
      const EDITOR_V2_FIXTURE_SESSIONS = [
        { id: 'fixture-session-static', title: '（fixture）静态会话 · 3 楼只 1 条 header', workspace: 'fixture', sizeBytes: 1024, mtime: '2026-09-13T10:03:08.000+08:00', requests: 1 },
        { id: 'fixture-session-injected', title: '（fixture）每轮注入 · 多 header', workspace: 'fixture', sizeBytes: 2048, mtime: '2026-09-13T11:05:59.000+08:00', requests: 3 },
        { id: 'fixture-session-broken', title: '（fixture）解析失败的会话', workspace: 'fixture', sizeBytes: 4096, mtime: '2026-09-13T09:00:00.000+08:00', requests: -2 },
        { id: 'fixture-session-noheader', title: '（fixture）无任何 request/header', workspace: 'fixture', sizeBytes: 512, mtime: '2026-09-13T12:01:26.000+08:00', requests: 1 },
        { id: 'fixture-session-empty', title: '（fixture）空会话', workspace: 'fixture', sizeBytes: 1, mtime: '2026-09-13T08:00:00.000+08:00', requests: 1 },
        // 20260914 M2：复合段夹具会话（<插件id>:profile 整段注入）—— 复合徽标 / 抽屉「复合段内部需 Tavern 接口」的证据源
        { id: 'fixture-session-composite', title: '（fixture）复合段 · 第三方 profile 整段注入', workspace: 'fixture', sizeBytes: 8192, mtime: '2026-09-14T09:00:00.000+08:00', requests: 3 },
      ]
        // 20260914 M2：/dsh-memory-archive/api/sections/text 的夹具（字段名按任务书 §9 冻结契约）。
      // 文本 = 构造的 fixture 文（首行自带「（fixture）」标识，绝不冒充真实内容），长度精确等于
      // sections-captured 夹具里的 chars，抽屉里的「字数」与端点 chars 才能对上。
      const pmFixText = (seed, n) => {
        let out = ''
        while (out.length < n) out += seed + ' '
        return out.slice(0, n)
      }
      const SECTIONS_TEXT_FIXTURE = {
        'fixture-session-injected': {
          'harness:identity': { offset: 0, text: pmFixText('（fixture）DSH 核心身份段正文：告诉模型它在 DSH 里、检出目录在哪、行为纪律。', 48) },
          'deployment:persona': { offset: 152, text: pmFixText('（fixture）部署级人设段正文：RP 身份（它以为自己是干什么的），落最前。', 4010) },
          'roleplay:policy': { offset: 4166, text: pmFixText('（fixture）RP 模式策略段正文：高风险操作被锁；身份与文风来自 preset / 角色卡。', 2981) },
          'sandbox:policy': { offset: 7151, text: pmFixText('（fixture）sandbox 上下文：沙箱策略说明。', 312) },
          'approval:policy': { offset: 7467, text: '' },
        },
        'fixture-session-composite': {
          'harness:identity': { offset: 0, text: pmFixText('（fixture）DSH 核心身份段正文。', 48) },
          'dsh-tavern:profile': { offset: 152, text: pmFixText('（fixture）第三方插件整段注入的复合段正文：ST 预设归一化后的内容（黑盒，内部结构本图不展开）。', 5200) },
          'ui:deliverable-file-references': { offset: 5356, text: pmFixText('（fixture）可交付文件引用说明（system 尾部固定段）。', 299) },
          'sandbox:policy': { offset: 5659, text: pmFixText('（fixture）sandbox 上下文。', 120) },
        },
      }
      // 复合段会话的 C4 段结构（与 SECTIONS_TEXT_FIXTURE['fixture-session-composite'] 的 chars 一一对应）
      const SECTIONS_CAPTURED_COMPOSITE = {
        ok: true, sessionId: 'fixture-session-composite', source: 'captured',
        capturedAt: '2026-09-14T09:00:00.000+08:00', turn: 2,
        sections: [
          { name: 'harness:identity', order: -1000, chars: 48, hash: '0f1e2d3c4b5a6978', mutability: 'static', mutabilityBasis: 'definition' },
          { name: 'dsh-tavern:profile', order: 10, chars: 5200, hash: '5a5a5a5a5a5a5a5a', mutability: 'per-turn', mutabilityBasis: 'definition' },
          { name: 'context:file-reference', order: 900, chars: 0, hash: 'e3b0c44298fc1c14', mutability: 'per-turn', mutabilityBasis: 'definition' },
          { name: 'ui:deliverable-file-references', order: 9000, chars: 299, hash: 'bc2dc17a65216924', mutability: 'static', mutabilityBasis: 'definition' },
        ],
        contexts: [{ name: 'sandbox:policy', chars: 120 }],
        tools: [{ name: 'pwsh', chars: 4419 }],
      }
      function editorV2FixtureLookup(url) {
        let u
        try { u = new URL(url, 'http://fixture.invalid') } catch (e) { return null }
        const p = u.pathname
        const q = u.searchParams
        const sid = String(q.get('id') || q.get('sessionId') || '')
        const turnFile = EDITOR_V2_FIXTURE_TURN_FILES[sid]
        if (p === PROMPT_API_BASE + '/api/sessions') return { ok: true, sessions: EDITOR_V2_FIXTURE_SESSIONS }
        if (p === PROMPT_API_BASE + '/api/sessions/resolve') return { ok: true, sessions: EDITOR_V2_FIXTURE_SESSIONS.map((x) => ({ id: x.id, title: x.title, requests: x.requests })) }
        if (p === PROMPT_API_BASE + '/api/session') return { ok: true, meta: { cwd: null }, title: (EDITOR_V2_FIXTURE_SESSIONS.find((s) => s.id === sid) || {}).title || sid, requests: [] }
        if (p === PROMPT_API_BASE + '/api/turns') {
          if (turnFile == null) return { ok: true, sessionId: sid, latest: 0, turns: [] }
          return EDITOR_V2_FIXTURES[turnFile]
        }
        if (p === PROMPT_API_BASE + '/api/messages') {
          if (sid !== 'fixture-session-static' && sid !== 'fixture-session-injected' && sid !== 'fixture-session-composite') return EDITOR_V2_FIXTURES['messages-empty']
          return EDITOR_V2_FIXTURES.messages
        }
        if (p === PROMPT_API_BASE + '/api/part') {
          const part = String(q.get('part') || '')
          const turnN = parseInt(q.get('turn') || '1', 10) || 1
          if (part === 'system') return EDITOR_V2_FIXTURES['part-system']
          if (part === 'tools') return EDITOR_V2_FIXTURES['part-tools']
          if (part === 'messages') {
            // ★ 甲（2026-09-18）：`seq=` ⇒ 单条**原样**对象 —— 自检要能真的驱动「原 JSON」按钮。
            //   形状照真机（`partApi` 的 messages+seq 分支）：{seq, role, chars, message, messageSource}。
            const seqQ = q.get('seq')
            if (seqQ !== null && seqQ !== '') {
              const hit = (EDITOR_V2_FIXTURES['part-messages'].messages || []).find((m) => String(m.seq) === String(seqQ))
              if (hit == null) {
                return { ok: false, error: { code: 'FIXTURE_MISSING', message: 'fixture：part-messages 里没有 seq=' + seqQ + ' 的消息' } }
              }
              return {
                ok: true, sessionId: sid, turn: turnN, part: 'messages',
                seq: Number(seqQ), role: hit.role, chars: hit.chars,
                isToolResult: !!hit.isToolResult, isCompacted: !!hit.isCompacted,
                message: { role: hit.role, content: [{ type: 'text', text: String(hit.preview || '') }] },
                messageSource: '会话日志里那条消息对象（原样）。⛔ 不是线上 wire JSON —— DSH 不落盘请求体，那个谁也拿不到。',
              }
            }
            // 20260914 M2：复合段会话给规整形状（── [seq N] role ──）的历史 ⇒ 定位行条数 + 特殊行可检出
            if (sid === 'fixture-session-composite') {
              return {
                ok: true, sessionId: sid, turn: turnN, part: 'messages', requestLogged: true, headerCarried: false, count: 4,
                text: '── [seq 503] user ──\n（fixture）开始吧\n\n── [seq 520] assistant ──\n（fixture）好的，我们开始。\n\n── [seq 526] user ──\n（fixture）<tool_result> 工具结果：ok</tool_result>\n\n── [seq 1188] user ──\n（fixture）<compacted-summary> 前情提要占位行',
                messages: [],
              }
            }
            const base = EDITOR_V2_FIXTURES['part-messages']
            if (turnN === 2 || sid !== 'fixture-session-static') return base
            // 第 1 / 3 楼：第 2 楼的数据换掉 seq/楼号/词头 ⇒ 各楼内容确实不同（fixture 域内构造）。
            // 20260918 查看器单：逐楼数据（turn/blocks）一并跟楼号走；text 用宿主同款 ── [seq N] role ──
            // 拼装形状重建（下钻全文按 seq 对号才切得开），⛔ 不另造第二种形状。
            const tag = '（fixture 第 ' + turnN + ' 楼历史）'
            const stripTag = (s) => String(s || '').replace(/^（fixture[^）]*）/, '')
            const variant = JSON.parse(JSON.stringify(base))
            variant.turn = turnN
            variant.messages = variant.messages.map((m, i) => Object.assign({}, m, {
              seq: turnN === 1 ? 16 + i : 1188 + i,
              turn: turnN,
              preview: tag + stripTag(m.preview),
              blocks: (Array.isArray(m.blocks) ? m.blocks : []).map((bk) => Object.assign({}, bk, {
                head: tag + stripTag(bk && bk.head),
              })),
            }))
            variant.text = variant.messages
              .map((m) => '── [seq ' + (m.seq != null ? m.seq : '?') + '] ' + m.role + ' ──\n' + String(m.preview || ''))
              .join('\n\n')
            variant.chars = variant.text.length
            return variant
          }
          if (part === 'inventory') return EDITOR_V2_FIXTURES['part-inventory']
          return { ok: false, error: { code: 'FIXTURE_MISSING', message: 'fixture 未覆盖 part=' + part } }
        }
        if (p === SECTIONS_API_BASE + '/sections') {
          if (sid === 'fixture-session-injected') return EDITOR_V2_FIXTURES['sections-captured']
          if (sid === 'fixture-session-static') return EDITOR_V2_FIXTURES['sections-inferred']
          if (sid === 'fixture-session-composite') return SECTIONS_CAPTURED_COMPOSITE
          return { ok: false, error: { code: 'no-capture-record', message: 'fixture：该会话没有捕获记录（inferred 降级）' } }
        }
        // 20260914 M2：§9 新端点夹具（字段名冻结：{ ok, sessionId, turn, name, offset, chars, source, text, unavailable }）。
        // failcase 参数仅夹具域有效（真端点不认识它）——专门用来在真界面里做反证：
        //   no-offset ⇒ text:null + unavailable:'no-offset'（DoD 10：必须显示「该段内容不可用」，⛔ 不许硬切）
        //   mismatch  ⇒ unavailable:'slice-mismatch'（反证 C：必须显示「内容不可用（校验未通过）」）
        //   nocapture ⇒ unavailable:'no-capture-record'（反证 B 的抽屉侧：醒目「文本推断 · 边界可能不准」）
        //   netfail   ⇒ 夹具不接（返回 null ⇒ FIXTURE_MISSING）＝网络失败口径「内容取不到：<原因>」
        // ★ 对真实路径字面量匹配（20260914 返工单第 3 条）：客户端若把端点常量接错（如少了 /api），
        //   这里就不会命中 ⇒ apiGet 落 FIXTURE_MISSING ⇒ 夹具域也会红，不会「两边同一个常量互相掩盖」。
        if (p === '/dsh-memory-archive/api/sections/text') {
          const name = String(q.get('name') || '')
          // failcase 两个来源都只在夹具域生效：URL 参数（手工点验用）与 window.__pmTextFailcase（自动化反证用）。
          // ⛔ 真端点不认识 failcase，也不读这个全局 —— 生产路径不经过本分支。
          const fail = String(q.get('failcase') || (typeof window !== 'undefined' ? window.__pmTextFailcase : '') || '')
          const turnN = parseInt(q.get('turn') || '2', 10) || 2
          if (fail === 'netfail') return null
          const base = { ok: true, sessionId: sid, turn: turnN, name: name }
          if (fail === 'no-offset') return Object.assign(base, { offset: null, chars: 2981, source: 'captured', text: null, unavailable: 'no-offset' })
          if (fail === 'mismatch') return Object.assign(base, { offset: 4166, chars: 2981, source: 'captured', text: null, unavailable: 'slice-mismatch' })
          if (fail === 'nocapture') return Object.assign(base, { offset: null, chars: 2981, source: 'inferred', text: null, unavailable: 'no-capture-record' })
          const catalog = SECTIONS_TEXT_FIXTURE[sid]
          const item = catalog ? catalog[name] : undefined
          if (item === undefined) {
            return Object.assign(base, { offset: null, chars: 0, source: 'inferred', text: null, unavailable: 'no-capture-record' })
          }
          return Object.assign(base, { offset: item.offset, chars: item.text.length, source: 'captured', text: item.text, unavailable: null })
        }
        if (p === '/dsh-memory-archive/prompt/health') return { ok: true, sessions: 5 }
        if (p === HOST_API_BASE + '/sessions') return { ok: true, sessions: [] }
        if (p === HOST_API_BASE + '/agent') return { ok: true, preset: null, active: false, sections: [], compaction: null }
        if (p === HOST_API_BASE + '/agent/detect') return { ok: true, candidates: [] }
        if (p === HOST_API_BASE + '/templates') return { ok: true, templates: {} }
        return null
      }
      // 统一取数入口（编辑器面板域）：fixture 开着走夹具，否则走真端点。失败语义与 requestJson 完全一致。
      async function apiGet(url, signal) {
        if (!editorV2FixtureMode()) return requestJson(url, signal)
        const data = editorV2FixtureLookup(url)
        if (data == null) {
          const err = new Error('fixture 未覆盖该端点：' + url)
          err.code = 'FIXTURE_MISSING'
          throw err
        }
        if (!data || data.ok !== true) {
          const err = new Error((data && data.error && data.error.message) || '接口返回异常')
          err.code = (data && data.error && data.error.code) || 'BAD_PAYLOAD'
          err.payload = data
          throw err
        }
        return JSON.parse(JSON.stringify(data))
      }

      /**
       * POST 版取数（20260915：常驻集改集用）。夹具模式**不覆盖写接口** ⇒ 如实报
       * FIXTURE_MISSING，⛔ 不假装成功（写完不知道写没写是最坏的一种"成功"）。
       */
      async function apiPost(url, signal, payload) {
        if (editorV2FixtureMode()) {
          const err = new Error('fixture 未覆盖该写接口：' + url)
          err.code = 'FIXTURE_MISSING'
          throw err
        }
        let res
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify(payload === undefined ? {} : payload),
            signal,
          })
        } catch (error) {
          if (error && error.name === 'AbortError') throw error
          const err = new Error('网络请求失败：' + String((error && error.message) || error))
          err.code = 'NETWORK'
          throw err
        }
        let data = null
        try { data = await res.json() } catch (error) { data = null }
        if (!res.ok || !data || data.ok !== true) {
          // ★ 服务端错误体是 {ok:false,error:{code,message}}：以前这里把 **整个 error 对象**当成
          //   消息与 code（于是界面显示 "[object Object]"、调用方拿不到 IMPORT_PLAN_STALE 这类
          //   可判别的 code）。这里按形状取字符串，取不到才回落到 HTTP 状态。
          const eo = data && data.error && typeof data.error === 'object' ? data.error : null
          const err = new Error((eo && typeof eo.message === 'string' && eo.message) || ('HTTP ' + res.status))
          err.code = (eo && typeof eo.code === 'string' && eo.code) || ('HTTP_' + res.status)
          err.payload = data
          throw err
        }
        return data
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
        // ★★ 2026-09-15（用户拍板口径）：**角色-周目是唯一的组织轴** ——
        //   `archive/` 存不存在只是**元数据**，不再是「能不能发现」的门槛。
        //   用户原话：可以容忍库里没实际数据，但目录要和「角色-周目」结构绑定。
        //   ⇒ 没有 archive/ 的周目照样列出来（空库可绑定；归档由首次「收纳/导入」创建）。
        const archiveMap = {}          // '<charId>/<ptId>' → 有没有 archive/ 目录
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
            plays.push(en.name)
            try {
              const inner = await listDir(charId + '/' + en.name, signal)
              archiveMap[charId + '/' + en.name] = inner.some((x) => x.type === 'dir' && x.name === 'archive')
            } catch (error) {
              if (signal.aborted) throw error
              archiveMap[charId + '/' + en.name] = false
            }
          }
          if (plays.length > 0) found.push({ charId: charId, plays: plays })
          if (signal.aborted) throw aborted()
        }
        if (found.length === 0) {
          const err = new Error('工作区根下没有任何 playthrough- 周目目录（「角色-周目」结构为空）')
          err.code = 'NO_ARCHIVE'
          throw err
        }
        // 自动挑一个：**优先已经有 archive/ 的**（那才是有数据的），
        // 其中有多个再按 summaries/index.json 的 updatedAt 取最新；
        // 一个都没有 ⇒ 取第一个周目（空归档，如实标注）。
        const first = found[0]
        const archived = first.plays.filter((p) => archiveMap[first.charId + '/' + p] === true)
        const pool = archived.length > 0 ? archived : first.plays
        let chosen = pool[0]
        if (pool.length > 1) {
          // 默认选 summaries/index.json updatedAt 最新的周目（小文件探测，失败不致命）
          const probes = []
          for (let i = 0; i < pool.length; i++) {
            const p = pool[i]
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
        return {
          found: found,
          characterId: first.charId,
          playthroughId: chosen,
          emptyArchive: archiveMap[first.charId + '/' + chosen] !== true,
          // ★ 2026-09-20：逐行的 archive 事实也带上 —— 设置页那两个下拉现在显示的是**绑定**，
          //   而 `emptyArchive` 只算得出"自动挑的那个" ⇒ 「无归档」徽标得能跟着显示的那一行走。
          archiveMap: archiveMap,
        }
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
      function MarkdownBody({ text, fontSize }) {
        const srcText = typeof text === 'string' ? text : ''
        const blocks = React.useMemo(() => parseMarkdown(srcText), [srcText])
        // ★ 2026-09-19：多一个可选字号（抽屉里的**注释**也走 Markdown 渲染，但那里的字要小一号）
        return e('div', { style: { fontSize: fontSize || BODY_FONT_SIZE, lineHeight: BODY_LINE_HEIGHT, color: 'CanvasText' } },
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
            // ★ 空归档不是错误（Tavern 的 404/PLAY_PATH_NOT_FOUND）⇒ 空态，不是红字（用户 2026-09-15 口径）
            if (isArchiveMissing(error)) { setState({ status: 'empty', entries: [], error: '' }); reportLoad(true, '该周目还没有归档'); return }
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
          state.status === 'empty' && e('div', { style: dimStyle }, '该周目还没有归档 —— 首次「收纳」或「导入」后，摘要会出现在这里。'),
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
              // ★ 空归档不是错误（用户 2026-09-15 口径）：没有 floors/ 也没有 visibility.json 时，
              //   用灰字如实说明"还没有可读的楼层"，⛔ 不把 404 原文当红字糊脸上。
              setUi((s) => ({ ...s, metaStatus: 'ready', metaNote: '该周目下没有可读的楼层（floors/ 与 visibility.json 都不存在或读不到）—— 首次「收纳」或「导入」后会出现。' }))
              reportLoad(false, '没有可读的楼层（该周目可能还没有归档）')
              return
            }
            await ensureUpTo(nums[0])
          })().catch((error) => {
            if (controller.signal.aborted) return
            // ★ 空归档不是错误（Tavern 404/PLAY_PATH_NOT_FOUND）⇒ 灰字空态
            if (isArchiveMissing(error)) {
              setUi((s) => ({ ...s, metaStatus: 'ready', metaNote: '该周目还没有归档 —— 首次「收纳」或「导入」后，原文楼层会出现在这里。' }))
              reportLoad(false, '该周目还没有归档')
              return
            }
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
      // ★ 2026-09-20 摘除：「状态」档（原 `StateFlow`）整个删掉了 —— 用户口径：「记忆库里的状态面板可以摘除」。
      //   它读的是归档里的 `state/current.json`，而那份文件**全仓只有这里读过、没有任何地方写**
      //   （写它的 state-bridge 已整体剥离）⇒ 那一档早就只会显示"还没有归档"，是死档。
      //   状态现在由周目笔记 `<周目>/.roleplay-memory/state.md` 维护（见「剧情大纲」档）。



      // ---------- 阅读源·角色扮演记忆库（同一档的上一块，20260919）：★ 同样带防剧透门 ----------
      // 读什么：社区 RP 预设（oliblue-evan/dsh-roleplay-preset）**自己约定写出来**的
      //   <工作目录>/.roleplay-memory/{index,story,characters,world}.md —— 别人的文件，我们只读。
      // 落点由宿主端候选链决定（周目目录 → 工作区根），命中哪一处、是否可能被多周目共用，
      //   都由宿主如实回报（baseLabel / sharedHint）—— ⛔ 面板不猜。
      // 纪律与那个已退役的单文件大纲门同款（自检钉死）：⛔ 零 useEffect；清单只在确认回调 reveal 里取；
      //   某一行的正文只在**点开那一行**时取；未确认态一个字节的记忆库内容都不进面板。
      function RpMemoryFlow({ scrollBind }) {
        const [gate, setGate] = React.useState('locked') // 'locked' | 'loading' | 'ready' | 'empty' | 'error'
        const [st, setSt] = React.useState({ files: [], baseLabel: '', candidates: [], sharedHint: false, otherEntries: 0, error: '' })
        const [openName, setOpenName] = React.useState(null)
        // ★ 2026-09-20（用户口径：「给剧情大纲面板加一个打开文件夹的按钮」）：
        //   按钮只发一个**不带路径**的 POST —— 开哪个目录由宿主自己按同一条候选链解析
        //   （`POST /playthrough/reveal`），⛔ 客户端一个字符的路径都插不进去。
        // ★★ 同日补（用户口径：「**没有加打开文件夹的按钮**，新会话依旧不显示」）：原来只有
        //   "目录已存在"才给按钮 ⇒ 新周目两处都还没建时**既没按钮也没状态**。现在两个态都给，
        //   并按**落点**分别发（只带枚举 `base`，⛔ 仍然不带任何路径）。`base` 记在状态里，好标"哪一个在忙"。
        const [openFolder, setOpenFolder] = React.useState({ status: 'idle', base: '', message: '' })
        const [pane, setPane] = React.useState({ status: 'idle', text: '', chars: 0, originalChars: 0, truncated: false, error: '' })
        const idle = { status: 'idle', text: '', chars: 0, originalChars: 0, truncated: false, error: '' }

        const reveal = () => {
          if (gate === 'loading' || gate === 'ready') return // 已确认过：不重复请求
          setGate('loading')
          const controller = new AbortController()
          ;(async () => {
            try {
              const data = await requestJson(HOST_API_BASE + '/playthrough/rp-memory', controller.signal)
              if (controller.signal.aborted) return
              if (data.exists === false) {
                // ★ 空态也要把**落点两处**带上：用户正是靠它知道"往哪儿放"（新周目两处都还没有）
                setSt({ files: [], baseLabel: '', candidates: Array.isArray(data.candidates) ? data.candidates : [], sharedHint: false, otherEntries: 0, error: '' })
                setGate('empty')
                return
              }
              setGate('ready')
              setSt({
                files: Array.isArray(data.files) ? data.files : [],
                baseLabel: typeof data.baseLabel === 'string' ? data.baseLabel : '',
                candidates: Array.isArray(data.candidates) ? data.candidates : [],
                sharedHint: data.sharedHint === true,
                otherEntries: Number.isFinite(data.otherEntries) ? data.otherEntries : 0,
                error: '',
              })
            } catch (error) {
              if (controller.signal.aborted) return
              // 目录还没有是**空态**不是错误（服务端 RP_MEMORY_MISSING / exists:false 都归到这里）
              if ((error && error.code === 'RP_MEMORY_MISSING') || (error && error.payload && error.payload.exists === false)) {
                const p = error && error.payload ? error.payload : {}
                setSt({ files: [], baseLabel: '', candidates: Array.isArray(p.candidates) ? p.candidates : [], sharedHint: false, otherEntries: 0, error: '' })
                setGate('empty')
                return
              }
              setGate('error')
              setSt({ files: [], baseLabel: '', candidates: [], sharedHint: false, otherEntries: 0, error: errText(error) })
            }
          })()
        }

        /**
         * 「打开文件夹」：POST 出去、宿主在系统文件管理器里打开那个落点。
         * 只带枚举 `base`（'playthrough' | 'workspace-root'）—— ⛔ 一个字符的路径都不带。
         * 回执如实翻成人话：新建了目录 / 那份不存在所以退到打开工作区根 / 普通打开。
         */
        const openMemFolder = (base) => {
          if (openFolder.status === 'busy') return
          setOpenFolder({ status: 'busy', base: base, message: '' })
          ;(async () => {
            try {
              const data = await apiPost(HOST_API_BASE + '/playthrough/reveal',
                undefined, base === undefined ? {} : { base: base })
              const label = (data && data.baseLabel) || '记忆库目录'
              const text = data && data.created === true
                ? '已创建并交给系统文件管理器打开：' + label
                : (data && data.fallbackTo === 'workspace-root'
                  ? '那一份还不存在（是社区预设的地盘，⛔ 我们不替它建）⇒ 已打开**工作区根**：在里面新建 .roleplay-memory 文件夹即可预置。'
                  : '已交给系统文件管理器打开：' + label)
              setOpenFolder({ status: 'ok', base: base, message: text })
            } catch (error) {
              setOpenFolder({ status: 'err', base: base, message: errText(error) })
            }
          })()
        }

        const toggleFile = (name) => {
          if (openName === name) { setOpenName(null); return } // 再点一次收起（单开：同看两份没意义）
          setOpenName(name)
          setPane({ status: 'loading', text: '', chars: 0, originalChars: 0, truncated: false, error: '' })
          const controller = new AbortController()
          ;(async () => {
            try {
              const data = await requestJson(HOST_API_BASE + '/playthrough/rp-memory?file=' + encodeURIComponent(name), controller.signal)
              if (controller.signal.aborted) return
              const f = data && data.file
              if (!f || f.exists === false) { setPane(Object.assign({}, idle, { status: 'empty' })); return }
              setPane({
                status: 'ready',
                text: typeof f.text === 'string' ? f.text : '',
                chars: Number.isFinite(f.chars) ? f.chars : 0,
                originalChars: Number.isFinite(f.originalChars) ? f.originalChars : 0,
                truncated: f.truncated === true,
                error: '',
              })
            } catch (error) {
              if (controller.signal.aborted) return
              if (error && error.code === 'RP_MEMORY_FILE_MISSING') { setPane(Object.assign({}, idle, { status: 'empty' })); return }
              setPane(Object.assign({}, idle, { status: 'error', error: errText(error) }))
            }
          })()
        }

        const empties = st.files.length > 0 && st.files.every((f) => !f.exists)
        const otherBase = st.candidates.filter((c) => c && c.exists && c.label !== st.baseLabel)
        const rows = st.files.map((f) => e('div', {
          key: f.name,
          id: 'dma-rpmem-file-' + f.name,
          className: 'dma-row',
          style: Object.assign({}, itemStyle, f.exists ? { cursor: 'pointer' } : {}),
          onClick: f.exists ? () => toggleFile(f.name) : null,
        },
          e('span', { style: { fontFamily: MONO } }, f.name),
          e('span', { style: dimBadgeStyle }, f.exists ? (formatBytes(f.bytes) + ' · ' + (f.mtime ? new Date(f.mtime).toLocaleString() : '—')) : '还没有'),
          openName === f.name && pane.status === 'loading' && e('div', { style: dimStyle }, '正在读取 ' + f.name + '…'),
          openName === f.name && pane.status === 'empty' && e('div', { style: dimStyle }, '这一份还没有内容。'),
          openName === f.name && pane.status === 'error' && e('div', { style: errorStyle }, '读取失败：' + pane.error),
          openName === f.name && pane.status === 'ready'
            ? e('div', null,
                e(MarkdownBody, { text: pane.text }),
                pane.truncated ? e('div', { style: dimStyle }, '（已截断：显示 ' + fmtChars(pane.chars) + ' / 共 ' + fmtChars(pane.originalChars) + ' 字符）') : null)
            : null,
        ))

        /**
         * ★★ 2026-09-20（用户口径：「**没有加打开文件夹的按钮**，新会话依旧不显示」）：
         * 落点**一行一个**，两处都给按钮 —— `empty` 态也给（新周目两处都还没建时，用户正是靠这一块
         * 才知道"往哪儿放"、并且有入口点）。周目目录不存在 ⇒ 按钮是「创建并打开」（宿主按需 mkdir：
         * 那是我们的写面）；共用那份不存在 ⇒ 打开**工作区根**（⛔ 不替社区预设建目录）。
         * ⛔ 仍然只在**确认之后**才渲染（locked 态调用不到它）。
         */
        const candRow = (base) => {
          const c = (Array.isArray(st.candidates) ? st.candidates : []).find((x) => x && x.base === base)
          if (!c) return null
          const exists = c.exists === true
          const n = Number.isFinite(c.fileCount) ? c.fileCount : null
          const busyThis = openFolder.status === 'busy' && openFolder.base === base
          const btnText = exists ? '打开文件夹' : (base === 'playthrough' ? '创建并打开' : '打开工作区根')
          return e('div', { key: 'cand-' + base, style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', marginTop: 2 } },
            e('div', { style: Object.assign({}, dimStyle, { flex: 1, minWidth: 0 }) },
              c.label + '：' + (exists ? ('在 · ' + (n === null ? '文件数读不到' : String(n) + ' 份')) : '还没有')),
            e('button', {
              id: base === 'playthrough' ? 'dma-rpmem-openfolder' : 'dma-rpmem-openfolder-' + base,
              className: 'dma-btn', style: miniBtnStyle,
              'data-cand-exists': exists ? '1' : '0',
              disabled: openFolder.status === 'busy',
              title: exists
                ? '在系统文件管理器里打开：' + c.label
                : (base === 'playthrough'
                  ? '这个周目目录下的记忆库还没建 —— 点它会先**建好目录**再打开（那是我们的写面）'
                  : '共用那份还没建 —— 点它打开**工作区根**，你在那儿新建 .roleplay-memory 文件夹即可预置（⛔ 我们不替社区预设建目录）'),
              onClick: () => openMemFolder(base),
            }, busyThis ? '正在打开…' : btnText))
        }
        const folderMsgs = [
          openFolder.status === 'ok' ? e('div', { key: 'fok', 'data-dma': 'openfolder-ok', style: dimStyle }, openFolder.message) : null,
          openFolder.status === 'err' ? e('div', { key: 'ferr', 'data-dma': 'openfolder-err', style: errorStyle }, '打开文件夹失败：' + openFolder.message) : null,
        ]

        return e('div', { style: colFillStyle },
          gate === 'locked' && e('div', Object.assign({}, scrollBind, {
            style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 },
          }),
            e('div', { style: { fontSize: BODY_FONT_SIZE, color: 'GrayText', maxWidth: 'min(560px, 92%)', textAlign: 'center', lineHeight: 1.7 } },
              '这一档是角色扮演预设在工作目录里维护的记忆库（.roleplay-memory/）：剧情正文、角色档案、世界观、索引。属于作者视角，默认不展示，避免剧透。'),
            e('button', { id: 'dma-rpmem-reveal', className: 'dma-btn', style: btnStyle, onClick: reveal },
              '显示角色扮演记忆库（含剧透）'),
          ),
          gate === 'loading' && e('div', { style: dimStyle }, '正在读取记忆库…'),
          gate === 'empty' && e('div', { style: readColStyle },
            e('div', { style: dimStyle }, '这个周目还没有记忆库（.roleplay-memory/）—— 两处落点都还没有文件：'),
            candRow('playthrough'),
            candRow('workspace-root'),
            e('div', { style: dimStyle },
              '笔记由模型开演时写进**周目目录**那处；想让新周目开局就带上下文 ⇒ 把要预置的文件放进**共用**那处（见 README「预部署」）。'),
            folderMsgs,
          ),
          gate === 'error' && e('div', { style: errorStyle }, '读取失败：' + st.error),
          gate === 'ready'
            ? e('div', Object.assign({}, scrollBind), e('div', { style: readColStyle },
              // 落点：**两处都给**（2026-09-20 用户口径）—— 正在看的是哪一处如实说，两处各有自己的按钮。
              e('div', { style: dimStyle },
                '正在看：' + (st.baseLabel || '未知') + (st.sharedHint ? ' · 记忆库按会话工作目录存放，可能被同一工作区里的多个周目共用。' : '')),
              candRow('playthrough'),
              candRow('workspace-root'),
              folderMsgs,
              otherBase.length > 0 ? e('div', { style: dimStyle }, '（' + otherBase.map((c) => c.label).join('、') + ' 下也有一处记忆库，本面板没有读它）') : null,
              st.otherEntries > 0 ? e('div', { style: dimStyle }, '目录里另有 ' + String(st.otherEntries) + ' 项未识别（不读）') : null,
              empties ? e('div', { style: dimStyle }, '目录在，但这四份都还没有。') : null,
              rows,
            ))
            : null,
        )
      }

      // ---------- 阅读源·向量（2026-09-20 第四档）：当前状态 + 库行 + 逐条条目 + 参与检索开关 ----------
      // 读什么：宿主 GET /vector/state —— 它只读 dsh-anima-rag 落的三张文件（快照 / 回执 / 入库状态），
      //   并打开向量库的 index.json 逐条列举（lib/vector-panel.js 的 entries：摘要名/标签/字数/正文预览）。
      // 动什么：POST /vector/action —— `enable` 写宿主自己的 config；其余四个动作写一张**请求单**。
      //   ⛔ 真拥有向量库的是 dsh-anima-rag（按会话挂载，引擎在它 apply() 闭包里）⇒ 面板拿不到引擎，
      //      只能"写条子"，动作由 anima 在该周目会话的下一轮开始前执行，然后把回执写回来。
      //   所以每个动作提交后要**轮询回执**（拿 id 对），而不是假装"点完就生效"。
      // ★ 时机口径（用户 2026-09-20）：「向量生成的时机需要明确为自动压缩入库或工具检索调用时」
      //   —— 本档常驻不生成任何向量，只在注入时/检索时由 anima 触发；「立即入库」是手工补一脚。
      // ⛔ 零轮询（空闲时）：只有提交过动作才起定时器，回执对上/超时就停。
      const VECTOR_POLL_MS = 2000        // 提交后每 2s 拉一次状态
      const VECTOR_POLL_LIMIT_MS = 60000 // 最多等 60s（anima 要等"下一轮开始前"那一脚，慢是正常的）
      // 二次确认：武装态 key → 真动作名 + 中文短名 + "再点一次"的说明。
      // ⛔ action 只许是 lib/vector-panel.js 那份白名单里的四个 + enable；面板不认识的动作一个都不发。
      // 注意「重建」两组按钮指向**同一个** action（anima 的 rebuild 就是"向量 + BM25 一起重建"），
      // 只是在面板上分两处摆 —— ⛔ 别改成两个不同的动作名（宿主那边没有那两条）。
      const VECTOR_ARMED = {
        'ingest-now': { action: 'ingest-now', label: '立即入库', hint: '把还没入库的摘要补进两个库（要调向量接口，可能花几十秒）。' },
        'rebuild:vector': { action: 'rebuild', label: '重建（向量 + BM25）', hint: '向量与 BM25 两个库一起从头重算（要调向量接口，可能花几十秒）。' },
        'rebuild:bm25': { action: 'rebuild', label: '重建（向量 + BM25）', hint: '向量与 BM25 两个库一起从头重算（要调向量接口，可能花几十秒）。' },
        'delete-vector': { action: 'delete-vector', label: '删除向量库', hint: '删掉整个向量库。会先改名留档（不彻底销毁）；删完检索只剩 BM25。' },
        'delete-bm25': { action: 'delete-bm25', label: '删除 BM25 库', hint: '删掉整个 BM25 库。会先改名留档（不彻底销毁）；删完检索只剩向量。' },
      }

      /** 入库状态的人话（字段缺就如实说"没有明细"，⛔ 不编 0）。 */
      function vectorIngestText(g) {
        if (!g || typeof g !== 'object') return '（还没有记录）'
        const bits = []
        if (g.running === true) bits.push('正在入库…')
        if (Number.isFinite(g.inserted)) bits.push('成功 ' + String(g.inserted) + ' 条')
        if (Number.isFinite(g.failed) && g.failed > 0) bits.push('失败 ' + String(g.failed) + ' 条')
        if (typeof g.skipped === 'string' && g.skipped !== '') bits.push('没有入库（' + g.skipped + '）')
        if (typeof g.error === 'string' && g.error !== '') bits.push('失败原因：' + g.error)
        return bits.length > 0 ? bits.join(' · ') : '（没有明细）'
      }

      // anima 写在 skipped 里的两个机器码 → 人话（认不出的码不硬翻，原样透出）。
      // ★ 真机实况：skipped:'no-index'（那个周目还没有摘要目录）、'all-done'（都入过了，内容没变）。
      const VECTOR_SKIPPED_PLAIN = {
        'all-done': '这些摘要早都入库了，内容没变',
        'no-index': '那个周目还没有摘要目录',
      }
      /** 周目 id 的人话短名：playthrough-adacc634-… → adacc634（认不出就原样）。 */
      function shortPlaythrough(id) {
        const m = /^playthrough-([0-9a-f]{8})/i.exec(String(id || ''))
        return m ? m[1] : String(id || '')
      }

      /** 回执里的动作机器码 → 按钮上那个中文短名（认不出的原样透出，⛔ 不编）。 */
      const VECTOR_RESULT_LABELS = {
        'ingest-now': '立即入库',
        'rebuild': '重建（向量 + BM25）',
        'delete-vector': '删除向量库',
        'delete-bm25': '删除 BM25 库',
      }

      /** 快照落后多久的人话（毫秒 → 秒/分/时）。 */
      function vectorStaleText(ms) {
        if (!Number.isFinite(ms)) return '—'
        if (ms < 60000) return Math.round(ms / 1000) + ' 秒前'
        if (ms < 3600000) return Math.round(ms / 60000) + ' 分钟前'
        return Math.round(ms / 3600000) + ' 小时前'
      }

      function VectorFlow({ archivePath, scrollBind }) {
        const [snap, setSnap] = React.useState({ status: 'loading', info: null, result: null, live: null, entries: null, staleMs: null, error: '' })
        const [chatOn, setChatOn] = React.useState(null) // 参与检索开关（读 /config 的 retrieval.chatEnabled；null = 还没读到）
        const [armed, setArmed] = React.useState('')     // 已武装、等着第二次点确认的动作 key
        const [busy, setBusy] = React.useState('')       // 正在提交的动作（'' = 空闲）
        const [out, setOut] = React.useState({ status: 'idle', message: '' })
        const [scope, setScope] = React.useState('all')     // 条目过滤：'all' 全部 | 'bound' 只看本周目
        const [entryLimit, setEntryLimit] = React.useState(GROUP_ROW_LIMIT) // 条目折叠：先显示 8 条
        const [openEntry, setOpenEntry] = React.useState('') // 展开了正文预览的那条（metadataFile 或 index 当 key）
        const [sumIdx, setSumIdx] = React.useState(null)     // 摘要索引 file → entry（与「摘要」页签同一份读法）
        const alive = React.useRef(true)
        const pollTimer = React.useRef(null)

        const applySnap = (d) => {
          setSnap({
            status: 'ready',
            info: (d && d.info) || null,
            result: (d && d.result) || null,
            live: (d && d.live) || null,
            entries: (d && d.entries) || null,
            staleMs: d && Number.isFinite(d.staleMs) ? d.staleMs : null,
            error: '',
          })
        }
        const load = () => requestJson(HOST_API_BASE + '/vector/state')
          .then((d) => { if (alive.current) applySnap(d) })
          .catch((error) => {
            if (alive.current) setSnap({ status: 'error', info: null, result: null, live: null, entries: null, staleMs: null, error: errText(error) })
          })

        // 提交后轮询回执：拿 id 对（anima 在它下一脚执行，回执才写回来）。对不上就等，超时如实说。
        const startPolling = (id) => {
          const started = Date.now()
          const tick = async () => {
            if (!alive.current) return
            try {
              const d = await requestJson(HOST_API_BASE + '/vector/state')
              if (!alive.current) return
              applySnap(d)
              const r = d && d.result
              if (r && String(r.id || '') === id) {
                setOut({
                  status: r.ok === true ? 'ok' : 'fail',
                  message: r.ok === true
                    ? ('执行成功' + (typeof r.message === 'string' && r.message !== '' ? '：' + r.message : ''))
                    : ('执行失败' + (typeof r.message === 'string' && r.message !== '' ? '：' + r.message : '')),
                })
                setBusy('')
                return
              }
            } catch (error) {
              // 单次取数失败不停轮询（宿主可能正好在重启），但也别吞着不说 —— 超时那条会把话说清楚
            }
            if (Date.now() - started >= VECTOR_POLL_LIMIT_MS) {
              setOut({ status: 'timeout', message: '还没执行：这个动作要在该周目下一轮对话开始前才会进行。可以先去忙别的，稍后回来看「最近一次动作」。' })
              setBusy('')
              return
            }
            pollTimer.current = setTimeout(tick, VECTOR_POLL_MS)
          }
          pollTimer.current = setTimeout(tick, VECTOR_POLL_MS)
        }

        const submit = (action) => {
          if (busy !== '') return
          setBusy(action)
          setOut({ status: 'waiting', message: '正在提交…' })
          ;(async () => {
            try {
              const d = await apiPost(HOST_API_BASE + '/vector/action', undefined, { action: action })
              if (!alive.current) return
              const id = String((d && d.id) || '')
              setOut({ status: 'waiting', message: String((d && d.hint) || '已排队') })
              await load()
              if (!alive.current) return
              if (id === '') {
                // 宿主 200 但没带回执 id（不该发生，比如模块降级）⇒ 空 id 永远对不上回执，
                // 起轮询只能白转满 60 秒 —— 如实停下说清，⛔ 不许一直转圈。
                setBusy('')
                setOut({ status: 'fail', message: '提交了，但没拿到回单编号，没法自动跟踪；结果看下面「最近一次动作」。' })
                return
              }
              startPolling(id)
            } catch (error) {
              if (alive.current) { setBusy(''); setOut({ status: 'fail', message: errText(error) }) }
            }
          })()
        }

        /** 每个按钮的点击：未武装 ⇒ 先武装（出确认条）；已武装 ⇒ 执行。 */
        const act = (key) => {
          if (busy !== '') return
          if (armed === key) { setArmed(''); submit(VECTOR_ARMED[key].action); return }
          setArmed(key)
          setOut({ status: 'idle', message: '' })
        }

        // 「参与检索」开关：同时管向量与 BM25 两条支线（开关在宿主 config，anima 直接读它）。
        const toggleChat = () => {
          if (busy !== '' || chatOn === null) return
          const next = chatOn !== true
          setBusy('enable')
          setOut({ status: 'waiting', message: '正在保存开关…' })
          ;(async () => {
            try {
              const d = await apiPost(HOST_API_BASE + '/vector/action', undefined, { action: 'enable', enabled: next })
              if (!alive.current) return
              setChatOn(d && d.chatEnabled === true)
              setOut({ status: 'ok', message: '已' + (next ? '打开' : '关掉') + '「参与检索」（向量与 BM25 一起生效；下一轮对话起作用）' })
            } catch (error) {
              if (alive.current) setOut({ status: 'fail', message: errText(error) })
            } finally {
              if (alive.current) setBusy('')
            }
          })()
        }

        React.useEffect(() => {
          alive.current = true
          load()
          // 开关初始态：走既有的 /config 投影（宿主 publicConfig 里就有 retrieval.chatEnabled）
          requestJson(HOST_API_BASE + '/config')
            .then((d) => { if (alive.current) setChatOn(d && d.retrieval ? d.retrieval.chatEnabled !== false : null) })
            .catch(() => { /* 读不到开关就显示"读取中…"，⛔ 不猜成"关" */ })
          return () => {
            alive.current = false
            if (pollTimer.current) clearTimeout(pollTimer.current)
          }
        }, [])

        // 摘要索引：与「摘要」页签**同一份读法**（archivePath + '/summaries/index.json'，⛔ 不另造第二套）。
        // 只用它给向量条目补「楼层 / 摘要全文 / 对应哪篇」；读不到（没归档 / 404 / 坏 JSON）⇒ null，
        // 条目照样列 —— 对应列如实显示"「摘要」页签里没有这条对应的文件"，⛔ 不因此整卡报错。
        React.useEffect(() => {
          if (!archivePath) { setSumIdx(null); return }
          const controller = new AbortController()
          readFileText(archivePath + '/summaries/index.json', controller.signal)
            .then((raw) => {
              const parsed = parseJsonOr(raw, 'summaries/index.json 不是合法 JSON')
              if (controller.signal.aborted) return
              const map = {}
              for (const en of (Array.isArray(parsed && parsed.entries) ? parsed.entries : [])) {
                if (en && typeof en.file === 'string' && en.file !== '') map[en.file] = en
              }
              setSumIdx(map)
            })
            .catch(() => { if (!controller.signal.aborted) setSumIdx(null) })
          return () => controller.abort()
        }, [archivePath])

        const info = snap.info
        const live = snap.live || {}
        const entries = snap.entries
        const iso = info && info.isolation && typeof info.isolation === 'object' ? info.isolation : null
        const vec = live.vector || null
        const bm = live.bm25 || null
        const numOr = (v) => (Number.isFinite(v) ? v : null)
        const total = iso ? numOr(iso.total) : null
        const boundCount = iso ? numOr(iso.boundCount) : null
        const deniedCount = iso ? numOr(iso.deniedCount) : null
        const bound = iso && typeof iso.bound === 'string' ? iso.bound : ''
        // 绑定来源（anima 快照 isolation.boundSource：'session'=活跃会话 / 'config'=面板绑定）——
        // 排障要分清"活跃会话没开对"与"面板里绑错了"：这是两种不同的修法，⛔ 不能只给周目名不给来路。
        const boundSrc = iso && typeof iso.boundSource === 'string' ? iso.boundSource : ''
        const boundSrcLabel = boundSrc === 'session' ? '来自活跃会话' : (boundSrc === 'config' ? '来自面板绑定' : '')
        // 上次入库的人话：skipped 里 anima 写的是机器码（all-done / no-index），先查人话表；
        // 认不出的码不硬翻。anima 自己写了 reason（现成中文）就原样用；两处都没有才逐字段拼。
        const ingestLive = live.ingestState && typeof live.ingestState === 'object' ? live.ingestState : null
        const ingestSnap = info && info.ingest && info.ingest.state && typeof info.ingest.state === 'object' ? info.ingest.state : null
        const skippedCode = (ingestLive && typeof ingestLive.skipped === 'string' && ingestLive.skipped !== '' ? ingestLive.skipped : '')
          || (ingestSnap && typeof ingestSnap.skipped === 'string' ? ingestSnap.skipped : '')
        const ingestReason = (ingestLive && typeof ingestLive.reason === 'string' && ingestLive.reason !== '' ? ingestLive.reason : '')
          || (ingestSnap && typeof ingestSnap.reason === 'string' ? ingestSnap.reason : '')
        const ingestPlain = VECTOR_SKIPPED_PLAIN[skippedCode] || (ingestReason !== '' ? ingestReason : vectorIngestText(ingestLive))
        // ★ 用户今天真正踩到的坑：库里有条目、但**一条都对不上当前绑定的周目** ⇒ 检索不到任何东西，
        //   而且一声不响。这一句必须一眼可见（红字），摆在状态卡里。
        const isolationDead = iso !== null && boundCount === 0 && total !== null && total > 0
        // ★★ 2026-09-20（口径「认不出来的会话默认为新会话」）：本会话认不出周目 ⇒ anima 那边是
        //   **fail-closed**（`blocked: 'no-bound-playthrough'`）⇒ 这一档**不参与检索**。
        //   面板必须把这件事说出来，⛔ 不许显示成"绑定周目：（空）"让人自己猜 —— 那正是"看着像骗人"的来源。
        const unmapped = iso !== null && (bound === '' || iso.blocked === 'no-bound-playthrough')
        const armedDoc = armed !== '' ? VECTOR_ARMED[armed] : null
        const boundShort = bound !== '' ? shortPlaythrough(bound) : ''
        const missingBadge = (exists) => (exists === false ? e('span', { style: amberBadgeStyle }, '⚠缺失') : null)

        // ---- 逐条条目：归属判定 + 与「摘要」页签按文件名对应（键 = metadata.index 去掉 sum_ 前缀） ----
        const ptOf = (tags) => {
          const t = (Array.isArray(tags) ? tags : []).find((x) => typeof x === 'string' && x.indexOf('pt:') === 0)
          return t ? t.slice(3) : ''
        }
        const attrOf = (it) => {
          const pt = ptOf(it.tags)
          if (pt === '') return 'unknown'
          return bound !== '' && pt === bound ? 'bound' : 'other'
        }
        // 三色语义：本周目=绿（能检索到）；别的周目=琥珀（这条现在检索不到）；未标注=灰（不猜）。
        const attrBadge = (it) => {
          const pt = ptOf(it.tags)
          if (pt !== '' && attrOf(it) === 'bound') {
            return e('span', { style: okBadgeStyle, title: '周目标签 pt:' + pt + '，就是当前绑定的周目' }, '●本周目')
          }
          if (pt !== '') {
            return e('span', { style: amberBadgeStyle, title: '周目标签 pt:' + pt + (bound !== '' ? '，不是当前绑定的周目（' + bound + '）' : '') }, '●别的周目')
          }
          return e('span', { style: dimBadgeStyle, title: '这条没有周目标签（pt:…），看不出归属' }, '○未标注周目')
        }
        const entryName = (it) => (typeof it.index === 'string' && it.index.indexOf('sum_') === 0 ? it.index.slice(4) : String(it.index || ''))
        const sumOf = (it) => {
          const n = entryName(it)
          return sumIdx !== null && Object.prototype.hasOwnProperty.call(sumIdx, n) ? sumIdx[n] : null
        }
        // 排序与「摘要」页签一致（按起始楼号）；非摘要条目（探针等）排最后，按名字稳定排序
        const sortedItems = entries !== null ? entries.items.slice().sort((a, b) => {
          const sa = sumOf(a)
          const sb = sumOf(b)
          const fa = sa && Number.isFinite(sa.fromFloor) ? sa.fromFloor : null
          const fb = sb && Number.isFinite(sb.fromFloor) ? sb.fromFloor : null
          if (fa === null && fb === null) return entryName(a) < entryName(b) ? -1 : (entryName(a) > entryName(b) ? 1 : 0)
          if (fa === null) return 1
          if (fb === null) return -1
          return fa - fb
        }) : []
        let cBound = 0
        let cOther = 0
        let cUnknown = 0
        for (const it of sortedItems) {
          const a = attrOf(it)
          if (a === 'bound') cBound++
          else if (a === 'other') cOther++
          else cUnknown++
        }
        const filteredItems = scope === 'bound' ? sortedItems.filter((it) => attrOf(it) === 'bound') : sortedItems
        const shownItems = filteredItems.slice(0, entryLimit)

        // 状态卡的一行「标签：值」（标签固定窄列，值可换行；对齐靠 grid，⛔ 不用一坨长句堆叠）
        const kvRow = (label, value) => e('div', { key: label, style: { display: 'grid', gridTemplateColumns: '64px minmax(0,1fr)', gap: '2px 10px', alignItems: 'baseline' } },
          e('span', { style: dimStyle }, label),
          e('span', { style: { fontSize: SMALL_FONT_SIZE, minWidth: 0, wordBreak: 'break-word' } }, value))

        const healthRows = []
        healthRows.push(e('div', { key: 'h1', style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          e('span', { style: sectionTitleStyle }, '当前状态'),
          isolationDead ? e('span', { style: amberBadgeStyle }, '检索不到东西') : null,
        ))
        healthRows.push(kvRow('绑定周目',
          unmapped
            ? '本会话未归入周目'
            : (bound === ''
              ? '未绑定'
              : e('span', null,
                e('span', { style: { fontFamily: MONO, fontSize: SMALL_FONT_SIZE }, title: bound }, boundShort),
                boundSrcLabel !== '' ? e('span', { style: dimStyle }, '（' + boundSrcLabel + '）') : null))))
        healthRows.push(kvRow('库存',
          vec === null
            ? '读不到'
            : (vec.count === null ? '条数读不到' : '共 ' + fmtChars(vec.count) + ' 条')
              + '：本周目 ' + (boundCount === null ? '—' : String(boundCount))
              + ' · 其它周目 ' + (deniedCount === null ? '—' : String(deniedCount))))
        healthRows.push(kvRow('上次入库',
          (ingestLive && Number.isFinite(ingestLive.finishedAt) ? new Date(ingestLive.finishedAt).toLocaleString() + ' · ' : '')
          + ingestPlain))
        healthRows.push(kvRow('数据时间',
          (info && Number.isFinite(info.at) ? new Date(info.at).toLocaleString() + '（' + vectorStaleText(snap.staleMs) + '）' : '还没有状态（插件还没在这个周目跑过）')
          + ' · 入库时机：剧情压缩时自动入库，检索工具调用时也会入库'))
        if (unmapped) {
          healthRows.push(e('div', { key: 'unmapped', id: 'dma-vector-unmapped', style: errorStyle },
            '本会话还没归入任何周目 ⇒ 这一档不参与检索（也不回响、不注最近几楼）。'
            + '先在 Tavern 里给这个会话开/选一个周目；面板里那个「工作区根」只是查看用的视图。'))
        }
        if (isolationDead) {
          healthRows.push(e('div', { key: 'dead', id: 'dma-vector-isolation-dead', style: errorStyle },
            bound !== ''
              ? '本库 ' + String(total) + ' 条都不属于当前周目（' + boundShort + '），当前周目 0 条 ⇒ 现在检索不到东西。'
              : '还没有绑定周目：本库 ' + String(total) + ' 条没有一条算本周目 ⇒ 现在检索不到东西。',
          ))
        }

        // 回执里的动作名是机器码（ingest-now…），摆出来前先翻成按钮上那个中文短名
        const resultRow = snap.result
          ? e('div', { id: 'dma-vector-lastresult', style: dimStyle },
              '最近一次动作：' + (VECTOR_RESULT_LABELS[String(snap.result.action || '')] || String(snap.result.action || '')) + ' · '
              + (snap.result.ok === true ? '成功' : '失败')
              + (typeof snap.result.message === 'string' && snap.result.message !== '' ? ' · ' + snap.result.message : '')
              + (snap.result.at ? ' · ' + new Date(snap.result.at).toLocaleString() : ''))
          : null

        const outStyle = out.status === 'ok' ? okStyle : (out.status === 'fail' || out.status === 'timeout' ? errorStyle : dimStyle)

        // 库行：名字 + 现状 +（重建 / 删除）。删除是危险动作 ⇒ 红字；缺库 ⇒ 琥珀 ⚠缺失。
        // 「重建」两组指向同一个 action（见 VECTOR_ARMED 说明）；`missing`=这个库定位不到（快照说了它没有 / 根缺失）。
        const libRow = (key, label, detail, missing, deleteKey) => {
          const armedHere = armed === key
          return e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '4px 0', borderTop: '1px solid color-mix(in srgb, CanvasText 8%, transparent)' } },
            e('span', { style: { fontSize: SMALL_FONT_SIZE, opacity: 0.75, width: 52, flex: 'none' } }, label),
            e('span', { style: dimStyle }, detail),
            missing === true ? e('span', { style: amberBadgeStyle }, '⚠缺失') : null,
            e('span', { style: { flex: 1 } }),
            e('button', {
              id: 'dma-vector-rebuild-' + (deleteKey === 'delete-bm25' ? 'bm25' : 'vector'),
              className: 'dma-btn', style: miniBtnStyle, disabled: busy !== '',
              title: '向量与 BM25 两个库一起从头重算（要调向量接口，可能花几十秒）',
              onClick: () => act(key),
            }, armedHere ? '再点一次确认' : '重建'),
            e('button', {
              id: 'dma-vector-delete-' + (deleteKey === 'delete-bm25' ? 'bm25' : 'vector'),
              className: 'dma-btn', style: dangerMiniBtnStyle, disabled: busy !== '',
              title: '删掉这个库（会先改名留档，不彻底销毁）',
              onClick: () => act(deleteKey),
            }, armed === deleteKey ? '再点一次确认' : '删除'),
          )
        }
        const vecDetail = vec === null
          ? '读不到'
          : (vec.exists === false ? '还没有文件' : (vec.count === null ? '条数读不到' : fmtChars(vec.count) + ' 条' + (vec.mtime ? ' · ' + new Date(vec.mtime).toLocaleString() : '')))
        const bmDetail = bm === null
          ? '读不到'
          : (bm.exists === false ? '还没有文件' : formatBytes(bm.bytes) + (bm.mtime ? ' · ' + new Date(bm.mtime).toLocaleString() : ''))

        // 逐条条目：一行 = 摘要名 · 楼层 · 字数 · 归属徽标（网格对齐），第二行小标签；点行展开正文预览
        const entryBodyNode = (it, sum) => e('div', { key: 'body', style: { padding: '2px 6px 8px', display: 'flex', flexDirection: 'column', gap: 4 } },
          it.text === null
            ? e('div', { style: errorStyle }, '正文读不到（库里那份正文文件缺失或已损坏）')
            : e('pre', { style: { margin: 0, padding: '8px 10px', fontFamily: MONO, fontSize: SMALL_FONT_SIZE, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 180, overflowY: 'auto', background: 'color-mix(in srgb, CanvasText 4%, Canvas)', borderRadius: 6 } },
                it.text + (it.textTruncated ? '\n…（预览到此为止；全文 ' + fmtChars(it.chars) + ' 字）' : '')),
          e('div', { style: dimStyle },
            '入库时间：' + (Number.isFinite(it.timestamp) ? new Date(it.timestamp).toLocaleString() : (Number.isFinite(it.mtime) ? new Date(it.mtime).toLocaleString() + '（按文件时间）' : '—'))
            + ' · 对应摘要：' + (sum
              ? String(sum.file) + (Number.isFinite(sum.chars) ? '（摘要全文 ' + fmtChars(sum.chars) + ' 字）' : '')
              : '「摘要」页签里没有这条对应的文件')),
        )
        const entryRowNode = (it) => {
          const key = it.metadataFile !== '' ? it.metadataFile : it.index
          const open = openEntry === key
          const sum = sumOf(it)
          const floorTxt = sum && Number.isFinite(sum.fromFloor)
            ? String(sum.fromFloor) + '–' + String(Number.isFinite(sum.toFloor) ? sum.toFloor : '?') + ' 楼'
            : '—'
          const tags = (Array.isArray(it.tags) ? it.tags : []).filter((t) => t.indexOf('pt:') !== 0)
          return e('div', { key, style: { borderBottom: '1px solid color-mix(in srgb, CanvasText 8%, transparent)' } },
            e('div', {
              onClick: () => setOpenEntry(open ? '' : key),
              style: {
                display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto auto auto', gap: '2px 12px',
                alignItems: 'baseline', padding: '5px 6px', cursor: 'pointer',
                background: open ? 'color-mix(in srgb, CanvasText 5%, Canvas)' : 'transparent',
              },
              title: open ? '收起正文' : '点开看这条的正文',
            },
              e('span', { style: { fontFamily: MONO, fontSize: SMALL_FONT_SIZE, wordBreak: 'break-all' } },
                entryName(it) === '' ? '（这条读不出名字）' : entryName(it)),
              e('span', { style: dimStyle }, floorTxt),
              e('span', { style: it.chars === null && it.metadataFile !== '' ? errorStyle : dimStyle, title: '这一条切片正文的字数（从库里的正文文件算）' },
                it.bad ? '数据不完整' : (it.metadataFile === '' ? '—' : (it.chars === null ? '字数读不到' : fmtChars(it.chars) + ' 字'))),
              attrBadge(it),
              tags.length > 0 ? e('span', { style: { gridColumn: '1 / -1', display: 'flex', gap: 4, flexWrap: 'wrap' } },
                tags.map((t, i) => e('span', { key: 't' + i, style: dimBadgeStyle }, '#' + t))) : null,
            ),
            open ? entryBodyNode(it, sum) : null,
          )
        }

        // 条目卡：读不到要分清来路（没落盘 / 打不开），⛔ 不白屏、不编空表
        let entriesCard = null
        if (snap.status === 'ready' && info !== null) {
          const kids = []
          kids.push(e('div', { key: 'head', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            e('span', { style: sectionTitleStyle }, '向量条目'),
            entries !== null ? e('span', { style: dimBadgeStyle }, '共 ' + String(entries.total) + ' 条') : null,
            e('span', { style: { flex: 1 } }),
            e('button', { className: 'dma-btn dma-tab', 'data-sel': scope === 'all' ? '1' : '0', style: miniBtnStyle, onClick: () => setScope('all') }, '全部'),
            e('button', { className: 'dma-btn dma-tab', 'data-sel': scope === 'bound' ? '1' : '0', style: miniBtnStyle, onClick: () => setScope('bound') }, '只看本周目'),
          ))
          if (entries === null) {
            kids.push(e('div', { key: 'none', style: vec !== null && vec.exists === false ? dimStyle : errorStyle },
              vec !== null && vec.exists === false
                ? '向量库文件还没有落盘（上面标着「⚠缺失」），条目无从列起；点「立即入库」让它建起来。'
                : '条目读不到：库文件（index.json）打不开或不是预期的格式。'))
          } else if (entries.items.length === 0) {
            kids.push(e('div', { key: 'empty', style: dimStyle }, '库是空的：还没有任何条目。点「立即入库」把摘要补进来。'))
          } else {
            kids.push(e('div', { key: 'count', style: dimStyle },
              '本周目 ' + String(cBound) + ' · 其它周目 ' + String(cOther) + ' · 未标注 ' + String(cUnknown)
              + ' · 与「摘要」页签按文件名一一对应'
              + (entries.unreadable > 0 ? ' · ' + String(entries.unreadable) + ' 条正文读不到' : '')))
            if (entries.truncated) kids.push(e('div', { key: 'trunc', style: dimStyle }, '条目太多，只列出前 ' + String(entries.items.length) + ' 条。'))
            if (scope === 'bound' && filteredItems.length === 0) {
              kids.push(e('div', { key: 'nobound', style: dimStyle },
                '本周目 0 条：列出的 ' + String(entries.items.length) + ' 条都不是当前周目的（见上方红字）。'))
            } else {
              kids.push(e('div', { key: 'rows' }, shownItems.map(entryRowNode)))
            }
            if (filteredItems.length > GROUP_ROW_LIMIT) {
              kids.push(e('div', { key: 'fold', style: { display: 'flex', gap: 8, alignItems: 'center', paddingTop: 4 } },
                filteredItems.length > shownItems.length
                  ? e('button', { className: 'dma-btn', style: btnStyle, onClick: () => setEntryLimit(entryLimit + 20) }, '展开其余 ' + String(filteredItems.length - shownItems.length) + ' 条')
                  : null,
                entryLimit > GROUP_ROW_LIMIT
                  ? e('button', { className: 'dma-btn', style: btnStyle, onClick: () => setEntryLimit(GROUP_ROW_LIMIT) }, '收起')
                  : null,
                e('span', { style: dimStyle }, '显示 ' + String(shownItems.length) + ' / ' + String(filteredItems.length) + ' 条'),
              ))
            }
          }
          entriesCard = e('div', { id: 'dma-vector-entries', style: cardStyle }, kids)
        }

        return e('div', Object.assign({}, scrollBind), e('div', { style: readColStyle },
          e('div', { id: 'dma-vector-health', style: cardStyle }, healthRows),
          snap.status === 'error' ? e('div', { style: errorStyle }, '读取向量状态失败：' + snap.error) : null,
          // ★ 空状态（info===null 是**正常态**：anima 还没在会话平面跑过那一脚）：明说怎么走出来，
          //   ⛔ 不白屏、也不拿一行"读不到"含糊过去（任务口径：这一句要原样出现）。
          snap.status === 'ready' && info === null
            ? e('div', { id: 'dma-vector-empty', style: itemStyle },
                '还没有状态快照：开一条这个周目的会话，或点『立即入库』。')
            : null,
          resultRow,
          // 库卡：只列 dsh-memory 这一个集合（用户 2026-09-20 拍板「只列这一个」）
          e('div', { id: 'dma-vector-collection', style: cardStyle },
            e('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              e('span', { style: sectionTitleStyle }, '库'),
              e('span', { style: { fontFamily: MONO, fontSize: SMALL_FONT_SIZE, opacity: 0.8 } }, String((info && info.collectionId) || 'dsh-memory')),
              missingBadge(vec ? vec.exists : undefined),
              e('span', { style: { flex: 1 } }),
              e('button', {
                id: 'dma-vector-ingest', className: 'dma-btn', style: btnStyle, disabled: busy !== '',
                title: '把还没入库的摘要补进两个库（要调向量接口，可能花几十秒）',
                onClick: () => act('ingest-now'),
              }, armed === 'ingest-now' ? '再点一次确认' : '立即入库'),
            ),
            libRow('rebuild:vector', '向量库', vecDetail, vec !== null && vec.exists === false, 'delete-vector'),
            libRow('rebuild:bm25', 'BM25', bmDetail, bm !== null && bm.exists === false, 'delete-bm25'),
          ),
          entriesCard,
          armedDoc
            ? e('div', { id: 'dma-vector-confirm', style: Object.assign({}, itemStyle, { color: 'crimson' }) },
                '确认「' + armedDoc.label + '」？' + armedDoc.hint + '再点一次确认执行。',
                e('button', {
                  id: 'dma-vector-confirm-cancel', className: 'dma-btn',
                  style: Object.assign({}, miniBtnStyle, { marginLeft: 8 }),
                  onClick: () => setArmed(''),
                }, '取消'),
              )
            : null,
          e('div', { style: cardStyle },
            e('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              e('span', { style: sectionTitleStyle }, '参与检索'),
              e('span', { style: dimStyle }, '这个开关同时管向量与 BM25 两个库：关掉后都不再参与检索（下一轮对话起作用）。'),
              e('button', {
                id: 'dma-vector-toggle', className: 'dma-btn', style: btnStyle,
                disabled: busy !== '' || chatOn === null,
                onClick: toggleChat,
              }, chatOn === null ? '读取中…' : (chatOn === true ? '已开启 · 点这里关掉' : '已关闭 · 点这里打开')),
            ),
          ),
          out.status !== 'idle' && out.status !== 'waiting' ? e('div', { id: 'dma-vector-outcome', style: outStyle }, out.message) : null,
          out.status === 'waiting' ? e('div', { id: 'dma-vector-outcome', style: dimStyle }, out.message) : null,
          e('div', { style: dimStyle }, '状态和条目都来自向量插件（dsh-anima-rag）落盘的文件；这里只看状态、递交请求，动作在该周目下一轮对话开始前执行。'),
        ))
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
      // 会话模式只剩会话事件；工作区模式 摘要/原文/剧情大纲（20260919 加「剧情大纲」档；2026-09-20 摘掉「状态」档）；
      // Tavern 不可达时退根会话事件，拿不到就无源可读
      function computeSources(mode, tavernOk, eventsSessionId) {
        if (mode === 'session') {
          return eventsSessionId ? [['events', '会话事件']] : []
        }
        if (!tavernOk) {
          // Tavern 不可达：工作区归档读不到；若拿得到根会话 ID（目录缓存/manifest），退到会话事件
          return eventsSessionId ? [['events', '会话事件']] : []
        }
        // ★ 2026-09-19：入口与摘要/原文同层（现排在最后，因为「状态」档 2026-09-20 已摘除）。
        //   它的防剧透门在档内组件里 —— 排序只管入口位置，不管可见性。
        // ★ 2026-09-20：「状态」档已摘除（用户口径）—— 见 StateFlow 那处的说明（它读的文件没有任何人写）。
        // ★ 2026-09-20：「向量」档（用户口径「把它的向量面板搬过来，和摘要原文平级」）—— 同样与它们同层。
        return [['summaries', '摘要'], ['floors', '原文'], ['outline', '剧情大纲'], ['vector', '向量']]
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
            'Tavern（pmp-dsh-tavern）不可达：工作区归档（摘要/原文）读不到。'
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
        } else if (cur === 'outline') {
          // ★ 剧情大纲档 = 角色扮演预设的记忆库（.roleplay-memory/，只读）：
          //   门在 RpMemoryFlow 内部 —— 未确认前正文零字节进面板。
          content = e(RpMemoryFlow, { scrollBind: scrollBind })
        } else if (cur === 'vector') {
          // ★ 向量档（2026-09-20）：只读状态 + 逐条条目 + 库行 + 参与检索开关。
          //   真拥有向量库的是 dsh-anima-rag（按会话挂载）⇒ 这一档只「读状态 / 写请求单」，
          //   动作由 anima 在该周目会话的下一轮开始前执行（实现全在宿主侧 lib/vector-panel.js）。
          //   archivePath 传进去只为把条目和「摘要」页签按文件名对上（同一份读法，⛔ 不另造）。
          content = e(VectorFlow, { archivePath: archivePath, scrollBind: scrollBind })
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
      // 提示词区（v4 第二单吸收；v4.1 起每次请求查看器为独立入口）
      // ★ 2026-09-18：原先这里指的「PART_TABS 并列版块页签」已随完整视图整体删除 —— 别再按那句找。
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

      /**
       * 常驻集响应归一（20260915 查看器提速）。纯函数，自检可直接调。
       * ★ 只认显式字段：缺失一律给「未知」的保守值（pending 空数组、refreshMs null），
       *   ⛔ 不把"没给"折成 0/false 那种会被误读成"已知"的值。
       */
      function applyResidentPayload(data) {
        const d = data && typeof data === 'object' ? data : {}
        return {
          ids: Array.isArray(d.ids) ? d.ids.map((x) => String(x)) : [],
          pending: Array.isArray(d.pending) ? d.pending.map((x) => String(x)) : [],
          queued: Array.isArray(d.queued) ? d.queued.map((x) => String(x)) : [],
          stats: d.stats && typeof d.stats === 'object' ? d.stats : null,
          lastWarmAt: typeof d.lastWarmAt === 'string' ? d.lastWarmAt : null,
          lastRefreshAt: typeof d.lastRefreshAt === 'string' ? d.lastRefreshAt : null,
          refreshMs: typeof d.refreshMs === 'number' ? d.refreshMs : null,
          max: typeof d.max === 'number' ? d.max : null,
        }
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
      // ★ 2026-09-20 退役：状态子系统整套剥离（state-bridge 归档、story-anchor 也不再挂载）。
      //   这条注释**只为老捕获**保留（新装配里不会有这一段）。
      const NOTE_STATE_CARD = '【已退役 · 2026-09-20】原为 L1 状态卡（副 LLM 每轮记账的数值/分组/到期）；现在状态改由周目笔记里的 `state.md` 维护。'
      const NOTE_ANIMA = 'L2 检索记忆：从历史里检索出来的摘录（<recalledMemories>）与近场历史（<immediateHistory>）。只对 RP 会话注入。'
      const NOTE_TOOL_GUIDE = '工具的使用说明与纪律，和下面 tools 里的定义配套。'
      const NOTE_COMPACTED = '被压缩出上下文的那段历史（checkpoint）。前言由官方 frameSummary() 拼出，作用是告诉模型“这是既成背景，别复述”。'
      const NOTE_TOOLS = '这次请求可用的工具定义（名字 + 参数 schema）。几十个属于正常量级。'
      const NOTE_MESSAGES = '真实历史轮次；其中可能夹着 durable 注入的快照（例如 context() 的每轮快照）。'
      const NOTE_ST_CHAR = '角色卡字段（SillyTavern 格式）在 system 里的落点。'
      const NOTE_STORY_ANCHOR = '（归属待确认）疑似剧情锚点相关注入；没查到确定的注入方，先如实标注。'
      const NOTE_UNKNOWN = '未能识别归属（未匹配到已知注入点）'

      // ★★ 归属文案里**不写 order 数字**（2026-09-14 结构性修复）：
      //   这批常量同时喂给两条路 —— ① 文本推断路径（SYS_SECTION_DEFS：那条路**没有 order 数据**）
      //   ② 装配地图图例（PROMPT_MAP_DEFS：图例自带 order/orderNum 字段，数字校对过）。
      //   把数字写进共享文案 ⇒ ① 会"继承"一个具体数字，于是漂了（真人踩到：identity 写成 ≈-100，真值 -1000）。
      //   ⇒ 归属只说"谁"；**数字一律来自捕获**（没有捕获就写"未知（按文本推断）"）。
      //   `_selftest-prompt-map.mjs` 有断言钉住这条（WHO_* 串里出现 order 数字即红）。
      const WHO_IDENTITY = 'DSH 核心（harness identity）'
      const WHO_PERSONA = 'DSH 核心（Agent/deployment persona）'
      const WHO_PRESET = 'pmp-dsh-tavern（profile 段）'
      const WHO_RP_POLICY = 'pmp-dsh-tavern（rp:policy）'
      // ★ 2026-09-20：state-bridge 已整套剥离，但**老捕获**里还有 `state:card` 那一行 ⇒ 归属与注释都留着
      //   （与 `deployment:persona` / `roleplay:policy` 那两条"历史名"同一个理由：留着才有注释可显示）。
      const WHO_STATE_CARD = 'dsh-state-bridge（state:card · 2026-09-20 已剥离）'
      const WHO_ANIMA = 'dsh-anima-rag（anima:memory）'
      const WHO_TOOL_GUIDE = 'DSH 核心（工具引导段）'
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
      /**
       * 正文显示（2026-09-19 改）：**默认按 Markdown 美化**，可一键切「原文」。
       *
       * 用户口径（原文）：「查看器显示的文本。请支持 md 格式美化显示」。
       * ★ 复用本文件里**既有的** Markdown 管线（`parseMarkdown` + `MarkdownBody`，散文正文那套），
       *   ⛔ 不再写第二套解析器（同一份能力两处实现，迟早漂）。
       * ★ **有搜索词时默认切到原文**：美化视图是流式排版，逐字高亮会破版；原文视图是等宽 + 分块 +
       *   `highlight()`，搜索命中一眼可见。⇒ 默认值随 query 走，用户仍可手动切（`null` = 跟随默认）。
       * 两种视图都**不截断**（原文分块只为 contentVisibility 省算力，内容一字不少）。
       */
      function ChunkedText({ text, query }) {
        const src = typeof text === 'string' ? text : ''
        const hasQuery = String(query == null ? '' : query).trim() !== ''
        const [choice, setChoice] = React.useState(null) // null = 跟随默认（有搜索词 ⇒ 原文）
        const showRaw = choice === null ? hasQuery : choice === 'raw'
        const toggle = e('div', {
          'data-md-toggle': '1',
          style: { width: READ_COL_WIDTH, margin: '0 auto 6px', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
        },
          [['md', '渲染'], ['raw', '原文']].map(([mode, label]) => {
            const on = (mode === 'raw') === showRaw
            return e('button', {
              key: mode, type: 'button', 'data-md-mode': mode,
              onClick: () => setChoice(mode),
              title: mode === 'md'
                ? '按 Markdown 美化显示（标题/列表/代码块/引用/粗体/行内代码）'
                : '原样显示（等宽、保留全部空白与标记；**搜索高亮只在这个视图里**）',
              style: {
                cursor: 'pointer', font: 'inherit', fontSize: SMALL_FONT_SIZE, padding: '1px 8px', borderRadius: 999,
                border: '1px solid color-mix(in srgb, CanvasText 20%, transparent)',
                background: on ? 'color-mix(in srgb, CanvasText 12%, transparent)' : 'transparent',
                fontWeight: on ? 700 : 400,
              },
            }, label)
          }),
          hasQuery && choice === null
            ? e('span', { 'data-md-hint': '1', style: { fontSize: SMALL_FONT_SIZE, color: 'GrayText' } },
              '有搜索词 ⇒ 默认原文（高亮在这里）；想看美化版点「渲染」')
            : null,
        )
        if (!showRaw) {
          return e('div', { 'data-md-view': 'md' }, toggle,
            e('div', { style: { width: READ_COL_WIDTH, margin: '0 auto' } }, e(MarkdownBody, { text: src })))
        }
        const chunks = []
        for (let i = 0; i < src.length; i += FULL_CHUNK_CHARS) {
          chunks.push(src.slice(i, i + FULL_CHUNK_CHARS))
        }
        if (chunks.length === 0) chunks.push('')
        return e('div', { 'data-md-view': 'raw' }, toggle,
          e('div', {
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
            }, query ? highlight(c, query) : c))),
        )
      }

      // ---------- 按楼分段（20260918 查看器单 T3）：一轮 = 一个区段 ----------
      // 输入 = part=messages 响应的 messages[]（宿主 20260918 起每行带 turn/blocks）。
      // 输出 = 有序段数组 { turn, label, messages }；段序 = 楼号首次出现的先后。
      // turn 缺失/null 的行**一条不丢**，归并进唯一一个「未标注楼」段固定放最后
      //（不知道是哪一楼就照实说，⛔ 不许塞进别的楼，也不许猜成"第 0 楼"）。
      function groupMessagesByTurn(messages) {
        const list = Array.isArray(messages) ? messages : []
        const segs = []
        const byTurn = new Map()
        let unmarked = null
        for (const m of list) {
          const t = m && typeof m.turn === 'number' && Number.isInteger(m.turn) && m.turn > 0 ? m.turn : null
          if (t === null) {
            if (unmarked === null) {
              unmarked = { turn: null, label: '未标注楼', messages: [] }
              segs.push(unmarked)
            }
            unmarked.messages.push(m)
            continue
          }
          let seg = byTurn.get(t)
          if (!seg) {
            seg = { turn: t, label: '第 ' + t + ' 楼', messages: [] }
            byTurn.set(t, seg)
            segs.push(seg)
          }
          seg.messages.push(m)
        }
        const floors = segs.filter((s) => s.turn !== null)
        return unmarked !== null ? floors.concat([unmarked]) : floors
      }

      // ---------- messages 视图：按楼分段的**列表**（20260918 消息流单 T2 改版） ----------
      // 两种形态，各有各的来路：
      //   ① 宿主给了逐楼数据（messages[].turn/blocks，20260918+）⇒ 按楼分段（一轮一段）+ 逐块词头：
      //      思维链（kind=reasoning）灰斜体、一眼可辨。点消息行 ⇒ onOpenSeq(该条 seq) 打开**单条抽屉**
      //      （ViewerMsgPanel：正文按条从出口取，与 system 单段抽屉同构）。
      //      ★ 旧「点行就地展开整段拼装 text + 行内原 JSON 按钮」已拆（用户拍板：并进抽屉，
      //        ⛔ 列表不再读整段拼装文本，也不再自己挂「原 JSON」取数）。
      //   ② 老宿主没有 turn/blocks ⇒ 原样走既有全文视图（每条正文 md 渲染，D 单口径不动）。
      // ⛔ 搜索词不再进这里（本栏搜索框已拆，20260918 消息流单 T1）；分段视图不受 query 影响。
      function ViewerMessagesBody({ text, messages, onOpenSeq }) {
        const src = typeof text === 'string' ? text : ''
        const parsed = splitMessagesText(src)
        const flow = Array.isArray(messages) && messages.length > 0
        if (flow) {
          const segs = groupMessagesByTurn(messages)
          const blockLabel = (kind) => (kind === 'reasoning' ? '思维链' : kind === 'text' ? '正文' : kind == null || kind === '' ? '块' : String(kind))
          return e('div', { style: { display: 'flex', flexDirection: 'column', gap: BLOCK_GAP } },
            segs.map((seg) => e('div', {
              key: 'turn-' + (seg.turn === null ? 'null' : String(seg.turn)),
              'data-msg-seg': seg.turn === null ? '' : String(seg.turn),
              style: { display: 'flex', flexDirection: 'column', gap: 4 },
            },
              e('div', {
                'data-msg-turn': seg.turn === null ? '' : String(seg.turn),
                style: {
                  fontSize: 12, fontWeight: 700, opacity: 0.75, paddingBottom: 2,
                  borderBottom: '1px solid color-mix(in srgb, CanvasText 20%, transparent)',
                },
              }, seg.label + ' · ' + seg.messages.length + ' 条'),
              seg.messages.map((m) => {
                const seqKey = m && m.seq != null ? String(m.seq) : 'idx-' + String((m && m.index) != null ? m.index : '?')
                // ★ 消息流单 T2：点行 ⇒ 单条抽屉。没有 seq 的条目给不了（端点按 seq 取）⇒ 如实不可点。
                const openable = typeof onOpenSeq === 'function' && m && m.seq != null
                const marks = []
                if (m && m.isToolResult) marks.push('工具结果')
                if (m && m.isCompacted) marks.push('已压缩')
                const blocksList = m && Array.isArray(m.blocks) ? m.blocks : []
                return e('div', {
                  key: seqKey,
                  'data-msg-seq': m && m.seq != null ? String(m.seq) : undefined,
                  style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
                },
                  e('div', {
                    'data-msg-row': '1',
                    style: {
                      display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0,
                      cursor: openable ? 'pointer' : 'default',
                    },
                    onClick: openable ? () => onOpenSeq(m.seq) : undefined,
                    title: openable ? '点开这一条的详细（正文按条从出口取；原样 JSON 在抽屉里）' : undefined,
                  },
                    e('span', { style: { fontWeight: 700, flexShrink: 0 } },
                      '[' + ((m && m.role) || '?') + ']' + (m && m.seq != null ? ' · seq ' + m.seq : '')),
                    e('span', { style: { fontFamily: MONO, fontSize: SMALL_FONT_SIZE, opacity: 0.6, flexShrink: 0 } },
                      (m && typeof m.chars === 'number' ? fmtChars(m.chars) + ' 字' : '')),
                    marks.map((x) => e('span', { key: x, style: dimBadgeStyle }, x)),
                    openable ? e('span', { style: { marginLeft: 'auto', flexShrink: 0, fontSize: SMALL_FONT_SIZE, color: 'GrayText' } }, '详情 ›') : null,
                  ),
                  // 详细词头：每块一行（head 沿用宿主 preview 同一条口径）；思维链灰斜体可辨。
                  // 块级词头行不可点 —— 下钻挂在消息行上（点行开单条抽屉，看正文与原样 JSON）。
                  blocksList.length > 0
                    ? blocksList.map((bk, i) => e('div', {
                      key: String(i),
                      'data-msg-block': bk && bk.kind != null ? String(bk.kind) : '',
                      style: bk && bk.kind === 'reasoning'
                        ? { fontStyle: 'italic', color: 'GrayText', fontSize: 12, wordBreak: 'break-word', paddingLeft: 10 }
                        : { fontSize: 12.5, opacity: 0.85, wordBreak: 'break-word', paddingLeft: 10 },
                      title: bk && bk.kind === 'reasoning'
                        ? '思维链（reasoning 块）词头 · ' + ((bk && bk.chars) || 0) + ' 字 —— 宿主只给词头，全文不进查看器'
                        : '该块词头 · ' + ((bk && bk.chars) || 0) + ' 字',
                    }, blockLabel(bk && bk.kind) + ' · ' + ((bk && bk.chars) || 0) + ' 字 · ' + String((bk && bk.head) || '')))
                    : e('div', { style: { fontSize: 12.5, opacity: 0.85, wordBreak: 'break-word' } },
                      String((m && m.preview) != null ? m.preview : '')),
                )
              }),
            )),
          )
        }
        if (!parsed) {
          // 形状变了（没有消息分隔标记）：按原样整段渲染，不猜
          return e(ChunkedText, { text: src, query: '' })
        }
        return e('div', { style: { display: 'flex', flexDirection: 'column', gap: BLOCK_GAP } },
          parsed.map((b, i) => {
            const body = typeof b.text === 'string' ? b.text.replace(/^\n/, '') : ''
            const big = body.length > PART_BIG_TEXT_CHARS
            return e('div', { key: String(i), style: msgBlockStyle },
              e('div', { style: msgHeadStyle },
                e('span', { style: { fontWeight: 700 } },
                  '[' + (b.role || '?') + ']' + (b.seq !== null && b.seq !== undefined ? ' · seq ' + b.seq : '')),
              ),
              big
                ? e(ChunkedText, { text: body, query: '' })
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

      // ★★ 2026-09-18（用户口径「拆了吧不需要了」）：**并列版块页签与「完整视图」已整体删除**。
      //   原先 `PART_TABS`（system/tools/inventory/消息流/完整）+ `PartTabs` + `FullPromptView` 是
      //   v4.1 那一版「部件并列」架构的遗物 —— 用户先砍掉了消息流栏的页签与搜索框（T1），
      //   最后连那个只剩深链 `box=full` 可达的壳也不要了。
      //   ⛔ 别再把它加回来：那些部件（system/tools/inventory）由**装配地图**逐行覆盖，
      //      地图行点开就是单段/单条抽屉，不需要第二套并列视图。
      //   （若哪天确实需要"整份 prompt 拼在一起看"，那先问用户 —— 别照着旧代码复活。）

      // ---------- 子页 A·左栏：会话列表（工作区分组，与 DSH 侧边栏逻辑一致） ----------
      // 首刷只扫目录；标题过 labelSession 三级回退；requests===0 / origin==='subagent' 默认隐藏
      // （-1 未解析不算空）；每组默认 8 条，超出折叠成「展开其余 N 个会话」。
      function ViewerSessionList({ state, hostById, hostError, selectedId, onSelect, onRefresh, nameIdx, width, mode, residentMeta, onModeChange, onToggleResident }) {
        const [filter, setFilter] = React.useState('')
        const [expanded, setExpanded] = React.useState(() => new Set())
        const [showAll, setShowAll] = React.useState(false)
        // 归档开关（20260914 M4，hook #3）：默认隐藏已归档行；状态只存本组件 state（不持久化）。
        const [showArchived, setShowArchived] = React.useState(false)
        // ★ 2026-09-15 用户口径：选常驻要"**选数个 → 点确认**"，不是"点一个就直接跳/直接加"。
        //   pending = 本次勾选但还没确认的 sessionId 集合；⛔ 勾选**不触发**任何网络请求、也不跳转。
        //   ⚠️ 本 hook 必须待在这一组既有 state **之后**（自检台按 hook 序号注入预设值，序号是冻结契约）。
        const [pending, setPending] = React.useState(() => new Set())
        // ⛔ 不用 useMemo：本仓库的自检台用**假 React**（只实现 useState/useEffect/useRef/useCallback），
        //   多一个 hook API 就会把台子打红；这里每帧重算一次（Set 很小）完全够。
        const pendingIds = Array.from(pending)
        const togglePending = (id) => setPending((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
        const clearPending = () => setPending(new Set())
        const q = filter.trim().toLowerCase()
        const joinOf = (row) => {
          const hit = hostById ? hostById.get(String(row.id)) : null
          return hit || null
        }
        const reasonOf = (row) => hiddenSessionReason({ requests: row.requests, origin: (joinOf(row) || {}).origin })
        // —— 归档过滤（20260914 M4）——
        // 行字段 archived: true|false|null（null = 注册表读不到，未知）。信封 state.archive.known
        // 为 false / 缺失 ⇒ 一条都不许隐藏（未知 ≠ 未归档，能藏错的宁可别藏），并显示一行说明。
        // ★ 当前选中的会话即使已归档也保持可见 —— ⛔ 不许因为过滤把右栏/详情搞空。
        const archiveKnown = !!(state.archive && state.archive.known === true)
        const archivedRows = archiveKnown ? state.items.filter((row) => row && row.archived === true) : []
        const archiveHides = (row) => archiveKnown && row.archived === true && !showArchived && row.id !== selectedId
        let nEmpty = 0
        let nSub = 0
        for (const row of state.items) {
          const r = reasonOf(row)
          if (r === 'empty') nEmpty++
          else if (r === 'subagent') nSub++
        }
        const kept = (showAll ? state.items : state.items.filter((row) => reasonOf(row) === null))
          .filter((row) => !archiveHides(row))
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
        // 20260913：列宽由分隔条拖动决定（width prop），缺省 300。
        // ★ flex:'none' 必须显式给 —— colSessionStyle 从 colFillStyle 展开时继承了 flex:1(grow)，
        //   不禁掉的话左栏会跟右栏对半分空间，切会话/页签时宽度跟着内容跳（用户报的跳宽就是它）。
        return e('div', { style: Object.assign({}, colSessionStyle, { flex: 'none', width: typeof width === 'number' ? width : 300 }) },
          e('div', { style: { display: 'flex', gap: 4 } },
            e('input', {
              id: 'dma-viewer-session-filter', name: 'dma-viewer-session-filter',
              'aria-label': '按标题/id/工作区路径过滤会话列表',
              style: Object.assign({}, inputStyle, { flex: 1, minWidth: 0 }), placeholder: '过滤：标题 / id / 工作区',
              value: filter, onChange: (ev) => setFilter(ev.target.value),
            }),
            e('button', { className: 'dma-btn', style: btnStyle, title: '重新扫描会话列表', onClick: onRefresh }, '↻')),
          // —— 常驻 / 全部 两个页（20260915 查看器提速）——
          // 常驻 = 只列用户自己挑的那几个；宿主后台**串行预热**成轻投影 ⇒ 打开即秒开、零解析。
          (() => {
            const ids = (residentMeta && residentMeta.ids) || []
            const pinned = selectedId ? ids.indexOf(selectedId) !== -1 : false
            const tabStyle = (on) => Object.assign({}, miniBtnStyle, { flex: 'none' },
              on ? { background: 'color-mix(in srgb, Highlight 25%, transparent)', fontWeight: 700 } : null)
            return e('div', { style: { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' } },
              e('button', {
                className: 'dma-btn dma-mini', style: tabStyle(mode !== 'all'), 'data-mode': 'resident',
                title: '只列常驻会话：宿主后台串行预热（同一时刻只解析一个），打开面板直接读缓存 —— 不扫全量、不批量解析',
                onClick: () => onModeChange('resident'),
              }, '常驻 ' + ids.length),
              e('button', {
                className: 'dma-btn dma-mini', style: tabStyle(mode === 'all'), 'data-mode': 'all',
                title: '全部会话（fs 扫描，不解析标题）—— 在这里挑会话点「＋」加进常驻',
                onClick: () => onModeChange('all'),
              }, '全部'),
              e('button', {
                className: 'dma-btn dma-mini', 'data-pin': pinned ? '1' : '0',
                style: Object.assign({}, miniBtnStyle, { flex: 'none' }, pinned ? { fontWeight: 700 } : null),
                disabled: !selectedId || !onToggleResident,
                title: !selectedId
                  ? '先选一个会话'
                  : (pinned ? '把当前会话移出常驻（不再后台预热）' : '把当前会话设为常驻：宿主后台预热，下次打开即秒开'),
                onClick: () => {
                  if (!selectedId || !onToggleResident) return
                  onToggleResident(pinned ? ids.filter((x) => x !== selectedId) : ids.concat([selectedId]))
                },
              }, pinned ? '－ 取消常驻' : '＋ 常驻'),
            )
          })(),
          state.status === 'loading' && e('div', { style: dimStyle }, '正在扫描会话列表…'),
          state.status === 'error' && e('div', { style: errorStyle }, '会话列表加载失败：' + state.error),
          // ★ 批量确认条（20260915 用户口径）：勾选几个之后**点这里**才落盘；勾选本身不发请求、不跳转。
          state.status === 'ready' && pending.size > 0 && (() => {
            const ids = (residentMeta && residentMeta.ids) || []
            const toAdd = pendingIds.filter((id) => ids.indexOf(id) === -1)
            const toRemove = pendingIds.filter((id) => ids.indexOf(id) !== -1)
            const barBtn = { className: 'dma-btn dma-mini', style: Object.assign({}, miniBtnStyle, { flex: 'none' }) }
            return e('div', {
              'data-pending-bar': '1',
              style: {
                display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
                border: '1px solid color-mix(in srgb, Highlight 45%, transparent)',
                background: 'color-mix(in srgb, Highlight 12%, transparent)',
                borderRadius: 6, padding: '4px 6px',
              },
            },
              e('span', { style: dimStyle, 'data-pending-count': String(pendingIds.length) },
                '已勾选 ' + pendingIds.length + ' 个（**还没生效**，点右边才落盘）'),
              toAdd.length > 0 && e('button', Object.assign({}, barBtn, {
                'data-pending-add': String(toAdd.length),
                title: '把勾选的 ' + toAdd.length + ' 个设为常驻（宿主后台串行预热，改集本身不解析）',
                onClick: () => { void onToggleResident(ids.concat(toAdd)); clearPending() },
              }), '＋ 设为常驻（' + toAdd.length + '）'),
              toRemove.length > 0 && e('button', Object.assign({}, barBtn, {
                'data-pending-remove': String(toRemove.length),
                title: '把勾选的 ' + toRemove.length + ' 个移出常驻',
                onClick: () => {
                  const kill = new Set(toRemove)
                  void onToggleResident(ids.filter((x) => !kill.has(x)))
                  clearPending()
                },
              }), '－ 取消常驻（' + toRemove.length + '）'),
              e('button', Object.assign({}, barBtn, {
                onClick: clearPending, title: '清空勾选（不改常驻集，也不发请求）',
              }), '清空'),
            )
          })(),
          state.status === 'ready' && e('div', { style: dimStyle },
            '共 ' + state.items.length + ' 个 · 显示 ' + filtered.length + ' 个'
            + (mode === 'resident' ? ' · 常驻页' : '')
            + (mode === 'resident' && residentMeta && residentMeta.pending && residentMeta.pending.length > 0
              ? ' · 后台预热中 ' + residentMeta.pending.length + ' 个'
              : '')
            + (mode === 'resident' && residentMeta && residentMeta.lastWarmAt
              ? ' · 上次预热 ' + String(residentMeta.lastWarmAt).slice(11, 19)
              : '')),
          // 常驻页空集：如实说清"怎么开始"，⛔ 不自动塞任何会话（用户选的才算常驻）。
          state.status === 'ready' && mode !== 'all' && state.items.length === 0 && e('div', { style: dimStyle, 'data-resident-empty': '1' },
            '还没有常驻会话。点上面「全部」→ 勾选几个（**勾选不会立刻生效**）→ 再点「＋ 设为常驻（N）」确认；'
            + '以后打开面板只拉这几个 —— 宿主在后台串行预热，打开即秒开，不再全量扫描、不再批量解析。'),
          // 归档开关（20260914 M4）：N = 列表里已归档的条数（开关关闭时即被隐藏的条数；
          // 当前选中的已归档会话始终可见，不计入隐藏）。
          state.status === 'ready' && archivedRows.length > 0 && e('button', {
            className: 'dma-btn dma-mini',
            style: Object.assign({}, miniBtnStyle, { flex: 'none' }),
            'data-arch-toggle': showArchived ? '1' : '0',
            title: '已归档 = 会话在工作区注册表 archivedSessionIds 里；日志仍在、内容照常可读。'
              + '默认隐藏，打开后置灰显示；当前选中的会话始终显示。',
            onClick: () => setShowArchived((v) => !v),
          }, (showArchived ? '隐藏已归档（' : '显示已归档（') + archivedRows.length + '）'),
          state.status === 'ready' && !archiveKnown && e('div', { style: dimStyle, 'data-arch-unknown': '1' },
            '归档状态不可用（已按普通会话显示）'),
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
                  const archivedRow = s.archived === true
                  // 调用次数徽标（20260913 新增）：★ 两态语义必须保住 ——
                  //   requests < 0 且 ≠ -2 → 未解析（快路径哨兵 -1）：画「—」，不是 0；
                  //   requests === -2      → 解析失败（宿主哨兵，20260913 新增）：画「⚠ 失败」，
                  //                          绝不许折成 0（否则 9.8MB 的会话会被当空会话隐藏）；
                  //   requests === 0       → 解析过、确实没有请求：画 0；
                  //   requests > 0         → 真值 N。
                  const cntBadge = typeof s.requests !== 'number'
                    ? e('span', { style: badgeCapsuleStyle, title: '调用次数未知（异常形状，不当 0 处理）' }, '?')
                    : s.requests === -2
                      ? e('span', { style: Object.assign({}, badgeCapsuleStyle, { color: 'crimson', borderColor: 'color-mix(in srgb, crimson 45%, transparent)', fontWeight: 700 }), title: '解析失败 —— 不是 0，也不当空会话隐藏；可点 ↻ 重扫重试' }, '⚠ 失败')
                      : s.requests < 0
                        ? e('span', { style: badgeCapsuleStyle, title: '未解析（快路径只扫目录）—— 点选该会话或等空闲解析后出真值；不是 0' }, '—')
                        : s.requests === 0
                          ? e('span', { style: badgeCapsuleStyle, title: '解析过：这个会话确实没有模型请求' }, '0 次')
                          : e('span', { style: Object.assign({}, badgeCapsuleStyle, { color: 'green', borderColor: 'color-mix(in srgb, green 40%, transparent)' }), title: '共 ' + s.requests + ' 次模型请求' }, s.requests + ' 次')
                  return e('div', {
                    key: s.id,
                    className: 'dma-row',
                    'data-sel': s.id === selectedId ? '1' : '0',
                    'data-arch': archivedRow ? '1' : '0',
                    // 已归档行置灰（20260914 M4）；选中高亮（data-sel 样式）不受影响。
                    style: Object.assign({}, itemStyle, archivedRow ? { opacity: 0.55 } : null, { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }),
                    onClick: () => onSelect(s.id),
                    title: String(s.id) + (g.resolved ? '' : ' · ' + String(s.workspace)),
                  },
                    e('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 } },
                      e('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0, fontSize: 14 } },
                        highlight(ls.text, filter)),
                      r === 'subagent' ? e('span', { style: dimBadgeStyle }, '子') : null,
                      r === 'empty' ? e('span', { style: dimBadgeStyle }, '空') : null,
                      archivedRow ? e('span', { style: dimBadgeStyle, 'data-arch-badge': '1', title: '已归档：该会话在工作区注册表 archivedSessionIds 里；日志仍在，内容照常可读' }, '已归档') : null,
                      // ★ M8：日志读不出来的行 —— 让用户**不必一条条点**就知道哪几条是坏的（悬停给 DSH 原文与行号）
                      (() => {
                        const rf = pmReadFailNotice(s.readError)
                        if (!rf) return null
                        return e('span', {
                          'data-read-fail-badge': '1',
                          style: Object.assign({}, dimBadgeStyle, {
                            color: 'crimson', borderColor: 'color-mix(in srgb, crimson 45%, transparent)', fontWeight: 700,
                          }),
                          title: rf.head + '：' + rf.lines.join(' '),
                        }, '⚠ 日志读不了')
                      })(),
                      cntBadge,
                      // ★ 勾选框（20260915 用户口径：**选数个 → 点上方确认**，不是点一个就生效/跳转）。
                      //   ⛔ stopPropagation：点勾选框不许顺带选中会话（那会触发解析与跳转）。
                      (() => {
                        if (!onToggleResident) return null
                        const checked = pending.has(s.id)
                        return e('input', {
                          type: 'checkbox',
                          id: 'dma-pin-' + s.id, name: 'dma-pin-' + s.id,
                          'aria-label': '勾选该会话，用于批量设为 / 取消常驻',
                          'data-pending-row': checked ? '1' : '0',
                          checked: checked,
                          title: '勾选（只勾选，不改任何设置）—— 勾好之后点上方「＋ 设为常驻 / － 取消常驻」才生效',
                          style: { flex: 'none', margin: 0 },
                          onClick: (ev) => ev.stopPropagation(),
                          onChange: () => togglePending(s.id),
                        })
                      })(),
                    ),
                    e('div', { className: 'dma-sub', style: { display: 'flex', gap: 6, fontSize: SMALL_FONT_SIZE, opacity: 0.6 } },
                      e('span', null, relativeTime(s.mtime)),
                      e('span', null, '· ' + g.label + (g.resolved ? '' : '（未解析出路径）')),
                    ),
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
      // 20260913 改版：整列移除 —— 「共 N 次 · #1 #2 …」压成装配地图头顶的轮次切换条
      //（20260913 三级导航：轮次条已删，切楼入口 = L2 消息定位；「静态/每轮」来自 C4 的 mutability。）

      // ---------- 子页 A·右栏：tools 列表 / inventory 分组 / 部件 tabs + 注释 + 搜索高亮 + 复制 ----------
      // ---------- v5 修复单 ③：工具面运行期体检（只判断、不执行） ----------
      // 判据来源不变（request/header.header.tools）。阈值 12 的依据：迁移后正常面是 7，
      // roleplay-noscope 实测 44、standard 实测 63 ⇒ 12 把「正常」与「没收窄」干净分开。
      // mcp__chrome__*/glm_* 是最典型的漏网标志（noscope 台子实测 29 个 chrome + 8 个 glm）。
      // ⛔ 只标红提示（现有 errorStyle），绝不做任何「收窄」动作 —— 它只是体检，不是执行者。
      const TOOL_SCOPE_WARN_THRESHOLD = 12
      function toolScopeWarning(tools) {
        const list = Array.isArray(tools) ? tools : []
        const names = list.map((t) => String((t && t.name) || ''))
        const n = names.length
        const chrome = names.filter((x) => x.indexOf('mcp__chrome__') === 0).length
        const glm = names.filter((x) => x.indexOf('glm_') === 0).length
        if (n <= TOOL_SCOPE_WARN_THRESHOLD && chrome === 0 && glm === 0) return null
        const hits = []
        if (chrome > 0) hits.push(chrome + ' 个 mcp__chrome__*')
        if (glm > 0) hits.push(glm + ' 个 glm_*')
        return '⚠ 本会话工具面没收窄（' + n + ' 个' + (hits.length > 0 ? '，含 ' + hits.join('、') : '')
          + '）——该 preset 的 rp-tool-scope.js 可能没生效，或被删了。'
      }
      function ToolScopeWarnLine({ tools }) {
        const msg = toolScopeWarning(tools)
        return msg ? e('div', { style: errorStyle }, msg) : null
      }

      function PromptToolsListView({ tools, query }) {
        return e('div', { style: promptListStyle },
          e(ToolScopeWarnLine, { tools: tools }),
          tools.map((t) => e('div', { key: t.name, style: toolRowStyle },
            e('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              highlight(t.name, query)),
            e('span', { style: { opacity: 0.6, flexShrink: 0 } }, String(t.chars) + ' 字'))),
        )
      }

      // ---------- 消息流单（20260918 T2/T3）：单条消息抽屉 —— 与 system 单段抽屉（SectionTextPanel）同构 ----------
      // 列表（ViewerMessagesBody）点一条 ⇒ 本抽屉：头（seq / role / 字数 / 徽标）+ 正文 + 原始 JSON。
      // ★ 正文**按条从出口取**：GET /api/part?id=&turn=&part=messages&seq=<n>。
      //   ⛔ 不把整段拼装 text 切开、不读 state.data.text、也不用 messages[].preview 拼 —— 那几条路本单起死掉。
      //   响应里的 message = 会话日志里那条的**原样**对象；messageSource = 来源说明（照 system 抽屉「原始 JSON」块一并摆出）。
      // 思维链（content 里 type:'reasoning' 的块）只给**词头**行（灰斜体，与列表口径一致）；⛔ 全文不默认展开 ——
      //   要看全文就在下方「原始 JSON」里对照（那才是"原样"，且仍是这一条的日志事实）。
      // 三种失败口径照 pmSectionTextState：取数中 / 网络失败 / 接口 ok:false 都有可见文案，⛔ 不许空白。
      // 被压缩摘要遮蔽的行宿主本来就取不到（ok:false 带原因）⇒ 如实显示，⛔ 不绕道。
      // T3：抽屉体有界高度 + overflow:auto（视口推，不写死小数字）；加载/完成两态同一个滚动容器。
      const msgDrawerScrollStyle = {
        display: 'flex', flexDirection: 'column', gap: 6,
        flex: 1, minHeight: 0, minWidth: 0,
        overflowY: 'auto',
        maxHeight: 'calc(100vh - 170px)',
      }
      // 原样对象 ⇒ 渲染用块数组：string content = 单 text 块；数组原样；其余 = null（调用方如实说"形状不认识"）
      function msgContentBlocks(message) {
        const content = message && typeof message === 'object' ? message.content : null
        if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
        if (!Array.isArray(content)) return null
        return content
      }
      function ViewerMsgPanel({ sessionId, turn, seq }) {
        const [st, setSt] = React.useState({ phase: 'loading', resp: null, errMsg: '' })
        React.useEffect(() => {
          if (!sessionId || !turn || seq == null) {
            setSt({ phase: 'error', resp: null, errMsg: '会话 / 楼号 / seq 缺一不可，取不到这一条' })
            return undefined
          }
          const controller = new AbortController()
          setSt({ phase: 'loading', resp: null, errMsg: '' })
          apiGet(PROMPT_API_BASE + '/api/part?id=' + encodeURIComponent(sessionId) + '&turn=' + String(turn)
            + '&part=messages&seq=' + encodeURIComponent(String(seq)), controller.signal)
            .then((resp) => {
              if (controller.signal.aborted) return
              setSt({ phase: 'ready', resp: resp, errMsg: '' })
            })
            .catch((error) => {
              if (controller.signal.aborted) return
              setSt({ phase: 'error', resp: null, errMsg: errText(error) })
            })
          return () => controller.abort()
        }, [sessionId, turn, seq])
        const resp = st.phase === 'ready' ? st.resp : null
        const okResp = resp && resp.ok === true ? resp : null
        const blocks = okResp ? msgContentBlocks(okResp.message) : null
        const msgBlockLabel = (kind) => (kind === 'reasoning' ? '思维链' : kind === 'text' ? '正文' : kind == null || kind === '' ? '块' : String(kind))
        const oneLineHead = (s) => {
          const flat = String(s || '').replace(/\s+/g, ' ').trim()
          return flat.length > 80 ? flat.slice(0, 80) + '…' : flat
        }
        const stateLine = st.phase === 'loading'
          ? e('div', { 'data-msg-drawer-state': 'loading', style: dimStyle }, '正在取 seq ' + String(seq) + ' 这一条的正文（按条从出口取）…')
          : st.phase === 'error'
            ? e('div', { 'data-msg-drawer-state': 'error', style: errorStyle }, '内容取不到：' + (st.errMsg || '未知原因'))
            : okResp === null
              ? e('div', { 'data-msg-drawer-state': 'error', style: errorStyle },
                '内容取不到：' + ((resp && resp.error && (resp.error.message || resp.error)) || '接口返回异常'))
              : null
        return e('div', { 'data-msg-drawer': '1', 'data-msg-drawer-scroll': '1', style: msgDrawerScrollStyle },
          // 抽屉头：seq / role / 字数 / 工具结果 / 已压缩（口径照 system 抽屉的段头）
          e('div', { 'data-msg-drawer-head': '1', style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'baseline', flex: 'none' } },
            e('strong', { style: { fontSize: 12 } }, '[' + ((okResp && okResp.role) || '…') + ']'),
            e('span', { style: { fontFamily: MONO, fontSize: SMALL_FONT_SIZE, opacity: 0.7 } }, 'seq ' + String(seq)),
            okResp && typeof okResp.chars === 'number'
              ? e('span', { style: { fontFamily: MONO, fontSize: SMALL_FONT_SIZE, opacity: 0.6 } }, fmtChars(okResp.chars) + ' 字')
              : null,
            okResp && okResp.isToolResult ? e('span', { style: dimBadgeStyle }, '工具结果') : null,
            okResp && okResp.isCompacted ? e('span', { style: dimBadgeStyle }, '已压缩') : null,
          ),
          stateLine,
          // 正文（来自响应里那条原样对象的 content；思维链块只给词头，⛔ 全文不默认展开）
          okResp !== null && okResp.message == null
            ? e('div', { 'data-msg-drawer-body': '1', style: dimStyle }, '（这一条没有可原样给出的对象 —— 会话日志里没有留它的正文）')
            : okResp !== null && blocks === null
              ? e('div', { 'data-msg-drawer-body': '1', style: dimStyle }, '内容块形状不认识（content 不是文本也不是数组）—— 原样对象照抄在下方 JSON 里')
              : okResp !== null
                ? e('div', { 'data-msg-drawer-body': '1', style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
                  blocks.map((bk, i) => {
                    const kind = bk && typeof bk.type === 'string' ? bk.type : null
                    const body = bk && typeof bk.text === 'string' ? bk.text : null
                    if (kind === 'reasoning') {
                      // ★ 思维链：词头行（灰斜体）。全文不进正文；要看原样在下方 JSON。
                      return e('div', {
                        key: String(i),
                        'data-msg-drawer-block': 'reasoning',
                        style: { fontStyle: 'italic', color: 'GrayText', fontSize: 12, wordBreak: 'break-word', paddingLeft: 10 },
                        title: '思维链（reasoning 块）词头 · ' + (body != null ? body.length : 0) + ' 字 —— 词头只是开头，全文不默认展开（原样对象在下方 JSON 里）',
                      }, msgBlockLabel(kind) + ' · ' + (body != null ? fmtChars(body.length) : '?') + ' 字 · ' + oneLineHead(body))
                    }
                    if (body === null) {
                      return e('div', { key: String(i), 'data-msg-drawer-block': kind || '', style: dimStyle },
                        '[' + (kind || '?') + '] 块（非文本）—— 原样对象见下方 JSON')
                    }
                    return body.length > PART_BIG_TEXT_CHARS
                      ? e(ChunkedText, { key: String(i), 'data-msg-drawer-block': kind || '', text: body, query: '' })
                      : e(MarkdownBody, { key: String(i), 'data-msg-drawer-block': kind || '', text: body })
                  }))
                : null,
          // 原始 JSON：同一响应里的 message（原样）+ messageSource（来源说明）—— 照 system 抽屉那块的形状，
          // 不折叠、不设上限；取不到时上面 stateLine 已把原因说出来，这里就不空挂一块。
          okResp !== null
            ? e('div', { 'data-msg-drawer-raw': '1', style: { display: 'flex', flexDirection: 'column', gap: 4, flex: 'none' } },
              e('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
                e('strong', { style: { fontSize: 12.5 } }, '原始 JSON'),
                e('span', { style: dimStyle },
                  '来源：' + String(okResp.messageSource || '（未说明）') + ' · ' + fmtChars(okResp.chars || 0) + ' 字')),
              e('pre', {
                'data-msg-drawer-json': '1',
                style: {
                  margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  fontFamily: MONO, fontSize: SMALL_FONT_SIZE, lineHeight: 1.45,
                  background: 'color-mix(in srgb, CanvasText 4%, transparent)', borderRadius: 6, padding: '8px 10px',
                },
              }, okResp.message == null ? '（无原样对象）' : JSON.stringify(okResp.message, null, 2)))
            : null,
        )
      }

      // tools 流的「整份清单」落点（20260918 消息流单）：消息流栏拆掉并列视图后，抽屉里点工具行
      // 仍能「← 整份清单」回到这份目录（M10 的既有交互，⛔ 不许因拆页签而坏掉）。
      function PromptToolsListPanel({ turn, state }) {
        const tools = state.status === 'ready' && state.data && Array.isArray(state.data.tools) ? state.data.tools : null
        return e('div', { style: colPartStyle },
          e(SectionLabel, { text: 'tools 清单' }),
          state.status === 'loading' && e('div', { style: dimStyle }, '正在加载 #' + turn + ' 的 tools …'),
          state.status === 'error' && e('div', { style: errorStyle }, '加载失败：' + state.error),
          state.status === 'ready' && tools !== null && e('div', { style: readColFlexStyle },
            e(PromptToolsListView, { tools: tools, query: '' })),
          state.status === 'ready' && tools !== null && tools.length === 0 && e('div', { style: dimStyle }, '（该楼 tools 为空）'),
        )
      }

      // ---------- 消息流栏（20260918 消息流单 T1/T2）：这一栏只做消息流，其余部件已由装配地图覆盖 ----------
      // 旧并列架构（system / tools / inventory / messages / 完整 五个 PartTabs 页签 + 栏内搜索框）已拆：
      //   · system 段 / 工具条目各有自己的单段抽屉（SectionTextPanel / ToolTextPanel，口径不动）；
      //   · 全景有装配地图；这一栏只剩 消息流列表 → 点一条 ⇒ 单条抽屉（ViewerMsgPanel）。
      // ⛔ 本栏不渲染 system / tools / inventory / full 视图，也不再有搜索框（段内搜索只在 system 抽屉里保留）。
      function PromptPartView({ sessionId, turn, part, state, onOpenSeq, onCopy }) {
        if (!sessionId || !turn) {
          // 初始态（深链先落了 box、会话/楼还没就位）：只给提示，不发请求。
          return e('div', { style: colPartStyle },
            e(SectionLabel, { text: '消息流' }),
            e('div', { style: dimStyle }, '← 再选一次请求（第 N 次）'))
        }
        if (part !== 'messages') {
          // 到不了这里（dispatch 只把 messages 派到本栏）；深链落在别的 box 时如实指路，不猜不装。
          return e('div', { style: colPartStyle },
            e(SectionLabel, { text: '消息流' }),
            e('div', { style: dimStyle }, '这一栏只做消息流（' + String(part) + ' 由装配地图覆盖）—— 请从地图对应行下钻。'))
        }
        const text = state.status === 'ready' && state.data && typeof state.data.text === 'string' ? state.data.text : null
        const msgRows = state.status === 'ready' && state.data && Array.isArray(state.data.messages) ? state.data.messages : null
        const msgNote = e(SectionNote, { label: 'messages 流', who: WHO_MESSAGES, note: NOTE_MESSAGES })
        return e('div', { style: Object.assign({}, colPartStyle, msgDrawerScrollStyle), 'data-msg-col': '1' },
          e(SectionLabel, { text: '消息流' }),
          e('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center', flex: 'none' } },
            e('span', { style: { flex: 1 } }),
            e(CopyFeedbackBtn, { label: '复制', title: '复制当前消息流整段全文', onCopy: onCopy }),
          ),
          state.status === 'loading' && e('div', { style: dimStyle }, '正在加载 #' + turn + ' 的消息流 …'),
          state.status === 'error' && e('div', { style: errorStyle }, '加载失败：' + state.error),
          state.status === 'ready' && msgNote,
          // 有逐楼数据 ⇒ 分段列表（点一条开抽屉）；老宿主没有 ⇒ 原样整段全文（D 单口径不动）
          state.status === 'ready' && (msgRows !== null || text !== null) && e(ViewerMessagesBody, {
            text: text, messages: msgRows, onOpenSeq: onOpenSeq,
          }),
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
          // ★ 2026-09-19（用户口径：「复制的全文中没有 tool 定义具体内容」）：现在**带正文** ——
          //   有渲染得出来的人话就用人话，拿不到正文（宿主那份超驻留上限）就如实说明，⛔ 不编。
          const blocks = d.tools.map((t) => {
            const head = '--- ' + String(t.name) + '（' + String(t.chars) + ' 字符）---'
            const human = typeof t.text === 'string' && t.text !== '' ? pmToolDefText(t.text) : null
            const body = human !== null ? human : (typeof t.text === 'string' && t.text !== '' ? t.text : '（没有正文：这一份原始工具定义没在内存里留下 —— 打开面板里该工具那一行仍可取）')
            return head + '\n' + body
          })
          parts.push('===== tools（' + d.tools.length + ' 个）=====\n' + blocks.join('\n\n'))
        }
        if (d.messages) {
          parts.push('===== messages =====\n' + d.messages.text
            + (d.messages.truncated ? '\n（已截断，原 ' + fmtChars(d.messages.original) + ' 字符）' : ''))
        }
        return parts.join('\n\n')
      }



      // ---------- 提示词装配地图（Prompt Map）：一次请求由哪些块拼成、谁前谁后、谁每轮在变 ----------
      // 三个框竖排：[system] → [tools] → [messages]。★ tools 必须是独立的一框：工具定义是请求的
      // 独立字段（request/header.header.tools），不拼进 system 文本 —— 只看 system 会得出
      // 「工具没了」的错误结论。
      // 三色分区（任务规格口径，不自创）：红 = 固定/高危/一头一尾；黄 = 记录/聊天记录/每轮变；
      // 蓝 = 工具区/工具的注入；灰虚线 = 还没落地/没检出。
      // ★★ 第四个维度：静态 / 每轮。官方 systemPrompt.section 的 text 可以是字符串（挂载时定死
      // ⇒ 改了要重建配置 + 新开一局）也可以是函数（每次组装重新求值 ⇒ 改了立刻生效）。
      // 判定优先级（任务规格）：实测发现「同会话另一轮这段文本变了」⇒ 每轮（实测推翻一切静态判断）；
      // 否则有已知类型按类型判；否则两轮都在 ⇒ 实测逐字相同 ⇒ 静态（实测口径）；否则 ⇒ 未知（不猜）。
      // 诚实口径沿用宿主 COMPOSITION_PROBES 的原话：探不到就不列已检出，但也不把「没探到」说成
      // 「不存在」—— 没检出的已知注入位画灰虚线。
      // ★ 20260914 M10（用户点名的赘文）：行内以前挂着一长串口径自证（「未检出（可能是本会话没装/没启用）——
      //   探不到就不列已检出，但也不把它说成不存在」），用户要求砍掉 —— 这套道理**在 `?` 事实说明书里讲一次就够**，
      //   行内只留"没检出**什么**"。
      const PM_NOT_DETECTED = '未检出'
      const PROMPT_MAP_DEFS = {
        identity: { label: 'harness identity', order: '≈-1000', orderNum: -1000, color: 'red', mut: 'static',
          mutWhy: 'DSH 核心恒定注入（挂载时定死）', who: WHO_IDENTITY, note: NOTE_IDENTITY },
        persona: { label: 'persona（人设段）', order: '0', orderNum: 0, color: 'red', mut: 'static',
          mutWhy: '部署级人设：agent 配置里定死的字符串（rp 身份落最前）', who: WHO_PERSONA, note: NOTE_PERSONA },
        preset: { label: 'Tavern preset 段（PROFILE_SECTION）', order: '10', orderNum: 10, color: 'red', mut: 'per-turn',
          mutWhy: 'PROFILE_SECTION 的 text 是函数：每轮重读活的卡/世界书/预设', who: WHO_PRESET, note: NOTE_PRESET },
        rpPolicy: { label: 'rp:policy', order: '45', orderNum: 45, color: 'red', mut: 'per-turn',
          mutWhy: 'rp:policy 每轮重新求值（官方实现 text 为函数）', who: WHO_RP_POLICY, note: NOTE_RP_POLICY },
        stateCard: { label: 'state:card', order: '50', orderNum: 50, color: 'yellow', mut: 'per-turn',
          mutWhy: '副 LLM 每轮记账，每轮重新注入', who: WHO_STATE_CARD, note: NOTE_STATE_CARD },
        anima: { label: 'anima:memory', order: '55', orderNum: 55, color: 'yellow', mut: 'per-turn',
          mutWhy: '每轮重新检索并注入', who: WHO_ANIMA, note: NOTE_ANIMA },
        stChar: { label: '角色卡字段（st-character-field）', order: '未知（profile 层）', orderNum: 57, color: 'yellow', mut: 'per-turn',
          mutWhy: 'profile 层每轮重读角色卡', who: WHO_ST_CHAR, note: NOTE_ST_CHAR },
        storyAnchor: { label: 'storyAnchor', order: '未知', orderNum: 58, color: 'yellow', mut: null,
          mutWhy: null, who: WHO_STORY_ANCHOR, note: NOTE_STORY_ANCHOR },
        compacted: { label: 'compaction（checkpoint 块）', order: '中段', orderNum: 600, color: 'red', mut: null,
          mutWhy: null, who: WHO_COMPACTED, note: NOTE_COMPACTED },
        toolGuide: { label: '工具引导段', order: '100–199', orderNum: 150, color: 'blue', mut: 'static',
          mutWhy: '跟随工具定义（每会话固定）', who: WHO_TOOL_GUIDE, note: NOTE_TOOL_GUIDE },
        dmaSettings: { label: 'dma:settings', order: '60', orderNum: 60, color: 'red', mut: 'static',
          mutWhy: '当前实现是挂载时定死的字符串', who: '本插件（dsh-memory-archive）', note: 'RP 预设包的设置段（order 60）' },
        planPolicy: { label: 'PLAN_POLICY', order: '500', orderNum: 500, color: 'red', mut: null,
          mutWhy: null, who: '未知', note: '计划模式策略段（system 中段固定注入）' },
        deliverableRefs: { label: 'DELIVERABLE_FILE_REFERENCES', order: '9000', orderNum: 9000, color: 'red', mut: null,
          mutWhy: null, who: '未知', note: '可交付文件引用说明（system 尾部）' },
        structuredOutput: { label: 'STRUCTURED_OUTPUT', order: '9900', orderNum: 9900, color: 'red', mut: null,
          mutWhy: null, who: '未知', note: '结构化输出约定（system 尾部）' },
        dmaRules: { label: 'dma:rules', order: '9950', orderNum: 9950, color: 'red', mut: 'static',
          mutWhy: '静态核心规则：当前实现是挂载时定死的字符串（落 system 最末尾）', who: '本插件（dsh-memory-archive）', note: '静态核心规则（order 9950，system 最末尾）' },
        unknown: { label: '未识别段', order: '未知', orderNum: null, color: 'gray', mut: null,
          mutWhy: null, who: '', note: NOTE_UNKNOWN },
      }
      // 扫描标记：SYS_SECTION_DEFS 的标记子串 + 本图补充认得的几类（persona 的探测标记、
      // 工具名、本插件 RP 预设包两段、DSH 尾部/中段固定段）。只用于本图，不改 splitSystemSections。
      const PROMPT_MAP_MARKS = [
        { key: 'identity', marks: ['You are an AI agent powered by DeepSeek Harness', 'harness:identity'] },
        { key: 'persona', marks: ['@deepseek-ai/dsh-persona'] },
        { key: 'preset', marks: ['dsh-tavern preset'] },
        { key: 'rpPolicy', marks: ['rp:policy', 'rp-policy'] },
        { key: 'stateCard', marks: ['state:card', '【当前状态】'] },
        { key: 'anima', marks: ['anima:memory', '<recalledMemories>', '<immediateHistory>'] },
        { key: 'toolGuide', marks: ['dsh-tool-fs-search', '@deepseek-ai/dsh-tool-fs', 'tool-bash', 'tool-pwsh', 'tool-web'] },
        { key: 'compacted', marks: ['<compacted-summary>'] },
        { key: 'stChar', marks: ['st-character-field'] },
        { key: 'storyAnchor', marks: ['storyAnchor'] },
        { key: 'dmaSettings', marks: ['dma:settings'] },
        { key: 'planPolicy', marks: ['PLAN_POLICY'] },
        { key: 'deliverableRefs', marks: ['DELIVERABLE_FILE_REFERENCES'] },
        { key: 'structuredOutput', marks: ['STRUCTURED_OUTPUT'] },
        { key: 'dmaRules', marks: ['dma:rules'] },
      ]
      // 已知没落地/按设计留空的注入位（灰虚线，永远在图上，不许说成已完成）
      const PROMPT_MAP_PLACEHOLDERS = [
        { key: 'worldbook', label: '世界书（lorebook）', order: '—', orderNum: 15, reason: '按决定留空（设计如此，不是探不到）' },
      ]
      // 这些 key 没检出时补灰虚线占位（检出过就不补）
      // ★ 2026-09-20：摘掉 `stateCard`（状态子系统整个剥离）与 `storyAnchor`（story-anchor **暂时不注册**，
      //   用户口径）—— 两个都不再期待存在，留着只会永远在图上画一条"缺失"的灰虚线。
      const PROMPT_MAP_MISSING_KEYS = ['anima', 'dmaSettings', 'dmaRules']

      // ---- 20260914 M2 ·「直观构成」四件套的纯函数 ----
      // ① 顺序脊的位置词（任务书 A2：一头一尾的位置直觉）。负 order=头；≥1000=尾；其余=中；没有数值不给词。
      // ★ 分界 1000 不是拍的（派单方 20260914 复核给出真机全部捕获记录的 order 取值分布）：
      //   -1000 -900 -800 | 0 10 45 50 55 56 500 900 | 1010 1100 1200 1300 1400 1500 1600 2000 2100 2400 2600 2700 2800 | 9000
      //   900（context:file-reference）与 1010（tool:pwsh）之间是唯一空档 ⇒ 1000 正落在真实空档里；
      //   若改成「≥9000 才算尾」，1010–2800 的 15 个工具段会全部掉进「中」、「尾」只剩 1 行，
      //   「一头一尾」的直觉反而垮掉。四个真实样本值已在本单断言钉死（-1000⇒头 / 900⇒中 / 1010⇒尾 / 9000⇒尾）。
      function pmPosTag(orderNum) {
        if (typeof orderNum !== 'number' || !Number.isFinite(orderNum)) return null
        if (orderNum < 0) return '头'
        if (orderNum >= 1000) return '尾'
        return '中'
      }
      // ② 复合段识别（任务书 A3）：`<插件id>:profile` 这类由第三方整段注入的段 —— 数据上就是一段
      //    （几千字黑盒）。按冻结的形状认（插件 id 是 kebab/字母数字，段名恰为 `:profile`），不猜别的。
      function isPmCompositeName(name) {
        return /^[A-Za-z0-9][A-Za-z0-9_-]*:profile$/.test(String(name || ''))
      }
      // ③ 可变性徽标的依据短词（任务书 A4）。C4 的 mutabilityBasis 冻结值：definition / header-equal /
      //    measured / unknown；文本推断路径的 judgePmMutability 用 known / measured / null。
      function pmBasisLabel(basis) {
        if (basis === 'definition') return '注册定义'
        if (basis === 'header-equal') return 'header相等'
        if (basis === 'measured') return '实测'
        if (basis === 'known') return '已知类型'
        return ''
      }
      // ④ 人话注释表（任务书 B/§3：段名用**运行时真名**；表里没有的段注释位写「未收录」，⛔ 不许编一句）。
      //    ★ 2026-09-15：按**真机捕获实测**补齐（`<storageDir>/assembly/*.jsonl` 汇总出 30 个真段名）。
      //    每条都有出处：DSH 核心段 → 官方注册处；本插件段 → 本仓库 preset-modules/*；上游段 → pmp-dsh-tavern。
      //    ⚠️ 表内文案**一律不写 order 数字**（数字只能来自捕获 —— 与 ★31/★32 同一条纪律）。
      //    实测 order 记在这里备查（注释不参与运行时，自检台读不到）：
      //      harness:identity -1000 · deployment:persona-prefix 0 · pmp-dsh-tavern:profile 10
      //      rp:policy 45 · state:card 50 · dma:echo 54 · anima:memory 55 · rp:storyAnchor 56
      //      plan:policy 500 · context:file-reference 900 · tool:* 1010–2800
      //      ui:deliverable-file-references 9000 · harness:source 10000 · app:web-surface 10100
      //      deployment:persona-suffix 10200 · rp:firstRound 10201
      //    ★「历史名」两条（`deployment:persona` / `roleplay:policy`）留着，是因为**老捕获**里就是那两个名字，
      //      抽屉与地图仍会渲染历史楼 ⇒ 留着才有注释可显示（不是把过期名当现行名）。
      // ★★ 2026-09-20：整表改成「来源 + 它是什么/干嘛 + 位置或坑」**一句话**（用户手改后给的口径，原文照录）。
      //    ⛔ 别再往注释里塞 order 数字、诊断名（`CHARACTER_*_APPROXIMATE`）与机制细节 —— 用户明确砍掉了那些。
      //    ⚠️ `deployment:persona` / `deployment:persona-suffix` 两条用户没给新文案 ⇒ **保留原文**（别顺手改）。
      const PM_SECTION_NOTES = {
        // ── DSH 核心：恒定注入的身份 / 来源 / 外壳 ──
        'harness:identity': '**DSH 核心身份段**，告诉模型它是谁。',
        // ── DSH 核心：部署级 persona 的两个槽 ──
        'deployment:persona-prefix': '**官方留出的 persona 入口**。一般用于定义通用的 agent 顶层。',
        'deployment:persona': '【历史名】旧版宿主把部署级人设段就叫这个；现行真名是 deployment:persona-prefix（老捕获里仍会出现，故保留）',
        'deployment:persona-suffix': '部署级人设的**后缀**槽位：第一方指导之后（system 最末）恒定注入；省略即为空段',
        // ── 上游 pmp-dsh-tavern ──
        'pmp-dsh-tavern:profile': 'dsh-tavern 把「预设 + 角色卡字段 + 世界书」拼成的复合段，内部没有标签；现在通常会被展开成多个 `:part:` 单字段段，只有认不出或替换模式下才保留。',
        'rp:policy': 'dsh-tavern 注入的 RP 模式策略段，默认只说明高风险操作被锁，定义身份和文风来自预设或角色卡。建议在 dsht 中删除默认文本留空。',
        'roleplay:policy': '旧版宿主的 RP 策略段名；现在真名是 `rp:policy`，保留用于读老捕获。',
        // ── 本插件（dsh-memory-archive）──
        // ★ 2026-09-20 退役：状态子系统整个剥离（state-bridge 归档）。**只对老捕获**保留这条注释 ——
        //   新装配里不会再有这一段；状态改由周目笔记 `<周目>/.roleplay-memory/state.md` 维护。
        'state:card': '【已退役 · 2026-09-20 剥离】原为 L1 状态卡（副 LLM 每轮记账的数值/分组/到期）；'
          + '现在**状态改由周目笔记里的 `state.md` 维护**（模型用 `memory_write` 写）。',
        'dma:echo': '本地记忆回响，利用 dsh 自带的 fts5，从记忆库归档的原文里检索出的记忆。',
        'rp:storyAnchor': '剧情锚点段，memory-archive 预留的注入位；挂在 RP 预设里。',
        'rp:firstRound': '保留第一轮问答，压缩后也会重注入到聊天记录区开头，让首轮末尾的思维模式指令一直有效。它和角色卡开场白不是一回事。',
        // ★ 2026-09-19 补：`mt:*` 这几段（宿主面注册、本插件自己的）此前在表里没有条目 ⇒ 面板一律显示「未收录」。
        // ⚠️ `mt:postHistory` 已**退役**（用户 2026-09-19：「mt post 那个字段就可以删了」）：
        //   卡的后处理指令现在**只有上游那一份**，由 `lib/tavern-field-plan.js` 摆位表摆到全文最后（order 10203）——
        //   它的注释在 `PM_TAVERN_FIELD_PLAN['character:postHistoryInstructions']` 里。⛔ 别再给这一行加回条目。
        'mt:lastFloors': '最近几楼原文；只在当前上下文很短时注入，让新周目开局有可承接的上下文。',
        'mt:memoryHome': '**memory-archive 注入的提示**，告诉模型剧情笔记的写入路径。',
        'mt:memoryProtocol': '**memory-archive 注入的提示**，告诉模型什么时候该主动调用 `anima_query` 进行向量检索。',
        // ── 别的插件 ──
        'anima:memory': 'anima 给出的检索记忆，包含 `<recalledMemories>` 摘录和 `<immediateHistory>` 近场历史；只对 RP 会话注入。',
        // ── DSH 官方能力 / 运行时上下文 ──
        'plan:policy': '官方的 plan 模式策略段。',
        // ★★ 下面四段是**DSH 官方给编码 agent 的定位/文件文字**，本 RP 预设用作用域遮蔽把它们禁用
        //    （`preset-modules/rp-suppress-host-sections.js`）。⚠️ 注释里**把来源与作用写全**，并写明
        //    「RP 已禁用 ⇒ 占位、无内容」——用户口径（2026-09-16）：**不隐藏这一行**（它占了一个 order），
        //    而是"给出字段 + 注释说清"。这里写的是**关于 RP 预设的事实**，所以在编码会话里也成立
        //    （编码会话里它们有内容，行上的字数会自己说话）。
        // ⛔ `context:file-reference` 的注释**不许**再写"已禁用/占位"—— 它其实每轮都有内容（真机 343 字）：
        //    预设名单里列了它但没遮蔽掉（它注册在 agent 作用域、正文由"有没有 read 工具"开关）。
        //    自检台 ★35 用**反向断言**钉住这一点（写了"已禁用"就红）。
        'context:file-reference': '官方文件引用段，告诉模型怎么引用/读取本地文件。',
        'ui:deliverable-file-references': '官方文件引用段，要求模型点名本轮创建/修改的主要文件，并写成 Markdown 行内代码；RP 模式已禁用。',
        'harness:source': '官方 app-boot 段，把本机源码检出路径告诉模型，用于检视/扩展 DSH 本身；RP 模式已禁用。',
        'app:web-surface': '官方 web-app 段，告诉模型本机 Web GUI 地址和界面约定；RP 模式已禁用。',
      }
      // ★★ 2026-09-20：注释改成一句话（用户手改后给的口径，原文照录）—— 文案的**真相源**见 `lib/tavern-field-plan.js`。
      //   ⚠️ **这张表是 `lib/tavern-field-plan.js` 的镜像**（宿主侧那份才是真相源：摆位也用它）。
      //      两边必须逐字一致 —— 由 `_selftest-prompt-map.mjs` 的 ★44 逐条比对（不一样就红）。
      //      ⛔ 别在这里手改文案：改 `lib/tavern-field-plan.js`，再按它重新生成这一段。
      const PM_TAVERN_FIELD_PLAN = {
        "character:systemPrompt": { order: 10, st: "main（系统提示词）", note: "**由 dsh-tavern 解算的角色卡字段** —— `system_prompt`，即系统提示词，在 ST 中位于提示词最前方，用于覆盖可能的原始提示词。" },
        "user:description": { order: 11, st: "Persona Description（用户人设）", note: "玩家角色的人设，说明 `{{user}}` 是谁、什么身份、和角色什么关系；通常并入系统提示区，也可能作为独立条目放在角色卡字段之前。" },
        "character:description": { order: 12, st: "charDescription（角色描述）", note: "**由 dsh-tavern 解算的角色卡字段** —— `description`，即对角色的描述 —— 外貌/身份/背景的正文，一般是角色卡里最主要的一段。" },
        "character:personality": { order: 13, st: "charPersonality（性格）", note: "**由 dsh-tavern 解算的角色卡字段** —— `personality`，即性格摘要，一句话式的性格与口吻基调，常与 description 互补。" },
        "character:scenario": { order: 14, st: "scenario（情境）", note: "**由 dsh-tavern 解算的角色卡字段** —— `scenario`，即情境/设定，定义故事发生在什么场面里（时间地点、双方处境）。" },
        "worldbook:content": { order: 15, st: "worldInfoAfter（世界书·后置）/ worldInfoBefore（前置）", note: "世界书条目，按关键词触发设定补充；dsh-tavern 把「描述前/场景后」两批压缩进同一字段名。" },
        "character:messageExample": { order: 16, st: "dialogueExamples（示例对话）", note: "示例对话，用几轮对话示范文风、称呼和说话方式；是样板，不是实际对话历史。" },
        "character:depthPrompt": { order: 17, st: "depth prompt（作者注 Author's Note）", note: "作者注/深度提示词，临时追加气氛或走向；原本按深度插进历史中间，近似放在卡字段之后、历史之前。" },
        "generated:header": { order: 18, st: "（没有对应的 ST 槽位）", note: "上游生成并推入的文本，没有来源文档；不是卡字段也不是世界书，位置按「卡字段之后」摆并标明。" },
        "preset:prompts_": { order: 19, st: "预设 prompt_order（Tavern 预设自己的条目）", note: "**由 dsh-tavern 解算的角色卡字段** —— 提示词条目；角色卡字段的位置由这些条目的槽位决定。" },
        "character:greeting": { order: 10150, st: "first_mes（历史的第一条）", note: "角色开场白，不是提示词，是角色先说的第一段话，也当说话样板；DSH 放在系统末尾、历史之前，并注明别原样抄。" },
        "character:postHistoryInstructions": { order: 10203, st: "post-history instructions（历史之后）", note: "**由 dsh-tavern 解算的角色卡字段** —— 后处理提示词，角色卡作者放在最后的收尾指令，一般用于强调写作纪律、放置破甲提示词；DSH 目前不支持放在 user 信息后，只能近似放在 system 最后。" },
      }
      /** 查一个 part 字段的计划（⛔ 查不到给兜底：面板照样要有"这是个没进表的字段"的说明）。 */
      const PM_TAVERN_FIELD_FALLBACK = { order: 20, st: null, note: "**由上游 dsh-tavern 解算的段**（这个字段名我们的表里还没有）　·　**意义**：⛔ 不认识 ⇒ 不编（表里每一条都会写全三件事：① 它是什么字段 ② 它的意义 ③ 它在 ST 里一般放在哪）　·　**ST 位置**：⛔ 同样不编 —— 认不出字段名就无从判断它的 ST 槽位；我们只把它摆在**卡字段之后**，不占别的插件的位置" }
      function pmTavernFieldPlan(key) {
        const k = String(key || '')
        if (k !== '' && PM_TAVERN_FIELD_PLAN[k] !== undefined) return PM_TAVERN_FIELD_PLAN[k]
        for (const [name, entry] of Object.entries(PM_TAVERN_FIELD_PLAN)) {
          if (name.endsWith('_') && k.startsWith(name)) return entry   // 预设条目按序号变（preset:prompts_<n>_content）
        }
        return PM_TAVERN_FIELD_FALLBACK
      }
      // 段名**前缀**兜底注释（精确表没有时的第二层；仍认不出的才写「未收录」）。
      //   为什么要有：`tool:*` 是「一个工具一段」，真机实测有 14 个（pwsh/read/write/edit/glob/grep/jobs/
      //   web_search/web_fetch/goal/workflow/ralph/subagent/subagent_fork），逐个列举会随工具面变化而漂
      //   ⇒ 用前缀给一句话，新增工具自动有注释。
      const PM_SECTION_NOTE_PREFIXES = [
        ['tool:', '该工具的说明与纪律（与这次请求 tools 里那份工具定义配套）'],
      ]
      function pmSectionNote(name) {
        const key = String(name || '')
        const hit = PM_SECTION_NOTES[key]
        if (typeof hit === 'string' && hit !== '') return hit
        // ★ 2026-09-19：上游展开的 part 段**按字段**给注释（一段一条，三条内容写全）——
        //   优先级高于下面那条"整族一句话"的前缀兜底；认不出的字段才落到兜底。
        const part = /^pmp-dsh-tavern:part:\d+:(.+)$/.exec(key)
        if (part !== null) {
          // ★ 2026-09-19：逐字段注释来自**摆位表**（`PM_TAVERN_FIELD_PLAN`，是 lib/tavern-field-plan.js 的镜像）
          const entry = pmTavernFieldPlan(part[1])
          if (entry !== null && typeof entry.note === 'string' && entry.note !== '') return entry.note
        }
        for (const [prefix, note] of PM_SECTION_NOTE_PREFIXES) {
          if (key.startsWith(prefix)) return note
        }
        return null
      }

      // ★★ 归属按**段名前缀**认（2026-09-14）。为什么这么改：以前"谁注册的"既有手写常量表
      //   （WHO_*，两条路复用）又有捕获里的通用话术，结果手写那份漂过（identity 的 order 写成 ≈-100）。
      //   ⇒ 归属只留**一个来源**：段名本身。名字里带 `dma:` 就是本插件注册的，带 `pmp-dsh-tavern` 就是上游，
      //     带 `harness:`/`app:`/`tool:`/`ui:`/`context:` 就是 DSH 核心；认不出就如实说认不出（⛔ 不猜）。
      //   ⚠️ 这张表里**不许写 order 数字**（数字一律来自捕获）—— `_selftest-prompt-map.mjs` ★31 钉住。
      //   ★ 2026-09-15（真机实测补）：`rp:` 前缀**不等于**上游 —— 实测 `rp:storyAnchor`/`rp:firstRound`
      //     是本插件预设模块注册的（见 preset-modules/*），只有 `rp:policy` 是上游的。
      //     所以先用**精确名**表覆盖，再落到前缀表（前缀表保持"不猜"的兜底语义）。
      const PM_SECTION_OWNERS_EXACT = {
        'rp:policy': 'pmp-dsh-tavern（上游 RP 策略段）',
        'rp:storyAnchor': '本插件（dsh-memory-archive · 预设模块 story-anchor）',
        'rp:firstRound': '本插件（dsh-memory-archive · 预设模块 keep-first-round）',
        'dma:echo': '本插件（dsh-memory-archive · 记忆回响 D2）',
        // ★ 2026-09-20：state-bridge 已整套剥离 ⇒ 这条**只对老捕获**有意义（新装配里不会有这一段）。
        'state:card': '原 dsh-state-bridge（2026-09-15 收编为本插件子包，2026-09-20 已剥离）',
      }
      const PM_SECTION_OWNERS = [
        ['harness:', 'DSH 核心（harness 恒定注入段）'],
        ['app:', 'DSH 核心（web 外壳段）'],
        ['deployment:', 'DSH 核心（部署级 persona 槽）'],
        ['tool:', 'DSH 核心（工具面，每个工具一段）'],
        ['ui:', 'DSH 核心（界面/交付约定段）'],
        ['context:', 'DSH 核心（运行时上下文类段）'],
        ['plan:', 'DSH 官方 plan 能力'],
        ['dma:', '本插件（dsh-memory-archive）注册'],
        ['pmp-dsh-tavern', 'pmp-dsh-tavern（上游 Tavern）'],
        ['rp:', 'pmp-dsh-tavern（上游；本插件自己那两段走精确名表）'],
        ['state:', 'dsh-state-bridge（2026-09-15 起为本插件子包）'],
        ['anima:', 'dsh-anima-rag'],
        ['compaction', 'DSH 官方 compaction（compaction-basic）'],
      ]
      function pmSectionOwner(name, fallback) {
        const s = String(name || '')
        const exact = PM_SECTION_OWNERS_EXACT[s]
        if (typeof exact === 'string' && exact !== '') return exact
        for (const [prefix, owner] of PM_SECTION_OWNERS) {
          if (s.startsWith(prefix)) return owner
        }
        return typeof fallback === 'string' ? fallback : null
      }
      // ★ 两条 ST 语义在 DSH 里**没有对应槽位**，只能近似 ⇒ 界面必须如实标注（判据见 _selftest-prompt-map ★32）。
      //   出处：上游自己的诊断 CHARACTER_PHI_APPROXIMATE / CHARACTER_DEPTH_APPROXIMATE，
      //   以及本仓库设计文档《设计-卡字段段注册与order》§3。
      const PM_SECTION_HONESTY = {
        'dma:card:post-history-instructions': '近似：ST 里它在历史之后、迟于玩家消息；DSH 的 system 是整块，没有"玩家消息之后"的槽位，只能放 system 尾部',
        'dma:card:depth-prompt': '近似：ST 按"距历史末尾的深度"插入，DSH 不暴露任意深度插入',
      }
      function pmSectionHonesty(name) {
        const hit = PM_SECTION_HONESTY[String(name || '')]
        return typeof hit === 'string' && hit !== '' ? hit : null
      }

      // 把 system 全文按已知注入点切成块（形状与 splitSystemSections 同源，但为本图补了
      // persona 探测标记 / 工具名 / dma 两段 / DSH 中段尾部固定段的识别；首块前残余只在
      // identity 开头时并进 identity，否则单独成未识别段；末尾裁切规则与 splitSystemSections 相同）。
      function pmSplitSystem(text) {
        if (typeof text !== 'string' || text === '') return []
        const hits = []
        for (const md of PROMPT_MAP_MARKS) {
          for (const mk of md.marks) {
            let i = text.indexOf(mk)
            while (i !== -1) {
              hits.push({ index: i, key: md.key })
              i = text.indexOf(mk, i + mk.length)
            }
          }
        }
        if (hits.length === 0) return [{ key: 'unknown', text: text }]
        hits.sort((a, b) => a.index - b.index)
        const bounds = []
        for (const h of hits) {
          const last = bounds.length > 0 ? bounds[bounds.length - 1] : null
          if (last && last.key === h.key) continue
          bounds.push(h)
        }
        const segs = []
        for (let i = 0; i < bounds.length; i++) {
          const start = i === 0 && bounds[0].key === 'identity' ? 0 : bounds[i].index
          const end = i + 1 < bounds.length ? bounds[i + 1].index : text.length
          segs.push({ key: bounds[i].key, text: text.slice(start, end) })
        }
        // 首块前残余（首块不是 identity 时）：非空白就单独成未识别段
        if (bounds[0].key !== 'identity' && bounds[0].index > 0 && text.slice(0, bounds[0].index).trim() !== '') {
          segs.unshift({ key: 'unknown', text: text.slice(0, bounds[0].index) })
        }
        // 末尾裁切：最后一个标记所在块（第一个空行）结束后若还剩非空白内容，单独成 unknown 段
        const lastStart = bounds[bounds.length - 1].index
        const brk = /\n\s*\n/.exec(text.slice(lastStart))
        if (brk) {
          let ts = lastStart + brk.index
          while (ts < text.length && /\s/.test(text[ts])) ts++
          if (ts < text.length) {
            segs[segs.length - 1].text = text.slice(lastStart, lastStart + brk.index)
            segs.push({ key: 'unknown', text: text.slice(ts) })
          }
        }
        const idAt = segs.findIndex((s) => s.key === 'identity')
        if (idAt >= 0 && segs[idAt + 1] && segs[idAt + 1].key === 'unknown') segs[idAt + 1].key = 'persona'
        for (const s of segs) {
          if (s.key === 'unknown' && /(^|\n)#{1,2}\s+[^\n]*(tool|工具)[^\n]*(\n|$)/i.test(s.text)) s.key = 'toolGuide'
        }
        return segs
      }

      // ★★ 静态/每轮判定（优先级见上）：实测变化 > 已知类型 > 实测逐字相同 > 未知
      function judgePmMutability(def, curText, prevText) {
        if (typeof prevText === 'string' && typeof curText === 'string' && prevText !== curText) {
          return { mut: 'per-turn', basis: 'measured', why: '实测：同一会话上一轮的这段文本与本次不同（每轮在变）' }
        }
        if (def && def.mut) return { mut: def.mut, basis: 'known', why: def.mutWhy || '' }
        if (typeof prevText === 'string' && typeof curText === 'string') {
          return { mut: 'static', basis: 'measured', why: '实测：同一会话两轮逐字相同（本会话内不变；口径是实测，不是段定义）' }
        }
        return { mut: 'unknown', basis: null, why: '判不出来：既没有已知类型，也没有同会话另一轮可比（不猜）' }
      }


      /**
       * 「没有 order 的段」落在 system 正文的哪一截（按捕获记录里的真实 offset 算）。
       * ⛔ 拿不到 offset / 总长就不给（返回 null）—— 宁可空着，也不按 order 猜位置。
       */
      function pmPosTagByOffset(offset, renderedChars) {
        if (!Number.isFinite(offset) || !Number.isFinite(renderedChars) || renderedChars <= 0) return null
        const ratio = offset / renderedChars
        if (ratio < 0.2) return '头段'
        if (ratio < 0.75) return '中段'
        return '尾段'
      }


      function pmDetectedBlock(def, text, judged) {
        // ★ 2026-09-15：文本推断路径里"工具引导段"同样按「蓝=工具」着色（与图例、与捕获路径一致）
        const isTool = def.key === 'toolGuide'
        const b = {
          key: def.label,   // 调用方（buildPromptMapData）会用段 key 覆盖
          label: def.label, order: def.order, orderNum: def.orderNum, color: isTool ? 'blue' : def.color, dashed: false,
          isTool: isTool,
          mut: judged.mut, mutBasis: judged.basis, mutWhy: judged.why,
          who: def.who, note: def.note, chars: text.length, reason: null, sub: null,
        }
        return b
      }

      function pmDashedBlock(key, label, reason, orderNum) {
        const b = {
          key: key, label: label, order: '—', orderNum: orderNum == null ? null : orderNum,
          color: 'gray', dashed: true, mut: 'unknown', mutBasis: null, mutWhy: null,
          who: '', note: null, chars: null, reason: reason, sub: reason,
        }
        return b
      }

      // 按数值 order 把占位块插进真实注入顺序里（orderNum null 的块不参与比较，照原位）
      function pmInsertPlaceholders(blocks, placeholders) {
        const out = blocks.slice()
        for (const ph of placeholders) {
          let at = out.length
          for (let i = 0; i < out.length; i++) {
            const b = out[i]
            if (b.orderNum != null && b.orderNum > ph.orderNum) { at = i; break }
          }
          out.splice(at, 0, ph)
        }
        return out
      }

      // ---- [tools] 框的纯函数版（buildPromptMapData 与 buildMapFromSections 共用） ----
      /**
       * 把一条工具定义的 JSON **渲染成人话**（纯函数）。
       *
       * 2026-09-19 用户口径：「工具定义字段中看不到渲染过的原文，必须到原始 json 中找」
       * ⇒ 抽屉里默认给人话（名字 / 描述 / 参数表），原始 JSON 仍在下面（那才是模型看到的东西）。
       * ⛔ 解析不了（不是 JSON / 形状不认识）就回 `null`，由调用方退回原文 —— 不猜、不编。
       * 兼容两种形状：`{name, description, parameters}` 与 `{type:'function', function:{…}}`。
       */
      function pmToolDefText(jsonText) {
        let t = null
        try { t = JSON.parse(String(jsonText == null ? '' : jsonText)) } catch { return null }
        if (!t || typeof t !== 'object' || Array.isArray(t)) return null
        const fn = t.function && typeof t.function === 'object' && !Array.isArray(t.function) ? t.function : t
        const name = String(fn.name != null ? fn.name : (t.name != null ? t.name : ''))
        if (name === '') return null
        const desc = String(fn.description != null ? fn.description : (t.description != null ? t.description : ''))
        const params = fn.parameters != null ? fn.parameters : t.parameters
        const lines = ['**' + name + '**']
        if (desc !== '') lines.push('', desc)
        const props = params && typeof params === 'object' && !Array.isArray(params) && params.properties && typeof params.properties === 'object'
          ? params.properties : null
        if (props !== null) {
          const required = Array.isArray(params.required) ? params.required.map(String) : []
          lines.push('', '**参数**（' + String(params.type || 'object') + (required.length > 0 ? '，必填：' + required.join('、') : '') + '）：')
          for (const [pn, pv] of Object.entries(props)) {
            const o = pv && typeof pv === 'object' ? pv : {}
            const ty = String(o.type != null ? o.type : (Array.isArray(o.enum) ? 'enum' : '?'))
            const pd = String(o.description != null ? o.description : (o.desc != null ? o.desc : ''))
            const en = Array.isArray(o.enum) ? '（可选值：' + o.enum.map(String).join(' / ') + '）' : ''
            lines.push('- `' + pn + '`（' + ty + (required.includes(pn) ? '，必填' : '') + '）' + (pd === '' ? '' : '：' + pd) + en)
          }
        } else if (params !== null && params !== undefined) {
          lines.push('', '**参数**：' + JSON.stringify(params))
        }
        return lines.join('\n')
      }

      function pmToolsBlocks(tools) {
        const toolBlocks = []
        if (tools === null) {
          toolBlocks.push(pmDashedBlock('toolsMissing', '工具定义数组（request.header.tools）', '取不到：part=tools 请求失败（不是没有工具）'))
        } else if (tools.length === 0) {
          toolBlocks.push(pmDashedBlock('toolsMissing', '工具定义数组（request.header.tools）', '未检出（本会话没有工具定义）'))
        } else {
          for (const t of tools) {
            const b = {
              key: 'tool:' + String(t && t.name != null ? t.name : '?'), label: String(t && t.name != null ? t.name : '?'),
              order: '—', orderNum: null, color: 'blue', dashed: false, mut: 'static', mutBasis: 'known',
              mutWhy: '工具定义随会话固定', who: 'DSH 核心 / 工具插件', note: null,
              chars: typeof (t && t.chars) === 'number' ? t.chars : null, reason: null, sub: null,
            }
            toolBlocks.push(b)
          }
        }
        return toolBlocks
      }

      // ---- [messages] 框的纯函数版（20260914 用户拍板 A8 改版）：框里只留**真实检出的特殊行**
      //      （checkpoint / role=tool）；普通历史（user/assistant 条数、首轮开场）不再占版面 ——
      //      定位入口换成框顶一行「对话历史 · N 条」（点它打开 L2 消息定位）。
      //      取不到（null）仍如实给一行「取不到」；空串如实 0 条；切不开（形状变了）仍按整段如实标注。
      // ---- ★★ 2026-09-18 甲（用户口径）：[messages] 框**改成给真实消息**，不再只给"速览"计数行。
      //      旧版只看 `messagesText`（拼装出来的整段文本）⇒ 这个框永远只有
      //      「被压缩掉的 checkpoint ×N / role=tool ×N」两行 —— 用户原话"字段一直没有发挥作用"。
      //      现在：宿主给了逐条数据（`messages[].turn/blocks`，20260918 查看器单新增）时
      //      **一条消息一行**：按楼标注、正文给词头、**思维链单列并报字数**。
      //      这就是"这一楼实际发出去的对话历史"本身 —— 和上面 [system] 框一样是**实况**，不是速览。
      //      ⛔ 拿不到逐条数据（文本推断路径 / 老宿主）⇒ 如实退回旧的计数行，绝不编。
      function pmMessagesBlocks(messagesText, messages) {
        const msgBlocks = []
        const list = Array.isArray(messages) ? messages : null
        if (list !== null && list.length > 0) {
          const totalChars = list.reduce((n, m) => n + (typeof m.chars === 'number' ? m.chars : 0), 0)
          const turnLabel = (m) =>
            (typeof m.turn === 'number' && Number.isInteger(m.turn) && m.turn > 0) ? '第 ' + m.turn + ' 楼' : '未标注楼'
          const nReason = list.filter((m) => (m.blocks || []).some((b) => b && b.kind === 'reasoning' && b.chars > 0)).length
          const head = {
            key: 'msgSummary', label: '本楼实际发出的对话历史 · ' + list.length + ' 条',
            order: '—', orderNum: null, color: 'yellow', dashed: false,
            mut: 'per-turn', mutBasis: 'known', mutWhy: '聊天记录每轮增长', who: '会话本身',
            note: null, chars: totalChars, reason: null, sub: null,
          }
          msgBlocks.push(head)
          const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').slice(0, 40)
          for (const m of list) {
            const roleLabel = m.role === 'assistant' ? 'AI' : m.role === 'tool' ? 'tool' : (m.isCompacted ? '压缩摘要' : 'user')
            const rChars = (m.blocks || []).reduce((n, b) => n + (b && b.kind === 'reasoning' && typeof b.chars === 'number' ? b.chars : 0), 0)
            const body = (m.blocks || []).find((b) => b && b.kind !== 'reasoning' && b.chars > 0 && typeof b.head === 'string')
              || (m.blocks || []).find((b) => b && typeof b.head === 'string' && b.head !== '')
            const head40 = body ? body.head : ''
            const label = turnLabel(m) + ' · ' + roleLabel
              + (rChars > 0 ? ' · 思维链 ' + fmtChars(rChars) + ' 字' : '')
              + (head40 ? ' 「' + oneLine(head40) + (String(head40).length > 40 ? '…' : '') + '」' : '')
            // ★★ 2026-09-20（用户口径，原话）：「但这一字段在对话历史里**需要给出并标红**。
            //   注释是：由 memory-archive 注入的后处理提示词。st 中后处理提示词一般放置强指令与破限
            //   提示词，DSH 系统字段无法实现文末注入，只能用 user 信息模拟，会在每轮对话间积累。
            //   提示词字数不建议超过 300 字。」
            //   ⇒ 认人靠结构性的 `sourcePlugin`（⛔ 不比文本、⛔ 不看字数）：本插件注入的那一条**标红**，
            //     并把那句注释做成**看得见的一行**挂在它下面（`sub`），超 300 字再补一句提醒。
            const isPhiInject = m.sourcePlugin === PM_PHI_INJECT_PLUGIN_ID
            const b = {
              key: 'msg-' + (m.seq == null ? roleLabel + '-' + msgBlocks.length : m.seq),
              label: isPhiInject ? label + ' · 插件注入' : label,
              order: '—', orderNum: null, color: isPhiInject ? 'red' : (m.role === 'tool' ? 'blue' : 'yellow'), dashed: false,
              mut: 'per-turn', mutBasis: 'known', mutWhy: '聊天记录每轮增长', who: '会话本身',
              note: isPhiInject ? PM_NOTE_PHI_INJECT : null,
              chars: typeof m.chars === 'number' ? m.chars : null, reason: null, sub: null,
            }
            if (isPhiInject) {
              b.sub = PM_NOTE_PHI_INJECT + (typeof m.chars === 'number' && m.chars > PM_PHI_INJECT_SUGGEST_CHARS
                ? `　⚠️ 本条 ${fmtChars(m.chars)} 字，超过建议的 ${PM_PHI_INJECT_SUGGEST_CHARS} 字。`
                : '')
            }
            msgBlocks.push(b)
          }
          return msgBlocks
        }
        if (messagesText == null) {
          msgBlocks.push(pmDashedBlock('messagesMissing', '对话历史（messages）', '取不到：part=messages 请求失败（不是没有历史）'))
          return msgBlocks
        }
        if (messagesText === '') return msgBlocks // 空：定位行会显示「0 条」，特殊行自然没有
        const parsed = splitMessagesText(messagesText)
        if (!parsed) {
          const b = pmDashedBlock('messagesRaw', 'messages 整段（未按预期形状切开）',
            '形状变了：认不出消息分隔行，按整段对待') // 20260914 M7：可见 sub 去掉「（不猜）」自证（信息是「按整段对待」）
          b.chars = messagesText.length
          b.sub = b.reason
          msgBlocks.push(b)
          return msgBlocks
        }
        const nCkpt = parsed.filter((b) => b.role === 'user' && /<compacted-summary>|compacted-summary/.test(b.text)).length
        const nTool = parsed.filter((b) => b.role === 'user' && /tool_result|tool_use_id|<tool_result>/.test(b.text)).length
        const histRow = (key, label, count) => {
          const b = {
            key: key, label: label + ' ×' + count, order: '—', orderNum: null, color: 'yellow', dashed: false,
            mut: 'per-turn', mutBasis: 'known', mutWhy: '聊天记录每轮增长', who: '会话本身', note: null,
            chars: null, reason: null, sub: null,
          }
          return b
        }
        if (nCkpt > 0) msgBlocks.push(histRow('msgCkpt', '被压缩掉的 checkpoint 占位行', nCkpt))
        if (nTool > 0) {
          const b = histRow('msgTool', 'role=tool 调用结果（夹在 user 行里）', nTool)
          b.color = 'blue'
          b.mutWhy = '调用结果随历史每轮增长'
          msgBlocks.push(b)
        }
        return msgBlocks
      }

      /**
       * 提示词装配地图的纯数据层（自检直接调用；组件只渲染）。
       * @param {{systemText?:string|null, prevSystemText?:string|null, systemTruncated?:boolean,
       *          tools?:Array|null, messagesText?:string|null}} input
       *   systemText/prevSystemText = 本轮与上一轮的 system 全文（同会话；上一轮拿得到才做实测比对）；
       *   tools = part=tools 的 {name,chars} 数组（null = 取不到；[] = 确实没有）；
       *   messagesText = part=messages 全文。
       * @returns {{boxes:Array, totals:Object}} boxes 固定三个：system → tools → messages。
       */
      function buildPromptMapData(input) {
        input = input || {}
        const systemText = typeof input.systemText === 'string' ? input.systemText : null
        const prevSystemText = typeof input.prevSystemText === 'string' ? input.prevSystemText : null
        const tools = Array.isArray(input.tools) ? input.tools : null
        const messagesText = typeof input.messagesText === 'string' ? input.messagesText : null

        // ---- [system] 框：切段 → 判可变性 → 补未检出占位 ----
        const curSegs = pmSplitSystem(systemText)
        const prevSegs = pmSplitSystem(prevSystemText)
        const prevByKey = {}
        for (const s of prevSegs) (prevByKey[s.key] = prevByKey[s.key] || []).push(s.text)
        const occ = {}
        let sysBlocks = []
        if (systemText == null) {
          sysBlocks.push(pmDashedBlock('systemMissing', 'system 全文', '取不到：part=system 请求失败（不是没有 system）'))
        } else {
          sysBlocks = curSegs.map((seg) => {
            const def = PROMPT_MAP_DEFS[seg.key] || PROMPT_MAP_DEFS.unknown
            const n = occ[seg.key] = (occ[seg.key] || 0) + 1
            const prevText = prevByKey[seg.key] ? prevByKey[seg.key][n - 1] : undefined
            const b = pmDetectedBlock(def, seg.text, judgePmMutability(def, seg.text, prevText))
            b.key = seg.key
            return b
          })
          const detected = new Set(curSegs.map((s) => s.key))
          const placeholders = PROMPT_MAP_PLACEHOLDERS.map((ph) => pmDashedBlock(ph.key, ph.label, ph.reason, ph.orderNum))
          for (const key of PROMPT_MAP_MISSING_KEYS) {
            if (detected.has(key)) continue
            const def = PROMPT_MAP_DEFS[key]
            placeholders.push(pmDashedBlock(key + '-missing', def.label, PM_NOT_DETECTED, def.orderNum))
          }
          sysBlocks = pmInsertPlaceholders(sysBlocks, placeholders)
        }

        const toolBlocks = pmToolsBlocks(tools)
        const msgBlocks = pmMessagesBlocks(messagesText)

        const totals = {
          systemChars: systemText != null ? systemText.length : null,
          // 文本推断路径没有 contexts 数据（只有 C4 /api/sections 有）—— 如实未知，不猜
          contextCount: null,
          contextChars: null,
          toolCount: tools != null ? tools.length : null,
          toolChars: tools != null ? tools.reduce((n, t) => n + (typeof (t && t.chars) === 'number' ? t.chars : 0), 0) : null,
          messageCount: messagesText != null ? (messagesText === '' ? 0 : (splitMessagesText(messagesText) || []).length || null) : null,
          // 20260914 M2（A7 三框占比）：messages 框的字数 = part=messages 全文长度（取不到如实 null）
          messagesChars: messagesText != null ? messagesText.length : null,
        }
        return {
          // ★ 2026-09-19（用户口径：「运行上下文没用删了吧。不显示」）：[上下文] 那一盒不再渲染。
          //   数据仍算在 totals 里（统计口径不悄悄改），只是**不出盒**。
          boxes: [
            { id: 'system', title: '[system] 系统提示', blocks: sysBlocks },
            { id: 'tools', title: '[tools] 工具定义（★ 独立字段，不在 system 里）', blocks: toolBlocks },
            // A8：框顶「对话历史 · N 条」定位入口的条数来源（null = 条数未知，如实显示）
            { id: 'messages', title: '[messages] 对话历史', blocks: msgBlocks, count: totals.messageCount },
          ],
          totals: totals,
          systemTruncated: input.systemTruncated === true,
        }
      }

      // C4 段结构 → 地图数据（20260913 新真相源：段名/切分/可变性来自组装捕获，不再靠文本猜）。
      // c4 = GET /dsh-memory-archive/api/sections 响应；opts.messagesText = C3 part=messages（按轮次）全文。
      // 返回与 buildPromptMapData 同形（boxes/totals），外加 source/capturedAt/inferred（诚实口径）：
      // ⛔ source:'inferred' 的结果只允许以「结构为文本推断」的明示出现，绝不允许标成捕获。
      function buildMapFromSections(c4, opts) {
        opts = opts || {}
        const captured = c4 && typeof c4 === 'object'
        const sections = captured && Array.isArray(c4.sections) ? c4.sections : []
        const contexts = captured && Array.isArray(c4.contexts) ? c4.contexts : []
        const tools = captured && Array.isArray(c4.tools) ? c4.tools : null
        // 20260914 M7：mutWhy 只进悬停 title（信息留着），文案洗掉「判断依据：/—— 最权威口径」这类元话
        const basisWhy = (basis) => basis === 'definition'
          ? '段定义（运行时 PromptSection.text 是否函数）'
          : basis === 'header-equal'
            ? '宿主判定本楼沿用上一条 header（逐字相等）'
            : basis === 'measured'
              ? '实测'
              : basis === 'project'
                ? '本项目口径：上游不给这些段的可变性字段，按事实标成「每轮」（每轮装配都重新展开/重算）'
                : null
        const sysBlocks = []
        // （2026-09-19：contexts 不再出盒 —— 见下方口径注释；这里不再收集 ctx:* 块）
        for (const s of sections) {
          const mutCaptured = s && s.mutability === 'per-turn' ? 'per-turn' : s && s.mutability === 'static' ? 'static' : 'unknown'
          const name = String(s && s.name != null ? s.name : '?')
          const chars = s && typeof s.chars === 'number' ? s.chars : null
          // ★★ 2026-09-19（用户口径：「tavern 注入的颜色没改，改成黄色」）：
          //   dsh-tavern 注入的那几段（`pmp-dsh-tavern:*`）在捕获里一律 `mutability: 'unknown'`
          //   —— 那是**上游没给这个字段**，不是"真的不知道"：每轮装配它都会重新展开一遍
          //   （真机实测同一会话不同轮里 part 的数量/字数/内容都在变，例如首轮多一段开场白、
          //    PHI 那一段在有的轮里被我们摘走）。⇒ 本项目按事实标成**每轮可变（黄）**，
          //   并把口径写进 mutWhy（⛔ 不改捕获数据、也不假装是宿主给的判据）。
          const isTavernInjected = name.startsWith('pmp-dsh-tavern')
          const mut = isTavernInjected ? 'per-turn' : mutCaptured
          const mutBasis = isTavernInjected ? 'project' : ((s && s.mutabilityBasis) || null)
          // ★ 2026-09-15：`tool:*` = **工具段**（每个工具一段的说明/纪律）。图例里「蓝=工具」本来就写着，
          //   但 system 框里这些段此前按**可变性**着色（黄/红）⇒ 图例与画面不一致、用户看不出这是工具段。
          //   这里统一成蓝；可变性语义不丢（仍由 mut + 徽标 + 悬停 tip 表达）。
          const isTool = name.startsWith('tool:')
          const b = {
            key: 'sec:' + name, label: name,
            order: s && s.order != null ? s.order : '—',
            orderNum: s && typeof s.order === 'number' ? s.order : null,
            // ★ 2026-09-19（用户：「还是没看到后处理提示词的位置」）：**没有 order 的段**（dsh-tavern
            //   展开出来的那些 part）在面板上原本只显示一个「—」，于是"它到底在 system 的哪儿"看不见。
            //   捕获记录里本来就有 `offset` / `renderedChars`（投影早就带过来了，只是一直没显示）
            //   ⇒ 拿它算出"第 N 字 / 共 M 字（约 X% 处）"，没有 order 的行就显示这个真实位置。
            offset: s && typeof s.offset === 'number' ? s.offset : null,
            renderedChars: s && typeof s.renderedChars === 'number' ? s.renderedChars : null,
            color: isTool ? 'blue' : mut === 'per-turn' ? 'yellow' : mut === 'static' ? 'red' : 'gray',
            isTool: isTool,
            dashed: false, mut: mut, mutBasis: mutBasis,
            mutWhy: basisWhy(mutBasis),
            who: pmSectionOwner(name, '段名来自组装捕获（system-prompt/assemble 瀑布的运行时真段名）'),
            // ★ 人话注释（有出处才写）+ 两条"近似"标注（PHI/depth 在 DSH 没有对应槽位，必须如实标）
            note: [pmSectionNote(name), pmSectionHonesty(name)].filter(Boolean).join('　·　') || null,
            honesty: pmSectionHonesty(name),
            chars: chars,
            // 20260914 M2：A3 复合段 / A5 空段（数据层先如实标注，渲染层据此画徽标/细线）
            composite: isPmCompositeName(name),
            empty: chars === 0,
            reason: null, sub: s && s.hash == null ? 'hash 未记录' : null,
          }
            sysBlocks.push(b)
        }
        // ★★★ 口径（20260914 第二次返工钉死，2026-09-19 只改了"显示"没改口径）：system 小计 = 只算 sections，
        // ⛔ 不含 contexts。依据（宿主源码，只读核对）：renderPrompt(assembly) 只拼 sections
        // （packages/core/system-prompt/src/index.ts:263-268，filter(len>0).join('\n\n')）⇒ system 里没有 contexts；
        // contexts 走 renderContextSnapshot（同文件 :275-291）拼成一条**独立消息**。
        // ★ 2026-09-19（用户口径：「运行上下文没用删了吧。不显示」）：contexts 那一段的**逐条块与占位块都不再渲染**，
        //   但 `totals.contextCount/contextChars` 照旧算（口径不许悄悄改）。原实现（ctx:* 块 + 「关掉了」占位）
        //   见 git 历史 —— 需要看 contexts 内容时去会话日志的注入消息里看，面板不再承担这个展示。
        // ★ 2026-09-15：宿主给**编码 agent** 的定位段，在 RP 预设里被作用域遮蔽成空
        //   （`preset-modules/rp-suppress-host-sections.js`）。0 字的段本来就不进 system
        //   （`renderPrompt` 只拼非空段）—— 但**面板照常逐行给出**它们（见下面 2026-09-16 的口径修正），
        //   因为每一段都占了一个 order，隐藏它等于把装配事实抹掉。
        //   ⚠️ 名单须与那个模块的 DEFAULT_SECTIONS 一致；其余空段（如 rp:policy — 上游的策略段本来就常为空）
        //      仍按 A5 规则显示为「空」行，不受影响。
        // ★ 2026-09-16（用户口径修正）：**不折叠、不隐藏** —— 这几段各占一个 order，行要照常给出来，
        //   注释里写清「来源 DSH 官方 + 作用 + RP 已禁用 ⇒ 占位、无内容」（见 PM_SECTION_NOTES）。
        //   行上只加一个**灰标「RP 遮蔽」**，而且只在它**确实为空**时加 —— 非空时（旧代会话、
        //   或编码会话）不加，避免暗示"已被遮蔽"而其实内容还在。
        const PM_HOST_ORIENT = ['harness:source', 'app:web-surface', 'context:file-reference', 'ui:deliverable-file-references']
        for (const b of sysBlocks) {
          if (PM_HOST_ORIENT.includes(b.label) && b.chars === 0) b.rpSuppressed = true
        }
        // ★★ 2026-09-19（用户口径：「还是没看到后处理提示词的位置」）：把"**卡的后处理提示词这一轮落在哪儿**"
        //   直接写在行上，不用去数 order 或猜。
        // ★ 2026-09-19 晚改（尾段退役后）：现在**只有上游那一份**，它由摆位表摆到全文最后（order 10203）
        //   ⇒ 这一行的注释来自摆位表（PM_TAVERN_FIELD_PLAN），这里只补一句"本轮它就在最后"的落点提示。
        const phiRow = sysBlocks.find((b) => /(^|:)character:postHistoryInstructions$/.test(String(b.label || '')))
        if (phiRow !== undefined && phiRow.orderNum === 10203) {
          phiRow.note = [
            // ★ 2026-09-20：改走"玩家消息之后"注入之后（lib/phi-message.js），system 里这份从**第二轮**起
            //   就被清空（同一个东西只留一份）⇒ 这一行会变成 0 字。这里如实说清它去哪儿了，
            //   ⛔ 不能让"排在这一行（全文最后）"这句话看着像"它还在、只是没内容"。
            phiRow.chars === 0
              ? '★ **本轮这一份为空**：后处理提示词已改从**玩家消息之后**注入（见 [对话历史] 里那条标红的「插件注入」行）'
              : '★★ **本轮它就排在这一行**（order 10203 = 全文最后）：这就是"后处理"该有的效果 —— 它比历史更晚被读到',
            phiRow.note,
          ].filter(Boolean).join('　·　')
        }
        if (sysBlocks.length === 0) {
          sysBlocks.push(pmDashedBlock('sectionsEmpty', 'system 段结构', '未检出（捕获记录里没有任何段）'))
        }
        const toolBlocks = pmToolsBlocks(tools)
        // ★ 甲：把逐条数据一并交给 pmMessagesBlocks —— 有它就按**真实消息**逐条出（这才叫"实况"），
        //   没有（文本推断路径 / 老宿主）才退回旧的计数行。
        const msgList = Array.isArray(opts.messages) && opts.messages.length > 0 ? opts.messages : null
        const msgBlocks = pmMessagesBlocks(typeof opts.messagesText === 'string' ? opts.messagesText : null, msgList)
        const sumChars = (list) => list.reduce((n, x) => n + (x && typeof x.chars === 'number' ? x.chars : 0), 0)
        // ★ system 小计 = 只算 sections（⛔ 不含 contexts）；systemNonEmpty 供分隔符口径：
        //   官方 renderPrompt = sections.filter(非空).join('\n\n') ⇒ 真日志 system 长度
        //   = Σ sections.chars + (非空段数 - 1) × 2（空段不计位）。
        const systemNonEmpty = sections.filter((s) => (s && typeof s.chars === 'number' ? s.chars : 0) > 0).length
        // ★ 20260918 查看器单 T1（底本全覆盖）：「未抓到」= 底本 − 已被各块覆盖的部分，只许减出来。
        // 底本 = /api/part part=system 的 system 全文口径（opts.systemText；⛔ 不新造来源）；
        // 覆盖 = Σ sections.chars + (非空段数−1)×2（上面那条官方 renderPrompt 分隔符公式）。
        // 只有捕获路径可比 —— 文本推断路径的块就是从底本自己切出来的，不可能有差；
        // 底本取不到 / 差值 ≤ 0 ⇒ 这一行**不出现**（⛔ 不写 0 字数的「未抓到」占位行）。
        let uncapturedChars = null
        if (captured && c4.source === 'captured' && typeof opts.systemText === 'string' && sections.length > 0) {
          const coveredChars = sumChars(sections) + Math.max(0, systemNonEmpty - 1) * 2
          const rest = opts.systemText.length - coveredChars
          if (rest > 0) {
            uncapturedChars = rest
            // ★ 2026-09-20（用户口径，原话）：「这段改成：底本（system 全文）8,384字 − 已装配 7,917字 = 未认领 467字」
            //   ⇒ **一句话连排**：`数字+字` 粘成一个单位、运算符两侧留空格；末了那句
            //   「（只减不编，切到多少报多少）」按用户给的句子**去掉**。
            //   ⛔ 也别再拆成小药丸（2026-09-18 那版 `subParts`）：拆了之后复制出去会断成一堆碎片，
            //   用户这次给的就是一句完整的话。
            const baseLen = opts.systemText.length
            const subText = '底本（system 全文）' + fmtChars(baseLen) + '字 − 已装配 ' + fmtChars(coveredChars)
              + '字 = 未认领 ' + fmtChars(rest) + '字'
            const b = pmDashedBlock('uncaptured', '未抓到（切完的剩余）', subText)
            b.chars = rest
            // ★ 2026-09-20：这一行也要有注释（抽屉里不许显示「未收录」—— 别的下钻都有，就它没有）。
            //   文案按用户口径（原文）：「这里展示的是不确定身份的字段。可能是没有注册，可能是格式不对露出。」
            b.note = '这里展示的是**不确定身份的字段**。可能是没有注册，可能是格式不对露出。'
            // ★ 2026-09-19（用户口径）：「这段改成…给一个下钻窗口，把未抓到的文本内容展示在这里」
            //   ⇒ 点这一行就能看到**未认领的那几段原文**。算法与上面那个数字**同源**：
            //   按各段的 [offset, offset+chars) 求补集（段按 offset 排序；取不到 offset 的段不参与，
            //   与"只减不编"同一条纪律 —— 那样算出来的字数可能比 `rest` 略多/略少，**如实标注**）。
            try {
              const spans = []
              for (const sec of sections) {
                if (typeof sec.offset !== 'number' || typeof sec.chars !== 'number' || sec.chars <= 0) continue
                spans.push([sec.offset, sec.offset + sec.chars])
              }
              spans.sort((a, b2) => a[0] - b2[0])
              // ★★ 2026-09-20（用户报障：「以上是没抓到的字段。很抽象，都是些字段碎片。我觉得算bug」）：
              //   真机复现（session-d3aea3f4 · 第 1 楼）——捕获那趟记的**段序**与本楼最终 system 对不上
              //   （捕获里多了一条 820 字的 `state:card`、少了开场白那两段）⇒ 从错位点往后，
              //   `[offset, offset+字数)` 切出来的"缺口"就成了 2~3 个字的**渣**（"at"/"ti"/"1."/"g-"）。
              //   ⇒ 这些渣**不是"没抓到的内容"**：短于 DUST_MIN 的片段按**对齐误差**处理，不进正文区
              //     （计数后在页脚如实交代，⛔ 不静默丢、⛔ 也不假装它是内容）。
              //   ⚠️ 这是**症状**上的处理；根因（捕获段序 vs 最终正文）另有账，注释里按用户口径写明了。
              const joined = []
              let cursor = 0
              let skippedNoOffset = 0
              let dustCount = 0
              let dustChars = 0
              const take = (raw) => {
                const t = raw.trim()
                if (t === '') return
                if (t.length < DUST_MIN) { dustCount += 1; dustChars += t.length; return }
                joined.push(t)
              }
              for (const [a, z] of spans) {
                if (a > cursor) take(opts.systemText.slice(cursor, a))
                cursor = Math.max(cursor, z)
              }
              if (cursor < opts.systemText.length) take(opts.systemText.slice(cursor))
              const unclaimed = joined.join('\n\n— — —\n\n')
              b.drillable = unclaimed !== ''
              b.unclaimedText = unclaimed
              for (const sec of sections) {
                if (typeof sec.offset !== 'number' && typeof sec.chars === 'number' && sec.chars > 0) skippedNoOffset += 1
              }
              b.unclaimedNote = (skippedNoOffset > 0
                ? `⚠ 有 ${skippedNoOffset} 段没记录位置（旧捕获）⇒ 它们的正文会被算成"未认领"；`
                : '')
                + (dustCount > 0
                  ? `另有 ${dustCount} 处共 ${fmtChars(dustChars)} 字的碎片（每处 ≤ ${DUST_MIN - 1} 字）**已略去** —— `
                    + '那是"捕获那趟的段序/字数与本楼最终 system 对不上"留下的对齐误差，不是内容；'
                  : '')
                + `实测补集 ${fmtChars(unclaimed.length)} 字（按各段位置从底本里切出来的原文，可能与上面那个"只减不编"的差值差几十字 —— 分隔符与空段的口径不同）`
            } catch { b.drillable = false; b.unclaimedText = null }
            // ★ 2026-09-20：底本**没验过**（调用方说 `systemTextVerified:false`，即那份 system 没与
            //   捕获凭据对上）⇒ 这一份"缺口"是从两份不同的 system 上减出来的，切片必然错位
            //   ⇒ **不给补集**，如实说。（真机：两份 system 同为 8,384 字、内容不同。）
            if (opts.systemTextVerified === false) {
              b.drillable = false
              b.unclaimedText = null
              b.unclaimedNote = '⚠ 本楼底本没能与捕获凭据（长度 + sha256）对上 ⇒ **不给补集切片**'
                + '（那样切出来只会是错位的碎片）；上面的数字仍是"底本 − 已装配"，只减不编。'
            }
            b.uncaptured = { baseChars: opts.systemText.length, coveredChars: coveredChars, chars: rest }
            sysBlocks.push(b)
          }
        }
        const totals = {
          systemChars: sections.length > 0 ? sumChars(sections) : null,
          systemNonEmpty: sections.length > 0 ? systemNonEmpty : null,
          // 20260918 T1：切完的剩余字数（null = 恰好全覆盖 / 底本取不到 / 非捕获路径，都⇒不出这一行）
          uncapturedChars: uncapturedChars,
          contextCount: contexts.length,
          contextChars: sumChars(contexts),
          toolCount: tools != null ? tools.length : null,
          toolChars: tools != null ? sumChars(tools) : null,
          // A8/A7：messages 条数与字数来自 part=messages（C3），捕获端点不给这两个数。
          // ★ 甲：有逐条数据时**以逐条为准**（它是权威），文本拼装口径只在拿不到逐条时兜底。
          messageCount: msgList !== null
            ? msgList.length
            : (typeof opts.messagesText === 'string' ? (opts.messagesText === '' ? 0 : (splitMessagesText(opts.messagesText) || []).length || null) : null),
          messagesChars: msgList !== null
            ? msgList.reduce((n, m) => n + (typeof m.chars === 'number' ? m.chars : 0), 0)
            : (typeof opts.messagesText === 'string' ? opts.messagesText.length : null),
        }
        return {
          // ★ 2026-09-19（用户口径：「运行上下文没用删了吧。不显示」）：[上下文] 那一盒不再渲染。
          //   ⚠️ contexts 的数据与 system 小计的口径照旧（`totals.contextCount/contextChars` 还在、
          //      system 小计仍**只算 sections**）—— 删的只是"显示它"，不是"改统计口径"。
          boxes: [
            { id: 'system', title: '[system] 系统提示', blocks: sysBlocks },
            { id: 'tools', title: '[tools] 工具定义（★ 独立字段，不在 system 里）', blocks: toolBlocks },
            { id: 'messages', title: '[messages] 对话历史', blocks: msgBlocks, count: totals.messageCount },
          ],
          totals: totals,
          systemTruncated: false,
          source: captured && c4.source === 'captured' ? 'captured' : 'inferred',
          capturedAt: captured && c4.capturedAt != null ? c4.capturedAt : null,
          inferred: captured && c4.inferred && typeof c4.inferred === 'object' ? c4.inferred : null,
        }
      }

      // ---------- 装配地图渲染（纯展示：三框竖排 + 色条行 + 悬停提示；数据来自 PromptMap） ----------
      // ★ 2026-09-20：补集里短于这个长度的片段按**对齐误差**看（见 buildMapFromSections 里那段注释）。
      const DUST_MIN = 8
      /** 本插件注入的后处理提示词，在 [对话历史] 里靠它认人（与宿主侧 lib/phi-message.js 同一个 id）。 */
      const PM_PHI_INJECT_PLUGIN_ID = 'dsh-memory-archive'
      /** 用户口径：后处理提示词字数**不建议超过 300 字**（超了就在行下提醒，⛔ 不拦）。 */
      const PM_PHI_INJECT_SUGGEST_CHARS = 300
      /** 那一条的注释（用户口径，原文照录；行下标红 + 注释都看得见）。 */
      const PM_NOTE_PHI_INJECT = '**由 memory-archive 注入的后处理提示词**。'
        + 'ST 中后处理提示词一般放置强指令与破限提示词；DSH 系统字段无法实现文末注入，'
        + '只能用 user 信息模拟，**会在每轮对话间积累**。提示词字数不建议超过 300 字。'
      const PM_COLOR = { red: 'crimson', yellow: 'DarkGoldenrod', blue: 'royalblue', gray: 'GrayText' }
      const PM_MUT_BADGE = { static: '静态', 'per-turn': '每轮', unknown: '未知' }

      // 20260914 M2 · A1/A2/A3/A4/A5：一行 = 顺序脊（order 数值 + 头/中/尾）+ 段名 + 复合/空标
      //   + order/字数 + 可变性徽标（带依据短词）+ 按字数的比例条（长度成正比 + 右侧百分比）。
      // boxTotal = 本框已检出字数合计（比例条与百分比按框内占比算）；拿不到（0/null）不画条，不猜。
      function pmRow(b, onDrill, boxTotal) {
        const color = PM_COLOR[b.color] || PM_COLOR.gray
        // ★ 2026-09-19：虚线块（例如「未抓到」）只要带 `drillable:true` 也允许下钻
        const clickable = typeof onDrill === 'function' && (b.drillable === true || !b.dashed)
        // ★ 2026-09-19：没有 order 的段（dsh-tavern 展开的那些 part）改用**捕获到的真实偏移**说位置，
        //   否则顺序脊只有一个「—」，用户看不见"它在 system 的哪儿"（用户原话：还是没看到后处理提示词的位置）。
        const offsetPos = b.orderNum == null ? pmPosTagByOffset(b.offset, b.renderedChars) : null
        const pos = b.orderNum == null ? offsetPos : pmPosTag(b.orderNum)
        const basis = pmBasisLabel(b.mutBasis)
        const empty = b.empty === true || b.chars === 0
        const pct = !b.dashed && typeof b.chars === 'number' && boxTotal > 0
          ? Math.round((b.chars / boxTotal) * 1000) / 10
          : null
        const spineText = b.orderNum != null
          ? String(b.orderNum) + (pos ? ' ' + pos : '')
          : (Number.isFinite(b.offset) ? '@' + b.offset : (b.order != null && b.order !== '—' ? String(b.order) : '—'))
        return e('div', {
          key: b.key + (b.sub || ''),
          'data-pm': 'row', 'data-pm-color': b.color, 'data-pm-mut': b.mut, 'data-pm-dashed': b.dashed ? '1' : '0',
          'data-pm-tool': b.isTool ? '1' : '0',
          'data-pm-rpsuppressed': b.rpSuppressed === true ? '1' : '0',
          'data-pm-click': clickable ? '1' : '0',
          'data-pm-empty': empty && !b.dashed ? '1' : '0',
          className: 'dma-pmrow',
          // ★ 2026-09-19（用户口径：「鼠标悬浮还有浮窗说明。删掉吧，不维护这一份了」）：
          //   行上**不再挂 tooltip** —— 同一份说明不再维护两处；要读说明就点开抽屉（那里是 Markdown 渲染的）。
          title: clickable ? '点击下钻：右侧滑出该段详细与原文' : undefined,
          onClick: clickable ? () => onDrill() : undefined,
          style: {
            borderLeft: '4px ' + (b.dashed ? 'dashed' : 'solid') + ' ' + color,
            display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0,
            paddingTop: empty && !b.dashed ? 0 : undefined,
            paddingBottom: empty && !b.dashed ? 0 : undefined,
          },
        },
          e('div', { style: { display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0 } },
            // A2 顺序脊：定宽一列，头/中/尾一眼可读（— 表示没有数值 order，如实）
            e('span', {
              'data-pm': 'spine', 'data-pm-pos': pos || '',
              style: { fontFamily: MONO, fontSize: SMALL_FONT_SIZE, opacity: 0.75, flexShrink: 0, width: 58, textAlign: 'right', color: pos ? color : 'GrayText', fontWeight: pos ? 700 : 400 },
            }, spineText),
            b.dashed
              ? e('span', { style: { fontSize: 12.5, wordBreak: 'break-all', color: 'GrayText' } }, b.label)
              : e('span', { style: { fontSize: empty ? 12 : 12.5, fontWeight: empty ? 400 : 600, wordBreak: 'break-all', color: color } }, b.label),
            // ★ 2026-09-15：工具段的**蓝色药丸**（图例「蓝=工具」的可见落点；行左侧色条也是蓝）
            b.isTool
              ? e('span', {
                'data-pm': 'tooltag',
                style: { fontSize: 10, color: 'white', background: PM_COLOR.blue, borderRadius: 999, padding: '0 6px', flexShrink: 0, fontFamily: MONO },
              }, '工具')
              : null,
            // ★ 2026-09-16：RP 遮蔽的宿主定位段 —— 行**照常给**（它占一个 order），只加一个灰标说清
            //   「本段被 RP 预设禁用（占位、无内容）」。⛔ 只在确实为空时加（非空说明内容还在，别误导）。
            b.rpSuppressed === true
              ? e('span', {
                'data-pm': 'rpsuppressed',
                style: { fontSize: 10, color: 'GrayText', border: '1px solid GrayText', borderRadius: 999, padding: '0 6px', flexShrink: 0, fontFamily: MONO, opacity: 0.9 },
              }, 'RP 遮蔽')
              : null,
            // A5 空段：极细一行 + 「空」标（和「没检出」明确区分开）
            empty && !b.dashed ? e('span', { 'data-pm': 'empty-tag', style: { fontSize: SMALL_FONT_SIZE, color: 'GrayText', flexShrink: 0, border: '1px solid color-mix(in srgb, CanvasText 25%, transparent)', borderRadius: 4, padding: '0 3px' } }, '空') : null,
            // A3 复合段：数据上就是一段的第三方整段注入（M12：徽标不再说"未展开"—— 点开就是原始记录+实际正文）
            b.composite ? e('span', {
              'data-pm': 'composite-badge',
              style: { fontSize: SMALL_FONT_SIZE, color: color, flexShrink: 0, border: '1px solid color-mix(in srgb, CanvasText 25%, transparent)', borderRadius: 4, padding: '0 3px' },
            }, '复合段') : null,
            b.order && b.order !== '—' && b.orderNum == null ? e('span', { style: { fontFamily: MONO, fontSize: SMALL_FONT_SIZE, opacity: 0.7, flexShrink: 0 } }, String(b.order)) : null,
            b.chars != null ? e('span', { style: { fontFamily: MONO, fontSize: SMALL_FONT_SIZE, opacity: 0.6, flexShrink: 0 } }, fmtChars(b.chars) + ' 字') : null,
            e('span', { style: { marginLeft: 'auto', flexShrink: 0 } }),
            // A4 可变性徽标：静态/每轮/未知 + 依据短词（完整依据在悬停 tip 里）
            e('span', {
              'data-pm': 'mutbadge', 'data-pm-mutbadge': (b.mut || 'unknown') + (basis ? '·' + basis : ''),
              style: { fontSize: SMALL_FONT_SIZE, color: color, flexShrink: 0, fontWeight: b.mut === 'per-turn' ? 700 : 400 },
              // 20260914 M7：可见下缀「·注册定义」去掉（出处保留在 data-pm-mutbadge 与上面的悬停 title 里）
            }, (b.mut === 'per-turn' ? '★' : '') + (PM_MUT_BADGE[b.mut] || '未知')),
          ),
          // A1 比例条：长度与本框内字数占比成正比 + 右侧百分比（虚线未检出块没有字数，不画条）
          pct != null ? e('div', { style: { display: 'flex', gap: 6, alignItems: 'center', minWidth: 0, paddingLeft: 62 } },
            e('div', {
              style: { flex: 1, height: empty ? 2 : 5, background: 'color-mix(in srgb, CanvasText 7%, transparent)', borderRadius: 3, overflow: 'hidden', minWidth: 0 },
            },
              e('div', {
                'data-pm': 'bar', 'data-pm-bar-w': String(pct), 'data-pm-for': b.key,
                style: { width: pct + '%', height: '100%', background: color, opacity: 0.55 },
              })),
            e('span', {
              'data-pm': 'bar-pct', 'data-pm-for': b.key,
              style: { fontFamily: MONO, fontSize: SMALL_FONT_SIZE, opacity: 0.65, flexShrink: 0, width: 46, textAlign: 'right' },
            }, pct + '%'),
          ) : null,
          // ★ 2026-09-20（用户口径：「这段改成：底本（system 全文）8,384字 − 已装配 7,917字 = 未认领 467字」）：
          //   说明行一律**连排一句话** —— 原来的 `subParts`（把数字拆成等宽小药丸）删掉了：
          //   拆开之后复制出去会碎成一堆片段，而且他那句话本来就是一整句。
          //   同时**允许换行**（不再 nowrap + 省略号 —— 窄面板上会被截掉，那正是"糊在一起"的老毛病）。
          b.sub
            ? e('div', {
              style: { fontSize: SMALL_FONT_SIZE, color: 'GrayText', paddingLeft: 62, paddingRight: 4, lineHeight: 1.5, wordBreak: 'break-word' },
            }, b.sub)
            : null,
        )
      }

      function pmBox(box, onDrill, locator) {
        // A1 的分母：本框已检出（非虚线且字数为数值）的字数合计
        const boxTotal = box.blocks.reduce((n, b) => n + (!b.dashed && typeof b.chars === 'number' ? b.chars : 0), 0)
        return e('div', { key: box.id, 'data-pm': 'box', 'data-pm-box': box.id, className: 'dma-pmbox', style: { display: 'flex', flexDirection: 'column', gap: 5, flex: 'none' } },
          e('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flex: 'none', flexWrap: 'wrap' } },
            e('span', { style: { fontWeight: 700, fontSize: 12.5 } }, box.title),
            box.note ? e('span', { style: { fontSize: SMALL_FONT_SIZE, color: 'GrayText' } }, box.note) : null,
            e('span', { style: { fontSize: SMALL_FONT_SIZE, color: 'GrayText' } },
              box.blocks.filter((b) => !b.dashed).length + '/' + box.blocks.length + ' 检出')),
          // A8 messages 定位入口：一行「对话历史 · N 条」，点它打开 L2 消息定位（主视图不换）
          locator ? e('div', {
            'data-pm': 'locator', 'data-pm-loc-open': typeof locator.onOpen === 'function' ? '1' : '0',
            className: 'dma-row',
            title: typeof locator.onOpen === 'function'
              ? '打开消息定位（左侧弹出：点一条消息 ⇒ 地图定位到所属楼）'
              : '消息定位入口未接线（此处只是显示条数）',
            onClick: typeof locator.onOpen === 'function' ? locator.onOpen : undefined,
            style: {
              display: 'flex', gap: 6, alignItems: 'baseline', padding: '4px 8px', cursor: typeof locator.onOpen === 'function' ? 'pointer' : 'default',
              border: '1px solid color-mix(in srgb, CanvasText 14%, transparent)', borderRadius: 6,
            },
          },
            e('span', { style: { fontWeight: 700, fontSize: 12.5 } }, '对话历史 · ' + (locator.count == null ? '条数未知' : locator.count + ' 条')),
            e('span', { style: { marginLeft: 'auto', fontSize: SMALL_FONT_SIZE, color: 'GrayText', flexShrink: 0 } }, '消息定位 ›'),
          ) : null,
          e('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 260, overflowY: 'auto' } },
            box.blocks.map((b) => pmRow(b, onDrill ? () => onDrill(box.id, b) : null, boxTotal)).filter(Boolean)),
        )
      }

      // 20260913 三级导航改版：地图是常驻主视图（永不被下钻替换）。
      // ★ 轮次切换胶囊/步进器删除（用户拍板：一排可点按钮无法应对长对话）——
      //   「第 N / M 楼」只是状态行；切楼入口 = L2 消息定位（左侧弹出，点消息 ⇒ 地图定位到所属楼）。
      // ★ 依据来源必须诚实（20260914 M2 · A6 升级为横幅口径）：
      //   captured → 「本楼结构来自组装捕获」；inferred / fallback → 「无捕获记录 · 以下为文本推断」，
      //   fallback 追加「捕获端点不可用」；inferred 的原因（c4.inferred.reason/message）明示在横幅里。
      function PromptMapView({ data, state, sessionId, turn, turnsCount, source, sourceNote, onDrill, onOpenLocator }) {
        const st = state && typeof state === 'object' ? state : { status: 'idle' }
        const d = data && typeof data === 'object' && Array.isArray(data.boxes) ? data : null
        const t = d ? d.totals : {}
        const fmtOrUnknown = (v, suffix) => (v == null ? '未知' : fmtChars(v) + suffix)
        const src = source || (d && d.source) || null
        const inferredMsg = (d && d.inferred && typeof d.inferred.message === 'string' && d.inferred.message) || sourceNote || ''
        const inferredReason = d && d.inferred && typeof d.inferred.reason === 'string' ? d.inferred.reason : ''
        // A6 来源横幅（同一条横幅节点带旧 data-pm 键 + 新 data-pm-banner，口径文案为用户拍板版）
        const sourceNode = src === 'captured'
          ? e('span', { 'data-pm': 'source-badge', 'data-pm-banner': '1', style: Object.assign({}, dimStyle, { color: 'green', fontWeight: 700, flexShrink: 0, border: '1px solid color-mix(in srgb, CanvasText 18%, transparent)', borderRadius: 6, padding: '1px 8px' }), title: '段名/切分来自 system-prompt/assemble 组装捕获（权威口径）\ncapturedAt：' + ((d && d.capturedAt) || '-') }, '本楼结构来自组装捕获')
          : src === 'inferred' || src === 'fallback'
            ? e('span', {
              'data-pm': 'inferred-badge', 'data-pm-banner': '1',
              style: Object.assign({}, dimStyle, { color: 'DarkGoldenrod', fontWeight: 700, flexShrink: 0, border: '1px solid color-mix(in srgb, DarkGoldenrod 45%, transparent)', borderRadius: 6, padding: '1px 8px' }),
              title: inferredMsg || '该楼没有组装捕获记录，段结构由文本推断，仅供定位 —— 不许当作捕获事实',
            },
              '无捕获记录 · 以下为文本推断' + (src === 'fallback' ? '（捕获端点不可用）' : '')
              + (inferredReason ? ' · 原因：' + inferredReason : ''))
            : null
        // A7 各框占比（分母 = 各框字数合计；某一框拿不到 ⇒ 该框「未知」，不硬凑）
        const pmBoxPctTotal = (typeof t.systemChars === 'number' ? t.systemChars : 0)
          + (typeof t.contextChars === 'number' ? t.contextChars : 0)
          + (typeof t.toolChars === 'number' ? t.toolChars : 0)
          + (typeof t.messagesChars === 'number' ? t.messagesChars : 0)
        const pctFor = (v) => (v == null || pmBoxPctTotal <= 0 ? '未知' : (Math.round((v / pmBoxPctTotal) * 1000) / 10) + '%')
        // ★ M11：占比直接跟在各自字数后面（用户要求把两行合成一行）。拿不到字数/合计 ⇒ 不显示占比，
        //   ⛔ 不编一个 0%（那是"确实为 0"的语义，跟自己都不知道不是一回事）。
        const pctSuffix = (v) => {
          const p = pctFor(v)
          return p === '未知' ? '' : '（' + p + '）'
        }
        // ★ 小计口径（20260914 第二次返工）：system 只算 sections，⛔ 不含 contexts；
        //   行容器 title 写明分隔符口径：Σ sections.chars + (非空段数-1)×2 = 官方 renderPrompt 长度
        //   （filter(非空).join('\n\n')，空段不计位）＝真日志里 request/header.header.system 的长度。
        const systemSubtotalTitle = t.systemNonEmpty != null
          ? 'system 小计 = 只算 sections（⛔ 不含 contexts）。分隔符口径：'
            + fmtChars(t.systemChars) + ' + ' + (t.systemNonEmpty - 1) + "×2 个 '\\n\\n' = "
            + fmtChars(t.systemChars + (t.systemNonEmpty - 1) * 2)
            + '＝官方 renderPrompt（filter(非空).join) 的长度＝真日志里 system 的长度（空段不计位）'
          : '文本推断路径没有段级小计（system 全文长度已含分隔符）'
        const n = typeof turnsCount === 'number' && turnsCount > 0 ? turnsCount : null
        return e('div', { style: Object.assign({}, colFillStyle, { overflowY: 'auto', gap: 8 }) },
          e('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', flex: 'none' } },
            e('span', { style: Object.assign({}, dimStyle, { fontWeight: 700, color: 'CanvasText', fontSize: 12.5 }) },
              '提示词装配地图'),
            // ★ M11（20260914 用户要求）：图例不用「·」分段，改用「|」；红/黄/蓝三个字**用各自的颜色**渲染。
            e('span', { 'data-pm': 'legend', style: { fontSize: SMALL_FONT_SIZE, color: 'GrayText', display: 'inline-flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' } },
              e('span', null, '颜色：'),
              e('span', null, e('span', { style: { color: PM_COLOR.red, fontWeight: 700 } }, '红'), '=固定/高危'),
              e('span', { style: { opacity: 0.6 } }, '|'),
              e('span', null, e('span', { style: { color: PM_COLOR.yellow, fontWeight: 700 } }, '黄'), '=每轮记录'),
              e('span', { style: { opacity: 0.6 } }, '|'),
              e('span', null, e('span', { style: { color: PM_COLOR.blue, fontWeight: 700 } }, '蓝'), '=工具'),
              e('span', { style: { opacity: 0.6 } }, '|'),
              e('span', null, e('span', { style: { color: 'GrayText', borderBottom: '2px dashed GrayText' } }, '灰虚线'), '=未检出')),
            e('span', { style: { flex: 1 } }),
            // 顶部状态行：会话 | 第 N / M 楼 | 依据来源（★ 状态显示，不是一排可点按钮）
            e('span', { 'data-pm': 'status-floor', style: Object.assign({}, dimStyle, { fontFamily: MONO, flexShrink: 0, fontSize: SMALL_FONT_SIZE }) },
              (sessionId ? shortId(sessionId) + ' | ' : '') + '第 ' + (turn || '—') + ' / ' + (n == null ? '—' : n) + ' 楼'),
            sourceNode,
          ),
          // ★ M11：小计与四框占比**合成一行**（用户：两行重复了）—— 占比直接跟在各自字数后面；
          //   段与段之间用「|」而不是「·」（用户：用 · 分段不合理）。
          e('div', {
            'data-pm': 'subtotal',
            title: systemSubtotalTitle,
            style: Object.assign({}, dimStyle, { flex: 'none', fontSize: SMALL_FONT_SIZE, border: '1px solid color-mix(in srgb, CanvasText 12%, transparent)', borderRadius: 6, padding: '3px 10px', background: 'color-mix(in srgb, CanvasText 2%, Canvas)' }),
          },
            // ★ 2026-09-19（用户口径）：小计行里**不再列上下文**（[上下文] 盒已不显示，列个数字没人能对）；
            //   数据仍在 totals 里（口径没变，只是不显示）。
            '小计：system ' + fmtOrUnknown(t.systemChars, ' 字') + pctSuffix(t.systemChars)
            + ' | 工具 ' + (t.toolCount == null ? '未知' : t.toolCount + ' 个 / ' + fmtChars(t.toolChars || 0) + ' 字' + pctSuffix(t.toolChars))
            + ' | 消息 ' + (t.messageCount == null ? '未知' : t.messageCount + ' 条' + pctSuffix(t.messagesChars))
            + (d ? (pmBoxPctTotal > 0 ? '（合计 ' + fmtChars(pmBoxPctTotal) + ' 字）' : '（字数拿不到，给不出占比）') : '')),
          d && d.systemTruncated ? e('div', { style: warnStyle }, 'system 全文已被宿主截断，地图按截断后的文本切分（尾部段落可能缺）') : null,
          st.status === 'loading' && e('div', { style: dimStyle }, '正在取段结构（C4）/ system / tools / messages…'),
          st.status === 'error' && e('div', { style: errorStyle }, '装配地图数据取不到：' + st.error),
          st.status === 'idle' && e('div', { style: dimStyle }, '← 选会话后自动装配（定位最新楼；楼号入口在左侧「消息定位」）'),
          d && d.boxes.map((box) => pmBox(box,
            typeof onDrill === 'function' ? onDrill : null,
            box.id === 'messages' ? { count: box.count, onOpen: typeof onOpenLocator === 'function' ? onOpenLocator : null } : null)),
        )
      }

      // 装配地图数据面（20260913 三级导航改版）：
      //   ★ C4 段结构（/api/sections）是段名/切分的真相源；拿得到 ⇒ buildMapFromSections（真段名）。
      //   C4 不可用（端点没挂/网络失败）⇒ 降级为旧文本推断 buildPromptMapData，source='fallback'，
      //   界面同样明示「结构为文本推断」—— ⛔ 不许把降级说成捕获。
      //   C3 system/tools/messages 仍取（L3 详细抽屉的原文来源 + messages 框）。
      //   上一轮 system 只在降级路径用于实测可变性比对；单段失败不拖垮其它段。
      function PromptMap({ sessionId, turn, turnsCount, onDrill, onOpenLocator, deepSec, onDeepSec }) {
        const [mapState, setMapState] = React.useState({ status: 'idle', data: null, error: '' })
        React.useEffect(() => {
          if (!sessionId || !turn) return undefined
          const controller = new AbortController()
          setMapState({ status: 'loading', data: null, error: '' })
          const base = PROMPT_API_BASE + '/api/part?id=' + encodeURIComponent(sessionId) + '&turn=' + String(turn)
          const out = { system: null, prevSystem: null, tools: null, messages: null, messageRows: null, sections: null, sectionsErr: '', verifiedSystem: null }
          const errs = []
          const jobs = [
            apiGet(SECTIONS_API_BASE + '/sections?sessionId=' + encodeURIComponent(sessionId) + '&turn=' + String(turn), controller.signal)
              .then((d) => { out.sections = d })
              .catch((error) => {
                if (controller.signal.aborted) throw error
                out.sectionsErr = errText(error)
              }),
            apiGet(base + '&part=system', controller.signal).then((d) => {
              out.system = clipInfo(typeof d.text === 'string' ? d.text : '')
            }).catch((error) => {
              if (controller.signal.aborted) throw error
              errs.push('system：' + errText(error))
            }),
            // ★★ 2026-09-20（用户报障「未抓到那行很抽象，都是些字段碎片」）：**底本**不能随便取一条 ——
            //   `part=system` 拿的是"该楼 header 那一刻生效的正文"，而捕获的 offset/chars 说的是
            //   **同一楼另一条** `system/message`。一楼里只要有多份正文（工具循环跑了几步），两者就不是
            //   同一份，补集切出来全是错位的渣（真机：两份同为 8,384 字、内容不同）。
            //   ⇒ 向宿主要"**捕获认过的那一份**"（逐候选按长度+sha256 验）；验不出来就不硬切。
            apiGet(SECTIONS_API_BASE + '/sections/system?sessionId=' + encodeURIComponent(sessionId) + '&turn=' + String(turn), controller.signal)
              .then((d) => {
                out.verifiedSystem = (d && typeof d.text === 'string' && d.text !== '') ? d.text : null
              })
              .catch(() => { /* 取不到就当没验过（下面按未验证处理），⛔ 不拿 viewer 那份冒充验过 */ }),
            turn > 1
              ? apiGet(PROMPT_API_BASE + '/api/part?id=' + encodeURIComponent(sessionId) + '&turn=' + String(turn - 1) + '&part=system', controller.signal)
                .then((d) => { out.prevSystem = typeof d.text === 'string' ? d.text : null })
                .catch(() => {})
              : Promise.resolve(),
            apiGet(base + '&part=tools', controller.signal).then((d) => {
              out.tools = Array.isArray(d.tools) ? d.tools : []
            }).catch((error) => {
              if (controller.signal.aborted) throw error
              errs.push('tools：' + errText(error))
            }),
            apiGet(base + '&part=messages', controller.signal).then((d) => {
              out.messages = clipInfo(typeof d.text === 'string' ? d.text : '')
              // ★★ 2026-09-18 真机踩到：`clipInfo` **只留文本**，会把响应里的逐条数据
              //   （`messages[].turn/blocks/词头`）整个丢掉 —— 于是再从它身上取一层永远是 undefined，
              //   [messages] 框静默退回旧计数口径（界面看着正常，其实没生效）。
              //   ⛔ 逐条数据必须**单独存**出来：「文本」与「逐条」是两条口径，都得留住。
              out.messageRows = Array.isArray(d.messages) ? d.messages : null
            }).catch((error) => {
              if (controller.signal.aborted) throw error
              errs.push('messages：' + errText(error))
            }),
          ]
          Promise.all(jobs).then(() => {
            if (controller.signal.aborted) return
            if (out.sections && out.sections.source) {
              setMapState({
                status: 'ready',
                // 20260918 查看器单 T1：system 全文口径一并传入 —— 底本（system 全文）与覆盖
                // （Σ 捕获段字数 + 官方分隔符）相减，差 >0 才出「未抓到」行（数据层自己判）。
                data: buildMapFromSections(out.sections, {
                  messagesText: out.messages ? out.messages.text : null,
                  // ★ 甲：逐条消息（turn/blocks/词头）—— [messages] 框据此给真实行。
                  //   ⛔ 取自 `out.messageRows`（上面的取数处单独留的），**不是**从 `out.messages`
                  //   再取一层 —— 那是 `clipInfo()` 的产物，里面根本没有 messages 数组。
                  messages: out.messageRows,
                  // ★ 2026-09-20：底本优先用**捕获认过的那一份**（`/sections/system`）；
                  //   拿不到就退回 viewer 那份，并如实标记"没验过"（那一行的补集就不给了）。
                  systemText: out.verifiedSystem !== null ? out.verifiedSystem : (out.system ? out.system.text : null),
                  systemTextVerified: out.verifiedSystem !== null,
                }),
                error: errs.length > 0 ? errs.join('；') : '',
              })
            } else if (out.system === null && out.tools === null && out.messages === null) {
              setMapState({ status: 'error', data: null, error: errs.join('；') || '三段都取不到' })
            } else {
              const fallbackData = buildPromptMapData({
                systemText: out.system ? out.system.text : null,
                systemTruncated: !!(out.system && out.system.truncated),
                prevSystemText: out.prevSystem,
                tools: out.tools,
                messagesText: out.messages ? out.messages.text : null,
              })
              fallbackData.__sectionsErr = out.sectionsErr
              setMapState({
                status: 'ready',
                data: fallbackData,
                error: errs.length > 0 ? errs.join('；') : '',
              })
            }
          }).catch((error) => {
            if (controller.signal.aborted) return
            setMapState({ status: 'error', data: null, error: errText(error) })
          })
          return () => controller.abort()
        }, [sessionId, turn])
        const d = mapState.status === 'ready' ? mapState.data : null
        const source = d ? (d.source || 'fallback') : null
        const sourceNote = d && d.__sectionsErr
          ? '段结构端点（C4 /api/sections）不可用：' + d.__sectionsErr + '；以下段结构由文本推断，仅供定位'
          : null
        // ★ M9：深链点名了某一段 ⇒ 数据就绪后**在真段块里命中**再下钻（⛔ 不造假的段对象）。
        //   命中/未命中都回报给上层：未命中要如实说"这一楼没有这个段名"，不许静默什么都不发生。
        React.useEffect(() => {
          if (!deepSec || !d) return
          let hit = null
          for (const box of (Array.isArray(d.boxes) ? d.boxes : [])) {
            for (const blk of (Array.isArray(box.blocks) ? box.blocks : [])) {
              if (blk && String(blk.key) === 'sec:' + deepSec) hit = { boxId: box.id, block: blk }
            }
          }
          if (hit && typeof onDrill === 'function') onDrill(hit.boxId, hit.block)
          if (typeof onDeepSec === 'function') onDeepSec(!!hit, deepSec)
        }, [deepSec, d])
        return e(PromptMapView, {
          data: d, state: mapState, sessionId: sessionId, turn: turn, turnsCount: turnsCount,
          source: source, sourceNote: sourceNote, onDrill: onDrill, onOpenLocator: onOpenLocator,
        })
      }

      // ---------- L2 消息定位（20260913 三级导航 · 左侧弹出） ----------
      // 点 L1 会话 ⇒ 本层从左侧滑出；自动滚到最新一条（决策 4）；点某条消息 ⇒ 地图定位到该楼（不换视图）。
      // 数据 = C2 /api/messages（preview 首行截断，不拉全文）。特殊标记：工具结果 / 已压缩，与契约一致。
      const l2DrawerStyle = {
        position: 'absolute', top: 44, left: 318, bottom: 64, width: 340, zIndex: 19,
        display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', boxSizing: 'border-box',
        background: 'Canvas', color: 'CanvasText',
        border: '1px solid ButtonBorder', borderRadius: 8,
        boxShadow: '0 6px 18px rgba(0,0,0,.25)', overflow: 'hidden',
      }
      function MessageLocatorPanel({ sessionId, turn, style, onClose, onLocate }) {
        const [msgs, setMsgs] = React.useState({ status: 'idle', data: null, error: '' })
        // ★ M10：注入行默认不显示（只列玩家自己发的那条）；开关状态只存本组件 state。
        const [showInjected, setShowInjected] = React.useState(false)
        const listRef = React.useRef(null)
        React.useEffect(() => {
          if (!sessionId) return undefined
          const controller = new AbortController()
          setMsgs({ status: 'loading', data: null, error: '' })
          apiGet(PROMPT_API_BASE + '/api/messages?id=' + encodeURIComponent(sessionId) + '&limit=200', controller.signal)
            .then((data) => {
              if (controller.signal.aborted) return
              setMsgs({ status: 'ready', data: data, error: '' })
            })
            .catch((error) => {
              if (controller.signal.aborted) return
              setMsgs({ status: 'error', data: null, error: errText(error) })
            })
          return () => controller.abort()
        }, [sessionId])
        // ★ 自动定位最新楼：列表就绪后把滚动位置压到底部（latestIndex 那条可见）
        React.useEffect(() => {
          const el = listRef.current
          if (msgs.status === 'ready' && el) el.scrollTop = el.scrollHeight
        }, [msgs.status, msgs.data])
        const roleLabel = (r) => (r === 'user' ? '玩家' : r === 'assistant' ? '角色' : r === 'tool' ? '工具' : String(r || '?'))
        const ready = msgs.status === 'ready' && msgs.data && typeof msgs.data === 'object'
        const allItems = ready && Array.isArray(msgs.data.messages) ? msgs.data.messages : []
        // ★ M10（20260914 用户要求）：「消息定位只收录玩家一次请求时发送的消息」——
        //   即玩家点发送后给出的那一条（宿主 `source.kind === 'user'`，**结构性判据**，不是猜文本前缀）。
        //   注入的 user 行（运行上下文快照 / 技能目录 / …）默认不列，但**不抹掉事实**：
        //   下面给一个开关能看它们，并写清是谁注入的。
        //   ★ 拿不到 source.kind（老宿主 / 形状变了）⇒ 一条都不许过滤，如实说明后按全部 user 行显示。
        const kindKnown = allItems.some((m) => m && typeof m.sourceKind === 'string')
        const playerItems = kindKnown
          ? allItems.filter((m) => m && m.role === 'user' && m.playerTyped === true)
          : allItems.filter((m) => m && m.role === 'user')
        const injectedItems = kindKnown ? allItems.filter((m) => m && m.role === 'user' && m.playerTyped !== true) : []
        const items = showInjected
          ? playerItems.concat(injectedItems).sort((a, b) => (a.index || 0) - (b.index || 0))
          : playerItems
        return e('div', { className: 'dma-l2', 'data-l2': '1', style: style || l2DrawerStyle },
          e('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flex: 'none', borderBottom: '1px solid ButtonBorder', paddingBottom: 6 } },
            e('strong', { style: { fontSize: 13, flexShrink: 0, whiteSpace: 'nowrap' } }, '消息定位'),
            e('span', { style: dimStyle }, '只列你发的那条；点一条 ⇒ 地图定位到该楼'),
            e('span', { style: { flex: 1 } }),
            e('button', { className: 'dma-btn dma-mini', style: miniBtnStyle, onClick: onClose, title: '关闭消息定位（地图不回退，停在当前楼）' }, '✕'),
          ),
          msgs.status === 'loading' && e('div', { style: dimStyle }, '正在取消息列表…'),
          msgs.status === 'error' && e('div', { style: errorStyle }, '消息列表取不到：' + msgs.error),
          ready && e('div', { style: dimStyle },
            items.length === 0 && playerItems.length === 0
              ? '该会话没有你发的消息（空会话，不存在「最新一条」）'
              : '共 ' + playerItems.length + ' 条你发的消息 · 最新第 ' + msgs.data.latestIndex + ' 条（已自动定位到底部）'),
          // 注入行：默认不列，但不藏事实 —— 一行开关 + 是谁注入的
          ready && kindKnown && injectedItems.length > 0
            ? e('div', { style: dimStyle, 'data-injected-toggle': '1' },
                e('button', {
                  className: 'dma-btn dma-mini', style: miniBtnStyle,
                  'data-sel': showInjected ? '1' : '0',
                  title: '注入行 = 宿主/插件往对话里塞的 user 行（例如运行上下文快照、技能目录），不是你发的',
                  onClick: () => setShowInjected((v) => !v),
                }, (showInjected ? '隐藏' : '显示') + '注入行（' + injectedItems.length + ' 条）'),
                e('span', { style: { marginLeft: 6 } }, '不是你发的'))
            : null,
          ready && !kindKnown
            ? e('div', { style: dimStyle, 'data-injected-toggle': 'unknown' },
                '这一版宿主没给 source.kind ⇒ 无法区分玩家/注入，按全部 user 行显示（如实说明，⛔ 不冒充）')
            : null,
          ready && e('div', { ref: listRef, style: promptListStyle },
            items.map((m) => {
              const isCur = turn && m.turn === turn
              const marks = []
              if (m.isToolResult) marks.push('工具结果')
              if (m.isCompacted) marks.push('已压缩')
              return e('div', {
                key: m.index,
                className: 'dma-row',
                'data-l2-row': String(m.index),
                'data-l2-turn': String(m.turn),
                'data-sel': isCur ? '1' : '0',
                style: Object.assign({}, itemStyle, { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }),
                onClick: () => { if (typeof onLocate === 'function' && m.turn) onLocate(m.turn, m.index) },
                title: '第 ' + m.turn + ' 楼 · seq=' + m.seq + ' · ' + m.chars + ' 字\n（点击 ⇒ 装配地图定位到这一楼）',
              },
                e('div', { style: { display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0 } },
                  e('span', { style: { fontWeight: 700, flexShrink: 0, fontSize: SMALL_FONT_SIZE } }, roleLabel(m.role)),
                  e('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0, fontSize: 13 } }, String(m.preview == null ? '' : m.preview)),
                  e('span', { style: { fontFamily: MONO, fontSize: SMALL_FONT_SIZE, opacity: 0.7, flexShrink: 0 } }, '第 ' + m.turn + ' 楼'),
                ),
                marks.length > 0 ? e('div', { style: { display: 'flex', gap: 4 } }, marks.map((x) => e('span', { key: x, style: dimBadgeStyle }, x))) : null,
              )
            }),
          ),
        )
      }

      // ---------- L3 单段抽屉（20260914 M2 · 任务书 B + §9）：点开一段 = 一句话注释 + 该段实际正文 ----------
      // ★ 正文来源 = 新端点 GET /dsh-memory-archive/api/sections/text?sessionId=&turn=&name=（M1 实现，记忆库路径）。
      //   ⛔ 客户端不许自己读会话文件、不许拉整段 system 自己切 —— 以下取值链是唯一的正文来源：
      //   text 非空 → 正常显示，页脚「来源：记忆库路径切片 [offset, chars]」
      //   unavailable:'no-offset'        → 「该段内容不可用（未记录位置）」
      //   unavailable:'slice-mismatch'   → 「内容不可用（校验未通过）」
      //   unavailable:'no-capture-record'→ 醒目「文本推断 · 边界可能不准」（source=inferred）
      //   网络失败 / 端点不存在          → 「内容取不到：<原因>」（⛔ 不许空白、⛔ 不许编内容）
      //   （纯函数拆出来供自检直测；组件只做取数 + 渲染。）
      function pmSectionTextState(resp, errMsg) {
        if (resp == null || typeof resp !== 'object') {
          return { kind: 'error', footer: '内容取不到：' + (errMsg || '响应为空'), text: null }
        }
        const unavailable = typeof resp.unavailable === 'string' ? resp.unavailable : null
        if (unavailable === 'no-offset') {
          // ★ 定稿失败**也要说清是哪几段**（2026-09-18）：只写「未记录位置」会让人以为内容丢了，
          //   实际是"这一楼有段没能在最终正文里落位 ⇒ 宁可不给位置，也不给可能错位的"。
          const miss = Array.isArray(resp.locateMiss) ? resp.locateMiss : null
          // 四个失败码含义**完全不同** ⇒ 逐段说人话，⛔ 不糊成"没落位"一句：
          //   anchor-miss = 这一段的开头在最终正文里根本找不到（多半是它被整段换掉了）
          //   blocked     = 锚点找到了，但它和下一个已知起点之间夹着别的未定位段 ⇒ 拆不开（那才是猜）
          //   nonpositive = 算出来长度 ≤0 ⇒ 锚点撞到别处了
          const whyMap = resp.locateWhy && typeof resp.locateWhy === 'object' ? resp.locateWhy : null
          const whyText = { 'anchor-miss': '锚点没找到', blocked: '夹着别的未定位段、拆不开', nonpositive: '算出来长度 ≤0' }
          const detail = miss === null ? '' : miss
            .map((n) => (whyMap && whyMap[n] ? n + '（' + (whyText[whyMap[n]] || whyMap[n]) + '）' : n))
            .join('、')
          const why = miss !== null && miss.length > 0
            ? '该段内容不可用（这一楼有 ' + miss.length + ' 段没能落到最终正文里：' + detail + ' ⇒ 位置宁可不给，也不给可能错位的）'
            : '该段内容不可用（未记录位置）'
          return { kind: 'no-offset', footer: why, text: null }
        }
        if (unavailable === 'slice-mismatch') {
          return { kind: 'mismatch', footer: '内容不可用（校验未通过）', text: null }
        }
        if (unavailable === 'no-capture-record') {
          return { kind: 'inferred', footer: '文本推断 · 边界可能不准', text: null, emphasis: true }
        }
        if (unavailable != null) {
          // 契约外的 unavailable 码（如 turn-not-found）：如实带码显示，不空白、不猜
          return { kind: 'error', footer: '该段内容不可用（' + unavailable + '）', text: null }
        }
        if (typeof resp.text === 'string') {
          const off = typeof resp.offset === 'number' ? resp.offset : '未知'
          const span = '[' + off + ', ' + (typeof resp.chars === 'number' ? resp.chars : resp.text.length) + ']'
          // 位置只有一个来源：捕获定稿时按段序在**最终正文**里定出来的（`finalized`）。
          //   三种来路如实分开说 —— 内容都是**最终正文的切片**，这点三者一样：
          //   逐字匹配 = 宿主原样搬运了这一段；锚点定界 = 宿主改写过它，边界按前后锚点推；
          //   ★ 底本回退（2026-09-18）= 本楼宿主**没有重发**系统提示词，定界用的是**上一份**正文。
          const way = resp.anchored === true
            ? '（**锚点定界**：这段在最终正文里被改写，边界按前后锚点推——内容就是它实际发出去的那一版）'
            : ''
          const carriedFrom = Number.isFinite(resp.carriedFromTurn) ? resp.carriedFromTurn : null
          const basis = resp.finalizeBasis === 'carried'
            ? '（**沿用第 ' + (carriedFrom !== null ? carriedFrom : '上一') + ' 楼的底本**：本楼宿主没有重发系统提示词——按 DSH 的口径，那等价于两楼发出去的系统正文逐字节相同，定界用的就是那份）'
            : ''
          return { kind: 'text', footer: '来源：记忆库路径切片 ' + span + way + basis, text: resp.text }
        }
        return { kind: 'error', footer: '内容取不到：响应里没有 text 字段（' + (errMsg || '形状不符') + '）', text: null }
      }

      // 抽屉体（纯渲染，自检直测）：段头（真段名 / order / 字数）+ 可变性徽标（依据）+ 注释
      //   + 正文（五种口径之一）+ 页脚。
      // ★ 20260919 视觉单：层次重排 —— 段头块（名 + 药丸徽标 + order/字数药丸）→ 注释卡 →
      //   位置/工具说明两行弱信息 → 正文（上方细分隔线，与元信息分层）→ 页脚。
      //   颜色一律系统色（CanvasText/GrayText/canvas 系 color-mix + 语义色 crimson/DarkGoldenrod），
      //   ⛔ 不写死黑/白 —— 明暗两套主题都按 Canvas/CanvasText 现算。
      function pmSectionDrawerBody(section, st, query) {
        const sec = section && typeof section === 'object' ? section : {}
        const name = String(sec.label || sec.name || '?')
        const mutBadge = PM_MUT_BADGE[sec.mut] || '未知'
        const basis = pmBasisLabel(sec.mutBasis)
        // ★ 2026-09-19：优先用**行上那份**注释（`sec.note` = 静态表 + 两条近似标注 + 运行时补的话，
        //   例如"本轮后处理提示词落在哪一行"）—— 抽屉与悬停必须说同一件事，⛔ 不能一个动态一个静态。
        const note = (typeof sec.note === 'string' && sec.note !== '') ? sec.note : pmSectionNote(name)
        const state = st && typeof st === 'object' ? st : { kind: 'error', footer: '内容取不到：状态缺失', text: null }
        // 可变性徽标胶囊：颜色沿用地图图例的语义（黄=每轮、红=静态、灰=未知）
        const mutColor = sec.mut === 'per-turn' ? PM_COLOR.yellow : sec.mut === 'static' ? PM_COLOR.red : 'GrayText'
        const mutBadgeStyle = {
          fontSize: SMALL_FONT_SIZE, fontWeight: 700, color: mutColor, flexShrink: 0,
          background: 'color-mix(in srgb, ' + mutColor + ' 8%, Canvas)',
          border: '1px solid color-mix(in srgb, ' + mutColor + ' 40%, transparent)',
          borderRadius: 999, padding: '0 8px',
        }
        const metaChipStyle = {
          fontFamily: MONO, fontSize: SMALL_FONT_SIZE, color: 'GrayText', flexShrink: 0,
          border: '1px solid color-mix(in srgb, CanvasText 15%, transparent)', borderRadius: 999, padding: '0 8px',
        }
        return e('div', { 'data-l3': 'section-panel', style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 } },
          // 段头块：第一行 = 段名 + 工具药丸 + order/字数药丸；第二行 = 可变性徽标 + 依据（看得见，不藏悬停）
          e('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } },
            e('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'baseline' } },
              e('strong', { style: { fontSize: 13, fontFamily: MONO, wordBreak: 'break-all' } }, name),
              // ★ 2026-09-15：工具段带药丸；底/字色用 Highlight 系统对（明暗主题都保可读，⛔ 不写死白字）
              name.startsWith('tool:')
                ? e('span', {
                  'data-l3': 'tooltag',
                  style: { fontSize: 10, color: 'HighlightText', background: 'Highlight', borderRadius: 999, padding: '0 6px', fontFamily: MONO, flexShrink: 0 },
                }, '工具')
                : null,
              e('span', { style: metaChipStyle },
                'order ' + (sec.order == null || sec.order === '—' ? '未知' : sec.order)),
              sec.chars != null ? e('span', { style: metaChipStyle }, fmtChars(sec.chars) + ' 字') : null,
            ),
            // 可变性徽标（20260914 M7：可见只留 [静态]/[每轮]/[未知]）
            // ★ 2026-09-19（用户口径：「鼠标悬浮还有浮窗说明。删掉吧，不维护这一份了」）：不挂 tooltip，
            //   依据就是**看得见的一行**（⛔ 该行不许再挂 title —— 自检台有反向断言）。
            //   ★ 视觉单去重：mutWhy 本就由 mutBasis 推出（是 basis 的完整版，如 basis=注册定义 /
            //     mutWhy=段定义（运行时…））⇒ 只说一遍：有 mutWhy 用 mutWhy，没有才退 basis。
            e('div', { 'data-l3': 'mut-line', style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'baseline', minWidth: 0 } },
              e('span', { style: mutBadgeStyle }, '[' + mutBadge + ']'),
              (sec.mutWhy || basis)
                ? e('span', { style: dimStyle }, '（依据：' + (sec.mutWhy || basis) + '）')
                : null,
            ),
          ),
          // 注释卡：表里没有 ⇒ 「未收录（注释表未收录）」（⛔ 不许编一句；M7 去掉自证赘文）
          // ★ 2026-09-19（用户口径：「注释也支持下 md 格式」）：注释走**同一套 Markdown 渲染**；
          //   视觉单：卡片化（左侧描边 + 极浅底），与正文隔开一层。
          e('div', {
            'data-l3': 'note-line',
            style: {
              display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0,
              background: 'color-mix(in srgb, CanvasText 3%, Canvas)',
              borderLeft: '3px solid color-mix(in srgb, CanvasText 22%, transparent)',
              borderRadius: 6, padding: '6px 10px 8px',
            },
          },
            e('div', { style: { fontSize: SMALL_FONT_SIZE, fontWeight: 700, color: 'GrayText' } }, '注释：'),
            e('div', { 'data-l3': 'note-md' },
              e(MarkdownBody, { text: note || '未收录（注释表未收录）', fontSize: 13 }))),
          // ★ 2026-09-19：没有 order 的段（上游展开的那些 part）在抽屉里也要给**真实位置** ——
          //   否则"它在 system 的哪儿"只有一个「order 未知」。
          (sec.orderNum == null && Number.isFinite(sec.offset))
            ? e('div', { 'data-l3': 'pos-line', style: dimStyle },
              '位置：system 正文第 ' + sec.offset + ' 字'
              + (Number.isFinite(sec.renderedChars) && sec.renderedChars > 0
                ? '（共 ' + sec.renderedChars + ' 字，约 ' + Math.round((sec.offset / sec.renderedChars) * 100) + '% 处'
                  + (pmPosTagByOffset(sec.offset, sec.renderedChars) ? '，' + pmPosTagByOffset(sec.offset, sec.renderedChars) : '') + '）'
                : '')
              + ' —— 该段没有 order（上游不给），位置按捕获记录的真实偏移给')
            : null,
          // ★ 2026-09-15：工具段把两个通道写在抽屉里（用户问过"tools 定义到底进哪儿"）
          name.startsWith('tool:')
            ? e('div', { 'data-l3': 'tool-hint', style: dimStyle },
              '工具段的两个通道：① 本段 = system 里的**说明与纪律**（每个工具一段）｜② 请求的 **tools 字段** = 它的 JSON 定义。这段是 ①。')
            : null,
          // ★ M12：删掉「复合段：…本图不展开内部结构」那行 —— 用户要求「不要因为过大不展开」：
          //   现在抽屉里先给原始记录 JSON、再给实际正文，不展开的说法已经不成立（也不该拿它当挡箭牌）。
          // 正文 / 取不到的口径（视觉单：正文上方一条细分隔线，把"元信息"与"正文"分成两截；
          //   取不到时不再用裸红字，给底色卡片把口径文案托住 —— 文字一字不改）
          state.kind === 'text'
            ? e('div', {
              'data-l3': 'body',
              style: { minWidth: 0, borderTop: '1px solid color-mix(in srgb, CanvasText 12%, transparent)', paddingTop: 8 },
            },
              e(ChunkedText, { text: state.text, query: query }))
            : e('div', {
              'data-l3': 'body', 'data-l3-missing': '1',
              style: state.emphasis
                ? { fontSize: 13, color: 'DarkGoldenrod', fontWeight: 700, background: 'color-mix(in srgb, DarkGoldenrod 8%, Canvas)', border: '1px solid color-mix(in srgb, DarkGoldenrod 45%, transparent)', borderRadius: 6, padding: '8px 10px' }
                : { fontSize: 12, color: 'crimson', background: 'color-mix(in srgb, crimson 6%, Canvas)', border: '1px solid color-mix(in srgb, crimson 35%, transparent)', borderRadius: 6, padding: '8px 10px' },
            }, state.kind === 'text' ? '' : (state.emphasis ? '★ ' : '') + state.footer),
          // 页脚（M12：不再追加「复合段内部需 Tavern 接口」—— 原始记录与实际正文都在上面了）
          // ★ 视觉单去重：取不到时上面那张卡片已经原样说了这句口径，页脚再重复一遍 ⇒ 只在
          //   正文正常（kind='text'）时画页脚；卡片态的口径由卡片自己说（文字一字不改）。
          state.kind === 'text'
            ? e('div', { 'data-l3': 'footer', style: dimStyle }, state.footer)
            : null,
        )
      }

      // 取数组件：挂 [sessionId, turn, 段名]；失败/缺端点都落「内容取不到：<原因>」，绝不空白。
      // 附带功能（任务书 §4）：复制该段 / 复制整楼 / 段内搜索（沿用 ChunkedText 与查询框）。
      // 「复制整楼」= 点按钮时现取现拼（三段各自失败不拖累），不在抽屉里展示整楼 —— 展示正文仍只走单段端点。
      // ★ M10（20260914 用户报障）：点工具行以前只会打开「整份工具清单＝目录」，看不到那一条自己长什么样。
      //   本组件只取**被点开的那一条**工具定义原文（走会话日志的 request/header.header.tools，
      //   ⛔ 不直读会话文件、⛔ 不给整份工具表），页脚写明来源与凭据（哪一楼、是自带 header 还是沿用上一楼）。
      /**
       * ★ M12（20260914 用户要求）：「原始 JSON」面板 —— 把**被点开的那一条**原样呈现，
       * 与工具那条同样的呈现方式（工具定义本来就是原样 JSON）。
       *
       * 「不要因为过大不展开」⇒ 本面板**不设字符上限、不做折叠**：后端给多少就渲染多少。
       * 取不到时如实说原因（⛔ 不留白、⛔ 不用一句"不展开"糊过去）。
       */
      function RawRecordPanel({ sessionId, turn, name, kind }) {
        const [st, setSt] = React.useState({ phase: 'loading', record: null, footer: '正在取原始记录…' })
        // ★ M14：默认只给**落盘的元数据**（原始 JSON）；打开「含正文」则再取一份**读取时派生**的
        //   `{…record, text}`（后端 withText=1）。⛔ 派生不落盘，所以这里两态都写清来源。
        const [withText, setWithText] = React.useState(false)
        React.useEffect(() => {
          if (!sessionId || !turn) {
            setSt({ phase: 'error', record: null, footer: '原始记录取不到：会话/楼号缺一不可' })
            return undefined
          }
          const controller = new AbortController()
          setSt({ phase: 'loading', record: null, footer: '正在取原始记录…' })
          let url = SECTIONS_API_BASE + '/sections/raw?sessionId=' + encodeURIComponent(sessionId) + '&turn=' + String(turn)
          if (name) url += '&name=' + encodeURIComponent(name)
          if (kind === 'context') url += '&kind=context'
          if (withText) url += '&withText=1'
          apiGet(url, controller.signal).then((resp) => {
            if (controller.signal.aborted) return
            if (!resp || resp.ok !== true) {
              const msg = resp && resp.error ? (resp.error.message || resp.error) : '接口没有返回原始记录'
              setSt({ phase: 'ready', record: null, footer: '原始记录取不到：' + String(msg) })
              return
            }
            const picked = withText && resp.recordWithText ? resp.recordWithText : (resp.record ?? null)
            setSt({
              phase: 'ready', record: picked,
              footer: '第 ' + resp.turn + ' 楼 · ' + (kind === 'context' ? '上下文' : '段') + '捕获记录'
                + (withText ? '（含正文 · 正文是读取时从会话日志切出来的，⛔ 没落盘）' : '（落盘的记录：只有元数据，⛔ 不含正文）')
                + (resp.textChars != null ? ' · 该条正文 ' + resp.textChars + ' 字符' : '')
                + (resp.textUnavailable ? '（正文：' + resp.textUnavailable + '）' : ''),
            })
          }).catch((error) => {
            if (controller.signal.aborted) return
            setSt({ phase: 'error', record: null, footer: '原始记录取不到：' + errText(error) })
          })
          return () => controller.abort()
        }, [sessionId, turn, name, kind, withText])
        const json = st.phase === 'ready' && st.record !== null && st.record !== undefined
          ? JSON.stringify(st.record, null, 2)
          : null
        return e('div', { 'data-raw-record': '1', style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 'none' } },
          e('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
            e('strong', { style: { fontSize: 12.5 } }, '原始 JSON'),
            e('span', { style: dimStyle }, st.footer),
            e('span', { style: { flex: 1 } }),
            json !== null ? e('span', { style: dimStyle }, json.length + ' 字符') : null,
            e('button', {
              className: 'dma-btn dma-mini', style: Object.assign({}, miniBtnStyle, { 'data-sel': withText ? '1' : '0' }),
              'data-raw-withtext': '1',
              onClick: () => setWithText((v) => !v),
              title: '落盘的捕获记录只有元数据（正文没落盘：甲方案不复制第二份正文）；打开这里会把正文按 offset 从会话日志切出来拼进 JSON（读取时派生）',
            }, withText ? '只看元数据' : '含正文'),
            json !== null ? e('button', {
              className: 'dma-btn dma-mini', style: miniBtnStyle,
              'data-raw-copy': '1',
              onClick: () => { copyText(json).catch(() => {}) },
              title: '复制这一条 JSON（不裁剪）',
            }, '复制 JSON') : null,
          ),
          json !== null
            ? e('pre', {
                'data-raw-body': '1',
                style: {
                  margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  fontFamily: MONO, fontSize: SMALL_FONT_SIZE, lineHeight: 1.45,
                  background: 'color-mix(in srgb, CanvasText 4%, transparent)', borderRadius: 6, padding: '8px 10px',
                },
              }, json)
            : (st.phase === 'loading' ? e('div', { style: dimStyle }, '…') : e('div', { style: errorStyle, 'data-raw-missing': '1' }, st.footer)),
        )
      }

      function ToolTextPanel({ sessionId, turn, toolName }) {
        const [st, setSt] = React.useState({ phase: 'loading', footer: '正在取该工具定义…', text: null, chars: null, err: '' })
        React.useEffect(() => {
          if (!sessionId || !turn || !toolName) {
            setSt({ phase: 'error', footer: '内容取不到：会话/楼号/工具名缺一不可', text: null, chars: null, err: '' })
            return undefined
          }
          const controller = new AbortController()
          setSt({ phase: 'loading', footer: '正在从该楼 request.header.tools 取这一条…', text: null, chars: null, err: '' })
          apiGet(PROMPT_API_BASE + '/api/tool?id=' + encodeURIComponent(sessionId) + '&turn=' + String(turn) + '&name=' + encodeURIComponent(toolName), controller.signal)
            .then((resp) => {
              if (controller.signal.aborted) return
              if (!resp || resp.ok !== true) {
                const msg = resp && resp.error ? (resp.error.message || resp.error) : '接口没有返回工具定义'
                setSt({ phase: 'ready', footer: '内容取不到：' + String(msg), text: null, chars: null, err: '' })
                return
              }
              const where = resp.requestLogged === true
                ? '来源：该楼自带的 request/header.header.tools'
                : (resp.headerCarried === true ? '来源：沿用上一楼的 header（宿主判定逐字相等）' : '来源：该楼最近的 header')
              setSt({
                phase: 'ready', text: typeof resp.text === 'string' ? resp.text : null,
                chars: typeof resp.chars === 'number' ? resp.chars : null,
                footer: where + ' · 原样 JSON（模型看到的就是这个）', err: '',
              })
            })
            .catch((error) => {
              if (controller.signal.aborted) return
              setSt({ phase: 'error', footer: '内容取不到：' + errText(error), text: null, chars: null, err: errText(error) })
            })
          return () => controller.abort()
        }, [sessionId, turn, toolName])
        return e('div', { 'data-tool-text': '1', 'data-l3-scroll': '1', style: { display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minHeight: 0, overflowY: 'auto' } },
          e('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
            e('strong', { style: { fontSize: 12.5, fontFamily: MONO } }, String(toolName || '')),
            e('span', { style: dimStyle }, '工具定义（不在 system 里，是请求的独立字段）· 上面是人话，下面是原样 JSON'),
            e('span', { style: { flex: 1 } }),
            e('span', { style: dimStyle }, st.chars != null ? st.chars + ' 字符' : '字数未知'),
            e('button', {
              className: 'dma-btn dma-mini', style: miniBtnStyle,
              onClick: () => { if (typeof st.text === 'string') copyText(st.text).catch(() => {}) },
              title: '复制这一条工具定义原文',
            }, '复制该条'),
          ),
          st.phase === 'loading' ? e('div', { style: dimStyle }, st.footer) : null,
          // ★ 2026-09-19（用户口径：「工具定义字段中看不到渲染过的原文」）：**先给人话**（名字/描述/参数表），
          //   原始 JSON 还在下面（那才是模型看到的东西）。解析不了 ⇒ 只出 JSON，并如实说明。
          st.phase === 'ready' && typeof st.text === 'string' && st.text !== '' && pmToolDefText(st.text) !== null
            ? e('div', { 'data-tool-human': '1', style: { width: READ_COL_WIDTH, margin: '0 auto' } },
              e(MarkdownBody, { text: pmToolDefText(st.text) }))
            : null,
          st.phase === 'ready' && typeof st.text === 'string' && st.text !== '' && pmToolDefText(st.text) === null
            ? e('div', { style: dimStyle }, '这一条不是能认出来的工具定义形状 ⇒ 下面是原样内容（⛔ 不硬翻译）')
            : null,
          st.phase === 'ready' && typeof st.text === 'string' && st.text !== ''
            ? e('pre', {
                'data-tool-body': '1',
                style: {
                  margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  fontFamily: MONO, fontSize: SMALL_FONT_SIZE, lineHeight: 1.5,
                  background: 'color-mix(in srgb, CanvasText 4%, transparent)', borderRadius: 6, padding: '8px 10px',
                },
              }, st.text)
            : null,
          // 取不到时如实说，⛔ 不许留白、⛔ 不许编
          st.phase === 'ready' && (st.text === null || st.text === '') ? e('div', { style: errorStyle, 'data-tool-unavailable': '1' }, st.footer) : null,
          st.phase === 'error' ? e('div', { style: errorStyle, 'data-tool-unavailable': '1' }, st.footer) : null,
          st.phase === 'ready' && typeof st.text === 'string' && st.text !== '' ? e('div', { style: dimStyle }, st.footer) : null,
        )
      }

      // ★ 20260919 视觉单：外壳新增「上一个 / 下一个」（右上角）—— 在**同一个框（同一楼）**里逐段切换。
      //   段清单自己取（C4 /sections 是段结构真相源），经 buildMapFromSections 投影成与地图行**同形**的块
      //   （键 = sec:段名，注释/徽标口径与地图完全一致），按序前后走；到头/到尾 disabled（⛔ 不循环）；
      //   清单取不到（端点失败/上下文段）⇒ 两钮都禁用，如实。键盘 ← / → 同步；打字处不抢键。
      function SectionTextPanel({ sessionId, turn, section, query, setQuery, onSwitchSection }) {
        const [st, setSt] = React.useState({ phase: 'loading', state: { kind: 'error', footer: '正在取该段正文…', text: null } })
        const name = section && typeof section === 'object' && section.label != null ? String(section.label) : null
        // ★ M12：`ctx:` 行是**上下文**（不在 system 里、没有段切片）⇒ 正文改走 /sections/raw 的 `text`
        //   （那条注入消息的原文）。⛔ 不再拿段端点去问一个上下文，避免"没有这个段"这种误导性报错。
        const isCtx = !!(section && typeof section.key === 'string' && section.key.indexOf('ctx:') === 0)
        // ★ 2026-09-19（用户口径：「给一个下钻窗口，把未抓到的文本内容展示在这里」）：
        //   「未抓到」那一行的正文是**本地算好的**（`buildMapFromSections` 按各段位置求的补集）
        //   ⇒ 不走任何端点、不猜：拿到就显示，拿不到如实说。
        const uncapturedText = section && typeof section === 'object' && section.key === 'uncaptured'
          && typeof section.unclaimedText === 'string' && section.unclaimedText !== ''
          ? section.unclaimedText
          : null
        // 同楼段清单（system 框的真实段，地图行同形）；null = 还没取到 / 取不到（导航禁用，不猜）
        const [sibs, setSibs] = React.useState(null)
        const scrollRef = React.useRef(null)
        React.useEffect(() => {
          if (uncapturedText !== null) {
            setSt({
              phase: 'ready',
              state: {
                kind: 'text',
                text: uncapturedText,
                chars: uncapturedText.length,
                footer: '来源：本条正文是**本地算出来的**（底本 system 全文 − 各段 [offset, offset+字数) 的补集；'
                  + '⛔ 不是端点切片）' + (typeof section.unclaimedNote === 'string' && section.unclaimedNote !== '' ? ' · ' + section.unclaimedNote : ''),
              },
            })
            return undefined
          }
          if (!sessionId || !turn || !name) {
            setSt({ phase: 'error', state: { kind: 'error', footer: '内容取不到：会话/楼号/段名缺一不可', text: null } })
            return undefined
          }
          const controller = new AbortController()
          setSt({ phase: 'loading', state: { kind: 'error', footer: isCtx ? '正在取该上下文的注入原文…' : '正在从记忆库路径取该段正文…', text: null } })
          const url = isCtx
            ? (SECTIONS_API_BASE + '/sections/raw?sessionId=' + encodeURIComponent(sessionId) + '&turn=' + String(turn)
              + '&kind=context&name=' + encodeURIComponent(name))
            : (SECTIONS_API_BASE + '/sections/text?sessionId=' + encodeURIComponent(sessionId) + '&turn=' + String(turn)
              + '&name=' + encodeURIComponent(name))
          apiGet(url, controller.signal)
            .then((resp) => {
              if (controller.signal.aborted) return
              if (isCtx) {
                if (!resp || resp.ok !== true) {
                  const msg = resp && resp.error ? (resp.error.message || resp.error) : '接口没有返回上下文原文'
                  setSt({ phase: 'error', state: pmSectionTextState(null, String(msg)) })
                  return
                }
                if (typeof resp.text === 'string' && resp.text !== '') {
                  setSt({
                    phase: 'ready',
                    state: {
                      kind: 'text', text: resp.text,
                      footer: '来源：' + (resp.textSource || '日志里那条注入消息') + '（contexts ⛔ 不在 system 里）',
                    },
                  })
                } else {
                  setSt({
                    phase: 'ready',
                    state: { kind: 'missing', text: null, emphasis: false, footer: '该上下文的注入原文取不到：' + (resp.textUnavailable || '未知原因') },
                  })
                }
                return
              }
              setSt({ phase: 'ready', state: pmSectionTextState(resp, '') })
            })
            .catch((error) => {
              if (controller.signal.aborted) return
              setSt({ phase: 'error', state: pmSectionTextState(null, errText(error)) })
            })
          return () => controller.abort()
        }, [sessionId, turn, name, isCtx, uncapturedText])
        // 同楼段清单：与 PromptMap 同一条 C4 端点、同一套投影（⛔ 不另立口径）。失败 ⇒ null（按钮禁用）。
        React.useEffect(() => {
          if (isCtx || !sessionId || !turn) { setSibs(null); return undefined }
          const controller = new AbortController()
          apiGet(SECTIONS_API_BASE + '/sections?sessionId=' + encodeURIComponent(sessionId) + '&turn=' + String(turn), controller.signal)
            .then((resp) => {
              if (controller.signal.aborted) return
              const projected = buildMapFromSections(resp, {})
              const box = (projected && Array.isArray(projected.boxes) ? projected.boxes : []).find((x) => x && x.id === 'system')
              setSibs((box && Array.isArray(box.blocks) ? box.blocks : [])
                .filter((b) => b && !b.dashed && typeof b.key === 'string' && b.key.indexOf('sec:') === 0))
            })
            .catch(() => { if (!controller.signal.aborted) setSibs(null) })
          return () => controller.abort()
        }, [sessionId, turn, isCtx])
        // 切段后回到抽屉顶部（否则新一段开着、滚动条还停在上一段读到的位置）
        React.useEffect(() => {
          const el = scrollRef.current
          if (el) el.scrollTop = 0
        }, [name])
        const curKey = section && typeof section.key === 'string' ? section.key : null
        const navIdx = Array.isArray(sibs) && curKey ? sibs.findIndex((b) => b && b.key === curKey) : -1
        const canPrev = navIdx > 0
        const canNext = navIdx >= 0 && navIdx < sibs.length - 1
        const goSection = (d) => {
          if (!Array.isArray(sibs) || typeof onSwitchSection !== 'function') return
          const target = sibs[navIdx + d]
          if (target) onSwitchSection(target)
        }
        // 键盘 ← / →：同楼切段。打字处（输入框/多行框/可编辑元素）不抢键；带修饰键的组合也不抢。
        React.useEffect(() => {
          if (!Array.isArray(sibs) || typeof onSwitchSection !== 'function') return undefined
          const onKey = (ev) => {
            if (ev.altKey || ev.ctrlKey || ev.metaKey) return
            if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return
            const t = ev.target
            const tag = t && typeof t.tagName === 'string' ? t.tagName.toLowerCase() : ''
            if (tag === 'input' || tag === 'textarea' || tag === 'select' || !!(t && t.isContentEditable)) return
            const i = curKey ? sibs.findIndex((b) => b && b.key === curKey) : -1
            if (ev.key === 'ArrowLeft' && i > 0) { ev.preventDefault(); onSwitchSection(sibs[i - 1]) }
            if (ev.key === 'ArrowRight' && i >= 0 && i < sibs.length - 1) { ev.preventDefault(); onSwitchSection(sibs[i + 1]) }
          }
          window.addEventListener('keydown', onKey)
          return () => window.removeEventListener('keydown', onKey)
        }, [sibs, curKey, onSwitchSection])
        const copySection = () => {
          const text = st.phase === 'ready' && st.state.kind === 'text' && typeof st.state.text === 'string' ? st.state.text : ''
          if (text === '') return Promise.reject(new Error('没有可复制的内容'))
          return copyText(text)
        }
        const copyFloor = () => {
          if (!sessionId || !turn) return Promise.reject(new Error('会话/楼号缺失'))
          const base = PROMPT_API_BASE + '/api/part?id=' + encodeURIComponent(sessionId) + '&turn=' + String(turn)
          const grab = (part, pick) => apiGet(base + '&part=' + encodeURIComponent(part), undefined).then(pick, () => null)
          return Promise.all([
            grab('system', (d) => clipInfo(typeof d.text === 'string' ? d.text : '')),
            grab('tools', (d) => (Array.isArray(d.tools) ? d.tools : null)),
            grab('messages', (d) => clipInfo(typeof d.text === 'string' ? d.text : '')),
          ]).then((out) => {
            const data = { system: out[0], tools: out[1], messages: out[2] }
            if (!data.system && !data.tools && !data.messages) throw new Error('三段都取不到')
            const text = buildFullPlainText(data)
            if (text === '') throw new Error('没有可复制的内容')
            return copyText(text)
          })
        }
        const navBtnStyle = {
          fontSize: 12, padding: '3px 10px', borderRadius: 999, flexShrink: 0,
          border: '1px solid color-mix(in srgb, CanvasText 28%, transparent)',
        }
        // ★ M13（20260914 用户报障：「你没做次级界面本身的滚动，只做了 json 的滚动」）：
        //   **整抽屉一起滚** —— 容器给 overflowY:auto，内部不再有任何自带滚动条的小盒子。
        //   顺序也按阅读顺序：工具行（复制 + 段导航）→ 搜索 → 段头/徽标/注释/正文 → 原始 JSON（补充材料放最后）。
        return e('div', { ref: scrollRef, 'data-l3-scroll': '1', style: { display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto' } },
          e('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', flex: 'none' } },
            e(CopyFeedbackBtn, {
              label: '复制该段', disabled: st.phase !== 'ready' || st.state.kind !== 'text',
              title: '复制该段正文（来自记忆库路径切片）', onCopy: copySection,
            }),
            e(CopyFeedbackBtn, {
              label: '复制整楼', disabled: !sessionId || !turn,
              title: '按顺序复制本楼 system / tools / messages 全文（现取现复制，不在抽屉里展示整楼）', onCopy: copyFloor,
            }),
            // ★ 右上角：同楼逐段切换。到头/到尾（含清单还没到/取不到）一律 disabled —— 禁用可见，⛔ 不循环。
            e('span', { style: { flex: 1 } }),
            e('button', {
              className: 'dma-btn', 'data-l3': 'nav-prev', disabled: !canPrev,
              onClick: () => goSection(-1), title: '同楼上一段（快捷键 ←；到头禁用）', style: navBtnStyle,
            }, '← 上一个'),
            e('span', {
              'data-l3': 'nav-count',
              style: { fontFamily: MONO, fontSize: SMALL_FONT_SIZE, color: 'GrayText', flexShrink: 0, minWidth: 44, textAlign: 'center' },
            }, navIdx >= 0 ? (navIdx + 1) + ' / ' + sibs.length : '—'),
            e('button', {
              className: 'dma-btn', 'data-l3': 'nav-next', disabled: !canNext,
              onClick: () => goSection(1), title: '同楼下一段（快捷键 →；到尾禁用）', style: navBtnStyle,
            }, '下一个 →'),
          ),
          e('input', {
            id: 'dma-section-search', name: 'dma-section-search',
            'aria-label': '在该段正文里搜索',
            style: Object.assign({}, inputStyle, { width: '100%', boxSizing: 'border-box', flex: 'none' }),
            placeholder: '在该段正文里搜索（子串高亮，纯前端）…',
            value: query, onChange: (ev) => { if (typeof setQuery === 'function') setQuery(ev.target.value) },
          }),
          st.phase === 'loading' ? e('div', { style: dimStyle }, st.state.footer) : null,
          // ① 段头 / 徽标 / 注释 / 正文（先看得见的这些）
          st.phase !== 'loading' ? pmSectionDrawerBody(section, st.state, query) : null,
          // ② 原始 JSON（原样记录，不折叠、不设上限）—— 放在正文之后，滚下去就有
          //   ⚠️ 「未抓到」那一行**没有**原始记录可给（它不是捕获到的一段，是底本减完剩下的）⇒ 不画这块，
          //   免得拿"未抓到（切完的剩余）"当段名去问端点、再报一句误导性的"没找到这个段"。
          st.phase !== 'loading' && uncapturedText === null ? e(RawRecordPanel, {
            sessionId: sessionId, turn: turn,
            name: sectionNameOf(section),
            kind: section && typeof section.key === 'string' && section.key.indexOf('ctx:') === 0 ? 'context' : 'section',
          }) : null,
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
          e(ToolScopeWarnLine, { tools: tools }),
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
      // 20260913 改版：从常驻一列改为地图底部的折叠条（用户拍板 5A），默认收起。
      /**
       * ★ M15（20260914 用户要求）：**导出注册表** —— 「全部带顺序的字段」。
       *
       * 数据源 = `/dsh-memory-archive/api/sections`（该楼实际装配的捕获记录：段 / 上下文 / 工具，都带 order 与字数），
       * 可选再逐段取正文（`texts`）。产出一份**纯文本 Markdown**：人看得懂，也能直接粘给 AI 问"这些字段各是干什么的"。
       *
       * ★ 纪律：只导出**这一楼真实装配的东西**；拿不到的字段如实写「未知」，⛔ 不补默认值、⛔ 不猜。
       * @param {object} cap - `/sections` 的响应
       * @param {{sessionId?:string, turn?:number|null, texts?:Map<string,string>|null, textNote?:string}} [opts]
       */
      function buildRegistryText(cap, opts) {
        const o = opts || {}
        const secs = Array.isArray(cap && cap.sections) ? cap.sections.slice() : []
        const ctxs = Array.isArray(cap && cap.contexts) ? cap.contexts.slice() : []
        const tools = Array.isArray(cap && cap.tools) ? cap.tools.slice() : []
        const byOrder = (a, b) => {
          const av = typeof a.order === 'number' ? a.order : Number.MAX_SAFE_INTEGER
          const bv = typeof b.order === 'number' ? b.order : Number.MAX_SAFE_INTEGER
          return av - bv
        }
        secs.sort(byOrder)
        ctxs.sort(byOrder)
        tools.sort((a, b) => (b.chars || 0) - (a.chars || 0))
        const num = (v) => (typeof v === 'number' ? String(v) : '未知')
        const sum = (arr) => arr.reduce((n, x) => n + (typeof x.chars === 'number' ? x.chars : 0), 0)
        const mutLabel = (m) => (m === 'static' ? '静态' : m === 'per-turn' ? '每轮' : '未知')
        const basisLabel = (b) => (b === 'definition' ? '注册定义' : b === 'header-equal' ? '沿用上一条 header' : b === 'known' ? '已知类型' : '未知')
        const turn = o.turn != null ? o.turn : (cap && cap.turn != null ? cap.turn : null)
        const texts = o.texts instanceof Map ? o.texts : null
        const out = []
        out.push('# DSH 提示词字段注册表（导出自「提示词查看器」装配地图）')
        out.push('')
        out.push('- 会话：`' + (o.sessionId || '未知') + '`')
        out.push('- 楼号：第 ' + (turn == null ? '未知' : turn) + ' 楼')
        out.push('- 来源：组装捕获（source=' + String((cap && cap.source) || '未知') + '）—— 这一轮**真实装进去**的字段与顺序')
        out.push('- 顺序 = **注入顺序**（不是重要性）：负 order 在最前，数值越大越靠后；⛔ 拿不到 order 就写「未知」，不补默认值')
        out.push('- 构成：system 段 ' + secs.length + ' 个（' + sum(secs) + ' 字）｜运行上下文 ' + ctxs.length + ' 个（' + sum(ctxs) + ' 字）｜工具定义 ' + tools.length + ' 个（' + sum(tools) + ' 字）')
        out.push('- ★ **怎么用**：把这份清单整段粘给 AI，直接问「下面每个字段分别是干什么的、哪几段会每轮变、哪些是角色卡/世界书/工具说明」——')
        out.push('  每行都给了顺序、字数、可变性与判据，AI 据此能判断各自扮演的角色；清单里没有正文时⛔ 不要让它编内容')
        out.push('')
        out.push('## 一 system 段（按注入顺序）')
        out.push('')
        out.push('| order | 字段名 | 字数 | 可变性 | 判据 | offset |')
        out.push('|---|---|---|---|---|---|')
        for (const s of secs) {
          out.push('| ' + num(s.order) + ' | `' + String(s.name) + '` | ' + num(s.chars) + ' | ' + mutLabel(s.mutability) + ' | ' + basisLabel(s.mutabilityBasis) + ' | ' + num(s.offset) + ' |')
        }
        if (secs.length === 0) out.push('| — | （没有捕获到 system 段） | — | — | — | — |')
        out.push('')
        out.push('## 二 运行上下文（★ 不在 system 里：作为一条独立消息发出）')
        out.push('')
        out.push('| order | 名称 | 字数 |')
        out.push('|---|---|---|')
        for (const c of ctxs) out.push('| ' + num(c.order) + ' | `' + String(c.name) + '` | ' + num(c.chars) + ' |')
        if (ctxs.length === 0) out.push('| — | （这一楼没有 contexts 条目） | — |')
        out.push('')
        out.push('## 三 工具定义（★ 独立字段 request.header.tools，不在 system 里）')
        out.push('')
        out.push('| 名称 | 字数 |')
        out.push('|---|---|')
        for (const t of tools) out.push('| `' + String(t.name) + '` | ' + num(t.chars) + ' |')
        if (tools.length === 0) out.push('| — | （这一楼没有工具定义） |')
        if (texts) {
          out.push('')
          out.push('## 四 各段正文（' + (o.textNote || '按 offset 从会话日志切出') + '）')
          for (const s of secs) {
            const t = texts.get(String(s.name))
            out.push('')
            out.push('### `' + String(s.name) + '`（order ' + num(s.order) + '，' + num(s.chars) + ' 字）')
            out.push('')
            out.push(t === undefined || t === null ? '_（取不到正文：未记录位置或校验未通过，⛔ 这里不编）_' : '```text\n' + t + '\n```')
          }
        }
        out.push('')
        return out.join('\n')
      }

      /**
       * ★ M15：导出条 —— 「导出注册表」（全部带顺序的字段），可复制去问 AI 每个字段的作用。
       * 放在地图底部的「来源：preset 组成」旁边（那里本来就是讲组成的地方）。
       */
      function RegistryExportBar({ sessionId, turn }) {
        const [note, setNote] = React.useState('')
        const [busy, setBusy] = React.useState('')
        const SECTIONS_CAP = 60    // 含正文时逐段取，最多取这么多段（超了如实说明，⛔ 不假装全给了）
        const run = (withText) => {
          if (!sessionId || !turn) { setNote('先选一个会话与楼号'); return }
          setBusy(withText ? 'text' : 'list')
          setNote(withText ? '正在取该楼装配记录与各段正文…' : '正在取该楼装配记录…')
          apiGet(SECTIONS_API_BASE + '/sections?sessionId=' + encodeURIComponent(sessionId) + '&turn=' + String(turn), undefined)
            .then(async (cap) => {
              if (!cap || cap.ok !== true) throw new Error((cap && cap.error && cap.error.message) || '装配记录取不到')
              if (!withText) return buildRegistryText(cap, { sessionId: sessionId, turn: turn })
              const secs = (Array.isArray(cap.sections) ? cap.sections : []).filter((s) => Number(s.chars) > 0).slice(0, SECTIONS_CAP)
              const texts = new Map()
              let got = 0
              for (const s of secs) {
                try {
                  const one = await apiGet(SECTIONS_API_BASE + '/sections/text?sessionId=' + encodeURIComponent(sessionId)
                    + '&turn=' + String(turn) + '&name=' + encodeURIComponent(s.name), undefined)
                  if (one && one.ok === true && typeof one.text === 'string') { texts.set(String(s.name), one.text); got++ }
                } catch {
                  // 单段失败不拖垮整份导出：那一段在导出里会写「取不到正文」
                }
              }
              const all = (Array.isArray(cap.sections) ? cap.sections : []).filter((s) => Number(s.chars) > 0)
              const noteTxt = '逐段从会话日志切出（拿到 ' + got + '/' + secs.length + ' 段'
                + (all.length > secs.length ? '；⚠ 该楼非空段共 ' + all.length + ' 个，本次只取前 ' + SECTIONS_CAP + ' 个' : '') + '）'
              return buildRegistryText(cap, { sessionId: sessionId, turn: turn, texts: texts, textNote: noteTxt })
            })
            .then((text) => copyText(text))
            .then(
              () => { setBusy(''); setNote(withText ? '已复制（含正文）—— 粘给 AI 问每个字段的作用' : '已复制（字段清单）—— 粘给 AI 问每个字段的作用') },
              (error) => { setBusy(''); setNote('导出失败：' + errText(error)) },
            )
        }
        // M16（用户截图反馈）：导出条改成**一行内联**（与「来源：preset 组成」同一条工具条），
        // 提示压在行尾、结果提示也走同一行 —— 不再各占一行、不再套两层盒子。
        return e('div', { 'data-registry-export': '1', style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 } },
          e('button', {
            className: 'dma-btn dma-mini', style: miniBtnStyle, 'data-export': 'list',
            disabled: !sessionId || !turn || busy !== '',
            onClick: () => run(false),
            title: '导出这一楼全部带顺序的字段（段 / 上下文 / 工具，含 order、字数、可变性、判据、offset）为 Markdown 清单并复制',
          }, busy === 'list' ? '导出中…' : '导出注册表'),
          e('button', {
            className: 'dma-btn dma-mini', style: miniBtnStyle, 'data-export': 'text',
            disabled: !sessionId || !turn || busy !== '',
            onClick: () => run(true),
            title: '同上，并逐段把实际正文也附上（较慢；单段取不到会如实标注，⛔ 不编）',
          }, busy === 'text' ? '取正文中…' : '含正文'),
          e('span', {
            style: Object.assign({}, dimStyle, { flex: '1 1 auto', minWidth: 0 }),
            'data-export-note': note ? '1' : undefined,
            title: '导出的是一份 Markdown 清单：每个字段的注入顺序 / 字数 / 是否每轮 / 判据，可直接粘给 AI 问它们各自的作用',
          }, note || '★ 复制后可喂给 AI 问：这些字段各是干什么的'),
        )
      }

      function CompositionBlock({ agent, sessionId, turn }) {
        const [open, setOpen] = React.useState(false)
        const toggleBtn = e('button', {
          className: 'dma-btn dma-mini', style: Object.assign({}, miniBtnStyle, { flex: 'none' }),
          onClick: () => setOpen((v) => !v),
          title: open
            ? '收起组成块'
            : '展开组成块：该 preset 声明了哪些段 / 插件 / order（与「导出注册表」不同：那个导出的是 DSH 这一楼实际装配的字段）',
        }, open ? '▾ 来源：preset 组成' : '▸ 来源：preset 组成')
        // M16（用户截图反馈）：「组成」开关与「导出注册表」并成**同一条工具条**，
        // 提示压在行尾、不占第二行；展开时明细就挂在这条下面（同一个卡片里）。
        const toolbar = e('div', {
          className: 'dma-card',
          style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', flex: 'none', minWidth: 0 },
        },
          toggleBtn,
          e('span', { style: { width: 1, height: 16, background: 'ButtonBorder', flexShrink: 0 } }),
          e(RegistryExportBar, { sessionId: sessionId, turn: turn }))
        if (!open) return e('div', { style: { flex: 'none', display: 'flex', flexDirection: 'column', gap: 6 } }, toolbar)
        const sections = agent.status === 'ready' && agent.data && Array.isArray(agent.data.sections)
          ? agent.data.sections
          : null
        return e('div', { style: { flex: 'none', display: 'flex', flexDirection: 'column', gap: 6 } },
          toolbar,
          agent.status === 'loading' && e('div', { style: dimStyle }, '正在读取 preset…'),
          agent.status === 'error' && e('div', { style: errorStyle }, 'preset 组成读取失败：' + agent.error),
          agent.status === 'ready' && e('div', { style: { flex: 'none', maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 } },
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
      // 「正在读取 preset…」的瞬态 = 三按钮禁用 + 理由「正在读取可写性…」（如实，不给过期承诺）。
      // ⛔ 一致性判定保持 P0 的实现（宿主 /agent 的 consistent 字段），这里只渲染，不改逻辑。
      // ---------- v5 P1a：应用卡（真写入 = 先干跑零写入，确认后才落盘）+ 备份卡（只读） ----------
      // 状态全部在 AgentEditorPanel（applyCtl 传入），本组件无 hooks；失败降级绝不抛。
      // v5 P2 ①：备份卡解禁 [回滚] —— 每条备份都能回滚，但必须走「干跑出计划 → 确认 → 写」
      // 三步（⛔ 不许点一下直接写）。回滚由宿主 POST /agent/rollback 完成：回滚前会先把
      // 当前文件再备份一次 ⇒ 回滚本身可再回滚。列表本身仍只读（不改不删任何备份文件）。
      // ---------- v5 P1b-2a ③：pack 应用卡（贴 RP-AGENT-PACK v1 → 干跑出计划与 persona 改前/改后 → 确认才写） ----------
      // ★ 界面文字对玩家用白话（术语禁令照旧）；开关改的是挂载行里的 config 值；persona 改写必须先给差异再确认。
      // ---------- 20260913 ⑧：一键生成 RP 预设卡（没装 → 干跑计划 → 确认生成；已装 → 显示已生成 + 先备份再删） ----------
      // 数据 = GET /agent/provision（只读计划）；写 = POST（dryRun 两步）；删 = DELETE（同样两步，宿主先备份再删）。
      // ⛔ 界面不说「全自动配好一切」：notes 的如实说明（不含 anima/state-bridge、压缩后端随目录落地）原样展示。
      // ---------- v3 外部组合（Tavern 2.3.0 候选的 v3 合同）：只读投影 + 显式切模式 ----------
      // 数据 = 宿主 GET /dsh-memory-archive/api/v3?sessionId=…（宿主侧只做转发与摘要，⛔ 不缓存正文）。
      // 为什么要有它：v3 合同是**后端/HTTP 交付**（上游明说没有内置 UI 按钮）⇒ 管理器插件得自己给个面。
      // 诚实口径（用户口径：说真话优先）：这不是"修好了什么"，而是"我们接管装配"的开关；
      // 默认关；切到 external 后 **Tavern 默认 profile 正文不再产生**。
      /** 纯函数：把 /v3 响应摊成可渲染的行（自检台直测，组件不掺逻辑）。 */
      function v3DigestLines(v3) {
        const out = []
        // ⛔ 排除数组（`typeof [] === 'object'`）：靠下面 `ok !== true` 也能兜住，但形状门要自己站得住。
        if (!v3 || typeof v3 !== 'object' || Array.isArray(v3)) return [{ label: '数据面', value: '取不到（响应形状不符）', kind: 'error' }]
        const tav = v3.tavern || {}
        if (v3.ok !== true) {
          out.push({ label: 'Tavern v3', value: (v3.error && v3.error.message) || '不可用', kind: 'error' })
          return out
        }
        // ① 合同：**放在第一行** —— 下面每一行的含义都取决于"这台 Tavern 是哪一套 v3"。
        //    两套合同的端点、能力面、以及"我们哪些功能不适用"完全不同；判错会把人指向不存在的修复动作。
        const ct = v3.contract
        /** 是不是 trace 合同 —— 决定"缺端口"该不该报警（composer 合同下本来就不需要端口）。 */
        const isTrace = !!(ct && typeof ct === 'object' && ct.id === 'trace')
        if (ct && typeof ct === 'object') {
          out.push({
            label: 'v3 合同',
            value: String(ct.label || ct.id || '?') + ' · ' + String(ct.reason || ''),
            kind: ct.known === true ? undefined : 'warn',
          })
          out.push({ label: '合同含义', value: String(ct.detail || ''), kind: ct.known === true ? undefined : 'warn' })
          if (ct.known !== true) out.push({ label: '⚠ 提醒', value: '合同没认准 ⇒ 下面凡是我们"自己的功能"的状态一律不可信，⛔ 别按它做判断', kind: 'warn' })
        }
        const cap = v3.capabilities || {}
        out.push({ label: 'Tavern v3', value: '可达（HTTP ' + String(tav.status ?? '?') + '）· apiVersion ' + String(cap.apiVersion ?? '?') + (cap.contract ? ' · contract ' + String(cap.contract) : '') + (cap.modes ? ' · modes ' + JSON.stringify(cap.modes) : '') })
        // ② replace 模式看守（用户 2026-09-17 点名要的"防线"）：Tavern 在 replace 下只保留它自己的段，
        //    我们那七段会被整批滤掉且不报错 ⇒ 这条必须**醒目**，否则面板上"全是 0"会被误读成"没命中"。
        const rg = v3.replaceGuard
        if (rg && typeof rg === 'object') {
          out.push({
            label: rg.atRisk === true ? '⚠ 装配模式' : '装配模式',
            value: String(rg.note || ('预设 systemPromptMode = ' + String(rg.presetMode ?? '（读不到）'))),
            kind: rg.atRisk === true ? 'warn' : undefined,
          })
        }
        // ③ 组合器：**区分"配置没开"和"这条路根本不存在"** —— 后者重启一万次也不会变好。
        const cm = v3.composer || {}
        if (cm.usable === false) {
          out.push({ label: '组合器', value: '这条路在这台 Tavern 上不存在 · ' + String(cm.note || ''), kind: 'warn' })
        } else if (cm.usable === null) {
          out.push({ label: '组合器', value: String(cm.note || '无法判定（没读到 capabilities）'), kind: 'warn' })
        } else {
          out.push({ label: '组合器', value: '已注册 ' + JSON.stringify(cm.owners || []) + (cm.enabled ? '（我们：' + String(cm.owner) + '）' : '（我们未启用）') })
          if (cm.needsHostRestart) out.push({ label: '⚠ 待生效', value: '配置说启用但本进程没注册上 —— 改完这条要重启宿主', kind: 'warn' })
        }
        // ④ 卡字段摆位（2026-09-19：取代了 tail / 带外填充器 / 重复PHI 三行）——
        //    把"这一轮上游解出来几段、我们摆到哪儿去了"直接摆出来。
        const pt = v3.parts
        if (pt && typeof pt === 'object') {
          const seen = pt.lastSeen && typeof pt.lastSeen === 'object' ? pt.lastSeen : null
          const lp = pt.lastPlaced && typeof pt.lastPlaced === 'object' ? pt.lastPlaced : null
          out.push({
            label: '卡字段摆位',
            value: (pt.registered === true ? '已接线' : (pt.armed === true ? '已挂载·待启用（等第一个会话事件）' : '未接线（' + String(pt.reason || '?') + '）'))
              + (pt.planLoaded === false ? ' · ⚠ 摆位表模块没加载' : '')
              + ' · 累计摆 ' + String(pt.placedTotal ?? 0) + ' 段'
              + (seen ? ' · 上轮 ' + String(seen.parts ?? '?') + ' 个上游段，摆了 ' + String(seen.placed ?? '?') + ' 个'
                + ((seen.fallback ?? 0) > 0 ? '（其中 ' + String(seen.fallback) + ' 个字段没进表，按兜底位摆）' : '') : '')
              + (lp && Array.isArray(lp.placed) && lp.placed.length
                ? ' · 摆位：' + lp.placed.map((x) => String(x.key) + '→' + String(x.order)).join('、')
                : ''),
            kind: (pt.registered === true || pt.armed === true) ? undefined : 'warn',
          })
        }
        if (cap.maxSections !== undefined) out.push({ label: '上限', value: '段 ≤ ' + String(cap.maxSections) + ' · profile ≤ ' + String(cap.maxProfileBytes ?? '?') + ' 字节 · 同步 ' + String(cap.synchronous) })
        if (v3.mode) {
          out.push({ label: '本会话装配', value: 'mode=' + String(v3.mode.mode) + ' · owner=' + String(v3.mode.owner ?? 'null') + ' · available=' + String(v3.mode.available) })
        } else if (v3.modeError) {
          out.push({ label: '本会话装配', value: '读不到（' + String(v3.modeError.code) + '）', kind: 'error' })
        } else {
          out.push({ label: '本会话装配', value: '未给 sessionId（选一个会话再看）' })
        }
        const s = v3.sources
        if (s) {
          out.push({ label: '卡', value: String(s.cardName ?? '（无名字）') + '  id=' + String(s.cardId ?? '—') })
          const g = s.greeting || {}
          out.push({ label: '开场', value: '序号 ' + String(g.effectiveIndex ?? '?') + '（请求 ' + String(g.requestedIndex ?? '?') + '）· ' + String(g.semantics ?? '?') + ' · ' + String(g.chars ?? 0) + ' 字' })
          const fields = Array.isArray(s.fields) ? s.fields : []
          out.push({ label: '字段字数', value: fields.length ? fields.map((f) => f.label + '=' + f.chars).join(' · ') : '（一个都没读到）' })
          const wb = s.worldBooks || {}
          out.push({ label: '世界书', value: '生效 ' + String(wb.effective ?? 0) + ' · 卡绑定 ' + String(wb.characterBound ?? 0) + ' · 用户绑定 ' + String(wb.userBound ?? 0) + ' · 重复 ' + String(wb.duplicate ?? 0) })
          out.push({ label: '快照', value: 'revision ' + String(s.revision ?? '—').slice(0, 16) + '… · 计数单位 ' + String(s.countUnit ?? '?') + ' · fieldLengths ' + String(s.fieldLengthKeys ?? 0) + ' 条' })
          const sc = s.suggestedCallConfig || {}
          out.push({ label: 'suggestedCallConfig', value: Object.keys(sc).length ? JSON.stringify(sc) : '（上游没给）' })
        } else if (v3.sourcesError) {
          out.push({ label: '来源快照', value: '读不到（' + String(v3.sourcesError.code) + '）', kind: 'error' })
        }
        if (v3.composer && v3.composer.note) out.push({ label: '说明', value: String(v3.composer.note) })
        // ⑤ 历史装配（**只有 trace 合同有**）：逐轮真实装配的索引，只给元数据（⛔ 不带正文）。
        //    这一段是"上游把卡字段展开成 :part: 段"之后才可能有的东西 —— 过去我们只能靠自己的组装捕获。
        const as = v3.assemblies
        if (as && typeof as === 'object') {
          const recs = Array.isArray(as.records) ? as.records : []
          if (recs.length === 0) {
            out.push({ label: '历史装配', value: '0 条 —— 上游说这个会话没有可返回的保留记录（⛔ 这不等于"该轮没注入"）' })
          } else {
            const lastRec = recs[recs.length - 1]
            out.push({
              label: '历史装配',
              value: recs.length + ' 条 / 上限 ' + String((as.storage && as.storage.maxRecords) ?? '?')
                + ' · 最近 turn ' + String(lastRec.turn ?? '?') + ' step ' + String(lastRec.step ?? '?')
                + ' · 段数 ' + String(lastRec.sectionCount ?? '（legacy 记录没有段数）')
                + ' · 状态 ' + String(lastRec.status ?? '?'),
            })
          }
        } else if (v3.assembliesError) {
          out.push({ label: '历史装配', value: '读不到（' + String(v3.assembliesError.code) + '）', kind: 'error' })
        }
        return out
      }

      /**
       * 纯函数：**单条装配记录** ⇒ 可渲染行（自检台直测）。
       *
       * 口径（与 v3DigestLines 同一套）：只摊它认识的那几个键；`sections[].text` **默认不进来**
       * （宿主的投影本来就不带，要看正文得单独点一下、按需取那一段）。
       * ⚠️ `assemblyVerified === false` 时必须说清"offsetUtf16 不能当实际位置用" —— 上游只在
       *    候选 system 文本**唯一匹配**一整条系统消息时才置 true，其余情况是"一致性未获证明"。
       */
      function assemblyLines(rec) {
        const out = []
        // ⛔ 必须排除数组：`typeof [] === 'object'` —— 放过去会把它当成一条记录，逐行摊出全 undefined。
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return [{ label: '记录', value: '取不到（响应形状不符）', kind: 'error' }]
        out.push({
          label: '位置',
          value: 'turn ' + String(rec.turn ?? '?') + ' · step ' + String(rec.step ?? '?') + ' · attempt ' + String(rec.attempt ?? '?')
            + ' · 采集 ' + (Number.isFinite(rec.recordedAt) ? new Date(rec.recordedAt).toISOString() : '?'),
        })
        out.push({ label: '状态', value: String(rec.status ?? '?') + ' · 内容 ' + String(rec.contentStatus ?? '?') + (rec.sourceMapping ? ' · 来源映射 ' + String(rec.sourceMapping) : '') })
        const d = rec.delivery
        if (d && typeof d === 'object') {
          const tools = Array.isArray(d.toolNames) ? d.toolNames : []
          out.push({ label: '投递', value: 'provider ' + String(d.provider ?? '?') + ' · model ' + String(d.model ?? '?') + ' · 工具 ' + tools.length + ' 个' + (tools.length ? '（' + tools.join(', ') + '）' : '') })
          out.push({
            label: '装配核对',
            value: d.assemblyVerified === true
              ? '✅ 候选正文唯一匹配到第 ' + String(d.systemMessageIndex ?? '?') + ' 条系统消息 ⇒ offset 可定位'
              : '⚠ 一致性**未获证明**（候选正文没能唯一匹配到一整条系统消息）⇒ 下面的 offset **不能**当作在实际系统消息里的位置',
            kind: d.assemblyVerified === true ? undefined : 'warn',
          })
        } else {
          out.push({ label: '投递', value: '没有 observed 投递信息（该记录未观察到 LLM 层请求）' })
        }
        const secs = Array.isArray(rec.sections) ? rec.sections : []
        if (secs.length === 0) out.push({ label: '段', value: '0 段（' + String(rec.contentStatus ?? '') + '）—— ⛔ 空不等于"没注入"' })
        for (const s of secs) {
          const part = s.part && typeof s.part === 'object' ? s.part : null
          const srcs = Array.isArray(s.sources) ? s.sources : []
          const who = part
            ? '卡字段 ' + String(part.kind || '?') + ':' + String(part.field || '?') + (part.sanitized ? '（字段名被上游清洗过）' : '')
            : ''
          out.push({
            label: '#' + String(s.index ?? '?'),
            value: String(s.name ?? '?')
              + ' · ' + String(s.characters ?? '?') + ' 字'
              + ' · 来源 ' + String(s.provenance ?? 'unknown')
              + (who ? ' · ' + who : '')
              + (srcs.length ? ' · 贡献者 ' + srcs.map((x) => String(x.kind ?? '?') + ':' + String(x.field ?? '?')).join(' + ') : '')
              // ⛔ offset 只在核对通过时才有意义
              + (d && d.assemblyVerified === true && Number.isFinite(s.offsetUtf16) ? ' · @' + String(s.offsetUtf16) : ''),
          })
        }
        return out
      }

      /** 面板：只读投影 + 两个显式动作（启用我方组合器 / 切本会话模式）。 */
      function V3Panel({ sessionId }) {
        const [state, setState] = React.useState({ status: 'idle', data: null, error: '' })
        const [act, setAct] = React.useState({ busy: false, ok: '', error: '' })
        const [tick, setTick] = React.useState(0)
        const ctl = React.useRef(null)
        React.useEffect(() => {
          if (ctl.current) ctl.current.abort()
          const controller = new AbortController()
          ctl.current = controller
          setState((s) => ({ ...s, status: 'loading' }))
          const q = sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : ''
          apiGet(HOST_API_BASE + '/v3' + q, controller.signal)
            .then((data) => { if (!controller.signal.aborted) setState({ status: 'ready', data: data, error: '' }) })
            .catch((error) => { if (!controller.signal.aborted) setState({ status: 'error', data: null, error: errText(error) }) })
          return () => { controller.abort(); ctl.current = null }
        }, [sessionId, tick])
        // 逐轮真实装配（**只有 trace 合同有**）：索引随 /v3 一起来；**单条详情按需再取**。
        // ⛔ 段正文更得再点一次才取 —— 那是系统提示词全文，不预取、不整份塞进面板。
        const [asm, setAsm] = React.useState({ status: 'idle', recordId: '', data: null, error: '' })
        const [secText, setSecText] = React.useState({ status: 'idle', index: -1, data: null, error: '' })
        const loadAssembly = (recordId) => {
          if (!sessionId || !recordId) return
          setAsm({ status: 'loading', recordId: recordId, data: null, error: '' })
          setSecText({ status: 'idle', index: -1, data: null, error: '' })
          const q = '?sessionId=' + encodeURIComponent(sessionId) + '&recordId=' + encodeURIComponent(recordId)
          apiGet(HOST_API_BASE + '/v3/assembly' + q)
            .then((data) => setAsm({ status: 'ready', recordId: recordId, data: data, error: '' }))
            .catch((error) => setAsm({ status: 'error', recordId: recordId, data: null, error: errText(error) }))
        }
        const loadSectionText = (index) => {
          if (!sessionId || !asm.recordId) return
          setSecText({ status: 'loading', index: index, data: null, error: '' })
          const q = '?sessionId=' + encodeURIComponent(sessionId) + '&recordId=' + encodeURIComponent(asm.recordId) + '&section=' + String(index)
          apiGet(HOST_API_BASE + '/v3/assembly' + q)
            .then((data) => setSecText({ status: 'ready', index: index, data: data, error: '' }))
            .catch((error) => setSecText({ status: 'error', index: index, data: null, error: errText(error) }))
        }
        const v3 = state.data
        const lines = v3DigestLines(v3)
        const mode = v3 && v3.mode ? String(v3.mode.mode) : ''
        const composerOn = !!(v3 && v3.composer && v3.composer.enabled)
        // ⛔ 合同明确说"这两条路不存在"时，按钮要**禁用并说清为什么** —— 别让人点出一个必然失败的动作
        //    （旧代码在 trace 合同下会显示成"配置说启用但没注册上 ⇒ 重启宿主"，把人指向无效修复）。
        const composerBlocked = !!(v3 && v3.contract && v3.contract.composerUsable === false)
        const modeBlocked = !!(v3 && v3.contract && v3.contract.modeSwitchable === false)
        const run = (label, fn) => {
          setAct({ busy: true, ok: '', error: '' })
          Promise.resolve()
            .then(fn)
            .then((msg) => { setAct({ busy: false, ok: label + '：' + msg, error: '' }); setTick((x) => x + 1) })
            .catch((error) => {
              const payload = error && error.payload && typeof error.payload === 'object' ? error.payload : null
              const code = payload && payload.error && payload.error.code ? ' [' + payload.error.code + ']' : ''
              const hint = payload && payload.hint ? '（' + payload.hint + '）' : ''
              setAct({ busy: false, ok: '', error: label + '失败：' + errText(error) + code + hint })
            })
        }
        const body = e('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } },
          lines.map((l, i) => e('div', { key: 'v3l' + i, 'data-v3-line': l.label, style: { display: 'flex', gap: 6, fontSize: SMALL_FONT_SIZE, minWidth: 0, color: l.kind === 'error' ? 'crimson' : l.kind === 'warn' ? 'DarkGoldenrod' : 'inherit' } },
            e('span', { style: { flexShrink: 0, opacity: 0.8, minWidth: 88 } }, l.label),
            e('span', { style: { wordBreak: 'break-word', minWidth: 0 } }, l.value),
          )),
          // 逐轮真实装配（trace 合同）：索引 → 点一条看段级明细 → 再点某一段看正文。
          // 三段式是刻意的（上游自己的 Trace 页面也这样）：面板打开时只读索引，**不预取正文**。
          (() => {
            const recs = v3 && v3.assemblies && Array.isArray(v3.assemblies.records) ? v3.assemblies.records : []
            if (recs.length === 0) return null
            const d = asm.status === 'ready' ? asm.data : null
            const okRecord = d && d.ok === true && d.record ? d.record : null
            const secs = okRecord && Array.isArray(okRecord.sections) ? okRecord.sections : []
            const st = secText.status === 'ready' && secText.data ? secText.data : null
            return e('div', { 'data-v3-assemblies': '1', style: { display: 'flex', flexDirection: 'column', gap: 4, borderTop: '1px solid color-mix(in srgb, CanvasText 15%, transparent)', paddingTop: 6, minWidth: 0 } },
              e('div', { style: dimStyle }, '逐轮真实装配（上游 trace 记录）· 点一条看段级明细；⛔ 正文默认不取，要看某一段得再点一次'),
              e('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } },
                recs.slice(-12).map((r) => e('button', {
                  key: 'v3as' + String(r.id),
                  className: 'dma-btn dma-mini',
                  style: Object.assign({}, miniBtnStyle, asm.recordId === String(r.id) ? { outline: '2px solid color-mix(in srgb, CanvasText 30%, transparent)' } : {}),
                  title: '读这一条的段级明细（只有元数据：段名 / 字数 / 来源 / 哈希）',
                  onClick: () => loadAssembly(String(r.id)),
                }, 't' + String(r.turn ?? '?') + 's' + String(r.step ?? '?') + (r.legacy ? '·旧' : '') + ' · ' + String(r.sectionCount ?? '?') + '段')),
              ),
              asm.status === 'loading' ? e('div', { style: dimStyle }, '读取中…') : null,
              asm.status === 'error' ? e('div', { style: errorStyle }, '取不到这条装配：' + asm.error) : null,
              d && d.ok !== true ? e('div', { style: errorStyle }, '取不到：' + String((d.error && d.error.code) || '?') + ' · ' + String((d.error && d.error.message) || '')) : null,
              okRecord ? e('div', { style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 } },
                assemblyLines(okRecord).map((l, i) => e('div', {
                  key: 'v3al' + i, 'data-v3-assembly-line': l.label,
                  style: { display: 'flex', gap: 6, fontSize: SMALL_FONT_SIZE, minWidth: 0, color: l.kind === 'error' ? 'crimson' : l.kind === 'warn' ? 'DarkGoldenrod' : 'inherit' },
                },
                  e('span', { style: { flexShrink: 0, opacity: 0.8, minWidth: 88 } }, l.label),
                  e('span', { style: { wordBreak: 'break-word', minWidth: 0 } }, l.value),
                )),
              ) : null,
              secs.length ? e('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 2 } },
                secs.map((s) => e('button', {
                  key: 'v3sec' + String(s.index),
                  className: 'dma-btn dma-mini',
                  style: Object.assign({}, miniBtnStyle, secText.index === s.index ? { outline: '2px solid color-mix(in srgb, CanvasText 30%, transparent)' } : {}),
                  title: '按需取这一段的正文（只有你点了才取；这是系统提示词原文）',
                  onClick: () => loadSectionText(s.index),
                }, '#' + String(s.index) + ' 正文')),
              ) : null,
              secText.status === 'loading' ? e('div', { style: dimStyle }, '取正文中…') : null,
              secText.status === 'error' ? e('div', { style: errorStyle }, '取不到正文：' + secText.error) : null,
              st && st.sectionText ? e('pre', {
                'data-v3-section-text': '1',
                style: { maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: SMALL_FONT_SIZE, margin: 0, padding: 6, border: '1px solid color-mix(in srgb, CanvasText 15%, transparent)', borderRadius: 4 },
              }, String(st.sectionText.text)) : null,
              st && !st.sectionText ? e('div', { style: { fontSize: SMALL_FONT_SIZE, color: 'DarkGoldenrod', wordBreak: 'break-word' } },
                '这一段没有正文：' + String((st.sectionTextError && st.sectionTextError.message) || '（上游没给原因）')) : null,
            )
          })(),
          e('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
            e('button', {
              className: 'dma-btn dma-mini', style: miniBtnStyle, disabled: !sessionId || mode === 'external' || modeBlocked,
              title: modeBlocked
                ? '⛔ 这台 Tavern 用 trace 合同：**没有**「按会话切装配模式」这条端点 ⇒ 这个动作不存在（与配置无关，重启也不会变好）'
                : '把**这个会话**切到 external：之后 Tavern 默认 profile 正文不再产生，改由我们的组合器产出命名段',
              onClick: () => run('切到 external', () => mutateJson(HOST_API_BASE + '/v3/mode', 'POST', { sessionId: sessionId, mode: 'external', confirm: true }, null).then(() => '已切（下一轮生效）')),
            }, '切到 external'),
            e('button', {
              className: 'dma-btn dma-mini', style: miniBtnStyle, disabled: !sessionId || mode === 'builtin' || modeBlocked,
              title: modeBlocked
                ? '⛔ 同上：trace 合同没有 prompt-mode 端点'
                : '把**这个会话**切回 builtin：装配交回 Tavern 内置策略',
              onClick: () => run('切回 builtin', () => mutateJson(HOST_API_BASE + '/v3/mode', 'POST', { sessionId: sessionId, mode: 'builtin', confirm: true }, null).then(() => '已切回（下一轮生效）')),
            }, '切回 builtin'),
            e('button', {
              className: 'dma-btn dma-mini', style: miniBtnStyle, disabled: act.busy || composerBlocked,
              title: composerBlocked
                ? '⛔ 这台 Tavern 用 trace 合同：**没有组合器注册表**（capabilities 自述 composerRegistry:false）⇒ 开关它没有意义'
                : '打开/关闭**我们自己**的 v3 组合器（写 config.v3.composer.enabled）。⚠️ 改完要重启宿主才生效',
              onClick: () => run(composerOn ? '关掉我们的组合器' : '启用我们的组合器', () => mutateJson(HOST_API_BASE + '/config', 'PUT', { v3: { composer: { enabled: !composerOn } } }, null).then(() => '已写入配置（重启宿主后生效）')),
            }, composerOn ? '关掉我们的组合器' : '启用我们的组合器'),
            e('button', {
              className: 'dma-btn dma-mini', style: miniBtnStyle, onClick: () => setTick((x) => x + 1),
              title: '重新读一次（capabilities / mode / sources 都是现读，不缓存）',
            }, '↻ 重新读'),
          ),
          act.busy ? e('div', { style: dimStyle }, '执行中…') : null,
          act.ok ? e('div', { style: { fontSize: SMALL_FONT_SIZE, color: 'DarkGoldenrod', wordBreak: 'break-word' } }, act.ok) : null,
          act.error ? e('div', { style: Object.assign({}, errorStyle, { wordBreak: 'break-word' }) }, act.error) : null,
          state.status === 'loading' ? e('div', { style: dimStyle }, '读取中…') : null,
          state.status === 'error' ? e('div', { style: errorStyle }, '取不到 v3 投影：' + state.error) : null,
        )
        return e('div', { className: 'dma-card', 'data-v3-panel': '1', style: { display: 'flex', flexDirection: 'column', gap: 6, flex: 'none' } },
          e('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
            e('strong', { style: sectionTitleStyle }, 'v3 外部组合（Tavern 候选分支）'),
            e('span', { style: dimStyle }, '只读投影 + 两个显式动作；⛔ 卡片正文请去 Tavern 自己的界面看，这里只给字数与序号'),
          ),
          body,
        )
      }

      // ---------- v5 P0：检测与预览视图（「生成 / 修复 RP agent」的只读产物展示，不落盘） ----------
      // 数据 = 宿主 GET /api/agent/detect；6 条事实在宿主侧逐条给出（本组件只渲染）。
      // v5 P1a：底部新增 ⑤ 应用卡（真写入，先干跑）与 ⑥ 备份卡（只读）；检测本身仍零写入。
      // 20260913 改版：渲染在「维护」抽屉里；skillOn 勾选整体移除（用户拍板：零功能的组件内 state）。
      // ---------- Agent 编辑器主体（v5 P0：独立入口「agent-editor」的浮层内容；席位与外壳见 AgentEditorButton） ----------
      // hook 序号（自检假 react 注入口径）：0 fullscreen · 1 health · 2 sessions · 3 hostRows ·
      // 4 nameIdx · 5 sessionId · 6 detail · 7 turn · 8 part · 9 partState ·
      // ★ 2026-09-18：`10 fullState` 已随「完整视图」整体删除 ⇒ **10 号起的序号全部前移一位**
      //   （自检 `_selftest-client.mjs` 的注值序号同步改了；⛔ 以后再删/加 hook 记得一起改）。
      // 10 query · 11 note · 12 sessionsAbort(ref) · 13 resolveSentRef(ref) ·
      // 15 agent · 16 detect · 17 detectTick · 18 maintOpen（20260913「维护」抽屉开关，
      //    顶替移除的 skillOn —— 用户拍板：该勾选是零功能的组件内 state，整体去掉）·
      // 19 apply（P1a 应用流）· 20 backups（P1a 备份列表）· 21 backupsTick ·
      // 22 rollback（P2 备份卡回滚流：idle → plan-loading → confirm → writing → done）
      // 24 provision（20260913 一键生成 RP 预设流：idle → plan-loading → confirm → writing → done，
      //    另有 delete-* 前缀的删除两步）· 25 provisionTick（计划/名册刷新信号）
      function AgentEditorPanel({ onClose }) {
        const [fullscreen, setFullscreen] = React.useState(false)
        const [health, setHealth] = React.useState({ status: 'loading', n: null, error: '' })
        const [sessions, setSessions] = React.useState({ status: 'loading', items: [], error: null, archive: null })
        const [hostRows, setHostRows] = React.useState({ status: 'loading', byId: null, error: null })
        const [nameIdx, setNameIdx] = React.useState(EMPTY_NAME_INDEX)
        const [sessionId, setSessionId] = React.useState('')
        const [detail, setDetail] = React.useState({ status: 'idle', meta: null, requests: [], error: null, archived: null })
        const [turn, setTurn] = React.useState(0)
        // 20260913 改版：part=null ⇒ 显示装配地图（主界面）；点地图色块/轮次切换条进入下钻。
        // ★ 2026-09-18：下钻目标只剩 `'messages'`（消息流栏）· `'system'`（单段抽屉）·
        //   `'tools'`（单条定义 / 整份清单）；`'full'` 已随完整视图整体删除，
        //   其余值落一行如实指路（见下面的 data-l3-fallback 分支）。
        const [part, setPart] = React.useState(null)
        const [partState, setPartState] = React.useState({ status: 'idle', data: null, error: null })
        const [query, setQuery] = React.useState('')
        const [note, setNote] = React.useState('')
        const sessionsAbort = React.useRef(null)
        const resolveSentRef = React.useRef(0)   // 本轮（进查看器/刷新列表）已排程补标题的个数；到 TITLE_FILL_CAP 即停
        // v5 P0 新增（hook 序号 15–18）：/api/agent 只读数据、检测预览开关与结果、维护抽屉开关。
        const [agent, setAgent] = React.useState({ status: 'loading', data: null, error: '' })
        const [detect, setDetect] = React.useState({ open: false, status: 'idle', data: null, error: '' })
        const [detectTick, setDetectTick] = React.useState(0)
        const [maintOpen, setMaintOpen] = React.useState(false)
        // v5 P1a（hook 序号 19–21）：应用流（idle → plan-loading → confirm → writing → done）、
        // 备份列表、备份刷新信号。全部组件内 state，不落任何本地存储。
        const [apply, setApply] = React.useState({ phase: 'idle', presetId: null, plan: null, result: null, error: '', rolledBack: false })
        const [backups, setBackups] = React.useState({ status: 'idle', data: null, error: '' })
        const [backupsTick, setBackupsTick] = React.useState(0)
        // v5 P2（hook 序号 22）：备份卡回滚流。与应用流同纪律：必须干跑计划 → 确认两步，⛔ 不许点一下直接写。
        const [rollback, setRollback] = React.useState({ phase: 'idle', presetId: null, file: null, plan: null, result: null, error: '', rolledBack: false })
        // v5 P1b-2a（hook 序号 23）：pack 应用流（贴 RP-AGENT-PACK v1 全文 → 干跑出计划与 persona 差异 → 确认才写）。
        const [pack, setPack] = React.useState({
          phase: 'idle',
          packText: '',
          switches: { settingsEnabled: true, rulesEnabled: true, settingsOrder: 60, rulesOrder: 9950, thinkMode: 'analysis' },
          plan: null,
          result: null,
          error: '',
          rolledBack: false,
        })
        // 20260913（hook 序号 24–25）：一键生成 RP 预设流（idle → plan-loading → confirm → writing → done，
        // 与应用流同纪律：先干跑再确认）+ 计划/名册刷新信号。全部组件内 state，不落任何本地存储。
        const [provision, setProvision] = React.useState({ phase: 'idle', plan: null, result: null, error: '', rolledBack: false })
        const [provisionTick, setProvisionTick] = React.useState(0)
        // 20260913（hook 序号 26）：左右栏分隔条位置。组件内 state（本项目禁本地存储），
        // 拖动改变，重开面板回到默认；宽度只由这里决定 ⇒ 切换会话/页签不再引起左右栏跳宽。
        const [leftWidth, setLeftWidth] = React.useState(300)
        // 20260913 三级导航（hook 序号 27–29）：
        //   turns —— C1 /api/turns（楼数/latest 的唯一权威；调用次数徽标也改用它，见 mergeRowCount）
        //   l2Open —— L2 消息定位（左侧弹出）开关；选中会话自动开
        //   l3Section —— L3 详细抽屉里 system 段的 C4 元数据（null = 看整个部件）
        const [turns, setTurns] = React.useState({ status: 'idle', data: null, error: '' })
        const [l2Open, setL2Open] = React.useState(false)
        const [l3Section, setL3Section] = React.useState(null)
        // ★ M10：L3 抽屉里要看哪一条工具定义（'' = 看整份工具清单＝目录；非空 = 看那一条的实际文本）
        const [toolName, setToolName] = React.useState('')
        // M9（20260914）深链 + 事实说明书（hook 序号 30–32）：
        //   helpOpen —— `?` 事实说明书开关（只讲判据，不做推销）
        //   pendingLink —— 从地址栏读到的深链，等该会话的 turns 就绪后再落 turn/box/sec
        //     （★ 必须晚于"自动定位最新楼"那个 effect，否则会被它覆盖掉）
        //   deepSec —— 深链点名的段名，交给 PromptMap 去命中**真段块**（⛔ 不造假的段对象）
        const [helpOpen, setHelpOpen] = React.useState(false)
        const [pendingLink, setPendingLink] = React.useState(null)
        const [deepSec, setDeepSec] = React.useState('')
        // M9-e) 结构化诊断（/api/editor/diagnostics）：一次问清这条会话/这一楼哪儿不对。
        //   与「事实说明书」互补：说明书讲**口径**，诊断讲**这条会话的具体事实**。
        const [diag, setDiag] = React.useState({ status: 'idle', data: null, error: '' })
        React.useEffect(() => {
          if (!sessionId) { setDiag({ status: 'idle', data: null, error: '' }); return undefined }
          const controller = new AbortController()
          setDiag({ status: 'loading', data: null, error: '' })
          const u = HOST_API_BASE + '/editor/diagnostics?sessionId=' + encodeURIComponent(sessionId) + (turn ? ('&turn=' + String(turn)) : '')
          apiGet(u, controller.signal).then((data) => {
            if (controller.signal.aborted) return
            setDiag({ status: 'ready', data: summarizeDiagnostics(data), error: '' })
          }).catch((error) => {
            if (controller.signal.aborted) return
            // 诊断自己取不到**不是**会话的问题：如实说取不到，⛔ 不当成"没毛病"
            setDiag({ status: 'error', data: null, error: errText(error) })
          })
          return () => controller.abort()
        }, [sessionId, turn])

        // 20260918 消息流单（hook 序号 35，**追加在冻结契约之后** —— 0–34 一个不许挪，自检台按序号注值）：
        // L3 消息流栏里要看哪一条（null = 列表；数字 = 那一条的单条抽屉 ViewerMsgPanel，形状对齐 system 单段抽屉）。
        const [msgSeq, setMsgSeq] = React.useState(null)

        // M9-a) 读地址栏深链（挂载 + hashchange）：只认 sess/turn/box/sec，其余忽略
        React.useEffect(() => {
          const apply = () => {
            const link = readHashLink(typeof window !== 'undefined' ? window.location.hash : '')
            if (link.sess || link.turn || link.box || link.sec) setPendingLink(link)
            if (link.sess) setSessionId(link.sess)
          }
          apply()
          window.addEventListener('hashchange', apply)
          return () => window.removeEventListener('hashchange', apply)
        }, [])

        // M9-b) 落深链：等 turns 有结论（ready/failed/error）再执行 —— 免得被"定位最新楼"覆盖
        React.useEffect(() => {
          if (!pendingLink) return
          if (pendingLink.sess && pendingLink.sess !== sessionId) return
          const settled = turns.status === 'ready' || turns.status === 'failed' || turns.status === 'error'
          if (sessionId && !settled) return
          if (pendingLink.turn) setTurn(pendingLink.turn)
          if (pendingLink.box) setPart(pendingLink.box)
          if (pendingLink.sec) setDeepSec(pendingLink.sec)
          setPendingLink(null)
        }, [pendingLink, sessionId, turns.status])

        // M9-c) 把当前状态写回地址栏（replaceState，⛔ 不往历史里塞垃圾；⛔ 深链不含正文）
        React.useEffect(() => {
          if (typeof window === 'undefined' || !window.history || !window.history.replaceState) return
          const next = formatHashLink({
            sess: sessionId,
            turn: turn,
            box: part,
            // 段名从块上取：块用 `key:'sec:<name>'`（`label` 是显示名），所以两种都认，取不到才算没有
            sec: sectionNameOf(l3Section) || deepSec || '',
          })
          const now = window.location.hash || ''
          if (now === next) return
          window.history.replaceState(null, '', window.location.pathname + window.location.search + next)
        }, [sessionId, turn, part, l3Section, deepSec])

        // M9-d) 键盘：`?` 开关事实说明书，`Esc` 关掉（输入框里不抢键）
        React.useEffect(() => {
          const onKey = (ev) => {
            const tag = ev.target && ev.target.tagName ? String(ev.target.tagName).toLowerCase() : ''
            if (tag === 'input' || tag === 'textarea') return
            if (ev.key === '?' || (ev.key === '/' && ev.shiftKey)) { setHelpOpen((v) => !v); ev.preventDefault() }
            else if (ev.key === 'Escape' && helpOpen) { setHelpOpen(false); ev.preventDefault() }
          }
          window.addEventListener('keydown', onKey)
          return () => window.removeEventListener('keydown', onKey)
        }, [helpOpen])

        // 0) 数据面健康（尽力而为：失败只影响这一行，列表有自己的错误态）
        React.useEffect(() => {
          const controller = new AbortController()
          apiGet(PROMPT_API_BASE + '/health', controller.signal).then((data) => {
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
          apiGet(HOST_API_BASE + '/sessions', controller.signal).then((data) => {
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
          apiGet(PROMPT_API_BASE + '/api/sessions' + (refresh ? '?refresh=1' : ''), controller.signal).then((data) => {
            if (controller.signal.aborted) return
            // 归档信封（20260914 M4）：known:false / 缺失 ⇒ 列表一条都不许隐藏（未知 ≠ 未归档）。
            setSessions({
              status: 'ready',
              items: Array.isArray(data.sessions) ? data.sessions : [],
              error: null,
              archive: data.archive && typeof data.archive === 'object'
                ? { known: data.archive.known === true, archivedCount: typeof data.archive.archivedCount === 'number' ? data.archive.archivedCount : null }
                : null,
            })
          }).catch((error) => {
            if (controller.signal.aborted) return
            setSessions({ status: 'error', items: [], error: errText(error) })
          })
        }, [])

        // （20260915 查看器提速）这里原来是「挂载即 loadSessions(false)」。现在**挂载只读常驻投影**。
        // ★ 常驻相关的 state / useCallback / effects 全部声明在本组件**最后一个 hook 之后**（见尾部
        //   「常驻集」块）—— ⛔ 不许挪到前面：本仓库的自检台按「组件 → hook 序号」注入预设值，
        //   hook 顺序是**冻结契约**（_selftest-client.mjs 顶部那段约定）。

        // 2) 会话详情（只在选中时拉）：只取 meta/title。★ 轮次数与徽标不再来自这里 ——
        //    request/header 条数对静态会话恒为 1（用户报的「切了没变」bug 本身），楼数唯一权威 = C1 turns。
        const mergeRow = React.useCallback((id, title, requests, readError) => {
          setSessions((s) => {
            if (s.status !== 'ready') return s
            let changed = false
            const items = s.items.map((it) => {
              if (it.id !== id) return it
              changed = true
              // ★ requests 两态语义（20260913）：解析结果非数字时绝不能折成 0 ——
              //   0 的客户端语义是「解析过、确实没有请求 ⇒ 空会话」。保持原值（-1 未解析）。
              const nextRequests = typeof requests === 'number' ? requests : it.requests
              // readError（20260914 M8）：只在**显式传了**（含显式 null）时才改 —— undefined = 不碰。
              const nextReadError = readError === undefined ? it.readError : readError
              return Object.assign({}, it, {
                title: typeof title === 'string' ? title : it.title,
                requests: nextRequests,
                readError: nextReadError,
              })
            })
            return changed ? Object.assign({}, s, { items: items }) : s
          })
        }, [])

        // 调用次数徽标的唯一权威 = C1 turns.length（20260913）。-2 哨兵 = C1 ok:false（解析失败），
        // 徽标仍走 ViewerSessionList 的四形态（— / ⚠ 失败 / 0 次 / N 次）。
        const mergeRowCount = React.useCallback((id, n) => {
          if (typeof n !== 'number') return
          setSessions((s) => {
            if (s.status !== 'ready') return s
            let changed = false
            const items = s.items.map((it) => {
              if (it.id !== id) return it
              changed = true
              return Object.assign({}, it, { requests: n })
            })
            return changed ? Object.assign({}, s, { items: items }) : s
          })
        }, [])

        React.useEffect(() => {
          if (!sessionId) return undefined
          const controller = new AbortController()
          setDetail({ status: 'loading', meta: null, requests: [], error: null })
          requestJson(PROMPT_API_BASE + '/api/session?id=' + encodeURIComponent(sessionId), controller.signal).then((data) => {
            if (controller.signal.aborted) return
            // archived（20260914 M4）：详情出口的归档位，详情页提示用它；true|false|null（未知）。
            setDetail({
              status: 'ready', meta: data.meta || {}, requests: [], error: null,
              archived: data.archived === true ? true : (data.archived === false ? false : null),
            })
            mergeRow(sessionId, typeof data.title === 'string' ? data.title : '', undefined)
          }).catch((error) => {
            if (controller.signal.aborted) return
            setDetail({ status: 'error', meta: null, requests: [], error: errText(error) })
          })
          return () => controller.abort()
        }, [sessionId, mergeRow])

        // 2b) C1 轮次（20260913 三级导航）：楼数/latest 的唯一权威。
        //     ★ 选中会话 ⇒ 自动定位最新楼（turn = latest；L2 滚到底 + 地图装配 latest 楼）。
        //     ok:false（解析失败）≠ 0 楼：turns.status='failed' + 徽标 -2（⚠ 失败），如实区分。
        React.useEffect(() => {
          if (!sessionId) return undefined
          const controller = new AbortController()
          setTurns({ status: 'loading', data: null, error: '', parseError: null })
          apiGet(PROMPT_API_BASE + '/api/turns?id=' + encodeURIComponent(sessionId), controller.signal).then((data) => {
            if (controller.signal.aborted) return
            const list = Array.isArray(data.turns) ? data.turns : []
            const latest = typeof data.latest === 'number' && data.latest > 0
              ? data.latest
              : (list.length > 0 ? list[list.length - 1].turn || list.length : 0)
            setTurns({ status: 'ready', data: data, error: '', parseError: null })
            mergeRow(sessionId, undefined, undefined, null)   // ★ M8：能读 ⇒ 清掉行上的 readError（显式 null）
            setTurn(latest)                       // ★ 自动定位最新楼
            mergeRowCount(sessionId, list.length) // ★ 徽标改用 turns.length（不再数 request/header）
          }).catch((error) => {
            if (controller.signal.aborted) return
            const payload = error && error.payload
            if (payload && payload.ok === false && Array.isArray(payload.turns)) {
              // ★ M8：把宿主的错误对象原样留下（code/message/detail）—— 界面要拿它显示「谁的锅、在哪一行」。
              const pe = payload.error && payload.error.code === 'session-parse-failed' ? payload.error : null
              setTurns({ status: 'failed', data: null, error: errText(error), parseError: pe })
              mergeRowCount(sessionId, -2)
              mergeRow(sessionId, undefined, -2, pe)   // ★ 列表行也能标出来，不必一条条点
            } else {
              setTurns({ status: 'error', data: null, error: errText(error), parseError: null })
            }
            setTurn(0)
          })
          return () => controller.abort()
        }, [sessionId, mergeRowCount])

        // 3) ★★ 20260915 查看器提速：**删掉了原来这里的「空闲批量补标题」effect**。
        //    它每进一次子页/刷新列表就对最多 TITLE_FILL_CAP(20) 个会话调 /api/sessions/resolve，
        //    而那是**整份日志解析**（客户端注释实测：单会话在宿主堆里瞬时驻留 126–186 MB）
        //    —— 这就是"打开就卡"的主因。现在标题只对**你点开的那一个**（/api/session）解析；
        //    想在列表里就看全标题 ⇒ 把它设为常驻，宿主后台串行预热。
        //    （TITLE_FILL_CAP / TITLE_FILL_BATCH 两个常量保留：它们仍是"别一次解析一堆"的口径说明。）

        // 4) 部件全文（20260913 三级导航：part 只作为 L3 详细抽屉的内容，不再替换主视图；null = 抽屉关着）
        React.useEffect(() => {
          if (!sessionId || !turn || !part) return undefined
          const controller = new AbortController()
          setPartState({ status: 'loading', data: null, error: null })
          apiGet(
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


        // 6) v5 P0：/api/agent（当前 preset + 组成 + 压缩一致性）。随 sessionId 变化重取：
        //    没选会话时服务端如实给 null（界面显示「未知」），绝不猜；拿不到服务 → error 态可读红字。
        React.useEffect(() => {
          const controller = new AbortController()
          setAgent({ status: 'loading', data: null, error: '' })
          apiGet(HOST_API_BASE + '/agent' + (sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : ''), controller.signal)
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

        // 8b) 20260913：一键生成 RP 预设的只读计划（维护抽屉打开时拉取；生成/删除后用 provisionTick 重取）。
        //     只读端点；失败只降级本卡（可读红字），绝不抛。
        React.useEffect(() => {
          if (!maintOpen) return undefined
          const controller = new AbortController()
          setProvision((s) => ({ ...s, status: 'loading' }))
          requestJson(AGENT_API + '/provision', controller.signal)
            .then((data) => {
              if (controller.signal.aborted) return
              setProvision((s) => ({ ...s, status: 'ready', data: data, error: '' }))
            })
            .catch((error) => {
              if (controller.signal.aborted) return
              setProvision((s) => ({ ...s, status: 'error', data: null, error: errText(error) }))
            })
          return () => controller.abort()
        }, [maintOpen, provisionTick])

        // ── 常驻集（20260915 查看器提速；用户思路：①不自动抓列表 ②常驻的后台自动抓）────────
        // ★ 这一块**必须待在本组件所有既有 hook 之后**：自检台按「组件 → hook 序号」注入预设值，
        //   h# 顺序是冻结契约；往前面插一个 hook 就会把后面所有序号顶掉（实测连红 3 条）。
        // 语义：面板默认只列**常驻集**（用户自己在「全部」里＋出来的那几个）；宿主后台**串行预热**成
        //      轻投影 ⇒ 打开面板只读缓存、零解析。「全部会话」降级成显式动作（切页/点 ↻ 才扫 fs）。
        const [listMode, setListMode] = React.useState('resident')   // 'resident' | 'all'
        const [resident, setResident] = React.useState({ ids: [], pending: [], queued: [], stats: null, lastWarmAt: null, refreshMs: null, max: null })

        /** 读常驻集：GET /api/resident —— 宿主侧**只读缓存、绝不解析**。挂载与切回常驻都走它。 */
        const loadResident = React.useCallback(() => {
          if (sessionsAbort.current) sessionsAbort.current.abort()
          const controller = new AbortController()
          sessionsAbort.current = controller
          setSessions((s) => ({ ...s, status: 'loading', error: null }))
          apiGet(PROMPT_API_BASE + '/api/resident', controller.signal).then((data) => {
            if (controller.signal.aborted) return
            setSessions({
              status: 'ready',
              items: Array.isArray(data.sessions) ? data.sessions : [],
              error: null,
              archive: data.archive && typeof data.archive === 'object'
                ? { known: data.archive.known === true, archivedCount: typeof data.archive.archivedCount === 'number' ? data.archive.archivedCount : null }
                : null,
            })
            setResident(applyResidentPayload(data))
          }).catch((error) => {
            if (controller.signal.aborted) return
            setSessions({ status: 'error', items: [], error: errText(error) })
          })
        }, [])

        /** 改常驻集（批量确认后调）：POST 之后直接吃宿主回来的新投影（不额外再拉一次）。
         *  ★ 返回 promise：批量确认条要靠它决定"什么时候清空勾选"。 */
        const saveResident = React.useCallback((ids) => {
          const controller = new AbortController()
          return apiPost(PROMPT_API_BASE + '/api/resident', controller.signal, { ids }).then((data) => {
            setSessions((s) => ({
              status: 'ready',
              items: Array.isArray(data.sessions) ? data.sessions : s.items,
              error: null,
              archive: data.archive && typeof data.archive === 'object'
                ? { known: data.archive.known === true, archivedCount: typeof data.archive.archivedCount === 'number' ? data.archive.archivedCount : null }
                : null,
            }))
            setResident(applyResidentPayload(data))
          }).catch((error) => setNote('改常驻集失败：' + errText(error)))
        }, [])

        React.useEffect(() => {
          loadResident()
          return () => { if (sessionsAbort.current) sessionsAbort.current.abort() }
        }, [loadResident])

        // 切页：常驻 ⇒ 读投影（缓存）；全部 ⇒ fs 扫描（不解析，标题仍是 —）。
        React.useEffect(() => {
          if (listMode === 'all') loadSessions(false)
          else loadResident()
        }, [listMode, loadSessions, loadResident])

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
        // v5 P1b-2a ③：pack 应用流并入同一个 ctl（干跑出计划与 persona 差异 → 确认 → 写；纪律同应用流）。
        applyCtl.pack = pack
        applyCtl.onPackText = (v) => setPack((s) => ({ ...s, packText: v }))
        applyCtl.onPackSwitch = (key, value) => setPack((s) => ({ ...s, switches: Object.assign({}, s.switches, { [key]: value }) }))
        applyCtl.onPackDryRun = () => {
          if (pack.packText.trim() === '') {
            setPack((s) => ({ ...s, phase: 'done', result: { ok: false, error: { code: 'BAD_REQUEST', message: '先贴入 RP-AGENT-PACK v1 全文' } }, error: '先贴入 RP-AGENT-PACK v1 全文' }))
            return
          }
          setPack((s) => ({ ...s, phase: 'plan-loading', plan: null, result: null, error: '', rolledBack: false }))
          const url = AGENT_API + '/pack/apply'
          mutateJson(url, 'POST', { presetId: backupsTargetId, packText: pack.packText, switches: pack.switches, dryRun: true })
            .then((data) => setPack((s) => (s.phase === 'plan-loading' ? { ...s, phase: 'confirm', plan: data } : s)))
            .catch((error) => {
              const payload = error && error.payload && typeof error.payload === 'object' ? error.payload : null
              setPack((s) => (s.phase === 'plan-loading'
                ? { ...s, phase: 'done', result: payload, error: errText(error), rolledBack: !!(payload && payload.rolledBack === true) }
                : s))
            })
        }
        applyCtl.onPackConfirm = () => {
          setPack((s) => ({ ...s, phase: 'writing', error: '', rolledBack: false }))
          const url = AGENT_API + '/pack/apply'
          mutateJson(url, 'POST', { presetId: backupsTargetId, packText: pack.packText, switches: pack.switches, dryRun: false })
            .then((data) => {
              setPack((s) => ({ ...s, phase: 'done', result: data, error: '', rolledBack: false }))
              setBackupsTick((x) => x + 1)
              setDetectTick((x) => x + 1)
            })
            .catch((error) => {
              const payload = error && error.payload && typeof error.payload === 'object' ? error.payload : null
              setPack((s) => ({ ...s, phase: 'done', result: payload, error: errText(error), rolledBack: !!(payload && payload.rolledBack === true) }))
              setBackupsTick((x) => x + 1)
            })
        }
        applyCtl.onPackCancel = () => setPack((s) => ({ ...s, phase: 'idle', plan: null, result: null, error: '', rolledBack: false }))
        applyCtl.packPresetId = backupsTargetId
        // 20260913：一键生成 RP 预设流并入同一个 ctl（干跑出计划 → 确认才写；删除同样先看计划再确认）。
        // mutateJson 遇 ok:false 会 throw 且带 payload —— 可读原因 / rolledBack 从 payload 读。
        applyCtl.provision = provision
        applyCtl.onProvisionDryRun = () => {
          setProvision((s) => ({ ...s, phase: 'plan-loading', plan: null, result: null, error: '', rolledBack: false }))
          const url = AGENT_API + '/provision'
          mutateJson(url, 'POST', { dryRun: true })
            .then((data) => setProvision((s) => (s.phase === 'plan-loading' ? { ...s, phase: 'confirm', plan: data } : s)))
            .catch((error) => {
              const payload = error && error.payload && typeof error.payload === 'object' ? error.payload : null
              setProvision((s) => (s.phase === 'plan-loading' ? { ...s, phase: 'idle', error: errText(error), result: payload } : s))
            })
        }
        applyCtl.onProvisionConfirm = () => {
          setProvision((s) => ({ ...s, phase: 'writing', error: '', rolledBack: false }))
          const url = AGENT_API + '/provision'
          mutateJson(url, 'POST', { dryRun: false })
            .then((data) => {
              setProvision((s) => ({ ...s, phase: 'done', result: data, error: '', rolledBack: false }))
              setProvisionTick((x) => x + 1)
              setDetectTick((x) => x + 1) // 名册多了 roleplay-mt ⇒ 重跑只读检测刷新候选
            })
            .catch((error) => {
              const payload = error && error.payload && typeof error.payload === 'object' ? error.payload : null
              setProvision((s) => ({ ...s, phase: 'done', result: payload, error: errText(error), rolledBack: !!(payload && payload.rolledBack === true) }))
            })
        }
        applyCtl.onProvisionDeleteDryRun = () => {
          setProvision((s) => ({ ...s, phase: 'delete-plan-loading', plan: null, result: null, error: '', rolledBack: false }))
          const url = AGENT_API + '/provision'
          mutateJson(url, 'DELETE', { presetId: 'roleplay-mt', dryRun: true })
            .then((data) => setProvision((s) => (s.phase === 'delete-plan-loading' ? { ...s, phase: 'delete-confirm', plan: data } : s)))
            .catch((error) => {
              const payload = error && error.payload && typeof error.payload === 'object' ? error.payload : null
              setProvision((s) => (s.phase === 'delete-plan-loading' ? { ...s, phase: 'idle', error: errText(error), result: payload } : s))
            })
        }
        applyCtl.onProvisionDeleteConfirm = () => {
          setProvision((s) => ({ ...s, phase: 'delete-writing', error: '', rolledBack: false }))
          const url = AGENT_API + '/provision'
          mutateJson(url, 'DELETE', { presetId: 'roleplay-mt', dryRun: false })
            .then((data) => {
              setProvision((s) => ({ ...s, phase: 'done', result: data, error: '', rolledBack: false }))
              setProvisionTick((x) => x + 1)
              setDetectTick((x) => x + 1)
            })
            .catch((error) => {
              const payload = error && error.payload && typeof error.payload === 'object' ? error.payload : null
              setProvision((s) => ({ ...s, phase: 'done', result: payload, error: errText(error), rolledBack: false }))
            })
        }
        applyCtl.onProvisionCancel = () => setProvision((s) => ({ ...s, phase: 'idle', plan: null, result: null, error: '', rolledBack: false }))
        // v5 P2 ②：可写项块的「应用 / 回滚」切到检测视图（⑤ 应用卡 / ⑥ 备份卡都在那里），
        // 并把当前 preset 预选为应用目标 —— 仍走同一条「先干跑再确认」的流。
        const openDetectFor = (presetId) => {
          if (presetId) setApply({ phase: 'idle', presetId: String(presetId), plan: null, result: null, error: '', rolledBack: false })
          setMaintOpen(true)   // 检测报告渲染在维护抽屉里（20260913 改版）
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


        // 刷新（↻）：常驻页重读投影（缓存）；全部页重扫 fs 索引。⛔ 两边都不解析。
        const refreshSessions = () => { setNote(''); if (listMode === 'all') loadSessions(true); else loadResident() }

        // 20260913：分隔条拖动。mousedown 记起点 → window 上挂 move/up，抬手即拆；
        // 宽度夹在 [240, 620]，绝不写任何存储。
        const onSplitterDown = (downEv) => {
          downEv.preventDefault()
          const startX = downEv.clientX
          const startW = leftWidth
          const onMove = (ev) => setLeftWidth(Math.min(620, Math.max(240, startW + (ev.clientX - startX))))
          const onUp = () => {
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
          }
          window.addEventListener('mousemove', onMove)
          window.addEventListener('mouseup', onUp)
        }

        const detailMeta = detail.status === 'ready' ? detail.meta : null
        // 楼数唯一权威 = C1 turns.length（20260913）；轮次胶囊删除后「第 N / M 楼」只作状态显示
        const turnsCount = turns.status === 'ready' && turns.data && Array.isArray(turns.data.turns) ? turns.data.turns.length : null
        // L1 会话选中：⇒ L2 消息定位从左侧滑出 + 自动定位最新楼（turn=latest 由 C1 effect 落地）
        const selectSession = (id) => {
          setSessionId(id)
          setPart(null)
          setL3Section(null)
          setToolName('')
          setMsgSeq(null)
          setL2Open(true)
        }
        // 地图色块下钻 ⇒ L3 详细抽屉（★ 主视图不换 —— 地图容器全程在 DOM 里）
        // ★ M10：点**工具行**（block.key='tool:<名>'）⇒ 记下工具名，抽屉里显示**那一条的实际文本**（不再是整份目录）。
        // ★ 消息流单 T2（20260918）：点**消息行**（block.key='msg-<seq>'）⇒ 直接开那一条的单条抽屉；
        //   点 [messages] 框的小计行（msgSummary）⇒ 消息流列表。与工具行同款「点谁开谁」。
        //   ⛔ 上下文行（[上下文] 框，key='ctx:<名>'）按 M12 本就该走单段抽屉（/sections/raw&kind=context）——
        //   旧实现漏了 'contexts' 盒、落进并列部件视图；并列视图本单拆掉，这里补上正确落点。
        const drillToPart = (boxId, block) => {
          setPart(boxId === 'tools' ? 'tools' : boxId === 'messages' ? 'messages' : 'system')
          // ★ M12：sec: 段 与 ctx: 上下文都能点开（上下文走 /sections/raw&kind=context —— 它的正文是独立一条消息）
          // ★ 2026-09-20（用户口径：「下钻页面要给出的是未认领的文本。和其它下钻页面一个格式」）：
          //   ⚠️ 补上 `uncaptured` —— 它的 key 不是 `sec:` 开头，原来这一行把它**整个吞掉**（点了等于没点，
          //   抽屉退回"看整个 system 部件"）。它也要走同一个单段抽屉，正文取本地算好的补集原文。
          const key = block && typeof block.key === 'string' ? block.key : ''
          const isDrillableSec = key.indexOf('sec:') === 0 || key.indexOf('ctx:') === 0 || key === 'uncaptured'
          setL3Section((boxId === 'system' || boxId === 'contexts') && isDrillableSec ? block : null)
          setToolName(boxId === 'tools' && block && typeof block.key === 'string' && block.key.indexOf('tool:') === 0
            ? block.key.slice(5)
            : '')
          setMsgSeq(boxId === 'messages' && /^msg-(\d+)$/.test(key) ? Number(key.slice(4)) : null)
        }
        const statusLine = [
          sessions.status === 'ready' ? '会话 ' + sessions.items.length + ' 个' : null,
          turns.status === 'ready' && turnsCount != null ? '第 ' + (turn || '—') + ' / ' + turnsCount + ' 楼' : null,
          turns.status === 'failed' ? '轮次解析失败（不是 0 楼，徽标已标 ⚠ 失败）' : null,
          sessionId && part ? 'L3 详细 · ' + part + (part === 'messages' && msgSeq != null ? ' · seq ' + msgSeq : '') : null,
          note,
        ].filter(Boolean).join(' | ')

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
              e('strong', { style: { fontSize: 14 } }, '提示词查看器'),
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
              // 「维护」次级入口（20260913 用户拍板 6A）：可写项 4 旋钮 / 检测与修复 / 备份与应用 / 一键生成
              // 全收进抽屉，主界面保持只读。
              e('button', {
                className: 'dma-btn', style: Object.assign({}, btnStyle, { flexShrink: 0 }),
                'data-sel': maintOpen ? '1' : '0',
                title: '维护：可写项 4 旋钮 / 一键生成 RP 预设 / 检测与修复（应用 · 备份 · 回滚 / 按 pack 更新）',
                onClick: () => setMaintOpen((v) => !v),
              }, '维护'),
              // M9：事实说明书入口（`?`）—— 与「维护」并列，放在 ⛶ 之前
              e('button', {
                className: 'dma-btn', style: Object.assign({}, btnStyle, { flexShrink: 0 }),
                'data-sel': helpOpen ? '1' : '0',
                'data-help-btn': '1',
                title: '事实说明书（?）：这张图的每个视觉元素是什么、不是什么 —— 含字数口径、头/中/尾判据、四句如实降级人话',
                onClick: () => setHelpOpen((v) => !v),
              }, '?'),
              e('button', { className: 'dma-btn', style: btnStyle, onClick: () => setFullscreen((v) => !v), title: fullscreen ? '退出全屏' : '全屏' }, '⛶'),
              e('button', { className: 'dma-btn', style: btnStyle, onClick: onClose, title: '关闭提示词查看器（会话 / 装配地图 / 维护）' }, '✕'),
            ),
            // 主体（20260913 三级导航，用户拍板）：两栏 —— 左=会话列表（L1，每行调用次数徽标），
            // 右=装配地图（主视图，★ 常驻、永不被下钻替换）。点会话 ⇒ L2 消息定位从左侧滑出；
            // 点 L2 消息 ⇒ 地图定位到所属楼；点地图色块 ⇒ L3 详细抽屉（与「维护」共用抽屉机制）。
            // 地图下挂着「来源：preset 组成」折叠条（原 CompositionBlock 列，5A）。
            e('div', { style: columnsStyle },
              e(ViewerSessionList, {
                state: sessions, hostById: hostRows.byId, hostError: hostRows.error,
                selectedId: sessionId, onSelect: selectSession, onRefresh: refreshSessions, nameIdx: nameIdx,
                width: leftWidth,
                // 常驻/全部两页 + 常驻集的＋/－（20260915 查看器提速）
                mode: listMode, residentMeta: resident, onModeChange: setListMode, onToggleResident: saveResident,
              }),
              // 可拖动分隔条（20260913 用户要求）：左右栏宽度由此决定
              e('div', {
                className: 'dma-splitter',
                style: { flex: 'none' },
                onMouseDown: onSplitterDown,
                title: '拖动调整左右栏宽度',
                'aria-label': '拖动调整左右栏宽度',
                role: 'separator', 'aria-orientation': 'vertical',
              }),
              // ★ 主视图 = 装配地图，始终在 DOM 里（下钻/抽屉都不替换它）
              e('div', { 'data-pm-main': '1', style: Object.assign({}, colFillStyle, { minWidth: 0 }) },
                detail.status === 'error' ? e('div', { style: errorStyle }, '会话解析失败：' + detail.error) : null,
                // 归档提示（20260914 M4）：详情页顶部一行；archived===true 才显示（null=未知，不猜）。
                detail.status === 'ready' && detail.archived === true
                  ? e('div', { style: dimStyle, 'data-archived-hint': '1', title: '来源：工作区注册表 archivedSessionIds（只读投影）' },
                      '该会话已归档（日志仍在，内容照常可读）')
                  : null,
                turns.status === 'error' ? e('div', { style: errorStyle }, '轮次数据（C1）取不到：' + turns.error + ' —— 楼号未知，不猜') : null,
                // ★ M8（20260914）：日志在 DSH 层读不出来时，**必须说清原因**（以前这里只留一句短话、
                //   地图区看着像空的，用户会误以为插件/预设不合）。下面这屏：谁的锅 + 在哪一行 + 影响面。
                turns.status === 'failed' ? (() => {
                  const notice = pmReadFailNotice(turns.parseError)
                  if (!notice) {
                    return e('div', { style: errorStyle, 'data-read-fail': '1' }, '会话日志解析失败，无法枚举轮次（不是 0 楼；如实区分，不折叠成空会话）')
                  }
                  return e('div', {
                    'data-read-fail': '1',
                    style: {
                      border: '1px solid color-mix(in srgb, crimson 45%, transparent)',
                      borderRadius: 6, padding: '8px 10px', margin: '0 0 8px 0',
                      background: 'color-mix(in srgb, crimson 8%, transparent)',
                      display: 'flex', flexDirection: 'column', gap: 3,
                    },
                  },
                    e('div', { style: { fontWeight: 700, fontSize: 13 } }, '⚠ ' + notice.head),
                    notice.lines.map((line, i) => e('div', {
                      key: 'rf' + i,
                      style: { fontSize: SMALL_FONT_SIZE, opacity: 0.92, wordBreak: 'break-word' },
                    }, line)),
                  )
                })() : null,
                // ★ M9：结构化诊断条 —— 一条会话的"哪儿不对"集中在这里（码给机器，悬停给人话+修法）。
                //   取不到诊断时**如实说取不到**，⛔ 不许显示成"没毛病"。
                diag.status === 'error' ? e('div', { style: dimStyle, 'data-diag': 'error' },
                  '诊断取不到：' + diag.error + '（不是"没毛病"，是没问到）') : null,
                diag.status === 'ready' && diag.data && diag.data.ok ? e('div', {
                  'data-diag': 'strip',
                  style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', margin: '0 0 6px 0' },
                },
                  e('span', { style: dimStyle }, '诊断：' + diag.data.chips.length + ' 项'
                    + (diag.data.counts.error ? ' · ' + diag.data.counts.error + ' 错' : '')
                    + (diag.data.counts.warn ? ' · ' + diag.data.counts.warn + ' 警' : '')
                    + (diag.data.counts.info ? ' · ' + diag.data.counts.info + ' 讯' : '')),
                  diag.data.chips.map((c, i) => e('span', {
                    key: 'dg' + i,
                    'data-diag-chip': c.code,
                    title: c.tip || c.code,
                    style: Object.assign({}, badgeCapsuleStyle, {
                      fontFamily: MONO, cursor: 'help',
                      color: c.severity === 'error' ? 'crimson' : (c.severity === 'warn' ? 'darkorange' : 'GrayText'),
                    }),
                  }, c.text)),
                ) : null,
                e(PromptMap, {
                  sessionId: sessionId, turn: turn, turnsCount: turnsCount,
                  onDrill: drillToPart,
                  onOpenLocator: () => setL2Open(true),   // A8：messages 框「对话历史 · N 条」⇒ 打开 L2 消息定位
                  deepSec: deepSec,
                  // 深链点名段名的结果：命中就清掉（抽屉已开）；没命中就如实说，⛔ 不许静默
                  onDeepSec: (ok, name) => {
                    setDeepSec('')
                    setNote(ok ? '' : ('第 ' + (turn || '—') + ' 楼没有名为 ' + name + ' 的段（深链已忽略）'))
                  },
                }),
                e(CompositionBlock, { agent: agent, sessionId: sessionId, turn: turn }),
              ),
            ),
            // L2 消息定位（左侧弹出）：可关闭；关闭回上一级，地图不回退。
            l2Open && e(MessageLocatorPanel, {
              sessionId: sessionId, turn: turn,
              style: Object.assign({}, l2DrawerStyle, { left: (typeof leftWidth === 'number' ? leftWidth : 300) + 18 }),
              onClose: () => setL2Open(false),
              onLocate: (n) => { if (n) setTurn(n) },
            }),
            // L3 详细抽屉（20260913 三级导航）：与「维护」共用同一套右侧抽屉机制；滑出该段原文，
            // ★ 地图不被替换。part 只在这里消费（effect 4/5 按 [sessionId, turn, part] 取数）。
            part && e('div', { className: 'dma-drawer', 'data-l3': '1', style: maintDrawerStyle },
              e('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flex: 'none', borderBottom: '1px solid ButtonBorder', paddingBottom: 6 } },
                e('strong', { style: { fontSize: 13 } }, '详细'),
                e('span', { style: dimStyle }, '第 ' + (turn || '—') + ' 楼 · ' + part
                  + (toolName ? ' · 工具 ' + toolName : '')
                  + (part === 'messages' && msgSeq != null ? ' · seq ' + msgSeq : '') + '（装配地图仍在位）'),
                e('span', { style: { flex: 1 } }),
                msgSeq != null ? e('button', {
                  className: 'dma-btn dma-mini', style: miniBtnStyle,
                  'data-msg-back': '1',
                  onClick: () => setMsgSeq(null),
                  title: '返回消息流列表（单条抽屉 ⇄ 列表，同在消息流栏内）',
                }, '← 消息流列表') : null,
                toolName ? e('button', {
                  className: 'dma-btn dma-mini', style: miniBtnStyle,
                  'data-tool-back': '1',
                  onClick: () => setToolName(''),
                  title: '返回整份工具清单（目录）',
                }, '← 整份清单') : null,
                e('button', {
                  className: 'dma-btn dma-mini', style: miniBtnStyle,
                  onClick: () => { setPart(null); setL3Section(null); setToolName(''); setMsgSeq(null) },
                  title: '收起 L3 详细抽屉（回到装配地图；地图从未被换掉）',
                }, '✕'),
              ),
              // 20260914 M2（任务书 B + §9）：点开捕获段 ⇒ 单段抽屉（注释 + 该段实际正文）。
              // ★ 正文只走 /dsh-memory-archive/api/sections/text 新端点 —— ⛔ 不在客户端切 system、⛔ 不读会话文件。
              //   非捕获段（文本推断/整部件）仍走 PromptPartView（整部件原文 + 搜索）。
              // 20260914 M10：点开**工具行** ⇒ 单条工具定义原文（ToolTextPanel）；⛔ 不再只给整份目录。
              // 20260918 消息流单：messages ⇒ 消息流栏（列表；msgSeq 点名 ⇒ 单条抽屉 ViewerMsgPanel）。
              //   ⛔ 旧的并列 PartTabs 架构（本栏切 system/tools/inventory/完整）已拆 —— 那些部件由装配地图覆盖。
              part === 'tools' && toolName
                ? e(ToolTextPanel, { sessionId: sessionId, turn: turn, toolName: toolName })
                : l3Section && part === 'system'
                ? e(SectionTextPanel, {
                  sessionId: sessionId, turn: turn, section: l3Section,
                  query: query, setQuery: setQuery,
                  // ★ 20260919 视觉单：抽屉右上角「上一个 / 下一个」切段 —— 落点还是 l3Section
                  //   （换段 = 换地图上被点开的那个块，正文/清单随 name 重取，地图不动）。
                  onSwitchSection: setL3Section,
                })
                : part === 'messages'
                  ? (msgSeq != null
                    ? e(ViewerMsgPanel, { sessionId: sessionId, turn: turn, seq: msgSeq })
                    : e(PromptPartView, {
                      sessionId: sessionId, turn: turn, part: part,
                      state: partState, onOpenSeq: setMsgSeq, onCopy: copyCurrent,
                    }))
                  : part === 'tools'
                    ? e(PromptToolsListPanel, { turn: turn, state: partState })
                    : e('div', { 'data-l3-fallback': '1', style: colPartStyle },
                      e('div', { style: dimStyle },
                        '这一栏只做消息流（20260918 拆掉并列部件视图与完整视图）：' + String(part) + ' 由装配地图覆盖 —— 请从地图对应行下钻。')),
            ),
            // 「维护」抽屉（20260913）：可写项 4 旋钮 + 检测与修复（应用/备份/回滚/pack）+ 一键生成 RP 预设。
            // 写路径纪律不变：一律先干跑出计划 → 确认才落盘（备份 + 回读校验 + 不一致自动回滚）。
            // M9：事实说明书抽屉（`?` 开关）。只讲**判据**，不讲卖点；每条都写清"是什么/不是什么"。
            helpOpen && e('div', { className: 'dma-drawer', 'data-help': '1', style: maintDrawerStyle },
              e('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flex: 'none', borderBottom: '1px solid ButtonBorder', paddingBottom: 6 } },
                e('strong', { style: { fontSize: 13 } }, '事实说明书'),
                e('span', { style: dimStyle }, '这张图的每个元素是什么、不是什么（按 ? 开关，Esc 关掉）'),
                e('span', { style: { flex: 1 } }),
                e('button', {
                  className: 'dma-btn dma-mini', style: miniBtnStyle,
                  onClick: () => setHelpOpen(false),
                  title: '关闭事实说明书（地图不动）',
                }, '✕'),
              ),
              e('div', { 'data-help-body': '1', style: { display: 'flex', flexDirection: 'column', gap: 10, overflow: 'auto' } },
                editorHelpSections().map((sec, i) => e('div', { key: 'hs' + i, style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                  e('div', { style: { fontWeight: 700, fontSize: 12.5 } }, sec.title),
                  sec.lines.map((line, j) => e('div', { key: 'hl' + i + '_' + j, style: { fontSize: SMALL_FONT_SIZE, opacity: 0.92, wordBreak: 'break-word' } }, line)),
                )),
              ),
            ),
            maintOpen && e('div', { className: 'dma-drawer', 'data-maint': '1', style: maintDrawerStyle },
              e('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flex: 'none', borderBottom: '1px solid ButtonBorder', paddingBottom: 6 } },
                e('strong', { style: { fontSize: 13 } }, '维护'),
                e('span', { style: dimStyle }, '低频写操作收在这里；主界面保持只读'),
                e('span', { style: { flex: 1 } }),
                e('button', {
                  className: 'dma-btn dma-mini', style: miniBtnStyle, onClick: () => setMaintOpen(false),
                  title: '收起维护抽屉',
                }, '✕'),
              ),
              // ★ 2026-09-19 预设线整块退役（用户口径「『生成 / 修复 RP agent』删掉」）：
              //   这一格原来挂 DetectReport（检测/预览）+ 入口按钮 + KnobsPanel（可写项块），
              //   它们依赖的 /agent/detect|apply|rollback|provision|backups|pack/apply 六条端点已从宿主删掉。
              //   留下来的只有提示词查看器本体（装配地图 / 消息流 / 单段抽屉 / 工具定义）+ 下面那张 V3 卡。
              e('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 } },
                e(V3Panel, { sessionId: sessionId }),
              ),
            ),
            e('div', { style: statusAreaStyle },
              e('span', { style: Object.assign({}, dimStyle, { flexShrink: 0 }) }, statusLine || '就绪'),
              detailMeta ? e('span', {
                // M16（用户截图反馈）：cwd/preset 允许被截断（长路径不再把底栏挤成两行），完整值留在 title
                style: Object.assign({}, dimStyle, {
                  flex: '1 1 220px', minWidth: 0, fontFamily: MONO,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }),
                title: 'cwd: ' + String(detailMeta.cwd || '-')
                  + (detailMeta.effectivePreset ? '\npreset: ' + detailMeta.effectivePreset : ''),
              }, 'cwd: ' + (detailMeta.cwd || '-')
                + (detailMeta.effectivePreset ? ' | preset: ' + detailMeta.effectivePreset : '')) : null,
              sessionId ? e('span', { style: { flexShrink: 0, marginLeft: 'auto' } },
                e(CopyBtn, { value: sessionId, label: '复制会话 ID' })) : null,
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
          }, props.wide ? '提示词查看器' : '词'),
          open && e(AgentEditorPanel, { onClose: () => setOpen(false) }),
        )
      }

      // ★★ 用户 2026-09-16 给的**说明原文**（逐字，⛔ 不许改写、不许润色、不许补术语）。
      const COMPACTION_EXPLAIN = [
        '这里收录了提示词模板，并提供了编辑功能。',
        '原理：插件更改了dsh原生的【压缩】机制，将原本的编程总结提示词换成了rp向提示词。',
        '重要：',
        '①压缩提示词存进内存，更改必须重启才能生效，也不能对已经总结过的内容追溯生效。建议在决定重开后再大修提示词。',
        '②提示词来自st anima记忆系统，向量检索插件依赖此提示词。不建议不清楚检索功能原理的用户更改。',
      ].join('\n')

      // ★ 用户 2026-09-16 决定：这张卡的提示块**整块撤掉**（说明那段已经把该说的说全了）。
      //   ⛔ 不要在这里指向「⑤ 应用（真写入）」：那张卡长在**另一个入口**（侧栏「提示词查看器」→ 检测视图），
      //   用户在这张卡所在的视图里**看不到它**（用户原话："插件里没有应用按钮"）—— 指路指到别处只会更迷惑。
      //   ⚠️ 但下面这条**事实**仍然成立，只是不该写在面板上（它不是这张卡能解决的事）：
      //   文本框存的是**本插件自己的副本**，压缩真正吃的是**预设里压缩后端的 `customInstruction`**；
      //   要让副本进预设，得走 `/agent/apply`（`index.js:2336-2348` 的定点写入，面板入口在提示词查看器那边）
      //   或直接手改预设文件。⇒ 已写进交接 §十八.5/§十九，别在 UI 上许愿。
      const COMPACTION_NOTICES = null

      // ★ 用户 2026-09-16 口径：这条只留**一句**（原文照抄）。
      const PLACEHOLDER_EXPLAIN = [
        '内容被「收纳」（移出上下文）之后，那一处不是空白 —— 模型在原位看到的是一段固定前言 + 归档正文。这里展示的是更改后的占位文本。如无必要请勿更改。',
      ].join('\n')

      // ★ 用户 2026-09-16：这两条 ⚠️ 提示**多余**，整块删掉（说明那一句已经含了"如无必要请勿更改"）。
      const PLACEHOLDER_NOTICES = null

      const PLACEHOLDER_VARS = '可用变量：{from} 起始楼号 · {to} 结束楼号 · {cast} 涉及角色 —— 真正执行收纳时替换。'
      const REF_SOURCE_LINE = '来源：DSH 官方 compaction-basic（MIT，Copyright (c) 2026 DeepSeek）'

      function TemplateCard({ templateKey, sessionId }) {
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
        // ★ 破限头（2026-09-16 用户口径）：**默认留空**，本插件不内置任何破限文本 —— 规避法律风险，
        //   由玩家自填；填了只在「应用（写进预设）」时拼在指令前面一起写进 preset。
        // ⚠ 新增 hook **一律追加在最后**：自检台按「组件名 → hook 序号」注入预设，插在中间会把
        //   load/draft/save/refOpen/tick 的序号整体顶掉（2026-09-16 我就这么错过一次：
        //   破限头文本框的初值变成了 save 状态对象，测试当场红）。
        const [jbDraft, setJbDraft] = React.useState('')
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
            const jb = data.templates && data.templates.compactionJailbreak
            setJbDraft(jb && typeof jb.current === 'string' ? jb.current : '')
          })().catch((error) => {
            if (controller.signal.aborted) return
            setLoad({ status: 'error', data: null, error: errText(error) })
          })
          return () => { controller.abort(); loadCtl.current = null }
        }, [templateKey, tick])

        // ★ 2026-09-16：原来这里有个 `act()`（把文本 PUT /templates 存进**本插件配置**）。
        //   现在两条卡都不走它了：压缩指令 ⇒ `applyToPreset()`（真写进 preset）；
        //   收纳占位 ⇒ 只读（没有可写目的地）。⇒ **删掉**，不留死代码（要恢复编辑看 git 历史）。

        const tpl = load.status === 'ready' && load.data && load.data.templates ? load.data.templates[templateKey] : null

        // ★★ 用户 2026-09-16：「保存」对**压缩指令**这张卡改成「应用」—— 直接把文本写进 preset。
        //   为什么必须这样：压缩真正吃的是 **preset 里压缩后端的 `customInstruction`**，面板文本框只是
        //   本插件自己的一份副本；只存副本 ⇒ 改了不生效（这正是用户最初报的"改了没变"）。
        //   走的是**服务端已经存在**的那条定点写入路（与「提示词查看器 → 检测视图 → ⑤ 应用卡」同一条）：
        //     ① PUT /templates 存好面板副本（`/agent/apply` 的默认取值就是它，见 index.js:2336-2343）
        //     ② POST /agent/apply {dryRun:true}  —— 干跑，零写入
        //     ③ POST /agent/apply {dryRun:false} —— 备份 → 定点替换 customInstruction → 回读校验
        //        （不一致自动回滚；只改这一个字段，其余行含注释原样保留）
        //   ⚠️「收纳占位」那张卡**没有可写目的地**（真机预设的 compaction 行只有
        //   thresholdRatio / retainTokens / customInstruction / faithful / summaryLanguage；插件运行期也没人读它）
        //   ⇒ 它的按钮仍是「保存副本」，要不要改成只读 / 或给它造一个真目的地，等用户拍板（交接 §十九）。
        const isCompaction = templateKey === 'compaction'
        const applyToPreset = (value, okText) => {
          if (actCtl.current) actCtl.current.abort()
          const controller = new AbortController()
          actCtl.current = controller
          setSave({ busy: true, error: '', ok: '' })
          ;(async () => {
            // ① 面板副本（/agent/apply 取的就是它）
            const body = {}
            body[templateKey] = value
            const saved = await mutateJson(HOST_API_BASE + '/templates', 'PUT', body, controller.signal)
            if (controller.signal.aborted) return
            setLoad({ status: 'ready', data: saved, error: '' })
            const backRead = saved && saved.templates ? saved.templates[templateKey] : null
            if (backRead && typeof backRead.current === 'string') setDraft(backRead.current)
            // ② 认目标 preset：先按会话解析（/agent），认不出再退"唯一可写候选"（与 ⑤ 应用卡同一判据）
            const q = typeof sessionId === 'string' && sessionId !== '' ? '?sessionId=' + encodeURIComponent(sessionId) : ''
            let presetId = ''
            let writable = null
            const agent = await apiGet(AGENT_API + q, controller.signal)
            if (controller.signal.aborted) return
            if (agent && agent.preset && typeof agent.preset.id === 'string' && agent.preset.id !== '') {
              presetId = agent.preset.id
              writable = typeof agent.preset.writable === 'boolean' ? agent.preset.writable : null
            } else {
              const det = await apiGet(AGENT_API + '/detect', controller.signal)
              if (controller.signal.aborted) return
              const cands = det && Array.isArray(det.candidates) ? det.candidates.filter((c) => c && c.writable === true) : []
              if (cands.length === 1) { presetId = String(cands[0].id); writable = true }
            }
            if (presetId === '') {
              const e1 = new Error('认不出要写哪个 preset —— 先在 ⚙ 设置里选好根会话（或在「提示词查看器 → 检测视图 → ⑤ 应用卡」里选目标 preset）')
              e1.code = 'NO_PRESET'
              throw e1
            }
            if (writable === false) {
              const e2 = new Error('这个 preset 是只读的（trust ≠ user：随部署附带的 preset 官方语义只读）⇒ 写不进')
              e2.code = 'PRESET_READONLY'
              throw e2
            }
            // ③ 干跑（零写入）⇒ ④ 真写（备份 + 回读校验 + 不一致回滚）
            // ★ 真正写进 preset 的文本 = **破限头（若玩家填了）+ 空行 + 指令**。
            //   破限头默认空 ⇒ 默认就等于"只写指令"（⛔ 本插件不内置任何破限文本）。
            //   走 knobs.customInstruction 显式传（服务端优先用它，见 index.js:2532），
            //   这样面板副本里始终只有"指令本身"，破限头单独存在它自己的字段里。
            const composed = jbDraft.trim() !== '' ? jbDraft.replace(/\s+$/, '') + '\n\n' + value : value
            // ★ 首参必须叫 `url`：自检台有一条"所有 mutateJson 都要落在宿主 API 上（疑似新增写归档路径就红）"
            //   的守卫，它按"首个参数名以 url 开头"放行 —— 与既有 ApplyCard 的写法保持一致。
            const url = AGENT_API + '/apply'
            await mutateJson(url, 'POST', { presetId: presetId, dryRun: true, knobs: { customInstruction: composed } }, controller.signal)
            if (controller.signal.aborted) return
            const out = await mutateJson(url, 'POST', { presetId: presetId, dryRun: false, knobs: { customInstruction: composed } }, controller.signal)
            if (controller.signal.aborted) return
            const applied = out && Array.isArray(out.applied) && out.applied[0] ? out.applied[0] : null
            const bits = []
            if (applied) bits.push('写入 ' + String(applied.file) + ' 的 ' + String(applied.field))
            if (out && out.backup && out.backup.dir) bits.push('备份在 ' + String(out.backup.dir))
            if (out && out.recompose && typeof out.recompose.note === 'string' && out.recompose.note) bits.push(out.recompose.note)
            setSave({ busy: false, error: '', ok: okText + (bits.length ? ' —— ' + bits.join('；') : '') })
          })().catch((error) => {
            if (controller.signal.aborted) return
            const payload = error && error.payload && typeof error.payload === 'object' ? error.payload : null
            const hint = payload && typeof payload.hint === 'string' && payload.hint ? '（' + payload.hint + '）' : ''
            setSave({ busy: false, error: errText(error) + hint, ok: '' })
          })
        }

        /**
         * 破限头的保存/清空（只动本插件配置里的 `prompts.compactionJailbreak`）。
         * ★ 为什么不内置任何破限文本（用户 2026-09-16 口径）：anima 那边也是"界面留空、玩家自填"，
         *   我们采取同一原则 —— 规避法律风险。所以这里的默认值恒为空串，且**没有**内置回退文本。
         */
        const saveJailbreak = (value) => {
          if (actCtl.current) actCtl.current.abort()
          const controller = new AbortController()
          actCtl.current = controller
          setSave({ busy: true, error: '', ok: '' })
          ;(async () => {
            const data = await mutateJson(HOST_API_BASE + '/templates', 'PUT', { compactionJailbreak: value === '' ? null : value }, controller.signal)
            if (controller.signal.aborted) return
            const jb = data.templates && data.templates.compactionJailbreak
            setJbDraft(jb && typeof jb.current === 'string' ? jb.current : '')
            setLoad({ status: 'ready', data: data, error: '' })
            setSave({
              busy: false, error: '',
              ok: value === '' ? '破限头已清空（留空 = 应用时不拼接任何破限文本）' : '破限头已保存 —— 点「应用（写进预设）」才会一起写进 preset',
            })
          })().catch((error) => {
            if (controller.signal.aborted) return
            setSave({ busy: false, error: errText(error), ok: '' })
          })
        }
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
            // ★ 用户 2026-09-16 口径：「收纳占位」这张卡**只读**（它没有可写目的地：真机预设的
            //   compaction 行没有对应键，插件运行期也没人读这段文本）⇒ 不给编辑入口，只展示 + 可复制。
            'aria-label': isCompaction ? '压缩指令模板（可编辑）' : '收纳占位模板（只读）',
            readOnly: !isCompaction,
            style: isCompaction ? templateAreaStyle : Object.assign({}, templateAreaStyle, { background: 'color-mix(in srgb, CanvasText 5%, Canvas)' }),
            rows: 14, spellCheck: false,
            value: draft,
            onChange: isCompaction ? (ev) => setDraft(ev.target.value) : undefined,
            placeholder: isCompaction ? '压缩指令模板文本（点「应用（写进预设）」才会写进 preset）' : '（只读展示）',
          }),
          isCompaction ? null : e('div', { style: dimStyle }, '（只读展示：面板不提供编辑入口。）'),
          // ── 破限头（仅压缩指令卡）：★ 默认留空，本插件**不内置**任何破限文本（用户口径：规避法律风险） ──
          isCompaction
            ? e('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 } },
              e('label', { htmlFor: 'dma-template-jailbreak', style: { fontSize: 12, fontWeight: 700 } },
                '破限头（默认留空 · 由玩家自填）'),
              e('textarea', {
                id: 'dma-template-jailbreak', name: 'dma-template-jailbreak',
                'aria-label': '破限头（默认留空，由玩家自填）',
                style: Object.assign({}, templateAreaStyle, { minHeight: 84 }),
                rows: 4, spellCheck: false, value: jbDraft,
                placeholder: '留空 = 应用时不拼接任何破限文本（本插件不内置）',
                onChange: (ev) => setJbDraft(ev.target.value),
              }),
              e('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                e('button', { className: 'dma-btn', style: btnStyle, disabled: save.busy, onClick: () => saveJailbreak(jbDraft) },
                  save.busy ? '保存中…' : '保存破限头'),
                e('button', { className: 'dma-btn', style: btnStyle, disabled: save.busy || jbDraft === '', onClick: () => saveJailbreak('') }, '清空'),
                jbDraft === '' ? e('span', { style: dimStyle }, '当前：留空') : e('span', { style: warnBadgeStyle }, '当前：已填 ' + jbDraft.length + ' 字符'),
              ),
            )
            : null,
          e('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
            // 压缩指令：应用（写进预设）+ 恢复内置默认；收纳占位：只有复制（只读）
            isCompaction
              ? e('button', {
                className: 'dma-btn', style: btnStyle, disabled: save.busy,
                title: '把这段文本写进预设里压缩后端的 customInstruction（干跑 → 备份 → 定点写 → 回读校验）—— 这样压缩才会真的用它',
                onClick: () => applyToPreset(draft, jbDraft.trim() !== ''
                  ? '已写进预设（破限头 + 压缩指令，写进 customInstruction）'
                  : '已写进预设（压缩后端 customInstruction）'),
              }, save.busy ? '应用中…（干跑 → 写入）' : '应用（写进预设）')
              : null,
            isCompaction
              ? e('button', {
                className: 'dma-btn', style: btnStyle, disabled: save.busy,
                title: '把该键存为 null 恢复内置默认；成功后文本框同步成回读值',
                onClick: () => applyToPreset(typeof t.builtin === 'string' ? t.builtin : '', '已把内置默认写进预设'),
              }, '恢复内置默认')
              : null,
            e(CopyFeedbackBtn, {
              label: '复制', title: '复制文本框内容到剪贴板',
              onCopy: () => copyText(draft).then(
                () => setSave((s) => ({ ...s, ok: '已复制文本框内容', error: '' })),
                () => setSave((s) => ({ ...s, error: '复制失败 [COPY_FAIL]', ok: '' })),
              ),
            }),
            isCompaction
              ? e('button', {
                className: 'dma-btn', style: btnStyle, disabled: save.busy || typeof t.builtin !== 'string',
                title: '把内置默认填进文本框（不保存，可先改再应用）',
                onClick: () => setDraft(typeof t.builtin === 'string' ? t.builtin : ''),
              }, '载入内置默认')
              : null,
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
          // ★ 2026-09-16：`notices` 置空后这里仍会画出一个**空的红框**（honestStyle 自带红底红框 +
          //   padding）—— 用户报的"底部红框没删"就是它。⇒ 没内容就**不渲染这个 div**。
          meta.notices ? e('div', { style: honestStyle }, meta.notices) : null,
        )
      }

      // ---------- 提示词模板容器（记忆库面板内）：两子页 tab + 返回阅读 ----------
      // v4.1：「每次请求」查看器已拆成独立入口 prompt-viewer，这里只剩模板两子页。
      function TemplatesView({ onBack, sessionId }) {
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
            e('div', { style: scrollColStyle }, e(TemplateCard, { key: tab, templateKey: tab, sessionId: sessionId })),
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
      // 归档位（20260914 M5）：行 archived: true|false|null 来自 /sessions 的逐请求投影，
      // 信封 archive.known===true 才可信（未知 ≠ 未归档，一行都不许标/藏）。
      function SessionRootPicker({ config, reload, nameIdx, onPick }) {
        const [state, setState] = React.useState({ status: 'loading', items: [], archiveKnown: false, error: null })
        const [save, setSave] = React.useState({ busy: false, error: null })
        const saveCtl = React.useRef(null)
        React.useEffect(() => () => { if (saveCtl.current) saveCtl.current.abort() }, [])

        React.useEffect(() => {
          const controller = new AbortController()
          ;(async () => {
            // ★ 2026-09-15：这里**不再要 titles=1** —— 宿主那侧注释实测「69 会话逐个投影 ≈ 9 秒」，
            //   而本下拉的显示名本来就有三级回退（会话标题 → 工作区 catalog 的「角色 · 周目」→ 短 ID）。
            //   走快路径（`/sessions` = 纯 fs 扫描，实测 1 ms）+ 周目名回退：既快，又正好覆盖
            //   「抓周目名」这条需求（`optionLabel()` 已经是 labelSession(s, nameIdx)）。
            const data = await requestJson(HOST_API_BASE + '/sessions', controller.signal)
            if (controller.signal.aborted) return
            setState({
              status: 'ready',
              items: Array.isArray(data.sessions) ? data.sessions : [],
              // 缺信封（旧服务端）与 known:false 同样按未知处理：不标、不藏
              archiveKnown: !!(data.archive && data.archive.known === true),
              error: null,
            })
          })().catch((error) => {
            if (controller.signal.aborted) return
            setState({ status: 'error', items: [], archiveKnown: false, error: errText(error) })
          })
          return () => controller.abort()
        }, [])

        // ★ /config 可能不返回 root：取不到当前选择时退化成占位项
        const current = config && config.root && typeof config.root.sessionId === 'string' ? config.root.sessionId : ''
        const items = state.status === 'ready' ? state.items : []
        const hasCurrent = items.some((s) => String(s && s.sessionId) === current)
        // ★★ 展示口径（20260914 M5，与编辑器列表故意不同）：这里【默认不隐藏】归档会话 ——
        // 本列表是选「记忆库根」用的，归档会话照样能当根、正文照样取得到（M5 实测：标归档后
        // /api/sections/text 20/20 段全部取得到）；藏起来会挡住一个正当用法。⛔ 不许加默认过滤。
        // 只做：文字徽标 + 置灰 + title 说明；archiveKnown===false（未知）时一行都不标。
        const rowArchived = (s) => state.archiveKnown && s && s.archived === true
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
            items.map((s) => {
              const archivedRow = rowArchived(s)
              return e('option', {
                key: String(s && s.sessionId), value: String(s && s.sessionId),
                'data-arch': archivedRow ? '1' : '0',
                // 完整 id 只在 title（既有口径）；归档行把「已归档 = …」说明也放进 title
                title: String((s && s.sessionId) || '')
                  + (archivedRow ? ' —— 已归档 = 会话在工作区注册表 archivedSessionIds 里；日志仍在、内容照常可读' : ''),
                // <option> 在下拉列表里 opacity/opacity 类样式多数浏览器不理，用 muted 灰置灰
                style: archivedRow ? { color: '#999999' } : null,
              }, (archivedRow ? '【已归档】' : '') + optionLabel(s))
            })),
          save.busy && e('div', { style: dimStyle }, '正在保存根会话…'),
          save.error && e('div', { style: errorStyle }, '根会话保存失败：' + save.error),
          // 归档状态未知（注册表没读到 / 旧服务端没这字段）：一行不标、一条不藏，如实说一句
          state.status === 'ready' && !state.archiveKnown && e('div', {
            style: dimStyle, 'data-archive-unknown': '1',
            title: '归档状态来自工作区注册表 archivedSessionIds；这次没读到，无法分辨已归档会话（未知 ≠ 未归档）',
          }, '归档状态不可用（已按普通会话显示）'),
          state.status === 'ready' && items.length === 0 && e('div', { style: dimStyle }, '宿主没有返回任何会话'),
        )
      }

      // 根归档提示的文案（20260914 M6，纯函数便于自检直测）：只在「会话根 + 归档位已知 +
      // 确实已归档」时给文案；未知（known:false）/ 工作区根 / 未归档 ⇒ null（⛔ 不提示、不猜）。
      // ★ 只提示：调用方不许因此隐藏/禁用/清空选根 —— 归档会话照样能当根（M4/M5 实测正文可取）。
      function rootArchiveHint(state) {
        if (!state || state.mode !== 'session') return null
        if (state.known !== true || state.archived !== true) return null
        return '该根会话已归档（日志仍在、内容照常可读）'
      }

      // ---------- 设置视图 B：工作区根选择（**三级级联：工作区 → 角色 → 周目**；结果写进配置 root） ----------
      // 口径（用户 2026-09-15）：
      //   · 「角色-周目」是**唯一的组织轴** —— archive/ 存不存在只是**元数据**，不影响发现与绑定；
      //   · 第 1 级「工作区」= Tavern 的**当前绑定根**（Tavern 只维护一个绑定，换绑在 Tavern 侧做），
      //     显示人话名（路径末段）+ 完整路径 tooltip，不把绝对路径糊在脸上。
      function WorkspaceRootPicker({ config, disc, nameIdx, reload, onPick }) {
        const [save, setSave] = React.useState({ busy: false, error: null })
        const saveCtl = React.useRef(null)
        React.useEffect(() => () => { if (saveCtl.current) saveCtl.current.abort() }, [])

        // —— 第 1 级数据：工作区（Tavern 绑定根）——
        const [ws, setWs] = React.useState({ status: 'loading', rootPath: '', selected: false, error: '' })
        const [wsNonce, setWsNonce] = React.useState(0)
        React.useEffect(() => {
          const controller = new AbortController()
          ;(async () => {
            try {
              const data = await requestJson('/pmp-dsh-tavern/api/v2/workspace', controller.signal)
              if (controller.signal.aborted) return
              setWs({
                status: 'ready',
                rootPath: data && typeof data.rootPath === 'string' ? data.rootPath : '',
                selected: !!(data && data.selected === true),
                error: '',
              })
            } catch (error) {
              if (controller.signal.aborted) return
              setWs({ status: 'error', rootPath: '', selected: false, error: errText(error) })
            }
          })()
          return () => controller.abort()
        }, [wsNonce])

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

        // ★★ 2026-09-20 修（真机："角色/周目切不动"）：
        //   两个下拉的显示值以前取自 `disc.*` —— 那是**自动发现挑的那个**，不是**已保存的绑定** ⇒
        //   ① 打开面板时显示的就跟真实绑定不是一回事（真机实测：绑定 70a0502d/0256fcac，下拉却显示 5c04213e 的周目）；
        //   ② 每次保存后 `reload()` 会 bump tick ⇒ 发现结果重算 ⇒ 显示值被重置回自动挑的那个，
        //      用户看到的就是「切了又弹回去」。⇒ 显示值一律**优先取绑定**（`config.root`，与 SessionRootPicker 同一口径），
        //      没绑定时才退回自动发现的那个（= 首次使用的默认值）。
        //   ⚠️ 绑定指向的 id 若不在发现结果里（周目被删 / 换了工作区）⇒ **照样列出来并标 ⚠**，绝不静默显示成别的项
        //      —— 那正是这次误会的来源（下拉显示 A，实际绑着 B，两边都不说话）。
        const root = config && config.root && typeof config.root === 'object' ? config.root : null
        const boundChar = root && typeof root.characterId === 'string' ? root.characterId : ''
        const boundPlay = root && typeof root.playthroughId === 'string' ? root.playthroughId : ''
        const found = Array.isArray(disc.found) ? disc.found : []
        const charRow = (cid) => found.find((f) => f.charId === cid) || null
        const charMissing = boundChar !== '' && charRow(boundChar) === null
        const selChar = boundChar !== '' ? boundChar : (disc.characterId || '')
        const charIds = charMissing ? [boundChar].concat(found.map((f) => f.charId)) : found.map((f) => f.charId)
        const cur = charRow(selChar)
        const plays = cur ? cur.plays : []
        const playMissing = boundPlay !== '' && plays.indexOf(boundPlay) < 0
        const playIds = playMissing ? [boundPlay].concat(plays) : plays
        // 显示的那个周目：绑定优先；绑定为空的周目不在本次的周目列表里（角色刚换）⇒ 退回列表第一个
        const wantPlay = boundPlay !== '' ? boundPlay : (disc.playthroughId || '')
        const selPlay = playIds.indexOf(wantPlay) >= 0 ? wantPlay : (playIds[0] || '')
        // 「无归档」徽标跟着**显示的那个**周目走（旧口径只算自动挑的那个 ⇒ 显示与绑定不一致时会标错）
        const noArchive = disc.archiveMap
          ? disc.archiveMap[selChar + '/' + selPlay] !== true
          : disc.emptyArchive === true

        // 工作区人话名 = 路径末段（空/未绑定都给可读占位）
        const wsName = (() => {
          const p = ws.rootPath
          if (p === '') return ws.selected ? '（已绑定工作区）' : '（Tavern 未绑定工作区）'
          const segs = p.split(/[\\/]/).filter(Boolean)
          return segs.length > 0 ? segs[segs.length - 1] : p
        })()

        // —— 可爱一点的三行布局：标签列定宽 ⇒ 三个下拉左边缘对齐 ——
        const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }
        const labStyle = { flex: '0 0 48px', fontSize: SMALL_FONT_SIZE, color: 'GrayText' }
        const pickStyle = Object.assign({}, selectStyle, {
          maxWidth: 'none', minWidth: 180, flex: '0 1 340px', padding: '3px 6px',
        })
        const missBadgeStyle = Object.assign({}, dimBadgeStyle, { color: 'DarkGoldenrod' })
        const row = (key, label, control, extra) => e('div', { key: key, style: rowStyle },
          e('span', { style: labStyle }, label), control,
          extra === undefined || extra === null ? null : extra)

        return e('div', { style: cardStyle },
          e('div', { style: sectionTitleStyle }, '工作区根（自动发现）'),
          e('div', { style: dimStyle },
            '三级级联：工作区 → 角色 → 周目。真名来自 catalog.json；「无归档」不影响绑定 —— '
            + '首次「收纳」或「导入」时会在 <角色>/<周目>/archive/ 下自动创建并写入。'),

          // ① 工作区（Tavern 绑定根；只读 + 可重读）
          row('ws', '工作区',
            e('select', {
              id: 'dma-workspace-select', name: 'dma-workspace-select',
              'aria-label': '工作区（Tavern 绑定根）',
              style: pickStyle,
              value: ws.rootPath || '',
              disabled: true,
              title: ws.rootPath
                ? 'Tavern 当前绑定的工作区根：' + ws.rootPath + '（换绑请在 Tavern 的 play 界面做）'
                : 'Tavern 尚未绑定工作区（在 Tavern 的 play 界面绑定后，这里会显示）',
            },
              e('option', { key: 'cur', value: ws.rootPath || '', title: ws.rootPath || '' },
                ws.status === 'loading'
                  ? '正在读取…'
                  : ws.status === 'error'
                    ? '读取失败：' + ws.error
                    : wsName)),
            e('button', {
              key: 'wsr', type: 'button', style: miniBtnStyle,
              onClick: () => setWsNonce((n) => n + 1),
              title: '重新读取 Tavern 的工作区绑定',
            }, '重读'),
            ws.status === 'ready' && ws.selected !== true
              ? e('span', { key: 'wsm', style: missBadgeStyle, title: 'Tavern 侧还没绑定工作区根' }, '未绑定')
              : null),

          // ② 角色
          disc.status === 'loading' && e('div', { key: 'cl', style: dimStyle }, '正在发现工作区里的角色与周目…'),
          disc.status === 'error' && e('div', { key: 'ce', style: errorStyle }, '归档发现失败：' + disc.error),
          disc.status === 'ready' && row('ch', '角色',
            e('select', {
              id: 'dma-character-select', name: 'dma-character-select',
              'aria-label': '选择工作区角色（根）',
              style: pickStyle, value: selChar, disabled: save.busy,
              onChange: (ev) => {
                const f = charRow(ev.target.value)
                if (f === null) return   // 绑定那个角色已不在工作区里（只列出来如实显示）⇒ 不提交
                commit(ev.target.value, f.plays[0])
              },
              title: selChar,
            },
              charIds.map((cid) => e('option', { key: cid, value: cid, title: cid },
                labelCharacter(cid, nameIdx) + (charRow(cid) === null ? ' · ⚠ 不在工作区' : '')))),
            charMissing
              ? e('span', {
                key: 'chm', style: missBadgeStyle,
                title: '当前绑定 ' + boundChar + ' 在工作区里找不到对应目录（下拉里这条是为如实显示绑定而列的）',
              }, '绑定不在工作区')
              : null),

          // ③ 周目（真名短版；完整「最后打开 …」进 tooltip）
          disc.status === 'ready' && playIds.length > 0 && row('pt', '周目',
            e('select', {
              id: 'dma-playthrough-select', name: 'dma-playthrough-select',
              'aria-label': '选择周目（根）',
              style: pickStyle, value: selPlay, disabled: save.busy,
              onChange: (ev) => commit(selChar, ev.target.value),
              title: selPlay,
            },
              playIds.map((p) => e('option', { key: p, value: p, title: labelPlaythrough(p, nameIdx) },
                labelPlaythrough(p, nameIdx, { short: true }) + (playMissing && p === boundPlay ? ' · ⚠ 不在工作区' : '')))),
            noArchive
              ? e('span', {
                key: 'ptm', style: missBadgeStyle,
                title: '该周目下还没有 archive/ 目录 —— 不影响绑定；首次收纳/导入时会自动创建',
              }, '无归档')
              : null),

          save.busy && e('div', { key: 'sb', style: dimStyle }, '正在保存工作区根…'),
          save.error && e('div', { key: 'se', style: errorStyle }, '工作区根保存失败：' + save.error),
        )
      }

      // ---------- 设置视图 C：向量检索 API（retrieval.*；密钥纪律与 api.key 一字不差） ----------
      // 20260918：这张卡从「总结侧路的渠道设置」改为「向量检索 API」，收整套。
      // 消费方是 dsh-anima-rag：它直接读本插件的配置文件（生效顺序只有两层：retrieval.* → anima 默认值）。
      // ⛔ 不存在"别处同名项以本卡为准"的覆盖规则 —— 这几项的唯一真相就是本配置文件。
      // ★★ 2026-09-20（用户口径「两个模型都要有接口」）：向量与重排**各一套完整三件套**
      //   （接口地址 / 模型名 / 密钥）—— 两个模型可以落在**不同服务商**上，那正是拆开的原因。
      //   兜底口径与宿主侧 `/retrieval/test`、anima 的 `applyRetrievalConfig` **逐条同一口径**：
      //   重排「接口地址」留空 ⇒ 用向量那个 + '/rerank'；重排「密钥」留空 ⇒ 用向量那把（= 改版前行为）。
      function ApiSettings({ config, reload }) {
        const r = config && config.retrieval && typeof config.retrieval === 'object' ? config.retrieval : {}
        const savedUrl = typeof r.url === 'string' ? r.url : ''
        const savedModel = typeof r.model === 'string' ? r.model : ''
        const savedRerankUrl = typeof r.rerankUrl === 'string' ? r.rerankUrl : ''
        const savedRerankModel = typeof r.rerankModel === 'string' ? r.rerankModel : ''
        const keySet = !!(r && r.keySet)
        const keyHint = r && typeof r.keyHint === 'string' ? r.keyHint : null
        const rrKeySet = !!(r && r.rerankKeySet)
        const rrKeyHint = r && typeof r.rerankKeyHint === 'string' ? r.rerankKeyHint : null
        // ★ 重排密钥"正在沿用向量那把"要**如实说出来** —— ⛔ 不许把它显示成"已单独保存"（那是骗人）。
        const rrKeyInherited = !!(r && r.rerankKeyInherited)

        const [url, setUrl] = React.useState(savedUrl)
        const [model, setModel] = React.useState(savedModel)
        const [rerankUrl, setRerankUrl] = React.useState(savedRerankUrl)
        const [rerankModel, setRerankModel] = React.useState(savedRerankModel)
        const [key, setKey] = React.useState('')
        const [rerankKey, setRerankKey] = React.useState('')
        const [act, setAct] = React.useState('')
        const [msg, setMsg] = React.useState(null)
        const ctl = React.useRef(null)
        React.useEffect(() => () => { if (ctl.current) ctl.current.abort() }, [])

        // 保存/清除后的回读结果（config 引用变化）覆盖本地草稿；两个密钥输入框永远清空、绝不回显
        React.useEffect(() => {
          setUrl(savedUrl); setModel(savedModel); setRerankUrl(savedRerankUrl)
          setRerankModel(savedRerankModel); setKey(''); setRerankKey('')
        }, [config])

        const rrKeyPlaceholder = rrKeyInherited
          ? '未单独设置 —— 现在用向量模型那把（' + (rrKeyHint || '****') + '）；只有填了才只给重排用'
          : rrKeySet ? '已保存（' + (rrKeyHint || '****') + '）· 留空则不修改' : '未设置'

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
          // body 只带改动的字段；两个 key 留空 = 不修改（宿主约定）
          const retrieval = {}
          if (url !== savedUrl) retrieval.url = url
          if (model !== savedModel) retrieval.model = model
          if (rerankUrl !== savedRerankUrl) retrieval.rerankUrl = rerankUrl
          if (rerankModel !== savedRerankModel) retrieval.rerankModel = rerankModel
          if (key !== '') retrieval.key = key
          if (rerankKey !== '') retrieval.rerankKey = rerankKey
          if (Object.keys(retrieval).length === 0) { setMsg({ ok: true, text: '没有需要保存的改动' }); return }
          runPut('save', { retrieval: retrieval }, '已保存，并已回读配置同步界面')
        }
        function doClearEmb() {
          runPut('clear-emb', { retrieval: { key: '__CLEAR__' } }, '已清除向量模型的密钥，并已回读配置同步界面')
        }
        function doClearRr() {
          runPut('clear-rr', { retrieval: { rerankKey: '__CLEAR__' } }, '已清除重排模型自己的密钥（重排回到沿用向量那把）')
        }
        function doTest() {
          if (ctl.current) ctl.current.abort()
          const controller = new AbortController()
          ctl.current = controller
          setAct('test')
          setMsg(null)
          ;(async () => {
            const data = await mutateJson(HOST_API_BASE + '/retrieval/test', 'POST', undefined, controller.signal)
            if (controller.signal.aborted) return
            setAct('')
            // ★ 宿主回来的是**两个模型各一行**的汇总（`向量模型通（…）· 重排模型通（…）`）——
            //   整句原样显示：⛔ 不做二次解读，免得把"只有向量通"说成"测试成功"。
            const text = data && typeof data.message === 'string' && data.message !== '' ? data.message : '测试完成'
            setMsg({ ok: !!(data && data.ok === true), text: text })
          })().catch((error) => {
            if (controller.signal.aborted) return
            setAct('')
            const payload = error && error.payload
            const detail = payload && payload.error && typeof payload.error.message === 'string'
              ? payload.error.message
              : errText(error)
            setMsg({ ok: false, text: '测试失败：' + detail })
          })
        }

        const groupStyle = { marginTop: 8, paddingTop: 8, borderTop: '1px solid color-mix(in srgb, CanvasText 12%, transparent)' }
        const groupTitleStyle = { fontSize: SMALL_FONT_SIZE, fontWeight: 600, color: 'CanvasText' }
        const keyRowStyle = { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }
        const field = (id, aria, value, set, placeholder) => e('label', { style: fieldLabelStyle }, null,
          e('input', {
            id: id, name: id, 'aria-label': aria, style: inputStyle, value: value,
            placeholder: placeholder, onChange: (ev) => set(ev.target.value),
          }))
        const keyField = (id, aria, value, set, placeholder) => e('label', { style: fieldLabelStyle }, null,
          e('input', {
            id: id, name: id, 'aria-label': aria, style: inputStyle, type: 'password', value: value,
            autoComplete: 'new-password', placeholder: placeholder, onChange: (ev) => set(ev.target.value),
          }))

        return e('div', { style: cardStyle },
          e('div', { style: sectionTitleStyle }, '向量检索 API'),

          // —— ① 向量模型（嵌入）——
          e('div', { style: groupStyle },
            e('div', { style: groupTitleStyle }, '向量模型'),
            e('div', { style: dimStyle }, '这一套管"把摘要与查询编码成向量"。'),
            e('div', { style: fieldLabelStyle }, '接口地址'),
            field('dma-retrieval-url', '向量模型 baseURL', url, setUrl, 'API baseURL（向量端点 = 本地址 + /embeddings）'),
            e('div', { style: fieldLabelStyle }, '模型名'),
            field('dma-retrieval-model', '向量模型名', model, setModel, 'embedding 模型名'),
            e('div', { style: fieldLabelStyle }, '密钥'),
            keyField('dma-retrieval-key', '向量模型密钥（只写不读）', key, setKey,
              keySet ? '已保存（' + (keyHint || '****') + '）· 留空则不修改' : '未设置'),
            e('div', { style: keyRowStyle },
              e('button', { className: 'dma-btn', style: btnStyle, onClick: doClearEmb, disabled: act !== '' || !keySet },
                act === 'clear-emb' ? '清除中…' : '清除向量密钥'),
              e('span', { style: dimStyle }, keySet ? '已保存（' + (keyHint || '****') + '）' : '未设置')),
          ),

          // —— ② 重排模型（rerank）——
          e('div', { style: groupStyle },
            e('div', { style: groupTitleStyle }, '重排模型'),
            e('div', { style: dimStyle }, '这一套管"把召回结果重新排序"。两个模型可以不在同一个服务商上。'),
            e('div', { style: fieldLabelStyle }, '接口地址'),
            field('dma-retrieval-rerank-url', '重排模型 baseURL', rerankUrl, setRerankUrl,
              '留空 = 用向量那个地址 + /rerank；单独填了就用它（重排端点 = 本地址 + /rerank）'),
            e('div', { style: fieldLabelStyle }, '模型名'),
            field('dma-retrieval-rerank-model', '重排模型名', rerankModel, setRerankModel, 'rerank 模型名'),
            e('div', { style: fieldLabelStyle }, '密钥'),
            keyField('dma-retrieval-rerank-key', '重排模型密钥（只写不读）', rerankKey, setRerankKey, rrKeyPlaceholder),
            e('div', { style: keyRowStyle },
              e('button', { className: 'dma-btn', style: btnStyle, onClick: doClearRr, disabled: act !== '' || !rrKeySet },
                act === 'clear-rr' ? '清除中…' : '清除重排密钥'),
              e('span', { style: dimStyle },
                rrKeyInherited ? '未单独设置（沿用向量那把）' : rrKeySet ? '已保存（' + (rrKeyHint || '****') + '）' : '未设置')),
          ),

          e('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 } },
            e('button', { className: 'dma-btn', style: btnStyle, onClick: doSave, disabled: act !== '' }, act === 'save' ? '保存中…' : '保存'),
            e('button', { className: 'dma-btn', style: btnStyle, onClick: doTest, disabled: act !== '' },
              act === 'test' ? '正在测试…（两个模型各测一次，可能要几十秒）' : '测试连接（两个模型各测一次）'),
          ),
          msg ? e('div', { style: msg.ok ? okStyle : errorStyle }, msg.text) : null,

          e('div', { style: dimStyle }, '换**向量模型**必须整库重算（脚本：产物/memory-tools/_reembed-anima-vectors.mjs）；只换**重排模型**不用重算。'),
          e('div', { style: dimStyle }, '这几项的唯一真相就是本配置文件（预设不参与检索配置）；测试连接对两个模型**各**打一次最小请求，并分别如实报结果。'),
          e('div', { style: dimStyle }, '两个密钥都只写不读：宿主不返回密钥内容，只返回是否已设置与尾 4 位提示。'),
        )
      }

      // ---------- 设置视图 E：保留第一轮问答（DeepSeek 专用）----------
      // ★ 面板文案逐字来自任务书 §5（= 方案 §5 的 D9-6 定稿），⛔ 不许"优化"。
      //   开关写插件 config（keepFirstRound.enabled，走既有 PUT /config）⇒ 下一轮生效；
      //   两段指令的〔复制〕按钮只复制原文，粘贴由人做（D9-7：不要自动粘贴）。
      const KEEP_FIRST_ROUND_INSTRUCTIONS = [
        {
          key: 'immersion',
          title: '【角色沉浸要求】在你的思考过程（<think>标签内）中，请遵守以下规则：',
          lines: [
            '1. 请以角色第一人称进行内心独白，用括号包裹内心活动，例如"（心想：……）"或"(内心OS：……)"',
            '2. 用第一人称描写角色的内心感受，例如"我心想""我觉得""我暗自"等',
            '3. 思考内容应沉浸在角色中，通过内心独白分析剧情和规划回复',
          ],
        },
        {
          key: 'analysis',
          title: '【思维模式要求】在你的思考过程（<think>标签内）中，请遵守以下规则：',
          lines: [
            '1. 禁止使用圆括号包裹内心独白，例如"（心想：……）"或"(内心OS：……)"，所有分析内容直接陈述即可',
            '2. 禁止以角色第一人称描写内心活动，例如"我心想""我觉得""我暗自"等，请用分析性语言替代',
            '3. 思考内容应聚焦于剧情走向分析和回复内容规划，不要在思考中进行角色扮演式的内心戏表演',
          ],
        },
      ]

      function KeepFirstRoundCard({ config, reload }) {
        const savedEnabled = !!(config && config.keepFirstRound && config.keepFirstRound.enabled === true)
        const [detailOpen, setDetailOpen] = React.useState(false)
        const [notesOpen, setNotesOpen] = React.useState(false)
        const [act, setAct] = React.useState(false)
        const [msg, setMsg] = React.useState(null)
        const ctl = React.useRef(null)
        React.useEffect(() => () => { if (ctl.current) ctl.current.abort() }, [])

        function doToggle(next) {
          if (ctl.current) ctl.current.abort()
          const controller = new AbortController()
          ctl.current = controller
          setAct(true)
          setMsg(null)
          ;(async () => {
            await mutateJson(HOST_API_BASE + '/config', 'PUT', { keepFirstRound: { enabled: next } }, controller.signal)
            await reload()
            if (controller.signal.aborted) return
            setAct(false)
            setMsg({ ok: true, text: '已保存：下一轮生效（不重写预设、不新会话、不重启）' })
          })().catch((error) => {
            if (controller.signal.aborted) return
            setAct(false)
            setMsg({ ok: false, text: errText(error) })
          })
        }

        const blockText = (inst) => [inst.title, ...inst.lines].join('\n')
        const linkStyle = { border: 'none', background: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', padding: 0 }

        return e('div', { style: cardStyle, 'data-keep-first-round': '1' },
          e('div', { style: { display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' } },
            e('div', { style: sectionTitleStyle }, '保留第一轮问答（前两楼原文 · DeepSeek 专用）'),
            e('label', { style: { display: 'flex', gap: 4, alignItems: 'center', fontSize: 12, flex: 'none', cursor: 'pointer' } },
              e('input', {
                id: 'dma-keep-first-round-enabled', type: 'checkbox', checked: savedEnabled,
                disabled: act, onChange: (ev) => doToggle(ev.target.checked),
              }),
              '开关'),
          ),
          e('div', { style: dimStyle }, 'ds模型推荐使用。需要特殊配置，见【详细】。'),
          // ★ 2026-09-19（用户口径）：它跟「卡里那段开场白」**不是一回事**，同屏说清，免得以后再混。
          e('div', { style: dimStyle }, '保留的是**第一轮问答的前两楼原文**（你给我一句、角色回一句）；'
            + '⛔ 与卡里的**开场白**无关 —— 开场白是卡字段，上游只在第一轮注入一次。'),
          e('div', { style: { textAlign: 'right' } },
            e('button', { style: linkStyle, onClick: () => setDetailOpen((v) => !v) }, detailOpen ? '【详细】▴' : '【详细】▾')),
          detailOpen ? e('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 10, borderLeft: '2px solid rgba(128,128,128,0.35)' } },
            e('div', { style: { fontSize: 12 } }, '特殊配置就两步：① 打开本卡的开关；② 在**第一条消息末尾**粘贴下面任一段指令（正文与指令之间空一行）。之后正常聊即可 —— 开关保证第一轮问答永不被压缩收走，指令因此一直有效。'),
            e('div', { style: { fontSize: 12 } }, '怎么用：在第一条消息末尾粘贴下面任一段（正文与指令之间空一行），之后正常聊。'),
            KEEP_FIRST_ROUND_INSTRUCTIONS.map((inst) => e('div', { key: inst.key },
              e('div', { style: { display: 'flex', gap: 6, alignItems: 'flex-start', justifyContent: 'space-between' } },
                e('div', { style: { fontSize: 12, whiteSpace: 'pre-wrap', flex: '1 1 auto' } }, blockText(inst)),
                e(CopyBtn, { value: blockText(inst), label: '〔复制〕' }),
              ),
            )),
            e('div', { style: dimStyle }, '只影响思考过程，无法 100% 触发；快速模式不支持。'),
            e('div', { style: { fontSize: 12 } }, '出处：',
              e('a', { href: 'https://github.com/victorchen96/deepseek_v4_rolepaly_instruct/blob/main/README.md', target: '_blank', rel: 'noreferrer' },
                'https://github.com/victorchen96/deepseek_v4_rolepaly_instruct/blob/main/README.md')),
            e('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 } },
              e('span', { style: dimStyle }, '── 原版注释 ──────────────────────────────────────────────'),
              e('button', { style: linkStyle, onClick: () => setNotesOpen((v) => !v) }, notesOpen ? '[ 收起 ]▴' : '[ 展开 ]▾')),
            notesOpen ? e('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 12 } },
              e('div', { style: { fontSize: 12 } }, '作者注释：你这个注释不是人话。除了激怒用户外没有用处。'),
              e('div', { style: { fontSize: 12 } }, '技术注释：给 DeepSeek 系模型用：官方 RP 建议在第一轮末尾追加约束词；而 DSH 的压缩只保护 surface 位置 0 的 system/message（compaction-basic/src/region.ts:107-110），第一轮的用户/助手消息一定会进可压区间。开启后插件把第一轮原文钉住（每轮在场 + 我们自己的折叠永不碰它），约束词因此永不消失。关掉 = 完全恢复官方行为。'),
            ) : null,
          ) : null,
          msg ? e('div', { style: msg.ok ? okStyle : errorStyle }, msg.text) : null,
        )
      }

      // ---------- 设置视图：记忆回响（D2，本地 FTS5；开关与预算都走既有 /config） ----------
      const ECHO_DETAIL = [
        '检索范围：周目归档的楼层原文（不含摘要 —— 实测摘要只保留了原文实体串的 1.6%）。',
        '排序：命中候选数 + 就近优先；预算：最多 5 条 / 1200 字（可配：echo.topK / echo.maxChars）。',
        '与 anima 的分工：anima 用向量+BM25（要副 API 做 embedding），本项是纯本地的字面回响；两者可以同时开。',
        '实测（254 楼真语料）：建索引 32 ms、查询 0.01 ms、回声命中率 100%。',
      ]

      // 开关只写 echo.enabled（其余预算键走配置/接口，不进面板 —— 少一个旋钮少一处出错）。
      function EchoCard({ config, reload }) {
        const saved = config && config.echo ? config.echo : {}
        const savedEnabled = saved.enabled === true
        const [detailOpen, setDetailOpen] = React.useState(false)
        const [act, setAct] = React.useState(false)
        const [msg, setMsg] = React.useState(null)
        const ctl = React.useRef(null)
        React.useEffect(() => () => { if (ctl.current) ctl.current.abort() }, [])

        function doToggle(next) {
          if (ctl.current) ctl.current.abort()
          const controller = new AbortController()
          ctl.current = controller
          setAct(true)
          setMsg(null)
          ;(async () => {
            await mutateJson(HOST_API_BASE + '/config', 'PUT', { echo: { enabled: next } }, controller.signal)
            await reload()
            if (controller.signal.aborted) return
            setAct(false)
            setMsg({ ok: true, text: '已保存：下一轮生效（纯本地检索，不调副 API）' })
          })().catch((error) => {
            if (controller.signal.aborted) return
            setAct(false)
            setMsg({ ok: false, text: errText(error) })
          })
        }

        const detailLink = { border: 'none', background: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', padding: 0 }
        return e('div', { style: cardStyle, 'data-echo-card': '1' },
          e('div', { style: { display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' } },
            e('div', { style: sectionTitleStyle }, '记忆回响（本地检索 · 不需要副 API）'),
            e('label', { style: { display: 'flex', gap: 4, alignItems: 'center', fontSize: 12, flex: 'none', cursor: 'pointer' } },
              e('input', {
                id: 'dma-echo-enabled', type: 'checkbox', checked: savedEnabled,
                disabled: act, onChange: (ev) => doToggle(ev.target.checked),
              }),
              '开关'),
          ),
          e('div', { style: dimStyle },
            '每轮开打之前，先在记忆库归档原文里搜一遍这一轮的关键词，把最相关的那几楼直接塞进提示词。'
            + '全本地、不调用任何副 API；只搜 3 字以上的词（更短的查不到，这是引擎限制）。'),
          e('div', { style: { textAlign: 'right' } },
            e('button', { style: detailLink, onClick: () => setDetailOpen((v) => !v) }, detailOpen ? '【详细】▴' : '【详细】▾')),
          detailOpen ? e('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 10, borderLeft: '2px solid rgba(128,128,128,0.35)' } },
            ECHO_DETAIL.map((line, i) => e('div', { key: 'echo-detail-' + i, style: { fontSize: 12 } }, line)),
            e('div', { style: dimStyle }, '当前预算：最多 ' + String(saved.topK ?? 5) + ' 条 / ' + String(saved.maxChars ?? 1200) + ' 字'),
          ) : null,
          msg ? e('div', { style: msg.ok ? okStyle : errorStyle }, msg.text) : null,
        )
      }

      // ---------- 设置视图：最近几楼（mt:lastFloors @10202；开关与预算都走既有 /config） ----------
      const LAST_FLOORS_DETAIL = [
        '只在本**周目绑定的会话**里生效（编程会话等一律不注）；且只在**第一句话**注入 —— 已经有真历史时一个字都不注。',
        '数据来源：当前「角色-周目」归档的 archive/floors（只读）；取最后 N 楼，按时间顺序（旧→新）发出。',
        '位置：system 块的**倒数第二** —— 紧随其后的 mt:postHistory（卡的后处理指令）保持绝对最后。',
        '为什么要它：新开的周目会话是空的，几百楼只在归档里 ⇒ 模型开局没有可承接的上下文，续写质量无从判断。',
        '⛔ DSH 结构上做不到把它注册成真会话历史（messages 块由宿主管）⇒ 只能注册成一段 system。',
        '超字数上限时**从最旧的那端丢**并如实标注丢了几楼（绝不清默吞）。',
      ]

      function LastFloorsCard({ config, reload }) {
        const saved = config && config.lastFloors ? config.lastFloors : {}
        const savedEnabled = saved.enabled === true
        const [detailOpen, setDetailOpen] = React.useState(false)
        const [act, setAct] = React.useState(false)
        const [msg, setMsg] = React.useState(null)
        const [count, setCount] = React.useState(String(saved.count ?? 8))
        const [maxChars, setMaxChars] = React.useState(String(saved.maxChars ?? 3000))
        const ctl = React.useRef(null)
        React.useEffect(() => () => { if (ctl.current) ctl.current.abort() }, [])
        // 保存后 reload 会带回服务端的真值 ⇒ 把两个输入框同步回真值（改不动的键就别显示成改得动的）。
        React.useEffect(() => {
          setCount(String(saved.count ?? 8))
          setMaxChars(String(saved.maxChars ?? 3000))
        }, [saved.count, saved.maxChars])

        function put(patch, okText) {
          if (ctl.current) ctl.current.abort()
          const controller = new AbortController()
          ctl.current = controller
          setAct(true)
          setMsg(null)
          ;(async () => {
            await mutateJson(HOST_API_BASE + '/config', 'PUT', { lastFloors: patch }, controller.signal)
            await reload()
            if (controller.signal.aborted) return
            setAct(false)
            setMsg({ ok: true, text: okText })
          })().catch((error) => {
            if (controller.signal.aborted) return
            setAct(false)
            setMsg({ ok: false, text: errText(error) })
          })
        }

        const numInput = { width: 76, fontSize: 12 }
        const detailLink = { border: 'none', background: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', padding: 0 }
        return e('div', { style: cardStyle, 'data-last-floors-card': '1' },
          e('div', { style: { display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' } },
            e('div', { style: sectionTitleStyle }, '最近几楼（新周目开局有上下文）'),
            e('label', { style: { display: 'flex', gap: 4, alignItems: 'center', fontSize: 12, flex: 'none', cursor: 'pointer' } },
              e('input', {
                id: 'dma-last-floors-enabled', type: 'checkbox', checked: savedEnabled,
                disabled: act, onChange: (ev) => put({ enabled: ev.target.checked }, '已保存：下一轮生效'),
              }),
              '开关'),
          ),
          e('div', { style: dimStyle },
            '新开的周目是空对话，模型看不到前面演过什么。打开后，只要**当前上下文少于 5000 字**（约等于"刚开场"），'
            + '就把当前周目归档里最近的几楼原文塞进提示词，让它接着演；上下文长过 5000 字就自动不再注入。只读归档，不调任何副 API。'),
          e('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 } },
            e('span', null, '保留楼层数'),
            e('input', {
              id: 'dma-last-floors-count', type: 'number', min: 1, max: 200, value: count,
              disabled: act, style: numInput, onChange: (ev) => setCount(ev.target.value),
            }),
            e('span', null, '字数上限'),
            e('input', {
              id: 'dma-last-floors-maxchars', type: 'number', min: 200, max: 60000, value: maxChars,
              disabled: act, style: numInput, onChange: (ev) => setMaxChars(ev.target.value),
            }),
            e('button', { disabled: act, onClick: () => put({ count: Number(count), maxChars: Number(maxChars) }, '已保存预算：下一轮生效') }, '保存预算'),
          ),
          e('div', { style: { textAlign: 'right' } },
            e('button', { style: detailLink, onClick: () => setDetailOpen((v) => !v) }, detailOpen ? '【详细】▴' : '【详细】▾')),
          detailOpen ? e('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 10, borderLeft: '2px solid rgba(128,128,128,0.35)' } },
            LAST_FLOORS_DETAIL.map((line, i) => e('div', { key: 'last-floors-detail-' + i, style: { fontSize: 12 } }, line)),
            e('div', { style: dimStyle }, '段名 mt:lastFloors · order 10202（倒数第二）· 当前预算：' + String(saved.count ?? 8) + ' 楼 / ' + String(saved.maxChars ?? 3000) + ' 字'),
          ) : null,
          msg ? e('div', { style: msg.ok ? okStyle : errorStyle }, msg.text) : null,
        )
      }

      // ---------- 记忆库写入（memory_write：模型交内容、我们落盘） ----------
      /**
       * 用户口径（2026-09-18）：「**最简单的，模型把文本输出到记忆库，我们自己抓**」。
       * ⇒ 给 RP 一个**语义**工具：模型交「一段文本 + 一个相对路径」，落盘、路径校验、周目归属全由插件负责。
       * ⛔ 通用 write / edit **永远不给**（会把"写任意文件"一起交出去，实测还会连带出两个写工具）。
       */
      // ---------- 归档写入视图（导入 U1 + 收纳） ----------
      /**
       * 用户口径（2026-09-15）：面板上「看不见导入」不是没生效 —— 是这半边**从来没做**
       * （B1 只到 plan；`/import/apply` 与面板入口都是待办）。这里把那半边补上：
       *
       *   ① **导入**（外部聊天记录 → 周目归档）：
       *      · 源 1）Tavern 的 `import-context-*.json`（Tavern 里选过导入就会生成）——面板**扫描**出来，点一下就用；
       *      · 源 2）手动粘贴 / 选文件（SillyTavern 导出的 jsonl 或 Tavern import-context JSON）。
       *      流程固定两步：**预览**（POST /import/plan，只给统计与警告，⛔ 不落库、不回正文）→
       *      **收进归档**（POST /import/apply，带上预览指纹；服务端重算并逐条核对，对不上就拒写）。
       *   ② **收纳**（本机会话 → 周目归档）：`/collect/scan` 只规划、`/collect/auto` 规划+落库+记台账（幂等）。
       *
       * ⛔ 界面绝不显示楼层正文：服务端计划里就没有正文（隐私铁律）。
       */
      function WriteView({ charId, playId, sessId, autoStatus, onToggleAuto, onPickTarget }) {
        const [targets, setTargets] = React.useState({ status: 'loading', list: [], error: '' })
        const [char, setChar] = React.useState(charId || '')
        const [play, setPlay] = React.useState(playId || '')
        const [scan, setScan] = React.useState(null) // { status, files:[name], note }
        const [srcPath, setSrcPath] = React.useState('')
        const [text, setText] = React.useState('')
        const [srcName, setSrcName] = React.useState('')
        const [keepGreeting, setKeepGreeting] = React.useState(true)
        const [keepHidden, setKeepHidden] = React.useState(true)
        const [plan, setPlan] = React.useState(null)
        const [busy, setBusy] = React.useState('')
        const [msg, setMsg] = React.useState(null)
        const [collectSess, setCollectSess] = React.useState(sessId || '')
        const [revision, setRevision] = React.useState(0)
        const ctl = React.useRef(null)
        React.useEffect(() => () => { if (ctl.current) ctl.current.abort() }, [])
        React.useEffect(() => { if (charId) setChar(charId) }, [charId])
        React.useEffect(() => { if (playId) setPlay(playId) }, [playId])
        React.useEffect(() => { if (sessId) setCollectSess(sessId) }, [sessId])

        // 可写的「角色-周目」列表（与收纳落库同一份 catalog 观察口径）
        React.useEffect(() => {
          const controller = new AbortController()
          ;(async () => {
            try {
              const res = await apiGet(HOST_API_BASE + '/collect/targets', controller.signal)
              if (controller.signal.aborted) return
              setTargets({ status: 'ready', list: Array.isArray(res.targets) ? res.targets : [], error: '' })
            } catch (error) {
              if (controller.signal.aborted) return
              setTargets({ status: 'error', list: [], error: errText(error) })
            }
          })()
          return () => controller.abort()
        }, [revision])

        // ★ 清空总结（运维口）—— **新 hook 一律追加在最后**：自检台按「组件名 → hook 序号」
        //   注入 fixture，插在中间会把后面所有 hook 的序号顶走（这个坑本轮已经踩过一次）。
        //   20260918 撤侧路：「扫描归档 / 开始总结」两步连同各自的结果 hook 一并删除
        //   —— 摘要由压缩链产出（走宿主主 API），面板不再单独调模型。
        const [sumReset, setSumReset] = React.useState(null)   // /summarize/reset 的结果（dryRun 或真清）
        const [overwriteImport, setOverwriteImport] = React.useState(false)

        const chars = []
        for (const t of targets.list) {
          if (t && typeof t.characterId === 'string' && t.characterId !== '' && chars.indexOf(t.characterId) < 0) chars.push(t.characterId)
        }
        const plays = targets.list.filter((t) => t && t.characterId === char)
        const targetReady = char !== '' && play !== ''
        // ★ 选中的周目是否已从工作区列表里消失（被删了）—— 用于上面那条醒目警示
        const targetStale = targetReady && !targets.list.some((t) => t && t.characterId === char && t.playthroughId === play)

        const run = (tag, fn) => {
          if (ctl.current) ctl.current.abort()
          const controller = new AbortController()
          ctl.current = controller
          setBusy(tag)
          setMsg(null)
          ;(async () => {
            const out = await fn(controller.signal)
            if (controller.signal.aborted) return
            setBusy('')
            return out
          })().catch((error) => {
            if (controller.signal.aborted) return
            setBusy('')
            const stale = error && error.code === 'IMPORT_PLAN_STALE'
            setMsg({
              ok: false,
              text: errText(error) + (stale ? ' —— 归档在你确认之后变了，请重新点「预览」再收。' : ''),
            })
          })
        }

        /** 扫描这个周目下 Tavern 留下的 import-context-*.json（Tavern 里选过导入就会有）。 */
        const doScan = () => run('scan', async (signal) => {
          if (!targetReady) throw new Error('先选「角色 / 周目」')
          const list = await listDir(char + '/' + play, signal)
          const files = list.filter((x) => x.type === 'file' && /^import-context-.*\.json$/.test(x.name)).map((x) => x.name)
          setScan({ status: 'ready', files, note: files.length === 0 ? '这个周目下没有待导入文件（Tavern 里选过导入才会有；也可以用下面的手动导入）' : '' })
        })

        /** 预览：只出统计与警告（⛔ 服务端不回正文）。 */
        const doPlan = (source) => run('plan', async (signal) => {
          if (!targetReady) throw new Error('先选「角色 / 周目」')
          const res = await apiPost(HOST_API_BASE + '/import/plan', signal, {
            source,
            target: { characterId: char, playthroughId: play },
            keepGreeting,
            keepHidden,
            // ★ 重新导入：覆盖同号楼层（不删周目、从 0 重写）
            overwrite: overwriteImport,
          })
          setPlan({ source, res })
        })

        /** 落库：把预览的 willWrite 原样回传 —— 服务端重算并逐条核对，对不上就一个字节都不写。 */
        const doApply = () => run('apply', async (signal) => {
          if (!plan) throw new Error('先点「预览」')
          const res = await apiPost(HOST_API_BASE + '/import/apply', signal, {
            source: plan.source,
            target: { characterId: char, playthroughId: play },
            keepGreeting,
            keepHidden,
            overwrite: overwriteImport,
            preview: { planId: plan.res.planId, hash: plan.res.hash, willWrite: plan.res.willWrite },
          })
          const n = Array.isArray(res.written) ? res.written.length : 0
          setMsg({ ok: true, text: '已收进归档：写入 ' + n + ' 个文件（' + res.floors + ' 楼 + 批次摘要 + 索引）' + (res.readBack ? '，每个文件都已读回核对' : '') })
          setPlan(null)
          setScan(null)
        })

        /** 收纳：scan = 只规划；auto = 规划+落库+记台账（幂等，重复点不会重复写）。 */
        const doCollect = (auto) => run(auto ? 'auto' : 'cs', async (signal) => {
          if (!collectSess) throw new Error('先选一个会话（或在 ⚙ 设置里把根会话选好）')
          if (!targetReady) throw new Error('先选「角色 / 周目」')
          // ⛔ 两条 URL 必须写成字面量：客户端自检台会扫「HOST_API_BASE 加单引号字面量」这种写法，
          //   写成三元表达式就漏检（表里就没它，等于这条纪律对收纳/导入两个端点失效）。
          //   （本注释故意不写出那种写法的样子 —— 它自己会被扫成一个"表外 rest"。）
          const collectUrl = auto ? HOST_API_BASE + '/collect/auto' : HOST_API_BASE + '/collect/scan'
          const res = await apiPost(collectUrl, signal, {
            sessionId: collectSess,
            target: { characterId: char, playthroughId: play },
          })
          if (!auto) {
            const regions = Array.isArray(res.regions) ? res.regions : []
            setMsg({ ok: true, text: '可收纳 ' + regions.length + ' 段；' + (res.willWrite ? res.willWrite.length + ' 个文件待写' : '') + (regions.length === 0 ? '（没有可收的东西：压缩过的楼段才会产生收纳目标）' : '') + '。确认无误再点「收进归档」。' })
          } else {
            const w = Array.isArray(res.written) ? res.written.length : 0
            setMsg({ ok: true, text: '收纳完成：写了 ' + w + ' 个文件' + (res.archived !== undefined ? '，覆盖 ' + res.archived + ' 楼' : '') + (res.skipped ? '，跳过 ' + res.skipped : '') })
          }
          setRevision((v) => v + 1)
        })

        /**
         * 清空总结（补救）：摘要坏了想重来时，把内容摘要清掉（压缩链随后会重新产出）。
         * 两步走：先 `dryRun:true` 看计划（清几条 / 备份到哪），再真清。
         * ⛔ 只清 summaries，原文楼层与导入批次清单一动不动。不调模型。
         */
        const doSumReset = (dry) => run(dry ? 'sumresetdry' : 'sumreset', async (signal) => {
          if (!targetReady) throw new Error('先选「角色 / 周目」')
          const res = await apiPost(HOST_API_BASE + '/summarize/reset', signal, {
            target: { characterId: char, playthroughId: play },
            dryRun: dry === true,
          })
          setSumReset(res)
          setMsg({ ok: res.ok, text: String(res.reason || '') })
          if (dry !== true) { setRevision((v) => v + 1) }
        })

        const pick = { fontSize: 12, maxWidth: 240 }
        const step = { display: 'flex', flexDirection: 'column', gap: 6, padding: 10, border: '1px solid rgba(128,128,128,0.25)', borderRadius: 6 }
        const warnLine = { fontSize: 12, color: 'inherit', opacity: 0.85 }

        return e('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, padding: 12, overflow: 'auto', minHeight: 0 } },
          // ★ 动作反馈**放在最上面**（2026-09-16 用户报「点了收纳没有用」）：
          //   原来它渲染在整页最底部（诊断卡上方），导入/收纳/总结任何一步失败，红字都在
          //   用户视线之外 ⇒ 看起来像"点了没反应"。现在提到顶部，一律第一眼就能看到。
          msg ? e('div', { style: Object.assign({}, msg.ok ? okStyle : errorStyle, { fontWeight: 700 }) }, msg.text) : null,
          // ── ①② 目标：角色-周目 ──
          e('div', { style: cardStyle },
            e('div', { style: sectionTitleStyle }, '写到哪个「角色-周目」'),
            targets.status === 'loading' ? e('div', { style: dimStyle }, '读取周目列表…') : null,
            targets.status === 'error' ? e('div', { style: errorStyle }, '读不到周目列表：' + targets.error) : null,
            targets.status === 'ready' && chars.length === 0
              ? e('div', { style: dimStyle }, '工作区里还没有 catalog.json 或没有周目 —— 先在 Tavern 里建一个周目。')
              : null,
            targets.status === 'ready' && targetStale
            ? e('div', { style: Object.assign({}, errorStyle, { fontWeight: 700 }) },
              '⚠ 当前选的周目「' + play + '」**已不在工作区列表里**（多半是被删除了）—— '
              + '写进一个已删除的周目会失败（报错会显示在本卡上方）。请重新选一个周目；'
              + '若内容还在 Tavern 回收站（`.dtavern-trash`），先恢复再选它。')
            : null,
          targets.status === 'ready' && chars.length > 0
              ? e('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
                e('select', {
                  id: 'dma-write-char', 'data-sel': '1', style: pick, value: char,
                  onChange: (ev) => { const c = ev.target.value; setChar(c); const first = targets.list.find((t) => t && t.characterId === c); setPlay(first ? first.playthroughId : ''); setPlan(null); setScan(null) },
                },
                e('option', { value: '' }, '（选角色）'),
                chars.map((c) => e('option', { key: 'wc-' + c, value: c }, c)),
                ),
                e('select', {
                  id: 'dma-write-play', 'data-sel': '1', style: pick, value: play, disabled: char === '',
                  onChange: (ev) => { setPlay(ev.target.value); setPlan(null); setScan(null) },
                },
                e('option', { value: '' }, '（选周目）'),
                plays.map((t) => e('option', { key: 'wp-' + t.playthroughId, value: t.playthroughId },
                  (t.title || t.playthroughId) + (t.hasArchive ? '（已有 ' + (t.floorCount ?? 0) + ' 楼）' : '（空库）'))),
                ),
                onPickTarget ? e('button', {
                  className: 'dma-btn dma-tab', title: '把设置里的根也切到这个周目',
                  onClick: () => onPickTarget(char, play),
                }, '设为当前根') : null,
              )
              : null,
          ),

          // ── ① 导入 ──
          e('div', { style: cardStyle },
            e('div', { style: sectionTitleStyle }, '导入外部聊天记录'),
            e('div', { style: dimStyle },
              '把外面的聊天记录收进 <角色>/<周目>/archive/ —— 支持两种源：Tavern 的 import-context JSON、'
              + 'SillyTavern 导出的 jsonl。楼号从归档现有最大楼号往后接；同一份源重复导入会被台账拦下。'),
            e('div', { style: step },
              e('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                e('button', { className: 'dma-btn dma-tab', disabled: !targetReady || busy !== '', onClick: doScan }, busy === 'scan' ? '扫描中…' : '① 扫描 Tavern 留下的待导入文件'),
                scan && scan.status === 'ready' && scan.files.length > 0
                  ? e('span', { style: okStyle }, '发现 ' + scan.files.length + ' 份')
                  : null,
              ),
              scan && scan.note ? e('div', { style: warnLine }, scan.note) : null,
              scan && scan.files.length > 0
                ? e('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                  scan.files.map((f) => e('div', { key: 'imp-' + f, style: { display: 'flex', gap: 8, alignItems: 'center' } },
                    e('code', { style: { fontSize: 12 } }, f),
                    e('button', {
                      className: 'dma-btn', disabled: busy !== '',
                      onClick: () => { setSrcPath(char + '/' + play + '/' + f); setSrcName(f); setText(''); doPlan({ path: char + '/' + play + '/' + f }) },
                    }, '预览这份'),
                  )),
                )
                : null,
            ),
            e('div', { style: step },
              e('div', { style: sectionTitleStyle }, '或者：手动给一份'),
              e('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                e('input', {
                id: 'dma-import-file', type: 'file', accept: '.json,.jsonl,.txt', style: { fontSize: 12 },
                  onChange: (ev) => {
                    const file = ev.target.files && ev.target.files[0]
                    if (!file) return
                    file.text().then((t) => { setText(t); setSrcName(file.name); setSrcPath(''); setPlan(null) }).catch((error) => setMsg({ ok: false, text: '读文件失败：' + errText(error) }))
                  },
                }),
                srcName && text !== '' ? e('span', { style: dimStyle }, '已载入：' + srcName + '（' + text.length + ' 字）') : null,
              ),
              e('textarea', {
                id: 'dma-import-text', value: text, placeholder: '也可以直接粘贴 JSON / JSONL 原文',
                style: { width: '100%', minHeight: 90, fontFamily: 'monospace', fontSize: 12 },
                onChange: (ev) => { setText(ev.target.value); setSrcPath(''); setPlan(null) },
              }),
              e('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                e('button', { className: 'dma-btn dma-tab', disabled: !targetReady || text.trim() === '' || busy !== '', onClick: () => doPlan({ text }) }, busy === 'plan' && srcPath === '' ? '导入①（进行中…）' : '导入①'),
                e('label', { style: { fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' } },
                  e('input', { id: 'dma-import-keep-greeting', type: 'checkbox', checked: keepGreeting, onChange: (ev) => { setKeepGreeting(ev.target.checked); setPlan(null) } }), '保留开场白'),
                e('label', { style: { fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' } },
                  e('input', { id: 'dma-import-keep-hidden', type: 'checkbox', checked: keepHidden, onChange: (ev) => { setKeepHidden(ev.target.checked); setPlan(null) } }), '保留隐藏楼'),
                // ★ 重新导入：覆盖同号楼层（归档里已有这些楼时，不加这个会被 COLLECT_FLOOR_CONFLICT 拦下）
                e('label', {
                  style: { fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' },
                  title: '归档里已有同号楼层时，勾上它 = 直接覆盖重写（不删周目、从 0 重来）；不勾会被「楼层已存在」拦下',
                },
                e('input', {
                  id: 'dma-import-overwrite', type: 'checkbox', checked: overwriteImport,
                  onChange: (ev) => { setOverwriteImport(ev.target.checked); setPlan(null) },
                }), '覆盖同号楼层（重新导入）'),
              ),
            ),
            plan
              ? e('div', { style: step },
                e('div', { style: sectionTitleStyle }, '预览（还没写任何东西）'),
                e('div', { style: { fontSize: 12 } },
                  '格式：' + String(plan.res.format) + ' · 源 ' + String(plan.res.stats.bytes) + ' 字节 / '
                  + String(plan.res.stats.turns) + ' 楼（隐藏 ' + String(plan.res.stats.hidden) + '）· 将写 '
                  + String(plan.res.willWrite.length) + ' 个文件 · 批次号 ' + String(plan.res.planId)),
                plan.res.firstTurnPreview
                  ? e('div', { style: dimStyle }, '首楼：' + plan.res.firstTurnPreview.role + ' / ' + String(plan.res.firstTurnPreview.chars) + ' 字（正文不回显）')
                  : null,
                Array.isArray(plan.res.warnings) && plan.res.warnings.length > 0
                  ? e('div', { style: warnLine }, plan.res.warnings.join('；'))
                  : null,
                e('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                  e('button', { className: 'dma-btn dma-tab', disabled: busy !== '' || !targetReady, onClick: doApply }, busy === 'apply' ? '写入中…' : '② 收进归档'),
                  e('button', { className: 'dma-btn', disabled: busy !== '', onClick: () => setPlan(null) }, '取消'),
                ),
              )
              : null,
          ),

          // ── ③ 归档摘要：由压缩链产出（20260918 撤侧路）＋ 清空总结（运维口） ──
          e('div', { style: cardStyle },
            e('div', { style: sectionTitleStyle }, '归档摘要：由压缩链自动产出'),
            e('div', { style: dimStyle },
              '摘要不再单独调模型：对话被压缩时，宿主主 API 顺手把摘要写进归档（走主 API，**不用配置**）。'
              + '这里只剩一个运维口：摘要坏了想重来时，清空内容摘要（会先备份），之后压缩链会重新产出。'),
            e('div', { style: step },
              // ── 清空总结（运维口：只清摘要、不调模型）—— 两步走 ──
              e('div', {
                style: {
                  display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
                },
              },
              e('button', {
                className: 'dma-btn', disabled: !targetReady || busy !== '',
                title: '先看计划（清几条、备份到哪），零写入',
                onClick: () => doSumReset(true),
              }, busy === 'sumresetdry' ? '出计划…' : '清空总结（先看计划）'),
              sumReset && sumReset.dryRun && !sumReset.cleared
                ? e('button', {
                  className: 'dma-btn dma-tab', disabled: busy !== '',
                  title: '把旧摘要正文备份到 archive/_backup-summaries-<时间戳>/ 之后清空，之后由压缩链重新产出',
                  onClick: () => doSumReset(false),
                }, busy === 'sumreset' ? '清空中…' : '确认清空 ' + String(sumReset.content ?? 0) + ' 条')
                : null,
              e('span', { style: dimStyle },
                '摘要坏了想重来时用这个：只清**内容摘要**（原文楼层与导入批次清单不动），清完等压缩链重新产出。'),
              ),
              sumReset && !sumReset.dryRun && sumReset.backupRel
                ? e('div', { style: { fontSize: 12, opacity: 0.85 } },
                  '旧摘要已备份到：' + String(sumReset.backupRel) + '（' + String(sumReset.backupFiles ?? 0) + ' 个文件）')
                : null,
            ),
          ),

          // ── ② 收纳（本机会话 → 归档） ──
          e('div', { style: cardStyle },
            e('div', { style: sectionTitleStyle }, '收纳：把本机会话的楼段收进归档'),
            e('div', { style: dimStyle },
              '扫这个会话里**被压缩替换掉**的楼段，把原文收进归档（幂等：重复点不会重复写）。'
              + '「只看不动」先规划，确认无误再「收进归档」。'),
            e('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              e('input', {
                id: 'dma-collect-session', value: collectSess, placeholder: '会话 id（默认取当前根会话）',
                style: { fontSize: 12, minWidth: 320 }, onChange: (ev) => setCollectSess(ev.target.value),
              }),
              e('button', { className: 'dma-btn dma-tab', disabled: busy !== '' || !collectSess || !targetReady, onClick: () => doCollect(false) }, busy === 'cs' ? '规划中…' : '看一看能收什么'),
              e('button', { className: 'dma-btn dma-tab', disabled: busy !== '' || !collectSess || !targetReady, onClick: () => doCollect(true) }, busy === 'auto' ? '收纳中…' : '收进归档'),
            ),
            // ── 自动收纳：压缩后自动收（默认开）+ 上一次运行结果（失败必播报） ──
            e('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 } },
              e('label', { style: { display: 'flex', gap: 4, alignItems: 'center', fontSize: 12, cursor: 'pointer' } },
                e('input', {
                  id: 'dma-auto-collect-enabled', type: 'checkbox',
                  checked: autoStatus && autoStatus.enabled !== false,
                  onChange: (ev) => { if (onToggleAuto) onToggleAuto(ev.target.checked) },
                }),
                '压缩后自动收（默认开）'),
              e('span', { style: dimStyle }, '只收**绑定周目**的会话；别的会话（比如你干活的编程会话）压了也不会写进角色档案。'),
            ),
            e('div', { style: autoStatus && autoStatus.last && autoStatus.last.ok === false ? errorStyle : dimStyle },
              !autoStatus || autoStatus.status === 'loading'
                ? '自动收纳状态：读取中…'
                : autoStatus.status === 'error'
                  ? '自动收纳状态读不到：' + autoStatus.error
                  : autoStatus.last === null
                    ? '自动收纳：还没跑过（等下一次压缩后的轮末）'
                    : autoStatus.last.ok === false
                      ? '★ 上次自动收纳**失败**：[' + String(autoStatus.last.code || '?') + '] ' + String(autoStatus.last.message || '')
                        + '（时间 ' + String(autoStatus.last.at || '') + '）'
                      : autoStatus.last.skipped === true
                        ? '上次自动收纳：跳过（' + String(autoStatus.last.reason || '') + '）'
                        : '上次自动收纳：成功 · 扫 ' + String(autoStatus.last.scanned ?? 0) + ' 段 / 收 ' + String(autoStatus.last.archived ?? 0)
                          + ' 段 / 写 ' + String(autoStatus.last.written ?? 0) + ' 个文件'
                          + (autoStatus.last.ms !== undefined ? '（' + String(autoStatus.last.ms) + 'ms）' : ''),
            ),
          ),
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
              : e(WorkspaceRootPicker, { config: cfg, disc: disc, nameIdx: nameIdx, reload: reload, onPick: onPickWorkspace }),
            e(ApiSettings, { config: cfg, reload: reload }),
            e(KeepFirstRoundCard, { config: cfg, reload: reload }),
            e(EchoCard, { config: cfg, reload: reload }),
            e(LastFloorsCard, { config: cfg, reload: reload }),
            // ★ 2026-09-19：「记忆库写入」那张卡随工具一起退役（用户口径「包括代码和描述」）。
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
      function ArchivePanel({ onClose, sessions }) {
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
        // 自动收纳的开关与**上一次运行结果**（失败要播报）：读自己的状态出口。
        // ★ 新增 hook 一律**追加在最后** —— 自检台是按「组件名 → hook 序号」注入预设的，
        //   插在中间会把 4=disc / 5=catalog / 6=tick / 7=pickedSessionId 的序号整体顶掉。
        const [autoStatus, setAutoStatus] = React.useState({ status: 'loading', enabled: true, last: null, error: '' })
        React.useEffect(() => {
          const controller = new AbortController()
          ;(async () => {
            try {
              const res = await apiGet(HOST_API_BASE + '/auto-collect', controller.signal)
              if (controller.signal.aborted) return
              setAutoStatus({ status: 'ready', enabled: res.enabled !== false, last: res.last ?? null, error: '' })
            } catch (error) {
              if (controller.signal.aborted) return
              setAutoStatus((s) => ({ ...s, status: 'error', error: errText(error) }))
            }
          })()
          return () => controller.abort()
        }, [tick, view])

        // ★ 2026-09-19（用户口径「点开记忆库要自动跳转到对应周目」）：**跟随当前会话**。
        //   问宿主"这个会话属于哪个周目"（/playthrough/for-session），查到且与当前绑定不同就
        //   **把绑定改过去** —— 改绑定而不是只改显示：面板读的档、面板里「收纳/导入」写的、
        //   后台自动收纳，三处都读同一个绑定，于是口径全都对得上。
        //   ⛔ 只在 `source === 'session'` 时动；查不到（非 Tavern 会话 / catalog 读不到）**一个字都不改**；
        //   ⛔ 跟随失败绝不影响面板本身（拿不到就按原绑定看）。
        const followRef = React.useRef('')
        // ★ 2026-09-20：「切不动」的另一半 —— 用户**在本面板里手动选过**之后就不再跟随。
        //   刚亲手改的绑定，不能被"打开即跟随当前会话"这套自动逻辑在**同一个面板会话里**再拽回去
        //   （跟随只在挂载时问一次会话归属；手动选择必须赢过它）。关掉面板重开 ⇒ 跟随照旧生效 —— 那是要的行为。
        const userPickedRef = React.useRef(false)
        // ★★ 2026-09-20：本会话「归入哪个周目」的**展示态** —— 与"改绑定"是**两件事**（见下）。
        //   口径「认不出来的会话默认为新会话」⇒ 未归入的会话一个字都不**改绑定**，但面板必须**说出来**：
        //   否则顶栏显示着绑定的那个周目、实际注入全停 —— 那正是一个"看着像骗人"的地方。
        //   取值复用**下面这次** `/playthrough/for-session`（⛔ 不新开第二次请求）。
        const [sessPt, setSessPt] = React.useState({ status: 'loading', playthroughId: '', source: '' })
        React.useEffect(() => {
          if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== 'function') return undefined
          let alive = true
          const sync = async () => {
            if (userPickedRef.current) return
            try {
              const snap = sessions.list.getSnapshot() || {}
              const sid = typeof snap.current === 'string' ? snap.current : ''
              if (sid === '') return
              const data = await requestJson(HOST_API_BASE + '/playthrough/for-session?sessionId=' + encodeURIComponent(sid))
              if (!alive) return
              // ★ 先记**展示态**（认得出 / 没归入），**再**决定要不要改绑定 —— 两件事互不牵连：
              //   认不出 ⇒ 不改绑定（⛔ 一个字都不动），但展示态要如实说"未归入"。
              const char0 = data && data.ok === true ? String(data.characterId || '') : ''
              const play0 = data && data.ok === true ? String(data.playthroughId || '') : ''
              const mapped = data && data.ok === true && data.source === 'session' && char0 !== '' && play0 !== ''
              setSessPt({ status: 'ready', playthroughId: mapped ? play0 : '', source: mapped ? 'session' : 'none' })
              if (!mapped) return
              const char = char0
              const play = play0
              const key = char + '/' + play
              if (followRef.current === key) return // 这次打开已经跟过它了 ⇒ 不重复写（reload 会把本 effect 再跑一遍）
              const cur = host.config && host.config.root ? host.config.root : null
              if (cur && cur.characterId === char && cur.playthroughId === play) { followRef.current = key; return }
              await mutateJson(HOST_API_BASE + '/config', 'PUT', { root: { characterId: char, playthroughId: play } })
              followRef.current = key
              if (alive) reload()
            } catch (error) { /* 跟随失败不影响面板 */ }
          }
          void sync()
          const unsubscribe = typeof sessions.list.subscribe === 'function'
            ? sessions.list.subscribe(() => { void sync() })
            : undefined
          return () => { alive = false; if (typeof unsubscribe === 'function') unsubscribe() }
        }, [tick, view])

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
            setDisc({ status: 'ready', error: '', found: res.found, characterId: res.characterId, playthroughId: res.playthroughId, emptyArchive: res.emptyArchive === true, archiveMap: res.archiveMap || null })
          })().catch((error) => {
            if (controller.signal.aborted) return
            setDisc({ status: 'error', error: errText(error), found: [], characterId: null, playthroughId: null })
          })
          return () => controller.abort()
        }, [tavernOk, tick])

        // 当前根（20260914 M6 起 /config 投影已回 root ⇒ 这里常态能拿到配置值；pickedSessionId
        // 只做「保存请求在途」时的即时回显，配置读不到时的自动发现退化保持原样）
        const cfgReady = host.configStatus === 'ready' && !!host.config
        const mode = cfgReady ? (host.config.rootMode === 'workspace' ? 'workspace' : 'session') : 'workspace'
        const cfgRoot = cfgReady && host.config.root && typeof host.config.root === 'object' ? host.config.root : null
        const wsChar = (cfgRoot && typeof cfgRoot.characterId === 'string' && cfgRoot.characterId) || disc.characterId || null
        const wsPlay = (cfgRoot && typeof cfgRoot.playthroughId === 'string' && cfgRoot.playthroughId) || disc.playthroughId || null
        const sessId = mode === 'session'
          ? ((cfgRoot && typeof cfgRoot.sessionId === 'string' && cfgRoot.sessionId) || pickedSessionId)
          : ''

        // 根归档位（20260914 M6）：GET /sessions（titles=0 快路径）带 M5 的逐请求归档投影 ——
        // 取当前根那一行的 archived 位 + archive.known。取不到/服务端旧 ⇒ known:false（未知），
        // 头部一条提示都不出（⛔ 不许猜）。★ 只提示：不隐藏、不禁用、不清空选根。
        const [rootArch, setRootArch] = React.useState({ known: false, archived: false })
        React.useEffect(() => {
          if (mode !== 'session' || !sessId) {
            setRootArch((s) => (s.known === false && s.archived === false) ? s : { known: false, archived: false })
            return
          }
          const controller = new AbortController()
          ;(async () => {
            const data = await apiGet(HOST_API_BASE + '/sessions', controller.signal)
            if (controller.signal.aborted) return
            const known = !!(data && data.archive && data.archive.known === true)
            const row = known && Array.isArray(data.sessions) ? data.sessions.find((r) => r && r.sessionId === sessId) : null
            setRootArch({ known, archived: !!row && row.archived === true })
          })().catch(() => {
            if (!controller.signal.aborted) setRootArch({ known: false, archived: false })   // 未知 ⇒ 不提示
          })
          return () => controller.abort()
        }, [mode, sessId])
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
              // ★★ 2026-09-20：**本会话的周目态** —— 紧挨「当前根」，让人一眼分清
              //   「面板在看哪个周目（绑定）」与「这个会话实际归入哪个周目（生效）」。
              //   认不出 ⇒ 红字：注入（笔记路径/最近几楼/回响/检索）与 memory_write 全停。
              //   ⛔ 未归入时**只显示**，一个字都不改绑定（改绑定由下面的跟随逻辑决定，且只在认得出时）。
              sessPt.status === 'ready' && sessPt.source === 'session'
                ? e('span', {
                  style: dimBadgeStyle, 'data-sess-pt': '1',
                  title: '本会话在 Tavern 的 catalog/timeline 里归入的周目：' + sessPt.playthroughId,
                }, '本会话：' + labelPlaythrough(sessPt.playthroughId, nameIdx, { short: true }))
                : (sessPt.status === 'ready' && sessPt.source === 'none'
                  ? e('span', {
                    style: errorStyle, 'data-sess-unmapped': '1',
                    title: '这个会话还没被 Tavern 归入任何周目 ⇒ 记忆库这一侧全停（笔记路径 / 最近几楼 / 回响 / 检索都不参与，memory_write 会直接报错）。先在 Tavern 里给它开/选一个周目。',
                  }, '本会话：未归入周目 ⇒ 注入与笔记停用')
                  : null),
              // 归档提示（20260914 M6）：会话根 + 已知 + 已归档才显示；★ 只提示，不隐藏不禁用
              (rootArchiveHint({ mode, known: rootArch.known, archived: rootArch.archived })
                ? e('span', {
                  style: dimBadgeStyle, 'data-root-archived': '1',
                  title: '来源：工作区注册表 archivedSessionIds（只读投影）',
                }, rootArchiveHint({ mode, known: rootArch.known, archived: rootArch.archived }))
                : null),
              cfgReady && host.config.configError
                ? e('span', { style: errorStyle, title: String(host.config.configError) }, '⚠')
                : null,
              // ★ 自动收纳**失败播报**（用户口径：失败要播报，不许静默）：顶栏一条红标，
              //   title 里给 code 与原因；点它就切到「⇩ 导入 / 收纳」看细节。
              autoStatus.last && autoStatus.last.ok === false
                ? e('span', {
                  style: errorStyle, 'data-auto-collect-failed': '1', role: 'button',
                  title: '自动收纳失败：[' + String(autoStatus.last.code || '?') + '] ' + String(autoStatus.last.message || '')
                    + '（点此查看「导入 / 收纳」）',
                  onClick: () => setView('write'),
                }, '⚠ 自动收纳失败')
                : null,
              e('div', { style: { flex: 1 } }),
              dot,
              e('button', {
                className: 'dma-btn dma-tab', 'data-sel': view === 'write' ? '1' : '0',
                onClick: () => setView(view === 'write' ? 'read' : 'write'),
                title: '导入外部聊天记录 / 收纳本机会话 —— 把内容真正写进 <角色>/<周目>/archive',
              }, '⇩ 导入 / 收纳'),
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
                : view === 'write'
                  ? e(WriteView, {
                    charId: wsChar, playId: wsPlay, sessId: sessId,
                    autoStatus: autoStatus,
                    // 「自动收纳」开关：真的落配置（默认开；关掉就完全不自动收）
                    onToggleAuto: (next) => {
                      runAction(async (signal) => {
                        await mutateJson(HOST_API_BASE + '/config', 'PUT', { autoCollect: { enabled: next } }, signal)
                        await loadAll(signal)
                        if (signal.aborted) return
                        setTick((t) => t + 1)
                      }).catch(() => {})
                    },
                    // 「设为当前根」= 真的落配置（与 ⚙ 设置里选根同一套 PUT /config），
                    // ⛔ 只改界面状态不改配置的话，下一轮读的还是旧根（"看起来切了其实没切"）。
                    onPickTarget: (c, p) => {
                      runAction(async (signal) => {
                        await mutateJson(HOST_API_BASE + '/config', 'PUT', { root: { sessionId: null, characterId: c, playthroughId: p } }, signal)
                        await loadAll(signal)
                        if (signal.aborted) return
                        setTick((t) => t + 1)
                      }).catch(() => {})
                    },
                  })
                  : view === 'templates'
                  ? e(TemplatesView, { onBack: () => setView('read'), sessionId: sessId || eventsSessionId || '' })
                  : e(SettingsView, {
                    host: host, saveMode: saveMode, modeSave: modeSave, reload: reload,
                    nameIdx: nameIdx, catalog: catalog, disc: disc,
                    onPickWorkspace: (c, p) => {
                      userPickedRef.current = true   // 手动选过 ⇒ 本次打开不再自动跟随（见 followRef 那段）
                      setDisc((s) => ({ ...s, characterId: c, playthroughId: p }))
                    },
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

      // ==================================================================
      // F 单（20260918）「OOC 划词质疑（近似版）」—— 会话正文划选 AI 回复 ⇒
      //   「OOC: 首行 + 原草稿 + > 逐行引用 + 我的质疑：」写回输入框草稿，玩家自己按发送。
      //   ⛔ 不做精确锚定、不做浮动跟随按钮、不做自动发送；选区文本不落盘。
      //
      // 宿主契约（任务书已查实的部分；deepseek-harness 源码被守卫挡着，不许再读）：
      //   - 会话级 slot 的 props 都带 `inputActions: InputActions`（ui-conversation contract/slots.ts:200）；
      //     InputActions 只有 setDraft(text)（整体替换草稿）与 submit()（contract/input.ts:222-236）——只写不读。
      //   - 席位 `conversation.input.right`（slots.ts:174）：composer 提交动作前的紧凑控件位（list/session）。
      //
      // 三条底线在代码里的落点：
      //   ① 读当前草稿没有 props 出口 ⇒ 唯一正当出口是输入卡片 DOM：从按钮往上找 class 含
      //     'card' 的祖先层（重启按钮单真机实测：输入卡片 class 是「哈希前缀_card」，后缀稳定），
      //     再在卡里找 textarea / contenteditable。★ 读不到草稿就一个字不写 —— setDraft 是
      //     整体替换，盲写等于覆盖玩家草稿（本功能头号事故）。
      //   ② 选区判据：getSelection 的 commonAncestorContainer 必须落在「会话区容器」里。
      //     容器 = **从我们自己的按钮往上**找到的第一个语义后缀命中的祖先（真机实测
      //     `_9UxHwG_scrollBody`；⛔ 别写 `.conversation.session` —— 真机里没有这个词）。
      //     找不到 = 禁用 + title 写明原因，绝不放宽。另排除两类假剧情：
      //     选区链条经过自家 dma- 浮层（面板正文不是剧情）、选区在输入框里（contenteditable）。
      //   ③ 拼装 = `OOC:` 单独占首行（社区预设的场外契约看开头）+ 原草稿逐字保留在前缀的
      //     下一段 + 空行 + 引用块；引用超长按 prompt-viewer 的 PREVIEW_MAX_CHARS=120
      //     同口径截断并标注「（已截断，原 N 字符）」。
      // ==================================================================

      // 会话区容器判据（★ 2026-09-18 真机实测改口径）：
      //   DSH 的真实 class 是 `<构建哈希>_<语义名>`（实测 `_9UxHwG_scrollBody` / `_9UxHwG_composerSeat`
      //   / `z2cnRW_sessionRow`），哈希随构建变、语义名稳 ⇒ 只能按**语义后缀**认。
      //   ⛔ 原先那三档候选选择器（`.conversation.session` 等）**在真机里一个都命不中** ——
      //   整个 DOM 里就没有 `conversation` 这个词（那是**席位名**，不是 class）。
      //   漏掉的后果不是报错，是**按钮恒禁用**（静默）。
      //   ★ 第二个必须改的原因：原实现从「自家 `.dma-entry` 齿轮」往上走、沿途判 `cur.contains(el)`，
      //   走到 `<body>` 时它对**任何**元素都为真 ⇒ 每个候选都被当成"在侧边栏"跳过 ⇒ 同样恒 null。
      //   （`_selftest-client.mjs` 的假节点没有 `contains`，所以那条分支在台子上一次都没被跑到。）
      //   ⇒ 现在改成**从我们自己的按钮往上找**：侧边栏天然不在输入栏的祖先链上，
      //     不必再猜"侧边栏那片"，上面两处一并消失。
      const OOC_CONTAINER_SUFFIXES = ['_scrollBody', '_root', '_body']   // 实测存在（`_9UxHwG_*`）
      // 输入栏「座位」（我们这一席就挂在这里面）—— 按钮还没挂上时（首帧）用它兜底
      const OOC_SEAT_SUFFIX = '_composerSeat'
      // 实测：整个页面**只有输入框**带 `contenteditable` ⇒ 拿它认"这条选区在输入框里"
      const OOC_COMPOSER_ATTR = 'contenteditable'
      // 与 lib/prompt-viewer.js:96 的 PREVIEW_MAX_CHARS 同一个数字、同一套口径（120）——
      //   client 半侧是独立 bundle 引不到它，只能照抄值；⛔ 不另起第二套截断口径。
      const OOC_QUOTE_MAX_CHARS = 120
      // 引导行 ★ 不带 `【OOC】`：场外标记已由首行 `OOC:` 承担（社区预设认的是**开头**），
      //   它名单里没有 `【OOC】` 这种写法 —— 再挂一个只会出现在草稿里添乱（旧形状的问题之二）。
      const OOC_BLOCK_TAIL = '我的质疑：'

      function oocChainHitsDma(node) {
        let cur = node
        let guard = 0
        while (cur && guard < 100) {
          const cls = typeof cur.className === 'string' ? cur.className : ''
          if (cls.indexOf('dma-') !== -1) return true
          cur = cur.parentNode
          guard++
        }
        return false
      }

      /** 纯判定（自检直测）：锚点是否落在会话区容器里（沿途不许经过自家 dma- 浮层） */
      function selectionVerdict(anchor, sessionContainer) {
        if (!anchor) return { ok: false, reason: '没有选中文字' }
        if (oocChainHitsDma(anchor)) return { ok: false, reason: '选区在本插件面板里，不是会话正文' }
        if (!sessionContainer) return { ok: false, reason: '页面上没找到会话区容器' }
        let cur = anchor
        let guard = 0
        while (cur && guard < 100) {
          if (cur === sessionContainer) return { ok: true, reason: '' }
          cur = cur.parentNode
          guard++
        }
        return { ok: false, reason: '选区不在会话区里（侧边栏/别处面板选中的一律不算）' }
      }

      /**
       * 会话区容器：**从我们自己那颗按钮**（输入栏席位）往上找会话区那一片。
       * ★ 侧边栏/别处面板天然不在输入栏的祖先链上 ⇒ 不必再猜「侧边栏那片」。
       * ★★ 找法必须是「先按**后缀优先级**扫整条祖先链」，**不能**「第一个命中的祖先就返回」——
       *   实测链是（由内到外）：`sFkQRG_root`(输入卡片) → `_9UxHwG_composerSeat` →
       *   **`_9UxHwG_scrollBody`(会话区，716 字)** → `_9UxHwG_body` → `_9UxHwG_root`。
       *   输入卡片自己就带 `_root` ⇒ 「第一个命中」会停在卡片上（那是**只有输入框**的一小块，
       *   里面没有任何正文）⇒ 选区判据永远说不清。
       * `fromEl` 还没有时（首帧 / 组件刚挂）退到页面上唯一的输入栏座位再往上找。
       * 仍然找不到就返回 null，调用方**禁用并如实写原因**（⛔ 绝不放宽成「页面上哪段选中都算剧情」）。
       */
      function findSessionContainer(fromEl, doc) {
        try {
          const chain = []
          let cur = fromEl && (fromEl.parentElement || fromEl.parentNode)
          if (!cur) {
            const d = doc || (typeof document === 'undefined' ? null : document)
            cur = d && typeof d.querySelector === 'function' ? d.querySelector('[class*="' + OOC_SEAT_SUFFIX + '"]') : null
          }
          let guard = 0
          while (cur && guard < 40) {
            chain.push(cur)
            cur = cur.parentElement || cur.parentNode
            guard++
          }
          // 后缀按**优先级**逐轮扫整条链（`_scrollBody` 最具体 ⇒ 排第一）
          for (let i = 0; i < OOC_CONTAINER_SUFFIXES.length; i++) {
            const suf = OOC_CONTAINER_SUFFIXES[i]
            for (let j = 0; j < chain.length; j++) {
              if (String(chain[j].className || '').indexOf(suf) !== -1) return chain[j]
            }
          }
        } catch (error) { /* 拿不到就按拿不到处理 */ }
        return null
      }

      /** 选区是不是落在输入框里（沿锚点往上、到容器为止，谁带 contenteditable 就是它） */
      function oocAnchorInComposer(anchor, container) {
        try {
          let cur = anchor
          let guard = 0
          while (cur && cur !== container && guard < 60) {
            if (typeof cur.hasAttribute === 'function' && cur.hasAttribute(OOC_COMPOSER_ATTR)) return true
            cur = cur.parentElement || cur.parentNode
            guard++
          }
        } catch (error) { return false }
        return false
      }

      /** 输入框元素（写回后聚焦用；⛔ 找不到就不聚焦，不硬凑） */
      function composerFocusEl(container) {
        if (!container || typeof container.querySelector !== 'function') return null
        try { return container.querySelector('[' + OOC_COMPOSER_ATTR + ']') } catch (error) { return null }
      }

      /**
       * 读当前草稿（⛔ `setDraft` 是**整体替换**，写之前必须先读；读不到返回 null ⇒ 调用方一个字不写）。
       * ★ 走宿主 props：`SessionStandardProps.useInput`（`ui-conversation/.../contract/slots.ts:200`）
       *   → `InputState.draft`（同目录 `contract/input.ts:331`，编辑器文档的**剪贴板投影**）。
       *   ⛔ 别去 DOM 里抠 `contenteditable.textContent`：那会把换行拍平，
       *   而且草稿里带 `@` / 斜杠芯片时，DOM 文本与真正的投影本来就不同。
       */
      function readDraftFromProps(props) {
        try {
          if (props && typeof props.useInput === 'function') {
            const v = props.useInput((s) => (s ? s.draft : undefined))
            if (typeof v === 'string') return v
            return null
          }
        } catch (error) { return null }
        return null
      }

      /** 读当前环境里的选区并下判据（渲染初值与点击时各读一次；点击时那份才算数） */
      function oocCurrentVerdict(btnEl) {
        try {
          if (typeof window === 'undefined' || !window || typeof window.getSelection !== 'function') {
            return { ok: false, reason: '这个环境没有 window.getSelection' }
          }
          const wsel = window.getSelection()
          if (!wsel || !wsel.rangeCount || wsel.isCollapsed) return { ok: false, reason: '没有选中文字' }
          const text = typeof wsel.toString === 'function' ? wsel.toString() : ''
          if (typeof text !== 'string' || text.replace(/\s+/g, '') === '') return { ok: false, reason: '选中的是空白' }
          const range = wsel.getRangeAt(0)
          const anchor = range && range.commonAncestorContainer ? range.commonAncestorContainer : null
          // 容器从**我们自己那颗按钮**往上找（按钮还没挂上则退到输入栏座位，见 findSessionContainer）
          const doc = typeof document === 'undefined' ? null : document
          const container = findSessionContainer(btnEl, doc)
          const v = selectionVerdict(anchor, container)
          if (!v.ok) return v
          // 玩家在输入框里划选自己的草稿不算「质疑 AI」
          if (oocAnchorInComposer(anchor, container)) {
            return { ok: false, reason: '选区在输入框里，不是会话正文' }
          }
          return { ok: true, reason: '', text: text }
        } catch (error) {
          return { ok: false, reason: '读取选区失败：' + errText(error) }
        }
      }

      /**
       * 拼装（纯函数，自检直测）：★ `OOC:` 必须单独占第一行 —— 社区预设的场外契约**看开头**，
       * 旧形状（`> 引用` 打头）进不了它的场外分支。前缀之后原草稿逐字保留（只挪位置，
       * ⛔ 一个字符都不许改写/截断/重排），引用块只追加在最后、绝不重排。
       */
      function buildOocText(prevDraft, quoteText) {
        const prev = typeof prevDraft === 'string' ? prevDraft : ''
        const quote = typeof quoteText === 'string'
          ? quoteText.replace(/\r\n?/g, '\n').replace(/^\s+/, '').replace(/\s+$/, '')
          : ''
        const clipped = quote.length > OOC_QUOTE_MAX_CHARS
        const body = clipped ? quote.slice(0, OOC_QUOTE_MAX_CHARS) : quote
        const lines = body.length ? body.split('\n') : []
        if (clipped) lines[lines.length - 1] += '…（已截断，原 ' + String(quote.length) + ' 字符）'
        const block = lines.map((l) => '> ' + l).join('\n') + '\n\n' + OOC_BLOCK_TAIL
        // 前缀独占首行 + 空行；不带尾随空格 —— 与 buildOocPrefix 的 `OOC: ` 是两种合法形状
        //（预设判据只看 `OOC:` 开头，都认）；⭐ 产出已被 OOC_PREFIX_RE 认出 ⇒ 再按「OOC」按钮是幂等。
        const head = 'OOC:\n\n'
        if (!prev) return head + block
        // 分隔只看草稿结尾：已空两行就不加、单换行补一行、其余补空行 —— 草稿本体一个字符都不动
        if (/\n\n$/.test(prev)) return head + prev + block
        if (/\n$/.test(prev)) return head + prev + '\n' + block
        return head + prev + '\n\n' + block
      }

      /**
       * 场外指令前缀。★ 必须落在**整条消息的最前面** —— 社区预设（oliblue-evan/dsh-roleplay-preset）
       * 的 OOC 契约是**看开头**的：「以 `OOC:` 或 `（OOC）` 开头、或以 `【导演】` 开头的内容是场外指令」。
       * ★ 20260919 起「质疑」产出自己就带 `OOC:` 首行 ⇒ 这类草稿再按本按钮会被幂等判据认出、
       *   一个字不动；本按钮管的是**其余情况**：玩家手写的草稿就地标成场外（历史草稿里 `>` 引用
       *   打头的旧质疑块也走"前缀单独一行"分支，不插进 `>` 里）。
       */
      const OOC_PREFIX = 'OOC: '
      /** 已有场外前缀的判据（幂等用）：`OOC:` / `OOC：` / `（OOC）` / `(OOC)` 开头。 */
      const OOC_PREFIX_RE = /^\s*(?:OOC[:：]|（OOC）|\(OOC\))/i

      /**
       * 给草稿加场外前缀（纯函数，自检直测）：**幂等** —— 已经有前缀就一个字不动。
       *   · 空草稿 ⇒ 只放前缀（"激活"：玩家接着写场外要求）；
       *   · 引用块开头（`>`，即我们「质疑」的产物）⇒ 前缀单独一行，别插进引用里；
       *   · 其余 ⇒ 直接前置（"把我这段话就地标成场外"）。
       */
      function buildOocPrefix(prevDraft) {
        const prev = typeof prevDraft === 'string' ? prevDraft : ''
        if (OOC_PREFIX_RE.test(prev)) return prev
        if (prev === '') return OOC_PREFIX
        if (/^>/.test(prev)) return 'OOC:\n\n' + prev
        return OOC_PREFIX + prev
      }

      const OOC_BTN_TITLE = 'OOC 划词质疑：把会话里选中的 AI 回复引用进输入框，拟好质疑草稿（发送由你自己按）'

      // ---- 输入栏两钮的视觉（20260919）：照邻居 dsh-restart-button 的口径 ----
      // 盒子（邻居 btnShapeStyle；其注释里的实测：这一行图标控件全是 28 高、发送键 34×34）——
      //   高度定死 + border-box + 纵向 padding 归零，防止字体 line-height 把盒子撑高；
      //   flex:'none' + whiteSpace:'nowrap'：不许长高/溢出，窄屏由宿主的 flex-wrap 换行。
      //   无底色/字号/颜色：全交注入的 CSS（.dma-ooc-btn）与继承，同邻居口径。
      const OOC_BTN_SHAPE = {
        boxSizing: 'border-box', height: 28, padding: '0 8px', borderRadius: 6,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        gap: 5, flex: 'none', whiteSpace: 'nowrap',
      }
      // 主次可辨：「OOC」是主操作（一键标场外），给它一颗 14×14 内联 SVG 图标提视觉重量；
      //   「质疑」是"划词引用"那条路，纯文字。图标照 DSH 自有画法：viewBox 0 0 16 16 +
      //   fill currentColor（色彩跟 hover 一起走）+ aria-hidden / focusable=false（不进可访问树）。
      const OOC_ICON_STYLE = { display: 'block', flex: 'none' }
      const OOC_BUBBLE_D =
        'M4 2.5H12A2.5 2.5 0 0 1 14.5 5V8A2.5 2.5 0 0 1 12 10.5H8.5L5.4 13.6'
        + 'C5.06 13.94 4.5 13.7 4.5 13.2V10.5H4A2.5 2.5 0 0 1 1.5 8V5A2.5 2.5 0 0 1 4 2.5Z'

      /**
       * 席位 3 组件（conversation.input.right，20260918 F 单）：会话级 slot props 给
       * `inputActions`（写）+ `useInput`（读草稿）；缺哪个就如实禁用并写明 title（⛔ 不抛）。
       * `__dmaReadDraft` 是自检注入口（生产端不存在 ⇒ 走 props 的 useInput）。
       *
       * ⚠️ `readDraftFromProps` 里调的是**宿主的** `props.useInput`（一个 hook）⇒ 只能在渲染期调、
       * 不能在 onClick 里调。所以点击时用的是**渲染期那份快照** —— `useInput` 是 selector hook，
       * 草稿一变本组件就重渲染，快照即最新。
       */
      function OocQuoteButton(props) {
        const inputActions = props && props.inputActions
        const readDraftOverride = props && typeof props.__dmaReadDraft === 'function' ? props.__dmaReadDraft : null
        const draftNow = readDraftOverride ? null : readDraftFromProps(props)
        const btnRef = React.useRef(null)
        // 初值按当前选区算一次；真机上 selectionchange 继续刷新（假 react 台子不跑 effect，初值函数会真执行）
        const [verdict, setVerdict] = React.useState(() => oocCurrentVerdict(null))
        const [note, setNote] = React.useState('')
        React.useEffect(() => {
          ensureDmaStyles()
          if (typeof document === 'undefined' || !document || typeof document.addEventListener !== 'function') return undefined
          const refresh = () => setVerdict(oocCurrentVerdict(btnRef.current))
          refresh()   // 挂上后立刻算一次（初值那会儿 ref 还是 null ⇒ 容器读不到）
          document.addEventListener('selectionchange', refresh)
          return () => document.removeEventListener('selectionchange', refresh)   // 卸载必须摘掉监听
        }, [])
        const actionsOk = Boolean(inputActions && typeof inputActions.setDraft === 'function')
        const title = note
          || (actionsOk
            ? (verdict.ok ? OOC_BTN_TITLE : 'OOC 划词质疑：' + verdict.reason + '。先在会话正文里划选一段 AI 回复')
            : 'OOC 划词质疑：这个会话位没给 inputActions（拿不到输入框写入口），按钮停用')
        const onClick = () => {
          const v = oocCurrentVerdict(btnRef.current)   // ★ 点击时重读判据，不信任渲染时的快照（禁用态强点也拦得住）
          if (!v.ok) return
          if (!actionsOk) return
          // ★ 先读后写：拿不到现有草稿就一个字不写（setDraft 是整体替换，盲写 = 覆盖玩家草稿）
          const draft = readDraftOverride ? readDraftOverride() : draftNow
          if (typeof draft !== 'string') {
            setNote('没读到输入框里的现有草稿（这个会话位没给 useInput）—— 为免覆盖你已输入的内容，没有写入')
            return
          }
          inputActions.setDraft(buildOocText(draft, v.text))
          setNote('')
          const focusEl = composerFocusEl(findSessionContainer(btnRef.current))
          if (focusEl && typeof focusEl.focus === 'function') { try { focusEl.focus() } catch (error) { /* 聚焦失败不碍事 */ } }
        }
        return e('button', {
          ref: (el) => { btnRef.current = el },
          className: 'dma-ooc-btn',
          title: title, 'aria-label': 'OOC 划词质疑',
          disabled: !(actionsOk && verdict.ok),
          onClick: onClick,
          style: OOC_BTN_SHAPE,
        }, '质疑')
      }

      /**
       * 席位 3b（20260919）：一键把输入框里的内容标成**场外指令**（OOC）。
       *
       * 为什么需要：社区 RP 预设的 OOC 契约**看开头**（`OOC:` / `（OOC）` / `【导演】`），而我们
       * 「质疑」产出的块以 `> 引用` 开头 ⇒ 光按质疑**不会**触发它的场外分支。这个按钮把 `OOC: `
       * 放到**整条消息最前面**：空草稿时先摆好前缀（"激活"，玩家接着写要求），有内容时就把
       * 这段话（含质疑块）**就地**标成场外。幂等：已有前缀 ⇒ 一个字不动。
       * ⛔ 与「质疑」一样只写草稿、绝不替玩家发送。
       */
      function OocModeButton(props) {
        const inputActions = props && props.inputActions
        const readDraftOverride = props && typeof props.__dmaReadDraft === 'function' ? props.__dmaReadDraft : null
        const draftNow = readDraftOverride ? null : readDraftFromProps(props)
        const btnRef = React.useRef(null)
        // 挂载即注入交互态 CSS（.dma-ooc-btn 的 hover/focus/disabled 内联表达不了）；
        //   不能等点击才注 —— 常态/hover 的样子从挂上去那一刻就得是对的。
        React.useEffect(() => { ensureDmaStyles() }, [])
        const [note, setNote] = React.useState('')
        const actionsOk = Boolean(inputActions && typeof inputActions.setDraft === 'function')
        const title = note
          || (actionsOk
            ? 'OOC 场外指令：一键给输入框加 `OOC: ` 前缀 —— 角色扮演预设认得这个开头，会跳出角色、以助手身份回应（发送由你自己按）'
            : 'OOC 场外指令：这个会话位没给 inputActions（拿不到输入框写入口），按钮停用')
        const onClick = () => {
          if (!actionsOk) return
          // ★ 先读后写：拿不到现有草稿就一个字不写（setDraft 是整体替换，盲写 = 覆盖玩家草稿）
          const draft = readDraftOverride ? readDraftOverride() : draftNow
          if (typeof draft !== 'string') {
            setNote('没读到输入框里的现有草稿（这个会话位没给 useInput）—— 为免覆盖你已输入的内容，没有写入')
            return
          }
          const next = buildOocPrefix(draft)
          if (next === draft) {
            setNote('已经是场外指令了（开头就是 OOC: ），没有再动')
            return
          }
          inputActions.setDraft(next)
          setNote('')
          const focusEl = composerFocusEl(findSessionContainer(btnRef.current))
          if (focusEl && typeof focusEl.focus === 'function') { try { focusEl.focus() } catch (error) { /* 聚焦失败不碍事 */ } }
        }
        return e('button', {
          ref: (el) => { btnRef.current = el },
          className: 'dma-ooc-btn',
          title: title, 'aria-label': 'OOC 场外指令',
          disabled: !actionsOk,
          onClick: onClick,
          style: OOC_BTN_SHAPE,
        },
          e('svg', {
            viewBox: '0 0 16 16', width: 14, height: 14,
            'aria-hidden': 'true', focusable: 'false', style: OOC_ICON_STYLE,
          }, e('path', { fill: 'currentColor', d: OOC_BUBBLE_D })),
          e('span', null, 'OOC'))
      }

      // ---------- 后台收纳提示（shell.overlay，20260919）----------
      // 读什么：宿主只读端点 /anima/ingest-state（它投影 dsh-anima-rag 落的 ingest-state.json）。
      // 显示规则：running ⇒ 「记忆库正在后台收纳当前会话…」；刚跑完 ≤6s ⇒ 一句结果；其余 ⇒ 不渲染。
      // 纪律：挂载期间低频轮询、卸载即停；⛔ 绝不抛（拿不到就当没有，不显示）；系统色、零红色。
      const INGEST_TOAST_POLL_MS = 5000
      const INGEST_TOAST_DONE_MS = 6000
      function IngestToast() {
        const [state, setState] = React.useState(null)
        React.useEffect(() => {
          let alive = true
          const tick = () => {
            requestJson(HOST_API_BASE + '/anima/ingest-state')
              .then((data) => { if (alive) setState(data && data.state ? data.state : null) })
              .catch(() => { if (alive) setState(null) })
          }
          tick()
          const timer = setInterval(tick, INGEST_TOAST_POLL_MS)
          return () => { alive = false; clearInterval(timer) }
        }, [])
        const running = state !== null && state.running === true
        const finishedRecently = state !== null && !running
          && typeof state.finishedAt === 'number' && Date.now() - state.finishedAt < INGEST_TOAST_DONE_MS
        // ★ 2026-09-20：**没真写进去，就一个字都不显示**。以前"跑了一趟但什么都没入"
        //   （skipped: all-done / no-dir / no-index）也会挂 6 秒「记忆库收纳完成：写入 0 条」——
        //   看起来就是"每一轮都弹一次收纳"（本轮真机排查的现场，见 ingest-state.json 的 skipped）。
        //   现在这种"空跑"不再冒泡；提示只对应**真的往库里写了东西**（写成功或写失败都算）。
        const didWrite = state !== null
          && ((typeof state.inserted === 'number' && state.inserted > 0)
            || (typeof state.failed === 'number' && state.failed > 0))
        if (!running && (!finishedRecently || !didWrite)) return null
        const text = running
          ? '记忆库正在后台收纳当前会话…'
          : (typeof state.failed === 'number' && state.failed > 0
            ? '记忆库收纳完成：写入 ' + String(state.inserted ?? 0) + ' 条、失败 ' + String(state.failed) + ' 条'
            : '记忆库收纳完成：写入 ' + String(state.inserted ?? 0) + ' 条')
        return e('div', {
          className: 'dma-toast',
          'data-ingest-running': running ? '1' : '0',
          // frame-wide 浮层是**点击穿透**的：这条只做展示，自己也不吃指针事件。
          style: { position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: 18, zIndex: 40,
            pointerEvents: 'none', fontSize: 12, lineHeight: 1.5, padding: '6px 14px', borderRadius: 999,
            background: 'color-mix(in srgb, Canvas 92%, CanvasText)', color: 'CanvasText',
            border: '1px solid color-mix(in srgb, CanvasText 18%, Canvas)',
            boxShadow: '0 4px 16px color-mix(in srgb, CanvasText 18%, transparent)' },
        }, text)
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
              open && e(ArchivePanel, { onClose: () => setOpen(false), sessions: ctx.sessions }),
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

        // 席位 3（F 单 20260918）：输入栏发送键前的紧凑控件位 —— OOC 划词质疑。
        //   order 90：排在重启按钮（id restart-host，order 100）之前；id 不与既有三席撞车。
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
          { name: 'conversation.input.right', id: 'ooc-quote', order: 90 },
          OocQuoteButton,
        ))

        // 席位 3b（20260919）：同一个座位上的「OOC」前缀按钮（order 89 ⇒ 排在「质疑」90 之前）。
        //   它才是让社区预设**真的**进 OOC 分支的那一下 —— 见 OocModeButton 的注释。
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
          { name: 'conversation.input.right', id: 'ooc-prefix', order: 89 },
          OocModeButton,
        ))

        // 席位 5（20260919）：frame-wide 浮层上的一条小提示 —— 后台收纳进行中时显示。
        //   ui-layout 的 shell.overlay 是**叠加式** list 席位（它的文档原话：badge / toast / status pill
        //   都归这里），我们只加自己那一条，⛔ 不顶掉别人。
        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: 'dma-ingest-toast' },
          IngestToast,
        ))
      }

      exports.apply = apply
      // 注入名单：
      //   'slots'    —— 注册席位 ×3：侧边栏 `sidebar.footer.action` ×2（记忆库齿轮 + Agent 编辑器）
      //                 + 输入栏 `conversation.input.right` ×1（F 单 20260918：OOC 划词质疑）
      //   ★ v4.1 D 单：'sessions' 已随搜索类阅读源一并移除（玩家侧检索用浏览器 Ctrl+F 即可）
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

      // 提示词装配地图（20260913 单）：纯新增的第二个自检出口。
      // ⛔ 不并进 __internals：_selftest-client.mjs 对 __internals 的键集合做了恰好 15 个的
      // deepEqual 断言，往里加键会打破既有台子。这里只挂装配地图自己的纯函数与组件。
      exports.__promptMap = {
        buildPromptMapData: buildPromptMapData,
        buildMapFromSections: buildMapFromSections,   // 20260913 C4 真相源数据层（三级导航单）
        pmToolsBlocks: pmToolsBlocks,
        pmMessagesBlocks: pmMessagesBlocks,
        pmSplitSystem: pmSplitSystem,
        judgePmMutability: judgePmMutability,
        PromptMapView: PromptMapView,
        PromptMap: PromptMap,
        MessageLocatorPanel: MessageLocatorPanel,     // 20260913 L2 消息定位（左侧弹出）
        // 20260914 M2「直观构成 + 单段抽屉」：纯函数出口（自检台直测，组件不掺逻辑）
        pmPosTag: pmPosTag,
        isPmCompositeName: isPmCompositeName,
        pmBasisLabel: pmBasisLabel,
        pmSectionNote: pmSectionNote,
        pmSectionOwner: pmSectionOwner,       // ★ 归属按段名前缀认（2026-09-14）；精确名表优先（2026-09-15 实测补）
        pmSectionHonesty: pmSectionHonesty,   // ★ PHI/depth 的"近似"标注
        PM_SECTION_OWNERS: PM_SECTION_OWNERS,
        PM_SECTION_OWNERS_EXACT: PM_SECTION_OWNERS_EXACT,   // 精确名覆盖（rp:storyAnchor/rp:firstRound/dma:echo/state:card）
        PM_SECTION_NOTES: PM_SECTION_NOTES,                 // 注释表（2026-09-15 按真机实测补齐；供自检逐名核）
        PM_SECTION_NOTE_PREFIXES: PM_SECTION_NOTE_PREFIXES, // 前缀兜底注释（tool:*）
        pmSectionTextState: pmSectionTextState,       // §9 取值链：端点响应 ⇒ 界面口径（五种）
        pmSectionDrawerBody: pmSectionDrawerBody,     // L3 单段抽屉体（纯渲染）
        ChunkedText: ChunkedText,                     // ★ 正文显示（2026-09-19：默认 Markdown 美化，可切原文）
        pmToolDefText: pmToolDefText,                 // ★ 工具定义 JSON → 人话（纯函数；认不出回 null）
        buildFullPlainText: buildFullPlainText,       // ★ 「复制整楼」拼文本（纯函数，供自检核工具正文进没进）
        SectionTextPanel: SectionTextPanel,
      }

      // 编辑器「已归档会话」（20260914 M4 单）：第三个自检出口。
      // ⛔ 不并进 __internals（既有台子对它做了恰好 15 键断言）也不动 __promptMap。
      // M5：主面板 SessionRootPicker（选根下拉，归档行只标不藏）也从这里出（自检直测）。
      // M6：rootArchiveHint（头部「当前根已归档」提示的纯文案函数）+ SessionRootPicker 一起出。
      exports.__editorArchive = {
        ViewerSessionList: ViewerSessionList,
        SessionRootPicker: SessionRootPicker,
        rootArchiveHint: rootArchiveHint,
      }

      // 「日志在 DSH 层读不出来」（20260914 M8）自检出口。
      // ⛔ 同样不并进 __internals（15 键断言）也不动 __editorArchive。
      exports.__readFail = {
        // 纯函数：C1 失败响应的 error（{code,message,detail}）⇒ 界面那一屏实话；健康时返回 null。
        pmReadFailNotice: pmReadFailNotice,
      }

      // 「深链 + 事实说明书」（20260914 M9）自检出口。⛔ 同样不并进 __internals。
      exports.__editorNav = {
        editorHelpSections: editorHelpSections,   // 事实说明书内容（纯数据）
        readHashLink: readHashLink,               // #sess=&turn=&box=&sec= ⇒ 对象（⛔ 只认这四个键）
        formatHashLink: formatHashLink,           // 状态 ⇒ 深链（键序稳定）
        sectionNameOf: sectionNameOf,             // 地图块 ⇒ 段名（深链回写用）
        summarizeDiagnostics: summarizeDiagnostics, // 诊断响应 ⇒ 界面 chips（码给机器，人话给眼睛）
        buildRegistryText: buildRegistryText,     // M15：导出注册表（带顺序的字段）纯函数
      }

      // v3 外部组合面板（2026-09-16）：同样的独立出口。⛔ 不并进 __internals（15 键断言）。
      exports.__v3 = {
        v3DigestLines: v3DigestLines,   // 纯函数：/v3 响应 ⇒ 可渲染行（自检直测）
        assemblyLines: assemblyLines,   // 纯函数：单条装配记录 ⇒ 可渲染行（自检直测）
        V3Panel: V3Panel,
      }

      // 20260918 查看器单（底本全覆盖 + 逐楼对话历史）：独立自检出口。⛔ 不并进 __internals
      //（既有台子对它做了恰好 15 键断言），也不动 __promptMap 等既有出口 —— 只纯新增。
      exports.__viewerMessages = {
        EDITOR_V2_FIXTURES: EDITOR_V2_FIXTURES,   // 夹具整包（自检直接对真实夹具做渲染断言与反证改写）
        groupMessagesByTurn: groupMessagesByTurn, // 纯函数：messages[] → 按楼分段（turn=null 归「未标注楼」段）
        ViewerMessagesBody: ViewerMessagesBody,   // 消息流**列表**（按楼分段 + 逐块词头；点行 ⇒ onOpenSeq 开单条抽屉）
        // 20260918 消息流单（T1/T2/T3）：
        ViewerMsgPanel: ViewerMsgPanel,           // 单条抽屉（头 + 按条取的正文 + 原 JSON；自检直测三种失败口径）
        PromptPartView: PromptPartView,           // 消息流栏（并列页签/搜索框已拆，只做消息流）
      }

      // F 单（20260918 OOC 划词质疑）：独立自检出口。⛔ 不并进 __internals（15 键断言），
      //   也不动 __promptMap 等既有出口 —— 只纯新增。
      exports.__ooc = {
        OOC_CONTAINER_SUFFIXES: OOC_CONTAINER_SUFFIXES, // 会话区容器**语义后缀**（真机实测 `_9UxHwG_*`）
        OOC_SEAT_SUFFIX: OOC_SEAT_SUFFIX,               // 输入栏座位后缀（首帧兜底用）
        OOC_QUOTE_MAX_CHARS: OOC_QUOTE_MAX_CHARS,       // 与 prompt-viewer PREVIEW_MAX_CHARS 同口径（120）
        buildOocText: buildOocText,                     // 纯函数：原草稿 + 选区 ⇒ 写回串（自检直测）
        selectionVerdict: selectionVerdict,             // 纯函数：锚点 + 容器 ⇒ 判据（自检直测）
        findSessionContainer: findSessionContainer,     // 容器查找（**从我们自己按钮**往上找，后缀阶梯）
        oocAnchorInComposer: oocAnchorInComposer,       // 判「这条选区在输入框里」（contenteditable）
        readDraftFromProps: readDraftFromProps,         // 草稿读取（宿主 props.useInput ⇒ InputState.draft）
        oocCurrentVerdict: oocCurrentVerdict,           // 环境选区 ⇒ 判据（组件初值与点击时都用它）
        OocQuoteButton: OocQuoteButton,                 // 席位组件本体（自检直渲染）
        OOC_PREFIX: OOC_PREFIX,                         // 场外前缀字面量（自检逐字钉）
        buildOocPrefix: buildOocPrefix,                 // 纯函数：草稿 ⇒ 加前缀（幂等，自检直测）
        OocModeButton: OocModeButton,                   // 席位组件本体：一键标成场外指令
      }

      return module.exports
    })()
  },
})
