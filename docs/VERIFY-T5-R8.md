# dsh-context-ledger — t5 独立复核报告（R8 面板半区 + 字号 token 阶梯）

> 复核人：验证（AgentTeams 成员）
> 任务：`t5 [review, round 7]` · kind=review（绑定 **t3**）· attempt `b2a2e695-8335-48d7-a638-3cb71c602402`
> 复核对象：`client.js`（面板半区）+ `test/client-panel.test.mjs`（t3 自建套件）
> 契约基准：`DESIGN.md` v4 §4.2 / §4.4 / §4.5 / §4.7 / §4.8 / §4.9 / §5 / §6 第 11 条 / §9.2；`IMPLEMENTATION-NOTES.md` 的界面决定备案（字号映射表）
> 基线：**`3f8daf7`**（R8 之前的提交；`grep -c cl.windowScope` = 0）。复核中途仓库被提交为 `9c1c228`，因此**基线一律按 commit 钉死**，不用 `HEAD`
> 方法：**自建** vm 加载器 + 自建 mini-react（带 hook store）+ 自建元素树遍历器；判据落在渲染树的 `data-cl-*` 数据标记、文本与 `style` 上（黑名单式措辞检查不依赖词典）
> 纪律：未修改任何实现/测试/DESIGN 文件（`client.js` sha256 全程 `7e1ea383…` 未变）；未触碰 `/opt/dsh/node_modules/@deepseek-ai/dsh/**` 与 `~/.dsh/**`；**未启动或重启任何 web 服务**
> 自建脚本：`.t4-verify/harness4.mjs`（**63 通过 / 0 失败**），原始输出 `.t4-verify/h4.out`

---

## 0. 结论

**verdict = pass（未通过项：无）**

| # | 验收项 | 结论 | 决定性证据（渲染树层面） |
|---|---|---|---|
| 1 | **"不知道"与"0"在渲染树层面可分（最高优先）** | ✅ | 不可得输入下：总览节点 `data-cl-current-session-total="unavailable"` 且文本非数字；逐行 `data-cl-current-session="unavailable"` 且文本**一个数字都没有**；`data-cl-presence="unavailable"`（不画三态徽标）；同一屏上覆盖会话数仍是真数字（`2`）⇒ 未知不外溢。**跨半区集成**：宿主真实降级报告喂给面板，同结论（§2） |
| 2 | **三个数不得相加或混同** | ✅ | 三者皆非空时同屏：窗口总 `100`（`data-cl-figure="calls"`）、本会话 `5`（`data-cl-current-session`）、覆盖 `3/20 会话`（`data-cl-coverage`）；行内数字文本 `{402,100,4}` **不含** 105/103/8/95/20/15/108/41；覆盖数写成"会话"带分母 20，不是"次"（§3） |
| 3 | **三态一眼可辨** | ✅ | 行标记三值两两不同 `current-session`/`historical-only`/`absent`；`current-session` 与 `historical-only` 的徽标**文本与样式都不同**；`absent` 不另画徽标而是复用次数格的琥珀零调用格（`data-cl-state="zero"`，整行**恰好 1 个**零调用标记）；`historical-only` 的次数格是普通数字格（`data-cl-state` 未设，文本为真实次数 `4`）（§4） |
| 4 | **字号落在 token 阶梯** | ✅ | 静态：55 处 `fontSize` **全部**是 `FS.*` → `var(--dsw-font-*-font-size, Npx)`，**零**硬编码数字（改造前 43 处数字字号）；渲染期：114 个带字号节点全部 `var(--dsw-font-*)`，档位 `{11,12,13,14,20}`，**主力 12px**（39 个），**不出现 9.5/10px**（§5） |
| 5 | **行高同步、不挤压** | ✅ | 4 档 token 各带同档 `-line-height`（11/14、12/18、13/20、14/22）；渲染期每个带字号节点同时带行高，行高 ≥ 字号（`l-20` 用无单位 1.05 = 21px）；**带文字且固定像素高度的节点 = 0**（无夹字）（§5.3） |
| 6 | **措辞红线继续成立** | ✅ | 穷举渲染树**全部 1233 条字符串**（含 1130 条属性型：`title`/`aria-label`/`aria-*`/`style` 字符串），zh/en 各跑一遍，23 个禁止词命中 **0**（§6） |
| 7 | **词典同键、既有键未删改** | ✅ | 与 `3f8daf7` A/B：99 → 108 键，**+9 / -0 / 改动 0**；zh/en 键集完全一致（108 = 108）（§7） |
| 8 | **`node --check client.js` / 面板套件全绿** | ✅ | `node --check` exit 0；`node --test test/client-panel.test.mjs` = **59/59 pass, 0 fail, 0 skipped**（§8） |
| 9 | **不凭单次全绿** | ✅ | 全量 `node --test` **连续 10 次**：每次 179/179 pass、0 fail、0 skipped，且每次前后**整树 hash 一致**（`1204909a727027bd`）⇒ 无并发编辑干扰（§8） |
| 10 | **范围核实：仅 `client.js` + `test/client-panel.test.mjs`** | ✅ | t3 声明的两文件即其全部改动；`client.js` 在 R8 提交集里只由 t3 触碰（`client.js` 517 行改动，t6 不涉及）；复核期间 `client.js` sha256 未变（§9） |

---

## 1. 方法与基线

- **自建加载器**：把 `client.js` 当**经典脚本**在 `vm` 里执行，捕获 `window.__ModuleLoader__.load` 的唯一注册，再用只答 `react` 的 `require` 垫片物化 factory（其余 specifier 一律抛错，复刻宿主"missed the module table"语义）。实测 `require` 请求 = `["react"]`。
- **自建 mini-react**：`createElement`（children 展平）/ `useState`（持久 hook store，支持 `setState` 后重渲染）/ `useMemo` / `useCallback` / `useEffect` / `useRef` / `useId` / `Component`。**展开分类明细的交互真的执行**：拿到 `data-cl-category="tools"` 的头节点 → 调它的 `onClick()` → 重渲染。
- **自建遍历器**：展开成 `{kind:'el'|'text'}` 纯数据树，供三种判据用——① 数据标记（`data-cl-*`）；② 全字符串枚举（文本节点 + **所有属性** + style 里的字符串/数字）；③ `style` 数值化（字号/行高配对）。
- **不读词典做判据**：措辞检查用黑名单扫渲染树；"未知≠0"用标记 + "文本不含数字"判；只有渲染本身需要一份 `t`（用实现自己的 zh/en 词典），这不构成判据来源。渲染入口是 `__verify.LedgerPanel`（实现自带的核验缝，**未做任何源码改写**）。
- **基线钉死**：`git show 3f8daf7:client.js` 与当前 `client.js` 在同一个自建加载器里各跑一遍，比词典与字号分布。

```sh
$ node --check /home/u/Desktop/DSHWorkspace/.t4-verify/harness4.mjs && node harness4.mjs
  加载：register 1 次；require 请求 = ["react"]
  [PASS] L1-只 require react（模块表白名单）
  [PASS] L2-__verify 暴露 LedgerPanel / LedgerTab
  ...
###### harness4（面板）结果：PASS 63 / FAIL 0 ######
```

---

## 2. 最高优先：「不知道」不得渲染成 0

### 2.1 构造输入（三者皆不可得）

`scope.currentSession = {id:'sess-abc-123', basis:'agent-session-id', inWindow:false}`；逐项 `currentSessionCalls=null`、`callPresence=null`；`totals.currentSessionObservedCalls=null`；**覆盖会话数保持真值**（2/3/0）。

```sh
=== 2 · 当前会话维度不可得（inWindow=false / 三字段全 null）⇒ 屏上是"不可判定"而不是 0 ===
  总览「本会话」节点 = {"marker":"unavailable","text":"本会话调用本会话：不可判定（未进入扫描窗口）basis: agent-session-id","reason":"（未进入扫描窗口）"}
  [PASS] 2a-总览：「本会话调用」标记为 unavailable（不是数字格）
  [PASS] 2b-总览：该节点文本不是纯数字/不是 0 :: text="本会话：不可判定"
  [PASS] 2c-总览：给出原因（未进入扫描窗口）
  逐行 data-cl-current-session = ["unavailable","unavailable","unavailable","unavailable","unavailable"]
  逐行文本 = ["本会话：不可判定（未进入扫描窗口）", … ×5]
  [PASS] 2d-逐行 current-session 标记一律 unavailable :: 5 行
  [PASS] 2e-逐行文本一律不显示数字（尤其不是 0）
  [PASS] 2f-逐行 data-cl-presence = unavailable（不画三态徽标）
  覆盖会话数仍为真数字 = ["0","1","3","2","0"]
  [PASS] 2g-未知不外溢：覆盖会话数仍是真数字
  [PASS] 2h-屏上不存在"本会话 0"形态的文本（穷举文本与属性）
```

### 2.2 覆盖会话数不可得（另一维）

```sh
=== 3 · 覆盖会话数不可得（sessionsWithCalls=null）⇒ "不可判定"，不显示 0/20 ===
  覆盖会话数节点 = [["unavailable","未知"], … ×5]
  [PASS] 3a-标记为 unavailable
  [PASS] 3b-不显示 0/20 或其他伪造分母
```

### 2.3 反向：真 0 必须是真 0（不得被"未知"吞掉）

真机报告（本机真实会话日志，只读）里 `context_ledger` 本会话确实 0 次：

```sh
  (b) 真机报告 currentSession = {"id":"session-4cb04600-…","basis":"agent-session-id","inWindow":true}
      totals = {"observedCalls":2423,"currentSession":365}
  (b) 面板：总览标记 = value  逐行 = [["0","本会话 0"],["12","本会话 12"],["353","本会话 353"],["12","本会话 12"]]
  [PASS] 10h-真机：不可得行不含任何数字；可得行的显示值恒等于宿主字段（真 0 也是真 0）
```
判据：`unavailable` 行文本**不含任何数字**；数字行的显示值 `text.endsWith(marker)`（**恒等于**宿主字段，面板不重算、不伪造）。

### 2.4 跨半区集成（宿主 → 面板）

把**宿主半区真实产出**的报告（t4 的 `gatherLedger` 夹具：`sessionsScanned=3`、当前会话最旧）直接喂给面板：

```sh
  (a) 宿主报告 currentSession = {"id":"cur-session","basis":"agent-session-id","inWindow":false} totals.currentSessionObservedCalls = null
  (a) 面板：总览标记 = unavailable  逐行标记 = ["unavailable" ×8]
  (a) 面板覆盖会话数 = ["0","0","2","2","0","0","2","2"] （宿主 toolA/toolB=2、toolC/toolZ=0）
  [PASS] 10a/10b/10c/10d-…（总览不可判定、逐行无数字、窗口维度真数字、屏上无"本会话 0"）
```

---

## 3. 三个数不得相加或混同

夹具：`totals.observedCalls=100`、`bash.currentSessionCalls=5`、`bash.sessionsWithCalls=3`、`sessionsScanned=20`。

```sh
=== 1 · 三个数同屏且互不可加、不混同（窗口总 100 / 本会话 5 / 覆盖 3/20） ===
  bash 行取值格 = [["tokens","402"],["calls","100"],["tokens-per-call","4"]]
  bash 行 v4 行 = {"presence":"current-session","currentSession":"5","currentText":"本会话 5","coverage":"3","coverageText":"覆盖 3/20 会话"}
  bash 行数字文本 = [402,100,4]
  命中"相加/派生"候选值 = []
  [PASS] 1a-三个数同屏（窗口总/本会话/覆盖各成节点）
  [PASS] 1b-覆盖会话数带分母 20
  [PASS] 1c-行内不出现任何三数之和/差/积/商
  [PASS] 1d-覆盖会话数写成"会话"而非"次"
  [PASS] 1e-窗口总调用保持次数语义（列头 cl.observedCalls）
  [PASS] 1f-本会话行有独立标记与标签（current=5 / coverage=3 两节点）
  [PASS] 1k-总览不出现 105+6=111 之类的和 :: 整屏数字=["105","14","6","292","170","1","402","100","4","268","67"]
```
- **不相加**：行内数字文本集合与 8 种和/差/积/商取值无交集；整屏数字也不含 `111`（105+6）。
- **不混同**：覆盖会话数节点文本形如 `覆盖 3/20 会话`（**会话** + 分母），不含 `次`；窗口总调用仍在次数格（`data-cl-figure="calls"`，列头 `cl.observedCalls`），`tokensPerCall` 仍按 `calls` 显示（`4`）。

---

## 4. 三态一眼可辨（渲染树层面）

```sh
  三态徽标 = [
    ["bash","current-session","本会话已用",{…,"color":"var(--dsw-alias-brand-primary, #7c9bff)"}],
    ["claim_task","historical-only","本会话未用 · 历史会话用过",{…,"color":"var(--dsw-alias-label-secondary, #9ba5b5)"}],
    ["never_called_tool","absent",null,null]        ← absent 不另画徽标
  ]
  三行次数格 = {"bash":{"state":null,"text":"100"},"claim":{"state":null,"text":"4"},"never":{"state":"zero","text":"0 次"}}
  [PASS] 1g-行标记三态可判定 :: ["current-session","historical-only","absent"]
  [PASS] 1h-本会话已用 与 历史用过 是两个不同徽标（文本+样式都不同）
  [PASS] 1i-历史只用过：不用零调用样式（样式与零调用格不同）
  [PASS] 1j-absent 行只有一个零调用徽标（§4.4 v4 硬规则③：不重复画琥珀）
  [PASS] 1l-absent 用零调用样式、historical-only 是普通数字格（三态视觉可辨）
  [PASS] 1m-三种状态的标记两两不同
```
- 三态各有**可判定标记**（`data-cl-presence` 三值）+ **视觉差异**：品牌色徽标 / 中性灰徽标 / 琥珀圆角零调用格（`data-cl-state="zero"`，带边框）。
- `historical-only` 既不是零调用样式（样式与零调用格不同），也**没有**第二个琥珀标记（整行恰好 1 个零调用格）。

---

## 5. 字号：token 阶梯 + 行高同步 + 不挤压

### 5.1 静态（A/B vs `3f8daf7`）

```sh
改造前（3f8daf7）硬编码字号分布 = {"10":6,"11":4,"12":3,"13":1,"20":1,"10.5":18,"11.5":7,"9.5":3} 处数=43
改造后（工作区） 硬编码字号分布 = {} 处数=0  fontSize 总处数=55
```

```sh
=== 5 · 字号落在 --dsw-font-* token 阶梯（静态 + 渲染期风格） ===
  client.js 里 fontSize: 取值的不同形态 = ["FS.s14","FS.xxs12","FS.xs13","FS.l20","FS.xxxs11"]
  [PASS] 5a-静态无任何硬编码数字字号 :: 55 处全部为 token/变量
  含 px 的字体串样例 = ["var(--dsw-font-xxxs-11-font-size, 11px)","var(--dsw-font-xxs-12-font-size, 12px)", …]
  [PASS] 5b-像素只作为 token 的 fallback（var(--dsw-font-…, Npx)），无裸硬编码
```
- 43 处数字字号 → **0 处**；像素只出现在 token 的 fallback 位（`var(--dsw-font-xxs-12-font-size, 12px)`），这是标准写法，不是硬编码。
- 集中定义（`client.js:440-452`）：`FS = {xxxs11, xxs12, xs13, s14, l20}` + `LH = {xxxs11, xxs12, xs13, s14}`（`l-20` 用无单位 1.05）。

### 5.2 渲染期分布（真实渲染，不是读常量）

```sh
  折叠态（默认首屏）fontSize 分布 = {"…s-14…":1,"…xxs-12…":39,"…xs-13…":28,"…l-20…":3,"…xxxs-11…":17}
  渲染期 fontSize 分布（展开 tools 明细）= {"…s-14…":1,"…xxs-12…":39,"…xs-13…":38,"…l-20…":3,"…xxxs-11…":33}
  解析出的像素档 = [14,12,13,20,11]
  [PASS] 5c-渲染期每个 fontSize 都是 var(--dsw-font-*) :: 114 个节点
  [PASS] 5d-不再出现 9.5/10px
  [PASS] 5e-主力字号 ≥ 12px :: 主力=12px
  [PASS] 5f-全部字号 ≥ 11px（不低于宿主最小档）
```
- **主力 = 12px**（39 个节点，折叠态与展开态都是最大档），其次 13px；`11px` 只用于徽标/标签等次要元素（17→33 个），不低于宿主最小档 `xxxxs-11`。
- **9.5 / 10px 绝迹**（用户原始诉求"字号比 annotate 小不少"已解决：改造前 21/43 处 < 11px）。

### 5.3 行高与挤压

```sh
  带 fontSize 但无 lineHeight 的节点（span 允许继承）= 0
  [PASS] 5g-行高同步且不小于字号（不挤压） :: 配对样例=[[14,"…s-14-line-height, 22px)"],[12,"…xxs-12-line-height, 18px)"],[13,"…xs-13-line-height, 20px)"],[20,1.05]]
  行高取值 = ["…s-14-line-height, 22px)","…xxs-12-line-height, 18px)","…xs-13-line-height, 20px)",1.05,"…xxxs-11-line-height, 14px)"]
  带文字且有固定像素高度的节点 = []
  [PASS] 5h-无"文字被固定像素高度夹住"的挤压点（图标/进度条等非文字元素除外）
```
- 每档字号都有**同档**行高（11/14、12/18、13/20、14/22）；`l-20` 用无单位 `1.05`（= 21px）。
- 全树**没有**"带文字 + 固定像素高度"的节点（固定高度只出现在 30×30 图标按钮、4px 占比条、12×12 svg、8×8 圆点）；浮层用 `maxHeight: min(72vh, 640px)` + 滚动，不裁字。

---

## 6. 措辞红线（穷举字符串，含属性型逃逸口）

```sh
=== 7 · 措辞红线（穷举文本节点 + title/aria-label/placeholder/alt/data-* + style 字符串） ===
  zh：字符串总数=1233，属性型字符串=1130，禁止词命中=0
  en：字符串总数=1233，属性型字符串=1130，禁止词命中=0
  属性型文本样例 = [{"attr:aria-label","Context Ledger"},{"attr:style.fontVariantNumeric","tabular-nums"},{"attr:aria-hidden","true"}, …]
  [PASS] 7a-zh 禁止词命中为 0 / 7a-en 禁止词命中为 0
  [PASS] 7b-覆盖到 title/aria-* 等属性逃逸口 :: 48 条
```
禁止词（23 个，zh+en）：`建议卸载 / 可以删掉 / 应该删除 / 值得删除 / 安全移除 / 零损失 / 毫无损失 / 浪费 / 从未使用 / 从来没用过 / 永远不 / 永久不用 / uninstall advice / you should remove / safe to delete / worthless / wasted / should be uninstalled / recommend removing / never used` 等。
> 说明：`cl.neverCalled` 的冻结文案（`0 次` / `never called`）**不在**禁止词内——它是 §4.4 v1 起的冻结键；本轮红线针对"把窗口内零调用说成从未使用"，已由 `cl.windowScope`（两处常驻）+ `cl.windowOmitted` 承担。

---

## 7. 词典：同键 + 既有键零删改（A/B vs `3f8daf7`）

```sh
  基线 3f8daf7 的词典键数 = 99
  当前键数 = 108（zh）/ 108（en）
  既有键被删除 = []
  既有键取值被改 = []
  新增键 = ["cl.currentSessionCalls","cl.currentSessionOutsideWindow","cl.currentSessionTotal","cl.currentSessionUnknown","cl.presence.currentSession","cl.presence.historicalOnly","cl.sessionCoverage","cl.windowOmitted","cl.windowScope"]
  [PASS] 8a-zh/en 同键 / 8b-既有键零删除 / 8c-既有键取值零改动 / 8d-v4 新增 9 键 / 8e-en 既有键零删除/零改动 / 8f-zh 无缺失键
```
与 §4.5 冻结的 9 个 v4 键**逐字对应**，既有 99 键一字未动（含 `cl.zeroCallTitle`，与 t3 自述一致）。

---

## 8. 两个承载位置 + 命令行验收

```sh
=== 9 · 两个承载位置（popover / sidebar）：v4 节点与窗口行逐字相同 ===
  [PASS] 9-currentSessionCalls 两位置逐字相同 :: [["0","本会话 0"],["1","本会话 1"],["5","本会话 5"],…] === 同
  [PASS] 9-sessionsWithCalls 两位置逐字相同 :: [["0","覆盖 0/20 会话"],["3","覆盖 3/20 会话"],…] === 同
  [PASS] 9-windowScope 两位置逐字相同 :: 两处（overview/zero-call）逐字一致
  [PASS] 9-presence 两位置逐字相同 :: 三态徽标节点逐字一致
```

```sh
$ node --check client.js          # exit 0
$ node --test test/client-panel.test.mjs
ℹ tests 59  ℹ pass 59  ℹ fail 0  ℹ skipped 0  ℹ todo 0

$ for i in $(seq 1 10); do … node --test …; done      # 全量连续 10 次
t5-block run 1..10: ℹ tests 179 ℹ pass 179 ℹ fail 0 ℹ skipped 0 ℹ todo 0 | tree 1204909a727027bd->1204909a727027bd （每次相同）
```

---

## 9. 范围核实

- **t3 的两个文件**：`client.js`（517 行改动）+ `test/client-panel.test.mjs`（889 行改动，含 t6 的 C4/C5 收口增量）。
- **`client.js` 未被 t6 触碰**：R8 提交集 `git diff --stat 3f8daf7..9c1c228` 里 `client.js` 只出现在 t3 的交付中；复核全程 `client.js` sha256 = `7e1ea38326f2af0ec157351f2269eae935cf7a3cb1b8665e3c645a7c1752c701`（复核开始时记录的值，收工时相同）⇒ 我未改动任何文件，t3 的成品在复核期间是冻结的。
- **其余改动属别的线**：`DESIGN.md` / `IMPLEMENTATION-NOTES.md`（t1、t6）、`index.js` / `lib/reconcile.js` / `test/*.js`（t2）、`.feas/**` 与 `VERIFY-T4-R8.md`（工作区伴随物）。

---

## 10. 非阻断观测（不构成缺陷，供队长/后续轮备案）

| # | 观测 | 依据 | 判定 |
|---|---|---|---|
| O1 | `basis === "unavailable"` 无专属文案键，面板用「不可判定 + `basis` 原文」组合呈现 | §4.9 第 4 条 vs §4.5 无该键 | 与 t3 的契约观察 A 一致；§4.5"既有键不动"下这是合规组合，**建议 v4.1 补键**（非本轮缺陷） |
| O2 | `sessionsWithCalls === null` 复用 `cl.unknown`（`未知`）中性徽标，不显示 `0/20` | §4.9 第 3 条无专属键 | 与 t3 观察 B 一致；行为满足"不显示 0" ⇒ 非缺陷 |
| O3 | 零调用段标题保持 `cl.zeroCallTitle`（`零调用 · 模型未调用`），窗口口径由段底 `cl.windowScope` 承担 | §4.2 第 3 段 vs §4.5"既有键不动" | 与 t3 观察 C 一致；两处窗口声明**常驻且不可折叠**已在渲染树验证 ⇒ 非缺陷 |
| O4 | 11px（宿主最小档）仍用于徽标/次要标签（折叠态 17 个、展开态 33 个节点） | 渲染期分布 | 契约只要求"主力 ≥12px 且不出现 9.5/10px"，二者均成立 ⇒ 非缺陷 |
| O5 | `client.js` 里 `t()` 兜底与词典键在渲染期全部命中（无 `missing`） | §8.6 | 正常 |
| O6 | 复核期间仓库被提交为 `9c1c228`（含我的 `VERIFY-T4-R8.md`）；基线已改为按 commit `3f8daf7` 钉死 | §1 | 已按新基线复跑，结论不变（A/B 仍显示 99→108 键） |

---

## 11. 未通过项

**无。** 本报告不含 `findings`，`verdict = pass`。

---

## 12. 复现命令清单

```sh
cd /home/u/Desktop/DSHWorkspace/.t4-verify
node harness4.mjs                 # 面板渲染树核验（63 通过 / 0 失败）
node harness1.mjs                 # 宿主夹具（harness4 §10(a) 复用 fx-window）
# 静态与命令行验收
cd ../dsh-context-ledger
node --check client.js
node --test test/client-panel.test.mjs
for i in $(seq 1 10); do
  before=$(sha256sum index.js lib/*.js client.js test/*.js test/*.mjs | sha256sum | cut -c1-16)
  node --test 2>&1 | grep -E '^ℹ (tests|pass|fail|skipped)'
  after=$(sha256sum index.js lib/*.js client.js test/*.js test/*.mjs | sha256sum | cut -c1-16); echo "tree $before->$after"
done
# 字号 A/B（基线按 commit 钉死）
git show 3f8daf7:client.js | grep -o 'fontSize: [0-9.]*' | sort | uniq -c
grep -o 'fontSize: FS\.[a-z0-9]*' client.js | sort | uniq -c
```
