/**
 * dsh-context-ledger — 会话日志回放：从 `tool/call` 记录里数**工具名**。
 *
 * 纯函数模块：输入是**已解压**的日志行，**不得** import 任何 `@deepseek-ai/*` 包，
 * 也不碰文件系统与子进程（解压与选目录是 `index.js` 的宿主职责）。
 *
 * ── 隐私边界（DESIGN §3.1，不可协商） ────────────────────────────────────────
 * 每行**只**读两处：
 *   1. 行顶层 `type`；
 *   2. `type === "tool/call"` 时的 `data.name`（工具名）。
 * 除此之外一个字段都不读。明文禁止读取（下列名字本文件只允许出现在注释里）：
 *   data.arguments   data.callId        data.turn / data.step
 *   data.message     data.content       data.title / data.text
 *   data.meta        data.error         data.stream / data.usage
 *   以及 session/title 类行的标题、user/message 类行的正文、tool/result 类行的
 *   输出 / 错误 / 元数据——这些行按 §3.1 一律当噪声丢弃。
 * `tool/ptc-dispatch` 系列**不计入**（其父 `tool/call` 已计数，避免重复计数），
 * 其 data.subCallId / data.name 同样不读。
 *
 * 第二道锁是名字护栏 `NAME_PATTERN`（§3.3）：任何正文/参数片段（含空格、引号、
 * 换行、非 ASCII）必然无法通过，因此即使上游出现 bug，片段也进不了产物。
 *
 * @module lib/usage
 */

/**
 * 工具名 / 技能名护栏（DESIGN §2.8 冻结值）。
 *
 * 注意：**不带 `g` 标志**——带 `g` 的 `RegExp.prototype.test` 会在多次调用间
 * 保留 `lastIndex`，产生「同一次回放里结果时对时错」的隐蔽 bug。
 */
export const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/

/** 单日志最多检视行数（DESIGN §2.8 冻结值）。超出即停并置 `truncated`。 */
export const MAX_LINES_PER_SESSION = 200000

/** 技能机制的工具名：DSH 只有一个 `skill` 工具，技能名在它的参数里（不读）。 */
export const SKILL_TOOL_NAME = 'skill'

/**
 * 工具名是否通过护栏。
 * @param {unknown} name
 * @returns {boolean}
 */
export function isValidToolName(name) {
  return typeof name === 'string' && NAME_PATTERN.test(name)
}

/**
 * 项目路径 → 会话目录键。
 *
 * 与宿主 `dsh-session-persistence-jsonl` 的 `projectKey` 逐分支对齐（DESIGN §1）：
 * 分隔符 `/ \ :` 折叠成一个 `-`；`[A-Za-z0-9._-]` 原样；其余码元（含 `~`）转
 * `~XXXX`（大写十六进制 4 位）；去掉前导 `-`；空则 `root`；截断到 251；
 * 两端包 `--`。
 *
 * @param {string} cwd - 会话工作目录（绝对路径）
 * @returns {string} 会话根下的目录名，如 `--home-u-Desktop-DSHWorkspace--`
 */
export function projectKey(cwd) {
  // 宿主对空串抛错；插件侧退化为 `root`，避免诊断工具因脏入参整体失败。
  if (typeof cwd !== 'string' || cwd.length === 0) return '--root--'
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * 把行数上限夹到合法区间。
 * @param {unknown} limit
 * @returns {number}
 */
function normalizeLimit(limit) {
  const n = Number(limit)
  if (!Number.isFinite(n) || n <= 0) return MAX_LINES_PER_SESSION
  return Math.floor(n)
}

/**
 * 增量式回放计数器。
 *
 * 存在的理由：会话日志通过 `zstd -dc` 以流式方式到达，逐行喂进来就能在触达行数
 * 上限时立刻停读，不必把整个日志读进内存。`countToolCalls` 是它在完整行序列上的
 * 薄封装（DESIGN §7 冻结签名）。
 *
 * @param {number} [limit] - 最多检视行数，缺省 {@link MAX_LINES_PER_SESSION}
 * @returns {{
 *   feed(line: string): boolean,
 *   result(): {callsByName: Record<string, number>, linesRead: number, toolCalls: number, skillToolCalls: number, namesRejected: number, truncated: boolean}
 * }}
 */
export function createUsageCounter(limit = MAX_LINES_PER_SESSION) {
  const max = normalizeLimit(limit)
  /** @type {Map<string, number>} */
  const counts = new Map()
  let linesRead = 0
  let toolCalls = 0
  let skillToolCalls = 0
  let namesRejected = 0
  let truncated = false

  return {
    /**
     * 喂一行（已解压的 JSONL 单行）。
     * @param {string} line
     * @returns {boolean} `true` 表示可以继续喂；`false` 表示已达上限，调用方应停止读取
     */
    feed(line) {
      if (truncated) return false
      if (linesRead >= max) {
        // 「最多检视 max 行，超出即停」：第 max+1 行到达才证明发生了截断。
        truncated = true
        return false
      }
      linesRead += 1
      if (typeof line !== 'string') return true
      const trimmed = line.trim()
      if (trimmed === '') return true

      // ── 白名单起点：只解析，不看任何业务字段 ──
      let record
      try {
        record = JSON.parse(trimmed)
      } catch {
        return true // 半行 / 损坏行：噪声，丢弃
      }
      if (record === null || typeof record !== 'object' || Array.isArray(record)) return true
      if (record.type !== 'tool/call') return true // 只认这一种事件类型
      const data = record.data
      if (data === null || typeof data !== 'object' || Array.isArray(data)) return true

      // ── 白名单终点：`data.name` 是唯一被读的数据字段 ──
      const toolName = data.name
      toolCalls += 1
      if (!isValidToolName(toolName)) {
        namesRejected += 1 // 未过护栏的名字不进计数表，只留一个可告警的信号位
        return true
      }
      counts.set(toolName, (counts.get(toolName) ?? 0) + 1)
      if (toolName === SKILL_TOOL_NAME) skillToolCalls += 1
      return true
    },

    /**
     * 汇总（键名升序，输出字节级稳定）。
     * @returns {{callsByName: Record<string, number>, linesRead: number, toolCalls: number, skillToolCalls: number, namesRejected: number, truncated: boolean}}
     */
    result() {
      /** @type {Record<string, number>} */
      const callsByName = {}
      for (const name of [...counts.keys()].sort()) {
        // `Object.fromEntries`/直接赋值遇到 `__proto__` 这类名字会走 setter，
        // 用 defineProperty 明确写成自有属性，杜绝原型污染与漏计。
        Object.defineProperty(callsByName, name, {
          value: counts.get(name) ?? 0,
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }
      return { callsByName, linesRead, toolCalls, skillToolCalls, namesRejected, truncated }
    },
  }
}

/**
 * 回放一批日志行，得到调用计数（DESIGN §7 冻结签名）。
 *
 * `lines` 可以是数组，也可以是同步生成器；触达 `limit` 时会提前 `break`，
 * 生成器的 `return()` 由 `for…of` 负责调用，因此流式读取不会漏关。
 *
 * @param {Iterable<string>} lines - 已解压的日志行
 * @param {number} [limit] - 最多检视行数，缺省 {@link MAX_LINES_PER_SESSION}
 * @returns {{callsByName: Record<string, number>, linesRead: number, toolCalls: number, skillToolCalls: number, namesRejected: number, truncated: boolean}}
 */
export function countToolCalls(lines, limit = MAX_LINES_PER_SESSION) {
  const counter = createUsageCounter(limit)
  if (lines !== null && typeof lines === 'object' && Symbol.iterator in lines) {
    for (const line of /** @type {Iterable<string>} */ (lines)) {
      if (!counter.feed(line)) break
    }
  }
  return counter.result()
}

/**
 * 从计数表里查一个名字的次数（只用自有属性，避免继承属性误命中）。
 * @param {Record<string, number>} callsByName
 * @param {string} name
 * @returns {number | undefined}
 */
export function lookupCount(callsByName, name) {
  if (callsByName === null || typeof callsByName !== 'object') return undefined
  if (!Object.hasOwn(callsByName, name)) return undefined
  const value = callsByName[name]
  return Number.isFinite(value) ? value : undefined
}
