# dsh-context-ledger — 项目简报（所有成员开工前必读）

## 一句话目标

把「每个请求常驻注入的 token 成本」与「实际调用次数」对账，找出**贵且没用**的注入物。
核心指标：**每次使用成本 = schema token ÷ 调用次数**。

## 为什么不是"又一个上下文审计插件"

同类插件 `dsh-context-doctor` 已覆盖纯成本核算（约 90%），**不要重复造那部分**。
它回答"谁**贵**"，回答不了"谁**没用**"——全源码检索使用频次逻辑零命中。
单独看成本会误删高频工具；单独看频次会留下昂贵但偶尔关键的工具。**只有相乘才可决策。**

本插件要做的是**对账**，不是成本统计。

## 范围红线（用户明确要求：不过度延伸）

**做**：
- 四类常驻注入物的成本：指令链 / 技能目录 / 工具 schema / MCP 工具
- 会话日志回放：真实调用次数
- 合成：每次使用成本排序 + 零调用项标记
- 一个 `context_ledger` 模型工具 + 一个客户端面板

**不做**（属于 context-doctor 的地盘，或用户明确排除）：
- 跨文件重复段落检测 / 同名技能遮蔽检测（语义相似度更不做）
- 技能正文 token 统计
- 跨会话趋势图表
- 发布 npm、推送 GitHub

## 隐私红线（不可协商）

会话日志含**用户正文**。允许与禁止：

| 允许 | 禁止 |
|---|---|
| 工具名 | 工具参数 |
| 调用计数 | 工具结果 |
| 会话数量、时间戳 | 用户消息、助手正文 |
| 文件字节数 / token 估算 | 文件内容、重复段落片段 |

违反此边界即视为任务失败。产出物中不得出现任何正文片段。

## 环境事实（已实测，不要重新假设）

| 事实 | 值 |
|---|---|
| DSH 版本 | 0.2.0-rc.2 |
| Node | v26.10.0 |
| 仓库路径 | `/home/u/Desktop/DSHWorkspace/dsh-context-ledger` |
| 参照实现（**只读参考，勿改**） | `/home/u/Desktop/DSHWorkspace/.feas/context-doctor` |
| 宿主依赖 | 已符号链接至 `node_modules/@deepseek-ai/`（来自 DSH 安装目录） |
| 会话日志 | `~/.dsh/sessions/<工作区>/<会话id>/session.v4.jsonl.zstd` |
| 解压工具 | 系统 `zstd`（`/usr/bin/zstd`） |
| 工具调用记录 | JSONL 中 `type == "tool/call"`，工具名在 `data.name` |
| 隔离验证 home | `DSH_HOME=/home/u/Desktop/DSHWorkspace/.feas/isolated-home`，profile 名 `testbed` |

**绝对禁止修改**（用户长期纪律）：
- `/opt/dsh/node_modules/@deepseek-ai/dsh/**`
- `~/.dsh/**`（含 `profiles/`、`sessions/` 只读）

验证插件**必须**用隔离的 `DSH_HOME`（指向工作区内目录），绝不碰真实 profile。

## 授权边界（用户已明确）

**已授权**：工作区内 `git commit`、网络访问（`curl` / `git clone`）、工作区内 `npm install`。
**未授权**：推送到 GitHub、发布到 npm。**不要尝试。**

## 已完成的骨架（可用，勿推倒重来）

```
dsh-context-ledger/
├── package.json        # dsh manifest + peerDeps 指向本机真实版本 >=0.2.0-rc.2
├── cordis.patch.yml    # bundle patch，已装进隔离 profile 验证通过
├── index.js            # 宿主半区骨架：estimateTokens / visibleSchemas / schemaCosts / apply
└── test/
```

**已验证通过**的链路（这是你的起点，不是待办）：
1. `dsh plugin --profile testbed add link:<repo>` 安装成功
2. `dsh --profile testbed --dump-config` 合成树含 `context-ledger` 条目
3. 假 ctx 下 `apply()` 正常执行，工具注册成功
4. `execute()` 返回真实数据：`{"visibleCount":2,"totalTokens":29,...}`

## 建议的模块切分

纯函数与宿主胶水分开，纯函数才能用 `node --test` 直接测：

| 模块 | 职责 | 可测性 |
|---|---|---|
| `lib/tokens.js` | token 启发式估算、格式化 | 纯函数，可测 |
| `lib/cost.js` | schema / 技能目录 / 指令链 → 成本表 | 纯函数（入参为数据，不碰宿主） |
| `lib/usage.js` | 会话日志回放 → 调用计数 | 纯函数（入参为已解压文本行） |
| `lib/reconcile.js` | 成本 × 使用 → 每次使用成本排序、零调用标记 | 纯函数，**核心价值所在** |
| `index.js` | 接线：取宿主服务、注册工具、可选 HTTP 路由 | 胶水，单元测试覆盖有限 |
| `client.js` | 浏览器半区面板 | 需构建或纯 JS |

**关键约束**：`lib/*.js` **不得** import `@deepseek-ai/*`，否则 `node --test` 跑不起来。
宿主依赖只允许出现在 `index.js`。

## 参照物说明

`context-doctor` 是 **BSD-3-Clause**，可参考其**输出格式与 UI 思路**（用户明确要求参照），
但**不要整段复制代码**，也继承它的兼容性问题。它的实际缺陷：peer 范围 `dsh-tools ^0.1.2-rc.1`
不含本机 `0.2.0-rc.2`。本插件应直接以本机版本为准。

## 完成定义

- `node --check index.js && node --test` 全绿
- 隔离 profile 下安装、dump-config、apply 三步均通过
- 用一个真实会话日志跑出「零调用项清单」，且**已验证输出中无任何正文片段**
