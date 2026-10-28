<script setup lang="ts">
// Results pane (§8): renders the result tree per run - APA tables, notes, error
// elements with Fix options. Chart honesty: <img> only when an element carries a
// loadable src (the CSP blocks data:/blob: images), otherwise a plain note.
// Connected AI: exposes "Explain with ARA Assistant" button to trigger narrative interpretations.
import { computed, ref, onMounted, onUnmounted } from "vue";
import {
  runsState,
  loadingState,
  displayTable,
  type Run,
  type ResultElement,
  type ResultTable,
  type ResultChart,
} from "./results.ts";
import {
  fmtCell,
  fmtP,
  isPColumn,
  isSig,
  decimalPlaces,
  extractApaSummary,
  parseAssumptionPills,
  type ApaSummary,
  type AssumptionPill,
} from "./format.ts";
import { specSummary, schemaById } from "./specs.ts";
import { robustFallback, fallbackForViolation } from "./advisor.ts";
import type { VizSpec } from "./vizCharts.ts";
import { state } from "./store.ts";

function isStale(run: Run): boolean {
  return (
    run.analysisId !== "pinned_chart" &&
    run.analysisId !== "visualize" &&
    run.datasetRev !== undefined &&
    run.datasetRev !== state.rev
  );
}

function jumpToRun(runId: string): void {
  document
    .getElementById("run-card-" + runId)
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
}

const emit = defineEmits<{
  (e: "export-html"): void;
  (e: "copy-text"): void;
  (e: "copy-run", run: Run): void;
  (e: "copy-apa", run: Run): void;
  (e: "copy-summary", run: Run): void;
  (e: "copy-table", run: Run, table: ResultTable): void;
  (e: "fix-options", run: Run): void;
  (e: "rerun", run: Run): void;
  (e: "explain-run", run: Run): void;
  (e: "open-analysis", analysisId: string, options?: Record<string, unknown>): void;
  (e: "open-viz", run: Run): void;
  (e: "export-chart", run: Run, chart: ResultChart): void;
  (
    e: "quick-start",
    kind: "descriptives" | "advisor" | "visualize"
  ): void;
  (e: "close"): void;
  (e: "close-run", run: Run): void;
  (e: "clear-all"): void;
}>();

const visibleRuns = computed(() =>
  runsState.runs.filter((r) => r.revealed).reverse(),
);

// Per-run minimize: collapsed bodies keep their head row with copy/close.
const minimized = ref(new Set<string>());
function isMinimized(run: Run): boolean {
  return minimized.value.has(run.runId);
}
function toggleMinimize(run: Run): void {
  const next = new Set(minimized.value);
  if (next.has(run.runId)) next.delete(run.runId);
  else next.add(run.runId);
  minimized.value = next;
}

// "Copied!" flash: the parent owns the clipboard write, so it calls back into
// markApaCopied (exposed below) to arm the 1.5s checkmark on this button.
const copiedFlags = ref<Record<string, boolean>>({});
function flashKey(runId: string, kind: string): string {
  return `${runId}:${kind}`;
}
function isCopied(runId: string, kind: string): boolean {
  return copiedFlags.value[flashKey(runId, kind)] === true;
}
function markCopied(runId: string, kind: string): void {
  copiedFlags.value = { ...copiedFlags.value, [flashKey(runId, kind)]: true };
  window.setTimeout(() => {
    const next = { ...copiedFlags.value };
    delete next[flashKey(runId, kind)];
    copiedFlags.value = next;
  }, 1500);
}
function isApaCopied(run: Run): boolean {
  return isCopied(run.runId, "apa");
}
function markApaCopied(run: Run): void {
  markCopied(run.runId, "apa");
}
function markSummaryCopied(run: Run): void {
  markCopied(run.runId, "summary");
}
function markRunCopied(run: Run): void {
  markCopied(run.runId, "copy");
}
defineExpose({ markApaCopied, markSummaryCopied, markRunCopied });

// Track runs where explanation was requested to hide the button
const explainedRuns = ref(new Set<string>());
function isExplained(run: Run): boolean {
  return (
    explainedRuns.value.has(run.runId) ||
    run.elements.some(
      (el) => el.kind === "note" && el.address?.startsWith("note:narrative"),
    )
  );
}
function onExplain(run: Run): void {
  const next = new Set(explainedRuns.value);
  next.add(run.runId);
  explainedRuns.value = next;
  emit("explain-run", run);
}

function desc(run: Run): string {
  // A pinned chart (Visualize → Pin to Results) has no missing policy, so it
  // describes its chart request rather than claiming "missing handling".
  if (!run.missingPolicy) {
    if (run.analysisId === "visualize") {
      const spec = run.spec as Partial<VizSpec>;
      const bits = [`chart type: ${spec.type ?? "chart"}`];
      if (spec.x) bits.push(`X: ${spec.x}`);
      if (spec.y) bits.push(`Y: ${spec.y}`);
      if (spec.group) bits.push(`group: ${spec.group}`);
      if (spec.trendline) bits.push("OLS trendline");
      return bits.join(" · ");
    }
    return specSummary(run.spec) || "Pinned from the Visualize dialog.";
  }
  return `${specSummary(run.spec)} (${run.missingPolicy} missing handling).`;
}

function starred(el: ResultElement): boolean {
  return (
    el.kind === "table" &&
    el.columns.some((c, i) => isPColumn(c) && el.rows.some((r) => isSig(r[i])))
  );
}

function isScalarTable(el: ResultElement): boolean {
  return (
    el.kind === "table" &&
    el.rows.length === 1 &&
    el.columns.length > 0 &&
    el.columns.length <= 8
  );
}

function scalarEntries(
  el: ResultElement,
): Array<{ label: string; value: unknown }> {
  if (el.kind !== "table" || !el.rows[0]) return [];
  return el.columns.map((label, i) => ({
    label: label || `Value ${i + 1}`,
    value: el.rows[0][i],
  }));
}

// APA house style: one "Note." line per table (copy block "Note. ... * p < .05.").
// Engine footnotes carry their own "Note." prefix; strip it so the line gets exactly one.
function noteTail(el: ResultElement): string {
  const parts =
    el.kind === "table"
      ? el.footnotes.map((f) => f.replace(/^Note\.\s*/, ""))
      : [];
  if (starred(el)) parts.push("* p < .05.");
  return parts.join(" ");
}

// --- Executive verdict, assumption pills, chart actions ---------------------

/** The one-line APA citation for a run (null when it reports no statistic). */
function verdict(run: Run): ApaSummary | null {
  return extractApaSummary(run);
}

/** The assumption checks the engine reported, as status pills. */
function pills(run: Run): AssumptionPill[] {
  return parseAssumptionPills(run);
}

interface FallbackAction {
  analysisId: string;
  options: Record<string, unknown>;
  label: string;
}

/**
 * The 1-click robust counterpart for a violated assumption (null when the
 * run has no violated assumption or the procedure has no counterpart).
 */
function fallback(run: Run): FallbackAction | null {
  const violated = pills(run)
    .filter((p) => p.violated)
    .map((p) => p.label);
  const target = fallbackForViolation(run.analysisId, violated);
  if (!target) return null;
  const fb = robustFallback(run.analysisId, run.spec, target);
  if (!fb) return null;
  return {
    analysisId: fb.analysisId,
    options: fb.options,
    label: schemaById(fb.analysisId)?.title ?? fb.analysisId,
  };
}

/** The elements as rendered (value labels applied) so copies match the pane. */
function displayed(run: Run): ResultElement[] {
  return run.elements.map((e) =>
    e.kind === "table" ? displayTable(e, run) : e,
  );
}

/** The raw table behind a copy button (the exporter applies the labels once). */
function tableOf(run: Run, address: string): ResultTable | null {
  const el = run.elements.find((e) => e.address === address);
  return el && el.kind === "table" ? el : null;
}

const PRECISIONS = [2, 3, 4] as const;

const decimalMenuOpen = ref(false);
const activeChartSizeMenu = ref<string | null>(null);

function selectDecimal(d: 2 | 3 | 4): void {
  decimalPlaces.value = d;
  decimalMenuOpen.value = false;
}

const CHART_SIZES = [
  { id: "fit", label: "Fit Width", hint: "Auto (100%)" },
  { id: "sm", label: "Small", hint: "380px" },
  { id: "md", label: "Medium", hint: "560px" },
  { id: "lg", label: "Large", hint: "750px" },
  { id: "full", label: "Original", hint: "Native size" },
] as const;
type ChartSize = (typeof CHART_SIZES)[number]["id"];

const chartSizes = ref<Record<string, ChartSize>>({});

function chartSize(runId: string): ChartSize {
  return chartSizes.value[runId] ?? "fit";
}

function chartSizeLabel(runId: string): string {
  const size = chartSize(runId);
  const found = CHART_SIZES.find((s) => s.id === size);
  return found?.label ?? "Fit Width";
}

function setChartSize(runId: string, size: ChartSize): void {
  chartSizes.value = { ...chartSizes.value, [runId]: size };
  activeChartSizeMenu.value = null;
}

function cycleChartSize(runId: string): void {
  const current = chartSize(runId);
  const idx = CHART_SIZES.findIndex((s) => s.id === current);
  const nextIdx = (idx + 1) % CHART_SIZES.length;
  setChartSize(runId, CHART_SIZES[nextIdx]!.id);
}

function toggleChartSizeMenu(runId: string): void {
  if (activeChartSizeMenu.value === runId) {
    activeChartSizeMenu.value = null;
  } else {
    activeChartSizeMenu.value = runId;
  }
}

function chartElOf(run: Run): ResultChart | null {
  const el = run.elements.find((e): e is ResultChart => e.kind === "chart");
  return el ?? null;
}

function prepareSvg(rawSvg: string): string {
  if (!rawSvg) return "";
  let svg = rawSvg;
  if (!svg.includes("viewBox")) {
    const wMatch = svg.match(/width=["'](\d+(?:\.\d+)?)["']/);
    const hMatch = svg.match(/height=["'](\d+(?:\.\d+)?)["']/);
    if (wMatch && hMatch) {
      const w = wMatch[1];
      const h = hMatch[1];
      svg = svg.replace(
        /<svg\b/,
        `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet"`,
      );
    }
  }
  return svg;
}

function handleGlobalClick(ev: MouseEvent): void {
  const target = ev.target as HTMLElement | null;
  if (!target) return;
  if (decimalMenuOpen.value && !target.closest(".gear-menu-wrap")) {
    decimalMenuOpen.value = false;
  }
  if (
    activeChartSizeMenu.value &&
    !target.closest(".chart-size-picker")
  ) {
    activeChartSizeMenu.value = null;
  }
}

function handleGlobalKey(ev: KeyboardEvent): void {
  if (ev.key === "Escape") {
    decimalMenuOpen.value = false;
    activeChartSizeMenu.value = null;
  }
}

onMounted(() => {
  window.addEventListener("click", handleGlobalClick);
  window.addEventListener("keydown", handleGlobalKey);
});

onUnmounted(() => {
  window.removeEventListener("click", handleGlobalClick);
  window.removeEventListener("keydown", handleGlobalKey);
});
</script>

<template>
  <section class="pane-results" aria-label="Results">
    <div class="pane-header">
      <h2>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
        <span>Result</span>
      </h2>
      <div class="spacer"></div>
      <div class="gear-menu-wrap">
        <button
          class="chip-btn icon-only"
          :class="{ 'is-active': decimalMenuOpen }"
          type="button"
          title="Decimal places & precision settings"
          aria-label="Decimal places & precision settings"
          @click.stop="decimalMenuOpen = !decimalMenuOpen"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <circle cx="12" cy="12" r="3" />
            <path
              d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
            />
          </svg>
        </button>
        <div v-if="decimalMenuOpen" class="decimal-dropdown-menu" role="menu">
          <div class="decimal-dropdown-header">Decimal Places</div>
          <button
            v-for="d in PRECISIONS"
            :key="d"
            type="button"
            class="decimal-dropdown-item"
            :class="{ 'is-selected': decimalPlaces === d }"
            role="menuitemradio"
            :aria-checked="decimalPlaces === d"
            @click.stop="selectDecimal(d)"
          >
            <span class="decimal-item-label">{{ d }} decimals ({{ d === 2 ? '.00' : d === 3 ? '.000' : '.0000' }})</span>
            <svg
              v-if="decimalPlaces === d"
              class="decimal-check"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </button>
        </div>
      </div>
      <button
        class="chip-btn icon-only"
        type="button"
        title="Copy as text"
        aria-label="Copy as text"
        @click="$emit('copy-text')"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
      </button>
      <button
        class="chip-btn icon-only"
        type="button"
        title="Export HTML"
        aria-label="Export HTML"
        @click="$emit('export-html')"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <path d="M14 2H6a2 2 0 002 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      </button>
      <button
        class="chip-btn icon-only"
        type="button"
        title="Collapse Result View"
        aria-label="Collapse Result View"
        @click="$emit('close')"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.2"
          stroke-linecap="round"
        >
          <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
          <path d="M10.5 2.5v11" />
          <path
            d="M3.5 8h4.4M6.2 5.9 8.3 8l-2.1 2.1"
            stroke-width="1.3"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </div>
    <div v-if="visibleRuns.length >= 2" class="results-toc">
      <button
        v-for="(run, i) in visibleRuns"
        :key="run.runId"
        type="button"
        class="toc-chip"
        @click="jumpToRun(run.runId)"
      >
        #{{ visibleRuns.length - i }} {{ run.title }}
      </button>
      <span class="spacer"></span>
      <button type="button" class="toc-clear" @click="$emit('clear-all')">
        Clear All
      </button>
    </div>
    <div v-if="loadingState.active" class="loading-line active" role="status">
      <div class="spinner" aria-hidden="true"></div>
      <span
        ><span>{{ loadingState.text }}</span
        ><span class="dots" aria-hidden="true"
          ><span>.</span><span>.</span><span>.</span></span
        ></span
      >
    </div>
    <div class="results-scroll">
      <div
        v-if="!visibleRuns.length && !loadingState.active"
        class="results-empty-state"
      >
        <div class="results-empty-icon" aria-hidden="true">
          <svg
            width="36"
            height="36"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          >
            <path
              d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
            />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10 9 9 9 8 9" />
          </svg>
        </div>
        <h4 class="results-empty-title">No Statistical Results Yet</h4>
        <p class="results-empty-desc">
          Choose a procedure from the <strong>Analyze</strong> menu or ask
          <strong>ARA Assistant</strong> to generate tables and interpretation narratives.
        </p>
        <div v-if="state.ds.columns.length" class="quick-start-row">
          <button
            type="button"
            class="quick-start-btn"
            @click="$emit('quick-start', 'descriptives')"
          >
            Descriptives
          </button>
          <button
            type="button"
            class="quick-start-btn"
            @click="$emit('quick-start', 'advisor')"
          >
            Test Advisor
          </button>
          <button
            type="button"
            class="quick-start-btn"
            @click="$emit('quick-start', 'visualize')"
          >
            Visualize
          </button>
        </div>
      </div>
      <article
        v-for="run in visibleRuns"
        :key="run.runId"
        :id="'run-card-' + run.runId"
        class="result-block"
        :class="{ fresh: run.fresh, error: run.status === 'error' }"
      >
        <div class="result-head-row">
          <h3 class="result-title">{{ run.title }}</h3>
          <div class="result-head-actions">
            <button
              v-if="
                run.analysisId !== 'pinned_chart' &&
                run.analysisId !== 'visualize'
              "
              class="icon-chip"
              type="button"
              title="Edit analysis options"
              aria-label="Edit analysis options"
              @click.stop="$emit('fix-options', run)"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <line x1="4" y1="21" x2="4" y2="14" />
                <line x1="4" y1="10" x2="4" y2="3" />
                <line x1="12" y1="21" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12" y2="3" />
                <line x1="20" y1="21" x2="20" y2="16" />
                <line x1="20" y1="12" x2="20" y2="3" />
                <line x1="1" y1="14" x2="7" y2="14" />
                <line x1="9" y1="8" x2="15" y2="8" />
                <line x1="17" y1="16" x2="23" y2="16" />
              </svg>
            </button>
            <button
              v-if="isStale(run)"
              class="stale-pill"
              type="button"
              title="Data changed — re-run with current data"
              @click.stop="$emit('rerun', run)"
            >
              ↻ Re-run (data changed)
            </button>
            <button
              v-if="chartElOf(run)"
              class="icon-chip"
              type="button"
              :title="`Chart size: ${chartSizeLabel(run.runId)} (click to cycle)`"
              :aria-label="`Chart size: ${chartSizeLabel(run.runId)}`"
              @click.stop="cycleChartSize(run.runId)"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>
            <button
              v-else
              class="icon-chip"
              type="button"
              :title="isApaCopied(run) ? 'Copied!' : 'Copy APA table'"
              :aria-label="isApaCopied(run) ? 'Copied!' : 'Copy APA table'"
              @click.stop="$emit('copy-apa', run)"
            >
              <svg
                v-if="isApaCopied(run)"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <svg
                v-else
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
              </svg>
            </button>
            <button
              class="icon-chip"
              type="button"
              :title="isMinimized(run) ? 'Expand this result' : 'Minimize this result'"
              :aria-label="
                isMinimized(run) ? 'Expand this result' : 'Minimize this result'
              "
              @click.stop="toggleMinimize(run)"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <button
              class="icon-chip danger"
              type="button"
              title="Close this result"
              aria-label="Close this result"
              @click.stop="$emit('close-run', run)"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
        <template v-if="!isMinimized(run)">
          <p v-if="run.status !== 'error'" class="result-desc">
            {{ desc(run) }}
          </p>

          <!-- Executive verdict: the APA citation and its significance. -->
          <div v-if="verdict(run)" class="verdict-row">
            <span
              class="verdict-badge"
              :class="verdict(run)!.significant ? 'is-sig' : 'is-ns'"
            >
              {{ verdict(run)!.significant ? "Significant" : "Not significant" }}
            </span>
            <code class="verdict-citation">{{ verdict(run)!.text }}</code>
            <button
              class="icon-chip"
              type="button"
              :title="
                isCopied(run.runId, 'summary')
                  ? 'Copied!'
                  : 'Copy APA citation'
              "
              :aria-label="
                isCopied(run.runId, 'summary')
                  ? 'Copied!'
                  : 'Copy APA citation'
              "
              @click.stop="$emit('copy-summary', run)"
            >
              <svg
                v-if="isCopied(run.runId, 'summary')"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <svg
                v-else
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
              </svg>
            </button>
          </div>

          <!-- Assumption pills + 1-click robust counterpart. -->
          <div v-if="pills(run).length" class="assumption-row">
            <span
              v-for="pill in pills(run)"
              :key="pill.label"
              class="assumption-pill"
              :class="pill.violated ? 'is-warn' : 'is-ok'"
            >
              <span class="assumption-mark" aria-hidden="true">
                {{ pill.violated ? "⚠" : "✓" }}
              </span>
              {{ pill.label }}
              <span class="assumption-detail">{{ pill.detail }}</span>
            </span>
            <button
              v-if="fallback(run)"
              class="fallback-chip"
              type="button"
              :title="`Run the robust counterpart: ${fallback(run)!.label}`"
              @click.stop="
                $emit(
                  'open-analysis',
                  fallback(run)!.analysisId,
                  fallback(run)!.options
                )
              "
            >
              Switch to {{ fallback(run)!.label }} &rarr;
            </button>
          </div>

          <template v-for="el in displayed(run)" :key="el.address">
            <div
              v-if="el.kind === 'table' && isScalarTable(el)"
              class="scalar-table"
            >
              <dl
                class="result-stats"
                :aria-label="el.caption"
                :style="el.status === 'stale' ? 'opacity: 0.55' : ''"
              >
                <dt v-for="(entry, i) in scalarEntries(el)" :key="`label-${i}`">
                  {{ entry.label }}
                </dt>
                <dd v-for="(entry, i) in scalarEntries(el)" :key="`value-${i}`">
                  {{
                    isPColumn(entry.label) && typeof entry.value === "number"
                      ? fmtP(entry.value)
                      : fmtCell(entry.value)
                  }}
                </dd>
              </dl>
              <button
                class="table-copy-btn"
                type="button"
                title="Copy this table"
                :aria-label="`Copy table: ${el.caption}`"
                @click.stop="$emit('copy-table', run, tableOf(run, el.address)!)"
              >
                Copy
              </button>
            </div>
            <table
              v-else-if="el.kind === 'table'"
              class="apa"
              :aria-label="el.caption"
              :style="el.status === 'stale' ? 'opacity: 0.55' : ''"
            >
              <caption>
                <span class="table-caption-text">{{ el.caption }}</span>
                <button
                  class="table-copy-btn"
                  type="button"
                  title="Copy this table"
                  :aria-label="`Copy table: ${el.caption}`"
                  @click.stop="$emit('copy-table', run, tableOf(run, el.address)!)"
                >
                  Copy
                </button>
              </caption>
              <thead>
                <tr>
                  <th
                    v-for="(c, i) in el.columns"
                    :key="i"
                    scope="col"
                    :class="i === 0 ? 'l' : ''"
                  >
                    {{ c }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, ri) in el.rows" :key="ri">
                  <template v-for="(v, ci) in row" :key="ci">
                    <th
                      v-if="ci === 0 && typeof v === 'string'"
                      scope="row"
                      class="l"
                    >
                      {{ v }}
                    </th>
                    <td
                      v-else-if="
                        isPColumn(el.columns[ci] ?? '') && typeof v === 'number'
                      "
                      :class="{ sig: isSig(v) }"
                    >
                      {{ fmtP(v) }}{{ isSig(v) ? " *" : "" }}
                    </td>
                    <td v-else>{{ fmtCell(v) }}</td>
                  </template>
                </tr>
              </tbody>
            </table>
            <p v-else-if="el.kind === 'note'" class="notes-line">
              {{ el.text }}
            </p>
            <img
              v-else-if="el.kind === 'chart' && el.src"
              :src="el.src"
              :alt="el.caption"
              style="max-width: 100%; margin: 8px 0"
            />
            <div
              v-else-if="el.kind === 'chart' && el.svg"
              class="chart-container"
              :class="`size-${chartSize(run.runId)}`"
            >
              <div
                class="chart-svg"
                role="img"
                :aria-label="el.caption"
                v-html="prepareSvg(el.svg)"
              ></div>
            </div>
            <p v-else-if="el.kind === 'chart'" class="chart-slot">
              {{ el.caption }}
            </p>
            <div v-else class="err-row" role="alert">
              <span class="err-icon" aria-hidden="true">!</span>
              <div class="err-text">
                <strong>Analysis failed.</strong> {{ el.userMessage }}
                <div style="margin-top: 8px">
                  <button class="btn btn-sm" @click="$emit('fix-options', run)">
                    Fix options
                  </button>
                </div>
              </div>
            </div>
            <p v-if="el.kind === 'table' && noteTail(el)" class="footnote">
              Note. {{ noteTail(el) }}
            </p>
          </template>

          <!-- Connected Result Actions -->
          <div
            v-if="run.status !== 'error' && !isMinimized(run)"
            class="result-action-bar"
          >
            <button
              v-if="!isExplained(run)"
              class="ai-explain-btn"
              type="button"
              @click="onExplain(run)"
            >
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path
                  d="M12 1C12 7.075 7.075 12 1 12C7.075 12 12 16.925 12 23C12 16.925 16.925 12 23 12C16.925 12 12 7.075 12 1Z"
                />
              </svg>
              <span>Explain this Result</span>
            </button>
            <div class="result-actions-group">
              <template v-if="chartElOf(run)">
                <div class="chart-size-picker">
                  <button
                    class="btn btn-sm btn-chart-size"
                    type="button"
                    :title="`Chart size: ${chartSizeLabel(run.runId)} (click to change)`"
                    @click.stop="toggleChartSizeMenu(run.runId)"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="15 3 21 3 21 9" />
                      <polyline points="9 21 3 21 3 15" />
                      <line x1="21" y1="3" x2="14" y2="10" />
                      <line x1="3" y1="21" x2="10" y2="14" />
                    </svg>
                    <span>Size: {{ chartSizeLabel(run.runId) }}</span>
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                  <div v-if="activeChartSizeMenu === run.runId" class="chart-size-dropdown" role="menu">
                    <button
                      v-for="s in CHART_SIZES"
                      :key="s.id"
                      type="button"
                      class="chart-size-item"
                      :class="{ 'is-selected': chartSize(run.runId) === s.id }"
                      @click.stop="setChartSize(run.runId, s.id)"
                    >
                      <span class="size-name">{{ s.label }}</span>
                      <span class="size-hint">{{ s.hint }}</span>
                      <svg v-if="chartSize(run.runId) === s.id" class="size-check" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </button>
                  </div>
                </div>
                <button
                  class="btn btn-sm"
                  type="button"
                  @click.stop="$emit('open-viz', run)"
                >
                  {{
                    run.analysisId === "visualize"
                      ? "Edit options"
                      : "Open in Visualizer"
                  }}
                </button>
                <button
                  v-if="chartElOf(run)?.svg"
                  class="btn btn-sm"
                  type="button"
                  @click.stop="$emit('export-chart', run, chartElOf(run)!)"
                >
                  Export PNG
                </button>
              </template>
              <button
                class="btn btn-sm btn-copy-result"
                type="button"
                :title="
                  isCopied(run.runId, 'copy')
                    ? 'Copied!'
                    : 'Copy this result (keeps table layout)'
                "
                :aria-label="
                  isCopied(run.runId, 'copy') ? 'Copied!' : 'Copy this result'
                "
                @click.stop="$emit('copy-run', run)"
              >
                <svg
                  v-if="isCopied(run.runId, 'copy')"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <svg
                  v-else
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                </svg>
                <span>{{ isCopied(run.runId, "copy") ? "Copied!" : "Copy" }}</span>
              </button>
            </div>
          </div>
        </template>
      </article>
    </div>
  </section>
</template>

<style scoped>
/* Results Pane Header & Gear menu for decimal precision */
.pane-results .pane-header,
.pane-header {
  overflow: visible !important;
  position: relative;
  z-index: 80;
}

.gear-menu-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.decimal-dropdown-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: -24px;
  z-index: 1000;
  min-width: 180px;
  background: var(--surface);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-md, 8px);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
  padding: 5px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.decimal-dropdown-header {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
  padding: 6px 8px 4px;
}

.decimal-dropdown-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 5px 8px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  text-align: left;
  transition: all 0.12s ease;
}

.decimal-dropdown-item:hover {
  background: var(--surface-hover);
  color: var(--accent);
}

.decimal-dropdown-item.is-selected {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.decimal-check {
  color: var(--accent);
  flex-shrink: 0;
}

/* Chart container, SVG and size controls */
.chart-container {
  display: flex;
  justify-content: center;
  align-items: center;
  width: 100%;
  margin: 8px 0;
  border-radius: var(--radius-sm, 6px);
  background: var(--surface-subtle);
  border: 1px solid var(--line-subtle);
  padding: 8px;
  box-sizing: border-box;
  overflow: hidden;
  transition: max-width 0.2s ease;
}

.chart-container.size-fit {
  max-width: 100%;
}

.chart-container.size-sm {
  max-width: 380px;
  margin-left: auto;
  margin-right: auto;
}

.chart-container.size-md {
  max-width: 560px;
  margin-left: auto;
  margin-right: auto;
}

.chart-container.size-lg {
  max-width: 750px;
  margin-left: auto;
  margin-right: auto;
}

.chart-container.size-full {
  max-width: 100%;
  overflow-x: auto;
}

.chart-svg {
  width: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
}

.chart-svg :deep(svg) {
  width: 100% !important;
  max-width: 100%;
  height: auto !important;
  display: block;
}

.chart-container.size-full .chart-svg :deep(svg) {
  width: auto !important;
  max-width: none !important;
}

.result-actions-group {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.result-actions-group :deep(.btn-copy-result) {
  margin-left: 0;
}

/* Chart size picker dropdown */
.chart-size-picker {
  position: relative;
  display: inline-flex;
}

.btn-chart-size {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
}

.chart-size-dropdown {
  position: absolute;
  bottom: calc(100% + 4px);
  right: 0;
  z-index: 100;
  min-width: 155px;
  background: var(--surface);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-md, 8px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.chart-size-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 8px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  text-align: left;
  transition: all 0.12s ease;
}

.chart-size-item:hover {
  background: var(--surface-hover);
  color: var(--accent);
}

.chart-size-item.is-selected {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.chart-size-item .size-hint {
  margin-left: auto;
  font-size: 10px;
  color: var(--muted);
}

.chart-size-item .size-check {
  color: var(--accent);
  flex-shrink: 0;
}

/* Executive verdict */
.verdict-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 6px 0 2px;
}

.verdict-badge {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 8px;
  border-radius: 100px;
  border: 1px solid;
}

.verdict-badge.is-sig {
  color: var(--ok);
  border-color: var(--ok);
  background: var(--surface);
}

.verdict-badge.is-ns {
  color: var(--muted);
  border-color: var(--line-strong);
  background: var(--surface);
}

.verdict-citation {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}

/* Assumption pills */
.assumption-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin: 6px 0 2px;
}

.assumption-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10.5px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 100px;
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.assumption-pill.is-ok {
  color: var(--ok);
  border-color: var(--ok);
}

.assumption-pill.is-warn {
  color: var(--warn);
  border-color: var(--warn);
}

.assumption-detail {
  font-weight: 500;
}

.fallback-chip {
  font-size: 10.5px;
  font-weight: 700;
  padding: 3px 10px;
  border-radius: 100px;
  border: 1px solid var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
  cursor: pointer;
  transition: all 0.12s ease;
}

.fallback-chip:hover {
  background: var(--accent);
  color: var(--panel);
}

/* Per-table copy */
.scalar-table {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.scalar-table .result-stats {
  width: 100%;
}

.scalar-table .table-copy-btn {
  margin: -4px 0 6px;
}

.table-caption-text {
  margin-right: 8px;
}

.table-copy-btn {
  font-size: 9.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: 3px;
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--muted);
  cursor: pointer;
}

.table-copy-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

/* Empty-state quick starts */
.quick-start-row {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-top: 14px;
  flex-wrap: wrap;
}

.quick-start-btn {
  font-size: 11.5px;
  font-weight: 600;
  padding: 5px 14px;
  border-radius: 100px;
  border: 1px solid var(--line-strong);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  transition: all 0.12s ease;
}

.quick-start-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}
</style>
