# dsh-state-bridge

**主模型每轮在思维链里一次决定：调 `state_patch` 提交状态增量；副 API 降级为默认关闭的兜底。**
合并、到期解除、护栏全部由代码拥有 —— LLM（主或副）只产出增量补丁。

> DeepSeek Harness 插件 · MIT · 零运行时依赖（只用 `node:*`） · v0.2

---

## 它补的是哪一块

角色状态闭环有四段，生态里 ②注入 / ③渲染 / ④分支回滚 都有现成件，
**只有 ①「每轮用辅助 LLM 增量重算状态」是缺口**（两次独立核实：
3408 个插件关键词搜索命中 0；GLM 对 35 个候选做 README 级选型，无一实现该环）。

本插件**只写这一块**，其余复用。设计参考了 `graph-memory`（生态里唯一"每轮一次辅助调用 + 失败隔离"的实现）。

## 三条设计原则

1. **LLM 只产补丁，合并由代码独占。**
   v0.2 起产补丁的是**主模型**：每轮直接调用 `state_patch` 工具（patch 入参与旧副 API 强制的
   `submit_state_patch.change` 由**同一个 `changeSchema()` 生成**，同构防漂移），一次决定、无二次调用。
   `mergeStatus` 做白名单校验合并；副 API 与工具走**同一条** `commitPatch` 路径（合并/护栏/到期/落盘只此一份）。
   用户锁定的字段不在 LLM 的可写集合里 —— 把"被覆盖"从**概率问题**变成**类型问题**。
   白名单之外的根键在工具门口被**显式拒收**（不静默丢弃）。

2. **失败只隔离本轮，绝不阻塞主对话。**
   副 API 失败 / 未提交工具调用 / 超配额 → 保留旧状态，并把失败写进**注入文本**让人看得见
   （"失败可见化"：把"要人工修"变成"点一下 `state_rerun`"）。
   patch-tool 模式下每轮 `turn/end` 还做**事后可见校验**：主模型那轮没调 `state_patch`，
   下一轮注入文本就多一条「⚠️ 上一轮未记录状态」—— 只提示，不阻塞（`requirePatchPerTurn`）。

3. **到期解除是代码的职责，不是模型的。**
   带时限的条目写成 `{ 效果, 到期: "YYYY/MM/DD", 依据 }`，到期后由 `sweepExpired()` 自动移除，
   连带清掉 `负面状态.惊厥` 这类布尔位与 `特殊['惊厥解除']` 标记，并在注入文本里通知 KP。
   *（这条是用户实际痛点的直接修复：以前期限只存在于散文里，解除只有一句"求模型记得删"，于是惊厥永不解除。）*

## 挂点

| 钩子 | 位置 | 为什么 |
|---|---|---|
| `session/event` 过滤 `turn/end` | `session/src/index.ts:74` | 唯一覆盖**全部**收尾原因（completed/blocked/error/abort）的钩子 |
| `systemPrompt.section()` | `system-prompt/src/index.ts:432` | 每轮装配求值 → 状态永远在场。**provider 同步**，只返回缓存值 |
| `'system-prompt/assemble'` | 同 `:19-31, 601-604` | 有界 await 后**改写 `assembly.sections`** |

> ⚠️ **不用** `agent/pre-step`：它改写的 `messages` 会被 `agent-loop/src/agent.ts:291-293`
> 逐条 `session.append('user/message', …)` —— 那是**写历史**，用它注入会把状态每轮累积进历史。
>
> ⚠️ **不新增 session 事件类型**：外部插件跑不了仓库内的持久化目录生成器，
> 而未标记的新事件是 required-on-read，老构建会**拒绝整个日志**。所以状态只落文件。

## 用法

```
# 1. 给要接管的会话设起跑线（**只有 seed 过的会话才会被接管**）
state_seed({ session_id: '<会话 id>', from_file: '…\\产物\\l1-state\\current.json' })

# 2. 之后主模型每轮调 state_patch 提交增量（无变化传 {}），下一轮注入最新状态
state_patch({ patch: { 时间: { 日期: '…' }, 状态栏: { … } }, summary: '依据' })

state_list()                        # 列出接管过的会话
state_show({ session_id, include_card: true })   # 看状态与当前注入文本
state_rerun({ session_id })         # 手动重跑最近一轮副 API（仅 sideApi.enabled 时可用）
state_purge({ session_id })         # 清掉该会话的全部产物（回滚）
```

## 配置

见 `cordis.patch.yml`。要点：

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `patch-tool` | 主模型每轮调 `state_patch`。`tool` / `json` = 旧副 API 路线（还须 `sideApi.enabled: true`） |
| `sideApi.enabled` | `false` | 副 API（turn/end 事后重算）总开关。patch-tool 模式下开启 = 主模型没交补丁的轮次由副 API **兜底补记** |
| `requirePatchPerTurn` | `true` | patch-tool 每轮事后校验：没调 `state_patch` → 下一轮注入「⚠️ 上一轮未记录状态」。可见化，不阻塞 |
| `api.url` / `api.model` / `api.temperature` | SiliconFlow / `deepseek-ai/DeepSeek-V3.2` / `0.4` | 对齐 ST 现役配置（仅 sideApi 启用时用到） |
| `api.key` | 空 | ⚠️ **别写进这个文件并入库**。用环境变量 `STATE_BRIDGE_API_KEY` |
| `maxNewMechanicsPerTurn` | `2` | **治「乱记」**：单轮新增机制条目超限则整轮拒收 + 留痕（主模型与副 API 同受此护栏）。0 = 关闭 |
| `gateTimeoutMs` | `8000` | 装配期有界等待。**超时必放行，绝不阻塞主对话**。0 = 不等（状态恒滞后一轮） |
| `injectSummary` | `true` | 把补丁的 `summary`（变更依据自述）也注入 → "无中生有"可审计 |

## 实测（用户真实数据）

- **反幻觉**：喂"只是被野猫吓了一跳、无任何掷骰"→ 模型提交 `change: {}`，
  自述"这是叙事描写而非机制结算，因此不记录任何状态变化"。
- **结构化到期**：喂"意志检定失败，恐惧+3，惊厥 1 天"→ 模型产出
  `{ 效果: "全技能-10%", 到期: "1966/09/05", 依据: "#5 意志检定失败触发惊厥" }`，恐惧 13→16 算对。
- **移植保真**：50 份真实归档 + 当前状态在空补丁下是**恒等变换**（不损坏既有数据）。
- **成本**：约 5,900–6,100 token/轮。

## 测试

```bash
npm test        # = node --test "tests/*.test.mjs"，70 项
```

> ⚠️ 别用 `node --test tests/`（目录形式）：Node 24 + Windows 下会把目录当模块 require 直接报错。

配套探针（放在你自己的工具目录里，不进本包）：
`_verify-state-bridge.mjs`（零额度全链路，含工具输出契约校验）、
`_verify-state-bridge-live.mjs`（真接 SiliconFlow 两轮对照）、
`_backfill-expiry.mjs`（从归档反推旧格式条目的到期日）。

## ⚠️ 上线注意

**插件接管注入后，必须解绑阶段 1 的 L1 世界书**（`state:card` 与世界书 constant 条目
是同一份内容，否则每轮注入两遍、白花约 540 token 且两份会打架）：

```
PUT /pmp-dsh-tavern/api/v1/characters/<characterId>/world-books
Origin: http://127.0.0.1:3080
{"worldBookIds":[]}
```

## 许可

MIT。本插件不修改任何第三方项目，也不读写 ST 安装目录。
