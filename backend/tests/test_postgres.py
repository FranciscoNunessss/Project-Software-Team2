"""Real PostgreSQL transactions, schema migrations and read-only SQLite import."""

import hashlib
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from app.main import create_app
from app.providers import Settings
from app.storage import Storage
from conftest import drop_test_schema, legacy_copy
from fastapi.testclient import TestClient
from migration_tools.sqlite_import import import_sqlite
from test_persistence import account


@pytest.fixture
def destination():
    settings = Settings(_env_file=None, database_schema="test_import_" + uuid4().hex)
    store = Storage(settings.database_url.get_secret_value(), settings.database_schema)
    try:
        yield store, settings
    finally:
        drop_test_schema(settings.database_schema)


def test_migration_is_repeatable_and_concurrent():
    settings = Settings(_env_file=None)

    def start(_):
        return Storage(settings.database_url.get_secret_value(), settings.database_schema)

    with ThreadPoolExecutor(max_workers=4) as pool:
        stores = list(pool.map(start, range(4)))
    with stores[0].connect() as db:
        assert db.execute("SELECT count(*) FROM schema_migrations").fetchone()[0] == 3


def test_modified_or_newer_migration_is_refused():
    settings = Settings(_env_file=None)
    store = Storage(settings.database_url.get_secret_value(), settings.database_schema)
    with store.connect() as db:
        db.execute("UPDATE schema_migrations SET checksum='modified'")
    with pytest.raises(RuntimeError, match="modified"):
        store.migrate()
    with store.connect() as db:
        db.execute("INSERT INTO schema_migrations(version,checksum) VALUES (999,'future')")
    with pytest.raises(RuntimeError, match="newer"):
        store.migrate()


def test_sqlite_v8_import_preserves_task_feedback(tmp_path, destination):
    app = create_app(Settings(_env_file=None))
    client = TestClient(app)
    user = account(client)
    result = client.post("/api/analyze", json={"task": "Synthetic task"}).json()
    response = client.put(
        f"/api/analyses/{result['id']}/outcome",
        json={"outcome": "resolved", "turns": 2},
    )
    assert response.status_code == 200
    source = tmp_path / "v8.sqlite3"
    legacy_copy(app.state.storage, source)
    with sqlite3.connect(source) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 8
    store, settings = destination
    counts = import_sqlite(source, store, settings, apply=True)
    assert counts["task_outcomes"] == 1
    with store.connect() as db:
        row = db.execute("SELECT * FROM task_outcomes").fetchone()
        assert row["analysis_id"] == result["id"]
        assert row["user_id"] == user["id"]
        assert row["outcome"] == "resolved" and row["turns"] == 2


def test_transaction_rolls_back_on_failure():
    settings = Settings(_env_file=None)
    store = Storage(settings.database_url.get_secret_value(), settings.database_schema)
    with pytest.raises(ValueError, match="rollback"):
        with store.connect() as db:
            db.execute("INSERT INTO users(id,email,password_hash) VALUES ('x','x@test','hash')")
            raise ValueError("rollback")
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM users").fetchone()[0] == 0


def test_sqlite_import_preserves_account_choices_text_and_encrypted_credentials(
    tmp_path, destination
):
    settings = Settings(_env_file=None)
    app = create_app(settings)
    client = TestClient(app)
    user = account(client)
    client.put("/api/context", json={"conversation_memory_enabled": True, "save_enabled": True})
    result = client.post("/api/analyze", json={"task": "Synthetic import task"}).json()
    client.post(
        "/api/decisions",
        json={
            "analysis_id": result["id"],
            "candidate_id": result["recommendation"]["id"],
        },
    )
    config = client.post(
        "/api/llm-configs",
        json={
            "label": "Synthetic",
            "provider": "groq",
            "model": "test",
            "api_key": "import-test-key",
        },
    ).json()
    chat = None
    if client.get("/api/features").json()["chat"]:
        chat = client.post("/api/chats").json()
        response = client.post(
            f"/api/chats/{chat['id']}/messages",
            json={
                "content": "Synthetic chat import",
                "provider": "demo",
            },
        )
        assert response.status_code == 200
    source = tmp_path / "source.sqlite3"
    legacy_copy(app.state.storage, source)
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    target, target_settings = destination
    counts = import_sqlite(source, target, target_settings)
    assert counts["users"] == 1 and counts["conversation_content"] == 1
    with target.connect() as db:
        assert db.execute("SELECT count(*) FROM users").fetchone()[0] == 0
    assert import_sqlite(source, target, target_settings, apply=True) == counts
    assert hashlib.sha256(source.read_bytes()).hexdigest() == before
    moved = TestClient(create_app(target_settings))
    moved.cookies.update(client.cookies)
    assert moved.get("/api/auth/me").json() == user
    history = moved.get(f"/api/sessions/{result['session_id']}").json()["analyses"][0]
    assert history["candidate_id"] == result["recommendation"]["id"]
    assert history["conversation"]["task"] == "Synthetic import task"
    assert moved.get("/api/llm-configs").json()[0]["id"] == config["id"]
    assert moved.app.state.storage.schema == target.schema
    from app.llm_config import ModelConfigurations

    configurations = ModelConfigurations(target, target_settings)
    restored = configurations.configured_settings(configurations.owned(user["id"], config["id"]))
    assert restored.groq_api_key.get_secret_value() == "import-test-key"
    if chat:
        messages = moved.get(f"/api/chats/{chat['id']}").json()["messages"]
        assert len(messages) == 2 and messages[0]["content"] == "Synthetic chat import"
    with pytest.raises(ValueError, match="not empty"):
        import_sqlite(source, target, target_settings, apply=True)


def test_import_refuses_legacy_raw_data_and_wrong_credential_key(tmp_path, destination):
    from cryptography.fernet import Fernet

    app = create_app(Settings(_env_file=None))
    client = TestClient(app)
    account(client)
    client.post(
        "/api/llm-configs",
        json={
            "label": "Synthetic",
            "provider": "groq",
            "model": "test",
            "api_key": "secret-test-key",
        },
    )
    source = tmp_path / "source.sqlite3"
    legacy_copy(app.state.storage, source)
    store, settings = destination
    with pytest.raises(ValueError, match="encryption key"):
        import_sqlite(
            source,
            store,
            settings.model_copy(
                update={
                    "credentials_key": type(settings.credentials_key)(
                        Fernet.generate_key().decode()
                    ),
                }
            ),
            apply=True,
        )
    with sqlite3.connect(source) as db:
        db.execute("PRAGMA user_version=2")
    with pytest.raises(ValueError, match="v7"):
        import_sqlite(source, store, settings, apply=True)
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM users").fetchone()[0] == 0


def test_import_failure_rolls_back_every_table(tmp_path, destination):
    app = create_app(Settings(_env_file=None))
    client = TestClient(app)
    account(client)
    client.post("/api/analyze", json={"task": "Synthetic"})
    source = tmp_path / "source.sqlite3"
    legacy_copy(app.state.storage, source)
    with sqlite3.connect(source) as db:
        db.execute("UPDATE sessions SET user_id='missing-user'")
    target, settings = destination
    import psycopg

    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        import_sqlite(source, target, settings, apply=True)
    with target.connect() as db:
        assert db.execute("SELECT count(*) FROM users").fetchone()[0] == 0
