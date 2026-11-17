"""Raw task content never reaches a stored record, a log or a trace (ADR-005, R-A3).

Card "Automated privacy test: no raw task content persisted": a task carrying a unique
marker goes through analysis, selection and feedback, on the normal path and on every
provider error path, and the marker must appear nowhere it could be kept.

The two documented exceptions are not exercised here and have their own tests: chat
messages (ADR-011) and opt-in conversation text (test_conversations.py).
"""

import logging

import pytest
from app import providers
from app.main import create_app
from app.models import Assessment, Profile
from app.providers import ProviderFailure, Settings
from fastapi.testclient import TestClient
from langsmith import utils as langsmith_utils
from profile_samples import profile_data
from psycopg import sql

MARKER = "CONFIDENTIAL_MARKER_4c1f"
TASK = f"Summarise the {MARKER} merger memo for the board."
FAILURE_CODES = [
    "provider_timeout",
    "provider_rate_limit",
    "provider_unavailable",
    "provider_authentication",
    "provider_insufficient_credits",
    "provider_model_unavailable",
    "provider_unsupported_request",
    "provider_output_truncated",
    "invalid_provider_output",
]


def account(client, email="marker@example.com"):
    response = client.post(
        "/api/auth/register", json={"email": email, "password": "test-password-123"}
    )
    assert response.status_code == 201
    return response.json()


def stored_text(app):
    """Every row of every table of the application's schema, as one string."""
    store = app.state.storage
    with store.connect() as db:
        tables = [
            row[0]
            for row in db.execute(
                "SELECT table_name FROM information_schema.tables WHERE table_schema=%s",
                (store.schema,),
            )
        ]
        assert {"sessions", "analyses", "decisions", "memory_entries"} <= set(tables)
        return "".join(
            str([tuple(row) for row in db.execute(sql.SQL("SELECT * FROM {}").format(table))])
            for table in map(sql.Identifier, tables)
        )


def private_pages(client):
    return "".join(
        client.get(path).text
        for path in (
            "/api/sessions",
            "/api/context",
            "/api/progress",
            "/api/progress/pending",
            "/api/progress/activity",
            "/api/progress/dashboard",
            "/api/progress/outcomes",
            "/api/progress/learning",
        )
    )


class EchoingProvider:
    """A model that repeats the task in every free-text field it returns."""

    def __init__(self):
        self.tracing = []

    async def assess(self, task):
        self.tracing.append(langsmith_utils.tracing_is_enabled())
        data = profile_data()
        data["explanation"] = task
        for value in data.values():
            if isinstance(value, dict):
                value["evidence"] = task
        return Assessment(profile=Profile.model_validate(data))


class FailingProvider:
    def __init__(self, failure):
        self.failure = failure

    async def assess(self, task):
        raise self.failure


def test_analysis_selection_and_feedback_keep_the_marker_nowhere(caplog, monkeypatch):
    # A developer machine with tracing switched on must still send no trace.
    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGCHAIN_TRACING_V2", "true")
    langsmith_utils.get_env_var.cache_clear()
    provider = EchoingProvider()
    app = create_app(Settings(_env_file=None), {"ollama": provider})
    client = TestClient(app)
    account(client)
    assert client.put("/api/context", json={"save_enabled": True}).status_code == 200
    with caplog.at_level(logging.DEBUG):
        analysed = client.post(
            "/api/analyze", json={"task": TASK, "task_context": TASK, "provider": "ollama"}
        )
        assert analysed.status_code == 200
        result = analysed.json()
        assert MARKER in analysed.text  # The live answer may quote the task; history may not.
        again = client.post(
            "/api/analyze",
            json={
                "task": TASK + " Shorter.",
                "provider": "ollama",
                "session_id": result["session_id"],
                "previous_analysis_id": result["id"],
            },
        )
        assert again.status_code == 200
        chosen = client.post(
            "/api/decisions",
            json={"analysis_id": result["id"], "candidate_id": result["recommendation"]["id"]},
        )
        assert chosen.status_code == 200
        outcome = client.put(
            f"/api/analyses/{result['id']}/outcome",
            json={"outcome": "not_resolved", "reason": "description"},
        )
        assert outcome.status_code == 200, outcome.text
        pages = private_pages(client) + client.get(f"/api/sessions/{result['session_id']}").text
    langsmith_utils.get_env_var.cache_clear()
    assert provider.tracing == [False, False]
    assert MARKER not in stored_text(app)
    assert MARKER not in pages
    assert MARKER not in caplog.text


@pytest.mark.parametrize("code", FAILURE_CODES)
def test_a_provider_failure_keeps_the_marker_nowhere(caplog, code):
    app = create_app(Settings(_env_file=None), {"ollama": FailingProvider(ProviderFailure(code))})
    client = TestClient(app)
    account(client)
    client.put("/api/context", json={"save_enabled": True})
    with caplog.at_level(logging.DEBUG):
        failed = client.post(
            "/api/analyze", json={"task": TASK, "task_context": TASK, "provider": "ollama"}
        )
    assert failed.status_code == 502
    assert failed.json() == {"detail": code}
    assert MARKER not in stored_text(app)
    assert MARKER not in private_pages(client)
    assert MARKER not in caplog.text
    # The session opened for the failed analysis is removed, not left empty.
    assert client.get("/api/sessions").json() == []


class EchoingSdkError(Exception):
    """A provider SDK error whose message quotes the request, as real ones can."""

    def __init__(self, status_code):
        super().__init__(f"Request failed for prompt: {TASK}")
        self.status_code = status_code
        self.body = {"error": {"message": TASK}}


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (401, "provider_authentication"),
        (429, "provider_rate_limit"),
        (500, "provider_unavailable"),
    ],
)
def test_a_provider_sdk_error_that_quotes_the_task_is_reduced_to_a_code(
    caplog, monkeypatch, status, code
):
    async def failing(provider, settings, schema, prompt, max_tokens, temperature):
        raise EchoingSdkError(status)

    monkeypatch.setattr(providers, "_invoke", failing)
    app = create_app(Settings(_env_file=None, groq_api_key="synthetic-key"))
    client = TestClient(app)
    account(client)
    with caplog.at_level(logging.DEBUG):
        failed = client.post(
            "/api/analyze",
            json={"task": TASK, "task_context": TASK, "provider": "groq", "allow_external": True},
        )
    assert failed.status_code == 502
    detail = failed.json()["detail"]
    assert detail == code
    assert MARKER not in failed.text
    assert MARKER not in stored_text(app)
    assert MARKER not in private_pages(client)
    assert MARKER not in caplog.text


async def test_the_failure_raised_by_a_provider_call_carries_no_task_text(monkeypatch):
    async def failing(provider, settings, schema, prompt, max_tokens, temperature):
        raise EchoingSdkError(500)

    monkeypatch.setattr(providers, "_invoke", failing)
    settings = Settings(_env_file=None, groq_api_key="synthetic-key")
    with pytest.raises(ProviderFailure) as failure:
        await providers.structured_call("groq", settings, Profile, "system", TASK, "assessment")
    error = failure.value
    # No chained exception: a traceback printed by the server cannot show the SDK message.
    assert error.__cause__ is None and error.__suppress_context__
    assert MARKER not in str(error) and MARKER not in repr(error) and MARKER not in error.code


def test_invalid_model_output_that_quotes_the_task_keeps_the_marker_nowhere(caplog):
    class Invalid:
        async def assess(self, task):
            data = profile_data()
            data["reasoning"]["score"] = 99  # Outside the rubric's scale.
            data["explanation"] = task
            return Assessment(profile=Profile.model_validate(data))

    app = create_app(Settings(_env_file=None), {"ollama": Invalid()})
    client = TestClient(app)
    account(client)
    with caplog.at_level(logging.DEBUG):
        failed = client.post("/api/analyze", json={"task": TASK, "provider": "ollama"})
    assert failed.status_code == 502
    assert failed.json() == {"detail": "invalid_provider_output"}
    assert MARKER not in stored_text(app)
    assert MARKER not in caplog.text
