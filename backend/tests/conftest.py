import atexit
import os
import tempfile
from pathlib import Path

import pytest

# The Prompt Coach is optional (ADR-009); its tests disappear with the module.
if not (Path(__file__).resolve().parents[1] / "app" / "prompt_coach.py").exists():
    collect_ignore_glob = ["test_prompt_coach*.py"]

# app.main creates its module-level app during test collection, before fixtures run.
# Keep that import away from the developer's database as well as isolating each test.
_collection_data = tempfile.TemporaryDirectory(prefix="adaptai-test-collection-")
atexit.register(_collection_data.cleanup)
os.environ["ADAPTAI_DATABASE_PATH"] = str(Path(_collection_data.name) / "collection.sqlite3")
os.environ["ADAPTAI_CREDENTIALS_KEY_PATH"] = str(Path(_collection_data.name) / "collection.key")


@pytest.fixture(autouse=True)
def isolated_database(tmp_path, monkeypatch):
    monkeypatch.setenv("ADAPTAI_DATABASE_PATH", str(tmp_path / "test.sqlite3"))
    monkeypatch.setenv("ADAPTAI_CREDENTIALS_KEY_PATH", str(tmp_path / "credentials.key"))
