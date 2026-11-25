"""WS3 T1 Team Scope: organisations, groups, roles and membership (ADR-016, docs/ws3/README.md).

One test per role proves what it can and cannot read or change (admin, manager, member, outsider),
plus invites, removal and the cascade on account deletion. Runs against the test database.
"""

import pytest
from app.main import create_app
from app.providers import Settings
from fastapi.testclient import TestClient

PASSWORD = "correct horse battery"


@pytest.fixture
def app():
    return create_app(Settings(_env_file=None))


def account(app, email):
    client = TestClient(app)
    assert client.post(
        "/api/auth/register", json={"email": email, "password": PASSWORD}
    ).status_code in (200, 201)
    return client


def join(client, invite):
    return client.post("/api/invites/accept", json={"token": invite["token"]})


@pytest.fixture
def team(app):
    """An organisation with one group: admin, a manager, a member and an outsider."""
    admin = account(app, "admin@example.com")
    manager = account(app, "manager@example.com")
    member = account(app, "member@example.com")
    outsider = account(app, "outsider@example.com")
    organisation = admin.post("/api/organisations", json={"name": "Acme"}).json()
    group = admin.post(
        f"/api/organisations/{organisation['id']}/groups", json={"name": "Engineering"}
    ).json()

    def invite(role):
        return admin.post(f"/api/groups/{group['id']}/invites", json={"role": role}).json()

    assert join(manager, invite("manager")).status_code == 200
    assert join(member, invite("member")).status_code == 200
    return {
        "organisation": organisation,
        "group": group,
        "admin": admin,
        "manager": manager,
        "member": member,
        "outsider": outsider,
    }


def user_id(client):
    return client.get("/api/auth/me").json()["id"]


def test_admin_creates_groups_lists_members_and_removes_them(team):
    admin, group = team["admin"], team["group"]

    listed = admin.get(f"/api/groups/{group['id']}/members").json()
    member_id = user_id(team["member"])
    removed = admin.delete(f"/api/groups/{group['id']}/members/{member_id}")

    assert {m["email"] for m in listed["members"]} == {"manager@example.com", "member@example.com"}
    assert removed.status_code == 200
    after = admin.get(f"/api/groups/{group['id']}/members").json()["members"]
    assert member_id not in {m["user_id"] for m in after}


def test_manager_sees_the_dashboard_but_not_the_member_list_and_cannot_change_the_team(team):
    manager, group = team["manager"], team["group"]

    assert manager.get(f"/api/groups/{group['id']}/dashboard").status_code == 200
    assert manager.get(f"/api/groups/{group['id']}/members").status_code == 403
    assert manager.post(f"/api/groups/{group['id']}/invites", json={}).status_code == 403
    assert (
        manager.delete(f"/api/groups/{group['id']}/members/{user_id(team['member'])}").status_code
        == 403
    )
    organisation = team["organisation"]["id"]
    assert (
        manager.post(f"/api/organisations/{organisation}/groups", json={"name": "X"}).status_code
        == 403
    )


def test_member_sees_only_their_group_name_and_no_team_data(team):
    member, group = team["member"], team["group"]

    organisations = member.get("/api/organisations").json()

    assert organisations[0]["groups"] == [
        {"id": group["id"], "name": "Engineering", "role": "member", "size": None}
    ]
    assert member.get(f"/api/groups/{group['id']}/dashboard").status_code == 403
    assert member.get(f"/api/groups/{group['id']}/members").status_code == 403


def test_outsider_cannot_tell_the_group_exists(team):
    outsider, group = team["outsider"], team["group"]

    assert outsider.get("/api/organisations").json() == []
    for path in (f"/api/groups/{group['id']}/dashboard", f"/api/groups/{group['id']}/members"):
        response = outsider.get(path)
        assert response.status_code == 404 and response.json()["detail"] == "group_not_found"


def test_a_manager_can_manage_several_groups(app, team):
    admin, manager = team["admin"], team["manager"]
    second = admin.post(
        f"/api/organisations/{team['organisation']['id']}/groups", json={"name": "Support"}
    ).json()
    invite = admin.post(f"/api/groups/{second['id']}/invites", json={"role": "manager"}).json()

    assert join(manager, invite).status_code == 200

    roles = {g["name"]: g["role"] for g in manager.get("/api/organisations").json()[0]["groups"]}
    assert roles == {"Engineering": "manager", "Support": "manager"}


def test_an_invite_works_once_and_a_used_revoked_or_unknown_link_gives_one_answer(app, team):
    admin, group = team["admin"], team["group"]
    invite = admin.post(f"/api/groups/{group['id']}/invites", json={}).json()
    revoked = admin.post(f"/api/groups/{group['id']}/invites", json={}).json()
    admin.delete(f"/api/groups/{group['id']}/invites/{revoked['id']}")
    newcomer = account(app, "new@example.com")

    assert join(newcomer, invite).status_code == 200
    for token in (invite["token"], revoked["token"], "adaptai_inv_" + "x" * 30):
        response = team["outsider"].post("/api/invites/accept", json={"token": token})
        assert response.status_code == 404 and response.json()["detail"] == "invite_not_valid"


def test_an_invite_bound_to_an_email_is_refused_to_anyone_else(team):
    admin, group = team["admin"], team["group"]
    invite = admin.post(
        f"/api/groups/{group['id']}/invites", json={"email": "Someone@Example.com"}
    ).json()

    response = join(team["outsider"], invite)

    assert response.status_code == 403 and response.json()["detail"] == "invite_for_another_email"


def test_the_invite_token_is_stored_only_as_a_hash(app, team):
    invite = team["admin"].post(f"/api/groups/{team['group']['id']}/invites", json={}).json()

    with app.state.storage.connect() as db:
        stored = [tuple(row) for row in db.execute("SELECT * FROM group_invites").fetchall()]

    assert invite["token"] not in repr(stored)


def test_a_member_can_leave_and_cannot_remove_others(team):
    member, group = team["member"], team["group"]
    manager_id = user_id(team["manager"])

    assert member.delete(f"/api/groups/{group['id']}/members/{manager_id}").status_code == 403
    assert member.delete(f"/api/groups/{group['id']}/members/{user_id(member)}").status_code == 200
    assert member.get("/api/organisations").json()[0]["groups"] == []


def test_deleting_an_account_removes_its_memberships(app, team):
    member, group = team["member"], team["group"]
    member_id = user_id(member)

    deleted = member.request(
        "DELETE", "/api/auth/account", json={"email": "member@example.com", "password": PASSWORD}
    )

    assert deleted.status_code in (200, 204), deleted.text
    with app.state.storage.connect() as db:
        rows = db.execute(
            "SELECT count(*) FROM group_members WHERE user_id=%s", (member_id,)
        ).fetchone()[0]
    assert rows == 0
    listed = team["admin"].get(f"/api/groups/{group['id']}/members").json()["members"]
    assert [m["email"] for m in listed] == ["manager@example.com"]


def test_team_writes_need_the_browser_session_not_an_api_token(team):
    admin = team["admin"]
    token = admin.post("/api/tokens", json={"name": "ide"}).json()["token"]
    ide = TestClient(admin.app)

    response = ide.post(
        f"/api/organisations/{team['organisation']['id']}/groups",
        json={"name": "From the IDE"},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 401


def test_group_names_are_unique_per_organisation_and_trimmed(team):
    admin, organisation = team["admin"], team["organisation"]["id"]

    duplicate = admin.post(
        f"/api/organisations/{organisation}/groups", json={"name": "  Engineering "}
    )
    blank = admin.post(f"/api/organisations/{organisation}/groups", json={"name": "   "})

    assert duplicate.status_code == 409 and duplicate.json()["detail"] == "group_name_taken"
    assert blank.status_code == 422
