/**
 * lib/reconcile.js —— 对账核心。
 *
 * 验收要求的第四条（每次使用成本排序）与第五条（零调用识别）都在这里；
 * 另外把 DESIGN §2.9 的冻结示例 JSON 当作**黄金样例**逐条重放：同一份输入必须
 * 产出 §2.9 的 13 条恒等式，并且 native 渲染逐字节等于 §2.11 的冻结文本。
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

/**
 * DESIGN §2.9 的 13 项（成本侧原样：不含次数），用于黄金样例重放。
 * 该示例明确标注为「合成数据，用于展示形状与取值约束」。
 */
function exampleItems() {
  return [
    {
      id: 'mcp:mcp__openviking__add_resource', category: 'mcp', name: 'mcp__openviking__add_resource',
      tokens: 402, source: 'mcp', server: 'openviking', bytes: 1609,
    },
    {
      id: 'mcp:mcp__openviking__forget', category: 'mcp', name: 'mcp__openviking__forget',
      tokens: 341, source: 'mcp', server: 'openviking', bytes: 1364,
    },
    {
      id: 'tools:task_board_list', category: 'tools', name: 'task_board_list',
      tokens: 292, source: 'native', bytes: 1168,
    },
    {
      id: 'tools:context_ledger', category: 'tools', name: 'context_ledger',
      tokens: 214, source: 'native', bytes: 856,
    },
    {
      id: 'tools:agent_teams_claim_task', category: 'tools', name: 'agent_teams_claim_task',
      tokens: 268, source: 'native', bytes: 1072,
    },
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

function exampleScope() {
  return {
    workspaceKey: '--home-u-Desktop-DSHWorkspace--',
    sessionsRoot: EXAMPLE_SESSIONS_ROOT,
    sessionsAvailable: 41,
    sessionsScanned: 20,
    sessionsUnreadable: 1,
    sessionsLimit: 20,
    windowStart: '2026-09-30T00:12:44.001Z',
    windowEnd: '2026-10-07T02:38:19.774Z',
    linesRead: 41233,
    skillToolCalls: 9,
    namesRejected: 0,
    truncated: false,
  }
}

function exampleReport() {
  return reconcile({
    cwd: EXAMPLE_CWD,
    sessionsRoot: EXAMPLE_SESSIONS_ROOT,
    scope: exampleScope(),
    callsByName: exampleCallsByName(),
    items: exampleItems(),
  })
}

test('黄金样例：DESIGN §2.9 的 13 条恒等式逐条成立', () => {
  const report = exampleReport()
  const category = key => report.categories.find(entry => entry.key === key)
  const sumCalls = report.items.reduce((sum, item) => sum + (item.calls ?? 0), 0)

  assert.equal(report.tool, 'context_ledger')
  assert.equal(report.version, 1)
  assert.equal(report.unit, 'token')
  assert.equal(report.estimator, 'heuristic-v1')
  assert.equal(report.cwd, EXAMPLE_CWD)

  // ① residentTokens = observableTokens + unknownUsageTokens
  assert.equal(report.totals.residentTokens, 3688)
  assert.equal(report.totals.residentTokens, report.totals.observableTokens + report.totals.unknownUsageTokens)
  assert.equal(report.totals.observableTokens, 2490)
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
  assert.equal(report.totals.observableTokensPerCall, 18)
  assert.equal(
    report.totals.observableTokensPerCall,
    Math.round(report.totals.observableTokens / report.totals.observedCalls),
  )
  // ⑦ zeroCallTokens
  assert.equal(report.totals.zeroCallItems, 3)
  assert.equal(report.totals.zeroCallTokens, 1035)
  // ⑧ items.length = Σ categories[].itemCount
  assert.equal(report.items.length, 13)
  assert.equal(report.items.length, report.categories.reduce((sum, entry) => sum + entry.itemCount, 0))
  // ⑨ unknownUsageItems = calls === null 的项数
  assert.equal(report.totals.unknownUsageItems, 5)
  assert.equal(report.totals.unknownUsageItems, report.items.filter(item => item.calls === null).length)
  // ⑩⑪⑫ 分类折算（用 Math.round）
  assert.equal(category('tools').tokensPerCall, 10)
  assert.equal(Math.round(category('tools').tokens / category('tools').calls), 10)
  assert.equal(category('mcp').tokensPerCall, 144)
  assert.equal(category('skills').mechanismCalls, 9)
  assert.equal(category('skills').mechanismTokensPerCall, 43)
  // ⑬ items 顺序严格符合 §2.7
  assert.deepEqual(report.items.map(item => item.id), [
    'mcp:mcp__openviking__add_resource',
    'mcp:mcp__openviking__forget',
    'tools:task_board_list',
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

test('黄金样例：findings 与 categories 形状、顺序、上限', () => {
  const report = exampleReport()
  assert.deepEqual(report.findings.zeroCall, [
    { id: 'mcp:mcp__openviking__add_resource', category: 'mcp', name: 'mcp__openviking__add_resource', tokens: 402 },
    { id: 'mcp:mcp__openviking__forget', category: 'mcp', name: 'mcp__openviking__forget', tokens: 341 },
    { id: 'tools:task_board_list', category: 'tools', name: 'task_board_list', tokens: 292 },
  ])
  assert.deepEqual(report.findings.topPerUse.map(item => item.id), [
    'tools:context_ledger',
    'tools:agent_teams_claim_task',
    'mcp:mcp__openviking__find',
    'tools:read',
    'tools:bash',
  ])
  assert.deepEqual(report.findings.topPerUse.map(item => item.tokensPerCall), [71, 67, 51, 47, 3])
  assert.deepEqual(report.categories.map(entry => entry.key), CATEGORY_KEYS)
  assert.deepEqual(report.categories.map(entry => entry.observableUsage), [false, false, true, true])
  assert.deepEqual(report.categories.map(entry => entry.itemCount), [1, 4, 5, 3])
  assert.deepEqual(report.categories.map(entry => entry.tokens), [812, 386, 1341, 1149])
  assert.deepEqual(
    report.categories.map(entry => entry.mechanismCalls),
    [null, 9, null, null],
  )
})

test('黄金样例：native 渲染逐字节等于 DESIGN §2.11 的冻结文本', () => {
  const expected = [
    'Context ledger: 3688 tokens resident / 137 observed calls across 20 sessions / 18 tokens per use',
    'Never called (cost without use): 3 items, 1035 tokens',
    '  - mcp__openviking__add_resource [mcp]  402 tokens  0 calls',
    '  - mcp__openviking__forget [mcp]  341 tokens  0 calls',
    '  - task_board_list [tools]  292 tokens  0 calls',
    'Most expensive per use:',
    '  - context_ledger [tools]  214 tokens  3 calls  -> 71 tokens/call',
    '  - agent_teams_claim_task [tools]  268 tokens  4 calls  -> 67 tokens/call',
    '  - mcp__openviking__find [mcp]  406 tokens  8 calls  -> 51 tokens/call',
    '  - read [tools]  186 tokens  4 calls  -> 47 tokens/call',
    '  - bash [tools]  381 tokens  118 calls  -> 3 tokens/call',
    'Not observable: instructions 812 tokens (always-on) / skills 386 tokens'
    + ' (per-skill unknown; 9 skill loads, 43 tokens/load)',
  ].join('\n')
  assert.equal(renderLedger(exampleReport()), expected)
})

test('黄金样例：canonical 形状——顶层 11 键、项字段顺序、无契约外字段', () => {
  const report = exampleReport()
  assert.deepEqual(Object.keys(report), [
    'tool', 'version', 'generatedAt', 'unit', 'estimator', 'cwd', 'scope', 'categories', 'items', 'findings', 'totals',
  ])
  assert.match(report.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.deepEqual(Object.keys(report.scope), [
    'workspaceKey', 'sessionsRoot', 'sessionsAvailable', 'sessionsScanned', 'sessionsUnreadable',
    'sessionsLimit', 'windowStart', 'windowEnd', 'linesRead', 'toolCalls', 'skillToolCalls',
    'callsUnmatched', 'callsUnmatchedNames', 'namesRejected', 'usageAvailable', 'truncated',
  ])
  assert.deepEqual(Object.keys(report.scope.callsUnmatchedNames), ['0', '1'])
  assert.deepEqual(Object.keys(report.categories[0]), [
    'key', 'itemCount', 'tokens', 'calls', 'tokensPerCall', 'observableUsage',
    'mechanismCalls', 'mechanismTokensPerCall',
  ])
  assert.deepEqual(Object.keys(report.findings), ['zeroCall', 'topPerUse'])
  assert.deepEqual(Object.keys(report.totals), [
    'residentTokens', 'observableTokens', 'unknownUsageTokens', 'observedCalls',
    'observableTokensPerCall', 'zeroCallItems', 'zeroCallTokens', 'unknownUsageItems',
  ])
  const bash = report.items.find(item => item.id === 'tools:bash')
  assert.deepEqual(Object.keys(bash), [
    'id', 'category', 'name', 'tokens', 'calls', 'tokensPerCall', 'zeroCall', 'usageBasis', 'source', 'bytes',
  ])
  const mcp = report.items.find(item => item.category === 'mcp')
  assert.ok(Object.keys(mcp).includes('server'))
  const instruction = report.items.find(item => item.category === 'instructions')
  assert.ok(Object.keys(instruction).includes('loadOrder'))
  const skill = report.items.find(item => item.category === 'skills')
  assert.ok(Object.keys(skill).includes('provider'))
  // 输入期的辅助字段不得进产物
  for (const item of report.items) {
    assert.equal(Object.hasOwn(item, 'observedCalls'), false)
  }
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

  // 1. instructions → always-on，次数恒不可观测
  assert.deepEqual(
    [byId.get('instructions:/w/AGENTS.md').usageBasis, byId.get('instructions:/w/AGENTS.md').calls,
      byId.get('instructions:/w/AGENTS.md').zeroCall],
    ['always-on', null, null],
  )
  // 2. skills → unobservable（技能名在工具参数里，隐私红线禁止读参）
  assert.deepEqual(
    [byId.get('skills:genui').usageBasis, byId.get('skills:genui').calls, byId.get('skills:genui').zeroCall],
    ['unobservable', null, null],
  )
  // 3. tools：有证据的次数照报，0 才是零调用
  assert.deepEqual(
    [byId.get('tools:bash').usageBasis, byId.get('tools:bash').calls, byId.get('tools:bash').zeroCall],
    ['tool-calls', 0, true],
  )
  assert.deepEqual(
    [byId.get('tools:grep').usageBasis, byId.get('tools:grep').calls, byId.get('tools:grep').zeroCall],
    ['tool-calls', 5, false],
  )
  // 4. 名字没过护栏的常驻项 → 降级为 unobservable，**不**误判零调用，并计入告警位
  assert.deepEqual(
    [byId.get('tools:weird name with spaces').usageBasis, byId.get('tools:weird name with spaces').calls,
      byId.get('tools:weird name with spaces').zeroCall],
    ['unobservable', null, null],
  )
  assert.equal(report.scope.namesRejected, 1)
  // 零调用清单只含真正有证据的零调用
  assert.deepEqual(report.findings.zeroCall.map(item => item.id), ['tools:bash'])
  assert.deepEqual(report.findings.topPerUse.map(item => item.id), ['tools:grep'])
})

test('零调用识别：calls === null 绝不当成 0，绝不进 findings.zeroCall', () => {
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
  assert.deepEqual(withoutEvidence.totals, {
    residentTokens: 100,
    observableTokens: 0,
    unknownUsageTokens: 100,
    observedCalls: 0,
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
  // 取整后 b 与 c 相等，顺序由未取整比值决定（b 33.67 > c 33.5）
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

test('findings 上限：各取前 10 条（FINDINGS_LIMIT）', () => {
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
  assert.deepEqual(Object.keys(report.findings.zeroCall[0]), ['id', 'category', 'name', 'tokens'])
  assert.deepEqual(
    Object.keys(report.findings.topPerUse[0]),
    ['id', 'category', 'name', 'tokens', 'calls', 'tokensPerCall'],
  )
})

test('降级态：无日志证据时 still 输出 4 条 categories，且工具/MCP 不报零调用', () => {
  const report = reconcile({
    cwd: EXAMPLE_CWD,
    sessionsRoot: EXAMPLE_SESSIONS_ROOT,
    scope: {
      ...exampleScope(),
      sessionsAvailable: 0,
      sessionsScanned: 0,
      sessionsUnreadable: 0,
      linesRead: 0,
      skillToolCalls: 0,
    },
    callsByName: {},
    items: exampleItems(),
  })
  assert.equal(report.scope.usageAvailable, false)
  assert.equal(report.scope.toolCalls, 0)
  assert.deepEqual(report.findings, { zeroCall: [], topPerUse: [] })
  assert.equal(report.totals.unknownUsageItems, 13)
  assert.equal(report.totals.residentTokens, 3688)
  assert.equal(report.totals.observableTokens, 0)
  assert.equal(report.totals.unknownUsageTokens, 3688)
  assert.equal(report.totals.observableTokensPerCall, null)
  assert.equal(report.categories.length, 4)
  assert.equal(report.categories.find(entry => entry.key === 'tools').observableUsage, true)
  assert.ok(report.items.every(item => item.zeroCall === null))
})

test('健壮性：未知 category 显式失败，脏项跳过', () => {
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
})

test('健壮性：id 由本模块推导，不采信调用方传入的 id（防止正文从 id 位置漏出）', () => {
  const report = reconcile({
    cwd: '/w',
    scope: { sessionsScanned: 1 },
    callsByName: { bash: 1 },
    items: [{ id: 'tools:has space and 中文', category: 'tools', name: 'bash', tokens: 10 }],
  })
  assert.equal(report.items[0].id, 'tools:bash')
  assert.equal(JSON.stringify(report).includes('中文'), false)
})

test('scope 兜底：workspaceKey 由 cwd 现算，usageAvailable 由 sessionsScanned 判定', () => {
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
})

test('常量与标识冻结', () => {
  assert.equal(LEDGER_TOOL, 'context_ledger')
  assert.equal(LEDGER_VERSION, 1)
  assert.equal(LEDGER_UNIT, 'token')
  assert.equal(ESTIMATOR, 'heuristic-v1')
  assert.deepEqual([...CATEGORY_KEYS], ['instructions', 'skills', 'tools', 'mcp'])
})
