"""Analysis registry: the 23 analyses of D2(c) and their option schemas.

Keys of ``ANALYSES`` are the fixture directory names and are listed in
alphabetical order; ``capabilities.analyses`` reports exactly this order.
Each schema maps an option key to a kind tuple:

    ("str",)                  non-empty string (a variable name)
    ("num",)                  int or float (not bool)
    ("str_list",)             list of non-empty strings
    ("enum", (v1, v2, ...))   string drawn from a fixed set

Every schema key is required; anything else is rejected as error 1001.
"""

from __future__ import annotations

ANALYSES: dict[str, dict[str, tuple]] = {
    "anova_oneway": {"dep": ("str",), "factor": ("str",)},
    "binomial": {
        "n": ("str",),
        "p0": ("num",),
        "successLevel": ("num",),
        "variable": ("str",),
    },
    "chisq_gof": {
        "expectedProportions": ("enum", ("equal",)),
        "variable": ("str",),
    },
    "chisq_independence": {"col": ("str",), "row": ("str",)},
    "correlation": {"variables": ("str_list",)},
    "descriptives": {"variables": ("str_list",)},
    "factorial_anova_2way": {
        "coding": ("enum", ("sum-to-zero", "treatment")),
        "dep": ("str",),
        "factors": ("str_list",),
    },
    "fisher_exact_2x2": {
        "alternative": ("enum", ("two-sided", "less", "greater")),
        "col": ("str",),
        "count": ("str",),
        "row": ("str",),
    },
    "frequencies": {"variables": ("str_list",)},
    "friedman": {"conditions": ("str_list",)},
    "kendall_tau": {
        "a": ("str",),
        "alternative": ("enum", ("two-sided", "less", "greater")),
        "b": ("str",),
        "method": ("enum", ("auto", "exact", "asymptotic")),
        "variant": ("enum", ("a", "b", "c")),
    },
    "kruskal_wallis": {"dep": ("str",), "factor": ("str",)},
    "linear_regression": {"dep": ("str",), "predictors": ("str_list",)},
    "logistic_regression": {
        "dep": ("str",),
        "model": ("enum", ("Logit", "probit")),
        "predictors": ("str_list",),
    },
    "mannwhitney_u": {"dep": ("str",), "group": ("str",)},
    "mcnemar": {"after": ("str",), "before": ("str",), "count": ("str",)},
    "shapiro_wilk": {"dep": ("str",)},
    "spearman_correlation": {"a": ("str",), "b": ("str",)},
    "ttest_independent": {"dep": ("str",), "group": ("str",)},
    "ttest_onesample": {"dep": ("str",), "testValue": ("num",)},
    "ttest_paired": {"a": ("str",), "b": ("str",)},
    "tukey_hsd": {"alpha": ("num",), "dep": ("str",), "factor": ("str",)},
    "welch_anova": {
        "dep": ("str",),
        "factor": ("str",),
        "useVar": ("enum", ("unequal", "equal")),
    },
    "wilcoxon_one_sample": {
        "alternative": ("enum", ("two-sided", "less", "greater")),
        "dep": ("str",),
        "method": ("enum", ("exact", "approx", "auto")),
        "mu": ("num",),
        "zeroMethod": ("enum", ("wilcox", "wilcox-pratt", "zsplit")),
    },
    "wilcoxon_signedrank": {"a": ("str",), "b": ("str",)},
}

TITLES = {
    "anova_oneway": "One-way ANOVA",
    "binomial": "Binomial test",
    "chisq_gof": "Chi-square goodness of fit",
    "chisq_independence": "Chi-square test of independence",
    "correlation": "Correlation matrix",
    "descriptives": "Descriptive statistics",
    "factorial_anova_2way": "Two-way factorial ANOVA",
    "fisher_exact_2x2": "Fisher’s exact test (2x2)",
    "frequencies": "Frequency tables",
    "friedman": "Friedman test",
    "kendall_tau": "Kendall’s tau",
    "kruskal_wallis": "Kruskal-Wallis test",
    "linear_regression": "Linear regression",
    "logistic_regression": "Logistic regression",
    "mannwhitney_u": "Mann-Whitney U test",
    "mcnemar": "McNemar’s test",
    "shapiro_wilk": "Shapiro-Wilk normality test",
    "spearman_correlation": "Spearman rank correlation",
    "ttest_independent": "Independent-samples t-test",
    "ttest_onesample": "One-sample t-test",
    "ttest_paired": "Paired-samples t-test",
    "tukey_hsd": "Tukey HSD",
    "welch_anova": "Welch’s ANOVA",
    "wilcoxon_one_sample": "One-sample Wilcoxon signed-rank test",
    "wilcoxon_signedrank": "Paired-samples Wilcoxon signed-rank test",
}


class SpecError(Exception):
    """Invalid spec (error 1001). ``user_message`` names the recovery action."""

    def __init__(self, user_message: str, detail: str | None = None):
        super().__init__(user_message)
        self.user_message = user_message
        self.detail = detail


def _check_value(key: str, kind: tuple, value, title: str) -> None:
    if kind[0] == "str":
        ok = isinstance(value, str) and value != ""
        expected = "a non-empty variable name"
    elif kind[0] == "num":
        ok = isinstance(value, (int, float)) and not isinstance(value, bool)
        expected = "a number"
    elif kind[0] == "str_list":
        ok = (
            isinstance(value, list)
            and len(value) > 0
            and all(isinstance(v, str) and v != "" for v in value)
        )
        expected = "a list of non-empty variable names"
        if ok and len(kind) > 1 and len(value) != kind[1]:
            ok = False
            expected = f"exactly {kind[1]} non-empty variable names"
    else:  # ("enum", values)
        ok = isinstance(value, str) and value in kind[1]
        expected = "one of " + ", ".join(repr(v) for v in kind[1])
    if not ok:
        raise SpecError(
            f"Option “{key}” of {title} needs {expected}. Change the option value.",
            f"option {key!r} expects {expected}, got {value!r}",
        )


def validate_spec(analysis_id: str, spec) -> dict:
    """Validate the option VALUES map for ``analysis_id`` (error 1001)."""
    schema = ANALYSES[analysis_id]
    title = TITLES[analysis_id]
    if not isinstance(spec, dict):
        raise SpecError(
            f"The options for {title} are missing. Choose the analysis options and run again.",
            f"spec is {type(spec).__name__}, expected object",
        )
    for key in schema:
        if key not in spec:
            raise SpecError(
                f"Option “{key}” of {title} is missing. Set the option and run again.",
                f"required option {key!r} missing",
            )
    for key in spec:
        if key not in schema:
            raise SpecError(
                f"Unknown option “{key}” for {title}. Remove it from the options.",
                f"unknown option {key!r}; allowed: {sorted(schema)}",
            )
    for key, kind in schema.items():
        _check_value(key, kind, spec[key], title)
    return spec
