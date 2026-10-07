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
      'cl.zeroCallTitle': '零调用 · 贵且没用',
      'cl.zeroCallHint': '观测窗口内一次都没被调用，但每个请求都在付这份 token',
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
      'cl.privacyNote': '仅回放工具名与调用次数，不含任何正文',
      'cl.rejectedWarning': '有 {n} 条调用名未通过名字护栏，已丢弃',
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
      'cl.zeroCallTitle': 'never called · cost without use',
      'cl.zeroCallHint': 'not called once in the window, yet every request pays its tokens',
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
      'cl.privacyNote': 'replays tool names and call counts only — never message content',
      'cl.rejectedWarning': '{n} call names failed the name guard and were dropped',
    }

    /**
     * 兜底翻译：只有 locale 座位缺席时才会走到这里（正常装配下 `t` 由宿主的 locale 座位注入）。
     * 它让面板在任何组合下都可渲染，且不改变文案来源（用的仍是上面两份词典）。
     */
    function fallbackT(key, params) {
      var text = en[key]
      if (text === undefined) return key
      if (params === undefined) return text
      return text.replace(/\{(\w+)\}/g, function (match, name) {
        return params[name] === undefined ? match : String(params[name])
      })
    }

    /* ══════════════════════════════════════════════════════════════════════
     * 常量（DESIGN §2.8 / §4）
     * ══════════════════════════════════════════════════════════════════════ */

    /** 宿主同源路由（DESIGN §4.1）：→ { ok: boolean, report: canonical JSON }。 */
    var LEDGER_API = '/api/context-ledger/ledger'
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
     * 样式（内联；bundle 不注入 CSS 文件、不写 style 标签，保持零副作用）
     * ══════════════════════════════════════════════════════════════════════ */

    var dockStyle = { display: 'inline-flex', alignItems: 'center', position: 'relative' }
    var triggerStyle = {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 30, height: 30, padding: 0, background: 'transparent',
      border: '1px solid ' + TONE.border, borderRadius: 7, cursor: 'pointer', font: 'inherit',
    }
    var panelStyle = {
      position: 'absolute', zIndex: 1000, right: 0, bottom: 'calc(100% + 12px)',
      width: 468, maxWidth: 'calc(100vw - 24px)', maxHeight: 'min(72vh, 640px)',
      overflowX: 'hidden', overflowY: 'auto', color: TONE.text,
      background: TONE.canvas, border: '1px solid ' + TONE.borderStrong, borderRadius: 12,
      boxShadow: '0 2px 6px rgba(0, 0, 0, .18), 0 20px 46px rgba(0, 0, 0, .3)',
      textAlign: 'left', font: 'inherit',
    }
    var headStyle = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, padding: '13px 15px 0' }
    var titleStyle = { display: 'block', color: TONE.text, fontSize: 13, fontWeight: 600 }
    var subtitleStyle = { display: 'block', marginTop: 2, color: TONE.quiet, fontSize: 11 }
    var headerMetaStyle = { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, color: TONE.quiet, fontSize: 10.5, fontVariantNumeric: 'tabular-nums' }
    var refreshStyle = {
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: 0, color: TONE.blue,
      background: 'transparent', border: 0, cursor: 'pointer', font: 'inherit', fontSize: 12, fontWeight: 500,
    }
    var noticeStyle = {
      display: 'flex', alignItems: 'flex-start', gap: 8, margin: '11px 15px 0', padding: '8px 10px',
      color: TONE.red, background: TONE.raised, border: '1px solid ' + TONE.border, borderRadius: 8,
      fontSize: 11.5, lineHeight: 1.45,
    }
    var errorStyle = { margin: '11px 15px 0', color: TONE.red, fontSize: 11.5, lineHeight: 1.45 }
    var emptyStyle = { margin: '0 15px', padding: '18px 0', color: TONE.muted, fontSize: 11.5, textAlign: 'center' }

    var statsStyle = { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 1, margin: '12px 15px 0', background: TONE.border, border: '1px solid ' + TONE.border, borderRadius: 9, overflow: 'hidden' }
    var statStyle = { display: 'flex', flexDirection: 'column', gap: 3, padding: '9px 10px', background: TONE.canvas, minWidth: 0 }
    var statLabelStyle = { color: TONE.quiet, fontSize: 10.5 }
    var statValueStyle = { display: 'flex', alignItems: 'baseline', gap: 5, minWidth: 0 }
    var statNumberStyle = { fontFamily: MONO, fontSize: 20, fontWeight: 500, letterSpacing: '-0.03em', lineHeight: 1.05, fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis' }
    var statUnitStyle = { color: TONE.muted, fontSize: 10.5 }
    var statSubStyle = { color: TONE.quiet, fontSize: 10.5, lineHeight: 1.4 }

    var blockStyle = { margin: '14px 15px 0' }
    var blockHeadStyle = { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }
    var blockTitleStyle = { color: TONE.text, fontSize: 12, fontWeight: 600 }
    var blockHintStyle = { color: TONE.quiet, fontSize: 10.5 }
    var GRID = 'minmax(0, 1fr) 74px 76px 88px'
    var columnHeadStyle = { display: 'grid', gridTemplateColumns: GRID, columnGap: 8, padding: '6px 0 3px', borderBottom: '1px solid ' + TONE.border }
    var columnLabelStyle = { color: TONE.quiet, fontSize: 10, textAlign: 'right' }
    var rowStyle = { display: 'grid', gridTemplateColumns: GRID, columnGap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid ' + TONE.border }
    var nameCellStyle = { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }
    var badgeStyle = { flex: '0 0 auto', padding: '1px 5px', borderRadius: 4, background: TONE.raised, color: TONE.muted, fontSize: 9.5, whiteSpace: 'nowrap' }
    var itemNameStyle = { overflow: 'hidden', color: TONE.text, fontSize: 11.5, textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
    var figureStyle = { color: TONE.text, fontFamily: MONO, fontSize: 11.5, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
    /* 未知值渲染成中性灰徽标（DESIGN §4.4：不是零调用样式，也不是数字）。 */
    var unknownFigureStyle = { justifySelf: 'end', padding: '1px 6px', border: '1px solid currentColor', borderRadius: 999, fontSize: 10, whiteSpace: 'nowrap', color: TONE.quiet }
    var catHeadStyle = { display: 'grid', gridTemplateColumns: '12px minmax(0, 1fr) 92px 44px', columnGap: 9, alignItems: 'center', width: '100%', padding: '8px 0', color: TONE.text, background: 'transparent', border: 0, borderBottom: '1px solid ' + TONE.border, textAlign: 'left', font: 'inherit' }
    var catNameStyle = { display: 'block', overflow: 'hidden', fontSize: 12, fontWeight: 500, textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
    var barTrackStyle = { display: 'block', height: 4, marginTop: 5, background: TONE.sunk, borderRadius: 2, overflow: 'hidden' }
    var catValueStyle = { fontFamily: MONO, fontSize: 11.5, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
    var catShareStyle = { justifySelf: 'end', color: TONE.muted, fontFamily: MONO, fontSize: 10.5, fontVariantNumeric: 'tabular-nums' }
    var catNoteStyle = { padding: '0 0 6px 21px', color: TONE.quiet, fontSize: 10.5, lineHeight: 1.5 }
    var detailStyle = { background: TONE.raised, borderBottom: '1px solid ' + TONE.border }
    var detailPadStyle = { padding: '0 10px' }
    var moreStyle = { padding: '6px 10px 0', color: TONE.quiet, fontSize: 10.5, fontFamily: MONO }
    var footerStyle = { display: 'flex', flexDirection: 'column', gap: 4, padding: '11px 15px 12px' }
    var evidenceStyle = { color: TONE.quiet, fontFamily: MONO, fontSize: 10, lineHeight: 1.5, wordBreak: 'break-all' }
    var warningStyle = { color: TONE.amber, fontSize: 10.5, lineHeight: 1.5 }
    var privacyStyle = { color: TONE.quiet, fontSize: 10.5, lineHeight: 1.5 }

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

    /** 数值格：有数 → 数字；null / 非有限 → cl.unknown（**绝不** 0）。 */
    function figure(value, t) {
      if (isNum(value)) return h('span', { key: 'figure', style: figureStyle }, formatInt(value))
      return h('span', { key: 'figure', style: unknownFigureStyle }, t('cl.unknown'))
    }

    /** 次数格：零调用 → neverCalled 徽标；未知 → unknown；正数 → 数字。 */
    function callsCell(item, t) {
      var state = itemState(item)
      if (state === 'zero') {
        return h('span', {
          key: 'calls',
          'data-cl-state': 'zero',
          style: { justifySelf: 'end', padding: '1px 6px', border: '1px solid currentColor', borderRadius: 999, fontSize: 10, whiteSpace: 'nowrap', color: chipColor('zero') },
        }, t('cl.neverCalled'))
      }
      return figure(item.calls, t)
    }

    /** 一行账目：名字 + 分类徽标 + 成本 + 次数 + 每次使用成本。 */
    function ledgerRow(item, t) {
      var state = itemState(item)
      return h('div', {
        key: String(item.id === undefined ? item.name : item.id),
        'data-cl-row': item.category,
        'data-cl-state': state,
        style: rowStyle,
      }, [
        h('div', { key: 'name', style: nameCellStyle }, [
          categoryBadge(item.category, t),
          h('span', {
            key: 'label',
            style: itemNameStyle,
            title: item.category === 'instructions' ? item.name : undefined,
          }, item.category === 'instructions' ? shortPath(item.name) : item.name),
        ]),
        figure(item.tokens, t),
        callsCell(item, t),
        figure(item.tokensPerCall, t),
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

    /** 清单块：标题 + 提示 + 列头 + 行；空清单显示 cl.empty（**不**包装成「健康」之类结论）。 */
    function listBlock(options) {
      var t = options.t
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
      var expandedState = useState(null)
      var expanded = expandedState[0]
      var setExpanded = expandedState[1]

      var rows = useMemo(function () { return categoryRows(report) }, [report])
      var stats = useMemo(function () { return overview(report, t) }, [report, t])
      var zeroCall = useMemo(function () { return findingRows(report, 'zeroCall') }, [report])
      var topPerUse = useMemo(function () { return findingRows(report, 'topPerUse') }, [report])
      var scope = useMemo(function () { return evidence(report) }, [report])
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
          listBlock({
            id: 'zero-call',
            t: t,
            title: t('cl.zeroCallTitle'),
            hint: t('cl.zeroCallHint'),
            rows: degraded ? [] : zeroCall,
            renderRow: function (item) {
              return ledgerRow({
                id: item.id, category: item.category, name: item.name,
                tokens: item.tokens, calls: 0, tokensPerCall: null, zeroCall: true,
              }, t)
            },
          }),
          listBlock({
            id: 'top-per-use',
            t: t,
            title: t('cl.topPerUseTitle'),
            hint: t('cl.topPerUseHint'),
            rows: degraded ? [] : topPerUse,
            renderRow: function (item) {
              return ledgerRow({
                id: item.id, category: item.category, name: item.name,
                tokens: item.tokens, calls: item.calls, tokensPerCall: item.tokensPerCall,
                zeroCall: false, usageBasis: 'tool-calls',
              }, t)
            },
          }),
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
                      fold.shown.map(function (item) { return ledgerRow(item, t) }),
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
        role: 'dialog',
        'aria-label': t('cl.title'),
        'data-cl-panel': '',
        style: panelStyle,
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
    function LedgerRing(props) {
      var t = typeof props.t === 'function' ? props.t : fallbackT
      var sessionId = props.sessionId
      var openState = useState(false)
      var open = openState[0]
      var setOpen = openState[1]
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
      var dockRef = useRef(null)
      var panelId = useId()

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

      /*
       * 取数时机（DESIGN §4.1）：**打开时**才拉取（每个 session 只自动拉一次），
       * 之后靠面板里的刷新按钮；关闭面板不丢弃已取到的报告；不在后台轮询。
       */
      useEffect(function () {
        if (!open) return undefined
        if (requestedRef.current === sessionId) return undefined
        requestedRef.current = sessionId
        refresh()
        return undefined
      }, [open, sessionId, refresh])

      /* 卸载即中止在途请求。 */
      useEffect(function () {
        return function () {
          if (controllerRef.current !== null) controllerRef.current.abort()
        }
      }, [])

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

      var hasZeroCall = report !== null && typeof report === 'object'
        && findingRows(report, 'zeroCall').length > 0
      var accent = life === 'error' ? TONE.red : hasZeroCall ? TONE.amber : TONE.muted

      return h('span', { ref: dockRef, 'data-context-ledger': '', style: dockStyle }, [
        h('button', {
          key: 'trigger',
          type: 'button',
          onClick: function () { setOpen(function (value) { return !value }) },
          title: t('cl.hint') + ' · ' + t('cl.title'),
          'aria-label': t('cl.title'),
          'aria-expanded': open,
          'aria-controls': panelId,
          style: Object.assign({}, triggerStyle, { color: accent }),
        }, ScaleIcon(16)),
        open
          ? h(PanelBoundary, { key: 'panel', t: t }, LedgerPanel({
            id: panelId,
            t: t,
            report: report,
            state: life,
            error: error,
            refreshedAt: stamp,
            onRefresh: refresh,
          }))
          : null,
      ])
    }

    /* ══════════════════════════════════════════════════════════════════════
     * cordis 插件面
     * ══════════════════════════════════════════════════════════════════════ */

    /**
     * 注册词典并把控件落到 composer 工具行（list 座位，不复用内置 id）。
     * @param {import('@deepseek-ai/cordis').Context} ctx
     */
    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en })
      }, 'context-ledger: dictionaries')

      ctx.slots.inject('conversation.input.right', function () {
        return ctx.slots.register({
          name: 'conversation.input.right',
          id: 'context-ledger',
          order: 21,
          locale: NS,
        }, LedgerRing)
      })
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
        LedgerPanel: LedgerPanel,
        LedgerRing: LedgerRing,
        PanelBoundary: PanelBoundary,
      },
    })

    return plugin
  },
})
