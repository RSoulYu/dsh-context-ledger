/**
 * dsh-context-ledger — **对账核心**：成本 × 使用 → 每次使用成本 + 零调用标记。
 *
 * 纯函数模块：**不得** import 任何 `@deepseek-ai/*` 包（宿主依赖只允许出现在
 * `index.js`）。
 *
 * 本模块是 `calls` / `tokensPerCall` / `zeroCall` / `usageBasis` 的**唯一赋权点**
 * （DESIGN §7）。`lib/cost.js` 只填成本侧字段，次数语义全部在这里落地，避免两条
 * 实现线各写一套。
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

import { ESTIMATOR } from './tokens.js'
import { isValidToolName, lookupCount, projectKey } from './usage.js'

/** `context_ledger` 工具标识（DESIGN §2.1，常量）。 */
export const LEDGER_TOOL = 'context_ledger'
/** canonical 形状版本（DESIGN §2.1，常量）。 */
export const LEDGER_VERSION = 1
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
  'source', 'server', 'bytes', 'provider', 'loadOrder',
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
 * 三种来源（前者优先），全部是**输入**；输出的 `calls` 仍由本模块赋值：
 *  1. `raw.observedCalls` —— 回放层挂在项上的原始次数（逐项最精确）；
 *  2. `callsByName[raw.name]` —— 全局计数表（`index.js` 的常规通路）；
 *  3. `raw.calls` —— 成本表若已带次数，容忍它作为输入（canonical 语义仍以本模块为准）。
 *
 * @param {Record<string, unknown>} raw
 * @param {Record<string, number> | null} callsByName
 * @returns {number | undefined} `undefined` = 没有任何信号
 */
function observedCountOf(raw, callsByName) {
  if (Number.isFinite(raw.observedCalls)) return toCount(raw.observedCalls)
  const name = typeof raw.name === 'string' ? raw.name : ''
  const fromMap = lookupCount(callsByName, name)
  if (fromMap !== undefined) return fromMap
  if (Number.isFinite(raw.calls)) return toCount(raw.calls)
  return undefined
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
 *   findingsLimit?: number,
 * }} input
 *   `scope` = §2.2 的观测范围字段（**不含** `usageAvailable`；它由本函数按
 *   「`sessionsScanned >= 1`」判定）。`callsByName` 是回放得到的计数表，可放在
 *   顶层，也可随 `scope.callsByName` 一起传（输入用，不进产物）。
 * @returns {Record<string, unknown>} canonical `context_ledger` 报告
 */
export function reconcile(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const scopeIn = (source.scope !== null && typeof source.scope === 'object') ? source.scope : {}
  const callsByName = (source.callsByName !== undefined && source.callsByName !== null)
    ? source.callsByName
    : (scopeIn.callsByName !== undefined && scopeIn.callsByName !== null ? scopeIn.callsByName : null)
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
  const hasCounts = callsByName !== null && typeof callsByName === 'object'
  if (Number.isFinite(scopeIn.callsUnmatched)) {
    callsUnmatched = toCount(scopeIn.callsUnmatched)
    callsUnmatchedNames = Array.isArray(scopeIn.callsUnmatchedNames)
      ? scopeIn.callsUnmatchedNames.filter(name => typeof name === 'string').slice(0, UNMATCHED_NAMES_LIMIT)
      : []
  } else if (hasCounts) {
    let accepted = 0
    const unmatched = []
    for (const key of Object.keys(callsByName).sort()) {
      const count = Number.isFinite(callsByName[key]) ? callsByName[key] : 0
      accepted += count
      if (!matchedNames.has(key)) unmatched.push(key)
    }
    callsUnmatched = Math.max(0, accepted - matchedCalls)
    callsUnmatchedNames = unmatched.slice(0, UNMATCHED_NAMES_LIMIT)
  } else {
    callsUnmatched = 0
    callsUnmatchedNames = []
  }
  if (Number.isFinite(scopeIn.skillToolCalls)) {
    skillToolCalls = toCount(scopeIn.skillToolCalls)
  } else if (hasCounts) {
    skillToolCalls = toCount(lookupCount(callsByName, 'skill'))
  } else {
    skillToolCalls = 0
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
    toolCalls: matchedCalls + callsUnmatched + namesRejected,
    skillToolCalls,
    callsUnmatched,
    callsUnmatchedNames,
    namesRejected,
    usageAvailable,
    truncated: scopeIn.truncated === true,
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
    findings: { zeroCall, topPerUse },
    totals,
  }
}

/**
 * native 渲染（DESIGN §2.11，冻结格式）。
 *
 * 只允许出现**名字、数字、单位与固定枚举文案**——不放任何正文派生的内容。
 *
 * @param {Record<string, any>} report - `reconcile()` 的产物
 * @returns {string}
 */
export function renderLedger(report) {
  const totals = report?.totals ?? {}
  const scope = report?.scope ?? {}
  const findings = report?.findings ?? { zeroCall: [], topPerUse: [] }
  const categories = Array.isArray(report?.categories) ? report.categories : []
  const perUse = totals.observableTokensPerCall === null || totals.observableTokensPerCall === undefined
    ? 'n/a'
    : String(totals.observableTokensPerCall)

  const lines = [
    `Context ledger: ${totals.residentTokens} tokens resident / ${totals.observedCalls} observed calls`
    + ` across ${scope.sessionsScanned} sessions / ${perUse} tokens per use`,
    `Never called (cost without use): ${totals.zeroCallItems} items, ${totals.zeroCallTokens} tokens`,
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
  return lines.join('\n')
}
