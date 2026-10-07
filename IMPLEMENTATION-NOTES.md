# 实现纪要 · 契约澄清与已知缺口

本文件记录实现线在施工中发现、**不属于设计变更**的契约澄清，以及队长对每条的裁定。
验证线（t4）必须按本文件的裁定口径执行，不得自行另立标准。

---

## F1 · S3 白名单缺 `id` 规则

**发现方**：实现宿主（t2）
**事实**：DESIGN §3.4 的 S3 白名单未给 `id` 留规则。§2.4 规定 `id = "<category>:<name>"`，含 `:`，无法通过 `NAME_PATTERN=/^[A-Za-z0-9_.-]{1,128}$/`。按字面规则执行会把自己的合法输出判为违规。
**实现方处置**：在 `test/whitelist.js` 中补了 `<category>:` 前缀规则，未改设计、未改产品代码。

**队长裁定：接受，但验证线必须独立确认它没有开出漏洞。**

理由：
- `NAME_PATTERN` 的管辖对象是**来自日志的常驻项名字**（用于挡住畸形名字导致的假零调用），不是 canonical `id`。两者混用是设计的疏漏，不是实现的越权。
- 关键安全性论据：`id` 由 `category` + `name` 拼接而成，二者**均来自声明侧**（`ctx.tools.schemas()` / `ctx.skills.list()`），**不来自日志载荷**。因此给 `id` 单独开规则不会让任何日志内容进入产物。

**验证线必须做的**：独立确认上述论据成立——即 `id` 的两个组成部分确实只来自声明侧，且在真实日志下 S3 依然零违规。若发现 `id` 任何一部分可被日志载荷污染，**F1 判定反转，此项即为不通过**。

---

## F2 · §7 的 `ReconcileInput` 没有承载回放计数的字段位

**发现方**：实现宿主（t2）
**事实**：DESIGN §7 冻结的 `ReconcileInput = { cwd, sessionsRoot, scope: Omit<scope,"usageAvailable">, items, findingsLimit? }` 中**没有任何字段可以传入调用计数**；而 §7 同时规定 `calls`/`tokensPerCall`/`zeroCall`/`usageBasis` 一律由 `reconcile` 赋值。即：契约要求 reconcile 赋值，却没有给它赋值的输入通道。这是设计的**真实缺口**，不是实现的问题。
**实现方处置**：接受顶层 `callsByName` 或 `scope.callsByName`，并额外容忍 `item.observedCalls` / `item.calls` 作为输入；未改设计。

**队长裁定：v1 接受现有实现，但记为 DESIGN v2 待办。**

理由与保留：
- 缺口客观存在，实现必须选一条路走，接受现状是合理的，不值得为此卡住 v1。
- **但容忍多条输入通道是真实的坏味道**：§7 的原则是"单点真理"，多通道会让未来调用方（例如 HTTP 路由与工具入口）各走一条路而不自知，一旦行为分歧极难定位。
- **DESIGN v2 必须收敛为单一通道**。

**验证线必须做的**：确认多通道容忍**不会导致行为分歧**——即同一份数据从不同通道传入时，`calls`/`tokensPerCall`/`zeroCall` 结果一致。不一致即为缺陷。

---

## F3 · `formatBytes(n): number` 是笔误

**发现方**：实现宿主（t2）
**事实**：§7 把 `formatBytes` 的返回类型写成 `number`，但按语义它是展示字符串（如 `"1.2 KB"`）。
**队长裁定：确认为笔误，实现按字符串返回是正确的。** 无需修改设计即可放行，DESIGN v2 一并订正。

---

## 已知缺口（队长已判定，不在本次修复范围）

| 项 | 状态 | 理由 |
|---|---|---|
| `package.json` 的 `files` 列了 `README.md` 但文件不存在 | **已由队长补齐** | 见仓库 `README.md` |
| 仓库不在任何 git 仓库内，无法提交 | **已由队长处理** | 按用户裁定「工作区新建仓库，先不建远端」执行 `git init` |
| `truncated` / `namesRejected` 以英文字段名直接呈现在中文面板证据行 | 维持原样 | DESIGN §4.5 键集已冻结，自行造键才是越线；为仅在扫描被截断时出现的边缘态升契约版本不划算 |
| DESIGN v2 需订正：§7 输入通道收敛、`formatBytes` 返回类型 | 待办 | 见 F2 / F3 |

---

## 验证线的口径约束（汇总）

1. F1 的 S3 白名单扩展口径**沿用** `test/whitelist.js` 的 `<category>:` 前缀规则，但必须独立验证其安全性论据（见 F1）。
2. F2 必须验证多通道一致性（见 F2）。
3. 隐私终审口径：**禁止访问任何工具参数**（`data.arguments`）。逐技能次数保持 `calls=null` / `unobservable`；技能维度只允许分类级 `mechanismCalls` / `mechanismTokensPerCall`。DSH 只有单一 `skill` 工具、技能名位于其参数中（`dsh-tool-skill/lib/index.js:60-65`），已在 DESIGN §6.1 否决"读参数取技能名"方案，队长确认为终审。
