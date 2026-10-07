/**
 * dsh-context-ledger — R6：工具级隐藏候选（`findings.hidePlan` 系列）与施加判定。
 *
 * 纯函数模块：
 * - 入参是**数据**（canonical `items[]`、归属信息、宿主探测到的预校验结果），
 *   **绝不自己读盘**、**不调用任何宿主接口**（读盘与施加都只在 `index.js`）；
 * - **不得** import 任何 `@deepseek-ai/*` 包（宿主依赖只允许出现在 `index.js`）。
 *
 * 唯一赋权点（DESIGN §2.18–§2.25）：`hidePlan` / `hidePlanTokens` / `hidePlanUnits` /
 * `hidePlanStatus` / `hideApply` 只在本模块计算；`lib/reconcile.js` 只做注入。
 *
 * 四条硬约束（§2.23）在**本模块**的落地方式：
 * - H1 作用域：本模块不施加任何限制，只在 `hideApply` 里如实记录"可施加/已施加"的**名字**；
 *   真正的施加发生在 `index.js` 的 agent 作用域内（宿主禁止全局施加）。
 * - H2 名字预校验：`precheck` 逐候选记录 `restrictable`，只有 `restrictable === true` 的名字才进 `denyList`。
 * - H3 三态降级：`precheck.status` / `hidePlanStatus` / `hideApply.applySupported` 如实表达
 *   "未校验 / 无该接口"，**不抛错**。
 * - H4 默认不施加：`hideApply.mode` 缺省恒为 `"suggestion-only"`、`appliedNames` 缺省恒为 `[]`。
 *
 * 措辞红线（§6 第 11 条）：本模块产出的字符串只允许是**名字、数字、固定枚举与证据边界常量**；
 * 不得出现"安全/零损失/无副作用/只影响模型"这类把不可判定写成结论的表述，也不得把
 * `hidePlanTokens` 与 `prunePlanReclaimableTokens` 相加（两者是**互斥替代方案**，见 §2.22）。
 *
 * @module lib/hide
 */

import { PROVIDED_BY_KINDS } from './provide.js'

/** `findings.hidePlanBasis` 常量（与 `prunePlanBasis` 同源同值，§2.18）。 */
export const HIDE_PLAN_BASIS = 'model-tool-calls-only'

/** `hideApply.mode` 取值域（恰好 2 个，§2.23.4）。 */
export const HIDE_MODES = Object.freeze(['suggestion-only', 'applied-by-config'])

/** `precheck.status` / `hidePlanStatus` 取值域（§2.20）。 */
export const PRECHECK_STATUSES = Object.freeze(['prechecked', 'unvalidated', 'unsupported'])

/** `precheck.reason` 取值域（§2.20；`reserved-name` 仅针对保留传输名 `run_code`）。 */
export const PRECHECK_REASONS = Object.freeze([
  'not-in-restrictable-names', 'no-agent-scope', 'interface-absent', 'reserved-name',
])

/** 保留传输名：`restrict()` 对它直接抛错（`dsh-tools/lib/index.js:2905`），永不允许进 `deny`。 */
export const RESERVED_TOOL_NAMES = Object.freeze(['run_code'])

/** `registryUse.verdict` 取值域（§2.19 硬规则 1：只有这两个，**不得**出现 safe/unused/no-loss）。 */
export const REGISTRY_USE_VERDICTS = Object.freeze(['unconfirmed', 'model-observed'])

/** `registryUse.verdictBasis` 常量：为什么给不出更强结论（§2.19）。 */
export const REGISTRY_USE_BASIS = 'no-non-model-observability'

/** `registryUse.nonModelCallers` 常量（§2.19）。 */
export const NON_MODEL_CALLERS = 'unobservable'

/** `nameReferencedElsewhere` 上限（§2.19：≤3，绝对路径，升序）。 */
export const NAME_REFERENCED_LIMIT = 3

/** `hidePlanCaveat`：共享代价常量，5 键冻结（§2.19）。 */
export const HIDE_PLAN_CAVEAT = Object.freeze({
  registryHideIsTotal: true,
  nonModelRegistryCalls: NON_MODEL_CALLERS,
  serviceCoupling: 'unconfirmed',
  confirmationRequired: true,
  prefixCacheCost: 'one-time-invalidation',
})

/** 可隐藏的分类：只有这两类有逐项次数与可限制性（§2.18）。 */
const HIDEABLE_CATEGORIES = new Set(['tools', 'mcp'])

/** 非负整数化。 */
function toCount(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(n)
}

/** 升序去重（字符串数组）。 */
function uniqueSorted(values) {
  const seen = new Set()
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value === 'string' && value !== '') seen.add(value)
  }
  return [...seen].sort()
}

/** 深拷贝 caveat（避免调用方改到共享常量）。 */
function caveatCopy() {
  return { ...HIDE_PLAN_CAVEAT }
}

/**
 * 候选的单元归属（§2.18 `unit` 子字段；取值域与 `providedBy.kind` 完全一致）。
 *
 * 与 `prunePlan` 的**关键差异**：这里**不要求**单元可卸载——`core` / `unknown` 归属的工具
 * 进不了 prunePlan，但同样可以被 deny（它们也是全局名字）。
 *
 * @param {{kind?: string, name?: string|null}|undefined} providedBy
 * @param {Record<string, {owner: string|null, removable: boolean}>} bundleOwners
 * @returns {{kind: string, target: string|null, factPackages: string[]}}
 */
function unitOf(providedBy, bundleOwners) {
  const kind = typeof providedBy?.kind === 'string' && PROVIDED_BY_KINDS.includes(providedBy.kind)
    ? providedBy.kind
    : 'unknown'
  const name = typeof providedBy?.name === 'string' && providedBy.name !== '' ? providedBy.name : null
  if (kind === 'mcp-server') return { kind, target: name, factPackages: [] }
  if (kind === 'plugin') {
    const entry = name !== null && bundleOwners !== null && typeof bundleOwners === 'object'
      ? bundleOwners[name]
      : undefined
    const owner = entry !== null && typeof entry === 'object' && entry.removable === true
      && typeof entry.owner === 'string' && entry.owner !== ''
      ? entry.owner
      : null
    return { kind, target: owner, factPackages: name === null ? [] : [name] }
  }
  return { kind, target: null, factPackages: [] }
}

/** 单元分组键：`kind` + `target`（`target` 为 null 时用空串占位）。 */
function unitKey(unit) {
  return `${unit.kind}\u0000${unit.target ?? ''}`
}

/** `hidePlan` 排序：`tokens` 降序 → `name` 升序（§2.20，全序）。 */
function compareHideEntries(a, b) {
  if (a.tokens !== b.tokens) return b.tokens - a.tokens
  return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)
}

/** `hidePlanUnits` 排序：`tokens` 降序 → `toolCount` 降序 → `(target ?? kind)` 升序（§2.20）。 */
function compareHideUnits(a, b) {
  if (a.tokens !== b.tokens) return b.tokens - a.tokens
  if (a.toolCount !== b.toolCount) return b.toolCount - a.toolCount
  const keyA = a.target ?? a.kind
  const keyB = b.target ?? b.kind
  return keyA < keyB ? -1 : (keyA > keyB ? 1 : 0)
}

/**
 * 逐候选的预校验结果（§2.20）。
 *
 * `status` 与 `restrictable` 是两个维度：`prechecked` 表示"查过了"，`restrictable` 才是结论。
 * 未校验时 `restrictable` 恒为 `null`——**不得**用 `false` 表示"没查"。
 *
 * @param {string} name
 * @param {{status?: string, restrictableNames?: string[]|null}} probe
 * @returns {{status: string, restrictable: boolean|null, reason: string|null}}
 */
export function precheckOf(name, probe) {
  const status = typeof probe?.status === 'string' && PRECHECK_STATUSES.includes(probe.status)
    ? probe.status
    : 'unsupported'
  if (status === 'unsupported') return { status, restrictable: null, reason: 'interface-absent' }
  if (status === 'unvalidated') return { status, restrictable: null, reason: 'no-agent-scope' }
  if (RESERVED_TOOL_NAMES.includes(name)) {
    // 防线：保留传输名永不允许进 deny（它本就不出现在 items 里）。
    return { status, restrictable: false, reason: 'reserved-name' }
  }
  const known = new Set(Array.isArray(probe?.restrictableNames) ? probe.restrictableNames : [])
  return known.has(name)
    ? { status, restrictable: true, reason: null }
    : { status, restrictable: false, reason: 'not-in-restrictable-names' }
}

/**
 * 生成工具级隐藏候选（§2.18 / §2.20）。
 *
 * @param {Array<Record<string, any>>} items - canonical `items[]`（`zeroCall` 已赋值）
 * @param {{byName?: Record<string, object>, bundleOwners?: Record<string, object>,
 *   weakEvidence?: Record<string, string[]>}} [provenance]
 * @param {{status?: string, restrictableNames?: string[]|null}} [probe] - 宿主探测到的预校验来源
 * @param {{prunePlan?: Array<{kind: string, target: string}>}} [options] - 用于 `hidePlanUnits[].inPrunePlan`
 * @returns {{hidePlan: Array<object>, hidePlanTokens: number, hidePlanUnits: Array<object>, hidePlanStatus: string}}
 */
export function buildHidePlan(items, provenance = {}, probe = {}, options = {}) {
  const list = Array.isArray(items) ? items : []
  const byName = provenance?.byName !== null && typeof provenance?.byName === 'object' ? provenance.byName : {}
  const bundleOwners = provenance?.bundleOwners !== null && typeof provenance?.bundleOwners === 'object'
    ? provenance.bundleOwners
    : {}
  const weakEvidence = provenance?.weakEvidence !== null && typeof provenance?.weakEvidence === 'object'
    ? provenance.weakEvidence
    : {}
  const pruneKeys = new Set((Array.isArray(options?.prunePlan) ? options.prunePlan : [])
    .filter(entry => entry !== null && typeof entry === 'object' && typeof entry.kind === 'string' && typeof entry.target === 'string')
    .map(entry => `${entry.kind}\u0000${entry.target}`))

  /** @type {Array<object>} */
  const hidePlan = []
  /** @type {Map<string, {kind: string, target: string|null, factPackages: Set<string>, toolCount: number, tokens: number, usedToolCount: number}>} */
  const units = new Map()
  const statuses = new Set()

  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    if (!HIDEABLE_CATEGORIES.has(item.category)) continue
    // 只有**有证据的零调用**才是候选（与 R1 同一纪律：没有证据就没有候选）。
    if (item.zeroCall !== true) {
      // 同单元的在用工具数：卸载/隐藏的代价信号，需把非零调用项也计入单元。
      const usedUnit = unitOf(item.providedBy ?? byName[item.name], bundleOwners)
      const usedKey = unitKey(usedUnit)
      const usedEntry = units.get(usedKey)
      if (usedEntry !== undefined && item.zeroCall === false) usedEntry.usedToolCount += 1
      else if (usedEntry === undefined && item.zeroCall === false) {
        units.set(usedKey, {
          kind: usedUnit.kind,
          target: usedUnit.target,
          factPackages: new Set(usedUnit.factPackages),
          toolCount: 0,
          tokens: 0,
          usedToolCount: 1,
        })
      }
      continue
    }

    const providedBy = item.providedBy ?? byName[item.name]
    const unit = unitOf(providedBy, bundleOwners)
    const precheck = precheckOf(String(item.name ?? ''), probe)
    statuses.add(precheck.status)
    const referenced = uniqueSorted(weakEvidence[item.name]).slice(0, NAME_REFERENCED_LIMIT)

    hidePlan.push({
      id: item.id,
      name: item.name,
      category: item.category,
      tokens: toCount(item.tokens),
      unit: { kind: unit.kind, target: unit.target, factPackages: [...unit.factPackages].sort() },
      registryUse: {
        // 候选恒为"零调用"⇒ 只可能是 unconfirmed；`model-observed` 是语义占位（§2.19）。
        verdict: 'unconfirmed',
        verdictBasis: REGISTRY_USE_BASIS,
        modelCalls: toCount(item.calls),
        nameReferencedElsewhere: referenced,
        nonModelCallers: NON_MODEL_CALLERS,
      },
      precheck,
      selfTool: item.name === 'context_ledger',
    })

    const key = unitKey(unit)
    const entry = units.get(key) ?? {
      kind: unit.kind,
      target: unit.target,
      factPackages: new Set(),
      toolCount: 0,
      tokens: 0,
      usedToolCount: 0,
    }
    for (const pkg of unit.factPackages) entry.factPackages.add(pkg)
    entry.toolCount += 1
    entry.tokens += toCount(item.tokens)
    units.set(key, entry)
  }

  hidePlan.sort(compareHideEntries)

  const hidePlanUnits = [...units.values()]
    .filter(entry => entry.toolCount > 0)
    .map(entry => ({
      kind: entry.kind,
      target: entry.target,
      factPackages: [...entry.factPackages].sort(),
      toolCount: entry.toolCount,
      tokens: entry.tokens,
      usedToolCount: entry.usedToolCount,
      inPrunePlan: pruneKeys.has(`${entry.kind}\u0000${entry.target ?? ''}`),
    }))
    .sort(compareHideUnits)

  const status = typeof probe?.status === 'string' && PRECHECK_STATUSES.includes(probe.status)
    ? probe.status
    : 'unsupported'
  // 三者取最弱一环（有候选时按候选；没有候选时按探测结果——否则会谎报"已校验"）。
  const hidePlanStatus = statuses.size === 0
    ? status
    : (statuses.has('unsupported') ? 'unsupported' : (statuses.has('unvalidated') ? 'unvalidated' : 'prechecked'))

  return {
    hidePlan,
    hidePlanTokens: hidePlan.reduce((sum, entry) => sum + entry.tokens, 0),
    hidePlanUnits,
    hidePlanStatus,
  }
}

/**
 * 组装 `findings.hideApply`（§2.23.2 / §2.23.4）。
 *
 * **默认不施加**：`mode` 缺省 `"suggestion-only"`、`appliedNames` 缺省 `[]`。
 * `denyList` 只含通过预校验的名字；其余进 `skipped`（两者是候选集合的一个划分）。
 *
 * @param {Array<object>} hidePlan
 * @param {{mode?: string, interfacePresent?: boolean, status?: string, appliedNames?: string[]}} [input]
 * @returns {{mode: string, interfacePresent: boolean, denyList: string[], skipped: Array<{name: string, reason: string}>, applySupported: boolean, appliedNames: string[]}}
 */
export function buildHideApply(hidePlan, input = {}) {
  const list = Array.isArray(hidePlan) ? hidePlan : []
  const mode = typeof input?.mode === 'string' && HIDE_MODES.includes(input.mode) ? input.mode : 'suggestion-only'
  const status = typeof input?.status === 'string' && PRECHECK_STATUSES.includes(input.status)
    ? input.status
    : 'unsupported'
  const interfacePresent = typeof input?.interfacePresent === 'boolean'
    ? input.interfacePresent
    : status !== 'unsupported'

  const denyNames = new Set()
  /** @type {Array<{name: string, reason: string}>} */
  const skipped = []
  for (const entry of list) {
    const restrictable = entry?.precheck?.restrictable === true
    const name = String(entry?.name ?? '')
    if (name === '') continue
    if (restrictable && !RESERVED_TOOL_NAMES.includes(name)) {
      denyNames.add(name)
    } else {
      // 预留名先判：即便上游把它标成 restrictable，本模块也必须按"保留名"如实记因。
      const reason = RESERVED_TOOL_NAMES.includes(name)
        ? 'reserved-name'
        : (typeof entry?.precheck?.reason === 'string'
          ? entry.precheck.reason
          : reasonForStatus(entry?.precheck?.status))
      skipped.push({ name, reason })
    }
  }
  const denyList = [...denyNames].sort()
  skipped.sort((a, b) => (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)))

  // 施加失败 / 空清单 / 名字消失时的容错：只有真正通过校验的名字才可能被记录为"已施加"。
  const appliedNames = uniqueSorted(input?.appliedNames).filter(name => denyNames.has(name))

  return {
    mode,
    interfacePresent,
    denyList,
    skipped,
    // 空清单绝不施加（`restrict()` 对空 filter 直接抛错，`dsh-tools/lib/index.js:2900`）。
    applySupported: interfacePresent && denyList.length > 0,
    appliedNames,
  }
}

/** 无 `reason` 时按状态补一个（不静默留空）。 */
function reasonForStatus(status) {
  if (status === 'unvalidated') return 'no-agent-scope'
  if (status === 'unsupported') return 'interface-absent'
  return 'not-in-restrictable-names'
}

/**
 * 生成 R6 的全部 `findings` 键（§2.18；`reconcile` 直接注入这七个字段）。
 *
 * @param {Array<Record<string, any>>} items
 * @param {{byName?: object, bundleOwners?: object, weakEvidence?: object}} [provenance]
 * @param {{status?: string, restrictableNames?: string[]|null, mode?: string,
 *   interfacePresent?: boolean, appliedNames?: string[]}} [hideInput]
 * @param {{prunePlan?: Array<{kind: string, target: string}>}} [options]
 * @returns {{hidePlan: Array<object>, hidePlanTokens: number, hidePlanUnits: Array<object>,
 *   hidePlanBasis: string, hidePlanStatus: string, hideApply: object, hidePlanCaveat: object}}
 */
export function buildHideFindings(items, provenance = {}, hideInput = {}, options = {}) {
  const plan = buildHidePlan(items, provenance, hideInput, options)
  const hideApply = buildHideApply(plan.hidePlan, {
    mode: hideInput?.mode,
    interfacePresent: hideInput?.interfacePresent,
    status: hideInput?.status,
    appliedNames: hideInput?.appliedNames,
  })
  return {
    hidePlan: plan.hidePlan,
    hidePlanTokens: plan.hidePlanTokens,
    hidePlanUnits: plan.hidePlanUnits,
    hidePlanBasis: HIDE_PLAN_BASIS,
    hidePlanStatus: plan.hidePlanStatus,
    hideApply,
    hidePlanCaveat: caveatCopy(),
  }
}
