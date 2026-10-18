// computeFill / rowsWithMissing: fill math, tie + all-missing no-ops, drop union.
import test from 'node:test'
import assert from 'node:assert/strict'
import { computeFill, rowsWithMissing, interpolateValues } from '../src/missing.ts'

const isNull = (v) => v === null

test('mean ignores missing cells', () => {
  assert.equal(computeFill([1, 2, null, 4], 'mean', isNull), 7 / 3)
})

test('median covers odd and even counts', () => {
  assert.equal(computeFill([3, 1, 2, null], 'median', isNull), 2)
  assert.equal(computeFill([4, 1, 2, 3], 'median', isNull), 2.5)
})

test('user-missing codes do not poison the fill value', () => {
  const isMissing = (v) => v === null || v === 99
  assert.equal(computeFill([10, 20, 99, null], 'mean', isMissing), 15)
  assert.deepEqual(rowsWithMissing({ a: [1, 99, 3] }, ['a'], () => false), [])
  assert.deepEqual(rowsWithMissing({ a: [1, 99, 3] }, ['a'], (c, v) => v === 99), [1])
})

test('mode picks the winner, ties and empties return null', () => {
  assert.equal(computeFill(['x', 'y', 'x', null], 'mode', isNull), 'x')
  assert.equal(computeFill(['x', 'y'], 'mode', isNull), null)
  assert.equal(computeFill([null, null], 'mean', isNull), null)
  assert.equal(computeFill([null], 'mode', isNull), null)
})

test('mean and median need numerics', () => {
  assert.equal(computeFill(['a', 'b'], 'mean', isNull), null)
  assert.equal(computeFill(['a', 'a'], 'median', isNull), null)
  assert.equal(computeFill(['a', 'b', 'a'], 'mode', isNull), 'a')
})

test('rowsWithMissing unions across columns in order', () => {
  const data = { a: [1, null, 3], b: ['x', 'y', null] }
  assert.deepEqual(rowsWithMissing(data, ['a', 'b'], (c, v) => v === null), [1, 2])
  assert.deepEqual(rowsWithMissing(data, ['a'], (c, v) => v === null), [1])
  assert.deepEqual(rowsWithMissing(data, ['b'], (c, v) => v === null), [2])
  assert.deepEqual(rowsWithMissing({ a: [1, 2] }, ['a'], (c, v) => v === null), [])
})

test('interpolateValues handles interior gaps, leading backfill, and trailing forward fill', () => {
  const isMissing = (v) => v === null || v === 99
  const seq = [null, 10, null, null, 40, null]
  const edits = interpolateValues(seq, isMissing, 1)
  assert.deepEqual(edits, [
    { row: 0, next: 10 },
    { row: 2, next: 20 },
    { row: 3, next: 30 },
    { row: 5, next: 40 }
  ])
})

test('interpolateValues returns empty if all missing or no numerics', () => {
  const isNull = (v) => v === null
  assert.deepEqual(interpolateValues([null, null], isNull), [])
  assert.deepEqual(interpolateValues(['a', null, 'b'], isNull), [])
})
