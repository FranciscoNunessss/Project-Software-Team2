"""OpenRouter provider: dynamic catalogue, pricing, model validation and key protection.

No test calls the real service: the catalogue comes from a fake fetcher or an httpx mock
transport, and the chat model is replaced the same way test_providers.py does it.
"""

import httpx
import pytest
from app.main import create_app
from app.models import Profile
from app.openrouter import (
    CatalogueUnavailable,
    OpenRouterCatalogue,
    build_catalogue,
    fetch_models,
    normalise,
)
from app.providers import Settings
from fastapi.testclient import TestClient
from profile_samples import profile_data

SECRET = "sk-or-test-key-must-never-leak"


def entry(identifier, prompt="0.000003", completion="0.000015", **extra):
    base = {
        "id": identifier,
        "name": identifier.split("/")[-1].title(),
        "description": "A model.",
        "context_length": 128000,
        "pricing": {"prompt": prompt, "completion": completion},
        "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]},
        "supported_parameters": ["temperature", "response_format", "structured_outputs"],
        "top_provider": {"context_length": 128000, "max_completion_tokens": 8192},
    }
    return base | extra


RAW = [
    entry("openai/gpt-paid", "0.0000025", "0.00001"),
    entry("meta-llama/llama-free:free", "0", "0"),
    # Free but WITHOUT the ":free" suffix: must still be recognised as free.
    entry("acme/gratis-model", "0", "0"),
    entry("anthropic/claude-paid", "0.000003", "0.000015"),
    entry("openrouter/free", "0", "0"),  # the Auto router: offered separately
    entry("openrouter/auto", "-1", "-1"),  # variable pricing: neither free nor priced
    entry("acme/half-free", "0", "0.000001"),
    entry(
        "acme/embedder",
        "0.0000001",
        "0",
        architecture={"input_modalities": ["text"], "output_modalities": ["embeddings"]},
    ),
    entry(
        "acme/painter",
        architecture={"input_modalities": ["text"], "output_modalities": ["image"]},
    ),
    entry("acme/no-structured", supported_parameters=["temperature"]),
    {"name": "no id"},
]


class FakeFetch:
    def __init__(self, data=None, error=None):
        self.data, self.error, self.calls = RAW if data is None else data, error, 0

    async def __call__(self):
        self.calls += 1
        if self.error:
            raise self.error
        return self.data


def signed_in(app, email="alice@example.com"):
    client = TestClient(app)
    assert (
        client.post(
            "/api/auth/register", json={"email": email, "password": "test-password-123"}
        ).status_code
        == 201
    )
    return client


def make_app(fetch=None, **settings):
    fetch = fetch or FakeFetch()
    app = create_app(
        Settings(_env_file=None, **settings), openrouter_catalogue=OpenRouterCatalogue(fetch)
    )
    return app, fetch


def connect(client, model="meta-llama/llama-free:free", key=SECRET):
    """OpenRouter is always a personal configuration (the user's own key); returns its id."""
    created = client.post(
        "/api/llm-configs",
        json={"label": "My OpenRouter", "provider": "openrouter", "model": model, "api_key": key},
    )
    assert created.status_code == 201, created.text
    return created.json()["id"]


# --- catalogue normalisation -------------------------------------------------------------------


def test_catalogue_keeps_free_and_paid_and_does_not_filter_by_suffix():
    models = {item["id"]: item for item in build_catalogue(RAW)}
    assert models["openai/gpt-paid"]["free"] is False
    assert models["meta-llama/llama-free:free"]["free"] is True
    assert models["acme/gratis-model"]["free"] is True  # no ":free" in the id
    assert models["anthropic/claude-paid"]["free"] is False
    assert models["acme/half-free"]["free"] is False  # free input only is not free
    assert "openrouter/free" not in models  # Auto is not mixed with individual models
    assert "no id" not in {item["name"] for item in models.values()}
    assert {item["organisation"] for item in models.values()} >= {
        "openai",
        "anthropic",
        "meta-llama",
        "acme",
    }


def test_prices_are_converted_from_per_token_to_per_million_tokens():
    paid = normalise(entry("openai/gpt-paid", "0.0000025", "0.00001"))
    assert paid["price_input_per_million"] == pytest.approx(2.5)
    assert paid["price_output_per_million"] == pytest.approx(10.0)
    free = normalise(entry("a/b:free", "0", "0"))
    assert free["price_input_per_million"] == 0 and free["free"] is True
    assert normalise(entry("a/tiny", "0.00000015", "0.0000006"))[
        "price_input_per_million"
    ] == pytest.approx(0.15)


def test_variable_or_missing_prices_are_never_reported_as_free():
    for pricing in ({"prompt": "-1", "completion": "-1"}, {}, {"prompt": "x", "completion": "0"}):
        item = normalise(entry("a/b", pricing=pricing))
        assert item["free"] is False
    assert normalise(entry("a/b", "-1", "-1"))["price_input_per_million"] is None
    # A per-request fee means the model is not free either.
    fee = entry("a/fee", "0", "0", pricing={"prompt": "0", "completion": "0", "request": "0.01"})
    assert normalise(fee)["free"] is False


def test_non_conversation_models_are_not_selectable_and_say_why():
    models = {item["id"]: item for item in build_catalogue(RAW)}
    assert models["openai/gpt-paid"]["selectable"] is True
    for identifier in ("acme/embedder", "acme/painter"):
        assert models[identifier]["selectable"] is False
        assert models[identifier]["text_chat"] is False
        assert "text conversation" in models[identifier]["unavailable_reason"]
    # ADR-014 A11: a chat model needs no structured output; only the assessor does.
    assert models["acme/no-structured"]["selectable"] is True
    assert models["acme/no-structured"]["structured_output"] is False


def test_catalogue_exposes_the_metadata_returned_by_the_api():
    item = normalise(entry("openai/gpt-paid", "0.0000025", "0.00001"))
    assert item["name"] == "Gpt-Paid" and item["description"] == "A model."
    assert item["context_length"] == 128000
    assert item["input_modalities"] == ["text"] and item["output_modalities"] == ["text"]
    assert "response_format" in item["supported_parameters"]
    assert item["top_provider"]["max_completion_tokens"] == 8192


# --- fetching ----------------------------------------------------------------------------------


async def test_fetch_models_calls_the_models_endpoint_without_the_api_key():
    seen = {}

    def handler(request: httpx.Request):
        seen["url"], seen["headers"] = str(request.url), dict(request.headers)
        return httpx.Response(200, json={"data": RAW})

    data = await fetch_models(5, httpx.MockTransport(handler))
    assert seen["url"] == "https://openrouter.ai/api/v1/models"
    assert "authorization" not in seen["headers"]
    assert len(data) == len(RAW)


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(500, text="boom " + SECRET),
        httpx.Response(200, text="not json"),
        httpx.Response(200, json={"data": "nope"}),
    ],
)
async def test_fetch_failures_become_safe_codes(response):
    with pytest.raises(CatalogueUnavailable) as failure:
        await fetch_models(5, httpx.MockTransport(lambda request: response))
    assert SECRET not in failure.value.code


# --- endpoint ----------------------------------------------------------------------------------


def test_models_endpoint_requires_sign_in_and_is_never_cached():
    app, fetch = make_app()
    assert TestClient(app).get("/api/openrouter/models").status_code == 401
    assert fetch.calls == 0
    response = signed_in(app).get("/api/openrouter/models")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"


def test_models_endpoint_loads_dynamically_caches_and_refreshes():
    app, fetch = make_app()
    client = signed_in(app)
    body = client.get("/api/openrouter/models").json()
    assert "auto" not in body  # no Auto router: the user always picks or configures a model
    ids = {item["id"] for item in body["models"]}
    assert "openai/gpt-paid" in ids and "acme/gratis-model" in ids
    assert any(item["free"] for item in body["models"])
    assert any(not item["free"] for item in body["models"])
    client.get("/api/openrouter/models")
    assert fetch.calls == 1  # served from the short cache
    fetch.data = [entry("new/just-added")]  # the catalogue changes upstream
    refreshed = client.get("/api/openrouter/models?refresh=true").json()
    assert fetch.calls == 2
    assert [item["id"] for item in refreshed["models"]] == ["new/just-added"]


def test_models_endpoint_reports_failure_without_stale_list_or_secrets():
    app, fetch = make_app()
    client = signed_in(app)
    assert client.get("/api/openrouter/models").status_code == 200
    fetch.error = CatalogueUnavailable()
    failed = client.get("/api/openrouter/models?refresh=true")
    assert failed.status_code == 502
    assert failed.json() == {"detail": "openrouter_catalogue_unavailable"}
    # No silent fallback to the previous list: the next plain read is a failure too.
    assert client.get("/api/openrouter/models").status_code == 502
    assert SECRET not in failed.text


# --- provider registration ---------------------------------------------------------------------


def test_openrouter_is_never_a_project_model_even_if_the_environment_has_a_key():
    app, _ = make_app(groq_api_key="g", groq_model="m", openrouter_api_key=SECRET)
    client = signed_in(app)
    options = client.get("/api/llm-options").json()
    server = {item["provider"] for item in options["options"] if item["source"] == "server"}
    assert "openrouter" not in server and "groq" in server
    assert options["auto_configuration_id"] == "server:groq"  # Auto is always the project Groq
    assert SECRET not in client.get("/api/llm-options").text
    listed = {item["id"]: item for item in client.get("/api/providers").json()}
    assert listed["openrouter"]["enabled"] is False
    # Nor can the project's configuration be selected by id.
    response = analyse(client, configuration_id="server:openrouter")
    assert response.status_code == 409 and response.json()["detail"] == "provider_not_configured"


def test_openrouter_appears_only_after_the_user_configures_it():
    app, _ = make_app()
    client = signed_in(app)
    options = client.get("/api/llm-options").json()["options"]
    assert "openrouter" not in {item["provider"] for item in options}
    connect(client)
    options = client.get("/api/llm-options").json()["options"]
    mine = [item for item in options if item["provider"] == "openrouter"]
    assert len(mine) == 1 and mine[0]["source"] == "personal" and mine[0]["external"] is True


def test_personal_openrouter_configuration_is_encrypted_and_never_returned():
    app, _ = make_app()
    client = signed_in(app)
    created = client.post(
        "/api/llm-configs",
        json={
            "label": "Mine",
            "provider": "openrouter",
            "model": "openai/gpt-paid",
            "api_key": SECRET,
        },
    )
    assert created.status_code == 201 and created.json()["external"] is True
    assert SECRET not in created.text and SECRET not in client.get("/api/llm-options").text
    with app.state.storage.connect() as db:
        assert SECRET not in db.execute("SELECT key_ciphertext FROM llm_configs").fetchone()[0]


# --- the adapter and analysis ------------------------------------------------------------------


class Recorder:
    """Stands in for langchain_openai.ChatOpenAI and records what the adapter built."""

    built: list[dict] = []
    error: Exception | None = None

    def __init__(self, **kwargs):
        Recorder.built.append(kwargs)

    def with_structured_output(self, schema, **kwargs):
        Recorder.options = kwargs
        return self

    async def ainvoke(self, messages):
        if Recorder.error:
            raise Recorder.error
        return {
            "parsed": Profile.model_validate(profile_data()),
            "parsing_error": None,
            "raw": None,
        }


@pytest.fixture
def recorder(monkeypatch):
    Recorder.built, Recorder.error, Recorder.options = [], None, {}
    monkeypatch.setattr("langchain_openai.ChatOpenAI", Recorder)
    return Recorder


def analyse(client, model=None, configuration_id=None, **extra):
    body = {
        "task": "Compare two API designs",
        "provider": "auto",
        "configuration_id": configuration_id or connect(client),
        "allow_external": True,
    } | extra
    if model:
        body["model"] = model
    return client.post("/api/analyze", json=body)


def test_the_configured_model_is_checked_against_the_catalogue_and_sent_exactly(recorder):
    app, fetch = make_app()
    response = analyse(signed_in(app))
    assert response.status_code == 200
    assert recorder.built[-1]["model"] == "meta-llama/llama-free:free"
    assert recorder.built[-1]["base_url"] == "https://openrouter.ai/api/v1"
    assert recorder.built[-1]["api_key"] == SECRET  # the user's own key
    assert recorder.options["method"] == "json_schema"
    # Only endpoints that support the strict JSON schema are used.
    assert recorder.built[-1]["extra_body"] == {"provider": {"require_parameters": True}}
    assert fetch.calls == 1
    assert SECRET not in response.text


def test_there_is_no_auto_router_a_configured_openrouter_free_is_refused(recorder):
    app, _ = make_app()
    client = signed_in(app)
    response = analyse(client, configuration_id=connect(client, model="openrouter/free"))
    assert response.status_code == 422 and response.json()["detail"] == "model_not_found"
    assert recorder.built == []


@pytest.mark.parametrize(
    "model", ["meta-llama/llama-free:free", "acme/gratis-model", "openai/gpt-paid"]
)
def test_manual_selection_sends_the_exact_catalogue_id(recorder, model):
    app, _ = make_app()
    response = analyse(signed_in(app), model, expected_model=model)  # paid: the user's own key
    assert response.status_code == 200
    assert recorder.built[-1]["model"] == model
    assert recorder.built[-1]["api_key"] == SECRET


def test_a_model_outside_the_catalogue_is_refused_before_any_provider_call(recorder):
    app, _ = make_app()
    response = analyse(signed_in(app), "made/up-model")
    assert response.status_code == 422 and response.json()["detail"] == "model_not_found"
    assert recorder.built == []


@pytest.mark.parametrize("model", ["acme/embedder", "acme/painter", "acme/no-structured"])
def test_incompatible_models_are_refused(recorder, model):
    app, _ = make_app()
    response = analyse(signed_in(app), model)
    assert response.status_code == 422 and response.json()["detail"] == "model_not_compatible"
    assert recorder.built == []


def test_unavailable_catalogue_blocks_every_model(recorder):
    app, _ = make_app(FakeFetch(error=CatalogueUnavailable()))
    client = signed_in(app)
    for model in (None, "openai/gpt-paid"):
        response = analyse(client, model)
        assert response.status_code == 502
        assert response.json()["detail"] == "openrouter_catalogue_unavailable"
    assert recorder.built == []  # no hardcoded fallback model was used


def test_the_model_field_is_only_accepted_for_openrouter(recorder):
    app, _ = make_app(groq_api_key="g", groq_model="m")
    response = analyse(signed_in(app), "openai/gpt-paid", configuration_id="server:groq")
    assert response.status_code == 422
    assert response.json()["detail"] == "model_override_not_supported"
    assert recorder.built == []


def test_the_chosen_model_is_not_replaced_silently(recorder):
    app, _ = make_app()
    response = analyse(signed_in(app), "openai/gpt-paid", expected_model="meta/other")
    assert response.status_code == 409
    assert response.json()["detail"] == "model_configuration_changed"
    assert recorder.built == []


def test_external_consent_is_still_required(recorder):
    app, _ = make_app()
    response = analyse(signed_in(app), allow_external=False)
    assert response.status_code == 403 and recorder.built == []


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (401, "provider_authentication"),
        (402, "provider_insufficient_credits"),
        (404, "provider_model_unavailable"),
        (429, "provider_rate_limit"),
    ],
)
def test_provider_errors_map_to_safe_codes_without_leaking_the_key(recorder, status, code):
    error = RuntimeError(f"upstream said {SECRET} and the private task")
    error.status_code = status
    recorder.error = error
    app, _ = make_app()
    response = analyse(signed_in(app))
    assert response.status_code == 502 and response.json()["detail"] == code
    assert SECRET not in response.text and "private task" not in response.text


def test_the_key_never_appears_in_settings_repr_or_openrouter_responses(recorder):
    settings = Settings(_env_file=None, openrouter_api_key=SECRET)
    assert SECRET not in repr(settings)
    app, _ = make_app()
    client = signed_in(app)
    texts = [
        client.get("/api/openrouter/models").text,
        client.get("/api/llm-options").text,
        analyse(client).text,
    ]
    assert all(SECRET not in text for text in texts)


def test_require_parameters_is_sent_only_for_the_assessment_never_the_chat(recorder):
    from app.providers import chat_model

    settings = Settings(
        _env_file=None, openrouter_api_key=SECRET, openrouter_model="acme/chat-only"
    )
    chat_model("openrouter", settings, 1024)
    assert "extra_body" not in recorder.built[-1]  # a model without structured output can chat
    app, _ = make_app()
    assert analyse(signed_in(app)).status_code == 200
    assert recorder.built[-1]["extra_body"] == {"provider": {"require_parameters": True}}


def test_no_endpoint_for_the_strict_schema_becomes_model_not_compatible(recorder):
    error = RuntimeError("No endpoints found that can handle the requested parameters")
    error.status_code = 404
    recorder.error = error
    app, _ = make_app()
    response = analyse(signed_in(app))
    assert response.status_code == 502
    assert response.json()["detail"] == "model_not_compatible"
    assert "No endpoints" not in response.text  # no upstream message is returned
