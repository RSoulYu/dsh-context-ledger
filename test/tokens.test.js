/**
 * lib/tokens.js —— token 估算与格式化。
 *
 * 验收要求的一条：token 估算。这里同时钉住 DESIGN §2.8 的估算器口径
 * （`ceil(ascii/4 + nonAscii/1.5)`），因为它是「成本」这一侧的唯一量纲。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ESTIMATOR, estimateTokens, formatBytes, formatTokens } from '../lib/tokens.js'

test('estimateTokens：空串与 ASCII 按 4 字符/token', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('a'), 1)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcde'), 2)
  assert.equal(estimateTokens('a'.repeat(400)), 100)
})

test('estimateTokens：非 ASCII 按 1.5 字符/token', () => {
  assert.equal(estimateTokens('中'), 1)
  assert.equal(estimateTokens('中文'), 2)
  assert.equal(estimateTokens('中文字'), 2)
  assert.equal(estimateTokens('中文字符'), 3)
})

test('estimateTokens：混合文本按两类分别计费后求和', () => {
  assert.equal(estimateTokens('a中'), 1) // ceil(0.25 + 0.667)
  assert.equal(estimateTokens('abcd中文'), 3) // ceil(1 + 1.333)
})

test('estimateTokens：按码点计数（代理对算一个非 ASCII 字符）', () => {
  assert.equal(estimateTokens('🙂'), 1)
  assert.equal(estimateTokens('🙂🙂🙂'), 2) // ceil(3 / 1.5)
})

test('estimateTokens：脏入参不抛错', () => {
  assert.equal(estimateTokens(undefined), 0)
  assert.equal(estimateTokens(null), 0)
  assert.equal(estimateTokens(42), 0)
})

test('ESTIMATOR 是 DESIGN §2.8 冻结的常量', () => {
  assert.equal(ESTIMATOR, 'heuristic-v1')
})

test('formatTokens / formatBytes', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1000), '1k')
  assert.equal(formatTokens(1249), '1.2k')
  assert.equal(formatTokens(12000), '12k')
  assert.equal(formatTokens(120000), '120k')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB')
})
