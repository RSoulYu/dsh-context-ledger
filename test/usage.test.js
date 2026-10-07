/**
 * lib/usage.js —— 会话日志回放：频次聚合 + 隐私白名单 + 名字护栏。
 *
 * 验收要求的第三条：频次聚合。这里同时把 DESIGN §3 的隐私约束做成可执行断言：
 * 回放只读「行顶层 type」与「tool/call 的 data.name」两处，其余字段填什么都不影响结果。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_LINES_PER_SESSION,
  NAME_PATTERN,
  countToolCalls,
  createUsageCounter,
  isValidToolName,
  lookupCount,
  projectKey,
} from '../lib/usage.js'

/** 构造一条 `tool/call` 日志行；载荷字段填哨兵，用于证明它们没被读到。 */
function toolCall(name, payload = 'LEDGER-PRIVACY-SENTINEL-8f3a') {
  return JSON.stringify({
    type: 'tool/call',
    seq: 7,
    time: 1759800000000,
    data: {
      turn: 1,
      step: 2,
      callId: payload,
      name,
      arguments: { secret: payload, note: `中文 ${payload} 🙂` },
    },
  })
}

test('countToolCalls：按工具名聚合，一条 tool/call = 一次调用', () => {
  const lines = [
    JSON.stringify({ type: 'session', data: { id: 'x' } }),
    toolCall('bash'),
    toolCall('bash'),
    toolCall('read'),
    JSON.stringify({ type: 'assistant/message', data: { content: 'LEDGER-PRIVACY-SENTINEL-8f3a' } }),
    toolCall('skill'),
  ]
  const result = countToolCalls(lines)
  assert.deepEqual(result.callsByName, { bash: 2, read: 1, skill: 1 })
  assert.equal(result.linesRead, 6)
  assert.equal(result.toolCalls, 4)
  assert.equal(result.skillToolCalls, 1)
  assert.equal(result.namesRejected, 0)
  assert.equal(result.truncated, false)
})

test('countToolCalls：调用不按 callId 去重（DSH 不重复发同一 call）', () => {
  const lines = [toolCall('bash', 'same-call-id'), toolCall('bash', 'same-call-id')]
  assert.equal(countToolCalls(lines).callsByName.bash, 2)
})

test('countToolCalls：只认 tool/call；其余事件类型一律当噪声丢弃', () => {
  const noise = [
    'tool/result', 'user/message', 'assistant/message', 'session/title',
    'session/title-llm-request', 'request/header', 'request/context',
    // ptc 派发不计入（父 tool/call 已计数，避免重复计数）
    'tool/ptc-dispatch', 'tool/ptc-dispatch-start',
  ].map(type => JSON.stringify({ type, data: { name: 'bash', message: 'LEDGER-PRIVACY-SENTINEL-8f3a' } }))
  const result = countToolCalls(noise)
  assert.equal(result.linesRead, noise.length)
  assert.equal(result.toolCalls, 0)
  assert.deepEqual(result.callsByName, {})
})

test('countToolCalls：坏行 / 空行只计入 linesRead，不算调用', () => {
  const result = countToolCalls(['', '   ', '{not json', 'null', '[1,2]', '"str"'])
  assert.equal(result.linesRead, 6)
  assert.equal(result.toolCalls, 0)
})

test('名字护栏：过不了护栏的名字只累加 namesRejected，不进计数表', () => {
  const badNames = [
    'has space', 'has"quote', 'has\nnewline', '中文工具', 'a/b', 'trailing~', 'x'.repeat(129), '',
  ]
  const lines = badNames.map(name => toolCall(name))
  const result = countToolCalls(lines)
  assert.equal(result.toolCalls, badNames.length)
  assert.equal(result.namesRejected, badNames.length)
  assert.deepEqual(result.callsByName, {})
  // 正文片段必然过不了护栏（哨兵串本身是名字形态，要带正文才越界）
  assert.equal(countToolCalls([toolCall('LEDGER-PRIVACY-SENTINEL-8f3a 正文')]).namesRejected, 1)
})

test('名字护栏：本机已观测到的工具名/技能名全部命中（不假设一定是 0 拒绝）', () => {
  for (const name of [
    'bash', 'read', 'todo_write', 'agent_teams_claim_task', 'task_board_get',
    'mcp__openviking__find', 'openviking-memory', 'context_ledger', 'validate_dsh_ui',
  ]) {
    assert.ok(NAME_PATTERN.test(name), `${name} 应通过护栏`)
  }
  assert.equal(isValidToolName('__proto__'), true)
  assert.equal(isValidToolName(42), false)
  assert.equal(isValidToolName(undefined), false)
})

test('隐私：载荷字段填哨兵也进不了回放结果', () => {
  const lines = [
    toolCall('bash'),
    JSON.stringify({ type: 'tool/result', data: { message: 'LEDGER-PRIVACY-SENTINEL-8f3a' } }),
    JSON.stringify({ type: 'user/message', data: { content: 'LEDGER-PRIVACY-SENTINEL-8f3a' } }),
    JSON.stringify({ type: 'session/title', data: { title: 'LEDGER-PRIVACY-SENTINEL-8f3a' } }),
  ]
  const result = countToolCalls(lines)
  assert.equal(JSON.stringify(result).includes('LEDGER-PRIVACY-SENTINEL-8f3a'), false)
  assert.deepEqual(result, {
    callsByName: { bash: 1 },
    linesRead: 4,
    toolCalls: 1,
    skillToolCalls: 0,
    namesRejected: 0,
    truncated: false,
  })
})

test('名字为 __proto__ / constructor 时不污染原型、不漏计', () => {
  const result = countToolCalls([toolCall('__proto__'), toolCall('__proto__'), toolCall('constructor')])
  assert.equal(Object.getPrototypeOf(result.callsByName), Object.prototype)
  assert.equal(lookupCount(result.callsByName, '__proto__'), 2)
  assert.equal(lookupCount(result.callsByName, 'constructor'), 1)
  assert.equal(lookupCount(result.callsByName, 'toString'), undefined)
  assert.deepEqual(Object.keys(result.callsByName), ['__proto__', 'constructor'])
})

test('callsByName 键名升序输出（字节级稳定）', () => {
  const result = countToolCalls([toolCall('z'), toolCall('a'), toolCall('m')])
  assert.deepEqual(Object.keys(result.callsByName), ['a', 'm', 'z'])
})

test('行数上限：触达上限即停并置 truncated', () => {
  const lines = [toolCall('bash'), toolCall('bash'), toolCall('bash'), toolCall('bash'), toolCall('bash')]
  const capped = countToolCalls(lines, 3)
  assert.equal(capped.linesRead, 3)
  assert.equal(capped.truncated, true)
  assert.equal(capped.toolCalls, 3)

  const exact = countToolCalls(lines.slice(0, 3), 3)
  assert.equal(exact.linesRead, 3)
  assert.equal(exact.truncated, false) // 恰好读满不算截断

  const uncapped = countToolCalls(lines, MAX_LINES_PER_SESSION)
  assert.equal(uncapped.truncated, false)
  assert.equal(uncapped.toolCalls, 5)
})

test('createUsageCounter：流式喂行，达上限后 feed 返回 false（调用方据此停读）', () => {
  const counter = createUsageCounter(2)
  assert.equal(counter.feed(toolCall('bash')), true)
  assert.equal(counter.feed(toolCall('bash')), true)
  assert.equal(counter.feed(toolCall('bash')), false)
  const result = counter.result()
  assert.equal(result.linesRead, 2)
  assert.equal(result.truncated, true)
  assert.equal(result.callsByName.bash, 2)
})

test('countToolCalls：接受任意 Iterable（数组 / 生成器均可）', () => {
  function* generate() {
    yield toolCall('bash')
    yield toolCall('read')
  }
  assert.deepEqual(countToolCalls(generate()).callsByName, { bash: 1, read: 1 })
  assert.deepEqual(countToolCalls(null).callsByName, {})
})

test('projectKey：与宿主 dsh-session-persistence-jsonl 逐分支对齐（DESIGN §1）', () => {
  assert.equal(projectKey('/home/u/Desktop/DSHWorkspace'), '--home-u-Desktop-DSHWorkspace--')
  assert.equal(projectKey('/a/b'), '--a-b--')
  assert.equal(projectKey('/a\\b'), '--a-b--')
  assert.equal(projectKey('C:\\Users\\u'), '--C-Users-u--')
  assert.equal(projectKey('//a///b'), '--a-b--') // 连续分隔符折叠成一个 -
  assert.equal(projectKey('/a b'), '--a~0020b--') // 非安全码元 ~XXXX（大写十六进制）
  assert.equal(projectKey('/a~b'), '--a~007Eb--') // ~ 自身也转义
  assert.equal(projectKey('/~'), '--~007E--')
  assert.equal(projectKey(''), '--root--')
  assert.equal(projectKey('/中'), '--~4E2D--')
  assert.equal(projectKey('/' + 'x'.repeat(400)).length, 255) // 251 + 两侧 --
})
