import json

import pytest
from app.assessment import POLICY_VERSION, completeness, explain_changes
from app.main import create_app
from app.models import Assessment, Profile
from app.providers import Settings
from fastapi.testclient import TestClient
from profile_samples import profile_data
from test_profiles import analyse

PASSWORD = "test-password-123"
DIMENSIONS = ("reasoning", "context", "ambiguity", "domain", "risk", "tools")


class Scripted:
    """Returns the queued profiles in order, one per assessment."""

    def __init__(self, *profiles):
        self.profiles = list(profiles)
        self.calls = 0

    async def assess(self, task):
        self.calls += 1
        return Assessment(profile=Profile.model_validate(self.profiles.pop(0)))


def client_for(assessor, email="changes@example.com", app=None):
    app = app or create_app(Settings(_env_file=None), {"ollama": assessor})
    client = TestClient(app)
    response = client.post("/api/auth/register", json={"email": email, "password": PASSWORD})
    assert response.status_code == 201
    return client


def post(client, **request):
    return client.post(
        "/api/analyze", json={"task": "Synthetic task", "provider": "ollama", **request}
    )


def high_confidence_profile():
    data = profile_data()
    for key in (*DIMENSIONS, "modality"):
        data[key]["confidence"] = "high"
    return Profile.model_validate(data)


def undetermined_profile():
    data = profile_data(**{key: None for key in DIMENSIONS})
    data["modality"] = {"required": None, "confidence": "undetermined", "evidence": "Unknown"}
    return Profile.model_validate(data)


def test_policy_version_is_bumped():
    assert POLICY_VERSION == "prototype-3"


def test_fully_determined_confident_profile_is_complete():
    assert completeness(high_confidence_profile(), provisional=False) == 100


def test_undetermined_provisional_profile_is_empty():
    assert completeness(undetermined_profile(), provisional=True) == 0


def test_mid_completeness_matches_hand_calculation():
    # 6 of 7 determined, 5 of 7 medium/high, ambiguity 2 -> 0.6, provisional:
    # 100 * (0.4 * 6/7 + 0.3 * 5/7 + 0.2 * 0.6 + 0) = 67.71 -> 68
    data = profile_data(reasoning=None, ambiguity=2)
    data["modality"]["confidence"] = "low"
    assert completeness(Profile.model_validate(data), provisional=True) == 68


@pytest.mark.parametrize(("ambiguity", "expected"), [(1, 100), (2, 92), (3, 84)])
def test_ambiguity_weight(ambiguity, expected):
    profile = Profile.model_validate(profile_data(ambiguity=ambiguity))
    assert completeness(profile, provisional=False) == expected


def test_response_includes_completeness_and_no_changes_without_previous():
    result = analyse(profile_data()).json()
    assert result["completeness"] == 100
    assert result["changes"] == []
    assert result["previous_analysis_id"] is None
    assert result["policy_version"] == "prototype-3"


def test_explain_changes_reads_only_values_from_previous():
    previous = {"risk": {"score": None}, "modality": {"required": ["text"]}}
    current = Profile.model_validate(profile_data(risk=3))
    changes = explain_changes(previous, current)
    assert [change.model_dump() for change in changes if change.dimension == "risk"] == [
        {"dimension": "risk", "before": None, "after": 3, "evidence": "Synthetic test evidence"}
    ]
    assert "modality" not in {change.dimension for change in changes}


def test_reanalysis_explains_changed_dimensions_only():
    first = profile_data(risk=None)
    second = profile_data(risk=3)
    second["risk"]["evidence"] = "Errors could affect a payment"
    second["modality"]["required"] = ["text", "image"]
    second["modality"]["evidence"] = "A screenshot is attached"
    assessor = Scripted(first, second)
    client = client_for(assessor)
    before = post(client).json()
    after = post(client, session_id=before["session_id"], previous_analysis_id=before["id"])
    assert after.status_code == 200
    result = after.json()
    assert result["previous_analysis_id"] == before["id"]
    assert result["changes"] == [
        {
            "dimension": "risk",
            "before": None,
            "after": 3,
            "evidence": "Errors could affect a payment",
        },
        {
            "dimension": "modality",
            "before": ["text"],
            "after": ["text", "image"],
            "evidence": "A screenshot is attached",
        },
    ]
    assert result["completeness"] == completeness(
        Profile.model_validate(second), result["recommendation_provisional"]
    )


def test_stored_changes_drop_evidence():
    assessor = Scripted(profile_data(risk=None), profile_data(risk=3))
    client = client_for(assessor)
    before = post(client).json()
    after = post(client, session_id=before["session_id"], previous_analysis_id=before["id"]).json()
    with client.app.state.storage.connect() as db:
        row = db.execute("SELECT result_json FROM analyses WHERE id=?", (after["id"],)).fetchone()
    stored = json.loads(row["result_json"])
    assert stored["changes"] == [{"dimension": "risk", "before": None, "after": 3}]
    assert all("evidence" not in change for change in stored["changes"])
    assert stored["completeness"] == after["completeness"]
    assert stored["previous_analysis_id"] == before["id"]
    history = client.get(f"/api/sessions/{before['session_id']}").json()
    assert history["analyses"][1]["result"]["changes"] == stored["changes"]


def test_previous_analysis_requires_session():
    assessor = Scripted(profile_data())
    client = client_for(assessor)
    response = post(client, previous_analysis_id="00000000-0000-0000-0000-000000000000")
    assert response.status_code == 422
    assert response.json() == {"detail": "previous_analysis_requires_session"}
    assert assessor.calls == 0
    assert client.get("/api/sessions").json() == []


def test_previous_analysis_of_another_user_is_not_found():
    assessor = Scripted(profile_data(), profile_data())
    app = create_app(Settings(_env_file=None), {"ollama": assessor})
    alice = client_for(assessor, "alice@example.com", app)
    bob = client_for(assessor, "bob@example.com", app)
    theirs = post(alice).json()
    session = bob.post("/api/sessions", json={}).json()
    response = post(bob, session_id=session["id"], previous_analysis_id=theirs["id"])
    assert response.status_code == 404
    assert response.json() == {"detail": "analysis_not_found"}
    unknown = post(
        bob, session_id=session["id"], previous_analysis_id="00000000-0000-0000-0000-000000000000"
    )
    assert unknown.status_code == 404
    assert assessor.calls == 1


def test_previous_analysis_of_another_session_is_rejected():
    assessor = Scripted(profile_data(), profile_data())
    client = client_for(assessor)
    first = post(client).json()
    other = client.post("/api/sessions", json={}).json()
    response = post(client, session_id=other["id"], previous_analysis_id=first["id"])
    assert response.status_code == 422
    assert response.json() == {"detail": "previous_analysis_other_session"}
    assert assessor.calls == 1


def test_previous_analysis_with_other_profile_version_is_incompatible():
    assessor = Scripted(profile_data(), profile_data())
    client = client_for(assessor)
    first = post(client).json()
    with client.app.state.storage.connect() as db:
        db.execute(
            "UPDATE analyses SET result_json=json_set(result_json,'$.profile_version','profile-1') "
            "WHERE id=?",
            (first["id"],),
        )
    response = post(client, session_id=first["session_id"], previous_analysis_id=first["id"])
    assert response.status_code == 422
    assert response.json() == {"detail": "previous_analysis_incompatible"}
    assert assessor.calls == 1


def test_previous_analysis_id_is_bounded():
    assessor = Scripted(profile_data())
    client = client_for(assessor)
    session = client.post("/api/sessions", json={}).json()
    response = post(client, session_id=session["id"], previous_analysis_id="x" * 37)
    assert response.status_code == 422
