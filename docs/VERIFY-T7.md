# dsh-context-ledger — t7 独立复核报告（R1：溯源 / 省额 / 隐私面）

> 复核人：验证（AgentTeams 成员）
> 任务：`t7 [verify]` · kind=review（round 1，绑定 t6）· attempt `5f58df44-816c-435c-aa69-3162bce79179`
> 复核基线：`b00135b`（feat(R1): 工具→插件溯源 + 可执行裁剪清单（t6 交付）+ 队长复核裁定；工作树 clean）
> 契约基线：DESIGN **v2**（1200 行）+ IMPLEMENTATION-NOTES 的队长裁定 + VERIFY-T4 §9
> 纪律：未修改任何实现文件（复核结束时 `git status --short` 为空）；未触碰 `~/.dsh/**`（只读会话日志）与 DSH 安装目录。

---

## 0. 结论

**verdict = needs_revision（1 项阻断）**

R1 的**功能本体全部通过**：独立自建 **816 条断言 / 0 失败**，覆盖溯源正确性、省额算术、隐私面、v2 契约、
F1/F2/F3 与 O1–O4 收口，以及真实日志 + 真实 profile 的端到端。

**唯一阻断项不是产品缺陷，而是 t6 交付的测试套件不能稳定代表验收判据**：

| # | 阻断项 | 定位 | 性质 |
|---|---|---|---|
| B1 | t6 acceptance 第 2 条（`node --test` → 96/96 pass）**不可靠复现**：6 次全量运行中第 6 次为 **95 pass / 1 fail** | `test/e2e.test.js:272`（用例）→ 断言 `test/e2e.test.js:297`（伴生 `:298`） | **仅测试脆弱**；已判定**无产品风险**（见 §1.4）。修复只需改测试，不动产品代码 |

我采用队长裁定的**条件式恒等式 2**，未按字面无条件断言（§3.2）。

| 复核项 | 结论 |
|---|---|
| 1 溯源正确性（本轮核心新逻辑） | ✅ 通过（65/65 与我的独立扫描逐字段一致；grep 一手核对 65/65） |
| 2 省额计算正确性（含"不重复计入"） | ✅ 通过（193 条手工算式断言） |
| 3 隐私未因新能力放宽 | ✅ 通过（S5 哨兵不可见；真实的"源码内容"进不了产物） |
| 4 契约一致性（DESIGN v2 冻结字段/取值域） | ✅ 通过（86 条） |
| 5 F1/F2/F3 + O1–O4 收口 | ✅ 全部收口 |
| 6 真实端到端（真日志 + 真 profile） | ✅ 通过（6 条恒等式全中，条件式 2 成立） |
| 7 acceptance 三条命令 | ⚠️ 第 1、3 条通过；**第 2 条不稳定（B1）** |

---

## 1. 阻断项 B1：全量套件偶发失败（队长要求定位）

### 1.1 复现与环境证据

```
$ cd dsh-context-ledger && for i in 1 2 3 4 5 6; do node --test 2>&1 | ... ; done
run 1: pass=96 fail=0
run 2: pass=96 fail=0
run 3: pass=96 fail=0
run 4: pass=96 fail=0
run 5: pass=96 fail=0
run 6: pass=95 fail=1
  ✖ E2E③：S2 载荷不变性差分证明（真实日志 + 哨兵副本） (529.105556ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual   linesRead: 2349
  - expected linesRead: 2352
  at TestContext.<anonymous> (file:///.../test/e2e.test.js:297:10)
```

复现率 **1/6**（与队长两次观测吻合：95/1 后转为 96/0）。

### 1.2 失败用例与根因

**用例**：`test/e2e.test.js:272`「E2E③：S2 载荷不变性差分证明（真实日志 + 哨兵副本）」

**关键代码路径**（行号为实测）：

| 行 | 动作 |
|---|---|
| 273 | `const source = sessions[0].logPath` ← **取工作区"最近被修改"的会话日志** |
| 287 | `const lines = raw.split('\n')...` ← 第一次读取（解压成快照） |
| 292 | `writeFileSync(copyPath, ...)` ← 从快照写出哨兵副本 |
| **294** | `const usageOriginal = await host.readSessionUsage(source, ...)` ← **再次读取同一个活文件** |
| 295 | `const usageCopy = await host.readSessionUsage(copyPath, ...)` ← 读冻结副本 |
| **297** | `assert.deepEqual(usageCopy, usageOriginal)` ← **失败点** |
| **298** | `assert.equal(usageOriginal.linesRead, lines.length)` ← **同样不稳定**（只是被 297 挡住） |

**根因**：该用例把「同一份数据」的快照（第 287/292 行）与「同一路径的再次读取」（第 294 行）
当成必然相等，而被读的文件**正在被并发写入**。

本工作区是团队共享 workspaceKey（`--home-u-Desktop-DSHWorkspace--`），
`~/.dsh/sessions/<key>/` 下同时有多个**活动会话**在持续追加。实测（`listWorkspaceSessions` 同规则）：

```
$ node flaky-repro.mjs
  捕捉到追加：session-4cb04600-e2d7-43f5-b8f3-34fc67d6deab 增长 9739 字节
  该文件 mtime = 2026-10-07T03:44:20.679Z
  → 说明 sessions[0] 是**仍在被写入的会话**
  快照 lines.length                = 2420
  副本读取 usageCopy.linesRead     = 2420
  活文件重读 usageOriginal.linesRead = 2421
  drift = liveReRead - snapshot    = +1
  第 297 行 deepEqual(usageCopy, usageOriginal) = **FAIL**
  第 298 行 equal(usageOriginal.linesRead, lines.length) = **FAIL**
```

即：**只要快照与重读之间有任意一行被追加，第 297/298 行必然失败**。
`sessions[0]` 是"最近被写"的那个日志——在并发团队工作区里，它经常正是**别人的活动会话**
（本次捕捉到的是队长会话 `session-4cb04600-…`；我自己的验证进程运行期间它被追加）。
这就是"逐文件单跑全通过、全量跑偶发失败"的原因：全量跑窗口更长、并发追加更容易撞上。

### 1.3 可复现命令

```sh
# 1) 统计复现率（6 次全量）
cd dsh-context-ledger && for i in 1 2 3 4 5 6; do node --test 2>&1 | grep -E "^ℹ (pass|fail)"; done

# 2) 确定性复现（等待一次真实追加后执行用例的同一序列）
cd /home/u/Desktop/DSHWorkspace/.feas/t7-verify && node flaky-repro.mjs
```

### 1.4 产品风险判定：**无**（这是关键的"须升级还是仅测试脆弱"结论）

**判据 1（静态语义）**：产品没有任何"两次读取必须一致"的不变量。
`readSessionUsage` 每次调用返回的是**该时刻的一次快照**；`gatherLedger` 对每个会话只读一次。
断言"同一活文件两次读取相等"只在测试内部成立，产品不依赖它。

**判据 2（并发半写文件的实测行为）**：我把真实 `.zstd` 按 7 个比例物理截断，模拟"正在被写"的文件，
跑产品的回放入口：

```
  完整文件基线: linesRead=986 toolCalls=164 distinctNames=9
   {"frac":0.9999,"outcome":"THROW","message":"zstd exited with code 1"}
   {"frac":0.999, "outcome":"THROW","message":"zstd exited with code 1"}
   {"frac":0.99,  "outcome":"THROW","message":"zstd exited with code 1"}
   {"frac":0.95,  "outcome":"THROW","message":"zstd exited with code 1"}
   {"frac":0.9,   "outcome":"THROW","message":"zstd exited with code 1"}
   {"frac":0.75,  "outcome":"THROW","message":"zstd exited with code 1"}
   {"frac":0.5,   "outcome":"THROW","message":"zstd exited with code 1"}
  → 抛错(fail-safe) 7 例 / 未抛错 0 例
```

**7/7 全部走"抛错"路径**，即 `zstd -dc` 对半写文件返回非 0 → `readSessionUsage` 抛出 →
`gatherLedger` 计入 `sessionsUnreadable`（**fail-safe**：宁可不报，也不产生假的零调用或少计）。
产品不会静默读到"半个真值"。

**判据 3（实跑）**：真实端到端（§5）在活动会话存在的情况下跑通 20/20，
且 `~/.dsh/sessions` 目录 mtime 未变（只读）。

**判定**：B1 是**测试脆弱**，不是产品问题。**不需要升级为产品缺陷**。

### 1.5 requiredFix（仅测试，最小改动）

`test/e2e.test.js` 的该用例**不得再读同一个活文件两次**。两种改法任一即可：

- **改法 A（推荐，最小）**：把基准也冻结成副本再比较。在第 292 行之后补
  `writeFileSync(basePath, `${lines.join('\n')}\n`)`，然后把第 294 行改成
  `const usageOriginal = await host.readSessionUsage(basePath, MAX_LINES_PER_SESSION)`。
  这样 A/B 两份**都是冻结输入**，断言恢复为确定性。
- **改法 B**：删掉第 294 行的活文件重读，直接用已冻结的 `lines` 推导期望值
  （`assert.equal(usageCopy.linesRead, lines.length)`），并把第 297 行的
  `deepEqual(usageCopy, usageOriginal)` 改为对 `lines` 的期望对象比较。

> 附带建议（非阻断）：其余读真实日志的用例（同文件 S4 段）只读一次活文件，不受此影响；
> 但若未来再出现"两次读取活文件并断言相等"的写法，应一律按改法 A 处理。

---

## 2. 溯源正确性（本轮核心新逻辑）—— ✅ 通过

### 2.1 独立扫描器 vs 插件：65 个名字逐字段一致

我按 DESIGN §2.14 的正则与 §2.13 的 8 行判定表**另写了一套扫描器**（自己的目录遍历、自己的正则、
自己的判定表），对同一批真实源码（profile 97 包 + 核心作用域 288 包）与同一份名字清单
（本会话可见工具名 ∪ 真实日志解析出的 34 个工具名 = 65 个）逐名字比对：

```
$ node provenance-cross-check.mjs
  我: profile 97 包 / core 288 包；文件 1594 / 47.1 MB / capped=true / 3430 ms
  插件: providerScan={"packages":385,"files":1594,"bytes":49422137,"capped":true} / 419 ms

=== C1 · 逐名字归属比对（我的实现 vs 插件）===
  名字总数 65，归属完全一致 65，不一致 0

=== C2 · 归属分布（我这边独立统计）===
  {"plugin/high":21,"core/high":22,"plugin/low":2,"core/low":2,"mcp-server/high":16,"unknown/low":2}
  给出归属 63/65（97%）；unknown 2 个：subagent, subagent_fork
```

- `kind` / `name` / `confidence` / `method` 四字段**逐名字完全一致**（65/65）。
- 独立复现了 `scope.providerScan`：文件数 **1594 = 1594**，字节数 **49,422,137** 与我自己的测量一致，
  包数 **385 = 97 + 288**，`capped=true`（本机确有 >3 MiB 前端 bundle，与 §2.14 记载一致）。
- 分布形态与 DESIGN §2.14 的自测（74/76，97%）一致；我的清单少 11 个名字故绝对数不同，比例相同。

### 2.2 grep 一手核对（不经过任何插件代码）

对全部 65 个名字，用 `grep -E` 直接在两级的真实源码上核对判定表的每一行前提
（强级 `name[[:space:]]*:[[:space:]]*["'`]NAME["'`]`、弱级 `["'`]NAME["'`]`），
并复刻 §2.8 的 `SKIP_DIR_NAMES` 与 3 MiB 单文件上限：

```
=== C3 · grep 一手核对（强/弱两级，按真实源码分箱）===
  逐名字 grep 一手核对：65/65 与判定表一致
```

重点样本：

| 名字 | 插件结论 | grep 一手事实 | 判定表行 |
|---|---|---|---|
| `bash` | `core/high`（profile 0 命中） | 强命中 profile **0** 个包、core 2 个包 | 第 4 行 ✓ |
| `task_board_list` | `plugin/@linxin666/dsh-client-ui-task-board` | 强命中恰 1 包，就是该包 | 第 2 行 ✓ |
| `agent_teams_status` | `plugin/@nanmicoder/dsh-agent-teams` | 强命中恰 1 包 | 第 2 行 ✓ |
| `subagent` | `unknown/low` + candidates | 强级 0；弱级 profile **7** 包 + core **33** 包 → 歧义 | 第 7 行 ✓（**未猜测**） |
| `workflow` | `core/low` | 强级 0、弱级 profile 0 / core 3 包 | 第 6 行 ✓ |
| `modlens_read_image` | `plugin/@liustack/modlens`（low） | 强级 0；弱级 profile 恰 1 包 | 第 5 行 ✓ |
| `context_ledger` | `plugin/dsh-context-ledger`（low） | 强级 0；弱级 profile 恰 1 包 | 第 5 行 ✓ |
| `mcp__openviking__find` | `mcp-server/openviking` | 不扫源码（命名约定） | 第 1 行 ✓ |

`annotation` → `plugin/dsh-annotate`（**强级**，`dsh-annotate/index.js:687` 有 `name: 'annotation'`），
与 DESIGN §2.14「弱级不做唯一性要求就会把 `annotation` 判给 genui」的记载一致——两处都实测复现。

### 2.3 "扫不到"必须如实标为未知，不得猜成别的插件 —— ✅

```
=== C4 · 不存在于任何源码的名字 ===
  zzz_never_exists_5c71: {"kind":"unknown","name":null,"confidence":"low","method":"not-found","evidenceFile":null,"candidates":[]}
  totally_made_up_tool:  {"kind":"unknown","name":null,"confidence":"low","method":"not-found","evidenceFile":null,"candidates":[]}
```

- 两级扫描皆无命中 → `unknown` + `method:"not-found"` + `name:null` + `candidates:[]`（**不猜**）。
- 缺省 provenance（调用方不给归属）→ 同样全部 `unknown/not-found`（§7.1 规则 3）。
- 畸形 `providedBy`（`kind` 非法）→ `reconcile.isProvidedBy` 拒收后退化 `unknown`，其后落
  `noRecommendation.unknown-attribution`，**不会**被当成 plugin 进入可执行候选（§4.4 硬规则）。
- `category === "mcp"` 但名字不符合 `MCP_NAME_PATTERN` → 走第 8 行 `unknown/not-found`，
  不得用"看起来像 MCP"推断（§2.13 说明 2）。
- `subagent`/`subagent_fork` 两个真·未知项：`method:"static-scan-weak"`、`candidates` 非空，
  如实暴露"有线索但无法唯一归因"，未猜测。

### 2.4 evidenceFile 可复核

```
=== C5 · evidenceFile 可复核性 ===
  有 evidenceFile 的名字 47 个，示例： [["agent_teams_amend_task","/home/u/.dsh/profiles/web/node_modules/@nanmicoder/dsh-agent-teams/lib/tools.js"], ...]
```
- 47 个 `evidenceFile` **全部是存在的绝对路径**（`statSync().isFile()` 逐个校验），且只含可打印 ASCII。
- `mcp-naming` / `not-found` 的 `evidenceFile` 恒为 `null`。
- **未输出任何源码片段/行号/内容摘要**（§3.6 硬规则 4）：产物 187 个叶子字符串中，
  路径类叶子只有目录结构派生的路径（见 §4）。

### 2.5 F5 可达性（独立量测）

```
=== C6 · F5 可达性（真实 profile 是否有孤儿 plugin 包）===
  @changfenhuang/dsh-genui: owner=["@changfenhuang/dsh-genui"] → 唯一 owner
  @linxin666/dsh-client-ui-task-board: owner=["@linxin666/dsh-web-all"] → 唯一 owner
  @liustack/modlens / @nanmicoder/dsh-agent-teams / dsh-annotate / dsh-context-ledger → 均唯一 owner
  孤儿 plugin 包数 = 0
```

本机 **0 个孤儿 plugin 包** ⇒ 恒等式 2 的**字面形式**在本机真实数据上同样成立（见 §3.2）。
另实测：`resolveBundleOwners` 的"包名字面量命中"用子串实现，对 7 个事实包做**子串 vs 精确边界**对照，
结果**逐一相同**（`@linxin666/dsh-client-ui-task-board` 与 `…-github` 同属 `@linxin666/dsh-web-all`），
无假命中（§7-O2）。

---

## 3. 省额计算正确性 —— ✅ 通过

### 3.1 已知答案复算（193 条断言 / 0 失败）

`pruneplan-known-answer.mjs` 驱动 `reconcile → buildPrunePlan`，期望值逐条手工算出：

| 用例 | 场景 | 手工期望 | 实测 |
|---|---|---|---|
| **P1** | **同一卸载单元下两个事实包**（真正的"不能重复计入"）`bundleW` 拥有 `pkgX`(+x1=100,x2=200) 与 `pkgY`(y1=300)，另有在用 used1=50 | **只有 1 个条目**（不是 2 个）；`itemCount=3`；`reclaimableTokens=100+200+300=600`（**不含** used1 的 50）；`usedToolCount=1`；`factPackages=["pkgX","pkgY"]` | 全部一致 |
| P2 | MCP 按 server 分组：srvA(a1=70,a2=30 + 在用 a3=40)、srvB(b1=10) | 2 条目；srvA `reclaimable=100`、`usedToolCount=1`、`factPackages=[]`；srvB=10；按 reclaimable 降序 | 一致 |
| P3 | noRecommendation 三理由各 1 项 + 不可观测项 | `prunePlan=[]`；`core 1/500`、`no-owner-bundle 1/10`、`unknown-attribution 1/20`；`zeroCallItems=3`、`zeroCallTokens=530`；不可观测项（名字含空格）`calls=null`/`zeroCall=null` 且**不进任何清单**，`namesRejected=1` | 一致 |
| P4 | confidence 取最弱一环 | 同 target 下 low+high → 条目 `low`；另一 target `high`；按 reclaimable 降序 | 一致 |
| P5 | 全序排序 | `reclaimable` 降序 → `itemCount` 降序 → `target` 升序（含两处全平用 target 兜底） | 一致 |
| P6 | 恒等式 6 | `sessionsScanned=0` ⇒ `prunePlan=[]`、三条 noRec 全 0、**无假零调用**（`zeroCall=null`） | 一致 |
| P7 | 归属缺失/畸形 | 不给归属就 `unknown`，落 `unknown-attribution`；**不猜**给已知 bundle | 一致 |
| P8 | instructions/skills | 即使调用方给了 `providedBy` 也**不注入**、不进候选（§2.13 硬规则 4 / §2.15 禁止） | 一致 |
| P9 | `buildPrunePlan` 边界 | 空输入 → 空清单 + 3 条零值；无 `bundleOwners` → `no-owner-bundle`，无候选 | 一致 |
| P10 | unknown 防线 | `kind=unknown` 的项**绝不**出现在可执行候选（§4.4 硬规则） | 一致 |

**"同一插件多个零调用工具不重复计入"的直接证据（P1）**：
两个事实包共享一个 `target` 时，实现把条目 key 定为 `${kind}\0${target}` ⇒ **合并成一个条目**，
`reclaimableTokens` 恰为三项自身 `tokens` 之和（600），且 `usedToolCount` 只作代价信号、不并入省额。
另有机械防线：`prunePlan` 内 `items[].id` 全局唯一（`placed` 集合），实测 `ids.length === new Set(ids).size`。

### 3.2 六条恒等式（真实数据）

```
=== F2 · 真实数据上的 6 条恒等式（含队长裁定的条件式 2）===
  Σ(plugin|mcp 零调用)=384 · no-owner-bundle=0 · Σ prunePlan=384
```

| 恒等式 | 结果 |
|---|---|
| 1 `prunePlanReclaimableTokens = Σ entries` | ✅ |
| **2 条件式（队长裁定）** `Σ prunePlan === Σ(plugin\|mcp-server 零调用) − Σ(no-owner-bundle.tokens)` | ✅（384 = 384 − 0） |
| 2 字面式（本机 0 孤儿 ⇒ 与条件式等价） | ✅ 亦成立，但**我不把它当无条件判据** |
| 3 `Σ itemCount + Σ noRec.items = totals.zeroCallItems` | ✅ |
| 4 `Σ reclaimable + Σ noRec.tokens = totals.zeroCallTokens` | ✅ |
| 5 `Σ reclaimable ≤ categories.tools.tokens + categories.mcp.tokens` | ✅ |
| 6 `usageAvailable===false ⇒ prunePlan===[] ∧ 三条全 0` | ✅（P6 单独构造验证） |

**关于 F5**：我采用你裁定的条件式核对，并在真实数据上量测到 `no-owner-bundle = 0`（§2.5 C6），
因此字面式在本机也成立——但这是**数据巧合**，不是我认为字面式正确。措辞冲突的账记在 DESIGN v3。

### 3.3 真实数据的 prunePlan 形态（与 DESIGN §2.16 的动作单元解析一致）

```
  Never-called candidates, grouped by removal unit — NOT uninstall advice: 384 tokens in 6 units
    - mcp-server openviking: 8 tools, 240 tokens if unused  (5 other tools of this unit are in use)
    - plugin @linxin666/dsh-web-all: 2 tools, 50 tokens if unused  (3 other tools of this unit are in use)  (provides @linxin666/dsh-client-ui-task-board)
    - plugin @liustack/modlens: 1 tool, 26 tokens if unused  (provides @liustack/modlens)
    - plugin dsh-context-ledger: 1 tool, 24 tokens if unused  (provides dsh-context-ledger)
    - plugin @changfenhuang/dsh-genui: 1 tool, 22 tokens if unused  (1 other tool of this unit is in use)  (provides @changfenhuang/dsh-genui)
    - plugin dsh-annotate: 1 tool, 22 tokens if unused  (provides dsh-annotate)
  No actionable unit: 7 items, 154 tokens (core 6, unknown attribution 1)
```

- **`target` 与 `factPackages` 不是一回事**，且解析正确：`@linxin666/dsh-client-ui-task-board` 的动作单元
  是 **`@linxin666/dsh-web-all`**（§2.16 规则 3 点名的例子）——我独立复核了 patch 文本归属，一致。
- `usedToolCount` 如实暴露卸载代价（openviking "5 other tools in use"、web-all "3 other tools in use"）。
- `noRecommendation` 三条固定顺序、零值条目保留形状。
- 候选项**全部**满足 `zeroCall===true ∧ kind ∈ {plugin, mcp-server}`，`calls===null` 的项**一个都没有**混入。

---

## 4. 隐私不因新能力放宽 —— ✅ 通过

### 4.1 新读取面的静态边界

```
=== D1 · 静态读盘面 ===
  lib/provide.js 中的读盘 API 命中 = []
  lib/provide.js 的 import = ["./usage.js"]
  使用不安全根/变量的 R1 读盘点 = []
```

- `lib/provide.js` **零读盘**（DESIGN §3.4 的 grep 判据），只 import 项目内纯函数模块。
- `index.js` 的全部读盘调用点逐行核对：R1 新增读盘点（373–634 区间）只使用
  `nodeModulesDir` / `dir` / `full` / `profileDir` / `packageDir` / `patchPath` 这类
  **由 profile/core 根派生**的变量，**没有任何一处**引用 `sessionsRoot` / `cwd` / `homedir` / 工作区路径。

### 4.2 S5 溯源哨兵（§3.4 新增自检）

在工作区内造一个假插件包（目录名 `@fake/toolpkg`、注册假工具 `faketool_s5c71`、
源码含哨兵 `LEDGER-PROVENANCE-SENTINEL-5c71`）+ 假 bundle patch，并布置三类**诱饵**：

| 诱饵 | 位置 | 期望 |
|---|---|---|
| `DECOY-OUTSIDE-NODE-MODULES-9a02` | `<profile>/outside.js`（node_modules 之外） | 不读 |
| `DECOY-README-PROSE-4b13` | `<pkg>/README.md` | 不读（扩展名不在 `SCAN_EXTENSIONS`） |
| `DECOY-TEST-FIXTURE-7d24` | `<pkg>/test/fixture.js` | 不读（`SKIP_DIR_NAMES` 含 `test`） |
| `DECOY-STORAGES-SECRET-2e88` | `<profile>/storages/secret.js` | 不读（不是扫描根） |

```
=== D2/D3 · S5 哨兵 + 诱饵文件不得被读 ===
  fake tool item: {"name":"faketool_s5c71","tokens":7,"providedBy":{"kind":"plugin","name":"@fake/toolpkg","confidence":"high","method":"static-scan","evidenceFile":".../s5-profile/node_modules/@fake/toolpkg/index.js","candidates":[]}}
  providerScan: {"packages":2,"files":1,"bytes":97,"capped":false}
```

- 假工具归属正确（第 2 行：profile 恰 1 包命中 → `plugin/high`），`evidenceFile` 指向**路径**。
- **四个哨兵在 JSON 产物与 native 渲染里全部不可见**。
- `providerScan.files = 1`：只读了 1 个文件（README / test/ / 目录外文件均未被读）。

### 4.3 真实语料：产物字符串逐条溯源

```
=== D4 · 真实语料下的产物字符串溯源 ===
  真实语料：1594 文件 / 47.1 MiB / capped=true
  产物叶子字符串 = 56
  白名单外叶子字符串 = 0 []
  evidenceFile 类叶子 = 3，不存在的 = 0
    可疑叶子中被源码包含的 = 101（全部是工具名——这正是命中定义）
```

- 真实端到端（§5）的 187 个产物叶子字符串，**白名单外 0 个**（含 v2 新增的 `PACKAGE_PATTERN` 包名）。
- 逐个把"可出现在源码里的产物字符串"回查 49 MB 被扫源码：**命中的全部是工具名本身**
  （那正是强/弱级的定义），**没有出现任何路径/片段/摘要类新字符串类别**。
- 产物中不含中文、引号、反斜杠（路径除外）——即不含散文/正文特征。

### 4.4 日志侧未被 R1 破坏

```
=== D5 · 日志载荷哨兵（S1）===
  scope: {"scanned":1,"toolCalls":1,"available":true}
  items: task_board_list:0 bash:1
```
- 载荷哨兵（`data.arguments` / `tool/result.message` / `user/message.content` / `session/title.title`）
  在完整 JSON 与 native 渲染中均不可见。
- 日志回放仍工作，且零调用项同时带上 `providedBy`（R1 与 v1 能力共存）。

---

## 5. 契约一致性（DESIGN v2）—— ✅ 通过（86 条）

| 检查 | 结果 |
|---|---|
| `version` 常量与产物 = **2** | ✅ |
| 顶层 11 键与顺序不变 | ✅ |
| `scope` **17 键**（含 `providerScan` 4 键），顺序与 §2.2 一致 | ✅ |
| `items[].providedBy` 6 子字段与顺序；仅 `tools`/`mcp` 有，`instructions`/`skills` **键都不存在** | ✅ |
| `kind` 取值域恰 4 个；`confidence` 2 个；`method` 4 个 | ✅ |
| `core`/`unknown` 的 `name` 恒 null；`plugin` 的 `name` 命中 `PACKAGE_PATTERN` | ✅ |
| `candidates` 仅在 `unknown` + `static-scan*` 时非空，升序去重 ≤8；其余恒 `[]` | ✅ |
| `findings` **6 键**与顺序（`prunePlan` / `prunePlanReclaimableTokens` / `prunePlanBasis` / `noRecommendation`） | ✅ |
| `PruneEntry` **8 字段**与顺序；`kind` 取值域 2 个；`factPackages` 仅 plugin | ✅ |
| `noRecommendation` 固定 3 条、顺序 `core → no-owner-bundle → unknown-attribution`、3 字段 | ✅ |
| `prunePlanBasis` 常量 `"model-tool-calls-only"` | ✅ |
| 输出 schema：顶层与各子对象 `additionalProperties:false`；`providedBy` 收紧且枚举冻结 | ✅ |
| 模型工具 `description` 与 §2.10 **v2 冻结文本**一致（空白归一化，见 §7-O5）；参数只有 `sessions` | ✅ |
| 确定性：同输入两次逐字节相同（除 `generatedAt`） | ✅ |
| §2.11 渲染逐行模板（含 R1 段标题 "candidates … NOT uninstall advice"、单元行 5 要素、末行固定声明） | ✅ |

### 5.1 F1 / F2 / F3 既有裁定被遵守

- **F1**：`test/whitelist.js` 的 `id` 前缀规则沿用，且**未放宽字符集**——`id` 的 name 部分仍须过
  `NAME_PATTERN` 或为绝对路径（对抗样本 `tools:中文`、`tools:a b` 均被拒）。
  v2 新增的字符串类别（包名 / 4 个 kind / 2 个 confidence / 4 个 method / 3 个 reason / `model-tool-calls-only`）
  全部被接受。**id 血统**：id 由 `reconcile` 从 `category`+`name` 推导，两个组成部分仍只来自声明侧。
- **F2**：§7.1 已收敛为**唯一通道** `callsByName`。实测：
  `item.calls` / `item.observedCalls` / `scope.callsByName` **全部被忽略并覆盖**
  （只给 `item.calls: 9` 时 `calls = 0`），只有顶层 `callsByName` 生效。单一生产者由 `gatherLedger` 保证。
- **F3**：`formatBytes(2048) === "2.0 KB"`（字符串），DESIGN v2 §7 已订正。

### 5.2 O1–O4 全部收口

| v1 观测 | v2 收口 | 实测 |
|---|---|---|
| **O1** §2.11「与节选逐字节相同」表述不准 | §2.11 已标注为**节选**并给出真实契约 | ✅ 实现按"逐行符合模板 + 完整渲染"；我逐行核对通过 |
| **O2** `?cwd=` 旋钮产出降级数据 | §4.1 判定**移除**，改为显式错误 | ✅ `?cwd=…` 与缺 session 均返回 **400** `{ok:false,error:"session-unresolved"}`；有效 session → 200；非 GET → 405；缓存复用同一 `generatedAt` |
| **O3** 矛盾输入无定论 | §7.1 规则 4 + §2.3 定论 | ✅ `sessionsScanned=0` 且 `callsByName` 非空 → 全部 `no-evidence`、`zeroCall=null`、`findings.zeroCall=[]`、`prunePlan=[]`；且**不重写**宿主传入的 `scope.toolCalls`（77 原样输出） |
| **O4** 同类部分可观测 | §2.3：有一个未知即整类 `null`，**不得给部分和** | ✅ 类内混入 `calls=null` 项 ⇒ 类级 `calls` 与 `tokensPerCall` 双 `null`，类级 `tokens` 仍如实合计 |

---

## 6. acceptance 三条命令（我自己执行）

| # | 命令 | 结果 |
|---|---|---|
| 1 | `cd dsh-context-ledger && node --check index.js`（含 `lib/*.js`） | ✅ exit 0（全部文件） |
| 2 | `cd dsh-context-ledger && node --test` | ⚠️ **不稳定**：6 次中 5 次 96/96 pass、1 次 **95/1 fail**（见 §1） |
| 3 | `cd dsh-context-ledger && DSH_HOME=.feas/isolated-home dsh --profile testbed --dump-config \| grep -c context-ledger` | ✅ 输出 `3`，exit 0 |

真实端到端（合成声明侧 + 真日志 + 真 profile）：

```
  scope: sessions 20/40 · lines 14528 · toolCalls 2460 · skillToolCalls 2 · namesRejected 0
  providerScan: {"packages":385,"files":1594,"bytes":49422137,"capped":true}
  providedBy 分布: {"mcp-server/high":13,"plugin/low":2,"plugin/high":16,"core/low":2,"core/high":21,"unknown/low":2}
  prunePlanReclaimableTokens = 384 (basis=model-tool-calls-only)
================ REAL E2E: 20 passed / 0 failed ================
```

> 声明侧（工具 schema / 技能目录）是**合成**的：本验证无法拿到运行中宿主的真实 schemas。
> 使用侧（真实会话日志）与归属侧（真实 profile + 真实核心作用域）全部是真的。此处不冒充全真。

---

## 7. 非阻断观测（6 项）

- **O1 · `noRecommendation.reason` 的 `actionFor` 兜底分支**：`lib/provide.js:333/346` 对
  "providedBy 不是对象"或"kind 非三者"的情形返回 `unknown-attribution`（而非 `no-owner-bundle`）。
  与 §2.16 三条理由的语义一致（"归属未知 ⇒ 无法给出动作"），实测未产生误分类。
- **O2 · `resolveBundleOwners` 用子串命中 patch 文本**（`index.js:590`）。§2.16 规则 3 与 §2.17 第 1 条
  明确"只用包名文本命中"，子串实现符合规范；实测 7 个真实事实包的**子串命中与精确边界命中逐一相同**，
  无假归属（含 `…-task-board` 与 `…-task-board-github` 同属一个 bundle 的情形）。记为低风险口径说明。
- **O3 · `unknown` 行的 `evidenceFile` 为 `null`**（`lib/provide.js:281/314`）。DESIGN §2.13 只强制
  `mcp-naming` / `not-found` 为 null；对第 3/7 行（有候选但无法唯一归因）未规定。实现取 null
  更保守（"没有唯一归因就没有单一证据"），且候选包名已在 `candidates` 里可查。建议 DESIGN v3 明写一句。
- **O4 · 输出 schema 未声明 `required`**（v1 起即如此）。§2.1 的"字段全部必需"由**实际 emit 值**满足——
  我已单独断言：11 个顶层键、17 个 scope 键、每个 item 的 8 个必需键在真实与合成数据上**全部存在**。
  记为契约硬化建议（非缺陷）。
- **O5 · §2.10 的 `description` 是块引用折行**：我按"折行即空格连接"比较（与 v1 一致），
  空白归一化后与实现逐字节相同。若契约要求字面换行，DESIGN 需改写成代码块。
- **O6 · 扫描会跟随 `link:` 符号链接进入工作区**：`collectCorpus`/`listPackages` 覆盖
  profile 顶层包（含指向工作区的 `dsh-annotate` / `dsh-context-ledger`）。§2.14 明确"符号链接指向
  pnpm store 亦计入"，且 §3.6 的"不读用户文件"针对的是**扫描根**而非解析后的目标——
  因此不构成越线。**但**这解释了为什么"不带 `SKIP_DIR_NAMES` 的 grep"会把包自己的 `test/` 夹具
  误判为命中（我第一版 harness 正是如此，加上 skip 后即 65/65 一致）——即 `SKIP_DIR_NAMES` 是**功能必需**，
  不是可选优化。

---

## 8. 复核方自身的错误（更正记录，保留不掩盖）

我最初写错 10 处期望值/夹具，全部定位为**我的脚本之错**后更正重跑，**未放宽任何判据**：

| # | 我的错误 | 事实 | 结论 |
|---|---|---|---|
| 1–2 | 参照扫描器把 `evidenceFile` 伪造成 `${pkg}/index.js`（A2/A2b 共 116 条"不一致"） | 需按真实命中文件路径生成 | 我的 harness 错 |
| 3 | P3 夹具想造"不可观测工具项"却给了 `usageAvailable=true` 且无计数 | 工具项在该条件下**就是**零调用；不可观测只能来自 `usageAvailable=false` 或名字不过护栏 | 我的夹具错（并因此额外验证了护栏兜底路径） |
| 4 | P8 用 `items[0]`/`items[1]` 取项 | `items` 已按 §2.7 排序，下标语义错；应按 id 取 | 我的断言错（**不是** providedBy 漏注入） |
| 5 | D1 的读盘点白名单漏了 `index.js:404` | 该点是 `isDirectory()` 辅助函数，根仍来自 profile/core | 我的白名单错 |
| 6–7 | D5 夹具把 `task_board_list` 写成了一次 `tool/call` | 我本意是"零调用" | 我的夹具错 |
| 8 | E3 夹具的零调用插件项缺 `byName` 条目 ⇒ 落 `unknown` 而非 plugin 条目 | 缺省归属 = unknown（设计如此） | 我的夹具错 |
| 9 | E10 按字面换行比较 §2.10 块引用 | DESIGN 的 `> ` 块是折行呈现 | 我的比较方式错（改为空白归一化） |
| 10 | real-e2e 的白名单缺 `PACKAGE_PATTERN` | §3.4 S3 已把包名列为 v2 新增类别 | 我的白名单错 |

---

## 9. 复现方式

核验脚本与原始输出都在工作区 `.feas/t7-verify/`：

| 文件 | 内容 | 断言 |
|---|---|---|
| `attribute-table.mjs` | 判定表 8 行 + 单趟合并正则 vs 逐名字参照（含 400 组随机语料） | 484 / 0 fail |
| `pruneplan-known-answer.mjs` | 省额与分组已知答案（P1–P10）+ 6 条恒等式（条件式 2） | 193 / 0 fail |
| `provenance-cross-check.mjs` | 我的独立扫描 vs 插件（65 名字）+ grep 一手核对 + 证据文件 + F5 可达性 | 9 / 0 fail（内含 65×2 逐项比对） |
| `privacy-r1.mjs` | S5 哨兵 + 诱饵文件 + 真实语料溯源 + 日志侧 S1 + 读盘面 | 24 / 0 fail |
| `contract-v2.mjs` | v2 契约 + F1/F2/F3 + O1–O4 + 路由 + 工具签名 | 86 / 0 fail |
| `real-e2e.mjs` | 真实日志 + 真实 profile 端到端（6 条恒等式、输出面白名单） | 20 / 0 fail |
| `flaky-s2.mjs` / `flaky-repro.mjs` | B1 的机制分析与确定性复现 | 见 §1 |
| `observe.mjs` | §7-O2 / 畸形 providedBy 的实测 | 见 §7 |
| `logs/` | 每次执行的完整原始输出 | — |

```sh
cd /home/u/Desktop/DSHWorkspace/.feas/t7-verify
node attribute-table.mjs && node pruneplan-known-answer.mjs && node provenance-cross-check.mjs \
  && node privacy-r1.mjs && node contract-v2.mjs && node real-e2e.mjs
node flaky-repro.mjs     # B1 的确定性复现
```

**合计 816 条独立断言 / 0 失败**（不含 B1 的复现计数）。

---

## 10. 最终判定

- **R1 功能本体：通过。** 溯源正确性（65/65 独立一致 + grep 一手核对）、省额算术（含"不重复计入"）、
  隐私面（S5 哨兵不可见、无新字符串类别）、v2 契约、F1/F2/F3 与 O1–O4 收口、真实端到端 6 条恒等式——
  全部由我独立构造、独立执行。
- **阻断项 B1（唯一）**：t6 acceptance 第 2 条 `node --test → 96/96` 在 6 次全量运行中出现 1 次
  `95/1`，**不能作为稳定判据**。定位到 `test/e2e.test.js:272`（用例）与 `:297`/`:298`（断言），
  根因是"先快照、再重读同一个正在被并发写入的活文件"，已给出确定性复现（drift +1）。
  经三项判据（静态语义 / 7-7 半写文件 fail-safe 实测 / 真实端到端通过）判定为**仅测试脆弱、无产品风险**，
  requiredFix 见 §1.5（只改测试，不动产品代码）。
- 因此 **verdict = needs_revision**：不是对 R1 功能的否定，而是"交付物自带的验收命令不可靠复现"
  这一事实无法用 `pass` 表述。修复后（改法 A 约 2 行）本报告 §2–§6 的结论可直接沿用。
