# 实现纪要 · 契约澄清与已知缺口

本文件记录实现线在施工中发现、**不属于设计变更**的契约澄清，以及队长对每条的裁定。
验证线（t4）必须按本文件的裁定口径执行，不得自行另立标准。

---

## F1 · S3 白名单缺 `id` 规则

**发现方**：实现宿主（t2）
**事实**：DESIGN §3.4 的 S3 白名单未给 `id` 留规则。§2.4 规定 `id = "<category>:<name>"`，含 `:`，无法通过 `NAME_PATTERN=/^[A-Za-z0-9_.-]{1,128}$/`。按字面规则执行会把自己的合法输出判为违规。
**实现方处置**：在 `test/whitelist.js` 中补了 `<category>:` 前缀规则，未改设计、未改产品代码。

**队长裁定：接受，但验证线必须独立确认它没有开出漏洞。**

理由：
- `NAME_PATTERN` 的管辖对象是**来自日志的常驻项名字**（用于挡住畸形名字导致的假零调用），不是 canonical `id`。两者混用是设计的疏漏，不是实现的越权。
- 关键安全性论据：`id` 由 `category` + `name` 拼接而成，二者**均来自声明侧**（`ctx.tools.schemas()` / `ctx.skills.list()`），**不来自日志载荷**。因此给 `id` 单独开规则不会让任何日志内容进入产物。

**验证线必须做的**：独立确认上述论据成立——即 `id` 的两个组成部分确实只来自声明侧，且在真实日志下 S3 依然零违规。若发现 `id` 任何一部分可被日志载荷污染，**F1 判定反转，此项即为不通过**。

---

## F2 · §7 的 `ReconcileInput` 没有承载回放计数的字段位

**发现方**：实现宿主（t2）
**事实**：DESIGN §7 冻结的 `ReconcileInput = { cwd, sessionsRoot, scope: Omit<scope,"usageAvailable">, items, findingsLimit? }` 中**没有任何字段可以传入调用计数**；而 §7 同时规定 `calls`/`tokensPerCall`/`zeroCall`/`usageBasis` 一律由 `reconcile` 赋值。即：契约要求 reconcile 赋值，却没有给它赋值的输入通道。这是设计的**真实缺口**，不是实现的问题。
**实现方处置**：接受顶层 `callsByName` 或 `scope.callsByName`，并额外容忍 `item.observedCalls` / `item.calls` 作为输入；未改设计。

**队长裁定：v1 接受现有实现，但记为 DESIGN v2 待办。**

理由与保留：
- 缺口客观存在，实现必须选一条路走，接受现状是合理的，不值得为此卡住 v1。
- **但容忍多条输入通道是真实的坏味道**：§7 的原则是"单点真理"，多通道会让未来调用方（例如 HTTP 路由与工具入口）各走一条路而不自知，一旦行为分歧极难定位。
- **DESIGN v2 必须收敛为单一通道**。

**验证线必须做的**：确认多通道容忍**不会导致行为分歧**——即同一份数据从不同通道传入时，`calls`/`tokensPerCall`/`zeroCall` 结果一致。不一致即为缺陷。

---

## F3 · `formatBytes(n): number` 是笔误

**发现方**：实现宿主（t2）
**事实**：§7 把 `formatBytes` 的返回类型写成 `number`，但按语义它是展示字符串（如 `"1.2 KB"`）。
**队长裁定：确认为笔误，实现按字符串返回是正确的。** 无需修改设计即可放行，DESIGN v2 一并订正。

---

## 已知缺口（队长已判定，不在本次修复范围）

| 项 | 状态 | 理由 |
|---|---|---|
| `package.json` 的 `files` 列了 `README.md` 但文件不存在 | **已由队长补齐** | 见仓库 `README.md` |
| 仓库不在任何 git 仓库内，无法提交 | **已由队长处理** | 按用户裁定「工作区新建仓库，先不建远端」执行 `git init` |
| `truncated` / `namesRejected` 以英文字段名直接呈现在中文面板证据行 | 维持原样 | DESIGN §4.5 键集已冻结，自行造键才是越线；为仅在扫描被截断时出现的边缘态升契约版本不划算 |
| DESIGN v2 需订正：§7 输入通道收敛、`formatBytes` 返回类型 | 待办 | 见 F2 / F3 |

---

## 验证线的口径约束（汇总）

1. F1 的 S3 白名单扩展口径**沿用** `test/whitelist.js` 的 `<category>:` 前缀规则，但必须独立验证其安全性论据（见 F1）。
2. F2 必须验证多通道一致性（见 F2）。
3. 隐私终审口径：**禁止访问任何工具参数**（`data.arguments`）。逐技能次数保持 `calls=null` / `unobservable`；技能维度只允许分类级 `mechanismCalls` / `mechanismTokensPerCall`。DSH 只有单一 `skill` 工具、技能名位于其参数中（`dsh-tool-skill/lib/index.js:60-65`），已在 DESIGN §6.1 否决"读参数取技能名"方案，队长确认为终审。

---

## 验证后裁定（t4 报告 §9 五项观测）

t4 独立验证已通过（478 条断言 / 0 失败）。以下是队长对五项非阻断观测的裁定——**全部无需改代码**。

### O1 · t2 自述的「renderLedger 与 §2.11 逐字节相同」表述不准确

**事实**（t4 核实）：DESIGN §2.11 是**节选**（零调用项给 3 行，`topPerUse` 只给 2 行，而其上限是 10）；实现渲染全部 `topPerUse` 行，因此完整输出**不可能**与节选逐字节相同。t4 逐行核对确认：**每行都符合 §2.11 冻结模板，首 8 行与末行逐字节相同**。

**队长裁定：实现正确，t2 的表述被 t4 更正并取代。** 正确表述为「与 §2.11 模板逐行一致，与节选部分逐字节相同」。此为文档层面更正，**不改代码**。

### O2 · `?cwd=` 诊断旋钮在无 agent scope 时成本侧退化

**事实**：DESIGN §4.1 声明的面板路径是 `?session=<id>`；`?cwd=` 是**实现自加**的旋钮（不在设计中）。只给 `?cwd=` 时 `agent` 为 `undefined`，`ctx.tools.schemas()` 返回 DSH 的全局视图 ⇒ 成本侧退化为 1 项。usage 半区仍完整（39 会话可用 / 扫 20 / 1978 次调用），且**如实降级为 `usageAvailable=false`，未伪造零调用**。

**队长裁定：不构成契约违背，保留现状；DESIGN v2 必须记录该旋钮的语义（或直接移除）。** 依据 DSH 自身惯用法：`registry.schemas(exec.agent)`（`dsh-tools/lib/index.js:1402`），省略 scope 即全局视图（同文件 3020-3025 注释明示）。**注意**：此旋钮是设计中不存在的额外表面，v2 若判定不需要应删。

### O3 · 多通道在矛盾输入下的行为

**事实**：`sessionsScanned=0` 却给出非空 `callsByName` 时，`scope.toolCalls=4` 而所有 item 声明 `no-evidence`。
**队长裁定：归入既有 F2 的 v2 待办（输入通道收敛），无需单独处置。** 理由：**宿主通路不可能产生该组合**（`gatherLedger` 只把成功回放的会话计入 `callsByName`，非空 ⟹ `sessionsScanned>=1`），故不可触达。关键安全性质仍成立：不产生假零调用，`findings.zeroCall` 仍为 `[]`。

### O4 · 同类内混入不可观测项会让整类 `calls` 变 null

**事实**：`lib/reconcile.js:337-339` —— 仅当该类**每一项** `calls !== null` 时类级 `calls` 才为数字之和，否则为 `null`。可触达条件仅为常驻项名字未过 `NAME_PATTERN` 护栏（DESIGN §3.3 称"理论上不该发生"）。

**队长裁定：行为正确，不改代码；DESIGN v2 补一句定论。**
理由：本插件的核心原则是**绝不把未知伪装成已知**。部分可观测时给 `null` 虽然损失了"39/40 已知"的信息，但它避免了把一个不完整的和当作完整的报告——这与全程"不产生假零调用"的立场一致。若未来要保留部分信息，应新增独立的"部分可观测"状态，而不是放宽 `null` 的语义。**DESIGN §2.3 现有措辞对该态无唯一读法，属 v2 待订正项。**

### O5 · `formatBytes` 返回类型

与本文 F3 裁定一致（设计笔误），确认放行。

---

## 覆盖缺口（t4 如实标注，队长承接）

**`?session=<id>` 的 agent 解析链路没有真实端到端证据。**

- t4 已验证：`?cwd=` 路径（HTTP 200）、客户端 bundle 在真实启动图中被接受并真机执行、`agents.get(sessionId)` 与 `sessions.get(id).header.cwd` 的**静态 API 符合性**（一手 file:line，含服务已加载的 dump-config 证据）。
- **未能验证**：在真实 web 宿主里用真实会话 ID 打通完整链路。
- **原因（边界真实存在）**：隔离 `DSH_HOME` 内没有活动会话（产生会话需要真实模型回合，而隔离 home 无凭据）；且纪律禁止以真实 `~/.dsh` 托管 web 服务。

**队长评估**：该缺口无法在现有权限边界内闭合。曾尝试在隔离环境内以程序方式创建会话以补齐，未找到可用的会话创建入口（DSH 的会话创建不走 REST，未定位到可用 RPC），已停止投入。

**闭合该缺口需要二者之一**：
1. 授权将本插件临时装入真实 profile，打开面板一次确认四类条目非空，随后卸载；
2. 由用户自行安装后反馈结果。

在此之前，本插件的验证状态应表述为：**核心链路与隐私边界已验证通过，面板的 `?session=` 取数路径缺少真实会话的端到端证据。**

---

## R1（v2）实现纪要 · 自主决策记录（t6）

按 DESIGN §9 的文件归属矩阵，`IMPLEMENTATION-NOTES.md` 归实现线（append-only）；
以下为 v2 §10.1 的 D 类（可自主）决策记录，**未改动任何冻结字段名/取值域/排序/恒等式**，
也未触碰队长既有裁定。

### D1 · `attributeNames` 的第三个参数（§7 签名）

**事实**：§7 写 `attributeNames(names, hits, bundles)`。但 §2.13 判定表的 8 行**没有任何一行**需要
bundle 归属信息——`candidates` 是"命中的 profile 包名"，第 2/5 行的唯一性也只按包名判；
bundle 归属只服务于 `prunePlan.target`（§2.16），由 `buildPrunePlan` 单独接收 `bundleOwners`。

**处置**：实现为 `attributeNames(names, hits, options)`，`options = { candidatesLimit }`；
不存在的第三个参数不接。这是**未冻结的私有接口细节**（D2），不影响任何 canonical 输出。

### D2 · `ScanResult` 的内部形状与单趟实现

`ScanResult = { strongHits, weakHits, evidence, files, bytes, capped }`，其中
`strongHits/weakHits` 为 `Record<name, Array<{pkg, file}>>`（按包名、文件路径升序去重），
`evidence` 为 `Record<name, string[]>`（该级命中文件路径升序，调用方取所需子集的最小者）。
§7 只给了字段名未给值型，这是"未冻结但必须选一个"的机械细节（D3）。

单个文件只做**一趟**正则扫描：`(\bname\s*:\s*)?(["'`])(A|B|…)\2`，
可选前缀是否匹配即强/弱之分。语义与"逐个名字依次 `test` 强级、弱级"等价——
`test/provide.test.js` 用参照实现（`strongPattern` / `weakPattern` 逐个名字）做对拍证明。

### D3 · `scope.providerScan` 的计数口径

- `files` / `bytes` 只计**源码**（`.js` / `.mjs` / `.cjs`）与**实际读取**的字节（UTF-8 字节数）。
  profile `package.json` 与 bundle patch 属于**清单读取**，不计入源码扫描足迹
  （§2.2 的措辞是"实际读取的源码文件数"）。
- 本机实测（`~/.dsh/profiles/web` + 核心作用域）：**385 包 / 1594 文件 / 49.4 MB / `capped: true`**。
  t5 原型测得 387 包 / 1593 文件 / 47.1 MB；其中 **核心根完全吻合（288 包 / 545 文件）**，
  其余差异来自 ① 计数单位（UTF-8 字节 vs UTF-16 码元，中文注释多的包差得最多）、
  ② profile 的 `link:` 包（`dsh-annotate` / `dsh-context-ledger`）指向工作区，内容在迭代中会变。
  `capped: true` 是**正确行为**：本机确有前端 bundle 单文件超过 3 MiB（§2.14 已列明 3 个）。
- `evidenceFile` 取"获胜包集合内"字典序最小的命中文件（§2.13）。实测例：`bash` 的
  evidenceFile 落在 `dsh-tool-bash-persistent/lib/index.js`（`-` 0x2D < `/` 0x2F，字典序确实最小），
  §2.9 示例里的 `dsh-tool-bash/lib/index.js` 是节选示例值，规则本身以"最小者"为准。

### D4 · 测试组织

- 新增 `test/provide.test.js`（`scanCorpus` 对拍、判定表 8 行、省额不重复计入）；
- S5（溯源哨兵）落在 `test/privacy.test.js`（纯函数层：语料含哨兵）与
  `test/host.test.js`（宿主层：真实临时 profile + bundle patch 夹具）；
- S3 白名单（`test/whitelist.js`）补 v2 字符串类别：`PACKAGE_PATTERN`、4 个 `kind`、
  2 个 `PruneEntry.kind`、3 个 `reason`、4 个 `method`、`high`/`low`、`model-tool-calls-only`。
  另显式放行**空串**：`reconcile` 在调用方未给 `sessionsRoot` 时缺省为空串，它不携带任何内容。

### D5 · 性能写法（不引入缓存）

单文件"每名字一趟"改为一趟合并正则（名字按长度降序排交替式），本机实测
**3703 ms → 409 ms（暖缓存，1594 文件 / 49 MB）**；§2.14 的"不引入任何缓存层"照旧遵守
（HTTP 路由的 60 s 结果缓存是 v1 既有件，未动）。同步 `readdir`/`stat`/`realpath` 保留，
因为 §2.14 要求 `realpath` 去重防符号链接环。

### D6 · native 渲染的未冻结措辞

§2.11 是**模板节选**，以下细节未冻结，按最自然的读法实现（面板文案另见 §4.7）：

| 情形 | 实现 |
|---|---|
| 单复数 | `1 item` / `2 items`、`1 tool` / `2 tools`、`1 unit` / `2 units`（模板两种形态都出现过） |
| 单元行同时有"在用工具"与"事实包" | 两个括号**各自成组**、以两个空格分隔，保证每一组都与模板对应形态逐字一致：`… if unused  (1 other tool of this unit is in use)  (provides @a, @b)` |
| `noRecommendation` 全 0 | 仍打印该行、不带括号：`No actionable unit: 0 items, 0 tokens` |
| 理由短语 | `core` / `no owner bundle` / `unknown attribution`（模板只给了第三种，其余按同一风格） |

### F4 · §7.1 规则 4 的落地（"输入即事实"）

`scope.toolCalls` 由**宿主回放**提供时原样输出（§7.1 规则 4），只有在调用方未提供时才由
`matchedCalls + callsUnmatched + namesRejected` 现算；`callsUnmatched` / `callsUnmatchedNames`
同理（给了就用，没给就从 `callsByName` 现算）。宿主通路上两者逐位相等
（`gatherLedger` 只把成功回放的会话计入 `callsByName`，回放行数 = 命中 + 未匹配 + 被拒），
因此 §2.6 恒等式 5 在真实数据上依然成立（`test/reconcile.test.js` 与 E2E 均已断言）。

### 解释性说明 · §2.16 规则 3 的"命中自身"

`P === B` 的来源与其它事实包一致：读 B 自己的 `dsh.bundle.patch` 文本，其中出现 `P` 的名字面量
即算命中（**不排除**自身）。本机 4 个"自持"bundle（`@changfenhuang/dsh-genui`、
`@liustack/modlens`、`@nanmicoder/dsh-agent-teams`、`dsh-annotate`）的 patch 都写了自己的包名，
因此都解析出唯一 owner。未额外引入"P === B 就无条件算命中"的捷径——那会与"按 patch 文本判定"
冲突，且实测无收益。

---

## F5 · §2.16 恒等式 2 **有条件成立**（已上报队长，未改设计）

**发现方**：实现宿主（t6）
**事实**：§2.16 恒等式 2 写作
`Σ prunePlan[].reclaimableTokens = Σ items[zeroCall===true ∧ providedBy.kind ∈ {plugin, mcp-server}].tokens`。
但 §2.15 的排除表规定：`plugin` 项若其事实包**找不到唯一可卸载 bundle**，则进
`noRecommendation.reason = "no-owner-bundle"`，**不**进 `prunePlan`。两者同时成立时，
只要存在一个这样的孤儿 plugin 包，恒等式 2 的左端就**必然小于**右端。

**最小反例**（`test/reconcile.test.js` 的"省额不重复计入"用例）：
两个 plugin 事实包（100 + 50 tokens）共属一个 bundle → prunePlan 150；
另一个 plugin 事实包（10 tokens）无 owner → noRecommendation.no-owner-bundle 10；
一个 mcp-server 项（70 tokens）→ prunePlan 70。
则 Σ prunePlan = 220，而 Σ(plugin|mcp-server 零调用项) = 230 ⇒ 恒等式 2 差 10。

**处置**：实现按 §2.15 / §2.16 的**规范条文**（排除表）执行——孤儿 plugin 项不给动作；
恒等式 2 在 `noRecommendation.no-owner-bundle === 0` 时成立（§2.9 黄金样例与本机实测都是这一情形，
两条都已断言）。**若队长认为恒等式 2 应无条件成立**，需要的是"把孤儿 plugin 项也算进省额"或
"收紧恒等式 2 的措辞"二者之一的**契约变更**（§10.2 E1/E4），实现线不自行决定。

### 可复现的核对命令

```sh
cd dsh-context-ledger && node --test           # 96 用例全绿
node --test test/reconcile.test.js             # 含 F5 的最小反例与 §2.9 黄金样例
```

---

## 队长裁定 · R1（t6）交付复核（2026-10-07）

### 复核方式与结论
队长**独立重跑** t6 的三条 verify，未采信自述：
- `node --check index.js` + 全部 `lib/*.js` → 全部通过
- 全量 `node --test` → **96 项 / 96 通过 / 0 失败**（与 t6 自述一致）
- 可加载性：直接 `import('./index.js')` 并构造假 ctx 调用 `apply()` → **未抛错，工具正常注册**。宿主是 link 安装、工作区即线上代码，此项须每次改动后复核。

**判定：R1 达标（价值标尺 ①新能力）。** 真机产出 5 个可执行单元 / 3376 tokens，并带 `usedToolCount` 使卸载代价可见——这正是把"诊断"变成"可决策候选"的那一步。

### F5 裁定（§2.16 恒等式 2 有条件成立）—— **实现正确，契约表述不精确**
t6 指出恒等式 2 只在 `noRecommendation.no-owner-bundle === 0` 时成立，并给出最小反例（220 vs 230）。
**队长裁定**：
1. **实现无误**。§2.15 排除表明确要求"找不到唯一可卸载 bundle 的 plugin 项不给动作"，因此只要存在孤儿 plugin 包，`Σ prunePlan < Σ(plugin|mcp-server 零调用项)` 是**契约语义的必然结果**，不是缺陷。
2. **不精确的是契约本身**：§2.16 把该恒等式写成了无条件形式。正确表述应带条件：
   `Σ prunePlan.reclaimableTokens === Σ(plugin|mcp-server 且 zeroCall===true 项) − Σ(noRecommendation.no-owner-bundle.tokens)`
3. **处置**：记为 **DESIGN v3 订正项**；本次**不改代码、不改 DESIGN v2**（t8/t10 正依赖 v2 施工）。
4. **验证线口径**：t7 **不得**按字面无条件断言该恒等式，应按上述条件式核对；若按字面断言并判为缺陷，即为复核口径错误。

### D1 裁定（§7 `attributeNames` 第三参数）—— **备案即可，无需动作**
该参数只服务 `prunePlan.target`，canonical 形状未变，属实现私有细节。确认无需修改契约。

### 队长另报一项：测试套件偶发不稳定（已移交 t7 查证）
队长复核时**连续两次**跑出 `95 通过 / 1 失败`，随后重跑变为 `96 通过 / 0 失败`；逐文件单跑则全部通过。即存在**仅在并发/全量运行时失败**的用例，最可能来源是某用例依赖**实时变化的真实会话日志**（本会话自身正在写日志，可能读到写入中的文件）。
**这不是 t6 的过失**（它交付时确为全绿），但属真实质量风险：一个会随机变红的套件会让后续每次复核都失去判据。已要求 t7 定位并给出结论。

---

## 队长裁定 · R1 修复回路（t11 → t12）收口（2026-10-07）

### 结论：R1 通过独立复核（t12 verdict = pass）
链路：t7 判 needs_revision（唯一阻断 B1）→ 系统自动派生 t11 修复 → t12 复审 pass。**这是 `kind=review` + `reviewedTaskId` 配对生效的直接证据**：对照 t4 那一轮用的是 `kind=work`，那种情况下复核失败不会自动派生修复与复审，需队长手工续派。

### B1 与修复（队长已独立复核）
B1 根因：`test/e2e.test.js:273` 取 `sessions[0]`（最近被修改的会话日志）——在并发团队工作区里常常正是**别人的活动会话**，随后 `:294` 重读同一个正在被写入的活文件并断言两次读取相等。**产品风险经三条判据排除**（无该不变量 / 截断 `.zstd` 后 7-7 均 fail-safe 计入 `sessionsUnreadable` / 真实端到端 20-20 通过）。

队长对照三条禁令核验 t11 修复：
1. **未放宽 S2**：`git diff` 中断言区无任何 `-` 行；唯一新增的是 `+ assert.deepEqual(copy, base)`——**加强**。t12 进一步逐字核对：三条 S2 断言「一字未改」，全用例 +2/-0，全文件 assert 73→81、字节级相等断言 51→56，且 `tolerance/approx/soft/assert.ok(true)` = 0、吞错 `catch {}` = 0、无 skip/todo/子集化。
2. **未动产品代码**：`git diff --name-only` 仅 `test/e2e.test.js`；t12 另用 sha256 核对 `index.js`/`lib/**`/`package.json`/`client.js` 与 HEAD 逐一相同。
3. **修根因而非绕开**：`source` 在 E2E③ 内只出现 2 次（绑定 + 唯一一次解压），此后全部读 `basePath`/`copyPath`/`frozenHome`；未新增任何"挑稳定会话"的启发式。

**超出最低要求**：t11 自行发现**同类第二处**（原 `:341` 的 prunePlan 交叉断言同为"冻结派生 vs 活文件派生"）并一并修复。

**决定性证据**：t12 的 A/B 并发夹具（会话日志每 ~20ms 追加完整 zstd 帧）——**旧版 9 轮 7 次失败（78%），新版 9 轮 0 次失败**，每轮活文件增长 62–64 行。这排除了"只是这次没撞上"。

### 队长对 t12 非阻断项的处置
- **O1（归属侧缺少防退化守卫）——记为携带项，不单独成轮。** `test/e2e.test.js:41` 的 `PROFILE_DIR` 由 `DSH_HOME` 派生；若在**改过 DSH_HOME** 的环境里运行，该路径不存在 ⇒ 归属全 unknown ⇒ 两侧 prunePlan 都是 `[]` ⇒ 第 361 行**静默恒真**。t11 已为"声明面"与"成本侧"加了守卫，**归属侧未加**。t12 建议补 `assert.ok(report.scope.providerScan.packages > 0)`。
  **队长裁定**：这是**修复前既有的性质**（HEAD 同款派生），非 t11 回归，故不阻塞 R1。用户明确要求"不做每次只修一点点的零散改动"，因此**不为此单开一轮**；改为**携带项**——下一次有任务改动 `test/e2e.test.js` 时必须一并补上该守卫（R6 的实现会触及测试，届时执行）。
- **O3（用例数 96→97）——已订正**：本文档前述"96 项 / 96 通过"应读作修复前的计数；**修复后为 97 项 / 97 通过**。后续引用以此为准。
- O2（E2E⑤ 标签措辞）、O4（t12 自陈连续 12 次全绿发生在团队空闲期、并发鲁棒性由 A/B 夹具证明而非连跑）——**均接受**。O4 的自我限定是正确的：它没有把有利证据说过头。

---

## 队长裁定 · R2 面板交付（t8）与一处真实崩溃缺陷（2026-10-07）

### 结论：R2 达标，同时命中 **①新能力** 与 **③修复真实缺陷**
- ①：§4.7 的七条呈现义务全部上屏，F1–F12 逐条有具名用例；54 键 zh/en 同键。
- ③：**修复了 v1 面板的真实崩溃缺陷**（见下）。

队长独立复核：`node --check client.js` 通过；`node --test test/client-panel.test.mjs` **28/28**；全量套件 **109/109**；改动范围仅 `client.js` 与 `test/client-panel.test.mjs`。

### ③ 真实缺陷：面板一打开就崩（已由 git 一手证据确认）
v1 的 `client.js:876`（`git show HEAD:client.js`）为：
```
? h(PanelBoundary, { key: 'panel', t: t }, LedgerPanel({ ... }))
```
而 `LedgerPanel` 是**含 hook 的组件**（同文件 :571 定义）。把它当**普通函数调用**会将该组件的 hook 内联进父组件的 hook 链；而该调用又位于 `?` **条件分支**内 ⇒ 展开/收起面板会改变父组件的 hook 数量 ⇒ React 抛
`Rendered more hooks than during the previous render`，**浏览器一打开面板即崩**。

**这条缺陷的意义超出 R2 本身**：它正落在队长早先明确标记过的**唯一未验证路径**上——t4/t7/t12 的验证覆盖了 bundle 加载与落座，但**从未在浏览器里真正展开过面板**。队长的原话是"面板取数路径缺真实会话证据"，而实际藏着的是一枚必崩的雷。**验证覆盖到哪里，缺陷就只在哪里被排除；未覆盖处不是"大概没事"，而是"不知道"。**

修复：改为 `h(LedgerPanel, {...})` 独立实例 + 两个块改为无 hook 纯渲染函数，并加 **F10 静态守卫**（防止该写法回归）。队长已确认 `h(LedgerPanel, …)` 在位（`client.js:1309`），守卫测试存在。

### 队长对 E4-1/2/3 的裁定
- **E4-1（`cl.pruneUsedTools` 一个键要承载两种措辞）——接受现状，记为 DESIGN v3 拆分项。**
  实现选择"不增删冻结键名，用 `|` 分隔变体"（0/单数/复数，`variantText()` 按下标选）。队长裁定：**在"冻结键集不可增删"与"满足 §4.7 两态措辞"之间，它选了保住冻结键集，这是正确的取舍**（键集是面板与测试的接口面，破坏它代价更大）。风险已知：若某语言译文正文含 `|` 会破坏解析；当前两语言均不含。**v3 应拆为 2–3 个独立键并删除该编码。**
- **E4-2（caveat 原文带 markdown 强调符）——接受。** 面板不是 markdown 渲染器，去掉 `**` 后逐字落地是正确处理；保留星号反而会让用户看到字面 `**`。v3 应把该键的契约文案改为纯文本以消除歧义。
- **E4-3（acceptance 写"六条"，§4.7 实为 7 条）——接受实现方的做法（按 7 条全做）。**
  **这条错在我的任务文本**：我在 t8 的 subject 与 acceptance 里写了"§4.7 六条硬性呈现义务"，而 §4.7 实际有 7 条（我只读到第 6 条就下了计数）。实现方**没有迁就我的错数**，而是按契约做全 7 条并上报差异——这是正确处理。记为我的规格性表述失误（与教训文档中同类）。
- **D6 自主项（hint 措辞、代表工具名取 3 + 「…」、mcp-server 的 factPackages 用中性占位「—」、noRecommendation 按理由分组计数且不从 `items[]` 反推）**——**全部接受**。其中"不从 `items[]` 反推分组"正确遵守了 §5 v2 禁止面板重算的规定。

### 携带项汇总（均属测试健壮性，不单开轮 —— 用户明确要求不做零散小改）
1. **t12 O1**：`test/e2e.test.js` 归属侧缺防退化守卫（改过 `DSH_HOME` 时两侧 prunePlan 皆 `[]` ⇒ 断言静默恒真）。
2. **t8 新报同类**：`DSH_HOME` 指向**无 `profiles/web`** 的隔离 home 时，E2E② 的 `subagent` 归属断言由 unknown 退化为 core 而失败（默认环境 109/109 全绿）。
**处置**：二者同源（对"profile 根不存在/被改"缺乏守卫），**打包为一项**——下一次有任务改动 `test/e2e.test.js` 时一并补。若本次开发收尾前仍无任务触及该文件，则在收尾时作为**一个**清理项处理，而不是零散多次。
（2026-10-07 更新：**已随 t14 派活**，并已在 t16 的复核验收里要求按"断言强度不得放宽"的同款标准检查。）

---

## 队长裁定 · DESIGN v3 合并（t13）四处差异（2026-10-07）

队长独立复核：`git diff --stat` 确认**只有 `DESIGN.md` 被改**（458 插入 / 6 删除）；示例 `version` 均为 3（`:252`/`:863`/`:1092`）且与 §2.1 常量、§7 模块契约一致；§9 主表保留的两处 `version: 2`（`:1580`/`:1584`）属**R1 轮次描述**，按"不得改既有行"保留是正确的。
另：队长一度把 v2 段落里的 `（F2）`（`:17`）当成悬空残留，**查证后确认是误报**——该处指向的是本文档原始的 F2（`ReconcileInput` 输入通道缺口），引用正确；t13 替换掉的是**草稿的 R6-F 编号**，保留这一处是对的。（这又是一次"我的粗筛比事实钝"，与本文档反复出现的那类误判同源。）

**四处差异的裁定——全部接受 t13 的处置，且两处是我的方案本身有缺陷：**

1. **§9.1 独立追加表（替代"主表增 3 行"）——接受，且优于我的原文。**
   §10.1 说"增 3 行"而 §10.3 列 5 行，本身不一致；若直接追加进主表，会让 `index.js`/`lib/reconcile.js`/`client.js` 与 R1 轮既有行**逐字重复**，而主表第三列的语义是"**R1（v2）本轮**是否触碰"——同一文件在同一张表里出现两次且列语义不同，会让后来的读者无法判断该看哪一行。t13 用独立的 §9.1（5 行、轮次标签独立、主表一字未改）解决了这个问题。**队长裁定：§9.1 即最终形态，不需要再改成主表内 3 行。**

2. **F#/C# 编号引用就地替换为一手 `file:line`（18 处）——接受，并明确否决备选方案。**
   这是我的合并方案**真实缺陷**：验收只列了 §10.1 的映射，而草稿 §1（F1–F17）与 §2（C1–C3）不在其中，导致正文出现**指向不存在小节的悬空引用**；且草稿的 `F2` 与本文档早已存在的 `F2`（输入通道缺口）**撞名**。
   **裁定：采纳 `file:line`，不采纳"并成小节 + 改名 R6F1–R6F17"。** 理由：冻结契约不应依赖一份**草稿内部**的编号体系（草稿不是契约的一部分）；`file:line` 自带可核性，且顺带消除了撞名。备选方案会把契约的可读性建立在草稿的存续上。

3. **§2.12 示例无 `version` 键 ⇒ "两个示例"实际只有一处——接受，错在我的验收文本。**
   我写下"两个示例"是照抄了草稿 §10.1 的措辞，没有自己去数。t13 **没有为凑数补键**，是正确的克制。

4. **第 4 处既有行改动（§7 模块契约 `写入 version: 2` → `3`）——接受，且我的验收自相矛盾。**
   我一方面限死"只改这 3 处"，另一方面又要求"示例 JSON 的 version 与实际常量一致"——而 §7 那一行描述的是**活常量**，不改则文档自相矛盾。t13 的取舍正确：**改活常量描述，保留轮次/历史描述**（§8 历史行、§9 主表的 R1 轮行）。

**附带记录**：t13 首次提交因 attempt_id 笔误被拒为 stale，它按纪律停手核查后重提、两提之间未再改文件——属正确处理。

---

## R6（v3）实现纪要 · 自主决策记录（t14）

按 DESIGN §9.1（R6 轮文件归属追加表），本轮实现线触碰：`lib/hide.js`（新建）、`index.js`、
`lib/reconcile.js`、宿主侧 `test/**`。以下为 §10.1 的 D 类记录（续 D1–D6 编号）与两条需队长处置的观察。

### F6 · `ReconcileInput`（§7.1 冻结）没有承载 R6 输入的通道 —— **需队长裁定**

**事实**：v3 新增了 7 个 `findings` 键（§2.5），并规定 `lib/hide.js` 计算、
`lib/reconcile.js` 注入（§9.1）。但 §7.1 冻结的 `ReconcileInput` 只有
`{ cwd, sessionsRoot, scope, callsByName, provenance:{byName,bundleOwners}, items, findingsLimit }`，
**没有任何字段**能传入 R6 所需的：① 宿主对 restrict 接口的探测结果（`status` / `restrictableNames`）、
② opt-in 施加状态（`mode` / `appliedNames`）、③ `registryUse.nameReferencedElsewhere` 所需的弱命中文件。
这与 v2 的 F2（次数通道缺口）是同一类缺口：契约要求 reconcile 注入，却没给注入的输入。

**处置**（**追加可选字段**，不改任何既有冻结字段的语义）：
1. `provenance.weakEvidence?: Record<string, string[]>` —— R1 弱扫描的命中文件（已是 §3.6 白名单内的绝对路径）；
2. 顶层 `hide?: { status, restrictableNames, mode, interfacePresent, appliedNames }` —— 宿主探测 + opt-in 状态。

缺省语义（旧调用方零影响）：`weakEvidence` 缺省 `{}`；`hide` 缺省 = `unsupported` + `suggestion-only` +
`appliedNames: []`（即"没有探测结果 ⇒ 不校验、不施加，只给候选"）。

**请队长决定**：是否在 DESIGN v4 的 §7.1 补上这两行（或授权我改 §7.1）。实现线不自行改冻结的 §7.1。

### F7 · §2.11 的 native 渲染模板**没有** R6 段 —— 措辞属未冻结内容（已自拟并固定）

**事实**：v3 在 §2.19 要求 `hidePlanCaveat` "必须在工具输出、native 渲染与面板三处同时呈现"，
在 §2.22 要求并列呈现规则"面板与 native 渲染都必须遵守"，但 §2.11 的冻结模板**只到 R1 段为止**，
没有给出 R6 段的逐行格式（草稿 `R6-DESIGN-DRAFT.md` 也没有）。

**处置**：按 D6（非契约措辞）自拟并把顺序固定为**紧接 R1 段的 6 行**（R1 段的每一行原样保留、位置不变）：

```text
Hide candidates (tool level) — needs manual confirmation: <hidePlanTokens> tokens in <N> tools across <U> units (status: <hidePlanStatus>)
  - <kind> <target|(no uninstall unit)>: hide <toolCount> tools, <tokens> tokens if hidden  |  uninstall this unit: <reclaimableTokens> tokens if unused (<usedToolCount> tools of this unit in use)
  - <kind> (no uninstall unit): hide <toolCount> tool, <tokens> tokens if hidden  |  uninstall is not available for this unit
  - (no candidates in this window)                      # 仅当 hidePlan 为空
Hide caveats: registry-level hide, not schema-only; non-model registry calls: unobservable; service coupling: unconfirmed; manual confirmation required before applying; prompt cache: one-time invalidation
Hide apply: <mode> (nothing applied by this plugin; opt-in config required | <N> names applied to this agent scope)
Do not add the hide tokens to the uninstall candidates: the two actions are alternative, not cumulative.
```

自查：不出现 §6 第 11 条禁用的结论式措辞；两个动作的 token 从不相加（末行显式声明）；`inPrunePlan === false`
的单元只给隐藏一行并注明"无法通过卸载移除"（§2.22 第 2 条）。**请队长确认或改 DESIGN §2.11。**

### D7 · `hidePlanStatus` 在没有候选时取**探测状态本身**

§2.20 说"三者取最弱一环"，但候选为空时对空集合取最弱一环会**谎报** `prechecked`。
实现取探测状态本身（`hide.status`），语义是"这次校验到底能不能做"——面板在"无候选"时也据此显示证据态。

### D8 · `hideApply.skipped` 的元素形状定为 `{ name, reason }`

DESIGN 只给字段名不给元素形状（§2.18）。定为 `{ name, reason }`（`reason` 复用 §2.20 的枚举），
并保证 `denyList` 与 `skipped` 是候选集合的一个**划分**（H6 机械成立：`|denyList| + |skipped| = |hidePlan|`）。

### D9 · 单元只在**存在候选**时输出；`usedToolCount` 只统计同单元的 `zeroCall === false` 项

只承载"在用工具"的单元不进 `hidePlanUnits`（否则 H4 的 `Σ toolCount = |hidePlan|` 与排序都会被无意义单元污染）。
`usedToolCount` 统计的是**同一逻辑单元**（`kind` + `target` 配对）下 `zeroCall === false` 的工具数。

### D10 · `interfacePresent` / `mode` 的推导

- `interfacePresent` 缺省由 `status` 推导（`unsupported` ⇒ `false`，否则 `true`），宿主可用显式值覆盖；
- `mode` **只有真的施加成功过**（`appliedNames` 非空）才是 `applied-by-config`；施加失败或空清单
  一律静默降级为 `suggestion-only`（§2.23.4 第 4 点）。`appliedNames` 只接受 `denyList` 之内、去重升序的名字。

### D11 · 施加失败一律 fail-soft（不抛错、不重试）

`applyDenyToAgent` 在 `agent.ctx.tools.restrict(...)` 抛错时返回空 `appliedNames`，并把请求的名字记为
`interface-absent`；`view(agent)` 抛错记为 `unvalidated`；缺 `restrict`/`view` 或 `restrictableNames`
不是数组记为 `unsupported`。三条路径都**不抛错**（旧世代 Harness 没有该接口，见 §2.23.3 的对照）。

### D12 · 不新增读取面，弱命中语料一对一复用

`registryUse.nameReferencedElsewhere` 复用 R1 的弱扫描结果：`scanProvenance` 额外返回
`weakFiles`（两个扫描根的 `evidence.weak` 合并后升序去重），`lib/hide.js` 只取字典序最小 3 条。
R6 不读任何新目录、不读会话正文、不解析别人配置（§2.25 第 6 点 / §3.7）。

### D13 · `hidePlanCaveat` 每次返回副本

共享常量 `HIDE_PLAN_CAVEAT` 冻结，但每次注入返回**新对象**，避免调用方改到常量本体。

### 携带项（t14 打包委托）· `test/e2e.test.js` 两处同源健壮性问题的处理

1. **归属侧缺防退化守卫** → 在 **E2E②** 与 **E2E③** 各补硬断言：
   `providerScan.packages > 0`、`providerScan.files > 0`；E2E③ 另加
   `Object.keys(provenance.byName).length > 0` 与"成本侧必须含 providedBy"。
   语义：若 `DSH_HOME` 指错或核心根解析失败，归属侧会整体退化为"0 包 0 文件"，
   原来的 `prunePlan` 比对会**静默恒真**（两侧都是 `[]`）；补上守卫后这种退化会**显式失败**。
   仍然**没有**放宽任何既有断言强度。
2. **`DSH_HOME` 无 `profiles/web` 时 `subagent` 归属断言误报** → 根因：profile 候选为空时不存在"多包歧义"，
   `subagent` 只会退到 `core`（§2.14 判定表第 6 行：弱级 profile 0 命中、核心 ≥1 命中 ⇒ `core/low`），
   而旧断言写死了 `unknown`。处理：把**恒成立**的那条（歧义名字**绝不**被猜成单一插件 `notEqual(kind,'plugin')`
   且 `name === null`）无条件断言；仅在 `PROFILE_DIR/node_modules` 存在时（`PROFILE_AVAILABLE`）才断言完整的
   歧义形状（`unknown` + `static-scan-weak` + 非空 `candidates`）。断言的实质强度不变，只去掉环境依赖。
   **实测**：把一份真实会话日志复制到**没有 `profiles/web`** 的临时 `DSH_HOME` 下跑 E2E，
   5 个用例全绿（修复前该断言会失败）。

---

## 队长裁定 · R6 宿主半区（t14）交付复核（2026-10-07）

### 队长独立复核（未采信自述）
- ① **作用域**：`index.js` 全文只有一处真实 `.restrict(` 调用（`:742`，在 `applyDenyToAgent` 内、走 `agent.ctx.tools.restrict`）；`:705` 注释明写"绝不全局施加"。**通过**
- ② **携带项①已做**：`test/e2e.test.js:255` 与 `:424` 两处 `assert.ok(report.scope.providerScan.packages > 0, …)`（主侧与差分侧各一）。**通过**
- ③ **携带项②已做**：`test/e2e.test.js:236` 处理了"无 `profiles/web` 的 DSH_HOME"歧义。**通过**
- ④ 全量套件 **139/139 通过**（t14 报 138，多出的一项是并行面板线 t15 新增的用例）。
- ⑤ F7 自拟文案独立抽验：`lib/reconcile.js` 禁用措辞 0 处；两处 `uninstall advice` 均为**契约强制的不做建议声明**（`:547` 段标题 `NOT uninstall advice`，§6 第 10 条要求），属合规。

真机：prechecked 下 32 候选 / 4214 tokens / 7 单元；prunePlan 保持 3329 不变 ⇒ 隐藏多覆盖 **885 tokens**（core 746 + unknown 139），与 §2.22 预期一致。

### F6 裁定（§7.1 的 `ReconcileInput` 无 R6 输入通道）—— **接受现状，但升级为"阻塞性携带项"**
实现按**追加可选字段**处理（`provenance.weakEvidence` + 顶层 `hide{status,restrictableNames,mode,interfacePresent,appliedNames}`），缺省保证旧调用方零影响。**接受**：向后兼容、已在真机验证。

**必须记的教训**：这与 v2 的 F2（输入通道缺口）**同类**，而 F2 当时被"记为 v3 待办"却没在 v3 修掉——**结果同类问题在 R6 又出现一次**。
**裁定**：不再当"注释式待办"。已写入 `BACKLOG.md` 作为**阻塞性携带项**（字段名明确、要求下次 DESIGN 修订必须完成 §7.1 输入通道补全），下一次设计轮次开工前强制核对。

### F7 裁定（§2.11 无 R6 渲染段，措辞自拟）—— **接受，定为 v4 机械化提升项**
§2.11 的 native 渲染模板确实无 R6 段，v3 只在 §2.19/§2.22 说"必须出现"。实现按 D6 自拟 6 行并**逐字**记入本文件。**接受**：该段是模型侧渲染而非用户界面文案，且已通过 §6 第 11 条自查。
**v4 处置**：这 6 行已被逐字钉住，提升进 §2.11 属**机械操作**，不需重新措辞。

### D7–D13 备案 —— **全部接受**
`hidePlanStatus` 空集合时取探测状态本身（不对空集取"最弱一环"，避免谎报 prechecked）；`skipped` 形状 `{name, reason}`；`usedToolCount` 只计同单元 `zeroCall === false` 项；`mode` 仅在真施加成功（`appliedNames` 非空）时升 `applied-by-config`。四条同一原则：**绝不把未知或未发生的事说成已发生。**

---

## 队长裁定 · R6 面板（t15）交付复核（2026-10-07）

### 队长独立复核
- 改动范围仅 `client.js`（纯追加 +556 行、**零删除行**）与 `test/client-panel.test.mjs`（28→40 用例）。
- **两条硬规则的证据强度我认可**：① "不得相加"不是靠断言，而是**结构上不可能**——面板从不读取 `hidePlanTokens`/`prunePlanReclaimableTokens`（静态断言 + 字段名零出现）；示例两数之和 7637 在整屏文本中不存在。② "建议≠已施加"在两种 mode 下都有明写措辞，未知 mode 保守回落。
- **一处矛盾我实测澄清**：t15 报"隔离 DSH_HOME 下全量套件因 E2E② 退化"，与 t14 报"已修好"矛盾。队长实测 **5 次连续全绿（139/139）**，故 **t14 的修复生效，t15 那条观察是它运行时修复尚未落地的时间差**，不是缺陷。

### t15 待裁定两项
1. **§4.5 未给 v3 键清单，实现自拟 45 个 `cl.hide*` 键并在测试里钉死键集 —— 接受，定为 v3.1 机械化采信项。**
   与 F7 同一性质：契约有逐条**文案义务**却未冻结**键集**，实现补上并钉住。**接受**，且因为键集已被测试钉死，v3.1 采信是机械操作。**不得**因此改键名——改名会同时击穿测试与已上屏文案。
2. **R6 复用 v2 同义键（`cl.pruneUnitPlugin`/`McpServer`、`cl.providedBy.core`/`unknown`、`cl.pruneFactPackages`）—— 批准。**
   理由：同义文案重复定义会带来**漂移风险**（一处改了另一处没改，同一概念在两种动作下显示不一致）。复用同义键是正确取舍，**不要求**为 R6 另立独立键名。

---

## 队长裁定 · 新增右侧栏承载位置（t20/t21，2026-10-07）

### 触发与决定
**用户直接请求**：「我希望这个 context ledger 能打开有侧边栏」。这与用户既有的交互偏好一致——点按钮后打开**右侧专属栏**，而不是在输入框上方就地展开。

**队长决定**：为账本**新增一个承载位置**（右侧栏 tab），**内容与呈现义务一条不减**（§4.7 七条 + §4.8 六条在右侧栏位置下同样成立）。既有 composer 控件保留为**触发入口**。

### 为什么不为此走一整轮契约修订
承载位置属 §4.1 的 slot 描述，严格说属契约面。但本次变更是**用户直接指定的交互要求**、且**不改变任何数据形状与内容义务**（只改呈现在哪里），为此再开一轮 requirements→review 的收益低于成本。
**处置**：以本裁定授权实现，并把 DESIGN 的收口记为携带项 **C6**（下一版 DESIGN 修订时把右侧栏位置并入 §4.1 与 §4.8，与 C1–C5 一并处理）。

### 已核验的一手契约（实现线照此施工，勿再自行摸索）
- 插槽 `sidebar.right.pane.tab`（kind=`keyed`、scope=`session`）与 `sidebar.right.pane.tab.title`（**同 key**）——`dsh-client-ui-sidebar-right/lib/types/client/contract/slots.d.ts:53` 与 `:67`。
- 打开入口：`ctx.sidebarRight` 对外面（同包 `lib/types/client/service.d.ts` 的 `ISidebarRight`）提供 `openTab(kind, options)` / `toggleExpanded()` / `isExpanded()` / `focus()` / `active()` / `close()`。其注释明写「**The column expands in the same step, because content the user cannot see is not opened.**」⇒ `openTab` 即可实现"点击即开栏"。
- **现成先例**：`@nanmicoder/dsh-agent-teams/lib/client/index.js` 与 `dsh-context/lib/client.js` 都在用 `sidebar.right.pane.tab`；照它们的注册形状走比自创更稳。

### 硬要求
1. `ctx.sidebarRight` **不可用时必须回退**到既有 popover，**不得抛错、不得让控件变死按钮**（老宿主 / headless）。
2. **不得把旧 popover 改名冒充侧栏**——复核线 t21 的首要任务就是真伪判别（注册进真插槽 + 真调用 `openTab`）。
3. 措辞红线在**新位置重验**：tab 标题与属性型文本（`title`/`aria-label`/…）是新增的逃逸口，必须一并穷举。
