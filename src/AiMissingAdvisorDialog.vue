<script lang="ts">
export { resetAiAdvisorCache } from './advisor.ts'
</script>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import {
  state, setMeta, deleteColumnByName, isUserMissing,
  imputeColumnsBatch, mergeDirtyCategories, convertToNumeric,
  winsorizeColumn, undo, undoDepth
} from './store.ts'
import { computeFill, computeModeDetails, type Cell } from './missing.ts'
import { computeMergeValues, computeConvertValues } from './transforms.ts'
import {
  readinessSummary, getAiRecommendation, cachedAiRec, resetAiAdvisorCache
} from './advisor.ts'
import { computeHealth, type QualityIssue, type HealthSummary } from './quality.ts'
import { watchDatasetSession } from './session.ts'

const props = defineProps<{
  modelValue: boolean
  focusVar?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', val: boolean): void
  (e: 'open-analysis', testId: string, options?: Record<string, unknown>): void
  (e: 'open-test-advisor', initialVars?: string[]): void
  (e: 'plot', colName: string): void
}>()

interface AdvisoryItem {
  name: string
  label: string
  type: string
  measure: string
  totalN: number
  missingN: number
  missingPct: number
  skewness: number | null
  recommendedMethod: 'mean' | 'median' | 'mode' | 'interpolate' | 'constant' | 'drop'
  selectedMethod: 'mean' | 'median' | 'mode' | 'interpolate' | 'constant' | 'drop'
  constantVal: string
  rationaleObs: string
  rationaleReason: string
}

interface QualityFixPreview {
  col: string
  kind: string
  title: string
  beforeLabel: string
  beforeValue: string
  afterLabel: string
  afterValue: string
  affectedN?: number
  apply: () => boolean | { ok: boolean; message: string } | void
}

interface StagedImpute {
  name: string
  method: AdvisoryItem['selectedMethod']
  constantVal?: number | string
  missingN: number
  preview: string
}

interface LogEntry {
  id: number
  kind: 'fix' | 'impute' | 'dismiss'
  category?: string
  title: string
  detail: string
  col: string
  rowsAffected: number
  /** Only dismiss entries use this (undo re-enables the dismissed issue). */
  dismissKey?: string
  undone: boolean
}

// --- Step flow ---------------------------------------------------------------
const STEPS = [
  { n: 1, label: 'Check', hint: 'Health & vitals' },
  { n: 2, label: 'Stage', hint: 'Pick & queue fixes' },
  { n: 3, label: 'Apply', hint: 'Summary & commit' }
] as const
const step = ref(1)
const fixStatus = ref('')
function goStep(n: number): void {
  step.value = Math.min(3, Math.max(1, n))
}
function stepKeyNav(ev: KeyboardEvent): void {
  if (ev.key === 'ArrowRight') { ev.preventDefault(); goStep(step.value + 1) }
  else if (ev.key === 'ArrowLeft') { ev.preventDefault(); goStep(step.value - 1) }
}

// --- Scan (Detect) ------------------------------------------------------------
const scanStatus = ref<'loading' | 'ready' | 'error'>('loading')
const scanError = ref('')
const healthTick = ref(0)
const health = computed<HealthSummary | null>(() => {
  void healthTick.value
  try {
    return computeHealth(state.ds)
  } catch (err) {
    scanError.value = err instanceof Error ? err.message : 'Scan failed.'
    scanStatus.value = 'error'
    return null
  }
})
const readiness = computed(() => readinessSummary())
function retryScan(): void {
  scanStatus.value = 'loading'
  scanError.value = ''
  void nextTick().then(() => {
    healthTick.value++
    if (scanStatus.value === 'loading') scanStatus.value = 'ready'
  })
}

// Baseline complete rows captured on open for usable cases delta.
const baseline = ref({ complete: 0, rows: 0 })

// --- Activity log (in-session, with Undo) --------------------------------------
let logId = 0
const activityLog = ref<LogEntry[]>([])
function log(entry: Omit<LogEntry, 'id' | 'undone'>): void {
  activityLog.value.push({ ...entry, id: ++logId, undone: false })
}
const newestUndoableId = computed(() => {
  const live = activityLog.value.filter((e) => !e.undone && e.kind !== 'dismiss')
  return live.length ? live[live.length - 1]!.id : -1
})
function undoEntry(e: LogEntry): void {
  if (e.undone) return
  if (e.kind !== 'dismiss' && e.id !== newestUndoableId.value) return
  if (e.kind === 'dismiss') {
    if (e.dismissKey) {
      if (e.dismissKey.startsWith('missing:')) {
        dismissedMissingNames.value.delete(e.dismissKey.replace('missing:', ''))
      } else {
        dismissedIssueKeys.value.delete(e.dismissKey)
      }
    }
  } else {
    undo()
    analyzeDataset()
    healthTick.value++
  }
  e.undone = true
}

// --- Quality issues ------------------------------------------------------------
const dismissedIssueKeys = ref<Set<string>>(new Set())
const dismissedMissingNames = ref<Set<string>>(new Set())

function issueKey(issue: QualityIssue): string {
  return `${issue.kind}:${issue.col}:${issue.evidence}`
}

function dismissIssue(issue: QualityIssue): void {
  const key = issueKey(issue)
  if (dismissedIssueKeys.value.has(key)) return
  dismissedIssueKeys.value.add(key)
  removeStaged(key)
  log({
    kind: 'dismiss', category: 'Dismiss', title: `Dismissed: ${plainFor(issue).title}`,
    detail: 'Kept as-is for this session', col: issue.col,
    rowsAffected: 0, dismissKey: key
  })
}

function dismissMissing(colName: string): void {
  if (dismissedMissingNames.value.has(colName)) return
  dismissedMissingNames.value.add(colName)
  removeStagedImpute(colName)
  log({
    kind: 'dismiss', category: 'Dismiss', title: `Dismissed missing fill for ${colName}`,
    detail: 'Kept with missing values for this session', col: colName,
    rowsAffected: 0, dismissKey: `missing:${colName}`
  })
}

const visibleIssues = computed(() =>
  (health.value?.issues ?? []).filter((i) => !dismissedIssueKeys.value.has(issueKey(i)))
)

// One-line title + one plain sentence per detector kind (no jargon).
const PLAIN: Record<string, { title: string; plain: string }> = {
  sentinel: {
    title: 'Placeholder codes look like real values',
    plain: 'This column holds placeholder codes such as 99 or 999 that stand in for missing answers, not real measurements.'
  },
  typeMismatch: {
    title: 'Numbers stored as text',
    plain: 'These values look like numbers but are stored as text, so they cannot be used in calculations yet.'
  },
  measureMismatch: {
    title: 'Codes treated as measurements',
    plain: 'This column holds only a few distinct codes, so averages and spreads computed from it would be misleading.'
  },
  unlabeledCodes: {
    title: 'Answer codes without labels',
    plain: 'These answer codes have no text labels, so tables and charts will show bare numbers.'
  },
  constant: {
    title: 'Same value in every row',
    plain: 'Every row has the same value here, so this column cannot tell rows apart.'
  },
  empty: {
    title: 'No usable answers',
    plain: 'This column has no usable answers at all.'
  },
  duplicates: {
    title: 'Repeats another column',
    plain: 'This column repeats another column exactly, so it adds no new information.'
  },
  idLike: {
    title: 'Looks like a row ID',
    plain: 'Almost every row has a different value, like an ID — it labels rows rather than measuring anything.'
  },
  dirtyCategories: {
    title: 'Same category spelled several ways',
    plain: 'The same category is spelled in different ways, which splits one group into several.'
  },
  outliers: {
    title: 'A few far-off values',
    plain: 'A few values sit far from the rest and can pull averages off centre.'
  }
}
const KIND_LABEL: Record<string, string> = {
  sentinel: 'Placeholder',
  typeMismatch: 'Text numbers',
  measureMismatch: 'Codes as measures',
  unlabeledCodes: 'Unlabeled codes',
  constant: 'Constant',
  empty: 'Empty',
  duplicates: 'Duplicate',
  idLike: 'Row ID',
  dirtyCategories: 'Spelling variants',
  outliers: 'Outliers'
}
function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind
}
function plainFor(issue: QualityIssue): { title: string; plain: string } {
  const base = PLAIN[issue.kind] ?? { title: issue.kind, plain: issue.message }
  if (issue.kind === 'measureMismatch' && /^Scale with 2 distinct:/.test(issue.evidence) && /(?:^|[\s:,])0\(\d+\)/.test(issue.evidence) && /(?:^|[\s:,])1\(\d+\)/.test(issue.evidence)) return { ...base, plain: `${base.plain} For 0/1 answers the average is the share of 1s, so the mean is still useful.` }
  return base
}
function fixLineFor(issue: QualityIssue): string {
  const fix = issue.fix
  if (!fix) return 'No automatic fix — review manually. Dismiss keeps it as-is for this session.'
  switch (fix.op) {
    case 'setMetaMissing':
      return `Fix: marks '${fix.value}' as missing so it stays out of means and spreads. Undo anytime.`
    case 'setMeasureNominal':
      return `Fix: excludes ${fix.col} from means and spreads. Undo anytime.`
    case 'applyPreset':
      return fix.preset === 'binary' ? 'Fix: adds text labels to tables and charts. Pairs with the Nominal fix. Undo anytime.' : 'Fix: adds text labels to tables and charts. Undo anytime.'
    case 'deleteColumn':
      return 'Fix: removes this column from the dataset. Undo anytime.'
    case 'mergeCategories':
      return 'Fix: unifies variant spellings into one group. Undo anytime.'
    case 'convertToNumeric':
      return 'Fix: converts text to numbers for calculations. Undo anytime.'
    case 'winsorize':
      return 'Fix: pulls extreme values back to boundary, keeps every row. Undo anytime.'
  }
}
function whyFor(issue: QualityIssue): string {
  switch (issue.kind) {
    case 'sentinel':
      return 'Sentinel codes (99, 999…) are placeholders, not measurements. Declaring them missing keeps statistics honest.'
    case 'measureMismatch':
    case 'idLike':
      return 'Discrete codes and identifiers are groupings, not continuous measurements. Nominal level stops means and spreads being computed on them.'
    case 'unlabeledCodes':
      return 'Value labels replace cryptic numbers in tables and charts for readable output.'
    case 'dirtyCategories':
      return 'Casing or spacing variants split identical categories into separate groups in tables and charts.'
    case 'typeMismatch':
      return 'Numbers stored as text cannot be used in means, correlations, or regressions until converted.'
    case 'constant':
      return 'A column with identical values carries zero variance and adds noise to analyses.'
    case 'empty':
      return 'An all-missing column carries no usable answers.'
    case 'duplicates':
      return 'Identical columns duplicate data and bias statistical models.'
    case 'outliers':
      return 'Extreme values can distort means and regression coefficients. Inspect in a histogram or winsorize.'
    default:
      return issue.message
  }
}

function describeFix(issue: QualityIssue): QualityFixPreview | null {
  const fix = issue.fix
  if (!fix) return null
  const meta = state.ds.columns.find((c) => c.name === fix.col)
  switch (fix.op) {
    case 'mergeCategories': {
      const raw = (state.ds.data[fix.col] ?? []) as Cell[]
      const mergeRes = computeMergeValues(raw, (v) => meta ? isUserMissing(meta, v) : v === null)
      return {
        col: fix.col, kind: 'Dirty Categories', title: 'Normalize case & spacing variants',
        beforeLabel: 'Now', beforeValue: issue.evidence,
        afterLabel: 'After', afterValue: `${mergeRes.changed} cells unified`,
        affectedN: mergeRes.changed,
        apply: () => mergeDirtyCategories(fix.col)
      }
    }
    case 'setMetaMissing': {
      const sentinelCount = ((state.ds.data[fix.col] ?? []) as Cell[]).filter((v) => v === fix.value).length
      return {
        col: fix.col, kind: 'Sentinel placeholder', title: `Treat '${fix.value}' as missing`,
        beforeLabel: 'Now', beforeValue: issue.evidence,
        afterLabel: 'After', afterValue: `'${fix.value}' excluded from statistics · ${sentinelCount} cell${sentinelCount === 1 ? '' : 's'} affected`,
        affectedN: sentinelCount,
        apply: () => {
          const c = state.ds.columns.find((cc) => cc.name === fix.col)
          if (!c) return false
          if (!c.missing.values.some((x) => x === fix.value)) {
            setMeta(fix.col, 'missing', { values: [...c.missing.values, fix.value], ranges: [...c.missing.ranges] })
          }
          return true
        }
      }
    }
    case 'setMeasureNominal': {
      const nominalCount = ((state.ds.data[fix.col] ?? []) as Cell[]).filter((v) => !(meta ? isUserMissing(meta, v) : v === null)).length
      return {
        col: fix.col, kind: 'Measurement level', title: 'Switch level to Nominal',
        beforeLabel: 'Now', beforeValue: issue.evidence,
        afterLabel: 'After', afterValue: `Nominal (group labels, no means) · ${nominalCount} cell${nominalCount === 1 ? '' : 's'} regrouped`,
        affectedN: nominalCount,
        apply: () => {
          setMeta(fix.col, 'measure', 'nominal')
          return true
        }
      }
    }
    case 'applyPreset': {
      const isLikert = fix.preset === 'likert5'
      const presetCount = ((state.ds.data[fix.col] ?? []) as Cell[]).filter((v) => !(meta ? isUserMissing(meta, v) : v === null)).length
      return {
        col: fix.col, kind: 'Value labels', title: `Apply ${isLikert ? '5-point Likert' : 'binary Yes/No'} labels`,
        beforeLabel: 'Now', beforeValue: issue.evidence,
        afterLabel: 'After', afterValue: `${isLikert ? "1='Strongly Disagree' … 5='Strongly Agree'" : "0='No' … 1='Yes'"} · ${presetCount} cell${presetCount === 1 ? '' : 's'} labeled`,
        affectedN: presetCount,
        apply: () => {
          setMeta(fix.col, 'valueLabels', isLikert
            ? { '1': 'Strongly Disagree', '2': 'Disagree', '3': 'Neutral', '4': 'Agree', '5': 'Strongly Agree' }
            : { '0': 'No / Absent', '1': 'Yes / Present' })
          return true
        }
      }
    }
    case 'deleteColumn': {
      const colRows = ((state.ds.data[fix.col] ?? []) as Cell[]).length
      return {
        col: fix.col, kind: 'Column cleanup', title: 'Remove this column',
        beforeLabel: 'Now', beforeValue: issue.evidence,
        afterLabel: 'After', afterValue: `1 column removed, ${colRows} row${colRows === 1 ? '' : 's'} untouched`,
        affectedN: 0,
        apply: () => deleteColumnByName(fix.col)
      }
    }
    case 'convertToNumeric': {
      const raw = (state.ds.data[fix.col] ?? []) as Cell[]
      const conv = computeConvertValues(raw, (v) => meta ? isUserMissing(meta, v) : v === null)
      const parsedCount = conv.converted + conv.nulled
      return {
        col: fix.col, kind: 'Data type', title: 'Convert text numbers to numeric',
        beforeLabel: 'Now', beforeValue: issue.evidence,
        afterLabel: 'After', afterValue: `Numeric storage · ${parsedCount} cell${parsedCount === 1 ? '' : 's'} converted`,
        affectedN: parsedCount,
        apply: () => convertToNumeric(fix.col)
      }
    }
    case 'winsorize': {
      const winCount = Number(/^(\d+) outliers/.exec(issue.evidence)?.[1] ?? 0)
      return {
        col: fix.col, kind: 'Outliers', title: 'Cap extreme values, keep every row',
        beforeLabel: 'Now', beforeValue: issue.evidence,
        afterLabel: 'After', afterValue: `Extreme values pulled back to bounds · ${winCount} cell${winCount === 1 ? '' : 's'} capped`,
        affectedN: winCount,
        apply: () => winsorizeColumn(fix.col)
      }
    }
  }
}

// --- Staging & Review Grouping ------------------------------------------------
const stagedKeys = ref<Set<string>>(new Set())
function isStaged(issue: QualityIssue): boolean {
  return stagedKeys.value.has(issueKey(issue))
}
function stageQuality(issue: QualityIssue): void {
  if (!issue.fix || isStaged(issue)) return
  stagedKeys.value.add(issueKey(issue))
}
function removeStaged(key: string): void {
  stagedKeys.value.delete(key)
}
const stagedQuality = computed(() =>
  (health.value?.issues ?? [])
    .filter((i) => stagedKeys.value.has(issueKey(i)) && !dismissedIssueKeys.value.has(issueKey(i)))
    .map((issue) => ({ issue, preview: describeFix(issue) }))
    .filter((s): s is { issue: QualityIssue; preview: QualityFixPreview } => s.preview !== null)
)

// --- Missing values (local advisory cards) --------------------------------------
const advisoryItems = ref<AdvisoryItem[]>([])
function computeSkewness(nums: number[]): number | null {
  if (nums.length < 3) return null
  const n = nums.length
  const mean = nums.reduce((a, b) => a + b, 0) / n
  let m2 = 0
  let m3 = 0
  for (const x of nums) {
    const d = x - mean
    m2 += d * d
    m3 += d * d * d
  }
  const std = Math.sqrt(m2 / (n - 1))
  if (std === 0) return 0
  return (m3 / n) / Math.pow(std, 3)
}
function analyzeDataset(): void {
  const items: AdvisoryItem[] = []
  for (const c of state.ds.columns) {
    const raw = (state.ds.data[c.name] ?? []) as Array<number | string | null>
    const totalN = raw.length
    if (!totalN) continue
    let missingN = 0
    for (const v of raw) {
      if (isUserMissing(c, v)) missingN++
    }
    if (missingN === 0) continue
    const missingPct = Math.round((missingN / totalN) * 100)
    let recommended: AdvisoryItem['recommendedMethod'] = 'mode'
    let rationaleObs = ''
    let rationaleReason = ''
    let skew: number | null = null
    if (c.type === 'numeric') {
      const validNums = raw.filter((v): v is number => !isUserMissing(c, v) && typeof v === 'number' && Number.isFinite(v))
      skew = computeSkewness(validNums)
      if (missingPct > 40) {
        recommended = 'drop'
        rationaleObs = `High missingness (${missingPct}%)`
        rationaleReason = 'Filling would add heavy bias; dropping deletes rows.'
      } else if (skew !== null && Math.abs(skew) > 1.0) {
        recommended = 'median'
        rationaleObs = `Skewed spread (skew ${skew > 0 ? '+' : ''}${skew.toFixed(2)})`
        rationaleReason = 'Median resists extreme values.'
      } else {
        recommended = 'mean'
        rationaleObs = `Roughly symmetric${skew !== null ? ` (skew ${skew > 0 ? '+' : ''}${skew.toFixed(2)})` : ''}`
        rationaleReason = 'Mean suits roughly symmetric columns.'
      }
    } else {
      rationaleObs = 'Text column'
      rationaleReason = 'Mode (most common answer) preserves observed shares.'
    }
    items.push({
      name: c.name, label: c.label || '', type: c.type, measure: c.measure,
      totalN, missingN, missingPct, skewness: skew,
      recommendedMethod: recommended, selectedMethod: recommended,
      constantVal: '',
      rationaleObs, rationaleReason
    })
  }
  advisoryItems.value = items
}

function computeFillPreview(item: AdvisoryItem): string {
  const meta = state.ds.columns.find((c) => c.name === item.name)
  if (!meta) return ''
  const raw = (state.ds.data[item.name] ?? []) as Cell[]
  if (item.selectedMethod === 'drop') return `Drop ${item.missingN} rows`
  if (item.selectedMethod === 'constant') return item.constantVal.trim() ? `Constant → "${item.constantVal.trim()}"` : 'Enter a constant value'
  if (item.selectedMethod === 'interpolate') return `Interpolate ${item.missingN} cells between neighbors`
  if (item.selectedMethod === 'mode') {
    const details = computeModeDetails(raw, (v) => isUserMissing(meta, v))
    if (!details.mode) return 'No valid category'
    return `Mode → "${String(details.mode)}"`
  }
  const fill = computeFill(raw, item.selectedMethod, (v) => isUserMissing(meta, v), 'first')
  if (fill === null) return 'No valid fill value'
  if (typeof fill === 'number') {
    const dec = meta.decimals ?? 2
    return `${item.selectedMethod === 'mean' ? 'Mean → ' : 'Median → '}${Number(fill.toFixed(dec)).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })}`
  }
  return `"${String(fill)}"`
}

function strategyLabel(method: AdvisoryItem['recommendedMethod']): string {
  switch (method) {
    case 'mean': return 'Mean'
    case 'median': return 'Median'
    case 'mode': return 'Mode'
    case 'interpolate': return 'Linear interpolation'
    case 'constant': return 'Constant'
    case 'drop': return 'Drop missing rows'
  }
}
const totalMissingCells = computed(() => advisoryItems.value.reduce((s, i) => s + i.missingN, 0))
const stagedImputes = ref<StagedImpute[]>([])
const noticesExpanded = ref(false)
const missingExpanded = ref(false)

function formatIssueKind(kind: string): string {
  switch (kind) {
    case 'unlabeledCodes':
    case 'unlabeled_codes': return 'Discrete Codes'
    case 'idLike':
    case 'id_like': return 'Identifier'
    case 'measureMismatch':
    case 'measure_mismatch': return 'Scale Mismatch'
    case 'dirtyCategories':
    case 'dirty_categories': return 'Dirty Categories'
    case 'outliers': return 'Outliers'
    case 'sentinels':
    case 'sentinel_missing': return 'Sentinel Codes'
    case 'constant': return 'Constant'
    case 'empty': return 'Empty'
    default: return kind.replace(/[-_]/g, ' ')
  }
}

function isImputeStaged(item: AdvisoryItem): boolean {
  return stagedImputes.value.some((s) => s.name === item.name)
}
function stageImpute(item: AdvisoryItem): void {
  if (isImputeStaged(item)) return
  if (item.selectedMethod === 'constant' && !item.constantVal.trim()) return
  stagedImputes.value.push({
    name: item.name, method: item.selectedMethod,
    ...(item.selectedMethod === 'constant' ? { constantVal: item.constantVal.trim() } : {}),
    missingN: item.missingN, preview: computeFillPreview(item)
  })
}
function removeStagedImpute(colName: string): void {
  stagedImputes.value = stagedImputes.value.filter((s) => s.name !== colName)
}
function clearAllStaged(): void {
  stagedKeys.value.clear()
  stagedImputes.value = []
}
// Single source for the staged number so the step badge and the Commit button
// can never disagree.
const stagedCount = computed(() => stagedQuality.value.length + stagedImputes.value.length)

// Review issue categories
const scaleIssues = computed(() =>
  visibleIssues.value.filter((i) => ['measureMismatch', 'typeMismatch', 'unlabeledCodes'].includes(i.kind))
)
const visibleAdvisoryItems = computed(() =>
  advisoryItems.value.filter((item) => !dismissedMissingNames.value.has(item.name))
)
const integrityIssues = computed(() =>
  visibleIssues.value.filter((i) => ['outliers', 'sentinels', 'dirtyCategories'].includes(i.kind))
)
const structuralIssues = computed(() =>
  visibleIssues.value.filter((i) => ['idLike', 'constant', 'empty', 'duplicates'].includes(i.kind))
)
const otherIssues = computed(() =>
  visibleIssues.value.filter(
    (i) => !['measureMismatch', 'typeMismatch', 'unlabeledCodes', 'outliers', 'sentinels', 'dirtyCategories', 'idLike', 'constant', 'empty', 'duplicates'].includes(i.kind)
  )
)

function stageGroup(issues: QualityIssue[]): void {
  for (const issue of issues) {
    if (issue.fix) stageQuality(issue)
  }
}
function stageMissingGroup(): void {
  for (const item of visibleAdvisoryItems.value) {
    stageImpute(item)
  }
}

const totalUnstagedCount = computed(() => {
  const unstagedIssues = visibleIssues.value.filter((i) => i.fix && !isStaged(i)).length
  const unstagedImputes = visibleAdvisoryItems.value.filter((item) => !isImputeStaged(item)).length
  return unstagedIssues + unstagedImputes
})

function stageAllFixes(): void {
  for (const issue of visibleIssues.value) {
    if (issue.fix) stageQuality(issue)
  }
  for (const item of visibleAdvisoryItems.value) {
    stageImpute(item)
  }
}

// Batch commit for Apply panel
function applyAllStaged(): void {
  const qualityList = stagedQuality.value.slice()
  const imputesList = stagedImputes.value.slice()
  if (!qualityList.length && !imputesList.length) return

  let appliedCount = 0
  const beforeDepth = undoDepth()

  for (const item of qualityList) {
    try {
      const res = item.preview.apply()
      const failed = res === false || (typeof res === 'object' && res !== null && res.ok === false)
      if (!failed) {
        appliedCount++
        log({
          kind: 'fix',
          category: item.preview.kind,
          title: item.preview.title,
          detail: item.preview.afterValue,
          col: item.preview.col,
          rowsAffected: item.preview.affectedN ?? 0
        })
      }
    } catch {
      // Continue batch
    }
  }

  if (imputesList.length) {
    const varsList = imputesList.map((s) => ({ ...s }))
    const cells = imputesList.reduce((s, i) => s + i.missingN, 0)
    const applied = imputeColumnsBatch(imputesList.map((s) => ({ colName: s.name, method: s.method, constantVal: s.constantVal })))
    if (applied) {
      appliedCount += imputesList.length
      const names = varsList.map((v) => `${v.name} (${strategyLabel(v.method)})`).join(', ')
      log({
        kind: 'impute',
        category: 'Imputation',
        title: `Filled missing values in ${varsList.length} column${varsList.length === 1 ? '' : 's'}`,
        detail: `${names} · ${cells} cells filled`,
        col: varsList.map((v) => v.name).join(', '),
        rowsAffected: cells
      })
    }
  }

  stagedKeys.value.clear()
  stagedImputes.value = []
  analyzeDataset()
  healthTick.value++

  if (undoDepth() > beforeDepth) {
    fixStatus.value = `Successfully applied ${appliedCount} change${appliedCount === 1 ? '' : 's'}.`
  } else {
    fixStatus.value = 'No changes were applied.'
  }
}

// Handover to Test Advisor
function openTestAdvisor(initialVars?: unknown): void {
  close()
  emit('open-test-advisor', Array.isArray(initialVars) ? (initialVars as string[]) : undefined)
}

// --- HITL AI: advisory only, explicit Apply, never auto-applies -----------------
const aiRec = cachedAiRec
const aiRecLoading = ref(false)
function healthRecommendationInput() {
  const h = health.value
  const cells = h ? h.rows * h.columns : 0
  return {
    score: h?.score ?? null,
    rows: h?.rows ?? 0,
    columns: h?.columns ?? 0,
    missingPct: cells > 0 ? Math.round((totalMissingCells.value / cells) * 1000) / 10 : 0,
    topIssues: visibleIssues.value.slice(0, 3).map((i) => ({ kind: i.kind, col: i.col }))
  }
}
let aiReqSeq = 0
async function loadAiRec(): Promise<void> {
  if (aiRecLoading.value) return
  const seq = ++aiReqSeq
  aiRecLoading.value = true
  try {
    const rec = await getAiRecommendation(healthRecommendationInput())
    if (seq === aiReqSeq) aiRec.value = rec
  } finally {
    if (seq === aiReqSeq) aiRecLoading.value = false
  }
}

function resetModalState(): void {
  step.value = 1
  noticesExpanded.value = false
  missingExpanded.value = false
  scanStatus.value = 'loading'
  scanError.value = ''
  stagedKeys.value.clear()
  stagedImputes.value = []
  activityLog.value = []
  dismissedIssueKeys.value.clear()
  dismissedMissingNames.value.clear()
  activeFocusVar.value = null
  fixStatus.value = ''
  resetAiAdvisorCache()
  aiReqSeq++
  aiRecLoading.value = false
}

// Undoable fixes can replace state.ds; only a new dataset session resets the workflow.
watchDatasetSession(() => {
  resetModalState()
  if (props.modelValue) {
    analyzeDataset()
    void nextTick().then(() => {
      healthTick.value++
      baseline.value = {
        complete: readiness.value.completeRows,
        rows: readiness.value.rows
      }
      if (scanStatus.value !== 'error') scanStatus.value = 'ready'
      if (state.ds.columns.length) {
        void loadAiRec()
      }
    })
  }
})
const activeFocusVar = ref<string | null>(props.focusVar ?? null)

function applyAiAction(target: 'missing' | 'readiness' | 'tests', targetCol?: string): void {
  if (targetCol) {
    activeFocusVar.value = targetCol
  }
  if (target === 'tests') {
    openTestAdvisor(targetCol ? [targetCol] : undefined)
  } else {
    step.value = 2
    scrollToFocusCard()
  }
}

/** After the Stage step renders, open the right group and center the focused card so users never hunt for it. */
function scrollToFocusCard(): void {
  void nextTick().then(() => {
    const card = modalCard.value?.querySelector<HTMLElement>('.dha-card.is-focus')
    if (!card) return
    const group = card.closest<HTMLDetailsElement>('details')
    if (group) group.open = true
    card.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
}
function confClass(c?: 'high' | 'medium' | 'low'): string {
  return c === 'high' ? 'prio-high' : c === 'medium' ? 'prio-medium' : 'prio-low'
}

function confLabel(c?: 'high' | 'medium' | 'low'): string {
  return c === 'high' ? 'High priority' : c === 'medium' ? 'Medium' : 'Low'
}

function dimColorClass(pct: number): string {
  if (pct >= 85) return 'is-good'
  if (pct >= 60) return 'is-fair'
  return 'is-low'
}

const scoreRating = computed(() => {
  const s = health.value?.score ?? 0
  if (s >= 85) return { label: 'Optimal', class: 'is-good' }
  if (s >= 70) return { label: 'Good', class: 'is-good' }
  if (s >= 50) return { label: 'Fair', class: 'is-fair' }
  return { label: 'Needs Review', class: 'is-low' }
})

function goToGroup(groupKey: 'scales' | 'missing' | 'integrity' | 'structural'): void {
  step.value = 2
  void nextTick().then(() => {
    const selector = groupKey === 'missing'
      ? '.review-issue-group.is-missing'
      : groupKey === 'integrity'
      ? '.review-issue-group.is-integrity'
      : groupKey === 'structural'
      ? '.review-issue-group.is-structural'
      : '.review-issue-group.is-scales'
    const el = modalCard.value?.querySelector<HTMLDetailsElement>(selector)
    if (el) {
      el.open = true
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  })
}

// --- Impact & Audit Trail --------------------------------------------------------
const activeActionsCount = computed(() =>
  activityLog.value.filter((e) => !e.undone && e.kind !== 'dismiss').length
)
const colsTouched = computed(() =>
  new Set(activityLog.value.filter((e) => !e.undone && e.kind !== 'dismiss').flatMap((e) => e.col.split(',').map((s) => s.trim()).filter(Boolean))).size
)
const rowsTouched = computed(() =>
  activityLog.value.filter((e) => !e.undone && e.kind !== 'dismiss').reduce((s, e) => s + e.rowsAffected, 0)
)
const completeRowsGained = computed(() =>
  Math.max(0, readiness.value.completeRows - baseline.value.complete)
)

function logCategoryBadge(e: LogEntry): { label: string; class: string } {
  if (e.kind === 'impute') return { label: 'Impute', class: 'is-impute' }
  if (e.kind === 'dismiss') return { label: 'Dismiss', class: 'is-dismiss' }
  const cat = (e.category || '').toLowerCase()
  if (cat.includes('measure') || cat.includes('type')) return { label: 'Scale', class: 'is-scale' }
  if (cat.includes('label')) return { label: 'Labels', class: 'is-labels' }
  if (cat.includes('dirty') || cat.includes('categorie')) return { label: 'Clean', class: 'is-clean' }
  if (cat.includes('sentinel')) return { label: 'Sentinel', class: 'is-sentinel' }
  if (cat.includes('outlier')) return { label: 'Outlier', class: 'is-outlier' }
  return { label: 'Fix', class: 'is-fix' }
}

// --- Modal behaviour: outside-click + Escape + focus trap + return focus ---------
const modalCard = ref<HTMLElement | null>(null)
let lastFocused: Element | null = null
function close(): void {
  emit('update:modelValue', false)
  noticesExpanded.value = false
  missingExpanded.value = false
  step.value = 1
  activeFocusVar.value = null
  fixStatus.value = ''
  if (lastFocused instanceof HTMLElement) lastFocused.focus()
}
function handleKeyDown(ev: KeyboardEvent): void {
  if (!props.modelValue) return
  if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && (ev.key === 'z' || ev.key === 'Z' || ev.key === 'y' || ev.key === 'Y')) {
    const t = ev.target as HTMLElement | null
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
    ev.preventDefault()
    ev.stopPropagation()
    if (ev.key.toLowerCase() === 'z') {
      const newest = activityLog.value.find((e) => e.id === newestUndoableId.value)
      if (newest) undoEntry(newest)
    }
    return
  }
  if (ev.key === 'Escape') { close(); return }
  if (ev.key !== 'Tab') return
  const root = modalCard.value
  if (!root) return
  const focusables = Array.from(
    root.querySelectorAll<HTMLElement>('button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')
  ).filter((el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true' && el.offsetParent !== null)
  if (!focusables.length) return
  const first = focusables[0]!
  const last = focusables[focusables.length - 1]!
  if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus() }
  else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus() }
}
onMounted(() => {
  window.addEventListener('keydown', handleKeyDown, true)
})
onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown, true)
})

watch(
  () => [props.modelValue, props.focusVar] as const,
  ([open, fv]) => {
    if (open) {
      resetModalState()
      activeFocusVar.value = fv ?? null
      step.value = fv ? 2 : 1
      analyzeDataset()
      void nextTick().then(() => {
        healthTick.value++
        baseline.value = {
          complete: readiness.value.completeRows,
          rows: readiness.value.rows
        }
        if (scanStatus.value !== 'error') scanStatus.value = 'ready'
        modalCard.value?.focus()
        if (fv) scrollToFocusCard()
        if (!aiRec.value && state.ds.columns.length) {
          void loadAiRec()
        }
      })
    } else {
      noticesExpanded.value = false
      missingExpanded.value = false
      step.value = 1
      activeFocusVar.value = null
      fixStatus.value = ''
    }
  }
)
</script>

<template>
  <div v-if="modelValue" class="modal-backdrop" @click.self="close">
    <div ref="modalCard" class="modal-card ai-advisor-modal" role="dialog" aria-modal="true" aria-labelledby="dha-title" tabindex="-1">
      <div class="modal-header">
        <div class="modal-title-wrap">
          <div class="dha-title-icon-wrap">
            <img src="/icon.png" alt="ARAStat" class="dha-app-icon" />
          </div>
          <div>
            <h3 id="dha-title">Data Health &amp; Preparation</h3>
            <p class="modal-subtitle">Quality audit, measurement scale validation, and missing value preparation.</p>
          </div>
        </div>
        <button class="icon-close-btn" title="Close (Esc)" aria-label="Close" @click="close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div class="modal-body">
        <!-- STEP 1: AUDIT / DETECT -->
        <section v-if="step === 1" aria-label="Step 1: Check">
          <div v-if="scanStatus === 'loading'" class="dha-skeleton" aria-live="polite" aria-label="Scanning dataset">
            <div class="ai-rec-skel-line is-wide"></div>
            <div class="ai-rec-skel-line"></div>
            <div class="ai-rec-skel-line is-narrow"></div>
          </div>
          <div v-else-if="scanStatus === 'error'" class="advisor-empty-state" role="alert">
            <h4>Scan failed</h4>
            <p>{{ scanError || 'The local scan could not finish.' }}</p>
            <button type="button" class="btn btn-primary" @click="retryScan">Retry scan</button>
          </div>
          <div v-else-if="!health" class="advisor-empty-state">
            <h4>No data to score</h4>
            <p>Import a dataset to see its health score and recommended actions.</p>
          </div>
          <template v-else>
            <!-- Executive Vitals Anchor: Score Radial Gauge (Left), 4 Dimension Gauges (Center), Scope & Completeness (Right) -->
            <div class="executive-vitals-anchor">
              <!-- Pillar 1: Health Score Gauge -->
              <div class="vitals-score-pillar" :class="scoreRating.class">
                <div class="vitals-gauge-wrap">
                  <svg class="vitals-gauge-svg" width="56" height="56" viewBox="0 0 56 56">
                    <circle class="gauge-bg" cx="28" cy="28" r="23" stroke-width="4.5" fill="none" />
                    <circle
                      class="gauge-fill"
                      cx="28"
                      cy="28"
                      r="23"
                      stroke-width="4.5"
                      fill="none"
                      :stroke-dasharray="144.51"
                      :stroke-dashoffset="144.51 * (1 - Math.min(100, Math.max(0, health.score)) / 100)"
                    />
                  </svg>
                  <div class="vitals-gauge-center">
                    <span class="vitals-score-num">{{ Math.round(health.score) }}</span>
                  </div>
                </div>
                <div class="vitals-score-info">
                  <span class="vitals-score-tag" :class="scoreRating.class">{{ scoreRating.label }}</span>
                  <span class="vitals-score-hint">Quality Index</span>
                </div>
              </div>

              <!-- Pillar 2: 4 Dimension Quality Bars -->
              <div class="vitals-dims-pillar">
                <div class="vitals-dims-grid">
                  <div
                    v-for="dim in health.dimensions"
                    :key="dim.id"
                    class="vitals-dim-card"
                    :class="dimColorClass(dim.pct)"
                    :title="`${dim.label}: ${Math.round(dim.pct)}% — ${dim.detail}`"
                  >
                    <div class="vitals-dim-head">
                      <span class="dim-name">{{ dim.label }}</span>
                      <span class="dim-val">{{ Math.round(dim.pct) }}%</span>
                    </div>
                    <div class="vitals-dim-track">
                      <div class="vitals-dim-bar" :style="{ width: `${Math.min(100, Math.max(0, dim.pct))}%` }"></div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Pillar 3: Scope & Case Completeness -->
              <div class="vitals-scope-pillar">
                <div class="scope-stat-box">
                  <div class="scope-stat-row">
                    <svg class="scope-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <path d="M3 9h18M9 21V9" />
                    </svg>
                    <strong class="scope-size-text">{{ health.rows.toLocaleString() }} rows &times; {{ health.columns }} columns</strong>
                  </div>
                  <div class="scope-cases-row">
                    <span class="scope-cases-count">{{ readiness.completeRows }}/{{ readiness.rows }} valid cases</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- 2. AI Data Health Advisor: Pure Advisory Guidance (Actions in Stage 2) -->
            <div class="dha-advisor-section">
              <div class="dha-advisor-head">
                <div class="dha-advisor-title-wrap">
                  <div class="ai-spark-icon-sm">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z"/>
                    </svg>
                  </div>
                  <div>
                    <strong class="dha-advisor-title">AI Data Health Advisor</strong>
                    <span class="dha-advisor-subtitle">Contextual guidance on variable scaling, imputation strategy, and data readiness.</span>
                  </div>
                </div>
              </div>

              <!-- Shimmer Loading Animation -->
              <div v-if="aiRecLoading" class="advisor-loading-card" role="status" aria-label="Analyzing quality patterns">
                <div class="advisor-loading-status">
                  <div class="pulse-indicator"></div>
                  <span>Evaluating distributions, measurement scales, and missingness mechanisms...</span>
                </div>
                <div class="shimmer-card-row">
                  <div class="shimmer-card">
                    <div class="shimmer-bar is-tag"></div>
                    <div class="shimmer-bar is-title"></div>
                    <div class="shimmer-bar is-desc"></div>
                  </div>
                  <div class="shimmer-card">
                    <div class="shimmer-bar is-tag"></div>
                    <div class="shimmer-bar is-title"></div>
                    <div class="shimmer-bar is-desc"></div>
                  </div>
                </div>
              </div>

              <!-- Idle Prompt with Preview Highlights -->
              <div v-else-if="!aiRec" class="advisor-idle-card">
                <p class="advisor-idle-text">
                  Get prioritized suggestions on measurement scaling, imputation strategy, and test readiness &mdash; aggregated data only, nothing leaves your device.
                </p>
                <div class="advisor-preview-chips">
                  <div class="advisor-preview-chip">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                    </svg>
                    <span>Scale validation</span>
                  </div>
                  <div class="advisor-preview-chip">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M12 6v6l4 2" />
                    </svg>
                    <span>Imputation safety</span>
                  </div>
                  <div class="advisor-preview-chip">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <span>Inferential models</span>
                  </div>
                </div>
              </div>

              <!-- Loaded Recommendations (Advisory Only) -->
              <div v-else class="advisor-results">
                <div class="advisor-rec-card is-primary is-advisory">
                  <div class="rec-top-row">
                    <span v-if="aiRec.primary.cols?.length" class="rec-col-chip">{{ aiRec.primary.cols.join(', ') }}</span>
                    <span class="rec-conf-tag" :class="confClass(aiRec.primary.confidence)">{{ confLabel(aiRec.primary.confidence) }}</span>
                  </div>
                  <h5 class="rec-title">{{ aiRec.primary.title }}</h5>
                  <p v-if="aiRec.primary.reason || aiRec.primary.detail" class="rec-desc">
                    {{ aiRec.primary.reason || aiRec.primary.detail }}
                  </p>
                </div>

                <div v-if="aiRec.secondary?.length" class="advisor-secondary-grid">
                  <div
                    v-for="(rec, idx) in aiRec.secondary"
                    :key="idx"
                    class="advisor-rec-card is-advisory"
                  >
                    <div class="rec-top-row">
                      <span v-if="rec.cols?.length" class="rec-col-chip">{{ rec.cols.join(', ') }}</span>
                      <span class="rec-conf-tag" :class="confClass(rec.confidence)">{{ rec.confidence }}</span>
                    </div>
                    <h5 class="rec-title">{{ rec.title }}</h5>
                    <p v-if="rec.reason || rec.detail" class="rec-desc">{{ rec.reason || rec.detail }}</p>
                  </div>
                </div>
                <p v-if="aiRec.error" class="advisor-error-note">{{ aiRec.error }}</p>
              </div>
            </div>

            <!-- 3. Primary Audit Findings: Advisory diagnosis cards (Action is only in Stage 2) -->
            <div v-if="visibleIssues.length || advisoryItems.length" class="dha-findings-row">
              <!-- Card 1: Column Notices (Expandable) -->
              <div class="dha-finding-card is-notices" :class="{ 'is-expanded': noticesExpanded }">
                <div class="finding-card-icon is-notices">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                </div>
                <div class="finding-card-body">
                  <div class="dha-finding-title-row">
                    <strong class="dha-finding-title">Column Notices</strong>
                    <span class="dha-finding-count-badge" :class="{ 'is-warn': visibleIssues.length > 0 }">
                      {{ visibleIssues.length }}
                    </span>
                    <button
                      v-if="visibleIssues.length > 0"
                      type="button"
                      class="dha-expand-toggle-btn"
                      :title="noticesExpanded ? 'Hide impacted columns' : 'Show impacted columns'"
                      :aria-expanded="noticesExpanded"
                      @click="noticesExpanded = !noticesExpanded"
                    >
                      <span>{{ noticesExpanded ? 'Hide' : 'Details' }}</span>
                      <svg :class="{ 'is-rotated': noticesExpanded }" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                  </div>
                  <p class="dha-finding-desc">
                    {{ visibleIssues.length ? `${visibleIssues.length} issues on discrete codes, IDs, or outliers.` : 'All columns have appropriate measurement levels.' }}
                  </p>
                  <p v-if="visibleIssues.length" class="dha-finding-rec">
                    <strong>Recommendation:</strong> Review variable scales, discrete codes, or outlier thresholds in Stage 2.
                  </p>

                  <!-- Impacted Columns Detail Drawer -->
                  <div v-if="noticesExpanded && visibleIssues.length" class="dha-finding-impact-list">
                    <div v-for="issue in visibleIssues" :key="issueKey(issue)" class="dha-impact-item">
                      <div class="dha-impact-head">
                        <code class="dha-impact-col-name">{{ issue.col }}</code>
                        <span class="dha-impact-kind-tag">{{ formatIssueKind(issue.kind) }}</span>
                      </div>
                      <div class="dha-impact-body" :title="issue.evidence ? `${issue.message} (${issue.evidence})` : issue.message">
                        <span class="dha-impact-msg">{{ issue.message }}</span>
                        <span v-if="issue.evidence && !issue.message.includes(issue.evidence)" class="dha-impact-evid">&middot; {{ issue.evidence }}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Card 2: Missing Data (Expandable) -->
              <div class="dha-finding-card is-missing" :class="{ 'is-expanded': missingExpanded }">
                <div class="finding-card-icon is-missing">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                    <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
                    <line x1="12" y1="22.08" x2="12" y2="12"/>
                  </svg>
                </div>
                <div class="finding-card-body">
                  <div class="dha-finding-title-row">
                    <strong class="dha-finding-title">Missing Data</strong>
                    <span class="dha-finding-count-badge" :class="{ 'is-warn': totalMissingCells > 0 }">
                      {{ totalMissingCells }} cells
                    </span>
                    <button
                      v-if="advisoryItems.length > 0"
                      type="button"
                      class="dha-expand-toggle-btn"
                      :title="missingExpanded ? 'Hide impacted columns' : 'Show impacted columns'"
                      :aria-expanded="missingExpanded"
                      @click="missingExpanded = !missingExpanded"
                    >
                      <span>{{ missingExpanded ? 'Hide' : 'Details' }}</span>
                      <svg :class="{ 'is-rotated': missingExpanded }" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                  </div>
                  <p class="dha-finding-desc">
                    {{ advisoryItems.length ? `${advisoryItems.length} columns have missing values across cases.` : 'Dataset is 100% complete across all columns.' }}
                  </p>
                  <p v-if="advisoryItems.length" class="dha-finding-rec">
                    <strong>Recommendation:</strong> Impute with central tendency (median/mode) or drop cases in Stage 2.
                  </p>

                  <!-- Impacted Columns Detail Drawer -->
                  <div v-if="missingExpanded && advisoryItems.length" class="dha-finding-impact-list">
                    <div v-for="item in advisoryItems" :key="item.name" class="dha-impact-item">
                      <div class="dha-impact-head">
                        <code class="dha-impact-col-name">{{ item.name }}</code>
                        <span class="dha-impact-measure-tag">{{ item.measure }}</span>
                      </div>
                      <div class="dha-impact-body">
                        <span class="dha-impact-msg">
                          <strong>{{ item.missingN }}</strong> cell{{ item.missingN === 1 ? '' : 's' }} ({{ item.missingPct }}%)
                        </span>
                        <span class="dha-impact-evid">&middot; Suggested: {{ strategyLabel(item.recommendedMethod) }}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div v-else class="dha-clean-bar">
              <div class="clean-check-icon">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <div class="clean-check-text">
                <strong>Dataset looks clean</strong>
                <span>All variables properly measured with zero unhandled missing cells.</span>
              </div>
            </div>
          </template>
        </section>

        <!-- STEP 2: REVIEW -->
        <section v-else-if="step === 2" aria-label="Step 2: Review">
          <div class="dha-section-header-row">
            <div class="dha-section-header-text">
              <h4 class="dha-section-title">Review Identified Issues ({{ visibleIssues.length + visibleAdvisoryItems.length }})</h4>
              <p class="dha-subhead-note">Issues grouped by statistical category. Stage fixes to preview and batch-apply them in Apply.</p>
            </div>
            <div class="dha-batch-actions">
              <button
                type="button"
                class="btn-stage-all"
                :disabled="totalUnstagedCount === 0"
                :title="totalUnstagedCount > 0 ? `Stage all ${totalUnstagedCount} available automatic fixes` : 'All available fixes are staged'"
                @click="stageAllFixes"
              >
                <span v-if="totalUnstagedCount > 0">Stage All Fixes ({{ totalUnstagedCount }})</span>
                <span v-else>All Fixes Staged</span>
              </button>
            </div>
          </div>

          <div v-if="!visibleIssues.length && !visibleAdvisoryItems.length" class="quality-clean-card">
            <div>
              <strong>No issues detected</strong>
              <p>All columns have appropriate levels, complete observations, and standard formatting.</p>
            </div>
          </div>

          <!-- Group 1: Measurement Scales & Types -->
          <details v-if="scaleIssues.length" open class="review-issue-group is-scales">
            <summary class="review-group-summary">
              <div class="review-group-title">
                <strong>Measurement Scales &amp; Types</strong>
                <span class="review-group-badge">{{ scaleIssues.length }}</span>
              </div>
              <div class="review-group-actions" @click.stop>
                <button
                  type="button"
                  class="btn-stage-group"
                  :disabled="scaleIssues.filter((i) => i.fix && !isStaged(i)).length === 0"
                  title="Stage all fixes in this category"
                  @click="stageGroup(scaleIssues)"
                >
                  Stage Group ({{ scaleIssues.filter((i) => i.fix && !isStaged(i)).length }})
                </button>
              </div>
            </summary>
            <div class="review-grid-2col">
              <article
                v-for="issue in scaleIssues"
                :key="issueKey(issue)"
                class="dha-card"
                :class="{ 'is-focus': issue.col === activeFocusVar }"
              >
                <button
                  class="btn-card-dismiss"
                  type="button"
                  title="Dismiss issue for this session"
                  aria-label="Dismiss issue"
                  @click="dismissIssue(issue)"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
                <div class="dha-card-head-content">
                  <span class="dha-col-chip">{{ issue.col }}</span>
                  <span class="quality-kind-badge" :class="issue.severity">{{ kindLabel(issue.kind) }}</span>
                  <strong class="dha-card-issue-title">{{ plainFor(issue).title }}</strong>
                </div>
                <div class="dha-card-summary">
                  <p class="dha-diag-text"><span class="dha-meta-label">Observed:</span> {{ issue.evidence }} &mdash; {{ plainFor(issue).plain }}</p>
                  <p class="dha-action-text"><span class="dha-meta-label">Resolution:</span> {{ fixLineFor(issue) }}</p>
                </div>
                <details v-if="whyFor(issue)" class="dha-rationale-box">
                  <summary class="dha-rationale-trigger">
                    <div class="dha-rationale-trigger-content">
                      <svg class="dha-rationale-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="16" x2="12" y2="12" />
                        <line x1="12" y1="8" x2="12.01" y2="8" />
                      </svg>
                      <span class="dha-rationale-trigger-title">Statistical Rationale</span>
                    </div>
                    <svg class="dha-rationale-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </summary>
                  <div class="dha-rationale-body">
                    {{ whyFor(issue) }}
                  </div>
                </details>
                <div class="dha-actions">
                  <button
                    v-if="issue.fix"
                    class="btn-stage-fix"
                    :class="{ 'is-staged': isStaged(issue) }"
                    type="button"
                    :disabled="isStaged(issue)"
                    @click="stageQuality(issue)"
                  >
                    <svg v-if="isStaged(issue)" class="btn-check-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    <span>{{ isStaged(issue) ? 'Staged' : 'Stage Fix' }}</span>
                  </button>
                  <span v-else class="quality-fix-note">Manual label in Variable View</span>
                </div>
              </article>
            </div>
          </details>

          <!-- Group 2: Missing Values & Imputation -->
          <details v-if="visibleAdvisoryItems.length" open class="review-issue-group is-missing">
            <summary class="review-group-summary">
              <div class="review-group-title">
                <strong>Missing Values &amp; Imputation</strong>
                <span class="review-group-badge">{{ visibleAdvisoryItems.length }}</span>
              </div>
              <div class="review-group-actions" @click.stop>
                <button
                  type="button"
                  class="btn-stage-group"
                  :disabled="visibleAdvisoryItems.filter((i) => !isImputeStaged(i)).length === 0"
                  title="Stage all imputations in this category"
                  @click="stageMissingGroup"
                >
                  Stage Group ({{ visibleAdvisoryItems.filter((i) => !isImputeStaged(i)).length }})
                </button>
              </div>
            </summary>
            <div class="review-grid-2col">
              <article
                v-for="item in visibleAdvisoryItems"
                :key="item.name"
                class="dha-card"
                :class="{ 'is-focus': item.name === activeFocusVar }"
              >
                <button
                  class="btn-card-dismiss"
                  type="button"
                  title="Dismiss missing fill for this session"
                  aria-label="Dismiss missing fill"
                  @click="dismissMissing(item.name)"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
                <div class="dha-card-head-content">
                  <span class="dha-col-chip">{{ item.name }}</span>
                  <span class="quality-kind-badge warn">missing</span>
                  <strong class="dha-card-issue-title">Incomplete Cases</strong>
                </div>
                <div class="dha-card-summary">
                  <p class="dha-diag-text">
                    <span class="dha-meta-label">Observed:</span> {{ item.missingN }} of {{ item.totalN }} cells missing ({{ item.missingPct }}%). {{ item.rationaleObs }}.
                  </p>
                  <p class="dha-action-text">
                    <span class="dha-meta-label">Resolution:</span> {{ computeFillPreview(item) }}.
                  </p>
                </div>
                <details v-if="item.rationaleReason" class="dha-rationale-box">
                  <summary class="dha-rationale-trigger">
                    <div class="dha-rationale-trigger-content">
                      <svg class="dha-rationale-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="16" x2="12" y2="12" />
                        <line x1="12" y1="8" x2="12.01" y2="8" />
                      </svg>
                      <span class="dha-rationale-trigger-title">Statistical Rationale</span>
                    </div>
                    <svg class="dha-rationale-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </summary>
                  <div class="dha-rationale-body">
                    {{ item.rationaleReason }}
                  </div>
                </details>
                <div class="dha-strategy-action-bar">
                  <div class="dha-strategy-field">
                    <label :for="`strategy-${item.name}`" class="dha-strategy-label">Strategy</label>
                    <div class="dha-strategy-select-wrap">
                      <select
                        :id="`strategy-${item.name}`"
                        v-model="item.selectedMethod"
                        class="dha-strategy-select"
                        :aria-label="`Missing value strategy for ${item.name}`"
                      >
                        <option v-if="item.type === 'numeric'" value="mean">Mean (average)</option>
                        <option v-if="item.type === 'numeric'" value="median">Median (robust)</option>
                        <option value="mode">Mode (most common)</option>
                        <option value="constant">Constant</option>
                        <option v-if="item.type === 'numeric'" value="interpolate">Linear interpolation</option>
                        <option value="drop">Drop missing rows</option>
                      </select>
                      <svg
                        class="dha-select-chevron"
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2.5"
                        aria-hidden="true"
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </div>
                    <input
                      v-if="item.selectedMethod === 'constant'"
                      v-model="item.constantVal"
                      type="text"
                      class="dha-strategy-input"
                      :aria-label="`Constant fill value for ${item.name}`"
                      placeholder="Fill value"
                    >
                  </div>
                  <button
                    class="btn-stage-fix"
                    :class="{ 'is-staged': isImputeStaged(item) }"
                    type="button"
                    :disabled="isImputeStaged(item)"
                    @click="stageImpute(item)"
                  >
                    <svg v-if="isImputeStaged(item)" class="btn-check-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    <span>{{ isImputeStaged(item) ? 'Staged' : 'Stage Fix' }}</span>
                  </button>
                </div>
              </article>
            </div>
          </details>

          <!-- Group 3: Data Integrity & Outliers -->
          <details v-if="integrityIssues.length" open class="review-issue-group is-integrity">
            <summary class="review-group-summary">
              <div class="review-group-title">
                <strong>Data Integrity &amp; Outliers</strong>
                <span class="review-group-badge">{{ integrityIssues.length }}</span>
              </div>
              <div class="review-group-actions" @click.stop>
                <button
                  type="button"
                  class="btn-stage-group"
                  :disabled="integrityIssues.filter((i) => i.fix && !isStaged(i)).length === 0"
                  title="Stage all fixes in this category"
                  @click="stageGroup(integrityIssues)"
                >
                  Stage Group ({{ integrityIssues.filter((i) => i.fix && !isStaged(i)).length }})
                </button>
              </div>
            </summary>
            <div class="review-grid-2col">
              <article
                v-for="issue in integrityIssues"
                :key="issueKey(issue)"
                class="dha-card"
                :class="{ 'is-focus': issue.col === activeFocusVar }"
              >
                <button
                  class="btn-card-dismiss"
                  type="button"
                  title="Dismiss issue for this session"
                  aria-label="Dismiss issue"
                  @click="dismissIssue(issue)"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
                <div class="dha-card-head-content">
                  <span class="dha-col-chip">{{ issue.col }}</span>
                  <span class="quality-kind-badge" :class="issue.severity">{{ kindLabel(issue.kind) }}</span>
                  <strong class="dha-card-issue-title">{{ plainFor(issue).title }}</strong>
                </div>
                <div class="dha-card-summary">
                  <p class="dha-diag-text"><span class="dha-meta-label">Observed:</span> {{ issue.evidence }} &mdash; {{ plainFor(issue).plain }}</p>
                  <p class="dha-action-text"><span class="dha-meta-label">Resolution:</span> {{ fixLineFor(issue) }}</p>
                </div>
                <details v-if="whyFor(issue)" class="dha-rationale-box">
                  <summary class="dha-rationale-trigger">
                    <div class="dha-rationale-trigger-content">
                      <svg class="dha-rationale-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="16" x2="12" y2="12" />
                        <line x1="12" y1="8" x2="12.01" y2="8" />
                      </svg>
                      <span class="dha-rationale-trigger-title">Statistical Rationale</span>
                    </div>
                    <svg class="dha-rationale-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </summary>
                  <div class="dha-rationale-body">
                    {{ whyFor(issue) }}
                  </div>
                </details>
                <div class="dha-actions">
                  <button
                    v-if="issue.fix"
                    class="btn-stage-fix"
                    :class="{ 'is-staged': isStaged(issue) }"
                    type="button"
                    :disabled="isStaged(issue)"
                    @click="stageQuality(issue)"
                  >
                    <svg v-if="isStaged(issue)" class="btn-check-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    <span>{{ isStaged(issue) ? 'Staged' : 'Stage Fix' }}</span>
                  </button>
                  <span v-else class="quality-fix-note">Review manually</span>
                </div>
              </article>
            </div>
          </details>

          <!-- Group 4: Structural Noise & Identifiers -->
          <details v-if="structuralIssues.length" open class="review-issue-group is-structural">
            <summary class="review-group-summary">
              <div class="review-group-title">
                <strong>Structural Noise &amp; Identifiers</strong>
                <span class="review-group-badge">{{ structuralIssues.length }}</span>
              </div>
              <div class="review-group-actions" @click.stop>
                <button
                  type="button"
                  class="btn-stage-group"
                  :disabled="structuralIssues.filter((i) => i.fix && !isStaged(i)).length === 0"
                  title="Stage all fixes in this category"
                  @click="stageGroup(structuralIssues)"
                >
                  Stage Group ({{ structuralIssues.filter((i) => i.fix && !isStaged(i)).length }})
                </button>
              </div>
            </summary>
            <div class="review-grid-2col">
              <article
                v-for="issue in structuralIssues"
                :key="issueKey(issue)"
                class="dha-card"
                :class="{ 'is-focus': issue.col === activeFocusVar }"
              >
                <button
                  class="btn-card-dismiss"
                  type="button"
                  title="Dismiss issue for this session"
                  aria-label="Dismiss issue"
                  @click="dismissIssue(issue)"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
                <div class="dha-card-head-content">
                  <span class="dha-col-chip">{{ issue.col }}</span>
                  <span class="quality-kind-badge" :class="issue.severity">{{ kindLabel(issue.kind) }}</span>
                  <strong class="dha-card-issue-title">{{ plainFor(issue).title }}</strong>
                </div>
                <div class="dha-card-summary">
                  <p class="dha-diag-text"><span class="dha-meta-label">Observed:</span> {{ issue.evidence }} &mdash; {{ plainFor(issue).plain }}</p>
                  <p class="dha-action-text"><span class="dha-meta-label">Resolution:</span> {{ fixLineFor(issue) }}</p>
                </div>
                <details v-if="whyFor(issue)" class="dha-rationale-box">
                  <summary class="dha-rationale-trigger">
                    <div class="dha-rationale-trigger-content">
                      <svg class="dha-rationale-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="16" x2="12" y2="12" />
                        <line x1="12" y1="8" x2="12.01" y2="8" />
                      </svg>
                      <span class="dha-rationale-trigger-title">Statistical Rationale</span>
                    </div>
                    <svg class="dha-rationale-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </summary>
                  <div class="dha-rationale-body">
                    {{ whyFor(issue) }}
                  </div>
                </details>
                <div class="dha-actions">
                  <button
                    v-if="issue.fix"
                    class="btn-stage-fix"
                    :class="{ 'is-staged': isStaged(issue) }"
                    type="button"
                    :disabled="isStaged(issue)"
                    @click="stageQuality(issue)"
                  >
                    <svg v-if="isStaged(issue)" class="btn-check-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    <span>{{ isStaged(issue) ? 'Staged' : 'Stage Fix' }}</span>
                  </button>
                  <span v-else class="quality-fix-note">Review manually</span>
                </div>
              </article>
            </div>
          </details>

          <!-- Group 5: Other Issues -->
          <details v-if="otherIssues.length" open class="review-issue-group is-other">
            <summary class="review-group-summary">
              <div class="review-group-title">
                <strong>Other Observations</strong>
                <span class="review-group-badge">{{ otherIssues.length }}</span>
              </div>
              <div class="review-group-actions" @click.stop>
                <button
                  type="button"
                  class="btn-stage-group"
                  :disabled="otherIssues.filter((i) => i.fix && !isStaged(i)).length === 0"
                  title="Stage all fixes in this category"
                  @click="stageGroup(otherIssues)"
                >
                  Stage Group ({{ otherIssues.filter((i) => i.fix && !isStaged(i)).length }})
                </button>
              </div>
            </summary>
            <div class="review-grid-2col">
              <article
                v-for="issue in otherIssues"
                :key="issueKey(issue)"
                class="dha-card"
                :class="{ 'is-focus': issue.col === activeFocusVar }"
              >
                <button
                  class="btn-card-dismiss"
                  type="button"
                  title="Dismiss issue for this session"
                  aria-label="Dismiss issue"
                  @click="dismissIssue(issue)"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
                <div class="dha-card-head-content">
                  <span class="dha-col-chip">{{ issue.col }}</span>
                  <span class="quality-kind-badge" :class="issue.severity">{{ kindLabel(issue.kind) }}</span>
                  <strong class="dha-card-issue-title">{{ plainFor(issue).title }}</strong>
                </div>
                <div class="dha-card-summary">
                  <p class="dha-diag-text"><span class="dha-meta-label">Observed:</span> {{ issue.evidence }} &mdash; {{ plainFor(issue).plain }}</p>
                  <p class="dha-action-text"><span class="dha-meta-label">Resolution:</span> {{ fixLineFor(issue) }}</p>
                </div>
                <details v-if="whyFor(issue)" class="dha-rationale-box">
                  <summary class="dha-rationale-trigger">
                    <div class="dha-rationale-trigger-content">
                      <svg class="dha-rationale-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="16" x2="12" y2="12" />
                        <line x1="12" y1="8" x2="12.01" y2="8" />
                      </svg>
                      <span class="dha-rationale-trigger-title">Statistical Rationale</span>
                    </div>
                    <svg class="dha-rationale-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </summary>
                  <div class="dha-rationale-body">
                    {{ whyFor(issue) }}
                  </div>
                </details>
                <div class="dha-actions">
                  <button
                    v-if="issue.fix"
                    class="btn-stage-fix"
                    :class="{ 'is-staged': isStaged(issue) }"
                    type="button"
                    :disabled="isStaged(issue)"
                    @click="stageQuality(issue)"
                  >
                    <svg v-if="isStaged(issue)" class="btn-check-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    <span>{{ isStaged(issue) ? 'Staged' : 'Stage Fix' }}</span>
                  </button>
                </div>
              </article>
            </div>
          </details>
        </section>

        <!-- STEP 3: APPLY (Pre-Flight Manifest & Audit Trail) -->
        <section v-else-if="step === 3" aria-label="Step 3: Apply">
          <!-- Pending Staged Changes Section -->
          <template v-if="stagedQuality.length || stagedImputes.length">
            <div class="dha-section-header-row">
              <div>
                <h4 class="dha-section-title">Pre-Flight Change Manifest ({{ stagedQuality.length + stagedImputes.length }})</h4>
                <p class="dha-subhead-note">Review pending modifications before committing them to the dataset.</p>
              </div>
            </div>

            <!-- Pre-flight Manifest Table -->
            <div class="preflight-manifest-wrap">
              <table class="manifest-table" aria-label="Staged dataset changes">
                <thead>
                  <tr>
                    <th style="width: 110px;">Column</th>
                    <th style="width: 110px;">Category</th>
                    <th>Proposed Transformation &amp; Diff</th>
                    <th style="width: 140px;">Impact</th>
                    <th style="width: 40px; text-align: center;"></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="s in stagedQuality" :key="issueKey(s.issue)">
                    <td><span class="manifest-col-badge">{{ s.preview.col }}</span></td>
                    <td>
                      <span
                        class="manifest-cat-badge"
                        :class="{
                          'is-scale': s.issue.kind.includes('measure') || s.issue.kind.includes('type'),
                          'is-labels': s.issue.kind.includes('unlabeled'),
                          'is-clean': s.issue.kind.includes('dirty'),
                          'is-sentinel': s.issue.kind.includes('sentinel'),
                          'is-outlier': s.issue.kind.includes('outlier'),
                          'is-structural': s.issue.kind.includes('id') || s.issue.kind.includes('constant') || s.issue.kind.includes('empty') || s.issue.kind.includes('duplicate')
                        }"
                      >
                        {{ s.preview.kind }}
                      </span>
                    </td>
                    <td>
                      <div class="manifest-op-desc">
                        <strong>{{ s.preview.title }}</strong>
                        <span>{{ s.preview.beforeLabel }}: {{ s.preview.beforeValue }} &rarr; {{ s.preview.afterLabel }}: {{ s.preview.afterValue }}</span>
                      </div>
                    </td>
                    <td><span class="dha-impact">{{ fixLineFor(s.issue) }}</span></td>
                    <td style="text-align: center;">
                      <button
                        class="btn-unstage-row"
                        type="button"
                        title="Remove from apply list"
                        aria-label="Remove change"
                        @click="removeStaged(issueKey(s.issue))"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </td>
                  </tr>

                  <tr v-for="s in stagedImputes" :key="s.name">
                    <td><span class="manifest-col-badge">{{ s.name }}</span></td>
                    <td><span class="manifest-cat-badge is-impute">Imputation</span></td>
                    <td>
                      <div class="manifest-op-desc">
                        <strong>Impute Missing Cells ({{ strategyLabel(s.method) }})</strong>
                        <span>Fill {{ s.missingN }} cells &middot; {{ s.preview }}</span>
                      </div>
                    </td>
                    <td><span class="dha-impact">+{{ s.missingN }} complete cells</span></td>
                    <td style="text-align: center;">
                      <button
                        class="btn-unstage-row"
                        type="button"
                        title="Remove from apply list"
                        aria-label="Remove change"
                        @click="removeStagedImpute(s.name)"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>

          <!-- Status notice when changes were applied -->
          <div v-if="fixStatus" class="dha-fix-status" role="status">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            <span>{{ fixStatus }}</span>
          </div>

          <!-- Session Applied Modifications & Audit Trail -->
          <template v-if="activityLog.length">
            <div class="dha-section-header-row" :style="stagedQuality.length || stagedImputes.length ? { marginTop: '20px' } : undefined">
              <div>
                <h4 class="dha-section-title">Applied Changes ({{ activeActionsCount }})</h4>
                <p class="dha-subhead-note">Audit trail for this session. Reverse any action individually.</p>
              </div>
            </div>

            <!-- Impact Scorecard (Informative, Concise, No Health Score) -->
            <div class="dha-impact-grid">
              <div class="dha-impact-card">
                <div class="dha-impact-head">
                  <span class="dha-impact-label">Usable Cases</span>
                  <span class="dha-impact-pill is-good">
                    {{ Math.round((readiness.completeRows / (readiness.rows || 1)) * 100) }}% complete
                  </span>
                </div>
                <div class="dha-impact-metric-row">
                  <span class="dha-impact-metric">{{ readiness.completeRows }} / {{ readiness.rows }}</span>
                  <span v-if="completeRowsGained > 0" class="dha-impact-gain">+{{ completeRowsGained }} restored</span>
                </div>
                <span class="dha-impact-sub">Cases with complete observations across all variables</span>
              </div>

              <div class="dha-impact-card">
                <div class="dha-impact-head">
                  <span class="dha-impact-label">Modifications</span>
                  <span class="dha-impact-pill is-info">
                    {{ colsTouched }} column{{ colsTouched === 1 ? '' : 's' }}
                  </span>
                </div>
                <div class="dha-impact-metric-row">
                  <span class="dha-impact-metric">{{ activeActionsCount }} change{{ activeActionsCount === 1 ? '' : 's' }} applied</span>
                </div>
                <span class="dha-impact-sub">{{ rowsTouched.toLocaleString() }} cells updated</span>
              </div>
            </div>

            <!-- Activity Log Card List -->
            <div class="dha-audit-list" role="list" aria-label="Applied actions audit log">
              <div
                v-for="e in activityLog.slice().reverse()"
                :key="e.id"
                class="dha-audit-item"
                :class="{ 'is-undone': e.undone }"
                role="listitem"
              >
                <div class="dha-audit-main">
                  <div class="dha-audit-head-row">
                    <span class="manifest-cat-badge" :class="logCategoryBadge(e).class">
                      {{ logCategoryBadge(e).label }}
                    </span>
                    <strong class="dha-audit-title">{{ e.title }}</strong>
                    <span v-if="e.col" class="manifest-col-badge">{{ e.col }}</span>
                  </div>
                  <div class="dha-audit-detail">{{ e.detail }}</div>
                </div>
                <div class="dha-audit-action">
                  <button
                    v-if="!e.undone"
                    class="btn btn-xs btn-subtle dha-undo-action-btn"
                    type="button"
                    :aria-disabled="e.kind !== 'dismiss' && e.id !== newestUndoableId"
                    :title="e.kind !== 'dismiss' && e.id !== newestUndoableId ? 'Undo newer changes first' : (e.kind === 'dismiss' ? 'Bring this finding back' : 'Reverse this change')"
                    @click="undoEntry(e)"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                      <path d="M9 14L4 9l5-5"/>
                      <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/>
                    </svg>
                    <span>{{ e.kind === 'dismiss' ? 'Restore' : 'Undo' }}</span>
                  </button>
                  <span v-else class="dha-undone-pill">Reversed</span>
                </div>
              </div>
            </div>
          </template>

          <!-- Empty State (No staged changes and no past activity) -->
          <div v-else-if="!stagedQuality.length && !stagedImputes.length" class="advisor-empty-state">
            <h4>No changes currently staged</h4>
            <p>Go to the Review step and select "Stage Fix" on any column issue to queue updates here.</p>
            <button type="button" class="btn btn-subtle" @click="step = 2">Go to Review &rarr;</button>
          </div>
        </section>
      </div>

      <div class="modal-footer dha-footer-simple">
        <div class="modal-footer-left">
          <button v-if="step > 1" class="btn btn-subtle" type="button" @click="goStep(step - 1)">
            &larr; Back
          </button>
          <button
            v-if="step === 3 && (stagedQuality.length || stagedImputes.length)"
            type="button"
            class="btn-stage-clear"
            @click="clearAllStaged"
          >
            Clear Staged
          </button>
        </div>

        <!-- Center Stepper Strip (Clean & Polished Segmented Control) -->
        <nav class="dha-footer-stepper" aria-label="Workflow progress" aria-live="polite" @keydown="stepKeyNav">
          <template v-for="(s, idx) in STEPS" :key="s.n">
            <div v-if="idx > 0" class="dha-step-separator" aria-hidden="true">
              <svg class="dha-step-sep-icon" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </div>
            <button
              type="button"
              class="dha-footer-step-btn"
              :class="{ 'is-done': step > s.n, 'is-current': step === s.n }"
              :tabindex="step === s.n ? 0 : -1"
              :aria-current="step === s.n ? 'step' : undefined"
              :aria-label="`${s.label}. ${s.hint}`"
              :title="`${s.label} — ${s.hint}`"
              @click="goStep(s.n)"
            >
              <svg v-if="step > s.n" class="dha-step-check" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span class="dha-footer-step-label">{{ s.label }}</span>
              <span v-if="s.n === 2 && stagedCount > 0" class="dha-footer-step-badge">{{ stagedCount }}</span>
              <span v-else-if="s.n === 3 && activeActionsCount > 0" class="dha-footer-step-badge is-applied">{{ activeActionsCount }}</span>
            </button>
          </template>
        </nav>

        <div class="modal-footer-right">
          <button v-if="step === 1" class="btn btn-primary" type="button" @click="goStep(2)">
            {{ visibleIssues.length || advisoryItems.length ? 'Stage fixes →' : 'Review details →' }}
          </button>
          <button v-else-if="step === 2" class="btn btn-primary" type="button" @click="goStep(3)">
            {{ stagedCount > 0 ? `Apply staged (${stagedCount}) →` : 'Proceed to Apply →' }}
          </button>
          <button
            v-else-if="stagedQuality.length || stagedImputes.length"
            class="btn btn-primary"
            type="button"
            @click="applyAllStaged"
          >
            Commit &amp; Apply All ({{ stagedCount }})
          </button>
          <button v-else class="btn btn-primary" type="button" @click="close">
            Done
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* App icon in dialog header - seamlessly blended with modal header */
.dha-title-icon-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  margin-right: 2px;
}

.dha-app-icon {
  width: 24px;
  height: 24px;
  object-fit: contain;
  display: block;
  filter: drop-shadow(0 2px 8px rgba(35, 103, 236, 0.45));
  transition: transform 0.2s ease, filter 0.2s ease;
}

.dha-title-icon-wrap:hover .dha-app-icon {
  transform: scale(1.08);
  filter: drop-shadow(0 3px 12px rgba(35, 103, 236, 0.65));
}

/* Expandable Impact Details inside Cards */
.dha-expand-toggle-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--surface-subtle);
  border: 1px solid var(--line);
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 5px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.dha-expand-toggle-btn:hover {
  background: var(--surface-hover);
  color: var(--text);
  border-color: var(--line-strong);
}

.dha-expand-toggle-btn svg {
  transition: transform 0.2s ease;
}

.dha-expand-toggle-btn svg.is-rotated {
  transform: rotate(180deg);
}

.dha-finding-impact-list {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 220px;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
  min-width: 0;
}

.dha-impact-item {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 5px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--surface-subtle);
  border: 1px solid var(--line-subtle);
  font-size: 11px;
  min-width: 0;
  box-sizing: border-box;
}

.dha-impact-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.dha-impact-col-name {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
  color: var(--text);
}

.dha-impact-kind-tag {
  font-size: 9.5px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(245, 158, 11, 0.12);
  color: var(--warn);
  white-space: nowrap;
}

.dha-impact-measure-tag {
  font-size: 9.5px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--accent-soft);
  color: var(--accent);
  text-transform: capitalize;
  white-space: nowrap;
}

.dha-impact-body {
  display: block;
  font-size: 11px;
  line-height: 1.45;
  color: var(--muted);
  word-break: break-word;
  overflow-wrap: break-word;
  white-space: normal;
  min-width: 0;
}

.dha-impact-msg {
  color: var(--text-secondary);
  white-space: normal;
  word-break: break-word;
  overflow-wrap: break-word;
}

.dha-impact-evid {
  color: var(--muted);
  white-space: normal;
  word-break: break-word;
  overflow-wrap: break-word;
}

/* Polished & Simpler Workflow Footer */
.dha-footer-simple {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
}

.dha-footer-stepper {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  background: var(--surface-subtle);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 2px 3px;
  user-select: none;
  flex-shrink: 0;
}

.dha-step-separator {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--faint);
  opacity: 0.5;
  user-select: none;
  pointer-events: none;
  padding: 0;
  margin: 0 1px;
}

.dha-step-sep-icon {
  display: block;
}

.dha-footer-step-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  background: transparent;
  border: 1px solid transparent;
  padding: 3px 9px;
  border-radius: 4px;
  cursor: pointer;
  color: var(--muted);
  font-family: inherit;
  font-size: 11.5px;
  font-weight: 500;
  line-height: 1.2;
  transition: all 0.15s ease;
}

.dha-footer-step-btn:hover {
  color: var(--text);
  background: var(--surface-hover);
}

.dha-footer-step-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.dha-footer-step-btn.is-current {
  background: var(--surface);
  border-color: var(--line-strong);
  color: var(--text);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}

.dha-footer-step-btn.is-done {
  color: var(--text-secondary);
}

.dha-step-check {
  color: var(--ok, #10b981);
  flex-shrink: 0;
  display: block;
}

.dha-footer-step-label {
  display: inline-block;
  line-height: 1.2;
}

.dha-footer-step-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 9.5px;
  font-weight: 700;
  line-height: 1;
}

.dha-footer-step-badge.is-applied {
  background: rgba(16, 185, 129, 0.15);
  color: var(--ok, #10b981);
}

.btn-check-icon {
  margin-right: 3px;
  vertical-align: middle;
}

.modal-body {
  overflow-x: hidden;
  scrollbar-width: thin;
  scrollbar-color: var(--line-strong) transparent;
}
.modal-body::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
.modal-body::-webkit-scrollbar-track {
  background: transparent;
}
.modal-body::-webkit-scrollbar-thumb {
  background: var(--line-strong);
  border-radius: 999px;
}
.modal-body::-webkit-scrollbar-thumb:hover {
  background: var(--muted);
}

/* Polished Card Summary & Diagnostic Text */
.dha-card-summary {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 2px;
}

.dha-diag-text,
.dha-action-text {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-secondary);
  line-height: 1.45;
}

.dha-meta-label {
  font-weight: 700;
  color: var(--text);
  margin-right: 4px;
}

/* Redesigned & Polished Statistical Rationale */
.dha-rationale-box {
  margin-top: 6px;
  border-radius: var(--radius-sm, 6px);
  border: 1px solid var(--line-subtle);
  background: var(--surface-subtle);
  overflow: hidden;
  transition: all 0.15s ease;
}

.dha-rationale-box[open] {
  border-color: rgba(74, 158, 255, 0.28);
  background: rgba(35, 103, 236, 0.04);
}

.dha-rationale-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 9px;
  cursor: pointer;
  user-select: none;
  list-style: none;
  transition: background 0.15s ease, color 0.15s ease;
}

.dha-rationale-trigger::-webkit-details-marker,
.dha-rationale-trigger::marker {
  display: none;
}

.dha-rationale-trigger:hover {
  background: var(--surface-hover);
}

.dha-rationale-trigger-content {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
}

.dha-rationale-icon {
  color: var(--accent);
  flex-shrink: 0;
}

.dha-rationale-chevron {
  color: var(--faint);
  flex-shrink: 0;
  transition: transform 0.2s cubic-bezier(0.2, 0, 0, 1);
}

.dha-rationale-box[open] .dha-rationale-chevron {
  transform: rotate(180deg);
}

.dha-rationale-body {
  padding: 6px 10px 9px 27px;
  font-size: 11px;
  color: var(--muted);
  line-height: 1.45;
  border-top: 1px solid rgba(74, 158, 255, 0.12);
}
</style>
