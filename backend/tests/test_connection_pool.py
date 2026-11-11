import psycopg
import pytest
from app.main import create_app
from app.providers import Settings
from fastapi.testclient import TestClient


def test_app_reuses_connection_and_rolls_back_failed_transactions():
    app = create_app(Settings(_env_file=None, database_pool_size=1))
    store = app.state.storage
    with TestClient(app):
        with store.connect() as first:
            pid = first.info.backend_pid
            assert first.execute("SELECT current_schema()").fetchone()[0] == store.schema
            assert first.execute("SHOW lock_timeout").fetchone()[0] == "15s"

        with pytest.raises(psycopg.errors.DivisionByZero), store.connect() as failed:
            assert failed.info.backend_pid == pid
            failed.execute("SET LOCAL search_path TO public")
            failed.execute("SELECT 1 / 0")

        with store.connect() as reused:
            assert reused.info.backend_pid == pid
            assert reused.execute("SELECT current_schema()").fetchone()[0] == store.schema
    assert reused.closed


def test_pool_can_be_disabled_for_a_comparison():
    app = create_app(Settings(_env_file=None, database_pool_size=0))
    with TestClient(app), app.state.storage.connect() as connection:
        assert connection.execute("SELECT 1").fetchone()[0] == 1
    assert connection.closed
