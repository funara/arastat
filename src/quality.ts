// Data-quality scanners (pure: no Vue/store imports, so node tests can import this).
// Reuses: isUserMissing logic from store.ts, NUMERIC_SHAPE/numericCell regex from
// src/io/types.ts, edaStats quartile (floor(n*0.25)/floor(n*0.75)) + topCategories
// (freqMap sorted desc, slice(0,5)) indexing from VariableConfigDialog.vue.
// Zero engine calls, zero new deps.
// Fixes route through setMeta/deleteColumnByName in the UI (one undo each).
// Flag-only detectors (typeMismatch, dirtyCategories, outliers) carry fix:null
// with a Phase 3 note; the UI shows evidence and waits for Confirm.
import type { ColumnMeta, ColumnarDataset } from './io/types.ts'

export type Cell = number | string | null
export type QualityKind =
  | 'sentinel'
  | 'typeMismatch'
  | 'measureMismatch'
  | 'unlabeledCodes'
  | 'constant'
  | 'empty'
  | 'duplicates'
  | 'idLike'
  | 'dirtyCategories'
  | 'outliers'

// Minimal fix descriptor: the UI maps each op to one store call (one undo).
// sentinel -> setMeta(col,'missing',values+v); low-cardinality/id-like ->
// setMeta(col,'measure','nominal'); unlabeled -> apply Likert/binary preset
export type QualityFix =
  | { op: 'setMetaMissing'; col: string; value: number | string }
  | { op: 'setMeasureNominal'; col: string }
  | { op: 'applyPreset'; col: string; preset: 'binary' | 'likert5' }
  | { op: 'deleteColumn'; col: string }
  | { op: 'mergeCategories'; col: string }
  | { op: 'convertToNumeric'; col: string }
  | { op: 'winsorize'; col: string }

export interface QualityIssue {
  col: string
  kind: QualityKind
  severity: 'warn' | 'err'
  message: string
  evidence: string
  fix: QualityFix | null
  fixNote?: string
}

// Local isUserMissing replica (store.ts logic, inlined to stay pure / vue-free).
function isMissing(meta: ColumnMeta, v: Cell): boolean {
  if (v === null) return true
  if (meta.missing.values.some((x) => x === v)) return true
  return typeof v === 'number' && meta.missing.ranges.some(([lo, hi]) => v >= lo && v <= hi)
}

// NUMERIC_SHAPE replica from src/io/types.ts (datasetFromRows regex).
const NUMERIC_SHAPE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/
function isNumericText(s: string): boolean {
  const t = s.trim()
  if (!NUMERIC_SHAPE.test(t)) return false
  return Number.isFinite(Number(t))
}

function validCells(meta: ColumnMeta, values: Cell[]): Cell[] {
  return values.filter((v) => !isMissing(meta, v))
}

function validNums(meta: ColumnMeta, values: Cell[]): number[] {
  const out: number[] = []
  for (const v of values) {
    if (!isMissing(meta, v) && typeof v === 'number' && Number.isFinite(v)) out.push(v)
  }
  return out
}

function distinctValid(values: Cell[]): Cell[] {
  return Array.from(new Set(values.map((v) => v as string | number)))
}

export function missingPctFor(meta: ColumnMeta, values: Cell[]): number {
  if (!values.length) return 0
  let miss = 0
  for (const v of values) if (isMissing(meta, v)) miss++
  return Math.round((miss / values.length) * 100)
}

// Compact number for evidence: integers plain, else up to 2 decimals trimmed.
function fmtB(v: number): string {
  if (!Number.isFinite(v)) return String(v)
  if (Number.isInteger(v)) return String(v)
  return String(Number(v.toFixed(2)))
}

// --- sentinel candidates at the max/min extreme ---
const SENTINELS = [99, 999, 9999, 99999, 998, 997, -1, -9, -99, -999]
export function scanSentinels(meta: ColumnMeta, values: Cell[]): QualityIssue[] {
  if (meta.type !== 'numeric') return []
  const valid = validCells(meta, values)
  const validN = valid.length
  if (validN < 10) return []
  const nums = validNums(meta, values)
  if (!nums.length) return []
  let min = Infinity
  let max = -Infinity
  for (const v of nums) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const uniq = Array.from(new Set(nums)).sort((a, b) => a - b)
  const threshold = Math.max(2, Math.ceil(validN * 0.01))
  const out: QualityIssue[] = []
  for (const s of SENTINELS) {
    // Skip codes already declared as user-missing (values or covering ranges).
    if (meta.missing.values.some((x) => x === s)) continue
    if (meta.missing.ranges.some(([lo, hi]) => s >= lo && s <= hi)) continue
    let count = 0
    for (const v of valid) if (v === s) count++
    if (count < threshold) continue
    if (s !== min && s !== max) continue // extreme max/min only
    const pct = (count / validN) * 100
    const pctS = pct.toFixed(1)
    let evidence: string
    if (s === max && uniq.length > 1) {
      const next = uniq[uniq.length - 2]!
      evidence = `${s} x${count} (${pctS}%) \u2014 max=${max}, next=${fmtB(next)}`
    } else if (s === min && uniq.length > 1) {
      const next = uniq[1]!
      evidence = `${s} x${count} (${pctS}%) \u2014 min=${min}, next=${fmtB(next)}`
    } else {
      evidence = `${s} x${count} (${pctS}%) \u2014 max=${max}, next=${fmtB(max)}`
    }
    out.push({
      col: meta.name,
      kind: 'sentinel',
      severity: 'warn',
      message: `Possible sentinel-missing code: ${evidence}. Declare as user-missing if it means missing.`,
      evidence,
      fix: { op: 'setMetaMissing', col: meta.name, value: s }
    })
  }
  return out
}

// --- string column that parses as numeric >=95% ---
export function scanTypeMismatch(meta: ColumnMeta, values: Cell[]): QualityIssue[] {
  if (meta.type !== 'string') return []
  const valid = validCells(meta, values)
  const validN = valid.length
  if (validN < 10) return []
  let parseable = 0
  let example = ''
  for (const v of valid) {
    const ok =
      (typeof v === 'number' && Number.isFinite(v)) ||
      (typeof v === 'string' && isNumericText(v))
    if (ok) parseable++
    else if (!example) example = String(v)
  }
  if (parseable / validN < 0.95) return []
  const pct = Math.round((parseable / validN) * 100)
  const unparseable = validN - parseable
  const evidence =
    unparseable === 0
      ? `STR but ${pct}% numeric (${parseable}/${validN})`
      : `STR but ${pct}% numeric (${parseable}/${validN}) + ${unparseable} unparseable: ${JSON.stringify(example)}`
  return [{
    col: meta.name,
    kind: 'typeMismatch',
    severity: 'warn',
    message: `${evidence}. Convert text column to numeric.`,
    evidence,
    fix: { op: 'convertToNumeric', col: meta.name },
    fixNote: 'Convert to numeric'
  }]
}

// --- numeric scale/ratio with <=10 distinct values (likely categorical) ---
export function scanMeasureMismatch(meta: ColumnMeta, values: Cell[]): QualityIssue[] {
  if (meta.type !== 'numeric') return []
  if (meta.measure !== 'scale' && meta.measure !== 'ratio') return []
  const valid = validCells(meta, values)
  const validN = valid.length
  if (validN < 10) return []
  const d = distinctValid(valid).length
  if (d < 1 || d > 10) return []
  // Top-category indexing (VariableConfigDialog edaStats): freq desc.
  const freq = new Map<string | number, number>()
  for (const v of valid) freq.set(v as string | number, (freq.get(v as string | number) ?? 0) + 1)
  const sorted = Array.from(freq.entries()).sort((a, b) => b[1] - a[1])
  const top = sorted.slice(0, 3).map(([v, c]) => `${String(v)}(${c})`).join(', ')
  const evidence = `Scale with ${d} distinct: ${top}${d > 3 ? '...' : ''} \u2014 looks categorical`
  return [{
    col: meta.name,
    kind: 'measureMismatch',
    severity: 'warn',
    message: `${evidence}.`,
    evidence,
    fix: { op: 'setMeasureNominal', col: meta.name }
  }]
}

// --- code sets with <100% valueLabels; presets only, never auto-gender ---
export function scanUnlabeledCodes(meta: ColumnMeta, values: Cell[]): QualityIssue[] {
  if (meta.type !== 'numeric') return []
  const nums = validNums(meta, values)
  if (!nums.length) return []
  const distinct = Array.from(new Set(nums)).sort((a, b) => a - b)
  if (distinct.length < 2 || distinct.length > 7) return []
  if (!distinct.every((v) => Number.isInteger(v))) return []
  // ponytail: zero-based counts (SibSp/Parch 0..6+, gaps ok) skip; binary 0/1 and 0-4 scales (max<=5) still fire; revisit if labeled-count schemes (0..N with value labels) need distinguishing from raw counts
  if (distinct[0] === 0 && distinct[distinct.length - 1] > 5 && distinct.length > 5) return []
  const inSet = (lo: number, hi: number): boolean => distinct.every((v) => v >= lo && v <= hi)
  let rangeLabel = ''
  if (distinct.length === 2 && distinct[0] === 0 && distinct[1] === 1) rangeLabel = '0\u20131'
  else if (inSet(1, 4)) rangeLabel = '1\u20134'
  else if (inSet(1, 5)) rangeLabel = '1\u20135'
  else if (inSet(1, 7)) rangeLabel = '1\u20137'
  else if (inSet(0, 10)) rangeLabel = '0\u201310'
  else return []
  const labels = meta.valueLabels || {}
  const missing = distinct.filter((v) => !(String(v) in labels))
  if (!missing.length) return [] // 100% labeled -> clean
  const labeled = distinct.length - missing.length
  const observed = `${distinct[0]}–${distinct[distinct.length - 1]}`
  const evidence = `Codes ${observed}, ${labeled}/${distinct.length} labeled \u2014 missing: ${missing.join(',')}`
  let fix: QualityFix | null = null
  let fixNote: string | undefined
  if (rangeLabel === '0\u20131') fix = { op: 'applyPreset', col: meta.name, preset: 'binary' }
  else if (rangeLabel === '1\u20135') fix = { op: 'applyPreset', col: meta.name, preset: 'likert5' }
  else fixNote = 'Label manually in Value Labels (no auto preset, no auto-gender).'
  return [{
    col: meta.name,
    kind: 'unlabeledCodes',
    severity: 'warn',
    message: `${evidence}. Apply the preset in Value Labels (no auto-gender).`,
    evidence,
    fix,
    ...(fixNote ? { fixNote } : {})
  }]
}

export function scanConstant(meta: ColumnMeta, values: Cell[]): QualityIssue[] {
  const totalN = values.length
  if (totalN < 2) return []
  const valid = validCells(meta, values)
  if (!valid.length) return [] // all-missing is empty, not constant
  if (distinctValid(valid).length !== 1) return []
  const evidence = `Constant: all ${valid.length} = ${JSON.stringify(valid[0])} \u2014 zero variance`
  return [{
    col: meta.name,
    kind: 'constant',
    severity: 'warn',
    message: `${evidence}.`,
    evidence,
    fix: { op: 'deleteColumn', col: meta.name }
  }]
}

export function scanEmpty(meta: ColumnMeta, values: Cell[]): QualityIssue[] {
  const totalN = values.length
  if (totalN === 0) return []
  const valid = validCells(meta, values)
  if (valid.length !== 0) return []
  const evidence = `Empty: 0/${totalN} valid`
  return [{
    col: meta.name,
    kind: 'empty',
    severity: 'err',
    message: `${evidence}.`,
    evidence,
    fix: { op: 'deleteColumn', col: meta.name }
  }]
}

// Per-column duplicates: pairwise strict === per row against earlier columns.
// One issue per duplicate column (keep-first); totalN>0.
export function scanDuplicates(ds: ColumnarDataset): QualityIssue[] {
  if (!ds.columns.length) return []
  const first = ds.columns[0]!
  const n = (ds.data[first.name]?.length ?? 0) as number
  if (n === 0) return []
  const out: QualityIssue[] = []
  const cols = ds.columns
  for (let i = 1; i < cols.length; i++) {
    const cur = cols[i]!
    const curArr = (ds.data[cur.name] ?? []) as Cell[]
    if (curArr.length !== n) continue
    for (let j = 0; j < i; j++) {
      const prev = cols[j]!
      const prevArr = (ds.data[prev.name] ?? []) as Cell[]
      if (prevArr.length !== n) continue
      let match = 0
      for (let r = 0; r < n; r++) {
        if ((curArr[r] ?? null) === (prevArr[r] ?? null)) match++
        else break
      }
      if (match === n) {
        const evidence = `Identical to ${prev.name} (${match}/${n} match)`
        out.push({
          col: cur.name,
          kind: 'duplicates',
          severity: 'warn',
          message: `${evidence} \u2014 delete the duplicate (keep first).`,
          evidence,
          fix: { op: 'deleteColumn', col: cur.name }
        })
        break // keep-first: one finding per duplicate column
      }
    }
  }
  return out
}

function isLikelyIdName(name: string): boolean {
  const n = name.trim().toLowerCase()
  return (
    n === 'id' ||
    n.endsWith('_id') ||
    n.startsWith('id_') ||
    n.endsWith('id') ||
    n.endsWith('_num') ||
    n.endsWith('_no') ||
    n.endsWith('_code') ||
    n === 'code' ||
    n === 'uuid' ||
    n === 'ssn' ||
    n === 'record' ||
    n === 'index'
  )
}

function isSequentialIntegers(nums: number[]): boolean {
  if (nums.length < 5) return false
  const sorted = [...nums].sort((a, b) => a - b)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) return false
  }
  return true
}

// >=95% unique (ID-like).
export function scanIdLike(meta: ColumnMeta, values: Cell[]): QualityIssue[] {
  if (meta.measure === 'nominal') return []
  const valid = validCells(meta, values)
  if (valid.length < 10) return []
  const uniq = distinctValid(valid).length
  if (uniq / valid.length < 0.95) return []
  // Continuous numeric scale variables (e.g. salary) naturally have unique values;
  // only flag numeric columns if their name or sequential integer structure indicates an ID.
  if (meta.type === 'numeric') {
    const nums = validNums(meta, values)
    if (!isLikelyIdName(meta.name) && !isSequentialIntegers(nums)) return []
  }
  const evidence = `ID-like: ${uniq}/${valid.length} unique \u2014 exclude from stats`
  return [{
    col: meta.name,
    kind: 'idLike',
    severity: 'warn',
    message: `${evidence}.`,
    evidence,
    fix: { op: 'setMeasureNominal', col: meta.name }
  }]
}

// Whitespace/case variants collapsing to one category.
export function scanDirtyCategories(meta: ColumnMeta, values: Cell[]): QualityIssue[] {
  if (meta.type !== 'string') return []
  const valid = validCells(meta, values)
  if (valid.length < 2) return []
  const groups = new Map<string, Map<string, number>>()
  for (const v of valid) {
    const raw = String(v)
    const norm = raw.trim().toLowerCase().replace(/\s+/g, ' ')
    if (!groups.has(norm)) groups.set(norm, new Map())
    const m = groups.get(norm)!
    m.set(raw, (m.get(raw) ?? 0) + 1)
  }
  const rawDistinct = new Set(valid.map((v) => String(v))).size
  if (groups.size >= rawDistinct) return [] // trim+lower changes nothing
  let affected = 0
  let biggest: { norm: string; raws: Array<[string, number]>; total: number } | null = null
  for (const [norm, m] of groups) {
    if (m.size < 2) continue
    let total = 0
    for (const c of m.values()) total += c
    affected += total
    if (!biggest || total > biggest.total) {
      const raws = Array.from(m.entries()).sort((a, b) => b[1] - a[1])
      biggest = { norm, raws, total }
    }
  }
  if (!biggest || affected < 2) return []
  const shown = biggest.raws.slice(0, 3).map(([r, c]) => `${JSON.stringify(r)}x${c}`).join(', ')
  const dominant = biggest.raws[0]?.[0] ?? biggest.norm
  const evidence = `${biggest.raws.length} variants \u2192 1: [${shown}${biggest.raws.length > 3 ? '...' : ''}]`
  return [{
    col: meta.name,
    kind: 'dirtyCategories',
    severity: 'warn',
    message: `Inconsistent casing or spacing: ${evidence}. Standardize to dominant form "${dominant}".`,
    evidence,
    fix: { op: 'mergeCategories', col: meta.name },
    fixNote: 'Merge case variants'
  }]
}

// IQR outliers (edaStats quartile indexing), flag only 1%..15%.
export function scanOutliers(meta: ColumnMeta, values: Cell[]): QualityIssue[] {
  if (meta.type !== 'numeric') return []
  if (meta.measure === 'nominal' || meta.measure === 'ordinal') return []
  const nums = validNums(meta, values)
  if (nums.length < 10) return []
  // Discrete scales with <= 7 integer values (e.g. Likert 1-5, 1-7) are rating scales, not continuous distributions with outliers
  const uniq = new Set(nums)
  if (uniq.size <= 7 && Array.from(uniq).every((v) => Number.isInteger(v))) return []
  const sorted = [...nums].sort((a, b) => a - b)
  const q1 = sorted[Math.floor(sorted.length * 0.25)]!
  const q3 = sorted[Math.floor(sorted.length * 0.75)]!
  const iqr = q3 - q1
  if (!Number.isFinite(iqr) || iqr <= 0) return []
  const lo = q1 - 1.5 * iqr
  const hi = q3 + 1.5 * iqr
  let out = 0
  for (const v of nums) if (v < lo || v > hi) out++
  if (out < 1) return []
  const rate = out / nums.length
  if (rate < 0.01 || rate > 0.15) return []
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length
  const variance = nums.reduce((a, v) => a + (v - mean) * (v - mean), 0) / (nums.length > 1 ? nums.length - 1 : 1)
  const stdDev = Math.sqrt(variance)
  let maxZ = 0
  if (Number.isFinite(stdDev) && stdDev > 0) {
    for (const v of nums) {
      if (v < lo || v > hi) {
        const z = Math.abs((v - mean) / stdDev)
        if (z > maxZ) maxZ = z
      }
    }
  }
  const pctS = (rate * 100).toFixed(1)
  // ponytail: display clamped to observed [min,max]; write path (transforms.ts) untouched, same capped set; unify display+write fences if winsorize bounds ever diverge from evidence
  const dLo = Math.max(lo, sorted[0]!), dHi = Math.min(hi, sorted[sorted.length - 1]!)
  const evidence = `${out} outliers (${pctS}%): bounds [${fmtB(dLo)},${fmtB(dHi)}], max|z|=${maxZ.toFixed(1)}`
  return [{
    col: meta.name,
    kind: 'outliers',
    severity: 'warn',
    message: `${evidence}. Inspect distribution in Histogram or Winsorize to bounds.`,
    evidence,
    fix: { op: 'winsorize', col: meta.name },
    fixNote: 'Winsorize or Review in Histogram'
  }]
}

export interface QualityReport {
  issues: QualityIssue[]
  byColumn: Record<string, QualityIssue[]>
  badgeN: number
  hasErr: boolean
}

/** Aggregator: per-column scans + pairwise duplicate columns; badgeN = cols with any issue. */
export function scanQuality(ds: ColumnarDataset): QualityReport {
  const issues: QualityIssue[] = []
  const byColumn: Record<string, QualityIssue[]> = {}
  let hasErr = false
  const push = (col: string, list: QualityIssue[]): void => {
    if (!list.length) return
    if (!byColumn[col]) byColumn[col] = []
    byColumn[col].push(...list)
    issues.push(...list)
  }
  for (const c of ds.columns) {
    const vals = ((ds.data[c.name] ?? []) as Cell[])
    push(c.name, scanEmpty(c, vals))
    push(c.name, scanConstant(c, vals))
    push(c.name, scanSentinels(c, vals))
    push(c.name, scanTypeMismatch(c, vals))
    push(c.name, scanMeasureMismatch(c, vals))
    push(c.name, scanUnlabeledCodes(c, vals))
    push(c.name, scanIdLike(c, vals))
    push(c.name, scanDirtyCategories(c, vals))
    push(c.name, scanOutliers(c, vals))
    // Badge err gates (not scanners): missing>40% or string+scale(/ratio).
    const mp = missingPctFor(c, vals)
    if (mp > 40) hasErr = true
    if (c.type === 'string' && (c.measure === 'scale' || c.measure === 'ratio')) hasErr = true
  }
  for (const d of scanDuplicates(ds)) push(d.col, [d])
  for (const list of Object.values(byColumn)) {
    if (list.some((i) => i.severity === 'err')) hasErr = true
  }
  const badgeN = Object.keys(byColumn).length
  return { issues, byColumn, badgeN, hasErr }
}

// --- health score (single documented aggregator) ---
// Audit notes (2026-09-28): previously no unified score existed; the modal
// showed row-level listwise completeness (completeRows/rows) next to unrelated
// per-column issue counts, so a dataset could read "100% usable" while carrying
// type errors. Denominators checked: missingPctFor divides by all cells
// (correct), outlier rate by valid numerics (correct), type-mismatch share by
// valid cells (correct), id-like share by valid cells (correct), duplicates by
// row count (correct). Double-counting found and fixed here: measureMismatch
// and unlabeledCodes can fire on the same column (e.g. Likert 1-5), and an
// identical constant column pair fires constant + duplicates, so each
// dimension counts a column ONCE (Set) even with several issues in it.
// Dimensions below intentionally overlap across (not within) dimensions.
export interface HealthDimension {
  id: 'completeness' | 'validity' | 'consistency' | 'uniqueness'
  label: string
  /** 0-100, rounded once at the score level; dims carry one decimal. */
  pct: number
  weight: number
  detail: string
}

export interface HealthSummary {
  score: number
  dimensions: HealthDimension[]
  issues: QualityIssue[]
  rows: number
  columns: number
}

/** Weights sum to 1. Completeness dominates: missing cells block every model. */
const HEALTH_WEIGHTS = { completeness: 0.4, validity: 0.25, consistency: 0.2, uniqueness: 0.15 } as const

/**
 * One documented rollup: score 0-100, capped, rounded ONCE.
 * Empty dataset (no columns or zero rows) -> null; the modal shows an
 * empty state, never a 0 that reads as "worst possible data".
 */
export function computeHealth(ds: ColumnarDataset): HealthSummary | null {
  const cols = ds.columns
  if (!cols.length) return null
  const rows = (ds.data[cols[0]!.name]?.length ?? 0) as number
  if (!rows) return null
  const report = scanQuality(ds)
  let missingCells = 0
  let totalCells = 0
  for (const c of cols) {
    const vals = (ds.data[c.name] ?? []) as Cell[]
    totalCells += vals.length
    for (const v of vals) if (isMissing(c, v)) missingCells++
  }
  const affected = (kinds: QualityKind[]): Set<string> => {
    const s = new Set<string>()
    for (const i of report.issues) if (kinds.includes(i.kind)) s.add(i.col)
    return s
  }
  // Completeness denominator is CELLS (rows x cols); the row-level listwise
  // share lives in readinessSummary and answers a different question.
  const completeness = totalCells ? 1 - missingCells / totalCells : 1
  const n = cols.length
  const validity = 1 - affected(['typeMismatch', 'measureMismatch', 'unlabeledCodes', 'sentinel', 'outliers', 'idLike']).size / n
  const consistency = 1 - affected(['constant', 'empty', 'dirtyCategories']).size / n
  const uniqueness = 1 - affected(['duplicates']).size / n
  const dims: HealthDimension[] = [
    { id: 'completeness', label: 'Completeness', pct: completeness * 100, weight: HEALTH_WEIGHTS.completeness, detail: `${totalCells - missingCells}/${totalCells} cells filled` },
    { id: 'validity', label: 'Validity', pct: validity * 100, weight: HEALTH_WEIGHTS.validity, detail: 'Types, scales, sentinels, outliers' },
    { id: 'consistency', label: 'Consistency', pct: consistency * 100, weight: HEALTH_WEIGHTS.consistency, detail: 'Constant, empty, mixed-case categories' },
    { id: 'uniqueness', label: 'Uniqueness', pct: uniqueness * 100, weight: HEALTH_WEIGHTS.uniqueness, detail: 'Duplicate columns' },
  ]
  const raw = dims.reduce((sum, d) => sum + (d.pct / 100) * d.weight, 0) * 100
  const score = Math.max(0, Math.min(100, Math.round(raw)))
  const issues = [...report.issues].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === 'err' ? -1 : 1
  )
  return { score, dimensions: dims, issues, rows, columns: n }
}
