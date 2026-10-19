<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { state } from './store.ts'
import {
  suitableTests, ADVISOR_TITLES, findSensibleDefaultTestVars,
  generateDatasetEdaHypotheses, type EdaHypothesis, type SuitableTestsResult
} from './advisor.ts'

const props = defineProps<{
  modelValue: boolean
  initialVars?: string[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', val: boolean): void
  (e: 'open-analysis', testId: string, options?: Record<string, unknown>): void
}>()

const modalCard = ref<HTMLElement | null>(null)
const selectedTestVars = ref<string[]>([])

const edaHypotheses = computed<EdaHypothesis[]>(() => {
  return generateDatasetEdaHypotheses(state.ds.columns)
})

const suitableResult = computed<SuitableTestsResult>(() => {
  const cols = state.ds.columns.filter((c) => selectedTestVars.value.includes(c.name))
  return suitableTests(cols)
})

const patternTitle = computed(() => {
  const pat = suitableResult.value.pattern
  if (pat === 'unknown') return 'CUSTOM SELECTION'
  return (ADVISOR_TITLES[pat] ?? pat).toUpperCase()
})

function toggleTestVar(colName: string): void {
  const idx = selectedTestVars.value.indexOf(colName)
  if (idx >= 0) {
    if (selectedTestVars.value.length > 1) selectedTestVars.value.splice(idx, 1)
  } else {
    if (selectedTestVars.value.length >= 3) selectedTestVars.value.shift()
    selectedTestVars.value.push(colName)
  }
}

function runEdaHypothesis(h: EdaHypothesis): void {
  emit('open-analysis', h.testId, h.options)
  close()
}

function runRecommendedTest(testId: string): void {
  const res = suitableResult.value
  const options: Record<string, unknown> = {}
  if (res.values.length === 1) {
    options['dep'] = res.values[0]
    options['variable'] = res.values[0]
  } else if (res.values.length === 2 && !res.group) {
    options['a'] = res.values[0]
    options['b'] = res.values[1]
    options['row'] = res.values[0]
    options['col'] = res.values[1]
    options['variables'] = [...res.values]
  } else if (res.values.length >= 3) {
    options['vars'] = [...res.values]
    options['variables'] = [...res.values]
    options['dep'] = res.values[0]
    options['predictors'] = res.values.slice(1)
  }
  if (res.group) {
    options['factor'] = res.group
    options['group'] = res.group
  }
  emit('open-analysis', testId, options)
  close()
}

function close(): void {
  emit('update:modelValue', false)
}

function handleKeyDown(ev: KeyboardEvent): void {
  if (!props.modelValue) return
  if (ev.key === 'Escape') {
    close()
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      if (props.initialVars && props.initialVars.length) {
        selectedTestVars.value = [...props.initialVars]
      } else {
        selectedTestVars.value = findSensibleDefaultTestVars(state.ds.columns)
      }
    }
  }
)

onMounted(() => {
  window.addEventListener('keydown', handleKeyDown)
})
onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown)
})
</script>

<template>
  <div v-if="modelValue" class="modal-backdrop" @click.self="close">
    <div
      ref="modalCard"
      class="modal-card test-advisor-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="test-advisor-title"
      tabindex="-1"
    >
      <div class="modal-header">
        <div class="modal-title-wrap">
          <div class="test-advisor-icon">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0c.7 4.5 3.5 7.3 8 8-4.5.7-7.3 3.5-8 8-.7-4.5-3.5-7.3-8-8 4.5-.7 7.3-3.5 8-8z" />
            </svg>
          </div>
          <div>
            <h3 id="test-advisor-title">Statistical Test Advisor</h3>
            <p class="modal-subtitle">Evaluate data properties, test assumptions, and match suitable inferential procedures.</p>
          </div>
        </div>
        <button class="icon-close-btn" title="Close (Esc)" aria-label="Close" @click="close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div class="modal-body test-advisor-body">
        <!-- Section 1: Quick EDA Starters -->
        <div v-if="edaHypotheses.length" class="eda-hypotheses-block">
          <div class="eda-hypotheses-header">
            <div class="eda-title-row">
              <span class="dha-badge is-local">Quick EDA Starters</span>
              <strong class="eda-block-heading">Recommended Research Hypotheses</strong>
            </div>
            <span class="eda-hypotheses-sub">Pre-configured test pairings inferred from your dataset measurement scales:</span>
          </div>
          <div class="eda-hypotheses-grid">
            <div
              v-for="h in edaHypotheses"
              :key="h.title"
              class="eda-hypothesis-card"
              tabindex="0"
              role="button"
              :aria-label="`Run ${h.title}: ${h.subtitle}`"
              @click="runEdaHypothesis(h)"
              @keydown.enter="runEdaHypothesis(h)"
              @keydown.space.prevent="runEdaHypothesis(h)"
            >
              <div class="eda-h-top">
                <span class="eda-h-badge">{{ h.badge }}</span>
                <span class="eda-h-arrow">Configure &amp; Run &rarr;</span>
              </div>
              <strong class="eda-h-title">{{ h.title }}</strong>
              <p class="eda-h-sub">{{ h.subtitle }}</p>
            </div>
          </div>
        </div>

        <!-- Section 2: Custom Variable Selection -->
        <div class="custom-test-block">
          <div class="section-title-wrap">
            <strong class="section-heading">Custom Analysis by Variable Selection</strong>
            <p class="section-desc">Pick 1 to 3 variables below to evaluate compatible statistical tests and assumption pre-checks.</p>
          </div>

          <div class="tests-var-chips dha-var-chips">
            <button
              v-for="col in state.ds.columns"
              :key="col.name"
              class="var-toggle-chip"
              :class="{ 'is-selected': selectedTestVars.includes(col.name) }"
              type="button"
              @click="toggleTestVar(col.name)"
            >
              <span class="var-chip-name">{{ col.name }}</span>
              <span class="var-chip-measure">{{ col.measure }}</span>
            </button>
          </div>

          <div class="tests-pattern-hero">
            <div class="pattern-header">
              <span class="pattern-label">Design Pattern:</span>
              <span class="pattern-badge">{{ patternTitle }}</span>
            </div>
            <div class="pattern-note">{{ suitableResult.note }}</div>
          </div>

          <div class="suitable-tests-list">
            <div v-for="test in suitableResult.tests" :key="test.id" class="test-card">
              <div class="test-card-content">
                <div class="test-card-head">
                  <h4 class="test-card-title">{{ test.title }}</h4>
                  <span class="test-card-category">{{ test.id }}</span>
                </div>
                <p class="test-card-desc">{{ test.description || 'Standard procedure for this column structure.' }}</p>
              </div>
              <button class="btn btn-primary btn-sm test-run-btn" type="button" @click="runRecommendedTest(test.id)">
                Configure &amp; Run &rarr;
              </button>
            </div>
            <div v-if="!suitableResult.tests.length" class="tests-empty-hint">
              Select 1 or more variables above to evaluate suitable tests.
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.test-advisor-modal {
  width: min(880px, 94vw);
  max-width: min(880px, 94vw);
  height: clamp(520px, 82vh, 760px);
  max-height: 92vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

@media (max-height: 640px) {
  .test-advisor-modal {
    height: 94vh;
    max-height: 94vh;
  }
}

.test-advisor-icon {
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: linear-gradient(135deg, #3b82f6 0%, #6366f1 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 6px rgba(59, 130, 246, 0.35);
  color: #ffffff;
  flex-shrink: 0;
}

.test-advisor-icon svg {
  width: 14px;
  height: 14px;
  color: #ffffff;
}

.test-advisor-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.eda-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.eda-block-heading {
  font-size: 13px;
  font-weight: 700;
  color: var(--ink);
}

.custom-test-block {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}

.section-title-wrap {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.section-heading {
  font-size: 13px;
  font-weight: 700;
  color: var(--ink);
}

.section-desc {
  margin: 0;
  font-size: 11px;
  color: var(--faint);
}
</style>
