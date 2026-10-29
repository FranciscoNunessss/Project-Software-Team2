import pytest
from app.main import create_app
from app.providers import Settings
from fastapi.testclient import TestClient

pytestmark = pytest.mark.prompt_coach


def test_features_report_prompt_coach_enabled():
    app = create_app(Settings(_env_file=None, prompt_coach_enabled=True))
    response = TestClient(app).get("/api/features")
    assert response.status_code == 200
    assert response.json() == {"prompt_coach": True}
    assert app.state.prompt_coach is not None
    assert app.state.prompt_coach["settings"].prompt_coach_enabled is True


def test_prompt_coach_options_reach_the_module():
    def factory():
        return None

    app = create_app(
        Settings(_env_file=None, prompt_coach_enabled=True),
        prompt_coach_options={"model_factory": factory},
    )
    assert app.state.prompt_coach["model_factory"] is factory
    assert app.state.prompt_coach["enabled"]["demo"] is True


def test_disabled_flag_does_not_install_the_module():
    app = create_app(Settings(_env_file=None, prompt_coach_enabled=False))
    assert getattr(app.state, "prompt_coach", None) is None
