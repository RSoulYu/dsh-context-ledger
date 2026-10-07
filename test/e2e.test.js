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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  const child = spawn('zstd', ['-dc', logPath], { stdio: ['ignore', 'pipe', 'ignore'] })
  const iface = createInterface({ input: child.stdout, crlfDelay: Infinity })
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
    child.kill()
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
  }, { cwd: WORKSPACE, sessions: 20 })

  // 证据位与观测规模
  assert.equal(report.scope.usageAvailable, true)
  assert.ok(report.scope.sessionsScanned >= 1)
  assert.ok(report.scope.sessionsAvailable >= report.scope.sessionsScanned)
  assert.ok(report.scope.toolCalls > 0, '真实日志应有工具调用')
  assert.equal(report.scope.sessionsLimit, 20)
  assert.match(report.scope.windowStart, /^\d{4}-\d{2}-\d{2}T/)
  assert.match(report.scope.windowEnd, /^\d{4}-\d{2}-\d{2}T/)

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
  writeFileSync(copyPath, `${rewritten.join('\n')}\n`)

  const usageOriginal = await host.readSessionUsage(source, MAX_LINES_PER_SESSION)
  const usageCopy = await host.readSessionUsage(copyPath, MAX_LINES_PER_SESSION)
  // 载荷变了，计数一模一样
  assert.deepEqual(usageCopy, usageOriginal)
  assert.equal(usageOriginal.linesRead, lines.length)
  assert.ok(usageOriginal.toolCalls > 0)

  // 用同一份成本表、同一份 scope 分别对账：除 generatedAt 外逐字节相同
  const declared = await readDeclaredTools(source)
  const report = await host.gatherLedger({
    fs: realFs,
    skills: { list: async () => REAL_SKILLS },
    tools: { schemas: () => declared },
    dshHome: DSH_HOME,
  }, { cwd: WORKSPACE, sessions: 1 })
  const costItems = report.items
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
  const fromOriginal = reconcile({ cwd: WORKSPACE, sessionsRoot: SESSIONS_ROOT, scope, callsByName: usageOriginal.callsByName, items: costItems })
  const fromCopy = reconcile({ cwd: WORKSPACE, sessionsRoot: SESSIONS_ROOT, scope, callsByName: usageCopy.callsByName, items: costItems })
  assert.equal(normalize(fromCopy), normalize(fromOriginal))
  assert.equal(renderLedger(fromCopy), renderLedger(fromOriginal))
  assert.equal(JSON.stringify(fromOriginal).includes(SENTINEL), false)
  assert.deepEqual(whitelistOffenders(fromOriginal), [])
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
