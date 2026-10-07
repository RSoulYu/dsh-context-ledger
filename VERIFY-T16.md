# dsh-context-ledger — t16 独立复核报告（R6 宿主半区）

> 复核人：验证（AgentTeams 成员）
> 任务：`t16 [verify]` · kind=review（round 4，绑定 t14）· attempt `4f7fc5b9-aff9-4d83-9d7e-809ee0729b10`
> 复核基线：`5616fbc`（feat(R6): 工具级隐藏候选（宿主半区 + 面板）+ 队长裁定；工作树 clean）
> 契约基线：DESIGN **v3**（§2.18–§2.25 / §3.7 / §6 第 11 条 / §9、§9.1）
> 纪律：未修改任何实现/测试/DESIGN 文件；未触碰 `~/.dsh/**` 与 DSH 安装目录。

---

## 0. 结论

**verdict = needs_revision（1 项阻断，属"在真实宿主上不可用"级）**

四条硬约束的**代码写法**是对的，我逐条用间谍注册表验证过（H1 作用域、H2 预校验逻辑、
H3 三态降级、H4 默认不施加）；`registryUse`、省额不相加、与 `prunePlan` 并存零变化、
契约字段/取值域/排序、恒等式 H1–H7 也全部通过。

**但整条 precheck / 施加链路在真实宿主上是死代码**：

| # | 阻断项 | 定位 | 性质 |
|---|---|---|---|
| B1 | `probeRestrict` 用 `Array.isArray(view(scope).restrictableNames)` 判定接口可用性，而**真实宿主返回的是 `Set`** ⇒ 真机上恒判 `unsupported`／`interfacePresent:false`，`denyList` 恒空，opt-in 施加永不生效，且 `interfacePresent` **谎报**为 false | `index.js:686-693`（判据）/ `lib/hide.js:160`（同源隐患） | 产品缺陷（真机不可用 + 产物不实），测试夹具类型与宿主不一致，139 项套件无法察觉 |

我自己的两套审计结果：

```
================ R6 AUDIT: 141 passed / 3 failed ================   ← 3 项失败即 B1
================ PRUNEPLAN BASELINE: 24 passed / 0 failed =========   ← prunePlan 零变化
全量 node --test 连续 12 次：每次 tests=139 / pass=139 / fail=0 / skipped=0
node --check index.js + lib/*.js → exit 0；隔离 dump-config | grep -c context-ledger = 3
```

---

## 1. 阻断项 B1：`restrictableNames` 的真实类型是 `Set`，实现按 `Array` 判定

### 1.1 一手事实（只读核对 DSH 安装目录）

```
$ node -e "const p=require('./package.json'); console.log(' main:',p.main,' exports:',JSON.stringify(p.exports))"
 main: lib/index.js  exports: {".":{"types":"./lib/types/index.d.ts","default":"./lib/index.js"}, ...}

$ grep -n "restrictableNames" lib/index.js
  2906:		const known = this.view(scope).restrictableNames;          ← 宿主自己用 .has()（Set 语义）
  2969:		const restrictableNames = /* @__PURE__ */ new Set();      ← **构造为 Set**
  2972:			restrictableNames.add(name);
  2983:			restrictableNames
  第 2969 行: const restrictableNames = /* @__PURE__ */ new Set();
  返回对象: return { visible, knownNames, restrictableNames }
```

- 运行时入口是 `lib/index.js`（`main` 与 `exports["."].default` 都是它），**只有一个** `view(scope)` 实现。
- 唯一提供 `tools` 服务的包是 `dsh-tools`（`super(ctx, "tools")`，`lib/index.js:2704`）。
- 插件的 `node_modules/@deepseek-ai/dsh-tools` 解析到 `/opt/dsh/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools` —— 就是上面这个实体。
- 因此**在真实宿主上 `view(scope).restrictableNames` 恒为 `Set<string>`**。

### 1.2 实现侧的判据（要求 Array）

```js
// index.js:684-695
try {
  const view = tools.view(agent)
  const names = view?.restrictableNames
  if (!Array.isArray(names)) {                        // ← 真机永远是 true
    return { status: 'unsupported', restrictableNames: null, interfacePresent: false }
  }
  return { status: 'prechecked', restrictableNames: names.filter(...), interfacePresent: true }
```

同源隐患：`lib/hide.js:160`
```js
const known = new Set(Array.isArray(probe?.restrictableNames) ? probe.restrictableNames : [])
```
—— 即使上游把 `Set` 传进来，这里也会静默当成**空集合**，于是每个名字都被判 `not-in-restrictable-names`。

### 1.3 实测对照（我的间谍注册表：一份照宿主返回 `Set`，一份返回 `Array`）

```
=== A7 · 【实测】宿主真实类型 restrictableNames 是 Set（一手：dsh-tools/lib/index.js:2969）===
  宿主真实类型(Set)   → probeRestrict = {"status":"unsupported","restrictableNames":null,"interfacePresent":false}
  实现方夹具类型(Array) → probeRestrict = {"status":"prechecked","restrictableNames":["alpha","beta"],"interfacePresent":true}
  宿主真实类型(Set)   下 applyDenyToAgent = {"interfacePresent":false,"appliedNames":[],"skipped":[{"name":"alpha","reason":"interface-absent"},{"name":"beta","reason":"interface-absent"}]}
  实现方夹具(Array)    下 applyDenyToAgent = {"interfacePresent":true,"appliedNames":["alpha","beta"],"skipped":[]}
  真实类型下产出的 hideApply = {"mode":"suggestion-only","interfacePresent":false,"denyList":[],
    "skipped":[{"name":"alpha","reason":"interface-absent"},{"name":"beta","reason":"interface-absent"},
               {"name":"mcp__srv__x","reason":"interface-absent"}],"applySupported":false,"appliedNames":[]}
  真实类型下产出的 hidePlanStatus = unsupported
  FAIL A7 【期望】宿主真实类型(Set)下必须能 precheck（当前实现做不到）
  FAIL A8 【期望】宿主真实类型下 denyList 非空（当前实现为空）
  FAIL A9 【期望】宿主真实类型下 interfacePresent 为 true（当前实现谎报 false）
```

### 1.4 后果（对齐任务口径的严重性）

1. **H2 的预校验在真机上永不发生**：`precheck.restrictable` 恒为 `null`，
   `hideApply.denyList` 恒为 `[]`、`applySupported` 恒为 false
   —— R6 的**核心交付物（可粘贴的 deny 清单）在真机上是死代码**。
2. **H4 的 opt-in 施加永不生效**：`applyDenyToAgent`（`index.js:715-751`）第一步就 `probeRestrict`
   → 真机得到 `unsupported` → 直接返回 `appliedNames: []`、`skipped` 全部标 `interface-absent`
   —— 用户按 §2.23.4 打开 `hide.apply: true` 也不会有任何名字被施加，且**原因标注是错的**。
3. **产物不实**：`hideApply.interfacePresent` 在接口明明存在时报 `false`，
   与 §2.23.3 的"把实际探测结果写进 `hideApply.interfacePresent`"直接矛盾；
   `hidePlanStatus` 恒 `unsupported`，§2.23.3 表格的 `prechecked` 一行在真机上不可达。
4. **测试无感**：全仓库没有任何夹具喂 `Set`——
   `test/host.test.js:688-701` 的 `makeFakeTools({restrictableNames})` 原样返回调用方给的**数组**
   （`:708/:711/:723/:735/:742/:749/:757/:772/:791/:807/:859` 全传数组），
   `test/hide.test.js`、`test/reconcile.test.js` 同样传数组；
   `test/e2e.test.js` 的"真机"跑的是 `{ schemas: ... }` 假 tools 替身，从不接触真实 `ctx.tools`。
   ⇒ 连续 12 次 139/139 全绿**不能**发现它。

### 1.5 requiredFix

**（必需，产品代码）** `dsh-context-ledger/index.js:686-693` 同时接受 `Set` 与 `Array`：

```js
const raw = view?.restrictableNames
const list = raw instanceof Set ? [...raw] : (Array.isArray(raw) ? raw : null)
if (list === null) {
  // 有 view 但拿不到 restrictableNames：旧宿主，按"接口缺失"处理（§2.23.3 第 3 行）
  return { status: 'unsupported', restrictableNames: null, interfacePresent: false }
}
return { status: 'prechecked', restrictableNames: list.filter(n => typeof n === 'string'), interfacePresent: true }
```

**（建议，纵深防御）** `lib/hide.js:160` 同样容忍 `Set`：

```js
const raw = probe?.restrictableNames
const known = new Set(raw instanceof Set ? [...raw] : (Array.isArray(raw) ? raw : []))
```

**（必需，测试夹具修正）** `test/host.test.js:688-701` 的 `makeFakeTools` 默认值必须与宿主一致
（`restrictableNames` 以 **`Set`** 暴露），并补一个显式的回归用例：
`probeRestrict(<Set 形态的 view>)` 必须返回 `prechecked` / `interfacePresent: true`、
且 `hideApply.denyList` 非空——这条就是本该拦住本缺陷的用例。
数组形态可作为兼容分支保留一条用例，但**不能**继续当作唯一形态。

---

## 2. 四条硬约束的独立核验（除 B1 的类型问题外，逻辑本身正确）

### 2.1 H1 · 作用域：只在 agent 作用域内施加 —— ✅

```
=== A · H1 作用域：只在 agent 作用域内施加 ===
  `.restrict(` 调用点：
    index.js:742  tools.restrict({ deny: applicable })
  applyDenyToAgent 记录: [{"receiver":"agent.ctx.tools","filter":{"deny":["alpha","beta"]}}]
  PASS A1 全仓只有 1 处 .restrict( 调用点（已剥注释后计数）
  PASS A2 该调用点位于 agent 作用域（agent?.ctx?.tools）
  PASS A3 不存在 ctx.tools.restrict（全局）调用路径
  PASS A3b 唯一的调用点写在 agent?.ctx?.tools 上
  PASS A4 负向对照：全局施加会抛错（所以全局路径是不可用代码）
  PASS A5 施加落在 agent.ctx.tools 上（一次、名字升序）
  PASS A6 global registry 从未被调用
```

- 静态：剥掉注释后全仓**只有** `index.js:742` 一处 `.restrict(`；接收者是 `agent?.ctx?.tools`（`index.js:717`）。
- 负向对照：我的假注册表照抄宿主 `:2896-2897` 的守卫，对**无 scope** 的 ctx 调用 `restrict` 会抛
  `tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent`
  —— 即"全局施加"在真宿主上根本跑不通（不可用代码），实现没有踩它。
- 正向：间谍记录显示施加发生在 `agent.ctx.tools` 上、一次调用、名字升序去重；插件自身的
  `ctx.tools` 从未被调用。

### 2.2 H2 · 名字预校验 + "未知名不得让整条施加崩" —— ✅（逻辑正确，但见 B1）

宿主语义（一手，`dsh-tools/lib/index.js:2906-2908`）：**任一未知名让整条 `restrict()` 抛错**，不是局部失败。

```
=== B · H2 名字预校验 ===
  PASS B1 负向对照：不预校验时整条施加抛错（宿主语义）
  PASS B2 混入未知名不抛错
  PASS B3 只把通过校验的名字交给 restrict（未知名被挡在外面）
  PASS B4 appliedNames = 通过者
  PASS B5 skipped 记下未知名与原因
  PASS B6 run_code 不抛错
  PASS B7 run_code 进 skipped/reserved-name 且不进 deny
  PASS B8 restrict 收到的 deny 不含 run_code
  PASS B9 名字全消失不抛错
  PASS B10 空清单绝不施加（restrict 零调用）
  PASS B11 appliedNames 为空
  PASS B12 审计后名字消失不抛错
  PASS B13 重新校验只用当次 restrictableNames
  PASS B14 precheckOf 的判据就是 restrictableNames
```

- 混入"已失效名字"：`['alpha','ghost_gone','beta']` → 实际下发给 `restrict` 的是 `["alpha","beta"]`，
  `ghost_gone` 记入 `skipped/not-in-restrictable-names`；整条不崩 ✓
- 施加前**重新**校验成立：审计时存在、施加时消失的名字（`beta`）被重新判掉 ✓
- `run_code` 双保险：预校验 + `buildHideApply`（`lib/hide.js:315-320`）都拦 ✓
- 空清单绝不施加：`applicable.length === 0` 直接返回，`restrict` 零调用 ✓

> 注：这些结论是在"夹具按实现期待的 **Array** 形态喂入"下得到的；换成**宿主真实类型 Set** 时
> 整段路径退化为 `unsupported`（B1），所以 H2 在真机上**实际从未发生**。

### 2.3 H3 · 三态优雅降级 —— ✅

```
=== C · H3 三态优雅降级（老宿主 / 无作用域 / 接口不全）===
  PASS C1..C9  ×5 组（缺 restrict / 缺 view / view 无 restrictableNames / view 抛错 / 无 agent）
  PASS C10 restrict 抛错不逃逸
  PASS C11 restrict 抛错 → appliedNames=[]（静默降级）
```

| 情形 | probeRestrict | hidePlanStatus | restrictable | denyList | applySupported |
|---|---|---|---|---|---|
| 缺 `restrict`（老宿主） | `unsupported` / `interfacePresent:false` | `unsupported` | `null` | `[]` | false |
| 缺 `view` | `unsupported` | `unsupported` | `null` | `[]` | false |
| `view` 无 `restrictableNames` | `unsupported` | `unsupported` | `null` | `[]` | false |
| `view(agent)` 抛错 | `unvalidated` / `interfacePresent:true` | `unvalidated` | `null` | `[]` | false |
| 无 agent（HTTP 路由） | `unvalidated` | `unvalidated` | `null` | `[]` | false |
| `restrict` 抛错 | — | — | — | — | `appliedNames: []`，不抛错 |

- 五组**全部不抛错**，候选仍照常列出（诊断有效），`restrictable` 恒 `null`（未用 `false` 冒充"没查"）✓
- `restrict` 抛错 fail-soft ✓

### 2.4 H4 · 默认不施加 —— ✅（证明默认路径不调用 restrict）

```
=== D · H4 默认不施加 ===
  PASS D1..D7 ×5 组
  场景 → agent/created 监听数 / restrict 调用数：
    apply(ctx, {})                        → 0 监听 / 0 调用
    hide.apply=false（带 deny）            → 0 监听 / 0 调用
    hide 缺省 + 显式 deny                  → 0 监听 / 0 调用
    hide.apply=true 但 deny 为空            → 0 监听 / 0 调用
    hide.apply=true + deny=['alpha','beta'] → 1 监听；触发后只对 **agent 作用域** 调用一次
  PASS D8  默认产物 mode = suggestion-only
  PASS D9  默认产物 appliedNames = []
  PASS D10 默认产物仍给出可粘贴清单（denyList 非空）
```

- `installHideApply`（`index.js:1396-1413`）：`hide.apply !== true` → `return false`（**在注册监听之前**返回）；
  `deny.length === 0` → `return false`；两者都不注册任何监听 ✓
- opt-in 打开后：只在 `agent/created` 里对 **该 agent 的 ctx** 施加；插件自身的 `ctx.tools` 仍零调用 ✓
- 产物的 `mode` 只在"真的施加成功过"时才变 `applied-by-config`（`index.js:827`）✓

---

## 3. `registryUse` 已知答案 —— ✅

```
=== E · registryUse 已知答案 + 措辞红线 ===
  PASS E1  verdict 恒为 unconfirmed
  PASS E2  verdictBasis 常量
  PASS E3  modelCalls 恒 0（候选定义即零调用）
  PASS E4  nonModelCallers 常量
  PASS E5  nameReferencedElsewhere ≤3 且升序（输入 5 条 → 取前 3，字典序）
  PASS E6  上限常量 = 3
  PASS E7  无 weakEvidence 时为空数组
  PASS E8  产物中无"笼统宣称无损失"类表述（zh/en 禁令词扫描命中 0）
  PASS E9  verdict 取值域不含 safe/unused/no-loss
  PASS E10 hidePlanCaveat 五键与冻结值
  PASS E11 caveat 是副本（改产物不影响共享常量）
```

- 输入 `weakEvidence.alpha = ['/z/last.js','/a/first.js','/m/mid.js','/b/second.js','/q/fifth.js']`
  → 产物 `["/a/first.js","/b/second.js","/m/mid.js"]`（升序 + 截断 3）✓
- 禁令词扫描覆盖 `safe / no-loss / zero loss / zero-cost / unused / harmless / 无损失 / 零成本 / 无害 / 不影响 / 只影响模型 / 无副作用 / 可以安全` —— 整份 `findings` 的 189 条字符串命中 **0** ✓

---

## 4. 省额不得相加（§2.22 第 3 条）—— ✅

```
=== F · 省额不相加 ===
  hidePlanTokens=700  prunePlanReclaimableTokens=100  两者之和=800
  PASS F2 hidePlanTokens = Σ hidePlan[].tokens
  PASS F3 prunePlanReclaimableTokens = Σ prunePlan[].reclaimableTokens
  PASS F4 产物中不存在数值 800（两动作之和）
  PASS F5 native 渲染中不存在数值 800
  PASS F6 native 渲染含显式"不累加"声明
  PASS F7 两个动作在每个单元行同屏（hide … | uninstall …）
  PASS F8 inPrunePlan=false 的单元注明"无法通过卸载移除"
  PASS F9 两个字段仍是各自独立的键（未被合并）
```

- 产物里 `hidePlanTokens` 与 `prunePlanReclaimableTokens` 是两个独立数字；
  **遍历整份产物与 native 渲染的所有数值，均不出现 800**（两者之和）✓
- native 渲染的 R6 段逐单元并列两种动作 + 代价，并以固定句收尾：
  `Do not add the hide tokens to the uninstall candidates: the two actions are alternative, not cumulative.` ✓
- `inPrunePlan === false` 的单元（core / unknown / 无唯一 owner 的 plugin）显示 `uninstall is not available for this unit` ✓

实测渲染（第 2 节的基线夹具）：

```
  | Hide candidates (tool level) — needs manual confirmation: 1230 tokens in 8 tools across 5 units (status: unsupported)
  |   - plugin bundleW: hide 3 tools, 600 tokens if hidden  |  uninstall this unit: 600 tokens if unused (1 tool of this unit in use)
  |   - core (no uninstall unit): hide 1 tool, 500 tokens if hidden  |  uninstall is not available for this unit
  |   - mcp-server srvA: hide 2 tools, 100 tokens if hidden  |  uninstall this unit: 100 tokens if unused (1 tool of this unit in use)
  |   - unknown (no uninstall unit): hide 1 tool, 20 tokens if hidden  |  uninstall is not available for this unit
  |   - plugin (no uninstall unit): hide 1 tool, 10 tokens if hidden  |  uninstall is not available for this unit
  | Hide caveats: registry-level hide, not schema-only; non-model registry calls: unobservable; service coupling: unconfirmed; manual confirmation required before applying; prompt cache: one-time invalidation
  | Hide apply: suggestion-only (nothing applied by this plugin; opt-in config required)
  | Do not add the hide tokens to the uninstall candidates: the two actions are alternative, not cumulative.
```

`hidePlanCaveat` 五条**逐条**出现在 native 渲染里 ✓（§2.19 要求"工具输出 / native 渲染 / 面板三处同时呈现"；
本任务只覆盖宿主半区，面板由 t15 承担。）

---

## 5. 与 `prunePlan` 并存：字段与既有行为**零变化** —— ✅

方法：把 **v2 基线 `b00135b`** 的 `lib/*.js`（`LEDGER_VERSION = 2`、无 `lib/hide.js`）整套抽到 scratch，
与当前 v3 实现对**同一输入**运行后逐字段比较。

```
$ node pruneplan-baseline.mjs
v2 基线 = b00135b（git show b00135b:lib/*.js 全部抽出）
  HEAD(v2) LEDGER_VERSION = 2   worktree(v3) = 3
  v2 行数=19  v3 行数=28（v3 追加 9 行）
================ PRUNEPLAN BASELINE: 24 passed / 0 failed ================
```

| 比对项 | 结果 |
|---|---|
| `findings.prunePlan`（含条目、排序、items 记录） | 逐字段相同 |
| `findings.prunePlanReclaimableTokens` / `prunePlanBasis` | 相同 |
| `findings.noRecommendation`（三理由计数与顺序） | 相同 |
| `findings.zeroCall` / `topPerUse` | 相同 |
| v2 的 findings 键 = v3 findings 的前 6 键（前缀一致） | ✓ |
| `items`（含 `providedBy` / `calls` / `zeroCall` / 排序） | 相同 |
| `categories` / `totals` / `scope`（v2 的键取值） | 相同 |
| 降级态（`sessionsScanned = 0`）下上述全部 | 相同 |
| DESIGN §2.9 v2 的 13 项冻结样例 | 相同 |
| native 渲染的前 19 行（v2 全部行） | 与 v2 **逐字相同**，R6 段纯追加 |

---

## 6. 契约一致性（§2.18/§2.20）与恒等式 —— ✅

```
=== G · 契约一致性（§2.18/§2.20）与恒等式 H1–H7 ===
  PASS G1  version = 3（常量与产物）
  PASS G2  findings 键顺序（13 键，R6 七键按 §2.5 顺序追加）
  PASS G3  HideEntry 8 字段与顺序
  PASS G4  unit 3 子字段   PASS G5 registryUse 5 子字段   PASS G6 precheck 3 子字段
  PASS G7  hideApply 6 子字段   PASS G8 hidePlanUnits 7 子字段
  PASS G9  kind ∈ providedBy.kind 取值域   PASS G10 category ∈ {tools, mcp}
  PASS G11 id/tokens/name 与 items[] 逐字一致
  PASS G12 hidePlanBasis 常量   PASS G13 hidePlan 排序 tokens 降序→name 升序
  PASS G14 hidePlanUnits 排序 tokens 降序→toolCount 降序→target??kind 升序
  PASS G15 selfTool 仅对 context_ledger 为 true
  PASS H1 hidePlanTokens = Σ hidePlan[].tokens
  PASS H2 hidePlanTokens = totals.zeroCallTokens
  PASS H3 Σ hidePlan[].tokens = Σ items[zeroCall ∧ tools|mcp].tokens
  PASS H4 Σ hidePlanUnits[].tokens = hidePlanTokens 且 Σ toolCount = hidePlan.length
  PASS H5 inPrunePlan=true 的 (kind,target) ⊆ prunePlan 的 (kind,target)
  PASS H6 denyList ⊆ restrictable 名字 且 |denyList|+|skipped| = |hidePlan|
  PASS H7 usageAvailable=false ⟹ hidePlan=[] ∧ hidePlanTokens=0 ∧ denyList=[]
  PASS H7b 降级态 hidePlanStatus 仍如实（不谎报已校验，不抛错）
```

`version` 残留扫描（代码 + 测试）：

```
$ grep -rn "version: 2\|version = 2\|version:2\|\"version\": 2\|version === 2" index.js client.js lib/ test/
  test/client-panel.test.mjs:316:    version: 2,
```

命中仅 1 处，且位于 `canonicalReport()`，其注释明确写着
「**DESIGN §2.9 v2 完整示例的逐字段副本**」——是**刻意保留的 v2 形状夹具**（面板对版本不敏感），
不是产品残留：`index.js` / `lib/**` / `client.js` 中 `version` 只有 `const: LEDGER_VERSION`（=3）一处。

---

## 7. 携带项（`test/e2e.test.js` 两处健壮性修复）与断言强度 —— ✅（未放宽）

从 t11 修复点（`6185b4d`）到 `5616fbc` 的逐用例断言清单比对：

```
=== e2e.test.js 逐用例断言清单对比（6185b4d → 5616fbc）===
  SAME     E2E①                                 旧 3→新 3   +0 -0
  CHANGED  E2E②                                 旧37→新67   +32 -2
  CHANGED  E2E③                                 旧10→新14   +4  -0
  SAME     E2E④                                 旧19→新19   +0 -0
  SAME     E2E⑤（t11 的漂移回归用例）              旧 6→新 6   +0 -0
=== 放宽迹象（两版本）===
  6185b4d: assert=81  容忍/近似=0 skip/todo=0 吞错=0 字节级相等=56
  5616fbc: assert=115 容忍/近似=0 skip/todo=0 吞错=0 字节级相等=79
```

**携带项①（归属侧防退化守卫）**：由"只断言被扫数据的形状"升级为硬断言 + 新增守卫：

```
  + assert.ok(report.scope.providerScan.packages > 0, '归属扫描必须真的扫到候选包（否则归属断言会静默恒真）')
  + assert.ok(report.scope.providerScan.files > 0, '归属扫描必须真的读到源码文件')
  + assert.ok(report.items.some(item => item.providedBy?.kind === 'plugin'), '有 profile 候选时应至少归属出一个插件包')
  （E2E③ 差分侧同样补 3 条：providerScan.packages/files > 0、provenance.byName 非空、costItems 含 providedBy）
```
—— 这正是我在 t12 报告 §7-O1 提的那条建议（`providerScan.packages > 0`），**加强**而非放宽。

**携带项②（`DSH_HOME` 无 `profiles/web` 时的 E2E②）**：`subagent` 块的形状断言改为环境条件化：

```
  - assert.equal(subagent.providedBy.kind, 'unknown')
  - assert.equal(subagent.providedBy.method, 'static-scan-weak')
  - assert.ok(subagent.providedBy.candidates.length > 0)
  + assert.notEqual(subagent.providedBy.kind, 'plugin', '歧义名字绝不允许被猜成单一插件')   ← 无条件，更强
  + assert.equal(subagent.providedBy.name, null)                                            ← 无条件（同旧）
  + if (PROFILE_AVAILABLE) { 上述三条强断言原样保留 }
    else { assert.ok(['core','unknown'].includes(subagent.providedBy.kind)) }
```

**我的判读：不构成"放宽/降级断言"**，理由是：
1. 默认环境（本机 `profiles/web` 存在 ⇒ `PROFILE_AVAILABLE === true`）下，三条强断言**原样保留**，
   并额外多一条无条件的 `notEqual(kind,'plugin')` ⇒ 该路径只增强不减弱；
2. 无 profile 的分支里，"弱级多包歧义"在**结构上不可能存在**（歧义要求 ≥2 个 profile 包弱命中），
   此时断言强形态等于断言一个与数据无关的假命题；
3. 没有使用被点名的禁用手段：无 `skip`/`todo`（`skip/todo=0`）、无容忍/近似（`=0`）、无吞错、
   无删除断言、无子集化（字节级相等断言反而 56→79）；
4. `-2` 的两条是**同一表达式的改写**（补了失败信息），不是删除：
   `assert.ok(report.scope.providerScan.packages > 0)` → 同名带 message 版本。

可选加固（非阻断）：在 `PROFILE_AVAILABLE === false` 分支里把放宽**钉到原因**上，例如
`assert.ok(report.items.every(i => i.providedBy.kind !== 'plugin'))`，
这样该分支不再是"随便 core/unknown 都行"。

---

## 8. 不凭单次全绿判过：连续 12 次全量 —— ✅

```
run 1..12: tests=139 pass=139 fail=0 skipped=0   （12/12）
```

（t14 报告写 138；当前为 139，多出的一例来自 t15 的面板测试，与 t14 无关。）

---

## 9. 范围与其它验收命令

```
$ git show --stat 5616fbc --format=""
 BACKLOG.md / IMPLEMENTATION-NOTES.md / client.js / index.js / lib/hide.js / lib/reconcile.js
 test/{client-panel,e2e,hide,host,privacy,reconcile,whitelist}
 13 files changed, 4013 insertions(+), 33 deletions(-)

$ 未被触碰（sha256 与 HEAD 相同）：package.json / cordis.patch.yml / DESIGN.md / README.md  → 全部 SAME
$ 工作树：clean
```

- 产品面改动 = `index.js` + `lib/**`（t14 的 in-scope）**以及 `client.js`**。
  `client.js` 属**另一个任务 t15（实现界面）**——我用只读团队任务表确认存在 `t15 | 实现界面 | completed`，
  且该提交信息为"宿主半区 + 面板"。因此这不是 t14 的越界，而是**一次提交打包了两个任务**；
  若要严格按文件归属审计，建议后续按任务分提交。
- `node --check index.js` + `lib/*.js` → exit 0；
  `DSH_HOME=.feas/isolated-home dsh --profile testbed --dump-config | grep -c context-ledger` → `3`（exit 0）。

---

## 10. 非阻断观测（4 项）

- **O1 · §2.23.2 的"空 filter 会抛错"引用不精确**：正文把 `deny.length === 0` 的依据指到
  `dsh-tools/lib/index.js:2900`，但该行是 `restrict({})`（`allow` 与 `deny` 都未给）才抛错；
  `{ deny: [] }` 在宿主上**不会**抛错。实现的处置（空清单绝不施加）是更保守的一侧、与契约意图一致，
  只是理由的引用要对齐——建议 DESIGN v4 把该句改为"空清单没有意义且易掩盖配置错误"，或把引用改成 `:2899-2900` 的语义描述。
- **O2 · `test/client-panel.test.mjs:316` 保留 `version: 2`**：是 §2.9 v2 冻结示例的逐字段副本（legacy 形状夹具），
  已在该函数注释中说明；产品代码内无 v2 残留。若要"测试里也不出现 v2"，需把该夹具改名/加注释为 legacy。
- **O3 · H6 的边界**：`denyList.length + skipped.length = hidePlan.length` 依赖
  "每个 `hidePlan` 项都有非空且唯一的名字"（`lib/hide.js:314` 对空名字 `continue`；`denyNames` 是 Set）。
  宿主通路不产生空名/重名项（names 来自 `schemas()` 且 `cost.js` 已过滤空名），故不可达；记录为契约硬化建议。
- **O4 · 真实类型问题上，E2E 的"真机"断言无法发现**：`test/e2e.test.js` 的 E2E② 用
  `tools: { schemas: () => declared }` 的假替身（无 `restrict`/`view`），因此那里断言
  `hidePlanStatus === 'unsupported'`、`interfacePresent === false`、`denyList === []`
  只能证明"缺接口时如实降级"，**不能**代表真机行为；真机路径必须靠 `test/host.test.js` 的接口替身覆盖，
  而该替身的类型与宿主不一致（B1 的根因）。

---

## 11. 复现方式

```sh
# 四条硬约束 / registryUse / 不相加 / 契约 / H1–H7（含 B1 的 Set vs Array 对照）
cd /home/u/Desktop/DSHWorkspace/.feas/t16-verify && node r6-audit.mjs

# prunePlan 与 v2 基线逐字段零变化
cd /home/u/Desktop/DSHWorkspace/.feas/t16-verify && node pruneplan-baseline.mjs

# 全量 12 次
cd dsh-context-ledger && for i in $(seq 1 12); do node --test 2>&1 | grep -E "^ℹ (tests|pass|fail|skipped)"; done
```

原始输出：`.feas/t16-verify/logs/`（`r6-audit.log`、`pruneplan-baseline.log`）。

---

## 12. 最终判定

**needs_revision。** 四条硬约束的**写法**、`registryUse`、省额不相加、`prunePlan` 零变化、
契约与恒等式都通过（我的审计 141 通过 / 3 失败，失败的 3 条全部指向同一个根因），
但 B1 让 R6 的**核心链路在真实宿主上完全不可用**：

- `probeRestrict` 要求 `Array`，宿主给的是 `Set`（`dsh-tools/lib/index.js:2969`，`main` = `lib/index.js`，
  插件 `node_modules` 指向同一实体）⇒ 真机恒 `unsupported` / `interfacePresent:false`；
- 于是 `denyList` 恒空（核心交付物死代码）、opt-in 施加永不生效、
  且 `interfacePresent` 与 `precheck.reason`（`interface-absent`）**都不实**，与 §2.23.3 直接冲突；
- 测试夹具与宿主类型不一致，139 项全绿 + 12 次连跑都不能发现它。

requiredFix 见 §1.5（`index.js:686-693` 兼容 `Set`；`lib/hide.js:160` 纵深防御；
`test/host.test.js:688-701` 夹具默认改用 `Set` 并补 `prechecked` 回归用例）。
