"""Run the quality evaluation of the task profile and compare it with the baseline.

    # A relevant subset (what CI runs on a pull request that touches prompts or the catalogue):
    python scripts/run_quality_eval.py run --provider P --model M --subset
    # The full set, 3 repeats (before a milestone), and make this run the new baseline:
    python scripts/run_quality_eval.py run --provider P --model M --repeats 3 --update-baseline
    # Compare a saved report with the baseline again:
    python scripts/run_quality_eval.py compare backend/eval/quality/reports/<file>.json

Exit codes: 0 passed (or accepted by an ADR, or there is no baseline yet), 1 regression of more than
5 percentage points, 3 NOT RUN (the provider failed or there is no key: this is never a pass).
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

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app import quality_eval as qe  # noqa: E402
from app.assessment import PROFILE_VERSION, RUBRIC_VERSION  # noqa: E402
from app.providers import LangChainProvider, ProviderFailure, Settings  # noqa: E402
from app.recommendation import POLICY_VERSION  # noqa: E402

QUALITY = ROOT / "backend/eval/quality"
TASKS = QUALITY / "tasks-1.json"
BASELINES = QUALITY / "baselines"
REPORTS = QUALITY / "reports"
ACCEPTED = QUALITY / "accepted.json"
NEEDS_KEY = {"groq": "groq_api_key", "openai": "openai_api_key", "claude": "anthropic_api_key"}


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
        from app.catalogue import active_catalogue

        return str(getattr(active_catalogue(), "version", "unknown"))
    except Exception:  # noqa: BLE001
        return "unknown"


def has_key(provider: str, settings: Settings) -> bool:
    field = NEEDS_KEY.get(provider)
    if field is None:
        return True  # local providers need none
    value = getattr(settings, field, "")
    return bool(value.get_secret_value() if hasattr(value, "get_secret_value") else value)


async def analyse(provider: LangChainProvider, text: str) -> tuple[dict, float]:
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
    return row, time.monotonic() - started


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
    return qe.compare(baseline, report, accepted)


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


def run(args) -> int:
    document = json.loads(TASKS.read_text(encoding="utf-8"))
    tasks = [task for task in document["tasks"] if task["subset"] or not args.subset]
    expected = {task["id"]: task["expected"] for task in tasks}
    settings = Settings().model_copy(update={f"{args.provider}_model": args.model})
    base = {
        "date": datetime.now(UTC).isoformat(timespec="seconds"),
        "commit": git("rev-parse", "HEAD"),
        "provider": args.provider,
        "model": args.model,
        "task_set": document["version"],
        "mode": "subset" if args.subset else "full",
        "repeats": args.repeats,
        "profile": PROFILE_VERSION,
        "rubric": RUBRIC_VERSION,
        "policy": POLICY_VERSION,
        "catalogue": catalogue_version(),
    }
    rows: list[dict] = []
    if has_key(args.provider, settings):
        provider = LangChainProvider(args.provider, settings)

        async def everything():
            for repeat in range(args.repeats):
                for task in tasks:
                    row, seconds = await analyse(provider, task["task"])
                    rows.append(
                        {"task": task["id"], "repeat": repeat, "seconds": round(seconds, 1), **row}
                    )
                    print(
                        f"{task['id']} #{repeat}: {row.get('error', 'ok')} {seconds:.1f}s",
                        flush=True,
                    )
                    await asyncio.sleep(args.pause)

        asyncio.run(everything())
    else:
        print(f"No key for {args.provider}: the evaluation cannot run.")
    metrics = qe.score(rows, expected)
    report = {**base, "metrics": metrics, "status": qe.run_status(metrics), "rows": rows}
    REPORTS.mkdir(parents=True, exist_ok=True)
    out = REPORTS / f"{slug(args.provider, args.model)}-{base['mode']}-{base['date'][:10]}.json"
    out.write_text(json.dumps(report, indent=1), encoding="utf-8")
    print(f"wrote {out.relative_to(ROOT)}")
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
    scorer = sub.add_parser("compare")
    scorer.add_argument("report")
    args = parser.parse_args()
    return run(args) if args.command == "run" else compare(args)


if __name__ == "__main__":
    raise SystemExit(main())
