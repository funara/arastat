<script setup lang="ts">
// ARA Assistant Copilot (§9): Connected AI for statistical analysis and result interpretation.
// Parity with ARA Office Copilot: thinking steps, process cards, confirm gate,
// two-way results explanation, and collapsible rail sidebar.
// Single unified model with backend fallback.
import { ref, nextTick, watch } from 'vue'
import { state, addColumn } from './store.ts'
import { schemaById, specSummary } from './specs.ts'
import { runAnalysis } from './runAnalysis.ts'
import { isRecord } from './guard.ts'
import { normalizeAiResponse } from './aiResponse.ts'
import { type Run } from './results.ts'
import { defaultMeta } from './io/types.ts'
import { splitLeadingBullet, splitTrailingProse } from './aiText.ts'

const open = ref(true)

const emit = defineEmits<{
  (e: 'edit-options', payload: { analysis: string; options: Record<string, unknown> }): void
  (e: 'toast', msg: string): void
  (e: 'open-settings'): void
  (e: 'visualize', payload: { type: 'scatter' | 'bar' | 'histogram' | 'line'; x?: string; y?: string }): void
  (e: 'status-change', status: 'ready' | 'busy' | 'error'): void
  (e: 'open-change', open: boolean): void
}>()
// Mirror open state to App so the splitter wall follows dock/rail in real time.
watch(open, (o) => emit('open-change', o))

interface Proposal {
  analysis: string
  variables: string[]
  options: Record<string, unknown>
  computedColumns?: string[]
}

interface ChatEntry {
  id: number
  who: 'user' | 'bot'
  text: string
  thinking?: string
  proposal?: Proposal
  chart?: { type: string; x?: string; y?: string; group?: string; title?: string }
  narrativeTargetRunId?: string
  narrativeNote?: string
  narrativeInserted?: boolean
  error?: boolean
}

interface PendingMutation {
  columns: number
  apply: () => void
  messageId: number
}

const INITIAL_GREETING = "Hello! I'm ARA Assistant, your statistical copilot. Ask me anything about your data, tests, or results."

const messages = ref<ChatEntry[]>([
  {
    id: 0,
    who: 'bot',
    text: INITIAL_GREETING
  }
])
const draft = ref('')
const busy = ref(false)
const pending = ref<PendingMutation | null>(null)
const scrollEl = ref<HTMLElement | null>(null)
let nextId = 1

function clear(): void {
  messages.value = [
    {
      id: 0,
      who: 'bot',
      text: INITIAL_GREETING
    }
  ]
  pending.value = null
  nextId = 1
}

function copyMessage(text: string): void {
  void navigator.clipboard.writeText(text).then(() => {
    emit('toast', 'Copied to clipboard')
  })
}

function scrollDown(): void {
  void nextTick(() => {
    scrollEl.value?.scrollTo({ top: scrollEl.value.scrollHeight, behavior: 'smooth' })
  })
}

function errText(err: unknown): string {
  const raw = isRecord(err) && typeof err['message'] === 'string' && err['message']
    ? (err['message'] as string)
    : err instanceof Error && err.message ? err.message : ''
  return raw || 'The AI service is temporarily unavailable. Try again.'
}

function handleAiError(err: unknown): void {
  const message = errText(err)
  messages.value.push({ id: nextId++, who: 'bot', text: message, error: true })
}

/** Supported analysis aliases for model robustness */
const ANALYSIS_ALIASES: Record<string, string> = {
  multiple_regression: 'linear_regression',
  multivariate_regression: 'linear_regression',
  regression: 'linear_regression',
  ols: 'linear_regression',
  ttest: 'ttest_independent',
  independent_ttest: 'ttest_independent',
  independent_samples_ttest: 'ttest_independent',
  paired_ttest: 'ttest_paired',
  one_sample_ttest: 'ttest_onesample',
  anova: 'anova_oneway',
  pearson: 'correlation',
  pearsons: 'correlation',
  chi_square: 'chisq_independence',
  chisq: 'chisq_independence',
  mann_whitney: 'mannwhitney_u',
  mannwhitney: 'mannwhitney_u',
  wilcoxon: 'wilcoxon_signedrank',
  kruskal: 'kruskal_wallis'
}

/** Robust proposal parse handling both code blocks and inline JSON */
function parseProposal(text: string): Proposal | null {
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  let candidate = fenceMatch ? fenceMatch[1].trim() : ''
  if (!candidate.startsWith('{')) {
    const rawMatch = /\{[\s\S]*?"analysis"[\s\S]*?\}/i.exec(text)
    if (!rawMatch) return null
    candidate = rawMatch[0].trim()
  }

  const found = normalizeAiResponse(text)
  const norm = found.proposal
  if (!norm) return null

  try {
    const rawId = norm.analysis
    const mappedId = ANALYSIS_ALIASES[rawId] ?? rawId
    const schema = schemaById(mappedId)
    if (!schema) return null

    const rawOptions = norm.options
    const variables = norm.variables
    // (variables + options come from the shared normalizer above)

    // Normalize option keys to match schema
    const options: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(rawOptions)) {
      const lk = k.toLowerCase().replace(/[-_ ]/g, '')
      if (lk === 'dep' || lk === 'dependent' || lk === 'dependentvariable' || lk === 'target' || lk === 'dv' || lk === 'outcome') {
        options['dep'] = val
      } else if (lk === 'predictors' || lk === 'predictor' || lk === 'independent' || lk === 'iv' || lk === 'covariates') {
        if (schema.options.some((o) => o.key === 'predictors')) {
          options['predictors'] = Array.isArray(val) ? val : [val]
        } else if (schema.options.some((o) => o.key === 'factor')) {
          options['factor'] = Array.isArray(val) ? val[0] : val
        } else if (schema.options.some((o) => o.key === 'group')) {
          options['group'] = Array.isArray(val) ? val[0] : val
        }
      } else if (lk === 'group' || lk === 'grouping' || lk === 'groupvariable') {
        options['group'] = val
      } else if (lk === 'factor' || lk === 'factorvariable') {
        options['factor'] = val
      } else if (lk === 'vars' || lk === 'variables') {
        options['variables'] = val
      } else {
        options[k] = val
      }
    }

    // Auto-fill missing required options from variables array
    if (!options['dep'] && schema.options.some((o) => o.key === 'dep') && variables.length > 0) {
      options['dep'] = variables[0]
    }
    if (!options['predictors'] && schema.options.some((o) => o.key === 'predictors') && variables.length > 1) {
      options['predictors'] = variables.slice(1)
    }
    if (!options['group'] && schema.options.some((o) => o.key === 'group') && variables.length > 1) {
      options['group'] = variables[1]
    }
    if (!options['factor'] && schema.options.some((o) => o.key === 'factor') && variables.length > 1) {
      options['factor'] = variables[1]
    }
    if (!options['variables'] && schema.options.some((o) => o.key === 'variables') && variables.length > 0) {
      options['variables'] = variables
    }

    // Populate defaults for options that are still missing
    for (const opt of schema.options) {
      if (options[opt.key] === undefined && opt.default !== undefined) {
        options[opt.key] = opt.default
      }
    }

    const computedColumns = norm.computedColumns ?? []

    return { analysis: mappedId, variables, options, computedColumns }
  } catch {
    return null
  }
}

/** Sanitize and format markdown into styled HTML */
function formatMarkdown(text: string): string {
  if (!text) return ''
  // 0. Detach a first bullet jammed onto its intro line ("...tests: - **Compare...")
  // so the intro stays a paragraph and the point joins its list. Raw markdown:
  // HTML tags inserted later must never be split.
  const expanded = text.split(/\r?\n/).flatMap((l) => splitLeadingBullet(l)).join('\n')
  // 1. Basic HTML escaping
  let s = expanded
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  // 2. Fenced code blocks ```...```
  s = s.replace(/```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/g, (_m, code) => {
    return `<pre class="ai-code-block"><code>${code.trim()}</code></pre>`
  })

  // 3. Inline code `...`
  s = s.replace(/`([^`\n]+)`/g, '<code class="ai-inline-code">$1</code>')

  // 4. Bold **text**
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')

  // 5. Italic *text*
  s = s.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>')

  // 6. Block elements (headers, lists, tables, dividers, paragraphs)
  const rawLines = s.split(/\r?\n/)
  const lines: string[] = []
  for (const l of rawLines) {
    const trimmed = l.trim()
    if (/^---\s*#{1,6}\s+/.test(trimmed)) {
      lines.push(trimmed.replace(/^---\s*/, ''))
    } else {
      lines.push(l)
    }
  }

  const res: string[] = []
  let inUl = false
  let inOl = false
  let inTable = false
  let tableHeaderDone = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    // Table rows: | Col1 | Col2 |
    const isTableRow = trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 2
    const isTableSep = isTableRow && /^\|(?:\s*:?-+:?\s*\|)+$/.test(trimmed)

    if (isTableRow) {
      if (inUl) { res.push('</ul>'); inUl = false }
      if (inOl) { res.push('</ol>'); inOl = false }
      if (isTableSep) {
        tableHeaderDone = true
        continue
      }
      const cells = trimmed
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim())

      if (!inTable) {
        inTable = true
        tableHeaderDone = false
        res.push('<div class="ai-table-wrap"><table class="ai-table">')
        res.push('<thead><tr>' + cells.map((c) => `<th>${c}</th>`).join('') + '</tr></thead>')
        res.push('<tbody>')
        continue
      } else {
        if (!tableHeaderDone) {
          res.push('<thead><tr>' + cells.map((c) => `<th>${c}</th>`).join('') + '</tr></thead>')
          res.push('<tbody>')
          tableHeaderDone = true
        } else {
          res.push('<tr>' + cells.map((c) => `<td>${c}</td>`).join('') + '</tr>')
        }
        continue
      }
    } else if (inTable) {
      res.push('</tbody></table></div>')
      inTable = false
      tableHeaderDone = false
    }

    // Dividers
    if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
      if (inUl) { res.push('</ul>'); inUl = false }
      if (inOl) { res.push('</ol>'); inOl = false }
      res.push('<hr class="ai-divider">')
      continue
    }

    // Lists
    const bulletMatch = /^[-*]\s+(.+)$/.exec(trimmed)
    const numMatch = /^(\d+)\.\s+(.+)$/.exec(trimmed)

    if (bulletMatch) {
      if (inOl) { res.push('</ol>'); inOl = false }
      if (!inUl) { res.push('<ul class="ai-list">'); inUl = true }
      // Model sometimes jams a list and its follow-up sentence on one line
      // ("- Variables: 8 - ... performance_rating To get started, ...").
      const [listPart, prosePart] = splitTrailingProse(bulletMatch[1], state.ds.columns.map((c) => c.name))
      res.push(`<li>${listPart}</li>`)
      if (prosePart) {
        res.push('</ul>')
        inUl = false
        res.push(`<p class="ai-p">${prosePart}</p>`)
      }
      continue
    } else if (numMatch) {
      if (inUl) { res.push('</ul>'); inUl = false }
      if (!inOl) { res.push('<ol class="ai-list">'); inOl = true }
      res.push(`<li>${numMatch[2]}</li>`)
      continue
    }

    if (inUl) { res.push('</ul>'); inUl = false }
    if (inOl) { res.push('</ol>'); inOl = false }

    if (trimmed.startsWith('#### ')) {
      res.push(`<h5 class="ai-heading">${trimmed.slice(5)}</h5>`)
    } else if (trimmed.startsWith('### ')) {
      res.push(`<h4 class="ai-heading">${trimmed.slice(4)}</h4>`)
    } else if (trimmed.startsWith('## ')) {
      res.push(`<h3 class="ai-heading">${trimmed.slice(3)}</h3>`)
    } else if (trimmed.startsWith('# ')) {
      res.push(`<h2 class="ai-heading">${trimmed.slice(2)}</h2>`)
    } else if (trimmed.startsWith('> ')) {
      res.push(`<blockquote class="ai-quote">${trimmed.slice(2)}</blockquote>`)
    } else if (!trimmed) {
      res.push('<div class="ai-gap"></div>')
    } else {
      res.push(`<p class="ai-p">${line}</p>`)
    }
  }

  if (inUl) res.push('</ul>')
  if (inOl) res.push('</ol>')
  if (inTable) res.push('</tbody></table></div>')

  return res.join('')
}


function proposalText(p: Proposal): string {
  const schema = schemaById(p.analysis)
  return schema ? `${schema.title}: ${specSummary({ ...p.options })}` : p.analysis
}

/** Conf row: non-variable options only, so it never echoes the Var row.
 *  Auto-fill copies variables into dep/predictors/group/factor; those are
 *  variable-kind keys and would duplicate Var verbatim. Empty means the card
 *  hides the Conf row entirely. */
function proposalConf(p: Proposal): string {
  const schema = schemaById(p.analysis)
  const varKeys = new Set((schema?.options ?? []).filter((o) => o.kind === 'variable' || o.kind === 'variable-list').map((o) => o.key))
  const rest: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(p.options)) {
    if (!varKeys.has(k)) rest[k] = val
  }
  return specSummary(rest)
}

function getDatasetContext(): string {
  const cols = state.ds.columns.map((c) => `${c.name} (${c.type}, ${c.measure})`).join(', ')
  return `Active dataset: ${state.filename || 'Untitled'}, ${state.ds.columns.length} columns [${cols}], ${state.ds.columns[0] ? (state.ds.data[state.ds.columns[0].name]?.length ?? 0) : 0} rows.`
}

async function sendPrompt(customText?: string): Promise<void> {
  const text = (customText ?? draft.value).trim()
  if (!text || busy.value) return
  if (!customText) draft.value = ''

  messages.value.push({ id: nextId++, who: 'user', text })
  busy.value = true
  emit('status-change', 'busy')
  scrollDown()

  try {
    const datasetCtx = getDatasetContext()
    const history = messages.value
      .filter((m) => !m.error)
      .map((m) => ({
        role: m.who === 'user' ? 'user' : 'assistant',
        content: m.proposal ? proposalText(m.proposal) : m.text
      }))

    const replyRaw = await window.ara.ai.chat([
      {
        role: 'system',
        content: `You are ARA Assistant, the precise statistical copilot in ARAStat (part of the ARA Office ecosystem). You are directly connected to the active dataset editor and results engine.
${datasetCtx}

CRITICAL TONE & CONCISENESS RULES:
- Be extremely direct, precise, factual, and to the point.
- NEVER use conversational filler or chatty intros (no "Great question!", "Certainly!", "Sure thing!", or "Here is a summary").
- Jump immediately into the facts and actionable recommendations.
- Keep answers compact (max 2 to 4 concise bullet points or 1 short paragraph).
- When recommending analyses, state the exact analysis name, purpose, and mapped variables clearly.
- In prose, name grid positions as rows and columns, never cases or variables (JSON keys such as "variables" stay exactly as specified). Keep list bullets on consecutive lines with no blank lines between them; start the first bullet on its own new line after any intro sentence, never sharing a line with it; put any follow-up sentence on its own line after the list, never sharing a line with a bullet.

Supported statistical analysis IDs:
- descriptives (variables)
- frequencies (variables)
- ttest_onesample (dep, testValue)
- ttest_independent (dep, group)
- ttest_paired (a, b)
- anova_oneway (dep, factor)
- welch_anova (dep, factor, useVar)
- tukey_hsd (dep, factor, alpha)
- factorial_anova_2way (dep, factors, coding)
- chisq_independence (row, col)
- chisq_gof (variable)
- fisher_exact_2x2 (row, col, count)
- correlation (variables)
- kendall_tau (a, b)
- linear_regression (dep, predictors)
- logistic_regression (dep, predictors)
- mannwhitney_u (dep, group)
- wilcoxon_signedrank (a, b)
- wilcoxon_one_sample (dep, mu)
- friedman (conditions)
- kruskal_wallis (dep, factor)

When recommending an analysis, write your reasoning in concise markdown (no fluff), then provide a fenced JSON block:
\`\`\`json
{"analysis": "<id_from_above>", "variables": ["col1", "col2"], "options": {"optionKey": "value"}}
\`\`\`
For linear or multiple regression, use "analysis": "linear_regression", with options {"dep": "dependent_col", "predictors": ["pred1", "pred2"]}.
If proposing computed columns, add "computedColumns": ["new_var = formula"].

When the user asks to visualize data, plot a chart (e.g., scatter plot, bar chart, histogram, line chart), or when a visual diagram assists the analysis:
Provide a concise explanation, and provide a fenced JSON block:
\`\`\`json
{"chart": {"type": "scatter|bar|hist|line", "x": "<x_col_name>", "y": "<y_col_name_or_empty_for_hist>", "group": "<optional_group_col>"}}
\`\`\`
Supported chart types: "scatter", "bar", "hist", "line".
When asked to explain results or APA tables, act as a Senior Professor of Statistics: provide a formal, rigorous, yet clear and simple interpretation following APA 7th edition standards (report test statistic, df, exact p-value, effect size, and practical takeaway). Zero filler.`
      },
      ...history.slice(-10),
      { role: 'user', content: text }
    ])

    // ONE shared normalizer: narrative/proposal/chart/fallback in one pass.
    const normalized = normalizeAiResponse(replyRaw)
    const thinking = normalized.thinking
    const proposal = parseProposal(replyRaw)
    const chart = normalized.chart

    let displayText = normalized.narrative
      .replace(/^Based on your dataset \([^)]+\),?\s*(?:here['’]s a summary of what you can do:?)?\s*/i, '')
      .trim()

    if (!displayText && proposal) {
      displayText = 'Configured proposed statistical analysis:'
    } else if (!displayText && chart) {
      displayText = `Recommended ${chart.type} visualization for your data:`
    }

    messages.value.push({
      id: nextId++,
      who: 'bot',
      text: displayText,
      thinking,
      proposal: proposal ?? undefined,
      ...(chart ? { chart } : {})
    })
    emit('status-change', 'ready')
  } catch (err) {
    emit('status-change', 'error')
    handleAiError(err)
  } finally {
    busy.value = false
    scrollDown()
  }
}

async function runProposal(entry: ChatEntry): Promise<void> {
  const p = entry.proposal
  if (!p) return
  const formulas = p.computedColumns ?? []
  const spec: Record<string, unknown> = { ...p.options }

  if (!formulas.length) {
    emit('toast', `Running ${schemaById(p.analysis)?.title ?? p.analysis}...`)
    await runAnalysis(p.analysis, spec, entry.chart ? { chart: entry.chart } : {})
    return
  }

  // Confirm Gate: mutations always wait for user confirmation
  pending.value = {
    columns: formulas.length,
    messageId: entry.id,
    apply: () => {
      const taken = new Set(state.ds.columns.map((c) => c.name))
      formulas.forEach((formula, i) => {
        let name = (formula.split('=')[0] ?? '').trim() || `computed${i + 1}`
        while (taken.has(name)) name = `${name}_${i + 2}`
        taken.add(name)
        addColumn(defaultMeta(name, 'numeric'))
      })
      state.computedFormulas.push(...formulas)
      emit('toast', `${formulas.length} computed columns added to the dataset`)
      void runAnalysis(p.analysis, spec)
    }
  }
  scrollDown()
}

function confirmMutation(): void {
  pending.value?.apply()
  pending.value = null
}

function cancelMutation(): void {
  pending.value = null
}


/** External trigger: Explain a specific analysis run from ResultsPane */
async function explainRun(run: Run): Promise<void> {
  open.value = true
  const tables = run.elements
    .filter((el) => el.kind === 'table')
    .map((t) => `${t.caption}: ${t.columns.join(' | ')}\nRows: ${t.rows.map((r) => r.join(' | ')).join('\n')}`)
    .join('\n\n')

  const promptText = `Please provide a concise, publication-grade statistical narrative interpretation for this ${run.title} analysis output:\n${tables}\nSpec: ${specSummary(run.spec)}`

  messages.value.push({ id: nextId++, who: 'user', text: `Explain results for "${run.title}"` })
  busy.value = true
  emit('status-change', 'busy')
  scrollDown()

  try {
    const replyRaw = await window.ara.ai.chat([
      {
        role: 'system',
        content: `You are a Senior Professor of Statistics in ARAStat. Provide a formal, rigorous, yet clear and simple statistical interpretation of the provided test results.
- Write in a scholarly, authoritative, yet accessible academic tone.
- Clearly explain what the statistical test examined and what the findings mean in plain language.
- Explicitly report the relevant test statistic, degrees of freedom, exact p-value (e.g., p = .003 or p < .001), and effect size following APA 7th edition standards.
- Conclude with an explicit, simple takeaway explaining the practical real-world meaning of the result.
- In prose, name grid positions as rows and columns, never cases or variables.
- Do not include conversational filler, preamble, or labels like "APA 7th Interpretation:" or "Takeaway:". State the narrative directly.`
      },
      { role: 'user', content: promptText }
    ])

    const interpreted = normalizeAiResponse(replyRaw)
    const normalizedText = interpreted.narrative
      .replace(/^(?:(?:\*\*)?(?:APA(?:\s*7th)?\s*)?(?:Narrative\s*)?Interpretation(?:\*\*)?[:\s\-–—]*)/i, '')
      .trim()
    messages.value.push({
      id: nextId++,
      who: 'bot',
      text: normalizedText,
      thinking: interpreted.thinking,
      narrativeTargetRunId: run.runId,
      narrativeNote: normalizedText
    })
    emit('status-change', 'ready')
  } catch (err) {
    emit('status-change', 'error')
    handleAiError(err)
  } finally {
    busy.value = false
    scrollDown()
  }
}

function insertNoteIntoResults(entry: ChatEntry): void {
  if (!entry.narrativeTargetRunId || !entry.narrativeNote) return
  const cleanNote = entry.narrativeNote
    .replace(/^(?:(?:\*\*)?(?:APA(?:\s*7th)?\s*)?(?:Narrative\s*)?Interpretation(?:\*\*)?[:\s\-–—]*)/i, '')
    .trim()
  window.dispatchEvent(
    new CustomEvent('ara:insert-narrative-note', {
      detail: { runId: entry.narrativeTargetRunId, text: cleanNote }
    })
  )
  entry.narrativeInserted = true
  emit('toast', 'Interpretation note added to results pane.')
}

function openChartInVisualizer(chart: { type: string; x?: string; y?: string; group?: string }): void {
  const rawType = (chart.type || 'scatter').toLowerCase()
  const normType: 'scatter' | 'bar' | 'histogram' | 'line' =
    rawType === 'hist' || rawType === 'histogram' ? 'histogram'
    : rawType === 'bar' || rawType === 'barchart' ? 'bar'
    : rawType === 'line' || rawType === 'linechart' ? 'line'
    : 'scatter'
  emit('visualize', {
    type: normType,
    x: chart.x,
    y: chart.y
  })
}

defineExpose({
  open,
  explainRun,
  clear,
  toggle: () => { open.value = !open.value },
  setOpen: (v: boolean) => { open.value = v },
  ask: (text: string) => {
    open.value = true
    void sendPrompt(text)
  }
})
</script>

<template>
  <aside class="pane-ai" :class="{ 'is-collapsed': !open }" aria-label="ARA Assistant">
    <!-- Collapsed Rail (Parity with ARA PDF & ARA Office ecosystem) -->
    <button
      v-if="!open"
      class="ai-rail"
      type="button"
      title="Open ARA Assistant"
      aria-label="Open ARA Assistant"
      @click="open = true"
    >
      <span class="ai-rail-icon" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 0c.7 4.5 3.5 7.3 8 8-4.5.7-7.3 3.5-8 8-.7-4.5-3.5-7.3-8-8 4.5-.7 7.3-3.5 8-8z" />
        </svg>
      </span>
    </button>

    <!-- Expanded AI Copilot Pane -->
    <template v-else>
      <header class="pane-header ai-panel-header">
        <div class="ai-title-wrap">
          <div class="ai-sparkle-squircle" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="white">
              <path d="M8 0c.7 4.5 3.5 7.3 8 8-4.5.7-7.3 3.5-8 8-.7-4.5-3.5-7.3-8-8 4.5-.7 7.3-3.5 8-8z" />
            </svg>
          </div>
          <span class="ai-head-title">ARA Assistant</span>
        </div>

        <div class="ai-panel-header-actions">
          <!-- AI Provider Settings Button -->
          <button
            class="ai-header-btn"
            type="button"
            title="AI Settings"
            aria-label="AI Settings"
            @click="emit('open-settings')"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
          </button>

          <!-- New Chat Button (IconNewChat) -->
          <button
            class="ai-header-btn"
            type="button"
            title="New chat"
            aria-label="New chat"
            @click="clear"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">
              <path
                d="M13.5 7.2v-3A1.7 1.7 0 0 0 11.8 2.5H4.2a1.7 1.7 0 0 0-1.7 1.7v6.1a1.7 1.7 0 0 0 1.7 1.7h1.1v2l2.6-2h1.3"
                stroke-linejoin="round"
              />
              <path d="M12.2 9.4v4M10.2 11.4h4" />
            </svg>
          </button>

          <!-- Collapse Button (IconSidebarCollapse) -->
          <button
            class="ai-header-btn"
            type="button"
            title="Collapse assistant"
            aria-label="Collapse assistant"
            @click="open = false"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">
              <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
              <path d="M10.5 2.5v11" />
              <path d="M3.5 8h4.4M6.2 5.9 8.3 8l-2.1 2.1" stroke-width="1.3" stroke-linejoin="round" />
            </svg>
          </button>
        </div>
      </header>

      <div ref="scrollEl" class="chat-scroll" role="log" aria-label="ARA Assistant conversation">
        <div v-if="!messages.length" class="chat-empty" role="status">
          <strong>ARA Assistant is ready.</strong>
          <span>Ask about your columns, statistical assumptions, or analyses.</span>
        </div>

        <div v-for="m in messages" :key="m.id" class="msg" :class="[m.who, { 'is-error': m.error }]">
          <div class="who">{{ m.who === 'user' ? 'You' : 'ARA Assistant' }}</div>
          <div class="bubble">
            <!-- Collapsible Thinking Process -->
            <details v-if="m.thinking" class="ai-thinking" open>
              <summary>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
                </svg>
                <span>Thinking Process</span>
              </summary>
              <div class="thought-content">{{ m.thinking }}</div>
            </details>

            <span v-if="m.error" role="alert">{{ m.text }}</span>
            <!-- Formatted Markdown Rendering -->
            <div v-else class="ai-rendered-content" v-html="formatMarkdown(m.text)"></div>

            <!-- Interactive Process Card -->
            <div v-if="m.proposal" class="ai-process-card">
              <div class="process-title">{{ schemaById(m.proposal.analysis)?.title ?? m.proposal.analysis }}</div>
              <div class="process-spec-list">
                <div class="spec-item">
                  <span class="spec-key">Var</span>
                  <code>{{ m.proposal.variables.join(', ') || 'Auto-select' }}</code>
                </div>
                <div v-if="proposalConf(m.proposal)" class="spec-item">
                  <span class="spec-key">Conf</span>
                  <span>{{ proposalConf(m.proposal) }}</span>
                </div>
                <div v-if="m.proposal.computedColumns?.length" class="spec-item">
                  <span class="spec-key">Calc</span>
                  <span>{{ m.proposal.computedColumns.join('; ') }}</span>
                </div>
                <div v-if="m.chart" class="spec-item">
                  <span class="spec-key">Chart</span>
                  <span>{{ m.chart.type }}: {{ m.chart.y ? `${m.chart.y} vs ${m.chart.x}` : m.chart.x }}{{ m.chart.group ? ` by ${m.chart.group}` : '' }}</span>
                </div>
              </div>
              <div class="process-actions">
                <button class="btn btn-primary btn-sm" type="button" @click="runProposal(m)">
                  Run Test
                </button>
                <button class="btn btn-sm" type="button" @click="emit('edit-options', { analysis: m.proposal!.analysis, options: { ...m.proposal!.options } })">
                  Edit Options
                </button>
              </div>
            </div>

            <!-- Standalone/Integrated Visualization Recommendation Card -->
            <div v-if="m.chart" class="ai-chart-card">
              <div class="chart-card-header">
                <span class="chart-type-tag">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="20" x2="18" y2="10" />
                    <line x1="12" y1="20" x2="12" y2="4" />
                    <line x1="6" y1="20" x2="6" y2="14" />
                  </svg>
                  {{ (m.chart.type === 'hist' ? 'histogram' : m.chart.type).toUpperCase() }}
                </span>
                <span class="chart-card-title">
                  {{ m.chart.y ? `${m.chart.y} vs ${m.chart.x}` : m.chart.x }}
                  {{ m.chart.group ? `(by ${m.chart.group})` : '' }}
                </span>
              </div>
              <div class="process-actions">
                <button
                  class="btn btn-primary btn-sm"
                  type="button"
                  @click="openChartInVisualizer(m.chart)"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7" />
                    <line x1="16" y1="5" x2="22" y2="5" />
                    <line x1="22" y1="5" x2="14" y2="13" />
                  </svg>
                  Open in Visualizer
                </button>
              </div>
            </div>

            <!-- Narrative Note Insertion Button -->
            <div v-if="m.narrativeNote && !m.narrativeInserted" style="margin-top: 10px;">
              <button class="btn btn-primary btn-sm" type="button" @click="insertNoteIntoResults(m)">
                + Insert Note into Results
              </button>
            </div>

            <!-- Message Action Toolbar (Copy, hover-revealed) -->
            <div v-if="m.who === 'bot' && !m.error" class="bubble-actions">
              <button class="bubble-act-btn" type="button" title="Copy text" aria-label="Copy text" @click="copyMessage(m.text)">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
              </button>
            </div>

            <!-- Confirm Gate for dataset mutation -->
            <div v-if="pending && m.id === pending.messageId" class="confirm-gate">
              <div class="confirm-copy">
                <span class="cg-icon" aria-hidden="true">!</span>
                <strong>Confirm change</strong>: This will add {{ pending.columns }} computed columns to your active dataset. Apply?
              </div>
              <div class="process-actions">
                <button class="btn btn-primary btn-sm" type="button" @click="confirmMutation">Confirm</button>
                <button class="btn btn-sm" type="button" @click="cancelMutation">Cancel</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Modern Composer -->
      <form class="chat-composer" @submit.prevent="sendPrompt()">
        <div class="composer-row">
          <input
            v-model="draft"
            type="text"
            placeholder="Ask ARA"
            autocomplete="off"
            :disabled="busy"
          />
          <button
            class="composer-send-btn"
            type="submit"
            :disabled="busy || !draft.trim()"
            title="Send"
            aria-label="Send"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        </div>
        <p class="chat-note">ARA Assistant suggestions are advisory, it can make mistakes.</p>
      </form>
    </template>
  </aside>
</template>
