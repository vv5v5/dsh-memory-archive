# 许可说明 · `state-bridge/` 子目录

本目录**原为独立插件 `dsh-state-bridge`**（自研，MIT），于 **2026-09-15** 收编进 `dsh-memory-archive`
（用户决策：包内子目录布局）。

## 许可（两段式，别混）
| 范围 | 许可 | 依据 |
|---|---|---|
| `state-bridge/` 子目录内的全部代码 | **MIT** | 原包 `LICENSE`（已随目录保留：`state-bridge/LICENSE`） |
| 本仓库其余部分 | **CC-BY-NC-4.0** | 仓库根 `LICENSE` |

⇒ 对外分发时请**同时**保留这两份许可声明：MIT 部分必须保留其版权与许可声明（MIT 的硬要求），
其余部分适用 CC-BY-NC-4.0。收编**不改变**任何一段代码的既有许可。

## 收编口径（为什么是"逐字节复制"）
- `state-bridge/lib/*.js` 与 `state-bridge/tests/*.mjs` 是原包的**逐字节副本**（13 个文件 sha256 全等，收编当时核过）。
- `state-bridge/tests/` 里的 `../lib/...` 导入因此**无需改动**，`node --test state-bridge/tests/*.test.mjs` 在新位置即可跑（收编当场 **70 pass / 0 fail**）。
- 挂载：由本仓库 `cordis.patch.yml` 的 `state-bridge` 行负责（子路径导出 = `dsh-memory-archive/state-bridge`）。
