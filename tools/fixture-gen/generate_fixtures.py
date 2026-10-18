#!/usr/bin/env python3
"""Generate deterministic Tier-2 reference fixtures for ARAStat.

All observations in this file are literal, hand-authored values.  The script
only writes input.csv and expected.json below tests/fixtures/tier2.
"""

from __future__ import annotations

import csv
import json
import math
import platform
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np
import pandas as pd
import scipy
import scipy.stats
import statsmodels
import statsmodels.api as sm
import statsmodels.formula.api as smf
from statsmodels.stats.anova import anova_lm
from statsmodels.stats.contingency_tables import mcnemar
from statsmodels.stats.multicomp import pairwise_tukeyhsd
from statsmodels.stats.oneway import anova_oneway


REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_ROOT = REPO_ROOT / "tests" / "fixtures" / "tier2"

VERSIONS = {
    "python": platform.python_version(),
    "numpy": np.__version__,
    "scipy": scipy.__version__,
    "statsmodels": statsmodels.__version__,
}


# Literal input rows.  No random state, time, or environment-dependent data is
# used anywhere in the fixture definitions.
CHISQ_ROWS = [
    ("North",),
    ("North",),
    ("North",),
    ("North",),
    ("North",),
    ("North",),
    ("North",),
    ("North",),
    ("North",),
    ("North",),
    ("North",),
    ("North",),
    ("North",),
    ("North",),
    ("South",),
    ("South",),
    ("South",),
    ("South",),
    ("South",),
    ("South",),
    ("South",),
    ("South",),
    ("South",),
    ("South",),
    ("South",),
    ("East",),
    ("East",),
    ("East",),
    ("East",),
    ("East",),
    ("East",),
    ("East",),
    ("East",),
    ("East",),
    ("West",),
    ("West",),
    ("West",),
    ("West",),
    ("West",),
    ("West",),
    ("West",),
    ("West",),
    ("West",),
    ("West",),
    ("West",),
    ("West",),
    ("West",),
    ("West",),
]

FISHER_ROWS = [
    ("Control", "Improved", 8),
    ("Control", "Not improved", 12),
    ("Treatment", "Improved", 15),
    ("Treatment", "Not improved", 5),
]

MCNEMAR_ROWS = [
    ("No", "No", 20),
    ("No", "Yes", 7),
    ("Yes", "No", 13),
    ("Yes", "Yes", 10),
]

BINOMIAL_ROWS = [
    ("trials", "successes", "null_probability"),
    (40, 27, 0.5),
]

WILCOXON_ROWS = [
    ("P01", 50, 50),
    ("P02", 52, 50),
    ("P03", 54, 50),
    ("P04", 54, 50),
    ("P05", 48, 50),
    ("P06", 47, 50),
    ("P07", 51, 50),
    ("P08", 53, 50),
    ("P09", 49, 50),
    ("P10", 52, 50),
    ("P11", 50, 50),
    ("P12", 55, 50),
]

FRIEDMAN_ROWS = [
    ("S01", 4, 5, 6),
    ("S02", 3, 4, 5),
    ("S03", 5, 6, 7),
    ("S04", 2, 4, 3),
    ("S05", 6, 5, 7),
    ("S06", 4, 3, 5),
    ("S07", 7, 8, 6),
    ("S08", 5, 6, 7),
    ("S09", 3, 2, 4),
    ("S10", 6, 7, 8),
]

KENDALL_ROWS = [
    ("P01", 1, 1),
    ("P02", 1, 2),
    ("P03", 2, 2),
    ("P04", 2, 3),
    ("P05", 3, 3),
    ("P06", 3, 4),
    ("P07", 4, 5),
    ("P08", 4, 4),
    ("P09", 5, 6),
    ("P10", 5, 5),
    ("P11", 6, 6),
    ("P12", 6, 7),
    ("P13", 7, 8),
    ("P14", 7, 7),
    ("P15", 8, 9),
    ("P16", 8, 8),
    ("P17", 9, 10),
    ("P18", 9, 9),
    ("P19", 10, 10),
    ("P20", 10, 10),
]

# The three standard deviations are exactly in the ratio 1:2:4 for these
# centered, hand-authored scores (sample SD, ddof=1).
VARIANCE_ROWS = [
    ("Narrow", 45),
    ("Narrow", 46),
    ("Narrow", 47),
    ("Narrow", 48),
    ("Narrow", 49),
    ("Narrow", 50),
    ("Narrow", 50),
    ("Narrow", 51),
    ("Narrow", 52),
    ("Narrow", 53),
    ("Narrow", 54),
    ("Narrow", 55),
    ("Medium", 50),
    ("Medium", 52),
    ("Medium", 54),
    ("Medium", 56),
    ("Medium", 58),
    ("Medium", 60),
    ("Medium", 60),
    ("Medium", 62),
    ("Medium", 64),
    ("Medium", 66),
    ("Medium", 68),
    ("Medium", 70),
    ("Wide", 50),
    ("Wide", 54),
    ("Wide", 58),
    ("Wide", 62),
    ("Wide", 66),
    ("Wide", 70),
    ("Wide", 70),
    ("Wide", 74),
    ("Wide", 78),
    ("Wide", 82),
    ("Wide", 86),
    ("Wide", 90),
]

FACTORIAL_ROWS = [
    ("S01", "Control", "Low", 10),
    ("S02", "Control", "Low", 11),
    ("S03", "Control", "Low", 9),
    ("S04", "Control", "Low", 10),
    ("S05", "Control", "Medium", 12),
    ("S06", "Control", "Medium", 13),
    ("S07", "Control", "Medium", 11),
    ("S08", "Control", "Medium", 12),
    ("S09", "Control", "High", 14),
    ("S10", "Control", "High", 15),
    ("S11", "Control", "High", 13),
    ("S12", "Control", "High", 14),
    ("S13", "Treatment", "Low", 11),
    ("S14", "Treatment", "Low", 12),
    ("S15", "Treatment", "Low", 10),
    ("S16", "Treatment", "Low", 11),
    ("S17", "Treatment", "Medium", 16),
    ("S18", "Treatment", "Medium", 17),
    ("S19", "Treatment", "Medium", 15),
    ("S20", "Treatment", "Medium", 16),
    ("S21", "Treatment", "High", 22),
    ("S22", "Treatment", "High", 23),
    ("S23", "Treatment", "High", 21),
    ("S24", "Treatment", "High", 22),
]

LOGIT_ROWS = [
    ("P01", 0, 20, 0),
    ("P02", 0, 20, 0),
    ("P03", 0, 20, 0),
    ("P04", 1, 20, 0),
    ("P05", 0, 20, 0),
    ("P06", 0, 20, 1),
    ("P07", 0, 20, 1),
    ("P08", 1, 20, 1),
    ("P09", 0, 20, 1),
    ("P10", 0, 20, 1),
    ("P11", 0, 30, 0),
    ("P12", 0, 30, 0),
    ("P13", 1, 30, 0),
    ("P14", 0, 30, 0),
    ("P15", 1, 30, 0),
    ("P16", 0, 30, 1),
    ("P17", 1, 30, 1),
    ("P18", 1, 30, 1),
    ("P19", 0, 30, 1),
    ("P20", 1, 30, 1),
    ("P21", 0, 40, 0),
    ("P22", 1, 40, 0),
    ("P23", 1, 40, 0),
    ("P24", 0, 40, 0),
    ("P25", 1, 40, 0),
    ("P26", 1, 40, 1),
    ("P27", 1, 40, 1),
    ("P28", 0, 40, 1),
    ("P29", 1, 40, 1),
    ("P30", 1, 40, 1),
    ("P31", 0, 50, 0),
    ("P32", 1, 50, 0),
    ("P33", 1, 50, 0),
    ("P34", 1, 50, 0),
    ("P35", 1, 50, 0),
    ("P36", 1, 50, 1),
    ("P37", 0, 50, 1),
    ("P38", 1, 50, 1),
    ("P39", 1, 50, 1),
    ("P40", 1, 50, 1),
    ("P41", 1, 60, 0),
    ("P42", 1, 60, 0),
    ("P43", 0, 60, 0),
    ("P44", 1, 60, 0),
    ("P45", 1, 60, 0),
    ("P46", 1, 60, 1),
    ("P47", 1, 60, 1),
    ("P48", 1, 60, 1),
    ("P49", 0, 60, 1),
    ("P50", 1, 60, 1),
]


def as_json_value(value: Any) -> Any:
    """Convert NumPy/scalar results and NaN table cells to JSON values."""
    if isinstance(value, np.ndarray):
        return [as_json_value(item) for item in value.tolist()]
    if isinstance(value, np.generic):
        return as_json_value(value.item())
    if isinstance(value, (list, tuple)):
        return [as_json_value(item) for item in value]
    if isinstance(value, dict):
        return {str(key): as_json_value(item) for key, item in value.items()}
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, bool) or value is None or isinstance(value, (int, str)):
        return value
    return value


def provenance(call: str) -> dict[str, str]:
    return {**VERSIONS, "call": call}


def write_fixture(
    key: str,
    header: Sequence[str],
    rows: Iterable[Sequence[Any]],
    fields: dict[str, Any],
    call: str,
    notes: str,
) -> None:
    out_dir = FIXTURE_ROOT / key
    out_dir.mkdir(parents=True, exist_ok=True)

    with (out_dir / "input.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(header)
        writer.writerows(rows)

    expected = dict(fields)
    expected["notes"] = notes
    expected["provenance"] = provenance(call)
    normalized = as_json_value(expected)
    encoded = json.dumps(
        normalized,
        ensure_ascii=True,
        indent=2,
        sort_keys=True,
        allow_nan=False,
    )
    with (out_dir / "expected.json").open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(encoded)
        handle.write("\n")


def fixture_chisq_gof() -> None:
    labels = ["North", "South", "East", "West"]
    observed = [14, 11, 9, 14]
    expected = [12, 12, 12, 12]
    result = scipy.stats.chisquare(f_obs=observed, f_exp=expected)
    write_fixture(
        "chisq_gof",
        ["region"],
        CHISQ_ROWS,
        {
            "n": sum(observed),
            "observed": dict(zip(labels, observed)),
            "expected": dict(zip(labels, expected)),
            "chi2": float(result.statistic),
            "df": len(labels) - 1,
            "p": float(result.pvalue),
        },
        "scipy.stats.chisquare(f_obs=observed, f_exp=expected)",
        "Four mutually exclusive categories use equal expected proportions; expected counts are 12 each and df=k-1=3.",
    )


def fixture_fisher_exact_2x2() -> None:
    table = [[8, 12], [15, 5]]
    result = scipy.stats.fisher_exact(table=table, alternative="two-sided")
    write_fixture(
        "fisher_exact_2x2",
        ["arm", "response", "count"],
        FISHER_ROWS,
        {
            "n": sum(sum(row) for row in table),
            "table": table,
            "a": table[0][0],
            "b": table[0][1],
            "c": table[1][0],
            "d": table[1][1],
            "odds_ratio": float(result.statistic),
            "p": float(result.pvalue),
            "alternative": "two-sided",
        },
        "scipy.stats.fisher_exact(table=table, alternative='two-sided')",
        "The table is ordered as [[Control improved, Control not improved], [Treatment improved, Treatment not improved]]. The p value is the exact two-sided Fisher probability.",
    )


def fixture_mcnemar() -> None:
    table = [[20, 7], [13, 10]]
    exact_result = mcnemar(table=table, exact=True)
    chi_result = mcnemar(table=table, exact=False, correction=False)
    write_fixture(
        "mcnemar",
        ["pre_response", "post_response", "count"],
        MCNEMAR_ROWS,
        {
            "n": sum(sum(row) for row in table),
            "table": table,
            "a": table[0][0],
            "b": table[0][1],
            "c": table[1][0],
            "d": table[1][1],
            "exact_statistic": float(exact_result.statistic),
            "exact_p": float(exact_result.pvalue),
            "chi2": float(chi_result.statistic),
            "chi2_p": float(chi_result.pvalue),
            "exact": True,
            "correction": False,
        },
        "statsmodels.stats.contingency_tables.mcnemar(table=table, exact=True); statsmodels.stats.contingency_tables.mcnemar(table=table, exact=False, correction=False)",
        "Both discordant cells are at least 5. exact=True is the two-sided exact binomial variant; exact=False with correction=False is the uncorrected asymptotic chi-square variant.",
    )


def fixture_binomial() -> None:
    n = 40
    k = 27
    p0 = 0.5
    result = scipy.stats.binomtest(k=k, n=n, p=p0, alternative="two-sided")
    interval = result.proportion_ci(confidence_level=0.95, method="exact")
    write_fixture(
        "binomial",
        ["trials", "successes", "null_probability"],
        BINOMIAL_ROWS[1:],
        {
            "n": n,
            "k": k,
            "p0": p0,
            "proportion": float(result.statistic),
            "p": float(result.pvalue),
            "ci_95": {
                "lower": float(interval.low),
                "upper": float(interval.high),
            },
            "alternative": "two-sided",
        },
        "scipy.stats.binomtest(k=k, n=n, p=p0, alternative='two-sided').proportion_ci(confidence_level=0.95, method='exact')",
        "The estimate is k/n. The interval is the exact 95% Clopper-Pearson interval for the success proportion under the two-sided binomial test.",
    )


def fixture_wilcoxon_one_sample() -> None:
    x = [row[1] for row in WILCOXON_ROWS]
    mu = 50
    mu_values = [row[2] for row in WILCOXON_ROWS]
    result = scipy.stats.wilcoxon(
        x=x,
        y=mu_values,
        zero_method="wilcox",
        correction=False,
        alternative="two-sided",
        method="exact",
    )
    n_used = sum(value != target for value, target in zip(x, mu_values))
    write_fixture(
        "wilcoxon_one_sample",
        ["participant", "score", "hypothesized_mu"],
        WILCOXON_ROWS,
        {
            "n": n_used,
            "n_observations": len(x),
            "statistic": float(result.statistic),
            "p": float(result.pvalue),
            "mu": mu,
            "alternative": "two-sided",
            "method": "exact",
            "zero_method": "wilcox",
            "correction": False,
        },
        "scipy.stats.wilcoxon(x=x, y=mu_values, zero_method='wilcox', correction=False, alternative='two-sided', method='exact')",
        "The one-sample comparison is score minus mu. zero_method='wilcox' removes the two zero differences, so n is the ten nonzero differences; tied absolute differences are retained in SciPy's exact result.",
    )


def fixture_friedman() -> None:
    condition_a = [row[1] for row in FRIEDMAN_ROWS]
    condition_b = [row[2] for row in FRIEDMAN_ROWS]
    condition_c = [row[3] for row in FRIEDMAN_ROWS]
    result = scipy.stats.friedmanchisquare(condition_a, condition_b, condition_c)
    write_fixture(
        "friedman",
        ["subject", "condition_a", "condition_b", "condition_c"],
        FRIEDMAN_ROWS,
        {
            "n": len(FRIEDMAN_ROWS),
            "k": 3,
            "statistic": float(result.statistic),
            "df": 2,
            "p": float(result.pvalue),
        },
        "scipy.stats.friedmanchisquare(condition_a, condition_b, condition_c)",
        "Three related conditions are ranked within each of ten blocks. SciPy returns the statistic and p value; df is the standard k-1=2 for k=3 conditions.",
    )


def fixture_kendall_tau() -> None:
    x = [row[1] for row in KENDALL_ROWS]
    y = [row[2] for row in KENDALL_ROWS]
    result = scipy.stats.kendalltau(
        x=x,
        y=y,
        variant="b",
        method="auto",
        alternative="two-sided",
    )
    write_fixture(
        "kendall_tau",
        ["participant", "ordinal_x", "ordinal_y"],
        KENDALL_ROWS,
        {
            "n": len(KENDALL_ROWS),
            "tau": float(result.statistic),
            "p": float(result.pvalue),
            "variant": "b",
            "method": "auto",
            "alternative": "two-sided",
        },
        "scipy.stats.kendalltau(x=x, y=y, variant='b', method='auto', alternative='two-sided')",
        "Both ordinal-like columns contain ties. variant='b' is Kendall tau-b; method='auto' selects the asymptotic calculation when ties prevent the exact method.",
    )


def variance_groups() -> tuple[list[str], list[np.ndarray]]:
    names = ["Narrow", "Medium", "Wide"]
    groups = [
        np.asarray([value for group, value in VARIANCE_ROWS if group == name], dtype=float)
        for name in names
    ]
    return names, groups


def group_summaries(names: Sequence[str], groups: Sequence[np.ndarray]) -> dict[str, dict[str, Any]]:
    return {
        name: {
            "n": int(values.size),
            "mean": float(np.mean(values)),
            "sd": float(np.std(values, ddof=1)),
        }
        for name, values in zip(names, groups)
    }


def fixture_welch_anova() -> None:
    names, groups = variance_groups()
    result = anova_oneway(groups, use_var="unequal")
    write_fixture(
        "welch_anova",
        ["group", "response_score"],
        VARIANCE_ROWS,
        {
            "groups": group_summaries(names, groups),
            "F": float(result.statistic),
            "df1": float(result.df_num),
            "df2": float(result.df_denom),
            "p": float(result.pvalue),
        },
        "statsmodels.stats.oneway.anova_oneway(groups, use_var='unequal')",
        "Welch's heteroscedastic ANOVA uses sample SDs with ddof=1. The hand-authored score spreads have SD ratio 1:2:4; statsmodels' default welch_correction=True is left at its default.",
    )


def fixture_tukey_hsd() -> None:
    names, groups = variance_groups()
    endog = np.asarray([value for _, value in VARIANCE_ROWS], dtype=float)
    group_labels = np.asarray([group for group, _ in VARIANCE_ROWS])
    result = pairwise_tukeyhsd(
        endog=endog,
        groups=group_labels,
        alpha=0.05,
    )
    pair_i, pair_j = result._multicomp.pairindices
    unique_names = result._multicomp.groupsunique
    pairs = []
    for index, (i, j) in enumerate(zip(pair_i, pair_j)):
        pairs.append(
            {
                "group1": str(unique_names[i]),
                "group2": str(unique_names[j]),
                "mean_difference": float(result.meandiffs[index]),
                "ci_95": {
                    "lower": float(result.confint[index, 0]),
                    "upper": float(result.confint[index, 1]),
                },
                "p_adjusted": float(result.pvalues[index]),
                "reject": bool(result.reject[index]),
            }
        )
    write_fixture(
        "tukey_hsd",
        ["group", "response_score"],
        VARIANCE_ROWS,
        {
            "alpha": 0.05,
            "groups": group_summaries(names, groups),
            "pairs": pairs,
        },
        "statsmodels.stats.multicomp.pairwise_tukeyhsd(endog=endog, groups=group_labels, alpha=0.05)",
        "All pairwise comparisons use Tukey HSD with alpha=0.05. mean_difference is group2 minus group1 in statsmodels' reported pair order; p_adjusted controls family-wise error.",
    )


def factorial_effects(table: pd.DataFrame) -> dict[str, dict[str, Any]]:
    labels = {
        "A": "C(A, Sum)",
        "B": "C(B, Sum)",
        "A:B": "C(A, Sum):C(B, Sum)",
        "residual": "Residual",
    }
    effects: dict[str, dict[str, Any]] = {}
    for effect, row_label in labels.items():
        row = table.loc[row_label]
        effects[effect] = {
            "SS": finite_float(row["sum_sq"]),
            "df": finite_float(row["df"]),
            "F": finite_float(row["F"]),
            "p": finite_float(row["PR(>F)"]),
        }
    return effects


def finite_float(value: Any) -> float | None:
    converted = float(value)
    return converted if math.isfinite(converted) else None


def fixture_factorial_anova_2way() -> None:
    data = pd.DataFrame(
        FACTORIAL_ROWS,
        columns=["subject", "A", "B", "score"],
    )
    formula = "score ~ C(A, Sum) * C(B, Sum)"
    model = smf.ols(formula=formula, data=data).fit()
    table_typ2 = anova_lm(model, typ=2)
    table_typ3 = anova_lm(model, typ=3)
    write_fixture(
        "factorial_anova_2way",
        ["subject", "A", "B", "score"],
        FACTORIAL_ROWS,
        {
            "formula": formula,
            "typ_2": factorial_effects(table_typ2),
            "typ_3": factorial_effects(table_typ3),
        },
        "statsmodels.formula.api.ols(formula='score ~ C(A, Sum) * C(B, Sum)', data=data).fit(); statsmodels.stats.anova.anova_lm(model, typ=2); statsmodels.stats.anova.anova_lm(model, typ=3)",
        "Between-subjects 2x3 design with four observations per cell and a non-zero A:B interaction. Type III uses Patsy Sum (sum-to-zero) coding via C(A, Sum) and C(B, Sum). The Residual row has no F or p in statsmodels' ANOVA table, so those two required cells are null rather than invented.",
    )


def fixture_logistic_regression() -> None:
    outcomes = np.asarray([row[1] for row in LOGIT_ROWS], dtype=float)
    engagement = np.asarray([row[2] for row in LOGIT_ROWS], dtype=float)
    remote = np.asarray([row[3] for row in LOGIT_ROWS], dtype=float)
    X = np.column_stack([np.ones(len(LOGIT_ROWS)), engagement, remote])
    result = sm.Logit(endog=outcomes, exog=X).fit(
        method="newton",
        maxiter=100,
        disp=False,
    )
    confidence = result.conf_int(alpha=0.05)
    terms = {}
    for index, term in enumerate(["const", "engagement", "remote"]):
        coefficient = float(result.params[index])
        terms[term] = {
            "coef": coefficient,
            "SE": float(result.bse[index]),
            "z": float(result.tvalues[index]),
            "p": float(result.pvalues[index]),
            "odds_ratio": float(np.exp(coefficient)),
            "odds_ratio_ci_95": {
                "lower": float(np.exp(confidence[index, 0])),
                "upper": float(np.exp(confidence[index, 1])),
            },
        }
    llf = float(result.llf)
    llnull = float(result.llnull)
    write_fixture(
        "logistic_regression",
        ["participant", "outcome", "engagement", "remote"],
        LOGIT_ROWS,
        {
            "n": len(LOGIT_ROWS),
            "llf": llf,
            "llnull": llnull,
            "mcfadden_pseudo_r2": 1.0 - (llf / llnull),
            "converged": bool(result.mle_retvals.get("converged", False)),
            "terms": terms,
        },
        "statsmodels.api.Logit(endog=outcomes, exog=X).fit(method='newton', maxiter=100, disp=False); result.conf_int(alpha=0.05)",
        "Binary outcome is modeled with statsmodels Logit and an intercept, continuous engagement, and binary remote predictor. Convergence is verified from result.mle_retvals['converged']; odds-ratio intervals exponentiate result.conf_int(alpha=0.05).",
    )


def main() -> None:
    FIXTURE_ROOT.mkdir(parents=True, exist_ok=True)
    fixture_chisq_gof()
    fixture_fisher_exact_2x2()
    fixture_mcnemar()
    fixture_binomial()
    fixture_wilcoxon_one_sample()
    fixture_friedman()
    fixture_kendall_tau()
    fixture_welch_anova()
    fixture_tukey_hsd()
    fixture_factorial_anova_2way()
    fixture_logistic_regression()
    print("generated 11 Tier-2 fixtures")
    print("versions:", json.dumps(VERSIONS, sort_keys=True))


if __name__ == "__main__":
    main()
