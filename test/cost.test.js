/**
 * lib/cost.js —— 成本折算（指令链 / 技能目录 / 工具 schema）。
 *
 * 验收要求的第二条：成本折算。这里同时钉住 DESIGN §7 的**责任边界**：
 * cost.js 只填成本侧字段，产物里不允许出现 `calls` / `tokensPerCall` /
 * `zeroCall` / `usageBasis`（次数语义的唯一赋权点是 reconcile.js）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { instructionItems, itemId, skillItems, toolItems } from '../lib/cost.js'
import { estimateTokens } from '../lib/tokens.js'

/** 次数语义字段：cost.js 的产物里一个都不许有。 */
const USAGE_FIELDS = ['calls', 'tokensPerCall', 'zeroCall', 'usageBasis']

function assertNoUsageFields(items) {
  for (const item of items) {
    for (const field of USAGE_FIELDS) {
      assert.equal(Object.hasOwn(item, field), false, `cost.js 不得产生 ${field}（见 DESIGN §7）`)
    }
  }
}

test('instructionItems：tokens 来自文件全文，顺序与 loadOrder 从 1 起', () => {
  const files = [
    { path: '/repo/AGENTS.md', text: 'abcd', bytes: 4, source: 'project' },
    { path: '/repo/sub/AGENTS.md', text: 'abcdefgh', bytes: 8, source: 'project' },
  ]
  const items = instructionItems(files, '/repo')
  assert.deepEqual(items.map(item => item.id), [
    'instructions:/repo/AGENTS.md',
    'instructions:/repo/sub/AGENTS.md',
  ])
  assert.deepEqual(items.map(item => item.tokens), [1, 2])
  assert.deepEqual(items.map(item => item.loadOrder), [1, 2])
  assert.deepEqual(items.map(item => item.category), ['instructions', 'instructions'])
  assert.deepEqual(items.map(item => item.source), ['project', 'project'])
  assert.equal(items[0].bytes, 4)
  assertNoUsageFields(items)
})

test('instructionItems：项目根之外的文件标成 user；tokens 可由 text 现算', () => {
  const items = instructionItems([{ path: '/home/u/.dsh/AGENTS.md', text: '中文' }], '/repo')
  assert.equal(items[0].source, 'user')
  assert.equal(items[0].tokens, estimateTokens('中文'))
  assert.equal(items[0].bytes, Buffer.byteLength('中文', 'utf8'))
})

test('instructionItems：脏入参被跳过而不是抛错', () => {
  assert.deepEqual(instructionItems([null, { text: 'x' }, { path: '' }], '/repo'), [])
  assert.deepEqual(instructionItems(undefined, '/repo'), [])
})

test('skillItems：常驻成本 = catalog 条目（name + description + whenToUse）', () => {
  const items = skillItems([
    { name: 'genui', description: 'abcd', whenToUse: 'efgh', source: 'user-dsh', provider: 'filesystem' },
  ])
  assert.equal(items.length, 1)
  assert.equal(items[0].id, 'skills:genui')
  assert.equal(items[0].category, 'skills')
  assert.equal(items[0].name, 'genui')
  assert.equal(
    items[0].tokens,
    estimateTokens('genui') + estimateTokens('abcd') + estimateTokens('efgh'),
  )
  assert.equal(items[0].source, 'user-dsh')
  assert.equal(items[0].provider, 'filesystem')
  assert.ok(items[0].bytes > 0)
  assertNoUsageFields(items)
})

test('skillItems：provider 自由文本标签未过名字护栏时省略该可选字段', () => {
  const items = skillItems([
    { name: 'genui', description: '', source: 'some source with spaces', provider: 'ok-provider' },
  ])
  assert.equal(Object.hasOwn(items[0], 'source'), false)
  assert.equal(items[0].provider, 'ok-provider')
})

test('toolItems：native 与 MCP 分流，MCP 解析出 server', () => {
  const items = toolItems([
    { name: 'bash', description: 'Run a shell command', parameters: { type: 'object' } },
    { name: 'mcp__openviking__find', description: 'Search memory', parameters: {} },
  ])
  const byId = new Map(items.map(item => [item.id, item]))
  const bash = byId.get('tools:bash')
  const find = byId.get('mcp:mcp__openviking__find')
  assert.equal(bash.category, 'tools')
  assert.equal(bash.source, 'native')
  assert.equal(bash.server, undefined)
  assert.equal(bash.tokens, estimateTokens('bash') + estimateTokens('Run a shell command'))
  assert.equal(find.category, 'mcp')
  assert.equal(find.source, 'mcp')
  assert.equal(find.server, 'openviking')
  assert.equal(find.name, 'mcp__openviking__find')
  assert.ok(find.bytes > 0)
  assert.equal(
    find.bytes,
    Buffer.byteLength(
      '{"description":"Search memory","name":"mcp__openviking__find","parameters":{}}',
      'utf8',
    ),
  )
  assertNoUsageFields(items)
})

test('toolItems：bytes 量的是整份 schema（含 parameters），与 stableJson 一致', () => {
  const schema = { name: 'x', description: 'y', parameters: { b: 1, a: 2 } }
  const items = toolItems([schema])
  const stable = '{"description":"y","name":"x","parameters":{"a":2,"b":1}}'
  assert.equal(items[0].bytes, Buffer.byteLength(stable, 'utf8'))
})

test('toolItems：无名/脏条目跳过', () => {
  assert.deepEqual(toolItems([null, { description: 'x' }, { name: '' }]), [])
})

test('itemId：`<category>:<name>`（DESIGN §2.4）', () => {
  assert.equal(itemId('tools', 'bash'), 'tools:bash')
  assert.equal(itemId('instructions', '/repo/AGENTS.md'), 'instructions:/repo/AGENTS.md')
})
