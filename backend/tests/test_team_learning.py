"""WS3 T2 on stored data and TL1 to TL5 (interim until WS4's TL0). Runs on the test database."""

import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from app.learning_engine import DIMENSIONS
from test_team_consent import build_team, make_app

MARKER = "ZEBRA-MARKER-7731"
OLD = 1_700_000_000
NOW = datetime.now(UTC)
LAST_WEEK = (NOW - timedelta(days=NOW.weekday() + 4)).strftime("%Y-%m-%dT10:00:00.000Z")
THIS_WEEK = (NOW - timedelta(days=NOW.weekday())).strftime("%Y-%m-%dT00:00:01.000Z")


@pytest.fixture
def team():
    return build_team(make_app())


def add_members(team, count, at=LAST_WEEK, score=0, outcome="resolved", tasks=5):
    """Synthetic members of the first group, each with ``tasks`` analysed tasks."""
    ids = []
    result = json.dumps({"recommendation": {"id": "a"}, "alternatives": [], "note": MARKER})
    with team["app"].state.storage.connect() as db:
        for _ in range(count):
            owner = str(uuid4())
            ids.append(owner)
            db.execute(
                "INSERT INTO users(id,email,password_hash) VALUES (%s,%s,'!')",
                (owner, f"{owner}@example.invalid"),
            )
            db.execute(
                "INSERT INTO group_members(group_id,user_id,role,joined_at) "
                "VALUES (%s,%s,'member',%s)",
                (team["group"], owner, OLD),
            )
            session = str(uuid4())
            db.execute(
                "INSERT INTO sessions(id,user_id,title) VALUES (%s,%s,%s)", (session, owner, MARKER)
            )
            for _ in range(tasks):
                analysis = str(uuid4())
                db.execute(
                    "INSERT INTO analyses(id,session_id,request_json,result_json,created_at) "
                    "VALUES (%s,%s,%s,%s,%s)",
                    (analysis, session, json.dumps({"task": MARKER}), result, at),
                )
                db.execute(
                    f"INSERT INTO request_quality(analysis_id,user_id,{','.join(DIMENSIONS)},"
                    f"prompt_version) VALUES (%s,%s,{','.join(['%s'] * len(DIMENSIONS))},'t')",
                    (analysis, owner, *[score] * len(DIMENSIONS)),
                )
                if outcome:
                    db.execute(
                        "INSERT INTO task_outcomes(analysis_id,user_id,outcome) VALUES (%s,%s,%s)",
                        (analysis, owner, outcome),
                    )
    return ids


def learning(team, who="manager"):
    return team[who].get(f"/api/groups/{team['group']}/learning")


def dashboard(team):
    return team["manager"].get(f"/api/groups/{team['group']}/dashboard").json()


def test_the_dashboard_of_a_real_group_reads_the_stored_data(team):
    add_members(team, 5)

    body = dashboard(team)

    assert body["source"] == "stored" and body["usage_source"] == "mock"
    assert body["totals"]["tasks"] == 25 and body["totals"]["resolved_rate"] == 100.0
    assert body["totals"]["clear_rate"] == 0.0
    assert body["totals"]["web_tasks"] is None  # no surface column until E0b
    assert MARKER not in json.dumps(body)


def test_a_figure_with_fewer_than_five_people_behind_it_is_hidden(team):
    add_members(team, 5, outcome=None)
    add_members(team, 1, outcome="not_resolved")

    totals = dashboard(team)["totals"]

    assert totals["tasks"] == 30
    assert totals["resolved_rate"] is None and totals["feedback"] is None


def test_web_and_ide_are_split_once_the_surface_exists_and_each_side_has_five(team):
    owners = add_members(team, 10)
    storage = team["app"].state.storage
    with storage.connect() as db:
        db.execute("ALTER TABLE analyses ADD COLUMN surface TEXT NOT NULL DEFAULT 'web'")
        db.execute(
            "UPDATE analyses a SET surface='ide' FROM sessions s "
            "WHERE s.id=a.session_id AND s.user_id = ANY(%s)",
            (owners[:5],),
        )

    totals = dashboard(team)["totals"]
    assert (totals["web_tasks"], totals["ide_tasks"]) == (25, 25)

    with storage.connect() as db:
        db.execute(
            "UPDATE analyses a SET surface='web' FROM sessions s "
            "WHERE s.id=a.session_id AND s.user_id=%s",
            (owners[0],),
        )
    assert dashboard(team)["totals"]["ide_tasks"] is None  # four IDE users


def test_radar_distribution_patterns_and_response_rate(team):
    add_members(team, 3, score=0)
    add_members(team, 2, score=2, outcome=None)

    body = learning(team).json()

    objective = body["dimensions"]["objective"]
    assert objective["median"] == 1 and objective["distribution"] == [3, 0, 0, 2]
    assert objective["previous"] is None
    assert {"code": "missing_dimension", "dimension": "context", "share": 60.0} in body["patterns"]
    assert body["feedback"] == {"enough": True, "response_rate": 60.0}
    assert body["coach"] == {"available": False}
    assert MARKER not in json.dumps(body)


def test_below_five_members_there_is_no_learning_number(team):
    add_members(team, 2)  # with the member and "other": four people, the manager is a fifth

    body = learning(team).json()

    assert all(item == {"enough": False} for item in body["dimensions"].values())
    assert body["patterns"] == [] and body["feedback"] == {"enough": False}


def test_the_open_week_is_left_out(team):
    add_members(team, 5, at=THIS_WEEK)

    assert learning(team).json()["dimensions"]["objective"] == {"enough": False}


def test_coach_adoption_once_coach_uses_exists(team):
    add_members(team, 6)
    with team["app"].state.storage.connect() as db:
        db.execute("CREATE TABLE coach_uses(analysis_id TEXT PRIMARY KEY, accepted BOOLEAN)")
        db.execute("INSERT INTO coach_uses SELECT id, TRUE FROM analyses")

    coach = learning(team).json()["coach"]

    assert coach["accepted_rate"] == 100.0 and coach["solved_when_accepted"] == 100.0
    assert coach["solved_when_not"] is None


def test_only_managers_and_admins_read_the_aggregates(team):
    assert learning(team, "admin").status_code == 200
    assert learning(team, "member").status_code == 403
    assert learning(team, "outsider").status_code == 404


def test_the_manager_picks_a_goal_and_members_see_it_with_the_group_progress(team):
    add_members(team, 5, at=THIS_WEEK, score=2, tasks=2)
    path = f"/api/groups/{team['group']}/goal"
    assert "follow_recommendation" in team["manager"].get(path).json()["suggestions"]

    chosen = team["manager"].put(path, json={"code": "state_context"})

    assert chosen.json()["goal"] == {
        "code": "state_context",
        "enough_members": True,
        "met": 10,
        "tasks": 10,
    }
    mine = team["member"].get("/api/progress/team-goals").json()["goals"]
    assert [item["goal"]["code"] for item in mine] == ["state_context"]
    assert "suggestions" not in team["member"].get(path).json()
    assert team["member"].put(path, json={"code": "state_context"}).status_code == 403
    assert team["manager"].put(path, json={"code": "write_more"}).status_code == 422


def test_goal_progress_is_hidden_when_few_people_worked_this_week(team):
    add_members(team, 1, at=THIS_WEEK)
    team["manager"].put(f"/api/groups/{team['group']}/goal", json={"code": "state_context"})

    goal = team["other"].get(f"/api/groups/{team['group']}/goal").json()["goal"]

    assert goal["enough_members"] is False and goal["met"] is None and goal["tasks"] is None
