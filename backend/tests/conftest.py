import atexit
import os
import tempfile
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql

_APP = Path(__file__).resolve().parents[1] / "app"
collect_ignore_glob = [
    pattern
    for module, pattern in (("prompt_coach", "test_prompt_coach*.py"), ("chat", "test_chat*.py"))
    if not (_APP / f"{module}.py").exists()
]

# Never inherit the application/Supabase URL. Tests own unique schemas only.
TEST_DATABASE_URL = os.environ.get(
    "ADAPTAI_TEST_DATABASE_URL", "postgresql://adaptai:adaptai@127.0.0.1:55432/adaptai"
)
_collection_data = tempfile.TemporaryDirectory(prefix="adaptai-test-collection-")
_collection_schema = "test_collection_" + uuid4().hex
os.environ["ADAPTAI_DATABASE_URL"] = TEST_DATABASE_URL
os.environ["ADAPTAI_DATABASE_SCHEMA"] = _collection_schema
os.environ["ADAPTAI_CREDENTIALS_KEY_PATH"] = str(Path(_collection_data.name) / "collection.key")
os.environ.pop("ADAPTAI_CREDENTIALS_KEY", None)
# The evaluation worker would call real providers; tests drive app.evaluations directly.
os.environ["ADAPTAI_EVALUATIONS_WORKER"] = "false"


def drop_test_schema(name):
    if not name.startswith("test_"):
        raise ValueError("Only generated test schemas may be removed")
    with psycopg.connect(TEST_DATABASE_URL, autocommit=True, connect_timeout=10) as db:
        db.execute(sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(sql.Identifier(name)))


def cleanup_collection():
    drop_test_schema(_collection_schema)
    _collection_data.cleanup()


try:
    with psycopg.connect(TEST_DATABASE_URL, connect_timeout=5):
        pass
except psycopg.OperationalError:
    raise pytest.UsageError(
        "PostgreSQL tests require docker compose up -d --wait postgres, "
        "or ADAPTAI_TEST_DATABASE_URL pointing to a disposable test database."
    ) from None
atexit.register(cleanup_collection)


@pytest.fixture(autouse=True)
def no_rate_limits_between_tests():
    """app.limits is per process: one test's rate-limited model must not affect the next."""
    from app import limits

    limits.clear()
    yield
    limits.clear()


@pytest.fixture(autouse=True)
def isolated_database(tmp_path, monkeypatch):
    schema = "test_" + uuid4().hex
    monkeypatch.setenv("ADAPTAI_DATABASE_URL", TEST_DATABASE_URL)
    monkeypatch.setenv("ADAPTAI_DATABASE_SCHEMA", schema)
    monkeypatch.setenv("ADAPTAI_CREDENTIALS_KEY_PATH", str(tmp_path / "credentials.key"))
    monkeypatch.delenv("ADAPTAI_CREDENTIALS_KEY", raising=False)
    yield
    drop_test_schema(schema)


def legacy_copy(store, path):
    """Synthetic v7 SQLite fixture for testing migration of historical releases."""
    from migration_tools.legacy_sqlite import LegacySQLiteStorage

    legacy = LegacySQLiteStorage(str(path))
    tables = (
        "users",
        "auth_sessions",
        "sessions",
        "analyses",
        "decisions",
        "user_context",
        "memory_entries",
        "llm_configs",
        "coaching_reports",
        "conversation_content",
    )
    with legacy.connect() as target, store.connect() as source:
        for table in (
            "task_outcomes",
            "prompt_coach_settings",
            "chat_sessions",
            "chat_messages",
            "chat_settings",
            "chat_model_tiers",
        ):
            columns = source.execute(
                "SELECT column_name,data_type FROM information_schema.columns "
                "WHERE table_schema=%s AND table_name=%s AND column_name<>'sequence_id' "
                "ORDER BY ordinal_position",
                (store.schema, table),
            ).fetchall()
            if columns:
                definitions = ",".join(
                    f'"{name}" ' + ("INTEGER" if kind in {"integer", "bigint"} else "TEXT")
                    for name, kind in columns
                )
                target.execute(f'CREATE TABLE IF NOT EXISTS "{table}" ({definitions})')
                tables += (table,)
        for table in tables:
            columns = [row[1] for row in target.execute(f"PRAGMA table_info({table})")]
            rows = source.execute(
                sql.SQL("SELECT {} FROM {} ORDER BY ctid").format(
                    sql.SQL(",").join(map(sql.Identifier, columns)), sql.Identifier(table)
                )
            ).fetchall()
            for row in rows:
                target.execute(
                    f"INSERT INTO {table} ({','.join(columns)}) "
                    f"VALUES ({','.join('?' for _ in columns)})",
                    tuple(row),
                )
    return legacy
