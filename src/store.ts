// Dataset store: one ColumnarDataset + minimal inverse-event undo/redo stack.
import { reactive, computed, toRaw, ref } from 'vue'
import { defaultMeta, type ColumnMeta, type ColumnarDataset, type ColumnValues } from './io/types.ts'
import { computeFill, interpolateValues, type FillMode } from './missing.ts'
import { computeLogValues, computeStandardizeValues, computeBinValues, suggestTransformName, computeConvertValues, computeMergeValues, computeWinsorizeValues } from './transforms.ts'

export const NA_TOKEN = 'NA'
export type Cell = number | string | null
export const showValueLabels = ref(true)

export type UiEvent =
  | { t: 'cell'; col: string; row: number; prev: Cell; next: Cell }
  | { t: 'meta'; col: string; key: keyof ColumnMeta; prev: unknown; next: unknown }
  | { t: 'rowAdd'; row: number; values: Record<string, Cell> }
  | { t: 'rowDel'; row: number; values: Record<string, Cell> }
  | { t: 'colAdd'; index: number; meta: ColumnMeta; values: ColumnValues }
  | { t: 'colDel'; index: number; meta: ColumnMeta; values: ColumnValues }
  | { t: 'dataset'; prev: ColumnarDataset; next: ColumnarDataset }

export const state = reactive({
  ds: { columns: [], data: {} } as ColumnarDataset,
  view: 'data' as 'data' | 'variable',
  sample: false,
  filename: '' as string,
  rev: 0,
  // Formulas behind AI-gated computed columns. ponytail: the list is append-only, the
  // inverse-event stack covers the columns themselves; tie formulas into the stack if
  // undo must drop them too.
  computedFormulas: [] as string[]
})

// Reactive stacks: the canUndo/canRedo/undoTip/redoTip computeds read these, so they
// must be reactive (plain arrays freeze those computeds at their first value and the
// Undo/Redo buttons could never enable).
const past = reactive([]) as UiEvent[]
const future = reactive([]) as UiEvent[]

const clone = <T,>(v: T): T => {
  if (typeof v !== 'object' || v === null) return v
  try {
    return JSON.parse(JSON.stringify(toRaw(v))) as T
  } catch {
    // SAFETY: dataset cells and meta are plain JSON-safe values by construction
    // (imports + validated UI writes); a non-serializable object can only be a
    // coding bug, so falling back to the reference keeps undo working.
    return v
  }
}

export function invert(ev: UiEvent): UiEvent {
  switch (ev.t) {
    case 'cell': return { t: 'cell', col: ev.col, row: ev.row, prev: ev.next, next: ev.prev }
    case 'meta': return { t: 'meta', col: ev.col, key: ev.key, prev: ev.next, next: ev.prev }
    case 'rowAdd': return { t: 'rowDel', row: ev.row, values: ev.values }
    case 'rowDel': return { t: 'rowAdd', row: ev.row, values: ev.values }
    case 'colAdd': return { t: 'colDel', index: ev.index, meta: ev.meta, values: ev.values }
    case 'colDel': return { t: 'colAdd', index: ev.index, meta: ev.meta, values: ev.values }
    case 'dataset': return { t: 'dataset', prev: ev.next, next: ev.prev }
  }
}

function colValues(name: string): Array<Cell> {
  const c = state.ds.columns.find((c) => c.name === name)
  if (!c) throw new Error(`no column ${name}`)
  return state.ds.data[c.name] as Array<Cell>
}

export function apply(ev: UiEvent): void {
  switch (ev.t) {
    case 'cell':
      colValues(ev.col)[ev.row] = ev.next
      break
    case 'meta': {
      const c = state.ds.columns.find((c) => c.name === ev.col)
      if (c)
        // SAFETY: ev.key is keyof ColumnMeta, so the cast only widens the write target.
        (c as unknown as Record<string, unknown>)[ev.key as string] = clone(ev.next)
      break
    }
    case 'rowAdd':
      for (const c of state.ds.columns) colValues(c.name).splice(ev.row, 0, ev.values[c.name] ?? null)
      break
    case 'rowDel':
      for (const c of state.ds.columns) colValues(c.name).splice(ev.row, 1)
      break
    case 'colAdd':
      state.ds.columns.splice(ev.index, 0, clone(ev.meta))
      state.ds.data[ev.meta.name] = clone(ev.values)
      break
    case 'colDel': {
      const [m] = state.ds.columns.splice(ev.index, 1)
      if (m) delete state.ds.data[m.name]
      break
    }
    case 'dataset':
      state.ds = clone(ev.next)
      break
  }
  state.rev++
}

export function commit(ev: UiEvent): void {
  apply(ev)
  past.push(clone(ev))
  future.length = 0
}

export function setCell(col: string, row: number, next: Cell): void {
  const prev = colValues(col)[row] ?? null
  if (prev === next) return
  commit({ t: 'cell', col, row, prev: prev as Cell, next })
}

export function setMeta(col: string, key: keyof ColumnMeta, next: unknown): void {
  const c = state.ds.columns.find((c) => c.name === col)
  if (!c) return
  // SAFETY: key is a keyof ColumnMeta here, so the read target is one of the
  // interface's own fields; Record<string, unknown> only widens access.
  const prev = (c as unknown as Record<string, unknown>)[key as string]
  if (JSON.stringify(prev) === JSON.stringify(next)) return
  commit({ t: 'meta', col, key, prev: clone(prev), next: clone(next) })
}

export function addRow(): void {
  addRowAt(rowCount.value)
}

/** Insert an empty row at an arbitrary index. */
export function addRowAt(row: number): void {
  if (row < 0 || row > rowCount.value) return
  const values: Record<string, Cell> = {}
  for (const c of state.ds.columns) values[c.name] = null
  commit({ t: 'rowAdd', row, values })
}

/**
 * Bulk cell edit (paste, compute-over-column): one undo event for many writes.
 * ponytail: two JSON deep clones per batch - fine for interactive pastes; swap
 * to structural sharing if datasets grow past ~100k rows.
 */
export function batchCells(edits: Array<{ col: string; row: number; next: Cell }>): void {
  if (!edits.length) return
  const prev = clone(state.ds)
  for (const e of edits) {
    const arr = state.ds.data[e.col]
    if (arr) (arr as Array<Cell>)[e.row] = e.next
  }
  commit({ t: 'dataset', prev, next: clone(state.ds) })
}

export function uniqueColumnName(prefix = 'VAR_'): string {
  const names = new Set(state.ds.columns.map((c) => c.name.toLowerCase()))
  let i = 1
  while (names.has(`${prefix.toLowerCase()}${i}`)) i += 1
  return `${prefix}${i}`
}

export function insertColumnAt(index: number, meta?: Partial<ColumnMeta>, initialValues?: ColumnValues): ColumnMeta {
  const safeIndex = Math.max(0, Math.min(index, state.ds.columns.length))
  const name = meta?.name || uniqueColumnName('VAR_')
  const base = defaultMeta(name, meta?.type || 'numeric')
  const fullMeta: ColumnMeta = {
    ...base,
    ...clone(meta || {})
  }
  fullMeta.name = name
  // Optional prefilled values (Phase 3.2 transforms): still ONE colAdd commit = one undo.
  // Falls back to null-filled when omitted (existing callers unchanged).
  const n = rowCount.value
  const values = (initialValues ? clone(initialValues) : new Array(n).fill(null)) as ColumnValues
  while (values.length < n) (values as Array<Cell>).push(null)
  if (values.length > n) values.length = n
  commit({ t: 'colAdd', index: safeIndex, meta: fullMeta, values })
  return fullMeta
}

export type TransformKind = 'log' | 'standardize' | 'bin'

/**
 * Phase 3.2 transform: new derived column right after the source, original untouched.
 * Single `colAdd` commit (via insertColumnAt with values) = one undo. Log refuses
 * on any non-positive valid value with a counted message; nothing is written then.
 */
export function transformColumn(
  colName: string,
  kind: TransformKind,
  opts: { bins?: number } = {}
): { ok: boolean; message: string; name?: string } {
  const srcIdx = state.ds.columns.findIndex((c) => c.name === colName)
  if (srcIdx < 0) return { ok: false, message: `No column named ${colName}.` }
  const src = state.ds.columns[srcIdx]!
  if (src.type !== 'numeric') return { ok: false, message: `${colName} is not numeric. Log, standardize, and bin need a numeric column.` }
  const vals = ((state.ds.data[colName] ?? []) as Array<Cell>)
  const missing = (v: Cell): boolean => isUserMissing(src, v)
  const existing = state.ds.columns.map((c) => c.name)
  if (kind === 'log') {
    const { values, error } = computeLogValues(vals, missing)
    if (error) return { ok: false, message: error }
    const name = suggestTransformName(existing, colName, '_log')
    insertColumnAt(srcIdx + 1, {
      name,
      label: `Log of ${src.label || colName}`,
      type: 'numeric',
      measure: 'scale',
      decimals: src.decimals ?? 2
    }, values as ColumnValues)
    return { ok: true, message: `Created ${name} as ln(${colName}).`, name }
  }
  if (kind === 'standardize') {
    const { values, error } = computeStandardizeValues(vals, missing)
    if (error) return { ok: false, message: error }
    const name = suggestTransformName(existing, colName, '_z')
    insertColumnAt(srcIdx + 1, {
      name,
      label: `Z-score of ${src.label || colName}`,
      type: 'numeric',
      measure: 'scale',
      decimals: 3
    }, values as ColumnValues)
    return { ok: true, message: `Created ${name} as z-scores of ${colName}.`, name }
  }
  const k = opts.bins ?? 5
  const { values, error } = computeBinValues(vals, missing, k)
  if (error) return { ok: false, message: error }
  const name = suggestTransformName(existing, colName, '_bin')
  insertColumnAt(srcIdx + 1, {
    name,
    label: `Binned ${src.label || colName} (${k} groups)`,
    type: 'numeric',
    measure: 'ordinal',
    decimals: 0
  }, values as ColumnValues)
  return { ok: true, message: `Created ${name} with ${k} equal-width bins of ${colName}.`, name }
}

// --- Phase 3.1 cell rewrites: each ONE commit = one undo. ---

/**
 * str→numeric convert (flagged by the typeMismatch scanner): NUMERIC_SHAPE
 * cells parse, unparseable→null. ONE dataset commit = one undo. Decimals
 * mirror onStorageTypeChange (integer→0, else keep>0 else 2).
 */
export function convertToNumeric(colName: string): { ok: boolean; message: string } {
  const meta = state.ds.columns.find((c) => c.name === colName)
  if (!meta) return { ok: false, message: `No column named ${colName}.` }
  if (meta.type !== 'string') return { ok: false, message: `${colName} is already ${meta.type}.` }
  const vals = ((state.ds.data[colName] ?? []) as Array<Cell>)
  const { values, error, decimals, converted, nulled } = computeConvertValues(vals, (v) => isUserMissing(meta, v))
  if (error) return { ok: false, message: error }
  const prev = clone(state.ds)
  const next = clone(state.ds)
  next.columns = next.columns.map((c) => c.name === colName ? { ...c, type: 'numeric' as const, decimals } : c)
  next.data[colName] = clone(values) as ColumnValues
  commit({ t: 'dataset', prev, next })
  const tail = nulled ? `, ${nulled} unparseable → missing` : ''
  return { ok: true, message: `Converted ${colName} to numeric (${converted} parsed${tail}).` }
}

/**
 * dirty-merge (flagged by the dirtyCategories scanner): variants collapsing
 * to one category rewrite to the most-frequent raw form (ties: first-seen),
 * trimmed. ONE batchCells commit = one undo.
 */
export function mergeDirtyCategories(colName: string): { ok: boolean; message: string } {
  const meta = state.ds.columns.find((c) => c.name === colName)
  if (!meta) return { ok: false, message: `No column named ${colName}.` }
  if (meta.type !== 'string') return { ok: false, message: `${colName} is not text.` }
  const vals = ((state.ds.data[colName] ?? []) as Array<Cell>)
  const { values, changed, examples } = computeMergeValues(vals, (v) => isUserMissing(meta, v))
  if (!changed) return { ok: false, message: `No dirty variants found in ${colName}.` }
  const edits: Array<{ col: string; row: number; next: Cell }> = []
  values.forEach((next, row) => {
    if ((vals[row] ?? null) !== (next ?? null)) edits.push({ col: colName, row, next })
  })
  batchCells(edits)
  const ex = examples.length ? `: ${examples.join(', ')}` : ''
  return { ok: true, message: `Merged ${changed} cells in ${colName}${ex}.` }
}

/**
 * Winsorize (flagged by the outliers scanner): out-of-bounds numerics clamp
 * to [Q1-1.5IQR, Q3+1.5IQR] rounded to meta.decimals. ONE batchCells = one undo.
 */
export function winsorizeColumn(colName: string): { ok: boolean; message: string; lo?: number; hi?: number } {
  const meta = state.ds.columns.find((c) => c.name === colName)
  if (!meta) return { ok: false, message: `No column named ${colName}.` }
  if (meta.type !== 'numeric') return { ok: false, message: `${colName} is not numeric.` }
  const vals = ((state.ds.data[colName] ?? []) as Array<Cell>)
  const { values, error, lo, hi, changed } = computeWinsorizeValues(vals, (v) => isUserMissing(meta, v), meta.decimals)
  if (error) return { ok: false, message: error }
  if (!changed) return { ok: true, message: `No outliers outside [${fmtB(lo)}, ${fmtB(hi)}] in ${colName}.`, lo, hi }
  const edits: Array<{ col: string; row: number; next: Cell }> = []
  values.forEach((next, row) => {
    if ((vals[row] ?? null) !== (next ?? null)) edits.push({ col: colName, row, next })
  })
  batchCells(edits)
  return { ok: true, message: `Winsorized ${changed} outliers in ${colName} to [${fmtB(lo)}, ${fmtB(hi)}].`, lo, hi }
}

function fmtB(v: number): string {
  if (!Number.isFinite(v)) return String(v)
  if (Number.isInteger(v)) return String(v)
  return String(Number(v.toFixed(2)))
}

export function duplicateColumn(colName: string): ColumnMeta | null {
  const idx = state.ds.columns.findIndex((c) => c.name === colName)
  if (idx < 0) return null
  const src = state.ds.columns[idx]
  const names = new Set(state.ds.columns.map((c) => c.name.toLowerCase()))
  let copyName = `${src.name}_copy`
  let count = 2
  while (names.has(copyName.toLowerCase())) {
    copyName = `${src.name}_copy${count++}`
  }
  const newMeta: ColumnMeta = {
    ...clone(src),
    name: copyName,
    label: src.label ? `${src.label} (Copy)` : ''
  }
  const srcValues = (state.ds.data[src.name] ?? []) as ColumnValues
  const clonedValues = clone(srcValues)
  commit({ t: 'colAdd', index: idx + 1, meta: newMeta, values: clonedValues })
  return newMeta
}

export function deleteColumnByName(colName: string): boolean {
  const idx = state.ds.columns.findIndex((c) => c.name === colName)
  if (idx < 0) return false
  return deleteColumn(idx)
}

export function reorderColumns(fromIndex: number, toIndex: number): void {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return
  if (fromIndex >= state.ds.columns.length || toIndex >= state.ds.columns.length) return
  const prev = clone(state.ds)
  const next = clone(state.ds)
  const [moved] = next.columns.splice(fromIndex, 1)
  next.columns.splice(toIndex, 0, moved)
  commit({ t: 'dataset', prev, next })
}

export function addColumn(meta: ColumnMeta): void {
  const values = new Array(rowCount.value).fill(null) as ColumnValues
  commit({ t: 'colAdd', index: state.ds.columns.length, meta, values })
}

export function deleteRow(row: number = rowCount.value - 1): boolean {
  if (!state.ds.columns.length || row < 0 || row >= rowCount.value) return false
  const values: Record<string, Cell> = {}
  for (const c of state.ds.columns) values[c.name] = (state.ds.data[c.name] as Array<Cell>)[row] ?? null
  commit({ t: 'rowDel', row, values })
  return true
}

export function deleteColumn(index: number = state.ds.columns.length - 1): boolean {
  const meta = state.ds.columns[index]
  if (!meta) return false
  commit({ t: 'colDel', index, meta: clone(meta), values: clone(state.ds.data[meta.name] ?? []) })
  return true
}

export function clearHistory(): void {
  past.length = 0
  future.length = 0
}

export function setDataset(ds: ColumnarDataset): void {
  commit({ t: 'dataset', prev: clone(state.ds), next: clone(ds) })
  state.sample = ds.sample ?? false
}

export const rowCount = computed(() => {
  const c = state.ds.columns[0]
  return c ? (state.ds.data[c.name]?.length ?? 0) : 0
})
export const colCount = computed(() => state.ds.columns.length)
export const canUndo = computed(() => past.length > 0)
export const canRedo = computed(() => future.length > 0)
export const undoTip = computed(() => (past.length ? `Undo ${describe(past[past.length - 1])}` : 'Nothing to undo'))
export const redoTip = computed(() => (future.length ? `Redo ${describe(future[future.length - 1])}` : 'Nothing to redo'))

function describe(ev: UiEvent): string {
  switch (ev.t) {
    case 'cell': return 'cell edit'
    case 'meta': return 'column settings change'
    case 'rowAdd': return 'add row'
    case 'rowDel': return 'delete row'
    case 'colAdd': return 'add column'
    case 'colDel': return 'delete column'
    case 'dataset': return 'dataset change'
  }
}

export function undo(): void {
  const ev = past.pop()
  if (!ev) return
  apply(invert(ev))
  future.push(ev)
}

export function redo(): void {
  const ev = future.pop()
  if (!ev) return
  apply(ev)
  past.push(ev)
}

export function undoDepth(): number { return past.length }

export function isUserMissing(meta: ColumnMeta, v: Cell): boolean {
  if (v === null) return true
  if (meta.missing.values.some((x) => x === v)) return true
  return typeof v === 'number' && meta.missing.ranges.some(([lo, hi]) => v >= lo && v <= hi)
}

export function displayCell(meta: ColumnMeta, v: Cell): string {
  if (isUserMissing(meta, v)) return NA_TOKEN
  const labels = meta.valueLabels as Record<string, string> | undefined
  const label = labels?.[String(v)]
  if (label && showValueLabels.value) return `${String(v)}. ${label}`
  if (typeof v === 'number' && meta.decimals !== undefined && Number.isFinite(meta.decimals)) {
    return v.toFixed(meta.decimals)
  }
  return String(v)
}

export function imputeColumn(
  colName: string,
  method: 'mean' | 'median' | 'mode' | 'interpolate' | 'constant' | 'drop',
  constantVal?: number | string
): boolean {
  const meta = state.ds.columns.find((c) => c.name === colName)
  if (!meta) return false
  const vals = (state.ds.data[colName] as Array<Cell>) ?? []
  if (method === 'drop') {
    const toDrop = new Set<number>()
    vals.forEach((v, r) => {
      if (isUserMissing(meta, v)) toDrop.add(r)
    })
    if (!toDrop.size) return false
    const nextData: Record<string, ColumnValues> = {}
    for (const c of state.ds.columns) {
      const arr = state.ds.data[c.name] ?? []
      nextData[c.name] = arr.filter((_, idx) => !toDrop.has(idx)) as ColumnValues
    }
    const nextDs: ColumnarDataset = {
      columns: clone(state.ds.columns),
      data: nextData
    }
    setDataset(nextDs)
    return true
  }
  if (method === 'interpolate') {
    if (meta.type !== 'numeric') return false
    const edits = interpolateValues(vals, (v) => isUserMissing(meta, v), meta.decimals)
    if (!edits.length) return false
    batchCells(edits.map((e) => ({ col: colName, row: e.row, next: e.next })))
    return true
  }
  if (method === 'constant') {
    if (constantVal === undefined || constantVal === '') return false
    const fillVal = meta.type === 'numeric' && Number.isFinite(Number(constantVal)) ? Number(constantVal) : constantVal
    const edits: Array<{ col: string; row: number; next: Cell }> = []
    vals.forEach((v, r) => {
      if (isUserMissing(meta, v)) edits.push({ col: colName, row: r, next: fillVal })
    })
    if (!edits.length) return false
    batchCells(edits)
    return true
  }
  const fill = computeFill(vals, method as FillMode, (v) => isUserMissing(meta, v), 'first')
  if (fill === null) return false
  const finalFill = typeof fill === 'number' && meta.decimals !== undefined ? Number(fill.toFixed(meta.decimals)) : fill
  const edits: Array<{ col: string; row: number; next: Cell }> = []
  vals.forEach((v, r) => {
    if (isUserMissing(meta, v)) edits.push({ col: colName, row: r, next: finalFill })
  })
  if (!edits.length) return false
  batchCells(edits)
  return true
}

export function imputeColumnsBatch(
  tasks: Array<{
    colName: string
    method: 'mean' | 'median' | 'mode' | 'interpolate' | 'constant' | 'drop'
    constantVal?: number | string
  }>
): number {
  if (!tasks.length) return 0
  const prev = clone(state.ds)
  let count = 0
  const allEdits: Array<{ col: string; row: number; next: Cell }> = []
  const dropRowIndices = new Set<number>()

  for (const task of tasks) {
    const meta = state.ds.columns.find((c) => c.name === task.colName)
    if (!meta) continue
    const vals = (state.ds.data[task.colName] as Array<Cell>) ?? []

    if (task.method === 'drop') {
      let found = false
      vals.forEach((v, r) => {
        if (isUserMissing(meta, v)) {
          dropRowIndices.add(r)
          found = true
        }
      })
      if (found) count++
      continue
    }

    if (task.method === 'interpolate') {
      if (meta.type !== 'numeric') continue
      const edits = interpolateValues(vals, (v) => isUserMissing(meta, v), meta.decimals)
      if (edits.length) {
        for (const e of edits) allEdits.push({ col: task.colName, row: e.row, next: e.next })
        count++
      }
      continue
    }

    if (task.method === 'constant') {
      if (task.constantVal === undefined || task.constantVal === '') continue
      const fillVal = meta.type === 'numeric' && Number.isFinite(Number(task.constantVal)) ? Number(task.constantVal) : task.constantVal
      let found = false
      vals.forEach((v, r) => {
        if (isUserMissing(meta, v)) {
          allEdits.push({ col: task.colName, row: r, next: fillVal })
          found = true
        }
      })
      if (found) count++
      continue
    }

    const fill = computeFill(vals, task.method as FillMode, (v) => isUserMissing(meta, v), 'first')
    if (fill === null) continue
    const finalFill = typeof fill === 'number' && meta.decimals !== undefined ? Number(fill.toFixed(meta.decimals)) : fill
    let found = false
    vals.forEach((v, r) => {
      if (isUserMissing(meta, v)) {
        allEdits.push({ col: task.colName, row: r, next: finalFill })
        found = true
      }
    })
    if (found) count++
  }

  if (!allEdits.length && !dropRowIndices.size) return 0

  for (const e of allEdits) {
    const arr = state.ds.data[e.col]
    if (arr) (arr as Array<Cell>)[e.row] = e.next
  }

  if (dropRowIndices.size > 0) {
    const nextData: Record<string, ColumnValues> = {}
    for (const c of state.ds.columns) {
      const arr = state.ds.data[c.name] ?? []
      nextData[c.name] = arr.filter((_, idx) => !dropRowIndices.has(idx)) as ColumnValues
    }
    state.ds.data = nextData
  }

  commit({ t: 'dataset', prev, next: clone(state.ds) })
  return count
}
