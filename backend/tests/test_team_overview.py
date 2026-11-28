"""WS3 T4: a manager of several groups compares them, each under the minimum size."""

import pytest
from app.team_data import activity
from test_team_consent import build_team, make_app

OLD = 1_700_000_000


@pytest.fixture
def team():
    return build_team(make_app())


def as_demo(app):
    """The comparison is checked on a demo organisation: every figure comes from the mock."""
    with app.state.storage.connect() as db:
        db.execute("UPDATE organisations SET demo=TRUE")


def fill(app, group, count, prefix):
    """Synthetic members who use AdaptAI every week in the mock source."""
    identifiers, number = [], 0
    while len(identifiers) < count:
        number += 1
        candidate = f"{prefix}-{number}"
        if activity(candidate) >= 1:
            identifiers.append(candidate)
    with app.state.storage.connect() as db:
        for identifier in identifiers:
            db.execute(
                "INSERT INTO users(id,email,password_hash) VALUES (%s,%s,'!')",
                (identifier, f"{identifier}@example.invalid"),
            )
            db.execute(
                "INSERT INTO group_members(group_id,user_id,role,joined_at) "
                "VALUES (%s,%s,'member',%s)",
                (group, identifier, OLD),
            )


def test_a_manager_compares_their_groups_on_the_dashboard_figures(team):
    fill(team["app"], team["group"], 6, "eng")
    as_demo(team["app"])
    manager = team["manager"]

    body = manager.get("/api/teams/overview").json()
    single = manager.get(f"/api/groups/{team['group']}/dashboard").json()

    groups = {g["name"]: g for g in body["groups"]}
    assert set(groups) == {"Engineering", "Support"}
    assert groups["Engineering"]["totals"] == single["totals"] is not None
    assert groups["Engineering"]["organisation"] == "Acme"
    # Support has two people: under the minimum, so no number at all.
    assert groups["Support"] == {
        "id": team["second"],
        "name": "Support",
        "organisation": "Acme",
        "source": "mock",
        "enough_members": False,
        "totals": None,
    }


def test_the_overview_lists_only_the_groups_the_caller_runs(team):
    assert team["member"].get("/api/teams/overview").json()["groups"] == []
    assert team["outsider"].get("/api/teams/overview").json()["groups"] == []
    assert len(team["admin"].get("/api/teams/overview").json()["groups"]) == 2


def test_the_overview_rejects_more_than_twelve_weeks(team):
    assert team["manager"].get("/api/teams/overview?weeks=13").status_code == 422
