"""Explicit opt-in live smoke test. Uses a synthetic task; may consume provider quota."""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.main import create_app  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=["groq", "openai", "ollama"], default="groq")
    args = parser.parse_args()
    client = TestClient(create_app())
    response = client.post(
        "/api/analyze",
        json={
            "task": "Compare two API designs for a small library catalogue. Explain trade-offs.",
            "provider": args.provider,
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
