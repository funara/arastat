# ARAStat — Design System & UI/UX Specification (`design.md`)

**Visual Direction**: **SPSS Workbench Precision + JASP Publication Clarity**  
**Surface Mode**: **Operate** (High-density desktop statistical workbench where scanability, measurement-scale clarity, keyboard speed, and zero-friction APA output outrank decorative chrome).

---

## 1. Design Philosophy: The SPSS + JASP Synthesis

ARAStat combines the two gold standards of statistical computing into a single cohesive desktop experience:

1. **From IBM SPSS Statistics (Left Pane — Data & Variable Workbench)**:
   - Instant mental model of a dataset through dual views: **Data View** (rows = cases, columns = variables) and **Variable View** (rows = variable definitions, columns = metadata attributes: Name, Type, Decimals, Label, Value Labels, Missing Rules, Measure).
   - Strict **Measurement Scale Iconography** everywhere a variable appears:
     - **Scale / Ratio**: Ruler icon (`--badge-scale-bg` / `--badge-scale-text`, Cobalt Blue)
     - **Ordinal**: Ascending 3-bar icon (`--badge-ordinal-bg` / `--badge-ordinal-text`, Cyan/Teal)
     - **Nominal**: 3-category/list icon (`--badge-nominal-bg` / `--badge-nominal-text`, Violet)
   - Dedicated, deterministic **Data & Transform Dialogs** (Compute Variable with formula keypad, Sort Cases, Recode, Missing Value Imputation) — **never** browser `window.prompt()` boxes.

2. **From JASP (Right Pane & Dialogs — Reactive Analysis & APA 7th Output)**:
   - **Split Two-Column Analysis Configuration (`AnalysisDialog.vue`)**: Left column holds filterable *Available Variables*; right column holds *Target Variable Dropzones* with **`▸` / `◂` Shuttle Buttons**, live assumption/group-level pre-checks, and clean parameter cards.
   - **Publication-Grade Results Pane (`ResultsPane.vue`)**: Every run renders an academic document card with strict **APA 7th Edition three-line tables** (top rule, header rule, bottom rule, zero vertical borders, tabular numerals, right-aligned numbers, `* p < .05` flagging), crisp SVG statistical plots, and optional 1-click AI narrative interpretation.

---

## 2. Color & Surface Token Architecture (`src/ara.css`)

All components **must** reference CSS custom properties from `:root` / `[data-theme="light"]` and `[data-theme="dark"]`. Hardcoded hex values inside component `<style>` blocks are strictly forbidden.

### 2.1 Surface Hierarchy
| Token | Light Mode | Dark Mode | Usage |
| :--- | :--- | :--- | :--- |
| `--chrome` | `#f1f3f6` | `#121416` | Custom frameless titlebar (`40px`), status bar (`26px`), collapsed side rails |
| `--bg` / `--canvas` | `#f8fafc` | `#16181a` | App background canvas, empty states, table zebra backdrop |
| `--panel` / `--surface` | `#ffffff` | `#1e2124` | Primary workspace panes, modal cards, dropdown menus, active tabs |
| `--panel-alt` / `--surface-subtle` | `#f8fafc` | `#16181a` | Modal headers/footers, pane headers, subtle card backgrounds |
| `--surface-hover` | `#f1f5f9` | `#262a2f` | Interactive row hover, button hover, menu item highlight |
| `--surface-active` | `#e2e8f0` | `#31363c` | Active/pressed controls, selected spreadsheet row/column header |

### 2.2 Brand & Semantic Status Tokens
| Token | Light Mode | Dark Mode | Usage |
| :--- | :--- | :--- | :--- |
| `--accent` | `#2367ec` | `#4a9eff` | Primary CTA buttons, active tab indicators, focus rings (`2px`), selected chips |
| `--accent-soft` | `rgba(35,103,236,0.08)` | `rgba(74,158,255,0.14)` | Selected variable row, active dropzone highlight, guide banners |
| `--ok` | `#059669` | `#10b981` | Engine ready dot, valid group check, high health score ($\ge 80$), copy checkmark |
| `--warn` / `--warn-bg` | `#d97706` / `#fef3c7` | `#f59e0b` / `#2d2412` | Skewness/outlier notices, moderate health score ($50–79$), validation warnings |
| `--err` / `--err-bg` | `#ef4444` / `#fef2f2` | `#f87171` / `#321616` | Engine error cards, destructive actions, invalid formula/group count |

---

## 3. Typography & Numeric Discipline

- **UI Font (`--font-sans`)**: `'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, sans-serif`
  - Base UI body: `13px` (`line-height: 1.45`)
  - Compact controls / table headers / menu items: `12px` (`font-weight: 500–600`)
  - Badges / keyboard hints (`<kbd>`): `10.5px–11px`
  - Modal titles: `14.5px` (`font-weight: 700`, `letter-spacing: -0.01em`)
- **Code & Formula Font (`--font-mono`)**: `'Cascadia Code', 'Consolas', 'Fira Code', monospace`
  - Used for Compute Variable formulas, storage type badges (`int`, `flt`, `str`, `date`), and value codes.
- **Strict Tabular Numerals (`font-variant-numeric: tabular-nums`)**:
  - **Mandatory** on all DataGrid numeric cells (`.num`), row numbers (`.rownum`), APA table numeric cells, EDA summary statistics, health scores, and tab counter badges so decimal points and digits align vertically without jitter.

---

## 4. Core Component Specifications

### 4.1 Workspace Layout & Resizable / Collapsible Panes
- **Three-Pane Workbench & Mutual-Exclusion Rule**:
  1. **Left Pane (`.pane-data`)**: Data Editor (`Data View` & `Variable View`). Minimum width **`460px`** (`DEFAULT_DATA_WIDTH = 480px`) so header controls (`+ Row`/`+ Variable`, `Undo`, `Redo`, `Collapse`) never clip or overlap. Collapses to the **left** into a `34px` vertical `.data-rail` (`Ctrl+D`).
  2. **Center Pane (`.pane-results`)**: JASP-style APA Output Viewer (`min-width: 280px`). Collapses into a `34px` vertical `.results-rail` (`Ctrl+J`).
  3. **Right Dock (`AiDock.vue`)**: Provider-agnostic AI Copilot drawer (`360px` default width). Collapses into a `34px` right `.ai-rail` independently of the other panes.
- **Core Visibility Invariant (`showData || showResults === true`)**:
  - At least **one** of **Data/Variable Pane** or **Result Pane** must be expanded at all times (either Data only, Result only, or both side-by-side). Both cannot be collapsed simultaneously.
  - Collapsing Data when Result is closed automatically expands Result (`showResults = true`), and collapsing Result when Data is closed automatically expands Data (`showData = true`).
  - `ARA Assistant` (`AiDock.vue`) is completely free from this rule and can open or collapse at any time.
- **Splitter Handle (`.pane-splitter`)**: `6px` hit target with a `2px` visual line that highlights in `var(--accent)` on hover/drag; rendered only when both `showData && showResults` are open.

### 4.2 Unified Tab & Stepper System (`.ara-tabs` & `.ara-stepper`)
ARAStat uses two standardized tab patterns across the entire app:

1. **Workspace View Switcher (`.view-segmented-tabs` in `.pane-header.data-header`)**:
   - Segmented pill container (`background: var(--chrome)`, `padding: 3px`, `border-radius: var(--radius-md)`).
   - Each tab (`Data View` / `Variable View`) displays:
     - Crisp `12×12px` SVG icon (grid icon for Data View, sliders/rows icon for Variable View).
     - Label + live count badge (`Data View · 120`, `Variable View · 14`).
   - Active tab uses `background: var(--panel)`, `color: var(--accent)`, `font-weight: 600`, `box-shadow: var(--shadow-sm)`.
   - Supports `Ctrl+Tab` global toggle and `ArrowLeft` / `ArrowRight` when focused.

2. **Modal Subheader Tabs & Steppers (`.dialog-tabs` / `.ara-stepper`)**:
   - Full-width bar directly beneath `.modal-header` (`background: var(--panel-alt)`, `border-bottom: 1px solid var(--line)`, `padding: 0 20px`, `gap: 6px`).
   - **Standard Modal Tabs (`VariableConfigDialog.vue`, `DataTransformDialog.vue`)**:
     - Height `38px`, bottom border `2px solid transparent`, transitioning to `border-bottom-color: var(--accent)` and `color: var(--accent)` when `.active`.
     - Count pills inside tabs (`Value Labels (5)`, `Missing Data (12)`) use subtle badge styling.
   - **Workflow Stepper Tabs (`AiMissingAdvisorDialog.vue`)**:
     - Numbered step pills (`1. Check Health` → `2. Stage Fixes` → `3. Apply & Log`) connected by subtle chevrons (`›`), showing completed checkmarks (`✓`) and staged item counters.
   - **Keyboard Accessibility**: Every `role="tablist"` container must support `ArrowLeft` and `ArrowRight` key navigation.

### 4.3 Unified Modal Shell Contract (`.ara-modal`)
Whether backed by native `<dialog>` or `.modal-backdrop > .modal-card`, all modals must share identical visual geometry and tokens:
- **Dimensions**:
  - Compact Confirm / Prompt Modals: `width: min(440px, 92vw)`
  - Standard Configuration Modals (`AI Settings`, `Transform / Compute`, `Variable Config`): `width: min(640px, 94vw)`, `max-height: min(640px, 88vh)`
  - Workbench Modals (`AnalysisDialog`, `VisualizeDialog`, `TestAdvisorDialog`, `AiMissingAdvisorDialog`): `width: min(760px–880px, 94vw)`, `max-height: min(680px, 88vh)`
- **Elevation & Framing**:
  - `background: var(--panel)`
  - `border: 1px solid var(--line-strong)`
  - `border-radius: 12px`
  - `box-shadow: var(--shadow-lg), 0 20px 48px rgba(0, 0, 0, 0.35)`
  - Backdrop: `background: rgba(9, 13, 22, 0.48); backdrop-filter: blur(2px);`
- **Unified Header (`.dlg-head` / `.modal-header`)**:
  - Padding `12px 18px`, `background: var(--panel-alt)`, `border-bottom: 1px solid var(--line)`.
  - Left: `28×28px` rounded-square icon badge + title (`14.5px` bold) + optional contextual subtitle or `< Prev | Next >` variable stepper.
  - Right: Standardized `28×28px` SVG close button (`border-radius: 6px`, hover `var(--surface-hover)`), never raw text `&times;`.
- **Unified Footer (`.dlg-foot` / `.modal-footer`)**:
  - Padding `10px 18px`, `background: var(--panel-alt)`, `border-top: 1px solid var(--line)`.
  - Left: Validation status pill (`Ready to execute` with green check, or actionable warning icon + message) or privacy note.
  - Right: Secondary action (`Cancel` / `Close`) on the left, Primary action (`.btn-primary`) on the right.

### 4.4 SPSS + JASP Analysis Dialog (`AnalysisDialog.vue`)
- **Left Column (`Available Variables`, `240px` fixed width)**:
  - Header with count badge + compact search input (`placeholder="Filter variables..."`).
  - Scrollable `.var-list` where each `.var-row` shows: `[Measure Icon] [Variable Name] [Storage Badge (int/flt/str)]`.
  - Incompatible variables for the currently focused target box are visually dimmed (`opacity: 0.45`) with a clear tooltip explaining the required measurement scale.
- **Center/Right Shuttle & Target Dropzones**:
  - Each `.target-field` includes a **`▸` Shuttle Button** alongside the `.target-box` so users can assign variables via:
    1. Drag-and-drop
    2. Click variable + click `▸` shuttle button (or click target box)
    3. Double-click variable in source list
  - Assigned `.token` pills display `[Measure Icon] [Variable Name] [× Remove]`.
  - **Live Pre-Check Cards**: Grouping fields automatically inspect the column and display detected group levels and sample sizes (`Group A (n=25) vs. Group B (n=25)`), blocking execution with a clear explanation if levels $\ne 2$ for a 2-group test.

### 4.5 APA 7th Results Pane (`ResultsPane.vue`)
- **Run Card Header (`.result-head-row`)**:
  - Title of the statistical procedure on the left.
  - Action chips on the right: **Copy APA Table** (with 1.5s checkmark feedback), **Minimize/Expand** (`–`/`+`), and **Delete Run** (`×`).
- **APA 7th Table Styling (`table.apa`)**:
  - Caption above table: bold table label + italic title.
  - Top rule (`border-top: 1.5px solid var(--text)`), header bottom rule (`border-bottom: 1px solid var(--text)`), table bottom rule (`border-bottom: 1.5px solid var(--text)`), zero vertical borders.
  - Left-aligned first column (`.l`), right-aligned numeric columns with `tabular-nums`, significant $p$-values highlighted with `.sig` (`*`).
  - Footnote directly below (`Note. ... * p < .05.`).

---

## 5. Reliability & Anti-Bloat Guardrails

1. **Zero `window.prompt()` / `window.alert()` / `window.confirm()`**: All user prompts and confirmations must use ARAStat's themed `<dialog>` / `.ara-modal` components.
2. **Zero Dead-End Buttons**: Every menu item or button rendered in the UI must perform its complete action. Never ship placeholder toasts (`"Available in a later build"`).
3. **Pre-Flight Validation Over Post-Run Crashes**: Validate variable count, numeric type, and group levels inside `AnalysisDialog.vue` and `DataTransformDialog.vue` *before* invoking the Python sidecar, giving users immediate, plain-language guidance.
4. **Listener & Focus Hygiene**: Every modal must trap focus while open, close on `Escape` or outside backdrop click, and restore focus to the invoking trigger on close.
