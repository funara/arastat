// Chart building for the Visualize dialog: pure, deterministic and unit
// testable. The dialog owns the Plotly surface; everything about *what* to
// draw - which columns, which rows survive the missing rules, which traces,
// which trendline - lives here so it can be reasoned about (and tested)
// without a DOM.
import type { ColumnMeta, ColumnValues } from './io/types.ts'

export type VizType = 'scatter' | 'bar' | 'line' | 'histogram' | 'boxplot'

/** Everything needed to rebuild a chart later (pinned with the chart). */
export interface VizSpec {
  type: VizType
  x: string
  y: string
  group: string
  trendline: boolean
}

/** A raw cell: number, string or null. */
type Cell = number | string | null

/** Theme colors, read from the CSS custom properties by the dialog. */
export interface VizTheme {
  primary: string
  border: string
  text: string
  muted: string
  grid: string
  surface: string
  palette: string[]
}

/** Everything the chart builder needs, gathered by the dialog. */
export interface VizInput {
  type: VizType
  x: string
  y: string
  group: string
  trendline: boolean
  columns: ColumnMeta[]
  data: Record<string, ColumnValues>
  showValueLabels: boolean
  theme: VizTheme
}

export interface VizOutput {
  traces: Record<string, unknown>[]
  yTitle: string
  title: string
}

/** A cell counts as missing when it is blank or the column's own sentinel. */
export function isMissingCell(meta: ColumnMeta | undefined, v: Cell): boolean {
  if (v === null || v === '') return true
  if (!meta) return false
  if (meta.missing.values.some((x) => x === v)) return true
  return typeof v === 'number' && meta.missing.ranges.some(([lo, hi]) => v >= lo && v <= hi)
}

interface ChartRows {
  x: Cell[]
  y: Cell[]
  g: Cell[]
}

/**
 * The one missing-aware reader every chart uses: a row survives only when
 * every column it needs holds a non-missing value (pairwise), so sentinel
 * codes such as 999 or -99 never reach a histogram, boxplot or bar mean.
 */
export function cleanRows(
  xName: string,
  yName: string,
  gName: string,
  columns: ColumnMeta[],
  data: Record<string, ColumnValues>
): ChartRows {
  const metaOf = (name: string): ColumnMeta | undefined =>
    name ? columns.find((c) => c.name === name) : undefined
  const mx = metaOf(xName)
  const my = metaOf(yName)
  const mg = metaOf(gName)
  const rx = ((data[xName] ?? []) as Cell[])
  const ry = yName ? ((data[yName] ?? []) as Cell[]) : []
  const rg = gName ? ((data[gName] ?? []) as Cell[]) : []
  const len = Math.max(rx.length, ry.length, rg.length)
  const rows: ChartRows = { x: [], y: [], g: [] }
  for (let i = 0; i < len; i++) {
    const xv = rx[i] ?? null
    if (isMissingCell(mx, xv)) continue
    const yv = yName ? (ry[i] ?? null) : null
    if (yName && isMissingCell(my, yv)) continue
    const gv = gName ? (rg[i] ?? null) : null
    if (gName && isMissingCell(mg, gv)) continue
    rows.x.push(xv)
    rows.y.push(yv)
    rows.g.push(gv)
  }
  return rows
}

/** Distinct values of a column slice, in first-appearance order. */
export function levelsOf(values: Cell[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    const key = String(v)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

/** Ordinary least squares fit of y on x (null when it cannot be computed). */
export function olsTrend(xs: number[], ys: number[]): { slope: number; intercept: number } | null {
  const n = xs.length
  if (n < 2) return null
  let sx = 0
  let sy = 0
  for (let i = 0; i < n; i++) {
    sx += xs[i] as number
    sy += ys[i] as number
  }
  const mx = sx / n
  const my = sy / n
  let numr = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] as number) - mx
    numr += dx * ((ys[i] as number) - my)
    den += dx * dx
  }
  if (den === 0) return null
  const slope = numr / den
  return { slope, intercept: my - slope * mx }
}

function num(v: Cell): number {
  return typeof v === 'number' ? v : Number(v)
}

/** The caption a pinned chart carries. */
export function captionFor(spec: Pick<VizSpec, 'type' | 'x' | 'y' | 'group'>): string {
  const t = spec.type
  if (t === 'histogram') return `Histogram of ${spec.x}`
  if (t === 'boxplot') {
    return spec.x ? `Boxplot of ${spec.y} by ${spec.x}` : `Boxplot of ${spec.y}`
  }
  if (t === 'bar') {
    return spec.group
      ? `Mean ${spec.y} by ${spec.x} and ${spec.group}`
      : `Mean ${spec.y} by ${spec.x}`
  }
  if (t === 'line') return `Line chart: ${spec.y} over ${spec.x}`
  return `Scatter plot: ${spec.y} vs ${spec.x}`
}

/**
 * The traces for the current chart (pure). Grouping splits the chart into one
 * trace per level; the scatter carries an optional OLS trendline.
 */
export function buildTraces(input: VizInput): VizOutput {
  const { type, x: xName, y: yName, group: groupName, trendline: wantTrend, theme } = input
  const rows = cleanRows(xName, yName, groupName, input.columns, input.data)
  const metaOf = (name: string): ColumnMeta | undefined =>
    name ? input.columns.find((c) => c.name === name) : undefined

  if (type === 'histogram') {
    const vals = rows.x.map(num).filter((v) => Number.isFinite(v))
    return {
      traces: [
        {
          x: vals,
          type: 'histogram',
          name: xName,
          marker: { color: theme.primary, opacity: 0.8, line: { width: 1, color: theme.border } },
          hovertemplate: '<b>Range</b>: %{x}<br><b>Count</b>: %{y}<extra></extra>'
        }
      ],
      yTitle: 'Frequency',
      title: `Distribution of ${xName}`
    }
  }

  if (type === 'boxplot') {
    // The boxplot's X is the optional group; Y holds the measured value.
    const levels = xName ? levelsOf(rows.x) : ['']
    const traces = levels.map((lv, i) => {
      const vals = rows.y
        .filter((_, idx) => (xName ? String(rows.x[idx]) === lv : true))
        .map(num)
        .filter((v) => Number.isFinite(v))
      return {
        y: vals,
        type: 'box',
        name: lv || yName,
        boxmean: true,
        boxpoints: false,
        marker: { color: theme.palette[i % theme.palette.length] },
        line: { color: theme.border, width: 1.5 },
        hovertemplate: `<b>${lv || yName}</b>: %{y}<extra></extra>`
      }
    })
    return {
      traces,
      yTitle: yName || 'Value',
      title: xName ? `Distribution of ${yName} by ${xName}` : `Distribution of ${yName}`
    }
  }

  const levels = groupName ? levelsOf(rows.g) : ['']
  const traces: Record<string, unknown>[] = []

  if (type === 'bar') {
    // Categorical X + numeric Y aggregates to the group mean.
    const labels = metaOf(xName)?.valueLabels
    levels.forEach((lv, gi) => {
      const cats: string[] = []
      const means: number[] = []
      const buckets = new Map<string, number[]>()
      rows.x.forEach((xv, idx) => {
        if (groupName && String(rows.g[idx]) !== lv) return
        const cat = String(xv ?? '').trim()
        if (!cat || cat === 'null' || cat === 'undefined') return
        const vy = num(rows.y[idx] as Cell)
        if (!Number.isFinite(vy)) return
        if (!buckets.has(cat)) buckets.set(cat, [])
        buckets.get(cat)!.push(vy)
      })
      for (const [cat, vals] of buckets) {
        const hit = input.showValueLabels ? labels?.[cat] : undefined
        cats.push(hit ? `${hit} (${cat})` : cat)
        means.push(Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100)
      }
      traces.push({
        x: cats,
        y: means,
        type: 'bar',
        name: groupName ? lv : `Mean ${yName}`,
        marker: {
          color: groupName ? theme.palette[gi % theme.palette.length] : theme.primary,
          opacity: 0.85,
          line: { width: 1, color: theme.border }
        },
        hovertemplate: `<b>%{x}</b><br>Mean ${yName}: %{y}<extra></extra>`
      })
    })
    return {
      traces,
      yTitle: `Mean ${yName}`,
      title: groupName ? `Mean ${yName} by ${xName} and ${groupName}` : `Mean ${yName} by ${xName}`
    }
  }

  // scatter / line: pairwise numeric extraction; line sorts by X for a clean path.
  levels.forEach((lv, gi) => {
    const pts: Array<{ x: number; y: number }> = []
    rows.x.forEach((xv, idx) => {
      if (groupName && String(rows.g[idx]) !== lv) return
      const vx = num(xv)
      const vy = num(rows.y[idx] as Cell)
      if (Number.isFinite(vx) && Number.isFinite(vy)) pts.push({ x: vx, y: vy })
    })
    const color = theme.palette[gi % theme.palette.length]
    if (type === 'line') {
      pts.sort((a, b) => a.x - b.x)
      traces.push({
        x: pts.map((p) => p.x),
        y: pts.map((p) => p.y),
        type: 'scatter',
        mode: 'lines+markers',
        name: groupName ? lv : `${yName} by ${xName}`,
        line: { color, width: 2 },
        marker: { size: 5, color },
        hovertemplate: `<b>${xName}</b>: %{x}<br><b>${yName}</b>: %{y}<extra></extra>`
      })
      return
    }
    traces.push({
      x: pts.map((p) => p.x),
      y: pts.map((p) => p.y),
      type: 'scatter',
      mode: 'markers',
      name: groupName ? lv : `${yName} vs ${xName}`,
      marker: { size: 8, color, opacity: 0.8, line: { width: 1, color: theme.border } },
      hovertemplate: `<b>${xName}</b>: %{x}<br><b>${yName}</b>: %{y}<extra></extra>`
    })
    if (wantTrend) {
      const fit = olsTrend(pts.map((p) => p.x), pts.map((p) => p.y))
      if (fit) {
        const xs = pts.map((p) => p.x)
        const lo = Math.min(...xs)
        const hi = Math.max(...xs)
        traces.push({
          x: [lo, hi],
          y: [fit.intercept + fit.slope * lo, fit.intercept + fit.slope * hi],
          type: 'scatter',
          mode: 'lines',
          name: groupName ? `OLS trend · ${lv}` : 'OLS trend',
          line: { color: theme.muted, width: 1.5, dash: 'dash' },
          hoverinfo: 'skip'
        })
      }
    }
  })
  return {
    traces,
    yTitle: yName || 'Value',
    title: type === 'line' ? `${yName} over ${xName}` : `Scatter: ${yName} vs ${xName}`
  }
}
