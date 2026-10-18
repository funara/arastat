import { isRecord } from '../renderer/src/guard.ts'

// Shared AI response schema/normalizer: the ONE path every AI caller routes
// through (root-cause fix - per-caller parsing drifts, so it lives here).
// Pure (no node imports): main and renderer both import it. Never throws:
// unparseable or empty replies get a deterministic advisory fallback.
export interface AiProposal {
  analysis: string
  variables: string[]
  options: Record<string, unknown>
  computedColumns?: string[]
}

/** First JSON object in text containing the given key (fenced block preferred). */
export interface AiChartSpec {
  type: string
  x?: string
  y?: string
  group?: string
  title?: string
}
export interface NormalizedAi {
  /** Clean narrative with embedded JSON/thinking blocks removed. */
  narrative: string
  thinking?: string
  proposal: AiProposal | null
  chart: AiChartSpec | null
  /** True when narrative is the deterministic fallback (provider said nothing usable). */
  fallback: boolean
}

const FALLBACK_NARRATIVE =
  'The AI service returned no usable content. Every analysis in the Analyze menu still runs fully offline - pick one for the current rows and columns.'

/** Spoken narrative for a reply that carried a chart spec but no prose: the
 *  card would otherwise sit under the "no usable content" fallback. A chart is
 *  only drawn when it rides on a proposal's Run Test, so the copy says
 *  "suggested", never "ready". */
const CHART_NARRATIVE = 'Chart suggested: '

/** First JSON object in text containing the given key (fenced block preferred). */
function extractJsonWithKey(text: string, key: string): Record<string, unknown> | null {
  const candidates: string[] = []
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi
  let f: RegExpExecArray | null
  while ((f = fence.exec(text)) !== null) candidates.push(f[1].trim())
  const greedy = /\{[\s\S]*\}/.exec(text)
  if (greedy) candidates.push(greedy[0])
  const raw = /\{[\s\S]*?\}/g
  let m: RegExpExecArray | null
  while ((m = raw.exec(text)) !== null) candidates.push(m[0])
  for (const candidate of candidates) {
    if (!candidate.startsWith('{')) continue
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (isRecord(parsed) && key in parsed) return parsed
    } catch {
      // not JSON - keep scanning
    }
  }
  return null
}

function cleanNarrative(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?\s*\{[\s\S]*?\}\s*```/gi, '')
    .replace(/^(?:Great question!|Certainly!|Sure thing!|Of course!|Sure!|Hello!|Hi!)\s*/i, '')
    .replace(/```(?:json)?\s*```/gi, '')
    .trim()
}

/** Normalize one raw model reply into the shared schema. Never throws. */
export function normalizeAiResponse(raw: unknown): NormalizedAi {
  const text = typeof raw === 'string' ? raw : ''
  let thinking: string | undefined
  const thinkMatch = /<think>([\s\S]*?)<\/think>/i.exec(text)
  if (thinkMatch) thinking = thinkMatch[1].trim() || undefined

  let proposal: AiProposal | null = null
  const found = extractJsonWithKey(text, 'analysis')
  if (found && typeof found['analysis'] === 'string') {
    const variables = Array.isArray(found['variables'])
      ? (found['variables'] as unknown[]).filter((v): v is string => typeof v === 'string')
      : []
    const options = isRecord(found['options']) ? (found['options'] as Record<string, unknown>) : {}
    const computedColumns = Array.isArray(found['computedColumns'])
      ? (found['computedColumns'] as unknown[]).filter((v): v is string => typeof v === 'string')
      : undefined
    proposal = {
      analysis: (found['analysis'] as string).toLowerCase().trim().replace(/[- ]/g, '_'),
      variables,
      options,
      ...(computedColumns ? { computedColumns } : {})
    }
  }

  let chart: AiChartSpec | null = null
  const chartFound = extractJsonWithKey(text, 'chart') ?? extractJsonWithKey(text, 'visualization')
  let chartRaw = chartFound ? (chartFound['chart'] ?? chartFound['visualization']) : undefined
  if (!isRecord(chartRaw)) {
    // Also check if a root JSON object itself has type + x (e.g. {"type": "bar", "x": "..."})
    const typeFound = extractJsonWithKey(text, 'type')
    if (typeFound && typeof typeFound['type'] === 'string' && (typeFound['x'] || typeFound['y'])) {
      chartRaw = typeFound
    }
  }
  if (isRecord(chartRaw) && typeof chartRaw['type'] === 'string') {
    const rawType = (chartRaw['type'] as string).toLowerCase().trim()
    const normType = rawType === 'hist' ? 'histogram' : rawType === 'scatterplot' ? 'scatter' : rawType === 'barchart' ? 'bar' : rawType === 'linechart' ? 'line' : rawType
    chart = {
      type: normType,
      ...(typeof chartRaw['x'] === 'string' ? { x: chartRaw['x'] } : {}),
      ...(typeof chartRaw['y'] === 'string' ? { y: chartRaw['y'] } : {}),
      ...(typeof chartRaw['group'] === 'string' ? { group: chartRaw['group'] } : {}),
      ...(typeof chartRaw['title'] === 'string' ? { title: chartRaw['title'] } : {})
    }
  }

  const narrative = cleanNarrative(text)
  if (narrative) return { narrative, thinking, proposal, chart, fallback: false }
  // Structured reply with no prose (a JSON-only answer): narrate the spec the
  // normalizer actually parsed instead of claiming the model said nothing.
  if (proposal) {
    return { narrative: `${proposal.analysis.replace(/_/g, ' ')} - variables: ${proposal.variables.join(', ') || 'none'}`, thinking, proposal, chart, fallback: false }
  }
  if (chart) {
    return { narrative: CHART_NARRATIVE + (chart.y ? `${chart.y} vs ${chart.x}` : chart.x), thinking, proposal, chart, fallback: false }
  }
  return { narrative: FALLBACK_NARRATIVE, thinking, proposal, chart, fallback: true }
}

/** Deterministic advisory fallback for provider errors (never rejects its caller). */
export function fallbackAdvice(what: string): string {
  return (
    `The AI service is temporarily unavailable, so here is the offline rule for ${what}: ` +
    'with no missing values keep listwise handling; with a few incomplete rows drop them; ' +
    'with widespread missingness fill numeric columns (mean/median) or categorical columns (mode) from the Transform menu, then rerun.'
  )
}
