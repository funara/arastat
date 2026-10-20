// Engine run path: builds the columnar payload from the dataset store and
// sends run_analysis over the §4 seam. Menu dialogs and AI proposal cards
// share this ONE path (arch §9: no second code path).
import { state, isUserMissing } from './store.ts'
import { startRun, findRun, markStale, failRun, newRunId, type RunChart } from './results.ts'
import { schemaById } from './specs.ts'
import { isRecord } from './guard.ts'

/** Variable names this spec reads (string and string-list values). */
function referencedColumns(spec: Record<string, unknown>): string[] {
  const names: string[] = []
  for (const val of Object.values(spec)) {
    if (typeof val === 'string' && val) names.push(val)
    else if (Array.isArray(val)) for (const v of val) if (typeof v === 'string' && v) names.push(v)
  }
  return [...new Set(names)]
}

/** Columnar payload: user-missing and empty cells collapse to one null (§6). */
function buildData(spec: Record<string, unknown>): Record<string, Array<number | string | null>> {
  const data: Record<string, Array<number | string | null>> = {}
  for (const name of referencedColumns(spec)) {
    const meta = state.ds.columns.find((c) => c.name === name)
    const raw = state.ds.data[name] ?? []
    data[name] = raw.map((v) => (meta && isUserMissing(meta, v as number | string | null) ? null : (v as number | string | null)))
  }
  return data
}

function errMessage(err: unknown): string {
  // Every engine failure arrives with a verbatim `userMessage`; prefer it so the
  // results pane and HTML export store clean copy.
  if (isRecord(err) && isRecord(err['data']) && typeof err['data']['userMessage'] === 'string') {
    return err['data']['userMessage'] as string
  }
  if (err instanceof Error && /engine not running/i.test(err.message)) {
    return 'The statistics engine is not running. Restart the app and run again.'
  }
  if (err instanceof Error && err.message) return err.message
  return 'The analysis could not run. Check the data and options, then run again.'
}

export interface RunOptions {
  missingPolicy?: string
  runId?: string
  chart?: RunChart
}

/** Run one analysis; returns the runId. Never throws: failures land as error elements. */
export async function runAnalysis(analysisId: string, spec: Record<string, unknown>, opts: RunOptions = {}): Promise<string> {
  const schema = schemaById(analysisId)
  const title = schema?.title ?? analysisId
  const missingPolicy = opts.missingPolicy ?? schema?.missingDefault ?? 'listwise'
  const runId = opts.runId ?? newRunId()
  // Callers pass reactive form/proposal state; the IPC invoke structured-clones
  // and rejects Proxies ("An object could not be cloned"). Plain-ify once at this
  // shared ingest so every run path crosses IPC safely. opts.chart rides through
  // the reactive chat messages and needs the same treatment. A failure to
  // plain-ify lands as an error element below, never a throw.
  let plainSpec = spec
  let plainChart: RunChart | undefined = opts.chart ?? undefined
  try {
    plainSpec = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>
    plainChart = opts.chart
      ? (JSON.parse(JSON.stringify(opts.chart)) as RunChart)
      : undefined
  } catch {
    // Keep the originals; the invoke below reports the failure.
  }
  if (findRun(runId)) markStale(runId, plainChart)
  else startRun(runId, analysisId, title, plainSpec, missingPolicy, plainChart)
  try {
    const caps = (await window.ara.engine.invoke('capabilities')) as unknown
    const analyses = isRecord(caps) && Array.isArray(caps['analyses']) ? (caps['analyses'] as unknown[]) : []
    if (!analyses.length) {
      failRun(runId, 'The statistics engine reported no analyses. Restart the app and run again.')
      return runId
    }
    if (!analyses.includes(analysisId)) {
      failRun(runId, `No analysis named ${analysisId} is available in this build.`)
      return runId
    }
    // A chart may read columns outside the analysis spec: send those too so the
    // engine's renderer can see them.
    const data = buildData(plainSpec)
    if (plainChart) {
      for (const name of [plainChart.x, plainChart.y, plainChart.group]) {
        if (typeof name === 'string' && name && data[name] === undefined) {
          const meta = state.ds.columns.find((c) => c.name === name)
          const raw = state.ds.data[name] ?? []
          data[name] = raw.map((v) => (meta && isUserMissing(meta, v as number | string | null) ? null : (v as number | string | null)))
        }
      }
    }
    const engineChart = plainChart
      ? { ...plainChart, type: plainChart.type === 'histogram' ? 'hist' : plainChart.type }
      : undefined
    await window.ara.engine.invoke('run_analysis', {
      runId, analysisId, spec: plainSpec, data, missingPolicy,
      ...(engineChart ? { chart: engineChart } : {})
    })
  } catch (err) {
    failRun(runId, errMessage(err))
  }
  return runId
}
