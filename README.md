# dsh-memory-archive · 记忆库

> **不发明记忆，只把 DSH 已经压掉的东西重新变得「取得到」。**

DSH 的[上下文压缩](https://github.com/deepseek-ai/deepseek-harness)（`compaction-basic`）本来就在把旧内容折叠出模型可见面。
本插件**不重写压缩、不重写摘要、不建第二份存储、不改 DSH 本体一行**，只补三件事：

1. **取用** —— 被折叠的内容**一直都在会话日志里**，缺的是一个够得着的入口（面板 / 检索 / 每轮注入）；
2. **如实标注** —— 每条内容标明它此刻是 `current`（还在模型可见面）/ `shadowed`（**已被压出上下文**）/ `log-only`（本来就不上面）；
3. **RP 的那一小套** —— 剧情笔记写入、最近几楼、第一轮保留、角色卡后处理指令、RP 专用压缩后端与压缩后收纳。

配套的两个独立插件（都是**可选**的，本仓库**不含**它们的代码）：
[`pmp-dsh-tavern`](https://github.com/Player-MINEPIG/dsh-tavern)（角色卡 / 世界书 / 周目 / ST 预设）与
[`dsh-anima-rag`](https://github.com/vv5v5/dsh-anima-rag)（向量 + BM25 检索、回响、向量面板那半边）。

---

## 它现在能干什么（如实标注）

| 能力 | 状态 |
|---|---|
| **记忆库面板**：摘要 / 原文 / 剧情大纲 / **向量** 四档 + 设置 | ✅ |
| **提示词查看器**：每次模型请求**真正发出**的全文（system 段地图、段级偏移、点开看该段正文、消息流） | ✅ |
| **剧情笔记写入**：`memory_write` 工具，写进本会话周目的 `.roleplay-memory/`（⛔ 只写周目目录） | ✅ |
| **预部署资料**：把要预置的文件放进**工作区根** `.roleplay-memory/` ⇒ 新周目开局就**读得到**（只读、所有周目共享；见下） | ✅ |
| **每轮注入**：`mt:memoryProtocol` · `mt:memoryHome` · `rp:firstRound` · `mt:lastFloors` | ✅ |
| **角色卡后处理指令**（PHI）：从 system 段挪成「玩家消息之后」的一条 user 消息（默认开） | ✅ |
| **RP 压缩后端**：中文归档指令（`mt-compaction-rp.js`，由本仓库生成、挂进预设目录）；★ 2026-09-22 起是**三档回退梯子**（R1 现状形状 → R2 每条消息都带 `source` → R3 官方形状），**谁赢的落一行**到 `compaction-failures.log` | ✅ |
| **压缩后自动收纳** + 孤儿清理（摘要进库、账本防重、被删切片的对账与隔离）；★ 2026-09-22 起入口判据 = **会话优先**（**这条会话自己解析出的周目** == 面板绑定的目标周目 ⇒ 才收；一路「从这里继续」续接出来的会话照收，认不出周目 / 属于另一个周目的仍拒） | ✅ |
| **OOC 两席**：输入栏的「OOC」前缀按钮 + 划词「质疑」 | ✅ |
| **一个 skill**：`rp-assistant`（带三份可查资料，见下） | ✅ |
| **自带的 RP 预设**：`preset/`（组装 + 模块 + 压缩后端），`node preset/install.mjs --apply` 铺到预设目录 | ✅ 可选，随包发布；模块**从本仓现场取** ⇒ 预设与插件不各自漂移 |
| **两种根**：会话模式（**零依赖**）/ 工作区模式（需 `pmp-dsh-tavern`） | ✅ |
| **预设生成 / 写入面**（detect · apply · rollback · provision · backups · pack） | ⛔ **已退役**（2026-09-19 用户口径：「不用保持了」）—— 预设目录现在**自己维护**，本插件不再替你改 |
| **状态子系统**（`state-bridge` 子包 + `state:card` 段 + 5 个状态工具） | ⛔ **已剥离**（2026-09-20）—— 状态改由**周目笔记 `state.md`** 承载，模型按文件开头写的要求自己维护 |

---

## 安装

```sh
# 从 GitHub
dsh plugin --profile <你的 profile 名> add github:vv5v5/dsh-memory-archive

# 或本地目录（开发用）
dsh plugin --profile <你的 profile 名> add ./dsh-memory-archive
```

装完**重启一次宿主**：浏览器半侧的 bundle 是宿主启动时组装的。

### 附带的 RP 预设（可选）

本包**自带一份**「角色扮演」预设（`preset/`：组装文件 + 几个模块 + RP 专用压缩后端）。
**它的描述里写明「由 dsh-memory-archive 提供」** —— 预设列表里**同名**的那份是社区预设，认描述就能分开。
它不会自动生效（DSH 的预设是文件系统型的），要铺一次：

```bash
node <profile>/node_modules/dsh-memory-archive/preset/install.mjs          # dry-run：先看会写什么
node <profile>/node_modules/dsh-memory-archive/preset/install.mjs --apply  # 真写（默认 roleplay 目录）
```

细节、依赖与限制见 [`preset/README.md`](preset/README.md)。

> 本包**没有构建步骤** —— `lib/` 里就是可直接运行的 JS（`react` 由 DSH 平台的模块 seed 表提供）。

### 依赖

| 功能 | 依赖 |
|---|---|
| 记忆库（会话模式）/ 提示词查看器 / 工具与注入 | **零依赖** —— 原版 DSH 纯净环境即可用 |
| 工作区模式、剧情笔记目录、剧情大纲、向量页签的体检行 | 需要 [`pmp-dsh-tavern`](https://github.com/Player-MINEPIG/dsh-tavern)（**可选**，未装时相关入口置灰并说明原因） |
| 检索注入（`anima:memory`）、回响、向量页签的动作 | 需要 [`dsh-anima-rag`](https://github.com/vv5v5/dsh-anima-rag)（**可选**） |

两者在 `package.json` 里都是 **optional peer**，不会被强制安装。

---

## 两种根模式

记忆库要能在两种环境里用，而它们的「根」根本不是同一种东西 —— 所以**根是一个可切换的模式**：

| | **会话模式**（默认） | **工作区模式** |
|---|---|---|
| 根 | 一条**手动选定**的 DSH 会话 | Tavern 工作区里某个周目的 `archive/` |
| 数据来源 | DSH 自己的会话事件日志（**精确读**，不触发索引重建） | 归档文件（`floors/` `summaries/` `.roleplay-memory/`） |
| 能看到 | 该会话的**全部**事件，含**已被压缩出上下文**的那些 | 归档契约覆盖的那些：原文 / 摘要 / 剧情笔记 |
| 依赖 | 无 | `pmp-dsh-tavern` |

**「手动选择」是刻意的** —— 「哪条会话算记忆」是用户的语义判断，不做自动推断。

---

## 面板

侧边栏底部两个入口：**记忆库**（齿轮）与 **Agent 编辑器**（只读检视组装）。输入栏里还有两席（OOC）。

### 记忆库 → 五档 + 设置

- **摘要** —— 按楼序拼接成长文，从头读到尾；
- **原文** —— 按需懒加载：每条的 `surface` 如实标记（`current` / **`shadowed`** / `log-only`），未发给模型的楼层如实标注；
- **剧情大纲** —— 本会话周目 `.roleplay-memory/` 里的笔记（`index.md` / `state.md` / `characters.md` / `world.md` …），**内容需手动确认才展开**；展开后**两处落点各一行**（本会话周目目录 / 跨周目共用那份），各自标「在 · N 份」或「还没有」，并各带一个按钮：`打开文件夹` / `创建并打开`（周目目录还没建 ⇒ 先建再开）/ `打开工作区根`（共用那份还没建 ⇒ 打开工作区根让你自己放，⛔ 我们不替社区预设建目录）；
- **向量** —— 本库（`dsh-memory`）的体检行 + 两行库（向量 / BM25，各带 `⚠缺失` / 重建 / 删除）+ 一个「参与检索」开关；动作走一张**请求单**，由 `dsh-anima-rag` 在该周目会话的下一轮开始前执行，回执写回来（`lib/vector-panel.js`）；
- **压缩** —— **自动压缩触发阈值控制面板**（2026-09-21；会话模式也与「会话事件」并列，因为它读的是本会话的实时数，不依赖 Tavern 归档）。三块：**实时读数**（每 4 秒现读宿主，面板关掉就停）——
  主行「当前 42%」= **DSH 自带的那个上下文百分比**（`contextPressure` 投影，prompt 侧压力，不含输出 token）；
  副行「触发判定 47%（含输出 token）」= **真正被拿去比阈值的那个数**（`tokenMeter.measure(session).totalTokens`）；
  第三行「窗口 128k · 预设阈值 15% · 阈值 19200 token」。**两个数不是同一个分子**，所以并排显示；
  **控件**（滑块 5–90 步 5 + 数字框互相同步 + 「用面板的阈值」开关 + 保存）；
  **如实说明**三条（逐字：`改完之后立刻生效。` / `触发阈值是估算的，因为输出token也参与计算，因此触发会略早于设置值。` / `另外如果上下文超限，会无视阈值强制压缩。`）。
  读不到 ⇒ 红字「读不到（原因）」，⛔ 不用 0% 冒充。阈值保存走 `POST /compaction/config`：**同时**写
  `config.json` 与**部署的预设 YAML** 的 `thresholdRatio`（先数出现次数、≠1 就拒绝改、改前备份 `.bak-<时间戳>`、写后回读校验），两件事**各自如实**回报；
- **设置** —— 根模式与根选择、**向量检索 API**（向量模型与重排模型**各一套**「接口地址 / 模型名 / 密钥」，两个密钥都只写不读、可各自清空）、提示词模板（压缩指令 / 收纳占位）、各项开关。

会话、周目、角色都显示**真名**而不是 id；三级回退（`title` → 周目反查 → 8 位截断 id）各级**如实标注来源**，
**任何情况下都不显示完整 UUID**。

### Agent 编辑器（只读）

当前会话所用 preset 的段 / 插件 / order 清单（每项一句「谁注入 · order · 作用」）、段级偏移、
**「面板值 vs preset 实际值是否一致」**（不一致就明说「面板改了也不会生效」）。v5 起**零写入**，连备份目录都不建。

---

## 每轮往提示词里注了什么（RP）

★ **口径：会话优先，认不出来的会话当新会话**（2026-09-20）。「哪个周目」按**这个会话**在 Tavern
`catalog.json`/`timeline.json` 里归入的那个算；**认不出**（新开的会话还没被 Tavern 认领 / 不是 Tavern 的会话）
⇒ **没有周目**：下面凡是要"某个周目"的，一律**不注入**，`memory_write` 也**直接报错**。
会话若同时被两个周目引用 ⇒ 判给**它是 `rootSessionId` 的那个**（顺序无关）；两个都不是根才按 catalog 顺序。
面板里那个「工作区根」只是**查看用的视图**（手动选根看别的周目照旧），⛔ 不决定注入写哪儿。
顶栏会并排显示两件事：`当前根：…`（视图）+ `本会话：…`（生效；未归入时是红字）。

★ **预部署（新周目开局就带上下文）**：把要预置的文件（角色设定 / 世界书 / 写作规矩一类）放进
**工作区根**下的 `<工作区根>/.roleplay-memory/` —— `<memoryHome>` 段会把它列出来（**只读**），
模型开局就读得到；⛔ 它不是写的地方（各周目的笔记仍只写自己周目目录，免得串味）。
为什么只能提前放到这儿：周目目录名里带**新建时才知道的 UUID**（`playthrough-<uuid>`）。

| 段名 | 作用 | 开关（插件 `config.json`） |
|---|---|---|
| `mt:memoryProtocol` | 告诉模型**什么时候**该主动去检索历史 | 常开 |
| `mt:memoryHome` | 告诉模型剧情笔记**写在哪个目录** | 常开 |
| `rp:firstRound` | 把**第一轮原文**钉住（每轮在场、永不进可压区间） | `keepFirstRound.enabled` |
| `mt:lastFloors` | 本会话上下文还短时，把**本档案最近几楼的原文**当历史喂进去 | `lastFloors.enabled` · `count` · `maxChars` |
| `anima:memory` | 检索到的历史（`<recalledMemories>` + `<immediateHistory>`）—— **由 `dsh-anima-rag` 填** | 见那个插件 |
| （PHI） | 角色卡的**后处理指令**：从 system 段挪成玩家消息之后的 user 消息 | `phiAsMessage.enabled`，默认**开** |

★ PHI 是唯一一处**故意写进会话历史**的注入（其余全走「不写历史」的缝）：因为 DSH 的 system 段无法实现文末注入，
只能拿 user 消息模拟。代价是它在每轮之间会积累 ⇒ 提示词查看器里**标红显示**、**不计楼层**，记忆库**不收录**它。

---

## 配置存在哪

```
<DSH_HOME 或 ~/.dsh>/dsh-memory-archive/config.json
```

**权限 0600**（里面有 API 密钥）、**原子写**（临时文件 + `rename`）、**读坏不崩**（回落默认值并如实报错）。
密钥**只在本机**：不进 git、不进日志、不经任何响应体回显（宿主只回 `keySet` 与末 4 位提示）。

主要键：`rootMode` · `root` · `retrieval{url,model,key,rerankUrl,rerankModel,rerankKey,chatEnabled}` · `prompts{compaction,placeholder,compactionJailbreak}`
· `keepFirstRound` · `echo` · `lastFloors` · `memoryWrite` · `phiAsMessage` · `autoCollect` · `summarize` · `v3`。

---

## 宿主接口

全部为**同源 HTTP**，两条前缀路由在宿主启动时同步注册（`ctx.effect` 管生命周期，热重载不留野路由）：

| 前缀 | 内容 |
|---|---|
| `/dsh-memory-archive/api` | 配置读写、会话精确读、`/templates`（提示词模板）、`/sessions`、`/session/events`、`/collect/*`（收纳）、`/playthrough/*`（周目目录与打开文件夹）、`/vector/state` + `/vector/action`（向量页签）、`/retrieval/test`（向量与重排**各**发一次最小请求）、`/agent` + `/agent/card(s)`（装配只读检视与角色卡阅读）、`/sections*`（段表与正文） |
| `/dsh-memory-archive/prompt` | 提示词查看器的数据面：`/health`、`/api/sessions`、`/api/session`、`/api/part` |

拿不到的服务一律**降级并说明**（`ok:false` + 可读 `code`），⛔ 不抛、⛔ 不 500、面板不白屏。

---

## 设计要点

完整思路见 [`docs/DESIGN.zh.md`](docs/DESIGN.zh.md)。四条：

1. **能用原生机制就用原生机制** —— 「隐藏旧楼层」= surface `replace` 遮蔽，而 append-only 事件日志是真相源 ⇒ **任何遮蔽都可逆**；
2. **不建第二份存储** —— 压缩只是把内容移出**模型可见面**，没从日志或索引里删掉。缺的从来不是存储，是**取用**；
3. **注入只走「不写历史」的缝** —— 只用 `systemPrompt.section()` 与 `system-prompt/assemble` 瀑布；⛔ 不用 `systemPrompt.context()`（它是 durable user-role 快照，长对话里等于每轮追加一条）；
4. **一件事只有一个写者** —— 向量库归 `dsh-anima-rag`（面板只读状态 + 写请求单）；预设目录归用户（本插件已退役写入面）；剧情笔记归模型（走 `memory_write`）。

---

## 已知限制（如实）

| # | 限制 | 说明 |
|---|---|---|
| 1 | `surface` 可能为 `null` | 平台版本不同或读取路径降级时**如实填 null**，**绝不猜测** |
| 2 | 工作区模式依赖 `pmp-dsh-tavern` | 未安装时相关入口**置灰并说明**，不会崩溃 |
| 3 | 本插件**不生成摘要** | 摘要由**压缩**产出（RP 压缩后端写 `compaction/summary`），本插件只把它收进库 |
| 4 | 「压缩指令」保存的是**文本** | 它由**预设目录里的**压缩后端读取（`mt-compaction-rp.js`，用 `_materialize-preset-modules.mjs` 铺盘） |
| 5 | 状态不再有独立子系统 | 由周目笔记 `state.md` 承载，模型自己维护；⛔ 没有优先级更高的"状态工具" |
| 6 | 向量库的写入动作要等一轮 | 面板点动作 = 写一张请求单，由 `dsh-anima-rag` 在**下一次装配**执行（面板会显示进度与回执） |
| 7 | **未归入周目的会话什么都拿不到** | 口径如此（⛔ 不继承上一轮的绑定）：笔记路径、最近几楼、回响、检索、最近总结全停，`memory_write` 报可读错。**先在 Tavern 里给它开/选一个周目**（经 Tavern「与 X 新开周目」开的会话从一开始就有周目）。顶栏与「向量」档都会如实标出来 |

---

## 开发

```sh
npm run check   # node --check lib/index.js && node --check lib/client.js
```

- `lib/index.js` —— **宿主半侧**：配置存储 + 同源 HTTP API + 每轮注入 + 自动收纳 + skill 注册；
- `lib/client.js` —— **浏览器半侧**：工厂形式 CJS，只 `require('react')`，**无 JSX、无需构建**；
- `lib/prompt-viewer.js` —— 提示词查看器宿主半侧；
- `lib/vector-panel.js` —— 向量页签宿主半侧（读状态快照 / 写请求单）；
- `preset-modules/` —— 挂进预设目录的那几个模块的**源**（含由生成器产出的压缩后端）；
- `skill/rp-assistant/` —— 那一个 skill 的正文与资料。

改完记得：`_sync-plugin-deploy.mjs --apply`（同步到部署副本）→ 换进程重启 → 自检台全量跑一遍。

## 许可与署名

- 许可证：**Attribution-NonCommercial 4.0 International（CC BY-NC 4.0）**，SPDX 标识符 `CC-BY-NC-4.0`；
  完整法律文本与 NOTICE 见 [`LICENSE`](./LICENSE)。
- Copyright (c) 2026 dsh-memory-archive contributors

### 移植来源与署名（按上游要求保留）

| 项目 | 内容 |
|---|---|
| 原项目 | `anima-rag` |
| 原作者 | `Ellinav` |
| 原项目地址 | <https://github.com/Ellinav/anima-rag> |
| 原项目许可 | Attribution-NonCommercial 4.0 International（CC BY-NC 4.0） |
| 移植许可 | 经原作者 Ellinav 许可后移植 |

### 场景限制（移植许可的条件）

- 仅限个人学习与非商业性用途；
- 禁止闭源商用，禁止转为付费插件/服务；
- 不重新分发任何预置私域数据。

## 第三方许可与出处

- **派生自**：DeepSeek Harness 官方 `compaction-basic`（压缩指令模板取自其 `summarize` 钩子）
  —— MIT，Copyright (c) 2026 DeepSeek；本作品中该部分**保留原始 MIT 声明**。
- **移植/派生自**：[`anima-rag`](https://github.com/Ellinav/anima-rag)（作者 Ellinav）
  —— CC BY-NC 4.0；本作品随之整体以 CC BY-NC 4.0 授权。
- **互操作/致谢**（⛔ 是互操作，**不是**派生）：`pmp-dsh-tavern`、`dsh-anima-rag`
  —— 均为 MIT；本作品**不包含**它们的任何代码，只与其配合工作。
