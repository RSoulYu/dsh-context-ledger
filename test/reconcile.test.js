/**
 * lib/reconcile.js —— 对账核心（v2）。
 *
 * 验收要求的第四条（每次使用成本排序）与第五条（零调用识别）都在这里；
 * 另外把 DESIGN §2.9 的冻结示例 JSON（v2：16 项，含 `providedBy` 与 `prunePlan`）
 * 当作**黄金样例**逐条重放：同一份输入必须产出 §2.9 的 21 条自洽断言，
 * 且 native 渲染逐行符合 §2.11 的冻结模板。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CATEGORY_KEYS,
  FINDINGS_LIMIT,
  LEDGER_TOOL,
  LEDGER_UNIT,
  LEDGER_VERSION,
  reconcile,
  renderLedger,
} from '../lib/reconcile.js'
import { ESTIMATOR } from '../lib/tokens.js'

const EXAMPLE_CWD = '/home/u/Desktop/DSHWorkspace'
const EXAMPLE_AGENTS_MD = '/home/u/Desktop/DSHWorkspace/AGENTS.md'
const EXAMPLE_SESSIONS_ROOT = '/home/u/.dsh/sessions'
const EXAMPLE_EVIDENCE_ROOT = '/home/u/.dsh/profiles/web/node_modules'

/**
 * DESIGN §2.9 的 16 项（**成本侧原样**：不含次数、不含 `providedBy`；
 * 后两者分别由 `callsByName` 与 `provenance` 通道传入）。
 */
function exampleItems() {
  return [
    {
      id: 'mcp:mcp__openviking__add_resource', category: 'mcp', name: 'mcp__openviking__add_resource',
      tokens: 402, source: 'mcp', server: 'openviking', bytes: 1609,
    },
    { id: 'tools:subagent', category: 'tools', name: 'subagent', tokens: 402, source: 'native', bytes: 1608 },
    {
      id: 'mcp:mcp__openviking__forget', category: 'mcp', name: 'mcp__openviking__forget',
      tokens: 341, source: 'mcp', server: 'openviking', bytes: 1364,
    },
    { id: 'tools:task_board_list', category: 'tools', name: 'task_board_list', tokens: 292, source: 'native', bytes: 1168 },
    {
      id: 'tools:task_board_github_list', category: 'tools', name: 'task_board_github_list',
      tokens: 196, source: 'native', bytes: 784,
    },
    { id: 'tools:task_board_schedule', category: 'tools', name: 'task_board_schedule', tokens: 174, source: 'native', bytes: 696 },
    { id: 'tools:context_ledger', category: 'tools', name: 'context_ledger', tokens: 214, source: 'native', bytes: 856 },
    { id: 'tools:agent_teams_claim_task', category: 'tools', name: 'agent_teams_claim_task', tokens: 268, source: 'native', bytes: 1072 },
    {
      id: 'mcp:mcp__openviking__find', category: 'mcp', name: 'mcp__openviking__find',
      tokens: 406, source: 'mcp', server: 'openviking', bytes: 1624,
    },
    { id: 'tools:read', category: 'tools', name: 'read', tokens: 186, source: 'native', bytes: 744 },
    { id: 'tools:bash', category: 'tools', name: 'bash', tokens: 381, source: 'native', bytes: 1524 },
    {
      id: `instructions:${EXAMPLE_AGENTS_MD}`, category: 'instructions', name: EXAMPLE_AGENTS_MD,
      tokens: 812, source: 'project', bytes: 3421, loadOrder: 1,
    },
    { id: 'skills:genui', category: 'skills', name: 'genui', tokens: 128, source: 'user-dsh', provider: 'filesystem', bytes: 512 },
    {
      id: 'skills:openviking-memory', category: 'skills', name: 'openviking-memory',
      tokens: 96, source: 'user-dsh', provider: 'filesystem', bytes: 384,
    },
    {
      id: 'skills:openviking-skills', category: 'skills', name: 'openviking-skills',
      tokens: 88, source: 'user-dsh', provider: 'filesystem', bytes: 352,
    },
    {
      id: 'skills:ov-experience-memory', category: 'skills', name: 'ov-experience-memory',
      tokens: 74, source: 'user-dsh', provider: 'filesystem', bytes: 296,
    },
  ]
}

/** 让 §2.9 的统计量成立的计数表：137 次命中账目项 + 4 次未匹配。 */
function exampleCallsByName() {
  return {
    bash: 118,
    read: 4,
    mcp__openviking__find: 8,
    agent_teams_claim_task: 4,
    context_ledger: 3,
    context_audit: 2,
    mcp__oldserver__ping: 2,
  }
}

/**
 * §2.9 的**覆盖会话数**通道（§7.1 规则 5：v4 新增，唯一来源是它）。
 *
 * 数字取自 §2.9 的逐项 `sessionsWithCalls`（`bash` 12 / `find` 5 / `context_ledger` 2 /
 * `claim_task` 2 / `read` 3）；未列出的名字 ⇒ 0（= "已判定、确实一个都没有"）。
 */
function exampleSessionCoverage() {
  return {
    bash: 12,
    read: 3,
    mcp__openviking__find: 5,
    agent_teams_claim_task: 2,
    context_ledger: 2,
  }
}

/**
 * §2.9 的**本会话调用数**通道（§7.1 规则 5）。
 *
 * 这是 `scope.currentSession.id` 那一个会话里的次数；合计 = §2.9 的
 * `totals.currentSessionObservedCalls = 47`（41 + 3 + 2 + 1 + 0）。
 */
function exampleCurrentSessionCalls() {
  return {
    bash: 41,
    read: 1,
    mcp__openviking__find: 3,
    agent_teams_claim_task: 0,
    context_ledger: 2,
  }
}

/** §2.9 的会话身份（v4）。 */
const EXAMPLE_SESSION_ID = '1f0a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8'

/** §2.9 的 `providedBy`（11 个 tools/mcp 项各一条）+ 两个事实包的卸载单元。 */
function exampleProvenance() {
  const staticScan = (kind, name, evidenceFile) => ({
    kind, name, confidence: 'high', method: 'static-scan', evidenceFile, candidates: [],
  })
  const mcpNaming = server => ({
    kind: 'mcp-server', name: server, confidence: 'high', method: 'mcp-naming', evidenceFile: null, candidates: [],
  })
  return {
    byName: {
      mcp__openviking__add_resource: mcpNaming('openviking'),
      mcp__openviking__forget: mcpNaming('openviking'),
      mcp__openviking__find: mcpNaming('openviking'),
      subagent: {
        kind: 'unknown', name: null, confidence: 'low', method: 'static-scan-weak', evidenceFile: null,
        candidates: [
          '@linxin666/dsh-pet', '@linxin666/dsh-session-archive', '@linxin666/dsh-web-all',
          '@nanmicoder/dsh-agent-teams', '@openviking/dsh-memory-plugin', 'dsh-context', 'dshmarket',
        ],
      },
      task_board_list: staticScan('plugin', '@linxin666/dsh-client-ui-task-board',
        `${EXAMPLE_EVIDENCE_ROOT}/@linxin666/dsh-client-ui-task-board/lib/index.js`),
      task_board_schedule: staticScan('plugin', '@linxin666/dsh-client-ui-task-board',
        `${EXAMPLE_EVIDENCE_ROOT}/@linxin666/dsh-client-ui-task-board/lib/index.js`),
      task_board_github_list: staticScan('plugin', '@linxin666/dsh-client-ui-task-board-github',
        `${EXAMPLE_EVIDENCE_ROOT}/@linxin666/dsh-client-ui-task-board-github/lib/index.js`),
      context_ledger: {
        kind: 'plugin', name: 'dsh-context-ledger', confidence: 'low', method: 'static-scan-weak',
        evidenceFile: '/home/u/Desktop/DSHWorkspace/dsh-context-ledger/index.js', candidates: [],
      },
      agent_teams_claim_task: staticScan('plugin', '@nanmicoder/dsh-agent-teams',
        `${EXAMPLE_EVIDENCE_ROOT}/@nanmicoder/dsh-agent-teams/lib/tool-names.js`),
      read: staticScan('core', null,
        '/opt/dsh/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-api-workspace-files/lib/index.js'),
      bash: staticScan('core', null,
        '/opt/dsh/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-bash/lib/index.js'),
    },
    bundleOwners: {
      '@linxin666/dsh-client-ui-task-board': { owner: '@linxin666/dsh-web-all', removable: true },
      '@linxin666/dsh-client-ui-task-board-github': { owner: '@linxin666/dsh-web-all', removable: true },
    },
  }
}

function exampleScope() {
  return {
    workspaceKey: '--home-u-Desktop-DSHWorkspace--',
    sessionsRoot: EXAMPLE_SESSIONS_ROOT,
    sessionsAvailable: 41,
    sessionsScanned: 20,
    // v4：为满足 W5（`scanned + unreadable ≤ limit`，即 20 + 0 ≤ 20）由 1 改为 0；
    // 并新增 sessionsOutsideWindow = 41 − 20 − 0 = 21 使 W4 成立（交接 3 的合成数据自洽修正）。
    sessionsUnreadable: 0,
    sessionsLimit: 20,
    sessionsOutsideWindow: 21,
    windowStart: '2026-09-30T00:12:44.001Z',
    windowEnd: '2026-10-07T02:38:19.774Z',
    windowBasis: 'session-log-mtime',
    currentSession: { id: EXAMPLE_SESSION_ID, basis: 'agent-session-id', inWindow: true },
    linesRead: 41233,
    toolCalls: 141,
    skillToolCalls: 9,
    namesRejected: 0,
    truncated: false,
    providerScan: { packages: 387, files: 1593, bytes: 49380329, capped: false },
  }
}

function exampleReport() {
  return reconcile({
    cwd: EXAMPLE_CWD,
    sessionsRoot: EXAMPLE_SESSIONS_ROOT,
    scope: exampleScope(),
    callsByName: exampleCallsByName(),
    sessionCoverage: exampleSessionCoverage(),
    currentSessionCallsByName: exampleCurrentSessionCalls(),
    provenance: exampleProvenance(),
    items: exampleItems(),
  })
}

test('黄金样例：DESIGN §2.9 的统计恒等式逐条成立', () => {
  const report = exampleReport()
  const category = key => report.categories.find(entry => entry.key === key)
  const sumCalls = report.items.reduce((sum, item) => sum + (item.calls ?? 0), 0)

  assert.equal(report.tool, 'context_ledger')
  assert.equal(report.version, 4)
  assert.equal(report.unit, 'token')
  assert.equal(report.estimator, 'heuristic-v1')
  assert.equal(report.cwd, EXAMPLE_CWD)

  // ① residentTokens = observableTokens + unknownUsageTokens
  assert.equal(report.totals.residentTokens, 4460)
  assert.equal(report.totals.residentTokens, report.totals.observableTokens + report.totals.unknownUsageTokens)
  assert.equal(report.totals.observableTokens, 3262)
  assert.equal(report.totals.unknownUsageTokens, 1198)
  // ② observableTokens = tools + mcp
  assert.equal(report.totals.observableTokens, category('tools').tokens + category('mcp').tokens)
  // ③ unknownUsageTokens = instructions + skills
  assert.equal(report.totals.unknownUsageTokens, category('instructions').tokens + category('skills').tokens)
  // ④ observedCalls = tools.calls + mcp.calls
  assert.equal(report.totals.observedCalls, 137)
  assert.equal(report.totals.observedCalls, category('tools').calls + category('mcp').calls)
  // ⑤ toolCalls = Σ items[].calls(非空) + callsUnmatched + namesRejected
  assert.equal(report.scope.toolCalls, 141)
  assert.equal(
    report.scope.toolCalls,
    sumCalls + report.scope.callsUnmatched + report.scope.namesRejected,
  )
  assert.equal(report.scope.callsUnmatched, 4)
  assert.deepEqual(report.scope.callsUnmatchedNames, ['context_audit', 'mcp__oldserver__ping'])
  // ⑥ observableTokensPerCall = round(observable / observed)
  assert.equal(report.totals.observableTokensPerCall, 24)
  assert.equal(
    report.totals.observableTokensPerCall,
    Math.round(report.totals.observableTokens / report.totals.observedCalls),
  )
  // ⑦ zeroCallTokens
  assert.equal(report.totals.zeroCallItems, 6)
  assert.equal(report.totals.zeroCallTokens, 1807)
  // ⑧ items.length = Σ categories[].itemCount
  assert.equal(report.items.length, 16)
  assert.equal(report.items.length, report.categories.reduce((sum, entry) => sum + entry.itemCount, 0))
  // ⑨ unknownUsageItems = calls === null 的项数
  assert.equal(report.totals.unknownUsageItems, 5)
  assert.equal(report.totals.unknownUsageItems, report.items.filter(item => item.calls === null).length)
  // ⑩⑪⑫ 分类折算（用 Math.round）
  assert.equal(category('tools').tokensPerCall, 16)
  assert.equal(category('mcp').tokensPerCall, 144)
  assert.equal(category('skills').mechanismCalls, 9)
  assert.equal(category('skills').mechanismTokensPerCall, 43)
  // ⑬ items 顺序严格符合 §2.7
  assert.deepEqual(report.items.map(item => item.id), [
    'mcp:mcp__openviking__add_resource',
    'tools:subagent',
    'mcp:mcp__openviking__forget',
    'tools:task_board_list',
    'tools:task_board_github_list',
    'tools:task_board_schedule',
    'tools:context_ledger',
    'tools:agent_teams_claim_task',
    'mcp:mcp__openviking__find',
    'tools:read',
    'tools:bash',
    `instructions:${EXAMPLE_AGENTS_MD}`,
    'skills:genui',
    'skills:openviking-memory',
    'skills:openviking-skills',
    'skills:ov-experience-memory',
  ])
})

test('黄金样例：DESIGN §2.9 的 v4 断言（窗口不变量 W1–W6 与三态 I1–I11）', () => {
  const report = exampleReport()
  const scope = report.scope
  const byName = new Map(report.items.map(item => [item.name, item]))
  const sumCurrent = report.items.reduce((sum, item) => sum + (item.currentSessionCalls ?? 0), 0)

  // v4 · version 3 → 4（新增必需字段即形状变更）
  assert.equal(report.version, 4)

  // v4 · W4/W5/W6 + W1（W2 在窗口非空时由字符串序保证）
  assert.equal(scope.sessionsAvailable, scope.sessionsScanned + scope.sessionsUnreadable + scope.sessionsOutsideWindow)
  assert.equal(scope.sessionsAvailable, 41)
  assert.equal(scope.sessionsOutsideWindow, 21)
  assert.ok(scope.sessionsScanned + scope.sessionsUnreadable <= scope.sessionsLimit)
  assert.notEqual(scope.windowStart, null)
  assert.notEqual(scope.windowEnd, null)
  assert.ok(scope.windowStart <= scope.windowEnd)
  assert.equal(scope.windowBasis, 'session-log-mtime')

  // v4 · scope.currentSession（§2.2 三条硬规则）
  assert.deepEqual(scope.currentSession, {
    id: EXAMPLE_SESSION_ID, basis: 'agent-session-id', inWindow: true,
  })
  assert.match(scope.currentSession.id, /^[A-Za-z0-9_.-]{1,128}$/)

  // v4 · I8/I9：本会话合计 = Σ 逐项；且 ≤ 窗口总量
  assert.equal(report.totals.currentSessionObservedCalls, 47)
  assert.equal(report.totals.currentSessionObservedCalls, sumCurrent)
  assert.ok(report.totals.currentSessionObservedCalls <= report.totals.observedCalls)

  // v4 · I1/I5/I6：逐项三态的取值与边界
  for (const item of report.items) {
    if (item.calls === null) {
      // I2：不可观测 ⇒ 三个新字段全 null
      assert.equal(item.currentSessionCalls, null, item.id)
      assert.equal(item.sessionsWithCalls, null, item.id)
      assert.equal(item.callPresence, null, item.id)
      continue
    }
    assert.ok(item.currentSessionCalls <= item.calls, `${item.id} 本会话次数超过窗口总量`)
    assert.ok(item.sessionsWithCalls <= scope.sessionsScanned, `${item.id} 覆盖会话数超过窗口`)
    assert.equal(item.calls > 0, item.sessionsWithCalls >= 1, `${item.id} I6 前半段`)
    assert.equal(item.calls === 0, item.sessionsWithCalls === 0, `${item.id} I6 后半段`)
    // I1 / I7
    assert.equal(item.callPresence === 'current-session', item.currentSessionCalls > 0, item.id)
    assert.equal(item.zeroCall === true, item.callPresence === 'absent', item.id)
    assert.ok(['current-session', 'historical-only', 'absent'].includes(item.callPresence), item.id)
  }

  // v4 · 三态齐全（§2.9 的自洽表：4 / 1 / 6）
  const presence = list => report.items.filter(item => item.callPresence === list).length
  assert.equal(presence('current-session'), 4)
  assert.equal(presence('historical-only'), 1)
  assert.equal(presence('absent'), 6)
  assert.equal(presence('absent'), report.totals.zeroCallItems)

  // v4 · 逐项数字与 §2.9 的示例逐字一致（代表项）
  assert.deepEqual(
    [byName.get('bash').calls, byName.get('bash').currentSessionCalls, byName.get('bash').sessionsWithCalls,
      byName.get('bash').callPresence],
    [118, 41, 12, 'current-session'],
  )
  assert.deepEqual(
    [byName.get('read').calls, byName.get('read').currentSessionCalls, byName.get('read').sessionsWithCalls],
    [4, 1, 3],
  )
  assert.deepEqual(
    [byName.get('mcp__openviking__find').calls, byName.get('mcp__openviking__find').currentSessionCalls,
      byName.get('mcp__openviking__find').sessionsWithCalls],
    [8, 3, 5],
  )
  // 态 2（historical-only）：本会话 0 次、窗口内其他会话调用过 ⇒ **不进** findings.zeroCall
  assert.equal(byName.get('agent_teams_claim_task').callPresence, 'historical-only')
  assert.equal(byName.get('agent_teams_claim_task').currentSessionCalls, 0)
  assert.equal(byName.get('agent_teams_claim_task').sessionsWithCalls, 2)
  assert.equal(byName.get('agent_teams_claim_task').zeroCall, false)
  assert.equal(report.findings.zeroCall.some(entry => entry.name === 'agent_teams_claim_task'), false)
  // 态 3（absent）
  assert.deepEqual(
    [byName.get('task_board_list').currentSessionCalls, byName.get('task_board_list').sessionsWithCalls,
      byName.get('task_board_list').callPresence, byName.get('task_board_list').zeroCall],
    [0, 0, 'absent', true],
  )

  // v4 · I10：窗口边界声明（与 prunePlanBasis/hidePlanBasis 正交，二者都必须在场）
  assert.equal(report.findings.zeroCallBasis, 'model-tool-calls-in-window')
  assert.equal(report.findings.prunePlanBasis, 'model-tool-calls-only')
  assert.equal(report.findings.hidePlanBasis, 'model-tool-calls-only')
})

test('黄金样例：providedBy 覆盖与取值约束（§2.13）', () => {
  const report = exampleReport()
  const attributable = report.items.filter(item => item.category === 'tools' || item.category === 'mcp')
  const others = report.items.filter(item => item.category !== 'tools' && item.category !== 'mcp')
  assert.equal(attributable.length, 11)
  assert.ok(attributable.every(item => item.providedBy !== undefined))
  assert.ok(others.every(item => item.providedBy === undefined)) // §2.13 硬规则 4：必须省略

  const byName = new Map(attributable.map(item => [item.name, item.providedBy]))
  assert.deepEqual(byName.get('task_board_schedule'), {
    kind: 'plugin', name: '@linxin666/dsh-client-ui-task-board', confidence: 'high', method: 'static-scan',
    evidenceFile: `${EXAMPLE_EVIDENCE_ROOT}/@linxin666/dsh-client-ui-task-board/lib/index.js`, candidates: [],
  })
  assert.deepEqual(byName.get('mcp__openviking__find'), {
    kind: 'mcp-server', name: 'openviking', confidence: 'high', method: 'mcp-naming',
    evidenceFile: null, candidates: [],
  })
  assert.equal(byName.get('subagent').kind, 'unknown')
  assert.equal(byName.get('subagent').evidenceFile, null)
  assert.equal(byName.get('subagent').candidates.length, 7)

  const PACKAGE = /^(@[A-Za-z0-9-_.~]+\/)?[A-Za-z0-9-_.~]{1,214}$/
  for (const item of attributable) {
    const { kind, name, confidence, method, evidenceFile, candidates } = item.providedBy
    assert.ok(['plugin', 'core', 'mcp-server', 'unknown'].includes(kind))
    assert.ok(['high', 'low'].includes(confidence))
    assert.ok(['static-scan', 'static-scan-weak', 'mcp-naming', 'not-found'].includes(method))
    if (kind === 'plugin') assert.ok(PACKAGE.test(name), `${name} 应匹配 PACKAGE_PATTERN`)
    else if (kind === 'mcp-server') assert.equal(typeof name, 'string')
    else assert.equal(name, null)
    if (kind === 'unknown') assert.equal(evidenceFile, null)
    else assert.equal(candidates.length, 0)
  }
})

test('黄金样例：findings 三个清单 + 省额恒等式（§2.15 / §2.16）', () => {
  const report = exampleReport()
  assert.deepEqual(report.findings.zeroCall.map(item => item.id), [
    'mcp:mcp__openviking__add_resource',
    'tools:subagent',
    'mcp:mcp__openviking__forget',
    'tools:task_board_list',
    'tools:task_board_github_list',
    'tools:task_board_schedule',
  ])
  assert.deepEqual(report.findings.topPerUse.map(item => item.id), [
    'tools:context_ledger',
    'tools:agent_teams_claim_task',
    'mcp:mcp__openviking__find',
    'tools:read',
    'tools:bash',
  ])
  assert.deepEqual(report.findings.topPerUse.map(item => item.tokensPerCall), [71, 67, 51, 47, 3])

  assert.deepEqual(report.findings.prunePlan, [
    {
      kind: 'mcp-server', target: 'openviking', factPackages: [],
      items: [
        { id: 'mcp:mcp__openviking__add_resource', category: 'mcp', name: 'mcp__openviking__add_resource', tokens: 402 },
        { id: 'mcp:mcp__openviking__forget', category: 'mcp', name: 'mcp__openviking__forget', tokens: 341 },
      ],
      itemCount: 2, reclaimableTokens: 743, usedToolCount: 1, confidence: 'high',
    },
    {
      kind: 'plugin', target: '@linxin666/dsh-web-all',
      factPackages: ['@linxin666/dsh-client-ui-task-board', '@linxin666/dsh-client-ui-task-board-github'],
      items: [
        { id: 'tools:task_board_list', category: 'tools', name: 'task_board_list', tokens: 292 },
        { id: 'tools:task_board_github_list', category: 'tools', name: 'task_board_github_list', tokens: 196 },
        { id: 'tools:task_board_schedule', category: 'tools', name: 'task_board_schedule', tokens: 174 },
      ],
      itemCount: 3, reclaimableTokens: 662, usedToolCount: 0, confidence: 'high',
    },
  ])
  assert.equal(report.findings.prunePlanReclaimableTokens, 1405)
  assert.equal(report.findings.prunePlanBasis, 'model-tool-calls-only')
  assert.deepEqual(report.findings.noRecommendation, [
    { reason: 'core', items: 0, tokens: 0 },
    { reason: 'no-owner-bundle', items: 0, tokens: 0 },
    { reason: 'unknown-attribution', items: 1, tokens: 402 },
  ])

  // 恒等式 1–6（§2.16）
  const category = key => report.categories.find(entry => entry.key === key)
  const pruneTokens = report.findings.prunePlan.reduce((sum, entry) => sum + entry.reclaimableTokens, 0)
  const pruneItems = report.findings.prunePlan.reduce((sum, entry) => sum + entry.itemCount, 0)
  const noRecItems = report.findings.noRecommendation.reduce((sum, entry) => sum + entry.items, 0)
  const noRecTokens = report.findings.noRecommendation.reduce((sum, entry) => sum + entry.tokens, 0)
  const actionable = report.items.filter(item => item.zeroCall === true
    && (item.providedBy.kind === 'plugin' || item.providedBy.kind === 'mcp-server'))
  const actionableTokens = actionable.reduce((sum, item) => sum + item.tokens, 0)

  assert.equal(report.findings.prunePlanReclaimableTokens, pruneTokens) // ①
  assert.equal(pruneTokens, actionableTokens) // ②
  assert.equal(pruneItems + noRecItems, report.totals.zeroCallItems) // ③
  assert.equal(pruneTokens + noRecTokens, report.totals.zeroCallTokens) // ④
  assert.ok(pruneTokens <= category('tools').tokens + category('mcp').tokens) // ⑤
  assert.equal(1405 <= 3262, true)
})

test('黄金样例：native 渲染逐行符合 §2.11 模板（R1 段逐字节相同）', () => {
  const lines = renderLedger(exampleReport()).split('\n')

  assert.equal(lines[0], 'Context ledger: 4460 tokens resident / 137 observed calls across 20 sessions / 24 tokens per use')
  assert.equal(lines[1], 'Never called by the model (cost without model use): 6 items, 1807 tokens')
  assert.equal(lines[2], '  - mcp__openviking__add_resource [mcp]  402 tokens  0 calls')
  assert.equal(lines[3], '  - subagent [tools]  402 tokens  0 calls')
  assert.equal(lines[8], 'Most expensive per use:')
  assert.equal(lines[9], '  - context_ledger [tools]  214 tokens  3 calls  -> 71 tokens/call')
  assert.equal(lines[10], '  - agent_teams_claim_task [tools]  268 tokens  4 calls  -> 67 tokens/call')
  assert.equal(
    lines[14],
    'Not observable: instructions 812 tokens (always-on)'
    + ' / skills 386 tokens (per-skill unknown; 9 skill loads, 43 tokens/load)',
  )
  // R1 段（§2.11 第 4 段，措辞是契约的一部分）
  assert.equal(
    lines[15],
    'Never-called candidates, grouped by removal unit — NOT uninstall advice: 1405 tokens in 2 units',
  )
  assert.equal(
    lines[16],
    '  - mcp-server openviking: 2 tools, 743 tokens if unused  (1 other tool of this unit is in use)',
  )
  assert.equal(
    lines[17],
    '  - plugin @linxin666/dsh-web-all: 3 tools, 662 tokens if unused'
    + '  (provides @linxin666/dsh-client-ui-task-board, @linxin666/dsh-client-ui-task-board-github)',
  )
  assert.equal(lines[18], 'No actionable unit: 1 item, 402 tokens (unknown attribution 1)')
  assert.equal(
    lines[19],
    'A tool can still be used by the UI, by background flows, or rarely but crucially; verify before removing.',
  )
  // 冻结的 20 行之后是 v3 追加的 R6 段（R1 模板的每一行都原样保留、位置不变）
  assert.equal(lines.slice(0, 20).length, 20)
  assert.match(lines[20], /^Hide candidates \(tool level\) — needs manual confirmation: \d+ tokens in \d+ tools? across \d+ units? \(status: (prechecked|unvalidated|unsupported)\)$/)
  assert.match(lines[lines.length - 1], /^Do not add the hide tokens to the uninstall candidates/)
  assert.ok(lines.some(line => line.startsWith('Hide caveats: registry-level hide, not schema-only;')))
  assert.ok(lines.some(line => line.startsWith('Hide apply: ')))
  // 两个括号组同时出现时（插件单元既在用又有事实包）：各自成组
  const mixed = reconcile({
    cwd: '/w',
    scope: { sessionsScanned: 1 },
    callsByName: { used_one: 2 },
    provenance: {
      byName: {
        never_one: { kind: 'plugin', name: '@a/fact', confidence: 'high', method: 'static-scan', evidenceFile: '/p/f.js', candidates: [] },
        used_one: { kind: 'plugin', name: '@a/fact', confidence: 'high', method: 'static-scan', evidenceFile: '/p/f.js', candidates: [] },
      },
      bundleOwners: { '@a/fact': { owner: '@a/bundle', removable: true } },
    },
    items: [
      { category: 'tools', name: 'never_one', tokens: 20 },
      { category: 'tools', name: 'used_one', tokens: 10 },
    ],
  })
  const mixedUnitLine = renderLedger(mixed).split('\n').find(line => line.startsWith('  - plugin @a/bundle:'))
  assert.equal(
    mixedUnitLine,
    '  - plugin @a/bundle: 1 tool, 20 tokens if unused'
    + '  (1 other tool of this unit is in use)  (provides @a/fact)',
  )
  // §6 第 10 条（R1 段）：除冻结模板自带的字样外，不得出现确定性动词
  const r1Block = lines.slice(15, 20).join('\n')
    .replace('NOT uninstall advice', '')
    .replace('verify before removing.', '')
  assert.equal(/\b(uninstall|remove|delete)\b/i.test(r1Block), false)
  // §2.22（R6 段）：两种动作的代价必须同屏；§6 第 11 条：不得把不可判定写成结论
  const r6Block = lines.slice(20).join('\n')
  assert.match(r6Block, /hide \d+ tools?, \d+ tokens if hidden/)
  assert.match(r6Block, /\| {2}(uninstall this unit: \d+ tokens if unused|uninstall is not available for this unit)/)
  assert.equal(/\b(safe|no loss|lossless|no side effect|only affects the model)\b/i.test(r6Block), false)
})

test('黄金样例：canonical 形状——顶层 11 键、项字段顺序、无契约外字段', () => {
  const report = exampleReport()
  assert.deepEqual(Object.keys(report), [
    'tool', 'version', 'generatedAt', 'unit', 'estimator', 'cwd', 'scope', 'categories', 'items', 'findings', 'totals',
  ])
  assert.match(report.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.deepEqual(Object.keys(report.scope), [
    'workspaceKey', 'sessionsRoot', 'sessionsAvailable', 'sessionsScanned', 'sessionsUnreadable',
    'sessionsLimit', 'sessionsOutsideWindow', 'windowStart', 'windowEnd', 'windowBasis', 'currentSession',
    'linesRead', 'toolCalls', 'skillToolCalls',
    'callsUnmatched', 'callsUnmatchedNames', 'namesRejected', 'usageAvailable', 'truncated', 'providerScan',
  ])
  assert.deepEqual(Object.keys(report.scope.currentSession), ['id', 'basis', 'inWindow'])
  assert.deepEqual(Object.keys(report.scope.providerScan), ['packages', 'files', 'bytes', 'capped'])
  assert.deepEqual(report.scope.providerScan, { packages: 387, files: 1593, bytes: 49380329, capped: false })
  assert.deepEqual(Object.keys(report.categories[0]), [
    'key', 'itemCount', 'tokens', 'calls', 'tokensPerCall', 'observableUsage',
    'mechanismCalls', 'mechanismTokensPerCall',
  ])
  assert.deepEqual(Object.keys(report.items[0]), [
    'id', 'category', 'name', 'tokens', 'calls', 'tokensPerCall', 'zeroCall',
    'currentSessionCalls', 'sessionsWithCalls', 'callPresence', 'usageBasis',
    'source', 'server', 'bytes', 'providedBy',
  ])
  assert.deepEqual(Object.keys(report.items[0].providedBy), [
    'kind', 'name', 'confidence', 'method', 'evidenceFile', 'candidates',
  ])
  assert.deepEqual(Object.keys(report.findings), [
    'zeroCall', 'topPerUse', 'prunePlan', 'prunePlanReclaimableTokens', 'prunePlanBasis', 'zeroCallBasis',
    'noRecommendation',
    'hidePlan', 'hidePlanTokens', 'hidePlanUnits', 'hidePlanBasis', 'hidePlanStatus', 'hideApply', 'hidePlanCaveat',
  ])
  assert.deepEqual(Object.keys(report.findings.prunePlan[0]), [
    'kind', 'target', 'factPackages', 'items', 'itemCount', 'reclaimableTokens', 'usedToolCount', 'confidence',
  ])
  assert.deepEqual(Object.keys(report.findings.prunePlan[0].items[0]), ['id', 'category', 'name', 'tokens'])
  assert.deepEqual(Object.keys(report.findings.noRecommendation[0]), ['reason', 'items', 'tokens'])
  assert.deepEqual(Object.keys(report.totals), [
    'residentTokens', 'observableTokens', 'unknownUsageTokens', 'observedCalls',
    'currentSessionObservedCalls',
    'observableTokensPerCall', 'zeroCallItems', 'zeroCallTokens', 'unknownUsageItems',
  ])
  for (const item of report.items) {
    assert.equal(Object.hasOwn(item, 'observedCalls'), false)
    // v4：三个新字段是必需的，逐项都必须在场（`null` 也是"在场"）
    for (const key of ['currentSessionCalls', 'sessionsWithCalls', 'callPresence']) {
      assert.equal(Object.hasOwn(item, key), true, `${item.id} 缺 ${key}`)
    }
  }
})

test('§7.1 规则 1：调用次数只有 callsByName 一个通道', () => {
  // ① items[].calls 被忽略并覆盖
  const fromItems = reconcile({
    cwd: '/w', scope: { sessionsScanned: 1 }, callsByName: { bash: 2 },
    items: [{ category: 'tools', name: 'bash', tokens: 10, calls: 99 }],
  })
  assert.equal(fromItems.items[0].calls, 2)
  assert.equal(fromItems.items[0].zeroCall, false)
  // ② scope.callsByName / item.observedCalls 不再被接受
  const ignored = reconcile({
    cwd: '/w',
    scope: { sessionsScanned: 1, callsByName: { bash: 7 } },
    callsByName: {},
    items: [{ category: 'tools', name: 'bash', tokens: 10, observedCalls: 5 }],
  })
  assert.equal(ignored.items[0].calls, 0)
  assert.equal(ignored.items[0].zeroCall, true)
  // ③ 缺省 callsByName = {}（不猜）
  const noChannel = reconcile({
    cwd: '/w', scope: { sessionsScanned: 1 }, items: [{ category: 'tools', name: 'bash', tokens: 10 }],
  })
  assert.equal(noChannel.items[0].calls, 0)
})

test('§7.1 规则 4：宿主传入的 scope 计数器以"输入即事实"为准（O3 矛盾输入也不产假候选）', () => {
  const report = reconcile({
    cwd: '/w',
    scope: {
      sessionsScanned: 0,
      toolCalls: 4,
      skillToolCalls: 3,
      namesRejected: 1,
      linesRead: 42,
      sessionsAvailable: 9,
    },
    callsByName: { bash: 4 },
    items: [{ category: 'tools', name: 'bash', tokens: 10 }],
  })
  assert.equal(report.scope.sessionsScanned, 0)
  assert.equal(report.scope.usageAvailable, false)
  assert.equal(report.scope.toolCalls, 4)
  assert.equal(report.scope.skillToolCalls, 3)
  assert.equal(report.scope.namesRejected, 1)
  assert.equal(report.scope.linesRead, 42)
  assert.equal(report.scope.sessionsAvailable, 9)
  assert.equal(report.items[0].usageBasis, 'no-evidence')
  assert.equal(report.items[0].calls, null)
  assert.deepEqual(report.findings.zeroCall, [])
  assert.deepEqual(report.findings.prunePlan, [])
  assert.equal(report.findings.prunePlanReclaimableTokens, 0)
})

test('§7.1 规则 5/6（v4）：`{}` 与 `null` 是两个事实——缺通道绝不当成零', () => {
  const item = { category: 'tools', name: 'bash', tokens: 10 }
  const base = {
    cwd: '/w',
    scope: { sessionsScanned: 2, sessionsAvailable: 2 },
    callsByName: { bash: 15 },
    items: [{ ...item }],
  }

  // ① 两个通道都缺字段 ⇒ 逐项 `null`（**不得**退化为 0——`calls = 15` 帮不了它们）
  const missing = reconcile({ ...base })
  assert.equal(missing.items[0].calls, 15)
  assert.equal(missing.items[0].currentSessionCalls, null)
  assert.equal(missing.items[0].sessionsWithCalls, null)
  assert.equal(missing.items[0].callPresence, null)
  assert.equal(missing.totals.currentSessionObservedCalls, null)

  // ② 显式 `null` = "给不出"（与缺字段同义）
  const explicitNull = reconcile({ ...base, sessionCoverage: null, currentSessionCallsByName: null })
  assert.equal(explicitNull.items[0].sessionsWithCalls, null)
  assert.equal(explicitNull.items[0].currentSessionCalls, null)
  assert.equal(explicitNull.totals.currentSessionObservedCalls, null)

  // ③ `{}` = "已判定、确实一个都没有" ⇒ `0`（**这是唯一允许产出 0 的情形**）
  const judged = reconcile({
    ...base,
    scope: { sessionsScanned: 2, sessionsAvailable: 2, currentSession: { id: 'sess-x', basis: 'agent-session-id', inWindow: true } },
    sessionCoverage: {},
    currentSessionCallsByName: {},
  })
  assert.equal(judged.items[0].sessionsWithCalls, 0)
  assert.equal(judged.items[0].currentSessionCalls, 0)
  // 本会话 0 次但窗口内有 15 次 ⇒ historical-only（**不是** absent，更不是零调用）
  assert.equal(judged.items[0].callPresence, 'historical-only')
  assert.equal(judged.items[0].zeroCall, false)
  assert.equal(judged.totals.currentSessionObservedCalls, 0)
  assert.equal(judged.items[0].tokensPerCall, Math.round(10 / 15))

  // ④ 通道值与 `calls` 不一致时以通道为准（§7.1 规则 5：一个事实一个通道，不得互相反推）
  const authoritative = reconcile({
    ...base,
    scope: { sessionsScanned: 2, sessionsAvailable: 2, currentSession: { id: 'sess-x', basis: 'agent-session-id', inWindow: true } },
    sessionCoverage: { bash: 1 },
    currentSessionCallsByName: { bash: 4 },
  })
  assert.equal(authoritative.items[0].sessionsWithCalls, 1) // 不是 15，也不是 sessionsScanned
  assert.equal(authoritative.items[0].currentSessionCalls, 4)
  assert.equal(authoritative.items[0].callPresence, 'current-session')
})

test('§2.26.2 判定表：7 行互斥且穷尽（逐行落地）', () => {
  const item = { category: 'tools', name: 'bash', tokens: 10 }
  const inWindow = {
    sessionsScanned: 3,
    sessionsAvailable: 3,
    currentSession: { id: 'sess-x', basis: 'agent-session-id', inWindow: true },
  }
  const outside = {
    sessionsScanned: 3,
    sessionsAvailable: 3,
    currentSession: { id: 'sess-x', basis: 'agent-session-id', inWindow: false },
  }

  // 行 1：tool-calls ∧ inWindow ∧ hit > 0 ⇒ current-session
  const row1 = reconcile({
    cwd: '/w', scope: inWindow, callsByName: { bash: 9 },
    sessionCoverage: { bash: 2 }, currentSessionCallsByName: { bash: 4 }, items: [{ ...item }],
  })
  assert.deepEqual(
    [row1.items[0].calls, row1.items[0].currentSessionCalls, row1.items[0].sessionsWithCalls,
      row1.items[0].callPresence, row1.items[0].zeroCall],
    [9, 4, 2, 'current-session', false],
  )

  // 行 2：tool-calls ∧ inWindow ∧ hit === 0 ∧ calls > 0 ⇒ historical-only（不进 zeroCall）
  const row2 = reconcile({
    cwd: '/w', scope: inWindow, callsByName: { bash: 4 },
    sessionCoverage: { bash: 2 }, currentSessionCallsByName: { bash: 0 }, items: [{ ...item }],
  })
  assert.deepEqual(
    [row2.items[0].calls, row2.items[0].currentSessionCalls, row2.items[0].sessionsWithCalls,
      row2.items[0].callPresence, row2.items[0].zeroCall],
    [4, 0, 2, 'historical-only', false],
  )
  assert.deepEqual(row2.findings.zeroCall, [])
  assert.deepEqual(row2.findings.prunePlan, [])

  // 行 3：tool-calls ∧ inWindow ∧ calls === 0 ⇒ absent（唯一进 zeroCall 的态）
  const row3 = reconcile({
    cwd: '/w', scope: inWindow, callsByName: {},
    sessionCoverage: {}, currentSessionCallsByName: {}, items: [{ ...item }],
  })
  assert.deepEqual(
    [row3.items[0].calls, row3.items[0].currentSessionCalls, row3.items[0].sessionsWithCalls,
      row3.items[0].callPresence, row3.items[0].zeroCall],
    [0, 0, 0, 'absent', true],
  )
  assert.deepEqual(row3.findings.zeroCall.map(entry => entry.id), ['tools:bash'])

  // 行 4：inWindow === false ∧ calls > 0 ⇒ 本会话不可判定（null），覆盖会话数照常给
  const row4 = reconcile({
    cwd: '/w', scope: outside, callsByName: { bash: 4 },
    sessionCoverage: { bash: 2 }, currentSessionCallsByName: { bash: 3 }, items: [{ ...item }],
  })
  assert.deepEqual(
    [row4.items[0].calls, row4.items[0].currentSessionCalls, row4.items[0].sessionsWithCalls,
      row4.items[0].callPresence, row4.items[0].zeroCall],
    [4, null, 2, null, false],
  )
  // 通道即使被宿主传了，`inWindow === false` 也**不得**让它变成数字（宁少报，不假报）
  assert.equal(row4.items[0].currentSessionCalls, null)
  assert.equal(row4.totals.currentSessionObservedCalls, null)

  // 行 5：inWindow === false ∧ calls === 0 ⇒ 覆盖 0，但本会话仍不可判定
  const row5 = reconcile({
    cwd: '/w', scope: outside, callsByName: {},
    sessionCoverage: {}, currentSessionCallsByName: {}, items: [{ ...item }],
  })
  assert.deepEqual(
    [row5.items[0].calls, row5.items[0].currentSessionCalls, row5.items[0].sessionsWithCalls,
      row5.items[0].callPresence, row5.items[0].zeroCall],
    [0, null, 0, null, true],
  )

  // 行 6：always-on / unobservable（calls === null）⇒ 三个新字段全 null
  const row6 = reconcile({
    cwd: '/w', scope: inWindow, callsByName: { bash: 3 },
    sessionCoverage: { bash: 1 }, currentSessionCallsByName: { bash: 1 },
    items: [
      { category: 'instructions', name: '/w/AGENTS.md', tokens: 100 },
      { category: 'skills', name: 'genui', tokens: 50 },
    ],
  })
  for (const entry of row6.items) {
    assert.equal(entry.calls, null)
    assert.equal(entry.currentSessionCalls, null)
    assert.equal(entry.sessionsWithCalls, null)
    assert.equal(entry.callPresence, null)
    assert.equal(entry.zeroCall, null)
  }
  assert.equal(row6.totals.currentSessionObservedCalls, null)

  // 行 7：no-evidence（sessionsScanned === 0）⇒ 同样全 null，且没有候选
  const row7 = reconcile({
    cwd: '/w',
    scope: { ...inWindow, sessionsScanned: 0, sessionsAvailable: 0 },
    callsByName: { bash: 3 },
    sessionCoverage: { bash: 1 }, currentSessionCallsByName: { bash: 1 },
    items: [{ ...item }],
  })
  assert.equal(row7.scope.usageAvailable, false)
  assert.equal(row7.items[0].usageBasis, 'no-evidence')
  assert.deepEqual(
    [row7.items[0].currentSessionCalls, row7.items[0].sessionsWithCalls, row7.items[0].callPresence],
    [null, null, null],
  )
  assert.deepEqual(row7.findings.zeroCall, [])
  assert.equal(row7.totals.currentSessionObservedCalls, null)
})

test('§7.1 规则 7（v4）：`scope.currentSession` 缺省填充、三条一致性与护栏', () => {
  const item = { category: 'tools', name: 'bash', tokens: 10 }

  // ① 缺字段 ⇒ 补 `{ id: null, basis: "unavailable", inWindow: false }`（**缺省填充**）
  const filled = reconcile({ cwd: '/w', scope: { sessionsScanned: 1 }, callsByName: { bash: 2 }, items: [{ ...item }] })
  assert.deepEqual(filled.scope.currentSession, { id: null, basis: 'unavailable', inWindow: false })
  assert.equal(filled.items[0].currentSessionCalls, null)

  // ② 宿主给了就原样透传（不得重写窗口/身份计数器）
  const passthrough = reconcile({
    cwd: '/w',
    scope: { sessionsScanned: 1, currentSession: { id: 'sess-a', basis: 'agent-session-id', inWindow: true } },
    callsByName: { bash: 2 },
    currentSessionCallsByName: { bash: 2 },
    items: [{ ...item }],
  })
  assert.deepEqual(passthrough.scope.currentSession, { id: 'sess-a', basis: 'agent-session-id', inWindow: true })
  assert.equal(passthrough.items[0].currentSessionCalls, 2)

  // ③ `inWindow === true` ⟺ 本会话计数通道可用（I4）；冲突时以 null 为准，**绝不升级为 0**
  const contradictory = reconcile({
    cwd: '/w',
    scope: { sessionsScanned: 1, currentSession: { id: 'sess-a', basis: 'agent-session-id', inWindow: true } },
    callsByName: { bash: 2 },
    items: [{ ...item }],
  })
  assert.equal(contradictory.scope.currentSession.inWindow, false)
  assert.equal(contradictory.items[0].currentSessionCalls, null)
  assert.equal(contradictory.items[0].callPresence, null)

  // ④ 通道给了但没声明 `inWindow === true` ⇒ 判定不了（不是 0）
  const channelOnly = reconcile({
    cwd: '/w',
    scope: { sessionsScanned: 1 },
    callsByName: { bash: 2 },
    currentSessionCallsByName: { bash: 2 },
    items: [{ ...item }],
  })
  assert.equal(channelOnly.items[0].currentSessionCalls, null)

  // ⑤ `id` 必须先过 `NAME_PATTERN`：不匹配按"取不到"处理（`null` + `unavailable`）
  for (const badId of ['has space', '中文会话', 'x'.repeat(129), '']) {
    const report = reconcile({
      cwd: '/w',
      scope: {
        sessionsScanned: 1,
        currentSession: { id: badId, basis: 'agent-session-id', inWindow: true },
      },
      callsByName: { bash: 2 },
      currentSessionCallsByName: { bash: 2 },
      items: [{ ...item }],
    })
    assert.deepEqual(report.scope.currentSession, { id: null, basis: 'unavailable', inWindow: false }, badId)
    assert.equal(report.items[0].currentSessionCalls, null)
  }

  // ⑥ 来源不明的 id（basis 越域/缺失）⇒ 不猜来源，按"取不到"处理；basis 越域必被规整
  for (const basis of [undefined, '', 'mtime-latest', 'unavailable']) {
    const report = reconcile({
      cwd: '/w',
      scope: { sessionsScanned: 1, currentSession: { id: 'sess-a', basis, inWindow: true } },
      callsByName: { bash: 2 },
      currentSessionCallsByName: { bash: 2 },
      items: [{ ...item }],
    })
    assert.deepEqual(report.scope.currentSession, { id: null, basis: 'unavailable', inWindow: false }, String(basis))
  }

  // ⑦ `basis === "unavailable"` ⟺ `id === null`（两条合法来源都必须保持成立）
  for (const [id, basis] of [['sess-a', 'agent-session-id'], ['sess-b', 'http-session-param']]) {
    const report = reconcile({
      cwd: '/w',
      scope: { sessionsScanned: 1, currentSession: { id, basis, inWindow: true } },
      callsByName: { bash: 2 },
      currentSessionCallsByName: { bash: 2 },
      items: [{ ...item }],
    })
    assert.deepEqual(report.scope.currentSession, { id, basis, inWindow: true })
  }
})

test('§2.2 W1–W6（v4）：窗口字段是宿主传入的事实 + 常量，缺省按 W4 补出', () => {
  const item = { category: 'tools', name: 'bash', tokens: 10 }

  // ① `windowBasis` 恒为常量（无论宿主给什么，W6 不允许别的取值）
  const basis = reconcile({ cwd: '/w', scope: { sessionsScanned: 1, windowBasis: 'whatever' }, callsByName: {}, items: [{ ...item }] })
  assert.equal(basis.scope.windowBasis, 'session-log-mtime')

  // ② W4：缺省时按 `available − scanned − unreadable` 补出（不变量机械成立）
  const derived = reconcile({
    cwd: '/w',
    scope: { sessionsScanned: 20, sessionsUnreadable: 1, sessionsAvailable: 41, sessionsLimit: 21 },
    callsByName: {}, items: [{ ...item }],
  })
  assert.equal(derived.scope.sessionsOutsideWindow, 20)
  assert.equal(
    derived.scope.sessionsAvailable,
    derived.scope.sessionsScanned + derived.scope.sessionsUnreadable + derived.scope.sessionsOutsideWindow,
  )
  assert.ok(derived.scope.sessionsScanned + derived.scope.sessionsUnreadable <= derived.scope.sessionsLimit)

  // ③ 宿主给了就照抄（"输入即事实"，§7.1 规则 4/§7.2）
  const given = reconcile({
    cwd: '/w',
    scope: { sessionsScanned: 20, sessionsUnreadable: 0, sessionsAvailable: 41, sessionsOutsideWindow: 21 },
    callsByName: {}, items: [{ ...item }],
  })
  assert.equal(given.scope.sessionsOutsideWindow, 21)

  // ④ W1/W3：`sessionsScanned === 0` 时边界为 null（降级态：没有窗口，也就没有边界）
  const degraded = reconcile({
    cwd: '/w',
    scope: { sessionsScanned: 0, sessionsAvailable: 0, windowStart: null, windowEnd: null },
    callsByName: {}, items: [{ ...item }],
  })
  assert.equal(degraded.scope.windowStart, null)
  assert.equal(degraded.scope.windowEnd, null)
  assert.equal(degraded.scope.windowBasis, 'session-log-mtime') // W3 不豁免窗口口径
  assert.equal(degraded.findings.zeroCallBasis, 'model-tool-calls-in-window')
})

test('使用次数语义：§2.4 赋值优先级互斥且逐条落地', () => {
  const report = reconcile({
    cwd: '/w',
    scope: { sessionsScanned: 2, sessionsAvailable: 2, linesRead: 10 },
    callsByName: { bash: 0, grep: 5 },
    items: [
      { category: 'instructions', name: '/w/AGENTS.md', tokens: 100 },
      { category: 'skills', name: 'genui', tokens: 50 },
      { category: 'tools', name: 'bash', tokens: 40 },
      { category: 'tools', name: 'grep', tokens: 30 },
      { category: 'tools', name: 'weird name with spaces', tokens: 20 },
    ],
  })
  const byId = new Map(report.items.map(item => [item.id, item]))

  assert.deepEqual(
    [byId.get('instructions:/w/AGENTS.md').usageBasis, byId.get('instructions:/w/AGENTS.md').calls,
      byId.get('instructions:/w/AGENTS.md').zeroCall],
    ['always-on', null, null],
  )
  assert.deepEqual(
    [byId.get('skills:genui').usageBasis, byId.get('skills:genui').calls, byId.get('skills:genui').zeroCall],
    ['unobservable', null, null],
  )
  assert.deepEqual(
    [byId.get('tools:bash').usageBasis, byId.get('tools:bash').calls, byId.get('tools:bash').zeroCall],
    ['tool-calls', 0, true],
  )
  assert.deepEqual(
    [byId.get('tools:grep').usageBasis, byId.get('tools:grep').calls, byId.get('tools:grep').zeroCall],
    ['tool-calls', 5, false],
  )
  assert.deepEqual(
    [byId.get('tools:weird name with spaces').usageBasis, byId.get('tools:weird name with spaces').calls,
      byId.get('tools:weird name with spaces').zeroCall],
    ['unobservable', null, null],
  )
  assert.equal(report.scope.namesRejected, 1)
  assert.deepEqual(report.findings.zeroCall.map(item => item.id), ['tools:bash'])
  assert.deepEqual(report.findings.topPerUse.map(item => item.id), ['tools:grep'])
  // 名字没过护栏的常驻项：归属照给（归属来自安装侧），但缺省为 unknown
  assert.deepEqual(byId.get('tools:weird name with spaces').providedBy, {
    kind: 'unknown', name: null, confidence: 'low', method: 'not-found', evidenceFile: null, candidates: [],
  })
})

test('零调用识别：calls === null 绝不当成 0，绝不进 findings.zeroCall / prunePlan', () => {
  const withEvidence = reconcile({
    cwd: '/w',
    scope: { sessionsScanned: 1 },
    callsByName: {},
    items: [{ category: 'tools', name: 'bash', tokens: 10 }],
  })
  assert.equal(withEvidence.items[0].calls, 0)
  assert.equal(withEvidence.items[0].zeroCall, true)
  assert.equal(withEvidence.items[0].tokensPerCall, null) // 除零保护

  const withoutEvidence = reconcile({
    cwd: '/w',
    scope: { sessionsScanned: 0, sessionsAvailable: 3, sessionsUnreadable: 3 },
    callsByName: {},
    items: [
      { category: 'tools', name: 'bash', tokens: 10 },
      { category: 'mcp', name: 'mcp__s__t', tokens: 20, server: 's' },
      { category: 'instructions', name: '/w/AGENTS.md', tokens: 30 },
      { category: 'skills', name: 'genui', tokens: 40 },
    ],
  })
  assert.equal(withoutEvidence.scope.usageAvailable, false)
  assert.deepEqual(withoutEvidence.findings.zeroCall, [])
  assert.deepEqual(withoutEvidence.findings.topPerUse, [])
  assert.deepEqual(withoutEvidence.findings.prunePlan, [])
  assert.equal(withoutEvidence.findings.prunePlanReclaimableTokens, 0)
  assert.deepEqual(withoutEvidence.findings.noRecommendation, [
    { reason: 'core', items: 0, tokens: 0 },
    { reason: 'no-owner-bundle', items: 0, tokens: 0 },
    { reason: 'unknown-attribution', items: 0, tokens: 0 },
  ])
  assert.deepEqual(withoutEvidence.totals, {
    residentTokens: 100,
    observableTokens: 0,
    unknownUsageTokens: 100,
    observedCalls: 0,
    // v4：无证据 ⇒ 本会话维度也**给不出**（null，不是 0）
    currentSessionObservedCalls: null,
    observableTokensPerCall: null,
    zeroCallItems: 0,
    zeroCallTokens: 0,
    unknownUsageItems: 4,
  })
  for (const item of withoutEvidence.items) {
    if (item.category === 'tools' || item.category === 'mcp') {
      assert.equal(item.usageBasis, 'no-evidence')
      assert.equal(item.calls, null)
      assert.equal(item.zeroCall, null)
    }
  }
  // 方法可观测 vs 本轮有证据：两个维度不得互相覆盖（DESIGN §2.12）
  const tools = withoutEvidence.categories.find(entry => entry.key === 'tools')
  assert.equal(tools.observableUsage, true)
  assert.equal(tools.calls, null)
  assert.equal(tools.tokensPerCall, null)
})

test('每次使用成本排序：用未取整比值排，输出字段用 Math.round', () => {
  const report = reconcile({
    cwd: '/w',
    scope: { sessionsScanned: 1 },
    // A: 100/3 = 33.33 → 33；B: 101/3 = 33.67 → 34；C: 67/2 = 33.5 → 34
    callsByName: { a: 3, b: 3, c: 2 },
    items: [
      { category: 'tools', name: 'a', tokens: 100 },
      { category: 'tools', name: 'b', tokens: 101 },
      { category: 'tools', name: 'c', tokens: 67 },
    ],
  })
  assert.deepEqual(report.findings.topPerUse.map(item => item.name), ['b', 'c', 'a'])
  assert.deepEqual(report.findings.topPerUse.map(item => item.tokensPerCall), [34, 34, 33])
  assert.equal(report.findings.topPerUse[0].tokensPerCall, report.findings.topPerUse[1].tokensPerCall)
})

test('排序是全序：同比值同 tokens 时用 id 升序兜底，输出字节级稳定', () => {
  const build = () => reconcile({
    cwd: '/w',
    scope: { sessionsScanned: 1 },
    callsByName: { b: 2, a: 2 },
    items: [
      { category: 'tools', name: 'b', tokens: 10 },
      { category: 'tools', name: 'a', tokens: 10 },
    ],
  })
  assert.deepEqual(build().items.map(item => item.id), ['tools:a', 'tools:b'])
  const first = JSON.stringify({ ...build(), generatedAt: 'x' })
  const second = JSON.stringify({ ...build(), generatedAt: 'x' })
  assert.equal(first, second)
})

test('findings 上限：zeroCall / topPerUse 各取前 10 条（prunePlan 不截断）', () => {
  const items = []
  const callsByName = {}
  for (let i = 0; i < 15; i += 1) {
    items.push({ category: 'tools', name: `never${i}`, tokens: 1000 - i })
    items.push({ category: 'tools', name: `used${i}`, tokens: 100 - i })
    callsByName[`used${i}`] = 1 + i
  }
  const report = reconcile({ cwd: '/w', scope: { sessionsScanned: 1 }, callsByName, items })
  assert.equal(FINDINGS_LIMIT, 10)
  assert.equal(report.findings.zeroCall.length, 10)
  assert.equal(report.findings.topPerUse.length, 10)
  assert.equal(report.findings.zeroCall[0].name, 'never0') // tokens 降序
  assert.equal(report.findings.topPerUse[0].name, 'used0') // 比值 (100-0)/(1+0) 最大
  // 归属未知的零调用项不给动作，全部落进 noRecommendation（不受 FINDINGS_LIMIT 影响）
  assert.deepEqual(report.findings.prunePlan, [])
  assert.equal(report.findings.noRecommendation[2].reason, 'unknown-attribution')
  assert.equal(report.findings.noRecommendation[2].items, 15)
  // 归属未知的零调用项不给动作，全部落进 noRecommendation（不受 FINDINGS_LIMIT 影响）
  assert.deepEqual(report.findings.prunePlan, [])
  assert.equal(report.findings.noRecommendation[2].reason, 'unknown-attribution')
  assert.equal(report.findings.noRecommendation[2].items, 15)
  assert.deepEqual(Object.keys(report.findings.zeroCall[0]), ['id', 'category', 'name', 'tokens'])
  assert.deepEqual(
    Object.keys(report.findings.topPerUse[0]),
    ['id', 'category', 'name', 'tokens', 'calls', 'tokensPerCall'],
  )
})

test('省额不重复计入：同一单元的多个事实包合成一条、每项全局只出现一次', () => {
  const provenance = {
    byName: {
      tb_a: { kind: 'plugin', name: '@scope/task-board-a', confidence: 'high', method: 'static-scan', evidenceFile: '/p/a.js', candidates: [] },
      tb_b: { kind: 'plugin', name: '@scope/task-board-b', confidence: 'low', method: 'static-scan-weak', evidenceFile: '/p/b.js', candidates: [] },
      tb_used: { kind: 'plugin', name: '@scope/task-board-a', confidence: 'high', method: 'static-scan', evidenceFile: '/p/a.js', candidates: [] },
      'mcp__srv__x': { kind: 'mcp-server', name: 'srv', confidence: 'high', method: 'mcp-naming', evidenceFile: null, candidates: [] },
      core_tool: { kind: 'core', name: null, confidence: 'high', method: 'static-scan', evidenceFile: '/c/x.js', candidates: [] },
      gone_tool: { kind: 'plugin', name: '@scope/orphan', confidence: 'high', method: 'static-scan', evidenceFile: '/p/o.js', candidates: [] },
      mystery: { kind: 'unknown', name: null, confidence: 'low', method: 'static-scan-weak', evidenceFile: null, candidates: ['@scope/x'] },
    },
    bundleOwners: {
      // 两个事实包属于同一个 bundle → 必须合成**一条**条目
      '@scope/task-board-a': { owner: '@scope/web-all', removable: true },
      '@scope/task-board-b': { owner: '@scope/web-all', removable: true },
      // 找不到唯一可卸载单元
      '@scope/orphan': { owner: null, removable: false },
    },
  }
  const report = reconcile({
    cwd: '/w',
    scope: { sessionsScanned: 1, toolCalls: 0 },
    callsByName: { tb_used: 4 }, // 唯一在用的工具（同单元）
    provenance,
    items: [
      { category: 'tools', name: 'tb_a', tokens: 100 },
      { category: 'tools', name: 'tb_b', tokens: 50 },
      { category: 'tools', name: 'tb_used', tokens: 30 },
      { category: 'mcp', name: 'mcp__srv__x', tokens: 70, server: 'srv' },
      { category: 'tools', name: 'core_tool', tokens: 20 },
      { category: 'tools', name: 'gone_tool', tokens: 10 },
      { category: 'tools', name: 'mystery', tokens: 5 },
    ],
  })

  // 只有两个可执行单元：@scope/web-all（两个事实包合成一条）与 MCP server
  assert.deepEqual(report.findings.prunePlan.map(entry => [entry.kind, entry.target]), [
    ['plugin', '@scope/web-all'],
    ['mcp-server', 'srv'],
  ])
  assert.deepEqual(report.findings.prunePlan[0].factPackages, ['@scope/task-board-a', '@scope/task-board-b'])
  assert.deepEqual(report.findings.prunePlan[0].items.map(item => item.id), ['tools:tb_a', 'tools:tb_b'])
  assert.equal(report.findings.prunePlan[0].reclaimableTokens, 150) // 100 + 50，逐项自身 token，不乘倍数
  assert.equal(report.findings.prunePlan[0].usedToolCount, 1) // tb_used 仍在用 → 卸载代价信号
  assert.equal(report.findings.prunePlan[0].confidence, 'low') // 取最弱一环（tb_b 是 low）

  // 每条目内没有重复，跨条目也没有重复（同一项至多出现一次）
  const ids = report.findings.prunePlan.flatMap(entry => entry.items.map(item => item.id))
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(new Set(report.findings.prunePlan.map(entry => entry.target)).size, report.findings.prunePlan.length)

  // 三类不给动作的理由分别计数（核心 / 找不到唯一单元 / 归属未知）
  assert.deepEqual(report.findings.noRecommendation, [
    { reason: 'core', items: 1, tokens: 20 },
    { reason: 'no-owner-bundle', items: 1, tokens: 10 },
    { reason: 'unknown-attribution', items: 1, tokens: 5 },
  ])

  // 恒等式：省额 = 这些候选自身的 token 之和；与 noRecommendation 相加 = 全部零调用 token
  const pruneTokens = report.findings.prunePlan.reduce((sum, entry) => sum + entry.reclaimableTokens, 0)
  const noRecTokens = report.findings.noRecommendation.reduce((sum, entry) => sum + entry.tokens, 0)
  const noRecItems = report.findings.noRecommendation.reduce((sum, entry) => sum + entry.items, 0)
  const pruneItems = report.findings.prunePlan.reduce((sum, entry) => sum + entry.itemCount, 0)
  assert.equal(report.findings.prunePlanReclaimableTokens, pruneTokens)
  assert.equal(pruneTokens, 100 + 50 + 70)
  assert.equal(pruneTokens + noRecTokens, report.totals.zeroCallTokens)
  assert.equal(pruneItems + noRecItems, report.totals.zeroCallItems)
  assert.equal(report.totals.zeroCallItems, 6)
  assert.equal(report.totals.zeroCallTokens, 255)

  // §2.16 恒等式 2 在**存在孤儿 plugin 包**时不成立（左 220 < 右 230）：
  // §2.15 的排除表要求"找不到唯一可卸载 bundle 的 plugin 项"不给动作。
  // 这是契约内部的条件性，不是实现缺陷——详见 IMPLEMENTATION-NOTES F5。
  const pluginOrMcpZero = report.items
    .filter(item => item.zeroCall === true && (item.providedBy.kind === 'plugin' || item.providedBy.kind === 'mcp-server'))
    .reduce((sum, item) => sum + item.tokens, 0)
  assert.equal(pluginOrMcpZero, 230)
  assert.equal(pruneTokens, 220)
  // 无孤儿包时（§2.9 黄金样例、本机实测）恒等式 2 成立
  assert.equal(report.findings.noRecommendation[1].items, 1)
})

test('降级态：无日志证据时仍输出 4 条 categories，工具/MCP 不报零调用也不出候选', () => {
  const report = reconcile({
    cwd: EXAMPLE_CWD,
    sessionsRoot: EXAMPLE_SESSIONS_ROOT,
    scope: {
      ...exampleScope(),
      sessionsAvailable: 0, sessionsScanned: 0, sessionsUnreadable: 0,
      linesRead: 0, skillToolCalls: 0, toolCalls: 0,
    },
    callsByName: {},
    provenance: exampleProvenance(),
    items: exampleItems(),
  })
  assert.equal(report.scope.usageAvailable, false)
  assert.equal(report.scope.toolCalls, 0)
  assert.deepEqual(report.findings.zeroCall, [])
  assert.deepEqual(report.findings.prunePlan, [])
  assert.equal(report.findings.prunePlanReclaimableTokens, 0)
  assert.equal(report.totals.unknownUsageItems, 16)
  assert.equal(report.totals.residentTokens, 4460)
  assert.equal(report.totals.observableTokensPerCall, null)
  assert.equal(report.categories.length, 4)
  assert.equal(report.categories.find(entry => entry.key === 'tools').observableUsage, true)
  assert.ok(report.items.every(item => item.zeroCall === null))
  // 归属与调用次数无关：日志不可读时归属照常给出（§2.12 注 ②）
  const scheduled = report.items.find(item => item.name === 'task_board_schedule')
  assert.equal(scheduled.providedBy.kind, 'plugin')
  assert.equal(scheduled.usageBasis, 'no-evidence')
})

test('健壮性：未知 category 显式失败，脏项跳过，id 与 providedBy 都不采信脏输入', () => {
  assert.throws(
    () => reconcile({ cwd: '/w', scope: { sessionsScanned: 1 }, items: [{ category: 'nope', name: 'x', tokens: 1 }] }),
    /unknown category/,
  )
  const report = reconcile({
    cwd: '/w',
    scope: { sessionsScanned: 1 },
    items: [null, 'x', { category: 'tools', name: 'bash' }],
  })
  assert.equal(report.items.length, 1)
  assert.equal(report.items[0].tokens, 0)
  assert.equal(report.items[0].id, 'tools:bash')

  const spoofed = reconcile({
    cwd: '/w',
    scope: { sessionsScanned: 1 },
    callsByName: { bash: 1 },
    provenance: { byName: { bash: { kind: 'not-a-kind' } } },
    items: [{ id: 'tools:has space and 中文', category: 'tools', name: 'bash', tokens: 10 }],
  })
  assert.equal(spoofed.items[0].id, 'tools:bash')
  assert.equal(spoofed.items[0].providedBy.kind, 'unknown')
  assert.equal(JSON.stringify(spoofed).includes('中文'), false)
})

test('scope 兜底：workspaceKey 由 cwd 现算，providerScan 缺省为零值', () => {
  const report = reconcile({
    cwd: EXAMPLE_CWD,
    scope: { sessionsScanned: 1 },
    items: [{ category: 'tools', name: 'bash', tokens: 1 }],
  })
  assert.equal(report.scope.workspaceKey, '--home-u-Desktop-DSHWorkspace--')
  assert.equal(report.scope.sessionsRoot, '')
  assert.equal(report.scope.usageAvailable, true)
  assert.equal(report.scope.windowStart, null)
  assert.equal(report.scope.windowEnd, null)
  assert.equal(report.scope.sessionsLimit, 0)
  assert.deepEqual(report.scope.providerScan, { packages: 0, files: 0, bytes: 0, capped: false })
})

test('常量与标识冻结（v2）', () => {
  assert.equal(LEDGER_TOOL, 'context_ledger')
  assert.equal(LEDGER_VERSION, 4)
  assert.equal(LEDGER_UNIT, 'token')
  assert.equal(ESTIMATOR, 'heuristic-v1')
  assert.deepEqual([...CATEGORY_KEYS], ['instructions', 'skills', 'tools', 'mcp'])
})

// ─────────────────────────────────────────────────────────────────────────────
// R6（v3）黄金样例：DESIGN §2.21 的 A1–A18 与恒等式 H1–H7
// ─────────────────────────────────────────────────────────────────────────────

const EXAMPLE_EVIDENCE = '/home/u/.dsh/profiles/web/node_modules'
const TB = '@linxin666/dsh-client-ui-task-board'
const TBG = '@linxin666/dsh-client-ui-task-board-github'
const WEB_ALL = '@linxin666/dsh-web-all'

/** §2.21 的 24 个零调用工具：`[name, category, tokens]`（真机口径 + 合成载荷，合计与真机一致）。 */
const R6_ZERO_CALL = [
  ['mcp__openviking__add_resource', 'mcp', 891],
  ['mcp__openviking__add_skill', 'mcp', 464],
  ['subagent', 'tools', 402],
  ['task_board_github_repositories', 'tools', 331],
  ['task_board_github_link_pr', 'tools', 298],
  ['task_board_schedule', 'tools', 274],
  ['task_board_run', 'tools', 242],
  ['modlens_read_image', 'tools', 156],
  ['validate_dsh_ui', 'tools', 133],
  ['read_mcp_resource', 'tools', 128],
  ['mcp__openviking__tree', 'mcp', 122],
  ['task_board_github_refresh', 'tools', 110],
  ['list_mcp_resources', 'tools', 96],
  ['annotation', 'tools', 88],
  ['list_mcp_resource_templates', 'tools', 88],
  ['mcp__openviking__forget', 'mcp', 75],
  ['interrupt_agent', 'tools', 74],
  ['task_board_set_parent', 'tools', 70],
  ['job_kill', 'tools', 52],
  ['mcp__openviking__remember', 'mcp', 47],
  ['update_goal', 'tools', 45],
  ['mcp__openviking__cancel_watch', 'mcp', 30],
  ['mcp__openviking__list_watches', 'mcp', 27],
  ['mcp__openviking__health', 'mcp', 18],
]

/** 24 个零调用项的归属（§2.21 的 unit 列）。 */
const R6_UNITS = {
  mcp__openviking__add_resource: ['mcp-server', 'openviking'],
  mcp__openviking__add_skill: ['mcp-server', 'openviking'],
  mcp__openviking__tree: ['mcp-server', 'openviking'],
  mcp__openviking__forget: ['mcp-server', 'openviking'],
  mcp__openviking__remember: ['mcp-server', 'openviking'],
  mcp__openviking__cancel_watch: ['mcp-server', 'openviking'],
  mcp__openviking__list_watches: ['mcp-server', 'openviking'],
  mcp__openviking__health: ['mcp-server', 'openviking'],
  subagent: ['unknown', null],
  modlens_read_image: ['plugin', '@liustack/modlens'],
  validate_dsh_ui: ['plugin', '@changfenhuang/dsh-genui'],
  annotation: ['plugin', 'dsh-annotate'],
  read_mcp_resource: ['core', null],
  list_mcp_resources: ['core', null],
  list_mcp_resource_templates: ['core', null],
  interrupt_agent: ['core', null],
  job_kill: ['core', null],
  update_goal: ['core', null],
}
for (const name of ['task_board_github_repositories', 'task_board_github_link_pr', 'task_board_github_refresh']) {
  R6_UNITS[name] = ['plugin', TBG]
}
for (const name of ['task_board_schedule', 'task_board_run', 'task_board_set_parent']) {
  R6_UNITS[name] = ['plugin', TB]
}

function r6ProvidedBy(name) {
  const [kind, pkg] = R6_UNITS[name] ?? ['unknown', null]
  if (kind === 'mcp-server') {
    return { kind, name: pkg, confidence: 'high', method: 'mcp-naming', evidenceFile: null, candidates: [] }
  }
  if (kind === 'plugin') {
    // modlens 在真机上是**弱级**命中（plugin/low），其余事实包为强级命中。
    const weak = pkg === '@liustack/modlens'
    return {
      kind, name: pkg, confidence: weak ? 'low' : 'high',
      method: weak ? 'static-scan-weak' : 'static-scan',
      evidenceFile: `${EXAMPLE_EVIDENCE}/${pkg}/lib/index.js`, candidates: [],
    }
  }
  if (kind === 'core') {
    return { kind, name: null, confidence: 'high', method: 'static-scan', evidenceFile: `${EXAMPLE_EVIDENCE}/core.js`, candidates: [] }
  }
  return {
    kind: 'unknown', name: null, confidence: 'low', method: 'static-scan-weak', evidenceFile: null,
    candidates: [
      '@linxin666/dsh-pet', '@linxin666/dsh-session-archive', '@linxin666/dsh-web-all',
      '@nanmicoder/dsh-agent-teams', '@openviking/dsh-memory-plugin', 'dsh-context', 'dshmarket',
    ],
  }
}

/** 让 `usedToolCount` 等于 §2.21 的真机值（openviking 8 / web-all 3 / genui 1）。 */
function r6UsedItems() {
  const used = []
  for (let i = 0; i < 8; i += 1) {
    used.push({ category: 'mcp', name: `mcp__openviking__used_${i}`, tokens: 10 + i, server: 'openviking' })
  }
  for (const name of ['task_board_create', 'task_board_update', 'task_board_list']) {
    used.push({ category: 'tools', name, tokens: 111 })
  }
  used.push({ category: 'tools', name: 'render_ui', tokens: 90 })
  return used
}

function r6GoldenInput() {
  const items = []
  for (const [name, category, tokens] of R6_ZERO_CALL) {
    items.push({ category, name, tokens, ...(category === 'mcp' ? { server: 'openviking' } : {}) })
  }
  items.push(...r6UsedItems())
  const byName = {}
  for (const [name] of R6_ZERO_CALL) byName[name] = r6ProvidedBy(name)
  for (const item of r6UsedItems()) {
    byName[item.name] = item.category === 'mcp'
      ? { kind: 'mcp-server', name: 'openviking', confidence: 'high', method: 'mcp-naming', evidenceFile: null, candidates: [] }
      : { kind: 'plugin', name: item.name === 'render_ui' ? '@changfenhuang/dsh-genui' : TB, confidence: 'high', method: 'static-scan', evidenceFile: `${EXAMPLE_EVIDENCE}/${TB}/lib/index.js`, candidates: [] }
  }
  const callsByName = {}
  for (const item of r6UsedItems()) callsByName[item.name] = 3
  return {
    cwd: EXAMPLE_CWD,
    sessionsRoot: EXAMPLE_SESSIONS_ROOT,
    scope: { sessionsScanned: 1, toolCalls: 12, callsUnmatched: 0, namesRejected: 0, linesRead: 100 },
    callsByName,
    provenance: {
      byName,
      bundleOwners: {
        [TB]: { owner: WEB_ALL, removable: true },
        [TBG]: { owner: WEB_ALL, removable: true },
        '@liustack/modlens': { owner: '@liustack/modlens', removable: true },
        '@changfenhuang/dsh-genui': { owner: '@changfenhuang/dsh-genui', removable: true },
        'dsh-annotate': { owner: 'dsh-annotate', removable: true },
      },
      weakEvidence: {
        subagent: [
          '/home/u/.dsh/profiles/web/node_modules/@nanmicoder/dsh-agent-teams/lib/harness-compat.js',
          '/home/u/.dsh/profiles/web/node_modules/@linxin666/dsh-session-archive/lib/index.js',
        ],
      },
    },
    hide: {
      status: 'prechecked',
      restrictableNames: [...R6_ZERO_CALL.map(entry => entry[0]), ...r6UsedItems().map(item => item.name)],
      mode: 'suggestion-only',
    },
    items,
  }
}

function r6GoldenReport() {
  return reconcile(r6GoldenInput())
}

test('R6 黄金样例：DESIGN §2.21 的 A1–A18 逐条成立', () => {
  const report = r6GoldenReport()
  const findings = report.findings
  const pruneTokens = findings.prunePlan.reduce((sum, entry) => sum + entry.reclaimableTokens, 0)
  const pruneItems = findings.prunePlan.reduce((sum, entry) => sum + entry.itemCount, 0)
  const noRecItems = findings.noRecommendation.reduce((sum, entry) => sum + entry.items, 0)
  const unitTokens = findings.hidePlanUnits.reduce((sum, entry) => sum + entry.tokens, 0)
  const unitTools = findings.hidePlanUnits.reduce((sum, entry) => sum + entry.toolCount, 0)

  assert.equal(report.version, 4)
  assert.equal(findings.hidePlan.length, 24)
  assert.equal(findings.hidePlanTokens, 4261) // A1 / A2
  assert.equal(findings.hidePlan.reduce((sum, entry) => sum + entry.tokens, 0), 4261)
  assert.equal(unitTokens, 4261) // A3
  assert.equal(unitTools, 24) // A4
  assert.equal(pruneTokens, 3376) // A5
  assert.equal(pruneTokens + findings.noRecommendation.reduce((sum, entry) => sum + entry.tokens, 0), 4261) // A6
  assert.equal(pruneItems + noRecItems, 24) // A7
  assert.equal(findings.hideApply.denyList.length + findings.hideApply.skipped.length, 24) // A8

  // A9 · hidePlan 顺序（tokens 降序 → name 升序）
  assert.deepEqual(findings.hidePlan.map(entry => entry.name), [
    'mcp__openviking__add_resource', 'mcp__openviking__add_skill', 'subagent', 'task_board_github_repositories',
    'task_board_github_link_pr', 'task_board_schedule', 'task_board_run', 'modlens_read_image', 'validate_dsh_ui',
    'read_mcp_resource', 'mcp__openviking__tree', 'task_board_github_refresh', 'list_mcp_resources', 'annotation',
    'list_mcp_resource_templates', 'mcp__openviking__forget', 'interrupt_agent', 'task_board_set_parent', 'job_kill',
    'mcp__openviking__remember', 'update_goal', 'mcp__openviking__cancel_watch', 'mcp__openviking__list_watches',
    'mcp__openviking__health',
  ])
  // A10 · hidePlanUnits 顺序与形状
  assert.deepEqual(findings.hidePlanUnits.map(entry => [entry.kind, entry.target, entry.toolCount, entry.tokens, entry.usedToolCount, entry.inPrunePlan]), [
    ['mcp-server', 'openviking', 8, 1674, 8, true],
    ['plugin', WEB_ALL, 6, 1325, 3, true],
    ['core', null, 6, 483, 0, false],
    ['unknown', null, 1, 402, 0, false],
    ['plugin', '@liustack/modlens', 1, 156, 0, true],
    ['plugin', '@changfenhuang/dsh-genui', 1, 133, 1, true],
    ['plugin', 'dsh-annotate', 1, 88, 0, true],
  ])
  assert.deepEqual(findings.hidePlanUnits[1].factPackages, [TB, TBG])

  // A11 · inPrunePlan === true 的单元集合 = prunePlan 的 (kind,target) 集合
  assert.deepEqual(
    findings.hidePlanUnits.filter(entry => entry.inPrunePlan).map(entry => `${entry.kind}:${entry.target}`).sort(),
    findings.prunePlan.map(entry => `${entry.kind}:${entry.target}`).sort(),
  )

  // A12 · hidePlan 的 {id,name,tokens} 与 items 逐字一致
  const itemById = new Map(report.items.map(item => [item.id, item]))
  for (const entry of findings.hidePlan) {
    const item = itemById.get(entry.id)
    assert.ok(item !== undefined, `${entry.id} 应存在于 items`)
    assert.equal(entry.name, item.name)
    assert.equal(entry.tokens, item.tokens)
    assert.equal(entry.category, item.category)
  }

  // A13 · unit.kind ∈ 4 值域；target 非 null ⟹ kind ∈ {plugin, mcp-server}
  for (const entry of findings.hidePlan) {
    assert.ok(['plugin', 'core', 'mcp-server', 'unknown'].includes(entry.unit.kind))
    if (entry.unit.target !== null) assert.ok(['plugin', 'mcp-server'].includes(entry.unit.kind))
  }

  // A14 · caveat 五键齐全
  assert.deepEqual(findings.hidePlanCaveat, {
    registryHideIsTotal: true,
    nonModelRegistryCalls: 'unobservable',
    serviceCoupling: 'unconfirmed',
    confirmationRequired: true,
    prefixCacheCost: 'one-time-invalidation',
  })

  // A15 / A16 · denyList 升序去重，且等于 hidePlan 名字全集（示例中全部通过预校验）
  assert.deepEqual(findings.hideApply.denyList, [...new Set(findings.hideApply.denyList)].sort())
  assert.deepEqual(findings.hideApply.denyList, findings.hidePlan.map(entry => entry.name).slice().sort())

  // A17 · items 里的零调用工具数 = hidePlan 长度 = 24
  assert.equal(report.items.filter(item => item.zeroCall === true).length, 24)
  assert.equal(findings.hidePlan.length, 24)

  /* A18（v4 补入的清单点）· `nameReferencedElsewhere` 升序去重且 ≤3（§2.19）。
   * 这个不变量住在宿主半区（lib/hide.js 的 uniqueSorted(...).slice(0, NAME_REFERENCED_LIMIT)），
   * 因此除了在面板侧机械拦住 DESIGN 与夹具，这里还要在**实现所在的一侧**测它。 */
  for (const entry of findings.hidePlan) {
    const referenced = entry.registryUse.nameReferencedElsewhere
    assert.ok(referenced.length <= 3, `${entry.name}: 弱命中必须 ≤3（§2.19）`)
    assert.deepEqual(referenced, [...referenced].sort(), `${entry.name}: 弱命中必须升序（§2.19）`)
    assert.deepEqual(referenced, [...new Set(referenced)], `${entry.name}: 弱命中必须去重（§2.19）`)
  }
  assert.deepEqual(findings.hidePlan.find(entry => entry.name === 'subagent').registryUse.nameReferencedElsewhere, [
    `${EXAMPLE_EVIDENCE}/@linxin666/dsh-session-archive/lib/index.js`,
    `${EXAMPLE_EVIDENCE}/@nanmicoder/dsh-agent-teams/lib/harness-compat.js`,
  ], 'A18：示例里唯一非空项按升序落值')
  /* 乱序 + 重复输入 ⇒ 升序去重后截断到 3（实测行为，不是照抄契约文字） */
  const scrambled = reconcile({
    cwd: EXAMPLE_CWD,
    scope: { sessionsScanned: 1, toolCalls: 1, callsUnmatched: 0, namesRejected: 0, linesRead: 10 },
    callsByName: {},
    provenance: {
      byName: {
        scrambled_tool: { kind: 'core', name: null, confidence: 'high', method: 'static-scan', evidenceFile: null, candidates: [] },
      },
      bundleOwners: {},
      weakEvidence: { scrambled_tool: ['/z/last.js', '/a/first.js', '/m/middle.js', '/a/first.js', '/b/second.js'] },
    },
    hide: { status: 'prechecked', restrictableNames: ['scrambled_tool'], mode: 'suggestion-only' },
    items: [{ category: 'tools', name: 'scrambled_tool', tokens: 100 }],
  })
  assert.deepEqual(scrambled.findings.hidePlan[0].registryUse.nameReferencedElsewhere,
    ['/a/first.js', '/b/second.js', '/m/middle.js'], 'A18：实现把乱序/重复输入排成升序去重并截断到 3')

  // H1–H7（§2.20）
  assert.equal(findings.hidePlanTokens, findings.hidePlan.reduce((sum, entry) => sum + entry.tokens, 0)) // H1
  assert.equal(findings.hidePlanTokens, report.totals.zeroCallTokens) // H2（instructions/skills 恒为 null）
  assert.equal(
    findings.hidePlanTokens,
    report.items.filter(item => item.zeroCall === true && (item.category === 'tools' || item.category === 'mcp'))
      .reduce((sum, item) => sum + item.tokens, 0),
  ) // H3
  assert.equal(unitTokens, findings.hidePlanTokens) // H4
  assert.equal(unitTools, findings.hidePlan.length)
  const denySet = new Set(findings.hideApply.denyList)
  assert.ok(findings.hideApply.denyList.every(name => findings.hidePlan
    .find(entry => entry.name === name).precheck.restrictable === true)) // H6
  assert.equal(denySet.size + findings.hideApply.skipped.length, findings.hidePlan.length)
  // H7：没有证据就没有候选
  const noEvidence = reconcile({
    cwd: EXAMPLE_CWD,
    scope: { sessionsScanned: 0 },
    callsByName: {},
    items: R6_ZERO_CALL.map(([name, category, tokens]) => ({ category, name, tokens })),
  })
  assert.deepEqual(noEvidence.findings.hidePlan, [])
  assert.equal(noEvidence.findings.hidePlanTokens, 0)
  assert.deepEqual(noEvidence.findings.hideApply.denyList, [])
})

test('R6：默认只输出建议，绝不自动施加（H4 / 四条硬约束的产物侧）', () => {
  const report = r6GoldenReport()
  // 即使名字全部通过预校验、清单完全可施加，`appliedNames` 仍恒为 []
  assert.equal(report.findings.hideApply.mode, 'suggestion-only')
  assert.deepEqual(report.findings.hideApply.appliedNames, [])
  assert.deepEqual(report.findings.hideApply.skipped, [])
  assert.equal(report.findings.hideApply.applySupported, true)
  assert.equal(report.findings.hidePlanStatus, 'prechecked')
  // 缺省（调用方什么都没给）⇒ unsupported + 不施加
  const bare = reconcile({
    cwd: '/w', scope: { sessionsScanned: 1 }, callsByName: {},
    items: [{ category: 'tools', name: 'x_tool', tokens: 10 }],
  })
  assert.equal(bare.findings.hidePlanStatus, 'unsupported')
  assert.deepEqual(bare.findings.hideApply, {
    mode: 'suggestion-only',
    interfacePresent: false,
    denyList: [],
    skipped: [{ name: 'x_tool', reason: 'interface-absent' }],
    applySupported: false,
    appliedNames: [],
  })
  // 有接口但拿不到 agent 作用域 ⇒ unvalidated，denyList 为空（不得照抄清单）
  const unvalidated = reconcile({
    cwd: '/w', scope: { sessionsScanned: 1 }, callsByName: {},
    hide: { status: 'unvalidated', restrictableNames: null, interfacePresent: true },
    items: [{ category: 'tools', name: 'x_tool', tokens: 10 }],
  })
  assert.equal(unvalidated.findings.hidePlanStatus, 'unvalidated')
  assert.deepEqual(unvalidated.findings.hideApply.denyList, [])
  assert.deepEqual(unvalidated.findings.hidePlan[0].precheck, {
    status: 'unvalidated', restrictable: null, reason: 'no-agent-scope',
  })
  assert.equal(unvalidated.findings.hideApply.applySupported, false)
  // 名字逐个预校验：集合外的名字进 skipped，不得进 denyList
  const partial = reconcile({
    cwd: '/w', scope: { sessionsScanned: 1 }, callsByName: {},
    hide: { status: 'prechecked', restrictableNames: ['a_tool'], interfacePresent: true },
    items: [
      { category: 'tools', name: 'a_tool', tokens: 10 },
      { category: 'tools', name: 'b_tool', tokens: 20 },
    ],
  })
  assert.deepEqual(partial.findings.hideApply.denyList, ['a_tool'])
  assert.deepEqual(partial.findings.hideApply.skipped, [{ name: 'b_tool', reason: 'not-in-restrictable-names' }])
  assert.equal(partial.findings.hidePlanStatus, 'prechecked')
  // 预留名 run_code 永不进 denyList（防线，即使被显式放进 restrictableNames）
  const reserved = reconcile({
    cwd: '/w', scope: { sessionsScanned: 1 }, callsByName: {},
    hide: { status: 'prechecked', restrictableNames: ['run_code'], interfacePresent: true },
    items: [{ category: 'tools', name: 'run_code', tokens: 10 }],
  })
  assert.deepEqual(reserved.findings.hideApply.denyList, [])
  assert.deepEqual(reserved.findings.hideApply.skipped, [{ name: 'run_code', reason: 'reserved-name' }])
})

test('R6：registryUse 逐候选判定含 verdictBasis，且不出现"无损失"式结论', () => {
  const report = r6GoldenReport()
  for (const entry of report.findings.hidePlan) {
    assert.deepEqual(Object.keys(entry.registryUse), [
      'verdict', 'verdictBasis', 'modelCalls', 'nameReferencedElsewhere', 'nonModelCallers',
    ])
    assert.equal(entry.registryUse.verdict, 'unconfirmed')
    assert.equal(entry.registryUse.verdictBasis, 'no-non-model-observability')
    assert.equal(entry.registryUse.modelCalls, 0)
    assert.equal(entry.registryUse.nonModelCallers, 'unobservable')
  }
  // 弱命中文件作为"别处引用过"的证据（≤3，升序，绝对路径）
  const subagent = report.findings.hidePlan.find(entry => entry.name === 'subagent')
  assert.equal(subagent.registryUse.nameReferencedElsewhere.length, 2)
  assert.deepEqual(subagent.registryUse.nameReferencedElsewhere, [...subagent.registryUse.nameReferencedElsewhere].sort())
  assert.equal(report.findings.hidePlan.filter(entry => entry.registryUse.nameReferencedElsewhere.length > 0).length, 1)
  // §6 第 11 条：不得出现"安全/零损失"这类把不可判定写成结论的字符串
  const json = JSON.stringify(report.findings)
  assert.equal(/\b(safe|unused|no-loss|lossless|zero-loss)\b/i.test(json), false)
  assert.equal(json.includes('"verdict":"model-observed"'), false)
})

test('R6：与 prunePlan 并存、不改其字段；两个动作的 token 相加是错误用法', () => {
  const report = r6GoldenReport()
  assert.deepEqual(Object.keys(report.findings.prunePlan[0]), [
    'kind', 'target', 'factPackages', 'items', 'itemCount', 'reclaimableTokens', 'usedToolCount', 'confidence',
  ])
  assert.equal(report.findings.prunePlanBasis, 'model-tool-calls-only')
  assert.equal(report.findings.hidePlanBasis, 'model-tool-calls-only')
  // 两个清单是**互斥替代方案**：契约只要求配对可见，不要求数量相等，也绝不求和
  const pruneTokens = report.findings.prunePlanReclaimableTokens
  assert.equal(pruneTokens, 3376)
  assert.equal(report.findings.hidePlanTokens, 4261)
  assert.ok(report.findings.hidePlanTokens > pruneTokens) // core/unknown 的 885 只有隐藏能收回
  const render = renderLedger(report)
  assert.match(render, /Do not add the hide tokens to the uninstall candidates: the two actions are alternative, not cumulative\./)
  assert.equal(render.includes(String(pruneTokens + report.findings.hidePlanTokens)), false)
})
