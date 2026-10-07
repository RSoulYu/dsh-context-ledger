/**
 * dsh-context-ledger — token 估算与格式化。
 *
 * 纯函数模块：**不得** import 任何 `@deepseek-ai/*` 包，否则 `node --test` 跑不起来
 * （宿主依赖只允许出现在 `index.js`）。
 *
 * 估算器与 DESIGN §2.8 冻结值一致：`heuristic-v1 = ceil(ascii/4 + nonAscii/1.5)`。
 * 契约明确它「仅用于相对比较与排序」，精确值以模型 tokenizer 为准；与
 * context-doctor 同口径是为了便于横向比对两边报出来的同一个数字。
 *
 * @module lib/tokens
 */

/** 冻结的估算器标识（DESIGN §2.8 / §2.1 `estimator` 字段取值）。 */
export const ESTIMATOR = 'heuristic-v1'

/**
 * 启发式 token 估算。
 *
 * ASCII 约 4 字符/token，非 ASCII（中文、emoji 等）约 1.5 字符/token。
 * 按 **码点** 计数（`for…of` 语义），与参照实现逐字节一致。
 *
 * @param {string} text - 待估算文本；非字符串按空串处理（插件不因脏入参抛错）
 * @returns {number} 非负整数 token 估算值
 */
export function estimateTokens(text) {
  const value = typeof text === 'string' ? text : ''
  let ascii = 0
  let nonAscii = 0
  for (const ch of value) {
    if (ch.codePointAt(0) < 0x80) ascii += 1
    else nonAscii += 1
  }
  return Math.ceil(ascii / 4 + nonAscii / 1.5)
}

/**
 * 把 token 数格式化为人类可读：`1234` → `"1.2k"`，`50000` → `"50k"`。
 *
 * 与参照实现同规则，避免同一个数字在两处显示成不同字符串。
 *
 * @param {number} n - token 数
 * @returns {string}
 */
export function formatTokens(n) {
  const value = Number.isFinite(n) ? n : 0
  if (value < 1000) return String(value)
  const k = value / 1000
  if (k >= 100 || Number.isInteger(k)) return `${Math.round(k)}k`
  return `${k.toFixed(1)}k`
}

/**
 * 把字节数格式化为人类可读：`2048` → `"2.0 KB"`。
 *
 * 注意：DESIGN §7 把返回类型写成了 `number`，那是笔误——它是给面板与
 * native 渲染用的展示字符串（参照实现亦然）。此处按语义返回字符串。
 *
 * @param {number} n - 字节数
 * @returns {string}
 */
export function formatBytes(n) {
  const value = Number.isFinite(n) ? n : 0
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${value} B`
}
