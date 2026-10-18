// Shared display formatting for result tables (ResultsPane + HTML export).
// Raw engine numbers stay untouched in the store; formatting is view-only.

/** A raw cell: numbers format APA-style, strings pass through, null is missing. */
export function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return '-'
  if (typeof v === 'string') return v === '' ? '-' : v
  if (typeof v !== 'number' || !Number.isFinite(v)) return '-'
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v)
  return String(parseFloat(v.toFixed(3)))
}

/** APA p value: ".012", "< .001" below threshold, "-" when not computed. */
export function fmtP(p: unknown): string {
  if (typeof p !== 'number' || !Number.isFinite(p)) return '-'
  if (p < 0.001) return '< .001'
  return String(parseFloat(p.toFixed(3))).replace(/^0\./, '.')
}

/** True when a table column header holds p values (drives fmtP + "*" marks). */
export function isPColumn(header: string): boolean {
  return header.trim().toLowerCase() === 'p'
}

/** True when a p value earns a significance star. */
export function isSig(p: unknown): boolean {
  return typeof p === 'number' && Number.isFinite(p) && p < 0.05
}
