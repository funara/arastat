<script setup lang="ts">
// Visualize dialog (Phase 8 §8.2.E): Plotly chart builder extracted from App.vue.
// Owns the whole chart surface — trace construction, layout theming, and the
// footer actions (pin to results, export). App only opens/closes it and routes
// the `pin` event into the run store.
import { computed, nextTick, ref, watch } from 'vue'
import Plotly from 'plotly.js-dist-min'
import { state, showValueLabels, type Cell } from './store.ts'

export type VizType = 'scatter' | 'bar' | 'line' | 'histogram' | 'boxplot'

const props = withDefaults(
  defineProps<{ open: boolean; type?: VizType; defaultX?: string; defaultY?: string }>(),
  { type: 'scatter', defaultX: '', defaultY: '' }
)

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'pin', payload: { caption: string; svg: string }): void
}>()

const dlg = ref<HTMLDialogElement | null>(null)
const plotEl = ref<HTMLElement | null>(null)

const vizType = ref<VizType>(props.type)
const vizX = ref('')
const vizY = ref('')
const status = ref('')

const numericCols = computed(() => state.ds.columns.filter((c) => c.type === 'numeric'))

// Boxplot reads one numeric column and ignores X, so it has no second axis.
const needsY = computed(() => vizType.value !== 'histogram')
const needsX = computed(() => vizType.value !== 'boxplot')

const availableXCols = computed(() => {
  if (vizType.value === 'scatter' || vizType.value === 'histogram' || vizType.value === 'boxplot') {
    return numericCols.value.length ? numericCols.value : state.ds.columns
  }
  return state.ds.columns
})

const availableYCols = computed(() => {
  // Only the histogram has no Y axis; every other type reads a numeric Y.
  if (vizType.value !== 'histogram') {
    return numericCols.value.length ? numericCols.value : state.ds.columns
  }
  return state.ds.columns
})

/** First column usable as a chart source: the chart needs data to draw at all. */
function pickValid(current: string, list: typeof state.ds.columns, avoid?: string): string {
  if (list.some((c) => c.name === current)) return current
  return (list.find((c) => c.name !== avoid) ?? list[0])?.name ?? ''
}

function seedSelection(): void {
  const xList = availableXCols.value
  const yList = availableYCols.value
  vizX.value =
    props.defaultX && xList.some((c) => c.name === props.defaultX)
      ? props.defaultX
      : pickValid(vizX.value, xList)
  const avoid = vizType.value === 'scatter' ? vizX.value : undefined
  vizY.value =
    props.defaultY && yList.some((c) => c.name === props.defaultY)
      ? props.defaultY
      : pickValid(vizY.value, yList, avoid)
  if (avoid && vizY.value === avoid) {
    vizY.value = (yList.find((c) => c.name !== avoid) ?? yList[0])?.name ?? ''
  }
}

function num(v: Cell): number {
  return typeof v === 'number' ? v : Number(v)
}

function column(name: string): Cell[] {
  return (state.ds.data[name] as Cell[] | undefined) ?? []
}

/** Trace + axis titles for the current chart type. Pure but for the store read. */
function buildTrace(): { trace: Record<string, unknown>; yTitle: string; title: string } {
  const rawX = column(vizX.value)
  const rawY = column(vizY.value)
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
  const primary = '#3b82f6'
  const border = isDark ? '#60a5fa' : '#1d4ed8'

  if (vizType.value === 'histogram') {
    const vals = rawX.map(num).filter((v) => Number.isFinite(v))
    return {
      trace: {
        x: vals,
        type: 'histogram',
        name: vizX.value,
        marker: { color: primary, opacity: 0.8, line: { width: 1, color: border } },
        hovertemplate: '<b>Range</b>: %{x}<br><b>Count</b>: %{y}<extra></extra>',
      },
      yTitle: 'Frequency',
      title: `Distribution of ${vizX.value}`,
    }
  }

  if (vizType.value === 'boxplot') {
    const vals = rawY.map(num).filter((v) => Number.isFinite(v))
    return {
      trace: {
        y: vals,
        type: 'box',
        name: vizY.value,
        boxmean: true,
        marker: { color: primary },
        line: { color: border, width: 1.5 },
        hovertemplate: `<b>${vizY.value}</b>: %{y}<extra></extra>`,
      },
      yTitle: vizY.value || 'Value',
      title: `Distribution of ${vizY.value}`,
    }
  }

  if (vizType.value === 'bar') {
    // Categorical X + numeric Y aggregates to the group mean.
    const labels = state.ds.columns.find((c) => c.name === vizX.value)?.valueLabels
    const showLabels = showValueLabels.value
    const groups = new Map<string, number[]>()
    const len = Math.max(rawX.length, rawY.length)
    for (let i = 0; i < len; i++) {
      const cat = String(rawX[i] ?? '').trim()
      if (!cat || cat === 'null' || cat === 'undefined') continue
      const vy = num(rawY[i])
      if (Number.isFinite(vy)) {
        if (!groups.has(cat)) groups.set(cat, [])
        groups.get(cat)!.push(vy)
      }
    }
    const cats: string[] = []
    const means: number[] = []
    for (const [cat, vals] of groups) {
      const hit = showLabels ? labels?.[cat] : undefined
      cats.push(hit ? `${hit} (${cat})` : cat)
      means.push(Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100)
    }
    return {
      trace: {
        x: cats,
        y: means,
        type: 'bar',
        name: `Mean ${vizY.value}`,
        marker: { color: primary, opacity: 0.85, line: { width: 1, color: border } },
        hovertemplate: `<b>%{x}</b><br>Mean ${vizY.value}: %{y}<extra></extra>`,
      },
      yTitle: `Mean ${vizY.value}`,
      title: `Mean ${vizY.value} by ${vizX.value}`,
    }
  }

  // scatter / line: pairwise numeric extraction; line sorts by X for a clean path.
  const pairs: Array<{ x: number; y: number }> = []
  const len = Math.max(rawX.length, rawY.length)
  for (let i = 0; i < len; i++) {
    const vx = num(rawX[i])
    const vy = num(rawY[i])
    if (Number.isFinite(vx) && Number.isFinite(vy)) pairs.push({ x: vx, y: vy })
  }
  if (vizType.value === 'line') {
    pairs.sort((a, b) => a.x - b.x)
    return {
      trace: {
        x: pairs.map((p) => p.x),
        y: pairs.map((p) => p.y),
        type: 'scatter',
        mode: 'lines+markers',
        name: `${vizY.value} by ${vizX.value}`,
        line: { color: primary, width: 2 },
        marker: { size: 5, color: border },
        hovertemplate: `<b>${vizX.value}</b>: %{x}<br><b>${vizY.value}</b>: %{y}<extra></extra>`,
      },
      yTitle: vizY.value || 'Value',
      title: `${vizY.value} over ${vizX.value}`,
    }
  }
  return {
    trace: {
      x: pairs.map((p) => p.x),
      y: pairs.map((p) => p.y),
      type: 'scatter',
      mode: 'markers',
      name: `${vizY.value} vs ${vizX.value}`,
      marker: { size: 8, color: primary, opacity: 0.8, line: { width: 1, color: border } },
      hovertemplate: `<b>${vizX.value}</b>: %{x}<br><b>${vizY.value}</b>: %{y}<extra></extra>`,
    },
    yTitle: vizY.value || 'Value',
    title: `Scatter: ${vizY.value} vs ${vizX.value}`,
  }
}

function caption(): string {
  const t = vizType.value
  if (t === 'histogram') return `Histogram of ${vizX.value}`
  if (t === 'boxplot') return `Boxplot of ${vizY.value}`
  if (t === 'bar') return `Mean ${vizY.value} by ${vizX.value}`
  if (t === 'line') return `Line chart: ${vizY.value} over ${vizX.value}`
  return `Scatter plot: ${vizY.value} vs ${vizX.value}`
}

function render(): void {
  const host = plotEl.value
  if (!host) return
  if (needsX.value && !vizX.value) return
  if (needsY.value && !vizY.value) return

  const { trace, yTitle, title } = buildTrace()
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
  const textColor = isDark ? '#e2e8f0' : '#1e293b'
  const mutedColor = isDark ? '#94a3b8' : '#64748b'
  const gridColor = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.07)'
  const zeroLineColor = isDark ? 'rgba(255, 255, 255, 0.18)' : 'rgba(0, 0, 0, 0.15)'

  const layout: Record<string, unknown> = {
    title: { text: title, font: { family: 'inherit', size: 14, color: textColor } },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { family: 'inherit', color: textColor, size: 11 },
    margin: { t: 48, r: 24, b: 52, l: 64 },
    xaxis: {
      title: { text: needsX.value ? vizX.value : '', font: { color: textColor, size: 12 } },
      gridcolor: gridColor,
      zerolinecolor: zeroLineColor,
      linecolor: gridColor,
      tickfont: { color: mutedColor, size: 11 },
    },
    yaxis: {
      title: { text: yTitle, font: { color: textColor, size: 12 } },
      gridcolor: gridColor,
      zerolinecolor: zeroLineColor,
      linecolor: gridColor,
      tickfont: { color: mutedColor, size: 11 },
    },
    hoverlabel: {
      bgcolor: isDark ? '#1e293b' : '#ffffff',
      bordercolor: isDark ? '#475569' : '#cbd5e1',
      font: { color: textColor, family: 'inherit' },
    },
    modebar: { bgcolor: 'transparent', color: mutedColor, activecolor: '#3b82f6' },
    autosize: true,
  }
  const config: Record<string, unknown> = {
    responsive: true,
    displaylogo: false,
    modeBarButtonsToRemove: ['lasso2d', 'select2d'],
  }
  void Plotly.react(host, [trace], layout, config)
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
    const url = await Plotly.toImage(host, { format: 'svg', width: 900, height: 600 })
    emit('pin', { caption: caption(), svg: decodeDataUrl(url) })
    status.value = 'Chart pinned to Result.'
  } catch (err) {
    status.value = `The chart could not be pinned. ${err instanceof Error ? err.message : ''}`.trim()
  }
}

/** Rasterize the chart SVG ourselves. Plotly's own PNG path routes through a
 *  `blob:` image, which the app's CSP (img-src has no `blob:`) blocks — here and
 *  in the shipped WebView. A `data:` SVG image is allowed, so decode → <img> →
 *  canvas → PNG stays inside the policy. */
async function svgToPngBytes(svgMarkup: string, width: number, height: number): Promise<Uint8Array> {
  const img = new Image()
  img.width = width
  img.height = height
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('the chart image could not be rasterized.'))
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgMarkup)}`
  })
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('the canvas is unavailable.')
  ctx.drawImage(img, 0, 0, width, height)
  const png = canvas.toDataURL('image/png')
  const bin = atob(png.slice(png.indexOf(',') + 1))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

async function onExportPng(): Promise<void> {
  const host = plotEl.value
  if (!host) return
  status.value = ''
  try {
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
    vizType.value = props.type
    status.value = ''
    seedSelection()
    void nextTick(() => {
      const el = dlg.value
      if (el && !el.open) el.showModal()
      render()
    })
  },
  { immediate: true }
)
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
      <div class="visualize-controls-bar">
        <div class="viz-field">
          <label for="vizType">Chart Type</label>
          <select id="vizType" v-model="vizType" class="viz-select" @change="onTypeChange">
            <option value="scatter">Scatter Plot</option>
            <option value="bar">Bar Chart</option>
            <option value="line">Line Chart</option>
            <option value="histogram">Histogram</option>
            <option value="boxplot">Boxplot</option>
          </select>
        </div>
        <div v-if="needsX" class="viz-field">
          <label for="vizX">X Variable</label>
          <select id="vizX" v-model="vizX" class="viz-select" @change="render">
            <option v-for="c in availableXCols" :key="c.name" :value="c.name">{{ c.name }}</option>
          </select>
        </div>
        <div v-if="needsY" class="viz-field">
          <label for="vizY">Y Variable</label>
          <select id="vizY" v-model="vizY" class="viz-select" @change="render">
            <option v-for="c in availableYCols" :key="c.name" :value="c.name">{{ c.name }}</option>
          </select>
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
