"""Charts (dependency-free SVG) + diagnose (missing/assumptions/serial).

No new third-party deps: SVG is hand-built strings (matplotlib is not
installed and the package mirror is unreachable from here), stats reuse the
numpy/scipy/statsmodels pins already in pyproject. All wording uses
row/column terminology, never variable/case.
"""

from __future__ import annotations

import math

CHART_TYPES = ("scatter", "bar", "hist", "line")

# ponytail: deterministic stride sampling; raise only if charts look thin.
MAX_POINTS = 2000

_PALETTE = ("#2563eb", "#dc2626", "#059669", "#d97706", "#7c3aed", "#0891b2")


class ChartError(Exception):
    """Bad chart request (user_message names the recovery action)."""

    def __init__(self, user_message: str, detail: str | None = None):
        super().__init__(user_message)
        self.user_message = user_message
        self.detail = detail


def _esc(value) -> str:
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def fnum(value):
    """Finite float leaf; anything else → None (JSON null)."""
    if value is None:
        return None
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def _is_missing(value) -> bool:
    return value is None or value == ""


def _num(value):
    if _is_missing(value):
        return None
    try:
        x = float(value)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def _fmt_tick(value: float) -> str:
    if value == 0:
        return "0"
    a = abs(value)
    if a >= 10000 or (a < 0.01 and a > 0):
        return f"{value:.1e}"
    if float(value).is_integer():
        return str(int(value))
    return f"{value:.2f}".rstrip("0").rstrip(".")


def _ticks(lo: float, hi: float, n: int = 5) -> list[float]:
    if not math.isfinite(lo) or not math.isfinite(hi):
        return [0.0]
    if lo == hi:
        lo, hi = lo - 1.0, hi + 1.0
    return [lo + i * (hi - lo) / (n - 1) for i in range(n)]


def _columns_of(data: dict) -> list[str]:
    return [k for k in data if isinstance(data[k], list)]


def _frame(chart, data: dict) -> dict:
    """Validate the chart spec and pull cleaned rows; raises ChartError."""
    if not isinstance(chart, dict):
        raise ChartError(
            "The chart description is missing. Pick a chart type and columns.",
            f"chart is {type(chart).__name__}",
        )
    raw_type = str(chart.get("type", "") or "").lower().strip()
    if raw_type == "histogram":
        raw_type = "hist"
    if raw_type not in CHART_TYPES:
        raise ChartError(
            "Unknown chart type. Use scatter, bar, hist, or line.",
            f"chart type {chart.get('type')!r}",
        )
    if not isinstance(data, dict) or not data:
        raise ChartError(
            "No data arrived with this chart. Open a dataset and run again.",
            "chart data is empty or not an object",
        )
    x = chart.get("x")
    y = chart.get("y")
    group = chart.get("group")
    if y == "":
        y = None
    if group == "":
        group = None
    if not isinstance(x, str) or not x:
        raise ChartError("The chart needs an x column. Choose the x column.", "chart.x missing")
    if raw_type in ("scatter", "line") and (not isinstance(y, str) or not y):
        raise ChartError(
            f"The {raw_type} chart needs a y column. Choose the y column.",
            "chart.y missing",
        )
    if raw_type == "bar" and y is not None and (not isinstance(y, str) or not y):
        raise ChartError(
            "The bar chart y column is invalid. Choose a numeric y column or leave it empty for counts.",
            f"chart.y is {y!r}",
        )
    names = [x] + ([y] if isinstance(y, str) and y else []) + ([group] if isinstance(group, str) and group else [])
    for name in names:
        if name not in data:
            raise ChartError(
                f"Column “{name}” is not in the dataset. Choose an available column.",
                f"column {name!r} missing from data",
            )
        if not isinstance(data[name], list):
            raise ChartError(
                f"Column “{name}” is not a column of values. Reimport the data and run again.",
                f"column {name!r} is not a list",
            )
    lengths = {len(data[n]) for n in names}
    if len(lengths) > 1:
        raise ChartError(
            "The dataset columns have unequal lengths. Reimport the data and run again.",
            f"ragged column lengths {sorted(lengths)}",
        )
    n = len(data[x])
    if n == 0:
        raise ChartError("Column “%s” has no rows. Choose a column with data." % x, "chart column is empty")
    xs_raw = list(data[x])
    ys_raw = list(data[y]) if isinstance(y, str) and y else None
    gs_raw = list(data[group]) if isinstance(group, str) and group else None
    xs: list = []
    ys: list = []
    gs: list = []
    if raw_type in ("scatter", "line", "hist"):
        for i in range(n):
            xv = _num(xs_raw[i])
            if xv is None:
                continue
            if raw_type == "hist":
                xs.append(xv)
                continue
            yv = _num(ys_raw[i]) if ys_raw is not None else None
            if yv is None:
                continue
            xs.append(xv)
            ys.append(yv)
            if gs_raw is not None:
                gs.append("missing" if _is_missing(gs_raw[i]) else str(gs_raw[i]))
    else:  # bar: categorical x, optional numeric y (counts when absent)
        for i in range(n):
            if _is_missing(xs_raw[i]):
                continue
            if ys_raw is not None and _num(ys_raw[i]) is None:
                continue
            xs.append(str(xs_raw[i]))
            if ys_raw is not None:
                ys.append(float(ys_raw[i]))
            if gs_raw is not None:
                gs.append("missing" if _is_missing(gs_raw[i]) else str(gs_raw[i]))
    if not xs:
        raise ChartError(
            "No rows remain for this chart after removing missing values. Check the missing-value rules.",
            "chart frame is empty",
        )
    if len(xs) > MAX_POINTS:
        stride = math.ceil(len(xs) / MAX_POINTS)
        xs = xs[::stride]
        ys = ys[::stride] if ys else ys
        gs = gs[::stride] if gs else gs
    title = chart.get("title")
    title = title.strip() if isinstance(title, str) and title.strip() else None
    if title is None:
        if raw_type == "scatter":
            title = f"{y} vs {x}"
        elif raw_type == "line":
            title = f"{y} over {x}"
        elif raw_type == "bar":
            title = f"{y if y else 'Count'} by {x}"
        else:
            title = f"Distribution of {x}"
    return {
        "type": raw_type, "x": x, "y": y if isinstance(y, str) else None,
        "group": group if isinstance(group, str) else None, "title": title,
        "xs": xs, "ys": ys, "gs": gs,
    }


def _svg_shell(title: str, body: str, xticks: list[str], yticks: list[str]) -> str:
    w, h = 480, 320
    ml, mr, mt, mb = 52, 12, 30, 44
    pw, ph = w - ml - mr, h - mt - mb
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" role="img" aria-label="{_esc(title)}">',
        f"<rect x=\"0\" y=\"0\" width=\"{w}\" height=\"{h}\" fill=\"#ffffff\"/>",
        f"<text x=\"{w // 2}\" y=\"18\" text-anchor=\"middle\" font-size=\"13\" font-family=\"sans-serif\" fill=\"#1a1a1a\">{_esc(title)}</text>",
    ]
    # gridlines + y labels
    for i, lab in enumerate(yticks):
        yy = mt + (ph * i / max(len(yticks) - 1, 1))
        parts.append(f'<line x1="{ml}" y1="{yy:.1f}" x2="{ml + pw}" y2="{yy:.1f}" stroke="#e5e5e5"/>')
        parts.append(f'<text x="{ml - 6}" y="{yy + 4:.1f}" text-anchor="end" font-size="10" font-family="sans-serif" fill="#555">{_esc(lab)}</text>')
    # x labels (first/last/middle to avoid crowding)
    kept = {0, len(xticks) - 1, len(xticks) // 2} if len(xticks) > 3 else set(range(len(xticks)))
    for i, lab in enumerate(xticks):
        if i not in kept:
            continue
        xx = ml + (pw * i / max(len(xticks) - 1, 1))
        short = lab if len(lab) <= 14 else lab[:13] + "…"
        parts.append(f'<text x="{xx:.1f}" y="{mt + ph + 16}" text-anchor="middle" font-size="10" font-family="sans-serif" fill="#555">{_esc(short)}</text>')
    parts.append(body)
    parts.append(f'<rect x="{ml}" y="{mt}" width="{pw}" height="{ph}" fill="none" stroke="#999"/>')
    parts.append("</svg>")
    return "".join(parts)


def _scale(lo: float, hi: float, pix_lo: float, pix_hi: float):
    if lo == hi:
        lo, hi = lo - 1.0, hi + 1.0
    span = hi - lo
    return lambda v: pix_lo + (v - lo) / span * (pix_hi - pix_lo)


def _render_scatter(fr: dict) -> str:
    xs, ys, gs = fr["xs"], fr["ys"], fr["gs"]
    ml, mt = 52, 30
    pw, ph = 480 - ml - 12, 320 - mt - 44
    xlo, xhi = min(xs), max(xs)
    ylo, yhi = min(ys), max(ys)
    pad_x = (xhi - xlo) * 0.05 or 1.0
    pad_y = (yhi - ylo) * 0.05 or 1.0
    xlo, xhi, ylo, yhi = xlo - pad_x, xhi + pad_x, ylo - pad_y, yhi + pad_y
    sx = _scale(xlo, xhi, ml, ml + pw)
    sy = _scale(ylo, yhi, mt + ph, mt)
    levels = list(dict.fromkeys(gs)) if gs else []
    color_of = {lv: _PALETTE[i % len(_PALETTE)] for i, lv in enumerate(levels)}
    dots = []
    for i, (xv, yv) in enumerate(zip(xs, ys)):
        c = color_of.get(gs[i], "#2563eb") if gs else "#2563eb"
        dots.append(f'<circle cx="{sx(xv):.1f}" cy="{sy(yv):.1f}" r="3" fill="{c}" opacity="0.75"/>')
    body = "".join(dots)
    if levels[:6]:
        leg = []
        for i, lv in enumerate(levels[:6]):
            yy = mt + 6 + i * 14
            short = lv if len(lv) <= 12 else lv[:11] + "…"
            leg.append(f'<circle cx="{ml + pw - 8}" cy="{yy}" r="3" fill="{color_of[lv]}"/><text x="{ml + pw - 14}" y="{yy + 3}" text-anchor="end" font-size="9" font-family="sans-serif" fill="#333">{_esc(short)}</text>')
        body += "".join(leg)
    xt = [_fmt_tick(v) for v in _ticks(xlo, xhi)]
    yt = [_fmt_tick(v) for v in reversed(_ticks(ylo, yhi))]
    return _svg_shell(fr["title"], body, xt, yt)


def _render_line(fr: dict) -> str:
    order = sorted(range(len(fr["xs"])), key=lambda i: fr["xs"][i])
    xs = [fr["xs"][i] for i in order]
    ys = [fr["ys"][i] for i in order]
    ml, mt = 52, 30
    pw, ph = 480 - ml - 12, 320 - mt - 44
    xlo, xhi = min(xs), max(xs)
    ylo, yhi = min(ys), max(ys)
    pad_y = (yhi - ylo) * 0.05 or 1.0
    ylo, yhi = ylo - pad_y, yhi + pad_y
    sx = _scale(xlo, xhi, ml, ml + pw)
    sy = _scale(ylo, yhi, mt + ph, mt)
    pts = " ".join(f"{sx(xv):.1f},{sy(yv):.1f}" for xv, yv in zip(xs, ys))
    body = f'<polyline points="{pts}" fill="none" stroke="#2563eb" stroke-width="2"/>'
    xt = [_fmt_tick(v) for v in _ticks(xlo, xhi)]
    yt = [_fmt_tick(v) for v in reversed(_ticks(ylo, yhi))]
    return _svg_shell(fr["title"], body, xt, yt)


def _render_bar(fr: dict) -> str:
    xs, ys = fr["xs"], fr["ys"]
    order = list(dict.fromkeys(xs))
    agg: dict[str, list[float]] = {lv: [] for lv in order}
    if ys:
        for lv, yv in zip(xs, ys):
            agg[lv].append(yv)
        vals = [sum(v) / len(v) for v in (agg[lv] for lv in order)]
    else:
        vals = [float(xs.count(lv)) for lv in order]
    ml, mt = 52, 30
    pw, ph = 480 - ml - 12, 320 - mt - 44
    top = max(vals) if vals else 1.0
    bot = min(0.0, min(vals) if vals else 0.0)
    if top == bot:
        top = bot + 1.0
    sy = _scale(bot, top, mt + ph, mt)
    band = pw / max(len(order), 1)
    bw = band * 0.6
    bars = []
    for i, (lv, vv) in enumerate(zip(order, vals)):
        xx = ml + band * i + (band - bw) / 2
        yy = sy(vv if vv >= 0 else 0)
        hh = abs(sy(vv) - sy(0))
        bars.append(f'<rect x="{xx:.1f}" y="{yy:.1f}" width="{bw:.1f}" height="{max(hh, 1):.1f}" fill="#2563eb" opacity="0.8"/>')
    body = "".join(bars)
    yt = [_fmt_tick(v) for v in reversed(_ticks(bot, top))]
    return _svg_shell(fr["title"], body, order, yt)


def _render_hist(fr: dict) -> str:
    xs = fr["xs"]
    lo, hi = min(xs), max(xs)
    if lo == hi:
        lo, hi = lo - 0.5, hi + 0.5
    nbins = max(5, min(20, int(math.sqrt(len(xs)))))
    width = (hi - lo) / nbins
    counts = [0] * nbins
    for xv in xs:
        b = min(int((xv - lo) / width), nbins - 1)
        counts[b] += 1
    ml, mt = 52, 30
    pw, ph = 480 - ml - 12, 320 - mt - 44
    top = max(counts)
    sy = _scale(0, top if top else 1, mt + ph, mt)
    bw = pw / nbins
    bars = []
    for i, c in enumerate(counts):
        xx = ml + bw * i + 0.5
        yy = sy(c)
        bars.append(f'<rect x="{xx:.1f}" y="{yy:.1f}" width="{bw - 1:.1f}" height="{max(mt + ph - yy, 1):.1f}" fill="#2563eb" opacity="0.8"/>')
    body = "".join(bars)
    xt = [_fmt_tick(lo + i * (hi - lo) / 4) for i in range(5)]
    yt = [_fmt_tick(v) for v in reversed(_ticks(0, top if top else 1, 5))]
    return _svg_shell(fr["title"], body, xt, yt)


def render_chart_svg(chart, data: dict) -> tuple[str, str]:
    """Validate + render; returns (svg, caption). Raises ChartError."""
    fr = _frame(chart, data)
    kind = fr["type"]
    if kind == "scatter":
        svg = _render_scatter(fr)
    elif kind == "line":
        svg = _render_line(fr)
    elif kind == "bar":
        svg = _render_bar(fr)
    else:
        svg = _render_hist(fr)
    return svg, fr["title"]


def render_scree_svg(labels: list, eigenvalues: list) -> str:
    """Scree plot: one bar per component plus the Kaiser λ = 1 threshold line.

    Called straight from the factor-analysis pipeline rather than the AI chart
    spec path, so the caller gets the SVG alone.
    """
    values = [fnum(v) or 0.0 for v in eigenvalues]
    ml, mt = 52, 30
    pw, ph = 480 - ml - 12, 320 - mt - 44
    top = max([*values, 1.0])
    bot = min([*values, 0.0])
    if top == bot:
        top = bot + 1.0
    sy = _scale(bot, top, mt + ph, mt)
    band = pw / max(len(values), 1)
    bw = band * 0.6
    bars = []
    for i, value in enumerate(values):
        xx = ml + band * i + (band - bw) / 2
        yy = sy(value if value >= 0 else 0)
        hh = abs(sy(value) - sy(0))
        bars.append(
            f'<rect x="{xx:.1f}" y="{yy:.1f}" width="{bw:.1f}" height="{max(hh, 1):.1f}"'
            ' fill="#2563eb" opacity="0.8"/>'
        )
    line = sy(1.0)
    body = "".join(bars) + (
        f'<line x1="{ml}" y1="{line:.1f}" x2="{ml + pw}" y2="{line:.1f}"'
        ' stroke="#dc2626" stroke-dasharray="5 3" stroke-width="1.5"/>'
        f'<text x="{ml + pw - 4}" y="{line - 5:.1f}" text-anchor="end" font-size="9"'
        ' font-family="sans-serif" fill="#dc2626">Kaiser λ = 1.0</text>'
    )
    yt = [_fmt_tick(v) for v in reversed(_ticks(bot, top))]
    return _svg_shell("Scree Plot", body, [str(label) for label in labels], yt)


# --- diagnose: missing summary + assumption + serial tests --------------------


def _num_list(values) -> list[float]:
    out = []
    for v in values or []:
        x = _num(v)
        if x is not None:
            out.append(x)
    return out


def missing_report(data: dict, columns: list[str] | None = None) -> dict:
    """Per-column missingness + one deterministic handling recommendation."""
    names = columns or _columns_of(data)
    names = [n for n in names if n in data and isinstance(data[n], list)]
    rows = max((len(data[n]) for n in names), default=0)
    per = []
    missing_cells = 0
    for n in names:
        miss = sum(1 for v in data[n] if _is_missing(v))
        missing_cells += miss
        per.append({"name": n, "missing": miss, "pct": (miss / rows * 100.0) if rows else 0.0})
    complete = 0
    for r in range(rows):
        if all(not _is_missing(data[n][r]) for n in names):
            complete += 1
    total = rows * len(names)
    if missing_cells == 0:
        rec, reason = "ok", "No missing values. Listwise and pairwise handling keep the same rows."
    elif rows and complete == 0:
        rec, reason = "fill", "No complete rows remain, so listwise handling empties the data. Fill or drop before running."
    elif rows and complete / rows >= 0.95:
        rec, reason = "listwise", f"{complete} of {rows} rows are complete. Listwise handling loses little."
    else:
        worst = max(per, key=lambda p: p["pct"]) if per else None
        if worst is not None and worst["pct"] > 40:
            rec = "fill"
            reason = f"Column “{worst['name']}” is {worst['pct']:.0f}% missing. Fill it or drop its rows before running."
        else:
            rec = "fill"
            reason = f"Only {complete} of {rows} rows are complete. Fill missing values or drop incomplete rows."
    return {
        "rows": rows, "columns": len(names), "cells": total, "missingCells": missing_cells,
        "missingPct": (missing_cells / total * 100.0) if total else 0.0,
        "completeRows": complete, "completePct": (complete / rows * 100.0) if rows else 0.0,
        "perColumn": per, "recommendation": rec, "reason": reason,
    }


def _normality(vals: list[float]):
    import scipy.stats as st

    if len(vals) < 3:
        return None
    try:
        if len(vals) <= 5000:
            res = st.shapiro(vals)
        else:
            res = st.normaltest(vals)
        return {"n": len(vals), "stat": fnum(res.statistic), "p": fnum(res.pvalue)}
    except Exception:
        return None


def _levene(groups: list[list[float]]):
    import scipy.stats as st

    try:
        if len(groups) < 2 or any(len(g) < 2 for g in groups):
            return None
        res = st.levene(*groups)
        return {"stat": fnum(res.statistic), "p": fnum(res.pvalue)}
    except Exception:
        return None


def _serial(vals: list[float]):
    if len(vals) < 3:
        return None
    out: dict = {"n": len(vals)}
    try:
        from statsmodels.stats.stattools import durbin_watson

        out["durbinWatson"] = fnum(durbin_watson(vals))
    except Exception:
        out["durbinWatson"] = None
    try:
        import numpy as np
        from statsmodels.stats.diagnostic import acorr_ljungbox

        lag = max(1, min(10, len(vals) // 5))
        lb = acorr_ljungbox(np.asarray(vals, dtype=float), lags=[lag], return_df=True)
        out["ljungBoxLag"] = lag
        out["ljungBoxP"] = fnum(lb["lb_pvalue"].iloc[0])
    except Exception:
        out["ljungBoxP"] = None
    return out


def _regression_assumptions(nums: dict[str, list[float]]):
    """Breusch-Pagan + DW + Jarque-Bera on y ~ X + const; None when it fits nothing."""
    import numpy as np
    import statsmodels.api as sm
    from statsmodels.stats.diagnostic import het_breuschpagan

    keys = [k for k, v in nums.items() if len(v) >= 4]
    if len(keys) < 2:
        return None
    try:
        n = min(len(nums[k]) for k in keys)
        y = np.asarray(nums[keys[0]][:n], dtype=float)
        X = np.column_stack([nums[k][:n] for k in keys[1:]])
        if n < X.shape[1] + 2:
            return None
        X = sm.add_constant(X, has_constant="add")
        fit = sm.OLS(endog=y, exog=X).fit()
        _, bp_p, _, _ = het_breuschpagan(fit.resid, fit.model.exog)
        import scipy.stats as st

        jb_p = fnum(st.jarque_bera(fit.resid).pvalue)
        from statsmodels.stats.stattools import durbin_watson

        return {
            "y": keys[0], "x": keys[1:], "n": int(n),
            "bpP": fnum(bp_p), "durbinWatson": fnum(durbin_watson(fit.resid)), "jbP": jb_p,
        }
    except Exception:
        return None


def diagnose(data: dict, group: str | None = None, values: list[str] | None = None) -> dict:
    """Missing summary + normality + homogeneity + serial (+ regression when 2+ numerics).

    Never raises on thin data: uncomputable slots are null. Raises ChartError
    only for malformed requests (not a dict, ragged columns, unknown names).
    """
    if not isinstance(data, dict) or not data:
        raise ChartError(
            "No data arrived with this check. Open a dataset and run again.",
            "diagnose data is empty or not an object",
        )
    ragged = [n for n, v in data.items() if not isinstance(v, list)]
    if ragged:
        raise ChartError(
            f"Column “{ragged[0]}” is not a column of values. Reimport the data and run again.",
            f"non-list columns {ragged}",
        )
    lengths = {len(v) for v in data.values()}
    if len(lengths) > 1:
        raise ChartError(
            "The dataset columns have unequal lengths. Reimport the data and run again.",
            f"ragged column lengths {sorted(lengths)}",
        )
    names = values or _columns_of(data)
    names = [n for n in names if n in data]
    if group is not None and group not in data:
        raise ChartError(
            f"Column “{group}” is not in the dataset. Choose an available column.",
            f"group column {group!r} missing",
        )
    nums = {n: _num_list(data[n]) for n in names}
    nums = {n: v for n, v in nums.items() if v}
    normality = {n: _normality(v) for n, v in nums.items()}
    homogeneity = None
    if group is not None:
        glabels = [("missing" if _is_missing(v) else str(v)) for v in data[group]]
        levels = list(dict.fromkeys(glabels))
        for n, v in nums.items():
            raw = [_num(x) for x in data[n]]
            grouped = [[x for x, g in zip(raw, glabels) if g == lv and x is not None] for lv in levels]
            lv = _levene(grouped)
            if lv is not None:
                homogeneity = {"value": n, "group": group, "levels": levels, **lv}
                break
    serial = {n: _serial(v) for n, v in nums.items()}
    return {
        "missing": missing_report(data, names),
        "normality": normality,
        "homogeneity": homogeneity,
        "serial": serial,
        "regression": _regression_assumptions(nums),
    }
