// computeHealth + AI-first recommendation fallback tests
import test from 'node:test'
import assert from 'node:assert/strict'
import { computeHealth } from '../src/renderer/src/quality.ts'
import { getAiRecommendation, ruleBasedRecs } from '../src/renderer/src/advisor.ts'
import { defaultMeta } from '../src/main/io/types.ts'

test('computeHealth: 100 rows with 10 missing cells in one of two columns', () => {
  const colA = defaultMeta('score', 'numeric')
  const colB = defaultMeta('group', 'string')
  colB.measure = 'nominal'
  const score = [...Array(90).fill(50), ...Array(10).fill(null)]
  const group = Array(100).fill('a')
  const ds = { columns: [colA, colB], data: { score, group } }
  const h = computeHealth(ds)
  assert.ok(h)
  assert.equal(h.rows, 100)
  assert.equal(h.columns, 2)
  const comp = h.dimensions.find((d) => d.id === 'completeness')
  assert.ok(comp)
  // 190/200 cells filled = 95%
  assert.equal(Math.round(comp.pct), 95)
  assert.ok(h.score >= 0 && h.score <= 100)
  assert.equal(h.dimensions.length, 4)
})

test('computeHealth: empty dataset returns null, not 0', () => {
  assert.equal(computeHealth({ columns: [], data: {} }), null)
  const c = defaultMeta('x', 'numeric')
  assert.equal(computeHealth({ columns: [c], data: { x: [] } }), null)
})

test('computeHealth: same column counted once per dimension (Likert 1-5)', () => {
  const c = defaultMeta('rating', 'numeric')
  const vals = []
  for (let i = 0; i < 100; i++) vals.push((i % 5) + 1)
  const ds = { columns: [c], data: { rating: vals } }
  const h = computeHealth(ds)
  assert.ok(h)
  // Likert fires measureMismatch + unlabeledCodes on one column; validity must be 0, not negative
  const validity = h.dimensions.find((d) => d.id === 'validity')
  assert.ok(validity)
  assert.equal(Math.round(validity.pct), 0)
})

test('ruleBasedRecs: 1 primary + 2 secondary, missing first', () => {
  const r = ruleBasedRecs({ score: 80, rows: 100, columns: 3, missingPct: 10, topIssues: [{ kind: 'duplicates', col: 'b' }] })
  assert.ok(r.primary.title.length > 0)
  assert.equal(r.secondary.length, 2)
  assert.match(r.primary.title.toLowerCase(), /fill|drop/)
})

test('getAiRecommendation: no AI bridge falls back without throwing', async () => {
  const r = await getAiRecommendation({ score: null, rows: 0, columns: 0, missingPct: 0, topIssues: [] })
  assert.equal(r.source, 'fallback')
  assert.ok(r.primary)
  assert.equal(r.secondary.length, 2)
})

test('defaultMeta: SPSS-compatible numeric and string widths', () => {
  assert.equal(defaultMeta('x', 'numeric').width, 8)
  assert.equal(defaultMeta('s', 'string').width, 0)
})
