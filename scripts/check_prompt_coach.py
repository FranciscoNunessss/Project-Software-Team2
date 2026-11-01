"""Explicit opt-in live smoke test of the Prompt Coach schema; synthetic task, consumes quota.

Checks that the provider accepts CoachLLMOutput as structured output. Never prints the task.
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.prompt_builder import active_rubric  # noqa: E402
from app.prompt_coach import (  # noqa: E402
    CoachLLMOutput,
    build_human_message,
    build_system_prompt,
    ground,
    select_targets,
)
from app.providers import ProviderFailure, Settings, structured_call  # noqa: E402

TASK = "Write a summary of the report for the team."
PROFILE = {
    "reasoning": {"score": None, "confidence": "undetermined"},
    "context": {"score": 1, "confidence": "high"},
    "ambiguity": {"score": 3, "confidence": "medium"},
    "domain": {"score": 1, "confidence": "high"},
    "risk": {"score": 1, "confidence": "low"},
    "tools": {"score": 1, "confidence": "high"},
    "modality": {"required": ["text"], "confidence": "high"},
}
MODEL_FIELDS = {
    "groq": "groq_model",
    "openai": "openai_model",
    "claude": "claude_model",
    "ollama": "ollama_model",
}
KEY_FIELDS = {"groq": "groq_api_key", "openai": "openai_api_key", "claude": "anthropic_api_key"}


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--provider", choices=["groq", "openai", "claude", "ollama"], default="groq"
    )
    parser.add_argument("--mode", choices=["tips", "edits", "rewrite"], default="edits")
    args = parser.parse_args()
    settings = Settings()
    model = getattr(settings, MODEL_FIELDS[args.provider])
    key = getattr(settings, KEY_FIELDS[args.provider], None)
    if not model or (key is not None and not key.get_secret_value()):
        print(json.dumps({"status": "failed", "error": "provider_not_configured"}))
        return 1
    targets = select_targets(PROFILE, active_rubric())
    try:
        parsed, usage = await structured_call(
            args.provider,
            settings,
            CoachLLMOutput,
            build_system_prompt(targets, args.mode),
            build_human_message(TASK, targets, args.mode),
            "coach",
        )
    except ProviderFailure as exc:
        print(json.dumps({"status": "failed", "schema_accepted": False, "error": exc.code}))
        return 1
    grounded = ground(parsed, TASK, [item["dimension"] for item in targets], args.mode)
    print(
        json.dumps(
            {
                "status": "ok",
                "schema_accepted": True,
                "provider": args.provider,
                "model": model,
                "mode": args.mode,
                "targets": [item["dimension"] for item in targets],
                "suggestions": len(parsed["suggestions"]),
                "kept_after_ground": len(grounded["suggestions"]),
                "dropped": grounded["dropped"],
                "rewrite": grounded["rewrite"] is not None,
                "usage": usage,
                "input": "synthetic task",
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
