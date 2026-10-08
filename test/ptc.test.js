/**
 * lib/ptc.js：PTC 声明面解析。
 *
 * 这里守两条**已付过代价**的规则：
 *  1. 文档注释归属**下一条**——按名字行朴素切分会让上一条吞掉下一条的注释（实测虚高 71 token/9 个工具）。
 *  2. 同名在 ToolArgsMap 与 ToolOutputMap 各出现一次，必须合并成"这一个工具"的成本。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DECLARATION_BASIS, SCHEMA_BASIS, parseDeclaredFace } from '../lib/ptc.js'

test('parseDeclaredFace：非 PTC 文本一律返回 null（不猜）', () => {
  assert.equal(parseDeclaredFace(''), null)
  assert.equal(parseDeclaredFace(null), null)
  assert.equal(parseDeclaredFace('interface SomethingElse { a: string }'), null)
})

test('parseDeclaredFace：文档注释归下一条，不吃进上一条', () => {
  const longDoc = 'X'.repeat(400)
  const prompt = [
    'interface ToolArgsMap {',
    '  a: JsonValue;',
    `  /** ${longDoc} */`,
    '  b: JsonValue;',
    '}',
  ].join('\n')
  const face = parseDeclaredFace(prompt)
  assert.equal(face.toolCount, 2)
  assert.equal(face.byName.a.chars, '  a: JsonValue;'.length, '上一条不得吞掉下一条的注释')
  assert.ok(face.byName.b.chars > 400, '注释应计入它所属的那一条')
})

test('parseDeclaredFace：同名两段合并为一个工具的成本', () => {
  const prompt = [
    'interface ToolArgsMap {',
    '  /** args doc */',
    '  t: JsonValue;',
    '}',
    'interface ToolOutputMap {',
    '  t: JsonValue;',
    '}',
  ].join('\n')
  const face = parseDeclaredFace(prompt)
  assert.equal(face.toolCount, 1)
  assert.equal(face.byName.t.chars, '  /** args doc */\n  t: JsonValue;'.length + '  t: JsonValue;'.length)
})

test('口径常量是冻结值（面板与模型都按它判断）', () => {
  assert.equal(SCHEMA_BASIS, 'tool-schemas')
  assert.equal(DECLARATION_BASIS, 'system-prompt-declaration')
})
