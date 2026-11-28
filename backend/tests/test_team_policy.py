"""WS3 T1b: the organisation admin turns pause and start over on or off (WS4 L17)."""

import pytest
from app.team_policy import is_paused
from fastapi.testclient import TestClient
from test_team_consent import account, build_team, make_app, user_id


@pytest.fixture
def team():
    return build_team(make_app())


def organisation(team):
    return team["admin"].get("/api/organisations").json()[0]


def set_policy(client, organisation_id, pause, reset):
    return client.put(
        f"/api/organisations/{organisation_id}/learning-policy",
        json={"allow_pause": pause, "allow_reset": reset},
    )


def test_pause_and_start_over_are_allowed_by_default(team):
    body = team["member"].get("/api/learning/settings").json()

    assert body["can_pause"] is True and body["can_reset"] is True
    assert organisation(team)["allow_pause"] is True


def test_the_admin_turns_them_off_and_the_learning_endpoints_obey(team):
    member = team["member"]
    assert set_policy(team["admin"], organisation(team)["id"], False, False).status_code == 200

    body = member.get("/api/learning/settings").json()

    assert body["can_pause"] is False and body["can_reset"] is False
    assert member.put("/api/learning/settings", json={"paused": True}).status_code == 403
    assert member.post("/api/learning/reset", json={}).status_code == 403
    assert member.put("/api/learning/settings", json={"paused": False}).status_code == 200


def test_a_pause_chosen_earlier_stops_applying_and_returns_when_allowed_again(team):
    member = team["member"]
    identifier = organisation(team)["id"]
    assert member.put("/api/learning/settings", json={"paused": True}).json()["paused"] is True

    set_policy(team["admin"], identifier, False, True)

    assert member.get("/api/learning/settings").json()["paused"] is False
    with team["app"].state.storage.connect() as db:
        assert is_paused(db, user_id(member)) is False
    set_policy(team["admin"], identifier, True, True)
    # Turning learning "off" while pausing was forbidden did not happen: the old choice is back.
    assert member.get("/api/learning/settings").json()["paused"] is True


def test_people_outside_the_groups_are_not_affected(team):
    set_policy(team["admin"], organisation(team)["id"], False, False)

    assert team["outsider"].get("/api/learning/settings").json()["can_pause"] is True
    group, other = team["group"], team["other"]
    assert other.delete(f"/api/groups/{group}/members/{user_id(other)}").status_code == 200
    assert other.get("/api/learning/settings").json()["can_reset"] is True


def test_the_strictest_organisation_wins(team):
    second = account(team["app"], "second-admin@example.com")
    org = second.post("/api/organisations", json={"name": "Beta"}).json()
    group = second.post(f"/api/organisations/{org['id']}/groups", json={"name": "B"}).json()
    invite = second.post(f"/api/groups/{group['id']}/invites", json={}).json()
    team["member"].post("/api/invites/accept", json={"token": invite["token"]})

    set_policy(second, org["id"], True, False)

    body = team["member"].get("/api/learning/settings").json()
    assert body["can_pause"] is True and body["can_reset"] is False


def test_only_an_admin_with_a_browser_session_changes_the_policy(team):
    identifier = organisation(team)["id"]

    assert set_policy(team["manager"], identifier, False, False).status_code == 403
    assert set_policy(team["outsider"], identifier, False, False).status_code == 404
    token = team["admin"].post("/api/tokens", json={"name": "ide"}).json()["token"]
    response = TestClient(team["app"]).put(
        f"/api/organisations/{identifier}/learning-policy",
        json={"allow_pause": False, "allow_reset": False},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code in (401, 403)
