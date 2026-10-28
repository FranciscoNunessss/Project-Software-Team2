import pytest


@pytest.fixture(autouse=True)
def isolated_database(tmp_path, monkeypatch):
    monkeypatch.setenv("ADAPTAI_DATABASE_PATH", str(tmp_path / "test.sqlite3"))
