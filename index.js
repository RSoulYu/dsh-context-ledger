/**
 * dsh-context-ledger — **宿主半区**（唯一允许出现宿主依赖的文件）。
 *
 * 职责：取宿主服务（`ctx.tools` / `ctx.skills` / `ctx.fs`）→ 组装四类常驻注入物的
 * 成本表 → 回放会话日志得到真实调用次数 → 交给 `lib/reconcile.js` 对账 → 注册
 * `context_ledger` 工具，并在有 Web 服务时可选注册 HTTP 路由（headless 自动跳过）。
 *
 * 只读：不写文件（HTTP 缓存只在内存）、不改 `~/.dsh/**`、不读任何会话正文。
 * `lib/**` 全部是纯函数，宿主依赖只在这里出现（`node --test` 才能直接跑）。
 *
 * @module dsh-context-ledger
 */

import { spawn } from 'node:child_process'
import { createReadStream, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { instructionItems, skillItems, toolItems } from './lib/cost.js'
import { FINDINGS_LIMIT, LEDGER_TOOL, LEDGER_UNIT, LEDGER_VERSION, reconcile, renderLedger } from './lib/reconcile.js'
import { ESTIMATOR } from './lib/tokens.js'
import { MAX_LINES_PER_SESSION, createUsageCounter, projectKey } from './lib/usage.js'

/** 插件 id（与 `cordis.patch.yml` 的 row id 对应）。 */
export const name = 'context-ledger'

/**
 * 必需服务：文件系统（读指令链）、技能注册表（读技能目录）、工具注册表
 * （读可见 schema 并注册 `context_ledger`）。`webServer` 不在其中——它是可选能力，
 * 用 `ctx.inject(['webServer'], …)` 挂载，headless 环境自动跳过。
 */
export const inject = ['fs', 'skills', 'tools']

/** 默认回放会话数（DESIGN §2.8）。 */
export const DEFAULT_SESSIONS = 20
/** 回放会话数上限，越界夹取不报错（DESIGN §2.8）。 */
export const MAX_SESSIONS = 200
/** 指令链单文件上限，超出跳过（DESIGN §2.8）。 */
export const MAX_INSTRUCTION_FILE_BYTES = 262144
/** HTTP 路由结果缓存时长（DESIGN §2.8）。 */
export const CACHE_TTL_MS = 60000
/** 浏览器半区的数据入口（DESIGN §4.1）。 */
export const LEDGER_API_PATH = '/api/context-ledger/ledger'

/** 指令链文件名（与宿主 workspace instruction 注入链对齐）。 */
const INSTRUCTION_NAMES = ['AGENTS.md', 'CLAUDE.md']
/** 会话日志文件名：`session.v<生成代>.jsonl[.zstd]`（DESIGN §1）。 */
const SESSION_LOG_PATTERN = /^session\.v(\d+)\.jsonl(\.zstd)?$/

/**
 * 解析 DSH home：`DSH_HOME` 优先，缺省 `~/.dsh`。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveDshHome(env = process.env) {
  const configured = typeof env?.DSH_HOME === 'string' && env.DSH_HOME !== '' ? env.DSH_HOME : ''
  return configured !== '' ? configured : join(homedir(), '.dsh')
}

/**
 * 会话日志根目录。
 * @param {string} dshHome
 * @returns {string}
 */
export function sessionsRootOf(dshHome) {
  return join(dshHome, 'sessions')
}

/**
 * 夹取 `sessions` 参数（1..200，缺省 20，越界夹取不报错）。
 * @param {unknown} value
 * @returns {number}
 */
export function clampSessions(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SESSIONS
  return Math.min(MAX_SESSIONS, Math.max(1, Math.round(n)))
}

/**
 * 取当前 agent 可见的工具 schema。
 *
 * `schemas()` 在 DSH 里只白名单 `name` / `description` / `parameters`——它本身就是
 * 送给模型的那一份，所以直接拿它量常驻成本。
 * @param {{schemas: Function}} tools
 * @param {unknown} [agent]
 * @returns {Array<{name: string, description?: string, parameters?: unknown}>}
 */
export function visibleSchemas(tools, agent) {
  try {
    const schemas = agent === undefined ? tools.schemas() : tools.schemas(agent)
    return Array.isArray(schemas) ? schemas : []
  } catch {
    try {
      const schemas = tools.schemas()
      return Array.isArray(schemas) ? schemas : []
    } catch {
      return []
    }
  }
}

/**
 * 列出某个工作区下的会话目录（按日志 mtime 降序 = 最近优先）。
 *
 * 只读目录项与 mtime，不读日志内容（内容由 {@link readSessionUsage} 流式回放）。
 * @param {string} sessionsRoot - `<DSH_HOME>/sessions`
 * @param {string} workspaceKey - {@link projectKey} 的结果
 * @returns {Array<{id: string, logPath: string, mtimeMs: number}>}
 */
export function listWorkspaceSessions(sessionsRoot, workspaceKey) {
  /** @type {Array<{id: string, logPath: string, mtimeMs: number}>} */
  const found = []
  let entries
  try {
    entries = readdirSync(join(sessionsRoot, workspaceKey), { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(sessionsRoot, workspaceKey, entry.name)
    let files
    try {
      files = readdirSync(dir)
    } catch {
      continue
    }
    let best = null
    let bestGeneration = -1
    for (const file of files) {
      const match = SESSION_LOG_PATTERN.exec(file)
      if (match === null) continue
      const generation = Number(match[1])
      if (generation < bestGeneration) continue
      if (generation === bestGeneration && best !== null && !(match[2] === '.zstd')) continue
      bestGeneration = generation
      best = file
    }
    if (best === null) continue
    const logPath = join(dir, best)
    let mtimeMs = 0
    try {
      const info = statSync(logPath)
      if (!info.isFile()) continue
      mtimeMs = info.mtimeMs
    } catch {
      continue
    }
    found.push({ id: entry.name, logPath, mtimeMs })
  }
  // mtime 降序；同 mtime 用 id 兜底，保证顺序确定。
  found.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.id < b.id ? 1 : (a.id > b.id ? -1 : 0)))
  return found
}

/**
 * 流式回放一个会话日志，数工具调用次数。
 *
 * `.zstd` 用系统 `zstd -dc` 解压（DESIGN §1）；未压缩的 `.jsonl` 直接读。
 * 逐行喂给 `lib/usage.js` 的计数器，触达行数上限立刻停读并杀掉子进程。
 *
 * 任何**非主动**失败（zstd 缺失 / 退出码非 0 / 读流错误）一律抛出，由调用方计入
 * `sessionsUnreadable`：半截回放会低估次数，进而产生假的「零调用」，宁可不报。
 *
 * @param {string} logPath
 * @param {number} limit - 最多检视行数
 * @param {AbortSignal} [signal]
 * @returns {Promise<ReturnType<ReturnType<typeof createUsageCounter>['result']>>}
 */
export async function readSessionUsage(logPath, limit = MAX_LINES_PER_SESSION, signal) {
  const counter = createUsageCounter(limit)
  const isZstd = logPath.endsWith('.zstd')
  const child = isZstd ? spawn('zstd', ['-dc', logPath], { stdio: ['ignore', 'pipe', 'ignore'] }) : null
  const source = child !== null ? child.stdout : createReadStream(logPath)
  /** @type {Error | null} */
  let failure = null
  let stoppedEarly = false

  if (child !== null) {
    child.on('error', (error) => {
      if (failure === null) failure = error instanceof Error ? error : new Error(String(error))
    })
    child.on('close', (code) => {
      if (code !== 0 && failure === null) failure = new Error(`zstd exited with code ${code}`)
    })
  } else {
    source.on('error', (error) => {
      if (failure === null) failure = error instanceof Error ? error : new Error(String(error))
    })
  }

  try {
    const iface = createInterface({ input: source, crlfDelay: Infinity })
    for await (const line of iface) {
      if (signal?.aborted) {
        stoppedEarly = true
        iface.close()
        source.destroy()
        child?.kill()
        break
      }
      if (!counter.feed(line)) {
        // 触达行数上限：主动停读，不是失败。
        stoppedEarly = true
        iface.close()
        source.destroy()
        child?.kill()
        break
      }
    }
  } catch (error) {
    if (failure === null) failure = error instanceof Error ? error : new Error(String(error))
  } finally {
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        const done = () => resolve(undefined)
        child.once('close', done)
        child.once('error', done)
      })
    }
  }

  if (signal?.aborted) throw new Error('aborted while replaying session log')
  if (failure !== null && !stoppedEarly) throw /** @type {Error} */ (failure)
  return counter.result()
}

/**
 * 判断路径是否存在于文件系统抽象里。
 * @param {any} fs - `ctx.fs`
 * @param {string} path
 * @param {AbortSignal} [signal]
 * @returns {Promise<boolean>}
 */
async function pathExists(fs, path, signal) {
  try {
    const target = await fs.resolve(path, { signal })
    return (await fs.stat(target, signal)) !== undefined
  } catch {
    return false
  }
}

/**
 * 扫描指令链（DESIGN §2.4 `instructions` 类）。
 *
 * 与宿主注入链对齐：用户全局 `<DSH_HOME>/AGENTS.md`（`source: "user"`）在前，
 * 项目链从 git 根（找不到 `.git` 时退化为从文件系统根起）到 `cwd` 逐层的
 * `AGENTS.md` / `CLAUDE.md`（`source: "project"`，外层 → 内层）在后。
 *
 * 去重与宿主一致：真实路径相同（符号链接折叠）或内容逐字节相同的文件只算一份，
 * 否则报告会和模型实际看到的对不上。
 *
 * @param {any} fs - `ctx.fs`
 * @param {string} cwd
 * @param {{dshHome: string, signal?: AbortSignal}} options
 * @returns {Promise<{root: string, files: Array<{path: string, text: string, bytes: number, source: string, loadOrder: number}>}>}
 */
export async function scanInstructionChain(fs, cwd, options) {
  const signal = options.signal
  /** @type {Array<{path: string, text: string, bytes: number, source: string, loadOrder: number}>} */
  const files = []
  const seenPaths = new Set()
  const seenContents = new Set()
  let loadOrder = 0

  const collect = async (path, source) => {
    let target
    try {
      target = await fs.resolve(path, { signal })
    } catch {
      return // 不存在 / 不可解析 / 越界
    }
    const realPath = fs.processPath(target)
    if (seenPaths.has(realPath)) return
    let info
    try {
      info = await fs.stat(target, signal)
    } catch {
      return
    }
    if (info === undefined || info.type !== 'file') return
    if (Number.isFinite(info.size) && info.size > MAX_INSTRUCTION_FILE_BYTES) return // 与 DESIGN §2.8 常量一致
    let text
    try {
      text = await fs.readText(target, signal)
    } catch {
      return
    }
    if (seenContents.has(text)) {
      seenPaths.add(realPath)
      return
    }
    seenPaths.add(realPath)
    seenContents.add(text)
    loadOrder += 1
    files.push({
      path: realPath,
      text,
      bytes: Number.isFinite(info.size) ? info.size : Buffer.byteLength(text, 'utf8'),
      source,
      loadOrder,
    })
  }

  // 1. 用户全局指令文件。
  const dshHome = typeof options.dshHome === 'string' && options.dshHome !== ''
    ? options.dshHome
    : resolveDshHome()
  await collect(join(dshHome, 'AGENTS.md'), 'user')

  // 2. 项目链：先找 git 根（含 .git 的最上层目录）。
  let root = cwd
  let current = cwd
  for (;;) {
    if (await pathExists(fs, join(current, '.git'), signal)) {
      root = current
      break
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  const layers = []
  current = cwd
  for (;;) {
    layers.push(current)
    if (current === root) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  layers.reverse() // 外层 → 内层（DESIGN §2.4 `loadOrder` 从 1 起）
  for (const dir of layers) {
    for (const fileName of INSTRUCTION_NAMES) {
      await collect(join(dir, fileName), 'project')
    }
  }

  return { root, files }
}

/**
 * 组装一份对账报告：成本表（指令链 / 技能目录 / 工具 schema） × 会话日志回放。
 *
 * @param {{fs: any, skills: any, tools: any, dshHome: string}} deps
 * @param {{cwd: string, sessions?: number, signal?: AbortSignal, agent?: unknown}} options
 * @returns {Promise<Record<string, unknown>>} canonical `context_ledger` 报告
 */
export async function gatherLedger(deps, options) {
  const cwd = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : process.cwd()
  const signal = options.signal
  const sessionsLimit = clampSessions(options.sessions)
  const dshHome = typeof deps.dshHome === 'string' && deps.dshHome !== '' ? deps.dshHome : resolveDshHome()

  // ── 1. 成本侧 ────────────────────────────────────────────────────────────
  const schemas = visibleSchemas(deps.tools, options.agent)

  let skillList = []
  try {
    // 技能查询必须带 scope（调用方 agent 即 scope key），否则只读 global 层。
    skillList = await deps.skills.list({
      cwd,
      signal,
      ...(options.agent !== undefined && options.agent !== null ? { scope: options.agent } : {}),
    })
  } catch {
    skillList = []
  }
  const modelSkills = (Array.isArray(skillList) ? skillList : [])
    .filter(skill => skill !== null && typeof skill === 'object' && skill.invocation?.modelInvocable !== false)

  let instructions = { root: cwd, files: [] }
  try {
    instructions = await scanInstructionChain(deps.fs, cwd, { dshHome, signal })
  } catch {
    instructions = { root: cwd, files: [] }
  }

  const items = [
    ...instructionItems(instructions.files, instructions.root),
    ...skillItems(modelSkills),
    ...toolItems(schemas),
  ]

  // ── 2. 使用侧：会话日志回放（只取工具名与计数） ──────────────────────────
  const workspaceKey = projectKey(cwd)
  const sessionsRoot = sessionsRootOf(dshHome)
  const available = listWorkspaceSessions(sessionsRoot, workspaceKey)
  const selected = available.slice(0, sessionsLimit)

  /** @type {Map<string, number>} */
  const counts = new Map()
  let sessionsScanned = 0
  let sessionsUnreadable = 0
  let linesRead = 0
  let skillToolCalls = 0
  let namesRejected = 0
  let truncated = false
  /** @type {number | null} */
  let oldest = null
  /** @type {number | null} */
  let newest = null

  for (const entry of selected) {
    if (signal?.aborted === true) break
    let usage
    try {
      usage = await readSessionUsage(entry.logPath, MAX_LINES_PER_SESSION, signal)
    } catch {
      sessionsUnreadable += 1
      continue
    }
    sessionsScanned += 1
    linesRead += usage.linesRead
    skillToolCalls += usage.skillToolCalls
    namesRejected += usage.namesRejected
    truncated = truncated || usage.truncated
    for (const [toolName, count] of Object.entries(usage.callsByName)) {
      counts.set(toolName, (counts.get(toolName) ?? 0) + count)
    }
    if (entry.mtimeMs > 0) {
      oldest = oldest === null ? entry.mtimeMs : Math.min(oldest, entry.mtimeMs)
      newest = newest === null ? entry.mtimeMs : Math.max(newest, entry.mtimeMs)
    }
  }

  /** @type {Record<string, number>} */
  const callsByName = {}
  for (const toolName of [...counts.keys()].sort()) {
    Object.defineProperty(callsByName, toolName, {
      value: counts.get(toolName) ?? 0,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }

  // ── 3. 对账（calls / tokensPerCall / zeroCall / usageBasis 的唯一赋权点） ──
  return reconcile({
    cwd,
    sessionsRoot,
    findingsLimit: FINDINGS_LIMIT,
    callsByName,
    scope: {
      workspaceKey,
      sessionsRoot,
      sessionsAvailable: available.length,
      sessionsScanned,
      sessionsUnreadable,
      sessionsLimit,
      windowStart: oldest === null ? null : new Date(oldest).toISOString(),
      windowEnd: newest === null ? null : new Date(newest).toISOString(),
      linesRead,
      skillToolCalls,
      namesRejected,
      truncated,
    },
    items,
  })
}

/**
 * 从查询串取单个参数（URL 解码；重复取首个）。
 * @param {string} url
 * @param {string} key
 * @returns {string | undefined}
 */
function parseQueryParam(url, key) {
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
  for (const part of query.split('&')) {
    if (!part.startsWith(`${key}=`)) continue
    try {
      return decodeURIComponent(part.slice(key.length + 1))
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * 写 JSON 响应。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * 构造 HTTP 路由（DESIGN §4.1）：`GET /api/context-ledger/ledger?session=<id>&sessions=<n>`
 * → `{ ok, report }`，宿主侧 60s 内存缓存（不落盘、不写文件）。
 *
 * @param {{deps: any, sessions?: {get(id: string): any}, defaultCwd?: string, cacheTtlMs?: number}} config
 * @returns {Array<{kind: 'exact', path: string, handler: (req: any, res: any) => void}>}
 */
export function makeLedgerRoutes(config) {
  const cacheTtlMs = Number.isFinite(config.cacheTtlMs) ? config.cacheTtlMs : CACHE_TTL_MS
  const defaultCwd = typeof config.defaultCwd === 'string' && config.defaultCwd !== ''
    ? config.defaultCwd
    : process.cwd()
  /** @type {Map<string, {at: number, promise: Promise<Record<string, unknown>>}>} */
  const cache = new Map()
  const maxCacheEntries = 32

  const report = (cwd, sessions, agent) => {
    const key = `${cwd} ${sessions}`
    const hit = cache.get(key)
    if (hit !== undefined && Date.now() - hit.at < cacheTtlMs) return hit.promise
    if (cache.size >= maxCacheEntries) {
      const oldestKey = cache.keys().next().value
      if (oldestKey !== undefined) cache.delete(oldestKey)
    }
    const promise = gatherLedger(config.deps, {
      cwd,
      sessions,
      signal: new AbortController().signal,
      ...(agent !== undefined ? { agent } : {}),
    }).catch((error) => {
      cache.delete(key) // 失败不缓存，允许下次重试
      throw error
    })
    cache.set(key, { at: Date.now(), promise })
    return promise
  }

  return [{
    kind: 'exact',
    path: LEDGER_API_PATH,
    handler: (req, res) => {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      const url = req.url ?? ''
      // cwd 显式参数（诊断/curl 用）> session 解析 > 默认目录。
      const explicitCwd = parseQueryParam(url, 'cwd')
      const sessionId = parseQueryParam(url, 'session')
      let cwd = explicitCwd !== undefined && explicitCwd !== '' ? explicitCwd : undefined
      let agent
      if (cwd === undefined && sessionId !== undefined && sessionId !== '') {
        const session = config.sessions?.get(sessionId)
        const sessionCwd = session?.header?.cwd
        if (typeof sessionCwd === 'string' && sessionCwd !== '') cwd = sessionCwd
      }
      if (cwd === undefined) cwd = defaultCwd
      if (sessionId !== undefined && sessionId !== '' && config.deps?.agents !== undefined) {
        agent = config.deps.agents.get(sessionId)
      }
      const sessions = clampSessions(parseQueryParam(url, 'sessions'))
      report(cwd, sessions, agent).then(
        value => json(res, 200, { ok: true, report: value }),
        (error) => json(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    },
  }]
}

/** `context_ledger` 工具描述（DESIGN §2.10，冻结文本，英文）。 */
const TOOL_DESCRIPTION =
  'Reconcile the resident cost of every injected context item against how often it is actually '
  + 'called in this workspace\'s session logs. Reports, per item: token cost, call count, '
  + 'cost-per-use (tokens ÷ calls) and whether it was never called. Read-only: it never writes a '
  + 'file, never reads message content, and extracts only tool names and counts from session logs.'

/** 可空整数（`calls` / `tokensPerCall` / …）。 */
function nullableInteger() {
  return { oneOf: [{ type: 'integer' }, { type: 'null' }] }
}

/** 可空布尔（`zeroCall`）。 */
function nullableBoolean() {
  return { oneOf: [{ type: 'boolean' }, { type: 'null' }] }
}

/** §2.4 的 `items[]` 输出 schema。 */
function itemSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      category: { type: 'string', enum: ['instructions', 'skills', 'tools', 'mcp'] },
      name: { type: 'string' },
      tokens: { type: 'integer' },
      calls: nullableInteger(),
      tokensPerCall: nullableInteger(),
      zeroCall: nullableBoolean(),
      usageBasis: { type: 'string', enum: ['tool-calls', 'no-evidence', 'unobservable', 'always-on'] },
      source: { type: 'string' },
      server: { type: 'string' },
      bytes: { type: 'integer' },
      provider: { type: 'string' },
      loadOrder: { type: 'integer' },
    },
  }
}

/** §2.3 的 `categories[]` 输出 schema。 */
function categorySchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      key: { type: 'string', enum: ['instructions', 'skills', 'tools', 'mcp'] },
      itemCount: { type: 'integer' },
      tokens: { type: 'integer' },
      calls: nullableInteger(),
      tokensPerCall: nullableInteger(),
      observableUsage: { type: 'boolean' },
      mechanismCalls: nullableInteger(),
      mechanismTokensPerCall: nullableInteger(),
    },
  }
}

/** §2.2 的 `scope` 输出 schema。 */
function scopeSchema() {
  const nullableTimestamp = { oneOf: [{ type: 'string' }, { type: 'null' }] }
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      workspaceKey: { type: 'string' },
      sessionsRoot: { type: 'string' },
      sessionsAvailable: { type: 'integer' },
      sessionsScanned: { type: 'integer' },
      sessionsUnreadable: { type: 'integer' },
      sessionsLimit: { type: 'integer' },
      windowStart: nullableTimestamp,
      windowEnd: nullableTimestamp,
      linesRead: { type: 'integer' },
      toolCalls: { type: 'integer' },
      skillToolCalls: { type: 'integer' },
      callsUnmatched: { type: 'integer' },
      callsUnmatchedNames: { type: 'array', items: { type: 'string' } },
      namesRejected: { type: 'integer' },
      usageAvailable: { type: 'boolean' },
      truncated: { type: 'boolean' },
    },
  }
}

/** §2.1 的顶层输出 schema（11 键，`additionalProperties: false`）。 */
function ledgerOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      tool: { type: 'string', const: LEDGER_TOOL },
      version: { type: 'integer', const: LEDGER_VERSION },
      generatedAt: { type: 'string' },
      unit: { type: 'string', const: LEDGER_UNIT },
      estimator: { type: 'string', const: ESTIMATOR },
      cwd: { type: 'string' },
      scope: scopeSchema(),
      categories: { type: 'array', items: categorySchema() },
      items: { type: 'array', items: itemSchema() },
      findings: {
        type: 'object',
        additionalProperties: false,
        properties: {
          zeroCall: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                category: { type: 'string', enum: ['instructions', 'skills', 'tools', 'mcp'] },
                name: { type: 'string' },
                tokens: { type: 'integer' },
              },
            },
          },
          topPerUse: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                category: { type: 'string', enum: ['instructions', 'skills', 'tools', 'mcp'] },
                name: { type: 'string' },
                tokens: { type: 'integer' },
                calls: { type: 'integer' },
                tokensPerCall: nullableInteger(),
              },
            },
          },
        },
      },
      totals: {
        type: 'object',
        additionalProperties: false,
        properties: {
          residentTokens: { type: 'integer' },
          observableTokens: { type: 'integer' },
          unknownUsageTokens: { type: 'integer' },
          observedCalls: { type: 'integer' },
          observableTokensPerCall: nullableInteger(),
          zeroCallItems: { type: 'integer' },
          zeroCallTokens: { type: 'integer' },
          unknownUsageItems: { type: 'integer' },
        },
      },
    },
  }
}

/**
 * 插件入口。
 * @param {any} ctx - cordis 上下文（真实宿主或测试用假 ctx）
 * @param {{defaultCwd?: string, cacheTtlMs?: number}} [config]
 */
export function apply(ctx, config = {}) {
  const deps = {
    fs: ctx.fs,
    skills: ctx.skills,
    tools: ctx.tools,
    dshHome: resolveDshHome(),
    agents: typeof ctx.get === 'function' ? ctx.get('agents') : undefined,
  }
  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined

  // 1. 模型工具：与 HTTP 路由返回同一份 canonical JSON（同一函数产出）。
  ctx.tools.register(defineTool({
    name: LEDGER_TOOL,
    description: TOOL_DESCRIPTION,
    parameters: {
      sessions: {
        type: 'integer',
        description: 'How many recent session logs of this workspace to replay. 1..200, defaults to 20.',
      },
    },
    output: {
      schema: ledgerOutputSchema(),
      render: (_args, value) => [{ type: 'text', text: renderLedger(value) }],
    },
    async execute(args, exec) {
      const agentCwd = exec?.agent?.session?.header?.cwd
      const cwd = typeof agentCwd === 'string' && agentCwd !== '' ? agentCwd : (config.defaultCwd ?? process.cwd())
      return await gatherLedger(deps, {
        cwd,
        sessions: args.sessions,
        signal: exec?.signal,
        ...(exec?.agent !== undefined ? { agent: exec.agent } : {}),
      })
    },
  }))

  // 2. 可选能力：Web 服务存在时注册面板数据路由；headless / CLI 下自动跳过。
  const routes = makeLedgerRoutes({
    deps,
    ...(sessions !== undefined ? { sessions } : {}),
    ...(config.defaultCwd !== undefined ? { defaultCwd: config.defaultCwd } : {}),
    ...(config.cacheTtlMs !== undefined ? { cacheTtlMs: config.cacheTtlMs } : {}),
  })
  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(() => {
      const disposers = routes.map(route => httpCtx.webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'context-ledger: routes')
  })
}
