# 角色扮演 · 记忆库版（DSH Agent 预设）

一套给 **DeepSeek Harness（dsh）** 用的角色扮演预设：**记忆库驱动**的沉浸式扮演 —— 长剧情靠「语义检索（Anima）+ 周目笔记 + RP 专用中文压缩」扛住，工具面只留扮演真正需要的那几件（技能 / 联网考据 / 提问 / 找文件 / 只读读文件），编程向工具**根本不注册**。

★ 本预设**随 [`dsh-memory-archive`](https://github.com/vv5v5/dsh-memory-archive) 一起发布**（就在这个 `preset/` 目录里）：模块与压缩后端都从**本仓库现场取**，所以预设与插件**不会各自漂移**。
预设 = 一个目录若干文件，dsh 即时识别、**不需要重启宿主**（改完开**新会话**即生效）。

## 装

1. 先把两个插件装进你正在用的那个 profile（见下节「依赖」）。
2. 再把预设铺到预设目录：

```bash
# 默认 dry-run：只打印会写什么、写到哪
node ~/.dsh/profiles/web/node_modules/dsh-memory-archive/preset/install.mjs

# 真写（已存在且内容不同的文件会先备份成 .bak-<时间戳>，⛔ 不静默覆盖）
node ~/.dsh/profiles/web/node_modules/dsh-memory-archive/preset/install.mjs --apply
```

（也可以直接 `git clone https://github.com/vv5v5/dsh-memory-archive` 后跑 `node preset/install.mjs --apply`。）

3. 在会话的预设列表里选「**角色扮演 · 记忆库版**」，开一个**新会话**。

> 目录名默认 `roleplay`（`<dshHome>/.agent-presets/roleplay/`）；想装到别的名字用 `--id=<名字>`。
> ⚠️ **如果你自己已经手写/维护着一份同名预设**：别直接把这份铺上去（`--apply` 会覆盖内容不同的文件，虽然会先备份）。换个 `--id=`，或先把你自己那份备份出来。

## 依赖

预设本身只有文本与几个模块；**记忆相关的能力来自插件**。装法都是「装进你正在用的那个 profile」—— 本预设的 `anima-rag.js` 薄壳就是按这个位置找插件的。

| 插件 | 必需？ | 它给什么 | 装到哪 / 怎么装 |
|---|---|---|---|
| [`dsh-memory-archive`](https://github.com/vv5v5/dsh-memory-archive) | **必需** | 归档与检索后端、提示词查看器、`keep-first-round` 的开关、`/v3.replaceGuard`、**本预设本身** | 装进 profile：`cd ~/.dsh/profiles/web && npm i github:vv5v5/dsh-memory-archive` |
| [`dsh-anima-rag`](https://github.com/vv5v5/dsh-anima-rag) | **必需** | Anima 式记忆检索（向量 + BM25 双轨、回响机制），每轮注入 `<recalledMemories>` | 同上：`cd ~/.dsh/profiles/web && npm i github:vv5v5/dsh-anima-rag` |
| `pmp-dsh-tavern` | 可选 | 角色卡 / 世界书 / Tavern 预设往 system 里注入那几段；RP 模式判据（`rp.active`）、只读沙箱 | 按它自己的 README 装进 profile 层（`~/.dsh/profiles/web/node_modules/`） |

- profile 目录名按你的实际部署改（`~/.dsh/profiles/<你的 profile>`）。装完**开新会话**，宿主会重新挂载。
- 另两个插件都**不在本仓库内**，本仓库只是与它们配合工作（见文末「许可与署名」）。
- ⛔ 没装 `dsh-anima-rag` 时，`agent.cordis.yml` 里 `anima-rag` 那一行会**大声报错、预设挂不上**（故意的：宁可当场看见，也不要记忆检索静默消失）。不想用它就把那一行（`id` + `name` 两行）注释掉。
- 装好后还要在**记忆库设置**里填检索服务的 key（`embed.key` / `rerank.api.key`）—— 预设里刻意留空，见「已知限制」。

## 这个预设长什么样

- **system 里注入的东西**：RP 身份句、记忆检索协议、RP persona（本预设的主体提示词）、Tavern 注入的角色卡字段与状态页、Anima 检索到的历史记忆与原文回响、被压缩洗掉后钉回来的第一轮问答。
- **工具面**：`anima_query`、`memory_write`、`skill`、`web_search`、`ask_user_question`、`glob`、`grep`、`read`（只读）。⛔ 没有 shell、没有写工具、没有子 agent —— 那些行**在这份组装里根本不存在**，不是被禁用。
- **压缩**：走官方 `compaction-basic` 的机制，但摘要是 **RP 专用**的中文归档模板（时间跨度/地点/角色/关键事件/未回收伏笔 + 结构化标签），并且活在 preset 自己的 isolate realm 里，**碰不到编程会话**。
- **记忆**：剧情笔记（`.roleplay-memory/`）由模型自己按文件开头的要求维护；被压掉的旧内容由 `dsh-memory-archive` 收进归档、由 `dsh-anima-rag` 建索引，每轮按**当前周目**检索回来。

## 文件清单（铺出来的那 11 个）

| 文件 | 作用 |
|---|---|
| `agent.cordis.yml` | 组装本体（13 行：7 个相对模块 + 5 个官方包行 + 1 个压缩组） |
| `preset.yml` | 预设的显示名与描述（会话预设列表里显示的就是它） |
| `rp-identity.js` | RP 身份句（替换掉编程向的身份段） |
| `memory-protocol.js` | 什么时候该去检索历史的协议段 |
| `rp-tool-scope.js` | 工具面收窄（只留扮演要用的） |
| `rp-suppress-host-sections.js` | 遮蔽不该出现在 RP 里的宿主段 |
| `mt-read.js` | 只读读文件（含周目目录） |
| `keep-first-round.js` | 把第一轮问答钉住（永不进可压区间） |
| `story-anchor.js` | 剧情锚点（默认**未挂载**，行是注释掉的） |
| `anima-rag.js` | ★ **薄壳**：让 `dsh-anima-rag` 那一行随预设目录走（不写死机器路径），加载时按 `DSH_HOME → profiles/*` 解析真包 |
| `mt-compaction-rp.js` | RP 专用中文压缩后端（**由本仓库生成器现场产出**，不在 git 里） |

## 已知限制（如实）

1. **本预设里一个机器路径都没有** —— 这是刻意的：`data.vectorRoot/sessionRoot/bm25Root`（Anima 数据根）与 `workspaceBase`（Tavern 工作区根）都**省略**了，省略时落在 `dsh-anima-rag` 自己的默认值上（真机核过：默认值与省略前写的**逐字相同**，所以行为零变化）。
   ⚠️ 但**默认值本身**仍是"作者机器"的位置（`…\SillyTavern\plugins\anima-rag\…` 与 `D:\apps\dsh-tarven`）—— 若你的 ST 数据 / Tavern 工作区不在那儿，**检索与入库会指向不存在的目录**。修法：在 profile 的 `cordis.patch.yml` 里配，或把 `data: {…}` / `workspaceBase: '…'` 加回 `agent.cordis.yml` 里 anima 那一行的 `config`。
2. **`dsh-anima-rag` 插件自身的默认配置里也写死了作者机器路径**（例如 `rpSelectionsFile` 的默认值是一条「盘符 + 用户名目录」的绝对路径，指向作者 DSH 目录下的 `pmp-dsh-tavern/session-selections.json`；插件注释自己写着"换机器/换工作区要改"）。该文件不存在时插件会回退到 `allowSessions`（空 = 不限制）。这一层本仓库改不了。
3. **薄壳的失败是硬的**：`anima-rag.js` 拿不到真包、或 require 失败 ⇒ 抛错、**整个 preset 挂不上**（故意的，⛔ 不静默降级）。修法见报错文本与上面「依赖」。
4. **验证到什么程度**：锚点链与 require 在本机真实环境实测过；**宿主加载那一步也验过了** —— 把本预设装进一台**全新 DSH_HOME**（两个插件按上面命令从 GitHub 装好）后：预设名册里本预设 `trust=user` 且**没有 `broken` 标记**（= 13 行全部解析成功，含薄壳），用本预设开一条会话时沙箱日志打出
   `[anima-rag] 已解析到 dsh-anima-rag：<沙箱>/profiles/web/node_modules/dsh-anima-rag/lib/index.js（判据=declared+resolvable）`，无报错。
   ⚠️ 没验的：真跑一轮对话看检索结果（那需要模型额度，与"能不能装/能不能挂"无关）。
5. **`install.mjs` 只写预设目录里那 11 个文件**：⛔ 不碰 `~/.dsh` 里别的东西、⛔ 不碰 profile、⛔ 不重启任何东西；已存在且内容不同的文件会先备份成 `.bak-<时间戳>`。

## 许可与署名

随 [`dsh-memory-archive`](https://github.com/vv5v5/dsh-memory-archive) 一起以 **CC BY-NC 4.0** 发布（全文见仓库根的 [`LICENSE`](../LICENSE)、第三方出处见根 README 的「第三方许可与出处」）。
其中 `mt-compaction-rp.js` 派生自动画侧 `anima-rag`（作者 Ellinav）与 DeepSeek Harness 官方 `compaction-basic`（MIT）—— 那两处的原始声明随本文件一并保留。
