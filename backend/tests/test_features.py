"""Core tests: the application works with the optional Prompt Coach switched off.

These tests are not marked ``prompt_coach`` so they run in the removal drill too.
"""

import ast
from pathlib import Path

from app.main import create_app
from app.providers import Settings
from fastapi.testclient import TestClient

APP_DIR = Path(__file__).resolve().parents[1] / "app"


def test_features_report_prompt_coach_disabled():
    client = TestClient(create_app(Settings(_env_file=None, prompt_coach_enabled=False)))
    response = client.get("/api/features")
    assert response.status_code == 200
    assert response.json() == {"prompt_coach": False}
    assert client.post("/api/prompt-coach", json={}).status_code == 404


def _imports_prompt_coach(node: ast.AST) -> bool:
    if isinstance(node, ast.Import):
        return any(alias.name in {"app.prompt_coach", "prompt_coach"} for alias in node.names)
    if isinstance(node, ast.ImportFrom):
        if node.module in {"app.prompt_coach", "prompt_coach"}:
            return True
        return node.module in {"app", None} and any(
            alias.name == "prompt_coach" for alias in node.names
        )
    return False


def _guarded_lines(tree: ast.Module) -> set[int]:
    """Lines of prompt_coach imports nested in an ``if`` inside ``create_app``."""
    lines: set[int] = set()
    for function in ast.walk(tree):
        if isinstance(function, ast.FunctionDef) and function.name == "create_app":
            for branch in ast.walk(function):
                if isinstance(branch, ast.If):
                    for node in ast.walk(branch):
                        if _imports_prompt_coach(node):
                            lines.add(node.lineno)
    return lines


def test_only_create_app_imports_prompt_coach_behind_the_flag():
    offending = []
    for path in sorted(APP_DIR.rglob("*.py")):
        if path.name == "prompt_coach.py":
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        allowed = _guarded_lines(tree) if path.name == "main.py" else set()
        for node in ast.walk(tree):
            if _imports_prompt_coach(node) and node.lineno not in allowed:
                offending.append(f"{path.relative_to(APP_DIR.parent)}:{node.lineno}")
    assert not offending, f"prompt_coach imported outside the guarded block: {offending}"
