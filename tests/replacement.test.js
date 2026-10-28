import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openWithDialog } from '../src/fileOps.ts'
import { state, setDataset, clearHistory, setCell, undoDepth, imputeColumnsBatch, undo } from '../src/store.ts'
import { computed, nextTick, ref } from 'vue'
import { computeHealth } from '../src/quality.ts'
import { defaultMeta } from '../src/io/types.ts'
import { runsState } from '../src/results.ts'
import { resetDatasetSession, resetProjectHistory, watchDatasetSession } from '../src/session.ts'

test('cancelled file replacement keeps data and undo history', async () => {
  setDataset({ columns: [defaultMeta('x', 'numeric')], data: { x: [1] } })
  clearHistory()
  setCell('x', 0, 2)
  let reads = 0
  globalThis.window = { ara: { file: { open: async () => 'sample.csv', readBytes: async () => { reads++; return null } } } }
  try {
    const result = await openWithDialog(() => assert.fail('restore called'), async () => false)
    assert.equal(result.kind, 'cancel')
    assert.equal(state.ds.data.x[0], 2)
    assert.equal(undoDepth(), 1)
    assert.equal(reads, 0)
  } finally {
    delete globalThis.window
  }
})

test('confirmed dataset replacements reset results, formulas, and history', () => {
  for (const action of ['sample', 'new', 'paste']) {
    setDataset({ columns: [defaultMeta('x', 'numeric')], data: { x: [1] } })
    state.computedFormulas = ['derived = x * 2']
    runsState.runs = [{ runId: action }]
    setCell('x', 0, 2)
    resetDatasetSession()
    assert.equal(undoDepth(), 0)
    assert.deepEqual([...state.computedFormulas], [])
    assert.deepEqual([...runsState.runs], [])
  }
})

test('applying an undoable health fix refreshes health without resetting the step', async () => {
  setDataset({ columns: [defaultMeta('x', 'numeric')], data: { x: [1, null, 3] } })
  const step = ref(3)
  const health = computed(() => computeHealth(state.ds))
  const before = health.value.dimensions.find((d) => d.id === 'completeness').pct
  const stop = watchDatasetSession(() => { step.value = 1 })
  try {
    imputeColumnsBatch([{ colName: 'x', method: 'mean' }])
    await nextTick()
    assert.equal(step.value, 3)
    assert.ok(health.value.dimensions.find((d) => d.id === 'completeness').pct > before)
    undo()
    await nextTick()
    assert.equal(step.value, 3)
    assert.equal(health.value.dimensions.find((d) => d.id === 'completeness').pct, before)
    state.filename = 'saved-under-another-name.ara.zip'
    await nextTick()
    assert.equal(step.value, 3)
    setDataset({ columns: [defaultMeta('x', 'numeric')], data: { x: [5] } })
    resetDatasetSession()
    await nextTick()
    assert.equal(step.value, 1)
    step.value = 3
    resetProjectHistory()
    await nextTick()
    assert.equal(step.value, 1)
  } finally {
    stop()
  }
})

test('project replacement keeps restored results and formulas while clearing old history', () => {
  state.computedFormulas = ['restored = x * 2']
  runsState.runs = [{ runId: 'restored' }]
  setDataset({ columns: [defaultMeta('x', 'numeric')], data: { x: [3] } })
  resetProjectHistory()
  assert.equal(undoDepth(), 0)
  assert.deepEqual([...state.computedFormulas], ['restored = x * 2'])
  assert.equal(runsState.runs[0].runId, 'restored')
})
