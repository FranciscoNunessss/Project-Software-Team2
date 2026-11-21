"""M4/M7: the KR1.2 savings ratio of one evaluation run, optionally with the blind-review verdicts.

    python scripts/savings.py backend/eval/quality/reports/<run>.json
    python scripts/savings.py backend/eval/quality/reports/<run>.json --review <score.json>

Writes <run>-savings.json next to the report. Exit codes: 0 measured (pass or fail is printed),
2 incomplete (a task has no tokens or no price), 3 NOT RUN. No model is called.
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app import savings as sv  # noqa: E402
from app.catalogue import active_catalogue  # noqa: E402

REFERENCE = ROOT / "backend/eval/quality/reference.json"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("report")
    parser.add_argument("--review", help="score.json of the blind review (M6)")
    args = parser.parse_args()
    report = json.loads(Path(args.report).read_text(encoding="utf-8"))
    reference = json.loads(REFERENCE.read_text(encoding="utf-8"))
    catalogue = active_catalogue()
    verdicts = None
    if args.review:
        items = json.loads(Path(args.review).read_text(encoding="utf-8"))["result"]["items"]
        votes: dict[str, list[str]] = {}
        for item in items.values():
            votes.setdefault(item["task"], []).extend(item["votes"])
        verdicts = sv.verdicts_from_votes(votes)
    result = sv.savings(
        sv.rows_from_report(report),
        sv.prices_from(catalogue),
        reference,
        verdicts,
        report.get("status"),
    )
    result["catalogue"] = catalogue.version
    if catalogue.version != reference["catalogue"]:
        result["warning"] = (
            f"the active catalogue {catalogue.version} is not the frozen {reference['catalogue']}"
        )
    out = Path(args.report).with_name(Path(args.report).stem + "-savings.json")
    out.write_text(json.dumps(result, indent=1), encoding="utf-8")
    if result["status"] == sv.NOT_RUN:
        print(f"NOT RUN: {result['reason']}")
        return 3
    print(
        f"KR1.2: following the recommendations costs {result['ratio_percent']}% of always using "
        f"{reference['model']} (prices of {reference['observed_on']}); target at most "
        f"{result['target_percent']}%: {'PASS' if result['passes'] else 'FAIL'}"
    )
    print(
        f"without the review penalty {result['ratio_without_review_penalty']}%, "
        f"if the top model wrote 1.5x more {result['ratio_if_top_writes_1_5x']}%; "
        f"under-sized {result['under_sized']}"
    )
    if result.get("warning"):
        print(f"warning: {result['warning']}")
    print(f"wrote {out}")
    if result["status"] == sv.INCOMPLETE:
        print(f"INCOMPLETE: no tokens or no price for {', '.join(result['unpriced'])}")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
