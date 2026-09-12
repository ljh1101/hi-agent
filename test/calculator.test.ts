import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calculatorTool, evaluateExpression } from '../src/tools/calculator.ts'
import type { ToolContext } from '../src/types.ts'

const ctx: ToolContext = { root: process.cwd(), log: () => {} }

test('respects operator precedence', () => {
  assert.equal(evaluateExpression('2 + 3 * 4'), 14)
  assert.equal(evaluateExpression('(2 + 3) * 4'), 20)
  assert.equal(evaluateExpression('2 + 3 * 4 - 6 / 3'), 12)
  assert.equal(evaluateExpression('7 % 4'), 3)
})

test('handles unary signs and right-associative powers', () => {
  assert.equal(evaluateExpression('-3 + 1'), -2)
  assert.equal(evaluateExpression('-(2 + 3)'), -5)
  assert.equal(evaluateExpression('+5'), 5)
  assert.equal(evaluateExpression('2 ^ 3 ^ 2'), 512)
  assert.equal(evaluateExpression('-2 ^ 2'), -4) // as in standard math: -(2 ^ 2)
  assert.equal(evaluateExpression('(-2) ^ 2'), 4)
})

test('supports functions and constants', () => {
  assert.equal(evaluateExpression('sqrt(16)'), 4)
  assert.equal(evaluateExpression('max(1, 2, 3) + min(4, 5)'), 7)
  assert.equal(evaluateExpression('floor(3.9) + ceil(0.1)'), 4)
  assert.equal(evaluateExpression('abs(-7)'), 7)
  assert.equal(evaluateExpression('pow(2, 10)'), 1024)
  assert.ok(Math.abs(evaluateExpression('pi') - Math.PI) < 1e-12)
  assert.ok(Math.abs(evaluateExpression('2 * pi') - 2 * Math.PI) < 1e-12)
})

test('is case-insensitive about identifiers and tolerates whitespace', () => {
  assert.equal(evaluateExpression('  SQRT( 9 )  '), 3)
  assert.equal(evaluateExpression('1e3 + 0.5'), 1000.5)
})

test('rejects malformed or unsafe input instead of guessing', () => {
  assert.throws(() => evaluateExpression('1 / 0'), /Division by zero/)
  assert.throws(() => evaluateExpression('1 % 0'), /Division by zero/)
  assert.throws(() => evaluateExpression('2 +'), /Unexpected end of expression/)
  assert.throws(() => evaluateExpression('(2 + 3'), /Missing closing parenthesis/)
  assert.throws(() => evaluateExpression('2 + 3)'), /Unexpected "\)"/)
  assert.throws(() => evaluateExpression('nope(1)'), /Unknown function "nope"/)
  assert.throws(() => evaluateExpression('x + 1'), /Unknown identifier "x"/)
  assert.throws(() => evaluateExpression('10 ^ 10 ^ 10'), /overflowed/)
  assert.throws(() => evaluateExpression('1.2.3'), /Invalid number/)
  assert.throws(() => evaluateExpression('process.exit(1)'), /Unknown identifier "process"/)
  assert.throws(() => evaluateExpression(''), /Unexpected end of expression/)
})

test('the calculator tool formats its result', async () => {
  const output = await calculatorTool.execute({ expression: '(23 * 17) + 9' }, ctx)
  assert.equal(output, '(23 * 17) + 9 = 400')
})

test('the calculator tool validates its arguments', () => {
  assert.throws(() => calculatorTool.execute({ expression: '  ' }, ctx), /non-empty string/)
  assert.throws(
    () => calculatorTool.execute({ expression: 42 as unknown as string }, ctx),
    /non-empty string/,
  )
})
