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
import { createReadStream, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { instructionItems, skillItems, toolItems } from './lib/cost.js'
import { DECLARATION_BASIS, SCHEMA_BASIS, readDeclaredFace } from './lib/ptc.js'
import {
  HIDE_MODES, HIDE_PLAN_BASIS, HIDE_PLAN_CAVEAT, PRECHECK_REASONS, PRECHECK_STATUSES,
  REGISTRY_USE_BASIS, REGISTRY_USE_VERDICTS, RESERVED_TOOL_NAMES, normalizeNameCollection,
} from './lib/hide.js'
import {
  NO_RECOMMENDATION_REASONS, PRUNE_KINDS, PRUNE_PLAN_BASIS,
  PROVIDED_BY_CONFIDENCE, PROVIDED_BY_KINDS, PROVIDED_BY_METHODS,
  attributeNames, scanCorpus,
} from './lib/provide.js'
import { FINDINGS_LIMIT, LEDGER_TOOL, LEDGER_UNIT, LEDGER_VERSION, SESSION_LOG_MTIME_BASIS, ZERO_CALL_BASIS, CALL_PRESENCE, CURRENT_SESSION_BASES, reconcile, renderLedger  } from './lib/reconcile.js'
import { ESTIMATOR } from './lib/tokens.js'
import { MAX_LINES_PER_SESSION, createUsageCounter, isValidToolName, projectKey } from './lib/usage.js'

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

/** 溯源扫描：单文件上限（DESIGN §2.8，防御性上限）。 */
export const MAX_SCAN_FILE_BYTES = 3145728
/** 溯源扫描：单包文件数上限（防御性上限）。 */
export const MAX_SCAN_FILES_PER_PACKAGE = 2000
/** 溯源扫描：目录深度上限（配合 realpath 去重防符号链接环）。 */
export const MAX_SCAN_DEPTH = 12
/** 溯源扫描跳过的目录名（§2.8 `SKIP_DIR_NAMES`）。 */
const SKIP_DIR_NAMES = new Set(['node_modules', 'test', 'tests', 'docs', 'examples', '.git', 'types'])
/** 溯源扫描的文件扩展名（§2.8 `SCAN_EXTENSIONS`；不扫 .ts/.json/.map）。 */
const SCAN_EXTENSIONS = new Set(['.js', '.mjs', '.cjs'])

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
/** 声明面读取时往前退几个会话（最新会话可能正在被写入）。 */
const DECLARED_FACE_CANDIDATES = 3

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
 * 解析本次对账所属的会话身份（DESIGN §2.2 `scope.currentSession`）。
 *
 * **只允许来自运行时对象**（两条合法来源，硬规则"不得猜"）：
 *  1. `?session=` 显式传入（HTTP 路由半区）→ `basis: "http-session-param"`；
 *  2. `agent.session.id`（模型工具半区）→ `basis: "agent-session-id"`。
 * 两者都取不到 → `{ id: null, basis: "unavailable" }`。
 *
 * **不得**用"mtime 最新的那个会话目录"顶替：用推断值会让"本会话调用数"变成假事实。
 * `id` 还必须先过 `NAME_PATTERN`（§3.3/§3.8 第 3 条）——会话 id 是宿主运行时字符串，
 * 不得成为绕过护栏的旁路；不匹配即按"取不到"处理。
 *
 * @param {{sessionId?: unknown, agent?: unknown}} options
 * @returns {{id: string | null, basis: string}}
 */
export function resolveCurrentSessionId(options) {
  const explicit = typeof options?.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : null
  const fromAgent = options?.agent?.session?.id
  const candidate = explicit ?? (typeof fromAgent === 'string' && fromAgent !== '' ? fromAgent : null)
  const basis = explicit !== null ? 'http-session-param' : 'agent-session-id'
  if (candidate === null || !isValidToolName(candidate)) return { id: null, basis: 'unavailable' }
  return { id: candidate, basis }
}

/**
 * 把「名字 → 次数」映射写成 canonical 对象（键名升序、`defineProperty` 防原型污染）。
 * @param {Map<string, number>} counts
 * @returns {Record<string, number>}
 */
function toCountsObject(counts) {
  /** @type {Record<string, number>} */
  const out = {}
  for (const name of [...counts.keys()].sort()) {
    Object.defineProperty(out, name, {
      value: counts.get(name) ?? 0,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out
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
 * 解析 profile 目录（DESIGN §2.14 `DSH_PROFILE_DIR`）。
 *
 * 优先取宿主注入的 `profileContext.dir`（`dsh-app-boot` 的 ProfileContext，
 * 仅由 `dsh` 启动的 profile 提供）；其次 `DSH_PROFILE_DIR` 环境变量；
 * 再次 `<DSH_HOME>/profiles/<DSH_PROFILE>`。取不到时返回 null——
 * profile 候选包为空，`plugin` 归属全部退化为"无候选"，`core` 归属照常。
 * @param {{get?: Function}} ctx
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function resolveProfileDir(ctx, env = process.env) {
  const profileContext = typeof ctx?.get === 'function' ? ctx.get('profileContext') : undefined
  const fromContext = profileContext?.dir
  if (typeof fromContext === 'string' && fromContext !== '') return fromContext
  const fromEnv = env?.DSH_PROFILE_DIR
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  const profileName = env?.DSH_PROFILE
  if (typeof profileName === 'string' && profileName !== '') {
    return join(resolveDshHome(env), 'profiles', profileName)
  }
  return null
}

/**
 * 核心作用域目录：`@deepseek-ai/dsh-tools/package.json` 解析结果的上两级
 * （即 `.../node_modules/@deepseek-ai`）。DESIGN §2.14 指定用 `createRequire` 定位，
 * **不得**硬编码安装路径（隔离 `DSH_HOME` 下自然指向隔离安装）。
 * @returns {string | null}
 */
export function resolveCoreScopeDir() {
  try {
    const require = createRequire(import.meta.url)
    return dirname(dirname(require.resolve('@deepseek-ai/dsh-tools/package.json')))
  } catch {
    return null
  }
}

/** 路径是否（跟随符号链接后）是目录。 */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 列出一个 `node_modules` 目录下的**全部顶层包**（含 `@scope/name` 展开）。
 * pnpm 通过符号链接暴露真实目录，因此这里用 `stat`（跟随链接）而不是 `dirent.isDirectory()`。
 * @param {string | null} nodeModulesDir
 * @returns {Array<{name: string, dir: string}>}
 */
export function listPackages(nodeModulesDir) {
  const found = []
  if (typeof nodeModulesDir !== 'string' || nodeModulesDir === '') return found
  let entries
  try {
    entries = readdirSync(nodeModulesDir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(nodeModulesDir, entry.name)
    if (entry.name.startsWith('@')) {
      let scoped
      try {
        scoped = readdirSync(full, { withFileTypes: true })
      } catch {
        continue
      }
      for (const child of scoped) {
        if (child.name.startsWith('.')) continue
        const packageDir = join(full, child.name)
        if (!isDirectory(packageDir)) continue
        found.push({ name: `${entry.name}/${child.name}`, dir: packageDir })
      }
      continue
    }
    if (!isDirectory(full)) continue
    found.push({ name: entry.name, dir: full })
  }
  found.sort((a, b) => (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)))
  return found
}

/**
 * 读取候选包的源码文本（单趟、只读）。
 *
 * 三条防御性上限（§2.14，**不是性能优化**）：单文件超过 {@link MAX_SCAN_FILE_BYTES}
 * 跳过、单包超过 {@link MAX_SCAN_FILES_PER_PACKAGE} 停止、目录深度超过
 * {@link MAX_SCAN_DEPTH} 停止下探（配合 `realpath` 去重防符号链接环）；任一触达即
 * 置 `capped = true`（只作诊断，不改变任何归属语义）。
 *
 * `path` 记录的是**走过的路径**（profile 视角，人可复核），`realpath` 只用于去重。
 * @param {Array<{name: string, dir: string}>} packages
 * @returns {{corpus: Record<string, Array<{path: string, text: string}>>, files: number, bytes: number, capped: boolean}}
 */
export function collectCorpus(packages) {
  /** @type {Record<string, Array<{path: string, text: string}>>} */
  const corpus = {}
  let files = 0
  let bytes = 0
  let capped = false
  for (const pkg of Array.isArray(packages) ? packages : []) {
    /** @type {Array<{path: string, text: string}>} */
    const collected = []
    const seenReal = new Set()
    const walk = (dir, depth) => {
      if (collected.length >= MAX_SCAN_FILES_PER_PACKAGE) {
        capped = true
        return
      }
      if (depth > MAX_SCAN_DEPTH) {
        capped = true
        return
      }
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (collected.length >= MAX_SCAN_FILES_PER_PACKAGE) {
          capped = true
          return
        }
        const full = join(dir, entry.name)
        let real
        try {
          real = realpathSync(full)
        } catch {
          continue
        }
        if (seenReal.has(real)) continue
        seenReal.add(real)
        if (isDirectory(full)) {
          if (SKIP_DIR_NAMES.has(entry.name)) continue
          walk(full, depth + 1)
          continue
        }
        if (!SCAN_EXTENSIONS.has(extname(entry.name))) continue
        let info
        try {
          info = statSync(full)
        } catch {
          continue
        }
        if (!info.isFile()) continue
        if (info.size > MAX_SCAN_FILE_BYTES) {
          capped = true
          continue
        }
        let text
        try {
          text = readFileSync(full, 'utf8')
        } catch {
          continue
        }
        collected.push({ path: full, text })
        files += 1
        bytes += Buffer.byteLength(text, 'utf8')
      }
    }
    walk(pkg.dir, 0)
    if (collected.length > 0) corpus[pkg.name] = collected
  }
  return { corpus, files, bytes, capped }
}

/**
 * 读 profile manifest：可卸载 bundle = `dependencies` ∩ `dsh.profile.bundles`（§2.16 规则 1）。
 * @param {string | null} profileDir
 * @returns {{dependencies: string[], bundles: string[], removable: string[]} | null} null = 不可读（**不猜**）
 */
export function readProfileManifest(profileDir) {
  if (typeof profileDir !== 'string' || profileDir === '') return null
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const dependencies = manifest?.dependencies !== null && typeof manifest?.dependencies === 'object'
      ? Object.keys(manifest.dependencies)
      : []
    const bundles = Array.isArray(manifest?.dsh?.profile?.bundles)
      ? manifest.dsh.profile.bundles.filter(entry => typeof entry === 'string')
      : []
    return { dependencies, bundles, removable: bundles.filter(bundle => dependencies.includes(bundle)) }
  } catch {
    return null
  }
}

/**
 * 解析「事实包 → 卸载单元」（§2.16 规则 2–4）。
 *
 * 每个可卸载 bundle 取其 `dsh.bundle.patch` 文本，事实包名在该文本中以字面量出现即算归属；
 * 恰 1 个 → 该 bundle；0 个或多个 → `{ owner: null, removable: false }`（记
 * `no-owner-bundle`，**不猜**）。manifest 不可读时调用方传空的 removable 列表即可。
 * @param {string | null} profileDir
 * @param {Iterable<string>} factPackages
 * @param {Iterable<string>} removableBundles
 * @returns {Record<string, {owner: string|null, removable: boolean}>}
 */
export function resolveBundleOwners(profileDir, factPackages, removableBundles) {
  /** @type {Record<string, {owner: string|null, removable: boolean}>} */
  const owners = {}
  if (typeof profileDir !== 'string' || profileDir === '') return owners
  const facts = [...new Set([...(factPackages ?? [])])].filter(name => typeof name === 'string' && name !== '').sort()
  if (facts.length === 0) return owners

  /** @type {Array<{bundle: string, patchText: string}>} */
  const patches = []
  for (const bundle of removableBundles ?? []) {
    if (typeof bundle !== 'string' || bundle === '') continue
    try {
      const packageDir = join(profileDir, 'node_modules', ...bundle.split('/'))
      const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
      const patchPath = manifest?.dsh?.bundle?.patch
      if (typeof patchPath !== 'string' || patchPath === '') continue
      patches.push({ bundle, patchText: readFileSync(join(packageDir, patchPath), 'utf8') })
    } catch {
      // 该 bundle 的 patch 读不到：它不参与归属判定（不猜）
    }
  }

  for (const fact of facts) {
    const hits = patches.filter(patch => patch.patchText.includes(fact)).map(patch => patch.bundle)
    owners[fact] = hits.length === 1
      ? { owner: hits[0], removable: true }
      : { owner: null, removable: false }
  }
  return owners
}

/**
 * 一次完整的归属扫描（宿主侧唯一读盘入口，§3.6 只读 profile / 核心作用域包）。
 * @param {{profileDir?: string|null, coreScopeDir?: string|null}} roots
 * @param {Array<{name: string, category: string}>} names - 待归属的工具 / MCP 项
 * @returns {{byName: Record<string, object>, bundleOwners: Record<string, object>, providerScan: {packages: number, files: number, bytes: number, capped: boolean}}}
 */
export function scanProvenance(roots, names) {
  const profilePackages = listPackages(roots?.profileDir ? join(roots.profileDir, 'node_modules') : null)
  const corePackages = listPackages(roots?.coreScopeDir)
  const profileRead = collectCorpus(profilePackages)
  const coreRead = collectCorpus(corePackages)
  const wanted = names.map(entry => entry.name)
  const profileScan = scanCorpus(profileRead.corpus, wanted, { capped: profileRead.capped })
  const coreScan = scanCorpus(coreRead.corpus, wanted, { capped: coreRead.capped })
  const byName = attributeNames(names, { profile: profileScan, core: coreScan })

  const factPackages = [...new Set(Object.values(byName)
    .filter(entry => entry.kind === 'plugin' && typeof entry.name === 'string')
    .map(entry => entry.name))].sort()
  const manifest = readProfileManifest(roots?.profileDir ?? null)
  const bundleOwners = resolveBundleOwners(
    roots?.profileDir ?? null,
    factPackages,
    manifest === null ? [] : manifest.removable,
  )

  return {
    byName,
    bundleOwners,
    // R6（§2.19）：`registryUse.nameReferencedElsewhere` 复用 R1 的**弱命中文件路径**
    // （已是白名单内的绝对路径；不新增读取面，§3.7）。
    weakFiles: mergeWeakFiles(profileScan, coreScan),
    providerScan: {
      packages: profilePackages.length + corePackages.length,
      files: profileRead.files + coreRead.files,
      bytes: profileRead.bytes + coreRead.bytes,
      capped: profileRead.capped || coreRead.capped,
    },
  }
}

/** 合并两个扫描根的弱命中文件：名字 → 升序去重的绝对路径。 */
function mergeWeakFiles(...scans) {
  /** @type {Record<string, string[]>} */
  const merged = {}
  for (const scan of scans) {
    const evidence = scan !== null && typeof scan === 'object' ? scan.evidence?.weak : undefined
    if (evidence === null || typeof evidence !== 'object') continue
    for (const [name, files] of Object.entries(evidence)) {
      const bucket = merged[name] ?? new Set()
      for (const file of Array.isArray(files) ? files : []) {
        if (typeof file === 'string' && file !== '') bucket.add(file)
      }
      merged[name] = bucket
    }
  }
  /** @type {Record<string, string[]>} */
  const out = {}
  for (const name of Object.keys(merged).sort()) out[name] = [...merged[name]].sort()
  return out
}

/**
 * 探测 R6 的施加接口与预校验来源（DESIGN §2.23.3 的三态；**绝不抛错**）。
 *
 * - `prechecked`：`restrict` 与 `view().restrictableNames` 都在，且有 agent 作用域；
 * - `unvalidated`：接口在，但拿不到 agent 作用域（如 HTTP 路由所在的宿主）；
 * - `unsupported`：缺 `restrict` / 缺 `view().restrictableNames`（旧宿主）。
 *
 * **类型以宿主源码为准（t18/B1）**：`view(scope).restrictableNames` 的真实类型是 **`Set`**
 * （`dsh-tools/lib/index.js:2969` 构造、`:2983` 放进 view、`:2906` 用 `.has()` 消费）。
 * 这里用 {@link normalizeNameCollection} 同时接受 `Set` 与 `Array`；把任何非集合形状
 * （`undefined` / 普通对象 / `Map`）如实判为"拿不到集合" ⇒ `unsupported`。
 * 曾用 `Array.isArray` 直接判定，导致真机上恒判 `unsupported`（`denyList` 恒为空）。
 *
 * @param {any} tools - `ctx.tools`（或 `agent.ctx.tools`）
 * @param {unknown} [agent] - 目标 agent（作用域）
 * @returns {{status: string, restrictableNames: string[]|null, interfacePresent: boolean}}
 */
export function probeRestrict(tools, agent) {
  const hasRestrict = tools !== null && typeof tools === 'object' && typeof tools.restrict === 'function'
  const hasView = tools !== null && typeof tools === 'object' && typeof tools.view === 'function'
  if (!hasRestrict || !hasView) {
    return { status: 'unsupported', restrictableNames: null, interfacePresent: false }
  }
  if (agent === undefined || agent === null) {
    return { status: 'unvalidated', restrictableNames: null, interfacePresent: true }
  }
  try {
    const view = tools.view(agent)
    // 宿主真机类型是 `Set`（见上）；`Array` 只在替身/历史实现里出现过，一并接受。
    const names = normalizeNameCollection(view?.restrictableNames)
    if (names === null) {
      // 有 view 但拿不到 `restrictableNames` 集合：旧宿主，按"接口缺失"处理（§2.23.3 第 3 行）。
      return { status: 'unsupported', restrictableNames: null, interfacePresent: false }
    }
    return { status: 'prechecked', restrictableNames: names, interfacePresent: true }
  } catch {
    // `view(agent)` 抛错 = 拿不到该 agent 的作用域（不是接口缺失）⇒ 未校验，不抛错。
    return { status: 'unvalidated', restrictableNames: null, interfacePresent: true }
  }
}

/**
 * 在**某个 agent 的作用域内**施加 deny（DESIGN §2.23.1 / §2.23.2）。
 *
 * - **绝不全局施加**：只走 `agent.ctx.tools.restrict(...)`——普通 ctx 调用会被宿主直接拒绝
 *   （`dsh-tools/lib/index.js:2895-2897`）。
 * - 施加前**重新**用 `view(agent).restrictableNames` 校验每个名字；未通过者记入 `skipped`
 *   （工具表可能已变化，不能复用审计时刻的结果）。
 * - 空清单**绝不施加**（空 filter 会抛错，同文件 `:2900`）；预留名 `run_code` 再拦一道。
 *
 * @param {any} agent
 * @param {string[]} deny
 * @returns {{interfacePresent: boolean, appliedNames: string[], skipped: Array<{name: string, reason: string}>}}
 */
export function applyDenyToAgent(agent, deny) {
  const wanted = [...new Set((Array.isArray(deny) ? deny : []).filter(name => typeof name === 'string' && name !== ''))].sort()
  const tools = agent?.ctx?.tools
  const probe = probeRestrict(tools, agent)
  if (probe.status !== 'prechecked') {
    return {
      interfacePresent: probe.interfacePresent,
      appliedNames: [],
      skipped: wanted.map(name => ({
        name,
        reason: probe.status === 'unvalidated' ? 'no-agent-scope' : 'interface-absent',
      })),
    }
  }
  const known = new Set(probe.restrictableNames ?? [])
  const applicable = []
  const skipped = []
  for (const name of wanted) {
    if (RESERVED_TOOL_NAMES.includes(name)) skipped.push({ name, reason: 'reserved-name' })
    else if (known.has(name)) applicable.push(name)
    else skipped.push({ name, reason: 'not-in-restrictable-names' })
  }
  if (applicable.length === 0) {
    // 名字全部消失 / 全部不可限制：静默降级为"只建议"，不抛错、不重试（§2.23.4 第 4 点）。
    return { interfacePresent: true, appliedNames: [], skipped }
  }
  try {
    tools.restrict({ deny: applicable })
    return { interfacePresent: true, appliedNames: applicable, skipped }
  } catch {
    return {
      interfacePresent: true,
      appliedNames: [],
      skipped: wanted.map(name => ({ name, reason: 'interface-absent' })),
    }
  }
}

/**
 * 组装一份对账报告：成本表（指令链 / 技能目录 / 工具 schema） × 会话日志回放。
 *
 * v2 追加：把两个扫描根（profile 顶层包 / 核心作用域包）的源码文本交给
 * `lib/provide.js`，得到 `providedBy` 与裁剪候选（宿主是**唯一**读盘者，§7）。
 * @param {{fs: any, skills: any, tools: any, dshHome: string,
 *   profileDir?: string|null, coreScopeDir?: string|null}} deps
 * @param {{cwd: string, sessions?: number, signal?: AbortSignal, agent?: unknown}} options
 * @returns {Promise<Record<string, unknown>>} canonical `context_ledger` 报告
 */
export async function gatherLedger(deps, options) {
  const cwd = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : process.cwd()
  const signal = options.signal
  const sessionsLimit = clampSessions(options.sessions)
  const dshHome = typeof deps.dshHome === 'string' && deps.dshHome !== '' ? deps.dshHome : resolveDshHome()

  // 会话清单（只 stat 目录项，不读内容）——成本侧要先用它定位"最新会话"，
  // 因为 PTC 下声明面**只在系统提示里**，而系统提示要按会话日志取。
  const workspaceKey = projectKey(cwd)
  const sessionsRoot = sessionsRootOf(dshHome)
  const available = listWorkspaceSessions(sessionsRoot, workspaceKey)
  const selected = available.slice(0, sessionsLimit)

  // ── 0. 声明面（v5）：PTC 下量系统提示里的 tools:sdk，而不是 JSON schema ──
  // 这是一次**独立的**流式读取（只取首个 system/message 即返回），不是 §3.8 那三个
  // 计数投影的一部分；三个投影仍严格出自下面唯一的一次回放。
  /** @type {{byName: Record<string, {chars: number, tokens: number}>, totalTokens: number, toolCount: number} | null} */
  let declaredFace = null
  let measureBasis = SCHEMA_BASIS
  try {
    // 依次尝试最近几个会话：**最新那个可能正在被写入**，单次读取会因日志不完整而取不到
    // （2026-10-08 实测：同一份日志单独读成功、作为"最新会话"读却返回 null）。
    // 声明面只随"工具集"变化，往前退一两个会话不影响结论。
    for (const entry of available.slice(0, DECLARED_FACE_CANDIDATES)) {
      if (signal?.aborted === true) break
      if (typeof entry?.logPath !== 'string') continue
      declaredFace = await readDeclaredFace(entry.logPath, MAX_LINES_PER_SESSION, signal)
      if (declaredFace !== null) { measureBasis = DECLARATION_BASIS; break }
    }
  } catch {
    // 量不到就如实退回 schema 口径，不猜、不填 0。
    declaredFace = null
    measureBasis = SCHEMA_BASIS
  }

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
    ...toolItems(schemas, declaredFace),
  ]

  // ── 1b. 归属扫描（R1）：只扫 tools / mcp 项的名字 ────────────────────────
  const attributable = items
    .filter(item => item.category === 'tools' || item.category === 'mcp')
    .map(item => ({ name: item.name, category: item.category }))
  let provenance = { byName: {}, bundleOwners: {}, weakEvidence: {} }
  let providerScan = { packages: 0, files: 0, bytes: 0, capped: false }
  try {
    const scanned = scanProvenance({ profileDir: deps.profileDir ?? null, coreScopeDir: deps.coreScopeDir ?? null }, attributable)
    provenance = { byName: scanned.byName, bundleOwners: scanned.bundleOwners, weakEvidence: scanned.weakFiles ?? {} }
    providerScan = scanned.providerScan
  } catch {
    // 扫描整体失败时如实退化为"没有归属信息"（全部 unknown / 无动作），不猜测填充。
    provenance = { byName: {}, bundleOwners: {}, weakEvidence: {} }
    providerScan = { packages: 0, files: 0, bytes: 0, capped: false }
  }

  // ── 1c. R6：restrict 接口探测 + opt-in 施加状态（§2.23；**默认不施加**） ──────
  // 预校验来源只能是**被审计 agent 的作用域**；探测失败一律 fail-soft（不抛错、三态如实降级）。
  const probe = probeRestrict(deps.tools, options.agent)
  const applied = options.agent !== undefined && deps.appliedByAgent instanceof WeakMap
    ? deps.appliedByAgent.get(options.agent)
    : undefined
  const appliedNames = Array.isArray(applied?.appliedNames) ? applied.appliedNames : []
  const hideInput = {
    status: probe.status,
    restrictableNames: probe.restrictableNames,
    interfacePresent: probe.interfacePresent,
    // 只有**真的施加成功过**才记为 applied-by-config；失败/空清单静默降级为只建议（§2.23.4）。
    mode: appliedNames.length > 0 ? 'applied-by-config' : 'suggestion-only',
    appliedNames,
  }

  // ── 2. 使用侧：会话日志回放（只取工具名与计数） ──────────────────────────
  // v4（§3.8 第 2 条）：三个投影**全部**出自下面这一次逐会话回放——
  // 窗口总量（`counts`）/ 覆盖会话数（`coverage`）/ 本会话次数（`currentSessionCounts`）。
  // **不得**为任何一项另开读取路径（不重新解压、不换计数函数、不 stat 以外的读盘）。
  const identity = resolveCurrentSessionId(options)

  /** @type {Map<string, number>} */
  const counts = new Map()
  /** @type {Map<string, number>} */
  const coverage = new Map()
  /** @type {Record<string, number> | null} */
  let currentSessionCounts = null
  let sessionsScanned = 0
  let sessionsUnreadable = 0
  let linesRead = 0
  let toolCalls = 0
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
    toolCalls += usage.toolCalls
    skillToolCalls += usage.skillToolCalls
    namesRejected += usage.namesRejected
    truncated = truncated || usage.truncated
    for (const [toolName, count] of Object.entries(usage.callsByName)) {
      counts.set(toolName, (counts.get(toolName) ?? 0) + count)
      coverage.set(toolName, (coverage.get(toolName) ?? 0) + 1)
    }
    if (identity.id !== null && entry.id === identity.id) currentSessionCounts = usage.callsByName
    if (entry.mtimeMs > 0) {
      oldest = oldest === null ? entry.mtimeMs : Math.min(oldest, entry.mtimeMs)
      newest = newest === null ? entry.mtimeMs : Math.max(newest, entry.mtimeMs)
    }
  }

  const callsByName = toCountsObject(counts)
  const inWindow = identity.id !== null && currentSessionCounts !== null
  // §7.1 规则 6：`{}` = "已判定、确实一个都没有"（⇒ 0）；`null` = "给不出"（⇒ `null`）。
  // 一次会话都没回放成功时，覆盖维度**没有**被判定过，因此如实传 `null`（不是 `{}`）。
  const sessionCoverage = sessionsScanned >= 1 ? toCountsObject(coverage) : null
  // 本会话不在窗口内（含身份未知）⇒ `null`：**绝不用 0 冒充"本会话没用过"**。
  // `usage.callsByName` 本身已是 canonical 形状（键名升序 + `defineProperty`），直接复用。
  const currentSessionCallsByName = inWindow ? currentSessionCounts : null

  // ── 3. 对账（calls / tokensPerCall / zeroCall / usageBasis 的唯一赋权点） ──
  return reconcile({
    cwd,
    sessionsRoot,
    findingsLimit: FINDINGS_LIMIT,
    callsByName,
    sessionCoverage,
    currentSessionCallsByName,
    scope: {
      workspaceKey,
      sessionsRoot,
      sessionsAvailable: available.length,
      sessionsScanned,
      sessionsUnreadable,
      sessionsLimit,
      // §2.2 W4：available = scanned + unreadable + outsideWindow（按此恒等式构造）。
      sessionsOutsideWindow: Math.max(0, available.length - sessionsScanned - sessionsUnreadable),
      windowStart: oldest === null ? null : new Date(oldest).toISOString(),
      windowEnd: newest === null ? null : new Date(newest).toISOString(),
      // 窗口边界**只**来自日志文件 mtime（文件系统元数据）；不读行内 `time`（§2.2 第 4 条）。
      windowBasis: SESSION_LOG_MTIME_BASIS,
      // §2.2（v5）：`items[].tokens` / `bytes` 是在**哪个口径**上量的。
      // `system-prompt-declaration` = PTC 下模型真正收到的 tools:sdk 声明；
      // `tool-schemas` = 退回按 JSON schema 估算（非 PTC，或声明面读不到）。
      measureBasis,
      currentSession: { id: identity.id, basis: identity.basis, inWindow },
      linesRead,
      toolCalls,
      skillToolCalls,
      namesRejected,
      truncated,
      providerScan,
    },
    provenance,
    hide: hideInput,
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
 * **v2 移除 `?cwd=` 旋钮**（收口 O2）：路由**只**接受 `?session=<id>`。
 * 缺 `session` 或会话无法解析时返回显式错误 `{ ok: false, error: "session-unresolved" }`
 * （HTTP 4xx），**不得**用"无 agent scope 的降级报告"顶替——那会把降级态伪装成事实。
 *
 * @param {{deps: any, sessions?: {get(id: string): any}, cacheTtlMs?: number}} config
 * @returns {Array<{kind: 'exact', path: string, handler: (req: any, res: any) => void}>}
 */
export function makeLedgerRoutes(config) {
  const cacheTtlMs = Number.isFinite(config.cacheTtlMs) ? config.cacheTtlMs : CACHE_TTL_MS
  /** @type {Map<string, {at: number, promise: Promise<Record<string, unknown>>}>} */
  const cache = new Map()
  const maxCacheEntries = 32

  const report = (cwd, sessions, agent, sessionId) => {
    // 缓存键必须含 sessionId：`scope.currentSession` 随会话变化，
    // 不含它会让同工作区的另一个会话读到**别人**的"本会话调用数"（同源分歧即缺陷，§5）。
    const key = `${cwd} ${sessions} ${sessionId ?? ''}`
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
      // §4.1（v4）：`?session=` 解析成功但拿不到 agent 时仍要把 id 传下去，
      // 否则"本会话调用数"会无谓退化成不可判定。
      sessionId,
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
      // §4.1（v2）：只接受 ?session=；解析不到就报显式错误，不用降级报告顶替。
      const sessionId = parseQueryParam(url, 'session')
      if (sessionId === undefined || sessionId === '') {
        json(res, 400, { ok: false, error: 'session-unresolved' })
        return
      }
      const session = config.sessions?.get(sessionId)
      const sessionCwd = session?.header?.cwd
      if (typeof sessionCwd !== 'string' || sessionCwd === '') {
        json(res, 404, { ok: false, error: 'session-unresolved' })
        return
      }
      const cwd = sessionCwd
      const agent = config.deps?.agents !== undefined ? config.deps.agents.get(sessionId) : undefined
      const sessions = clampSessions(parseQueryParam(url, 'sessions'))
      // v4：`?session=` 是 `scope.currentSession.id` 的两个合法来源之一（§2.2/§4.1）。
      report(cwd, sessions, agent, sessionId).then(
        value => json(res, 200, { ok: true, report: value }),
        (error) => json(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    },
  }]
}

/**
 * `context_ledger` 工具描述（DESIGN §2.10，**v4 修订版**，冻结文本，英文，实现线照抄）。
 *
 * 与 v2 的差别（v4）：补一句**窗口口径限定**——模型半区是"零调用候选"这句话的发出者，
 * 不告诉它窗口口径，它会继续把"窗口内 0 次"表述成"从未使用"（§2.26 开头 / §5 第 3 条）。
 */
const TOOL_DESCRIPTION =
  'Reconcile the resident cost of every injected context item against how often it is actually '
  + 'called in this workspace\'s session logs. Reports, per item: token cost, call count, '
  + 'cost-per-use (tokens ÷ calls) and whether it was never called. Also reports, per item, which '
  + 'package provides it — a heuristic inferred from installed plugin sources, never presented as '
  + 'fact — and groups never-called items by the plugin bundle or MCP server they come from. '
  + 'Those groups are CANDIDATES for review, not uninstall advice: a tool can still be used by the '
  + 'UI, by background flows, or rarely but crucially, and model call counts cannot prove otherwise. '
  + 'Call counts cover only the scanned window (the most recent sessions, `sessions` parameter, '
  + 'default 20) — the report states the window bounds and how many sessions were left outside it, '
  + 'so "0 calls" means "not called in this window", never "never used". '
  + 'Read-only: it never writes a file, never reads message content, and extracts only tool names '
  + 'and counts from session logs.'

/** 可空整数（`calls` / `tokensPerCall` / …）。 */
function nullableInteger() {
  return { oneOf: [{ type: 'integer' }, { type: 'null' }] }
}

/** 可空布尔（`zeroCall`）。 */
function nullableBoolean() {
  return { oneOf: [{ type: 'boolean' }, { type: 'null' }] }
}

/** 可空字符串（`providedBy.name` / `evidenceFile` / 时间戳）。 */
function nullableString() {
  return { oneOf: [{ type: 'string' }, { type: 'null' }] }
}

/** §2.26.2 的 `callPresence`（三态 + `null`）。 */
function callPresenceSchema() {
  return {
    oneOf: [
      { type: 'string', enum: [CALL_PRESENCE.CURRENT_SESSION, CALL_PRESENCE.HISTORICAL_ONLY, CALL_PRESENCE.ABSENT] },
      { type: 'null' },
    ],
  }
}

/** §2.2 的 `scope.currentSession`（三个子字段全部必需）。 */
function currentSessionSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: nullableString(),
      basis: { type: 'string', enum: [...CURRENT_SESSION_BASES] },
      inWindow: { type: 'boolean' },
    },
  }
}

/** §2.13 的 `items[].providedBy` 输出 schema（全部子字段必需）。 */
function providedBySchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: [...PROVIDED_BY_KINDS] },
      name: nullableString(),
      confidence: { type: 'string', enum: [...PROVIDED_BY_CONFIDENCE] },
      method: { type: 'string', enum: [...PROVIDED_BY_METHODS] },
      evidenceFile: nullableString(),
      candidates: { type: 'array', items: { type: 'string' } },
    },
  }
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
      // ── v4（R8）：三个新维度，顺序与 §2.4 字段表逐行一致 ──
      currentSessionCalls: nullableInteger(),
      sessionsWithCalls: nullableInteger(),
      callPresence: callPresenceSchema(),
      usageBasis: { type: 'string', enum: ['tool-calls', 'no-evidence', 'unobservable', 'always-on'] },
      source: { type: 'string' },
      server: { type: 'string' },
      bytes: { type: 'integer' },
      provider: { type: 'string' },
      loadOrder: { type: 'integer' },
      providedBy: providedBySchema(),
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
  const nullableTimestamp = nullableString()
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
      // ── v4（R8）：窗口边界显式化，顺序与 §2.2 字段表逐行一致 ──
      sessionsOutsideWindow: { type: 'integer' },
      windowStart: nullableTimestamp,
      windowEnd: nullableTimestamp,
      windowBasis: { type: 'string', const: SESSION_LOG_MTIME_BASIS },
      // v5：常驻口径（枚举，不是自由字符串——它决定上面每个 tokens 的含义）
      measureBasis: { type: 'string', enum: [SCHEMA_BASIS, DECLARATION_BASIS] },
      currentSession: currentSessionSchema(),
      linesRead: { type: 'integer' },
      toolCalls: { type: 'integer' },
      skillToolCalls: { type: 'integer' },
      callsUnmatched: { type: 'integer' },
      callsUnmatchedNames: { type: 'array', items: { type: 'string' } },
      namesRejected: { type: 'integer' },
      usageAvailable: { type: 'boolean' },
      truncated: { type: 'boolean' },
      providerScan: {
        type: 'object',
        additionalProperties: false,
        properties: {
          packages: { type: 'integer' },
          files: { type: 'integer' },
          bytes: { type: 'integer' },
          capped: { type: 'boolean' },
        },
      },
    },
  }
}

/** §2.18 的 `hidePlan[].unit` 输出 schema。 */
function hideUnitSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: [...PROVIDED_BY_KINDS] },
      target: nullableString(),
      factPackages: { type: 'array', items: { type: 'string' } },
    },
  }
}

/** §2.19 的 `registryUse` 输出 schema（5 键）。 */
function registryUseSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      verdict: { type: 'string', enum: [...REGISTRY_USE_VERDICTS] },
      verdictBasis: { type: 'string', const: REGISTRY_USE_BASIS },
      modelCalls: { type: 'integer' },
      nameReferencedElsewhere: { type: 'array', items: { type: 'string' } },
      nonModelCallers: { type: 'string', const: 'unobservable' },
    },
  }
}

/** §2.20 的 `precheck` 输出 schema（3 键）。 */
function precheckSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: [...PRECHECK_STATUSES] },
      restrictable: nullableBoolean(),
      reason: { oneOf: [{ type: 'string', enum: [...PRECHECK_REASONS] }, { type: 'null' }] },
    },
  }
}

/** §2.18 的 `hidePlan[]`（`HideEntry`，8 字段）输出 schema。 */
function hideEntrySchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      category: { type: 'string', enum: ['tools', 'mcp'] },
      tokens: { type: 'integer' },
      unit: hideUnitSchema(),
      registryUse: registryUseSchema(),
      precheck: precheckSchema(),
      selfTool: { type: 'boolean' },
    },
  }
}

/** §2.18 的 `hidePlanUnits[]` 输出 schema（7 字段）。 */
function hideUnitSummarySchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: [...PROVIDED_BY_KINDS] },
      target: nullableString(),
      factPackages: { type: 'array', items: { type: 'string' } },
      toolCount: { type: 'integer' },
      tokens: { type: 'integer' },
      usedToolCount: { type: 'integer' },
      inPrunePlan: { type: 'boolean' },
    },
  }
}

/**
 * §2.18 / §2.23.4 的 `hideApply` 输出 schema（6 键）。
 *
 * `mode` 的取值域只有 2 个：默认 `suggestion-only`；只有用户显式 opt-in 且真的施加成功过
 * 才会是 `applied-by-config`。
 */
function hideApplySchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      mode: { type: 'string', enum: [...HIDE_MODES] },
      interfacePresent: { type: 'boolean' },
      denyList: { type: 'array', items: { type: 'string' } },
      skipped: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            reason: { type: 'string', enum: [...PRECHECK_REASONS] },
          },
        },
      },
      applySupported: { type: 'boolean' },
      appliedNames: { type: 'array', items: { type: 'string' } },
    },
  }
}

/** §2.19 的 `hidePlanCaveat` 输出 schema（5 键，值冻结）。 */
function hidePlanCaveatSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      registryHideIsTotal: { type: 'boolean', const: HIDE_PLAN_CAVEAT.registryHideIsTotal },
      nonModelRegistryCalls: { type: 'string', const: HIDE_PLAN_CAVEAT.nonModelRegistryCalls },
      serviceCoupling: { type: 'string', const: HIDE_PLAN_CAVEAT.serviceCoupling },
      confirmationRequired: { type: 'boolean', const: HIDE_PLAN_CAVEAT.confirmationRequired },
      prefixCacheCost: { type: 'string', const: HIDE_PLAN_CAVEAT.prefixCacheCost },
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
          prunePlan: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', enum: [...PRUNE_KINDS] },
                target: { type: 'string' },
                factPackages: { type: 'array', items: { type: 'string' } },
                items: {
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
                itemCount: { type: 'integer' },
                reclaimableTokens: { type: 'integer' },
                usedToolCount: { type: 'integer' },
                confidence: { type: 'string', enum: [...PROVIDED_BY_CONFIDENCE] },
              },
            },
          },
          prunePlanReclaimableTokens: { type: 'integer' },
          prunePlanBasis: { type: 'string', const: PRUNE_PLAN_BASIS },
          // v4（R8）：零调用清单的窗口边界声明（与 prunePlanBasis 正交，§2.5）
          zeroCallBasis: { type: 'string', const: ZERO_CALL_BASIS },
          noRecommendation: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                reason: { type: 'string', enum: [...NO_RECOMMENDATION_REASONS] },
                items: { type: 'integer' },
                tokens: { type: 'integer' },
              },
            },
          },
          // ── v3（R6）：顺序与 §2.5 表格逐行一致 ──
          hidePlan: { type: 'array', items: hideEntrySchema() },
          hidePlanTokens: { type: 'integer' },
          hidePlanUnits: { type: 'array', items: hideUnitSummarySchema() },
          hidePlanBasis: { type: 'string', const: HIDE_PLAN_BASIS },
          hidePlanStatus: { type: 'string', enum: [...PRECHECK_STATUSES] },
          hideApply: hideApplySchema(),
          hidePlanCaveat: hidePlanCaveatSchema(),
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
          // v4（R8）：Σ 逐项 currentSessionCalls（非 null）；无此类项时 null
          currentSessionObservedCalls: nullableInteger(),
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
 * 安装 R6 的 **opt-in** 施加（DESIGN §2.23.4；默认**不施加**）。
 *
 * 只有用户在自己的 profile patch 里显式写了 `config.hide.apply: true` **且** `deny` 非空时，
 * 才注册 `agent/created` 监听，并在 **root agent 的作用域内**施加 deny；否则**什么都不做**
 * （不注册监听、不调用 `restrict`）。
 *
 * @param {any} ctx
 * @param {{hide?: {apply?: boolean, deny?: string[]}}} config
 * @param {WeakMap<object, object>} appliedByAgent - 施加结果（供报告读 `hideApply`）
 * @returns {boolean} 是否真的安装了施加监听
 */
export function installHideApply(ctx, config, appliedByAgent) {
  const hide = config !== null && typeof config === 'object' && config.hide !== null && typeof config.hide === 'object'
    ? config.hide
    : {}
  if (hide.apply !== true) return false // 默认永久"只建议"（H4）
  const deny = Array.isArray(hide.deny) ? hide.deny.filter(name => typeof name === 'string' && name !== '') : []
  if (deny.length === 0) return false // 空清单绝不施加（空 filter 会抛错）
  if (typeof ctx?.on !== 'function') return false
  ctx.on('agent/created', ({ agent }) => {
    // 施加结果只影响该 agent 及其层链继承者；失败静默降级，不抛错、不重试。
    try {
      appliedByAgent.set(agent, applyDenyToAgent(agent, deny))
    } catch {
      appliedByAgent.set(agent, { interfacePresent: false, appliedNames: [], skipped: [] })
    }
  })
  return true
}

/**
 * 插件入口。
 * @param {any} ctx - cordis 上下文（真实宿主或测试用假 ctx）
 * @param {{defaultCwd?: string, cacheTtlMs?: number,
 *   hide?: {apply?: boolean, deny?: string[]}}} [config]
 */
export function apply(ctx, config = {}) {
  /** 施加结果（只在 opt-in 且真的施加上时才有条目）。 */
  const appliedByAgent = new WeakMap()
  const deps = {
    fs: ctx.fs,
    skills: ctx.skills,
    tools: ctx.tools,
    dshHome: resolveDshHome(),
    // R1 的两个扫描根（只读）：profile 顶层包 + 核心作用域包（§2.14）。
    profileDir: resolveProfileDir(ctx),
    coreScopeDir: resolveCoreScopeDir(),
    agents: typeof ctx.get === 'function' ? ctx.get('agents') : undefined,
    appliedByAgent,
  }
  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined

  // 0. R6：opt-in 施加（默认关闭；见 installHideApply）。
  installHideApply(ctx, config, appliedByAgent)

  // 1. 模型工具：与 HTTP 路由返回同一份 canonical JSON（同一函数产出）。
  //    **按需启用（默认关闭）**：PTC 模式下这条声明每次请求常驻约 1,725 token，是全部 80 个
  //    工具里最大的一条（返回类型声明一项就占整个 ToolOutputMap 的 32%），而 56 个会话里
  //    它被调用 0 次。HTTP 路由与面板不受影响，随时可用同一份 canonical JSON。
  //    开启方式：在自己 profile patch 里写 `config.tool.enabled: true`。
  const toolEnabled = config !== null && typeof config === 'object' && config.tool !== null && typeof config.tool === 'object'
    ? config.tool.enabled === true
    : config !== null && typeof config === 'object' && config.toolEnabled === true
  if (toolEnabled) ctx.tools.register(defineTool({
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
