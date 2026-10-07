/**
 * dsh-context-ledger — **对账核心**：成本 × 使用 → 每次使用成本 + 零调用标记。
 *
 * 纯函数模块：**不得** import 任何 `@deepseek-ai/*` 包（宿主依赖只允许出现在
 * `index.js`）。
 *
 * 本模块是 `calls` / `tokensPerCall` / `zeroCall` / `usageBasis` 的**唯一赋权点**
 * （DESIGN §7）。`lib/cost.js` 只填成本侧字段，次数语义全部在这里落地，避免两条
 * 实现线各写一套。v2 起还负责把 `lib/provide.js` 算出的 `providedBy` 与
 * `findings.prunePlan` / `prunePlanReclaimableTokens` / `noRecommendation`
 * **注入** canonical JSON（§7.2：归属与省额语义的唯一赋权点是 `lib/provide.js`，
 * 本模块只注入与缺省填充，不自行判断归属）。
 *
 * 三件不可协商的事（DESIGN §2.4 / §2.7）：
 *  1. `calls === null` 表示**不可观测 / 无证据**，绝不写成 `0`，绝不进
 *     `findings.zeroCall`，`zeroCall` 恒为 `null`；
 *  2. 零调用必须由证据支撑：只有 `usageBasis === "tool-calls"` 且命中次数为 0
 *     才能报 `zeroCall: true`；
 *  3. 排序用**未取整**比值，输出字段用 `Math.round`，两者不一致是设计如此。
 *
 * @module lib/reconcile
 */

import { buildHideFindings } from './hide.js'
import { PRUNE_PLAN_BASIS, PROVIDED_BY_KINDS, buildPrunePlan, unknownProvidedBy } from './provide.js'
import { ESTIMATOR } from './tokens.js'
import { isValidToolName, lookupCount, projectKey } from './usage.js'

/** `context_ledger` 工具标识（DESIGN §2.1，常量）。 */
export const LEDGER_TOOL = 'context_ledger'
/** canonical 形状版本（DESIGN §2.1，常量；v3 新增必需字段，故 2 → 3）。 */
export const LEDGER_VERSION = 3
/** 所有 token 数值的单位（DESIGN §2.1，常量）。 */
export const LEDGER_UNIT = 'token'

/** 四类注入物，**顺序恒为**此顺序（DESIGN §2.3）。 */
export const CATEGORY_KEYS = Object.freeze(['instructions', 'skills', 'tools', 'mcp'])

/** 逐项次数可观测的分类（DESIGN §2.3：方法与证据是两件事）。 */
const OBSERVABLE_CATEGORIES = new Set(['tools', 'mcp'])

/** `findings.*` 数组上限（DESIGN §2.8）。 */
export const FINDINGS_LIMIT = 10
/** `scope.callsUnmatchedNames` 上限（DESIGN §2.8）。 */
export const UNMATCHED_NAMES_LIMIT = 20

/** `usageBasis` 全集（DESIGN §2.4，4 个值，冻结）。 */
export const USAGE_BASIS = Object.freeze({
  TOOL_CALLS: 'tool-calls',
  NO_EVIDENCE: 'no-evidence',
  UNOBSERVABLE: 'unobservable',
  ALWAYS_ON: 'always-on',
})

/** `items[]` 的 canonical 字段顺序（DESIGN §2.4；顺序本身也是契约的一部分）。 */
const ITEM_FIELD_ORDER = Object.freeze([
  'id', 'category', 'name', 'tokens', 'calls', 'tokensPerCall', 'zeroCall', 'usageBasis',
  'source', 'server', 'bytes', 'provider', 'loadOrder', 'providedBy',
])

/**
 * 非负整数化。
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
function toCount(value, fallback = 0) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.round(n)
}

/**
 * `calls / tokens` 折算：`calls` 为 null 或 0 时无意义。
 * @param {number} tokens
 * @param {number | null} calls
 * @returns {number | null}
 */
function perCall(tokens, calls) {
  if (calls === null || calls === 0) return null
  return Math.round(tokens / calls)
}

/**
 * 解析一项的「观测调用次数」。
 *
 * **唯一通道**（DESIGN §7.1 规则 1，F2 的结论）：只认顶层 `callsByName`。
 * v1 曾额外容忍的 `scope.callsByName` / `item.observedCalls` / `item.calls`
 * **一律不再接受**——传入的 `items[].calls` 会被本模块忽略并覆盖，不参与任何计算。
 *
 * @param {Record<string, unknown>} raw
 * @param {Record<string, number>} callsByName
 * @returns {number | undefined} `undefined` = 没有任何信号
 */
function observedCountOf(raw, callsByName) {
  const name = typeof raw.name === 'string' ? raw.name : ''
  return lookupCount(callsByName, name)
}

/**
 * 归属对象是否成形（kind 必须是 4 个冻结值之一）。成形才注入，否则退化为 unknown。
 * @param {unknown} value
 * @returns {boolean}
 */
function isProvidedBy(value) {
  return value !== null && typeof value === 'object'
    && typeof value.kind === 'string'
    && PROVIDED_BY_KINDS.includes(value.kind)
}

/**
 * 构造一个 canonical `items[]` 记录：只保留契约字段，且按契约字段顺序排。
 *
 * `observedCalls` 等输入期辅助字段在此被丢弃——产物里不允许出现契约外字段。
 * @param {Record<string, unknown>} input
 * @returns {Record<string, unknown>}
 */
function canonicalItem(input) {
  const out = {}
  for (const key of ITEM_FIELD_ORDER) {
    const value = input[key]
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * §2.7 的项排序。
 *
 * rank 0：零调用（`tokens` 降序 → `id` 升序）
 * rank 1：有次数（**未取整** `tokens/calls` 降序 → `tokens` 降序 → `id` 升序）
 * rank 2：次数未知（`tokens` 降序 → `id` 升序）
 *
 * 三个分支都以 `id` 兜底，因此比较器是全序，同一输入输出字节级稳定。
 * @param {Record<string, unknown>} a
 * @param {Record<string, unknown>} b
 * @returns {number}
 */
function compareItems(a, b) {
  const rank = (item) => {
    if (item.zeroCall === true) return 0
    if (item.calls !== null) return 1
    return 2
  }
  const rankA = rank(a)
  const rankB = rank(b)
  if (rankA !== rankB) return rankA - rankB
  if (rankA === 1) {
    const ratioA = a.tokens / a.calls
    const ratioB = b.tokens / b.calls
    if (ratioA !== ratioB) return ratioB - ratioA
  }
  if (a.tokens !== b.tokens) return b.tokens - a.tokens
  return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)
}

/**
 * `findings.zeroCall` 的顺序：`tokens` 降序 → `id` 升序（DESIGN §2.5）。
 */
function compareZeroCall(a, b) {
  if (a.tokens !== b.tokens) return b.tokens - a.tokens
  return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)
}

/**
 * `findings.topPerUse` 的顺序：未取整比值降序 → `tokens` 降序 → `id` 升序。
 */
function compareTopPerUse(a, b) {
  const ratioA = a.tokens / a.calls
  const ratioB = b.tokens / b.calls
  if (ratioA !== ratioB) return ratioB - ratioA
  if (a.tokens !== b.tokens) return b.tokens - a.tokens
  return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)
}

/**
 * 合成一份 canonical 账本（DESIGN §2.1）。
 *
 * @param {{
 *   cwd: string,
 *   sessionsRoot?: string,
 *   scope: Record<string, unknown>,
 *   items: Array<Record<string, unknown>>,
 *   callsByName?: Record<string, number>,
 *   provenance?: { byName?: Record<string, object>, bundleOwners?: Record<string, object>,
 *     weakEvidence?: Record<string, string[]> },
 *   hide?: { status?: string, restrictableNames?: string[]|null, mode?: string,
 *     interfacePresent?: boolean, appliedNames?: string[] },
 *   findingsLimit?: number,
 * }} input
 *   `scope` = §2.2 的观测范围字段（**不含** `usageAvailable`；它由本函数按
 *   「`sessionsScanned >= 1`」判定）。`callsByName` 是**唯一**的调用次数通道
 *   （§7.1 规则 1）。`provenance` 是**唯一**的归属通道：`byName` 为
 *   {@link import('./provide.js').attributeNames} 的结果，`bundleOwners` 为
 *   事实包 → 卸载单元的解析结果；缺省 = 全部 `unknown` / 无动作（**不猜**）。
 *   `provenance.weakEvidence`（v3 新增，可选）为 R1 弱扫描得到的"别处引用过该名字"的文件路径，
 *   供 R6 的 `registryUse.nameReferencedElsewhere` 使用（≤3，升序）。
 *   `hide`（**v3 新增通道**）是宿主对 restrict 接口的探测结果与 opt-in 施加状态；
 *   缺省 = `unsupported` + `suggestion-only` + `appliedNames: []`（即"不施加、只建议"，§2.23.3/§2.23.4）。
 * @returns {Record<string, unknown>} canonical `context_ledger` 报告
 */
export function reconcile(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const scopeIn = (source.scope !== null && typeof source.scope === 'object') ? source.scope : {}
  const provenance = (source.provenance !== null && typeof source.provenance === 'object') ? source.provenance : {}
  const providedByName = (provenance.byName !== null && typeof provenance.byName === 'object') ? provenance.byName : {}
  const bundleOwners = (provenance.bundleOwners !== null && typeof provenance.bundleOwners === 'object')
    ? provenance.bundleOwners
    : {}
  const weakEvidence = (provenance.weakEvidence !== null && typeof provenance.weakEvidence === 'object')
    ? provenance.weakEvidence
    : {}
  const hideInput = (source.hide !== null && typeof source.hide === 'object') ? source.hide : {}
  // §7.1 规则 1/3：调用次数只有这一个入口；缺省 = {}（**不猜**）。
  const callsByName = (source.callsByName !== null && typeof source.callsByName === 'object')
    ? source.callsByName
    : {}
  const cwd = typeof source.cwd === 'string' ? source.cwd : ''
  const findingsLimit = toCount(source.findingsLimit ?? FINDINGS_LIMIT, FINDINGS_LIMIT)
  const sessionsScanned = toCount(scopeIn.sessionsScanned)
  // 证据位：至少一个日志被成功回放即 true。**不要求**观测到任何 tool/call——
  // 该窗口内「真的一次都没调用」是合法结论，必须能报成零调用（DESIGN §2.2）。
  const usageAvailable = sessionsScanned >= 1

  let namesRejected = toCount(scopeIn.namesRejected)
  /** @type {Map<string, Array<Record<string, unknown>>>} */
  const byCategory = new Map(CATEGORY_KEYS.map(key => [key, []]))
  /** @type {Record<string, unknown>[]} */
  const items = []
  /** 已经归因到某个可观测账目项的名字（用于算 `callsUnmatched`）。 */
  const matchedNames = new Set()
  let matchedCalls = 0

  const rawItems = Array.isArray(source.items) ? source.items : []
  for (const raw of rawItems) {
    if (raw === null || typeof raw !== 'object') continue
    const category = typeof raw.category === 'string' ? raw.category : ''
    if (!CATEGORY_KEYS.includes(category)) {
      // 四类之外没有合法表示（categories 恒 4 条）。宁可显式失败，也不静默漏报。
      throw new Error(`reconcile: unknown category "${category}"`)
    }
    const name = typeof raw.name === 'string' ? raw.name : ''
    const tokens = toCount(raw.tokens)
    const observed = observedCountOf(raw, callsByName)

    /** @type {string} */
    let usageBasis
    /** @type {number | null} */
    let calls
    /** @type {boolean | null} */
    let zeroCall

    // 赋值优先级（DESIGN §2.4，互斥，按此顺序判定）。
    if (category === 'instructions') {
      usageBasis = USAGE_BASIS.ALWAYS_ON
      calls = null
      zeroCall = null
    } else if (category === 'skills') {
      usageBasis = USAGE_BASIS.UNOBSERVABLE
      calls = null
      zeroCall = null
    } else if (!isValidToolName(name)) {
      // 常驻项名字没过护栏：降级为不可观测 + 累加告警位。
      // 这条规则保证永远不会出现「因为名字被丢掉而误判零调用」（DESIGN §3.3）。
      usageBasis = USAGE_BASIS.UNOBSERVABLE
      calls = null
      zeroCall = null
      namesRejected += 1
    } else if (!usageAvailable) {
      usageBasis = USAGE_BASIS.NO_EVIDENCE
      calls = null
      zeroCall = null
    } else {
      usageBasis = USAGE_BASIS.TOOL_CALLS
      calls = observed ?? 0
      zeroCall = calls === 0
      matchedCalls += calls
      matchedNames.add(name)
    }

    // `providedBy` 只出现在 tools / mcp 项上（§2.13 硬规则 4）；缺省 = 全部 unknown。
    const providedBy = (category === 'tools' || category === 'mcp')
      ? (isProvidedBy(providedByName[name]) ? providedByName[name] : unknownProvidedBy())
      : undefined

    const item = canonicalItem({
      // `id` 由本模块从 `category` + `name` **推导**（§2.4 冻结形态），
      // 不采信调用方传入的 id：否则契约外的自由文本会从 id 位置漏进产物。
      id: `${category}:${name}`,
      category,
      name,
      tokens,
      calls,
      tokensPerCall: perCall(tokens, calls),
      zeroCall,
      usageBasis,
      source: raw.source,
      server: raw.server,
      bytes: Number.isFinite(raw.bytes) ? toCount(raw.bytes) : undefined,
      provider: raw.provider,
      loadOrder: Number.isFinite(raw.loadOrder) ? Math.max(1, Math.round(Number(raw.loadOrder))) : undefined,
      providedBy,
    })
    items.push(item)
    byCategory.get(category)?.push(item)
  }

  // ── scope.counts：单一真理在计数表上 ──
  // §2.2 声明 `toolCalls = Σ items[].calls(非空) + callsUnmatched + namesRejected`，
  // 因此这里按该恒等式**构造** toolCalls（而不是信任调用方另报一个数），
  // 恒等式因此机械成立；正常通路下它与回放行数逐位相等。
  // `callsUnmatched` / `skillToolCalls` 是 §2.2 的输入字段：调用方给了就采信，
  // 没给就从计数表现算（两条路径都不会让 `calls` 变成 0）。
  /** @type {number} */
  let callsUnmatched
  /** @type {string[]} */
  let callsUnmatchedNames
  let skillToolCalls
  if (Number.isFinite(scopeIn.callsUnmatched)) {
    callsUnmatched = toCount(scopeIn.callsUnmatched)
    callsUnmatchedNames = Array.isArray(scopeIn.callsUnmatchedNames)
      ? scopeIn.callsUnmatchedNames.filter(name => typeof name === 'string').slice(0, UNMATCHED_NAMES_LIMIT)
      : []
  } else {
    let accepted = 0
    const unmatched = []
    for (const key of Object.keys(callsByName).sort()) {
      const count = Number.isFinite(callsByName[key]) ? callsByName[key] : 0
      accepted += count
      if (!matchedNames.has(key)) unmatched.push(key)
    }
    callsUnmatched = Math.max(0, accepted - matchedCalls)
    callsUnmatchedNames = unmatched.slice(0, UNMATCHED_NAMES_LIMIT)
  }
  if (Number.isFinite(scopeIn.skillToolCalls)) {
    skillToolCalls = toCount(scopeIn.skillToolCalls)
  } else {
    skillToolCalls = toCount(lookupCount(callsByName, 'skill'))
  }

  const scope = {
    workspaceKey: typeof scopeIn.workspaceKey === 'string' && scopeIn.workspaceKey !== ''
      ? scopeIn.workspaceKey
      : projectKey(cwd),
    sessionsRoot: typeof source.sessionsRoot === 'string'
      ? source.sessionsRoot
      : (typeof scopeIn.sessionsRoot === 'string' ? scopeIn.sessionsRoot : ''),
    sessionsAvailable: toCount(scopeIn.sessionsAvailable),
    sessionsScanned,
    sessionsUnreadable: toCount(scopeIn.sessionsUnreadable),
    sessionsLimit: toCount(scopeIn.sessionsLimit),
    windowStart: typeof scopeIn.windowStart === 'string' ? scopeIn.windowStart : null,
    windowEnd: typeof scopeIn.windowEnd === 'string' ? scopeIn.windowEnd : null,
    linesRead: toCount(scopeIn.linesRead),
    // `scope` 计数器以**输入即事实**为准（§7.1 规则 4）：宿主给了就照抄，
    // 缺省时才用本模块的账目现算（两路在宿主通路上逐位相等，见 §2.6 恒等式 5）。
    toolCalls: Number.isFinite(scopeIn.toolCalls)
      ? toCount(scopeIn.toolCalls)
      : (matchedCalls + callsUnmatched + namesRejected),
    skillToolCalls,
    callsUnmatched,
    callsUnmatchedNames,
    namesRejected,
    usageAvailable,
    truncated: scopeIn.truncated === true,
    // v2：归属扫描自身的足迹（由宿主扫描时统计后传入）；缺省 = 没扫过。
    providerScan: {
      packages: toCount(scopeIn.providerScan?.packages),
      files: toCount(scopeIn.providerScan?.files),
      bytes: toCount(scopeIn.providerScan?.bytes),
      capped: scopeIn.providerScan?.capped === true,
    },
  }

  // ── categories：恒 4 条、顺序固定（DESIGN §2.3） ──
  const categories = CATEGORY_KEYS.map((key) => {
    const group = byCategory.get(key) ?? []
    const tokens = group.reduce((sum, item) => sum + item.tokens, 0)
    const calls = group.length > 0 && group.every(item => item.calls !== null)
      ? group.reduce((sum, item) => sum + (item.calls ?? 0), 0)
      : null
    // 机制级量只属于 skills：技能名在 skill 工具的**参数**里，隐私红线禁止读参数，
    // 所以逐技能次数不可观测；「整目录成本 ÷ 技能加载次数」是可决策的替代观测。
    const mechanismCalls = key === 'skills' ? skillToolCalls : null
    const mechanismTokensPerCall = (key === 'skills' && mechanismCalls !== null && mechanismCalls > 0)
      ? Math.round(tokens / mechanismCalls)
      : null
    return {
      key,
      itemCount: group.length,
      tokens,
      calls,
      tokensPerCall: perCall(tokens, calls),
      observableUsage: OBSERVABLE_CATEGORIES.has(key),
      mechanismCalls,
      mechanismTokensPerCall,
    }
  })

  // ── 排序（§2.7，全量项的唯一权威顺序） ──
  items.sort(compareItems)

  // ── findings（§2.5：两个直接可消费的事实清单） ──
  const zeroCall = items
    .filter(item => item.zeroCall === true)
    .sort(compareZeroCall)
    .slice(0, findingsLimit)
    .map(item => ({ id: item.id, category: item.category, name: item.name, tokens: item.tokens }))
  const topPerUse = items
    .filter(item => item.calls !== null && item.calls > 0)
    .sort(compareTopPerUse)
    .slice(0, findingsLimit)
    .map(item => ({
      id: item.id,
      category: item.category,
      name: item.name,
      tokens: item.tokens,
      calls: item.calls,
      tokensPerCall: item.tokensPerCall,
    }))

  // ── R1：归属已注入 items，裁剪候选由 lib/provide.js 的唯一赋权点算出 ──
  // 没有调用证据就没有候选：零调用项为空（或全为 null）时这里自然得到空清单与全 0 计数（§2.16 恒等式 6）。
  const { prunePlan, prunePlanReclaimableTokens, noRecommendation } =
    buildPrunePlan(items, providedByName, bundleOwners)

  // ── R6：工具级隐藏候选（纯函数，唯一赋权点 lib/hide.js；本模块只注入，§7.2） ──
  // `inPrunePlan` 需要 prunePlan 的 (kind, target) 集合，故在它之后计算。
  const hideFindings = buildHideFindings(
    items,
    { byName: providedByName, bundleOwners, weakEvidence },
    hideInput,
    { prunePlan },
  )

  // ── totals（§2.6：合计与自洽计数） ──
  let residentTokens = 0
  let observableTokens = 0
  let unknownUsageTokens = 0
  let observedCalls = 0
  let zeroCallItems = 0
  let zeroCallTokens = 0
  let unknownUsageItems = 0
  for (const item of items) {
    residentTokens += item.tokens
    if (item.calls === null) {
      unknownUsageTokens += item.tokens
      unknownUsageItems += 1
    } else {
      observableTokens += item.tokens
      observedCalls += item.calls
    }
    if (item.zeroCall === true) {
      zeroCallItems += 1
      zeroCallTokens += item.tokens
    }
  }
  const totals = {
    residentTokens,
    observableTokens,
    unknownUsageTokens,
    observedCalls,
    observableTokensPerCall: observedCalls > 0 ? Math.round(observableTokens / observedCalls) : null,
    zeroCallItems,
    zeroCallTokens,
    unknownUsageItems,
  }

  return {
    tool: LEDGER_TOOL,
    version: LEDGER_VERSION,
    generatedAt: new Date().toISOString(),
    unit: LEDGER_UNIT,
    estimator: ESTIMATOR,
    cwd,
    scope,
    categories,
    items,
    findings: {
      zeroCall,
      topPerUse,
      prunePlan,
      prunePlanReclaimableTokens,
      prunePlanBasis: PRUNE_PLAN_BASIS,
      noRecommendation,
      // v3（R6）：顺序与 §2.5 的表格逐行一致
      hidePlan: hideFindings.hidePlan,
      hidePlanTokens: hideFindings.hidePlanTokens,
      hidePlanUnits: hideFindings.hidePlanUnits,
      hidePlanBasis: hideFindings.hidePlanBasis,
      hidePlanStatus: hideFindings.hidePlanStatus,
      hideApply: hideFindings.hideApply,
      hidePlanCaveat: hideFindings.hidePlanCaveat,
    },
    totals,
  }
}

/**
 * native 渲染（DESIGN §2.11，冻结格式）。
 *
 * 契约是「**逐行符合模板** + 两个清单按各自上限完整渲染 + R1 段每单元一行」
 * （§2.11 的节选说明：示例只给 3 行零调用 / 2 行 topPerUse，而实际上限是
 * `FINDINGS_LIMIT`）。只允许出现**名字、数字、单位与固定枚举文案**——不放任何
 * 正文派生的内容；措辞遵守 §6 第 10 条（不得把"从未被模型调用"写成"没用"，
 * R1 段标题必须含 "candidates" 与 "NOT uninstall advice"，末行为固定不确定性声明）。
 *
 * @param {Record<string, any>} report - `reconcile()` 的产物
 * @returns {string}
 */
export function renderLedger(report) {
  const totals = report?.totals ?? {}
  const scope = report?.scope ?? {}
  const findings = report?.findings ?? {}
  const categories = Array.isArray(report?.categories) ? report.categories : []
  const perUse = totals.observableTokensPerCall === null || totals.observableTokensPerCall === undefined
    ? 'n/a'
    : String(totals.observableTokensPerCall)

  const lines = [
    `Context ledger: ${totals.residentTokens} tokens resident / ${totals.observedCalls} observed calls`
    + ` across ${scope.sessionsScanned} sessions / ${perUse} tokens per use`,
    `Never called by the model (cost without model use):`
    + ` ${totals.zeroCallItems} ${plural(totals.zeroCallItems, 'item')}, ${totals.zeroCallTokens} tokens`,
  ]
  for (const item of findings.zeroCall ?? []) {
    lines.push(`  - ${item.name} [${item.category}]  ${item.tokens} tokens  0 calls`)
  }
  lines.push('Most expensive per use:')
  for (const item of findings.topPerUse ?? []) {
    lines.push(`  - ${item.name} [${item.category}]  ${item.tokens} tokens  ${item.calls} calls`
      + `  -> ${item.tokensPerCall} tokens/call`)
  }
  const instructions = categories.find(category => category.key === 'instructions')
  const skills = categories.find(category => category.key === 'skills')
  const skillNote = skills !== undefined && skills.mechanismCalls !== null && skills.mechanismCalls > 0
    ? `per-skill unknown; ${skills.mechanismCalls} skill loads, ${skills.mechanismTokensPerCall} tokens/load`
    : 'per-skill unknown'
  lines.push(`Not observable: instructions ${instructions?.tokens ?? 0} tokens (always-on)`
    + ` / skills ${skills?.tokens ?? 0} tokens (${skillNote})`)

  // ── R1 追加段（§2.11 第 4 段；措辞是契约的一部分） ──
  const prunePlan = Array.isArray(findings.prunePlan) ? findings.prunePlan : []
  const reclaimable = Number.isFinite(findings.prunePlanReclaimableTokens)
    ? findings.prunePlanReclaimableTokens
    : 0
  lines.push('Never-called candidates, grouped by removal unit — NOT uninstall advice:'
    + ` ${reclaimable} tokens in ${prunePlan.length} ${plural(prunePlan.length, 'unit')}`)
  for (const entry of prunePlan) {
    // 两个括号组各自成组、与模板里对应形态逐字一致（§2.11 未冻结两者同时出现的写法）
    const notes = []
    if (entry.usedToolCount > 0) {
      notes.push(`(${entry.usedToolCount} other ${plural(entry.usedToolCount, 'tool')} of this unit`
        + ` ${entry.usedToolCount === 1 ? 'is' : 'are'} in use)`)
    }
    if (Array.isArray(entry.factPackages) && entry.factPackages.length > 0) {
      notes.push(`(provides ${entry.factPackages.join(', ')})`)
    }
    lines.push(`  - ${entry.kind} ${entry.target}: ${entry.itemCount} ${plural(entry.itemCount, 'tool')},`
      + ` ${entry.reclaimableTokens} tokens if unused`
      + (notes.length > 0 ? `  ${notes.join('  ')}` : ''))
  }
  const noRecommendation = Array.isArray(findings.noRecommendation) ? findings.noRecommendation : []
  const blockedItems = noRecommendation.reduce((sum, entry) => sum + (entry?.items ?? 0), 0)
  const blockedTokens = noRecommendation.reduce((sum, entry) => sum + (entry?.tokens ?? 0), 0)
  const blockers = noRecommendation
    .filter(entry => entry !== null && typeof entry === 'object' && entry.items > 0)
    .map(entry => `${NO_RECOMMENDATION_LABELS[entry.reason] ?? entry.reason} ${entry.items}`)
  lines.push(`No actionable unit: ${blockedItems} ${plural(blockedItems, 'item')}, ${blockedTokens} tokens`
    + (blockers.length > 0 ? ` (${blockers.join(', ')})` : ''))
  lines.push('A tool can still be used by the UI, by background flows, or rarely but crucially;'
    + ' verify before removing.')

  // ── R6 追加段（v3）：工具级隐藏候选 ──
  // 三条硬要求都在这一段落地：
  //  §2.19 —— `hidePlanCaveat` 五条**必须**在 native 渲染里逐条出现；
  //  §2.22 —— 每个单元一行、两种动作的代价同屏；`inPrunePlan === false` 的单元注明无法通过卸载移除；
  //  §2.22 第 3 条 —— **绝不**把两种动作的 token 相加（下面显式声明它们是互斥替代方案）。
  //  §6 第 11 条 —— 只允许名字、数字、固定枚举与固定措辞，不得出现"安全/零损失/无副作用"这类结论。
  const hidePlan = Array.isArray(findings.hidePlan) ? findings.hidePlan : []
  const hidePlanUnits = Array.isArray(findings.hidePlanUnits) ? findings.hidePlanUnits : []
  const hideApply = (findings.hideApply !== null && typeof findings.hideApply === 'object') ? findings.hideApply : {}
  const hideTokens = Number.isFinite(findings.hidePlanTokens) ? findings.hidePlanTokens : 0
  const hideStatus = typeof findings.hidePlanStatus === 'string' ? findings.hidePlanStatus : 'unsupported'
  const pruneByTarget = new Map((Array.isArray(findings.prunePlan) ? findings.prunePlan : [])
    .map(entry => [`${entry.kind}\u0000${entry.target}`, entry]))
  lines.push(`Hide candidates (tool level) — needs manual confirmation: ${hideTokens} tokens in`
    + ` ${hidePlan.length} ${plural(hidePlan.length, 'tool')} across ${hidePlanUnits.length}`
    + ` ${plural(hidePlanUnits.length, 'unit')} (status: ${hideStatus})`)
  for (const unit of hidePlanUnits) {
    const matched = unit.inPrunePlan === true ? pruneByTarget.get(`${unit.kind}\u0000${unit.target}`) : undefined
    const uninstallClause = matched !== undefined
      ? `uninstall this unit: ${matched.reclaimableTokens} tokens if unused`
        + ` (${matched.usedToolCount} ${plural(matched.usedToolCount, 'tool')} of this unit in use)`
      : 'uninstall is not available for this unit'
    lines.push(`  - ${unit.kind} ${unit.target ?? '(no uninstall unit)'}:`
      + ` hide ${unit.toolCount} ${plural(unit.toolCount, 'tool')}, ${unit.tokens} tokens if hidden`
      + `  |  ${uninstallClause}`)
  }
  if (hidePlan.length === 0) lines.push('  - (no candidates in this window)')
  lines.push('Hide caveats: registry-level hide, not schema-only; non-model registry calls: unobservable;'
    + ' service coupling: unconfirmed; manual confirmation required before applying;'
    + ' prompt cache: one-time invalidation')
  lines.push(`Hide apply: ${typeof hideApply.mode === 'string' ? hideApply.mode : 'suggestion-only'}`
    + ((Array.isArray(hideApply.appliedNames) && hideApply.appliedNames.length > 0)
      ? ` (${hideApply.appliedNames.length} ${plural(hideApply.appliedNames.length, 'name')} applied to this agent scope)`
      : ' (nothing applied by this plugin; opt-in config required)'))
  lines.push('Do not add the hide tokens to the uninstall candidates: the two actions are alternative,'
    + ' not cumulative.')
  return lines.join('\n')
}

/** 数量词的单复数（模板里 `3 items` / `1 item` 两种形态都出现过）。 */
function plural(count, noun) {
  return count === 1 ? noun : `${noun}s`
}

/** `noRecommendation.reason` → 渲染用短语（机械映射，不是新枚举）。 */
const NO_RECOMMENDATION_LABELS = Object.freeze({
  core: 'core',
  'no-owner-bundle': 'no owner bundle',
  'unknown-attribution': 'unknown attribution',
})
