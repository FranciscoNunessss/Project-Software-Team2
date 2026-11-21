"""WS3 T7 demo seed (docs/ws3/README.md): refuses outside preview/demo, builds the planned team."""

import importlib.util
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def seeder():
    spec = importlib.util.spec_from_file_location("seed_demo", ROOT / "scripts/seed_demo.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_seed_refuses_to_run_without_a_preview_or_demo_environment():
    seed = seeder()

    assert seed.refuse_unless_allowed({}) is not None
    assert seed.refuse_unless_allowed({"ADAPTAI_ENVIRONMENT": "production"}) is not None
    assert seed.refuse_unless_allowed({"ADAPTAI_ENVIRONMENT": "Preview"}) is None


def test_the_plan_has_three_groups_fifteen_members_and_one_group_below_the_minimum():
    members = seeder().plan(int(time.time()))

    assert len(members) == 15
    sizes = {
        group: sum(m["group"] == group for m in members) for group in {m["group"] for m in members}
    }
    assert sorted(sizes.values()) == [4, 5, 6]
    assert sum(m["role"] == "manager" for m in members) == 3
    assert all(m["email"].endswith("@demo.adaptai.invalid") for m in members)


def test_seed_then_reset_creates_and_removes_only_the_demo(tmp_path):
    from app.main import create_app
    from app.providers import Settings
    from fastapi.testclient import TestClient

    seed = seeder()
    app = create_app(Settings(_env_file=None))
    presenter = TestClient(app)
    presenter.post(
        "/api/auth/register",
        json={"email": "presenter@example.com", "password": "correct horse battery"},
    )
    store = app.state.storage

    created = seed.seed(store, "presenter@example.com", int(time.time()))
    seed.export(tmp_path, created["user_ids"], int(time.time()))

    groups = presenter.get("/api/organisations").json()[0]["groups"]
    assert {g["name"]: g["size"] for g in groups} == {"Engineering": 6, "Support": 5, "Interns": 4}
    interns = next(g for g in groups if g["name"] == "Interns")
    assert presenter.get(f"/api/groups/{interns['id']}/dashboard").json()["enough_members"] is False
    assert (tmp_path / "c1-usage.jsonl").read_text(encoding="utf-8").strip()
    assert seed.reset(store) == 0
    assert presenter.get("/api/organisations").json() == []
    with store.connect() as db:
        assert (
            db.execute(
                "SELECT count(*) FROM users WHERE email LIKE '%%@demo.adaptai.invalid'"
            ).fetchone()[0]
            == 0
        )
        assert (
            db.execute("SELECT count(*) FROM users WHERE email='presenter@example.com'").fetchone()[
                0
            ]
            == 1
        )
