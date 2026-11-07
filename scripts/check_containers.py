"""Smoke-test the built stack with synthetic data and demo models, without provider calls.

Use a disposable Compose project. Save --state-file outside the repository, recreate
the backend/frontend, then run --verify-only to check login and data persistence.
"""

import argparse
import http.cookiejar
import json
import re
import secrets
import urllib.error
import urllib.request
from pathlib import Path
from uuid import uuid4


class Client:
    def __init__(self, url):
        self.url = url.rstrip("/")
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
        )

    def open(self, path, body=None, *, headers=None):
        request_headers = {"Origin": self.url, **(headers or {})}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            request_headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.url + path, data=data, headers=request_headers)
        return self.opener.open(request, timeout=30)

    def json(self, path, body=None):
        with self.open(path, body) as response:
            result = json.load(response)
            if path != "/api/health":
                assert "no-store" in response.headers.get("Cache-Control", ""), path
            return result


def frontend(client):
    with client.open("/") as response:
        assert "text/html" in response.headers.get("Content-Type", "")
        html = response.read().decode()
    assets = re.findall(r'(?:src|href)="(/assets/[^" ]+)"', html)
    assert assets, "Compiled frontend assets missing"
    for asset in assets:
        with client.open(asset) as response:
            assert "immutable" in response.headers.get("Cache-Control", "")
            assert response.read(), "Empty asset"
    assert client.json("/api/health") == {"status": "ok"}
    try:
        client.open("/api/no-such-route")
    except urllib.error.HTTPError as exc:
        assert exc.code == 404 and "application/json" in exc.headers.get("Content-Type", "")
    else:
        raise AssertionError("Unknown API route fell back to the SPA")


def create(client):
    state = {"email": f"container-{uuid4().hex}@example.com", "password": secrets.token_hex(16)}
    with client.open("/api/auth/register", state) as response:
        assert response.status == 201
        assert "httponly" in response.headers.get("Set-Cookie", "").lower()
        state["user_id"] = json.load(response)["id"]
    try:
        client.open("/api/auth/logout", {}, headers={"Origin": "https://wrong-origin.example"})
    except urllib.error.HTTPError as exc:
        assert exc.code == 403
    else:
        raise AssertionError("Cross-origin cookie write was accepted")
    chat = client.json("/api/chats", {})
    state["chat_id"] = chat["id"]
    task = "Explain an API for a synthetic container smoke test."
    analysis = client.json(
        "/api/analyze", {"task": task, "provider": "demo", "session_id": chat["id"]}
    )
    state["analysis_id"] = analysis["id"]
    client.json(
        "/api/decisions",
        {
            "analysis_id": analysis["id"],
            "candidate_id": analysis["recommendation"]["id"],
        },
    )
    with client.open(
        f"/api/chats/{chat['id']}/messages",
        {
            "content": task,
            "provider": "demo",
            "analysis_id": analysis["id"],
        },
        headers={"Accept": "text/event-stream"},
    ) as response:
        assert response.headers.get_content_type() == "text/event-stream"
        assert "no-store" in response.headers.get("Cache-Control", "")
        events = []
        name = None
        for raw in response:
            line = raw.decode().strip()
            if line.startswith("event: "):
                name = line[7:]
            elif line.startswith("data: "):
                events.append((name, json.loads(line[6:])))
        names = [name for name, _ in events]
        assert names[0] == "message" and "delta" in names and names[-1] == "done"
        assert events[-1][1]["answer"]["status"] == "complete"
    configuration = client.json(
        "/api/llm-configs",
        {
            "label": "Container smoke (synthetic)",
            "provider": "openai",
            "model": "synthetic-model",
            "api_key": "synthetic-container-key",
            "enabled": False,
        },
    )
    assert configuration["has_key"] and "api_key" not in configuration
    state["configuration_id"] = configuration["id"]
    return state


def verify(client, state):
    assert client.json("/api/auth/me")["id"] == state["user_id"]
    chat = client.json(f"/api/chats/{state['chat_id']}")
    assert len(chat["messages"]) == 2 and chat["messages"][-1]["status"] == "complete"
    session = client.json(f"/api/sessions/{state['chat_id']}")
    assert session["analyses"][0]["result"]["id"] == state["analysis_id"]
    progress = client.json("/api/progress")
    assert progress["analyses"] == 1 and progress["choices"] == 1
    assert any(
        item["id"] == state["configuration_id"] and item["has_key"]
        for item in client.json("/api/llm-configs")
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8080")
    parser.add_argument("--state-file", type=Path, required=True)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    client = Client(args.url)
    frontend(client)
    if args.verify_only:
        state = json.loads(args.state_file.read_text(encoding="utf-8"))
        client.json("/api/auth/login", {key: state[key] for key in ("email", "password")})
    else:
        state = create(client)
        with args.state_file.open("x", encoding="utf-8") as output:
            json.dump(state, output)
    verify(client, state)
    print("Container smoke passed: assets, proxy, cookies, CSRF, analysis, SSE and saved data.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
