/**
 * 客户端半区核验（无浏览器、无网络、只读宿主文件）。
 *
 * 覆盖：
 *   A. 经典脚本加载 + loader 模块表解析 + cordis 插件面（含 package.json dsh.client 声明）
 *   B. 插槽落座契约（conversation.input.right / id / order / locale）与宿主一手证据（file:line）
 *   C. 词典：命名空间 context-ledger，zh/en 与 DESIGN §4.5 冻结键集完全同键
 *   D. 展示映射：状态三分、`calls === null` 绝不渲染成 0、占比、折叠、总览降级保护
 *   E. 面板渲染（极简 hook 运行时 + 元素树→文本）：canonical / 降级 / 零调用 / 折叠 / 错误边界
 *   F. R2（DESIGN §4.7 六条硬性呈现义务）：候选语气、每行五件事实、常驻不确定性声明、
 *      低置信推断标记、unknown 只进 noRecommendation、顺序不二次加工、capped 页脚、证据可查
 *
 * 宿主依赖走工作区内的符号链接（node_modules/@deepseek-ai/*），链接缺失即整体失败——
 * 这正是「宿主依赖链接后，客户端半区能被解析」的判据。
 *
 * @module dsh-context-ledger/test/client-panel.test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 宿主包根目录：从工作区链接解析（不假设安装路径，但必须已链接）。 */
function hostPackages() {
  const link = join(REPO, 'node_modules/@deepseek-ai/dsh-tools')
  assert.ok(existsSync(link), '宿主依赖链接缺失：node_modules/@deepseek-ai/dsh-tools（先 dsh plugin add link:<repo>）')
  return dirname(realpathSync(link))
}

const HOST = hostPackages()
/** 安装目录的 node_modules 根（用于按包名解析客户端包）。 */
const NODE_MODULES = dirname(HOST)
const PKG = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
const CLIENT_SRC = readFileSync(join(REPO, 'client.js'), 'utf8')

/**
 * 从已安装的 web shell 里抽取 loader 模块表（platform seed）键集：
 * 抽不到就退回登记值（两种情形都在断言中体现出来）。
 */
function platformSeedWords() {
  const dist = join(HOST, 'dsh-web-frontend/dist/assets')
  const file = readdirSync(dist).find((name) => name.endsWith('.js'))
  if (file === undefined) return null
  const text = readFileSync(join(dist, file), 'utf8')
  const anchor = text.indexOf('"react-dom/client"')
  if (anchor === -1) return null
  const start = text.lastIndexOf('return{', anchor)
  const end = text.indexOf('}}', anchor)
  if (start === -1 || end === -1) return null
  const slice = text.slice(start, end)
  const words = []
  for (const match of slice.matchAll(/(?:^|[{,])\s*(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/g)) {
    words.push(match[1] ?? match[2])
  }
  return words.length >= 8 && words.includes('react') ? words : null
}

/** vm 里构造的对象/数组与宿主 realm 不同源，跨 realm 断言前统一成平凡 JSON。 */
function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

/** 提交给 factory 的 require：只答模块表里的词，其余一律抛错（与宿主同语义）。 */
function createRequireShim(seedWords) {
  const requested = []
  const require = (specifier) => {
    requested.push(specifier)
    if (!seedWords.includes(specifier)) {
      throw new Error(`client-modules: require("${specifier}") missed the module table`)
    }
    return null // 具体值由各用例注入（见 materialize）
  }
  require.requested = requested
  return require
}

/**
 * 极简 React（**仅核验用**）：真实 react 未随宿主以 node_modules 形式安装，
 * 因此这里提供一个只实现本组件用到的那几个 API 的替身，用来把组件函数执行成元素树。
 */
function createMiniReact() {
  const slots = []
  let cursor = 0
  const element = (type, props) => ({ type, props })
  const React = {
    createElement(type, props, ...children) {
      const flat = children.length === 1 && Array.isArray(children[0]) ? children[0] : children
      return element(type, { ...(props ?? {}), children: flat.flat(Infinity).filter((child) => child !== undefined) })
    },
    useState(initial) {
      const index = cursor++
      if (slots.length <= index) slots[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[index]
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
    },
    useRef(initial) {
      const index = cursor++
      if (slots.length <= index) slots[index] = { kind: 'ref', value: { current: initial } }
      return slots[index].value
    },
    useMemo(fn) { return fn() },
    useCallback(fn) { return fn },
    useId() { return 'cl-test-id' },
    useEffect() { /* 渲染期不跑副作用（取数/事件订阅因此不会触发） */ },
    Component: class Component {
      constructor(props) { this.props = props; this.state = {} }
    },
  }
  return {
    React,
    /** 一次渲染：重置 hook 游标、保留既有 hook 槽（模拟重渲染）。 */
    render(component, props) {
      cursor = 0
      return component(props)
    },
    reset() { slots.length = 0; cursor = 0 },
  }
}

/** 递归收集元素树里的文本（属性文案不算文本，避免把 title 当成可见文案）。 */
function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node === 'object' && node.props !== undefined) return textOf(node.props.children)
  return ''
}

/** 深度优先收集元素节点。 */
function nodesOf(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) nodesOf(child, out); return out }
  out.push(node)
  nodesOf(node.props?.children, out)
  return out
}

/**
 * 在 vm 里以**经典脚本**方式执行 client.js，捕获 __ModuleLoader__ 注册，
 * 再用注入的 require 物化 factory（与宿主 bootInjections 的 queue 模式一致：
 * dsh-client-modules/lib/index.js:461-472）。
 */
function loadBundle(miniReact, extraGlobals) {
  const seed = platformSeedWords() ?? [
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
  ]
  const registrations = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        mode: 'queue',
        pendingQueue: registrations,
        load(registration) { registrations.push(registration) },
        create() { throw new Error('test facade does not boot the module system') },
      },
    },
  }
  Object.assign(sandbox, extraGlobals ?? {})
  sandbox.globalThis = sandbox
  new vm.Script(CLIENT_SRC, { filename: 'client.js' }).runInNewContext(sandbox)

  assert.equal(registrations.length, 1, 'client.js 必须恰好注册一个 bundle')
  const registration = registrations[0]
  const requested = []
  const require = (specifier) => {
    requested.push(specifier)
    if (specifier === 'react') return miniReact.React
    throw new Error(`client-modules: require("${specifier}") missed the module table`)
  }
  const plugin = registration.factory(require)
  return { registration, plugin, requested, seed }
}

const mini = createMiniReact()
const loaded = loadBundle(mini)
const V = loaded.plugin.__verify

/** 假 ctx：只记录 apply 触碰的服务与参数。 */
function fakeContext() {
  const calls = { effects: [], registers: [], localeRegisters: [], disposers: [] }
  const ctx = {
    effect(callback, label) {
      calls.effects.push({ callback, label })
      // cordis 语义：ctx.effect 的回调在调用点立即执行，返回值就是卸载器。
      const dispose = callback()
      calls.disposers.push(dispose)
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register(namespace, dictionaries) {
        calls.localeRegisters.push({ namespace, dictionaries })
        return () => {}
      },
    },
    slots: {
      inject(key, callback) { calls.injectKey = key; calls.injectCallback = callback; return () => {} },
      register(options, component) {
        calls.registers.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, calls }
}

const T = (key, params) => V.fallbackT(key, params)

/**
 * 独立实现的词典翻译器（核验用）：证明两件事——
 * ① 词典本身自洽（zh 能独立渲染，不依赖 fallbackT）；② 面板 t 的接口就是 (key, params)。
 */
function dictionaryT(dict) {
  return (key, params) => {
    let text = dict[key]
    if (text === undefined) return key
    if (params === undefined) return text
    text = text.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
    return text
  }
}

const ZH = dictionaryT(V.dictionaries.zh)

/** DESIGN §4.5 冻结键集（33 键，实现线不得增删）。 */
/** v1 + v2 冻结键集（54 键；R2 轮已核，本轮**不得删改**）。 */
const FROZEN_KEYS = [
  /* v1 键集（33，保持） */
  'cl.title', 'cl.subtitle', 'cl.hint', 'cl.residentTotal', 'cl.tokens', 'cl.observedCalls',
  'cl.tokensPerCall', 'cl.sessionsCovered', 'cl.window', 'cl.zeroCallTitle', 'cl.zeroCallHint',
  'cl.topPerUseTitle', 'cl.topPerUseHint', 'cl.neverCalled', 'cl.unknown', 'cl.noEvidence',
  'cl.cat.instructions', 'cl.cat.skills', 'cl.cat.tools', 'cl.cat.mcp', 'cl.alwaysOnNote',
  'cl.skillsUnknownNote', 'cl.skillLoads', 'cl.expand', 'cl.collapse', 'cl.more', 'cl.refresh',
  'cl.updated', 'cl.loading', 'cl.error', 'cl.empty', 'cl.privacyNote', 'cl.rejectedWarning',
  /* v2 新增键集（21，§4.5 冻结） */
  'cl.prunePlanTitle', 'cl.prunePlanHint', 'cl.prunePlanCaveat', 'cl.pruneUnitPlugin',
  'cl.pruneUnitMcpServer', 'cl.pruneToolsCount', 'cl.pruneReclaimableTokens', 'cl.pruneUsedTools',
  'cl.pruneFactPackages', 'cl.pruneConfidenceLow', 'cl.noRecommendationTitle',
  'cl.reason.core', 'cl.reason.no-owner-bundle', 'cl.reason.unknown-attribution',
  'cl.providedBy.plugin', 'cl.providedBy.core', 'cl.providedBy.mcp-server',
  'cl.providedBy.unknown', 'cl.providedBy.inferred', 'cl.providedBy.evidence',
  'cl.providerScanCapped',
]

/**
 * v3 新增键集（45 键；R6/R3 轮）。
 * 注：DESIGN v3 §4.8 规定了逐条文案义务，但 §4.5 未给 v3 键清单（机械合并遗漏，已上报队长）。
 * 这里把实现实际新增的键集**钉死**，两语言必须齐全；v1+v2 的 54 键一个不得删、不得改值。
 */
const V3_KEYS = [
  'cl.hidePlanTitle', 'cl.hidePlanHint',
  'cl.hide.registryUseLabel', 'cl.hide.registryUseBasis',
  'cl.hide.verdict.unconfirmed', 'cl.hide.verdict.modelObserved',
  'cl.hide.precheckLabel', 'cl.hide.precheck.prechecked', 'cl.hide.precheck.unvalidated',
  'cl.hide.precheck.unsupported',
  'cl.hide.reason.not-in-restrictable-names', 'cl.hide.reason.no-agent-scope',
  'cl.hide.reason.interface-absent', 'cl.hide.reason.reserved-name',
  'cl.hide.selfToolNote', 'cl.hide.referencedElsewhere', 'cl.hide.unvalidatedBanner',
  'cl.hide.denyListLabel', 'cl.hide.copyDenyList', 'cl.hide.copied', 'cl.hide.copyUnavailable',
  'cl.hide.applyModeLabel', 'cl.hide.applyMode.suggestionOnly', 'cl.hide.applyMode.appliedByConfig',
  'cl.hide.applyApplied', 'cl.hide.applySkipped',
  'cl.hide.caveatTitle', 'cl.hide.caveat.registryHideIsTotal', 'cl.hide.caveat.nonModelRegistryCalls',
  'cl.hide.caveat.serviceCoupling', 'cl.hide.caveat.confirmationRequired', 'cl.hide.caveat.prefixCacheCost',
  'cl.hide.restoreTitle', 'cl.hide.restoreStep1', 'cl.hide.restoreStep2', 'cl.hide.restoreStep3',
  'cl.hide.restoreSubagent', 'cl.hide.restoreNoUndo', 'cl.hide.restoreReadonly',
  'cl.hide.parallelTitle', 'cl.hide.parallelHint', 'cl.hide.unitHideLine', 'cl.hide.unitPruneLine',
  'cl.hide.noUninstall', 'cl.hide.noSum',
]

/** v1+v2 既有键里语义不可漂移的代表值（"既有键不得删改"的定点证据）。 */
const FROZEN_VALUES = {
  'cl.zeroCallTitle': '零调用 · 模型未调用',
  'cl.prunePlanTitle': '零调用候选 · 需人工确认',
  'cl.pruneUsedTools': '该单元无在用工具|另有 1 个工具在用|另有 {n} 个工具在用',
  'cl.pruneReclaimableTokens': '若未使用可省 {tokens} token',
  'cl.noRecommendationTitle': '无法给出动作',
  'cl.providerScanCapped': '本次归属扫描触达上限，覆盖可能更窄',
}

/** 证据文件的绝对路径（合成；§2.9 的形状约束要求它是路径而非内容）。 */
const EVIDENCE = {
  taskBoard: '/home/u/.dsh/profiles/web/node_modules/@linxin666/dsh-client-ui-task-board/lib/index.js',
  taskBoardGithub: '/home/u/.dsh/profiles/web/node_modules/@linxin666/dsh-client-ui-task-board-github/lib/index.js',
  agentTeams: '/home/u/.dsh/profiles/web/node_modules/@nanmicoder/dsh-agent-teams/lib/tool-names.js',
  contextLedger: '/home/u/Desktop/DSHWorkspace/dsh-context-ledger/index.js',
  coreFiles: '/opt/dsh/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-api-workspace-files/lib/index.js',
  coreBash: '/opt/dsh/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-bash/lib/index.js',
}

const mcpServer = (server) => ({
  kind: 'mcp-server', name: server, confidence: 'high', method: 'mcp-naming', evidenceFile: null, candidates: [],
})
const pluginBy = (name, evidenceFile, confidence = 'high', method = 'static-scan') => ({
  kind: 'plugin', name, confidence, method, evidenceFile, candidates: [],
})
const coreBy = (evidenceFile, confidence = 'high', method = 'static-scan') => ({
  kind: 'core', name: null, confidence, method, evidenceFile, candidates: [],
})
const unknownBy = (candidates, confidence = 'low', method = 'static-scan-weak') => ({
  kind: 'unknown', name: null, confidence, method, evidenceFile: null, candidates,
})

/**
 * canonical 报告 —— **DESIGN §2.9 v2 完整示例的逐字段副本**（16 items / 4 categories /
 * prunePlan 2 单元 / noRecommendation 3 条）。合成数据，用于展示形状与取值约束。
 */
function canonicalReport() {
  return {
    tool: 'context_ledger',
    version: 2,
    generatedAt: '2026-10-07T02:41:07.512Z',
    unit: 'token',
    estimator: 'heuristic-v1',
    cwd: '/home/u/Desktop/DSHWorkspace',
    scope: {
      workspaceKey: '--home-u-Desktop-DSHWorkspace--',
      sessionsRoot: '/home/u/.dsh/sessions',
      sessionsAvailable: 41,
      sessionsScanned: 20,
      sessionsUnreadable: 1,
      sessionsLimit: 20,
      windowStart: '2026-09-30T00:12:44.001Z',
      windowEnd: '2026-10-07T02:38:19.774Z',
      linesRead: 41233,
      toolCalls: 141,
      skillToolCalls: 9,
      callsUnmatched: 4,
      callsUnmatchedNames: ['context_audit', 'mcp__oldserver__ping'],
      namesRejected: 0,
      usageAvailable: true,
      truncated: false,
      providerScan: { packages: 387, files: 1593, bytes: 49380329, capped: false },
    },
    categories: [
      { key: 'instructions', itemCount: 1, tokens: 812, calls: null, tokensPerCall: null, observableUsage: false, mechanismCalls: null, mechanismTokensPerCall: null },
      { key: 'skills', itemCount: 4, tokens: 386, calls: null, tokensPerCall: null, observableUsage: false, mechanismCalls: 9, mechanismTokensPerCall: 43 },
      { key: 'tools', itemCount: 8, tokens: 2113, calls: 129, tokensPerCall: 16, observableUsage: true, mechanismCalls: null, mechanismTokensPerCall: null },
      { key: 'mcp', itemCount: 3, tokens: 1149, calls: 8, tokensPerCall: 144, observableUsage: true, mechanismCalls: null, mechanismTokensPerCall: null },
    ],
    items: [
      { id: 'mcp:mcp__openviking__add_resource', category: 'mcp', name: 'mcp__openviking__add_resource', tokens: 402, calls: 0, tokensPerCall: null, zeroCall: true, usageBasis: 'tool-calls', source: 'mcp', server: 'openviking', bytes: 1609, providedBy: mcpServer('openviking') },
      { id: 'tools:subagent', category: 'tools', name: 'subagent', tokens: 402, calls: 0, tokensPerCall: null, zeroCall: true, usageBasis: 'tool-calls', source: 'native', bytes: 1608, providedBy: unknownBy(['@linxin666/dsh-pet', '@linxin666/dsh-session-archive', '@linxin666/dsh-web-all', '@nanmicoder/dsh-agent-teams', '@openviking/dsh-memory-plugin', 'dsh-context', 'dshmarket']) },
      { id: 'mcp:mcp__openviking__forget', category: 'mcp', name: 'mcp__openviking__forget', tokens: 341, calls: 0, tokensPerCall: null, zeroCall: true, usageBasis: 'tool-calls', source: 'mcp', server: 'openviking', bytes: 1364, providedBy: mcpServer('openviking') },
      { id: 'tools:task_board_list', category: 'tools', name: 'task_board_list', tokens: 292, calls: 0, tokensPerCall: null, zeroCall: true, usageBasis: 'tool-calls', source: 'native', bytes: 1168, providedBy: pluginBy('@linxin666/dsh-client-ui-task-board', EVIDENCE.taskBoard) },
      { id: 'tools:task_board_github_list', category: 'tools', name: 'task_board_github_list', tokens: 196, calls: 0, tokensPerCall: null, zeroCall: true, usageBasis: 'tool-calls', source: 'native', bytes: 784, providedBy: pluginBy('@linxin666/dsh-client-ui-task-board-github', EVIDENCE.taskBoardGithub) },
      { id: 'tools:task_board_schedule', category: 'tools', name: 'task_board_schedule', tokens: 174, calls: 0, tokensPerCall: null, zeroCall: true, usageBasis: 'tool-calls', source: 'native', bytes: 696, providedBy: pluginBy('@linxin666/dsh-client-ui-task-board', EVIDENCE.taskBoard) },
      { id: 'tools:context_ledger', category: 'tools', name: 'context_ledger', tokens: 214, calls: 3, tokensPerCall: 71, zeroCall: false, usageBasis: 'tool-calls', source: 'native', bytes: 856, providedBy: pluginBy('dsh-context-ledger', EVIDENCE.contextLedger, 'low', 'static-scan-weak') },
      { id: 'tools:agent_teams_claim_task', category: 'tools', name: 'agent_teams_claim_task', tokens: 268, calls: 4, tokensPerCall: 67, zeroCall: false, usageBasis: 'tool-calls', source: 'native', bytes: 1072, providedBy: pluginBy('@nanmicoder/dsh-agent-teams', EVIDENCE.agentTeams) },
      { id: 'mcp:mcp__openviking__find', category: 'mcp', name: 'mcp__openviking__find', tokens: 406, calls: 8, tokensPerCall: 51, zeroCall: false, usageBasis: 'tool-calls', source: 'mcp', server: 'openviking', bytes: 1624, providedBy: mcpServer('openviking') },
      { id: 'tools:read', category: 'tools', name: 'read', tokens: 186, calls: 4, tokensPerCall: 47, zeroCall: false, usageBasis: 'tool-calls', source: 'native', bytes: 744, providedBy: coreBy(EVIDENCE.coreFiles) },
      { id: 'tools:bash', category: 'tools', name: 'bash', tokens: 381, calls: 118, tokensPerCall: 3, zeroCall: false, usageBasis: 'tool-calls', source: 'native', bytes: 1524, providedBy: coreBy(EVIDENCE.coreBash) },
      { id: 'instructions:/home/u/Desktop/DSHWorkspace/AGENTS.md', category: 'instructions', name: '/home/u/Desktop/DSHWorkspace/AGENTS.md', tokens: 812, calls: null, tokensPerCall: null, zeroCall: null, usageBasis: 'always-on', source: 'project', bytes: 3421, loadOrder: 1 },
      { id: 'skills:genui', category: 'skills', name: 'genui', tokens: 128, calls: null, tokensPerCall: null, zeroCall: null, usageBasis: 'unobservable', source: 'user-dsh', provider: 'filesystem', bytes: 512 },
      { id: 'skills:openviking-memory', category: 'skills', name: 'openviking-memory', tokens: 96, calls: null, tokensPerCall: null, zeroCall: null, usageBasis: 'unobservable', source: 'user-dsh', provider: 'filesystem', bytes: 384 },
      { id: 'skills:openviking-skills', category: 'skills', name: 'openviking-skills', tokens: 88, calls: null, tokensPerCall: null, zeroCall: null, usageBasis: 'unobservable', source: 'user-dsh', provider: 'filesystem', bytes: 352 },
      { id: 'skills:ov-experience-memory', category: 'skills', name: 'ov-experience-memory', tokens: 74, calls: null, tokensPerCall: null, zeroCall: null, usageBasis: 'unobservable', source: 'user-dsh', provider: 'filesystem', bytes: 296 },
    ],
    findings: {
      zeroCall: [
        { id: 'mcp:mcp__openviking__add_resource', category: 'mcp', name: 'mcp__openviking__add_resource', tokens: 402 },
        { id: 'tools:subagent', category: 'tools', name: 'subagent', tokens: 402 },
        { id: 'mcp:mcp__openviking__forget', category: 'mcp', name: 'mcp__openviking__forget', tokens: 341 },
        { id: 'tools:task_board_list', category: 'tools', name: 'task_board_list', tokens: 292 },
        { id: 'tools:task_board_github_list', category: 'tools', name: 'task_board_github_list', tokens: 196 },
        { id: 'tools:task_board_schedule', category: 'tools', name: 'task_board_schedule', tokens: 174 },
      ],
      topPerUse: [
        { id: 'tools:context_ledger', category: 'tools', name: 'context_ledger', tokens: 214, calls: 3, tokensPerCall: 71 },
        { id: 'tools:agent_teams_claim_task', category: 'tools', name: 'agent_teams_claim_task', tokens: 268, calls: 4, tokensPerCall: 67 },
        { id: 'mcp:mcp__openviking__find', category: 'mcp', name: 'mcp__openviking__find', tokens: 406, calls: 8, tokensPerCall: 51 },
        { id: 'tools:read', category: 'tools', name: 'read', tokens: 186, calls: 4, tokensPerCall: 47 },
        { id: 'tools:bash', category: 'tools', name: 'bash', tokens: 381, calls: 118, tokensPerCall: 3 },
      ],
      prunePlan: [
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
      ],
      prunePlanReclaimableTokens: 1405,
      prunePlanBasis: 'model-tool-calls-only',
      noRecommendation: [
        { reason: 'core', items: 0, tokens: 0 },
        { reason: 'no-owner-bundle', items: 0, tokens: 0 },
        { reason: 'unknown-attribution', items: 1, tokens: 402 },
      ],
    },
    totals: {
      residentTokens: 4460,
      observableTokens: 3262,
      unknownUsageTokens: 1198,
      observedCalls: 137,
      observableTokensPerCall: 24,
      zeroCallItems: 6,
      zeroCallTokens: 1807,
      unknownUsageItems: 5,
    },
  }
}

/** 降级态（DESIGN §2.12）：日志不可读 ⇒ calls 全 null，observedCalls = 0 但不许当实测。 */
function degradedReport() {
  const report = canonicalReport()
  report.scope = {
    ...report.scope, sessionsAvailable: 0, sessionsScanned: 0, sessionsUnreadable: 0,
    windowStart: null, windowEnd: null, linesRead: 0, toolCalls: 0, skillToolCalls: 0,
    callsUnmatched: 0, callsUnmatchedNames: [], namesRejected: 0, usageAvailable: false, truncated: false,
    providerScan: { ...report.scope.providerScan, capped: true },
  }
  report.items = report.items.map((item) => (item.category === 'tools' || item.category === 'mcp'
    ? { ...item, calls: null, tokensPerCall: null, zeroCall: null, usageBasis: 'no-evidence' }
    : item))
  report.categories = report.categories.map((category) => (category.observableUsage
    ? { ...category, calls: null, tokensPerCall: null }
    : category))
  report.findings = {
    zeroCall: [], topPerUse: [], prunePlan: [],
    prunePlanReclaimableTokens: 0, prunePlanBasis: 'model-tool-calls-only',
    noRecommendation: [
      { reason: 'core', items: 0, tokens: 0 },
      { reason: 'no-owner-bundle', items: 0, tokens: 0 },
      { reason: 'unknown-attribution', items: 0, tokens: 0 },
    ],
  }
  report.totals = {
    ...report.totals, observedCalls: 0, observableTokensPerCall: null,
    zeroCallItems: 0, zeroCallTokens: 0, unknownUsageItems: 11,
  }
  return report
}

/** 一个类目塞满 8 条，用来验证「>6 行折叠为 cl.more」（DESIGN §4.3）。 */
function wideReport() {
  const report = canonicalReport()
  const tools = Array.from({ length: 8 }, (_, index) => ({
    id: `tools:fake_${index}`, category: 'tools', name: `fake_${index}`,
    tokens: 100 + index, calls: 2 + index, tokensPerCall: Math.round((100 + index) / (2 + index)),
    zeroCall: false, usageBasis: 'tool-calls', source: 'native',
    providedBy: pluginBy(`@example/fake-${index}`, `/tmp/fake-${index}/lib/index.js`),
  }))
  report.items = [...tools, ...report.items.filter((item) => item.category !== 'tools')]
  report.categories = report.categories.map((category) => (category.key === 'tools'
    ? { ...category, itemCount: 8, tokens: tools.reduce((sum, item) => sum + item.tokens, 0) }
    : category))
  return report
}

/** 低置信 + 长清单的裁剪候选（§4.7 第 4/7 条：单元行与明细行都要带「推断」标记；证据路径可查）。 */
function lowConfidencePruneReport() {
  const report = canonicalReport()
  report.findings.prunePlan = [{
    kind: 'plugin', target: '@example/low-conf',
    factPackages: ['@example/low-conf-ui'],
    items: [
      { id: 'tools:fake_low_1', category: 'tools', name: 'fake_low_1', tokens: 300 },
      { id: 'tools:fake_low_2', category: 'tools', name: 'fake_low_2', tokens: 200 },
    ],
    itemCount: 2, reclaimableTokens: 500, usedToolCount: 2, confidence: 'low',
  }]
  report.items = [
    { id: 'tools:fake_low_1', category: 'tools', name: 'fake_low_1', tokens: 300, calls: 0, tokensPerCall: null, zeroCall: true, usageBasis: 'tool-calls', source: 'native', providedBy: pluginBy('@example/low-conf-ui', '/tmp/low-conf-ui/lib/index.js', 'low', 'static-scan-weak') },
    { id: 'tools:fake_low_2', category: 'tools', name: 'fake_low_2', tokens: 200, calls: 0, tokensPerCall: null, zeroCall: true, usageBasis: 'tool-calls', source: 'native', providedBy: pluginBy('@example/low-conf-ui', '/tmp/low-conf-ui/lib/index.js', 'low', 'static-scan-weak') },
    ...report.items,
  ]
  return report
}

/**
 * 归属徽标 / 证据路径专用夹具：四个 tools 项 + 一个 mcp 项，覆盖
 * plugin(high) / plugin(low) / core / mcp-server / unknown 五种 providedBy，
 * 且条数小于 DETAIL_LIMIT（不被折叠，便于逐行断言）。
 */
function attributionReport() {
  const report = canonicalReport()
  report.items = [
    { id: 'tools:aaa_plugin_high', category: 'tools', name: 'aaa_plugin_high', tokens: 120, calls: 0, tokensPerCall: null, zeroCall: true, usageBasis: 'tool-calls', source: 'native', providedBy: pluginBy('@example/high', '/tmp/high/lib/index.js') },
    { id: 'tools:bbb_plugin_low', category: 'tools', name: 'bbb_plugin_low', tokens: 110, calls: 0, tokensPerCall: null, zeroCall: true, usageBasis: 'tool-calls', source: 'native', providedBy: pluginBy('@example/low', '/tmp/low/lib/index.js', 'low', 'static-scan-weak') },
    { id: 'tools:ccc_core', category: 'tools', name: 'ccc_core', tokens: 100, calls: 2, tokensPerCall: 50, zeroCall: false, usageBasis: 'tool-calls', source: 'native', providedBy: coreBy('/tmp/core/lib/index.js') },
    { id: 'tools:ddd_unknown', category: 'tools', name: 'ddd_unknown', tokens: 90, calls: 0, tokensPerCall: null, zeroCall: true, usageBasis: 'tool-calls', source: 'native', providedBy: unknownBy(['@a/one', '@b/two']) },
    { id: 'mcp:mcp__srv__t', category: 'mcp', name: 'mcp__srv__t', tokens: 80, calls: 0, tokensPerCall: null, zeroCall: true, usageBasis: 'tool-calls', source: 'mcp', server: 'srv', providedBy: mcpServer('srv') },
    ...report.items.filter((item) => item.category === 'instructions' || item.category === 'skills'),
  ]
  report.categories = report.categories.map((category) => {
    if (category.key === 'tools') return { ...category, itemCount: 4, tokens: 420, calls: 2, tokensPerCall: 210 }
    if (category.key === 'mcp') return { ...category, itemCount: 1, tokens: 80, calls: 0, tokensPerCall: null }
    return category
  })
  report.findings = {
    zeroCall: [
      { id: 'tools:aaa_plugin_high', category: 'tools', name: 'aaa_plugin_high', tokens: 120 },
      { id: 'tools:bbb_plugin_low', category: 'tools', name: 'bbb_plugin_low', tokens: 110 },
      { id: 'tools:ddd_unknown', category: 'tools', name: 'ddd_unknown', tokens: 90 },
      { id: 'mcp:mcp__srv__t', category: 'mcp', name: 'mcp__srv__t', tokens: 80 },
    ],
    topPerUse: [
      { id: 'tools:ccc_core', category: 'tools', name: 'ccc_core', tokens: 100, calls: 2, tokensPerCall: 50 },
    ],
    prunePlan: [],
    prunePlanReclaimableTokens: 0,
    prunePlanBasis: 'model-tool-calls-only',
    noRecommendation: [
      { reason: 'core', items: 0, tokens: 0 },
      { reason: 'no-owner-bundle', items: 0, tokens: 0 },
      { reason: 'unknown-attribution', items: 1, tokens: 90 },
    ],
  }
  return report
}

/**
 * DESIGN v3 §2.21 的 R6 完整示例（**逐字副本**，从 DESIGN 机械抽取，未手改数字）。
 * 24 个零调用工具 / hidePlanTokens 4261 / prunePlanReclaimableTokens 3376；
 * §2.21.1 的 A1–A17 恒等式在抽取时已逐条复核通过。
 */
const R6_EXAMPLE = {
  "tool": "context_ledger",
  "version": 3,
  "unit": "token",
  "items": [
    {
      "id": "mcp:mcp__openviking__add_resource",
      "category": "mcp",
      "name": "mcp__openviking__add_resource",
      "tokens": 891,
      "calls": 0,
      "zeroCall": true
    },
    {
      "id": "mcp:mcp__openviking__add_skill",
      "category": "mcp",
      "name": "mcp__openviking__add_skill",
      "tokens": 464,
      "calls": 0,
      "zeroCall": true
    },
    {
      "id": "tools:subagent",
      "category": "tools",
      "name": "subagent",
      "tokens": 402,
      "calls": 0,
      "zeroCall": true
    },
    {
      "id": "tools:task_board_github_repositories",
      "category": "tools",
      "name": "task_board_github_repositories",
      "tokens": 331,
      "calls": 0,
      "zeroCall": true
    },
    {
      "id": "tools:task_board_github_link_pr",
      "category": "tools",
      "name": "task_board_github_link_pr",
      "tokens": 298,
      "calls": 0,
      "zeroCall": true
    },
    {
      "id": "tools:task_board_schedule",
      "category": "tools",
      "name": "task_board_schedule",
      "tokens": 274,
      "calls": 0,
      "zeroCall": true
    },
    {
      "id": "tools:task_board_run",
      "category": "tools",
      "name": "task_board_run",
      "tokens": 242,
      "calls": 0,
      "zeroCall": true
    },
    {
      "id": "tools:modlens_read_image",
      "category": "tools",
      "name": "modlens_read_image",
      "tokens": 156,
      "calls": 0,
      "zeroCall": true
    },
    {
      "id": "tools:validate_dsh_ui",
      "category": "tools",
      "name": "validate_dsh_ui",
      "tokens": 133,
      "calls": 0,
      "zeroCall": true
    },
    {
      "id": "tools:read_mcp_resource",
      "category": "tools",
      "name": "read_mcp_resource",
      "tokens": 128,
      "calls": 0,
      "zeroCall": true
    },
    {
      "id": "mcp:mcp__openviking__tree",
      "category": "mcp",
      "name": "mcp__openviking__tree",
      "tokens": 122,
      "calls": 0,
      "zeroCall": true
    },
    {
      "id": "tools:task_board_github_refresh",
      "category": "tools",
      "name": "task_board_github_refresh",
      "tokens": 110,
      "calls": 0,
      "zeroCall": true
    },
    {
      "id": "tools:list_mcp_resources",
      "category": "tools",
      "name": "list_mcp_resources",
      "tokens": 96,
      "calls": 0,
      "zeroCall": true
    },
    {
      "id": "tools:annotation",
      "category": "tools",
      "name": "annotation",
      "tokens": 88,
      "calls": 0,
      "zeroCall": true
    },
    {
      "id": "tools:list_mcp_resource_templates",
      "category": "tools",
      "name": "list_mcp_resource_templates",
      "tokens": 88,
      "calls": 0,
      "zeroCall": true
    },
    {
      "id": "mcp:mcp__openviking__forget",
      "category": "mcp",
      "name": "mcp__openviking__forget",
      "tokens": 75,
      "calls": 0,
      "zeroCall": true
    },
    {
      "id": "tools:interrupt_agent",
      "category": "tools",
      "name": "interrupt_agent",
      "tokens": 74,
      "calls": 0,
      "zeroCall": true
    },
    {
      "id": "tools:task_board_set_parent",
      "category": "tools",
      "name": "task_board_set_parent",
      "tokens": 70,
      "calls": 0,
      "zeroCall": true
    },
    {
      "id": "tools:job_kill",
      "category": "tools",
      "name": "job_kill",
      "tokens": 52,
      "calls": 0,
      "zeroCall": true
    },
    {
      "id": "mcp:mcp__openviking__remember",
      "category": "mcp",
      "name": "mcp__openviking__remember",
      "tokens": 47,
      "calls": 0,
      "zeroCall": true
    },
    {
      "id": "tools:update_goal",
      "category": "tools",
      "name": "update_goal",
      "tokens": 45,
      "calls": 0,
      "zeroCall": true
    },
    {
      "id": "mcp:mcp__openviking__cancel_watch",
      "category": "mcp",
      "name": "mcp__openviking__cancel_watch",
      "tokens": 30,
      "calls": 0,
      "zeroCall": true
    },
    {
      "id": "mcp:mcp__openviking__list_watches",
      "category": "mcp",
      "name": "mcp__openviking__list_watches",
      "tokens": 27,
      "calls": 0,
      "zeroCall": true
    },
    {
      "id": "mcp:mcp__openviking__health",
      "category": "mcp",
      "name": "mcp__openviking__health",
      "tokens": 18,
      "calls": 0,
      "zeroCall": true
    }
  ],
  "findings": {
    "hidePlan": [
      {
        "id": "mcp:mcp__openviking__add_resource",
        "name": "mcp__openviking__add_resource",
        "category": "mcp",
        "tokens": 891,
        "unit": {
          "kind": "mcp-server",
          "target": "openviking",
          "factPackages": []
        },
        "registryUse": {
          "verdict": "unconfirmed",
          "verdictBasis": "no-non-model-observability",
          "modelCalls": 0,
          "nameReferencedElsewhere": [],
          "nonModelCallers": "unobservable"
        },
        "precheck": {
          "status": "prechecked",
          "restrictable": true,
          "reason": null
        },
        "selfTool": false
      },
      {
        "id": "mcp:mcp__openviking__add_skill",
        "name": "mcp__openviking__add_skill",
        "category": "mcp",
        "tokens": 464,
        "unit": {
          "kind": "mcp-server",
          "target": "openviking",
          "factPackages": []
        },
        "registryUse": {
          "verdict": "unconfirmed",
          "verdictBasis": "no-non-model-observability",
          "modelCalls": 0,
          "nameReferencedElsewhere": [],
          "nonModelCallers": "unobservable"
        },
        "precheck": {
          "status": "prechecked",
          "restrictable": true,
          "reason": null
        },
        "selfTool": false
      },
      {
        "id": "tools:subagent",
        "name": "subagent",
        "category": "tools",
        "tokens": 402,
        "unit": {
          "kind": "unknown",
          "target": null,
          "factPackages": []
        },
        "registryUse": {
          "verdict": "unconfirmed",
          "verdictBasis": "no-non-model-observability",
          "modelCalls": 0,
          "nameReferencedElsewhere": [
            "/home/u/.dsh/profiles/web/node_modules/@nanmicoder/dsh-agent-teams/lib/harness-compat.js",
            "/home/u/.dsh/profiles/web/node_modules/@linxin666/dsh-session-archive/lib/index.js"
          ],
          "nonModelCallers": "unobservable"
        },
        "precheck": {
          "status": "prechecked",
          "restrictable": true,
          "reason": null
        },
        "selfTool": false
      },
      {
        "id": "tools:task_board_github_repositories",
        "name": "task_board_github_repositories",
        "category": "tools",
        "tokens": 331,
        "unit": {
          "kind": "plugin",
          "target": "@linxin666/dsh-web-all",
          "factPackages": [
            "@linxin666/dsh-client-ui-task-board-github"
          ]
        },
        "registryUse": {
          "verdict": "unconfirmed",
          "verdictBasis": "no-non-model-observability",
          "modelCalls": 0,
          "nameReferencedElsewhere": [],
          "nonModelCallers": "unobservable"
        },
        "precheck": {
          "status": "prechecked",
          "restrictable": true,
          "reason": null
        },
        "selfTool": false
      },
      {
        "id": "tools:task_board_github_link_pr",
        "name": "task_board_github_link_pr",
        "category": "tools",
        "tokens": 298,
        "unit": {
          "kind": "plugin",
          "target": "@linxin666/dsh-web-all",
          "factPackages": [
            "@linxin666/dsh-client-ui-task-board-github"
          ]
        },
        "registryUse": {
          "verdict": "unconfirmed",
          "verdictBasis": "no-non-model-observability",
          "modelCalls": 0,
          "nameReferencedElsewhere": [],
          "nonModelCallers": "unobservable"
        },
        "precheck": {
          "status": "prechecked",
          "restrictable": true,
          "reason": null
        },
        "selfTool": false
      },
      {
        "id": "tools:task_board_schedule",
        "name": "task_board_schedule",
        "category": "tools",
        "tokens": 274,
        "unit": {
          "kind": "plugin",
          "target": "@linxin666/dsh-web-all",
          "factPackages": [
            "@linxin666/dsh-client-ui-task-board"
          ]
        },
        "registryUse": {
          "verdict": "unconfirmed",
          "verdictBasis": "no-non-model-observability",
          "modelCalls": 0,
          "nameReferencedElsewhere": [],
          "nonModelCallers": "unobservable"
        },
        "precheck": {
          "status": "prechecked",
          "restrictable": true,
          "reason": null
        },
        "selfTool": false
      },
      {
        "id": "tools:task_board_run",
        "name": "task_board_run",
        "category": "tools",
        "tokens": 242,
        "unit": {
          "kind": "plugin",
          "target": "@linxin666/dsh-web-all",
          "factPackages": [
            "@linxin666/dsh-client-ui-task-board"
          ]
        },
        "registryUse": {
          "verdict": "unconfirmed",
          "verdictBasis": "no-non-model-observability",
          "modelCalls": 0,
          "nameReferencedElsewhere": [],
          "nonModelCallers": "unobservable"
        },
        "precheck": {
          "status": "prechecked",
          "restrictable": true,
          "reason": null
        },
        "selfTool": false
      },
      {
        "id": "tools:modlens_read_image",
        "name": "modlens_read_image",
        "category": "tools",
        "tokens": 156,
        "unit": {
          "kind": "plugin",
          "target": "@liustack/modlens",
          "factPackages": [
            "@liustack/modlens"
          ]
        },
        "registryUse": {
          "verdict": "unconfirmed",
          "verdictBasis": "no-non-model-observability",
          "modelCalls": 0,
          "nameReferencedElsewhere": [],
          "nonModelCallers": "unobservable"
        },
        "precheck": {
          "status": "prechecked",
          "restrictable": true,
          "reason": null
        },
        "selfTool": false
      },
      {
        "id": "tools:validate_dsh_ui",
        "name": "validate_dsh_ui",
        "category": "tools",
        "tokens": 133,
        "unit": {
          "kind": "plugin",
          "target": "@changfenhuang/dsh-genui",
          "factPackages": [
            "@changfenhuang/dsh-genui"
          ]
        },
        "registryUse": {
          "verdict": "unconfirmed",
          "verdictBasis": "no-non-model-observability",
          "modelCalls": 0,
          "nameReferencedElsewhere": [],
          "nonModelCallers": "unobservable"
        },
        "precheck": {
          "status": "prechecked",
          "restrictable": true,
          "reason": null
        },
        "selfTool": false
      },
      {
        "id": "tools:read_mcp_resource",
        "name": "read_mcp_resource",
        "category": "tools",
        "tokens": 128,
        "unit": {
          "kind": "core",
          "target": null,
          "factPackages": []
        },
        "registryUse": {
          "verdict": "unconfirmed",
          "verdictBasis": "no-non-model-observability",
          "modelCalls": 0,
          "nameReferencedElsewhere": [],
          "nonModelCallers": "unobservable"
        },
        "precheck": {
          "status": "prechecked",
          "restrictable": true,
          "reason": null
        },
        "selfTool": false
      },
      {
        "id": "mcp:mcp__openviking__tree",
        "name": "mcp__openviking__tree",
        "category": "mcp",
        "tokens": 122,
        "unit": {
          "kind": "mcp-server",
          "target": "openviking",
          "factPackages": []
        },
        "registryUse": {
          "verdict": "unconfirmed",
          "verdictBasis": "no-non-model-observability",
          "modelCalls": 0,
          "nameReferencedElsewhere": [],
          "nonModelCallers": "unobservable"
        },
        "precheck": {
          "status": "prechecked",
          "restrictable": true,
          "reason": null
        },
        "selfTool": false
      },
      {
        "id": "tools:task_board_github_refresh",
        "name": "task_board_github_refresh",
        "category": "tools",
        "tokens": 110,
        "unit": {
          "kind": "plugin",
          "target": "@linxin666/dsh-web-all",
          "factPackages": [
            "@linxin666/dsh-client-ui-task-board-github"
          ]
        },
        "registryUse": {
          "verdict": "unconfirmed",
          "verdictBasis": "no-non-model-observability",
          "modelCalls": 0,
          "nameReferencedElsewhere": [],
          "nonModelCallers": "unobservable"
        },
        "precheck": {
          "status": "prechecked",
          "restrictable": true,
          "reason": null
        },
        "selfTool": false
      },
      {
        "id": "tools:list_mcp_resources",
        "name": "list_mcp_resources",
        "category": "tools",
        "tokens": 96,
        "unit": {
          "kind": "core",
          "target": null,
          "factPackages": []
        },
        "registryUse": {
          "verdict": "unconfirmed",
          "verdictBasis": "no-non-model-observability",
          "modelCalls": 0,
          "nameReferencedElsewhere": [],
          "nonModelCallers": "unobservable"
        },
        "precheck": {
          "status": "prechecked",
          "restrictable": true,
          "reason": null
        },
        "selfTool": false
      },
      {
        "id": "tools:annotation",
        "name": "annotation",
        "category": "tools",
        "tokens": 88,
        "unit": {
          "kind": "plugin",
          "target": "dsh-annotate",
          "factPackages": [
            "dsh-annotate"
          ]
        },
        "registryUse": {
          "verdict": "unconfirmed",
          "verdictBasis": "no-non-model-observability",
          "modelCalls": 0,
          "nameReferencedElsewhere": [],
          "nonModelCallers": "unobservable"
        },
        "precheck": {
          "status": "prechecked",
          "restrictable": true,
          "reason": null
        },
        "selfTool": false
      },
      {
        "id": "tools:list_mcp_resource_templates",
        "name": "list_mcp_resource_templates",
        "category": "tools",
        "tokens": 88,
        "unit": {
          "kind": "core",
          "target": null,
          "factPackages": []
        },
        "registryUse": {
          "verdict": "unconfirmed",
          "verdictBasis": "no-non-model-observability",
          "modelCalls": 0,
          "nameReferencedElsewhere": [],
          "nonModelCallers": "unobservable"
        },
        "precheck": {
          "status": "prechecked",
          "restrictable": true,
          "reason": null
        },
        "selfTool": false
      },
      {
        "id": "mcp:mcp__openviking__forget",
        "name": "mcp__openviking__forget",
        "category": "mcp",
        "tokens": 75,
        "unit": {
          "kind": "mcp-server",
          "target": "openviking",
          "factPackages": []
        },
        "registryUse": {
          "verdict": "unconfirmed",
          "verdictBasis": "no-non-model-observability",
          "modelCalls": 0,
          "nameReferencedElsewhere": [],
          "nonModelCallers": "unobservable"
        },
        "precheck": {
          "status": "prechecked",
          "restrictable": true,
          "reason": null
        },
        "selfTool": false
      },
      {
        "id": "tools:interrupt_agent",
        "name": "interrupt_agent",
        "category": "tools",
        "tokens": 74,
        "unit": {
          "kind": "core",
          "target": null,
          "factPackages": []
        },
        "registryUse": {
          "verdict": "unconfirmed",
          "verdictBasis": "no-non-model-observability",
          "modelCalls": 0,
          "nameReferencedElsewhere": [],
          "nonModelCallers": "unobservable"
        },
        "precheck": {
          "status": "prechecked",
          "restrictable": true,
          "reason": null
        },
        "selfTool": false
      },
      {
        "id": "tools:task_board_set_parent",
        "name": "task_board_set_parent",
        "category": "tools",
        "tokens": 70,
        "unit": {
          "kind": "plugin",
          "target": "@linxin666/dsh-web-all",
          "factPackages": [
            "@linxin666/dsh-client-ui-task-board"
          ]
        },
        "registryUse": {
          "verdict": "unconfirmed",
          "verdictBasis": "no-non-model-observability",
          "modelCalls": 0,
          "nameReferencedElsewhere": [],
          "nonModelCallers": "unobservable"
        },
        "precheck": {
          "status": "prechecked",
          "restrictable": true,
          "reason": null
        },
        "selfTool": false
      },
      {
        "id": "tools:job_kill",
        "name": "job_kill",
        "category": "tools",
        "tokens": 52,
        "unit": {
          "kind": "core",
          "target": null,
          "factPackages": []
        },
        "registryUse": {
          "verdict": "unconfirmed",
          "verdictBasis": "no-non-model-observability",
          "modelCalls": 0,
          "nameReferencedElsewhere": [],
          "nonModelCallers": "unobservable"
        },
        "precheck": {
          "status": "prechecked",
          "restrictable": true,
          "reason": null
        },
        "selfTool": false
      },
      {
        "id": "mcp:mcp__openviking__remember",
        "name": "mcp__openviking__remember",
        "category": "mcp",
        "tokens": 47,
        "unit": {
          "kind": "mcp-server",
          "target": "openviking",
          "factPackages": []
        },
        "registryUse": {
          "verdict": "unconfirmed",
          "verdictBasis": "no-non-model-observability",
          "modelCalls": 0,
          "nameReferencedElsewhere": [],
          "nonModelCallers": "unobservable"
        },
        "precheck": {
          "status": "prechecked",
          "restrictable": true,
          "reason": null
        },
        "selfTool": false
      },
      {
        "id": "tools:update_goal",
        "name": "update_goal",
        "category": "tools",
        "tokens": 45,
        "unit": {
          "kind": "core",
          "target": null,
          "factPackages": []
        },
        "registryUse": {
          "verdict": "unconfirmed",
          "verdictBasis": "no-non-model-observability",
          "modelCalls": 0,
          "nameReferencedElsewhere": [],
          "nonModelCallers": "unobservable"
        },
        "precheck": {
          "status": "prechecked",
          "restrictable": true,
          "reason": null
        },
        "selfTool": false
      },
      {
        "id": "mcp:mcp__openviking__cancel_watch",
        "name": "mcp__openviking__cancel_watch",
        "category": "mcp",
        "tokens": 30,
        "unit": {
          "kind": "mcp-server",
          "target": "openviking",
          "factPackages": []
        },
        "registryUse": {
          "verdict": "unconfirmed",
          "verdictBasis": "no-non-model-observability",
          "modelCalls": 0,
          "nameReferencedElsewhere": [],
          "nonModelCallers": "unobservable"
        },
        "precheck": {
          "status": "prechecked",
          "restrictable": true,
          "reason": null
        },
        "selfTool": false
      },
      {
        "id": "mcp:mcp__openviking__list_watches",
        "name": "mcp__openviking__list_watches",
        "category": "mcp",
        "tokens": 27,
        "unit": {
          "kind": "mcp-server",
          "target": "openviking",
          "factPackages": []
        },
        "registryUse": {
          "verdict": "unconfirmed",
          "verdictBasis": "no-non-model-observability",
          "modelCalls": 0,
          "nameReferencedElsewhere": [],
          "nonModelCallers": "unobservable"
        },
        "precheck": {
          "status": "prechecked",
          "restrictable": true,
          "reason": null
        },
        "selfTool": false
      },
      {
        "id": "mcp:mcp__openviking__health",
        "name": "mcp__openviking__health",
        "category": "mcp",
        "tokens": 18,
        "unit": {
          "kind": "mcp-server",
          "target": "openviking",
          "factPackages": []
        },
        "registryUse": {
          "verdict": "unconfirmed",
          "verdictBasis": "no-non-model-observability",
          "modelCalls": 0,
          "nameReferencedElsewhere": [],
          "nonModelCallers": "unobservable"
        },
        "precheck": {
          "status": "prechecked",
          "restrictable": true,
          "reason": null
        },
        "selfTool": false
      }
    ],
    "hidePlanTokens": 4261,
    "hidePlanUnits": [
      {
        "kind": "mcp-server",
        "target": "openviking",
        "factPackages": [],
        "toolCount": 8,
        "tokens": 1674,
        "usedToolCount": 8,
        "inPrunePlan": true
      },
      {
        "kind": "plugin",
        "target": "@linxin666/dsh-web-all",
        "factPackages": [
          "@linxin666/dsh-client-ui-task-board",
          "@linxin666/dsh-client-ui-task-board-github"
        ],
        "toolCount": 6,
        "tokens": 1325,
        "usedToolCount": 3,
        "inPrunePlan": true
      },
      {
        "kind": "core",
        "target": null,
        "factPackages": [],
        "toolCount": 6,
        "tokens": 483,
        "usedToolCount": 0,
        "inPrunePlan": false
      },
      {
        "kind": "unknown",
        "target": null,
        "factPackages": [],
        "toolCount": 1,
        "tokens": 402,
        "usedToolCount": 0,
        "inPrunePlan": false
      },
      {
        "kind": "plugin",
        "target": "@liustack/modlens",
        "factPackages": [
          "@liustack/modlens"
        ],
        "toolCount": 1,
        "tokens": 156,
        "usedToolCount": 0,
        "inPrunePlan": true
      },
      {
        "kind": "plugin",
        "target": "@changfenhuang/dsh-genui",
        "factPackages": [
          "@changfenhuang/dsh-genui"
        ],
        "toolCount": 1,
        "tokens": 133,
        "usedToolCount": 1,
        "inPrunePlan": true
      },
      {
        "kind": "plugin",
        "target": "dsh-annotate",
        "factPackages": [
          "dsh-annotate"
        ],
        "toolCount": 1,
        "tokens": 88,
        "usedToolCount": 0,
        "inPrunePlan": true
      }
    ],
    "hidePlanBasis": "model-tool-calls-only",
    "hidePlanStatus": "prechecked",
    "hideApply": {
      "mode": "suggestion-only",
      "interfacePresent": true,
      "denyList": [
        "annotation",
        "interrupt_agent",
        "job_kill",
        "list_mcp_resource_templates",
        "list_mcp_resources",
        "mcp__openviking__add_resource",
        "mcp__openviking__add_skill",
        "mcp__openviking__cancel_watch",
        "mcp__openviking__forget",
        "mcp__openviking__health",
        "mcp__openviking__list_watches",
        "mcp__openviking__remember",
        "mcp__openviking__tree",
        "modlens_read_image",
        "read_mcp_resource",
        "subagent",
        "task_board_github_link_pr",
        "task_board_github_refresh",
        "task_board_github_repositories",
        "task_board_run",
        "task_board_schedule",
        "task_board_set_parent",
        "update_goal",
        "validate_dsh_ui"
      ],
      "skipped": [],
      "applySupported": true,
      "appliedNames": []
    },
    "hidePlanCaveat": {
      "registryHideIsTotal": true,
      "nonModelRegistryCalls": "unobservable",
      "serviceCoupling": "unconfirmed",
      "confirmationRequired": true,
      "prefixCacheCost": "one-time-invalidation"
    },
    "prunePlan": [
      {
        "kind": "mcp-server",
        "target": "openviking",
        "factPackages": [],
        "itemCount": 8,
        "reclaimableTokens": 1674,
        "usedToolCount": 8,
        "confidence": "high"
      },
      {
        "kind": "plugin",
        "target": "@linxin666/dsh-web-all",
        "factPackages": [
          "@linxin666/dsh-client-ui-task-board",
          "@linxin666/dsh-client-ui-task-board-github"
        ],
        "itemCount": 6,
        "reclaimableTokens": 1325,
        "usedToolCount": 3,
        "confidence": "high"
      },
      {
        "kind": "plugin",
        "target": "@liustack/modlens",
        "factPackages": [
          "@liustack/modlens"
        ],
        "itemCount": 1,
        "reclaimableTokens": 156,
        "usedToolCount": 0,
        "confidence": "low"
      },
      {
        "kind": "plugin",
        "target": "@changfenhuang/dsh-genui",
        "factPackages": [
          "@changfenhuang/dsh-genui"
        ],
        "itemCount": 1,
        "reclaimableTokens": 133,
        "usedToolCount": 1,
        "confidence": "high"
      },
      {
        "kind": "plugin",
        "target": "dsh-annotate",
        "factPackages": [
          "dsh-annotate"
        ],
        "itemCount": 1,
        "reclaimableTokens": 88,
        "usedToolCount": 0,
        "confidence": "high"
      }
    ],
    "prunePlanReclaimableTokens": 3376,
    "prunePlanBasis": "model-tool-calls-only",
    "noRecommendation": [
      {
        "reason": "core",
        "items": 6,
        "tokens": 483
      },
      {
        "reason": "no-owner-bundle",
        "items": 0,
        "tokens": 0
      },
      {
        "reason": "unknown-attribution",
        "items": 1,
        "tokens": 402
      }
    ]
  }
}

/**
 * R6 报告：§2.21 的 findings + 它的 24 个零调用工具（另补 instructions/skills 项，
 * 让四类明细仍可渲染）。categories/totals 按这批数据自洽推导。
 */
function r6Report() {
  const base = canonicalReport()
  const items = R6_EXAMPLE.items
  const tools = items.filter((item) => item.category === 'tools')
  const mcp = items.filter((item) => item.category === 'mcp')
  const sum = (rows) => rows.reduce((total, row) => total + row.tokens, 0)
  return {
    ...base,
    version: 3,
    items: [
      ...items.map((item) => ({
        ...item,
        tokensPerCall: null,
        usageBasis: 'tool-calls',
        source: item.category === 'mcp' ? 'mcp' : 'native',
        ...(item.category === 'mcp' ? { server: 'openviking' } : {}),
      })),
      ...base.items.filter((item) => item.category === 'instructions' || item.category === 'skills'),
    ],
    categories: [
      base.categories[0],
      base.categories[1],
      { key: 'tools', itemCount: tools.length, tokens: sum(tools), calls: 0, tokensPerCall: null, observableUsage: true, mechanismCalls: null, mechanismTokensPerCall: null },
      { key: 'mcp', itemCount: mcp.length, tokens: sum(mcp), calls: 0, tokensPerCall: null, observableUsage: true, mechanismCalls: null, mechanismTokensPerCall: null },
    ],
    findings: {
      /* 深拷贝：R6_EXAMPLE 是模块级常量，直接引用会让各夹具互相污染（已踩过一次）。 */
      ...JSON.parse(JSON.stringify(R6_EXAMPLE.findings)),
      /* §2.21 是 R6 增量片段，未给 zeroCall/topPerUse；这里按 §2.5 口径从它的 24 项派生：
       * zeroCall = tokens 降序 → id 升序，上限 10；topPerUse = []（这批工具调用次数全为 0）。 */
      zeroCall: [...items]
        .sort((a, b) => b.tokens - a.tokens || (a.id < b.id ? -1 : 1))
        .slice(0, 10)
        .map((item) => ({ id: item.id, category: item.category, name: item.name, tokens: item.tokens })),
      topPerUse: [],
    },
    totals: {
      residentTokens: R6_EXAMPLE.findings.hidePlanTokens + 1198,
      observableTokens: R6_EXAMPLE.findings.hidePlanTokens,
      unknownUsageTokens: 1198,
      observedCalls: 0,
      observableTokensPerCall: null,
      zeroCallItems: R6_EXAMPLE.items.length,
      zeroCallTokens: R6_EXAMPLE.findings.hidePlanTokens,
      unknownUsageItems: 5,
    },
  }
}

/** §2.20 三态：未校验（有接口但拿不到 agent 作用域）——候选照列、denyList 为空、不给复制按钮。 */
function r6Unvalidated() {
  const report = r6Report()
  report.findings.hidePlanStatus = 'unvalidated'
  report.findings.hidePlan = report.findings.hidePlan.map((entry) => ({
    ...entry,
    precheck: { status: 'unvalidated', restrictable: null, reason: 'no-agent-scope' },
  }))
  report.findings.hideApply = {
    mode: 'suggestion-only', interfacePresent: true, denyList: [], skipped: [],
    applySupported: false, appliedNames: [],
  }
  return report
}

/** §2.20 三态：不支持（宿主没有该接口）——同样照列候选、不得抛错。 */
function r6Unsupported() {
  const report = r6Unvalidated()
  report.findings.hidePlanStatus = 'unsupported'
  report.findings.hidePlan = report.findings.hidePlan.map((entry) => ({
    ...entry,
    precheck: { status: 'unsupported', restrictable: null, reason: 'interface-absent' },
  }))
  report.findings.hideApply = {
    mode: 'suggestion-only', interfacePresent: false, denyList: [], skipped: [],
    applySupported: false, appliedNames: [],
  }
  return report
}

/** §2.23.4 的唯一例外：用户显式 opt-in 后 host 施加；面板必须说清"来自你的配置"。 */
function r6AppliedByConfig() {
  const report = r6Report()
  const applied = report.findings.hideApply.denyList.slice(0, 3)
  report.findings.hideApply = {
    ...report.findings.hideApply,
    mode: 'applied-by-config',
    appliedNames: applied,
    skipped: [{ name: 'x', reason: 'not-in-restrictable-names' }],
  }
  return report
}

/** §4.8 第 6 条：selfTool 候选（隐藏它会移除模型对本账本的入口）。 */
function r6SelfTool() {
  const report = r6Report()
  report.findings.hidePlan = [
    {
      id: 'tools:context_ledger', name: 'context_ledger', category: 'tools', tokens: 214,
      unit: { kind: 'plugin', target: 'dsh-context-ledger', factPackages: ['dsh-context-ledger'] },
      registryUse: { verdict: 'unconfirmed', verdictBasis: 'no-non-model-observability', modelCalls: 0, nameReferencedElsewhere: [], nonModelCallers: 'unobservable' },
      precheck: { status: 'prechecked', restrictable: true, reason: null },
      selfTool: true,
    },
    ...report.findings.hidePlan.map((entry) => ({ ...entry, selfTool: false })),
  ]
  return report
}

/** 无 hidePlan 的旧形状（v2 报告）：面板必须保守降级（未校验 + 空态 + 常驻声明）。 */
function r6Absent() {
  const report = canonicalReport()
  delete report.findings.hidePlan
  delete report.findings.hidePlanUnits
  delete report.findings.hidePlanStatus
  delete report.findings.hideApply
  return report
}

test('A. client.js 是经典脚本；loader 只从模块表取词；导出合规的 cordis 插件', () => {
  assert.equal(loaded.registration.id, 'dsh-context-ledger', 'bundle 注册 id 必须是包名')
  assert.equal(typeof loaded.registration.factory, 'function')
  assert.deepEqual([...new Set(loaded.requested)], ['react'], '只允许 require 模块表里的平台单例')

  const seed = loaded.seed
  assert.ok(seed.includes('react'), `platform seed 必须含 react（抽取到 ${seed.length} 个词：${seed.join(', ')}）`)
  console.log('[证据] loader 模块表（从已安装 web shell 抽取，%d 个词）：%s', seed.length, seed.join(', '))
  for (const specifier of loaded.requested) {
    assert.ok(seed.includes(specifier), `require("${specifier}") 不在 platform seed 里`)
  }

  assert.equal(loaded.plugin.name, 'context-ledger')
  assert.deepEqual(plain(loaded.plugin.inject), ['slots', 'locale'], 'cordis 服务注入：slots + locale')
  assert.equal(typeof loaded.plugin.apply, 'function')
  assert.deepEqual(Object.keys(loaded.plugin).sort(), ['apply', 'inject', 'name'],
    'loader 看到的插件导出只能是这三键（核验缝必须不可枚举）')
  assert.ok(loaded.plugin.__verify !== undefined)
  assert.equal(Object.getOwnPropertyDescriptor(loaded.plugin, '__verify').enumerable, false)

  // 交叉插件值导入是 harness 的 bundle purity 门禁禁区：客户端半区不得出现 @deepseek-ai/ 取词
  assert.equal(/require\(\s*["']@deepseek-ai\//.test(CLIENT_SRC), false)
  assert.equal(/^\s*(?:import|export)\s/m.test(CLIENT_SRC), false, 'client bundle 不得使用 ESM 语法')
})

test('A2. package.json 的 dsh.client / exports 声明符合宿主解析规则', () => {
  assert.equal(PKG.dsh.client.platform, 'web')
  assert.equal(PKG.dsh.client.immediately, true)
  assert.deepEqual(PKG.dsh.client.inject, [
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-conversation',
  ])
  // 宿主规则：clientExportOf 接受字符串或「有一层 default」的对象（dsh-client-modules/lib/index.js:170-181）
  const clientExport = PKG.exports['./client']
  const bundleRel = typeof clientExport === 'string' ? clientExport : clientExport?.default
  assert.equal(typeof bundleRel, 'string', 'exports["./client"] 必须是字符串或带 default 的对象')
  assert.ok(existsSync(join(REPO, bundleRel)), `客户端半区文件不存在：${bundleRel}`)
  assert.ok(PKG.files.includes(bundleRel.replace(/^\.\//, '')), 'files 必须包含客户端半区')

  for (const name of PKG.dsh.client.inject) {
    const pkgPath = join(NODE_MODULES, name, 'package.json')
    assert.ok(existsSync(pkgPath), `所 inject 的客户端包不存在：${name}`)
    const manifest = JSON.parse(readFileSync(pkgPath, 'utf8'))
    assert.equal(manifest.dsh?.client?.platform, 'web', `${name} 未声明 dsh.client.platform=web`)
    const rel = manifest.exports?.['./client']
    const file = typeof rel === 'string' ? rel : rel?.default
    assert.equal(typeof file, 'string', `${name} 未导出 ./client`)
    assert.ok(existsSync(join(NODE_MODULES, name, file)), `${name} 的客户端产物缺失：${file}`)
    assert.equal(manifest.version, '0.2.0-rc.2', `${name} 版本应为本机 0.2.0-rc.2`)
  }
})

test('A3. 宿主自己的图排序器接受本插件的 boot row', async () => {
  const { orderByModuleGraph } = await import(
    pathToFileURL(join(HOST, 'dsh-client-modules/lib/index.js')).href
  )
  const row = {
    id: 'dsh-context-ledger',
    url: '/dsh-context-ledger/client.js',
    rev: 'rev',
    inject: PKG.dsh.client.inject,
    immediately: true,
  }
  const ordered = orderByModuleGraph([row])
  assert.deepEqual(ordered.map((entry) => entry.id), ['dsh-context-ledger'])
})

test('B. 插槽落座：conversation.input.right / context-ledger / order 21 / locale 命名空间', () => {
  const { ctx, calls } = fakeContext()
  loaded.plugin.apply(ctx)

  assert.equal(calls.injectKey, 'conversation.input.right')
  assert.equal(typeof calls.injectCallback, 'function')
  const dispose = calls.injectCallback()
  assert.equal(typeof dispose, 'function', 'slots.inject 的 callback 必须返回 disposer')

  assert.equal(calls.registers.length, 1)
  const options = calls.registers[0].options
  assert.deepEqual(plain(options), {
    name: 'conversation.input.right',
    id: 'context-ledger',
    order: 21,
    locale: 'context-ledger',
  })
  assert.equal(typeof calls.registers[0].component, 'function')
  assert.equal(calls.registers[0].component, V.LedgerRing)

  // 词典走冻结命名空间，且注册进 ctx.effect（插件卸载即回收）
  assert.equal(calls.localeRegisters.length, 1)
  assert.equal(calls.localeRegisters[0].namespace, 'context-ledger')
  assert.deepEqual(Object.keys(calls.localeRegisters[0].dictionaries).sort(), ['en', 'zh'])
  assert.equal(calls.effects.length, 1)
  assert.equal(calls.effects[0].label, 'context-ledger: dictionaries')
  assert.equal(typeof calls.disposers[0], 'function', 'effect 必须返回 disposer（卸载时注销词典）')
})

test('B2. 宿主插槽契约一手证据（file:line）与控件落座位置', () => {
  const conversation = readFileSync(join(HOST, 'dsh-client-ui-conversation/lib/client.js'), 'utf8').split('\n')
  const declaration = conversation.findIndex((line) => line.includes('"conversation.input.right": {'))
  assert.ok(declaration > 0, '未找到插槽声明')
  assert.match(conversation[declaration + 1], /kind: "list"/, 'conversation.input.right 必须是 list 座位')
  assert.match(conversation[declaration + 2], /scope: "session"/)
  const renderSite = conversation.findIndex((line) => line.includes('renderSlot("conversation.input.right"'))
  assert.ok(renderSite > 0, '未找到 renderSlot 调用点')
  assert.ok(conversation[renderSite].includes('conversation.input.model'), '渲染点在 model 座位之前（工具行右端）')

  const contract = readFileSync(join(HOST, 'dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts'), 'utf8').split('\n')
  const typed = contract.findIndex((line) => line.includes("'conversation.input.right': {"))
  assert.ok(typed > 0)
  assert.match(contract[typed + 1], /kind: 'list'/)

  const catalog = readFileSync(join(HOST, 'dsh-cordis-client-runner/lib/client.js'), 'utf8').split('\n')
  const entry = catalog.findIndex((line) => line.includes('key: "conversation.input.right"'))
  assert.ok(entry > 0, '未找到插槽目录条目')
  const nextKey = catalog.findIndex((line, index) => index > entry && /^\s*key: "/.test(line))
  const block = catalog.slice(entry, nextKey === -1 ? entry + 80 : nextKey).join('\n')
  assert.match(block, /kind: "list"/)
  assert.match(block, /name: "id",\s*$/m, 'list 座位的 id 是必填 registerOption')
  assert.match(block, /name: "order",\s*$/m, 'order 是可选 registerOption')
  assert.match(block, /packages\/client\/ui-conversation\/src\/client\/contract\/slots\.ts:\d+/)
  assert.match(block, /source: /)

  // 我注入的两个服务确实由这两个客户端插件提供
  const renderer = readFileSync(join(HOST, 'dsh-client-ui-renderer/lib/client.js'), 'utf8').split('\n')
  const slotsService = renderer.findIndex((line) => line.includes('super(ctx, "slots")'))
  assert.ok(slotsService > 0, 'ctx.slots 由 dsh-client-ui-renderer 提供')
  const locale = readFileSync(join(HOST, 'dsh-client-locale/lib/client.js'), 'utf8')
  assert.match(locale, /ctx\.provide\("locale", locale\)/, 'ctx.locale 由 dsh-client-locale 提供')

  console.log('[证据] 插槽声明 dsh-client-ui-conversation/lib/client.js:%d（kind: list）', declaration + 1)
  console.log('[证据] 渲染点   dsh-client-ui-conversation/lib/client.js:%d', renderSite + 1)
  console.log('[证据] 类型契约 dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:%d', typed + 1)
  console.log('[证据] 插槽目录 dsh-cordis-client-runner/lib/client.js:%d', entry + 1)
  console.log('[证据] slots 服务 dsh-client-ui-renderer/lib/client.js:%d', slotsService + 1)
})

test('C. 词典：命名空间 context-ledger，zh/en 同键；v1+v2 键一个未删、未改值；v3 键两语言齐全', () => {
  assert.equal(V.NS, 'context-ledger')
  const zhKeys = Object.keys(V.dictionaries.zh).sort()
  const enKeys = Object.keys(V.dictionaries.en).sort()
  assert.deepEqual(zhKeys, enKeys, 'zh/en 必须同键（§4.5 硬要求）')
  assert.deepEqual(zhKeys, [...FROZEN_KEYS, ...V3_KEYS].sort(),
    '键集 = v1+v2（54，保持）+ v3（45，本轮新增）；不得增删')
  assert.deepEqual([...V3_KEYS].sort(), [...V3_KEYS].sort())

  for (const key of FROZEN_KEYS) {
    assert.equal(typeof V.dictionaries.zh[key], 'string')
    assert.equal(typeof V.dictionaries.en[key], 'string')
    assert.notEqual(V.dictionaries.zh[key], '', `${key} 中文文案不得为空`)
  }
  /* 既有（v1+v2）键不得改值：定点核对代表值 + 全量非空 */
  for (const [key, value] of Object.entries(FROZEN_VALUES)) {
    assert.equal(V.dictionaries.zh[key], value, `既有键 ${key} 的值不得改（R2 冻结）`)
  }
  for (const key of FROZEN_KEYS) {
    assert.notEqual(V.dictionaries.zh[key].trim(), '', `${key} 不得被清空`)
  }
  /* v3 键两语言齐全且非空 */
  for (const key of V3_KEYS) {
    assert.equal(typeof V.dictionaries.zh[key], 'string', `${key} 缺中文文案`)
    assert.equal(typeof V.dictionaries.en[key], 'string', `${key} 缺英文文案`)
    assert.notEqual(V.dictionaries.zh[key].trim(), '', `${key} 中文文案不得为空`)
    assert.notEqual(V.dictionaries.en[key].trim(), '', `${key} 英文文案不得为空`)
  }
  // 产品名词不翻译
  for (const noun of ['token', 'schema', 'MCP', 'Context Ledger']) {
    assert.ok(V.dictionaries.zh[keyOf(noun)].includes(noun), `zh 文案应保留产品名词 ${noun}`)
  }
  function keyOf(noun) {
    return { token: 'cl.tokens', schema: 'cl.cat.tools', MCP: 'cl.cat.mcp', 'Context Ledger': 'cl.title' }[noun]
  }
})

test('D. 状态三分：zero / unknown / no-evidence 互斥，calls=null 绝不判成零调用', () => {
  assert.equal(V.itemState({ calls: 0, zeroCall: true, usageBasis: 'tool-calls' }), 'zero')
  assert.equal(V.itemState({ calls: 3, zeroCall: false, usageBasis: 'tool-calls' }), 'used')
  assert.equal(V.itemState({ calls: null, zeroCall: null, usageBasis: 'unobservable' }), 'unknown')
  assert.equal(V.itemState({ calls: null, zeroCall: null, usageBasis: 'always-on' }), 'unknown')
  assert.equal(V.itemState({ calls: null, zeroCall: null, usageBasis: 'no-evidence' }), 'no-evidence')

  const zero = V.chipColor('zero')
  const unknown = V.chipColor('unknown')
  const noEvidence = V.chipColor('no-evidence')
  assert.notEqual(zero, unknown)
  assert.notEqual(unknown, noEvidence)
  assert.notEqual(zero, noEvidence)
})

test('D2. 分类固定顺序 / 占比 / 折叠 / 总览降级保护', () => {
  const report = canonicalReport()
  const rows = V.categoryRows(report)
  assert.deepEqual(plain(rows.map((row) => row.key)), ['instructions', 'skills', 'tools', 'mcp'])
  assert.deepEqual(plain(rows.map((row) => row.tokens)), [812, 386, 2113, 1149])
  assert.equal(rows[0].share, 812 / 4460)
  assert.equal(rows[1].mechanism.calls, 9)
  assert.equal(rows[1].mechanism.each, 43)
  assert.deepEqual(plain(V.categoryRows({ ...report, totals: { ...report.totals, residentTokens: 0 } })
    .map((row) => row.share)), [null, null, null, null], '除零保护：不画占比条')

  // 分类内保持 canonical items 相对顺序（rank0 零调用 top → rank1 → rank2）
  assert.deepEqual(plain(V.itemsOfCategory(report, 'tools').map((item) => item.name)),
    ['subagent', 'task_board_list', 'task_board_github_list', 'task_board_schedule',
      'context_ledger', 'agent_teams_claim_task', 'read', 'bash'])

  const wide = V.itemsOfCategory(wideReport(), 'tools')
  assert.equal(wide.length, 8)
  assert.equal(V.foldRows(wide, V.DETAIL_LIMIT).shown.length, 6)
  assert.equal(V.foldRows(wide, V.DETAIL_LIMIT).hidden, 2)

  const healthy = V.overview(report, T)
  assert.deepEqual(plain(healthy.map((stat) => stat.key)), ['resident', 'calls', 'perUse'])
  assert.equal(healthy[0].value, '4,460')
  assert.equal(healthy[1].value, '137')
  assert.equal(healthy[2].value, '24')
  assert.match(healthy[1].sub, /20 \/ 41/)
  assert.match(healthy[1].sub, /\d{2}-\d{2} \d{2}:\d{2} → \d{2}-\d{2} \d{2}:\d{2}/, 'window 按本地时区渲染')

  const degraded = V.overview(degradedReport(), T)
  assert.equal(degraded[1].value, T('cl.unknown'), '降级态：observedCalls=0 不是实测，必须显示未知')
  assert.equal(degraded[1].unknown, true)
  assert.equal(degraded[2].value, T('cl.unknown'))
})

test('E. canonical 报告渲染（zh 词典独立渲染）：五段版面 + 零调用徽标 + 每次使用成本', () => {
  mini.reset()
  const tree = mini.render(V.LedgerPanel, { id: 'p', t: ZH, report: canonicalReport(), state: 'ready', refreshedAt: Date.now(), onRefresh() {} })
  const text = textOf(tree)
  const nodes = nodesOf(tree)

  // 1 标题行（标题 + 副标题 + 更新时间 + 刷新）
  assert.ok(text.includes('Context Ledger'))
  assert.ok(text.includes(ZH('cl.subtitle')))
  assert.ok(text.includes(ZH('cl.refresh')))
  assert.ok(text.includes(ZH('cl.updated', { when: ZH('cl.unknown') })) === false, '有 refreshedAt 时应显示具体时刻')

  // 2 三数字总览
  assert.equal(nodes.filter((node) => node.props?.['data-cl-panel'] !== undefined).length, 1)
  assert.ok(text.includes('4,460'))
  assert.ok(text.includes('137'))
  assert.ok(text.includes('24'))

  // 3 两个对账清单（直接消费 findings，不重排）
  assert.ok(text.includes(ZH('cl.zeroCallTitle')))
  assert.ok(text.includes(ZH('cl.topPerUseTitle')))
  const zeroBlock = nodesOf(nodes.find((node) => node.props?.['data-cl-block'] === 'zero-call'))
  const zeroRows = zeroBlock.filter((node) => node.props?.['data-cl-row'] !== undefined)
  assert.deepEqual(zeroRows.map((node) => node.props['data-cl-state']),
    ['zero', 'zero', 'zero', 'zero', 'zero', 'zero'])
  assert.ok(zeroRows.every((node) => textOf(node).includes(ZH('cl.neverCalled'))))
  assert.ok(zeroRows.every((node) => textOf(node).includes(ZH('cl.unknown'))), '零调用项的次数不可用 → 第 3 列必须是未知')
  assert.match(textOf(zeroBlock[0]), /add_resource.*402/s)
  const topBlock = nodesOf(nodes.find((node) => node.props?.['data-cl-block'] === 'top-per-use'))
  const topRows = topBlock.filter((node) => node.props?.['data-cl-row'] !== undefined)
  assert.deepEqual(topRows.map((node) => node.props['data-cl-state']), ['used', 'used', 'used', 'used', 'used'])
  assert.ok(textOf(topRows[0]).includes('context_ledger'))
  assert.ok(textOf(topRows[0]).includes('71'), '每次使用成本列必须出现')
  assert.ok(textOf(topRows[0]).includes('3'), '调用次数列必须出现')

  // 4 四类明细（固定顺序；只在明细块内取下标，清单徽标里也会出现分类名）
  const categoriesBlock = nodes.find((node) => node.props?.['data-cl-block'] === 'categories')
  const categoriesText = textOf(categoriesBlock)
  const order = ['instructions', 'skills', 'tools', 'mcp'].map((key) => categoriesText.indexOf(ZH('cl.cat.' + key)))
  assert.ok(order.every((index) => index > 0), '四类明细行必须都在')
  assert.deepEqual([...order].sort((a, b) => a - b), order, '分类行必须固定顺序 instructions→skills→tools→mcp')
  assert.ok(categoriesText.includes(ZH('cl.alwaysOnNote')))
  assert.ok(categoriesText.includes(ZH('cl.skillsUnknownNote')))
  assert.ok(categoriesText.includes(ZH('cl.skillLoads', { calls: '9', each: '43' })), 'skills 机制级对账必须出现')
  assert.ok(text.includes('AGENTS.md') === false, '未展开时不渲染条目行（AGENTS.md 只在展开后出现）')

  // 5 页脚：证据行 + 隐私声明
  assert.ok(text.includes('--home-u-Desktop-DSHWorkspace--'))
  assert.ok(text.includes(ZH('cl.sessionsCovered', { scanned: '20', available: '41' })))
  assert.ok(text.includes('namesRejected 0'))
  assert.ok(text.includes(ZH('cl.privacyNote')))
  assert.equal(text.includes('truncated'), false, 'truncated=false 不显示')

  // 未知项不得渲染成 0，也不得进零调用清单
  assert.equal(/genui[^]{0,120}0 次/.test(text), false)
})

test('E2. 零调用项之外的 calls=null 一律渲染为未知，绝不渲染成 0', () => {
  const report = canonicalReport()
  report.findings = { zeroCall: [], topPerUse: [] }
  report.items = report.items.map((item) => (item.category === 'tools'
    ? { ...item, calls: null, tokensPerCall: null, zeroCall: null, usageBasis: 'unobservable' }
    : item))
  mini.reset()
  const tree = mini.render(V.LedgerPanel, { id: 'p', t: ZH, report, state: 'ready', refreshedAt: 0, onRefresh() {} })
  const text = textOf(tree)
  const nodes = nodesOf(tree)
  assert.equal(text.includes(ZH('cl.neverCalled')), false, '没有任何有证据的零调用项时不得出现「0 次」')
  assert.equal(nodes.filter((node) => node.props?.['data-cl-state'] === 'zero').length, 0)
  assert.ok(text.includes(ZH('cl.empty')), '清单为空 → 空态文案（不包装成结论）')
  assert.equal(nodes.filter((node) => node.props?.['data-cl-row'] !== undefined).length, 0,
    '未展开时不渲染条目行')

  // 展开 tools 类目：六行全部是 unknown（calls === null，绝不是 0）
  const toolsHead = nodesOf(tree).find((node) => node.props?.['data-cl-category'] === 'tools').props.children[0]
  toolsHead.props.onClick()
  const expandedTree = mini.render(V.LedgerPanel, { id: 'p', t: ZH, report, state: 'ready', refreshedAt: 0, onRefresh() {} })
  const rows = nodesOf(expandedTree).filter((node) => node.props?.['data-cl-row'] === 'tools')
  assert.equal(rows.length, 6, 'v2 fixture 的 tools 有 8 项，明细按 DETAIL_LIMIT=6 折叠')
  assert.deepEqual(rows.map((node) => node.props['data-cl-state']).filter((state) => state !== 'unknown'), [])
  assert.ok(textOf(expandedTree).includes(ZH('cl.more', { n: '2' })), '折起的 2 行用 cl.more 计数')
  assert.ok(rows.every((node) => textOf(node).includes(ZH('cl.unknown'))))
  assert.equal(textOf(expandedTree).includes(ZH('cl.neverCalled')), false)
})

test('E3. 降级态：顶部提示条 + 清单空态 + 总览不伪装成 0', () => {
  mini.reset()
  const tree = mini.render(V.LedgerPanel, { id: 'p', t: ZH, report: degradedReport(), state: 'ready', refreshedAt: 0, onRefresh() {} })
  const nodes = nodesOf(tree)
  const text = textOf(tree)
  assert.equal(nodes.filter((node) => node.props?.['data-cl-notice'] === 'no-evidence').length, 1)
  assert.ok(text.includes(ZH('cl.noEvidence')))
  assert.equal(text.includes(ZH('cl.neverCalled')), false, '降级态不得出现零调用徽标')
  assert.equal(nodes.filter((node) => node.props?.['data-cl-state'] === 'zero').length, 0)
  const zeroBlock = nodes.find((node) => node.props?.['data-cl-block'] === 'zero-call')
  assert.ok(textOf(zeroBlock).includes(ZH('cl.empty')), '降级态清单段显示空态')
  const statValues = nodes.filter((node) => node.props?.key === 'n').map((node) => textOf(node))
  assert.equal(statValues.length, 3)
  assert.equal(statValues[0], '4,460', '常驻合计仍是真实测量值')
  assert.equal(statValues[1], ZH('cl.unknown'), '降级态：observedCalls=0 不是实测，必须是未知')
  assert.equal(statValues[2], ZH('cl.unknown'))
})

test('E4. 展开与折叠：>6 行只渲染 6 行 + cl.more', () => {
  mini.reset()
  const report = wideReport()
  const baseProps = { id: 'p', t: ZH, report, state: 'ready', refreshedAt: 0, onRefresh() {} }
  /** 只取某个分类容器内的条目行（清单段的行也带 data-cl-row，必须隔离）。 */
  const categoryRowsOf = (tree, category) => {
    const container = nodesOf(tree).find((node) => node.props?.['data-cl-category'] === category)
    return nodesOf(container.props.children).filter((node) => node.props?.['data-cl-row'] === category)
  }
  let tree = mini.render(V.LedgerPanel, baseProps)
  const toolsHead = nodesOf(tree).find((node) => node.props?.['data-cl-category'] === 'tools').props.children[0]
  assert.equal(toolsHead.props['aria-expanded'], false)
  assert.equal(categoryRowsOf(tree, 'tools').length, 0, '未展开则不渲染条目行')
  toolsHead.props.onClick()
  tree = mini.render(V.LedgerPanel, baseProps)
  assert.equal(categoryRowsOf(tree, 'tools').length, 6, '展开后折叠为 6 行（DETAIL_LIMIT）')
  assert.equal(textOf(tree).includes(ZH('cl.more', { n: '2' })), true, '必须显示「还有 2 项」')
  const head = nodesOf(tree).find((node) => node.props?.['data-cl-category'] === 'tools').props.children[0]
  assert.equal(head.props['aria-expanded'], true)
  head.props.onClick()
  const collapsed = mini.render(V.LedgerPanel, baseProps)
  assert.equal(categoryRowsOf(collapsed, 'tools').length, 0, '再点收起')
  assert.equal(textOf(collapsed).includes(ZH('cl.more', { n: '2' })), false)
})

test('E5. 触发器与错误边界：控件在未展开时不渲染浮层；面板崩了不拖垮宿主', () => {
  mini.reset()
  const triggerTree = mini.render(V.LedgerRing, { t: T, sessionId: 'session-1' })
  const trigger = nodesOf(triggerTree).find((node) => node.type === 'button')
  assert.ok(trigger !== undefined)
  assert.equal(trigger.props['aria-label'], 'Context Ledger')
  assert.ok(trigger.props.title.includes(T('cl.hint')))
  assert.equal(trigger.props['aria-expanded'], false)
  assert.equal(nodesOf(triggerTree).filter((node) => node.props?.['data-cl-panel'] !== undefined).length, 0)

  const boundary = new V.PanelBoundary({ t: T, children: 'ok' })
  assert.equal(boundary.render(), 'ok')
  Object.assign(boundary.state, V.PanelBoundary.getDerivedStateFromError())
  assert.equal(textOf(boundary.render()), T('cl.error'))
})

test('E6. 不轮询 / 不外发数据：唯一的取数是宿主同源路由', () => {
  assert.equal(V.API, '/api/context-ledger/ledger')
  const fetches = [...CLIENT_SRC.matchAll(/fetch\(([^)]*)\)/g)].map((match) => match[1])
  assert.equal(fetches.length, 1, '只允许一个 fetch 调用点（打开时拉取 + 手动刷新共用）')
  assert.ok(CLIENT_SRC.includes("LEDGER_API + '?session=' + encodeURIComponent(sessionId)"))
  assert.equal(/setInterval|setTimeout/.test(CLIENT_SRC), false, '不做后台轮询')
  assert.equal(CLIENT_SRC.includes('localStorage'), false)
})

test('E7. 加载态 / 错误态 / 证据告警：状态与事实都如实呈现', () => {
  // 加载态：还没有报告
  mini.reset()
  const loading = textOf(mini.render(V.LedgerPanel, { id: 'p', t: ZH, report: null, state: 'loading', refreshedAt: 0, onRefresh() {} }))
  assert.ok(loading.includes(ZH('cl.loading')))

  // 错误态：只给状态码之类的短码，不承载宿主任意串
  mini.reset()
  const failed = textOf(mini.render(V.LedgerPanel, {
    id: 'p', t: ZH, report: null, state: 'error', error: 'HTTP 404', refreshedAt: 0, onRefresh() {},
  }))
  assert.ok(failed.includes(ZH('cl.error')))
  assert.ok(failed.includes('HTTP 404'))

  // 证据行：truncated 与 namesRejected 是事实信号，必须出现（§4.2.5）
  const report = canonicalReport()
  report.scope = { ...report.scope, truncated: true, namesRejected: 3 }
  mini.reset()
  const tree = mini.render(V.LedgerPanel, { id: 'p', t: ZH, report, state: 'ready', refreshedAt: 0, onRefresh() {} })
  const text = textOf(tree)
  assert.ok(text.includes('truncated'), 'truncated=true 必须在证据行出现')
  assert.ok(text.includes('namesRejected 3'))
  assert.ok(text.includes(ZH('cl.rejectedWarning', { n: '3' })), 'namesRejected>0 是告警一行，不静默')

  // 刷新按钮存在且可点（onRefresh 会被调用）
  let refreshed = 0
  mini.reset()
  const withRefresh = mini.render(V.LedgerPanel, {
    id: 'p', t: ZH, report, state: 'ready', refreshedAt: 0, onRefresh() { refreshed += 1 },
  })
  const button = nodesOf(withRefresh).find((node) => node.type === 'button' && textOf(node).includes(ZH('cl.refresh')))
  assert.ok(button !== undefined)
  button.props.onClick()
  assert.equal(refreshed, 1)
})

test('A4. 隔离 profile 的 node_modules 能解析出客户端半区（宿主 loader 扫描的实际路径）', (t) => {
  const profileRoot = '/home/u/Desktop/DSHWorkspace/.feas/isolated-home/profiles/testbed'
  if (!existsSync(join(profileRoot, 'node_modules/dsh-context-ledger'))) {
    t.skip('隔离 profile 未安装本插件（先 dsh plugin --profile testbed add link:<repo>）')
    return
  }
  const require = createRequire(join(profileRoot, 'package.json'))
  const pkgJson = require.resolve('dsh-context-ledger/package.json')
  const client = require.resolve('dsh-context-ledger/client')
  assert.ok(existsSync(client))
  assert.equal(JSON.parse(readFileSync(pkgJson, 'utf8')).dsh.client.platform, 'web')
  console.log('[证据] 隔离 profile 解析：%s → %s', pkgJson, client)
})

/* ══════════════════════════════════════════════════════════════════════════
 * F 组：R2 —— DESIGN §4.7 的硬性呈现义务（逐条可核）
 * ══════════════════════════════════════════════════════════════════════════ */

/** 渲染面板并返回可断言的视图。 */
function renderPanel(report, t = ZH, verify = V) {
  mini.reset()
  const tree = mini.render(verify.LedgerPanel, {
    id: 'p', t, report, state: 'ready', refreshedAt: 0, onRefresh() {},
  })
  return { tree, nodes: nodesOf(tree), text: textOf(tree) }
}

/** 取某个块的节点（`data-cl-block`）。 */
function blockOf(nodes, key) {
  return nodes.find((node) => node.props?.['data-cl-block'] === key)
}

/** 取块内的裁剪候选行。 */
function pruneRowsOf(nodes) {
  const block = blockOf(nodes, 'prune-plan')
  return nodesOf(block).filter((node) => node.props?.['data-cl-prune-row'] !== undefined)
}

/** 取某行内的某个字段节点（§4.7 第 2 条的五件事实各有自己的标记）。 */
function fieldOf(row, attribute) {
  return nodesOf(row).find((node) => node.props?.[attribute] !== undefined)
}

test('F1. 候选语气（§4.7 第 1 条）：段标题逐字契约 + 全文无确定性措辞 + 无红色告警样式', () => {
  const { nodes, text } = renderPanel(canonicalReport())
  const pruneBlock = blockOf(nodes, 'prune-plan')
  const title = fieldOf(pruneBlock, 'data-cl-prune-title')

  // 段标题逐字来自 §4.7 第 1 条（zh「零调用候选 · 需人工确认」/ en「Never-called candidates · needs your call」）
  assert.equal(V.dictionaries.zh['cl.prunePlanTitle'], '零调用候选 · 需人工确认')
  assert.equal(V.dictionaries.en['cl.prunePlanTitle'], 'Never-called candidates · needs your call')
  assert.equal(textOf(title), '零调用候选 · 需人工确认')
  assert.ok(textOf(pruneBlock).includes('需人工确认'))

  // 确定性/贬损措辞一律不得出现（两种语言的词典与整屏文本）
  const FORBIDDEN = [
    '建议卸载', '可以删掉', '浪费', '无用', '应该删除', '值得删除',
    'uninstall advice', 'you should remove', 'safe to delete', 'worthless', 'wasted',
    'should be uninstalled', 'recommend removing',
  ]
  for (const [lang, dict] of Object.entries(V.dictionaries)) {
    for (const [key, value] of Object.entries(dict)) {
      for (const bad of FORBIDDEN) {
        assert.equal(value.includes(bad), false, `词典 ${lang}/${key} 不得含确定性措辞「${bad}」`)
      }
    }
  }
  for (const bad of FORBIDDEN) {
    assert.equal(text.includes(bad), false, `面板不得出现「${bad}」`)
  }

  // 不得用红色告警样式暗示危害（§4.7 第 1 条）
  for (const row of pruneRowsOf(nodes)) {
    assert.equal(/state-error-primary/.test(JSON.stringify(row.props.style)), false,
      '裁剪候选行不得使用错误/告警红')
    const low = fieldOf(row, 'data-cl-prune-low')
    if (low !== undefined) {
      assert.equal(/state-error-primary/.test(JSON.stringify(low.props.style)), false)
    }
  }
})

test('F2. 每行五件事实齐备（§4.7 第 2 条）：缺一即缺陷', () => {
  const report = canonicalReport()
  const { nodes } = renderPanel(report)
  const rows = pruneRowsOf(nodes)
  assert.equal(rows.length, report.findings.prunePlan.length, '候选行数与 findings.prunePlan 一致')

  // 每行必须有五个独立字段节点，且文本非空（结构上"缺一即缺陷"）
  for (const row of rows) {
    for (const attribute of ['data-cl-prune-unit', 'data-cl-prune-tools', 'data-cl-prune-reclaim',
      'data-cl-prune-used', 'data-cl-prune-facts']) {
      const field = fieldOf(row, attribute)
      assert.ok(field !== undefined, `${row.props['data-cl-prune-row']} 缺字段 ${attribute}`)
      assert.ok(textOf(field).trim() !== '', `${attribute} 不得为空`)
    }
  }

  // 单元 1：mcp-server openviking（五项逐一点名）
  const mcpRow = rows.find((node) => node.props['data-cl-prune-row'] === 'openviking')
  assert.equal(textOf(fieldOf(mcpRow, 'data-cl-prune-unit')), 'MCP 服务器 · openviking')
  assert.equal(textOf(fieldOf(mcpRow, 'data-cl-prune-tools')), '2 个未调用工具：mcp__openviking__add_resource, mcp__openviking__forget')
  assert.equal(textOf(fieldOf(mcpRow, 'data-cl-prune-reclaim')), '若未使用可省 743 token')
  assert.equal(textOf(fieldOf(mcpRow, 'data-cl-prune-used')), '另有 1 个工具在用')
  assert.equal(textOf(fieldOf(mcpRow, 'data-cl-prune-facts')), '事实包：—')

  // 单元 2：plugin @linxin666/dsh-web-all（factPackages 非空 → 必须列出来）
  const pluginRow = rows.find((node) => node.props['data-cl-prune-row'] === '@linxin666/dsh-web-all')
  assert.equal(textOf(fieldOf(pluginRow, 'data-cl-prune-unit')), '插件包 · @linxin666/dsh-web-all')
  assert.equal(textOf(fieldOf(pluginRow, 'data-cl-prune-tools')),
    '3 个未调用工具：task_board_list, task_board_github_list, task_board_schedule')
  assert.equal(textOf(fieldOf(pluginRow, 'data-cl-prune-reclaim')), '若未使用可省 662 token')
  assert.equal(textOf(fieldOf(pluginRow, 'data-cl-prune-facts')),
    '事实包：@linxin666/dsh-client-ui-task-board, @linxin666/dsh-client-ui-task-board-github')

  // 可省 token 必须带「若未使用」条件语（§4.7 第 2 条 / §2.11）
  assert.ok(textOf(fieldOf(pluginRow, 'data-cl-prune-reclaim')).includes('若未使用'))
  assert.equal(V.dictionaries.en['cl.pruneReclaimableTokens'].includes('if unused'), true)

  // 行内展示代表工具名；完整清单在展开里（§4.7 第 2 条）
  assert.equal(fieldOf(pluginRow, 'data-cl-prune-detail'), undefined, '未展开时不渲染完整清单')
})

test('F3. usedToolCount：0 必须显示「该单元无在用工具」，>0 必须显示「另有 N 个工具在用」', () => {
  const { nodes } = renderPanel(canonicalReport())
  const rows = pruneRowsOf(nodes)
  const usedOf = (target) => textOf(fieldOf(rows.find((node) => node.props['data-cl-prune-row'] === target), 'data-cl-prune-used'))

  assert.equal(usedOf('@linxin666/dsh-web-all'), '该单元无在用工具', 'usedToolCount=0 也要显示，不省略该行')
  assert.equal(usedOf('openviking'), '另有 1 个工具在用')

  // 纯映射逐值核对（含复数形态与英文）
  assert.equal(V.usedToolsText({ usedToolCount: 0 }, ZH), '该单元无在用工具')
  assert.equal(V.usedToolsText({ usedToolCount: 1 }, ZH), '另有 1 个工具在用')
  assert.equal(V.usedToolsText({ usedToolCount: 3 }, ZH), '另有 3 个工具在用')
  assert.equal(V.usedToolsText({ usedToolCount: 0 }, T), 'no tool of this unit is in use')
  assert.equal(V.usedToolsText({ usedToolCount: 1 }, T), '1 other tool of this unit is in use')
  assert.equal(V.usedToolsText({ usedToolCount: 3 }, T), '3 other tools of this unit are in use')

  // 两种措辞都在**同一个冻结键**里逐字保留（§4.5 只给了 cl.pruneUsedTools 一个键）
  const zhVariants = V.dictionaries.zh['cl.pruneUsedTools'].split('|')
  const enVariants = V.dictionaries.en['cl.pruneUsedTools'].split('|')
  assert.deepEqual(plain(zhVariants), ['该单元无在用工具', '另有 1 个工具在用', '另有 {n} 个工具在用'])
  assert.deepEqual(plain(enVariants), ['no tool of this unit is in use', '1 other tool of this unit is in use', '{n} other tools of this unit are in use'])
})

test('F4. 固定不确定性声明（§4.7 第 3 条）：常驻段底、不折叠、不做 tooltip、无交互', () => {
  const report = canonicalReport()
  const { nodes } = renderPanel(report)
  const pruneBlock = blockOf(nodes, 'prune-plan')
  const caveats = nodesOf(pruneBlock).filter((node) => node.props?.['data-cl-prune-caveat'] !== undefined)
  assert.equal(caveats.length, 1, '声明必须恰好一处且可见')

  const caveat = caveats[0]
  const caveatText = textOf(caveat)
  assert.equal(caveatText, V.dictionaries.zh['cl.prunePlanCaveat'])
  /* §4.7 第 3 条的文字必须逐字在此（去掉设计稿里的 markdown 强调符后仍逐字一致） */
  assert.ok(caveatText.includes('这些候选只说明模型没有调用过，不代表没用'))
  assert.ok(caveatText.includes('请确认你也没有使用其功能后再移除'))
  assert.equal(V.dictionaries.zh['cl.prunePlanCaveat'].includes('**'), false, '面板不是 markdown，不得渲染强调符')

  // 不可折叠 / 不做 tooltip / 无交互
  assert.equal(caveat.props.title, undefined, '声明不得只放进 tooltip')
  assert.equal(caveat.props.onClick, undefined, '声明不得可点击隐藏')
  assert.equal(caveat.props.hidden, undefined)
  assert.equal(caveat.props['aria-expanded'], undefined)
  assert.equal(caveat.props.role, undefined)

  // 位置：段的最后一个子节点（"常驻段底"）
  const children = pruneBlock.props.children
  assert.equal(children[children.length - 1], caveat, '声明必须是该段最后一个可见元素')
  // 且不在展开区里（展开区只在点开时出现）
  const detail = nodesOf(pruneBlock).find((node) => node.props?.['data-cl-prune-detail'] !== undefined)
  assert.equal(detail, undefined)

  // 清单为空时声明仍在（常驻，而不是只在有候选时出现）
  const emptyReport = canonicalReport()
  emptyReport.findings.prunePlan = []
  const empty = renderPanel(emptyReport)
  const emptyCaveat = nodesOf(blockOf(empty.nodes, 'prune-plan'))
    .filter((node) => node.props?.['data-cl-prune-caveat'] !== undefined)
  assert.equal(emptyCaveat.length, 1, '候选为空时声明也必须常驻')
  assert.equal(textOf(emptyCaveat[0]), V.dictionaries.zh['cl.prunePlanCaveat'])
  assert.ok(textOf(blockOf(empty.nodes, 'prune-plan')).includes(ZH('cl.empty')))

  // 降级态（无证据 ⇒ 无候选）同样常驻声明（§4.4 的空态 + §4.7 第 3 条的常驻）
  const degraded = renderPanel(degradedReport())
  assert.equal(nodesOf(blockOf(degraded.nodes, 'prune-plan'))
    .filter((node) => node.props?.['data-cl-prune-caveat'] !== undefined).length, 1)
})

test('F5. 低置信（§4.7 第 4/7 条）：单元行带推断标记；展开给证据路径与「推断，可能存在误判」', () => {
  /* ── 第一部分：裁剪候选的低置信标记 ── */
  const pruneProps = { id: 'p', t: ZH, report: lowConfidencePruneReport(), state: 'ready', refreshedAt: 0, onRefresh() {} }
  mini.reset()
  let tree = mini.render(V.LedgerPanel, pruneProps)
  let row = pruneRowsOf(nodesOf(tree))[0]

  assert.equal(row.props['data-cl-prune-confidence'], 'low')
  const lowMark = fieldOf(row, 'data-cl-prune-low')
  assert.ok(lowMark !== undefined, '低置信单元行必须带「推断」标记')
  assert.equal(textOf(lowMark), '推断，可能存在误判')

  const toggle = row.props.children[0]
  assert.equal(toggle.props['aria-expanded'], false)
  toggle.props.onClick()
  tree = mini.render(V.LedgerPanel, pruneProps)
  row = pruneRowsOf(nodesOf(tree))[0]
  const detail = fieldOf(row, 'data-cl-prune-detail')
  assert.ok(detail !== undefined, '展开后必须给出完整清单（§4.7 第 2 条）')
  const detailText = textOf(detail)
  assert.ok(detailText.includes('fake_low_1') && detailText.includes('fake_low_2'), '完整清单在展开里')
  assert.ok(detailText.includes(ZH('cl.providedBy.evidence', { path: '/tmp/low-conf-ui/lib/index.js' })),
    '展开时必须给出证据路径（只显示路径文本）')
  assert.ok(detailText.includes('推断，可能存在误判'), '低置信明细行必须同时给「推断，可能存在误判」')
  const detailBadges = nodesOf(detail).filter((node) => node.props?.['data-cl-attribution'] !== undefined)
  assert.ok(detailBadges.length >= 2 && detailBadges.every((node) => textOf(node).endsWith(' ?')),
    '低置信归属徽标必须带问号')

  /* ── 第二部分：四类明细里的归属徽标 + 证据路径 ── */
  const props = { id: 'p', t: ZH, report: attributionReport(), state: 'ready', refreshedAt: 0, onRefresh() {} }
  mini.reset()
  let panel = mini.render(V.LedgerPanel, props)
  const openCategory = (name) => {
    nodesOf(panel).find((node) => node.props?.['data-cl-category'] === name)
      .props.children[0].props.onClick()
    panel = mini.render(V.LedgerPanel, props)
  }
  openCategory('tools')
  const tools = nodesOf(panel).find((node) => node.props?.['data-cl-category'] === 'tools')
  const toolsText = textOf(tools)
  const badgeOf = (id) => textOf(nodesOf(nodesOf(panel)
    .find((node) => node.props?.['data-cl-item'] === id))
    .find((node) => node.props?.['data-cl-attribution'] !== undefined))

  assert.equal(badgeOf('tools:aaa_plugin_high'), '插件 @example/high', '高置信插件：只给包名，不带问号')
  assert.equal(badgeOf('tools:bbb_plugin_low'), '插件 @example/low ?', '低置信插件：必须带推断问号')
  assert.equal(badgeOf('tools:ccc_core'), 'DSH 自带', 'core：DSH 自带，不带问号')
  assert.equal(badgeOf('tools:ddd_unknown'), '归属未知 ?', 'unknown：归属未知，绝不是 DSH 自带')

  assert.ok(toolsText.includes(ZH('cl.providedBy.evidence', { path: '/tmp/high/lib/index.js' })), '高置信项也给证据路径')
  assert.ok(toolsText.includes(ZH('cl.providedBy.evidence', { path: '/tmp/low/lib/index.js' })), '低置信项的证据路径可查')
  assert.ok(toolsText.includes(ZH('cl.providedBy.evidence', { path: '/tmp/core/lib/index.js' })), 'core 项的证据路径可查')
  /* 逐行核对：只有 confidence === "low" 的明细行带「推断，可能存在误判」。 */
  const lowCaveatOf = (id) => nodesOf(nodesOf(panel).find((node) => node.props?.['data-cl-item'] === id))
    .filter((node) => node.props?.['data-cl-attribution-note'] === 'low')
  assert.equal(lowCaveatOf('tools:aaa_plugin_high').length, 0, '高置信行不得出现推断警示')
  assert.equal(lowCaveatOf('tools:ccc_core').length, 0, 'core/high 行不得出现推断警示')
  assert.equal(textOf(lowCaveatOf('tools:bbb_plugin_low')[0]), '推断，可能存在误判', '低置信行必须出现')
  assert.equal(textOf(lowCaveatOf('tools:ddd_unknown')[0]), '推断，可能存在误判',
    '归属未知（confidence low）行同样必须出现')
  assert.equal(toolsText.split('推断，可能存在误判').length - 1, 2)
  assert.equal(toolsText.includes('归属（推断）'), false, 'tooltip 文案不得混进可见文本')

  /* §4.7 第 7 条：路径必须是可复制的文本（可选中即可复制），而不是不可选中的装饰 */
  const evidenceNode = nodesOf(panel).find((node) => node.props?.['data-cl-attribution-note'] === 'evidence')
  assert.ok(evidenceNode !== undefined)
  assert.equal(evidenceNode.props.style.userSelect, 'text')

  /* 单一展开位：打开 mcp 会收起 tools（§4.3 的展开语义不变） */
  openCategory('mcp')
  const mcp = nodesOf(panel).find((node) => node.props?.['data-cl-category'] === 'mcp')
  assert.ok(textOf(mcp).includes('MCP: srv'), 'mcp-server 徽标显示 MCP: <server>')
  assert.equal(mcp.props.children[0].props['aria-expanded'], true)
})

test('F6. kind === "unknown" 只进 noRecommendation（§4.7 第 4 条），不得显示成「DSH 自带」', () => {
  const report = canonicalReport()
  const { nodes } = renderPanel(report)
  const pruneText = textOf(blockOf(nodes, 'prune-plan'))
  assert.equal(pruneText.includes('subagent'), false, '归属未知的项不得混进候选清单')

  const noRec = blockOf(nodes, 'no-recommendation')
  assert.ok(noRec !== undefined, '必须有独立的「无法给出动作」分节')
  assert.equal(textOf(fieldOf(noRec, 'data-cl-norec-title')), '无法给出动作')
  assert.equal(V.dictionaries.zh['cl.noRecommendationTitle'], '无法给出动作')
  assert.equal(V.dictionaries.en['cl.noRecommendationTitle'], 'no action available')

  // 三个理由里只有 unknown-attribution 非 0 → 只渲染那一行（§2.16：面板过滤 0 值）
  const noRecRows = nodesOf(noRec).filter((node) => node.props?.['data-cl-norec-row'] !== undefined)
  assert.deepEqual(plain(noRecRows.map((node) => node.props['data-cl-norec-row'])), ['unknown-attribution'])
  assert.equal(textOf(noRecRows[0]), ZH('cl.reason.unknown-attribution', { items: '1', tokens: '402' }))
  assert.equal(textOf(noRec).includes('DSH 自带'), false, 'unknown 项绝不得显示成「DSH 自带」')

  // core 真的非 0 时才出现，且那时「DSH 自带」是正确的标签
  const withCore = canonicalReport()
  withCore.findings.noRecommendation = [
    { reason: 'core', items: 2, tokens: 400 },
    { reason: 'no-owner-bundle', items: 0, tokens: 0 },
    { reason: 'unknown-attribution', items: 1, tokens: 402 },
  ]
  const coreRows = V.noRecommendationRows(withCore, ZH)
  assert.deepEqual(plain(coreRows.map((row) => row.reason)), ['core', 'unknown-attribution'])
  assert.equal(coreRows[0].text, ZH('cl.reason.core', { items: '2', tokens: '400' }))
  assert.ok(coreRows[0].text.includes('DSH 自带'))

  // 明细行里该 unknown 项的归属徽标必须是「归属未知 ?」，不是 DSH 自带
  const live = { id: 'p', t: ZH, report: canonicalReport(), state: 'ready', refreshedAt: 0, onRefresh() {} }
  mini.reset()
  let tree = mini.render(V.LedgerPanel, live)
  nodesOf(tree).find((node) => node.props?.['data-cl-category'] === 'tools').props.children[0].props.onClick()
  tree = mini.render(V.LedgerPanel, live)
  const subagent = nodesOf(tree).find((node) => node.props?.['data-cl-item'] === 'tools:subagent')
  assert.ok(subagent !== undefined)
  const badge = nodesOf(subagent).find((node) => node.props?.['data-cl-attribution'] !== undefined)
  assert.equal(textOf(badge), '归属未知 ?')
  assert.equal(textOf(badge).includes('DSH'), false)
})

test('F7. 顺序不二次加工（§4.7 第 5 条 / §4.3）：恒为 reclaimableTokens 降序，不按可信度重排或过滤', () => {
  // 故意构造「低置信在前、且 reclaimableTokens 更大」的输入：
  // 若面板按可信度重排，high 会跑到前面；若面板过滤 low，行数会少一条。
  const report = canonicalReport()
  report.findings.prunePlan = [
    { kind: 'plugin', target: 'zzz-low-first', factPackages: [], items: [{ id: 'tools:x1', category: 'tools', name: 'x1', tokens: 800 }], itemCount: 1, reclaimableTokens: 800, usedToolCount: 0, confidence: 'low' },
    { kind: 'plugin', target: 'aaa-high-second', factPackages: [], items: [{ id: 'tools:x2', category: 'tools', name: 'x2', tokens: 600 }], itemCount: 1, reclaimableTokens: 600, usedToolCount: 0, confidence: 'high' },
  ]
  const { nodes } = renderPanel(report)
  const order = pruneRowsOf(nodes).map((node) => node.props['data-cl-prune-row'])
  assert.deepEqual(plain(order), ['zzz-low-first', 'aaa-high-second'], '必须逐条保持宿主顺序，不按可信度重排')
  assert.equal(order.length, 2, 'low 条目照常出现，不得过滤')

  // 纯映射也保持输入顺序（不重排）
  assert.deepEqual(plain(V.pruneEntries(report).map((entry) => entry.target)),
    ['zzz-low-first', 'aaa-high-second'])
  // §4.5/§4.3：不得出现"按可信度排序"这类二次加工的实现痕迹
  assert.equal(/sort\([^)]*confidence|confidence[^)]*\.sort\(/.test(CLIENT_SRC), false)
})

test('F8. providerScan.capped（§4.7 第 6 条）：触达上限时页脚提示，未触达时不提示', () => {
  const healthy = renderPanel(canonicalReport())
  assert.equal(healthy.nodes.filter((node) => node.props?.['data-cl-provider-scan-capped'] !== undefined).length, 0,
    'capped=false 不得出现覆盖上限提示')

  const capped = canonicalReport()
  capped.scope.providerScan = { ...capped.scope.providerScan, capped: true }
  const cappedView = renderPanel(capped)
  const marks = cappedView.nodes.filter((node) => node.props?.['data-cl-provider-scan-capped'] !== undefined)
  assert.equal(marks.length, 1)
  assert.equal(textOf(marks[0]), ZH('cl.providerScanCapped'))
  assert.equal(V.dictionaries.zh['cl.providerScanCapped'], '本次归属扫描触达上限，覆盖可能更窄')
  assert.equal(V.providerScanCapped(capped), true)
  assert.equal(V.providerScanCapped(canonicalReport()), false)
  assert.equal(V.providerScanCapped(degradedReport()), true, '§2.12 的降级态示例 capped 为 true')
})

test('F9. 归属徽标（§4.2.4 / §4.4）：四态取值 + 不确定时带问号 + 隐私声明写明推断性质', () => {
  assert.equal(V.attributionText(pluginBy('@a/b', '/tmp/a'), ZH), '插件 @a/b')
  assert.equal(V.attributionText(pluginBy('@a/b', '/tmp/a', 'low'), ZH), '插件 @a/b ?')
  assert.equal(V.attributionText(coreBy('/tmp/c'), ZH), 'DSH 自带')
  assert.equal(V.attributionText(coreBy('/tmp/c', 'low'), ZH), 'DSH 自带 ?')
  assert.equal(V.attributionText(mcpServer('openviking'), ZH), 'MCP: openviking')
  assert.equal(V.attributionText(unknownBy(['@a/b']), ZH), '归属未知 ?')
  assert.equal(V.attributionText(null, ZH), null, 'instructions/skills 没有归属徽标')
  assert.equal(V.attributionText(pluginBy('@a/b', '/tmp/a'), T), 'plugin @a/b')

  // §4.2 第 5 段：隐私声明必须写明「归属为安装侧静态推断，非运行时可证」
  const privacy = V.dictionaries.zh['cl.privacyNote']
  assert.ok(privacy.includes('不含正文'))
  assert.ok(privacy.includes('归属为安装侧静态推断，非运行时可证'))
  const { text } = renderPanel(canonicalReport())
  assert.ok(text.includes(privacy))

  // 插件包名 / MCP: server / DSH 自带 / 归属未知 四种徽标都能上屏
  const mcpView = renderPanel(canonicalReport())
  const mcpHead = nodesOf(blockOf(mcpView.nodes, 'categories'))
    .find((node) => node.props?.['data-cl-category'] === 'mcp')
  assert.ok(mcpHead !== undefined)
})

test('F10. hook 纪律（静态守卫）：面板必须作为组件挂载，钩子只声明在 LedgerPanel', () => {
  assert.ok(CLIENT_SRC.includes('h(LedgerPanel, {'), '面板必须以组件方式挂载（h(LedgerPanel, …)）')
  assert.equal(/[^h]LedgerPanel\(\{/.test(CLIENT_SRC), false, '不得直接调用 LedgerPanel({…}) 把钩子挂到父组件上')

  const pruneBlock = CLIENT_SRC.slice(CLIENT_SRC.indexOf('function PruneBlock'), CLIENT_SRC.indexOf('function NoRecommendationBlock'))
  const noRecBlock = CLIENT_SRC.slice(CLIENT_SRC.indexOf('function NoRecommendationBlock'), CLIENT_SRC.indexOf('function LedgerPanel'))
  for (const [name, body] of [['PruneBlock', pruneBlock], ['NoRecommendationBlock', noRecBlock]]) {
    assert.equal(/use(State|Ref|Memo|Effect|Callback|Id)\(/.test(body), false,
      `${name} 必须是无 hook 的纯渲染函数（否则条件渲染会破坏 hook 顺序）`)
  }

  const panel = CLIENT_SRC.slice(CLIENT_SRC.indexOf('function LedgerPanel'), CLIENT_SRC.indexOf('class PanelBoundary'))
  const ring = CLIENT_SRC.slice(CLIENT_SRC.indexOf('function LedgerRing'), CLIENT_SRC.indexOf('function apply'))
  assert.ok(/useState\(null\)/.test(panel), 'LedgerPanel 无条件声明展开状态')
  assert.equal(/use(State|Memo|Effect|Callback|Ref|Id)\(/.test(
    ring.slice(ring.indexOf('return h('))), false, 'LedgerRing 的条件渲染分支里不得再有 hook')
})

test('F12. 缺字段的旧形状报告不炸（防御：面板坏掉不许拖垮宿主 shell）', () => {
  const legacy = canonicalReport()
  delete legacy.scope.providerScan
  delete legacy.findings.prunePlan
  delete legacy.findings.prunePlanReclaimableTokens
  delete legacy.findings.prunePlanBasis
  delete legacy.findings.noRecommendation
  legacy.items = legacy.items.map(({ providedBy, ...rest }) => rest)
  mini.reset()
  const tree = mini.render(V.LedgerPanel, { id: 'p', t: ZH, report: legacy, state: 'ready', refreshedAt: 0, onRefresh() {} })
  const nodes = nodesOf(tree)
  const text = textOf(tree)
  assert.ok(nodes.filter((node) => node.props?.['data-cl-panel'] !== undefined).length === 1)
  assert.ok(text.includes(ZH('cl.empty')), '没有候选数据时显示空态')
  assert.ok(text.includes(ZH('cl.prunePlanCaveat')), '声明仍然常驻（不因缺数据而消失）')
  assert.equal(nodes.filter((node) => node.props?.['data-cl-provider-scan-capped'] !== undefined).length, 0)
  assert.equal(nodes.filter((node) => node.props?.['data-cl-attribution'] !== undefined).length, 0,
    '没有 providedBy 时不渲染归属徽标')
  assert.equal(V.pruneEntries(legacy).length, 0)
  assert.deepEqual(plain(V.noRecommendationRows(legacy, ZH)), [])
  assert.equal(V.providerScanCapped(legacy), false)
})

test('F11. 面板文案实况（人读用）：R1 段落逐行打印，便于核验措辞而不必启动 web shell', () => {
  const report = canonicalReport()
  const { nodes } = renderPanel(report)
  const lines = []
  const push = (label, node) => lines.push(`${label}: ${textOf(node).replace(/\s+/g, ' ').trim()}`)

  push('[段标题]', fieldOf(blockOf(nodes, 'prune-plan'), 'data-cl-prune-title'))
  push('[段提示]', blockOf(nodes, 'prune-plan').props.children[0].props.children[1])
  for (const row of pruneRowsOf(nodes)) {
    const target = row.props['data-cl-prune-row']
    push(`[候选 ${target} · 单元]`, fieldOf(row, 'data-cl-prune-unit'))
    push(`[候选 ${target} · 工具]`, fieldOf(row, 'data-cl-prune-tools'))
    push(`[候选 ${target} · 可省]`, fieldOf(row, 'data-cl-prune-reclaim'))
    push(`[候选 ${target} · 在用]`, fieldOf(row, 'data-cl-prune-used'))
    push(`[候选 ${target} · 事实包]`, fieldOf(row, 'data-cl-prune-facts'))
    if (fieldOf(row, 'data-cl-prune-low') !== undefined) push(`[候选 ${target} · 低置信]`, fieldOf(row, 'data-cl-prune-low'))
  }
  push('[段底声明]', fieldOf(blockOf(nodes, 'prune-plan'), 'data-cl-prune-caveat'))
  push('[无法给出动作·标题]', fieldOf(blockOf(nodes, 'no-recommendation'), 'data-cl-norec-title'))
  for (const row of nodesOf(blockOf(nodes, 'no-recommendation'))
    .filter((node) => node.props?.['data-cl-norec-row'] !== undefined)) {
    push(`[无法给出动作 ${row.props['data-cl-norec-row']}]`, row)
  }
  const footer = nodes.find((node) => node.props?.key === 'foot')
  push('[页脚·隐私]', footer.props.children[footer.props.children.length - 1])

  console.log(lines.join('\n'))
  assert.ok(lines.length >= 10)
})


/* ══════════════════════════════════════════════════════════════════════════
 * G 组：R3/R6 —— DESIGN v3 §4.8 的呈现义务（逐条可核）
 * ══════════════════════════════════════════════════════════════════════════ */

/** 取 hide 段的节点。 */
function hideBlockOf(nodes) {
  return blockOf(nodes, 'hide-plan')
}

/** 取 hide 段里的候选行。 */
function hideRowsOf(nodes) {
  return nodesOf(hideBlockOf(nodes)).filter((node) => node.props?.['data-cl-hide-row'] !== undefined)
}

/** 取某行内的字段节点。 */
function hideRowField(row, attribute) {
  return nodesOf(row).find((node) => node.props?.[attribute] !== undefined)
}

/** §6 第 11 条 + §4.8 第 1 条的措辞红线（多词、无歧义的确定性/贬损表述）。 */
const HIDE_FORBIDDEN = [
  '建议隐藏', '安全隐藏', '安全移除', '零损失', '零功能损失', '无副作用', '放心删', '只影响模型',
  'suggest hiding', 'recommend hiding', 'safe to hide', 'safe to remove', 'safe to delete',
  'zero loss', 'zero cost', 'no side effects', 'removable', 'worthless',
]
/** 命令式组合（"建议/可以 + 隐藏/移除/卸载/删除"）：契约自带的否定式文案不会命中。 */
const HIDE_IMPERATIVE = /(建议|推荐|应该|应当|可以)(隐藏|移除|卸载|删除)|(suggest|recommend|should|feel free to)\s+[a-z]*(hid|remov|delet|uninstall)/i

test('G1. §4.8 第 1 条：段标题逐字契约、候选语气、无确定性动词、无危险色', () => {
  assert.equal(V.dictionaries.zh['cl.hidePlanTitle'], '可隐藏候选（工具级）· 需人工确认')
  assert.equal(V.dictionaries.en['cl.hidePlanTitle'], 'Hide candidates (tool level) · needs your call')

  const { nodes, text } = renderPanel(r6Report())
  const title = fieldOf(hideBlockOf(nodes), 'data-cl-hide-title')
  assert.equal(textOf(title), '可隐藏候选（工具级）· 需人工确认')
  assert.ok(textOf(title).includes('候选') && textOf(title).includes('需人工确认'))

  // 措辞红线：v3 全部键 + 整屏文本（两种语言都扫）
  for (const [lang, dict] of Object.entries(V.dictionaries)) {
    for (const key of V3_KEYS) {
      for (const bad of HIDE_FORBIDDEN) {
        assert.equal(dict[key].includes(bad), false, `v3 键 ${lang}/${key} 不得含「${bad}」`)
      }
      assert.equal(HIDE_IMPERATIVE.test(dict[key]), false, `v3 键 ${lang}/${key} 不得是命令句：${dict[key]}`)
    }
  }
  for (const bad of HIDE_FORBIDDEN) assert.equal(text.includes(bad), false, `面板不得出现「${bad}」`)

  // 不得用危险色暗示危害（§4.8 第 1 条 / §6 第 11 条）
  for (const row of hideRowsOf(nodes)) {
    assert.equal(/state-error-primary/.test(JSON.stringify(row.props.style)), false)
  }
  const bannerStyles = nodesOf(hideBlockOf(nodes))
    .filter((node) => node.props?.['data-cl-hide-banner'] !== undefined || node.props?.['data-cl-hide-no-sum'] !== undefined)
    .map((node) => JSON.stringify(node.props.style)).join(' ')
  assert.equal(/state-error-primary/.test(bannerStyles), false, '提示条与并列说明不得用危险红')
})

test('G2. §4.8 第 2 条：每行五件事实（name / unit / tokens / registryUse 人话 / 预校验状态）', () => {
  const report = r6Report()
  const { nodes } = renderPanel(report)
  const rows = hideRowsOf(nodes)
  assert.equal(rows.length, report.findings.hidePlan.length, '候选数与 findings.hidePlan 一致（不筛选）')

  for (const row of rows) {
    for (const attribute of ['data-cl-hide-name', 'data-cl-hide-unit', 'data-cl-hide-tokens',
      'data-cl-hide-verdict', 'data-cl-hide-precheck-text']) {
      const field = hideRowField(row, attribute)
      assert.ok(field !== undefined, `${row.props['data-cl-hide-row']} 缺字段 ${attribute}`)
      assert.ok(textOf(field).trim() !== '', `${attribute} 不得为空`)
    }
  }

  // 逐字核对三种 unit 形态 + 判定解释
  const byName = (name) => rows.find((row) => row.props['data-cl-hide-row'] === name)
  const mcpRow = byName('mcp__openviking__add_resource')
  assert.equal(textOf(hideRowField(mcpRow, 'data-cl-hide-name')), 'mcp__openviking__add_resource')
  assert.equal(textOf(hideRowField(mcpRow, 'data-cl-hide-tokens')), '891 token')
  assert.equal(textOf(hideRowField(mcpRow, 'data-cl-hide-unit')), 'MCP 服务器 · openviking · 事实包：—')
  assert.equal(textOf(hideRowField(mcpRow, 'data-cl-hide-verdict')),
    '该功能是否经注册表被调用：未确认 · DSH 无法观测非模型的注册表调用')
  assert.equal(textOf(hideRowField(mcpRow, 'data-cl-hide-precheck-text')), '预校验：已校验')

  assert.equal(textOf(hideRowField(byName('read_mcp_resource'), 'data-cl-hide-unit')), 'DSH 自带 · 事实包：—')
  assert.equal(textOf(hideRowField(byName('annotation'), 'data-cl-hide-unit')),
    '插件包 · dsh-annotate · 事实包：dsh-annotate')
  assert.equal(textOf(hideRowField(byName('subagent'), 'data-cl-hide-unit')), '归属未知 · 事实包：—')

  // 原始枚举值不得泄漏到 UI（都是不可读的机器常量）
  const hideText = textOf(hideBlockOf(nodes))
  for (const raw of ['unobservable', 'one-time-invalidation', 'no-non-model-observability', 'suggestion-only']) {
    assert.equal(hideText.includes(raw), false, `不得把原始枚举「${raw}」直接印给用户`)
  }
})

test('G3. §4.8 第 3 条：hidePlanCaveat 五条与 JSON 字段一一对应、常驻段底、不可折叠', () => {
  const report = r6Report()
  const caveatKeys = Object.keys(report.findings.hidePlanCaveat)
  assert.deepEqual(plain(caveatKeys).sort(), [...V.HIDE_CAVEAT_KEYS].sort(),
    'JSON 的五个字段与实现的键集一一对应（§2.19 表）')

  const { nodes } = renderPanel(report)
  const hideBlock = hideBlockOf(nodes)
  const rendered = nodesOf(hideBlock).filter((node) => node.props?.['data-cl-hide-caveat'] !== undefined)
  assert.equal(rendered.length, 5, '五条必须全部出现')
  for (const key of caveatKeys) {
    const node = rendered.find((item) => item.props['data-cl-hide-caveat'] === key)
    assert.ok(node !== undefined, `缺 caveat ${key}`)
    assert.equal(textOf(node), V.dictionaries.zh['cl.hide.caveat.' + key])
    for (const lang of ['zh', 'en']) {
      assert.equal(typeof V.dictionaries[lang]['cl.hide.caveat.' + key], 'string', `${lang} 缺 caveat ${key}`)
    }
    // 常驻：不可折叠、不做 tooltip、无交互
    assert.equal(node.props.title, undefined)
    assert.equal(node.props.onClick, undefined)
    assert.equal(node.props.hidden, undefined)
  }
  // 段底：caveat 容器是该段最后一个子节点
  const children = hideBlock.props.children
  assert.equal(children[children.length - 1], nodesOf(hideBlock).find((node) => node.props?.['data-cl-hide-caveats'] !== undefined),
    '五条必须常驻该段底部')

  // 五条各自的关键内容（契约事实，不是空壳）
  const caveatText = (key) => V.dictionaries.zh['cl.hide.caveat.' + key]
  assert.ok(caveatText('registryHideIsTotal').includes('注册表') && caveatText('registryHideIsTotal').includes('不可解析'))
  assert.ok(caveatText('registryHideIsTotal').includes('不是只从 schema 里抹掉'))
  assert.ok(caveatText('nonModelRegistryCalls').includes('非模型') && caveatText('nonModelRegistryCalls').includes('没有观测面'))
  assert.ok(caveatText('serviceCoupling').includes('人工确认'))
  assert.ok(caveatText('confirmationRequired').includes('必须人工确认'))
  assert.ok(caveatText('prefixCacheCost').includes('prompt cache') && caveatText('prefixCacheCost').includes('一次性'))

  // 空候选 / 旧形状 / 降级态：五条照旧常驻
  for (const [label, fixture] of [['无 hidePlan 的旧形状', r6Absent()], ['降级态', degradedReport()]]) {
    const view = renderPanel(fixture)
    const nodesHere = nodesOf(hideBlockOf(view.nodes)).filter((node) => node.props?.['data-cl-hide-caveat'] !== undefined)
    assert.equal(nodesHere.length, 5, `${label} 下五条也必须常驻`)
  }
})

test('G4. §4.8 第 4 条 + §3.7：与 prunePlan 并列呈现，两个动作的 token 绝不相加', () => {
  const report = r6Report()
  const { nodes, text } = renderPanel(report)
  const parallel = blockOf(nodes, 'plan-parallel')
  assert.ok(parallel !== undefined, '必须有并列段（§2.22）')

  const rows = nodesOf(parallel).filter((node) => node.props?.['data-cl-parallel-row'] !== undefined)
  assert.equal(rows.length, report.findings.hidePlanUnits.length, '每个单元一行（7 个单元）')

  // 每行：隐藏口径 + （可卸载时）卸载口径；不可卸载时明确写"无法通过卸载移除"
  const byKey = (key) => rows.find((row) => row.props['data-cl-parallel-row'] === key)
  const openviking = byKey('mcp-server:openviking')
  assert.equal(textOf(fieldOf(openviking, 'data-cl-parallel-unit')), 'MCP 服务器 · openviking · 8')
  assert.equal(textOf(fieldOf(openviking, 'data-cl-parallel-hide')),
    '隐藏这 8 个工具可省 1,674 token（代价：这些名字注册表级不可用；须人工确认）')
  assert.equal(textOf(fieldOf(openviking, 'data-cl-parallel-prune')),
    '卸载该单元可省 1,674 token（代价：失去 8 个在用工具，以及该单元的 UI/后台功能）')

  for (const key of ['core:', 'unknown:']) {
    const row = byKey(key)
    assert.ok(row !== undefined, `缺单元 ${key}`)
    assert.equal(fieldOf(row, 'data-cl-parallel-prune'), undefined, 'inPrunePlan=false 只显示隐藏一行')
    assert.equal(textOf(fieldOf(row, 'data-cl-parallel-no-uninstall')), '无法通过卸载移除')
  }

  // 硬规则：两笔 token 不得相加（示例里 4261 + 3376 = 7637，任何形式都不得出现）
  assert.equal(text.includes('7,637'), false, '不得出现两笔之和')
  assert.equal(text.includes('7637'), false, '不得出现两笔之和（无分隔符形式）')
  assert.equal(/总可省|合计可省|total reclaimable|combined savings/i.test(text), false)
  // 结构证明：面板根本不读两个"总计"字段（只逐条呈现），因此不可能求和
  assert.equal(/hidePlanTokens/.test(CLIENT_SRC), false, '面板不得读取 hidePlanTokens 这个总计字段')
  assert.equal(/prunePlanReclaimableTokens/.test(CLIENT_SRC), false, '面板不得读取 prunePlanReclaimableTokens')
  // 并列表述必须显式写明"不得相加"
  assert.ok(textOf(fieldOf(parallel, 'data-cl-hide-no-sum')).includes('不得相加'))
  assert.equal(V.dictionaries.en['cl.hide.noSum'].includes('never add'), true)
})

test('G5. §4.8 第 5 条：未校验/不支持 ⇒ 提示条且不给复制按钮；已校验才给', () => {
  const prechecked = renderPanel(r6Report())
  assert.equal(nodesOf(hideBlockOf(prechecked.nodes)).filter((node) => node.props?.['data-cl-hide-banner'] !== undefined).length, 0,
    '已校验时不得出现未校验提示条')
  const copyButtons = nodesOf(hideBlockOf(prechecked.nodes)).filter((node) => node.props?.['data-cl-hide-copy'] !== undefined)
  assert.equal(copyButtons.length, 1, '已校验且有 denyList 时必须给复制按钮')
  assert.equal(textOf(copyButtons[0]), '复制清单')
  const denyList = fieldOf(hideBlockOf(prechecked.nodes), 'data-cl-hide-deny-list')
  assert.equal(textOf(denyList).split(', ').length, 24, '可粘贴清单列出全部 24 个名字')
  assert.equal(textOf(denyList), R6_EXAMPLE.findings.hideApply.denyList.join(', '))
  assert.equal(denyList.props.style.userSelect, 'text', '清单必须可选中复制')

  for (const [label, fixture, status] of [['未校验', r6Unvalidated(), 'unvalidated'], ['不支持', r6Unsupported(), 'unsupported']]) {
    const view = renderPanel(fixture)
    const banner = nodesOf(hideBlockOf(view.nodes)).filter((node) => node.props?.['data-cl-hide-banner'] !== undefined)
    assert.equal(banner.length, 1, `${label} 必须有提示条`)
    assert.equal(banner[0].props['data-cl-hide-banner'], status)
    assert.equal(textOf(banner[0]), '未校验，不要直接照抄清单')
    assert.equal(nodesOf(hideBlockOf(view.nodes)).filter((node) => node.props?.['data-cl-hide-copy'] !== undefined).length, 0,
      `${label} 时不得显示复制按钮`)
    assert.equal(textOf(hideBlockOf(view.nodes)).includes('undefined'), false)
    // 候选仍然照列（诊断有效，§2.23.3）
    assert.equal(hideRowsOf(view.nodes).length, 24)
  }

  // 旧形状（无 hidePlanStatus）：保守按"未校验"处理
  const absent = renderPanel(r6Absent())
  assert.equal(nodesOf(hideBlockOf(absent.nodes)).filter((node) => node.props?.['data-cl-hide-banner'] !== undefined).length, 1)
  assert.equal(nodesOf(hideBlockOf(absent.nodes)).filter((node) => node.props?.['data-cl-hide-copy'] !== undefined).length, 0)
})

test('G6. §4.8 第 6 条：selfTool 候选必须说明"隐藏后模型将无法再调用本账本"', () => {
  const { nodes } = renderPanel(r6SelfTool())
  const rows = hideRowsOf(nodes)
  const selfRows = rows.filter((row) => row.props['data-cl-hide-self'] === 'true')
  assert.equal(selfRows.length, 1, '只有 context_ledger 自己该被标记')
  assert.equal(selfRows[0].props['data-cl-hide-row'], 'context_ledger')
  assert.equal(textOf(fieldOf(selfRows[0], 'data-cl-hide-self-note')), '隐藏后模型将无法再调用本账本')
  for (const row of rows.filter((item) => item !== selfRows[0])) {
    assert.equal(fieldOf(row, 'data-cl-hide-self-note'), undefined, '非 selfTool 行不得出现该提示')
  }
})

test('G7. §2.24 恢复路径可查：改回配置、不追溯、没有撤销命令、本插件不写配置', () => {
  const restore = renderPanel(r6Report())
  const block = blockOf(restore.nodes, 'hide-restore')
  assert.ok(block !== undefined)
  assert.equal(textOf(fieldOf(block, 'data-cl-hide-restore-title')), '如何恢复（隐藏来自配置；本插件不提供撤销命令）')
  const lines = nodesOf(block).filter((node) => node.props?.['data-cl-hide-restore-line'] !== undefined)
  assert.deepEqual(plain(lines.map((node) => node.props['data-cl-hide-restore-line'])),
    ['step1', 'step2', 'step3', 'subagent', 'no-undo', 'readonly'])
  const restoreText = textOf(block)
  assert.ok(restoreText.includes('hide.apply'), '必须说清改哪个配置')
  assert.ok(restoreText.includes('deny'), '必须说清只想恢复个别工具时怎么做')
  assert.ok(restoreText.includes('HMR'), '必须说清生效时机')
  assert.ok(restoreText.includes('不追溯'), '必须如实说明不追溯（§2.24.1 边界）')
  assert.ok(restoreText.includes('没有“撤销上一条隐藏”的命令'), '必须如实说明不存在撤销命令（§2.24.3）')
  assert.ok(restoreText.includes('不生成、不修改、不备份你的配置文件'), '必须说清本插件只输出片段')
  assert.ok(restoreText.includes('toolFilter'), '必须给出子代理载体的恢复方式')

  // 恢复信息是常驻的：无候选 / 降级态下同样可查
  for (const fixture of [r6Absent(), degradedReport()]) {
    const view = renderPanel(fixture)
    assert.ok(textOf(blockOf(view.nodes, 'hide-restore')).includes('没有“撤销上一条隐藏”的命令'))
  }
})

test('G8. §2.19 registryUse 如实呈现：判定 + 不可观测 + 证据，绝不写成事实', () => {
  const report = r6Report()
  const { nodes, text } = renderPanel(report)
  const rows = hideRowsOf(nodes)

  // 每一行都给 verdictBasis（"DSH 无法观测非模型的注册表调用"）——§2.19 硬规则 2
  for (const row of rows) {
    const verdict = textOf(hideRowField(row, 'data-cl-hide-verdict'))
    assert.ok(verdict.includes('DSH 无法观测非模型的注册表调用'), `行 ${row.props['data-cl-hide-row']} 缺 verdictBasis`)
    assert.ok(verdict.includes('未确认'), '候选恒为 unconfirmed')
  }
  // 确认要求（confirmationRequired）与不可观测（nonModelRegistryCalls）都在常驻声明里
  const hideText = textOf(hideBlockOf(nodes))
  assert.ok(hideText.includes('施加前必须人工确认'))
  assert.ok(hideText.includes('非模型的注册表调用没有观测面'))

  // 不得出现比 verdict 更强的结论值（§2.19 硬规则 1）
  for (const forbidden of ['safe', 'unused', 'no-loss', 'lossless']) {
    assert.equal(V.verdictLabel(forbidden, ZH).includes(forbidden), false, `不得把 ${forbidden} 当 verdict`)
  }
  assert.equal(V.verdictLabel('safe', ZH), ZH('cl.hide.verdict.unconfirmed'), '未知 verdict 必须保守回落到未确认')
  assert.equal(V.verdictLabel('model-observed', ZH), ZH('cl.hide.verdict.modelObserved'))

  // §2.19 硬规则 3：nameReferencedElsewhere 非空 → 带"别处引用过该名字（需人工确认）"标记 + 路径
  const subagent = rows.find((row) => row.props['data-cl-hide-row'] === 'subagent')
  const marker = fieldOf(subagent, 'data-cl-hide-referenced')
  assert.ok(marker !== undefined, 'subagent 有 nameReferencedElsewhere ⇒ 必须有标记')
  assert.ok(textOf(marker).includes('别处引用过该名字（需人工确认）'))
  assert.ok(textOf(marker).includes('/home/u/.dsh/profiles/web/node_modules/@linxin666/dsh-session-archive/lib/index.js'))
  assert.equal(/被调用过|was called|used by/i.test(textOf(marker)), false, '启发式证据不得改写成"被调用"')
  for (const row of rows.filter((item) => item !== subagent)) {
    assert.equal(fieldOf(row, 'data-cl-hide-referenced'), undefined, '无证据的行不得带该标记')
  }
  // 弱命中的原始列表来自宿主（只读呈现，面板不改写、不截断成单一结论）
  assert.equal(V.referencedPaths(subagent.registryUse ?? report.findings.hidePlan.find((e) => e.name === 'subagent').registryUse).length, 2)
})

test('G9. §2.23.4 措辞：建议 ≠ 已施加（suggestion-only 与 applied-by-config 如实区分）', () => {
  const suggested = renderPanel(r6Report())
  const suggestedLine = textOf(fieldOf(hideBlockOf(suggested.nodes), 'data-cl-hide-apply-mode'))
  assert.equal(suggestedLine, '施加方式：仅建议：本插件不会自动施加（appliedNames 为空）')
  assert.ok(suggestedLine.includes('不会自动施加'))

  const applied = renderPanel(r6AppliedByConfig())
  const appliedLine = textOf(fieldOf(hideBlockOf(applied.nodes), 'data-cl-hide-apply-mode'))
  assert.ok(appliedLine.includes('按你自己的配置施加'), '必须说清来自用户配置')
  assert.ok(appliedLine.includes('不是本插件自动决定'))
  assert.ok(appliedLine.includes('已施加 3 个名字'))
  assert.ok(appliedLine.includes('1 个名字未施加'), 'skipped 必须如实呈现')

  // 未知 mode 保守回落为"仅建议"，绝不宣称已施加
  const weird = r6Report()
  weird.findings.hideApply = { ...weird.findings.hideApply, mode: 'garbage' }
  const weirdLine = textOf(fieldOf(hideBlockOf(renderPanel(weird).nodes), 'data-cl-hide-apply-mode'))
  assert.ok(weirdLine.includes('仅建议'))
  assert.equal(weirdLine.includes('已施加'), false)
  assert.deepEqual(plain(V.HIDE_APPLY_MODES), ['suggestion-only', 'applied-by-config'])
})

test('G10. 叠加不破既有契约：五段版面顺序、并列段位置、旧形状防御、无 undefined 泄漏', () => {
  const report = r6Report()
  const { nodes } = renderPanel(report)
  const blockOrder = nodes.filter((node) => node.props?.['data-cl-block'] !== undefined)
    .map((node) => node.props['data-cl-block'])
  assert.deepEqual(plain(blockOrder),
    ['zero-call', 'top-per-use', 'prune-plan', 'no-recommendation', 'hide-plan', 'hide-restore', 'plan-parallel', 'categories'],
    'R1 三块位置不变；R6 三块追加在 prune 的伴生段之后、四类明细之前')

  // 既有 R1/R2 断言在叠加后仍成立（抽样）
  const text = textOf(nodesOf(nodes.find((node) => node.props?.['data-cl-block'] === 'zero-call'))[0])
  assert.ok(text.includes('0 次'))

  // 旧形状（v2 报告）：R6 三段照常渲染，不抛错、不泄漏 undefined
  const absent = renderPanel(r6Absent())
  assert.ok(absent.text.includes('可隐藏候选（工具级）· 需人工确认'))
  assert.ok(absent.text.includes('未校验，不要直接照抄清单'))
  assert.ok(absent.text.includes('没有“撤销上一条隐藏”的命令'))
  assert.equal(absent.text.includes('undefined'), false)
  assert.equal(absent.text.includes('NaN'), false)
  const absentParallel = blockOf(absent.nodes, 'plan-parallel')
  assert.ok(textOf(absentParallel).includes(ZH('cl.empty')))
  assert.ok(textOf(hideBlockOf(absent.nodes)).includes(ZH('cl.empty')))
})

test('G11. 面板文案实况（人读用）：R6 三段逐行打印，便于核验措辞', () => {
  const report = r6Report()
  const { nodes } = renderPanel(report)
  const lines = []
  const push = (label, node) => lines.push(`${label}: ${textOf(node).replace(/\s+/g, ' ').trim()}`)
  const hideBlock = hideBlockOf(nodes)
  const rows = hideRowsOf(nodes)

  push('[段标题]', fieldOf(hideBlock, 'data-cl-hide-title'))
  push('[段提示]', hideBlock.props.children[0].props.children[1])
  push('[施加方式]', fieldOf(hideBlock, 'data-cl-hide-apply-mode'))
  for (const row of [rows[0], rows.find((item) => item.props['data-cl-hide-row'] === 'subagent')]) {
    const name = row.props['data-cl-hide-row']
    push(`[候选 ${name} · 名字]`, hideRowField(row, 'data-cl-hide-name'))
    push(`[候选 ${name} · 单元]`, hideRowField(row, 'data-cl-hide-unit'))
    push(`[候选 ${name} · token]`, hideRowField(row, 'data-cl-hide-tokens'))
    push(`[候选 ${name} · 判定]`, hideRowField(row, 'data-cl-hide-verdict'))
    push(`[候选 ${name} · 预校验]`, hideRowField(row, 'data-cl-hide-precheck-text'))
    if (hideRowField(row, 'data-cl-hide-referenced') !== undefined) {
      push(`[候选 ${name} · 证据]`, hideRowField(row, 'data-cl-hide-referenced'))
    }
  }
  push('[可粘贴清单]', fieldOf(hideBlock, 'data-cl-hide-deny-label'))
  push('[声明标题]', fieldOf(hideBlock, 'data-cl-hide-caveat-title'))
  for (const caveat of nodesOf(hideBlock).filter((node) => node.props?.['data-cl-hide-caveat'] !== undefined)) {
    push(`[声明 ${caveat.props['data-cl-hide-caveat']}]`, caveat)
  }
  const restore = blockOf(nodes, 'hide-restore')
  push('[恢复标题]', fieldOf(restore, 'data-cl-hide-restore-title'))
  for (const line of nodesOf(restore).filter((node) => node.props?.['data-cl-hide-restore-line'] !== undefined)) {
    push(`[恢复 ${line.props['data-cl-hide-restore-line']}]`, line)
  }
  const parallel = blockOf(nodes, 'plan-parallel')
  push('[并列标题]', fieldOf(parallel, 'data-cl-hide-parallel-title'))
  push('[并列硬规则]', fieldOf(parallel, 'data-cl-hide-no-sum'))
  for (const key of ['mcp-server:openviking', 'unknown:']) {
    const row = nodesOf(parallel).find((node) => node.props?.['data-cl-parallel-row'] === key)
    push(`[并列 ${key} · 单元]`, fieldOf(row, 'data-cl-parallel-unit'))
    push(`[并列 ${key} · 隐藏]`, fieldOf(row, 'data-cl-parallel-hide'))
    const prune = fieldOf(row, 'data-cl-parallel-prune')
    if (prune !== undefined) push(`[并列 ${key} · 卸载]`, prune)
    else push(`[并列 ${key} · 卸载]`, fieldOf(row, 'data-cl-parallel-no-uninstall'))
  }

  console.log(lines.join('\n'))
  assert.ok(lines.length >= 25)
})

test('G12. 复制清单的两种结局都如实反馈（无剪贴板 ⇒ 提示手动复制；有 ⇒ 已复制）', () => {
  const props = { id: 'p', t: ZH, report: r6Report(), state: 'ready', refreshedAt: 0, onRefresh() {} }

  /* ① 浏览器没有剪贴板（本 harness 的 vm 全局里没有 navigator）：不得假装复制成功 */
  mini.reset()
  let tree = mini.render(V.LedgerPanel, props)
  let button = nodesOf(hideBlockOf(nodesOf(tree))).find((node) => node.props?.['data-cl-hide-copy'] !== undefined)
  assert.equal(textOf(button), '复制清单')
  button.props.onClick()
  tree = mini.render(V.LedgerPanel, props)
  const after = hideBlockOf(nodesOf(tree))
  const buttonAfter = nodesOf(after).find((node) => node.props?.['data-cl-hide-copy'] !== undefined)
  assert.equal(textOf(buttonAfter), '复制清单', '没复制成功就不许显示"已复制"')
  const note = nodesOf(after).find((node) => node.props?.['data-cl-hide-copy-note'] !== undefined)
  assert.ok(note !== undefined, '必须提示手动复制')
  assert.equal(textOf(note), '浏览器未提供剪贴板，请手动选中下面的清单复制')

  /* ② 浏览器提供剪贴板：点击后显示"已复制"，且不再显示手动提示 */
  const withClipboard = loadBundle(mini, { navigator: { clipboard: { writeText: async () => {} } } })
  const clipboardV = withClipboard.plugin.__verify
  mini.reset()
  let tree2 = mini.render(clipboardV.LedgerPanel, props)
  let button2 = nodesOf(hideBlockOf(nodesOf(tree2))).find((node) => node.props?.['data-cl-hide-copy'] !== undefined)
  button2.props.onClick()
  tree2 = mini.render(clipboardV.LedgerPanel, props)
  const after2 = hideBlockOf(nodesOf(tree2))
  const buttonAfter2 = nodesOf(after2).find((node) => node.props?.['data-cl-hide-copy'] !== undefined)
  assert.equal(textOf(buttonAfter2), '已复制')
  assert.equal(nodesOf(after2).filter((node) => node.props?.['data-cl-hide-copy-note'] !== undefined).length, 0)
  assert.equal(clipboardV.copyToClipboard('x'), true, '剪贴板可用时返回 true')
  assert.equal(V.copyToClipboard('x'), false, '剪贴板缺席时返回 false（不抛错）')
})
