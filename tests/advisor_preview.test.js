import test from 'node:test'
import assert from 'node:assert/strict'
import { computeFill, computeModeDetails, rowsWithMissing } from '../src/missing.ts'
import { findSensibleDefaultTestVars } from '../src/advisor.ts'

test('fill preview: computeFill accurately calculates median for skewed and mean for symmetric numeric columns', () => {
  const isMissing = (v) => v === null || v === ''

  // Salary column with extreme outlier skew: [50000, 52000, 55000, 60000, 250000]
  const salaries = [50000, 52000, null, 55000, 60000, null, 250000]
  const medianFill = computeFill(salaries, 'median', isMissing)
  assert.equal(medianFill, 55000)

  // Symmetric age distribution: [25, 30, 35]
  const ages = [25, 30, null, 35]
  const meanFill = computeFill(ages, 'mean', isMissing)
  assert.equal(meanFill, 30)
})

test('fill preview: computeFill extracts mode for categorical text columns', () => {
  const isMissing = (v) => v === null || v === ''
  const depts = ['IT', 'HR', 'IT', 'Sales', null, 'IT', 'Sales']
  const modeFill = computeFill(depts, 'mode', isMissing)
  assert.equal(modeFill, 'IT')
})

test('fill preview: computeModeDetails and tieBreaker break ties reliably', () => {
  const isMissing = (v) => v === null || v === ''
  // 2 Engineering, 2 Sales -> Tied!
  const tiedDepts = ['Engineering', 'Sales', 'Engineering', 'Sales', null]
  const details = computeModeDetails(tiedDepts, isMissing)
  assert.equal(details.tied, true)
  assert.equal(details.count, 2)
  assert.deepEqual(details.tiedModes, ['Engineering', 'Sales'])

  // Default tieBreaker ('null') returns null for pure math test parity
  assert.equal(computeFill(tiedDepts, 'mode', isMissing), null)

  // Imputation tieBreaker ('first') breaks the tie deterministically
  assert.equal(computeFill(tiedDepts, 'mode', isMissing, 'first'), 'Engineering')
})

test('completeness forecast: correctly determines complete rows gain when filling missing columns', () => {
  const isMissing = (c, v) => v === null || v === ''
  const data = {
    emp_name: ['Alice', 'Bob', 'Charlie', 'Diana', 'Evan'],
    salary: [60000, null, 70000, 80000, 75000],
    department: ['IT', 'HR', null, 'Sales', 'IT']
  }
  const allCols = ['emp_name', 'salary', 'department']

  // Rows missing in any column
  const initialIncomplete = rowsWithMissing(data, allCols, isMissing)
  assert.deepEqual(initialIncomplete, [1, 2]) // Row 1 missing salary, Row 2 missing department
  const initialComplete = 5 - initialIncomplete.length
  assert.equal(initialComplete, 3)

  // If salary is imputed, only department remains
  const afterSalaryOnly = rowsWithMissing(data, ['department'], isMissing)
  assert.deepEqual(afterSalaryOnly, [2])
  assert.equal(5 - afterSalaryOnly.length, 4)

  // If both salary and department are imputed, 0 columns remain incomplete
  const afterBoth = rowsWithMissing(data, [], isMissing)
  assert.equal(afterBoth.length, 0)
  assert.equal(5 - afterBoth.length, 5) // 100% complete!
})

test('test recommendation: findSensibleDefaultTestVars skips ID columns and pairs scale with group', () => {
  const cols = [
    { name: 'emp_name', type: 'string', measure: 'nominal' },
    { name: 'department', type: 'string', measure: 'nominal' },
    { name: 'salary', type: 'numeric', measure: 'scale' },
    { name: 'age', type: 'numeric', measure: 'scale' }
  ]
  const defaults = findSensibleDefaultTestVars(cols)
  assert.deepEqual(defaults, ['salary', 'department'])
})

test('advisor: extractJson handles raw json, markdown fences, and conversational preambles', async () => {
  const { extractJson } = await import('../src/advisor.ts')
  assert.deepEqual(extractJson('{"hello":"world"}'), { hello: 'world' })
  assert.deepEqual(extractJson('```json\n{"actions":[{"title":"Test"}]}\n```'), { actions: [{ title: 'Test' }] })
  assert.deepEqual(extractJson('Here is your analysis:\n```json\n{"score":90}\n```\nHope that helps!'), { score: 90 })
  assert.equal(extractJson('gibberish without braces'), null)
})

test('advisor: generateDatasetEdaHypotheses creates sensible Titanic-like test pairings', async () => {
  const { generateDatasetEdaHypotheses } = await import('../src/advisor.ts')
  const titanicCols = [
    { name: 'PassengerId', type: 'numeric', measure: 'nominal' },
    { name: 'Survived', type: 'numeric', measure: 'nominal' },
    { name: 'Pclass', type: 'numeric', measure: 'nominal' },
    { name: 'Sex', type: 'string', measure: 'nominal' },
    { name: 'Age', type: 'numeric', measure: 'scale' },
    { name: 'Fare', type: 'numeric', measure: 'scale' }
  ]
  const hypotheses = generateDatasetEdaHypotheses(titanicCols)
  assert.ok(hypotheses.length >= 2)
  const testIds = hypotheses.map(h => h.testId)
  assert.ok(testIds.includes('chisq_independence'))
  assert.ok(testIds.includes('ttest_independent') || testIds.includes('anova_oneway') || testIds.includes('descriptives'))
})

test('dummy_testdata: end-to-end EDA quality scan & smart hypothesis detection', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { importCsvBytes } = await import('../src/io/csv.ts')
  const { scanQuality } = await import('../src/quality.ts')
  const { generateDatasetEdaHypotheses } = await import('../src/advisor.ts')

  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const csvBuffer = readFileSync(join(root, 'tests', 'dummy_testdata.csv'))
  const ds = importCsvBytes(new Uint8Array(csvBuffer))
  assert.equal(ds.columns.length, 12)
  assert.equal(ds.data['PassengerId'].length, 891)

  // 1. Quality report
  const quality = scanQuality(ds)
  assert.ok(quality.issues.length > 0)
  const colsWithIssues = new Set(quality.issues.map(i => i.col))
  assert.ok(colsWithIssues.has('PassengerId'))
  assert.ok(colsWithIssues.has('Survived'))
  assert.ok(colsWithIssues.has('Pclass'))

  // 2. Missing data check
  const cabinData = ds.data['Cabin']
  const cabinMissingCount = cabinData.filter(v => v === null || v === '').length
  assert.equal(cabinMissingCount, 687)
  const cabinMissingPct = Math.round((cabinMissingCount / 891) * 100)
  assert.equal(cabinMissingPct, 77)

  // 3. Smart EDA Hypotheses
  const hypotheses = generateDatasetEdaHypotheses(ds.columns)
  assert.ok(hypotheses.length >= 2)
  const titles = hypotheses.map(h => h.title)
  // Should suggest bivariate EDA pairings
  assert.ok(titles.some(t => t.toLowerCase().includes('survived') || t.toLowerCase().includes('sex') || t.toLowerCase().includes('fare') || t.toLowerCase().includes('age')))
})

test('data health: issue grouping categorization separates scales, integrity, and structural issues', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { importCsvBytes } = await import('../src/io/csv.ts')
  const { scanQuality } = await import('../src/quality.ts')
  const { suitableTests } = await import('../src/advisor.ts')

  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const csvBuffer = readFileSync(join(root, 'tests', 'dummy_testdata.csv'))
  const ds = importCsvBytes(new Uint8Array(csvBuffer))
  const quality = scanQuality(ds)

  // Categorize issues
  const scaleIssues = quality.issues.filter(i => ['measureMismatch', 'typeMismatch', 'unlabeledCodes'].includes(i.kind))
  const integrityIssues = quality.issues.filter(i => ['outliers', 'sentinels', 'dirtyCategories'].includes(i.kind))
  const structuralIssues = quality.issues.filter(i => ['idLike', 'constant', 'empty', 'duplicates'].includes(i.kind))

  assert.ok(scaleIssues.length > 0, 'Must identify scale/type issues')
  assert.ok(structuralIssues.length > 0, 'Must identify structural/id issues')

  // Verify suitable tests pattern matcher for Fare (scale) + Survived (2 groups nominal)
  const fareCol = ds.columns.find(c => c.name === 'Fare')
  const survivedCol = ds.columns.find(c => c.name === 'Survived')
  if (fareCol && survivedCol) {
    fareCol.measure = 'scale'
    survivedCol.measure = 'nominal'
    const result = suitableTests([fareCol, survivedCol])
    assert.equal(result.pattern, 'scale-2group')
    assert.ok(result.testIds.includes('ttest_independent'))
    assert.ok(result.testIds.includes('mannwhitney_u'))
  }
})

test('advisor: resetAiAdvisorCache clears cached recommendations on dataset close or new open', async () => {
  const { cachedAiRec, resetAiAdvisorCache } = await import('../src/advisor.ts')

  // Set mock recommendation in cache
  cachedAiRec.value = {
    primary: { title: 'Fill missing cells', detail: 'Missing cells detected', target: 'missing', confidence: 'high' },
    secondary: [
      { title: 'Repair flagged columns', detail: 'Wrong types', target: 'readiness', confidence: 'high' },
      { title: 'Remove redundant columns', detail: 'Constant columns', target: 'readiness', confidence: 'medium' }
    ],
    source: 'ai'
  }
  assert.ok(cachedAiRec.value !== null, 'Cache must hold active recommendations')
  assert.equal(cachedAiRec.value.primary.title, 'Fill missing cells')

  // Calling resetAiAdvisorCache resets the AI analyze state
  resetAiAdvisorCache()
  assert.equal(cachedAiRec.value, null, 'Cache must be reset to null after resetAiAdvisorCache')
})


