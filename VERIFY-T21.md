# dsh-context-ledger — t21 独立复核报告（右侧栏承载 / R7）

> 复核人：验证（AgentTeams 成员）
> 任务：`t21 [verify]` · kind=review（round 6，绑定 t20）· attempt `34d27e3e-ede9-4c72-b681-aed5e99dd672`
> 复核基线：**`0140c96`**（feat(R7): context-ledger 支持以右侧栏形式打开（t20））
> 对比基线：`d1d2c15`（R7 之前）
> 判定基准：DESIGN v3 §4.7（七条）/ §4.8（六条）/ §4.5 / §2.19 / §2.22 / §2.24 / §6 第 11 条 / §9；
> 宿主契约：`dsh-client-ui-sidebar-right` 的 `slots.d.ts` 与 `service.d.ts`
> 纪律：未修改任何实现/测试/DESIGN；未触碰 `~/.dsh/**` 与 DSH 安装目录。
> **运行时验证已按要求执行并在结束后终止**（§3，含端口与残留进程证据）。

---

## 0. 结论

**verdict = pass**

t20 注册的是**真右侧栏 tab**（不是把 popover 改名）：类型 `kind` 注册进 `sidebarRightTabs`、正文与标题
两个座位用**同一个 key = 类型 id** 注册进 `sidebar.right.pane.tab` / `.title`（keyed 契约），
控件 click **真的调用** `ctx.sidebarRight.openTab('context-ledger')` 且**一次点击即成栏**，
缺服务时**不抛错并回退就地浮层**（不是死按钮）。

**最关键的一点：这次我在真实浏览器里把它展开过了。**

| 验收项 | 结论 | 证据 |
|---|---|---|
| 真伪判别（真 tab，非同名浮层） | ✅ | 契约 `slots.d.ts:53`/`:67`（keyed + scope:session + 「dispatched with the same key」）；注册调用点在 `client.js:2018-2034`；**浏览器里**正文落在 `.pI_x6G_rightbarCol` 内、chip 落在宿主 `role=tablist` 的 tab strip 内 |
| 点控件即开栏 | ✅ | `client.js:1885`（onClick 先问右侧栏，成功即 return）→ `client.js:1979-1989`（`face.openTab.call(face, LEDGER_TAB_KIND)`）；浏览器实测一次点击后右栏从 **0 → 324 px** |
| 优雅降级 | ✅ | 5 类坏环境（无服务/抛错/无 get/face 不全/openTab 抛错）全部**不抛错**返回 false；点击后**浮层真的打开**（回退路径回归验证） |
| 内容义务不减 | ✅ | §4.7 七条 + §4.8 六条在 `mode:'sidebar'` 下逐条通过；**sidebar 与 popover 的可见文本序列逐一相同**（内容零分叉） |
| 措辞红线（含 chip 与属性型） | ✅ | 遍历渲染树穷举 sidebar 正文 + 标题 chip + `title`/`aria-label`/… 属性：zh 118 条、en 119 条受审，禁止词命中 **0** |
| 词典同键、既有键未删改 | ✅ | 99 = 99 键；`git diff` 中 `cl.*` 词典行变更 **0 行** |
| `node --check` / 面板套件 | ✅ | exit 0；`test/client-panel.test.mjs` 46/46 |
| 不凭单次全绿 | ✅ | 连续 **12 次**全量 `node --test`：12/12 均 153/153 pass、0 fail、0 skipped |
| 范围 | ✅ | `0140c96` = `IMPLEMENTATION-NOTES.md` + `client.js` + `test/client-panel.test.mjs`（3 文件）；`index.js`/`lib/**`/`DESIGN.md`/`package.json`/`cordis.patch.yml` 触碰次数均为 **0** |

我自己的三套审计：`placement-audit.mjs` **50/0**、`sidebar-obligations.mjs` **35/0**、
`browser-sidebar.mjs`（真 Chromium）**20/0**。

非阻断观测 4 项见 §8。

---

## 1. 真伪判别：它注册的是真 tab（契约 + 注册形状 + 浏览器三重）

### 1.1 插槽契约出处（一手原文）

```
$ sed -n '53p;67p' $SR/lib/types/client/contract/slots.d.ts
  'sidebar.right.pane.tab': { kind: 'keyed'; scope: 'session'; ... }
  'sidebar.right.pane.tab.title': { kind: 'keyed'; scope: 'session'; ... }

契约注释（同文件）：
  · 正文座位：'One tab's body, dispatched with the `id` of the type in force for `tab.kind`.
              A tab type registers here under its definition's `id` …'
  · 标题座位：'A tab's title as its chip …, dispatched with **the same key** and information hook as the body.'
```

运行时按 key 分派（一手）：`$SR/lib/client.js:5551`
`entryKey: definition?.id ?? tab.kind`，且标题座位渲染为 `<span class={...tabTitle}>`。

`openTab` 契约与语义（一手）：`service.d.ts:138` 的 `interface ISidebarRight`；
实现 `$SR/lib/client.js:6394 openTab(kind, options)`：
`const { sessionId, actions } = this.require()` → `this.placeTab(...)`；
`require()` 在**无在屏会话**时抛 `sidebarRight: no session surface is mounted`（`:6744`），
`placeTab` 在 **kind 未注册**时抛 `sidebarRight: no tab type is registered as "<kind>"`。

### 1.2 注册形状（实现侧调用点）

```
$ grep -n 'tabs.register\|slots.inject\|slots.register\|LEDGER_TAB_SEATS' client.js
  client.js:367  LEDGER_TAB_SEATS = ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']
  client.js:2018  id: LEDGER_TAB_ID,            ← 'dsh-context-ledger'
  client.js:2019  kind: LEDGER_TAB_KIND,        ← 'context-ledger'
  client.js:2020  title: function () { return t('cl.title') }
  client.js:2024  native.slots.inject(seat, ...)   ← 逐个座位注入
  client.js:2028  key: LEDGER_TAB_ID,           ← 正文与标题**同一个 key**
  client.js:2032  seat === LEDGER_TAB_SEATS[0] ? LedgerTab : LedgerTabTitle
```

我用可控 ctx + 与宿主同形的 slots 服务回放 `apply()`，捕获到的注册行为：

```
  捕获：composer 座位 1 个 / 右侧栏座位 2 个
  类型定义: {"id":"dsh-context-ledger","kind":"context-ledger","title":"t:cl.title"}
  座位注册: [{"name":"sidebar.right.pane.tab","key":"dsh-context-ledger","locale":"context-ledger"},
             {"name":"sidebar.right.pane.tab.title","key":"dsh-context-ledger","locale":"context-ledger"}]
  PASS A8  tab 类型 = {id, kind}
  PASS A11 座位注入顺序 = 契约的两个座位名
  PASS A15 【keyed 契约】正文与标题共用同一 key
  PASS A16 【keyed 契约】key === 类型定义的 id（宿主按 id 分派）
  PASS A17 两个座位注册的是**不同**组件（正文 ≠ 标题）
  PASS A19 正文座位注册的是 LedgerTab，标题座位是 LedgerTabTitle
  PASS A6 延迟注入的服务名 = ['sidebarRightTabs']
```

> 注意 `A6`：类型注册走 `ctx.inject(['sidebarRightTabs'], cb)` 的**延迟注入**——
> 这正是"老宿主/headless 上回调永不执行、于是自然没有 tab"的降级机制（§4）。

### 1.3 浏览器里它是什么样（决定性）

```
=== 面板祖先链（点控件后，真实 Chromium）===
  [data-cl-tab] → …P3OORG_tabBody → _tabHostBody_._paneBody_ → SECTION._tabHost_._pane_
                → _tabCell_ → _tabLayout_ → _surface_ → P3OORG_panelBody → P3OORG_panel
                → P3OORG_session → **DIV.pI_x6G_rightbarCol** → pI_x6G_frame → BODY
  chip 渲染在宿主 tab strip（role=tablist）内：true
  chip 文案：Context Ledger
  panel 在右侧栏列内：true      panel 在 composer 停靠点内：false
  控件 aria-expanded：false（没有走就地浮层）
```

并且**宿主会持久化并恢复**我们的 tab：重新加载页面后 `tabOpenOnLoad: true`
（dock 布局 `data-dockkit-content="tab2" data-dockkit-pane="pane1"`）——
只有真正注册进注册表的类型才会被 dock 恢复。

---

## 2. 点控件即开栏（调用点 + 调用证据 + 一次即成）

实现（一手）：

```
client.js:1885   if (openLedgerTab !== null && openLedgerTab() === true) return   ← 右侧栏优先，成功即 return
client.js:1979   function openLedgerTab(ctx) {
client.js:1983     face.openTab.call(face, LEDGER_TAB_KIND)                       ← 真调用
```

我的调用证据：

```
  PASS B3 openTab 收到的 kind 就是注册的类型 kind → [['context-ledger', undefined]]
  PASS B7 一次点击 = 一次 openTab（不要求二次点击）→ ['context-ledger']
  PASS B8 开栏成功后**不**同时打开浮层（栏内已有内容）→ 浮层组件数 0
```

**浏览器实测的"列被展开"**（先点 dock 的 Close 关掉被恢复的 tab，再点控件）：

```
  载入时（宿主恢复）：右侧栏列宽 = 324   tab 在列内 = true   chip = "Context Ledger"
  关闭后：            右侧栏列宽 = 0     tab 存在 = false    浮层存在 = false
  点一次控件后：       右侧栏列宽 = 324   tab 在列内 = true    chip 在 strip 内 = true
  PASS D1 点击后右侧栏列宽 > 0
  PASS D2 列宽不小于关闭态（开栏后栏是展开的）
  PASS D3 一次点击即产生面板（没有要求二次点击）
```

`0 → 324 px` 是"同一列被展开"的直接测量，不是间接推断。

---

## 3. 运行时验证（队长硬要求）—— 已执行并在结束后终止

### 3.1 为什么必须做（写进报告的理由）

本插件 v1 曾有一个**必崩缺陷**（含 hook 的组件被当普通函数调用且位于条件分支内），
它穿过了三份报告合计 1000+ 条断言——**因为那些验证从未在浏览器里真正展开过面板**。
本次是**新增承载位置**，属同一类未覆盖风险：插槽契约、注册形状、降级分支都可以被结构断言"写对"，
但**"宿主是否真的接受这个 tab 类型、点一下是否真的成栏"只有真机能回答**。
所以本轮不再用静态与结构化断言了事。

### 3.2 环境（隔离、工作区内、受管）

```
隔离 home（工作区内）：/home/u/Desktop/DSHWorkspace/.feas/t21-verify/iso-home
  profiles/testbed/package.json  dsh.profile.bundles = [@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-context-ledger]
  dsh-context-ledger → link:/home/u/Desktop/DSHWorkspace/dsh-context-ledger
  $ DSH_HOME=<iso> dsh plugin --profile testbed install   →  linked（离线 pnpm，61ms）
  $ DSH_HOME=<iso> dsh --profile testbed --dump-config | grep -c context-ledger → 3
受管后台作业启动：DSH_HOME=<iso> dsh --profile testbed --no-open --host 127.0.0.1 --port 3099
  启动输出：dsh web: http://127.0.0.1:3099/?token=…（服务器就绪，LISTEN 127.0.0.1:3099）
浏览器：/usr/bin/chromium --headless=new --remote-debugging-port=9222（受管后台作业）
  驱动：我自写的 CDP 客户端（Node 内置 WebSocket，无第三方依赖）
真实 `~/.dsh` 未被使用（早先直接跑 `dsh web` 时被 EROFS 拒写，只读纪律 + 沙箱双重保证）。
```

### 3.3 结果

```
=== ① 宿主接受 tab 类型与两个座位 ===
  __DSH_BOOT__ 存在；应用挂载；[data-cl-trigger] 挂载成功（插件客户端半区已加载）
  宿主恢复出我们的 tab（tabOpenOnLoad=true，dock 布局 tab2/pane1）→ 类型已进注册表
  chip 在 role=tablist 的 strip 内；栏内正文含 R1 三块 + R6 三块 + 四类明细（8 个 data-cl-block）
  控制台错误/异常：无
=== ② openTab 在不抛错且列被展开 ===
  右侧栏列宽 0 → 324（同一步）
  面板祖先链命中 .pI_x6G_rightbarCol（真右侧栏列）
=== 浏览器审计总计 ===
================ BROWSER SIDEBAR AUDIT: 20 passed / 0 failed ================
```

截图证据（真实浏览器，右侧栏 tab 已打开）：

- `.feas/t21-verify/logs/shot-open.png` —— 右上角 tab strip 内可见 **「Context Ledger」** chip，右栏渲染账本体
- `.feas/t21-verify/logs/shot-clean.png` —— 同上（关掉 Preview Notice 后）：右栏标题
  「Context Ledger / resident cost × actual calls / updated 19:42:44 / ↻ Refresh」，
  以及 `tool schemas 139 never called`、`112`、`83`、`72` 等行

### 3.4 清理证据（不留常驻进程）

```
$ job_kill bash-1199（web 实例） / job_kill bash-1202（chromium）
$ job_list → bash-1199 killed, bash-1202 killed（bash-1196 是首次语法探路的已完成作业，exit 1）
$ 端口探活
  :3099 → 连接失败     ✓ 无监听
  :9222 → 连接失败     ✓ 无监听
$ ps -eo pid,ppid,etime,cmd | grep -E "dsh.*(testbed|web)|chromium|headless"  → （空 = 无残留）
```

---

## 4. 优雅降级：缺服务不抛错 + 回退就地浮层（不是死按钮）

```
=== 5 类坏环境，openLedgerTab 一律不抛错并返回 false ===
  PASS  get 返回 undefined（老宿主/headless） · 不抛错 · 返回 false
  PASS  get 抛错 · 不抛错 · 返回 false
  PASS  没有 get 方法 · 不抛错 · 返回 false
  PASS  face 不完整（无 openTab） · 不抛错 · 返回 false
  PASS  openTab 抛错（无在屏会话 / kind 未注册） · 不抛错 · 返回 false
  PASS  sidebarFaceOf 对 null/undefined/抛错 一律返回 null
  PASS  无 ctx.inject（老宿主）时 apply 不抛错；registerSidebarTab 返回 null（没有 tab）
  PASS  座位注册抛错不逃逸
  回滚轨迹: ["tab:context-ledger","tab-disposed"]  座位尝试: []
  PASS  抛错后回滚已注册的 tab 类型（fail-soft，不留半注册状态）
```

**回退路径的回归验证**（这条筛掉"只在理想环境能跑"的实现）：

```
  PASS C9  初始：浮层未打开
  PASS C11 缺服务时 openLedgerTab 返回 false
  PASS C12 【不是死按钮】点击后浮层组件真的被渲染了（LedgerPanel 组件数 0 → 1）
  PASS C13 回退路径同时给出 aria-expanded=true
  PASS C14 浮层组件仍包在 PanelBoundary 里（v1 崩溃缺陷的修法在新位置未退化）
```

---

## 5. 内容义务不减（§4.7 七条 + §4.8 六条，在 sidebar 渲染下逐条）

```
=== §4.7 ===
  PASS D1  §4.7① 段标题逐字（零调用候选 · 需人工确认）
  PASS D2  §4.7① 无 error 红
  PASS D3  §4.7⑤ 候选顺序照抄（hidePlan 四行 alpha/context_ledger/mcp__srv__x/ghosty）
  PASS D4  §4.7③ prunePlan caveat 常驻 1 个      PASS D5 非 tooltip（无 title）
  PASS D9  §4.7③ caveat 位于 prune-plan 段底（最后一个子节点）
  PASS D7  §4.7⑥ capped 页脚在屏
  PASS D8  §4.7⑦ 展开明细后证据路径可查 → ["证据：/p/pkgA/lib/tools.js"]
  PASS D8b §4.7⑦ 低置信同时给「推断，可能存在误判」
=== §4.8 ===
  PASS D10 §4.8① 段标题逐字        PASS D11 §4.8② 每行五件事实（4 行 × 5 节点）
  PASS D12 §4.8③ caveat 常驻 hide-plan 段底且不可折叠
  PASS D13 §4.8④ 两动作不得相加的硬规则在屏
  PASS D14 §4.8⑤ 已校验 ⇒ 1 个复制按钮 / 0 条未校验提示条
  PASS D19 未校验态 ⇒ 1 条提示条 / 0 个复制按钮
  PASS D15 §4.8⑥ selfTool 提示在屏
  PASS D16 §4.8 建议≠已施加（「不会自动施加」在屏）
  PASS D17 §2.24 恢复路径六行齐全（step1/2/3/subagent/no-undo/readonly）
  PASS D18 并列块逐单元两动作同屏（4 行）
```

### 内容零分叉（换位置不许改内容）

```
  PASS D20 两种承载位置的可见文本序列逐一相同（sidebar vs popover，逐条比对）
  唯一差异（属性）：[["role","dialog","region"],["data-cl-mode","popover","sidebar"]]
  PASS D21 除 id/role/mode 外无差异
```

即：`mode` 只换了**外层版式与语义**（`role: dialog → region`、加 `data-cl-mode`），
**文本内容一条不差**——这正是"内容义务不能因为换了位置就松"的机器可验证形式。

---

## 6. 措辞红线（含 tab 标题与属性型文本）+ 词典

严格方法沿用 `VERIFY-T9`/`T17`：**不读词典**，执行渲染函数后遍历渲染树；
本轮额外把 **`LedgerTabTitle`（栏 chip）** 与**全部属性型文本**纳入穷举。

```
  受审：sidebar 正文 + chip 文本 118 条 / 属性型 6 条（"Context Ledger","展开"×5）
  en  受审 119 条 / 属性 6 条
  PASS E1 zh（含 chip 与属性）确定性/完成态措辞命中 0
        （禁止词：建议隐藏/安全移除/零损失/无损失/可以删掉/浪费/无用/直接隐藏/应该隐藏/
          放心/不再需要/已隐藏/已经隐藏/一键恢复/自动回滚）
  PASS E2 tab chip 文案 = cl.title（"Context Ledger"）
  PASS E3 chip 不携带命令式/完成态属性文案
  PASS E4 en（含 chip 与属性）命中 0
  PASS E5 整屏无 error 红（无 state-error-primary / #ef6a7d）
  控件属性型文本：["title=打开上下文账本：常驻注入成本与真实调用次数 · Context Ledger",
                   "aria-label=Context Ledger"]
  PASS E6 控件属性文本无命令式/危害暗示
  PASS E7 控件 aria-label = cl.title（无障碍名与 tab 一致）
```

豁免仍只限契约强制的否定句（§4.7「不代表没用」、§2.23.4「不会自动施加…」、§3.7「不得相加…」、
§2.24「没有“撤销上一条隐藏”的命令」），剔除后覆盖上述 118/119 条。

词典：

```
  PASS F1 zh/en 同键        PASS F2 键数仍为 99（R7 零新增）
  PASS F3/F4 R7 之前全部键值未改（zh/en 逐条比对）
  PASS F5 键集未增未删
  $ git diff d1d2c15..0140c96 -- client.js | grep -cE "^[+-]\s*'cl\."   → 0 行
  PASS F6 R7 diff 中没有任何 cl.* 词典行被增删改
```

---

## 7. 自跑与范围

### 7.1 逐次结果

```
$ node --check client.js                      → exit 0
$ node --test test/client-panel.test.mjs      → ℹ tests 46 / pass 46 / fail 0 / skipped 0
$ for i in $(seq 1 12); do node --test; done
  run 1..12: tests=153 pass=153 fail=0 skipped=0        ← 12/12 全绿
```

### 7.2 我自己的审计

```
$ node placement-audit.mjs        → PLACEMENT AUDIT (A–C): 50 passed / 0 failed
$ node sidebar-obligations.mjs    → SIDEBAR OBLIGATIONS (D–F): 35 passed / 0 failed
$ APP_URL=… node browser-sidebar.mjs → BROWSER SIDEBAR AUDIT: 20 passed / 0 failed
```

### 7.3 范围

```
$ git show --stat 0140c96 --format=""
  IMPLEMENTATION-NOTES.md    |  16 ++
  client.js                  | 259 +++++++++---
  test/client-panel.test.mjs | 381 +++++++++++++
  3 files changed, 624 insertions(+), 32 deletions(-)

$ 在 0140c96 中的出现次数（应为 0）：
  index.js: 0   lib/hide.js: 0   lib/reconcile.js: 0   DESIGN.md: 0   package.json: 0   cordis.patch.yml: 0

$ git diff --numstat d1d2c15..0140c96 -- client.js                        → 233  26
$ git diff --numstat d1d2c15..0140c96 -- test/client-panel.test.mjs       → 375  6
```

client.js 的 26 行删除我逐行看过，**全部是重构**（不是删内容）：
`role: 'dialog'` → 变为按 mode 取值；`LedgerRing` 的取数 hook 抽成 `useLedgerData`；
`onClick` 从"直接 toggle"变为"先问右侧栏"；面板 props 从散字段改为 data 对象。
删除清单里**没有一条**是文案、断言或呈现义务。面板测试的 6 行删除是 `fakeContext`/`renderPanel` 的夹具重构。
**更强的不删证据**是 §5 的 `D20`：sidebar 与 popover 的可见文本序列**逐一相同**。

---

## 8. 非阻断观测（4 项）

- **O1 · `package.json` 的 `dsh.client.inject` 未列 `@deepseek-ai/dsh-client-ui-sidebar-right`**（t20 自陈）：
  实现走 `ctx.inject(['sidebarRightTabs'], …)` 延迟注入、**不 import** 该包任何模块，所以功能上不依赖它；
  但两个已发布先例都列了。`package.json` 不在 t20 的 in-scope，故这是**留给队长的裁量项**，非本轮缺陷。
- **O2 · 没有浏览器内 E2E 进入仓库测试**：我用真实 Chromium 验证了（§3），但那是我这边的临时驱动器，
  不在 `test/**` 里；仓库现有 46 个面板用例仍是结构化断言。若要长期防回归，建议把
  "真 tab / 一次点击成栏"固化成一条可在 CI 跑的检查（成本较高，需权衡）。
- **O3 · `sidebarMode` 的版式差异只在少量属性上**：`role: region` + `data-cl-mode: sidebar`（+ 调用方传的 `id`）。
  这是"内容零分叉"的前提，也是它可被机器验证的原因；记录在案以免后人把版式差异扩散到内容层。
- **O4 · `title` 座位的 thunk 与 chip 组件并存**：类型注册的 `title()` 返回 `cl.title`（宿主在无 live title 时用它），
  同时我们又注册了 `.title` 座位组件（chip 用它）。两者文案同源（同一词典键），实测 chip 显示 "Context Ledger"、
  控件 aria-label 也是 "Context Ledger"，一致；记录以免后人只改一处造成文案漂移。

---

## 9. 复现方式

```sh
# A–C：真伪判别 / 开栏调用 / 优雅降级
cd /home/u/Desktop/DSHWorkspace/.feas/t21-verify && node placement-audit.mjs
# D–F：内容义务（sidebar 模式）/ 措辞（含 chip 与属性）/ 词典
cd /home/u/Desktop/DSHWorkspace/.feas/t21-verify && node sidebar-obligations.mjs

# 运行时（隔离 home + 受管 web + 真 Chromium）—— 复现后请同样终止
ISO=/home/u/Desktop/DSHWorkspace/.feas/t21-verify/iso-home
DSH_HOME=$ISO dsh plugin --profile testbed install
DSH_HOME=$ISO dsh --profile testbed --no-open --host 127.0.0.1 --port 3099 &   # 记下输出里的 token URL
/usr/bin/chromium --headless=new --no-sandbox --remote-debugging-port=9222 \
  --user-data-dir=/tmp/t21-chrome about:blank &
APP_URL='<token URL>' node browser-sidebar.mjs
```

原始输出与截图：`.feas/t21-verify/logs/`（`placement-audit.log`、`sidebar-obligations.log`、
`browser-sidebar.log`、`shot-open.png`、`shot-clean.png`）。

---

## 10. 最终判定

**pass。** 本轮最重要的一件事——**真伪判别**——用三条独立证据链闭合：

1. **契约**：`slots.d.ts:53`/`:67` 两个 keyed 座位，正文按**类型定义的 id** 注册、
   标题"**dispatched with the same key**"；运行时按 `entryKey: definition?.id ?? tab.kind` 分派。
   实现注册的正是 `key = LEDGER_TAB_ID = 类型 id`，两个座位一个 body 组件一个 title 组件（`client.js:2018-2034`）。
2. **调用**：控件 onClick → `openLedgerTab()` → `face.openTab.call(face, 'context-ledger')`，
   一次点击一次调用、成功即 return（不弹浮层）；缺服务/抛错一律返回 false 并回退就地浮层，
   回退路径实测**浮层真的打开**，控件永远不是死按钮。
3. **真机**：在**工作区内隔离 `DSH_HOME`** 下用**受管后台作业**起 web 实例、用真 Chromium 打开，
   宿主**恢复并接受**了我们的 tab、chip 落在真 `role=tablist` 的 strip 内、正文落在 `.pI_x6G_rightbarCol` 内、
   点一次控件右栏从 **0 → 324 px**、全程**无控制台错误**；验证结束后实例与浏览器**均已终止**
   （端口 3099/9222 无监听、无残留进程）。

内容义务一条不减：§4.7 七条 + §4.8 六条在 sidebar 模式下逐条通过，且
**sidebar 与 popover 的可见文本序列逐一相同**；措辞穷举把 tab 标题与属性型文本都纳入后命中 0；
词典同键、`cl.*` 词典行零变更；面板套件 46/46、全量 12 次 153/153；
范围严格限于 `client.js` + `test/client-panel.test.mjs`（+ append-only 记录）。
