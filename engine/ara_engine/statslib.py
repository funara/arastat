"""The 23 analysis handlers.

Each handler reproduces the fixture's provenance call exactly and returns the
golden stats dict (expected.json minus provenance/notes). Extraction
conventions: level order = first appearance in input rows; non-finite leaves
serialize as null; quantiles use method="linear"; SD is ddof=1.
"""

from __future__ import annotations

import itertools
import math

import numpy as np
import pandas as pd
import scipy.stats as st
import statsmodels.api as sm
import statsmodels.formula.api as smf
from statsmodels.stats.anova import anova_lm
from statsmodels.stats.contingency_tables import mcnemar
from statsmodels.stats.multicomp import pairwise_tukeyhsd
from statsmodels.stats.oneway import anova_oneway


class DataError(Exception):
    """Invalid data (error 1003)."""

    def __init__(self, user_message: str, detail: str | None = None):
        super().__init__(user_message)
        self.user_message = user_message
        self.detail = detail


class NumericError(Exception):
    """Numeric failure (error 1004)."""

    def __init__(self, user_message: str, detail: str | None = None):
        super().__init__(user_message)
        self.user_message = user_message
        self.detail = detail


def f(value):
    """Float leaf; NaN/inf → None (JSON null)."""
    if value is None:
        return None
    value = float(value)
    return value if math.isfinite(value) else None


def is_missing(value) -> bool:
    """Missing at the seam = null (plus a blank CSV cell passed through raw)."""
    return value is None or value == ""


def numeric(values, name: str) -> list[float]:
    out = []
    for v in values:
        if is_missing(v):
            out.append(float("nan"))
            continue
        try:
            x = float(v)
        except (TypeError, ValueError):
            raise DataError(
                f"Variable “{name}” needs numeric values. Recast the variable as numeric.",
                f"non-numeric cell {v!r} in {name!r}",
            ) from None
        if not math.isfinite(x):
            raise DataError(
                f"Variable “{name}” needs finite numeric values. Fix the cell values.",
                f"non-finite cell {v!r} in {name!r}",
            )
        out.append(x)
    return out


def levels(values) -> list[str]:
    """Distinct labels in first-appearance order."""
    seen: list[str] = []
    for v in values:
        s = str(v)
        if s not in seen:
            seen.append(s)
    return seen


def count_by(labels):
    d = {}
    for v in labels:
        s = str(v)
        d[s] = d.get(s, 0) + 1
    return d


def pivot2(row_levels, col_levels, rvals, cvals, counts):
    table = [[0 for _ in col_levels] for _ in row_levels]
    ri = {lv: i for i, lv in enumerate(map(str, row_levels))}
    ci = {lv: i for i, lv in enumerate(map(str, col_levels))}
    for rv, cv, cnt in zip(rvals, cvals, counts):
        table[ri[str(rv)]][ci[str(cv)]] += int(float(cnt))
    return table


def _two_groups(cols, group_col: str, test: str = "This test") -> tuple[list[str], dict[str, list[float]]]:
    """Split into exactly two groups. More levels must be refused: silently
    comparing the first two of three or more would answer a question the user
    did not ask, over a subset they never chose."""
    labels = levels(cols[group_col])
    if len(labels) < 2:
        raise NumericError(
            f"Grouping variable “{group_col}” has 1 defined group. Define at least two groups.",
            f"{group_col!r} has {len(labels)} distinct level(s)",
        )
    if len(labels) > 2:
        raise NumericError(
            f"Grouping variable “{group_col}” has {len(labels)} groups. {test} compares exactly two: "
            f"choose a two-group column, or run One-way ANOVA for three or more.",
            f"{group_col!r} has {len(labels)} distinct level(s): {labels}",
        )
    names = labels[:2]
    dep_vals = cols.get("__dep__")
    groups = {g: [v for lbl, v in zip(cols[group_col], dep_vals) if str(lbl) == g] for g in names}
    for g in names:
        if len(groups[g]) < 2:
            raise NumericError(
                f"Group “{g}” of “{group_col}” has too few values. Add more rows to every group.",
                f"group {g!r} has {len(groups[g])} value(s)",
            )
    return names, groups


def _split_groups(cols, dep: str, factor: str, min_per: int = 1):
    labels = levels(cols[factor])
    if len(labels) < 2:
        raise NumericError(
            f"Grouping variable “{factor}” has 1 defined group. Define at least two groups.",
            f"{factor!r} has {len(labels)} distinct level(s)",
        )
    values = numeric(cols[dep], dep)
    groups = {g: [v for lbl, v in zip(cols[factor], values) if str(lbl) == g] for g in labels}
    for g in labels:
        if len(groups[g]) < min_per:
            raise NumericError(
                f"Group “{g}” of “{factor}” has too few values. Add more rows to every group.",
                f"group {g!r} has {len(groups[g])} value(s)",
            )
    return labels, groups


def _group_summary(groups: dict[str, list[float]]) -> dict:
    out = {}
    for g, vals in groups.items():
        arr = np.asarray(vals, dtype=float)
        out[g] = {"n": int(arr.size), "mean": f(np.mean(arr)), "sd": f(np.std(arr, ddof=1))}
    return out


def _confidence_interval(result):
    interval = result.confidence_interval(confidence_level=0.95)
    return f(interval.low), f(interval.high)


# --- tier 1 -----------------------------------------------------------------


def run_descriptives(spec, cols):
    summary = {}
    for name in spec["variables"]:
        values = np.asarray(numeric(cols[name], name), dtype=float)
        if values.size == 0:
            raise NumericError(
                f"Variable “{name}” has no non-missing values. Choose a variable with data.",
                f"{name!r} is all-missing",
            )
        q1, median, q3 = np.quantile(values, [0.25, 0.5, 0.75], method="linear")
        summary[name] = {
            "n": int(values.size),
            "mean": f(np.mean(values)),
            "sd": f(np.std(values, ddof=1)),
            "min": f(np.min(values)),
            "q1": f(q1),
            "median": f(median),
            "q3": f(q3),
            "max": f(np.max(values)),
        }
    return {"variables": summary}


def run_frequencies(spec, raw):
    summary = {}
    for name in spec["variables"]:
        values = [v for v in raw[name]]
        valid = [v for v in values if v is not None and v != ""]
        if not valid:
            raise NumericError(
                f"Variable “{name}” has no non-missing values. Choose a variable with data.",
                f"{name!r} is all-missing",
            )
        total = len(values)
        order = levels(valid)
        counts = {lv: int(count_by(valid)[lv]) for lv in order}
        summary[name] = {
            "validN": len(valid),
            "missingN": total - len(valid),
            "counts": counts,
            "percent": {lv: c / total * 100.0 for lv, c in counts.items()},
            "validPercent": {lv: c / len(valid) * 100.0 for lv, c in counts.items()},
        }
    return {"variables": summary}


def run_ttest_onesample(spec, cols):
    values = np.asarray(numeric(cols[spec["dep"]], spec["dep"]), dtype=float)
    if values.size < 2:
        raise NumericError(
            f"Variable “{spec['dep']}” has fewer than two values. Add more rows.",
            f"n = {values.size}",
        )
    test_value = float(spec["testValue"])
    result = st.ttest_1samp(a=values, popmean=test_value, alternative="two-sided")
    ci_lower, ci_upper = _confidence_interval(result)
    mean = float(np.mean(values))
    sd = float(np.std(values, ddof=1))
    return {
        "n": int(values.size),
        "mean": f(mean),
        "sd": f(sd),
        "testValue": test_value,
        "meanDiff": f(mean - test_value),
        "SE": f(sd / math.sqrt(values.size)),
        "t": f(result.statistic),
        "df": int(values.size - 1),
        "p": f(result.pvalue),
        "ciLower": ci_lower,
        "ciUpper": ci_upper,
    }


def run_ttest_independent(spec, cols):
    dep = spec["dep"]
    cols = dict(cols, __dep__=numeric(cols[dep], dep))
    names, groups = _two_groups(cols, spec["group"], "The independent-samples t-test")
    first = np.asarray(groups[names[0]], dtype=float)
    second = np.asarray(groups[names[1]], dtype=float)
    welch = st.ttest_ind(a=first, b=second, equal_var=False, alternative="two-sided")
    student = st.ttest_ind(a=first, b=second, equal_var=True, alternative="two-sided")
    n1, n2 = int(first.size), int(second.size)
    mean_diff = float(np.mean(first) - np.mean(second))
    s1 = float(np.std(first, ddof=1))
    s2 = float(np.std(second, ddof=1))
    pooled_sd = math.sqrt(((n1 - 1) * s1**2 + (n2 - 1) * s2**2) / (n1 + n2 - 2))
    if pooled_sd == 0.0:
        raise NumericError(
            f"Variable “{dep}” is constant within both groups. Choose a variable that varies.",
            "pooled SD is zero",
        )
    welch_se = math.sqrt(s1**2 / n1 + s2**2 / n2)
    student_se = pooled_sd * math.sqrt(1.0 / n1 + 1.0 / n2)
    welch_low, welch_high = _confidence_interval(welch)
    student_low, student_high = _confidence_interval(student)
    return {
        "groups": _group_summary({names[0]: list(first), names[1]: list(second)}),
        "welch": {
            "t": f(welch.statistic),
            "df": f(welch.df),
            "p": f(welch.pvalue),
            "meanDiff": f(mean_diff),
            "SE": f(welch_se),
            "ciLower": welch_low,
            "ciUpper": welch_high,
        },
        "student": {
            "t": f(student.statistic),
            "df": f(student.df),
            "p": f(student.pvalue),
            "meanDiff": f(mean_diff),
            "SE": f(student_se),
            "ciLower": student_low,
            "ciUpper": student_high,
        },
        "pooledSd": f(pooled_sd),
        "cohensD": f(mean_diff / pooled_sd),
    }


def run_ttest_paired(spec, cols):
    first = np.asarray(numeric(cols[spec["a"]], spec["a"]), dtype=float)
    second = np.asarray(numeric(cols[spec["b"]], spec["b"]), dtype=float)
    differences = first - second
    if differences.size < 2:
        raise NumericError(
            f"Paired variables “{spec['a']}” and “{spec['b']}” have fewer than two pairs. Add more rows.",
            f"nPairs = {differences.size}",
        )
    result = st.ttest_rel(a=first, b=second, alternative="two-sided")
    ci_lower, ci_upper = _confidence_interval(result)
    mean_diff = float(np.mean(differences))
    sd_diff = float(np.std(differences, ddof=1))
    return {
        "nPairs": int(first.size),
        "meanA": f(np.mean(first)),
        "meanB": f(np.mean(second)),
        "meanDiff": f(mean_diff),
        "sdDiff": f(sd_diff),
        "t": f(result.statistic),
        "df": int(first.size - 1),
        "p": f(result.pvalue),
        "ciLower": ci_lower,
        "ciUpper": ci_upper,
        "cohensDz": f(mean_diff / sd_diff),
    }


def run_anova_oneway(spec, cols):
    labels, groups = _split_groups(cols, spec["dep"], spec["factor"], min_per=2)
    arrays = [np.asarray(groups[g], dtype=float) for g in labels]
    result = st.f_oneway(*arrays)
    all_values = np.concatenate(arrays)
    grand = float(np.mean(all_values))
    ss_between = sum(len(groups[g]) * (float(np.mean(groups[g])) - grand) ** 2 for g in labels)
    ss_total = float(np.sum((all_values - grand) ** 2))
    if ss_total == 0.0:
        raise NumericError(
            f"Variable “{spec['dep']}” has no variation. Choose a variable that varies.",
            "total sum of squares is zero",
        )
    return {
        "groups": _group_summary(groups),
        "F": f(result.statistic),
        "df1": len(labels) - 1,
        "df2": int(all_values.size - len(labels)),
        "p": f(result.pvalue),
        "etaSquared": f(ss_between / ss_total),
    }


def run_chisq_independence(spec, cols):
    row_levels = levels(cols[spec["row"]])
    col_levels = levels(cols[spec["col"]])
    if len(row_levels) < 2 or len(col_levels) < 2:
        raise NumericError(
            f"Variables “{spec['row']}” and “{spec['col']}” need at least two levels each. Define more levels.",
            f"{len(row_levels)}x{len(col_levels)} table",
        )
    observed = np.asarray(
        [
            [sum(1 for r, c in zip(cols[spec["row"]], cols[spec["col"]]) if str(r) == rl and str(c) == cl) for cl in col_levels]
            for rl in row_levels
        ],
        dtype=int,
    )
    result = st.chi2_contingency(observed, correction=False)
    n = int(np.sum(observed))
    min_dim = min(observed.shape[0] - 1, observed.shape[1] - 1)
    if min_dim == 0 or f(result.statistic) is None:
        raise NumericError(
            "The contingency table could not be tested. Check the two variables.",
            "degenerate table",
        )
    cramers_v = math.sqrt(float(result.statistic) / (n * min_dim))
    return {
        "rowLevels": row_levels,
        "colLevels": col_levels,
        "observed": observed.astype(int).tolist(),
        "expected": np.asarray(result.expected_freq, dtype=float).tolist(),
        "n": n,
        "chi2": f(result.statistic),
        "df": int(result.dof),
        "p": f(result.pvalue),
        "cramersV": f(cramers_v),
    }


def run_correlation(spec, raw):
    variables = list(spec["variables"])
    values = {name: numeric(raw[name], name) for name in variables}
    r_matrix, p_matrix, n_matrix = [], [], []
    for i, vi in enumerate(variables):
        r_row, p_row, n_row = [], [], []
        for j, vj in enumerate(variables):
            if i == j:
                r_row.append(1.0)
                p_row.append(0.0)
                n_row.append(sum(1 for v in values[vi] if math.isfinite(v)))
            else:
                mask = [
                    (a, b)
                    for a, b in zip(values[vi], values[vj])
                    if math.isfinite(a) and math.isfinite(b)
                ]
                n_row.append(len(mask))
                if len(mask) < 2:
                    raise NumericError(
                        f"Variables “{vi}” and “{vj}” share fewer than two complete pairs. Add more rows.",
                        f"pairwise n = {len(mask)}",
                    )
                res = st.pearsonr(x=[t[0] for t in mask], y=[t[1] for t in mask])
                r_row.append(float(res.statistic))
                p_row.append(float(res.pvalue))
        r_matrix.append(r_row)
        p_matrix.append(p_row)
        n_matrix.append(n_row)
    return {
        "variables": variables,
        "rMatrix": [[f(v) for v in row] for row in r_matrix],
        "pMatrix": [[f(v) for v in row] for row in p_matrix],
        "nMatrix": n_matrix,
    }


def run_linear_regression(spec, cols):
    dep = spec["dep"]
    predictors = list(spec["predictors"])
    y = np.asarray(numeric(cols[dep], dep), dtype=float)
    X = np.column_stack([numeric(cols[p], p) for p in predictors])
    if y.size < len(predictors) + 2:
        raise NumericError(
            f"Regression of “{dep}” needs more rows than predictors. Add more rows or remove predictors.",
            f"n = {y.size}, predictors = {len(predictors)}",
        )
    X = sm.add_constant(X, has_constant="add")
    result = sm.OLS(endog=y, exog=X).fit()
    confidence = result.conf_int(alpha=0.05)
    terms = {}
    for index, term in enumerate(["const"] + predictors):
        terms[term] = {
            "coef": f(result.params[index]),
            "SE": f(result.bse[index]),
            "t": f(result.tvalues[index]),
            "p": f(result.pvalues[index]),
            "ciLower": f(confidence[index, 0]),
            "ciUpper": f(confidence[index, 1]),
        }
    return {
        "n": int(y.size),
        "r2": f(result.rsquared),
        "adjR2": f(result.rsquared_adj),
        "F": f(result.fvalue),
        "dfModel": f(result.df_model),
        "dfResid": f(result.df_resid),
        "pOverall": f(result.f_pvalue),
        "terms": terms,
    }


def run_mannwhitney_u(spec, cols):
    dep = spec["dep"]
    cols = dict(cols, __dep__=numeric(cols[dep], dep))
    names, groups = _two_groups(cols, spec["group"], "The Mann-Whitney U test")
    result = st.mannwhitneyu(
        x=groups[names[0]],
        y=groups[names[1]],
        alternative="two-sided",
        method="exact",
    )
    return {
        "groups": {g: {"n": len(vals)} for g, vals in groups.items()},
        "U": f(result.statistic),
        "p": f(result.pvalue),
        "method": "exact",
    }


def run_wilcoxon_signedrank(spec, cols):
    first = np.asarray(numeric(cols[spec["a"]], spec["a"]), dtype=float)
    second = np.asarray(numeric(cols[spec["b"]], spec["b"]), dtype=float)
    differences = first - second
    if differences.size < 1:
        raise NumericError(
            f"Paired variables “{spec['a']}” and “{spec['b']}” have no pairs. Add more rows.",
            f"nPairs = {differences.size}",
        )
    result = st.wilcoxon(
        x=first,
        y=second,
        zero_method="wilcox",
        correction=False,
        alternative="two-sided",
        method="approx",
    )
    return {
        "nUsed": int(np.sum(differences != 0)),
        "statistic": f(result.statistic),
        "p": f(result.pvalue),
        "method": "approx",
    }


def run_kruskal_wallis(spec, cols):
    labels, groups = _split_groups(cols, spec["dep"], spec["factor"], min_per=1)
    result = st.kruskal(*[groups[g] for g in labels])
    return {
        "groups": {g: {"n": len(vals)} for g, vals in groups.items()},
        "H": f(result.statistic),
        "df": len(labels) - 1,
        "p": f(result.pvalue),
    }


# --- tier 2 -----------------------------------------------------------------


def run_chisq_gof(spec, cols):
    labels = levels(cols[spec["variable"]])
    obs_map = count_by(cols[spec["variable"]])
    n = sum(obs_map.values())
    obs = [obs_map[k] for k in labels]
    exp_counts = [n / len(labels)] * len(labels)
    res = st.chisquare(f_obs=obs, f_exp=exp_counts)
    return {
        "n": n,
        "observed": obs_map,
        "expected": {k: exp_counts[i] for i, k in enumerate(labels)},
        "chi2": f(res.statistic),
        "df": len(labels) - 1,
        "p": f(res.pvalue),
    }


def run_fisher_exact_2x2(spec, cols):
    rl = levels(cols[spec["row"]])
    cl = levels(cols[spec["col"]])
    if len(rl) != 2 or len(cl) != 2:
        raise NumericError(
            f"Fisher’s exact test needs two levels in “{spec['row']}” and “{spec['col']}”. Define exactly two levels each.",
            f"{len(rl)}x{len(cl)} table",
        )
    table = pivot2(rl, cl, cols[spec["row"]], cols[spec["col"]], cols[spec["count"]])
    res = st.fisher_exact(table=table, alternative="two-sided")
    return {
        "n": sum(sum(r) for r in table),
        "table": table,
        "a": table[0][0],
        "b": table[0][1],
        "c": table[1][0],
        "d": table[1][1],
        "odds_ratio": f(res.statistic),
        "p": f(res.pvalue),
        "alternative": "two-sided",
    }


def run_mcnemar(spec, cols):
    rl = levels(cols[spec["before"]])
    cl = levels(cols[spec["after"]])
    if len(rl) != 2 or len(cl) != 2:
        raise NumericError(
            f"McNemar’s test needs two levels in “{spec['before']}” and “{spec['after']}”. Define exactly two levels each.",
            f"{len(rl)}x{len(cl)} table",
        )
    table = pivot2(rl, cl, cols[spec["before"]], cols[spec["after"]], cols[spec["count"]])
    ex = mcnemar(table=table, exact=True)
    ch = mcnemar(table=table, exact=False, correction=False)
    return {
        "n": sum(sum(r) for r in table),
        "table": table,
        "a": table[0][0],
        "b": table[0][1],
        "c": table[1][0],
        "d": table[1][1],
        "exact_statistic": f(ex.statistic),
        "exact_p": f(ex.pvalue),
        "chi2": f(ch.statistic),
        "chi2_p": f(ch.pvalue),
        "exact": True,
        "correction": False,
    }


def run_binomial(spec, cols):
    n = int(float(cols[spec["n"]][0]))
    k = int(float(cols[spec["variable"]][0]))
    if "null_probability" in cols:
        p0 = float(cols["null_probability"][0])
    else:
        p0 = float(spec["p0"])
    res = st.binomtest(k=k, n=n, p=p0, alternative="two-sided")
    ci = res.proportion_ci(confidence_level=0.95, method="exact")
    return {
        "n": n,
        "k": k,
        "p0": p0,
        "proportion": f(res.statistic),
        "p": f(res.pvalue),
        "ci_95": {"lower": f(ci.low), "upper": f(ci.high)},
        "alternative": "two-sided",
    }


def run_wilcoxon_one_sample(spec, cols):
    dep = spec["dep"]
    x = numeric(cols[dep], dep)
    if "hypothesized_mu" in cols:
        mu_vals = numeric(cols["hypothesized_mu"], "hypothesized_mu")
    else:
        mu_vals = [float(spec["mu"])] * len(x)
    mu = mu_vals[0]
    res = st.wilcoxon(
        x=x,
        y=mu_vals,
        zero_method="wilcox",
        correction=False,
        alternative="two-sided",
        method="exact",
    )
    return {
        "n": sum(a != b for a, b in zip(x, mu_vals)),
        "n_observations": len(x),
        "statistic": f(res.statistic),
        "p": f(res.pvalue),
        "mu": mu,
        "alternative": "two-sided",
        "method": "exact",
        "zero_method": "wilcox",
        "correction": False,
    }


def run_friedman(spec, cols):
    groups = [numeric(cols[c], c) for c in spec["conditions"]]
    res = st.friedmanchisquare(*groups)
    return {
        "n": len(groups[0]),
        "k": len(groups),
        "statistic": f(res.statistic),
        "df": len(groups) - 1,
        "p": f(res.pvalue),
    }


def run_kendall_tau(spec, cols):
    x = numeric(cols[spec["a"]], spec["a"])
    y = numeric(cols[spec["b"]], spec["b"])
    res = st.kendalltau(x=x, y=y, variant="b", method="auto", alternative="two-sided")
    return {
        "n": len(x),
        "tau": f(res.statistic),
        "p": f(res.pvalue),
        "variant": "b",
        "method": "auto",
        "alternative": "two-sided",
    }


def _welch_groups(spec, cols):
    labels, groups = _split_groups(cols, spec["dep"], spec["factor"], min_per=2)
    summary = {}
    for g in labels:
        arr = np.asarray(groups[g], dtype=float)
        summary[g] = {"n": int(arr.size), "mean": f(np.mean(arr)), "sd": f(np.std(arr, ddof=1))}
    return labels, groups, summary


def run_welch_anova(spec, cols):
    labels, groups, summary = _welch_groups(spec, cols)
    res = anova_oneway(
        [np.asarray(groups[g], dtype=float) for g in labels],
        use_var="unequal",
    )
    return {
        "groups": summary,
        "F": f(res.statistic),
        "df1": f(res.df_num),
        "df2": f(res.df_denom),
        "p": f(res.pvalue),
    }


def run_tukey_hsd(spec, cols):
    labels, groups, summary = _welch_groups(spec, cols)
    data = [(g, v) for g in labels for v in groups[g]]
    endog = np.array([v for _, v in data], dtype=float)
    lab = np.array([g for g, _ in data])
    alpha = float(spec["alpha"])
    res = pairwise_tukeyhsd(endog=endog, groups=lab, alpha=alpha)
    uniq = list(res.groupsunique)
    pairs = []
    for idx, (g1, g2) in enumerate(itertools.combinations(uniq, 2)):
        lo, hi = res.confint[idx]
        pairs.append(
            {
                "group1": g1,
                "group2": g2,
                "mean_difference": f(res.meandiffs[idx]),
                "p_adjusted": f(res.pvalues[idx]),
                "reject": bool(res.reject[idx]),
                "ci_95": {"lower": f(lo), "upper": f(hi)},
            }
        )
    return {"alpha": alpha, "groups": summary, "pairs": pairs}


def run_factorial_anova_2way(spec, cols):
    dep = spec["dep"]
    fa, fb = spec["factors"][0], spec["factors"][1]
    frame = pd.DataFrame(
        {dep: numeric(cols[dep], dep), fa: [str(v) for v in cols[fa]], fb: [str(v) for v in cols[fb]]}
    )
    formula = f"{dep} ~ C({fa}, Sum) * C({fb}, Sum)"
    model = smf.ols(formula=formula, data=frame).fit()
    t2 = anova_lm(model, typ=2)
    t3 = anova_lm(model, typ=3)
    name_map = {
        f"C({fa}, Sum)": fa,
        f"C({fb}, Sum)": fb,
        f"C({fa}, Sum):C({fb}, Sum)": f"{fa}:{fb}",
        "Residual": "residual",
    }

    def conv(tab):
        out = {}
        for label, row in tab.iterrows():
            if label == "Intercept":
                continue
            out[name_map[label]] = {
                "SS": f(row["sum_sq"]),
                "df": f(row["df"]),
                "F": f(row.get("F")),
                "p": f(row.get("PR(>F)")),
            }
        return out

    return {"formula": formula, "typ_2": conv(t2), "typ_3": conv(t3)}


def run_logistic_regression(spec, cols):
    dep = spec["dep"]
    predictors = list(spec["predictors"])
    y = np.array(numeric(cols[dep], dep))
    X = pd.DataFrame({p: numeric(cols[p], p) for p in predictors})
    X = sm.add_constant(X, has_constant="add")
    res = sm.Logit(y, X).fit(method="newton", maxiter=100, disp=False)
    ci = np.exp(np.asarray(res.conf_int(alpha=0.05)))
    terms = {}
    for i, name in enumerate(X.columns):
        lo, hi = ci[i]
        terms[name] = {
            "coef": f(res.params.iloc[i]),
            "SE": f(res.bse.iloc[i]),
            "z": f(res.tvalues.iloc[i]),
            "p": f(res.pvalues.iloc[i]),
            "odds_ratio": f(math.exp(res.params.iloc[i])),
            "odds_ratio_ci_95": {"lower": f(lo), "upper": f(hi)},
        }
    return {
        "converged": bool(res.mle_retvals["converged"]),
        "llf": f(res.llf),
        "llnull": f(res.llnull),
        "mcfadden_pseudo_r2": f(1 - res.llf / res.llnull),
        "n": len(y),
        "terms": terms,
    }


def run_shapiro_wilk(spec, cols):
    values = np.asarray(numeric(cols[spec["dep"]], spec["dep"]), dtype=float)
    if values.size < 3:
        raise NumericError(
            f"Variable “{spec['dep']}” needs at least three values for a Shapiro-Wilk test. Add more rows.",
            f"n = {values.size}",
        )
    result = st.shapiro(values)
    return {"n": int(values.size), "W": f(result.statistic), "p": f(result.pvalue)}


def run_spearman_correlation(spec, cols):
    first = np.asarray(numeric(cols[spec["a"]], spec["a"]), dtype=float)
    second = np.asarray(numeric(cols[spec["b"]], spec["b"]), dtype=float)
    if first.size < 2:
        raise NumericError(
            f"Variables “{spec['a']}” and “{spec['b']}” need at least two complete pairs. Add more rows.",
            f"n = {first.size}",
        )
    result = st.spearmanr(first, second, alternative="two-sided")
    return {"n": int(first.size), "rho": f(result.statistic), "p": f(result.pvalue)}


HANDLERS = {
    "shapiro_wilk": run_shapiro_wilk,
    "spearman_correlation": run_spearman_correlation,
    "anova_oneway": run_anova_oneway,
    "binomial": run_binomial,
    "chisq_gof": run_chisq_gof,
    "chisq_independence": run_chisq_independence,
    "correlation": run_correlation,
    "descriptives": run_descriptives,
    "factorial_anova_2way": run_factorial_anova_2way,
    "fisher_exact_2x2": run_fisher_exact_2x2,
    "frequencies": run_frequencies,
    "friedman": run_friedman,
    "kendall_tau": run_kendall_tau,
    "kruskal_wallis": run_kruskal_wallis,
    "linear_regression": run_linear_regression,
    "logistic_regression": run_logistic_regression,
    "mannwhitney_u": run_mannwhitney_u,
    "mcnemar": run_mcnemar,
    "ttest_independent": run_ttest_independent,
    "ttest_onesample": run_ttest_onesample,
    "ttest_paired": run_ttest_paired,
    "tukey_hsd": run_tukey_hsd,
    "welch_anova": run_welch_anova,
    "wilcoxon_one_sample": run_wilcoxon_one_sample,
    "wilcoxon_signedrank": run_wilcoxon_signedrank,
}
