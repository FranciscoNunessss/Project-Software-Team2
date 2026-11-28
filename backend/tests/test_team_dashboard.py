"""WS3 T2 group dashboard on mock data (ADR-016, docs/ws3/README.md).

The arithmetic and the privacy rules are tested on fixed records (no database); the last tests go
through the API with the deterministic mock source and need the test database.
"""

from datetime import UTC, date, datetime

import pytest
from app import team_dashboard as td
from app.team_data import C1_FIELDS, MockSource, activity, day_records

TODAY = date(2026, 12, 3)  # a Thursday; the open week starts on Monday 30 Nov
OLD = int(datetime(2026, 10, 1, tzinfo=UTC).timestamp())


def at(day: date, hour=10) -> int:
    return int(datetime(day.year, day.month, day.day, hour, tzinfo=UTC).timestamp())


def usage(user, day, tokens_in=100, tokens_out=50, cost=0.01):
    return {
        "user_id": user,
        "created_at": at(day),
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "est_cost_eur": cost,
        "price_catalog_date": "2026-11-06",
    }


def decided(user, day, sizing):
    return {
        "event": "recommendation_decided",
        "user_id": user,
        "created_at": at(day),
        "sizing": sizing,
    }


def outcome(user, day, resolved):
    return {
        "event": "outcome_reported",
        "user_id": user,
        "created_at": at(day),
        "resolved": resolved,
    }


def members(count, joined=OLD):
    return [{"user_id": f"u{n}", "joined_at": joined} for n in range(count)]


WEEK = date(2026, 11, 24)  # a day of the last closed week (Monday 23 Nov)


def test_weeks_are_mondays_oldest_first_with_the_current_week_open():
    assert td.week_starts(TODAY, 3) == [date(2026, 11, 16), date(2026, 11, 23), date(2026, 11, 30)]


def test_a_week_with_enough_contributors_shows_tokens_cost_and_rates():
    group = members(5)
    records = [usage(m["user_id"], date(2026, 11, 24)) for m in group]
    events = [
        decided("u0", WEEK, "match"),
        decided("u1", WEEK, "over"),
        outcome("u2", WEEK, "yes"),
        outcome("u3", WEEK, "no"),
    ]

    body = td.dashboard(group, records, events, TODAY, 2)

    week = body["weeks"][0]
    assert week["enough_members"] is True
    assert (week["tokens_in"], week["tokens_out"], week["est_cost_eur"]) == (500, 250, 0.05)
    assert week["acceptance_rate"] == 50.0 and week["over_sized_rate"] == 50.0
    assert week["resolved_rate"] == 50.0
    assert body["price_catalog_date"] == "2026-11-06"


def test_a_group_below_the_minimum_size_shows_not_enough_members():
    group = members(4)
    records = [usage(m["user_id"], date(2026, 11, 24)) for m in group]

    body = td.dashboard(group, records, [], TODAY, 2)

    assert body["enough_members"] is False and body["totals"] is None
    assert all(
        week["enough_members"] is False and "tokens_in" not in week for week in body["weeks"]
    )


def test_a_week_with_fewer_than_five_contributors_is_hidden_even_in_a_big_group():
    group = members(10)
    records = [usage("u0", date(2026, 11, 24))]  # one person used AdaptAI that week

    week = td.dashboard(group, records, [], TODAY, 2)["weeks"][0]

    assert week == {"week": "2026-11-23", "open": False, "enough_members": False}


def test_totals_add_up_only_the_weeks_shown_so_a_hidden_week_cannot_be_recovered():
    group = members(5)
    shown = [usage(m["user_id"], date(2026, 11, 24)) for m in group]
    hidden = [usage("u0", date(2026, 11, 17), tokens_in=9999)]

    body = td.dashboard(group, shown + hidden, [], TODAY, 3)

    assert body["totals"]["tokens_in"] == 500


def test_a_member_counts_only_from_the_first_full_week_after_joining():
    group = members(5) + [{"user_id": "late", "joined_at": at(date(2026, 11, 25))}]
    records = [usage(m["user_id"], date(2026, 11, 26)) for m in group]

    week = td.dashboard(group, records, [], TODAY, 2)["weeks"][0]

    assert week["tokens_in"] == 500  # the late joiner's 100 tokens are not in that week


def test_a_removed_member_is_in_no_aggregate():
    group = members(5)
    records = [usage(m["user_id"], date(2026, 11, 24)) for m in group]
    records.append(usage("removed", date(2026, 11, 24), tokens_in=7777))

    assert td.dashboard(group, records, [], TODAY, 2)["totals"]["tokens_in"] == 500


def test_mock_records_follow_contract_c1_and_carry_no_text():
    user = next(f"user-{n}" for n in range(50) if activity(f"user-{n}") > 2)
    records, events = MockSource().records([user], date(2026, 11, 1), date(2026, 11, 28))

    assert records and events
    assert all(tuple(record) == C1_FIELDS for record in records)
    assert all(
        isinstance(value, (int, float)) or len(str(value)) < 80
        for r in records
        for value in r.values()
    )
    assert day_records(user, date(2026, 11, 5)) == day_records(user, date(2026, 11, 5))


# --- through the API (test database) ------------------------------------------------------------


def add_weekly_tasks(app, owners):
    """One stored analysis per member on each Monday of the last four weeks."""
    starts = td.week_starts(datetime.now(UTC).date(), 4)
    result = '{"recommendation": {"id": "a"}, "alternatives": []}'
    with app.state.storage.connect() as db:
        for owner in owners:
            db.execute(
                "INSERT INTO sessions(id,user_id,title) VALUES (%s,%s,'t')", (f"s-{owner}", owner)
            )
            for start in starts:
                db.execute(
                    "INSERT INTO analyses(id,session_id,request_json,result_json,created_at) "
                    "VALUES (%s,%s,'{}',%s,%s)",
                    (f"{owner}-{start}", f"s-{owner}", result, f"{start}T00:00:00.000Z"),
                )


PASSWORD = "correct horse battery"


@pytest.fixture
def app():
    from app.main import create_app
    from app.providers import Settings

    return create_app(Settings(_env_file=None))


def test_dashboard_totals_reconcile_with_the_c1_records_of_the_source(app):
    from fastapi.testclient import TestClient

    admin = TestClient(app)
    admin.post("/api/auth/register", json={"email": "boss@example.com", "password": PASSWORD})
    organisation = admin.post("/api/organisations", json={"name": "Acme"}).json()
    group = admin.post(
        f"/api/organisations/{organisation['id']}/groups", json={"name": "Team"}
    ).json()
    with app.state.storage.connect() as db:
        ids = []
        for n in range(8):
            user = f"synthetic-{n}"
            ids.append(user)
            db.execute(
                "INSERT INTO users(id,email,password_hash) VALUES (%s,%s,'!')",
                (user, f"s{n}@example.invalid"),
            )
            db.execute(
                "INSERT INTO group_members(group_id,user_id,role,joined_at) "
                "VALUES (%s,%s,'member',%s)",
                (group["id"], user, OLD),
            )

    body = admin.get(f"/api/groups/{group['id']}/dashboard?weeks=4").json()

    assert body["source"] == "stored" and body["usage_source"] == "mock"
    assert body["min_group_size"] == td.MIN_GROUP_SIZE
    # A real group is shown from its stored activity: give each synthetic member a task a week.
    add_weekly_tasks(app, ids)
    body = admin.get(f"/api/groups/{group['id']}/dashboard?weeks=4").json()
    shown = [week for week in body["weeks"] if week["enough_members"]]
    assert (
        sum(week["tokens_in"] for week in shown)
        == (body["totals"] or {"tokens_in": 0})["tokens_in"]
    )
    today = datetime.now(UTC).date()
    starts = td.week_starts(today, 4)
    records, _ = MockSource().records(ids, starts[0], today)
    expected = sum(
        r["tokens_in"]
        for r in records
        if td.monday(datetime.fromtimestamp(r["created_at"], UTC).date()).isoformat()
        in {w["week"] for w in shown}
    )
    assert sum(week["tokens_in"] for week in shown) == expected


def test_the_dashboard_rejects_more_than_twelve_weeks(app):
    from fastapi.testclient import TestClient

    admin = TestClient(app)
    admin.post("/api/auth/register", json={"email": "boss@example.com", "password": PASSWORD})
    organisation = admin.post("/api/organisations", json={"name": "Acme"}).json()
    group = admin.post(
        f"/api/organisations/{organisation['id']}/groups", json={"name": "Team"}
    ).json()

    assert admin.get(f"/api/groups/{group['id']}/dashboard?weeks=13").status_code == 422
