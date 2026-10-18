<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from "vue";
import DataGrid from "./DataGrid.vue";
import VariableView from "./VariableView.vue";
import ResultsPane from "./ResultsPane.vue";
import AiDock from "./AiDock.vue";
import AnalysisDialog from "./AnalysisDialog.vue";
import TestAdvisorDialog from "./TestAdvisorDialog.vue";
import VisualizeDialog, { type VizType } from "./VisualizeDialog.vue";
import DataTransformDialog, { type TransformMode } from "./DataTransformDialog.vue";
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
} from "./store.ts";
import { defaultMeta, datasetFromRows } from "./io/types.ts";
import { schemaById, type AnalysisSchema } from "./specs.ts";
import { runAnalysis } from "./runAnalysis.ts";
import {
  applyNotification,
  snapshotRuns,
  restoreRuns,
  pinChartElement,
  type Run,
} from "./results.ts";
import {
  buildResultsHtml,
  copyRunsToClipboard,
} from "./exports.ts";
import { runsState } from "./results.ts";
import { openWithDialog, saveWithDialog, ioMessage } from "./fileOps.ts";
import { resetAiAdvisorCache } from "./AiMissingAdvisorDialog.vue";
import AiMissingAdvisorDialog from "./AiMissingAdvisorDialog.vue";
import UpdateRestartModal from "./UpdateRestartModal.vue";
import AiSettingsDialog from "./AiSettingsDialog.vue";

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
/* Visualize dialog: the extracted component owns chart rendering, so App only
   records the request (chart type + preselected columns) and pins what comes back. */
const visualizeOpen = ref(false);
const visualizeRequest = ref<{ type: VizType; x: string; y: string }>({
  type: "scatter",
  x: "",
  y: "",
});

function openVisualize(
  type: VizType = "scatter",
  defaultX?: string,
  defaultY?: string,
): void {
  closeMenus();
  visualizeRequest.value = { type, x: defaultX ?? "", y: defaultY ?? "" };
  visualizeOpen.value = true;
}

function pinChart(payload: { caption: string; svg: string }): void {
  pinChartElement(payload.caption, payload.svg);
  showResults.value = true;
  toast("Chart pinned to Result.");
}

/* Data & Transform dialog: one host for Compute, Transform, Recode, Sort/Drop
   and Find. `recodeNew` preselects Recode-into-a-new-column for that menu item. */
const transformOpen = ref(false);
const transformRequest = ref<{ mode: TransformMode; recodeNew: boolean }>({
  mode: "compute",
  recodeNew: true,
});

function openTransform(mode: TransformMode, recodeNew = false): void {
  transformRequest.value = { mode, recodeNew };
  transformOpen.value = true;
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

/* SPSS cross-view ergonomics: a double-clicked column header opens that
   variable's config in Variable View, and a double-clicked variable row number
   jumps back to its column in Data View. The highlight is a one-shot signal
   cleared before it is set, so double-clicking the same column twice still
   flashes the grid. */
const gridHighlight = ref("");
const variableViewRef = ref<InstanceType<typeof VariableView> | null>(null);

function openVariableFromGrid(name: string): void {
  ensureView("variable");
  void nextTick(() => variableViewRef.value?.openConfigFor(name));
}

function jumpToDataColumn(name: string): void {
  gridHighlight.value = "";
  ensureView("data");
  void nextTick(() => {
    gridHighlight.value = name;
  });
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

/* AI Settings host: the dialog owns its form; App keeps only visibility (and
   the push threshold mirrored above, which the pane splitter reads). */
const aiSettingsOpen = ref(false);
const aiDialogView = ref<"settings" | "about">("settings");

function openSettings(): void {
  closeMenus();
  aiDialogView.value = "settings";
  aiSettingsOpen.value = true;
}

function openAbout(): void {
  closeMenus();
  aiDialogView.value = "about";
  aiSettingsOpen.value = true;
}

function onAiSettingsSaved(t: number): void {
  aiPushThreshold.value = t;
}

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

/* Per-run copy (header button and the run's bottom action bar): write the APA
   clipboard payload, then let the pane show its own 1.5s checkmark so the
   feedback lands on the button that was clicked, even while minimized. */
const resultsPaneRef = ref<InstanceType<typeof ResultsPane> | null>(null);
async function copyApaRun(run: Run): Promise<void> {
  // An APA copy of a table-less run (a pinned chart) would be an empty payload:
  // say so instead of reporting a copy that carried nothing.
  if (!run.elements.some((el) => el.kind === "table")) {
    toast("This result has no tables to copy as APA.");
    return;
  }
  try {
    await copyRunsToClipboard([run]);
    resultsPaneRef.value?.markApaCopied(run);
  } catch {
    toast("The clipboard could not be written. Try again.");
  }
}

function closeRun(run: Run): void {
  const i = runsState.runs.findIndex((r) => r.runId === run.runId);
  if (i >= 0) runsState.runs.splice(i, 1);
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

// Rich copy: the APA exporter writes both text/html (publication-style tables
// with the APA three-line rules) and a text/plain fallback, so every copy entry
// point shares one output path.
async function copyRunsFormatted(runs: Run[]): Promise<void> {
  if (!runs.length) {
    toast("No results to copy yet.");
    return;
  }
  try {
    await copyRunsToClipboard(runs);
    toast(
      runs.length === 1
        ? "Result copied with formatting."
        : "Results copied with formatting.",
    );
  } catch {
    toast("The clipboard could not be written. Try again.");
  }
}

function onAiVisualize(payload: {
  type: VizType;
  x?: string;
  y?: string;
}): void {
  openVisualize(payload.type || "scatter", payload.x, payload.y);
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
    case "data-sort":
    case "transform-compute":
    case "transform-fill":
    case "transform-log":
    case "transform-standardize":
    case "transform-bin":
    case "transform-recode-same":
    case "transform-recode-diff":
    case "data-drop-missing":
    case "edit-find": {
      // Every Data/Transform operation now lives in one themed dialog: no
      // window.prompt(), no dead-end toast. Map the menu item onto its mode.
      const mode: TransformMode =
        id === "data-sort" || id === "data-drop-missing"
          ? "sort-drop"
          : id === "edit-find"
            ? "find"
            : id.startsWith("transform-recode")
              ? "recode"
              : id === "transform-compute"
                ? "compute"
                : "transform";
      openTransform(mode, id === "transform-recode-diff");
      return;
    }
    default:
      // Unreachable from the UI (every menu id has a case above); kept honest
      // rather than promising a future build if a stale id ever arrives.
      toast(`Unknown command: ${id}.`);
  }
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
              <button
                class="dd-row"
                role="menuitem"
                @click.stop="openVisualize('boxplot')"
              >
                Boxplot
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
                data-sub="scale"
                :class="{ open: openSub === 'scale' }"
                @mouseenter="openSub = 'scale'"
                @mouseleave="openSub = null"
              >
                <button
                  class="dd-row"
                  role="menuitem"
                  aria-haspopup="menu"
                  :aria-expanded="openSub === 'scale'"
                  @click.stop="toggleSub('scale')"
                >
                  Scale / Factor
                </button>
                <div class="dropdown" role="menu" aria-label="Scale / Factor">
                  <button
                    class="dd-row"
                    role="menuitem"
                    @click.stop="openAnalysis('reliability_cronbach')"
                  >
                    Reliability (alpha &amp; omega)
                  </button>
                  <button
                    class="dd-row"
                    role="menuitem"
                    @click.stop="openAnalysis('factor_efa')"
                  >
                    Factor analysis (EFA / PCA)
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
              <span class="view-tab-count ara-spreadsheet-count">{{ rowCount }}</span>
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
              <span class="view-tab-count ara-spreadsheet-count">{{ colCount }}</span>
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
          <DataGrid
            v-if="state.view === 'data'"
            :highlight-column="gridHighlight"
            @open-variable="openVariableFromGrid"
          />
          <VariableView
            v-else
            ref="variableViewRef"
            @plot="(col) => openVisualize('histogram', col)"
            @ask-ai="onAskAi"
            @open-analysis="(id, opts) => openAnalysis(id, opts)"
            @open-test-advisor="(vars) => openTestAdvisor(vars)"
            @open-advisor="(col) => openHealthAdvisor(col || '')"
            @jump-to-column="jumpToDataColumn"
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
        ref="resultsPaneRef"
        @export-html="act('export-html')"
        @copy-text="act('results-copy-text')"
        @copy-run="copyApaRun"
        @copy-apa="copyApaRun"
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

    <!-- AI Settings / Google Key Guide / About (AiSettingsDialog.vue) -->
    <AiSettingsDialog
      :open="aiSettingsOpen"
      :push-threshold="aiPushThreshold"
      :initial-view="aiDialogView"
      @close="aiSettingsOpen = false"
      @saved="onAiSettingsSaved"
      @toast="toast"
    />

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

    <!-- Data & Transform dialog (Compute, Transform, Recode, Sort/Drop, Find) -->
    <DataTransformDialog
      :open="transformOpen"
      :mode="transformRequest.mode"
      :column="''"
      :recode-new="transformRequest.recodeNew"
      @close="transformOpen = false"
      @done="toast"
      @find-hit="jumpToDataColumn"
    />

    <!-- Visualize dialog (renders locally; can pin a chart into the Result pane) -->
    <VisualizeDialog
      :open="visualizeOpen"
      :type="visualizeRequest.type"
      :default-x="visualizeRequest.x"
      :default-y="visualizeRequest.y"
      @close="visualizeOpen = false"
      @pin="pinChart"
    />

    <div class="toast" :class="{ show: toastShow }" role="status">
      {{ toastMsg }}
    </div>
  </div>
</template>
