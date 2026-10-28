import { shallowRef } from 'vue'
import { specSummary } from './specs.ts'
import type { Run } from './results.ts'

/** Build the exact user message shown for approval before a result explanation. */
export function explanationPrompt(run: Run): string {
  const tables = run.elements
    .filter((element) => element.kind === 'table')
    .map((table) => {
      const rows = run.analysisId === 'frequencies'
        ? table.rows.map((row, index) => [`Category ${index + 1}`, ...row.slice(1)])
        : table.rows
      return `${table.caption}: ${table.columns.join(' | ')}\nRows: ${rows.map((row) => row.join(' | ')).join('\n')}`
    })
    .join('\n\n')
  const notice = run.analysisId === 'frequencies' ? '\nFrequency category values have been replaced with generic category labels.' : ''
  return `Please provide a concise, publication-grade statistical narrative interpretation for this ${run.title} analysis output:\n${tables}${notice}\nSpec: ${specSummary(run.spec)}`
}

export function createSessionGuard() {
  let generation = 0
  return {
    snapshot: () => generation,
    isCurrent: (token: number) => token === generation,
    invalidate: () => { generation++ }
  }
}

/** Consume approval before calling the provider so cancellation and repeated clicks send nothing. */
export function createExplanationGate(send: (request: { run: Run; prompt: string }) => Promise<void>) {
  const pending = shallowRef<{ run: Run; prompt: string } | null>(null)
  return {
    pending,
    show(run: Run) { pending.value = { run, prompt: explanationPrompt(run) } },
    cancel() { pending.value = null },
    async approve() {
      const request = pending.value
      if (!request) return
      pending.value = null
      await send(request)
    }
  }
}
