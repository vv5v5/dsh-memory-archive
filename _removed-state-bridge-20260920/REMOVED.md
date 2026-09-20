# state-bridge —— 已剥离（2026-09-20）

**这套东西不再挂载、不再部署。** 目录留着只是为了"哪天想复活，代码还在"。

## 为什么剥离

用户口径（2026-09-20，原话）：
> 现在开始改状态系统。整个剥离我们原本的写的状态工具。现在的状态由周目笔记维护，character md。

原来的分工是：本子包注册 `state:card` 段（order 50）+ 5 个工具
（`state_list / state_show / state_seed / state_patch / state_purge`），
由**宿主面**（`cordis.patch.yml`）与 **RP 预设**（`agent.cordis.yml`）各挂一次，
状态落在 `C:\Users\w\.dsh\l1-state\`。

现在：**状态改由周目笔记维护** —— 落在 `<周目>/.roleplay-memory/state.md`，
模型用本插件已有的 `memory_write` 工具写它（预设正文里已改成"查阅/维护 state.md"）。

## 剥离时改了哪些地方（复活时要一并改回）

1. `package.json`：`exports["./state-bridge"]` 与 `files` 里的 `state-bridge` —— **已删**；
2. `cordis.patch.yml`：宿主面的挂载块 —— **已删**（原 `- id: state-bridge`）；
3. `~/.dsh/.agent-presets/roleplay/agent.cordis.yml`：`- id: state-bridge` 整块 —— **已删**；
4. 预设模块 `rp-tool-scope.js`（**两份逐字一致**：仓库 `preset-modules/` + 预设目录）：
   白名单里的 4 个 `state_*` —— **已删**；
5. `lib/index.js`：`OUR_SECTION_NAMES` 里的 `state:card`、`/agent` 段的识别条目 —— **已摘**；
6. `lib/client.js`：`PROMPT_MAP_MISSING_KEYS` 里的 `stateCard` —— **已摘**；
   识别/文案条目**保留**（只为读**老捕获**，注释里写了"已退役"）；
7. `lib/card-sections.js`：`HARD_RESERVED_ORDERS` 里 order 50 —— **已删**。

## 磁盘上的旧数据

`C:\Users\w\.dsh\l1-state\` 已改名归档为 `l1-state.removed-20260920\`（6 会话 / 122K）。
要回来跑，把目录名改回去即可（`storageDir` 默认就是 `<DSH_HOME>/l1-state`）。
