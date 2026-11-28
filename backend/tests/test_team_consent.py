"""WS3 T3: the member view with consent (ADR-016 rules 4 to 6). Runs against the test database."""

import json
from uuid import uuid4

import pytest
from app.learning_engine import DIMENSIONS
from app.main import create_app
from app.providers import Settings
from fastapi.testclient import TestClient

PASSWORD = "correct horse battery"
MARKER = "ZEBRA-MARKER-7731"


def make_app(enabled=True):
    return create_app(Settings(_env_file=None, team_member_view=enabled))


def account(app, email):
    client = TestClient(app)
    assert client.post(
        "/api/auth/register", json={"email": email, "password": PASSWORD}
    ).status_code in (200, 201)
    return client


def user_id(client):
    return client.get("/api/auth/me").json()["id"]


def build_team(app):
    """Admin (in no group), manager, two members, an outsider, and two groups."""
    team = {
        name: account(app, f"{name}@example.com")
        for name in ("admin", "manager", "member", "other", "outsider")
    }
    admin = team["admin"]
    organisation = admin.post("/api/organisations", json={"name": "Acme"}).json()
    first, second = (
        admin.post(f"/api/organisations/{organisation['id']}/groups", json={"name": name}).json()
        for name in ("Engineering", "Support")
    )

    def join(name, group, role):
        invite = admin.post(f"/api/groups/{group['id']}/invites", json={"role": role}).json()
        response = team[name].post("/api/invites/accept", json={"token": invite["token"]})
        assert response.status_code == 200

    join("manager", first, "manager")
    join("member", first, "member")
    join("other", first, "member")
    join("manager", second, "manager")
    join("member", second, "member")
    return team | {"group": first["id"], "second": second["id"], "app": app}


@pytest.fixture
def team():
    return build_team(make_app())


def add_tasks(app, owner, count=6, score=0):
    """Analysed tasks of ``owner`` with request-quality scores and a marker in their text."""
    with app.state.storage.connect() as db:
        session = str(uuid4())
        db.execute(
            "INSERT INTO sessions(id,user_id,title) VALUES (%s,%s,%s)", (session, owner, MARKER)
        )
        result = json.dumps({"recommendation": {"id": "a"}, "alternatives": [], "note": MARKER})
        for _ in range(count):
            analysis = str(uuid4())
            db.execute(
                "INSERT INTO analyses(id,session_id,request_json,result_json) VALUES (%s,%s,%s,%s)",
                (analysis, session, json.dumps({"task": MARKER}), result),
            )
            db.execute(
                f"INSERT INTO request_quality(analysis_id,user_id,{','.join(DIMENSIONS)},"
                f"prompt_version) VALUES (%s,%s,{','.join(['%s'] * len(DIMENSIONS))},'t')",
                (analysis, owner, *[score] * len(DIMENSIONS)),
            )


def share(client, group, consented=True):
    return client.put(f"/api/groups/{group}/consent", json={"consented": consented})


def test_consent_is_off_by_default_and_a_manager_sees_nobody(team):
    group, manager = team["group"], team["manager"]

    assert team["member"].get(f"/api/groups/{group}/consent").json()["consented"] is False
    assert manager.get(f"/api/groups/{group}/member-views").json() == {
        "enabled": True,
        "members": [],
    }
    hidden = manager.get(f"/api/groups/{group}/member-views/{user_id(team['member'])}")
    assert hidden.status_code == 404


def test_the_manager_sees_exactly_what_the_member_sees_and_never_any_text(team):
    group, member = team["group"], team["member"]
    member_id = user_id(member)
    add_tasks(team["app"], member_id)

    assert share(member, group).json()["consented"] is True
    seen = team["manager"].get(f"/api/groups/{group}/member-views/{member_id}")
    mirror = member.get(f"/api/groups/{group}/consent/view")

    assert seen.status_code == 200 and seen.json() == mirror.json()
    assert seen.json()["tasks"] == 6 and seen.json()["overall_level"] == 1
    assert {p["code"] for p in seen.json()["patterns"]} == {"missing_dimension"}
    assert MARKER not in seen.text and "level_from" not in seen.text
    listed = team["manager"].get(f"/api/groups/{group}/member-views").json()["members"]
    assert [m["email"] for m in listed] == ["member@example.com"]


def test_the_view_uses_the_level_without_hysteresis(team):
    member = team["member"]
    owner = user_id(member)
    # Ten clear tasks, then two weak ones: My progress still says Expert, the window does not.
    add_tasks(team["app"], owner, count=10, score=2)
    add_tasks(team["app"], owner, count=5, score=0)

    seen = member.get(f"/api/groups/{team['group']}/consent/view").json()
    own = member.get("/api/progress/indicators").json()["dimensions"]["objective"]

    assert seen["dimensions"]["objective"]["level"] == own["level_raw"] != own["level"]


def test_revoking_hides_the_data_on_the_next_request(team):
    group, member, manager = team["group"], team["member"], team["manager"]
    path = f"/api/groups/{group}/member-views/{user_id(member)}"
    share(member, group)
    assert manager.get(path).status_code == 200

    assert share(member, group, consented=False).json()["consented"] is False

    assert manager.get(path).status_code == 404
    assert manager.get(f"/api/groups/{group}/member-views").json()["members"] == []


def test_consent_for_one_group_says_nothing_to_the_other(team):
    member = team["member"]
    share(member, team["group"])

    response = team["manager"].get(f"/api/groups/{team['second']}/member-views/{user_id(member)}")

    assert response.status_code == 404


def test_only_managers_and_admins_open_member_views(team):
    group, member = team["group"], team["member"]
    path = f"/api/groups/{group}/member-views/{user_id(member)}"
    share(member, group)

    assert team["admin"].get(path).status_code == 200
    assert team["other"].get(path).status_code == 403
    assert team["other"].get(f"/api/groups/{group}/member-views").status_code == 403
    assert team["outsider"].get(path).status_code == 404
    assert share(team["outsider"], group).status_code == 404
    assert share(team["admin"], group).status_code == 409  # not in the group: nothing to share


def test_leaving_the_group_removes_the_consent(team):
    group, member = team["group"], team["member"]
    share(member, group)

    assert member.delete(f"/api/groups/{group}/members/{user_id(member)}").status_code == 200

    with team["app"].state.storage.connect() as db:
        assert db.execute("SELECT count(*) FROM group_consents").fetchone()[0] == 0


def test_an_api_token_cannot_give_consent(team):
    token = team["member"].post("/api/tokens", json={"name": "ide"}).json()["token"]

    response = TestClient(team["app"]).put(
        f"/api/groups/{team['group']}/consent",
        json={"consented": True},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code in (401, 403)


def test_with_the_flag_off_nobody_sees_a_member_and_nobody_can_opt_in():
    team = build_team(make_app(enabled=False))
    group, member, manager = team["group"], team["member"], team["manager"]
    member_id = user_id(member)
    with team["app"].state.storage.connect() as db:
        db.execute(
            "INSERT INTO group_consents(group_id,user_id,granted_at) VALUES (%s,%s,1)",
            (group, member_id),
        )

    assert share(member, group).status_code == 404
    assert member.get(f"/api/groups/{group}/consent/view").status_code == 404
    assert manager.get(f"/api/groups/{group}/member-views").json() == {
        "enabled": False,
        "members": [],
    }
    assert manager.get(f"/api/groups/{group}/member-views/{member_id}").status_code == 404
    assert share(member, group, consented=False).status_code == 200  # revoking always works


def test_the_flag_is_off_unless_configured(monkeypatch):
    monkeypatch.delenv("ADAPTAI_TEAM_MEMBER_VIEW", raising=False)

    assert Settings(_env_file=None).team_member_view is False
