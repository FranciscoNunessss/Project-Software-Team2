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
    parser.add_argument(
        "--with-conversations",
        action="store_true",
        help="Include synthetic opted-in text to check provisional prompt analysis",
    )
    args = parser.parse_args()
    settings = Settings()
    if not settings.groq_model or not settings.groq_api_key.get_secret_value():
        print(json.dumps({"status": "failed", "error": "project_default_not_configured"}))
        return 1
    metadata = {
        "sample_size": 3,
        "sample_limit": 50,
        "conversation_excerpts": [
            {
                "task": "Summarise this public release note in three bullets for a new teammate. "
                "Keep each bullet short. Keep each bullet short. Keep each bullet short.",
                "task_context": "Audience: a new teammate. No sensitive information.",
                "response_excerpt": "A task requiring basic text summarisation.",
            }
        ]
        if args.with_conversations
        else [],
        "metrics": {
            "analyses": 3,
            "confirmed_choices": 2,
            "pending_choices": 1,
            "larger_than_recommended": 1,
            "smaller_than_recommended": 0,
            "matches": 1,
        },
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
                "patterns": list(report.patterns.model_dump()),
                "schema_version": report.schema_version,
                "prompting_status": report.patterns.prompting.status,
                "conversation_samples": len(metadata["conversation_excerpts"]),
                "input": "synthetic metadata",
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
