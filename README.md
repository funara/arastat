# ARAStat

<p align="center">
  <img src="src/renderer/public/ARAStat.png" alt="ARAStat Logo" width="380" />
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

**ARAStat** is an open-source, offline-first desktop statistical analysis software designed as a fast, accessible, and privacy-conscious alternative to traditional tools like SPSS, JASP, and Jamovi. Built with an Electron and Vue frontend backed by a verified native Python statistical engine, ARAStat combines spreadsheet data management with 23 statistical tests, publication-ready output tables, interactive Plotly visualizations, and an AI copilot (**ARA Assistant**).

---

## Key Features

- **Dual-View Spreadsheet Workspace**:
  - **Data View**: High-performance grid for data entry, row/column transformations, filtering, and sorting.
  - **Variable View**: SPSS-grade variable metadata definition (name, type, width, decimal places, value labels, user-missing sentinels, and measurement scales: Nominal, Ordinal, Scale).
- **23 Native Statistical Analyses**:
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

ARAStat implements 23 statistical procedures with golden-reference fixture tests verifying exact mathematical alignment against R and SPSS outputs:

| Category                         | Analyses Included                                                                                                                                                    |
| :------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Descriptive & Frequencies**    | Descriptive Statistics, Frequency Tables                                                                                                                             |
| **Comparing Means (Parametric)** | One-Sample t-test, Paired-Samples t-test, Independent-Samples t-test, One-Way ANOVA, Welch ANOVA, Two-Way Factorial ANOVA                                            |
| **Non-Parametric Tests**         | Mann-Whitney U, Wilcoxon Signed-Rank, Wilcoxon One-Sample, Kruskal-Wallis H, Friedman ANOVA                                                                          |
| **Correlation & Association**    | Pearson & Spearman Correlation, Kendall's Tau-b, Chi-Square Test of Independence, Chi-Square Goodness of Fit, Fisher's Exact Test (2×2), McNemar Test, Binomial Test |
| **Regression Modeling**          | Linear Regression (OLS), Binary Logistic Regression                                                                                                                  |
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
  - API keys are stored in encrypted local storage and handled exclusively in the main Electron process; keys are never transmitted to third-party telemetry servers or exposed to renderer scripts.

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

> **Note on Windows / Electron Install**: If your npm policy restricts lifecycle scripts (`allowScripts`), run `node node_modules/electron/install.js` once so Electron can download its local binary.

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
# Start desktop app in development mode with HMR
npm run dev

# Run full TypeScript typecheck
npm run typecheck

# Run unit and golden-reference integration tests (109 tests)
npm test

# Build production bundle for Main, Preload, and Renderer
npm run build

# Package desktop installer / portable executable
npm run dist
npm run dist:win
```

---

## Architecture

ARAStat separates presentation, orchestration, and statistical calculation into three decoupled layers:

```
┌────────────────────────────────────────────────────────┐
│                   Renderer Process                     │
│         Vue 3.5 + TypeScript + Vanilla CSS UI          │
│  (DataGrid, VariableView, ResultsPane, AiDock, Specs)  │
└───────────────────────────▲────────────────────────────┘
                            │  ContextBridge IPC
┌───────────────────────────▼────────────────────────────┐
│                     Main Process                       │
│    Electron 44 + Node 24 Sandboxed Orchestration       │
│  - File I/O & Binary Serialization (.sav, .xlsx, .csv) │
│  - Secure AI Adapter (Gemini & OpenAI-compatible SSE)  │
│  - Subprocess Lifecycle & IPC Bridge                   │
└───────────────────────────▲────────────────────────────┘
                            │  JSON-RPC over stdin/stdout
┌───────────────────────────▼────────────────────────────┐
│                Native Python Stats Engine              │
│                  CPython 3.12 Subprocess               │
│        NumPy, SciPy, statsmodels, tabulate, math       │
│   (23 Verified Statistical Analyses + Error Traps)     │
└────────────────────────────────────────────────────────┘
```

- **Fail-Safe Startup**: The UI window is shown independently of engine initialization. If Python fails or is missing, the application notifies the user with clear recovery instructions rather than crashing.
- **Strict Error Handling**: Electron's invoke boundaries return typed engine exceptions preserving user-friendly guidance (e.g., error 1004 when a 2-group test receives 3+ distinct levels).

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
