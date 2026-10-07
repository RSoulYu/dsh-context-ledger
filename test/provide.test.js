/**
 * lib/provide.js —— R1 归属（启发式）与裁剪候选清单。
 *
 * 覆盖三件事：
 *  1. `scanCorpus` 的强/弱匹配与**参照实现对拍**（逐个名字依次 `test` 的朴素写法）；
 *  2. §2.13 判定表 8 行的逐行落地（含"歧义必须记 unknown + candidates，不得猜测"）；
 *  3. §2.15/§2.16 的分组、排序、置信度取最弱一环、省额口径与 3 条不给动作的理由。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CANDIDATES_LIMIT,
  MCP_NAME_PATTERN,
  NO_RECOMMENDATION_REASONS,
  PACKAGE_PATTERN,
  PRUNE_PLAN_BASIS,
  attributeNames,
  buildPrunePlan,
  scanCorpus,
  strongPattern,
  unknownProvidedBy,
  weakPattern,
} from '../lib/provide.js'
import { NAME_PATTERN } from '../lib/usage.js'

/** 参照实现：逐个名字、依次 test 强级与弱级（与合并正则版必须等价）。 */
function referenceScan(corpus, names) {
  const strong = {}
  const weak = {}
  for (const name of names) {
    if (!NAME_PATTERN.test(name)) continue
    const strongRe = strongPattern(name)
    const weakRe = weakPattern(name)
    for (const [pkg, entries] of Object.entries(corpus)) {
      for (const entry of entries) {
        if (strongRe.test(entry.text)) (strong[name] ??= []).push(`${pkg}\u0000${entry.path}`)
        else if (weakRe.test(entry.text)) (weak[name] ??= []).push(`${pkg}\u0000${entry.path}`)
      }
    }
  }
  return { strong, weak }
}

const TRICKY_CORPUS = {
  '@scope/alpha': [
    {
      path: '/n/@scope/alpha/lib/index.js',
      text: [
        "defineTool({ name: 'bash', description: 'x' })",
        'const other = { name : "read" }',
        "toolname: 'grep'",
        "const INDIRECT = 'todo_write'",
        "name: 'task_board'",
        'const K = `skill`',
        '// dot-escape guard exercised separately below',
        'const fake = "axb"',
      ].join('\n'),
    },
    { path: '/n/@scope/alpha/lib/extra.js', text: "name: 'bash'" },
  ],
  '@scope/beta': [
    { path: '/n/@scope/beta/lib/index.js', text: "module.exports = { name: 'task_board_list' }" },
  ],
}

test('scanCorpus：与「逐个名字依次 test」的参照实现完全等价', () => {
  const names = ['bash', 'read', 'grep', 'todo_write', 'task_board', 'task_board_list', 'skill', 'axb', 'a.b', 'absent']
  const scan = scanCorpus(TRICKY_CORPUS, names)
  const reference = referenceScan(TRICKY_CORPUS, names)

  // 只比较"有命中的名字"（scanCorpus 为每个待扫名字都留了键，空数组等价于无命中）
  const nonEmpty = entries => Object.fromEntries(Object.entries(entries).filter(([, list]) => list.length > 0))
  const flatten = hits => nonEmpty(Object.fromEntries(Object.entries(hits)
    .map(([name, pairs]) => [name, pairs.map(pair => `${pair.pkg}\u0000${pair.file}`).sort()])))
  assert.deepEqual(flatten(scan.strongHits), nonEmpty(Object.fromEntries(
    Object.entries(reference.strong).map(([name, list]) => [name, list.sort()]),
  )))
  assert.deepEqual(flatten(scan.weakHits), nonEmpty(Object.fromEntries(
    Object.entries(reference.weak).map(([name, list]) => [name, list.sort()]),
  )))

  // 强/弱分层与字符串字面量的具体形状
  const strongNames = Object.keys(nonEmpty(scan.strongHits))
  const weakNames = Object.keys(nonEmpty(scan.weakHits))
  assert.deepEqual(strongNames.sort(), ['bash', 'read', 'task_board', 'task_board_list'])
  assert.deepEqual(weakNames.sort(), ['axb', 'grep', 'skill', 'todo_write'])
  // `toolname:` 不是注册点写法（`\bname` 要求词边界），只能落弱级
  assert.equal(scan.strongHits.grep.length, 0)
  assert.equal(scan.weakHits.grep.length, 1)
  // 名字里的 `.` 必须按字面量匹配（`a.b` 的模式是 `a\.b`，不得命中 `axb`）
  assert.equal(scan.weakHits['a.b'].length, 0)
  assert.equal(scan.weakHits.axb.length, 1)
})

test('scanCorpus：按包聚合去重、evidence 升序、files/bytes/capped 计数', () => {
  const corpus = {
    '@scope/zeta': [{ path: '/n/zeta/b.js', text: "name: 'bash'" }],
    '@scope/alpha': [
      { path: '/n/alpha/z.js', text: "name: 'bash'" },
      { path: '/n/alpha/a.js', text: "name: 'bash'" },
      { path: '/n/alpha/skip.js', text: 'nothing here' },
    ],
  }
  const scan = scanCorpus(corpus, ['bash'], { capped: true })
  // 包名升序；包内无重复；同包多文件都算命中文件（包只算 1 个候选）
  assert.deepEqual(scan.strongHits.bash.map(hit => hit.pkg), ['@scope/alpha', '@scope/alpha', '@scope/zeta'])
  assert.deepEqual(scan.evidence.strong.bash, ['/n/alpha/a.js', '/n/alpha/z.js', '/n/zeta/b.js'])
  assert.equal(scan.files, 4)
  assert.equal(scan.bytes, Buffer.byteLength(TRICKY_CORPUS['@scope/alpha'][0].text, 'utf8') * 0 // 占位：下面单独断言
    + Object.values(corpus).flat().reduce((sum, entry) => sum + Buffer.byteLength(entry.text, 'utf8'), 0))
  assert.equal(scan.capped, true)
  assert.equal(scanCorpus(corpus, ['bash']).capped, false)
  // 未过 NAME_PATTERN 的名字不参与匹配（也不炸）
  assert.deepEqual(scanCorpus(corpus, ['has space', 'bash']).strongHits['has space'], undefined)
  assert.deepEqual(scanCorpus({}, []).strongHits, {})
})

/** 便捷：从「命中表」造 attributeNames 的输入。 */
function hits({ profileStrong = {}, profileWeak = {}, coreStrong = {}, coreWeak = {} }) {
  const toPairs = (map, root) => Object.fromEntries(Object.entries(map).map(([name, pkgs]) => [
    name, pkgs.map(pkg => ({ pkg, file: `${root}/${pkg}/lib/index.js` })),
  ]))
  return {
    profile: { strongHits: toPairs(profileStrong, '/profile'), weakHits: toPairs(profileWeak, '/profile') },
    core: { strongHits: toPairs(coreStrong, '/core'), weakHits: toPairs(coreWeak, '/core') },
  }
}

test('attributeNames：§2.13 判定表 8 行逐行落地', () => {
  const names = [
    { name: 'task_board_list', category: 'tools' },
    { name: 'mcp__openviking__find', category: 'mcp' },
    { name: 'mcp__weird', category: 'mcp' },
    { name: 'ambiguous', category: 'tools' },
    { name: 'core_tool', category: 'tools' },
    { name: 'weak_plugin', category: 'tools' },
    { name: 'weak_core', category: 'tools' },
    { name: 'weak_ambiguous', category: 'tools' },
    { name: 'weak_mixed', category: 'tools' },
    { name: 'nothing', category: 'tools' },
  ]
  const byName = attributeNames(names, hits({
    profileStrong: {
      task_board_list: ['@linxin666/dsh-client-ui-task-board'],
      ambiguous: ['@a/one', '@b/two', '@c/three'],
    },
    coreStrong: { ambiguous: ['@deepseek-ai/dsh-x'], core_tool: ['@deepseek-ai/dsh-tool-bash'] },
    profileWeak: { weak_plugin: ['@liustack/modlens'], weak_ambiguous: ['@a/one', '@b/two'], weak_mixed: ['@a/one'] },
    coreWeak: { weak_core: ['@deepseek-ai/dsh-plan-mode'], weak_mixed: ['@deepseek-ai/dsh-tool-workflow'] },
  }))

  // 第 1 行：MCP 命名约定（不扫源码）
  assert.deepEqual(byName['mcp__openviking__find'], {
    kind: 'mcp-server', name: 'openviking', confidence: 'high', method: 'mcp-naming',
    evidenceFile: null, candidates: [],
  })
  // 说明 2：category 是 mcp 但名字不符合约定 → 第 8 行，不得"看起来像 MCP"就推断
  assert.deepEqual(byName['mcp__weird'], unknownProvidedBy())
  // 第 2 行：强扫描 profile 恰好 1 个命中
  assert.deepEqual(byName.task_board_list, {
    kind: 'plugin', name: '@linxin666/dsh-client-ui-task-board', confidence: 'high', method: 'static-scan',
    evidenceFile: '/profile/@linxin666/dsh-client-ui-task-board/lib/index.js', candidates: [],
  })
  // 第 3 行：强扫描 profile ≥ 2 → unknown/low + candidates（即使核心也有命中也不给 core 结论）
  assert.deepEqual(byName.ambiguous, {
    kind: 'unknown', name: null, confidence: 'low', method: 'static-scan', evidenceFile: null,
    candidates: ['@a/one', '@b/two', '@c/three'],
  })
  // 第 4 行：强扫描 profile 0、核心 ≥ 1
  assert.deepEqual(byName.core_tool, {
    kind: 'core', name: null, confidence: 'high', method: 'static-scan',
    evidenceFile: '/core/@deepseek-ai/dsh-tool-bash/lib/index.js', candidates: [],
  })
  // 第 5 行：弱扫描 profile 唯一命中且核心 0 命中 → plugin/low
  assert.deepEqual(byName.weak_plugin, {
    kind: 'plugin', name: '@liustack/modlens', confidence: 'low', method: 'static-scan-weak',
    evidenceFile: '/profile/@liustack/modlens/lib/index.js', candidates: [],
  })
  // 第 6 行：弱扫描 profile 0、核心 ≥ 1 → core/low
  assert.deepEqual(byName.weak_core, {
    kind: 'core', name: null, confidence: 'low', method: 'static-scan-weak',
    evidenceFile: '/core/@deepseek-ai/dsh-plan-mode/lib/index.js', candidates: [],
  })
  // 第 7 行：弱扫描歧义（≥2 包，或 profile 与核心同时命中）→ unknown/low + candidates
  assert.equal(byName.weak_ambiguous.kind, 'unknown')
  assert.equal(byName.weak_ambiguous.method, 'static-scan-weak')
  assert.deepEqual(byName.weak_ambiguous.candidates, ['@a/one', '@b/two'])
  assert.deepEqual(byName.weak_mixed.candidates, ['@a/one'])
  assert.equal(byName.weak_mixed.kind, 'unknown')
  // 第 8 行：强、弱都无命中 → unknown / not-found（不猜）
  assert.deepEqual(byName.nothing, unknownProvidedBy())
  assert.equal(byName.nothing.method, 'not-found')
})

test('attributeNames：硬规则与边界', () => {
  const many = Array.from({ length: 12 }, (_, i) => `@scope/pkg${String(i).padStart(2, '0')}`)
  const byName = attributeNames(
    [{ name: 'crowded', category: 'tools' }],
    hits({ profileStrong: { crowded: many } }),
  )
  assert.equal(byName.crowded.kind, 'unknown')
  assert.equal(byName.crowded.candidates.length, CANDIDATES_LIMIT) // ≤ 8
  assert.deepEqual(byName.crowded.candidates, [...byName.crowded.candidates].sort()) // 升序
  assert.equal(new Set(byName.crowded.candidates).size, byName.crowded.candidates.length) // 去重

  // core / unknown 的 name 恒为 null；plugin 的 name 匹配 PACKAGE_PATTERN
  for (const entry of Object.values(byName)) {
    if (entry.kind === 'core' || entry.kind === 'unknown') assert.equal(entry.name, null)
    if (entry.kind === 'plugin') assert.ok(PACKAGE_PATTERN.test(entry.name))
    if (entry.kind !== 'unknown') assert.deepEqual(entry.candidates, [])
  }
  assert.ok(MCP_NAME_PATTERN.test('mcp__openviking__find'))
  assert.equal(MCP_NAME_PATTERN.test('mcp__weird'), false)
  // 空输入与裸字符串名字（默认按 tools 处理）
  assert.deepEqual(attributeNames([], hits({})), {})
  assert.equal(attributeNames(['bash'], hits({ coreStrong: { bash: ['@deepseek-ai/dsh-tool-bash'] } })).bash.kind, 'core')
})

/** 造一个 canonical item（reconcile 之后的样子）。 */
function item(name, tokens, { category = 'tools', zeroCall = true, providedBy = unknownProvidedBy(), id } = {}) {
  return {
    id: id ?? `${category}:${name}`,
    category,
    name,
    tokens,
    calls: zeroCall ? 0 : 1,
    tokensPerCall: zeroCall ? null : tokens,
    zeroCall,
    usageBasis: 'tool-calls',
    source: category === 'mcp' ? 'mcp' : 'native',
    providedBy,
  }
}

const pluginBy = (name, confidence = 'high') => ({
  kind: 'plugin', name, confidence, method: confidence === 'high' ? 'static-scan' : 'static-scan-weak',
  evidenceFile: `/profile/${name}/lib/index.js`, candidates: [],
})
const mcpBy = server => ({
  kind: 'mcp-server', name: server, confidence: 'high', method: 'mcp-naming', evidenceFile: null, candidates: [],
})
const coreBy = () => ({
  kind: 'core', name: null, confidence: 'high', method: 'static-scan', evidenceFile: '/core/x.js', candidates: [],
})
const unknownBy = (candidates = []) => ({
  kind: 'unknown', name: null, confidence: 'low', method: 'static-scan-weak', evidenceFile: null, candidates,
})

test('buildPrunePlan：分组、排序、置信度、usedToolCount 与理由计数', () => {
  const items = [
    item('a1', 300, { providedBy: pluginBy('@scope/a') }),
    item('a2', 200, { providedBy: pluginBy('@scope/a') }),
    item('b1', 100, { providedBy: pluginBy('@scope/b', 'low') }),
    item('a_used', 50, { providedBy: pluginBy('@scope/a'), zeroCall: false }),
    item('m1', 120, { category: 'mcp', providedBy: mcpBy('srv') }),
    item('m_used', 40, { category: 'mcp', providedBy: mcpBy('srv'), zeroCall: false }),
    item('c1', 90, { providedBy: coreBy() }),
    item('u1', 30, { providedBy: unknownBy(['@scope/x']) }),
    item('orphan', 10, { providedBy: pluginBy('@scope/orphan') }),
  ]
  const bundleOwners = {
    '@scope/a': { owner: '@scope/web-all', removable: true },
    '@scope/b': { owner: '@scope/web-all', removable: true },
    '@scope/orphan': { owner: null, removable: false },
  }
  const plan = buildPrunePlan(items, {}, bundleOwners)

  // 排序：reclaimableTokens 降序 → itemCount 降序 → target 升序
  assert.deepEqual(plan.prunePlan.map(entry => [entry.target, entry.reclaimableTokens, entry.itemCount]), [
    ['@scope/web-all', 600, 3],
    ['srv', 120, 1],
  ])
  assert.equal(plan.prunePlanReclaimableTokens, 720)
  // factPackages 升序去重；mcp-server 恒为 []
  assert.deepEqual(plan.prunePlan[0].factPackages, ['@scope/a', '@scope/b'])
  assert.deepEqual(plan.prunePlan[1].factPackages, [])
  // items 按 tokens 降序
  assert.deepEqual(plan.prunePlan[0].items.map(entry => entry.name), ['a1', 'a2', 'b1'])
  // usedToolCount = 同一逻辑单元下 zeroCall === false 的工具数
  assert.equal(plan.prunePlan[0].usedToolCount, 1)
  assert.equal(plan.prunePlan[1].usedToolCount, 1)
  // confidence 取最弱一环
  assert.equal(plan.prunePlan[0].confidence, 'low')
  assert.equal(plan.prunePlan[1].confidence, 'high')
  // noRecommendation：固定 3 条、顺序固定、空理由保留且置 0
  assert.deepEqual(plan.noRecommendation.map(entry => entry.reason), [...NO_RECOMMENDATION_REASONS])
  assert.deepEqual(plan.noRecommendation, [
    { reason: 'core', items: 1, tokens: 90 },
    { reason: 'no-owner-bundle', items: 1, tokens: 10 },
    { reason: 'unknown-attribution', items: 1, tokens: 30 },
  ])
  assert.equal(PRUNE_PLAN_BASIS, 'model-tool-calls-only')
})

test('buildPrunePlan：省额不重复计入（同一项只进一个条目、条目内不重复）', () => {
  const items = [
    item('x1', 10, { providedBy: pluginBy('@scope/x') }),
    item('x2', 20, { providedBy: pluginBy('@scope/y') }),
    item('x3', 30, { category: 'mcp', providedBy: mcpBy('srv') }),
  ]
  const plan = buildPrunePlan(items, {}, {
    '@scope/x': { owner: '@scope/one', removable: true },
    '@scope/y': { owner: '@scope/one', removable: true }, // 同一个卸载单元
  })
  assert.equal(plan.prunePlan.length, 2)
  const ids = plan.prunePlan.flatMap(entry => entry.items.map(entryItem => entryItem.id))
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(plan.prunePlanReclaimableTokens, 60) // 10 + 20 + 30，每项只算一次
  // 同一项即便被重复塞进 items 也只计一次
  const duplicated = buildPrunePlan([items[0], items[0]], {}, { '@scope/x': { owner: '@scope/one', removable: true } })
  assert.equal(duplicated.prunePlanReclaimableTokens, 10)
  assert.equal(duplicated.prunePlan[0].itemCount, 1)
})

test('buildPrunePlan：没有证据就没有候选（zeroCall 非 true 的项一律不进）', () => {
  const items = [
    item('unknown_usage', 100, { zeroCall: null, providedBy: pluginBy('@scope/a') }),
    item('used', 50, { zeroCall: false, providedBy: pluginBy('@scope/a') }),
    item('instructions', 80, { category: 'instructions', zeroCall: null, providedBy: undefined }),
  ]
  const plan = buildPrunePlan(items, {}, { '@scope/a': { owner: '@scope/web-all', removable: true } })
  assert.deepEqual(plan.prunePlan, [])
  assert.equal(plan.prunePlanReclaimableTokens, 0)
  assert.deepEqual(plan.noRecommendation.map(entry => entry.items), [0, 0, 0])
  assert.deepEqual(buildPrunePlan([], {}, {}).noRecommendation.map(entry => entry.items), [0, 0, 0])
})

test('buildPrunePlan：providedByByName 作为缺省来源（items 未带 providedBy 时）', () => {
  const bare = { id: 'tools:z', category: 'tools', name: 'z', tokens: 42, calls: 0, zeroCall: true }
  const plan = buildPrunePlan([bare], { z: pluginBy('@scope/z') }, { '@scope/z': { owner: '@scope/web-all', removable: true } })
  assert.equal(plan.prunePlanReclaimableTokens, 42)
  assert.deepEqual(plan.prunePlan[0].factPackages, ['@scope/z'])
  // 既没有 items.providedBy 也没有 byName → unknown → 不给动作（不猜）
  const fallback = buildPrunePlan([bare], {}, {})
  assert.deepEqual(fallback.prunePlan, [])
  assert.deepEqual(fallback.noRecommendation, [
    { reason: 'core', items: 0, tokens: 0 },
    { reason: 'no-owner-bundle', items: 0, tokens: 0 },
    { reason: 'unknown-attribution', items: 1, tokens: 42 },
  ])
})
