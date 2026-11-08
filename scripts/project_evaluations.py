"""What the project's own key has measured (ADR-014 A10, layer 3).

    uv run python scripts/project_evaluations.py

Reads the database of the running app (ADAPTAI_DATABASE_URL in .env). Prints whether the key
is set (never the key), the calls used today against the daily limit, the total spent against
the budget, the next models in line, and every project run with its levels or failure.
"""

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.catalogue import active_catalogue  # noqa: E402
from app.evaluations import PROJECT_CONFIGURATION, Ratings, project_targets  # noqa: E402
from app.providers import Settings  # noqa: E402
from app.storage import Storage  # noqa: E402


def main() -> int:
    settings = Settings()
    store = Storage(settings.database_url.get_secret_value(), settings.database_schema)
    has_key = bool(settings.evaluation_openrouter_key.get_secret_value())
    today = time.strftime("%Y-%m-%d", time.gmtime())
    with store.connect() as db:
        rows = [
            dict(row)
            for row in db.execute(
                "SELECT model,status,progress,total,errors,spent_usd,failure,levels_json,"
                "updated_at FROM model_evaluations WHERE configuration_id=%s "
                "ORDER BY sequence_id",
                (PROJECT_CONFIGURATION,),
            ).fetchall()
        ]
    calls_today = sum(r["progress"] for r in rows if r["updated_at"].startswith(today))
    spent = sum(float(r["spent_usd"] or 0) for r in rows)
    print(f"Project key set: {'yes' if has_key else 'NO (ADAPTAI_EVALUATION_OPENROUTER_KEY)'}")
    print(f"Calls today: {calls_today} of {settings.evaluation_daily_calls}")
    print(
        f"Spent: {spent:.4f} USD of {settings.evaluation_budget_usd:.2f}; "
        f"paid models {'on' if settings.evaluation_paid else 'off'}"
    )
    waiting = [t.model for t in project_targets(settings, Ratings(store, active_catalogue()))]
    measured = {r["model"] for r in rows if r["status"] == "done"}
    waiting = [model for model in waiting if model not in measured]
    print(f"In line ({len(waiting)}): {', '.join(waiting[:8])}{' …' if len(waiting) > 8 else ''}")
    print("\n| Model | Status | Calls | Levels or failure | Updated |\n|---|---|---|---|---|")
    for row in rows:
        levels = json.loads(row["levels_json"] or "null")
        detail = (
            " ".join(f"{name[:4]} {item['level']}" for name, item in levels.items())
            if levels
            else row["failure"] or ""
        )
        print(
            f"| {row['model']} | {row['status']} | {row['progress']}/{row['total']} "
            f"| {detail} | {row['updated_at'][:16]} |"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
