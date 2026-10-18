<script setup lang="ts">
// One SPSS measurement-scale badge for every place a variable is shown: DataGrid
// headers, VariableView rows, AnalysisDialog source rows and assigned tokens.
// Colors come from the --badge-* tokens (design.md §1) so light/dark stay in step.
import type { Measure } from './io/types.ts'

withDefaults(defineProps<{ measure: Measure; size?: number; showTitle?: boolean }>(), {
  size: 11,
  showTitle: true,
})
</script>

<template>
  <span
    class="var-measure-icon"
    :class="measure"
    :title="showTitle ? measure : undefined"
    aria-hidden="true"
  >
    <!-- Nominal: category list -->
    <svg v-if="measure === 'nominal'" :width="size" :height="size" viewBox="0 0 16 16" fill="currentColor">
      <path d="M2 3.5h12M2 8h12M2 12.5h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
    </svg>
    <!-- Ordinal: ascending bars -->
    <svg v-else-if="measure === 'ordinal'" :width="size" :height="size" viewBox="0 0 16 16" fill="currentColor">
      <path d="M2 13h3V9H2v4zm4 0h3V6H6v7zm4 0h3V2h-3v11z" />
    </svg>
    <!-- Scale / Ratio: ruler -->
    <svg v-else :width="size" :height="size" viewBox="0 0 16 16" fill="currentColor">
      <path d="M6 2v12M10 2v12M3 6h10M3 10h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
    </svg>
  </span>
</template>

<style scoped>
.var-measure-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  flex-shrink: 0;
}

.var-measure-icon.ratio,
.var-measure-icon.scale {
  color: var(--badge-scale-text);
  background: var(--badge-scale-bg);
}

.var-measure-icon.nominal {
  color: var(--badge-nominal-text);
  background: var(--badge-nominal-bg);
}

.var-measure-icon.ordinal {
  color: var(--badge-ordinal-text);
  background: var(--badge-ordinal-bg);
}
</style>
