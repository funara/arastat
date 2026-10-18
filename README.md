# ARAStat

<p align="center">
  <img src="src/public/ARAStat.png" alt="ARAStat Logo" width="380" />
</p>

<p align="center">
  <strong>Modern, Privacy-First Desktop Statistical Workbench with Integrated AI Copilot</strong>
</p>

<p align="center">
  <a href="#key-features">Features</a> •
  <a href="#supported-statistical-analyses">Analyses</a> •
  <a href="#ara-assistant-ai-copilot">AI Copilot</a> •
  <a href="#getting-started">Getting Started</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#privacy--security">Privacy</a> •
  <a href="#license">License</a>
</p>

---

## Overview

**ARAStat** is an open-source, offline-first desktop statistical analysis software designed as a fast, accessible, and privacy-conscious alternative to traditional tools like SPSS, JASP, and Jamovi. Built with a Tauri v2 (Rust) host and a Vue 3 renderer backed by a verified native Python statistical engine, ARAStat combines spreadsheet data management with 25 statistical tests, publication-ready output tables, interactive Plotly visualizations, and an AI copilot (**ARA Assistant**).

---

## Key Features

- **Dual-View Spreadsheet Workspace**:
  - **Data View**: High-performance grid for data entry, row/column transformations, filtering, and sorting.
  - **Variable View**: SPSS-grade variable metadata definition (name, type, width, decimal places, value labels, user-missing sentinels, and measurement scales: Nominal, Ordinal, Scale).
- **25 Native Statistical Analyses**:
  - Comprehensive parametric, non-parametric, regression, contingency, and post-hoc routines powered by SciPy, statsmodels, and NumPy.
- **Data Health Scan & Smart Imputation Advisor**:
  - Automatically identifies data quality concerns (severe outliers, extreme sentinels, measure mismatches, high-missing columns, and category spelling variations).
  - Imputation preview engine (Mean, Median, Mode, Linear Interpolation) with live complete-cases forecasting.
- **Interactive Visualizations**:
  - Built-in Plotly charts: Scatter plots, Grouped/Stacked Bar charts, Histograms, and Line charts.
- **Broad File Format Interoperability**:
  - **SPSS `.sav`**: Full binary read and write support via `jsavvy`.
  - **Excel `.xlsx`**: Import and export with variable metadata preservation sheet.
  - **CSV**: RFC 4180 compliant parsing and formula-injection-safe export.
  - **Project Archives (`.arastat`)**: Lossless single-file archives bundling data, full variable metadata, and analysis result history.
- **Clean Results Pane**:
  - Hierarchical result trees with collapsible analysis runs, APA-formatted summary tables, notes, and one-click copy or HTML export.
- **Zero Telemetry & 100% Privacy**:
  - No account requirements, no tracking, and no external dependencies. All data and computations stay local to your machine.

---

## Supported Statistical Analyses

ARAStat implements 25 statistical procedures with golden-reference fixture tests verifying exact mathematical alignment against R and SPSS outputs:

| Category                         | Analyses Included                                                                                                                                                    |
| :------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Descriptive & Frequencies**    | Descriptive Statistics, Frequency Tables                                                                                                                             |
| **Comparing Means (Parametric)** | One-Sample t-test, Paired-Samples t-test, Independent-Samples t-test, One-Way ANOVA, Welch ANOVA, Two-Way Factorial ANOVA                                            |
| **Non-Parametric Tests**         | Mann-Whitney U, Wilcoxon Signed-Rank, Wilcoxon One-Sample, Kruskal-Wallis H, Friedman ANOVA                                                                          |
| **Correlation & Association**    | Pearson & Spearman Correlation, Kendall's Tau-b, Chi-Square Test of Independence, Chi-Square Goodness of Fit, Fisher's Exact Test (2×2), McNemar Test, Binomial Test |
| **Regression Modeling**          | Linear Regression (OLS), Binary Logistic Regression                                                                                                                  |
| **Scale & Factor Analysis**      | Scale Reliability Analysis (Cronbach's Alpha & McDonald's Omega), Exploratory Factor Analysis (EFA / PCA)                                                            |
| **Post-Hoc Tests**               | Tukey's Honestly Significant Difference (HSD)                                                                                                                        |

---

## ARA Assistant (AI Copilot)

ARAStat features an optional, privacy-respecting AI copilot that acts as a statistical assistant, helping users interpret test results into APA-style narratives, suggesting relevant charts, and detecting data health issues.

- **Provider Agnostic**:
  - **Google Gemini**: Connect using a Google AI Studio API key (`gemini-2.5-flash`, `gemini-2.5-pro`, or latest models).
  - **OpenAI-Compatible Endpoints**: Connect to any local or remote OpenAI-compatible server (e.g. **Ollama**, **LM Studio**, **vLLM**, **Anthropic** proxies, or **OpenRouter**).
- **In-App Model Discovery**:
  - Automatically fetch and select from available models directly from your endpoint URL.
- **Local Security**:
  - API keys are stored in the **OS native credential store** (Windows Credential Manager, macOS Keychain, or the Linux Secret Service) and used exclusively by the Rust host; they are never written to a settings file, transmitted to third-party telemetry servers, or exposed to renderer scripts. Only a masked tail hint (last 4 characters) ever reaches the UI.

---

## Getting Started

### Prerequisites

- **Node.js**: `24.x` or later (tested on 24.18.0)
- **CPython**: `3.12.x` (tested on 3.12.14)
- **Package Managers**: `npm` and either `uv` (recommended) or standard `pip`

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/ARAEcosystem/arastat.git
cd arastat
npm install
```

### 2. Set Up the Python Statistical Engine

The statistical engine runs inside a dedicated virtual environment at `engine/.venv`.

**Using `uv` (Recommended - fast):**

```bash
uv venv engine/.venv --python 3.12
uv pip install --python engine/.venv -r engine/requirements.txt
```

**Using standard Python `venv`:**

On Windows:

```powershell
python3.12 -m venv engine\.venv
engine\.venv\Scripts\python.exe -m pip install -r engine\requirements.txt
```

On macOS / Linux:

```bash
python3.12 -m venv engine/.venv
engine/.venv/bin/python -m pip install -r engine/requirements.txt
```

---

## Development & Test Commands

```bash
# Start the Tauri v2 desktop app in development mode with HMR
npm run dev

# Build a signed Windows installer (NSIS) + updater artifacts
npm run build

# Build just the frontend bundle (src/ -> dist/)
npm run build:vite

# Run full TypeScript typecheck
npm run typecheck

# Run unit and golden-reference integration tests
npm test

# Run the Rust host + live-engine seam tests
npm run test:rust

# Regenerate the tier-2 reference fixtures (writes tests/fixtures/tier2)
engine/.venv/Scripts/python.exe engine/generate_fixtures.py   # Windows
engine/.venv/bin/python engine/generate_fixtures.py          # macOS / Linux
```

### Updater signing keys

`npm run build` signs the update package with a Minisign key. Generate a
keypair once and keep the private key outside the repo:

```bash
npx tauri signer generate -w ~/.tauri/arastat.key
```

Then export the private key (and its password, if set) for the release build, and
paste the printed **public** key into `plugins.updater.pubkey` in
`src-tauri/tauri.conf.json`:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/arastat.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
```

Publish the resulting `.exe`, its `.sig`, and a `latest.json` manifest to the
GitHub release the `endpoints` list points at. Without a key, the updater stays
disabled and the app makes zero update requests at startup.

To exercise the real check/download/verify path without publishing a release,
point a **debug** run at any static `latest.json` (served over plain HTTP for
local testing only — Tauri warns about that on a debug build and refuses it in
release):

```bash
ARASTAT_UPDATE_ENDPOINT="http://127.0.0.1:8099/latest.json" npm run dev
```

A manifest advertising a version whose artifact is not signed for that exact
version is rejected by Minisign verification, which is the expected outcome of
mismatched test fixtures.

---

## Architecture

ARAStat separates presentation, orchestration, and statistical calculation into three decoupled layers:

```
┌────────────────────────────────────────────────────────┐
│                  WebView Frontend (Vue 3.5)            │
│         Vue 3.5 + TypeScript + Vanilla CSS UI          │
│  (DataGrid, VariableView, ResultsPane, AiDock, Specs)  │
│  Pure Web I/O: .sav/.xlsx/.csv/.arastat via DataView   │
└───────────────────────────▲────────────────────────────┘
                            │  Tauri v2 IPC
                            │  (typed commands + raw ArrayBuffer)
┌───────────────────────────▼────────────────────────────┐
│                 ARAStat Host (Rust / Tauri v2)         │
│  - Native dialogs + binary file I/O (OS picker, no fs  │
│    scope errors)                                       │
│  - Async NDJSON-RPC client + Python process lifecycle  │
│    guarded by a Windows Job Object (kill-on-close)     │
│  - AI proxy (Gemini + OpenAI-compatible + LAN HTTP)    │
│  - API key in the OS credential store, never on disk   │
│  - Signed updater (@tauri-apps/plugin-updater, Minisign)│
└───────────────────────────▲────────────────────────────┘
                            │  JSON-RPC over stdin/stdout
┌───────────────────────────▼────────────────────────────┐
│                Native Python Stats Engine              │
│                  CPython 3.12 Subprocess               │
│        NumPy, SciPy, statsmodels, pandas, patsy        │
│  (25 golden-reference analyses + registered extras)    │
└────────────────────────────────────────────────────────┘
```

- **Fail-Safe Startup**: The UI window is shown independently of engine initialization. If Python fails or is missing, the application reports the condition with clear recovery instructions rather than crashing.
- **Zero Zombie Processes**: On Windows the engine is bound to a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so the kernel terminates `python.exe` the moment ARAStat exits or is force-killed.
- **Strict Error Handling**: The IPC boundary rejects with `{ code, message, userMessage, detail }`, preserving user-facing engine guidance verbatim (e.g., error `1004` when a 2-group test receives 3+ distinct levels).
- **One Update Modal**: The active update prompt and the post-restart changelog share the single-window Vue modal in `UpdateRestartModal.vue`; no second OS window is spawned.

---

## Privacy & Security

- **Offline-First Execution**: Statistical tests run locally through the bundled Python engine. No network connection is required for data entry, transformations, imports, or computations.
- **Zero Telemetry**: No analytics, tracking beacons, error monitoring services, or telemetry endpoints exist anywhere in ARAStat.
- **Sanitized Exports**: CSV and text exports automatically escape leading formula triggers (`=`, `+`, `-`, `@`, `\t`, `\r`) to protect users from CSV formula injection vulnerabilities.

### Third-Party AI & Zero Data Retention (ZDR) Disclaimer

ARAStat is fundamentally an **offline-first, privacy-first** application. All statistical calculations, data transformations, and file I/O operations are performed exclusively on your local machine.

However, ARAStat includes an optional **AI Copilot (ARA Assistant)** feature that allows you to connect external language model providers (e.g., Google Gemini, OpenAI-compatible APIs, or cloud proxies).

> [!WARNING]
> **User Responsibility & Consent Regarding Non-ZDR AI Endpoints:**
>
> 1. **Direct Connection**: When you configure and prompt an external cloud AI service, statistical excerpts and variables are transmitted directly from your computer to that third-party provider under your own API credentials.
> 2. **Zero Data Retention (ZDR)**: If you connect to an external provider that does **not** enforce a Zero Data Retention (ZDR) policy or an enterprise business agreement, your data may be logged, retained, or processed according to that third party's terms of service and training policies.
> 3. **Disclaimer of Liability**: ARAStat and its author (**Adhi Rahmadian**) are **not responsible** for how third-party AI providers collect, retain, store, or utilize data transmitted through user-configured endpoints. The user assumes sole responsibility for selecting and vetting AI providers to ensure compliance with their institutional, regulatory, and privacy requirements.
> 4. **100% Offline AI Alternative**: If you work with sensitive, clinical, or proprietary datasets and require guaranteed Zero Data Retention, you should exclusively use **local offline engines** (such as **Ollama** or **LM Studio**)

---

## Author & Creator

Created and maintained by **[Adhi Rahmadian](https://adhirahmadian.id)**.

---

## License

ARAStat is free and open-source software licensed under the **[GNU General Public License v3.0 or later (GPL-3.0-or-later)](LICENSE)**.

Copyright (C) 2026 **Adhi Rahmadian** ([https://adhirahmadian.id](https://adhirahmadian.id)).
