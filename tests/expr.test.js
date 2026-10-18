// Compute Variable expression evaluator (CSP-safe, no eval): real module import.
import test from 'node:test'
import assert from 'node:assert/strict'
import { evalExprTokens, tokenizeExpr } from '../src/expr.ts'

const toks = tokenizeExpr

test('compute evaluator: precedence and grouping', () => {
  assert.equal(evalExprTokens(toks('2+3*4'), {}), 14)
  assert.equal(evalExprTokens(toks('(2+3)*4'), {}), 20)
  assert.equal(evalExprTokens(toks('-x + 1'), { x: 5 }), -4)
})

test('compute evaluator: variables and missing cells', () => {
  assert.equal(evalExprTokens(toks('a * b'), { a: 3, b: 4 }), 12)
  assert.equal(evalExprTokens(toks('a + b'), { a: 1, b: null }), null) // missing cell → null for that row
})

test('compute evaluator: malformed input returns null, division by zero is NaN', () => {
  assert.equal(evalExprTokens(toks('a b'), { a: 1, b: 2 }), null) // juxtaposed identifiers
  assert.equal(evalExprTokens(toks('a +'), { a: 1 }), null) // trailing operator
  assert.equal(evalExprTokens(toks('(a'), { a: 1 }), null) // unbalanced paren
  assert.equal(evalExprTokens(toks('unknown + 1'), { a: 1 }), null) // non-numeric variable
  assert.ok(Number.isNaN(evalExprTokens(toks('1 / 0'), {}))) // parse-valid, caller maps NaN → missing
})
