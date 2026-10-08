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
 *   G. R3/R6（DESIGN §4.8 六条 + §2.22/§2.24）：可隐藏候选、五条常驻代价声明、未校验不给复制、
 *      恢复路径、两套动作并列且 token 不相加
 *   H. R7：右侧栏承载（tab 类型/座位/openTab/优雅降级/两位置义务一条不减）
 *   I. R8/v4（DESIGN §4.9 六条 + §4.4 三行新状态 + §4.5 的 9 个新键）：
 *      窗口总 / 本会话 / 覆盖会话数三个数同屏且互不可加；**"不可得"绝不显示为 0**；
 *      三态（本会话已用 / 仅历史会话用过 / 窗口内从未调用）一眼可辨；窗口边界常驻并让"零调用"
 *      有参照系；清单口径不扩张；措辞红线（含 title/aria-label）；以及面板字号对齐
 *      `--dsw-font-*` token 阶梯（主力 12px，行高同步）
 *
 * 宿主依赖走工作区内的符号链接（node_modules/@deepseek-ai/*），链接缺失即整体失败——
 * 这正是「宿主依赖链接后，客户端半区能被解析」的判据。
 *
 * @module dsh-context-ledger/test/client-panel.test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
/* J 组（C4/C5）用：把 A18 与实现侧的**实际行为**对上（只读导入，不改 lib）。 */
import { NAME_REFERENCED_LIMIT, buildHidePlan } from '../lib/hide.js'

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
/**
 * 记录型假 ctx（只实现被测路径真正用到的那几个面）。
 *
 * 与服务交互的部分刻意做得**可编排**：`services` 决定 `ctx.get(name)` 看到什么，
 * `deferred` 决定延迟注入（`ctx.inject(deps, cb)`）是"立即拿到服务"、"永不回调"还是"回调里抛错"，
 * 于是 H 组的注册形状与优雅降级都能被逐分支断言。
 */
function fakeContext(options) {
  const opts = options ?? {}
  const calls = { effects: [], registers: [], localeRegisters: [], disposers: [], deferred: [], gets: [], seatRegisters: [] }
  const services = opts.services ?? {}
  const ctx = {
    effect(callback, label) {
      calls.effects.push({ callback, label })
      // cordis 语义：ctx.effect 的回调在调用点立即执行，返回值就是卸载器。
      const dispose = callback()
      calls.disposers.push(dispose)
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(name) {
      calls.gets.push(name)
      if (opts.getThrows === true) throw new Error(`hostile get(${name})`)
      return services[name]
    },
    inject(deps, callback) {
      calls.deferred.push({ deps, callback })
      const handle = { dispose() { calls.deferredDisposed = (calls.deferredDisposed ?? 0) + 1 } }
      if (opts.noInject === true) return null
      if (opts.neverResolves === true) return handle
      // 服务已在时 cordis 立即挂载子插件；这里用 native 面模拟。
      const native = {
        get(name) { return services[name] },
        slots: {
          inject(key, cb) { calls.seatInjects = (calls.seatInjects ?? []).concat([key]); return cb() },
          register(regOptions, component) {
            calls.seatRegisters.push({ options: regOptions, component })
            return () => { calls.seatDisposed = (calls.seatDisposed ?? 0) + 1 }
          },
        },
      }
      if (opts.injectThrows === true) throw new Error('hostile inject')
      callback(native)
      return handle
    },
    locale: {
      register(namespace, dictionaries) {
        calls.localeRegisters.push({ namespace, dictionaries })
        return () => {}
      },
      bind(namespace) {
        calls.bound = namespace
        return (key, params) => dictionaryT(V.dictionaries.zh)(key, params)
      },
    },
    slots: {
      inject(key, callback) { calls.injectKey = key; calls.injectCallback = callback; return () => {} },
      register(options2, component) {
        calls.registers.push({ options: options2, component })
        return () => {}
      },
    },
  }
  return { ctx, calls }
}

/** 一个可编排的右侧栏服务面：`openTab` 记录被打开的类型；`mode` 决定它如何表现。 */
function fakeSidebarFace(mode) {
  const calls = []
  const face = {
    openTab(kind) {
      if (mode === 'throws') throw new Error('openTab rejected (no session surface)')
      calls.push(kind)
    },
    isExpanded() { return calls.length > 0 },
  }
  return { face, calls }
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

/**
 * v4 新增键集（9 键；R8 轮，DESIGN §4.5 的 v4 清单）。
 * v4 的窗口口径**只靠新增键**实现（`cl.zeroCallTitle` 等既有键一字不动，§4.5 的复用规则）：
 * `absent` 复用既有 `cl.neverCalled`，因此这里只有 9 个键。
 */
const V4_KEYS = [
  'cl.windowScope', 'cl.windowOmitted',
  'cl.currentSessionCalls', 'cl.sessionCoverage', 'cl.currentSessionTotal',
  'cl.currentSessionUnknown', 'cl.currentSessionOutsideWindow',
  'cl.presence.currentSession', 'cl.presence.historicalOnly',
]

/**
 * v4 键的**逐字契约文案**（DESIGN §4.4 / §4.9；这些是产品行为，不得自由改写）。
 * 三态徽标两条与「不可判定」「窗口外」两条的措辞在 §4.4 的 v4 三行里逐字给出。
 */
const V4_VALUES = {
  'cl.presence.currentSession': '本会话已用',
  'cl.presence.historicalOnly': '本会话未用 · 历史会话用过',
  'cl.currentSessionUnknown': '本会话：不可判定',
  'cl.currentSessionOutsideWindow': '（未进入扫描窗口）',
}

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
 * §2.9（v4）/ §2.26.3 的**逐项三态字段**：与 `items[]` 一一对应（同源数字，合成载荷）。
 * 单独成表是为了让"哪一项是哪种态"一眼可读，也让夹具与 §2.9 的对应关系可机械核对：
 *   · `current-session` 4 项（bash 41/12、find 3/5、context_ledger 2/2、read 1/3）
 *   · `historical-only` 1 项（agent_teams_claim_task 0/2 —— **不进** zeroCall）
 *   · `absent` 6 项（= `zeroCall === true` 的项数，逐项 0/0）
 *   · `calls === null` 5 项（instructions/skills）⇒ 三个新字段全 null（I2）
 */
const V4_ITEM_TRISTATE = {
  'mcp:mcp__openviking__add_resource': { currentSessionCalls: 0, sessionsWithCalls: 0, callPresence: 'absent' },
  'tools:subagent': { currentSessionCalls: 0, sessionsWithCalls: 0, callPresence: 'absent' },
  'mcp:mcp__openviking__forget': { currentSessionCalls: 0, sessionsWithCalls: 0, callPresence: 'absent' },
  'tools:task_board_list': { currentSessionCalls: 0, sessionsWithCalls: 0, callPresence: 'absent' },
  'tools:task_board_github_list': { currentSessionCalls: 0, sessionsWithCalls: 0, callPresence: 'absent' },
  'tools:task_board_schedule': { currentSessionCalls: 0, sessionsWithCalls: 0, callPresence: 'absent' },
  'tools:context_ledger': { currentSessionCalls: 2, sessionsWithCalls: 2, callPresence: 'current-session' },
  'tools:agent_teams_claim_task': { currentSessionCalls: 0, sessionsWithCalls: 2, callPresence: 'historical-only' },
  'mcp:mcp__openviking__find': { currentSessionCalls: 3, sessionsWithCalls: 5, callPresence: 'current-session' },
  'tools:read': { currentSessionCalls: 1, sessionsWithCalls: 3, callPresence: 'current-session' },
  'tools:bash': { currentSessionCalls: 41, sessionsWithCalls: 12, callPresence: 'current-session' },
  'instructions:/home/u/Desktop/DSHWorkspace/AGENTS.md': { currentSessionCalls: null, sessionsWithCalls: null, callPresence: null },
  'skills:genui': { currentSessionCalls: null, sessionsWithCalls: null, callPresence: null },
  'skills:openviking-memory': { currentSessionCalls: null, sessionsWithCalls: null, callPresence: null },
  'skills:openviking-skills': { currentSessionCalls: null, sessionsWithCalls: null, callPresence: null },
  'skills:ov-experience-memory': { currentSessionCalls: null, sessionsWithCalls: null, callPresence: null },
}

/** 给一条 §2.9 条目补上 v4 三态字段（缺表项时补 null，绝不编造 0）。 */
function v4Tristate(item) {
  const tri = V4_ITEM_TRISTATE[item.id]
  return tri === undefined
    ? { ...item, currentSessionCalls: null, sessionsWithCalls: null, callPresence: null }
    : { ...item, ...tri }
}

/**
 * canonical 报告 —— **DESIGN §2.9 v4 完整示例的逐字段副本**（16 items / 4 categories /
 * prunePlan 2 单元 / noRecommendation 3 条 / 逐项三态字段）。合成数据，用于展示形状与取值约束。
 */
function canonicalReport() {
  return {
    tool: 'context_ledger',
    version: 4,
    generatedAt: '2026-10-07T02:41:07.512Z',
    unit: 'token',
    estimator: 'heuristic-v1',
    cwd: '/home/u/Desktop/DSHWorkspace',
    scope: {
      workspaceKey: '--home-u-Desktop-DSHWorkspace--',
      sessionsRoot: '/home/u/.dsh/sessions',
      sessionsAvailable: 41,
      sessionsScanned: 20,
      /* v4（§2.9 的合成数据修正）：1 → 0，使 W5（20 + 0 ≤ 20）成立；并补 sessionsOutsideWindow。 */
      sessionsUnreadable: 0,
      sessionsLimit: 20,
      sessionsOutsideWindow: 21,
      windowStart: '2026-09-30T00:12:44.001Z',
      windowEnd: '2026-10-07T02:38:19.774Z',
      windowBasis: 'session-log-mtime',
      currentSession: { id: '1f0a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8', basis: 'agent-session-id', inWindow: true },
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
    ].map(v4Tristate),
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
      /* v4（§2.5 / §2.26.4 I10）：窗口边界声明，与 prunePlanBasis 正交、两者都必须在场 */
      zeroCallBasis: 'model-tool-calls-in-window',
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
      /* v4（§2.6）：Σ 非 null 的 currentSessionCalls = 41 + 3 + 2 + 0 + 1 = 47（≤ 137） */
      currentSessionObservedCalls: 47,
      observableTokensPerCall: 24,
      zeroCallItems: 6,
      zeroCallTokens: 1807,
      unknownUsageItems: 5,
    },
  }
}

/** 降级态（DESIGN §2.12 v4）：日志不可读 ⇒ calls 全 null，observedCalls = 0 但不许当实测。 */
function degradedReport() {
  const report = canonicalReport()
  report.scope = {
    ...report.scope, sessionsAvailable: 0, sessionsScanned: 0, sessionsUnreadable: 0,
    sessionsOutsideWindow: 0,
    windowStart: null, windowEnd: null, windowBasis: 'session-log-mtime',
    /* §2.12 ⑤：会话身份来自运行时对象，不依赖日志是否可读；但 inWindow === false ⇒ 逐项三态全 null。 */
    currentSession: { id: '1f0a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8', basis: 'agent-session-id', inWindow: false },
    linesRead: 0, toolCalls: 0, skillToolCalls: 0,
    callsUnmatched: 0, callsUnmatchedNames: [], namesRejected: 0, usageAvailable: false, truncated: false,
    providerScan: { ...report.scope.providerScan, capped: true },
  }
  report.items = report.items.map((item) => (item.category === 'tools' || item.category === 'mcp'
    ? {
      ...item, calls: null, tokensPerCall: null, zeroCall: null, usageBasis: 'no-evidence',
      currentSessionCalls: null, sessionsWithCalls: null, callPresence: null,
    }
    : item))
  report.categories = report.categories.map((category) => (category.observableUsage
    ? { ...category, calls: null, tokensPerCall: null }
    : category))
  report.findings = {
    zeroCall: [], topPerUse: [], prunePlan: [],
    prunePlanReclaimableTokens: 0, prunePlanBasis: 'model-tool-calls-only',
    /* §2.12 ⑥：zeroCallBasis 照常给出——它声明口径，不声明证据充足 */
    zeroCallBasis: 'model-tool-calls-in-window',
    noRecommendation: [
      { reason: 'core', items: 0, tokens: 0 },
      { reason: 'no-owner-bundle', items: 0, tokens: 0 },
      { reason: 'unknown-attribution', items: 0, tokens: 0 },
    ],
  }
  report.totals = {
    ...report.totals, observedCalls: 0, observableTokensPerCall: null,
    /* §2.12 ⑥：null（不是 0）——"给不出"与"确实是 0"必须可区分 */
    currentSessionObservedCalls: null,
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
 * §2.21.1 的 A1–A18 恒等式在抽取时已逐条复核通过。
 *
 * **v4（R8）同步**：`version` 随 canonical 版本升到 4、`findings.zeroCallBasis` 补进副本
 * （DESIGN §2.21 在 v4 里的两处变化）；`subagent.registryUse.nameReferencedElsewhere`
 * 按 §2.19 的升序重排（C4 修正）。
 * **防漂移**：J 组会把本常量与 `DESIGN.md` §2.21 的 jsonc 块做**机械逐字段比对**并校验
 * 内容指纹（`SECTION_21_FINGERPRINT`）——DESIGN 将来再改动时，这里会**显式变红**。
 */
const R6_EXAMPLE = {
  "tool": "context_ledger",
  "version": 4,
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
            "/home/u/.dsh/profiles/web/node_modules/@linxin666/dsh-session-archive/lib/index.js",
            "/home/u/.dsh/profiles/web/node_modules/@nanmicoder/dsh-agent-teams/lib/harness-compat.js"
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
    "zeroCallBasis": "model-tool-calls-in-window",
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
    /* version 直接跟随夹具（不再硬编码）：§2.21 是 canonical 的增量片段，两者版本必须一致。 */
    version: R6_EXAMPLE.version,
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

test('C. 词典：命名空间 context-ledger，zh/en 同键；v1+v2+v3 键一个未删、未改值；v4 键两语言齐全', () => {
  assert.equal(V.NS, 'context-ledger')
  const zhKeys = Object.keys(V.dictionaries.zh).sort()
  const enKeys = Object.keys(V.dictionaries.en).sort()
  assert.deepEqual(zhKeys, enKeys, 'zh/en 必须同键（§4.5 硬要求）')
  assert.deepEqual(zhKeys, [...FROZEN_KEYS, ...V3_KEYS, ...V4_KEYS].sort(),
    '键集 = v1+v2（54，保持）+ v3（45，保持）+ v4（9，本轮新增）；不得增删')
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
  /* v4 键两语言齐全且非空 */
  for (const key of V4_KEYS) {
    assert.equal(typeof V.dictionaries.zh[key], 'string', `${key} 缺中文文案`)
    assert.equal(typeof V.dictionaries.en[key], 'string', `${key} 缺英文文案`)
    assert.notEqual(V.dictionaries.zh[key].trim(), '', `${key} 中文文案不得为空`)
    assert.notEqual(V.dictionaries.en[key].trim(), '', `${key} 英文文案不得为空`)
  }
  /* v4 键：§4.4 里逐字给出的文案不得被改写（三态徽标两条 + 不可判定两条） */
  for (const [key, value] of Object.entries(V4_VALUES)) {
    assert.equal(V.dictionaries.zh[key], value, `v4 键 ${key} 的文案是 §4.4 的逐字契约，不得改`)
  }
  assert.equal(V.dictionaries.en['cl.presence.currentSession'], 'used in this session')
  assert.equal(V.dictionaries.en['cl.presence.historicalOnly'], 'not in this session · used in earlier ones')
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
function renderPanel(report, t = ZH, verify = V, extraProps = {}) {
  mini.reset()
  const tree = mini.render(verify.LedgerPanel, {
    id: 'p', t, report, state: 'ready', refreshedAt: 0, onRefresh() {}, ...extraProps,
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

/* ══════════════════════════════════════════════════════════════════════════
 * H 组：R7 —— 右侧栏承载（点控件即开栏 + 优雅降级 + 义务不减）
 * ══════════════════════════════════════════════════════════════════════════ */


/** 浮层是否出现在树里（嵌套组件不会被 harness 执行，因此按元素与 props 判断）。 */
function popoverElements(nodes, verify = V) {
  return nodes.filter((node) => node.type === verify.LedgerPanel && node.props?.mode === 'popover')
}

/** 用假 ctx 跑一遍 apply，返回记录。 */
function applied(options) {
  const { ctx, calls } = fakeContext(options)
  loaded.plugin.apply(ctx)
  // 框架语义：座位声明已存在时 slots.inject 的回调立即执行（composer 控件由此注册）。
  if (typeof calls.injectCallback === 'function') calls.injectCallback()
  return { ctx, calls }
}

/** 从 composer 注册项里取出注入面（框架就是这么给组件塞 props 的）。 */
function composerFace(calls) {
  const entry = calls.registers.find((row) => row.options.name === 'conversation.input.right')
  assert.ok(entry !== undefined, 'composer 控件必须仍注册在 conversation.input.right')
  assert.equal(typeof entry.options.inject, 'function', '打开入口必须经 slot 的 inject face 注入')
  return entry.options.inject()
}

test('H1. 右侧栏 tab 类型：正文与标题两座位共用同一个 key（= 类型 id），符合宿主插槽契约', () => {
  const { calls } = applied({ services: { sidebarRightTabs: { register: () => () => {} } } })

  // ① 延迟注入只针对可选服务，且不是硬依赖
  assert.deepEqual(plain(calls.deferred.map((row) => row.deps)), [['sidebarRightTabs']])
  assert.deepEqual(plain(loaded.plugin.inject), ['slots', 'locale'], '硬依赖不得新增（否则老宿主会卡住/报错）')

  // ② 类型定义：id / kind / title thunk；页类型不认领资源地址
  const define = calls.deferred[0].callback
  const typeRegistrations = []
  const seatRegisters = calls.seatRegisters
  const nativeRegistrations = []
  const { ctx, calls: inner } = fakeContext({
    services: {
      sidebarRightTabs: {
        register(definition) { typeRegistrations.push(definition); return () => { inner.typeDisposed = true } },
      },
    },
  })
  loaded.plugin.apply(ctx)
  assert.equal(typeRegistrations.length, 1, '必须恰注册一个 tab 类型')
  const definition = typeRegistrations[0]
  assert.equal(definition.id, V.LEDGER_TAB_ID)
  assert.equal(definition.id, 'dsh-context-ledger')
  assert.equal(definition.kind, V.LEDGER_TAB_KIND)
  assert.equal(definition.kind, 'context-ledger')
  assert.equal(typeof definition.title, 'function')
  assert.equal(definition.title(), 'Context Ledger', 'chip 初始文案走本插件词典（cl.title）')
  assert.equal(definition.patterns, undefined, '页类型：不申报资源 glob')
  assert.equal(definition.priority, undefined, '省略 priority = extension 带（外来类型最高）')

  // ③ 两个座位：名字正确、key 同为类型 id、locale 座位指向本命名空间
  const seats = inner.seatRegisters.map((row) => row.options)
  assert.deepEqual(plain(seats.map((row) => row.name)).sort(), [...V.LEDGER_TAB_SEATS].sort(),
    '正文与标题两个座位都要注册')
  for (const seat of seats) {
    assert.equal(seat.key, definition.id, `${seat.name} 的 key 必须 = 类型 id（宿主按 id 分派）`)
    assert.equal(seat.locale, 'context-ledger')
  }
  assert.equal(typeof inner.seatRegisters.find((row) => row.options.name === 'sidebar.right.pane.tab').component, 'function')
  assert.equal(inner.seatRegisters.find((row) => row.options.name === 'sidebar.right.pane.tab').component, V.LedgerTab)
  assert.equal(inner.seatRegisters.find((row) => row.options.name === 'sidebar.right.pane.tab.title').component, V.LedgerTabTitle)
  assert.deepEqual(plain(inner.seatInjects).sort(), [...V.LEDGER_TAB_SEATS].sort())

  // ④ 一手契约：两个座位在宿主里都是 keyed/session，且分派 key 取 definition.id
  const seatContract = readFileSync(join(HOST, 'dsh-client-ui-sidebar-right/lib/types/client/contract/slots.d.ts'), 'utf8').split('\n')
  for (const seat of V.LEDGER_TAB_SEATS) {
    const line = seatContract.findIndex((text) => text.includes(`'${seat}': {`))
    assert.ok(line > 0, `宿主契约里缺 ${seat}`)
    assert.match(seatContract[line + 1], /kind: 'keyed'/, `${seat} 应为 keyed`)
    assert.match(seatContract[line + 2], /scope: 'session'/, `${seat} 应为 session 作用域`)
    console.log('[证据] %s 契约：%s:%d（kind: keyed / scope: session）', seat,
      'dsh-client-ui-sidebar-right/lib/types/client/contract/slots.d.ts', line + 1)
  }
  const runtime = readFileSync(join(HOST, 'dsh-client-ui-sidebar-right/lib/client.js'), 'utf8').split('\n')
  const dispatch = runtime.findIndex((text) => text.includes('entryKey: definition?.id ?? tab.kind'))
  assert.ok(dispatch > 0, '宿主按 definition.id 分派 body/title 座位')
  console.log('[证据] 座位分派：dsh-client-ui-sidebar-right/lib/client.js:%d', dispatch + 1)
})

test('H2. 点 composer 控件即开右侧栏：走 ctx.sidebarRight.openTab(kind)，同一步展开、不多点一次', () => {
  const { face, calls: opens } = fakeSidebarFace('ok')
  const { calls } = applied({ services: { sidebarRight: face, sidebarRightTabs: { register: () => () => {} } } })
  const injected = composerFace(calls)

  // 注入面就是控件点击时调用的那个函数
  assert.equal(typeof injected.openLedgerTab, 'function')
  assert.equal(injected.openLedgerTab(), true, '服务在时必须报告成功（控件据此不再展开浮层）')
  assert.deepEqual(plain(opens), ['context-ledger'], 'openTab 必须收到我们的 kind')

  // 真点一次：右侧栏接管，浮层不得出现（不得要求用户再点一次）
  mini.reset()
  const props = { id: 'p', t: ZH, report: canonicalReport(), state: 'ready', refreshedAt: 0, onRefresh() {}, openLedgerTab: injected.openLedgerTab }
  let tree = mini.render(V.LedgerRing, { t: ZH, sessionId: 's1', openLedgerTab: injected.openLedgerTab })
  const trigger = nodesOf(tree).find((node) => node.props?.['data-cl-trigger'] !== undefined)
  assert.ok(trigger !== undefined)
  assert.equal(trigger.props['aria-expanded'], false)
  trigger.props.onClick()
  assert.deepEqual(plain(opens), ['context-ledger', 'context-ledger'], '点击即开栏')
  tree = mini.render(V.LedgerRing, { t: ZH, sessionId: 's1', openLedgerTab: injected.openLedgerTab })
  assert.equal(popoverElements(nodesOf(tree)).length, 0,
    '右侧栏接管时不得再就地展开浮层（内容已在栏里，不需要第二下）')
  assert.equal(nodesOf(tree).find((node) => node.props?.['data-cl-trigger'] !== undefined).props['aria-expanded'], false)
  // 再点一次：仍然交给右侧栏（它会 reveal/focus 已开的那页），不弹浮层、不抛错
  nodesOf(tree).find((node) => node.props?.['data-cl-trigger'] !== undefined).props.onClick()
  assert.equal(opens.length, 3)
  assert.equal(props.state, 'ready')
})

test('H3. 优雅降级：右侧栏不可用时回退就地浮层，不抛错、控件不是死按钮', () => {
  const variants = [
    ['完全没有该服务', { services: {} }],
    ['服务存在但 face 不完整（无 openTab）', { services: { sidebarRight: { isExpanded: () => true } } }],
    ['ctx.get 本身抛错', { services: {}, getThrows: true }],
    ['openTab 抛错（无在屏会话）', { services: { sidebarRight: fakeSidebarFace('throws').face } }],
  ]
  for (const [label, options] of variants) {
    const { calls } = applied(options)
    const injected = composerFace(calls)
    let returned
    assert.doesNotThrow(() => { returned = injected.openLedgerTab() }, `${label}：openLedgerTab 不得抛错`)
    assert.equal(returned, false, `${label}：必须报告失败，让控件回退`)

    // 控件点击 → 就地浮层出现（不是死按钮）
    mini.reset()
    let tree = mini.render(V.LedgerRing, { t: ZH, sessionId: 's1', openLedgerTab: injected.openLedgerTab })
    const trigger = nodesOf(tree).find((node) => node.props?.['data-cl-trigger'] !== undefined)
    assert.doesNotThrow(() => trigger.props.onClick(), `${label}：点击不得抛错`)
    tree = mini.render(V.LedgerRing, { t: ZH, sessionId: 's1', openLedgerTab: injected.openLedgerTab })
    const panels = popoverElements(nodesOf(tree))
    assert.equal(panels.length, 1, `${label}：必须回退到就地浮层`)
    assert.equal(panels[0].props.report !== undefined, true)
    assert.equal(nodesOf(tree).find((node) => node.props?.['data-cl-trigger'] !== undefined).props['aria-expanded'], true)
  }

  // 连注入面都缺席（框架没给 props）：同样回退，不抛错
  mini.reset()
  let tree = mini.render(V.LedgerRing, { t: ZH, sessionId: 's1' })
  nodesOf(tree).find((node) => node.props?.['data-cl-trigger'] !== undefined).props.onClick()
  tree = mini.render(V.LedgerRing, { t: ZH, sessionId: 's1' })
  assert.equal(popoverElements(nodesOf(tree)).length, 1, '连注入面都没有时同样回退到浮层')

  // 注册侧降级：服务缺席（回调永不执行）/ 注册表残缺 / 注册抛错 / 座位注册抛错 / 没有 inject
  assert.doesNotThrow(() => applied({ neverResolves: true }))
  assert.doesNotThrow(() => applied({ services: { sidebarRightTabs: {} } }))
  assert.doesNotThrow(() => applied({ services: { sidebarRightTabs: { register() { throw new Error('taken id/kind') } } } }))
  assert.doesNotThrow(() => applied({ injectThrows: true }))
  const noInject = fakeContext({ noInject: true })
  assert.doesNotThrow(() => loaded.plugin.apply(noInject.ctx))
  assert.doesNotThrow(() => noInject.calls.injectCallback(), '座位声明已存在时回调立即执行')
  assert.equal(noInject.calls.registers.length, 1, '没有延迟注入能力时 composer 控件照旧注册')
  const noInjectFace = noInject.calls.registers[0].options.inject()
  assert.equal(noInjectFace.openLedgerTab(), false, '没有右侧栏服务时打开入口报告失败')

  // 座位注册抛错 ⇒ 已注册的类型必须被回滚（不留半套）
  const rolled = []
  const { ctx } = fakeContext({ services: { sidebarRightTabs: { register: () => () => { rolled.push('type') } } } })
  ctx.inject = (deps, callback) => {
    const native = {
      get: () => ({ register: () => { rolled.push('registered') ; return () => { rolled.push('type-disposed') } } }),
      slots: { inject: (key, cb) => cb(), register: () => { throw new Error('seat rejected') } },
    }
    callback(native)
    return { dispose() {} }
  }
  assert.doesNotThrow(() => loaded.plugin.apply(ctx))
  assert.deepEqual(rolled, ['registered', 'type-disposed'], '座位注册失败必须回滚已注册的类型')
})

test('H4. 既有内容义务在新位置一条不减：§4.7/§4.8 的关键义务在右侧栏版式下同样成立', () => {
  // 新位置（栏内）渲染同一个 LedgerPanel
  const { nodes, text } = renderPanel(r6Report(), ZH, V, { mode: 'sidebar' })
  const panel = nodes.find((node) => node.props?.['data-cl-panel'] !== undefined)
  assert.equal(panel.props['data-cl-mode'], 'sidebar', '栏内渲染必须标记 sidebar 版式')

  // §4.7 第 1/2/3 条：候选语气 + 每行五件事实 + 声明常驻段底
  const pruneBlock = blockOf(nodes, 'prune-plan')
  assert.equal(textOf(fieldOf(pruneBlock, 'data-cl-prune-title')), ZH('cl.prunePlanTitle'))
  for (const row of pruneRowsOf(nodes)) {
    for (const field of ['data-cl-prune-unit', 'data-cl-prune-tools', 'data-cl-prune-reclaim',
      'data-cl-prune-used', 'data-cl-prune-facts']) {
      assert.ok(textOf(fieldOf(row, field)).trim() !== '', `栏内：${field} 不得为空`)
    }
  }
  const caveat = nodesOf(pruneBlock).filter((node) => node.props?.['data-cl-prune-caveat'] !== undefined)
  assert.equal(caveat.length, 1)
  assert.equal(pruneBlock.props.children[pruneBlock.props.children.length - 1],
    nodesOf(pruneBlock).find((node) => node.props?.['data-cl-prune-caveats'] !== undefined) ?? caveat[0])

  // §4.8 第 1/2/3 条：栏内同样有候选语气标题、五件事实、五条常驻声明
  const hideBlock = hideBlockOf(nodes)
  assert.equal(textOf(fieldOf(hideBlock, 'data-cl-hide-title')), ZH('cl.hidePlanTitle'))
  for (const row of hideRowsOf(nodes)) {
    for (const field of ['data-cl-hide-name', 'data-cl-hide-unit', 'data-cl-hide-tokens',
      'data-cl-hide-verdict', 'data-cl-hide-precheck-text']) {
      assert.ok(textOf(hideRowField(row, field)).trim() !== '', `栏内：${field} 不得为空`)
    }
  }
  assert.equal(nodesOf(hideBlock).filter((node) => node.props?.['data-cl-hide-caveat'] !== undefined).length, 5)
  // §4.8 第 3 条（建议 ≠ 已施加）+ 第 6 条（恢复路径可查）
  assert.ok(textOf(fieldOf(hideBlock, 'data-cl-hide-apply-mode')).includes('不会自动施加'))
  const restoreText = textOf(blockOf(nodes, 'hide-restore'))
  assert.ok(restoreText.includes('没有“撤销上一条隐藏”的命令'))
  assert.ok(restoreText.includes('不追溯'))
  // §3.7：两个动作的 token 仍不相加（栏内同样不出现两笔之和）
  assert.equal(text.includes('7,637'), false)
  assert.equal(text.includes('7637'), false)
  assert.ok(textOf(fieldOf(blockOf(nodes, 'plan-parallel'), 'data-cl-hide-no-sum')).includes('不得相加'))
  // 明细里的归属徽标/证据行同样在（同一份映射）
  assert.equal(V.attributionText({ kind: 'unknown', name: null, confidence: 'low' }, ZH), ZH('cl.providedBy.unknown') + ' ?')

  /* 最强形式：两个承载位置的**可见文本与数据标记逐字节相同**，
   * 唯一差异是外层 section 的版式 / 语义 / mode 标记（内容零分叉）。 */
  const panelOf = (view) => view.nodes.find((node) => node.props?.['data-cl-panel'] !== undefined)
  const markersOf = (view) => nodesOf(panelOf(view))
    .map((node) => Object.keys(node.props ?? {}).filter((key) => key.indexOf('data-cl') === 0).sort().join('|'))
    .join(',')
  for (const [label, fixture] of [['§2.9 canonical', canonicalReport()], ['§2.21 R6', r6Report()]]) {
    const asPopover = renderPanel(fixture, ZH, V, { mode: 'popover' })
    const asSidebar = renderPanel(fixture, ZH, V, { mode: 'sidebar' })
    assert.equal(textOf(panelOf(asSidebar)), textOf(panelOf(asPopover)), `${label}：栏内与弹层的可见文本必须逐字相同`)
    assert.equal(markersOf(asSidebar), markersOf(asPopover), `${label}：数据标记（挂点）必须相同`)
    const a = panelOf(asPopover).props
    const b = panelOf(asSidebar).props
    assert.notEqual(a['data-cl-mode'], b['data-cl-mode'])
    assert.notEqual(a.style, b.style)
    assert.notEqual(a.role, b.role)
    for (const key of Object.keys(a)) {
      if (key === 'style' || key === 'role' || key === 'data-cl-mode' || key === 'children') continue
      assert.deepEqual(b[key], a[key], `${label}：除版式/语义外根属性不得不同（${key}）`)
    }
    /* 子树逐属性渲染期闭包（onClick）必然不同，故用"节点数 + 文本 + 数据标记"三重一致代替深比。 */
    assert.equal(nodesOf(panelOf(asSidebar)).length, nodesOf(panelOf(asPopover)).length,
      `${label}：两承载位置的元素节点数必须相同`)
  }

  // 弹层版式（默认）仍然一模一样：显式给 mode: 'popover' 复核同一批义务
  const popover = renderPanel(r6Report(), ZH, V, { mode: 'popover' })
  assert.equal(popover.nodes.find((node) => node.props?.['data-cl-panel'] !== undefined).props['data-cl-mode'], 'popover')
  assert.equal(textOf(fieldOf(blockOf(popover.nodes, 'prune-plan'), 'data-cl-prune-title')), ZH('cl.prunePlanTitle'))
  assert.equal(textOf(fieldOf(hideBlockOf(popover.nodes), 'data-cl-hide-title')), ZH('cl.hidePlanTitle'))
  assert.equal(popover.text.includes('7,637'), false)
})

test('H5. 措辞红线在新位置重验：栏内整屏 / tab 标题 / tooltip 属性文本均无禁止词与危险色', () => {
  const { nodes, text } = renderPanel(r6Report(), ZH, V, { mode: 'sidebar' })
  for (const bad of [...HIDE_FORBIDDEN, '建议卸载', '可以删掉', '浪费', '无用', 'safe to delete']) {
    assert.equal(text.includes(bad), false, `栏内整屏不得出现「${bad}」`)
  }
  assert.equal(HIDE_IMPERATIVE.test(text), false)
  const panel = nodes.find((node) => node.props?.['data-cl-panel'] !== undefined)
  assert.equal(/state-error-primary/.test(JSON.stringify(panel.props.style)), false)

  // tab 标题（chip）与注册表 title thunk：同一份 cl.title，无禁止词、不藏 tooltip
  const titleTree = V.LedgerTabTitle({ t: ZH })
  assert.equal(titleTree.props['data-cl-tab-title'], '')
  assert.equal(textOf(titleTree).trim(), 'Context Ledger')
  assert.equal(titleTree.props.title, undefined, 'chip 标题不得把文案藏进 tooltip')
  for (const bad of HIDE_FORBIDDEN) assert.equal(textOf(titleTree).includes(bad), false)
  assert.equal(V.dictionaries.zh['cl.title'], 'Context Ledger')
  assert.equal(V.dictionaries.en['cl.title'], 'Context Ledger')

  // composer 触发器的属性型文本（title / aria-label）
  mini.reset()
  const ring = mini.render(V.LedgerRing, { t: ZH, sessionId: 's1' })
  const trigger = nodesOf(ring).find((node) => node.props?.['data-cl-trigger'] !== undefined)
  for (const attr of [trigger.props.title, trigger.props['aria-label']]) {
    assert.equal(typeof attr, 'string')
    for (const bad of HIDE_FORBIDDEN) assert.equal(attr.includes(bad), false, `属性文本不得含「${bad}」`)
    assert.equal(HIDE_IMPERATIVE.test(attr), false)
  }
  console.log('[文案] tab 标题 = %s ｜ 触发器 title = %s', textOf(titleTree), trigger.props.title)

  // 本轮零删改既有词典键（v4 只新增 9 个键；既有 99 键一个未删未改）
  assert.equal(Object.keys(V.dictionaries.zh).length, FROZEN_KEYS.length + V3_KEYS.length + V4_KEYS.length)
  assert.deepEqual(Object.keys(V.dictionaries.zh).sort(), Object.keys(V.dictionaries.en).sort())
})

test('H6. 版式：栏内不再绝对定位/限高，弹层版式原样保留（同一份内容，两个承载位置）', () => {
  const inSidebar = renderPanel(canonicalReport(), ZH, V, { mode: 'sidebar' })
  const sidebarPanel = inSidebar.nodes.find((node) => node.props?.['data-cl-panel'] !== undefined)
  assert.equal(sidebarPanel.props.style.position, undefined, '栏内不得绝对定位')
  assert.equal(sidebarPanel.props.style.width, '100%')
  assert.equal(sidebarPanel.props.style.maxHeight, undefined, '栏内不限高（交给栏自己滚动）')
  assert.equal(sidebarPanel.props.style.borderRadius, 0)
  assert.equal(sidebarPanel.props.role, 'region', '栏内是栏的一页，不用对话框语义')

  const popover = renderPanel(canonicalReport(), ZH, V, { mode: 'popover' })
  const popoverPanel = popover.nodes.find((node) => node.props?.['data-cl-panel'] !== undefined)
  assert.equal(popoverPanel.props.style.position, 'absolute', '弹层版式保持不变（回退路径）')
  assert.match(String(popoverPanel.props.style.maxHeight), /min\(72vh/)
  assert.equal(popoverPanel.props.role, 'dialog')

  // tab 正文外壳：占满栏高、自己滚动，并把 mode: 'sidebar' 交给面板
  mini.reset()
  const tabTree = mini.render(V.LedgerTab, { t: ZH, sessionId: 's1' })
  assert.equal(tabTree.props['data-cl-tab'], '')
  assert.equal(tabTree.props.style.height, '100%')
  assert.equal(tabTree.props.style.overflowY, 'auto')
  const boundary = tabTree.props.children[0]
  assert.equal(boundary.type, V.PanelBoundary, '栏内也要有渲染兜底（面板崩了不许带走栏）')
  const panelElement = boundary.props.children[0]
  assert.equal(panelElement.type, V.LedgerPanel)
  assert.equal(panelElement.props.mode, 'sidebar')
  assert.equal(panelElement.props.t, ZH)
  assert.equal(panelElement.props.report, null, '新挂载实例：数据由 useLedgerData 在挂载后拉取')
  assert.equal(panelElement.props.state, 'idle')
})

/* ══════════════════════════════════════════════════════════════════════════
 * I 组：R8/v4 —— DESIGN §4.9 的六条呈现义务 + §4.4 的三行新状态
 *      + IMPLEMENTATION-NOTES「面板字号对齐 DSH --dsw-font-* 阶梯」
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 本会话**不在窗口内**（§2.26.2 判定表行 4/5）：逐项 `currentSessionCalls` / `callPresence`
 * 全为 `null`，`totals.currentSessionObservedCalls` 为 `null`；而窗口口径与**覆盖会话数**
 * 照常可用（覆盖通道是另一个通道）——这正是"不知道 ≠ 0"最容易被做错的一处的夹具。
 */
function outsideWindowReport() {
  const report = canonicalReport()
  report.scope = {
    ...report.scope,
    currentSession: { id: '1f0a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8', basis: 'agent-session-id', inWindow: false },
  }
  report.items = report.items.map((item) => (item.category === 'tools' || item.category === 'mcp'
    ? { ...item, currentSessionCalls: null, callPresence: null }
    : item))
  report.totals = { ...report.totals, currentSessionObservedCalls: null }
  return report
}

/** 本会话身份拿不到（§2.2 硬规则 1 / §4.9 第 4 条）：`basis: "unavailable"`、`id: null`。 */
function unknownSessionReport() {
  const report = outsideWindowReport()
  report.scope = { ...report.scope, currentSession: { id: null, basis: 'unavailable', inWindow: false } }
  report.totals = { ...report.totals, currentSessionObservedCalls: null }
  return report
}

/** 渲染面板并展开某个类目（v4 的逐项三态均在条目行里）。 */
function renderExpanded(report, category, t = ZH, extraProps = {}) {
  mini.reset()
  const base = { id: 'p', t, report, state: 'ready', refreshedAt: 0, onRefresh() {}, ...extraProps }
  const collapsed = mini.render(V.LedgerPanel, base)
  const head = nodesOf(collapsed).find((node) => node.props?.['data-cl-category'] === category)
  assert.ok(head !== undefined, `缺类目 ${category}`)
  head.props.children[0].props.onClick()
  const tree = mini.render(V.LedgerPanel, base)
  return { tree, nodes: nodesOf(tree), text: textOf(tree) }
}

/** 明细里某一项的行节点（外层容器带 `data-cl-item`，行节点带 `data-cl-row`）。 */
function detailRowOf(nodes, itemId) {
  const wrapper = nodes.find((node) => node.props?.['data-cl-item'] === itemId)
  assert.ok(wrapper !== undefined, `明细里必须有 ${itemId}（未被折叠）`)
  const row = nodesOf(wrapper).find((node) => node.props?.['data-cl-row'] !== undefined)
  assert.ok(row !== undefined, `${itemId} 缺行节点`)
  return row
}

/** 取值格节点（v4：三个数各有自己的数据标记，逐格断言而非对整行做模糊匹配）。 */
function figureOf(row, marker) {
  return nodesOf(row).find((node) => node.props?.['data-cl-figure'] === marker)
}

/** 本地时区的 `MM-DD HH:mm`（与 shortStamp 同口径，独立实现，避免自证）。 */
function localStamp(iso) {
  const date = new Date(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** v4 节点（窗口 / 本会话 / 三态 / 覆盖）的标记 + 文本，用于两承载位置的一致性比对。 */
function v4Signature(nodes) {
  const isV4 = (node) => Object.keys(node.props ?? {}).some((key) => /^data-cl-(window|presence|current-session|coverage)/.test(key))
  return nodes.filter(isV4).map((node) => {
    const marks = Object.keys(node.props).filter((key) => key.indexOf('data-cl') === 0).sort().join('|')
    return `${marks}::${node.props['data-cl-window-scope'] ?? ''}${node.props['data-cl-window-omitted'] ?? ''}`
      + `${node.props['data-cl-presence'] ?? ''}::${textOf(node)}`
  }).join('§')
}

test('I1. §4.9 第 1 条：窗口总调用 / 本会话 / 覆盖会话数三个数同屏，各有独立节点与标签，互不可加', () => {
  const report = canonicalReport()
  const { nodes, text } = renderExpanded(report, 'tools')

  // ① 三个数各自有独立节点（不是堆在一段文字里让人自己算）
  /* tools 类目按 DETAIL_LIMIT=6 折叠，取行内的三项：context_ledger（calls 3 / 本会话 2 / 覆盖 2）。 */
  const row = detailRowOf(nodes, 'tools:context_ledger')
  assert.equal(textOf(figureOf(row, 'calls')), '3', '窗口总调用格 = calls（窗口口径）')
  const session = nodesOf(row).find((node) => node.props?.['data-cl-current-session'] !== undefined)
  const coverage = nodesOf(row).find((node) => node.props?.['data-cl-coverage'] !== undefined)
  assert.equal(session.props['data-cl-current-session'], '2', '本会话格 = currentSessionCalls')
  assert.equal(coverage.props['data-cl-coverage'], '2', '覆盖格 = sessionsWithCalls')
  assert.equal(textOf(session), ZH('cl.currentSessionCalls') + ' 2', '本会话格必须自带标签')
  assert.equal(textOf(coverage), ZH('cl.sessionCoverage', { n: '2', scanned: '20' }),
    '覆盖会话数必须带分母（分母 = scope.sessionsScanned），写作 n/scanned')
  assert.equal(textOf(figureOf(row, 'tokens-per-call')), '71', 'tokensPerCall 仍按 calls 计算（不得换分母）')

  // 三个数同屏：同一行的可见文本里同时出现 3（窗口总） / 本会话 2 / 覆盖 2/20
  const rowText = textOf(row)
  for (const value of ['3', ZH('cl.currentSessionCalls') + ' 2', '2/20']) {
    assert.ok(rowText.includes(value), `行内必须同屏出现 ${value}`)
  }
  // 三个数各自的列/格标签都在场（不是无标签的三个数字）
  const categoryBlock = nodes.find((node) => node.props?.['data-cl-block'] === 'categories')
  for (const label of [ZH('cl.observedCalls'), ZH('cl.currentSessionCalls') + ' 2',
    ZH('cl.sessionCoverage', { n: '2', scanned: '20' })]) {
    assert.ok(textOf(categoryBlock).includes(label), `明细里必须有清晰标签：${label}`)
  }

  // ② 互不可加：构造 100 + 5 的用例，面板**不得**出现任何和数（也不得换分母）
  const sumReport = canonicalReport()
  sumReport.scope = { ...sumReport.scope, sessionsScanned: 2, sessionsAvailable: 2, sessionsOutsideWindow: 0 }
  sumReport.items = sumReport.items.map((item) => (item.id === 'tools:context_ledger'
    ? { ...item, tokens: 300, calls: 100, tokensPerCall: 3, currentSessionCalls: 5, sessionsWithCalls: 1, callPresence: 'current-session' }
    : item))
  const sum = renderExpanded(sumReport, 'tools')
  const sumRow = detailRowOf(sum.nodes, 'tools:context_ledger')
  assert.equal(textOf(figureOf(sumRow, 'calls')), '100')
  assert.equal(textOf(nodesOf(sumRow).find((node) => node.props?.['data-cl-current-session'] !== undefined)),
    ZH('cl.currentSessionCalls') + ' 5')
  assert.equal(textOf(figureOf(sumRow, 'tokens-per-call')), '3', '每次使用成本 = round(300 / 100)，未改用本会话数做分母')
  /* 逐格检查：面板里任何数值格都不得出现"三个数相加"或"改用本会话数做分母"的派生值
   * （不用整屏子串匹配——千分位数字会让 "460" 这类子串误伤）。 */
  const figures = sum.nodes.filter((node) => node.props?.['data-cl-figure'] !== undefined).map((node) => textOf(node))
  assert.equal(figures.includes('105'), false, '三个数不得相加（100 + 5）')
  assert.equal(figures.includes('60'), false, '不得改用本会话数做 tokensPerCall 的分母（300 / 5）')
  assert.equal(sum.text.includes('1/2'), true, '覆盖会话数照实呈现')

  // ③ 面板不得派生"平均每次会话调用"之类结论（§2.26.1 硬规则 3 / §6 第 12 条③）
  for (const banned of ['平均', '最活跃', 'average', 'most active', '最近一次调用']) {
    assert.equal(text.includes(banned), false, `不得派生结论「${banned}」`)
  }
})

test('I2. §4.9 第 3/4 条：「不可得」与「0」视觉可分——本会话维度拿不到时绝不显示 0', () => {
  // ① 真 0：本会话在窗口内、该工具在窗口内确实没被调用（canonical 的 absent 项）
  const zeros = renderExpanded(canonicalReport(), 'tools')
  const absent = detailRowOf(zeros.nodes, 'tools:task_board_list')
  assert.equal(absent.props['data-cl-presence'], 'absent')
  const absentFigure = nodesOf(absent).find((node) => node.props?.['data-cl-current-session'] !== undefined)
  assert.equal(absentFigure.props['data-cl-current-session'], '0', '窗口内的真零调用：本会话数是 0（有证据）')
  assert.equal(textOf(absentFigure), ZH('cl.currentSessionCalls') + ' 0')
  assert.ok(textOf(zeros.nodes.find((node) => node.props?.['data-cl-current-session-summary'] !== undefined))
    .includes('47'), '总览的本会话调用数是宿主给的值')

  // ② 不可得：本会话不在窗口内 ⇒ 逐项不显示 0，显示"不可判定 + 原因"
  const outside = renderExpanded(outsideWindowReport(), 'tools')
  const missing = detailRowOf(outside.nodes, 'tools:context_ledger')
  assert.equal(missing.props['data-cl-presence'], 'unavailable', '拿不到三态就标记 unavailable，不猜')
  const missingFigure = nodesOf(missing).find((node) => node.props?.['data-cl-current-session'] !== undefined)
  assert.equal(missingFigure.props['data-cl-current-session'], 'unavailable')
  assert.equal(textOf(missingFigure), ZH('cl.currentSessionUnknown') + ZH('cl.currentSessionOutsideWindow'),
    '必须写成"本会话：不可判定（未进入扫描窗口）"，且给出原因')
  /* 视觉可分的最强证据：真 0 是普通数字格，不可得是**中性灰徽标**（§4.4 的 v4 第 3 行）。 */
  assert.equal(absentFigure.props.style.border, undefined, '真 0 是普通数字格')
  assert.equal(typeof missingFigure.props.style.border, 'string', '"不可判定"必须渲染成中性灰徽标')
  assert.notEqual(missingFigure.props.style.borderRadius, absentFigure.props.style.borderRadius)
  assert.equal(/本会话 0/.test(outside.text), false, '不可得**绝不**显示成本会话 0 次')
  /* 该报告里仍有**真**零调用项（窗口口径 calls === 0，有证据）——那不矛盾：
   * 被禁止的是把"本会话拿不到"渲染成 0，所以这里逐行检查"零调用徽标只跟着窗口零调用走"。 */
  const outsideRows = outside.nodes.filter((node) => node.props?.['data-cl-row'] !== undefined)
  for (const row of outsideRows) {
    const zeroChips = nodesOf(row).filter((node) => node.props?.['data-cl-state'] === 'zero'
      && node.props?.['data-cl-row'] === undefined)
    if (row.props['data-cl-state'] === 'used') {
      assert.equal(zeroChips.length, 0, '本会话拿不到时，非零调用行不得出现任何零调用徽标')
    } else {
      assert.equal(zeroChips.length, 1, '窗口口径的真零调用仍然只用零调用徽标')
      assert.equal(textOf(zeroChips[0]), ZH('cl.neverCalled'))
    }
  }
  const zeroBlockRows = nodesOf(blockOf(outside.nodes, 'zero-call'))
    .filter((node) => node.props?.['data-cl-row'] !== undefined)
  assert.equal(zeroBlockRows.filter((row) => row.props['data-cl-state'] === 'zero').length,
    outsideWindowReport().findings.zeroCall.length, '零调用段只含宿主给的零调用项')
  // 覆盖会话数是**另一个**通道：本会话拿不到，不影响它照实呈现
  const coverage = nodesOf(missing).find((node) => node.props?.['data-cl-coverage'] !== undefined)
  assert.equal(coverage.props['data-cl-coverage'], '2')

  // ③ 总览：null ⇒ 不可判定（不是 0），并给出原因；且与"有数"时的样式不同
  const summary = outside.nodes.find((node) => node.props?.['data-cl-current-session-summary'] !== undefined)
  const total = nodesOf(summary).find((node) => node.props?.['data-cl-current-session-total'] !== undefined)
  assert.equal(total.props['data-cl-current-session-total'], 'unavailable')
  assert.equal(textOf(total), ZH('cl.currentSessionUnknown'))
  const knownTotal = nodesOf(zeros.nodes.find((node) => node.props?.['data-cl-current-session-summary'] !== undefined))
    .find((node) => node.props?.['data-cl-current-session-total'] !== undefined)
  assert.equal(knownTotal.props['data-cl-current-session-total'], 'value')
  assert.equal(textOf(knownTotal), '47')
  assert.notEqual(total.props.style.fontSize, knownTotal.props.style.fontSize,
    '"不可判定"与"有数"必须用不同字号/样式（未知不得长得像数字）')
  assert.equal(textOf(nodesOf(summary).find((node) => node.props?.['data-cl-current-session-reason'] !== undefined)),
    ZH('cl.currentSessionOutsideWindow'))

  // ④ 会话身份拿不到（basis: "unavailable"）：仍然不可判定、仍然不显示 0，且绝不显示 id
  const unknown = renderExpanded(unknownSessionReport(), 'tools')
  const unknownSummary = unknown.nodes.find((node) => node.props?.['data-cl-current-session-summary'] !== undefined)
  const basis = nodesOf(unknownSummary).find((node) => node.props?.['data-cl-current-session-basis'] !== undefined)
  assert.equal(basis.props['data-cl-current-session-basis'], 'unavailable', '身份来源必须如实呈现')
  assert.equal(textOf(nodesOf(unknownSummary).find((node) => node.props?.['data-cl-current-session-total'] !== undefined)),
    ZH('cl.currentSessionUnknown'))
  for (const view of [zeros, outside, unknown]) {
    assert.equal(view.text.includes('1f0a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8'), false,
      '§2.26.5 第 6 条：会话 id 是标识，不得上屏（不当标题/用户名）')
  }

  // ⑤ 降级态（usageAvailable === false）：observedCalls=0 与"本会话不可判定"都必须如实
  const degraded = renderPanel(degradedReport())
  assert.equal(degraded.text.includes('本会话 0'), false, '降级态不得把"没有证据"渲染成本会话 0 次')
  assert.ok(textOf(degraded.nodes.find((node) => node.props?.['data-cl-current-session-summary'] !== undefined))
    .includes(ZH('cl.currentSessionUnknown')), '降级态的总览本会话数必须是"不可判定"')

  // ⑥ 面板不承载任意宿主串：basis 不匹配契约形状时按 unavailable 处理，原字符串绝不上屏
  const hostile = outsideWindowReport()
  const HOSTILE = '<img src=x onerror=alert(1)>' + 'x'.repeat(200)
  hostile.scope = { ...hostile.scope, currentSession: { id: null, basis: HOSTILE, inWindow: false } }
  const safe = renderPanel(hostile)
  assert.equal(safe.text.includes(HOSTILE), false, '宿主给的任意串不得上屏')
  const safeBasis = safe.nodes.find((node) => node.props?.['data-cl-current-session-basis'] !== undefined)
  assert.equal(safeBasis.props['data-cl-current-session-basis'], 'unavailable')
})

test('I3. §4.9 第 5 条 + §4.4 三行新状态：三态一眼可辨，只有 absent 用零调用样式', () => {
  const { nodes } = renderExpanded(canonicalReport(), 'tools')

  const current = detailRowOf(nodes, 'tools:context_ledger')
  const historical = detailRowOf(nodes, 'tools:agent_teams_claim_task')
  const absent = detailRowOf(nodes, 'tools:task_board_list')

  // ① 三态取值互异且恰好取契约里的三个值
  assert.deepEqual(plain([current, historical, absent].map((row) => row.props['data-cl-presence'])),
    ['current-session', 'historical-only', 'absent'])
  assert.deepEqual(plain(V.PRESENCE_VALUES), ['current-session', 'historical-only', 'absent'])

  // ② 每态有自己的徽标/文案（不是堆三个数字让人自己算）
  const badgeOf = (row) => nodesOf(row).find((node) => node.props?.['data-cl-presence'] !== undefined
    && node.props?.['data-cl-row'] === undefined)
  const currentBadge = badgeOf(current)
  const historicalBadge = badgeOf(historical)
  assert.equal(textOf(currentBadge), ZH('cl.presence.currentSession'))
  assert.equal(textOf(historicalBadge), ZH('cl.presence.historicalOnly'))
  const histSession = nodesOf(historical).find((node) => node.props?.['data-cl-current-session'] !== undefined)
  const histCoverage = nodesOf(historical).find((node) => node.props?.['data-cl-coverage'] !== undefined)
  assert.equal(textOf(histSession), ZH('cl.currentSessionCalls') + ' 0', '历史会话用过 ⇒ 本会话数是 0（有证据的 0）')
  assert.equal(textOf(histCoverage), ZH('cl.sessionCoverage', { n: '2', scanned: '20' }))
  /* absent 态**复用**零调用徽标（cl.neverCalled）——同一行里不重复画第二个琥珀标记 */
  assert.ok(textOf(absent).includes(ZH('cl.neverCalled')), 'absent 必须用零调用徽标')
  assert.equal(nodesOf(absent).filter((node) => node.props?.['data-cl-presence'] !== undefined
    && node.props?.['data-cl-row'] === undefined).length, 0,
  'absent 不再另画一个琥珀徽标（§4.4 v4 硬规则③：同一行不得出现两个「0 次」标记）')

  // ③ 视觉可区分：三态颜色两两不同，且 only absent 是琥珀
  const colors = ['current-session', 'historical-only', 'absent'].map((state) => V.presenceColor(state))
  assert.equal(new Set(colors).size, 3, '三态颜色必须两两不同')
  assert.equal(V.presenceColor('absent'), V.chipColor('zero'), 'absent 用零调用色')
  assert.notEqual(V.presenceColor('historical-only'), V.chipColor('zero'), 'historical-only 绝不能用零调用色')
  assert.notEqual(V.presenceColor('current-session'), V.chipColor('zero'), 'current-session 绝不能用零调用色')
  assert.equal(historicalBadge.props.style.color, V.presenceColor('historical-only'))
  assert.equal(currentBadge.props.style.color, V.presenceColor('current-session'))
  assert.equal(/state-error-primary|state-warn-primary/.test(JSON.stringify(historicalBadge.props.style)), false,
    'historical-only 不得带告警样式')

  // ④ 三态行的可见文本互不相同（"一眼可辨"的最强形式）
  const texts = [current, historical, absent].map((row) => textOf(row))
  assert.equal(new Set(texts).size, 3)
  // historical-only 不得被读成零调用：它不进 findings.zeroCall，也不该出现「0 次」以外让人误会的东西
  assert.equal(texts[1].includes(ZH('cl.neverCalled')), false, 'historical-only 绝不用零调用徽标')
  assert.equal(nodesOf(historical).filter((node) => node.props?.['data-cl-state'] === 'zero').length, 0)
})

test('I4. §4.9 第 2 条 + §2.2：窗口边界常驻两段，让"零调用"有明确参照系', () => {
  const report = canonicalReport()
  const { nodes, text } = renderPanel(report)

  // ① 总览段与零调用段**都**有窗口声明行，且都带 sessionsScanned/available + 窗口区间 + windowBasis
  const scopes = nodes.filter((node) => node.props?.['data-cl-window-scope'] !== undefined)
  assert.deepEqual(plain(scopes.map((node) => node.props['data-cl-window-scope'])), ['overview', 'zero-call'],
    '两个承载位置的窗口声明行都得在（§4.2 第 2/3 段）')
  const expectWindow = ZH('cl.windowScope', {
    scanned: '20', available: '41',
    start: localStamp(report.scope.windowStart), end: localStamp(report.scope.windowEnd),
    basis: 'session-log-mtime',
  })
  for (const node of scopes) {
    assert.equal(textOf(node), expectWindow, '窗口声明必须同时给出扫描数/总数、窗口区间与边界来源')
  }
  // 窗口边界与 windowBasis 一起呈现（§5 v4 第 4 条：否则会被读成日志内的事件时间）
  assert.ok(expectWindow.includes('session-log-mtime'))
  assert.ok(expectWindow.includes(localStamp(report.scope.windowStart)))
  assert.equal(V.windowScopeOf(report).basis, 'session-log-mtime')

  // ② 窗口外会话数：> 0 必须追加一行；= 0 不得出现
  const omitted = nodes.filter((node) => node.props?.['data-cl-window-omitted'] !== undefined)
  assert.deepEqual(plain(omitted.map((node) => node.props['data-cl-window-omitted'])), ['overview', 'zero-call'])
  for (const node of omitted) {
    assert.equal(textOf(node), ZH('cl.windowOmitted', { n: '21' }))
  }
  const inside = renderPanel({ ...report, scope: { ...report.scope, sessionsOutsideWindow: 0 } })
  assert.equal(inside.nodes.filter((node) => node.props?.['data-cl-window-omitted'] !== undefined).length, 0,
    'sessionsOutsideWindow = 0 时不追加那一行')

  // ③ 窗口声明常驻零调用段**段底**、不可折叠、不做 tooltip（§4.9 第 2 条）
  const zeroBlock = blockOf(nodes, 'zero-call')
  const last = zeroBlock.props.children[zeroBlock.props.children.length - 1]
  assert.equal(last.props['data-cl-window-omitted'], 'zero-call', '零调用段最后一行就是窗口声明')
  for (const node of scopes.concat(omitted)) {
    assert.equal(node.type, 'p', '窗口声明是普通段落（不是按钮/折叠容器）')
    assert.equal(node.props.title, undefined, '不得收进 tooltip')
    assert.equal(node.props.onClick, undefined, '不得可折叠')
    assert.equal(/state-error-primary/.test(JSON.stringify(node.props.style)), false, '窗口边界不是告警')
  }
  assert.ok(textOf(zeroBlock).includes(ZH('cl.windowScope', {
    scanned: '20', available: '41',
    start: localStamp(report.scope.windowStart), end: localStamp(report.scope.windowEnd),
    basis: 'session-log-mtime',
  })), '零调用段自己就带着参照系')

  // ④ 降级态（没有窗口）也照常给出窗口口径，且不泄漏 undefined/NaN
  const degraded = renderPanel(degradedReport())
  assert.equal(degraded.nodes.filter((node) => node.props?.['data-cl-window-scope'] !== undefined).length, 2,
    '没有窗口不等于没有窗口口径（§2.12 ④）')
  assert.equal(degraded.text.includes('undefined'), false)
  assert.equal(degraded.text.includes('NaN'), false)
  assert.ok(textOf(degraded.nodes.find((node) => node.props?.['data-cl-window-scope'] !== undefined))
    .includes(ZH('cl.unknown')), '没有窗口时区间如实写成未知，不编造时刻')
})

test('I5. 字号对齐 DSH token 阶梯 + 行高同步（IMPLEMENTATION-NOTES 界面决定备案）', () => {
  // ① 不得再出现硬编码像素字号（硬编码不会跟随主题/字号缩放）
  assert.equal(/fontSize:\s*[0-9]/.test(CLIENT_SRC), false, '不得硬编码像素字号')
  assert.equal(/fontSize:\s*'[0-9]/.test(CLIENT_SRC), false, '不得写死字符串字号')

  // ② 五档 token 都在场、都带 fallback
  for (const token of ['xxxs-11', 'xxs-12', 'xs-13', 's-14', 'l-20']) {
    assert.ok(CLIENT_SRC.includes(`var(--dsw-font-${token}-font-size, `), `缺 token ${token} 的字号变量`)
  }
  const fallback = (value) => Number(/,\s*([0-9.]+)px\)$/.exec(value)[1])
  assert.equal(fallback(V.FONT_SIZES.xxxs11), 11)
  assert.equal(fallback(V.FONT_SIZES.xxs12), 12, '主力档 = 12px（对齐 dsh-annotate 的正文基准）')
  assert.equal(fallback(V.FONT_SIZES.xs13), 13)
  assert.equal(fallback(V.FONT_SIZES.s14), 14)
  assert.equal(fallback(V.FONT_SIZES.l20), 20)
  for (const value of Object.values(V.FONT_SIZES)) {
    assert.ok(fallback(value) >= 11, '面板不得再出现低于宿主最小档（11px）的字号')
  }

  // ③ 用量分布：主力是 12px 档，且 12/13 档压过 11px 档（正文基准不再低于 annotate）
  const count = (needle) => (CLIENT_SRC.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length
  const sizes = { xxxs11: count('fontSize: FS.xxxs11'), xxs12: count('fontSize: FS.xxs12'), xs13: count('fontSize: FS.xs13') }
  assert.ok(sizes.xxs12 >= 18, `主力档（12px）至少 18 处，实际 ${sizes.xxs12}`)
  assert.ok(sizes.xs13 >= 11, `次级档（13px）至少 11 处，实际 ${sizes.xs13}`)
  assert.ok(sizes.xxxs11 >= 9, `小标签档（11px）至少 9 处，实际 ${sizes.xxxs11}`)
  assert.ok(Math.max(sizes.xxs12, sizes.xs13) === sizes.xxs12, '12px 是主力档')
  assert.ok(sizes.xxs12 + sizes.xs13 > sizes.xxxs11, '正文基准档应多于最低档')
  assert.equal(count('fontSize: FS.l20'), 1, '总览数字（20px）保持')

  // ④ 行高同步：渲染出来的每个带字号的节点都必须同时带行高（20px 数字档用紧排比例）
  const sizesOf = Object.values(V.FONT_SIZES)
  const lineHeightsOf = Object.values(V.FONT_LINE_HEIGHTS)
  for (const [label, report] of [['§2.9 v4', canonicalReport()], ['§2.21 R6', r6Report()], ['§2.12 降级', degradedReport()]]) {
    const { nodes } = renderPanel(report)
    let checked = 0
    for (const node of nodes) {
      const style = node.props?.style
      if (style === undefined || style.fontSize === undefined) continue
      checked += 1
      assert.ok(sizesOf.includes(style.fontSize), `${label}：字号必须是宿主 token，实际 ${style.fontSize}`)
      if (style.fontSize === V.FONT_SIZES.l20) {
        assert.equal(typeof style.lineHeight, 'number', `${label}：20px 数字档用紧排比例行高`)
        continue
      }
      assert.ok(lineHeightsOf.includes(style.lineHeight),
        `${label}：字号 ${style.fontSize} 必须同步行高 token，实际 ${style.lineHeight}`)
      assert.equal(style.lineHeight, V.FONT_LINE_HEIGHTS[/xxxs-11|xxs-12|xs-13|s-14/.exec(style.fontSize)[0]
        .replace('xxxs-11', 'xxxs11').replace('xxs-12', 'xxs12').replace('xs-13', 'xs13').replace('s-14', 's14')],
      `${label}：字号与行高必须同档`)
    }
    assert.ok(checked >= 15, `${label}：带字号的渲染节点样本太少（${checked}）`)
  }

  // ⑤ 定点：标题 14px/22px、条目名 13px/20px、总览数字 20px、徽标 11px/14px
  const { nodes } = renderExpanded(canonicalReport(), 'tools')
  const title = nodes.find((node) => textOf(node) === ZH('cl.title'))
  assert.equal(title.props.style.fontSize, V.FONT_SIZES.s14)
  assert.equal(title.props.style.lineHeight, V.FONT_LINE_HEIGHTS.s14)
  const row = detailRowOf(nodes, 'tools:context_ledger')
  const nameCell = nodesOf(row).find((node) => node.props?.['data-cl-row'] === undefined && node.props?.style?.fontSize === V.FONT_SIZES.xs13)
  assert.ok(nameCell !== undefined, '条目名用 13px 档')
  const statNumber = nodes.find((node) => textOf(node) === '4,460' && node.props?.style?.fontSize !== undefined)
  assert.equal(statNumber.props.style.fontSize, V.FONT_SIZES.l20)
  const sessionFigure = nodesOf(row).find((node) => node.props?.['data-cl-current-session'] !== undefined)
  assert.equal(sessionFigure.props.style.fontSize, V.FONT_SIZES.xxxs11)
  assert.equal(sessionFigure.props.style.lineHeight, V.FONT_LINE_HEIGHTS.xxxs11)
})

test('I6. 措辞红线（§6 第 10/11/12 条）：新增文案与属性型文本一并穷举，且无危险色', () => {
  /** v4 新增文案与既有文案共用同一份红线（"浪费/建议卸载/从未使用"类确定性措辞）。 */
  const FORBIDDEN = [
    '无用', '浪费', '可以删掉', '建议卸载', '应该删除', '值得删除', '该删',
    '从未使用', '从来没用过', '从未用过', '建议隐藏', '安全隐藏', '安全移除',
    '零损失', '零功能损失', '无副作用', '放心删', '只影响模型',
    'never used', 'never been used', 'worthless', 'wasted', 'safe to delete', 'safe to hide',
    'safe to remove', 'recommend removing', 'should be uninstalled', 'you should remove',
    'no side effects', 'zero loss', 'removable', 'no longer used',
  ]
  const views = [
    ['§2.9 v4', canonicalReport()],
    ['§2.9 本会话不在窗口内', outsideWindowReport()],
    ['§2.9 身份不可得', unknownSessionReport()],
    ['§2.21 R6', r6Report()],
    ['§2.12 降级', degradedReport()],
  ]
  for (const [label, report] of views) {
    for (const [lang, dict] of Object.entries(V.dictionaries)) {
      const { nodes, text } = renderPanel(report, dictionaryT(dict))
      for (const bad of FORBIDDEN) {
        assert.equal(text.includes(bad), false, `${label}/${lang}：整屏不得出现「${bad}」`)
      }
      // 属性型文本（title / aria-label）同样纳入穷举：不得把危险措辞藏进 tooltip
      for (const node of nodes) {
        for (const attr of ['title', 'aria-label']) {
          const value = node.props?.[attr]
          if (typeof value !== 'string') continue
          for (const bad of FORBIDDEN) {
            assert.equal(value.includes(bad), false, `${label}/${lang}：属性 ${attr} 不得含「${bad}」`)
          }
          assert.equal(HIDE_IMPERATIVE.test(value), false, `${label}/${lang}：属性 ${attr} 不得是命令式建议`)
        }
      }
    }
    // 词典本身（两种语言）也不得含红线词
    for (const [lang, dict] of Object.entries(V.dictionaries)) {
      for (const [key, value] of Object.entries(dict)) {
        for (const bad of FORBIDDEN) {
          assert.equal(value.includes(bad), false, `词典 ${lang}/${key} 不得含「${bad}」`)
        }
      }
    }
  }

  /* 「没用」一词只允许出现在固定的否定式声明里（§4.7 第 3 条的"不代表没用"），
   * 不得作为结论出现在任何其它位置——这是 §6 第 10 条最容易被顺手写坏的一处。 */
  for (const [label, report] of views) {
    const { text } = renderPanel(report, ZH)
    for (const match of text.matchAll(/没用/g)) {
      assert.equal(text.slice(Math.max(0, match.index - 3), match.index), '不代表',
        `${label}：「没用」只能出现在否定式声明里`)
    }
  }

  // v4 节点一律不使用危险红/告警色（"unknown" 与"零调用"都不是危害）
  const { nodes } = renderExpanded(canonicalReport(), 'tools')
  const v4Nodes = nodes.filter((node) => Object.keys(node.props ?? {}).some((key) => /^data-cl-(window|presence|current-session|coverage)/.test(key)))
  assert.ok(v4Nodes.length >= 10, 'v4 节点样本应充足')
  for (const node of v4Nodes) {
    assert.equal(/state-error-primary/.test(JSON.stringify(node.props.style)), false,
      `v4 节点不得使用危险色：${JSON.stringify(node.props.style)}`)
  }
})

test('I7. §4.9 第 6 条：三态不扩张清单口径——historical-only 不进三段，但也不被面板筛掉', () => {
  const report = canonicalReport()
  const { nodes } = renderPanel(report)

  // ① 零调用段：每行都必须是 absent（zeroCall ⟺ absent，§2.26.4 I7）
  const zeroRows = nodesOf(blockOf(nodes, 'zero-call')).filter((node) => node.props?.['data-cl-row'] !== undefined)
  assert.equal(zeroRows.length, report.findings.zeroCall.length, '零调用段行数恒等于宿主给的 findings.zeroCall')
  assert.deepEqual([...new Set(zeroRows.map((row) => row.props['data-cl-presence']))], ['absent'])
  assert.equal(textOf(blockOf(nodes, 'zero-call')).includes('agent_teams_claim_task'), false,
    'historical-only 绝不出现在零调用段（它不是零调用）')

  // ② 每次使用最贵段：historical-only 的项**必须**照旧出现（面板不按三态筛选，§4.9 第 6 条）
  const topRows = nodesOf(blockOf(nodes, 'top-per-use')).filter((node) => node.props?.['data-cl-row'] !== undefined)
  assert.equal(topRows.length, report.findings.topPerUse.length)
  const historicalRow = topRows.find((row) => row.props['data-cl-presence'] === 'historical-only')
  assert.ok(historicalRow !== undefined, 'historical-only 的项在「每次使用最贵」里不得被筛掉')
  assert.ok(textOf(historicalRow).includes('agent_teams_claim_task'))

  // ③ 裁剪候选 / 可隐藏候选段的入组条件仍是 zeroCall === true：两段都不含该工具
  const pruneText = textOf(blockOf(nodes, 'prune-plan'))
  assert.equal(pruneText.includes('agent_teams_claim_task'), false)
  assert.equal(V.pruneEntries(report).some((entry) => (entry.items ?? []).some((item) => item.name === 'agent_teams_claim_task')), false)
  assert.equal(V.hideEntries(r6Report()).some((entry) => String(entry.name) === 'agent_teams_claim_task'), false)
  assert.equal(V.hideEntries(r6Report()).length, r6Report().findings.hidePlan.length, '可隐藏候选段不筛选宿主给的清单')
})

test('I8. §4.9 在两个承载位置都适用：v4 节点与文本在两位置逐字相同', () => {
  const report = canonicalReport()
  const expanded = { mode: 'popover' }
  const popover = renderExpanded(report, 'tools', ZH, expanded)
  const sidebar = renderExpanded(report, 'tools', ZH, { mode: 'sidebar' })
  assert.equal(v4Signature(sidebar.nodes), v4Signature(popover.nodes),
    'v4 的窗口/本会话/三态/覆盖节点在两承载位置必须一模一样（右侧栏不是简版）')
  assert.ok(v4Signature(popover.nodes).length > 0)
  const panel = sidebar.nodes.find((node) => node.props?.['data-cl-panel'] !== undefined)
  assert.equal(panel.props['data-cl-mode'], 'sidebar')
})

test('I9. 面板文案实况（人读用）：R8 的窗口口径 / 本会话 / 三态逐行打印', () => {
  const lines = []
  const push = (label, node) => lines.push(`${label}: ${textOf(node).replace(/\s+/g, ' ').trim()}`)

  const report = canonicalReport()
  const { nodes } = renderPanel(report)
  push('[窗口口径 · 总览]', nodes.find((node) => node.props?.['data-cl-window-scope'] === 'overview'))
  push('[窗口外会话 · 总览]', nodes.find((node) => node.props?.['data-cl-window-omitted'] === 'overview'))
  push('[窗口口径 · 零调用段]', nodes.find((node) => node.props?.['data-cl-window-scope'] === 'zero-call'))
  push('[窗口外会话 · 零调用段]', nodes.find((node) => node.props?.['data-cl-window-omitted'] === 'zero-call'))
  push('[本会话调用 · 总览]', nodes.find((node) => node.props?.['data-cl-current-session-summary'] !== undefined))
  push('[零调用段标题]', nodes.find((node) => String(node.props?.key) === 'title' && textOf(node).includes(ZH('cl.zeroCallTitle'))))

  const expanded = renderExpanded(report, 'tools')
  for (const [label, id] of [
    ['current-session', 'tools:context_ledger'],
    ['historical-only', 'tools:agent_teams_claim_task'],
    ['absent', 'tools:task_board_list'],
  ]) {
    push(`[逐项 ${label}]`, detailRowOf(expanded.nodes, id))
  }

  const outside = renderPanel(outsideWindowReport())
  push('[不可得 · 总览]', outside.nodes.find((node) => node.props?.['data-cl-current-session-summary'] !== undefined))
  push('[不可得 · 逐项]', detailRowOf(renderExpanded(outsideWindowReport(), 'tools').nodes, 'tools:context_ledger'))

  const unknown = renderPanel(unknownSessionReport())
  push('[身份不可得 · 总览]', unknown.nodes.find((node) => node.props?.['data-cl-current-session-summary'] !== undefined))

  push('[字号 · 主档]', nodesOf(nodes.find((node) => node.props?.['data-cl-row'] !== undefined))[0])
  lines.push(`[字号 · 五档] ${Object.entries(V.FONT_SIZES).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  lines.push(`[行高 · 四档] ${Object.entries(V.FONT_LINE_HEIGHTS).map(([k, v]) => `${k}=${v}`).join(' ')}`)

  console.log(lines.join('\n'))
  assert.ok(lines.length >= 13)
})

/* ══════════════════════════════════════════════════════════════════════════
 * J 组：契约夹具的**机械保真**与**防漂移指纹**（C4 + C5，R8 / t6）
 *
 * 背景：§2.9 / §2.21 的合成示例是**被测试机械抽取**的契约数据。VERIFY-T17 §8.1 曾做过一次
 * 「解析 DESIGN 的 jsonc 与夹具逐字段比对 → 13/13 SAME」，但那是一次**人工**核验，会静默过期
 * （VERIFY-T17 §385 的建议）。这里把那次比对变成**常驻测试**：
 *   ① 从 `DESIGN.md` 现场解析 jsonc 块 → 与夹具 deepEqual（漂移立刻显式变红，且打印差异路径）；
 *   ② **内容指纹**（sha256 of canonical JSON）钉死（C5）→ 连"改了但恰好等值"的编辑也会被发现；
 *   ③ A18（§2.19 的升序 / 去重 / ≤3）在 DESIGN 与夹具**两份数据**上都被机械检查，
 *      并与 `lib/hide.js` 的**实际行为**（`buildHidePlan` 喂乱序输入）对照——同类违规下次会被拦住。
 * ══════════════════════════════════════════════════════════════════════════ */

/** `DESIGN.md` 原文：夹具保真比对的唯一真源（只读）。 */
const DESIGN_SRC = readFileSync(join(REPO, 'docs', 'DESIGN.md'), 'utf8')

/** 从某个小节标题之后抽出第一个 ```jsonc 代码块并解析（解析失败即显式失败，不静默跳过）。 */
function designJsoncBlock(sectionMarker) {
  const start = DESIGN_SRC.indexOf(sectionMarker)
  assert.ok(start > 0, `DESIGN.md 里找不到小节：${sectionMarker}`)
  const fence = DESIGN_SRC.indexOf('```jsonc', start)
  assert.ok(fence > 0, `${sectionMarker} 之后找不到 jsonc 代码块`)
  const end = DESIGN_SRC.indexOf('```', fence + '```jsonc'.length)
  assert.ok(end > fence, `${sectionMarker} 的 jsonc 代码块未闭合`)
  const body = DESIGN_SRC.slice(fence + '```jsonc'.length, end)
  try {
    return JSON.parse(body)
  } catch (error) {
    throw new Error(`${sectionMarker} 的 jsonc 块不是合法 JSON：${error.message}`)
  }
}

/** 递归排序键后的规范形式：指纹只取决于内容，与键序 / 缩进 / 空白无关。 */
function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value !== null && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = canonicalJson(value[key])
      return out
    }, {})
  }
  return value
}

/** 内容指纹：canonical JSON 的 sha256（数组顺序**参与**指纹——排序违规会直接改指纹）。 */
function fingerprintOf(value) {
  return createHash('sha256').update(JSON.stringify(canonicalJson(value))).digest('hex')
}

/**
 * §2.21 契约块的**内容指纹**（C5）。
 *
 * 它是**有意的闸门**：`DESIGN.md` §2.21 或 `R6_EXAMPLE` 夹具只要漂移一个字节（含数组顺序），
 * J2 就会失败并打印本常量与两侧实际值。若漂移是**有意的契约变更**，必须同一步更新：
 * ① `DESIGN.md` §2.21、② 本文件的 `R6_EXAMPLE`、③ 本常量。
 *
 * 2026-10-08：发布前的路径脱敏把示例中的本机绝对路径换成通用路径，DESIGN 与夹具同步改写
 * （J1 仍 13/13 SAME），指纹随之更新。
 */
const SECTION_21_FINGERPRINT = '0f497be8b3ec8785eaa1e914aed558c37e31e069a8dd72656911439ce6e9bea7'

/** 逐字段差异（返回人类可读的路径清单；失败信息里直接给出，避免"只知道不相等"）。 */
function describeDiffs(design, fixture, path) {
  const where = path ?? '§2.21'
  const out = []
  if (Array.isArray(design) && Array.isArray(fixture)) {
    if (design.length !== fixture.length) out.push(`${where}: 长度 DESIGN=${design.length} 夹具=${fixture.length}`)
    for (let i = 0; i < Math.min(design.length, fixture.length); i++) {
      out.push(...describeDiffs(design[i], fixture[i], `${where}[${i}]`))
    }
    return out
  }
  if (design !== null && fixture !== null && typeof design === 'object' && typeof fixture === 'object') {
    for (const key of [...new Set([...Object.keys(design), ...Object.keys(fixture)])]) {
      if (!(key in design)) out.push(`${where}.${key}: 仅夹具有（${JSON.stringify(fixture[key])}）`)
      else if (!(key in fixture)) out.push(`${where}.${key}: 仅 DESIGN 有（${JSON.stringify(design[key])}）`)
      else out.push(...describeDiffs(design[key], fixture[key], `${where}.${key}`))
    }
    return out
  }
  if (JSON.stringify(design) !== JSON.stringify(fixture)) {
    out.push(`${where}: DESIGN=${JSON.stringify(design)} 夹具=${JSON.stringify(fixture)}`)
  }
  return out
}

test('J1. C4-夹具保真：DESIGN §2.21 与 R6_EXAMPLE 机械逐字段一致（13/13 SAME）', () => {
  const design = designJsoncBlock('### 2.21 R6 完整示例')
  const fixture = R6_EXAMPLE

  /* 13 个比对组：与 VERIFY-T17 §8.1 那次人工核验的口径同构，逐组打印 SAME/DIFF。 */
  const groups = [
    ['tool / unit / version', (o) => ({ tool: o.tool, unit: o.unit, version: o.version })],
    ['items（24 项逐字段）', (o) => o.items],
    ['hidePlanTokens', (o) => o.findings.hidePlanTokens],
    ['hidePlanBasis', (o) => o.findings.hidePlanBasis],
    ['hidePlanStatus', (o) => o.findings.hidePlanStatus],
    ['hidePlan 条数 / 名字序列 / 各 tokens', (o) => o.findings.hidePlan],
    ['hidePlanUnits', (o) => o.findings.hidePlanUnits],
    ['hideApply', (o) => o.findings.hideApply],
    ['hidePlanCaveat', (o) => o.findings.hidePlanCaveat],
    ['prunePlan', (o) => o.findings.prunePlan],
    ['prunePlanReclaimableTokens', (o) => o.findings.prunePlanReclaimableTokens],
    ['zeroCallBasis', (o) => o.findings.zeroCallBasis],
    ['noRecommendation', (o) => o.findings.noRecommendation],
  ]
  const report = []
  for (const [label, pick] of groups) {
    const diffs = describeDiffs(pick(design), pick(fixture), label)
    report.push(`${diffs.length === 0 ? 'SAME' : 'DIFF'}  ${label}`)
    assert.deepEqual(diffs, [], `§2.21 契约与夹具漂移（${label}）：\n  ${diffs.join('\n  ')}`)
  }
  /* 整块 deepEqual：比 13 组更强——任何**未列入组**的字段漂移也会被发现。 */
  const whole = describeDiffs(design, fixture, '§2.21(整块)')
  assert.deepEqual(whole, [], `§2.21 整块漂移：\n  ${whole.join('\n  ')}`)
  const same = report.filter((line) => line.startsWith('SAME')).length
  assert.equal(same, 13, '13 个比对组必须全部 SAME')
  console.log('=== DESIGN §2.21 vs R6_EXAMPLE 逐字段比对 ===\n  ' + report.join('\n  ')
    + `\n  （整块 deepEqual：${whole.length} 处差异）⇒ ${same}/13 SAME`)
})

test('J2. C5-防漂移指纹：DESIGN §2.21 与夹具的内容指纹必须等于钉死值', () => {
  const design = designJsoncBlock('### 2.21 R6 完整示例')
  const actualDesign = fingerprintOf(design)
  const actualFixture = fingerprintOf(R6_EXAMPLE)

  const drifted = (side, actual) => `DESIGN §2.21 ${side} 的内容指纹漂移了。\n`
    + `  期望（钉死）：${SECTION_21_FINGERPRINT}\n  实际：        ${actual}\n`
    + '这是 C5 的**有意闸门**：若这是有意的契约变更，请**同一步**更新 '
    + '① DESIGN.md §2.21 的示例、② test/client-panel.test.mjs 的 R6_EXAMPLE 夹具、'
    + '③ 本文件的 SECTION_21_FINGERPRINT 常量（并跑 J1/J3）；若不是有意变更，请还原。'

  assert.equal(actualDesign, SECTION_21_FINGERPRINT, drifted('DESIGN 示例', actualDesign))
  assert.equal(actualFixture, SECTION_21_FINGERPRINT, drifted('测试夹具', actualFixture))

  // 指纹机制自检（证明它不是装饰）：值一变必变、数组顺序一变必变
  const mutated = JSON.parse(JSON.stringify(design))
  mutated.findings.hidePlanTokens += 1
  assert.notEqual(fingerprintOf(mutated), SECTION_21_FINGERPRINT, '值改动必须改变指纹')
  const reordered = JSON.parse(JSON.stringify(design))
  const subagent = reordered.findings.hidePlan.find((entry) => entry.name === 'subagent')
  subagent.registryUse.nameReferencedElsewhere.reverse()
  assert.notEqual(fingerprintOf(reordered), SECTION_21_FINGERPRINT,
    '数组顺序改动（正是 C4 的那类违规）必须改变指纹')

  // 键序 / 缩进不参与指纹（否则改格式就误报，闸门会变成噪音）
  const reshaped = {}
  for (const key of Object.keys(design).reverse()) reshaped[key] = design[key]
  assert.equal(fingerprintOf(reshaped), SECTION_21_FINGERPRINT)
  console.log(`=== §2.21 内容指纹 ===\n  DESIGN / 夹具 / 钉死值 = ${SECTION_21_FINGERPRINT.slice(0, 16)}…（三者一致）`)
})

test('J3. C4-清单 A18：nameReferencedElsewhere 升序去重且 ≤3（DESIGN 与夹具同时受检）', () => {
  const design = designJsoncBlock('### 2.21 R6 完整示例')
  const evidence = []

  for (const [label, block] of [['DESIGN §2.21', design], ['R6_EXAMPLE', R6_EXAMPLE]]) {
    const entries = block.findings.hidePlan
    assert.equal(entries.length, 24, `${label}: hidePlan 应为 24 条`)
    for (const entry of entries) {
      const list = entry.registryUse.nameReferencedElsewhere
      assert.ok(Array.isArray(list), `${label}/${entry.name}: 必须是数组`)
      assert.ok(list.length <= 3, `${label}/${entry.name}: 长度必须 ≤3（§2.19 / A18）`)
      assert.deepEqual([...list], [...list].sort(),
        `${label}/${entry.name}: 必须升序（§2.19 / A18；默认 sort = 码元序）`)
      assert.deepEqual([...list], [...new Set(list)], `${label}/${entry.name}: 必须去重（A18）`)
      for (const filePath of list) {
        assert.match(filePath, /^\//, `${label}/${entry.name}: 弱命中必须是绝对路径`)
      }
    }
    const nonEmpty = entries.filter((entry) => entry.registryUse.nameReferencedElsewhere.length > 0)
    assert.deepEqual(plain(nonEmpty.map((entry) => entry.name)), ['subagent'],
      `${label}: 示例中唯一非空项应是 subagent（A18 的取证点）`)
    evidence.push(`${label}: ${nonEmpty[0].registryUse.nameReferencedElsewhere
      .map((filePath) => filePath.slice(filePath.indexOf('node_modules/'))) 
      .join(' → ')}`)
  }

  /* A18 的取证点被钉住：C4 修正后的升序必须是 @linxin666/… 先于 @nanmicoder/… */
  const subagent = design.findings.hidePlan.find((entry) => entry.name === 'subagent')
  assert.ok(subagent.registryUse.nameReferencedElsewhere[0].includes('@linxin666/dsh-session-archive'),
    'C4 修正后的 §2.21 示例：@linxin666/… 必须排在 @nanmicoder/… 之前（升序）')
  assert.ok(subagent.registryUse.nameReferencedElsewhere[1].includes('@nanmicoder/dsh-agent-teams'))

  /* 与**实现侧实际行为**对照（A18 不得写一条实现做不到的断言）：
   * `lib/hide.js` 的 `uniqueSorted(weakEvidence[name]).slice(0, NAME_REFERENCED_LIMIT)`。 */
  assert.equal(NAME_REFERENCED_LIMIT, 3, 'A18 的 ≤3 必须等于实现侧的 NAME_REFERENCED_LIMIT')
  const scrambled = ['/z/last.js', '/a/first.js', '/m/middle.js', '/a/first.js', '/b/second.js']
  const built = buildHidePlan(
    [{
      id: 'tools:scrambled_tool', category: 'tools', name: 'scrambled_tool', tokens: 100, calls: 0,
      zeroCall: true, usageBasis: 'tool-calls', source: 'native',
      providedBy: { kind: 'core', name: null, confidence: 'high', method: 'static-scan', evidenceFile: null, candidates: [] },
    }],
    { byName: {}, bundleOwners: {}, weakEvidence: { scrambled_tool: scrambled } },
    { restrictableNames: ['scrambled_tool'], interfacePresent: true },
  )
  assert.equal(built.hidePlan.length, 1)
  assert.deepEqual(plain(built.hidePlan[0].registryUse.nameReferencedElsewhere),
    ['/a/first.js', '/b/second.js', '/m/middle.js'],
    'A18：实现把乱序 / 重复输入排成升序去重并截断到 3（实测行为与清单一致）')
  console.log('=== A18 升序取证 ===\n  ' + evidence.join('\n  ')
    + '\n  实现实测（乱序+重复输入）→ ' + JSON.stringify(plain(built.hidePlan[0].registryUse.nameReferencedElsewhere)))
})

test('J4. v4 下游漂移：DESIGN §2.9 与 canonicalReport 夹具逐字段一致', () => {
  const design = designJsoncBlock('### 2.9 完整示例 JSON')
  const fixture = canonicalReport()
  const diffs = describeDiffs(design, fixture, '§2.9')
  assert.deepEqual(diffs, [], `§2.9 契约与面板夹具漂移：\n  ${diffs.join('\n  ')}`)
  /* item 4 的两处定点（t1 的合成数据自洽修正）：两处副本都必须与 DESIGN 同值。 */
  assert.equal(fixture.scope.sessionsUnreadable, 0)
  assert.equal(fixture.scope.sessionsOutsideWindow, 21)
  assert.equal(fixture.scope.sessionsAvailable,
    fixture.scope.sessionsScanned + fixture.scope.sessionsUnreadable + fixture.scope.sessionsOutsideWindow,
    'W4：41 = 20 + 0 + 21')
  console.log('=== DESIGN §2.9 vs canonicalReport 逐字段比对 ===\n  SAME（0 处差异）'
    + `；sessionsUnreadable=${fixture.scope.sessionsUnreadable} / sessionsOutsideWindow=${fixture.scope.sessionsOutsideWindow}`)
})


