# dsh-context-ledger — t19 独立复核报告（B1 修复 / 宿主真实类型）

> 复核人：验证（AgentTeams 成员）
> 任务：`t19 [verify]` · kind=review（round 5，绑定 t18）· attempt `6cd0662b-f1e0-485e-a460-f7e74bab9cef`
> 复核基线：**`d1d2c15`**（fix(B1): 兼容宿主真实返回类型 Set —— 真机不可用级修复）
> 修复前基线：**`6307c98`**（`d1d2c15^`，其 `probeRestrict` 仍是 `if (!Array.isArray(names))`）
> 契约基准：DESIGN v3 §2.23.3（三态与 `interfacePresent`）/ §2.19 / §2.20；`VERIFY-T16.md`（B1 的定位）
> 纪律：未修改任何实现/测试/DESIGN 文件；未触碰 `~/.dsh/**` 与 DSH 安装目录；未启动 web 服务。

---

## 0. 结论

**verdict = pass**

B1 已按**宿主真实类型**为准确认并修复，且**可观测判据直接达标**：
真机类型（`Set`）下 `hidePlanStatus = prechecked`、`interfacePresent = true`、**`denyList` 非空**、
`restrictable` 不为 `null`；opt-in 施加路径在真机类型下**真的下发名字**。

| 验收项 | 结论 | 关键证据 |
|---|---|---|
| 先独立核对宿主源码真实类型 | ✅ | 我自己 `require.resolve` + 读源码：`const restrictableNames = new Set()`（`dsh-tools/lib/index.js:2969`）→ 放进 `view()` 返回（`:2983`）→ 宿主自己 `!known.has(name)` 消费（`:2906`）；同族 `visible=Map`、`knownNames=Set`（§1） |
| **真机类型（Set）下的可观测判据** | ✅ | `hidePlanStatus=prechecked`、`interfacePresent=true`、**`denyList=["mcp__openviking__find","never_called_tool"]`**、`restrictable=[true,true]`、`applySupported=true`（§2） |
| opt-in 施加路径在真机类型下可达 | ✅ | `restrict` 恰被调用 1 次且收到 `{deny:["mcp__openviking__find","never_called_tool"]}`；`bash`/`gone_tool`（不在当次集合）/`run_code`（保留名）在**施加前重校验**被剔除进 `skipped`；报告 `mode=applied-by-config`（§3） |
| **夹具已镜像宿主** | ✅ | `makeFakeTools` 默认 `namesType='set'`、`view()` 返回 `{visible:Map, knownNames:Set, restrictableNames:Set}`（我**直接抽取该函数**与宿主形状对拍，三项全同）；另留 `namesType:'array'` 兼容回归一条（§4） |
| 纵深防御（Set/Array 同结果） | ✅ | `normalizeNameCollection` 两型等价、非集合 → `null`；`precheckOf`/`buildHideFindings` 在 Set 与 Array 下**产物完全一致**；非集合形状一律 `unsupported`；空 Set ⇒ `prechecked` 但 `denyList=[]` 且 `restrict` 零调用（§5） |
| 断言强度未放宽（三条禁令） | ✅ | 删除行共 5 行**全是夹具/import 重构**（无一条断言）；断言数 `257→293`、`63→78`；无容差/近似/软断言；`skipped=0` 且 B1 五个用例实测 `✔` 执行（§6） |
| 不凭单次全绿 + 确定性证明 | ✅ | 全量连续 **12 次 153/153**、t18 相关文件连续 **12 次 70/70**，均 0 fail 0 skipped；外加**修复前/后 A/B**：Array/undefined/object/Map/string 路径**逐字节相同**，只有 Set 路径翻转（`unsupported` → `prechecked`）（§7） |
| 范围核实 | ✅ | `d1d2c15` = `IMPLEMENTATION-NOTES.md` + `index.js` + `lib/hide.js` + `test/hide.test.js` + `test/host.test.js`；`client.js` / `test/client-panel.test.mjs` / `package.json` / `DESIGN.md` / `cordis.patch.yml` **均不在提交中**（§8） |

我自己的审计脚本 `set-path.mjs`：**70 passed / 0 failed**。

非阻断观测 5 项见 §9。

---

## 1. 第一步：独立核对宿主源码的真实类型（不采信任何自述）

```
$ node -e "require.resolve('@deepseek-ai/dsh-tools')"
  /opt/dsh/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js

  一手事实（我自己读该文件）：
    YES  constructed        ← const restrictableNames = new Set()
    YES  returnedInView     ← return { visible, knownNames, restrictableNames }
    YES  consumedWithHas    ← const known = this.view(scope).restrictableNames; … !known.has(name)
    YES  visibleIsMap
    YES  knownNamesIsSet
  view(scope) 定义在第 2959 行；其 return 段：
    | 		if (this.modeFor(scope) !== "native") visible.set(RUN_CODE_NAME, this.requirePtcTransport());
    | 		return {
    | 			visible,
    | 			knownNames,
    | 			restrictableNames
    | 		};
    | 	}
```

完整上下文（`:2967-2985`）：`const visible = new Map(); const knownNames = new Set();
const restrictableNames = new Set();` → 逐个 `add` → `return { visible, knownNames, restrictableNames }`。

**结论**：`view(scope).restrictableNames` 的真实类型是 **`Set`**（宿主自己用 `.has()` 消费），
与 t16/B1 的定位一字不差。夹具若继续用 `Array`，就是"自己造了一个宿主不存在的接口"——
这正是漏掉 B1 的根因，也是本轮判定"是否真的修好"的唯一基准。

---

## 2. 真机类型（Set）下的可观测判据 —— 直接证据（不是间接推断）

我用**自己写的、与宿主同形**的注册表（**不复用实现方的替身**）：

```
=== 1 · 我自己的"宿主同形"注册表 ===
  我的注册表 view() 形状：
    visible            = Map
    knownNames         = Set
    restrictableNames  = Set

=== 2 · 真机类型（Set）下的可观测判据 ===
  probeRestrict(Set 注册表) = {"status":"prechecked","restrictableNames":["never_called_tool","mcp__openviking__find","bash"],"interfacePresent":true}
  → hidePlanStatus          = prechecked
  → hideApply.interfacePresent = true
  → hideApply.denyList      = ["mcp__openviking__find","never_called_tool"]
  → precheck.restrictable   = [true,true]
  → applySupported          = true / skipped = []
```

| 判据 | 修复前（`6307c98`） | 现在 |
|---|---|---|
| `probeRestrict(Set)` | `unsupported` / `interfacePresent:false` | **`prechecked` / `true`** |
| `hidePlanStatus` | `unsupported` | **`prechecked`** |
| `denyList` | `[]`（恒空 = 核心交付物死代码） | **`["mcp__openviking__find","never_called_tool"]`** |
| `precheck.restrictable` | 恒 `null` | **`true` / `true`** |

---

## 3. opt-in 施加路径在真机类型下可达

```
=== 3 · opt-in 施加路径在真机类型下可达（H2 的"施加前重新预校验"真的执行）===
  apply(ctx, {hide:{apply:true, deny:["never_called_tool","mcp__openviking__find","bash","gone_tool","run_code"]}})
    → agent/created 监听 1 个
  restrict 实际收到 = [{"deny":["mcp__openviking__find","never_called_tool"]}]
  applyDenyToAgent 结果 = {"interfacePresent":true,
    "appliedNames":["mcp__openviking__find","never_called_tool"],
    "skipped":[{"name":"bash","reason":"not-in-restrictable-names"},
               {"name":"gone_tool","reason":"not-in-restrictable-names"},
               {"name":"run_code","reason":"reserved-name"}]}
  → 报告 hideApply = {"mode":"applied-by-config","interfacePresent":true,
      "denyList":["mcp__openviking__find","never_called_tool"],"skipped":[],
      "applySupported":true,"appliedNames":["mcp__openviking__find","never_called_tool"]}
```

- **S1**：`restrict` 恰被调用 **1 次**，且下发的正是通过**当次**校验的名字（顺序为升序）；
- **S2**：审计时在配置里、但**不在当次 `restrictableNames`** 的名字（`bash`、`gone_tool`）被剔除 ⇒
  H2 的"施加前**重新**校验"在真机类型下**真的执行**（不是文件里写着而已）；
- **S3**：保留名 `run_code` 以 `reserved-name` 单独标注；
- **S4**：名字在审计后消失时（单独夹具）只施加剩下的：`appliedNames=["never_called_tool"]`、
  `skipped=[{mcp__openviking__find, not-in-restrictable-names}]`；
- **S5**：真机类型下 `mode=applied-by-config` 可达且 `appliedNames` 非空（修复前这条路径不可达）。

---

## 4. 夹具是否**真的**镜像宿主（本轮最高优先项）

1. 读 `makeFakeTools`（`test/host.test.js:699-724`）：默认 `namesType = 'set'`，
   `view()` 返回 `{ visible: new Map(...), knownNames: new Set(...), restrictableNames: Set }`；
   只有显式 `namesType: 'array'` 才给数组。
2. **我自己把该函数从测试文件里抽出来**（按大括号配平，不经测试框架）与宿主真实形状对拍：

```
  sig@32358 bodyBrace@32485
  宿主真实形状  : visible=Map, knownNames=Set, restrictableNames=Set
  夹具默认形状  : visible=Map, knownNames=Set, restrictableNames=Set
  夹具显式数组  : restrictableNames=Array
  → 夹具默认与宿主同形: true
  → 夹具 view() 是否齐宿主三字段: true
```

3. **是否还有替身在用与宿主不一致的类型**：全仓扫描 `test/**` 的 `restrictableNames` 用法——
   - 传给 `makeFakeTools({restrictableNames: [...]})` 的 11 处**不是**不一致：夹具内部会 `new Set(...)`
     包起来（`test/host.test.js:714`），所以它们**自动走真机路径**；
   - 其余数组用法都在**纯函数边界**（`precheckOf` / `buildHideFindings` 的入参，
     其声明类型本就是 `string[]|null`，`probeRestrict` 也正是在这里交付数组）——
     而且 `test/hide.test.js:254/260` 现在对**同一语义**分别用 `new Set(['a_tool'])` 与 `['a_tool']`
     各测一遍，属纵深防御而非迁就；
   - `test/host.test.js:1026` 的内联替身也给 `new Set()`。
   → **未发现任何替身默认用数组型接口**。

4. 新增的机械防线（`test/host.test.js:919-933`）：只读
   `require.resolve('@deepseek-ai/dsh-tools')` 源码，断言
   `const restrictableNames = new Set()` / 放进 `view()` / 宿主 `!known.has(name)` 消费，
   并断言默认夹具给出 `Set`（`visible`=Map、`knownNames`=Set）。
   **宿主将来若改成数组，这条会显式失败**，而不是让套件继续绿——正是针对 B1 根因的防线。

---

## 5. 纵深防御：Set 与 Array 等价，非集合形状仍如实降级

```
=== 4 · 纵深防御 ===
  PASS 4.1 normalizeNameCollection(Set)   = ["a","b"]
  PASS 4.2 normalizeNameCollection(Array) = ["a","b"]
  PASS 4.4 Map / object / undefined / string / number / null  → 一律 null（6 例）
  PASS 4.5 precheckOf(Set 来源) 与 (Array 来源) 一致
  PASS 4.6 precheckOf：Set 型不得被静默当空集合（a 必须 restrictable=true）
  PASS 4.7 buildHideFindings：Set 与 Array 产物**完全一致**
  PASS 4.8 buildHideFindings：Set 下 denyList 非空（纵深防线成立）
  非集合形状的探测结果：
    Map        → {"status":"unsupported","restrictableNames":null,"interfacePresent":false}
    object     → 同上        undefined → 同上        string → 同上        number → 同上
  PASS 4.10 非集合形状一律 unsupported + interfacePresent=false（5/5）
  空 Set → probe={"status":"prechecked","restrictableNames":[],"interfacePresent":true}；denyList=[] status=prechecked
  PASS 4.12 空 Set ⇒ prechecked + interfacePresent=true，但 denyList 空 / applySupported=false
  PASS 4.13 空 Set 下 restrict 从未被调用（空清单绝不施加）
```

要点：
- `lib/hide.js:81` 的 `normalizeNameCollection` 把**两处类型假设收敛成一个判据**（`index.js` 与 `lib/hide.js`
  共用），这正是"B1 是只有一处类型假设写错"的结构性修法；
- 修复**没有**放宽成"什么都接受"：`Map`（宿主另一个真实类型！）仍被判 `unsupported`——
  这是对的，因为 `Map` 不是名字集合；把它当集合才是过度接受；
- 空 `Set` 的语义正确：**接口可用**（`prechecked` / `interfacePresent:true`）但**没有可限制的名字**
  ⇒ `denyList=[]`、`applySupported=false`、`restrict` 零调用（不把"可用但空"误报成"接口缺失"，也不施加空清单）。

---

## 6. 断言强度未被放宽（既有三条禁令逐项）

**禁令①：不得近似/容差/软断言/跳过/降级断言**

```
=== 被删除/改写的行（host.test.js + hide.test.js）===
  -  RESERVED_TOOL_NAMES, buildHideApply, buildHideFindings, buildHidePlan, precheckOf,   ← import 重排
  -import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'                 ← 需 readFileSync/createRequire
  -/** 假 tools 服务：可控地暴露 restrict / view / restrictableNames。 */                    ← 替换为新的夹据注释
  -function makeFakeTools({ restrictableNames = null, hasRestrict = true, ... }) {          ← 替换为 namesType 版
  -      return { restrictableNames }                                                        ← 替换为宿主同形返回
  （test/hide.test.js：1 行 import 重排）
```

- **5 行删除全部是夹具/import 重构，没有一条断言被删或改弱**；
- 断言数**只增不减**：`test/host.test.js` 257 → **293**；`test/hide.test.js` 63 → **78**；
- 无 `tolerance` / `approx` / `closeTo` / `assert.ok(true)` / 软断言；
- `skip:` 只出现在既有的 `{ skip: hostSkip }`（`hostSkip = host === null`，宿主包不可解析时的环境守卫）
  与新增 `tripwireSkip`（同源守卫），且**实测 `skipped=0`**；
  B1 的五个用例单独跑显示 **`✔` 真的执行**：

```
$ node --test test/host.test.js | grep B1 ·
  ✔ B1 · 夹具对拍宿主源码：restrictableNames 的真实类型是 Set（默认夹具必须一致） (1.004822ms)
  ✔ B1 · 回归：Set（宿主真机类型）⇒ prechecked + interfacePresent=true + denyList 非空 (7.359847ms)
  ✔ B1 · 回归：Set 下 opt-in 施加路径真的下发名字（H2 的"施加前重新预校验"在真机类型下可达） (10.111007ms)
  ✔ B1 · 兼容性回归：数组型 restrictableNames 仍然可用（旧替身/旧宿主形态） (10.725549ms)
  ✔ B1 · 非集合形状仍如实判 unsupported（Map / 普通对象 / undefined 不得被当成可用接口） (0.366043ms)
```

**禁令②：不得改产品语义迁就夹具** —— 用**修复前/后 A/B** 直接证伪（§7.2）：
数组路径逐字节相同，唯一差异就是 Set 路径（那正是要修的）。产品语义零漂移。

**禁令③：不得把 Set 用例换成"能过的类型"** —— 反向检查：夹具默认**已经从数组换成 Set**（更难的那种），
数组只在显式 `namesType:'array'` 的兼容用例里出现；且接口替身由**只读宿主源码的 tripwire** 兜底。

---

## 7. 不凭单次全绿：连续 12 次 + 确定性证明

### 7.1 逐次结果

```
全量 node --test 连续 12 次：
  run 1..12: tests=153 pass=153 fail=0 skipped=0        ← 12/12 全绿
t18 相关文件（host/hide/reconcile/privacy/whitelist/e2e）连续 12 次：
  run 1..12: pass=70 fail=0 skipped=0                   ← 12/12 全绿
```

> **归因说明**：全量是 153 项，而 t18 报告的是 147 项——多出的 6 项来自**面板线 t20 正在飞的工作**
> （工作树里 `client.js` / `test/client-panel.test.mjs` 处于未提交修改状态，属 t20，不在 t18 范围内）。
> 为免把别线的波动误算到 t18 头上，我另跑了**只含 t18 相关文件**的 12 次（70/70）。
> 两组都 0 fail / 0 skipped。

### 7.2 确定性证明（不是"这次跑绿了"）：修复前/后 A/B

基线 `6307c98`（修复前）的闸门：`if (!Array.isArray(names)) {`。

```
=== 6 · 超集证明 ===
  修复前基线 = 6307c98 docs: 仓库发布就绪 …
  SAME  数组（全部可限制）  修复前={"status":"prechecked","restrictableNames":["a","b","c"],"interfacePresent":true}
  SAME  数组（空）          修复前={"status":"prechecked","restrictableNames":[],"interfacePresent":true}
  SAME  数组（含非字符串）  修复前={"status":"prechecked","restrictableNames":["a","b"],"interfacePresent":true}
  SAME  undefined          修复前={"status":"unsupported",…,"interfacePresent":false}
  SAME  普通对象            修复前={"status":"unsupported",…}
  SAME  Map                修复前={"status":"unsupported",…}
  SAME  字符串              修复前={"status":"unsupported",…}
  DIFF  Set（宿主真机类型） 修复前={"status":"unsupported","restrictableNames":null,"interfacePresent":false}
                            WT ={"status":"prechecked","restrictableNames":["a","b"],"interfacePresent":true}
  PASS 6.3 【B1 的机械复现】修复前（6307c98）对 Set 判 unsupported —— 与 t16 报告逐字一致
  PASS 6.4 修复后对 Set 判 prechecked
```

外加：
- 同一 Set 输入重复 **500 次**，`probeRestrict` 结果字面恒等；同一 Set 对象再重复 **200 次**亦恒等；
- `Set` 的 4 种构造方式（字面量 / 逐条 `add` / 从 Map keys 派生 / 逆序）得到**同样的名字集合**；
- 静态：`probeRestrict` 函数体内**不再出现 `Array.isArray`** 类型闸门，类型判据只来自
  `normalizeNameCollection`（§9-O4 说明顺序事项）；
- 全仓已无 `Array.isArray(view…restrictableNames)` 形态的残留闸门（扫描为空）。

---

## 8. 范围核实

```
$ git show --name-only --format="" d1d2c15
  IMPLEMENTATION-NOTES.md
  index.js
  lib/hide.js
  test/hide.test.js
  test/host.test.js
$ # client.js / test/client-panel.test.mjs / package.json / DESIGN.md / cordis.patch.yml
  → 在 t18 提交中出现的次数均为 0
```

- t18 的提交**只含** `index.js` + `lib/**` + `test/**`（外加 `§9` 允许的 append-only 实施线记录），
  未越界；面板线的 `client.js` / `test/client-panel.test.mjs`（工作树中的 t20 在飞改动）**未被 t18 触碰**；
- 我未修改任何文件；工作树里我只新增了自己的报告与 scratch 脚本（`VERIFY-T19.md`、`.feas/t19-verify/**`）。

---

## 9. 非阻断观测（5 项）

- **O1 · `tripwireSkip` 是环境守卫**：`@deepseek-ai/dsh-tools` 不可解析时会跳过对拍用例
  （与既有 `hostSkip` 同源）。本环境可解析 ⇒ 实测 `✔` 执行、`skipped=0`，判据成立。
  若希望"宿主包缺失"在 CI 里显式失败而非跳过，可另加一条环境前提用例；非本轮缺陷。
- **O2 · tripwire 用正则匹配宿主源码**：宿主把 `new Set()` 改写成别的等价形式会让该用例变红。
  这正是"宿主类型变了要显式失败"的**设计意图**，但代价是与宿主实现细节耦合；记录为取舍。
- **O3 · `probeRestrict` 保留集合的迭代顺序**（宿主 `Set` 是插入序），
  排序由下游 `hideApply.denyList` 的 `uniqueSorted` 保证。这是**真实属性**而非缺陷——
  记录在案以免后人"顺手"在探测层加排序而改变 `prechecked` 的返回形态。
- **O4 · 全量用例数从 147 变 153**：差额来自面板线 t20 的在飞测试，与 t18 无关；
  所以我同时给出 t18 相关文件的 70/70 独立循环，避免归因混淆。
- **O5 · 宿主 API 返回值类型普查（我的抽样复核）**：`tools.schemas(scope)` 返回
  `[...this.view(scope).visible.values()].map(...)` ⇒ **Array**（`dsh-tools/lib/index.js:3023-3024` ✓）；
  `skills.list()` 返回 `(await this.snapshot()).skills`，而 `skills` 是
  `[...collected.entries.values()].map(...).sort(...)` ⇒ **Array**（`dsh-skill/lib/index.js:224` ✓）；
  `FsInfo` 是 interface（`dsh-fs/lib/types/types.d.ts:67` ✓）。抽查三项与自述一致，
  "同族隐患只此一处"的判断我没有反例。

---

## 10. 复现方式

```sh
# 一手宿主类型 + 真机类型（Set）判据 + opt-in 施加 + 纵深防御 + 确定性 + 修复前/后 A/B
cd /home/u/Desktop/DSHWorkspace/.feas/t19-verify && node set-path.mjs
# 夹具形状 vs 宿主形状（抽取夹具函数直接对拍）
cd /home/u/Desktop/DSHWorkspace/.feas/t19-verify && cat logs/fixture-vs-host.log
# 连续 12 次
cd dsh-context-ledger && for i in $(seq 1 12); do node --test 2>&1 | grep -E "^ℹ (tests|pass|fail|skipped)"; done
cd dsh-context-ledger && for i in $(seq 1 12); do node --test test/host.test.js test/hide.test.js test/reconcile.test.js test/privacy.test.js test/whitelist.js test/e2e.test.js 2>&1 | grep -E "^ℹ (pass|fail|skipped)"; done
```

原始输出：`.feas/t19-verify/logs/`（`set-path.log`、`fixture-vs-host.log`）。

---

## 11. 最终判定

**pass。** B1 的根因（**夹具自洽 ≠ 实现与宿主一致**）被两条互补的修法真正解决：

1. **以宿主为准的类型判据**：`normalizeNameCollection` 收敛了 `index.js` 与 `lib/hide.js` 的类型假设，
   真机 `Set` 得到 `prechecked` + `interfacePresent:true` + **`denyList` 非空** + `restrictable` 非 `null`，
   opt-in 施加在真机类型下**真的下发名字**并保留"施加前重新校验"；
2. **夹具对齐宿主 + 机械防线**：接口替身默认改为宿主同形的 `Set`（我抽函数对拍三项全同），
   并新增**只读宿主源码**的对拍用例——宿主若改类型，套件会显式失败而不是继续绿。

同时修复是**严格超集**：Array/undefined/object/Map/string 路径与修复前逐字节相同（A/B 证明），
唯 Set 路径翻转；断言数只增不减（257→293、63→78），无一条断言被删或放宽，`skipped=0`；
全量 12 次 153/153、t18 相关文件 12 次 70/70 全绿；范围严格限于 `index.js` / `lib/**` / `test/**`。
