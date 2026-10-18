// Missing-data helpers (pure: no Vue/store imports, so node tests can import this).
// Fill statistics compute over cells that pass isMissing, so user-missing codes
// (e.g. 99) never poison the fill value. Fills route through batchCells and
// drops through one dataset commit, so each op is a single undo event.

export type Cell = number | string | null
export type FillMode = 'mean' | 'median' | 'mode'

/** Mode computation details including tied status and runner-ups. */
export function computeModeDetails(
  values: Cell[],
  isMissing: (v: Cell) => boolean
): { mode: Cell | null; count: number; tied: boolean; tiedModes: Cell[] } {
  const valid = values.filter((v) => !isMissing(v))
  if (!valid.length) return { mode: null, count: 0, tied: false, tiedModes: [] }
  const counts = new Map<Cell, number>()
  for (const v of valid) counts.set(v, (counts.get(v) ?? 0) + 1)
  let maxN = 0
  for (const [, n] of counts) {
    if (n > maxN) maxN = n
  }
  const topModes: Cell[] = []
  for (const [v, n] of counts) {
    if (n === maxN) topModes.push(v)
  }
  return {
    mode: topModes[0] ?? null,
    count: maxN,
    tied: topModes.length > 1,
    tiedModes: topModes
  }
}

/** Fill value for one column, or null when there is nothing valid to fill from
 *  (all missing, no numerics for mean/median, or a tied mode vote when tieBreaker is 'null'). */
export function computeFill(
  values: Cell[],
  mode: FillMode,
  isMissing: (v: Cell) => boolean,
  tieBreaker: 'first' | 'null' = 'null'
): Cell | null {
  const valid = values.filter((v) => !isMissing(v))
  if (!valid.length) return null
  if (mode === 'mode') {
    const details = computeModeDetails(values, isMissing)
    if (!details.mode) return null
    if (details.tied && tieBreaker === 'null') return null
    return details.mode
  }
  const nums = valid.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (!nums.length) return null
  if (mode === 'mean') return nums.reduce((a, b) => a + b, 0) / nums.length
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] as number
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

/** Row indices where any of `cols` is missing (union, ascending). */
export function rowsWithMissing(
  data: Record<string, Cell[]>,
  cols: string[],
  isMissing: (col: string, v: Cell) => boolean
): number[] {
  const first = cols.map((c) => data[c]).find((a) => Array.isArray(a))
  if (!first) return []
  const out: number[] = []
  for (let r = 0; r < first.length; r++) {
    for (const c of cols) {
      const arr = data[c]
      if (!arr) continue
      if (isMissing(c, (arr[r] ?? null) as Cell)) {
        out.push(r)
        break
      }
    }
  }
  return out
}

/**
 * Linear interpolation across missing values in a sequence.
 * For leading missing values before the first valid observation, it backfills
 * using the first valid value. For trailing missing values, it forward-fills the last.
 * For gaps between two valid numbers across step count, it interpolates linearly.
 */
export function interpolateValues(
  values: Cell[],
  isMissing: (v: Cell) => boolean,
  decimals?: number
): Array<{ row: number; next: number }> {
  const edits: Array<{ row: number; next: number }> = []
  const nums = values.map((v) => (isMissing(v) || typeof v !== 'number' || !Number.isFinite(v) ? null : v))

  const validIndices: number[] = []
  for (let i = 0; i < nums.length; i++) {
    if (nums[i] !== null) validIndices.push(i)
  }
  if (!validIndices.length) return []

  const firstValid = validIndices[0]!
  const lastValid = validIndices[validIndices.length - 1]!

  // 1. Leading missing: backfill from first valid
  const vFirst = nums[firstValid]!
  for (let i = 0; i < firstValid; i++) {
    edits.push({ row: i, next: decimals !== undefined ? Number(vFirst.toFixed(decimals)) : vFirst })
  }

  // 2. Interior missing: linear interpolation between neighboring valid points
  for (let k = 0; k < validIndices.length - 1; k++) {
    const idx0 = validIndices[k]!
    const idx1 = validIndices[k + 1]!
    if (idx1 - idx0 > 1) {
      const v0 = nums[idx0]!
      const v1 = nums[idx1]!
      const steps = idx1 - idx0
      for (let j = 1; j < steps; j++) {
        const val = v0 + ((v1 - v0) * j) / steps
        const next = decimals !== undefined ? Number(val.toFixed(decimals)) : val
        edits.push({ row: idx0 + j, next })
      }
    }
  }

  // 3. Trailing missing: forward fill from last valid
  const vLast = nums[lastValid]!
  for (let i = lastValid + 1; i < nums.length; i++) {
    edits.push({ row: i, next: decimals !== undefined ? Number(vLast.toFixed(decimals)) : vLast })
  }

  return edits
}
