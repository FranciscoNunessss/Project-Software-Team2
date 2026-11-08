"""Choices and feedback per task (ADR-014). Core: the Educator and My progress read them.

A task starts with an analysed message. The user says once, at the end, whether the model
they used solved it: resolved, resolved_with_refinement, not_resolved (with an optional
reason) or skipped. Never per answer, never twice for the same task.

Privacy (Product Specification section 8): only choices, counts, levels and identifiers are
stored, never text. Rows go with the analysis, the history or the account (cascade).
"""

import json
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.accounts import AuthenticatedUser
from app.catalogue import CAPABILITIES, active_catalogue
from app.recommendation import Option, candidate_gap
from app.storage import Storage

Outcome = Literal["resolved", "resolved_with_refinement", "not_resolved", "skipped"]
Reason = Literal["quality", "instructions", "description", "other"]
MODEL_ID = r"^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$"


class OutcomeInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    outcome: Outcome
    reason: Reason | None = None
    # The model the answers came from, when known (the chat knows it).
    provider: str | None = Field(default=None, max_length=32, pattern=r"^[a-z]+$")
    model: str | None = Field(default=None, max_length=200, pattern=MODEL_ID)
    turns: int | None = Field(default=None, ge=0, le=1000)
    switched_model: bool | None = None
    retries: int | None = Field(default=None, ge=0, le=1000)
    stops: int | None = Field(default=None, ge=0, le=1000)

    @model_validator(mode="after")
    def reason_only_when_not_resolved(self):
        if self.reason is not None and self.outcome != "not_resolved":
            raise ValueError("a reason is only given for not_resolved")
        return self


def owned_analysis(db, user_id: str, analysis_id: str) -> dict:
    row = db.execute(
        "SELECT a.id,a.session_id,a.result_json FROM analyses a "
        "JOIN sessions s ON s.id=a.session_id WHERE a.id=%s AND s.user_id=%s",
        (analysis_id, user_id),
    ).fetchone()
    if not row:
        raise HTTPException(404, "analysis_not_found")
    return dict(row)


def record_decision(db, user_id: str, analysis_id: str, candidate_id: str) -> dict:
    """Record the model chosen for an analysis, once (the same choice again is accepted)."""
    result = json.loads(owned_analysis(db, user_id, analysis_id)["result_json"])
    eligible = [result["recommendation"], *result["alternatives"]]
    if candidate_id not in [item["id"] for item in eligible]:
        raise HTTPException(422, "candidate_not_eligible")
    previous = db.execute(
        "SELECT candidate_id FROM decisions WHERE analysis_id=%s", (analysis_id,)
    ).fetchone()
    if previous and previous["candidate_id"] != candidate_id:
        raise HTTPException(409, "decision_already_recorded")
    db.execute(
        "INSERT INTO decisions(analysis_id,candidate_id) VALUES (%s,%s) "
        "ON CONFLICT(analysis_id) DO NOTHING",
        (analysis_id, candidate_id),
    )
    saved_memory = db.execute(
        "SELECT m.metadata_json FROM memory_entries m "
        "JOIN user_context c ON c.user_id=m.user_id "
        "WHERE m.analysis_id=%s AND m.user_id=%s AND c.save_enabled=1",
        (analysis_id, user_id),
    ).fetchone()
    if saved_memory:
        metadata = json.loads(saved_memory[0])
        if "recommended_capacity" in metadata and "recommended_model" not in metadata:
            metadata["chosen_capacity"] = next(
                item.get("capacity") for item in eligible if item["id"] == candidate_id
            )
        else:
            metadata["chosen_model"] = candidate_id
            metadata["chosen_gap"] = candidate_gap(result, candidate_id)
        db.execute(
            "UPDATE memory_entries SET metadata_json=%s WHERE analysis_id=%s",
            (json.dumps(metadata), analysis_id),
        )
    return result


def card_used(result: dict, provider: str | None, model: str | None, chosen: str | None):
    """The catalogue card of the model used: from provider and model, else the choice."""
    catalogue = active_catalogue()
    if provider and model:
        # The model actually used decides; without a card it has no levels.
        card = catalogue.card_for(provider, model)
        if card is None:
            return None, None
        return card.id, {name: card.level(name) for name in CAPABILITIES}
    card = None
    if chosen:
        card = catalogue.card(chosen)
        if card is None:
            # A card of an older catalogue version: keep its id, levels from the analysis.
            for item in [result["recommendation"], *result["alternatives"]]:
                if item["id"] == chosen:
                    return chosen, {
                        entry["need"]: entry["capability"] for entry in item.get("coverage", [])
                    }
            return chosen, None
    if card is None:
        return None, None
    return card.id, {name: card.level(name) for name in CAPABILITIES}


def model_used(result: dict, provider: str | None, model: str | None, chosen: str | None):
    """(provider, model) of the answers, else of the choice recorded for the analysis."""
    if provider and model:
        return provider, model
    for item in [result["recommendation"], *result["alternatives"]]:
        if item["id"] == chosen and item.get("provider") and item.get("model"):
            return item["provider"], item["model"]
    return None, None


def followed(result: dict, used: tuple, card_id: str | None, chosen: str | None) -> bool | None:
    """Whether the task was done with the recommended model.

    None only when it could not be followed (an illustrative recommendation, no real model)
    or when nothing is known about the model used.
    """
    recommendation = result["recommendation"]
    if recommendation.get("illustrative") or recommendation.get("capacity") is not None:
        return None
    target = (recommendation.get("provider"), recommendation.get("model"))
    if used != (None, None):
        return used == target or (card_id is not None and card_id == recommendation["id"])
    if chosen:
        return chosen == recommendation["id"]
    return None


def public_outcome(row) -> dict:
    keys = (
        "analysis_id",
        "outcome",
        "reason",
        "model_card_id",
        "used_provider",
        "used_model",
        "levels_source",
        "recommended_card_id",
        "completeness",
        "turns",
        "retries",
        "stops",
        "created_at",
    )
    data = {key: row[key] for key in keys}
    data["followed_recommendation"] = (
        None if row["followed_recommendation"] is None else bool(row["followed_recommendation"])
    )
    data["switched_model"] = None if row["switched_model"] is None else bool(row["switched_model"])
    return data


def outcome_summary(store: Storage, user_id: str) -> dict:
    """Totals for My progress and the Educator: no text, only counts."""
    with store.connect() as db:
        rows = db.execute(
            "SELECT outcome,reason,model_card_id,used_provider,used_model,"
            "followed_recommendation,turns,completeness "
            "FROM task_outcomes WHERE user_id=%s",
            (user_id,),
        ).fetchall()
    answered = [row for row in rows if row["outcome"] != "skipped"]
    solved = {"resolved", "resolved_with_refinement"}

    def rate(items):
        return (
            round(100 * sum(row["outcome"] in solved for row in items) / len(items))
            if items
            else None
        )

    followed = [row for row in answered if row["followed_recommendation"] == 1]
    other = [row for row in answered if row["followed_recommendation"] == 0]
    turns = [row["turns"] for row in answered if row["turns"] is not None]
    by_model: dict[str, dict] = {}
    for row in answered:
        # Per model actually used: its card when it has one, else provider and model id.
        name = row["model_card_id"] or (
            f"{row['used_provider']} · {row['used_model']}" if row["used_model"] else None
        )
        entry = by_model.setdefault(name or "unknown", {"model": name, "tasks": 0, "solved": 0})
        entry["tasks"] += 1
        entry["solved"] += row["outcome"] in solved
    return {
        "tasks": len(answered),
        "skipped": len(rows) - len(answered),
        "resolved": sum(row["outcome"] == "resolved" for row in answered),
        "resolved_with_refinement": sum(
            row["outcome"] == "resolved_with_refinement" for row in answered
        ),
        "not_resolved": sum(row["outcome"] == "not_resolved" for row in answered),
        "described_poorly": sum(row["reason"] == "description" for row in answered),
        "solved_rate_following": rate(followed),
        "solved_rate_not_following": rate(other),
        "followed": len(followed),
        "mean_turns": round(sum(turns) / len(turns), 1) if turns else None,
        "by_model": sorted(by_model.values(), key=lambda item: -item["tasks"]),
    }


def install_outcomes(app: FastAPI, store: Storage, on_change=None, ratings_for=None) -> None:
    """ratings_for(user_id) -> app.evaluations.Ratings: levels of models without a catalogue
    card (measured, LMArena, Artificial Analysis...), so their outcomes feed calibration."""

    @app.put("/api/analyses/{analysis_id}/outcome")
    def put_outcome(analysis_id: str, body: OutcomeInput, user: AuthenticatedUser):
        with store.connect() as db:
            store.lock_user(db, user["id"])
            analysis = owned_analysis(db, user["id"], analysis_id)
            if db.execute(
                "SELECT 1 FROM task_outcomes WHERE analysis_id=%s", (analysis_id,)
            ).fetchone():
                raise HTTPException(409, "outcome_already_recorded")
            result = json.loads(analysis["result_json"])
            decision = db.execute(
                "SELECT candidate_id FROM decisions WHERE analysis_id=%s", (analysis_id,)
            ).fetchone()
            chosen = decision["candidate_id"] if decision else None
            card_id, levels = card_used(result, body.provider, body.model, chosen)
            used = model_used(result, body.provider, body.model, chosen)
            source = None
            if ratings_for is not None and used[0] and used[1]:
                ratings = ratings_for(user["id"])
                found = ratings.source(used[0], used[1])
                source = found[0] if found else None
                if card_id is None and found:
                    card = ratings.card(Option(used[0], used[1], None, used[1]))
                    if card is not None:
                        card_id = card.id
                        levels = {name: card.level(name) for name in CAPABILITIES}
            recommended = result["recommendation"]["id"]
            follows = followed(result, used, card_id, chosen)
            db.execute(
                """INSERT INTO task_outcomes(analysis_id,user_id,outcome,reason,model_card_id,
                   catalogue_version,recommended_card_id,followed_recommendation,needs_json,
                   capabilities_json,completeness,turns,switched_model,retries,stops,
                   used_provider,used_model,levels_source)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (
                    analysis_id,
                    user["id"],
                    body.outcome,
                    body.reason,
                    card_id,
                    result.get("catalogue_version"),
                    recommended,
                    None if follows is None else int(follows),
                    json.dumps(result.get("needs")) if result.get("needs") else None,
                    json.dumps(levels) if levels else None,
                    result.get("completeness"),
                    body.turns,
                    None if body.switched_model is None else int(body.switched_model),
                    body.retries,
                    body.stops,
                    used[0],
                    used[1],
                    source,
                ),
            )
            row = db.execute(
                "SELECT * FROM task_outcomes WHERE analysis_id=%s", (analysis_id,)
            ).fetchone()
        if on_change:
            on_change(user["id"])
        return public_outcome(row)

    @app.get("/api/analyses/{analysis_id}/outcome")
    def get_outcome(analysis_id: str, user: AuthenticatedUser):
        with store.connect() as db:
            owned_analysis(db, user["id"], analysis_id)
            row = db.execute(
                "SELECT * FROM task_outcomes WHERE analysis_id=%s", (analysis_id,)
            ).fetchone()
        if not row:
            raise HTTPException(404, "outcome_not_found")
        return public_outcome(row)

    @app.get("/api/progress/outcomes")
    def outcomes(user: AuthenticatedUser):
        return outcome_summary(store, user["id"])
