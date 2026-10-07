# dsh-context-ledger DESIGN — 数据契约 · 隐私边界 · 面板层级（v3，已冻结）

> 状态：**FROZEN v3**（2026-10-07，任务 t13 / 触发 R6；v2 由任务 t5 触发 R1，v1 由任务 t1 冻结）
> 读者：实现线（宿主半区 / 客户端面板）、验证线、队长。
> 约束来源：[BRIEF.md](./BRIEF.md)（范围红线、隐私红线、环境事实、授权边界）+ [BACKLOG.md](./BACKLOG.md) R1 + [IMPLEMENTATION-NOTES.md](./IMPLEMENTATION-NOTES.md)。
> 变更控制：本文件冻结的**字段名、语义、排序规则、常量**不得由实现线自行改名或"顺手优化"。
> 需要变更时，必须另开任务并在此文件 `## 8. 修订记录` 追加一条，实现线照新版本施工。
> 文档结构：§0–§8 为 v1 既有骨架（**章节号不重排**，避免击穿 IMPLEMENTATION-NOTES / VERIFY-T4 的既有引用）；
> v2 新增内容追加为 §2.13–§2.17（R1 契约）、§9（文件归属矩阵）、§10（决策信封）；
> v3 新增内容追加为 §2.18–§2.25（R6 契约）、§3.7、§4.8、§9.1。

本文只冻结契约，不含实现代码。每一项各有唯一结论，不留"两种都行"。

**v1 → v2 的不兼容变更（实现线必须同步）**：canonical `version` 由 `1` 升到 `2`（新增必需字段 = 形状变更）；
`items[].providedBy`（`tools`/`mcp` 必需）、`scope.providerScan`、`findings.prunePlan` /
`findings.prunePlanReclaimableTokens` / `findings.prunePlanBasis` / `findings.noRecommendation` 为 v2 新增；
`ReconcileInput` 收敛为单一调用次数通道（F2）；`?cwd=` 旋钮移除（O2）。逐条见 §8。

**v2 → v3 的不兼容变更（实现线必须同步）**：canonical `version` 由 `2` 升到 `3`（新增必需字段 = 形状变更）；
`findings.hidePlan` / `hidePlanTokens` / `hidePlanUnits` / `hidePlanBasis` / `hidePlanStatus` / `hideApply` / `hidePlanCaveat` 为 v3 新增（§2.18–§2.25）；
R6 **只输出建议、不自动施加**（§2.23.4）。逐条见 §8。

---

## 0. 一句话结论

`context_ledger` 输出一份 canonical JSON 账本：**每个常驻注入物一行**，携带
`tokens`（常驻成本）· `calls`（观测调用次数）· `tokensPerCall`（每次使用成本）· `zeroCall`（是否零调用）
四要素；排序把"零调用"顶到最前，其次是"每次使用最贵"。
调用次数**只能**来自会话日志回放中 `type == "tool/call"` 的 `data.name`（工具名）——仅此一项，
其余字段一律不读。技能目录逐项与指令链无调用信号，一律记为 `null`（不可观测），
**绝不记为 0**；零调用必须由证据支撑（见 §2.4、§3.4）。

v2 追加一层**归属与候选**：`items[].providedBy` 回答"这个工具由谁提供"（插件包 / DSH 自带 / MCP 服务器 / 未知，
且**每条都标注置信度与判定手段**），`findings.prunePlan` 汇总为"**从未被模型调用的常驻项候选**"——
它是**人工判断的输入，不是卸载建议**：模型调用次数只能证明"没被模型调用"，不能证明"没用"
（该功能可能走 UI / 后台流程 / 极低频关键操作）。契约里成本是事实、归属是启发式、用处是未知，三者必须可区分。

---

## 1. 已核验的环境事实（实现线直接采信，不要重新假设）

| 事实 | 值 / 结论 | 核验方式（只读） |
|---|---|---|
| DSH 版本 / Node | 0.2.0-rc.2 / v26.10.0 | BRIEF 已实测 |
| 会话日志 | `<DSH_HOME>/sessions/<workspaceKey>/<sessionId>/session.v4.jsonl.zstd` | `ls ~/.dsh/sessions/--home-u-Desktop-DSHWorkspace--/<id>/` 实测：目录内仅 `session.v4.jsonl.zstd` + `session.lock` |
| `DSH_HOME` 缺省 | `~/.dsh`；隔离验证用 `.feas/isolated-home` | BRIEF 环境事实 |
| 日志事件形状 | `'tool/call': { turn, step, callId, name, arguments }` | `dsh-session/lib/types/known-event-types.js` + `dsh-agent-loop/lib/index.js:682` |
| `tool/call` 实际落盘键 | `type, seq, time, data{turn,step,callId,name,arguments}` | 实测解压一个真实会话，统计键名 |
| 解压 | 系统 `zstd`（`/usr/bin/zstd`，v1.5.7），`zstd -dc <file>` | `zstd --version` |
| `workspaceKey` 算法 | 分隔符 `/ \ :` 折叠为一个 `-`；`[A-Za-z0-9._-]` 原样；其余码元转 `~XXXX`（大写十六进制 4 位，`~` 自身也转义）；去掉前导 `-`；空则 `root`；截断到 251；两端包 `--` | `dsh-session-persistence-jsonl/lib/index.js:853-894`（`encodeSegment` / `projectKey`） |
| 日志文件名 | `session.v<version>.jsonl[.zstd]`，版本号来自当前格式代（本机 v4） | 同文件 `generationLogFilename` / `parseGenerationLogFilename` |
| 技能调用机制 | **只有一个** `skill` 工具（`name: "skill"`，参数 `{ name: string }`），技能名在**参数**里 | `dsh-tool-skill/lib/index.js:55-67` |
| 无技能激活事件 | 事件词汇表 54 项中没有任何 skill 级事件 | `known-event-types.js` 全量枚举核对 |
| 无 MCP / 工具调用计数器服务 | 会话日志是唯一可复现的调用次数来源 | 检索 DSH checkout：无 tool 调用计数持久化 |
| `~/.dsh/dsh-usage/usage-ledger.json` | 只有 provider/model 级 token 与 `calls`（模型请求数），**无工具名维度** | 实读该文件 → **不作为本插件数据源**（见 §6） |

> 结论性推论（冻结）：
> 1. 工具 schema / MCP 工具**可以**拿到精确的"调用次数"（工具名即可匹配）。
> 2. 技能目录**拿不到**逐技能调用次数（技能名在工具参数里，隐私红线禁止读参）。
> 3. 指令链**拿不到**任何调用信号（常驻，无调用动作）。
> 4. 因此数据模型必须能表达"次数未知"，并且**不得**把未知降级成 0。

---

## 2. 冻结项 A：数据模型（canonical JSON）

### 2.1 顶层对象

`context_ledger` 工具的输出值。字段全部必需，`additionalProperties: false`。

| 字段 | 类型 | 单位/取值 | 含义 |
|---|---|---|---|
| `tool` | string | 常量 `"context_ledger"` | 工具标识，便于回执识别 |
| `version` | integer | 常量 `3` | canonical 形状版本（v3 起为 3；v2 为 2、v1 为 1）。新增必需字段即视为形状变更，必须升号 |
| `generatedAt` | string | ISO-8601 UTC（`2026-10-07T02:41:07.512Z`） | 生成时刻 |
| `unit` | string | 常量 `"token"` | 所有 token 数值的单位；便于模型理解量纲 |
| `estimator` | string | 常量 `"heuristic-v1"` | token 估算器标识：`ceil(ascii/4 + nonAscii/1.5)`；仅用于相对比较与排序 |
| `cwd` | string | 绝对路径 | 本次对账的会话工作目录 |
| `scope` | object | 见 §2.2 | 观测范围与证据充分性（v2 增加 `providerScan`） |
| `categories` | array | 长度恒为 4，顺序固定 | 四类注入物的汇总（§2.3） |
| `items` | array | 见 §2.4 | 逐项账目，按 §2.7 排序（v2 增加 `providedBy`） |
| `findings` | object | 见 §2.5 | 面板与模型直接消费的清单（v2 增加 `prunePlan` 等） |
| `totals` | object | 见 §2.6 | 全局合计与一致性计数 |

### 2.2 `scope`（观测范围 / 证据充分性）

| 字段 | 类型 | 语义 |
|---|---|---|
| `workspaceKey` | string | 由 `cwd` 按 §1 算法得到的日志目录键 |
| `sessionsRoot` | string | 绝对路径，如 `/home/u/.dsh/sessions`（诊断用，仅路径） |
| `sessionsAvailable` | integer | 该 `workspaceKey` 下的会话目录总数 |
| `sessionsScanned` | integer | 实际成功读取并回放的会话数 |
| `sessionsUnreadable` | integer | 选中但读取/解压失败的会话数 |
| `sessionsLimit` | integer | 本次扫描上限（工具参数，默认 20，范围 1..200） |
| `windowStart` | string \| null | 被扫描会话中最早日志的 mtime（ISO-8601 UTC）；无则为 null |
| `windowEnd` | string \| null | 最晚日志的 mtime（ISO-8601 UTC）；无则为 null |
| `linesRead` | integer | 实际检视的 JSONL 行数（含被丢弃的行） |
| `toolCalls` | integer | 判定为 `tool/call` 的行数；恒等于 `Σ items[].calls(非空) + callsUnmatched + namesRejected`（= 观测到的一切工具调用） |
| `skillToolCalls` | integer | 其中 `data.name === "skill"` 的次数（技能机制级使用量） |
| `callsUnmatched` | integer | 工具名通过护栏但未匹配到任何账目项的调用次数 |
| `callsUnmatchedNames` | string[] | 未匹配的工具名，去重升序，≤20 项（**仅工具名**） |
| `namesRejected` | integer | 未通过 `NAME_PATTERN` 护栏而被丢弃的调用数（见 §3.3） |
| `usageAvailable` | boolean | **证据位**：`sessionsScanned >= 1`（至少一个日志被成功解压并完成逐行判定）即为 true。**不要求**观测到任何 `tool/call`——该窗口内"真的一次都没调用"是合法结论，必须能报成零调用，而不是降级成"无证据" |
| `truncated` | boolean | 任一被扫描日志触达 `MAX_LINES_PER_SESSION` 上限时为 true |
| `providerScan` | object | **v2 新增**：本次归属扫描自身的足迹，供人工复核"启发式确实跑过、跑的是哪些包"。字段见下 |

`scope.providerScan`（v2 新增，全部必需）：

| 字段 | 类型 | 语义 |
|---|---|---|
| `packages` | integer | 候选包数（profile 顶层包 + 核心作用域包） |
| `files` | integer | 实际读取的源码文件数 |
| `bytes` | integer | 实际读取的源码字节数 |
| `capped` | boolean | 是否触达任一**防御性上限**（§2.8 的 `MAX_SCAN_FILE_BYTES` / `MAX_SCAN_FILES_PER_PACKAGE` / 深度上限）。**仅供诊断**：为 true 不改变任何归属语义，但提示覆盖可能更窄 |

> 名称说明：`scope.truncated` 是"会话日志回放被截断"，`scope.providerScan.capped` 是"源码扫描触达上限"，
> 两者语义不同，不得互相借用（v2 特意不叫 `truncated` 以避免误读）。

### 2.3 `categories[]`（四类注入物，顺序固定）

顺序恒为 `["instructions", "skills", "tools", "mcp"]`（**身份稳定优先于量级**，量级由数字与占比表达）。

| 字段 | 类型 | 语义 |
|---|---|---|
| `key` | string | `"instructions" \| "skills" \| "tools" \| "mcp"` |
| `itemCount` | integer | 该类条目数 |
| `tokens` | integer | 该类常驻 token 合计 |
| `calls` | integer \| null | 该类**逐项**调用次数之和；该类无逐项次数则为 null |
| `tokensPerCall` | integer \| null | `tokens / calls` 四舍五入；`calls` 为 null 或 0 时为 null |
| `observableUsage` | boolean | 该类逐项次数是否可观测：`tools`/`mcp` = true，`instructions`/`skills` = false |
| `mechanismCalls` | integer \| null | **机制级**调用次数：仅 `skills` 用 `scope.skillToolCalls`，其余恒为 null |
| `mechanismTokensPerCall` | integer \| null | 仅 `skills`：`tokens / mechanismCalls` 四舍五入（`mechanismCalls > 0` 时），否则 null |

> `mechanismCalls` / `mechanismTokensPerCall` 存在的唯一理由：技能目录虽无法逐项归因，
> 但"整目录成本 ÷ 技能加载次数"是可观测、可决策的（例：4150 token ÷ 9 次 = 461 token/次）。
> 它们**不改变**逐项语义：`skills` 的 `calls` 与 `tokensPerCall` 恒为 null。

**部分可观测时的定论（v2 收口 O4，唯一读法）**：只要某类**存在至少一个** `calls === null` 的项，
该类 `calls` 与 `tokensPerCall` 恒为 `null`——**即使其余项次数已知，也不得给出部分和**。
理由：本插件的核心原则是"绝不把未知伪装成已知"；一个不完整的和会被读成完整的和，
这与"不产生假零调用"同源。若未来要保留"39/40 已知"这类信息，必须新增独立的
"部分可观测"状态（BACKLOG R4），**不得**通过放宽本条的 `null` 语义来实现。

### 2.4 `items[]`（逐项账目 —— 四要素的载体）

| 字段 | 类型 | 单位 | 必需 | 语义 |
|---|---|---|---|---|
| `id` | string | — | ✅ | 稳定唯一键：`"<category>:<name>"`（`instructions` 用绝对路径作 name） |
| `category` | string | — | ✅ | `"instructions" \| "skills" \| "tools" \| "mcp"` |
| `name` | string | — | ✅ | 展示名：指令链=绝对路径；技能=技能名；工具/MCP=工具名（MCP 保留 `mcp__<server>__<tool>` 全名） |
| `tokens` | integer ≥ 0 | token | ✅ | **成本**：该注入物每请求常驻的 token 估算 |
| `calls` | integer ≥ 0 \| null | 次 | ✅ | **调用次数**：`null` = 不可观测 / 无证据 |
| `tokensPerCall` | integer ≥ 0 \| null | token/次 | ✅ | **每次使用成本** = `round(tokens / calls)`；`calls` 为 null 或 0 时 null |
| `zeroCall` | boolean \| null | — | ✅ | **是否零调用**：仅当 `usageBasis === "tool-calls"` 时有布尔值（`calls === 0` → true）；否则 null |
| `usageBasis` | string | — | ✅ | 次数来源与可信度，见下表 |
| `source` | string | — | 可选 | `instructions`: `"project" \| "user"`；`skills`: 注册来源（如 `user-dsh`/`bundled`）；`tools`: 恒 `"native"`；`mcp`: 恒 `"mcp"` |
| `server` | string | — | 可选 | 仅 `mcp`：`mcp__<server>__<tool>` 解析出的 `<server>` |
| `bytes` | integer ≥ 0 | 字节 | 可选 | 序列化后字节数（指令链文件 / 工具 schema） |
| `provider` | string | — | 可选 | 仅 `skills`：技能 provider |
| `loadOrder` | integer ≥ 1 | — | 可选 | 仅 `instructions`：注入链顺序（外层→内层，从 1 起） |
| `providedBy` | object | — | `tools`/`mcp` **✅ 必需**；`instructions`/`skills` **必须省略** | **v2 新增**：该工具由谁提供（**启发式推导**，非运行时可证）。取值域、语义、置信度与判定表见 §2.13 |

`usageBasis` 取值（冻结，全集 4 个）：

| 值 | 用于 | 语义 |
|---|---|---|
| `"tool-calls"` | `tools` / `mcp` | 次数来自会话日志的 `tool/call` 名字匹配，**有证据** |
| `"no-evidence"` | `tools` / `mcp`，且 `scope.usageAvailable === false` | 日志不可读/为空的降级态；`calls = null`，不许宣称零调用 |
| `"unobservable"` | `skills`（逐项）；以及名字未通过 `NAME_PATTERN` 的任意项 | 该维度不存在可观测信号（隐私红线禁止读工具参数） |
| `"always-on"` | `instructions` | 常驻注入，没有"调用"这个动作 |

**赋值优先级（实现按此顺序判定，互斥）**：
1. `category === "instructions"` → `always-on`，`calls = null`，`zeroCall = null`。
2. `category === "skills"` → `unobservable`，`calls = null`，`zeroCall = null`。
3. 其余（`tools`/`mcp`）：`name` 不匹配 `NAME_PATTERN` → `unobservable`（并计入 `scope.namesRejected`）；
   否则 `scope.usageAvailable === false` → `no-evidence`；否则 `tool-calls`，`calls = 命中次数`（可为 0）。

### 2.5 `findings`（结论清单，直接供面板与模型消费）

| 字段 | 上限 | 排序 | 记录字段（字段名与 `items` 完全一致，不得改名） |
|---|---|---|---|
| `zeroCall` | 10 | `tokens` 降序 → `id` 升序 | `{ id, category, name, tokens }` |
| `topPerUse` | 10 | 未取整比值 `tokens/calls` 降序 → `tokens` 降序 → `id` 升序；仅 `calls > 0` | `{ id, category, name, tokens, calls, tokensPerCall }` |
| `prunePlan` | 不截断（与归属单元数同阶） | `reclaimableTokens` 降序 → `itemCount` 降序 → `target` 升序 | **v2 新增**，`PruneEntry` 见 §2.15 |
| `prunePlanReclaimableTokens` | — | — | **v2 新增**：integer，恒等于 `Σ prunePlan[].reclaimableTokens` |
| `prunePlanBasis` | — | — | **v2 新增**：常量 `"model-tool-calls-only"`——声明该清单的**证据边界**：只依据"模型工具调用次数"，不能据此推断功能无用 |
| `noRecommendation` | 固定 3 条，顺序固定 | `reason` 升序（= `core` → `no-owner-bundle` → `unknown-attribution`） | **v2 新增**：零调用但**不给出动作**的项分组计数，`{ reason, items, tokens }`，见 §2.16 |
| `hidePlan` | 不截断（候选数 ≤ 零调用工具数） | `tokens` 降序 → `name` 升序 | **v3 新增**：`HideEntry`，见 §2.18 |
| `hidePlanTokens` | — | — | **v3 新增**：integer，恒等于 `Σ hidePlan[].tokens`，见 §2.18/§2.20（H1） |
| `hidePlanUnits` | 不截断（与单元数同阶） | `tokens` 降序 → `toolCount` 降序 → `target ?? kind` 升序 | **v3 新增**：单元级汇总 `{ kind, target, factPackages, toolCount, tokens, usedToolCount, inPrunePlan }`，见 §2.18/§2.20 |
| `hidePlanBasis` | — | — | **v3 新增**：常量 `"model-tool-calls-only"`（与 `prunePlanBasis` 同源、同值），见 §2.18 |
| `hidePlanStatus` | — | — | **v3 新增**：`"prechecked" \| "unvalidated" \| "unsupported"`（三者取最弱一环），见 §2.20 |
| `hideApply` | — | — | **v3 新增**：`{ mode, interfacePresent, denyList, skipped, applySupported, appliedNames }`，见 §2.18/§2.23.4 |
| `hidePlanCaveat` | — | — | **v3 新增**：共享代价常量（5 键），必须在工具输出 / native 渲染 / 面板三处同时呈现，见 §2.19 |

`findings.zeroCall` **只**含 `zeroCall === true` 的项；`calls === null` 的项永远不进这两个清单中的 `zeroCall`。
当 `scope.usageAvailable === false` 时，`findings.zeroCall` 恒为 `[]`，且 `prunePlan` 恒为 `[]`
（**没有证据就没有候选**——不得用旧数据或推测填补）。

### 2.6 `totals`（合计与自洽计数）

| 字段 | 类型 | 恒等式 / 语义 |
|---|---|---|
| `residentTokens` | integer | `= observableTokens + unknownUsageTokens` |
| `observableTokens` | integer | Σ `tokens`（`calls !== null` 的项） |
| `unknownUsageTokens` | integer | Σ `tokens`（`calls === null` 的项） |
| `observedCalls` | integer | Σ `calls`（非 null 项） |
| `observableTokensPerCall` | integer \| null | `observedCalls > 0` 时 `round(observableTokens / observedCalls)`，否则 null |
| `zeroCallItems` | integer | `zeroCall === true` 的项数（⊂ observable 项） |
| `zeroCallTokens` | integer | `zeroCall === true` 的项 token 合计 |
| `unknownUsageItems` | integer | `calls === null` 的项数 |

### 2.7 排序（canonical `items` 顺序，冻结）

`items` 是全量项的唯一权威顺序，跨分类统一排：

1. **rank 0**：`zeroCall === true` —— 按 `tokens` 降序 → `id` 升序。
2. **rank 1**：`calls` 为非 null 且 > 0 —— 按**未取整** `tokens/calls` 降序 → `tokens` 降序 → `id` 升序。
3. **rank 2**：`calls === null`（不可观测 / 无证据）—— 按 `tokens` 降序 → `id` 升序。

规则说明（实现与验证都必须遵守）：排序键用**未取整**比值，输出字段 `tokensPerCall` 用 `Math.round`；
两者不一致是**设计如此**（避免两个等值项顺序抖动）。所有比较器必须是全序（含 `id` 兜底），
因此同一输入的输出字节级稳定。

### 2.8 常量（冻结）

| 常量 | 值 | 用途 |
|---|---|---|
| `FINDINGS_LIMIT` | 10 | `findings.*` 数组上限 |
| `DEFAULT_SESSIONS` | 20 | 默认回放会话数 |
| `MAX_SESSIONS` | 200 | `sessions` 参数上限（越界夹取，不报错） |
| `MAX_LINES_PER_SESSION` | 200000 | 单日志最多检视行数，超出即停并置 `scope.truncated = true` |
| `MAX_INSTRUCTION_FILE_BYTES` | 262144 | 指令链单文件上限，超出跳过（不注入则该文件不产生成本） |
| `UNMATCHED_NAMES_LIMIT` | 20 | `scope.callsUnmatchedNames` 上限 |
| `NAME_PATTERN` | `/^[A-Za-z0-9_.-]{1,128}$/` | 工具名/技能名护栏（§3.3） |
| `CACHE_TTL_MS` | 60000 | 宿主 HTTP 路由结果缓存（v1 既有；v2 **不新增**任何缓存层，见 §2.14） |
| `ESTIMATOR` | `"heuristic-v1"` = `ceil(ascii/4 + nonAscii/1.5)` | 与 context-doctor 同口径，便于横向比对 |
| `PACKAGE_PATTERN` | `/^(@[A-Za-z0-9-_.~]+\/)?[A-Za-z0-9-_.~]{1,214}$/` | **v2 新增**：`providedBy.name`（插件包名）与 `factPackages[]` 的唯一合法形态。npm 包名（含 scope）的宽松上界；用于 S3 白名单（§3.4） |
| `MCP_NAME_PATTERN` | `/^mcp__([A-Za-z0-9_.-]{1,64})__([A-Za-z0-9_.-]{1,128})$/` | **v2 新增**：`mcp-server` 归属的命名约定（server 名抽取）；不匹配即 `unknown` |
| `MAX_SCAN_FILE_BYTES` | 3145728 | **v2 新增·防御性上限（非性能优化）**：单个源码文件超过 3 MiB 跳过 |
| `MAX_SCAN_FILES_PER_PACKAGE` | 2000 | **v2 新增·防御性上限**：单包最多读取 2000 个文件，超出即停并置 `scope.providerScan.capped = true`（本机实测：无包触达此上限） |
| `MAX_SCAN_DEPTH` | 12 | **v2 新增·防御性上限**：目录遍历深度上限，配合 `realpath` 去重防符号链接环 |
| `SKIP_DIR_NAMES` | `{"node_modules","test","tests","docs","examples",".git","types"}` | **v2 新增**：扫描时跳过的目录名（`node_modules` 防嵌套依赖；其余为测试/文档/类型声明，不含注册点） |
| `SCAN_EXTENSIONS` | `{".js",".mjs",".cjs"}` | **v2 新增**：扫描的文件扩展名。**不扫** `.ts`/`.d.ts`/`.json`/`.map`（发布的插件注册点在这些扩展里的概率极低，且 `.json` 会引入 lockfile 噪声） |

### 2.9 完整示例 JSON（**合成数据**，用于展示形状与取值约束；非本机实测值；本机实测的扫描足迹见 §2.14）

```jsonc
{
  "tool": "context_ledger",
  "version": 3,
  "generatedAt": "2026-10-07T02:41:07.512Z",
  "unit": "token",
  "estimator": "heuristic-v1",
  "cwd": "/home/u/Desktop/DSHWorkspace",
  "scope": {
    "workspaceKey": "--home-u-Desktop-DSHWorkspace--",
    "sessionsRoot": "/home/u/.dsh/sessions",
    "sessionsAvailable": 41,
    "sessionsScanned": 20,
    "sessionsUnreadable": 1,
    "sessionsLimit": 20,
    "windowStart": "2026-09-30T00:12:44.001Z",
    "windowEnd": "2026-10-07T02:38:19.774Z",
    "linesRead": 41233,
    "toolCalls": 141,
    "skillToolCalls": 9,
    "callsUnmatched": 4,
    "callsUnmatchedNames": ["context_audit", "mcp__oldserver__ping"],
    "namesRejected": 0,
    "usageAvailable": true,
    "truncated": false,
    "providerScan": { "packages": 387, "files": 1593, "bytes": 49380329, "capped": false }
  },
  "categories": [
    { "key": "instructions", "itemCount": 1, "tokens": 812, "calls": null, "tokensPerCall": null,
      "observableUsage": false, "mechanismCalls": null, "mechanismTokensPerCall": null },
    { "key": "skills", "itemCount": 4, "tokens": 386, "calls": null, "tokensPerCall": null,
      "observableUsage": false, "mechanismCalls": 9, "mechanismTokensPerCall": 43 },
    { "key": "tools", "itemCount": 8, "tokens": 2113, "calls": 129, "tokensPerCall": 16,
      "observableUsage": true, "mechanismCalls": null, "mechanismTokensPerCall": null },
    { "key": "mcp", "itemCount": 3, "tokens": 1149, "calls": 8, "tokensPerCall": 144,
      "observableUsage": true, "mechanismCalls": null, "mechanismTokensPerCall": null }
  ],
  "items": [
    { "id": "mcp:mcp__openviking__add_resource", "category": "mcp", "name": "mcp__openviking__add_resource",
      "tokens": 402, "calls": 0, "tokensPerCall": null, "zeroCall": true, "usageBasis": "tool-calls",
      "source": "mcp", "server": "openviking", "bytes": 1609,
      "providedBy": { "kind": "mcp-server", "name": "openviking", "confidence": "high",
        "method": "mcp-naming", "evidenceFile": null, "candidates": [] } },
    { "id": "tools:subagent", "category": "tools", "name": "subagent", "tokens": 402, "calls": 0,
      "tokensPerCall": null, "zeroCall": true, "usageBasis": "tool-calls", "source": "native", "bytes": 1608,
      "providedBy": { "kind": "unknown", "name": null, "confidence": "low", "method": "static-scan-weak",
        "evidenceFile": null,
        "candidates": ["@linxin666/dsh-pet", "@linxin666/dsh-session-archive", "@linxin666/dsh-web-all",
          "@nanmicoder/dsh-agent-teams", "@openviking/dsh-memory-plugin", "dsh-context", "dshmarket"] } },
    { "id": "mcp:mcp__openviking__forget", "category": "mcp", "name": "mcp__openviking__forget", "tokens": 341,
      "calls": 0, "tokensPerCall": null, "zeroCall": true, "usageBasis": "tool-calls",
      "source": "mcp", "server": "openviking", "bytes": 1364,
      "providedBy": { "kind": "mcp-server", "name": "openviking", "confidence": "high",
        "method": "mcp-naming", "evidenceFile": null, "candidates": [] } },
    { "id": "tools:task_board_list", "category": "tools", "name": "task_board_list", "tokens": 292,
      "calls": 0, "tokensPerCall": null, "zeroCall": true, "usageBasis": "tool-calls",
      "source": "native", "bytes": 1168,
      "providedBy": { "kind": "plugin", "name": "@linxin666/dsh-client-ui-task-board", "confidence": "high",
        "method": "static-scan",
        "evidenceFile": "/home/u/.dsh/profiles/web/node_modules/@linxin666/dsh-client-ui-task-board/lib/index.js",
        "candidates": [] } },
    { "id": "tools:task_board_github_list", "category": "tools", "name": "task_board_github_list", "tokens": 196,
      "calls": 0, "tokensPerCall": null, "zeroCall": true, "usageBasis": "tool-calls",
      "source": "native", "bytes": 784,
      "providedBy": { "kind": "plugin", "name": "@linxin666/dsh-client-ui-task-board-github",
        "confidence": "high", "method": "static-scan",
        "evidenceFile": "/home/u/.dsh/profiles/web/node_modules/@linxin666/dsh-client-ui-task-board-github/lib/index.js",
        "candidates": [] } },
    { "id": "tools:task_board_schedule", "category": "tools", "name": "task_board_schedule", "tokens": 174,
      "calls": 0, "tokensPerCall": null, "zeroCall": true, "usageBasis": "tool-calls",
      "source": "native", "bytes": 696,
      "providedBy": { "kind": "plugin", "name": "@linxin666/dsh-client-ui-task-board", "confidence": "high",
        "method": "static-scan",
        "evidenceFile": "/home/u/.dsh/profiles/web/node_modules/@linxin666/dsh-client-ui-task-board/lib/index.js",
        "candidates": [] } },

    { "id": "tools:context_ledger", "category": "tools", "name": "context_ledger", "tokens": 214,
      "calls": 3, "tokensPerCall": 71, "zeroCall": false, "usageBasis": "tool-calls",
      "source": "native", "bytes": 856,
      "providedBy": { "kind": "plugin", "name": "dsh-context-ledger", "confidence": "low",
        "method": "static-scan-weak",
        "evidenceFile": "/home/u/Desktop/DSHWorkspace/dsh-context-ledger/index.js", "candidates": [] } },
    { "id": "tools:agent_teams_claim_task", "category": "tools", "name": "agent_teams_claim_task", "tokens": 268,
      "calls": 4, "tokensPerCall": 67, "zeroCall": false, "usageBasis": "tool-calls",
      "source": "native", "bytes": 1072,
      "providedBy": { "kind": "plugin", "name": "@nanmicoder/dsh-agent-teams", "confidence": "high",
        "method": "static-scan",
        "evidenceFile": "/home/u/.dsh/profiles/web/node_modules/@nanmicoder/dsh-agent-teams/lib/tool-names.js",
        "candidates": [] } },
    { "id": "mcp:mcp__openviking__find", "category": "mcp", "name": "mcp__openviking__find", "tokens": 406,
      "calls": 8, "tokensPerCall": 51, "zeroCall": false, "usageBasis": "tool-calls",
      "source": "mcp", "server": "openviking", "bytes": 1624,
      "providedBy": { "kind": "mcp-server", "name": "openviking", "confidence": "high",
        "method": "mcp-naming", "evidenceFile": null, "candidates": [] } },
    { "id": "tools:read", "category": "tools", "name": "read", "tokens": 186, "calls": 4,
      "tokensPerCall": 47, "zeroCall": false, "usageBasis": "tool-calls", "source": "native", "bytes": 744,
      "providedBy": { "kind": "core", "name": null, "confidence": "high", "method": "static-scan",
        "evidenceFile": "/opt/dsh/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-api-workspace-files/lib/index.js",
        "candidates": [] } },
    { "id": "tools:bash", "category": "tools", "name": "bash", "tokens": 381, "calls": 118,
      "tokensPerCall": 3, "zeroCall": false, "usageBasis": "tool-calls", "source": "native", "bytes": 1524,
      "providedBy": { "kind": "core", "name": null, "confidence": "high", "method": "static-scan",
        "evidenceFile": "/opt/dsh/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-bash/lib/index.js",
        "candidates": [] } },

    { "id": "instructions:/home/u/Desktop/DSHWorkspace/AGENTS.md", "category": "instructions",
      "name": "/home/u/Desktop/DSHWorkspace/AGENTS.md", "tokens": 812, "calls": null,
      "tokensPerCall": null, "zeroCall": null, "usageBasis": "always-on", "source": "project",
      "bytes": 3421, "loadOrder": 1 },
    { "id": "skills:genui", "category": "skills", "name": "genui", "tokens": 128, "calls": null,
      "tokensPerCall": null, "zeroCall": null, "usageBasis": "unobservable",
      "source": "user-dsh", "provider": "filesystem", "bytes": 512 },
    { "id": "skills:openviking-memory", "category": "skills", "name": "openviking-memory", "tokens": 96,
      "calls": null, "tokensPerCall": null, "zeroCall": null, "usageBasis": "unobservable",
      "source": "user-dsh", "provider": "filesystem", "bytes": 384 },
    { "id": "skills:openviking-skills", "category": "skills", "name": "openviking-skills", "tokens": 88,
      "calls": null, "tokensPerCall": null, "zeroCall": null, "usageBasis": "unobservable",
      "source": "user-dsh", "provider": "filesystem", "bytes": 352 },
    { "id": "skills:ov-experience-memory", "category": "skills", "name": "ov-experience-memory", "tokens": 74,
      "calls": null, "tokensPerCall": null, "zeroCall": null, "usageBasis": "unobservable",
      "source": "user-dsh", "provider": "filesystem", "bytes": 296 }
  ],
  "findings": {
    "zeroCall": [
      { "id": "mcp:mcp__openviking__add_resource", "category": "mcp",
        "name": "mcp__openviking__add_resource", "tokens": 402 },
      { "id": "tools:subagent", "category": "tools", "name": "subagent", "tokens": 402 },
      { "id": "mcp:mcp__openviking__forget", "category": "mcp", "name": "mcp__openviking__forget",
        "tokens": 341 },
      { "id": "tools:task_board_list", "category": "tools", "name": "task_board_list", "tokens": 292 },
      { "id": "tools:task_board_github_list", "category": "tools", "name": "task_board_github_list",
        "tokens": 196 },
      { "id": "tools:task_board_schedule", "category": "tools", "name": "task_board_schedule", "tokens": 174 }
    ],
    "topPerUse": [
      { "id": "tools:context_ledger", "category": "tools", "name": "context_ledger", "tokens": 214,
        "calls": 3, "tokensPerCall": 71 },
      { "id": "tools:agent_teams_claim_task", "category": "tools", "name": "agent_teams_claim_task",
        "tokens": 268, "calls": 4, "tokensPerCall": 67 },
      { "id": "mcp:mcp__openviking__find", "category": "mcp", "name": "mcp__openviking__find",
        "tokens": 406, "calls": 8, "tokensPerCall": 51 },
      { "id": "tools:read", "category": "tools", "name": "read", "tokens": 186, "calls": 4,
        "tokensPerCall": 47 },
      { "id": "tools:bash", "category": "tools", "name": "bash", "tokens": 381, "calls": 118,
        "tokensPerCall": 3 }
    ],
    "prunePlan": [
      { "kind": "mcp-server", "target": "openviking", "factPackages": [],
        "items": [
          { "id": "mcp:mcp__openviking__add_resource", "category": "mcp",
            "name": "mcp__openviking__add_resource", "tokens": 402 },
          { "id": "mcp:mcp__openviking__forget", "category": "mcp", "name": "mcp__openviking__forget",
            "tokens": 341 }
        ],
        "itemCount": 2, "reclaimableTokens": 743, "usedToolCount": 1, "confidence": "high" },
      { "kind": "plugin", "target": "@linxin666/dsh-web-all",
        "factPackages": ["@linxin666/dsh-client-ui-task-board", "@linxin666/dsh-client-ui-task-board-github"],
        "items": [
          { "id": "tools:task_board_list", "category": "tools", "name": "task_board_list", "tokens": 292 },
          { "id": "tools:task_board_github_list", "category": "tools", "name": "task_board_github_list",
            "tokens": 196 },
          { "id": "tools:task_board_schedule", "category": "tools", "name": "task_board_schedule",
            "tokens": 174 }
        ],
        "itemCount": 3, "reclaimableTokens": 662, "usedToolCount": 0, "confidence": "high" }
    ],
    "prunePlanReclaimableTokens": 1405,
    "prunePlanBasis": "model-tool-calls-only",
    "noRecommendation": [
      { "reason": "core", "items": 0, "tokens": 0 },
      { "reason": "no-owner-bundle", "items": 0, "tokens": 0 },
      { "reason": "unknown-attribution", "items": 1, "tokens": 402 }
    ]
  },
  "totals": {
    "residentTokens": 4460,
    "observableTokens": 3262,
    "unknownUsageTokens": 1198,
    "observedCalls": 137,
    "observableTokensPerCall": 24,
    "zeroCallItems": 6,
    "zeroCallTokens": 1807,
    "unknownUsageItems": 5
  }
}
```

示例自洽校验（验证线可直接照抄为断言）：

| 断言 | 值 |
|---|---|
| `residentTokens = observableTokens + unknownUsageTokens` | `4460 = 3262 + 1198` |
| `observableTokens = categories.tools.tokens + categories.mcp.tokens` | `3262 = 2113 + 1149` |
| `unknownUsageTokens = categories.instructions.tokens + categories.skills.tokens` | `1198 = 812 + 386` |
| `observedCalls = categories.tools.calls + categories.mcp.calls` | `137 = 129 + 8` |
| `scope.toolCalls = Σ items[].calls(非空) + callsUnmatched + namesRejected` | `141 = 137 + 4 + 0` |
| `observableTokensPerCall = round(observableTokens / observedCalls)` | `24 = round(3262 / 137)` |
| `zeroCallTokens` | `1807 = 402 + 402 + 341 + 292 + 196 + 174` |
| `items.length = Σ categories[].itemCount` | `16 = 1 + 4 + 8 + 3` |
| `unknownUsageItems` = 项数（`calls === null`） | `5`（1 instructions + 4 skills） |
| `categories.tools.tokensPerCall = round(2113 / 129)` | `16` |
| `categories.mcp.tokensPerCall = round(1149 / 8)` | `144` |
| `categories.skills.mechanismTokensPerCall = round(386 / 9)` | `43` |
| **`prunePlanReclaimableTokens = Σ prunePlan[].reclaimableTokens`** | `1405 = 743 + 662` |
| **`Σ prunePlan[].reclaimableTokens + Σ noRecommendation[].tokens = totals.zeroCallTokens`** | `1405 + 402 = 1807` |
| **`Σ prunePlan[].itemCount + Σ noRecommendation[].items = totals.zeroCallItems`** | `(2+3) + 1 = 6` |
| **`prunePlanReclaimableTokens ≤ categories.tools.tokens + categories.mcp.tokens`**（省额不得重复计入同类合计） | `1405 ≤ 3262` |
| `prunePlan` 顺序（`reclaimableTokens` 降序） | `743 → 662` |
| `prunePlan[].items` 顺序（`tokens` 降序 → `id` 升序） | `openviking: 402 → 341`；`web-all: 292 → 196 → 174` |
| `providedBy` 覆盖 | 11 个 `tools`/`mcp` 项**全部**有 `providedBy`；5 个 `instructions`/`skills` 项**全部**没有 |
| `providedBy.name` 与 `kind` 的组合约束 | `plugin` → 非 null 且匹配 `PACKAGE_PATTERN`；`mcp-server` → 非 null 且匹配 `MCP_NAME_PATTERN` 的 server 段；`core`/`unknown` → null |
| `items` 顺序 | 严格符合 §2.7：rank0（402,402 → 341 → 292 → 196 → 174）→ rank1（71.33 → 67 → 50.75 → 46.5 → 3.23）→ rank2（812 → 128 → 96 → 88 → 74） |
| `findings.zeroCall` / `topPerUse` 顺序 | 分别符合 §2.5 的 tokens 降序 / 未取整比值降序（`zeroCall` 中 `402` 并列时按 `id` 升序：`mcp:…` < `tools:…`） |

### 2.10 工具签名（模型半区，冻结）

```
name: "context_ledger"
parameters: { sessions?: integer }        // 1..200，缺省 20；越界夹取（v2 不新增任何参数）
output.schema: 对象，字段 = §2.1 全部必需字段（v2 含 providedBy / providerScan / prunePlan 系列），additionalProperties: false
```

`description`（**英文**，模型可读；**v2 修订**：加入归属与"候选而非建议"的措辞，实现线照抄）：

> Reconcile the resident cost of every injected context item against how often it is actually
> called in this workspace's session logs. Reports, per item: token cost, call count,
> cost-per-use (tokens ÷ calls) and whether it was never called. Also reports, per item, which
> package provides it — a heuristic inferred from installed plugin sources, never presented as
> fact — and groups never-called items by the plugin bundle or MCP server they come from.
> Those groups are CANDIDATES for review, not uninstall advice: a tool can still be used by the
> UI, by background flows, or rarely but crucially, and model call counts cannot prove otherwise.
> Read-only: it never writes a file, never reads message content, and extracts only tool names
> and counts from session logs.

### 2.11 native 渲染（文本块，冻结格式）

**节选说明（v2 收口 O1）**：下面是**模板节选**——零调用段示例给 3 行、`topPerUse` 段给 2 行，
而两者的实际上限是 `FINDINGS_LIMIT = 10`，R1 段（"candidate"）每单元给 1 个单元示例。
因此**契约是"逐行符合本模板 + 两个清单按各自上限完整渲染 + 每单元一行"**，
**不是**"与本节选逐字节相同"（v1 曾有过的表述不准确，以本条为准）。
每行只允许出现名字、数字、单位与固定枚举文案。

```text
Context ledger: 3688 tokens resident / 137 observed calls across 20 sessions / 18 tokens per use
Never called by the model (cost without model use): 3 items, 1035 tokens
  - mcp__openviking__add_resource [mcp]  402 tokens  0 calls
  - mcp__openviking__forget [mcp]  341 tokens  0 calls
  - task_board_list [tools]  292 tokens  0 calls
Most expensive per use:
  - context_ledger [tools]  214 tokens  3 calls  -> 71 tokens/call
  - agent_teams_claim_task [tools]  268 tokens  4 calls  -> 67 tokens/call
Not observable: instructions 812 tokens (always-on) / skills 386 tokens (per-skill unknown; 9 skill loads, 43 tokens/load)
Never-called candidates, grouped by removal unit — NOT uninstall advice: 1405 tokens in 2 units
  - mcp-server openviking: 2 tools, 743 tokens if unused  (1 other tool of this unit is in use)
  - plugin @linxin666/dsh-web-all: 3 tools, 662 tokens if unused  (provides @linxin666/dsh-client-ui-task-board, @linxin666/dsh-client-ui-task-board-github)
No actionable unit: 1 item, 402 tokens (unknown attribution 1)
A tool can still be used by the UI, by background flows, or rarely but crucially; verify before removing.
```

第 4 段（R1 追加段）**措辞是契约的一部分**：段标题必须含 "candidates" 与 "NOT uninstall advice"；
每个单元行必须给出 **单元名 + 工具数 + 可省 token + 同单元在用工具数 + 事实包名**（人才能判断"这是什么功能"）；
末行必须是固定的不确定性声明。**禁止**出现 "uninstall"/"remove"/"delete" 之类确定性动词
（`if unused` 这类条件措辞是允许且要求的）。中文面板文案对应要求见 §4.7。
模型可读文本按 §2.11 的英文渲染；面板文案跟随宿主语言（§4.5）。

### 2.12 降级态示例：日志不可读（`usageAvailable === false`）

当 `<sessionsRoot>/<workspaceKey>/` 不存在、或全部日志解压失败时，**不得**把 `tools`/`mcp` 报成零调用。
此时相对 §2.9 的差异（冻结，其他字段不变；下面**只列受影响的字段与代表条目**——
实际的 `categories` 恒为 4 条、`items` 为全量 `tools`+`mcp` 项，`instructions`/`skills` 项不变）：

```jsonc
{
"scope": { "sessionsAvailable": 0, "sessionsScanned": 0, "sessionsUnreadable": 0, "linesRead": 0,
           "toolCalls": 0, "skillToolCalls": 0, "callsUnmatched": 0, "callsUnmatchedNames": [],
           "namesRejected": 0, "usageAvailable": false, "truncated": false, "windowStart": null, "windowEnd": null,
           "providerScan": { "packages": 387, "files": 1593, "bytes": 49380329, "capped": true } },
"categories": [
  { "key": "tools", "itemCount": 8, "tokens": 2113, "calls": null, "tokensPerCall": null,
    "observableUsage": true, "mechanismCalls": null, "mechanismTokensPerCall": null }
],
"items": [
  { "id": "tools:task_board_list", "category": "tools", "name": "task_board_list", "tokens": 292,
    "calls": null, "tokensPerCall": null, "zeroCall": null, "usageBasis": "no-evidence",
    "source": "native", "bytes": 1168,
    "providedBy": { "kind": "plugin", "name": "@linxin666/dsh-client-ui-task-board", "confidence": "high",
      "method": "static-scan",
      "evidenceFile": "/home/u/.dsh/profiles/web/node_modules/@linxin666/dsh-client-ui-task-board/lib/index.js",
      "candidates": [] } }
],
"findings": { "zeroCall": [], "topPerUse": [], "prunePlan": [],
              "prunePlanReclaimableTokens": 0, "prunePlanBasis": "model-tool-calls-only",
              "noRecommendation": [ { "reason": "core", "items": 0, "tokens": 0 },
                                    { "reason": "no-owner-bundle", "items": 0, "tokens": 0 },
                                    { "reason": "unknown-attribution", "items": 0, "tokens": 0 } ] },
"totals": { "residentTokens": 4460, "observableTokens": 0, "unknownUsageTokens": 4460,
            "observedCalls": 0, "observableTokensPerCall": null,
            "zeroCallItems": 0, "zeroCallTokens": 0, "unknownUsageItems": 16 }
}
```

注意三点：①`categories[].observableUsage` 仍为 true（**方法**可观测），但逐项 `usageBasis` 是 `no-evidence`
（**本轮没有证据**）——两者是不同维度，不得互相覆盖；②`providedBy` 与调用次数**无关**，
日志不可读时归属照常给出（归属来自安装侧，不来自日志）；③`findings.prunePlan` 恒为 `[]`——
**没有调用证据就没有候选**（O3 意义上的"合成了矛盾输入"也不得让 `prunePlan` 变得有内容）。

### 2.13 `items[].providedBy`（R1 冻结：取值域 · 语义 · 置信度）

**性质声明（必须与字段一起理解，实现与面板措辞都不得违背）**：
`providedBy` 是**安装侧静态推断**，**不是运行时可证事实**。运行时的真实注册关系（哪个插件在哪个 agent scope 下注册了什么）
DSH 没有暴露可读接口，本插件也不做运行时 hook；因此契约用三个正交字段把"推断"标出来：
`kind`（结论）+ `confidence`（对 `kind` 判断的把握）+ `method`（判定手段），外加 `evidenceFile`（可复核的一手证据）。

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `kind` | string | ✅ | 归属类别，**取值域恰好 4 个**：`"plugin" \| "core" \| "mcp-server" \| "unknown"` |
| `name` | string \| null | ✅ | 归到具体单元时的单元名：`plugin` → 包名（匹配 `PACKAGE_PATTERN`）；`mcp-server` → server 名；`core` / `unknown` → **恒为 null** |
| `confidence` | string | ✅ | `"high" \| "low"`，**语义 = 对 `kind` 判断的把握**（不是对"有没有用"的把握，也不是对省额的把握） |
| `method` | string | ✅ | `"static-scan" \| "static-scan-weak" \| "mcp-naming" \| "not-found"`（判定手段，见 §2.14） |
| `evidenceFile` | string \| null | ✅ | 命中的源码文件**绝对路径**（人工复核入口）；多个命中时取**字典序最小者**；`mcp-naming` / `not-found` 时为 null |
| `candidates` | string[] | ✅ | 歧义候选（包名，升序去重，≤8）。**仅** `kind === "unknown"` 且 `method` 为 `static-scan` / `static-scan-weak` 时非空，其余恒为 `[]` |

**判定表（冻结；从上到下第一个命中者胜，互斥且穷尽）**：

| # | 条件（`tools` / `mcp` 项） | `kind` | `name` | `confidence` | `method` |
|---|---|---|---|---|---|
| 1 | `category === "mcp"` 且名字匹配 `MCP_NAME_PATTERN` | `mcp-server` | server 段 | `high` | `mcp-naming` |
| 2 | 强扫描：profile 候选包中**恰好 1 个**命中 | `plugin` | 该包名 | `high` | `static-scan` |
| 3 | 强扫描：profile 命中 **≥ 2 个**包 | `unknown` | null | `low` | `static-scan` |
| 4 | 强扫描：profile 0 命中，核心包 **≥ 1** 命中 | `core` | null | `high` | `static-scan` |
| 5 | 弱扫描（仅在上面全部落空后执行）：profile **恰好 1 个**包命中 **且** 核心 0 命中 | `plugin` | 该包名 | `low` | `static-scan-weak` |
| 6 | 弱扫描：profile 0 命中 **且** 核心 ≥ 1 命中 | `core` | null | `low` | `static-scan-weak` |
| 7 | 弱扫描：**歧义**——profile ≥ 2 包命中，或（profile ≥ 1 命中 且 核心 ≥ 1 命中） | `unknown` | null | `low` | `static-scan-weak`（`candidates` = 命中的 profile 包名，升序，≤8） |
| 8 | 其余（强、弱扫描均**无任何命中**） | `unknown` | null | `low` | `not-found` |

> 说明 1：第 7 行的语义是"**有线索但无法唯一归因**"，因此 `method` 记 `static-scan-weak` 并**必须**填
> `candidates`（让人看到是哪些包提到了它）；只有第 8 行才是"什么都没扫到"。
> 说明 2：`category === "mcp"` 但名字**不**匹配 `MCP_NAME_PATTERN` 的异常项走第 8 行
> （`unknown` / `not-found`）——不得用"看起来像 MCP"来推断。
> 说明 3：第 3 行优先于第 4 行（profile 歧义时不给 `core` 结论）：此时若报 `core`，用户会以为"这个工具
> 与已装插件无关、不可移除"，而事实是**两个已装包都提到了它**——宁可记 `unknown` 并列出候选，也不给错结论。

**硬规则（实现线必须遵守）**：
1. `kind` 的 4 个值**不得**增减、改名或合并（尤其：`mcp-server` 不得并进 `unknown`——那会把 16 个 MCP 工具的
   真实归属说成"查不到"；也不得并进 `core`）。
2. `confidence: "high"` **不代表**"这工具没用"或"卸载一定省这么多"；它只表示归属判定有唯一命中。
3. 面板与 README 呈现 `providedBy` 时**必须**同时呈现其推断性质（§4.7）；不得只印包名让人误读成事实。
4. `providedBy` **不得**出现在 `instructions` / `skills` 项上（这会与 `source` / `provider` 语义冲突，
   且那两类没有"工具注册点"可扫）。
5. `evidenceFile` 只允许是**路径**；**禁止**输出被匹配的行内容、片段、或任何源码文本（见 §3.6）。

### 2.14 R1 溯源方法（冻结的启发式算法 + 本机实测）

**扫描面（两个根，只读）**：

| 根 | 取值方式 | 用途 |
|---|---|---|
| profile 候选包 | `<DSH_PROFILE_DIR>/node_modules` 下的**全部顶层包**（含 `@scope/name`；符号链接指向 pnpm store 亦计入） | 归属到 `plugin` |
| 核心作用域包 | 由 `createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tools/package.json')` 定位，取其**父目录**（即 `@deepseek-ai` 作用域目录）下的全部包 | 归属到 `core` |

> `DSH_PROFILE_DIR` 由宿主注入（实测存在，值如 `/home/u/.dsh/profiles/web`）。
> **不得**硬编码 `/opt/dsh/node_modules/...`；隔离 `DSH_HOME` 下的解析结果自然指向隔离安装。
> profile 目录取不到时：`plugin` 归属全部退化为"无候选"，`core` 归属照常（核心根不依赖 profile）。

**匹配规则（两级）**：

| 级 | 正则（对文件全文，`NAME` 正则转义） | 语义 |
|---|---|---|
| 强 | ``\bname\s*:\s*(["'`])NAME\1`` | 命中**工具注册点**的 `name:` 属性写法（`defineTool({ name: 'x' })` 等） |
| 弱 | ``(["'`])NAME\1`` | 命中"名字以引号字面量出现过"（覆盖 `config.toolName \|\| 'x'`、`const X = 'x'` 之后以变量注册等间接写法） |

弱级**只在强级两处都落空后**执行，且要求唯一性（判定表第 5/6 行）。**禁止**把弱级结果当作强级使用
（它是"低置信"，不是"另一个 high"）。

**单趟算法（冻结，语言无关）**：
1. 枚举两个根的候选包（顶层目录，含 scope 展开）。
2. **每个候选文件只读取一次**；同一份文本上依次测试全部待归属名字（强级一遍、弱级一遍）。
3. 命中集合按"包名"聚合（去重；同包内多文件命中只算 1 个候选包，`evidenceFile` 取字典序最小命中文件）。
4. 按 §2.13 判定表给出 `providedBy`。
5. 记录 `scope.providerScan = { packages, files, bytes, capped }`。

**缓存：不引入。** R1 **不新增**任何缓存层（不缓存文件文本、不缓存命中结果、不加重建 TTL）。
依据：本机实测 —— 冻结规则下 profile 99 包 / 1048 文件 / 26.8 MB，核心 288 包 / 545 文件 / 20.3 MB，
合计 **387 包 / 1593 文件 / 47.1 MB，两趟全量扫描 ≈0.15 s（93 ms + 50 ms，内联原型，未做任何优化）**；
队长独立测量为 ~0.1 s（热缓存，857 MB/s）。0.15 s 不值得用陈旧数据与复杂度去换。
（v1 既有的 HTTP 路由 60s 结果缓存保持原样，与本条无关。）

**防御性上限（不是性能优化，双列以免再次被误读）**：

| 上限 | 值 | 触达后果 | 性质 |
|---|---|---|---|
| `MAX_SCAN_FILE_BYTES` | 3 MiB | 跳过该文件，`capped = true` | **防御性**：挡住被压成大 bundle 的单文件（本机实测有 3 个包含此类文件：`@changfenhuang/dsh-genui`、`dsh-client-ui-settings-account`、`dsh-client-ui-sidebar-documentpreview`，均为前端 bundle，非注册点） |
| `MAX_SCAN_FILES_PER_PACKAGE` | 2000 | 停止该包，`capped = true` | **防御性**：异常目录结构下的硬停（本机实测无包触达） |
| `MAX_SCAN_DEPTH` | 12 | 停止下探，`capped = true` | **防御性**：配合 `realpath` 去重防符号链接环 |

**实测覆盖与已知盲区（诚实边界；数字可复现，方法同上）**：
在 76 个名字（本会话可见工具名 + 本工作区真实会话日志中出现过的工具名）上跑冻结算法：

| 归属 | 数量 | 说明 |
|---|---|---|
| `plugin` / `high` | 29 | `@nanmicoder/dsh-agent-teams`（9）、`@linxin666/dsh-client-ui-task-board` + `-github`（17）、`@changfenhuang/dsh-genui`（2）、`dsh-annotate`（1） |
| `core` / `high` | 25 | `bash`/`read`/`edit`/`write`/`grep`/`glob`/`skill`/`todo_write`/`present`/`job_list`/… |
| `mcp-server` / `high` | 16 | `mcp__openviking__*` → server `openviking` |
| `plugin` / `low`（弱级） | 2 | `modlens_read_image` → `@liustack/modlens`；`context_ledger` → `dsh-context-ledger`（自己，注册名经常量传递，强级扫不到） |
| `core` / `low`（弱级） | 2 | `exit_plan_mode` → `dsh-plan-mode`；`workflow` → `dsh-tool-workflow`（名字经常量/配置传递） |
| `unknown` / `low` | 2 | `subagent`（弱级 profile 命中 7 包、核心 33 文件 → 歧义）、`subagent_fork`（2 包） |

即 **74/76 给出归属（97%），仅 2 个真正未知**——且这 2 个在弱级是**歧义**（不是"查不到"），
契约选择保守记 `unknown` 而**不做**猜测。分解对照：只用强级 + MCP 命名 = **70/76（92%）**，
6 个落空；弱级把其中 4 个（两名 `plugin`、两名 `core`，都是"名字经常量/配置传递"的写法）救回。
（队长独立测量给出 58/80（72%）——其口径把 16 个 MCP 工具记为"未溯源"；
本契约按 `mcp__<server>__<tool>` 命名约定把 MCP 计入 `mcp-server`，故总数更高。两种口径的差异只在这 16 项。）
**已知盲区**（不掩盖）：
- 名字完全由运行时拼装（如 `mcp__<server>__<tool>` 之外的动态名）不可扫；
- 弱级唯一命中**仍可能是假阳性**（同名字面量出现在无关语境）——这正是它只能记 `low` 的原因；
- **另一条被否决的路**：把弱级放宽为"命中即接受、不要求唯一性"会引入假归属。实测证据：`annotation`
  在弱级命中 3 个包（`@changfenhuang/dsh-genui`、`dsh-annotate`、`katex`）——若不做唯一性要求，
  它可能被判给 `genui`；而强级给出的 `dsh-annotate` 才是真的（该包 `index.js` 里有 `name: 'annotation'`）。
  这类假归属会直接污染裁剪候选，因此弱级**必须**带唯一性门槛（判定表第 5/6 行），歧义一律落回 `unknown`（第 7 行）。
  总体取向：**精度优先于覆盖**——宁可少给一个归属，也不给一个错的归属。

### 2.15 `findings.prunePlan`（R1 冻结：canonical 形状）

**性质（措辞即契约）**：`prunePlan` = 「**从未被模型调用的常驻项候选**」。
它**不是**卸载建议、不是"没用的清单"、不是"这次清理能省这么多"的承诺。
每条都是"**若你也未使用其 UI / 后台功能**，移除该单元可省下这些 token"的条件式候选。

`PruneEntry`（所有字段必需）：

| 字段 | 类型 | 语义 |
|---|---|---|
| `kind` | string | `"plugin" \| "mcp-server"`——动作种类（卸载插件包 / 移除 MCP 服务器）。**取值域只有 2 个**：本字段描述"可执行的单元类型"，不描述归属（归属在 `items[].providedBy`） |
| `target` | string | **卸载单元名**：`plugin` → profile 的**顶层 bundle 包名**（`dsh.profile.bundles` ∩ profile `dependencies` 中可达该事实包的那个，见 §2.16）；`mcp-server` → server 名 |
| `factPackages` | string[] | **仅 `plugin`**：该单元下承载零调用工具的**事实包名**（即 `items[].providedBy.name` 去重升序）；`mcp-server` 恒为 `[]` |
| `items` | array | 该单元下**从未被模型调用**的项：`{ id, category, name, tokens }`（字段名与 `items[]` 一致，不得改名）。**同一项在所有条目里最多出现一次**（禁止跨条目重复计入） |
| `itemCount` | integer | `= items.length` |
| `reclaimableTokens` | integer | **可省 token**：`= Σ items[].tokens`。**只算这些项自身的 `tokens`**；不得乘以任何倍数、不得并入同类合计、不得把 `itemCount` 当作 token 累加 |
| `usedToolCount` | integer | 同一逻辑单元下 `zeroCall === false` 的工具数（**卸载代价信号**：> 0 说明该单元还在被模型使用） |
| `confidence` | string | `"high" \| "low"`：该条目**全部** `items[].providedBy.confidence === "high"` 时为 `high`，否则 `low`（取最弱一环） |

**排序（全序，冻结）**：`reclaimableTokens` 降序 → `itemCount` 降序 → `target` 升序。

**入组与排除（冻结；4 类排除理由见 §2.16）**：

| 入 `prunePlan` 的条件 | 排除到 `noRecommendation` 的条件 |
|---|---|
| `zeroCall === true`（**有证据的零调用**） | `calls === null`（不可观测 / 无证据）→ **完全不进任何清单** |
| `providedBy.kind === "plugin"` 且该事实包恰属**一个可卸载 bundle** | `providedBy.kind === "core"` → `reason: "core"` |
| `providedBy.kind === "mcp-server"` | `providedBy.kind === "unknown"` → `reason: "unknown-attribution"` |
| — | `plugin` 但找不到唯一可卸载 bundle（0 个或多个，或 profile manifest 不可读）→ `reason: "no-owner-bundle"` |

**禁止**：把 `instructions` / `skills` 项放进 `prunePlan`（那两类连逐项调用次数都没有，谈不上"从未被调用"）。

### 2.16 动作单元解析 + 省额口径与自洽恒等式

**动作单元（`target`）解析规则（冻结）**：
1. 读 profile manifest：`<DSH_PROFILE_DIR>/package.json` 的 `dependencies`（可卸载的包集合）与
   `dsh.profile.bundles`（已装载的 bundle 集合）；**可卸载 bundle = 二者交集**。
2. 对每个可卸载 bundle `B`：取其包目录下 `package.json` 的 `dsh.bundle.patch` 相对路径 → 读该 patch 文本。
3. 事实包 `P` 的**归属 bundle** = patch 文本中出现 `P` 名字面量的那个 `B`（`P === B` 时也算命中自身）。
   *（实测：`@linxin666/dsh-client-ui-task-board` 的两个包都由 `@linxin666/dsh-web-all` 的 patch 以
   `config.plugin:` 引入 ⇒ 它们的动作单元是 `@linxin666/dsh-web-all`，而不是包名本身。）*
4. 恰 1 个 → `target = B`；0 个或多个 → `reason: "no-owner-bundle"`。
5. `mcp-server` 项：动作单元 = server 名本身（`kind: "mcp-server"`），不做 bundle 解析
   （MCP 服务器由用户自己的 MCP 配置提供，可能来自任意插件；**本契约不承诺单一卸载命令**）。
6. manifest 不可读 → 全部 `plugin` 项进 `reason: "no-owner-bundle"`（**不猜**）。

**`noRecommendation`（固定 3 条，顺序固定，全部必需）**：

| 顺序 | `reason` | 含义 |
|---|---|---|
| 1 | `"core"` | DSH 自带（`providedBy.kind === "core"`）：用户无法通过卸载移除 |
| 2 | `"no-owner-bundle"` | 归到了某个插件包，但在 profile 里找不到**唯一**可卸载的装载单元（或 manifest 不可读） |
| 3 | `"unknown-attribution"` | 归属未知（`providedBy.kind === "unknown"`）：**无法给出动作** |

每条 `{ reason, items, tokens }`：`items` = 该理由下的零调用项**数**，`tokens` = 其 `tokens` 之和。
理由为空时**保留该条**并把两个计数值置 0（固定形状便于机器校验，面板自行过滤 0 值）。

**省额口径（冻结，三条不许违反）**：
1. **逐项自身 tokens 求和**，不乘倍数、不按比例外推、不把同类 `categories[].tokens` 当作可省额。
2. **同一项只进一个条目**（`items[].id` 在 `prunePlan` 内全局唯一）——`plugin` 与 `mcp-server` 不重叠，
   两个 bundle 之间也不重叠（每项只有一个 `target`）。
3. **不承诺净收益**：卸载一个 bundle 会连带移除它提供的**在用工具**（`usedToolCount` 是提示），
   因此 `reclaimableTokens` 的语义是"**这些候选项自身占用的常驻 token**"，不是"卸载后的净节省"。

**恒等式（冻结，验证线可直接断言）**：
1. `findings.prunePlanReclaimableTokens = Σ prunePlan[].reclaimableTokens`
2. `Σ prunePlan[].reclaimableTokens = Σ items[zeroCall===true ∧ providedBy.kind ∈ {plugin, mcp-server}].tokens`
3. `Σ prunePlan[].itemCount + Σ noRecommendation[].items = totals.zeroCallItems`
4. `Σ prunePlan[].reclaimableTokens + Σ noRecommendation[].tokens = totals.zeroCallTokens`
5. `prunePlanReclaimableTokens ≤ categories.tools.tokens + categories.mcp.tokens`（**省额不得重复计入同类合计**）
6. `scope.usageAvailable === false` ⟹ `prunePlan === []` ∧ `prunePlanReclaimableTokens === 0` ∧ `noRecommendation` 三条全为 0

### 2.17 R1 的取值边界（不做的事，防止实现线自行扩张）

1. **不解析 cordis patch 的 id / 嵌套结构**：只用"包名文本命中"判断归属 bundle。
   暴露"可单独停用某一行（`- id: web-ui-task-board`）"需要解析 YAML 结构，收益（用户可更细粒度停用）
   与脆弱性（patch 由各 bundle 作者生成、已见 AUTO-GENERATED 变体）不成比例 → **R1 不做**，记为 R2/后续候选。
2. **不扫描 `node_modules` 之外的安装形态**（如全局 npm 前缀、`pnpm` store 直接路径）：实测目标包都在 profile
   顶层 `node_modules` 下（pnpm 通过符号链接暴露）；扫描 store 会引入路径与内容重复。
3. **不引入运行时 hook / 不注册 DSH 内部 API 监听**：本插件只读，不改变宿主行为。
4. **不新增参数旋钮**：R1 不在 `context_ledger` 上加开关（v1 的 O2 教训：无设计的旋钮会产出降级数据）。
   扫描总是执行；不需要时由调用方忽略 `providedBy` / `prunePlan`。
5. **不做跨 profile 汇总**：只看当前 `DSH_PROFILE_DIR` 的一个 profile。

---

---

### 2.18 R6 数据形状：`findings.hidePlan` 与其余新增键（v3 新增）

**性质（措辞即契约）**：`hidePlan` = 「**可以把这些工具从该 agent 的模型可见面与可调用面移除**的候选」。
它**不是**"安全删除清单"，也不是"零成本"：代价由 `registryUse` 与 §2.19 的 caveat 如实表达。

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `id` | string | ✅ | 与 `items[].id` **逐字相同**（`"<category>:<name>"`），用于与账目项对齐 |
| `name` | string | ✅ | **全局工具名**——施加 deny 时用的正是它（匹配 `NAME_PATTERN`） |
| `category` | string | ✅ | 恒为 `"tools"` 或 `"mcp"`（只有这两类有逐项调用次数与可限制性） |
| `tokens` | integer ≥ 0 | ✅ | 该 schema 的常驻成本（与 `items[].tokens` 逐字相同） |
| `unit` | object | ✅ | 归属单元（复刻 §2.13 的 4 值模型，**不新造**）：`{ kind, target, factPackages }` |
| `registryUse` | object | ✅ | **逐候选的「该功能是否经工具注册表被调用」判定**（§2.19） |
| `precheck` | object | ✅ | 名字预校验结果（§2.20）：`{ status, restrictable, reason }` |
| `selfTool` | boolean | ✅ | 仅当 `name === "context_ledger"` 为 true：隐藏它会移除模型的入口（不违规，但必须可见） |

`unit` 子字段：

| 子字段 | 类型 | 语义 |
|---|---|---|
| `kind` | string | `"plugin" \| "core" \| "mcp-server" \| "unknown"`（取值域与 `providedBy.kind` 完全一致） |
| `target` | string \| null | `plugin` → 该事实包的**可卸载 bundle**（若存在，按 §2.16 解析；否则 null）；`mcp-server` → server 名；`core`/`unknown` → null |
| `factPackages` | string[] | `plugin` → 事实包名（升序）；其余 `[]` |

> **关键差异（R6 的价值所在）**：`hidePlan` 的候选**不要求**单元可卸载。`core` 与 `unknown` 归属的工具
> 进不了 `prunePlan`，但**可以**被 deny（它们同样是全局名字）。这是 R6"救活 R1 收益"的机制来源。

| 字段 | 类型 | 语义 |
|---|---|---|
| `hidePlanTokens` | integer | `= Σ hidePlan[].tokens`（= 全部零调用工具的常驻成本；恒等式见 §2.20） |
| `hidePlanUnits` | array | **单元级汇总**（`{ kind, target, factPackages, toolCount, tokens, usedToolCount, inPrunePlan }`），排序 `tokens` 降序 → `target` 升序；`target` 为 null 时用 `kind` 参与排序（见 §2.20 排序规则） |
| `hidePlanBasis` | string | 常量 `"model-tool-calls-only"`（与 `prunePlanBasis` 同源、同值：证据边界相同） |
| `hidePlanStatus` | string | `"prechecked" \| "unvalidated" \| "unsupported"`（§2.20） |
| `hideApply` | object | `{ mode, interfacePresent, denyList, skipped, applySupported, appliedNames }`（§2.23.4） |
| `hidePlanCaveat` | object | **共享代价常量**（§2.19），逐条强制呈现，替代"每个条目重复三句" |

### 2.19 `registryUse` 与共享 caveat（该功能是否经工具注册表被调用）

| 字段 | 类型 | 语义 |
|---|---|---|
| `verdict` | string | `"unconfirmed"`（默认且唯一现实取值）/ `"model-observed"`（语义占位：若模型调用过则该工具根本不会进候选） |
| `verdictBasis` | string | 常量 `"no-non-model-observability"`：为什么给不出更强结论——DSH 未暴露"非模型的注册表调用"的可观测面（会话日志只记录模型发起的 `tool/call` 与 PTC 子派发，见 §3.1） |
| `modelCalls` | integer | 该工具的模型调用次数（= `items[].calls`；**候选恒为 0**） |
| `nameReferencedElsewhere` | string[] | **启发式证据**（≤3，绝对路径，升序）：其他包源码中该名字的**弱命中文件**（R1 弱扫描语料，见 §2.14）。用途：提示"这个名字在别处被引用过"，**不等于**被调用——弱命中也可能是文档/注释/字符串表 |
| `nonModelCallers` | string | 常量 `"unobservable"` |

**硬规则**：
1. `verdict` **不得**出现 `"safe"` / `"unused"` / `"no-loss"` 之类值——那等于把不可判定的事情写成结论。
2. 呈现层必须同时展示 `verdictBasis`（"DSH 没有该观测面"）与 `confirmationRequired`（§2.19），
   否则用户会把"没查到"读成"不存在"。
3. `nameReferencedElsewhere` 非空时，该候选在面板上必须带"别处引用过该名字（需人工确认）"标记。

`hidePlanCaveat`（共享常量，**必须**在工具输出、native 渲染与面板三处同时呈现）：

| 字段 | 值 | 含义 |
|---|---|---|
| `registryHideIsTotal` | `true` | deny 让该名字在**该作用域内的注册表**上不可见也不可解析（注册表级：`dsh-tools/lib/index.js:2995-2996`、`:3011-3016`），**不是**仅从 schema 里抹掉 |
| `nonModelRegistryCalls` | `"unobservable"` | 非模型的注册表调用没有观测面（§2.19） |
| `serviceCoupling` | `"unconfirmed"` | "功能是否由独立服务提供（UI/后台不经注册表）"静态不可判定，须逐单元人工确认 |
| `confirmationRequired` | `true` | 施加前必须人工确认；本插件不代替用户确认 |
| `prefixCacheCost` | `"one-time-invalidation"` | 任何隐藏都会改变请求前缀，导致 prompt cache **一次性**失效（BACKLOG R1 已实测：输入 token 98–99% 是缓存命中）；这是**一次性成本**，不是持续成本 |

### 2.20 precheck、hidePlanStatus、排序、上限与恒等式（冻结）

`precheck`（逐候选）：

| 字段 | 类型 | 语义 |
|---|---|---|
| `status` | string | `"prechecked"`（已对该 agent 的 `restrictableNames` 校验）/ `"unvalidated"`（有该接口但拿不到 agent 作用域）/ `"unsupported"`（宿主没有该接口） |
| `restrictable` | boolean \| null | `status === "prechecked"` 时为布尔；否则 null（**不得**用 false 表示"没查"） |
| `reason` | string \| null | 仅当 `restrictable === false` 或非 prechecked 时给出枚举：`"not-in-restrictable-names"` / `"no-agent-scope"` / `"interface-absent"` / `"reserved-name"`（`run_code`，本插件不会产出它） |

`hidePlanStatus`（全局）：三者取**最弱**一环——任一项 `unsupported` ⇒ `unsupported`；否则任一项 `unvalidated` ⇒ `unvalidated`；否则 `prechecked`。

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

### 2.21 R6 完整示例 JSON（增量片段；载荷合成，单元边界与真机合计一致）

> 本示例是 canonical 报告的 **R6 增量片段**：`findings` 完整 + 全部 24 个零调用 `items`（R6 的候选来源）。
> `items` 只列与 R6 相关的字段；完整 `items[]` 字段（`providedBy` 等）见 §2.9/§2.13。
> `findings.prunePlan` 原样带上，用于展示两套动作的配对（§2.22）。
> **每个数字的出处见 §2.21.2**；`version` 由 2 升 3（新增强制字段即形状变更）。
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

#### 2.21.1 示例自洽校验（冻结断言；验证线可直接照抄）

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

**本示例是机械校验通过版**（A1–A17 全绿）；这 17 条断言是冻结契约的一部分，实现线与验证线都必须逐条通过。

#### 2.21.2 每个数字的出处（避免把示例当实测）

| 数字 | 值 | 出处 |
|---|---|---|
| 工具 schema 数 | 84 | BACKLOG R6 2026-10-07 实测（"工具 schema 84 个，实际被调用 60 个"） |
| 从未被调用的工具数 | 24 | 同上 |
| 零调用 tokens 合计 | 4261 | t6 真机交付记录；队长记录「真机实测 ΣprunePlan + ΣnoRecommendation = 3376 + 885 = 4261」 |
| 可卸载单元 3376 的分项 | 1674 / 1325 / 156 / 133 / 88 | 同上（"真机实测各插件可省 token 明细"） |
| openviking 8 项的逐项 tokens | 891/464/122/75/47/30/27/18 | t6 真机输出（逐项列出，合计 1674） |
| `usedToolCount`：openviking 8、web-all 3、genui 1，其余 0 | — | openviking 8 = t6 真机；web-all 3、genui 1 = VERIFY-T7 §3.3 真机渲染行 |
| 其余逐项 tokens（web-all 6 项、core 6 项、unknown 1 项、modlens/genui/annotate 各 1 项） | 合成 | **本示例合成**，只保证"每个单元合计 = 真机合计"（1325 / 483 / 402 / 156 / 133 / 88） |
| 单元归属（`target` / `factPackages`） | — | §2.16 模型 + VERIFY-T7 §3.3 真机复核（task-board → web-all） |

### 2.22 与 `prunePlan` 的并存关系与并列呈现（冻结）

| 维度 | `prunePlan`（R1，v2 已冻结，**不改**） | `hidePlan`（R6，本草案） |
|---|---|---|
| 动作 | 卸载/移除一个**单元**（插件 bundle 或 MCP 服务器） | 从**模型可见面与注册表**移除**单个工具名** |
| 候选条件 | `zeroCall === true` ∧ 归属 ∈ {plugin, mcp-server} ∧ **恰有一个可卸载 bundle** | `zeroCall === true` ∧ `category ∈ {tools, mcp}`（**不要求**可卸载单元） |
| 覆盖面 | 3376 tokens（真机） | 4261 tokens（真机）——多出的 885 是 core/unknown 归属 |
| 代价信号 | `usedToolCount`（失去的在用工具数）+ 失去整个插件（含 UI/后台） | `registryUse`（注册表级不可调用 + 不可观测的调用者）+ `hidePlanCaveat`（须人工确认） |
| 恢复 | 重装插件（或 `disabled: false`） | 删配置 + 重载（§2.24） |
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

### 2.23 R6 施加模型与四条硬约束的落地（v3 新增）

### 2.23.1 H1 · 作用域：按 agent，而不是全局（有意为之）

- **施加点**：被审计 agent 的作用域（`exec.agent` 对应的 agent），机制是 `agent.ctx.tools.restrict({ deny })`。
- **为什么不是全局**：DSH **禁止**（`dsh-tools/lib/index.js:2895-2897`）。契约显式记录这是被宿主约束的**有意选择**，不是疏漏。
- **为什么影响主 agent 是对的**：常驻工具成本是**按该 agent 的视图**量出来的（§2.2 的成本侧用 `tools.schemas(agent)`），
  所以隐藏该 agent 视野里的工具，省的正是账本里那一笔。
- **覆盖范围（机器语义 + 诚实边界）**：该 agent 的作用域及其**层链继承者**（`lib/types/index.d.ts:665-676`）。契约要求措辞为
  "对该 agent 及其继承者生效"，**禁止**写成"对所有 agent 生效"。

### 2.23.2 H2 · 名字预校验（必须，否则整条施加失败）

- 判据：`tools.view(targetAgent).restrictableNames`（`dsh-tools/lib/index.js:2959-2984`）。**只有**落在集合里的名字才允许进 `deny`。
- 过滤规则：`deny = hidePlan.filter(c => c.precheck.restrictable === true).map(c => c.name)`；
  未通过者进 `hideApply.skipped` 并带 `reason`。
- **空清单绝不施加**：`deny.length === 0` 时 `applySupported = false`（对应 `dsh-tools/lib/index.js:2900`：空 filter 会抛错）。
- **`run_code` 永不出现在候选里**（保留传输名：`dsh-tools/lib/index.js:2905`）：它是保留传输名，且它不出现在 `items`（账本只收 `schemas()` 投影的可见工具）；
  契约仍要求实现显式过滤一次，作为防线。
- 名字"已消失"的容错：预校验是在**施加时刻**做的，工具表可能已变化；因此 `deny` 必须在施加前**重新**校验一次
  （不能复用审计时的结果），并把差异记入 `hideApply.skipped`。

### 2.23.3 H3 · 接口存在性检查与优雅降级（三态）

| 情形 | `hidePlanStatus` | 行为 |
|---|---|---|
| 有 `restrict` 且有 agent 作用域 | `prechecked` | 逐项预校验，给出可粘贴清单 |
| 有 `restrict` 但拿不到 agent 作用域（如 HTTP 路由在无活动 agent 的宿主里） | `unvalidated` | 照常列出候选，`precheck.restrictable = null`，**`hideApply.denyList = []`**、`applySupported = false`；面板顶部提示"未校验" |
| 缺 `restrict` / 缺 `view().restrictableNames`（旧宿主） | `unsupported` | 同上且**不得**抛错；候选仍是有效诊断（用户可手工用别的方式处理） |

硬规则：**接口缺失/校验失败绝不抛错、绝不中断账本**（对照 `@nanmicoder/dsh-agent-teams/lib/harness-compat.js:228-235` 记录的已知兼容性问题：
更早的 Harness 世代没有该接口）。实现侧一律 fail-soft，并把实际探测结果写进 `hideApply.interfacePresent`。

### 2.23.4 H4 · 只输出建议，不自动施加（默认永久如此）

- `hideApply.mode` 默认恒为 `"suggestion-only"`；`appliedNames` 恒为 `[]`。
- 唯一例外是**用户显式写入的 opt-in 配置**（本插件自己的 config，默认关闭）：

```yaml
# <profile>/cordis.patch.yml —— 用户侧补丁层（id 定向 config 覆盖）
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
  2. `apply: true` ⇒ 本插件在 `agent/created`（`dsh-agent/lib/index.js:576-584`）里对 **root agent** 的作用域施加 `{ deny }`，
     且**每条名字都重新预校验**（H2）；施加结果写入 `hideApply.appliedNames` / `skipped`，
     `mode` 变为 `"applied-by-config"`。
  3. **不加作用域旋钮**（"root 还是全部 agent"）——语义固定为"root agent 的作用域，其继承者按层链继承"。
     这是 §4.1（O2）教训的直接应用：无设计的旋钮会产出无法解释的降级态。
  4. 施加失败（接口缺失 / 全部名字都不可限制）⇒ 记入 `skipped` 并**静默降级**为 `suggestion-only`，
     不抛错、不重试。
  5. 本插件**不写配置文件**：`deny` 的内容由用户自己从 `hideApply.denyList` 复制粘贴。

### 2.23.5 三种施加载体（并列，各自代价写明）

| 载体 | 适用 | 落地方式 | 持久化 | 代价 |
|---|---|---|---|---|
| **A. 子代理描述符 `toolFilter`** | 子代理作用域 | continuable 子代理描述符（`SUBAGENT_DESCRIPTOR_VERSION = 3`，`dsh-subagent/lib/index.js:1309`）里的 `toolFilter: { deny: [...] }`（DSH 原生字段，`CONTINUABLE_DESCRIPTOR_KEYS` 的白名单成员） | 随描述符持久化 | 仅覆盖该子代理；主 agent 不受影响 |

载体 A 的可粘贴片段（`toolFilter` 是**已有字段**，不是本插件发明的）：

```jsonc
{ "version": 3, "mode": "continuable", "label": "reviewer",
  "toolFilter": { "deny": ["mcp__openviking__add_resource", "task_board_run"] } }
```
| **B. 本插件 opt-in 配置** | root/主 agent 作用域 | `context-ledger.hide.{apply:true, deny:[...]}` + `agent/created` 施加（`dsh-agent/lib/index.js:576-584`；`agent.ctx` 可访问作用域服务） | 用户侧 `<profile>/cordis.patch.yml` | 需重启/重载生效；影响该 agent 及其继承者 |
| **C. 禁用工具提供者的装载入口** | 想连 UI/后台一起停 | profile patch 里 `- id: <entry> / disabled: true` | 同一份 patch 文件 | **最重**：连 UI/后台与在用工具一起停；只在"整个入口都不需要"时使用 |

R6 的**主推是 B + A**；C 作为已知选项如实列出（它不是 deny，代价完全不同，必须分开描述）。

---

### 2.24 R6 恢复路径（v3 新增）

### 2.24.1 解除器语义（机制事实）

- `restrict()` 返回**确切的解除器**（`dsh-tools/lib/index.js:2909`、`lib/types/index.d.ts:642`）；调用它只解除这一次限制（不是"清空所有限制"）。
- 限制本身挂在调用者 ctx 的 effect 层上（`layers.effect(this.ctx, …)`）：**插件卸载 / HMR 重载即自动解除**，
  不需要用户做任何事。
- 限制**不落盘**：它是进程内对象。新起的进程若没有对应配置，就没有任何限制。

### 2.24.2 配置持久化（用户侧）

- 载体 A：`toolFilter` 写在**子代理描述符**里（持久化随描述符）；恢复 = 改回描述符。
- 载体 B：`context-ledger.hide` 写在 `<profile>/cordis.patch.yml`（id 定向 config 覆盖）；恢复 = 改回该段。
- 载体 C：`disabled: true/false` 同一份 patch 文件。
- 本插件**不生成、不修改、不备份**这些配置；只输出可粘贴片段与恢复步骤（只读纪律：本插件不写配置）。

### 2.24.3 「日后需要该工具时如何一键恢复」（诚实版）

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

### 2.25 R6 的取值边界（不做的事）

1. **不做全局限制**：宿主禁止（`dsh-tools/lib/index.js:2895-2897`）。任何"绕过去"的方案（例如用 `guard` 冒充）都要被拒绝——
   `guard` 不减 schema（`dsh-tools/lib/index.js:2626`、`:2647`），拿它当隐藏手段是自欺。
2. **不自动施加、不写配置、不做自动回滚**（只读纪律/§2.23.4）。
3. **不把 deny 说成"仅隐藏"**（注册表级：`dsh-tools/lib/index.js:2995-2996`、`:3011-3016`）。
4. **不评估"功能是否由服务提供"**：静态不可判定，只输出证据与"须人工确认"。
5. **不引入作用域旋钮**（§2.23.4 第 3 点）。
6. **不解析/不修改别人的插件配置**：只读 profile patch 的**存在性**都不做——R6 完全不碰配置读取，
   配置由用户提供（本插件的 config 由宿主注入，不算"读文件"）。
7. **不为 MCP 服务器做跨服务器推断**：MCP 工具的隐藏与服务器进程无关（隐藏的只是 DSH 侧的注册表名字）。

---

## 3. 冻结项 B：隐私边界的具体落地

红线原文（BRIEF）：允许 **工具名 / 调用计数 / 会话数量与时间戳 / 文件字节数与 token 估算**；
禁止 **工具参数 / 工具结果 / 用户消息 / 助手正文 / 文件内容 / 重复段落片段**。
产出物中不得出现任何正文片段。违反即任务失败。

### 3.1 usage 回放的**唯一**提取白名单

回放入口是一个纯函数（`lib/usage.js`，签名见 §7），输入是**已解压的日志行**。对每一行：

| 步骤 | 动作 | 允许读的字段 |
|---|---|---|
| 1 | 判定记录类型 | 行的顶层 `type` |
| 2 | `type !== "tool/call"` → 立即丢弃该行（不取值） | — |
| 3 | `type === "tool/call"` → 取 `data.name` | `data.name` |
| 4 | 护栏校验后计数（§3.3），把 name 加入 `callsByName` 计数 | — |

**除此之外一个字段都不读**。明文禁止读取（实现线必须在代码注释与测试中同时声明）：

```
data.arguments        data.callId         data.turn / data.step
data.message          data.content        data.title / data.text
data.meta             data.error          data.stream / data.usage
session/title* 行的 data.title            user/message 行的 data.content
任何 tool/result 的 message / error / meta
```

其余 `type` 一律当噪声丢弃：`assistant/message`、`user/message`、`tool/result`、
`session/title`、`session/title-llm-request`、`request/header`、`request/context` 等。
`tool/ptc-dispatch` / `tool/ptc-dispatch-start` **不计入**（其父 `tool/call` 已计数，避免重复计数），
其 `data.subCallId`/`data.name` 也不读。

### 3.2 计数口径（冻结）

- 一条 `tool/call` 记录 = 一次调用；不按 `callId` 去重（DSH 不重复发出同一 call 记录）。
- 计数按**工具名**聚合：`callsByName: { [name]: integer }`。
- 账目项的 `calls` = `callsByName[item.name] ?? 0`（仅在 `usageBasis === "tool-calls"` 时成立）。
- `scope.toolCalls` = 通过护栏的全部 `tool/call` 行数（= 已匹配项的 `calls` 之和 + `callsUnmatched` + `namesRejected`）；
  `callsUnmatched` = 名字通过护栏但未匹配任何账目项的调用次数之和。

### 3.3 名字护栏（`NAME_PATTERN`）：把"正文"挡在输出之外的第二道锁

- `NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/`（本机已观测到的名字——`bash`、`read`、`todo_write`、
  `agent_teams_claim_task`、`task_board_get`、`mcp__openviking__find`、`openviking-memory`——全部命中；
  仍以 `scope.namesRejected` 作为兜底信号，不假设"一定是 0"）。
- 回放阶段：不匹配的 `name` **不入 `callsByName`**，只累加 `scope.namesRejected`。
- 账目构造阶段：若某个**常驻项**的 `name` 本身不匹配（理论上不该发生），该项
  `usageBasis = "unobservable"`、`calls = null`、`zeroCall = null`，并累加 `scope.namesRejected`。
  → 这条规则保证**永远不会出现"因为名字被丢掉而误判零调用"**。
- 任意正文/参数片段（含空格、引号、换行、非 ASCII）必然无法通过该护栏，因此即使上游出现 bug，
  片段也无法进入输出。`namesRejected > 0` 是告警信号（面板显示一行提示），不是静默。

### 3.4 "输出中不得出现正文"的自检办法（五项，全部可执行；验证线照此判定）

| # | 自检 | 具体做法 | 通过判据 |
|---|---|---|---|
| S1 | **哨兵不可见** | 构造合成日志：`tool/call` 的 `arguments`、`tool/result` 的 `message`、`user/message` 的 `content`、`session/title` 的 `title` 全部填唯一哨兵 `LEDGER-PRIVACY-SENTINEL-8f3a`（另加中文/emoji 变体）；跑 `usage → reconcile → JSON.stringify(report)` 与 native 渲染 | 两份产物中 `includes("LEDGER-PRIVACY-SENTINEL-8f3a") === false`，且结构等于期望值 |
| S2 | **载荷不变性（差分证明）** | 同一条日志做两份：A 的载荷字段（`arguments`/`message`/`content`/`title`/`meta`/`error`）全填哨兵 S1；B 的同一批字段替换为**不同长度、不同字符集**的随机垃圾 S2 | 归一化 `generatedAt` 后 `JSON.stringify(A) === JSON.stringify(B)`。这机械地证明输出只是白名单字段（`type` + `name` + 计数）的函数 |
| S3 | **全局字符串白名单** | 对整份 report 递归遍历所有字符串值，要求每个都命中：枚举常量（`context_ledger`/`token`/`heuristic-v1`/四种 category/四种 usageBasis/`plugin`/`core`/`mcp-server`/`unknown`/`high`/`low`/四种 method/三种 `noRecommendation.reason`/`model-tool-calls-only`/`plugin`/`mcp-server`）、`NAME_PATTERN`、**v2 新增 `PACKAGE_PATTERN`（包名）**、绝对路径（`/` 起始）、ISO-8601 时间戳、`workspaceKey` 形态（`--…--`）、数字字符串 | 无例外；任一字符串不命中即失败。此检查在真实日志 + 真实归属数据的 E2E 上跑；`id` 的 `<category>:` 前缀规则沿用 F1 裁定（`test/whitelist.js`） |
| S4 | **真实日志 E2E** | 用本机真实会话日志（`~/.dsh/sessions/…/session.v4.jsonl.zstd`，**只读**）跑完整链路，再跑 S3；随后把 S1 的哨兵注入同一日志的载荷字段（写入工作区内的副本，绝不改原日志）后重跑 | ①S3 通过；②注入哨兵前后 report 逐字节相同（除 `generatedAt`）；③`scope.usageAvailable === true` 且 `scope.toolCalls > 0`；④逐项 `findings.zeroCall` 与 `items` 中 `zeroCall === true` 的集合一致（本轮实际有多少零调用项由真实数据决定，**不作为通过前提**） |
| S5 | **溯源哨兵（v2 新增）** | 在工作区内造一个**假插件包**（目录名与 `package.json.name` 用合法包名，源码里含唯一哨兵 `LEDGER-PROVENANCE-SENTINEL-5c71`，并注册一个假工具名），把它放进 profile 候选包集合的替身（测试夹具）后跑完整链路；再跑 S3 | ①输出中 `includes("LEDGER-PROVENANCE-SENTINEL-5c71") === false`；②该假工具 `providedBy.kind === "plugin"` 且 `name` = 假包名；③S3 对新增字符串（包名 / evidenceFile）零违规；④`evidenceFile` 指向**文件路径**且不含该文件任何内容片段 |

对应的验证命令（实现线必须提供这些测试；BRIEF 的完成定义要求 `node --test` 全绿）：

```sh
node --test                       # 含 privacy 测试：S1/S2/S3/S5 单元 + S4 端到端
grep -rn "arguments\|tool/result\|user/message" lib/usage.js   # 仅允许出现在"禁止读取"的注释里
grep -n "readFileSync\|readText" lib/provide.js               # 纯函数模块里不得出现任何读盘调用
```

两条 `grep` 的判据：①`lib/usage.js` 中出现这些词的**每一处**都必须位于声明"禁止读取"的注释或
测试夹具引用中，不得出现在任何取值表达式里；②`lib/provide.js` **不得**自己读盘——读盘只在 `index.js`，
否则"纯函数可测"与"只读可控"两条约束同时被破坏。

### 3.5 输出面清单（哪些字符串**可以**进产物）

允许：工具名、技能名、MCP 全名、指令链文件绝对路径、`cwd`、`workspaceKey`、`sessionsRoot`、
时间戳、枚举常量、数字、单位，以及 **v2 新增**：插件包名（`PACKAGE_PATTERN`）、
MCP server 名、`evidenceFile`（安装侧源码**绝对路径**）。
禁止：任何 schema 描述文本、技能描述文本、指令文件内容、**被扫描插件源码的任何片段或行内容**、
工具参数、工具结果、消息正文、`schemaHash`/内容摘要（**不输出任何内容派生的哈希**，把攻击面降到零）。

### 3.6 R1 溯源扫描的隐私边界（v2 新增，与 §3.1 同源）

R1 需要读"已安装插件的源码"，这与 §3.1 的"会话日志只读工具名"是**两个不同的读取面**，
必须各自交代清楚，不得混为一谈：

| 维度 | 会话日志回放（§3.1） | 溯源扫描（本节的 R1） |
|---|---|---|
| 读什么 | 仅 `type` + `data.name` | profile / 核心包的 `.js/.mjs/.cjs` 源码文本、bundle 的 patch 文本、`package.json` 的 `name`/`dependencies`/`dsh.bundle.patch` |
| 谁的文本 | **用户内容**（因此只允许取工具名） | **第三方/机器生成代码**（npm 包与 DSH 自带包），不是用户内容 |
| 读出的东西怎么用 | 把名字聚合成计数（数字） | 只取**布尔**（该包是否命中该名字）；文本在单次构建内即弃 |
| 进入输出的 | 名字、数字 | 包名、server 名、**单个** `evidenceFile` 路径 |
| 绝不进入输出 | 参数/结果/正文 | **源码片段、命中行、行号、文件内容摘要**、任何内容派生的哈希 |

补充硬规则：
1. **不读用户文件**：溯源只在 `<DSH_PROFILE_DIR>/node_modules`、profile `package.json` 与核心作用域包目录内读，
   不碰 `~/.dsh/sessions/**` 之外的任何用户目录，也不读工作区文件。
2. **不看被扫描包的 README / docs / 测试目录**（`SKIP_DIR_NAMES` 已排除 `docs`/`test`/`tests`/`examples`），
   进一步降低"读到人写的散文"的概率。
3. 命中结果**只以布尔与包名形式**参与输出；`evidenceFile` 是路径，供人自行打开核对——
   这是"把推断标为推断"的落地方式，而不是把源码搬进产物。
4. S5 是这条边界的机械证明：假包源码里放哨兵，输出必须不含哨兵。

---

### 3.7 R6 不新增读取面（v3 新增）

R6 **不新增任何读取面**：
- 归属复用 R1 的扫描结果（已在 §3.6 冻结为"只取布尔 + 包名 + 单个 evidenceFile"）；
- `registryUse.nameReferencedElsewhere` 复用 R1 的**弱命中文件路径**（已是白名单内的绝对路径）；
- 预校验读的是**工具注册表**（名字集合），不读任何文件、不读会话正文。
- S3 白名单需新增：`hidePlanUnits` 的 `kind` 复用 4 值、`inPrunePlan` 是布尔、`hideApply.mode` 两个常量、
  `registryUse` 的两个常量、`precheck.status`/`reason` 的枚举、`hidePlanCaveat` 的常量值。**无新字符串类别**。

---

---

## 4. 冻结项 C：面板信息层级

参照 `/home/u/Desktop/DSHWorkspace/.feas/context-doctor`（BSD-3-Clause，**只参考输出格式与 UI 组织思路，不复制代码**）。
沿用它的**承载方式与信息骨架**：composer 工具行右侧的图标触发器 + 展开浮层 + 顶部预算总览 + 四类分片 + 可展开明细；
**不继承**它已覆盖的内容（重复段落检测、同名技能遮蔽、按严重度排序的裁剪建议、技能正文统计均属它的地盘，本插件不做）。

### 4.1 承载方式（冻结）

| 项 | 结论 |
|---|---|
| 客户端插槽 | `conversation.input.right`（`kind: 'list'`，落座不挤占内置计量条） |
| 落座标识 | `id: "context-ledger"`，`order: 21`（与 context-doctor 的 20 错开） |
| 数据入口 | `GET /api/context-ledger/ledger?session=<id>&sessions=<n>` → `{ ok: boolean, report: <canonical JSON> }`；宿主侧 60s 缓存（v1 既有）；无 `httpServer` 服务时跳过路由注册（headless 下工具仍可用） |
| **`?cwd=` 旋钮：v2 移除（收口 O2）** | **面板与路由只接受 `?session=<id>`**。`?cwd=` 是实现自加的表面、不在任何设计中，且它必然产出**无 agent scope 的降级成本侧**（`ctx.tools.schemas()` 退回全局视图，实测退化为 1 项）——用户无法把这种"混合态"与真实发现区分开，正是本项目禁止的"把推断/降级写成事实"。缺 `session` 或会话无法解析时返回**显式错误** `{ ok: false, error: "session-unresolved" }`（HTTP 4xx），**不得**用降级报告顶替 |
| 刷新 | 打开时拉取 + 手动刷新按钮；失败显示错误态；不在后台轮询 |
| 语言 | 命名空间 `context-ledger`，zh/en 双词典；数字用等宽，正文继承宿主 UI 字体（含 CJK 回退） |
| 主题 | 沿用宿主 CSS 变量（`--dsw-alias-*`），不硬编码配色 |

### 4.2 版面层级（自上而下，冻结 5 段）

1. **标题行**：`Context Ledger` / 副标题「常驻成本 × 实际调用对账」+ 更新时间 + 刷新按钮。
2. **对账总览（3 个数字，主视觉）**：
   - 常驻合计 `totals.residentTokens`
   - 观测调用 `totals.observedCalls`（副行：覆盖 `scope.sessionsScanned` / `scope.sessionsAvailable` 个会话，`windowStart→windowEnd`）
   - 每次使用成本 `totals.observableTokensPerCall`（副行：可观测部分 `totals.observableTokens` token）
3. **对账清单（本插件的核心，唯一新增价值）**：三段排列，各取 `findings`：
   - 「**零调用**」= `findings.zeroCall`：每行 `name` + 分类徽标 + `tokens` + 琥珀色 `0 次` 徽标。
     **标题不得**写成"贵且没用"或任何等同"没用"的说法（v2 修订：调用次数只证明"没被模型调用"）。
   - 「**每次使用最贵**」= `findings.topPerUse`：每行 `name` + 分类徽标 + `tokens` + `calls` + `tokensPerCall`。
   - 「**裁剪候选**」= `findings.prunePlan`（v2 新增，见 §4.7）：每行 = 单元名 + 工具数 + 可省 token +
     同单元在用工具数 + 事实包名；**必须**带固定不确定性声明行。
   - 三段都为空时显示空态文案；**不得**把"清单为空"包装成"健康"之类结论（本插件只报事实，不下判断）。
4. **四类明细**：固定顺序 4 行（`instructions` / `skills` / `tools` / `mcp`），每行 = 分类名 +
   `itemCount` + `tokens` + 占比条（`tokens / totals.residentTokens`）；点开为该类条目行（顺序见 §4.3）：
   - `tools` / `mcp` 行：`name` + `tokens` + `calls` + `tokensPerCall`（零调用项带徽标）+
     **归属徽标**（v2 新增）：插件包名 / `DSH 自带` / `MCP: <server>` / `归属未知`（低置信时带 `?`，见 §4.7）。
   - `instructions` 行：`name`（短标签取路径尾段，完整路径进 `title`）+ `tokens` + 未知标记 + 说明「常驻，无调用信号」。
   - `skills` 行：`name` + `tokens` + 未知标记 + 说明「逐项不可观测（技能名在工具参数中）」；
     分类行额外展示 `mechanismCalls` / `mechanismTokensPerCall`：「9 次技能加载 · 43 token/次」。
5. **页脚**：范围与证据行（`workspaceKey`、`sessionsScanned`、`truncated`、`namesRejected` 告警、
   **`providerScan.capped` 告警（v2）**）+ 隐私声明一行：
   「仅回放工具名与调用次数（不含正文）；归属为安装侧静态推断，非运行时可证」。

### 4.3 排序规则（面板视图；与 §2.7 一致，不另立第二套）

| 视图 | 排序 |
|---|---|
| 对账清单·零调用 | 直接消费 `findings.zeroCall`（已按 tokens 降序） |
| 对账清单·每次使用最贵 | 直接消费 `findings.topPerUse`（已按未取整比值降序） |
| 对账清单·裁剪候选 | 直接消费 `findings.prunePlan`（已按 `reclaimableTokens` 降序）；**不得**按"可信度"重排或过滤，`confidence: "low"` 条目照常出现并带标记 |
| 分类行 | **固定顺序** `instructions → skills → tools → mcp`（分类身份稳定；量级由数字与占比表达） |
| 分类内条目行 | 保持 canonical `items` 相对顺序（rank0 零调用 top → rank1 每次使用最贵 → rank2 不可观测） |
| 明细展开 | 超过 6 行折叠为 `+N more`（与 context-doctor 的 `DETAIL_LIMIT` 同量级，避免浮层过长） |

面板**不得**自行重排 canonical 顺序做"优化"（避免同一数据两处不同读法）；需要新排序时改 DESIGN 版本。

### 4.4 四种状态必须视觉可区分（冻结）

| 状态 | 触发条件 | 视觉 | 文案（zh / en） |
|---|---|---|---|
| **零调用** | `zeroCall === true` | 琥珀/红徽标 + 该行前置 | `0 次` / `never called` |
| **未知（不可观测）** | `calls === null` 且 `usageBasis ∈ {unobservable, always-on}` | 中性灰徽标，**不使用**零调用样式 | `未知` / `n/a` |
| **无证据（降级）** | `calls === null` 且 `usageBasis === "no-evidence"`（即 `scope.usageAvailable === false`） | 面板顶部一条提示条，清单段显示空态 | `未读到会话日志，无法判定调用次数` / `no session-log evidence; call counts unavailable` |
| **归属未知 / 低置信（v2 新增）** | `providedBy.kind === "unknown"` 或 `confidence === "low"` | 归属徽标用中性灰 + 问号；**不使用**确定语气 | `归属未知` / `attribution unknown`；低置信为 `归属（推断）` / `attribution (inferred)` |

硬规则：`calls === null` **绝不**渲染成 `0`，**绝不**计入零调用计数，**绝不**进入 `findings.zeroCall`；
`providedBy.kind === "unknown"` 的项**绝不**出现在可执行候选里（只能进 `noRecommendation`）。

### 4.5 面板文案键（冻结命名空间与键集，zh/en 必须同键）

v1 键集（保持）：
`cl.title` · `cl.subtitle` · `cl.hint` · `cl.residentTotal` · `cl.tokens` · `cl.observedCalls` ·
`cl.tokensPerCall` · `cl.sessionsCovered` · `cl.window` · `cl.zeroCallTitle` · `cl.zeroCallHint` ·
`cl.topPerUseTitle` · `cl.topPerUseHint` · `cl.neverCalled` · `cl.unknown` · `cl.noEvidence` ·
`cl.cat.instructions` · `cl.cat.skills` · `cl.cat.tools` · `cl.cat.mcp` · `cl.alwaysOnNote` ·
`cl.skillsUnknownNote` · `cl.skillLoads` · `cl.expand` · `cl.collapse` · `cl.more` · `cl.refresh` ·
`cl.updated` · `cl.loading` · `cl.error` · `cl.empty` · `cl.privacyNote` · `cl.rejectedWarning`

**v2 新增键（R1/R2 必需；键名冻结，zh/en 同键）**：
`cl.prunePlanTitle` · `cl.prunePlanHint` · `cl.prunePlanCaveat` · `cl.pruneUnitPlugin` ·
`cl.pruneUnitMcpServer` · `cl.pruneToolsCount` · `cl.pruneReclaimableTokens` ·
`cl.pruneUsedTools` · `cl.pruneFactPackages` · `cl.pruneConfidenceLow` · `cl.noRecommendationTitle` ·
`cl.reason.core` · `cl.reason.no-owner-bundle` · `cl.reason.unknown-attribution` ·
`cl.providedBy.plugin` · `cl.providedBy.core` · `cl.providedBy.mcp-server` · `cl.providedBy.unknown` ·
`cl.providedBy.inferred` · `cl.providedBy.evidence` · `cl.providerScanCapped`

产品名词（`token`、`schema`、`MCP`、`Context Ledger`）两种语言都不翻译（沿用 context-doctor 的约定）。
键值文案的**语义约束**见 §4.7（这是契约，不只是命名）。

### 4.6 与 context-doctor 的边界（避免重复造轮子）

| 能力 | context-doctor | 本插件 |
|---|---|---|
| 四类 token 成本 | ✅（本插件复用它已被验证的成本口径与估算器） | ✅（同口径，便于横向比对） |
| 重复段落 / 同名遮蔽 / 技能正文 | ✅ | ❌ 不做 |
| 按严重度的裁剪建议（"该删什么"的确定性结论） | ✅ | ❌ 不做（本插件只给"零调用""每次使用最贵""**候选单元**"三类事实，不替用户下结论） |
| 调用次数回放 | ❌ | ✅ 唯一新增价值 |
| 每次使用成本排序 / 零调用清单 | ❌ | ✅ |
| 工具→插件归属 + 候选单元分组 | ❌ | ✅（v2/R1 新增，且**显式标注为启发式推断**） |
| 面板：成本总览 + 四类分片 + 可展开明细 | ✅ | ✅（同骨架，**内容换成对账件**：多出零调用清单、每次使用成本列、候选单元段与归属徽标） |

### 4.7 R1 面板呈现义务（v2 新增，R2 必须照此实现）

`prunePlan` 一旦上屏，措辞就是产品行为。以下为**硬性呈现义务**：

1. **段标题**必须是候选语气：zh「**零调用候选 · 需人工确认**」/ en `Never-called candidates · needs your call`。
   **禁止**「建议卸载」「可以删掉」「浪费」「无用」等确定性措辞，也禁止用"红色告警"样式暗示危害。
2. **每行必须同时给出**（缺一即不可决策，违反本条即为缺陷）：
   - 单元名（`target`）与单元种类（插件包 / MCP 服务器）；
   - 工具数（`itemCount`）与**代表工具名**（至少行内展示 `items[].name`，完整清单在展开里）；
   - 可省 token（`reclaimableTokens`，文案必须带条件语「若未使用」）；
   - **同单元在用工具数**（`usedToolCount`）——为 0 时也必须显示「该单元无在用工具」，
     不为 0 时显示「另有 N 个工具在用」，让"卸载的代价"可见；
   - `factPackages`（事实包名）——回答"为什么单元名和工具名不是一回事"。
3. **固定不确定性声明**（`cl.prunePlanCaveat`，必须常驻该段底部，不得折叠）：
   zh「这些候选只说明**模型没有调用过**，不代表没用：工具可能由界面、后台流程或极低频但关键的操作使用。
   请确认你也没有使用其功能后再移除。」/ en 对应英文。**不得**把它做成 tooltip 或可点击隐藏。
4. **归属推断必须可辨**：`providedBy.confidence === "low"` 的条目在单元行与明细行都要带「推断」标记；
   `kind === "unknown"` 的项只能出现在 `noRecommendation` 分节（「**无法给出动作**」），
   **不得**混进候选清单，也不得显示成"DSH 自带"。
5. **不得替用户排序成"最该做的"**：候选清单顺序恒为 `reclaimableTokens` 降序（§4.3），
   不允许"按可信度/按危害"二次加工排序。
6. `providerScan.capped === true` 时页脚提示一行「本次归属扫描触达上限，覆盖可能更窄」——
   把启发式的边界也告诉用户，而不是只报好消息。
7. **证据可查**：展开单元或明细时，`providedBy.evidenceFile` 以可点击/可复制的**路径**呈现
   （面板只显示路径文本，不读该文件）；`confidence === "low"` 时必须同时显示
   「推断，可能存在误判」而不是只给一个包名。

---

### 4.8 R6 面板呈现义务（v3 新增，R2/后续轮实现）

1. **段标题**：zh「**可隐藏候选（工具级）· 需人工确认**」/ en `Hide candidates (tool level) · needs your call`；
   禁止"建议隐藏""安全移除""零损失"等措辞。
2. 每行必须给出：`name` + `unit`（单元名/种类）+ `tokens` + `registryUse.verdict` 的**人话解释**
   （"DSH 无法观测非模型的注册表调用"）+ 预校验状态（已校验/未校验/不支持）。
3. `hidePlanCaveat` 五条必须**常驻**该段底部（不得折叠、不得 tooltip）：
   注册表级不可用 / 非模型调用不可观测 / 服务耦合须人工确认 / 须人工确认 / 前缀缓存一次性失效。
4. 与 `prunePlan` 的并列规则见 §2.22；**两个动作的 token 不得相加**。
5. 未校验（`unvalidated` / `unsupported`）时，段内显示"未校验，不要直接照抄清单"的提示条，
   且**不显示**复制按钮。
6. `selfTool === true` 的候选（`context_ledger` 自身）要显示"隐藏后模型将无法再调用本账本"。

---

---

## 5. 交叉一致性（模型侧 / 面板侧共用一份契约）

- 模型 `context_ledger` 与 HTTP 路由**返回同一份 canonical JSON**（同一函数产出），面板不获得额外字段。
- 面板不做二次计算，只做展示映射：`tokens` → 字符串、`tokensPerCall` → 数字、null → `未知`。
- 唯一允许的面板派生量：占比条 = `tokens / totals.residentTokens`（除零保护：`residentTokens === 0` 时不画条）。
- **v2**：面板**不得**重算归属或省额，也**不得**筛选/重排 `prunePlan`；`confidence: "low"`、`kind: "unknown"`、
  `noRecommendation` 三项都必须如实呈现（把不确定性藏起来就是违背契约）。
- 语言：canonical JSON **不含任何展示文案**（没有 `label` 之类字段）。文案全部在面板词典里，
  避免同一份 JSON 因语言不同而"形状漂移"。
- 时间：`generatedAt`/`windowStart`/`windowEnd` 一律 ISO-8601 UTC 字符串；面板按本地时区渲染。
- **v2 提示词的对应关系**：`findings.prunePlanBasis = "model-tool-calls-only"` 是机器可读的"证据边界"声明，
  `renderLedger` 的末行与面板的 `cl.prunePlanCaveat` 是它的人类可读对应物——**三者必须同时存在**，
  不允许只在 JSON 里声明而界面不提。

---

## 6. 明确不做（并说明为什么不做，防止实现线"顺手加上"）

1. **不读工具参数** ⇒ **不做**逐技能调用次数、不做参数级热点分析。
   （备选方案"只取 `skill` 工具的 `name` 参数值"已被**否决**：BRIEF 隐私红线把"工具参数"整体列为禁止，
   不做例外面。技能维度的替代观测是 `scope.skillToolCalls` + `categories.skills.mechanismTokensPerCall`。）
2. **不读工具结果 / 消息 / 标题** ⇒ 不做"调用是否成功""是否被截断"等质量维度。
3. **不吃 `~/.dsh/dsh-usage/usage-ledger.json`**：它只有 provider/model 级 token 与请求数，**没有工具名维度**，
   无法用于对账；且读取它会让数据源变成两处（口径漂移风险）。
4. **不做**跨文件重复段落检测、语义相似度、同名技能遮蔽（context-doctor 地盘）。
5. **不做**技能正文 token 统计（BRIEF 排除；且需要读正文，与最小读取原则冲突）。
6. **不做**跨会话趋势图表（BRIEF 排除）。
7. **不写任何文件**：不落地缓存、不写报告文件、不改 `~/.dsh/**`；HTTP 缓存只在内存。
8. **不发布** npm、不推送 GitHub（BRIEF 授权边界）。
9. **v2 补充（R1 边界，详见 §2.17）**：不解析 cordis patch 的 YAML 结构、不做运行时 hook、
   不扫 `node_modules` 之外的安装形态、不跨 profile 汇总、不给 `context_ledger` 加开关参数。
10. **v2 补充（措辞红线）**：**任何**输出面（工具 JSON、native 渲染、面板、README）**不得**把
    "从未被模型调用"表述为"没用 / 浪费 / 建议卸载 / 可以删除"；归因**不得**表述为运行时事实。
    违反本条等同于"把未知伪装成已知"，按项目原则计为缺陷。
11. **v3 补充（R6 措辞红线）**：**任何**输出面（工具 JSON、native 渲染、面板、README）**不得**出现：
    "安全隐藏 / 零功能损失 / 无副作用 / 放心删 / 只影响模型"等**把不可判定写成结论**的表述；
    **不得**把 `hidePlan` 的 token 与 `prunePlan` 的 token 相加作为"总可省"；
    **不得**在 `verdict !== "unconfirmed"` 之外给 `registryUse` 赋值（枚举只留语义占位）。
    违反即为缺陷（与 §6 第 10 条同源：把未知伪装成已知）。

---

## 7. 模块接口契约（两条实现线照此施工；只给签名，不含实现）

| 模块 | 导出（签名） | 约束 |
|---|---|---|
| `lib/tokens.js` | `estimateTokens(text: string): number`、`formatTokens(n: number): string`、**`formatBytes(n: number): string`** | 纯函数；无宿主依赖。**v2 订正 F3**：`formatBytes` 返回**字符串**（如 `"1.2 KB"`），v1 写成的 `number` 是笔误 |
| `lib/cost.js` | `instructionItems(files, root): LedgerItem[]`、`skillItems(skillList): LedgerItem[]`、`toolItems(schemas): LedgerItem[]` | 纯函数；入参为**数据**（不碰宿主、不碰 fs）；产出 §2.4 的**成本侧**字段 |
| `lib/usage.js` | `countToolCalls(lines: Iterable<string>, limit: number): UsageResult`，其中 `UsageResult = { callsByName, linesRead, toolCalls, skillToolCalls, namesRejected, truncated }` | 纯函数；输入为**已解压的行**；越界由调用方夹取；只读 `type` + `data.name`（§3.1） |
| **`lib/provide.js`（v2 新增）** | `scanCorpus(corpus, names): ScanResult`、`attributeNames(names, hits, bundles): ProvidedByByName`、`buildPrunePlan(items, providedByByName, bundleOwners): { prunePlan, prunePlanReclaimableTokens, noRecommendation }`；`ScanResult = { strongHits, weakHits, files, bytes, capped }` | **纯函数**：入参为**已读文本**（`corpus: { [pkg]: Array<{path, text}> }`、bundle patch 文本、profile manifest 数据），**绝不自己读盘**（§3.4 的 grep 判据）；实现 §2.13/§2.14/§2.15/§2.16 全部规则 |
| `lib/reconcile.js` | `reconcile(input: ReconcileInput): LedgerReport`（§2.1 全量对象）、`renderLedger(report): string`（§2.11） | 纯函数；**核心价值所在**；负责 §2.7 排序、§2.6 恒等式、`findings` 截断、§2.13/§2.15 的注入与 §2.16 恒等式，并写入 `version: 3` |
| `index.js` | 宿主胶水：注册 `context_ledger`、HTTP 路由、`zstd -dc` 子进程读取、`DSH_HOME`/`DSH_PROFILE_DIR` 解析、会话目录发现（`projectKey` 纯函数实现）、**v2 新增**：读 profile manifest 与 bundle patch、遍历两个扫描根、把文本交给 `lib/provide.js` | 唯一允许 import `@deepseek-ai/*` **与唯一允许读盘**的文件；`lib/**` 不得 import 宿主包（否则 `node --test` 跑不起来） |
| `client.js` | 浏览器半区：插槽落座 + 浮层（§4）；v2 增加候选单元段与归属徽标（R2） | 不得反向依赖 `lib/usage.js` 的日志逻辑；不得自行重算归属或省额 |

### 7.1 `ReconcileInput`（v2 收敛为单一通道，收口 F2/O3）

```
ReconcileInput = {
  cwd: string,
  sessionsRoot: string,
  scope: Omit<scope, "usageAvailable">,          // 观测范围与计数器（由宿主回放算出）
  callsByName: Record<string, number>,           // ★ 唯一的调用次数输入通道
  provenance?: {                                 // ★ 唯一的归属输入通道；缺省 = 全部 unknown
    byName: Record<string, ProvidedBy>,          //   键 = 工具名 / MCP 名
    bundleOwners: Record<string, { owner: string | null, removable: boolean }>   // 事实包名 → 卸载单元
  },
  items: LedgerItem[],                           // 成本侧字段（cost.js 产出）
  findingsLimit?: number
}
```

**收敛规则（冻结，F2 的结论）**：
1. **唯一通道**：调用次数**只能**通过顶层 `callsByName` 传入。v1 实现里额外容忍的
   `scope.callsByName`、`item.observedCalls`、`item.calls` **一律不再接受**——
   `reconcile` 必须**忽略并覆盖** `items[].calls` / `items[].observedCalls`（不得让它们参与任何计算）。
   理由（队长裁定 F2）：容忍多通道会让工具入口与 HTTP 路由各走一条路而不自知，行为分歧极难定位。
2. **单一生产者**：工具入口与 HTTP 路由**必须**共用同一个 `gatherLedger` 式函数，
   由 `lib/usage.js` 的 `countToolCalls` 产出 `callsByName`，不允许任何第二条生产路径。
3. **缺省语义**：`callsByName` 缺省 = `{}`；`provenance` 缺省 = 全部 `unknown`（`method: "not-found"`），
   即"没有归属信息"时**不猜**。
4. **O3 的定论（矛盾输入）**：`scope.sessionsScanned === 0` 且 `callsByName` 非空**不可能**由宿主通路产生
   （`gatherLedger` 只把成功回放的会话计入计数）。若被直接构造出来：`usageAvailable` 仍由
   `sessionsScanned` 决定（false）⇒ 全部 `tools`/`mcp` 项为 `no-evidence`、`findings.zeroCall === []`、
   `prunePlan === []`；`reconcile` **不得**重写宿主传入的 `scope` 计数器（保持"输入即事实"）。
   **安全性质**：该状态下不可能产生假零调用或假候选。

### 7.2 责任边界（唯一赋权点）

| 字段 | 唯一赋值方 | 说明 |
|---|---|---|
| `tokens` / `bytes` / `source` / `provider` / `server` / `loadOrder` | `lib/cost.js` | 成本侧（来自声明面与文件） |
| `calls` / `tokensPerCall` / `zeroCall` / `usageBasis` | `lib/reconcile.js` | 次数语义（**唯一**），输入只有 `callsByName` |
| `providedBy`（全部子字段） | `lib/provide.js` 计算 → `lib/reconcile.js` 注入 | 归属语义（**唯一**）；`reconcile` 只做注入与缺省填充，不自行判断归属 |
| `findings.prunePlan` / `prunePlanReclaimableTokens` / `noRecommendation` | `lib/provide.js` 计算 → `lib/reconcile.js` 注入 | 省额与分组（**唯一**）；面板不得重算 |

---

## 8. 修订记录

| 版本 | 日期 | 变更 | 触发 |
|---|---|---|---|
| v1 | 2026-10-07 | 首次冻结：数据模型（§2）、隐私落地（§3）、面板层级（§4） | 任务 t1 |
| v2 | 2026-10-07 | **R1 新能力 + v1 遗留收口**（见下方清单）；canonical `version` 1 → 2 | **R1**（任务 t5） |
| v3 | 2026-10-07 | R6 工具级隐藏建议：`findings.hidePlan`/`hidePlanUnits`/`hideApply`/`hidePlanCaveat`（§2.18–§2.25）、`registryUse` 逐候选判定、作用域模型（**宿主禁止全局限制**，见 §2.23.1）、恢复路径（§2.24）；`version` 2 → 3 | **R6**（任务 t13） |

### v2 变更清单（可追溯逐条）

**A. R1 新增（新能力：工具→插件溯源 + 可执行候选清单）**

| # | 变更 | 位置 |
|---|---|---|
| A1 | `items[].providedBy`（`tools`/`mcp` 必需）：4 值取值域 `plugin`/`core`/`mcp-server`/`unknown` + `name`/`confidence`/`method`/`evidenceFile`/`candidates`；**推断性质、置信度语义、7 行判定表**冻结 | §2.4、§2.13 |
| A2 | `scope.providerScan`：`{ packages, files, bytes, capped }`——扫描足迹与防御性上限状态 | §2.2 |
| A3 | `findings.prunePlan`（`PruneEntry[]`）+ `prunePlanReclaimableTokens` + `prunePlanBasis` + `noRecommendation`（固定 3 条） | §2.5、§2.15、§2.16 |
| A4 | 溯源方法与实测：两扫描根、强/弱两级匹配、单趟算法、**不引入缓存**（实测 147 ms / 387 包 / 1593 文件 / 47.1 MB）、3 项防御性上限、实测覆盖 74/76 与已知盲区 | §2.14 |
| A5 | 动作单元解析（profile bundle patch 归属）+ 省额口径三条 + 6 条自洽恒等式 | §2.16 |
| A6 | 隐私第三面：溯源扫描的读取面与输出面清单（**禁止输出源码片段/行号/内容摘要**）+ 自检 S5（溯源哨兵） | §3.4、§3.5、§3.6 |
| A7 | 面板呈现义务：候选语气、每行必给 5 项、固定不确定性声明、归属推断可辨、`noRecommendation` 分节 | §4.2、§4.4、§4.5、§4.7 |
| A8 | 新模块 `lib/provide.js`（纯函数、不读盘）+ `ReconcileInput.provenance` 通道 + 责任边界表 | §7、§7.1、§7.2 |

**B. v1 遗留收口（对应 IMPLEMENTATION-NOTES 的 F/O 项）**

| # | 项 | v2 结论 | 位置 |
|---|---|---|---|
| B1 | **F2 / O3**：`ReconcileInput` 缺次数通道、实现容忍多通道 | 收敛为**唯一通道** `callsByName`；`scope.callsByName`/`item.calls`/`item.observedCalls` **不再接受且必须被覆盖**；工具入口与路由共用单一生产者；O3 的矛盾输入定论（不可达 + 安全性质）写明 | §7.1 |
| B2 | **O4**：同类部分可观测时整类 `calls` 变 null | 确认为**设计如此**的唯一读法：有一个未知项即整类 null，不得给部分和；未来要部分信息须新增独立状态（R4），不得放宽 null | §2.3 |
| B3 | **O1**：`renderLedger` 与 §2.11"逐字节相同"的表述不准确 | §2.11 明确标注为**节选**，契约为"逐行符合模板 + 清单按上限完整渲染 + 每单元一行" | §2.11 |
| B4 | **O2**：实现自加的 `?cwd=` 旋钮 | **移除**：只接受 `?session=`；无法解析则返回显式错误 `{ ok:false, error:"session-unresolved" }`，不得用降级报告顶替 | §4.1 |
| B5 | **F3 / O5**：`formatBytes` 返回类型写成 `number` | 订正为 **`string`**（笔误） | §7 |

**C. 与 t5 验收文本的差异（1 处，已获队长 2026-10-07 实测指令确认）**

t5 验收写的是"取值域：插件包名 / core / 未知"（3 值）。队长随后实测：当前会话 80 个工具中
**16 个是 MCP 工具**，其名字不以字面量出现在任何插件源码里（扫描天然扫不到），但插件已按
`mcp__<server>__<tool>` 约定解析出 server。若硬并入 `unknown`，就等于把**已知的归属**说成"查不到"，
与"绝不把已知伪装成未知"同源。故 v2 采用 **4 值取值域**（增 `mcp-server`），并在 §2.13 给出硬规则
（`mcp-server` 不得并进 `unknown`/`core`）。其余验收条目（`providedBy` 的置信度表达、
`prunePlan` 形状/排序/省额口径、完整示例自洽、文件归属矩阵、决策信封、5 项 v1 收口）**全部照做**。

### v2 的下游影响（实现线须知）

| 影响面 | 必须做什么 |
|---|---|
| canonical 形状 | `LEDGER_VERSION` 1 → 2；`test/reconcile.test.js:123` 的 `version === 1` 断言需同步（**实现线**） |
| 输出 schema | 补 `providedBy` / `providerScan` / `prunePlan` 系列字段（`additionalProperties: false` 下漏一个就自相矛盾） |
| 面板 fixtures | `test/client-panel.test.mjs:242` 的 `canonicalReport()` 是 §2.9 的逐字段副本（当前 `version: 1`），应随 v2 形状同步（**面板线，R2 轮**）。实测 `client.js` 完全不读 `version`（`grep -c version client.js` = 0），故**不阻塞 R1 交付** |
| 新增读盘 | `index.js` 需读 profile manifest + bundle patch + 两个扫描根（**宿主线**），`lib/provide.js` 只收文本 |
| 移除旋钮 | `index.js` 路由去掉 `?cwd=` 分支并返回显式错误；相关测试同步（**宿主线**） |
| 白名单 | `test/whitelist.js` 需补 `PACKAGE_PATTERN`、4 个 `kind`、2 个 `prunePlan.kind`、3 个 `reason`、4 个 `method`、`high`/`low`、`model-tool-calls-only`（**宿主线**） |

---

## 9. 文件归属矩阵（v2 新增；消除并行写冲突）

**背景（真实事故）**：v1 期间 `package.json` 差点被"宿主实现线"与"面板实现线"同时写
（两条线都认为自己需要加依赖/字段）。v1 缺本节，靠队长临场拦下。本节的目的是让"哪个文件归谁写"
在**开工前**就无歧义。

**规则（三条，优先级从高到低）**：
1. **一个文件在同一轮内只允许一条线写**。跨线需求 → 报队长，由队长改或由队长授权单一线路代改。
2. 表中"归属"是指**该文件的修改权**；其他线**可以读**任何文件（只读不受限）。
3. 冻结文件（DESIGN.md）的修改必须走 §8 的版本追加流程；**任何线不得就地改冻结字段名**。

| 文件 | 归属线 | R1（v2）本轮是否触碰 | 备注 |
|---|---|---|---|
| `DESIGN.md` | **设计线**（t5 本任务） | ✅ 本轮唯一被写文件 | 冻结契约；版本变更走 §8 |
| `index.js` | **宿主实现线** | ✅ 需改（读 profile/patch、两扫描根、`providedBy` 注入、路由去掉 `?cwd=`、`version: 2`） | 唯一的读盘者与唯一的宿主依赖引入点 |
| `lib/tokens.js` | 宿主实现线 | ⬜ 不改（`formatBytes` 代码本就返回字符串，只是设计笔误） | |
| `lib/cost.js` | 宿主实现线 | ⬜ 不改（成本侧字段不变） | |
| `lib/usage.js` | 宿主实现线 | ⬜ 不改 | 隐私白名单（§3.1）保持 |
| `lib/reconcile.js` | 宿主实现线 | ✅ 需改（`version: 2`、`providedBy` 注入、`prunePlan`/`noRecommendation` 注入、收敛输入通道） | |
| `lib/provide.js` | 宿主实现线 | ✅ **新建** | 纯函数；不得读盘（§3.4 grep 判据） |
| `client.js` | **面板实现线** | ⬜ 本轮不改（R1 只冻结数据；呈现改动属 **R2**） | 面板呈现义务见 §4.7 |
| `test/cost.test.js`、`test/tokens.test.js`、`test/usage.test.js`、`test/reconcile.test.js`、`test/privacy.test.js`、`test/e2e.test.js`、`test/host.test.js`、`test/whitelist.js` | 宿主实现线 | ✅ 需改（`version` 断言、白名单扩充、`provide` 单测、S5 用例） | |
| `test/client-panel.test.mjs` | 面板实现线 | ⬜ 本轮不改（其 `canonicalReport()` 是 §2.9 的副本，`version` 由 1 升 2 **随 R2 轮**更新；面板不读 `version`，故不阻塞 R1） | 与 `client.js` 同线 |
| `package.json` | **队长** | ⬜ 不改 | **v1 差点被两线并写**：任何线需要改它（依赖/字段/scripts）一律报队长 |
| `cordis.patch.yml` | **队长** | ⬜ 不改 | 装载配置，改动影响隔离验证 |
| `README.md` | 队长（文档随队长裁定） | ⬜ 不改（R2/发布轮再动） | 若需写"候选"措辞，按 §4.7 与 §6 第 10 条 |
| `BACKLOG.md` | 队长 | ⬜ 不改 | 轮次目标与评分由队长维护 |
| `IMPLEMENTATION-NOTES.md` | 实现线（**append-only**） | ✅ 允许追加（记录实现期澄清） | 不得改写队长既有裁定；新条目按 F/O 编号续写 |
| `VERIFY-*.md` | **验证线** | ⬜ 不改 | 验证报告独立成文；发现的问题写进自己的报告 + 报队长 |
| `.gitignore`、`.git/**` | 队长 | ⬜ 不改 | 提交与仓库操作由队长执行 |

### 9.1 R6（v3）轮的文件归属（追加表；§9 主表保持不变）

> 主表第三列是 **R1（v2）轮**语义，按"只追加、不重排"原则不修改；R6 轮的触碰状态按下表执行。

| 文件 | 归属线 | R6（v3）是否触碰 | 备注 |
|---|---|---|---|
| `lib/hide.js`（建议新增） | 宿主实现线 | ✅ 新建（纯函数：从 items + precheck 生成 `hidePlan`/`hidePlanUnits`/`hideApply`；不读盘） | 与 `lib/provide.js` 同规格 |
| `index.js` | 宿主实现线 | ✅（`restrictableNames` 预校验、`agent/created` opt-in 施加、schema 扩展、`version: 3`） | 唯一读盘者与唯一宿主依赖点 |
| `lib/reconcile.js` | 宿主实现线 | ✅（注入 R6 的 findings 七键） | |
| `client.js` | 面板实现线 | ✅（§4.8 的段与并列呈现） | 与 `test/client-panel.test.mjs` 同线 |
| `<profile>/cordis.patch.yml`、子代理描述符 | **用户**（不在仓库内） | ⬜ 本插件只输出片段 | 明确不归任何实现线；本插件不写配置（§2.23.4） |

**R1 分解到线的建议（供队长排任务；不是本设计的强制切分）**：
宿主线一个任务（`lib/provide.js` + `index.js` + 宿主侧测试与白名单）为最小可验证单元；
R2 面板任务在宿主线通过验证后再开，避免面板对着未定型的 JSON 施工。

---

## 10. 决策信封（v2 新增；实现线可自主 vs 必须上报）

**目的**：避免两类损失——① 遇到明显笔误就停下来问（拖慢交付）；② 遇到契约缝隙就自行扩张（污染契约）。
本节给出边界，**实现线不需要再回问队长**即可判断。

### 10.1 可自主决定（做了即可，只需在 `IMPLEMENTATION-NOTES.md` 追加一条记录）

| # | 类型 | 例子（本项目的真实情形） |
|---|---|---|
| D1 | **笔误级/描述性错误**：按语义实现 | F3 的 `formatBytes(n): number` → 实现返回字符串；§2.11 曾写"逐字节相同"而实际是节选 |
| D2 | **私有实现细节**：函数内部命名、拆分、正则的具体写法（只要语义等价且可测） | 强/弱匹配正则可以写成 `exec`/`test` 任一形式；命中集合用 `Map` 还是对象 |
| D3 | **确定性的边界处理**：未冻结但必须选一个的机械细节 | `evidenceFile` 取字典序最小命中文件；候选列表 `sort()` 的稳定性兜底 |
| D4 | **测试组织**：测试文件名、用例分组、夹具构造方式（须在 `test/**` 内） | 新增 `provide.test.js` 还是并入 `reconcile.test.js` |
| D5 | **性能与健壮性实现**：不违反"不新增缓存层"与 §2.14 防御性上限的写法 | 单趟里先弱后强、先按长度过滤文件 |
| D6 | **措辞的非契约部分**：未被 §4.7 与 §6 第 10 条 指定的文案细节 | 提示语的具体字数、折叠阈值（§4.3 给的 6 行可自行取 5–8） |

D1–D6 的共同前提：**不得**触碰 §10.2 的任何一项，且**不得**改变任何冻结字段名/取值域/排序/恒等式。

### 10.2 必须上报队长（先报告、后动手；未经裁定不得合入）

| # | 类型 | 触发信号（出现即上报） |
|---|---|---|
| E1 | **冻结字段名 / 取值域 / 排序 / 恒等式**要改 | 需要重命名字段、增删枚举值、改 comparator、改 `totals` 恒等式 |
| E2 | **隐私边界**要动 | 需要读日志的新字段（除 `type`/`data.name`）、需要放宽 `NAME_PATTERN`、需要输出新的字符串类别（如源码片段、行号、任何哈希） |
| E3 | **范围红线** | BRIEF"不做"清单、§6、§2.17 里的任何一项 |
| E4 | **acceptance 本身有错或不可达** | 按本轮 t5 的实践：**明确指出并说明理由**，不迁就着做（见 §8 的 C 节：3 值 vs 4 值取值域） |
| E5 | **跨文件/跨线接口变更** | 需要改 `ReconcileInput`、`ProvidedBy`、`PruneEntry` 形状，或需要动别人的文件（§9 规则 1） |
| E6 | **需要越权路径** | 要写 `~/.dsh/**`、DSH 安装目录、`package.json`、`cordis.patch.yml` |
| E7 | **实质新增读盘面** | 想读 profile/核心包之外的目录（例如 `~/.dsh/storages/**`）以补齐信息 |
| E8 | **无法判定"可自主"还是"须上报"** | 默认**上报**（保守优先）；不要用"先做了再说"的方式试探边界 |

### 10.3 验证线对应的口径

- 验证线只按 **DESIGN（当前版本）+ IMPLEMENTATION-NOTES 的队长裁定** 判定，不自行另立标准；
  发现二者冲突时**以 DESIGN 为准并上报**（说明冲突点）。
- 验证线发现 `providedBy`/`prunePlan` 的**假归属、重复计入、无条件措辞**三类问题，
  按缺陷处理（它们直接对应本项目的"绝不把未知/推断写成已知"原则）。
- 验证线**不得**为了通过而修改产品代码或 DESIGN；证据与结论写进 `VERIFY-*.md` 并报队长。
