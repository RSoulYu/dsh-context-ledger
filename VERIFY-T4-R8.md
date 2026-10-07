# dsh-context-ledger — t4 独立复核报告（R8 宿主半区 / DESIGN v4）

> 复核人：验证（AgentTeams 成员）
> 任务：`t4 [review, round 7]` · kind=review（绑定 **t2**）· attempt `5d8d771e-e285-49d3-ab27-7b67e44bb3fb`
> 复核对象：`index.js` · `lib/reconcile.js`（宿主半区 = R8 三态调用口径 + 窗口边界显式化）
> 契约基准：`DESIGN.md` **v4**（§2.2 W1–W6 / §2.4 字段表与三态赋值表 / §2.5 / §2.6 / §2.26.1–§2.26.6 / §3.1 / §3.8 / §7.1 / §7.2 / §9.2）
> 基线：`git HEAD = 3f8daf7`（`LEDGER_VERSION = 3`，无 `currentSession` / `sessionCoverage` 通道）
> 方法基准：`VERIFY-T19.md` 的 A/B 反证法（证明"严格超集、无语义漂移"，而不是"又跑绿了"）
> 纪律：**未修改任何实现/测试/DESIGN/package.json 文件**；未触碰 `/opt/dsh/node_modules/@deepseek-ai/dsh/**` 与 `~/.dsh/**`
> （真机复验只读，见 §7）；复核脚本与合成夹具全部落在我自己的目录 `.t4-verify/`。

---

## 0. 结论

**verdict = pass（未通过项：无）**

| # | 验收项 | 结论 | 决定性证据 |
|---|---|---|---|
| 1 | **"不知道"与"0"严格可分（最高优先）** | ✅ | 构造输入 3 类（窗口外 / 无身份 / 日志不可读）逐项 `currentSessionCalls === null`、`callPresence === null`、`totals.currentSessionObservedCalls === null`，且原始 JSON **不含 `"currentSessionCalls":0`**；可得输入给出真数字；真机复验同结论（§2、§7） |
| 2 | **两条路径各自独立验证** | ✅ | 模型工具路径经 `apply()` 注册的真实 tool definition 执行（`basis=agent-session-id`）；HTTP 路径经 `makeLedgerRoutes()` 真实 handler（`basis=http-session-param`，拿到/拿不到 agent 两种都验）；各自都验了"可得给真数字 / 不可得给 null"（§3） |
| 3 | **不新增读取通道** | ✅ | `lib/usage.js` 与 v3 基线 **sha256 逐字节相同**（`111f721e…`）；代码区叶子字段读取恰好 `record.type` + `data.name`；新增行无任何读盘/时间戳/正文/`arguments` 命中；S1/S2 哨兵与载荷不变性通过（§4） |
| 4 | **覆盖会话数与总计数同源** | ✅ | `index.js` 只有**一个** `readSessionUsage` 调用点（`:909`），`counts`/`coverage`/`currentSessionCounts` 只在该循环内写（`:921/:922/:924`）；**动态**用 `zstd` PATH 替身计数：每个被扫描日志恰好 spawn 1 次，窗口外日志 0 次；自建已知答案夹具逐项对表（§5） |
| 5 | **`zeroCall` 语义未变（零漂移）** | ✅ | A/B：v3（`git HEAD` 的 lib 副本）vs v4，**200 组随机输入**剥离 v4 字段后**逐字段零差异**；`findings.zeroCall` / `prunePlan` / `hidePlan` / 逐项 `calls·zeroCall·usageBasis·tokensPerCall` 完全一致；`renderLedger` 段与 v3 **字节级相同**（§6） |
| 6 | **窗口边界不再恒为 null + 受 `sessions` 与上限约束** | ✅ | W1–W6 全绿；`sessionsScanned=0` ⇒ 边界 `null` 且 `usageAvailable=false`；`sessions=1/3/200` 实测；`clampSessions` 越界夹取（§6.3） |
| 7 | **不凭单次全绿判过 / 三态确定性证明** | ✅ | 全量 `node --test` **10 + 12 + 10 次**逐次记录（31 次绿；唯一 1 次红已按 hash 变化归因为 t6 并发编辑中间态）；三态用 7 行判定表 + 62 个宿主可达组合扫描 + 288 组合"绝不造 0" + 同一输入 30 次逐字节相同（§8、§9） |
| 8 | **断言强度未被放宽** | ✅ | 删除的 9 条断言**全部有同类替换**（`version 3 → 4`、键集 `V3_KEYS → +V4_KEYS`）；未新增 `hostSkip` 之外的 skip/todo；未新增近似/容差断言；六个测试文件用例数与断言点数**只增不减**（§10） |
| 9 | **`version` 为 4** | ✅ | 产物 `version === 4`；出厂 `output.schema.properties.version.const === 4`（§8.5） |
| 10 | **范围核实：仅 `index.js` / `lib/**` / `test/**`** | ✅ | `git status` 改动集 = 11 个文件 + `.feas/`；`package.json`/`cordis.patch.yml`/`README.md`/`CHANGELOG.md`/`LICENSE`/`lib/usage·cost·provide·hide·tokens.js` 全部**不在改动集**（§10.4） |

自我审计脚本：**`.t4-verify/harness1.mjs` 154 通过 / 0 失败**、**`harness2.mjs` 75 通过 / 0 失败**、**`harness3.mjs`（真机只读）15 通过 / 0 失败**；合计 **244 / 0**。

证据快照（复核全程）：

| 文件 | sha256 | 复核期间是否变化 |
|---|---|---|
| `index.js` | `5963b702a8ad84c4…` | **否**（开工到收工一致） |
| `lib/reconcile.js` | `70ba107801a1d4ef…` | **否** |
| `lib/usage.js` | `111f721e450da643…` | **否**（且 = v3 基线） |
| `client.js` | `7e1ea38326f2af0e…` | 否（属 t3 面板线） |
| `test/client-panel.test.mjs` | `74a33aea…` → 期间被 **t6** 改动 | 是（t6 在飞，见 §10.5） |
| `DESIGN.md` | `9fe74847…` → 期间被 **t6** 改动 | 是（t6 只动 §2.21/A18） |

---

## 1. 复核基线与方法

- **基线固定**：`git show HEAD:lib/*.js` 全部导出到 `.t4-verify/baseline-v3/lib/`（`LEDGER_VERSION = 3`，`grep -c "currentSession\|sessionCoverage"` = 0），作为 A/B 的"旧版"，与工作区版本在**同一份输入**上对拍。
- **不复用实现方夹具**：三个 harness 的合成日志、虚拟 `fs`/`skills`/`tools`（与宿主同形）、HTTP `req/res`、断言全部由我自建；只调用产物的公开导出（`apply` / `gatherLedger` / `makeLedgerRoutes` / `reconcile` / `renderLedger` / `resolveCurrentSessionId` / `clampSessions`）。
- **合成夹具的答案表手算**（§5.1），实现方 test/ 下的任何期望值都不是我的判据来源。

执行入口：

```sh
cd /home/u/Desktop/DSHWorkspace/.t4-verify
node harness1.mjs   # 三态/未知≠0/两条路径/窗口边界/覆盖会话数
node harness2.mjs   # 判定表+全组合扫描/确定性/隐私读取面/单次读取/A-B/出厂 schema/断言强度/范围
node harness3.mjs   # 真机只读复验（~/.dsh/sessions 只读）
```

---

## 2. 最高优先项：「不知道」绝不写成 0

### 2.1 构造夹具（我自己造）

`cwd = /home/u/Desktop/DSHWorkspace/dsh-context-ledger`；4 个会话，mtime 由旧到新：`cur-session`（toolA×3, toolC×1）、`session-b`（toolA×2, toolB×1）、`session-c`（toolB×4）、`session-d`（toolA×1）；`toolZ` 是常驻工具项但**任何日志里都没出现**。

```sh
$ node harness1.mjs
=== 1 · 最高优先：当前会话不在窗口内 ⇒ null（不是 0）  [sessions=3, cur-session 最旧] ===
  scope.currentSession = {"id":"cur-session","basis":"agent-session-id","inWindow":false}
  toolA: calls=3 currentSessionCalls=null sessionsWithCalls=2 callPresence=null zeroCall=false
  toolB: calls=5 currentSessionCalls=null sessionsWithCalls=2 callPresence=null zeroCall=false
  toolC: calls=0 currentSessionCalls=null sessionsWithCalls=0 callPresence=null zeroCall=true
  totals = {"observedCalls":8,"currentSessionObservedCalls":null}
  [PASS] U1-identity :: {"id":"cur-session",…,"inWindow":false} === 同
  [PASS] U1-toolC-zeroCall-true :: true === true
  [PASS] U1-raw-no-zero-currentSessionCalls :: raw.includes('"currentSessionCalls":0') = false
  [PASS] U1-raw-has-null-currentSessionCalls :: 含 null 形式
```

**判据**：`inWindow=false` 时逐项 `currentSessionCalls === null`、`callPresence === null`、`totals.currentSessionObservedCalls === null`；**同时**窗口口径照常给出真数字（`toolA.calls=3`、`toolB.sessionsWithCalls=2`）；整份 JSON 里**不存在** `"currentSessionCalls":0`。
→ 实现位置：`index.js:932-938`（`inWindow` 与 `null` 通道）、`lib/reconcile.js:366-382`。

### 2.2 三类"不可得"分别构造

```sh
# (a) 无身份（无 agent / 无 ?session=）
[R3] currentSession = {"id":null,"basis":"unavailable","inWindow":false} ；totals = {"observedCalls":564,"currentSessionObservedCalls":null}
[PASS] R3-逐项 null / R3-raw 无 "currentSessionCalls":0

# (b) 身份可得但本会话日志不可读（坏 zstd）
$ node harness1.mjs
=== 4 · 当前会话日志不可读（坏 zstd）⇒ inWindow false + 逐项 null（不是 0） ===
  scope = {"scanned":2,"unreadable":1,"outside":0,"start":"2026-10-01T00:01:00.000Z","cur":{"id":"cur-session","basis":"agent-session-id","inWindow":false}}
  toolA = {…,"calls":3,…,"currentSessionCalls":null,"sessionsWithCalls":2,"callPresence":null,…}
  [PASS] U3-identity-kept :: {"id":"cur-session","basis":"agent-session-id","inWindow":false}
  [PASS] U3-toolA-current-null :: null === null
  [PASS] U3-raw-no-zero :: 无 currentSessionCalls:0

# (c) 宿主未给通道（reconcile 直调，缺 sessionCoverage / currentSessionCallsByName）
[PASS] U6-no-channel-null :: [null,null,null,null] === [null,null,null,null]
[PASS] U6-no-channel-not-zero :: null 而非 0
```

**同一条硬规则的另一面（`{}` ≠ `null`）**：

```sh
[PASS] U6-empty-object-zero :: [0,0,0,"absent",true] === [0,0,0,"absent",true]
[PASS] U6-empty-totals-zero :: 0 === 0
```
`{}` = "已判定、确实一个都没有" ⇒ `0`；缺字段/`null` = "给不出" ⇒ `null`。与 §7.1 规则 6 逐字一致。

### 2.3 「0 也必须是真事实」（反向）

```sh
=== 2 · 当前会话在窗口内 ⇒ 真数字  [sessions=4] ===
  toolB: calls=5 currentSessionCalls=0  sessionsWithCalls=2 callPresence=historical-only zeroCall=false
  toolZ: calls=0 currentSessionCalls=0  sessionsWithCalls=0 callPresence=absent          zeroCall=true
  totals = {"observedCalls":12,"currentSessionObservedCalls":4}
  [PASS] U4-toolB-currentSessionCalls-0-is-real-zero :: 0 === 0
  [PASS] U4-historical-only不进zeroCall :: false === false
```

---

## 3. 两条路径各自独立验证（不推及）

| 路径 | 入口 | 实测 `scope.currentSession` | 可得时的数字 |
|---|---|---|---|
| **模型工具路径** | `apply(fakeCtx)` 注册出的真实 tool definition（`output.schema` + `execute`），`exec({sessions:4}, {agent:{session:{id:'cur-session'}}})` | `{"id":"cur-session","basis":"agent-session-id","inWindow":true}` | `toolA.currentSessionCalls=3`、`totals=4` |
| 模型路径·不可得 | 同上，`agent={session:{header:{cwd}}}`（宿主没给 session.id） | `{"id":null,"basis":"unavailable","inWindow":false}` | 逐项 `null`，raw 无 `currentSessionCalls:0` |
| 模型路径·无 agent | `exec({sessions:4}, {})` | `{"id":null,"basis":"unavailable","inWindow":false}` | 逐项 `null` |
| **HTTP 路由路径** | 真实 `makeLedgerRoutes()` 的 handler（假 `req/res`、假 `sessions.get`）；**未提供 `deps.agents`**（= 解析到 session 但拿不到 agent） | `{"id":"session-d","basis":"http-session-param","inWindow":true}` | `toolA.currentSessionCalls=1`、`toolZ.callPresence="absent"` |
| HTTP 路径·窗口外 | `?session=cur-session&sessions=3` | `{"id":"cur-session","basis":"http-session-param","inWindow":false}` | 逐项 `null`、`totals=null`、raw 无 `currentSessionCalls:0` |
| HTTP 路径·会话不存在 | `?session=nope` / 缺 `session` | `404 / 400` `{ok:false,error:"session-unresolved"}` | **不得**用降级报告顶替（§4.1） |

```sh
$ node harness1.mjs
  tool definition keys = ["name","description","parameters","output","execute"]
  [PASS] P1-agent-basis :: {"id":"cur-session","basis":"agent-session-id","inWindow":true} === 同
  [PASS] P1b-all-null :: 全部工具项 currentSessionCalls=null
  [PASS] P1c-no-agent :: {"id":null,"basis":"unavailable","inWindow":false} === 同
  [PASS] P2-route-basis-http :: {"id":"session-d","basis":"http-session-param","inWindow":true} === 同
  [PASS] P2b-route-outside-basis :: {"id":"cur-session","basis":"http-session-param","inWindow":false} === 同
  [PASS] P2c-route-404 :: [404,{"ok":false,"error":"session-unresolved"}] === 同
  [PASS] P2d-route-400 :: [400,{"ok":false,"error":"session-unresolved"}] === 同
```

**名称护栏（§3.8 第 3 条，隐私防线）**：`?session=evil id with spaces and 正文` ⇒ `{id:null,basis:"unavailable",inWindow:false}`，逐项 `null`，**脏字符串不出现在产物任何位置**。

```sh
  [PASS] P3-evil-id-unavailable :: {"id":null,"basis":"unavailable","inWindow":false} === 同
  [PASS] P3-evil-id-not-in-output :: 产物不含脏 id
  P4-both（优先级实测）= {"id":"session-d","basis":"http-session-param"}
```
> 非阻断观测 O1：两条来源同时存在时，实现以 `?session=` 优先（`index.js:118-121`）。DESIGN §2.2 未规定优先级；两来源在宿主通路中指向同一会话（路由把解析出的 id 与其 agent 一起传下），故我按"不构成缺陷"记录，仅作备案。

---

## 4. 不新增读取通道（逐条独立核对）

### 4.1 `lib/usage.js` 读取面：**零改动**（不采信 t2 自述）

```sh
$ sha256sum dsh-context-ledger/lib/usage.js .t4-verify/baseline-v3/lib/usage.js
111f721e450da6437dbe7ecb04f55c4a6c5037ac337d34b18dab05b5472ec4bf  …/lib/usage.js
111f721e450da6437dbe7ecb04f55c4a6c5037ac337d34b18dab05b5472ec4bf  …/baseline-v3/lib/usage.js
```
→ 与 `git HEAD` 的**同一份字节**。这是"读取面未扩张"的最强形式（不是"我读了代码觉得没变"）。

代码区（去注释）属性访问的全集：

```sh
$ node harness2.mjs
  lib/usage.js 代码区（去注释）的全部属性访问 = ["data.name","record.data","record.type"]
  [PASS] B3-usage.js 代码区叶子字段读取恰好两处 :: ["data.name","record.type"]
  [PASS] B3a-容器访问只有 record.data（无 record.* 其他字段） :: ["record.data","record.type"]
  [PASS] B3b-除 data.name / record.type / 容器 record.data 外全部只在注释里出现
```
（`record.data` 是 §3.1 第 3 步取 `data.name` 的必经容器导航，不是数据字段；文件注释里逐条列出 `data.arguments/callId/turn/step/message/content/title/text/meta/error/stream/usage/subCallId` —— 这些名字**只出现在注释**。）

### 4.2 新增行里有没有偷偷读别的字段 / 新开读盘

```sh
$ git diff -U0 -- index.js lib/reconcile.js | grep '^+' | grep -E 'data\.(arguments|callId|turn|step|message|content|title|text|meta|error|stream|usage)|\.time\b|timestamp|readFileSync|createReadStream|readdirSync|statSync'
  （无输出）
  [PASS] B4-新增行无实际读取面扩张（非注释命中=0） :: 0 === 0
```
窗口边界只来自**文件系统元数据**：`index.js:207-211`（`statSync(...).mtimeMs`）→ `:925-928` 取 min/max → `:957-960` 写成 ISO + `windowBasis="session-log-mtime"`。**没有任何**行内 `time` / `data.turn` / `data.step` 读取。

DESIGN §3.4 的两条强制 grep 也照跑：

```sh
$ grep -rn "arguments\|tool/result\|user/message" lib/usage.js   # 命中项全在注释里
[PASS] B5-§3.4 grep①：usage.js 命中项全在注释里 :: [] === []
$ grep -n "readFileSync\|readText" lib/provide.js
[PASS] B6-§3.4 grep②：provide.js 不自读盘 :: "" === ""
```

### 4.3 哨兵不可见 + 载荷不变性（S1/S2 我自己的版本）

合成日志把哨兵 `LEDGER-PRIVACY-SENTINEL-8f3a` 注入 `tool/call` 的 `time/arguments/callId/turn/step/message/content/title/text/meta/error/stream/usage`，以及 `tool/result`、`user/message`、`assistant/message`、`session/title`、`session/title-llm-request`、`request/header`、`request/context`、`tool/ptc-dispatch(-start)` 的全部载荷字段。

```sh
  [PASS] B1-哨兵不进 JSON :: includes = false
  [PASS] B1-哨兵不进 native 文本 :: includes = false
  [PASS] B1-toolA 计数 1 次（ptc-dispatch 不计） :: 1 === 1
  [PASS] B2-载荷不变性（A/B 逐字节相同） :: 两份产物（仅 generatedAt 归一）逐字节相同
```
（B2 = 把同一批载荷字段换成不同长度/字符集的垃圾，产物不变 ⇒ 产物只是白名单字段的函数。）

---

## 5. 覆盖会话数与总计数同源 + 已知答案

### 5.1 自建答案表（手算，实现方夹具不参与）

窗口 = `{cur-session, session-b, session-c, session-d}`（`sessions=4`）：

| 工具 | 逐会话真值 | `calls`（窗口总） | `sessionsWithCalls`（覆盖会话数） | `currentSessionCalls` | `callPresence` |
|---|---|---|---|---|---|
| `toolA` | cur×3, b×2, d×1 | **6** | **3** | **3** | `current-session` |
| `toolB` | b×1, c×4 | **5** | **2** | **0** | `historical-only` |
| `toolC` | cur×1 | **1** | **1** | **1** | `current-session` |
| `toolZ` | 无 | **0** | **0** | **0** | `absent` |

```sh
  [PASS] C-toolA-calls :: 6 === 6        [PASS] C-toolA-sessionsWithCalls :: 3 === 3
  [PASS] C-toolB-calls :: 5 === 5        [PASS] C-toolB-sessionsWithCalls :: 2 === 2   ← 4 次调用于同一会话只算 1 个会话
  [PASS] C-toolC-currentSessionCalls :: 1 === 1   [PASS] C-toolZ-sessionsWithCalls :: 0 === 0
  [PASS] C-同源-覆盖数≤会话数且与calls不相等（toolB: 5 次 2 会话）
```
恒等式抽样：`I5`（`currentSessionCalls ≤ calls`）、`I6a/I6b`（`sessionsWithCalls ≤ sessionsScanned`；`calls>0 ⇒ ≥1`；`calls=0 ⟺ =0`）、`I8`（`Σ currentSessionCalls`）、`I9`、`I4`、`I1`、`I2`、`I7`、`I10`、`I11` 全部逐项断言通过（`harness1` §2 共 30 余条）。

### 5.2 「同一次读取」的动态证明（zstd PATH 替身）

原理：`.zstd` 日志每次读取 = `spawn('zstd', ['-dc', <path>])` ⇒ 在 PATH 前置一个记录 `"$@"` 再 `exec /usr/bin/zstd` 的替身，即可**精确计数每个日志被打开几次**。

```sh
  C1 spawn 记录：
    -dc …/session-e/session.v1.jsonl.zstd
    -dc …/session-d/session.v1.jsonl.zstd
    -dc …/session-c/session.v1.jsonl.zstd
  [PASS] C1-每个被扫描日志恰好被打开 1 次 :: {…session-e…:1, …session-d…:1, …session-c…:1}
  [PASS] C1-被打开的文件数 = sessionsScanned :: 3 === 3
  [PASS] C1-当前会话计入 :: true === true
  C2 spawn 记录： ["session-e","session-d"]
  [PASS] C2-窗口外会话日志零打开 :: spawn 了 2 次，全部在窗口内
  [PASS] C2-总打开次数 = sessionsScanned :: 2 === 2
```

静态面：

```sh
$ grep -n "readSessionUsage(" index.js
236:export async function readSessionUsage(...)   # 定义
909:      usage = await readSessionUsage(entry.logPath, MAX_LINES_PER_SESSION, signal)   # 唯一调用点
$ grep -n "counts\.set\|coverage\.set\|currentSessionCounts" index.js
921: counts.set(...)   922: coverage.set(...)   924: currentSessionCounts = usage.callsByName   # 同一个循环内
```
→ **唯一读取路径 + 三个投影同循环**，与 §3.8 第 2 条、§7.1 规则 5 一致。

---

## 6. `zeroCall` 零漂移（A/B 反证）与窗口边界

### 6.1 A/B：v3 基线 vs v4，200 组随机输入

同一份输入（含 `items` 四类、随机 `callsByName`、`sessionsScanned ∈ {0,1,2,5}`、provenance、hide）喂两版；v4 产物剥离 v4 新增键后与 v3 逐字段比较（键序无关，仅 `generatedAt` 归一）：

```sh
  [PASS] D-既有字段零漂移（200 组随机输入，仅 generatedAt 归一） :: cases=200 既有字段差异=0
  [PASS] D-v3 忽略 v4 新通道 :: v3 基线自比差异=0      # 只加 v4 通道时 v3 产物完全不变 = 严格超集
  [PASS] D-native 文本零漂移 :: 差异=0                  # renderLedger(v4报告) 与 v3 渲染逐字符相同
  [PASS] D-version: v3=3 → v4=4 :: [3,4] === [3,4]
  [PASS] D-zeroCall 清单一致 :: 3 项 id/name/tokens 完全一致
  [PASS] D-zeroCall 逐项零漂移 :: [["mcp__s__t",0,true,"tool-calls",null],["a",0,true,"tool-calls",null],["c",0,true,"tool-calls",null],["b",3,false,"tool-calls",67],["/p/AGENTS.md",null,null,"always-on",null],["sk",null,null,"unobservable",null]] === 同
  [PASS] D-prunePlan 一致 :: [] === []
  [PASS] D-hidePlan 一致 :: 3 条完整对象逐字段相同
  [PASS] D-totals 一致（除新字段，键序无关）
```
`renderLedger` 段字节级证据（我另做的扇区 sha）：

```sh
renderLedger 段长度: 6666 6666 逐字节相同: true
sha256 v3: be701d77102655ee  /  sha256 v4: be701d77102655ee
```

### 6.2 窗口边界 W1–W6

```sh
  [PASS] W1 :: scanned=3 start=2026-10-01T00:01:00.000Z end=2026-10-01T00:03:00.000Z
  [PASS] W2-bounds-are-scanned-mtimes :: ["2026-10-01T00:01:00.000Z","2026-10-01T00:03:00.000Z"] === 同   # = 被回放会话的日志 mtime
  [PASS] W4-values :: [4,3,0,1] === [4,3,0,1]         # available = scanned + unreadable + outside
  [PASS] W5 :: 3+0 <= 3
  [PASS] W6 :: "session-log-mtime" === "session-log-mtime"
  空工作区 scope = {"scanned":0,"start":null,"end":null,"cur":{…,"inWindow":false},"available":false}
  [PASS] W3-null-bounds / W3-usageAvailable-false / W3-no-evidence-basis / W3-zeroCall-empty / W3-all-null
```
→ 与 §2.12 的降级态补充 ④⑤⑥ 逐字一致（身份仍非 null、`inWindow=false`、逐项 `null`、`totals=null`）。

### 6.3 窗口大小仍受 `sessions` 与上限约束

```sh
  [PASS] clamp-default :: 20    [PASS] clamp-0 :: 20    [PASS] clamp-neg :: 20
  [PASS] clamp-9999 :: 200      [PASS] clamp-1 :: 1     [PASS] clamp-round :: 3
  [PASS] limit-1-scanned :: 1   [PASS] limit-1-outside :: 3   [PASS] limit-1-toolA-calls :: 1
  [PASS] limit-200-scanned :: 4 [PASS] limit-200-limit :: 200 [PASS] limit-200-outside :: 0
```

---

## 7. 真机只读复验（`~/.dsh/sessions`，只读、零写入）

```sh
$ node harness3.mjs
  DSH_HOME = /home/u/.dsh （只读）
  会话总目录数 = 46 ；workspaceKey = --home-u-Desktop-DSHWorkspace--
  [R1] scope.currentSession = {"id":"session-4cb04600-…","basis":"agent-session-id","inWindow":true}
  [R1] 窗口 = {"available":46,"scanned":20,"outside":26,"start":"2026-10-06T02:11:58.916Z","end":"2026-10-07T13:19:13.029Z","basis":"session-log-mtime"}
  [R1] totals = {"observedCalls":2371,"currentSessionObservedCalls":361}
  [R1] context_ledger: calls=0 currentSessionCalls=0 sessionsWithCalls=0/20 presence=absent
  [R1] mcp__openviking__find: calls=1 currentSessionCalls=0 sessionsWithCalls=1/20 presence=historical-only
  [R1] read: calls=431 currentSessionCalls=12 sessionsWithCalls=17/20 presence=current-session
  [R1] bash: calls=1939 currentSessionCalls=349 sessionsWithCalls=18/20 presence=current-session
  [R2] 最旧会话 f1cacb7e-… ⇒ {"basis":"agent-session-id","inWindow":false}
  [R2] read: calls=73 currentSessionCalls=null sessionsWithCalls=3 presence=null zeroCall=false
  [R2] bash: calls=490 currentSessionCalls=null sessionsWithCalls=3 presence=null zeroCall=false
  [PASS] R2-原始 JSON 无 "currentSessionCalls":0 ；R2-totals 为 null（不是 0）；R2-窗口总量照常给出（563）
  [PASS] R3-身份不可得 + 逐项 null（无 agent 时）
  [PASS] R4-sessionsWithCalls ≤ sessionsScanned（真机全量） :: 违规 0 项
  [R4] calls > sessionsWithCalls 的项数 = 2 ；样例 = ["read: 430 次 / 17 会话","bash: 1927 次 / 18 会话"]
```
真机数据同时给出三态齐全的实例（`absent`/`historical-only`/`current-session` 各至少一项）与"多调一会话"的实证。

---

## 8. 确定性证明（不是"这次跑绿了"）

### 8.1 判定表 7 行逐行

```sh
  [PASS] A-行1 current-session :: {"calls":5,"cur":3,"swc":2,"p":"current-session","z":false}
  [PASS] A-行2 historical-only :: {"calls":5,"cur":0,"swc":2,"p":"historical-only","z":false}
  [PASS] A-行3 absent         :: {"calls":0,"cur":0,"swc":0,"p":"absent","z":true}
  [PASS] A-行4 inWindow=false 且 calls>0 :: {"calls":5,"cur":null,"swc":2,"p":null,"z":false}
  [PASS] A-行5 inWindow=false 且 calls=0 :: {"calls":0,"cur":null,"swc":0,"p":null,"z":true}
  [PASS] A-行6 always-on / unobservable  :: 全 null
  [PASS] A-行7 no-evidence（日志不可读）  :: 全 null
```

### 8.2 288 组合扫描

```sh
  组合数 = 288；其中宿主可达（自洽）= 62，宿主自相矛盾 = 226
  [PASS] A-宿主可达组合零违规 :: 62 个自洽组合全部满足 I1/I2/I5/I6/I7/I8
  [PASS] A-矛盾/缺通道输入下绝不造 0 :: 226 个自相矛盾组合 + 全部缺通道组合中，缺通道一律 null
```
自相矛盾输入的行为（按 §7.1 规则 8「宿主必须保证；`reconcile` **不得**静默修补」逐一归档）：

- `inWindow ≠ 通道存在性`：落回 `inWindow=false` + 逐项 `null`（**安全方向**：宁可说"不可判定"，绝不说 0）；
- `hit > calls`：暴露为 `I5` 违规（不夹取、不修补）；
- `coverage` 与 `calls` 矛盾：暴露为 `I6` 违规（不修补）。
> 非阻断观测 O2：上述三类都**不会**产生假零：扫描中断言"缺通道 ⇒ 必须 `null`"零违例。

### 8.3 同一输入 30 次逐字节相同

```sh
  [PASS] A2-30 次逐字节相同 :: 不同产物数 = 1
```
（归一化 `generatedAt` 后整份 report 逐字节相同 ⇒ 三态判定无随机性、无时序遍历依赖。）

### 8.4 出厂 `output.schema` 机械校验

```sh
  [PASS] E-schema 含三态字段 / E-schema callPresence 枚举 :: ["current-session","historical-only","absent"]
  [PASS] E-schema version const :: 4
  [PASS] E-schema windowBasis const :: "session-log-mtime"
  [PASS] E-schema currentSession.basis 枚举 :: ["agent-session-id","http-session-param","unavailable"]
  [PASS] E-产物通过出厂 schema :: 零违规      # 我自写的 mini-validator：type/enum/const/oneOf/additionalProperties:false
```
另核对 `lib/reconcile.js:89-93` 的 `ITEM_FIELD_ORDER` 含三新字段，与 §2.4 字段表顺序一致。

---

## 9. 连续全量 `node --test` 逐次结果

**Block A（复核开始时，tree hash `ddab34982cf5afba`，t6 尚未开工）**

```
run 1..10: ℹ tests 175 ℹ pass 175 ℹ fail 0 ℹ skipped 0 ℹ todo 0 | tree ddab…->ddab…
```
10/10 绿，且每次运行前后整棵代码树 hash 不变。

**Block B（t6 在飞期间，tree hash 变动）**

```
run 1: ℹ tests 179 ℹ pass 178 ℹ fail 1 | tree cf06c68225dd1654->2026bf2cc0ca44e3 | 红：✖ J3. C4-清单 A18：nameReferencedElsewhere 升序去重且 ≤3
run 2..12: ℹ tests 179 ℹ pass 179 ℹ fail 0 ℹ skipped 0 ℹ todo 0 | tree 2026bf…/bfbe…（稳定或仅 t6 文档改动）
```
**唯一一次红 = t6 并发编辑的中间态**（归属判断依据，见 §10.5）：失败用例位于 `test/client-panel.test.mjs:4065`（t3/t6 的面板测试文件，**不属 t2**），它机械抽取 `DESIGN.md` 的 `### 2.21 R6 完整示例` 与夹具对拍；运行期间整树 hash 从 `cf06c68…` 变成 `2026bf2…`（`DESIGN.md` 写于 21:15:07、`test/client-panel.test.mjs` 写于 21:17:58），即"文档已改、夹具未同步"的窗口。**`index.js` / `lib/reconcile.js` 的 sha256 从开工到收工未变**，与 t2 无关。

**Block C（t6 的中间态落定后，tree hash `bfbe503ac3b1ee8f`）**

```
blockC run 1..10: ℹ tests 179 ℹ pass 179 ℹ fail 0 ℹ skipped 0 ℹ todo 0 | tree bfbe…->bfbe…（每次前后一致）
```
10/10 绿。

合计：**31 次全量运行绿色**，1 次红色已按文件与 hash 归因（非 t2 实现语义）。`skipped 0` 同时证明 t2 新增的 7 个 `{ skip: hostSkip }` 用例在真机依赖齐备时**真的执行**（`hostSkip` 是基线已有的守卫，基线中出现 23 次）。

---

## 10. 断言强度与改动范围

### 10.1 删除的断言行全部是"值更新"，不是"删断言"

```sh
  删除行总数 = 37 ；其中含断言关键字的行 = 9
    - assert.deepEqual(zhKeys, [...FROZEN_KEYS, ...V3_KEYS].sort(),
    - assert.equal(Object.keys(V.dictionaries.zh).length, FROZEN_KEYS.length + V3_KEYS.length)
    - assert.equal(report.version, 3)   ×5（含 body.report.version）
    - assert.equal(LEDGER_VERSION, 3)
  未被同类断言替换的删除行 = []
  [PASS] F1-删除的断言行全部有同类替换 :: [] === []
  [PASS] F1b-version 断言已更新到 4 :: version,4 断言数=10
  [PASS] F1c-面板键集断言已加 V4_KEYS :: V4_KEYS 出现在新增行
```
即：v4 把 `version` 3→4、键集 `+V4_KEYS` 是**契约变更本身**，9 条删除行全部被同 subject 的**新值**断言替换。

### 10.2 未新增跳过/未放宽比较

```sh
  hostSkip 在基线中已有用法数 = 23
  hostSkip 之外的 skip/todo = 0        [PASS] F2-未新增 hostSkip 之外的 skip/todo
  新增近似/容差断言 = 0                [PASS] F4-未新增近似/容差断言
```

### 10.3 用例数与断言点只增不减

| 文件 | 用例 | 断言点 |
|---|---|---|
| `test/reconcile.test.js` | 25 → 30 | 275 → 376 |
| `test/host.test.js` | 24 → 31 | 293 → 402 |
| `test/privacy.test.js` | 8 → 9 | 54 → 68 |
| `test/e2e.test.js` | 5 → 5 | 115 → 129 |
| `test/whitelist.js` | 8 → 9 | 0 → 0（S3 白名单常量表） |
| `test/client-panel.test.mjs` | 68 → 86（含 t6 在飞内容） | 528 → 665 |

### 10.4 范围核实

```sh
  git status 改动集 = ["DESIGN.md","IMPLEMENTATION-NOTES.md","client.js","index.js","lib/reconcile.js",
    "test/client-panel.test.mjs","test/e2e.test.js","test/host.test.js","test/privacy.test.js",
    "test/reconcile.test.js","test/whitelist.js",".feas/"]
  [PASS] F5-改动集未越界 :: [] === []
  [PASS] F6-未改动 package.json / cordis.patch.yml / README.md / CHANGELOG.md / LICENSE
  [PASS] F6-未改动 lib/usage.js / lib/cost.js / lib/provide.js / lib/hide.js / lib/tokens.js
```
- t2 自述的 7 个文件（`index.js` · `lib/reconcile.js` · `test/{whitelist,reconcile.test,host.test,privacy.test,e2e.test}.js`）**全部在 inScope 内**；
- `client.js` + `test/client-panel.test.mjs` 是 **t3 面板线**的交付（团队任务 t3 的输出明确记录"只改 client.js + test/client-panel.test.mjs"），`DESIGN.md`/`IMPLEMENTATION-NOTES.md` 是 **t1/t6** 的交付；
- `lib/` 下 t2 只碰了 `reconcile.js`；`package.json` 等契约外文件**零改动**（用 `git status` 改动集证明，不依赖 mtime）。

### 10.5 并发编辑归属（队长提示的落实）

- 唯一红色 → `test/client-panel.test.mjs:4065`（t6 新加的 J3，读 `DESIGN.md` §2.21）＝**夹具/文档层中间态**，判为"疑似并发编辑所致"，非 t2 缺陷；
- t2 语义面 `index.js`（`5963b702…`）与 `lib/reconcile.js`（`70ba1078…`）**在整个复核期间 hash 未变**，故 §2–§8 的结论不受 t6 在飞影响；
- 本报告 §10 的测试文件统计是**审计时刻快照**，`test/client-panel.test.mjs` 的 sha256 已在 §0 表记录，t6 继续编辑会让这些数字变化（不影响 t2 判据）。

---

## 11. 非阻断观测（不构成缺陷，供队长/后续轮备案）

| # | 观测 | 位置 | 我的判定 |
|---|---|---|---|
| O1 | 两条来源同时存在时 `?session=` 优先 | `index.js:118-121` | DESIGN 未规定优先级；宿主通路下两来源同值 ⇒ 非缺陷 |
| O2 | 宿主自相矛盾输入（`hit>calls`、`coverage` 与 `calls` 矛盾）**不被修补**，原样暴露 | `lib/reconcile.js:366-382` | 与 §7.1 规则 8「不得静默修补，缺陷要暴露给验证线」一致 ⇒ 非缺陷；且此类输入永不产生 0 |
| O3 | `inWindow=true` 而通道为 `null` 时，输出 `inWindow=false` 并全 `null`（落回不可判定） | `lib/reconcile.js:225-240` | 与 §7.1 规则 7「任一不成立以 `null` 为准，绝不升级为 0」一致 ⇒ 非缺陷 |
| O4 | native 渲染文本仍不含三态数字（第 1 行与零调用段标题也未写窗口口径） | `lib/reconcile.js` 的 `renderLedger`（与 v3 **字节级相同**） | §2.11 明确"本版不改文本"，是 **C7 携带项**（已排期）；模型半区的窗口告知由 §2.10 描述句承担（我已核对 `index.js:1090-1102` 的 v4 修订句逐字在位） |
| O5 | 真机上 `context_ledger` 自身 `currentSessionCalls=0`（本次调用尚未落盘） | §2.26.5 第 5 条 | 契约明示"读取时刻快照、至少少 1 次" ⇒ 行为正确 |
| O6 | `.t4-verify/` 是我为复核新建的工作目录（未跟踪），内含合成夹具与替身 | `.t4-verify/**` | 非交付物；如需清理可整体删除，不影响插件 |

---

## 12. 未通过项

**无。** 本报告不含 `findings`，`verdict = pass`。

---

## 13. 复现命令清单

```sh
# 1) 基线（v3）
cd /home/u/Desktop/DSHWorkspace/dsh-context-ledger
git rev-parse HEAD                      # 3f8daf7
mkdir -p ../.t4-verify/baseline-v3/lib
for f in $(git ls-tree --name-only HEAD lib/); do git show HEAD:$f > ../.t4-verify/baseline-v3/$f; done

# 2) 我的三个独立 harness（自建夹具与断言）
cd ../.t4-verify && node harness1.mjs && node harness2.mjs && node harness3.mjs

# 3) 全量测试（逐次 + 树 hash 防并发编辑）
cd ../dsh-context-ledger && for i in $(seq 1 10); do
  before=$(sha256sum index.js lib/*.js client.js test/*.js test/*.mjs | sha256sum | cut -c1-16)
  node --test 2>&1 | grep -E "^ℹ (tests|pass|fail|skipped)"
  after=$(sha256sum index.js lib/*.js client.js test/*.js test/*.mjs | sha256sum | cut -c1-16)
  echo "tree $before -> $after"
done

# 4) 读取面静态核对
sha256sum lib/usage.js ../.t4-verify/baseline-v3/lib/usage.js
grep -rn "arguments\|tool/result\|user/message" lib/usage.js
grep -n "readFileSync\|readText" lib/provide.js
git diff -U0 -- index.js lib/reconcile.js | grep '^+' | grep -E 'data\.(arguments|callId|turn|step|message|content|title|meta|error)|\.time\b|readFileSync|createReadStream'
```

---

## 14. 复确认（t4 attempt 2 · 2026-10-07）

本任务第一次提交时，更新载荷因过长在传输中被截断成非法 JSON（`MALFORMED_RESPONSE`），任务被结算为 `failed`（verdict 不可改）；队长裁定 **③ 重派**。本节记录重派后的**复确认**（不重做报告、不重跑 31 次全量）：

| 项 | 值 |
|---|---|
| 复核基线（与 §0 一致） | `index.js` `5963b702a8ad84c4…` · `lib/reconcile.js` `70ba107801a1d4ef…` · `lib/usage.js` `111f721e450da643…`（**三者在 R8 提交 `9c1c228` 中与复核时逐字节相同**） |
| 提交集 | `9c1c228 feat(v4): R8 三态调用口径 + 面板字号对齐 + C4/C5 收口`（工作区干净，仅 `VERIFY-T5-R8.md` 未跟踪） |
| t2 的改动面（提交内证） | `index.js` · `lib/reconcile.js` · `test/{reconcile,host,privacy,e2e}.test.js` · `test/whitelist.js` = **恰好 t2 自述的 7 个文件**（+1168/-46），`package.json`/`cordis.patch.yml`/`README`/`CHANGELOG`/`LICENSE` 与 `lib` 其余 5 文件不在提交集 |
| 复核脚本复跑 | `harness1` **154/0**、`harness2` **75/0**（A/B 基线已改钉 `3f8daf7`，因 HEAD 已被提交推进）、`harness3`（真机只读）**15/0** ⇒ 合计 **244/0** |
| 全量单次复验 | `node --test` ⇒ `ℹ tests 179 ℹ pass 179 ℹ fail 0 ℹ skipped 0` |

结论不变：**verdict = pass，未通过项 0**。

> 脚本维护说明（不影响结论）：`harness2` 的断言强度/范围两项原先以 `git HEAD` 为基线，HEAD 被提交推进后会把"基线 = 当前"而误报；已改为钉死 `3f8daf7`，复跑全绿。`harness4`（t5）同样已钉死基线。
