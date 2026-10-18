// Dataset profile: deterministic aggregates for the Explain Data card.
// Aggregate-only (counts, missing %, min/max/mean) - never raw rows, so no
// cell values or PII cross into the LLM prompt.
import type { Cell } from './missing.ts'

export interface ColumnProfile {
  name: string
  type: string
  n: number
  missing: number
  detail: string
}

export interface DatasetProfile {
  columns: number
  rows: number
  completeRows: number
  profiles: ColumnProfile[]
}

/** Deterministic per-column aggregates over cells passing isMissing. */
export function profileDataset(
  cols: Array<{ name: string; type: string }>,
  data: Record<string, Cell[]>,
  isMissing: (col: string, v: Cell) => boolean
): DatasetProfile {
  const names = cols.map((c) => c.name)
  const first = names.map((n) => data[n]).find((a) => Array.isArray(a))
  const rows = first ? first.length : 0
  let completeRows = 0
  for (let r = 0; r < rows; r++) {
    let ok = true
    for (const n of names) {
      if (isMissing(n, ((data[n] as Cell[])[r] ?? null) as Cell)) {
        ok = false
        break
      }
    }
    if (ok) completeRows++
  }
  const profiles = cols.map((c) => {
    const arr = (data[c.name] as Cell[] | undefined) ?? []
    const miss = arr.filter((v) => isMissing(c.name, v)).length
    let detail = ''
    if (c.type === 'numeric') {
      const nums = arr.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && !isMissing(c.name, v))
      if (nums.length) {
        let lo = Infinity
        let hi = -Infinity
        for (const v of nums) {
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
        const mean = nums.reduce((a, b) => a + b, 0) / nums.length
        detail = `range ${fmt(lo)}–${fmt(hi)}, mean ${fmt(mean)}`
      }
    } else {
      const distinct = new Set(arr.filter((v) => !isMissing(c.name, v)).map((v) => String(v))).size
      detail = `${distinct} distinct`
    }
    return { name: c.name, type: c.type, n: rows, missing: miss, detail }
  })
  return { columns: cols.length, rows, completeRows, profiles }
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2)
}

/** Compact card text: one line per column plus the complete-rows line. */
export function profileText(p: DatasetProfile, filename: string): string {
  const lines = [
    `Dataset: ${filename || 'Untitled'} - ${p.columns} columns, ${p.rows} rows, ${p.completeRows} complete rows.`
  ]
  for (const c of p.profiles) {
    const pct = c.n ? Math.round((c.missing / c.n) * 100) : 0
    const miss = c.missing ? `${c.missing} missing (${pct}%)` : 'no missing'
    lines.push(`- ${c.name} (${c.type}): ${miss}${c.detail ? `, ${c.detail}` : ''}`)
  }
  return lines.join('\n')
}
