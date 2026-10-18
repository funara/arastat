<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from "vue";
import Plotly from "plotly.js-dist-min";
import DataGrid from "./DataGrid.vue";
import VariableView from "./VariableView.vue";
import ResultsPane from "./ResultsPane.vue";
import AiDock from "./AiDock.vue";
import AnalysisDialog from "./AnalysisDialog.vue";
import TestAdvisorDialog from "./TestAdvisorDialog.vue";
import {
  state,
  rowCount,
  colCount,
  addRow,
  addColumn,
  deleteRow,
  deleteColumn,
  undo,
  redo,
  canUndo,
  canRedo,
  undoTip,
  redoTip,
  setDataset,
  uniqueColumnName,
  clearHistory,
  commit,
  batchCells,
  transformColumn,
  isUserMissing,
  type Cell,
} from "./store.ts";
import { defaultMeta, datasetFromRows } from "./io/types.ts";
import type { ColumnValues } from "./io/types.ts";
import { evalExprTokens, tokenizeExpr } from "./expr.ts";
import { computeFill, rowsWithMissing, type FillMode } from "./missing.ts";
import { schemaById, type AnalysisSchema } from "./specs.ts";
import { runAnalysis } from "./runAnalysis.ts";
import {
  applyNotification,
  snapshotRuns,
  restoreRuns,
  type Run,
} from "./results.ts";
import { buildResultsHtml, buildResultsText } from "./exports.ts";
import { runsState } from "./results.ts";
import { openWithDialog, saveWithDialog, ioMessage } from "./fileOps.ts";
import { resetAiAdvisorCache } from "./AiMissingAdvisorDialog.vue";
import AiMissingAdvisorDialog from "./AiMissingAdvisorDialog.vue";
import UpdateRestartModal from "./UpdateRestartModal.vue";

const rootEl = ref<HTMLElement | null>(null);
const aiDock = ref<InstanceType<typeof AiDock> | null>(null);
const isEmpty = computed(() => rowCount.value === 0);

/* ---------- Status Bar & Indicators (KISS: Reactive Local State) ---------- */
const aiStatus = ref<"ready" | "busy" | "error">("ready");
const aiStatusText = computed(() => {
  if (aiStatus.value === "busy") return "ARA Assistant thinking";
  if (aiStatus.value === "error") return "ARA Assistant unavailable";
  return "ARA Assistant ready";
});
const aiStatusDotClass = computed(() => {
  if (aiStatus.value === "busy") return "busy";
  if (aiStatus.value === "error") return "error";
  return "";
});

const cleanFilename = computed(() => {
  const raw = state.filename?.trim() || "";
  if (!raw) return "Untitled.sav";
  return raw.replace(/\.([a-zA-Z0-9]+)\.\1$/i, ".$1");
});

/* ---------- Theme Management ---------- */
type Theme = "light" | "dark";
const theme = ref<Theme>("light");

function applyTheme(t: Theme): void {
  theme.value = t;
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("ara:theme", t);
}

function toggleTheme(): void {
  applyTheme(theme.value === "dark" ? "light" : "dark");
  toast(`Switched to ${theme.value === "dark" ? "Dark" : "Light"} mode`);
}

/* ---------- Window Controls ---------- */
const isMaximized = ref(false);
const isWindows =
  typeof window !== "undefined" && /Windows/i.test(navigator.userAgent);

function minimizeWindow(): void {
  void window.ara?.window?.minimize();
}

function toggleMaximizeWindow(): void {
  void window.ara?.window?.toggleMaximize();
}

function closeWindow(): void {
  void window.ara?.window?.close();
}

/* ---------- Toast ---------- */
const toastMsg = ref("");
const toastShow = ref(false);
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string): void {
  toastMsg.value = msg;
  toastShow.value = true;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastShow.value = false;
  }, 2200);
}

function onAskAi(query: string): void {
  aiDock.value?.ask(query);
}

const dlgSchema = ref<AnalysisSchema | null>(null);
const dlgInitial = ref<Record<string, unknown> | undefined>(undefined);
const dlgRerunId = ref<string | undefined>(undefined);

function openAnalysis(
  id: string,
  initial?: Record<string, unknown>,
  rerunId?: string,
): void {
  closeMenus();
  const schema = schemaById(id);
  if (!schema) {
    toast(`No analysis named ${id} is available in this build.`);
    return;
  }
  dlgSchema.value = schema;
  dlgInitial.value = initial;
  dlgRerunId.value = rerunId;
}

const testAdvisorOpen = ref(false);
const testAdvisorVars = ref<string[] | undefined>(undefined);

function openTestAdvisor(vars?: string[]): void {
  closeMenus();
  testAdvisorVars.value = vars;
  testAdvisorOpen.value = true;
}

const healthOpen = ref(false);
const healthFocusVar = ref("");

function openHealthAdvisor(colName?: string): void {
  closeMenus();
  healthFocusVar.value = colName ?? "";
  healthOpen.value = true;
}

async function onDialogRun(payload: {
  schema: AnalysisSchema;
  values: Record<string, unknown>;
}): Promise<void> {
  const schema = payload.schema;
  const values = { ...payload.values };
  const rerunId = dlgRerunId.value;
  dlgSchema.value = null;
  dlgInitial.value = undefined;
  dlgRerunId.value = undefined;
  showResults.value = true;
  await runAnalysis(schema.id, values, {
    missingPolicy: schema.missingDefault,
    runId: rerunId,
  });
}

const showResults = ref(true);
const visualizeOpen = ref(false);
const visualizeDlg = ref<HTMLDialogElement | null>(null);
const visualizeEl = ref<HTMLElement | null>(null);
const visualizeType = ref<"scatter" | "bar" | "histogram" | "line">("scatter");
const visualizeX = ref("");
const visualizeY = ref("");

const availableXCols = computed(() => {
  if (
    visualizeType.value === "scatter" ||
    visualizeType.value === "histogram"
  ) {
    const num = state.ds.columns.filter((c) => c.type === "numeric");
    return num.length ? num : state.ds.columns;
  }
  return state.ds.columns;
});

const availableYCols = computed(() => {
  if (
    visualizeType.value === "scatter" ||
    visualizeType.value === "bar" ||
    visualizeType.value === "line"
  ) {
    const num = state.ds.columns.filter((c) => c.type === "numeric");
    return num.length ? num : state.ds.columns;
  }
  return state.ds.columns;
});

function onVisualizeTypeChange(): void {
  if (!availableXCols.value.some((c) => c.name === visualizeX.value)) {
    visualizeX.value = availableXCols.value[0]?.name ?? "";
  }
  if (
    !availableYCols.value.some((c) => c.name === visualizeY.value) ||
    (visualizeType.value === "scatter" && visualizeY.value === visualizeX.value)
  ) {
    visualizeY.value =
      availableYCols.value.find((c) => c.name !== visualizeX.value)?.name ??
      availableYCols.value[0]?.name ??
      "";
  }
  renderVisualization();
}

function openVisualize(
  type: "scatter" | "bar" | "histogram" | "line" = "scatter",
  defaultX?: string,
  defaultY?: string,
): void {
  closeMenus();
  visualizeType.value = type;
  const numCols = state.ds.columns.filter((c) => c.type === "numeric");
  const validXList =
    (type === "scatter" || type === "histogram") && numCols.length
      ? numCols
      : state.ds.columns;
  const validYList = numCols.length ? numCols : state.ds.columns;

  if (defaultX && validXList.some((c) => c.name === defaultX)) {
    visualizeX.value = defaultX;
  } else if (!validXList.some((c) => c.name === visualizeX.value)) {
    visualizeX.value = validXList[0]?.name ?? "";
  }

  if (defaultY && validYList.some((c) => c.name === defaultY)) {
    visualizeY.value = defaultY;
  } else if (
    !validYList.some((c) => c.name === visualizeY.value) ||
    (type === "scatter" && visualizeY.value === visualizeX.value)
  ) {
    visualizeY.value =
      (validYList.find((c) => c.name !== visualizeX.value) ?? validYList[0])
        ?.name ?? "";
  }

  visualizeOpen.value = true;
  void nextTick(() => {
    visualizeDlg.value?.showModal();
    renderVisualization();
  });
}

function closeVisualize(): void {
  visualizeDlg.value?.close();
  visualizeOpen.value = false;
}

function renderVisualization(): void {
  const host = visualizeEl.value;
  if (!host || !visualizeX.value) return;

  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const textColor = isDark ? "#e2e8f0" : "#1e293b";
  const mutedColor = isDark ? "#94a3b8" : "#64748b";
  const gridColor = isDark
    ? "rgba(255, 255, 255, 0.08)"
    : "rgba(0, 0, 0, 0.07)";
  const zeroLineColor = isDark
    ? "rgba(255, 255, 255, 0.18)"
    : "rgba(0, 0, 0, 0.15)";
  const primaryBlue = "#3b82f6";
  const borderBlue = isDark ? "#60a5fa" : "#1d4ed8";

  const rawX =
    (state.ds.data[visualizeX.value] as Array<Cell> | undefined) ?? [];
  const rawY =
    (state.ds.data[visualizeY.value] as Array<Cell> | undefined) ?? [];

  let trace: Record<string, unknown>;
  let yAxisTitle = visualizeY.value || "Value";
  let chartTitle = `${visualizeY.value} vs ${visualizeX.value}`;

  if (visualizeType.value === "histogram") {
    const vals: number[] = [];
    for (let i = 0; i < rawX.length; i++) {
      const v =
        typeof rawX[i] === "number" ? (rawX[i] as number) : Number(rawX[i]);
      if (Number.isFinite(v)) vals.push(v);
    }
    trace = {
      x: vals,
      type: "histogram",
      name: visualizeX.value,
      marker: {
        color: primaryBlue,
        opacity: 0.8,
        line: { width: 1, color: borderBlue },
      },
      hovertemplate: "<b>Range</b>: %{x}<br><b>Count</b>: %{y}<extra></extra>",
    };
    yAxisTitle = "Frequency";
    chartTitle = `Distribution of ${visualizeX.value}`;
  } else if (visualizeType.value === "bar") {
    // If X has categorical groups and Y is numeric, aggregate Mean of Y per group
    const groups = new Map<string, number[]>();
    const len = Math.max(rawX.length, rawY.length);
    for (let i = 0; i < len; i++) {
      const cat = String(rawX[i] ?? "").trim();
      if (!cat || cat === "null" || cat === "undefined") continue;
      const vy =
        typeof rawY[i] === "number" ? (rawY[i] as number) : Number(rawY[i]);
      if (Number.isFinite(vy)) {
        if (!groups.has(cat)) groups.set(cat, []);
        groups.get(cat)!.push(vy);
      }
    }
    const cats: string[] = [];
    const means: number[] = [];
    for (const [cat, vals] of groups) {
      cats.push(cat);
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      means.push(Math.round(avg * 100) / 100);
    }
    trace = {
      x: cats,
      y: means,
      type: "bar",
      name: `Mean ${visualizeY.value}`,
      marker: {
        color: primaryBlue,
        opacity: 0.85,
        line: { width: 1, color: borderBlue },
      },
      hovertemplate: `<b>%{x}</b><br>Mean ${visualizeY.value}: %{y}<extra></extra>`,
    };
    yAxisTitle = `Mean ${visualizeY.value}`;
    chartTitle = `Mean ${visualizeY.value} by ${visualizeX.value}`;
  } else if (visualizeType.value === "line") {
    // Pairwise numeric extraction, sorted by X for a clean continuous line
    const pairs: Array<{ x: number; y: number }> = [];
    const len = Math.max(rawX.length, rawY.length);
    for (let i = 0; i < len; i++) {
      const vx =
        typeof rawX[i] === "number" ? (rawX[i] as number) : Number(rawX[i]);
      const vy =
        typeof rawY[i] === "number" ? (rawY[i] as number) : Number(rawY[i]);
      if (Number.isFinite(vx) && Number.isFinite(vy)) {
        pairs.push({ x: vx, y: vy });
      }
    }
    pairs.sort((a, b) => a.x - b.x);
    trace = {
      x: pairs.map((p) => p.x),
      y: pairs.map((p) => p.y),
      type: "scatter",
      mode: "lines+markers",
      name: `${visualizeY.value} by ${visualizeX.value}`,
      line: { color: primaryBlue, width: 2 },
      marker: { size: 5, color: borderBlue },
      hovertemplate: `<b>${visualizeX.value}</b>: %{x}<br><b>${visualizeY.value}</b>: %{y}<extra></extra>`,
    };
    chartTitle = `${visualizeY.value} over ${visualizeX.value}`;
  } else {
    // SCATTER PLOT: Explicitly mode: 'markers' (NOT lines!)
    const pairs: Array<{ x: number; y: number }> = [];
    const len = Math.max(rawX.length, rawY.length);
    for (let i = 0; i < len; i++) {
      const vx =
        typeof rawX[i] === "number" ? (rawX[i] as number) : Number(rawX[i]);
      const vy =
        typeof rawY[i] === "number" ? (rawY[i] as number) : Number(rawY[i]);
      if (Number.isFinite(vx) && Number.isFinite(vy)) {
        pairs.push({ x: vx, y: vy });
      }
    }
    trace = {
      x: pairs.map((p) => p.x),
      y: pairs.map((p) => p.y),
      type: "scatter",
      mode: "markers",
      name: `${visualizeY.value} vs ${visualizeX.value}`,
      marker: {
        size: 8,
        color: primaryBlue,
        opacity: 0.8,
        line: { width: 1, color: borderBlue },
      },
      hovertemplate: `<b>${visualizeX.value}</b>: %{x}<br><b>${visualizeY.value}</b>: %{y}<extra></extra>`,
    };
    chartTitle = `Scatter: ${visualizeY.value} vs ${visualizeX.value}`;
  }

  const layout: Record<string, unknown> = {
    title: {
      text: chartTitle,
      font: { family: "inherit", size: 14, color: textColor },
    },
    paper_bgcolor: "transparent",
    plot_bgcolor: "transparent",
    font: { family: "inherit", color: textColor, size: 11 },
    margin: { t: 48, r: 24, b: 52, l: 64 },
    xaxis: {
      title: { text: visualizeX.value, font: { color: textColor, size: 12 } },
      gridcolor: gridColor,
      zerolinecolor: zeroLineColor,
      linecolor: gridColor,
      tickfont: { color: mutedColor, size: 11 },
    },
    yaxis: {
      title: { text: yAxisTitle, font: { color: textColor, size: 12 } },
      gridcolor: gridColor,
      zerolinecolor: zeroLineColor,
      linecolor: gridColor,
      tickfont: { color: mutedColor, size: 11 },
    },
    hoverlabel: {
      bgcolor: isDark ? "#1e293b" : "#ffffff",
      bordercolor: isDark ? "#475569" : "#cbd5e1",
      font: { color: textColor, family: "inherit" },
    },
    modebar: {
      bgcolor: "transparent",
      color: mutedColor,
      activecolor: primaryBlue,
    },
    autosize: true,
  };

  const config: Record<string, unknown> = {
    responsive: true,
    displaylogo: false,
    modeBarButtonsToRemove: ["lasso2d", "select2d"],
  };

  void Plotly.react(host, [trace], layout, config);
}

function toggleResults(): void {
  showResults.value = !showResults.value;
}

function toggleAi(): void {
  aiDock.value?.toggle();
}

// Data/Column pane is always visible; the view buttons only switch views.
function ensureView(view: "data" | "variable"): void {
  state.view = view;
}

// Arrow-key navigation for the Data/Variable segmented tabs.
function viewTabKeyNav(ev: KeyboardEvent): void {
  if (ev.key === "ArrowRight") {
    ev.preventDefault();
    ensureView("variable");
  } else if (ev.key === "ArrowLeft") {
    ev.preventDefault();
    ensureView("data");
  }
}

// Resizable Data/Column pane vs Result View
const DEFAULT_DATA_WIDTH = 400;
const MIN_DATA_WIDTH = 390;
const MIN_RESULTS_WIDTH = 280;
const savedDataWidth = Number(localStorage.getItem("ara:data-pane-width"));
const dataPaneWidth = ref(
  Number.isFinite(savedDataWidth) && savedDataWidth > 0
    ? Math.max(MIN_DATA_WIDTH, Math.min(savedDataWidth, 440))
    : DEFAULT_DATA_WIDTH,
);
// Mirrored from AiDock's open-change so the wall follows rail/open in real time.
const aiDockOpen = ref(true);
const isResizingPanes = ref(false);
const stuckHintVisible = ref(false);
let stuckHintTimer: ReturnType<typeof setTimeout> | undefined;
// Push-to-collapse feel: a gentle push hits the wall; a configurable hard push
// minimizes the assistant so the data pane can expand.
const AI_OPEN_W = 360;
const AI_RAIL_W = 34;
const DEFAULT_AI_PUSH_PX = 48;
const savedPushThreshold = Number(
  localStorage.getItem("ara:ai-push-threshold"),
);
const aiPushThreshold = ref(
  Number.isFinite(savedPushThreshold) &&
    localStorage.getItem("ara:ai-push-threshold") !== null
    ? Math.max(0, Math.min(400, savedPushThreshold))
    : DEFAULT_AI_PUSH_PX,
);

function aiReserve(): number {
  return aiDockOpen.value ? AI_OPEN_W : AI_RAIL_W;
}

function dataWall(): number {
  return window.innerWidth - MIN_RESULTS_WIDTH - aiReserve() - 60;
}

function hideStuckHint(): void {
  stuckHintVisible.value = false;
  clearTimeout(stuckHintTimer);
  stuckHintTimer = undefined;
}

function showStuckHint(): void {
  if (stuckHintVisible.value) return;
  stuckHintVisible.value = true;
  stuckHintTimer = setTimeout(hideStuckHint, 1600);
}

function startSplitterResize(e: PointerEvent): void {
  e.preventDefault();
  isResizingPanes.value = true;
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  hideStuckHint();

  const startX = e.clientX;
  let showedStuckHint = false;
  // Base on the effective width, not the saved one: a saved width from a
  // wider/rail session can exceed the current wall and would jump on grab.
  const startWidth = Math.min(dataPaneWidth.value, dataWall());

  const onPointerMove = (ev: PointerEvent): void => {
    const delta = ev.clientX - startX;
    const wall = dataWall();
    const over = startWidth + delta - wall;
    if (aiDockOpen.value && over > aiPushThreshold.value) {
      // Hard push past the stuck wall: minimize the dock, keep dragging smooth.
      aiDock.value?.setOpen(false);
      const newWall = dataWall();
      dataPaneWidth.value = Math.max(
        MIN_DATA_WIDTH,
        Math.min(startWidth + delta, newWall),
      );
      return;
    }
    if (aiDockOpen.value && over > 0 && !showedStuckHint) {
      showedStuckHint = true;
      showStuckHint();
    }
    const clamped = Math.max(
      MIN_DATA_WIDTH,
      Math.min(wall, startWidth + delta),
    );
    dataPaneWidth.value = clamped;
  };

  const onPointerUp = (): void => {
    isResizingPanes.value = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    hideStuckHint();
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    localStorage.setItem("ara:data-pane-width", String(dataPaneWidth.value));
  };

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
}

const paneDataStyle = computed(() => {
  if (!showResults.value) {
    return { flex: "1 1 auto", width: "auto", maxWidth: "100%" };
  }
  const aiReservePx = aiReserve();
  return {
    flex: `0 0 ${dataPaneWidth.value}px`,
    width: `${dataPaneWidth.value}px`,
    maxWidth: `calc(100% - 280px - ${aiReservePx}px - 14px)`,
  };
});

const paneResultsStyle = computed(() => {
  return { flex: "1 1 0", minWidth: `${MIN_RESULTS_WIDTH}px` };
});

function openAuthorLink(): void {
  window.open("https://adhirahmadian.id", "_blank");
}

function fixOptions(run: Run): void {
  openAnalysis(run.analysisId, { ...run.spec }, run.runId);
}

function onExplainRun(run: Run): void {
  showResults.value = true;
  aiDock.value?.explainRun(run);
}

function closeRun(run: Run): void {
  const i = runsState.runs.findIndex((r) => r.runId === run.runId);
  if (i >= 0) runsState.runs.splice(i, 1);
}

async function copyRun(run: Run): Promise<void> {
  await copyRunsFormatted([run]);
}

async function exportHtml(): Promise<void> {
  try {
    // Autofill: arastat_<original>.<ext>.html (falls back to results.html).
    const base =
      (state.filename || "")
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.[a-zA-Z0-9]+$/, "") || "results";
    const path = await window.ara.file.save(`arastat_${base}.html`);
    if (!path) return;
    const html = buildResultsHtml(runsState.runs, new Date().toLocaleString());
    const ok = await window.ara.file.writeBytes(
      path,
      new TextEncoder().encode(html).buffer as ArrayBuffer,
    );
    toast(
      ok
        ? `Results saved to ${path}.`
        : "The file could not be saved. Try a different location.",
    );
  } catch (err) {
    toast(err instanceof Error ? err.message : "The file could not be saved.");
  }
}

// Rich copy: HTML + plain text so tables/pacing paste into Word/Sheets intact.
async function copyRunsFormatted(runs: Run[]): Promise<void> {
  if (!runs.length) {
    toast("No results to copy yet.");
    return;
  }
  const at = new Date().toLocaleString();
  const html = buildResultsHtml(runs, at);
  const text = buildResultsText(runs, at);
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ]);
    } else {
      await navigator.clipboard.writeText(text);
    }
    toast(
      runs.length === 1
        ? "Result copied with formatting."
        : "Results copied with formatting.",
    );
  } catch {
    toast("The clipboard could not be written. Try again.");
  }
}

const settingsOpen = ref(false);
const settingsDlg = ref<HTMLDialogElement | null>(null);
type AiProvider = "google" | "custom";
interface SettingsForm {
  provider: AiProvider;
  baseUrl: string;
  key: string;
  model: string;
  pushThreshold: number;
}
const settingsForm = ref<SettingsForm>({
  provider: "google",
  baseUrl: "",
  key: "",
  model: "",
  pushThreshold: DEFAULT_AI_PUSH_PX,
});
const showAiKey = ref(false);
// Hints are kept per provider: the key stored for Google must not be advertised
// on the Custom tab (and vice versa).
const savedKeyHints = ref<{ google: string; custom: string }>({ google: "", custom: "" });
const savedAiKeyHint = computed(() => {
  const hint = savedKeyHints.value[settingsForm.value.provider];
  return hint ? `Saved key: ••••${hint}. Enter a new key to replace it.` : "";
});
const settingsError = ref("");

const GOOGLE_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-pro",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
];

/* ---------- Google Key Guide Dialog ---------- */
const keyGuideOpen = ref(false);
const keyGuideDlg = ref<HTMLDialogElement | null>(null);

function openGoogleKeyGuide(): void {
  closeMenus();
  keyGuideOpen.value = true;
  void nextTick(() => keyGuideDlg.value?.showModal());
}

function closeGoogleKeyGuide(): void {
  keyGuideDlg.value?.close();
  keyGuideOpen.value = false;
}

function openAiStudioLink(): void {
  window.open("https://aistudio.google.com/apikey", "_blank");
}

function onAiVisualize(payload: {
  type: "scatter" | "bar" | "histogram" | "line";
  x?: string;
  y?: string;
}): void {
  openVisualize(payload.type || "scatter", payload.x, payload.y);
}

async function openSettings(): Promise<void> {
  closeMenus();
  if (settingsOpen.value || settingsDlg.value?.open) return;
  settingsOpen.value = true;
  await nextTick();
  const dialog = settingsDlg.value;
  if (dialog && !dialog.open) dialog.showModal();
  try {
    const s = await window.ara.ai.getSettings();
    const provider = s.provider;
    const savedProvider: AiProvider =
      provider === "custom" ? "custom" : "google";
    savedKeyHints.value = s.keyHints;
    settingsForm.value = {
      provider: savedProvider,
      baseUrl: s.baseUrl,
      key: "",
      model:
        s.model ||
        (savedProvider === "google" ? "gemini-3.8-flash" : "gpt-4o-mini"),
      pushThreshold: aiPushThreshold.value,
    };
  } catch {
    savedKeyHints.value = { google: "", custom: "" };
    settingsForm.value = {
      provider: "google",
      baseUrl: "",
      key: "",
      model: "",
      pushThreshold: aiPushThreshold.value,
    };
  }
}

function closeSettings(): void {
  settingsDlg.value?.close();
  settingsOpen.value = false;
}

function isLocalUrl(url: string): boolean {
  if (!url) return false;
  return /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?/i.test(url.trim());
}

const customModelsList = ref<string[]>([]);
const isFetchingModels = ref(false);

async function fetchCustomModels(): Promise<void> {
  const url = settingsForm.value.baseUrl.trim();
  if (!url) {
    settingsError.value = "Please enter a Base URL first.";
    return;
  }
  isFetchingModels.value = true;
  settingsError.value = "";
  try {
    let models: string[] = [];
    if (window.ara?.ai?.listModels) {
      models = await window.ara.ai.listModels({
        baseUrl: url,
        key: settingsForm.value.key.trim(),
      });
    } else {
      const cleanUrl = url.replace(/\/+$/, "");
      const modelsUrl = cleanUrl.endsWith("/models")
        ? cleanUrl
        : `${cleanUrl}/models`;
      const headers: Record<string, string> = { accept: "application/json" };
      if (settingsForm.value.key.trim()) {
        headers["authorization"] = `Bearer ${settingsForm.value.key.trim()}`;
      }
      const res = await fetch(modelsUrl, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as unknown;
      if (json && typeof json === "object") {
        const rec = json as Record<string, unknown>;
        const list = Array.isArray(rec.data)
          ? rec.data
          : Array.isArray(rec.models)
            ? rec.models
            : [];
        models = list
          .map((m: any) => (typeof m === "string" ? m : m.id || m.name))
          .filter(Boolean);
      }
    }
    if (models.length > 0) {
      customModelsList.value = models;
      if (
        !settingsForm.value.model ||
        !models.includes(settingsForm.value.model)
      ) {
        settingsForm.value.model = models[0];
      }
      toast(`Fetched ${models.length} model${models.length === 1 ? "" : "s"}.`);
    } else {
      toast(
        "No models returned by endpoint. You can enter model name manually.",
      );
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    settingsError.value =
      msg.includes("Failed to fetch") || msg.includes("unreachable")
        ? "Could not reach endpoint. Check Base URL and ensure the service is running."
        : `Failed to fetch models: ${msg}`;
  } finally {
    isFetchingModels.value = false;
  }
}

function applyCustomPreset(
  preset: "ollama" | "lmstudio" | "anthropic" | "openai" | "openrouter",
): void {
  if (preset === "ollama") {
    settingsForm.value.baseUrl = "http://localhost:11434/v1";
    if (
      !settingsForm.value.model ||
      settingsForm.value.model === "gpt-4o-mini"
    ) {
      settingsForm.value.model = "llama3.2";
    }
  } else if (preset === "lmstudio") {
    settingsForm.value.baseUrl = "http://localhost:1234/v1";
    if (
      !settingsForm.value.model ||
      settingsForm.value.model === "gpt-4o-mini"
    ) {
      settingsForm.value.model = "local-model";
    }
  } else if (preset === "anthropic") {
    settingsForm.value.baseUrl = "https://api.anthropic.com/v1";
    settingsForm.value.model = "claude-3-7-sonnet";
  } else if (preset === "openai") {
    settingsForm.value.baseUrl = "https://api.openai.com/v1";
    settingsForm.value.model = "gpt-4o-mini";
  } else if (preset === "openrouter") {
    settingsForm.value.baseUrl = "https://openrouter.ai/api/v1";
    settingsForm.value.model = "anthropic/claude-3.7-sonnet";
  }
}

async function saveSettings(): Promise<void> {
  const key = settingsForm.value.key.trim();
  const isLocalCustom =
    settingsForm.value.provider === "custom" &&
    isLocalUrl(settingsForm.value.baseUrl);
  if (!key && !savedAiKeyHint.value && !isLocalCustom) {
    settingsError.value =
      settingsForm.value.provider === "google"
        ? "Please enter your Google AI Studio API key."
        : "Please enter your API key.";
    if (settingsForm.value.provider === "google") {
      document.getElementById("settingsKey")?.focus();
    } else {
      document.getElementById("settingsCustomKey")?.focus();
    }
    return;
  }
  settingsError.value = "";
  try {
    const modelToSave =
      settingsForm.value.provider === "google"
        ? settingsForm.value.model.trim() || "gemini-3.8-flash"
        : settingsForm.value.model.trim() || "gpt-4o-mini";
    const saved = await window.ara.ai.setSettings({
      provider: settingsForm.value.provider,
      baseUrl: settingsForm.value.baseUrl.trim(),
      ...(key ? { key } : {}),
      model: modelToSave,
    });
    savedKeyHints.value = saved.keyHints;
    aiPushThreshold.value = Math.max(
      0,
      Math.min(400, Number(settingsForm.value.pushThreshold) || 0),
    );
    settingsForm.value.pushThreshold = aiPushThreshold.value;
    localStorage.setItem(
      "ara:ai-push-threshold",
      String(aiPushThreshold.value),
    );
    closeSettings();
    toast("AI settings saved.");
  } catch {
    toast("The settings could not be saved. Try again.");
  }
}

function closeDataset(): void {
  void confirmCloseDataset();
}

async function confirmCloseDataset(): Promise<void> {
  if (!state.ds.columns.length && !runsState.runs.length) return;
  if (
    !(await askConfirm(
      "Close the current dataset? Unsaved changes will be lost.",
    ))
  )
    return;
  // Fresh session: empty dataset, no filename, no undo, no results, fresh chat.
  state.ds = { columns: [], data: {} };
  state.filename = "";
  state.sample = false;
  state.view = "data";
  state.computedFormulas = [];
  clearHistory();
  runsState.runs = [];
  aiDock.value?.clear();
  resetAiAdvisorCache();
  toast("Dataset closed.");
}

/* Themed confirm dialog (replaces native window.confirm, which ignores app theming). */
const confirmState = ref<{
  message: string;
  resolve: (ok: boolean) => void;
} | null>(null);
const confirmDlg = ref<HTMLDialogElement | null>(null);
function askConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    confirmState.value = { message, resolve };
    void nextTick(() => confirmDlg.value?.showModal());
  });
}
function settleConfirm(ok: boolean): void {
  confirmState.value?.resolve(ok);
  confirmState.value = null;
}

async function confirmNewDataset(): Promise<void> {
  if (
    (rowCount.value || colCount.value) &&
    !(await askConfirm(
      "Replace the current dataset? Unsaved changes will be lost.",
    ))
  )
    return;
  setDataset({ columns: [], data: {} });
  state.filename = "";
  state.sample = false;
  aiDock.value?.clear();
  resetAiAdvisorCache();
  toast("New dataset created.");
}

async function act(id: string): Promise<void> {
  closeMenus();
  switch (id) {
    case "file-close":
      closeDataset();
      return;
    case "file-new":
      void confirmNewDataset();
      return;
    case "file-open":
    case "file-import": {
      try {
        const res = await openWithDialog(restoreRuns);
        if (res.kind !== "cancel") {
          aiDock.value?.clear();
          resetAiAdvisorCache();
          toast(`Loaded ${state.filename || "dataset"}.`);
        }
      } catch (err) {
        toast(ioMessage(err));
      }
      return;
    }
    case "file-save":
    case "file-save-as": {
      try {
        const saved = await saveWithDialog(snapshotRuns());
        if (saved) toast("Project saved.");
      } catch (err) {
        toast(ioMessage(err));
      }
      return;
    }
    case "data-paste": {
      try {
        const text = (await navigator.clipboard.readText()).trim();
        const rows = text.split(/\r?\n/).map((line) => line.split("\t"));
        if (!text || !rows.length) {
          toast("The clipboard is empty. Copy rows from a spreadsheet first.");
          return;
        }
        setDataset(datasetFromRows(rows[0], rows.slice(1)));
        aiDock.value?.clear();
        resetAiAdvisorCache();
        toast("Data pasted.");
      } catch {
        toast(
          "The clipboard could not be read. Copy the data first, then paste again.",
        );
      }
      return;
    }
    case "export-html":
      await exportHtml();
      return;
    case "results-copy-text": {
      await copyRunsFormatted(runsState.runs.filter((r) => r.revealed));
      return;
    }
    case "edit-undo":
      if (canUndo.value) undo();
      return;
    case "edit-redo":
      if (canRedo.value) redo();
      return;
    case "data-add-var":
      // Adds a column; available from both Data and Variable views.
      addColumn(defaultMeta(uniqueColumnName("col"), "numeric"));
      return;
    case "data-del-var": {
      const last = state.ds.columns[state.ds.columns.length - 1];
      if (last && deleteColumn()) toast(`Removed column ${last.name}.`);
      return;
    }
    case "data-add-case":
      if (!colCount.value)
        addColumn(defaultMeta(uniqueColumnName("col"), "numeric"));
      addRow();
      ensureView("data");
      return;
    case "data-del-case":
      if (rowCount.value && deleteRow()) {
        ensureView("data");
        toast("Removed last row.");
      }
      return;
    case "data-define-props":
      ensureView("variable");
      return;
    case "data-sort": {
      // Sort Rows: pick a column + order, rebuild the dataset.
      const name = window.prompt(
        `Sort rows by column (${state.ds.columns.map((c) => c.name).join(", ")})`,
        state.ds.columns[0]?.name ?? "",
      );
      if (!name || !state.ds.columns.some((c) => c.name === name)) return;
      const asc =
        (window.prompt("Order: A for ascending, D for descending", "A") ?? "A")
          .trim()
          .toUpperCase() !== "D";
      const order = state.ds.columns.map((c) => c.name);
      const idx = [...Array(rowCount.value).keys()].sort((a, b) => {
        const va = state.ds.data[name]?.[a] ?? null;
        const vb = state.ds.data[name]?.[b] ?? null;
        if (va === null && vb === null) return 0;
        if (va === null) return 1; // missing always sorts last, like SPSS
        if (vb === null) return -1;
        const cmp =
          typeof va === "number" && typeof vb === "number"
            ? va - vb
            : String(va).localeCompare(String(vb));
        return asc ? cmp : -cmp;
      });
      const data: Record<string, ColumnValues> = {};
      // SAFETY: the permutation maps each column onto its own values, so each
      // array keeps its column's element type; Cell[] is the widest view of it.
      for (const col of order)
        data[col] = (state.ds.data[col] ?? [])
          .map((_, r) => idx[r])
          .map(
            (i) => (state.ds.data[col] as Array<Cell>)[i] ?? null,
          ) as ColumnValues;
      setDataset({ columns: state.ds.columns.map((c) => ({ ...c })), data });
      toast(`Sorted by ${name} (${asc ? "ascending" : "descending"}).`);
      return;
    }
    case "transform-compute": {
      // Compute Column: "name = expression" (+ - * / ( ) and column names).
      // Shared CSP-safe evaluator: no eval/new Function; missing cells propagate per row.
      const formula = window.prompt(
        "Compute column, e.g.  total = pre_test + post_test",
      );
      if (!formula) return;
      const eq = formula.indexOf("=");
      if (eq < 1) {
        toast("Use the form  name = expression");
        return;
      }
      const target = formula.slice(0, eq).trim();
      const expr = formula.slice(eq + 1).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(target)) {
        toast(
          "The column name must start with a letter and use letters, digits, or underscores.",
        );
        return;
      }
      const tokens = tokenizeExpr(expr);
      if (!tokens.length) {
        toast("The expression may use column names, numbers, and + - * / ( ).");
        return;
      }
      const unknown = [
        ...new Set(tokens.filter((t) => /^[A-Za-z_]/.test(t))),
      ].filter((t) => !state.ds.columns.some((c) => c.name === t));
      if (unknown.length) {
        toast(`Unknown column in expression: ${unknown[0]}.`);
        return;
      }
      const values: Array<number | null> = [];
      // Parse probe with every column = 1: catches malformed input (1 +, 2 3,
      // a b) unconditionally, before any row is written. Real missing cells
      // still propagate to null per row inside the loop.
      const probeVars: Record<string, number | string | null> = {};
      for (const c of state.ds.columns) probeVars[c.name] = 1;
      if (evalExprTokens(tokens, probeVars) === null) {
        toast("The expression could not be parsed. Check the syntax.");
        return;
      }
      for (let r = 0; r < rowCount.value; r++) {
        const row: Record<string, number | string | null> = {};
        for (const c of state.ds.columns)
          row[c.name] = (state.ds.data[c.name] as Array<Cell>)[r] ?? null;
        const out = evalExprTokens(tokens, row);
        values.push(out === null || !Number.isFinite(out) ? null : out);
      }
      const existing = state.ds.columns.findIndex((c) => c.name === target);
      if (existing >= 0) {
        batchCells(values.map((v, r) => ({ col: target, row: r, next: v })));
      } else {
        const meta = defaultMeta(target, "numeric");
        commit({ t: "colAdd", index: state.ds.columns.length, meta, values });
        state.computedFormulas.push(`${target} = ${expr}`);
      }
      toast(`Computed ${target}.`);
      return;
    }
    case "transform-fill": {
      // Fill missing: prompt column + method; one batchCells commit = one undo.
      const name = window.prompt(
        `Fill missing in column (${state.ds.columns.map((c) => c.name).join(", ")})`,
        state.ds.columns[0]?.name ?? "",
      );
      if (!name) return;
      const meta = state.ds.columns.find((c) => c.name === name);
      if (!meta) {
        toast(`No column named ${name}.`);
        return;
      }
      const raw = (
        window.prompt(
          "Method: mean, median, or mode",
          meta.type === "numeric" ? "mean" : "mode",
        ) ?? ""
      )
        .trim()
        .toLowerCase();
      if (raw !== "mean" && raw !== "median" && raw !== "mode") {
        toast("Use mean, median, or mode.");
        return;
      }
      // SAFETY: validated against the three literals above; the cast only names it.
      const method = raw as FillMode;
      if (method !== "mode" && meta.type !== "numeric") {
        toast("Mean and median need a numeric column. Use mode.");
        return;
      }
      const vals = (state.ds.data[name] as Array<Cell>) ?? [];
      const fill = computeFill(vals, method, (v) => isUserMissing(meta, v));
      if (fill === null) {
        toast(
          `No fill value: ${name} has no valid values, or the mode is tied.`,
        );
        return;
      }
      const edits: Array<{ col: string; row: number; next: Cell }> = [];
      vals.forEach((v, row) => {
        if (isUserMissing(meta, v)) edits.push({ col: name, row, next: fill });
      });
      if (!edits.length) {
        toast(`${name} has no missing values.`);
        return;
      }
      batchCells(edits);
      toast(
        `Filled ${edits.length} missing in ${name} (${method} = ${String(fill)}).`,
      );
      return;
    }
    case "transform-log":
    case "transform-standardize":
    case "transform-bin": {
      // Phase 3.2: new derived column right after the source, original untouched.
      // transformColumn() does ONE colAdd commit = one undo; log refuses on
      // non-positive valid values (nothing written) and returns a counted message.
      const nums = state.ds.columns.filter((c) => c.type === "numeric");
      if (!nums.length) {
        toast("No numeric columns to transform.");
        return;
      }
      const name = window.prompt(
        `Transform column (${nums.map((c) => c.name).join(", ")})`,
        nums[0]?.name ?? "",
      );
      if (!name) return;
      const meta = state.ds.columns.find((c) => c.name === name);
      if (!meta) {
        toast(`No column named ${name}.`);
        return;
      }
      let bins = 5;
      if (id === "transform-bin") {
        const raw = window.prompt("Number of bins (2-20)", "5");
        if (raw === null) return;
        bins = Math.floor(Number(raw));
        if (!Number.isFinite(bins) || bins < 2 || bins > 20) {
          toast("Bins must be a whole number from 2 to 20.");
          return;
        }
      }
      const kind =
        id === "transform-log"
          ? "log"
          : id === "transform-standardize"
            ? "standardize"
            : "bin";
      const res = transformColumn(name, kind, { bins });
      toast(res.message);
      return;
    }
    case "data-drop-missing": {
      // Drop rows with missing: prompt columns (blank = all); one setDataset = one undo.
      const answer = window.prompt(
        `Drop rows missing in columns, comma separated (blank = all columns): ${state.ds.columns.map((c) => c.name).join(", ")}`,
        "",
      );
      if (answer === null) return;
      const picked = answer
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const cols = picked.length ? picked : state.ds.columns.map((c) => c.name);
      const unknown = cols.find(
        (n) => !state.ds.columns.some((c) => c.name === n),
      );
      if (unknown) {
        toast(`No column named ${unknown}.`);
        return;
      }
      if (!rowCount.value) {
        toast("No rows to drop.");
        return;
      }
      const data = state.ds.data as Record<string, Array<Cell>>;
      const drop = new Set(
        rowsWithMissing(data, cols, (col, v) => {
          const m = state.ds.columns.find((c) => c.name === col);
          return m ? isUserMissing(m, v) : v === null;
        }),
      );
      if (!drop.size) {
        toast("No rows with missing values.");
        return;
      }
      const kept: Record<string, ColumnValues> = {};
      for (const c of state.ds.columns)
        kept[c.name] = ((state.ds.data[c.name] as Array<Cell>) ?? []).filter(
          (_, r) => !drop.has(r),
        ) as ColumnValues;
      setDataset({
        columns: state.ds.columns.map((c) => ({ ...c })),
        data: kept,
      });
      toast(
        `Dropped ${drop.size} row${drop.size === 1 ? "" : "s"} with missing values.`,
      );
      return;
    }
    case "transform-recode-same":
    case "transform-recode-diff":
    case "edit-find":
      toast("Available in a later build. Use Compute or Sort meanwhile.");
      return;
    default:
      toast("Available in the v1 build");
  }
}

/* ---------- About dialog ---------- */
const aboutOpen = ref(false);
const aboutDlg = ref<HTMLDialogElement | null>(null);
function openAbout(): void {
  closeMenus();
  aboutOpen.value = true;
  void nextTick(() => aboutDlg.value?.showModal());
}
function closeAbout(): void {
  aboutDlg.value?.close();
  aboutOpen.value = false;
}

// ::backdrop clicks retarget to the <dialog> element; the rect check keeps
// border clicks inside the card from closing it.
function onDialogBackdrop(e: MouseEvent, el: HTMLDialogElement | null): void {
  if (!el || e.target !== el) return;
  const r = el.getBoundingClientRect();
  if (
    e.clientX < r.left ||
    e.clientX > r.right ||
    e.clientY < r.top ||
    e.clientY > r.bottom
  )
    el.close();
}

/* ---------- Menus Behavior ---------- */
const activeMenu = ref<string | null>(null);
const isMenuBarActive = ref(false);
const MENU_LIST = ["file", "edit", "data", "transform", "visualize", "analyze"];
const openSub = ref<string | null>(null);

type MenuName = (typeof MENU_LIST)[number];

function openMenu(name: MenuName): void {
  activeMenu.value = name;
  isMenuBarActive.value = true;
  openSub.value = null;
}

function toggleSub(name: string): void {
  openSub.value = openSub.value === name ? null : name;
}

function toggleMenu(name: string): void {
  if (activeMenu.value === name) {
    closeMenus();
  } else {
    openMenu(name);
  }
}

function onMenuMouseEnter(name: string): void {
  if (isMenuBarActive.value && activeMenu.value !== name) {
    openMenu(name);
  }
}

function closeMenus(): void {
  activeMenu.value = null;
  isMenuBarActive.value = false;
  openSub.value = null;
  for (const s of Array.from(
    rootEl.value?.querySelectorAll(".dd-sub.open") ?? [],
  )) {
    s.classList.remove("open");
    s.querySelector(":scope > .dd-row")?.setAttribute("aria-expanded", "false");
  }
}

function menuKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    if (activeMenu.value) {
      e.preventDefault();
      closeMenus();
    }
    return;
  }
  if (!activeMenu.value) return;

  const curIdx = MENU_LIST.indexOf(activeMenu.value);
  if (e.key === "ArrowRight") {
    const row = document.activeElement as HTMLElement | null;
    const sub = row?.closest<HTMLElement>(".dd-sub");
    if (
      sub &&
      openSub.value !== sub.dataset.sub &&
      row?.parentElement === sub
    ) {
      e.preventDefault();
      openSub.value = sub.dataset.sub ?? null;
      sub.querySelector<HTMLElement>(":scope > .dropdown > .dd-row")?.focus();
      return;
    }
    if (curIdx >= 0) {
      e.preventDefault();
      activeMenu.value = MENU_LIST[(curIdx + 1) % MENU_LIST.length];
    }
  } else if (e.key === "ArrowLeft") {
    const row = document.activeElement as HTMLElement | null;
    const sub = row?.closest<HTMLElement>(".dd-sub");
    if (
      sub &&
      openSub.value === sub.dataset.sub &&
      sub.querySelector(":scope > .dropdown")?.contains(row)
    ) {
      e.preventDefault();
      openSub.value = null;
      sub.querySelector<HTMLElement>(":scope > .dd-row")?.focus();
      return;
    }
    if (curIdx >= 0) {
      e.preventDefault();
      activeMenu.value =
        MENU_LIST[(curIdx - 1 + MENU_LIST.length) % MENU_LIST.length];
    }
  }
}

function onWindowKeydown(e: KeyboardEvent): void {
  menuKeydown(e);
  if (e.defaultPrevented) return;
  const t = e.target as HTMLElement | null;
  if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
  if (!e.ctrlKey) return;
  const k = e.key.toLowerCase();
  if (k === "n") {
    e.preventDefault();
    void act("file-new");
  } else if (k === "o") {
    e.preventDefault();
    void act("file-open");
  } else if (k === "s") {
    e.preventDefault();
    void act("file-save");
  } else if (k === "z") {
    e.preventDefault();
    void act("edit-undo");
  } else if (k === "y") {
    e.preventDefault();
    void act("edit-redo");
  } else if (k === "j") {
    e.preventDefault();
    toggleResults();
  } else if (k === "tab") {
    e.preventDefault();
    ensureView(state.view === "data" ? "variable" : "data");
  } else if (e.key === ",") {
    e.preventDefault();
    void openSettings();
  }
}

/** Disposers for bridge subscriptions; cleared in `onBeforeUnmount`. */
const disposers: Array<() => void> = [];

/** AI narrative note insertion (custom event from AiDock). */
function onInsertNarrativeNote(e: Event): void {
  const detail = (e as CustomEvent<{ runId: string; text: string }>).detail;
  if (!detail) return;
  const run = runsState.runs.find((r) => r.runId === detail.runId);
  if (!run) return;
  const cleanText = detail.text
    .replace(
      /^(?:(?:\*\*)?(?:APA(?:\s*7th)?\s*)?(?:Narrative\s*)?Interpretation(?:\*\*)?[:\s\-–—]*)/i,
      "",
    )
    .trim();
  run.elements.push({
    kind: "note",
    status: "ok",
    text: cleanText,
    address: `note:narrative:${Date.now()}`,
  });
}

/** Clicking anywhere outside the menubar closes any open menu. */
function onWindowClick(e: MouseEvent): void {
  const target = e.target as HTMLElement | null;
  if (!target?.closest(".titlebar-menu")) closeMenus();
}

onMounted(() => {
  // Initialize theme from storage or system
  const saved = localStorage.getItem("ara:theme") as Theme | null;
  const sysDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  applyTheme(saved || (sysDark ? "dark" : "light"));

  // Listen to window state changes
  if (window.ara?.window) {
    void window.ara.window.isMaximized().then((max) => {
      isMaximized.value = max;
    });
    disposers.push(
      window.ara.window.onStateChanged((max) => {
        isMaximized.value = max;
      }),
    );
  }

  // Handle narrative note insertion from AI
  window.addEventListener("ara:insert-narrative-note", onInsertNarrativeNote);
  window.addEventListener("click", onWindowClick);
  window.addEventListener("keydown", onWindowKeydown);
  disposers.push(window.ara.engine.onNotification(applyNotification));
});

// Every listener registered on mount is released here: leaving one attached
// duplicates analysis output and click handling across HMR reloads.
onBeforeUnmount(() => {
  window.removeEventListener("ara:insert-narrative-note", onInsertNarrativeNote);
  window.removeEventListener("click", onWindowClick);
  window.removeEventListener("keydown", onWindowKeydown);
  for (const dispose of disposers.splice(0)) dispose();
});
</script>

<template>
  <div ref="rootEl" class="app-root">
    <!-- ====================================================================
         1. CUSTOM FRAMELESS TITLEBAR (ARA OFFICE CHROME)
         ==================================================================== -->
    <header class="app-titlebar" data-tauri-drag-region aria-label="Application header">
      <div class="titlebar-left">
        <!-- Logo with transparent background (dark & light theme variants) -->
        <img
          class="tab-brand-logo tab-brand-logo-dark"
          src="/ARAStat.png"
          alt="ARAStat"
        />
        <img
          class="tab-brand-logo tab-brand-logo-light"
          src="/ARAStat_light.png"
          alt="ARAStat"
        />

        <!-- Integrated Menubar -->
        <nav class="titlebar-menu" aria-label="Application menu">
          <!-- File Menu -->
          <div class="menu-item" :class="{ open: activeMenu === 'file' }">
            <button
              class="menu-btn"
              aria-haspopup="menu"
              :aria-expanded="activeMenu === 'file'"
              @click.stop="toggleMenu('file')"
              @mouseenter="onMenuMouseEnter('file')"
            >
              File
            </button>
            <div class="dropdown" role="menu" aria-label="File">
              <button
                class="dd-row"
                role="menuitem"
                @click.stop="act('file-new')"
              >
                New dataset<span class="hint">Ctrl+N</span>
              </button>
              <button
                class="dd-row"
                role="menuitem"
                @click.stop="act('file-open')"
              >
                Open<span class="hint">Ctrl+O</span>
              </button>
              <div class="dd-sep"></div>
              <button
                class="dd-row"
                role="menuitem"
                @click.stop="act('file-save')"
              >
                Save<span class="hint">Ctrl+S</span>
              </button>
              <button
                class="dd-row"
                role="menuitem"
                @click.stop="act('file-save-as')"
              >
                Save as
              </button>
              <button
                class="dd-row"
                role="menuitem"
                @click.stop="act('export-html')"
              >
                Export results as HTML
              </button>
              <div class="dd-sep"></div>
              <button
                class="dd-row"
                role="menuitem"
                @click.stop="act('file-close')"
              >
                Close
              </button>
            </div>
          </div>

          <!-- Edit Menu -->
          <div class="menu-item" :class="{ open: activeMenu === 'edit' }">
            <button
              class="menu-btn"
              aria-haspopup="menu"
              :aria-expanded="activeMenu === 'edit'"
              @click.stop="toggleMenu('edit')"
              @mouseenter="onMenuMouseEnter('edit')"
            >
              Edit
            </button>
            <div class="dropdown" role="menu" aria-label="Edit">
              <button
                class="dd-row"
                role="menuitem"
                :disabled="!canUndo"
                @click.stop="act('edit-undo')"
              >
                <span class="menu-icon" aria-hidden="true">↶</span
                ><span>Undo</span><span class="hint">Ctrl+Z</span>
              </button>
              <button
                class="dd-row"
                role="menuitem"
                :disabled="!canRedo"
                @click.stop="act('edit-redo')"
              >
                <span class="menu-icon" aria-hidden="true">↷</span
                ><span>Redo</span><span class="hint">Ctrl+Y</span>
              </button>
              <div class="dd-sep"></div>
              <button
                class="dd-row"
                role="menuitem"
                @click.stop="act('data-paste')"
              >
                Paste data from clipboard
              </button>
              <button
                class="dd-row"
                role="menuitem"
                @click.stop="act('edit-find')"
              >
                Find in data
              </button>
            </div>
          </div>

          <!-- Data Menu -->
          <div class="menu-item" :class="{ open: activeMenu === 'data' }">
            <button
              class="menu-btn"
              aria-haspopup="menu"
              :aria-expanded="activeMenu === 'data'"
              @click.stop="toggleMenu('data')"
              @mouseenter="onMenuMouseEnter('data')"
            >
              Data
            </button>
            <div class="dropdown" role="menu" aria-label="Data">
              <button
                class="dd-row"
                role="menuitem"
                @click.stop="openHealthAdvisor()"
              >
                <span class="menu-icon" aria-hidden="true">✨</span>
                <strong>Data Health Advisor</strong>
              </button>
              <div class="dd-sep"></div>
              <button
                class="dd-row"
                role="menuitem"
                @click.stop="act('data-add-var')"
              >
                Add column
              </button>
              <button
                class="dd-row"
                role="menuitem"
                @click.stop="act('data-add-case')"
              >
                Add row
              </button>
              <button
                class="dd-row"
                role="menuitem"
                :disabled="!colCount"
                @click.stop="act('data-del-var')"
              >
                Remove column
              </button>
              <button
                class="dd-row"
                role="menuitem"
                :disabled="!rowCount"
                @click.stop="act('data-del-case')"
              >
                Remove row
              </button>
              <div class="dd-sep"></div>
              <button
                class="dd-row"
                role="menuitem"
                @click.stop="act('data-sort')"
              >
                Sort rows...
              </button>
              <button
                class="dd-row"
                role="menuitem"
                @click.stop="act('data-drop-missing')"
              >
                Drop rows with missing...
              </button>
              <div class="dd-sep"></div>
              <button
                class="dd-row"
                role="menuitem"
                @click.stop="
                  ensureView(state.view === 'data' ? 'variable' : 'data')
                "
              >
                {{
                  state.view === "data"
                    ? "Switch to Variable View"
                    : "Switch to Data View"
                }}<span class="hint">Ctrl+Tab</span>
              </button>
            </div>
          </div>

          <!-- Transform Menu -->
          <div class="menu-item" :class="{ open: activeMenu === 'transform' }">
            <button
              class="menu-btn"
              aria-haspopup="menu"
              :aria-expanded="activeMenu === 'transform'"
              @click.stop="toggleMenu('transform')"
              @mouseenter="onMenuMouseEnter('transform')"
            >
              Transform
            </button>
            <div class="dropdown" role="menu" aria-label="Transform">
              <button
                class="dd-row"
                role="menuitem"
                @click.stop="act('transform-compute')"
              >
                Compute column...
              </button>
              <button
                class="dd-row"
                role="menuitem"
                @click.stop="act('transform-fill')"
              >
                Fill missing values...
              </button>
              <div class="dd-sep"></div>
              <button
                class="dd-row"
                role="menuitem"
                @click.stop="act('transform-log')"
              >
                Log transform (new column)...
              </button>
              <button
                class="dd-row"
                role="menuitem"
                @click.stop="act('transform-standardize')"
              >
                Standardize (new column)...
              </button>
              <button
                class="dd-row"
                role="menuitem"
                @click.stop="act('transform-bin')"
              >
                Bin into groups (new column)...
              </button>
              <div class="dd-sep"></div>
              <button
                class="dd-row"
                role="menuitem"
                @click.stop="act('transform-recode-same')"
              >
                Recode into same column
              </button>
              <button
                class="dd-row"
                role="menuitem"
                @click.stop="act('transform-recode-diff')"
              >
                Recode into different column
              </button>
            </div>
          </div>

          <!-- Visualize Menu (Flat, clean, no redundant nested Charts submenu) -->
          <div class="menu-item" :class="{ open: activeMenu === 'visualize' }">
            <button
              class="menu-btn"
              aria-haspopup="menu"
              :aria-expanded="activeMenu === 'visualize'"
              @click.stop="toggleMenu('visualize')"
              @mouseenter="onMenuMouseEnter('visualize')"
            >
              Visualize
            </button>
            <div class="dropdown" role="menu" aria-label="Visualize">
              <button
                class="dd-row"
                role="menuitem"
                @click.stop="openVisualize('scatter')"
              >
                Scatter plot
              </button>
              <button
                class="dd-row"
                role="menuitem"
                @click.stop="openVisualize('bar')"
              >
                Bar chart
              </button>
              <button
                class="dd-row"
                role="menuitem"
                @click.stop="openVisualize('line')"
              >
                Line chart
              </button>
              <button
                class="dd-row"
                role="menuitem"
                @click.stop="openVisualize('histogram')"
              >
                Histogram
              </button>
            </div>
          </div>

          <!-- Analyze Menu (Simplified grouping by function) -->
          <div class="menu-item" :class="{ open: activeMenu === 'analyze' }">
            <button
              class="menu-btn"
              aria-haspopup="menu"
              :aria-expanded="activeMenu === 'analyze'"
              @click.stop="toggleMenu('analyze')"
              @mouseenter="onMenuMouseEnter('analyze')"
            >
              Analyze
            </button>
            <div class="dropdown" role="menu" aria-label="Analyze">
              <button
                class="dd-row"
                role="menuitem"
                @click.stop="openTestAdvisor()"
              >
                <span class="menu-icon" aria-hidden="true">✨</span>
                <strong>Statistical Test Advisor</strong>
              </button>
              <div class="dd-sep"></div>
              <button
                class="dd-row"
                role="menuitem"
                @click.stop="openAnalysis('descriptives')"
              >
                Descriptives
              </button>
              <button
                class="dd-row"
                role="menuitem"
                @click.stop="openAnalysis('frequencies')"
              >
                Frequencies
              </button>
              <div class="dd-sep"></div>
              <div
                class="dd-sub"
                data-sub="ttests"
                :class="{ open: openSub === 'ttests' }"
                @mouseenter="openSub = 'ttests'"
                @mouseleave="openSub = null"
              >
                <button
                  class="dd-row"
                  role="menuitem"
                  aria-haspopup="menu"
                  :aria-expanded="openSub === 'ttests'"
                  @click.stop="toggleSub('ttests')"
                >
                  T-Tests
                </button>
                <div class="dropdown" role="menu" aria-label="T-Tests">
                  <button
                    class="dd-row"
                    role="menuitem"
                    @click.stop="openAnalysis('ttest_onesample')"
                  >
                    One-sample
                  </button>
                  <button
                    class="dd-row"
                    role="menuitem"
                    @click.stop="openAnalysis('ttest_independent')"
                  >
                    Independent
                  </button>
                  <button
                    class="dd-row"
                    role="menuitem"
                    @click.stop="openAnalysis('ttest_paired')"
                  >
                    Paired
                  </button>
                </div>
              </div>
              <div
                class="dd-sub"
                data-sub="anova"
                :class="{ open: openSub === 'anova' }"
                @mouseenter="openSub = 'anova'"
                @mouseleave="openSub = null"
              >
                <button
                  class="dd-row"
                  role="menuitem"
                  aria-haspopup="menu"
                  :aria-expanded="openSub === 'anova'"
                  @click.stop="toggleSub('anova')"
                >
                  ANOVA
                </button>
                <div class="dropdown" role="menu" aria-label="ANOVA">
                  <button
                    class="dd-row"
                    role="menuitem"
                    @click.stop="openAnalysis('anova_oneway')"
                  >
                    One-way
                  </button>
                  <button
                    class="dd-row"
                    role="menuitem"
                    @click.stop="openAnalysis('welch_anova')"
                  >
                    Welch
                  </button>
                  <button
                    class="dd-row"
                    role="menuitem"
                    @click.stop="openAnalysis('tukey_hsd')"
                  >
                    Tukey HSD
                  </button>
                  <button
                    class="dd-row"
                    role="menuitem"
                    @click.stop="openAnalysis('factorial_anova_2way')"
                  >
                    Factorial (2-way)
                  </button>
                </div>
              </div>
              <div
                class="dd-sub"
                data-sub="correlation"
                :class="{ open: openSub === 'correlation' }"
                @mouseenter="openSub = 'correlation'"
                @mouseleave="openSub = null"
              >
                <button
                  class="dd-row"
                  role="menuitem"
                  aria-haspopup="menu"
                  :aria-expanded="openSub === 'correlation'"
                  @click.stop="toggleSub('correlation')"
                >
                  Correlation
                </button>
                <div class="dropdown" role="menu" aria-label="Correlation">
                  <button
                    class="dd-row"
                    role="menuitem"
                    @click.stop="openAnalysis('correlation')"
                  >
                    Pearson
                  </button>
                  <button
                    class="dd-row"
                    role="menuitem"
                    @click.stop="openAnalysis('kendall_tau')"
                  >
                    Kendall tau
                  </button>
                </div>
              </div>
              <div
                class="dd-sub"
                data-sub="regression"
                :class="{ open: openSub === 'regression' }"
                @mouseenter="openSub = 'regression'"
                @mouseleave="openSub = null"
              >
                <button
                  class="dd-row"
                  role="menuitem"
                  aria-haspopup="menu"
                  :aria-expanded="openSub === 'regression'"
                  @click.stop="toggleSub('regression')"
                >
                  Regression
                </button>
                <div class="dropdown" role="menu" aria-label="Regression">
                  <button
                    class="dd-row"
                    role="menuitem"
                    @click.stop="openAnalysis('linear_regression')"
                  >
                    Linear
                  </button>
                  <button
                    class="dd-row"
                    role="menuitem"
                    @click.stop="openAnalysis('logistic_regression')"
                  >
                    Logistic
                  </button>
                </div>
              </div>
              <div
                class="dd-sub"
                data-sub="chisq"
                :class="{ open: openSub === 'chisq' }"
                @mouseenter="openSub = 'chisq'"
                @mouseleave="openSub = null"
              >
                <button
                  class="dd-row"
                  role="menuitem"
                  aria-haspopup="menu"
                  :aria-expanded="openSub === 'chisq'"
                  @click.stop="toggleSub('chisq')"
                >
                  Chi-Square
                </button>
                <div class="dropdown" role="menu" aria-label="Chi-Square">
                  <button
                    class="dd-row"
                    role="menuitem"
                    @click.stop="openAnalysis('chisq_independence')"
                  >
                    Independence
                  </button>
                  <button
                    class="dd-row"
                    role="menuitem"
                    @click.stop="openAnalysis('chisq_gof')"
                  >
                    Goodness-of-fit
                  </button>
                  <button
                    class="dd-row"
                    role="menuitem"
                    @click.stop="openAnalysis('fisher_exact_2x2')"
                  >
                    Fisher exact
                  </button>
                  <button
                    class="dd-row"
                    role="menuitem"
                    @click.stop="openAnalysis('mcnemar')"
                  >
                    McNemar
                  </button>
                </div>
              </div>
              <div
                class="dd-sub"
                data-sub="nonparam"
                :class="{ open: openSub === 'nonparam' }"
                @mouseenter="openSub = 'nonparam'"
                @mouseleave="openSub = null"
              >
                <button
                  class="dd-row"
                  role="menuitem"
                  aria-haspopup="menu"
                  :aria-expanded="openSub === 'nonparam'"
                  @click.stop="toggleSub('nonparam')"
                >
                  Nonparametric
                </button>
                <div class="dropdown" role="menu" aria-label="Nonparametric">
                  <button
                    class="dd-row"
                    role="menuitem"
                    @click.stop="openAnalysis('mannwhitney_u')"
                  >
                    Mann-Whitney U
                  </button>
                  <button
                    class="dd-row"
                    role="menuitem"
                    @click.stop="openAnalysis('wilcoxon_signedrank')"
                  >
                    Wilcoxon signed-rank
                  </button>
                  <button
                    class="dd-row"
                    role="menuitem"
                    @click.stop="openAnalysis('wilcoxon_one_sample')"
                  >
                    Wilcoxon one-sample
                  </button>
                  <button
                    class="dd-row"
                    role="menuitem"
                    @click.stop="openAnalysis('kruskal_wallis')"
                  >
                    Kruskal-Wallis
                  </button>
                  <button
                    class="dd-row"
                    role="menuitem"
                    @click.stop="openAnalysis('friedman')"
                  >
                    Friedman
                  </button>
                  <button
                    class="dd-row"
                    role="menuitem"
                    @click.stop="openAnalysis('binomial')"
                  >
                    Binomial
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- About -->
          <div class="menu-item">
            <button class="menu-btn" type="button" @click="openAbout">
              About
            </button>
          </div>
        </nav>
      </div>

      <!-- Right Window Controls & Theme Toggle (Dataset badge moved to footer) -->
      <div class="titlebar-right">
        <div class="titlebar-actions">
          <!-- Theme Toggle -->
          <button
            class="icon-btn"
            type="button"
            :title="
              theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
            "
            @click="toggleTheme"
          >
            <svg
              v-if="theme === 'dark'"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <circle cx="12" cy="12" r="5"></circle>
              <line x1="12" y1="1" x2="12" y2="3"></line>
              <line x1="12" y1="21" x2="12" y2="23"></line>
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
              <line x1="1" y1="12" x2="3" y2="12"></line>
              <line x1="21" y1="12" x2="23" y2="12"></line>
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
            </svg>
            <svg
              v-else
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"></path>
            </svg>
          </button>
        </div>

        <!-- Windows Native Window Controls -->
        <div v-if="isWindows" class="window-controls">
          <button
            class="win-control"
            type="button"
            aria-label="Minimize"
            @click="minimizeWindow"
          >
            <span class="glyph-min"></span>
          </button>
          <button
            class="win-control"
            type="button"
            :aria-label="isMaximized ? 'Restore' : 'Maximize'"
            @click="toggleMaximizeWindow"
          >
            <span :class="isMaximized ? 'glyph-restore' : 'glyph-max'"></span>
          </button>
          <button
            class="win-control win-close"
            type="button"
            aria-label="Close"
            @click="closeWindow"
          >
            <span class="glyph-close"></span>
          </button>
        </div>
      </div>
    </header>

    <!-- ====================================================================
         3. WORKSPACE: THREE-PANE LAYOUT
         ==================================================================== -->
    <div class="workspace" :class="{ 'is-resizing': isResizingPanes }">
      <section
        class="pane-data"
        :style="paneDataStyle"
        aria-label="Data editor"
      >
        <div class="pane-header data-header">
          <!-- View Switcher Tabs (Segmented Control: Clear Active State) -->
          <div
            class="view-segmented-tabs"
            role="tablist"
            aria-label="Editor View"
            @keydown="viewTabKeyNav"
          >
            <button
              class="view-tab-btn"
              :class="{ 'is-active': state.view === 'data' }"
              type="button"
              role="tab"
              :aria-selected="state.view === 'data'"
              aria-controls="editor-panel"
              title="Data View (Ctrl+Tab to switch)"
              @click="ensureView('data')"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="3" y1="9" x2="21" y2="9" />
                <line x1="9" y1="21" x2="9" y2="9" />
              </svg>
              <span>Data View</span>
            </button>
            <button
              class="view-tab-btn"
              :class="{ 'is-active': state.view === 'variable' }"
              type="button"
              role="tab"
              :aria-selected="state.view === 'variable'"
              aria-controls="editor-panel"
              title="Variable View (Ctrl+Tab to switch)"
              @click="ensureView('variable')"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <line x1="4" y1="6" x2="20" y2="6" />
                <line x1="4" y1="12" x2="20" y2="12" />
                <line x1="4" y1="18" x2="20" y2="18" />
              </svg>
              <span>Variable View</span>
            </button>
          </div>

          <div class="spacer"></div>
          <span v-if="state.sample" class="demo-label">Sample data</span>
          <button
            v-if="state.view === 'data'"
            class="chip-btn"
            type="button"
            title="Add new row (Data > Add row)"
            @click="act('data-add-case')"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.4"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>Row</span>
          </button>
          <button
            v-if="state.view === 'variable'"
            class="chip-btn"
            type="button"
            title="Add new variable (Data > Add column)"
            @click="act('data-add-var')"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.4"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>Variable</span>
          </button>
          <button
            class="chip-btn icon-only"
            type="button"
            :disabled="!canUndo"
            :title="undoTip"
            aria-label="Undo"
            @click="act('edit-undo')"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M9 14 4 9l5-5" />
              <path d="M4 9h10a6 6 0 0 1 0 12h-1" />
            </svg>
          </button>
          <button
            class="chip-btn icon-only"
            type="button"
            :disabled="!canRedo"
            :title="redoTip"
            aria-label="Redo"
            @click="act('edit-redo')"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="m15 14 5-5-5-5" />
              <path d="M20 9H10a6 6 0 0 0 0 12h1" />
            </svg>
          </button>
        </div>
        <div
          v-if="!isEmpty"
          id="editor-panel"
          class="grid-wrap"
          role="tabpanel"
        >
          <DataGrid v-if="state.view === 'data'" />
          <VariableView
            v-else
            @plot="(col) => openVisualize('histogram', col)"
            @ask-ai="onAskAi"
            @open-analysis="(id, opts) => openAnalysis(id, opts)"
            @open-test-advisor="(vars) => openTestAdvisor(vars)"
            @open-advisor="(col) => openHealthAdvisor(col || '')"
          />
        </div>
        <div v-else class="empty-state">
          <svg width="40" height="30" viewBox="0 0 40 30" aria-hidden="true">
            <rect
              x="1"
              y="1"
              width="38"
              height="28"
              rx="2"
              fill="none"
              stroke="currentColor"
            />
            <path d="M1 8h38M13 8v21M26 8v21" stroke="currentColor" />
          </svg>
          <p>No data yet. Enter rows or import a .sav, .csv, or .xlsx file.</p>
          <div class="es-actions">
            <button
              class="btn btn-primary"
              type="button"
              @click="act('file-import')"
            >
              Import Data
            </button>
            <button class="btn" type="button" @click="act('data-paste')">
              Paste
            </button>
          </div>
        </div>
      </section>

      <!-- Collapsed Result View rail (parity with AI rail) -->
      <button
        v-if="!showResults"
        class="results-rail"
        type="button"
        title="Open Result View (Ctrl+J)"
        aria-label="Open Result View"
        @click="showResults = true"
      >
        <span class="results-rail-icon" aria-hidden="true">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path
              d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
            />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
        </span>
        <span class="results-rail-label">RESULTS</span>
      </button>

      <!-- Draggable Splitter between Data/Column pane and Result View -->
      <div
        v-if="showResults"
        class="pane-splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Data and Results panes"
        @pointerdown="startSplitterResize"
      >
        <div class="splitter-handle"></div>
      </div>
      <div v-if="stuckHintVisible" class="stuck-push-hint" role="status">
        Push further to minimize the assistant
      </div>

      <ResultsPane
        v-if="showResults"
        :style="paneResultsStyle"
        @export-html="act('export-html')"
        @copy-text="act('results-copy-text')"
        @copy-run="copyRun"
        @fix-options="fixOptions"
        @explain-run="onExplainRun"
        @close="showResults = false"
        @close-run="closeRun"
      />

      <AiDock
        ref="aiDock"
        @edit-options="(p) => openAnalysis(p.analysis, p.options)"
        @open-settings="openSettings"
        @visualize="onAiVisualize"
        @toast="toast"
        @status-change="
          (s) => {
            aiStatus = s;
          }
        "
        @open-change="
          (o) => {
            aiDockOpen = o;
          }
        "
      />
    </div>

    <!-- ====================================================================
         4. STATUS BAR
         ==================================================================== -->
    <footer class="app-footer" aria-label="ARAStat status bar">
      <div class="footer-left">
        <div
          class="status-indicator"
          title="Statistical computation engine status (100% offline & local)"
        >
          <span class="status-dot"></span>
          <span>ARA Engine</span>
        </div>
        <div class="footer-divider" role="separator"></div>
        <div
          class="status-indicator"
          :title="`ARA Assistant: ${aiStatusText}`"
          @click="openSettings"
        >
          <span class="status-dot" :class="aiStatusDotClass"></span>
          <span>ARA Assistant</span>
        </div>
        <div class="footer-divider" role="separator"></div>
        <div
          class="status-indicator dataset-status-indicator"
          :title="
            state.filename
              ? `Dataset loaded: ${cleanFilename}`
              : 'Dataset: Active editor'
          "
        >
          <span class="status-dot" :class="{ 'is-empty': isEmpty }"></span>
          <span>Dataset</span>
        </div>
      </div>
      <div class="footer-center">
        <div
          class="dataset-filename-center"
          :title="
            state.filename
              ? `Current file: ${cleanFilename} (${rowCount} rows, ${colCount} columns)`
              : 'New unsaved dataset'
          "
        >
          <span class="dataset-filename-text">{{ cleanFilename }}</span>
          <span v-if="!isEmpty" class="dataset-count-hint"
            >&bull; {{ rowCount.toLocaleString() }} rows,
            {{ colCount.toLocaleString() }} cols</span
          >
        </div>
      </div>
      <div class="footer-right">
        <span
          >ARAStat by
          <a
            href="https://adhirahmadian.id"
            target="_blank"
            rel="noopener noreferrer"
            class="footer-author-link"
            @click.prevent="openAuthorLink"
            >Adhi Rahmadian</a
          ></span
        >
      </div>
    </footer>

    <!-- Modals -->
    <AnalysisDialog
      v-if="dlgSchema"
      :schema="dlgSchema"
      :initial="dlgInitial"
      @close="dlgSchema = null"
      @run="onDialogRun"
    />

    <!-- Statistical Test Advisor Dialog -->
    <TestAdvisorDialog
      v-model="testAdvisorOpen"
      :initial-vars="testAdvisorVars"
      @open-analysis="(id, opts) => openAnalysis(id, opts)"
    />

    <!-- Data Health & Advisor Dialog (single host: menu + Variable View entry points) -->
    <AiMissingAdvisorDialog
      v-model="healthOpen"
      :focus-var="healthFocusVar"
      @plot="(col) => openVisualize('histogram', col)"
      @open-analysis="(id, opts) => openAnalysis(id, opts)"
      @open-test-advisor="(vars) => openTestAdvisor(vars)"
    />

    <!-- Post-restart changelog (shown once when the updater flags a version bump) -->
    <UpdateRestartModal />

    <!-- AI Settings Dialog (Refined Provider & Settings Layout) -->
    <dialog
      v-if="settingsOpen"
      ref="settingsDlg"
      aria-labelledby="settingsTitle"
      class="settings-dlg"
      @click="onDialogBackdrop($event, settingsDlg)"
      @close="settingsOpen = false"
    >
      <div class="dlg-head settings-dlg-head">
        <div class="settings-dlg-title-wrap">
          <div class="settings-dlg-icon">
            <img src="/icon.png" alt="ARAStat" class="settings-dlg-app-icon" />
          </div>
          <div>
            <h3 id="settingsTitle">AI Settings</h3>
            <p class="settings-subtitle">
              Select your preferred AI engine for interpretation and insights.
            </p>
          </div>
        </div>
        <button
          class="settings-close-btn"
          type="button"
          aria-label="Close settings"
          @click="closeSettings"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>

      <div class="dlg-body settings-body">
        <!-- Provider Selection Cards (2-column balanced layout) -->
        <div
          class="provider-cards-grid"
          role="radiogroup"
          aria-label="AI Provider"
        >
          <!-- Gemini AI Card -->
          <button
            type="button"
            class="provider-card-btn"
            :class="{ active: settingsForm.provider === 'google' }"
            role="radio"
            :aria-checked="settingsForm.provider === 'google'"
            @click="settingsForm.provider = 'google'"
          >
            <div class="provider-card-header">
              <div class="provider-card-icon-wrap provider-icon-gemini">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <path
                    d="M12 3c0 4.97-4.03 9-9 9 4.97 0 9 4.03 9 9 0-4.97 4.03-9 9-9-4.97 0-9-4.03-9-9z"
                  />
                </svg>
              </div>
              <div
                class="provider-radio-pill"
                :class="{ checked: settingsForm.provider === 'google' }"
              >
                <div class="radio-dot"></div>
              </div>
            </div>
            <span class="provider-card-title">Gemini AI</span>
            <span class="provider-card-desc"
              >Connect using a Google AI Studio API key.</span
            >
          </button>

          <!-- OpenAI / Custom Card -->
          <button
            type="button"
            class="provider-card-btn"
            :class="{ active: settingsForm.provider === 'custom' }"
            role="radio"
            :aria-checked="settingsForm.provider === 'custom'"
            @click="settingsForm.provider = 'custom'"
          >
            <div class="provider-card-header">
              <div class="provider-card-icon-wrap provider-icon-custom">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                  <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                  <line x1="6" y1="6" x2="6.01" y2="6" />
                  <line x1="6" y1="18" x2="6.01" y2="18" />
                </svg>
              </div>
              <div
                class="provider-radio-pill"
                :class="{ checked: settingsForm.provider === 'custom' }"
              >
                <div class="radio-dot"></div>
              </div>
            </div>
            <span class="provider-card-title">OpenAI-Compatible</span>
            <span class="provider-card-desc"
              >Connect to an OpenAI-compatible endpoint.</span
            >
          </button>
        </div>

        <!-- Google AI Studio Configuration -->
        <div
          v-if="settingsForm.provider === 'google'"
          class="provider-config-section"
        >
          <div class="google-guide-banner">
            <div class="google-guide-banner-text">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="guide-banner-icon"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
              <span
                >Need a free Gemini key? Google AI Studio offers a free usage
                tier.</span
              >
            </div>
            <button
              type="button"
              class="guide-link-btn"
              @click="openGoogleKeyGuide"
            >
              How to get key ↗
            </button>
          </div>

          <label class="settings-field" for="settingsGoogleModel">
            <span class="settings-field-label">
              <span>Model</span>
              <span class="settings-tag-subtle"
                >Recommended: gemini-3.8-flash</span
              >
            </span>
            <div class="select-wrapper">
              <select id="settingsGoogleModel" v-model="settingsForm.model">
                <option v-for="m in GOOGLE_MODELS" :key="m" :value="m">
                  {{ m }} {{ m === "gemini-3.8-flash" ? "(Recommended)" : "" }}
                </option>
              </select>
              <svg
                class="select-arrow"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>
          </label>

          <label class="settings-field" for="settingsKey">
            <span class="settings-field-label">
              <span>Google AI Studio API Key</span>
              <span
                v-if="!savedAiKeyHint && !settingsForm.key"
                class="settings-tag-required"
              >
                Required
              </span>
            </span>
            <div class="input-with-button">
              <input
                id="settingsKey"
                v-model="settingsForm.key"
                :type="showAiKey ? 'text' : 'password'"
                autocomplete="off"
                spellcheck="false"
                :placeholder="
                  savedAiKeyHint || 'Paste key starting with AQ. or AIza...'
                "
                :aria-invalid="!!settingsError"
              />
              <button
                type="button"
                class="input-eye-btn"
                :title="showAiKey ? 'Hide key' : 'Show key'"
                :aria-label="showAiKey ? 'Hide key' : 'Show key'"
                @click="showAiKey = !showAiKey"
              >
                <svg
                  v-if="!showAiKey"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                <svg
                  v-else
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path
                    d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"
                  />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
              </button>
            </div>
            <span v-if="settingsError" class="settings-error" role="alert">{{
              settingsError
            }}</span>
            <span v-else class="settings-help">
              Stored locally on this machine. Requests are sent directly to
              Google AI Studio.
            </span>
          </label>
        </div>

        <!-- Custom / OpenAI Compatible Configuration -->
        <div v-else class="provider-config-section">
          <!-- Quick Presets -->
          <div class="preset-chips-wrap">
            <span class="preset-chips-label">Quick presets:</span>
            <div class="preset-chips-row">
              <button
                type="button"
                class="preset-chip"
                title="Fill Ollama default endpoint (http://localhost:11434/v1)"
                @click="applyCustomPreset('ollama')"
              >
                Ollama (Local)
              </button>
              <button
                type="button"
                class="preset-chip"
                title="Fill LM Studio default endpoint (http://localhost:1234/v1)"
                @click="applyCustomPreset('lmstudio')"
              >
                LM Studio
              </button>
              <button
                type="button"
                class="preset-chip"
                title="Fill Anthropic Claude endpoint"
                @click="applyCustomPreset('anthropic')"
              >
                Anthropic
              </button>
              <button
                type="button"
                class="preset-chip"
                title="Fill OpenAI official endpoint"
                @click="applyCustomPreset('openai')"
              >
                OpenAI
              </button>
              <button
                type="button"
                class="preset-chip"
                title="Fill OpenRouter gateway"
                @click="applyCustomPreset('openrouter')"
              >
                OpenRouter
              </button>
            </div>
          </div>

          <label class="settings-field" for="settingsBaseUrl">
            <span class="settings-field-label">
              <span>Base URL</span>
            </span>
            <input
              id="settingsBaseUrl"
              v-model="settingsForm.baseUrl"
              type="text"
              autocomplete="url"
              spellcheck="false"
              placeholder="https://api.openai.com/v1"
            />
          </label>

          <div class="settings-field">
            <div class="settings-field-label">
              <span>Model Name</span>
              <div class="model-fetch-actions">
                <button
                  type="button"
                  class="fetch-models-btn"
                  :disabled="isFetchingModels || !settingsForm.baseUrl.trim()"
                  :title="
                    !settingsForm.baseUrl.trim()
                      ? 'Enter a Base URL first'
                      : 'Fetch available models from the URL'
                  "
                  @click="fetchCustomModels"
                >
                  <svg
                    v-if="!isFetchingModels"
                    class="fetch-icon"
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <polyline points="23 4 23 10 17 10" />
                    <polyline points="1 20 1 14 7 14" />
                    <path
                      d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"
                    />
                  </svg>
                  <span v-else class="fetch-spinner"></span>
                  <span>{{
                    isFetchingModels ? "Fetching..." : "Fetch models"
                  }}</span>
                </button>
              </div>
            </div>

            <!-- When models fetched: dropdown select -->
            <div v-if="customModelsList.length > 0" class="select-wrapper">
              <select id="settingsCustomModel" v-model="settingsForm.model">
                <option v-for="m in customModelsList" :key="m" :value="m">
                  {{ m }}
                </option>
              </select>
              <svg
                class="select-arrow"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>

            <!-- When no models fetched yet: text input -->
            <input
              v-else
              id="settingsCustomModel"
              v-model="settingsForm.model"
              type="text"
              autocomplete="off"
              spellcheck="false"
              placeholder="e.g. gpt-4o-mini, llama3.2, or click Fetch models"
            />
          </div>

          <label class="settings-field" for="settingsCustomKey">
            <span class="settings-field-label">
              <span>API Key</span>
              <span
                v-if="
                  !savedAiKeyHint &&
                  !settingsForm.key &&
                  !isLocalUrl(settingsForm.baseUrl)
                "
                class="settings-tag-required"
              >
                Required
              </span>
              <span
                v-else-if="isLocalUrl(settingsForm.baseUrl)"
                class="settings-tag-subtle"
              >
                Optional
              </span>
            </span>
            <div class="input-with-button">
              <input
                id="settingsCustomKey"
                v-model="settingsForm.key"
                :type="showAiKey ? 'text' : 'password'"
                autocomplete="off"
                spellcheck="false"
                :placeholder="
                  savedAiKeyHint ||
                  (isLocalUrl(settingsForm.baseUrl)
                    ? 'Optional for local models'
                    : 'Paste API key here')
                "
                :aria-invalid="!!settingsError"
              />
              <button
                type="button"
                class="input-eye-btn"
                :title="showAiKey ? 'Hide key' : 'Show key'"
                :aria-label="showAiKey ? 'Hide key' : 'Show key'"
                @click="showAiKey = !showAiKey"
              >
                <svg
                  v-if="!showAiKey"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                <svg
                  v-else
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path
                    d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"
                  />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
              </button>
            </div>
            <span v-if="settingsError" class="settings-error" role="alert">{{
              settingsError
            }}</span>
          </label>
        </div>

        <!-- ZDR & Privacy Disclaimer -->
        <div class="settings-zdr-disclaimer">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          <span
            ><strong>Privacy Notice<br /></strong> By connecting an external AI
            provider, you acknowledge that your data is governed by its
            terms.</span
          >
        </div>
      </div>

      <div class="dlg-foot settings-dlg-foot">
        <div class="settings-privacy-note">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          <span
            >All API keys are encrypted and stored locally on your device.</span
          >
        </div>
        <button type="button" class="btn btn-primary" @click="saveSettings">
          Save Settings
        </button>
      </div>
    </dialog>

    <!-- Google AI Studio Key Guide Modal -->
    <dialog
      v-if="keyGuideOpen"
      ref="keyGuideDlg"
      class="key-guide-dlg"
      aria-labelledby="keyGuideTitle"
      @click="onDialogBackdrop($event, keyGuideDlg)"
      @close="keyGuideOpen = false"
    >
      <div class="dlg-head">
        <h3 id="keyGuideTitle">Get a Free Google AI Studio API Key</h3>
        <button
          class="icon-btn"
          type="button"
          aria-label="Close guide"
          @click="closeGoogleKeyGuide"
        >
          ×
        </button>
      </div>
      <div class="key-guide-body">
        <p>
          Google AI Studio provides free, rate-limited API access to Gemini
          models for testing, prototyping, and statistical research without
          requiring a credit card.
        </p>

        <ol class="key-guide-step-list">
          <li class="key-guide-step-item">
            <span class="step-num-badge">1</span>
            <div class="step-content">
              <strong>Visit Google AI Studio</strong>
              <span
                >Go to
                <a
                  href="https://aistudio.google.com/apikey"
                  target="_blank"
                  rel="noopener noreferrer"
                  >aistudio.google.com/apikey</a
                >
                and sign in with any Google account.</span
              >
            </div>
          </li>
          <li class="key-guide-step-item">
            <span class="step-num-badge">2</span>
            <div class="step-content">
              <strong>Create API Key</strong>
              <span
                >Click the blue <strong>Create API key</strong> button in the
                top left, and choose or create a Google Cloud project.</span
              >
            </div>
          </li>
          <li class="key-guide-step-item">
            <span class="step-num-badge">3</span>
            <div class="step-content">
              <strong>Copy your Key</strong>
              <span
                >Copy the generated key (it usually starts with
                <code>AIzaSy...</code>).</span
              >
            </div>
          </li>
          <li class="key-guide-step-item">
            <span class="step-num-badge">4</span>
            <div class="step-content">
              <strong>Paste into ARAStat</strong>
              <span
                >Select <strong>Gemini AI</strong> in AI Settings, paste your
                key, and click Save.</span
              >
            </div>
          </li>
        </ol>

        <div class="key-guide-callout">
          <strong>Recommended Models:</strong>
          <br />• <strong>gemini-3.8-flash</strong>: Fast, high-accuracy
          reasoning for hypothesis testing and diagnostics (Recommended).
          <br />• <strong>gemini-3.5-flash-lite</strong>: Blazing fast with
          generous rate limits, ideal for table insights. <br />•
          <strong>gemini-3.1-pro</strong>: In-depth statistical synthesis and
          advanced methodology.
        </div>
      </div>
      <div class="dlg-foot">
        <button type="button" class="btn btn-primary" @click="openAiStudioLink">
          Open Google AI Studio ↗
        </button>
      </div>
    </dialog>

    <!-- About dialog (Help > About ARAStat) -->
    <dialog
      v-if="aboutOpen"
      ref="aboutDlg"
      aria-label="About ARAStat"
      class="settings-dlg about-dlg"
      @click="onDialogBackdrop($event, aboutDlg)"
      @close="aboutOpen = false"
    >
      <button
        class="icon-btn about-close"
        type="button"
        aria-label="Close about"
        @click="closeAbout"
      >
        ×
      </button>
      <div class="dlg-body about-body">
        <img src="/ARAStat.png" alt="ARAStat logo" class="about-logo" />
        <p class="about-text">
          Statistics workbench with an integrated AI copilot.<br />Author: Adhi
          Rahmadian<br />Version 0.1.0 · GNU GPL v3.0 (<button
            class="about-link"
            type="button"
            @click="openAuthorLink"
          >
            adhirahmadian.id</button
          >)
        </p>
        <div class="about-card-box about-links">
          <div class="about-link-row">
            <div class="about-link-text">
              <strong>Need an API key?</strong
              ><span>Get a Gemini API key from Google AI Studio.</span>
            </div>
            <button
              class="btn btn-primary btn-sm"
              type="button"
              @click="openAiStudioLink"
            >
              Get Google API keys ↗
            </button>
          </div>
        </div>
      </div>
    </dialog>

    <!-- Themed confirm dialog -->
    <dialog
      v-if="confirmState"
      ref="confirmDlg"
      class="settings-dlg confirm-dlg"
      @click="onDialogBackdrop($event, confirmDlg)"
      @close="settleConfirm(false)"
    >
      <div class="dlg-body confirm-body">
        <p class="confirm-msg">{{ confirmState.message }}</p>
        <div class="confirm-actions">
          <button class="btn" type="button" @click="settleConfirm(false)">
            Cancel
          </button>
          <button
            class="btn btn-primary"
            type="button"
            autofocus
            @click="settleConfirm(true)"
          >
            OK
          </button>
        </div>
      </div>
    </dialog>

    <dialog
      v-if="visualizeOpen"
      ref="visualizeDlg"
      class="settings-dlg visualize-dlg"
      aria-labelledby="visualizeTitle"
      @click="onDialogBackdrop($event, visualizeDlg)"
      @close="visualizeOpen = false"
    >
      <div class="dlg-head">
        <h3 id="visualizeTitle">Visualize Data</h3>
        <button
          class="icon-btn"
          type="button"
          aria-label="Close visualization"
          @click="closeVisualize"
        >
          ×
        </button>
      </div>
      <div class="visualize-body">
        <div class="visualize-controls-bar">
          <div class="viz-field">
            <label for="vizType">Chart Type</label>
            <select
              id="vizType"
              v-model="visualizeType"
              class="viz-select"
              @change="onVisualizeTypeChange"
            >
              <option value="scatter">Scatter Plot</option>
              <option value="line">Line Chart</option>
              <option value="bar">Bar Chart</option>
              <option value="histogram">Histogram</option>
            </select>
          </div>
          <div class="viz-field">
            <label for="vizX">X Variable</label>
            <select
              id="vizX"
              v-model="visualizeX"
              class="viz-select"
              @change="renderVisualization"
            >
              <option v-for="c in availableXCols" :key="c.name" :value="c.name">
                {{ c.name }}
              </option>
            </select>
          </div>
          <div v-if="visualizeType !== 'histogram'" class="viz-field">
            <label for="vizY">Y Variable</label>
            <select
              id="vizY"
              v-model="visualizeY"
              class="viz-select"
              @change="renderVisualization"
            >
              <option v-for="c in availableYCols" :key="c.name" :value="c.name">
                {{ c.name }}
              </option>
            </select>
          </div>
        </div>
        <div class="visualize-plot-container">
          <div
            ref="visualizeEl"
            class="visualize-plot"
            role="img"
            aria-label="Interactive statistical chart"
          ></div>
        </div>
      </div>
    </dialog>

    <div class="toast" :class="{ show: toastShow }" role="status">
      {{ toastMsg }}
    </div>
  </div>
</template>
