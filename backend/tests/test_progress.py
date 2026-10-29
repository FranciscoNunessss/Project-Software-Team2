import json

import pytest
from app.coaching import (
    SIZE_METRICS_SENTENCE,
    TREND_SENTENCE,
    CoachingReport,
    GroqCoach,
    register_snapshot_extension,
    snapshot,
    unregister_snapshot_extension,
)
from app.main import create_app
from app.providers import ProviderFailure, Settings
from fastapi.testclient import TestClient

REPORT = {
    "schema_version": 3,
    "summary": "Your confirmed choices can help review capacity needs.",
    "patterns": {
        "over_provisioning": {
            "explanation": "Compare confirmed capacities with the prototype recommendation.",
            "action": "Review the task requirements before choosing extra capacity.",
        },
        "under_provisioning": {
            "explanation": "A lower chosen capacity is not proof of a poor decision.",
            "action": "Check unresolved task requirements before confirming a smaller tier.",
        },
        "prompting": {
            "status": "not_assessed",
            "explanation": "No task text is available to assess prompt inflation.",
            "action": "As an exercise, state the intended outcome before adding constraints.",
        },
    },
    "suggestions": [
        {
            "title": "Review capacity",
            "explanation": "Compare your choices with the recorded profile.",
            "action": "Confirm a pending choice before reviewing agreement.",
        }
    ],
}


def account(app, email="alice@example.com"):
    client = TestClient(app)
    assert (
        client.post(
            "/api/auth/register", json={"email": email, "password": "test-password-123"}
        ).status_code
        == 201
    )
    return client


def analyze(client):
    response = client.post("/api/analyze", json={"task": "PRIVATE_TASK_SENTINEL"})
    assert response.status_code == 200
    return response.json()


def test_automatic_coaching_opt_in_updates_on_analysis_and_choice(monkeypatch):
    calls = []

    class Coach:
        def __init__(self, settings):
            pass

        async def generate(self, metadata):
            calls.append(metadata)
            return CoachingReport.model_validate(REPORT)

    monkeypatch.setattr("app.coaching.GroqCoach", Coach)
    app = create_app(Settings(_env_file=None, groq_api_key="synthetic-key"))
    alice, bob = account(app), account(app, "bob@example.com")
    result = analyze(alice)
    assert not calls
    assert alice.get("/api/context").json()["coaching_auto_enabled"] is False
    enabled = alice.put("/api/context", json={"coaching_auto_enabled": True})
    assert enabled.json()["coaching_auto_enabled"] is True
    assert len(calls) == 1  # Existing history is processed when opting in.
    assert alice.get("/api/progress/coaching").json()["saved"]["stale"] is False
    alice.get("/api/progress/coaching")
    assert len(calls) == 1  # Refreshing reuses the report.
    choice = {"analysis_id": result["id"], "candidate_id": result["recommendation"]["id"]}
    assert alice.post("/api/decisions", json=choice).status_code == 200
    assert len(calls) == 2 and calls[-1]["assessments"][0]["chosen_capacity"] == 2
    alice.post("/api/decisions", json=choice)
    assert len(calls) == 2  # Idempotent confirmations cause no extra model call.
    analyze(alice)
    assert len(calls) == 3 and calls[-1]["sample_size"] == 2
    assert bob.get("/api/context").json()["coaching_auto_enabled"] is False
    analyze(bob)
    assert len(calls) == 3
    alice.put("/api/context", json={"coaching_auto_enabled": False})
    analyze(alice)
    assert alice.get("/api/progress/coaching").json()["saved"]["stale"] is True
    assert len(calls) == 3


def test_automatic_coaching_failure_does_not_block_or_repeat_on_poll(monkeypatch):
    calls = []

    class Broken:
        def __init__(self, settings):
            pass

        async def generate(self, metadata):
            calls.append(metadata)
            raise ProviderFailure("provider_rate_limit")

    monkeypatch.setattr("app.coaching.GroqCoach", Broken)
    app = create_app(Settings(_env_file=None, groq_api_key="synthetic-key"))
    client = account(app)
    client.put("/api/context", json={"coaching_auto_enabled": True})
    analyze(client)  # The analysis still succeeds when coaching fails.
    state = client.get("/api/progress/coaching").json()
    assert state["error"] == "provider_rate_limit" and not state["generating"]
    client.get("/api/progress/coaching")
    assert len(calls) == 1
    analyze(client)
    assert len(calls) == 2  # A new history revision can make a fresh attempt.


def test_disabling_automatic_coaching_during_call_does_not_save_report(monkeypatch):
    app = create_app(Settings(_env_file=None, groq_api_key="synthetic-key"))
    client = account(app)
    result = analyze(client)
    with app.state.storage.connect() as db:
        owner = db.execute(
            "SELECT user_id FROM sessions WHERE id=?", (result["session_id"],)
        ).fetchone()[0]

    class Coach:
        def __init__(self, settings):
            pass

        async def generate(self, metadata):
            with app.state.storage.connect() as db:
                db.execute(
                    "UPDATE user_context SET coaching_auto_enabled=0 WHERE user_id=?", (owner,)
                )
            return CoachingReport.model_validate(REPORT)

    monkeypatch.setattr("app.coaching.GroqCoach", Coach)
    client.put("/api/context", json={"coaching_auto_enabled": True})
    assert client.get("/api/progress/coaching").json()["saved"] is None


def test_v5_migration_preserves_history_and_defaults_automatic_coaching_off():
    from app.storage import Storage

    settings = Settings(_env_file=None)
    app = create_app(settings)
    client = account(app)
    analyze(client)
    client.put("/api/context", json={"content": "Portuguese", "save_enabled": True})
    with app.state.storage.connect() as db:
        db.execute("ALTER TABLE user_context DROP COLUMN coaching_auto_enabled")
        db.execute("ALTER TABLE user_context DROP COLUMN conversation_memory_enabled")
        db.execute("ALTER TABLE coaching_reports DROP COLUMN source_json")
        db.execute("DROP TABLE conversation_content")
        db.execute("PRAGMA user_version=5")
    migrated = Storage(settings.database_path)
    with migrated.connect() as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 7
        assert db.execute("SELECT count(*) FROM analyses").fetchone()[0] == 1
        row = db.execute("SELECT * FROM user_context").fetchone()
        assert row["content"] == "Portuguese" and row["save_enabled"] == 1
        assert row["coaching_auto_enabled"] == 0


def test_pending_confirmation_updates_activity_match_and_isolation():
    app = create_app(Settings(_env_file=None))
    alice, bob = account(app), account(app, "bob@example.com")
    first, second = analyze(alice), analyze(alice)
    assert alice.get("/api/progress").json()["choices"] == 0
    pending = alice.get("/api/progress/pending?limit=1").json()
    assert len(pending) == 1 and pending[0]["candidate_id"] is None
    assert "PRIVATE_TASK_SENTINEL" not in str(pending)
    assert len(alice.get("/api/progress/pending?limit=1&offset=1").json()) == 1
    assert bob.get("/api/progress/pending").json() == []
    assert bob.get("/api/progress/activity").json() == []
    assert sum(item["analyses"] for item in alice.get("/api/progress/activity").json()) == 2
    assert (
        alice.post(
            "/api/decisions",
            json={"analysis_id": first["id"], "candidate_id": first["recommendation"]["id"]},
        ).status_code
        == 200
    )
    assert alice.get("/api/progress").json()["matches"] == 1
    assert len(alice.get("/api/progress/pending").json()) == 1
    assert alice.get("/api/progress/pending").json()[0]["result"]["id"] == second["id"]
    assert sum(item["choices"] for item in alice.get("/api/progress/activity").json()) == 1
    assert alice.get("/api/progress/dashboard").json()["series"][0]["rate"] == 100
    assert alice.delete("/api/sessions/" + first["session_id"]).status_code == 200
    assert alice.get("/api/progress").json()["matches"] == 0


def test_coaching_is_explicit_cached_stale_and_private(monkeypatch):
    calls = []

    class Coach:
        def __init__(self, settings):
            pass

        async def generate(self, metadata):
            calls.append(metadata)
            return CoachingReport.model_validate(REPORT)

    monkeypatch.setattr("app.coaching.GroqCoach", Coach)
    settings = Settings(_env_file=None, groq_api_key="synthetic-coaching-key")
    app = create_app(settings)
    alice, bob = account(app), account(app, "bob@example.com")
    assert alice.get("/api/progress/coaching").json()["saved"] is None
    analyze(alice)
    assert calls == []
    body = {"allow_external": True, "expected_model": settings.groq_model}
    assert (
        alice.post("/api/progress/coaching", json={**body, "allow_external": False}).status_code
        == 403
    )
    assert (
        alice.post("/api/progress/coaching", json={**body, "expected_model": "changed"}).status_code
        == 409
    )
    response = alice.post("/api/progress/coaching", json=body)
    assert response.status_code == 200 and response.json()["report"] == REPORT
    assert response.headers["cache-control"] == "no-store"
    assert "PRIVATE_TASK_SENTINEL" not in json.dumps(calls)
    assert "synthetic-coaching-key" not in json.dumps(calls)
    assert "evidence" not in json.dumps(calls)
    assert alice.post("/api/progress/coaching", json=body).status_code == 200
    assert len(calls) == 1
    assert bob.get("/api/progress/coaching").json()["saved"] is None
    analyze(alice)
    assert alice.get("/api/progress/coaching").json()["saved"]["stale"] is True
    assert alice.post("/api/progress/coaching", json=body).json()["stale"] is False
    assert len(calls) == 2


def test_coaching_rejects_empty_history_and_sanitizes_failures(monkeypatch):
    app = create_app(Settings(_env_file=None, groq_api_key="synthetic-coaching-key"))
    client = account(app)
    body = {"allow_external": True, "expected_model": "openai/gpt-oss-20b"}
    assert client.post("/api/progress/coaching", json=body).status_code == 409
    analyze(client)

    class Broken:
        def __init__(self, settings):
            pass

        async def generate(self, metadata):
            raise ProviderFailure("provider_timeout")

    monkeypatch.setattr("app.coaching.GroqCoach", Broken)
    assert client.post("/api/progress/coaching", json=body).json() == {"detail": "provider_timeout"}
    assert client.get("/api/progress/coaching").json()["saved"] is None


def test_history_deleted_during_coaching_is_not_recreated(monkeypatch):
    app = create_app(Settings(_env_file=None, groq_api_key="synthetic-coaching-key"))
    client = account(app)
    result = analyze(client)

    class Coach:
        def __init__(self, settings):
            pass

        async def generate(self, metadata):
            client.delete("/api/sessions/" + result["session_id"])
            return CoachingReport.model_validate(REPORT)

    monkeypatch.setattr("app.coaching.GroqCoach", Coach)
    response = client.post(
        "/api/progress/coaching",
        json={"allow_external": True, "expected_model": "openai/gpt-oss-20b"},
    )
    assert response.status_code == 409
    assert client.get("/api/progress/coaching").json()["saved"] is None


def test_clear_usage_history_preserves_account_preferences_and_other_users():
    app = create_app(Settings(_env_file=None))
    alice, bob = account(app), account(app, "bob@example.com")
    alice.put("/api/context", json={"content": "Portuguese", "save_enabled": True})
    analyze(alice)
    analyze(bob)
    alice.post("/api/llm-configs", json={"provider": "ollama", "label": "Local", "model": "local"})
    assert alice.get("/api/context").json()["memory"]
    assert alice.delete("/api/progress/history").status_code == 200
    assert alice.get("/api/context").json()["memory"] == []
    assert alice.get("/api/context").json()["content"] == "Portuguese"
    assert alice.get("/api/progress").json() == {
        "sessions": 0,
        "analyses": 0,
        "choices": 0,
        "matches": 0,
    }
    assert alice.get("/api/auth/me").status_code == 200
    assert len(alice.get("/api/llm-configs").json()) == 1
    assert bob.get("/api/progress").json()["analyses"] == 1


async def test_groq_coach_structured_contract_and_invalid_output(monkeypatch):
    captured = []
    parsed = REPORT

    class Model:
        def __init__(self, **options):
            assert options["base_url"] == "https://api.groq.com/openai/v1"
            assert options["max_retries"] == 0
            assert "temperature" not in options
            assert options["max_tokens"] == 4096

        def with_structured_output(self, schema, **options):
            assert schema is CoachingReport and options["strict"] is True
            return self

        async def ainvoke(self, messages):
            captured.append(messages)
            return {"parsed": parsed, "parsing_error": None}

    monkeypatch.setattr("langchain_openai.ChatOpenAI", Model)
    coach = GroqCoach(Settings(_env_file=None))
    report = await coach.generate({"sample_size": 1, "sample_limit": 50, "assessments": []})
    assert report.model_dump() == REPORT
    assert len(captured) == 1
    assert "NOT user ability" in captured[0][0][1]
    parsed = {"summary": "", "suggestions": []}
    with pytest.raises(ProviderFailure, match="invalid_provider_output"):
        await coach.generate({})


def test_snapshot_changes_on_confirm_and_does_not_contain_raw_content():
    app = create_app(Settings(_env_file=None))
    client = account(app)
    result = analyze(client)
    user_id = client.get("/api/auth/me").json()["id"]
    before, metadata = snapshot(app.state.storage, user_id)
    assert "PRIVATE_TASK_SENTINEL" not in json.dumps(metadata)
    client.post(
        "/api/decisions",
        json={"analysis_id": result["id"], "candidate_id": result["recommendation"]["id"]},
    )
    after, _ = snapshot(app.state.storage, user_id)
    assert before != after


def test_snapshot_metrics_are_computed_from_confirmed_choices_only():
    app = create_app(Settings(_env_file=None))
    client = account(app)
    first, second, third = [analyze(client) for _ in range(3)]
    for result, chosen in [(first, "demo-advanced"), (second, "demo-small")]:
        client.post("/api/decisions", json={"analysis_id": result["id"], "candidate_id": chosen})
    owner = client.get("/api/auth/me").json()["id"]
    _, metadata = snapshot(app.state.storage, owner)
    assert metadata["metrics"] == {
        "analyses": 3,
        "confirmed_choices": 2,
        "pending_choices": 1,
        "larger_than_recommended": 1,
        "smaller_than_recommended": 1,
        "matches": 0,
    }
    assert third["id"] not in json.dumps(metadata)


def test_old_coaching_cache_is_stale_and_replaced_without_altering_history(monkeypatch):
    settings = Settings(_env_file=None, groq_api_key="synthetic-key")
    app = create_app(settings)
    client = account(app)
    analyze(client)
    owner = client.get("/api/auth/me").json()["id"]
    old = {"summary": "Old summary", "suggestions": REPORT["suggestions"]}
    with app.state.storage.connect() as db:
        db.execute(
            "INSERT INTO coaching_reports(user_id,fingerprint,model,report_json) VALUES (?,?,?,?)",
            (owner, "old-contract-fingerprint", settings.groq_model, json.dumps(old)),
        )
    assert client.get("/api/progress/coaching").json()["saved"]["stale"]
    before = client.get("/api/progress").json()

    class Coach:
        def __init__(self, settings):
            pass

        async def generate(self, metadata):
            return CoachingReport.model_validate(REPORT)

    monkeypatch.setattr("app.coaching.GroqCoach", Coach)
    saved = client.post(
        "/api/progress/coaching",
        json={
            "allow_external": True,
            "expected_model": settings.groq_model,
        },
    ).json()
    assert saved["report"]["patterns"] == REPORT["patterns"]
    assert saved["report"]["schema_version"] == 3 and not saved["stale"]
    assert client.get("/api/progress").json() == before


def test_coaching_contract_rejects_missing_patterns_and_invented_prompt_detection():
    from copy import deepcopy

    from pydantic import ValidationError

    missing = {"summary": "Legacy report", "suggestions": REPORT["suggestions"]}
    with pytest.raises(ValidationError):
        CoachingReport.model_validate(missing)
    incorrect = deepcopy(REPORT)
    incorrect["patterns"]["prompting"]["status"] = "detected"
    with pytest.raises(ValidationError):
        CoachingReport.model_validate(incorrect)


DIMENSIONS = ("reasoning", "context", "ambiguity", "domain", "risk", "tools", "modality")


def user_of(client):
    return client.get("/api/auth/me").json()["id"]


def store_profile(app, analysis_id, determined, *, stored_completeness=None):
    """Rewrite a stored analysis so its first ``determined`` dimensions are known."""
    with app.state.storage.connect() as db:
        result = json.loads(
            db.execute("SELECT result_json FROM analyses WHERE id=?", (analysis_id,)).fetchone()[0]
        )
        for index, name in enumerate(DIMENSIONS):
            known = index < determined
            value = result["profile"][name]
            value["confidence"] = "high" if known else "undetermined"
            if name == "modality":
                value["required"] = ["text"] if known else None
            else:
                value["score"] = 1 if known else None
        result["recommendation_provisional"] = determined < len(DIMENSIONS)
        if stored_completeness is None:
            result.pop("completeness", None)  # As stored before A3.
        else:
            result["completeness"] = stored_completeness
        db.execute(
            "UPDATE analyses SET result_json=? WHERE id=?", (json.dumps(result), analysis_id)
        )


def sessions_with_rising_completeness(app, client, count):
    for determined in range(count):
        first = analyze(client)
        store_profile(app, first["id"], determined + 1, stored_completeness=0)
        # A later analysis in the same session does not enter the series.
        response = client.post(
            "/api/analyze",
            json={"task": "PRIVATE_TASK_SENTINEL", "session_id": first["session_id"]},
        )
        assert response.status_code == 200


def test_completeness_series_follows_sessions_and_prompt_asks_for_trend(monkeypatch):
    prompts = []

    async def fake_call(provider, settings, schema, system, human, role):
        prompts.append((system, human))
        return REPORT, None

    monkeypatch.setattr("app.coaching.structured_call", fake_call)
    app = create_app(Settings(_env_file=None, groq_api_key="synthetic-key"))
    client = account(app)
    sessions_with_rising_completeness(app, client, 6)
    _, metadata = snapshot(app.state.storage, user_of(client))
    series = metadata["completeness_series"]
    assert len(series) == 6 and series == sorted(series) and len(set(series)) == 6
    assert 0 not in series  # Stored values are never trusted.
    assert "insufficient_history" not in metadata and "extensions" not in metadata
    body = {"allow_external": True, "expected_model": app.state.settings.groq_model}
    assert client.post("/api/progress/coaching", json=body).status_code == 200
    system, human = prompts[-1]
    assert TREND_SENTENCE.strip() in system and SIZE_METRICS_SENTENCE.strip() not in system
    assert json.loads(human)["completeness_series"] == series


def test_completeness_series_recomputes_analyses_without_stored_value():
    app = create_app(Settings(_env_file=None))
    client = account(app)
    first = analyze(client)
    store_profile(app, first["id"], 7)
    _, metadata = snapshot(app.state.storage, user_of(client))
    assert metadata["completeness_series"] == [100]
    assert metadata["insufficient_history"] is True


def test_four_sessions_are_insufficient_history():
    app = create_app(Settings(_env_file=None))
    client = account(app)
    sessions_with_rising_completeness(app, client, 4)
    _, metadata = snapshot(app.state.storage, user_of(client))
    assert len(metadata["completeness_series"]) == 4
    assert metadata["insufficient_history"] is True


def test_snapshot_extension_data_prompt_note_and_unregistering(monkeypatch):
    prompts = []

    async def fake_call(provider, settings, schema, system, human, role):
        prompts.append(system)
        return REPORT, None

    monkeypatch.setattr("app.coaching.structured_call", fake_call)
    app = create_app(Settings(_env_file=None, groq_api_key="synthetic-key"))
    client = account(app)
    analyze(client)
    store, user_id = app.state.storage, user_of(client)
    plain_fingerprint, plain = snapshot(store, user_id)
    seen = []

    def data(store_arg, user_arg):
        seen.append(user_arg)
        return {"mean_tokens": 120, "samples": 1}

    register_snapshot_extension("sizes", data, lambda: "Sizes are token-count aggregates.")
    try:
        fingerprint, metadata = snapshot(store, user_id)
        assert metadata["extensions"] == {"sizes": {"mean_tokens": 120, "samples": 1}}
        assert seen[-1] == user_id and fingerprint != plain_fingerprint
        body = {"allow_external": True, "expected_model": app.state.settings.groq_model}
        assert client.post("/api/progress/coaching", json=body).status_code == 200
        assert "Sizes are token-count aggregates." in prompts[-1]
        assert SIZE_METRICS_SENTENCE.strip() not in prompts[-1]
        register_snapshot_extension(
            "sizes", data, lambda: "Sizes are token-count aggregates.", provides_size_metrics=True
        )
        sized_fingerprint, _ = snapshot(store, user_id)
        assert sized_fingerprint != fingerprint  # The prompt change refreshes the cache.
        assert client.get("/api/progress/coaching").json()["saved"]["stale"] is True
        assert client.post("/api/progress/coaching", json=body).status_code == 200
        # ADR-009 S3: size metrics never unlock prompting.status, only excerpts do.
        assert SIZE_METRICS_SENTENCE.strip() in prompts[-1]
        assert "prompting.status MUST be not_assessed" in prompts[-1]
    finally:
        unregister_snapshot_extension("sizes")
    assert snapshot(store, user_id) == (plain_fingerprint, plain)


def test_snapshot_contains_no_task_free_text():
    app = create_app(Settings(_env_file=None))
    client = account(app)
    sessions_with_rising_completeness(app, client, 2)
    _, metadata = snapshot(app.state.storage, user_of(client))
    text = json.dumps(metadata)
    for forbidden in (
        "PRIVATE_TASK_SENTINEL",
        "evidence",
        "explanation",
        "rationale",
        "not retained",
        "Not retained",
    ):
        assert forbidden not in text
    assert all(isinstance(value, int) for value in metadata["completeness_series"])
