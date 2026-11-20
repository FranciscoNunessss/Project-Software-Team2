"""Evaluate the Educator's text against the verdict decided in Python (05 section 7.6).

    python scripts/run_educator_eval.py --provider lmstudio --model <id> --repeats 2

For each synthetic usage history (backend/tests/usage_histories.py) it builds what the Educator
receives, asks the real coaching model, and checks what the model wrote AROUND the verdict:

- ``summary`` and ``suggestions`` are never replaced by ``apply_verdicts``, so they are the text
  that can contradict the verdict. They are flagged when they assert a choice pattern that the
  rule did not detect (a sentence that mentions it without a negation or a "too few").
- ``patterns.over_provisioning`` and ``patterns.under_provisioning`` are replaced by Python
  whenever the pattern is not detected; they are only shown here to read what was replaced.
  For a detected pattern the model's text is kept and is checked for the opposite claim.

The flags are a conservative filter for a person to read, not a judgement: the report keeps the
model's text next to each flag. The histories are synthetic (no task text), so keeping the
model's answer in the report is safe. The exit code is 1 when anything was flagged, 3 when
nothing could be measured, 0 otherwise.
"""

import argparse
import asyncio
import json
import re
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "backend/tests"))

from app.coaching import (  # noqa: E402
    COACHING_POLICY_VERSION,
    CoachingReport,
    educator_prompt,
    usage_patterns,
)
from app.providers import ProviderFailure, Settings, structured_call  # noqa: E402
from usage_histories import GAP, HISTORIES  # noqa: E402

REPORTS = ROOT / "backend/eval/educator/reports"

CLAIMS = {
    "over_provisioning": re.compile(
        r"over[- ]?provision|larger (?:model|than)|bigger model"
        r"|more (?:model )?than (?:the task )?needs?"
        r"|too (?:large|big|powerful)|oversiz",
        re.I,
    ),
    "under_provisioning": re.compile(
        r"under[- ]?provision|smaller (?:model|than)|less capable|too (?:small|weak)"
        r"|covers? less|undersiz",
        re.I,
    ),
}
NEGATION = re.compile(
    r"\b(no|not|never|neither|nor|without|isn't|aren't|doesn't|don't|too few|not enough|"
    r"insufficient|unclear|cannot|can't|if|when|whether|avoid|would)\b",
    re.I,
)


def metadata_of(history) -> dict:
    """What the Educator receives, as ``snapshot`` builds it, from the choices alone."""
    gaps = [GAP[kind] for kind in history.choices if kind != "pending"]
    rows = [
        {"mode": "demo", "choice_gap": None if kind == "pending" else GAP[kind]}
        for kind in history.choices
    ]
    return {
        "sample_size": len(rows),
        "sample_limit": 50,
        "metrics": {
            "analyses": len(rows),
            "confirmed_choices": len(gaps),
            "pending_choices": len(rows) - len(gaps),
            "larger_than_recommended": sum(g > 0 for g in gaps),
            "smaller_than_recommended": sum(g < 0 for g in gaps),
            "matches": sum(g == 0 for g in gaps),
        },
        "usage_patterns": usage_patterns(gaps),
        "assessments": rows,
        "conversation_excerpts": [],
        "completeness_series": [],
        "insufficient_history": True,
    }


def sentences(text: str) -> list[str]:
    return [part for part in re.split(r"(?<=[.!?])\s+|\n", text) if part.strip()]


def claims_in(text: str, name: str) -> list[str]:
    """Sentences that assert the pattern ``name`` (mention it with no negation or condition)."""
    return [
        sentence
        for sentence in sentences(text)
        if CLAIMS[name].search(sentence) and not NEGATION.search(sentence)
    ]


def flags_of(report: dict, history, patterns: dict) -> list[dict]:
    free_text = {
        "summary": report["summary"],
        **{
            f"suggestion {i + 1}": f"{s['title']}. {s['explanation']} {s['action']}"
            for i, s in enumerate(report["suggestions"])
        },
    }
    flags = []
    for name in ("over_provisioning", "under_provisioning"):
        status = patterns[name]["status"]
        for where, text in free_text.items():
            if status != "detected":
                for sentence in claims_in(text, name):
                    flags.append(
                        {"where": where, "pattern": name, "status": status, "text": sentence}
                    )
        advice = report["patterns"][name]
        if status == "detected":
            other = "under_provisioning" if name == "over_provisioning" else "over_provisioning"
            for sentence in claims_in(f"{advice['explanation']} {advice['action']}", other):
                flags.append(
                    {
                        "where": f"patterns.{name}",
                        "pattern": other,
                        "status": "opposite",
                        "text": sentence,
                    }
                )
    return flags


async def run(args) -> int:
    settings = Settings().model_copy(update={f"{args.provider}_model": args.model})
    system = educator_prompt({})
    rows, failed = [], 0
    for history in HISTORIES:
        metadata = metadata_of(history)
        for repeat in range(args.repeats):
            try:
                parsed, _ = await structured_call(
                    args.provider,
                    settings,
                    CoachingReport,
                    system,
                    json.dumps(metadata),
                    "educator",
                )
                report = CoachingReport.model_validate(parsed).model_dump()
            except ProviderFailure as error:
                failed += 1
                rows.append({"history": history.name, "repeat": repeat, "error": str(error)})
                print(f"{history.name} #{repeat}: ERROR {error}", flush=True)
                continue
            flags = flags_of(report, history, metadata["usage_patterns"])
            rows.append(
                {
                    "history": history.name,
                    "repeat": repeat,
                    "verdict": {
                        n: metadata["usage_patterns"][n]["status"]
                        for n in ("over_provisioning", "under_provisioning")
                    },
                    "report": report,
                    "flags": flags,
                }
            )
            print(f"{history.name} #{repeat}: {len(flags)} flag(s)", flush=True)
    measured = [r for r in rows if "report" in r]
    flagged = [r for r in measured if r["flags"]]
    out = {
        "provider": args.provider,
        "model": args.model,
        "policy": COACHING_POLICY_VERSION,
        "date": datetime.now(UTC).isoformat(timespec="seconds"),
        "histories": len(HISTORIES),
        "repeats": args.repeats,
        "measured": len(measured),
        "failed": failed,
        "flagged": len(flagged),
        "rows": rows,
    }
    REPORTS.mkdir(parents=True, exist_ok=True)
    stem = f"{args.provider}_{args.model}".replace("/", "_").replace(":", "_")
    path = REPORTS / f"{stem}-{out['date'][:10]}.json"
    path.write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    print(
        f"\n{len(measured)} of {len(rows)} runs measured, {len(flagged)} flagged, "
        f"{failed} failed. Report: {path}"
    )
    if not measured:
        return 3
    return 1 if flagged else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--provider", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--repeats", type=int, default=2)
    return asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
