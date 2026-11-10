"""End-to-end scenarios of adding models and getting their evaluations (ADR-014 A8 to A12):
what a user does, step by step, through the API, with a fake catalogue and fake models."""

import json

import pytest
from app import evaluations
from app.main import create_app
from app.openrouter import OpenRouterCatalogue
from app.providers import Settings
from fastapi.testclient import TestClient
from test_evaluations import GROQ, PASSWORD, Assessor, FakeModel, drain


def entry(identifier, prompt="0", completion="0"):
    return {
        "id": identifier,
        "name": identifier,
        "context_length": 128000,
        "pricing": {"prompt": prompt, "completion": completion},
        "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]},
        "supported_parameters": ["tools", "response_format"],
    }


CATALOGUE = [
    entry("acme/free-one:free"),
    entry("acme/free-two"),  # free without the suffix
    entry("vendor/paid", "0.000001", "0.000004"),
    entry("vendor/unpriced", "-1", "-1"),  # OpenRouter's "price unknown"
]


@pytest.fixture
def app():
    async def fetch():
        return CATALOGUE

    return create_app(
        Settings(_env_file=None, groq_models=GROQ, groq_api_key="synthetic"),
        {"groq": Assessor()},
        openrouter_catalogue=OpenRouterCatalogue(fetch=fetch),
        evaluation_options={"worker": False},
    )


def user(app, email):
    client = TestClient(app)
    client.post("/api/auth/register", json={"email": email, "password": PASSWORD})
    return client


def router_config(client, model=""):
    body = {"label": "Router", "provider": "openrouter", "api_key": "sk-or-synthetic"}
    if model:
        body["model"] = model
    response = client.post("/api/llm-configs", json=body)
    assert response.status_code == 201, response.text
    return response.json()["id"]


def add(client, configuration, model):
    response = client.post(
        "/api/evaluations/models", json={"configuration_id": configuration, "model": model}
    )
    assert response.status_code == 201, response.text
    return response.json()


def listing(client):
    return {item["model"]: item for item in client.get("/api/evaluations").json()["models"]}


def test_key_only_router_then_free_paid_and_unpriced_models(app):
    client = user(app, "a@example.com")
    configuration = router_config(client)
    assert add(client, configuration, "acme/free-one:free")["status"] == "queued"
    assert add(client, configuration, "acme/free-two")["status"] == "queued"
    assert add(client, configuration, "vendor/paid")["status"] == "awaiting_consent"
    assert add(client, configuration, "vendor/unpriced")["status"] == "awaiting_consent"
    drain(app)
    models = listing(client)
    assert models["acme/free-one:free"]["levels_source"] == "measured"
    assert models["acme/free-two"]["levels_source"] == "measured"
    assert models["vendor/paid"]["evaluation"]["status"] == "awaiting_consent"
    # The key-only configuration has no model of its own to evaluate.
    assert "" not in models

    paid = models["vendor/paid"]["evaluation"]
    assert paid["estimate"]["price_known"] and paid["estimate"]["max_usd"] > 0
    assert client.post(f"/api/evaluations/{paid['id']}/consent", json={"accept": True}).json() == {
        "status": "queued"
    }
    unpriced = models["vendor/unpriced"]["evaluation"]
    refused = client.post(f"/api/evaluations/{unpriced['id']}/consent", json={"accept": True})
    assert refused.status_code == 422 and refused.json()["detail"] == "confirm_unknown_price"
    drain(app)
    assert listing(client)["vendor/paid"]["levels_source"] == "measured"


def test_re_evaluate_re_runs_the_model_asked_for(app):
    client = user(app, "a@example.com")
    configuration = router_config(client, model="acme/free-one:free")
    add(client, configuration, "acme/free-two")
    drain(app)
    before = listing(client)
    response = client.post(
        "/api/evaluations/reevaluate",
        json={"configuration_id": configuration, "model": "acme/free-two"},
    )
    assert response.status_code == 200, response.text
    after = listing(client)
    assert after["acme/free-two"]["evaluation"]["status"] == "queued"
    assert after["acme/free-two"]["evaluation"]["id"] != before["acme/free-two"]["evaluation"]["id"]
    # The configuration's own model was not touched.
    assert after["acme/free-one:free"]["evaluation"] == before["acme/free-one:free"]["evaluation"]


def test_one_users_evaluation_serves_everyone(app):
    alice, bob = user(app, "a@example.com"), user(app, "b@example.com")
    alice_router, bob_router = router_config(alice), router_config(bob)
    add(alice, alice_router, "vendor/paid")
    evaluation = listing(alice)["vendor/paid"]["evaluation"]
    alice.post(f"/api/evaluations/{evaluation['id']}/consent", json={"accept": False})
    # Bob pays for it; Alice gets the measured levels without paying.
    add(bob, bob_router, "vendor/paid")
    evaluation = listing(bob)["vendor/paid"]["evaluation"]
    assert (
        bob.post(f"/api/evaluations/{evaluation['id']}/consent", json={"accept": True}).status_code
        == 200
    )
    drain(app)
    assert listing(alice)["vendor/paid"]["levels_source"] == "measured"


def test_local_models_are_evaluated_for_their_owner_only(app):
    alice, bob = user(app, "a@example.com"), user(app, "b@example.com")
    response = alice.post(
        "/api/llm-configs",
        json={"label": "Local", "provider": "ollama", "model": "llama-local:8b"},
    )
    assert response.status_code == 201, response.text
    assert listing(alice)["llama-local:8b"]["evaluation"]["status"] == "queued"
    drain(app)
    assert listing(alice)["llama-local:8b"]["levels_source"] == "measured"
    assert "llama-local:8b" not in listing(bob)


def test_disabled_edited_and_removed_configurations(app):
    client = user(app, "a@example.com")
    configuration = router_config(client, model="acme/free-one:free")
    add(client, configuration, "acme/free-two")
    drain(app)
    assert {"acme/free-one:free", "acme/free-two"} <= set(listing(client))

    # Edited: the new default model is evaluated.
    edited = client.put(
        f"/api/llm-configs/{configuration}",
        json={"label": "Router", "provider": "openrouter", "model": "vendor/paid"},
    )
    assert edited.status_code == 200, edited.text
    assert listing(client)["vendor/paid"]["evaluation"]["status"] == "awaiting_consent"

    # Disabled: its models leave the list and the recommendation.
    client.put(
        f"/api/llm-configs/{configuration}",
        json={
            "label": "Router",
            "provider": "openrouter",
            "model": "vendor/paid",
            "enabled": False,
        },
    )
    assert "acme/free-two" not in listing(client)

    # Removed: its picks go with it; the shared results stay for others.
    client.delete(f"/api/llm-configs/{configuration}")
    assert not any(model.startswith(("acme/", "vendor/")) for model in listing(client))
    with app.state.storage.connect() as db:
        kept = db.execute(
            "SELECT COUNT(*) AS n FROM model_evaluations WHERE model='acme/free-two'"
        ).fetchone()["n"]
    assert kept == 1


def test_the_analysis_uses_what_was_measured_and_says_what_is_pending(app):
    client = user(app, "a@example.com")
    configuration = router_config(client)
    add(client, configuration, "acme/free-one:free")
    pending = client.post(
        "/api/analyze", json={"task": "Plan a trip", "provider": "auto", "allow_external": True}
    ).json()
    assert any("acme/free-one:free" in note for note in pending["notes"])
    drain(app)
    done = client.post(
        "/api/analyze", json={"task": "Plan a trip", "provider": "auto", "allow_external": True}
    ).json()
    compared = [done["recommendation"]["model"]] + [item["model"] for item in done["alternatives"]]
    assert "acme/free-one:free" in compared
    assert not any("acme/free-one:free" in note for note in done["notes"])


def test_a_withdrawn_model_fails_with_the_reason_and_a_restart_resumes(app):
    client = user(app, "a@example.com")
    configuration = router_config(client)
    add(client, configuration, "acme/free-one:free")

    class Gone(FakeModel):
        async def ainvoke(self, messages):
            error = RuntimeError("No endpoints found for acme/free-one:free")
            error.status_code = 404
            raise error

    finished = drain(app, Gone())
    assert finished[0]["failure"].startswith("provider_refused")
    assert finished[0]["progress"] == evaluations.REFUSED_STREAK

    add(client, configuration, "acme/free-two")
    row = listing(client)["acme/free-two"]["evaluation"]
    with app.state.storage.connect() as db:
        db.execute("UPDATE model_evaluations SET status='running' WHERE id=%s", (row["id"],))
    evaluations.recover(app.state.storage)
    assert listing(client)["acme/free-two"]["evaluation"]["status"] == "queued"
    finished = {row["model"]: row["status"] for row in drain(app)}
    assert finished["acme/free-two"] == "done"
    # The refused model is not retried within the hour, however often the list is read.
    assert "acme/free-one:free" not in finished


def test_examples_and_disagreement_never_change_levels(app):
    client = user(app, "a@example.com")
    configuration = router_config(client)
    add(client, configuration, "acme/free-one:free")
    drain(app, FakeModel(weak={"reasoning"}))
    item = listing(client)["acme/free-one:free"]
    levels = {name: value["level"] for name, value in item["levels"].items()}
    assert levels["reasoning"] < levels["context"]
    assert item["evaluation"]["examples"]
    response = client.post(
        f"/api/evaluations/{item['evaluation']['id']}/disagree", json={"capability": "reasoning"}
    )
    assert response.json() == {"status": "recorded"}
    again = listing(client)["acme/free-one:free"]
    assert {n: v["level"] for n, v in again["levels"].items()} == levels
    assert json.dumps(again).count("sk-or-synthetic") == 0
