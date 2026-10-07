/**
 * dsh-context-ledger — 常驻注入物的**成本侧**账目构造。
 *
 * 纯函数模块：入参是**数据**（不碰宿主服务、不碰 fs），**不得** import 任何
 * `@deepseek-ai/*` 包。
 *
 * 责任边界（DESIGN §7，硬约束）：
 * - 本模块**只**填成本侧字段（`id` / `category` / `name` / `tokens` / `source` /
 *   `server` / `bytes` / `provider` / `loadOrder`）；
 * - `calls` / `tokensPerCall` / `zeroCall` / `usageBasis` **一律不在这里出现**，
 *   它们是 `lib/reconcile.js` 的唯一赋权点（次数语义只能有一处）。
 *
 * @module lib/cost
 */

import { estimateTokens } from './tokens.js'
import { isValidToolName } from './usage.js'

/** 冻结的四类注入物键（DESIGN §2.3，顺序固定，本模块只使用、不重排）。 */
export const INSTRUCTION_CATEGORY = 'instructions'
export const SKILL_CATEGORY = 'skills'
export const TOOL_CATEGORY = 'tools'
export const MCP_CATEGORY = 'mcp'

/** MCP 工具名形态：`mcp__<server>__<tool>`（DESIGN §2.4）。 */
const MCP_NAME_PREFIX = 'mcp__'

const encoder = new TextEncoder()

/**
 * 字符串的 UTF-8 字节数。
 * @param {string} text
 * @returns {number}
 */
function utf8Bytes(text) {
  return encoder.encode(text).byteLength
}

/**
 * 键名升序的稳定序列化，用于量出 schema 的字节数。
 *
 * 只用于算字节数，**不**进产物（DESIGN §3.5：v1 不输出任何内容派生的摘要）。
 * @param {unknown} value
 * @returns {string}
 */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value)
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * 去重产物里的自由文本标签（`source` / `provider`）。
 *
 * 这两个字段由技能 provider 提供，取值域是开放的（`SkillSource` 允许任意字符串）。
 * 为了让「输出中不得出现正文」这条保证不依赖 provider 的自觉，标签也必须过同一
 * 道名字护栏：不过关就**省略该可选字段**，而不是把可疑文本写进产物。
 * @param {unknown} value
 * @returns {string | undefined}
 */
function safeLabel(value) {
  return isValidToolName(value) ? value : undefined
}

/**
 * 构造稳定唯一键：`"<category>:<name>"`（DESIGN §2.4）。
 * @param {string} category
 * @param {string} name
 * @returns {string}
 */
export function itemId(category, name) {
  return `${category}:${name}`
}

/**
 * 非负整数化：脏入参不产生 `NaN` / 负数 / 浮点 token 数。
 * @param {unknown} value
 * @returns {number}
 */
function toNonNegativeInt(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(n)
}

/**
 * 判断路径是否落在项目根内（用于给指令链文件分 `project` / `user`）。
 * @param {string} path
 * @param {string} root
 * @returns {boolean}
 */
function isInsideRoot(path, root) {
  if (typeof root !== 'string' || root === '' || !path.startsWith(root)) return false
  if (path.length === root.length) return true
  const boundary = path.charAt(root.length)
  return boundary === '/' || boundary === '\\'
}

/**
 * 指令链文件 → 账目项。
 *
 * 每个文件每请求都常驻，成本 = 文件全文的 token 估算（与参照实现同口径）；
 * 没有「调用」这个动作，因此这里不产生任何次数字段。
 *
 * @param {Array<{path: string, text?: string, bytes?: number, tokens?: number, source?: string, loadOrder?: number}>} files
 *   指令链文件（外层 → 内层顺序）；`text` 用于估算，`bytes` 缺省时由 `text` 现算
 * @param {string} root - 项目根（git 根或扫描起点）；用于推断 `source`
 * @returns {Array<Record<string, unknown>>} 成本侧账目项（`category: "instructions"`）
 */
export function instructionItems(files, root) {
  const list = Array.isArray(files) ? files : []
  const items = []
  let loadOrder = 0
  for (const file of list) {
    if (file === null || typeof file !== 'object') continue
    const path = typeof file.path === 'string' ? file.path : ''
    if (path === '') continue
    loadOrder += 1
    const text = typeof file.text === 'string' ? file.text : ''
    const tokens = Number.isFinite(file.tokens) ? toNonNegativeInt(file.tokens) : estimateTokens(text)
    const bytes = Number.isFinite(file.bytes) ? toNonNegativeInt(file.bytes) : utf8Bytes(text)
    items.push({
      id: itemId(INSTRUCTION_CATEGORY, path),
      category: INSTRUCTION_CATEGORY,
      name: path,
      tokens,
      source: safeLabel(file.source) ?? (isInsideRoot(path, root) ? 'project' : 'user'),
      bytes,
      loadOrder: Number.isFinite(file.loadOrder) ? Math.max(1, Math.round(file.loadOrder)) : loadOrder,
    })
  }
  return items
}

/**
 * 技能目录条目 → 账目项。
 *
 * 常驻成本 = 模型每请求看到的 catalog 条目文本（`name` + `description` +
 * `whenToUse`）。**不读技能正文**（BRIEF 范围红线），也不在这里做任何次数推断：
 * 技能名在 `skill` 工具的**参数**里，隐私红线禁止读参数，因此逐技能次数不可观测
 * 由 `lib/reconcile.js` 统一判成 `unobservable` / `calls = null`。
 *
 * @param {Array<{name: string, description?: string, whenToUse?: string, source?: string, provider?: string}>} skillList
 * @returns {Array<Record<string, unknown>>} 成本侧账目项（`category: "skills"`）
 */
export function skillItems(skillList) {
  const list = Array.isArray(skillList) ? skillList : []
  const items = []
  for (const skill of list) {
    if (skill === null || typeof skill !== 'object') continue
    const name = typeof skill.name === 'string' ? skill.name : ''
    if (name === '') continue
    const description = typeof skill.description === 'string' ? skill.description : ''
    const whenToUse = typeof skill.whenToUse === 'string' ? skill.whenToUse : ''
    const catalogText = `${name}\n${description}\n${whenToUse}`
    items.push({
      id: itemId(SKILL_CATEGORY, name),
      category: SKILL_CATEGORY,
      name,
      tokens: estimateTokens(name) + estimateTokens(description) + estimateTokens(whenToUse),
      source: safeLabel(skill.source),
      provider: safeLabel(skill.provider),
      bytes: utf8Bytes(catalogText),
    })
  }
  return items.map(dropUndefined)
}

/**
 * 工具 schema → 账目项（native 工具与 MCP 工具分流）。
 *
 * `mcp__<server>__<tool>` 全名进 MCP 类并解析出 `server`；其余进 native 工具类。
 * 常驻成本 = `estimateTokens(name) + estimateTokens(description)`；`bytes` = 整份
 * schema（含 `parameters`）稳定序列化后的字节数。**不读参数内容、不输出 schema
 * 摘要**（DESIGN §3.5）。
 *
 * @param {Array<{name: string, description?: string, parameters?: unknown}>} schemas
 * @returns {Array<Record<string, unknown>>} 成本侧账目项（`tools` + `mcp`）
 */
export function toolItems(schemas) {
  const list = Array.isArray(schemas) ? schemas : []
  const items = []
  for (const schema of list) {
    if (schema === null || typeof schema !== 'object') continue
    const name = typeof schema.name === 'string' ? schema.name : ''
    if (name === '') continue
    const description = typeof schema.description === 'string' ? schema.description : ''
    const isMcp = name.startsWith(MCP_NAME_PREFIX)
    const server = isMcp ? (name.split('__')[1] ?? 'unknown') : undefined
    items.push({
      id: itemId(isMcp ? MCP_CATEGORY : TOOL_CATEGORY, name),
      category: isMcp ? MCP_CATEGORY : TOOL_CATEGORY,
      name,
      tokens: estimateTokens(name) + estimateTokens(description),
      source: isMcp ? 'mcp' : 'native',
      server,
      bytes: utf8Bytes(stableJson({ name, description, parameters: schema.parameters ?? null })),
    })
  }
  return items.map(dropUndefined)
}

/**
 * 去掉值为 `undefined` 的可选字段，保证 canonical JSON 形状稳定。
 * @param {Record<string, unknown>} item
 * @returns {Record<string, unknown>}
 */
function dropUndefined(item) {
  const out = {}
  for (const [key, value] of Object.entries(item)) {
    if (value !== undefined) out[key] = value
  }
  return out
}
