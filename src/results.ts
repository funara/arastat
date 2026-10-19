// Result-tree run store (§8): one Run per analysis execution, elements
// keyed by address, patched in place from the analysis/update stream.
import { reactive } from 'vue'
import { isRecord } from './guard.ts'
import { state, showValueLabels } from './store.ts'
export type ElementStatus = 'ok' | 'stale' | 'error'

export interface ResultTable {
  address: string
  status: ElementStatus
  kind: 'table'
  caption: string
  columns: string[]
  rows: unknown[][]
  footnotes: string[]
}
export interface ResultNote {
  address: string
  status: ElementStatus
  kind: 'note'
  text: string
}
export interface ResultChart {
  address: string
  status: ElementStatus
  kind: 'chart'
  caption: string
  src?: string
  svg?: string
}
export interface ResultError {
  address: string
  status: 'error'
  kind: 'error'
  userMessage: string
  detail?: string
}
export type ResultElement = ResultTable | ResultNote | ResultChart | ResultError

export type RunStatus = 'loading' | 'done' | 'error' | 'cancelled'

export interface Run {
  runId: string
  analysisId: string
  title: string
  spec: Record<string, unknown>
  missingPolicy: string
  status: RunStatus
  elements: ResultElement[]
  lastSeq: number
  fresh: boolean
  createdAt: number
  startTime: number
  revealed: boolean
  datasetRev?: number
}


export const runsState = reactive<{ runs: Run[] }>({ runs: [] })

// Locked loading line state: "Running <analysis name>" holds the mockup's 1000 ms
// floor budget, then "Analysis complete" (announced via role=status) and the fresh
// block fades in at the same tick, matching the mockup's timed reveal exactly.
export const loadingState = reactive<{ active: boolean; text: string; runId: string }>({
  active: false,
  text: '',
  runId: ''
})

function scheduleReveal(run: Run): void {
  const wait = Math.max(0, 1000 - (Date.now() - run.startTime))
  window.setTimeout(() => {
    run.revealed = true
    run.fresh = true
    if (loadingState.runId !== run.runId) return
    if (run.status === 'done') {
      // Copy block's second phase: hold "Analysis complete" so the role=status
      // line announces it before the line hides (the mockup swapped and hid in
      // one tick, which rendered the named copy invisible).
      loadingState.text = 'Analysis complete'
      window.setTimeout(() => {
        if (loadingState.runId === run.runId) loadingState.active = false
      }, 400)
      return
    }
    loadingState.active = false
  }, wait)
}

let nextRun = 1
export function newRunId(): string {
  return `run${nextRun++}`
}

function asElement(raw: unknown): ResultElement | null {
  if (!isRecord(raw) || typeof raw['address'] !== 'string' || typeof raw['kind'] !== 'string') return null
  const address = raw['address'] as string
  if (raw['kind'] === 'table') {
    return {
      address, status: 'ok', kind: 'table',
      caption: typeof raw['caption'] === 'string' ? raw['caption'] : '',
      columns: Array.isArray(raw['columns']) ? (raw['columns'] as unknown[]).map(String) : [],
      rows: Array.isArray(raw['rows']) ? (raw['rows'] as unknown[][]) : [],
      footnotes: Array.isArray(raw['footnotes']) ? (raw['footnotes'] as unknown[]).map(String) : []
    }
  }
  if (raw['kind'] === 'note') {
    return { address, status: 'ok', kind: 'note', text: typeof raw['text'] === 'string' ? raw['text'] : '' }
  }
  if (raw['kind'] === 'chart') {
    return {
      address, status: 'ok', kind: 'chart',
      caption: typeof raw['caption'] === 'string' ? raw['caption'] : 'Chart',
      src: typeof raw['src'] === 'string' ? raw['src'] : undefined,
      svg: typeof raw['svg'] === 'string' ? raw['svg'] : undefined
    }
  }
  if (raw['kind'] === 'error') {
    return {
      address, status: 'error', kind: 'error',
      userMessage: typeof raw['userMessage'] === 'string' ? raw['userMessage'] : 'The analysis failed.',
      detail: typeof raw['detail'] === 'string' ? raw['detail'] : undefined
    }
  }
  return null
}

export function startRun(runId: string, analysisId: string, title: string, spec: Record<string, unknown>, missingPolicy: string): Run {
  const run: Run = {
    runId, analysisId, title, spec: { ...spec }, missingPolicy,
    status: 'loading', elements: [], lastSeq: 0, fresh: false, createdAt: Date.now(),
    startTime: Date.now(), revealed: false, datasetRev: state.rev
  }
  runsState.runs.push(run)
  loadingState.active = true
  loadingState.text = `Running ${title}`
  loadingState.runId = runId
  return run
}

export function findRun(runId: string): Run | undefined {
  return runsState.runs.find((r) => r.runId === runId)
}

/** Stale flags on rerun: old elements dim until fresh patches replace them. */
export function markStale(runId: string): void {
  const run = findRun(runId)
  if (!run) return
  run.status = 'loading'
  run.fresh = false
  run.startTime = Date.now()
  run.datasetRev = state.rev
  // A rerun reuses the runId but the engine restarts patch seq at 1: without
  // this reset every fresh patch would be dropped as stale (seq <= lastSeq).
  run.lastSeq = 0
  for (const el of run.elements) {
    if (el.kind !== 'error') el.status = 'stale'
  }
  loadingState.active = true
  loadingState.text = `Running ${run.title}`
  loadingState.runId = runId
}

/** Option edit: dim the latest settled result for the analysis until it is rerun. */
export function flagStale(analysisId: string, spec: Record<string, unknown>): void {
  const run = runsState.runs.findLast((r) => r.analysisId === analysisId && r.status !== 'loading')
  if (!run || JSON.stringify(run.spec) === JSON.stringify(spec)) return
  for (const el of run.elements) {
    if (el.kind !== 'error') el.status = 'stale'
  }
  run.fresh = false
}

/**
 * Display-only value labels (Phase 12): map coded stubs like `0` to
 * `Control (0)` using the dataset's `ColumnMeta.valueLabels`. Stored rows
 * stay raw so engine payloads and golden stats are untouched.
 */
export function displayTable(el: ResultTable, run: Run): ResultTable {
  const lab = (col: string | undefined, v: unknown): unknown => {
    if (!showValueLabels.value) return v
    if (col === undefined) return v
    const hit = state.ds.columns.find((c) => c.name === col)?.valueLabels?.[String(v)]
    return hit ? `${hit} (${String(v)})` : v
  }
  const col0 = (rows: unknown[][], col: string | undefined, extra?: string): unknown[][] =>
    rows.map((r) => r.map((v, ci) => {
      if (ci === 0) return lab(col, v)
      if (extra !== undefined && ci === 1) return lab(extra, v)
      return v
    }))
  const spec = run.spec
  const str = (k: string): string | undefined => (typeof spec[k] === 'string' ? (spec[k] as string) : undefined)
  let columns = el.columns
  let rows = el.rows
  if (run.analysisId === 'frequencies') {
    const vars = Array.isArray(spec['variables']) ? (spec['variables'] as unknown[]).map(String) : []
    const name = vars[(Number(/\/table\/(\d+)$/.exec(el.address)?.[1]) || 1) - 1]
    if (name) rows = col0(rows, name)
  } else if (run.analysisId === 'chisq_gof') {
    const name = str('variable')
    if (name) rows = col0(rows, name)
  } else if (run.analysisId === 'chisq_independence') {
    const row = str('row')
    const col = str('col')
    if (row) rows = rows.map((r) => r.map((v, ci) => (ci === 0 ? lab(row, v) : v)))
    if (col) columns = columns.map((c, i) => (i === 0 ? c : String(lab(col, c) ?? c)))
  } else {
    const group = str('group') ?? str('factor')
    if (group && el.columns[0] === 'Group') rows = col0(rows, group)
    else if (group && el.columns[0] === 'Group 1' && el.columns[1] === 'Group 2') {
      rows = col0(rows, group, group)
    }
  }
  if (rows === el.rows && columns === el.columns) return el
  return { ...el, columns, rows }
}

/** Local failure (invoke rejection): an error element when the run has none. */
export function failRun(runId: string, userMessage: string): void {
  const run = findRun(runId)
  if (!run) return
  run.status = 'error'
  if (!run.elements.some((el) => el.kind === 'error')) {
    run.elements.push({ address: `${runId}/error/1`, status: 'error', kind: 'error', userMessage })
  }
  scheduleReveal(run)
}

/** Route one engine notification (analysis/update | analysis/done) into the tree. */
export function applyNotification(note: { method: string; params: unknown }): void {
  if (!isRecord(note.params) || typeof note.params['runId'] !== 'string') return
  const run = findRun(note.params['runId'] as string)
  if (!run) return
  if (note.method === 'analysis/update') {
    const seq = note.params['seq']
    if (typeof seq === 'number') {
      if (seq <= run.lastSeq) return
      run.lastSeq = seq
    }
    const patches = note.params['patches']
    if (!Array.isArray(patches)) return
    for (const raw of patches) {
      if (!isRecord(raw) || typeof raw['address'] !== 'string') continue
      const address = raw['address'] as string
      if (raw['op'] === 'remove') {
        run.elements = run.elements.filter((el) => el.address !== address)
        continue
      }
      if (raw['op'] !== 'upsert') continue
      const el = asElement(raw['element'])
      if (!el) continue
      const i = run.elements.findIndex((e) => e.address === address)
      if (i >= 0) run.elements[i] = el
      else run.elements.push(el)
    }
  } else if (note.method === 'analysis/done') {
    const status = note.params['status']
    run.status = status === 'complete' ? 'done' : status === 'cancelled' ? 'cancelled' : 'error'
    scheduleReveal(run)
  }
}

/**
 * Pin a rendered chart as its own result card (Visualize dialog → results pane).
 * Goes straight onto the run list: `startRun` would also take over the global
 * loading line and clobber an engine run that is still streaming.
 */
export function pinChartElement(caption: string, svg: string): string {
  const runId = newRunId()
  runsState.runs.push({
    runId,
    analysisId: 'visualize',
    title: caption,
    spec: {},
    missingPolicy: '',
    status: 'done',
    elements: [{ address: `${runId}/chart/1`, status: 'ok', kind: 'chart', caption, svg }],
    lastSeq: 0,
    fresh: true,
    createdAt: Date.now(),
    startTime: Date.now(),
    revealed: true,
    datasetRev: state.rev
  })
  return runId
}

/** Serializable snapshot for the project archive (opaque result tree slot). */
export function snapshotRuns(): unknown {
  return {
    runs: runsState.runs.map((r) => ({
      runId: r.runId, analysisId: r.analysisId, title: r.title,
      spec: r.spec, missingPolicy: r.missingPolicy, status: r.status,
      elements: r.elements, datasetRev: r.datasetRev
    }))
  }
}

/** Restore archived runs (elements render read-only; reruns start fresh ids). */
export function restoreRuns(raw: unknown): void {
  if (!isRecord(raw) || !Array.isArray(raw['runs'])) return
  const seen = new Set(runsState.runs.map((r) => r.runId))
  for (const item of raw['runs'] as unknown[]) {
    if (!isRecord(item) || typeof item['runId'] !== 'string') continue
    if (seen.has(item['runId'] as string)) continue
    const elements = Array.isArray(item['elements'])
      ? (item['elements'] as unknown[]).map(asElement).filter((e): e is ResultElement => e !== null)
      : []
    runsState.runs.push({
      runId: item['runId'] as string,
      analysisId: typeof item['analysisId'] === 'string' ? item['analysisId'] : '',
      title: typeof item['title'] === 'string' ? item['title'] : 'Analysis',
      spec: isRecord(item['spec']) ? (item['spec'] as Record<string, unknown>) : {},
      missingPolicy: typeof item['missingPolicy'] === 'string' ? item['missingPolicy'] : 'listwise',
      status: item['status'] === 'done' ? 'done' : 'error',
      elements, lastSeq: 0, fresh: false, createdAt: Date.now(),
      startTime: Date.now(), revealed: true, datasetRev: state.rev
    })
    const m = /^run(\d+)$/.exec(item['runId'] as string)
    if (m) nextRun = Math.max(nextRun, Number(m[1]) + 1)
  }
}
