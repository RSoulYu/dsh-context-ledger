/**
 * dsh-context-ledger — PTC 模式下的「声明面」测量。
 *
 * ## 为什么需要它
 *
 * DSH 的 PTC 传输下，线上只发 1 个 `run_code`，**全部工具的声明被搬进系统提示**的
 * `tools:sdk` 段（`system/message` → `data.message.content[0].text`）。此时：
 *   - `request/header.tools` 只剩 `run_code`（不是声明面）；
 *   - JSON schema 也不再是模型看到的东西（不是声明面）。
 * 所以按 schema 量出来的「常驻成本」在 PTC 下**系统性低估约 4 倍**（2026-10-08 实测）。
 * 本模块从系统提示里把真正的那一份量出来。
 *
 * ## 归因规则
 *
 * 一条声明的边界 = 它自己的名字行 + **紧随其后的文档注释归下一条**。
 * 按名字行朴素切分会把下一条的注释算进本条（实测让 9 个工具虚高 71 token）。
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { estimateTokens } from './tokens.js'

/**
 * `scope.measureBasis` 的取值（§2.2 v5）。
 *
 * - `system-prompt-declaration`：PTC 传输下模型真正收到的是**系统提示**里的 `tools:sdk` 声明，
 *   常驻成本必须在那一份上量。
 * - `tool-schemas`：非 PTC，或声明面读不到时的退路——按 JSON schema 估算。
 *
 * 二者不可混用：同一批工具在 PTC 下按 schema 量会**低估约 4 倍**（2026-10-08 实测）。
 *
 * 常量放在本模块（而非 `reconcile.js`）是有意的：link 安装下热重载可能只换掉部分模块，
 * 若常量定义在"可能还是旧的"那个模块里，新代码就会在运行期拿到未定义标识符。
 */
export const SCHEMA_BASIS = 'tool-schemas'
export const DECLARATION_BASIS = 'system-prompt-declaration'

/** 系统提示里声明段的标识（dsh-tools 的 `renderToolsSdk` 生成）。 */
const ARGS_MARK = 'interface ToolArgsMap'
const OUTPUT_MARK = 'interface ToolOutputMap'

/** 名字行：恰好两个空格缩进 + 标识符 + 冒号。 */
const NAME_LINE = /^ {2}([A-Za-z_][A-Za-z0-9_]*):/
/** 文档注释行：恰好两个空格缩进 + `/**`。 */
const DOC_LINE = /^ {2}\/\*\*/

/**
 * 解析系统提示里的 `tools:sdk` 声明段。
 *
 * @param {string} promptText - 整段系统提示文本
 * @returns {{byName: Record<string, {chars: number, tokens: number}>, totalTokens: number, toolCount: number} | null}
 *   解析不到声明段时返回 `null`（如实表示"这个传输下量不到"，不猜）。
 */
export function parseDeclaredFace(promptText) {
  if (typeof promptText !== 'string' || promptText.length === 0) return null
  if (!promptText.includes(ARGS_MARK)) return null

  /** @type {Record<string, {chars: number, tokens: number}>} */
  const byName = {}
  let totalTokens = 0
  let toolCount = 0

  for (const mark of [ARGS_MARK, OUTPUT_MARK]) {
    const block = sliceBlock(promptText, mark)
    if (block === null) continue
    for (const [name, text] of entriesOf(block)) {
      const chars = text.length
      const tokens = estimateTokens(text)
      const prev = byName[name]
      if (prev === undefined) {
        byName[name] = { chars, tokens }
        totalTokens += tokens
        toolCount += 1
      } else {
        // 同名在两段里各出现一次（参数的 + 返回的）：合并成"这一个工具"的声明成本。
        const merged = { chars: prev.chars + chars, tokens: prev.tokens + tokens }
        byName[name] = merged
        totalTokens += tokens
      }
    }
  }
  return toolCount > 0 ? { byName, totalTokens, toolCount } : null
}

/** 取 `mark` 开始、到该块结束（行首 `}`）为止的文本。 */
function sliceBlock(text, mark) {
  const start = text.indexOf(mark)
  if (start < 0) return null
  const end = text.indexOf('\n}', start)
  return text.slice(start, end < 0 ? text.length : end)
}

/**
 * 把一个声明段切成 `[名字, 该条声明的完整文本]`。
 * 文档注释归属**下一条**：条目从"紧跟其后的那条注释"之前开始，到"下一条的注释或名字行"之前结束。
 */
function entriesOf(block) {
  const names = []
  const docs = []
  const lines = block.split('\n')
  let offset = 0
  for (const line of lines) {
    if (NAME_LINE.test(line)) names.push({ at: offset, name: NAME_LINE.exec(line)[1] })
    else if (DOC_LINE.test(line)) docs.push(offset)
    offset += line.length + 1
  }
  const out = []
  for (let i = 0; i < names.length; i += 1) {
    const pos = names[i].at
    const nextName = i + 1 < names.length ? names[i + 1].at : block.length
    // 结束点 = **下一条自己的注释或名字行**之前（注释属于下一条，不能算进本条）
    const nextDoc = docs.find(d => d > pos)
    const end = nextDoc !== undefined && nextDoc < nextName ? nextDoc : nextName
    // 起点 = **紧邻本条**的那条注释（若它与名字行之间只有这一条注释）
    let start = pos
    const before = docs.filter(d => d < pos)
    if (before.length > 0) {
      const d = before[before.length - 1]
      const seg = block.slice(d, pos)
      if (seg.trimEnd().endsWith('*/') && seg.indexOf('/**') === seg.lastIndexOf('/**')) start = d
    }
    out.push([names[i].name, block.slice(start, end).replace(/\s+$/, '')])
  }
  return out
}

/**
 * 从一份会话日志里取「模型当前看到的声明面」。
 *
 * 只读**首个**含 `tools:sdk` 的 `system/message` 就返回——系统提示在会话里是不变的，
 * 不必回放整份日志。读不到（老日志 / 非 PTC）返回 `null`。
 *
 * @param {string} logPath
 * @param {number} [limit] - 最多读多少行（防御性上限）
 * @param {AbortSignal} [signal]
 */
export async function readDeclaredFace(logPath, limit = 20000, signal) {
  const isZstd = typeof logPath === 'string' && logPath.endsWith('.zstd')
  const child = isZstd ? spawn('zstd', ['-dc', logPath], { stdio: ['ignore', 'pipe', 'ignore'] }) : null
  const input = child !== null ? child.stdout : createReadStream(logPath)
  const iface = createInterface({ input, crlfDelay: Infinity })
  let read = 0
  try {
    for await (const line of iface) {
      if (signal?.aborted === true) break
      read += 1
      if (read > limit) break
      if (!line.includes(ARGS_MARK)) continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (record === null || typeof record !== 'object' || record.type !== 'system/message') continue
      const content = record.data?.message?.content
      const text = Array.isArray(content) ? content[0]?.text : undefined
      const parsed = parseDeclaredFace(typeof text === 'string' ? text : '')
      if (parsed !== null) return parsed
    }
    return null
  } finally {
    iface.close()
    child?.kill()
  }
}
