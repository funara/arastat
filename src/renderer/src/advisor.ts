// Phase 2 — Engine readiness (one seam call, no new engine method).
// New file `advisor.ts`: `suitableTests()` via `schemaById` + type/measure,
// ONE `window.ara.engine.invoke('diagnose', {data})` seam with
// buildData/referencedColumns null-collapse mirroring runAnalysis.ts,
// per-pattern assumption pre-checks, listwise forecast via
// profileDataset.completeRows + rowsWithMissing, and a read-only
// readiness summary (completeness bar + 3 stat-cards).
// Pure where possible (suitableTests / assumption / forecast math take
// explicit args so node tests can import this); the diagnose seam reads
// the dataset store and fails soft (Tier1 fails soft, never throws).
import { ref } from 'vue'
import { schemaById } from './specs.ts'
import type { AnalysisSchema } from './specs.ts'
import { profileDataset } from './profile.ts'
import { rowsWithMissing } from './missing.ts'
import type { Cell as MissingCell } from './missing.ts'
import { state, isUserMissing } from './store.ts'
import { isRecord } from './guard.ts'
import type { ColumnMeta } from '../../main/io/types.ts'

export type AdvisorPatternId =
  | 'single-scale'
  | 'paired-scale'
  | 'scale-2group'
  | 'scale-multigroup'
  | 'scale-predictors'
  | 'group-group'
  | 'ord-group'

export interface SuitableTestsResult {
  pattern: AdvisorPatternId | 'unknown'
  testIds: string[]
  tests: AnalysisSchema[]
  /** Suggested diagnose inputs for the ONE diagnose seam (null = no diagnose call). */
  group: string | null
  values: string[]
  needsDiagnose: boolean
  /** One-sentence assumption pre-check for this pattern. */
  note: string
}

// Exact 7-pattern mapping (ids must match registry/specs; engine rejects
// unknown keys 1001). Accessed only through schemaById below.
export const ADVISOR_TESTS: Record<AdvisorPatternId, string[]> = {
  'single-scale': ['descriptives', 'ttest_onesample', 'wilcoxon_one_sample'],
  'paired-scale': ['ttest_paired', 'wilcoxon_signedrank', 'correlation'],
  'scale-2group': ['ttest_independent', 'mannwhitney_u'],
  'scale-multigroup': ['anova_oneway', 'welch_anova', 'kruskal_wallis'],
  'scale-predictors': ['linear_regression', 'correlation', 'kendall_tau'],
  'group-group': ['chisq_independence', 'chisq_gof', 'frequencies'],
  'ord-group': ['mannwhitney_u', 'kruskal_wallis', 'descriptives']
}

export const ADVISOR_NOTES: Record<AdvisorPatternId, string> = {
  'single-scale': 'Examines the distribution and central tendency of a continuous metric. Tests whether the population mean differs from a hypothesized standard value using One-Sample t-test or non-parametric Wilcoxon.',
  'paired-scale': 'Compares two repeated continuous measurements on the same subjects (e.g. pre/post scores) or assesses linear correlation between two continuous columns.',
  'scale-2group': 'Compares a continuous metric across two independent groups (e.g. treated vs control). Assesses normality and variance equality to guide between Independent t-test and Mann-Whitney U.',
  'scale-multigroup': 'Compares continuous outcomes across 3 or more independent groups (One-Way ANOVA). Employs Welch ANOVA if group variances are unequal, followed by Tukey HSD post-hoc pairwise tests.',
  'scale-predictors': 'Models how a continuous outcome is explained by one or more predictor columns using Multiple Linear Regression, evaluating model fit (R²), coefficients, and residual assumptions.',
  'group-group': 'Evaluates contingency tables and independence between two categorical factors using Pearson Chi-Square test or Fisher Exact test for sparse frequency counts.',
  'ord-group': 'Compares ordinal rating scales or ranks across independent groups using non-parametric rank sums (Mann-Whitney U or Kruskal-Wallis).'
}

export const ADVISOR_TITLES: Record<AdvisorPatternId, string> = {
  'single-scale': 'Single Continuous Metric',
  'paired-scale': 'Paired / Repeated Measurements',
  'scale-2group': 'Two-Group Comparison (Independent Samples)',
  'scale-multigroup': 'Multi-Group Comparison (One-Way ANOVA)',
  'scale-predictors': 'Multiple Linear Regression',
  'group-group': 'Categorical Association (Cross-Tabulation)',
  'ord-group': 'Ordinal / Ranked Groups'
}

/** Finds sensible default variables to evaluate, skipping ID columns and pairing continuous outcomes with grouping factors. */
export function findSensibleDefaultTestVars(cols: ColumnMeta[]): string[] {
  if (!cols.length) return []
  const isLikelyId = (c: ColumnMeta): boolean => {
    const n = c.name.toLowerCase()
    return n === 'id' || n.endsWith('_id') || n.startsWith('id_') || n === 'emp_name' || n === 'name' || n === 'uuid' || n === 'record'
  }
  const pool = cols.filter((c) => !isLikelyId(c))
  const candidates = pool.length >= 2 ? pool : cols

  // Preferred: continuous outcome + categorical group factor
  const scale = candidates.find((c) => c.type === 'numeric' && (c.measure === 'scale' || c.measure === 'ratio'))
  const group = candidates.find((c) => c !== scale && (c.measure === 'nominal' || c.measure === 'ordinal'))
  if (scale && group) return [scale.name, group.name]

  // Alternative: two continuous scales
  const scales = candidates.filter((c) => c.type === 'numeric' && (c.measure === 'scale' || c.measure === 'ratio'))
  if (scales.length >= 2) return [scales[0].name, scales[1].name]

  // Alternative: two group variables
  const groups = candidates.filter((c) => c.measure === 'nominal' || c.measure === 'ordinal')
  if (groups.length >= 2) return [groups[0].name, groups[1].name]

  return candidates.slice(0, 2).map((c) => c.name)
}

const isScale = (c: ColumnMeta): boolean =>
  c.type === 'numeric' && (c.measure === 'scale' || c.measure === 'ratio')
const isOrdinal = (c: ColumnMeta): boolean => c.measure === 'ordinal'
const isGroup = (c: ColumnMeta): boolean =>
  c.measure === 'nominal' || c.measure === 'ordinal'

/**
 * Pattern detection from type/measure (+ optional group level count).
 * scale-2group vs scale-multigroup splits on `groupLevels` (or the group
 * column valueLabels when available); unknown levels default to 2-group
 * with a note pointing at the ANOVA path. Pure.
 */
export function suitableTests(
  cols: ColumnMeta[],
  opts: { groupLevels?: number } = {}
): SuitableTestsResult {
  const idsOf = (pattern: AdvisorPatternId): { testIds: string[]; tests: AnalysisSchema[] } => {
    const testIds = ADVISOR_TESTS[pattern]
    const tests: AnalysisSchema[] = []
    for (const id of testIds) {
      const s = schemaById(id)
      if (s) tests.push(s)
    }
    return { testIds: [...testIds], tests }
  }
  const finish = (
    pattern: AdvisorPatternId | 'unknown',
    group: string | null,
    values: string[]
  ): SuitableTestsResult => {
    if (pattern === 'unknown') {
      return { pattern, testIds: [], tests: [], group, values, needsDiagnose: false, note: '' }
    }
    const { testIds, tests } = idsOf(pattern)
    return {
      pattern, testIds, tests, group, values,
      needsDiagnose: pattern !== 'group-group',
      note: ADVISOR_NOTES[pattern]
    }
  }
  if (cols.length === 0) return finish('unknown', null, [])
  if (cols.length === 1) {
    const c = cols[0] as ColumnMeta
    if (isScale(c)) return finish('single-scale', null, [c.name])
    return finish('group-group', null, [c.name])
  }
  if (cols.length === 2) {
    const [a, b] = cols as [ColumnMeta, ColumnMeta]
    if (isScale(a) && isScale(b)) return finish('paired-scale', null, [a.name, b.name])
    // ORD + GROUP before generic GROUP x GROUP (ordinal dep + nominal group).
    const ordGroup =
      (isOrdinal(a) && b.measure === 'nominal') || (isOrdinal(b) && a.measure === 'nominal')
    if (ordGroup) {
      const dep = isOrdinal(a) ? a : b
      const grp = dep === a ? b : a
      return finish('ord-group', grp.name, [dep.name])
    }
    if (isScale(a) && isGroup(b)) return finish(scaleGroupPattern(b, opts.groupLevels), b.name, [a.name])
    if (isScale(b) && isGroup(a)) return finish(scaleGroupPattern(a, opts.groupLevels), a.name, [b.name])
    if (isGroup(a) && isGroup(b)) return finish('group-group', null, [a.name, b.name])
    // Fallback: scale + ordinal predictor treated as a 2-group split.
    if (isScale(a) || isScale(b)) {
      const grp = isScale(a) ? b : a
      const dep = isScale(a) ? a : b
      return finish(scaleGroupPattern(grp, opts.groupLevels), grp.name, [dep.name])
    }
    return finish('unknown', null, cols.map((c) => c.name))
  }
  // 3+ columns: scale dep + predictors (regression path) when the first
  // column is scale; otherwise unknown.
  const dep = cols[0] as ColumnMeta
  if (isScale(dep)) return finish('scale-predictors', null, cols.map((c) => c.name))
  return finish('unknown', null, cols.map((c) => c.name))
}

function scaleGroupPattern(group: ColumnMeta, hint?: number): AdvisorPatternId {
  const labels = group.valueLabels ? Object.keys(group.valueLabels).length : 0
  const levels = hint ?? (labels >= 2 ? labels : 2)
  return levels >= 3 ? 'scale-multigroup' : 'scale-2group'
}

// --- diagnose seam (ONE invoke site; engine read-only) ----------------------

export interface DiagnoseNormality { n: number; stat: number | null; p: number | null }
export interface DiagnoseReport {
  missing: {
    rows: number
    columns: number
    cells: number
    missingCells: number
    missingPct: number
    completeRows: number
    completePct: number
    perColumn: Array<{ name: string; missing: number; pct: number }>
    recommendation: string
    reason: string
  } | null
  normality: Record<string, DiagnoseNormality | null>
  homogeneity: { value: string; group: string; levels: string[]; stat: number | null; p: number | null } | null
  serial: Record<string, { n: number; durbinWatson: number | null; ljungBoxLag?: number; ljungBoxP?: number | null } | null>
  regression: { y: string; x: string[]; n: number; bpP: number | null; durbinWatson: number | null; jbP: number | null } | null
}

/** Deduped variable names (mirrors runAnalysis.ts referencedColumns). */
function referencedColumns(names: string[]): string[] {
  const out: string[] = []
  for (const n of names) {
    if (typeof n === 'string' && n && !out.includes(n)) out.push(n)
  }
  return out
}

/** Columnar payload: user-missing and empty cells collapse to one null (§6). */
function buildData(names: string[]): Record<string, Array<number | string | null>> {
  const data: Record<string, Array<number | string | null>> = {}
  for (const name of referencedColumns(names)) {
    const meta = state.ds.columns.find((c) => c.name === name)
    const raw = (state.ds.data[name] ?? []) as Array<number | string | null>
    data[name] = raw.map((v) =>
      meta && isUserMissing(meta, v as number | string | null) ? null : v
    )
  }
  return data
}

const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

function parseDiagnose(raw: unknown): DiagnoseReport | null {
  if (!isRecord(raw)) return null
  const missing = isRecord(raw['missing'])
    ? {
        rows: typeof raw['missing']['rows'] === 'number' ? (raw['missing']['rows'] as number) : 0,
        columns: typeof raw['missing']['columns'] === 'number' ? (raw['missing']['columns'] as number) : 0,
        cells: typeof raw['missing']['cells'] === 'number' ? (raw['missing']['cells'] as number) : 0,
        missingCells: typeof raw['missing']['missingCells'] === 'number' ? (raw['missing']['missingCells'] as number) : 0,
        missingPct: typeof raw['missing']['missingPct'] === 'number' ? (raw['missing']['missingPct'] as number) : 0,
        completeRows: typeof raw['missing']['completeRows'] === 'number' ? (raw['missing']['completeRows'] as number) : 0,
        completePct: typeof raw['missing']['completePct'] === 'number' ? (raw['missing']['completePct'] as number) : 0,
        perColumn: Array.isArray(raw['missing']['perColumn'])
          ? (raw['missing']['perColumn'] as unknown[]).filter(isRecord).map((p) => ({
              name: typeof p['name'] === 'string' ? (p['name'] as string) : '',
              missing: typeof p['missing'] === 'number' ? (p['missing'] as number) : 0,
              pct: typeof p['pct'] === 'number' ? (p['pct'] as number) : 0
            }))
          : [],
        recommendation: typeof raw['missing']['recommendation'] === 'string' ? (raw['missing']['recommendation'] as string) : '',
        reason: typeof raw['missing']['reason'] === 'string' ? (raw['missing']['reason'] as string) : ''
      }
    : null
  const normality: DiagnoseReport['normality'] = {}
  if (isRecord(raw['normality'])) {
    for (const [k, v] of Object.entries(raw['normality'])) {
      if (!isRecord(v)) { normality[k] = null; continue }
      normality[k] = {
        n: typeof v['n'] === 'number' ? (v['n'] as number) : 0,
        stat: numOrNull(v['stat']),
        p: numOrNull(v['p'])
      }
    }
  }
  let homogeneity: DiagnoseReport['homogeneity'] = null
  if (isRecord(raw['homogeneity'])) {
    const h = raw['homogeneity']
    homogeneity = {
      value: typeof h['value'] === 'string' ? (h['value'] as string) : '',
      group: typeof h['group'] === 'string' ? (h['group'] as string) : '',
      levels: Array.isArray(h['levels']) ? (h['levels'] as unknown[]).map(String) : [],
      stat: numOrNull(h['stat']),
      p: numOrNull(h['p'])
    }
  }
  const serial: DiagnoseReport['serial'] = {}
  if (isRecord(raw['serial'])) {
    for (const [k, v] of Object.entries(raw['serial'])) {
      if (v === null || v === undefined) { serial[k] = null; continue }
      if (!isRecord(v)) { serial[k] = null; continue }
      serial[k] = {
        n: typeof v['n'] === 'number' ? (v['n'] as number) : 0,
        durbinWatson: numOrNull(v['durbinWatson']),
        ...(typeof v['ljungBoxLag'] === 'number' ? { ljungBoxLag: v['ljungBoxLag'] as number } : {}),
        ...('ljungBoxP' in v ? { ljungBoxP: numOrNull(v['ljungBoxP']) } : {})
      }
    }
  }
  let regression: DiagnoseReport['regression'] = null
  if (isRecord(raw['regression'])) {
    const r = raw['regression']
    regression = {
      y: typeof r['y'] === 'string' ? (r['y'] as string) : '',
      x: Array.isArray(r['x']) ? (r['x'] as unknown[]).map(String) : [],
      n: typeof r['n'] === 'number' ? (r['n'] as number) : 0,
      bpP: numOrNull(r['bpP']),
      durbinWatson: numOrNull(r['durbinWatson']),
      jbP: numOrNull(r['jbP'])
    }
  }
  return { missing, normality, homogeneity, serial, regression }
}

export interface DiagnoseOptions {
  group?: string
  pattern?: AdvisorPatternId | 'unknown'
}

/**
 * Single diagnose seam: fails soft (null) when the engine is unreachable.
 * GROUP x GROUP never calls: returns { report: null, advice } with the
 * level/Fisher pre-check instead.
 */
export async function diagnoseColumns(
  names: string[],
  opts: DiagnoseOptions = {}
): Promise<{ report: DiagnoseReport | null; advice: string }> {
  const pattern = opts.pattern ?? 'single-scale'
  if (pattern === 'group-group') {
    return {
      report: null,
      advice: 'Categorical association needs no diagnose call: check ≥2 levels each; 2x2 small-n → Fisher exact.'
    }
  }
  const all = opts.group ? [...names, opts.group] : names
  const data = buildData(all)
  if (!Object.keys(data).length) return { report: null, advice: 'No columns to check.' }
  try {
    if (typeof window === 'undefined' || !window.ara?.engine?.invoke) {
      return { report: null, advice: 'Engine unavailable: assumption checks skipped.' }
    }
    const plain = JSON.parse(JSON.stringify({ data, group: opts.group ?? null, values: referencedColumns(names) })) as {
      data: Record<string, Array<number | string | null>>
      group: string | null
      values: string[]
    }
    const raw = await window.ara.engine.invoke('diagnose', {
      data: plain.data,
      ...(plain.group ? { group: plain.group } : {}),
      values: plain.values
    })
    const report = parseDiagnose(raw)
    return { report, advice: assumptionNote(pattern, report, referencedColumns(names)) }
  } catch {
    return { report: null, advice: 'Data check failed: assumption checks skipped.' }
  }
}

// --- per-pattern assumption pre-checks (pure; Shapiro null when n<3) --------

export function shapiroP(report: DiagnoseReport | null, col: string): number | null {
  const e = report?.normality?.[col]
  return e && typeof e.p === 'number' ? e.p : null
}

export function leveneP(report: DiagnoseReport | null): number | null {
  const p = report?.homogeneity?.p
  return typeof p === 'number' ? p : null
}

export function minShapiroP(report: DiagnoseReport | null, cols: string[]): number | null {
  let best: number | null = null
  for (const c of cols) {
    const p = shapiroP(report, c)
    if (p === null) continue
    if (best === null || p < best) best = p
  }
  return best
}

const fmtP = (p: number | null): string => (p === null ? 'n/a' : `p=${p.toFixed(3)}`)

/** One-sentence advisory per pattern from a diagnose report. Pure. */
export function assumptionNote(
  pattern: AdvisorPatternId | 'unknown',
  report: DiagnoseReport | null,
  cols: string[] = []
): string {
  if (pattern === 'unknown') return 'Choose variables to see the assumption check.'
  if (!report) return 'Assumption check unavailable: Shapiro null when n<3 → never blocks.'
  switch (pattern) {
    case 'single-scale': {
      const p = cols.length ? shapiroP(report, cols[0] as string) : null
      if (p === null) return 'Shapiro unavailable (n<3): descriptives are safe; treat t-test as provisional.'
      return p < 0.05
        ? `Non-normal (Shapiro ${fmtP(p)}): prefer Wilcoxon one-sample over the t-test.`
        : `Approximately normal (Shapiro ${fmtP(p)}): parametric t-test ok.`
    }
    case 'paired-scale': {
      const p = minShapiroP(report, cols)
      if (p === null) return 'Shapiro unavailable (n<3): paired t-test is provisional; BP/JB do not apply (y/x arbitrary).'
      return p < 0.05
        ? `Non-normal differences (min Shapiro ${fmtP(p)}): prefer Wilcoxon signed-rank; never quote BP/JB here.`
        : `Differences look normal (min Shapiro ${fmtP(p)}): paired t-test ok; BP/JB do not apply.`
    }
    case 'scale-2group': {
      const lv = leveneP(report)
      const sp = minShapiroP(report, cols)
      if (lv !== null && lv < 0.05) {
        return `Unequal variances (Levene ${fmtP(lv)}): read the Welch row (engine returns both); Shapiro min ${fmtP(sp)}.`
      }
      if (sp !== null && sp < 0.05) {
        return `Non-normal (Shapiro min ${fmtP(sp)}): prefer Mann-Whitney U; Levene ${fmtP(lv)}.`
      }
      return `Assumptions look ok (Shapiro min ${fmtP(sp)}, Levene ${fmtP(lv)}): t-test ok, Welch row available.`
    }
    case 'scale-multigroup': {
      const lv = leveneP(report)
      const sp = minShapiroP(report, cols)
      if (sp !== null && sp < 0.05) return `Non-normal (Shapiro min ${fmtP(sp)}): prefer Kruskal-Wallis; Tukey only post-omnibus.`
      if (lv !== null && lv < 0.05) return `Unequal variances (Levene ${fmtP(lv)}): prefer Welch ANOVA; Tukey only post-omnibus.`
      return `Assumptions look ok (Shapiro min ${fmtP(sp)}, Levene ${fmtP(lv)}): ANOVA ok; Tukey only post-omnibus.`
    }
    case 'scale-predictors': {
      const bp = report.regression?.bpP ?? null
      const jb = report.regression?.jbP ?? null
      const dw = report.regression?.durbinWatson ?? null
      if (bp === null && jb === null) return 'Regression checks unavailable (need 2+ numerics, n≥k+2): correlation is the safe fallback.'
      const bits: string[] = []
      if (bp !== null) bits.push(bp < 0.05 ? `heteroskedastic (BP ${fmtP(bp)})` : `homoskedastic (BP ${fmtP(bp)})`)
      if (jb !== null) bits.push(jb < 0.05 ? `non-normal residuals (JB ${fmtP(jb)})` : `residuals look normal (JB ${fmtP(jb)})`)
      if (dw !== null) bits.push(`DW=${dw.toFixed(2)}`)
      return `Regression diagnostics (only here): ${bits.join('; ')}.`
    }
    case 'group-group':
      return 'No diagnose call: check ≥2 levels each; 2x2 small-n → Fisher exact.'
    case 'ord-group': {
      const sp = minShapiroP(report, cols)
      const lv = leveneP(report)
      if (sp !== null && sp >= 0.05) return `Advisory only (Shapiro ${fmtP(sp)}, Levene ${fmtP(lv)}): p≥.05 + scale → parametric ok, else stay non-parametric.`
      return `Advisory only (Shapiro min ${fmtP(sp)}, Levene ${fmtP(lv)}): prefer Mann-Whitney/Kruskal.`
    }
  }
}

// --- listwise forecast (profileDataset.completeRows + rowsWithMissing) -------

export interface ListwiseForecast {
  rows: number
  complete: number
  dropped: number
  droppedPct: number
  missingRows: number[]
  /** Mirrors missing_report thresholds: ok / listwise / fill. */
  policy: 'ok' | 'listwise' | 'fill'
  reason: string
  /** statslib.py guards: n≥2 per group, exactly-2-groups, 1003/1004. */
  guard: string | null
}

const cellIsMissing = (col: string, v: MissingCell, byName: Map<string, ColumnMeta>): boolean => {
  const meta = byName.get(col)
  if (!meta) return v === null || v === ''
  return isUserMissing(meta, v as number | string | null)
};

/**
 * Listwise forecast `(rows-complete)/rows`. Policy mirrors
 * missing_report: 0 → ok, complete==0 → fill (listwise-emptied), ≥95%
 * complete → listwise, worst col >40% → fill/drop. Guards mirror
 * statslib.py (n≥2, exactly-2-groups) and pipeline codes (1003 invalid
 * data, 1004 numeric failure → all-missing column).
 */
export function listwiseForecast(
  columnNames?: string[],
  opts: { group?: string; groupLevels?: string[] } = {}
): ListwiseForecast {
  const cols = columnNames ?? state.ds.columns.map((c) => c.name)
  const names = referencedColumns(cols)
  const byName = new Map(state.ds.columns.map((c) => [c.name, c]))
  const data: Record<string, MissingCell[]> = {}
  for (const n of names) data[n] = ((state.ds.data[n] ?? []) as MissingCell[])
  const isMissing = (col: string, v: MissingCell): boolean => cellIsMissing(col, v, byName)
  const profile = profileDataset(
    names.map((n) => ({ name: n, type: byName.get(n)?.type ?? 'numeric' })),
    data,
    isMissing
  )
  const missingRows = rowsWithMissing(data, names, isMissing)
  const rows = profile.rows
  const complete = profile.completeRows
  const dropped = rows - complete
  const droppedPct = rows ? (dropped / rows) * 100 : 0
  // Worst-column missing % (missing_report threshold: worst col >40% → fill).
  let worst = { name: '', pct: 0 }
  for (const p of profile.profiles) {
    const pct = p.n ? (p.missing / p.n) * 100 : 0
    if (pct > worst.pct) worst = { name: p.name, pct }
  }
  const missingCells = profile.profiles.reduce((a, p) => a + p.missing, 0)
  let policy: ListwiseForecast['policy'] = 'fill'
  let reason = ''
  if (rows === 0) {
    reason = 'No rows to forecast (1003: empty data).'
  } else if (missingCells === 0) {
    policy = 'ok'
    reason = 'No missing values. Listwise and pairwise handling keep the same rows.'
  } else if (complete === 0) {
    policy = 'fill'
    reason = 'No complete rows remain, so listwise handling empties the data. Fill or drop before running.'
  } else if (complete / rows >= 0.95) {
    policy = 'listwise'
    reason = `${complete} of ${rows} rows are complete. Listwise handling loses little.`
  } else if (worst.pct > 40) {
    policy = 'fill'
    reason = `Column “${worst.name}” is ${worst.pct.toFixed(0)}% missing. Fill it or drop its rows before running.`
  } else {
    policy = 'fill'
    reason = `Only ${complete} of ${rows} rows are complete. Fill missing values or drop incomplete rows.`
  }
  // Guards mirror statslib.py: n≥2 per group, exactly two groups, 1003/1004.
  let guard: string | null = null
  const allMissing = profile.profiles.filter((p) => rows > 0 && p.missing >= rows).map((p) => p.name)
  if (allMissing.length) {
    guard = `1004: Variable “${allMissing[0]}” has no non-missing values. Choose a variable with data.`
  } else if (rows < 2) {
    guard = '1004: n≥2 rows are needed; add more rows to every group.'
  } else if (opts.group && opts.groupLevels) {
    const k = opts.groupLevels.length
    if (k < 2) guard = `1004: Grouping variable “${opts.group}” has 1 defined group. Define at least two groups.`
    else if (k > 2) {
      guard =
        `1004: Grouping variable “${opts.group}” has ${k} groups. This test compares exactly two: ` +
        'choose a two-group column, or run One-way ANOVA for three or more.'
    }
  }
  return { rows, complete, dropped, droppedPct, missingRows, policy, reason, guard }
}

// --- readiness (completeness bar + 3 stat-cards, read-only) ------------------

export interface ReadinessSummary {
  rows: number
  completeRows: number
  completePct: number
  ready: number
  attention: number
  highRisk: number
  perColumn: Array<{ name: string; missingPct: number; band: 'ready' | 'attention' | 'high-risk' }>
}

/** Read-only hub Readiness tab model: no writes, aggregates only. */
export function readinessSummary(columnNames?: string[]): ReadinessSummary {
  const cols = columnNames ?? state.ds.columns.map((c) => c.name)
  const names = referencedColumns(cols)
  const byName = new Map(state.ds.columns.map((c) => [c.name, c]))
  const data: Record<string, MissingCell[]> = {}
  for (const n of names) data[n] = ((state.ds.data[n] ?? []) as MissingCell[])
  const isMissing = (col: string, v: MissingCell): boolean => cellIsMissing(col, v, byName)
  const profile = profileDataset(
    names.map((n) => ({ name: n, type: byName.get(n)?.type ?? 'numeric' })),
    data,
    isMissing
  )
  let ready = 0
  let attention = 0
  let highRisk = 0
  const perColumn = profile.profiles.map((p) => {
    const missingPct = p.n ? Math.round((p.missing / p.n) * 100) : 0
    // Bands mirror the badge gates: >40% missing (or empty) is high-risk.
    const band: 'ready' | 'attention' | 'high-risk' =
      missingPct === 0 ? 'ready' : missingPct > 40 ? 'high-risk' : 'attention'
    if (band === 'ready') ready++
    else if (band === 'attention') attention++
    else highRisk++
    return { name: p.name, missingPct, band }
  })
  const rows = profile.rows
  const completeRows = profile.completeRows
  return {
    rows,
    completeRows,
    completePct: rows ? (completeRows / rows) * 100 : 0,
    ready,
    attention,
    highRisk,
    perColumn
  }
}

// --- AI-first recommendation (Data Health + Advisor modal) ------------------
// Single entry point: primary + 2 secondary actions. Aggregate-only prompt
// (missing %, kinds, counts) so raw cells never leave the device. 30s
// timeout, never throws: failures resolve to rule-based recs ({ source:
// 'fallback' }) so the modal renders first and fills in after.
export interface HealthSummaryInput {
  score: number | null
  rows: number
  columns: number
  missingPct: number
  topIssues: Array<{ kind: string; col: string }>
}

export interface AiActionRec {
  title: string
  detail: string
  target: 'missing' | 'readiness' | 'tests'
  /** One-sentence why (rank basis). Optional for backward compat. */
  reason?: string
  /** Model self-rated confidence. */
  confidence?: 'high' | 'medium' | 'low'
  /** Column refs (names only, never cell values). */
  cols?: string[]
}

export interface AiRecommendationResult {
  primary: AiActionRec
  secondary: [AiActionRec, AiActionRec]
  source: 'ai' | 'fallback'
  error?: string
}

const AI_REC_TIMEOUT_MS = 30000

/** Rule-based fallback: complete -> valid -> dedupe, capped at 3 actions. */
export function ruleBasedRecs(input: HealthSummaryInput): { primary: AiActionRec; secondary: [AiActionRec, AiActionRec] } {
  const recs: AiActionRec[] = []
  if (input.missingPct > 0) {
    recs.push({
      title: input.missingPct > 40 ? 'Drop incomplete rows' : 'Fill missing cells',
      detail: `${input.missingPct}% of cells are missing across ${input.columns} columns.`,
      target: 'missing',
      reason: 'Missing cells are dropped from multi-column models, so filling or dropping restores usable rows.',
      confidence: 'high' as const
    })
  }
  const kinds = new Set(input.topIssues.map((i) => i.kind))
  if (kinds.has('typeMismatch') || kinds.has('measureMismatch') || kinds.has('sentinel') || kinds.has('unlabeledCodes')) {
    recs.push({ title: 'Repair flagged columns', detail: 'Type, scale, sentinel, or label issues need review.', target: 'readiness', reason: 'Wrong types and sentinel codes distort means and spreads.', confidence: 'high' as const })
  }
  if (kinds.has('duplicates') || kinds.has('constant') || kinds.has('empty') || kinds.has('dirtyCategories')) {
    recs.push({ title: 'Remove redundant columns', detail: 'Duplicate, constant, or empty columns add noise.', target: 'readiness', reason: 'Dead columns add noise without new information.', confidence: 'medium' as const })
  }
  if (kinds.has('outliers') || kinds.has('idLike')) {
    recs.push({ title: 'Inspect flagged distributions', detail: 'Outliers or id-like columns skew summaries.', target: 'readiness', reason: 'Extreme or id-like values pull averages off centre.', confidence: 'medium' as const })
  }
  recs.push({ title: 'Choose a statistical test', detail: 'Match columns to a test once data is clean.', target: 'tests', reason: 'Clean columns map to one or two suitable tests.', confidence: 'low' as const })
  const seen: Record<string, true> = {}
  const uniq = recs.filter((r) => (seen[r.title] ? false : (seen[r.title] = true))).slice(0, 3)
  while (uniq.length < 3) uniq.push({ title: 'Choose a statistical test', detail: 'Match columns to a test once data is clean.', target: 'tests', confidence: 'low' as const })
  return { primary: uniq[0]!, secondary: [uniq[1]!, uniq[2]!] }
}

export interface EdaHypothesis {
  title: string
  subtitle: string
  testId: string
  options: Record<string, unknown>
  badge: string
}

export function generateDatasetEdaHypotheses(cols: ColumnMeta[]): EdaHypothesis[] {
  const hypotheses: EdaHypothesis[] = []
  if (!cols.length) return hypotheses

  const isLikelyId = (c: ColumnMeta): boolean => {
    const n = c.name.toLowerCase()
    return n === 'id' || n.endsWith('_id') || n.startsWith('id_') || n === 'name' || n === 'uuid' || n === 'ticket'
  }
  const cleanCols = cols.filter((c) => !isLikelyId(c))

  const scales = cleanCols.filter((c) => c.type === 'numeric' && (c.measure === 'scale' || c.measure === 'ratio'))
  const groups = cleanCols.filter((c) => c.measure === 'nominal' || c.measure === 'ordinal')
  const binaryCols = cleanCols.filter((c) => {
    const n = c.name.toLowerCase()
    return n === 'survived' || n.includes('status') || n.includes('success') || n.includes('outcome') || (c.valueLabels && Object.keys(c.valueLabels).length === 2)
  })

  // 1. Primary categorical outcome vs group (e.g. Survived by Sex, Survived by Pclass)
  const targetBinary = binaryCols[0] || groups.find((c) => ['survived', 'outcome', 'target', 'group'].includes(c.name.toLowerCase()))
  if (targetBinary) {
    const otherGroups = groups.filter((g) => g.name !== targetBinary.name)
    for (const g of otherGroups.slice(0, 2)) {
      hypotheses.push({
        title: `${targetBinary.name} by ${g.name}`,
        subtitle: `Cross-tabulation & Chi-Square test of independence between ${targetBinary.name} and ${g.name}.`,
        testId: 'chisq_independence',
        options: { row: g.name, col: targetBinary.name },
        badge: 'Categorical'
      })
    }
  } else if (groups.length >= 2) {
    hypotheses.push({
      title: `${groups[0].name} vs ${groups[1].name}`,
      subtitle: `Contingency table & Chi-Square independence test.`,
      testId: 'chisq_independence',
      options: { row: groups[0].name, col: groups[1].name },
      badge: 'Categorical'
    })
  }

  // 2. Continuous outcome by 2 groups (e.g. Age by Survived)
  const twoLevelGroup = groups.find((g) => {
    const n = g.name.toLowerCase()
    return n === 'sex' || n === 'gender' || n === 'survived' || (g.valueLabels && Object.keys(g.valueLabels).length === 2)
  }) || (groups.length ? groups[0] : null)

  if (scales.length && twoLevelGroup) {
    const primaryScale = scales.find((s) => ['age', 'score', 'fare', 'salary'].includes(s.name.toLowerCase())) || scales[0]
    hypotheses.push({
      title: `${primaryScale.name} by ${twoLevelGroup.name}`,
      subtitle: `Compare mean ${primaryScale.name} across ${twoLevelGroup.name} groups (Independent Samples t-test).`,
      testId: 'ttest_independent',
      options: { dep: primaryScale.name, group: twoLevelGroup.name },
      badge: 'Group Comparison'
    })
  }

  // 3. Continuous outcome by multi-group (e.g. Fare by Pclass)
  const multiGroup = groups.find((g) => {
    const n = g.name.toLowerCase()
    return n === 'pclass' || n === 'class' || n === 'dept' || n === 'department' || (g.valueLabels && Object.keys(g.valueLabels).length >= 3)
  }) || (groups.length > 1 ? groups[1] : null)

  if (scales.length && multiGroup && multiGroup.name !== twoLevelGroup?.name) {
    const altScale = scales.find((s) => ['fare', 'income', 'rating'].includes(s.name.toLowerCase())) || scales[scales.length - 1]
    hypotheses.push({
      title: `${altScale.name} across ${multiGroup.name}`,
      subtitle: `Test mean differences across 3+ levels of ${multiGroup.name} (One-Way ANOVA & Welch).`,
      testId: 'anova_oneway',
      options: { dep: altScale.name, factor: multiGroup.name },
      badge: 'ANOVA'
    })
  }

  // 4. Continuous variables overview (e.g. Descriptives for Age, Fare)
  if (scales.length >= 1) {
    const metricNames = scales.slice(0, 3).map((s) => s.name)
    hypotheses.push({
      title: `Summary Descriptives (${metricNames.join(', ')})`,
      subtitle: `Mean, standard deviation, skewness, and quartile spread for continuous metrics.`,
      testId: 'descriptives',
      options: { variables: metricNames },
      badge: 'Descriptives'
    })
  }

  return hypotheses.slice(0, 4)
}

/** Safe JSON extraction from arbitrary LLM responses (handles preamble, codeblocks, trailing chatter). */
export function extractJson(text: string): unknown {
  if (!text || typeof text !== 'string') return null
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1))
      } catch {
        // failed substring parse
      }
    }
    const arrStart = text.indexOf('[')
    const arrEnd = text.lastIndexOf(']')
    if (arrStart >= 0 && arrEnd > arrStart) {
      try {
        return JSON.parse(text.slice(arrStart, arrEnd + 1))
      } catch {
        // failed array substring parse
      }
    }
  }
  return null
}

// Session-level persistent AI recommendation cache across dialog open/close
export const cachedAiRec = ref<AiRecommendationResult | null>(null)

export function resetAiAdvisorCache(): void {
  cachedAiRec.value = null
}

/**
 * AI recommendation: prompt carries aggregates only, with a 30s cap.
 * The caller invokes this only after an explicit user action.
 */
export async function getAiRecommendation(input: HealthSummaryInput): Promise<AiRecommendationResult> {
  const fallback = (): AiRecommendationResult => ({ ...ruleBasedRecs(input), source: 'fallback' })
  try {
    if (typeof window === 'undefined' || !window.ara?.ai?.chat) return fallback()
    const kinds = input.topIssues.slice(0, 3).map((i) => `${i.kind} on ${i.col}`).join('; ') || 'none'
    const cols = [...new Set(input.topIssues.map((i) => i.col))].slice(0, 6).join(', ') || 'none'
    const prompt =
      `Dataset health audit: score ${input.score ?? 'unknown'}/100, ${input.rows} rows x ${input.columns} columns, ${input.missingPct}% missing cells. ` +
      `Quality notices: ${kinds}. Columns: ${cols}. ` +
      `Provide 3 prioritized statistical actions (measurement level corrections, imputation strategy, distribution skew, or model suitability). Focus on statistical reliability and analysis validity. ` +
      `Reply ONLY JSON: {"actions":[{"title":"...","detail":"...","target":"missing|readiness|tests","reason":"one sentence statistical rationale","confidence":"high|medium|low","cols":["col names only"]}]}`
    const raw = await Promise.race([
      window.ara.ai.chat([
        { role: 'system', content: 'You are ARA Statistical Advisor in ARAStat. Provide reliable, professional statistical interpretations and preparations. Reply valid JSON only.' },
        { role: 'user', content: prompt }
      ]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), AI_REC_TIMEOUT_MS))
    ])
    const parsed: unknown = extractJson(String(raw))
    const list: unknown =
      typeof parsed === 'object' && parsed !== null && 'actions' in parsed
        ? (parsed as Record<string, unknown>).actions
        : undefined
    if (!Array.isArray(list) || list.length < 1) return fallback()
    const ok = (t: unknown): t is AiActionRec['target'] => t === 'missing' || t === 'readiness' || t === 'tests'
    const norm: AiActionRec[] = []
    const okConf = (c: unknown): c is 'high' | 'medium' | 'low' => c === 'high' || c === 'medium' || c === 'low'
    for (const entry of list.slice(0, 3)) {
      if (typeof entry !== 'object' || entry === null) continue
      if (!('title' in entry) || typeof entry.title !== 'string' || !entry.title.trim()) continue
      const detail = 'detail' in entry && typeof entry.detail === 'string' ? entry.detail.slice(0, 160) : ''
      const target = 'target' in entry && ok(entry.target) ? entry.target : 'readiness'
      const rec: AiActionRec = { title: entry.title.slice(0, 80), detail, target }
      if ('reason' in entry && typeof entry.reason === 'string' && entry.reason.trim()) rec.reason = entry.reason.slice(0, 200)
      if ('confidence' in entry && okConf(entry.confidence)) rec.confidence = entry.confidence
      if ('cols' in entry && Array.isArray(entry.cols)) {
        const names = (entry.cols as unknown[]).filter((c): c is string => typeof c === 'string' && !!c.trim()).slice(0, 4)
        if (names.length) rec.cols = names
      }
      norm.push(rec)
    }
    if (!norm.length) return fallback()
    while (norm.length < 3) norm.push({ title: 'Choose a statistical test', detail: '', target: 'tests', confidence: 'low' })
    return { primary: norm[0]!, secondary: [norm[1]!, norm[2]!], source: 'ai' }
  } catch {
    const f = fallback()
    return { ...f, error: 'AI recommendation unavailable. Showing offline suggestions.' }
  }
}
