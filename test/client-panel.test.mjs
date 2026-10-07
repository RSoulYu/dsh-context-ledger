/**
 * 客户端半区核验（无浏览器、无网络、只读宿主文件）。
 *
 * 覆盖：
 *   A. 经典脚本加载 + loader 模块表解析 + cordis 插件面（含 package.json dsh.client 声明）
 *   B. 插槽落座契约（conversation.input.right / id / order / locale）与宿主一手证据（file:line）
 *   C. 词典：命名空间 context-ledger，zh/en 与 DESIGN §4.5 冻结键集完全同键
 *   D. 展示映射：状态三分、`calls === null` 绝不渲染成 0、占比、折叠、总览降级保护
 *   E. 面板渲染（极简 hook 运行时 + 元素树→文本）：canonical / 降级 / 零调用 / 折叠 / 错误边界
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
function loadBundle(miniReact) {
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
const FROZEN_KEYS = [
  'cl.title', 'cl.subtitle', 'cl.hint', 'cl.residentTotal', 'cl.tokens', 'cl.observedCalls',
  'cl.tokensPerCall', 'cl.sessionsCovered', 'cl.window', 'cl.zeroCallTitle', 'cl.zeroCallHint',
  'cl.topPerUseTitle', 'cl.topPerUseHint', 'cl.neverCalled', 'cl.unknown', 'cl.noEvidence',
  'cl.cat.instructions', 'cl.cat.skills', 'cl.cat.tools', 'cl.cat.mcp', 'cl.alwaysOnNote',
  'cl.skillsUnknownNote', 'cl.skillLoads', 'cl.expand', 'cl.collapse', 'cl.more', 'cl.refresh',
  'cl.updated', 'cl.loading', 'cl.error', 'cl.empty', 'cl.privacyNote', 'cl.rejectedWarning',
]

/** canonical 报告（形状取自 DESIGN §2.9，数据为合成值；privacy 边界与面板无关）。 */
function canonicalReport() {
  return {
    tool: 'context_ledger',
    version: 1,
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
      callsUnmatchedNames: ['context_audit'],
      namesRejected: 0,
      usageAvailable: true,
      truncated: false,
    },
    categories: [
      { key: 'instructions', itemCount: 1, tokens: 812, calls: null, tokensPerCall: null, observableUsage: false, mechanismCalls: null, mechanismTokensPerCall: null },
      { key: 'skills', itemCount: 4, tokens: 386, calls: null, tokensPerCall: null, observableUsage: false, mechanismCalls: 9, mechanismTokensPerCall: 43 },
      { key: 'tools', itemCount: 5, tokens: 1341, calls: 129, tokensPerCall: 10, observableUsage: true, mechanismCalls: null, mechanismTokensPerCall: null },
      { key: 'mcp', itemCount: 3, tokens: 1149, calls: 8, tokensPerCall: 144, observableUsage: true, mechanismCalls: null, mechanismTokensPerCall: null },
    ],
    items: [
      { id: 'mcp:mcp__openviking__add_resource', category: 'mcp', name: 'mcp__openviking__add_resource', tokens: 402, calls: 0, tokensPerCall: null, zeroCall: true, usageBasis: 'tool-calls' },
      { id: 'mcp:mcp__openviking__forget', category: 'mcp', name: 'mcp__openviking__forget', tokens: 341, calls: 0, tokensPerCall: null, zeroCall: true, usageBasis: 'tool-calls' },
      { id: 'tools:task_board_list', category: 'tools', name: 'task_board_list', tokens: 292, calls: 0, tokensPerCall: null, zeroCall: true, usageBasis: 'tool-calls' },
      { id: 'tools:context_ledger', category: 'tools', name: 'context_ledger', tokens: 214, calls: 3, tokensPerCall: 71, zeroCall: false, usageBasis: 'tool-calls' },
      { id: 'tools:bash', category: 'tools', name: 'bash', tokens: 381, calls: 118, tokensPerCall: 3, zeroCall: false, usageBasis: 'tool-calls' },
      { id: 'instructions:/home/u/Desktop/DSHWorkspace/AGENTS.md', category: 'instructions', name: '/home/u/Desktop/DSHWorkspace/AGENTS.md', tokens: 812, calls: null, tokensPerCall: null, zeroCall: null, usageBasis: 'always-on', source: 'project', bytes: 3421, loadOrder: 1 },
      { id: 'skills:genui', category: 'skills', name: 'genui', tokens: 128, calls: null, tokensPerCall: null, zeroCall: null, usageBasis: 'unobservable' },
    ],
    findings: {
      zeroCall: [
        { id: 'mcp:mcp__openviking__add_resource', category: 'mcp', name: 'mcp__openviking__add_resource', tokens: 402 },
        { id: 'mcp:mcp__openviking__forget', category: 'mcp', name: 'mcp__openviking__forget', tokens: 341 },
        { id: 'tools:task_board_list', category: 'tools', name: 'task_board_list', tokens: 292 },
      ],
      topPerUse: [
        { id: 'tools:context_ledger', category: 'tools', name: 'context_ledger', tokens: 214, calls: 3, tokensPerCall: 71 },
        { id: 'tools:bash', category: 'tools', name: 'bash', tokens: 381, calls: 118, tokensPerCall: 3 },
      ],
    },
    totals: {
      residentTokens: 3688,
      observableTokens: 2490,
      unknownUsageTokens: 1198,
      observedCalls: 137,
      observableTokensPerCall: 18,
      zeroCallItems: 3,
      zeroCallTokens: 1035,
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
  }
  report.items = report.items.map((item) => (item.category === 'tools' || item.category === 'mcp'
    ? { ...item, calls: null, tokensPerCall: null, zeroCall: null, usageBasis: 'no-evidence' }
    : item))
  report.categories = report.categories.map((category) => (category.observableUsage
    ? { ...category, calls: null, tokensPerCall: null }
    : category))
  report.findings = { zeroCall: [], topPerUse: [] }
  report.totals = {
    ...report.totals, observedCalls: 0, observableTokensPerCall: null,
    zeroCallItems: 0, zeroCallTokens: 0, unknownUsageItems: 8,
  }
  return report
}

/** 一个类目塞满 8 条，用来验证「>6 行折叠为 cl.more」（DESIGN §4.3）。 */
function wideReport() {
  const report = canonicalReport()
  const tools = Array.from({ length: 8 }, (_, index) => ({
    id: `tools:fake_${index}`, category: 'tools', name: `fake_${index}`,
    tokens: 100 + index, calls: 2 + index, tokensPerCall: Math.round((100 + index) / (2 + index)),
    zeroCall: false, usageBasis: 'tool-calls',
  }))
  report.items = [...tools, ...report.items.filter((item) => item.category !== 'tools')]
  report.categories = report.categories.map((category) => (category.key === 'tools'
    ? { ...category, itemCount: 8, tokens: tools.reduce((sum, item) => sum + item.tokens, 0) }
    : category))
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

test('C. 词典：命名空间 context-ledger，zh/en 与 DESIGN §4.5 冻结键集完全同键', () => {
  assert.equal(V.NS, 'context-ledger')
  assert.deepEqual(Object.keys(V.dictionaries.zh).sort(), [...FROZEN_KEYS].sort(),
    'zh 词典键集必须与冻结键集一致（不得增删）')
  assert.deepEqual(Object.keys(V.dictionaries.en).sort(), [...FROZEN_KEYS].sort(),
    'en 词典键集必须与冻结键集一致（不得增删）')
  for (const key of FROZEN_KEYS) {
    assert.equal(typeof V.dictionaries.zh[key], 'string')
    assert.equal(typeof V.dictionaries.en[key], 'string')
    assert.notEqual(V.dictionaries.zh[key], '', `${key} 中文文案不得为空`)
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
  assert.deepEqual(plain(rows.map((row) => row.tokens)), [812, 386, 1341, 1149])
  assert.equal(rows[0].share, 812 / 3688)
  assert.equal(rows[1].mechanism.calls, 9)
  assert.equal(rows[1].mechanism.each, 43)
  assert.deepEqual(plain(V.categoryRows({ ...report, totals: { ...report.totals, residentTokens: 0 } })
    .map((row) => row.share)), [null, null, null, null], '除零保护：不画占比条')

  // 分类内保持 canonical items 相对顺序
  assert.deepEqual(plain(V.itemsOfCategory(report, 'tools').map((item) => item.name)),
    ['task_board_list', 'context_ledger', 'bash'])

  const wide = V.itemsOfCategory(wideReport(), 'tools')
  assert.equal(wide.length, 8)
  assert.equal(V.foldRows(wide, V.DETAIL_LIMIT).shown.length, 6)
  assert.equal(V.foldRows(wide, V.DETAIL_LIMIT).hidden, 2)

  const healthy = V.overview(report, T)
  assert.deepEqual(plain(healthy.map((stat) => stat.key)), ['resident', 'calls', 'perUse'])
  assert.equal(healthy[0].value, '3,688')
  assert.equal(healthy[1].value, '137')
  assert.equal(healthy[2].value, '18')
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
  assert.ok(text.includes('3,688'))
  assert.ok(text.includes('137'))
  assert.ok(text.includes('18'))

  // 3 两个对账清单（直接消费 findings，不重排）
  assert.ok(text.includes(ZH('cl.zeroCallTitle')))
  assert.ok(text.includes(ZH('cl.topPerUseTitle')))
  const zeroBlock = nodesOf(nodes.find((node) => node.props?.['data-cl-block'] === 'zero-call'))
  const zeroRows = zeroBlock.filter((node) => node.props?.['data-cl-row'] !== undefined)
  assert.deepEqual(zeroRows.map((node) => node.props['data-cl-state']), ['zero', 'zero', 'zero'])
  assert.ok(zeroRows.every((node) => textOf(node).includes(ZH('cl.neverCalled'))))
  assert.ok(zeroRows.every((node) => textOf(node).includes(ZH('cl.unknown'))), '零调用项的次数不可用 → 第 3 列必须是未知')
  assert.match(textOf(zeroBlock[0]), /add_resource.*402/s)
  const topBlock = nodesOf(nodes.find((node) => node.props?.['data-cl-block'] === 'top-per-use'))
  const topRows = topBlock.filter((node) => node.props?.['data-cl-row'] !== undefined)
  assert.deepEqual(topRows.map((node) => node.props['data-cl-state']), ['used', 'used'])
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
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map((node) => node.props['data-cl-state']), ['unknown', 'unknown', 'unknown'])
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
  assert.equal(statValues[0], '3,688', '常驻合计仍是真实测量值')
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
