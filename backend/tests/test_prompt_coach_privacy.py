"""Card B4: the Prompt Coach never stores, logs or prints the task, and asks for consent first.

A unique marker travels in the task text and in everything the fake Coach model returns
(quote, replacement and rewrite). After analysing and coaching in all three modes, the marker
must be absent from every table and column of the database, from every log record and from
stdout/stderr, whatever the user's memory and personal context settings are.
"""

import itertools
import logging
from pathlib import Path
from uuid import uuid4

import pytest
from app.main import create_app
from app.models import Assessment, Profile
from app.providers import Settings
from fastapi.testclient import TestClient
from profile_samples import profile_data

pytestmark = pytest.mark.prompt_coach

MARKER = "ZXQ-PRIVACY-MARKER"
TASK = f"Write a summary of the {MARKER} report for the board."
PLACEHOLDER = "[what must the result include?]"
MODES = ("tips", "edits", "rewrite")


class CountingCoach:
    """Fake Coach model: counts calls and echoes the marker in quote, replacement and rewrite."""

    calls: list = []

    def __init__(self, provider, settings, model):
        self.provider = provider

    async def __call__(self, schema, system, human):
        CountingCoach.calls.append(self.provider)
        return {
            "suggestions": [
                {
                    "dimension": "ambiguity",
                    "kind": "edit",
                    "title": "Name the audience",
                    "rationale": "The audience is not stated.",
                    "quote": MARKER,
                    "replacement": f"{MARKER} quarterly",
                    "expected_effect": "lower_ambiguity",
                },
                {
                    "dimension": "reasoning",
                    "kind": "question",
                    "title": "Ask what the summary must decide",
                    "rationale": "The purpose is unclear.",
                    "quote": None,
                    "replacement": None,
                    "expected_effect": "determine_dimension",
                },
            ],
            "rewrite": f"Write a summary of the {MARKER} report for the board. {PLACEHOLDER}",
            "open_questions": [f"Who reads the {MARKER} summary?"],
        }, {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}


@pytest.fixture(autouse=True)
def reset_calls():
    CountingCoach.calls = []


class EchoingAssessor:
    """Fake assessor that, like a real model might, echoes the task into its evidence."""

    async def assess(self, task):
        data = profile_data(ambiguity=3, reasoning=None)
        for key in ("context", "domain", "risk", "tools", "modality"):
            data[key]["confidence"] = "high"
        for value in data.values():
            if isinstance(value, dict):
                value["evidence"] = f"Quoted from the task: {MARKER}"
        data["explanation"] = f"The task mentions {MARKER}."
        return Assessment(profile=Profile.model_validate(data))


def make_app():
    settings = Settings(
        _env_file=None,
        prompt_coach_enabled=True,
        ollama_model="local-test-model",
        groq_api_key="",
    )
    assessor = EchoingAssessor()
    return create_app(
        settings,
        overrides={name: assessor for name in ("groq", "openai", "claude", "ollama")},
        prompt_coach_options={"model_factory": CountingCoach},
    )


def register(app):
    client = TestClient(app)
    response = client.post(
        "/api/auth/register",
        json={"email": f"{uuid4()}@example.com", "password": "test-password-123"},
    )
    assert response.status_code == 201
    return client


def analyse(client, provider="groq", **fields):
    response = client.post(
        "/api/analyze",
        json={"task": TASK, "provider": provider, "allow_external": True, **fields},
    )
    assert response.status_code == 200, response.text
    return response.json()


def coach_payload(analysis_id, mode, **fields):
    return {"analysis_id": analysis_id, "task": TASK, "mode": mode, **fields}


def database_text(app) -> list[tuple[str, str, str]]:
    """Every (table, column, value) of every row of every table, blobs decoded as UTF-8."""
    found = []
    with app.state.storage.connect() as db:
        tables = [
            row[0]
            for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        ]
        assert {"sessions", "analyses", "memory_entries", "user_context"} <= set(tables)
        for table in tables:
            cursor = db.execute(f'SELECT * FROM "{table}"')
            columns = [item[0] for item in cursor.description]
            for row in cursor.fetchall():
                for column, value in zip(columns, tuple(row), strict=True):
                    if isinstance(value, bytes | bytearray | memoryview):
                        text = bytes(value).decode("utf-8", errors="ignore")
                    else:
                        text = "" if value is None else str(value)
                    found.append((table, column, text))
    return found


def assert_marker_nowhere(app, caplog, capsys):
    leaks = [(table, column) for table, column, text in database_text(app) if MARKER in text]
    assert leaks == [], f"marker stored in {leaks}"
    # The database files themselves (main file and write-ahead log), byte for byte.
    database = Path(app.state.storage.path)
    for path in (database, Path(f"{database}-wal"), Path(f"{database}-journal")):
        if path.exists():
            assert MARKER.encode() not in path.read_bytes(), f"marker in {path.name}"
    logged = [
        record.name
        for record in caplog.records
        if MARKER
        in " ".join(
            str(part)
            for part in (record.getMessage(), record.args, record.exc_text, record.stack_info)
        )
    ]
    assert logged == [], f"marker logged by {logged}"
    captured = capsys.readouterr()
    assert MARKER not in captured.out and MARKER not in captured.err


CONTEXT_STATES = [
    dict(zip(("save_enabled", "use_enabled", "coaching_auto_enabled"), flags, strict=True))
    for flags in itertools.product((False, True), repeat=3)
]


@pytest.mark.parametrize("use_personal_context", [None, False])
@pytest.mark.parametrize(
    "context", CONTEXT_STATES, ids=lambda state: "-".join(k for k, v in state.items() if v) or "off"
)
def test_marker_is_never_stored_logged_or_printed(context, use_personal_context, caplog, capsys):
    caplog.set_level(logging.DEBUG)  # root logger: every logger propagates here
    app = make_app()
    client = register(app)
    saved = client.put("/api/context", json={"content": "I write for executives.", **context})
    assert saved.status_code == 200
    extra = {} if use_personal_context is None else {"use_personal_context": False}
    analysis = analyse(client, **extra)
    # The marker really flows through the analysis response (so the check below is not vacuous).
    assert MARKER in str(analysis["profile"])

    bodies = {}
    for mode in MODES:
        response = client.post(
            "/api/prompt-coach", json=coach_payload(analysis["id"], mode, allow_external=True)
        )
        assert response.status_code == 200, response.text
        bodies[mode] = response.json()
    assert CountingCoach.calls == ["groq"] * 3
    # The marker reaches the user in the edit and in the rewrite...
    edit = bodies["edits"]["suggestions"][0]
    assert edit["kind"] == "edit" and edit["quote"] == MARKER
    assert MARKER in edit["replacement"]
    assert MARKER in bodies["rewrite"]["rewrite"]
    assert MARKER in str(bodies["tips"]["open_questions"])
    # ...and does not come back through any read endpoint.
    for path in ("/api/sessions", f"/api/sessions/{analysis['session_id']}", "/api/context"):
        assert MARKER not in client.get(path).text
    # A recorded choice updates saved memory; it must still carry no task text.
    choice = client.post(
        "/api/decisions",
        json={"analysis_id": analysis["id"], "candidate_id": analysis["recommendation"]["id"]},
    )
    assert choice.status_code == 200

    assert_marker_nowhere(app, caplog, capsys)


def external_analysis(client, provider):
    if provider == "personal-groq":
        created = client.post(
            "/api/llm-configs",
            json={
                "label": "My Groq",
                "provider": "groq",
                "model": "personal-model",
                "api_key": "gsk-test-key",
            },
        )
        assert created.status_code == 201, created.text
        return analyse(client, configuration_id=created.json()["id"])
    return analyse(client, provider=provider)


@pytest.mark.parametrize("consent", [{"allow_external": False}, {}], ids=["false", "omitted"])
@pytest.mark.parametrize("provider", ["groq", "openai", "claude", "personal-groq"])
@pytest.mark.parametrize("mode", MODES)
def test_external_provider_without_consent_never_calls_the_model(
    provider, consent, mode, caplog, capsys
):
    caplog.set_level(logging.DEBUG)
    app = make_app()
    client = register(app)
    analysis = external_analysis(client, provider)
    response = client.post("/api/prompt-coach", json=coach_payload(analysis["id"], mode, **consent))
    assert response.status_code == 403
    assert response.json() == {"detail": "external_processing_requires_consent"}
    assert len(CountingCoach.calls) == 0
    assert_marker_nowhere(app, caplog, capsys)


@pytest.mark.parametrize("consent", [{"allow_external": False}, {}], ids=["false", "omitted"])
def test_local_provider_needs_no_external_consent(consent):
    """Control: the consent gate is specific to external providers, so the zero above is real."""
    app = make_app()
    client = register(app)
    analysis = analyse(client, provider="ollama")
    response = client.post(
        "/api/prompt-coach", json=coach_payload(analysis["id"], "tips", **consent)
    )
    assert response.status_code == 200
    assert CountingCoach.calls == ["ollama"]
