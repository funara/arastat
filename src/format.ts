// Shared display formatting for result tables (ResultsPane + HTML export).
// Raw engine numbers stay untouched in the store; formatting is view-only.
import { ref } from 'vue'
import type { Run } from './results.ts'

/** Decimal places shown for numeric cells (2 | 3 | 4). */
export const decimalPlaces = ref<2 | 3 | 4>(3)

/** A raw cell: numbers format APA-style, strings pass through, null is missing. */
export function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return '-'
  if (typeof v === 'string') return v === '' ? '-' : v
  if (typeof v !== 'number' || !Number.isFinite(v)) return '-'
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v)
  return String(parseFloat(v.toFixed(decimalPlaces.value)))
}

/** APA p value: ".012", "< .001" below threshold, "-" when not computed. */
export function fmtP(p: unknown): string {
  if (typeof p !== 'number' || !Number.isFinite(p)) return '-'
  if (p < 0.001) return '< .001'
  return String(parseFloat(p.toFixed(3))).replace(/^0\./, '.')
}

/** Column headers that hold p values (drives fmtP + "*" marks). */
const P_COLUMN_HEADERS = new Set([
  'p',
  'p adj',
  'p adj.',
  'adj p',
  'adj. p',
  'p value',
  'p-value',
  'exact p',
  'bartlett p',
  'chi2 p',
  'chi-square p',
  'sig p',
  'sig. (2-tailed)'
])

/** True when a table column header holds p values (drives fmtP + "*" marks). */
export function isPColumn(header: string): boolean {
  const h = header.trim().toLowerCase()
  if (!h) return false
  if (P_COLUMN_HEADERS.has(h)) return true
  // "p", "p < .001", "p (2-tailed)": a bare p followed by a separator.
  return /^p(\s|$)/.test(h)
}

/** True when a p value earns a significance star. */
export function isSig(p: unknown): boolean {
  return typeof p === 'number' && Number.isFinite(p) && p < 0.05
}

// --- APA citation chip -------------------------------------------------------

/** Table headers that carry a test statistic. */
const STAT_HEADERS = new Set(['t', 'f', 'r', 'z', 'u', 'h', 'w', 'χ²', 'chi2', 'chi-square', 'statistic'])

/** The APA symbol for a test, when the column header alone is too generic. */
const STAT_BY_ANALYSIS: Record<string, string> = {
  ttest_onesample: 't',
  ttest_independent: 't',
  ttest_paired: 't',
  anova_oneway: 'F',
  welch_anova: 'F',
  factorial_anova_2way: 'F',
  mannwhitney_u: 'U',
  wilcoxon_signedrank: 'W',
  wilcoxon_one_sample: 'W',
  kruskal_wallis: 'H',
  friedman: 'χ²',
  chisq_independence: 'χ²',
  chisq_gof: 'χ²',
  correlation: 'r',
  kendall_tau: 'r',
  linear_regression: 't',
  logistic_regression: 'z',
  binomial: 'z'
}

export interface ApaSummary {
  /** One-line APA citation, e.g. "t(118) = -3.42, p < .001". */
  text: string
  /** The p value behind the verdict (null when the run reports none). */
  p: number | null
  /** True when p < .05. */
  significant: boolean
}

/** APA number: 3 decimals, no leading zero (".012"), sign kept. */
function fmtStat(v: number): string {
  const n = parseFloat(v.toFixed(decimalPlaces.value))
  return String(n).replace(/^(-?)0\./, '$1.')
}

/** APA p clause: "p < .001" or "p = .012". */
function fmtPClause(p: number): string {
  return p < 0.001 ? 'p < .001' : `p = ${fmtP(p)}`
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * The one-line APA citation for a run (pure): "t(118) = -3.42, p < .001".
 *
 * Two strategies, in order: a table row that pairs a statistic with its p
 * value, then the engine's footnote (χ² and H live there). Returns null when
 * the run reports no inferential statistic.
 */
export function extractApaSummary(run: Run): ApaSummary | null {
  for (const el of run.elements) {
    if (el.kind !== 'table') continue
    const pIdx = el.columns.findIndex((c) => isPColumn(c))
    if (pIdx < 0) continue
    const statIdx = el.columns.findIndex((c) => STAT_HEADERS.has(c.trim().toLowerCase()))
    if (statIdx < 0) continue
    const dfIdxs = el.columns
      .map((c, i) => (/^df\d?$/i.test(c.trim()) ? i : -1))
      .filter((i) => i >= 0)
    const symbol = STAT_BY_ANALYSIS[run.analysisId] ?? el.columns[statIdx]?.trim() ?? ''
    for (const row of el.rows) {
      const stat = row[statIdx]
      const p = row[pIdx]
      if (!isNum(stat) || !isNum(p)) continue
      const dfs = dfIdxs.map((i) => row[i]).filter(isNum)
      const dfText = dfs.length ? `(${dfs.join(', ')})` : ''
      return {
        text: `${symbol}${dfText} = ${fmtStat(stat)}, ${fmtPClause(p)}`,
        p,
        significant: isSig(p)
      }
    }
  }
  // Footnote fallback: "χ²(2) = 5.41, p = .019" and "H = 3.45, df = 2, p = .012".
  for (const el of run.elements) {
    if (el.kind !== 'table') continue
    for (const note of el.footnotes) {
      const hit = parseFootnoteStat(note)
      if (hit) return hit
    }
  }
  return null
}

/** Parse "X(df) = v, p = p" and "X = v, df = d, p = p" out of a footnote. */
function parseFootnoteStat(note: string): ApaSummary | null {
  // The symbol boundary is a non-letter, not \b: χ is not a word character.
  const withDf =
    /(?:^|[^A-Za-zχ])([A-Za-zχ][A-Za-zχ²]*)\s*\(\s*(\d+)\s*\)\s*=\s*(-?\d+(?:\.\d+)?)\s*,\s*p\s*=\s*(<)?\s*(\.?\d+(?:\.\d+)?)/.exec(note)
  if (withDf) {
    const p = withDf[4] ? 0 : Number(withDf[5])
    return {
      text: `${withDf[1]}(${withDf[2]}) = ${withDf[3]}, ${withDf[4] ? 'p < .001' : `p = ${fmtP(p)}`}`,
      p,
      significant: isSig(p)
    }
  }
  const dfAfter =
    /(?:^|[^A-Za-zχ])([A-Za-zχ][A-Za-zχ²]*)\s*=\s*(-?\d+(?:\.\d+)?)\s*,\s*df\s*=\s*(\d+)\s*,\s*p\s*=\s*(<)?\s*(\.?\d+(?:\.\d+)?)/.exec(note)
  if (dfAfter) {
    const p = dfAfter[4] ? 0 : Number(dfAfter[5])
    return {
      text: `${dfAfter[1]}(${dfAfter[3]}) = ${dfAfter[2]}, ${dfAfter[4] ? 'p < .001' : `p = ${fmtP(p)}`}`,
      p,
      significant: isSig(p)
    }
  }
  return null
}

// --- Assumption pills --------------------------------------------------------

export interface AssumptionPill {
  /** Check name, e.g. "Shapiro-Wilk". */
  label: string
  /** The engine's own wording, e.g. "p = .012". */
  detail: string
  /** The p value when the check reports one (null for statistic-only checks). */
  p: number | null
  /** True when p < .05, i.e. the assumption is violated. */
  violated: boolean
}

/**
 * The engine's assumption note as status pills (pure): "normality
 * (Shapiro-Wilk) p = .012" becomes a Shapiro-Wilk pill with p = .012.
 */
export function parseAssumptionPills(run: Run): AssumptionPill[] {
  const note = run.elements.find(
    (el) => el.kind === 'note' && el.address.includes('/note/assumptions')
  )
  if (!note || note.kind !== 'note') return []
  const body = note.text.replace(/^Assumption checks:\s*/i, '')
  const out: AssumptionPill[] = []
  for (const raw of body.split(';')) {
    const seg = raw.trim().replace(/\.$/, '')
    if (!seg) continue
    const m = /^(.*?)\(([^)]+)\)\s*(.*)$/.exec(seg)
    if (!m) continue
    const detail = (m[3] ?? '').trim()
    const pm = /p\s*=\s*(<)?\s*(\.?\d+(?:\.\d+)?)/.exec(detail)
    const p = pm ? (pm[1] ? 0 : Number(pm[2])) : null
    out.push({
      label: (m[2] ?? '').trim(),
      detail,
      p,
      violated: p !== null && p < 0.05
    })
  }
  return out
}
