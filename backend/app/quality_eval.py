"""Quality evaluation of the task profile: scoring and the regression gate.

This is not a contract test. A contract test checks that the code keeps its promises with a fake
model; this module scores what a real model answered against the expected levels of a labelled
task set, and compares that score with the last baseline. The runner that calls the model is
``scripts/run_quality_eval.py``; everything here is pure so it can be tested without a model.

Reports never contain the text of a task: only its id, the levels, the confidence and the cost.
"""

from __future__ import annotations

from collections import defaultdict

DIMENSIONS = ("reasoning", "context", "ambiguity", "domain", "risk", "tools")
MAX_DROP_POINTS = 5.0
MAX_FAILED_SHARE = 0.10

PASS = "pass"
REGRESSION = "regression"
ACCEPTED = "accepted"
NOT_RUN = "not_run"
NO_BASELINE = "no_baseline"
NOT_COMPARABLE = "not_comparable"


def score(rows: list[dict], expected: dict[str, dict[str, int]]) -> dict:
    """Agreement with the expected levels.

    ``rows``: one per analysis, ``{"task", "levels": {dimension: level or None}}`` or
    ``{"task", "error"}`` when the provider failed. Only labelled dimensions are scored. An
    undetermined level counts as a disagreement (the gate must not reward a model that declines).
    """
    cells = defaultdict(
        lambda: {"n": 0, "exact": 0, "within_1": 0, "abs_error": 0, "undetermined": 0}
    )
    failed = 0
    analyses = 0
    for row in rows:
        analyses += 1
        if "error" in row or "levels" not in row:
            failed += 1
            continue
        for dimension, wanted in expected.get(row["task"], {}).items():
            got = row["levels"].get(dimension)
            for key in (dimension, "all"):
                cell = cells[key]
                cell["n"] += 1
                if got is None:
                    cell["undetermined"] += 1
                    continue
                cell["exact"] += got == wanted
                cell["within_1"] += abs(got - wanted) <= 1
                cell["abs_error"] += abs(got - wanted)

    def finish(cell: dict) -> dict:
        n = cell["n"]
        decided = n - cell["undetermined"]
        return {
            "n": n,
            "agreement": round(100 * cell["exact"] / n, 1) if n else None,
            "within_1": round(100 * cell["within_1"] / n, 1) if n else None,
            "mean_abs_error": round(cell["abs_error"] / decided, 2) if decided else None,
            "undetermined": cell["undetermined"],
        }

    return {
        "analyses": analyses,
        "failed": failed,
        "overall": finish(cells["all"])
        if cells["all"]["n"]
        else finish({"n": 0, "exact": 0, "within_1": 0, "abs_error": 0, "undetermined": 0}),
        "by_dimension": {d: finish(cells[d]) for d in DIMENSIONS if cells[d]["n"]},
    }


def run_status(metrics: dict) -> str:
    """``not_run`` when too many analyses failed to say anything about quality."""
    analyses = metrics["analyses"]
    if analyses == 0 or metrics["failed"] / analyses > MAX_FAILED_SHARE:
        return NOT_RUN
    return PASS


def compare(
    baseline: dict | None,
    current: dict,
    accepted: list[dict] | None = None,
    max_drop: float = MAX_DROP_POINTS,
) -> dict:
    """Is the current run worse than the baseline by more than ``max_drop`` percentage points?

    Each report carries ``status``, ``metrics``, ``task_set`` (the version of the labelled set),
    ``rubric`` and ``model``. A drop beyond ``max_drop`` is a regression unless ``accepted`` has an
    entry for the same model and rubric, naming the ADR in which the Architecture Owner accepted
    it. A run that did not run is never compared and never passes.
    """
    if current["status"] == NOT_RUN:
        return {
            "verdict": NOT_RUN,
            "reason": "too many analyses failed: the quality was not measured",
        }
    if baseline is None:
        return {
            "verdict": NO_BASELINE,
            "reason": "no baseline for this model yet: this run can become it",
        }
    same = all(baseline.get(key) == current.get(key) for key in ("task_set", "rubric", "model"))
    if not same:
        return {
            "verdict": NOT_COMPARABLE,
            "reason": "the task set, the rubric or the model differs from the baseline",
        }
    before = baseline["metrics"]["overall"]["agreement"]
    now = current["metrics"]["overall"]["agreement"]
    drop = round(before - now, 1)
    detail = {"before": before, "now": now, "drop_points": drop, "max_drop": max_drop}
    dimensions = {}
    for name, cell in current["metrics"]["by_dimension"].items():
        old = baseline["metrics"]["by_dimension"].get(name)
        if old and old["agreement"] is not None and cell["agreement"] is not None:
            dimensions[name] = round(old["agreement"] - cell["agreement"], 1)
    detail["dimension_drops"] = dimensions
    if drop <= max_drop:
        return {"verdict": PASS, **detail}
    for item in accepted or []:
        if (
            item.get("model") == current["model"]
            and item.get("rubric") == current["rubric"]
            and item.get("adr")
        ):
            return {"verdict": ACCEPTED, "adr": item["adr"], **detail}
    return {"verdict": REGRESSION, **detail}
