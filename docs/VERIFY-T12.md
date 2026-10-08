# dsh-context-ledger — t12 独立复核报告（round 2：B1 修复复核）

> 复核人：验证（AgentTeams 成员）
> 任务：`t12 [verify]` · kind=review（round 2，绑定 t11）· attempt `b3c1bd70-bd9a-4e32-ba4c-32c79cab8f3a`
> 复核对象：t11 对 **B1**（全量套件偶发失败）的修复（`test/e2e.test.js`，工作树未提交）
> 基线：产品侧 `b00135b`；修复侧 `git diff`（1 file changed, 69 insertions(+), 9 deletions(-)）
> 纪律：未修改任何实现/测试文件；未写 `~/.dsh/**`；未动 DSH 安装目录。

---

## 0. 结论

**verdict = pass**

修复**把问题修对了，而不是把门放宽**。6 项必核全部通过，且**没有放宽任何一条既有断言**：

| # | 必核项 | 结论 | 一句话证据 |
|---|---|---|---|
| 1 | 断言未被放宽（权重最高） | ✅ 通过 | E2E③ 的 8 条断言**逐字保留**，`assert.deepEqual(usageCopy, usageOriginal)` 等三条 S2 断言**一字未改**；只 **+2** 条新断言，**-0** 条 |
| 2 | 未改产品代码 | ✅ 通过 | `git diff --name-only` = `test/e2e.test.js`；`index.js` / `lib/**` / `package.json` / `client.js` 的 sha256 与 HEAD **逐一相同** |
| 3 | 根因而非绕开 | ✅ 通过 | E2E③ 内 `source` 只出现 **2 次**（绑定 + 唯一一次解压），此后全部读 `basePath`/`copyPath`/`frozenHome`；**未**加入"挑稳定会话"之类的环境依赖 |
| 4 | 偶发确已消除（≥10 次） | ✅ 通过 | 全量 `node --test` **12 次连续 12/12 通过**（每次 tests=97 / pass=97 / fail=0 / skipped=0） |
| 5 | 确定性反证（文件正在被写） | ✅ 通过 | 同一套"持续追加活文件"夹具下：**旧版 9 次跑出 7 次失败**（全部是 t7 定位的 drift）、**新版 9 次 0 失败**，E2E③ ✔ 9/9 |
| 6 | 其他既有判据未被削弱 | ✅ 通过 | 逐用例断言清单比对：E2E①/②/④ = 3/37/19 条**完全未变**；其余 9 个测试文件断言数**逐一相同**（host 188 / privacy 43 / reconcile 199 / provide 66 / cost 36 / tokens 26 / usage 54 / client-panel 165） |

验收命令复核：`node --check` exit 0；`node --test` 97/97；`--dump-config | grep -c context-ledger` = 3。
另：R1 功能六套件（t7 建的 816 条断言）复跑**仍全绿**（产品代码哈希未变，理应如此，已实测）。

---

## 1. 必核项 1：断言未被放宽 —— ✅（最高优先，本项不成立则其余不看）

### 1.1 S2 三条核心断言逐字比对

| 版本 | 代码 |
|---|---|
| HEAD | `assert.deepEqual(usageCopy, usageOriginal)`<br>`assert.equal(usageOriginal.linesRead, lines.length)`<br>`assert.ok(usageOriginal.toolCalls > 0)` |
| 工作树 | `assert.deepEqual(usageCopy, usageOriginal)`<br>`assert.equal(usageOriginal.linesRead, lines.length)`<br>`assert.ok(usageOriginal.toolCalls > 0)` |

**三行一字不差**；唯一变化是二者的**输入**：`usageOriginal` 从 `readSessionUsage(source)`（活文件）
改为 `readSessionUsage(basePath)`（冻结副本）。S2 的语义（"载荷全量替换后计数逐字段相等"）
因此**以逐字节相等成立**，且是确定性成立的。

### 1.2 E2E③ 全部断言：只增不减

```
=== 逐用例断言清单对比（e2e.test.js）===
  SAME     E2E①：本机真实日志可定位                       旧 3→新 3
  SAME     E2E②：真实日志 → 真实声明面 → 零调用清单          旧37→新37
  CHANGED  E2E③：S2 载荷不变性差分证明（真实日志 + 哨兵副本）  旧 8→新10  +2 -0
      + 新增: assert.ok(declared !== null && declared.length > 0, '冻结基准快照应含 request/header 的 tools 声明')
      + 新增: assert.ok(costItems.some(item => item.category === 'tools'), '差分报告的成本侧必须含工具项')
  SAME     E2E④：scanInstructionChain 在真实磁盘上工作        旧19→新19
  仅新增用例: ['E2E⑤：S2 夹具纪律（回归测试）——输入不冻结就会漂移，冻结后免疫']
```

E2E③ 的 8 条原有断言**一条都没有被移除或改写**（`-0`）；新增的 2 条是**防退化守卫**
（防止冻结快照丢失声明面 / 成本侧变空，导致 S2 退化成"空对空"），属于**加强**。

### 1.3 全文件放宽迹象扫描（两版本对比）

| 指标 | HEAD | 工作树 | 判定 |
|---|---|---|---|
| `assert.*` 总数（e2e.test.js） | 73 | **81** | 只增 |
| 近似/容差/软失败（`tolerance`/`approx`/`soft`/`assert.ok(true)`） | 0 | **0** | 未引入 |
| 吞错 `catch {}` | 0 | 0 | 未引入 |
| 字节级相等断言（`equal`/`deepEqual`） | 51 | **56** | 只增 |
| `notEqual`/`notDeepEqual` | 1 | 2 | 只增（E2E⑤ 的机制断言） |
| `skip`/`todo` 数 | 4 | 5 | 仅新增用例复用同一 `{ skip }` 守卫 |

**没有**任何 `t.skip` / `todo` / 条件软失败 / 子集化 / 删除断言。

### 1.4 顺带确认：E2E③ 内部的 prunePlan 交叉断言不是"空对空"

第 361 行 `assert.deepEqual(fromOriginal.findings.prunePlan, report.findings.prunePlan)` 的强度
取决于该配置下 `prunePlan` 是否非空。我复现 E2E③ 的输入配置（真 profile + 冻结快照）实测：

```
$ node probe-e2e3.mjs
usageOriginal: linesRead=1416 toolCalls=235 distinctNames=9
declared tools = 70
report: items=70 categories.tools.itemCount=54 prunePlan=6 prunePlanReclaimableTokens=5274
prunePlan targets: ["openviking:2658","@linxin666/dsh-web-all:2005","@changfenhuang/dsh-genui:284","@liustack/modlens:156","dsh-annotate:88","@nanmicoder/dsh-agent-teams:83"]
→ E2E③ 内部 prunePlan 交叉断言是否非空:  非空（断言有意义）
```

6 个单元 / 5274 tokens ⇒ 该断言在真实环境下**非平凡**。（边界见 §7-O1。）

---

## 2. 必核项 2：未改产品代码 —— ✅

```
$ git diff --name-only
test/e2e.test.js

$ for f in index.js lib/provide.js lib/reconcile.js lib/tokens.js lib/usage.js lib/cost.js package.json client.js; do
    a=$(git show HEAD:$f | sha256sum | cut -c1-16); b=$(sha256sum $f | cut -c1-16); [ "$a" = "$b" ] && echo "SAME $f" || echo "DIFF! $f"; done
  SAME  index.js
  SAME  lib/provide.js
  SAME  lib/reconcile.js
  SAME  lib/tokens.js
  SAME  lib/usage.js
  SAME  lib/cost.js
  SAME  package.json
  SAME  client.js
```

8 个产品文件与前一轮基线**逐字节相同**（sha256 前 16 位一致）。`git diff -U0` 的 12 个 hunk 全部落在
① import 行、② `readDeclaredTools`、③ E2E③ 用例体、④ 新增 E2E⑤ —— **没有**任何 hunk 落在产品代码或其它测试。

---

## 3. 必核项 3：根因而非绕开 —— ✅

### 3.1 结构性证明：E2E③ 不再读活文件

```
$ awk 'NR>=277 && NR<=362' test/e2e.test.js | grep -n "source"
  2:  const source = sessions[0].logPath
  9:    const child = spawn('zstd', ['-dc', source], ...)      ← 唯一一次读取（生成快照）
```

`source` 只出现 **2 次**：绑定 + **唯一一次**解压。快照之后的每一次读取都指向冻结物：
`readSessionUsage(basePath)`（第 308 行）、`readSessionUsage(copyPath)`（第 309 行）、
`readDeclaredTools(basePath)`（第 318 行）、`gatherLedger({ dshHome: frozenHome })`（第 325 行）。
即**drift 窗口在结构上消失**，而不是被"更小概率"替代。

### 3.2 不是环境巧合式规避

- `const source = sessions[0].logPath` **未改动**（仍取最近会话，没有"挑最旧的/挑最大的/挑某个固定 id"）。
- 全文件**没有**新增任何按路径/大小/时间筛选会话的启发式（diff 中无相关 hunk）。
- 因此换一个工作区、换一个并发节奏，结论不变——因为**根本不再有第二次读取**。

### 3.3 同类第二处也一并解决

原先（HEAD）第 341 行的 `assert.deepEqual(fromOriginal.findings.prunePlan, report.findings.prunePlan)`
是"冻结派生 vs **活文件**派生"，同样会随漂移炸；修复把 `report` 的来源改为只含冻结快照的
`frozenHome`（第 304–306、325 行），于是两侧都是冻结派生。**断言文本未改**（第 361 行与 HEAD 同文）。

---

## 4. 必核项 4：偶发确已消除（12 次全量）—— ✅

```
$ for i in $(seq 1 12); do node --test ...; done
run 1: tests=97 pass=97 fail=0 skipped=0
run 2: tests=97 pass=97 fail=0 skipped=0
... （略）
run 12: tests=97 pass=97 fail=0 skipped=0

会话日志总字节：开始=37453815 结束=37453815 增长=0
```

**12/12 通过，fail 恒为 0，skipped 恒为 0**（t6 交付 96 项 + t11 新增 E2E⑤ = 97）。

**诚实边界（与 t11 一致，我不拿它当证据）**：这 12 次运行期间工作区会话日志增长 **0 字节**，
即窗口内团队空闲，因此"12 次全绿"只能说明**静态环境下**不抖，**不能单独证明**并发写入下的鲁棒性。
真正的证明是下一项。

---

## 5. 必核项 5：确定性反证（文件正在被并发写入）—— ✅

### 5.1 夹具（全部在工作区内，未碰 `~/.dsh/**`）

把 `DSH_HOME` 指向工作区临时 home：

| 项 | 内容 |
|---|---|
| `sessions/<key>/sess-live/session.v4.jsonl.zstd` | 真实日志内容（**只读**拷出，含 81 条 `request/header` tools 声明），由一个后台循环**持续追加完整 zstd 帧**（每帧 1 条 `tool/call`，约每 20 ms 一帧） |
| `profiles/web` | 符号链接到真实 `~/.dsh/profiles/web`（只读）——**关键**：保证归属扫描仍是真数据，避免 `prunePlan` 退化成空对空 |

对照组：用 `git show HEAD:test/e2e.test.js` 展开到符号链接农场 `oldrepo/`（`index.js`/`lib`/`node_modules`/`whitelist.js`
均软链到真实文件），使**旧用例**在同一 DSH_HOME、同一追加压力下运行。

### 5.2 原始输出（同一夹具，旧 vs 新）

```
old  run1  exit=1  pass=3 fail=1  追加帧=56  活文件行数 240→284  ✖ E2E③
        ↳ AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
new  run1  exit=0  pass=5 fail=0  追加帧=~75 活文件行数 296→359  ✔ E2E③
old  run2  exit=0  pass=4 fail=0  追加帧=74  活文件行数 371→434  ✔ E2E③
new  run2  exit=0  pass=5 fail=0  追加帧=75  活文件行数 446→509  ✔ E2E③
old  run3  exit=1  pass=3 fail=1  追加帧=58  活文件行数 520→567  ✖ E2E③
        ↳ AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
new  run3  exit=0  pass=5 fail=0  追加帧=77  活文件行数 579→643  ✔ E2E③

# 追加 6 轮 old（同一夹具）
old  run1..3,6  exit=1  fail=1  ✖ E2E③   old  run4,5  exit=0  ✔ E2E③
# 追加 6 轮 new（同一夹具）
new  run1..6    exit=0  fail=0  ✔ E2E③   （活文件每轮增长 62–64 行）
```

**汇总**：

| 版本 | 轮次 | E2E③ 失败 | 失败率 |
|---|---|---|---|
| 旧（HEAD） | 9 | **7** | 78% |
| 新（工作树） | 9 | **0** | 0% |

### 5.3 失败模式确认为"drift"，不是别的错

```
$ for f in live-old-*.log; do echo "$f: $(grep -c 'AssertionError' $f) AssertionError / $(grep -c 'zstd exit\|cannot read' $f) zstd错误"; done
live-old-1.log: 1 AssertionError / 0 zstd错误
live-old-2.log: 0 AssertionError / 0 zstd错误
live-old-3.log: 1 AssertionError / 0 zstd错误

  +   linesRead: 264      ← usageCopy（冻结副本）
  -   linesRead: 265      ← usageOriginal（活文件重读）
  +     bash: 72  toolCalls: 78
  -     bash: 73  toolCalls: 79
```

旧版的失败**全部**是 t7 定位的同一机制（同一活文件两次读取差 1 行），**零** zstd 错误 ⇒
我的夹具复现的是目标危害，而不是另一个副作用。

**因此**：修复后在"文件正在被写入"的条件下，S2 **稳定成立**（9/9），而它在修复前于同一条件下
有 78% 的概率失败。这就是"根因已消除"的确定性证据，而不是"这次没撞上"。

---

## 6. 必核项 6：其他既有判据未被削弱 —— ✅

### 6.1 逐用例断言清单

见 §1.2：E2E① = 3 条、E2E② = 37 条、E2E④ = 19 条，**完全未变**（多/少均为 0）。

### 6.2 其余测试文件断言数逐一相同

```
  SAME  test/host.test.js: 188 → 188
  SAME  test/privacy.test.js: 43 → 43
  SAME  test/reconcile.test.js: 199 → 199
  SAME  test/provide.test.js: 66 → 66
  SAME  test/cost.test.js: 36 → 36
  SAME  test/tokens.test.js: 26 → 26
  SAME  test/usage.test.js: 54 → 54
  SAME  test/whitelist.js: 0 → 0
  SAME  test/client-panel.test.mjs: 165 → 165
```

### 6.3 test/** 内不再存在"对活会话日志的两次读取比较"

```
$ grep -n "readSessionUsage|sessions\[0\]|logPath|realSessions|DSH_HOME" test/*.js
  e2e.test.js:152  readDeclaredTools(sessions[0].logPath)      ← E2E② 单次读（喂声明面）
  e2e.test.js:159  gatherLedger({ dshHome: DSH_HOME })          ← E2E② 单次读（喂计数）；与 :152 的读取**不相比较**
  e2e.test.js:278/285                                            ← E2E③ 唯一一次活文件读取（生成快照）
  e2e.test.js:308/309                                            ← 冻结 basePath / copyPath
  e2e.test.js:389–392                                            ← E2E⑤ 自己的 tmp 夹具
  e2e.test.js:420/441                                            ← E2E④ 指令链（不读会话日志）
  host.test.js:*                                                 ← 全部自建临时夹具
```

E2E② 的两处读取**各自独立、互不比较**（一次取声明面、一次取计数），因此不存在"两次读取相等"的假设。
实证：在 §5 的持续追加压力下，新版 9 轮全部 `pass=5 / fail=0`（即 E2E①–⑤ 全绿）。

### 6.4 R1 功能判据复跑

产品代码哈希未变，t7 的六套件复跑仍全绿：

```
  attribute-table.mjs exit=0        （484 条）
  pruneplan-known-answer.mjs exit=0 （193 条）
  provenance-cross-check.mjs exit=0 （65/65 逐字段一致）
  privacy-r1.mjs exit=0             （24 条）
  contract-v2.mjs exit=0            （86 条）
  real-e2e.mjs exit=0               （20 条）
```

---

## 7. 非阻断观测（4 项）

- **O1 · `PROFILE_DIR` 由 `DSH_HOME` 派生，可能让 E2E③ 的 prunePlan 交叉断言退化为空对空**。
  `test/e2e.test.js:41` `PROFILE_DIR = join(DSH_HOME, 'profiles', 'web')`。默认环境下它存在
  （§1.4 实测 prunePlan 6 单元 / 5274 tokens，断言非平凡）；但若有人在**改了 `DSH_HOME`** 的环境里跑
  （例如审阅者做隔离实验），该路径不存在 ⇒ 归属全 `unknown` ⇒ 两侧 `prunePlan` 都是 `[]` ⇒
  第 361 行**静默退化为恒真**。t11 已为"声明面"和"成本侧"加了防退化守卫，**但没有为归属侧加**。
  属**修复前就存在**的性质（HEAD 同款派生），不是 t11 引入的回归；我自建的并发夹具正是靠
  `profiles/web` 软链避开了这一陷阱，故本轮不受影响。
  **建议（不阻断）**：在 E2E③ 里补一条守卫，如
  `assert.ok(report.scope.providerScan.packages > 0, '归属扫描必须真的扫到候选包')`，
  这样"profile 缺失导致的静默退化"会直接报错而不是静默通过。
- **O2 · E2E⑤ 的 `assert.equal(liveFirst.toolCalls, liveSecond.toolCalls)`（第 395 行）** 断言
  "同一 tmp 文件两次读取不变"。该文件在两次读取之间无人写入 ⇒ **确定性、不 flaky**；
  它的作用是锚定"与 `base` 的差异来自那次刻意的追加"，因此合理。仅提示其标签
  「同一次读取之间不应变化」措辞略绕。
- **O3 · 用例数 96 → 97**：下游若有引用"96/96"的文档（如提交信息、IMPLEMENTATION-NOTES）需要同步为 97。
- **O4 · 我的 12 次全量运行期间团队空闲**（会话日志增长 0 字节）。因此"12/12"不构成并发鲁棒性的证明；
  该证明来自 §5 的 A/B 确定性夹具（旧 7/9 失败 vs 新 0/9）。这一点我明确写出来，避免被当作更强的结论引用。

---

## 8. 复现方式

```sh
# 必核项 4：12 次全量
cd dsh-context-ledger && for i in $(seq 1 12); do node --test 2>&1 | grep -E "^ℹ (tests|pass|fail|skipped)"; done

# 必核项 1/6：断言强度与断言集比对
cd dsh-context-ledger && git diff test/e2e.test.js
cd dsh-context-ledger && diff <(git show HEAD:test/e2e.test.js | grep -o "assert\.[a-zA-Z]*") <(grep -o "assert\.[a-zA-Z]*" test/e2e.test.js)

# 必核项 5：并发写入下的 A/B 确定性反证（旧 vs 新，同一夹具）
cd /home/u/Desktop/DSHWorkspace/.feas/t12-verify && bash counter-proof.sh 6 both

# 必核项 1.4：E2E③ 的 prunePlan 是否非空
cd /home/u/Desktop/DSHWorkspace/.feas/t12-verify && node probe-e2e3.mjs
```

核验脚本与原始输出：`.feas/t12-verify/`（`counter-proof.sh`、`probe-e2e3.mjs`、`logs/`）。

---

## 9. 最终判定

**pass。** t11 的修复满足全部 6 项必核要求：

1. **没有放宽任何断言**——S2 的三条核心断言逐字保留，E2E③ 8 条原有断言一条未减，全文件只新增断言（+2 条守卫 + E2E⑤ 的 6 条）；
2. 产品代码零改动（8 个文件 sha256 与 HEAD 逐一相同）；
3. 走的是**根因**（冻结基准副本，结构性消灭 drift 窗口），不是"挑稳定会话"的环境巧合规避；
4. 全量 `node --test` **12/12 通过**；
5. **确定性反证**：同一"持续追加活文件"夹具下，旧版 9 轮 **7 次失败（78%，全部是 drift）**、
   新版 9 轮 **0 次失败**，E2E③ 在文件正在被写入时稳定成立；
6. 其余判据强度不变（E2E①/②/④ 与另外 9 个测试文件断言数逐一相同；R1 六套件复跑全绿）。

4 项非阻断观测见 §7，其中 O1 建议补一条归属侧防退化守卫（非阻断、修复前既有性质）。
