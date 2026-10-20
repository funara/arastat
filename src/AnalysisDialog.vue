<script setup lang="ts">
// Generic schema-driven analysis options dialog (arch §7): one component renders all
// 25 analysis specs. Native <dialog>.showModal() provides Esc-to-close and native focus
// return to the invoking control.
import { ref, computed, watch, nextTick } from 'vue'
import { state } from './store.ts'
import { defaultValues, validateValues, defaultChartForSpec, type AnalysisSchema, type SpecOption, type ChartSpec } from './specs.ts'
import { distinctGroupLevels, listwiseForecast } from './advisor.ts'
import { storageShort, type Measure } from './io/types.ts'
import { flagStale } from './results.ts'
import MeasureIcon from './MeasureIcon.vue'

const props = defineProps<{
  schema: AnalysisSchema | null
  initial?: Record<string, unknown>
  /** Restore an existing run's missing policy when editing its options. */
  initialMissingPolicy?: 'listwise' | 'pairwise'
  /** Restore an existing run's companion plot when editing its options. */
  initialIncludeChart?: boolean
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'run', payload: {
    schema: AnalysisSchema
    values: Record<string, unknown>
    chart: ChartSpec | null
    missingPolicy: 'listwise' | 'pairwise'
  }): void
}>()

const dlg = ref<HTMLDialogElement | null>(null)
const values = ref<Record<string, unknown>>({})
const selected = ref<string | null>(null)
const dragOver = ref<string | null>(null)
// Filter text is dialog-only state: the registry rejects unknown spec keys (1001),
// so it never serializes into `values`.
const variableFilter = ref('')
const showGuidePopover = ref(false)
// Focused target slot: drives the incompatible-variable dimming and the
// shuttle button's target. Empty until the user focuses a slot.
const activeTargetKey = ref<string | null>(null)
// Missing-value handling and the companion plot ride the run, never the spec
// (the engine rejects unknown spec keys).
const missingPolicy = ref<'listwise' | 'pairwise'>('listwise')
const includeChart = ref(true)

/**
 * Polishes field hint: strips technical parentheticals like (Scale, e.g., salary)
 * to deliver concise, human-friendly guidance placed beneath the label.
 */
function cleanHint(text?: string): string {
  if (!text) return ''
  let s = text.trim()
  s = s.replace(/\s*\([^)]*(?:e\.g\.|Scale|Nominal|Ordinal|Ratio)[^)]*\)/gi, '').trim()
  s = s.replace(/[,;]+$/, '').trim()
  if (s && !/[.!?]$/.test(s)) s += '.'
  return s
}

/**
 * Formats multi-step how-to guidance strings into clean numbered items.
 */
function formattedHowTo(raw?: string): string[] {
  if (!raw) return []
  if (/^\s*1\.\s+/.test(raw) || /\s+2\.\s+/.test(raw)) {
    return raw
      .split(/\s*\b\d+\.\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return [raw.trim()]
}

const varFilter = computed(() => variableFilter.value.trim().toLowerCase())

/** Source rows shown: name or label substring match, case-insensitive. */
const sourceColumns = computed(() => {
  const q = varFilter.value
  if (!q) return state.ds.columns
  return state.ds.columns.filter((c) => c.name.toLowerCase().includes(q) || c.label.toLowerCase().includes(q))
})

/** Honest count: `shown / total` while filtering, else the total. */
const sourceCount = computed(() =>
  variableFilter.value.trim() ? `${sourceColumns.value.length} / ${state.ds.columns.length}` : String(state.ds.columns.length)
)

const varOptions = computed(() => props.schema?.options.filter((o) => o.kind === 'variable' || o.kind === 'variable-list') ?? [])
const scalarOptions = computed(() => props.schema?.options.filter((o) => o.kind !== 'variable' && o.kind !== 'variable-list') ?? [])

let seeding = false

// Both signals + immediate: the dialog mounts on open (App v-if) with the schema
// already set, so seeding and showModal must also run at mount.
watch(
  [() => props.schema, () => props.initial, () => props.initialMissingPolicy, () => props.initialIncludeChart],
  ([s]) => {
    if (!s) {
      dlg.value?.close()
      return
    }
    seeding = true
    values.value = defaultValues(s, props.initial)
    missingPolicy.value = props.initialMissingPolicy ?? s.missingDefault ?? 'listwise'
    includeChart.value = props.initialIncludeChart ?? true
    seeding = false
    selected.value = null
    dragOver.value = null
    variableFilter.value = ''
    showGuidePopover.value = false
    activeTargetKey.value = null
    nextTick(() => {
      const el = dlg.value
      if (el && !el.open) el.showModal()
    })
  },
  { immediate: true }
)

// Stale on option edit: a user change dims the latest settled result for this
// analysis until it is rerun. Seeding is not an edit.
watch(values, () => {
  if (seeding || !props.schema) return
  flagStale(props.schema.id, { ...values.value }, missingPolicy.value)
}, { deep: true, flush: 'sync' })

// The missing policy changes the result too, so it dims the settled run.
watch(missingPolicy, (policy) => {
  if (seeding || !props.schema) return
  flagStale(props.schema.id, { ...values.value }, policy)
}, { flush: 'sync' })

function onClose(): void {
  selected.value = null
  showGuidePopover.value = false
  emit('close')
}

// ::backdrop clicks retarget to the <dialog>; the rect check spares border clicks.
function onBackdropClick(e: MouseEvent): void {
  const el = dlg.value
  if (!el || e.target !== el) return
  const r = el.getBoundingClientRect()
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) el.close()
}

/** Lockstep list normalization for the template bindings. */
function listFor(key: string): string[] {
  const v = values.value[key]
  return Array.isArray(v) ? (v as string[]) : []
}

/** Measure gate: unchanged engine rule, just no longer displayed. */
function acceptable(opt: SpecOption, name: string | null): boolean {
  if (!name) return false
  const meta = state.ds.columns.find((c) => c.name === name)
  if (!meta) return false
  return opt.measures?.includes(meta.measure) ?? true
}

/** Short dtype label (int / float / str / date) for the source list. */
function dtypeOf(name: string): string {
  const meta = state.ds.columns.find((c) => c.name === name)
  return meta ? storageShort(meta) : ''
}

/** Measure badge for an assigned token; null when the column is gone (render nothing). */
function measureOf(name: string): Measure | null {
  return state.ds.columns.find((c) => c.name === name)?.measure ?? null
}

function assignTo(key: string, name?: string): boolean {
  const opt = props.schema?.options.find((o) => o.key === key)
  const target = name ?? selected.value
  if (!opt || !acceptable(opt, target)) return false
  if (opt.kind === 'variable') {
    values.value[key] = target
    return true
  }
  const cur = listFor(key)
  if (cur.includes(target!)) return false
  if (opt.max !== undefined && cur.length >= opt.max) return false
  values.value[key] = [...cur, target!]
  return true
}

/** Click on a target box focuses it and places the selected source variable. */
function onTargetClick(key: string): void {
  activeTargetKey.value = key
  assignTo(key)
}

/** Double-click fallback: first compatible field with room. */
function assignFirst(name: string): void {
  for (const o of varOptions.value) {
    if (!acceptable(o, name)) continue
    if (o.kind === 'variable' && !values.value[o.key]) {
      values.value[o.key] = name
      return
    }
    if (o.kind === 'variable-list') {
      const cur = listFor(o.key)
      if (!cur.includes(name) && (o.max === undefined || cur.length < o.max)) {
        values.value[o.key] = [...cur, name]
        return
      }
    }
  }
}

function unassign(key: string, name?: string): void {
  const opt = props.schema?.options.find((o) => o.key === key)
  if (!opt) return
  if (opt.kind === 'variable') values.value[key] = ''
  else values.value[key] = listFor(key).filter((v) => v !== name)
}

// --- Drag and drop (HTML5, no deps) ---
interface DragPayload { name: string; from: string | null }

function readPayload(e: DragEvent): DragPayload | null {
  try {
    const raw = e.dataTransfer?.getData('text/plain')
    if (!raw) return null
    const p = JSON.parse(raw) as DragPayload
    return typeof p.name === 'string' ? p : null
  } catch {
    return null
  }
}

function onSourceDragStart(e: DragEvent, name: string): void {
  e.dataTransfer?.setData('text/plain', JSON.stringify({ name, from: null } satisfies DragPayload))
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
}

function onTokenDragStart(e: DragEvent, fromKey: string, name: string): void {
  e.stopPropagation()
  e.dataTransfer?.setData('text/plain', JSON.stringify({ name, from: fromKey } satisfies DragPayload))
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onTargetDrop(e: DragEvent, key: string): void {
  e.preventDefault()
  dragOver.value = null
  const p = readPayload(e)
  if (!p) return
  activeTargetKey.value = key
  if (p.from && p.from !== key) {
    if (assignTo(key, p.name)) unassign(p.from, p.name)
  } else {
    assignTo(key, p.name)
  }
}

function onSourceDrop(e: DragEvent): void {
  e.preventDefault()
  const p = readPayload(e)
  if (p?.from) unassign(p.from, p.name)
}

// --- Target focus: incompatible variables dim for the focused slot ---------

/** True when the slot still waits for a variable. */
function slotEmpty(o: SpecOption): boolean {
  if (o.kind === 'variable') return !values.value[o.key]
  return listFor(o.key).length === 0
}

/**
 * The slot the dimming rule applies to: the one the user focused, else the
 * first slot still waiting for a variable.
 */
const activeTarget = computed<SpecOption | null>(() => {
  const opts = varOptions.value
  const active = activeTargetKey.value ? opts.find((o) => o.key === activeTargetKey.value) : undefined
  if (active) return active
  return opts.find((o) => slotEmpty(o)) ?? opts[0] ?? null
})

/** True when the column's measurement scale cannot go into the active slot. */
function incompatible(name: string): boolean {
  const opt = activeTarget.value
  if (!opt || !opt.measures || !opt.measures.length) return false
  const meta = state.ds.columns.find((c) => c.name === name)
  if (!meta) return false
  return !opt.measures.includes(meta.measure)
}

/** Tooltip naming the measurement scale the active slot needs. */
const incompatibleHint = computed(() => {
  const m = activeTarget.value?.measures ?? []
  if (!m.length) return ''
  return `Requires ${m.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(' / ')}`
})

// --- Group levels (live, read-only) ----------------------------------------
// The `group` option is the two-group slot (ttest_independent, mannwhitney_u)
// and needs exactly 2 levels; `factor` (ANOVA, Welch, Tukey, Kruskal) needs 2+.
// Levels come from the shared advisor helper, so the preview matches the run.

/** The grouping slot in use, with the level count it demands. */
const levelSlot = computed(() => {
  const groupName = values.value['group']
  if (typeof groupName === 'string' && groupName) return { key: 'group', name: groupName, exact: 2 }
  const factorName = values.value['factor']
  if (typeof factorName === 'string' && factorName) return { key: 'factor', name: factorName, exact: 0 }
  return null
})

/** Distinct non-missing levels with counts, in first-appearance order. */
const groupLevels = computed(() =>
  levelSlot.value ? distinctGroupLevels(levelSlot.value.name) : []
)

/** Pre-flight replacement for engine error 1004: never run a grouping variable with the wrong level count. */
const groupLevelWarning = computed(() => {
  const slot = levelSlot.value
  if (!slot) return ''
  const name = slot.name
  const levels = groupLevels.value
  const title = props.schema?.title ?? 'This test'
  const listed = levels.map((l) => l.value).join(', ')
  if (!levels.length) return `Column '${name}' has no non-missing values. ${title} needs a grouping column with data — choose another column.`
  if (slot.exact === 2) {
    if (levels.length === 2) return ''
    if (levels.length === 1) return `Column '${name}' has 1 distinct group (${listed}). ${title} requires exactly 2 groups — define a second group or choose another column.`
    return `Column '${name}' has ${levels.length} distinct groups (${listed}). ${title} requires exactly 2 groups — use One-Way ANOVA instead.`
  }
  if (levels.length < 2) return `Column '${name}' has 1 distinct group (${listed}). ${title} requires at least 2 groups — define a second group or choose another column.`
  return ''
})

// --- Completeness preview (listwise forecast) ------------------------------

/** Columns the current spec reads, in slot order. */
const referencedNames = computed(() => {
  const out: string[] = []
  for (const o of varOptions.value) {
    if (o.kind === 'variable') {
      const v = values.value[o.key]
      if (typeof v === 'string' && v) out.push(v)
    } else {
      for (const n of listFor(o.key)) out.push(n)
    }
  }
  return [...new Set(out)]
})

/** How many rows survive listwise handling for the current selection. */
const completeness = computed(() =>
  referencedNames.value.length ? listwiseForecast(referencedNames.value) : null
)

const problems = computed(() => {
  if (!state.ds.columns.length) return ['Add or import data before running a test']
  if (!props.schema) return ['No analysis chosen']
  const errs = validateValues(props.schema, values.value)
  // Unshifted, not pushed: the footer renders problems[0], and the group block is
  // the one the user must act on before the engine would raise 1004.
  const group = groupLevelWarning.value
  return group ? [group, ...errs] : errs
})
const canRun = computed(() => problems.value.length === 0)

function run(): void {
  if (!props.schema || !canRun.value) return
  const chart = includeChart.value ? defaultChartForSpec(props.schema.id, values.value) : null
  emit('run', {
    schema: props.schema,
    values: { ...values.value },
    chart,
    missingPolicy: missingPolicy.value,
  })
  dlg.value?.close()
}
</script>

<template>
  <dialog ref="dlg" aria-labelledby="dlgTitle" class="analysis-dialog" @close="onClose" @click="onBackdropClick($event)">
    <div class="dlg-head">
      <div class="dlg-head-title-wrap">
        <div class="analysis-head-icon" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="20" x2="18" y2="10" />
            <line x1="12" y1="20" x2="12" y2="4" />
            <line x1="6" y1="20" x2="6" y2="14" />
          </svg>
        </div>
        <h3 id="dlgTitle">{{ schema?.title ?? 'Analysis' }}</h3>
      </div>
      <div class="dlg-head-actions">
        <div v-if="schema?.howTo || schema?.description" class="dlg-info-wrap">
          <button
            type="button"
            class="dlg-info-btn"
            aria-label="Analysis Guide &amp; Instructions"
            :title="schema?.title ? `${schema.title} Guide` : 'Guide'"
            @mouseenter="showGuidePopover = true"
            @mouseleave="showGuidePopover = false"
            @focus="showGuidePopover = true"
            @blur="showGuidePopover = false"
            @click="showGuidePopover = !showGuidePopover"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
          </button>
          <div
            v-if="showGuidePopover"
            class="dlg-info-popover"
            role="tooltip"
            @mouseenter="showGuidePopover = true"
            @mouseleave="showGuidePopover = false"
          >
            <div class="popover-head">
              <div class="popover-title">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
                <span>{{ schema?.title }} Guide</span>
              </div>
            </div>
            <div class="popover-content">
              <p v-if="schema?.description" class="popover-desc">{{ schema.description }}</p>
              <div v-if="schema?.howTo" class="popover-howto-section">
                <span class="popover-howto-title">Setup Instructions</span>
                <div class="popover-howto-list">
                  <div
                    v-for="(step, idx) in formattedHowTo(schema.howTo)"
                    :key="idx"
                    class="popover-howto-item"
                  >
                    <span class="howto-item-badge">{{ idx + 1 }}</span>
                    <span class="howto-item-text">{{ step }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <button type="button" class="dlg-close-x" title="Close (Esc)" aria-label="Close" @click="dlg?.close()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>

    <div class="dlg-body">
      <!-- Left Column: Source Variables -->
      <div class="dlg-left">
        <input
          v-model="variableFilter"
          type="search"
          class="dialog-input var-filter-input"
          placeholder="Filter variables..."
          aria-label="Filter variables"
        >
        <div class="field-header">
          <span id="sourceListLabel" class="field-label">Available Variables</span>
          <span class="var-count-badge">{{ sourceCount }}</span>
        </div>
        <div
          class="var-list"
          role="group"
          aria-labelledby="sourceListLabel"
          @dragover.prevent
          @drop="onSourceDrop($event)"
        >
          <p v-if="!state.ds.columns.length" class="analysis-empty">No columns are available. Add or import data first.</p>
          <p v-else-if="!sourceColumns.length" class="analysis-empty">
            No variables match “{{ variableFilter.trim() }}”. Clear the filter or try another search.
            <button type="button" class="var-filter-clear" @click="variableFilter = ''">Clear filter</button>
          </p>
          <button
            v-for="c in sourceColumns"
            :key="c.name"
            type="button"
            class="var-row"
            :class="{ 'is-incompatible': incompatible(c.name) }"
            draggable="true"
            :aria-pressed="selected === c.name"
            :aria-disabled="incompatible(c.name) ? 'true' : undefined"
            :title="incompatible(c.name) ? `${c.name} (${c.measure}) - ${incompatibleHint}` : `${c.name} (${c.type}, ${c.measure}) - Click to select or double-click to place`"
            @click="selected = selected === c.name ? null : c.name"
            @dblclick="assignFirst(c.name)"
            @dragstart="onSourceDragStart($event, c.name)"
          >
            <MeasureIcon :measure="c.measure" />
            <span class="var-name">{{ c.name }}</span>
            <span class="dtype-badge" :class="c.measure">{{ dtypeOf(c.name) }}</span>
          </button>
        </div>
      </div>

      <!-- Right Column: Target Dropzones & Parameters -->
      <div class="dlg-right">
        <div v-for="o in varOptions" :key="o.key" class="target-field">
          <div class="target-field-meta">
            <span :id="`lbl-${o.key}`" class="field-label">
              {{ o.label }}
              <span v-if="o.required" class="req-star" title="Required">*</span>
            </span>
            <span v-if="o.hint" class="field-hint">{{ cleanHint(o.hint) }}</span>
          </div>
          <div class="target-row">
            <div
              class="target-box"
              :class="{ 'drag-over': dragOver === o.key, 'has-value': o.kind === 'variable' ? !!values[o.key] : listFor(o.key).length > 0, 'is-active': activeTargetKey === o.key }"
              role="group"
              :aria-labelledby="`lbl-${o.key}`"
              :title="selected ? `Click to place '${selected}'` : 'Drag a variable here'"
              @click="onTargetClick(o.key)"
              @focusin="activeTargetKey = o.key"
              @dragover.prevent="dragOver = o.key"
              @dragleave="dragOver = null"
              @drop="onTargetDrop($event, o.key)"
            >
              <template v-if="o.kind === 'variable'">
                <span
                  v-if="values[o.key]"
                  class="token"
                  draggable="true"
                  :title="`${values[o.key]} - Drag to move or click × to remove`"
                  @dragstart="onTokenDragStart($event, o.key, values[o.key] as string)"
                >
                  <MeasureIcon v-if="measureOf(values[o.key] as string)" :measure="measureOf(values[o.key] as string)!" :show-title="false" />
                  <span class="token-name">{{ values[o.key] }}</span>
                  <button type="button" class="token-remove-btn" :aria-label="`Remove ${values[o.key]}`" title="Remove" @click.stop="unassign(o.key)">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </span>
                <div v-else class="target-empty-prompt">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 5v14M5 12h14"/>
                  </svg>
                  <span>Drop variable or click to assign</span>
                </div>
              </template>
              <template v-else>
                <span
                  v-for="name in listFor(o.key)"
                  :key="name"
                  class="token"
                  draggable="true"
                  :title="`${name} - Drag to move or click × to remove`"
                  @dragstart="onTokenDragStart($event, o.key, name)"
                >
                  <MeasureIcon v-if="measureOf(name)" :measure="measureOf(name)!" :show-title="false" />
                  <span class="token-name">{{ name }}</span>
                  <button type="button" class="token-remove-btn" :aria-label="`Remove ${name}`" title="Remove" @click.stop="unassign(o.key, name)">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </span>
                <div v-if="!listFor(o.key).length" class="target-empty-prompt">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 5v14M5 12h14"/>
                  </svg>
                  <span>Drop variables or click to assign</span>
                </div>
              </template>
            </div>
            <button
              type="button"
              class="shuttle-btn"
              :disabled="!selected || !acceptable(o, selected)"
              :title="selected ? `Place “${selected}” in ${o.label}` : 'Select a variable in the list first'"
              :aria-label="`Place the selected variable in ${o.label}`"
              @click="onTargetClick(o.key)"
            >▸</button>
          </div>

          <!-- Group levels are read live from the data; nothing here is serialized. -->
          <div v-if="levelSlot && o.key === levelSlot.key" class="groups-card">
            <template v-if="!groupLevelWarning">
              <span class="groups-card-label">Levels:</span>
              <span class="group-levels">
                <template v-if="groupLevels.length === 2">
                  <span class="group-level">{{ groupLevels[0].label }} (n = {{ groupLevels[0].n }})</span>
                  <span class="group-vs">vs.</span>
                  <span class="group-level">{{ groupLevels[1].label }} (n = {{ groupLevels[1].n }})</span>
                </template>
                <template v-else>
                  <span v-for="l in groupLevels" :key="l.value" class="group-level">
                    {{ l.label }} (n = {{ l.n }})
                  </span>
                </template>
              </span>
            </template>
            <p v-else class="groups-warning" role="status">{{ groupLevelWarning }}</p>
          </div>
        </div>

        <!-- Options Section: Modern card replacing archaic fieldset -->
        <div v-if="scalarOptions.length" class="options-panel">
          <div class="options-panel-header">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
            <span class="options-panel-title">Options &amp; Parameters</span>
          </div>
          <div class="options-panel-body">
            <template v-for="o in scalarOptions" :key="o.key">
              <div v-if="o.kind === 'number'" class="option-row">
                <div class="option-meta">
                  <label :for="`opt-${o.key}`" class="option-label">{{ o.label }}</label>
                  <span v-if="o.hint" class="option-hint">{{ o.hint }}</span>
                </div>
                <div class="option-control">
                  <input
                    :id="`opt-${o.key}`"
                    v-model.number="values[o.key]"
                    type="number"
                    step="any"
                    class="dialog-input option-number-input"
                  />
                </div>
              </div>
              <div v-else-if="o.kind === 'enum'" class="option-row">
                <div class="option-meta">
                  <label :for="`opt-${o.key}`" class="option-label">{{ o.label }}</label>
                  <span v-if="o.hint" class="option-hint">{{ o.hint }}</span>
                </div>
                <div class="option-control">
                  <select :id="`opt-${o.key}`" v-model="values[o.key]" class="dialog-select option-select">
                    <option v-for="choice in o.values" :key="choice" :value="choice">{{ choice }}</option>
                  </select>
                </div>
              </div>
              <label v-else-if="o.kind === 'boolean'" class="option-row is-checkbox">
                <div class="option-control-check">
                  <input :id="`opt-${o.key}`" v-model="values[o.key]" type="checkbox" class="option-checkbox" />
                </div>
                <div class="option-meta">
                  <span class="option-label">{{ o.label }}</span>
                  <span v-if="o.hint" class="option-hint">{{ o.hint }}</span>
                </div>
              </label>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- Dialog Footer -->
    <div class="dlg-foot">
      <div class="dlg-foot-status">
        <p v-if="!canRun" class="dlg-status is-warning" role="status">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <span>{{ problems[0] }}</span>
        </p>
        <p v-else class="dlg-status is-ready" role="status">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span>Ready to execute</span>
        </p>
        <div class="dlg-foot-extras">
          <span v-if="completeness" class="dlg-foot-completeness">
            Complete rows: {{ completeness.complete }}/{{ completeness.rows }}
          </span>
          <label class="dlg-foot-field">
            <span class="dlg-foot-field-label">Missing</span>
            <select v-model="missingPolicy" class="dialog-select dlg-policy-select" aria-label="Missing value handling">
              <option value="listwise">Listwise</option>
              <option value="pairwise">Pairwise</option>
            </select>
          </label>
          <label class="dlg-foot-field">
            <input v-model="includeChart" type="checkbox" class="option-checkbox" />
            <span class="dlg-foot-field-label">Companion plot</span>
          </label>
        </div>
      </div>
      <div class="dlg-foot-actions">
        <button type="button" class="btn" @click="dlg?.close()">Cancel</button>
        <button
          type="button"
          class="btn btn-primary"
          :disabled="!canRun"
          :title="canRun ? `Run ${schema?.title ?? ''}` : problems[0]"
          @click="run"
        >
          Run test
        </button>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.analysis-dialog {
  width: min(760px, calc(100vw - 32px));
  height: clamp(520px, 80vh, 720px);
  max-height: calc(100dvh - 36px);
  margin: auto;
  position: fixed;
  inset: 0;
  border-radius: 12px;
  border: 1px solid var(--line-strong);
  background: var(--panel);
  box-shadow: var(--shadow-lg), 0 20px 48px rgba(0, 0, 0, 0.38);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0;
}

.dlg-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-alt);
  position: relative;
}

.dlg-head-title-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
}

.analysis-head-icon {
  width: 28px;
  height: 28px;
  border-radius: 7px;
  background: var(--accent-soft);
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.dlg-head h3 {
  margin: 0;
  font-size: 14.5px;
  font-weight: 700;
  color: var(--text);
}

.dlg-head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.dlg-info-wrap {
  position: relative;
}

.dlg-info-btn {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: transparent;
  border: none;
  color: var(--muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.12s ease;
  padding: 0;
}

.dlg-info-btn:hover,
.dlg-info-btn:focus-visible {
  background: var(--accent-soft);
  color: var(--accent);
}

.dlg-info-popover {
  position: absolute;
  top: calc(100% + 8px);
  right: -4px;
  width: 360px;
  max-width: calc(100vw - 48px);
  background: var(--panel);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg), 0 12px 32px rgba(0, 0, 0, 0.45);
  z-index: 100;
  overflow: hidden;
  animation: popoverFadeIn 0.14s ease-out;
}

@keyframes popoverFadeIn {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.popover-head {
  padding: 10px 14px;
  background: var(--panel-alt);
  border-bottom: 1px solid var(--line);
}

.popover-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--accent);
}

.popover-content {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.popover-desc {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text);
}

.popover-howto-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--line);
}

.popover-howto-title {
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
}

.popover-howto-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.popover-howto-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--text);
}

.howto-item-badge {
  flex: 0 0 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 10px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 1px;
}

.howto-item-text {
  flex: 1;
}

.dlg-close-x {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: transparent;
  border: none;
  color: var(--muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.12s ease;
  padding: 0;
}

.dlg-close-x:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.dlg-body {
  display: flex;
  gap: 16px;
  padding: 14px 18px 16px;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

.dlg-left {
  flex: 0 0 240px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.var-filter-input {
  height: 28px !important;
  font-size: 11.5px;
}

.var-filter-input::-webkit-search-cancel-button {
  cursor: pointer;
}

.var-filter-clear {
  display: block;
  margin: 6px auto 0;
  padding: 0;
  border: none;
  background: none;
  color: var(--accent);
  font-size: 11.5px;
  text-decoration: underline;
  cursor: pointer;
}

.field-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-bottom: 2px;
}

.field-label {
  font-size: 11px;
  font-weight: 700;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.req-star {
  color: var(--accent);
  font-weight: 700;
  margin-left: 2px;
}

.var-count-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 100px;
  background: var(--line);
  color: var(--muted);
}

.var-list {
  flex: 1 1 auto;
  height: 320px;
  min-height: 220px;
  overflow-y: auto;
  background: var(--panel-alt);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-md);
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.analysis-empty {
  padding: 16px 12px;
  font-size: 12px;
  color: var(--muted);
  text-align: center;
}

.var-row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  transition: all 0.1s ease;
  user-select: none;
  width: 100%;
  box-sizing: border-box;
}

.var-row:hover {
  background: var(--surface-hover);
}

.var-row[aria-pressed="true"] {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}

.var-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
}

.dtype-badge {
  font-size: 9.5px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--line);
  color: var(--muted);
  text-transform: uppercase;
  font-family: var(--font-mono);
  letter-spacing: 0.03em;
}

.dlg-right {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.target-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.target-field-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.target-field-meta .field-label {
  font-size: 11px;
  font-weight: 700;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.target-field-meta .field-hint {
  font-size: 11.5px;
  color: var(--text-dim);
  font-weight: 400;
  line-height: 1.35;
}

.target-box {
  width: 100%;
  min-height: 52px;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  border: 1.5px dashed var(--line-strong);
  background: var(--panel-alt);
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  transition: all 0.15s ease;
  cursor: pointer;
  box-sizing: border-box;
}

.target-box.has-value {
  border-style: solid;
  border-color: var(--line-strong);
  background: var(--panel);
}

.target-box.drag-over {
  border-color: var(--accent);
  border-style: solid;
  background: var(--accent-soft);
  box-shadow: 0 0 0 3px var(--accent-light);
}

.target-empty-prompt {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 11.5px;
  font-style: normal;
  pointer-events: none;
}

.token {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--surface);
  border: 1px solid var(--accent);
  border-radius: 6px;
  padding: 3px 6px 3px 9px;
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 500;
  box-shadow: var(--shadow-sm);
  cursor: grab;
}

.token:active {
  cursor: grabbing;
}

.token-remove-btn {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
  transition: all 0.1s ease;
}

.token-remove-btn:hover {
  background: var(--err-bg);
  color: var(--err);
}

.target-row {
  display: flex;
  align-items: stretch;
  gap: 6px;
}

.target-row .target-box {
  flex: 1 1 auto;
  min-width: 0;
}

/* ▸ shuttle button (design.md §4.4) */
.shuttle-btn {
  flex: 0 0 28px;
  width: 28px;
  border-radius: var(--radius-md);
  border: 1px solid var(--line-strong);
  background: var(--panel-alt);
  color: var(--muted);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  transition: all 0.12s ease;
  padding: 0;
}

.shuttle-btn:hover:not(:disabled),
.shuttle-btn:focus-visible:not(:disabled) {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.shuttle-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.target-box.is-active {
  border-color: var(--accent);
}

.var-row.is-incompatible {
  opacity: 0.45;
}

.dlg-foot-extras {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 4px;
}

.dlg-foot-completeness {
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.dlg-foot-field {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--muted);
  cursor: pointer;
  user-select: none;
}

.dlg-foot-field-label {
  white-space: nowrap;
}

.dlg-policy-select {
  height: 24px;
  font-size: 11px;
  padding: 0 4px;
}

.groups-card {
  margin-top: 6px;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  background: var(--panel-alt);
  border: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
}

.groups-card-label {
  font-weight: 500;
  color: var(--text-secondary);
}

.group-levels {
  display: flex;
  align-items: center;
  gap: 8px;
  font-variant-numeric: tabular-nums;
  color: var(--ok);
  font-weight: 600;
}

.group-vs {
  color: var(--muted);
  font-weight: 500;
}

.group-level {
  color: var(--text);
}

.groups-warning {
  margin: 0;
  flex: 1;
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--warn);
}

/* Options Panel */
.options-panel {
  border-radius: var(--radius-md);
  background: var(--panel-alt);
  border: 1px solid var(--line);
  overflow: hidden;
}

.options-panel-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: var(--surface-hover);
  border-bottom: 1px solid var(--line);
  color: var(--muted);
}

.options-panel-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
}

.options-panel-body {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.option-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 32px;
}

.option-row.is-checkbox {
  cursor: pointer;
  justify-content: flex-start;
  gap: 10px;
  user-select: none;
}

.option-meta {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}

.option-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  cursor: inherit;
}

.option-hint {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.3;
}

.option-control {
  flex-shrink: 0;
}

.option-number-input {
  width: 120px !important;
  height: 32px !important;
  text-align: right;
  font-weight: 600;
  font-family: var(--font-mono);
}

.option-select {
  min-width: 140px;
  height: 32px;
}

.option-control-check {
  display: flex;
  align-items: center;
}

.option-checkbox {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
  cursor: pointer;
}

/* Footer */
.dlg-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  border-top: 1px solid var(--line);
  background: var(--panel-alt);
  gap: 12px;
}

.dlg-foot-status {
  display: flex;
  align-items: center;
  min-width: 0;
  flex: 1;
}

.dlg-status {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 11.5px;
  font-weight: 500;
  line-height: 1.3;
}

.dlg-status.is-warning {
  color: var(--warn);
}

.dlg-status.is-ready {
  color: var(--ok);
}

.dlg-foot-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

@media (max-width: 580px) {
  .analysis-dialog {
    width: calc(100vw - 16px);
  }
  .dlg-body {
    flex-wrap: wrap;
    padding: 12px;
    gap: 12px;
  }
  .dlg-left, .dlg-right {
    flex-basis: 100%;
  }
  .var-list {
    height: 180px;
  }
}
</style>
