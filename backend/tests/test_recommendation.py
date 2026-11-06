"""One test per step of the recommendation (ADR-014, policy needs-capabilities-1)."""

import pytest
from app.catalogue import Catalogue
from app.models import Profile
from app.recommendation import (
    NoEligibleModel,
    Option,
    available_cards,
    coverage,
    extra_rules,
    hard_filter,
    model_status,
    recommend,
    task_needs,
)
from profile_samples import profile_data

TODAY = "2026-11-06"


def rating(level, status="provisional"):
    if level is None:
        return {"level": None, "status": "unrated"}
    return {"level": level, "status": status, "source": "test", "observed_on": TODAY}


def card(identifier, levels, price, *, tools=True, modalities=("text",), window=128000, **extra):
    names = ("reasoning", "context", "domain", "reliability", "tools")
    if isinstance(levels, int):
        levels = dict.fromkeys(names, levels)
    status = extra.pop("status", "provisional")
    return {
        "id": identifier,
        "family": "test",
        "name": identifier.upper(),
        "aliases": [{"provider": "groq", "model": identifier}],
        "facts": {
            "context_window": window,
            "modalities": list(modalities),
            "capabilities": ["text", "code", *(["vision"] if "image" in modalities else [])],
            "tool_calling": tools,
            "structured_output": True,
            "price_in_per_mtok": price,
            "price_out_per_mtok": price,
            "source": "test",
            "observed_on": TODAY,
            **extra,
        },
        "capabilities": {name: rating(levels.get(name), status) for name in names},
    }


def catalogue(*cards):
    demo = card("demo-x", 2, 1)
    demo["illustrative"] = True
    demo["aliases"] = []
    return Catalogue.model_validate(
        {
            "version": "catalogue-9.0",
            "rubric_scale": "rubric-2.0",
            "benchmark_mapping": None,
            "observed_on": TODAY,
            "source": "test",
            "cost_bands": {"currency": "USD", "unit": "test", "low_max": 0.5, "medium_max": 5},
            "cards": [demo, *cards],
        }
    )


def options(*models):
    return [Option("groq", model, f"server:groq:{model}", model) for model in models]


def needs(task_chars=0, capabilities=None, modality=None, **scores):
    data = profile_data(**scores)
    if modality:
        data["modality"]["required"] = modality
    return task_needs(Profile.model_validate(data), task_chars, capabilities)


SMALL, MEDIUM, LARGE = card("small", 1, 0.1), card("medium", 2, 1.0), card("large", 3, 10.0)


def test_task_needs_are_intervals_from_confidence():
    profile = profile_data(reasoning=2, risk=3, tools=None)
    profile["reasoning"]["confidence"] = "low"
    result = task_needs(Profile.model_validate(profile))
    assert (result.needs["reasoning"].estimated, result.needs["reasoning"].top) == (2, 3)
    assert (result.needs["reliability"].estimated, result.needs["reliability"].top) == (3, 3)
    assert (result.needs["tools"].estimated, result.needs["tools"].top) == (2, 3)
    assert result.needs["tools"].determined is False


def test_ambiguity_is_not_a_need_but_marks_the_task_ambiguous():
    result = needs(ambiguity=3)
    assert "ambiguity" not in result.needs
    assert result.ambiguous is True
    assert needs(ambiguity=1).ambiguous is False


def test_available_cards_keeps_rated_cards_the_user_can_use():
    unrated = card("mystery", {"reasoning": 2}, 1.0)
    items, missing = available_cards(
        catalogue(SMALL, MEDIUM, unrated), options("small", "mystery", "unknown")
    )
    assert [item.card.id for item in items] == ["small"]
    assert sorted(option.model for option in missing) == ["mystery", "unknown"]


def test_hard_filter_modality_window_and_tools():
    vision = card("vision", 3, 5, modalities=("text", "image"))
    image_task = needs(modality=["text", "image"])
    assert hard_filter(image_task, catalogue(LARGE).card("large")) == "no image input"
    assert hard_filter(image_task, catalogue(vision).card("vision")) is None
    short_window = catalogue(card("tiny", 3, 1, window=100)).card("tiny")
    assert "context window" in hard_filter(needs(task_chars=4000), short_window)
    no_tools = catalogue(card("plain", 3, 1, tools=False)).card("plain")
    assert hard_filter(needs(tools=3), no_tools) == "no tool calling"
    assert hard_filter(needs(tools=2), no_tools) is None


def test_coverage_separates_certain_uncertain_and_short():
    profile = profile_data(reasoning=2, context=3)
    profile["reasoning"]["confidence"] = "low"
    task = task_needs(Profile.model_validate(profile))
    items = {
        item["need"]: item["state"] for item in coverage(task, catalogue(MEDIUM).card("medium"))
    }
    assert items["reasoning"] == "covers_as_described"
    assert items["context"] == "short"
    assert items["domain"] == "covers"


def test_model_status_lists_the_shortfalls():
    assert model_status([{"need": "reasoning", "state": "covers"}]) == ("covers", [])
    assert model_status(
        [
            {"need": "reasoning", "state": "covers_as_described"},
            {"need": "tools", "state": "covers"},
        ]
    ) == ("covers_as_described", [])
    assert model_status(
        [{"need": "reasoning", "state": "short"}, {"need": "tools", "state": "short"}]
    ) == ("short", ["reasoning", "tools"])


def test_choose_the_cheapest_model_that_covers_everything():
    result = recommend(
        needs(reasoning=2), options("small", "medium", "large"), catalogue(SMALL, MEDIUM, LARGE)
    )
    ids = [item["id"] for item in result.candidates]
    assert ids[0] == "medium"
    assert result.candidates[0]["status"] == "covers"
    gaps = {item["id"]: item["gap"] for item in result.candidates}
    assert gaps == {"medium": 0, "large": 1, "small": -1}
    assert "SMALL costs less but falls short in reasoning" in result.rationale
    assert "LARGE also covers it but costs more than needed" in result.rationale


def test_ties_prefer_least_excess_then_calibrated_then_id():
    exact = card("exact", 2, 1.0)
    roomy = card("roomy", 3, 1.0)
    calibrated = card("calibrated", 2, 1.0, status="calibrated")
    result = recommend(
        needs(reasoning=2),
        options("exact", "roomy", "calibrated"),
        catalogue(exact, roomy, calibrated),
    )
    assert [item["id"] for item in result.candidates][:3] == ["calibrated", "exact", "roomy"]


def test_fallback_is_provisional_when_only_the_description_is_covered():
    profile = profile_data(reasoning=2)
    profile["reasoning"]["confidence"] = "low"
    task = task_needs(Profile.model_validate(profile))
    result = recommend(task, options("small", "medium"), catalogue(SMALL, MEDIUM))
    assert result.candidates[0]["id"] == "medium"
    assert result.candidates[0]["status"] == "covers_as_described"
    assert result.provisional is True


def test_fallback_when_nothing_covers_names_the_gap():
    result = recommend(needs(reasoning=3), options("small", "medium"), catalogue(SMALL, MEDIUM))
    assert result.candidates[0]["id"] == "medium"
    assert result.candidates[0]["status"] == "short"
    assert result.provisional is True
    assert any("None of your models covers reasoning 3" in note for note in result.notes)


def test_extra_rules_for_risk_and_tools():
    notes = extra_rules(needs(risk=3, tools=3))
    assert any("verify the result with a person" in note for note in notes)
    assert any("does not run tools" in note for note in notes)
    assert extra_rules(needs(risk=2, tools=2)) == []


def test_without_rated_models_the_illustrative_cards_are_used_and_said():
    result = recommend(needs(), options("unknown"), catalogue(SMALL))
    assert result.illustrative is True
    assert result.candidates[0]["id"] == "demo-x"
    assert any("illustrative demo models" in note for note in result.notes)


def test_unrated_models_are_named_but_never_recommended():
    result = recommend(needs(), options("small", "unknown"), catalogue(SMALL))
    assert [item["id"] for item in result.candidates] == ["small"]
    assert any("Not classified yet" in note and "unknown" in note for note in result.notes)


def test_no_eligible_model_raises():
    with pytest.raises(NoEligibleModel):
        recommend(needs(modality=["audio"]), options("small"), catalogue(SMALL))


def test_free_and_local_models_cost_nothing_and_band_low():
    local = card("local", 2, 3.0, local=True)
    result = recommend(needs(reasoning=2), options("medium", "local"), catalogue(MEDIUM, local))
    assert result.candidates[0]["id"] == "local"
    assert result.candidates[0]["blended_price"] == 0
    assert result.candidates[0]["cost_band"] == "low"


def test_candidate_carries_how_to_use_it():
    result = recommend(needs(), options("large"), catalogue(LARGE))
    best = result.candidates[0]
    assert best["configuration_id"] == "server:groq:large"
    assert best["provider"] == "groq" and best["model"] == "large"
    assert {entry["need"] for entry in best["coverage"]} == {
        "reasoning",
        "context",
        "domain",
        "reliability",
        "tools",
    }


def test_a_model_run_locally_costs_nothing_whatever_its_card_price():
    gemma = card("gemma", 2, 0.3)
    gemma["aliases"] = [{"provider": "lmstudio", "model": "gemma-local"}]
    result = recommend(
        needs(reasoning=2),
        [Option("lmstudio", "gemma-local", "personal-1", "LM Studio · gemma")],
        catalogue(gemma),
    )
    assert result.candidates[0]["blended_price"] == 0 and result.candidates[0]["local"] is True
