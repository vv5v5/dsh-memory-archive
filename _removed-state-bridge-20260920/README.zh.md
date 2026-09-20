# dsh-state-bridge

> **许可：本子目录内的代码为 MIT**（见 `LICENSE`），仓库其余部分为 CC-BY-NC-4.0（见仓库根 `LICENSE`）。
> 收编沿革与两段式许可口径见 `NOTICE.md`。

**记账只有一条路：主模型每轮调用 `state_patch` 提交状态增量。**
合并、到期解除、护栏全部由代码拥有 —— 模型只产补丁，不写状态。
漏记不会静默：`turn/end` 只做**事后可见校验**，那一轮没交补丁就在下一轮状态卡里写一条
「⚠️ 上一轮未记录状态」（`requirePatchPerTurn`，只提示、不阻塞、不改状态本体）。

> DeepSeek Harness 插件 · MIT · 零运行时依赖（只用 `node:*`） · v0.2

---

## 它补的是哪一块

角色状态闭环有四段，生态里 ②注入 / ③渲染 / ④分支回滚 都有现成件，
**只有 ①「每轮增量重算角色状态」是缺口**（两次独立核实：
3408 个插件关键词搜索命中 0；GLM 对 35 个候选做 README 级选型，无一实现该环）。

本插件**只写这一块**，其余复用。

## 三条设计原则

1. **模型只产补丁，合并由代码独占。**
   每轮由**主模型**在思维链里一次决定：直接调用 `state_patch` 工具，
   patch 入参由 `changeSchema()` 生成（与注册的 JSON Schema 同源，防漂移），一次决定、无二次调用。
   `mergeStatus` 做白名单校验合并；所有入口都只走**同一条** `commitPatch` 路径
   （合并/护栏/到期/落盘只此一份）。
   用户锁定的字段不在模型的可写集合里 —— 把"被覆盖"从**概率问题**变成**类型问题**。
   白名单之外的根键在工具门口被**显式拒收**（不静默丢弃）。

2. **漏记只可见化，绝不阻塞主对话。**
   未提交工具调用 / 超配额 / 非法键 → 保留旧状态，并把结果写进**注入文本**让人看得见
   （"失败可见化"）。
   每轮 `turn/end` 还做**事后可见校验**：主模型那轮没调 `state_patch`，
   下一轮注入文本就多一条「⚠️ 上一轮未记录状态」—— 只提示，不阻塞（`requirePatchPerTurn`）。
   没有任何后台补记路径：状态要么由主模型当轮写好，要么明确标成"没记"。

3. **到期解除是代码的职责，不是模型的。**
   带时限的条目写成 `{ 效果, 到期: "YYYY/MM/DD", 依据 }`，到期后由 `sweepExpired()` 自动移除，
   连带清掉 `负面状态.惊厥` 这类布尔位与 `特殊['惊厥解除']` 标记，并在注入文本里通知 KP。
   *（这条是用户实际痛点的直接修复：以前期限只存在于散文里，解除只有一句"求模型记得删"，于是惊厥永不解除。）*

## 挂点

| 钩子 | 位置 | 为什么 |
|---|---|---|
| `session/event` 过滤 `turn/end` | `session/src/index.ts:74` | 唯一覆盖**全部**收尾原因（completed/blocked/error/abort）的钩子；这里只读事件、只写文件 |
| `systemPrompt.section()` | `system-prompt/src/index.ts:432` | 每轮装配求值 → 状态永远在场。**provider 同步**，只返回缓存值 |
| `'system-prompt/assemble'` | 同 `:19-31, 601-604` | 用最新落盘状态重渲染注入段 |

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
state_purge({ session_id })         # 清掉该会话的全部产物（回滚）
```

## 配置

见 `cordis.patch.yml`。要点：

| 键 | 默认 | 说明 |
|---|---|---|
| `requirePatchPerTurn` | `true` | 每轮事后校验：没调 `state_patch` → 下一轮注入「⚠️ 上一轮未记录状态」。可见化，不阻塞 |
| `maxNewMechanicsPerTurn` | `2` | **治「乱记」**：单轮新增机制条目超限则整轮拒收 + 留痕。0 = 关闭 |
| `gateTimeoutMs` | `8000` | 保留的配置位。记账全在主模型生成过程中同步完成，装配期没有在途任务可等，故恒为直通 |
| `injectionOrder` | `50` | 注入文本在 system prompt 里的排序位 |
| `deltaMaxChars` | `6000` | 保留的配置位（当前主模型工具路径不读增量文本） |
| `injectSummary` | `true` | 把补丁的 `summary`（变更依据自述）也注入 → "无中生有"可审计 |
| `storageDir` | 空 | 存储根；留空 = `<DSH_HOME>/l1-state` |
| `sessionAllowlist` | `[]` | 只接管这些会话；空 = 接管所有**已 seed** 的会话 |

## 实测（用户真实数据）

- **反幻觉**：喂"只是被野猫吓了一跳、无任何掷骰"→ 模型提交 `patch: {}`，
  自述"这是叙事描写而非机制结算，因此不记录任何状态变化"。
- **结构化到期**：喂"意志检定失败，恐惧+3，惊厥 1 天"→ 模型产出
  `{ 效果: "全技能-10%", 到期: "1966/09/05", 依据: "#5 意志检定失败触发惊厥" }`，恐惧 13→16 算对。
- **移植保真**：50 份真实归档 + 当前状态在空补丁下是**恒等变换**（不损坏既有数据）。

## 测试

```bash
node --test tests/*.test.mjs      # 逐文件形式（推荐）
```

> ⚠️ 别用 `node --test tests/`（目录形式）：Node 24 + Windows 下会把目录当模块 require 直接报错。

配套探针（放在你自己的工具目录里，不进本包）：
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
