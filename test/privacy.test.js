/**
 * 隐私自检 S1 / S2 / S3（DESIGN §3.4）。
 *
 * S1 哨兵不可见：载荷字段全填唯一哨兵，产物里不能出现它。
 * S2 载荷不变性（差分证明）：把全部载荷字段换成不同长度、不同字符集的垃圾后，
 *    产物逐字节相同（归一化 generatedAt 后）。这机械地证明产物只是
 *    「type + data.name + 计数」的函数。
 * S3 全局字符串白名单：递归遍历产物里每个字符串，必须命中白名单。
 *
 * 注意：S3 在 DESIGN §3.4 列的规则之外还必须有 `id` 规则——§2.4 冻结的 `id`
 * 形态是 `"<category>:<name>"`，含 `:`，必然过不了 `NAME_PATTERN`。IDS 规则见下。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcile, renderLedger } from '../lib/reconcile.js'
import { attributeNames, scanCorpus } from '../lib/provide.js'
import { countToolCalls } from '../lib/usage.js'
import { allStrings, currentSessionIdOffenders, isWhitelisted, whitelistOffenders } from './whitelist.js'

const SENTINEL = 'LEDGER-PRIVACY-SENTINEL-8f3a'
const SENTINEL_CJK = '机密正文-绝对不许出现在产物里-🙂'

/** 一条载荷字段齐全的 tool/call 行。 */
function callLine(name, payload) {
  return JSON.stringify({
    type: 'tool/call',
    seq: 1,
    time: 1759800000000,
    data: { turn: 1, step: 1, callId: payload, name, arguments: { secret: payload, nested: [payload] } },
  })
}

/** 一条非 tool/call 的事件行，载荷同样填哨兵。 */
function noiseLine(type, payload) {
  return JSON.stringify({
    type,
    seq: 2,
    time: 1759800000001,
    data: { message: payload, content: payload, title: payload, meta: { x: payload }, error: payload, usage: payload },
  })
}

/** 构造一份日志：A 用哨兵载荷，B 用长度/字符集都不同的垃圾载荷。 */
function logWith(payload) {
  return [
    JSON.stringify({ type: 'session', data: { id: 's-1', cwd: '/w' } }),
    callLine('bash', payload),
    callLine('bash', payload),
    callLine('read', payload),
    callLine('mcp__openviking__find', payload),
    noiseLine('assistant/message', payload),
    noiseLine('tool/result', payload),
    noiseLine('user/message', payload),
    noiseLine('session/title', payload),
    callLine('never_called_tool', payload),
  ]
}

/**
 * 归属输入（v2 / R1）：让 S1–S3 同时覆盖 R1 新增的字符串类别
 * （插件包名、`evidenceFile` 路径、`candidates`、prunePlan 的 target/factPackages）。
 */
function provenanceFixture() {
  return {
    byName: {
      bash: { kind: 'core', name: null, confidence: 'high', method: 'static-scan', evidenceFile: '/core/dsh-tool-bash/lib/index.js', candidates: [] },
      read: { kind: 'core', name: null, confidence: 'low', method: 'static-scan-weak', evidenceFile: '/core/dsh-tool-fs/lib/index.js', candidates: [] },
      never_called_tool: {
        kind: 'plugin', name: '@scope/task-board', confidence: 'high', method: 'static-scan',
        evidenceFile: '/profile/@scope/task-board/lib/index.js', candidates: [],
      },
      orphan_tool: {
        kind: 'plugin', name: '@scope/task-board', confidence: 'high', method: 'static-scan',
        evidenceFile: '/profile/@scope/task-board/lib/index.js', candidates: [],
      },
      mcp__openviking__find: {
        kind: 'mcp-server', name: 'openviking', confidence: 'high', method: 'mcp-naming',
        evidenceFile: null, candidates: [],
      },
    },
    bundleOwners: { '@scope/task-board': { owner: '@scope/web-all', removable: true } },
  }
}

/** 用同一份成本表把日志回放到 canonical 报告。 */
function reportFor(lines) {
  const usage = countToolCalls(lines)
  return {
    usage,
    report: reconcile({
      cwd: '/w',
      sessionsRoot: '/home/u/.dsh/sessions',
      callsByName: usage.callsByName,
      provenance: provenanceFixture(),
      // v3（R6）：让 S1/S2/S3 覆盖 hidePlan / hideApply / hidePlanCaveat 的字符串类别
      hide: {
        status: 'prechecked',
        restrictableNames: ['bash', 'read', 'mcp__openviking__find'],
        mode: 'suggestion-only',
      },
      // v4（R8）：让 S1/S2/S3 覆盖窗口字段与三态的全部新字符串类别
      // （`session-log-mtime` / `agent-session-id` / `current-session` / `historical-only` /
      //   `absent` / `model-tool-calls-in-window` / `unavailable`，以及受护栏约束的 currentSession.id）
      scope: {
        workspaceKey: '--w--',
        sessionsRoot: '/home/u/.dsh/sessions',
        sessionsAvailable: 3,
        sessionsScanned: 2,
        sessionsUnreadable: 0,
        sessionsLimit: 20,
        sessionsOutsideWindow: 1,
        windowStart: '2026-10-07T00:00:00.000Z',
        windowEnd: '2026-10-07T01:00:00.000Z',
        windowBasis: 'session-log-mtime',
        currentSession: {
          id: '9f8e7d6c-5b4a-3928-8170-a1b2c3d4e5f6', basis: 'agent-session-id', inWindow: true,
        },
        linesRead: usage.linesRead,
        skillToolCalls: usage.skillToolCalls,
        namesRejected: usage.namesRejected,
        truncated: usage.truncated,
        providerScan: { packages: 2, files: 9, bytes: 4096, capped: false },
      },
      // 三态的两个通道（§7.1 规则 5）：`{}` = 已判定；未列出的名字 ⇒ 0
      sessionCoverage: { bash: 1 },
      currentSessionCallsByName: { bash: 2, read: 0, never_called_tool: 0 },
      items: [
        { id: 'tools:bash', category: 'tools', name: 'bash', tokens: 120, source: 'native', bytes: 480 },
        { id: 'tools:read', category: 'tools', name: 'read', tokens: 80, source: 'native', bytes: 320 },
        { id: 'tools:never_called_tool', category: 'tools', name: 'never_called_tool', tokens: 300, source: 'native', bytes: 900 },
        { id: 'mcp:mcp__openviking__find', category: 'mcp', name: 'mcp__openviking__find', tokens: 400, source: 'mcp', server: 'openviking', bytes: 1600 },
        { id: 'tools:orphan_tool', category: 'tools', name: 'orphan_tool', tokens: 300, source: 'native', bytes: 900 },
        { id: 'instructions:/w/AGENTS.md', category: 'instructions', name: '/w/AGENTS.md', tokens: 200, source: 'project', bytes: 800, loadOrder: 1 },
        { id: 'skills:genui', category: 'skills', name: 'genui', tokens: 60, source: 'user-dsh', provider: 'filesystem', bytes: 240 },
      ],
    }),
  }
}

/** 归一化时间戳（S2 允许的唯一差异）。 */
function normalize(report) {
  return JSON.stringify({ ...report, generatedAt: 'NORMALIZED' })
}

test('S1 哨兵不可见：JSON 产物与 native 文本都不含哨兵', () => {
  for (const payload of [SENTINEL, SENTINEL_CJK]) {
    const { report } = reportFor(logWith(payload))
    const json = JSON.stringify(report)
    const text = renderLedger(report)
    assert.equal(json.includes(payload), false, 'canonical JSON 泄漏了载荷')
    assert.equal(text.includes(payload), false, 'native 渲染泄漏了载荷')
    assert.equal(json.includes(SENTINEL), false)
    assert.equal(text.includes(SENTINEL_CJK), false)
  }
  // 计数仍然正确（哨兵没把真实信号吃掉）
  const { usage, report } = reportFor(logWith(SENTINEL))
  assert.deepEqual(usage.callsByName, { bash: 2, mcp__openviking__find: 1, never_called_tool: 1, read: 1 })
  assert.equal(report.totals.observedCalls, 5)
  // 唯一的零调用项是夹具里的 orphan_tool（它从未出现在日志中）
  assert.deepEqual(report.findings.zeroCall.map(item => item.name), ['orphan_tool'])
})

test('S2 载荷不变性：换掉全部载荷字段后产物逐字节相同', () => {
  const a = reportFor(logWith(SENTINEL))
  // 长度、字符集都不同的垃圾载荷
  const b = reportFor(logWith('x'.repeat(37) + 'Ω﷽' + '9'.repeat(200)))
  assert.equal(normalize(a.report), normalize(b.report))
  assert.equal(renderLedger(a.report), renderLedger(b.report))
  assert.deepEqual(a.usage, b.usage)
})

test('S3 全局字符串白名单：产物里每个字符串都必须命中', () => {
  const { report } = reportFor(logWith(SENTINEL))
  const strings = allStrings(report)
  assert.ok(strings.length > 40, '至少要真的遍历到几十个字符串，避免空跑')
  const offenders = strings.filter(value => !isWhitelisted(value))
  assert.deepEqual(offenders, [])
  // 白名单规则本身不是「全都放行」
  assert.equal(isWhitelisted('has space and 中文'), false)
  assert.equal(isWhitelisted(SENTINEL_CJK), false)
  assert.equal(isWhitelisted('tools:bash bad name'), false)
})

test('S3：正文不可能进产物——名字护栏 + 白名单规则同时挡住', () => {
  // 直接把正文塞进工具名位置：回放层拒绝写入计数表，产物里也就没有它
  const { report } = reportFor([callLine(`bash ${SENTINEL_CJK}`, SENTINEL), callLine('read', SENTINEL)])
  assert.equal(JSON.stringify(report).includes(SENTINEL_CJK), false)
  assert.equal(report.scope.namesRejected, 1)
  assert.deepEqual(report.scope.callsUnmatchedNames, [])
})

test('S5 溯源哨兵：假插件源码里的哨兵不进产物，且归属仍指向假包', () => {
  const sentinel = 'LEDGER-PROVENANCE-SENTINEL-5c71'
  // 「假插件包」在纯函数层的等价物：语料里含着哨兵，命中名仍是工具名
  const scan = scanCorpus(
    { '@scope/task-board': [{ path: '/profile/@scope/task-board/lib/index.js', text: `// ${sentinel}\nname: 'never_called_tool'` }] },
    ['never_called_tool'],
  )
  const byName = attributeNames(
    [{ name: 'never_called_tool', category: 'tools' }],
    { profile: scan, core: scanCorpus({}, []) },
  )
  assert.equal(byName.never_called_tool.kind, 'plugin')
  assert.equal(byName.never_called_tool.name, '@scope/task-board')
  assert.equal(byName.never_called_tool.evidenceFile, '/profile/@scope/task-board/lib/index.js')
  // evidenceFile 是**路径**，不含该文件任何内容片段
  assert.equal(byName.never_called_tool.evidenceFile.includes(sentinel), false)
  assert.equal(JSON.stringify(byName).includes(sentinel), false)

  // 把这份归属喂进完整链路，产物与渲染都不得含哨兵
  const usage = countToolCalls(logWith(sentinel))
  const report = reconcile({
    cwd: '/w',
    sessionsRoot: '/home/u/.dsh/sessions',
    scope: { sessionsScanned: 1, providerScan: { packages: 1, files: 1, bytes: 64, capped: false } },
    callsByName: usage.callsByName,
    provenance: {
      byName: { orphan_tool: byName.never_called_tool },
      bundleOwners: { '@scope/task-board': { owner: '@scope/web-all', removable: true } },
    },
    items: [{ category: 'tools', name: 'orphan_tool', tokens: 300, source: 'native', bytes: 900 }],
  })
  assert.equal(JSON.stringify(report).includes(sentinel), false)
  assert.equal(renderLedger(report).includes(sentinel), false)
  assert.equal(whitelistOffenders(report).length, 0)
  assert.deepEqual(report.findings.prunePlan.map(entry => entry.target), ['@scope/web-all'])
})

test('S3 · R6 字符串类别：hidePlan/hideApply/hidePlanCaveat 全部命中白名单（§3.7：无新字符串类别）', () => {
  const { report } = reportFor(logWith(SENTINEL))
  const findings = report.findings
  assert.equal(findings.hidePlanTokens, 300) // orphan_tool 是唯一零调用工具
  assert.equal(findings.hidePlan.length, 1)
  assert.deepEqual(findings.hideApply.denyList, []) // orphan_tool 不在 restrictableNames 里
  assert.deepEqual(findings.hideApply.skipped, [{ name: 'orphan_tool', reason: 'not-in-restrictable-names' }])
  assert.deepEqual(findings.hidePlanCaveat, {
    registryHideIsTotal: true, nonModelRegistryCalls: 'unobservable', serviceCoupling: 'unconfirmed',
    confirmationRequired: true, prefixCacheCost: 'one-time-invalidation',
  })
  assert.deepEqual(whitelistOffenders(report), [])
  // 渲染里 caveat 与并列呈现规则都在（§2.19 / §2.22）
  const text = renderLedger(report)
  assert.match(text, /Hide caveats: registry-level hide, not schema-only;/)
  assert.match(text, /Do not add the hide tokens to the uninstall candidates/)
  assert.equal(text.includes(SENTINEL), false)
  // 反向校验：R6 的枚举值在白名单里，而正文形态仍被挡
  for (const value of ['unconfirmed', 'no-non-model-observability', 'suggestion-only', 'applied-by-config',
    'prechecked', 'unvalidated', 'unsupported', 'no-agent-scope', 'interface-absent', 'reserved-name',
    'one-time-invalidation', 'unobservable']) {
    assert.equal(isWhitelisted(value), true, `${value} 应在白名单里`)
  }
  assert.equal(isWhitelisted('safe to hide 无损失'), false)
})

test('S3 · R8（v4）字符串类别：窗口与三态的新常量全部命中白名单，且 currentSession.id 受护栏约束', () => {
  const { report } = reportFor(logWith(SENTINEL))
  const findings = report.findings
  // 三态在产物里真的都出现过（不是靠白名单空转）
  assert.equal(findings.zeroCallBasis, 'model-tool-calls-in-window')
  assert.equal(report.scope.windowBasis, 'session-log-mtime')
  assert.equal(report.scope.currentSession.basis, 'agent-session-id')
  const presence = new Set(report.items.map(item => item.callPresence))
  assert.equal(presence.has('current-session'), true) // bash：本会话用过
  assert.equal(presence.has('historical-only'), true) // find/read：本会话没用过
  assert.equal(report.items.some(item => item.callPresence === null), true) // instructions/skills

  // S3 全字符串白名单（含 v4 的 8 个新常量）
  assert.deepEqual(allStrings(report).filter(value => !isWhitelisted(value)), [])
  // v4 独立复算：`scope.currentSession.id` 必须过 NAME_PATTERN，且 basis/inWindow 自洽
  assert.deepEqual(currentSessionIdOffenders(report), [])

  // 反向校验：v4 的 8 个新常量确实在白名单里，而正文形态仍被挡
  for (const value of ['session-log-mtime', 'agent-session-id', 'http-session-param', 'unavailable',
    'current-session', 'historical-only', 'absent', 'model-tool-calls-in-window']) {
    assert.equal(isWhitelisted(value), true, `${value} 应在白名单里`)
  }
  // 违规 id 必须被 currentSessionIdOffenders 抓到（否则这条规则是永真的空断言）
  const withBadId = { ...report, scope: { ...report.scope, currentSession: { id: 'has space 中文', basis: 'agent-session-id', inWindow: true } } }
  assert.equal(currentSessionIdOffenders(withBadId).length, 1)
  const withBadBasis = { ...report, scope: { ...report.scope, currentSession: { id: 'sess-a', basis: 'unavailable', inWindow: true } } }
  assert.ok(currentSessionIdOffenders(withBadBasis).length >= 1)
  assert.equal(isWhitelisted('has space 中文'), false)
  assert.equal(isWhitelisted('logging mtime of the newest session'), false)
})

test('S3 · R1 字符串类别：插件包名 / evidenceFile / candidates / prunePlan 全部命中白名单', () => {
  const { report } = reportFor(logWith(SENTINEL))
  assert.equal(report.items.find(item => item.name === 'never_called_tool').providedBy.kind, 'plugin')
  assert.equal(report.findings.prunePlan.length, 1)
  assert.equal(report.findings.prunePlan[0].target, '@scope/web-all')
  assert.deepEqual(report.findings.prunePlan[0].factPackages, ['@scope/task-board'])
  assert.deepEqual(whitelistOffenders(report), [])
  // 反向校验：R1 的枚举值确实在白名单里，而正文形态仍然被挡
  assert.equal(isWhitelisted('mcp-server'), true)
  assert.equal(isWhitelisted('static-scan-weak'), true)
  assert.equal(isWhitelisted('@scope/task-board'), true)
  assert.equal(isWhitelisted('model-tool-calls-only'), true)
  assert.equal(isWhitelisted('no-owner-bundle'), true)
  assert.equal(isWhitelisted('@scope/bad name'), false)
})

test('S2 只归一化 generatedAt：其余字段（含 cwd/时间窗）本就与载荷无关', () => {
  const { report } = reportFor(logWith(SENTINEL))
  assert.equal(report.cwd, '/w')
  assert.equal(report.scope.windowStart, '2026-10-07T00:00:00.000Z')
  assert.equal(report.scope.windowBasis, 'session-log-mtime')
  // 产物里不允许出现任何「内容派生」字段（如 schemaHash / 片段预览）
  const keys = new Set()
  for (const item of report.items) for (const key of Object.keys(item)) keys.add(key)
  assert.equal(keys.has('schemaHash'), false)
  assert.equal(keys.has('preview'), false)
  assert.equal(keys.has('description'), false)
})
