<script setup lang="ts">
// Results pane (§8): renders the result tree per run - APA tables, notes, error
// elements with Fix options. Chart honesty: <img> only when an element carries a
// loadable src (the CSP blocks data:/blob: images), otherwise a plain note.
// Connected AI: exposes "Explain with ARA Assistant" button to trigger narrative interpretations.
import { computed, ref } from 'vue'
import { runsState, loadingState, type Run, type ResultElement } from './results.ts'
import { fmtCell, fmtP, isPColumn, isSig } from './format.ts'
import { specSummary } from './specs.ts'

const emit = defineEmits<{
  (e: 'export-html'): void
  (e: 'copy-text'): void
  (e: 'copy-run', run: Run): void
  (e: 'fix-options', run: Run): void
  (e: 'explain-run', run: Run): void
  (e: 'close'): void
  (e: 'close-run', run: Run): void
}>()

const visibleRuns = computed(() => runsState.runs.filter((r) => r.revealed).reverse())

// Per-run minimize: collapsed bodies keep their head row with copy/close.
const minimized = ref(new Set<string>())
function isMinimized(run: Run): boolean {
  return minimized.value.has(run.runId)
}
function toggleMinimize(run: Run): void {
  const next = new Set(minimized.value)
  if (next.has(run.runId)) next.delete(run.runId)
  else next.add(run.runId)
  minimized.value = next
}

// Track runs where explanation was requested to hide the button
const explainedRuns = ref(new Set<string>())
function isExplained(run: Run): boolean {
  return explainedRuns.value.has(run.runId) || run.elements.some((el) => el.kind === 'note' && el.address?.startsWith('note:narrative'))
}
function onExplain(run: Run): void {
  const next = new Set(explainedRuns.value)
  next.add(run.runId)
  explainedRuns.value = next
  emit('explain-run', run)
}

function desc(run: Run): string {
  return `${specSummary(run.spec)} (${run.missingPolicy} missing handling).`
}

function starred(el: ResultElement): boolean {
  return el.kind === 'table' && el.columns.some((c, i) => isPColumn(c) && el.rows.some((r) => isSig(r[i])))
}

function isScalarTable(el: ResultElement): boolean {
  return el.kind === 'table' && el.rows.length === 1 && el.columns.length > 0 && el.columns.length <= 8
}

function scalarEntries(el: ResultElement): Array<{ label: string; value: unknown }> {
  if (el.kind !== 'table' || !el.rows[0]) return []
  return el.columns.map((label, i) => ({ label: label || `Value ${i + 1}`, value: el.rows[0][i] }))
}

// APA house style: one "Note." line per table (copy block "Note. ... * p < .05.").
// Engine footnotes carry their own "Note." prefix; strip it so the line gets exactly one.
function noteTail(el: ResultElement): string {
  const parts = el.kind === 'table' ? el.footnotes.map((f) => f.replace(/^Note\.\s*/, '')) : []
  if (starred(el)) parts.push('* p < .05.')
  return parts.join(' ')
}
</script>

<template>
  <section class="pane-results" aria-label="Results">
    <div class="pane-header">
      <h2>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
        </svg>
        <span>Result</span>
      </h2>
      <div class="spacer"></div>
      <button class="chip-btn icon-only" type="button" title="Copy as text" aria-label="Copy as text" @click="$emit('copy-text')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
      </button>
      <button class="chip-btn icon-only" type="button" title="Export HTML" aria-label="Export HTML" @click="$emit('export-html')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      </button>
      <button class="chip-btn icon-only" type="button" title="Collapse Result View" aria-label="Collapse Result View" @click="$emit('close')">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">
          <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
          <path d="M10.5 2.5v11" />
          <path d="M3.5 8h4.4M6.2 5.9 8.3 8l-2.1 2.1" stroke-width="1.3" stroke-linejoin="round" />
        </svg>
      </button>
    </div>
    <div v-if="loadingState.active" class="loading-line active" role="status">
      <div class="spinner" aria-hidden="true"></div>
      <span><span>{{ loadingState.text }}</span><span class="dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span></span>
    </div>
    <div class="results-scroll">
      <p v-if="!visibleRuns.length && !loadingState.active" class="result-desc">No results yet. Choose an analysis from the Analyze menu or ask ARA Assistant.</p>
      <article v-for="run in visibleRuns" :key="run.runId" class="result-block" :class="{ fresh: run.fresh, error: run.status === 'error' }">
        <div class="result-head-row">
          <h3 class="result-title">{{ run.title }}</h3>
          <div class="result-head-actions">
            <button
              class="icon-chip"
              type="button"
              :title="isMinimized(run) ? 'Expand this result' : 'Minimize this result'"
              :aria-label="isMinimized(run) ? 'Expand this result' : 'Minimize this result'"
              @click.stop="toggleMinimize(run)"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <button
              class="icon-chip danger"
              type="button"
              title="Close this result"
              aria-label="Close this result"
              @click.stop="$emit('close-run', run)"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>
        <template v-if="!isMinimized(run)">
        <p v-if="run.status !== 'error'" class="result-desc">{{ desc(run) }}</p>
        <template v-for="el in run.elements" :key="el.address">
          <dl v-if="el.kind === 'table' && isScalarTable(el)" class="result-stats" :aria-label="el.caption" :style="el.status === 'stale' ? 'opacity: 0.55' : ''">
            <dt v-for="(entry, i) in scalarEntries(el)" :key="`label-${i}`">{{ entry.label }}</dt>
            <dd v-for="(entry, i) in scalarEntries(el)" :key="`value-${i}`">{{ isPColumn(entry.label) && typeof entry.value === 'number' ? fmtP(entry.value) : fmtCell(entry.value) }}</dd>
          </dl>
          <table v-else-if="el.kind === 'table'" class="apa" :aria-label="el.caption" :style="el.status === 'stale' ? 'opacity: 0.55' : ''">
            <caption>{{ el.caption }}</caption>
            <thead>
              <tr>
                <th v-for="(c, i) in el.columns" :key="i" scope="col" :class="i === 0 ? 'l' : ''">{{ c }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, ri) in el.rows" :key="ri">
                <template v-for="(v, ci) in row" :key="ci">
                  <th v-if="ci === 0 && typeof v === 'string'" scope="row" class="l">{{ v }}</th>
                  <td v-else-if="isPColumn(el.columns[ci] ?? '') && typeof v === 'number'" :class="{ sig: isSig(v) }">{{ fmtP(v) }}{{ isSig(v) ? ' *' : '' }}</td>
                  <td v-else>{{ fmtCell(v) }}</td>
                </template>
              </tr>
            </tbody>
          </table>
          <p v-else-if="el.kind === 'note'" class="notes-line">{{ el.text }}</p>
          <img v-else-if="el.kind === 'chart' && el.src" :src="el.src" :alt="el.caption" style="max-width:100%; margin:8px 0;">
          <div v-else-if="el.kind === 'chart' && el.svg" class="chart-svg" role="img" :aria-label="el.caption" v-html="el.svg"></div>
          <p v-else-if="el.kind === 'chart'" class="chart-slot">{{ el.caption }}</p>
          <div v-else class="err-row" role="alert">
            <span class="err-icon" aria-hidden="true">!</span>
            <div class="err-text">
              <strong>Analysis failed.</strong> {{ el.userMessage }}
              <div style="margin-top:8px;">
                <button class="btn btn-sm" @click="$emit('fix-options', run)">Fix options</button>
              </div>
            </div>
          </div>
          <p v-if="el.kind === 'table' && noteTail(el)" class="footnote">Note. {{ noteTail(el) }}</p>
        </template>

        <!-- Connected Result Actions -->
        <div v-if="run.status !== 'error' && !isMinimized(run)" class="result-action-bar">
          <button
            v-if="!isExplained(run)"
            class="ai-explain-btn"
            type="button"
            @click="onExplain(run)"
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 1C12 7.075 7.075 12 1 12C7.075 12 12 16.925 12 23C12 16.925 16.925 12 23 12C16.925 12 12 7.075 12 1Z" />
            </svg>
            <span>Explain this Result</span>
          </button>
          <button
            class="btn btn-sm btn-copy-result"
            type="button"
            title="Copy this result (keeps table layout)"
            aria-label="Copy this result"
            @click.stop="$emit('copy-run', run)"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
            <span>Copy</span>
          </button>
        </div>
        </template>
      </article>
    </div>
  </section>
</template>
