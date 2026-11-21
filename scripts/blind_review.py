"""M2/M6: build the blind-review packet from an evaluation run, and score the reviewers' answers.

    # From one complete run of the labelled set (M5), with 3 reviewers:
    python scripts/blind_review.py export backend/eval/quality/reports/<run>.json --seed 2026
    # After the review, one CSV per reviewer (columns item, answer, confidence; others are ignored):
    python scripts/blind_review.py score backend/eval/review/<date>/packet.json R1=r1.csv R2=r2.csv

Export writes packet.json (team side: which items are controls) and one form per reviewer,
form-R1.csv and so on, plus models.csv (the cards every reviewer sees). Exit codes: 0 done,
2 not usable (printed), 3 NOT RUN (fewer than 2 reviewers).
"""

import argparse
import csv
import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app import blind_review as br  # noqa: E402
from app.catalogue import active_catalogue  # noqa: E402

REVIEW = ROOT / "backend/eval/review"
REFERENCE = ROOT / "backend/eval/quality/reference.json"
DEFAULT_REFERENCE = "claude-sonnet-5-5"


def real_cards() -> dict:
    return {card.id: card for card in active_catalogue().cards if not card.illustrative}


def reference_id() -> str:
    if REFERENCE.exists():
        return json.loads(REFERENCE.read_text(encoding="utf-8"))["model"]
    return DEFAULT_REFERENCE


def export(args) -> int:
    report = json.loads(Path(args.report).read_text(encoding="utf-8"))
    cards = real_cards()
    prices = {card_id: card.blended_price for card_id, card in cards.items()}
    prices = {card_id: price for card_id, price in prices.items() if price is not None}
    review = br.packet(
        report,
        prices,
        reference_id(),
        tuple(f"R{n + 1}" for n in range(args.reviewers)),
        args.seed,
    )
    task_file = ROOT / report.get("task_set_file", "backend/eval/quality/tasks-2.json")
    texts = {
        task["id"]: task["task"]
        for task in json.loads(task_file.read_text(encoding="utf-8"))["tasks"]
    }
    out = Path(args.out or REVIEW / date.today().isoformat())
    out.mkdir(parents=True, exist_ok=True)
    (out / "packet.json").write_text(json.dumps(review, indent=1), encoding="utf-8")
    items = {item["item"]: item for item in review["items"]}
    for reviewer, order in review["orders"].items():
        with (out / f"form-{reviewer}.csv").open("w", encoding="utf-8", newline="") as stream:
            writer = csv.writer(stream)
            writer.writerow(["order", "item", "task", "recommended_model", "answer", "confidence"])
            for position, item_id in enumerate(order, 1):
                item = items[item_id]
                writer.writerow(
                    [position, item_id, texts[item["task"]], cards[item["model"]].name, "", ""]
                )
    with (out / "models.csv").open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["model", "price_in_usd_per_mtok", "price_out_usd_per_mtok"])
        for card in sorted(cards.values(), key=lambda card: card.blended_price or 0):
            writer.writerow(
                [card.name, card.facts.price_in_per_mtok, card.facts.price_out_per_mtok]
            )
    print(f"wrote {out} ({len(review['items'])} items, {len(review['orders'])} reviewers)")
    return 0


def read_answers(reviewer: str, path: Path) -> list[dict]:
    with path.open(encoding="utf-8", newline="") as stream:
        return [
            {
                "reviewer": reviewer,
                "item": row["item"].strip(),
                "answer": (row.get("answer") or "").strip().upper(),
                "confidence": (row.get("confidence") or "").strip().lower().replace(" ", "_"),
            }
            for row in csv.DictReader(stream)
            if (row.get("answer") or "").strip()
        ]


def score(args) -> int:
    review = json.loads(Path(args.packet).read_text(encoding="utf-8"))
    answers = []
    for pair in args.answers:
        reviewer, _, path = pair.partition("=")
        answers += read_answers(reviewer, Path(path))
    result = br.score(review, answers)
    out = Path(args.packet).with_name("score.json")
    out.write_text(json.dumps({"answers": answers, "result": result}, indent=1), encoding="utf-8")
    if result["status"] == br.NOT_RUN:
        print(f"NOT RUN: {result['reason']}")
        return 3
    agreement = result["agreement"]
    print(
        f"KR1.1: {result['correct']} of {result['out_of']} correct "
        f"(target {result['target']}): {'PASS' if result['passes'] else 'FAIL'}"
    )
    print(
        f"agreement {agreement['percent']}%, {agreement['kind']} kappa {agreement['kappa']}"
        + (" (low agreement)" if agreement["low"] else "")
    )
    print(f"splits {result['splits']}, missing answers {len(result['gaps'])}")
    print(f"controls judged correct: {result['controls_judged_correct']}")
    print(f"wrote {out}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    exporter = sub.add_parser("export")
    exporter.add_argument("report")
    exporter.add_argument("--seed", type=int, required=True)
    exporter.add_argument("--reviewers", type=int, default=3)
    exporter.add_argument("--out")
    scorer = sub.add_parser("score")
    scorer.add_argument("packet")
    scorer.add_argument("answers", nargs="+", help="R1=path.csv")
    args = parser.parse_args()
    try:
        return export(args) if args.command == "export" else score(args)
    except br.ReviewError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
