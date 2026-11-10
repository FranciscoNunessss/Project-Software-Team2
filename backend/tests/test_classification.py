"""Provisional levels from a benchmark snapshot (ADR-014, docs/model-classification.md)."""

import pytest
from app.classification import (
    DOMAIN_MEAN,
    INDEX,
    build_mapping,
    facts_from_openrouter,
    level,
    rate,
    snapshot_entry,
    thresholds,
)

TODAY = "2026-11-06"


def snapshot(models):
    return {
        "source": "Artificial Analysis",
        "source_url": "https://artificialanalysis.ai/",
        "file": "aa-test.json",
        "tier": "free",
        "intelligence_index_version": 4,
        "observed_on": TODAY,
        "models": models,
    }


def free_models():
    """100 models with only the free indices, values 1..100."""
    return [
        snapshot_entry(
            {
                "slug": f"m{value}",
                "name": f"M{value}",
                "evaluations": {
                    INDEX: value,
                    "artificial_analysis_legal_index": value,
                    "artificial_analysis_engineering_index": value + 1,
                    "artificial_analysis_coding_index": None,
                },
            }
        )
        for value in range(1, 101)
    ]


def test_snapshot_entry_keeps_numbers_only_and_averages_the_industry_indices():
    entry = snapshot_entry(
        {
            "slug": "x",
            "evaluations": {
                INDEX: 20,
                "artificial_analysis_legal_index": 10,
                "artificial_analysis_economics_index": 20,
                "artificial_analysis_agentic_index": None,
                "flag": True,
            },
        }
    )
    assert entry["metrics"] == {
        INDEX: 20.0,
        "artificial_analysis_legal_index": 10.0,
        "artificial_analysis_economics_index": 20.0,
        DOMAIN_MEAN: 15.0,
    }
    assert snapshot_entry({"name": "no slug"}) is None


def test_thresholds_are_the_34th_and_67th_percentiles_and_need_ten_models():
    limits = thresholds([float(value) for value in range(1, 101)])
    assert limits["models"] == 100
    assert 33 <= limits["level_2_from"] <= 35 and 66 <= limits["level_3_from"] <= 68
    with pytest.raises(ValueError):
        thresholds([1.0] * 9)
    assert level(10, limits) == 1 and level(50, limits) == 2 and level(90, limits) == 3


def test_mapping_freezes_absolute_thresholds_for_the_metrics_present():
    mapping = build_mapping(snapshot(free_models()), "benchmark-mapping-1", TODAY)
    assert set(mapping["thresholds"]) == {INDEX, DOMAIN_MEAN}
    assert mapping["percentiles"] == [34, 67]
    assert mapping["snapshot"] == "aa-test.json"


def test_rate_falls_back_to_the_indices_and_says_so():
    mapping = build_mapping(snapshot(free_models()), "benchmark-mapping-1", TODAY)
    entry = snapshot_entry(
        {"slug": "x", "evaluations": {INDEX: 90, "artificial_analysis_legal_index": 20}}
    )
    ratings = rate(entry, mapping, tool_calling=True)
    assert ratings["reasoning"]["level"] == 3
    assert ratings["domain"]["level"] == 1
    assert "domain_indices_mean=20" in ratings["domain"]["source"]
    assert "fallback" in ratings["reasoning"]["source"]
    assert all(item["status"] == "provisional" for item in ratings.values())


def test_preferred_benchmark_wins_when_present():
    models = free_models()
    for position, entry in enumerate(models):
        entry["metrics"]["gpqa_diamond"] = float(position)
    mapping = build_mapping(snapshot(models), "benchmark-mapping-1", TODAY)
    entry = snapshot_entry({"slug": "x", "evaluations": {INDEX: 90, "gpqa_diamond": 1}})
    ratings = rate(entry, mapping, tool_calling=True)
    assert ratings["reasoning"]["level"] == 1
    assert "gpqa_diamond=1" in ratings["reasoning"]["source"]
    assert "fallback" not in ratings["reasoning"]["source"]


def test_no_tool_calling_is_tools_1_and_a_missing_model_is_unrated():
    mapping = build_mapping(snapshot(free_models()), "benchmark-mapping-1", TODAY)
    ratings = rate(None, mapping, tool_calling=False)
    assert ratings["tools"]["level"] == 1
    assert ratings["reasoning"] == {"level": None, "status": "unrated"}


def test_facts_from_openrouter():
    facts = facts_from_openrouter(
        {
            "id": "google/gemma-x",
            "context_length": 131072,
            "top_provider": {"context_length": None},
            "input_modalities": ["text", "image", "file"],
            "supported_parameters": ["tools", "response_format"],
            "structured_output": True,
            "price_input_per_million": 0.1,
            "price_output_per_million": 0.2,
            "free": False,
        },
        TODAY,
    )
    assert facts["modalities"] == ["text", "image"]
    assert facts["capabilities"] == ["text", "code", "vision"]
    assert facts["tool_calling"] is True and facts["context_window"] == 131072
