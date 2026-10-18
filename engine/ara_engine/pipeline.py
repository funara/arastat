"""run_analysis pipeline: data validation, missing policy, result tree.

Error codes: 1001 invalid spec (registry.validate_spec), 1003 invalid data
(DataError), 1004 numeric failure (NumericError, plus guarded fit failures).
"""

from __future__ import annotations

import numpy as np

from .registry import ANALYSES, SpecError, TITLES, validate_spec
from .statslib import HANDLERS, DataError, NumericError, is_missing
from .insights import ChartError, render_chart_svg, render_scree_svg

MISSING_POLICIES = ("listwise", "pairwise")


class AnalysisFailure(Exception):
    """A domain error carrying (code, user_message, detail)."""

    def __init__(self, code: int, user_message: str, detail: str | None = None):
        super().__init__(user_message)
        self.code = code
        self.user_message = user_message
        self.detail = detail


def _columns(spec, data, analysis_id: str) -> list[str]:
    """Variable names this analysis reads, in spec order."""
    names: list[str] = []
    for key, kind in ANALYSES[analysis_id].items():
        if kind[0] == "str":
            names.append(spec[key])
        elif kind[0] == "str_list":
            names.extend(spec[key])
    # Summary-row columns read by two analyses when present.
    if analysis_id == "binomial" and "null_probability" in data:
        names.append("null_probability")
    if analysis_id == "wilcoxon_one_sample" and "hypothesized_mu" in data:
        names.append("hypothesized_mu")
    seen: list[str] = []
    for name in names:
        if name not in seen:
            seen.append(name)
    return seen


def _validate_data(spec, data, analysis_id: str) -> None:
    if not isinstance(data, dict) or not data:
        raise AnalysisFailure(
            1003,
            "No data arrived with this run. Open a dataset and run again.",
            "data is empty or not an object",
        )
    ragged = [name for name, v in data.items() if not isinstance(v, list)]
    if ragged:
        raise AnalysisFailure(
            1003,
            f"Variable “{ragged[0]}” is not a column of values. Reimport the data and run again.",
            f"non-list columns {ragged}",
        )
    lengths = {len(v) for v in data.values()}
    if len(lengths) > 1:
        raise AnalysisFailure(
            1003,
            "The dataset columns have unequal lengths. Reimport the data and run again.",
            f"ragged column lengths {sorted(lengths)}",
        )
    for name in _columns(spec, data, analysis_id):
        if name not in data:
            raise AnalysisFailure(
                1003,
                f"Variable “{name}” is not in the dataset. Choose an available variable.",
                f"column {name!r} missing from data",
            )
        if len(data[name]) == 0:
            raise AnalysisFailure(
                1003,
                f"Variable “{name}” has no rows. Choose a variable with data.",
                f"column {name!r} is empty",
            )
    if analysis_id == "frequencies":
        return  # reports missingness itself
    for name in _columns(spec, data, analysis_id):
        if all(is_missing(v) for v in data[name]):
            raise AnalysisFailure(
                1004,
                f"Variable “{name}” has no non-missing values. Choose a variable with data.",
                f"column {name!r} is all-missing",
            )


def _apply_missing_policy(spec, data: dict, analysis_id: str, policy: str) -> dict:
    cols = _columns(spec, data, analysis_id)
    if analysis_id == "frequencies":
        # Reports missing values itself: pass every row through untouched.
        return {name: list(data[name]) for name in cols}
    if analysis_id == "correlation" or policy == "pairwise":
        # Pairwise filtering happens inside the handler.
        return {name: list(data[name]) for name in cols}
    # listwise: drop rows missing in any referenced column
    length = len(data[cols[0]])
    keep = [
        i
        for i in range(length)
        if all(not is_missing(data[name][i]) for name in cols)
    ]
    if len(keep) == 0:
        raise AnalysisFailure(
            1003,
            "No complete rows remain after removing missing values. Check the missing-value rules.",
            "listwise filtering removed every row",
        )
    return {name: [data[name][i] for i in keep] for name in cols}


# --- result tree (§8) -------------------------------------------------------


def _table(address: str, caption: str, columns: list[str], rows: list[list], footnotes=None) -> dict:
    return {
        "op": "upsert",
        "address": address,
        "element": {
            "address": address,
            "status": "ok",
            "kind": "table",
            "caption": caption,
            "columns": columns,
            "rows": rows,
            "footnotes": footnotes or [],
        },
    }


def _note(address: str, text: str) -> dict:
    return {
        "op": "upsert",
        "address": address,
        "element": {"address": address, "status": "ok", "kind": "note", "text": text},
    }


def error_patches(run_id: str, user_message: str, detail: str | None) -> list[dict]:
    """One error element patch for a failed run (§8: userMessage + fix affordance)."""
    address = f"{run_id}/error/1"
    return [
        {
            "op": "upsert",
            "address": address,
            "element": {
                "address": address,
                "status": "error",
                "kind": "error",
                "userMessage": user_message,
                "detail": detail,
            },
        }
    ]

def _chart_patch(run_id: str, chart, data: dict) -> dict:
    """Chart patch for a run (AI chart spec → inline SVG, same update stream)."""
    address = f"{run_id}/chart/1"
    try:
        svg, caption = render_chart_svg(chart, data)
    except ChartError as exc:
        return {
            "op": "upsert",
            "address": address,
            "element": {"address": address, "status": "ok", "kind": "note",
                        "text": f"Chart not drawn. {exc.user_message}"},
        }
    except Exception:  # seam must survive any render failure
        return {
            "op": "upsert",
            "address": address,
            "element": {"address": address, "status": "ok", "kind": "note",
                        "text": "Chart not drawn. Check the chart columns and run again."},
        }
    return {
        "op": "upsert",
        "address": address,
        "element": {"address": address, "status": "ok", "kind": "chart",
                    "caption": caption, "svg": svg},
    }


def _fmt_p(p):
    if p is None:
        return "-"
    return "< .001" if p < 0.001 else f"{p:.3f}".removeprefix("0")


def _assumption_patches(run_id: str, address: str, analysis_id: str, spec, cols: dict) -> list[dict]:
    """One assumption-check note for parametric analyses (patches only).

    Stats mirrors stay golden-exact; classic checks (Shapiro, Levene,
    Breusch-Pagan, Durbin-Watson) ride the existing note element so the AI
    narrative path (explainRun → shared normalizer) can quote them.
    Uncomputable on thin data → no patch, never a failed run.
    """
    from .insights import diagnose as _diagnose

    if analysis_id not in ("ttest_onesample", "ttest_independent", "ttest_paired", "anova_oneway", "linear_regression"):
        return []
    try:
        group = {"ttest_independent": spec.get("group"), "anova_oneway": spec.get("factor")}.get(analysis_id)
        diag = _diagnose({k: list(v) for k, v in cols.items()}, group, None)
    except Exception:
        return []
    bits: list[str] = []
    normality = diag.get("normality") or {}
    seen_p = [n["p"] for n in normality.values() if isinstance(n, dict) and n.get("p") is not None]
    if seen_p:
        bits.append(f"normality (Shapiro-Wilk) p = {_fmt_p(min(seen_p))}")
    homogeneity = diag.get("homogeneity")
    if isinstance(homogeneity, dict) and homogeneity.get("p") is not None:
        bits.append(f"equal variances (Levene) p = {_fmt_p(homogeneity['p'])}")
    regression = diag.get("regression")
    if isinstance(regression, dict):
        if regression.get("bpP") is not None:
            bits.append(f"constant variance (Breusch-Pagan) p = {_fmt_p(regression['bpP'])}")
        if regression.get("durbinWatson") is not None:
            bits.append(f"serial independence (Durbin-Watson) = {regression['durbinWatson']:.2f}")
    serial = diag.get("serial") or {}
    if not isinstance(regression, dict):
        for name, slot in serial.items():
            if isinstance(slot, dict) and slot.get("ljungBoxP") is not None:
                bits.append(f"serial independence (Ljung-Box) p = {_fmt_p(slot['ljungBoxP'])}")
                break
    if not bits:
        return []
    text = "Assumption checks: " + "; ".join(bits) + "."
    return [_note(address, text)]
    return "< .001" if p < 0.001 else f"{p:.3f}".removeprefix("0")


def _result_elements(run_id: str, analysis_id: str, spec, stats) -> list[dict]:
    """Build §8 result-tree patches for a successful run (house APA style)."""
    out: list[dict] = []
    title = TITLES[analysis_id]
    base = run_id

    if analysis_id == "descriptives":
        rows = [[name, s["n"], s["mean"], s["sd"]] for name, s in stats["variables"].items()]
        out.append(
            _table(
                f"{base}/table/1",
                "Descriptive statistics",
                ["Variable", "n", "M", "SD"],
                rows,
                ["Note. SD is the sample standard deviation (ddof = 1)."],
            )
        )
        out.append(_note(f"{base}/note/1", f"{title} summarized {len(stats['variables'])} variables."))
    elif analysis_id == "frequencies":
        for i, (name, s) in enumerate(stats["variables"].items(), start=1):
            rows = [[lv, s["counts"][lv], s["percent"][lv], s["validPercent"][lv]] for lv in s["counts"]]
            out.append(
                _table(
                    f"{base}/table/{i}",
                    f"Frequency table - {name}",
                    ["Level", "n", "Percent", "Valid percent"],
                    rows,
                    [
                        f"Note. Valid N = {s['validN']}, missing = {s['missingN']}. "
                        "Percent uses all rows as the denominator; valid percent uses valid rows."
                    ],
                )
            )
    elif analysis_id == "ttest_onesample":
        out.append(
            _table(
                f"{base}/table/1",
                f"One-sample t-test - {spec['dep']}",
                ["n", "M", "SD", "t", "df", "p"],
                [[stats["n"], stats["mean"], stats["sd"], stats["t"], stats["df"], stats["p"]]],
                [
                    f"Note. Test value = {stats['testValue']}. "
                    f"95% CI of the mean difference [{stats['ciLower']}, {stats['ciUpper']}]."
                ],
            )
        )
        p = stats["p"]
        out.append(
            _note(
                f"{base}/note/1",
                f"The mean {'differs' if p < 0.05 else 'does not differ significantly'} "
                f"from the test value (p = {_fmt_p(p)}).",
            )
        )
    elif analysis_id == "ttest_independent":
        rows = [[name, s["n"], s["mean"], s["sd"]] for name, s in stats["groups"].items()]
        out.append(
            _table(
                f"{base}/table/1",
                f"Independent-samples t-test - {spec['dep']}",
                ["Group", "n", "M", "SD"],
                rows,
                [f"Note. Grouping variable: {spec['group']}. Cohen’s d = {stats['cohensD']:.3f}."],
            )
        )
        out.append(
            _table(
                f"{base}/table/2",
                "Test results",
                ["", "t", "df", "p"],
                [
                    [f"{spec['dep']} (Student’s)", stats["student"]["t"], stats["student"]["df"], stats["student"]["p"]],
                    [f"{spec['dep']} (Welch’s)", stats["welch"]["t"], stats["welch"]["df"], stats["welch"]["p"]],
                ],
                ["Note. Mean difference is the first group minus the second group in data order."],
            )
        )
    elif analysis_id == "ttest_paired":
        out.append(
            _table(
                f"{base}/table/1",
                f"Paired-samples t-test - {spec['a']} vs {spec['b']}",
                ["n pairs", "M A", "M B", "M diff", "t", "df", "p"],
                [[stats["nPairs"], stats["meanA"], stats["meanB"], stats["meanDiff"], stats["t"], stats["df"], stats["p"]]],
                [f"Note. Differences are A minus B. Cohen’s dz = {stats['cohensDz']:.3f}."],
            )
        )
    elif analysis_id == "anova_oneway":
        rows = [[g, s["n"], s["mean"], s["sd"]] for g, s in stats["groups"].items()]
        out.append(
            _table(
                f"{base}/table/1",
                f"One-way ANOVA - {spec['dep']}",
                ["Group", "n", "M", "SD"],
                rows,
                [f"Note. Grouping variable: {spec['factor']}. η² = {stats['etaSquared']:.3f}."],
            )
        )
        out.append(
            _table(
                f"{base}/table/2",
                "ANOVA summary",
                ["F", "df1", "df2", "p"],
                [[stats["F"], stats["df1"], stats["df2"], stats["p"]]],
            )
        )
    elif analysis_id == "chisq_independence":
        out.append(
            _table(
                f"{base}/table/1",
                f"Chi-square test of independence - {spec['row']} × {spec['col']}",
                [""] + stats["colLevels"],
                [[rl] + row for rl, row in zip(stats["rowLevels"], stats["observed"])],
                [
                    f"Note. Cramér’s V = {stats['cramersV']:.3f}. "
                    f"n = {stats['n']}, χ²({stats['df']}) = {stats['chi2']:.3f}, p = {_fmt_p(stats['p'])}."
                ],
            )
        )
    elif analysis_id == "correlation":
        out.append(
            _table(
                f"{base}/table/1",
                "Correlation matrix (Pearson)",
                stats["variables"],
                [list(row) for row in stats["rMatrix"]],
                ["Note. Pairwise complete observations; the p and n matrices mirror this layout."],
            )
        )
    elif analysis_id == "shapiro_wilk":
        out.append(
            _table(
                f"{base}/table/1",
                f"Shapiro-Wilk normality test - {spec['dep']}",
                ["n", "W", "p"],
                [[stats["n"], stats["W"], stats["p"]]],
            )
        )
    elif analysis_id == "spearman_correlation":
        out.append(
            _table(
                f"{base}/table/1",
                f"Spearman rank correlation - {spec['a']} × {spec['b']}",
                ["n", "rho", "p"],
                [[stats["n"], stats["rho"], stats["p"]]],
            )
        )
    elif analysis_id == "linear_regression":
        rows = [[term, s["coef"], s["SE"], s["t"], s["p"]] for term, s in stats["terms"].items()]
        out.append(
            _table(
                f"{base}/table/1",
                f"Linear regression - {spec['dep']}",
                ["Term", "Coef", "SE", "t", "p"],
                rows,
                [f"Note. n = {stats['n']}, R² = {stats['r2']:.3f}, adjusted R² = {stats['adjR2']:.3f}."],
            )
        )
    elif analysis_id == "mannwhitney_u":
        out.append(
            _table(
                f"{base}/table/1",
                f"Mann-Whitney U test - {spec['dep']}",
                ["U", "p"],
                [[stats["U"], stats["p"]]],
                ["Note. Exact two-sided p; groups in data order."],
            )
        )
    elif analysis_id == "wilcoxon_signedrank":
        out.append(
            _table(
                f"{base}/table/1",
                f"Wilcoxon signed-rank test - {spec['a']} vs {spec['b']}",
                ["n used", "Statistic", "p"],
                [[stats["nUsed"], stats["statistic"], stats["p"]]],
                ["Note. Zero differences are removed (zero_method = wilcox); approximate p."],
            )
        )
    elif analysis_id == "kruskal_wallis":
        rows = [[g, s["n"]] for g, s in stats["groups"].items()]
        out.append(
            _table(
                f"{base}/table/1",
                f"Kruskal-Wallis test - {spec['dep']}",
                ["Group", "n"],
                rows,
                [f"Note. H = {stats['H']:.3f}, df = {stats['df']}, p = {_fmt_p(stats['p'])}."],
            )
        )
    elif analysis_id == "chisq_gof":
        rows = [[lv, stats["observed"][lv], stats["expected"][lv]] for lv in stats["observed"]]
        out.append(
            _table(
                f"{base}/table/1",
                f"Chi-square goodness of fit - {spec['variable']}",
                ["Level", "Observed", "Expected"],
                rows,
                [f"Note. n = {stats['n']}, χ²({stats['df']}) = {stats['chi2']:.3f}, p = {_fmt_p(stats['p'])}."],
            )
        )
    elif analysis_id == "fisher_exact_2x2":
        out.append(
            _table(
                f"{base}/table/1",
                "Fisher’s exact test (2×2)",
                ["", "Col 1", "Col 2"],
                [["Row 1", stats["a"], stats["b"]], ["Row 2", stats["c"], stats["d"]]],
                [f"Note. Odds ratio = {stats['odds_ratio']}, p = {_fmt_p(stats['p'])} ({stats['alternative']})."],
            )
        )
    elif analysis_id == "mcnemar":
        out.append(
            _table(
                f"{base}/table/1",
                "McNemar’s test",
                ["", "After 1", "After 2"],
                [["Before 1", stats["a"], stats["b"]], ["Before 2", stats["c"], stats["d"]]],
                [f"Note. Exact p = {_fmt_p(stats['exact_p'])}; χ² p = {_fmt_p(stats['chi2_p'])}."],
            )
        )
    elif analysis_id == "binomial":
        out.append(
            _table(
                f"{base}/table/1",
                "Binomial test",
                ["n", "k", "p0", "Proportion", "p"],
                [[stats["n"], stats["k"], stats["p0"], stats["proportion"], stats["p"]]],
                [f"Note. Exact 95% CI [{stats['ci_95']['lower']}, {stats['ci_95']['upper']}]."],
            )
        )
    elif analysis_id == "wilcoxon_one_sample":
        out.append(
            _table(
                f"{base}/table/1",
                "One-sample Wilcoxon signed-rank test",
                ["n used", "n obs", "Statistic", "p"],
                [[stats["n"], stats["n_observations"], stats["statistic"], stats["p"]]],
                [f"Note. mu = {stats['mu']}, zero_method = {stats['zero_method']}, method = {stats['method']}."],
            )
        )
    elif analysis_id == "friedman":
        out.append(
            _table(
                f"{base}/table/1",
                "Friedman test",
                ["n", "k", "Statistic", "df", "p"],
                [[stats["n"], stats["k"], stats["statistic"], stats["df"], stats["p"]]],
            )
        )
    elif analysis_id == "kendall_tau":
        out.append(
            _table(
                f"{base}/table/1",
                "Kendall’s tau",
                ["n", "tau", "p"],
                [[stats["n"], stats["tau"], stats["p"]]],
                [f"Note. Variant {stats['variant']}, method {stats['method']}."],
            )
        )
    elif analysis_id == "welch_anova":
        rows = [[g, s["n"], s["mean"], s["sd"]] for g, s in stats["groups"].items()]
        out.append(
            _table(
                f"{base}/table/1",
                f"Welch’s ANOVA - {spec['dep']}",
                ["Group", "n", "M", "SD"],
                rows,
                [
                    f"Note. F = {stats['F']:.3f}, df = ({stats['df1']}, {stats['df2']}), "
                    f"p = {_fmt_p(stats['p'])}. Variances assumed unequal."
                ],
            )
        )
    elif analysis_id == "tukey_hsd":
        rows = [
            [p["group1"], p["group2"], p["mean_difference"], p["p_adjusted"], "yes" if p["reject"] else "no"]
            for p in stats["pairs"]
        ]
        out.append(
            _table(
                f"{base}/table/1",
                f"Tukey HSD - {spec['dep']}",
                ["Group 1", "Group 2", "Mean diff", "p adj", "Reject"],
                rows,
                [f"Note. alpha = {stats['alpha']}."],
            )
        )
    elif analysis_id == "factorial_anova_2way":
        for i, typ in enumerate(("typ_2", "typ_3"), start=1):
            rows = [[term, s["SS"], s["df"], s["F"], s["p"]] for term, s in stats[typ].items()]
            out.append(
                _table(
                    f"{base}/table/{i}",
                    f"Two-way ANOVA ({'Type II' if typ == 'typ_2' else 'Type III'}) - {stats['formula']}",
                    ["Term", "SS", "df", "F", "p"],
                    rows,
                )
            )
    elif analysis_id == "logistic_regression":
        rows = [
            [term, s["coef"], s["SE"], s["z"], s["p"], s["odds_ratio"]]
            for term, s in stats["terms"].items()
        ]
        out.append(
            _table(
                f"{base}/table/1",
                f"Logistic regression - {spec['dep']}",
                ["Term", "Coef", "SE", "z", "p", "Odds ratio"],
                rows,
                [f"Note. n = {stats['n']}, McFadden pseudo R² = {stats['mcfadden_pseudo_r2']:.3f}."],
            )
        )
    elif analysis_id == "reliability_cronbach":
        alpha = stats["alpha"]
        out.append(
            _table(
                f"{base}/table/1",
                "Reliability Statistics",
                ["α", "95% CI", "Standardized α", "McDonald’s ω_t", "N of Items", "Valid N"],
                [
                    [
                        alpha,
                        f"[{stats['ciLower']}, {stats['ciUpper']}]",
                        stats["standardizedAlpha"],
                        stats["omega"],
                        stats["k"],
                        stats["n"],
                    ]
                ],
                [
                    "Note. α is Cronbach’s coefficient alpha; the interval is Feldt’s (1965) exact "
                    "F-based 95% CI. ω_t is McDonald’s total omega from a single-factor solution."
                ],
            )
        )
        item_rows = [
            [
                s["name"],
                s["itemMean"],
                s["itemSd"],
                s["scaleMeanIfDeleted"],
                s["scaleVarianceIfDeleted"],
                s["correctedItemTotal"],
                s["alphaIfDeleted"],
            ]
            for s in stats["items"]
        ]
        flagged = [
            s["name"]
            for s in stats["items"]
            if (s["correctedItemTotal"] is not None and s["correctedItemTotal"] < 0.30)
            or (s["alphaIfDeleted"] is not None and alpha is not None and s["alphaIfDeleted"] > alpha)
        ]
        footnotes = [
            "Note. Corrected item-total r correlates the item with the sum of the remaining items."
        ]
        if flagged:
            footnotes.append(
                "Flagged (r_it < .30 or α if deleted > α): " + ", ".join(flagged) + "."
            )
        out.append(
            _table(
                f"{base}/table/2",
                "Item-Total Statistics",
                [
                    "Item",
                    "Item M",
                    "Item SD",
                    "Scale M if deleted",
                    "Scale Var if deleted",
                    "Corrected r_it",
                    "α if deleted",
                ],
                item_rows,
                footnotes,
            )
        )
        out.append(
            _note(
                f"{base}/note/1",
                f"Scale reliability for {stats['k']} items on {stats['n']} complete cases: "
                f"α = {alpha:.3f}, 95% CI [{stats['ciLower']:.3f}, {stats['ciUpper']:.3f}], "
                f"standardized α = {stats['standardizedAlpha']:.3f}, ω_t = {stats['omega']:.3f}. "
                f"The summed scale scores average {stats['scaleMean']:.2f} "
                f"(SD = {stats['scaleSd']:.2f}). "
                + (
                    "Items flagged above are candidates for revision: a low corrected item-total "
                    "correlation or a higher alpha after deletion means the item adds noise."
                    if flagged
                    else "No item is flagged: every corrected item-total correlation reaches .30 "
                    "and no deletion raises alpha."
                ),
            )
        )
    elif analysis_id == "factor_efa":
        bar = stats["bartlett"]
        out.append(
            _table(
                f"{base}/table/1",
                "KMO and Bartlett’s Test",
                ["Statistic", "Value"],
                [
                    ["Kaiser-Meyer-Olkin measure", stats["kmo"]],
                    ["Bartlett χ²", bar["chi2"]],
                    ["Bartlett df", bar["df"]],
                    ["Bartlett p", bar["p"]],
                ],
                [
                    "Note. KMO below .50 means the correlation matrix is barely factorable. "
                    "Bartlett’s test of sphericity asks whether the matrix differs from an identity matrix."
                ],
            )
        )
        out.append(
            _table(
                f"{base}/table/2",
                "Total Variance Explained",
                ["Component", "Eigenvalue", "% of variance", "Cumulative %"],
                [
                    [i, row["eigenvalue"], row["percent"], row["cumulative"]]
                    for i, row in enumerate(stats["explained"], start=1)
                ],
                [
                    f"Note. Extraction method: {'principal axis factoring' if stats['method'] == 'paf' else 'principal component analysis'}. "
                    f"{stats['nFactors']} factor(s) retained from {stats['k']} variables."
                ],
            )
        )
        factor_columns = [f"F{i + 1}" for i in range(stats["nFactors"])]
        out.append(
            _table(
                f"{base}/table/3",
                "Rotated Factor Loadings & Communalities",
                ["Variable", *factor_columns, "h²", "u²"],
                [
                    [row["name"], *row["loadings"], row["communality"], row["uniqueness"]]
                    for row in stats["loadings"]
                ],
                [
                    "Note. "
                    + (
                        "Varimax rotation; loadings are pattern coefficients."
                        if stats["rotation"] == "varimax"
                        else "Unrotated loadings."
                    )
                    + " h² is the explained communality, u² the unique variance."
                ],
            )
        )
        scree = {
            "op": "upsert",
            "address": f"{base}/chart/1",
            "element": {
                "address": f"{base}/chart/1",
                "status": "ok",
                "kind": "chart",
                "caption": "Scree Plot",
                "svg": render_scree_svg(
                    [str(i) for i in range(1, stats["k"] + 1)], stats["eigenvalues"]
                ),
            },
        }
        out.append(scree)
        out.append(
            _note(
                f"{base}/note/1",
                f"KMO = {stats['kmo']:.3f} on {stats['k']} variables and {stats['n']} complete cases; "
                f"Bartlett χ²({bar['df']}) = {bar['chi2']:.3f}, p = {_fmt_p(bar['p'])}. "
                f"{stats['nFactors']} factor(s) retained, explaining "
                f"{stats['explained'][stats['nFactors'] - 1]['cumulative']:.1f}% of the total variance. "
                "Variables whose largest loading sits on the same factor belong to the same construct.",
            )
        )
    return out


def run_analysis(run_id: str, analysis_id: str, spec, data, missing_policy: str, chart=None):
    """Run one analysis.

    Returns (patches, stats). Raises AnalysisFailure(1001|1003|1004).
    ``chart`` is an optional AI chart spec rendered from the same data and
    appended through the same patch stream; a bad spec becomes a note, never
    a failed run, and ``stats`` is untouched (golden mirrors stay exact).
    """
    try:
        validate_spec(analysis_id, spec)
    except SpecError as exc:
        raise AnalysisFailure(1001, exc.user_message, exc.detail) from None
    if missing_policy not in MISSING_POLICIES:
        raise AnalysisFailure(
            1003,
            f"Unknown missing-value policy “{missing_policy}”. Use listwise or pairwise.",
            f"missingPolicy {missing_policy!r}",
        )
    _validate_data(spec, data, analysis_id)
    cols = _apply_missing_policy(spec, data, analysis_id, missing_policy)
    handler = HANDLERS[analysis_id]
    try:
        stats = handler(spec, cols)
        patches = _result_elements(run_id, analysis_id, spec, stats)
    except (DataError, NumericError) as exc:
        code = 1003 if isinstance(exc, DataError) else 1004
        raise AnalysisFailure(code, exc.user_message, exc.detail) from None
    except (np.linalg.LinAlgError, ValueError) as exc:
        raise AnalysisFailure(
            1004,
            "The statistical test could not be computed from this data. Check the data and options.",
            f"{type(exc).__name__}: {exc}",
        ) from None
    except Exception as exc:  # seam must survive any library failure
        raise AnalysisFailure(
            1004,
            "The statistical test could not be computed from this data. Check the data and options.",
            f"{type(exc).__name__}: {exc}",
        ) from None
    patches = _result_elements(run_id, analysis_id, spec, stats)
    patches = [*patches, *_assumption_patches(run_id, f"{run_id}/note/assumptions", analysis_id, spec, cols)]
    if chart is not None:
        patches = [*patches, _chart_patch(run_id, chart, data)]
    return patches, stats
