# dsh-context-ledger — t9 独立复核报告（R2 面板呈现 / §4.7）

> 复核人：验证（AgentTeams 成员）
> 任务：`t9 [verify]` · kind=review（round 2，绑定 t8）· attempt `9024b945-a03c-40a7-b490-87fa433663ca`
> 复核基线：`113c2f5`（feat(R2): 面板呈现裁剪候选与归属（t8）+ 修复 v1 面板必崩缺陷；工作树 clean）
> 判定基准：DESIGN **v2 §4.7**（**7 条**编号义务——任务文本写「六条」，实为 7，见 §9-O5）+ §4.1–§4.6 + §9 文件归属矩阵
> 纪律：未修改任何实现文件 / 测试 / DESIGN；未触碰 `~/.dsh/**` 与 DSH 安装目录。

---

## 0. 结论

**verdict = pass**

R2 的 §4.7 **7 条硬性呈现义务全部落地**，且**穷举渲染输出的全部可见文案后，未发现任何确定性「建议卸载」类措辞、也未发现红色告警式危害暗示**。

| 任务要求的核验项 | 结论 | 一句话证据 |
|---|---|---|
| ① §4.7 逐条（实为 7 条） | ✅ 通过 | 7 条各自有结构 + 渲染输出双侧证据（§2） |
| ② **对抗性措辞穷举**（权重最高） | ✅ 通过 | 我自己遍历渲染树收集 zh/en 各 66 条受审文案 + 7 条属性型文案，禁止词命中 **0**（§1） |
| ③ 每行五项齐备（usedToolCount 必查） | ✅ 通过 | 五项各有独立 `data-cl-*` 节点；`usedToolCount=0` 显示「该单元无在用工具」，**缺失字段也不省略**（§3） |
| ④ caveat 常驻段底 / 非 tooltip / 不可折叠 | ✅ 通过 | 结构：section 最后一个子节点、无 `title`/`onClick`/`hidden`、祖先链无 `button`/`details`；非空/空/降级三态都在（§4） |
| ⑤ unknown 只进 noRecommendation、不显示成「DSH 自带」 | ✅ 通过 | 候选清单 0 条 unknown 文案；`kind=unknown → 「归属未知」+?`，`kind=core → 「DSH 自带」`（§5） |
| ⑥ 顺序恒为 reclaimableTokens 降序、无二次加工 | ✅ 通过 | 正序/逆序/低置信在前且更大/12 条不截断四种夹具 + 真实数据面板顺序 == 宿主顺序（§6） |
| ⑦ 不采信自述 | ✅ 通过 | 自读 `client.js`、自建渲染审计（96 条断言）、自行运行 t8 套件 28/28 与全量 109/109（§8） |
| 附带：t8 声称修复的 v1「面板必崩」 | ✅ 机械证实 | A/B：修复前父组件 hook 数 13→19（+6，正是 React 崩溃条件）；修复后 13→13（§7） |

非阻断观测 6 项（§9），均为「已在实现注释与 t8 报告中显式标注的契约缝隙/口径说明」，无一项属于 §4.7 违规。

---

## 1. 对抗性措辞检查（权重最高）—— ✅ 无一处违规

### 1.1 方法：不读词典，读**渲染输出**

不采信「词典里没写坏词」这种做法。我用自己写的最小 React 替身执行 `client.js` 的
`LedgerPanel` / `PruneBlock`，然后**遍历整棵渲染树**，穷举：

- 所有**文本节点**；
- 所有可能上屏的**属性文本**：`title` / `aria-label` / `placeholder` / `alt` / `aria-description`（这是"藏进 tooltip"的常见逃逸口）。

夹具用**真实风险形态**：排名第一的候选是一个大 token、`usedToolCount=0`、低置信的单元
（对应队长点名的场景——用户特意配置过、由 UI/后台使用的功能域）。

```
$ node panel-audit.mjs
  [zh] 受审文案片段 = 66（豁免 caveat 1 条）
  [zh] 可见文案片段数 = 67（其中属性型 7）
  [en] 受审文案片段 = 66（豁免 caveat 1 条）
  [en] 可见文案片段数 = 67（其中属性型 7）
  [en] 小写补充扫描命中: []
```

> 「豁免 caveat 1 条」不是放水：§4.7 第 3 条**强制要求**的不确定性声明本身含
> 「不代表**没用**」，是契约规定的**否定句**。朴素子串扫描会把它误报，故先剔除该句，
> 再对剩余全部文案判定。剔除后的判定仍然覆盖了 66 条片段（含全部标题/提示/徽标/页脚/属性文本）。

### 1.2 禁止词表（命中 0）

```
zh: 建议卸载 / 可以删掉 / 删掉 / 浪费 / 无用 / 没用 / 不该用 / 应该移除 / 建议删除 /
    不再需要 / 放心删 / 清理掉 / 没价值 / 低价值
en: uninstall advice / should uninstall / you can delete / safe to remove / safe to delete /
    waste / useless / worthless / no value / low value / get rid of / recommend removing /
    should remove / feel free to remove / junk
→ zh 命中 []，en 命中 []（含大小写不敏感补充扫描）
```

### 1.3 候选行的调色板（无红色告警）

```
$ 采集候选块子树内所有颜色引用
  候选块内的颜色引用: ["--dsw-alias-label-primary","--dsw-alias-label-secondary",
                      "--dsw-alias-label-tertiary","--dsw-alias-bg-layer-1/-2",
                      "--dsw-alias-border-l2/-l3","--dsw-alias-state-warn-primary"]
  → 候选块内不引用宿主 error(红) 色: 通过
```

候选行各元素配色：单元名 `label-primary`、行文本 `label-secondary`、事实包 `label-tertiary`、
分隔线 `border-l2`、明细背景 `bg-layer-2`。**唯一非中性色**是低置信标记的 `state-warn-primary`（琥珀），
语义是"这条**归属推断**可能不准"（见 §9-O2 的判读）。

### 1.4 真实数据整屏文案（人工逐条判读的基础）

用真实日志 + 真实 profile 产出的 `prunePlan` 喂进面板，打印候选段全部文案：

```
=== 面板上屏：每个候选单元这一行的可见文案 ===
  [openviking]              ["MCP 服务器 · openviking","8 个未调用工具：mcp__openviking__add_resource, mcp__openviking__cancel_watch, mcp__openviking__list_watches …","若未使用可省 240 token","另有 5 个工具在用","事实包：—"]
  [@linxin666/dsh-web-all]  ["插件包 · @linxin666/dsh-web-all","2 个未调用工具：task_board_manage, task_board_run","若未使用可省 50 token","另有 3 个工具在用","事实包：@linxin666/dsh-client-ui-task-board"]
  [@liustack/modlens]       ["插件包 · @liustack/modlens","1 个未调用工具：modlens_read_image","若未使用可省 26 token","该单元无在用工具","推断，可能存在误判","事实包：@liustack/modlens"]
  [dsh-context-ledger]      ["插件包 · dsh-context-ledger","1 个未调用工具：context_ledger","若未使用可省 24 token","该单元无在用工具","推断，可能存在误判","事实包：dsh-context-ledger"]
  [@changfenhuang/dsh-genui]["插件包 · @changfenhuang/dsh-genui","1 个未调用工具：render_ui","若未使用可省 22 token","另有 1 个工具在用","事实包：@changfenhuang/dsh-genui"]
  [dsh-annotate]            ["插件包 · dsh-annotate","1 个未调用工具：annotation","若未使用可省 22 token","该单元无在用工具","事实包：dsh-annotate"]

=== 判读 ===
  确定性/贬损措辞命中（已排除契约强制的"不代表没用"否定句）: []
  首行候选是否带「若未使用」条件语: true
  首行候选是否显示在用工具数: ["另有 5 个工具在用"]
```

**针对队长点名的场景**：真实数据里大 token 的候选（`openviking` 8 工具 / 240 token；
`@linxin666/dsh-web-all` 2 工具 / 50 token）恰恰是用户配置的功能域——面板对它们：
① 段标题是「零调用候选 · 需人工确认」；② 可省 token 一律带条件语「若未使用」；
③ **同时显示「另有 5 / 3 个工具在用」，把卸载代价摆在同一次视线内**；④ 段底常驻声明
「这些候选只说明模型没有调用过，**不代表没用**：工具可能由界面、后台流程或极低频但关键的操作使用。
请确认你也没有使用其功能后再移除。」⑤ 页脚「本次归属扫描触达上限，覆盖可能更窄」。
**没有把它说成"该删"**。

---

## 2. §4.7 逐条核验（DESIGN 实为 7 条）

### 第 1 条 · 段标题必须是候选语气 —— ✅

```
=== C · §4.7 第 1 条：段标题逐字 + 无告警色 ===
  PASS C1  zh 段标题节点存在
  PASS C1b zh 标题文案逐字等于契约
  PASS C1  en 段标题节点存在
  PASS C1b en 标题文案逐字等于契约
  PASS C2  候选块内不引用宿主 error(红) 色
```

- zh 逐字：`零调用候选 · 需人工确认`；en 逐字：`Never-called candidates · needs your call`
  （与 §4.7 第 1 条给定文案一致；实现在 `client.js:95` / `client.js:159`）。
- 禁止的确定性措辞：见 §1.2 命中 0。
- 红色告警样式：候选块内零 error 色引用（§1.3）。

### 第 2 条 · 每行必须同时给出五项 —— ✅（缺一即缺陷）

见 §3 的逐项节点计数与文案断言。

### 第 3 条 · 固定不确定性声明常驻段底、不得折叠 —— ✅

```
=== E · §4.7 第 3 条：不确定性声明常驻段底、非 tooltip、不可折叠 ===
  PASS E1 非空清单/zh caveat 节点恰 1 个      PASS E1 非空清单/en ...
  PASS E2 非空清单/zh caveat 无 title（非 tooltip）
  PASS E2 非空清单/zh caveat 无 onClick/href（不可点击隐藏）
  PASS E2 非空清单/zh caveat 无 hidden/display:none
  PASS E3 非空清单/zh caveat 文案含「不代表没用」
  PASS E4 非空清单/zh caveat 位于段底（section 最后一个子节点）
  PASS E5 非空清单/zh caveat 不在任何 button/details 内
  （空清单/en 各 6 条同样通过）
```

结构证据（一手）：`client.js:925-935` —— caveat 是 `h('section')` 的**最后一个子节点**，
`h('p', { key:'caveat', style: caveatStyle, 'data-cl-prune-caveat': '' }, t('cl.prunePlanCaveat'))`，
无 `title` / 无 `onClick` / 无 `hidden`；`caveatStyle`（`client.js:724`）为中性配色
（`label-secondary` on `bg-layer-2` + 中性边框），**不是告警色**。
降级态与空态下 caveat 仍渲染（§I-1），即"没有候选"时也不隐藏不确定性声明。

### 第 4 条 · 归属推断必须可辨 —— ✅

```
=== F · §4.7 第 4 条：低置信可辨 + unknown 只进 noRecommendation ===
  PASS F1 低置信单元行带「推断，可能存在误判」节点（恰 1 个）
  PASS F2 低置信措辞逐字 = 推断，可能存在误判
  PASS F3 明细行给低置信项「推断，可能存在误判」
  PASS F4 明细行给出证据路径（可查）
  PASS F5 高置信项也给证据路径（展开另一条）
  PASS F5b 展开低置信项 → 标记出现 2 次（行标记 + 明细补充）
  PASS F5c 展开高置信项 → 标记只出现 1 次（低置信那条的行标记）
  PASS F7 unknown 落在「无法给出动作」分节
  PASS F8 unknown 的徽标文案为「归属未知」而非「DSH 自带」
  PASS F9 kind=core 才显示「DSH 自带」
  PASS F10 候选块自身不含 unknown 项文案
  PASS F11 「无法给出动作」分节标题逐字
  PASS F12 计数值为 0 的理由被过滤（§2.16 授权面板自行过滤）
```

- 单元行：`client.js:902` 低置信行标记；明细行：`client.js:918` `attributionNoteLines`
  （证据路径 + 低置信警示，均为**可见文本**，非 tooltip）。
- `attributionText`（`client.js:571-580`）按 `kind` 分支：`unknown → 「归属未知」`；`core → 「DSH 自带」`。
  **`unknown` 永远不会显示成 "DSH 自带"**（两条分支互斥）。徽标样式：
  `unknown`/低置信走 `attributionUncertainStyle`（中性灰 + 虚线边框 + 文案自带 `?`），符合 §4.4。

### 第 5 条 · 不得替用户排序 —— ✅

见 §6。

### 第 6 条 · capped 页脚 —— ✅

```
=== H · §4.7 第 6 条：capped 页脚（true 出现 / false 零出现）===
  PASS H1 capped=true  → 页脚节点数 1
  PASS H2 capped=true  → 文案「本次归属扫描触达上限，覆盖可能更窄」存在
  PASS H1 capped=false → 页脚节点数 0
  PASS H2 capped=false → 文案不存在
```

真实数据（本机 `capped: true`）上屏确有该行（§1.4 末段）。

### 第 7 条 · 证据可查（"展开单元**或**明细"两条路径） —— ✅

```
=== K · §4.7 第 7 条："展开单元或明细"两条路径都要给证据路径 ===
  分类展开后的 detail 行: ["tools:low","tools:high"]
  detail 区域的可见文案: ["归属（推断）","插件 @liustack/modlens ?",
    "证据：/p/@liustack/modlens/dsh/index.js","推断，可能存在误判",
    "插件 @nanmicoder/dsh-agent-teams","证据：/p/@nanmicoder/dsh-agent-teams/lib/tools.js", ...]
  PASS K1 明细展开渲染了两行
  PASS K2 明细行给出低置信项的证据路径
  PASS K3 明细行给出高置信项的证据路径
  PASS K4 明细行低置信同时给「推断，可能存在误判」
  PASS K5 低置信徽标带问号（不只给一个包名）
  PASS K6 低置信明细恰 1 条警示（高置信那条不带）
```

- 「单元」路径：`client.js:918`（PruneBlock 明细）→ 证据路径 + 低置信警示。
- 「明细」路径：`client.js:1109`（四类明细行后追加 `attributionNoteLines`）→ 同样两条。
- 路径样式 `attributionEvidenceStyle` 带 `userSelect: 'text'` + `wordBreak: 'break-all'`
  （`client.js:712`）→ **可复制**；面板**不读**该文件（只渲染字符串）。

---

## 3. 每行五项齐备 + usedToolCount 必查 —— ✅

```
=== D · §4.7 第 2 条：每行五项齐备；usedToolCount=0 不省略 ===
  PASS D1 zh 行数 = 条目数            PASS D2 zh ① 单元名+种类节点 = 2
  PASS D2 zh ② 工具数+代表工具名节点 = 2   PASS D2 zh ③ 可省 token 节点 = 2
  PASS D2 zh ④ 在用工具数节点（0 也在）= 2  PASS D2 zh ⑤ 事实包名节点 = 2
  PASS D3 zh ④ usedToolCount=0 显示「该单元无在用工具」
  PASS D3 zh ④ usedToolCount=5 显示「另有 5 个工具在用」
  PASS D3 zh ③ 带条件语「若未使用」
  PASS D3 zh ⑤ 事实包呈现（事实包：@x/tb）
  PASS D3 zh ② 工具数 + 代表工具名（4 个未调用工具：alpha, beta, gamma …）
  PASS D3 zh ① 单元种类（插件包 · @x/web-all / MCP 服务器 · openviking）
  PASS D4 zh usedToolCount=1 显示单数措辞「另有 1 个工具在用」
  PASS D5 zh usedToolCount 缺失时仍渲染该字段（不省略）
  （en 侧同样 12 条通过）
```

- 五项各有独立节点（`data-cl-prune-unit/tools/reclaim/used/facts`），**不是**"可有可无的行内词"。
- `usedToolsText`（`client.js:545-549`）对 `0` 走变体 0 → 「该单元无在用工具」；
  对 `1` 走变体 1（单数）；对 ≥2 走变体 2。**任何取值都有文案，不可能被省略**；
  甚至字段缺失（`isNum` 为假）也按 0 渲染而不是留空。
- 真实数据上六行全部带齐五项（§1.4），包括两个 `usedToolCount=0` 的行。

---

## 4. §4.7 第 5 条：顺序未二次加工 —— ✅

```
=== G · §4.7 第 5 条：顺序恒为宿主 reclaimableTokens 降序，不二次加工 ===
  PASS G1 顺序 = 宿主顺序（不按 target/confidence/tokens 重排）  → ["zzz-small","aaa-big"]
  PASS G2 反向输入亦照抄                                      → ["aaa-big","zzz-small"]
  PASS G3 低置信在前且更大 → 仍在前（未按可信度重排）             → ["low-big","high-small"]
  PASS G4 不截断（12 条全部渲染）
```

真实数据（§1.4）：

```
  宿主顺序: ["openviking","@linxin666/dsh-web-all","@liustack/modlens","dsh-context-ledger","@changfenhuang/dsh-genui","dsh-annotate"]
  面板顺序: ["openviking","@linxin666/dsh-web-all","@liustack/modlens","dsh-context-ledger","@changfenhuang/dsh-genui","dsh-annotate"]
  顺序一致: true
```

G3 是**证伪式**用例：把低置信单元放在首位且给最大 `reclaimableTokens`——若实现"按可信度重排"
或"过滤低置信"，它会被移走/消失；实测原样保留（低置信有标记但不过滤，符合 §4.3）。

---

## 5. 附带修复：t8 声称的 v1「面板必崩」缺陷 —— ✅ 机械证实

t8 报告称：v1 的 `LedgerRing` 把含 hook 的 `LedgerPanel` **当普通函数调用**且位于 `open ?` 条件分支内
→ 展开面板时父组件 hook 数量变化 → React 抛 "Rendered more hooks than during the previous render"。

**一手证据（修复前，`git show HEAD~1:client.js`）**：

```
       6	        open
       7	          ? h(PanelBoundary, { key: 'panel', t: t }, LedgerPanel({   ← 直接函数调用
       8	            id: panelId, t: t, report: report, state: life, ...
```

**我的 A/B（用带"组件帧"的 hook 替身模拟 React 记账）**：

```
=== A · HEAD~1（修复前）===
  父帧 hook 数：open=false → 13，open=true → 19
  子组件帧：[{"name":"PanelBoundary(class)","calls":null}]
  PASS A1 修复前：父组件 hook 数随展开变化（= React 崩溃条件）: true
  PASS A2 修复前：LedgerPanel 未作为独立组件实例出现（hooks 被内联进父帧）: false
  → 差值 6 个 hook：与 "Rendered more hooks than during the previous render" 的触发条件一致

=== B · 工作树（修复后）===
  父帧 hook 数：open=false → 13，open=true → 13
  子组件帧：[{"name":"PanelBoundary(class)","calls":null},{"name":"LedgerPanel","calls":10}]
  PASS B1 修复后：父组件 hook 数跨"展开"稳定: [13,13]
  PASS B2 修复后：LedgerPanel 作为独立组件实例被实例化: true
  PASS B3 LedgerPanel 的 hook 落在自己的帧里: "number"
```

即：修复前**父组件 hook 数 13 → 19（+6）**，正是崩溃条件；修复后稳定在 13，`LedgerPanel`
以独立实例消耗自己的 10 个 hook。修法（`h(LedgerPanel, …)`，`client.js:573`）**真正消除了缺陷**，
不是措辞层面的变更。该缺陷位于队长早先标记的唯一未验证路径（浏览器内展开面板）上，t8 的发现成立。

---

## 6. 范围与自跑（不采信自述）

### 6.1 改动范围（§9 文件归属矩阵）

```
$ git show --stat HEAD --format=""
 IMPLEMENTATION-NOTES.md    |  35 +++
 client.js                  | 478 +++++++++++++++++++++++++++++++-
 test/client-panel.test.mjs | 645 ++++++++++++++++++++++++++++++++++++++++++---
 3 files changed, 1114 insertions(+), 44 deletions(-)
```

- 产品面只动 `client.js`；测试只动 `test/client-panel.test.mjs`；`IMPLEMENTATION-NOTES.md` 按 §9 归实现线（append-only）。
- **未越界**：`index.js` / `lib/**` / `DESIGN.md` / `package.json` / `cordis.patch.yml` / `README.md` 均未被触碰：

```
  SAME  index.js   SAME  lib/provide.js   SAME  lib/reconcile.js
  SAME  package.json   SAME  cordis.patch.yml   SAME  DESIGN.md
```

### 6.2 自跑套件

```
$ node --test test/client-panel.test.mjs
  ℹ tests 28 / pass 28 / fail 0 / skipped 0

$ node --test
  ℹ tests 109 / pass 109 / fail 0 / skipped 0
```

### 6.3 我自己的审计

`panel-audit.mjs`（独立夹具、独立渲染树遍历、独立断言）：

```
================ PANEL AUDIT: 96 passed / 0 failed ================
================ HOOK DISCIPLINE A/B: 5 passed / 0 failed ================
```

---

## 7. 非阻断观测（6 项）

- **O1 · `cl.pruneUsedTools` 用 `|` 变体编码承载两种契约措辞**（`client.js:107` / `:169`）。
  §4.7 第 2 条要求两种措辞（0 / >0），而 §4.5 只冻结了一个键名。实现把三种变体
  （0 / 单数 / 复数）用 `|` 编进同一个冻结键，由 `variantText()`（`client.js:227`）按下标选定。
  **我实测该编码是收敛的**：全词典只有这一个键含 `|`；全代码只有一处使用它（`client.js:548`）；
  两种契约措辞逐字保留。风险是"任何不经 `variantText` 的消费方会看到三段拼接文本"——
  当前无此消费方，且若宿主词典覆盖为单段，`variantText` 会退化为直接渲染单段（只是失去变体区分）。
  → 建议 DESIGN v3 拆键后删除该编码（与 t8 的 E4-1 建议一致）；**本轮不判缺陷**。
- **O2 · 低置信标记用琥珀（`state-warn-primary`）而非中性灰**（`pruneLowStyle` `client.js:720`、
  `attributionWarnStyle` `client.js:713`）。§4.4 的"中性灰 + 问号"要求我按字面核对的是**归属徽标**——
  徽标确实走 `attributionUncertainStyle`（中性灰 + 虚线 + 文案自带 `?`），合规。
  琥珀只落在「推断，可能存在误判」这句**对推断本身的警示**上：它降低而非提升"卸载冲动"，
  与 §4.7 第 1 条禁止的"用红色告警暗示危害"方向相反。→ 记录为口径说明，非缺陷。
- **O3 · en 版 `no-owner-bundle` 理由含 "uninstallable"**
  （`client.js:175`：`no single uninstallable owner unit found: …`）。这是**描述性理由**，
  出现在「无法给出动作」分节内（不是候选行的建议），且只在计数 > 0 时显示；
  语义与 §2.16 的 `no-owner-bundle`（找不到唯一可卸载的装载单元）一致。
  按 §4.7 第 1 条的字面禁止清单（建议卸载/可以删掉/浪费/无用）判定**不构成违规**；
  点出来供队长按更严口径裁量。
- **O4 · `cl.topPerUseHint` 的软性措辞**（zh「比值越大越值得重新考虑」/ en "deserves a second look"）
  属 §4.5 v1 键、位于「每次使用最贵」段（非候选段）。它是软建议而非确定性指令，不在禁止清单内。
- **O5 · 任务文本写「六条」，DESIGN §4.7 实为 7 条**。我按 **7 条**全部核验（t8 的 E4-3 同样指出，
  且实现按 7 条落地）。这是 acceptance 文本的笔误，不是实现缺陷。
- **O6 · §4.7 第 3 条 caveat 原文带 markdown 强调符**（`**模型没有调用过**`）。面板非 markdown，
  t8 按纯文本逐字落地（去星号），句子其余部分逐字一致；我扫描确认词典值内**无残留 `**`**。
  与 t8 的 E4-2 记录一致。

---

## 8. 复现方式

```sh
# 我的渲染审计（穷举可见文案 + 7 条义务 + 五项 + 顺序 + caveat + unknown）
cd /home/u/Desktop/DSHWorkspace/.feas/t9-verify && node panel-audit.mjs

# v1「面板必崩」缺陷的 A/B 机械复现
cd /home/u/Desktop/DSHWorkspace/.feas/t9-verify && node hooks-ab.mjs

# 真实数据上屏逐字判读
cd /home/u/Desktop/DSHWorkspace/.feas/t9-verify && node real-panel.mjs

# 实现方套件与全量（我自己跑）
cd dsh-context-ledger && node --test test/client-panel.test.mjs && node --test
```

核验脚本与原始输出：`.feas/t9-verify/`（`panel-audit.mjs`、`hooks-ab.mjs`、`real-panel.mjs`、`logs/`）。

---

## 9. 最终判定

**pass。** §4.7 的 7 条硬性呈现义务全部落地并有双侧（结构 + 渲染输出）证据；
对抗性措辞检查在**穷举渲染输出**（zh/en 各 66 条受审文案 + 各 7 条属性型文案）后**零命中**；
候选行无红色告警配色；用于判断的第 2 条五项齐备（含 `usedToolCount=0` 与字段缺失都不省略）；
caveat 常驻段底、非 tooltip、不可折叠，且空/降级态仍在；`unknown` 只进「无法给出动作」分节、
绝不显示成「DSH 自带」；候选顺序逐条照抄宿主（含"低置信在前且更大"的证伪用例）；
改动范围严格限定在 §9 允许的两个文件（+ append-only 记录）。

另外，t8 附带修复的 v1 面板必崩缺陷经我机械 A/B 证实为**真实缺陷且已真修复**
（父组件 hook 数 13→19 → 13→13）。

6 项非阻断观测见 §7，其中 O1（`|` 变体编码）与 O5（acceptance 文本"六条"笔误）建议进 DESIGN v3 处理。
