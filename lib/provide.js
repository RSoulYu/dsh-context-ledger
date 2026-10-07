/**
 * dsh-context-ledger — R1：工具 → 插件归属（**启发式**）与裁剪候选清单。
 *
 * 纯函数模块：
 * - 入参是**已读文本**（corpus 文本 / bundle patch 文本 / manifest 数据），
 *   **绝不自己读盘**（DESIGN §3.4 的 grep 判据：本文件不得出现任何读盘调用）；
 * - **不得** import 任何 `@deepseek-ai/*` 包（宿主依赖只允许出现在 `index.js`）。
 *
 * 唯一赋权点（DESIGN §7.2）：`providedBy` 的全部子字段、`findings.prunePlan`、
 * `prunePlanReclaimableTokens`、`noRecommendation` 只在本模块计算；
 * `lib/reconcile.js` 只做注入与缺省填充。
 *
 * 性质（§2.13，措辞即契约）：`providedBy` 是**安装侧静态推断**，**不是运行时可证事实**。
 * 因此本模块的每个返回值都带 `method` 与 `confidence`，无法唯一归因时一律记
 * `unknown` + `candidates`，**绝不猜测填充**。
 *
 * @module lib/provide
 */

import { NAME_PATTERN } from './usage.js'

/** `providedBy.kind` 的取值域（恰好 4 个，§2.13 硬规则 1：不得增减/合并）。 */
export const PROVIDED_BY_KINDS = Object.freeze(['plugin', 'core', 'mcp-server', 'unknown'])
/** 置信度取值域；语义 = **对 `kind` 判断的把握**。 */
export const PROVIDED_BY_CONFIDENCE = Object.freeze(['high', 'low'])
/** 判定手段取值域（§2.13）。 */
export const PROVIDED_BY_METHODS = Object.freeze(['static-scan', 'static-scan-weak', 'mcp-naming', 'not-found'])
/** `prunePlan[].kind` 取值域（恰好 2 个：动作种类）。 */
export const PRUNE_KINDS = Object.freeze(['plugin', 'mcp-server'])
/** `noRecommendation[].reason` 固定 3 条及其顺序（§2.16）。 */
export const NO_RECOMMENDATION_REASONS = Object.freeze(['core', 'no-owner-bundle', 'unknown-attribution'])
/** `findings.prunePlanBasis` 常量：机器可读的证据边界声明（§2.5 / §5）。 */
export const PRUNE_PLAN_BASIS = 'model-tool-calls-only'

/** npm 包名（含 scope）的宽松上界（§2.8 `PACKAGE_PATTERN`）。 */
export const PACKAGE_PATTERN = /^(@[A-Za-z0-9-_.~]+\/)?[A-Za-z0-9-_.~]{1,214}$/
/** MCP 工具名约定：`mcp__<server>__<tool>`（§2.8 `MCP_NAME_PATTERN`）。 */
export const MCP_NAME_PATTERN = /^mcp__([A-Za-z0-9_.-]{1,64})__([A-Za-z0-9_.-]{1,128})$/

/** `candidates` 上限（§2.13：≤8，升序去重）。 */
export const CANDIDATES_LIMIT = 8

/** 引号字符类（强/弱匹配共用；捕获组供 `\1` 回引，保证前后引号一致）。 */
const QUOTE_GROUP = '(["\'`])'

/**
 * 正则元字符转义。归属名字来自声明面（工具名），必须按字面量匹配。
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 强级匹配的**参照实现**（§2.14 第 2 级正则的逐字形态）：
 * 出现**工具注册点**的 `name:` 属性写法（`defineTool({ name: 'x' })` 等）。
 *
 * `scanCorpus` 出于性能用"一趟合并正则"实现同一语义（D5）；本函数保留为
 * **对拍基准**——`test/provide.test.js` 用它逐名字 `test`，证明两条路等价。
 * @param {string} name - 已通过 `NAME_PATTERN` 的名字
 * @returns {RegExp}
 */
export function strongPattern(name) {
  return new RegExp(`\\bname\\s*:\\s*${QUOTE_GROUP}${escapeRegExp(name)}\\1`)
}

/**
 * 弱级匹配的**参照实现**（§2.14 第 3 级正则的逐字形态）：
 * 名字以引号字面量出现过（覆盖"经常量/配置传递"的间接写法）。同样只作对拍基准。
 * @param {string} name
 * @returns {RegExp}
 */
export function weakPattern(name) {
  return new RegExp(`${QUOTE_GROUP}${escapeRegExp(name)}\\1`)
}

/**
 * 「无归属信息」的缺省值（§7.1 规则 3：缺省 = 全部 unknown，即**不猜**）。
 * 每次返回**新对象**，避免共享可变引用。
 * @returns {{kind: string, name: null, confidence: string, method: string, evidenceFile: null, candidates: string[]}}
 */
export function unknownProvidedBy() {
  return { kind: 'unknown', name: null, confidence: 'low', method: 'not-found', evidenceFile: null, candidates: [] }
}

/**
 * 扫描一批文本，得到每个名字的强/弱命中。
 *
 * 单趟算法（§2.14）：每个候选文件只在这一个循环里被检视一次，同一份文本上依次
 * 测试全部待归属名字；命中按包聚合（同包多文件只算 1 个候选包）。
 *
 * 只扫描通过 `NAME_PATTERN` 的名字：不过护栏的名字（理论不该出现）不参与匹配
 * ——既避免把正则元字符/引号注入匹配式，也让它们如实落到判定表第 8 行（unknown）。
 *
 * @param {Record<string, Array<{path: string, text: string}>>} corpus
 *   包名 → 该包已读取的文件（`path` 绝对路径、`text` 文件全文）
 * @param {Iterable<string>} names - 待归属的工具名
 * @param {{capped?: boolean}} [options] - 读盘阶段的防御性上限是否已被触达
 * @returns {{strongHits: Record<string, Array<{pkg: string, file: string}>>,
 *   weakHits: Record<string, Array<{pkg: string, file: string}>>,
 *   evidence: {strong: Record<string, string[]>, weak: Record<string, string[]>},
 *   files: number, bytes: number, capped: boolean}}
 *   `strongHits` / `weakHits`：名字 → 命中的 `(包, 文件)` 列表，按（包名, 文件路径）升序去重；
 *   `evidence`：名字 → 该级命中文件路径（升序；调用方取所需子集的最小者）。
 */
export function scanCorpus(corpus, names, options = {}) {
  const textSource = corpus !== null && typeof corpus === 'object' ? corpus : {}
  /** @type {Set<string>} */
  const probes = new Set()
  for (const raw of names ?? []) {
    if (typeof raw !== 'string' || raw === '' || probes.has(raw)) continue
    if (!NAME_PATTERN.test(raw)) continue
    probes.add(raw)
  }
  const wanted = [...probes.keys()]

  /** @type {Record<string, Map<string, Set<string>>>} */
  const strongRaw = {}
  /** @type {Record<string, Map<string, Set<string>>>} */
  const weakRaw = {}
  for (const name of wanted) {
    strongRaw[name] = new Map()
    weakRaw[name] = new Map()
  }

  // 性能写法（D5）：每个文件只做**一趟**正则扫描，而不是"每名字一趟"。
  //   `(\bname\s*:\s*)?` 可选前缀 = 强级标记；捕获组 2 是引号（`\2` 回引保证前后一致）；
  //   捕获组 3 是名字。名字按长度降序排在交替式里，避免短名抢先匹配后回退。
  // 语义与"逐个名字依次 test 强级、弱级"完全等价（test/provide.test.js 用参照实现对拍验证）。
  const alternation = wanted
    .slice()
    .sort((a, b) => (b.length - a.length) || (a < b ? -1 : 1))
    .map(escapeRegExp)
    .join('|')
  const scan = wanted.length === 0
    ? null
    : new RegExp(`(\\bname\\s*:\\s*)?${QUOTE_GROUP}(${alternation})\\2`, 'g')

  const record = (raw, name, pkg, file) => {
    const bucket = raw[name].get(pkg) ?? new Set()
    bucket.add(file)
    raw[name].set(pkg, bucket)
  }

  let files = 0
  let bytes = 0
  for (const pkg of Object.keys(textSource).sort()) {
    const entries = Array.isArray(textSource[pkg]) ? textSource[pkg] : []
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') continue
      const text = typeof entry.text === 'string' ? entry.text : ''
      const file = typeof entry.path === 'string' ? entry.path : ''
      if (file === '') continue
      files += 1
      bytes += Buffer.byteLength(text, 'utf8')
      if (scan === null) continue
      const strongInFile = new Set()
      scan.lastIndex = 0
      for (let match = scan.exec(text); match !== null; match = scan.exec(text)) {
        const name = match[3]
        if (match[1] !== undefined) strongInFile.add(name)
        // 同一文件里强级已命中的名字不再记弱级命中（等价于"强级一遍、弱级一遍"）
        else record(weakRaw, name, pkg, file)
      }
      for (const name of strongInFile) record(strongRaw, name, pkg, file)
    }
  }

  const flatten = (raw) => {
    /** @type {Record<string, Array<{pkg: string, file: string}>>} */
    const hits = {}
    /** @type {Record<string, string[]>} */
    const evidence = {}
    for (const name of Object.keys(raw).sort()) {
      const pairs = []
      const filesAsc = []
      for (const pkg of [...raw[name].keys()].sort()) {
        for (const file of [.../** @type {Set<string>} */ (raw[name].get(pkg)).values()].sort()) {
          pairs.push({ pkg, file })
          filesAsc.push(file)
        }
      }
      pairs.sort((a, b) => (a.pkg < b.pkg ? -1 : (a.pkg > b.pkg ? 1 : (a.file < b.file ? -1 : (a.file > b.file ? 1 : 0)))))
      hits[name] = pairs
      evidence[name] = filesAsc
    }
    return { hits, evidence }
  }

  const strong = flatten(strongRaw)
  const weak = flatten(weakRaw)
  return {
    strongHits: strong.hits,
    weakHits: weak.hits,
    evidence: { strong: strong.evidence, weak: weak.evidence },
    files,
    bytes,
    capped: options.capped === true,
  }
}

/**
 * 取某级命中里属于指定包集合的最小文件（§2.13：多个命中时取字典序最小者）。
 * @param {Array<{pkg: string, file: string}> | undefined} hits
 * @param {string[]} packages
 * @returns {string | null}
 */
function smallestEvidence(hits, packages) {
  if (!Array.isArray(hits) || packages.length === 0) return null
  const wanted = new Set(packages)
  const files = hits.filter(hit => wanted.has(hit.pkg)).map(hit => hit.file).sort()
  return files.length > 0 ? files[0] : null
}

/** 包名列表（升序去重）。 */
function packageNames(hits) {
  const names = []
  const seen = new Set()
  for (const hit of Array.isArray(hits) ? hits : []) {
    if (!seen.has(hit.pkg)) {
      seen.add(hit.pkg)
      names.push(hit.pkg)
    }
  }
  return names.sort()
}

/**
 * 按 DESIGN §2.13 的**判定表**给每个名字定 `providedBy`。
 *
 * 判定表从上到下第一个命中者胜（互斥且穷尽）——本函数即那张表的机械实现。
 * `kind === "unknown"` 时一律不填 `evidenceFile`（没有唯一归因就没有单一证据）。
 *
 * @param {Array<string | {name: string, category?: string}>} names
 * @param {{profile?: object, core?: object}} hits - 两个扫描根的 {@link scanCorpus} 结果
 * @param {{candidatesLimit?: number}} [options]
 * @returns {Record<string, {kind: string, name: string|null, confidence: string, method: string, evidenceFile: string|null, candidates: string[]}>}
 */
export function attributeNames(names, hits, options = {}) {
  const limit = Number.isFinite(options.candidatesLimit) ? Math.max(1, Math.round(options.candidatesLimit)) : CANDIDATES_LIMIT
  const profile = hits !== null && typeof hits === 'object' ? (hits.profile ?? {}) : {}
  const core = hits !== null && typeof hits === 'object' ? (hits.core ?? {}) : {}
  /** @type {Record<string, object>} */
  const out = {}

  for (const raw of names ?? []) {
    const name = typeof raw === 'string' ? raw : raw?.name
    const category = typeof raw === 'string' ? 'tools' : (raw?.category ?? 'tools')
    if (typeof name !== 'string' || name === '') continue

    // 第 1 行：MCP 命名约定（不扫描源码；已知的归属不得并进 unknown）。
    if (category === 'mcp') {
      const mcp = MCP_NAME_PATTERN.exec(name)
      if (mcp !== null) {
        out[name] = {
          kind: 'mcp-server', name: mcp[1], confidence: 'high', method: 'mcp-naming',
          evidenceFile: null, candidates: [],
        }
        continue
      }
      // 说明 2：category 是 mcp 但名字不符合约定 → 第 8 行（不得"看起来像 MCP"就推断）。
      out[name] = unknownProvidedBy()
      continue
    }

    const strongProfile = packageNames(profile.strongHits?.[name])
    const strongCore = packageNames(core.strongHits?.[name])

    // 第 2 行：强扫描 profile 恰好 1 个命中。
    if (strongProfile.length === 1) {
      out[name] = {
        kind: 'plugin', name: strongProfile[0], confidence: 'high', method: 'static-scan',
        evidenceFile: smallestEvidence(profile.strongHits?.[name], strongProfile), candidates: [],
      }
      continue
    }
    // 第 3 行：强扫描 profile ≥ 2 个命中（歧义：不给 core 结论，也不指定唯一包）。
    if (strongProfile.length >= 2) {
      out[name] = {
        kind: 'unknown', name: null, confidence: 'low', method: 'static-scan', evidenceFile: null,
        candidates: strongProfile.slice(0, limit),
      }
      continue
    }
    // 第 4 行：强扫描 profile 0 命中、核心 ≥ 1 命中。
    if (strongCore.length >= 1) {
      out[name] = {
        kind: 'core', name: null, confidence: 'high', method: 'static-scan',
        evidenceFile: smallestEvidence(core.strongHits?.[name], strongCore), candidates: [],
      }
      continue
    }

    // 第 5–7 行：强级两处全落空后才做弱扫描，且要求唯一性。
    const weakProfile = packageNames(profile.weakHits?.[name])
    const weakCore = packageNames(core.weakHits?.[name])
    if (weakProfile.length === 1 && weakCore.length === 0) {
      out[name] = {
        kind: 'plugin', name: weakProfile[0], confidence: 'low', method: 'static-scan-weak',
        evidenceFile: smallestEvidence(profile.weakHits?.[name], weakProfile), candidates: [],
      }
      continue
    }
    if (weakProfile.length === 0 && weakCore.length >= 1) {
      out[name] = {
        kind: 'core', name: null, confidence: 'low', method: 'static-scan-weak',
        evidenceFile: smallestEvidence(core.weakHits?.[name], weakCore), candidates: [],
      }
      continue
    }
    if (weakProfile.length >= 2 || (weakProfile.length >= 1 && weakCore.length >= 1)) {
      out[name] = {
        kind: 'unknown', name: null, confidence: 'low', method: 'static-scan-weak', evidenceFile: null,
        candidates: weakProfile.slice(0, limit),
      }
      continue
    }
    // 第 8 行：强、弱扫描均无任何命中。
    out[name] = unknownProvidedBy()
  }
  return out
}

/**
 * 某个 `providedBy` 对应的**动作单元**（§2.16 解析规则）。
 * @param {{kind: string, name: string|null}} providedBy
 * @param {Record<string, {owner: string|null, removable: boolean}>} bundleOwners
 * @returns {{kind: string, target: string} | {reason: string} | null}
 *   `null` = 该项不该出现在任何清单里（`instruction`/`skills` 之外理论上不会发生）
 */
function actionFor(providedBy, bundleOwners) {
  if (providedBy === null || typeof providedBy !== 'object') return { reason: 'unknown-attribution' }
  if (providedBy.kind === 'mcp-server') {
    if (typeof providedBy.name !== 'string' || providedBy.name === '') return { reason: 'unknown-attribution' }
    return { kind: 'mcp-server', target: providedBy.name }
  }
  if (providedBy.kind === 'plugin') {
    const entry = bundleOwners !== null && typeof bundleOwners === 'object' ? bundleOwners[providedBy.name] : undefined
    // 恰 1 个可卸载 bundle 才有动作单元；0 个 / 多个 / manifest 不可读 → 不给动作（§2.16 规则 4/6）。
    if (entry === undefined || entry === null) return { reason: 'no-owner-bundle' }
    if (entry.removable !== true || typeof entry.owner !== 'string' || entry.owner === '') return { reason: 'no-owner-bundle' }
    return { kind: 'plugin', target: entry.owner }
  }
  if (providedBy.kind === 'core') return { reason: 'core' }
  return { reason: 'unknown-attribution' }
}

/** `tokens` 降序 → `id` 升序（§2.15 条目内 items 顺序）。 */
function compareItemsByTokens(a, b) {
  if (a.tokens !== b.tokens) return b.tokens - a.tokens
  return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)
}

/** 条目排序：`reclaimableTokens` 降序 → `itemCount` 降序 → `target` 升序（§2.15）。 */
function compareEntries(a, b) {
  if (a.reclaimableTokens !== b.reclaimableTokens) return b.reclaimableTokens - a.reclaimableTokens
  if (a.itemCount !== b.itemCount) return b.itemCount - a.itemCount
  return a.target < b.target ? -1 : (a.target > b.target ? 1 : 0)
}

/**
 * 组装裁剪候选清单（DESIGN §2.15 / §2.16）。
 *
 * 省额口径三条（不许违反）：①逐项自身 `tokens` 求和；②**同一项只进一个条目**
 * （按项 id 去重，条目之间不重叠）；③不承诺净收益（`usedToolCount` 是代价信号）。
 *
 * @param {Array<Record<string, any>>} items - canonical `items[]`（`zeroCall` 已由 reconcile 赋值）
 * @param {Record<string, object>} providedByByName
 * @param {Record<string, {owner: string|null, removable: boolean}>} bundleOwners
 * @returns {{prunePlan: Array<object>, prunePlanReclaimableTokens: number, noRecommendation: Array<object>}}
 */
export function buildPrunePlan(items, providedByByName = {}, bundleOwners = {}) {
  const byName = providedByByName !== null && typeof providedByByName === 'object' ? providedByByName : {}
  const list = Array.isArray(items) ? items : []

  /** @type {Array<{reason: string, items: number, tokens: number}>} */
  const noRecommendation = NO_RECOMMENDATION_REASONS.map(reason => ({ reason, items: 0, tokens: 0 }))
  const indexOfReason = new Map(noRecommendation.map((entry, index) => [entry.reason, index]))
  /** @type {Map<string, {kind: string, target: string, zero: Map<string, object>, used: number, factPackages: Set<string>}>} */
  const units = new Map()
  /** 已进入「可执行候选」的项 id：保证同一项在所有条目里最多出现一次（省额不重复计入）。 */
  const placed = new Set()

  const resolve = item => (item.providedBy ?? byName[item.name] ?? unknownProvidedBy())

  // 第一趟：只用来自「工具/MCP」类的项（instructions/skills 连逐项次数都没有）。
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    if (item.category !== 'tools' && item.category !== 'mcp') continue
    const action = actionFor(resolve(item), bundleOwners)
    if (action === null) continue
    if (action.reason !== undefined) {
      // 只统计**有证据的零调用**项；不可观测/无证据项完全不进任何清单。
      if (item.zeroCall === true) {
        const index = indexOfReason.get(action.reason)
        if (index !== undefined) {
          noRecommendation[index].items += 1
          noRecommendation[index].tokens += Number.isFinite(item.tokens) ? item.tokens : 0
        }
      }
      continue
    }
    const key = `${action.kind}\u0000${action.target}`
    const unit = units.get(key) ?? { kind: action.kind, target: action.target, zero: new Map(), used: 0, factPackages: new Set() }
    units.set(key, unit)
    if (item.zeroCall === false) {
      // 卸载代价信号：同一逻辑单元下还在被模型使用的工具数。
      unit.used += 1
    } else if (item.zeroCall === true && !placed.has(item.id)) {
      placed.add(item.id)
      unit.zero.set(item.id, item)
      const providedBy = resolve(item)
      if (action.kind === 'plugin' && typeof providedBy.name === 'string' && providedBy.name !== '') {
        unit.factPackages.add(providedBy.name)
      }
    }
  }

  /** @type {Array<object>} */
  const prunePlan = []
  for (const unit of units.values()) {
    const zeroItems = [...unit.zero.values()]
    if (zeroItems.length === 0) continue
    const entryItems = zeroItems
      .sort(compareItemsByTokens)
      .map(item => ({ id: item.id, category: item.category, name: item.name, tokens: item.tokens }))
    const reclaimableTokens = entryItems.reduce((sum, item) => sum + item.tokens, 0)
    prunePlan.push({
      kind: unit.kind,
      target: unit.target,
      factPackages: unit.kind === 'plugin' ? [...unit.factPackages].sort() : [],
      items: entryItems,
      itemCount: entryItems.length,
      reclaimableTokens,
      usedToolCount: unit.used,
      confidence: zeroItems.every(item => resolve(item).confidence === 'high') ? 'high' : 'low',
    })
  }
  prunePlan.sort(compareEntries)

  return {
    prunePlan,
    prunePlanReclaimableTokens: prunePlan.reduce((sum, entry) => sum + entry.reclaimableTokens, 0),
    noRecommendation,
  }
}
