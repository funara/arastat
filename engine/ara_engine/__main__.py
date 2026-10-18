"""Stdio NDJSON-RPC 2.0 loop for the ARA stats engine.

Seam contract: one UTF-8 JSON object per line on stdin; responses and
notifications on stdout. Requests: ``capabilities``, ``run_analysis``,
``cancel``. Notifications (not emitted at scaffold stage):
``analysis/update``, ``analysis/done``. Clean shutdown on stdin EOF.
"""

from __future__ import annotations

import json
import sys

from . import ENGINE_NAME, __version__
from .insights import ChartError, diagnose, render_chart_svg
from .registry import ANALYSES
from .pipeline import AnalysisFailure, error_patches, run_analysis

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
UNKNOWN_ANALYSIS = 1002

KNOWN_METHODS = ("capabilities", "run_analysis", "cancel", "render_chart", "diagnose")

def _error(code: int, message: str, user_message: str, detail: str | None = None) -> dict:
    return {"code": code, "message": message, "data": {"userMessage": user_message, "detail": detail}}


def _emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _reply(msg_id, result=None, error=None) -> None:
    out = {"jsonrpc": "2.0", "id": msg_id}
    if error is not None:
        out["error"] = error
    else:
        out["result"] = result
    _emit(out)


def _handle(msg: dict):
    """Dispatch one request; returns (result, error)."""
    method = msg.get("method")
    params = msg.get("params")
    if method not in KNOWN_METHODS:
        return None, _error(METHOD_NOT_FOUND, "method not found", f"Unknown method {method!r}.")
    if method == "capabilities":
        if params not in (None, {}):
            return None, _error(INVALID_PARAMS, "invalid params", "capabilities takes no parameters.")
        return {"engine": ENGINE_NAME, "version": __version__, "analyses": sorted(ANALYSES)}, None
    if method == "run_analysis":
        if not isinstance(params, dict) or not isinstance(params.get("analysisId"), str):
            return None, _error(
                INVALID_PARAMS,
                "invalid params",
                "run_analysis needs {runId, analysisId, spec, data, missingPolicy}.",
            )
        analysis_id = params["analysisId"]
        if analysis_id not in ANALYSES:
            return None, _error(
                UNKNOWN_ANALYSIS,
                "unknown analysis",
                f"No analysis named {analysis_id!r} is available in this build.",
                f"capabilities.analyses lists {len(ANALYSES)} analyses.",
            )
        run_id = params.get("runId")
        if not isinstance(run_id, str) or not run_id:
            return None, _error(
                INVALID_PARAMS,
                "invalid params",
                "run_analysis needs a non-empty runId string.",
            )
        try:
            patches, stats = run_analysis(
                run_id,
                analysis_id,
                params.get("spec"),
                params.get("data"),
                params.get("missingPolicy", "listwise"),
                params.get("chart"),
            )
        except AnalysisFailure as exc:
            _emit(
                {
                    "jsonrpc": "2.0",
                    "method": "analysis/update",
                    "params": {
                        "runId": run_id,
                        "seq": 1,
                        "patches": error_patches(run_id, exc.user_message, exc.detail),
                    },
                }
            )
            _emit(
                {
                    "jsonrpc": "2.0",
                    "method": "analysis/done",
                    "params": {"runId": run_id, "status": "error"},
                }
            )
            return None, _error(
                exc.code,
                "analysis failed",
                exc.user_message,
                exc.detail,
            )
        # Stream the result-tree patches as one update, then done with the
        # machine-readable stats mirror.
        seq = 1
        for patch in patches:
            _emit(
                {
                    "jsonrpc": "2.0",
                    "method": "analysis/update",
                    "params": {"runId": run_id, "seq": seq, "patches": [patch]},
                }
            )
            seq += 1
        _emit(
            {
                "jsonrpc": "2.0",
                "method": "analysis/done",
                "params": {"runId": run_id, "status": "complete", "stats": stats},
            }
        )
        return {"runId": run_id, "status": "complete"}, None
    if method == "render_chart":
        if not isinstance(params, dict):
            return None, _error(INVALID_PARAMS, "invalid params", "render_chart needs {chart, data}.")
        try:
            data = params.get("data")
            svg, caption = render_chart_svg(params.get("chart"), data if isinstance(data, dict) else {})
        except ChartError as exc:
            return None, _error(1003, "invalid chart", exc.user_message, exc.detail)
        except Exception as exc:
            return None, _error(1004, "invalid chart", "The chart could not be drawn. Check the chart columns and run again.", f"{type(exc).__name__}: {exc}")
        return {"svg": svg, "caption": caption}, None
    if method == "diagnose":
        if not isinstance(params, dict):
            return None, _error(INVALID_PARAMS, "invalid params", "diagnose needs {data}.")
        try:
            data = params.get("data")
            return diagnose(data if isinstance(data, dict) else {}, params.get("group"), params.get("values")), None
        except ChartError as exc:
            return None, _error(1003, "invalid diagnose", exc.user_message, exc.detail)
        except Exception as exc:
            return None, _error(1004, "invalid diagnose", "The data check could not run. Check the data and run again.", f"{type(exc).__name__}: {exc}")
    # method == "cancel"
    if not isinstance(params, dict) or "runId" not in params:
        return None, _error(INVALID_PARAMS, "invalid params", "cancel needs {runId}.")
    # Nothing runs at scaffold stage: nothing to cancel and no analysis/done follows.
    return {"runId": params["runId"], "cancelled": False}, None


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            _reply(None, error=_error(PARSE_ERROR, "parse error", "The engine received a line that is not valid JSON."))
            continue
        msg_id = msg.get("id") if isinstance(msg, dict) else None
        if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0" or not isinstance(msg.get("method"), str):
            _reply(
                msg_id,
                error=_error(INVALID_REQUEST, "invalid request", "Requests must be JSON-RPC 2.0 objects with a string method."),
            )
            continue
        result, error = _handle(msg)
        _reply(msg_id, result=result, error=error)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
