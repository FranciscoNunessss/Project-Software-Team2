"""Automatic evaluation of the configured models (ADR-014): the 16 cases of the plan.

Fake models answer the synthetic suite; no provider is called and nothing is paid.
"""

import asyncio
import json

import pytest
from app import evaluations
from app.catalogue import CAPABILITIES
from app.evaluations import (
    Ratings,
    Target,
    adaptive_levels,
    ensure,
    estimate,
    family_of,
    inventory,
    recover,
    run_next,
)
from app.main import create_app
from app.measurement import SUITE_VERSION
from app.providers import Settings
from app.recommendation import Option
from fastapi.testclient import TestClient
from test_measurement import reference
from test_recommendation import card, catalogue

PASSWORD = "correct horse battery"
GROQ = "openai/gpt-oss-20b"


class Reply:
    def __init__(self, content, tokens_out=50):
        self.content = content
        self.usage_metadata = {"input_tokens": 100, "output_tokens": tokens_out}


class FakeModel:
    """Answers every task right, except capabilities in ``weak`` (wrong from level 2 up)."""

    calls = 0

    def __init__(self, weak=(), fail_every=0, tokens_out=50):
        self.weak, self.fail_every, self.tokens_out = set(weak), fail_every, tokens_out

    def __call__(self, provider, settings, max_tokens):
        return self

    async def ainvoke(self, messages):
        FakeModel.calls += 1
        if self.fail_every and FakeModel.calls % self.fail_every == 0:
            raise RuntimeError("invalid request")
        prompt = messages[0][1]
        task = next(t for t in evaluations.suite() if t.prompt == prompt)
        if task.capability in self.weak and task.level >= 2:
            return Reply("I am not sure.", self.tokens_out)
        return Reply(reference(task), self.tokens_out)


async def no_sleep(_seconds):
    return None


class Assessor:
    async def assess(self, task):
        from app.models import Assessment, Profile
        from profile_samples import profile_data

        return Assessment(profile=Profile.model_validate(profile_data(reasoning=2)))


def make_app(**settings):
    return create_app(
        Settings(_env_file=None, groq_models=GROQ, groq_api_key="synthetic", **settings),
        {"groq": Assessor()},
        evaluation_options={"worker": False},
    )


def account(app, email="alice@example.com"):
    client = TestClient(app)
    client.post("/api/auth/register", json={"email": email, "password": PASSWORD})
    return client


def configure(client, provider="openai", model="gpt-5.4-mini", key="sk-synthetic"):
    body = {"label": model, "provider": provider, "model": model}
    if key:
        body["api_key"] = key
    response = client.post("/api/llm-configs", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def drain(app, model=None):
    async def go():
        done = []
        while row := await run_next(
            app.state.storage,
            app.state.evaluation_configurations,
            model or FakeModel(),
            no_sleep,
        ):
            done.append(row)
        return done

    return asyncio.run(go())


def by_model(client):
    return {item["model"]: item for item in client.get("/api/evaluations").json()["models"]}


# 1. free model (server) evaluated without asking; 16. it enters the recommendation
def test_server_model_is_evaluated_without_consent_and_then_recommended():
    app = make_app()
    client = account(app)
    listed = by_model(client)[GROQ]
    assert listed["evaluation"]["status"] == "queued" and not listed["paid_by_you"]
    finished = drain(app)
    assert [row["status"] for row in finished] == ["done"]
    listed = by_model(client)[GROQ]
    assert listed["levels_source"] == "measured"
    assert {name: item["level"] for name, item in listed["levels"].items()} == dict.fromkeys(
        CAPABILITIES, 3
    )
    result = client.post(
        "/api/analyze", json={"task": "Plan a trip", "provider": "auto", "allow_external": True}
    ).json()
    assert result["recommendation"]["model"] == GROQ
    assert result["recommendation"]["illustrative"] is False


# 2. already evaluated by us: reused, no new calls
def test_an_evaluated_model_is_reused_by_every_user_without_new_calls():
    app = make_app()
    alice = account(app)
    by_model(alice)
    drain(app)
    FakeModel.calls = 0
    bob = account(app, "bob@example.com")
    assert by_model(bob)[GROQ]["evaluation"]["status"] == "done"
    assert drain(app) == [] and FakeModel.calls == 0


# 3. paid model with the user's key: waits for consent and makes no call before it
def test_a_paid_model_waits_for_consent_with_an_estimate_and_a_maximum():
    app = make_app()
    client = account(app)
    by_model(client)
    drain(app)  # the server model first
    configure(client, "openai", "gpt-5.4-mini")
    row = by_model(client)["gpt-5.4-mini"]["evaluation"]
    assert row["status"] == "awaiting_consent"
    cost = row["estimate"]
    assert cost["price_known"] is True and 0 < cost["estimated_usd"] < cost["max_usd"] < 1
    FakeModel.calls = 0
    assert drain(app) == [] and FakeModel.calls == 0
    assert client.post(f"/api/evaluations/{row['id']}/consent", json={"accept": True}).json() == {
        "status": "queued"
    }
    assert [r["status"] for r in drain(app)] == ["done"]


# 4. declined: usable, never recommended; consent possible later
def test_a_declined_model_stays_usable_but_is_not_recommended():
    app = make_app()
    client = account(app)
    configure(client, "openai", "gpt-5.4-mini")
    row = by_model(client)["gpt-5.4-mini"]["evaluation"]
    client.post(f"/api/evaluations/{row['id']}/consent", json={"accept": False})
    listed = by_model(client)["gpt-5.4-mini"]
    assert listed["evaluation"]["status"] == "declined"
    options = client.get("/api/llm-options").json()["options"]
    assert any(item["model"] == "gpt-5.4-mini" for item in options)
    assert listed["levels_source"] is None


# 5. unknown price: double confirmation
def test_an_unknown_price_needs_a_second_confirmation():
    app = make_app()
    client = account(app)
    configure(client, "openai", "some-new-model")
    row = by_model(client)["some-new-model"]["evaluation"]
    assert row["estimate"]["price_known"] is False and row["estimate"]["max_usd"] is None
    url = f"/api/evaluations/{row['id']}/consent"
    assert client.post(url, json={"accept": True}).status_code == 422
    assert client.post(url, json={"accept": True, "confirm_unknown_price": True}).status_code == 200


# 6. the cost limit stops the run
def test_the_run_stops_at_the_guaranteed_maximum():
    app = make_app()
    client = account(app)
    configure(client, "openai", "gpt-5.4-mini")
    row = by_model(client)["gpt-5.4-mini"]["evaluation"]
    client.post(f"/api/evaluations/{row['id']}/consent", json={"accept": True})
    # Answers far longer than the cap would allow: the run must stop at the maximum.
    finished = drain(app, FakeModel(tokens_out=100_000))
    assert finished[0]["status"] == "failed" and finished[0]["failure"] == "cost_limit_reached"
    assert finished[0]["spent_usd"] >= row["estimate"]["max_usd"]
    assert finished[0]["progress"] < finished[0]["total"]


# 7. more than 10% failed calls: discarded
def test_too_many_failed_calls_discard_the_run():
    app = make_app()
    client = account(app)
    by_model(client)
    FakeModel.calls = 0
    finished = drain(app, FakeModel(fail_every=3))
    assert finished[0]["status"] == "failed" and finished[0]["failure"] == "too_many_failed_calls"
    assert by_model(client)[GROQ]["levels_source"] is None


# 8. rate limits are retried
def test_rate_limits_are_retried_and_the_run_finishes():
    class Limited(FakeModel):
        async def ainvoke(self, messages):
            Limited.hits = getattr(Limited, "hits", 0) + 1
            if Limited.hits % 5 == 0:
                raise RuntimeError("429 rate limit")
            return await super().ainvoke(messages)

    app = make_app()
    client = account(app)
    by_model(client)
    finished = drain(app, Limited())
    assert finished[0]["status"] == "done" and finished[0]["errors"] == 0


# 9. two users at the same time: one run
def test_concurrent_requests_open_a_single_run():
    app = make_app()
    store = app.state.storage
    target = Target("groq", GROQ, "server:groq", None)

    async def both():
        return await asyncio.gather(ensure(store, target), ensure(store, target))

    first, second = asyncio.run(both())
    assert first["id"] == second["id"]


# 10. local models are per user, never shared
def test_local_models_are_evaluated_per_user():
    app = make_app()
    alice, bob = account(app), account(app, "bob@example.com")
    configure(alice, "lmstudio", "gemma-local", key=None)
    configure(bob, "lmstudio", "gemma-local", key=None)
    first = by_model(alice)["gemma-local"]
    second = by_model(bob)["gemma-local"]
    assert first["shared"] is False and second["shared"] is False
    assert first["evaluation"]["id"] != second["evaluation"]["id"]
    assert first["evaluation"]["status"] == "queued"  # local: free, no consent


# 11. a new suite version re-evaluates; 12. stale results too
def test_a_new_suite_version_needs_a_new_run(monkeypatch):
    app = make_app()
    client = account(app)
    by_model(client)
    drain(app)
    monkeypatch.setattr(evaluations, "SUITE_VERSION", SUITE_VERSION + "-next")
    assert by_model(client)[GROQ]["evaluation"]["status"] == "queued"


# 13. deleting a configuration keeps the shared result but removes the model for that user
def test_deleting_a_configuration_removes_it_from_the_users_list():
    app = make_app()
    client = account(app)
    config = configure(client, "openrouter", "google/gemma-4-31b-it:free")
    by_model(client)
    drain(app)
    client.delete(f"/api/llm-configs/{config['id']}")
    assert "google/gemma-4-31b-it:free" not in by_model(client)
    other = account(app, "bob@example.com")
    configure(other, "openrouter", "google/gemma-4-31b-it:free")
    assert by_model(other)["google/gemma-4-31b-it:free"]["evaluation"]["status"] == "done"


# 14. Artificial Analysis as the fallback source, with its source named
def test_artificial_analysis_is_the_fallback_for_unmeasured_models():
    ratings = Ratings(None, catalogue())
    found = ratings.source("claude", "claude-sonnet-5-5")
    assert found is not None and found[0] == "benchmark"
    assert all(item["status"] == "provisional" for item in found[1].values())
    assert "Artificial Analysis overall index" in found[1]["reasoning"]["source"]
    assert ratings.source("claude", "claude-unknown") is None


# 15. family inheritance: the lowest measured level, provisional
def test_family_inheritance_takes_the_lowest_measured_levels():
    ratings = Ratings(None, catalogue())
    ratings.measured = {
        ("openrouter", "google/gemma-4-31b-it"): {
            "levels_json": json.dumps(
                {n: {"level": 2, "pass_rates": {"2": 1.0}} for n in CAPABILITIES}
            ),
            "facts_json": None,
            "finished_at": "2026-11-07T00:00:00Z",
        },
        ("openrouter", "google/gemma-4-12b-it"): {
            "levels_json": json.dumps(
                {n: {"level": 1, "pass_rates": {"2": 0.0}} for n in CAPABILITIES}
            ),
            "facts_json": None,
            "finished_at": "2026-11-07T00:00:00Z",
        },
    }
    found = ratings.source("openrouter", "google/gemma-5-9b-it")
    assert found[0] == "family" and found[1]["reasoning"]["level"] == 1
    assert family_of("google/gemma-4-26b-a4b-it:free") == "gemma"
    # Different families must not lend each other levels.
    assert family_of("openai/gpt-oss-20b") == "gpt-oss" != family_of("gpt-5.4-mini") == "gpt"


# calibrated catalogue levels win over measured ones
def test_calibrated_levels_win():
    calibrated = card("gpt-oss-20b", 1, 0.1, status="calibrated")
    calibrated["aliases"] = [{"provider": "groq", "model": GROQ}]
    ratings = Ratings(None, catalogue(calibrated))
    ratings.measured = {
        ("groq", GROQ): {
            "levels_json": json.dumps(
                {n: {"level": 3, "pass_rates": {"2": 1.0}} for n in CAPABILITIES}
            ),
            "facts_json": None,
            "finished_at": "2026-11-07T00:00:00Z",
        }
    }
    built = ratings.card(Option("groq", GROQ, "server:groq", "Groq"))
    assert built.level("reasoning") == 1 and built.capabilities["reasoning"].status == "calibrated"


def test_adaptive_levels_and_estimate_bounds():
    rates = {
        "reasoning": {2: 1.0, 3: 0.75},
        "context": {2: 1.0, 3: 0.5},
        "domain": {2: 0.5, 1: 1.0},
        "reliability": {2: 0.25, 1: 0.5},
        "tools": {2: 0.75, 3: 1.0},
    }
    assert adaptive_levels(rates) == {
        "reasoning": 3,
        "context": 2,
        "domain": 1,
        "reliability": None,
        "tools": 3,
    }
    cost = estimate(2.0, 10.0, False)
    assert cost["calls_max"] == 40 and cost["estimated_usd"] < cost["max_usd"]
    assert estimate(None, None, True)["max_usd"] == 0.0


def test_inventory_lists_server_models_and_enabled_configurations_only():
    app = make_app()
    client = account(app)
    configure(client, "openai", "gpt-5.4-mini")
    disabled = configure(client, "claude", "claude-sonnet-5-5")
    client.put(
        f"/api/llm-configs/{disabled['id']}",
        json={"label": "x", "provider": "claude", "model": "claude-sonnet-5-5", "enabled": False},
    )
    found = {
        (t.provider, t.model)
        for t in inventory(app.state.storage, app.state.evaluation_configurations, {"groq": True})
    }
    assert ("groq", GROQ) in found and ("openai", "gpt-5.4-mini") in found
    assert ("claude", "claude-sonnet-5-5") not in found


def test_disagreement_is_recorded_and_changes_nothing():
    app = make_app()
    client = account(app)
    by_model(client)
    drain(app)
    listed = by_model(client)[GROQ]
    url = f"/api/evaluations/{listed['evaluation']['id']}/disagree"
    assert client.post(url, json={"capability": "tools"}).json() == {"status": "recorded"}
    assert client.post(url, json={"capability": "magic"}).status_code == 422
    assert by_model(client)[GROQ]["levels"] == listed["levels"]


@pytest.mark.parametrize("weak", [("tools",)])
def test_a_weak_capability_gets_a_low_level(weak):
    app = make_app()
    client = account(app)
    by_model(client)
    drain(app, FakeModel(weak=weak))
    levels = by_model(client)[GROQ]["evaluation"]["levels"]
    assert levels["tools"]["level"] == 1 and levels["reasoning"]["level"] == 3


def test_a_restart_retries_free_runs_and_fails_paid_ones():
    app = make_app()
    client = account(app)
    by_model(client)
    configure(client, "openai", "gpt-5.4-mini")
    paid = by_model(client)["gpt-5.4-mini"]["evaluation"]
    client.post(f"/api/evaluations/{paid['id']}/consent", json={"accept": True})
    store = app.state.storage
    with store.connect() as db:
        db.execute("UPDATE model_evaluations SET status='running', progress=7")
    recover(store)
    listed = by_model(client)
    assert listed[GROQ]["evaluation"]["status"] == "queued"
    assert listed[GROQ]["evaluation"]["progress"] == 0
    assert listed["gpt-5.4-mini"]["evaluation"]["status"] == "failed"
    assert listed["gpt-5.4-mini"]["evaluation"]["failure"] == "interrupted"


def test_the_analysis_says_which_models_are_still_being_evaluated():
    app = make_app()
    client = account(app)
    by_model(client)  # queues the server model
    result = client.post(
        "/api/analyze", json={"task": "Plan a trip", "provider": "auto", "allow_external": True}
    ).json()
    assert any(
        "Not in this recommendation yet" in note and GROQ in note for note in result["notes"]
    )
    drain(app)
    result = client.post(
        "/api/analyze", json={"task": "Plan a trip", "provider": "auto", "allow_external": True}
    ).json()
    assert not any("Not in this recommendation yet" in note for note in result["notes"])


def test_the_worker_waits_for_its_turn_before_every_call():
    app = make_app()
    client = account(app)
    by_model(client)
    turns = []

    async def wait_turn():
        turns.append(1)

    async def go():
        return await run_next(
            app.state.storage,
            app.state.evaluation_configurations,
            FakeModel(),
            no_sleep,
            wait_turn,
        )

    row = asyncio.run(go())
    assert row["status"] == "done" and len(turns) == row["progress"]


def router_app():
    from app.openrouter import OpenRouterCatalogue

    def entry(identifier, prompt="0", completion="0"):
        return {
            "id": identifier,
            "name": identifier,
            "context_length": 128000,
            "pricing": {"prompt": prompt, "completion": completion},
            "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]},
            "supported_parameters": ["response_format", "structured_outputs", "tools"],
        }

    async def fetch():
        return [entry("acme/base:free"), entry("acme/picked:free"), entry("acme/other:free")]

    class Echo:
        def __init__(self, *_args):
            pass

        async def stream(self, _messages):
            yield "answer"

    return create_app(
        Settings(_env_file=None, groq_models=GROQ, groq_api_key="synthetic"),
        {"groq": Assessor()},
        evaluation_options={"worker": False},
        openrouter_catalogue=OpenRouterCatalogue(fetch),
        chat_options={"model_factory": Echo},
    )


@pytest.mark.chat
def test_a_model_picked_in_the_chat_is_evaluated_and_then_recommended():
    app = router_app()
    client = account(app)
    config = configure(client, "openrouter", "acme/base:free", key="sk-or-synthetic")
    chat = client.post("/api/chats").json()
    sent = client.post(
        f"/api/chats/{chat['id']}/messages",
        json={
            "content": "hello",
            "configuration_id": config["id"],
            "model": "acme/picked:free",
            "allow_external": True,
        },
    )
    assert sent.status_code == 200, sent.text
    listed = by_model(client)
    assert listed["acme/picked:free"]["picked"] is True
    assert listed["acme/picked:free"]["evaluation"]["status"] == "queued"  # free: no consent
    drain(app, FakeModel())
    result = client.post(
        "/api/analyze", json={"task": "x", "provider": "auto", "allow_external": True}
    ).json()
    compared = {item["model"]: item for item in [result["recommendation"], *result["alternatives"]]}
    picked = compared["acme/picked:free"]
    # Recommended or compared with how to use it: the configuration's key and the picked id.
    assert picked["configuration_id"] == config["id"] and picked["blended_price"] == 0


def test_openrouter_models_can_be_added_and_removed_from_the_evaluations():
    app = router_app()
    client = account(app)
    config = configure(client, "openrouter", "acme/base:free", key="sk-or-synthetic")
    added = client.post(
        "/api/evaluations/models",
        json={"configuration_id": config["id"], "model": "acme/other:free"},
    )
    assert added.status_code == 201 and added.json()["status"] == "queued"
    assert by_model(client)["acme/other:free"]["picked"] is True
    unknown = client.post(
        "/api/evaluations/models", json={"configuration_id": config["id"], "model": "acme/missing"}
    )
    assert unknown.status_code == 422
    other = configure(client, "openai", "gpt-5.4-mini")
    wrong = client.post(
        "/api/evaluations/models",
        json={"configuration_id": other["id"], "model": "acme/other:free"},
    )
    assert wrong.status_code == 404
    client.delete(
        "/api/evaluations/models",
        params={"configuration_id": config["id"], "model": "acme/other:free"},
    )
    assert "acme/other:free" not in by_model(client)
    # Disabling the configuration takes its picked models out too.
    client.post(
        "/api/evaluations/models",
        json={"configuration_id": config["id"], "model": "acme/other:free"},
    )
    client.put(
        f"/api/llm-configs/{config['id']}",
        json={"label": "x", "provider": "openrouter", "model": "acme/base:free", "enabled": False},
    )
    assert "acme/other:free" not in by_model(client)
