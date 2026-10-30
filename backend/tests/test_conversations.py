"""Explicit task-text consent, bounded reuse, revocation and owner-only deletion."""

from copy import deepcopy

from app.coaching import CoachingReport, snapshot
from app.main import create_app
from app.providers import DemonstrationProvider, Settings
from test_progress import REPORT, account


def task(client, text="OPTED_IN_TASK", **options):
    response = client.post("/api/analyze", json={"task": text, **options})
    assert response.status_code == 200
    return response.json()


def history(client, result):
    return client.get(f"/api/sessions/{result['session_id']}").json()["analyses"][0]


def test_conversation_storage_is_explicit_and_owner_only():
    app = create_app(Settings(_env_file=None))
    alice, bob = account(app), account(app, "bob@example.com")
    alice.put("/api/context", json={"save_enabled": True, "use_enabled": True})
    original = task(alice, "DO_NOT_STORE_THIS")
    assert history(alice, original)["conversation"] is None
    assert alice.get("/api/context").json()["conversation_memory_enabled"] is False
    alice.put("/api/context", json={"conversation_memory_enabled": True})
    saved = task(alice, task_context="PRIVATE_CONTEXT")
    content = history(alice, saved)["conversation"]
    assert content["task"] == "OPTED_IN_TASK" and content["task_context"] == "PRIVATE_CONTEXT"
    assert content["response"]["id"] == saved["id"]
    assert history(alice, original)["conversation"] is None  # No retroactive text recovery.
    assert "OPTED_IN_TASK" not in str(alice.get("/api/context").json())
    assert alice.get("/api/context").json()["saved_conversations"] == 1
    assert bob.get(f"/api/sessions/{saved['session_id']}").status_code == 404
    owner = alice.get("/api/auth/me").json()["id"]
    other = bob.get("/api/auth/me").json()["id"]
    assert snapshot(app.state.storage, owner)[1]["conversation_excerpts"]
    assert snapshot(app.state.storage, other)[1]["conversation_excerpts"] == []


def test_text_reuse_requires_both_permissions_and_is_bounded():
    app = create_app(Settings(_env_file=None))
    client = account(app)
    client.put("/api/context", json={"conversation_memory_enabled": True})
    owner = client.get("/api/auth/me").json()["id"]
    for index in range(6):
        task(client, f"TEXT_{index}_" + "a" * 7000, task_context="b" * 4000)
    assert snapshot(app.state.storage, owner)[1]["conversation_excerpts"] == []
    client.put("/api/context", json={"use_enabled": True})
    fingerprint, metadata = snapshot(app.state.storage, owner)
    samples = metadata["conversation_excerpts"]
    assert len(samples) == 5 and samples[0]["task"].startswith("TEXT_5_")
    assert all(len(row["task"]) <= 3000 and len(row["task_context"]) <= 500 for row in samples)
    assert "TEXT_0_" not in str(samples)
    client.put("/api/context", json={"conversation_memory_enabled": False})
    after, metadata = snapshot(app.state.storage, owner)
    assert after != fingerprint and metadata["conversation_excerpts"] == []
    task(client, "NO_MORE_SAVING")
    assert client.get("/api/context").json()["saved_conversations"] == 6


def test_assistant_receives_opted_in_excerpts_and_request_opt_out_wins():
    received = []

    class Provider:
        async def assess(self, text):
            received.append(text)
            return await DemonstrationProvider().assess(text)

    app = create_app(Settings(_env_file=None), {"groq": Provider()})
    client = account(app)
    client.put("/api/context", json={"conversation_memory_enabled": True, "use_enabled": True})
    task(client, "PAST_TASK_MARKER", provider="groq", allow_external=True)
    task(client, "CURRENT_TASK", provider="groq", allow_external=True)
    assert "PAST_TASK_MARKER" in received[-1]
    task(
        client, "PRIVATE_REQUEST", provider="groq", allow_external=True, use_personal_context=False
    )
    assert received[-1] == "PRIVATE_REQUEST"


def test_text_disabled_during_assessment_is_not_saved():
    app = None

    class Provider:
        async def assess(self, text):
            with app.state.storage.connect() as db:
                db.execute("UPDATE user_context SET conversation_memory_enabled=0")
            return await DemonstrationProvider().assess(text)

    app = create_app(Settings(_env_file=None), {"groq": Provider()})
    client = account(app)
    client.put("/api/context", json={"conversation_memory_enabled": True})
    saved = task(client, provider="groq", allow_external=True)
    assert history(client, saved)["conversation"] is None


def test_coach_uses_text_only_when_allowed_and_cannot_detect_without_it(monkeypatch):
    calls = []

    class Coach:
        def __init__(self, settings):
            pass

        async def generate(self, metadata):
            calls.append(metadata)
            output = deepcopy(REPORT)
            output["patterns"]["prompting"]["status"] = "possible_pattern"
            return CoachingReport.model_validate(output)

    monkeypatch.setattr("app.coaching.GroqCoach", Coach)
    settings = Settings(_env_file=None, groq_api_key="synthetic-key")
    app = create_app(settings)
    client = account(app)
    client.put("/api/context", json={"conversation_memory_enabled": True, "use_enabled": True})
    task(client)
    request = {"allow_external": True, "expected_model": settings.groq_model}
    saved = client.post("/api/progress/coaching", json=request)
    assert saved.status_code == 200
    assert saved.json()["source"]["conversation_samples"] == 1
    assert calls[-1]["conversation_excerpts"][0]["task"] == "OPTED_IN_TASK"
    client.put("/api/context", json={"use_enabled": False})
    assert client.get("/api/progress/coaching").json()["saved"] is None
    rejected = client.post("/api/progress/coaching", json=request)
    assert rejected.status_code == 502 and rejected.json()["detail"] == "invalid_provider_output"
    assert calls[-1]["conversation_excerpts"] == []


def test_delete_conversations_clears_coaching_preserves_metadata_and_other_accounts():
    app = create_app(Settings(_env_file=None))
    alice, bob = account(app), account(app, "bob@example.com")
    for client in (alice, bob):
        client.put("/api/context", json={"conversation_memory_enabled": True})
    saved = task(alice)
    task(bob, "BOB_TEXT")
    alice.delete("/api/context/conversations")
    assert history(alice, saved)["conversation"] is None
    assert alice.get("/api/progress").json()["analyses"] == 1
    assert bob.get("/api/context").json()["saved_conversations"] == 1
    new = task(alice)
    alice.delete(f"/api/sessions/{new['session_id']}")
    assert alice.get("/api/context").json()["saved_conversations"] == 0


def test_permission_revoked_during_coaching_does_not_restore_text_based_report(monkeypatch):
    app = create_app(Settings(_env_file=None, groq_api_key="synthetic-key"))
    client = account(app)
    client.put("/api/context", json={"conversation_memory_enabled": True, "use_enabled": True})
    task(client)

    class Coach:
        def __init__(self, settings):
            pass

        async def generate(self, metadata):
            client.put("/api/context", json={"conversation_memory_enabled": False})
            return CoachingReport.model_validate(REPORT)

    monkeypatch.setattr("app.coaching.GroqCoach", Coach)
    response = client.post(
        "/api/progress/coaching",
        json={
            "allow_external": True,
            "expected_model": "openai/gpt-oss-20b",
        },
    )
    assert response.status_code == 409
    assert client.get("/api/progress/coaching").json()["saved"] is None


def test_revocation_while_collecting_snapshot_discards_text(monkeypatch):
    app = create_app(Settings(_env_file=None))
    client = account(app)
    client.put("/api/context", json={"conversation_memory_enabled": True, "use_enabled": True})
    task(client)
    owner = client.get("/api/auth/me").json()["id"]
    original = app.state.storage.conversation_samples

    def revoke_after_read(user_id):
        samples = original(user_id)
        with app.state.storage.connect() as db:
            db.execute("UPDATE user_context SET use_enabled=0 WHERE user_id=?", (user_id,))
        return samples

    monkeypatch.setattr(app.state.storage, "conversation_samples", revoke_after_read)
    assert snapshot(app.state.storage, owner)[1]["conversation_excerpts"] == []
