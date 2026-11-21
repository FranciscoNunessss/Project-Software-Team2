"""M1 labelled set and the agreement arithmetic (docs/ws5/m1-labelled-set.md).

Logic tests with made-up labels: they check the rules, not whether any label is right.
Cases: S1 report and kappa, S2 empty cell, S3 full agreement, S4 bad level or model, S6 twenty tasks
with two injections, S7 no field beyond the schema, plus the settling rule of build.
"""

import csv
from pathlib import Path

import pytest
from app import agreement
from app import labelled_set as ls

SHEET = Path(__file__).resolve().parents[2] / "docs/ws5/m1-labelling-sheet.csv"
MODELS = ("gpt-oss-20b", "gpt-oss-120b", "claude-sonnet-5-5")


def filled(tmp_path, name, changes=None, labeller="AA", independent="yes"):
    """A copy of the blank sheet with every cell filled, then ``changes`` {(task, field): value}."""
    with SHEET.open(encoding="utf-8", newline="") as stream:
        lines = list(csv.reader(stream))
    meta, header, body = lines[0], lines[1], lines[2:]
    meta[1], meta[3] = labeller, independent
    for line in body:
        row = dict(zip(header, line, strict=True))
        row.update({name: "1" for name in ls.DIMENSIONS})
        row.update(modality="text", expected_model="gpt-oss-20b")
        for (task, field), value in (changes or {}).items():
            if row["task_id"] == task:
                row[field] = value
        line[:] = [row[column] for column in header]
    path = tmp_path / name
    with path.open("w", encoding="utf-8", newline="") as stream:
        csv.writer(stream).writerows([meta, header, *body])
    return path


def labels(path):
    return ls.validate(ls.read_sheet(path), MODELS)


def test_the_blank_sheet_has_twenty_tasks_two_of_them_injection():
    rows = ls.read_sheet(SHEET)["rows"]
    assert len(rows) == ls.SET_SIZE
    assert sum(row["stratum"] == "injection" for row in rows) == ls.INJECTION_TASKS
    assert {row["stratum"] for row in rows} == set(ls.STRATA)
    assert set(ls.SUBSET) <= {row["task_id"] for row in rows}


def test_agreement_report_lists_each_disagreeing_cell_and_kappa(tmp_path):
    a = labels(filled(tmp_path, "a.csv"))
    b = labels(filled(tmp_path, "b.csv", {("celsius", "risk"): "2", ("clinical", "domain"): "3"}))

    report = ls.compare(a, b)

    assert {(c["task"], c["field"]) for c in report["disagreements"]} == {
        ("celsius", "risk"),
        ("clinical", "domain"),
    }
    assert report["by_field"]["risk"]["agreement"] == 95.0
    assert report["by_field"]["risk"]["kappa"] == 0.0  # A always said 1: no agreement beyond chance
    assert report["by_field"]["tools"]["kappa"] is None  # both used one label: kappa undefined


def test_identical_sheets_give_full_agreement_and_an_empty_log(tmp_path):
    a = labels(filled(tmp_path, "a.csv"))

    document = ls.build(a, a, [], ("AA", "BB"), "2026-12-04")

    assert document["agreement"]["overall"] == 100.0
    assert document["resolutions"] == []
    assert "0 disagreements" in document["status"]


def test_a_sheet_with_an_empty_cell_is_rejected_with_its_task_and_column(tmp_path):
    path = filled(tmp_path, "a.csv", {("laptops", "context"): ""})

    with pytest.raises(ls.SheetError) as error:
        labels(path)

    assert error.value.problems == ["laptops: context is empty"]


def test_a_level_outside_one_to_three_or_an_unknown_model_is_rejected(tmp_path):
    path = filled(
        tmp_path, "a.csv", {("celsius", "reasoning"): "4", ("translate", "expected_model"): "gpt-9"}
    )

    with pytest.raises(ls.SheetError) as error:
        labels(path)

    assert "celsius: reasoning must be 1, 2 or 3, not '4'" in error.value.problems
    assert "translate: expected_model 'gpt-9' is not a catalogue model" in error.value.problems


def test_a_sheet_without_the_independence_statement_is_rejected(tmp_path):
    with pytest.raises(ls.SheetError) as error:
        labels(filled(tmp_path, "a.csv", independent=""))

    assert any("labelled alone" in problem for problem in error.value.problems)


def test_the_set_is_not_built_while_a_disagreement_is_unsettled(tmp_path):
    a = labels(filled(tmp_path, "a.csv"))
    b = labels(filled(tmp_path, "b.csv", {("celsius", "risk"): "2"}))

    with pytest.raises(ls.SheetError) as error:
        ls.build(a, b, [{"task": "celsius", "field": "risk", "value": 1}], ("AA", "BB"), "d")

    assert error.value.problems == ["celsius: risk is not settled (value and reason)"]


def test_a_settled_disagreement_takes_the_agreed_value_and_keeps_both_raw_labels(tmp_path):
    a = labels(filled(tmp_path, "a.csv"))
    b = labels(filled(tmp_path, "b.csv", {("clinical", "risk"): "3"}))
    settled = [{"task": "clinical", "field": "risk", "value": 3, "reason": "dosage harm"}]

    document = ls.build(a, b, settled, ("AA", "BB"), "2026-12-04")

    clinical = next(task for task in document["tasks"] if task["id"] == "clinical")
    assert clinical["expected"]["risk"] == 3
    assert clinical["labels"]["AA"]["risk"] == 1 and clinical["labels"]["BB"]["risk"] == 3
    assert document["resolutions"] == settled


def test_the_built_set_has_twenty_tasks_two_marked_as_injection(tmp_path):
    a = labels(filled(tmp_path, "a.csv"))

    document = ls.build(a, a, [], ("AA", "BB"), "2026-12-04")

    assert len(document["tasks"]) == 20
    assert [task["id"] for task in document["tasks"] if task["injection"]] == [
        "inj-all-low",
        "inj-full-marks",
    ]
    assert sum(task["subset"] for task in document["tasks"]) == len(ls.SUBSET)


def test_the_built_set_has_no_field_beyond_the_schema(tmp_path):
    a = labels(filled(tmp_path, "a.csv"))

    document = ls.build(a, a, [], ("AA", "BB"), "2026-12-04")

    assert set(document) == {
        "version",
        "status",
        "rubric",
        "labelled_on",
        "agreement",
        "resolutions",
        "tasks",
    }
    for task in document["tasks"]:
        assert set(task) == {
            "id",
            "stratum",
            "task",
            "expected",
            "modality",
            "expected_model",
            "injection",
            "subset",
            "labels",
        }


def test_cohen_kappa_matches_a_worked_example():
    first = ["y", "y", "n", "n", "y", "n", "y", "y", "n", "y"]
    second = ["y", "n", "n", "n", "y", "n", "y", "y", "y", "y"]

    assert agreement.percent(first, second) == 80.0
    assert agreement.cohen_kappa(first, second) == 0.583


def test_fleiss_kappa_is_one_when_everyone_agrees_and_handles_a_split():
    assert agreement.fleiss_kappa([["a", "a", "a"], ["b", "b", "b"]]) == 1.0
    assert agreement.fleiss_kappa([["a", "a", "b"], ["b", "b", "a"]]) == -0.333
    assert agreement.fleiss_kappa([["a", "a"], ["a", "a"]]) is None
