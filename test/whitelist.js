/**
 * 测试共用的 S3 字符串白名单（DESIGN §3.4；v2 已补齐 R1 新增字符串类别）。
 *
 * 非 `*.test.js`，`node --test` 不会把它当作用例文件；被 privacy.test.js 与
 * e2e.test.js 共同引用。
 *
 * 白名单规则（DESIGN §3.4 S3 的规则集 + 一条必要补充）：
 *  - 枚举常量（工具标识 / 单位 / 估算器 / 四类注入物 / 四种 usageBasis）
 *  - `NAME_PATTERN`：工具名、技能名、以及 provider 提供的 `source`/`provider` 标签
 *  - 绝对路径（`/` 起始）：`cwd` / `sessionsRoot` / 指令链文件
 *  - ISO-8601 时间戳、`workspaceKey` 形态（`--…--`）、数字字符串
 *  - **补充**：`id` = `"<category>:<name>"`。§2.4 冻结的 `id` 含 `:`，必然过不了
 *    `NAME_PATTERN`，因此 S3 若照字面规则执行会把自己的 `id` 判为违规；
 *    这里按 `category:` 前缀实测其 name 部分。
 */

/** 冻结枚举常量（v2：加入归属 / 置信度 / 判定手段 / 候选种类 / noRecommendation 理由 / 证据边界）。 */
export const ENUM_CONSTANTS = new Set([
  'context_ledger', 'token', 'heuristic-v1',
  'instructions', 'skills', 'tools', 'mcp',
  'tool-calls', 'no-evidence', 'unobservable', 'always-on',
  // v2 · providedBy
  'plugin', 'core', 'mcp-server', 'unknown',
  'high', 'low',
  'static-scan', 'static-scan-weak', 'mcp-naming', 'not-found',
  // v2 · prunePlan / noRecommendation
  'model-tool-calls-only',
  'no-owner-bundle', 'unknown-attribution',
  // v3 · R6（§2.18–§2.23；§3.7 明示"无新字符串类别"）
  'unconfirmed', 'model-observed', 'no-non-model-observability', 'unobservable',
  'suggestion-only', 'applied-by-config',
  'prechecked', 'unvalidated', 'unsupported',
  'not-in-restrictable-names', 'no-agent-scope', 'interface-absent', 'reserved-name',
  'one-time-invalidation',
  // v4 · R8（§3.8 的 8 个新常量；全部是固定枚举常量 + 一个受 NAME_PATTERN 约束的 id）
  'session-log-mtime', 'agent-session-id', 'http-session-param', 'unavailable',
  'current-session', 'historical-only', 'absent', 'model-tool-calls-in-window',
])

/** 与 lib/usage.js 一致的护栏（此处独立声明，避免用被测常量自证）。 */
export const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/
/** npm 包名形态（§2.8 `PACKAGE_PATTERN`；独立声明，避免自证）。 */
export const PACKAGE_PATTERN = /^(@[A-Za-z0-9-_.~]+\/)?[A-Za-z0-9-_.~]{1,214}$/
export const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
export const WORKSPACE_KEY = /^--[A-Za-z0-9._~-]{1,251}--$/
export const ABSOLUTE_PATH = /^\//
export const NUMERIC = /^\d+$/
export const ID_FORM = /^(instructions|skills|tools|mcp):(.+)$/

/**
 * 递归取出任意 JSON 值里的所有字符串。
 * @param {unknown} value
 * @param {string[]} [out]
 * @returns {string[]}
 */
export function allStrings(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const entry of value) allStrings(entry, out)
  else if (value !== null && typeof value === 'object') for (const entry of Object.values(value)) allStrings(entry, out)
  return out
}

/**
 * 该字符串是否命中白名单。
 * @param {string} value
 * @returns {boolean}
 */
export function isWhitelisted(value) {
  // 空串不携带任何内容：`reconcile` 在调用方未提供 `sessionsRoot` 时缺省为空串，
  // 它不是"正文片段"，因此显式放行（其他所有规则都要求至少 1 个字符）。
  if (value === '') return true
  if (ENUM_CONSTANTS.has(value)) return true
  if (NAME_PATTERN.test(value)) return true
  // v2：插件包名（providedBy.name / factPackages / target / candidates）
  if (PACKAGE_PATTERN.test(value)) return true
  if (ABSOLUTE_PATH.test(value)) return true
  if (ISO_UTC.test(value)) return true
  if (WORKSPACE_KEY.test(value)) return true
  if (NUMERIC.test(value)) return true
  const idMatch = ID_FORM.exec(value)
  if (idMatch !== null) {
    const name = idMatch[2]
    return ABSOLUTE_PATH.test(name) || NAME_PATTERN.test(name)
  }
  return false
}

/**
 * v4（§3.8 / §3.4 S3）：`scope.currentSession.id` 是**唯一**新增的"受护栏约束的运行时字符串"。
 *
 * 它必须先过 `NAME_PATTERN` 才能进产物（不匹配即按"取不到"处理）。这条在这里独立复算，
 * 而不是靠 `isWhitelisted` 的通用 `NAME_PATTERN` 分支"顺带"通过——否则
 * "id 必须过护栏"这条硬规则会退化成永真的空断言。
 *
 * @param {unknown} report
 * @returns {string[]} 违规说明（空数组 = 通过）
 */
export function currentSessionIdOffenders(report) {
  const current = report?.scope?.currentSession
  if (current === null || typeof current !== 'object') return ['scope.currentSession 缺失（§2.2 必需）']
  const problems = []
  if (current.id !== null && !NAME_PATTERN.test(current.id)) {
    problems.push(`currentSession.id 未过 NAME_PATTERN: ${String(current.id)}`)
  }
  if ((current.basis === 'unavailable') !== (current.id === null)) {
    problems.push('currentSession：basis === "unavailable" ⟺ id === null 不成立')
  }
  if (!['agent-session-id', 'http-session-param', 'unavailable'].includes(current.basis)) {
    problems.push(`currentSession.basis 取值越域: ${String(current.basis)}`)
  }
  if (typeof current.inWindow !== 'boolean') problems.push('currentSession.inWindow 不是布尔')
  return problems
}

/**
 * 返回报告里未命中白名单的字符串（空数组 = S3 通过）。
 * @param {unknown} report
 * @returns {string[]}
 */
export function whitelistOffenders(report) {
  return allStrings(report).filter(value => !isWhitelisted(value))
}
