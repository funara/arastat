<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { state, rowCount, setMeta, isUserMissing, imputeColumn, mergeDirtyCategories, convertToNumeric } from './store.ts'
import type { ColumnMeta, Measure, MissingRules, StorageType } from '../../main/io/types.ts'
import { getStorageType, storageShort } from '../../main/io/types.ts'
import { scanQuality, type QualityIssue } from './quality.ts'

const props = withDefaults(defineProps<{
  modelValue: boolean
  colName: string
  initialTab?: ConfigTab
}>(), {
  initialTab: 'general'
})

const emit = defineEmits<{
  (e: 'update:modelValue', val: boolean): void
  (e: 'plot', colName: string): void
  (e: 'navigate', colName: string): void
}>()

type ConfigTab = 'general' | 'labels' | 'missing' | 'eda'
const activeTab = ref<ConfigTab>(props.initialTab)

// Column resolution
const currentColumn = computed<ColumnMeta | undefined>(() => {
  return state.ds.columns.find((c) => c.name === props.colName)
})

const currentColumnIndex = computed(() => {
  return state.ds.columns.findIndex((c) => c.name === props.colName)
})

const qualityIssuesForCol = computed<QualityIssue[]>(() => {
  if (!props.colName) return []
  const report = scanQuality(state.ds)
  return report.byColumn[props.colName] ?? []
})

function applyQualityFix(issue: QualityIssue): void {
  const fix = issue.fix
  if (!fix) return
  switch (fix.op) {
    case 'setMetaMissing': {
      const c = currentColumn.value
      if (!c) return
      if (!c.missing.values.some((x) => x === fix.value)) {
        setMeta(fix.col, 'missing', { values: [...c.missing.values, fix.value], ranges: [...c.missing.ranges] })
        syncMissingFromColumn()
      }
      break
    }
    case 'setMeasureNominal':
      setMeta(fix.col, 'measure', 'nominal')
      break
    case 'applyPreset':
      applyLabelPreset(fix.preset)
      break
    case 'mergeCategories':
      mergeDirtyCategories(fix.col)
      break
    case 'convertToNumeric':
      convertToNumeric(fix.col)
      break
  }
}

const columnData = computed<Array<number | string | null>>(() => {
  if (!props.colName) return []
  return (state.ds.data[props.colName] ?? []) as Array<number | string | null>
})

// Navigation between variables
function prevVar(): void {
  const idx = currentColumnIndex.value
  if (idx > 0) {
    const prev = state.ds.columns[idx - 1]
    if (prev) emit('navigate', prev.name)
  }
}

function nextVar(): void {
  const idx = currentColumnIndex.value
  if (idx >= 0 && idx < state.ds.columns.length - 1) {
    const next = state.ds.columns[idx + 1]
    if (next) emit('navigate', next.name)
  }
}

function close(): void {
  emit('update:modelValue', false)
}

function handleKeyDown(ev: KeyboardEvent): void {
  if (props.modelValue && ev.key === 'Escape') {
    close()
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeyDown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown)
})

// -------------------------------------------------------------
// TAB 1: General & Format State
// -------------------------------------------------------------
const draftName = ref('')
const draftLabel = ref('')
const nameError = ref('')

watch(
  () => [props.modelValue, props.colName, props.initialTab] as const,
  () => {
    if (props.modelValue && currentColumn.value) {
      // Deep-link (Phase 1.3): hub Configure opens straight at the requested tab.
      activeTab.value = props.initialTab
      draftName.value = currentColumn.value.name
      draftLabel.value = currentColumn.value.label || ''
      nameError.value = ''
      syncLabelsFromColumn()
      syncMissingFromColumn()
    }
  },
  { immediate: true }
)

function onNameChange(): void {
  const t = draftName.value.trim()
  if (!t) {
    nameError.value = 'Variable name cannot be empty.'
    return
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) {
    nameError.value = 'Name must start with a letter/underscore and contain only letters, numbers, and underscores.'
    return
  }
  if (t !== props.colName && state.ds.columns.some((c) => c.name === t)) {
    nameError.value = `Variable '${t}' already exists.`
    return
  }
  nameError.value = ''
  if (t !== props.colName) {
    setMeta(props.colName, 'name', t)
    emit('navigate', t)
  }
}

function onLabelChange(): void {
  setMeta(props.colName, 'label', draftLabel.value.trim())
}

function onStorageTypeChange(ev: Event): void {
  const c = currentColumn.value
  if (!c) return
  const st = (ev.target as HTMLSelectElement).value as StorageType
  if (st === 'integer') {
    setMeta(c.name, 'type', 'numeric')
    setMeta(c.name, 'decimals', 0)
  } else if (st === 'float') {
    setMeta(c.name, 'type', 'numeric')
    setMeta(c.name, 'decimals', (c.decimals && c.decimals > 0) ? c.decimals : 2)
  } else if (st === 'string') {
    setMeta(c.name, 'type', 'string')
    setMeta(c.name, 'decimals', 0)
  } else if (st === 'date') {
    setMeta(c.name, 'type', 'date')
    setMeta(c.name, 'decimals', 0)
  }
}

function onMeasureChange(ev: Event): void {
  const c = currentColumn.value
  if (!c) return
  setMeta(c.name, 'measure', (ev.target as HTMLSelectElement).value as Measure)
}

function stepDecimals(delta: number): void {
  const c = currentColumn.value
  if (!c || c.type !== 'numeric') return
  const current = c.decimals ?? 0
  const next = Math.max(0, Math.min(16, current + delta))
  if (next !== current) {
    setMeta(c.name, 'decimals', next)
  }
}

// -------------------------------------------------------------
// TAB 2: Value Labels State
// -------------------------------------------------------------
interface LabelRow {
  code: string
  label: string
}
const labelRows = ref<LabelRow[]>([])
const newLabelCode = ref('')
const newLabelText = ref('')
const labelError = ref('')

function syncLabelsFromColumn(): void {
  const c = currentColumn.value
  if (!c) return
  labelRows.value = Object.entries(c.valueLabels || {}).map(([code, label]) => ({
    code,
    label
  }))
  newLabelCode.value = ''
  newLabelText.value = ''
  labelError.value = ''
}

function commitLabels(): void {
  const labels: Record<string, string> = {}
  for (const r of labelRows.value) {
    if (r.code.trim()) {
      labels[r.code.trim()] = r.label.trim()
    }
  }
  setMeta(props.colName, 'valueLabels', labels)
}

function addLabelRow(): void {
  const code = newLabelCode.value.trim()
  const label = newLabelText.value.trim()
  if (!code) {
    labelError.value = 'Value code cannot be empty.'
    return
  }
  if (!label) {
    labelError.value = 'Label text cannot be empty.'
    return
  }
  const existingIdx = labelRows.value.findIndex((r) => r.code === code)
  if (existingIdx >= 0) {
    labelRows.value[existingIdx].label = label
  } else {
    labelRows.value.push({ code, label })
  }
  newLabelCode.value = ''
  newLabelText.value = ''
  labelError.value = ''
  commitLabels()
}

function removeLabelRow(index: number): void {
  labelRows.value.splice(index, 1)
  commitLabels()
}

function sortLabelRows(): void {
  labelRows.value.sort((a, b) => {
    const na = Number(a.code)
    const nb = Number(b.code)
    if (!isNaN(na) && !isNaN(nb)) return na - nb
    return a.code.localeCompare(b.code)
  })
  commitLabels()
}

function applyLabelPreset(preset: string): void {
  labelError.value = ''
  if (preset === 'likert5') {
    labelRows.value = [
      { code: '1', label: 'Strongly Disagree' },
      { code: '2', label: 'Disagree' },
      { code: '3', label: 'Neutral' },
      { code: '4', label: 'Agree' },
      { code: '5', label: 'Strongly Agree' }
    ]
  } else if (preset === 'binary') {
    labelRows.value = [
      { code: '0', label: 'No / Absent' },
      { code: '1', label: 'Yes / Present' }
    ]
  } else if (preset === 'gender') {
    labelRows.value = [
      { code: '1', label: 'Female' },
      { code: '2', label: 'Male' },
      { code: '3', label: 'Other' }
    ]
  } else if (preset === 'clear') {
    labelRows.value = []
  }
  commitLabels()
}

// -------------------------------------------------------------
// TAB 3: Missing Rules & Imputation State
// -------------------------------------------------------------
type MissingRuleType = 'none' | 'discrete' | 'range'
const missingRuleType = ref<MissingRuleType>('none')
const discrete1 = ref('')
const discrete2 = ref('')
const discrete3 = ref('')
const rangeLow = ref('')
const rangeHigh = ref('')
const rangeDiscrete = ref('')

const imputeStrategy = ref<'mean' | 'median' | 'mode' | 'interpolate' | 'constant' | 'drop'>('mean')
const customConstantVal = ref('')
const confirmDropRows = ref(false)

function syncMissingFromColumn(): void {
  confirmDropRows.value = false
  customConstantVal.value = ''
  const c = currentColumn.value
  if (!c) return

  imputeStrategy.value = c.type === 'numeric' ? 'mean' : 'mode'

  const vals = c.missing?.values ?? []
  const ranges = c.missing?.ranges ?? []

  if (ranges.length > 0) {
    missingRuleType.value = 'range'
    rangeLow.value = String(ranges[0]?.[0] ?? '')
    rangeHigh.value = String(ranges[0]?.[1] ?? '')
    rangeDiscrete.value = vals.length > 0 ? String(vals[0]) : ''
    discrete1.value = ''
    discrete2.value = ''
    discrete3.value = ''
  } else if (vals.length > 0) {
    missingRuleType.value = 'discrete'
    discrete1.value = vals[0] !== undefined ? String(vals[0]) : ''
    discrete2.value = vals[1] !== undefined ? String(vals[1]) : ''
    discrete3.value = vals[2] !== undefined ? String(vals[2]) : ''
    rangeLow.value = ''
    rangeHigh.value = ''
    rangeDiscrete.value = ''
  } else {
    missingRuleType.value = 'none'
    discrete1.value = ''
    discrete2.value = ''
    discrete3.value = ''
    rangeLow.value = ''
    rangeHigh.value = ''
    rangeDiscrete.value = ''
  }
}

function saveMissingRules(): void {
  const c = currentColumn.value
  if (!c) return
  let values: Array<number | string> = []
  let ranges: Array<[number, number]> = []

  const parseVal = (str: string): number | string => {
    const s = str.trim()
    if (c.type === 'numeric' && Number.isFinite(Number(s))) return Number(s)
    return s
  }

  if (missingRuleType.value === 'discrete') {
    if (discrete1.value.trim()) values.push(parseVal(discrete1.value))
    if (discrete2.value.trim()) values.push(parseVal(discrete2.value))
    if (discrete3.value.trim()) values.push(parseVal(discrete3.value))
  } else if (missingRuleType.value === 'range') {
    const lo = Number(rangeLow.value.trim())
    const hi = Number(rangeHigh.value.trim())
    if (Number.isFinite(lo) && Number.isFinite(hi) && lo <= hi) {
      ranges.push([lo, hi])
    }
    if (rangeDiscrete.value.trim()) {
      values.push(parseVal(rangeDiscrete.value))
    }
  }

  const rules: MissingRules = { values, ranges }
  setMeta(props.colName, 'missing', rules)
}

function executeImpute(): void {
  if (imputeStrategy.value === 'drop' && !confirmDropRows.value) {
    confirmDropRows.value = true
    return
  }

  let constantVal: string | number | undefined = undefined
  const c = currentColumn.value
  if (imputeStrategy.value === 'constant') {
    if (!customConstantVal.value.trim()) return
    constantVal = c?.type === 'numeric' && Number.isFinite(Number(customConstantVal.value.trim()))
      ? Number(customConstantVal.value.trim())
      : customConstantVal.value.trim()
  }

  imputeColumn(props.colName, imputeStrategy.value, constantVal)
  confirmDropRows.value = false
}

// Missing counts for current column
const missingStats = computed(() => {
  const c = currentColumn.value
  const raw = columnData.value
  if (!c || !raw.length) return { total: 0, missing: 0, pct: 0 }
  let missing = 0
  for (const v of raw) {
    if (isUserMissing(c, v)) missing++
  }
  const total = raw.length
  const pct = total > 0 ? Math.round((missing / total) * 100) : 0
  return { total, missing, pct }
})

// -------------------------------------------------------------
// TAB 4: EDA Distribution & Stats
// -------------------------------------------------------------
interface EdaStats {
  validN: number
  missingN: number
  totalN: number
  missingPct: number
  isNumeric: boolean
  min?: number
  max?: number
  mean?: number
  median?: number
  stdDev?: number
  iqr?: number
  bins?: Array<{ x0: number; x1: number; count: number; heightPct: number }>
  uniqueN?: number
  mode?: string
  topCategories?: Array<{ val: string; count: number; pct: number }>
}

const edaStats = computed<EdaStats | null>(() => {
  const c = currentColumn.value
  const raw = columnData.value
  if (!c || !raw) return null
  const totalN = raw.length

  let missingN = 0
  for (const v of raw) {
    if (isUserMissing(c, v)) missingN++
  }
  const validN = totalN - missingN
  const missingPct = totalN > 0 ? Math.round((missingN / totalN) * 100) : 0

  if (c.type === 'numeric') {
    const nums: number[] = []
    for (const v of raw) {
      if (!isUserMissing(c, v) && typeof v === 'number' && Number.isFinite(v)) {
        nums.push(v)
      }
    }
    if (!nums.length) {
      return { validN: 0, missingN, totalN, missingPct, isNumeric: true }
    }
    nums.sort((a, b) => a - b)
    const min = nums[0]!
    const max = nums[nums.length - 1]!
    const range = max - min
    const sum = nums.reduce((acc, v) => acc + v, 0)
    const mean = sum / nums.length
    const mid = Math.floor(nums.length / 2)
    const median = nums.length % 2 === 1 ? nums[mid]! : (nums[mid - 1]! + nums[mid]!) / 2

    const q1 = nums[Math.floor(nums.length * 0.25)] ?? min
    const q3 = nums[Math.floor(nums.length * 0.75)] ?? max
    const iqr = q3 - q1

    const variance = nums.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / (nums.length > 1 ? nums.length - 1 : 1)
    const stdDev = Math.sqrt(variance)

    // 10 Histogram bins
    const numBins = 10
    const binWidth = range === 0 ? 1 : range / numBins
    const binCounts = new Array(numBins).fill(0)
    for (const v of nums) {
      let b = range === 0 ? 0 : Math.floor((v - min) / binWidth)
      if (b >= numBins) b = numBins - 1
      binCounts[b]++
    }
    const maxCount = Math.max(...binCounts, 1)
    const bins = binCounts.map((count, i) => ({
      x0: min + i * binWidth,
      x1: min + (i + 1) * binWidth,
      count,
      heightPct: Math.round((count / maxCount) * 100)
    }))

    return {
      validN,
      missingN,
      totalN,
      missingPct,
      isNumeric: true,
      min,
      max,
      mean,
      median,
      stdDev,
      iqr,
      bins
    }
  } else {
    // Categorical
    const freqMap = new Map<string, number>()
    for (const v of raw) {
      if (!isUserMissing(c, v)) {
        const key = v === null || v === undefined ? '(Blank)' : String(v)
        freqMap.set(key, (freqMap.get(key) ?? 0) + 1)
      }
    }
    const sorted = Array.from(freqMap.entries()).sort((a, b) => b[1] - a[1])
    const uniqueN = sorted.length
    const mode = sorted[0]?.[0] ?? '-'
    const topCategories = sorted.slice(0, 5).map(([val, count]) => ({
      val,
      count,
      pct: validN > 0 ? Math.round((count / validN) * 100) : 0
    }))

    return {
      validN,
      missingN,
      totalN,
      missingPct,
      isNumeric: false,
      uniqueN,
      mode,
      topCategories
    }
  }
})

function formatNum(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '-'
  if (Math.abs(v) >= 1000 || (Math.abs(v) > 0 && Math.abs(v) < 0.01)) {
    return v.toPrecision(4)
  }
  return Number(v.toFixed(3)).toString()
}

function launchPlot(): void {
  emit('plot', props.colName)
  close()
}
</script>

<template>
  <div v-if="modelValue && currentColumn" class="modal-backdrop" @click.self="close">
    <div class="modal-card var-config-modal" role="dialog" aria-modal="true" :aria-label="`Variable Configuration for ${colName}`">

      <!-- Slim title row: name + dtype/measure keep context on every tab -->
      <div class="modal-header config-header">
        <div class="header-title-line">
          <span class="header-var-name">{{ currentColumn.name }}</span>
          <span class="badge-type">{{ storageShort(currentColumn) }}</span>
          <span class="badge-measure">{{ currentColumn.measure.toUpperCase() }}</span>
        </div>
        <button class="icon-close-btn" title="Close (Esc)" @click="close">&times;</button>
      </div>

      <!-- Tab Switcher -->
      <div class="dialog-tabs" role="tablist" aria-label="Variable configuration tabs">
        <button
          class="dialog-tab-btn"
          :class="{ active: activeTab === 'general' }"
          type="button"
          role="tab"
          :aria-selected="activeTab === 'general'"
          @click="activeTab = 'general'"
        >
          General &amp; Type
        </button>
        <button
          class="dialog-tab-btn"
          :class="{ active: activeTab === 'labels' }"
          type="button"
          role="tab"
          :aria-selected="activeTab === 'labels'"
          @click="activeTab = 'labels'"
        >
          Value Labels ({{ labelRows.length }})
        </button>
        <button
          class="dialog-tab-btn"
          :class="{ active: activeTab === 'missing' }"
          type="button"
          role="tab"
          :aria-selected="activeTab === 'missing'"
          @click="activeTab = 'missing'"
        >
          Missing Data ({{ missingStats.missing }})
        </button>
        <button
          class="dialog-tab-btn"
          :class="{ active: activeTab === 'eda' }"
          type="button"
          role="tab"
          :aria-selected="activeTab === 'eda'"
          @click="activeTab = 'eda'"
        >
          Distribution &amp; EDA
        </button>
      </div>

      <!-- Tab Body -->
      <div class="modal-body config-body" role="tabpanel">

        <!-- Variable Quality Alert Callout -->
        <div v-if="qualityIssuesForCol.length" class="var-quality-callout" role="alert">
          <div class="vqc-main">
            <div class="vqc-header">
              <svg class="vqc-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <span class="vqc-badge">Quality Tip</span>
            </div>
            <p class="vqc-msg">{{ qualityIssuesForCol[0]!.message }}</p>
          </div>
          <button
            v-if="qualityIssuesForCol[0]!.fix"
            class="btn-quality-fix"
            type="button"
            @click="applyQualityFix(qualityIssuesForCol[0]!)"
          >
            Fix Issue
          </button>
        </div>

        <!-- TAB 1: GENERAL & TYPE -->
        <div v-if="activeTab === 'general'" class="config-tab-pane">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Variable Name</label>
              <input
                v-model="draftName"
                class="dialog-input"
                placeholder="e.g. salary"
                @blur="onNameChange"
                @keydown.enter.prevent="onNameChange"
              />
              <span v-if="nameError" class="form-error">{{ nameError }}</span>
            </div>
            <div class="form-group">
              <label class="form-label">Descriptive Label</label>
              <input
                v-model="draftLabel"
                class="dialog-input"
                placeholder="e.g. Annual employee base salary ($ USD)"
                @blur="onLabelChange"
                @keydown.enter.prevent="onLabelChange"
              />
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Data Type</label>
              <div class="datatype-row">
                <select
                  :value="getStorageType(currentColumn)"
                  class="dialog-select"
                  @change="onStorageTypeChange"
                >
                  <option value="integer">Integer (Exact discrete number)</option>
                  <option value="float">Float (Decimal precision number)</option>
                  <option value="string">String (Text / Categorical)</option>
                  <option value="date">Date / Timestamp</option>
                </select>
                <div v-if="getStorageType(currentColumn) === 'float'" class="decimals-stepper" title="Decimal places">
                  <button
                    class="step-btn"
                    type="button"
                    aria-label="Fewer decimal places"
                    :disabled="(currentColumn.decimals ?? 0) <= 0"
                    @click="stepDecimals(-1)"
                  >
                    -
                  </button>
                  <span class="step-num">{{ currentColumn.decimals ?? 0 }}</span>
                  <button
                    class="step-btn"
                    type="button"
                    aria-label="More decimal places"
                    :disabled="(currentColumn.decimals ?? 0) >= 16"
                    @click="stepDecimals(1)"
                  >
                    +
                  </button>
                </div>
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">Statistical Measure</label>
              <select
                :value="currentColumn.measure"
                class="dialog-select"
                @change="onMeasureChange"
              >
                <option value="nominal">Nominal (Unordered categories)</option>
                <option value="ordinal">Ordinal (Ordered rankings)</option>
                <option value="scale">Scale (Continuous measurement)</option>
                <option value="ratio">Ratio (Continuous with true zero)</option>
              </select>
            </div>
          </div>
        </div>

        <!-- TAB 2: VALUE LABELS -->
        <div v-else-if="activeTab === 'labels'" class="config-tab-pane">
          <div class="preset-bar">
            <span class="preset-label">Templates:</span>
            <button class="chip-btn" type="button" @click="applyLabelPreset('likert5')">Likert 1–5</button>
            <button class="chip-btn" type="button" @click="applyLabelPreset('binary')">Binary (0/1)</button>
            <button class="chip-btn" type="button" @click="applyLabelPreset('gender')">Gender</button>
            <button class="chip-btn danger-chip" type="button" @click="applyLabelPreset('clear')">Clear All</button>
          </div>

          <div class="label-table-container">
            <table class="label-table">
              <thead>
                <tr>
                  <th style="width: 110px;">Value Code</th>
                  <th>Display Label</th>
                  <th style="width: 50px; text-align: center;"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(r, i) in labelRows" :key="i">
                  <td>
                    <input v-model="r.code" class="dialog-input" @blur="commitLabels" />
                  </td>
                  <td>
                    <input v-model="r.label" class="dialog-input" @blur="commitLabels" />
                  </td>
                  <td style="text-align: center;">
                    <button class="del-row-btn" title="Remove label" @click="removeLabelRow(i)">&times;</button>
                  </td>
                </tr>
                <tr v-if="!labelRows.length">
                  <td colspan="3" class="empty-labels-msg">
                    No value labels defined. Add below or select a preset template.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="add-label-row">
            <input
              v-model="newLabelCode"
              class="dialog-input code-input"
              placeholder="Value (e.g. 1)"
              @keydown.enter.prevent="addLabelRow"
            />
            <input
              v-model="newLabelText"
              class="dialog-input label-input"
              placeholder="Label (e.g. Agree)"
              @keydown.enter.prevent="addLabelRow"
            />
            <button class="btn btn-secondary btn-sm" type="button" @click="addLabelRow">+ Add</button>
            <button v-if="labelRows.length > 1" class="btn btn-ghost btn-sm" type="button" @click="sortLabelRows">
              ⇅ Sort
            </button>
          </div>
          <div v-if="labelError" class="form-error">{{ labelError }}</div>
        </div>

        <!-- TAB 3: MISSING DATA & IMPUTE -->
        <div v-else-if="activeTab === 'missing'" class="config-tab-pane">
          <!-- Summary Banner -->
          <div class="missing-summary-banner">
            <div class="banner-stat">
              <span class="stat-num">{{ missingStats.missing }}</span>
              <span class="stat-lbl">Missing Cells</span>
            </div>
            <div class="banner-divider"></div>
            <div class="banner-stat">
              <span class="stat-num">{{ missingStats.pct }}%</span>
              <span class="stat-lbl">Missing Rate</span>
            </div>
            <div class="banner-divider"></div>
            <div class="banner-stat">
              <span class="stat-num">{{ missingStats.total - missingStats.missing }}</span>
              <span class="stat-lbl">Valid Cells</span>
            </div>
          </div>

          <!-- Section: Define Rules -->
          <div class="sub-section">
            <div class="sub-section-title">User-Missing Codes</div>
            <div class="radio-option">
              <label class="radio-label">
                <input v-model="missingRuleType" type="radio" value="none" @change="saveMissingRules" />
                <span>Standard blank / null cells only</span>
              </label>
            </div>

            <div class="radio-option">
              <label class="radio-label">
                <input v-model="missingRuleType" type="radio" value="discrete" @change="saveMissingRules" />
                <span>Discrete user-missing values (up to 3)</span>
              </label>
              <div v-if="missingRuleType === 'discrete'" class="discrete-inputs-row">
                <input v-model="discrete1" class="dialog-input" placeholder="e.g. 99" @blur="saveMissingRules" />
                <input v-model="discrete2" class="dialog-input" placeholder="e.g. 999" @blur="saveMissingRules" />
                <input v-model="discrete3" class="dialog-input" placeholder="e.g. -1" @blur="saveMissingRules" />
              </div>
            </div>

            <div class="radio-option">
              <label class="radio-label">
                <input v-model="missingRuleType" type="radio" value="range" @change="saveMissingRules" />
                <span>Range of values (low through high)</span>
              </label>
              <div v-if="missingRuleType === 'range'" class="discrete-inputs-row">
                <input v-model="rangeLow" class="dialog-input" placeholder="Low (e.g. -1)" @blur="saveMissingRules" />
                <input v-model="rangeHigh" class="dialog-input" placeholder="High (e.g. 0)" @blur="saveMissingRules" />
                <input v-model="rangeDiscrete" class="dialog-input" placeholder="Optional extra value" @blur="saveMissingRules" />
              </div>
            </div>
          </div>

          <!-- Section: 1-Click Imputation -->
          <div class="sub-section" style="margin-top: 10px;">
            <div class="sub-section-title"> Smart Imputation</div>
            <div v-if="missingStats.missing === 0" class="clean-dataset-msg">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2">
                <path d="M20 6L9 17l-5-5"/>
              </svg>
              <span>This variable has 0 missing observations. No imputation needed!</span>
            </div>

            <div v-else class="impute-controls-row">
              <select v-model="imputeStrategy" class="dialog-select flex-1">
                <option v-if="currentColumn.type === 'numeric'" value="mean">Mean</option>
                <option v-if="currentColumn.type === 'numeric'" value="median">Median</option>
                <option value="mode">Mode</option>
                <option v-if="currentColumn.type === 'numeric'" value="interpolate">Linear Interpolation</option>
                <option value="constant">Constant Value</option>
                <option value="drop">Drop Rows with Missing</option>
              </select>

              <input
                v-if="imputeStrategy === 'constant'"
                v-model="customConstantVal"
                class="dialog-input"
                style="width: 140px;"
                :placeholder="currentColumn.type === 'numeric' ? 'e.g. 0' : 'e.g. N/A'"
              />

              <button
                class="btn btn-impute-action"
                :class="imputeStrategy === 'drop' ? 'btn-danger' : 'btn-primary'"
                type="button"
                @click="executeImpute"
              >
                {{ confirmDropRows ? 'Confirm Delete' : 'Impute' }}
              </button>
            </div>
            <span v-if="confirmDropRows" class="danger-warning" style="display:block; margin-top:4px;">
              ⚠️ This will remove rows missing in {{ colName }}. All operations support Undo (Ctrl+Z).
            </span>
          </div>
        </div>

        <!-- TAB 4: EDA DISTRIBUTION & PLOT -->
        <div v-else-if="activeTab === 'eda'" class="config-tab-pane">
          <!-- Completeness Bar -->
          <div class="completeness-bar-wrap">
            <div class="completeness-bar">
              <div class="completeness-fill valid" :style="{ width: `${100 - (edaStats?.missingPct ?? 0)}%` }"></div>
              <div class="completeness-fill missing" :style="{ width: `${edaStats?.missingPct ?? 0}%` }"></div>
            </div>
            <div class="completeness-legend">
              <span>Valid: <strong>{{ edaStats?.validN }}</strong> ({{ 100 - (edaStats?.missingPct ?? 0) }}%)</span>
              <span>Missing: <strong>{{ edaStats?.missingN }}</strong> ({{ edaStats?.missingPct }}%)</span>
            </div>
          </div>

          <!-- Numeric Summary -->
          <template v-if="edaStats?.isNumeric">
            <div class="eda-grid-container">
              <!-- Histogram -->
              <div class="eda-histogram-box">
                <span class="sub-section-title">Distribution Histogram</span>
                <div v-if="edaStats.bins?.length" class="histogram-container">
                  <svg class="histogram-svg" viewBox="0 0 240 65" preserveAspectRatio="none">
                    <rect
                      v-for="(b, bi) in edaStats.bins"
                      :key="bi"
                      :x="bi * 24 + 1"
                      :y="65 - (b.heightPct * 0.6)"
                      width="22"
                      :height="Math.max(b.heightPct * 0.6, 2)"
                      class="hist-bar"
                      rx="2"
                    >
                      <title>{{ formatNum(b.x0) }} to {{ formatNum(b.x1) }}: {{ b.count }} observations</title>
                    </rect>
                  </svg>
                  <div class="histogram-axis">
                    <span>{{ formatNum(edaStats.min) }}</span>
                    <span>Median: {{ formatNum(edaStats.median) }}</span>
                    <span>{{ formatNum(edaStats.max) }}</span>
                  </div>
                </div>
              </div>

              <!-- Metrics -->
              <div class="stats-metric-grid">
                <div class="stat-card">
                  <span class="stat-card-lbl">Mean</span>
                  <span class="stat-card-val">{{ formatNum(edaStats.mean) }}</span>
                </div>
                <div class="stat-card">
                  <span class="stat-card-lbl">Median</span>
                  <span class="stat-card-val">{{ formatNum(edaStats.median) }}</span>
                </div>
                <div class="stat-card">
                  <span class="stat-card-lbl">Std. Dev.</span>
                  <span class="stat-card-val">{{ formatNum(edaStats.stdDev) }}</span>
                </div>
                <div class="stat-card">
                  <span class="stat-card-lbl">IQR</span>
                  <span class="stat-card-val">{{ formatNum(edaStats.iqr) }}</span>
                </div>
                <div class="stat-card">
                  <span class="stat-card-lbl">Min</span>
                  <span class="stat-card-val">{{ formatNum(edaStats.min) }}</span>
                </div>
                <div class="stat-card">
                  <span class="stat-card-lbl">Max</span>
                  <span class="stat-card-val">{{ formatNum(edaStats.max) }}</span>
                </div>
              </div>
            </div>
          </template>

          <!-- Categorical Frequencies -->
          <template v-else-if="edaStats">
            <div class="sub-section">
              <div class="sub-section-title">
                <span>Top Categories ({{ edaStats.uniqueN }} Unique)</span>
                <span class="mode-badge">Mode: {{ edaStats.mode }}</span>
              </div>
              <div class="category-bars-list">
                <div v-for="(cat, ci) in edaStats.topCategories" :key="ci" class="cat-bar-item">
                  <div class="cat-header">
                    <span class="cat-name">{{ cat.val }}</span>
                    <span class="cat-count">{{ cat.count }} ({{ cat.pct }}%)</span>
                  </div>
                  <div class="cat-progress-track">
                    <div class="cat-progress-fill" :style="{ width: `${cat.pct}%` }"></div>
                  </div>
                </div>
              </div>
            </div>
          </template>

          <div class="eda-action-bar">
            <button class="btn btn-secondary btn-sm" type="button" @click="launchPlot">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="20" x2="18" y2="10"/>
                <line x1="12" y1="20" x2="12" y2="4"/>
                <line x1="6" y1="20" x2="6" y2="14"/>
              </svg>
              <span>Open in Full Visualizer</span>
            </button>
          </div>
        </div>

      </div>

      <!-- Refined Modal Footer with Center Navigation Stepper -->
      <div class="modal-footer config-footer">
        <div class="footer-left"></div>

        <!-- Centered Prev/Next Navigation Stepper -->
        <div class="footer-center">
          <div class="var-nav-stepper">
            <button
              class="var-nav-btn"
              type="button"
              :disabled="currentColumnIndex <= 0"
              title="Previous variable"
              @click="prevVar"
            >
              &larr; Prev
            </button>
            <span class="var-nav-idx">{{ currentColumnIndex + 1 }} / {{ state.ds.columns.length }}</span>
            <button
              class="var-nav-btn"
              type="button"
              :disabled="currentColumnIndex >= state.ds.columns.length - 1"
              title="Next variable"
              @click="nextVar"
            >
              Next &rarr;
            </button>
          </div>
        </div>

        <div class="footer-actions">
          <button class="btn btn-primary" type="button" @click="close">Done</button>
        </div>
      </div>
    </div>
  </div>
</template>
