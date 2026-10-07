# dsh-context-ledger

**把每个请求常驻注入的 token 成本，与实际调用次数对账，找出「贵且没用」的注入物。**

DSH 插件。只读，零第三方运行时依赖。

---

## 它解决什么问题

模型每个请求都自动携带一批常驻注入物：层层叠加的 `AGENTS.md` 指令链、技能目录、几十个工具 schema、MCP 工具面。它们悄悄消耗输入 token。

已有的上下文审计插件能告诉你**谁贵**，但告诉不了你**谁没用**。这会造成两种反向错误：

- 只看成本 → 会误删调用频繁的高频工具（贵，但每次使用成本极低）
- 只看频次 → 会留下几乎不用但 schema 巨大的工具（不贵？它每次请求都在付费）

本插件给出可决策的单一指标：

```
每次使用成本 = schema token ÷ 实际调用次数
```

零调用的常驻项被单独标记——它们是**纯浪费**，因为成本每请求都在付，收益为零。

## 输出

`context_ledger` 工具返回 canonical JSON，按每次使用成本全序排序，并对四类注入物分别对账：

| 类别 | 常驻成本 | 使用次数来源 |
|---|---|---|
| `instructions` | `AGENTS.md` / `CLAUDE.md` 指令链逐层 | 不适用（始终生效） |
| `skills` | 技能目录描述 | 分类级（见下方限制） |
| `tools` | 内置工具 schema | 会话日志真实调用计数 |
| `mcp` | MCP 工具 schema | 会话日志真实调用计数 |

浏览器半区提供一个面板（插槽 `conversation.input.right`），把对账结果按上述层级呈现。

## 重要限制：逐技能次数不可观测

DSH 只有**单一** `skill` 工具，技能名位于该工具的**参数**中，且会话事件词汇表中没有任何 skill 级事件。在本插件的隐私边界下（不读工具参数），**逐技能调用次数无法观测**。

因此：

- 技能项的 `calls` 为 `null`，`usageBasis` 为 `unobservable`，**绝不报告为 0**（那会把"未知"伪装成"没被用过"）
- 技能维度改用**分类级**替代指标：`scope.skillToolCalls` 与 `categories.skills.mechanismCalls` / `mechanismTokensPerCall`

"只读 `skill` 工具的 `name` 参数"这一方案已被**明确否决**：隐私保证的核心是"忽略全部载荷字段后产物逐字节不变"，为一个字段开例外会让这条最强保证失效。

## 隐私边界

会话日志含用户正文。本插件**只**读取：

- 每行的顶层 `type` 字段
- `type === "tool/call"` 时该行的 `data.name`（工具名）

**禁止**访问：`data.arguments`、`data.callId`、`data.turn`、`data.step`、`data.message`、`data.content`、`data.title`、`data.text`、`data.meta`、`data.error`、`data.stream`、`data.usage`，以及任何子调用的 `data.subCallId`。

产物中不出现任何工具参数、工具结果、用户消息或助手正文片段。此外：

- **不写任何文件**（HTTP 缓存仅在内存）
- **不执行**任何被审计对象
- **无对外网络调用**（HTTP 路由仅同源）

## 安装

```sh
dsh plugin --profile <name> add link:/path/to/dsh-context-ledger
dsh --profile <name> --dump-config | grep context-ledger
```

## 开发

宿主依赖由 profile 提供，本地开发需要先链接：

```sh
mkdir -p node_modules/@deepseek-ai
for p in dsh-tools cordis dsh-fs dsh-skill dsh-session dsh-util-values; do
  ln -sfn /opt/dsh/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/$p node_modules/@deepseek-ai/$p
done
```

```sh
node --check index.js && node --check client.js
node --test
```

**硬约束**：`lib/**` 一律不得 import `@deepseek-ai/*`，否则 `node --test` 无法运行。宿主依赖只允许出现在 `index.js`。

### 模块切分

| 模块 | 职责 |
|---|---|
| `lib/tokens.js` | token 启发式估算（ASCII ≈ 4 字符/token，非 ASCII ≈ 1.5） |
| `lib/cost.js` | 成本侧账目（只填成本字段，不含次数语义） |
| `lib/usage.js` | 会话日志流式回放 → 调用计数（只读 `type` 与 `data.name`） |
| `lib/reconcile.js` | `calls`/`tokensPerCall`/`zeroCall`/`usageBasis` 的**唯一赋权点**；排序、恒等式、findings |
| `index.js` | 宿主接线：取服务、注册工具、可选 HTTP 路由、`zstd -dc` 流式读取 |
| `client.js` | 浏览器半区面板（手写 loader bundle，无构建链） |

## 文档

- `BRIEF.md` — 项目简报：目标、范围红线、隐私红线、环境事实、授权边界
- `DESIGN.md` — 冻结契约：数据模型、隐私落地、面板层级、模块接口
- `IMPLEMENTATION-NOTES.md` — 实现期发现的契约澄清与队长裁定、已知缺口

## 许可

MIT
