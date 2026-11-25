"""M1: check two labellers' sheets, report their agreement and build the labelled task set.

    # Agreement and the list of disagreeing cells (share it before the settling meeting):
    python scripts/labelled_set.py agree sheet-A.csv sheet-B.csv
    # After the meeting, with every disagreement settled in resolutions.json:
    python scripts/labelled_set.py build sheet-A.csv sheet-B.csv --resolutions resolutions.json

resolutions.json is a list of {"task", "field", "value", "reason"}. Exit codes: 0 done, 2 a sheet or
a resolution is not usable (every problem is printed). No model is called.
"""

import argparse
import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app import labelled_set as ls  # noqa: E402

OUT = ROOT / "backend/eval/quality/tasks-2.json"


def load(path: str) -> tuple[str, dict]:
    sheet = ls.read_sheet(Path(path))
    return sheet["labeller"], ls.validate(sheet, ls.concrete_models())


def print_report(report: dict) -> None:
    print(f"{report['tasks']} tasks, overall agreement {report['overall']}%")
    for field, cell in report["by_field"].items():
        weighted = f"  weighted {cell['weighted_kappa']}" if "weighted_kappa" in cell else ""
        print(f"  {field:<15} {cell['agreement']}%  kappa {cell['kappa']}{weighted}")
    print(f"{len(report['disagreements'])} disagreeing cells")
    for cell in report["disagreements"]:
        print(f"  {cell['task']}: {cell['field']} A={cell['a']} B={cell['b']}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("agree", "build"):
        command = sub.add_parser(name)
        command.add_argument("first")
        command.add_argument("second")
    sub.choices["build"].add_argument("--resolutions", required=True)
    sub.choices["build"].add_argument("--out", default=str(OUT))
    args = parser.parse_args()
    try:
        name_a, first = load(args.first)
        name_b, second = load(args.second)
        report = ls.compare(first, second)
        print_report(report)
        if args.command == "agree":
            return 0
        try:
            resolutions = json.loads(Path(args.resolutions).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ls.SheetError(
                [f"{args.resolutions}: not a readable JSON list ({error})"]
            ) from error
        document = ls.build(first, second, resolutions, (name_a, name_b), date.today().isoformat())
    except ls.SheetError as error:
        for problem in error.problems:
            print(f"error: {problem}", file=sys.stderr)
        return 2
    Path(args.out).write_text(json.dumps(document, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
