/**
 * dsh-context-ledger — 浏览器半区（client bundle，实现 DESIGN.md 冻结项 C：§4 面板层级）。
 *
 * 落座位置：`conversation.input.right`（kind: 'list'，composer 工具行右端、Send 之前），
 * `id: 'context-ledger'`、`order: 21`。宿主证据（本机 0.2.0-rc.2，只读核对）：
 *   - 插槽声明：dsh-client-ui-conversation/lib/client.js:18317
 *     `"conversation.input.right": { kind: "list", scope: "session" }`（conversation.composer.bar 的 children）
 *   - 渲染点：dsh-client-ui-conversation/lib/client.js:17532 `renderSlot("conversation.input.right", {})`
 *   - 类型契约：dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:235
 *   - 插槽目录（registerOptions：id 必填 / order 可选；list 座位「新 id 落在内置条目旁边」）：
 *     dsh-cordis-client-runner/lib/client.js:3279（source: packages/client/ui-conversation/src/client/contract/slots.ts:203）
 * 因此本控件不挤占任何既有控件（list 语义 + 自己的 id）。
 *
 * 载荷形态（宿主契约，勿改形状）：client-modules 把 `exports["./client"]` 指向的本文件当作
 * **经典脚本**加载；脚本必须调用 `window.__ModuleLoader__.load({ id, factory })`，factory 在首次
 * materialize 时执行，其 `require` 只解析 loader 模块表（platform seed）里的平台单例：
 * react / react/jsx-runtime / react-dom / react-dom/client / @deepseek-ai/cordis /
 * @deepseek-ai/dsh-client-store / @deepseek-ai/dsh-client-ui-slots /
 * @deepseek-ai/dsh-client-ui-primitives / @deepseek-ai/dsh-client-ui-dockkit。
 * 本文件因此**只 require `react`**，其余协作全部走 cordis 服务（`slots` / `locale`），
 * 不 import 任何其它插件的客户端包（跨插件值导入被 harness 的 bundle purity 门禁禁止）。
 * 证据：dsh-client-modules/lib/index.js:461-472（queue 模式下 factory(require) → exports 的调用约定）、
 *       dsh-client-modules/lib/client.js:700-706（require 未命中即抛「missed the module table」）、
 *       dsh-web-frontend/dist/assets/index-5SrrfWpU.js（staticModules 种子，含上述 9 个词）。
 *
 * 隐私边界（DESIGN §3，对客户端同样成立）：面板**只**消费宿主半区给出的 canonical JSON
 * （工具名 / 技能名 / 路径 / 计数 / 估算 token），自己**不**读会话日志、**不**读工具参数、
 * **不**读工具结果与任何消息正文；唯一的网络请求是宿主同源路由 GET /api/context-ledger/ledger。
 *
 * 数据契约（DESIGN §2）：report = context_ledger 输出的 canonical JSON。面板只做展示映射：
 * 不重排 canonical 顺序、不二次计算次数、`calls === null` 绝不渲染成 0（§4.4 硬规则）。
 *
 * @module dsh-context-ledger/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-context-ledger',
  factory: function (require) {
    'use strict'

    var React = require('react')
    var h = React.createElement
    var useCallback = React.useCallback
    var useEffect = React.useEffect
    var useId = React.useId
    var useMemo = React.useMemo
    var useRef = React.useRef
    var useState = React.useState

    /* ══════════════════════════════════════════════════════════════════════
     * 文案词典 —— 命名空间 context-ledger，zh/en 同键（DESIGN §4.5 冻结键集，33 键）
     * 产品名词（token / schema / MCP / Context Ledger）两种语言都不翻译。
     * ══════════════════════════════════════════════════════════════════════ */

    /** 面板命名空间（与 DESIGN §4.1 冻结值一致，勿改）。 */
    var NS = 'context-ledger'

    var zh = {
      'cl.title': 'Context Ledger',
      'cl.subtitle': '常驻成本 × 实际调用对账',
      'cl.hint': '打开上下文账本：常驻注入成本与真实调用次数',
      'cl.residentTotal': '常驻合计',
      'cl.tokens': 'token',
      'cl.observedCalls': '观测调用',
      'cl.tokensPerCall': '每次使用成本',
      'cl.sessionsCovered': '覆盖 {scanned} / {available} 个会话',
      'cl.window': '{start} → {end}',
      /* v2 修订（DESIGN §4.2）：调用次数只证明“模型没调用过”，不得写成“贵且没用”或任何等同“没用”的说法。 */
      'cl.zeroCallTitle': '零调用 · 模型未调用',
      'cl.zeroCallHint': '观测窗口内模型的调用次数为 0；这只统计模型的工具调用',
      'cl.topPerUseTitle': '每次使用最贵',
      'cl.topPerUseHint': '常驻 token ÷ 调用次数；比值越大越值得重新考虑',
      'cl.neverCalled': '0 次',
      'cl.unknown': '未知',
      'cl.noEvidence': '未读到会话日志，无法判定调用次数',
      'cl.cat.instructions': '指令链',
      'cl.cat.skills': '技能目录',
      'cl.cat.tools': '工具 schema',
      'cl.cat.mcp': 'MCP 工具',
      'cl.alwaysOnNote': '常驻，无调用信号',
      'cl.skillsUnknownNote': '逐项不可观测（技能名在工具参数中）',
      'cl.skillLoads': '{calls} 次技能加载 · {each} token/次',
      'cl.expand': '展开',
      'cl.collapse': '收起',
      'cl.more': '还有 {n} 项',
      'cl.refresh': '刷新',
      'cl.updated': '更新于 {when}',
      'cl.loading': '正在读取账目…',
      'cl.error': '账目读取失败',
      'cl.empty': '清单为空',
      /* v2：隐私声明加入归属的推断性质（§4.2 第 5 段） */
      'cl.privacyNote': '仅回放工具名与调用次数（不含正文）；归属为安装侧静态推断，非运行时可证',
      'cl.rejectedWarning': '有 {n} 条调用名未通过名字护栏，已丢弃',
      /* ── v2 新增键（DESIGN §4.5，21 个；键名冻结，zh/en 同键）──────────────────── */
      /* §4.7 第 1 条：段标题必须是候选语气（文案逐字来自契约） */
      'cl.prunePlanTitle': '零调用候选 · 需人工确认',
      'cl.prunePlanHint': '按动作单元分组：模型从未调用过的工具；仍需你确认是否真的没在用',
      /* §4.7 第 3 条：固定不确定性声明（必须常驻段底，不得折叠/藏进 tooltip） */
      'cl.prunePlanCaveat': '这些候选只说明模型没有调用过，不代表没用：工具可能由界面、后台流程或极低频但关键的操作使用。请确认你也没有使用其功能后再移除。',
      'cl.pruneUnitPlugin': '插件包',
      'cl.pruneUnitMcpServer': 'MCP 服务器',
      /* §4.7 第 2 条：工具数 + 代表工具名（完整清单在展开里） */
      'cl.pruneToolsCount': '{n} 个未调用工具：{names}',
      /* §4.7 第 2 条：可省 token 必须带「若未使用」条件语 */
      'cl.pruneReclaimableTokens': '若未使用可省 {tokens} token',
      /* §4.7 第 2 条：同单元在用工具数。两种措辞（0 / 单数 / 复数）以 `|` 变体编码在同一个冻结键里，
       * 因为 §4.5 只给了这一个键——详见 variantText() 的说明（已作为 E4 观察上报队长）。 */
      'cl.pruneUsedTools': '该单元无在用工具|另有 1 个工具在用|另有 {n} 个工具在用',
      'cl.pruneFactPackages': '事实包：{packages}',
      'cl.pruneConfidenceLow': '推断，可能存在误判',
      'cl.noRecommendationTitle': '无法给出动作',
      'cl.reason.core': 'DSH 自带：{items} 个未调用工具，{tokens} token',
      'cl.reason.no-owner-bundle': '找不到唯一可卸载的装载单元：{items} 个未调用工具，{tokens} token',
      'cl.reason.unknown-attribution': '归属未知：{items} 个未调用工具，{tokens} token',
      'cl.providedBy.plugin': '插件 {name}',
      'cl.providedBy.core': 'DSH 自带',
      'cl.providedBy.mcp-server': 'MCP: {name}',
      'cl.providedBy.unknown': '归属未知',
      'cl.providedBy.inferred': '归属（推断）',
      'cl.providedBy.evidence': '证据：{path}',
      'cl.providerScanCapped': '本次归属扫描触达上限，覆盖可能更窄',
      /* ── v3 新增键（R6/R3 必需；DESIGN §4.8 的呈现义务需要这些文案）────────────────
       * 说明：DESIGN v3 §4.8 规定了逐条文案义务，但 §4.5 只列到 v2 键集、未给 v3 清单
       * （机械合并时的遗漏，已作为 E4 观察上报队长）。这里按 §4.8 / §2.19 / §2.22 / §2.24
       * 的**逐字契约文案**新增 `cl.hide*` 键；既有 v1/v2 键一个未删、一个未改值。
       * 单元种类与事实包复用 v2 已冻结的同义键（cl.pruneUnitPlugin / cl.pruneUnitMcpServer /
       * cl.providedBy.core / cl.providedBy.unknown / cl.pruneFactPackages），避免同义重复。 */
      'cl.hidePlanTitle': '可隐藏候选（工具级）· 需人工确认',
      'cl.hidePlanHint': '这些工具模型从未调用过；隐藏后模型将无法再调用它们（注册表级），而不是只从视图里藏起来',
      'cl.hide.registryUseLabel': '该功能是否经注册表被调用',
      'cl.hide.registryUseBasis': 'DSH 无法观测非模型的注册表调用',
      'cl.hide.verdict.unconfirmed': '未确认',
      'cl.hide.verdict.modelObserved': '模型调用过（正常不会进候选）',
      'cl.hide.precheckLabel': '预校验',
      'cl.hide.precheck.prechecked': '已校验',
      'cl.hide.precheck.unvalidated': '未校验',
      'cl.hide.precheck.unsupported': '不支持',
      'cl.hide.reason.not-in-restrictable-names': '不在该 agent 的可限制名字集合里',
      'cl.hide.reason.no-agent-scope': '拿不到该 agent 的作用域',
      'cl.hide.reason.interface-absent': '宿主没有该接口',
      'cl.hide.reason.reserved-name': '保留名字',
      'cl.hide.selfToolNote': '隐藏后模型将无法再调用本账本',
      'cl.hide.referencedElsewhere': '别处引用过该名字（需人工确认）',
      'cl.hide.unvalidatedBanner': '未校验，不要直接照抄清单',
      'cl.hide.denyListLabel': '可粘贴清单（{n} 个名字）',
      'cl.hide.copyDenyList': '复制清单',
      'cl.hide.copied': '已复制',
      'cl.hide.copyUnavailable': '浏览器未提供剪贴板，请手动选中下面的清单复制',
      'cl.hide.applyModeLabel': '施加方式',
      'cl.hide.applyMode.suggestionOnly': '仅建议：本插件不会自动施加（appliedNames 为空）',
      'cl.hide.applyMode.appliedByConfig': '按你自己的配置施加（来自 profile patch，不是本插件自动决定）',
      'cl.hide.applyApplied': '已施加 {n} 个名字',
      'cl.hide.applySkipped': '{n} 个名字未施加（接口缺失或名字不可限制）',
      /* §4.8 第 3 条：五条代价/不确定性；键名与 hidePlanCaveat 的五个字段一一对应，常驻段底 */
      'cl.hide.caveatTitle': '代价与不确定性（常驻本节底部）',
      'cl.hide.caveat.registryHideIsTotal': '隐藏是注册表级的：该名字在该 agent 作用域内不可见、也不可解析——不是只从 schema 里抹掉',
      'cl.hide.caveat.nonModelRegistryCalls': '非模型的注册表调用没有观测面：DSH 看不到这类调用',
      'cl.hide.caveat.serviceCoupling': '功能是否由独立服务提供（UI/后台不经注册表）静态不可判定，须逐单元人工确认',
      'cl.hide.caveat.confirmationRequired': '施加前必须人工确认；本插件不代替用户确认',
      'cl.hide.caveat.prefixCacheCost': '任何隐藏都会改变请求前缀，导致 prompt cache 一次性失效（一次性成本，不是持续成本）',
      /* §2.24 恢复路径 */
      'cl.hide.restoreTitle': '如何恢复（隐藏来自配置；本插件不提供撤销命令）',
      'cl.hide.restoreStep1': '1. 在 <profile>/cordis.patch.yml 的 `- id: context-ledger` 条目里把 hide.apply 改回 false；只想恢复个别工具就从 deny 里删掉那些名字',
      'cl.hide.restoreStep2': '2. 重载：启用了 HMR 时保存即生效（限制挂在 effect 层，释放即解除）；否则重启对应 profile',
      'cl.hide.restoreStep3': '3. 已在运行的 agent / 子代理不追溯（限制只在创建时施加），重启即消失',
      'cl.hide.restoreSubagent': '子代理载体：把描述符里的 toolFilter 去掉；新子代立即不受限',
      'cl.hide.restoreNoUndo': '没有“撤销上一条隐藏”的命令；恢复就是把配置改回去',
      'cl.hide.restoreReadonly': '本插件只输出片段：不生成、不修改、不备份你的配置文件',
      /* §2.22 并列呈现（与 prunePlan 同屏；token 不得相加） */
      'cl.hide.parallelTitle': '两套动作并列（互斥的替代方案）',
      'cl.hide.parallelHint': '每个单元一行：上一行是隐藏该单元的工具，下一行是卸载该单元',
      'cl.hide.unitHideLine': '隐藏这 {tools} 个工具可省 {tokens} token（代价：这些名字注册表级不可用；须人工确认）',
      'cl.hide.unitPruneLine': '卸载该单元可省 {tokens} token（代价：失去 {used} 个在用工具，以及该单元的 UI/后台功能）',
      'cl.hide.noUninstall': '无法通过卸载移除',
      'cl.hide.noSum': '两种动作互斥：隐藏的可省 token 与卸载的可省 token 不得相加（不是两笔收益之和）',
      /* ── v4 新增键（DESIGN §4.5 的 R8 清单，9 个；键名冻结，zh/en 同键）──────────────
       * 窗口口径不靠改既有键取值实现（`cl.zeroCallTitle` 等一字不动），只靠 `cl.windowScope` /
       * `cl.windowOmitted` 两行常驻（§4.5 的复用规则）。`absent` 复用既有 `cl.neverCalled`。 */
      'cl.windowScope': '扫描窗口：{scanned} / {available} 个会话 · {start} → {end} · 边界取自日志文件 mtime（{basis}）',
      'cl.windowOmitted': '另有 {n} 个更早会话未纳入本次扫描',
      'cl.currentSessionCalls': '本会话',
      'cl.sessionCoverage': '覆盖 {n}/{scanned} 会话',
      'cl.currentSessionTotal': '本会话调用',
      'cl.currentSessionUnknown': '本会话：不可判定',
      'cl.currentSessionOutsideWindow': '（未进入扫描窗口）',
      'cl.presence.currentSession': '本会话已用',
      'cl.presence.historicalOnly': '本会话未用 · 历史会话用过',
    }

    var en = {
      'cl.title': 'Context Ledger',
      'cl.subtitle': 'resident cost × actual calls',
      'cl.hint': 'Open the context ledger: resident injection cost against real call counts',
      'cl.residentTotal': 'resident',
      'cl.tokens': 'token',
      'cl.observedCalls': 'observed calls',
      'cl.tokensPerCall': 'cost per use',
      'cl.sessionsCovered': '{scanned} / {available} sessions covered',
      'cl.window': '{start} → {end}',
      'cl.zeroCallTitle': 'never called by the model',
      'cl.zeroCallHint': 'zero model tool calls in the window; this counts model tool calls only',
      'cl.topPerUseTitle': 'most expensive per use',
      'cl.topPerUseHint': 'resident tokens ÷ calls; a higher ratio deserves a second look',
      'cl.neverCalled': 'never called',
      'cl.unknown': 'n/a',
      'cl.noEvidence': 'no session-log evidence; call counts unavailable',
      'cl.cat.instructions': 'instructions',
      'cl.cat.skills': 'skills',
      'cl.cat.tools': 'tool schemas',
      'cl.cat.mcp': 'MCP tools',
      'cl.alwaysOnNote': 'always resident; no call signal',
      'cl.skillsUnknownNote': 'per-skill unknown (the skill name lives in tool arguments)',
      'cl.skillLoads': '{calls} skill loads · {each} tokens/load',
      'cl.expand': 'expand',
      'cl.collapse': 'collapse',
      'cl.more': '+{n} more',
      'cl.refresh': 'Refresh',
      'cl.updated': 'updated {when}',
      'cl.loading': 'reading the ledger…',
      'cl.error': 'ledger request failed',
      'cl.empty': 'empty list',
      'cl.privacyNote': 'replays tool names and call counts only (no message content); '
        + 'attribution is a static install-side inference, not runtime-provable',
      'cl.rejectedWarning': '{n} call names failed the name guard and were dropped',
      /* ── v2 additions (DESIGN §4.5; 21 keys, same key set as zh) ───────────────── */
      'cl.prunePlanTitle': 'Never-called candidates · needs your call',
      'cl.prunePlanHint': 'grouped by removal unit: tools the model never called; only you can confirm they are unused',
      'cl.prunePlanCaveat': 'These candidates only say the model never called them; that does not mean they are unused: '
        + 'a tool may still be used by the UI, by background flows, or by rare but crucial operations. '
        + 'Please confirm you are not using their features before removing them.',
      'cl.pruneUnitPlugin': 'plugin package',
      'cl.pruneUnitMcpServer': 'MCP server',
      'cl.pruneToolsCount': '{n} never-called tools: {names}',
      'cl.pruneReclaimableTokens': '{tokens} tokens reclaimable if unused',
      /* 0 / singular / plural variants of the same frozen key — see the zh note and variantText(). */
      'cl.pruneUsedTools': 'no tool of this unit is in use|1 other tool of this unit is in use'
        + '|{n} other tools of this unit are in use',
      'cl.pruneFactPackages': 'fact packages: {packages}',
      'cl.pruneConfidenceLow': 'inferred — may be wrong',
      'cl.noRecommendationTitle': 'no action available',
      'cl.reason.core': 'bundled with DSH: {items} never-called tools, {tokens} tokens',
      'cl.reason.no-owner-bundle': 'no single uninstallable owner unit found: {items} never-called tools, {tokens} tokens',
      'cl.reason.unknown-attribution': 'attribution unknown: {items} never-called tools, {tokens} tokens',
      'cl.providedBy.plugin': 'plugin {name}',
      'cl.providedBy.core': 'bundled with DSH',
      'cl.providedBy.mcp-server': 'MCP: {name}',
      'cl.providedBy.unknown': 'attribution unknown',
      'cl.providedBy.inferred': 'attribution (inferred)',
      'cl.providedBy.evidence': 'evidence: {path}',
      'cl.providerScanCapped': 'this attribution scan hit its cap; coverage may be narrower',
      /* ── v3 additions (R6/R3; see the zh block for the §4.5 gap note) ───────────── */
      'cl.hidePlanTitle': 'Hide candidates (tool level) · needs your call',
      'cl.hidePlanHint': 'the model never called these tools; hiding them makes them unreachable for the model '
        + '(registry level), not merely absent from the view',
      'cl.hide.registryUseLabel': 'is this feature used via the tool registry',
      'cl.hide.registryUseBasis': 'DSH cannot observe non-model registry calls',
      'cl.hide.verdict.unconfirmed': 'unconfirmed',
      'cl.hide.verdict.modelObserved': 'called by the model (normally not a candidate)',
      'cl.hide.precheckLabel': 'precheck',
      'cl.hide.precheck.prechecked': 'validated',
      'cl.hide.precheck.unvalidated': 'not validated',
      'cl.hide.precheck.unsupported': 'unsupported',
      'cl.hide.reason.not-in-restrictable-names': 'not in this agent\'s restrictable names',
      'cl.hide.reason.no-agent-scope': 'no agent scope available',
      'cl.hide.reason.interface-absent': 'the host has no such interface',
      'cl.hide.reason.reserved-name': 'reserved name',
      'cl.hide.selfToolNote': 'hiding it removes the ledger as a callable tool for the model',
      'cl.hide.referencedElsewhere': 'this name is referenced elsewhere (needs human confirmation)',
      'cl.hide.unvalidatedBanner': 'not validated — do not copy this list as-is',
      'cl.hide.denyListLabel': 'paste-ready list ({n} names)',
      'cl.hide.copyDenyList': 'Copy list',
      'cl.hide.copied': 'Copied',
      'cl.hide.copyUnavailable': 'the browser offered no clipboard — select the list below and copy manually',
      'cl.hide.applyModeLabel': 'apply mode',
      'cl.hide.applyMode.suggestionOnly': 'suggestion only: this plugin never applies it by itself (appliedNames is empty)',
      'cl.hide.applyMode.appliedByConfig': 'applied by your own config (from the profile patch, not decided by this plugin)',
      'cl.hide.applyApplied': '{n} names applied',
      'cl.hide.applySkipped': '{n} names not applied (interface missing or name not restrictable)',
      'cl.hide.caveatTitle': 'cost and uncertainty (always shown at the bottom of this section)',
      'cl.hide.caveat.registryHideIsTotal': 'hiding is registry-level: the name becomes invisible and unresolvable in that agent\'s scope — '
        + 'not merely wiped from the schema',
      'cl.hide.caveat.nonModelRegistryCalls': 'non-model registry calls have no observation surface: DSH cannot see them',
      'cl.hide.caveat.serviceCoupling': 'whether a feature is served by an independent service (UI/background bypassing the registry) '
        + 'cannot be decided statically; confirm per unit',
      'cl.hide.caveat.confirmationRequired': 'human confirmation is required before applying; this plugin never confirms on your behalf',
      'cl.hide.caveat.prefixCacheCost': 'any hiding changes the request prefix and invalidates the prompt cache once '
        + '(a one-time cost, not a recurring one)',
      'cl.hide.restoreTitle': 'how to restore (hiding comes from config; this plugin has no undo command)',
      'cl.hide.restoreStep1': '1. in <profile>/cordis.patch.yml, set hide.apply back to false under the `- id: context-ledger` entry; '
        + 'to restore only some tools, drop those names from deny',
      'cl.hide.restoreStep2': '2. reload: with HMR enabled, saving takes effect immediately (the restriction lives on an effect layer '
        + 'and is released on reload); otherwise restart that profile',
      'cl.hide.restoreStep3': '3. already-running agents/subagents are not retroactive (limits apply at creation time); '
        + 'a restart clears them',
      'cl.hide.restoreSubagent': 'subagent carrier: remove toolFilter from the descriptor; new subagents are unrestricted immediately',
      'cl.hide.restoreNoUndo': 'there is no "undo the last hide" command; restoring means editing the config back',
      'cl.hide.restoreReadonly': 'this plugin only prints snippets: it does not create, modify, or back up your config files',
      'cl.hide.parallelTitle': 'both actions side by side (mutually exclusive alternatives)',
      'cl.hide.parallelHint': 'one row per unit: the first line hides that unit\'s tools, the second line uninstalls the unit',
      'cl.hide.unitHideLine': 'hiding these {tools} tools saves {tokens} tokens (cost: those names become registry-level unavailable; '
        + 'human confirmation required)',
      'cl.hide.unitPruneLine': 'uninstalling this unit saves {tokens} tokens (cost: {used} of its tools are in use, '
        + 'plus its UI/background features)',
      'cl.hide.noUninstall': 'cannot be removed by uninstalling',
      'cl.hide.noSum': 'the two actions are mutually exclusive: never add the hide tokens to the uninstall tokens '
        + '(they are not two separate savings)',
      /* ── v4 additions (DESIGN §4.5; 9 keys, same key set as zh) ──────────────────── */
      'cl.windowScope': 'scan window: {scanned} / {available} sessions · {start} → {end} · bounds from session-log mtime ({basis})',
      'cl.windowOmitted': '{n} earlier sessions were not scanned this time',
      'cl.currentSessionCalls': 'this session',
      'cl.sessionCoverage': '{n}/{scanned} sessions covered',
      'cl.currentSessionTotal': 'this session',
      'cl.currentSessionUnknown': 'this session: n/a',
      'cl.currentSessionOutsideWindow': ' (outside the scan window)',
      'cl.presence.currentSession': 'used in this session',
      'cl.presence.historicalOnly': 'not in this session · used in earlier ones',
    }

    /**
     * 把 `{name}` 占位符按参数替换（与宿主 locale 的替换规则一致：未提供的占位符原样保留）。
     * @param {string} text
     * @param {Record<string, unknown>} [params]
     * @returns {string}
     */
    function fillTemplate(text, params) {
      if (params === undefined) return text
      return text.replace(/\{(\w+)\}/g, function (match, name) {
        return params[name] === undefined ? match : String(params[name])
      })
    }

    /**
     * 兜底翻译：只有 locale 座位缺席时才会走到这里（正常装配下 `t` 由宿主的 locale 座位注入）。
     * 它让面板在任何组合下都可渲染，且不改变文案来源（用的仍是上面两份词典）。
     */
    function fallbackT(key, params) {
      var text = en[key]
      if (text === undefined) return key
      return fillTemplate(text, params)
    }

    /**
     * 词典值里的**变体编码**（只为绕开 §4.5 的键集限制而设，语义上仍是冻结文案）。
     *
     * 为什么需要它：§4.7 第 2 条要求同单元在用工具数的**两种措辞**——为 0 时「该单元无在用工具」、
     * 不为 0 时「另有 N 个工具在用」——而 §4.5 的冻结键集只给了 `cl.pruneUsedTools` 一个键。
     * 为**不自行增删冻结键名**，该键的值由 `|` 分隔为若干变体：
     *   变体 0 = 零值形态，变体 1 = 单数形态，变体 2 = 复数形态（只有一个变体时原样返回）。
     * 选谁由调用方按 `usedToolCount` 决定（`usedToolsText()`），词典里保留的是**逐字契约文案**。
     *
     * 这是本实现唯一一处"词典值编码"；已作为 E4/E1 观察上报队长：若 v3 允许把它拆成
     * 2–3 个键（例如 `cl.pruneUsedTools` + `cl.pruneUsedToolsNone`），删掉本函数即可。
     *
     * @param {(key: string, params?: object) => string} t
     * @param {string} key
     * @param {number} index - 变体下标（越界时取最后一个变体）
     * @param {Record<string, unknown>} [params]
     * @returns {string}
     */
    function variantText(t, key, index, params) {
      var raw = t(key)
      if (typeof raw !== 'string') return ''
      var parts = raw.split('|')
      if (parts.length < 2) return fillTemplate(raw, params)
      var bound = isNum(index) ? Math.max(0, Math.floor(index)) : 0
      return fillTemplate(parts[Math.min(bound, parts.length - 1)], params)
    }

    /* ══════════════════════════════════════════════════════════════════════
     * 常量（DESIGN §2.8 / §4）
     * ══════════════════════════════════════════════════════════════════════ */

    /** 宿主同源路由（DESIGN §4.1）：→ { ok: boolean, report: canonical JSON }。 */
    var LEDGER_API = '/api/context-ledger/ledger'

    /**
     * 右侧栏 tab 的**类型身份**（R7 新增的承载位置；DESIGN v3 §4.1 的"data entry"不变）。
     *
     * 契约事实（本机 0.2.0-rc.2 只读核对）：
     *   · `sidebar.right.pane.tab`（kind: keyed / scope: session）与
     *     `sidebar.right.pane.tab.title` 由 **同一个 key** 分派，key = tab 类型定义的 `id`
     *     （`dsh-client-ui-sidebar-right/lib/client.js` 的 `entryKey: definition?.id ?? tab.kind`）；
     *   · 类型本身注册进 `ctx.sidebarRightTabs`（`SidebarRightTabRegistry.register`），
     *     `kind` 是 `ctx.sidebarRight.openTab(kind)` 用的类型判别符；
     *   · `ctx.sidebarRight.openTab` 注释明写"column expands in the same step" ⇒ 点一下即成栏。
     * 先例：@nanmicoder/dsh-agent-teams 与 dsh-context 的客户端半区都按这个形状注册。
     */
    var LEDGER_TAB_ID = 'dsh-context-ledger'
    var LEDGER_TAB_KIND = 'context-ledger'
    /** 右侧栏 tab 的两个座位名（同一个 key = LEDGER_TAB_ID）。 */
    var LEDGER_TAB_SEATS = ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']
    /** 宿主服务名：`sidebarRightTabs` 是可选的注册表，`sidebarRight` 是打开入口。 */
    var SIDEBAR_TABS_SERVICE = 'sidebarRightTabs'
    var SIDEBAR_SERVICE = 'sidebarRight'
    /** 明细展开后仍超出的行数用 cl.more 折叠（DESIGN §4.3）。 */
    var DETAIL_LIMIT = 6
    /** 分类固定顺序（DESIGN §2.3：身份稳定优先于量级）。 */
    var CATEGORY_ORDER = ['instructions', 'skills', 'tools', 'mcp']
    /** usageBasis：日志不可读的降级态（DESIGN §2.4）。 */
    var BASIS_NO_EVIDENCE = 'no-evidence'
    /** 失败码进入面板前截断，保证面板不承载任意宿主串。 */
    var ERROR_MAX = 64

    /** 主题：全部沿宿主 CSS 变量，不硬编码配色（DESIGN §4.1）。 */
    var TONE = {
      canvas: 'var(--dsw-alias-bg-layer-1, #161b24)',
      raised: 'var(--dsw-alias-bg-layer-2, #1d2430)',
      sunk: 'var(--dsw-alias-bg-layer-3, #252d3b)',
      border: 'var(--dsw-alias-border-l2, rgba(196, 211, 232, 0.16))',
      borderStrong: 'var(--dsw-alias-border-l3, rgba(196, 211, 232, 0.3))',
      text: 'var(--dsw-alias-label-primary, #e9edf4)',
      muted: 'var(--dsw-alias-label-secondary, #9ba5b5)',
      quiet: 'var(--dsw-alias-label-tertiary, #707a8b)',
      blue: 'var(--dsw-alias-brand-primary, #7c9bff)',
      amber: 'var(--dsw-alias-state-warn-primary, #e0a83a)',
      red: 'var(--dsw-alias-state-error-primary, #ef6a7d)',
      green: 'var(--dsw-alias-state-success-primary, #4fc281)',
      /* skills 的标识色：宿主 CSS 变量集里没有对应别名，沿用参照实现的紫（仅作分类标识，不承载结论）。 */
      violet: '#a488ea',
    }

    /** 分类标识色（沿宿主 CSS 变量；只用于圆点/占比条，不承载结论）。 */
    var CATEGORY_TONE = {
      instructions: TONE.blue,
      skills: TONE.violet,
      tools: TONE.amber,
      mcp: TONE.green,
    }

    /** 仅数字用等宽；正文继承宿主 UI 字体（含 CJK 回退），避免中文落到无 CJK 的等宽栈。 */
    var MONO = 'ui-monospace, "SFMono-Regular", "Cascadia Mono", Consolas, monospace'

    /**
     * 字号与行高：**对齐宿主 `--dsw-font-*` token 阶梯**，不写裸 px（硬编码不会跟随主题/字号缩放）。
     * 依据：`IMPLEMENTATION-NOTES.md` 的「界面决定备案 · 面板字号对齐 DSH `--dsw-font-*` 阶梯」（R8 / t1）。
     *
     * 映射（现状 px → token 档）：9.5 / 10 → `xxxs-11`；**10.5 / 11 → `xxs-12`（主力）**；
     * 11.5 / 12 → `xs-13`；13 → `s-14`；20（总览数字）保持 `l-20`。
     * 行高**同步**取同一档的 `-line-height`（字号变大后不得挤字）。
     */
    var FS = {
      xxxs11: 'var(--dsw-font-xxxs-11-font-size, 11px)',
      xxs12: 'var(--dsw-font-xxs-12-font-size, 12px)',
      xs13: 'var(--dsw-font-xs-13-font-size, 13px)',
      s14: 'var(--dsw-font-s-14-font-size, 14px)',
      l20: 'var(--dsw-font-l-20-font-size, 20px)',
    }
    var LH = {
      xxxs11: 'var(--dsw-font-xxxs-11-line-height, 14px)',
      xxs12: 'var(--dsw-font-xxs-12-line-height, 18px)',
      xs13: 'var(--dsw-font-xs-13-line-height, 20px)',
      s14: 'var(--dsw-font-s-14-line-height, 22px)',
    }

    /* ══════════════════════════════════════════════════════════════════════
     * 纯展示映射（无副作用；`__verify` 缝直接暴露给核验线逐条断言）
     * ══════════════════════════════════════════════════════════════════════ */

    /** 有限数字判定（canonical JSON 里 token / 次数都是有限整数）。 */
    function isNum(value) {
      return typeof value === 'number' && Number.isFinite(value)
    }

    /** 整数千分位；非有限值返回空串，由调用方渲染成「未知」，绝不回落成 0。 */
    function formatInt(value) {
      if (!isNum(value)) return ''
      return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    /**
     * 条目状态三分（DESIGN §4.4；硬规则：`calls === null` 绝不是零调用）：
     *   'zero'        zeroCall === true（有证据的零调用；兜底接受 calls === 0）
     *   'no-evidence' calls === null 且 usageBasis === 'no-evidence'（日志不可读的降级态）
     *   'unknown'     calls === null 的其它情况（unobservable / always-on）
     *   'used'        calls > 0
     * @param {object} item
     * @returns {'zero'|'no-evidence'|'unknown'|'used'}
     */
    function itemState(item) {
      if (item === null || typeof item !== 'object') return 'unknown'
      if (item.zeroCall === true || item.calls === 0) return 'zero'
      if (item.calls === null || item.calls === undefined) {
        return item.usageBasis === BASIS_NO_EVIDENCE ? 'no-evidence' : 'unknown'
      }
      return 'used'
    }

    /** 三种状态的颜色：零调用=琥珀，未知=中性灰，无证据=红（DESIGN §4.4 视觉硬区分）。 */
    var STATE_TONE = {
      zero: TONE.amber,
      unknown: TONE.quiet,
      'no-evidence': TONE.red,
      used: TONE.muted,
    }

    /** 状态 → 颜色（核验线用它证明三种状态视觉可区分）。 */
    function chipColor(state) {
      var tone = STATE_TONE[state]
      return tone === undefined ? TONE.muted : tone
    }

    /** 占比条：唯一允许的面板派生量（DESIGN §5），除零保护。 */
    function shareOf(tokens, total) {
      if (!isNum(tokens) || !isNum(total) || total <= 0) return null
      return Math.max(0, Math.min(1, tokens / total))
    }

    /** 分类行的机制级指标（仅 skills：mechanismCalls / mechanismTokensPerCall）。 */
    function mechanismOf(category) {
      if (category === null || typeof category !== 'object') return null
      if (!isNum(category.mechanismCalls)) return null
      return {
        calls: category.mechanismCalls,
        each: isNum(category.mechanismTokensPerCall) ? category.mechanismTokensPerCall : null,
      }
    }

    /**
     * 四类明细行：**固定顺序** instructions → skills → tools → mcp（DESIGN §4.3）。
     * 分类对象缺失时补一条零值行，保证版面恒为 4 行。
     */
    function categoryRows(report) {
      var categories = report !== null && typeof report === 'object' && Array.isArray(report.categories)
        ? report.categories
        : []
      var byKey = {}
      for (var i = 0; i < categories.length; i++) {
        var category = categories[i]
        if (category !== null && typeof category === 'object' && typeof category.key === 'string') {
          byKey[category.key] = category
        }
      }
      var totals = report !== null && typeof report === 'object' ? report.totals : null
      var resident = totals !== null && typeof totals === 'object' ? totals.residentTokens : 0
      return CATEGORY_ORDER.map(function (key) {
        var found = byKey[key]
        var tokens = found !== undefined && isNum(found.tokens) ? found.tokens : 0
        return {
          key: key,
          itemCount: found !== undefined && isNum(found.itemCount) ? found.itemCount : 0,
          tokens: tokens,
          share: shareOf(tokens, resident),
          observableUsage: found !== undefined && found.observableUsage === true,
          mechanism: found === undefined ? null : mechanismOf(found),
        }
      })
    }

    /** 某一类的条目行：**保持 canonical `items` 相对顺序**，不重排（DESIGN §4.3 硬要求）。 */
    function itemsOfCategory(report, key) {
      var items = report !== null && typeof report === 'object' && Array.isArray(report.items) ? report.items : []
      return items.filter(function (item) {
        return item !== null && typeof item === 'object' && item.category === key
      })
    }

    /**
     * 明细折叠（DESIGN §4.3）：展开后**最多**渲染 DETAIL_LIMIT 行，其余折成 `cl.more` 计数。
     * 与参照实现 context-doctor 的 DETAIL_LIMIT 同量级（硬上限，避免浮层过长）。
     */
    function foldRows(rows, limit) {
      var bound = isNum(limit) ? limit : DETAIL_LIMIT
      if (rows.length <= bound) return { shown: rows, hidden: 0 }
      return { shown: rows.slice(0, bound), hidden: rows.length - bound }
    }

    /** 指令链展示名：取路径尾段（父目录/文件名），完整路径进 title（DESIGN §4.2.4）。 */
    function shortPath(path) {
      if (typeof path !== 'string' || path === '') return ''
      var parts = path.split(/[/\\]/).filter(Boolean)
      if (parts.length === 0) return path
      var last = parts[parts.length - 1]
      var parent = parts.length >= 2 ? parts[parts.length - 2] : undefined
      return parent === undefined ? last : parent + '/' + last
    }

    /** ISO-8601 UTC → 本地 `MM-DD HH:mm`（DESIGN §5：面板按本地时区渲染）。 */
    function shortStamp(iso) {
      if (typeof iso !== 'string' || iso === '') return ''
      var date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      function pad(n) { return n < 10 ? '0' + n : String(n) }
      return pad(date.getMonth() + 1) + '-' + pad(date.getDate())
        + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    /** 本地 `HH:mm:ss`，用于「更新于 …」。 */
    function clockStamp(ms) {
      if (!isNum(ms)) return ''
      var date = new Date(ms)
      function pad(n) { return n < 10 ? '0' + n : String(n) }
      return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
    }

    /**
     * 对账总览三个数字（DESIGN §4.2.2）。
     *
     * 降级态保护（把 §4.4「calls === null 不渲染成 0」推广到总计）：`usageAvailable === false`
     * 时 `totals.observedCalls = 0` 不是「测到 0 次」而是「没有证据」，因此渲染成 `cl.unknown`。
     * `unknown: true` 让组件知道该格没有可用数字（顺带决定是否显示单位）。
     */
    function overview(report, t) {
      var scope = report !== null && typeof report === 'object' && report.scope !== null
        && typeof report.scope === 'object' ? report.scope : {}
      var totals = report !== null && typeof report === 'object' && report.totals !== null
        && typeof report.totals === 'object' ? report.totals : {}
      var available = scope.usageAvailable === true
      var unknown = t('cl.unknown')

      var sessions = t('cl.sessionsCovered', {
        scanned: formatInt(isNum(scope.sessionsScanned) ? scope.sessionsScanned : 0),
        available: formatInt(isNum(scope.sessionsAvailable) ? scope.sessionsAvailable : 0),
      })
      var start = shortStamp(scope.windowStart)
      var end = shortStamp(scope.windowEnd)

      return [
        {
          key: 'resident',
          label: t('cl.residentTotal'),
          value: formatInt(isNum(totals.residentTokens) ? totals.residentTokens : 0),
          unknown: false,
          unit: t('cl.tokens'),
          sub: null,
        },
        {
          key: 'calls',
          label: t('cl.observedCalls'),
          value: available ? formatInt(isNum(totals.observedCalls) ? totals.observedCalls : 0) : unknown,
          unknown: !available,
          unit: null,
          sub: start !== '' && end !== ''
            ? sessions + ' · ' + t('cl.window', { start: start, end: end })
            : sessions,
        },
        {
          key: 'perUse',
          label: t('cl.tokensPerCall'),
          value: available && isNum(totals.observableTokensPerCall)
            ? formatInt(totals.observableTokensPerCall)
            : unknown,
          unknown: !available || !isNum(totals.observableTokensPerCall),
          unit: t('cl.tokens'),
          sub: t('cl.tokens') + ' ' + formatInt(isNum(totals.observableTokens) ? totals.observableTokens : 0),
        },
      ]
    }

    /** 页脚证据行（DESIGN §4.2.5）：范围与证据，全是数据字段，不是结论。 */
    function evidence(report) {
      var scope = report !== null && typeof report === 'object' && report.scope !== null
        && typeof report.scope === 'object' ? report.scope : {}
      return {
        workspaceKey: typeof scope.workspaceKey === 'string' ? scope.workspaceKey : '',
        sessionsScanned: isNum(scope.sessionsScanned) ? scope.sessionsScanned : 0,
        sessionsAvailable: isNum(scope.sessionsAvailable) ? scope.sessionsAvailable : 0,
        truncated: scope.truncated === true,
        namesRejected: isNum(scope.namesRejected) ? scope.namesRejected : 0,
      }
    }

    /** findings 清单（DESIGN §4.3：直接消费宿主已排好的顺序，不重排）。 */
    function findingRows(report, key) {
      var findings = report !== null && typeof report === 'object' && report.findings !== null
        && typeof report.findings === 'object' ? report.findings : {}
      var rows = findings[key]
      return Array.isArray(rows) ? rows : []
    }

    /* ══════════════════════════════════════════════════════════════════════
     * R8/v4 展示映射（DESIGN §2.26 / §4.2 / §4.4 / §4.9；纯函数，零重算）
     *
     * 三条硬规则（与 §2.26.1 同源，面板侧一条都不能破）：
     *   ① **窗口总调用** `/ items[].calls`、**本会话** `currentSessionCalls`、**覆盖会话数**
     *      `sessionsWithCalls` 是三个互不可加的口径：各自独立成节点、各自有标签，
     *      面板**不**把它们相加/相减/相乘，也**不**由此派生"平均每次会话调用"之类的结论；
     *   ② `null`（给不出）**绝不**渲染成 `0`——渲染成"不可判定"并给出原因（`calls === null`
     *      的既有规则同样成立：那是"未知/无证据"，不是零调用）；
     *   ③ 三态徽标视觉可区分：只有 `absent` 用零调用（琥珀）样式，另两态用中性/品牌色。
     * ══════════════════════════════════════════════════════════════════════ */

    /** 三态取值域（§2.26.2）：恰好 3 个 + null；其它取值一律按"给不出"处理，不猜。 */
    var PRESENCE_VALUES = ['current-session', 'historical-only', 'absent']

    /** 三态 → 颜色（核验线用它证明三态视觉可区分；`historical-only` 绝不能是琥珀）。 */
    var PRESENCE_TONE = {
      'current-session': TONE.blue,
      'historical-only': TONE.muted,
      absent: TONE.amber,
    }

    /** 三态 → 颜色（未知/不可判定取中性灰）。 */
    function presenceColor(presence) {
      var tone = PRESENCE_TONE[presence]
      return tone === undefined ? TONE.quiet : tone
    }

    /** 逐项三态：**只读** canonical 的 `callPresence`，绝不按 `calls` 反推（§2.26.4 I1）。 */
    function presenceOf(item) {
      if (item === null || typeof item !== 'object') return null
      return PRESENCE_VALUES.indexOf(item.callPresence) === -1 ? null : item.callPresence
    }

    /** 窗口边界与口径（§2.2 W1–W6）：只读 `scope`，窗口外一律不探测、不算任何派生量。 */
    function windowScopeOf(report) {
      var scope = report !== null && typeof report === 'object' && report.scope !== null
        && typeof report.scope === 'object' ? report.scope : {}
      var start = shortStamp(scope.windowStart)
      var end = shortStamp(scope.windowEnd)
      return {
        scanned: isNum(scope.sessionsScanned) ? scope.sessionsScanned : 0,
        available: isNum(scope.sessionsAvailable) ? scope.sessionsAvailable : 0,
        outside: isNum(scope.sessionsOutsideWindow) ? scope.sessionsOutsideWindow : 0,
        start: start,
        end: end,
        /* W6：常量 `session-log-mtime`；只在宿主真的给了字符串时呈现，不自己编一个。 */
        basis: typeof scope.windowBasis === 'string' && scope.windowBasis !== '' ? scope.windowBasis : '',
      }
    }

    /** `scope.currentSession`（§2.2）：`basis` 取不到就如实按 `unavailable` 处理（不猜 id）。 */
    function currentSessionOf(report) {
      var scope = report !== null && typeof report === 'object' && report.scope !== null
        && typeof report.scope === 'object' ? report.scope : {}
      var current = scope.currentSession !== null && typeof scope.currentSession === 'object'
        ? scope.currentSession : null
      /* `basis` 是 §2.2 冻结的三个枚举值之一；形状护栏确保面板**不承载任意宿主串**
       * （不匹配就按契约里的"取不到"取值 `unavailable` 处理）。 */
      var raw = current !== null && typeof current.basis === 'string' ? current.basis : ''
      var basis = /^[a-z][a-z0-9-]{0,31}$/.test(raw) ? raw : 'unavailable'
      return {
        basis: basis,
        /* 缺字段按 false：拿不到"在窗口内"的证据，就不能假装在窗口内。 */
        inWindow: current !== null && current.inWindow === true,
      }
    }

    /** 渲染期上下文（v4）：覆盖会话数的分母 + 本会话是否在窗口内。 */
    function panelScope(report) {
      return { window: windowScopeOf(report), current: currentSessionOf(report) }
    }

    /**
     * 总览里的「本会话调用」（§4.2 第 2 段 ② / §4.9 第 3、4 条）。
     * `totals.currentSessionObservedCalls === null` ⇒ "不可判定"（**绝不** 0）；
     * `inWindow === false` ⇒ 必须给出原因文案（`cl.currentSessionOutsideWindow`）。
     * `basis` 只作为标识来源呈现，绝不把 `id` 当标题/用户名（§2.26.5 第 6 条）。
     */
    function currentSessionSummary(report, t) {
      var totals = report !== null && typeof report === 'object' && report.totals !== null
        && typeof report.totals === 'object' ? report.totals : {}
      var current = currentSessionOf(report)
      var known = isNum(totals.currentSessionObservedCalls)
      return {
        label: t('cl.currentSessionTotal'),
        value: known ? formatInt(totals.currentSessionObservedCalls) : t('cl.currentSessionUnknown'),
        unknown: !known,
        basis: current.basis,
        inWindow: current.inWindow,
        reason: current.inWindow ? null : t('cl.currentSessionOutsideWindow'),
      }
    }

    /**
     * 三态徽标（§4.4 的 v4 三行 / §4.9 第 5 条）：
     *   `current-session` → 品牌色（中性偏正向，**不**用琥珀告警样式）；
     *   `historical-only` → 中性灰（**绝不**用零调用样式，否则会被读成"零调用"）；
     *   `absent`          → **不**另画徽标：该行的次数格已经是零调用徽标（`cl.neverCalled`），
     *                       同一行里出现两个琥珀「0 次」正是 §4.4 v4 硬规则③禁止的；
     *   `null`            → 不画徽标（由「不可判定」文案承担）。
     */
    function presenceBadge(presence, t) {
      if (presence === 'current-session') {
        return h('span', {
          key: 'presence', 'data-cl-presence': 'current-session', style: presenceCurrentStyle,
        }, t('cl.presence.currentSession'))
      }
      if (presence === 'historical-only') {
        return h('span', {
          key: 'presence', 'data-cl-presence': 'historical-only', style: presenceNeutralStyle,
        }, t('cl.presence.historicalOnly'))
      }
      return null
    }

    /**
     * 逐项 v4 行（§4.2 第 4 段 / §4.9 第 1、3、5 条）：三态徽标 + 本会话数 + 覆盖会话数。
     *
     * 只有**次数可观测**的项才有这一行（`calls !== null`）：`instructions` / `skills` 没有"调用"
     * 这个动作（§2.4 赋值优先级），给它们编一个本会话数就是造假——这是本文件"绝不把未知写成已知"
     * 的既有规则，不是省略。
     *
     * @param {object} item
     * @param {(key: string, params?: object) => string} t
     * @param {{window: object, current: object}|null} scope - `panelScope()` 的结果
     */
    function presenceLine(item, t, scope) {
      if (item === null || typeof item !== 'object') return null
      if (!isNum(item.calls)) return null
      if (item.category !== 'tools' && item.category !== 'mcp') return null
      var context = scope !== null && typeof scope === 'object' ? scope : null
      var win = context !== null && context.window !== null && typeof context.window === 'object'
        ? context.window : null
      var inWindow = context !== null && context.current !== null && typeof context.current === 'object'
        ? context.current.inWindow === true : false
      var scanned = win !== null && isNum(win.scanned) ? formatInt(win.scanned) : t('cl.unknown')
      var sessionFigure
      if (isNum(item.currentSessionCalls)) {
        /* 窗口总调用与本会话调用**并列**呈现，各自带标签，不做任何加减。 */
        sessionFigure = t('cl.currentSessionCalls') + ' ' + formatInt(item.currentSessionCalls)
      } else {
        /* 给不出就写"不可判定"（**绝不** 0），inWindow === false 时给出原因。 */
        sessionFigure = t('cl.currentSessionUnknown')
          + (inWindow ? '' : t('cl.currentSessionOutsideWindow'))
      }
      var coverage = isNum(item.sessionsWithCalls)
        ? t('cl.sessionCoverage', { n: formatInt(item.sessionsWithCalls), scanned: scanned })
        : t('cl.unknown')
      return h('div', { key: 'v4', 'data-cl-presence-line': '', style: presenceLineStyle }, [
        presenceBadge(presenceOf(item), t),
        h('span', {
          key: 'current',
          'data-cl-current-session': isNum(item.currentSessionCalls)
            ? formatInt(item.currentSessionCalls) : 'unavailable',
          style: isNum(item.currentSessionCalls) ? presenceFigureStyle : presenceUnknownStyle,
        }, sessionFigure),
        h('span', {
          key: 'coverage',
          'data-cl-coverage': isNum(item.sessionsWithCalls) ? formatInt(item.sessionsWithCalls) : 'unavailable',
          style: isNum(item.sessionsWithCalls) ? presenceFigureStyle : presenceUnknownStyle,
        }, coverage),
      ])
    }

    /**
     * 清单行 → canonical 条目（§5：面板不重算，只做展示映射）。
     *
     * `findings.zeroCall` / `findings.topPerUse` 的记录只有 `id` / `category` / `name` / `tokens`；
     * v4 的三个数**只能**来自 `items[]`，所以按 `id` 取回 canonical 条目原样渲染。
     * 取不到时**不猜任何新数字**：只回落到不含 v4 字段的最小形状——面板会把"本会话"如实
     * 呈现为不可判定，而不是 0（`null` 与 `0` 是两个事实，§2.26.4 I3）。
     */
    function findingSource(itemById, entry, zeroCall) {
      if (entry === null || typeof entry !== 'object') return entry
      var index = itemById === null || typeof itemById !== 'object' ? {} : itemById
      var source = index[entry.id]
      if (source !== null && typeof source === 'object') return source
      return {
        id: entry.id,
        category: entry.category,
        name: entry.name,
        tokens: entry.tokens,
        calls: zeroCall === true ? 0 : entry.calls,
        tokensPerCall: zeroCall === true ? null : entry.tokensPerCall,
        zeroCall: zeroCall === true,
        usageBasis: 'tool-calls',
      }
    }

    /**
     * 窗口声明行（§4.9 第 2 条）：总览段与零调用段**都**常驻，不得折叠、不得收进 tooltip。
     * 它同时是 `findings.zeroCallBasis` 的人类可读对应物，并与 `windowBasis` 一起呈现（§5 v4 第 4 条）。
     *
     * @param {object} report
     * @param {(key: string, params?: object) => string} t
     * @param {'overview'|'block'} where - 承载位置（只影响外边距，不影响内容）
     * @returns {Array<object>} 1–2 个节点（`sessionsOutsideWindow > 0` 时追加一行）
     */
    function windowScopeNodes(report, t, where) {
      var win = windowScopeOf(report)
      var inBlock = where === 'block'
      var marker = inBlock ? 'zero-call' : 'overview'
      var nodes = [
        h('p', {
          key: 'window-scope:' + marker,
          'data-cl-window-scope': marker,
          style: inBlock ? windowScopeNoteStyle : windowScopeStyle,
        }, t('cl.windowScope', {
          scanned: formatInt(win.scanned),
          available: formatInt(win.available),
          start: win.start === '' ? t('cl.unknown') : win.start,
          end: win.end === '' ? t('cl.unknown') : win.end,
          basis: win.basis === '' ? t('cl.unknown') : win.basis,
        })),
      ]
      if (win.outside > 0) {
        nodes.push(h('p', {
          key: 'window-omitted:' + marker,
          'data-cl-window-omitted': marker,
          style: inBlock ? windowOmittedNoteStyle : windowOmittedStyle,
        }, t('cl.windowOmitted', { n: formatInt(win.outside) })))
      }
      return nodes
    }

    /** 总览里的「本会话调用」节点（§4.2 第 2 段 ②）：值 + 原因 + 标识来源，绝不显示 id 本身。 */
    function currentSessionNode(summary) {
      return h('div', {
        key: 'current-session',
        'data-cl-current-session-summary': '',
        style: currentSessionStyle,
      }, [
        h('span', { key: 'label', style: currentSessionLabelStyle }, summary.label),
        h('span', {
          key: 'value',
          'data-cl-current-session-total': summary.unknown ? 'unavailable' : 'value',
          style: summary.unknown ? currentSessionQuietStyle : currentSessionValueStyle,
        }, summary.value),
        summary.reason === null ? null : h('span', {
          key: 'reason', 'data-cl-current-session-reason': '', style: currentSessionQuietStyle,
        }, summary.reason),
        h('span', {
          key: 'basis',
          'data-cl-current-session-basis': summary.basis,
          style: currentSessionQuietStyle,
        }, 'basis: ' + summary.basis),
      ])
    }

    /* ══════════════════════════════════════════════════════════════════════
     * R1/R2 展示映射（DESIGN §4.7 的呈现义务；纯函数，零重算）
     *
     * 面板**不重算归属、不重算省额、不筛选/不重排 prunePlan**（§5 v2）：
     * 这里只把 canonical JSON 的字段映射成文案与元素，判断全部由宿主半区给出。
     * ══════════════════════════════════════════════════════════════════════ */

    /** 展开里"行内代表工具名"的条数（§4.7 第 2 条要求行内至少给出若干名字；D6 取 3）。 */
    var PRUNE_REPRESENTATIVE_NAMES = 3

    /** id → `items[]` 项。只为取 `providedBy`（§4.7 第 7 条），不做任何重算。 */
    function itemIndex(report) {
      var items = report !== null && typeof report === 'object' && Array.isArray(report.items)
        ? report.items : []
      var map = {}
      for (var i = 0; i < items.length; i++) {
        var item = items[i]
        if (item !== null && typeof item === 'object' && typeof item.id === 'string') map[item.id] = item
      }
      return map
    }

    /** 一条呈现义务所需的五件事实之一：单元种类（§4.7 第 2 条）。 */
    function pruneUnitText(entry, t) {
      return entry !== null && typeof entry === 'object' && entry.kind === 'mcp-server'
        ? t('cl.pruneUnitMcpServer')
        : t('cl.pruneUnitPlugin')
    }

    /** 五件事实之二：工具数 + 行内代表工具名（§4.7 第 2 条）。 */
    function pruneNamesText(entry, t) {
      var items = entry !== null && typeof entry === 'object' && Array.isArray(entry.items) ? entry.items : []
      var count = entry !== null && typeof entry === 'object' && isNum(entry.itemCount) ? entry.itemCount : items.length
      var names = []
      for (var i = 0; i < items.length && i < PRUNE_REPRESENTATIVE_NAMES; i++) {
        if (items[i] !== null && typeof items[i] === 'object') names.push(String(items[i].name))
      }
      var text = names.join(', ')
      if (items.length > PRUNE_REPRESENTATIVE_NAMES) text += ' …'
      return t('cl.pruneToolsCount', { n: formatInt(count), names: text })
    }

    /** 五件事实之三：可省 token，**必须**带「若未使用」条件语（§4.7 第 2 条）。 */
    function pruneReclaimText(entry, t) {
      var tokens = entry !== null && typeof entry === 'object' && isNum(entry.reclaimableTokens)
        ? entry.reclaimableTokens : 0
      return t('cl.pruneReclaimableTokens', { tokens: formatInt(tokens) })
    }

    /** 五件事实之四：同单元在用工具数（§4.7 第 2 条：为 0 也要显示，不省略）。 */
    function usedToolsText(entry, t) {
      var used = entry !== null && typeof entry === 'object' && isNum(entry.usedToolCount) ? entry.usedToolCount : 0
      var variant = used === 0 ? 0 : (used === 1 ? 1 : 2)
      return variantText(t, 'cl.pruneUsedTools', variant, { n: formatInt(used) })
    }

    /** 五件事实之五：事实包名（§4.7 第 2 条；`mcp-server` 按契约恒为 `[]`，显示中性占位符）。 */
    function pruneFactText(entry, t) {
      var packages = entry !== null && typeof entry === 'object' && Array.isArray(entry.factPackages)
        ? entry.factPackages : []
      return t('cl.pruneFactPackages', { packages: packages.length === 0 ? '—' : packages.join(', ') })
    }

    /** 裁剪候选（§4.3：顺序恒为宿主给的 `reclaimableTokens` 降序，面板不重排、不过滤）。 */
    function pruneEntries(report) {
      return findingRows(report, 'prunePlan').filter(function (entry) {
        return entry !== null && typeof entry === 'object'
      })
    }

    /** 低置信标记（§4.7 第 4 条：单元行与明细行都要带「推断」标记）。 */
    function isLowConfidence(value) {
      return value !== null && typeof value === 'object' && value.confidence === 'low'
    }

    /** 归属徽标文案（§4.2.4 / §4.4）：`unknown` 只显示「归属未知」，绝不显示成「DSH 自带」。 */
    function attributionText(providedBy, t) {
      if (providedBy === null || typeof providedBy !== 'object') return null
      var label
      if (providedBy.kind === 'plugin') label = t('cl.providedBy.plugin', { name: String(providedBy.name) })
      else if (providedBy.kind === 'core') label = t('cl.providedBy.core')
      else if (providedBy.kind === 'mcp-server') label = t('cl.providedBy.mcp-server', { name: String(providedBy.name) })
      else label = t('cl.providedBy.unknown')
      /* §4.4：`kind === "unknown"` 或 `confidence === "low"` 用中性灰 + 问号，不使用确定语气。 */
      return providedBy.kind === 'unknown' || providedBy.confidence === 'low' ? label + ' ?' : label
    }

    /** 证据路径文案（§4.7 第 7 条：只呈现路径文本，面板不读该文件）。 */
    function evidenceText(providedBy, t) {
      if (providedBy === null || typeof providedBy !== 'object') return null
      if (typeof providedBy.evidenceFile !== 'string' || providedBy.evidenceFile === '') return null
      return t('cl.providedBy.evidence', { path: providedBy.evidenceFile })
    }

    /**
     * 明细行下的归属补充行（§4.7 第 7 条）：
     * 有 `evidenceFile` → 路径文本；`confidence === "low"` → 必须同时给「推断，可能存在误判」。
     * @returns {Array<{key: string, text: string, tone: string}>} 空数组表示没有可呈现的补充
     */
    function attributionNotes(providedBy, t) {
      var notes = []
      if (providedBy === null || typeof providedBy !== 'object') return notes
      var evidence = evidenceText(providedBy, t)
      if (evidence !== null) notes.push({ key: 'evidence', text: evidence, tone: 'quiet' })
      if (providedBy.confidence === 'low') {
        notes.push({ key: 'low', text: t('cl.pruneConfidenceLow'), tone: 'warn' })
      }
      return notes
    }

    /**
     * 「无法给出动作」分节的行（§4.7 第 4 条）：只放宿主给出的 `noRecommendation`，
     * 保持宿主顺序（§2.16 固定 3 条、按 reason 升序），并按 §2.16 过滤两个计数都为 0 的条目。
     */
    function noRecommendationRows(report, t) {
      return findingRows(report, 'noRecommendation')
        .filter(function (row) {
          if (row === null || typeof row !== 'object' || typeof row.reason !== 'string') return false
          var items = isNum(row.items) ? row.items : 0
          var tokens = isNum(row.tokens) ? row.tokens : 0
          return items > 0 || tokens > 0
        })
        .map(function (row) {
          return {
            reason: row.reason,
            items: isNum(row.items) ? row.items : 0,
            tokens: isNum(row.tokens) ? row.tokens : 0,
            text: t('cl.reason.' + row.reason, {
              items: formatInt(isNum(row.items) ? row.items : 0),
              tokens: formatInt(isNum(row.tokens) ? row.tokens : 0),
            }),
          }
        })
    }

    /** 归属扫描是否触达上限（§4.7 第 6 条：页脚必须提示）。 */
    function providerScanCapped(report) {
      var scope = report !== null && typeof report === 'object' && report.scope !== null
        && typeof report.scope === 'object' ? report.scope : {}
      var scan = scope.providerScan
      return scan !== null && typeof scan === 'object' && scan.capped === true
    }

    /* ══════════════════════════════════════════════════════════════════════
     * R6 展示映射（DESIGN v3 §4.8 的呈现义务；纯函数，零重算）
     *
     * 与 R1 同一纪律（§5 v2 / §2.22）：面板**不重算**任何判定——
     *   · 不重算 hidePlan（候选、排序、token 都由宿主给出）；
     *   · 不把 hidePlan 的 token 与 prunePlan 的 token 相加（§3.7 / §6 第 11 条硬规则）；
     *   · registryUse 只做"人话解释"，不给出比 verdict 更强的结论。
     * ══════════════════════════════════════════════════════════════════════ */

    /** `hidePlanCaveat` 的五个字段（顺序冻结，与 §2.19 的表一致）。 */
    var HIDE_CAVEAT_KEYS = ['registryHideIsTotal', 'nonModelRegistryCalls', 'serviceCoupling',
      'confirmationRequired', 'prefixCacheCost']
    /** `precheck.reason` 的四个枚举（§2.20）。 */
    var HIDE_REASONS = ['not-in-restrictable-names', 'no-agent-scope', 'interface-absent', 'reserved-name']
    /** 三种 precheck 状态（§2.20）。 */
    var HIDE_PRECHECK_STATUSES = ['prechecked', 'unvalidated', 'unsupported']
    /** `hideApply.mode` 的两个枚举（§2.23.4）。 */
    var HIDE_APPLY_MODES = ['suggestion-only', 'applied-by-config']

    /** `findings.hidePlan`（§2.18）：**保持宿主顺序**，不筛选、不重排。 */
    function hideEntries(report) {
      return findingRows(report, 'hidePlan').filter(function (entry) {
        return entry !== null && typeof entry === 'object'
      })
    }

    /** `findings.hidePlanUnits`（§2.18）：单元级汇总，同样保持宿主顺序。 */
    function hideUnits(report) {
      return findingRows(report, 'hidePlanUnits').filter(function (unit) {
        return unit !== null && typeof unit === 'object'
      })
    }

    /** `findings.hideApply` 或 null（旧形状报告）。 */
    function hideApplyOf(report) {
      var findings = report !== null && typeof report === 'object' && report.findings !== null
        && typeof report.findings === 'object' ? report.findings : {}
      var apply = findings.hideApply
      return apply !== null && typeof apply === 'object' ? apply : null
    }

    /**
     * `findings.hidePlanStatus`（§2.20）。缺字段（旧形状报告）时按**最保守**处理：
     * 记 `unvalidated` ⇒ 显示"未校验"提示条且不给复制按钮，绝不当成已校验。
     */
    function hideStatusOf(report) {
      var findings = report !== null && typeof report === 'object' && report.findings !== null
        && typeof report.findings === 'object' ? report.findings : {}
      var status = findings.hidePlanStatus
      return HIDE_PRECHECK_STATUSES.indexOf(status) === -1 ? 'unvalidated' : status
    }

    /** 五条代价/不确定性（§4.8 第 3 条）：文本来自冻结词典，逐条常驻，与 JSON 五个键一一对应。 */
    function hideCaveats(t) {
      return HIDE_CAVEAT_KEYS.map(function (key) {
        return { key: key, text: t('cl.hide.caveat.' + key) }
      })
    }

    /** 单元种类文案：复用 v2 冻结的同义键（4 值域与 providedBy.kind 一致，§2.18）。 */
    function unitKindText(unit, t) {
      var kind = unit !== null && typeof unit === 'object' ? unit.kind : null
      if (kind === 'plugin') return t('cl.pruneUnitPlugin')
      if (kind === 'mcp-server') return t('cl.pruneUnitMcpServer')
      if (kind === 'core') return t('cl.providedBy.core')
      return t('cl.providedBy.unknown')
    }

    /** 单元标签：种类 + （有则）单元名 target。 */
    function unitLabelText(unit, t) {
      var kind = unitKindText(unit, t)
      var target = unit !== null && typeof unit === 'object' && typeof unit.target === 'string'
        ? unit.target : null
      return target === null ? kind : kind + ' · ' + target
    }

    /** 事实包名（复用 v2 的 cl.pruneFactPackages：语义与 §2.13 的 factPackages 相同）。 */
    function unitFactText(unit, t) {
      var packages = unit !== null && typeof unit === 'object' && Array.isArray(unit.factPackages)
        ? unit.factPackages : []
      return t('cl.pruneFactPackages', { packages: packages.length === 0 ? '—' : packages.join(', ') })
    }

    /** `registryUse.verdict` 的标签（枚举只留两个语义占位，§2.19 硬规则 1）。 */
    function verdictLabel(verdict, t) {
      return verdict === 'model-observed' ? t('cl.hide.verdict.modelObserved') : t('cl.hide.verdict.unconfirmed')
    }

    /**
     * `registryUse` 的人话解释（§4.8 第 2 条 + §2.19 硬规则 2）：
     * 必须同时给出 verdict 与 verdictBasis（"DSH 没有该观测面"），否则"没查到"会被读成"不存在"。
     * `nameReferencedElsewhere` 只作为证据列出，**不**改写成"被调用过"。
     */
    function registryUseText(registryUse, t) {
      var verdict = registryUse !== null && typeof registryUse === 'object' ? registryUse.verdict : null
      return verdictLabel(verdict, t) + ' · ' + t('cl.hide.registryUseBasis')
    }

    /** `precheck` 的人话（§4.8 第 2 条）：状态 + （有则）不能限制的原因。 */
    function precheckText(precheck, t) {
      var status = precheck !== null && typeof precheck === 'object'
        && HIDE_PRECHECK_STATUSES.indexOf(precheck.status) !== -1 ? precheck.status : 'unvalidated'
      var text = t('cl.hide.precheck.' + status)
      if (status === 'prechecked' && precheck !== null && typeof precheck === 'object'
        && precheck.restrictable === false && HIDE_REASONS.indexOf(precheck.reason) !== -1) {
        text += ' · ' + t('cl.hide.reason.' + precheck.reason)
      }
      if (status !== 'prechecked' && precheck !== null && typeof precheck === 'object'
        && HIDE_REASONS.indexOf(precheck.reason) !== -1) {
        text += ' · ' + t('cl.hide.reason.' + precheck.reason)
      }
      return text
    }

    /** 别处引用过的证据路径（§2.19 硬规则 3；只呈现路径文本，面板不读这些文件）。 */
    function referencedPaths(registryUse) {
      if (registryUse === null || typeof registryUse !== 'object'
        || !Array.isArray(registryUse.nameReferencedElsewhere)) return []
      return registryUse.nameReferencedElsewhere.filter(function (path) { return typeof path === 'string' && path !== '' })
    }

    /** 可粘贴的 deny 清单文本（§2.23.2：来自 hideApply.denyList，用户自己复制粘贴）。 */
    function denyListText(apply) {
      if (apply === null || typeof apply !== 'object' || !Array.isArray(apply.denyList)) return ''
      return apply.denyList.filter(function (name) { return typeof name === 'string' }).join(', ')
    }

    /** 是否显示复制按钮（§4.8 第 5 条：未校验 / 不支持时**不显示**）。 */
    function showCopyButton(status, apply) {
      return status === 'prechecked' && denyListText(apply) !== ''
    }

    /** `hideApply.mode` 与 appliedNames/skipped 的如实呈现（§2.23.4：建议 ≠ 已施加）。 */
    function applyModeText(apply, t) {
      var mode = apply !== null && typeof apply === 'object' ? apply.mode : null
      var base = HIDE_APPLY_MODES.indexOf(mode) === -1 || mode === 'suggestion-only'
        ? t('cl.hide.applyMode.suggestionOnly')
        : t('cl.hide.applyMode.appliedByConfig')
      var applied = apply !== null && typeof apply === 'object' && Array.isArray(apply.appliedNames)
        ? apply.appliedNames.length : 0
      var skipped = apply !== null && typeof apply === 'object' && Array.isArray(apply.skipped)
        ? apply.skipped.length : 0
      var extra = []
      if (applied > 0) extra.push(t('cl.hide.applyApplied', { n: formatInt(applied) }))
      if (skipped > 0) extra.push(t('cl.hide.applySkipped', { n: formatInt(skipped) }))
      return extra.length === 0 ? base : base + ' · ' + extra.join(' · ')
    }

    /** 恢复路径（§2.24）：六条事实文案，常驻可见。 */
    function restoreLines(t) {
      return [
        { key: 'step1', text: t('cl.hide.restoreStep1') },
        { key: 'step2', text: t('cl.hide.restoreStep2') },
        { key: 'step3', text: t('cl.hide.restoreStep3') },
        { key: 'subagent', text: t('cl.hide.restoreSubagent') },
        { key: 'no-undo', text: t('cl.hide.restoreNoUndo') },
        { key: 'readonly', text: t('cl.hide.restoreReadonly') },
      ]
    }

    /** 单元配对键（§2.22：`(kind, target)`；target 为 null 时用 kind 参与配对）。 */
    function unitKeyOf(unit) {
      var kind = unit !== null && typeof unit === 'object' && typeof unit.kind === 'string' ? unit.kind : 'unknown'
      var target = unit !== null && typeof unit === 'object' && typeof unit.target === 'string' ? unit.target : ''
      return kind + ':' + target
    }

    /**
     * 并列呈现的行（§2.22 第 1/2 条）：每个 hidePlan 单元一行，两种动作的代价同屏。
     * `inPrunePlan === true` 时按 `(kind, target)` 在 `prunePlan` 里**查表**取卸载口径；
     * 查不到就只显示隐藏一行 —— 面板不自行推断"能否卸载"。
     * **两个动作的 token 各自独立呈现，绝不求和**（§2.22 第 3 条）。
     */
    function parallelRows(report, t) {
      var prune = pruneEntries(report)
      return hideUnits(report).map(function (unit) {
        var key = unitKeyOf(unit)
        var match = null
        if (unit.inPrunePlan === true) {
          for (var i = 0; i < prune.length; i++) {
            if (unitKeyOf(prune[i]) === key) { match = prune[i]; break }
          }
        }
        return {
          key: key,
          unitText: unitLabelText(unit, t) + ' · ' + formatInt(isNum(unit.toolCount) ? unit.toolCount : 0),
          hideText: t('cl.hide.unitHideLine', {
            tools: formatInt(isNum(unit.toolCount) ? unit.toolCount : 0),
            tokens: formatInt(isNum(unit.tokens) ? unit.tokens : 0),
          }),
          pruneText: match === null ? null : t('cl.hide.unitPruneLine', {
            tokens: formatInt(isNum(match.reclaimableTokens) ? match.reclaimableTokens : 0),
            used: formatInt(isNum(match.usedToolCount) ? match.usedToolCount : 0),
          }),
        }
      })
    }

    /** 复制到剪贴板：不可用时不抛错、返回 false（面板据此外显地告诉用户手动复制）。 */
    function copyToClipboard(text) {
      try {
        var nav = typeof navigator === 'undefined' ? null : navigator
        if (nav === null || nav.clipboard === null || typeof nav.clipboard !== 'object'
          || typeof nav.clipboard.writeText !== 'function') return false
        var result = nav.clipboard.writeText(text)
        if (result !== null && result !== undefined && typeof result.then === 'function') {
          result.then(function () {}, function () {})
        }
        return true
      } catch (error) {
        return false
      }
    }

    /* ══════════════════════════════════════════════════════════════════════
     * 样式（内联；bundle 不注入 CSS 文件、不写 style 标签，保持零副作用）
     * ══════════════════════════════════════════════════════════════════════ */

    var dockStyle = { display: 'inline-flex', alignItems: 'center', position: 'relative' }
    var triggerStyle = {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 30, height: 30, padding: 0, background: 'transparent',
      border: '1px solid ' + TONE.border, borderRadius: 7, cursor: 'pointer', font: 'inherit',
    }
    /* 右侧栏内版式：不绝对定位、不限高、不加阴影——栏自己滚动，内容随栏宽。 */
    var panelSidebarStyle = {
      width: '100%', minWidth: 0, maxWidth: '100%', color: TONE.text,
      background: 'transparent', border: 0, borderRadius: 0, boxShadow: 'none',
      textAlign: 'left', font: 'inherit', overflowX: 'hidden',
    }
    /** 栏内承载容器：占满栏高并自己滚动（弹层版高度由 panelStyle 自己管）。 */
    var tabHostStyle = { height: '100%', minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '2px 10px 14px' }
    /** 栏 chip 的标题排（图标 + 文案）：chip 自身负责排版，这里只让两者基线对齐。 */
    var tabTitleStyle = { display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }
    var panelStyle = {
      position: 'absolute', zIndex: 1000, right: 0, bottom: 'calc(100% + 12px)',
      width: 468, maxWidth: 'calc(100vw - 24px)', maxHeight: 'min(72vh, 640px)',
      overflowX: 'hidden', overflowY: 'auto', color: TONE.text,
      background: TONE.canvas, border: '1px solid ' + TONE.borderStrong, borderRadius: 12,
      boxShadow: '0 2px 6px rgba(0, 0, 0, .18), 0 20px 46px rgba(0, 0, 0, .3)',
      textAlign: 'left', font: 'inherit',
    }
    var headStyle = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, padding: '13px 15px 0' }
    var titleStyle = { display: 'block', color: TONE.text, fontSize: FS.s14, lineHeight: LH.s14, fontWeight: 600 }
    var subtitleStyle = { display: 'block', marginTop: 2, color: TONE.quiet, fontSize: FS.xxs12, lineHeight: LH.xxs12 }
    var headerMetaStyle = { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, color: TONE.quiet, fontSize: FS.xxs12, lineHeight: LH.xxs12, fontVariantNumeric: 'tabular-nums' }
    var refreshStyle = {
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: 0, color: TONE.blue,
      background: 'transparent', border: 0, cursor: 'pointer', font: 'inherit',
      fontSize: FS.xs13, lineHeight: LH.xs13, fontWeight: 500,
    }
    var noticeStyle = {
      display: 'flex', alignItems: 'flex-start', gap: 8, margin: '11px 15px 0', padding: '8px 10px',
      color: TONE.red, background: TONE.raised, border: '1px solid ' + TONE.border, borderRadius: 8,
      fontSize: FS.xs13, lineHeight: LH.xs13,
    }
    var errorStyle = { margin: '11px 15px 0', color: TONE.red, fontSize: FS.xs13, lineHeight: LH.xs13 }
    var emptyStyle = { margin: '0 15px', padding: '18px 0', color: TONE.muted, fontSize: FS.xs13, lineHeight: LH.xs13, textAlign: 'center' }

    var statsStyle = { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 1, margin: '12px 15px 0', background: TONE.border, border: '1px solid ' + TONE.border, borderRadius: 9, overflow: 'hidden' }
    var statStyle = { display: 'flex', flexDirection: 'column', gap: 3, padding: '9px 10px', background: TONE.canvas, minWidth: 0 }
    var statLabelStyle = { color: TONE.quiet, fontSize: FS.xxs12, lineHeight: LH.xxs12 }
    var statValueStyle = { display: 'flex', alignItems: 'baseline', gap: 5, minWidth: 0 }
    /* 20（总览数字）保持 l-20；行高仍是数字专用的紧排（字号未变，不涉及挤字）。 */
    var statNumberStyle = { fontFamily: MONO, fontSize: FS.l20, fontWeight: 500, letterSpacing: '-0.03em', lineHeight: 1.05, fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis' }
    var statUnitStyle = { color: TONE.muted, fontSize: FS.xxs12, lineHeight: LH.xxs12 }
    var statSubStyle = { color: TONE.quiet, fontSize: FS.xxs12, lineHeight: LH.xxs12 }

    var blockStyle = { margin: '14px 15px 0' }
    var blockHeadStyle = { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }
    var blockTitleStyle = { color: TONE.text, fontSize: FS.xs13, lineHeight: LH.xs13, fontWeight: 600 }
    var blockHintStyle = { color: TONE.quiet, fontSize: FS.xxs12, lineHeight: LH.xxs12 }
    var GRID = 'minmax(0, 1fr) 76px 86px 92px'
    var columnHeadStyle = { display: 'grid', gridTemplateColumns: GRID, columnGap: 8, padding: '6px 0 3px', borderBottom: '1px solid ' + TONE.border }
    var columnLabelStyle = { color: TONE.quiet, fontSize: FS.xxxs11, lineHeight: LH.xxxs11, textAlign: 'right' }
    var rowWrapStyle = { padding: '6px 0', borderBottom: '1px solid ' + TONE.border }
    var rowStyle = { display: 'grid', gridTemplateColumns: GRID, columnGap: 8, alignItems: 'center' }
    var nameCellStyle = { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }
    var badgeStyle = { flex: '0 0 auto', padding: '1px 5px', borderRadius: 4, background: TONE.raised, color: TONE.muted, fontSize: FS.xxxs11, lineHeight: LH.xxxs11, whiteSpace: 'nowrap' }
    var itemNameStyle = { overflow: 'hidden', color: TONE.text, fontSize: FS.xs13, lineHeight: LH.xs13, textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
    var figureStyle = { color: TONE.text, fontFamily: MONO, fontSize: FS.xs13, lineHeight: LH.xs13, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
    /* 未知值渲染成中性灰徽标（DESIGN §4.4：不是零调用样式，也不是数字）。 */
    var unknownFigureStyle = { justifySelf: 'end', padding: '1px 6px', border: '1px solid currentColor', borderRadius: 999, fontSize: FS.xxxs11, lineHeight: LH.xxxs11, whiteSpace: 'nowrap', color: TONE.quiet }
    var catHeadStyle = { display: 'grid', gridTemplateColumns: '12px minmax(0, 1fr) 92px 44px', columnGap: 9, alignItems: 'center', width: '100%', padding: '8px 0', color: TONE.text, background: 'transparent', border: 0, borderBottom: '1px solid ' + TONE.border, textAlign: 'left', font: 'inherit' }
    var catNameStyle = { display: 'block', overflow: 'hidden', fontSize: FS.xs13, lineHeight: LH.xs13, fontWeight: 500, textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
    var barTrackStyle = { display: 'block', height: 4, marginTop: 5, background: TONE.sunk, borderRadius: 2, overflow: 'hidden' }
    var catValueStyle = { fontFamily: MONO, fontSize: FS.xs13, lineHeight: LH.xs13, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
    var catShareStyle = { justifySelf: 'end', color: TONE.muted, fontFamily: MONO, fontSize: FS.xxs12, lineHeight: LH.xxs12, fontVariantNumeric: 'tabular-nums' }
    var catNoteStyle = { padding: '0 0 6px 21px', color: TONE.quiet, fontSize: FS.xxs12, lineHeight: LH.xxs12 }
    var detailStyle = { background: TONE.raised, borderBottom: '1px solid ' + TONE.border }
    var detailPadStyle = { padding: '0 10px' }
    var moreStyle = { padding: '6px 10px 0', color: TONE.quiet, fontSize: FS.xxs12, lineHeight: LH.xxs12, fontFamily: MONO }
    var footerStyle = { display: 'flex', flexDirection: 'column', gap: 4, padding: '11px 15px 12px' }
    var evidenceStyle = { color: TONE.quiet, fontFamily: MONO, fontSize: FS.xxxs11, lineHeight: LH.xxxs11, wordBreak: 'break-all' }
    var warningStyle = { color: TONE.amber, fontSize: FS.xxs12, lineHeight: LH.xxs12 }
    var privacyStyle = { color: TONE.quiet, fontSize: FS.xxs12, lineHeight: LH.xxs12 }

    /* ── v2：归属徽标 / 裁剪候选块 / 无法给出动作分节 ───────────────────────── */
    var attributionStyle = { flex: '0 0 auto', padding: '1px 5px', borderRadius: 4, background: TONE.raised, color: TONE.muted, fontSize: FS.xxxs11, lineHeight: LH.xxxs11, whiteSpace: 'nowrap' }
    /* §4.4：归属未知 / 低置信 —— 中性灰 + 问号（由文案自带），不用确定语气、不用琥珀/红。 */
    var attributionUncertainStyle = { flex: '0 0 auto', padding: '1px 5px', borderRadius: 4, border: '1px dashed ' + TONE.borderStrong, color: TONE.quiet, fontSize: FS.xxxs11, lineHeight: LH.xxxs11, whiteSpace: 'nowrap' }
    var attributionEvidenceStyle = { padding: '0 0 4px 21px', color: TONE.quiet, fontFamily: MONO, fontSize: FS.xxxs11, lineHeight: LH.xxxs11, userSelect: 'text', wordBreak: 'break-all' }
    var attributionWarnStyle = { padding: '0 0 4px 21px', color: TONE.amber, fontSize: FS.xxs12, lineHeight: LH.xxs12 }

    var pruneRowStyle = { padding: '2px 0 7px', borderBottom: '1px solid ' + TONE.border }
    var pruneHeadStyle = { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 8, rowGap: 3, width: '100%', padding: '6px 0 0', color: TONE.text, background: 'transparent', border: 0, textAlign: 'left', font: 'inherit', cursor: 'pointer' }
    var pruneUnitStyle = { color: TONE.text, fontSize: FS.xs13, lineHeight: LH.xs13, fontWeight: 600 }
    var pruneLineStyle = { color: TONE.muted, fontSize: FS.xxs12, lineHeight: LH.xxs12 }
    var pruneStrongStyle = { color: TONE.text, fontSize: FS.xxs12, lineHeight: LH.xxs12, fontWeight: 500 }
    var pruneLowStyle = { color: TONE.amber, fontSize: FS.xxs12, lineHeight: LH.xxs12 }
    var pruneFactStyle = { padding: '1px 0 0', color: TONE.quiet, fontSize: FS.xxs12, lineHeight: LH.xxs12, wordBreak: 'break-all' }
    var pruneDetailStyle = { marginTop: 4, padding: '4px 0 2px 10px', background: TONE.raised, borderLeft: '2px solid ' + TONE.border }
    /* §4.7 第 3 条：固定不确定性声明常驻段底（可见、不折叠、无交互）。 */
    var caveatStyle = { margin: '8px 0 0', padding: '7px 9px', color: TONE.muted, background: TONE.raised, border: '1px solid ' + TONE.border, borderRadius: 8, fontSize: FS.xxs12, lineHeight: LH.xxs12 }
    var noRecRowStyle = { padding: '5px 0', color: TONE.muted, fontSize: FS.xxs12, lineHeight: LH.xxs12, borderBottom: '1px solid ' + TONE.border }

    /* ── v3：可隐藏候选 / 恢复路径 / 两套动作并列 ───────────────────────────
     * 配色沿用宿主主题变量；**不用** error 红暗示危害（§6 第 11 条）：未校验提示条
     * 复用 §4.7 已有的 noticeStyle（那是"需要人工确认"的中性提示，不是危险告警）。 */
    var hideRowStyle = { padding: '6px 0 8px', borderBottom: '1px solid ' + TONE.border }
    var hideHeadStyle = { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 8, rowGap: 3 }
    var hideApplyStyle = { padding: '7px 0 0', color: TONE.muted, fontSize: FS.xxs12, lineHeight: LH.xxs12 }
    var hideEvidenceStyle = { padding: '2px 0 0', color: TONE.quiet, fontFamily: MONO, fontSize: FS.xxxs11, lineHeight: LH.xxxs11, wordBreak: 'break-all', userSelect: 'text' }
    var hideWarnStyle = { padding: '3px 0 0', color: TONE.amber, fontSize: FS.xxs12, lineHeight: LH.xxs12 }
    var hideDenyStyle = { margin: '8px 0 0', padding: '7px 9px', background: TONE.raised, border: '1px solid ' + TONE.border, borderRadius: 8 }
    var hideDenyHeadStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }
    var hideDenyListStyle = { margin: '4px 0 0', color: TONE.text, fontFamily: MONO, fontSize: FS.xxs12, lineHeight: LH.xxs12, wordBreak: 'break-all', userSelect: 'text' }
    var hideNoSumStyle = { margin: '6px 0 0', padding: '6px 8px', color: TONE.muted, background: TONE.raised, border: '1px solid ' + TONE.border, borderRadius: 8, fontSize: FS.xxs12, lineHeight: LH.xxs12 }

    /* ── v4（R8）：窗口口径 / 本会话口径 / 三态徽标（DESIGN §4.9）──────────────
     * 配色沿用宿主主题变量：三态里只有 `absent` 复用零调用（琥珀）样式；
     * `historical-only` 用中性灰（**绝不**用琥珀，否则会被读成"零调用"）；
     * `current-session` 用品牌色（中性偏正向，**不是**告警色、也不是"健康"绿）。 */
    var windowScopeStyle = { margin: '6px 15px 0', color: TONE.quiet, fontSize: FS.xxs12, lineHeight: LH.xxs12, fontVariantNumeric: 'tabular-nums' }
    var windowOmittedStyle = { margin: '2px 15px 0', color: TONE.amber, fontSize: FS.xxs12, lineHeight: LH.xxs12 }
    var windowScopeNoteStyle = { margin: '6px 0 0', color: TONE.quiet, fontSize: FS.xxs12, lineHeight: LH.xxs12, fontVariantNumeric: 'tabular-nums' }
    var windowOmittedNoteStyle = { margin: '2px 0 0', color: TONE.amber, fontSize: FS.xxs12, lineHeight: LH.xxs12 }
    var currentSessionStyle = { display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 8, rowGap: 2, margin: '6px 15px 0', color: TONE.text, fontSize: FS.xxs12, lineHeight: LH.xxs12 }
    var currentSessionLabelStyle = { color: TONE.quiet, fontSize: FS.xxs12, lineHeight: LH.xxs12 }
    var currentSessionValueStyle = { fontFamily: MONO, fontSize: FS.xs13, lineHeight: LH.xs13, fontVariantNumeric: 'tabular-nums' }
    var currentSessionQuietStyle = { color: TONE.quiet, fontSize: FS.xxxs11, lineHeight: LH.xxxs11 }
    var presenceLineStyle = { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 8, rowGap: 2, margin: '2px 0 0' }
    var presenceFigureStyle = { color: TONE.quiet, fontSize: FS.xxxs11, lineHeight: LH.xxxs11, fontVariantNumeric: 'tabular-nums' }
    /* 「不可判定」渲染成中性灰**徽标**（§4.4 的 v4 第 3 行）：与"本会话 0 次"的普通数字格
     * 在视觉上就是两种东西——"不知道"不得长得像"零调用"。 */
    var presenceUnknownStyle = { padding: '1px 6px', border: '1px solid ' + TONE.borderStrong, borderRadius: 999, color: TONE.quiet, fontSize: FS.xxxs11, lineHeight: LH.xxxs11, whiteSpace: 'nowrap' }
    var presenceCurrentStyle = { flex: '0 0 auto', padding: '1px 5px', borderRadius: 4, background: TONE.raised, color: TONE.blue, fontSize: FS.xxxs11, lineHeight: LH.xxxs11, whiteSpace: 'nowrap' }
    var presenceNeutralStyle = { flex: '0 0 auto', padding: '1px 5px', borderRadius: 4, background: TONE.raised, color: TONE.muted, fontSize: FS.xxxs11, lineHeight: LH.xxxs11, whiteSpace: 'nowrap' }
    var zeroChipInlineStyle = { justifySelf: 'end', padding: '1px 6px', border: '1px solid currentColor', borderRadius: 999, fontSize: FS.xxxs11, lineHeight: LH.xxxs11, whiteSpace: 'nowrap', color: chipColor('zero') }

    /* ══════════════════════════════════════════════════════════════════════
     * 展示组件（全部由上面的纯映射驱动）
     * ══════════════════════════════════════════════════════════════════════ */

    function ScaleIcon(size) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true',
      }, h('path', {
        d: 'M12 4v16M7 20h10M12 5.6 5 8m7-2.4L19 8M5 8l-2.4 5.2a3.1 3.1 0 0 0 4.8 0L5 8Zm14 0-2.4 5.2a3.1 3.1 0 0 0 4.8 0L19 8Z',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    function RefreshIcon() {
      return h('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M20 11a8 8 0 0 0-14.98-3.8M4 5v4h4M4 13a8 8 0 0 0 14.98 3.8M20 19v-4h-4',
          stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
        }))
    }

    /** 分类徽标：只出现固定枚举文案（cl.cat.*）。 */
    function categoryBadge(category, t) {
      var label = CATEGORY_ORDER.indexOf(category) === -1 ? String(category) : t('cl.cat.' + category)
      return h('span', { key: 'badge', style: badgeStyle }, label)
    }

    /**
     * 数值格：有数 → 数字；null / 非有限 → cl.unknown（**绝不** 0）。
     * `marker`（v4）给该格一个数据标记（`tokens` / `tokens-per-call`），
     * 让核验线能逐格断言"§4.9 第 1 条的三个数各有独立节点"，而不是对整行文本做模糊匹配。
     */
    function figure(value, t, marker) {
      var tag = marker === undefined ? {} : { 'data-cl-figure': marker }
      if (isNum(value)) return h('span', Object.assign({ key: 'figure', style: figureStyle }, tag), formatInt(value))
      return h('span', Object.assign({ key: 'figure', style: unknownFigureStyle }, tag), t('cl.unknown'))
    }

    /** 次数格（窗口口径 `calls`）：零调用 → neverCalled 徽标；未知 → unknown；正数 → 数字。 */
    function callsCell(item, t) {
      var state = itemState(item)
      if (state === 'zero') {
        return h('span', {
          key: 'calls',
          'data-cl-state': 'zero',
          'data-cl-figure': 'calls',
          style: zeroChipInlineStyle,
        }, t('cl.neverCalled'))
      }
      return figure(item.calls, t, 'calls')
    }

    /**
     * 归属徽标（v2，DESIGN §4.2.4 / §4.4）：插件包名 / DSH 自带 / MCP: server / 归属未知；
     * `confidence === "low"` 或 `kind === "unknown"` 时带问号，用中性灰，**不使用**确定语气。
     */
    function attributionBadge(providedBy, t) {
      var label = attributionText(providedBy, t)
      if (label === null) return null
      var uncertain = providedBy.kind === 'unknown' || providedBy.confidence === 'low'
      return h('span', {
        key: 'attribution',
        'data-cl-attribution': String(providedBy.kind),
        'data-cl-attribution-confidence': String(providedBy.confidence),
        style: uncertain ? attributionUncertainStyle : attributionStyle,
        title: providedBy.confidence === 'low' ? t('cl.providedBy.inferred') : undefined,
      }, label)
    }

    /** 明细行下的归属补充（§4.7 第 7 条）：证据路径 + 低置信的「推断，可能存在误判」。 */
    function attributionNoteLines(providedBy, t) {
      return attributionNotes(providedBy, t).map(function (note) {
        return h('div', {
          key: note.key,
          'data-cl-attribution-note': note.key,
          style: note.tone === 'warn' ? attributionWarnStyle : attributionEvidenceStyle,
        }, note.text)
      })
    }

    /**
     * 一行账目：名字 + 分类徽标 + 归属徽标 + 成本 + 次数 + 每次使用成本。
     *
     * v4（§4.2 第 4 段 / §4.9 第 1 条）：次数可观测的项再补一行 v4 口径——
     * **窗口总调用（上面那格 `calls`）· 本会话 `currentSessionCalls` · 覆盖会话数
     * `sessionsWithCalls`** 三个数同屏，各自独立成节点、标签清晰、互不可加。
     * 行标记 `data-cl-presence` 取三态值（拿不到时为 `unavailable`），供核验线逐行断言。
     */
    function ledgerRow(item, t, scope) {
      var state = itemState(item)
      var presence = presenceOf(item)
      return h('div', {
        key: String(item.id === undefined ? item.name : item.id),
        'data-cl-row': item.category,
        'data-cl-state': state,
        'data-cl-presence': presence === null ? 'unavailable' : presence,
        style: rowWrapStyle,
      }, [
        h('div', { key: 'grid', style: rowStyle }, [
          h('div', { key: 'name', style: nameCellStyle }, [
            categoryBadge(item.category, t),
            attributionBadge(item.providedBy, t),
            h('span', {
              key: 'label',
              style: itemNameStyle,
              title: item.category === 'instructions' ? item.name : undefined,
            }, item.category === 'instructions' ? shortPath(item.name) : item.name),
          ]),
          figure(item.tokens, t, 'tokens'),
          callsCell(item, t),
          figure(item.tokensPerCall, t, 'tokens-per-call'),
        ]),
        presenceLine(item, t, scope),
      ])
    }

    /** 列头（复用冻结键：token / 观测调用 / 每次使用成本）。 */
    function columnHead(t) {
      return h('div', { key: 'cols', style: columnHeadStyle }, [
        h('span', { key: 'c1' }),
        h('span', { key: 'c2', style: columnLabelStyle }, t('cl.tokens')),
        h('span', { key: 'c3', style: columnLabelStyle }, t('cl.observedCalls')),
        h('span', { key: 'c4', style: columnLabelStyle }, t('cl.tokensPerCall')),
      ])
    }

    /**
     * 清单块：标题 + 提示 + 列头 + 行；空清单显示 cl.empty（**不**包装成「健康」之类结论）。
     * `options.footer`（v4 新增，可选）渲染在段体之后：零调用段用它常驻窗口声明行
     * （§4.2 第 3 段 / §4.9 第 2 条）——它必须是**普通节点**，不可折叠、不做 tooltip。
     */
    function listBlock(options) {
      var t = options.t
      var footer = Array.isArray(options.footer) ? options.footer : []
      return h('section', { key: options.id, style: blockStyle, 'data-cl-block': options.id }, [
        h('div', { key: 'head', style: blockHeadStyle }, [
          h('span', { key: 'title', style: blockTitleStyle }, options.title),
          h('span', { key: 'hint', style: blockHintStyle }, options.hint),
        ]),
        options.rows.length === 0
          ? h('p', { key: 'empty', style: emptyStyle }, t('cl.empty'))
          : h('div', { key: 'body' }, [
            columnHead(t),
            options.rows.map(options.renderRow),
          ]),
        footer,
      ])
    }

    /**
     * 裁剪候选块（DESIGN §4.7 第 1/2/3/5/7 条）：
     *   · 段标题是候选语气（`cl.prunePlanTitle`，逐字契约）；
     *   · 每行五件事实齐备：单元名 + 单元种类 / 工具数与代表工具名 / 可省 token（带「若未使用」）/
     *     同单元在用工具数（0 也要显示）/ 事实包名；
     *   · `confidence === "low"` 的单元带「推断，可能存在误判」；
     *   · 顺序恒为宿主给的 `reclaimableTokens` 降序，不重排、不过滤；
     *   · 末行常驻固定不确定性声明（`cl.prunePlanCaveat`），不可折叠、不做 tooltip。
     *
     * 展开状态由 `props.expandedTarget` / `props.onToggle` 提供（本函数是**无 hook 的纯渲染函数**：
     * hook 只在 LedgerPanel 里声明，避免条件渲染改变 hook 顺序）。
     */
    function PruneBlock(props) {
      var t = typeof props.t === 'function' ? props.t : fallbackT
      var entries = Array.isArray(props.entries) ? props.entries : []
      var index = props.itemIndex === undefined || props.itemIndex === null ? {} : props.itemIndex
      var onToggle = typeof props.onToggle === 'function' ? props.onToggle : function () {}

      var rows = entries.map(function (entry) {
        var target = String(entry.target)
        var isOpen = props.expandedTarget === target
        var low = isLowConfidence(entry)
        var items = Array.isArray(entry.items) ? entry.items : []
        return h('div', {
          key: 'prune:' + target,
          'data-cl-prune-row': target,
          'data-cl-prune-kind': String(entry.kind),
          'data-cl-prune-confidence': String(entry.confidence),
          style: pruneRowStyle,
        }, [
          h('button', {
            key: 'toggle',
            type: 'button',
            'aria-expanded': isOpen,
            title: isOpen ? t('cl.collapse') : t('cl.expand'),
            onClick: function () {
              onToggle(target)
            },
            style: pruneHeadStyle,
          }, [
            /* ① 单元名 + 单元种类（§4.7 第 2 条） */
            h('span', { key: 'unit', style: pruneUnitStyle, 'data-cl-prune-unit': '' },
              pruneUnitText(entry, t) + ' · ' + target),
            /* ② 工具数 + 行内代表工具名 */
            h('span', { key: 'tools', style: pruneLineStyle, 'data-cl-prune-tools': '' }, pruneNamesText(entry, t)),
            /* ③ 可省 token（带「若未使用」条件语） */
            h('span', { key: 'reclaim', style: pruneStrongStyle, 'data-cl-prune-reclaim': '' }, pruneReclaimText(entry, t)),
            /* ④ 同单元在用工具数（为 0 也显示） */
            h('span', { key: 'used', style: pruneLineStyle, 'data-cl-prune-used': '' }, usedToolsText(entry, t)),
            /* 低置信标记（§4.7 第 4 条） */
            low ? h('span', { key: 'low', style: pruneLowStyle, 'data-cl-prune-low': '' }, t('cl.pruneConfidenceLow')) : null,
          ]),
          /* ⑤ 事实包名（回答“为什么单元名和工具名不是一回事”） */
          h('div', { key: 'facts', style: pruneFactStyle, 'data-cl-prune-facts': '' }, pruneFactText(entry, t)),
          isOpen
            ? h('div', { key: 'detail', style: pruneDetailStyle, 'data-cl-prune-detail': '' },
              items.map(function (item) {
                var source = index[item.id]
                var providedBy = source !== undefined && source !== null ? source.providedBy : null
                return h('div', { key: 'item:' + String(item.id), 'data-cl-prune-item': String(item.id) }, [
                  h('div', { key: 'row', style: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 8 } }, [
                    attributionBadge(providedBy, t),
                    h('span', { key: 'name', style: itemNameStyle }, String(item.name)),
                    h('span', { key: 'tokens', style: pruneLineStyle }, formatInt(item.tokens) + ' ' + t('cl.tokens')),
                  ]),
                  /* §4.7 第 7 条：证据路径可查、且不读该文件 */
                  attributionNoteLines(providedBy, t),
                ])
              }))
            : null,
        ])
      })

      return h('section', { key: 'prune', style: blockStyle, 'data-cl-block': 'prune-plan' }, [
        h('div', { key: 'head', style: blockHeadStyle }, [
          h('span', { key: 'title', style: blockTitleStyle, 'data-cl-prune-title': '' }, t('cl.prunePlanTitle')),
          h('span', { key: 'hint', style: blockHintStyle }, t('cl.prunePlanHint')),
        ]),
        entries.length === 0
          ? h('p', { key: 'empty', style: emptyStyle }, t('cl.empty'))
          : h('div', { key: 'rows' }, rows),
        /* 常驻段底的固定不确定性声明（文字不经 tooltip、不折叠、无 onClick）。 */
        h('p', { key: 'caveat', style: caveatStyle, 'data-cl-prune-caveat': '' }, t('cl.prunePlanCaveat')),
      ])
    }

    /**
     * 「无法给出动作」分节（DESIGN §4.7 第 4 条）：
     * `providedBy.kind === "unknown"` 的项**只能**落在这里（按宿主给的理由分组计数），
     * 不得混进候选清单，也不得显示成「DSH 自带」。计数全为 0 的理由由 §2.16 要求面板过滤。
     */
    function NoRecommendationBlock(props) {
      var t = typeof props.t === 'function' ? props.t : fallbackT
      var rows = Array.isArray(props.rows) ? props.rows : []
      return h('section', { key: 'norec', style: blockStyle, 'data-cl-block': 'no-recommendation' }, [
        h('div', { key: 'head', style: blockHeadStyle }, [
          h('span', { key: 'title', style: blockTitleStyle, 'data-cl-norec-title': '' }, t('cl.noRecommendationTitle')),
        ]),
        rows.length === 0
          ? h('p', { key: 'empty', style: emptyStyle }, t('cl.empty'))
          : h('div', { key: 'rows' }, rows.map(function (row) {
            return h('div', {
              key: 'norec:' + row.reason,
              'data-cl-norec-row': row.reason,
              style: noRecRowStyle,
            }, row.text)
          })),
      ])
    }

    /**
     * R6 段：可隐藏候选（工具级）（DESIGN §4.8 第 1/2/3/5/6 条）。
     *
     * 措辞要点（§6 第 11 条 / 本轮验收）：
     *   · 段标题逐字契约：「可隐藏候选（工具级）· 需人工确认」——是**候选**，不是"已施加"；
     *   · 每行给出 name / unit（种类+单元名）/ tokens / registryUse 的人话解释 / 预校验状态；
     *   · `hidePlanCaveat` 五条**常驻段底**（无 onClick、无 title、无折叠）；
     *   · `hidePlanStatus !== "prechecked"` 时显示"未校验，不要直接照抄清单"，且**不显示复制按钮**；
     *   · `selfTool === true` 的行必须说明"隐藏后模型将无法再调用本账本"。
     *
     * 无 hook 的纯渲染函数（hook 只在 LedgerPanel 声明，见 F10 的静态守卫）。
     */
    function HidePlanBlock(props) {
      var t = typeof props.t === 'function' ? props.t : fallbackT
      var entries = Array.isArray(props.entries) ? props.entries : []
      var status = typeof props.status === 'string' ? props.status : 'unvalidated'
      var apply = props.apply === undefined ? null : props.apply
      var caveats = Array.isArray(props.caveats) ? props.caveats : []
      var onCopy = typeof props.onCopy === 'function' ? props.onCopy : function () {}
      var validated = status === 'prechecked'
      var denyText = denyListText(apply)
      var copyable = showCopyButton(status, apply)

      var rows = entries.map(function (entry) {
        var registryUse = entry.registryUse === undefined ? null : entry.registryUse
        var unit = entry.unit === undefined ? null : entry.unit
        var precheck = entry.precheck === undefined ? null : entry.precheck
        var referenced = referencedPaths(registryUse)
        return h('div', {
          key: 'hide:' + String(entry.name),
          'data-cl-hide-row': String(entry.name),
          'data-cl-hide-precheck': precheck !== null && typeof precheck === 'object'
            ? String(precheck.status) : 'unvalidated',
          'data-cl-hide-self': entry.selfTool === true ? 'true' : 'false',
          style: hideRowStyle,
        }, [
          h('div', { key: 'head', style: hideHeadStyle }, [
            h('span', { key: 'name', style: itemNameStyle, 'data-cl-hide-name': '' }, String(entry.name)),
            categoryBadge(entry.category, t),
            h('span', { key: 'tokens', style: pruneStrongStyle, 'data-cl-hide-tokens': '' },
              formatInt(isNum(entry.tokens) ? entry.tokens : 0) + ' ' + t('cl.tokens')),
          ]),
          h('div', { key: 'unit', style: pruneFactStyle, 'data-cl-hide-unit': '' },
            unitLabelText(unit, t) + ' · ' + unitFactText(unit, t)),
          h('div', { key: 'registry', style: pruneLineStyle, 'data-cl-hide-verdict': '' },
            t('cl.hide.registryUseLabel') + '：' + registryUseText(registryUse, t)),
          h('div', { key: 'precheck', style: pruneLineStyle, 'data-cl-hide-precheck-text': '' },
            t('cl.hide.precheckLabel') + '：' + precheckText(precheck, t)),
          referenced.length === 0
            ? null
            : h('div', { key: 'referenced', style: hideEvidenceStyle, 'data-cl-hide-referenced': '' }, [
              h('span', { key: 'label', style: { color: TONE.amber } }, t('cl.hide.referencedElsewhere')),
              h('span', { key: 'paths' }, ' ' + referenced.join(', ')),
            ]),
          entry.selfTool === true
            ? h('div', { key: 'self', style: hideWarnStyle, 'data-cl-hide-self-note': '' }, t('cl.hide.selfToolNote'))
            : null,
        ])
      })

      return h('section', { key: 'hide', style: blockStyle, 'data-cl-block': 'hide-plan' }, [
        h('div', { key: 'head', style: blockHeadStyle }, [
          h('span', { key: 'title', style: blockTitleStyle, 'data-cl-hide-title': '' }, t('cl.hidePlanTitle')),
          h('span', { key: 'hint', style: blockHintStyle }, t('cl.hidePlanHint')),
        ]),
        /* §4.8 第 5 条：未校验 / 不支持 ⇒ 提示条（且下面不给复制按钮） */
        validated
          ? null
          : h('p', { key: 'banner', style: noticeStyle, 'data-cl-hide-banner': status }, t('cl.hide.unvalidatedBanner')),
        /* §2.23.4：把"仅建议 / 已按配置施加"如实说清，绝不让建议看起来像已施加 */
        h('div', { key: 'apply', style: hideApplyStyle, 'data-cl-hide-apply-mode': '' },
          t('cl.hide.applyModeLabel') + '：' + applyModeText(apply, t)),
        entries.length === 0
          ? h('p', { key: 'empty', style: emptyStyle }, t('cl.empty'))
          : h('div', { key: 'rows' }, rows),
        /* 可粘贴清单（§2.23.2/§2.23.4）：只在已校验时给复制按钮；文本始终可选中复制 */
        denyText === ''
          ? null
          : h('div', { key: 'deny', style: hideDenyStyle, 'data-cl-hide-deny': '' }, [
            h('div', { key: 'label', style: hideDenyHeadStyle }, [
              h('span', { key: 'text', style: pruneLineStyle, 'data-cl-hide-deny-label': '' },
                t('cl.hide.denyListLabel', { n: formatInt(denyText.split(', ').length) })),
              copyable
                ? h('button', {
                  key: 'copy', type: 'button', style: refreshStyle, 'data-cl-hide-copy': '',
                  onClick: onCopy,
                }, props.copyState === 'copied' ? t('cl.hide.copied') : t('cl.hide.copyDenyList'))
                : null,
            ]),
            h('div', { key: 'names', style: hideDenyListStyle, 'data-cl-hide-deny-list': '' }, denyText),
            !copyable || props.copyState !== 'manual'
              ? null
              : h('div', { key: 'manual', style: hideWarnStyle, 'data-cl-hide-copy-note': '' },
                t('cl.hide.copyUnavailable')),
          ]),
        /* §4.8 第 3 条：五条代价/不确定性常驻段底（无交互、不可折叠） */
        hideCaveatBlock(t, caveats),
      ])
    }

    /** `hidePlanCaveat` 五条（§4.8 第 3 条）：常驻段底，纯文本，不可折叠、无 tooltip。 */
    function hideCaveatBlock(t, caveats) {
      return h('div', { key: 'caveats', style: caveatStyle, 'data-cl-hide-caveats': '' }, [
        h('div', { key: 'title', style: pruneStrongStyle, 'data-cl-hide-caveat-title': '' }, t('cl.hide.caveatTitle')),
        h('ul', { key: 'list', style: { margin: '4px 0 0', padding: '0 0 0 16px' } },
          caveats.map(function (caveat) {
            return h('li', {
              key: caveat.key,
              'data-cl-hide-caveat': caveat.key,
              style: { margin: '2px 0', lineHeight: 1.55 },
            }, caveat.text)
          })),
      ])
    }

    /** R6 恢复路径（§2.24）：如何改回配置、不追溯、没有撤销命令、本插件不写配置。 */
    function HideRestoreBlock(props) {
      var t = typeof props.t === 'function' ? props.t : fallbackT
      var lines = Array.isArray(props.lines) ? props.lines : []
      return h('section', { key: 'restore', style: blockStyle, 'data-cl-block': 'hide-restore' }, [
        h('div', { key: 'head', style: blockHeadStyle }, [
          h('span', { key: 'title', style: blockTitleStyle, 'data-cl-hide-restore-title': '' }, t('cl.hide.restoreTitle')),
        ]),
        h('div', { key: 'lines' }, lines.map(function (line) {
          return h('div', {
            key: line.key,
            'data-cl-hide-restore-line': line.key,
            style: line.key === 'no-undo' || line.key === 'readonly' ? hideWarnStyle : pruneFactStyle,
          }, line.text)
        })),
      ])
    }

    /**
     * 两套动作并列（§2.22 / §4.8 第 4 条）：每个单元一行，隐藏口径与卸载口径同屏。
     *
     * 硬规则：**两个动作的 token 各自独立呈现，绝不相加**——它们是互斥的替代方案，
     * 不是叠加收益（§3.7 / §6 第 11 条）。面板把这条规则本身也写在段内，避免被读成两笔收益。
     */
    function ParallelBlock(props) {
      var t = typeof props.t === 'function' ? props.t : fallbackT
      var rows = Array.isArray(props.rows) ? props.rows : []
      return h('section', { key: 'parallel', style: blockStyle, 'data-cl-block': 'plan-parallel' }, [
        h('div', { key: 'head', style: blockHeadStyle }, [
          h('span', { key: 'title', style: blockTitleStyle, 'data-cl-hide-parallel-title': '' }, t('cl.hide.parallelTitle')),
          h('span', { key: 'hint', style: blockHintStyle }, t('cl.hide.parallelHint')),
        ]),
        h('p', { key: 'nosum', style: hideNoSumStyle, 'data-cl-hide-no-sum': '' }, t('cl.hide.noSum')),
        rows.length === 0
          ? h('p', { key: 'empty', style: emptyStyle }, t('cl.empty'))
          : h('div', { key: 'rows' }, rows.map(function (row) {
            return h('div', { key: 'p:' + row.key, 'data-cl-parallel-row': row.key, style: hideRowStyle }, [
              h('div', { key: 'unit', style: pruneUnitStyle, 'data-cl-parallel-unit': '' }, row.unitText),
              h('div', { key: 'hide', style: pruneLineStyle, 'data-cl-parallel-hide': '' }, row.hideText),
              row.pruneText === null
                ? h('div', { key: 'no-uninstall', style: hideWarnStyle, 'data-cl-parallel-no-uninstall': '' },
                  t('cl.hide.noUninstall'))
                : h('div', { key: 'prune', style: pruneLineStyle, 'data-cl-parallel-prune': '' }, row.pruneText),
            ])
          })),
      ])
    }

    /**
     * 面板本体 —— **纯展示组件**（入参全部来自 props，不含取数逻辑），
     * 便于无浏览器核验：把 canonical report 直接传进来，逐状态断言渲染结果。
     */
    function LedgerPanel(props) {
      var t = typeof props.t === 'function' ? props.t : fallbackT
      var report = props.report
      var state = props.state
      /* 承载位置（R7）：'popover'（composer 就地浮层，默认）或 'sidebar'（右侧栏 tab 正文）。
       * 只影响外层版式与语义，**不影响**任何内容与呈现义务。 */
      var sidebarMode = props.mode === 'sidebar'
      var expandedState = useState(null)
      var expanded = expandedState[0]
      var setExpanded = expandedState[1]
      /* 裁剪候选的展开状态：与分类展开一样**无条件**声明（hook 顺序跨渲染恒定）。 */
      var pruneState = useState(null)
      var pruneExpanded = pruneState[0]
      var setPruneExpanded = pruneState[1]
      /* 复制清单后的反馈（null / 'copied' / 'manual'）：同样无条件声明。 */
      var copyStateStore = useState(null)
      var copyState = copyStateStore[0]
      var setCopyState = copyStateStore[1]

      var rows = useMemo(function () { return categoryRows(report) }, [report])
      var stats = useMemo(function () { return overview(report, t) }, [report, t])
      var zeroCall = useMemo(function () { return findingRows(report, 'zeroCall') }, [report])
      var topPerUse = useMemo(function () { return findingRows(report, 'topPerUse') }, [report])
      var scope = useMemo(function () { return evidence(report) }, [report])
      var itemById = useMemo(function () { return itemIndex(report) }, [report])
      var noRecommendation = useMemo(function () { return noRecommendationRows(report, t) }, [report, t])
      var capped = useMemo(function () { return providerScanCapped(report) }, [report])
      /* R6：hidePlan 相关的展示映射（全部只读宿主字段，不重算判定） */
      var hidePlan = useMemo(function () { return hideEntries(report) }, [report])
      var hideApply = useMemo(function () { return hideApplyOf(report) }, [report])
      var hideStatus = useMemo(function () { return hideStatusOf(report) }, [report])
      var hideCaveatList = useMemo(function () { return hideCaveats(t) }, [t])
      var hideRestore = useMemo(function () { return restoreLines(t) }, [t])
      var parallel = useMemo(function () { return parallelRows(report, t) }, [report, t])
      /* v4：窗口口径 / 本会话口径（只读 scope；覆盖会话数的分母与"本会话在不在窗口内"）。 */
      var v4Scope = useMemo(function () { return panelScope(report) }, [report])
      var currentSession = useMemo(function () { return currentSessionSummary(report, t) }, [report, t])
      var degraded = report !== null && typeof report === 'object' && report.scope !== null
        && typeof report.scope === 'object' && report.scope.usageAvailable === false

      var body
      if (state === 'error') {
        body = h('p', { key: 'error', style: errorStyle },
          t('cl.error') + (props.error ? ' — ' + String(props.error).slice(0, ERROR_MAX) : ''))
      } else if (report === null || report === undefined) {
        body = h('p', { key: 'empty', style: emptyStyle },
          state === 'loading' ? t('cl.loading') : t('cl.empty'))
      } else {
        body = [
          /* 降级态（§4.4）：顶部提示条 + 清单段空态；总览的数字不伪装成实测 0。 */
          degraded ? h('p', { key: 'notice', 'data-cl-notice': 'no-evidence', style: noticeStyle }, t('cl.noEvidence')) : null,
          h('div', { key: 'stats', style: statsStyle }, stats.map(function (stat) {
            return h('div', { key: stat.key, style: statStyle }, [
              h('span', { key: 'label', style: statLabelStyle }, stat.label),
              h('span', { key: 'value', style: statValueStyle }, [
                h('span', { key: 'n', style: statNumberStyle }, stat.value),
                stat.unknown ? null : h('span', { key: 'u', style: statUnitStyle }, stat.unit),
              ]),
              stat.sub === null ? null : h('span', { key: 'sub', style: statSubStyle }, stat.sub),
            ])
          })),
          /* v4（§4.2 第 2 段 ①）：窗口口径行 + 窗口外会话数，**常驻**总览段（不折叠、不进 tooltip）。 */
          windowScopeNodes(report, t, 'overview'),
          /* v4（§4.2 第 2 段 ② / §4.9 第 3、4 条）：本会话调用；null ⇒ 不可判定（**绝不** 0）。 */
          currentSessionNode(currentSession),
          listBlock({
            id: 'zero-call',
            t: t,
            title: t('cl.zeroCallTitle'),
            hint: t('cl.zeroCallHint'),
            rows: degraded ? [] : zeroCall,
            /* v4（§4.2 第 3 段 / §4.9 第 2 条）：零调用段底部常驻窗口声明，让"零调用"有参照系。 */
            footer: windowScopeNodes(report, t, 'block'),
            renderRow: function (entry) {
              return ledgerRow(findingSource(itemById, entry, true), t, v4Scope)
            },
          }),
          listBlock({
            id: 'top-per-use',
            t: t,
            title: t('cl.topPerUseTitle'),
            hint: t('cl.topPerUseHint'),
            rows: degraded ? [] : topPerUse,
            renderRow: function (entry) {
              return ledgerRow(findingSource(itemById, entry, false), t, v4Scope)
            },
          }),
          /* ── v2 第 3 段：裁剪候选（§4.2 第 3 段 / §4.7）─────────────────────
           * 降级态（usageAvailable === false）下宿主恒给 prunePlan = []（§2.5），
           * 面板照实显示空态，绝不推测候选。 */
          PruneBlock({
            t: t,
            entries: degraded ? [] : pruneEntries(report),
            itemIndex: itemById,
            expandedTarget: pruneExpanded,
            onToggle: function (target) {
              setPruneExpanded(function (current) { return current === target ? null : target })
            },
          }),
          /* ── v2：给出不了动作的项（§4.7 第 4 条：独立分节）───────────────── */
          NoRecommendationBlock({ t: t, rows: degraded ? [] : noRecommendation }),
          /* ── v3/R6 第 4 段：可隐藏候选（工具级）（§4.8）──────────────────────
           * 降级态下宿主恒给 hidePlan = []（§2.20 H7：没有证据就没有候选）；
           * 段的五条代价/不确定性声明照旧常驻（§4.8 第 3 条要求"常驻"，不随是否有候选而变）。 */
          HidePlanBlock({
            t: t,
            entries: degraded ? [] : hidePlan,
            status: hideStatus,
            apply: hideApply,
            caveats: hideCaveatList,
            copyState: copyState,
            onCopy: function () {
              setCopyState(copyToClipboard(denyListText(hideApply)) ? 'copied' : 'manual')
            },
          }),
          /* ── v3/R6：恢复路径（§2.24，独立成段以便代价声明保持在上一段的段底） */
          HideRestoreBlock({ t: t, lines: hideRestore }),
          /* ── v3/R6：两套动作并列（§2.22；token 不得相加）────────────────── */
          ParallelBlock({ t: t, rows: degraded ? [] : parallel }),
          h('section', { key: 'categories', style: blockStyle, 'data-cl-block': 'categories' },
            rows.map(function (row) {
              var items = itemsOfCategory(report, row.key)
              var isOpen = expanded === row.key
              var fold = foldRows(items, DETAIL_LIMIT)
              var note = row.key === 'instructions' ? t('cl.alwaysOnNote')
                : row.key === 'skills' ? t('cl.skillsUnknownNote') : null
              return h('div', { key: row.key, 'data-cl-category': row.key }, [
                h('button', {
                  key: 'head',
                  type: 'button',
                  disabled: items.length === 0,
                  'aria-expanded': isOpen,
                  title: isOpen ? t('cl.collapse') : t('cl.expand'),
                  onClick: function () {
                    setExpanded(function (current) { return current === row.key ? null : row.key })
                  },
                  style: Object.assign({}, catHeadStyle, { cursor: items.length === 0 ? 'default' : 'pointer' }),
                }, [
                  h('span', {
                    key: 'dot',
                    style: { width: 8, height: 8, borderRadius: 99, background: row.tokens > 0 ? CATEGORY_TONE[row.key] : TONE.border },
                  }),
                  h('span', { key: 'name', style: { minWidth: 0 } }, [
                    h('span', { key: 'label', style: catNameStyle },
                      t('cl.cat.' + row.key) + ' · ' + formatInt(row.itemCount)),
                    row.tokens > 0 && row.share !== null
                      ? h('span', { key: 'bar', style: barTrackStyle },
                        h('span', {
                          style: {
                            display: 'block', height: '100%', borderRadius: 2, background: CATEGORY_TONE[row.key],
                            width: Math.round(row.share * 100) + '%',
                          },
                        }))
                      : null,
                  ]),
                  h('span', { key: 'tokens', style: catValueStyle }, formatInt(row.tokens) + ' ' + t('cl.tokens')),
                  h('span', { key: 'share', style: catShareStyle },
                    row.share === null ? t('cl.unknown') : Math.round(row.share * 100) + '%'),
                ]),
                /* 不可观测说明 + 技能目录的机制级对账（DESIGN §4.2.4） */
                note !== null
                  ? h('div', { key: 'note', style: catNoteStyle }, note
                    + (row.key === 'skills' && row.mechanism !== null
                      ? ' · ' + t('cl.skillLoads', {
                        calls: formatInt(row.mechanism.calls),
                        each: row.mechanism.each === null ? t('cl.unknown') : formatInt(row.mechanism.each),
                      })
                      : ''))
                  : null,
                isOpen && items.length > 0
                  ? h('div', { key: 'detail', style: detailStyle }, [
                    h('div', { key: 'pad', style: detailPadStyle }, [
                      columnHead(t),
                      /* 明细行 + 归属补充（§4.7 第 7 条：证据路径；低置信再给「推断，可能存在误判」）。 */
                      fold.shown.map(function (item) {
                        return h('div', { key: 'detail:' + String(item.id), 'data-cl-item': String(item.id) }, [
                          ledgerRow(item, t, v4Scope),
                          attributionNoteLines(item.providedBy, t),
                        ])
                      }),
                    ]),
                    fold.hidden > 0
                      ? h('div', { key: 'more', style: moreStyle }, t('cl.more', { n: formatInt(fold.hidden) }))
                      : null,
                  ])
                  : null,
              ])
            })),
        ]
      }

      return h('section', {
        key: 'panel',
        id: props.id,
        /* 弹层是对话框语义；栏内是栏的一页（栏自己有 tab/region 语义），不用 dialog 冒充。 */
        role: sidebarMode ? 'region' : 'dialog',
        'aria-label': t('cl.title'),
        'data-cl-panel': '',
        'data-cl-mode': sidebarMode ? 'sidebar' : 'popover',
        style: sidebarMode ? panelSidebarStyle : panelStyle,
      }, [
        h('header', { key: 'head', style: headStyle }, [
          h('span', { key: 'titles' }, [
            h('span', { key: 'title', style: titleStyle }, t('cl.title')),
            h('span', { key: 'subtitle', style: subtitleStyle }, t('cl.subtitle')),
          ]),
          h('span', { key: 'meta', style: headerMetaStyle }, [
            h('span', { key: 'updated' }, t('cl.updated', { when: clockStamp(props.refreshedAt) || t('cl.unknown') })),
            h('button', {
              key: 'refresh', type: 'button', disabled: state === 'loading',
              onClick: props.onRefresh, style: refreshStyle,
            }, [RefreshIcon(), t('cl.refresh')]),
          ]),
        ]),
        body,
        h('footer', { key: 'foot', style: footerStyle }, [
          /*
           * 证据行是数据行（沿用 canonical JSON 的字段名形态）：workspaceKey 原样、
           * sessionsCovered 用冻结键、truncated / namesRejected 是字段名。
           * 注：DESIGN §4.5 的冻结键集里没有 truncated 的文案键，因此这里只呈现字段名，
           * 不自行新增键（键集以 DESIGN 为准；需要文案时应先改 DESIGN 再改代码）。
           */
          h('span', { key: 'evidence', style: evidenceStyle },
            (scope.workspaceKey === '' ? t('cl.unknown') : scope.workspaceKey)
            + ' · ' + t('cl.sessionsCovered', {
              scanned: formatInt(scope.sessionsScanned),
              available: formatInt(scope.sessionsAvailable),
            })
            + (scope.truncated ? ' · truncated' : '')
            + ' · namesRejected ' + formatInt(scope.namesRejected)),
          scope.namesRejected > 0
            ? h('span', { key: 'rejected', style: warningStyle },
              t('cl.rejectedWarning', { n: formatInt(scope.namesRejected) }))
            : null,
          /* §4.7 第 6 条：归属扫描触达上限时，把启发式的边界也告诉用户（不是只报好消息）。 */
          capped
            ? h('span', { key: 'capped', style: warningStyle, 'data-cl-provider-scan-capped': '' },
              t('cl.providerScanCapped'))
            : null,
          h('span', { key: 'privacy', style: privacyStyle }, t('cl.privacyNote')),
        ]),
      ])
    }

    /** 渲染兜底：面板内部渲染抛错也不许把宿主 shell 带下去（React 错误边界）。 */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      render() {
        var t = typeof this.props.t === 'function' ? this.props.t : fallbackT
        if (this.state.failed) return h('p', { key: 'failed', style: errorStyle }, t('cl.error'))
        return this.props.children
      }
    }

    /**
     * composer 工具行里的控件（DESIGN §4.1）：图标触发器 + 展开浮层。
     * 打开时先拉一次；手动刷新；不在后台轮询。取数只走宿主同源路由。
     */
    /**
     * 账本数据的取数生命周期（**自定义 hook**：hook 顺序在调用它的组件里恒定）。
     *
     * `enabled` 是"这个承载位置现在需要数据吗"：composer 就地浮层传 `open`（打开时才拉，
     * DESIGN §4.1 的"打开时拉取"不变），右侧栏 tab 传 `true`（挂载即拉，因为栏已经展开、
     * 内容已经在屏幕上）。每个 session 只自动拉一次，之后靠刷新按钮；不在后台轮询。
     *
     * @param {string|undefined} sessionId
     * @param {boolean} enabled
     * @returns {{life: string, report: object|null, error: string|null, stamp: number|null, refresh: function}}
     */
    function useLedgerData(sessionId, enabled) {
      var lifeState = useState('idle')
      var life = lifeState[0]
      var setLife = lifeState[1]
      var reportState = useState(null)
      var report = reportState[0]
      var setReport = reportState[1]
      var errorState = useState(null)
      var error = errorState[0]
      var setError = errorState[1]
      var stampState = useState(null)
      var stamp = stampState[0]
      var setStamp = stampState[1]
      var controllerRef = useRef(null)
      var requestedRef = useRef(null)

      var refresh = useCallback(function () {
        if (typeof sessionId !== 'string' || sessionId === '') return
        if (controllerRef.current !== null) controllerRef.current.abort()
        var controller = typeof AbortController === 'function' ? new AbortController() : null
        controllerRef.current = controller
        setLife('loading')
        setError(null)
        var url = LEDGER_API + '?session=' + encodeURIComponent(sessionId)
        fetch(url, controller === null ? undefined : { signal: controller.signal }).then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status)
          return response.json()
        }).then(function (data) {
          if (controller !== null && controller.signal.aborted) return
          if (data !== null && typeof data === 'object' && data.ok === true
            && data.report !== null && typeof data.report === 'object') {
            setReport(data.report)
            setError(null)
            setStamp(Date.now())
            setLife('ready')
          } else {
            setReport(null)
            setError('empty ledger response')
            setLife('error')
          }
        }, function (failure) {
          if (controller !== null && controller.signal.aborted) return
          setReport(null)
          setError(failure !== null && typeof failure === 'object' && typeof failure.message === 'string'
            ? failure.message : 'ledger transport error')
          setLife('error')
        })
      }, [sessionId])

      useEffect(function () {
        if (enabled !== true) return undefined
        if (requestedRef.current === sessionId) return undefined
        requestedRef.current = sessionId
        refresh()
        return undefined
      }, [enabled, sessionId, refresh])

      /* 卸载（或承载位置消失）即中止在途请求。 */
      useEffect(function () {
        return function () {
          if (controllerRef.current !== null) controllerRef.current.abort()
        }
      }, [])

      return { life: life, report: report, error: error, stamp: stamp, refresh: refresh }
    }

    /**
     * composer 工具行里的控件（DESIGN §4.1 触发入口；R7 起"点我就是开右侧栏"）。
     *
     * 点击语义（本轮硬要求）：
     *   1. 先问右侧栏：`openLedgerTab()` → `ctx.sidebarRight.openTab(kind)`——**同一步展开**该栏；
     *   2. 右侧栏不可用（老宿主 / headless / 未注册成 tab 类型 / 没有在屏会话）→ 回退到
     *      **既有的就地浮层**：控件永远不是死按钮，不抛错、也不静默什么都不做。
     * `openLedgerTab` 由 slot 的 inject face 注入（见 apply()）；它缺席时按"不可用"处理。
     */
    function LedgerRing(props) {
      var t = typeof props.t === 'function' ? props.t : fallbackT
      var sessionId = props.sessionId
      var openState = useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var openLedgerTab = typeof props.openLedgerTab === 'function' ? props.openLedgerTab : null
      var data = useLedgerData(sessionId, open)
      var dockRef = useRef(null)
      var panelId = useId()

      /* Escape / 点击面板外关闭（capture 阶段：被页面内容吞掉的点击也生效）。 */
      useEffect(function () {
        if (!open) return undefined
        function onKeyDown(event) { if (event.key === 'Escape') setOpen(false) }
        function onPointerDown(event) {
          var dock = dockRef.current
          if (dock !== null && dock !== undefined && event.target instanceof Node && !dock.contains(event.target)) setOpen(false)
        }
        document.addEventListener('keydown', onKeyDown)
        document.addEventListener('pointerdown', onPointerDown, true)
        return function () {
          document.removeEventListener('keydown', onKeyDown)
          document.removeEventListener('pointerdown', onPointerDown, true)
        }
      }, [open])

      var hasZeroCall = data.report !== null && typeof data.report === 'object'
        && findingRows(data.report, 'zeroCall').length > 0
      var accent = data.life === 'error' ? TONE.red : hasZeroCall ? TONE.amber : TONE.muted

      return h('span', { ref: dockRef, 'data-context-ledger': '', style: dockStyle }, [
        h('button', {
          key: 'trigger',
          type: 'button',
          'data-cl-trigger': '',
          onClick: function () {
            /* 右侧栏优先：它接管本次点击（同一步展开）；拿不到才就地展开浮层。 */
            if (openLedgerTab !== null && openLedgerTab() === true) return
            setOpen(function (value) { return !value })
          },
          title: t('cl.hint') + ' · ' + t('cl.title'),
          'aria-label': t('cl.title'),
          'aria-expanded': open,
          'aria-controls': panelId,
          style: Object.assign({}, triggerStyle, { color: accent }),
        }, ScaleIcon(16)),
        open
          /*
           * 面板必须是**独立组件实例**（`h(LedgerPanel, …)`），不能直接调用 `LedgerPanel(…)`：
           * 直接调用会把面板的 hook 挂到 LedgerRing 的 hook 列表上，而这里又是条件渲染
           * （open 为 false 时不渲染）——展开/收起会改变 hook 数量，直接触发 React 的
           * "Rendered more hooks than during the previous render" 崩溃。
           */
          ? h(PanelBoundary, { key: 'panel', t: t }, h(LedgerPanel, {
            id: panelId,
            mode: 'popover',
            t: t,
            report: data.report,
            state: data.life,
            error: data.error,
            refreshedAt: data.stamp,
            onRefresh: data.refresh,
          }))
          : null,
      ])
    }

    /**
     * 右侧栏 tab 的**正文**（`sidebar.right.pane.tab`，key = tab 类型的 id）。
     *
     * 与 composer 浮层**共用同一个 LedgerPanel**（`mode: 'sidebar'` 只换外层版式：
     * 不再绝对定位、不再限高，交给栏自己滚动），因此 §4.7 七条与 §4.8 的 R6 义务
     * 在新位置**一条不减**（同一份映射、同一份词典）。
     */
    function LedgerTab(props) {
      var t = typeof props.t === 'function' ? props.t : fallbackT
      var data = useLedgerData(props.sessionId, true)
      return h('div', { 'data-cl-tab': '', style: tabHostStyle }, h(PanelBoundary, { t: t }, h(LedgerPanel, {
        id: 'context-ledger-tab',
        mode: 'sidebar',
        t: t,
        report: data.report,
        state: data.life,
        error: data.error,
        refreshedAt: data.stamp,
        onRefresh: data.refresh,
      })))
    }

    /** 右侧栏 tab 的**标题**（`sidebar.right.pane.tab.title`，同一个 key）：栏 chip 的文案。 */
    function LedgerTabTitle(props) {
      var t = typeof props.t === 'function' ? props.t : fallbackT
      return h('span', { 'data-cl-tab-title': '', style: tabTitleStyle }, [ScaleIcon(13), t('cl.title')])
    }

    /* ══════════════════════════════════════════════════════════════════════
     * cordis 插件面
     * ══════════════════════════════════════════════════════════════════════ */

    /**
     * 注册词典并把控件落到 composer 工具行（list 座位，不复用内置 id）。
     * @param {import('@deepseek-ai/cordis').Context} ctx
     */
    /* ══════════════════════════════════════════════════════════════════════
     * 右侧栏承载（R7）：tab 类型注册 + 打开入口 + 优雅降级
     *
     * 三条纪律：
     *   1. `slots` + `locale` 仍是**唯一硬依赖**；`sidebarRightTabs` / `sidebarRight`
     *      一律走延迟/可选获取，缺席时面板照旧可用（就地浮层）。
     *   2. 任何一步（注册表、座位注册、openTab）抛错都**被吸收**并报告为"不可用"，
     *      绝不把浏览器带下去，也绝不让控件变成死按钮。
     *   3. 两个座位共用**同一个 key**（= 类型定义的 id）：宿主按 id 分派正文与标题。
     * ══════════════════════════════════════════════════════════════════════ */

    /** 右侧栏服务面：拿不到（老宿主 / headless / 服务被撤下 / face 不完整）时返回 null，绝不抛错。 */
    function sidebarFaceOf(ctx) {
      try {
        if (ctx === null || ctx === undefined || typeof ctx.get !== 'function') return null
        var face = ctx.get(SIDEBAR_SERVICE)
        if (face === null || face === undefined) return null
        return typeof face.openTab === 'function' ? face : null
      } catch (error) {
        return null
      }
    }

    /**
     * 让右侧栏在**同一步**展开账本页；失败返回 false（调用方据此回退到就地浮层）：
     * 无服务 / kind 没有注册的类型（`openTab` 会抛）/ 没有在屏会话（控制器会抛）。
     * 每次点击都重新取面：服务可能在 HMR 前后落座或被撤下。
     */
    function openLedgerTab(ctx) {
      var face = sidebarFaceOf(ctx)
      if (face === null) return false
      try {
        face.openTab.call(face, LEDGER_TAB_KIND)
        return true
      } catch (error) {
        return false
      }
    }

    /**
     * 注册 tab 类型 + 正文座位 + 标题座位——**只在宿主提供 `sidebarRightTabs` 时**。
     *
     * 用 `ctx.inject([...], cb)`（延迟注入的子插件）：服务缺席时回调永不执行，本插件也不等待它，
     * 于是老宿主 / headless 自然走"没有右侧栏"的分支（硬依赖仍只有 `slots` + `locale`）。
     * 注册全程 fail-soft：任何一步抛错都回滚已注册的部分，并让本次注册退化为"没有 tab"。
     *
     * @param {object} ctx - 客户端根 context
     * @param {(key: string, params?: object) => string} t - 绑定本命名空间的翻译（词典同源）
     * @returns {object|null} 子插件 fiber（测试与 HMR 用）；不可用时 null
     */
    function registerSidebarTab(ctx, t) {
      if (ctx === null || ctx === undefined || typeof ctx.inject !== 'function') return null
      try {
        return ctx.inject([SIDEBAR_TABS_SERVICE], function (native) {
          var disposers = []
          function own(result) { if (typeof result === 'function') disposers.push(result) }
          function disposeAll() {
            for (var index = disposers.length - 1; index >= 0; index--) {
              try { disposers[index]() } catch (error) { /* 卸载失败不致命 */ }
            }
            disposers.length = 0
          }
          try {
            /* 结构再证明一次：异版本 / 外来注册表（或没有 register）走"没有 tab"分支。 */
            var tabs = typeof native.get === 'function' ? native.get(SIDEBAR_TABS_SERVICE) : null
            if (tabs === null || tabs === undefined || typeof tabs.register !== 'function') return undefined
            own(tabs.register({
              id: LEDGER_TAB_ID,
              kind: LEDGER_TAB_KIND,
              /* 页类型：不申报 patterns（按 kind 打开，不认领资源地址）；priority 省略 = extension 带。 */
              title: function () { return t('cl.title') },
            }))
            LEDGER_TAB_SEATS.forEach(function (seat) {
              own(native.slots.inject(seat, function () {
                return native.slots.register({
                  name: seat,
                  /* 关键：正文与标题两个座位共用同一个 key = 类型定义的 id。 */
                  key: LEDGER_TAB_ID,
                  locale: NS,
                }, seat === LEDGER_TAB_SEATS[0] ? LedgerTab : LedgerTabTitle)
              }))
            })
          } catch (error) {
            disposeAll()
            return undefined
          }
          return disposeAll
        })
      } catch (error) {
        return null
      }
    }

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en })
      }, 'context-ledger: dictionaries')

      /* 绑定本命名空间的翻译：注册表的 title thunk 与栏内组件共用同一份词典。 */
      var t = ctx !== null && ctx !== undefined && ctx.locale !== null && ctx.locale !== undefined
        && typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : fallbackT

      ctx.slots.inject('conversation.input.right', function () {
        return ctx.slots.register({
          name: 'conversation.input.right',
          id: 'context-ledger',
          order: 21,
          locale: NS,
          /* 把"开右侧栏"的入口注入给控件：点它先开栏，拿不到才就地展开浮层。 */
          inject: function () {
            return { openLedgerTab: function () { return openLedgerTab(ctx) } }
          },
        }, LedgerRing)
      })

      /* 右侧栏 tab 类型（正文 + 标题座位）：宿主没有该注册表时回调永不执行（优雅降级的关键）。 */
      registerSidebarTab(ctx, t)
    }

    var plugin = { name: 'context-ledger', inject: ['slots', 'locale'], apply: apply }

    /**
     * 核验缝（**只读**，不参与装配、不被框架读取）：把纯展示映射与词典原样暴露，
     * 让无浏览器的核验线可以直接断言 DATA→展示 的映射（状态三分、占比、折叠、总览降级保护、
     * 词典同键），而不必启动 web shell。用 defineProperty 保持不可枚举，
     * 保证 cordis loader 看到的插件导出与手工声明的三键完全一致。
     */
    Object.defineProperty(plugin, '__verify', {
      enumerable: false,
      value: {
        NS: NS,
        API: LEDGER_API,
        DETAIL_LIMIT: DETAIL_LIMIT,
        CATEGORY_ORDER: CATEGORY_ORDER,
        dictionaries: { zh: zh, en: en },
        itemState: itemState,
        chipColor: chipColor,
        shareOf: shareOf,
        categoryRows: categoryRows,
        itemsOfCategory: itemsOfCategory,
        foldRows: foldRows,
        overview: overview,
        evidence: evidence,
        shortPath: shortPath,
        formatInt: formatInt,
        fallbackT: fallbackT,
        fillTemplate: fillTemplate,
        variantText: variantText,
        /* v2：R1 呈现所需的纯映射（核验线直接断言，不必启动 web shell） */
        PRUNE_REPRESENTATIVE_NAMES: PRUNE_REPRESENTATIVE_NAMES,
        itemIndex: itemIndex,
        pruneEntries: pruneEntries,
        pruneUnitText: pruneUnitText,
        pruneNamesText: pruneNamesText,
        pruneReclaimText: pruneReclaimText,
        usedToolsText: usedToolsText,
        pruneFactText: pruneFactText,
        isLowConfidence: isLowConfidence,
        attributionText: attributionText,
        evidenceText: evidenceText,
        attributionNotes: attributionNotes,
        noRecommendationRows: noRecommendationRows,
        providerScanCapped: providerScanCapped,
        /* v3：R6 呈现所需的纯映射（核验线直接断言，不必启动 web shell） */
        HIDE_CAVEAT_KEYS: HIDE_CAVEAT_KEYS,
        HIDE_REASONS: HIDE_REASONS,
        HIDE_PRECHECK_STATUSES: HIDE_PRECHECK_STATUSES,
        HIDE_APPLY_MODES: HIDE_APPLY_MODES,
        hideEntries: hideEntries,
        hideUnits: hideUnits,
        hideApplyOf: hideApplyOf,
        hideStatusOf: hideStatusOf,
        hideCaveats: hideCaveats,
        unitKindText: unitKindText,
        unitLabelText: unitLabelText,
        unitFactText: unitFactText,
        verdictLabel: verdictLabel,
        registryUseText: registryUseText,
        precheckText: precheckText,
        referencedPaths: referencedPaths,
        denyListText: denyListText,
        showCopyButton: showCopyButton,
        applyModeText: applyModeText,
        restoreLines: restoreLines,
        unitKeyOf: unitKeyOf,
        parallelRows: parallelRows,
        copyToClipboard: copyToClipboard,
        /* v4：R8 呈现所需的纯映射（核验线直接断言，不必启动 web shell） */
        PRESENCE_VALUES: PRESENCE_VALUES,
        PRESENCE_TONE: PRESENCE_TONE,
        presenceColor: presenceColor,
        presenceOf: presenceOf,
        presenceBadge: presenceBadge,
        presenceLine: presenceLine,
        windowScopeOf: windowScopeOf,
        currentSessionOf: currentSessionOf,
        currentSessionSummary: currentSessionSummary,
        currentSessionNode: currentSessionNode,
        windowScopeNodes: windowScopeNodes,
        panelScope: panelScope,
        findingSource: findingSource,
        ledgerRow: ledgerRow,
        FONT_SIZES: FS,
        FONT_LINE_HEIGHTS: LH,
        /* v3.1/R7：右侧栏承载（类型身份、座位、打开入口、降级判定） */
        LEDGER_TAB_ID: LEDGER_TAB_ID,
        LEDGER_TAB_KIND: LEDGER_TAB_KIND,
        LEDGER_TAB_SEATS: LEDGER_TAB_SEATS,
        SIDEBAR_SERVICE: SIDEBAR_SERVICE,
        SIDEBAR_TABS_SERVICE: SIDEBAR_TABS_SERVICE,
        sidebarFaceOf: sidebarFaceOf,
        openLedgerTab: openLedgerTab,
        registerSidebarTab: registerSidebarTab,
        LedgerTab: LedgerTab,
        LedgerTabTitle: LedgerTabTitle,
        LedgerPanel: LedgerPanel,
        LedgerRing: LedgerRing,
        PruneBlock: PruneBlock,
        NoRecommendationBlock: NoRecommendationBlock,
        HidePlanBlock: HidePlanBlock,
        HideRestoreBlock: HideRestoreBlock,
        ParallelBlock: ParallelBlock,
        PanelBoundary: PanelBoundary,
      },
    })

    return plugin
  },
})
