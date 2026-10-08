# dsh-context-ledger R6 契约草稿 — 工具级隐藏建议（deny）

> **本文件是草稿，不是冻结契约。** DESIGN.md 保持 v2 不变（本任务只写本文件，见 §14 证据）；
> 合并动作由**队长**在 t9 全部终态后执行：按 §10 的章节映射把各节并入 DESIGN，并在 `## 8. 修订记录` 追加 v3 行。
> 合并前，任何实现线**不得**按本文件施工（它可能被修订）。
>
> 来源：`BACKLOG.md` R6 条目 + DESIGN v2 §2.13/§2.15/§2.16/§7.1 + BRIEF 隐私红线。
> 本任务（t10）性质：requirements 草稿；**不改任何实现文件，不改 DESIGN.md**。
>
> **编号约定（避免混淆）**：本文件**自己**的章节直接写 `§N`（如 `§3.6`、`§4.4`、`§10.1`）；
> 引用冻结契约一律加前缀，写作 **DESIGN §2.13**、**DESIGN §7.1**。§10.1 映射表里的 `§2.18`、`§2.21`、`§2.24`、`§4.8`
> 是**拟在 DESIGN v3 中新建**的编号（目前不存在）。

---

## 0. 一页结论

1. **R6 的价值路径成立，但它的第一条硬约束不成立**：`restrict()` 在本机 DSH（0.2.0-rc.2）**拒绝**从普通 ctx 施加的"全局"限制——源码硬报错
   `dsh-tools/lib/index.js:2897`。因此"全局隐藏"不是"非既有用法"，而是**不可用**。契约把动作模型改为
   **按 agent 作用域施加**（对"被审计的那个 agent 及其继承者"生效），并显式说明为什么这仍能满足用户意图（§2）。
2. **deny 不是"仅隐藏"**：`get()`（`dsh-tools/lib/index.js:2995-2996`）与 `resolveExecution()`（`3011-3016`）都以可见面为首步，
   deny 让该名字在**整个注册表**上既不可见也不可解析（对作用域内所有调用者）。收益描述**禁止**笼统宣称"零功能损失"，
   每个候选必须带 `registryUse` 判定字段与"须人工确认"常量（§3.3、§8）。
3. **数据形状**：新增 `findings.hidePlan`（工具级候选）+ `hidePlanUnits`（单元级并列）+ `hideApply`（建议/已施加状态），
   与既有 `findings.prunePlan`（卸载单元）**并存、不改其字段**，两套动作的代价按单元并列呈现（§3.7）。
4. **恢复路径**：限制是"进程内 + 作用域"的对象，由 fiber 生命周期持有（`layers.effect`）；**持久化完全在用户侧配置**里
   （本插件只读、绝不写配置）；"一键恢复"= 删/注掉配置块 + 重载（HMR 或重启），不存在"撤销上一条隐藏"的命令（§5）。
5. 本文件是**草稿**，合并方案与编号映射见 §10。

**收益重述（用真机数字，不夸大）**：R1 的实测是"从未被模型调用的工具 4261 tokens（20 会话 / 2353 次调用），
其中可**卸载**单元 3376 tokens，但这些单元都捆着在用工具（openviking 8 个在用、web-all 3 个在用……）"。
deny 的覆盖面是**全部 4261 tokens**（隐藏不需要可卸载单元），代价是"这些名字在该作用域内注册表级不可用 + 需人工确认"
（§2.3：为什么 4261 是可行动上限、而 3376 不是）。

---

## 1. 已核验的 DSH 事实（本任务只读核验，一手 file:line）

| # | 事实 | 证据（本机 0.2.0-rc.2） |
|---|---|---|
| F1 | `restrict(filter: ToolRestriction): () => void` 是公开 API，`ToolRestriction = { allow?, deny? }` | `dsh-tools/lib/types/index.d.ts:508`、`:638-644` |
| F2 | **`restrict()` 要求 scoped context；普通 ctx 直接抛错**：`"tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead"` | `dsh-tools/lib/index.js:2895-2897` |
| F3 | 空 filter（既无 allow 也无 deny）抛错 | 同文件 `:2900` |
| F4 | 名字含保留传输名 `run_code` 抛错 | 同文件 `:2905` |
| F5 | **未知名硬报错**（列出已知全局工具），所以必须先预校验 | 同文件 `:2906-2908` |
| F6 | 预校验的来源：`view(scope).restrictableNames`，**只含继承面（global + 祖先层）**，scope 自身注册的名字**不在其中** | 同文件 `:2959-2984`（`restrictableNames` 构造于 `:2969-2972`；`own.tools` 只进 `knownNames`/`visible`，`:2975-2978`） |
| F7 | `visible` 需**每个层都 `admits(name)`**；`admits` 只看 `restrictions`（`allow`/`deny`） | 同文件 `:2640-2642`、`:2973` |
| F8 | **deny 是注册表级**：`get(name, scope) = view(scope).visible.get(name)`；`resolveExecution` 首步即 `get`，取不到返回 `undefined`（对模型直呼与嵌套 sub-dispatch 同样生效） | 同文件 `:2995-2996`、`:3011-3016` |
| F9 | 模型可见 schema 只投影 `view.visible` | 同文件 `:3023-3024`（`schemas(scope)`） |
| F10 | `guard()` 是**另一套**机制：普通 ctx 的 guard 全局生效，但它只影响执行期（`guards` 与 `guardReason`），**不影响 `visible`/`schemas`** | `:2913`、`:2626`、`:2647`、`:2921-2936`；`admits` 只看 restrictions（F7） |
| F11 | 作用域限制会沿层链影响**继承者**：限制过滤的是"该 scope 继承到的"（global 与每个祖先层），不碰它自己注册的 | `lib/types/index.d.ts:665-676` |
| F12 | 官方先例（委派者作用域）：`dsh-subagent/lib/index.js:522` — `if (composition.toolFilter !== void 0) childCtx.tools.restrict(composition.toolFilter)` | 同文件；`toolFilter` 是 continuable 子代理描述符的合法键（`:1323-1330`，`TOOL_FILTER_KEYS = {allow, deny}`） |
| F13 | 插件先例（先校验再转发）：`@nanmicoder/dsh-agent-teams/lib/harness-compat.js:228-235`，注释明确记录"`restrict()` 对未知名硬报错，先对该 view 校验"与"更早世代没有该接口" | 同文件 |
| F14 | 若要给 root agent 施加限制，可用 `ctx.on("agent/created", ({ agent }) => ...)`；该事件由 `dsh-agent` **串行**发出，且在放行排队工作**之前** | `dsh-agent/lib/index.js:576-584`；同款监听在 9+ 个插件中使用（如 `dsh-goal/lib/index.js:594`、`dsh-tool-subagent/lib/index.js:652`） |
| F15 | `agent.ctx` 可访问作用域服务（如 `agent.ctx.inject(["systemPrompt","tools"], …)`、`agent.ctx.get(...)`） | `dsh-file-reference-local/lib/index.js:342-346`、`dsh-api-terminal-controller/lib/index.js:988-989` |
| F16 | 用户侧补丁层是 `<profile>/cordis.patch.yml`：**id 定向的 config 覆盖、禁用、插入列表**；文件头注释明示"applied after every bundle layer" | 实读 `~/.dsh/profiles/web/cordis.patch.yml`（含 `- id:`/`name:`/`config:`/`disabled:` 的真实用例） |
| F17 | `restrict()` 返回**确切的解除器**；其 effect 挂在调用者的 ctx 上（卸载/HMR 即解除） | `dsh-tools/lib/index.js:2909`（`layers.effect(this.ctx, …)`）、`lib/types/index.d.ts:642` |

> 以上全部为只读核验；未修改 `/opt/dsh/node_modules/@deepseek-ai/dsh/**` 与 `~/.dsh/**`。

---

## 2. 前提修正（三条；第一条使原方案的"全局"表述不可行）

### 2.1 C1 · 「全局限制」不可用（对 BACKLOG 第 139-141 行硬约束 ① 的修正）

**原表述**（BACKLOG R6）："惯用法是按委派者作用域限制，而 R6 要做的是**全局**限制（从普通 ctx 施加）。
机制上支持（文档明示 plain-context 生效于全局），但这**不是既有用法**……"

**核验结果**：机制上**不支持**。`dsh-tools/lib/index.js:2897` 对普通 ctx 直接抛错，措辞就是拒绝理由
（"would mask every agent — deny the tool for the intended agent instead"）。BACKLOG 引用的"文档明示"取自
`types/index.d.ts:638-639`，但那里 `restrict` 的文档现在的措辞是 "Restrict **global tools** for the **calling agent scope**"——
"global" 修饰的是**被限制的工具来自全局层**，不是"限制的作用域是全局"。（与 `guard()` 的文档对比可证：只有 guard 明写
"plain-context guard applies globally"。）

**对契约的影响（冻结）**：
1. R6 的动作模型是**按 agent 作用域**施加，不是全局。
2. 契约**禁止**把效果描述为"对所有 agent 生效"。允许的表述是"对**被审计的那个 agent** 及其层链继承者生效"。
3. 施加入口从"插件从普通 ctx 调一次"改为"在某一个 agent 的作用域内施加"（三种载体见 §4.5）。
4. 用户意图仍然满足：常驻工具成本发生在**该 agent 的请求**上（成本侧本来就是按 `exec.agent` 的视图量出来的），
   对主 agent 施加即可回收它自己的 schema 成本。这正是 DSH 报错信息给出的建议路径。

### 2.2 C2 · 「零功能损失」不成立（与 BACKLOG 已查证结论一致，但要求在契约里**逐单元**落地）

BACKLOG 已查证 deny 是注册表级（F8）。因此：
- 对"功能由独立服务提供、UI/后台不经注册表"的插件 ⇒ 可能零功能损失；
- 对任何**经注册表**的程序化调用者（工作流、子代理、直接调工具的代码）⇒ 一并失效。
- 而"某单元是否属于前者"**静态不可判定**（本插件不执行被审对象、不读其运行期行为）。

**契约做法**：不写结论，写证据与门（§3.3 的 `registryUse` + 共享 caveat + `confirmationRequired`），
并在验收里把"笼统宣称无损失"定为缺陷（§8 措辞红线）。

### 2.3 C3 · 持久化不在本插件（只读纪律的直接推论）

BRIEF 与 DESIGN 一贯要求本插件**只读、不写文件、不改 `~/.dsh/**`**。因此：
- R6 **不自动施加**、**不写配置**；
- 持久化载体是**用户侧**的 `<profile>/cordis.patch.yml`（F16）或子代理描述符的 `toolFilter`（F12）；
- 本插件只**输出**可粘贴的片段 + 明确的恢复步骤（§4.5、§5）。

---

## 3. 数据形状（拟并入 DESIGN，编号见 §10）

### 3.1 `findings.hidePlan`：工具级候选（`HideEntry[]`）

**性质（措辞即契约）**：`hidePlan` = 「**可以把这些工具从该 agent 的模型可见面与可调用面移除**的候选」。
它**不是**"安全删除清单"，也不是"零成本"：代价由 `registryUse` 与 §3.4 的 caveat 如实表达。

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `id` | string | ✅ | 与 `items[].id` **逐字相同**（`"<category>:<name>"`），用于与账目项对齐 |
| `name` | string | ✅ | **全局工具名**——施加 deny 时用的正是它（匹配 `NAME_PATTERN`） |
| `category` | string | ✅ | 恒为 `"tools"` 或 `"mcp"`（只有这两类有逐项调用次数与可限制性） |
| `tokens` | integer ≥ 0 | ✅ | 该 schema 的常驻成本（与 `items[].tokens` 逐字相同） |
| `unit` | object | ✅ | 归属单元（复刻 DESIGN §2.13 的 4 值模型，**不新造**）：`{ kind, target, factPackages }` |
| `registryUse` | object | ✅ | **逐候选的「该功能是否经工具注册表被调用」判定**（§3.3） |
| `precheck` | object | ✅ | 名字预校验结果（§3.4）：`{ status, restrictable, reason }` |
| `selfTool` | boolean | ✅ | 仅当 `name === "context_ledger"` 为 true：隐藏它会移除模型的入口（不违规，但必须可见） |

`unit` 子字段：

| 子字段 | 类型 | 语义 |
|---|---|---|
| `kind` | string | `"plugin" \| "core" \| "mcp-server" \| "unknown"`（取值域与 `providedBy.kind` 完全一致） |
| `target` | string \| null | `plugin` → 该事实包的**可卸载 bundle**（若存在，按 DESIGN §2.16 解析；否则 null）；`mcp-server` → server 名；`core`/`unknown` → null |
| `factPackages` | string[] | `plugin` → 事实包名（升序）；其余 `[]` |

> **关键差异（R6 的价值所在）**：`hidePlan` 的候选**不要求**单元可卸载。`core` 与 `unknown` 归属的工具
> 进不了 `prunePlan`，但**可以**被 deny（它们同样是全局名字）。这是 R6"救活 R1 收益"的机制来源。

### 3.2 `findings` 的其余新增键

| 字段 | 类型 | 语义 |
|---|---|---|
| `hidePlanTokens` | integer | `= Σ hidePlan[].tokens`（= 全部零调用工具的常驻成本；恒等式见 §3.5） |
| `hidePlanUnits` | array | **单元级汇总**（`{ kind, target, factPackages, toolCount, tokens, usedToolCount, inPrunePlan }`），排序 `tokens` 降序 → `target` 升序；`target` 为 null 时用 `kind` 参与排序（见 §3.5 排序规则） |
| `hidePlanBasis` | string | 常量 `"model-tool-calls-only"`（与 `prunePlanBasis` 同源、同值：证据边界相同） |
| `hidePlanStatus` | string | `"prechecked" \| "unvalidated" \| "unsupported"`（§3.4） |
| `hideApply` | object | `{ mode, interfacePresent, denyList, skipped, applySupported, appliedNames }`（§4.4） |
| `hidePlanCaveat` | object | **共享代价常量**（§3.4），逐条强制呈现，替代"每个条目重复三句" |

### 3.3 `registryUse`：逐候选的「是否经工具注册表被调用」判定（t10 验收的硬要求）

| 字段 | 类型 | 语义 |
|---|---|---|
| `verdict` | string | `"unconfirmed"`（默认且唯一现实取值）/ `"model-observed"`（语义占位：若模型调用过则该工具根本不会进候选） |
| `verdictBasis` | string | 常量 `"no-non-model-observability"`：为什么给不出更强结论——DSH 未暴露"非模型的注册表调用"的可观测面（会话日志只记录模型发起的 `tool/call` 与 PTC 子派发，见 DESIGN §3.1） |
| `modelCalls` | integer | 该工具的模型调用次数（= `items[].calls`；**候选恒为 0**） |
| `nameReferencedElsewhere` | string[] | **启发式证据**（≤3，绝对路径，升序）：其他包源码中该名字的**弱命中文件**（R1 弱扫描语料，见 DESIGN §2.14）。用途：提示"这个名字在别处被引用过"，**不等于**被调用——弱命中也可能是文档/注释/字符串表 |
| `nonModelCallers` | string | 常量 `"unobservable"` |

**硬规则**：
1. `verdict` **不得**出现 `"safe"` / `"unused"` / `"no-loss"` 之类值——那等于把不可判定的事情写成结论。
2. 呈现层必须同时展示 `verdictBasis`（"DSH 没有该观测面"）与 `confirmationRequired`（§3.4），
   否则用户会把"没查到"读成"不存在"。
3. `nameReferencedElsewhere` 非空时，该候选在面板上必须带"别处引用过该名字（需人工确认）"标记。

### 3.4 `precheck`、`hidePlanStatus` 与共享 caveat

`precheck`（逐候选）：

| 字段 | 类型 | 语义 |
|---|---|---|
| `status` | string | `"prechecked"`（已对该 agent 的 `restrictableNames` 校验）/ `"unvalidated"`（有该接口但拿不到 agent 作用域）/ `"unsupported"`（宿主没有该接口） |
| `restrictable` | boolean \| null | `status === "prechecked"` 时为布尔；否则 null（**不得**用 false 表示"没查"） |
| `reason` | string \| null | 仅当 `restrictable === false` 或非 prechecked 时给出枚举：`"not-in-restrictable-names"` / `"no-agent-scope"` / `"interface-absent"` / `"reserved-name"`（`run_code`，本插件不会产出它） |

`hidePlanStatus`（全局）：三者取**最弱**一环——任一项 `unsupported` ⇒ `unsupported`；否则任一项 `unvalidated` ⇒ `unvalidated`；否则 `prechecked`。

`hidePlanCaveat`（共享常量，**必须**在工具输出、native 渲染与面板三处同时呈现）：

| 字段 | 值 | 含义 |
|---|---|---|
| `registryHideIsTotal` | `true` | deny 让该名字在**该作用域内的注册表**上不可见也不可解析（F8），**不是**仅从 schema 里抹掉 |
| `nonModelRegistryCalls` | `"unobservable"` | 非模型的注册表调用没有观测面（§3.3） |
| `serviceCoupling` | `"unconfirmed"` | "功能是否由独立服务提供（UI/后台不经注册表）"静态不可判定，须逐单元人工确认 |
| `confirmationRequired` | `true` | 施加前必须人工确认；本插件不代替用户确认 |
| `prefixCacheCost` | `"one-time-invalidation"` | 任何隐藏都会改变请求前缀，导致 prompt cache **一次性**失效（BACKLOG R1 已实测：输入 token 98–99% 是缓存命中）；这是**一次性成本**，不是持续成本 |

### 3.5 排序、上限与恒等式（冻结）

**`hidePlan` 排序**：`tokens` 降序 → `name` 升序（全序，与 `items` rank0 一致）。
**上限**：不截断（候选数 ≤ 零调用工具数，量级为几十）。
**`hidePlanUnits` 排序**：`tokens` 降序 → `itemCount`（`toolCount`）降序 → `target ?? kind` 升序。

**恒等式**：

| # | 恒等式 |
|---|---|
| H1 | `hidePlanTokens = Σ hidePlan[].tokens` |
| H2 | `hidePlanTokens = totals.zeroCallTokens − Σ(零调用但 category ∈ {instructions, skills} 的项 tokens)`（本插件中后者恒为 0，因为 instructions/skills 的 `zeroCall` 恒为 `null`） |
| H3 | `Σ hidePlan[].tokens = Σ items[zeroCall === true ∧ category ∈ {tools, mcp}].tokens` |
| H4 | `Σ hidePlanUnits[].tokens = hidePlanTokens`；`Σ hidePlanUnits[].toolCount = hidePlan.length` |
| H5 | `hidePlanUnits` 中 `inPrunePlan === true` 的单元集合 = `prunePlan[].target` 集合（按 `kind` + `target` 配对），且这些单元的 `tokens ≤ prunePlan[].reclaimableTokens + Σ(该单元 `calls === null` 项 tokens)`（后者为 0 时可简化为相等或更小） |
| H6 | `hideApply.denyList ⊆ { hidePlan[].name | precheck.restrictable === true }`；`hideApply.skipped` 覆盖其余候选，且 `denyList.length + skipped.length = hidePlan.length` |
| H7 | `scope.usageAvailable === false` ⟹ `hidePlan === []` ∧ `hidePlanTokens === 0` ∧ `hideApply.denyList === []`（与 R1 同一纪律：**没有证据就没有候选**） |

> H5 的写法说明：`hidePlan` 按"零调用工具"取，`prunePlan` 按"单元"取且要求唯一可卸载 bundle，
> 两者边界不同（前者更宽）。契约**不要求**两者数量相等，只要求配对关系可机器判定，避免面板重算。

### 3.6 完整示例 JSON（R6 增量片段；载荷合成，单元边界与真机合计一致）

> 本示例是 canonical 报告的 **R6 增量片段**：`findings` 完整 + 全部 24 个零调用 `items`（R6 的候选来源）。
> `items` 只列与 R6 相关的字段；完整 `items[]` 字段（`providedBy` 等）见 DESIGN §2.9/§2.13。
> `findings.prunePlan` 原样带上，用于展示两套动作的配对（§3.7）。
> **每个数字的出处见 §3.6.2**；`version` 由 2 升 3（新增强制字段即形状变更）。
> 真机口径：24 个零调用工具 / 4261 tokens 来自 t6 真机（20 会话、2353 次 `tool/call`）；
> `openviking` 8 项的逐项 tokens 为真机真值，其余 16 项为**合成载荷**，但**每个单元合计都与真机一致**。

```jsonc
{
  "tool": "context_ledger",
  "version": 3,
  "unit": "token",
  "items": [
    { "id": "mcp:mcp__openviking__add_resource", "category": "mcp", "name": "mcp__openviking__add_resource", "tokens": 891, "calls": 0, "zeroCall": true },
    { "id": "mcp:mcp__openviking__add_skill", "category": "mcp", "name": "mcp__openviking__add_skill", "tokens": 464, "calls": 0, "zeroCall": true },
    { "id": "tools:subagent", "category": "tools", "name": "subagent", "tokens": 402, "calls": 0, "zeroCall": true },
    { "id": "tools:task_board_github_repositories", "category": "tools", "name": "task_board_github_repositories", "tokens": 331, "calls": 0, "zeroCall": true },
    { "id": "tools:task_board_github_link_pr", "category": "tools", "name": "task_board_github_link_pr", "tokens": 298, "calls": 0, "zeroCall": true },
    { "id": "tools:task_board_schedule", "category": "tools", "name": "task_board_schedule", "tokens": 274, "calls": 0, "zeroCall": true },
    { "id": "tools:task_board_run", "category": "tools", "name": "task_board_run", "tokens": 242, "calls": 0, "zeroCall": true },
    { "id": "tools:modlens_read_image", "category": "tools", "name": "modlens_read_image", "tokens": 156, "calls": 0, "zeroCall": true },
    { "id": "tools:validate_dsh_ui", "category": "tools", "name": "validate_dsh_ui", "tokens": 133, "calls": 0, "zeroCall": true },
    { "id": "tools:read_mcp_resource", "category": "tools", "name": "read_mcp_resource", "tokens": 128, "calls": 0, "zeroCall": true },
    { "id": "mcp:mcp__openviking__tree", "category": "mcp", "name": "mcp__openviking__tree", "tokens": 122, "calls": 0, "zeroCall": true },
    { "id": "tools:task_board_github_refresh", "category": "tools", "name": "task_board_github_refresh", "tokens": 110, "calls": 0, "zeroCall": true },
    { "id": "tools:list_mcp_resources", "category": "tools", "name": "list_mcp_resources", "tokens": 96, "calls": 0, "zeroCall": true },
    { "id": "tools:annotation", "category": "tools", "name": "annotation", "tokens": 88, "calls": 0, "zeroCall": true },
    { "id": "tools:list_mcp_resource_templates", "category": "tools", "name": "list_mcp_resource_templates", "tokens": 88, "calls": 0, "zeroCall": true },
    { "id": "mcp:mcp__openviking__forget", "category": "mcp", "name": "mcp__openviking__forget", "tokens": 75, "calls": 0, "zeroCall": true },
    { "id": "tools:interrupt_agent", "category": "tools", "name": "interrupt_agent", "tokens": 74, "calls": 0, "zeroCall": true },
    { "id": "tools:task_board_set_parent", "category": "tools", "name": "task_board_set_parent", "tokens": 70, "calls": 0, "zeroCall": true },
    { "id": "tools:job_kill", "category": "tools", "name": "job_kill", "tokens": 52, "calls": 0, "zeroCall": true },
    { "id": "mcp:mcp__openviking__remember", "category": "mcp", "name": "mcp__openviking__remember", "tokens": 47, "calls": 0, "zeroCall": true },
    { "id": "tools:update_goal", "category": "tools", "name": "update_goal", "tokens": 45, "calls": 0, "zeroCall": true },
    { "id": "mcp:mcp__openviking__cancel_watch", "category": "mcp", "name": "mcp__openviking__cancel_watch", "tokens": 30, "calls": 0, "zeroCall": true },
    { "id": "mcp:mcp__openviking__list_watches", "category": "mcp", "name": "mcp__openviking__list_watches", "tokens": 27, "calls": 0, "zeroCall": true },
    { "id": "mcp:mcp__openviking__health", "category": "mcp", "name": "mcp__openviking__health", "tokens": 18, "calls": 0, "zeroCall": true }
  ],
  "findings": {
    "hidePlan": [
      { "id": "mcp:mcp__openviking__add_resource", "name": "mcp__openviking__add_resource", "category": "mcp", "tokens": 891, "unit": { "kind": "mcp-server", "target": "openviking", "factPackages": [] }, "registryUse": { "verdict": "unconfirmed", "verdictBasis": "no-non-model-observability", "modelCalls": 0, "nameReferencedElsewhere": [], "nonModelCallers": "unobservable" }, "precheck": { "status": "prechecked", "restrictable": true, "reason": null }, "selfTool": false },
      { "id": "mcp:mcp__openviking__add_skill", "name": "mcp__openviking__add_skill", "category": "mcp", "tokens": 464, "unit": { "kind": "mcp-server", "target": "openviking", "factPackages": [] }, "registryUse": { "verdict": "unconfirmed", "verdictBasis": "no-non-model-observability", "modelCalls": 0, "nameReferencedElsewhere": [], "nonModelCallers": "unobservable" }, "precheck": { "status": "prechecked", "restrictable": true, "reason": null }, "selfTool": false },
      { "id": "tools:subagent", "name": "subagent", "category": "tools", "tokens": 402, "unit": { "kind": "unknown", "target": null, "factPackages": [] }, "registryUse": { "verdict": "unconfirmed", "verdictBasis": "no-non-model-observability", "modelCalls": 0, "nameReferencedElsewhere": ["/home/u/.dsh/profiles/web/node_modules/@nanmicoder/dsh-agent-teams/lib/harness-compat.js", "/home/u/.dsh/profiles/web/node_modules/@linxin666/dsh-session-archive/lib/index.js"], "nonModelCallers": "unobservable" }, "precheck": { "status": "prechecked", "restrictable": true, "reason": null }, "selfTool": false },
      { "id": "tools:task_board_github_repositories", "name": "task_board_github_repositories", "category": "tools", "tokens": 331, "unit": { "kind": "plugin", "target": "@linxin666/dsh-web-all", "factPackages": ["@linxin666/dsh-client-ui-task-board-github"] }, "registryUse": { "verdict": "unconfirmed", "verdictBasis": "no-non-model-observability", "modelCalls": 0, "nameReferencedElsewhere": [], "nonModelCallers": "unobservable" }, "precheck": { "status": "prechecked", "restrictable": true, "reason": null }, "selfTool": false },
      { "id": "tools:task_board_github_link_pr", "name": "task_board_github_link_pr", "category": "tools", "tokens": 298, "unit": { "kind": "plugin", "target": "@linxin666/dsh-web-all", "factPackages": ["@linxin666/dsh-client-ui-task-board-github"] }, "registryUse": { "verdict": "unconfirmed", "verdictBasis": "no-non-model-observability", "modelCalls": 0, "nameReferencedElsewhere": [], "nonModelCallers": "unobservable" }, "precheck": { "status": "prechecked", "restrictable": true, "reason": null }, "selfTool": false },
      { "id": "tools:task_board_schedule", "name": "task_board_schedule", "category": "tools", "tokens": 274, "unit": { "kind": "plugin", "target": "@linxin666/dsh-web-all", "factPackages": ["@linxin666/dsh-client-ui-task-board"] }, "registryUse": { "verdict": "unconfirmed", "verdictBasis": "no-non-model-observability", "modelCalls": 0, "nameReferencedElsewhere": [], "nonModelCallers": "unobservable" }, "precheck": { "status": "prechecked", "restrictable": true, "reason": null }, "selfTool": false },
      { "id": "tools:task_board_run", "name": "task_board_run", "category": "tools", "tokens": 242, "unit": { "kind": "plugin", "target": "@linxin666/dsh-web-all", "factPackages": ["@linxin666/dsh-client-ui-task-board"] }, "registryUse": { "verdict": "unconfirmed", "verdictBasis": "no-non-model-observability", "modelCalls": 0, "nameReferencedElsewhere": [], "nonModelCallers": "unobservable" }, "precheck": { "status": "prechecked", "restrictable": true, "reason": null }, "selfTool": false },
      { "id": "tools:modlens_read_image", "name": "modlens_read_image", "category": "tools", "tokens": 156, "unit": { "kind": "plugin", "target": "@liustack/modlens", "factPackages": ["@liustack/modlens"] }, "registryUse": { "verdict": "unconfirmed", "verdictBasis": "no-non-model-observability", "modelCalls": 0, "nameReferencedElsewhere": [], "nonModelCallers": "unobservable" }, "precheck": { "status": "prechecked", "restrictable": true, "reason": null }, "selfTool": false },
      { "id": "tools:validate_dsh_ui", "name": "validate_dsh_ui", "category": "tools", "tokens": 133, "unit": { "kind": "plugin", "target": "@changfenhuang/dsh-genui", "factPackages": ["@changfenhuang/dsh-genui"] }, "registryUse": { "verdict": "unconfirmed", "verdictBasis": "no-non-model-observability", "modelCalls": 0, "nameReferencedElsewhere": [], "nonModelCallers": "unobservable" }, "precheck": { "status": "prechecked", "restrictable": true, "reason": null }, "selfTool": false },
      { "id": "tools:read_mcp_resource", "name": "read_mcp_resource", "category": "tools", "tokens": 128, "unit": { "kind": "core", "target": null, "factPackages": [] }, "registryUse": { "verdict": "unconfirmed", "verdictBasis": "no-non-model-observability", "modelCalls": 0, "nameReferencedElsewhere": [], "nonModelCallers": "unobservable" }, "precheck": { "status": "prechecked", "restrictable": true, "reason": null }, "selfTool": false },
      { "id": "mcp:mcp__openviking__tree", "name": "mcp__openviking__tree", "category": "mcp", "tokens": 122, "unit": { "kind": "mcp-server", "target": "openviking", "factPackages": [] }, "registryUse": { "verdict": "unconfirmed", "verdictBasis": "no-non-model-observability", "modelCalls": 0, "nameReferencedElsewhere": [], "nonModelCallers": "unobservable" }, "precheck": { "status": "prechecked", "restrictable": true, "reason": null }, "selfTool": false },
      { "id": "tools:task_board_github_refresh", "name": "task_board_github_refresh", "category": "tools", "tokens": 110, "unit": { "kind": "plugin", "target": "@linxin666/dsh-web-all", "factPackages": ["@linxin666/dsh-client-ui-task-board-github"] }, "registryUse": { "verdict": "unconfirmed", "verdictBasis": "no-non-model-observability", "modelCalls": 0, "nameReferencedElsewhere": [], "nonModelCallers": "unobservable" }, "precheck": { "status": "prechecked", "restrictable": true, "reason": null }, "selfTool": false },
      { "id": "tools:list_mcp_resources", "name": "list_mcp_resources", "category": "tools", "tokens": 96, "unit": { "kind": "core", "target": null, "factPackages": [] }, "registryUse": { "verdict": "unconfirmed", "verdictBasis": "no-non-model-observability", "modelCalls": 0, "nameReferencedElsewhere": [], "nonModelCallers": "unobservable" }, "precheck": { "status": "prechecked", "restrictable": true, "reason": null }, "selfTool": false },
      { "id": "tools:annotation", "name": "annotation", "category": "tools", "tokens": 88, "unit": { "kind": "plugin", "target": "dsh-annotate", "factPackages": ["dsh-annotate"] }, "registryUse": { "verdict": "unconfirmed", "verdictBasis": "no-non-model-observability", "modelCalls": 0, "nameReferencedElsewhere": [], "nonModelCallers": "unobservable" }, "precheck": { "status": "prechecked", "restrictable": true, "reason": null }, "selfTool": false },
      { "id": "tools:list_mcp_resource_templates", "name": "list_mcp_resource_templates", "category": "tools", "tokens": 88, "unit": { "kind": "core", "target": null, "factPackages": [] }, "registryUse": { "verdict": "unconfirmed", "verdictBasis": "no-non-model-observability", "modelCalls": 0, "nameReferencedElsewhere": [], "nonModelCallers": "unobservable" }, "precheck": { "status": "prechecked", "restrictable": true, "reason": null }, "selfTool": false },
      { "id": "mcp:mcp__openviking__forget", "name": "mcp__openviking__forget", "category": "mcp", "tokens": 75, "unit": { "kind": "mcp-server", "target": "openviking", "factPackages": [] }, "registryUse": { "verdict": "unconfirmed", "verdictBasis": "no-non-model-observability", "modelCalls": 0, "nameReferencedElsewhere": [], "nonModelCallers": "unobservable" }, "precheck": { "status": "prechecked", "restrictable": true, "reason": null }, "selfTool": false },
      { "id": "tools:interrupt_agent", "name": "interrupt_agent", "category": "tools", "tokens": 74, "unit": { "kind": "core", "target": null, "factPackages": [] }, "registryUse": { "verdict": "unconfirmed", "verdictBasis": "no-non-model-observability", "modelCalls": 0, "nameReferencedElsewhere": [], "nonModelCallers": "unobservable" }, "precheck": { "status": "prechecked", "restrictable": true, "reason": null }, "selfTool": false },
      { "id": "tools:task_board_set_parent", "name": "task_board_set_parent", "category": "tools", "tokens": 70, "unit": { "kind": "plugin", "target": "@linxin666/dsh-web-all", "factPackages": ["@linxin666/dsh-client-ui-task-board"] }, "registryUse": { "verdict": "unconfirmed", "verdictBasis": "no-non-model-observability", "modelCalls": 0, "nameReferencedElsewhere": [], "nonModelCallers": "unobservable" }, "precheck": { "status": "prechecked", "restrictable": true, "reason": null }, "selfTool": false },
      { "id": "tools:job_kill", "name": "job_kill", "category": "tools", "tokens": 52, "unit": { "kind": "core", "target": null, "factPackages": [] }, "registryUse": { "verdict": "unconfirmed", "verdictBasis": "no-non-model-observability", "modelCalls": 0, "nameReferencedElsewhere": [], "nonModelCallers": "unobservable" }, "precheck": { "status": "prechecked", "restrictable": true, "reason": null }, "selfTool": false },
      { "id": "mcp:mcp__openviking__remember", "name": "mcp__openviking__remember", "category": "mcp", "tokens": 47, "unit": { "kind": "mcp-server", "target": "openviking", "factPackages": [] }, "registryUse": { "verdict": "unconfirmed", "verdictBasis": "no-non-model-observability", "modelCalls": 0, "nameReferencedElsewhere": [], "nonModelCallers": "unobservable" }, "precheck": { "status": "prechecked", "restrictable": true, "reason": null }, "selfTool": false },
      { "id": "tools:update_goal", "name": "update_goal", "category": "tools", "tokens": 45, "unit": { "kind": "core", "target": null, "factPackages": [] }, "registryUse": { "verdict": "unconfirmed", "verdictBasis": "no-non-model-observability", "modelCalls": 0, "nameReferencedElsewhere": [], "nonModelCallers": "unobservable" }, "precheck": { "status": "prechecked", "restrictable": true, "reason": null }, "selfTool": false },
      { "id": "mcp:mcp__openviking__cancel_watch", "name": "mcp__openviking__cancel_watch", "category": "mcp", "tokens": 30, "unit": { "kind": "mcp-server", "target": "openviking", "factPackages": [] }, "registryUse": { "verdict": "unconfirmed", "verdictBasis": "no-non-model-observability", "modelCalls": 0, "nameReferencedElsewhere": [], "nonModelCallers": "unobservable" }, "precheck": { "status": "prechecked", "restrictable": true, "reason": null }, "selfTool": false },
      { "id": "mcp:mcp__openviking__list_watches", "name": "mcp__openviking__list_watches", "category": "mcp", "tokens": 27, "unit": { "kind": "mcp-server", "target": "openviking", "factPackages": [] }, "registryUse": { "verdict": "unconfirmed", "verdictBasis": "no-non-model-observability", "modelCalls": 0, "nameReferencedElsewhere": [], "nonModelCallers": "unobservable" }, "precheck": { "status": "prechecked", "restrictable": true, "reason": null }, "selfTool": false },
      { "id": "mcp:mcp__openviking__health", "name": "mcp__openviking__health", "category": "mcp", "tokens": 18, "unit": { "kind": "mcp-server", "target": "openviking", "factPackages": [] }, "registryUse": { "verdict": "unconfirmed", "verdictBasis": "no-non-model-observability", "modelCalls": 0, "nameReferencedElsewhere": [], "nonModelCallers": "unobservable" }, "precheck": { "status": "prechecked", "restrictable": true, "reason": null }, "selfTool": false }
    ],
    "hidePlanTokens": 4261,
    "hidePlanUnits": [
      { "kind": "mcp-server", "target": "openviking", "factPackages": [], "toolCount": 8, "tokens": 1674, "usedToolCount": 8, "inPrunePlan": true },
      { "kind": "plugin", "target": "@linxin666/dsh-web-all", "factPackages": ["@linxin666/dsh-client-ui-task-board", "@linxin666/dsh-client-ui-task-board-github"], "toolCount": 6, "tokens": 1325, "usedToolCount": 3, "inPrunePlan": true },
      { "kind": "core", "target": null, "factPackages": [], "toolCount": 6, "tokens": 483, "usedToolCount": 0, "inPrunePlan": false },
      { "kind": "unknown", "target": null, "factPackages": [], "toolCount": 1, "tokens": 402, "usedToolCount": 0, "inPrunePlan": false },
      { "kind": "plugin", "target": "@liustack/modlens", "factPackages": ["@liustack/modlens"], "toolCount": 1, "tokens": 156, "usedToolCount": 0, "inPrunePlan": true },
      { "kind": "plugin", "target": "@changfenhuang/dsh-genui", "factPackages": ["@changfenhuang/dsh-genui"], "toolCount": 1, "tokens": 133, "usedToolCount": 1, "inPrunePlan": true },
      { "kind": "plugin", "target": "dsh-annotate", "factPackages": ["dsh-annotate"], "toolCount": 1, "tokens": 88, "usedToolCount": 0, "inPrunePlan": true }
    ],
    "hidePlanBasis": "model-tool-calls-only",
    "hidePlanStatus": "prechecked",
    "hideApply": {
      "mode": "suggestion-only",
      "interfacePresent": true,
      "denyList": ["annotation", "interrupt_agent", "job_kill", "list_mcp_resource_templates", "list_mcp_resources", "mcp__openviking__add_resource", "mcp__openviking__add_skill", "mcp__openviking__cancel_watch", "mcp__openviking__forget", "mcp__openviking__health", "mcp__openviking__list_watches", "mcp__openviking__remember", "mcp__openviking__tree", "modlens_read_image", "read_mcp_resource", "subagent", "task_board_github_link_pr", "task_board_github_refresh", "task_board_github_repositories", "task_board_run", "task_board_schedule", "task_board_set_parent", "update_goal", "validate_dsh_ui"],
      "skipped": [],
      "applySupported": true,
      "appliedNames": []
    },
    "hidePlanCaveat": {
      "registryHideIsTotal": true,
      "nonModelRegistryCalls": "unobservable",
      "serviceCoupling": "unconfirmed",
      "confirmationRequired": true,
      "prefixCacheCost": "one-time-invalidation"
    },
    "prunePlan": [
      { "kind": "mcp-server", "target": "openviking", "factPackages": [], "itemCount": 8, "reclaimableTokens": 1674, "usedToolCount": 8, "confidence": "high" },
      { "kind": "plugin", "target": "@linxin666/dsh-web-all", "factPackages": ["@linxin666/dsh-client-ui-task-board", "@linxin666/dsh-client-ui-task-board-github"], "itemCount": 6, "reclaimableTokens": 1325, "usedToolCount": 3, "confidence": "high" },
      { "kind": "plugin", "target": "@liustack/modlens", "factPackages": ["@liustack/modlens"], "itemCount": 1, "reclaimableTokens": 156, "usedToolCount": 0, "confidence": "low" },
      { "kind": "plugin", "target": "@changfenhuang/dsh-genui", "factPackages": ["@changfenhuang/dsh-genui"], "itemCount": 1, "reclaimableTokens": 133, "usedToolCount": 1, "confidence": "high" },
      { "kind": "plugin", "target": "dsh-annotate", "factPackages": ["dsh-annotate"], "itemCount": 1, "reclaimableTokens": 88, "usedToolCount": 0, "confidence": "high" }
    ],
    "prunePlanReclaimableTokens": 3376,
    "prunePlanBasis": "model-tool-calls-only",
    "noRecommendation": [
      { "reason": "core", "items": 6, "tokens": 483 },
      { "reason": "no-owner-bundle", "items": 0, "tokens": 0 },
      { "reason": "unknown-attribution", "items": 1, "tokens": 402 }
    ]
  }
}
```

#### 3.6.1 示例自洽校验（冻结断言；验证线可直接照抄）

| # | 断言 | 期望 |
|---|---|---|
| A1 | `hidePlanTokens = Σ hidePlan[].tokens` | `4261` |
| A2 | `hidePlanTokens = Σ items[].tokens`（本例 items 即全部零调用工具） | `4261` |
| A3 | `Σ hidePlanUnits[].tokens = hidePlanTokens` | `1674+1325+483+402+156+133+88 = 4261` |
| A4 | `Σ hidePlanUnits[].toolCount = hidePlan.length` | `8+6+6+1+1+1+1 = 24` |
| A5 | `prunePlanReclaimableTokens = Σ prunePlan[].reclaimableTokens` | `1674+1325+156+133+88 = 3376` |
| A6 | `Σ prunePlan[].reclaimableTokens + Σ noRecommendation[].tokens = hidePlanTokens` | `3376+885 = 4261` |
| A7 | `Σ prunePlan[].itemCount + Σ noRecommendation[].items =` 零调用工具数 | `(8+6+1+1+1)+(6+0+1) = 24` |
| A8 | `hideApply.denyList.length + skipped.length = hidePlan.length` | `24+0 = 24` |
| A9 | `hidePlan` 排序 = `tokens` 降序 → `name` 升序 | 891…464…402…331…298…274…242…156…133…128…122…110…96…88(`annotation`)…88(`list_mcp_resource_templates`)…75…74…70…52…47…45…30…27…18 |
| A10 | `hidePlanUnits` 排序 = `tokens` 降序 → `toolCount` 降序 → `(target ?? kind)` 升序 | 1674 → 1325 → 483 → 402 → 156 → 133 → 88 |
| A11 | `inPrunePlan === true` 的单元集合 = `prunePlan[].target` 集合 | 5 个：openviking / `@linxin666/dsh-web-all` / `@liustack/modlens` / `@changfenhuang/dsh-genui` / `dsh-annotate` |
| A12 | 每个 `hidePlan[].{id,name,tokens}` 与 `items[]` 逐字一致 | 成立（24/24） |
| A13 | 每个 `unit.kind` ∈ `providedBy.kind` 的 4 值域；`unit.target !== null` ⟹ `kind ∈ {plugin, mcp-server}` | 成立 |
| A14 | `hidePlanCaveat` 五键齐全且 `confirmationRequired === true` | 成立 |
| A15 | `hideApply.denyList` 升序且去重 | 成立 |
| A16 | `hideApply.denyList` = `hidePlan[].name` 升序全集（示例中全部候选都通过预校验） | 成立 |
| A17 | `items.length === 24 ∧ hidePlan.length === 24` | 成立 |

校验脚本与实测结果见 §14；**本示例是机械校验通过版**（A1–A17 全绿），可直接合并。

#### 3.6.2 每个数字的出处（避免把示例当实测）

| 数字 | 值 | 出处 |
|---|---|---|
| 工具 schema 数 | 84 | BACKLOG R6 2026-10-07 实测（"工具 schema 84 个，实际被调用 60 个"） |
| 从未被调用的工具数 | 24 | 同上 |
| 零调用 tokens 合计 | 4261 | t6 真机交付记录；队长记录「真机实测 ΣprunePlan + ΣnoRecommendation = 3376 + 885 = 4261」 |
| 可卸载单元 3376 的分项 | 1674 / 1325 / 156 / 133 / 88 | 同上（"真机实测各插件可省 token 明细"） |
| openviking 8 项的逐项 tokens | 891/464/122/75/47/30/27/18 | t6 真机输出（逐项列出，合计 1674） |
| `usedToolCount`：openviking 8、web-all 3、genui 1，其余 0 | — | openviking 8 = t6 真机；web-all 3、genui 1 = VERIFY-T7 §3.3 真机渲染行 |
| 其余逐项 tokens（web-all 6 项、core 6 项、unknown 1 项、modlens/genui/annotate 各 1 项） | 合成 | **本示例合成**，只保证"每个单元合计 = 真机合计"（1325 / 483 / 402 / 156 / 133 / 88） |
| 单元归属（`target` / `factPackages`） | — | DESIGN §2.16 模型 + VERIFY-T7 §3.3 真机复核（task-board → web-all） |
### 3.7 与 `prunePlan` 的并存关系与并列呈现（冻结）

| 维度 | `prunePlan`（R1，v2 已冻结，**不改**） | `hidePlan`（R6，本草案） |
|---|---|---|
| 动作 | 卸载/移除一个**单元**（插件 bundle 或 MCP 服务器） | 从**模型可见面与注册表**移除**单个工具名** |
| 候选条件 | `zeroCall === true` ∧ 归属 ∈ {plugin, mcp-server} ∧ **恰有一个可卸载 bundle** | `zeroCall === true` ∧ `category ∈ {tools, mcp}`（**不要求**可卸载单元） |
| 覆盖面 | 3376 tokens（真机） | 4261 tokens（真机）——多出的 885 是 core/unknown 归属 |
| 代价信号 | `usedToolCount`（失去的在用工具数）+ 失去整个插件（含 UI/后台） | `registryUse`（注册表级不可调用 + 不可观测的调用者）+ `hidePlanCaveat`（须人工确认） |
| 恢复 | 重装插件（或 `disabled: false`） | 删配置 + 重载（§5） |
| 是否改既有字段 | — | **不改**：`PruneEntry` 一字不动 |
| 机器可判定的配对 | `hidePlanUnits[].inPrunePlan` + `(kind, target)` | 同左 |

**并列呈现规则（面板与 native 渲染都必须遵守）**：
1. 每个单元一行，**两种动作的代价同屏**：
   `隐藏这 N 个工具可省 X tokens（代价：这些名字注册表级不可用；须人工确认）` 与
   `卸载该单元可省 Y tokens（代价：失去 M 个在用工具，以及该单元的 UI/后台功能）`。
2. `inPrunePlan === false` 的单元只显示隐藏一行（因为卸载不可行），并显示"无法通过卸载移除"。
3. 面板**不得**把两个动作的 token 相加（它们是**互斥的替代方案**，不是叠加收益）——
   这条必须写成硬规则，否则会出现"隐藏 4261 + 卸载 3376 = 7637 可省"的错误宣传。

---

## 4. 施加模型与四条硬约束的落地（拟并入 DESIGN §2.21）

### 4.1 H1 · 作用域：按 agent，而不是全局（有意为之）

- **施加点**：被审计 agent 的作用域（`exec.agent` 对应的 agent），机制是 `agent.ctx.tools.restrict({ deny })`。
- **为什么不是全局**：DSH **禁止**（F2）。契约显式记录这是被宿主约束的**有意选择**，不是疏漏。
- **为什么影响主 agent 是对的**：常驻工具成本是**按该 agent 的视图**量出来的（DESIGN §2.2 的成本侧用 `tools.schemas(agent)`），
  所以隐藏该 agent 视野里的工具，省的正是账本里那一笔。
- **覆盖范围（机器语义 + 诚实边界）**：该 agent 的作用域及其**层链继承者**（F11）。契约要求措辞为
  "对该 agent 及其继承者生效"，**禁止**写成"对所有 agent 生效"。

### 4.2 H2 · 名字预校验（必须，否则整条施加失败）

- 判据：`tools.view(targetAgent).restrictableNames`（F6）。**只有**落在集合里的名字才允许进 `deny`。
- 过滤规则：`deny = hidePlan.filter(c => c.precheck.restrictable === true).map(c => c.name)`；
  未通过者进 `hideApply.skipped` 并带 `reason`。
- **空清单绝不施加**：`deny.length === 0` 时 `applySupported = false`（对应 F3：空 filter 会抛错）。
- **`run_code` 永不出现在候选里**（F4）：它是保留传输名，且它不出现在 `items`（账本只收 `schemas()` 投影的可见工具）；
  契约仍要求实现显式过滤一次，作为防线。
- 名字"已消失"的容错：预校验是在**施加时刻**做的，工具表可能已变化；因此 `deny` 必须在施加前**重新**校验一次
  （不能复用审计时的结果），并把差异记入 `hideApply.skipped`。

### 4.3 H3 · 接口存在性检查与优雅降级（三态）

| 情形 | `hidePlanStatus` | 行为 |
|---|---|---|
| 有 `restrict` 且有 agent 作用域 | `prechecked` | 逐项预校验，给出可粘贴清单 |
| 有 `restrict` 但拿不到 agent 作用域（如 HTTP 路由在无活动 agent 的宿主里） | `unvalidated` | 照常列出候选，`precheck.restrictable = null`，**`hideApply.denyList = []`**、`applySupported = false`；面板顶部提示"未校验" |
| 缺 `restrict` / 缺 `view().restrictableNames`（旧宿主） | `unsupported` | 同上且**不得**抛错；候选仍是有效诊断（用户可手工用别的方式处理） |

硬规则：**接口缺失/校验失败绝不抛错、绝不中断账本**（对照 F13 记录的已知兼容性问题：
更早的 Harness 世代没有该接口）。实现侧一律 fail-soft，并把实际探测结果写进 `hideApply.interfacePresent`。

### 4.4 H4 · 只输出建议，不自动施加（默认永久如此）

- `hideApply.mode` 默认恒为 `"suggestion-only"`；`appliedNames` 恒为 `[]`。
- 唯一例外是**用户显式写入的 opt-in 配置**（本插件自己的 config，默认关闭）：

```yaml
# <profile>/cordis.patch.yml —— 用户侧补丁层（F16）
# context-ledger 由它自己的 bundle patch 以 id: context-ledger / name: 'dsh-context-ledger' 挂载，
# 因此覆盖它要写同一组 id+name（id 定向 config 覆盖）。
- id: context-ledger
  name: 'dsh-context-ledger'
  config:
    hide:
      apply: false      # 默认 false：只输出建议。改为 true 才施加
      deny: []          # 仅在 apply: true 时使用；空数组 = 不施加
```

  语义（冻结）：
  1. `apply: false`（缺省）⇒ 本插件**不调用** `restrict`，只输出 `hidePlan`。
  2. `apply: true` ⇒ 本插件在 `agent/created`（F14）里对 **root agent** 的作用域施加 `{ deny }`，
     且**每条名字都重新预校验**（H2）；施加结果写入 `hideApply.appliedNames` / `skipped`，
     `mode` 变为 `"applied-by-config"`。
  3. **不加作用域旋钮**（"root 还是全部 agent"）——语义固定为"root agent 的作用域，其继承者按层链继承"。
     这是 DESIGN §4.1（O2）教训的直接应用：无设计的旋钮会产出无法解释的降级态。
  4. 施加失败（接口缺失 / 全部名字都不可限制）⇒ 记入 `skipped` 并**静默降级**为 `suggestion-only`，
     不抛错、不重试。
  5. 本插件**不写配置文件**：`deny` 的内容由用户自己从 `hideApply.denyList` 复制粘贴。

### 4.5 三种施加载体（并列，各自代价写明）

| 载体 | 适用 | 落地方式 | 持久化 | 代价 |
|---|---|---|---|---|
| **A. 子代理描述符 `toolFilter`** | 子代理作用域 | continuable 子代理描述符（`SUBAGENT_DESCRIPTOR_VERSION = 3`，`dsh-subagent/lib/index.js:1309`）里的 `toolFilter: { deny: [...] }`（F12，DSH 原生字段，`CONTINUABLE_DESCRIPTOR_KEYS` 的白名单成员） | 随描述符持久化 | 仅覆盖该子代理；主 agent 不受影响 |

载体 A 的可粘贴片段（`toolFilter` 是**已有字段**，不是本插件发明的）：

```jsonc
{ "version": 3, "mode": "continuable", "label": "reviewer",
  "toolFilter": { "deny": ["mcp__openviking__add_resource", "task_board_run"] } }
```
| **B. 本插件 opt-in 配置** | root/主 agent 作用域 | `context-ledger.hide.{apply:true, deny:[...]}` + `agent/created` 施加（F14/F15） | 用户侧 `<profile>/cordis.patch.yml`（F16） | 需重启/重载生效；影响该 agent 及其继承者 |
| **C. 禁用工具提供者的装载入口** | 想连 UI/后台一起停 | profile patch 里 `- id: <entry> / disabled: true`（F16） | 同一份 patch 文件 | **最重**：连 UI/后台与在用工具一起停；只在"整个入口都不需要"时使用 |

R6 的**主推是 B + A**；C 作为已知选项如实列出（它不是 deny，代价完全不同，必须分开描述）。

---

## 5. 恢复路径（拟并入 DESIGN §2.22）

### 5.1 解除器语义（机制事实）

- `restrict()` 返回**确切的解除器**（F17）；调用它只解除这一次限制（不是"清空所有限制"）。
- 限制本身挂在调用者 ctx 的 effect 层上（`layers.effect(this.ctx, …)`）：**插件卸载 / HMR 重载即自动解除**，
  不需要用户做任何事。
- 限制**不落盘**：它是进程内对象。新起的进程若没有对应配置，就没有任何限制。

### 5.2 配置持久化（用户侧）

- 载体 A：`toolFilter` 写在**子代理描述符**里（持久化随描述符）；恢复 = 改回描述符。
- 载体 B：`context-ledger.hide` 写在 `<profile>/cordis.patch.yml`（F16：id 定向 config 覆盖）；恢复 = 改回该段。
- 载体 C：`disabled: true/false` 同一份 patch 文件。
- 本插件**不生成、不修改、不备份**这些配置；只输出可粘贴片段与恢复步骤（C3）。

### 5.3 「日后需要该工具时如何一键恢复」（诚实版）

| 步骤 | 动作 | 生效时机 |
|---|---|---|
| 1 | 在 `<profile>/cordis.patch.yml` 的 `- id: context-ledger` 条目里把 `hide.apply` 改回 `false`（或删掉整个 `config.hide` 段；只想恢复个别工具时从 `deny` 里删掉那些名字） | 下次重载或重启 |
| 2 | 重载：若 profile 启用了 HMR，保存即触发插件重载 ⇒ effect 释放 ⇒ 限制立即解除；否则重启 `dsh web`/对应 profile | 立即（HMR）/ 重启后 |
| 3 | 载体 A：把描述符里的 `toolFilter` 去掉，新子代理不再受限（**已在运行的子代理保留限制**直到它结束——描述符在子代创建时施加） | 新子代立即 |
| 4 | 已在上一步之前开始的会话：其限制随进程存在；重启即消失 | 重启 |

**必须如实说明的两点**：
1. **不存在**"撤销上一条隐藏"的命令；恢复就是把配置改回去。R6 **不提供**自动回滚。
2. 载体 A 的恢复**对已运行子代理不追溯**（它只在创建时施加）；载体 B 的恢复对**已创建的 agent** 也不追溯
   （只在 `agent/created` 时施加），但重启/重载会重建 agent 世界。

---

## 6. 面板呈现义务（拟并入 DESIGN §4.8，R2/后续轮实现）

1. **段标题**：zh「**可隐藏候选（工具级）· 需人工确认**」/ en `Hide candidates (tool level) · needs your call`；
   禁止"建议隐藏""安全移除""零损失"等措辞。
2. 每行必须给出：`name` + `unit`（单元名/种类）+ `tokens` + `registryUse.verdict` 的**人话解释**
   （"DSH 无法观测非模型的注册表调用"）+ 预校验状态（已校验/未校验/不支持）。
3. `hidePlanCaveat` 五条必须**常驻**该段底部（不得折叠、不得 tooltip）：
   注册表级不可用 / 非模型调用不可观测 / 服务耦合须人工确认 / 须人工确认 / 前缀缓存一次性失效。
4. 与 `prunePlan` 的并列规则见 §3.7；**两个动作的 token 不得相加**。
5. 未校验（`unvalidated` / `unsupported`）时，段内显示"未校验，不要直接照抄清单"的提示条，
   且**不显示**复制按钮。
6. `selfTool === true` 的候选（`context_ledger` 自身）要显示"隐藏后模型将无法再调用本账本"。

---

## 7. 隐私（拟并入 DESIGN §3.7）

R6 **不新增任何读取面**：
- 归属复用 R1 的扫描结果（已在 DESIGN §3.6 冻结为"只取布尔 + 包名 + 单个 evidenceFile"）；
- `registryUse.nameReferencedElsewhere` 复用 R1 的**弱命中文件路径**（已是白名单内的绝对路径）；
- 预校验读的是**工具注册表**（名字集合），不读任何文件、不读会话正文。
- S3 白名单需新增：`hidePlanUnits` 的 `kind` 复用 4 值、`inPrunePlan` 是布尔、`hideApply.mode` 两个常量、
  `registryUse` 的两个常量、`precheck.status`/`reason` 的枚举、`hidePlanCaveat` 的常量值。**无新字符串类别**。

---

## 8. 措辞红线（拟并入 DESIGN §6 第 11 条）

**任何输出面**（工具 JSON、native 渲染、面板、README）**不得**出现：
"安全隐藏 / 零功能损失 / 无副作用 / 放心删 / 只影响模型"等**把不可判定写成结论**的表述；
**不得**把 `hidePlan` 的 token 与 `prunePlan` 的 token 相加作为"总可省"；
**不得**在 `verdict !== "unconfirmed"` 之外给 `registryUse` 赋值（枚举只留语义占位）。
违反即为缺陷（与 DESIGN §6 第 10 条同源：把未知伪装成已知）。

---

## 9. R6 的取值边界（不做的事）

1. **不做全局限制**：宿主禁止（F2）。任何"绕过去"的方案（例如用 `guard` 冒充）都要被拒绝——
   `guard` 不减 schema（F10），拿它当隐藏手段是自欺。
2. **不自动施加、不写配置、不做自动回滚**（C3/§4.4）。
3. **不把 deny 说成"仅隐藏"**（F8）。
4. **不评估"功能是否由服务提供"**：静态不可判定，只输出证据与"须人工确认"。
5. **不引入作用域旋钮**（§4.4 第 3 点）。
6. **不解析/不修改别人的插件配置**：只读 profile patch 的**存在性**都不做——R6 完全不碰配置读取，
   配置由用户提供（本插件的 config 由宿主注入，不算"读文件"）。
7. **不为 MCP 服务器做跨服务器推断**：MCP 工具的隐藏与服务器进程无关（隐藏的只是 DSH 侧的注册表名字）。

---

## 10. 合并方案（队长执行；本文件不自合并）

### 10.1 章节映射（与 DESIGN 现有 §0–§10 结构兼容——只**追加**，不重排）

| 本文件 | 并入 DESIGN 的位置 | 动作 |
|---|---|---|
| §3.1–§3.3 | 新增 `### 2.18`、`### 2.19`、`### 2.20` | 追加（紧接 R1 的 DESIGN §2.13–§2.17 之后） |
| §3.4–§3.5 | 并入 `### 2.20`（预校验与恒等式） | 追加 |
| §3.6 | 替换/追加 `### 2.9` 的示例（**新增**一节 `### 2.21 R6 示例`，不动 DESIGN §2.9 原文） | 追加 |
| §3.7 | 新增 `### 2.22 与 prunePlan 的并存与并列呈现` | 追加 |
| §4 | 新增 `### 2.23 R6 施加模型与四条硬约束` | 追加 |
| §5 | 新增 `### 2.24 R6 恢复路径` | 追加 |
| §9 | 新增 `### 2.25 R6 取值边界` | 追加 |
| §7 | 新增 `### 3.7 R6 不新增读取面` | 追加 |
| §6 | 新增 `### 4.8 R6 面板呈现义务` | 追加 |
| §8 | 并入 `## 6` 第 11 条 | 追加一条 |
| §10.1 末行 | `## 9` 文件归属矩阵增 3 行（见 §10.3） | 追加行 |
| 全文件 | `## 8` 追加 v3 修订记录行 | 追加 |

**需要改动的既有行（仅 3 处，且都不改字段名/取值域）**：
1. DESIGN §2.1 的 `version` 行：常量 `2` → `3`（R6 新增必需字段）。
2. DESIGN §2.5 的 `findings` 表：追加 `hidePlan` / `hidePlanTokens` / `hidePlanUnits` / `hidePlanBasis` /
   `hidePlanStatus` / `hideApply` / `hidePlanCaveat` 七行。
3. DESIGN §2.9 与 §2.12 两个示例里的 `"version": 2` → `"version": 3`（示例跟形状走）。
   连带影响（属**实现线**任务，由队长派活，不在本草案内）：`test/**` 中任何 `version === 2` 的断言、
   以及 `test/whitelist.js` 的枚举扩展；`client.js` 若不读 `version` 则不受影响。

### 10.2 §8 待追加的修订记录行（草稿）

| 版本 | 日期 | 变更 | 触发 |
|---|---|---|---|
| v3 | 2026-10-07 | R6 工具级隐藏建议：`findings.hidePlan`/`hidePlanUnits`/`hideApply`/`hidePlanCaveat`（§2.18–§2.24）、`registryUse` 逐候选判定、作用域模型（**宿主禁止全局限制**，F2）、恢复路径（§2.24）；`version` 2 → 3 | R6 |

### 10.3 §9 文件归属矩阵待追加的行

| 文件 | 归属线 | R6 是否触碰 | 备注 |
|---|---|---|---|
| `lib/hide.js`（建议新增） | 宿主实现线 | ✅ 新建（纯函数：从 items+precheck 生成 `hidePlan`/`hidePlanUnits`/`hideApply`；不读盘） | 与 `lib/provide.js` 同规格 |
| `index.js` | 宿主实现线 | ✅（`restrictableNames` 预校验、`agent/created` opt-in 施加、schema 扩展、`version: 3`） | 唯一读盘者与唯一宿主依赖点 |
| `lib/reconcile.js` | 宿主实现线 | ✅（注入 R6 的 findings 键） | |
| `client.js` | 面板实现线 | ✅（§4.8 的段与并列呈现） | 与 `test/client-panel.test.mjs` 同线 |
| `<profile>/cordis.patch.yml`、子代理描述符 | **用户**（不在仓库内） | ⬜ 本插件只输出片段 | 明确不归任何实现线 |

### 10.4 合并前置条件（沿用 BACKLOG 的判据）

`git status` 中 `DESIGN.md` 无未提交改动，且 t6/t7/t8/t9 均为终态 ⇒ 队长执行合并。
合并时**必须**同时更新：`version` 常量、§2.5 表、§2.9 校验表（如果采纳新示例则新增断言）、
`test/whitelist.js` 的枚举（属于实现线任务，由队长派活）。

---

## 11. 与 t10 验收文本的差异（E4：如实说明，不迁就）

| # | 验收文本 | 本草案的实际结论 | 理由 |
|---|---|---|---|
| D1 | "全局限制（须显式说明这是有意为之）" | **全局限制不可用**；改为按 agent 作用域（并显式说明这是宿主约束下的有意选择） | F2：`dsh-tools/lib/index.js:2897` 硬报错。写"有意为之的全局限制"会把一个不可能的动作写进契约 |
| D2 | "可卸载单元 10 个" | 真机输出是 **5 个可卸载单元**（prunePlan）；**10** 只在"事实包级"计数下成立（7 个 plugin 事实包 + 1 个 mcp server + core + unknown） | t5 已把单元模型纠正为"可卸载单元 = profile dependencies ∩ dsh.profile.bundles"；示例按该模型写 5 个单元，并附计数对账表（§11.1） |
| D3 | "84 个 schema / 24 个未调用" | 与真机一致（沿用） | BACKLOG R6 实测 |
| D4 | "每个候选单元给出是否经注册表被调用的判定字段" | 落为 `registryUse`（逐**候选**）+ `hidePlanUnits`（逐单元）两处 | 判定本身不可得（无观测面），只能给"判定 + 依据 + 门"；笼统宣称无损失被 §8 定为缺陷 |

### 11.1 单元计数对账（为什么"10"与"5"都对，说的是两件事）

| 计数口径 | 数量 | 组成 |
|---|---|---|
| **事实包级**（工具名出现在哪些包） | **10** | 7 个 plugin 事实包（agent-teams / task-board / task-board-github / genui / modlens / dsh-annotate / dsh-context-ledger）+ mcp-server openviking + core + unknown |
| **可卸载单元级**（DESIGN §2.16 模型，prunePlan 用） | **5**（真机 t6） | openviking / `@linxin666/dsh-web-all`（折叠 task-board 系列 2 个事实包）/ modlens / genui / dsh-annotate |
| **可隐藏候选级**（本草案，hidePlan 用） | **24** | 全部零调用工具名（不要求单元可卸载） |

---

## 12. 未验证项与风险（诚实边界）

| # | 未验证/风险 | 影响 | 处理 |
|---|---|---|---|
| R1 | **继承性级联**（对 root agent 施加，子代是否自动受限）由 F11 的文档语义推出，**未实机执行验证** | 影响"覆盖范围"的措辞 | 契约只写"该 agent 及其层链继承者"；R6 实现线必须补一条实机验证（造 root + 子代，检查子代 schema 是否减少）；未验证前**不得**把覆盖范围写成"含全部子代理" |
| R2 | `agent/created` 里调用 `agent.ctx.tools.restrict` 的**时序**（是否早于首个请求装配）：F14 说明事件在放行排队工作前串行发出，但"restrict 在 setup 之后、首请求之前"这一具体时序**未实机验证** | 若过晚，首个请求仍带被隐藏工具的 schema（只影响第一次请求） | 契约要求实现线实测并用 `hideApply.appliedNames` 记录实际生效范围；若时序不成立则必须在文档标注"首个请求可能仍包含该 schema" |
| R3 | 面板的 `?session=` 路径在无活动 agent 时**只能给 `unvalidated`** | 用户可能照抄未校验清单 → 施加时硬错（F5） | 已用 `hideApply.denyList = []` + 面板不显示复制按钮封住（§4.3/§6） |
| R4 | 前缀缓存一次性失效的**金额**影响 | 无法量化（BACKLOG 已记录"拟合单价失败"） | 只写"一次性失效"这个可复核事实，不写金额（沿用 BACKLOG 的诚实边界） |
| R5 | `dsh-tools` 未来版本可能**放宽**普通 ctx 的限制（那时全局可用） | 契约可能过时 | §1 的 F2 是"本机 0.2.0-rc.2 的事实"；合并时在 §8 注明适用版本，并在实现里做**接口探测**（H3），不假设 |

---

## 13. 决策信封的实际使用记录（DESIGN §10）

| 判断 | 依据 | 处置 |
|---|---|---|
| C1 全局限制不可用 | E4（acceptance 前提本身有错）+ 一手源码 | 如实写出并改动作模型（§2.1） |
| D1 "10 个单元"差异 | E4 | 给出对账表（§11.1），不迁就 |
| F2/F8 等 DSH 事实 | 只读核验（不属任何实现线的改动请求） | 记录 file:line，不请求授权（只读） |
| 未改 DESIGN.md / 未改实现文件 | in-scope 约束 | 见本文件头部声明与 §14 的命令证据 |
| 若合并要动 `version` 常量与 §2.5 表 | E1（冻结字段） | **不自行改**，写入 §10.1 交给队长 |

---

## 14. 本任务的校验证据

| # | 命令 | 结果 |
|---|---|---|
| 1 | `test -f R6-DESIGN-DRAFT.md && wc -l R6-DESIGN-DRAFT.md` | 存在；行数见文末 |
| 2 | `git status --porcelain` | **`DESIGN.md` 无改动**；仅见本任务新增的未跟踪文件 `R6-DESIGN-DRAFT.md`（以及此前实现线留下的 `test/e2e.test.js` 改动与 `VERIFY-*.md`） |
| 3 | `node -e '<解析 §3.6 的 jsonc 块并逐条校验 A1–A14>'` | **ALL R6 EXAMPLE ASSERTIONS PASS**（A1–A14 全绿） |
| 4 | `node -e '<§ 引用完整性：抽取 §N.N 引用与标题求差集>'` | 无悬空引用 |

**校验脚本（命令 3 的等价实现，只读）**：

```sh
node -e '
const fs=require("fs");
const md=fs.readFileSync("R6-DESIGN-DRAFT.md","utf8");
const a=md.indexOf("### 3.6"),b=md.indexOf("```jsonc",a),c=md.indexOf("```",b+8);
const j=JSON.parse(md.slice(b+8,c));
const F=j.findings,sum=(x,f)=>x.reduce((s,y)=>s+f(y),0);
const ok=(k,v)=>{if(!v)throw new Error("FAIL "+k);console.log("ok "+k)};
ok("A1 hidePlanTokens==sum(hidePlan)",F.hidePlanTokens===sum(F.hidePlan,e=>e.tokens));
ok("A2 hidePlanTokens==sum(items)",F.hidePlanTokens===sum(j.items,i=>i.tokens));
ok("A3 units==hidePlanTokens",sum(F.hidePlanUnits,u=>u.tokens)===F.hidePlanTokens);
ok("A4 units toolCount==hidePlan.length",sum(F.hidePlanUnits,u=>u.toolCount)===F.hidePlan.length);
ok("A5 prunePlan sum",F.prunePlanReclaimableTokens===sum(F.prunePlan,e=>e.reclaimableTokens));
ok("A6 prune+noRec==hidePlanTokens",F.prunePlanReclaimableTokens+sum(F.noRecommendation,n=>n.tokens)===F.hidePlanTokens);
ok("A7 items==24",sum(F.prunePlan,e=>e.itemCount)+sum(F.noRecommendation,n=>n.items)===j.items.length);
ok("A8 denyList+skipped",F.hideApply.denyList.length+F.hideApply.skipped.length===F.hidePlan.length);
const desc=a2=>{for(let i=1;i<a2.length;i++){const p=a2[i-1],q=a2[i];if(p.tokens<q.tokens)return false;
 if(p.tokens===q.tokens&&!(p.name<q.name))return false}return true};
ok("A9 hidePlan sorted",desc(F.hidePlan));
ok("A10 hidePlanUnits sorted",F.hidePlanUnits.every((u,i)=>i===0||F.hidePlanUnits[i-1].tokens>u.tokens));
const byId=Object.fromEntries(j.items.map(i=>[i.id,i]));
ok("A12 hidePlan vs items 逐字一致",F.hidePlan.every(h=>byId[h.id]&&byId[h.id].name===h.name&&byId[h.id].tokens===h.tokens));
ok("A13 kind/target 组合",F.hidePlan.every(h=>["plugin","core","mcp-server","unknown"].includes(h.unit.kind)&&(h.unit.target===null||["plugin","mcp-server"].includes(h.unit.kind))));
ok("A14 caveat",Object.keys(F.hidePlanCaveat).length===5&&F.hidePlanCaveat.confirmationRequired===true);
ok("A15 denyList 升序去重",JSON.stringify(F.hideApply.denyList)===JSON.stringify([...new Set(F.hideApply.denyList)].sort()));
ok("A16 denyList==hidePlan names",JSON.stringify(F.hideApply.denyList)===JSON.stringify([...F.hidePlan.map(h=>h.name)].sort()));
ok("A17 24/24",j.items.length===24&&F.hidePlan.length===24);
console.log("ALL R6 EXAMPLE ASSERTIONS PASS");
'
```

---

## 附录 · 与 t5（DESIGN v2）的关系

本草案由 t5 的同一作者按同一纪律撰写，复用而不重造：`providedBy` 4 值域（§2.13）、
可卸载单元模型（§2.16）、恒等式与"没有证据就没有候选"（§2.15/§7.1）、S3 白名单与隐私自检（§3.4/§3.6）、
§9 文件归属矩阵与 §10 决策信封的用法。R6 **不改**这些，只在其上追加一层动作模型。
