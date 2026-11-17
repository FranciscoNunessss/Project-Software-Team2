"""Run the quality evaluation of the task profile and compare it with the baseline.

    # A relevant subset (what CI runs on a pull request that touches prompts or the catalogue):
    python scripts/run_quality_eval.py run --provider P --model M --subset
    # Other suites: --suite injection (orders aimed at the assessor), --suite pairs (M7).
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
from app.assessment import PROFILE_VERSION, RUBRIC_VERSION, completeness  # noqa: E402
from app.models import Assessment, Profile  # noqa: E402
from app.prompt_builder import build_assessment_prompt, load_rubric  # noqa: E402
from app.providers import LangChainProvider, ProviderFailure, Settings, structured_call  # noqa: E402
from app.recommendation import POLICY_VERSION  # noqa: E402

QUALITY = ROOT / "backend/eval/quality"
# The suites: the profile of ordinary tasks, tasks that carry an instruction aimed at the assessor
# (injection), and pairs of a vague and a complete version of one intent (M7).
SUITES = {
    "profile": QUALITY / "tasks-1.json",
    "injection": QUALITY / "injection-1.json",
    "pairs": QUALITY / "pairs-1.json",
}
BASELINES = QUALITY / "baselines"
REPORTS = QUALITY / "reports"
ACCEPTED = QUALITY / "accepted.json"
NEEDS_KEY = {"groq": "groq_api_key", "openai": "openai_api_key", "claude": "anthropic_api_key"}


def shown(path: Path) -> str:
    """A path relative to the repository when it is inside it."""
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


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


class RubricProvider:
    """The assessor with the prompt of a chosen rubric version, to compare it with the active."""

    def __init__(self, provider: str, settings: Settings, version: str):
        self.provider, self.settings = provider, settings
        self.prompt = build_assessment_prompt(load_rubric(version))

    async def assess(self, task: str) -> Assessment:
        parsed, usage = await structured_call(
            self.provider, self.settings, Profile, self.prompt, task, "assessment"
        )
        return Assessment(profile=Profile.model_validate(parsed), usage=usage)


async def analyse(provider, text: str) -> tuple[dict, float]:
    started = time.monotonic()
    try:
        assessment = await provider.assess(text)
    except ProviderFailure as failure:
        return {"error": str(failure)}, time.monotonic() - started
    profile = assessment.profile
    row = {
        "completeness": completeness(profile, False),
        "levels": {name: getattr(profile, name).score for name in qe.DIMENSIONS},
        "confidence": {name: getattr(profile, name).confidence for name in qe.DIMENSIONS},
    }
    if assessment.usage:
        row["tokens"] = assessment.usage
    return row, time.monotonic() - started


def summary(report: dict, result: dict) -> str:
    metrics = report["metrics"]["overall"]
    suite = report.get("suite", "profile")
    what, unit = {
        "profile": ("Agreement with the expected levels", "cells"),
        "injection": ("Levels the task would get without the injected instruction", "cells"),
        "pairs": ("Pairs in which the complete version scored higher", "pairs"),
    }[suite]
    lines = [
        f"## Quality evaluation ({suite}): {result['verdict'].upper().replace('_', ' ')}",
        "",
        f"Model `{report['model']}`, rubric `{report['rubric']}`, "
        f"task set {report['task_set']} ({report['mode']}), commit `{report['commit'][:8]}`.",
        "",
        f"{what}: **{metrics['agreement']}%** over {metrics['n']} {unit}; "
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


def baseline_file(provider: str, model: str, suite: str) -> Path:
    """The profile suite keeps its original file name; the others carry the suite in it."""
    suffix = "" if suite == "profile" else f".{suite}"
    return BASELINES / f"{slug(provider, model)}{suffix}.json"


def jobs_of(document: dict, suite: str, subset: bool) -> list[tuple[str, str, str | None]]:
    """What to analyse: (id, text, variant). Pairs make two analyses each."""
    if suite == "pairs":
        pairs = [pair for pair in document["pairs"] if pair["subset"] or not subset]
        return [(p["id"], p[v], v) for p in pairs for v in ("vague", "complete")]
    return [(t["id"], t["task"], None) for t in document["tasks"] if t["subset"] or not subset]


def run(args) -> int:
    document = json.loads(SUITES[args.suite].read_text(encoding="utf-8"))
    jobs = jobs_of(document, args.suite, args.subset)
    expected = (
        {}
        if args.suite == "pairs"
        else {t["id"]: t["expected"] for t in document["tasks"] if t["subset"] or not args.subset}
    )
    settings = Settings().model_copy(update={f"{args.provider}_model": args.model})
    base = {
        "date": datetime.now(UTC).isoformat(timespec="seconds"),
        "commit": git("rev-parse", "HEAD"),
        "provider": args.provider,
        "model": args.model,
        "suite": args.suite,
        "task_set": document["version"],
        "mode": "subset" if args.subset else "full",
        "repeats": args.repeats,
        "profile": PROFILE_VERSION,
        "rubric": args.rubric or RUBRIC_VERSION,
        "policy": POLICY_VERSION,
        "catalogue": catalogue_version(),
    }
    rows: list[dict] = []
    if has_key(args.provider, settings):
        provider = (
            RubricProvider(args.provider, settings, args.rubric)
            if args.rubric
            else LangChainProvider(args.provider, settings)
        )

        async def everything():
            for repeat in range(args.repeats):
                for name, text, variant in jobs:
                    row, seconds = await analyse(provider, text)
                    extra = {"variant": variant} if variant else {}
                    rows.append(
                        {
                            "task": name,
                            "repeat": repeat,
                            "seconds": round(seconds, 1),
                            **extra,
                            **row,
                        }
                    )
                    label = f"{name} {variant or ''} #{repeat}".replace("  ", " ")
                    print(f"{label}: {row.get('error', 'ok')} {seconds:.1f}s", flush=True)
                    await asyncio.sleep(args.pause)

        asyncio.run(everything())
    else:
        print(f"No key for {args.provider}: the evaluation cannot run.")
    metrics = qe.score_pairs(rows) if args.suite == "pairs" else qe.score(rows, expected)
    report = {**base, "metrics": metrics, "status": qe.run_status(metrics), "rows": rows}
    REPORTS.mkdir(parents=True, exist_ok=True)
    version = f"-{args.rubric}" if args.rubric else ""
    name = slug(args.provider, args.model)
    stem = f"{name}-{args.suite}{version}-{base['mode']}-{base['date'][:10]}"
    out = REPORTS / f"{stem}.json"
    out.write_text(json.dumps(report, indent=1), encoding="utf-8")
    print(f"wrote {shown(out)}")
    baseline_path = baseline_file(args.provider, args.model, args.suite)
    result = decide(report, baseline_path, ACCEPTED)
    if args.update_baseline and report["status"] == qe.PASS and base["mode"] == "full":
        BASELINES.mkdir(parents=True, exist_ok=True)
        baseline_path.write_text(
            json.dumps({k: v for k, v in report.items() if k != "rows"}, indent=1), encoding="utf-8"
        )
        print(f"baseline updated: {shown(baseline_path)}")
    elif args.update_baseline:
        print("The baseline is only updated from a full run that was measured.", file=sys.stderr)
    return finish(report, result)


def diff(args) -> int:
    """Per-dimension agreement of two reports (for example rubric-2.0 and rubric-2.1)."""
    first, second = (
        json.loads(Path(p).read_text(encoding="utf-8")) for p in (args.first, args.second)
    )
    for report in (first, second):
        print(f"{report['rubric']:12} {report['suite']:9} {report['model']}")
    print(f"{'':14}{first['rubric']:>12}{second['rubric']:>12}   change")
    rows = [("overall", first["metrics"]["overall"], second["metrics"]["overall"])]
    names = first["metrics"]["by_dimension"].keys() | second["metrics"]["by_dimension"].keys()
    rows += [
        (n, first["metrics"]["by_dimension"].get(n), second["metrics"]["by_dimension"].get(n))
        for n in qe.DIMENSIONS
        if n in names
    ]
    for name, one, two in rows:
        a = one["agreement"] if one else None
        b = two["agreement"] if two else None
        change = f"{b - a:+.1f}" if a is not None and b is not None else ""
        print(
            f"{name:14}{a if a is not None else '-':>11}%"
            f"{b if b is not None else '-':>11}%   {change}"
        )
    return 0


def compare(args) -> int:
    report = json.loads(Path(args.report).read_text(encoding="utf-8"))
    baseline_path = baseline_file(
        report["provider"], report["model"], report.get("suite", "profile")
    )
    return finish(report, decide(report, baseline_path, ACCEPTED))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    runner = sub.add_parser("run")
    runner.add_argument("--provider", required=True)
    runner.add_argument("--model", required=True)
    runner.add_argument("--suite", choices=sorted(SUITES), default="profile")
    runner.add_argument("--rubric", help="a rubric version to use instead of the active one")
    runner.add_argument("--subset", action="store_true")
    runner.add_argument("--repeats", type=int, default=1)
    runner.add_argument(
        "--pause", type=float, default=2.5, help="seconds between calls, for rate limits"
    )
    runner.add_argument("--update-baseline", action="store_true")
    scorer = sub.add_parser("compare")
    scorer.add_argument("report")
    sides = sub.add_parser("diff", help="two reports of the same suite, side by side")
    sides.add_argument("first")
    sides.add_argument("second")
    args = parser.parse_args()
    if args.command == "run":
        return run(args)
    return diff(args) if args.command == "diff" else compare(args)


if __name__ == "__main__":
    raise SystemExit(main())
