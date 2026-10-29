"""Explicit live coaching smoke test; synthetic metadata only, consumes Groq quota."""

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.coaching import GroqCoach  # noqa: E402
from app.providers import ProviderFailure, Settings  # noqa: E402


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", required=True)
    parser.parse_args()
    settings = Settings()
    if not settings.groq_model or not settings.groq_api_key.get_secret_value():
        print(json.dumps({"status": "failed", "error": "project_default_not_configured"}))
        return 1
    metadata = {
        "sample_size": 3,
        "sample_limit": 50,
        "assessments": [
            {
                "mode": "semantic",
                "profile": {"reasoning": {"score": 2, "confidence": "medium"}},
                "recommended_capacity": 2,
                "chosen_capacity": chosen,
            }
            for chosen in (3, 2, None)
        ],
    }
    try:
        report = await GroqCoach(settings).generate(metadata)
    except ProviderFailure as exc:
        print(json.dumps({"status": "failed", "error": exc.code}))
        return 1
    print(
        json.dumps(
            {
                "status": "ok",
                "model": settings.groq_model,
                "suggestions": len(report.suggestions),
                "input": "synthetic metadata",
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
