# Changelog

本文件记录本插件的显著变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [0.2.0] — 2026-10-07

### 新增

- **工具→插件归属**（`items[].providedBy`）：四值域 `plugin` / `core` / `mcp-server` / `unknown`，
  每条附置信度与判定手段；静态扫描 profile 与 DSH 核心两处包源码，扫不到如实记 `unknown`，**绝不猜**。
- **可执行裁剪清单**（`findings.prunePlan`）：按**可卸载单元**（profile dependencies ∩ dsh.profile.bundles）
  聚合，含 `usedToolCount` 让卸载代价可见；定性为"从未被模型调用的候选"而非"卸载建议"。
- **工具级隐藏候选**（`findings.hidePlan`）：不卸载插件、仅从模型可见性移除工具即可收回常驻成本；
  含可粘贴 deny 清单、`registryUse` 逐候选判定、恢复路径，并明确"两个动作的 token 绝不相加"。
- **面板**：composer 工具行的账本控件 + 展开面板，按层级呈现总览 / 对账清单 / 四类明细 /
  裁剪候选 / 隐藏候选 / 恢复路径。
- 契约升 v3（`DESIGN.md`），新增文件归属矩阵与决策信封两节。

### 修复

- **面板必崩缺陷**：含 hook 的组件被当普通函数调用且位于条件分支内，展开面板即触发
  React `Rendered more hooks than during the previous render`。改为独立组件实例并加静态守卫。
  该缺陷此前穿过了三份验证报告合计 1000+ 条断言——它们只验证了 bundle 加载与落座，
  从未在浏览器里真正展开过面板。
- **测试套件偶发失败**：E2E③ 会重读一个正在被并发写入的活会话日志并断言两次读取相等。
  改为全部使用冻结副本；并用 A/B 并发夹具反证（旧版 9 轮 7 次失败 → 新版 0 次失败）。

### 变更

- canonical 输出的 `version` 常量：`1` → `2` → `3`。
- **不兼容变更**：`items[].providedBy`、`scope.providerScan`、`findings.prunePlan*` 与
  `findings.hidePlan*` 系列为新增必需字段；`ReconcileInput` 收敛为单一调用次数通道。

---

## [0.1.0] — 2026-10-07

### 新增

- 初始版本：四类常驻注入物（指令链 / 技能目录 / 内置工具 schema / MCP 工具）的 token 成本，
  与会话日志中的真实调用次数对账，产出**每次使用成本**排序与**零调用标记**。
- 只读：会话日志仅读行类型与 `tool/call` 的工具名，不接触任何载荷字段。
- 零第三方运行时依赖。

---

## 关于已知缺陷

本插件刻意把"未知"与"已知"分开呈现，同理，其自身缺陷也如实记录在
[README 的「已知缺陷与实现边界」](./README.md#已知缺陷与实现边界)一节。请在那里查看当前状态。
