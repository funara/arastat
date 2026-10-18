<script setup lang="ts">
// Generic schema-driven analysis options dialog (arch §7): one component renders all
// 25 analysis specs. Native <dialog>.showModal() provides Esc-to-close and native focus
// return to the invoking control.
import { ref, computed, watch, nextTick } from 'vue'
import { state, isUserMissing } from './store.ts'
import { defaultValues, validateValues, type AnalysisSchema, type SpecOption } from './specs.ts'
import { storageShort, type Measure } from './io/types.ts'
import { flagStale } from './results.ts'
import MeasureIcon from './MeasureIcon.vue'

const props = defineProps<{ schema: AnalysisSchema | null; initial?: Record<string, unknown> }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'run', payload: { schema: AnalysisSchema; values: Record<string, unknown> }): void
}>()

const dlg = ref<HTMLDialogElement | null>(null)
const values = ref<Record<string, unknown>>({})
const selected = ref<string | null>(null)
const dragOver = ref<string | null>(null)
// Filter text and the active token pill are dialog-only state: the registry rejects
// unknown spec keys (1001), so neither ever serializes into `values`.
const variableFilter = ref('')
const activeToken = ref<{ key: string; name: string } | null>(null)

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
watch([() => props.schema, () => props.initial], ([s]) => {
  if (!s) {
    dlg.value?.close()
    return
  }
  seeding = true
  values.value = defaultValues(s, props.initial)
  seeding = false
  selected.value = null
  dragOver.value = null
  variableFilter.value = ''
  activeToken.value = null
  nextTick(() => {
    const el = dlg.value
    if (el && !el.open) el.showModal()
  })
}, { immediate: true })

// Stale on option edit: a user change dims the latest settled result for this
// analysis until it is rerun. Seeding is not an edit.
watch(values, () => {
  if (seeding || !props.schema) return
  flagStale(props.schema.id, { ...values.value })
}, { deep: true, flush: 'sync' })

function onClose(): void {
  selected.value = null
  activeToken.value = null
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

// --- Shuttle buttons (SPSS/JASP move arrows) --------------------------------
// One token can be "active" at a time: its field's arrow flips to ◂ so the very
// same control also moves the variable back out. Dialog-only state, never values.

function toggleToken(key: string, name: string): void {
  const t = activeToken.value
  activeToken.value = t && t.key === key && t.name === name ? null : { key, name }
}

function shuttleMode(o: SpecOption): 'assign' | 'unassign' {
  return activeToken.value?.key === o.key ? 'unassign' : 'assign'
}

/** Why ▸ cannot fire, or '' when it can. Keeps the disabled button explainable. */
function shuttleBlock(o: SpecOption): string {
  const t = activeToken.value
  if (t) return `Move “${t.name}” out first (◂)`
  const name = selected.value
  if (!name) return 'Select a variable in Available Variables first'
  if (!acceptable(o, name)) return `${name} is not a valid ${o.label}`
  if (o.kind === 'variable') return values.value[o.key] ? `${o.label} already has ${values.value[o.key]}` : ''
  const cur = listFor(o.key)
  if (cur.includes(name)) return `${name} is already in ${o.label}`
  if (o.max !== undefined && cur.length >= o.max) return `${o.label} is full (max ${o.max})`
  return ''
}

function shuttleDisabled(o: SpecOption): boolean {
  return shuttleMode(o) === 'assign' && shuttleBlock(o) !== ''
}

function shuttleLabel(o: SpecOption): string {
  const t = activeToken.value
  if (t && t.key === o.key) return `Unassign ${t.name}`
  return `Assign ${selected.value ?? 'variable'} to ${o.label}`
}

function shuttleTitle(o: SpecOption): string {
  return shuttleDisabled(o) ? shuttleBlock(o) : shuttleLabel(o)
}

/** The ▸ / ◂ action: reuses assignTo/unassign so measure gating and max hold. */
function onShuttle(o: SpecOption): void {
  const t = activeToken.value
  if (t && t.key === o.key) {
    unassign(o.key, t.name)
    return
  }
  if (selected.value) assignTo(o.key, selected.value)
}

function assignTo(key: string, name?: string): boolean {
  const opt = props.schema?.options.find((o) => o.key === key)
  const target = name ?? selected.value
  if (!opt || !acceptable(opt, target)) return false
  if (opt.kind === 'variable') {
    values.value[key] = target
    // A click-to-assign can overwrite a pill that was mid-move; drop the stale
    // activation so ◂ never points at a variable that is no longer there.
    const t = activeToken.value
    if (t && t.key === key && t.name !== target) activeToken.value = null
    return true
  }
  const cur = listFor(key)
  if (cur.includes(target!)) return false
  if (opt.max !== undefined && cur.length >= opt.max) return false
  values.value[key] = [...cur, target!]
  return true
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
  // Every removal path (× button, drag-out, shuttle ◂) drops the activation too.
  const t = activeToken.value
  if (t && t.key === key && (opt.kind === 'variable' || t.name === name)) activeToken.value = null
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

// --- Group levels (live, read-only) ----------------------------------------
// The `group` option is the two-group slot (ttest_independent, mannwhitney_u).
// Its levels are computed from the assigned column's own data, so the guard is
// about the column, not the analysis id — a different analysis with a 3-level
// `factor` (ANOVA, Kruskal-Wallis) is untouched.

/** Assigned `group` column name, or '' when this analysis has no group slot. */
const groupCol = computed(() => {
  const opt = varOptions.value.find((o) => o.key === 'group')
  const name = opt ? values.value[opt.key] : null
  return typeof name === 'string' ? name : ''
})

/**
 * Distinct non-missing levels with counts in first-appearance order (statslib.py
 * `levels()` uses the same order, so this preview matches the eventual run).
 */
const groupLevels = computed<Array<{ value: string; n: number }>>(() => {
  const name = groupCol.value
  if (!name) return []
  const meta = state.ds.columns.find((c) => c.name === name)
  const out: Array<{ value: string; n: number }> = []
  const at = new Map<string, number>()
  for (const v of state.ds.data[name] ?? []) {
    // null and '' are missing here as well as under the column's own rules.
    if (v === null || v === '' || (meta && isUserMissing(meta, v))) continue
    const key = String(v)
    const i = at.get(key)
    if (i === undefined) {
      at.set(key, out.length)
      out.push({ value: key, n: 1 })
    } else out[i].n++
  }
  return out
})

/** Pre-flight replacement for engine error 1004: never run a non-2-level grouping variable. */
const groupLevelWarning = computed(() => {
  const name = groupCol.value
  if (!name || groupLevels.value.length === 2) return ''
  const title = props.schema?.title ?? 'This test'
  const levels = groupLevels.value
  const listed = levels.map((l) => l.value).join(', ')
  if (!levels.length) return `Column '${name}' has no non-missing values. ${title} needs a grouping column with data — choose another column.`
  if (levels.length === 1) return `Column '${name}' has 1 distinct group (${listed}). ${title} requires exactly 2 groups — define a second group or choose another column.`
  return `Column '${name}' has ${levels.length} distinct groups (${listed}). ${title} requires exactly 2 groups — use One-Way ANOVA instead.`
})

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
  emit('run', { schema: props.schema, values: { ...values.value } })
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
      <button type="button" class="dlg-close-x" title="Close (Esc)" aria-label="Close" @click="dlg?.close()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>

    <!-- Polished Guide Callout -->
    <div v-if="schema?.howTo || schema?.description" class="dlg-guide-banner">
      <div class="guide-icon" aria-hidden="true">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      </div>
      <div class="guide-body">
        <span class="guide-text">{{ schema?.howTo ?? schema?.description }}</span>
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
            draggable="true"
            :aria-pressed="selected === c.name"
            :title="`${c.name} (${c.type}, ${c.measure}) - Click to select or double-click to place`"
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
          <div class="field-header">
            <span :id="`lbl-${o.key}`" class="field-label">
              {{ o.label }}
              <span v-if="o.required" class="req-star" title="Required">*</span>
            </span>
            <span v-if="o.hint" class="field-hint">{{ o.hint }}</span>
          </div>
          <div class="target-row">
            <div
              class="target-box"
              :class="{ 'drag-over': dragOver === o.key, 'has-value': o.kind === 'variable' ? !!values[o.key] : listFor(o.key).length > 0 }"
              role="group"
              :aria-labelledby="`lbl-${o.key}`"
              :title="selected ? `Click to place '${selected}'` : 'Drag a variable here'"
              @click="assignTo(o.key)"
              @dragover.prevent="dragOver = o.key"
              @dragleave="dragOver = null"
              @drop="onTargetDrop($event, o.key)"
            >
              <template v-if="o.kind === 'variable'">
                <!-- The token carries a real remove <button>, so it is not itself a
                     role=button (nested interactive content is invalid). Activation
                     is a mouse convenience; the keyboard path is the × and the ◂
                     shuttle button, which owns the aria-pressed state. -->
                <span
                  v-if="values[o.key]"
                  class="token"
                  :class="{ 'is-active': activeToken?.key === o.key }"
                  draggable="true"
                  :title="`${values[o.key]} - click to select, then use ◂ to move it back`"
                  @dragstart="onTokenDragStart($event, o.key, values[o.key] as string)"
                  @click.stop="toggleToken(o.key, values[o.key] as string)"
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
                  :class="{ 'is-active': activeToken?.key === o.key && activeToken?.name === name }"
                  draggable="true"
                  :title="`${name} - click to select, then use ◂ to move it back`"
                  @dragstart="onTokenDragStart($event, o.key, name)"
                  @click.stop="toggleToken(o.key, name)"
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
            <!-- SPSS/JASP shuttle arrow: ▸ moves the selected source variable in, ◂ on
                 an active token moves that variable back out. -->
            <button
              type="button"
              class="shuttle-btn"
              :class="{ 'is-remove': shuttleMode(o) === 'unassign' }"
              :disabled="shuttleDisabled(o)"
              :aria-pressed="shuttleMode(o) === 'unassign'"
              :aria-label="shuttleLabel(o)"
              :title="shuttleTitle(o)"
              @click.stop="onShuttle(o)"
            >
              {{ shuttleMode(o) === 'unassign' ? '◂' : '▸' }}
            </button>
          </div>

          <!-- Group levels are read live from the data; nothing here is serialized. -->
          <div v-if="o.key === 'group' && values[o.key]" class="groups-card">
            <template v-if="groupLevels.length === 2">
              <span class="groups-card-label">Levels:</span>
              <span class="group-levels">
                <span class="group-level">{{ groupLevels[0].value }} (n = {{ groupLevels[0].n }})</span>
                <span class="group-vs">vs.</span>
                <span class="group-level">{{ groupLevels[1].value }} (n = {{ groupLevels[1].n }})</span>
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
  width: min(740px, calc(100vw - 32px));
  max-height: min(660px, calc(100dvh - 48px));
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

/* Guide banner */
.dlg-guide-banner {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 14px;
  margin: 12px 18px 0;
  background: var(--accent-soft);
  border: 1px solid rgba(35, 103, 236, 0.18);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius-md);
  font-size: 12px;
  line-height: 1.45;
  color: var(--text);
}

.guide-icon {
  color: var(--accent);
  flex-shrink: 0;
  margin-top: 1px;
}

.guide-body {
  flex: 1;
}

.guide-text {
  font-size: 12px;
  line-height: 1.45;
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
  gap: 4px;
}

.field-hint {
  font-size: 11px;
  color: var(--muted);
  font-weight: normal;
  text-transform: none;
  letter-spacing: normal;
}

.target-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.shuttle-btn {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line-strong);
  background: var(--panel-alt);
  color: var(--accent);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  transition: all 0.12s ease;
}

.shuttle-btn:hover:not(:disabled) {
  background: var(--accent-soft);
  border-color: var(--accent);
}

.shuttle-btn:disabled {
  color: var(--muted);
  opacity: 0.5;
  cursor: not-allowed;
}

.shuttle-btn.is-remove {
  color: var(--text);
}

.target-box {
  min-height: 52px;
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
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
  box-shadow: 0 0 0 3px rgba(35, 103, 236, 0.15);
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

/* Active token: the ◂ arrow in its field is now enabled for the move-back. */
.token.is-active {
  background: var(--accent-soft);
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.token.is-active .token-name {
  font-weight: 700;
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
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
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
  color: var(--ok, #10b981);
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
