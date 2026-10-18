// Data quality scanners and fixes test suite
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  scanQuality,
  scanIdLike,
  scanMeasureMismatch,
  scanSentinels,
  scanUnlabeledCodes,
  scanConstant,
  scanEmpty,
  scanDuplicates,
  scanDirtyCategories,
  scanTypeMismatch,
  scanOutliers
} from '../src/renderer/src/quality.ts'
import { defaultMeta } from '../src/main/io/types.ts'

test('scanIdLike: skips when column measure is already nominal', () => {
  const meta = defaultMeta('emp_name', 'string')
  assert.equal(meta.measure, 'nominal')
  const values = []
  for (let i = 0; i < 50; i++) values.push(`Emp_${i}`)

  // Should return empty since it is already nominal
  const issues = scanIdLike(meta, values)
  assert.equal(issues.length, 0)
})

test('scanIdLike: flags when >=95% unique and measure is scale or ordinal', () => {
  const meta = defaultMeta('emp_id', 'numeric')
  assert.equal(meta.measure, 'scale')
  const values = []
  for (let i = 0; i < 100; i++) values.push(i)

  const issues = scanIdLike(meta, values)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].kind, 'idLike')
  assert.equal(issues[0].fix?.op, 'setMeasureNominal')

  // After fix (setting measure to nominal), scanIdLike should return empty
  meta.measure = 'nominal'
  const afterFix = scanIdLike(meta, values)
  assert.equal(afterFix.length, 0)
})

test('scanIdLike: does not flag continuous scale variables like salary', () => {
  const meta = defaultMeta('salary', 'numeric')
  assert.equal(meta.measure, 'scale')
  // 290 unique salaries
  const values = []
  for (let i = 0; i < 290; i++) values.push(50000 + i * 125.5)

  const issues = scanIdLike(meta, values)
  assert.equal(issues.length, 0, 'continuous numeric scale measurements must not be flagged as ID-like')
})

test('scanDirtyCategories: flags case/whitespace variants and provides mergeCategories fix', () => {
  const meta = defaultMeta('department', 'string')
  const values = ['Engineering', 'ENGINEERING', 'Engineering', 'Marketing']

  const issues = scanDirtyCategories(meta, values)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].kind, 'dirtyCategories')
  assert.equal(issues[0].fix?.op, 'mergeCategories')
  assert.equal(issues[0].fixNote, 'Merge case variants')
  assert.doesNotMatch(issues[0].message, /Phase 3/i)
})

test('scanMeasureMismatch: flags scale with <=10 distinct categories and clears on nominal', () => {
  const meta = defaultMeta('satisfaction', 'numeric')
  assert.equal(meta.measure, 'scale')
  // 50 rows of values 1..5
  const values = []
  for (let i = 0; i < 50; i++) values.push((i % 5) + 1)

  const issues = scanMeasureMismatch(meta, values)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].kind, 'measureMismatch')
  assert.equal(issues[0].fix?.op, 'setMeasureNominal')

  meta.measure = 'nominal'
  assert.equal(scanMeasureMismatch(meta, values).length, 0)
})

test('scanSentinels: flags extreme sentinels and clears when added to missing values', () => {
  const meta = defaultMeta('age', 'numeric')
  const values = [20, 25, 30, 35, 40, 22, 28, 33, 38, 99, 99]

  const issues = scanSentinels(meta, values)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].kind, 'sentinel')
  assert.equal(issues[0].fix?.op, 'setMetaMissing')
  assert.equal(issues[0].fix?.value, 99)

  // Declare 99 missing
  meta.missing.values.push(99)
  assert.equal(scanSentinels(meta, values).length, 0)
})

test('scanConstant and scanEmpty: identify zero-variance or unpopulated columns', () => {
  const metaConst = defaultMeta('const_col', 'numeric')
  const constVals = new Array(20).fill(42)
  const constIssues = scanConstant(metaConst, constVals)
  assert.equal(constIssues.length, 1)
  assert.equal(constIssues[0].fix?.op, 'deleteColumn')

  const metaEmpty = defaultMeta('empty_col', 'string')
  const emptyVals = new Array(20).fill(null)
  const emptyIssues = scanEmpty(metaEmpty, emptyVals)
  assert.equal(emptyIssues.length, 1)
  assert.equal(emptyIssues[0].fix?.op, 'deleteColumn')
})

test('scanQuality: aggregates overall quality report', () => {
  const ds = {
    columns: [
      defaultMeta('clean_var', 'string'),
      { ...defaultMeta('id_scale', 'numeric'), measure: 'scale' }
    ],
    data: {
      clean_var: ['A', 'B', 'A', 'B', 'A', 'B', 'A', 'B', 'A', 'B', 'A', 'B'],
      id_scale: Array.from({ length: 20 }, (_, i) => i + 1)
    }
  }

  const report = scanQuality(ds)
  assert.equal(report.byColumn['clean_var'] ?? [].length, 0)
  assert.ok((report.byColumn['id_scale'] ?? []).length > 0)
})

test('scanOutliers: does not flag discrete Likert rating scales (1-5)', () => {
  const meta = defaultMeta('performance_rating', 'numeric')
  meta.measure = 'scale'
  // 100 rows of ratings 1 to 5
  const values = []
  for (let i = 0; i < 100; i++) values.push((i % 5) + 1)

  const issues = scanOutliers(meta, values)
  assert.equal(issues.length, 0, 'discrete 1-5 rating scales must not be flagged as having outliers')
})

test('scanOutliers: flags continuous outliers and provides winsorize fix', () => {
  const meta = defaultMeta('salary', 'numeric')
  meta.measure = 'scale'
  // Normal distribution around 50,000 with 3 extreme outliers
  const values = []
  for (let i = 0; i < 97; i++) values.push(50000 + (i % 10) * 1000)
  values.push(200000, 250000, 300000) // 3% outliers

  const issues = scanOutliers(meta, values)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].kind, 'outliers')
  assert.equal(issues[0].fix?.op, 'winsorize')
})

test('scanUnlabeledCodes: skips zero-based count columns (SibSp/Parch-like 0..6)', () => {
  const meta = defaultMeta('parch', 'numeric')
  const values = []
  for (let i = 0; i < 60; i++) values.push(0)
  for (let i = 0; i < 20; i++) values.push(1)
  values.push(2, 2, 3, 4, 5, 6)
  assert.equal(scanUnlabeledCodes(meta, values).length, 0)
  // measureMismatch intentionally still fires (nominal treatment harmless)
  assert.equal(scanMeasureMismatch(meta, values).length, 1)
})

test('scanUnlabeledCodes: still fires on binary 0/1, Likert 1-5, and 0-4 scales', () => {
  const bin = defaultMeta('survived', 'numeric')
  const binVals = [...new Array(50).fill(0), ...new Array(50).fill(1)]
  assert.equal(scanUnlabeledCodes(bin, binVals).length, 1)
  const lik = defaultMeta('rating', 'numeric')
  const likVals = []
  for (let i = 0; i < 50; i++) likVals.push((i % 5) + 1)
  assert.equal(scanUnlabeledCodes(lik, likVals).length, 1)
  const z45 = defaultMeta('zero_four', 'numeric')
  const z45Vals = []
  for (let i = 0; i < 50; i++) z45Vals.push(i % 5)
  assert.equal(scanUnlabeledCodes(z45, z45Vals).length, 1)
})

test('scanUnlabeledCodes: Pclass-like {1,2,3} uses observed range Codes 1–3', () => {
  const meta = defaultMeta('pclass', 'numeric')
  const values = []
  for (let i = 0; i < 60; i++) values.push(1)
  for (let i = 0; i < 25; i++) values.push(2)
  for (let i = 0; i < 15; i++) values.push(3)
  const issues = scanUnlabeledCodes(meta, values)
  assert.equal(issues.length, 1)
  assert.match(issues[0].evidence, /^Codes 1–3,/)
})

test('scanOutliers: clamps displayed bounds to observed min on non-negative data', () => {
  const meta = defaultMeta('fare', 'numeric')
  meta.measure = 'scale'
  const values = []
  for (let i = 0; i < 97; i++) values.push(8 + (i % 10))
  values.push(0, 100, 200) // low zero + high extremes
  const issues = scanOutliers(meta, values)
  assert.equal(issues.length, 1)
  assert.match(issues[0].evidence, /^(\d+) outliers/)
  const lo = Number(/bounds \[([^,]+),/.exec(issues[0].evidence)?.[1])
  assert.ok(lo >= 0, `displayed lo bound must be non-negative, got ${lo}`)
})
