// Workbench helpers added by the Visualize / Analyze / Results upgrade:
// the shared group-level reader, the schema-driven companion plot, the APA
// verdict chip, the assumption pills and the robust fallback map.
import test from 'node:test'
import assert from 'node:assert/strict'
import { state } from '../src/store.ts'
import { defaultMeta } from '../src/io/types.ts'
import {
  distinctGroupLevels,
  robustFallback,
  fallbackForViolation,
  suitableTests,
} from '../src/advisor.ts'
import { defaultChartForSpec } from '../src/specs.ts'
import { buildTraces, cleanRows, olsTrend, captionFor } from '../src/vizCharts.ts'
import {
  fmtCell,
  isPColumn,
  decimalPlaces,
  extractApaSummary,
  parseAssumptionPills,
} from '../src/format.ts'

function runWith(elements, analysisId = 'ttest_independent', spec = {}) {
  return {
    runId: 'run1',
    analysisId,
    title: 'Analysis',
    spec,
    missingPolicy: 'listwise',
    status: 'done',
    elements,
    lastSeq: 1,
    fresh: false,
    createdAt: 0,
    startTime: 0,
    revealed: true,
  }
}

function tableEl(overrides = {}) {
  return {
    address: 'run1/table/2',
    status: 'ok',
    kind: 'table',
    caption: 'Test results',
    columns: ['', 't', 'df', 'p'],
    rows: [['dep', -3.42, 118, 0.0004]],
    footnotes: [],
    ...overrides,
  }
}

// --- distinctGroupLevels ---------------------------------------------------

test('distinctGroupLevels skips user-missing cells and counts the rest', () => {
  const meta = defaultMeta('group', 'string')
  meta.measure = 'nominal'
  meta.valueLabels = { 0: 'Control', 1: 'Treatment' }
  meta.missing = { values: [99], ranges: [] }
  state.ds = {
    columns: [meta],
    data: { group: [0, 1, 0, null, 99, '', 1] },
  }
  const levels = distinctGroupLevels('group')
  assert.equal(levels.length, 2)
  assert.deepEqual(levels[0], { value: '0', label: 'Control', n: 2 })
  assert.deepEqual(levels[1], { value: '1', label: 'Treatment', n: 2 })
})

test('distinctGroupLevels drives the 2-group vs multi-group test split', () => {
  const meta = defaultMeta('dept', 'string')
  meta.measure = 'nominal'
  state.ds = {
    columns: [meta],
    data: { dept: ['IT', 'HR', 'Sales', 'IT'] },
  }
  const scale = defaultMeta('salary', 'numeric')
  const cols = [scale, meta]
  assert.equal(suitableTests(cols).pattern, 'scale-2group')
  assert.equal(
    suitableTests(cols, { groupLevels: distinctGroupLevels('dept').length }).pattern,
    'scale-multigroup'
  )
})

// --- defaultChartForSpec ---------------------------------------------------

test('defaultChartForSpec picks the natural companion plot per analysis', () => {
  assert.deepEqual(defaultChartForSpec('descriptives', { variables: ['age', 'pay'] }), {
    type: 'hist',
    x: 'age',
    title: 'Distribution of age',
  })
  assert.deepEqual(defaultChartForSpec('ttest_independent', { dep: 'pay', group: 'dept' }), {
    type: 'bar',
    x: 'dept',
    y: 'pay',
    title: 'Mean pay by dept',
  })
  assert.deepEqual(defaultChartForSpec('ttest_paired', { a: 'pre', b: 'post' }), {
    type: 'scatter',
    x: 'pre',
    y: 'post',
    title: 'post vs pre',
  })
  assert.deepEqual(defaultChartForSpec('anova_oneway', { dep: 'pay', factor: 'dept' }), {
    type: 'bar',
    x: 'dept',
    y: 'pay',
    title: 'Mean pay by dept',
  })
})

test('defaultChartForSpec returns null when no honest plot exists', () => {
  assert.equal(defaultChartForSpec('chisq_independence', { row: 'a', col: 'b' }), null)
  assert.equal(defaultChartForSpec('factor_efa', { vars: ['q1', 'q2'] }), null)
  assert.equal(defaultChartForSpec('descriptives', {}), null)
})

// --- p-column detection ----------------------------------------------------

test('isPColumn recognises every p-value header the engine emits', () => {
  for (const h of ['p', 'P', ' p ', 'p adj', 'exact p', 'bartlett p', 'chi2 p', 'p < .001']) {
    assert.ok(isPColumn(h), `${h} should be a p column`)
  }
  for (const h of ['M', 'SD', 'n', 'Group', 'price', 'Pearson r']) {
    assert.ok(!isPColumn(h), `${h} should not be a p column`)
  }
})

test('decimalPlaces drives the displayed precision', () => {
  const before = decimalPlaces.value
  decimalPlaces.value = 2
  assert.equal(fmtCell(1.23456), '1.23')
  decimalPlaces.value = 4
  assert.equal(fmtCell(1.23456), '1.2346')
  decimalPlaces.value = before
})

// --- APA verdict chip ------------------------------------------------------

test('extractApaSummary builds the t-test citation from the results table', () => {
  const summary = extractApaSummary(runWith([tableEl()]))
  assert.ok(summary)
  assert.equal(summary.text, 't(118) = -3.42, p < .001')
  assert.equal(summary.significant, true)
})

test('extractApaSummary builds the F citation with both degrees of freedom', () => {
  const el = tableEl({
    caption: 'ANOVA summary',
    columns: ['F', 'df1', 'df2', 'p'],
    rows: [[8.14, 2, 117, 0.0003]],
  })
  const summary = extractApaSummary(runWith([el], 'anova_oneway'))
  assert.ok(summary)
  assert.equal(summary.text, 'F(2, 117) = 8.14, p < .001')
})

test('extractApaSummary falls back to the footnote for chi-square', () => {
  const el = tableEl({
    caption: 'Chi-square test of independence',
    columns: ['', 'a', 'b'],
    rows: [['r1', 10, 20]],
    footnotes: ['Note. Cramér’s V = 0.213. n = 891, χ²(2) = 5.41, p = .019.'],
  })
  const summary = extractApaSummary(runWith([el], 'chisq_independence'))
  assert.ok(summary)
  assert.equal(summary.text, 'χ²(2) = 5.41, p = .019')
  assert.equal(summary.significant, true)
})

test('extractApaSummary returns null when the run reports no statistic', () => {
  const el = tableEl({
    caption: 'Descriptive statistics',
    columns: ['Variable', 'n', 'M', 'SD'],
    rows: [['age', 10, 30.2, 4.1]],
  })
  assert.equal(extractApaSummary(runWith([el], 'descriptives')), null)
})

// --- assumption pills ------------------------------------------------------

test('parseAssumptionPills turns the engine note into status pills', () => {
  const note = {
    address: 'run1/note/assumptions',
    status: 'ok',
    kind: 'note',
    text:
      'Assumption checks: normality (Shapiro-Wilk) p = .012; ' +
      'equal variances (Levene) p = .450; serial independence (Durbin-Watson) = 1.23.',
  }
  const pills = parseAssumptionPills(runWith([note]))
  assert.equal(pills.length, 3)
  assert.deepEqual(pills[0], { label: 'Shapiro-Wilk', detail: 'p = .012', p: 0.012, violated: true })
  assert.equal(pills[1].label, 'Levene')
  assert.equal(pills[1].violated, false)
  assert.equal(pills[2].label, 'Durbin-Watson')
  assert.equal(pills[2].p, null)
  assert.equal(pills[2].violated, false)
})

test('parseAssumptionPills returns nothing when the run has no assumption note', () => {
  assert.deepEqual(parseAssumptionPills(runWith([tableEl()])), [])
})

// --- robust fallback -------------------------------------------------------

test('fallbackForViolation maps a violated assumption to the robust test', () => {
  assert.equal(fallbackForViolation('ttest_independent', ['Shapiro-Wilk']), 'mannwhitney_u')
  assert.equal(fallbackForViolation('anova_oneway', ['Shapiro-Wilk']), 'kruskal_wallis')
  assert.equal(fallbackForViolation('anova_oneway', ['Levene']), 'welch_anova')
  assert.equal(fallbackForViolation('ttest_paired', ['Shapiro-Wilk']), 'wilcoxon_signedrank')
  assert.equal(fallbackForViolation('ttest_independent', []), null)
  assert.equal(fallbackForViolation('descriptives', ['Shapiro-Wilk']), null)
})

test('robustFallback builds an engine-valid spec with the same variables', () => {
  const fb = robustFallback('ttest_independent', { dep: 'pay', group: 'dept' })
  assert.ok(fb)
  assert.equal(fb.analysisId, 'mannwhitney_u')
  assert.equal(fb.options.dep, 'pay')
  assert.equal(fb.options.group, 'dept')

  const welch = robustFallback('anova_oneway', { dep: 'pay', factor: 'dept' }, 'welch_anova')
  assert.ok(welch)
  assert.equal(welch.analysisId, 'welch_anova')
  assert.equal(welch.options.dep, 'pay')
  assert.equal(welch.options.factor, 'dept')
  assert.equal(welch.options.useVar, 'unequal')

  const one = robustFallback('ttest_onesample', { dep: 'score', testValue: 70 })
  assert.ok(one)
  assert.equal(one.analysisId, 'wilcoxon_one_sample')
  assert.equal(one.options.mu, 70)
  assert.equal(one.options.testValue, undefined)
})

// --- Visualize chart building ------------------------------------------------

const THEME = {
  primary: '#2367ec',
  border: '#1b58cf',
  text: '#0f172a',
  muted: '#64748b',
  grid: '#e2e8f0',
  surface: '#ffffff',
  palette: ['#2367ec', '#ef4444', '#059669'],
}

function vizColumns() {
  const pay = defaultMeta('pay', 'numeric')
  const dept = defaultMeta('dept', 'string')
  dept.measure = 'nominal'
  dept.valueLabels = { IT: 'Information Technology' }
  const senior = defaultMeta('senior', 'numeric')
  senior.missing = { values: [999], ranges: [] }
  return [pay, dept, senior]
}

const VIZ_DATA = {
  pay: [10, 12, 11, 13, 9, 14],
  dept: ['IT', 'HR', 'IT', 'Sales', 'HR', 'IT'],
  senior: [1, 0, 1, 999, 0, 1],
}

/** The same columns without the sentinel row, so no group loses a member. */
const VIZ_CLEAN = {
  pay: [10, 12, 11, 13, 9, 14],
  dept: ['IT', 'HR', 'IT', 'Sales', 'HR', 'IT'],
  senior: [1, 0, 1, 1, 0, 1],
}

test('cleanRows drops rows where any needed column is user-missing', () => {
  const cols = vizColumns()
  const rows = cleanRows('pay', 'senior', '', cols, VIZ_DATA)
  assert.equal(rows.x.length, 5, 'the 999 sentinel must drop its row')
  assert.deepEqual(rows.x, [10, 12, 11, 9, 14])
  assert.deepEqual(rows.y, [1, 0, 1, 0, 1])
})

test('buildTraces: histogram never plots a user-missing sentinel', () => {
  const out = buildTraces({
    type: 'histogram',
    x: 'senior',
    y: '',
    group: '',
    trendline: false,
    columns: vizColumns(),
    data: VIZ_DATA,
    showValueLabels: true,
    theme: THEME,
  })
  assert.equal(out.traces.length, 1)
  assert.deepEqual(out.traces[0].x, [1, 0, 1, 0, 1])
  assert.equal(out.yTitle, 'Frequency')
})

test('buildTraces: bar chart aggregates the group mean, not the raw sum', () => {
  const out = buildTraces({
    type: 'bar',
    x: 'dept',
    y: 'pay',
    group: '',
    trendline: false,
    columns: vizColumns(),
    data: VIZ_DATA,
    showValueLabels: true,
    theme: THEME,
  })
  assert.equal(out.traces.length, 1)
  const t = out.traces[0]
  assert.deepEqual(t.x, ['Information Technology (IT)', 'HR', 'Sales'])
  assert.deepEqual(t.y, [11.67, 10.5, 13])
  assert.equal(out.yTitle, 'Mean pay')
})

test('buildTraces: grouping splits the chart into one trace per level', () => {
  const out = buildTraces({
    type: 'scatter',
    x: 'pay',
    y: 'senior',
    group: 'dept',
    trendline: false,
    columns: vizColumns(),
    data: VIZ_CLEAN,
    showValueLabels: true,
    theme: THEME,
  })
  assert.equal(out.traces.length, 3)
  assert.deepEqual(out.traces.map((t) => t.name), ['IT', 'HR', 'Sales'])
  assert.deepEqual(out.traces[0].x, [10, 11, 14])
})

test('buildTraces: the OLS trendline follows the plotted points', () => {
  const out = buildTraces({
    type: 'scatter',
    x: 'pay',
    y: 'senior',
    group: '',
    trendline: true,
    columns: vizColumns(),
    data: VIZ_CLEAN,
    showValueLabels: true,
    theme: THEME,
  })
  assert.equal(out.traces.length, 2)
  const trend = out.traces[1]
  assert.equal(trend.name, 'OLS trend')
  assert.equal(trend.mode, 'lines')
  assert.deepEqual(trend.x, [9, 14])
})

test('buildTraces: a grouped boxplot draws one box per level', () => {
  const out = buildTraces({
    type: 'boxplot',
    x: 'dept',
    y: 'pay',
    group: '',
    trendline: false,
    columns: vizColumns(),
    data: VIZ_DATA,
    showValueLabels: true,
    theme: THEME,
  })
  assert.equal(out.traces.length, 3)
  assert.deepEqual(out.traces.map((t) => t.name), ['IT', 'HR', 'Sales'])
  assert.deepEqual(out.traces[0].y, [10, 11, 14])
  assert.equal(out.traces[0].type, 'box')
})

test('olsTrend fits a straight line and refuses a degenerate one', () => {
  const fit = olsTrend([1, 2, 3], [2, 4, 6])
  assert.ok(fit)
  assert.equal(Math.round(fit.slope * 100) / 100, 2)
  assert.equal(Math.round(fit.intercept * 100) / 100, 0)
  assert.equal(olsTrend([1, 1, 1], [1, 2, 3]), null)
  assert.equal(olsTrend([1], [2]), null)
})

test('captionFor names the chart the way the results card does', () => {
  assert.equal(captionFor({ type: 'histogram', x: 'pay', y: '', group: '' }), 'Histogram of pay')
  assert.equal(captionFor({ type: 'boxplot', x: 'dept', y: 'pay', group: '' }), 'Boxplot of pay by dept')
  assert.equal(
    captionFor({ type: 'bar', x: 'dept', y: 'pay', group: 'senior' }),
    'Mean pay by dept and senior'
  )
})

// --- run store: the companion plot rides the run ---------------------------

test('the run store keeps the companion plot across a re-run and an archive', async () => {
  const { runsState, startRun, markStale, findRun, snapshotRuns, restoreRuns } =
    await import('../src/results.ts')
  runsState.runs.splice(0)
  const chart = { type: 'bar', x: 'dept', y: 'pay' }

  startRun('run1', 'ttest_independent', 'Independent-samples t-test', { dep: 'pay', group: 'dept' }, 'listwise', chart)
  assert.deepEqual(findRun('run1')?.chart, chart)

  // A re-run with the same plot keeps it.
  markStale('run1', { ...chart })
  assert.deepEqual(findRun('run1')?.chart, chart)

  // A re-run without a plot clears the old one.
  markStale('run1', undefined)
  assert.equal(findRun('run1')?.chart, undefined)

  // The archive carries the plot and the missing policy.
  startRun('run2', 'anova_oneway', 'One-way ANOVA', { dep: 'pay', factor: 'dept' }, 'pairwise', chart)
  const snapshot = snapshotRuns()
  runsState.runs.splice(0)
  restoreRuns(snapshot)
  assert.deepEqual(findRun('run2')?.chart, chart)
  assert.equal(findRun('run2')?.missingPolicy, 'pairwise')
  runsState.runs.splice(0)
})

// --- re-run leaves no stale elements behind ---------------------------------

function tablePatch(address, value) {
  return {
    op: 'upsert',
    address,
    element: {
      address,
      status: 'ok',
      kind: 'table',
      caption: address,
      columns: ['Value'],
      rows: [[value]],
      footnotes: [],
    },
  }
}

test('a finished re-run drops the elements the new run did not produce', async () => {
  const { runsState, startRun, markStale, applyNotification, findRun } =
    await import('../src/results.ts')
  runsState.runs.splice(0)
  // The reveal timer needs a window; node has none.
  const prevWindow = globalThis.window
  globalThis.window = { setTimeout: () => 0 }
  try {
    startRun('run1', 'frequencies', 'Frequency tables', { variables: ['a', 'b', 'c'] }, 'listwise')
    const run = findRun('run1')
    for (const n of [1, 2, 3]) {
      run.elements.push({
        address: `run1/table/${n}`,
        status: 'ok',
        kind: 'table',
        caption: `Table ${n}`,
        columns: ['Value'],
        rows: [['old']],
        footnotes: [],
      })
    }
    assert.equal(run.elements.length, 3)

    // The re-run produces one table and no chart.
    markStale('run1')
    applyNotification({
      method: 'analysis/update',
      params: { runId: 'run1', seq: 1, patches: [tablePatch('run1/table/1', 'new')] },
    })
    applyNotification({ method: 'analysis/done', params: { runId: 'run1', status: 'complete' } })

    assert.equal(run.elements.length, 1, 'the two tables the new run did not make must be gone')
    assert.equal(run.elements[0].address, 'run1/table/1')
    assert.deepEqual(run.elements[0].rows, [['new']])
    assert.equal(run.status, 'done')
  } finally {
    if (prevWindow === undefined) delete globalThis.window
    else globalThis.window = prevWindow
    runsState.runs.splice(0)
  }
})

test('a successful re-run clears the error of the previous attempt', async () => {
  const { runsState, startRun, markStale, applyNotification, findRun } =
    await import('../src/results.ts')
  runsState.runs.splice(0)
  const prevWindow = globalThis.window
  globalThis.window = { setTimeout: () => 0 }
  try {
    startRun('run2', 'ttest_independent', 't-test', { dep: 'pay', group: 'senior' }, 'listwise')
    const run = findRun('run2')
    run.elements.push({
      address: 'run2/error/1',
      status: 'error',
      kind: 'error',
      userMessage: 'The statistical test could not be computed from this data.',
    })

    markStale('run2')
    applyNotification({
      method: 'analysis/update',
      params: { runId: 'run2', seq: 1, patches: [tablePatch('run2/table/1', 'ok')] },
    })
    applyNotification({ method: 'analysis/done', params: { runId: 'run2', status: 'complete' } })

    assert.equal(run.elements.length, 1)
    assert.equal(run.elements[0].kind, 'table')
  } finally {
    if (prevWindow === undefined) delete globalThis.window
    else globalThis.window = prevWindow
    runsState.runs.splice(0)
  }
})

test('a failed run keeps its error and the dimmed previous result', async () => {
  const { runsState, startRun, markStale, applyNotification, findRun } =
    await import('../src/results.ts')
  runsState.runs.splice(0)
  const prevWindow = globalThis.window
  globalThis.window = { setTimeout: () => 0 }
  try {
    startRun('run3', 'ttest_independent', 't-test', { dep: 'pay', group: 'senior' }, 'listwise')
    const run = findRun('run3')
    run.elements.push({
      address: 'run3/table/1',
      status: 'ok',
      kind: 'table',
      caption: 'Old result',
      columns: ['Value'],
      rows: [['old']],
      footnotes: [],
    })

    markStale('run3')
    applyNotification({
      method: 'analysis/update',
      params: {
        runId: 'run3',
        seq: 1,
        patches: [
          {
            op: 'upsert',
            address: 'run3/error/1',
            element: {
              address: 'run3/error/1',
              status: 'error',
              kind: 'error',
              userMessage: 'The analysis failed.',
            },
          },
        ],
      },
    })
    applyNotification({ method: 'analysis/done', params: { runId: 'run3', status: 'error' } })

    assert.equal(run.status, 'error')
    assert.ok(run.elements.some((el) => el.kind === 'error'), 'the error must survive')
    assert.ok(run.elements.some((el) => el.status === 'stale'), 'the old result stays dimmed')
  } finally {
    if (prevWindow === undefined) delete globalThis.window
    else globalThis.window = prevWindow
    runsState.runs.splice(0)
  }
})

test('restoring the original options un-dims the settled result', async () => {
  const { runsState, startRun, flagStale, findRun } = await import('../src/results.ts')
  runsState.runs.splice(0)
  const spec = { dep: 'pay', group: 'senior' }
  startRun('run4', 'ttest_independent', 't-test', spec, 'listwise')
  const run = findRun('run4')
  run.status = 'done'
  run.elements.push({
    address: 'run4/table/1',
    status: 'ok',
    kind: 'table',
    caption: 'Test results',
    columns: ['Value'],
    rows: [['ok']],
    footnotes: [],
  })

  // A different option set dims the result.
  flagStale('ttest_independent', { dep: 'pay', group: 'dept' }, 'listwise')
  assert.equal(run.elements[0].status, 'stale')
  assert.equal(run.fresh, false)

  // Undoing the edit matches the settled result again.
  flagStale('ttest_independent', spec, 'listwise')
  assert.equal(run.elements[0].status, 'ok')
  assert.equal(run.fresh, true)
  runsState.runs.splice(0)
})
