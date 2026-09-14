# 数据契约 · 编辑器 v2（冻结版 · 20260913）

> **状态：冻结。** 契约一旦冻结，**只许增字段、不许改已定字段的语义**（要改必须先通知所有流 + 集成流）。
> 本文把《修复计划书-编辑器逻辑四条-并行版-20260913》§2 的 C1–C5 **逐字**落档（原文照抄，仅补说明）。
> 配套 fixture：`_fixtures/editor-v2/`（见文末清单），C 流可**只靠 fixture 开发**，不必等 A/B。

---

## 谁实现哪个

| 契约 | 端点 / 产物 | 实现流 |
|---|---|---|
| C1 轮次 | `GET /dsh-memory-archive/prompt/api/turns` | **A**（`lib/prompt-viewer.js`） |
| C2 消息列表 | `GET /dsh-memory-archive/prompt/api/messages` | **A**（`lib/prompt-viewer.js`） |
| C3 PART | `GET /dsh-memory-archive/prompt/api/part`（`messages` 语义修正为**按轮次**） | **A**（`lib/prompt-viewer.js`） |
| C4 段结构 | `GET /dsh-memory-archive/api/sections` | **B**（新增 `lib/sections-capture.js`；**默认落盘**，见 C5） |
| C5 落盘布局 | `<storageDir>/assembly/<sessionId>.jsonl` | **B** |
| 客户端消费方（L1/L2/L3、地图、徽标） | — | **C**（`lib/client.js`） |
| 宿主注册 + `#3` 缺陷 2 口径（`lib/index.js:1449` 事件路径优先） | — | **D**（`lib/index.js`） |

### B 模块的冻结导出名（供 D 代为注册；B 按此实现，⛔ B 不改 `lib/index.js`）

- 文件：`lib/sections-capture.js`
- `registerSectionsCapture(context)` —— 挂 `system-prompt/assemble` 监听（`inject: ['systemPrompt']`），从 `context.agent.session.id` 认会话，按 C5 落盘。
- `resolveSections(sessionId, turn)` —— C4 的数据访问；无捕获记录时返回 `source:"inferred"`（降级），不抛。
- 路由 `GET /dsh-memory-archive/api/sections?sessionId=<sid>&turn=N` 的**挂载由 D 落地**（与 `registerSectionsCapture` 的调用一起写进 `lib/index.js`）。

#### B 流实现后的冻结片段（增量 20260913 · 只增不改；D 照此接线，已在本流沙箱实跑验证）

- 模块：`lib/sections-capture.js`；导出补充：
  - `registerSectionsCapture(context, options?)` —— 内部用**自带 `inject: ['systemPrompt','sessionProjections']` 的内联 cordis 插件**（`context.plugin({name, inject, apply})`），调用方 ctx 自己没声明这两个服务也能挂上；幂等（同一 ctx 重复调用安全跳过）。返回 cordis Fiber。
  - `handleSectionsGet(ctx, url, send, log)` —— 端点处理函数（内部即调 `resolveSections`），D 的 dispatch 行直接用它。
- 注入（按实际需要写准）：`['systemPrompt', 'sessionProjections']`（轮号读 `sessionProjections.stateOf(session,'turnBoundary').lastTurn`，回退 `agent.phase.turn`）。
- **D 在 `lib/index.js` 要做的三处**（已在本流沙箱安装副本上按同文模拟并验证）：
  1. 顶层守卫预加载 `await import('./sections-capture.js')`（照抄 rp-agent 的模式）；
  2. `apply()` 内调 `sectionsCapture.registerSectionsCapture(ctx)`（try/catch 降级）；
  3. ENDPOINTS 表加 **`'/sections': ['GET']`** + dispatch 行 `if (rest === '/sections') return await sectionsCapture.handleSectionsGet(ctx, url, send, log)`。
     ★ 路由表行是 **`'/sections'`**（`API_PREFIX` 剥离后的 rest），不是 `'/api/sections'` —— 后者拼出来是 `/dsh-memory-archive/api/api/sections`，与 C4 契约 URL `GET /dsh-memory-archive/api/sections` 不符（初稿笔误，实测发现）。
- 全文落盘开关：`options.fullText === true` 或 **env `MAGICTARVEN_SECTIONS_FULLTEXT=1`**，默认关（实测：默认文件零正文字段；开关打开后 `sections[].text/contexts[].text/tools[].text` 出现）。D 若接 config，可把它映射成 config 项。
- 落盘布局：`<storageDir>/dsh-memory-archive/assembly/<sessionId>.jsonl`（storageDir 与 lib/index.js 同一套 `DSH_HOME` 推导）；首行 `{"v":1,"kind":"dsh-memory-archive-assembly"}`，之后每楼一行（同楼多步组装**后写覆盖先写**）；有界：每会话最近 200 楼、全局 32 MB（超限按 mtime 淘汰最旧会话文件）；版本不认识/坏行 ⇒ 降级 `inferred`，不抛。

---

## ★ 三条防踩线（后来人必读）

1. **轮次的唯一锚点是 `turn/start` / `turn/end`，⛔ 不是 `request/header` 的条数。**
   宿主只在 header **变了**时才记一条：`agent-loop/src/agent.ts:498-518` —— 只有三情况记账：`initial`/`resume`（本 run 首次）、`change`（头变了）、`series`（新一段）。对提示词静态的会话，header 条数恒为 1（或重启次数），**拿它当轮次数就是"切了没变"这个 bug 本身**。
2. **`requestLogged:false` 不是缺陷，是权威信息。**
   宿主只有 `headerEquals(baseline, header) === true` 才不记 ⇒ 该楼的 system/tools **等于上一条记录**（`headerCarried:true`），按 carry-forward 取该轮之前最近一条 `request/header`。这比"diff 两轮文本"更准，且静态会话也成立。
3. **`source:"captured"` 与 `"inferred"` 必须可区分，⛔ 界面与文档都不许把推断说成捕获。**
   `captured` 来自组装瀑布的真实段名/真文本；`inferred` 是降级路径（文本推断），界面上必须明示（如角标「结构为文本推断」）。

---

## C1 轮次（`GET /dsh-memory-archive/prompt/api/turns?id=<sid>`）

```json
{ "ok": true, "sessionId": "…", "latest": 3,
  "turns": [ { "turn": 1, "startedAt": "…", "endedAt": "…",
               "messageCount": 3, "seqRange": [14, 517],
               "requestLogged": true,          // 这一轮有没有自己的 request/header
               "headerCarried": true,          // 没有 ⇒ 用上一条记录，且宿主判定"逐字相等"
               "systemChars": 1946, "toolCount": 0 } ] }
```

- **轮次来自 `turn/start` / `turn/end` 成对出现**（排查文档 §0.2）。
- `requestLogged:false` 时，`system/tools` 走 **carry-forward**（取该轮之前最近一条 `request/header`），并在响应里标 `headerCarried:true`（这是**权威**信息：宿主只有 `headerEquals` 为真才不记）。

说明：`systemChars` / `chars` 类字段的单位是**字符数（`String.length`）**，不是字节数。

## C2 消息列表（二级，`GET /dsh-memory-archive/prompt/api/messages?id=<sid>&from=&limit=`）

```json
{ "ok": true, "total": 5, "latestIndex": 4,
  "messages": [ { "index": 0, "seq": 17, "turn": 1, "role": "user",
                  "preview": "开始吧", "chars": 6,
                  "isToolResult": false, "isCompacted": false } ] }
```

- `turn` = 该消息归属的楼（供二级→地图联动）；`preview` = 首行截断（**不许**把全文塞进来）。
- 分页：`from`/`limit`，默认返回**最后 N 条**（配合"自动定位最新楼"）。

## C3 PART（修正语义，`GET /dsh-memory-archive/prompt/api/part?id=<sid>&turn=N&part=…`）

- `part=messages` **必须按轮次**：返回**该楼实际发出的历史**，不是整份会话历史（GLM 落档的缺陷 4）。
- `part=sections` ⇒ 走 C4 的同一份数据（等价入口）。
- `system` / `tools` / `inventory` 语义不变。

## C4 ★ 段结构（**新的真相源**，`GET /dsh-memory-archive/api/sections?sessionId=<sid>&turn=N`）

```json
{ "ok": true, "source": "captured",          // ★ "captured"=组装捕获（权威） / "inferred"=文本推断（降级，界面必须明示）
  "capturedAt": "…", "turn": 2,
  "sections": [ { "name": "harness:identity", "order": -1000, "chars": 48, "hash": "…",
                  "mutability": "static", "mutabilityBasis": "definition" } ],
  "contexts": [ { "name": "sandbox:policy", "chars": 0 } ],
  "tools":    [ { "name": "pwsh", "chars": 4419 } ] }
```

- `source:"captured"` 的数据来自 **`system-prompt/assemble` 瀑布**（`system-prompt/src/index.ts:31`），
  监听者从 **`context.agent.session.id`** 认会话（`agent-loop/src/index.ts:416` 的用法为证），从 **`assembly.sections`** 拿真段名与真文本。
- `mutabilityBasis`：`"definition"`（拿得到 `PromptSection.text` 是不是函数 ⇒ 最权威） >
  `"header-equal"`（宿主判定头未变 ⇒ 逐字相等） > `"unknown"`。⛔ 不许把 `inferred` 的结果标成 `captured`。

## C5 落盘（**决策 5：默认落盘**）

- 位置：插件自己的 storages 下，`<storageDir>/assembly/<sessionId>.jsonl`（**不写用户的会话目录**）。
- 每条记录：`{ turn, capturedAt, sections:[{name, order, chars, hash}], contexts:[…], tools:[…] }`。
- ★ 默认**只存段名 + order + 字数 + hash**（存全文会让私域正文扩散到别处，且体积爆炸）。要全文另开开关，默认关。
- 有界：每会话保留最近 `N` 轮（建议 200）、全局总量上限（建议 32 MB），超出按最旧淘汰；文件头写 schema 版本，读到不认识的版本 ⇒ 当作"未记录"（`source:"inferred"`），**不抛**。

---

## W0 增量字段（**只增不改**，冻结时一并定下；各流如有异议在报告期提出）

契约只定义了成功路径的形状；以下是 fixture 覆盖边界场景所必需的**增量**（均已按"只许增字段"规则处理）：

1. **失败形状**（解析失败的会话）：`{ "ok": false, "error": { "code": "session-parse-failed", "message": "…" }, "turns": [], "latest": 0 }`。
   客户端的调用次数徽标必须把 `ok:false` 显示为「失败」，**与 `0` 区分开**（用户已拍板：`-2/失败` ≠ `0`）。
2. **空会话**：C2 对没有任何消息的会话返回 `total:0, messages:[]`，此时 `latestIndex` 为 **`null`**（不存在"最新一条"）。
3. **无任何 `request/header` 的会话**：C1 增加顶层 `headerAvailable:false`；此时每楼 `requestLogged:false`、`headerCarried:false`、`systemChars:null`、`toolCount:null`（system/tools 未知，不猜）。`headerAvailable:true` 时可省略该字段。
4. **`inferred` 的降级说明字段**（C4）：`source:"inferred"` 时必须带
   `"inferred": { "reason": "no-capture-record|schema-version-unknown|…", "message": "…人话…" }`，且 `capturedAt:null`；推断段的 `hash` 允许为 `null`、`order` 允许为 `null`（按序列位置显示）。
5. **PART 响应的补充字段**（C3）：在现有 `{ok, part, text}` / `{ok, part, tools}` 之上补 `sessionId`、`turn`、`chars`（文本字符数）；carried 楼补 `requestLogged:false`、`headerCarried:true`、`mutabilityBasis:"header-equal"`。

---

## fixture 清单（`_fixtures/editor-v2/`）

| 文件 | 对应端点 | 覆盖的边界场景 |
|---|---|---|
| `turns.json` | C1 | ① 静态会话：1 条 header、3 楼（**回归夹具**） |
| `turns-injected.json` | C1 | ② 每轮注入：多 header、systemChars 逐楼不同 |
| `turns-error.json` | C1 | ③ 解析失败：`ok:false`，徽标显「失败」 |
| `turns-noheader.json` | C1 | ⑥ 空态：一条 request/header 都没有 |
| `messages.json` | C2 | ⑤ 特殊行：`isToolResult` / `isCompacted` 各 ≥1 |
| `messages-empty.json` | C2 | ⑥ 空态：`messages:[]`、`latestIndex:null` |
| `sections-captured.json` | C4 | ④ `source:"captured"`（真段名、`mutabilityBasis`） |
| `sections-inferred.json` | C4 | ④ `source:"inferred"`（含降级说明）；⑥ `contexts:[]` |
| `part-system.json` | C3 | carried 楼（`header-equal`）的 system |
| `part-tools.json` | C3 | 0 工具（tools 空态） |
| `part-messages.json` | C3 | **按轮次**的 messages（非整份历史） |
| `part-inventory.json` | C3 | 非空 tools/inventory 清单（26 个） |

全部为**构造的假数据**；详见 `_fixtures/editor-v2/README.md`。
