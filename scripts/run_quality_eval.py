"""Run the quality evaluation of the task profile and compare it with the baseline.

    # A relevant subset (what CI runs on a pull request that touches prompts or the catalogue):
    python scripts/run_quality_eval.py run --provider P --model M --subset
    # The full set, 3 repeats (before a milestone), and make this run the new baseline:
    python scripts/run_quality_eval.py run --provider P --model M --repeats 3 --update-baseline
    # Compare a saved report with the baseline again:
    python scripts/run_quality_eval.py compare backend/eval/quality/reports/<file>.json
    # WS5 M3: the labelled set, 3 runs, with answer tokens for the savings ratio (M4):
    python scripts/run_quality_eval.py run --provider groq --model openai/gpt-oss-20b \\
        --set backend/eval/quality/tasks-2.json --repeats 3 --answer-tokens
    # Continue a run stopped by the rate limit:
    python scripts/run_quality_eval.py run ... --resume backend/eval/quality/reports/<file>.json

Groq evaluations use EVAL_GROQ_API_KEY (a separate account), never the production key: without it
the run does not start (exit 3, NOT RUN).

Exit codes: 0 passed (or accepted by an ADR, or there is no baseline yet), 1 regression of more than
5 percentage points or an injection task that forced the levels, 2 a resume that does not match,
3 NOT RUN (the provider failed or there is no key: this is never a pass).
This is a quality evaluation with a real model. The contract tests with fake models stay in
backend/tests and are not evals. Reports hold ids, levels and costs, never the text of a task.
"""

import argparse
import asyncio
import json
import os
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

from pydantic import SecretStr

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app import quality_eval as qe  # noqa: E402
from app.assessment import (  # noqa: E402
    PROFILE_VERSION,
    RUBRIC_VERSION,
    required_capabilities,
)
from app.catalogue import active_catalogue  # noqa: E402
from app.evaluations import Ratings  # noqa: E402
from app.providers import LangChainProvider, ProviderFailure, Settings, chat_model  # noqa: E402
from app.recommendation import (  # noqa: E402
    POLICY_VERSION,
    NoEligibleModel,
    Option,
    recommend,
    task_needs,
)

QUALITY = ROOT / "backend/eval/quality"
TASKS = QUALITY / "tasks-1.json"
BASELINES = QUALITY / "baselines"
REPORTS = QUALITY / "reports"
ACCEPTED = QUALITY / "accepted.json"
NEEDS_KEY = {"groq": "groq_api_key", "openai": "openai_api_key", "claude": "anthropic_api_key"}
RUBRIC_HASHES = ROOT / "backend/rubric/versions.json"
ANSWER_MAX_TOKENS = 2048


def slug(provider: str, model: str) -> str:
    return f"{provider}_{model}".replace("/", "_").replace(":", "_")


def git(*args: str) -> str:
    try:
        return subprocess.run(
            ["git", *args], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout.strip()
    except Exception:  # noqa: BLE001 - a missing git is not a reason to lose the report
        return "unknown"


def catalogue_version() -> str:
    try:
        return str(getattr(active_catalogue(), "version", "unknown"))
    except Exception:  # noqa: BLE001
        return "unknown"


def rubric_hash() -> str:
    try:
        return json.loads(RUBRIC_HASHES.read_text(encoding="utf-8")).get(RUBRIC_VERSION, "unknown")
    except (OSError, json.JSONDecodeError):
        return "unknown"


def has_key(provider: str, settings: Settings) -> bool:
    field = NEEDS_KEY.get(provider)
    if field is None:
        return True  # local providers need none
    value = getattr(settings, field, "")
    return bool(value.get_secret_value() if hasattr(value, "get_secret_value") else value)


def catalogue_options() -> list[Option]:
    """Every alias of every real card: the recommendation chooses across the whole catalogue."""
    return [
        Option(alias.provider, alias.model, None, card.name)
        for card in active_catalogue().cards
        if not card.illustrative
        for alias in card.aliases
    ]


def card_prices() -> dict[str, dict]:
    return {
        card.id: {"in": card.facts.price_in_per_mtok, "out": card.facts.price_out_per_mtok}
        for card in active_catalogue().cards
        if not card.illustrative
    }


def recommendation(profile, text: str, ratings: Ratings) -> dict:
    """What the product would recommend for this profile (the analysis' match step)."""
    needs = task_needs(profile, len(text), required_capabilities(profile, []))
    try:
        result = recommend(needs, catalogue_options(), ratings.catalogue, ratings.card)
    except NoEligibleModel:
        return {"recommendation_error": "no_eligible_model"}
    return {
        "recommended": result.candidates[0]["id"],
        "illustrative": result.illustrative,
        "provisional": result.provisional,
    }


async def analyse(
    provider: LangChainProvider, text: str, ratings: Ratings | None = None
) -> tuple[dict, float]:
    started = time.monotonic()
    try:
        assessment = await provider.assess(text)
    except ProviderFailure as failure:
        return {"error": str(failure)}, time.monotonic() - started
    profile = assessment.profile
    row = {
        "levels": {name: getattr(profile, name).score for name in qe.DIMENSIONS},
        "confidence": {name: getattr(profile, name).confidence for name in qe.DIMENSIONS},
    }
    if assessment.usage:
        row["tokens"] = assessment.usage
    # WS4 L1 adds request-quality scores to the same call; read them when they exist.
    quality = getattr(assessment, "request_quality", None)
    if quality:
        row["request_quality"] = (
            quality.model_dump() if hasattr(quality, "model_dump") else dict(quality)
        )
    if ratings is not None:
        row.update(recommendation(profile, text, ratings))
    return row, time.monotonic() - started


async def answer_tokens(provider: str, settings: Settings, text: str) -> dict:
    """Real token counts of one answer to the task (M4 savings), never the answer itself."""
    try:
        message = await chat_model(provider, settings, ANSWER_MAX_TOKENS).ainvoke([("user", text)])
    except Exception as failure:  # noqa: BLE001 - the analysis row is still valid without tokens
        return {"answer_tokens_error": type(failure).__name__}
    usage = getattr(message, "usage_metadata", None) or {}
    tokens = {key: usage[key] for key in ("input_tokens", "output_tokens") if key in usage}
    return {"answer_tokens": tokens} if len(tokens) == 2 else {"answer_tokens_error": "no_usage"}


def measurements(rows: list[dict], tasks: list[dict], repeats: int, eval_price) -> dict:
    """Stability, recommendation agreement, injection check and usage (WS5 M3)."""
    expected = {task["id"]: task["expected"] for task in tasks}
    expected_models = {
        task["id"]: task["expected_model"] for task in tasks if "expected_model" in task
    }
    blended = {
        card: (3 * price["in"] + price["out"]) / 4
        for card, price in card_prices().items()
        if price["in"] is not None and price["out"] is not None
    }
    injection = [task["id"] for task in tasks if task.get("injection")]
    return {
        "level_stability": qe.stability(rows, repeats),
        "request_quality_stability": qe.stability(rows, repeats, "request_quality"),
        "recommendation": qe.recommendation_agreement(rows, expected_models, blended)
        if expected_models
        else {"available": False, "reason": "the task set has no expected models"},
        "injection": qe.injection_check(rows, injection, expected),
        "usage": qe.usage_totals(rows, eval_price),
    }


def summary(report: dict, result: dict) -> str:
    metrics = report["metrics"]["overall"]
    lines = [
        f"## Quality evaluation: {result['verdict'].upper().replace('_', ' ')}",
        "",
        f"Model `{report['model']}`, rubric `{report['rubric']}`, "
        f"task set {report['task_set']} ({report['mode']}), commit `{report['commit'][:8]}`.",
        "",
        f"Agreement with the expected levels: **{metrics['agreement']}%** "
        f"over {metrics['n']} cells; "
        f"{report['metrics']['failed']} of {report['metrics']['analyses']} analyses failed.",
    ]
    extra = report.get("measurements")
    if extra:
        stable = extra["level_stability"]
        if stable.get("applicable"):
            text = f"**{stable['percent']}%** of {stable['cells']} cells identical in every run"
        else:
            text = stable["reason"]
        lines += ["", f"Level stability: {text}."]
        rec = extra["recommendation"]
        if rec.get("n"):
            lines.append(
                f"Recommended model = labelled model in **{rec['agreement']}%** of {rec['n']} "
                f"tasks ({rec['over_sized']} over, {rec['under_sized']} under, "
                f"{rec['illustrative']} illustrative)."
            )
        if extra["injection"]["flagged"]:
            lines.append(f"**Injection flagged:** {extra['injection']['flagged']}.")
        usage = extra["usage"]
        lines.append(
            f"Analysis tokens {usage['tokens_in']} in, {usage['tokens_out']} out; "
            f"estimated cost USD {usage['estimated_cost_usd']}."
        )
    if "before" in result:
        lines += [
            "",
            f"Baseline {result['before']}%, change {-result['drop_points']:+.1f} points "
            f"(blocked beyond {result['max_drop']}).",
        ]
    if "reason" in result:
        lines += ["", result["reason"] + "."]
    if result["verdict"] == qe.NOT_RUN:
        lines += ["", "**This is not a pass: nothing was measured.**"]
    return "\n".join(lines) + "\n"


def decide(report: dict, baseline_path: Path, accepted_path: Path) -> dict:
    baseline = (
        json.loads(baseline_path.read_text(encoding="utf-8")) if baseline_path.exists() else None
    )
    accepted = (
        json.loads(accepted_path.read_text(encoding="utf-8")) if accepted_path.exists() else []
    )
    return qe.gate_injection(qe.compare(baseline, report, accepted), report)


def finish(report: dict, result: dict) -> int:
    text = summary(report, result)
    print(text)
    target = os.environ.get("GITHUB_STEP_SUMMARY")
    if target:
        with open(target, "a", encoding="utf-8") as stream:
            stream.write(text)
    if result["verdict"] == qe.NOT_RUN:
        print("::warning title=Quality evaluation NOT RUN::nothing measured, not a pass")
        return 3
    return 1 if result["verdict"] == qe.REGRESSION else 0


def eval_price(provider: str, model: str) -> dict | None:
    card = active_catalogue().card_for(provider, model)
    return card_prices().get(card.id) if card else None


def run(args) -> int:
    task_file = Path(args.set).resolve() if args.set else TASKS
    document = json.loads(task_file.read_text(encoding="utf-8"))
    tasks = [task for task in document["tasks"] if task["subset"] or not args.subset]
    expected = {task["id"]: task["expected"] for task in tasks}
    settings = Settings().model_copy(update={f"{args.provider}_model": args.model})
    try:
        key = qe.dev_key(args.provider, dict(os.environ))
    except qe.NoDevKey as missing:
        print(f"NOT RUN: {missing}.", file=sys.stderr)
        return 3
    if key is not None:
        settings = settings.model_copy(update={NEEDS_KEY[args.provider]: SecretStr(key)})
    previous = json.loads(Path(args.resume).read_text(encoding="utf-8")) if args.resume else None
    if previous and (previous["model"], previous["task_set"]) != (args.model, document["version"]):
        print("The report to resume is for another model or task set.", file=sys.stderr)
        return 2
    base = {
        "date": previous["date"] if previous else datetime.now(UTC).isoformat(timespec="seconds"),
        "commit": git("rev-parse", "HEAD"),
        "provider": args.provider,
        "model": args.model,
        "task_set": document["version"],
        "task_set_file": task_file.relative_to(ROOT).as_posix()
        if task_file.is_relative_to(ROOT)
        else str(task_file),
        "injection_tasks": [task["id"] for task in tasks if task.get("injection")],
        "mode": "subset" if args.subset else "full",
        "repeats": args.repeats,
        "profile": PROFILE_VERSION,
        "rubric": RUBRIC_VERSION,
        "rubric_sha256": rubric_hash(),
        "policy": POLICY_VERSION,
        "catalogue": catalogue_version(),
        "key": "eval" if key else "local or personal",
    }
    rows: list[dict] = list(previous["rows"]) if previous else []
    if has_key(args.provider, settings):
        provider = LangChainProvider(args.provider, settings)
        ratings = Ratings(None, active_catalogue())
        texts = {task["id"]: task["task"] for task in tasks}

        async def everything():
            failures = 0
            for repeat, task_id in qe.pending(list(texts), args.repeats, rows):
                row, seconds = await analyse(provider, texts[task_id], ratings)
                if args.answer_tokens and repeat == 0 and "error" not in row:
                    row.update(await answer_tokens(args.provider, settings, texts[task_id]))
                rows.append(
                    {"task": task_id, "repeat": repeat, "seconds": round(seconds, 1), **row}
                )
                print(f"{task_id} #{repeat}: {row.get('error', 'ok')} {seconds:.1f}s", flush=True)
                failures = failures + 1 if "error" in row else 0
                if failures >= args.stop_after_failures:
                    print(
                        f"Stopped after {failures} failures in a row (rate limit or outage): "
                        "continue later with --resume.",
                        flush=True,
                    )
                    return
                await asyncio.sleep(args.pause)

        asyncio.run(everything())
    else:
        print(f"No key for {args.provider}: the evaluation cannot run.")
    rows = qe.latest_rows(rows)
    metrics = qe.score(rows, expected)
    report = {
        **base,
        "metrics": metrics,
        "measurements": measurements(
            rows, tasks, args.repeats, eval_price(args.provider, args.model)
        ),
        "status": qe.run_status(metrics),
        "rows": rows,
    }
    REPORTS.mkdir(parents=True, exist_ok=True)
    out = (
        Path(args.resume)
        if args.resume
        else REPORTS / f"{slug(args.provider, args.model)}-{base['mode']}-{base['date'][:10]}.json"
    )
    out.write_text(json.dumps(report, indent=1), encoding="utf-8")
    print(f"wrote {out}")
    baseline_path = BASELINES / f"{slug(args.provider, args.model)}.json"
    result = decide(report, baseline_path, ACCEPTED)
    if args.update_baseline and report["status"] == qe.PASS and base["mode"] == "full":
        BASELINES.mkdir(parents=True, exist_ok=True)
        baseline_path.write_text(
            json.dumps({k: v for k, v in report.items() if k != "rows"}, indent=1), encoding="utf-8"
        )
        print(f"baseline updated: {baseline_path.relative_to(ROOT)}")
    elif args.update_baseline:
        print("The baseline is only updated from a full run that was measured.", file=sys.stderr)
    return finish(report, result)


def compare(args) -> int:
    report = json.loads(Path(args.report).read_text(encoding="utf-8"))
    baseline_path = BASELINES / f"{slug(report['provider'], report['model'])}.json"
    return finish(report, decide(report, baseline_path, ACCEPTED))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    runner = sub.add_parser("run")
    runner.add_argument("--provider", required=True)
    runner.add_argument("--model", required=True)
    runner.add_argument("--subset", action="store_true")
    runner.add_argument("--repeats", type=int, default=1)
    runner.add_argument(
        "--pause", type=float, default=2.5, help="seconds between calls, for rate limits"
    )
    runner.add_argument("--update-baseline", action="store_true")
    runner.add_argument("--set", help="task set file (default: the draft tasks-1.json)")
    runner.add_argument(
        "--answer-tokens",
        action="store_true",
        help="also answer each task once and keep only the token counts (M4 savings)",
    )
    runner.add_argument("--resume", help="the report of a run that stopped early")
    runner.add_argument("--stop-after-failures", type=int, default=3)
    scorer = sub.add_parser("compare")
    scorer.add_argument("report")
    args = parser.parse_args()
    return run(args) if args.command == "run" else compare(args)


if __name__ == "__main__":
    raise SystemExit(main())
