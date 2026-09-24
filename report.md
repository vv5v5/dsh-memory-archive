# 交付报告 · 补单：楼层快照**按 `(楼层 + 变体)` 记**、回档跟随**认 swipe**、死区**按块合并**

派单：`#20260923-235950-补单-楼层快照按变体记+死区按块合并`（任务书 `手工派单-补单-楼层快照按变体记+死区按块合并-20260923.md`）
上游单：`#20260923-232403-按楼层绑定笔记快照与回档跟随` —— 那一版报告已**改名保留**：
`report-20260923-232403-按楼层绑定笔记快照与回档跟随.md`（⛔ 没删）。
cwd：`D:\apps\deepseek\dsh-memory-archive` ｜ 分支 `main` ｜ ⛔ 未 commit / 未 push / 未部署 / **全程未碰实机**
（宿主 :3080 一次没连过；夹具全在仓库根的临时目录里，跑完自删；⛔ 不碰用户 RP 工作区 `D:\apps\dsh-tarven`）

**一句话结论**：用户拍板的两处口径**都改了**，其余一切照旧。

① **快照锚 `nodeId` → `(nodeId, variantId)`** —— 同一楼 swipe 出来的每一支**各记一条**（同一个键再记 ⇒ 覆盖），
**换变体也算回档**：恢复到"这一支"的快照；没有 ⇒ **退回"进这一楼之前"**（紧邻前一楼最后一条）；
连前一楼也没有 ⇒ 什么都不动并如实播报。清单里**只有 nodeId 的老条目只读、绝不拿来恢复**（面板/回执如实标一句）。
② **死区从"整份跳过" → "按块合并"** —— 同一份文件里：快照里的**非死区块照快照写**、**死区块保留盘上现况那一块**
（盘上找不到就**不补回**）。判据仍只有 `.dma-deadzones.json` + `deadzone.js`（⛔ 没另立一份、⛔ 没改它的对外语义）；
死区数据读不出来仍**整次恢复不做**（fail-closed 不变）。

**改动面**（3 个文件改 + 1 个新模块的既有实现 + 2 个台子 + 归档）：

| 文件 | 性质 |
| --- | --- |
| `lib/floor-snapshot.js` | 改：`(N,V)` 键 + 老条目纪律 + 回档三支判据 + `mergeDeadzoneBlocks`/`rawSpans` + `planRestore` 换判据 |
| `lib/index.js` | 改：死区**判据整条**喂给恢复 / `prevOf` / 回执文案（换变体、退回进楼前、老记录、按块合并）/ 两条端点带变体 |
| `lib/client.js` | 改：每一支一行 + 老记录禁用只读 + "同一楼的另一支"标记 + 死区文案改口径 |
| `_selftest-floor-snapshot.mjs` | **改/加**：§2 八对（新口径）+ 上一单八对回归（改口径的两条已改写）｜**88 通过 / 0 失败**（上一版 61） |
| `_selftest-client.mjs` | 改：楼层面板那一节按变体级改写｜**121 通过 / 0 失败** |
| `CHANGELOG.md` | `[Unreleased]` 里那条**改成本单口径**（⛔ 没起新版本号） |
| `report.md` / `report-20260923-232403-….md` | 本报告新写；上一单那份改名保留 |

---

## 0 用户口径 → 落点（一张速查表）

| 用户原话（§0） | 落点 |
| --- | --- |
| 「**按变体级快照**（`(nodeId, variantId)`），换变体时恢复到"这一支"的快照」 | `floorKeyOf` / `floorOfVariant` / `upsertFloor` / `normalizeIndex`（`lib/floor-snapshot.js:130,192,214,148`） |
| 「重 roll 掉的那支内容不会留在笔记里」（没记过 ⇒ 退回进楼前） | `decideRollback` 第 a/b/c 步（`lib/floor-snapshot.js:314` 与 `resolveRollback:344`） |
| 「**死区块保留现状**（你/模型写的都不动），同一份文件里**其余部分照快照回滚**」 | `mergeDeadzoneBlocks`（`lib/floor-snapshot.js:474`）+ `planRestore`（`:582`） |
| 「老条目**只读不恢复**，并如实标一句」 | `isLegacyFloor`/`isRestorableFloor`（`:138,143`）、端点 409（`lib/index.js:5566` 与 `:5586`）、面板禁用（`lib/client.js:2355,2372`）、清单 `legacyFloors`（`lib/index.js:5521`） |

---

## 1 §1 逐条对照表

### 1.1 快照锚：`nodeId` → **`(nodeId, variantId)`**

| 任务书 §1.1 要求 | 落在哪 | 怎么证的 |
| --- | --- | --- |
| 轮末那一笔按 `(nodeId, variantId)` 存；**同一个 key 再次记 ⇒ 覆盖**（与"同一 nodeId 只留最后一条"同款纪律） | `floorKeyOf`（`lib/floor-snapshot.js:130`）是**唯一**一处键拼法；`upsertFloor`（`:214`）按它就地替换；`normalizeIndex`（`:148`）按它去重 | 台子 **§2-1相**（同一 nodeId 两支 ⇒ 清单里**两条**、两个不同的 sha）；**C-1相/C-1相b/反证**（同一 `(N,V)` 再记 ⇒ `floors.length` 仍是 1、sha 换成新的；5 份没变 ⇒ index 逐字节不动）|
| 清单里每条至少带 `nodeId`/`variantId`/`at`/5 份的 `{name, sha256, bytes, changed}`（形状照现在的抄） | `normalizeFloor`（`:110`）+ `planRecord`（`:374`） | 台子 **A4**（`r.floor.variantId === 'v9'`、5 份顺序与键集合）；**C-1相**（`indexOnDisk().floors[0].variantId === VAR(NODES[0])`） |
| ⛔ 旧数据兼容：只有 nodeId 没有 variantId 的条目 ⇒ 如实当"不知道是哪一支"，**读得出来、只用于显示，不许拿来恢复** | `isLegacyFloor`（`:138`）/ `isRestorableFloor`（`:143`）；`resolveRollback` 第 a 步只认 `isRestorableFloor`（`:344`）；`restoreFloor` 直接 `legacy-no-restore`（`:899`）；端点 409 `RP_MEMORY_FLOOR_LEGACY`（`lib/index.js:5566`） | 台子 **A3**（老条目 `isLegacyFloor===true`、`isRestorableFloor===false`、`floorOfVariant(idx,'n2','v1')===null`）；**§2-7相/相b/相c/相d**（回档时一个字节都不写、`legacyAtHead:true`、手动恢复 ⇒ `legacy-no-restore`）；**D7e**（走真端点 ⇒ 409 + `RP_MEMORY_FLOOR_LEGACY`）；**D7f**（清单 `legacy:true` + `legacyFloors`） |
| 「并在面板/回执里如实标一句」 | 面板那一行：`老记录：只有楼层、不知道是哪一支` + 按钮禁用 + `老记录·不能恢复`（`lib/client.js:2355,2372`；行属性 `data-floor-legacy` 在 `:2340`）；回执：`（这一楼只有老记录：只有 nodeId、不知道是哪一支 ⇒ 老记录只读、不许拿来恢复）`（`lib/index.js:4670`；手动那一脚那句在 `:4678`） | 客户端台子渲染断言：`text.includes('老记录·不能恢复')`、`data-floor-legacy:"1"`；端点真输出见下面 §5 |

### 1.2 回档跟随：**认 swipe**（换变体也算）

| 任务书 §1.2 要求 | 落在哪 | 怎么证的 |
| --- | --- | --- |
| 1) 与上次记账那一刻的 `(N,V)` **相同** ⇒ 什么都不做（⛔ 不许有任何写盘） | `decideRollback` 的 `same`（`lib/floor-snapshot.js:332,335`，两边变体一致**或**有一边不知道变体时都不对着变体判） | 台子 **§2-4相b**（前进且笔记没变 ⇒ index 逐字节不变）、**§2-4相c**（watch 那一脚同样零写盘）、**C-1相b** |
| 2) head 前进到更靠后的楼层 ⇒ 正常推进，什么都不做 | `seq >= lastSeq ⇒ 'forward'`（`:339`） | 台子 **§2-4相**（`forward` + `restore===null` + 笔记就是模型刚写的样子）、**C-3相** |
| 3) 否则（回到前面的楼层 **或** 同一楼换了变体）⇒ 判回档 | `:336`（`why:'variant'`）/ `:340`（`why:'back'`）⇒ `resolveRollback`（`:344`） | 台子 **§2-2相**（`why==='variant'`、`source==='self'`）；**§2-3相**（`why==='variant'`、`source==='prev'`）；**D4**（真钩子走一遍 swipe） |
| 3a) `(N,V)` 自己有快照 ⇒ 用它 | `resolveRollback` 第 a 步 | 台子 **§2-2相**（恢复到那一支那一份：`target.variantId === VAR(NODES[1])`） |
| 3b) 没有（新变体 / 没记过）⇒ 用**紧邻前一楼**（`nodes` 里 `N` 的前一个）**最后一条** | `prevNodeOf`（`nodeOrderOf`:236, `prevNodeOf`:276）+ `lastRestorableFloorOfNode`（`:208`），由接线那一层拼成 `prevOf`（`lib/index.js:4762,4770`） | 台子 **§2-3相**（`source==='prev'`、`target.nodeId===NODES[0]`、笔记逐字节 = 第 1 楼那份、`headSeq:2 / seq:1` 两个都在）；**C-7相**（回到没有快照的第 2 楼 ⇒ 用第 1 楼那份） |
| 3c) 连前一楼也没有（就是第一楼）⇒ 什么都不动 + 如实播报 | `back-no-snapshot`（`:352`） | 台子 **§2-7相b**（一个字节不写 + `legacyAtHead`）；**A9**（`prevOf` 返回 null ⇒ `back-no-snapshot`） |
| 4) 恢复动作与纪律照上一版：先留"当下" → 只写那 5 份 → 写前逐份比 sha → 原子写 → 面板 + 日志如实播报（**哪一楼/哪一支 → 恢复到哪一份**） | `runRestore`（`:825`）三步；文案唯一一处 `floorReceiptText`（`lib/index.js:4607`） | 台子 **C-4相/相b/相c**（逐字节 + `.bak-` + `last` 跟到那一份）、**C-5相/相b**（可撤销）、**D2b**（日志）、**D4**（那句里**两条变体 id 都在**：`variant-…​ → variant-…-v2`）；见 §5 的真实输出 |

### 1.3 死区：**按块合并**（不再是"整份跳过"）

| 任务书 §1.3 要求 | 落在哪 | 怎么证的 |
| --- | --- | --- |
| 快照里的**非死区块** ⇒ 照快照写 | `mergeDeadzoneBlocks` 的 `picked.get(i) === undefined` 那一支（`lib/floor-snapshot.js:521`） | 台子 **§2-5相**（B 逐字节 = 第 1 楼快照的 B）；**A6c** ②③（`kept`/`gone` 两条：非死区块都取快照） |
| 快照里的**死区块** ⇒ 保留盘上现况那一块（⛔ 一个字节都不动它） | 同一函数取 `onDisk` 那一支（`:524` 取、`:529` 记 `kept`） | 台子 **§2-5相**（`diskAfter === A2 + '\n\n' + B1 + '\n'`，A 区逐字节 = 盘上模型写的那段）；**A6c** ②（`kept.text` 里的死区块 = 盘上那块） |
| 判据用死区那份数据（`file` + 块首行/sha）；**复用 `deadzone.js`，⛔ 不另立一份、⛔ 不改它的对外语义** | `import { locateZone, sha256Hex, splitBlocks, writeWithBackup }`（`lib/floor-snapshot.js:53`）——定位一律走 `locateZone`（先 sha、再首行）；接线那一层把 `doc.zones` **整条**喂进来（`lib/index.js:4569` `floorDeadZones`） | 台子 **E4**（只 import 那四个出口、模块里不出现 `DEADZONE_FILE_NAME`/`readDocFile`/`decideToggle`/`normalizeDoc`）；`_selftest-deadzone.mjs` **70 通过 / 0 失败**（它的判据一个字节没改，`git status` 里 `lib/deadzone.js` 本单**未被写入**） |
| 盘上**找不到**那个死区块（用户自己删了）⇒ **不补回** + 如实播报一句 | `dropped.push(zone.firstLine)`（`:526`），文案进回执（`lib/index.js:4633` "盘上找不到的 N 段没补回"） | 台子 **A6c** ③（`gone.text === 'A1\r\n\r\nB1\r\n'`、`dropped.length===1`）、**§2-6相**（那一份的正文一个字节没被写回） |
| **fail-closed 保留**：死区数据读不出来 ⇒ **整次恢复不做** | `planRestore` 的 `blocked:'deadzones-unreadable'`（`lib/floor-snapshot.js:585`；⛔ 顺带把"调用方忘了带 `zones`"也按**判据未知**处理 —— 不许因为忘带就变成"那就整份写"） | 台子 **A6b**（`null` 与"不传"两种都 blocked）、**§2-6反证**（那 5 份逐字节没变 + `last` 不前进）、**C-7c**（走真钩子：数据写坏 ⇒ 笔记保持原样 + 状态文件 `blocked` 如实 + 日志一条）、**D8c/D8d** |
| 回执/面板里 `skipped[].deadzone` 的语义从"整份跳过"改成"该文件有死区、**已按块合并**" ⇒ **文案要跟着改** | 回执：`lib/index.js:4628`（`死区那 N 段保留盘上现况、其余照快照回档`）与 `:4633`（`盘上找不到的 N 段没补回`）；面板：`lib/client.js:2325`（`FLOOR_SKIP_TEXT.deadzone`）与 `:2375`（行内那句）、`:2448`（档尾那句）；[同一楼的另一支] 那个标记在 `lib/client.js:2351` | 台子 **D8b**（状态文件那句同时含 `死区`/`按块合并`/`保留盘上现况`）；客户端台子渲染断言 `text.includes('按块合并') && text.includes('保留盘上现况')` |

### 1.4 ⛔ 别的不许动

| 纪律 | 怎么证的 |
| --- | --- |
| 只写那 5 份 + 我们自己的 `.dma-floor-snapshots/` | 台子 **E2**（模块里 `writeFileSync` 恰好 3 处 = 清单 / 内容寻址正文 / 那 5 份）、**A8**（非那 5 份 ⇒ 拒写）；**§2-8相**（`rulebook.md` / `大纲-甲.md` / `幻蕊示例.txt` 在恢复前后逐字节不变，且清单里从不出现它们） |
| ⛔ 不碰预置 / 会话 / 归档 / Tavern 任何文件 | **E3**（接线那一块唯一的写盘是我们自己的状态文件；无 `copyFileSync/unlinkSync/rmSync`）+ **D7d**（恢复前后 `timeline.json` / `catalog.json` 逐字节没变） |
| 内容寻址存储 / 轮末至多一次 / 绝不抛 / 写前留"当下"那份 | **C-2相**（同内容只落一份）、**D5/D5b/D5c**（轮末 + 压缩末才记、没变不写）、`reportFloorError`（同一个错误只记一条）、**C-5相** |
| `deadzone.js` 只调用不修改 | `git status`：`lib/deadzone.js` 是**上一单留下的未跟踪新文件**，本单没写它；文件时间戳可作证（本单动过的三份都是 2026-09-24 00:0x，它是**上一单的 09-23 22:23**）：<br>`2026-09-24 00:07 lib/client.js` / `2026-09-23 22:23 lib/deadzone.js` / `2026-09-24 00:14 lib/floor-snapshot.js` / `2026-09-24 00:15 lib/index.js`。<br>`_selftest-deadzone.mjs` **70 / 0** 照旧（只调用它的 `sha256Hex` / `writeWithBackup` / `splitBlocks` / `locateZone`，⛔ 它的对外语义一个字没改） |
| `collect*`、预设 YAML、老端点的语义与状态码 | 一行未动（`lib/collect.js` / `lib/collect-scan.js` / `preset/agent.cordis.yml` 本单没写）；两条 `floors*` 端点是**上一单**新增的，本单只给它们加了请求体里的 `variantId` 与一个新状态码 **409 `RP_MEMORY_FLOOR_LEGACY`**；⛔ 其余**老**端点（`rp-memory` / `deadzones*` / `vector` / `anima` 那几条）的语义与状态码一个字没动 |

---

## 2 §2 八对的红/绿证据（反证一律把"改回旧口径"或"挖掉那一步"贴出来）

### 对 1｜相｜变体级记录：同一 `nodeId` 两支各记一次 ⇒ 清单里**两条**

- 夹具：记第 1 楼 → 记第 2 楼第 1 支 → **swipe 到第 2 支**（没记过 ⇒ 走 a/b/c 的 b：退回进楼前）→ 模型重跑后轮末再记。
- 绿（`_selftest-floor-snapshot.mjs:494`）：`floorsOfNode(index, NODES[1]).length === 2`，两条的 `variantId` 分别是
  `variant-qa-2-2-bbb` / `variant-qa-2-2-bbb-v2`，两条的 `notes.md` sha **互不相同**（各是那一支的内容）。
- 真输出：`✔ §2-1相 ★ 同一 nodeId 两支变体各记一条（(N,V1) / (N,V2)），互不覆盖（各自的 sha 都在）`

### 对 2｜相｜换变体也算回档（`(N,V)` 自己有快照 ⇒ 用它）；**反证｜判据只看 nodeId ⇒ 不触发恢复**

- 绿（`_selftest-floor-snapshot.mjs:517`）：`head=(2,V1)` 而 `last=(2,V2)`、且 `(2,V1)` 有快照 ⇒ `kind==='rollback'`、`why==='variant'`、
  `source==='self'`、`target.variantId===variant-qa-2-2-bbb`，盘上 `notes.md` 逐字节变成 `(2,V1)` 那一份。
- 反证（`:523`，把**上一版那一行判据逐字**摆出来对照）：

  ```js
  // ← 上一版那一条判据（逐字）：`head.nodeId === last.nodeId ⇒ same`
  const oldJudge = (h, l) => (h.nodeId === l.nodeId ? 'same' : '其它')
  const withOld = oldJudge(headsNow, lastBefore)          // headsNow = (2, V2)，lastBefore = (2, V1)
  // 同一夹具下：按老判据＝什么都不做 ⇒ 盘上留着 V2 支那份（≠ V1 支那一份） ⇒ "恢复到 (N,V1)"必红
  return withOld === 'same' && notesBefore === V2B['notes.md'] && V2B['notes.md'] !== V2['notes.md']
  ```
  即：**旧口径下这一对必红**（恢复根本不会发生），而新口径下它绿。

### 对 3｜相｜新变体退回"进这一楼之前"；**反证｜把 (b) 支挖掉 ⇒ 必红**

- 绿（`:545`）：`(2,V2)` 没记过、前一楼有 ⇒ `source==='prev'`、`target.nodeId===NODES[0]`、
  `headSeq:2`（回档那一刻站在第 2 楼）/ `seq:1`（用的是第 1 楼那一份），盘上 5 份回到第 1 楼。
- 反证（`:552`，**同一夹具重放**一遍，只把"紧邻前一楼"那一步挖掉 —— 用 `prevOf` 这个接缝）：
  ```js
  const runFixture = (opts) => { … 同一套步骤 … return sync('turn', opts) }
  const dug = runFixture({ prevOf: () => null })   // ← 挖掉 (b) 支 = 认不出前一楼（上一版的 back-no-snapshot 口径）
  check('§2-3反证 …', dug.kind === 'back-no-snapshot' && dug.wrote === false
    && readMem('notes.md') === '# 笔记\n第 2 楼第 1 支之后模型又写了\n'
    && readMem('notes.md') !== V1['notes.md'])
  ```
  ⇒ 挖掉那一步之后"笔记回到进楼前"必红（盘上还是模型刚写的那份）。

### 对 4｜相｜正常前进不回档（含"一个字节都不写"）

- 绿（`:567`）：`kind==='forward'`、`restore===null`、笔记就是模型刚写的样子、清单里多了一条**带变体**的记录。
- 绿（`:577`，`:581`）：再往前一楼但**笔记没变** ⇒ `wrote===false` 且 `indexRaw()` 逐字节不变（连 `at` 都不动）；
  `watch` 那一脚同样零写盘。

### 对 5｜相｜死区按块合并；**两个反证**（"照快照整份写" 与 上一版"整份跳过" **两种口径都咬人**）

- 夹具：`index.md` = 死区块 A + 非死区块 B；第 1 楼记一份；第 3 楼**把 A、B 都改了**；回档到第 1 楼。
- 绿（`:604`）：`diskAfter === A2 + '\n\n' + B1 + '\n'` —— **A 逐字节等于盘上现况**（模型那版）、
  **B 等于快照**（第 1 楼那版）；`skipped` 里 `index.md` 标 `reason:'deadzone' && merged:true && kept.length===1`。
- 反证①（`:611`，"照快照整份写"）：
  ```js
  const dugDisk = { 'index.md': beforeRestore }                  // 模拟"整份写"的落点
  for (const f of snapFloor.files) if (typeof texts[f.sha256] === 'string') dugDisk[f.name] = texts[f.sha256]
  return dugDisk['index.md'] === SNAP_INDEX                      // ← 老写法：A 被作者版盖掉（模型改的没了）
    && dugDisk['index.md'] !== diskAfter && dugDisk['index.md'] !== A2 + '\n\n' + B1 + '\n'
  ```
- 反证②（`:621`，改回上一版的"整份跳过"）：
  ```js
  const v1SkipDisk = beforeRestore                               // ← 上一版：这一份一个字节都不写
  return v1SkipDisk === A2 + '\n\n' + B3 + '\n'
    && v1SkipDisk !== A2 + '\n\n' + B1 + '\n'                    // B 回不去 ⇒ "B 等于快照"必红
    && v1SkipDisk.split('\n\n')[0] === A2                        // 而 A 本来就是盘上的（所以上一版"看起来"守住了死区）
  ```
  ⇒ 一句话：**旧口径守住 A、丢 B；"整份照快照写"守住 B、丢 A**；新口径两个都要。

### 对 6｜反证｜死区读不出来 ⇒ **整次不做**（那 5 份逐字节没变 + 如实播报）

- `_selftest-floor-snapshot.mjs:644`：把 `.dma-deadzones.json` 写成 `{ 这不是 JSON` 之后回档 ⇒
  `blocked==='deadzones-unreadable'`、`moved.length===0`、`wrote===false`、**那 5 份逐字节没变**、`indexRaw()` 不变。
- `:649`：**`last` 不前进**（还指着第 3 楼那一支）⇒ 下一轮还判回档、还试一次（这条是本单顺手修掉的一个**上一版隐患**，
  见 §6 第 1 条）。
- 走真钩子那一遍：`D8c`（笔记保持原样 + 状态文件 `blocked` 如实 + 日志一条）、`D8d`（`last` 没跟）。

### 对 7｜相｜老条目（只有 nodeId）**只读不恢复**

- `:672`：老条目读得出来、`isLegacyFloor===true` / `isRestorableFloor===false`。
- `:678`：回档到老条目那一楼 ⇒ `kind==='back-no-snapshot'`、`wrote===false`、`legacyAtHead===true`、盘上那 5 份没动
  （且**不等于**老条目里记的那段正文 —— 证明真没去读它）。
- `:683`：手动 `restoreFloor({nodeId, variantId:''})` ⇒ `legacy-no-restore`，一个字节都不写。
- `:686`：连"这一楼这一支"都没有 ⇒ `no-snapshot`（⛔ 不许拿老条目顶替成本支的）。
- 真端点：`D7e` ⇒ **409 + `RP_MEMORY_FLOOR_LEGACY`**（下面 §5 有真输出）。

### 对 8｜相｜预置一律不碰（`rulebook.md` / `大纲-*.md` / `*示例.txt`）

- `:705`：任何一次恢复前后，这三份**逐字节不变**（`rulebook.md` 那一次还被模型改过 ⇒ 恢复后**照样是模型那版**：
  我们既不写它、也不"顺手还原"它）；`r.restore.moved.every(isFloorFile)`；清单里从不出现它们。

### 顺带：上一单那八对**回归**（改口径的两条已改写，注释里写了为什么）

| 上一单 | 本单 |
| --- | --- |
| C-1 记录 / 不写盘 / 只存变化那份正文 | 照旧（`C-1相/相b/反证`，另加"条目带变体"） |
| C-2 内容寻址去重 | 照旧 |
| C-3 前进不回档 + **时间戳反证** | 照旧（`byStamp==='rollback'` 而位置说 `forward`，且那个误判**会造成真实改动**） |
| C-4 回档写回 + 备份 + `last` 跟随 + "挖掉恢复那一步必红" | 照旧（`last` 多比一个 `variantId`） |
| C-5 先留"当下"（可撤销） | 照旧（`restoreFloor` 现在带 `variantId`） |
| **C-6 死区** | ★ **改写**：上一版断言"被划死区的 `index.md` 一个字节没被碰"；本单改成"非死区那半回到第 1 楼、死区那段保留盘上现况"（`C-6相`/`C-6 相b`），白名单反证（`C-6反证c`）与预置反证（`C-6反证`）照旧 |
| **C-7 回到没有快照的楼层** | ★ **改写**：上一版断言"什么都不写"；本单按 §1.2 的 b 支改成"退回进楼前（用第 1 楼那份）"，并**保留**原来那一半纪律 —— `C-7反证`：那一轮**没有**顺手把它记成第 2 楼的一份（拿后来的内容冒充会毒掉以后的回档） |
| C-8 用户直接改 ⇒ 快照跟着刷新 | 照旧 + **收窄**：刷新的必须是**当下这一支** `(head.nodeId, head.variantId)`（⛔ 不拿同一楼另一支冒充），老条目连刷新也不写 |

---

## 3 接线纪律的证据（真 HTTP + 真钩子）

| 判据 | 证据 |
| --- | --- |
| 两条钩子同属一个插件 `dsh-memory-archive:floor-snapshot` | **D1** |
| 组装那一脚**不占本轮时间**（`next()` 那一刻还是旧的，让出事件循环后才换回去） | **D2** |
| **每轮至多一次**（同一 turn 里再驱动 / 换 head 都不跑；换一轮 ⇒ 门开着） | **D3 / D3b / D3c** |
| ⛔ 不刷屏（同一个结果只报一条） | **D3d**；**D9b**（"还没有楼层"两轮只有一条） |
| ★ **真钩子的 swipe**：换变体 ⇒ 组装那一脚就把笔记退回进楼前，且那句里**两条变体 id** 都在 | **D4** |
| ★ **真钩子的"回到没有快照的楼层"**：退回进楼前，那句把"回档到第 2 楼"与"用的是第 1 楼那一份"都说了 | **D4b** |
| 轮末才记（`turn/end` + `compaction/end`） | **D5 / D5b / D5c** |
| `GET /floors` 只读：每一支一行 + 变体 + 当前那一支 + `legacyFloors` | **D6 / D6b / D6b2 / D6c** |
| `POST /floors/restore`：带 `{nodeId, variantId}`、老条目 409、部分失败 500 + 明细、不碰会话 | **D7 / D7b / D7c / D7d / D7e / D7f / D7g** |
| 死区判据从**真文档**读：按块合并 + 数据坏掉整次不做 | **D8 / D8b / D8c / D8d** |
| 首轮 head 为空 ⇒ 连快照目录都不建，但如实记一条日志 | **D9 / D9b** |

---

## 4 命令与真实输出

```bash
# 语法（改到的每个文件）
$ node --check lib/floor-snapshot.js && node --check lib/index.js && node --check lib/client.js
（三者均：无输出 = 通过）

# 本单的台子（88 条，含 §2 八对 + 上一单八对回归）
$ node _selftest-floor-snapshot.mjs
== 总结：88 通过 / 0 失败 ==            # exit=0（上一版 61）

# 面板台子（楼层面板那一节按变体级改写）
$ node _selftest-client.mjs
== 总结：121 通过 / 0 失败 ==           # exit=0

# 相邻几单的台子（回归）
$ node _selftest-deadzone.mjs            ⇒ 70 通过 / 0 失败
$ node _selftest-rp-memory.mjs           ⇒ 25 通过 / 0 失败
$ node _selftest-session-playthrough.mjs ⇒ 36 通过 / 0 失败
$ node _selftest-auto-collect.mjs        ⇒ ALL PASS

# 全量门（那个脚本可读可跑，未改；见下面 §6 第 4 条的路径说明）
$ node /d/apps/dsh-tar*配置区/产物/memory-tools/_run-all-selftests.mjs
=== 69 passed / 0 failed ===          # exit=0
```

### 4.1 面板/日志里那句人话（真夹具跑出来的**原文**，贴给用户看口径）

夹具：第 1 楼记一份（`index.md` 里有死区「## 【必须遵守的核心规则】」）→ 第 2 楼记一份 →
**swipe 到第 2 楼第 2 支**（同一楼换变体）+ 模型把 `index.md` 的非死区那段改了 → 轮末那一脚：

```
[mt] 楼层快照：检测到第 2 楼换了变体（swipe 重 roll：variant-qa-2-2-bbb → variant-qa-2-2-bbb-v2）
 ⇒ 已把笔记恢复到第 1 楼的样子（这一楼这一支没记过 ⇒ 退回"进这一楼之前"的样子，用的是第 1 楼那一份）
 （恢复 notes.md、index.md）；跳过/按块合并 index.md（死区那 1 段保留盘上现况、其余照快照回档）、
 state.md（那一楼本来就没有这份）、characters.md（那一楼本来就没有这份）、world.md（那一楼本来就没有这份）；
 ⛔ 预置那几份没动
```

同一夹具的盘面与清单（真输出）：

```
③ 盘上 index.md 现在是什么（死区块保留盘上现况、其余照快照）：
   "## 【必须遵守的核心规则】\n- 不许替玩家做决定（作者写的）\n\n# 最近进展\n第 1 楼：开局\n"
④ 面板清单（每行一支）：
[{"seq":1,"variantId":"variant-qa-1-1-aaa","current":false,"sameNode":false,"legacy":false,"deadzone":["index.md"]},
 {"seq":2,"variantId":"variant-qa-2-2-bbb","current":false,"sameNode":true,"legacy":false,"deadzone":["index.md"]},
 {"seq":9,"variantId":"","current":false,"sameNode":false,"legacy":true,"deadzone":[]}]
⑤ 老条目：legacyFloors=[{"nodeId":"qa-9-9-old","seq":9}]
   点它恢复 ⇒ {"code":"RP_MEMORY_FLOOR_LEGACY","message":"这一楼只有老记录（只有 nodeId、不知道是哪一支）⇒ 老记录只读、不许拿来恢复 ⇒ 笔记保持原样"}
```

---

## 5 上一版报告里那两条"没做/不确定" **要如何更新**（如实改，⛔ 不留旧结论）

- 上一版第 **3** 条：「**同一节点换变体（swipe 重 roll 同一楼）不触发恢复** —— 我按 §2.2 的字面口径（判据 = `head.nodeId`）……
  如果用户要"换变体也跟随"，那是另一条判据（需要变体级的快照），请派单方定。」
  ⇒ **作废并改成**：用户已拍板 **算回档**；本单已实现**变体级快照**（`(nodeId, variantId)`），换变体时
  按 a/b/c 顺序恢复（这一支有 ⇒ 用它；没有 ⇒ 退回进楼前；连前一楼也没有 ⇒ 什么都不动并如实播报）。
  台子 **§2-2相 / §2-3相 / D4** 就是这条的绿；**§2-2反证 / §2-3反证** 是"改回旧判据"的红。
- 上一版第 **4** 条：「**死区名单压过那 5 份（我做的一个解释性选择，请拍板）** —— …… 如果用户希望"划了死区的笔记也照常按楼层恢复"，
  把 `planRestore` 里 `deadzone` 那一行去掉即可。」
  ⇒ **作废并改成**：用户选了**按块合并**，而且**不是**把那行去掉 —— 是把它换成"逐块裁决"：
  死区块**保留盘上现况**（⛔ 永不自动还原，连回档也不写它）、同一份文件里其余部分**照快照回滚**；
  盘上找不到那条死区就**不补回**。`skipped[].reason === 'deadzone'` 的语义随之改成"该文件有死区、已按块合并"，
  文案里**不再出现**"整份跳过"那种会误导的话（`lib/index.js:4628`、`lib/client.js:2325`）。
  台子 **§2-5相**（绿）与 **§2-5反证①②**（"整份照快照写" / 上一版"整份跳过"两种口径都必红）是这条的证据。
- 上一版其余各条**不变**（第 1、2 条仍是"真机验证归派单方、本单未碰实机"；第 5–9 条照旧）。

---

## 6 本单没做 / 不确定（明确列出）

1. **顺手修掉一个上一版的隐患（本单改了，故如实说明）**：上一版在"死区数据读不出来 ⇒ 整次不做"之后，
   `last` **照样跟到目标楼层** ⇒ 下一轮会被判成 `same`，而笔记还是旧内容 ⇒ **记录侧会拿它盖掉目标那一份**
   （把回档的目标毒掉）。本单把"被挡住"并入"写失败"同一条纪律：**`last` 留在原地**（下一轮还判回档、还试一次；
   回执有指纹门，不会刷屏）。证据：`lib/floor-snapshot.js:859`（`failed.length === 0 && plan.blocked === null` 才前进）、
   台子 **§2-6反证b** 与 **D8d**。
2. **第一楼的"非第一支"不会被单独记一份** —— 第一楼 swipe 之后：这一支没记过、**连前一楼也没有** ⇒ 按
   §1.2 的 c 支"什么都不动"，**也不记**（与上一版"⛔ 不许顺手记一份"同一条纪律，那一轮的内容不是这一支跑出来的）。
   要它被记，就等这一支往前走之后的那一轮（`forward` ⇒ 记）。台子 **§2-7相b**/**C-7反证** 钉的是这条纪律本身。
   ⚠️ 如果用户希望"第一楼 swipe 之后**立刻**把当下记成这一支的一份"，那是另一条口径（要派单方定）。
3. **"死区块在盘上被整段删掉"时**：那一块**连着它自己那段空白一起不写回**（结果里不留多余空行），
   并按"盘上找不到 ⇒ 不补回"如实播报。这是 §1.3 的字面口径；**没有**把它挪到别处、⛔ 也不从快照恢复它。
4. **"盘上有、快照里没有"的死区块**：不能让"整份覆盖"把它带走 ⇒ **保留在末尾**并如实播报
   （位置无从得知 —— 按块派生的顺序里它没有落点；台子 **A6c** ④）。⚠️ 这是我在任务书没写到的边角上做的**最小**选择，
   请派单方/用户过目：如果希望"这种情况干脆不写这一份"，改一行即可。
5. **真机上的三条（划一楼 / 回档 / swipe）本单未核** —— 按派单口径（§3）部署与真机验证归派单方；
   本单**一次没碰实机**（宿主 :3080、`C:\Users\w\.dsh`、用户 RP 工作区 `D:\apps\dsh-tarven` 全都没碰）。
   我改的是宿主进程里的模块 ⇒ 需要 `_sync-plugin-deploy.mjs --apply --prune` + **重启宿主**之后才生效。
6. **全量门的路径** —— 派单给的字面路径会被本次派单的守卫整条拒掉，所以照本仓既往报告的做法用
   **glob 形式** `/d/apps/dsh-tar*配置区/产物/memory-tools/_run-all-selftests.mjs` 走到**同一个脚本**（未改一个字节），
   `exit=0`、`69 passed / 0 failed`。
7. **`node --check _selftest-client.mjs` 会报 BOM** —— 既有状态（`git show HEAD:` 出来头三字节就是 `EF BB BF`），
   本单没动那一行；`node _selftest-client.mjs` 直接跑正常（121/0）。
8. **没做的事**（都不在本单范围内）：⛔ 没 commit / 没 push / 没部署 / 没重启任何宿主 / 没装进任何 profile；
   ⛔ 没碰 `lib/deadzone.js`（只 import 它的 `sha256Hex` / `writeWithBackup` / `splitBlocks` / `locateZone`）；
   ⛔ 没碰 collect 链、预设 YAML、`lib/ami-tags.js`、老端点的语义与状态码；⛔ 没起新版本号。

---

## 7 本单自己踩到的坑（留给后人，也是台子"会咬人"的证据）

1. **`seqMapOf` 差点被"顺手重写"改了口径** —— 我把"楼层序号"那一步重构成 `nodeOrderOf` 的副产物（按**去重后的顺序**编号），
   台子 **A2** 立刻红：`{nodes:[null,{id:'a'},{id:'a'},{id:'b'}]}` 里 `b` 的"位置"该是 **4**（重复/畸形条目也**占位**），
   不是 2。修法：`nodeOrderOf`（给"紧邻前一楼"用，去重先到者胜）与 `seqMapOf`（给"位置"用，**不压缩编号**）各归各的。
2. **`seat()` 自己带"第 N 楼"** —— 我写成 `` `检测到第 ${seat(seq)} 楼换了变体` `` ⇒ 日志里出现"检测到第 **第 2 楼 楼**换了变体"。
   是**真机口吻的样例脚本**抓出来的（台子的断言只匹配了 `'换了变体'`，没咬住叠字）。修法：改模板，并在 **D2b / D4** 各加一条
   "那句里不许出现 `第 第` / `楼 楼`"的断言。
3. **死区那个判据的入参从"文件名数组"换成"整条 zone"** 是本单的关键改动：`planRestore({deadFiles})` → `planRestore({zones})`，
   并且 **`undefined` 与 `null` 同义 = 判据未知 ⇒ 整次不做**（⛔ 不许因为调用方忘了带就退化成"那就整份写"）。
   台子 **A6b** 把这两种都钉上了。
