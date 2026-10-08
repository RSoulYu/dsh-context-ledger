# dsh-context-ledger — 独立验证报告（t4）

> 验证人：验证（AgentTeams 成员）
> 任务：`t4 [verify]` · attempt `eaf5f19b-82d7-4058-a675-7af864935f7a`
> 基线：`dsh-context-ledger` @ git commit `a70a237`（22 文件，工作树干净，无远端）
> 环境：DSH 0.2.0-rc.2 / Node v26.10.0 / zstd 1.5.7
> 纪律：未修改 `/opt/dsh/node_modules/@deepseek-ai/dsh/**` 与 `~/.dsh/**`；未修改任何实现文件。

## 0. 结论

**全部 7 项核验项通过，未发现阻断性问题，未发现隐私越线。**

不信任实现方自述：所有断言都由本轮独立编写、独立执行。共 **478 条独立断言，0 失败**
（含 6 个自建核验套件 + 1 个白名单对抗套件）。验证过程中我自己写错了 9 处期望值，
已逐条定位并更正（见 §8「验证方自身的错误」）——更正记录保留，不掩盖。

| # | 核验项 | 结论 |
|---|---|---|
| 1 | 隐私红线（权重最高） | ✅ 通过 |
| 2 | 数值正确性（本次核心） | ✅ 通过 |
| 3 | 客户端半区在真实启动图中的可加载性 | ✅ 通过 |
| 4 | 契约一致性（冻结字段名/语义/排序） | ✅ 通过 |
| 5 | 只读性 | ✅ 通过 |
| 6 | 隔离性 | ✅ 通过 |
| 7 | 范围红线 | ✅ 通过 |

发现 **5 项非阻断观测**（其中 2 项是对实现方/设计方表述的纠正），全部列在 §9。
**1 项覆盖缺口**（§10）：`?session=` 的 agent 解析路径只有静态 API 符合性证据，没有真实会话端到端证据，
原因是我不能使用真实 `~/.dsh` 托管一个有会话的 web 服务（纪律所限）。

---

## 1. 隐私红线（权重最高）—— ✅ 通过

### 1.1 静态确认：不存在对禁止字段的访问

```
$ grep -rn "data\.[A-Za-z_]" index.js lib/ client.js
lib/usage.js:10:  *   2. `type === "tool/call"` 时的 `data.name`（工具名）。
lib/usage.js:12:  *   data.arguments   data.callId        data.turn / data.step     ← 注释（禁止清单）
lib/usage.js:13:  *   data.message     data.content       data.title / data.text    ← 注释（禁止清单）
lib/usage.js:14:  *   data.meta        data.error         data.stream / data.usage  ← 注释（禁止清单）
lib/usage.js:18:  * 其 data.subCallId / data.name 同样不读。                          ← 注释
lib/usage.js:146:      // ── 白名单终点：`data.name` 是唯一被读的数据字段 ──               ← 注释
lib/usage.js:147:      const toolName = data.name                                        ← 唯一的实际读取
client.js:805:          if (data !== null && typeof data === 'object' && data.ok === true   ← 本插件自己的 HTTP 响应体
client.js:806:            && data.report !== null && typeof data.report === 'object'
```

`record` 对象只有 2 处属性访问：`record.type`（line 142）、`record.data`（line 143）。
全仓库唯一的 `JSON.parse` 在 `lib/usage.js:137`（日志行）。`client.js` 的 `data.*` 读的是
`GET /api/context-ledger/ledger` 的响应体 `{ok, report}`，与日志无关。

**代码 vs 注释的机械判定**（不用人眼，逐行判定是否落在注释块内）：

```
$ node -e "<逐行判定注释块 + 命中关键词>" 
  2 COMMENT  text
 12 COMMENT  arguments,callId
 13 COMMENT  content,message,title,text
 14 COMMENT  meta,error,stream,usage
 15 COMMENT  message,title,tool/result,user/message
 18 COMMENT  subCallId
 23 COMMENT  usage
```

**7 处命中，7 处全在注释，代码行 0 处。** 这比 DESIGN §3.4 要求的「人工可复核信号」更强。

已复核且判定为非问题的一处：
`index.js:560` 的 `error.message` 是 **HTTP 路由 500 分支里 `Error` 对象的 `.message`**，
不是日志记录的 `data.message`；`index.js:491` 的 `'content-type'` 是 HTTP 响应头名。
（我在报告里点明这两处，避免下游误读 grep 命中为越线。）

### 1.2 日志形状实测（证明「只读 name」是可行的最小读取）

自己用 `zstd -dc` 流式解压 6 个真实会话（3.18MB/2.65MB/2.54MB/1.86MB/177KB/41KB 压缩体积），逐行解析：

```
[corpus] lines=7871 forbiddenStrings=18317 distinct16Shingles=4212122
[corpus] distinct DATAKEYS shapes:
   DATAKEYS:tool/call -> arguments,callId,name,step,turn  x1296
   DATAKEYS:assistant/message -> message,step,stream,turn,usage  x1121
   DATAKEYS:tool/result -> message,step,turn  x1031
   DATAKEYS:tool/result -> message,meta,step,turn  x248
   DATAKEYS:user/message -> content,id,role,source  x192
   DATAKEYS:step/start -> step,turn  x1124
   DATAKEYS:session-log-deepseek/delivery-accepted -> sessionFormatVersion,sessionId,throughSeq  x1130
   ...
```

即：`tool/call` 的 `data` 里确实有 `arguments`/`callId`，与 DESIGN §1 冻结的落盘键一致；
而回放只需要 `data.name`。

### 1.3 我实际执行的核查方法与原始输出

**缓存文件**：`~/.dsh/sessions/--home-u-Desktop-DSHWorkspace--/` 下 39 个会话目录，
只用 `zstd -dc` 流式读取，未复制、未修改（验证结束后复查仍为 39 个目录）。

我从真实日志的**全部禁止字段**里抽 16-gram（`data.arguments` / `tool/result.message` /
`user/message.content` / `session/title.title` / `meta` / `error` / `stream` / `usage` /
`assistant/message.message` …）建立语料库（4 212 122 个不同 16-gram），然后检查这些
gram 是否出现在插件产物里。为消除「合法来源值」造成的假阳性，先把产物里
**非循环推导**的合法来源值（reconcile 入参：`cwd`/`sessionsRoot`/`workspaceKey`/时间戳/
item 名与 id/`source`/`provider`/`server`；以及 `callsByName` 的键=允许的工具名；
以及 DESIGN 冻结的常量与 canonical 键名）在原文本里挖成 `#`，再看语料是否仍能命中：

```
[S3-independent] strings=337 violating=0
[charclass] strings containing whitespace/CJK/quote/backslash (excluding paths) = 0
[S1-real] 16-gram forbidden-payload shingles=4212122 | masked-report RESIDUAL-LEAK=0 | masked-native RESIDUAL-LEAK=0
[S1-real-synthetic-items] 16-gram masked RESIDUAL-LEAK=0
[provenance] leaf strings=337 not traceable to reconcile input/constants=0
```

- **RESIDUAL-LEAK = 0**：真实日志的 421 万个禁止内容 16-gram，没有一个能命中产物（JSON 与 native 渲染皆 0）。
- **provenance = 0**：产物里 337 个字符串，逐个都能溯源到 reconcile 的入参或冻结常量
  （数字字符串与 ISO 时间戳另行放行）。这是「产物只是白名单字段的函数」的机械证明。
- **charclass = 0**：产物里没有任何含空白/中文/引号/反斜杠的字符串（路径除外）。

**哨兵注入 + 载荷不变性差分**（DESIGN §3.4 S1/S2，我独立复现）：

取一个真实 2583 行日志，把**全部禁止字段**替换为 `LEDGER-PRIVACY-SENTINEL-8f3a`
与 `正文哨兵-中文-😀-QUOTED"\x`（ASCII + CJK + emoji 变体），比较替换前后的回放结果与报告：

```
[S2-diff] usageA===usageB : true
[S2-diff] reportA===reportB (generatedAt normalized): true
[S1-sentinel] sentinel(ascii or cjk/emoji) visible in any product: false
```

替换掉全部载荷后**回放结果逐字节相同、完整报告逐字节相同（除 generatedAt）**——
这在数学上排除了「任何载荷字段影响产物」的可能性，比抽样检查更强。

**名字护栏对抗测试**（9 个恶意/畸形 `data.name`）：

```
[guard] toolCalls=9 namesRejected=6
         acceptedKeys=["__proto__","constructor","mcp__ok__tool"]
[guard] any accepted key fails NAME_PATTERN: false
[guard] product contains secret-payload: false
[guard-item] {"id":"tools:nevertool","name":"nevertool","calls":0,"zeroCall":true,"usageBasis":"tool-calls"}
[guard-item] {"id":"tools:bad name with spaces","name":"bad name with spaces","calls":null,"zeroCall":null,"usageBasis":"unobservable"}
[guard-item] scope.namesRejected=1 findings.zeroCall=["nevertool"]
```

被拒的 6 个：`bash --command "rm -rf /"`、`中文工具名带正文`、200 字符超长名、
含换行的名字、`name with spaces`、`quote"inside`——全部只累加 `namesRejected`，不进产物。
关**键安全性质**同时得到验证：常驻项名字不过护栏时降级为 `unobservable`/`calls=null`/`zeroCall=null`，
且**不会**被误判为零调用（`bad name with spaces` 未进 `findings.zeroCall`）。
`__proto__` 通过护栏（`_` 是合法字符）但被 `Object.defineProperty` 安全处理，无原型污染、无漏计。

**结论**：产出物中只有工具名、计数、路径、时间戳与枚举常量，无任何工具参数、工具结果、
用户消息或助手正文片段。

### 1.4 附加：对**宿主真实产出**（不是我脚本重构的）再扫一遍

`logs/route-real.json` 是真实 web 宿主 200 响应体（§3 那次调用），不是我构造的：

```
宿主真实路由产物：leaf strings = 41
白名单外字符串 = 0
含空白/中文/引号的字符串（路径除外）= 0
顶层键 = tool,version,generatedAt,unit,estimator,cwd,scope,categories,items,findings,totals
11 键 = true
```

宿主服务出来的 client bundle 同样只取 `react`，无跨插件值导入：

```
宿主服务出的 bundle 含 @deepseek-ai 值导入 = false
宿主服务出的 bundle 的 require 目标 = react
```


---

## 2. 数值正确性（本次核心）—— ✅ 通过

**方法**：自建「已知答案」输入，手工算出期望值（算式写在核验脚本注释里），
与插件输出逐项比对。**完全没有复用 `test/**` 的任何用例**。

```
================ NUMERIC SUMMARY: 262 passed / 0 failed ================
```

覆盖的边界（每条都带手工算式）：

| 用例 | 覆盖点 | 手工期望（节选） | 实测 |
|---|---|---|---|
| N1 | 真零调用 + 除数为 0 | `gamma tokens=0 calls=0 → tokensPerCall=null`（**除数为 0，不得算出 0 或 Infinity**）；`beta 250/1=250`；`delta 101/3=33.67→34`；`alpha 100/4=25` | 一致 |
| N1 | `totals` 及分类合计 | `resident 451`；`observableTokensPerCall=round(451/8)=56`；`categories.tools=round(350/5)=70`；`mcp=round(101/3)=34` | 一致 |
| N2 | 无证据降级（`sessionsScanned=0`） | 全部 `calls=null`/`zeroCall=null`；`findings.zeroCall=[]`；`observedCalls=0`；`observableTokensPerCall=null` | 一致 |
| N3 | 同类内混合零调用 + 不可观测 | 零调用项进 `findings.zeroCall`；不可观测项 `calls=null` 且**永不进 zeroCall**；`namesRejected=1` | 一致 |
| N4 | 排序用**未取整**比值 | `B 17/4=4.25` 必须排在 `A 21/5=4.2` 前（两者 `round` 都是 4）；若误按 round 值再按 tokens 排会得到 A 在前——那就说明设计被违背 | 一致（B 在前） |
| N4 | rank0 优先级 | 0 token 的零调用项也必须排在 999 token 的零调用项之后、非零调用项之前 | 一致 |
| N4 | rank2 全序兜底 | 同 tokens 的不可观测项按 `id` 升序 | 一致 |
| N5 | `findings` 截断 10 | 12 个零调用项 → 保留 tokens 12..3；`zeroCallTokens=78` | 一致 |
| N6 | `findingsLimit` 入参 | `findingsLimit=2` → 只保留最大的 2 个 | 一致 |
| N7 | instructions/skills 永不报次数 | 有日志证据且 `skill` 调用为 0 时，`instructions`/`skills` 仍 `calls=null`、不进 `zeroCall`；`mechanismTokensPerCall=round(386/9)=43` | 一致 |
| N9 | 机制级除零边界 | `mechanismCalls=0 → null`；`tokens=0 且 calls=5 → 0`（不是 null） | 一致 |
| N10 | `toolCalls` 恒等式 | `Σ items.calls(非空) + callsUnmatched + namesRejected` | 一致 |
| N11 | 渲染降级 | `observedCalls=0` 时首行渲染 `n/a`（不是 0） | 一致 |
| N12 | §2.9 的 13 条恒等式 | 逐条成立 | 一致 |

**另外独立重放了 DESIGN §2.9 的 13 项示例数据**（`render-frozen.mjs`，期望值照抄 DESIGN 文本）：

```
$ node render-frozen.mjs
Context ledger: 3688 tokens resident / 137 observed calls across 20 sessions / 18 tokens per use
Never called (cost without use): 3 items, 1035 tokens
  - mcp__openviking__add_resource [mcp]  402 tokens  0 calls
  - mcp__openviking__forget [mcp]  341 tokens  0 calls
  - task_board_list [tools]  292 tokens  0 calls
Most expensive per use:
  - context_ledger [tools]  214 tokens  3 calls  -> 71 tokens/call
  - agent_teams_claim_task [tools]  268 tokens  4 calls  -> 67 tokens/call
  - mcp__openviking__find [mcp]  406 tokens  8 calls  -> 51 tokens/call
  - read [tools]  186 tokens  4 calls  -> 47 tokens/call
  - bash [tools]  381 tokens  118 calls  -> 3 tokens/call
Not observable: instructions 812 tokens (always-on) / skills 386 tokens (per-skill unknown; 9 skill loads, 43 tokens/load)

================ RENDER/FROZEN §2.9-§2.11: 39 passed / 0 failed ================
```

DESIGN §2.9 断言表逐条复现：`3688 / 2490 / 1198 / 137 / 18 / 3 / 1035 / 5 / 141 / 10 / 144 / 43`
以及 `items` 顺序与 `findings` 顺序全部一致。

§2.11 冻结文本逐字节比对（`design-excerpt-compare.mjs`）：

```
§2.11 节选行数 = 9  实际渲染行数 = 12
SAME  design[0]="Context ledger: 3688 tokens resident / 137 observed calls across 20 sessions / 18 tokens per use"
SAME  design[1]="Never called (cost without use): 3 items, 1035 tokens"
SAME  design[2..4]=3 条零调用行
SAME  design[5]="Most expensive per use:"
SAME  design[6]="  - context_ledger [tools]  214 tokens  3 calls  -> 71 tokens/call"
SAME  design[7]="  - agent_teams_claim_task [tools]  268 tokens  4 calls  -> 67 tokens/call"
前 8 行逐字节相同: true
实际渲染最后一行 = "Not observable: instructions 812 tokens (always-on) / skills 386 tokens (per-skill unknown; 9 skill loads, 43 tokens/load)"
```

见 §9-F1：§2.11 是**节选**（只给了 2 行 topPerUse，而 `findings.topPerUse` 上限是 10），
实现渲染全部行。**每行都符合 §2.11 的冻结模板**，首 8 行与末行与 DESIGN 逐字节相同；
但实现方「与 §2.11 冻结文本逐字节相同」的说法在**完整**输出上不成立（12 行 vs 节选 9 行）。

---

## 3. 客户端半区在真实启动图中的可加载性 —— ✅ 通过

**方法**：在**工作区内**的隔离 `DSH_HOME`（`.feas/isolated-home`）下启动受管的
`dsh --profile testbed --port 0 --no-open`，抓取真实页面并解析 `globalThis["__DSH_BOOT__"]`，
再从宿主**自己的** `plugins/??` 端点取回 client bundle 并真机执行。

启动（受管后台作业，结束后已确认终止）：

```
$ DSH_HOME=/home/u/Desktop/DSHWorkspace/.feas/isolated-home dsh --profile testbed --port 0 --no-open
dsh web: http://127.0.0.1:38949/?token=zpO75joCwUYcnNApZtdEctf6UOxaPOKkz5b9eY4Yevk
```

真实 boot 图（页面 HTML 内 `window.__DSH_BOOT__`）：

```
$ node boot-parse.mjs
boot keys: rev, entries, batches
entries count: 66
entries mentioning dsh-context-ledger: 1
  {"id":"dsh-context-ledger","url":"plugins/??dsh-context-ledger/client.js&rev=19e2b37df64a",
   "rev":"19e2b37df64a",
   "inject":["@deepseek-ai/dsh-client-ui-renderer","@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-conversation"],
   "immediately":true}
VERDICT entries-accepted: true
```

宿主服务出来的 bundle（不是静态解析）：

```
$ curl -o ledger-client.bundle.js -w "HTTP %{http_code} bytes=%{size_download} ctype=%{content_type}\n" \
    "http://127.0.0.1:38949/plugins/??dsh-context-ledger/client.js&rev=19e2b37df64a"
HTTP 200 bytes=48571 ctype=text/javascript; charset=utf-8
（仓库 client.js = 48496 字节 + 宿主追加的 sourceMappingURL 注释）
```

真机执行（最小模块加载器 + 假 slots/locale 服务替身）：

```
$ node client-bundle-exec.mjs
spec.__ModuleLoader__ calls: [{"id":"dsh-context-ledger","hasFactory":true}]
module exports keys: [ 'name', 'inject', 'apply' ]
plugin: {"name":"context-ledger","inject":["slots","locale"],"hasApply":"function"}
effects: ["context-ledger: dictionaries"]
slot calls: [{"kind":"inject","name":"conversation.input.right"},
             {"kind":"register","contract":{"name":"conversation.input.right","id":"context-ledger","order":21,"locale":"context-ledger"},
              "componentType":"function"}]
================ CLIENT BUNDLE EXEC: 11 passed / 0 failed ================
```

**真实宿主栈的 HTTP 路由 E2E（同一进程内 `ctx.tools.schemas()` / `ctx.skills.list()` / `ctx.fs`）**：

```
$ curl -b cookies.txt -w "HTTP %{http_code} bytes=%{size_download} time=%{time_total}s\n" \
   "http://127.0.0.1:38949/api/context-ledger/ledger?cwd=<workspace>&sessions=20"
HTTP 200 bytes=2157 time=0.709188s
{"ok":true,"report":{ ...11 个 canonical 键... }}
```

为让隔离 home 能读到真实日志，我在**工作区内**建了一个**只读符号链接**
（`isolated-home/sessions/--home-…-- → ~/.dsh/sessions/--home-…--`），未复制、未修改真实日志，
验证结束后已删除该链接（复查真实日志仍为 39 个目录）。该次真实栈调用的 usage 半区完整：

```
sessionsAvailable=39  sessionsScanned=20  sessionsUnreadable=0
linesRead=11266  toolCalls=1978  skillToolCalls=2  namesRejected=0  truncated=false
windowStart=2026-10-06T00:56:44.336Z  windowEnd=2026-10-07T02:55:29.909Z
```

**进程收尾确认**（两次启动的 web 服务都已终止，无残留）：

```
$ curl -sS -m 3 http://127.0.0.1:38949/
curl: (7) Failed to connect to 127.0.0.1:38949 after 0 ms — Could not connect to server
$ pgrep -af "dsh --profile testbed"   → (无)
$ ss -ltnp | grep 35635               → no listener
```

---

## 4. 契约一致性 —— ✅ 通过

`f1-f2-contract.mjs`（84 条断言）+ `client-mapping.mjs`（23 条）：

- **顶层 11 键与顺序**：`tool/version/generatedAt/unit/estimator/cwd/scope/categories/items/findings/totals` 完全一致；
  常量 `tool="context_ledger"`、`version=1`、`unit="token"`、`estimator="heuristic-v1"`。
- **`scope` 16 键**与 §2.2 完全一致；`workspaceKey` 由 `cwd` 按 §1 算法推导（实现 `projectKey` 与宿主
  `dsh-session-persistence-jsonl` 的分支对齐，已由 t2 测过，我复核了 `--home-u-Desktop-DSHWorkspace--` 形态）。
- **`categories` 恒 4 条且顺序固定** `instructions→skills→tools→mcp`；空类也出现；8 个字段名一致；
  `observableUsage` 只在 tools/mcp 为 true；`mechanismCalls` 只在 skills 非 null。
- **`items` 字段名 + 顺序**：只出现 §2.4 的 13 个冻结名，且顺序即契约顺序；
  输入期的 `observedCalls`/`callsByName` **不会**漏进产物（已断言）。
- **`usageBasis` 全集 4 值**；赋值优先级（instructions→skills→名字护栏→无证据→tool-calls）逐分支验证。
- **硬规则**：`calls===null ⟹ tokensPerCall===null 且 zeroCall===null`；
  `calls===0 ⟹ zeroCall===true 且 tokensPerCall===null`；`calls>0 ⟹ zeroCall===false`。
- **§2.7 排序**：我按 DESIGN 文字**独立实现了一遍比较器**再与实现输出比对 → 顺序一致（含 rank 划分与 `id` 兜底）。
- **恒 4 条 + 显式失败**：四类之外的 category 会 `throw`（不静默漏报），比 §2.3 的字面要求更严。
- **`totals` 8 键**、**`findings` 2 键 + 记录字段名与 §2.5 一致**。
- **确定性**：同一输入两次，除 `generatedAt` 外逐字节相同。
- **`clampSessions`**：`undefined/0/负数/非数字 → 20`，`201/1e9 → 200`，`1 → 1`。
- **HTTP 路由**：恰好 1 条，`kind="exact"`、`path="/api/context-ledger/ledger"`；非 GET → 405
  `{ok:false,error:"method-not-allowed"}`；60s 内两次 GET 返回同一 `generatedAt`（内存缓存生效）；
  路由**只**在 `ctx.inject(['webServer'])` 里注册（headless 自动跳过）。
- **模型工具签名（§2.10）**：`name="context_ledger"`；参数只有 `sessions`（object schema 的 integer）；
  `description` 与 §2.10 冻结英文文本**逐字节相同**（我把它当作字面量断言，不信任自述）；
  `output.schema` 顶层 11 键、`additionalProperties:false`，`items`/`categories` 子 schema 同样收紧，
  `usageBasis`/`category` 枚举冻结，`calls`/`zeroCall` 为 nullable。
- **面板文案键（§4.5）**：zh/en 各 **33 键**，键集与 §4.5 冻结清单**完全相等**，zh/en 同键；
  命名空间 `context-ledger`、API 路径、`DETAIL_LIMIT=6`、`CATEGORY_ORDER` 一致。
- **三状态视觉硬区分（§4.4）**：`calls=0 & zeroCall=true → "zero"`；
  `calls=null & unobservable → "unknown"`；`calls=null & always-on → "unknown"`；
  `calls=null & no-evidence → "no-evidence"`；`calls>0 → "used"`。四状态两两不同，
  **`calls===null` 绝不映射成 `zero`**，chip 配色也不同。降级态 `observableTokensPerCall=null`
  在总览里显示为 `cl.unknown`（不是 0）。明细 `>6` 行折叠为 `{shown:6, hidden:N}`。
- **占比除零保护（§5）**：`shareOf(10, 0) → null`（不画条）；`shareOf(10, 40) → 0.25`（0..1 分数）。

---

## 5. 只读性 —— ✅ 通过

**静态扫描**（`index.js` / `lib/**` / `client.js`）：

```
$ grep -rn "writeFile|appendFile|createWriteStream|mkdir|unlink|rmSync|rmdir|rename|copyFile|chmod|truncate|fs.write|exec(|execSync|eval(|new Function" index.js lib/ client.js
（无写文件/执行 API；仅 truncated 变量名等假阳性）
$ grep -rn "spawn" index.js lib/ client.js
index.js:14:import { spawn } from 'node:child_process'
index.js:175:  const child = isZstd ? spawn('zstd', ['-dc', logPath], { stdio: ['ignore','pipe','ignore'] }) : null
$ grep -rn "fetch(|http.request|https.request|net.|dns.|XMLHttpRequest|WebSocket|EventSource" index.js lib/ client.js
client.js:800:        fetch(url, ...)
$ grep -n "LEDGER_API =" client.js
147:    var LEDGER_API = '/api/context-ledger/ledger'
```

- **不写文件**：无任何写 API。
- **不执行被审计对象**：唯一子进程是 `zstd -dc <logPath>`，参数数组传参（无 shell）、只读解压；
  未 `eval`/`new Function`/动态 `require`。
- **无对外网络**：唯一 `fetch` 目标是**同源相对路径** `/api/context-ledger/ledger`；无轮询、
  无 `localStorage`/`sessionStorage`/`document.cookie`/`postMessage`/indexedDB。
- **HTTP 缓存只在内存**：`const cache = new Map()`（`index.js:508`），TTL 60000ms，上限 32 条，
  失败即 `cache.delete` 允许重试；无落盘。

**运行时文件系统差分**（快照 `相对路径|字节数|mtime`）：

```
[model-tool.mjs]
  isolated home: created files = []
  isolated home: modified files = []
  isolated home: removed files = []
  ~/.dsh (real): created = []
  ~/.dsh (real): modified = []
```

**插件自带测试套件跑完后的真实 home 差分**（单次命令内前后快照，6831 个条目）：

```
$ node --test  →  ℹ tests 79 / ℹ pass 79 / ℹ fail 0 / exit=0
=== ~/.dsh diff（应无）===
IDENTICAL — 无任何文件新增/修改/删除
```

---

## 6. 隔离性 —— ✅ 通过

```
$ ls ~/.dsh/profiles/
web                         ← 仍只有 web（mtime 2026-09-28 21:21，本次未变）
$ ls .feas/isolated-home/profiles/
testbed                     ← 工作区内的隔离 profile
```

**全部 `dsh` 调用都显式设置 `DSH_HOME=/home/u/Desktop/DSHWorkspace/.feas/isolated-home`。**
重定向生效的正面证据：隔离 home 里出现了 dsh 才写的状态目录
（`.anonymous-user-id`、`.credentials.yaml`、`storages/workspace.json`、`profiles/testbed`），
而真实 `~/.dsh` 顶层没有新增这些内容。

```
$ ls ~/.dsh/sessions/--home-u-Desktop-DSHWorkspace--/ | wc -l
39                          ← 真实日志数量未变（只读回放）
```

**一处需要说明、但不是违规的现象**：`~/.dsh/dsh-usage` 的 mtime 在本轮期间有更新。
这是**承载本会话的 DSH Harness 自身**在产生模型流量时写的（我是它的子会话），
不是插件、也不是我的核验命令写的——佐证：插件测试套件跑完后 6831 个条目 **diff 完全相同**，
且我的每次 dsh 调用都指向隔离 home。此处点明，避免被误读为隔离失败。

**进程收尾**：两次 web 服务（端口 35635 / 38949）均已终止，端口拒绝连接、无残留进程、
无监听 socket、无遗留常驻服务。工作区内的临时符号链接已删除。

---

## 7. 范围红线 —— ✅ 通过

```
$ grep -rniE "jaccard|levenshtein|cosine|similarit|semantic|embedding|shingle|duplicate|重复段落|相似度|遮蔽|skillBody|SKILL\.md|bodyToken|trend|趋势|sparkline|chartJS|recharts" index.js lib/ client.js
(none)
$ grep -rniE "npm publish|git push|github\.com|api\.github|npm dist-tag|NPM_TOKEN" index.js lib/ client.js package.json cordis.patch.yml
(none)
$ node -e "...package.json..." 
dependencies: null        optionalDependencies: null
peerDependencies: {"@deepseek-ai/cordis":"^4.0.1","@deepseek-ai/dsh-tools":">=0.2.0-rc.2"}
$ grep -rn "@deepseek-ai" lib/
（仅出现在 4 个文件的「不得 import」注释里；无实际 import）
$ git remote -v            → (空，无远端 → 不可能推送 GitHub)
$ git log --oneline -1     → a70a237 feat: dsh-context-ledger v0.1.0 — 成本×使用对账（22 文件）
$ git status --short       → (干净)
```

- 未做重复段落检测、语义相似度、同名技能遮蔽。
- 未做技能正文 token 统计：`lib/cost.js:149-170` 的 `skillItems` 只取 `name`/`description`/`whenToUse`
  （catalog 条目文本），**不读技能正文**（无 `body`/`SKILL.md`/文件读取）。
- 未做跨会话趋势图表（无图表库、无 trend 关键词）。
- 未推送 GitHub（无远端）、未 npm publish（`"private": true`，且 `lib/**` 零第三方运行时依赖）。
- `lib/**` 无宿主依赖，宿主依赖只在 `index.js:19` 一处（`@deepseek-ai/dsh-tools`），符合 BRIEF。

---

## 8. 验证方自身的错误（更正记录，保留不掩盖）

我最初写错了 9 条期望值，全部**由我自己定位为「验证脚本的错」而非「实现的错」**，并更正后重跑：

| # | 我的错误期望 | 实际（正确） | 结论 |
|---|---|---|---|
| 1 | N2 期望 `scope.toolCalls=0` | 我给了与 `sessionsScanned=0` 矛盾的 `callsByName` | 我的输入不自洽（见 §9-F3 观测） |
| 2 | N7 期望 topPerUse 顺序 `["M","tools_hit"]` | `tools_hit 40/2=20 > M 60/7=8.57` | 我算错了比值 |
| 3 | F2 期望 gatherLedger 项顺序 | 应比较按 id 取值的映射，不比较数组顺序 | 我的断言写法错 |
| 4 | C5 期望 basis 数组顺序 | 应排序后比较集合 | 我的断言写法错 |
| 5 | §2.9 `scope.toolCalls=141` | 我漏把 `callsUnmatched` 的 4 次（`context_audit` 3 + `mcp__oldserver__ping` 1）放进 `callsByName` | 我的输入不完整 |
| 6 | 降级态渲染第 4 行 | 空清单时只有 4 行，header 在 index 2 | 我行号算错 |
| 7 | `itemState(calls>0)` 期望 `"ok"` | 实际是 `"used"` | 我猜错了状态名 |
| 8 | `foldRows` 期望 `.rows`/`.visible` | 实际是 `.shown`/`.hidden` | 我猜错了返回键名 |
| 9 | `shareOf(10,40)` 期望 25 | 实际 0.25（0..1 分数，DESIGN §5 就是分数） | 我混用了百分比 |

这 9 条的更正**没有**放宽任何判据：改的是我的期望值，不是断言强度。

---

## 9. 非阻断观测（5 项）

### F1 · 「与 §2.11 逐字节相同」的表述不准确（文档/自述层面，非缺陷）
DESIGN §2.11 是**节选**：它给了 3 行零调用项，却只给 2 行 topPerUse，而 `findings.topPerUse`
上限是 10。实现会渲染全部 topPerUse 行（§2.9 数据下 12 行 vs 节选 9 行）。
我逐行核对了冻结模板：**每行都符合 §2.11 模板，首 8 行与末行逐字节相同**。
→ 实现正确；t2 报告里「renderLedger 输出与 §2.11 冻结文本逐字节相同」在完整输出上不成立，
应表述为「与 §2.11 模板逐行一致、与节选部分逐字节相同」。**不影响通过。**

### F2 · `?cwd=` 诊断通道在无 agent scope 时成本侧退化（低）
DESIGN §4.1 声明的路由是 `?session=<id>&sessions=<n>`；`?cwd=` 是实现自加的诊断旋钮。
只给 `?cwd=` 时 `agent` 为 `undefined` → `ctx.tools.schemas()` 取 DSH 的**全局视图**。
实测（隔离 home，真实日志经符号链接）：

```
usage 半区完整: sessionsAvailable=39 sessionsScanned=20 linesRead=11266 toolCalls=1978
成本半区退化:   items.length=1（仅 context_ledger 95 tokens）、skills 0、instructions 0、mcp 0
totals: {residentTokens:95, observableTokens:0, unknownUsageTokens:95, observedCalls:0, observableTokensPerCall:null}
```

DSH 侧的根据（只读核对）：`dsh-tools/lib/index.js:3020-3025` 注释明确
`@param scope - the viewing scope (the agent); omitted = the global view`；
DSH 自己的惯用法是 `registry.schemas(exec.agent)`（同文件 1402 行）与
`exec.agent?.session.header.cwd`（1423 行）。

**判断**：这不是契约违背——DESIGN 的面板路径是 `?session=`，模型工具路径传 `exec.agent`；
且该次报告正确地降级为 `usageAvailable=false` 形态的诚实状态，**没有**伪造零调用。
**建议（可选，非必须）**：`?cwd=` 分支在无 agent 时，把 `costSide` 的退化在 `scope` 里显式告知，
或直接改用「必须 session」；DESIGN v2 可顺带记录该旋钮的语义。

### F3 · F2 多通道在**矛盾输入**下的行为（低，v2 待办范围内）
`sessionsScanned=0` 却给了非空 `callsByName` 时：

```
item.calls=null usageBasis=no-evidence zeroCall=null   ← 诚实（不假零调用）
scope.toolCalls=4  callsUnmatched=4  usageAvailable=false
totals.observedCalls=0
```

即 `scope.toolCalls` 报了 4，而所有 item 都声明「无证据」。
**宿主通路不可能产生这种组合**（`gatherLedger` 只把成功回放的会话计入 `callsByName`，
`callsByName` 非空 ⟹ `sessionsScanned>=1`），所以这不是可触达缺陷。
**关键安全性质仍成立**：不产生假零调用、`findings.zeroCall` 仍为 `[]`（已断言）。
→ 归入队长已记录的 F2 / DESIGN v2「输入通道收敛」待办。

### F4 · 同类内混入不可观测项会让整类 `calls` 变 null（低，信息性）
`lib/reconcile.js:337-339`：只有当**该类每一项** `calls !== null` 时，类级 `calls` 才是数字之和，
否则为 `null`。实测（N3）：tools 类含一个名字没过护栏的项时 `categories.tools.calls=null`，
而 `totals.observedCalls` 仍是数字。DESIGN §2.3 的措辞「该类逐项调用次数之和；该类无逐项次数则为 null」
对这种部分可观测态没有唯一读法，且会让 §2.9 的恒等式
`observedCalls = categories.tools.calls + categories.mcp.calls` 在该态下不可按数字读。
**安全性无问题**（是 `null` 不是 `0`，绝不伪造零调用），且只有常驻项名字不过护栏时才可达
（DESIGN §3.3 称「理论上不该发生」）。→ 建议 DESIGN v2 补一句定论。

### F5 · `formatBytes` 返回类型
`lib/tokens.js:62-67` 返回展示字符串（如 `"1.2 KB"`），DESIGN §7 写成 `number`。
与 IMPLEMENTATION-NOTES F3 的裁定一致（设计笔误），确认放行。

---

## 10. 覆盖缺口（如实标注）

**`?session=` 的 agent 解析路径没有端到端证据，只有静态 API 符合性证据。**

- 我验证了 `?cwd=` 路径（HTTP 200，usage 半区完整）与模型工具路径传 `exec.agent` 的写法；
  但**没能**在真实 web 宿主里用一个真实会话 ID 触发 `agents.get(sessionId)` +
  `sessions.get(sessionId).header.cwd` 的完整链路。
- 原因：隔离 `DSH_HOME` 里没有活动会话（要产生会话需要真实模型回合），
  而我**不能**用真实 `~/.dsh` 托管 web 服务（纪律禁止触碰 `~/.dsh/**`）。
- 我做到的静态符合性核查（一手 file:line）：
  - `dsh-agent/lib/index.js:332` — `super(ctx, "agents")`（服务键存在）；
  - `dsh-session/lib/index.js:1621` — `super(ctx, "sessions")`；`1861` — `SessionStore.get(id)`；
    `1699-1709` — `header.cwd` 来自 `meta.cwd`；
  - `dsh-tools/lib/types/index.d.ts:228` — 工具执行上下文含 `/** The agent on whose behalf the call runs */`；
    `dsh-tools/lib/index.js:1402` — DSH 自身用 `registry.schemas(exec.agent)` 作 scope；
    `dsh-tools/lib/index.js:1423` — DSH 自身用 `exec.agent?.session.header.cwd` 取 cwd；
  - `dsh-skill/lib/index.js:224-234` — `list(options)` 的 `options.scope` 选 viewing agent 层
    （插件调用形态 `{cwd, signal, scope}` 合法）；
  - `--dump-config` 确认该 profile 已加载 `@deepseek-ai/dsh-agent`（line 46）与
    `@deepseek-ai/dsh-session`（line 20）→ 两个服务在真实 web host 中都在。
- **建议**：请队长在**普通（非隔离）`dsh web` 会话**里打开面板一次（或让真实会话里的 agent
  调用一次 `context_ledger` 工具），确认四类条目非空。这属于我纪律边界之外的确认动作。
- 另：真实会话日志下的「零调用清单」（t2 报的 34 项 / 4320 tokens）我**没有**逐字复现——
  该数字依赖当时选中的 20 个会话，而本会话自身在持续产生新日志。
  我复现的是**方法与量级**：真实栈 20 会话 → 1978 次 tool/call、namesRejected=0、
  usage 半区各恒等式成立（见 §3、§4）。

---

## 11. 复现方式

全部核验脚本与原始输出在本仓库外的工作区目录 `.feas/t4-verify/`：

| 文件 | 内容 | 断言数 |
|---|---|---|
| `privacy-independent.mjs` | 隐私：真实日志语料 + 哨兵 + 差分 + 护栏 + S3/charclass/溯源 | 指标见 §1 |
| `numbers-independent.mjs` | 已知答案数值核验（N1–N12） | 262 / 0 fail |
| `f1-f2-contract.mjs` | F1 id 血统 + F2 多通道 + 契约一致性 | 84 / 0 fail |
| `model-tool.mjs` | 模型工具签名 + 路由 + 只读快照差分 | 31 / 0 fail |
| `render-frozen.mjs` | §2.9 重放 + §2.11 模板逐行核对 | 39 / 0 fail |
| `client-mapping.mjs` | 客户端词典/三状态/折叠/占比 | 23 / 0 fail |
| `client-bundle-exec.mjs` | 宿主服务出的 bundle 真机执行 | 11 / 0 fail |
| `whitelist-adversarial.mjs` | F1 白名单 id 规则对抗 | 28 / 0 fail |
| `boot-parse.mjs` / `design-excerpt-compare.mjs` | 启动图解析 / §2.11 逐字节比对 | — |
| `logs/` | 上述每次执行的完整原始输出 | — |

**合计 478 条独立断言，0 失败。**

复现命令（任选）：

```sh
cd /home/u/Desktop/DSHWorkspace/.feas/t4-verify
node privacy-independent.mjs          # 读 ~/.dsh/sessions（只读）
node numbers-independent.mjs
node f1-f2-contract.mjs
node render-frozen.mjs
node client-mapping.mjs
node whitelist-adversarial.mjs
DSH_HOME=/home/u/Desktop/DSHWorkspace/.feas/t4-verify/f1-home node model-tool.mjs
node boot-parse.mjs && node client-bundle-exec.mjs   # 需先跑过 §3 的启动步骤
```

---

## 12. 最终判定

| 核验项 | 结论 | 阻断性发现 |
|---|---|---|
| 1 隐私红线 | 通过 | 无 |
| 2 数值正确性 | 通过 | 无 |
| 3 客户端真实启动图 | 通过 | 无 |
| 4 契约一致性 | 通过 | 无 |
| 5 只读性 | 通过 | 无 |
| 6 隔离性 | 通过 | 无 |
| 7 范围红线 | 通过 | 无 |
| F1（S3 id 规则安全论据） | **论据成立**（§13） | 无 |
| F2（多通道一致性） | **三条目标字段一致**（§13） | 无 |
| F3（formatBytes 笔误） | 确认放行 | 无 |

**结论：验证通过（pass）。** 无阻断性发现，无隐私越线。5 项非阻断观测与 1 项覆盖缺口
（§9、§10）建议纳入 DESIGN v2 与后续回归，不构成本次不通过理由。

---

## 13. 对 IMPLEMENTATION-NOTES F1/F2/F3 的独立裁定

### F1 —— 队长裁定「接受，但验证线必须独立确认它没开出漏洞」→ **论据成立，无漏洞**

我按队长要求**实际验证了论据本身，而不是接受陈述**：

**(a) 血统验证（直接）**：用假的 `ctx`（声明侧工具/技能/指令）+ 一个带恶意工具名的真实
`.jsonl.zstd` 会话日志（自己用 `zstd` 压进**工作区内**的 scratch DSH_HOME）跑真实宿主入口
`gatherLedger`：

```
items=[{"id":"tools:never_called_decl_tool",...},{"id":"mcp:mcp__srv__real",...},{"id":"tools:bash",...},
       {"id":"skills:decl-skill",...},{"id":"instructions:/home/u/.../f1-proj/AGENTS.md",...}]
```

日志侧注入的哨兵结果：

| 哨兵 | 放在哪 | 是否出现在产物 |
|---|---|---|
| `SENTINEL BAD 8f3a`（含空格） | `data.name` | **否**（被护栏拒收，`namesRejected+1`） |
| `中文名带正文-8f3a` | `data.name` | **否** |
| 300 字符超长名 | `data.name` | **否** |
| `ARG-SENTINEL-8f3a` | `data.arguments` | **否** |
| `RESULT-SENTINEL-8f3a` | `tool/result.data.message` | **否** |
| `USER-SENTINEL-8f3a` | `user/message.data.content` | **否** |
| `ASSISTANT-SENTINEL-8f3a` | `assistant/message.data.message` | **否** |
| `TITLE-SENTINEL-8f3a` | `session/title.data.title` | **否** |
| `SENTINELTOOLPASS8f3a`（合法名） | `data.name` | **出现 1 次**，且只在 `scope.callsUnmatchedNames`——这是 §2.2 明确允许的「仅工具名」面 |

```
check('F1', 'namesRejected counts 3 rejected names', report.scope.namesRejected, 3)          → 通过
check('F1', 'legal sentinel occurs exactly once (unmatched list)', sentinelOutsideAllowed, 1) → 通过
check('F1', 'name is declaration-side', declNames.has(it.name), true)  对每个 item → 通过
check('F1', 'id === category:name', it.id, `${it.category}:${it.name}`) 对每个 item → 通过
```

**(b) 静态血统链**：
`index.js:382-386` 的 `items` 只来自 `instructionItems()/skillItems()/toolItems()`
（`lib/cost.js`，入参是声明数据）；`index.js:421-439` 把日志计数折进 `callsByName`，**从不写回 items**；
`lib/reconcile.js:252` 的 `id` 由 `category` + `name` 推导，而 `name = raw.name` 来自调用方（声明侧）。
日志侧唯一能进入产物的字符串是 `scope.callsUnmatchedNames`，且强制过 `NAME_PATTERN`。

**(c) 白名单 id 规则对抗**（`whitelist-adversarial.mjs`，28/0）：

```
应当被拒： "tools:中文名"→false  "tools:name with space"→false  "tools:a\"b"→false
          "tools:a\nb"→false  "<script>x</script>"→false  "tools:"+"a".repeat(200)→false
          "mcp:汉字"→false  "LEAK-PAYLOAD-8f3a=body text"→false  "tools:a\\b"→false  "tools:a\tb"→false
应当被接受："tools:bash"→true  "mcp:mcp__openviking__find"→true
          "instructions:/home/.../AGENTS.md"→true  "context_ledger"→true  "--home-…--"→true
关键判据：id 的 name 部分**仍必须**过 NAME_PATTERN 或为绝对路径 → 该补充规则没有放宽字符集
```

**裁定：接受成立。** `id` 的两个组成部分确实只来自声明侧，日志载荷无法污染任何一部分；
补充规则只是把「`category` + `:`」从护栏管辖范围里摘出去，name 部分仍受同一道 `NAME_PATTERN` 约束。

### F2 —— 队长要求「确认多通道不会导致行为分歧」→ **目标字段一致，无分歧**

同一份数据（`alpha: 4 次`、`gamma: 0 次`）从 4 条通道传入：

| 通道 | 传法 |
|---|---|
| A | 顶层 `callsByName` |
| B | `scope.callsByName` |
| C | `item.observedCalls` |
| D | `item.calls` |

```
check('F2', 'channel A vs B/C/D : calls/tokensPerCall/zeroCall', trio(r), trio(chanA))  → 全部通过
check('F2', 'channel A vs B/C/D : categories', ...)  → 通过
check('F2', 'channel A vs B/C/D : totals', ...)      → 通过
check('F2', 'channel A vs B/C/D : findings', ...)    → 通过
check('F2', 'channel A vs B/C/D : scope.toolCalls', ...)        → 通过（四通道都是 4）
check('F2', 'channel A vs B/C/D : scope.callsUnmatched', ...)   → 通过（四通道都是 0）
check('F2', 'channel A vs B : whole report byte-identical (excl generatedAt)', norm(chanB), norm(chanA)) → 通过
```

**队长点名的三条字段（`calls` / `tokensPerCall` / `zeroCall`）在四条通道下完全一致**，
`categories` / `totals` / `findings` / `scope.toolCalls` / `scope.callsUnmatched` 也一致。

**残留（信息性，已并入 §9-F3）**：`scope.callsUnmatchedNames` 在 item 级通道（C/D）下无法表达
（`[]`），因为该通道本身不携带「未匹配名字」信息——这是通道表达力差异，不是行为分歧；
另一种矛盾输入（`sessionsScanned=0` + 非空 `callsByName`）让 `scope.toolCalls` 与 item 声明不一致，
但宿主通路不可达，且不产生假零调用。两条都支持队长的 DESIGN v2「收敛为单一通道」结论。

### F3 —— 确认放行
`lib/tokens.js:62-67` 返回字符串，DESIGN §7 的 `number` 确为笔误。与裁定一致，无异议。
