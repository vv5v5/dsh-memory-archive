# `_fixtures/editor-v2/` · 编辑器 v2 fixture 说明

> 一页说明。配套契约：`docs/INTERFACES-editor-v2.md`（冻结版 20260913）。

## 这是什么

编辑器 v2 各端点**响应形状的真实样例（假数据）**。C 流（客户端三级导航 + 地图）可以**只靠这份 fixture 开发**，不必等 A/B 的服务端实现 —— 这就是并行施工的价值。

| 文件 | 端点 | 场景 |
|---|---|---|
| `turns.json` | `GET /dsh-memory-archive/prompt/api/turns?id=` | **静态会话**：只 1 条 `request/header`、真跑 3 楼；第 2/3 楼 `requestLogged:false` + `headerCarried:true`（**用户报"切轮次没变"的回归夹具**） |
| `turns-injected.json` | 同上 | **每轮注入的会话**：多 header，每楼 `requestLogged:true`，`systemChars` 逐楼不同（7026 / 7039 / 7032 字符） |
| `turns-error.json` | 同上 | **解析失败的会话**：`ok:false` + 错误信息，`turns:[]`；调用次数徽标必须显「失败」而不是 `0` |
| `turns-noheader.json` | 同上 | **空态**：一条 `request/header` 都没有 ⇒ `headerAvailable:false`，`systemChars/toolCount` 为 `null`（未知，不猜） |
| `messages.json` | `GET /dsh-memory-archive/prompt/api/messages?id=&from=&limit=` | 10 条消息跨 3 楼；含 `isToolResult:true`（index 5）与 `isCompacted:true`（index 7）特殊行各 ≥1 |
| `messages-empty.json` | 同上 | **空态**：`total:0`、`messages:[]`、`latestIndex:null` |
| `sections-captured.json` | `GET /dsh-memory-archive/api/sections?sessionId=&turn=` | `source:"captured"`：真段名（`harness:identity` 等）、`mutabilityBasis:"definition"`；`contexts`、26 个 `tools` |
| `sections-inferred.json` | 同上 | `source:"inferred"`：带 `inferred.reason/message` 降级说明；`contexts:[]`（空态）、`hash/order` 可为 `null` |
| `part-system.json` | `GET /dsh-memory-archive/prompt/api/part?id=&turn=2&part=system` | carried 楼的 system（`header-equal`），1946 字符 |
| `part-tools.json` | `…&part=tools` | 0 工具（tools 空态） |
| `part-messages.json` | `…&part=messages` | **按轮次**：只含第 2 楼实际发出的 4 条，非整份会话历史 |
| `part-inventory.json` | `…&part=inventory` | 非空清单：26 个工具、合计 27,448 字符（按字符数降序） |

## 字段约定

- `chars` / `systemChars` 单位是**字符数（`String.length`）**，不是字节数。
- 时间戳、`hash`、`sessionId`、消息内容全部为**构造的假数据**；数值量级参考排查文档 §0 的沙箱实测（静态会话 system 1946 字符 / tools 0 个 / 3 楼；带注入的会话 system 7,026–7,039 字符 / tools 26 个 / 合计 27,448 字符）。
- 空会话的 `latestIndex` 为 `null`（不存在"最新一条"）。
- `headerAvailable` 只在 `false` 时出现；缺省即 `true`。

## 硬线

- **全部为假数据。** ⛔ 不许放任何用户真机会话的标题、正文、存档片段进本目录（也不进任何产物/报告）。
- `source:"inferred"` 的 fixture 刻意长得和 `captured` 不一样（段名无命名空间前缀、`hash:null`）—— 这是在帮 C 流练"两态可区分"。
