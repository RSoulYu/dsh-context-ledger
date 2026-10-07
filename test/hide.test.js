/**
 * lib/hide.js —— R6 工具级隐藏候选（纯函数层）。
 *
 * 覆盖 DESIGN §2.18–§2.23 里**能在纯函数层验证**的部分：
 * 单元解析（含"插件无唯一可卸载 bundle"的关键差异）、排序与上限、
 * `precheck` 三态、`hideApply` 的划分与默认不施加、恒等式 H1–H7，
 * 以及 §3.4 的"纯函数不读盘"grep 判据。
 *
 * 宿主侧的四条硬约束（探测三态、agent 作用域施加、opt-in 开关、installHideApply）
 * 在 `test/host.test.js` 覆盖，因为它们需要假 ctx / 假 agent。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  HIDE_MODES, HIDE_PLAN_BASIS, HIDE_PLAN_CAVEAT, NAME_REFERENCED_LIMIT, NON_MODEL_CALLERS,
  PRECHECK_REASONS, PRECHECK_STATUSES, REGISTRY_USE_BASIS, REGISTRY_USE_VERDICTS,
  RESERVED_TOOL_NAMES, buildHideApply, buildHideFindings, buildHidePlan, precheckOf,
} from '../lib/hide.js'

const PROVIDED = {
  pluginA: { kind: 'plugin', name: '@scope/plug-a', confidence: 'high', method: 'static-scan', evidenceFile: '/p/a.js', candidates: [] },
  pluginWeak: { kind: 'plugin', name: '@scope/plug-b', confidence: 'low', method: 'static-scan-weak', evidenceFile: '/p/b.js', candidates: [] },
  pluginOrphan: { kind: 'plugin', name: '@scope/orphan', confidence: 'high', method: 'static-scan', evidenceFile: '/p/o.js', candidates: [] },
  coreTool: { kind: 'core', name: null, confidence: 'high', method: 'static-scan', evidenceFile: '/c/x.js', candidates: [] },
  mcpTool: { kind: 'mcp-server', name: 'srv', confidence: 'high', method: 'mcp-naming', evidenceFile: null, candidates: [] },
  unknownTool: { kind: 'unknown', name: null, confidence: 'low', method: 'static-scan-weak', evidenceFile: null, candidates: ['@scope/x'] },
}

const BUNDLES = {
  '@scope/plug-a': { owner: '@scope/web-all', removable: true },
  '@scope/plug-b': { owner: '@scope/web-all', removable: true },
  '@scope/orphan': { owner: null, removable: false },
}

function item(name, tokens, providedBy, { zeroCall = true, calls = zeroCall ? 0 : 3, category = 'tools' } = {}) {
  return { id: `${category}:${name}`, category, name, tokens, calls, tokensPerCall: null, zeroCall, usageBasis: 'tool-calls', providedBy }
}

test('precheckOf：三态与四种 reason（未校验绝不用 false 冒充）', () => {
  assert.deepEqual(precheckOf('x', { status: 'prechecked', restrictableNames: ['x'] }), {
    status: 'prechecked', restrictable: true, reason: null,
  })
  assert.deepEqual(precheckOf('x', { status: 'prechecked', restrictableNames: [] }), {
    status: 'prechecked', restrictable: false, reason: 'not-in-restrictable-names',
  })
  assert.deepEqual(precheckOf('x', { status: 'unvalidated', restrictableNames: null }), {
    status: 'unvalidated', restrictable: null, reason: 'no-agent-scope',
  })
  assert.deepEqual(precheckOf('x', { status: 'unsupported' }), {
    status: 'unsupported', restrictable: null, reason: 'interface-absent',
  })
  // 预留名即使出现在 restrictableNames 里也不可限制
  assert.deepEqual(precheckOf('run_code', { status: 'prechecked', restrictableNames: ['run_code'] }), {
    status: 'prechecked', restrictable: false, reason: 'reserved-name',
  })
  // 缺省探测结果 = unsupported（fail-soft，不抛错）
  assert.equal(precheckOf('x', {}).status, 'unsupported')
  assert.equal(precheckOf('x', { status: 'nonsense' }).status, 'unsupported')
})

test('buildHidePlan：单元解析（plugin 无唯一 bundle ⇒ target 为 null，但仍是候选）', () => {
  const plan = buildHidePlan([
    item('a_tool', 100, PROVIDED.pluginA),
    item('b_tool', 50, PROVIDED.pluginWeak),
    item('c_tool', 30, PROVIDED.coreTool),
    item('d_tool', 20, PROVIDED.mcpTool, { category: 'mcp' }),
    item('e_tool', 10, PROVIDED.unknownTool),
    item('f_tool', 5, PROVIDED.pluginOrphan),
    item('a_used', 999, PROVIDED.pluginA, { zeroCall: false }),
  ], { byName: PROVIDED, bundleOwners: BUNDLES }, { status: 'prechecked', restrictableNames: ['a_tool', 'b_tool', 'c_tool', 'd_tool', 'e_tool', 'f_tool'] })

  assert.deepEqual(plan.hidePlan.map(entry => entry.name), ['a_tool', 'b_tool', 'c_tool', 'd_tool', 'e_tool', 'f_tool'])
  assert.equal(plan.hidePlanTokens, 100 + 50 + 30 + 20 + 10 + 5)
  // 关键差异：core / unknown 归属也能进候选（这就是 R6 比 prunePlan 覆盖面更宽的地方）
  assert.deepEqual(plan.hidePlan.find(entry => entry.name === 'c_tool').unit, { kind: 'core', target: null, factPackages: [] })
  assert.deepEqual(plan.hidePlan.find(entry => entry.name === 'e_tool').unit, { kind: 'unknown', target: null, factPackages: [] })
  // plugin 无唯一可卸载 bundle ⇒ target null，但 factPackages 仍如实给出
  assert.deepEqual(plan.hidePlan.find(entry => entry.name === 'f_tool').unit, {
    kind: 'plugin', target: null, factPackages: ['@scope/orphan'],
  })
  assert.deepEqual(plan.hidePlan.find(entry => entry.name === 'd_tool').unit, {
    kind: 'mcp-server', target: 'srv', factPackages: [],
  })
  // 同一 bundle 的两个事实包合并成一个单元；在用工具计入 usedToolCount
  const webAll = plan.hidePlanUnits.find(entry => entry.target === '@scope/web-all')
  assert.deepEqual(webAll.factPackages, ['@scope/plug-a', '@scope/plug-b'])
  assert.equal(webAll.toolCount, 2)
  assert.equal(webAll.tokens, 150)
  assert.equal(webAll.usedToolCount, 1)
  // 排序：tokens 降序 → toolCount 降序 → (target ?? kind) 升序
  // 排序键是 `target ?? kind`：mcp-server 单元有 target（`srv`），故用 `srv` 参与排序
  assert.deepEqual(plan.hidePlanUnits.map(entry => entry.target ?? entry.kind), [
    '@scope/web-all', 'core', 'srv', 'unknown', 'plugin',
  ])
  assert.equal(plan.hidePlanStatus, 'prechecked')
})

test('buildHidePlan：inPrunePlan 只认 (kind,target) 配对；没有证据就没有候选（H7）', () => {
  const plan = buildHidePlan(
    [item('a_tool', 100, PROVIDED.pluginA), item('c_tool', 30, PROVIDED.coreTool)],
    { byName: PROVIDED, bundleOwners: BUNDLES },
    { status: 'prechecked', restrictableNames: ['a_tool', 'c_tool'] },
    { prunePlan: [{ kind: 'plugin', target: '@scope/web-all' }, { kind: 'mcp-server', target: 'openviking' }] },
  )
  assert.equal(plan.hidePlanUnits.find(entry => entry.target === '@scope/web-all').inPrunePlan, true)
  assert.equal(plan.hidePlanUnits.find(entry => entry.kind === 'core').inPrunePlan, false)

  // 无证据态（calls === null ⇒ zeroCall 恒为 null）：一个候选都没有
  const noEvidence = buildHidePlan([
    { id: 'tools:a', category: 'tools', name: 'a', tokens: 100, calls: null, zeroCall: null, providedBy: PROVIDED.pluginA },
    { id: 'tools:b', category: 'tools', name: 'b', tokens: 50, calls: null, zeroCall: null, providedBy: PROVIDED.pluginA, },
  ], { byName: PROVIDED, bundleOwners: BUNDLES }, { status: 'prechecked', restrictableNames: ['a', 'b'] })
  assert.deepEqual(noEvidence.hidePlan, [])
  assert.equal(noEvidence.hidePlanTokens, 0)
  assert.deepEqual(noEvidence.hidePlanUnits, [])
  // instructions / skills 永远不是候选（连逐项次数都没有）
  const others = buildHidePlan([
    { id: 'instructions:/w/AGENTS.md', category: 'instructions', name: '/w/AGENTS.md', tokens: 800, calls: null, zeroCall: null },
    { id: 'skills:genui', category: 'skills', name: 'genui', tokens: 50, calls: null, zeroCall: null },
  ], {}, { status: 'prechecked', restrictableNames: [] })
  assert.deepEqual(others.hidePlan, [])
})

test('buildHidePlan：hidePlan 排序是全序（同 tokens 用 name 升序），registryUse 逐项成形', () => {
  const plan = buildHidePlan([
    item('zeta_tool', 50, PROVIDED.coreTool),
    item('alpha_tool', 50, PROVIDED.coreTool),
    item('beta_tool', 10, PROVIDED.coreTool),
  ], { weakEvidence: { zeta_tool: ['/z/2.js', '/z/1.js', '/z/3.js', '/z/4.js'] } }, { status: 'prechecked', restrictableNames: ['zeta_tool', 'alpha_tool', 'beta_tool'] })

  assert.deepEqual(plan.hidePlan.map(entry => entry.name), ['alpha_tool', 'zeta_tool', 'beta_tool'])
  const zeta = plan.hidePlan.find(entry => entry.name === 'zeta_tool')
  assert.deepEqual(zeta.registryUse, {
    verdict: 'unconfirmed',
    verdictBasis: REGISTRY_USE_BASIS,
    modelCalls: 0,
    // ≤3 且升序（取字典序最小的三个）
    nameReferencedElsewhere: ['/z/1.js', '/z/2.js', '/z/3.js'].slice(0, NAME_REFERENCED_LIMIT),
    nonModelCallers: NON_MODEL_CALLERS,
  })
  assert.equal(zeta.selfTool, false)
  const selfItem = buildHidePlan(
    [item('context_ledger', 100, PROVIDED.coreTool)],
    {},
    { status: 'prechecked', restrictableNames: ['context_ledger'] },
  ).hidePlan[0]
  assert.equal(selfItem.selfTool, true)
})

test('buildHideApply：候选集合的划分、空清单绝不施加、appliedNames 只能来自 denyList', () => {
  const hidePlan = [
    { name: 'a_tool', precheck: { status: 'prechecked', restrictable: true, reason: null } },
    { name: 'b_tool', precheck: { status: 'prechecked', restrictable: false, reason: 'not-in-restrictable-names' } },
    { name: 'c_tool', precheck: { status: 'unvalidated', restrictable: null, reason: 'no-agent-scope' } },
  ]
  const apply = buildHideApply(hidePlan, { status: 'prechecked', interfacePresent: true })
  assert.deepEqual(Object.keys(apply), ['mode', 'interfacePresent', 'denyList', 'skipped', 'applySupported', 'appliedNames'])
  assert.equal(apply.mode, 'suggestion-only') // 默认恒不施加
  assert.deepEqual(apply.denyList, ['a_tool'])
  assert.deepEqual(apply.skipped, [
    { name: 'b_tool', reason: 'not-in-restrictable-names' },
    { name: 'c_tool', reason: 'no-agent-scope' },
  ])
  assert.equal(apply.denyList.length + apply.skipped.length, hidePlan.length)
  assert.equal(apply.applySupported, true)
  assert.deepEqual(apply.appliedNames, [])

  // 空清单 ⇒ 绝不施加（空 filter 在宿主侧会抛错）
  const empty = buildHideApply([hidePlan[1]], { status: 'prechecked', interfacePresent: true })
  assert.deepEqual(empty.denyList, [])
  assert.equal(empty.applySupported, false)
  // 接口缺失 ⇒ applySupported false、mode 仍是只建议
  const noInterface = buildHideApply(hidePlan, { status: 'unsupported', interfacePresent: false })
  assert.equal(noInterface.applySupported, false)
  assert.equal(noInterface.interfacePresent, false)
  assert.equal(noInterface.mode, 'suggestion-only')
  // appliedNames 只接受 denyList 之内、去重升序
  const applied = buildHideApply(hidePlan, {
    status: 'prechecked', interfacePresent: true, mode: 'applied-by-config',
    appliedNames: ['a_tool', 'a_tool', 'zzz_not_in_list'],
  })
  assert.equal(applied.mode, 'applied-by-config')
  assert.deepEqual(applied.appliedNames, ['a_tool'])
  // 非法 mode 一律回落到 suggestion-only
  assert.equal(buildHideApply(hidePlan, { mode: 'yolo' }).mode, HIDE_MODES[0])
  // 保留名永不进 denyList
  const reserved = buildHideApply(
    [{ name: 'run_code', precheck: { status: 'prechecked', restrictable: true, reason: null } }],
    { status: 'prechecked', interfacePresent: true },
  )
  assert.deepEqual(reserved.denyList, [])
  assert.deepEqual(reserved.skipped, [{ name: 'run_code', reason: 'reserved-name' }])
})

test('buildHideFindings：七个键齐全、caveat 是副本、basis 与 prunePlan 同源', () => {
  const findings = buildHideFindings(
    [item('a_tool', 42, PROVIDED.pluginA)],
    { byName: PROVIDED, bundleOwners: BUNDLES },
    { status: 'prechecked', restrictableNames: ['a_tool'] },
    { prunePlan: [{ kind: 'plugin', target: '@scope/web-all' }] },
  )
  assert.deepEqual(Object.keys(findings), [
    'hidePlan', 'hidePlanTokens', 'hidePlanUnits', 'hidePlanBasis', 'hidePlanStatus', 'hideApply', 'hidePlanCaveat',
  ])
  assert.equal(findings.hidePlanBasis, HIDE_PLAN_BASIS)
  assert.equal(findings.hidePlanBasis, 'model-tool-calls-only')
  assert.equal(findings.hidePlanTokens, 42)
  assert.deepEqual(findings.hidePlanCaveat, HIDE_PLAN_CAVEAT)
  assert.notEqual(findings.hidePlanCaveat, HIDE_PLAN_CAVEAT) // 副本，调用方改不到共享常量
  assert.deepEqual(findings.hideApply.denyList, ['a_tool'])
  assert.equal(findings.hideApply.appliedNames.length, 0)
})

test('常量取值域冻结（§2.18–§2.23）', () => {
  assert.deepEqual([...HIDE_MODES], ['suggestion-only', 'applied-by-config'])
  assert.deepEqual([...PRECHECK_STATUSES], ['prechecked', 'unvalidated', 'unsupported'])
  assert.deepEqual([...PRECHECK_REASONS], ['not-in-restrictable-names', 'no-agent-scope', 'interface-absent', 'reserved-name'])
  assert.deepEqual([...REGISTRY_USE_VERDICTS], ['unconfirmed', 'model-observed'])
  assert.deepEqual([...RESERVED_TOOL_NAMES], ['run_code'])
  assert.equal(NAME_REFERENCED_LIMIT, 3)
  assert.deepEqual(HIDE_PLAN_CAVEAT, {
    registryHideIsTotal: true, nonModelRegistryCalls: 'unobservable', serviceCoupling: 'unconfirmed',
    confirmationRequired: true, prefixCacheCost: 'one-time-invalidation',
  })
})

test('§3.4 grep 判据：lib/hide.js 是纯函数模块（不读盘、不 import 宿主包）', () => {
  const source = readFileSync(new URL('../lib/hide.js', import.meta.url), 'utf8')
  const code = source.split('\n').filter(line => !line.trim().startsWith('*') && !line.trim().startsWith('//')).join('\n')
  for (const forbidden of ['readFileSync', 'readText', 'readdirSync', 'statSync', 'realpathSync', 'spawn(']) {
    assert.equal(code.includes(forbidden), false, `lib/hide.js 不得出现 ${forbidden}`)
  }
  assert.equal(/^import .*@deepseek-ai/m.test(code), false, 'lib/hide.js 不得 import 宿主包')
})
