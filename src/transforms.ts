// Phase 3.2 — pure transform math (no Vue/store imports, so node tests can import this).
// Log / standardize / bin each produce a NEW column; the source column is never
// touched. The store wraps these in a single `colAdd` commit (via insertColumnAt
// with values) = one undo. Missing cells (per the caller's isMissing) stay null.

export type Cell = number | string | null
export type TransformKind = 'log' | 'standardize' | 'bin'

export interface TransformCompute {
  values: Cell[]
  error: string | null
}

/** Natural-log transform. Refuses when any valid numeric is <= 0 (message counts them). */
export function computeLogValues(
  vals: Cell[],
  isMissing: (v: Cell) => boolean
): TransformCompute {
  const out: Cell[] = new Array(vals.length)
  let bad = 0
  let badExample: Cell = null
  let hasValid = false
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i] ?? null
    if (isMissing(v)) {
      out[i] = null
      continue
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      out[i] = null // non-numeric in a numeric col -> null, never blocks
      continue
    }
    hasValid = true
    if (v <= 0) {
      bad++
      if (badExample === null) badExample = v
      out[i] = null
      continue
    }
    out[i] = Math.log(v)
  }
  if (!hasValid) return { values: out, error: 'No valid values to transform.' }
  if (bad > 0) {
    const ex = badExample !== null ? `, e.g. ${String(badExample)}` : ''
    return { values: out, error: `Cannot take log: values must be > 0 (found ${bad} non-positive${ex}).` }
  }
  return { values: out, error: null }
}

/** Z-scores via sample SD (n-1, matching the EDA inspector). */
export function computeStandardizeValues(
  vals: Cell[],
  isMissing: (v: Cell) => boolean
): TransformCompute {
  const out: Cell[] = new Array(vals.length)
  const nums: number[] = []
  for (const raw of vals) {
    const v = raw ?? null
    if (isMissing(v)) continue
    if (typeof v === 'number' && Number.isFinite(v)) nums.push(v)
  }
  if (!nums.length) return { values: vals.map(() => null), error: 'No valid values to transform.' }
  if (nums.length < 2) return { values: vals.map(() => null), error: 'Cannot standardize: need at least 2 valid values.' }
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length
  const variance = nums.reduce((a, v) => a + (v - mean) * (v - mean), 0) / (nums.length - 1)
  const sd = Math.sqrt(variance)
  if (!Number.isFinite(sd) || sd === 0) {
    return { values: vals.map(() => null), error: 'Cannot standardize: zero variance (SD = 0).' }
  }
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i] ?? null
    if (isMissing(v)) {
      out[i] = null
      continue
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      out[i] = null
      continue
    }
    out[i] = (v - mean) / sd
  }
  return { values: out, error: null }
}

/** Equal-width binning into k integer groups 1..k (for an ordinal new column). */
export function computeBinValues(
  vals: Cell[],
  isMissing: (v: Cell) => boolean,
  k = 5
): TransformCompute {
  if (!Number.isFinite(k) || Math.floor(k) !== k || k < 2 || k > 20) {
    return { values: vals.map(() => null), error: 'Bins must be a whole number from 2 to 20.' }
  }
  const nums: number[] = []
  for (const raw of vals) {
    const v = raw ?? null
    if (isMissing(v)) continue
    if (typeof v === 'number' && Number.isFinite(v)) nums.push(v)
  }
  if (!nums.length) return { values: vals.map(() => null), error: 'No valid values to transform.' }
  let lo = Infinity
  let hi = -Infinity
  for (const v of nums) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (!(hi > lo)) {
    return { values: vals.map(() => null), error: `Cannot bin: zero variance (all valid = ${String(nums[0])}).` }
  }
  const w = (hi - lo) / k
  const out: Cell[] = new Array(vals.length)
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i] ?? null
    if (isMissing(v)) {
      out[i] = null
      continue
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      out[i] = null
      continue
    }
    let b = Math.floor((v - lo) / w)
    if (b < 0) b = 0
    if (b >= k) b = k - 1 // v == max lands in the last bin
    out[i] = b + 1
  }
  return { values: out, error: null }
}

/** Derived-column naming: `${src}${suffix}`, deduped case-insensitively (`_2`, `_3`, ...). Pure. */
export function suggestTransformName(existing: string[], src: string, suffix: string): string {
  const lower = new Set(existing.map((n) => n.toLowerCase()))
  const base = `${src}${suffix}`
  if (!lower.has(base.toLowerCase())) return base
  let i = 2
  while (lower.has(`${base}_${i}`.toLowerCase())) i++
  return `${base}_${i}`
}

// --- Phase 3.1 cell rewrites (pure; each wrapped by the store in ONE
// batchCells/setDataset commit = one undo). Missing cells (per the caller's
// isMissing) stay null.

const NUMERIC_SHAPE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

export interface ConvertCompute {
  values: Cell[]
  error: string | null
  /** Decimals for the converted column (mirrors onStorageTypeChange: all-integer -> 0, else 2). */
  decimals: number
  converted: number
  nulled: number
}

/** str->numeric: NUMERIC_SHAPE text parses, everything else unparseable -> null. */
export function computeConvertValues(
  vals: Cell[],
  isMissing: (v: Cell) => boolean
): ConvertCompute {
  const out: Cell[] = new Array(vals.length)
  let validN = 0
  let converted = 0
  let nulled = 0
  let allInteger = true
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i] ?? null
    if (isMissing(v)) {
      out[i] = null
      continue
    }
    validN++
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[i] = v
      if (!Number.isInteger(v)) allInteger = false
      continue
    }
    if (typeof v === 'string') {
      const t = v.trim()
      if (NUMERIC_SHAPE.test(t)) {
        const n = Number(t)
        if (Number.isFinite(n)) {
          out[i] = n
          converted++
          if (!Number.isInteger(n)) allInteger = false
          continue
        }
      }
    }
    out[i] = null
    nulled++
  }
  if (!validN) {
    return { values: vals.map(() => null), error: 'No valid values to convert.', decimals: 0, converted: 0, nulled: 0 }
  }
  return { values: out, error: null, decimals: allInteger ? 0 : 2, converted, nulled }
}

export interface MergeCompute {
  values: Cell[]
  changed: number
  examples: string[]
}

const normCat = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * dirty-merge: variants collapsing to one normalized form rewrite to the
 * most-frequent raw form (ties: first-seen), trimmed so the dirt goes away.
 */
export function computeMergeValues(
  vals: Cell[],
  isMissing: (v: Cell) => boolean
): MergeCompute {
  const out: Cell[] = vals.map((v) => v ?? null)
  const groups = new Map<string, { rows: number[]; freq: Map<string, number>; first: Map<string, number> }>()
  vals.forEach((raw, i) => {
    const v = raw ?? null
    if (isMissing(v)) return
    const s = String(v)
    const k = normCat(s)
    let g = groups.get(k)
    if (!g) {
      g = { rows: [], freq: new Map(), first: new Map() }
      groups.set(k, g)
    }
    g.rows.push(i)
    g.freq.set(s, (g.freq.get(s) ?? 0) + 1)
    if (!g.first.has(s)) g.first.set(s, i)
  })
  let changed = 0
  const examples: string[] = []
  for (const g of groups.values()) {
    if (g.freq.size < 2) continue
    let win = ''
    let winN = -1
    let winFirst = Infinity
    for (const [s, n] of g.freq) {
      const f = g.first.get(s)!
      if (n > winN || (n === winN && f < winFirst)) {
        win = s
        winN = n
        winFirst = f
      }
    }
    const target = win.trim()
    for (const [s] of g.freq) {
      if (s !== target && examples.length < 2) examples.push(`"${s}"\u2192"${target}"`)
    }
    for (const r of g.rows) {
      if (out[r] !== target) {
        out[r] = target
        changed++
      }
    }
  }
  return { values: out, changed, examples }
}

export interface WinsorizeCompute {
  values: Cell[]
  error: string | null
  lo: number
  hi: number
  changed: number
}

/**
 * Winsorize to [Q1-1.5IQR, Q3+1.5IQR] (floor(n*0.25)/floor(n*0.75) quartile
 * indexing, matching edaStats and the outlier scanner). Only out-of-bounds
 * cells are rewritten, rounded to `decimals`; in-bounds cells are untouched.
 */
export function computeWinsorizeValues(
  vals: Cell[],
  isMissing: (v: Cell) => boolean,
  decimals = 2
): WinsorizeCompute {
  const fail = (error: string): WinsorizeCompute =>
    ({ values: vals.map(() => null), error, lo: 0, hi: 0, changed: 0 })
  const nums: number[] = []
  for (const raw of vals) {
    const v = raw ?? null
    if (isMissing(v)) continue
    if (typeof v === 'number' && Number.isFinite(v)) nums.push(v)
  }
  if (nums.length < 10) return fail('Need at least 10 valid values to winsorize.')
  const sorted = [...nums].sort((a, b) => a - b)
  const q1 = sorted[Math.floor(sorted.length * 0.25)]!
  const q3 = sorted[Math.floor(sorted.length * 0.75)]!
  const iqr = q3 - q1
  if (!(iqr > 0)) return fail('Zero spread (IQR = 0): nothing to winsorize.')
  const lo = q1 - 1.5 * iqr
  const hi = q3 + 1.5 * iqr
  const d = Number.isFinite(decimals) ? Math.max(0, Math.min(16, Math.floor(decimals))) : 2
  const out: Cell[] = vals.map((v) => v ?? null)
  let changed = 0
  for (let i = 0; i < out.length; i++) {
    const v = out[i]
    if (isMissing(v) || typeof v !== 'number' || !Number.isFinite(v)) continue
    if (v < lo || v > hi) {
      out[i] = Number((v < lo ? lo : hi).toFixed(d))
      changed++
    }
  }
  return { values: out, error: null, lo, hi, changed }
}

export interface RecodeRule {
  /** Matched with the cell's string form, so 1 and '1' are one rule. */
  from: string
  to: string
}

export interface RecodeCompute {
  values: Cell[]
  error: string | null
  changed: number
}

/**
 * Recode cell values through an old → new table (SPSS Recode into Different
 * Variables). Unmatched cells pass through untouched; a blank `to` means the
 * code becomes missing. `numericOut` writes numbers where the new text parses
 * as one, so a numeric column stays numeric.
 */
export function computeRecodeValues(
  vals: Cell[],
  isMissing: (v: Cell) => boolean,
  rules: RecodeRule[],
  numericOut: boolean
): RecodeCompute {
  const usable = rules.filter((r) => r.from.trim() !== '')
  if (!usable.length) return { values: vals.map(() => null), error: 'Add at least one old → new rule.', changed: 0 }
  const map = new Map<string, string>()
  for (const r of usable) map.set(r.from.trim(), r.to.trim())
  const out: Cell[] = vals.map((v) => v ?? null)
  let changed = 0
  for (let i = 0; i < out.length; i++) {
    const v = out[i]
    if (isMissing(v)) continue
    const key = String(v)
    if (!map.has(key)) continue
    const to = map.get(key) as string
    out[i] = to === '' ? null : numericOut && Number.isFinite(Number(to)) ? Number(to) : to
    changed++
  }
  return { values: out, error: null, changed }
}
