"""Measure every catalogue model the configured keys can reach (ADR-014, measure-suite-1).

    uv run python scripts/measure_models.py                      # all reachable models, free only
    uv run python scripts/measure_models.py --card gpt-oss-20b   # one model
    uv run python scripts/measure_models.py --allow-paid         # also paid models (costs cents)

Keys come from .env or the environment (ADAPTAI_GROQ_API_KEY, ADAPTAI_OPENROUTER_API_KEY,
ADAPTAI_OPENAI_API_KEY, ADAPTAI_ANTHROPIC_API_KEY); they are never printed. For each card the
first alias whose provider has a key is used, preferring free (":free" or Groq) aliases.
Every answer is graded automatically (backend/app/measurement.py). One file per model is
written to backend/eval/measure/runs/; apply them with scripts/apply_measurements.py.
The suite is synthetic: no user data is sent.
"""

import argparse
import asyncio
import json
import sys
import time
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.catalogue import load_catalogue  # noqa: E402
from app.measurement import SUITE_VERSION, build_suite, grade, levels  # noqa: E402
from app.providers import Settings, chat_model  # noqa: E402

RUNS = ROOT / "backend/eval/measure/runs"
KEYS = {
    "groq": "groq_api_key",
    "openrouter": "openrouter_api_key",
    "openai": "openai_api_key",
    "claude": "anthropic_api_key",
}


def reachable(settings: Settings, provider: str) -> bool:
    field = KEYS.get(provider)
    return bool(field and getattr(settings, field).get_secret_value())


def choose_alias(card, settings: Settings, allow_paid: bool):
    aliases = [alias for alias in card.aliases if reachable(settings, alias.provider)]
    free = [a for a in aliases if a.model.endswith(":free") or a.provider == "groq"]
    if free:
        return free[0]
    if allow_paid and aliases:
        return aliases[0]
    return None


async def ask(llm, prompt: str) -> str:
    reply = await llm.ainvoke([("human", prompt)])
    content = reply.content
    if isinstance(content, list):
        content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
    return str(content).strip()


def call(llm, prompt: str, delay: float) -> str:
    wait = 15.0
    for attempt in range(6):
        try:
            answer = asyncio.run(ask(llm, prompt))
            time.sleep(delay)
            return answer
        except Exception as exc:  # noqa: BLE001 - provider errors vary; retried, then recorded
            text = f"{type(exc).__name__}: {exc}".lower()
            transient = any(
                word in text for word in ("429", "rate", "limit", "timeout", "503", "502")
            )
            if not transient or attempt == 5:
                return f"[error: {type(exc).__name__}]"
            time.sleep(wait)
            wait = min(wait * 2, 120)
    return "[error: retries]"


def measure(card, alias, settings: Settings, seed: int, delay: float, max_tokens: int) -> dict:
    field = f"{alias.provider}_model" if alias.provider != "claude" else "claude_model"
    llm = chat_model(alias.provider, settings.model_copy(update={field: alias.model}), max_tokens)
    results = []
    for task in build_suite(seed):
        answer = call(llm, task.prompt, delay)
        passed = not answer.startswith("[error") and grade(task, answer)
        results.append(
            {
                "id": task.id,
                "capability": task.capability,
                "level": task.level,
                "passed": passed,
                "error": answer if answer.startswith("[error") else None,
                "answer": answer[:2000],
            }
        )
        error = " " + answer if answer.startswith("[error") else ""
        print(f"  {task.id:16} {'pass' if passed else 'FAIL'}{error}")
    return {
        "suite": SUITE_VERSION,
        "seed": seed,
        "card": card.id,
        "provider": alias.provider,
        "model": alias.model,
        "measured_on": date.today().isoformat(),
        "errors": sum(item["error"] is not None for item in results),
        "levels": levels(results),
        "results": results,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--card", action="append", default=[], help="card id (repeatable)")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--delay", type=float, default=2.0, help="seconds between calls")
    parser.add_argument("--max-tokens", type=int, default=2048)
    parser.add_argument("--allow-paid", action="store_true")
    args = parser.parse_args()
    settings = Settings()
    catalogue = load_catalogue()
    RUNS.mkdir(parents=True, exist_ok=True)
    measured = 0
    for card in catalogue.cards:
        if card.illustrative or (args.card and card.id not in args.card):
            continue
        alias = choose_alias(card, settings, args.allow_paid)
        if alias is None:
            print(f"{card.id}: skipped (no key for a free alias; --allow-paid for paid ones)")
            continue
        print(f"{card.id}: {alias.provider} {alias.model}")
        run = measure(card, alias, settings, args.seed, args.delay, args.max_tokens)
        out = RUNS / f"{card.id}-{run['measured_on']}-seed{args.seed}.json"
        out.write_text(json.dumps(run, indent=1) + "\n", encoding="utf-8")
        summary = ", ".join(f"{name} {item['level']}" for name, item in run["levels"].items())
        print(f"  -> {summary} ({run['errors']} errors) written to {out.relative_to(ROOT)}")
        measured += 1
    print(f"{measured} model(s) measured")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
