"""Group dashboard (WS3 T2, ADR-016): tokens, estimated cost and performance of a group, by week.

Aggregates only. A week shows numbers when at least ``MIN_GROUP_SIZE`` members *contributed* in it
(had at least one usage record); otherwise it says "not enough members". A member counts in a week
only if they joined the group before that week started (ADR-016 rule 7). Removed members are not in
the group, so they are in no new aggregate. Totals add up the weeks that are shown, never the
suppressed ones, so a total cannot be used to recover a hidden week.

Only admins of the organisation and managers of the group can open it. The data comes from a
source (``app.team_data.MockSource`` until the WS1 gateway and WS4 events exist).
"""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, date, datetime, timedelta

from fastapi import APIRouter, FastAPI, Query, Response

from app.accounts import AuthenticatedUser
from app.storage import Storage
from app.team_data import MockSource
from app.team_learning import group_learning, stored_events
from app.teams import ADMIN, MANAGER, managed_groups, members_of, require_group

MIN_GROUP_SIZE = 5
MAX_WEEKS = 12


def monday(day: date) -> date:
    return day - timedelta(days=day.weekday())


def week_starts(today: date, weeks: int) -> list[date]:
    """Mondays of the last ``weeks`` weeks, oldest first; the last is the current (open) week."""
    current = monday(today)
    return [current - timedelta(weeks=n) for n in range(weeks - 1, -1, -1)]


def _epoch(day: date) -> int:
    return int(datetime(day.year, day.month, day.day, tzinfo=UTC).timestamp())


def _rate(part: int, whole: int) -> float | None:
    return round(100 * part / whole, 1) if whole else None


def _figures(usage: list[dict], events: list[dict]) -> dict:
    decisions = [e for e in events if e["event"] == "recommendation_decided"]
    outcomes = [e for e in events if e["event"] == "outcome_reported"]
    return {
        "calls": len(usage),
        "tokens_in": sum(r["tokens_in"] for r in usage),
        "tokens_out": sum(r["tokens_out"] for r in usage),
        "est_cost_eur": round(sum(r["est_cost_eur"] for r in usage), 4),
        "tasks": len(decisions),
        "acceptance_rate": _rate(sum(e["sizing"] == "match" for e in decisions), len(decisions)),
        "over_sized_rate": _rate(sum(e["sizing"] == "over" for e in decisions), len(decisions)),
        "under_sized_rate": _rate(sum(e["sizing"] == "under" for e in decisions), len(decisions)),
        "feedback": len(outcomes),
        "resolved_rate": _rate(sum(e["resolved"] == "yes" for e in outcomes), len(outcomes)),
        "partly_rate": _rate(sum(e["resolved"] == "partly" for e in outcomes), len(outcomes)),
    }


def _stored_figures(events: list[dict], k: int) -> dict:
    """Figures from the stored events (T2). Each needs ``k`` people of its own: a week with many
    active members but one who answered would otherwise show that person's answers."""

    def of(kind: str) -> list[dict]:
        found = [e for e in events if e["event"] == kind]
        return found if len({e["user_id"] for e in found}) >= k else []

    analysed, decisions = of("task_analysed"), of("recommendation_decided")
    outcomes, assessed = of("outcome_reported"), of("request_assessed")
    surfaces = {
        name: {e["user_id"] for e in analysed if e["surface"] == name} for name in ("web", "ide")
    }
    # The split is shown only when no side of it stands for a few people.
    split = any(surfaces.values()) and all(
        not people or len(people) >= k for people in surfaces.values()
    )
    return {
        "tasks": len(analysed) if analysed else None,
        "acceptance_rate": _rate(sum(e["sizing"] == "match" for e in decisions), len(decisions)),
        "over_sized_rate": _rate(sum(e["sizing"] == "over" for e in decisions), len(decisions)),
        "under_sized_rate": _rate(sum(e["sizing"] == "under" for e in decisions), len(decisions)),
        "feedback": len(outcomes) if outcomes else None,
        "resolved_rate": _rate(sum(e["resolved"] == "yes" for e in outcomes), len(outcomes)),
        "partly_rate": _rate(sum(e["resolved"] == "partly" for e in outcomes), len(outcomes)),
        "clear_rate": _rate(sum(e["clear"] for e in assessed), sum(e["of"] for e in assessed)),
        "web_tasks": sum(e["surface"] == "web" for e in analysed) if split else None,
        "ide_tasks": sum(e["surface"] == "ide" for e in analysed) if split else None,
    }


def dashboard(
    members: list[dict],
    usage: list[dict],
    events: list[dict],
    today: date,
    weeks: int,
    k: int = MIN_GROUP_SIZE,
    stored: bool = False,
) -> dict:
    """The dashboard body for ``members`` ({user_id, joined_at}) and their records."""
    starts = week_starts(today, weeks)
    joined = {m["user_id"]: m["joined_at"] for m in members}
    by_week_usage: dict[date, list[dict]] = defaultdict(list)
    by_week_events: dict[date, list[dict]] = defaultdict(list)
    for record in usage:
        start = monday(datetime.fromtimestamp(record["created_at"], UTC).date())
        if record["user_id"] in joined and joined[record["user_id"]] < _epoch(start):
            by_week_usage[start].append(record)
    for event in events:
        start = monday(datetime.fromtimestamp(event["created_at"], UTC).date())
        if event["user_id"] in joined and joined[event["user_id"]] < _epoch(start):
            by_week_events[start].append(event)

    def figures(week_usage: list[dict], week_events: list[dict]) -> dict:
        body = _figures(week_usage, week_events)
        return body | _stored_figures(week_events, k) if stored else body

    rows, shown_usage, shown_events = [], [], []
    for start in starts:
        week_usage = by_week_usage.get(start, [])
        contributors = len({record["user_id"] for record in week_usage})
        if stored:  # real activity decides, not the synthetic usage records
            contributors = len({e["user_id"] for e in by_week_events.get(start, [])})
        row = {"week": start.isoformat(), "open": start == starts[-1]}
        if contributors < k:
            rows.append({**row, "enough_members": False})
            continue
        week_events = by_week_events.get(start, [])
        shown_usage += week_usage
        shown_events += week_events
        rows.append({**row, "enough_members": True, **figures(week_usage, week_events)})
    shown = [row for row in rows if row["enough_members"]]
    dates = sorted({record["price_catalog_date"] for record in shown_usage})
    return {
        "min_group_size": k,
        "enough_members": len(members) >= k and bool(shown),
        "weeks": rows,
        "totals": figures(shown_usage, shown_events) if shown else None,
        "price_catalog_date": dates[-1] if dates else None,
    }


def install_team_dashboard(app: FastAPI, store: Storage, source=None, clock=None) -> None:
    """``source`` gives the token and cost records (mock until WS1's C1). Real organisations
    read choices, feedback and request quality from the stored data; demo ones stay all mock."""
    source = source or MockSource()
    clock = clock or (lambda: datetime.now(UTC).date())
    router = APIRouter(prefix="/api")

    def figures_for(members: list[dict], weeks: int, demo: bool) -> dict:
        today = clock()
        starts = week_starts(today, weeks)
        ids = [m["user_id"] for m in members]
        usage, events = source.records(ids, starts[0], today)
        if not demo:
            events = stored_events(store, ids, starts[0], today)
        return {
            "source": source.name if demo else "stored",
            "usage_source": source.name,
            **dashboard(members, usage, events, today, weeks, stored=not demo),
        }

    def is_demo(db, organisation_id: str) -> bool:
        return db.execute(
            "SELECT demo FROM organisations WHERE id=%s", (organisation_id,)
        ).fetchone()["demo"]

    @router.get("/groups/{group_id}/learning")
    def learning(
        group_id: str,
        response: Response,
        user: AuthenticatedUser,
        weeks: int = Query(default=4, ge=1, le=MAX_WEEKS),
    ):
        """TL1 to TL4 (interim, see ``app.team_learning``)."""
        response.headers["Cache-Control"] = "no-store"
        with store.connect() as db:
            require_group(db, user["id"], group_id, {ADMIN, MANAGER})
            members = [dict(row) for row in members_of(db, group_id)]
        return group_learning(store, members, clock(), weeks, MIN_GROUP_SIZE)

    @router.get("/teams/overview")
    def overview(
        response: Response,
        user: AuthenticatedUser,
        weeks: int = Query(default=4, ge=1, le=MAX_WEEKS),
    ):
        """T4: every group the caller runs, on the same figures, each under the minimum size."""
        response.headers["Cache-Control"] = "no-store"
        with store.connect() as db:
            groups = [
                (
                    dict(group),
                    [dict(row) for row in members_of(db, group["id"])],
                    is_demo(db, group["organisation_id"]),
                )
                for group in managed_groups(db, user["id"])
            ]
            names = {
                row["id"]: row["name"]
                for row in db.execute(
                    "SELECT id,name FROM organisations WHERE id = ANY(%s)",
                    (list({group["organisation_id"] for group, _, _ in groups}),),
                ).fetchall()
            }
        result = []
        for group, members, demo in groups:
            body = figures_for(members, weeks, demo)
            result.append(
                {
                    "id": group["id"],
                    "name": group["name"],
                    "organisation": names[group["organisation_id"]],
                    "source": body["source"],
                    "enough_members": body["enough_members"],
                    "totals": body["totals"] if body["enough_members"] else None,
                }
            )
        return {
            "usage_source": source.name,
            "min_group_size": MIN_GROUP_SIZE,
            "weeks": weeks,
            "groups": result,
        }

    @router.get("/groups/{group_id}/dashboard")
    def group_dashboard(
        group_id: str,
        response: Response,
        user: AuthenticatedUser,
        weeks: int = Query(default=4, ge=1, le=MAX_WEEKS),
    ):
        response.headers["Cache-Control"] = "no-store"
        with store.connect() as db:
            group = require_group(db, user["id"], group_id, {ADMIN, MANAGER})
            members = [dict(row) for row in members_of(db, group_id)]
            demo = is_demo(db, group["organisation_id"])
        return {
            "group": {"id": group["id"], "name": group["name"]},
            **figures_for(members, weeks, demo),
        }

    app.include_router(router)
