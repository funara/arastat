# Changelog

All notable changes to **ARAStat** are documented in this file.

The release note format below (`###` headings, `- **NEW**:`, `- **FIX**:`, `**bold**`, and `` `code` ``) is parsed directly by [`src/UpdateRestartModal.vue`](src/UpdateRestartModal.vue) when pasted into a GitHub Release body.

---

## [0.1.0] — 2026-10-20

First public release of **ARAStat** — a privacy-first, 100% local ergonomics desktop statistical workbench with a provider-agnostic AI copilot.

### Statistical Engine & Procedures (27 Local Tests)

- **NEW**: **100% Local Python Sidecar (`ara_engine`)** — All statistical computations execute offline using NumPy and SciPy with deterministic precision (`1e-9` golden reference parity) and zero data telemetry.
- **NEW**: **Descriptives & Normality** — Descriptive Statistics (`M`, `SD`, skewness, kurtosis, IQR), Frequency Tables with cumulative percentages, and standalone **Shapiro-Wilk Normality** tests.
- **NEW**: **Parametric Group Comparisons** — One-Sample `t`-test, Independent-Samples `t`-test (with Welch's `t`, Cohen's `d`, and 95% CI), Paired-Samples `t`-test, One-Way ANOVA (with `\eta^2` and `\omega^2`), **Welch's ANOVA**, **Tukey HSD** post-hoc comparisons, and **Two-Way Factorial ANOVA** (`A * B` interaction and main effects).
- **NEW**: **Non-Parametric Procedures** — Mann-Whitney `U`, Wilcoxon Signed-Rank (paired and one-sample), Kruskal-Wallis `H`, Friedman repeated-measures test, and Exact Binomial test.
- **NEW**: **Correlation & Regression** — Pearson `r` correlation matrix, **Spearman's rank (`\rho`)**, **Kendall's `\tau`**, Ordinary Least Squares (**Linear Regression**) with `R^2` and Durbin-Watson diagnostics, and Binary **Logistic Regression** (Logit & Probit with odds ratios).
- **NEW**: **Psychometrics & Contingency Tables** — **Scale Reliability Analysis** (Cronbach's `\alpha` with 95% CI, McDonald's `\omega`, and item-rest diagnostics), **Exploratory Factor Analysis (`EFA / PCA`)** with KMO, Bartlett's test, Varimax rotation, and Scree Plot, plus **Chi-Square** (Independence & Goodness-of-Fit), **Fisher's Exact (`2x2`)**, and **McNemar's** paired binary test.

### Interactive Results Workbench & APA 7th Output

- **NEW**: **Executive Verdict Chip** — Instant one-line APA 7th citation (`t(118) = -3.42, p < .001`) with a `Significant` / `Not significant` badge and 1-click citation copy on every inferential run.
- **NEW**: **Structured Assumption Pills & 1-Click Robust Fallback** — Automatically parses Shapiro-Wilk normality, Levene variance homogeneity, and Durbin-Watson checks into color-coded status pills (`✓` / `⚠`) with a 1-click **`Switch to <Robust Test> →`** action when assumptions are violated.
- **NEW**: **Publication-Ready APA 7th Tables** — Three-line rule tables with italicized statistical symbols (`M`, `SD`, `t`, `F`, `p`, `df`, `r`, `R^2`), dynamic decimal precision switcher (`2 | 3 | 4` decimals), per-table and per-run rich clipboard copy (`text/html` + `text/plain` for Word, Google Docs, and Excel), and standalone HTML report export.
- **NEW**: **Stale Run Tracking & Re-Run** — Automatically detects dataset edits after an analysis is run and offers a 1-click **`↻ Re-run (data changed)`** badge while preserving companion plots and missing-value policies.

### Guided Analyze & Statistical Test Advisor

- **NEW**: **Statistical Test Advisor** — Evaluates variable measurement levels, distinct group counts (`2` groups vs. `3+` groups), sample completeness, and live normality/variance assumptions (`diagnose`) to recommend the optimal parametric or non-parametric test.
- **NEW**: **Smart Analysis Dialog** — Schema-driven dialog for all 27 procedures featuring keyboard/click `▸` shuttle buttons, incompatible variable dimming, live group-level verification, completeness forecast (`n / N complete cases`), listwise/pairwise missing policy selector, and automatic companion plots.

### Data Editor, Transforms & Visualization

- **NEW**: **Dual Data View & Variable View** — Virtualized spreadsheet grid with SPSS-style cross-view navigation, measurement level badges (`Scale`, `Ordinal`, `Nominal`), value labels (`0 = Control`), user-missing value sentinels, and full `Undo` / `Redo` history.
- **NEW**: **Data Health & Quality Advisor** — Automated dataset scanner detecting unlabeled category codes, measure mismatches, extreme numeric sentinels (`999`, `-99`), dirty category casing/whitespace, and continuous outliers with 1-click guided fixes.
- **NEW**: **Data & Transform Suite** — Safe CSP-compliant formula evaluator (`Compute column`), `Log` / `Z-score` / `Binning` transforms, smart missing-value imputation (`Mean`, `Median`, `Mode`, linear interpolation), `Recode` (same or new column), multi-column sorting, and missing-row filtering.
- **NEW**: **Interactive Visualizer** — Local Plotly chart builder (`Scatter` with optional **OLS trendline**, **Mean Bar Chart**, `Line`, `Histogram`, and grouped `Boxplot`) with `Group / Color by` multi-trace splitting, user-missing sentinel filtering, theme-reactive palette, native PNG export, and round-trip editing of charts pinned to Results.
- **NEW**: **Multi-Format I/O** — Native support for `.sav` (SPSS compressed binary with long variable names and metadata), `.csv` / `.tsv` (RFC 4180 with formula-injection protection), `.xlsx` (with metadata sheet round-tripping), `.arastat` project archives, and 5 built-in sample datasets.

### Provider-Agnostic AI Assistant & Security

- **NEW**: **ARA Assistant Dock** — Context-aware statistical copilot that proposes executable analysis cards, explains results in plain or academic prose, and inserts APA narrative interpretations directly into Result cards—never transmitting raw dataset rows.
- **NEW**: **Cloud & Local AI Parity** — Supports Google Gemini, OpenAI, Anthropic, OpenRouter, and keyless local loopback servers (`Ollama` at `localhost:11434` and `LM Studio` at `localhost:1234`) with OS native keychain storage for API keys.
- **NEW**: **Signed Auto-Updater** — Cryptographically verified NSIS installer updates via GitHub Releases with an in-app download progress prompt and post-restart changelog viewer.
