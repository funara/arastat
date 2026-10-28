import { test } from 'node:test'
import assert from 'node:assert/strict'
import { state, setDataset, clearHistory, addComputedFormulas, undo, redo } from '../src/store.ts'
import { defaultMeta } from '../src/io/types.ts'

function setup() {
  const x = defaultMeta('x', 'numeric')
  x.missing.values = [99]
  setDataset({ columns: [x], data: { x: [2, 99, null, 5] } })
  state.computedFormulas = []
  clearHistory()
}

test('AI computed formulas calculate sequentially and undo together', () => {
  setup()
  addComputedFormulas(['double = x * 2', 'plus = double + 1'])
  assert.deepEqual([...state.ds.data.double], [4, null, null, 10])
  assert.deepEqual([...state.ds.data.plus], [5, null, null, 11])
  undo()
  assert.equal(state.ds.data.double, undefined)
  assert.deepEqual([...state.computedFormulas], [])
  redo()
  assert.deepEqual([...state.ds.data.double], [4, null, null, 10])
  assert.equal(state.computedFormulas.length, 2)
})

test('AI computed proposals fail atomically for invalid or colliding formulas', () => {
  setup()
  assert.throws(() => addComputedFormulas(['good = x * 2', 'bad = x $ 2']))
  assert.throws(() => addComputedFormulas(['x = 1']))
  assert.throws(() => addComputedFormulas(['other = missing + 1']))
  assert.deepEqual(state.ds.columns.map(c => c.name), ['x'])
  assert.deepEqual([...state.computedFormulas], [])
})
