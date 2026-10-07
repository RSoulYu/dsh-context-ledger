/**
 * 真实会话日志端到端（DESIGN §3.4 S4）。
 *
 * 用本机**真实**会话日志（`<DSH_HOME>/sessions/<workspaceKey>/…/session.v4.jsonl.zstd`，
 * 只读）跑完整链路：
 *   ① 声明面取自真实日志里 `request/header` 记录的 `header.tools`（= 宿主真正送给
 *      模型的那份 schema，等于 `ctx.tools.schemas()` 的产物），只取 `name`/`description`；
 *   ② 使用面用 `index.js` 的流式回放（`zstd -dc`）数真实调用次数；
 *   ③ 断言 S3 字符串白名单 + 零调用清单与 `items` 一致；
 *   ④ 把哨兵注入**工作区外的临时副本**的全部载荷字段后重跑，产物逐字节相同。
 *
 * 绝不修改原日志、绝不写 `~/.dsh/**`；临时副本写在系统临时目录并在结束时删除。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { instructionItems } from '../lib/cost.js'
import { estimateTokens } from '../lib/tokens.js'
import { MAX_LINES_PER_SESSION, projectKey } from '../lib/usage.js'
import { renderLedger } from '../lib/reconcile.js'
import { whitelistOffenders } from './whitelist.js'

let host = null
try {
  host = await import('../index.js')
} catch {
  host = null
}

const WORKSPACE = '/home/u/Desktop/DSHWorkspace'
const WORKSPACE_KEY = '--home-u-Desktop-DSHWorkspace--'
const DSH_HOME = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
  ? process.env.DSH_HOME
  : join(homedir(), '.dsh')
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')
/** 真实 profile（只读）：R1 的 plugin 候选包从这里扫。 */
const PROFILE_DIR = join(DSH_HOME, 'profiles', 'web')
/** profile 候选包是否可扫：缺失时 `subagent` 的"多包歧义"在结构上不可能存在（见 E2E②）。 */
const PROFILE_AVAILABLE = existsSync(join(PROFILE_DIR, 'node_modules'))
const SENTINEL = 'LEDGER-PRIVACY-SENTINEL-8f3a'

/** 本机真实技能目录（与当前会话 catalog 同源；E2E 只用于补齐成本侧形状）。 */
const REAL_SKILLS = [
  { name: 'genui', description: 'GenUI dsh-ui component/schema reference.', source: 'user-dsh', provider: 'filesystem', invocation: { modelInvocable: true } },
  { name: 'openviking-memory', description: 'Work with OpenViking, the persistent context database.', source: 'user-dsh', provider: 'filesystem', invocation: { modelInvocable: true } },
  { name: 'openviking-skills', description: 'Find, use, create, install, share skills in OpenViking.', source: 'user-dsh', provider: 'filesystem', invocation: { modelInvocable: true } },
  { name: 'ov-experience-memory', description: 'Retrieve and apply OpenViking Experience memories.', source: 'user-dsh', provider: 'filesystem', invocation: { modelInvocable: true } },
]

/** 真实文件系统支持的 ctx.fs（只读工作区里的指令文件）。 */
const realFs = {
  resolve: async path => ({ path }),
  processPath: target => target.path,
  stat: async (target) => {
    try {
      const info = statSync(target.path)
      return { type: info.isFile() ? 'file' : 'directory', size: info.size }
    } catch {
      return undefined
    }
  },
  readText: async target => readFileSync(target.path, 'utf8'),
}

/** @type {string[]} */
const tmpRoots = []
after(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true })
})

/** 找本机真实会话日志（最近优先）。 */
function realSessions() {
  if (host === null) return []
  return host.listWorkspaceSessions(SESSIONS_ROOT, WORKSPACE_KEY)
}

const sessions = realSessions()
const skip = host === null
  ? '宿主依赖 @deepseek-ai/dsh-tools 不可解析：E2E 跳过'
  : (sessions.length === 0 ? `本机没有 ${WORKSPACE_KEY} 的会话日志：E2E 跳过（不伪造数据）` : false)

/**
 * 从真实日志里读**声明面**：第一条 `request/header` 记录的 `header.tools`。
 *
 * 只取 `name` / `description`（这两项就是生产路径 `ctx.tools.schemas()` 的产物），
 * 不读 `arguments` / `message` / `content` / `title` 等任何载荷字段，读到达成立刻停。
 * @param {string} logPath
 * @returns {Promise<Array<{name: string, description: string}> | null>}
 */
async function readDeclaredTools(logPath) {
  // `.zstd` 走系统解压；未压缩的 `.jsonl`（本文件里的冻结快照）直接读——
  // 冻结快照不能用 `zstd -dc` 读（对未压缩输入 zstd 会以 1 退出）。
  const child = logPath.endsWith('.zstd')
    ? spawn('zstd', ['-dc', logPath], { stdio: ['ignore', 'pipe', 'ignore'] })
    : null
  const input = child === null ? createReadStream(logPath) : child.stdout
  const iface = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of iface) {
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (record === null || typeof record !== 'object' || record.type !== 'request/header') continue
      const declared = record.data?.header?.tools
      if (!Array.isArray(declared) || declared.length === 0) continue
      return declared
        .filter(entry => entry !== null && typeof entry === 'object' && typeof entry.name === 'string')
        .map(entry => ({
          name: entry.name,
          description: typeof entry.description === 'string' ? entry.description : '',
        }))
    }
    return null
  } finally {
    iface.close()
    child?.kill()
  }
}

/** 把一条记录的全部字符串载荷换成哨兵，只保留 `type` 与 `data.name`。 */
function sentinelize(value, parentKey) {
  if (typeof value === 'string') return SENTINEL
  if (Array.isArray(value)) return value.map(entry => sentinelize(entry, parentKey))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      const keep = key === 'type' || (parentKey === 'data' && key === 'name')
      out[key] = keep ? entry : sentinelize(entry, key)
    }
    return out
  }
  return value
}

/** 归一化时间戳（S2 允许的唯一差异）。 */
function normalize(report) {
  return JSON.stringify({ ...report, generatedAt: 'NORMALIZED' })
}

test('E2E①：本机真实日志可定位（跳过条件明确，不伪造数据）', { skip }, () => {
  assert.equal(projectKey(WORKSPACE), WORKSPACE_KEY)
  assert.ok(sessions.length >= 1)
  assert.ok(sessions[0].logPath.endsWith('.jsonl.zstd') || sessions[0].logPath.endsWith('.jsonl'))
})

test('E2E②：真实日志 → 真实声明面 → 零调用清单，且输出无任何正文片段', { skip }, async (t) => {
  const declared = await readDeclaredTools(sessions[0].logPath)
  assert.ok(declared !== null && declared.length > 0, '真实日志里应有 request/header 的 tools 声明')

  const report = await host.gatherLedger({
    fs: realFs,
    skills: { list: async () => REAL_SKILLS },
    tools: { schemas: () => declared },
    dshHome: DSH_HOME,
    profileDir: PROFILE_DIR,
    coreScopeDir: host.resolveCoreScopeDir(),
  }, { cwd: WORKSPACE, sessions: 20 })

  // 证据位与观测规模
  assert.equal(report.scope.usageAvailable, true)
  assert.ok(report.scope.sessionsScanned >= 1)
  assert.ok(report.scope.sessionsAvailable >= report.scope.sessionsScanned)
  assert.ok(report.scope.toolCalls > 0, '真实日志应有工具调用')
  assert.equal(report.scope.sessionsLimit, 20)
  assert.match(report.scope.windowStart, /^\d{4}-\d{2}-\d{2}T/)
  assert.match(report.scope.windowEnd, /^\d{4}-\d{2}-\d{2}T/)

  // ── v4（R8）：窗口边界显式化（W1/W4/W5/W6）──
  assert.equal(report.scope.windowBasis, 'session-log-mtime')
  assert.ok(report.scope.windowStart <= report.scope.windowEnd) // W2
  assert.equal(
    report.scope.sessionsAvailable,
    report.scope.sessionsScanned + report.scope.sessionsUnreadable + report.scope.sessionsOutsideWindow,
  ) // W4
  assert.ok(report.scope.sessionsScanned + report.scope.sessionsUnreadable <= report.scope.sessionsLimit) // W5
  assert.equal(report.findings.zeroCallBasis, 'model-tool-calls-in-window') // I10

  // ── v4：三态在真机数据上的恒等式（I1–I3/I5/I6/I7；这里没传 agent ⇒ 本会话不可判定）──
  assert.deepEqual(report.scope.currentSession, { id: null, basis: 'unavailable', inWindow: false })
  assert.equal(report.totals.currentSessionObservedCalls, null) // 给不出 ≠ 0
  for (const item of report.items) {
    assert.equal(item.currentSessionCalls, null, `${item.id} 本会话不可判定却给了数字`)
    assert.equal(item.callPresence, null, `${item.id} 本会话不可判定却给了三态`)
    if (item.calls === null) {
      assert.equal(item.sessionsWithCalls, null, `${item.id} 不可观测却给了覆盖会话数`)
      continue
    }
    // I6：覆盖会话数由**同一次回放**按会话分组得到（分母 = sessionsScanned）
    assert.ok(item.sessionsWithCalls <= report.scope.sessionsScanned, `${item.id} 覆盖数越界`)
    assert.equal(item.calls > 0, item.sessionsWithCalls >= 1, `${item.id} I6 前半段`)
    assert.equal(item.calls === 0, item.sessionsWithCalls === 0, `${item.id} I6 后半段`)
  }
  // 真机数据里三态的两态必然出现（本会话不可判定 ⇒ absent 由 zeroCall 反推，见 I7 的窗口侧）
  assert.ok(report.items.some(item => item.sessionsWithCalls > 0), '真机数据应有跨会话复用的工具')

  // 恒等式在真实数据上仍成立
  const sumCalls = report.items.reduce((sum, item) => sum + (item.calls ?? 0), 0)
  assert.equal(report.scope.toolCalls, sumCalls + report.scope.callsUnmatched + report.scope.namesRejected)
  assert.equal(
    report.totals.residentTokens,
    report.totals.observableTokens + report.totals.unknownUsageTokens,
  )

  // 逐项语义：calls === null 的项绝不带 zeroCall = true
  for (const item of report.items) {
    if (item.calls === null) {
      assert.equal(item.zeroCall, null, `${item.id} 次数未知却被判零调用`)
      assert.notEqual(item.usageBasis, 'tool-calls')
    } else {
      assert.equal(item.zeroCall, item.calls === 0)
      assert.equal(item.usageBasis, 'tool-calls')
    }
  }

  // S4 ④：findings.zeroCall 与 items 中 zeroCall === true 的集合一致（同序、同上限）
  const expectedZero = report.items.filter(item => item.zeroCall === true).slice(0, 10)
  assert.deepEqual(
    report.findings.zeroCall.map(item => item.id),
    expectedZero.map(item => item.id),
  )
  assert.deepEqual(
    report.findings.topPerUse.map(item => item.id),
    report.items.filter(item => item.calls !== null && item.calls > 0)
      .sort((a, b) => (b.tokens / b.calls - a.tokens / a.calls) || (b.tokens - a.tokens))
      .slice(0, 10)
      .map(item => item.id),
  )

  // 真实数据下确实存在「贵且没用」的注入物
  assert.ok(report.totals.zeroCallItems > 0, '真实声明面里应有从未被调用的工具')
  t.diagnostic(`sessions: ${report.scope.sessionsScanned}/${report.scope.sessionsAvailable}`
    + ` · lines: ${report.scope.linesRead} · toolCalls: ${report.scope.toolCalls}`
    + ` · skillToolCalls: ${report.scope.skillToolCalls} · namesRejected: ${report.scope.namesRejected}`)
  t.diagnostic(`zero-call items (${report.totals.zeroCallItems} total, ${report.totals.zeroCallTokens} tokens): `
    + report.items.filter(item => item.zeroCall === true).map(item => `${item.name}(${item.tokens})`).join(', '))
  t.diagnostic(`native render:\n${renderLedger(report)}`)

  // 输出中无正文片段：S3 全字符串白名单 + 哨兵不可见
  const offenders = whitelistOffenders(report)
  assert.deepEqual(offenders, [])
  assert.equal(JSON.stringify(report).includes(SENTINEL), false)
  assert.equal(renderLedger(report).includes(SENTINEL), false)

  // ── R1：真机归属与可执行候选 ──
  const byName = new Map(report.items.map(item => [item.id, item]))
  const attributable = report.items.filter(item => item.category === 'tools' || item.category === 'mcp')
  assert.ok(attributable.length > 0)
  for (const item of attributable) {
    const providedBy = item.providedBy
    assert.ok(['plugin', 'core', 'mcp-server', 'unknown'].includes(providedBy.kind))
    if (providedBy.kind === 'plugin') assert.match(providedBy.name, /^(@[A-Za-z0-9-_.~]+\/)?[A-Za-z0-9-_.~]{1,214}$/)
    if (providedBy.kind === 'mcp-server') assert.equal(providedBy.name, 'openviking')
    if (providedBy.kind === 'core' || providedBy.kind === 'unknown') assert.equal(providedBy.name, null)
    if (providedBy.kind !== 'unknown') assert.deepEqual(providedBy.candidates, [])
  }
  // 已知盲区：`subagent` 在弱级是歧义（多包命中），必须如实记 unknown 并列出候选，不得猜测。
  // 携带项②（t14）：`DSH_HOME` 下没有 `profiles/web` 时 profile 候选为空，歧义在结构上不可能存在，
  // 此时它只会落到 core/unknown——旧断言写死 `unknown` 会误报环境差异。
  // 处理：把"恒成立"的那条（**绝不猜成单一插件**）无条件断言；"有 profile 候选"时才断言完整的
  // 歧义形状（unknown + static-scan-weak + 非空 candidates）。断言的实质强度不变，只去掉环境依赖。
  const subagent = byName.get('tools:subagent')
  if (subagent !== undefined) {
    assert.notEqual(subagent.providedBy.kind, 'plugin', '歧义名字绝不允许被猜成单一插件')
    assert.equal(subagent.providedBy.name, null)
    if (PROFILE_AVAILABLE) {
      assert.equal(subagent.providedBy.kind, 'unknown')
      assert.equal(subagent.providedBy.method, 'static-scan-weak')
      assert.ok(subagent.providedBy.candidates.length > 0)
    } else {
      assert.ok(['core', 'unknown'].includes(subagent.providedBy.kind))
    }
  }
  // 携带项①（t14）：**防退化守卫**——若 DSH_HOME 指错/核心根解析失败，归属侧会整体退化为
  // "无候选"，后续关于 providedBy / prunePlan 的断言就会静默恒真（扫描 0 包 0 文件也能通过）。
  // 因此这里把"确实扫到了东西"变成硬断言，而不是只断言被扫描数据的形状。
  assert.ok(report.scope.providerScan.packages > 0, '归属扫描必须真的扫到候选包（否则归属断言会静默恒真）')
  assert.ok(report.scope.providerScan.files > 0, '归属扫描必须真的读到源码文件')
  assert.equal(typeof report.scope.providerScan.capped, 'boolean')
  if (PROFILE_AVAILABLE) {
    assert.ok(report.items.some(item => item.providedBy?.kind === 'plugin'), '有 profile 候选时应至少归属出一个插件包')
  }

  // prunePlan：只含有证据的零调用项，且省额 = 这些项自身 tokens 之和
  const pruneTokens = report.findings.prunePlan.reduce((sum, entry) => sum + entry.reclaimableTokens, 0)
  const pruneItems = report.findings.prunePlan.reduce((sum, entry) => sum + entry.itemCount, 0)
  const noRecItems = report.findings.noRecommendation.reduce((sum, entry) => sum + entry.items, 0)
  const noRecTokens = report.findings.noRecommendation.reduce((sum, entry) => sum + entry.tokens, 0)
  assert.equal(report.findings.prunePlanReclaimableTokens, pruneTokens)
  assert.equal(pruneItems + noRecItems, report.totals.zeroCallItems)
  assert.equal(pruneTokens + noRecTokens, report.totals.zeroCallTokens)
  for (const entry of report.findings.prunePlan) {
    assert.ok(entry.kind === 'plugin' || entry.kind === 'mcp-server')
    assert.equal(entry.reclaimableTokens, entry.items.reduce((sum, item) => sum + item.tokens, 0))
    assert.equal(entry.itemCount, entry.items.length)
    if (entry.kind === 'mcp-server') assert.deepEqual(entry.factPackages, [])
    else assert.ok(entry.factPackages.length >= 1)
  }
  const pruneIds = report.findings.prunePlan.flatMap(entry => entry.items.map(item => item.id))
  assert.equal(new Set(pruneIds).size, pruneIds.length) // 同一项不重复计入
  // 不可观测（calls === null）的项绝不进候选
  for (const entry of report.findings.prunePlan) {
    for (const item of entry.items) {
      assert.equal(byName.get(item.id).zeroCall, true)
    }
  }
  // ── R6（v3）：真机隐藏候选 ──
  const hideFindings = report.findings
  assert.equal(report.version, 4)
  assert.equal(hideFindings.hidePlanBasis, 'model-tool-calls-only')
  // H1/H2/H3：可隐藏 token = 全部零调用工具的自身 token 之和
  assert.equal(hideFindings.hidePlanTokens, hideFindings.hidePlan.reduce((sum, entry) => sum + entry.tokens, 0))
  assert.equal(hideFindings.hidePlanTokens, report.totals.zeroCallTokens)
  assert.equal(hideFindings.hidePlan.length, report.items.filter(item => item.zeroCall === true
    && (item.category === 'tools' || item.category === 'mcp')).length)
  // H4：单元汇总守恒
  assert.equal(hideFindings.hidePlanUnits.reduce((sum, unit) => sum + unit.tokens, 0), hideFindings.hidePlanTokens)
  assert.equal(hideFindings.hidePlanUnits.reduce((sum, unit) => sum + unit.toolCount, 0), hideFindings.hidePlan.length)
  // H6：denyList 与 skipped 是候选集合的一个划分
  assert.equal(hideFindings.hideApply.denyList.length + hideFindings.hideApply.skipped.length, hideFindings.hidePlan.length)
  // 三态（§2.23.3 第 3 行）：本用例注入的假 tools 服务**没有** `restrict`/`view`
  // ⇒ 如实降级为 `unsupported`；候选照列（仍是有效诊断），但绝不抛错、绝不给可照抄的 denyList。
  // （`unvalidated` 与 `prechecked` 两态在 test/host.test.js 用带接口的假 ctx 覆盖。）
  assert.equal(hideFindings.hidePlanStatus, 'unsupported')
  assert.equal(hideFindings.hideApply.interfacePresent, false)
  assert.deepEqual(hideFindings.hideApply.denyList, [])
  assert.equal(hideFindings.hideApply.applySupported, false)
  // H4 硬约束：默认只建议，永不自动施加
  assert.equal(hideFindings.hideApply.mode, 'suggestion-only')
  assert.deepEqual(hideFindings.hideApply.appliedNames, [])
  // 每个候选都带 registryUse（含 verdictBasis）与 precheck
  for (const entry of hideFindings.hidePlan) {
    assert.equal(entry.registryUse.verdict, 'unconfirmed')
    assert.equal(entry.registryUse.verdictBasis, 'no-non-model-observability')
    assert.equal(entry.registryUse.modelCalls, 0)
    assert.equal(entry.precheck.restrictable, null) // 未校验绝不能用 false 冒充
    assert.equal(entry.precheck.reason, 'interface-absent')
  }
  // 与 prunePlan 并存且不改其字段；两个动作的 token 不得相加
  assert.equal(hideFindings.prunePlanBasis, 'model-tool-calls-only')
  assert.ok(hideFindings.hidePlanTokens >= hideFindings.prunePlanReclaimableTokens)
  const r6Render = renderLedger(report)
  assert.match(r6Render, /Hide candidates \(tool level\) — needs manual confirmation: \d+ tokens/)
  assert.match(r6Render, /Hide caveats: registry-level hide, not schema-only;/)
  assert.match(r6Render, /Do not add the hide tokens to the uninstall candidates/)
  assert.equal(r6Render.includes(String(hideFindings.hidePlanTokens + hideFindings.prunePlanReclaimableTokens)), false)
  assert.equal(r6Render.includes(SENTINEL), false)
  assert.deepEqual(whitelistOffenders(report), [])

  t.diagnostic(`providerScan: ${JSON.stringify(report.scope.providerScan)}`)
  t.diagnostic(`hidePlan: ${hideFindings.hidePlanTokens} tokens / ${hideFindings.hidePlan.length} tools /`
    + ` status=${hideFindings.hidePlanStatus} / mode=${hideFindings.hideApply.mode} /`
    + ` 单元=${hideFindings.hidePlanUnits.map(unit => `${unit.kind}:${unit.target ?? '-'}(${unit.tokens})`).join(' ')}`)
  t.diagnostic(`prunePlan（真实数据）:\n${report.findings.prunePlan.map(entry =>
    `  - ${entry.kind} ${entry.target}: ${entry.itemCount} tools, ${entry.reclaimableTokens} tokens,`
    + ` usedToolCount=${entry.usedToolCount}, confidence=${entry.confidence}`
    + (entry.factPackages.length > 0 ? `, factPackages=${entry.factPackages.join('|')}` : '')).join('\n')}`)
  t.diagnostic(`noRecommendation: ${JSON.stringify(report.findings.noRecommendation)}`)
})

test('E2E③：S2 载荷不变性差分证明（真实日志 + 哨兵副本）', { skip }, async () => {
  const source = sessions[0].logPath
  const tmpRoot = mkdtempSync(join(tmpdir(), 'context-ledger-e2e-'))
  tmpRoots.push(tmpRoot)
  const copyPath = join(tmpRoot, 'session.v4.jsonl')

  // 解压 → 把所有载荷字段换成哨兵 → 写副本（原日志绝不改动）
  const raw = await new Promise((resolve, reject) => {
    const child = spawn('zstd', ['-dc', source], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { out += chunk })
    child.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`zstd exit ${code}`))))
    child.on('error', reject)
  })
  const lines = raw.split('\n').filter(line => line.trim() !== '')
  const rewritten = lines.map((line) => {
    const record = JSON.parse(line)
    return JSON.stringify(sentinelize(record, 'root'))
  })
  // S2 的两份输入都必须**冻结**：基准副本 + 哨兵副本。
  // 活动会话日志在测试执行期间仍在增长；若只冻结一份、另一份去重读活文件，
  // 断言就退化成"同一活文件读两次并比较"，会随窗口漂移而 flaky（t11 修复）。
  const basePath = join(tmpRoot, 'baseline.jsonl')
  writeFileSync(basePath, `${lines.join('\n')}\n`)
  writeFileSync(copyPath, `${rewritten.join('\n')}\n`)
  // 报告侧也只喂冻结快照：临时 DSH_HOME 下只放这一个会话目录
  const frozenHome = join(tmpRoot, 'home')
  mkdirSync(join(frozenHome, 'sessions', WORKSPACE_KEY, 'sess-frozen'), { recursive: true })
  writeFileSync(join(frozenHome, 'sessions', WORKSPACE_KEY, 'sess-frozen', 'session.v4.jsonl'), `${lines.join('\n')}\n`)

  const usageOriginal = await host.readSessionUsage(basePath, MAX_LINES_PER_SESSION)
  const usageCopy = await host.readSessionUsage(copyPath, MAX_LINES_PER_SESSION)
  // 载荷变了，计数一模一样（两份输入都冻结 ⇒ 断言确定）
  assert.deepEqual(usageCopy, usageOriginal)
  assert.equal(usageOriginal.linesRead, lines.length)
  assert.ok(usageOriginal.toolCalls > 0)

  // 用同一份成本表、同一份 scope 分别对账：除 generatedAt 外逐字节相同
  // 报告侧也只用冻结输入（frozenHome），于是下面的 prunePlan 交叉断言同样在
  // "两份冻结派生"之间成立——全程不再读任何活会话日志。
  const declared = await readDeclaredTools(basePath)
  // 防静默退化：冻结快照里必须真的读到声明面（否则 S2 就变成"空对空"）
  assert.ok(declared !== null && declared.length > 0, '冻结基准快照应含 request/header 的 tools 声明')
  const report = await host.gatherLedger({
    fs: realFs,
    skills: { list: async () => REAL_SKILLS },
    tools: { schemas: () => declared },
    dshHome: frozenHome,
    profileDir: PROFILE_DIR,
    coreScopeDir: host.resolveCoreScopeDir(),
  }, { cwd: WORKSPACE, sessions: 1 })
  const costItems = report.items
  assert.ok(costItems.some(item => item.category === 'tools'), '差分报告的成本侧必须含工具项')
  // 从真机报告里复原归属输入，让差分报告与真机报告形状一致
  const byName = Object.fromEntries(report.items.filter(item => item.providedBy).map(item => [item.name, item.providedBy]))
  const manifest = host.readProfileManifest(PROFILE_DIR)
  const facts = [...new Set(Object.values(byName).filter(entry => entry.kind === 'plugin').map(entry => entry.name))]
  const provenance = {
    byName,
    bundleOwners: host.resolveBundleOwners(PROFILE_DIR, facts, manifest === null ? [] : manifest.removable),
  }
  const scope = {
    workspaceKey: WORKSPACE_KEY,
    sessionsAvailable: report.scope.sessionsAvailable,
    sessionsScanned: 1,
    sessionsUnreadable: 0,
    sessionsLimit: 1,
    windowStart: report.scope.windowStart,
    windowEnd: report.scope.windowEnd,
    linesRead: usageOriginal.linesRead,
    skillToolCalls: usageOriginal.skillToolCalls,
    namesRejected: usageOriginal.namesRejected,
    truncated: usageOriginal.truncated,
  }
  const { reconcile } = await import('../lib/reconcile.js')
  const fromOriginal = reconcile({ cwd: WORKSPACE, sessionsRoot: SESSIONS_ROOT, scope, callsByName: usageOriginal.callsByName, provenance, items: costItems })
  const fromCopy = reconcile({ cwd: WORKSPACE, sessionsRoot: SESSIONS_ROOT, scope, callsByName: usageCopy.callsByName, provenance, items: costItems })
  assert.equal(normalize(fromCopy), normalize(fromOriginal))
  assert.equal(renderLedger(fromCopy), renderLedger(fromOriginal))
  assert.equal(JSON.stringify(fromOriginal).includes(SENTINEL), false)
  assert.deepEqual(whitelistOffenders(fromOriginal), [])
  // 携带项①（t14）防退化守卫：`fromOriginal.findings.prunePlan` 与真机报告比对时，
  // 若归属扫描整体退化（0 包 0 文件），两侧都会是 []，断言会**静默恒真**。
  // 这里先把"确实归属到了东西"变成硬断言——与真机侧同一条守卫。
  assert.ok(report.scope.providerScan.packages > 0, '差分侧同样要求归属扫描真的扫到候选包')
  assert.ok(report.scope.providerScan.files > 0)
  assert.ok(Object.keys(provenance.byName).length > 0, '归属通道不得为空（否则差分断言静默成立）')
  assert.ok(costItems.some(item => item.providedBy !== undefined))
  // 归属与省额也和真机报告一致。报告侧同样只读冻结快照（frozenHome），
  // 因此这条断言也在"两份冻结派生"之间成立，不再随活文件漂移（t11）。
  assert.deepEqual(fromOriginal.findings.prunePlan, report.findings.prunePlan)
})

test('E2E⑤：S2 夹具纪律（回归测试）——输入不冻结就会漂移，冻结后免疫', { skip }, async () => {
  // 这份用例把 t11 的根因**复现**成可断言的形态，不碰任何真实会话日志：
  // ① 旧写法（读活文件两次并比较）在活文件被追加后必然失败；
  // ② 新写法（基准副本 + 哨兵副本都冻结）对后续追加免疫。
  const tmpRoot = mkdtempSync(join(tmpdir(), 'context-ledger-drift-'))
  tmpRoots.push(tmpRoot)
  const livePath = join(tmpRoot, 'live.jsonl')
  const basePath = join(tmpRoot, 'baseline.jsonl')
  const copyPath = join(tmpRoot, 'sentinel.jsonl')

  const line = (type, data) => JSON.stringify({ type, seq: 1, time: 1, data })
  const seed = [
    line('session', { id: 'sess-drift' }),
    line('tool/call', { callId: 'c1', name: 'bash', arguments: { secret: SENTINEL } }),
    line('tool/result', { message: SENTINEL }),
  ]
  writeFileSync(livePath, `${seed.join('\n')}\n`)
  // 冻结：基准副本（原载荷）+ 哨兵副本（载荷替换）
  const snapshot = seed
  writeFileSync(basePath, `${snapshot.join('\n')}\n`)
  writeFileSync(copyPath, `${snapshot.map(entry => JSON.stringify(sentinelize(JSON.parse(entry), 'root'))).join('\n')}\n`)

  // 快照之后，活文件又被追加了一次 tool/call（模拟并发团队的持续写入）
  writeFileSync(livePath, `${[...seed, line('tool/call', { callId: 'c2', name: 'read', arguments: {} })].join('\n')}\n`)

  const liveFirst = await host.readSessionUsage(livePath, MAX_LINES_PER_SESSION)
  const liveSecond = await host.readSessionUsage(livePath, MAX_LINES_PER_SESSION)
  const base = await host.readSessionUsage(basePath, MAX_LINES_PER_SESSION)
  const copy = await host.readSessionUsage(copyPath, MAX_LINES_PER_SESSION)

  // ① 活文件在增长：两次读取确实会不一致（这正是旧断言 flaky 的机制）
  assert.equal(liveFirst.toolCalls, liveSecond.toolCalls, '同一次读取之间不应变化')
  assert.notDeepEqual(liveSecond, base, '活文件在快照后增长 ⇒ 与快照必然不同（旧写法的失败模式）')
  assert.equal(liveSecond.toolCalls, base.toolCalls + 1)
  // ② 冻结的两份输入不受后续追加影响，S2 断言因此确定
  assert.deepEqual(copy, base)
  assert.equal(copy.linesRead, base.linesRead)
  assert.equal(JSON.stringify(copy).includes(SENTINEL), false)
})

test('E2E④：scanInstructionChain 在真实磁盘上工作（去重 / loadOrder / 体积上限）', { skip }, async (t) => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'context-ledger-chain-'))
  tmpRoots.push(tmpRoot)
  const outer = join(tmpRoot, 'AGENTS.md')
  const nested = join(tmpRoot, 'sub')
  const outerText = '# outer rules\n\nkeep it read-only.\n'
  writeFileSync(outer, outerText)
  // `.git` 让宿主把这一层认作项目根：指令链 = 根 → cwd（外层 → 内层）
  mkdirSync(join(tmpRoot, '.git'), { recursive: true })
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(nested, 'AGENTS.md'), '# nested rules\n\nmore specific wins.\n')
  // 内容逐字节相同的 CLAUDE.md：宿主只注入一份，这里也必须只算一份
  writeFileSync(join(tmpRoot, 'CLAUDE.md'), outerText)
  // 超过 MAX_INSTRUCTION_FILE_BYTES 的文件：跳过
  writeFileSync(join(nested, 'CLAUDE.md'), 'x'.repeat(host.MAX_INSTRUCTION_FILE_BYTES + 1))

  const chain = await host.scanInstructionChain(realFs, nested, { dshHome: DSH_HOME })
  assert.equal(chain.root, tmpRoot) // 有 .git：root = 项目根（与宿主注入链对齐）
  assert.deepEqual(chain.files.map(file => file.path), [
    join(tmpRoot, 'AGENTS.md'),
    join(nested, 'AGENTS.md'),
  ])
  assert.deepEqual(chain.files.map(file => file.loadOrder), [1, 2])
  assert.deepEqual(chain.files.map(file => file.source), ['project', 'project'])
  assert.equal(chain.files[0].bytes, Buffer.byteLength(outerText, 'utf8'))
  const items = instructionItems(chain.files, chain.root)
  assert.deepEqual(items.map(item => item.tokens), [
    estimateTokens(outerText),
    estimateTokens('# nested rules\n\nmore specific wins.\n'),
  ])
  assert.deepEqual(items.map(item => item.loadOrder), [1, 2])

  // 真实工作区（当前没有 AGENTS.md/CLAUDE.md）：instructions 类应如实为空
  const report = await host.gatherLedger({
    fs: realFs,
    skills: { list: async () => REAL_SKILLS },
    tools: { schemas: () => [{ name: 'bash', description: 'Run a shell command.' }] },
    dshHome: DSH_HOME,
    profileDir: PROFILE_DIR,
    coreScopeDir: host.resolveCoreScopeDir(),
  }, { cwd: WORKSPACE, sessions: 1 })
  const instructions = report.items.filter(item => item.category === 'instructions')
  for (const item of instructions) {
    assert.equal(item.usageBasis, 'always-on')
    assert.equal(item.calls, null)
    assert.equal(item.zeroCall, null)
    assert.ok(item.tokens > 0)
    assert.match(item.id, /^instructions:\//)
    assert.equal(item.source === 'project' || item.source === 'user', true)
    assert.ok(item.loadOrder >= 1)
  }
  t.diagnostic(`workspace instruction files: ${instructions.length}`)
  // 技能目录逐项不可观测，分类级只给机制量
  const skills = report.categories.find(entry => entry.key === 'skills')
  assert.equal(skills.itemCount, REAL_SKILLS.length)
  assert.equal(skills.calls, null)
  assert.equal(skills.tokensPerCall, null)
  assert.equal(skills.mechanismCalls, report.scope.skillToolCalls)
  assert.equal(
    skills.tokens,
    REAL_SKILLS.reduce((sum, skill) => sum + estimateTokens(skill.name) + estimateTokens(skill.description), 0),
  )
})
