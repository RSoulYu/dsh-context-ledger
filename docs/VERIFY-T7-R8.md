# dsh-context-ledger — t7 独立复核报告（C4 §2.21 升序 + C5 防漂移指纹）

> 复核人：验证（AgentTeams 成员）
> 任务：`t7 [review, round 8]` · kind=review（绑定 **t6**）· attempt `3ad4d47f-ca66-4eab-814b-6b99df350135`
> 复核对象：`DESIGN.md` §2.21 / §2.21.1（C4）· `test/client-panel.test.mjs` 的 J1/J2/J3（C5）· `test/reconcile.test.js` 的宿主侧 A18 · `test/host.test.js` 的一处正则
> 基线（**按团队规则钉死不可变引用**）：`3f8daf7`（R8 之前的提交）；辅助参考 `VERIFY-T17.md:368`（上一轮记录下的"修正前"顺序）
> 方法：自建 jsonc 抽取器 + 花括号配平夹具抽取器 + 深比对器 + 独立指纹实现（`harness5.mjs`）；
> **对抗性实做**：6 次故意变异（`t7-mutate.sh`），每次都要求"显式红 + 复原到逐字节相同"
> 纪律：未修改任何实现/测试文件；变异全部在同一任务内复原（变异前后 sha256 逐字节相同，见 §2.7）；未触碰 `/opt/dsh/node_modules/@deepseek-ai/dsh/**` 与 `~/.dsh/**`；未启动 web 服务

---

## 0. 结论

**verdict = pass（未通过项：无）**

| # | 验收项 | 结论 | 决定性证据 |
|---|---|---|---|
| 1 | **指纹是真防线而非摆设** | ✅ | **实做 6 次变异**：夹具改值 / 夹具反转顺序 / DESIGN 改值 / DESIGN 回退为降序 → **J1+J2（必要时加 J3）显式红**；只改指纹常量 → **J2 单独红**；只改格式 → **仍全绿**；每次复原后 sha256 与基线逐字节相同（§2） |
| 2 | **A18 是真断言而非装饰** | ✅ | 我自己构造乱序/重复/超限/脏值/长路径输入喂 `lib/hide.js` 与 `reconcile()`，输出**确实是升序去重截断到 3**；实现侧 `reconcile.test.js:1486-1516` 的同类断言也确有其事（§3） |
| 3 | **13/13 SAME 是真机械比对** | ✅ | 我用**自己的**抽取器/比对器独立解析 DESIGN §2.21 与夹具：`13/13 SAME`、整块 deepEqual **0 处差异**；并独立重算指纹 = 钉死常量（§4） |
| 4 | **C4 真修了、且只改顺序** | ✅ | 与钉死基线 `3f8daf7` 逐字段比对：§2.21 差异**恰好 4 处** = 数组两位置（C4）+ `version` 与 `zeroCallBasis`（v4 契约变更，`DESIGN §2.5` 明列）；**其余 24 项/全部 tokens/unit/caveat 零改动**；两数组**多重集完全相同**（§5） |
| 5 | **无产品代码改动** | ✅ | `git diff 3f8daf7..HEAD -- lib/` = **仅 `lib/reconcile.js`**（t2 的 v4 工作）；`index.js`/`lib/reconcile.js` 的 sha256 与我 t4 复核时记录的值一致 ⇒ **t6 零产品改动**（§6） |
| 6 | **不凭单次全绿** | ✅ | 干净条件下**连续 12 次全量**（每次 179/179 pass、0 fail、0 skipped，每次前后整树 hash 一致）（§7） |
| 7 | **断言强度未被放宽** | ✅ | 无新增 skip/todo、无近似/容差；删除的断言全部是 `version 3→4` / 键集 `+V4_KEYS` 的**值更新**；用例数与断言点只增不减；`host.test.js` 唯一一处 matcher 放松（`items` → `items?`）经独立评估为**修掉与相邻行 `units?` 不一致的过严写法**，且单数行为仍被 `reconcile.test.js:496` 的严格等式钉住（§8） |
| 8 | **范围核实** | ✅ | 本轮改动只在 `DESIGN.md`（§2.21 排序 + §2.21.1 A18）与测试文件；`lib/**` 仅 t2 的 `reconcile.js`；工作区未提交改动 = 队长写入的 NOTES 规则 14 行 + 我的 `VERIFY-T4-R8.md` §14（§9，含本仓库"单次 squash 提交"导致的隔离限制说明） |

自建脚本：`.t4-verify/harness5.mjs`（**18 通过 / 0 失败**）、`.t4-verify/t7-mutate.sh`（6 个变异用例，日志 `.t4-verify/t7-mutations/*.txt`）。

---

## 1. 方法与基线

- **基线钉死**（团队规则）：所有 A/B 用 `3f8daf7`，不出现 `git HEAD`（HEAD 已被提交推进，拿它当旧版会退化成"自己和自己比"，静默通过）。
- **自建三件套**：jsonc 抽取（标题 → 下一个 ```jsonc → 到行首 ``` 结束 → `JSON.parse`）；夹具抽取（`const R6_EXAMPLE = ` 起，花括号配平，字符串/注释感知，再 `new Function('return (...)')`）；深比对（路径化差异列表）。指纹用我自己的 canonical JSON（递归排序键）+ sha256，**不调用被测代码里的任何函数**。
- **对抗性实做**：变异脚本对 `DESIGN.md` / `test/client-panel.test.mjs` 做定点替换，跑 `node --test test/client-panel.test.mjs`，记录红点与断言原文，随后 `cp` 复原并**逐字节校验 sha256**；`trap ... EXIT` 兜底，任何中途失败也会复原。

```sh
$ node .t4-verify/harness5.mjs
  A/B 基线（钉死）= 3f8daf7
  === DESIGN §2.21 vs R6_EXAMPLE（我的独立实现）===
    SAME  tool / unit / version
    SAME  items（24 项逐字段）
    ...（13 组全 SAME）
    （整块 deepEqual：0 处差异）⇒ 13/13 SAME
  ...
###### harness5 结果：PASS 18 / FAIL 0 ######
```

---

## 2. 第一优先：指纹是否真能让测试失败（6 次变异实做）

| 变异 | 对象 | 期望 | 实测（`node --test test/client-panel.test.mjs`） |
|---|---|---|---|
| M1 | 夹具值：`"version": 4` → `5` | J1+J2 红 | **fail 2**：✖ J1 ✖ J2（`tool / unit / version.version: DESIGN=4 夹具=5`） |
| M2 | 夹具数组顺序：subagent 两条路径反转 | J1+J2(+J3) 红 | **fail 3**：✖ J1 ✖ J2 ✖ J3 |
| M3 | 夹具**只改格式**（多一个空格） | 仍全绿 | **pass 59 / fail 0**（指纹与保真比对都与格式无关） |
| M4 | DESIGN §2.21 值：subagent `"tokens": 402` → `403` | J1+J2 红 | **fail 2**：✖ J1 ✖ J2 |
| M5 | DESIGN §2.21 数组**回退为降序**（复现 C4 老违规） | J1(A18)+J2 红 | **fail 3**：✖ J1 ✖ J2 ✖ J3 |
| M6 | **只改钉死指纹常量**最后一位 | J2 红 | **fail 1**：✖ J2（其余 58 条全绿）⇒ 常量确实参与断言，不只是打印 |

原始断言原文（节选，来自 `.t4-verify/t7-mutations/*.txt`）：

```
M2 · J2（指纹闸门，期望 vs 实际）
  AssertionError: DESIGN §2.21 测试夹具 的内容指纹漂移了。
    期望（钉死）：cc5e143e4399e0cb6878efb9facbed09687d7c9fbe2572a80274bec889ac4a36
    实际：        4f63376061d777cdda85d5ca73dbec6f9a00156a869d37d42e0e4db9e30fb681

M5 · J3（A18 在 DESIGN 数据上当场被拦住）
  AssertionError: DESIGN §2.21/subagent: 必须升序（§2.19 / A18；默认 sort = 码元序）
    + actual - expected
      [ + '@nanmicoder/.../harness-compat.js',  '/linxin666/.../index.js',  - '@nanmicoder/.../harness-compat.js' ]

M1 · J1（保真比对给出路径化差异）
  AssertionError: §2.21 契约与夹具漂移（tool / unit / version）：
    tool / unit / version.version: DESIGN=4 夹具=5
```

**归因说明（我自己那次并发）**：第一次 10 连跑（`t7-block`）的 run 5 出现 J1+J2 红且整树 hash 中途变化（`4f210ce6…` → `c6b968ab…` → 回）——那是**我自己的变异脚本与测试并发**造成的（变异→复原窗口被测试读到）。我据此把该轮判为"污染轮"，另在**无其它写入者**的条件下重跑 12 次（§7，全绿、hash 全程一致）。这是"先归属、再结论"的同一纪律，也再次印证：**不能让门禁在有写者时给出结论**。

### 2.7 复原证据

```
=== 变异前 sha256 ===
4e32037ce61694913b84b288287c312442d4f66de4b5779805ee144848e29927  DESIGN.md
761f4bd0226d42276fb01c30c48f3f10eb58f45efae43b14ded8fef1d4c5e956  test/client-panel.test.mjs
…
最终 sha256 与基线一致 ⇒ 工作树干净
 M IMPLEMENTATION-NOTES.md      ← 队长写入的团队规则（非我）
 M VERIFY-T4-R8.md              ← 我 t4 的 §14 复确认（非本轮变异）
?? VERIFY-T5-R8.md
```
六个变异用例每次都打印"复原 OK（sha256 与基线逐字节相同）"；收工 `git status` 里**没有任何测试/DESIGN 文件的改动**，仓库内也没有我的临时文件（日志与备份都在仓库外的 `.t4-verify/`）。

---

## 3. A18 是真断言：独立构造输入喂实现

`lib/hide.js:95` 的 `uniqueSorted()` + `:241` 的 `slice(0, NAME_REFERENCED_LIMIT)`（`NAME_REFERENCED_LIMIT = 3`，`:56`）。我**自己造**输入，直接验行为：

```sh
  NAME_REFERENCED_LIMIT = 3
  (a) 输入（乱序） = ["/z/last.js","/a/first.js","/m/middle.js"] → 输出 = ["/root/a/first.js","/root/m/middle.js","/root/z/last.js"]
  (b) 输入（含重复） = ["/b/x.js","/a/y.js","/a/y.js","/b/x.js"] → 输出 = ["/a/y.js","/b/x.js"]
  (c) 输入（5 个乱序） = ["/e.js","/a.js","/d.js","/b.js","/c.js"] → 输出 = ["/a.js","/b.js","/c.js"]（升序后取前 3）
  (d) 输入（脏值混入） = ["/b.js",42,"",null,"/a.js",{},…] → 输出 = ["/a.js","/b.js"]（非字符串/空串被过滤）
  (e) 真实形态长路径（喂反序）→ 输出 = 按码元序升序
  (f) reconcile() 全链路（乱序 + 重复）→ ["/a.js","/m.js","/z.js"]
  (g) DESIGN §2.21 示例里的 subagent 数组：自身升序、去重、≤3
  [PASS] 2a–2g 全部通过
```
即：**清单文字与实现行为一致**（清单声称"实现 = uniqueSorted(...).slice(0,3)"，实测正是如此）。

实现侧的同类断言确实存在（不是只在 DESIGN 里写一句话）：

```js
// test/reconcile.test.js:1486-1516（我读的原文）
for (const entry of findings.hidePlan) {                      // 24 条逐项
  assert.ok(referenced.length <= 3, …)
  assert.deepEqual(referenced, [...referenced].sort(), …)
  assert.deepEqual(referenced, [...new Set(referenced)], …)
}
assert.deepEqual(subagent…, [linxin666 路径, nanmicoder 路径], 'A18：示例里唯一非空项按升序落值')
// 乱序 + 重复输入 ⇒ 升序去重后截断到 3（实测行为，不是照抄契约文字）
assert.deepEqual(scrambled…, ['/a/first.js','/b/second.js','/m/middle.js'], …)
```

---

## 4. 13/13 SAME 是真机械比对（我的独立实现）

```
  === DESIGN §2.21 vs R6_EXAMPLE（我的独立实现）===
    SAME  tool / unit / version
    SAME  items（24 项逐字段）
    SAME  hidePlan 条数/名字序列/各 tokens
    SAME  hidePlanTokens / hidePlanBasis / hidePlanStatus / hidePlanUnits
    SAME  hideApply / hidePlanCaveat
    SAME  prunePlan / prunePlanReclaimableTokens / zeroCallBasis / noRecommendation
    （整块 deepEqual：0 处差异）⇒ 13/13 SAME

  DESIGN 指纹（我算）= cc5e143e4399e0cb6878efb9facbed09687d7c9fbe2572a80274bec889ac4a36
  夹具指纹（我算）  = cc5e143e4399e0cb6878efb9facbed09687d7c9fbe2572a80274bec889ac4a36
  钉死常量           = cc5e143e4399e0cb6878efb9facbed09687d7c9fbe2572a80274bec889ac4a36
```
- 13 组 + 整块 deepEqual 是我**另写一套**得到的结果，与 J1 打印的 13/13 独立吻合。
- 指纹我在**不调用被测函数**的前提下重算，两侧都等于钉死常量 ⇒ 该常量不是"随手写死的数字"，而是当期内容的真实哈希；且 M6 证明它参与断言。

---

## 5. C4 只改了顺序：与钉死基线逐字段比对

```
  与 3f8daf7 的差异总数 = 4
    · §2.21.findings.hidePlan[2].registryUse.nameReferencedElsewhere[0]: "…@nanmicoder…harness-compat.js" vs "…@linxin666…index.js"
    · §2.21.findings.hidePlan[2].registryUse.nameReferencedElsewhere[1]: "…@linxin666…index.js" vs "…@nanmicoder…harness-compat.js"
    · §2.21.findings.zeroCallBasis: 仅 B 有 = "model-tool-calls-in-window"
    · §2.21.version: 3 vs 4
  基线 subagent 数组 = ["…@nanmicoder…harness-compat.js","…@linxin666…index.js"]（降序）
  当前 subagent 数组 = ["…@linxin666…index.js","…@nanmicoder…harness-compat.js"]（升序）
  授权差异分类 = [ …, …, "…zeroCallBasis", "…version" ]
  非授权差异 = []
  [PASS] 3a-数组多重集不变（仅顺序） / 3b-顺序从非升序改为升序 / 3c-零非授权差异 / 3d-version 3→4 / 3f-items 零改动
```
- **只有 4 处差异**，其中 2 处就是 C4 的排序修复（同一对路径的两个位置互换），另 2 处是 v4 契约变更（`version`、`zeroCallBasis`，后者在 `DESIGN §2.5` 字段表里明列"v4 新增"，属 t1 的契约工作）。
- 24 个 `hidePlan` 项的 tokens/unit/precheck/selfTool、`hidePlanUnits`、`hidePlanCaveat`、`hideApply`、`items` 全部**零改动**（`3f` 断言：items 相关差异 = []）。
- **第二份独立参考**：`VERIFY-T17.md:368` 在上一轮就记录了修正前的形态是"`@nanmicoder/…` → `@linxin666/…`，而按码点 `@linxin666` 应排在**前**" —— 与我从 `3f8daf7` 读到的降序完全一致，两条来源互相印证。
- **诚实的限制**：仓库把 t1/t2/t3/t6 的成果压成**一次提交**（`9c1c228`），因此 git 里**不存在**"v4 已冻结但 C4 未修"的中间快照；我无法把"立即修正前"的 §2.21 单独取出来。我用 `3f8daf7`（唯一可用的不可变旧版）+ `VERIFY-T17.md:368` 两条独立参考得到上面结论，并将"除顺序外零改动"表述为"除 C4 那两处顺序与两处已声明的 v4 变更外，其余全部逐字段相同"。

---

## 6. 无产品代码改动

```sh
$ git diff --name-only 3f8daf7..HEAD -- lib/
lib/reconcile.js                     # 只有 t2 的 v4 工作

$ sha256sum index.js lib/reconcile.js      # 与我 t4 复核时记录的值一致
5963b702a8ad84c4c2735ca33c9e4b387e2f2eb8d42b1a4309134a5c8b57d8b5  index.js
70ba107801a1d4efa92d16d655263f22045b9ff4f6be053ab28a09b078cb0465  lib/reconcile.js
```
`lib/hide.js` / `cost.js` / `provide.js` / `tokens.js` / `usage.js` **不在提交集**（= 与 `3f8daf7` 逐字节相同）；`index.js` 与 `lib/reconcile.js` 的哈希与 t4 复核时的记录**一字不差** ⇒ 在本轮（C4/C5）里 **t6 零产品代码改动**。

---

## 7. 连续全量 `node --test`（干净条件 12 次）

```
t7-clean run 1..12: ℹ tests 179 ℹ pass 179 ℹ fail 0 ℹ cancelled 0 ℹ skipped 0 ℹ todo 0
                    | tree 4f210ce63406982b->4f210ce63406982b（每次前后一致）
```
（另有被我自己变异脚本污染的 10 连跑一轮：run 5 红、整树 hash 中途变化 —— 已在 §2 归因，不计入判据。）

---

## 8. 断言强度

| 文件 | 删除行（含断言） | 新增 skip/todo | 新增近似/容差 | 用例数 | 断言点 |
|---|---|---|---|---|---|
| `test/client-panel.test.mjs` | 18（2 条断言：`zhKeys` 键集与键数） | 0 | 0 | 68 → **90** | 528 → **692** |
| `test/reconcile.test.js` | 9（3 条：`version` / `LEDGER_VERSION` 3→4） | 0 | 0 | 25 → **30** | 275 → **381** |
| `test/host.test.js` | 9（4 条：3×`version` 3→4 + 1 处渲染正则） | 0 | 0 | 24 → **31** | 293 → **402** |

- 删除的断言全部是**值更新**（`version 3→4`、词典键集 `+V4_KEYS`），不是删断言；用例与断言点只增不减。
- 唯一一处 matcher 放松的**独立评估**：`host.test.js:916` 由 `/… : \d+ items, \d+ tokens/` 改为 `\d+ items?, \d+ tokens`。我核对了三点：① `renderLedger` 的 `plural()` 在 `3f8daf7` 就存在（`lib/reconcile.js:524`），且 t4 已证该渲染段与 v3 **字节级相同**；② 基线同一处的**下一行本来就是** `\d+ units?`（`3f8daf7:test/host.test.js:582`），即"旧写法与相邻行自相矛盾"；③ 单数行为仍被 `test/reconcile.test.js:496` 的严格等式 `assert.equal(lines[18], 'No actionable unit: 1 item, 402 tokens (unknown attribution 1)')` 钉住。⇒ 判定为**修掉过严/自相矛盾的 matcher**，不是"为了让指纹通过而放宽"，且与指纹机制（J2）无关（M1–M6 证明指纹本身照常红）。

---

## 9. 范围核实

```sh
$ git diff --name-only 3f8daf7..HEAD
.feas/dump.err, .feas/dump.yml, .feas/profile-backup/…, .feas/web-copy/…,
DESIGN.md, IMPLEMENTATION-NOTES.md, VERIFY-T4-R8.md, client.js, index.js,
lib/reconcile.js, test/client-panel.test.mjs, test/e2e.test.js, test/host.test.js,
test/privacy.test.js, test/reconcile.test.js, test/whitelist.js

$ git status --porcelain          # 工作区当前未提交改动
 M IMPLEMENTATION-NOTES.md        # 队长写入的团队规则（A/B 基线必须钉死；14 行；我读过原文）
 M VERIFY-T4-R8.md                # 我的 t4 §14 复确认
?? VERIFY-T5-R8.md                # 我的 t5 报告
```
- 本轮（C4/C5）在仓库里的落点是 `DESIGN.md`（§2.21 排序 + §2.21.1 的 A18）与测试文件；`.feas/**` 是设计期工作区伴随物，`VERIFY-*.md` 是验证线交付物。
- **限制说明**：`9c1c228` 是一次 squash 提交（含 t1/t2/t3/t6），所以"逐轮的范围隔离"无法从 git 单独取得。我用两条可核事实替代：① `lib/` 下只有 `reconcile.js`（t2 的 v4）；② 测试侧的 C4/C5 机制（J1/J2/J3、A18 断言、`items?`）都能在提交内容里定位到具体行号（§3/§8）。

---

## 10. 非阻断观测 / 未能构造反例的项

| # | 项 | 说明 |
|---|---|---|
| O1 | **无法从 git 取到"立即修正前"的 §2.21 快照** | 单次 squash 提交所致（§5）。我用 `3f8daf7` + `VERIFY-T17.md:368` 两条独立参考替代，未发现任何未声明的差异；但"只改顺序"这一条的**最强形式**（与紧邻前态逐字节对比）本轮**未能构造**，如实记录。 |
| O2 | `host.test.js:916` 的 `items?` 是 matcher 放松 | 见 §8 的三点评估，判为合理修复；若队长要求"零放松"，可改为对该夹具断言单数形态的严格等式（`1 item`）——属可选加固，非缺陷。 |
| O3 | J3 只覆盖 DESIGN 与夹具两份数据 | 实现侧行为由 `test/reconcile.test.js:1486-1516` 覆盖，且我用独立输入复现（§3）；两处合起来构成闭环。 |
| O4 | 指纹只覆盖 §2.21 | t6 报告称 §2.9 的副本尚无哈希（J4 只做 deepEqual）。属**已知候选**（t6 明示未做），非本轮范围。 |
| O5 | 我的 t7 连跑曾与变异脚本并发 | 已在 §2 归因，并另跑干净 12 连；规则性结论：门禁运行期间不得有写入者。 |

---

## 11. 未通过项

**无。** 本报告不含 `findings`，`verdict = pass`。

---

## 12. 复现命令清单

```sh
# 1) 独立比对 + A18 行为（自建，不调用被测断言）
cd /home/u/Desktop/DSHWorkspace/.t4-verify && node harness5.mjs

# 2) 指纹对抗性验证（6 个变异；自动复原并逐字节校验）
bash t7-mutate.sh                      # 日志：t7-mutations/M1..M6.txt

# 3) 干净条件下连续全量
cd ../dsh-context-ledger
for i in $(seq 1 10); do
  before=$(sha256sum index.js lib/*.js client.js test/*.js test/*.mjs DESIGN.md | sha256sum | cut -c1-16)
  node --test 2>&1 | grep -E '^ℹ (tests|pass|fail|skipped)'
  after=$(sha256sum index.js lib/*.js client.js test/*.js test/*.mjs DESIGN.md | sha256sum | cut -c1-16)
  echo "tree $before->$after"
done

# 4) 范围与基线（基线钉死，禁用 HEAD）
git diff --name-only 3f8daf7..HEAD -- lib/
git diff --stat 3f8daf7..HEAD -- DESIGN.md test/
git status --porcelain
```
