<script setup lang="ts">
// Visualize dialog (Phase 8 §8.2.E): Plotly chart builder extracted from App.vue.
// Owns the whole chart surface — trace construction, layout theming, and the
// footer actions (pin to results, export). App only opens/closes it and routes
// the `pin` event into the run store. The chart *logic* lives in vizCharts.ts
// so it stays pure and unit-testable; this file is the Plotly shell.
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { state, showValueLabels } from './store.ts'

type PlotlyModule = typeof import('plotly.js-dist-min')['default']
let plotlyPromise: Promise<PlotlyModule> | null = null

/** Lazy-load Plotly on first chart render so the 4.8 MB bundle stays out of startup. */
function loadPlotly(): Promise<PlotlyModule> {
  if (!plotlyPromise) {
    plotlyPromise = import('plotly.js-dist-min').then((m) => m.default)
  }
  return plotlyPromise
}
import { svgToPngBytes } from './exports.ts'
import {
  buildTraces,
  captionFor,
  type VizSpec,
  type VizTheme,
  type VizType,
} from './vizCharts.ts'

export type { VizSpec, VizType }

const props = withDefaults(
  defineProps<{
    open: boolean
    type?: VizType
    defaultX?: string
    defaultY?: string
    /** Saved chart to edit (Results pane → Edit options). */
    initialSpec?: VizSpec | null
  }>(),
  { type: 'scatter', defaultX: '', defaultY: '', initialSpec: null }
)

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'pin', payload: { caption: string; svg: string; spec: VizSpec }): void
}>()

const dlg = ref<HTMLDialogElement | null>(null)
const plotEl = ref<HTMLElement | null>(null)

const vizType = ref<VizType>(props.type)
const vizX = ref('')
const vizY = ref('')
const vizGroup = ref('')
const trendline = ref(false)
const status = ref('')

const numericCols = computed(() => state.ds.columns.filter((c) => c.type === 'numeric'))
const groupLikeCols = computed(() =>
  state.ds.columns.filter((c) => c.measure === 'nominal' || c.measure === 'ordinal')
)

/** The histogram plots X's own values; every other type reads a numeric Y. */
const needsY = computed(() => vizType.value !== 'histogram')

const availableXCols = computed(() => {
  if (vizType.value === 'histogram') return numericCols.value.length ? numericCols.value : state.ds.columns
  if (vizType.value === 'boxplot') return groupLikeCols.value.length ? groupLikeCols.value : state.ds.columns
  if (vizType.value === 'bar') {
    return groupLikeCols.value.length ? groupLikeCols.value : numericCols.value.length ? numericCols.value : state.ds.columns
  }
  return numericCols.value.length ? numericCols.value : state.ds.columns
})

const availableYCols = computed(() =>
  numericCols.value.length ? numericCols.value : state.ds.columns
)

/** The "Group / Color by" column: any column that is not already on an axis. */
const availableGroupCols = computed(() => {
  const used = new Set([vizX.value, vizY.value].filter(Boolean))
  const rest = state.ds.columns.filter((c) => !used.has(c.name))
  const groupLike = rest.filter((c) => c.measure === 'nominal' || c.measure === 'ordinal')
  return groupLike.length ? groupLike : rest
})

/** First column usable as a chart source: the chart needs data to draw at all. */
function pickValid(current: string, list: typeof state.ds.columns, avoid?: string): string {
  if (list.some((c) => c.name === current)) return current
  return (list.find((c) => c.name !== avoid) ?? list[0])?.name ?? ''
}

function seedSelection(): void {
  const xList = availableXCols.value
  const yList = availableYCols.value
  // A boxplot's X is an optional group: an empty X means "no grouping".
  if (vizType.value === 'boxplot' && !vizX.value) {
    // keep the empty group
  } else {
    vizX.value =
      props.defaultX && xList.some((c) => c.name === props.defaultX)
        ? props.defaultX
        : pickValid(vizX.value, xList)
  }
  const avoid = vizType.value === 'scatter' ? vizX.value : undefined
  vizY.value =
    props.defaultY && yList.some((c) => c.name === props.defaultY)
      ? props.defaultY
      : pickValid(vizY.value, yList, avoid)
  if (avoid && vizY.value === avoid) {
    vizY.value = (yList.find((c) => c.name !== avoid) ?? yList[0])?.name ?? ''
  }
  // The group column must never collide with an axis.
  if (vizGroup.value && (vizGroup.value === vizX.value || vizGroup.value === vizY.value)) {
    vizGroup.value = ''
  }
}

/** Reads the live theme tokens so light and dark stay in lockstep. */
function readTheme(): VizTheme {
  const root = getComputedStyle(document.documentElement)
  const get = (name: string, fallback: string): string =>
    root.getPropertyValue(name).trim() || fallback
  return {
    primary: get('--accent', '#2367ec'),
    border: get('--accent-dark', '#1b58cf'),
    text: get('--text', '#0f172a'),
    muted: get('--muted', '#64748b'),
    grid: get('--line', '#e2e8f0'),
    surface: get('--surface', '#ffffff'),
    palette: [
      get('--accent', '#2367ec'),
      get('--err', '#ef4444'),
      get('--ok', '#059669'),
      get('--warn', '#d97706'),
      get('--badge-nominal-text', '#7c3aed'),
      get('--badge-ordinal-text', '#0891b2')
    ]
  }
}

/** The chart request that travels with a pinned chart. */
function currentSpec(): VizSpec {
  return {
    type: vizType.value,
    x: vizX.value,
    y: vizY.value,
    group: vizGroup.value,
    trendline: trendline.value
  }
}

function caption(): string {
  return captionFor(currentSpec())
}

function render(): void {
  const host = plotEl.value
  if (!host) return
  if (!vizX.value && vizType.value !== 'histogram') return
  if (needsY.value && !vizY.value) return

  const theme = readTheme()
  const { traces, yTitle, title } = buildTraces({
    type: vizType.value,
    x: vizX.value,
    y: vizY.value,
    group: vizGroup.value,
    trendline: trendline.value,
    columns: state.ds.columns,
    data: state.ds.data,
    showValueLabels: showValueLabels.value,
    theme
  })
  if (!traces.length) return
  const gridColor = theme.grid

  const layout: Record<string, unknown> = {
    title: { text: title, font: { family: 'inherit', size: 14, color: theme.text } },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { family: 'inherit', color: theme.text, size: 11 },
    margin: { t: 48, r: 24, b: 52, l: 64 },
    showlegend: traces.length > 1,
    xaxis: {
      title: { text: vizX.value, font: { color: theme.text, size: 12 } },
      gridcolor: gridColor,
      zerolinecolor: gridColor,
      linecolor: gridColor,
      tickfont: { color: theme.muted, size: 11 }
    },
    yaxis: {
      title: { text: yTitle, font: { color: theme.text, size: 12 } },
      gridcolor: gridColor,
      zerolinecolor: gridColor,
      linecolor: gridColor,
      tickfont: { color: theme.muted, size: 11 }
    },
    hoverlabel: {
      bgcolor: theme.surface,
      bordercolor: theme.grid,
      font: { color: theme.text, family: 'inherit' }
    },
    modebar: { bgcolor: 'transparent', color: theme.muted, activecolor: theme.primary },
    autosize: true
  }
  const config: Record<string, unknown> = {
    responsive: true,
    displaylogo: false,
    modeBarButtonsToRemove: ['lasso2d', 'select2d']
  }
  void loadPlotly().then((Plotly) => Plotly.react(host, traces, layout, config))
}

function onTypeChange(): void {
  seedSelection()
  render()
}

/** Plotly hands back a `data:` URL. Decoding it in memory is the only option
 *  here: the CSP's connect-src does not allow `data:`, so fetch() throws. */
function decodeDataUrl(url: string): string {
  const payload = url.slice(url.indexOf(',') + 1)
  if (/;base64/i.test(url)) {
    const bin = atob(payload)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  }
  return decodeURIComponent(payload)
}

async function onPin(): Promise<void> {
  const host = plotEl.value
  if (!host) return
  status.value = ''
  try {
    const Plotly = await loadPlotly()
    const url = await Plotly.toImage(host, { format: 'svg', width: 900, height: 600 })
    emit('pin', { caption: caption(), svg: decodeDataUrl(url), spec: currentSpec() })
    status.value = 'Chart pinned to Result.'
  } catch (err) {
    status.value = `The chart could not be pinned. ${err instanceof Error ? err.message : ''}`.trim()
  }
}

/** Rasterize the chart SVG ourselves. Plotly's own PNG path routes through a
 *  `blob:` image, which the app's CSP (img-src has no `blob:`) blocks — here and
 *  in the shipped WebView. A `data:` SVG image is allowed, so decode → <img> →
 *  canvas → PNG stays inside the policy. */
async function onExportPng(): Promise<void> {
  const host = plotEl.value
  if (!host) return
  status.value = ''
  try {
    const Plotly = await loadPlotly()
    const url = await Plotly.toImage(host, { format: 'svg', width: 1200, height: 800 })
    const bytes = await svgToPngBytes(decodeDataUrl(url), 1200, 800)
    // Same native save path as the HTML export: the user picks the location and
    // nothing depends on a browser download.
    const name = `${caption().replace(/[^\w.-]+/g, '_') || 'chart'}.png`
    const path = await window.ara.file.save(name)
    if (!path) return void (status.value = 'PNG export cancelled.')
    const ok = await window.ara.file.writeBytes(path, bytes.buffer as ArrayBuffer)
    status.value = ok ? `Image saved to ${path}.` : 'The file could not be saved. Try a different location.'
  } catch (err) {
    status.value = `The image could not be exported: ${err instanceof Error ? err.message : String(err)}`
  }
}

function close(): void {
  dlg.value?.close()
}

function onBackdropClick(e: MouseEvent): void {
  const el = dlg.value
  if (!el || e.target !== el) return
  const r = el.getBoundingClientRect()
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) el.close()
}

// The dialog mounts once and is shown/hidden by the parent, so seeding and
// rendering (which need a laid-out plot host) happen on the open edge.
watch(
  () => props.open,
  (open) => {
    if (!open) return
    status.value = ''
    if (props.initialSpec) {
      vizType.value = props.initialSpec.type
      vizX.value = props.initialSpec.x
      vizY.value = props.initialSpec.y
      vizGroup.value = props.initialSpec.group ?? ''
      trendline.value = props.initialSpec.trendline ?? false
    } else {
      vizType.value = props.type
      vizX.value = ''
      vizY.value = ''
      vizGroup.value = ''
      trendline.value = false
    }
    seedSelection()
    void nextTick(() => {
      const el = dlg.value
      if (el && !el.open) el.showModal()
      render()
    })
  },
  { immediate: true }
)

// Value labels change the bar categories, so the chart has to be rebuilt.
watch(showValueLabels, () => {
  if (props.open) render()
})

// The theme tokens live on <html data-theme>: watch the switch so the chart
// repaints in the new palette instead of keeping the old colours.
let themeObserver: MutationObserver | null = null

onMounted(() => {
  themeObserver = new MutationObserver(() => {
    if (props.open) render()
  })
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme']
  })
})

onUnmounted(() => {
  themeObserver?.disconnect()
  themeObserver = null
})
</script>

<template>
  <dialog
    ref="dlg"
    class="settings-dlg visualize-dlg"
    aria-labelledby="visualizeTitle"
    @click="onBackdropClick($event)"
    @close="emit('close')"
  >
    <div class="ara-modal-head">
      <div class="ara-modal-title-wrap">
        <div class="ara-modal-badge" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="20" x2="18" y2="10" />
            <line x1="12" y1="20" x2="12" y2="4" />
            <line x1="6" y1="20" x2="6" y2="14" />
          </svg>
        </div>
        <h3 id="visualizeTitle">Visualize Data</h3>
      </div>
      <button type="button" class="ara-modal-close" title="Close (Esc)" aria-label="Close visualization" @click="close">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>

    <div class="visualize-body">
      <!-- Chart type strip (design.md §4.4: icon strip, not a bare dropdown) -->
      <div class="viz-type-strip" role="group" aria-label="Chart type">
        <button
          v-for="t in (['scatter', 'bar', 'line', 'histogram', 'boxplot'] as VizType[])"
          :key="t"
          type="button"
          class="viz-type-btn"
          :class="{ 'is-active': vizType === t }"
          :aria-pressed="vizType === t"
          :title="t.charAt(0).toUpperCase() + t.slice(1)"
          @click="vizType = t; onTypeChange()"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <template v-if="t === 'scatter'">
              <circle cx="4" cy="11" r="1.6" /><circle cx="8" cy="6" r="1.6" /><circle cx="12" cy="9" r="1.6" />
            </template>
            <template v-else-if="t === 'bar'">
              <line x1="3" y1="13" x2="13" y2="13" />
              <rect x="4" y="7" width="2.4" height="6" /><rect x="8" y="4" width="2.4" height="9" /><rect x="11" y="9" width="2.4" height="4" />
            </template>
            <template v-else-if="t === 'line'">
              <polyline points="2,12 6,7 9,9 14,4" />
            </template>
            <template v-else-if="t === 'histogram'">
              <rect x="2.5" y="8" width="2.6" height="5" /><rect x="6" y="4" width="2.6" height="9" /><rect x="9.5" y="6" width="2.6" height="7" />
            </template>
            <template v-else>
              <rect x="4" y="6" width="8" height="6" rx="1" /><line x1="8" y1="3" x2="8" y2="13" /><line x1="2.5" y1="6" x2="2.5" y2="12" /><line x1="13.5" y1="6" x2="13.5" y2="12" />
            </template>
          </svg>
          <span>{{ t.charAt(0).toUpperCase() + t.slice(1) }}</span>
        </button>
      </div>

      <div class="visualize-controls-bar">
        <div class="viz-field">
          <label for="vizX">{{ vizType === 'boxplot' ? 'Group (optional)' : 'X Variable' }}</label>
          <select id="vizX" v-model="vizX" class="viz-select" @change="render">
            <option v-if="vizType === 'boxplot'" value="">None</option>
            <option v-for="c in availableXCols" :key="c.name" :value="c.name">{{ c.name }}</option>
          </select>
        </div>
        <div v-if="needsY" class="viz-field">
          <label for="vizY">Y Variable</label>
          <select id="vizY" v-model="vizY" class="viz-select" @change="render">
            <option v-for="c in availableYCols" :key="c.name" :value="c.name">{{ c.name }}</option>
          </select>
        </div>
        <div v-if="vizType !== 'histogram' && vizType !== 'boxplot'" class="viz-field">
          <label for="vizGroup">Group / Color by</label>
          <select id="vizGroup" v-model="vizGroup" class="viz-select" @change="render">
            <option value="">None</option>
            <option v-for="c in availableGroupCols" :key="c.name" :value="c.name">{{ c.name }}</option>
          </select>
        </div>
        <div v-if="vizType === 'scatter'" class="viz-field">
          <label class="viz-toggle">
            <input v-model="trendline" type="checkbox" class="option-checkbox" @change="render" />
            <span>OLS trendline</span>
          </label>
        </div>
      </div>
      <div class="visualize-plot-container">
        <div ref="plotEl" class="visualize-plot" role="img" :aria-label="caption()"></div>
      </div>
    </div>

    <div class="ara-modal-foot">
      <p class="ara-status-pill" :class="status ? 'is-ready' : ''" role="status">
        <span v-if="!status">Charts render locally from the current dataset.</span>
        <span v-else>{{ status }}</span>
      </p>
      <div class="ara-modal-foot-actions">
        <button type="button" class="btn" @click="close">Close</button>
        <button type="button" class="btn" title="Download this chart as a PNG image" @click="onExportPng">
          Export PNG
        </button>
        <button type="button" class="btn btn-primary" title="Add this chart to the Result pane" @click="onPin">
          Pin to Results
        </button>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.viz-type-strip {
  display: flex;
  gap: 4px;
  padding: 4px;
  border-radius: var(--radius-md);
  background: var(--chrome);
  flex-shrink: 0;
}

.viz-type-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 9px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--muted);
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.12s ease;
}

.viz-type-btn:hover {
  color: var(--accent);
  background: var(--surface-hover);
}

.viz-type-btn.is-active {
  background: var(--panel);
  color: var(--accent);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}

.viz-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--muted);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
</style>
