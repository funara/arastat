<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import {
  state, rowCount, setCell, addRowAt, deleteRow, deleteColumn, setMeta, batchCells,
  displayCell, isUserMissing, type Cell
} from './store.ts'
import type { ColumnMeta } from './io/types.ts'
import { storageShort } from './io/types.ts'

const emit = defineEmits<{
  (e: 'edit', row: number, col: string): void
}>()

/* ---------- Right-click context menu (SPSS-style) ---------- */
const ctxMenu = ref<{ x: number; y: number; row: number; col: string | null } | null>(null)
function openGridMenu(e: MouseEvent, row: number, col: string | null): void {
  e.preventDefault()
  // Open at the cursor, then flip up/left using the Teleported menu's real
  // size so bottom/right clicks never clip past the viewport edge.
  const PAD = 8
  ctxMenu.value = { x: Math.max(PAD, e.clientX), y: Math.max(PAD, e.clientY), row, col }
  void nextTick(() => {
    const m = ctxMenu.value
    const el = document.querySelector('.ctx-menu')
    if (!m || !(el instanceof HTMLElement)) return
    const r = el.getBoundingClientRect()
    if (r.right > window.innerWidth - PAD) m.x = Math.max(PAD, window.innerWidth - r.width - PAD)
    if (r.bottom > window.innerHeight - PAD) m.y = Math.max(PAD, window.innerHeight - r.height - PAD)
  })
}
function closeGridMenu(): void {
  ctxMenu.value = null
}
function ctxAct(fn: () => void): void {
  closeGridMenu()
  fn()
}
function editCellFromMenu(): void {
  const m = ctxMenu.value
  if (!m || !m.col) return
  const meta = state.ds.columns.find((c) => c.name === m.col)
  if (meta) startEdit(meta, m.row, null)
}
function deleteRowAt(): void {
  const at = ctxMenu.value?.row
  if (at != null) deleteRow(at)
}
function deleteColAt(): void {
  const name = ctxMenu.value?.col
  if (!name) return
  const i = state.ds.columns.findIndex((c) => c.name === name)
  if (i >= 0) deleteColumn(i)
}
function measureAct(measure: 'nominal' | 'ordinal' | 'scale' | 'ratio'): void {
  const name = ctxMenu.value?.col
  if (name) setMeta(name, 'measure', measure)
}
async function copyFromMenu(): Promise<void> {
  const m = ctxMenu.value
  if (!m) return
  const vals: Cell[][] = []
  for (let r = m.row; r < rowCount.value; r++) {
    vals.push(state.ds.columns.map((c) => (state.ds.data[c.name] as Array<Cell>)[r] ?? null))
  }
  const text = vals.map((r) => r.map((v) => (v === null ? '' : String(v))).join('\t')).join('\n')
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    /* clipboard unavailable; nothing to report */
  }
}
async function pasteFromMenu(): Promise<void> {
  const m = ctxMenu.value
  if (!m) return
  let rows: string[][] = []
  try {
    const text = await navigator.clipboard.readText()
    if (text.trim()) rows = text.split(/\r?\n/).map((line) => line.split('\t'))
  } catch {
    return
  }
  const ci = state.ds.columns.findIndex((c) => c.name === m.col)
  const edits: Array<{ col: string; row: number; next: Cell }> = []
  for (let r = 0; r < rows.length && m.row + r < rowCount.value; r++) {
    for (let c = 0; c < rows[r].length && ci + c < state.ds.columns.length; c++) {
      const meta = state.ds.columns[ci + c]
      const t = (rows[r][c] ?? '').trim()
      if (t === '') continue // blanks never clobber existing values
      const v: Cell = t.toUpperCase() === 'NA' ? null : meta.type === 'numeric' ? (Number.isFinite(Number(t)) ? Number(t) : null) : t
      edits.push({ col: meta.name, row: m.row + r, next: v })
    }
  }
  batchCells(edits)
}

/* ---------- Row virtualization: fixed 28px row pitch, render only the visible slice.
   Without this an 18k-row import mounts ~130k <td>s synchronously and hangs the UI. ---------- */
const ROW_H = 28
const BUFFER = 8
const scrollEl = ref<HTMLElement | null>(null)
const scrollTopV = ref(0)
const viewportH = ref(600)
let scrollRaf = 0
function onGridScroll(): void {
  if (scrollRaf) return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0
    const el = scrollEl.value
    if (!el) return
    scrollTopV.value = el.scrollTop
    viewportH.value = el.clientHeight
    // Scrolling unmounts off-window rows; don't let an open cell edit die with them.
    if (editing.value) commit(false)
  })
}
const firstRow = computed(() =>
  Math.max(0, Math.min(Math.floor(scrollTopV.value / ROW_H) - BUFFER, rowCount.value - BUFFER))
)
const visibleRows = computed<number[]>(() => {
  const start = firstRow.value + 1 // 1-based row numbers
  const end = Math.min(rowCount.value, firstRow.value + Math.ceil(viewportH.value / ROW_H) + BUFFER * 2)
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => start + i)
})
const lastVisible = computed(() => visibleRows.value[visibleRows.value.length - 1] ?? 0)

const editing = ref<{ row: number; name: string } | null>(null)
const draft = ref('')
const tableEl = ref<HTMLTableElement | null>(null)
const editingCell = ref<HTMLTableCellElement | null>(null)

function raw(meta: ColumnMeta, r: number): Cell {
  return (state.ds.data[meta.name]?.[r] ?? null) as Cell
}

function startEdit(meta: ColumnMeta, r: number, target: EventTarget | null): void {
  editingCell.value = target instanceof HTMLTableCellElement ? target : null
  editing.value = { row: r, name: meta.name }
  const v = raw(meta, r)
  draft.value = isUserMissing(meta, v) && v !== null ? 'NA' : v === null ? '' : String(v)
  void nextTick(() => tableEl.value?.querySelector<HTMLInputElement>('tbody input')?.focus())
}

function focusEditingCell(): void {
  const cell = editingCell.value
  editingCell.value = null
  void nextTick(() => cell?.focus())
}

function parseInput(meta: ColumnMeta, text: string): Cell {
  const t = text.trim()
  if (t === '' || t.toUpperCase() === 'NA') return null
  if (meta.type === 'numeric') {
    const n = Number(t)
    return Number.isFinite(n) ? n : null
  }
  return t
}

function commit(restoreFocus = true): void {
  const e = editing.value
  if (!e) return
  const meta = state.ds.columns.find((c) => c.name === e.name)
  if (meta) setCell(e.name, e.row, parseInput(meta, draft.value))
  editing.value = null
  if (restoreFocus) focusEditingCell()
}
function cancel(): void {
  editing.value = null
  focusEditingCell()
}

function cellClass(meta: ColumnMeta, v: Cell): string {
  const cls = [meta.align === 'left' || meta.type === 'string' ? 'txt' : 'num']
  if (isUserMissing(meta, v)) cls.push('cell-missing')
  return cls.join(' ')
}

function onDocClick(): void {
  closeGridMenu()
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
  // The scroll container is the .grid-wrap parent rendered by App.vue.
  void nextTick(() => {
    scrollEl.value = tableEl.value?.closest<HTMLElement>('.grid-wrap') ?? null
    if (scrollEl.value) {
      viewportH.value = scrollEl.value.clientHeight
      scrollEl.value.addEventListener('scroll', onGridScroll, { passive: true })
    }
  })
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  scrollEl.value?.removeEventListener('scroll', onGridScroll)
  if (scrollRaf) cancelAnimationFrame(scrollRaf)
})
</script>

<template>
  <table ref="tableEl" class="grid" aria-label="Data View">
    <caption class="sr-only">Dataset cells as displayed.</caption>
    <thead>
      <tr>
        <th class="corner" scope="col"><span class="sr-only">Row</span></th>
        <th v-for="c in state.ds.columns" :key="c.name" scope="col" :style="{ minWidth: Math.max(c.width || 0, 110) + 'px' }">
          <span class="vname">{{ c.name }} <span class="dtype-badge">{{ storageShort(c) }}</span></span>
        </th>
      </tr>
    </thead>
    <tbody>
      <tr v-if="firstRow > 0" aria-hidden="true" class="vspacer">
        <td :colspan="state.ds.columns.length + 1" :style="{ height: firstRow * ROW_H + 'px' }"></td>
      </tr>
      <tr v-for="r in visibleRows" :key="r">
        <td class="rownum" @contextmenu="openGridMenu($event, r - 1, null)">{{ r }}</td>
        <td
          v-for="c in state.ds.columns"
          :key="c.name"
          :style="{ minWidth: Math.max(c.width || 0, 110) + 'px' }"
          :class="cellClass(c, raw(c, r - 1))"
          tabindex="0"
          @dblclick="startEdit(c, r - 1, $event.currentTarget)"
          @keydown.enter.prevent="startEdit(c, r - 1, $event.currentTarget)"
          @contextmenu="openGridMenu($event, r - 1, c.name)"
        >
          <input
            v-if="editing && editing.row === r - 1 && editing.name === c.name"
            v-model="draft"
            :aria-label="`${c.name}, row ${r}`"
            style="width:100%; height:22px; border:0; padding:0; font:inherit; background:transparent;"
            @blur="commit(false)"
            @keydown.enter.prevent.stop="commit()"
            @keydown.esc.prevent.stop="cancel"
          />
          <template v-else>{{ displayCell(c, raw(c, r - 1)) }}</template>
        </td>
      </tr>
      <tr v-if="lastVisible < rowCount" aria-hidden="true" class="vspacer">
        <td :colspan="state.ds.columns.length + 1" :style="{ height: (rowCount - lastVisible) * ROW_H + 'px' }"></td>
      </tr>
    </tbody>
  </table>
  <Teleport to="body">
    <div
      v-if="ctxMenu"
      class="ctx-menu"
      role="menu"
      :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
      @click.stop
    >
      <template v-if="ctxMenu.col === null">
        <button class="dd-row" role="menuitem" @click="ctxAct(() => { const at = ctxMenu!.row; addRowAt(at) })">Insert row above</button>
        <button class="dd-row" role="menuitem" @click="ctxAct(() => { const at = ctxMenu!.row; addRowAt(at + 1) })">Insert row below</button>
        <button class="dd-row" role="menuitem" @click="ctxAct(deleteRowAt)">Delete row</button>
      </template>
      <template v-else>
        <button class="dd-row" role="menuitem" @click="ctxAct(editCellFromMenu)">Edit cell</button>
        <div class="dd-sep"></div>
        <button class="dd-row" role="menuitem" @click="ctxAct(copyFromMenu)">Copy from here down</button>
        <button class="dd-row" role="menuitem" @click="ctxAct(pasteFromMenu)">Paste</button>
        <div class="dd-sep"></div>
        <button class="dd-row" role="menuitem" @click="ctxAct(() => { const at = ctxMenu!.row; addRowAt(at) })">Insert row above</button>
        <button class="dd-row" role="menuitem" @click="ctxAct(() => { const at = ctxMenu!.row; addRowAt(at + 1) })">Insert row below</button>
        <button class="dd-row" role="menuitem" @click="ctxAct(deleteRowAt)">Delete row</button>
        <div class="dd-sep"></div>
        <button class="dd-row" role="menuitem" @click="ctxAct(deleteColAt)">Delete column {{ ctxMenu!.col }}</button>
        <div class="dd-sep"></div>
        <button class="dd-row" role="menuitem" @click="ctxAct(() => measureAct('nominal'))">Measure: Nominal</button>
        <button class="dd-row" role="menuitem" @click="ctxAct(() => measureAct('ordinal'))">Measure: Ordinal</button>
        <button class="dd-row" role="menuitem" @click="ctxAct(() => measureAct('scale'))">Measure: Scale</button>
        <button class="dd-row" role="menuitem" @click="ctxAct(() => measureAct('ratio'))">Measure: Ratio</button>
      </template>
    </div>
  </Teleport>
</template>
