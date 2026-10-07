# Changelog

本文件记录本插件的显著变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [0.3.0] — 2026-10-07

### 新增

- **三态调用口径**：`items[].calls`（窗口总调用）之外新增 `currentSessionCalls`（**当前会话**调用数）、
  `sessionsWithCalls`（**覆盖会话数**——该工具在扫描的 N 个会话里被多少个会话调用过）、
  `callPresence`（`current-session` / `historical-only` / `absent` / `null`）。
  **答的是"到底是没用，还是只是最近没用"**——此前只有窗口口径时，一个在更早会话里用过、
  最近 20 个会话里没用过的工具会被列进"零调用候选"，无从分辨。
- **窗口边界显式化**：`windowStart` / `windowEnd` 由"可为 null"收紧为**不变量**
  （`sessionsScanned ≥ 1 ⟹ 非 null`）；新增 `windowBasis="session-log-mtime"`
  与 `sessionsOutsideWindow`，并新增 `scope.currentSession`。
  窗口只覆盖 `sessions` 参数指定的会话数（默认 20，上限 200），**不穷尽磁盘**。
- 面板字号改为对齐 DSH 的 `--dsw-font-*` token 阶梯（`xxxs-11`/`xxs-12`/`xs-13`/`s-14`/`l-20`），
  主力正文 **10.5px → 12px**，硬编码像素 **43 处 → 0 处**，行高逐档同步。

### 变更

- canonical `version` `3` → `4`（新增必需字段 = 形状变更）。
- `zeroCall` **语义不变**（仍是窗口内零调用）；`tokensPerCall` 仍按 `calls` 计算。

### 说明

- **"不可得"与"0"严格分开**：当前会话不可判定时 `currentSessionCalls` 为 `null`，**不是 0**。
  "不知道"和"零调用"是两回事，把它们混起来会直接误导判断。
- **零新增读取通道**：新增维度与既有计数**共用同一次日志扫描**，仍只读行 `type` 与
  `tool/call` 的 `data.name`；**没有**为"最近调用时间"去读日志时间戳。

### 修复

- **C4**：`DESIGN.md` §2.21 的冻结示例违反 §2.19 的升序规定（`@nanmicoder/...` 排在
  `@linxin666/...` 之前）。已修正，并将该排序点补进 A 清单（A1–A17 → A18）——
  这处违规此前**不在清单里**，所以自检拦不住它。
- **C5**：§2.21 的测试夹具是**写死的字面量**，DESIGN 改动后它会**静默过期**。
  已加入内容指纹，使漂移变成**显式测试失败**（并已验证：改值 / 反转数组顺序 / 改指纹常量末位
  ⇒ 各自显式红；仅改格式 ⇒ 不误报）。
- `test/host.test.js` 一处硬编码复数字面量 `\d+ items` 改为 `\d+ items?` ——
  该断言会在真实数据恰为 1 个零调用项时**无端变红**（相邻行本来就是 `\d+ units?`）。

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
- **右侧栏承载位置**：点击控件**优先打开右侧栏**（宿主原生 tab，`ctx.sidebarRight.openTab`），
  并在同一步展开；**内容与就地浮层零分叉**（共用取数路径与文案）。缺该服务/开栏失败时
  优雅回退到浮层，控件永不是死按钮。
- 契约升 v3（`DESIGN.md`），新增文件归属矩阵与决策信封两节。

### 修复

- **B1（真机不可用级）**：`probeRestrict` 以 `Array.isArray` 判定 `restrictableNames` 可用性，
  而宿主真实返回 **`Set`** ⇒ 真机恒判"接口缺失"，`hidePlanStatus` 恒 `unsupported`、
  可粘贴 deny 清单恒为空，R6 核心交付物在真机上不生效。
  修复：改为共享的 `normalizeNameCollection`（Set/Array 均接受、其它→null）；测试夹具默认改用
  **与宿主一致的 Set**。并新增一条**只读宿主源码的类型对拍用例**——宿主将来改类型会显式失败，
  而不是套件继续绿。该缺陷此前穿过了三份验证报告合计 1000+ 条断言，因为夹具自己造了数组型接口：
  **夹具与实现自洽，但实现与宿主不一致。**
- **面板必崩缺陷**：含 hook 的组件被当普通函数调用且位于条件分支内，展开面板即触发
  React `Rendered more hooks than during the previous render`。改为独立组件实例并加静态守卫。
  该缺陷同样穿过了上述 1000+ 条断言——它们只验证了 bundle 加载与落座，从未在浏览器里真正展开过面板。
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
