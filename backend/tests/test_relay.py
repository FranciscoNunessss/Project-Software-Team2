"""The relay (ADR-015): a personal LM Studio model run by its owner's client, through the backend.

A fake client (a thread) plays the VS Code extension: it takes requests from
``/api/relay/next`` and answers them on ``/api/relay/jobs/{id}/events`` the way LM Studio would.
The backend is the real one, with the real OpenAI client, so streaming, errors and ownership are
tested end to end.
"""

import base64
import json
import threading
import time

import pytest
from app.main import create_app
from app.providers import Settings
from app.relay import BROKER
from fastapi.testclient import TestClient

PASSWORD = "test-password-123"


@pytest.fixture(autouse=True)
def fresh_broker():
    BROKER.reset()
    yield
    BROKER.reset()


@pytest.fixture
def app():
    return create_app(Settings(_env_file=None, timeout_seconds=3))


@pytest.fixture
def client(app):
    # One client, and so one event loop, for the whole test: the relay's waits live in its loop.
    with TestClient(app) as test_client:
        yield test_client


def user(client, email):
    """Registers an account; returns the Bearer headers of a personal token."""
    client.cookies.clear()
    assert (
        client.post("/api/auth/register", json={"email": email, "password": PASSWORD}).status_code
        == 201
    )
    token = client.post("/api/tokens", json={"name": "test"}).json()["token"]
    client.cookies.clear()
    return {"Authorization": f"Bearer {token}"}


def add_model(client, headers, **extra):
    body = {
        "label": "LM Studio",
        "provider": "lmstudio",
        "model": "my-local-model",
        "execution": "client",
        **extra,
    }
    response = client.post("/api/llm-configs", json=body, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


def sse(*pieces):
    lines = []
    for piece in pieces:
        delta = {"index": 0, "delta": {"content": piece}, "finish_reason": None}
        chunk = {"id": "c", "object": "chat.completion.chunk", "choices": [delta]}
        lines.append("data: " + json.dumps(chunk) + "\n\n")
    stop = {"index": 0, "delta": {}, "finish_reason": "stop"}
    lines.append("data: " + json.dumps({"id": "c", "choices": [stop]}) + "\n\n")
    lines.append("data: [DONE]\n\n")
    return lines


def stream_events(*pieces):
    events = [{"type": "start", "status": 200, "content_type": "text/event-stream"}]
    for line in sse(*pieces):
        events.append({"type": "chunk", "data": base64.b64encode(line.encode()).decode()})
    return [*events, {"type": "end"}]


def completion_events(text):
    body = {
        "id": "c",
        "object": "chat.completion",
        "choices": [
            {"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}
        ],
    }
    return [
        {"type": "start", "status": 200, "content_type": "application/json"},
        {"type": "chunk", "data": base64.b64encode(json.dumps(body).encode()).decode()},
        {"type": "end"},
    ]


class Agent:
    """The extension, as far as the backend can tell: it asks for work and answers it."""

    def __init__(self, client, headers, reply):
        self.client, self.headers, self.reply = client, headers, reply
        self.seen = []
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self):
        while not self.stop.is_set():
            response = self.client.get("/api/relay/next?wait=1", headers=self.headers)
            if response.status_code != 200:
                continue
            job = response.json()
            self.seen.append(job)
            events = self.reply(job)
            if events:
                self.client.post(
                    f"/api/relay/jobs/{job['id']}/events",
                    json={"events": events},
                    headers=self.headers,
                )

    def __enter__(self):
        self.thread.start()
        deadline = time.monotonic() + 5
        while not self.client.get("/api/relay/status", headers=self.headers).json()["connected"]:
            assert time.monotonic() < deadline
            time.sleep(0.05)
        return self

    def __exit__(self, *_):
        self.stop.set()
        self.thread.join(timeout=5)


def send(client, headers, configuration_id, content="Hello there"):
    chat = client.post("/api/chats", headers=headers).json()["id"]
    response = client.post(
        f"/api/chats/{chat}/messages",
        json={"content": content, "provider": "lmstudio", "configuration_id": configuration_id},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()["answer"]


def request_of(job):
    return json.loads(base64.b64decode(job["body"]))


# -- the setting ----------------------------------------------------------------------------------


def test_a_configuration_runs_on_the_server_unless_it_is_set_to_the_client(client):
    headers = user(client, "alice@example.com")
    default = client.post(
        "/api/llm-configs",
        json={"label": "L", "provider": "lmstudio", "model": "m"},
        headers=headers,
    ).json()
    assert default["execution"] == "server"
    assert add_model(client, headers)["execution"] == "client"
    listed = client.get("/api/llm-configs", headers=headers).json()
    assert sorted(item["execution"] for item in listed) == ["client", "server"]


def test_only_lm_studio_can_run_on_the_client(client):
    headers = user(client, "alice@example.com")
    response = client.post(
        "/api/llm-configs",
        json={
            "label": "G",
            "provider": "groq",
            "model": "m",
            "api_key": "k",
            "execution": "client",
        },
        headers=headers,
    )
    assert response.status_code == 422
    response = client.post(
        "/api/llm-configs",
        json={"label": "L", "provider": "lmstudio", "model": "m", "execution": "somewhere"},
        headers=headers,
    )
    assert response.status_code == 422


def test_the_setting_can_be_changed_back(client):
    headers = user(client, "alice@example.com")
    created = add_model(client, headers)
    body = {"label": "L", "provider": "lmstudio", "model": "m", "execution": "server"}
    updated = client.put(f"/api/llm-configs/{created['id']}", json=body, headers=headers).json()
    assert updated["execution"] == "server"


# -- the client side ------------------------------------------------------------------------------


def test_the_client_is_connected_while_it_asks_for_work(client):
    headers = user(client, "alice@example.com")
    assert client.get("/api/relay/status", headers=headers).json() == {"connected": False}
    assert client.get("/api/relay/next?wait=0", headers=headers).status_code == 204
    assert client.get("/api/relay/status", headers=headers).json() == {"connected": True}
    assert client.get("/api/relay/status", headers=headers).headers["cache-control"] == "no-store"


def test_the_relay_needs_a_signed_in_user(client):
    client.cookies.clear()
    assert client.get("/api/relay/status").status_code == 401
    assert client.get("/api/relay/next?wait=0").status_code == 401
    assert (
        client.post("/api/relay/jobs/x/events", json={"events": [{"type": "end"}]}).status_code
        == 401
    )


# -- the model on the client ----------------------------------------------------------------------


@pytest.mark.chat
def test_a_chat_answer_comes_from_the_model_on_the_client(client):
    headers = user(client, "alice@example.com")
    config = add_model(client, headers)
    with Agent(
        client, headers, lambda job: stream_events("Hello ", "from ", "my LM Studio")
    ) as agent:
        answer = send(client, headers, config["id"], "Say hello")
    assert answer["status"] == "complete" and answer["error"] is None
    assert answer["content"] == "Hello from my LM Studio"
    request = request_of(agent.seen[0])
    assert agent.seen[0]["path"] == "/v1/chat/completions" and agent.seen[0]["method"] == "POST"
    assert request["model"] == "my-local-model" and request["stream"] is True
    assert request["messages"][-1] == {"role": "user", "content": "Say hello"}
    assert "authorization" not in {key.lower() for key in agent.seen[0]}


def test_a_structured_call_goes_through_the_client_too(app, client):
    from app.providers import chat_model

    headers = user(client, "alice@example.com")
    config = add_model(client, headers)
    from app.llm_config import ModelConfigurations

    configurations = ModelConfigurations(app.state.storage, app.state.settings)
    row = configurations.owned(
        client.get("/api/auth/me", headers=headers).json()["id"], config["id"]
    )
    settings = configurations.configured_settings(row)
    assert settings.lmstudio_relay_user == row["user_id"]
    import asyncio

    with Agent(client, headers, lambda job: completion_events("Plain answer")):
        model = chat_model("lmstudio", settings, 100)
        # The test runs outside the app's loop; the broker only needs the agent's polling to work.
        reply = asyncio.run(model.ainvoke([("human", "Hi")]))
    assert reply.content == "Plain answer"


@pytest.mark.chat
def test_without_a_client_the_request_fails_at_once_and_says_why(client):
    headers = user(client, "alice@example.com")
    config = add_model(client, headers)
    answer = send(client, headers, config["id"])
    assert (
        BROKER._jobs == {}
    )  # no request was queued: nothing waited for a client that is not there
    assert answer["status"] == "failed" and answer["error"] == "relay_unavailable"
    assert answer["content"] == ""


@pytest.mark.chat
def test_a_server_configuration_never_uses_the_relay(client):
    headers = user(client, "alice@example.com")
    config = add_model(client, headers, execution="server")
    with Agent(client, headers, lambda job: stream_events("never")) as agent:
        answer = send(client, headers, config["id"])
    assert agent.seen == []
    assert answer["error"] != "relay_unavailable"  # it tried LM Studio on the server's localhost


@pytest.mark.chat
def test_a_client_that_takes_a_request_and_never_answers_ends_with_a_timeout(client):
    headers = user(client, "alice@example.com")
    config = add_model(client, headers)
    with Agent(client, headers, lambda job: [{"type": "ack"}]):
        answer = send(client, headers, config["id"])
    assert answer["status"] == "failed" and answer["error"] == "relay_timeout"


@pytest.mark.chat
def test_a_request_nobody_confirms_goes_back_in_the_queue_and_then_fails(client, monkeypatch):
    import app.relay as relay

    monkeypatch.setattr(relay, "ACK_SECONDS", 0.3)
    monkeypatch.setattr(relay, "PICKUP_SECONDS", 3.0)
    headers = user(client, "alice@example.com")
    config = add_model(client, headers)
    with Agent(client, headers, lambda job: None) as agent:  # takes requests, never confirms
        answer = send(client, headers, config["id"])
    assert len(agent.seen) >= 2  # it was offered again after the first one went unconfirmed
    assert answer["status"] == "failed" and answer["error"] == "relay_unavailable"


@pytest.mark.chat
def test_an_error_from_the_client_is_the_error_of_the_request(client):
    headers = user(client, "alice@example.com")
    config = add_model(client, headers)
    with Agent(client, headers, lambda job: [{"type": "error", "code": "relay_client_error"}]):
        answer = send(client, headers, config["id"])
    assert answer["status"] == "failed" and answer["error"] == "relay_client_error"


@pytest.mark.chat
def test_a_model_that_answers_with_an_error_status_is_a_provider_error(client):
    headers = user(client, "alice@example.com")
    config = add_model(client, headers)
    events = [
        {"type": "start", "status": 404, "content_type": "application/json"},
        {"type": "chunk", "data": base64.b64encode(b'{"error":{"message":"no model"}}').decode()},
        {"type": "end"},
    ]
    with Agent(client, headers, lambda job: events):
        answer = send(client, headers, config["id"])
    assert answer["status"] == "failed" and answer["error"] == "provider_model_unavailable"


# -- ownership and limits -------------------------------------------------------------------------


@pytest.mark.chat
def test_a_request_is_only_ever_given_to_the_client_of_the_same_account(client):
    alice = user(client, "alice@example.com")
    bob = user(client, "bob@example.com")
    config = add_model(client, alice)
    # Bob's client is connected, Alice's is not: Alice's request must fail, not go to Bob.
    with Agent(client, bob, lambda job: stream_events("Bob's model")) as bobs:
        answer = send(client, alice, config["id"])
    assert answer["error"] == "relay_unavailable"
    assert bobs.seen == []


@pytest.mark.chat
def test_a_client_cannot_answer_a_job_of_another_account(client):
    alice = user(client, "alice@example.com")
    bob = user(client, "bob@example.com")
    config = add_model(client, alice)
    seen = {}

    def reply(job):
        seen["id"] = job["id"]
        # Bob tries to answer Alice's job while Alice's client is still working on it.
        seen["status"] = client.post(
            f"/api/relay/jobs/{job['id']}/events",
            json={"events": stream_events("forged")},
            headers=bob,
        ).status_code
        return stream_events("genuine")

    with Agent(client, alice, reply):
        answer = send(client, alice, config["id"])
    assert seen["status"] == 404
    assert answer["content"] == "genuine"
    missing = client.post(
        "/api/relay/jobs/does-not-exist/events", json={"events": [{"type": "end"}]}, headers=bob
    )
    assert missing.status_code == 404


def test_the_events_of_a_client_are_checked(client):
    headers = user(client, "alice@example.com")
    post = lambda events: client.post(  # noqa: E731
        "/api/relay/jobs/x/events", json={"events": events}, headers=headers
    )
    assert post([]).status_code == 422
    assert post([{"type": "chunk", "data": "not base64!"}]).status_code in {404, 422}
    assert post([{"type": "start"}]).status_code == 422
    assert post([{"type": "unknown"}]).status_code == 422
    assert post([{"type": "error", "code": "Not A Code!"}]).status_code == 422
    too_big = base64.b64encode(b"x" * 300_000).decode()
    assert post([{"type": "chunk", "data": too_big}]).status_code in {413, 422}


def test_only_the_chat_completions_path_is_relayed():
    import asyncio

    import httpx
    from app.relay import RelayError, RelayTransport

    async def call(method, url):
        transport = RelayTransport("someone")
        return await transport.handle_async_request(httpx.Request(method, url, content=b"{}"))

    for method, url in [
        ("POST", "http://relay.invalid/v1/models"),
        ("GET", "http://relay.invalid/v1/chat/completions"),
        ("POST", "http://relay.invalid/admin"),
    ]:
        with pytest.raises(RelayError) as caught:
            asyncio.run(call(method, url))
        assert caught.value.code == "relay_path_not_allowed"


def test_too_many_requests_in_flight_are_refused():
    from app.relay import MAX_JOBS_PER_USER, Broker, RelayError

    broker = Broker()
    broker._seen["u"] = time.monotonic()
    for _ in range(MAX_JOBS_PER_USER):
        broker.submit("u", {"body": ""})
    with pytest.raises(RelayError) as caught:
        broker.submit("u", {"body": ""})
    assert caught.value.code == "relay_busy"
    assert Broker().connected("nobody") is False


def test_a_response_larger_than_the_limit_ends_the_request():
    from app.relay import MAX_CHUNK_BYTES, MAX_RESPONSE_BYTES, Broker

    broker = Broker()
    broker._seen["u"] = time.monotonic()
    job = broker.submit("u", {"body": ""})
    chunk = {"type": "chunk", "data": b"x" * MAX_CHUNK_BYTES}
    broker.answer("u", job.id, [chunk] * (MAX_RESPONSE_BYTES // MAX_CHUNK_BYTES + 2))
    codes = []
    while not job.events.empty():
        event = job.events.get_nowait()
        if event["type"] == "error":
            codes.append(event["code"])
    assert codes == ["relay_response_too_large"] and job.finished


def test_a_poll_that_was_hung_up_on_is_given_no_job():
    import asyncio

    from app.relay import Broker

    async def run():
        broker = Broker()
        broker._seen["u"] = time.monotonic()
        broker.submit("u", {"body": ""})

        async def hung_up():
            return True

        assert await broker.next_job("u", 5, hung_up) is None
        assert len(broker._pending["u"]) == 1  # the job is still waiting for a client that is there
        return (await broker.next_job("u", 0)) is not None

    assert asyncio.run(run())


def test_a_client_is_connected_while_a_request_of_its_is_open_and_briefly_after():
    import asyncio

    from app.relay import CLIENT_GRACE_SECONDS, Broker

    async def run():
        broker = Broker()
        assert broker.connected("u") is False
        task = asyncio.create_task(broker.next_job("u", 0.6))
        await asyncio.sleep(0.2)
        during = broker.connected("u")
        await task
        right_after = broker.connected("u")
        broker._seen["u"] = time.monotonic() - CLIENT_GRACE_SECONDS - 1
        later = broker.connected("u")
        return during, right_after, later, broker._polls["u"]

    assert asyncio.run(run()) == (True, True, False, 0)


def test_a_request_taken_by_a_dead_poll_is_given_to_the_next_one(monkeypatch):
    import asyncio

    import app.relay as relay
    from app.relay import Broker

    monkeypatch.setattr(relay, "ACK_SECONDS", 0.2)

    async def run():
        broker = Broker()
        broker._seen["u"] = time.monotonic()
        job = broker.submit("u", {"body": ""})
        waiter = asyncio.create_task(broker.wait_for_start(job, 5))
        taken = await broker.next_job("u", 1)  # a poll that nobody is listening to any more
        assert taken is job and job.attempts == 1
        await asyncio.sleep(0.4)
        again = await broker.next_job("u", 1)  # the live client's poll
        assert again is job and job.attempts == 2
        broker.answer("u", job.id, [{"type": "start", "status": 200, "content_type": None}])
        return (await waiter)["status"]

    assert asyncio.run(run()) == 200
