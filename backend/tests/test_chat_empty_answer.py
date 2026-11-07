"""A model that ends without any text is a failed answer, not a complete one (ADR-011)."""

from uuid import uuid4

import pytest
from app.main import create_app
from app.providers import Settings
from fastapi.testclient import TestClient

pytestmark = pytest.mark.chat

ORIGIN = {"Origin": "http://127.0.0.1:8443"}


class Silent:
    """Streams nothing (or only whitespace) at first, then answers normally."""

    outputs: list[list[str]] = []

    def __init__(self, provider, settings, model):
        pass

    async def stream(self, messages):
        for part in Silent.outputs.pop(0):
            yield part


def build():
    app = create_app(
        Settings(_env_file=None, groq_api_key="test-key"), chat_options={"model_factory": Silent}
    )
    client = TestClient(app, headers=ORIGIN)
    client.post(
        "/api/auth/register",
        json={"email": f"{uuid4()}@example.com", "password": "test-password-123"},
    )
    return client, client.post("/api/chats").json()["id"]


@pytest.mark.parametrize("silent", [[], ["", ""], ["  ", "\n"]])
def test_empty_answer_is_failed_and_can_be_retried(silent):
    Silent.outputs = [silent, ["Now there is text."]]
    client, chat = build()
    path = f"/api/chats/{chat}/messages"
    answer = client.post(
        path, json={"content": "Hello", "provider": "groq", "allow_external": True}
    )
    assert answer.status_code == 200
    body = answer.json()["answer"]
    assert (body["status"], body["error"], body["content"]) == (
        "failed",
        "empty_answer",
        "".join(silent),
    )

    retry = client.post(
        f"{path}/{body['id']}/retry", json={"provider": "groq", "allow_external": True}
    )
    assert retry.status_code == 200
    assert (retry.json()["answer"]["status"], retry.json()["answer"]["content"]) == (
        "complete",
        "Now there is text.",
    )


def test_empty_answer_is_reported_as_an_error_event_when_streaming():
    Silent.outputs = [[]]
    client, chat = build()
    with client.stream(
        "POST",
        f"/api/chats/{chat}/messages",
        headers={**ORIGIN, "Accept": "text/event-stream"},
        json={"content": "Hello", "provider": "groq", "allow_external": True},
    ) as response:
        text = "".join(response.iter_text())
    assert "event: error" in text and "empty_answer" in text and "event: done" in text
