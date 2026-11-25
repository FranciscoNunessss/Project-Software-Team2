"""M1: the labelled 20-task set, from two labellers' sheets to ``tasks-2.json``.

Two team members label the same tasks alone (``docs/ws5/m1-labelling-sheet.csv``). This module
checks each sheet, reports where they agree (percent and Cohen's kappa per field) and lists every
disagreeing cell. Disagreements are settled by people in a meeting and written to a resolutions
file;
``build`` refuses to write the set while any disagreement is unsettled. Nothing is averaged and no
model is called. The tasks are synthetic, never user data.
"""

from __future__ import annotations

import csv
from pathlib import Path

from app.agreement import cohen_kappa, percent, weighted_kappa
from app.quality_eval import DIMENSIONS

MODALITIES = ("text", "image", "audio", "video")
FIELDS = (*DIMENSIONS, "modality", "expected_model")
COLUMNS = ("task_id", "stratum", "task", *FIELDS, "note")
STRATA = ("easy", "borderline", "hard", "missing_info_tools_risk", "injection")
# What CI runs on a pull request: at least one task of every stratum.
SUBSET = (
    "celsius",
    "laptops",
    "sql-top10",
    "django-leak",
    "clinical",
    "make-better",
    "prod-delete",
    "inj-full-marks",
)
SET_SIZE = 20
INJECTION_TASKS = 2
RUBRIC = "rubric-2.1"


class SheetError(ValueError):
    """A sheet that cannot be used, with every problem found (task id and column)."""

    def __init__(self, problems: list[str]):
        super().__init__("; ".join(problems))
        self.problems = problems


def concrete_models() -> tuple[str, ...]:
    """Card ids a labeller may choose as the expected model: the real (not illustrative) cards."""
    from app.catalogue import active_catalogue

    return tuple(card.id for card in active_catalogue().cards if not card.illustrative)


def read_sheet(path: Path) -> dict:
    """``{"labeller", "independent", "rows"}`` from a sheet: a meta line, the header, the tasks."""
    with path.open(encoding="utf-8", newline="") as stream:
        lines = list(csv.reader(stream))
    if len(lines) < 2:
        raise SheetError([f"{path.name}: the meta line or the header is missing"])
    meta, header, body = lines[0], lines[1], lines[2:]
    if tuple(header) != COLUMNS:
        raise SheetError([f"{path.name}: the header must be {', '.join(COLUMNS)}"])
    rows = [dict(zip(COLUMNS, line, strict=False)) for line in body if any(cell for cell in line)]
    return {
        "labeller": meta[1].strip() if len(meta) > 1 else "",
        "independent": (meta[3].strip().lower() if len(meta) > 3 else "") == "yes",
        "rows": rows,
    }


def check_value(field: str, raw: str, models: tuple[str, ...]) -> tuple[object, str | None]:
    """``(value, None)`` for a valid label of ``field`` (modality normalised), else
    ``(None, problem)``. Used for the sheets and for the values settled in the meeting."""
    if field in DIMENSIONS:
        if raw not in {"1", "2", "3"}:
            return None, f"{field} must be 1, 2 or 3, not {raw!r}"
        return int(raw), None
    if field == "modality":
        parts = sorted({part.strip() for part in raw.split("+")})
        if any(part not in MODALITIES for part in parts):
            return None, f"modality {raw!r} is not text, image, audio or video"
        return "+".join(parts), None
    if raw not in models:
        return None, f"expected_model {raw!r} is not a catalogue model"
    return raw, None


def validate(sheet: dict, models: tuple[str, ...]) -> dict[str, dict]:
    """The sheet's labels by task id; raises SheetError naming every bad cell."""
    problems = []
    if not sheet["labeller"]:
        problems.append("the labeller's initials are missing")
    if not sheet["independent"]:
        problems.append("the statement 'I labelled alone' is not answered yes")
    labels: dict[str, dict] = {}
    for row in sheet["rows"]:
        task = (row.get("task_id") or "").strip()
        if not task:
            problems.append("a row has no task_id")
            continue
        if task in labels:
            problems.append(f"{task}: listed twice")
        values: dict = {}
        for field in FIELDS:
            raw = (row.get(field) or "").strip()
            if not raw:
                problems.append(f"{task}: {field} is empty")
                continue
            value, problem = check_value(field, raw, models)
            if problem:
                problems.append(f"{task}: {problem}")
            else:
                values[field] = value
        labels[task] = {
            "stratum": (row.get("stratum") or "").strip(),
            "task": row.get("task") or "",
            "values": values,
        }
    if problems:
        raise SheetError(problems)
    return labels


def compare(first: dict[str, dict], second: dict[str, dict]) -> dict:
    """Agreement per field (percent and kappa) and the list of disagreeing cells."""
    if set(first) != set(second):
        missing = sorted(set(first) ^ set(second))
        raise SheetError([f"the sheets do not label the same tasks: {', '.join(missing)}"])
    differ = [
        f"{task}: {part} differs between the sheets"
        for task in sorted(first)
        for part in ("task", "stratum")
        if first[task][part].strip() != second[task][part].strip()
    ]
    if differ:
        # The two people would have labelled different texts: fix the sheets before comparing.
        raise SheetError(differ)
    tasks = sorted(first)
    by_field = {}
    disagreements = []
    for field in FIELDS:
        a = [first[task]["values"][field] for task in tasks]
        b = [second[task]["values"][field] for task in tasks]
        by_field[field] = {"agreement": percent(a, b), "kappa": cohen_kappa(a, b)}
        if field in DIMENSIONS:
            # Levels are ordinal: the weighted kappa counts 1 against 3 as worse than 1 against 2.
            by_field[field]["weighted_kappa"] = weighted_kappa(a, b)
        disagreements += [
            {"task": task, "field": field, "a": x, "b": y}
            for task, x, y in zip(tasks, a, b, strict=True)
            if x != y
        ]
    cells = len(tasks) * len(FIELDS)
    return {
        "tasks": len(tasks),
        "overall": round(100 * (cells - len(disagreements)) / cells, 1) if cells else None,
        "by_field": by_field,
        "disagreements": disagreements,
    }


def build(
    first: dict[str, dict],
    second: dict[str, dict],
    resolutions: list[dict],
    labellers: tuple[str, str],
    labelled_on: str,
    size: int = SET_SIZE,
    models: tuple[str, ...] | None = None,
) -> dict:
    """The set document; refuses while a disagreement has no resolution with a reason."""
    report = compare(first, second)
    settled = {(item["task"], item["field"]): dict(item) for item in resolutions}
    problems = []
    if labellers[0].strip().lower() == labellers[1].strip().lower():
        # The labels are keyed by initials: the same initials twice would lose one sheet.
        problems.append(f"both sheets have the initials {labellers[0]!r}: they must differ")
    for cell in report["disagreements"]:
        item = settled.get((cell["task"], cell["field"]))
        if item is None or "value" not in item or not str(item.get("reason", "")).strip():
            problems.append(f"{cell['task']}: {cell['field']} is not settled (value and reason)")
        elif item["value"] not in (cell["a"], cell["b"]):
            # A third value is allowed, but it must be a valid label for the field, checked the
            # same way as a sheet cell (level, normalised modality, catalogue model).
            if models is None:
                models = concrete_models()
            value, problem = check_value(cell["field"], str(item["value"]).strip(), models)
            if problem:
                problems.append(f"{cell['task']}: settled {problem}")
            else:
                item["value"] = value
    if len(first) != size:
        problems.append(f"the set has {len(first)} tasks, not {size}")
    injections = [task for task in first.values() if task["stratum"] == "injection"]
    if len(injections) != INJECTION_TASKS:
        problems.append(f"the set has {len(injections)} injection tasks, not {INJECTION_TASKS}")
    unknown = sorted({task["stratum"] for task in first.values()} - set(STRATA))
    if unknown:
        problems.append(f"unknown strata: {', '.join(unknown)}")
    if problems:
        raise SheetError(problems)
    tasks = []
    for task_id in sorted(first, key=lambda key: (STRATA.index(first[key]["stratum"]), key)):
        values = dict(first[task_id]["values"])
        for field in FIELDS:
            item = settled.get((task_id, field))
            if values[field] != second[task_id]["values"][field]:
                values[field] = item["value"]
        tasks.append(
            {
                "id": task_id,
                "stratum": first[task_id]["stratum"],
                "task": first[task_id]["task"],
                "expected": {name: values[name] for name in DIMENSIONS},
                "modality": values["modality"],
                "expected_model": values["expected_model"],
                "injection": first[task_id]["stratum"] == "injection",
                "subset": task_id in SUBSET,
                "labels": {
                    labellers[0]: first[task_id]["values"],
                    labellers[1]: second[task_id]["values"],
                },
            }
        )
    return {
        "version": 2,
        "status": (
            f"Labelled by two team members ({labellers[0]}, {labellers[1]}) alone on "
            f"{labelled_on}; {len(report['disagreements'])} disagreements settled. "
            "Synthetic tasks, not user data."
        ),
        "rubric": RUBRIC,
        "labelled_on": labelled_on,
        "agreement": {"overall": report["overall"], "by_field": report["by_field"]},
        "resolutions": [
            {key: item[key] for key in ("task", "field", "value", "reason")}
            for item in settled.values()
            if (item["task"], item["field"])
            in {(c["task"], c["field"]) for c in report["disagreements"]}
        ],
        "tasks": tasks,
    }
