"""Card B4: the Prompt Coach never stores, logs or prints anything, and asks for consent first.

Two markers (ADR-009 v0.2 persistence rules):
- TASK_MARKER travels in the task text and in the assessor's evidence. Since PR #12 the user may
  opt in to "Save task text and AI responses": only then, and only in ``conversation_content``
  (and the owner's session read that returns it), may it be stored. Otherwise it is nowhere.
- COACH_MARKER travels only in what the fake Coach model returns (replacement, rewrite, open
  questions). It must never be stored, logged, printed or returned by a read endpoint, whatever
  the user's settings are, including conversation saving.
All 16 combinations of save, use, automatic coaching and conversation saving are covered.
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

TASK_MARKER = "ZXQ-TASK-MARKER"
COACH_MARKER = "ZXQ-COACH-MARKER"
MARKERS = (TASK_MARKER, COACH_MARKER)
TASK = f"Write a summary of the {TASK_MARKER} report for the board."
PLACEHOLDER = "[what must the result include?]"
MODES = ("tips", "edits", "rewrite")


class CountingCoach:
    """Fake Coach model: counts calls; its output carries COACH_MARKER (quote stays task text)."""

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
                    "quote": TASK_MARKER,
                    "replacement": f"{TASK_MARKER} {COACH_MARKER} quarterly",
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
            "rewrite": f"Write a summary of the {COACH_MARKER} report for the board. {PLACEHOLDER}",
            "open_questions": [f"Who reads the {COACH_MARKER} summary?"],
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
                value["evidence"] = f"Quoted from the task: {TASK_MARKER}"
        data["explanation"] = f"The task mentions {TASK_MARKER}."
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


def assert_privacy(app, caplog, capsys, *, conversations_saved=False):
    """COACH_MARKER is nowhere; TASK_MARKER only in conversation_content when opted in."""
    allowed = {"conversation_content"} if conversations_saved else set()
    for marker in MARKERS:
        tables = allowed if marker == TASK_MARKER else set()
        leaks = [
            (table, column)
            for table, column, text in database_text(app)
            if marker in text and table not in tables
        ]
        assert leaks == [], f"{marker} stored in {leaks}"
    # The database files themselves (main file and write-ahead log), byte for byte.
    database = Path(app.state.storage.path)
    file_markers = (COACH_MARKER,) if conversations_saved else MARKERS
    for path in (database, Path(f"{database}-wal"), Path(f"{database}-journal")):
        if path.exists():
            content = path.read_bytes()
            for marker in file_markers:
                assert marker.encode() not in content, f"{marker} in {path.name}"
    logged = [
        record.name
        for record in caplog.records
        if any(
            marker
            in " ".join(
                str(part)
                for part in (record.getMessage(), record.args, record.exc_text, record.stack_info)
            )
            for marker in MARKERS
        )
    ]
    assert logged == [], f"marker logged by {logged}"
    captured = capsys.readouterr()
    for marker in MARKERS:
        assert marker not in captured.out and marker not in captured.err


FLAGS = ("save_enabled", "use_enabled", "coaching_auto_enabled", "conversation_memory_enabled")
CONTEXT_STATES = [
    dict(zip(FLAGS, flags, strict=True)) for flags in itertools.product((False, True), repeat=4)
]


@pytest.mark.parametrize("use_personal_context", [None, False])
@pytest.mark.parametrize(
    "context", CONTEXT_STATES, ids=lambda state: "-".join(k for k, v in state.items() if v) or "off"
)
def test_coach_output_is_never_kept_and_task_text_only_with_consent(
    context, use_personal_context, caplog, capsys
):
    caplog.set_level(logging.DEBUG)  # root logger: every logger propagates here
    app = make_app()
    client = register(app)
    saved = client.put("/api/context", json={"content": "I write for executives.", **context})
    assert saved.status_code == 200
    extra = {} if use_personal_context is None else {"use_personal_context": False}
    analysis = analyse(client, **extra)
    # The marker really flows through the analysis response (so the checks are not vacuous).
    assert TASK_MARKER in str(analysis["profile"])
    saved_text = context["conversation_memory_enabled"]

    bodies = {}
    for mode in MODES:
        response = client.post(
            "/api/prompt-coach", json=coach_payload(analysis["id"], mode, allow_external=True)
        )
        assert response.status_code == 200, response.text
        bodies[mode] = response.json()
    assert CountingCoach.calls == ["groq"] * 3
    # The Coach output reaches the user in the edit, the rewrite and the open questions...
    edit = bodies["edits"]["suggestions"][0]
    assert edit["kind"] == "edit" and edit["quote"] == TASK_MARKER
    assert COACH_MARKER in edit["replacement"]
    assert COACH_MARKER in bodies["rewrite"]["rewrite"]
    assert COACH_MARKER in str(bodies["tips"]["open_questions"])
    # ...and never comes back through a read endpoint; the task only as an opted-in conversation.
    for path in ("/api/sessions", f"/api/sessions/{analysis['session_id']}", "/api/context"):
        text = client.get(path).text
        assert COACH_MARKER not in text
        task_allowed = saved_text and path == f"/api/sessions/{analysis['session_id']}"
        assert (TASK_MARKER in text) == task_allowed, path
    # A recorded choice updates saved memory; it must still carry no task text.
    choice = client.post(
        "/api/decisions",
        json={"analysis_id": analysis["id"], "candidate_id": analysis["recommendation"]["id"]},
    )
    assert choice.status_code == 200

    assert_privacy(app, caplog, capsys, conversations_saved=saved_text)


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
    assert_privacy(app, caplog, capsys)


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
