/**
 * index.js —— 宿主半区接线：工具注册、可选 HTTP 路由、会话目录发现与回放。
 *
 * 本文件需要宿主依赖（`@deepseek-ai/dsh-tools`）；缺失时整组用例跳过，
 * 纯函数测试（tokens / cost / usage / reconcile / privacy）不受影响。
 *
 * 夹具用隔离的临时 `DSH_HOME`（写在系统临时目录，跑完删除），**不碰** `~/.dsh`。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let host = null
try {
  host = await import('../index.js')
} catch {
  host = null
}
const hostSkip = host === null
  ? '宿主依赖 @deepseek-ai/dsh-tools 不可解析：宿主侧用例跳过'
  : false

const WORKSPACE = '/home/u/Desktop/DSHWorkspace'
const WORKSPACE_KEY = '--home-u-Desktop-DSHWorkspace--'
const INSTRUCTION_TEXT = '# 工作区规则\n\n只读审计插件：不写文件、不读正文。\n'

/** §2.10 冻结的工具描述（与 DESIGN 原文逐词一致，仅折叠换行空白）。 */
const FROZEN_DESCRIPTION =
  'Reconcile the resident cost of every injected context item against how often it is actually '
  + 'called in this workspace\'s session logs. Reports, per item: token cost, call count, '
  + 'cost-per-use (tokens ÷ calls) and whether it was never called. Read-only: it never writes a '
  + 'file, never reads message content, and extracts only tool names and counts from session logs.'

const SCHEMAS = [
  { name: 'bash', description: 'Run a shell command in the session workspace.', parameters: { type: 'object' } },
  { name: 'read', description: 'Read a file.', parameters: { type: 'object' } },
  { name: 'skill', description: 'Load a skill by name.', parameters: { type: 'object' } },
  {
    name: 'never_called_tool',
    description: 'A tool nobody calls in the fixture log.',
    parameters: { type: 'object' },
  },
  { name: 'mcp__openviking__find', description: 'Search memory.', parameters: { type: 'object' } },
]

const SKILLS = [
  { name: 'genui', description: 'GenUI reference.', source: 'user-dsh', provider: 'filesystem', invocation: { modelInvocable: true } },
  { name: 'human-only', description: 'not model invocable', source: 'user-dsh', provider: 'filesystem', invocation: { modelInvocable: false } },
]

function toolCallLine(name) {
  return JSON.stringify({ type: 'tool/call', seq: 1, time: 1, data: { name, arguments: { secret: 'LEDGER-PRIVACY-SENTINEL-8f3a' } } })
}

const GOOD_LOG_LINES = [
  JSON.stringify({ type: 'session', data: { id: 'sess-ok' } }),
  toolCallLine('bash'),
  toolCallLine('bash'),
  toolCallLine('read'),
  toolCallLine('skill'),
  toolCallLine('unmatched_tool'),
  JSON.stringify({ type: 'tool/result', data: { message: 'LEDGER-PRIVACY-SENTINEL-8f3a' } }),
]

let tmpRoot = ''
/** @type {string[]} */
const tmpRoots = []

/** 建一个隔离的 DSH_HOME：一个可读会话 + 一个坏 zstd 会话。 */
function setupIsolatedHome() {
  tmpRoot = mkdtempSync(join(tmpdir(), 'context-ledger-host-'))
  tmpRoots.push(tmpRoot)
  const sessionsDir = join(tmpRoot, 'sessions', WORKSPACE_KEY)
  mkdirSync(join(sessionsDir, 'sess-ok'), { recursive: true })
  writeFileSync(join(sessionsDir, 'sess-ok', 'session.v4.jsonl'), `${GOOD_LOG_LINES.join('\n')}\n`)
  mkdirSync(join(sessionsDir, 'sess-broken'), { recursive: true })
  writeFileSync(join(sessionsDir, 'sess-broken', 'session.v4.jsonl.zstd'), 'definitely-not-zstd')
  return tmpRoot
}

/** 等路由 handler 把响应写完（handler 自己拥有异步生命周期）。 */
async function waitForResponse(state) {
  for (let i = 0; i < 500; i += 1) {
    if (state.status !== 0) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('response timeout')
}

/** 假 ctx.fs：只认工作区里的 AGENTS.md。 */
function makeFakeFs() {
  return {
    resolve: async target => ({ path: target }),
    processPath: target => target.path,
    stat: async (target) => {
      if (target.path === join(WORKSPACE, 'AGENTS.md')) {
        return { type: 'file', size: Buffer.byteLength(INSTRUCTION_TEXT, 'utf8') }
      }
      return undefined
    },
    readText: async target => (target.path === join(WORKSPACE, 'AGENTS.md') ? INSTRUCTION_TEXT : ''),
  }
}

function makeDeps(overrides = {}) {
  return {
    fs: makeFakeFs(),
    skills: { list: async () => SKILLS },
    tools: { schemas: () => SCHEMAS },
    dshHome: tmpRoot,
    ...overrides,
  }
}

/** 统计 `tools.schemas()` 被调了几次（用于验证 60s 缓存真的起作用）。 */
function countingDeps() {
  let calls = 0
  const deps = makeDeps({
    tools: {
      schemas: () => {
        calls += 1
        return SCHEMAS
      },
    },
  })
  return { deps, count: () => calls }
}

function fakeResponse() {
  const state = { status: 0, headers: null, body: '' }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
    },
    end(body) {
      state.body = body
    },
  }
}

test('宿主依赖可用（否则本文件其余用例只会跳过）', { skip: hostSkip }, () => {
  assert.ok(host !== null)
})

test('插件标识与必需服务', { skip: hostSkip }, () => {
  assert.equal(host.name, 'context-ledger')
  assert.deepEqual(host.inject, ['fs', 'skills', 'tools'])
  assert.equal(host.LEDGER_API_PATH, '/api/context-ledger/ledger')
  assert.equal(host.DEFAULT_SESSIONS, 20)
  assert.equal(host.MAX_SESSIONS, 200)
  assert.equal(host.MAX_INSTRUCTION_FILE_BYTES, 262144)
  assert.equal(host.CACHE_TTL_MS, 60000)
})

test('resolveDshHome / sessionsRootOf / clampSessions', { skip: hostSkip }, () => {
  assert.equal(host.resolveDshHome({ DSH_HOME: '/iso' }), '/iso')
  assert.equal(host.resolveDshHome({ DSH_HOME: '' }).endsWith('/.dsh'), true)
  assert.equal(host.sessionsRootOf('/iso'), join('/iso', 'sessions'))
  assert.equal(host.clampSessions(undefined), 20)
  assert.equal(host.clampSessions(0), 20)
  assert.equal(host.clampSessions('7'), 7)
  assert.equal(host.clampSessions(9999), 200)
  assert.equal(host.clampSessions(-3), 20)
})

test('listWorkspaceSessions：只列目录、选最新一代日志、按 mtime 降序', { skip: hostSkip }, () => {
  setupIsolatedHome()
  const sessions = host.listWorkspaceSessions(join(tmpRoot, 'sessions'), WORKSPACE_KEY)
  assert.deepEqual(sessions.map(entry => entry.id).sort(), ['sess-broken', 'sess-ok'])
  for (const entry of sessions) assert.ok(entry.logPath.startsWith(join(tmpRoot, 'sessions')))
  // 目录不存在时静默返回空
  assert.deepEqual(host.listWorkspaceSessions(join(tmpRoot, 'nope'), WORKSPACE_KEY), [])
})

test('readSessionUsage：jsonl 直读、zstd 解压、坏文件抛错', { skip: hostSkip }, async () => {
  setupIsolatedHome()
  const sessionsDir = join(tmpRoot, 'sessions', WORKSPACE_KEY)
  const usage = await host.readSessionUsage(join(sessionsDir, 'sess-ok', 'session.v4.jsonl'), 1000)
  assert.equal(usage.linesRead, GOOD_LOG_LINES.length)
  assert.equal(usage.toolCalls, 5)
  assert.equal(usage.skillToolCalls, 1)
  assert.deepEqual(usage.callsByName, { bash: 2, read: 1, skill: 1, unmatched_tool: 1 })
  await assert.rejects(
    host.readSessionUsage(join(sessionsDir, 'sess-broken', 'session.v4.jsonl.zstd'), 1000),
  )
  await assert.rejects(host.readSessionUsage(join(sessionsDir, 'sess-ok', 'missing.jsonl'), 1000))
})

test('gatherLedger：四类成本 × 真实回放 → canonical 报告', { skip: hostSkip }, async () => {
  setupIsolatedHome()
  const report = await host.gatherLedger(makeDeps(), { cwd: WORKSPACE, sessions: 20 })
  assert.equal(report.tool, 'context_ledger')
  assert.deepEqual(Object.keys(report), [
    'tool', 'version', 'generatedAt', 'unit', 'estimator', 'cwd', 'scope', 'categories', 'items', 'findings', 'totals',
  ])
  assert.equal(report.cwd, WORKSPACE)
  assert.equal(report.scope.workspaceKey, WORKSPACE_KEY)
  assert.equal(report.scope.sessionsAvailable, 2)
  assert.equal(report.scope.sessionsScanned, 1)
  assert.equal(report.scope.sessionsUnreadable, 1)
  assert.equal(report.scope.sessionsLimit, 20)
  assert.equal(report.scope.usageAvailable, true)
  assert.equal(report.scope.truncated, false)
  assert.equal(report.scope.linesRead, GOOD_LOG_LINES.length)
  assert.equal(report.scope.toolCalls, 5)
  assert.equal(report.scope.skillToolCalls, 1)
  assert.equal(report.scope.callsUnmatched, 1)
  assert.deepEqual(report.scope.callsUnmatchedNames, ['unmatched_tool'])
  assert.equal(report.scope.namesRejected, 0)
  assert.match(report.scope.windowStart, /^\d{4}-\d{2}-\d{2}T/)

  const byId = new Map(report.items.map(item => [item.id, item]))
  // 指令链（fake fs 提供 1 个文件）
  const instruction = byId.get(`instructions:${join(WORKSPACE, 'AGENTS.md')}`)
  assert.equal(instruction.category, 'instructions')
  assert.equal(instruction.usageBasis, 'always-on')
  assert.equal(instruction.calls, null)
  assert.equal(instruction.zeroCall, null)
  assert.equal(instruction.source, 'project')
  assert.ok(instruction.tokens > 0)
  // 技能目录（只有 model-invocable 的进 catalog）
  assert.equal(byId.has('skills:genui'), true)
  assert.equal(byId.has('skills:human-only'), false)
  assert.equal(byId.get('skills:genui').usageBasis, 'unobservable')
  assert.equal(byId.get('skills:genui').calls, null)
  // 工具 / MCP
  assert.equal(byId.get('tools:bash').calls, 2)
  assert.equal(byId.get('tools:bash').zeroCall, false)
  assert.equal(byId.get('tools:never_called_tool').calls, 0)
  assert.equal(byId.get('tools:never_called_tool').zeroCall, true)
  assert.equal(byId.get('mcp:mcp__openviking__find').calls, 0)
  assert.equal(byId.get('mcp:mcp__openviking__find').server, 'openviking')
  // 机制级技能量
  const skills = report.categories.find(entry => entry.key === 'skills')
  assert.equal(skills.calls, null)
  assert.equal(skills.tokensPerCall, null)
  assert.equal(skills.mechanismCalls, 1)
  assert.ok(skills.mechanismTokensPerCall !== null)
  // 零调用清单：有证据的零调用进，不可观测的绝不进
  assert.deepEqual(report.findings.zeroCall.map(item => item.name).sort(), ['mcp__openviking__find', 'never_called_tool'])
  // 隐私：夹具里所有载荷字段都是哨兵，产物里不得出现
  assert.equal(JSON.stringify(report).includes('LEDGER-PRIVACY-SENTINEL-8f3a'), false)
})

test('gatherLedger：日志全不可读时降级为 no-evidence，不报零调用', { skip: hostSkip }, async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'context-ledger-empty-'))
  tmpRoots.push(tmpRoot)
  const report = await host.gatherLedger(makeDeps(), { cwd: WORKSPACE })
  assert.equal(report.scope.sessionsAvailable, 0)
  assert.equal(report.scope.sessionsScanned, 0)
  assert.equal(report.scope.usageAvailable, false)
  assert.deepEqual(report.findings, { zeroCall: [], topPerUse: [] })
  for (const item of report.items) {
    if (item.category === 'tools' || item.category === 'mcp') {
      assert.equal(item.usageBasis, 'no-evidence')
      assert.equal(item.calls, null)
      assert.equal(item.zeroCall, null)
    }
  }
})

test('apply：注册 context_ledger 工具并挂载可选 webServer 路由', { skip: hostSkip }, async () => {
  setupIsolatedHome()
  const registered = []
  const injections = []
  const disposed = []
  const routes = []
  const ctx = {
    tools: { schemas: () => SCHEMAS, register: definition => registered.push(definition) },
    skills: { list: async () => SKILLS },
    fs: makeFakeFs(),
    get: () => undefined,
    inject: (deps, callback) => injections.push({ deps, callback }),
  }
  host.apply(ctx, { defaultCwd: WORKSPACE })

  assert.equal(registered.length, 1)
  const definition = registered[0]
  assert.equal(definition.name, 'context_ledger')
  assert.equal(definition.description, FROZEN_DESCRIPTION)
  // 参数 schema（DSH 会把它编译成隐式开放对象根）
  assert.deepEqual(Object.keys(definition.parameters.properties), ['sessions'])
  assert.equal(definition.parameters.properties.sessions.type, 'integer')
  // 输出 schema（§2.1：11 键 + additionalProperties:false；§2.2 16 键；§2.4 13 字段）
  const outputSchema = definition.output.schema
  assert.equal(outputSchema.additionalProperties, false)
  assert.deepEqual(Object.keys(outputSchema.properties), [
    'tool', 'version', 'generatedAt', 'unit', 'estimator', 'cwd', 'scope', 'categories', 'items', 'findings', 'totals',
  ])
  assert.equal(outputSchema.properties.scope.additionalProperties, false)
  assert.equal(Object.keys(outputSchema.properties.scope.properties).length, 16)
  assert.deepEqual(Object.keys(outputSchema.properties.items.items.properties), [
    'id', 'category', 'name', 'tokens', 'calls', 'tokensPerCall', 'zeroCall', 'usageBasis',
    'source', 'server', 'bytes', 'provider', 'loadOrder',
  ])
  assert.deepEqual(Object.keys(outputSchema.properties.categories.items.properties), [
    'key', 'itemCount', 'tokens', 'calls', 'tokensPerCall', 'observableUsage',
    'mechanismCalls', 'mechanismTokensPerCall',
  ])
  assert.equal(outputSchema.properties.categories.items.properties.key.enum.length, 4)
  assert.equal(outputSchema.properties.items.items.properties.calls.oneOf.length, 2)
  assert.equal(outputSchema.properties.categories.items.properties.observableUsage.type, 'boolean')

  assert.equal(injections.length, 1)
  assert.deepEqual(injections[0].deps, ['webServer'])
  const fakeHttpCtx = {
    effect: (factory) => {
      disposed.push(factory())
    },
    webServer: { register: route => { routes.push(route); return () => {} } },
  }
  injections[0].callback(fakeHttpCtx)
  assert.deepEqual(routes.map(route => [route.kind, route.path]), [['exact', host.LEDGER_API_PATH]])
  assert.equal(typeof disposed[0], 'function')

  // 工具执行：默认 cwd 走 config.defaultCwd，返回契约形状
  const report = await definition.execute({ sessions: 5 }, { agent: undefined, signal: undefined })
  assert.equal(report.tool, 'context_ledger')
  assert.equal(report.scope.sessionsLimit, 5)
  const rendered = definition.output.render({}, report)
  assert.equal(Array.isArray(rendered), true)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /^Context ledger: \d+ tokens resident \/ \d+ observed calls across \d+ sessions \/ /)
  assert.match(rendered[0].text, /Never called \(cost without use\): \d+ items, \d+ tokens/)
  assert.match(rendered[0].text, /Not observable: instructions \d+ tokens \(always-on\)/)
})

test('apply：agent cwd 优先于 defaultCwd', { skip: hostSkip }, async () => {
  setupIsolatedHome()
  const registered = []
  host.apply({
    tools: { schemas: () => SCHEMAS, register: definition => registered.push(definition) },
    skills: { list: async () => SKILLS },
    fs: makeFakeFs(),
    get: () => undefined,
    inject: () => {},
  }, { defaultCwd: '/somewhere/else' })
  const report = await registered[0].execute({}, {
    agent: { session: { header: { cwd: WORKSPACE } } },
    signal: undefined,
  })
  assert.equal(report.cwd, WORKSPACE)
  assert.equal(report.scope.workspaceKey, WORKSPACE_KEY)
})

test('HTTP 路由：200 + {ok, report}、60s 缓存、405、session 参数解析', { skip: hostSkip }, async () => {
  setupIsolatedHome()
  const { deps, count } = countingDeps()
  const routes = host.makeLedgerRoutes({
    deps,
    defaultCwd: WORKSPACE,
    sessions: { get: id => (id === 's1' ? { header: { cwd: WORKSPACE } } : undefined) },
  })
  assert.equal(routes.length, 1)

  const first = fakeResponse()
  routes[0].handler({ method: 'GET', url: `${host.LEDGER_API_PATH}?sessions=20` }, first)
  await waitForResponse(first.state)
  assert.equal(first.state.status, 200)
  assert.equal(first.state.headers['content-type'], 'application/json; charset=utf-8')
  const body = JSON.parse(first.state.body)
  assert.equal(body.ok, true)
  assert.equal(body.report.tool, 'context_ledger')
  assert.equal(body.report.scope.workspaceKey, WORKSPACE_KEY)
  assert.equal(count(), 1)

  // 第二次命中 60s 缓存：不再重新采集
  const second = fakeResponse()
  routes[0].handler({ method: 'GET', url: `${host.LEDGER_API_PATH}?sessions=20` }, second)
  await waitForResponse(second.state)
  assert.equal(second.state.status, 200)
  assert.equal(count(), 1)
  assert.equal(JSON.parse(second.state.body).report.generatedAt, body.report.generatedAt)

  // 不同参数 = 不同缓存键
  const third = fakeResponse()
  routes[0].handler({ method: 'GET', url: `${host.LEDGER_API_PATH}?session=s1&sessions=3` }, third)
  await waitForResponse(third.state)
  assert.equal(third.state.status, 200)
  assert.equal(JSON.parse(third.state.body).report.scope.sessionsLimit, 3)
  assert.equal(count(), 2)

  // 非 GET
  const post = fakeResponse()
  routes[0].handler({ method: 'POST', url: host.LEDGER_API_PATH }, post)
  assert.equal(post.state.status, 405)
  assert.equal(JSON.parse(post.state.body).ok, false)
})

after(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true })
})
