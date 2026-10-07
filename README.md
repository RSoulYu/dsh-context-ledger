# dsh-context-ledger

**DSH 上下文账本：把每个请求常驻注入的 token 成本，与实际调用次数对账。**

模型每个请求都自动背着一批常驻注入物——层层叠加的 `AGENTS.md` 指令链、技能目录、几十个工具 schema、MCP 工具面。它们每次请求都在计费，但平时没人量化。

本插件给出单一可决策指标：

```
每次使用成本 = 常驻 token ÷ 实际调用次数
```

零调用的常驻项被单独标记——它们的成本每请求都在付，收益为零。

DSH 插件 · 只读 · 零第三方运行时依赖。

---

## 为什么不是"又一个上下文审计插件"

同类插件能告诉你**谁贵**，但告诉不了你**谁没用**。这会造成两种反向错误：

- 只看成本 → 会误删调用频繁的高频工具（贵，但每次使用成本极低）
- 只看频次 → 会留下几乎不用但 schema 巨大的工具

只有相乘才可决策。本插件做的是**对账**，不是成本统计。

---

## 能力

### 1. 成本 × 使用对账（v0.1.0）

四类常驻注入物各自给出成本，并与会话日志中的**真实调用次数**对账：

| 类别 | 常驻成本 | 使用次数来源 |
|---|---|---|
| `instructions` | `AGENTS.md` / `CLAUDE.md` 指令链逐层 | 不适用（始终生效） |
| `skills` | 技能目录描述 | 分类级（见下方边界） |
| `tools` | 内置工具 schema | 会话日志真实调用计数 |
| `mcp` | MCP 工具 schema | 会话日志真实调用计数 |

### 2. 归属与可执行裁剪清单（R1）

- `items[].providedBy` —— 回答"这个工具由谁提供"，取值域 **`plugin` / `core` / `mcp-server` / `unknown`**，每条附**置信度与判定手段**（不是二值猜测）。
- `findings.prunePlan` —— 汇总为**"从未被模型调用的常驻项候选"**，按**可卸载单元**聚合，并给出 `usedToolCount`（该单元还有几个工具在用），**让卸载代价可见**。

> 关键设计：`providedBy` 是**安装侧静态推断，非运行时可证**。契约里明确禁止把"从未被模型调用"写成"没用"——那是推断，不是事实。

### 3. 工具级隐藏候选（R6）

不卸载任何插件、仅把工具从模型可见性中移除，即可收回常驻成本。对"功能由独立服务提供"的插件零功能损失。

- `findings.hidePlan` + 可粘贴的 deny 清单 + 恢复路径
- **默认只输出建议、绝不自动施加**；施加为显式 opt-in，且**只能在 agent 作用域内**（DSH 明确拒绝全局限制）
- 与 `prunePlan` **并列呈现，两个动作的 token 绝不相加**

### 4. 面板：就地浮层 + 右侧栏

在 composer 工具行注册一个账本控件。点击后**优先打开右侧栏**（宿主原生 tab，`ctx.sidebarRight.openTab`），**同一步展开**，不需要再点第二次。

- **内容零分叉**：右侧栏与就地浮层共用同一条取数路径和同一套文案，可见文本序列逐一相同（差异仅在 `role` 与 `data-cl-mode`）。
- **优雅降级**：缺 `ctx.sidebarRight`（老宿主 / headless）、无在屏会话、tab 类型被抢注、开栏抛错、HMR 撤下 —— 一律**回退到就地浮层，控件永不是死按钮**。
- 面板按层级呈现：总览 → 每次使用最贵 → 裁剪候选 → 无法给出动作 → 隐藏候选 → 恢复路径 → 四类明细。

### 5. 三态调用口径：区分「没用过」与「最近没用」

报告给三个数，量纲不同，**不可相加**：

| 数 | 含义 |
|---|---|
| `items[].calls` | **窗口内**总调用（窗口 = `sessions` 参数，默认 20，上限 200） |
| `items[].currentSessionCalls` | **当前会话**内的调用数 |
| `items[].sessionsWithCalls` | **覆盖会话数**：扫描的 N 个会话里，有几个用过它 |

`callPresence` 把三者归纳成一句话：`current-session`（本会话用过）/ `historical-only`（只用过历史）/
`absent`（窗口内从未用过）/ `null`（不可判定）。

> **为什么要三个**：只给窗口口径时，"最近 20 个会话里 0 次"很容易被读成"从未使用"。
> 但一个工具完全可能**在更早的会话里用过、只是最近没用**——两者的处置完全不同。
>
> **不可判定时给 `null`，不给 `0`。** "不知道"和"零调用"是两回事，混起来会直接误导判断。
> 面板对这两者也有**样式级区分**（真 0 是普通数字格，不可得是中性灰徽标）。

窗口边界（`windowStart` / `windowEnd` / `sessionsOutsideWindow`）会显式出现在报告里，
所以"零调用"始终有一个明确的参照系。**报告不穷尽磁盘**——窗口外的会话会被如实记数。

---

## 安装

```sh
dsh plugin --profile <你的profile> add "github:<user>/dsh-context-ledger#main"
dsh --profile <你的profile> --dump-config | grep context-ledger
```

本地开发可直接 link：

```sh
dsh plugin --profile <你的profile> add link:/path/to/dsh-context-ledger
```

> 修改了 `client.js` 或 `index.js` 之后需重启 DSH 生效。**注意**：插件激活失败会让整个 DSH 启动失败（`startup failed: N required plugins did not activate`），所以改动后先跑 `npm run check && npm test` 再重启。

## 使用

模型侧调用工具：

```
context_ledger                          # 审计当前会话工作目录
context_ledger sessions=60              # 扩大会话日志回放窗口（默认 20，上限 200）
context_ledger detail=developer         # 附带逐条证据回执
```

浏览器侧：在会话的 composer 工具行点击账本控件，展开面板。

---

## 已知缺陷与实现边界

> 这一节是**必读**的。本插件刻意把"未知"与"已知"分开呈现，同理，它自己的能力边界也如实列在这里。

### 缺陷

**当前版本无已知阻断缺陷。**

版本历史中修掉的两个真实缺陷（详见 [CHANGELOG](./CHANGELOG.md)）：

| # | 缺陷 | 影响 | 状态 |
|---|---|---|---|
| B1 | `probeRestrict` 以 `Array.isArray` 判定 `restrictableNames` 可用性，而宿主真实返回 **`Set`**（`dsh-tools/lib/index.js:2969`） | 真机上会恒判"接口缺失" ⇒ `hidePlanStatus` 恒 `unsupported`、可粘贴 deny 清单恒为空 ⇒ R6 核心交付物在真机上不生效（其余功能不受影响） | **已修复并复核通过**（0.2.0） |
| B0 | 面板必崩：含 hook 的组件被当普通函数调用且位于条件分支内，展开即触发 React `Rendered more hooks than during the previous render` | 浏览器一打开面板即崩 | **已修复**（0.2.0） |

> B1 的成因值得记录：它穿过了三份验证报告合计 1000+ 条断言，因为**测试夹具自己造了一个数组型接口**——夹具与实现自洽，套件全绿，而不一致发生在**实现与宿主之间**。修复同时加了一条**读宿主源码的类型对拍用例**：宿主将来改类型会显式失败，而不是套件继续绿。

### 边界（设计使然，不是缺陷）

1. **token 是启发式估算**（ASCII ≈ 4 字符/token，非 ASCII ≈ 1.5 字符/token），用于**相对比较与排序**；精确值以模型 tokenizer 为准。
2. **"从未被模型调用" ≠ "没用"**。工具可能由界面、后台流程或极低频但关键的操作使用。因此输出一律是**候选语气**，禁用"建议卸载/移除"等确定性措辞。
3. **`providedBy` 是安装侧静态推断**，非运行时可证；扫不到的如实记为 `unknown` 或 `core`，**绝不猜**。
4. **逐技能调用次数不可观测**。DSH 只有一个 `skill` 工具、技能名在其**参数**里，而本插件承诺不读任何工具参数（隐私红线）。故技能维度只给**分类级**替代指标。
5. **"省 token" ≠ "等比例省钱"**。实测本机 **98–99% 的输入 token 是缓存命中**，常驻前缀几乎总在缓存里 ⇒ 裁掉 schema 省的是**缓存价**，金额远小于 token 比例暗示的幅度。
6. **可卸载单元是 bundle，不是事实包**。例如 `task-board` 系列并不在 profile 依赖里，而是由 `@linxin666/dsh-web-all` 的 patch 引入 ⇒ 唯一可卸载单元是 `dsh-web-all`（可能捆着十几个子插件）。`prunePlan` 因此按**可卸载单元**聚合，并给出 `usedToolCount` 让你看到代价。**可执行收益通常远小于"零调用 token 总量"。**
7. **不改环境**：不写文件、不落地缓存、不执行被审计对象、无对外网络调用；隐藏工具的施加**默认关闭**，开启后也只作用于 agent 作用域。
8. **会话窗口影响结论**：`sessions`（默认 20）决定回放多少会话。窗口越小，"从未被调用"的清单越长。请按你的实际使用周期调整。
9. **右侧栏的浏览器内行为未纳入自动化测试**。`npm test` 覆盖的是注册形状、开栏调用、降级回退与内容义务（结构化断言）；"宿主是否接受该 tab、点一次是否真的展开"由**一次性真机验证**（隔离 `DSH_HOME` + 受管实例 + headless Chromium）确认，其驱动器未进 `test/**`。若你改动了承载位置相关代码，**请自行在浏览器里点一次确认**。

### 隐私红线

会话日志含用户正文。本插件**只**读取：

- 每行的顶层 `type` 字段
- `type === "tool/call"` 时该行的 `data.name`（工具名）

**禁止**访问 `data.arguments`、`data.callId`、`data.message`、`data.content` 等一切载荷字段。产物中不出现任何工具参数、工具结果、用户消息或助手正文片段。

---

## 开发

宿主依赖由 profile 提供，本地开发需先链接：

```sh
mkdir -p node_modules/@deepseek-ai
for p in dsh-tools cordis dsh-fs dsh-skill dsh-session dsh-util-values; do
  ln -sfn /opt/dsh/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/$p node_modules/@deepseek-ai/$p
done
```

```sh
npm run check    # 语法检查
npm test         # 全量测试
```

**硬约束**：`lib/**` 一律不得 import `@deepseek-ai/*`，否则 `node --test` 无法运行；宿主依赖只允许出现在 `index.js`。

### 文档索引

| 文件 | 内容 |
|---|---|
| `BRIEF.md` | 项目简报：范围红线、隐私红线、环境事实、授权边界 |
| `DESIGN.md` | **冻结契约**：数据模型、隐私落地、面板层级、模块接口（当前 v3） |
| `BACKLOG.md` | 候选池、价值标尺、已完成项、**阻塞性携带项** |
| `IMPLEMENTATION-NOTES.md` | 实现期澄清与**队长裁定**（append-only） |
| `VERIFY-*.md` | 四份独立验证报告（t4 / t7+t12 / t9 / t16+t17） |
| `R6-DESIGN-DRAFT.md` | R6 契约草稿（已并入 DESIGN v3，保留为来源证据） |

## 许可

[MIT](LICENSE)
