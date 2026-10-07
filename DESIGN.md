# dsh-context-ledger DESIGN — 数据契约 · 隐私边界 · 面板层级（v1，已冻结）

> 状态：**FROZEN v1**（2026-10-07，任务 t1）
> 读者：实现线（宿主半区 / 客户端面板）、验证线、队长。
> 约束来源：[BRIEF.md](./BRIEF.md)（范围红线、隐私红线、环境事实、授权边界）。
> 变更控制：本文件冻结的**字段名、语义、排序规则、常量**不得由实现线自行改名或"顺手优化"。
> 需要变更时，必须另开任务并在此文件 `## 8. 修订记录` 追加一条（v2 起），实现线照新版本施工。

本文只冻结契约，不含实现代码。三件事各有唯一结论，不留"两种都行"。

---

## 0. 一句话结论

`context_ledger` 输出一份 canonical JSON 账本：**每个常驻注入物一行**，携带
`tokens`（常驻成本）· `calls`（观测调用次数）· `tokensPerCall`（每次使用成本）· `zeroCall`（是否零调用）
四要素；排序把"零调用"顶到最前，其次是"每次使用最贵"。
调用次数**只能**来自会话日志回放中 `type == "tool/call"` 的 `data.name`（工具名）——仅此一项，
其余字段一律不读。技能目录逐项与指令链链无调用信号，一律记为 `null`（不可观测），
**绝不记为 0**；零调用必须由证据支撑（见 §2.4、§3.4）。

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
| `version` | integer | 常量 `1` | canonical 形状版本；本文件冻结 v1 |
| `generatedAt` | string | ISO-8601 UTC（`2026-10-07T02:41:07.512Z`） | 生成时刻 |
| `unit` | string | 常量 `"token"` | 所有 token 数值的单位；便于模型理解量纲 |
| `estimator` | string | 常量 `"heuristic-v1"` | token 估算器标识：`ceil(ascii/4 + nonAscii/1.5)`；仅用于相对比较与排序 |
| `cwd` | string | 绝对路径 | 本次对账的会话工作目录 |
| `scope` | object | 见 §2.2 | 观测范围与证据充分性 |
| `categories` | array | 长度恒为 4，顺序固定 | 四类注入物的汇总（§2.3） |
| `items` | array | 见 §2.4 | 逐项账目，按 §2.7 排序 |
| `findings` | object | 见 §2.5 | 面板与模型直接消费的两个结论清单 |
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

### 2.5 `findings`（两个结论清单，直接供面板与模型消费）

| 字段 | 上限 | 排序 | 记录字段（字段名与 `items` 完全一致，不得改名） |
|---|---|---|---|
| `zeroCall` | 10 | `tokens` 降序 → `id` 升序 | `{ id, category, name, tokens }` |
| `topPerUse` | 10 | 未取整比值 `tokens/calls` 降序 → `tokens` 降序 → `id` 升序；仅 `calls > 0` | `{ id, category, name, tokens, calls, tokensPerCall }` |

`findings.zeroCall` **只**含 `zeroCall === true` 的项；`calls === null` 的项永远不进这两个清单中的 `zeroCall`。
当 `scope.usageAvailable === false` 时，`findings.zeroCall` 恒为 `[]`。

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
| `CACHE_TTL_MS` | 60000 | 宿主 HTTP 路由结果缓存 |
| `ESTIMATOR` | `"heuristic-v1"` = `ceil(ascii/4 + nonAscii/1.5)` | 与 context-doctor 同口径，便于横向比对 |

### 2.9 完整示例 JSON（**合成数据**，用于展示形状与取值约束；非本机实测值）

```jsonc
{
  "tool": "context_ledger",
  "version": 1,
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
    "truncated": false
  },
  "categories": [
    { "key": "instructions", "itemCount": 1, "tokens": 812, "calls": null, "tokensPerCall": null,
      "observableUsage": false, "mechanismCalls": null, "mechanismTokensPerCall": null },
    { "key": "skills", "itemCount": 4, "tokens": 386, "calls": null, "tokensPerCall": null,
      "observableUsage": false, "mechanismCalls": 9, "mechanismTokensPerCall": 43 },
    { "key": "tools", "itemCount": 5, "tokens": 1341, "calls": 129, "tokensPerCall": 10,
      "observableUsage": true, "mechanismCalls": null, "mechanismTokensPerCall": null },
    { "key": "mcp", "itemCount": 3, "tokens": 1149, "calls": 8, "tokensPerCall": 144,
      "observableUsage": true, "mechanismCalls": null, "mechanismTokensPerCall": null }
  ],
  "items": [
    { "id": "mcp:mcp__openviking__add_resource", "category": "mcp", "name": "mcp__openviking__add_resource",
      "tokens": 402, "calls": 0, "tokensPerCall": null, "zeroCall": true, "usageBasis": "tool-calls",
      "source": "mcp", "server": "openviking", "bytes": 1609 },
    { "id": "mcp:mcp__openviking__forget", "category": "mcp", "name": "mcp__openviking__forget", "tokens": 341,
      "calls": 0, "tokensPerCall": null, "zeroCall": true, "usageBasis": "tool-calls",
      "source": "mcp", "server": "openviking", "bytes": 1364 },
    { "id": "tools:task_board_list", "category": "tools", "name": "task_board_list", "tokens": 292,
      "calls": 0, "tokensPerCall": null, "zeroCall": true, "usageBasis": "tool-calls",
      "source": "native", "bytes": 1168 },

    { "id": "tools:context_ledger", "category": "tools", "name": "context_ledger", "tokens": 214,
      "calls": 3, "tokensPerCall": 71, "zeroCall": false, "usageBasis": "tool-calls",
      "source": "native", "bytes": 856 },
    { "id": "tools:agent_teams_claim_task", "category": "tools", "name": "agent_teams_claim_task", "tokens": 268,
      "calls": 4, "tokensPerCall": 67, "zeroCall": false, "usageBasis": "tool-calls",
      "source": "native", "bytes": 1072 },
    { "id": "mcp:mcp__openviking__find", "category": "mcp", "name": "mcp__openviking__find", "tokens": 406,
      "calls": 8, "tokensPerCall": 51, "zeroCall": false, "usageBasis": "tool-calls",
      "source": "mcp", "server": "openviking", "bytes": 1624 },
    { "id": "tools:read", "category": "tools", "name": "read", "tokens": 186, "calls": 4,
      "tokensPerCall": 47, "zeroCall": false, "usageBasis": "tool-calls", "source": "native", "bytes": 744 },
    { "id": "tools:bash", "category": "tools", "name": "bash", "tokens": 381, "calls": 118,
      "tokensPerCall": 3, "zeroCall": false, "usageBasis": "tool-calls", "source": "native", "bytes": 1524 },

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
      { "id": "mcp:mcp__openviking__forget", "category": "mcp", "name": "mcp__openviking__forget",
        "tokens": 341 },
      { "id": "tools:task_board_list", "category": "tools", "name": "task_board_list", "tokens": 292 }
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
    ]
  },
  "totals": {
    "residentTokens": 3688,
    "observableTokens": 2490,
    "unknownUsageTokens": 1198,
    "observedCalls": 137,
    "observableTokensPerCall": 18,
    "zeroCallItems": 3,
    "zeroCallTokens": 1035,
    "unknownUsageItems": 5
  }
}
```

示例自洽校验（验证线可直接照抄为断言）：

| 断言 | 值 |
|---|---|
| `residentTokens = observableTokens + unknownUsageTokens` | `3688 = 2490 + 1198` |
| `observableTokens = categories.tools.tokens + categories.mcp.tokens` | `2490 = 1341 + 1149` |
| `unknownUsageTokens = categories.instructions.tokens + categories.skills.tokens` | `1198 = 812 + 386` |
| `observedCalls = categories.tools.calls + categories.mcp.calls` | `137 = 129 + 8` |
| `scope.toolCalls = Σ items[].calls(非空) + callsUnmatched + namesRejected` | `141 = 137 + 4 + 0` |
| `observableTokensPerCall = round(observableTokens / observedCalls)` | `18 = round(2490 / 137)` |
| `zeroCallTokens` | `1035 = 402 + 341 + 292` |
| `items.length = Σ categories[].itemCount` | `13 = 1 + 4 + 5 + 3` |
| `unknownUsageItems` = 项数（`calls === null`） | `5`（1 instructions + 4 skills） |
| `categories.tools.tokensPerCall = round(1341 / 129)` | `10` |
| `categories.mcp.tokensPerCall = round(1149 / 8)` | `144` |
| `categories.skills.mechanismTokensPerCall = round(386 / 9)` | `43` |
| `items` 顺序 | 严格符合 §2.7：rank0（402 → 341 → 292）→ rank1（比值 71.33 → 67 → 50.75 → 46.5 → 3.23）→ rank2（812 → 128 → 96 → 88 → 74） |
| `findings.zeroCall` / `topPerUse` 顺序 | 分别符合 §2.5 的 tokens 降序 / 未取整比值降序 |

### 2.10 工具签名（模型半区，冻结）

```
name: "context_ledger"
parameters: { sessions?: integer }        // 1..200，缺省 20；越界夹取
output.schema: 对象，字段 = §2.1 全部必需字段，additionalProperties: false
```

`description`（**英文**，模型可读；冻结文本，实现线不得随意改写）：

> Reconcile the resident cost of every injected context item against how often it is actually
> called in this workspace's session logs. Reports, per item: token cost, call count,
> cost-per-use (tokens ÷ calls) and whether it was never called. Read-only: it never writes a
> file, never reads message content, and extracts only tool names and counts from session logs.

### 2.11 native 渲染（文本块，冻结格式）

单行摘要 + 分节；**只允许出现名字、数字、单位与固定枚举文案**：

```text
Context ledger: 3688 tokens resident / 137 observed calls across 20 sessions / 18 tokens per use
Never called (cost without use): 3 items, 1035 tokens
  - mcp__openviking__add_resource [mcp]  402 tokens  0 calls
  - mcp__openviking__forget [mcp]  341 tokens  0 calls
  - task_board_list [tools]  292 tokens  0 calls
Most expensive per use:
  - context_ledger [tools]  214 tokens  3 calls  -> 71 tokens/call
  - agent_teams_claim_task [tools]  268 tokens  4 calls  -> 67 tokens/call
Not observable: instructions 812 tokens (always-on) / skills 386 tokens (per-skill unknown; 9 skill loads, 43 tokens/load)
```

### 2.12 降级态示例：日志不可读（`usageAvailable === false`）

当 `<sessionsRoot>/<workspaceKey>/` 不存在、或全部日志解压失败时，**不得**把 `tools`/`mcp` 报成零调用。
此时相对 §2.9 的差异（冻结，其他字段不变；下面**只列受影响的字段与代表条目**——
实际的 `categories` 恒为 4 条、`items` 为全量 `tools`+`mcp` 项，`instructions`/`skills` 项不变）：

```jsonc
{
"scope": { "sessionsAvailable": 0, "sessionsScanned": 0, "sessionsUnreadable": 0, "linesRead": 0,
           "toolCalls": 0, "skillToolCalls": 0, "callsUnmatched": 0, "callsUnmatchedNames": [],
           "namesRejected": 0, "usageAvailable": false, "truncated": false, "windowStart": null, "windowEnd": null },
"categories": [
  { "key": "tools", "itemCount": 5, "tokens": 1341, "calls": null, "tokensPerCall": null,
    "observableUsage": true, "mechanismCalls": null, "mechanismTokensPerCall": null }
],
"items": [
  { "id": "tools:task_board_list", "category": "tools", "name": "task_board_list", "tokens": 292,
    "calls": null, "tokensPerCall": null, "zeroCall": null, "usageBasis": "no-evidence",
    "source": "native", "bytes": 1168 }
],
"findings": { "zeroCall": [], "topPerUse": [] },
"totals": { "residentTokens": 3688, "observableTokens": 0, "unknownUsageTokens": 3688,
            "observedCalls": 0, "observableTokensPerCall": null,
            "zeroCallItems": 0, "zeroCallTokens": 0, "unknownUsageItems": 13 }
}
```

注意 `categories[].observableUsage` 仍为 true（**方法**可观测），但逐项 `usageBasis` 是 `no-evidence`
（**本轮没有证据**）——两者是不同维度，不得互相覆盖。

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

### 3.4 "输出中不得出现正文"的自检办法（四项，全部可执行；验证线照此判定）

| # | 自检 | 具体做法 | 通过判据 |
|---|---|---|---|
| S1 | **哨兵不可见** | 构造合成日志：`tool/call` 的 `arguments`、`tool/result` 的 `message`、`user/message` 的 `content`、`session/title` 的 `title` 全部填唯一哨兵 `LEDGER-PRIVACY-SENTINEL-8f3a`（另加中文/emoji 变体）；跑 `usage → reconcile → JSON.stringify(report)` 与 native 渲染 | 两份产物中 `includes("LEDGER-PRIVACY-SENTINEL-8f3a") === false`，且结构等于期望值 |
| S2 | **载荷不变性（差分证明）** | 同一条日志做两份：A 的载荷字段（`arguments`/`message`/`content`/`title`/`meta`/`error`）全填哨兵 S1；B 的同一批字段替换为**不同长度、不同字符集**的随机垃圾 S2 | 归一化 `generatedAt` 后 `JSON.stringify(A) === JSON.stringify(B)`。这机械地证明输出只是白名单字段（`type` + `name` + 计数）的函数 |
| S3 | **全局字符串白名单** | 对整份 report 递归遍历所有字符串值，要求每个都命中：枚举常量（`context_ledger`/`token`/`heuristic-v1`/四种 category/四种 usageBasis）、`NAME_PATTERN`、绝对路径（`/` 起始）、ISO-8601 时间戳、`workspaceKey` 形态（`--…--`）、数字字符串 | 无例外；任一字符串不命中即失败。此检查在真实日志上跑（E2E） |
| S4 | **真实日志 E2E** | 用本机真实会话日志（`~/.dsh/sessions/…/session.v4.jsonl.zstd`，**只读**）跑完整链路，再跑 S3；随后把 S1 的哨兵注入同一日志的载荷字段（写入工作区内的副本，绝不改原日志）后重跑 | ①S3 通过；②注入哨兵前后 report 逐字节相同（除 `generatedAt`）；③`scope.usageAvailable === true` 且 `scope.toolCalls > 0`；④逐项 `findings.zeroCall` 与 `items` 中 `zeroCall === true` 的集合一致（本轮实际有多少零调用项由真实数据决定，**不作为通过前提**） |

对应的验证命令（实现线必须提供这些测试；BRIEF 的完成定义要求 `node --test` 全绿）：

```sh
node --test                       # 含 privacy 测试：S1/S2/S3 单元 + S4 端到端
grep -rn "arguments\|tool/result\|user/message" lib/usage.js   # 仅允许出现在"禁止读取"的注释里
```

`grep` 那条的判据：`lib/usage.js` 中出现这些词的**每一处**都必须位于声明"禁止读取"的注释或
测试夹具引用中，不得出现在任何取值表达式里。这是给验证线的人工可复核信号。

### 3.5 输出面清单（哪些字符串**可以**进产物）

允许：工具名、技能名、MCP 全名、指令链文件绝对路径、`cwd`、`workspaceKey`、`sessionsRoot`、
时间戳、枚举常量、数字、单位。禁止：任何 schema 描述文本、技能描述文本、指令文件内容、
工具参数、工具结果、消息正文、`schemaHash`/内容摘要（v1 **不输出任何内容派生的哈希**，把攻击面降到零）。

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
| 数据入口 | `GET /api/context-ledger/ledger?session=<id>&sessions=<n>` → `{ ok: boolean, report: <canonical JSON> }`；宿主侧 60s 缓存；无 `httpServer` 服务时跳过路由注册（headless 下工具仍可用） |
| 刷新 | 打开时拉取 + 手动刷新按钮；失败显示错误态；不在后台轮询 |
| 语言 | 命名空间 `context-ledger`，zh/en 双词典；数字用等宽，正文继承宿主 UI 字体（含 CJK 回退） |
| 主题 | 沿用宿主 CSS 变量（`--dsw-alias-*`），不硬编码配色 |

### 4.2 版面层级（自上而下，冻结 5 段）

1. **标题行**：`Context Ledger` / 副标题「常驻成本 × 实际调用对账」+ 更新时间 + 刷新按钮。
2. **对账总览（3 个数字，主视觉）**：
   - 常驻合计 `totals.residentTokens`
   - 观测调用 `totals.observedCalls`（副行：覆盖 `scope.sessionsScanned` / `scope.sessionsAvailable` 个会话，`windowStart→windowEnd`）
   - 每次使用成本 `totals.observableTokensPerCall`（副行：可观测部分 `totals.observableTokens` token）
3. **对账清单（本插件的核心，唯一新增价值）**：两段并排/上下排列，各取 `findings`：
   - 「**零调用 · 贵且没用**」= `findings.zeroCall`：每行 `name` + 分类徽标 + `tokens` + 红色/琥珀色 `0 次` 徽标。
   - 「**每次使用最贵**」= `findings.topPerUse`：每行 `name` + 分类徽标 + `tokens` + `calls` + `tokensPerCall`。
   - 两段都为空时显示空态文案；**不得**把"清单为空"包装成"健康"之类结论（本插件只报事实，不下判断）。
4. **四类明细**：固定顺序 4 行（`instructions` / `skills` / `tools` / `mcp`），每行 = 分类名 +
   `itemCount` + `tokens` + 占比条（`tokens / totals.residentTokens`）；点开为该类条目行（顺序见 §4.3）：
   - `tools` / `mcp` 行：`name` + `tokens` + `calls` + `tokensPerCall`（零调用项带徽标）。
   - `instructions` 行：`name`（短标签取路径尾段，完整路径进 `title`）+ `tokens` + 未知标记 + 说明「常驻，无调用信号」。
   - `skills` 行：`name` + `tokens` + 未知标记 + 说明「逐项不可观测（技能名在工具参数中）」；
     分类行额外展示 `mechanismCalls` / `mechanismTokensPerCall`：「9 次技能加载 · 43 token/次」。
5. **页脚**：范围与证据行（`workspaceKey`、`sessionsScanned`、`truncated`、`namesRejected` 告警）
   + 隐私声明一行：「仅回放工具名与调用次数，不含任何正文」。

### 4.3 排序规则（面板视图；与 §2.7 一致，不另立第二套）

| 视图 | 排序 |
|---|---|
| 对账清单·零调用 | 直接消费 `findings.zeroCall`（已按 tokens 降序） |
| 对账清单·每次使用最贵 | 直接消费 `findings.topPerUse`（已按未取整比值降序） |
| 分类行 | **固定顺序** `instructions → skills → tools → mcp`（分类身份稳定；量级由数字与占比表达） |
| 分类内条目行 | 保持 canonical `items` 相对顺序（rank0 零调用 top → rank1 每次使用最贵 → rank2 不可观测） |
| 明细展开 | 超过 6 行折叠为 `+N more`（与 context-doctor 的 `DETAIL_LIMIT` 同量级，避免浮层过长） |

面板**不得**自行重排 canonical 顺序做"优化"（避免同一数据两处不同读法）；需要新排序时改 DESIGN 版本。

### 4.4 三种状态必须视觉可区分（冻结）

| 状态 | 触发条件 | 视觉 | 文案（zh / en） |
|---|---|---|---|
| **零调用** | `zeroCall === true` | 琥珀/红徽标 + 该行前置 | `0 次` / `never called` |
| **未知（不可观测）** | `calls === null` 且 `usageBasis ∈ {unobservable, always-on}` | 中性灰徽标，**不使用**零调用样式 | `未知` / `n/a` |
| **无证据（降级）** | `calls === null` 且 `usageBasis === "no-evidence"`（即 `scope.usageAvailable === false`） | 面板顶部一条提示条，清单段显示空态 | `未读到会话日志，无法判定调用次数` / `no session-log evidence; call counts unavailable` |

硬规则：`calls === null` **绝不**渲染成 `0`，**绝不**计入零调用计数，**绝不**进入 `findings.zeroCall`。

### 4.5 面板文案键（冻结命名空间与键集，zh/en 必须同键）

`cl.title` · `cl.subtitle` · `cl.hint` · `cl.residentTotal` · `cl.tokens` · `cl.observedCalls` ·
`cl.tokensPerCall` · `cl.sessionsCovered` · `cl.window` · `cl.zeroCallTitle` · `cl.zeroCallHint` ·
`cl.topPerUseTitle` · `cl.topPerUseHint` · `cl.neverCalled` · `cl.unknown` · `cl.noEvidence` ·
`cl.cat.instructions` · `cl.cat.skills` · `cl.cat.tools` · `cl.cat.mcp` · `cl.alwaysOnNote` ·
`cl.skillsUnknownNote` · `cl.skillLoads` · `cl.expand` · `cl.collapse` · `cl.more` · `cl.refresh` ·
`cl.updated` · `cl.loading` · `cl.error` · `cl.empty` · `cl.privacyNote` · `cl.rejectedWarning`

产品名词（`token`、`schema`、`MCP`、`Context Ledger`）两种语言都不翻译（沿用 context-doctor 的约定）。

### 4.6 与 context-doctor 的边界（避免重复造轮子）

| 能力 | context-doctor | 本插件 |
|---|---|---|
| 四类 token 成本 | ✅（本插件复用它已被验证的成本口径与估算器） | ✅（同口径，便于横向比对） |
| 重复段落 / 同名遮蔽 / 技能正文 | ✅ | ❌ 不做 |
| 按严重度的裁剪建议 | ✅ | ❌ 不做（本插件只给"零调用"与"每次使用最贵"两个事实清单，不替用户下结论） |
| 调用次数回放 | ❌ | ✅ 唯一新增价值 |
| 每次使用成本排序 / 零调用清单 | ❌ | ✅ |
| 面板：成本总览 + 四类分片 + 可展开明细 | ✅ | ✅（同骨架，**内容换成对账件**：多出零调用清单与 calls/每次使用成本列） |

---

## 5. 交叉一致性（模型侧 / 面板侧共用一份契约）

- 模型 `context_ledger` 与 HTTP 路由**返回同一份 canonical JSON**（同一函数产出），面板不获得额外字段。
- 面板不做二次计算，只做展示映射：`tokens` → 字符串、`tokensPerCall` → 数字、null → `未知`。
- 唯一允许的面板派生量：占比条 = `tokens / totals.residentTokens`（除零保护：`residentTokens === 0` 时不画条）。
- 语言：canonical JSON **不含任何展示文案**（没有 `label` 之类字段）。文案全部在面板词典里，
  避免同一份 JSON 因语言不同而"形状漂移"。
- 时间：`generatedAt`/`windowStart`/`windowEnd` 一律 ISO-8601 UTC 字符串；面板按本地时区渲染。

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

---

## 7. 模块接口契约（两条实现线照此施工；只给签名，不含实现）

| 模块 | 导出（签名） | 约束 |
|---|---|---|
| `lib/tokens.js` | `estimateTokens(text: string): number`、`formatTokens(n): string`、`formatBytes(n): number` | 纯函数；无宿主依赖 |
| `lib/cost.js` | `instructionItems(files, root): LedgerItem[]`、`skillItems(skillList): LedgerItem[]`、`toolItems(schemas): LedgerItem[]` | 纯函数；入参为**数据**（不碰宿主、不碰 fs）；产出 §2.4 字段 |
| `lib/usage.js` | `countToolCalls(lines: Iterable<string>, limit: number): UsageResult`，其中 `UsageResult = { callsByName, linesRead, toolCalls, skillToolCalls, namesRejected, truncated }` | 纯函数；输入为**已解压的行**；越界由调用方夹取；只读 `type` + `data.name`（§3.1） |
| `lib/reconcile.js` | `reconcile(input: ReconcileInput): LedgerReport`（§2.1 全量对象）、`renderLedger(report): string`（§2.11） | 纯函数；**核心价值所在**；负责 §2.7 排序、§2.6 恒等式、`findings` 截断 |
| `index.js` | 宿主胶水：注册 `context_ledger`、可选 HTTP 路由、`zstd -dc` 子进程读取、`DSH_HOME` 解析、会话目录发现（`projectKey` 纯函数实现） | 唯一允许 import `@deepseek-ai/*` 的文件；`lib/**` 不得 import 宿主包（否则 `node --test` 跑不起来） |
| `client.js` | 浏览器半区：插槽落座 + 浮层（§4） | 不得反向依赖 `lib/usage.js` 的日志逻辑 |

`ReconcileInput`（冻结字段）：`{ cwd, sessionsRoot, scope: Omit<scope, "usageAvailable">, items, findingsLimit? }`
——`usageAvailable`（恒等于 `scope.sessionsScanned >= 1`）与 `totals`、`categories`、`findings` 由 `reconcile` 计算，
不由调用方传入（单点真理）。

`LedgerItem` 的构造责任边界：`lib/cost.js` 只填"成本侧字段"，`calls`/`tokensPerCall`/`zeroCall`/`usageBasis`
**一律由 `lib/reconcile.js` 赋值**（唯一赋权点，避免两条实现线各写一套次数语义）。

---

## 8. 修订记录

| 版本 | 日期 | 变更 | 触发 |
|---|---|---|---|
| v1 | 2026-10-07 | 首次冻结：数据模型（§2）、隐私落地（§3）、面板层级（§4） | 任务 t1 |
