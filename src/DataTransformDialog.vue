<script setup lang="ts">
// Data & Transform dialog (Phase 8 §8.2.E): one themed home for the operations
// that used to be window.prompt() boxes plus the two dead-end menu items.
// Modes mirror the menu items that open them; every mode commits through the
// store, so each action is exactly ONE undo step.
import { computed, nextTick, ref, watch } from 'vue'
import {
  state,
  rowCount,
  batchCells,
  isUserMissing,
  transformColumn,
  setDataset,
  insertColumnAt,
  setMeta,
  type Cell,
} from './store.ts'
import type { ColumnValues } from './io/types.ts'
import { computeFill, rowsWithMissing, type FillMode } from './missing.ts'
import { computeRecodeValues, type RecodeRule } from './transforms.ts'
import { evalExprTokens, tokenizeExpr } from './expr.ts'

export type TransformMode = 'compute' | 'transform' | 'sort-drop' | 'recode' | 'find'

const props = withDefaults(
  defineProps<{ open: boolean; mode?: TransformMode; column?: string; recodeNew?: boolean }>(),
  { mode: 'compute', column: '', recodeNew: true }
)

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'done', message: string): void
  /** A Find hit: the caller reveals that column in the Data View. */
  (e: 'find-hit', column: string): void
}>()

const dlg = ref<HTMLDialogElement | null>(null)
const mode = ref<TransformMode>(props.mode)

/* Shared status line: every action reports here instead of a toast, so the
   dialog stays the single place a user watches an operation land. Returns
   `false` so guards can `return say(...)` in one statement. */
const status = ref('')
const statusOk = ref(true)
function say(message: string, ok = true): false {
  status.value = message
  statusOk.value = ok
  return false
}

const numericCols = computed(() => state.ds.columns.filter((c) => c.type === 'numeric'))
/** Source column for the single-column operations (transform, recode, sort). */
const sourceCol = ref('')
/** Target for recode / a new computed column. */
const targetCol = ref('')

watch(
  () => props.open,
  (open) => {
    if (!open) return
    mode.value = props.mode
    status.value = ''
    recodeIntoNew.value = props.recodeNew
    sourceCol.value =
      props.column && state.ds.columns.some((c) => c.name === props.column)
        ? props.column
        : (numericCols.value[0]?.name ?? state.ds.columns[0]?.name ?? '')
    targetCol.value = ''
    void nextTick(() => {
      const el = dlg.value
      if (el && !el.open) el.showModal()
    })
  },
  { immediate: true }
)

function close(): void {
  dlg.value?.close()
}

function onBackdropClick(e: MouseEvent): void {
  const el = dlg.value
  if (!el || e.target !== el) return
  const r = el.getBoundingClientRect()
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) el.close()
}

function column(name: string): Cell[] {
  return (state.ds.data[name] as Cell[] | undefined) ?? []
}

function metaOf(name: string) {
  return state.ds.columns.find((c) => c.name === name)
}

function missingIn(name: string): (v: Cell) => boolean {
  const meta = metaOf(name)
  return meta ? (v: Cell) => isUserMissing(meta, v) : (v: Cell) => v === null || v === ''
}

const TABS: Array<{ id: TransformMode; label: string }> = [
  { id: 'compute', label: 'Compute' },
  { id: 'transform', label: 'Transform' },
  { id: 'recode', label: 'Recode' },
  { id: 'sort-drop', label: 'Sort & Filter' },
  { id: 'find', label: 'Find' },
]

function tabKeyNav(e: KeyboardEvent): void {
  const idx = TABS.findIndex((t) => t.id === mode.value)
  if (idx < 0) return
  let next = idx
  if (e.key === 'ArrowRight') next = (idx + 1) % TABS.length
  else if (e.key === 'ArrowLeft') next = (idx - 1 + TABS.length) % TABS.length
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = TABS.length - 1
  else return
  e.preventDefault()
  mode.value = TABS[next]!.id
  status.value = ''
  const container = e.currentTarget as HTMLElement | null
  void nextTick(() => {
    container?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  })
}

/* ---------------------------------------------------------------- compute -- */
const formula = ref('')
const computePreview = computed(() => {
  const eq = formula.value.indexOf('=')
  if (eq < 1) return { error: 'Use the form  name = expression', rows: [] as Array<[number, number | null]> }
  const target = formula.value.slice(0, eq).trim()
  const expr = formula.value.slice(eq + 1).trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(target)) {
    return { error: 'The column name must start with a letter and use letters, digits, or underscores.', rows: [] }
  }
  const tokens = tokenizeExpr(expr)
  if (!tokens.length) {
    return { error: 'The expression may use column names, numbers, and + - * / ( ).', rows: [] }
  }
  const unknown = [...new Set(tokens.filter((t) => /^[A-Za-z_]/.test(t)))].filter(
    (t) => !state.ds.columns.some((c) => c.name === t)
  )
  if (unknown.length) return { error: `Unknown column in expression: ${unknown[0]}.`, rows: [] }
  const probeVars: Record<string, number | string | null> = {}
  for (const c of state.ds.columns) probeVars[c.name] = 1
  if (evalExprTokens(tokens, probeVars) === null) {
    return { error: 'The expression could not be parsed. Check the syntax.', rows: [] }
  }
  const rows: Array<[number, number | null]> = []
  for (let r = 0; r < rowCount.value && rows.length < 5; r++) {
    const row: Record<string, number | string | null> = {}
    for (const c of state.ds.columns) row[c.name] = (state.ds.data[c.name] as Array<Cell>)[r] ?? null
    const out = evalExprTokens(tokens, row)
    rows.push([r + 1, out === null || !Number.isFinite(out) ? null : out])
  }
  return { error: null, target, expr, tokens, rows }
})

function runCompute() {
  const p = computePreview.value
  if (p.error || !p.target || !p.expr || !p.tokens) return say(p.error ?? 'Check the expression.', false)
  const values: Array<number | null> = []
  for (let r = 0; r < rowCount.value; r++) {
    const row: Record<string, number | string | null> = {}
    for (const c of state.ds.columns) row[c.name] = (state.ds.data[c.name] as Array<Cell>)[r] ?? null
    const out = evalExprTokens(p.tokens, row)
    values.push(out === null || !Number.isFinite(out) ? null : out)
  }
  const existing = state.ds.columns.findIndex((c) => c.name === p.target)
  if (existing >= 0) {
    batchCells(values.map((v, r) => ({ col: p.target as string, row: r, next: v })))
  } else {
    insertComputedColumn(p.target, values)
  }
  say(`Computed ${p.target}.`)
}

// The store's insertColumnAt wraps the colAdd commit, so a recoded/computed
// column lands as exactly one undo step, like the built-in transforms.
function insertComputedColumn(name: string, values: Array<number | null>): void {
  const meta = state.ds.columns.find((c) => c.name === name)
  if (meta) return
  insertColumnAt(state.ds.columns.length, { name, type: 'numeric', measure: 'scale', decimals: 2 }, values as ColumnValues)
  state.computedFormulas.push(`${name} = ${formula.value.slice(formula.value.indexOf('=') + 1).trim()}`)
}

/* -------------------------------------------------------------- transform -- */
type TransformKind = 'log' | 'standardize' | 'bin'
const transformKind = ref<TransformKind>('log')
const bins = ref(5)

const TRANSFORMS: Array<{ id: TransformKind; label: string; hint: string }> = [
  { id: 'log', label: 'Log transform', hint: 'Natural log into a new column' },
  { id: 'standardize', label: 'Standardize (Z-score)', hint: 'Sample SD, new column' },
  { id: 'bin', label: 'Bin into equal groups', hint: 'Equal-width bins into a new column' },
]

function runTransform() {
  if (!sourceCol.value) return say('Choose a column to transform.', false)
  const res = transformColumn(sourceCol.value, transformKind.value, { bins: bins.value })
  say(res.message, res.ok)
}

/* ----------------------------------------------------------- fill missing -- */
const fillMethod = ref<FillMode>('mean')

function runFill() {
  const name = sourceCol.value
  const meta = metaOf(name)
  if (!meta) return say('Choose a column to fill.', false)
  const vals = column(name)
  const isMissing = missingIn(name)

  if (fillMethod.value !== 'mode' && meta.type !== 'numeric') {
    return say('Mean and median need a numeric column. Use mode.', false)
  }
  const fill = computeFill(vals, fillMethod.value, isMissing)
  if (fill === null) return say(`No fill value: ${name} has no valid values, or the mode is tied.`, false)
  const edits: Array<{ col: string; row: number; next: Cell }> = []
  vals.forEach((v, row) => {
    if (isMissing(v)) edits.push({ col: name, row, next: fill })
  })
  if (!edits.length) return say(`${name} has no missing values.`, false)
  batchCells(edits)
  say(`Filled ${edits.length} missing in ${name} (${fillMethod.value} = ${String(fill)}).`)
}

/* ----------------------------------------------------------------- recode -- */
const recodeRules = ref<RecodeRule[]>([{ from: '', to: '' }])
const recodeIntoNew = ref(true)
const recodeNewName = ref('')

function addRule(): void {
  recodeRules.value = [...recodeRules.value, { from: '', to: '' }]
}
function removeRule(i: number): void {
  recodeRules.value = recodeRules.value.filter((_, idx) => idx !== i)
}

/** Distinct non-missing values of the source, so rules can be filled by hand. */
const sourceLevels = computed(() => {
  const name = sourceCol.value
  if (!name) return []
  const isMissing = missingIn(name)
  const seen: string[] = []
  for (const v of column(name)) {
    if (isMissing(v)) continue
    const s = String(v)
    if (!seen.includes(s)) seen.push(s)
    if (seen.length >= 40) break
  }
  return seen
})

function runRecode() {
  const name = sourceCol.value
  const meta = metaOf(name)
  if (!meta) return say('Choose a column to recode.', false)
  const target = recodeIntoNew.value ? recodeNewName.value.trim() : name
  if (!target) return say('Name the new column.', false)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(target)) {
    return say('The column name must start with a letter and use letters, digits, or underscores.', false)
  }
  if (target !== name && state.ds.columns.some((c) => c.name === target)) {
    return say(`A column named ${target} already exists.`, false)
  }
  const res = computeRecodeValues(
    column(name),
    missingIn(name),
    recodeRules.value,
    // Numeric output is possible when the source is numeric OR every mapped
    // target is itself a number (coding categories to 1/2/3 gives a numeric
    // column, which is what downstream tests expect).
    meta.type === 'numeric' ||
      recodeRules.value.some((r) => r.to.trim() !== '') &&
        recodeRules.value.every((r) => r.to.trim() === '' || Number.isFinite(Number(r.to.trim())))
  )
  if (res.error) return say(res.error, false)
  if (!res.changed) return say('No cell matched a rule; nothing changed.', false)

  // A purely numeric result is stored as a numeric column whichever way the
  // source was typed; anything else inherits the source's storage type.
  const numericResult = res.values.every((v) => v === null || typeof v === 'number')
  const outType = numericResult ? 'numeric' : meta.type
  if (target === name) {
    const edits: Array<{ col: string; row: number; next: Cell }> = []
    const before = column(name)
    res.values.forEach((next, row) => {
      if ((before[row] ?? null) !== (next ?? null)) edits.push({ col: name, row, next })
    })
    batchCells(edits)
    if (numericResult && meta.type !== 'numeric') setMeta(name, 'type', 'numeric')
  } else {
    const base = metaOf(name)
    insertColumnAt(state.ds.columns.length, {
      name: target,
      type: outType,
      measure: numericResult && meta.measure === 'nominal' ? 'ordinal' : meta.measure,
      decimals: numericResult ? (base?.decimals ?? 2) : 0,
    }, res.values as ColumnValues)
  }
  say(`Recoded ${res.changed} cells into ${target}.`)
}

/* ------------------------------------------------------------- sort & drop -- */
const sortAsc = ref(true)
function runSort() {
  const name = sourceCol.value
  if (!name || !metaOf(name)) return say('Choose a column to sort by.', false)
  const order = state.ds.columns.map((c) => c.name)
  const idx = [...Array(rowCount.value).keys()].sort((a, b) => {
    const va = state.ds.data[name]?.[a] ?? null
    const vb = state.ds.data[name]?.[b] ?? null
    if (va === null && vb === null) return 0
    if (va === null) return 1 // missing always sorts last, like SPSS
    if (vb === null) return -1
    const cmp =
      typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))
    return sortAsc.value ? cmp : -cmp
  })
  const data: Record<string, ColumnValues> = {}
  for (const col of order) {
    data[col] = column(col)
      .map((_, r) => idx[r])
      .map((i) => column(col)[i] ?? null) as ColumnValues
  }
  setDataset({ columns: state.ds.columns.map((c) => ({ ...c })), data })
  say(`Sorted by ${name} (${sortAsc.value ? 'ascending' : 'descending'}).`)
}

/** Columns chosen for the drop; empty means every column. */
const dropCols = ref<string[]>([])
const dropCandidates = computed(() => (dropCols.value.length ? dropCols.value : state.ds.columns.map((c) => c.name)))
const affectedRows = computed(() => {
  if (!rowCount.value) return 0
  return rowsWithMissing(state.ds.data as Record<string, Cell[]>, dropCandidates.value, (col, v) => missingIn(col)(v)).length
})

function toggleDropCol(name: string): void {
  dropCols.value = dropCols.value.includes(name)
    ? dropCols.value.filter((n) => n !== name)
    : [...dropCols.value, name]
}

function runDrop() {
  if (!rowCount.value) return say('No rows to drop.', false)
  const cols = dropCandidates.value
  const drop = new Set(
    rowsWithMissing(state.ds.data as Record<string, Cell[]>, cols, (col, v) => missingIn(col)(v))
  )
  if (!drop.size) return say('No rows with missing values.', false)
  const kept: Record<string, ColumnValues> = {}
  for (const c of state.ds.columns) {
    kept[c.name] = column(c.name).filter((_, r) => !drop.has(r)) as ColumnValues
  }
  setDataset({ columns: state.ds.columns.map((c) => ({ ...c })), data: kept })
  say(`Dropped ${drop.size} row${drop.size === 1 ? '' : 's'} with missing values.`)
}

/* ------------------------------------------------------------------- find -- */
// Find scrolls the Data View to the first matching cell. The grid reads the
// store, so the hit is reported here and the view switch is the caller's job.
const findQuery = ref('')
const findHits = computed(() => {
  const q = findQuery.value.trim().toLowerCase()
  if (!q) return [] as Array<{ col: string; row: number; value: string }>
  const hits: Array<{ col: string; row: number; value: string }> = []
  for (const c of state.ds.columns) {
    const isMissing = missingIn(c.name)
    const vals = column(c.name)
    for (let r = 0; r < vals.length; r++) {
      const v = vals[r]
      if (isMissing(v)) continue
      const s = String(v)
      if (s.toLowerCase().includes(q)) hits.push({ col: c.name, row: r + 1, value: s })
      if (hits.length >= 200) return hits
    }
  }
  return hits
})

function runFind() {
  if (!findQuery.value.trim()) return say('Type something to find.', false)
  const n = findHits.value.length
  if (!n) return say('No matching cells.', false)
  say(`${n} matching cell${n === 1 ? '' : 's'} found. The first hit's column is shown in Data View.`)
  emit('find-hit', findHits.value[0]!.col)
}
</script>

<template>
  <dialog
    ref="dlg"
    class="settings-dlg transform-dlg"
    aria-labelledby="transformTitle"
    @click="onBackdropClick($event)"
    @close="emit('close')"
  >
    <div class="ara-modal-head">
      <div class="ara-modal-title-wrap">
        <div class="ara-modal-badge" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 20V4l8 8 8-8v16" />
          </svg>
        </div>
        <h3 id="transformTitle">Data &amp; Transform</h3>
      </div>
      <button type="button" class="ara-modal-close" title="Close (Esc)" aria-label="Close" @click="close">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>

    <div class="ara-tabs" role="tablist" aria-label="Data and transform modes" @keydown="tabKeyNav">
      <button
        v-for="t in TABS"
        :key="t.id"
        type="button"
        role="tab"
        class="ara-tab"
        :class="{ 'is-active': mode === t.id }"
        :aria-selected="mode === t.id"
        :tabindex="mode === t.id ? 0 : -1"
        @click="mode = t.id; status = ''"
      >
        {{ t.label }}
      </button>
    </div>

    <div class="ara-modal-body">
      <!-- COMPUTE ------------------------------------------------------------ -->
      <template v-if="mode === 'compute'">
        <div class="tf-field">
          <label for="tfFormula">Target = expression</label>
          <input
            id="tfFormula"
            v-model="formula"
            class="dialog-input tf-input"
            placeholder="total = pre_test + post_test"
            spellcheck="false"
          />
          <p class="tf-hint">
            Use column names, numbers, and + - * / ^ ( ). Missing cells propagate as missing.
          </p>
        </div>
        <div class="tf-preview">
          <span class="tf-preview-title">Preview (first rows)</span>
          <p v-if="computePreview.error" class="tf-error">{{ computePreview.error }}</p>
          <table v-else class="tf-preview-table">
            <thead>
              <tr><th scope="col">Row</th><th scope="col">{{ computePreview.target }}</th></tr>
            </thead>
            <tbody>
              <tr v-for="[r, v] in computePreview.rows" :key="r">
                <td>{{ r }}</td>
                <td>{{ v === null ? 'missing' : v }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="tf-actions">
          <button type="button" class="btn btn-primary" :disabled="!!computePreview.error" @click="runCompute">
            Compute column
          </button>
        </div>
      </template>

      <!-- TRANSFORM ---------------------------------------------------------- -->
      <template v-else-if="mode === 'transform'">
        <div class="tf-field">
          <label for="tfSrc">Column</label>
          <select id="tfSrc" v-model="sourceCol" class="dialog-select">
            <option v-for="c in state.ds.columns" :key="c.name" :value="c.name">
              {{ c.name }}{{ c.type === 'numeric' ? '' : ' (not numeric)' }}
            </option>
          </select>
        </div>
        <div class="tf-field">
          <span class="tf-label">Operation</span>
          <div class="tf-radio-list">
            <label v-for="t in TRANSFORMS" :key="t.id" class="tf-radio">
              <input v-model="transformKind" type="radio" :value="t.id" />
              <span><strong>{{ t.label }}</strong><em>{{ t.hint }}</em></span>
            </label>
          </div>
        </div>
        <div v-if="transformKind === 'bin'" class="tf-field">
          <label for="tfBins">Number of bins (2–20)</label>
          <input id="tfBins" v-model.number="bins" type="number" min="2" max="20" class="dialog-input tf-num" />
        </div>
        <div class="tf-actions">
          <button type="button" class="btn btn-primary" @click="runTransform">Create new column</button>
        </div>

        <hr class="tf-rule" />

        <div class="tf-field">
          <span class="tf-label">Fill missing values in {{ sourceCol || 'a column' }}</span>
          <div class="tf-inline">
            <select v-model="fillMethod" class="dialog-select">
              <option value="mean">Mean</option>
              <option value="median">Median</option>
              <option value="mode">Mode</option>
            </select>
            <button type="button" class="btn" @click="runFill">Fill missing</button>
          </div>
          <p class="tf-hint">Mean and median need a numeric column; mode works on any column.</p>
        </div>
      </template>

      <!-- RECODE ------------------------------------------------------------- -->
      <template v-else-if="mode === 'recode'">
        <div class="tf-field">
          <label for="tfRecodeSrc">Recode column</label>
          <select id="tfRecodeSrc" v-model="sourceCol" class="dialog-select">
            <option v-for="c in state.ds.columns" :key="c.name" :value="c.name">{{ c.name }}</option>
          </select>
        </div>
        <div class="tf-field">
          <span class="tf-label">Old → new</span>
          <div v-for="(rule, i) in recodeRules" :key="i" class="tf-rule-row">
            <input v-model="rule.from" class="dialog-input tf-rule-input" placeholder="old" aria-label="Old value" />
            <span class="tf-arrow" aria-hidden="true">→</span>
            <input v-model="rule.to" class="dialog-input tf-rule-input" placeholder="new (blank = missing)" aria-label="New value" />
            <button type="button" class="ara-modal-close tf-rule-del" title="Remove rule" aria-label="Remove rule" @click="removeRule(i)">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12" /></svg>
            </button>
          </div>
          <button type="button" class="btn btn-sm" @click="addRule">Add rule</button>
          <p v-if="sourceLevels.length" class="tf-hint">
            Values present: <span class="tf-codes">{{ sourceLevels.slice(0, 12).join(', ') }}</span>
          </p>
        </div>
        <div class="tf-field">
          <label class="tf-radio">
            <input v-model="recodeIntoNew" type="radio" :value="true" />
            <span><strong>Into a new column</strong></span>
          </label>
          <label class="tf-radio">
            <input v-model="recodeIntoNew" type="radio" :value="false" />
            <span><strong>Into the same column</strong><em>Overwrites the source, one undo step.</em></span>
          </label>
          <input
            v-if="recodeIntoNew"
            v-model="recodeNewName"
            class="dialog-input tf-input"
            placeholder="new column name"
            aria-label="New column name"
          />
        </div>
        <div class="tf-actions">
          <button type="button" class="btn btn-primary" @click="runRecode">Recode values</button>
        </div>
      </template>

      <!-- SORT & FILTER ------------------------------------------------------ -->
      <template v-else-if="mode === 'sort-drop'">
        <div class="tf-field">
          <label for="tfSortCol">Sort rows by</label>
          <div class="tf-inline">
            <select id="tfSortCol" v-model="sourceCol" class="dialog-select">
              <option v-for="c in state.ds.columns" :key="c.name" :value="c.name">{{ c.name }}</option>
            </select>
            <label class="tf-radio">
              <input v-model="sortAsc" type="radio" :value="true" /><span><strong>Ascending</strong></span>
            </label>
            <label class="tf-radio">
              <input v-model="sortAsc" type="radio" :value="false" /><span><strong>Descending</strong></span>
            </label>
            <button type="button" class="btn" @click="runSort">Sort rows</button>
          </div>
          <p class="tf-hint">Missing values always sort last.</p>
        </div>

        <hr class="tf-rule" />

        <div class="tf-field">
          <span class="tf-label">Drop rows with missing values</span>
          <div class="tf-check-grid">
            <label v-for="c in state.ds.columns" :key="c.name" class="tf-check">
              <input type="checkbox" :checked="dropCols.includes(c.name)" @change="toggleDropCol(c.name)" />
              <span>{{ c.name }}</span>
            </label>
          </div>
          <p class="tf-hint">
            {{ dropCols.length ? `${dropCols.length} column(s) selected.` : 'No column selected: every column is checked.' }}
            <strong>{{ affectedRows }}</strong> row(s) would be removed.
          </p>
          <button type="button" class="btn btn-primary" :disabled="!affectedRows" @click="runDrop">
            Drop rows
          </button>
        </div>
      </template>

      <!-- FIND -------------------------------------------------------------- -->
      <template v-else>
        <div class="tf-field">
          <label for="tfFind">Find in data</label>
          <input id="tfFind" v-model="findQuery" class="dialog-input tf-input" placeholder="Search any value..." />
        </div>
        <table v-if="findHits.length" class="tf-preview-table">
          <thead>
            <tr><th scope="col">Column</th><th scope="col">Row</th><th scope="col">Value</th></tr>
          </thead>
          <tbody>
            <tr v-for="(hit, i) in findHits.slice(0, 50)" :key="i">
              <td>{{ hit.col }}</td><td>{{ hit.row }}</td><td>{{ hit.value }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="tf-hint">Type a value or label to locate its cells.</p>
        <div class="tf-actions">
          <button type="button" class="btn" @click="runFind">Find</button>
        </div>
      </template>
    </div>

    <div class="ara-modal-foot">
      <p class="ara-status-pill" :class="status ? (statusOk ? 'is-ready' : 'is-warn') : ''" role="status">
        <span>{{ status || 'Every action is a single undo step.' }}</span>
      </p>
      <div class="ara-modal-foot-actions">
        <button type="button" class="btn" @click="close">Close</button>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.transform-dlg {
  width: min(660px, 94vw);
  max-height: min(680px, 88vh);
  margin: auto;
  position: fixed;
  inset: 0;
}

.tf-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.tf-field label,
.tf-label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
}

.tf-input { width: 100%; font-family: var(--font-mono); }
.tf-num { width: 90px; }

.tf-hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.4;
  color: var(--muted);
}

.tf-error {
  margin: 0;
  font-size: 11.5px;
  color: var(--err);
}

.tf-inline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.tf-radio-list { display: flex; flex-direction: column; gap: 6px; }

.tf-radio {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  cursor: pointer;
}
.tf-radio input { margin-top: 2px; accent-color: var(--accent); }
.tf-radio span { display: flex; flex-direction: column; }
.tf-radio em {
  font-style: normal;
  font-size: 11px;
  color: var(--muted);
}

.tf-rule { border: 0; border-top: 1px solid var(--line); margin: 4px 0; }

.tf-actions { display: flex; justify-content: flex-end; gap: 8px; }

.tf-preview {
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--panel-alt);
  padding: 8px 10px;
}

.tf-preview-title {
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
}

.tf-preview-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 6px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.tf-preview-table th {
  text-align: left;
  font-weight: 600;
  color: var(--muted);
  border-bottom: 1px solid var(--line-strong);
  padding: 3px 6px;
}
.tf-preview-table td { padding: 3px 6px; font-family: var(--font-mono); }

.tf-rule-row { display: flex; align-items: center; gap: 6px; }
.tf-rule-input { flex: 1; min-width: 0; }
.tf-arrow { color: var(--muted); }
.tf-rule-del { width: 24px; height: 24px; }

.tf-codes { font-family: var(--font-mono); color: var(--text); }

.tf-check-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 4px 10px;
  max-height: 160px;
  overflow-y: auto;
}

.tf-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  cursor: pointer;
}
.tf-check input { accent-color: var(--accent); }
</style>
