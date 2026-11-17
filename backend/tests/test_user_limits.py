"""Per-user limits on the shared hosted models (app/quotas.py).

The point: one person must not use the whole free quota of the project, and a person who brings
their own key, or uses a local or demonstration model, must never be limited by it.
"""

from uuid import uuid4

import pytest
from app import quotas
from app.main import create_app
from app.models import Assessment, Profile
from app.providers import Settings
from fastapi.testclient import TestClient
from profile_samples import profile_data

ORIGIN = {"Origin": "http://127.0.0.1:8443"}


class FakeProvider:
    async def assess(self, task):
        return Assessment(profile=Profile.model_validate(profile_data()))


class FakeChat:
    def __init__(self, provider, settings, model):
        self.provider, self.model = provider, model

    async def stream(self, messages):
        yield "ok"


def settings(**limits):
    base = {
        "user_analyses_per_minute": 0,
        "user_analyses_per_day": 0,
        "user_messages_per_minute": 0,
        "user_messages_per_day": 0,
    }
    return Settings(_env_file=None, groq_api_key="synthetic", **{**base, **limits})


def person(app):
    client = TestClient(app, headers=ORIGIN)
    response = client.post(
        "/api/auth/register",
        json={"email": f"{uuid4()}@example.com", "password": "test-password-123"},
    )
    assert response.status_code == 201
    return client


def analyse(client, **extra):
    body = {"task": "Plan a trip", "provider": "auto", "allow_external": True, **extra}
    return client.post("/api/analyze", json=body)


def app_with(**limits):
    return create_app(
        settings(**limits), {"groq": FakeProvider()}, chat_options={"model_factory": FakeChat}
    )


def test_per_minute_window_blocks_the_next_call_and_frees_up_later():
    store, config = object(), settings(user_analyses_per_minute=2)
    quotas.enforce(store, config, "u", "analysis", now=100.0)
    quotas.enforce(store, config, "u", "analysis", now=110.0)
    with pytest.raises(Exception) as caught:
        quotas.enforce(store, config, "u", "analysis", now=120.0)
    assert caught.value.status_code == 429 and caught.value.detail == "user_rate_limit"
    assert caught.value.headers["Retry-After"] == "41"
    quotas.enforce(store, config, "u", "analysis", now=161.0)


def test_a_limit_of_zero_is_no_limit_and_people_do_not_share_a_window():
    store, config = object(), settings()
    for second in range(50):
        quotas.enforce(store, config, "u", "analysis", now=float(second))
    config = settings(user_analyses_per_minute=1)
    quotas.enforce(store, config, "a", "analysis", now=1.0)
    quotas.enforce(store, config, "b", "analysis", now=1.0)


def test_analyses_on_the_shared_model_stop_at_the_minute_limit():
    client = person(app_with(user_analyses_per_minute=2))
    assert analyse(client).status_code == 200
    assert analyse(client).status_code == 200
    blocked = analyse(client)
    assert blocked.status_code == 429
    assert blocked.json()["detail"] == "user_rate_limit"
    assert int(blocked.headers["Retry-After"]) >= 1


def test_another_person_is_not_limited_by_this_persons_use():
    app = app_with(user_analyses_per_minute=1)
    first, second = person(app), person(app)
    assert analyse(first).status_code == 200
    assert analyse(first).status_code == 429
    assert analyse(second).status_code == 200


def test_the_daily_limit_counts_stored_analyses_and_ignores_older_ones():
    app = app_with(user_analyses_per_day=2)
    client = person(app)
    assert analyse(client).status_code == 200
    assert analyse(client).status_code == 200
    blocked = analyse(client)
    assert blocked.status_code == 429 and blocked.json()["detail"] == "analysis_daily_limit"
    # Yesterday's analyses do not count: age them by two days.
    with app.state.storage.connect() as db:
        db.execute("UPDATE analyses SET created_at='2020-01-01T00:00:00.000Z'")
    assert analyse(client).status_code == 200


def test_a_refused_analysis_leaves_no_session_behind():
    app = app_with(user_analyses_per_minute=1)
    client = person(app)
    assert analyse(client).status_code == 200
    assert analyse(client).status_code == 429
    assert len(client.get("/api/sessions").json()) == 1


def test_a_person_with_their_own_key_is_never_limited():
    client = person(app_with(user_analyses_per_minute=1, user_analyses_per_day=1))
    created = client.post(
        "/api/llm-configs",
        json={
            "label": "My Groq",
            "provider": "groq",
            "model": "openai/gpt-oss-20b",
            "api_key": "gsk_personal_key_that_is_not_real",
            "enabled": True,
            "is_default": False,
        },
    )
    assert created.status_code in (200, 201), created.text
    own = created.json()["id"]
    for _ in range(3):
        result = analyse(client, configuration_id=own)
        assert result.status_code != 429, result.text


def test_the_demonstration_model_is_never_limited():
    client = person(app_with(user_analyses_per_minute=1, user_analyses_per_day=1))
    for _ in range(3):
        result = client.post("/api/analyze", json={"task": "Plan a trip", "provider": "demo"})
        assert result.status_code != 429, result.text


@pytest.mark.chat
def test_chat_answers_stop_at_their_own_limits_separately_from_analyses():
    client = person(app_with(user_messages_per_minute=2))
    chat = client.post("/api/chats").json()["id"]

    def send():
        body = {"content": "Hello there", "provider": "groq", "allow_external": True}
        return client.post(f"/api/chats/{chat}/messages", json=body)

    assert send().status_code == 200
    assert send().status_code == 200
    blocked = send()
    assert blocked.status_code == 429 and blocked.json()["detail"] == "user_rate_limit"
    # The analysis budget is separate and untouched.
    assert analyse(client).status_code == 200


@pytest.mark.chat
def test_the_daily_chat_limit_counts_stored_answers():
    app = app_with(user_messages_per_day=2)
    client = person(app)
    chat = client.post("/api/chats").json()["id"]
    body = {"content": "Hello there", "provider": "groq", "allow_external": True}
    assert client.post(f"/api/chats/{chat}/messages", json=body).status_code == 200
    assert client.post(f"/api/chats/{chat}/messages", json=body).status_code == 200
    blocked = client.post(f"/api/chats/{chat}/messages", json=body)
    assert blocked.status_code == 429 and blocked.json()["detail"] == "message_daily_limit"
