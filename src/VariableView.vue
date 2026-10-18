<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import {
  state, rowCount, isUserMissing,
  insertColumnAt, duplicateColumn, deleteColumnByName, reorderColumns
} from './store.ts'
import type { ColumnMeta } from './io/types.ts'
import { storageShort } from './io/types.ts'
import { scanQuality } from './quality.ts'
import VariableConfigDialog from './VariableConfigDialog.vue'
import MeasureIcon from './MeasureIcon.vue'

const emit = defineEmits<{
  (e: 'plot', colName: string): void
  (e: 'ask-ai', query: string): void
  (e: 'open-analysis', testId: string, options?: Record<string, unknown>): void
  (e: 'open-test-advisor', initialVars?: string[]): void
  (e: 'open-advisor', colName?: string): void
  (e: 'jump-to-column', name: string): void
}>()

// Filtering
const searchQuery = ref('')
const isSearchOpen = ref(false)
const searchInputRef = ref<HTMLInputElement | null>(null)
const searchBoxRef = ref<HTMLElement | null>(null)
type FilterOption = 'all' | 'numeric' | 'categorical' | 'missing'
const filterMode = ref<FilterOption>('all')

function toggleSearch(): void {
  isSearchOpen.value = !isSearchOpen.value
  if (isSearchOpen.value) {
    nextTick(() => searchInputRef.value?.focus())
  } else {
    searchQuery.value = ''
  }
}

function closeSearch(): void {
  searchQuery.value = ''
  isSearchOpen.value = false
}

// Dialog States
type ConfigTab = 'general' | 'labels' | 'missing' | 'eda'
const configDialogOpen = ref(false)
const selectedVarName = ref<string>('')
const selectedConfigTab = ref<ConfigTab>('general')

// Context Menu State
interface CtxMenuState {
  x: number
  y: number
  colName: string
}
const ctxMenu = ref<CtxMenuState | null>(null)

// Drag and drop custom sorting
const draggedColIndex = ref<number | null>(null)
const dragOverColIndex = ref<number | null>(null)
const dropPosition = ref<'above' | 'below' | null>(null)

function onDragStart(e: DragEvent, index: number): void {
  draggedColIndex.value = index
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(index))
  }
}

function onDragOver(e: DragEvent, index: number): void {
  e.preventDefault()
  if (draggedColIndex.value === null || draggedColIndex.value === index) {
    dragOverColIndex.value = null
    dropPosition.value = null
    return
  }
  dragOverColIndex.value = index
  const target = e.currentTarget as HTMLElement | null
  if (target) {
    const rect = target.getBoundingClientRect()
    const mid = rect.top + rect.height / 2
    dropPosition.value = e.clientY < mid ? 'above' : 'below'
  }
}

function onDragLeave(index: number): void {
  if (dragOverColIndex.value === index) {
    dragOverColIndex.value = null
    dropPosition.value = null
  }
}

function onDrop(e: DragEvent, targetIndex: number): void {
  e.preventDefault()
  if (draggedColIndex.value === null || draggedColIndex.value === targetIndex) {
    onDragEnd()
    return
  }
  const sourceCol = filteredColumns.value[draggedColIndex.value]
  const targetCol = filteredColumns.value[targetIndex]
  if (!sourceCol || !targetCol || sourceCol.name === targetCol.name) {
    onDragEnd()
    return
  }

  const fromActual = state.ds.columns.findIndex((c) => c.name === sourceCol.name)
  let toActual = state.ds.columns.findIndex((c) => c.name === targetCol.name)

  if (fromActual >= 0 && toActual >= 0 && fromActual !== toActual) {
    if (dropPosition.value === 'above' && fromActual < toActual) {
      toActual -= 1
    } else if (dropPosition.value === 'below' && fromActual > toActual) {
      toActual += 1
    }
    reorderColumns(fromActual, toActual)
  }
  onDragEnd()
}

function onDragEnd(): void {
  draggedColIndex.value = null
  dragOverColIndex.value = null
  dropPosition.value = null
}
function onRowKeydown(e: KeyboardEvent, index: number): void {
  if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
  e.preventDefault()
  reorderColumns(index, Math.max(0, Math.min(state.ds.columns.length - 1, index + (e.key === 'ArrowUp' ? -1 : 1))))
}

function openContextMenu(e: MouseEvent, colName: string): void {
  const PAD = 8
  ctxMenu.value = {
    x: Math.max(PAD, e.clientX),
    y: Math.max(PAD, e.clientY),
    colName
  }
  void nextTick(() => {
    const m = ctxMenu.value
    const el = document.querySelector('.vv-ctx-menu')
    if (!m || !(el instanceof HTMLElement)) return
    const r = el.getBoundingClientRect()
    if (r.right > window.innerWidth - PAD) m.x = Math.max(PAD, window.innerWidth - r.width - PAD)
    if (r.bottom > window.innerHeight - PAD) m.y = Math.max(PAD, window.innerHeight - r.height - PAD)
  })
}

function closeContextMenu(): void {
  ctxMenu.value = null
}

function handleEdit(colName: string, tab: ConfigTab = 'general'): void {
  closeContextMenu()
  openConfig(colName, tab)
}

function handleInsert(colName: string): void {
  closeContextMenu()
  const idx = state.ds.columns.findIndex((c) => c.name === colName)
  if (idx >= 0) insertColumnAt(idx + 1)
}

function handleDuplicate(colName: string): void {
  closeContextMenu()
  duplicateColumn(colName)
}

function handleDelete(colName: string): void {
  closeContextMenu()
  deleteColumnByName(colName)
}

function handleViewInData(): void {
  closeContextMenu()
  state.view = 'data'
}

function handleAskAi(colName: string): void {
  closeContextMenu()
  emit('ask-ai', `Tell me about variable '${colName}' in this dataset: summarize its distribution, measurement scale, and suitable statistical analyses.`)
}

function onDocClick(e: MouseEvent): void {
  if (ctxMenu.value) closeContextMenu()
  if (isSearchOpen.value && searchBoxRef.value) {
    const target = e.target as Node | null
    if (target && !searchBoxRef.value.contains(target)) {
      closeSearch()
    }
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && ctxMenu.value) closeContextMenu()
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKeydown)
})

// Missing helpers
function getMissingCount(c: ColumnMeta): number {
  const arr = state.ds.data[c.name] as Array<number | string | null> | undefined
  if (!arr) return 0
  let count = 0
  for (const v of arr) {
    if (isUserMissing(c, v)) count++
  }
  return count
}

const totalVars = computed(() => state.ds.columns.length)
const numericCount = computed(() => state.ds.columns.filter((c) => c.type === 'numeric').length)
const categoricalCount = computed(() => state.ds.columns.filter((c) => c.type !== 'numeric').length)
const missingVarsCount = computed(() => state.ds.columns.filter((c) => getMissingCount(c) > 0).length)

// Phase 1.2 quality wiring: badgeN = cols with any scanQuality() issue.
const qualityReport = computed(() => scanQuality(state.ds))
const badgeN = computed(() => qualityReport.value.badgeN)
const qualityHasErr = computed(() => qualityReport.value.hasErr)
const hasDatasetCriticalErr = computed(() =>
  qualityReport.value.issues.some((i) => i.severity === 'err')
)

const advisorTitle = computed(() =>
  badgeN.value > 0
    ? `Data Health & Advisor: ${badgeN.value} column${badgeN.value === 1 ? ' needs' : 's need'} review`
    : 'Data Health & Advisor: dataset looks clean — open to see the score'
)

function hasQualityIssue(colName: string): boolean {
  return (qualityReport.value.byColumn[colName]?.length ?? 0) > 0
}

function colSeverity(colName: string): 'err' | 'warn' {
  const list = qualityReport.value.byColumn[colName]
  if (!list?.length) return 'warn'
  return list.some((i) => i.severity === 'err') ? 'err' : 'warn'
}

function qualityTip(colName: string): string {
  const list = qualityReport.value.byColumn[colName]
  if (!list?.length) return ''
  return list.slice(0, 3).map((i) => i.message).join('\n')
}

function formatMissingSummary(c: ColumnMeta): { text: string; pct: number; isClean: boolean; severityClass: string } {
  const miss = getMissingCount(c)
  const total = rowCount.value
  if (miss === 0) {
    return { text: '✓ Clean', pct: 0, isClean: true, severityClass: 'is-clean' }
  }
  const pctNum = total > 0 ? (miss / total) * 100 : 0
  const pctStr = pctNum > 0 && pctNum < 1 ? '<1%' : `${Math.round(pctNum)}%`
  const severityClass = pctNum > 40 ? 'is-high' : pctNum >= 5 ? 'is-medium' : 'is-low'
  return { text: `${miss} (${pctStr})`, pct: pctNum, isClean: false, severityClass }
}

function openAdvisorAll(): void {
  emit('open-advisor', '')
}

function handleReviewQuality(colName: string): void {
  closeContextMenu()
  emit('open-advisor', colName)
}

function openMissingAdvisor(colName: string): void {
  emit('open-advisor', colName)
}

// Filtered list
const filteredColumns = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  return state.ds.columns.filter((c) => {
    if (q) {
      const matchName = c.name.toLowerCase().includes(q)
      const matchLabel = (c.label || '').toLowerCase().includes(q)
      if (!matchName && !matchLabel) return false
    }

    if (filterMode.value === 'numeric') return c.type === 'numeric'
    if (filterMode.value === 'categorical') return c.type !== 'numeric'
    if (filterMode.value === 'missing') return getMissingCount(c) > 0

    return true
  })
})

function openConfig(colName: string, tab: ConfigTab = 'general'): void {
  selectedVarName.value = colName
  selectedConfigTab.value = tab
  configDialogOpen.value = true
}

// Hub "Configure variable" deep-links land here by name, so an active filter
// must never hide the target: openConfig() takes the name, not the row index.
defineExpose({ openConfigFor: (name: string) => openConfig(name, 'general') })

function jumpToColumn(colName: string): void {
  emit('jump-to-column', colName)
}

function onPlotRequest(colName: string): void {
  emit('plot', colName)
}
</script>

<template>
  <div class="variable-view-container">
    <!-- Compact, Non-wrapping Single-line Toolbar -->
    <div class="vv-compact-toolbar">
      <!-- Left side: Search toggle button & filter dropdown -->
      <div class="vv-toolbar-left">
        <!-- Search Toggle Button (when search is closed) -->
        <button
          v-if="!isSearchOpen"
          type="button"
          class="vv-icon-btn"
          :class="{ 'has-query': searchQuery.length > 0 }"
          title="Search variables"
          aria-label="Search variables"
          @click.stop="toggleSearch"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
        </button>

        <!-- Expanded Search Input (when search is open) -->
        <div v-else ref="searchBoxRef" class="vv-search-box is-expanded" @click.stop>
          <svg class="vv-search-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            ref="searchInputRef"
            v-model="searchQuery"
            class="vv-search-input"
            placeholder="Filter variable..."
            aria-label="Filter variable"
            @keydown.esc="closeSearch"
          />
          <button class="vv-clear-btn" type="button" title="Close search" @click.stop="closeSearch">&times;</button>
        </div>

        <!-- Filter Dropdown: Hidden when search is open (Request #5) -->
        <div v-if="!isSearchOpen" class="vv-filter-wrapper">
          <select v-model="filterMode" class="vv-filter-select" aria-label="Filter variable types">
            <option value="all">All ({{ totalVars }})</option>
            <option value="numeric">Numeric ({{ numericCount }})</option>
            <option value="categorical">Categorical ({{ categoricalCount }})</option>
            <option value="missing">Missing ({{ missingVarsCount }})</option>
          </select>
        </div>
      </div>

      <!-- Right side: Health & Test Advisor action buttons -->
      <div class="vv-toolbar-right">
        <!-- Health button -->
        <button
          class="btn-advisor-toolbar"
          type="button"
          :title="advisorTitle"
          :aria-label="advisorTitle"
          @click="openAdvisorAll"
        >
          <svg class="advisor-sparkle-icon" width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0c.7 4.5 3.5 7.3 8 8-4.5.7-7.3 3.5-8 8-.7-4.5-3.5-7.3-8-8 4.5-.7 7.3-3.5 8-8z" />
          </svg>
          <span class="advisor-btn-text">Health</span>
          <span v-if="badgeN > 0" class="advisor-badge" :class="hasDatasetCriticalErr ? 'is-err' : 'is-warn'">{{ badgeN }}</span>
        </button>

        <!-- Statistical Test Advisor button -->
        <button
          class="btn-advisor-toolbar btn-test-advisor-toolbar"
          type="button"
          title="Statistical Test Advisor: Evaluate assumptions and match tests"
          aria-label="Statistical Test Advisor"
          @click="emit('open-test-advisor')"
        >
          <svg class="advisor-sparkle-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="20" x2="18" y2="10"/>
            <line x1="12" y1="20" x2="12" y2="4"/>
            <line x1="6" y1="20" x2="6" y2="14"/>
          </svg>
          <span class="advisor-btn-text">Test Advisor</span>
        </button>
      </div>
    </div>

    <!-- 6-Column Grid: Index, Variable, Label, Data Type, Measure, Missing -->
    <div class="vv-table-wrapper">
      <table class="grid varGrid vv-streamlined-grid" aria-label="Variable View">
        <caption class="sr-only">Variables summary and configuration.</caption>
        <thead>
          <tr>
            <th class="corner vv-th-index" scope="col" title="Row index">#</th>
            <th scope="col" class="vv-th-variable">Variable</th>
            <th scope="col" class="vv-th-label">Label</th>
            <th scope="col" class="th-center vv-th-datatype" title="Data Type">Type</th>
            <th scope="col" class="th-center vv-th-measure">Measure</th>
            <th scope="col" class="th-center vv-th-missing">Missing</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(c, i) in filteredColumns"
            :key="c.name"
            class="vv-row"
            :class="{
              'is-dragging': draggedColIndex === i,
              'drag-target-above': dragOverColIndex === i && dropPosition === 'above',
              'drag-target-below': dragOverColIndex === i && dropPosition === 'below'
            }"
            draggable="true"
            tabindex="0"
            @keydown="onRowKeydown($event, state.ds.columns.findIndex((column) => column.name === c.name))"
            title="Drag to reorder variable; use Alt+Arrow Up or Down to move"
            @dragstart="onDragStart($event, i)"
            @dragover="onDragOver($event, i)"
            @dragleave="onDragLeave(i)"
            @drop="onDrop($event, i)"
            @dragend="onDragEnd"
            @dblclick="openConfig(c.name, 'general')"
            @contextmenu.prevent="openContextMenu($event, c.name)"
          >
            <!-- Row Number: click configures, double-click jumps to Data View -->
            <td
              class="cell-rownum"
              :title="`Click to configure ${c.name}, double-click to show it in Data View`"
              @click.stop="openConfig(c.name, 'general')"
              @dblclick.stop="jumpToColumn(c.name)"
            >
              <span class="row-num-val">{{ i + 1 }}</span>
            </td>

            <!-- Variable Name: click to configure -->
            <td class="cell-var-name" :title="`${c.name} (Click to configure)`" @click="openConfig(c.name, 'general')">
              <div class="var-name-row">
                <MeasureIcon :measure="c.measure" />
                <span class="var-name-primary" :title="c.name">{{ c.name }}</span>
                <button
                  v-if="hasQualityIssue(c.name)"
                  type="button"
                  class="vv-quality-dot"
                  :class="colSeverity(c.name) === 'err' ? 'is-err' : 'is-warn'"
                  :title="qualityTip(c.name) + '\nClick to review in Advisor'"
                  aria-label="Quality warning"
                  @click.stop="openMissingAdvisor(c.name)"
                >!</button>
                <span v-if="Object.keys(c.valueLabels || {}).length" class="var-labels-tag">
                  {{ Object.keys(c.valueLabels).length }} labels
                </span>
              </div>
            </td>

            <!-- Variable Label: click to edit -->
            <td class="cell-var-label" :title="c.label ? `${c.label} (Click to edit)` : 'No label (Click to add)'" @click="openConfig(c.name, 'general')">
              <span v-if="c.label" class="var-label-text" :title="c.label">{{ c.label }}</span>
              <span v-else class="var-label-empty">-</span>
            </td>

            <!-- Separate Data Type Column: click to configure type -->
            <td class="cell-data-type" title="Click to change data type" @click.stop="openConfig(c.name, 'general')">
              <span class="badge-type">{{ storageShort(c) }}</span>
            </td>

            <!-- Separate Measure Variable Column: click to configure measure -->
            <td class="cell-measure" title="Click to change measurement scale" @click.stop="openConfig(c.name, 'general')">
              <span class="badge-measure" :class="`measure-${c.measure}`">{{ c.measure.toUpperCase() }}</span>
            </td>

            <!-- Missing Value Column: click to inspect/impute -->
            <td
              class="cell-missing-summary"
              tabindex="0"
              role="button"
              :title="getMissingCount(c) > 0 ? `${getMissingCount(c)} missing cells (${formatMissingSummary(c).pct.toFixed(1)}%). Click to review & fill in Advisor.` : 'Clean: click to inspect missing rules'"
              @click.stop="getMissingCount(c) > 0 ? openMissingAdvisor(c.name) : openConfig(c.name, 'missing')"
              @keydown.enter="getMissingCount(c) > 0 ? openMissingAdvisor(c.name) : openConfig(c.name, 'missing')"
              @keydown.space.prevent="getMissingCount(c) > 0 ? openMissingAdvisor(c.name) : openConfig(c.name, 'missing')"
            >
              <span
                v-if="!formatMissingSummary(c).isClean"
                class="missing-warning-badge"
                :class="formatMissingSummary(c).severityClass"
              >
                {{ formatMissingSummary(c).text }}
              </span>
              <span v-else class="missing-clean-badge">
                ✓ Clean
              </span>
            </td>
          </tr>

          <tr v-if="!filteredColumns.length">
            <td colspan="6" class="vv-empty-search">
              No variables match the current filter.
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- All-in-one Variable Configuration Dialog -->
    <VariableConfigDialog
      v-model="configDialogOpen"
      :col-name="selectedVarName"
      :initial-tab="selectedConfigTab"
      @plot="onPlotRequest"
      @navigate="selectedVarName = $event"
    />

    <!-- Right-click Context Menu -->
    <Teleport to="body">
      <div
        v-if="ctxMenu"
        class="ctx-menu vv-ctx-menu"
        role="menu"
        :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
        @click.stop
      >
        <button class="dd-row" role="menuitem" @click="handleEdit(ctxMenu.colName, 'general')">
          <span class="dd-icon" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
            </svg>
          </span>
          <span>Edit Variable...</span>
        </button>

        <button class="dd-row" role="menuitem" @click="handleEdit(ctxMenu.colName, 'eda')">
          <span class="dd-icon" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="20" x2="18" y2="10"/>
              <line x1="12" y1="20" x2="12" y2="4"/>
              <line x1="6" y1="20" x2="6" y2="14"/>
            </svg>
          </span>
          <span>Distribution &amp; EDA...</span>
        </button>

        <button class="dd-row" role="menuitem" @click="handleReviewQuality(ctxMenu.colName)">
          <span class="dd-icon" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0c.7 4.5 3.5 7.3 8 8-4.5.7-7.3 3.5-8 8-.7-4.5-3.5-7.3-8-8 4.5-.7 7.3-3.5 8-8z" />
            </svg>
          </span>
          <span>Review Health &amp; Advisor...</span>
        </button>

        <button class="dd-row" role="menuitem" @click="handleAskAi(ctxMenu.colName)">
          <span class="dd-icon" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          </span>
          <span>Ask ARA Assistant about '{{ ctxMenu.colName }}'</span>
        </button>

        <div class="dd-sep"></div>

        <button class="dd-row" role="menuitem" @click="handleInsert(ctxMenu.colName)">
          <span class="dd-icon" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </span>
          <span>Insert Variable</span>
        </button>

        <button class="dd-row" role="menuitem" @click="handleDuplicate(ctxMenu.colName)">
          <span class="dd-icon" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
          </span>
          <span>Duplicate Variable</span>
        </button>

        <button class="dd-row danger" role="menuitem" @click="handleDelete(ctxMenu.colName)">
          <span class="dd-icon" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </span>
          <span>Delete Variable</span>
        </button>

        <div class="dd-sep"></div>

        <button class="dd-row" role="menuitem" @click="handleViewInData">
          <span class="dd-icon" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </span>
          <span>View in Data View</span>
        </button>
      </div>
    </Teleport>
  </div>
</template>
