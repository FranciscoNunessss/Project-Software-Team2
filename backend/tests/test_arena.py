"""Levels from the public LMArena leaderboards (ADR-014 A10, layer 1)."""

import json
import sys
from pathlib import Path

import pytest
from app import arena
from app.catalogue import CAPABILITIES, CATALOGUE_DIR, active_catalogue
from app.evaluations import Ratings, router_snapshot_facts
from app.recommendation import Option

ROOT = Path(__file__).resolve().parents[2]

RULES = {"default": {"min_votes": 300, "max_interval": 60}, "agent": {"min_votes": 100}}
LIMITS = {"level_2_from": 1300.0, "level_3_from": 1400.0}
CATEGORIES = ["overall", "math", "hard_prompts", "expert", "longer_query", "instruction_following"]


def entry(rating, votes=1000, width=20):
    return {
        "rating": rating,
        "lower": rating - width / 2,
        "upper": rating + width / 2,
        "votes": votes,
    }


def fixture(monkeypatch, models: dict, aliases: dict | None = None, factuality=None, agent=None):
    snapshot = {
        "subsets": {
            arena.TEXT: models,
            "text_factuality": factuality or {},
            "agent": agent or {},
        }
    }
    slots = [f"{arena.TEXT}/{c}" for c in CATEGORIES] + ["text_factuality/overall"]
    mapping = {
        "version": "arena-mapping-test",
        "observed_on": "2026-11-06",
        "rules": RULES,
        "thresholds": {slot: LIMITS for slot in slots}
        | {"agent/overall": {"level_2_from": 0.0, "level_3_from": 0.1}},
    }
    merged = arena.merge_variants(snapshot, RULES)
    monkeypatch.setattr(
        arena, "reference", lambda: (mapping, merged, aliases or {"confirmed": [], "blocked": []})
    )


def flat(rating):
    return {category: entry(rating) for category in CATEGORIES}


@pytest.mark.parametrize(
    ("arena_name", "provider_id"),
    [
        ("Claude Haiku 4.5 (20251001)", "anthropic/claude-haiku-4.5"),
        ("Gemma 4 31B", "google/gemma-4-31b-it:free"),
        ("gpt-oss-20b", "openai/gpt-oss-20b"),
        ("Step 5 Preview", "stepfun/step-5-preview"),
        ("DeepSeek-V4.1-Flash-20260910 (Max)", "deepseek/deepseek-v4.1-flash"),
        ("Claude Sonnet 5.5 (xHigh)", "claude-sonnet-5-5"),
        ("Kimi K3 (Max)", "moonshotai/kimi-k3:batch"),
    ],
)
def test_names_of_the_same_model_normalise_to_the_same_key(arena_name, provider_id):
    assert arena.normalise(arena_name) == arena.normalise(provider_id)


@pytest.mark.parametrize(
    ("one", "other"),
    [
        ("DeepSeek-V4.1-Flash-20260910 (Max)", "deepseek/deepseek-v4.1-flash-1017"),
        ("DeepSeek-V3.2", "deepseek/deepseek-v3.2-exp"),
        ("GPT-5.2", "openai/gpt-5.2-chat"),
        ("GPT-6 Luna (Max)", "openai/gpt-6-luna-pro"),
    ],
)
def test_different_models_never_share_a_key(one, other):
    assert arena.normalise(one) != arena.normalise(other)


def test_variants_count_as_one_model_with_the_lowest_rating(monkeypatch):
    fixture(monkeypatch, {"Model X (High)": flat(1450), "Model X (Low)": flat(1350)})
    levels = arena.ratings("openrouter", "vendor/model-x")
    assert {name: item["level"] for name, item in levels.items()} == {
        "reasoning": 2,
        "context": 2,
        "domain": 2,
        "reliability": 2,
        "tools": 2,
    }
    assert "Model X (Low)" in levels["reasoning"]["source"]


def test_an_uncertain_category_falls_to_the_next_one(monkeypatch):
    model = flat(1450) | {"expert": entry(1100, votes=50), "math": entry(1100, width=90)}
    fixture(monkeypatch, {"Model Y": model})
    levels = arena.ratings("openrouter", "vendor/model-y")
    # math too wide: reasoning from hard prompts alone; expert too few votes: hard prompts.
    assert levels["reasoning"]["level"] == 3 and "math" not in levels["reasoning"]["source"]
    assert levels["domain"]["level"] == 3 and "hard prompts" in levels["domain"]["source"]


def test_reasoning_takes_the_lower_of_math_and_hard_prompts(monkeypatch):
    fixture(monkeypatch, {"Model Z": flat(1450) | {"math": entry(1250)}})
    assert arena.ratings("openrouter", "vendor/model-z")["reasoning"]["level"] == 1


def test_tools_are_capped_at_2_without_agent_data_and_use_it_when_present(monkeypatch):
    fixture(
        monkeypatch,
        {"Model T": flat(1450), "Model A": flat(1450)},
        agent={"Model A": {"overall": entry(0.2, votes=500, width=0.02)}},
    )
    capped = arena.ratings("openrouter", "vendor/model-t")["tools"]
    assert capped["level"] == 2 and "capped at 2" in capped["source"]
    assert arena.ratings("openrouter", "vendor/model-a")["tools"]["level"] == 3


def test_factuality_decides_reliability_when_present(monkeypatch):
    fixture(monkeypatch, {"Model F": flat(1450)}, factuality={"Model F": {"overall": entry(1200)}})
    reliability = arena.ratings("openrouter", "vendor/model-f")["reliability"]
    assert reliability["level"] == 1 and "factuality" in reliability["source"]


def test_confirmed_links_are_used_and_blocked_ids_never_link(monkeypatch):
    aliases = {
        "confirmed": [{"provider": "openrouter", "model": "meta/odd-name", "arena": "Model Q 70B"}],
        "blocked": [{"provider": "openrouter", "model": "vendor/model-q-70b"}],
    }
    fixture(monkeypatch, {"Model Q 70B": flat(1450)}, aliases)
    assert arena.ratings("openrouter", "meta/odd-name") is not None
    assert arena.ratings("openrouter", "vendor/model-q-70b") is None


def test_the_source_names_lmarena_the_date_and_the_licence(monkeypatch):
    fixture(monkeypatch, {"Model S": flat(1450)})
    rating = arena.ratings("openrouter", "vendor/model-s")["reasoning"]
    assert rating["status"] == "provisional" and rating["observed_on"] == "2026-11-06"
    assert rating["source"].startswith("LMArena 2026-11-06") and "CC BY 4.0" in rating["source"]


def test_thresholds_come_from_the_frozen_mapping(monkeypatch):
    fixture(monkeypatch, {"Model R": flat(1350)})
    assert arena.ratings("openrouter", "vendor/model-r")["context"]["level"] == 2
    mapping, merged, aliases = arena.reference()
    mapping["thresholds"][f"{arena.TEXT}/longer_query"] = {
        "level_2_from": 1360,
        "level_3_from": 1500,
    }
    assert arena.ratings("openrouter", "vendor/model-r")["context"]["level"] == 1


def test_measured_levels_beat_lmarena_and_lmarena_beats_artificial_analysis():
    ratings = Ratings(None, active_catalogue())
    # In LMArena and in the Artificial Analysis links: LMArena wins (per category).
    assert ratings.source("openrouter", "anthropic/claude-sonnet-5.5")[0] == "arena"
    # Only in Artificial Analysis.
    assert ratings.source("openrouter", "deepseek/deepseek-v4.1-flash-1017")[0] == "benchmark"
    ratings.measured[("openrouter", "anthropic/claude-sonnet-5.5")] = {
        "levels_json": json.dumps(
            {c: {"level": 1, "pass_rates": {"2": 0.0}} for c in CAPABILITIES}
        ),
        "finished_at": "2026-11-08",
    }
    assert ratings.source("openrouter", "anthropic/claude-sonnet-5.5")[0] == "measured"


def test_a_model_rated_only_by_lmarena_gets_a_card_with_openrouter_facts():
    card = Ratings(None, active_catalogue()).card(
        Option("openrouter", "openai/gpt-6-luna", None, "x")
    )
    assert card is not None and card.facts.price_in_per_mtok is not None
    assert card.facts.source.startswith("https://openrouter.ai/openai/gpt-6-luna")
    assert router_snapshot_facts("vendor/none") is None


def test_most_used_models_have_levels():
    """The models most used in the world are always rated (ADR-014 A10)."""
    data = json.loads((CATALOGUE_DIR / "most-used.json").read_text(encoding="utf-8"))
    ratings = Ratings(None, active_catalogue())
    missing = [
        f"{item['provider']} {item['model']}"
        for item in data["models"]
        if ratings.source(item["provider"], item["model"]) is None
    ]
    assert not missing, f"Without levels: {missing}. Add a link or measure them."
    for item in data["no_public_source"]:
        assert item["why"]


def test_the_committed_mapping_reads_a_committed_snapshot():
    mapping = json.loads((CATALOGUE_DIR / "arena-mapping-1.json").read_text(encoding="utf-8"))
    snapshot = json.loads((CATALOGUE_DIR / mapping["snapshot"]).read_text(encoding="utf-8"))
    assert snapshot["licence"] == "CC BY 4.0" and snapshot["observed_on"] == mapping["observed_on"]
    assert set(mapping["thresholds"]) >= {f"{arena.TEXT}/overall", "text_factuality/overall"}
    for limits in mapping["thresholds"].values():
        assert limits["level_2_from"] <= limits["level_3_from"]


def test_a_model_that_left_the_leaderboard_keeps_its_last_entries(tmp_path, monkeypatch):
    sys.path.insert(0, str(ROOT / "scripts"))
    import snapshot_lmarena

    old = {
        "publish_dates": {arena.TEXT: "2026-10-01"},
        "subsets": {arena.TEXT: {"Gone": {"overall": entry(1400)}, "Stays": {"overall": entry(1)}}},
    }
    (tmp_path / "lmarena-2026-10-01.json").write_text(json.dumps(old))
    (tmp_path / "lmarena-2026-01-01.json").write_text(json.dumps(old))
    monkeypatch.setattr(snapshot_lmarena, "OUT_DIR", tmp_path)
    new = {"observed_on": "2026-11-06", "subsets": {arena.TEXT: {"Stays": {"overall": entry(2)}}}}
    snapshot_lmarena.carry_over(new)
    assert new["subsets"][arena.TEXT]["Stays"]["overall"]["rating"] == 2
    assert new["subsets"][arena.TEXT]["Gone"]["overall"]["seen_on"] == "2026-10-01"
    later = {"observed_on": "2027-06-01", "subsets": {arena.TEXT: {}}}
    snapshot_lmarena.carry_over(later)
    assert later["subsets"][arena.TEXT] == {}
