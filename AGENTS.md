# ARAStat — AI Coding Agent Playbook & Guardrails (`agent.md`)

This document is the authoritative operational guide for any AI coding assistant working in the **ARAStat** repository. Read this file alongside [`design.md`](file:///C:/Users/adhir/Documents/Git/ARAEcosystem/arastat/design.md), [`architecture.md`](file:///C:/Users/adhir/Documents/Git/ARAEcosystem/arastat/architecture.md), and [`plan.md`](file:///C:/Users/adhir/Documents/Git/ARAEcosystem/arastat/plan.md) before proposing or writing changes.

---

## 1. Core Identity & Non-Negotiable Principles

1. **Privacy-First & 100% Local Computation**:
   - All statistical computations execute locally inside the Python `ara_engine` sidecar (`engine/ara_engine/`) or pure TypeScript dataset transforms (`src/`).
   - Never add telemetry, analytics, cloud storage, or third-party tracking scripts.
   - Never send raw dataset rows to an AI endpoint; AI prompts in `src/ai.ts` must only include schema metadata and aggregated statistical output.
2. **Provider-Agnostic AI**:
   - Keep first-class parity between Google Gemini, OpenAI-compatible APIs, and local keyless loopback servers (`http://localhost:11434/v1` for Ollama, `http://localhost:1234/v1` for LM Studio).
3. **SPSS + JASP Visual & Functional Standard**:
   - Follow [`design.md`](file:///C:/Users/adhir/Documents/Git/ARAEcosystem/arastat/design.md) strictly.
   - **Never** use `window.prompt()`, `window.alert()`, or `window.confirm()`. Always use themed ARAStat modals.
   - **Never** ship dead-end UI stubs (e.g., `"Available in a later build"` toasts). Every visible control must work end-to-end.
   - **Never** hardcode hex colors in Vue `<style>` blocks; use CSS custom properties from `src/ara.css` so Light and Dark themes stay in lockstep.
4. **Compact 4-Folder Repository Layout**:
   - Keep the root directory restricted to `engine/`, `src/`, `src-tauri/`, and `tests/`.
   - Keep `src/` flat (`src/*.vue`, `src/*.ts`, `src/io/*`, `src/shared/*`). Do not introduce deeply nested `src/components/modals/...` folder trees.

---

## 2. Build, Typecheck & Test Commands

Run these commands from the repository root (`C:\Users\adhir\Documents\Git\ARAEcosystem\arastat`):

| Task | Command | Notes |
| :--- | :--- | :--- |
| **TypeScript & Vue Check** | `npm run typecheck` | Runs `vue-tsc --noEmit`. Must pass with `0` errors. |
| **Frontend + Engine Tests** | `npm test` | Runs Node test runner (`tests/*.test.js`), including `tests/ref.test.js` which spawns the real Python `ara_engine` and checks golden fixtures at `1e-9` relative tolerance. |
| **Rust Host Unit Tests** | `npm run test:rust` | Runs `cargo test --manifest-path src-tauri/Cargo.toml` (tests AES-GCM crypto, AI proxy validation, SAV parser, engine framing, recent files, updater). |
| **Frontend Production Build** | `npm run build` | Builds Vite frontend from `src/` into `dist/`. |
| **Tauri Dev Mode** | `npm run dev` | Starts Vite dev server on `http://localhost:5173` and launches the Tauri v2 desktop window. |
| **Regenerate Golden Fixtures** | `engine\.venv\Scripts\python.exe engine/ara_engine/fixtures.py` | Regenerates `expected.json` files in `tests/fixtures/` when adding a new statistical test. |

---

## 3. Step-by-Step Playbook: Adding a New Statistical Procedure

Whenever you add a new statistical test (e.g., `reliability_cronbach` or `factor_efa`), you **must** update all 6 layers in lockstep:

1. **Engine Schema Registry (`engine/ara_engine/registry.py`)**:
   - Add the analysis ID (alphabetically) to `ANALYSES` with its exact option types (`("str",)`, `("num",)`, `("str_list",)`, `("enum", (...))`).
   - Add the human-readable title to `TITLES`.
2. **Mathematical Implementation (`engine/ara_engine/statslib.py`)**:
   - Implement the pure NumPy/SciPy calculation function.
   - Enforce numerical preconditions and raise `EngineError(1004, "code", user_message)` with an actionable recovery hint when preconditions fail (e.g., zero variance, fewer than required columns/cases, singular correlation matrix).
   - Return a deterministic `stats` dict containing only JSON-serializable primitives/lists (`float`, `int`, `str`, `list`, `dict`).
3. **Pipeline & Output Formatting (`engine/ara_engine/pipeline.py`)**:
   - Wire the analysis ID into `run_pipeline()`.
   - Emit APA 7th tables (`_table(...)`), optional SVG charts (`charts.py`), and dual-mode (`pro` / `beginner`) narrative interpretation notes.
4. **Frontend Dialog Schema (`src/specs.ts`)**:
   - Add the `AnalysisSchema` entry to `SCHEMAS` with matching `id`, `title`, `description`, `howTo`, and `options` (`variable`, `variable-list`, `number`, `enum`, `boolean`) including allowed `measures` (`['scale', 'ratio', 'ordinal', 'nominal']`).
5. **Menu & Smart Advisor Wiring (`src/App.vue` / `src/AppTitlebar.vue` & `src/advisor.ts`)**:
   - Add the menu item under the `Analyze` menu and register appropriate recommendation heuristics in `src/advisor.ts`.
6. **Golden Reference Fixture (`engine/ara_engine/fixtures.py` & `tests/ref.test.js`)**:
   - Add a deterministic fixture generator in `engine/ara_engine/fixtures.py` writing `input.csv`, `spec.json`, and `expected.json` under `tests/fixtures/tier1/<id>` or `tests/fixtures/tier2/<id>`.
   - Add `<id>` (alphabetically) to `ANALYSIS_IDS` in `tests/ref.test.js` and run `npm test` to confirm `1e-9` golden parity.

---

## 4. Security & CSP Invariants

- **Strict Content Security Policy (`src/index.html` & `src-tauri/tauri.conf.json`)**:
  - No `unsafe-eval`. All user-entered formulas in Compute Variable must be parsed and evaluated via `src/expr.ts` (`tokenizeExpr` + `evalExprTokens`).
  - All HTML strings built for exports or clipboard (`src/exports.ts`) must escape user data (`&`, `<`, `>`, `"`, `'`) to prevent XSS injection.
- **IPC Boundary (`src/tauri-shim.ts` & `src-tauri/src/lib.rs`)**:
  - Frontend components must interact with native capabilities exclusively through `window.ara` and `window.araUpdate` (defined in `src/shared/ara-api.ts` and `src/shared/update-api.ts`).
  - Keep `src/tauri-shim.ts` in 1:1 parity with `#[tauri::command]` handlers in `src-tauri/src/lib.rs`.
