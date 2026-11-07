"""Explicit opt-in live smoke test. Uses a synthetic task; may consume provider quota."""

import argparse
import json
import secrets
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.main import create_app  # noqa: E402
from app.providers import Settings  # noqa: E402
from app.storage import temporary_database  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--provider", choices=["groq", "openai", "claude", "ollama"], default="groq"
    )
    args = parser.parse_args()
    # /api/analyze requires an account: use a throwaway database and account, never the
    # local one, so the smoke test leaves no history behind.
    with (
        tempfile.TemporaryDirectory() as directory,
        temporary_database(
            Settings(credentials_key_path=str(Path(directory) / "check.key"))
        ) as settings,
    ):
        client = TestClient(create_app(settings))
        client.post(
            "/api/auth/register",
            json={
                "email": f"check-{secrets.token_hex(4)}@example.com",
                "password": secrets.token_hex(12),
            },
        )
        return run(client, args.provider)


def run(client: TestClient, provider: str) -> int:
    response = client.post(
        "/api/analyze",
        json={
            "task": "Compare two API designs for a small library catalogue. Explain trade-offs.",
            "provider": provider,
            "allow_external": True,
        },
    )
    if response.status_code != 200:
        print(
            json.dumps(
                {
                    "status": "failed",
                    "http_status": response.status_code,
                    "error": response.json().get("detail", "request_failed"),
                }
            )
        )
        return 1
    result = response.json()
    print(
        json.dumps(
            {
                key: result[key]
                for key in (
                    "mode",
                    "provider",
                    "assessment_model",
                    "latency_ms",
                    "usage",
                )
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
