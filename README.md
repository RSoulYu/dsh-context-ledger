# dsh-context-ledger

**把每个请求常驻注入的 token 成本，与实际调用次数对账——找出那些「每请求都在付钱、收益为零」的注入物。**

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![version](https://img.shields.io/badge/version-0.5.0-green.svg)](CHANGELOG.md)

**简体中文** | [English](README.en.md) · [CHANGELOG](CHANGELOG.md) · [设计契约](docs/DESIGN.md)

## 为什么

模型每个请求都自动背着一批常驻注入物：层层叠加的 `AGENTS.md` 指令链、技能目录、几十个工具 schema、MCP 工具面。它们每请求都在计费，平时却没人量化。

同类工具能告诉你**谁贵**，但告诉不了你**谁没用**：只看成本会误删高频工具（贵，但每次使用成本极低），只看频次会留下 schema 巨大却几乎不用的工具。只有相乘才可决策——本插件做的是**对账**，不是成本统计：

```
每次使用成本 = 常驻 token ÷ 实际调用次数
```

## 安装

```sh
dsh plugin --profile <profile> add "github:RSoulYu/dsh-context-ledger#main"
dsh --profile <profile> --dump-config | grep context-ledger   # 确认合成树含该条目
```

改动 `index.js` 或 `client.js` 后需重启 `dsh web` 生效。

## 使用

**面板**——在会话 composer 的工具行点击账本控件：优先打开宿主右侧栏并同一步展开；宿主不支持（老版本 / headless / tab 被抢注 / 开栏抛错）时回退到就地浮层，控件不会是死按钮。

**模型工具**——v0.4.0 起按需启用、默认关闭（这条声明本身就是常驻成本，本插件用同一把尺子量自己）。在 profile 的 `cordis.patch.yml` 里开启：

```yaml
- id: context-ledger
  config:
    tool:
      enabled: true
```

```
context_ledger                    # 审计当前会话工作目录
context_ledger sessions=60        # 会话回放窗口（默认 20，上限 200）
context_ledger detail=developer   # 附带逐条证据回执
```

工具、面板与 HTTP 路由走同一条取数路径、返回同一份 canonical JSON，不开启工具不影响面板与路由。

## 能力

| 能力 | 说明 |
|---|---|
| **成本 × 使用对账** | 指令链 / 技能目录 / 工具 schema / MCP 四类各给常驻成本，并与会话日志里的真实调用次数对账 |
| **归属推断** | `providedBy` 回答「这个工具由谁提供」：`plugin` / `core` / `mcp-server` / `unknown`，每条附置信度与判定手段 |
| **裁剪候选** | `prunePlan` 把从未被调用的常驻项按**可卸载单元**聚合，给出 `usedToolCount` 让卸载代价可见 |
| **隐藏候选** | `hidePlan` 只把工具从模型可见性里移除、不卸载插件，附可粘贴的 deny 清单与恢复路径 |
| **三态调用口径** | 区分「本会话用过 / 只用过历史 / 窗口内从未用过 / 不可判定」；**不可判定给 `null`，不给 `0`** |

**默认只输出建议，绝不自动施加。** 隐藏工具是显式 opt-in，且只在 agent 作用域内生效（DSH 拒绝全局限制）。

## 边界与隐私

**设计使然，不是缺陷：**

- **token 是启发式估算**（ASCII ≈ 4 字符/token，非 ASCII ≈ 1.5），用于相对比较与排序；精确值以模型 tokenizer 为准。
- **「从未被调用」≠「没用」**：工具可能由界面、后台流程或极低频但关键的操作使用。输出一律是**候选语气**，不含「建议卸载」这类确定性措辞。
- **归属是安装侧静态推断**，非运行时可证；扫不到的如实记为 `unknown` 或 `core`，不猜。
- **逐技能调用次数不可观测**：DSH 只有一个 `skill` 工具、技能名在其参数里，而本插件承诺不读任何工具参数，故技能维度只给分类级指标。
- **省 token ≠ 等比例省钱**：常驻前缀通常命中缓存，裁掉 schema 省下的是缓存价，金额远小于 token 比例暗示的幅度。
- **可卸载单元是 bundle，不是事实包**：可执行收益通常远小于「零调用 token 总量」。
- **会话窗口影响结论**：`sessions` 越小，「从未被调用」清单越长，请按实际使用周期调整。

**隐私红线**——会话日志含用户正文。本插件只读每行顶层 `type` 字段，以及 `type === "tool/call"` 时的 `data.name`（工具名）。**禁止**访问 `data.arguments`、`data.callId`、`data.message`、`data.content` 等一切载荷字段；产物中不出现任何工具参数、工具结果或对话正文。**不改环境**：不写文件、不落地缓存、不执行被审计对象、无对外网络调用。

## 已知限制

- **PTC 传输下「常驻」量的是系统提示里的 `tools:sdk` 声明，不是 JSON schema。** 报告用 `scope.measureBasis` 标明口径：`"system-prompt-declaration"`（PTC）或 `"tool-schemas"`（退路口径）。**看到退路口径就不要拿它做绝对量决策。**
- **右侧栏的浏览器内行为未纳入自动化测试**：`npm test` 覆盖注册形状、开栏调用、降级回退与内容义务；「宿主是否接受该 tab、点一次是否真的展开」需人工在浏览器确认。

## 开发

```sh
npm run check    # 语法检查
npm test         # 全量测试
```

**硬约束**：`lib/**` 一律不得 import `@deepseek-ai/*`，否则 `node --test` 无法运行；宿主依赖只允许出现在 `index.js`。

文档：[设计契约](docs/DESIGN.md) · [项目简报](docs/BRIEF.md) · [候选池](docs/BACKLOG.md) · [实现注记](docs/IMPLEMENTATION-NOTES.md)

## 许可

[MIT](LICENSE) © 2026 RSoulYu
