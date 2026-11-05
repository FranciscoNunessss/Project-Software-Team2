"""Optional chat module (ADR-011): chats, messages, settings and model tiers."""

from uuid import uuid4

import pytest
from app.chat import DEMO_ANSWER, MAX_HISTORY_CHARS, MAX_HISTORY_TURNS, history_for, title_from
from app.main import create_app
from app.providers import ProviderFailure, Settings
from fastapi.testclient import TestClient

pytestmark = pytest.mark.chat

ORIGIN = {"Origin": "http://127.0.0.1:8443"}
QUESTION = "Write a one-page summary of the report for the board."


class FakeChat:
    """Answers with the question it received; ``fail`` makes the next call fail."""

    seen: list[list[tuple[str, str]]] = []
    fail: str | None = None

    def __init__(self, provider, settings, model):
        self.provider, self.model = provider, model

    async def stream(self, messages):
        FakeChat.seen.append(messages)
        if FakeChat.fail:
            code, FakeChat.fail = FakeChat.fail, None
            yield "partial "
            raise ProviderFailure(code)
        yield "Answer to: "
        yield messages[-1][1]


@pytest.fixture(autouse=True)
def reset_fake():
    FakeChat.seen, FakeChat.fail = [], None


def build(factory=FakeChat):
    settings = Settings(_env_file=None, groq_api_key="test-key-not-real")
    return create_app(settings, chat_options={"model_factory": factory} if factory else None)


def register(app):
    client = TestClient(app, headers=ORIGIN)
    response = client.post(
        "/api/auth/register",
        json={"email": f"{uuid4()}@example.com", "password": "test-password-123"},
    )
    assert response.status_code == 201
    return client


def new_chat(client):
    response = client.post("/api/chats")
    assert response.status_code == 201
    return response.json()["id"]


def send(client, chat_id, content=QUESTION, **extra):
    body = {"content": content, "provider": "groq", "allow_external": True, **extra}
    return client.post(f"/api/chats/{chat_id}/messages", json=body)


def test_create_list_rename_and_delete_only_for_the_owner():
    app = build()
    alice, bob = register(app), register(app)
    chat_id = new_chat(alice)
    assert [item["id"] for item in alice.get("/api/chats").json()] == [chat_id]
    assert bob.get("/api/chats").json() == []
    for call in (
        bob.get(f"/api/chats/{chat_id}"),
        bob.patch(f"/api/chats/{chat_id}", json={"title": "Mine"}),
        bob.delete(f"/api/chats/{chat_id}"),
        send(bob, chat_id),
    ):
        assert call.status_code == 404
    renamed = alice.patch(f"/api/chats/{chat_id}", json={"title": "  Board summary  "})
    assert renamed.status_code == 200 and renamed.json()["title"] == "Board summary"
    assert alice.delete(f"/api/chats/{chat_id}").status_code == 204
    assert alice.get(f"/api/chats/{chat_id}").status_code == 404


def test_a_plain_session_is_not_a_chat():
    app = build()
    client = register(app)
    session = client.post("/api/sessions", json={}).json()
    assert client.get("/api/chats").json() == []
    assert client.get(f"/api/chats/{session['id']}").status_code == 404


def test_sending_stores_question_and_answer_and_titles_the_chat():
    app = build()
    client = register(app)
    chat_id = new_chat(client)
    response = send(client, chat_id)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"  # Message text is private.
    body = response.json()
    assert body["title"] == title_from(QUESTION)
    assert body["message"]["role"] == "user" and body["message"]["content"] == QUESTION
    assert body["answer"] == {
        **body["answer"],
        "role": "assistant",
        "content": f"Answer to: {QUESTION}",
        "provider": "groq",
        "status": "complete",
        "error": None,
    }
    stored = client.get(f"/api/chats/{chat_id}").json()
    assert [m["role"] for m in stored["messages"]] == ["user", "assistant"]
    assert stored["message_count"] == 2
    # A second message keeps the title and sends the history before it.
    send(client, chat_id, "And a shorter version?")
    assert client.get(f"/api/chats/{chat_id}").json()["title"] == title_from(QUESTION)
    assert FakeChat.seen[-1][0][0] == "system"
    assert [role for role, _ in FakeChat.seen[-1][1:]] == ["human", "ai", "human"]


def test_external_providers_need_consent_and_a_configured_provider():
    client = register(build())
    chat_id = new_chat(client)
    refused = send(client, chat_id, allow_external=False)
    assert refused.status_code == 403
    assert refused.json()["detail"] == "external_processing_requires_consent"
    assert send(client, chat_id, provider="openai").status_code == 409  # No OpenAI key.
    assert client.get(f"/api/chats/{chat_id}").json()["messages"] == []


def test_the_demonstration_provider_answers_with_a_fixed_note():
    client = register(build(factory=None))
    chat_id = new_chat(client)
    answer = send(client, chat_id, provider="demo", allow_external=False).json()["answer"]
    assert answer["content"] == DEMO_ANSWER and answer["status"] == "complete"


def test_a_provider_failure_is_stored_and_left_out_of_the_next_history():
    client = register(build())
    chat_id = new_chat(client)
    FakeChat.fail = "provider_rate_limit"
    failed = send(client, chat_id).json()["answer"]
    assert failed["status"] == "failed" and failed["error"] == "provider_rate_limit"
    send(client, chat_id, "Try again")
    sent_roles = [role for role, _ in FakeChat.seen[-1][1:]]
    assert sent_roles == ["human", "human"]  # The failed answer is not sent back.


def test_an_analysis_links_only_from_the_same_chat_and_user():
    app = build()
    alice, bob = register(app), register(app)
    chat_id = new_chat(alice)
    other_chat = new_chat(alice)
    analysis = alice.post(
        "/api/analyze", json={"task": QUESTION, "provider": "demo", "session_id": chat_id}
    )
    assert analysis.status_code == 200
    analysis_id = analysis.json()["id"]
    assert send(alice, other_chat, analysis_id=analysis_id).status_code == 404
    bob_chat = new_chat(bob)
    assert send(bob, bob_chat, analysis_id=analysis_id).status_code == 404
    linked = send(alice, chat_id, analysis_id=analysis_id).json()["message"]
    assert linked["analysis_id"] == analysis_id
    assert linked["completeness"] == analysis.json()["completeness"]


def test_deleting_a_chat_deletes_its_messages_and_analyses():
    app = build()
    client = register(app)
    chat_id = new_chat(client)
    client.post("/api/analyze", json={"task": QUESTION, "provider": "demo", "session_id": chat_id})
    send(client, chat_id)
    client.delete(f"/api/chats/{chat_id}")
    with app.state.storage.connect() as db:
        for table in ("chat_messages", "chat_sessions", "analyses"):
            assert db.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == 0


def test_always_analyse_is_off_by_default_and_per_user():
    app = build()
    alice, bob = register(app), register(app)
    assert alice.get("/api/chat/settings").json() == {"auto_analyse": False}
    assert alice.put("/api/chat/settings", json={"auto_analyse": True}).json() == {
        "auto_analyse": True
    }
    assert alice.get("/api/chat/settings").json() == {"auto_analyse": True}
    assert bob.get("/api/chat/settings").json() == {"auto_analyse": False}


def test_model_tiers_map_owned_configurations_to_catalogue_tiers():
    app = build()
    alice, bob = register(app), register(app)
    config = alice.post(
        "/api/llm-configs",
        json={"label": "Mine", "provider": "groq", "model": "m", "api_key": "test-key-not-real"},
    ).json()
    set_tier = alice.put(
        "/api/chat/model-tiers", json={"configuration_id": config["id"], "tier": "demo-advanced"}
    )
    assert set_tier.json() == [{"configuration_id": config["id"], "tier": "demo-advanced"}]
    alice.put(
        "/api/chat/model-tiers", json={"configuration_id": "server:groq", "tier": "demo-small"}
    )
    assert len(alice.get("/api/chat/model-tiers").json()) == 2
    assert (
        alice.put(
            "/api/chat/model-tiers", json={"configuration_id": config["id"], "tier": "huge"}
        ).status_code
        == 422
    )
    assert (
        bob.put(
            "/api/chat/model-tiers", json={"configuration_id": config["id"], "tier": "demo-small"}
        ).status_code
        == 404
    )
    cleared = alice.put(
        "/api/chat/model-tiers", json={"configuration_id": config["id"], "tier": None}
    )
    assert cleared.json() == [{"configuration_id": "server:groq", "tier": "demo-small"}]


def test_history_is_capped_and_starts_with_the_user():
    rows = []
    for index in range(MAX_HISTORY_TURNS + 5):
        rows.append({"role": "user", "content": f"q{index}", "status": "complete"})
        rows.append({"role": "assistant", "content": f"a{index}", "status": "complete"})
    kept = history_for(rows)
    assert len(kept) == MAX_HISTORY_TURNS * 2 and kept[0] == ("human", "q5")
    long = [
        {"role": "user", "content": "x" * (MAX_HISTORY_CHARS // 2), "status": "complete"},
        {"role": "assistant", "content": "y" * (MAX_HISTORY_CHARS // 2), "status": "complete"},
        {"role": "user", "content": "now", "status": "complete"},
    ]
    assert history_for(long) == [("human", "now")]  # Never starts with an assistant turn.


def test_message_validation():
    client = register(build())
    chat_id = new_chat(client)
    assert send(client, chat_id, "   ").status_code == 422
    assert send(client, chat_id, "x" * 8001).status_code == 422


def test_the_chat_is_mounted_after_the_core_routes_and_can_be_removed(monkeypatch):
    import sys

    import app.chat as module

    seen = []
    original = module.install_chat

    def recording(app, *args, **kwargs):
        seen.append(len(app.routes))
        return original(app, *args, **kwargs)

    monkeypatch.setattr(module, "install_chat", recording)
    installed = create_app(Settings(_env_file=None))
    monkeypatch.setitem(sys.modules, "app.chat", None)  # As if the file were deleted.
    without = create_app(Settings(_env_file=None))
    assert seen == [len(without.routes)]  # Mounted last, after the Prompt Coach too.
    assert TestClient(without).get("/api/features").json()["chat"] is False
    assert TestClient(installed).get("/api/features").json()["chat"] is True


def test_deleting_the_history_deletes_every_chat_message():
    app = build()
    client = register(app)
    send(client, new_chat(client))
    assert client.delete("/api/progress/history").status_code == 200
    assert client.get("/api/chats").json() == []
    with app.state.storage.connect() as db:
        assert db.execute("SELECT count(*) FROM chat_messages").fetchone()[0] == 0
