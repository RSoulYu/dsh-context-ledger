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
import { countToolCalls } from '../lib/usage.js'
import { allStrings, isWhitelisted } from './whitelist.js'

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

/** 用同一份成本表把日志回放到 canonical 报告。 */
function reportFor(lines) {
  const usage = countToolCalls(lines)
  return {
    usage,
    report: reconcile({
      cwd: '/w',
      sessionsRoot: '/home/u/.dsh/sessions',
      callsByName: usage.callsByName,
      scope: {
        workspaceKey: '--w--',
        sessionsRoot: '/home/u/.dsh/sessions',
        sessionsAvailable: 1,
        sessionsScanned: 1,
        sessionsUnreadable: 0,
        sessionsLimit: 20,
        windowStart: '2026-10-07T00:00:00.000Z',
        windowEnd: '2026-10-07T01:00:00.000Z',
        linesRead: usage.linesRead,
        skillToolCalls: usage.skillToolCalls,
        namesRejected: usage.namesRejected,
        truncated: usage.truncated,
      },
      items: [
        { id: 'tools:bash', category: 'tools', name: 'bash', tokens: 120, source: 'native', bytes: 480 },
        { id: 'tools:read', category: 'tools', name: 'read', tokens: 80, source: 'native', bytes: 320 },
        { id: 'tools:never_called_tool', category: 'tools', name: 'never_called_tool', tokens: 300, source: 'native', bytes: 900 },
        { id: 'mcp:mcp__openviking__find', category: 'mcp', name: 'mcp__openviking__find', tokens: 400, source: 'mcp', server: 'openviking', bytes: 1600 },
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
  assert.deepEqual(report.findings.zeroCall.map(item => item.name), [])
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

test('S2 只归一化 generatedAt：其余字段（含 cwd/时间窗）本就与载荷无关', () => {
  const { report } = reportFor(logWith(SENTINEL))
  assert.equal(report.cwd, '/w')
  assert.equal(report.scope.windowStart, '2026-10-07T00:00:00.000Z')
  // 产物里不允许出现任何「内容派生」字段（如 schemaHash / 片段预览）
  const keys = new Set()
  for (const item of report.items) for (const key of Object.keys(item)) keys.add(key)
  assert.equal(keys.has('schemaHash'), false)
  assert.equal(keys.has('preview'), false)
  assert.equal(keys.has('description'), false)
})
