# dsh-context-ledger — t17 独立复核报告（R6 面板 / §4.8）

> 复核人：验证（AgentTeams 成员）
> 任务：`t17 [verify]` · kind=review（round 4，绑定 t15）· attempt `4c52d0c9-1397-4f6e-b9e1-2d743c4ce980`
> 复核基线：`5616fbc`（feat(R6): 工具级隐藏候选（宿主半区 + 面板）+ 队长裁定；工作树 clean）
> 判定基准：DESIGN **v3** §4.8（七条呈现义务）+ §3.7 / §2.19 / §2.22 / §2.24 / §6 第 11 条 / §9
> 方法：沿用 `VERIFY-T9.md` 的严格方法——**不读词典**，执行渲染函数后遍历整棵渲染树，
> 穷举文本节点 + `title`/`aria-label`/`placeholder`/`alt`/`aria-description` + 颜色引用。
> 纪律：未修改任何实现/测试/DESIGN 文件；未触碰 `~/.dsh/**` 与 DSH 安装目录；未启动 web 服务。

---

## 0. 结论

**verdict = pass**

R6 面板（§4.8）在**渲染树层**逐条落地，两轮新风险（"建议≠已施加"、"两动作 token 不相加"）均通过；
对抗性措辞穷举在 zh/en 各 **117 条受审文案 + 各 6 条属性型文案**上**零命中**。

| 验收项 | 结论 | 证据 |
|---|---|---|
| 对抗性措辞穷举（最高优先） | ✅ | 渲染树穷举 zh/en 各 117 条受审文案；确定性/贬损词命中 **0**；整屏无 error(红) 色（§1） |
| **建议 ≠ 已施加** | ✅ | 4 种状态矩阵 + "有清单≠已施加"组合；未知 mode 保守回落；完成态措辞 0 命中（§2） |
| **两动作 token 不相加** | ✅ | 渲染树 + **哨兵法**（面板根本不消费两个总额）；和 864 全屏不存在；段内显式硬规则（§3） |
| registryUse 不确定性如实 | ✅ | 每行同时给 verdict 与"DSH 无法观测非模型的注册表调用"；未写成"没被调用"（§4） |
| caveat 五条常驻/不可折叠/非 tooltip | ✅ | 6 种状态 × 2 语言：容器恒 1 个、条目恒 5 条、位于段底、无 title/onClick/hidden（§4） |
| 恢复路径可查 | ✅ | 六行齐全（含"没有撤销命令""不写配置""不追溯"）；未宣称"一键恢复/自动回滚"（§5） |
| §4.8 第 1/2/5/6 条 | ✅ | 标题逐字 zh/en；每行五件事实；未校验→提示条且**无复制按钮**；selfTool 提示（§6） |
| zh/en 同键、既有键未删改 | ✅ | 99 = 99 键；v2 的 54 键**值一字未改**；v3 新增 45 键两语言齐全（§7） |
| `node --check` / 面板套件 | ✅ | exit 0；`test/client-panel.test.mjs` 40/40（§9） |
| 不凭单次全绿 | ✅ | 连续 12 次全量：12/12 均 139/139 pass、0 fail、0 skipped（§9） |
| 改动范围 | ✅ | `client.js` **+556/-0**（纯追加）；`test/client-panel.test.mjs` +1590/-8（§9.3） |

我自己的三套脚本：`panel-audit-r6.mjs` **210 passed / 0 failed**、`real-panel-r6.mjs`（真实数据）全绿、
`pruneplan`/契约夹具比对 13/13 SAME + A1–A17 全 PASS。

非阻断观测 6 项（§10）：其中 **O1 是 DESIGN §2.21 示例自身的缺陷**（`nameReferencedElsewhere` 未按
§2.19 要求升序），**与 t15 的实现无关**（宿主侧实现排序正确，我在 t16 已实测）。

---

## 1. 对抗性措辞穷举（最高优先）—— ✅ 零命中

### 1.1 方法（不读词典，读渲染树）

执行 `client.js` 的 `LedgerPanel`（含 R6 三段），然后遍历整棵树收集：

- 所有**文本节点**；
- 所有可能上屏的**属性文本**：`title` / `aria-label` / `placeholder` / `alt` / `aria-description`（tooltip 是逃逸口）。

夹具覆盖高风险形态：`context_ledger` 自身（selfTool）、MCP 单元、core/unknown 单元、
未通过预校验的候选（`restrictable:false` + 原因）、`nameReferencedElsewhere` 非空的候选。

```
=== B · 对抗性措辞穷举（渲染树层，zh/en）===
  [zh] 受审文本 117 条（豁免契约强制句 3 条）
  [zh] 可见文本片段 120 条 / 属性型 6 条
  [en] 受审文本 117 条（豁免契约强制句 3 条）
  [en] 可见文本片段 120 条 / 属性型 6 条
  整屏颜色引用: [... "var(--dsw-alias-state-warn-primary, #e0a83a)"]
  PASS B1 zh 无确定性/贬损措辞
  PASS B1 en 无确定性/贬损措辞
  PASS B2 整屏不引用宿主 error(红) 色
  PASS B3 zh 说明"隐藏后模型无法再调用（注册表级）而非仅藏起来"
  PASS B4 en 同义说明
```

> **豁免说明（不是放水）**：豁免的 3 条是契约**强制**的否定/限制句——
> §4.7 的「不代表没用」、本轮 §2.23.4 的「本插件不会自动施加（appliedNames 为空）」、
> §3.7 的「不得相加（不是两笔收益之和）」。朴素子串扫描会把它们误报；
> 剔除后仍覆盖全部 117 条文案。

### 1.2 禁止词表（zh/en 双向，命中 0）

```
zh: 建议隐藏 / 安全移除 / 零损失 / 无损失 / 可以删掉 / 浪费 / 无用 / 没用 /
    直接隐藏 / 应该隐藏 / 放心 / 不再需要 / 没价值 / 可以隐藏掉
en: recommend hiding / safe to hide / safe to remove / zero loss / no loss /
    you can delete / waste / useless / should hide / feel free to hide /
    no longer needed / worthless
→ 命中 []
```

### 1.3 危险色

整屏颜色引用（节选）：`label-primary / label-secondary / label-tertiary / bg-layer-1 / bg-layer-2 /
border-l2 / border-l3 / brand-primary / state-warn-primary`。
**无 `state-error-primary`（红）**。琥珀（`state-warn-primary`）只出现在
`hideWarnStyle`（selfTool 提示、"无法通过卸载移除"、"没有撤销命令"、"本插件不写配置"、
剪贴板不可用提示）与 `referencedElsewhere` 标签上——全部是**降低行动冲动**的注意色，
与被禁止的"用红色告警暗示危害"方向相反（与 `VERIFY-T9` 的 O2 判读一致）。

### 1.4 真实数据上屏（不是只有合成夹具）

用真机日志 + 真机 profile 声明面产出 v3 报告后渲染：

```
=== 真实数据上屏（zh）：R6 三段 ===
  候选行数 = 19
  提示条 = 1（status=unsupported）
  复制按钮 = 0
  caveat 容器 = 1 / 条目 = 5
  恢复行 = ["step1","step2","step3","subagent","no-undo","readonly"]
  并列行 = 8
  施加方式行 = "施加方式：仅建议：本插件不会自动施加（appliedNames 为空） · 19 个名字未施加（接口缺失或名字不可限制）"
  registryUse 行 = "该功能是否经注册表被调用：未确认 · DSH 无法观测非模型的注册表调用"
  确定性/完成态措辞命中: []
  §2.22 不得相加声明在屏: true
  §2.24 无撤销命令声明在屏: true
  §2.19 五条 caveat 在屏: true
```

（en 侧同款结论：`确定性/完成态措辞命中: []`、不得相加 `true`、无撤销命令 `true`、caveat `true`。）

---

## 2. 不得把"建议"渲染成"已施加" —— ✅

四种状态 + 一种高危组合，逐条看**上屏那一行**：

```
=== C · 建议 ≠ 已施加（本轮新增风险，逐状态矩阵）===
  [suggestion-only（默认）]     施加方式行 = "施加方式：仅建议：本插件不会自动施加（appliedNames 为空）"
  [applied-by-config]          施加方式行 = "施加方式：按你自己的配置施加（来自 profile patch，不是本插件自动决定） · 已施加 2 个名字"
  [未知 mode（保守回落）]        施加方式行 = "施加方式：仅建议：本插件不会自动施加（appliedNames 为空）"
  [缺 hideApply（旧形状）]       施加方式行 = "施加方式：仅建议：本插件不会自动施加（appliedNames 为空）"
```

- 非 `applied-by-config` 的三种状态下：文案明写"本插件不会自动施加（appliedNames 为空）"，
  且**全屏不出现**"已施加 N 个名字"（`C2/C3` 通过）。
- `applied-by-config` 下：明写**来源是 profile patch**、"不是本插件自动决定"，并如实给出数量（`C4/C5`）。
- **未知 mode 与缺字段都保守回落到"仅建议"**（`hideApplyOf`/`applyModeText` 的 fail-safe，
  `client.js:782-787`、`client.js:881-895`）。

**最高危组合单列**（`mode=suggestion-only` 但 `denyList` 非空——"有清单"最容易被读成"已施加"）：

```
  PASS C7 有可粘贴清单但仍明说未施加
  PASS C8 清单以"可粘贴清单（2 个名字）"呈现（不是"已隐藏"）
  PASS C9 不得出现"已隐藏"/"隐藏了 N 个"/"已经隐藏"之类完成态措辞
```

清单标题是「**可粘贴清单**（2 个名字）」——语义落在"给你粘，不是替你施"。
全屏也**没有**"已隐藏/已为你隐藏/已经隐藏"这类完成态措辞。

---

## 3. 两个动作的 token 不得相加（§3.7 / §2.22 第 3 条）—— ✅

夹具：`hidePlanTokens = 764`（4 个单元）且 `prunePlanReclaimableTokens = 100`（1 个单元），两者之和 `864`。

```
=== D · 两个动作的 token 不得相加（渲染层）===
  hidePlanTokens=764 prunePlanReclaimableTokens=100 之和=864
  并列单元行数 = 4
  hide 行: ["隐藏这 1 个工具可省 100 token（代价：这些名字注册表级不可用；须人工确认）",
            "隐藏这 1 个工具可省 214 token（…）","隐藏这 1 个工具可省 400 token（…）","隐藏这 1 个工具可省 50 token（…）"]
  prune 行: ["卸载该单元可省 100 token（代价：失去 1 个在用工具，以及该单元的 UI/后台功能）"]（无卸载口径 3 行）
  no-sum 行 = "两种动作互斥：隐藏的可省 token 与卸载的可省 token 不得相加（不是两笔收益之和）"
```

- `D1` 整屏文本**不出现 864**；
- `D2/D3` **哨兵法**：把 `hidePlanTokens`/`prunePlanReclaimableTokens` 改成不可能由条目推出的魔数
  （`987654` / `123456`），渲染结果**一次都不出现** ⟹ 面板**根本不消费这两个总额**，
  因而在结构上不可能求和（与 t15 的 G4 静态断言独立互证）；
- `D5/D6/D7` 每个单元一行、hide 行与 prune 行各自带**各自的** token 数，绝不合并；
- `D8/D9` 段内显式写出硬规则（`data-cl-hide-no-sum`），文案明说"互斥"、"不得相加"、"不是两笔收益之和"；
  en 侧为 `never add the hide tokens to the uninstall tokens (they are not two separate savings)`。

---

## 4. registryUse 的不确定性 + caveat 常驻 —— ✅

```
=== E · registryUse：不确定性不得渲染成确定事实 ===
  [zh] verdict 行 = "该功能是否经注册表被调用：未确认 · DSH 无法观测非模型的注册表调用"
  [en] verdict 行 = "is this feature used via the tool registry：unconfirmed · DSH cannot observe non-model registry calls"
  PASS E1/E2/E3/E4（两种语言）
```

- 每行的 `registryUse` 必须**同时**给出判定与证据边界（§2.19 硬规则 2）——
  "未确认" + "DSH 无法观测非模型的注册表调用"同屏出现；
- **把扫描限定在 hide-plan 段子树**后，该段内不存在"未被调用/没有被调用过/确认未使用/一定没被"
  之类把"没查到"写成"没被调用"的断言（`E2` 通过）；
  全屏唯一的"未使用"是 prunePlan 段契约强制的条件语「**若**未使用可省 100 token」（信息性输出已列出）；
- `nameReferencedElsewhere` 只作**证据**呈现，且带"需人工确认"标记（`E3`），
  未被写成"被调用过"（`E4`）。

caveat 常驻（6 种状态 × 2 语言，共 12 组）：

```
  [有候选/已校验] caveat 容器 1 个 / 条目 5 条        [空候选] 1 / 5
  [未校验] 1 / 5                                     [不支持] 1 / 5
  [降级态（usageAvailable=false）] 1 / 5              [缺 hidePlanStatus（旧形状）] 1 / 5
  （zh / en 各一遍，全部 PASS F1–F10）
```

- `F3` 五条键名与 §2.19 逐一对应：`registryHideIsTotal` / `nonModelRegistryCalls` /
  `serviceCoupling` / `confirmationRequired` / `prefixCacheCost`；
- `F4/F5/F6` 容器**无 `title`**（非 tooltip）、无 `onClick`/`href`（不可点击隐藏）、无 `hidden`/`display:none`；
- `F7` 容器是 hide-plan 段**最后一个子节点**（段底常驻）；`F8` 不在任何 `button/details/summary` 内；
- `F9/F10` 五条**语义真的在屏**（"注册表级"、"人工确认"、"prompt cache 一次性失效"），不是空壳。

面板实况（zh）：

```
· "代价与不确定性（常驻本节底部）"
· "隐藏是注册表级的：该名字在该 agent 作用域内不可见、也不可解析——不是只从 schema 里抹掉"
· "非模型的注册表调用没有观测面：DSH 看不到这类调用"
· "功能是否由独立服务提供（UI/后台不经注册表）静态不可判定，须逐单元人工确认"
· "施加前必须人工确认；本插件不代替用户确认"
· "任何隐藏都会改变请求前缀，导致 prompt cache 一次性失效（一次性成本，不是持续成本）"
```

---

## 5. 恢复路径可查（§2.24）—— ✅

```
=== K · §2.24 恢复路径 ===
  恢复行: ["step1","step2","step3","subagent","no-undo","readonly"]
  PASS K1 恢复行键集
  PASS K2 如实说明不存在撤销命令
  PASS K3 如实说明本插件不生成/不修改/不备份配置
  PASS K4 如实说明已运行 agent 不追溯
  PASS K5 给出具体恢复动作（hide.apply 改回 false / 从 deny 删名字）
  PASS K6 不得宣称"一键恢复/自动回滚"等不存在的能力
  PASS K7 en 同义
```

上屏原文（zh）：

```
· "如何恢复（隐藏来自配置；本插件不提供撤销命令）"
· "1. 在 <profile>/cordis.patch.yml 的 `- id: context-ledger` 条目里把 hide.apply 改回 false；只想恢复个别工具就从 deny 里删掉那些名字"
· "2. 重载：启用了 HMR 时保存即生效（限制挂在 effect 层，释放即解除）；否则重启对应 profile"
· "3. 已在运行的 agent / 子代理不追溯（限制只在创建时施加），重启即消失"
· "子代理载体：把描述符里的 toolFilter 去掉；新子代立即不受限"
· "没有“撤销上一条隐藏”的命令；恢复就是把配置改回去"
· "本插件只输出片段：不生成、不修改、不备份你的配置文件"
```

契约里最容易"被悄悄说反"的两条边界都**如实**落地且是显式否定句：
**不存在撤销命令**（`no-undo`）、**对已运行 agent 不追溯**（`step3`）。

---

## 6. §4.8 其余条款 —— ✅

| 条 | 断言 | 结果 |
|---|---|---|
| 第 1 条 | 段标题逐字：zh「可隐藏候选（工具级）· 需人工确认」/ en `Hide candidates (tool level) · needs your call` | PASS I1（两语言） |
| 第 2 条 | 每行五件事实各有独立节点：`data-cl-hide-name` / `-tokens` / `-unit` / `-verdict` / `-precheck-text`，各 = 行数（4） | PASS J1/J2 |
| 第 2 条 | 未通过预校验的行给出**原因**（"不在该 agent 的可限制名字集合里"） | PASS J3 |
| 第 5 条 | `prechecked`+清单非空 ⇒ 复制按钮 1 个、无提示条；`prechecked`+空清单 ⇒ 0/0；`unvalidated`/`unsupported`/缺字段 ⇒ **0 个复制按钮 + 1 条提示条** | PASS G1/G2/G3（5 组） |
| 第 6 条 | `selfTool===true` 的行恰为 `context_ledger`，且显示「隐藏后模型将无法再调用本账本」（en `removes the ledger as a callable tool for the model`） | PASS H1–H4 |
| 版面 | `zero-call → top-per-use → prune-plan → no-recommendation → hide-plan → hide-restore → plan-parallel → categories`（R1 三块位置未破，R6 三块追加其后、四类明细之前） | PASS L1 |
| 健壮性 | v3 空 findings / 完全无 v3 键（v2 旧报告）/ 缺 `findings` 本体 / `hidePlan` 项字段缺失 —— 四种输入**渲染均不抛错**，且旧形状**保守按未校验**（提示条 1、复制按钮 0、caveat 仍常驻、apply 行回落"仅建议"） | PASS M1–M5 |

---

## 7. 词典：zh/en 同键 + 既有键未被删改 —— ✅

```
=== A · 词典 ===
  zh=99 键 / en=99 键
  PASS A1 zh/en 同键
  PASS A2 键数 = 54(v2) + 45(v3) = 99
  PASS A3 v2 的全部键仍存在
  PASS A4 v2 既有键的值一字未改（zh）
  PASS A5 v2 既有键的值一字未改（en）
  PASS A6 v3 新增键数 = 45
  PASS A7 新增键全部以 cl.hide 前缀命名
```

`A4/A5` 是把我复核过的 v2 基线（`3fb433b:client.js`，R2 轮已 pass）的 54 个键值逐个字节比对——
**一个都没改**。实现侧还有一处更强的证据：`test/client-panel.test.mjs` 的 `FROZEN_KEYS`(54) +
`V3_KEYS`(45) 用 `deepEqual` 做**精确集合相等**，即键集被钉死为"54+45，不得增删"。

---

## 8. 实现方自述的独立核验（不采信）

### 8.1 "§2.21 示例是逐字机械抽取" + "A1–A17 恒等式全绿"

我把 DESIGN §2.21 的 jsonc 块**自己解析**，与测试夹具 `R6_EXAMPLE` 逐字段比对：

```
=== DESIGN §2.21 示例 vs 测试夹具 R6_EXAMPLE 逐字段比对 ===
  SAME  hidePlanTokens / hidePlanBasis / prunePlanReclaimableTokens / hidePlanStatus
  SAME  hideApply / hidePlanCaveat
  SAME  hidePlan 条数 / 名字序列 / 各 tokens
  SAME  hidePlanUnits / prunePlan / items / zeroCall
```

`13/13 SAME`。再用 DESIGN 的数据**自己算**契约 §2.21.1 的 A1–A17：

```
  PASS A1..A17（17/17）——含 4261 / 3376 / 885 / 24 的恒等式、两种排序、denyList 全集与升序、
       unit.kind 值域、caveat 五键、items.length===24 ∧ hidePlan.length===24
```

### 8.2 "面板从不读取 hidePlanTokens / prunePlanReclaimableTokens"

用**哨兵法**独立验证：把两个值替换为 `987654` / `123456`，渲染结果中**一次都不出现**（§3 的 D2/D3）。

### 8.3 真实数据端到端

`real-panel-r6.mjs`：真机 20 会话日志 + 真机 profile/core 声明面 → `gatherLedger` → 真实面板。
真实报告 `hidePlan` 19 条 / `hidePlanTokens` 476 / `hidePlanUnits` 8 / `prunePlan` 6 条；
面板如实显示"未校验，不要直接照抄清单"提示条、**不给复制按钮**、caveat 五条常驻、
"19 个名字未施加（接口缺失或名字不可限制）"、恢复六行齐全（§1.4）。
两语言确定性措辞命中 **0**。

> 交叉引用：真实宿主当前恒判 `unsupported`（`interfacePresent:false`）是**宿主半区的缺陷**，
> 已由我在 **t16 / B1** 报告（`restrictableNames` 真实类型是 `Set`，实现按 `Array` 判定）。
> 面板对此**如实呈现**（提示条 + 无复制按钮 + 不谎报已施加），属正确行为；
> 待宿主修好后，`prechecked` 状态下的呈现（含复制按钮）由 §6 的 G 矩阵覆盖。
> 这是本次 `pass` 与 t16 `needs_revision` 并存的原因：**面板忠实，宿主不忠实**。

---

## 9. 自跑与范围

### 9.1 命令

```
$ node --check client.js                                   → exit 0
$ node --test test/client-panel.test.mjs                   → ℹ tests 40 / pass 40 / fail 0 / skipped 0
$ for i in $(seq 1 12); do node --test; done               → 12/12 均 tests=139 / pass=139 / fail=0 / skipped=0
```

### 9.2 我自己的审计

```
$ node panel-audit-r6.mjs
================ R6 PANEL AUDIT: 210 passed / 0 failed ================
$ node real-panel-r6.mjs      （真实数据；zh/en 全部判读通过）
```

### 9.3 改动范围

```
$ git diff --numstat c01b388..HEAD -- client.js
  556  0  client.js                      ← 纯追加，零删除行（t15 自述属实）
$ git diff --numstat c01b388..HEAD -- test/client-panel.test.mjs
  1590  8  test/client-panel.test.mjs

$ git diff --name-status c01b388..HEAD
  M BACKLOG.md / M IMPLEMENTATION-NOTES.md / M client.js / M index.js / A lib/hide.js / M lib/reconcile.js
  M test/{client-panel,e2e,host,privacy,reconcile}.{test.js,mjs} / A test/hide.test.js / M test/whitelist.js

$ package.json / cordis.patch.yml / DESIGN.md / README.md 的 sha256 与 HEAD 逐一相同 → SAME
```

- 仓库里**只有 `client.js` 一个前端入口**（其余是 `index.js` 服务端与文档），面板面没有第二个文件；
- t14 宿主半区与 t15 面板被**打包进同一个提交**（同 t16 报告 §9 的记录）；
  就 t15 而言，它的两个声明 in-scope 路径恰好是本次改动的面板相关文件：`client.js` + `test/client-panel.test.mjs`；
- `test/client-panel.test.mjs` 的 8 行删除我逐行看过：3 行是测试工具重构（`loadBundle`/`renderPanel`），
  5 行是被**改写加强**的词典用例（见 §10-O3），**没有删除任何 v2 用例**（28 → 40，只增不减）。

---

## 10. 非阻断观测（6 项）

- **O1 · DESIGN §2.21 的冻结示例违反 §2.19 的"升序"要求**（`DESIGN.md:895`）：
  `subagent.registryUse.nameReferencedElsewhere` 列出
  `@nanmicoder/.../harness-compat.js` → `@linxin666/.../index.js`，而按码点 `@linxin666` 应排在
  `@nanmicoder` **之前**（升序）。我逐项复核了 §2.19 的"≤3、绝对路径、升序"三要求，示例**只此 1 处不符**。
  → 这是**文档/示例缺陷**（t13 机械合并的产物，该点不在 §2.21.1 的 A1–A17 清单内，故自检没拦住），
  **不是 t15 的实现问题**：宿主侧 `lib/hide.js` 的 `uniqueSorted()` 排序正确，
  我在 t16 用未排序输入实测输出为升序。**建议 DESIGN v3.1 修正该示例的顺序**（或把该点补进 A 清单）。
- **O2 · 矛盾的 `hideApply` 输入会让"施加方式"行自相矛盾**：输入
  `{mode:'suggestion-only', appliedNames:['a']}` 时上屏
  「仅建议：本插件不会自动施加（appliedNames 为空） · 已施加 1 个名字」。
  该输入**宿主不可能产出**（`index.js:827` 保证 `appliedNames` 非空 ⟺ `mode==='applied-by-config'`），
  故不构成用户可见风险。可选加固：把"已施加 N"后缀限定在 `mode==='applied-by-config'` 分支内
  （`client.js:881-895`）。
- **O3 · 一条恒真的死断言**：`test/client-panel.test.mjs` 里
  `assert.deepEqual([...V3_KEYS].sort(), [...V3_KEYS].sort())` 是自比较（永远通过，不提供保护）。
  它**没有削弱**任何东西——真正的保护是它上面那行
  `assert.deepEqual(zhKeys, [...FROZEN_KEYS, ...V3_KEYS].sort(), '键集 = 54 + 45；不得增删')`（精确集合相等，
  比我复核过的 v2 基线用例更强）。建议删掉这行噪音。
- **O4 · §2.21 夹具是**存下来的字面量**，不是测试时从 DESIGN 读**：所以 DESIGN 改动不会自动让测试失败。
  我今天独立核对了它的保真度（13/13 SAME）与恒等式（A1–A17 全绿），但**未来会静默漂移**。
  建议（择一）：测试时机械抽取 DESIGN 的 jsonc 块，或为夹具加一条内容指纹断言。
- **O5 · e2e 的"真机"跑的是假 tools 替身**：`test/e2e.test.js` 用 `{schemas}` 假服务，
  因此那里断言 `hidePlanStatus==='unsupported'`、`interfacePresent===false`、`denyList===[]`
  只能证明"缺接口时如实降级"，不能代表真机；真机路径靠 `test/host.test.js` 的替身覆盖，
  而该替身类型与宿主不一致（= t16 的 B1 根因）。
- **O6 · 琥珀色用于"注意"而非"危害"**：`hideWarnStyle` 落在 selfTool 提示、"无法通过卸载移除"、
  "没有撤销命令"、"不写配置"、剪贴板不可用这些句子上，方向是**降低**行动冲动；
  候选行本体是中性灰阶。判为口径说明，非缺陷（与 `VERIFY-T9` 的 O2 同一判据）。

---

## 11. 复现方式

```sh
# 渲染树穷举 + §4.8 七条 + 建议≠已施加 + 不相加 + registryUse + caveat + 恢复 + 健壮性
cd /home/u/Desktop/DSHWorkspace/.feas/t17-verify && node panel-audit-r6.mjs

# 真实数据（真机会话日志 + 真机声明面）→ 真实面板
cd /home/u/Desktop/DSHWorkspace/.feas/t17-verify && node real-panel-r6.mjs

# 全量 12 次
cd dsh-context-ledger && for i in $(seq 1 12); do node --test 2>&1 | grep -E "^ℹ (tests|pass|fail|skipped)"; done
```

原始输出：`.feas/t17-verify/logs/`（`panel-audit-r6.log`、`real-panel-r6.log`）。

---

## 12. 最终判定

**pass。** R6 面板按 DESIGN v3 §4.8 逐条落地，且本轮两个新增风险面都守住了：

1. **建议 ≠ 已施加**：`suggestion-only`/未知 mode/缺字段三种情形明写"本插件不会自动施加
   （appliedNames 为空）"，`applied-by-config` 明写来源是 profile patch 且"不是本插件自动决定"；
   全屏无"已隐藏"类完成态措辞；清单以"可粘贴清单（N 个名字）"呈现。
2. **两动作 token 不相加**：面板**根本不消费**两个总额（哨兵法证明），逐单元并列各自数字，
   段内显式写出"互斥、不得相加、不是两笔收益之和"的硬规则，全屏不存在两数之和。

对抗性措辞穷举（渲染树层，zh/en 各 117 条受审文案 + 各 6 条属性型文案）**零命中**，
整屏无 error 红；registryUse 的判定与"无法观测非模型注册表调用"同屏，
caveat 五条在 6 种状态下常驻段底且不可折叠/非 tooltip；恢复路径六行齐全、如实说明
"没有撤销命令"与"不追溯"。词典 99/99 同键、v2 的 54 键值一字未改；
`client.js` 纯追加 +556/-0；面板套件 40/40；全量 12 次 139/139 全绿。

6 项非阻断观测见 §10，其中 **O1 是 DESIGN 示例自身的缺陷**（`nameReferencedElsewhere` 未升序，
与实现无关，建议 v3.1 修正），O2–O6 为可选加固。
面板在真实宿主上的 `unsupported` 呈现是**忠实**的——根因是 t16 已报告的宿主 B1（`Set` vs `Array`）。
