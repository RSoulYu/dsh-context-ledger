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

/** §2.10 冻结的工具描述（**v2 修订版**，与 DESIGN 原文逐词一致，仅折叠换行空白）。 */
const FROZEN_DESCRIPTION =
  'Reconcile the resident cost of every injected context item against how often it is actually '
  + 'called in this workspace\'s session logs. Reports, per item: token cost, call count, '
  + 'cost-per-use (tokens ÷ calls) and whether it was never called. Also reports, per item, which '
  + 'package provides it — a heuristic inferred from installed plugin sources, never presented as '
  + 'fact — and groups never-called items by the plugin bundle or MCP server they come from. '
  + 'Those groups are CANDIDATES for review, not uninstall advice: a tool can still be used by the '
  + 'UI, by background flows, or rarely but crucially, and model call counts cannot prove otherwise. '
  + 'Read-only: it never writes a file, never reads message content, and extracts only tool names '
  + 'and counts from session logs.'

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

/** 溯源夹具：一个假 profile（manifest + bundle patch）+ 三个假事实包。 */
const FIXTURE_BUNDLE = '@fixture/web-all'
const FIXTURE_FACT = '@fixture/task-board'

function setupProvenanceProfile() {
  const profileDir = join(tmpRoot, 'profile')
  mkdirSync(join(profileDir, 'node_modules', '@fixture', 'task-board', 'lib'), { recursive: true })
  mkdirSync(join(profileDir, 'node_modules', '@fixture', 'web-all'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-fixture',
    dependencies: { [FIXTURE_FACT]: '1.0.0', [FIXTURE_BUNDLE]: '1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', FIXTURE_BUNDLE] } },
  }))
  writeFileSync(join(profileDir, 'node_modules', '@fixture', 'web-all', 'package.json'), JSON.stringify({
    name: FIXTURE_BUNDLE,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(profileDir, 'node_modules', '@fixture', 'web-all', 'cordis.patch.yml'), [
    '- insert:',
    '    - id: task-board',
    `      name: '${FIXTURE_FACT}'`,
  ].join('\n'))
  // 事实包源码里有**强级注册点**写法 → plugin/high；另有一个只出现在注释里的哨兵
  writeFileSync(join(profileDir, 'node_modules', '@fixture', 'task-board', 'lib', 'index.js'), [
    '// LEDGER-PROVENANCE-SENTINEL-5c71 这段注释绝不允许进入产物',
    "export const tool = { name: 'never_called_tool' }",
  ].join('\n'))
  return profileDir
}

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
    // 默认不扫真实机器的两个扫描根（用例自足）；需要溯源时由用例显式注入
    profileDir: join(tmpRoot, 'no-profile'),
    coreScopeDir: join(tmpRoot, 'no-core'),
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
  assert.equal(report.version, 3)
  assert.equal(report.cwd, WORKSPACE)
  assert.equal(report.scope.workspaceKey, WORKSPACE_KEY)
  assert.deepEqual(report.scope.providerScan, { packages: 0, files: 0, bytes: 0, capped: false })
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
  // 扫不到源码的工具不猜：unknown / not-found，不给动作
  assert.deepEqual(byId.get('tools:bash').providedBy, {
    kind: 'unknown', name: null, confidence: 'low', method: 'not-found', evidenceFile: null, candidates: [],
  })
  // MCP 命名约定给出的归属不依赖源码扫描，因此零调用时直接成为可执行候选
  assert.deepEqual(report.findings.prunePlan.map(entry => [entry.kind, entry.target, entry.reclaimableTokens]), [
    ['mcp-server', 'openviking', 10],
  ])
  assert.equal(report.findings.prunePlanReclaimableTokens, 10)
  assert.equal(report.findings.prunePlanBasis, 'model-tool-calls-only')
  assert.deepEqual(report.findings.noRecommendation, [
    { reason: 'core', items: 0, tokens: 0 },
    { reason: 'no-owner-bundle', items: 0, tokens: 0 },
    { reason: 'unknown-attribution', items: 1, tokens: byId.get('tools:never_called_tool').tokens },
  ])
  assert.equal(byId.get(`instructions:${join(WORKSPACE, 'AGENTS.md')}`).providedBy, undefined)
  // 隐私：夹具里所有载荷字段都是哨兵，产物里不得出现
  assert.equal(JSON.stringify(report).includes('LEDGER-PRIVACY-SENTINEL-8f3a'), false)
})

test('gatherLedger：R1 溯源 + 可执行候选（假 profile / bundle patch）', { skip: hostSkip }, async () => {
  setupIsolatedHome()
  const profileDir = setupProvenanceProfile()
  const report = await host.gatherLedger(makeDeps({ profileDir }), { cwd: WORKSPACE, sessions: 20 })

  // 扫描足迹：1 个事实包 + 1 个 bundle = 2 个候选包（core 根为空）；
  // `files`/`bytes` 只计**源码**（.js/.mjs/.cjs）——profile manifest 与 bundle patch
  // 属于清单读取，不计入源码扫描足迹（§2.2 的措辞是"实际读取的源码文件数"）。
  assert.deepEqual(report.scope.providerScan, {
    packages: 2,
    files: 1,
    bytes: Buffer.byteLength([
      '// LEDGER-PROVENANCE-SENTINEL-5c71 这段注释绝不允许进入产物',
      "export const tool = { name: 'never_called_tool' }",
    ].join('\n'), 'utf8'),
    capped: false,
  })

  const byId = new Map(report.items.map(item => [item.id, item]))
  const attributed = byId.get('tools:never_called_tool').providedBy
  assert.equal(attributed.kind, 'plugin')
  assert.equal(attributed.name, FIXTURE_FACT)
  assert.equal(attributed.confidence, 'high')
  assert.equal(attributed.method, 'static-scan')
  assert.equal(attributed.evidenceFile, join(profileDir, 'node_modules', '@fixture', 'task-board', 'lib', 'index.js'))
  assert.deepEqual(attributed.candidates, [])

  // 可执行的卸载单元 = bundle patch 里出现该事实包的那个 bundle；
  // 另一个候选来自 MCP 命名归属（零调用）。按 reclaimableTokens 降序。
  const pluginTokens = byId.get('tools:never_called_tool').tokens
  assert.deepEqual(report.findings.prunePlan, [
    {
      kind: 'plugin',
      target: FIXTURE_BUNDLE,
      factPackages: [FIXTURE_FACT],
      items: [{ id: 'tools:never_called_tool', category: 'tools', name: 'never_called_tool', tokens: pluginTokens }],
      itemCount: 1,
      reclaimableTokens: pluginTokens,
      usedToolCount: 0,
      confidence: 'high',
    },
    {
      kind: 'mcp-server',
      target: 'openviking',
      factPackages: [],
      items: [{ id: 'mcp:mcp__openviking__find', category: 'mcp', name: 'mcp__openviking__find', tokens: 10 }],
      itemCount: 1,
      reclaimableTokens: 10,
      usedToolCount: 0,
      confidence: 'high',
    },
  ])
  assert.equal(report.findings.prunePlanReclaimableTokens, pluginTokens + 10)
  // MCP 命名归属 + 其它工具无命中（不猜）
  assert.equal(byId.get('mcp:mcp__openviking__find').providedBy.kind, 'mcp-server')
  assert.equal(byId.get('tools:bash').providedBy.method, 'not-found')
  // S5 哨兵：假包源码里的哨兵绝不允许进入产物
  assert.equal(JSON.stringify(report).includes('LEDGER-PROVENANCE-SENTINEL-5c71'), false)
})

test('resolveProfileDir / readProfileManifest / resolveBundleOwners', { skip: hostSkip }, () => {
  const profileDir = setupProvenanceProfile()
  assert.equal(host.resolveProfileDir({ get: () => ({ dir: profileDir }) }), profileDir)
  assert.equal(host.resolveProfileDir({ get: () => undefined }, { DSH_PROFILE_DIR: '/env/dir' }), '/env/dir')
  assert.equal(host.resolveProfileDir({ get: () => undefined }, { DSH_HOME: '/h', DSH_PROFILE: 'web' }), join('/h', 'profiles', 'web'))
  assert.equal(host.resolveProfileDir({ get: () => undefined }, {}), null)

  const manifest = host.readProfileManifest(profileDir)
  assert.deepEqual(manifest.dependencies.sort(), [FIXTURE_FACT, FIXTURE_BUNDLE].sort())
  assert.deepEqual(manifest.removable, [FIXTURE_BUNDLE]) // 交集（dsh-base 不在 dependencies 里）
  assert.equal(host.readProfileManifest(join(tmpRoot, 'nope')), null)

  assert.deepEqual(
    host.resolveBundleOwners(profileDir, [FIXTURE_FACT, '@fixture/orphan'], manifest.removable),
    {
      [FIXTURE_FACT]: { owner: FIXTURE_BUNDLE, removable: true },
      '@fixture/orphan': { owner: null, removable: false },
    },
  )
  // manifest 不可读 → 调用方传空的可卸载列表 → 全部没动作（不猜）
  assert.deepEqual(host.resolveBundleOwners(profileDir, [FIXTURE_FACT], []), {
    [FIXTURE_FACT]: { owner: null, removable: false },
  })
})

test('listPackages / collectCorpus：只读 .js/.mjs/.cjs、跳过 SKIP_DIR_NAMES、上限置 capped', { skip: hostSkip }, () => {
  setupIsolatedHome()
  const root = join(tmpRoot, 'scan')
  mkdirSync(join(root, 'pkg-a', 'lib'), { recursive: true })
  mkdirSync(join(root, 'pkg-a', 'test'), { recursive: true })
  mkdirSync(join(root, 'pkg-a', 'node_modules'), { recursive: true })
  mkdirSync(join(root, '@s', 'pkg-b'), { recursive: true })
  writeFileSync(join(root, 'pkg-a', 'lib', 'index.js'), "name: 'bash'")
  writeFileSync(join(root, 'pkg-a', 'lib', 'index.mjs'), "name: 'read'")
  writeFileSync(join(root, 'pkg-a', 'lib', 'index.cjs'), "name: 'grep'")
  writeFileSync(join(root, 'pkg-a', 'lib', 'types.d.ts'), "name: 'nope'")
  writeFileSync(join(root, 'pkg-a', 'lib', 'data.json'), '{"name":"nope"}')
  writeFileSync(join(root, 'pkg-a', 'test', 'x.js'), "name: 'nope'")
  writeFileSync(join(root, 'pkg-a', 'node_modules', 'dep.js'), "name: 'nope'")
  writeFileSync(join(root, '@s', 'pkg-b', 'index.js'), "name: 'skill'")

  const packages = host.listPackages(root)
  assert.deepEqual(packages.map(entry => entry.name), ['@s/pkg-b', 'pkg-a'])
  const read = host.collectCorpus(packages)
  assert.equal(read.capped, false)
  assert.equal(read.files, 4) // pkg-a 三个扩展名 + pkg-b 一个
  assert.deepEqual(Object.keys(read.corpus).sort(), ['@s/pkg-b', 'pkg-a'])
  assert.equal(read.corpus['pkg-a'].every(entry => entry.path.startsWith(root)), true)
  // 单文件超上限 → 跳过并置 capped
  writeFileSync(join(root, 'pkg-a', 'lib', 'huge.js'), 'x'.repeat(host.MAX_SCAN_FILE_BYTES + 1))
  const capped = host.collectCorpus(host.listPackages(root))
  assert.equal(capped.capped, true)
  assert.equal(capped.files, 4)
  assert.equal(host.listPackages(join(root, 'nope')).length, 0)
})

test('scanProvenance：MCP 命名归属不依赖源码扫描', { skip: hostSkip }, () => {
  const scan = host.scanProvenance({ profileDir: null, coreScopeDir: null }, [
    { name: 'mcp__openviking__find', category: 'mcp' },
    { name: 'bash', category: 'tools' },
  ])
  assert.deepEqual(scan.providerScan, { packages: 0, files: 0, bytes: 0, capped: false })
  assert.equal(scan.byName['mcp__openviking__find'].kind, 'mcp-server')
  assert.equal(scan.byName.bash.kind, 'unknown')
  assert.deepEqual(scan.bundleOwners, {})
})

test('gatherLedger：日志全不可读时降级为 no-evidence，不报零调用', { skip: hostSkip }, async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'context-ledger-empty-'))
  tmpRoots.push(tmpRoot)
  const report = await host.gatherLedger(makeDeps(), { cwd: WORKSPACE })
  assert.equal(report.scope.sessionsAvailable, 0)
  assert.equal(report.scope.sessionsScanned, 0)
  assert.equal(report.scope.usageAvailable, false)
  assert.deepEqual(report.findings.zeroCall, [])
  assert.deepEqual(report.findings.topPerUse, [])
  assert.deepEqual(report.findings.prunePlan, [])
  assert.equal(report.findings.prunePlanReclaimableTokens, 0)
  assert.deepEqual(report.findings.noRecommendation.map(entry => entry.items), [0, 0, 0])
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
  // 输出 schema（§2.1：11 键 + additionalProperties:false；§2.2 17 键；§2.4 14 字段；§2.5 6 键）
  const outputSchema = definition.output.schema
  assert.equal(outputSchema.additionalProperties, false)
  assert.deepEqual(Object.keys(outputSchema.properties), [
    'tool', 'version', 'generatedAt', 'unit', 'estimator', 'cwd', 'scope', 'categories', 'items', 'findings', 'totals',
  ])
  assert.equal(outputSchema.properties.scope.additionalProperties, false)
  assert.deepEqual(Object.keys(outputSchema.properties.scope.properties), [
    'workspaceKey', 'sessionsRoot', 'sessionsAvailable', 'sessionsScanned', 'sessionsUnreadable',
    'sessionsLimit', 'windowStart', 'windowEnd', 'linesRead', 'toolCalls', 'skillToolCalls',
    'callsUnmatched', 'callsUnmatchedNames', 'namesRejected', 'usageAvailable', 'truncated', 'providerScan',
  ])
  assert.deepEqual(Object.keys(outputSchema.properties.scope.properties.providerScan.properties), [
    'packages', 'files', 'bytes', 'capped',
  ])
  assert.deepEqual(Object.keys(outputSchema.properties.items.items.properties), [
    'id', 'category', 'name', 'tokens', 'calls', 'tokensPerCall', 'zeroCall', 'usageBasis',
    'source', 'server', 'bytes', 'provider', 'loadOrder', 'providedBy',
  ])
  const providedBySchema = outputSchema.properties.items.items.properties.providedBy
  assert.equal(providedBySchema.additionalProperties, false)
  assert.deepEqual(Object.keys(providedBySchema.properties), [
    'kind', 'name', 'confidence', 'method', 'evidenceFile', 'candidates',
  ])
  assert.deepEqual(providedBySchema.properties.kind.enum, ['plugin', 'core', 'mcp-server', 'unknown'])
  assert.deepEqual(providedBySchema.properties.method.enum, ['static-scan', 'static-scan-weak', 'mcp-naming', 'not-found'])
  assert.deepEqual(providedBySchema.properties.candidates.items, { type: 'string' })
  assert.deepEqual(Object.keys(outputSchema.properties.categories.items.properties), [
    'key', 'itemCount', 'tokens', 'calls', 'tokensPerCall', 'observableUsage',
    'mechanismCalls', 'mechanismTokensPerCall',
  ])
  assert.equal(outputSchema.properties.categories.items.properties.key.enum.length, 4)
  assert.equal(outputSchema.properties.items.items.properties.calls.oneOf.length, 2)
  assert.equal(outputSchema.properties.categories.items.properties.observableUsage.type, 'boolean')
  // findings：三个清单 + 省额 + 证据边界 + 固定 3 条 noRecommendation + R6 七键（§2.5 逐行顺序）
  assert.deepEqual(Object.keys(outputSchema.properties.findings.properties), [
    'zeroCall', 'topPerUse', 'prunePlan', 'prunePlanReclaimableTokens', 'prunePlanBasis', 'noRecommendation',
    'hidePlan', 'hidePlanTokens', 'hidePlanUnits', 'hidePlanBasis', 'hidePlanStatus', 'hideApply', 'hidePlanCaveat',
  ])
  const pruneEntrySchema = outputSchema.properties.findings.properties.prunePlan.items
  assert.deepEqual(Object.keys(pruneEntrySchema.properties), [
    'kind', 'target', 'factPackages', 'items', 'itemCount', 'reclaimableTokens', 'usedToolCount', 'confidence',
  ])
  assert.deepEqual(pruneEntrySchema.properties.kind.enum, ['plugin', 'mcp-server'])
  assert.deepEqual(Object.keys(pruneEntrySchema.properties.items.items.properties), ['id', 'category', 'name', 'tokens'])
  assert.equal(outputSchema.properties.findings.properties.prunePlanBasis.const, 'model-tool-calls-only')
  assert.deepEqual(
    outputSchema.properties.findings.properties.noRecommendation.items.properties.reason.enum,
    ['core', 'no-owner-bundle', 'unknown-attribution'],
  )
  // R6 输出 schema：HideEntry 8 字段 / unit 3 键 / registryUse 5 键 / precheck 3 键 /
  // hidePlanUnits 7 键 / hideApply 6 键 / caveat 5 键（§2.18、§2.19、§2.23.4）
  const hideEntrySchema = outputSchema.properties.findings.properties.hidePlan.items
  assert.deepEqual(Object.keys(hideEntrySchema.properties), [
    'id', 'name', 'category', 'tokens', 'unit', 'registryUse', 'precheck', 'selfTool',
  ])
  assert.deepEqual(hideEntrySchema.properties.category.enum, ['tools', 'mcp'])
  assert.deepEqual(Object.keys(hideEntrySchema.properties.unit.properties), ['kind', 'target', 'factPackages'])
  assert.deepEqual(hideEntrySchema.properties.unit.properties.kind.enum, ['plugin', 'core', 'mcp-server', 'unknown'])
  assert.deepEqual(Object.keys(hideEntrySchema.properties.registryUse.properties), [
    'verdict', 'verdictBasis', 'modelCalls', 'nameReferencedElsewhere', 'nonModelCallers',
  ])
  assert.deepEqual(Object.keys(hideEntrySchema.properties.precheck.properties), ['status', 'restrictable', 'reason'])
  assert.deepEqual(hideEntrySchema.properties.precheck.properties.status.enum, ['prechecked', 'unvalidated', 'unsupported'])
  assert.deepEqual(hideEntrySchema.properties.precheck.properties.reason.oneOf[0].enum, [
    'not-in-restrictable-names', 'no-agent-scope', 'interface-absent', 'reserved-name',
  ])
  assert.deepEqual(
    Object.keys(outputSchema.properties.findings.properties.hidePlanUnits.items.properties),
    ['kind', 'target', 'factPackages', 'toolCount', 'tokens', 'usedToolCount', 'inPrunePlan'],
  )
  assert.deepEqual(
    Object.keys(outputSchema.properties.findings.properties.hideApply.properties),
    ['mode', 'interfacePresent', 'denyList', 'skipped', 'applySupported', 'appliedNames'],
  )
  assert.deepEqual(outputSchema.properties.findings.properties.hideApply.properties.mode.enum, [
    'suggestion-only', 'applied-by-config',
  ])
  assert.deepEqual(
    Object.keys(outputSchema.properties.findings.properties.hidePlanCaveat.properties),
    ['registryHideIsTotal', 'nonModelRegistryCalls', 'serviceCoupling', 'confirmationRequired', 'prefixCacheCost'],
  )
  assert.equal(outputSchema.properties.findings.properties.hidePlanCaveat.properties.registryHideIsTotal.const, true)
  assert.equal(outputSchema.properties.findings.properties.hidePlanBasis.const, 'model-tool-calls-only')

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
  assert.match(rendered[0].text, /Never called by the model \(cost without model use\): \d+ items, \d+ tokens/)
  assert.match(rendered[0].text, /Never-called candidates, grouped by removal unit — NOT uninstall advice: \d+ tokens in \d+ units?/)
  assert.match(rendered[0].text, /^A tool can still be used by the UI, by background flows, or rarely but crucially; verify before removing\.$/m)
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
  assert.equal(report.version, 3)
  assert.equal(report.cwd, WORKSPACE)
  assert.equal(report.scope.workspaceKey, WORKSPACE_KEY)
  // apply() 会把**真实**核心作用域目录注入 deps（§2.14：用 createRequire 定位，不硬编码路径），
  // 因此这次执行确实扫了 DSH 自带包，`bash` 应归到 core。
  assert.ok(report.scope.providerScan.packages > 0)
  assert.ok(report.scope.providerScan.files > 0)
  const bash = report.items.find(item => item.id === 'tools:bash')
  assert.equal(bash.providedBy.kind, 'core')
  assert.equal(bash.providedBy.name, null)
  assert.equal(typeof bash.providedBy.evidenceFile, 'string')
})

test('HTTP 路由：只接受 ?session=（v2 移除 ?cwd=），60s 缓存、405、显式错误', { skip: hostSkip }, async () => {
  setupIsolatedHome()
  const { deps, count } = countingDeps()
  const routes = host.makeLedgerRoutes({
    deps,
    sessions: { get: id => (id === 's1' ? { header: { cwd: WORKSPACE } } : undefined) },
  })
  assert.equal(routes.length, 1)

  // 缺 ?session= → 显式错误（不得用降级报告顶替）
  const missing = fakeResponse()
  routes[0].handler({ method: 'GET', url: `${host.LEDGER_API_PATH}?sessions=20` }, missing)
  assert.equal(missing.state.status, 400)
  assert.deepEqual(JSON.parse(missing.state.body), { ok: false, error: 'session-unresolved' })
  assert.equal(count(), 0)

  // ?cwd= 已移除（收口 O2）：给 session 之外的路径旋钮也不认
  const legacyCwd = fakeResponse()
  routes[0].handler({ method: 'GET', url: `${host.LEDGER_API_PATH}?cwd=${encodeURIComponent(WORKSPACE)}` }, legacyCwd)
  assert.equal(legacyCwd.state.status, 400)
  assert.deepEqual(JSON.parse(legacyCwd.state.body), { ok: false, error: 'session-unresolved' })
  assert.equal(count(), 0)

  // 会话解析不到 → 显式错误（404）
  const unknown = fakeResponse()
  routes[0].handler({ method: 'GET', url: `${host.LEDGER_API_PATH}?session=nope` }, unknown)
  assert.equal(unknown.state.status, 404)
  assert.deepEqual(JSON.parse(unknown.state.body), { ok: false, error: 'session-unresolved' })
  assert.equal(count(), 0)

  // 正常路径：?session=<id>&sessions=<n>
  const first = fakeResponse()
  routes[0].handler({ method: 'GET', url: `${host.LEDGER_API_PATH}?session=s1&sessions=20` }, first)
  await waitForResponse(first.state)
  assert.equal(first.state.status, 200)
  assert.equal(first.state.headers['content-type'], 'application/json; charset=utf-8')
  const body = JSON.parse(first.state.body)
  assert.equal(body.ok, true)
  assert.equal(body.report.tool, 'context_ledger')
  assert.equal(body.report.version, 3)
  assert.equal(body.report.scope.workspaceKey, WORKSPACE_KEY)
  assert.equal(count(), 1)

  // 第二次命中 60s 缓存：不再重新采集
  const second = fakeResponse()
  routes[0].handler({ method: 'GET', url: `${host.LEDGER_API_PATH}?session=s1&sessions=20` }, second)
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
  routes[0].handler({ method: 'POST', url: `${host.LEDGER_API_PATH}?session=s1` }, post)
  assert.equal(post.state.status, 405)
  assert.equal(JSON.parse(post.state.body).ok, false)
})

after(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// R6 宿主侧：接口探测（三态）、agent 作用域施加、opt-in 开关与 gatherLedger 接线
// ─────────────────────────────────────────────────────────────────────────────

/** 假 tools 服务：可控地暴露 restrict / view / restrictableNames。 */
function makeFakeTools({ restrictableNames = null, hasRestrict = true, hasView = true, onRestrict = null } = {}) {
  const calls = []
  const tools = { schemas: () => SCHEMAS }
  if (hasRestrict) {
    tools.restrict = (filter) => {
      calls.push(filter)
      if (onRestrict !== null) onRestrict(filter)
      return () => {}
    }
  }
  if (hasView) {
    tools.view = () => {
      if (restrictableNames === null) return {}
      return { restrictableNames }
    }
  }
  return { tools, restrictCalls: calls }
}

test('R6 · probeRestrict：三态如实降级（有接口无作用域 / 缺接口 / 缺 restrictableNames）', { skip: hostSkip }, () => {
  const agent = { ctx: { tools: makeFakeTools({ restrictableNames: ['bash'] }).tools } }
  // ① prechecked：接口齐备 + agent 作用域
  assert.deepEqual(host.probeRestrict(agent.ctx.tools, agent), {
    status: 'prechecked', restrictableNames: ['bash'], interfacePresent: true,
  })
  // ② unvalidated：接口在，但没有 agent 作用域（如 HTTP 路由在无活动 agent 的宿主里）
  assert.deepEqual(host.probeRestrict(agent.ctx.tools, undefined), {
    status: 'unvalidated', restrictableNames: null, interfacePresent: true,
  })
  // ③ unsupported：旧宿主没有 restrict / view
  const withoutRestrict = makeFakeTools({ hasRestrict: false }).tools
  assert.deepEqual(host.probeRestrict(withoutRestrict, agent), {
    status: 'unsupported', restrictableNames: null, interfacePresent: false,
  })
  // ④ 有 view 但拿不到 restrictableNames（旧宿主）⇒ unsupported，不抛错
  assert.deepEqual(host.probeRestrict(makeFakeTools({ restrictableNames: null }).tools, agent), {
    status: 'unsupported', restrictableNames: null, interfacePresent: false,
  })
  // ⑤ view() 抛错 ⇒ unvalidated（拿不到作用域，不是接口缺失），绝不抛错
  const throwing = { restrict() {}, view() { throw new Error('no such scope') }, schemas: () => [] }
  assert.deepEqual(host.probeRestrict(throwing, agent), {
    status: 'unvalidated', restrictableNames: null, interfacePresent: true,
  })
})

test('R6 · applyDenyToAgent：只在 agent 作用域施加、施加前重新校验、保留名与空清单不施加', { skip: hostSkip }, () => {
  // ① 正常路径：走 agent.ctx.tools.restrict（作用域由 agent.ctx 决定，绝不全局施加）
  const fake = makeFakeTools({ restrictableNames: ['a_tool', 'b_tool'] })
  const agent = { ctx: { tools: fake.tools } }
  const result = host.applyDenyToAgent(agent, ['b_tool', 'a_tool'])
  assert.deepEqual(fake.restrictCalls, [{ deny: ['a_tool', 'b_tool'] }]) // 升序去重后一次施加
  assert.deepEqual(result, { interfacePresent: true, appliedNames: ['a_tool', 'b_tool'], skipped: [] })

  // ② 名字"已消失"（预校验集合里没有）⇒ 进 skipped，只施加剩下的
  const partial = makeFakeTools({ restrictableNames: ['a_tool'] })
  const partialResult = host.applyDenyToAgent({ ctx: { tools: partial.tools } }, ['a_tool', 'gone_tool'])
  assert.deepEqual(partial.restrictCalls, [{ deny: ['a_tool'] }])
  assert.deepEqual(partialResult.appliedNames, ['a_tool'])
  assert.deepEqual(partialResult.skipped, [{ name: 'gone_tool', reason: 'not-in-restrictable-names' }])

  // ③ 全部名字都不可限制 ⇒ 空清单，绝不施加（空 filter 会抛错）
  const none = makeFakeTools({ restrictableNames: [] })
  const noneResult = host.applyDenyToAgent({ ctx: { tools: none.tools } }, ['x_tool'])
  assert.deepEqual(none.restrictCalls, [])
  assert.deepEqual(noneResult, {
    interfacePresent: true, appliedNames: [], skipped: [{ name: 'x_tool', reason: 'not-in-restrictable-names' }],
  })

  // ④ 保留名 run_code 永不进 deny（即使它在 restrictableNames 里）
  const reserved = makeFakeTools({ restrictableNames: ['run_code'] })
  const reservedResult = host.applyDenyToAgent({ ctx: { tools: reserved.tools } }, ['run_code'])
  assert.deepEqual(reserved.restrictCalls, [])
  assert.deepEqual(reservedResult.skipped, [{ name: 'run_code', reason: 'reserved-name' }])

  // ⑤ 接口缺失 / 无作用域 ⇒ 记 skipped，不抛错
  const noInterface = host.applyDenyToAgent({ ctx: {} }, ['a_tool'])
  assert.deepEqual(noInterface, {
    interfacePresent: false, appliedNames: [], skipped: [{ name: 'a_tool', reason: 'interface-absent' }],
  })
  const noScope = host.applyDenyToAgent({}, ['a_tool'])
  assert.equal(noScope.interfacePresent, false)
  assert.deepEqual(noScope.appliedNames, [])

  // ⑥ restrict 抛错 ⇒ 静默降级（不抛错、不重试、appliedNames 为空）
  const boom = makeFakeTools({ restrictableNames: ['a_tool'], onRestrict: () => { throw new Error('nope') } })
  const boomResult = host.applyDenyToAgent({ ctx: { tools: boom.tools } }, ['a_tool'])
  assert.deepEqual(boomResult.appliedNames, [])
  assert.deepEqual(boomResult.skipped, [{ name: 'a_tool', reason: 'interface-absent' }])
})

test('R6 · installHideApply：默认不注册监听；opt-in 且 deny 非空才施加', { skip: hostSkip }, () => {
  const listeners = []
  const ctx = { on: (event, handler) => listeners.push({ event, handler }) }
  const applied = new WeakMap()

  // ① 默认（无配置）⇒ 不注册任何监听 = 不施加
  assert.equal(host.installHideApply(ctx, {}, applied), false)
  assert.equal(host.installHideApply(ctx, { hide: { apply: false, deny: ['a_tool'] } }, applied), false)
  // ② apply: true 但 deny 为空 ⇒ 空清单绝不施加
  assert.equal(host.installHideApply(ctx, { hide: { apply: true, deny: [] } }, applied), false)
  assert.equal(listeners.length, 0)

  // ③ apply: true 且 deny 非空 ⇒ 注册 agent/created，并在事件里对**该 agent** 施加
  const fake = makeFakeTools({ restrictableNames: ['a_tool'] })
  const agent = { ctx: { tools: fake.tools } }
  assert.equal(host.installHideApply(ctx, { hide: { apply: true, deny: ['a_tool', 'gone_tool'] } }, applied), true)
  assert.deepEqual(listeners.map(entry => entry.event), ['agent/created'])
  assert.deepEqual(fake.restrictCalls, []) // 注册本身不施加
  listeners[0].handler({ agent })
  assert.deepEqual(fake.restrictCalls, [{ deny: ['a_tool'] }])
  assert.deepEqual(applied.get(agent).appliedNames, ['a_tool'])
  // ④ 无 on 的 ctx ⇒ 返回 false，不抛错
  assert.equal(host.installHideApply({}, { hide: { apply: true, deny: ['a_tool'] } }, applied), false)
})

test('R6 · gatherLedger：hide 输入接线（prechecked 给 denyList；无 agent 则 unvalidated；opt-in 后记 appliedNames）', { skip: hostSkip }, async () => {
  setupIsolatedHome()
  const zeroCallNames = ['never_called_tool', 'mcp__openviking__find']
  // ① 有 agent 作用域：prechecked，零调用且可限制的名字进 denyList
  const fake = makeFakeTools({ restrictableNames: [...zeroCallNames, 'bash'] })
  const agent = { ctx: { tools: fake.tools } }
  const report = await host.gatherLedger(makeDeps({ tools: fake.tools }), { cwd: WORKSPACE, sessions: 20, agent })
  assert.equal(report.findings.hidePlanStatus, 'prechecked')
  assert.deepEqual(report.findings.hideApply.denyList, ['mcp__openviking__find', 'never_called_tool'])
  assert.equal(report.findings.hideApply.interfacePresent, true)
  assert.equal(report.findings.hideApply.applySupported, true)
  // 默认不施加（H4）：即使清单可施加，appliedNames 仍为空、mode 仍为 suggestion-only
  assert.deepEqual(report.findings.hideApply.appliedNames, [])
  assert.equal(report.findings.hideApply.mode, 'suggestion-only')
  // H1/H2/H3：可隐藏 token = 全部零调用工具的自身 token 之和
  assert.equal(report.findings.hidePlanTokens, 15 + 10)
  assert.equal(
    report.findings.hidePlanTokens,
    report.items.filter(i => i.zeroCall === true).reduce((sum, i) => sum + i.tokens, 0),
  )
  // 隐藏候选与账本项逐字一致
  for (const entry of report.findings.hidePlan) {
    const item = report.items.find(i => i.id === entry.id)
    assert.equal(entry.name, item.name)
    assert.equal(entry.tokens, item.tokens)
    assert.equal(entry.selfTool, entry.name === 'context_ledger')
  }

  // ② 无 agent 作用域（HTTP 路由场景）⇒ unvalidated：候选照列，但 denyList 必须为空
  const unvalidated = await host.gatherLedger(makeDeps({ tools: fake.tools }), { cwd: WORKSPACE, sessions: 20 })
  assert.equal(unvalidated.findings.hidePlanStatus, 'unvalidated')
  assert.deepEqual(unvalidated.findings.hideApply.denyList, [])
  assert.equal(unvalidated.findings.hideApply.applySupported, false)
  assert.ok(unvalidated.findings.hidePlan.length > 0)
  assert.equal(unvalidated.findings.hidePlan.every(entry => entry.precheck.restrictable === null), true)
  assert.equal(unvalidated.findings.hidePlan.every(entry => entry.precheck.reason === 'no-agent-scope'), true)

  // ③ opt-in 施加后：mode = applied-by-config，appliedNames 如实记录（来自 WeakMap）
  const applied = new WeakMap()
  applied.set(agent, { interfacePresent: true, appliedNames: ['never_called_tool'], skipped: [] })
  const appliedReport = await host.gatherLedger(
    makeDeps({ tools: fake.tools, appliedByAgent: applied }),
    { cwd: WORKSPACE, sessions: 20, agent },
  )
  assert.equal(appliedReport.findings.hideApply.mode, 'applied-by-config')
  assert.deepEqual(appliedReport.findings.hideApply.appliedNames, ['never_called_tool'])

  // ④ 旧宿主（无 restrict）⇒ unsupported，且**绝不抛错**
  const legacy = await host.gatherLedger(makeDeps({ tools: { schemas: () => SCHEMAS } }), { cwd: WORKSPACE, sessions: 20, agent })
  assert.equal(legacy.findings.hidePlanStatus, 'unsupported')
  assert.equal(legacy.findings.hideApply.interfacePresent, false)
  assert.deepEqual(legacy.findings.hideApply.denyList, [])
})

test('R6 · HTTP 路由：session 能解析出 agent 时给 prechecked，否则 unvalidated', { skip: hostSkip }, async () => {
  setupIsolatedHome()
  const fake = makeFakeTools({ restrictableNames: ['never_called_tool'] })
  const agent = { ctx: { tools: fake.tools } }
  const deps = makeDeps({ tools: fake.tools, agents: { get: id => (id === 's1' ? agent : undefined) } })
  const routes = host.makeLedgerRoutes({
    deps,
    sessions: { get: id => (id === 's1' ? { header: { cwd: WORKSPACE } } : undefined) },
  })
  const withAgent = fakeResponse()
  routes[0].handler({ method: 'GET', url: `${host.LEDGER_API_PATH}?session=s1&sessions=20` }, withAgent)
  await waitForResponse(withAgent.state)
  const body = JSON.parse(withAgent.state.body)
  assert.equal(body.report.findings.hidePlanStatus, 'prechecked')
  assert.deepEqual(body.report.findings.hideApply.denyList, ['never_called_tool'])

  // 路由解析得到 session（cwd）但 agents 注册表里没有该 id ⇒ 无 agent 作用域 ⇒ unvalidated
  const depsNoAgent = makeDeps({ tools: fake.tools, agents: { get: () => undefined } })
  const routesNoAgent = host.makeLedgerRoutes({ deps: depsNoAgent, sessions: { get: id => (id === 's2' ? { header: { cwd: WORKSPACE } } : undefined) } })
  const noAgent = fakeResponse()
  routesNoAgent[0].handler({ method: 'GET', url: `${host.LEDGER_API_PATH}?session=s2&sessions=20` }, noAgent)
  await waitForResponse(noAgent.state)
  const noAgentBody = JSON.parse(noAgent.state.body)
  assert.equal(noAgentBody.report.findings.hidePlanStatus, 'unvalidated')
  assert.deepEqual(noAgentBody.report.findings.hideApply.denyList, [])
})
