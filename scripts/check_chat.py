"""Explicit opt-in live smoke test of the optional chat (ADR-011). May consume provider quota.

By default it runs the app in-process over a throwaway database and account, like
check_llm.py, and needs no server. With --url it talks to a running backend instead, which
also checks Stop over a real connection (in-process responses are read whole).

    uv run python scripts/check_chat.py                    # Groq from .env
    uv run python scripts/check_chat.py --provider demo    # no key needed
    uv run python scripts/check_chat.py --url http://127.0.0.1:8000
"""

import argparse
import json
import secrets
import sys
import tempfile
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.main import create_app  # noqa: E402
from app.providers import Settings  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

STREAM = {"Accept": "text/event-stream"}


class Failed(Exception):
    pass


def check(label: str, condition: bool, detail: str = "") -> None:
    print(("  ok    " if condition else "  FAIL  ") + label + (f"  ({detail})" if detail else ""))
    if not condition:
        raise Failed(label)


def events(response, stop_after: int | None = None):
    """SSE events as they arrive; with stop_after, return early (the client's Stop)."""
    name, deltas = None, 0
    for line in response.iter_lines():
        if line.startswith("event: "):
            name = line.removeprefix("event: ")
        elif line.startswith("data: "):
            yield name, json.loads(line.removeprefix("data: "))
            deltas += name == "delta"
            if stop_after and deltas >= stop_after:
                return


def register(client: httpx.Client) -> None:
    response = client.post(
        "/api/auth/register",
        json={
            "email": f"check-chat-{secrets.token_hex(4)}@example.com",
            "password": secrets.token_hex(12),
        },
    )
    check("throwaway account", response.status_code == 201, str(response.status_code))


def run(client: httpx.Client, provider: str, live: bool, other: httpx.Client) -> None:
    external = provider != "demo"
    send = {"provider": provider, "allow_external": external}
    register(client)
    check("chat module installed", client.get("/api/features").json().get("chat") is True)
    chat_id = client.post("/api/chats").json()["id"]

    print("1. Streamed answer")
    question = {"content": "Explain in three short sentences what an API is.", **send}
    with client.stream(
        "POST", f"/api/chats/{chat_id}/messages", json=question, headers=STREAM
    ) as response:
        check("event stream", response.status_code == 200, str(response.status_code))
        seen = list(events(response))
    names = [name for name, _ in seen]
    summary = f"message, {names.count('delta')} deltas, {names[-1]}"
    check("message, deltas, done", names[0] == "message" and names[-1] == "done", summary)
    answer = seen[-1][1]["answer"]
    check("answer complete", answer["status"] == "complete", answer["error"] or "")
    print("        " + answer["content"][:160].replace("\n", " "))
    check("title from the first message", seen[-1][1]["title"].startswith("Explain"))

    if live and external:
        print("2. Stop over a real connection, then Retry")
        long = {"content": "Write a long paragraph about the history of the web.", **send}
        with client.stream(
            "POST", f"/api/chats/{chat_id}/messages", json=long, headers=STREAM
        ) as response:
            list(events(response, stop_after=2))
        last = client.get(f"/api/chats/{chat_id}").json()["messages"][-1]
        check("partial text kept as stopped", last["status"] == "stopped", repr(last["content"]))
        count = len(client.get(f"/api/chats/{chat_id}").json()["messages"])
        retry = client.post(f"/api/chats/{chat_id}/messages/{last['id']}/retry", json=send)
        check("retry completes", retry.json()["answer"]["status"] == "complete")
        check(
            "retry replaces the answer",
            len(client.get(f"/api/chats/{chat_id}").json()["messages"]) == count,
        )
    else:
        print("2. Stop and Retry: skipped (needs --url and a real provider)")

    print("3. Analyse, then send with the analysis")
    task = "Write a one-page summary of the report for the board."
    analysis = client.post("/api/analyze", json={"task": task, "session_id": chat_id, **send})
    detail = "" if analysis.status_code == 200 else analysis.json().get("detail", "")
    check(
        "analysis in this chat",
        analysis.status_code == 200,
        f"{analysis.status_code} {detail}".strip(),
    )
    sent = client.post(
        f"/api/chats/{chat_id}/messages",
        json={"content": task, "analysis_id": analysis.json()["id"], **send},
    ).json()
    check("message linked", sent["message"]["analysis_id"] == analysis.json()["id"])
    check(
        "message shows the completeness",
        sent["message"]["completeness"] == analysis.json()["completeness"],
        str(sent["message"]["completeness"]),
    )

    print("4. Privacy")
    check("no-store", client.get("/api/chats").headers.get("cache-control") == "no-store")
    register(other)
    check("another user gets 404", other.get(f"/api/chats/{chat_id}").status_code == 404)
    check("delete", client.delete(f"/api/chats/{chat_id}").status_code == 204)
    check("deleted", client.get(f"/api/chats/{chat_id}").status_code == 404)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--provider", choices=["groq", "openai", "claude", "ollama", "demo"], default="groq"
    )
    parser.add_argument("--url", help="a running backend, e.g. http://127.0.0.1:8000")
    args = parser.parse_args()
    try:
        if args.url:
            with httpx.Client(base_url=args.url, timeout=90) as client:
                with httpx.Client(base_url=args.url, timeout=30) as other:
                    run(client, args.provider, True, other)
        else:
            with tempfile.TemporaryDirectory() as directory:
                settings = Settings(database_path=str(Path(directory) / "check.sqlite3"))
                app = create_app(settings)
                run(TestClient(app), args.provider, False, TestClient(app))
    except Failed:
        return 1
    except httpx.ConnectError:
        print(f"  FAIL  no backend at {args.url}")
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
