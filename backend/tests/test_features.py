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
    # Stays meaningful once the module registers routes: with the flag off there are none.
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


def _is_flag_test(test: ast.expr) -> bool:
    return (
        isinstance(test, ast.Attribute)
        and test.attr == "prompt_coach_enabled"
        and isinstance(test.value, ast.Name)
        and test.value.id == "settings"
    )


def _guarded_lines(tree: ast.Module) -> set[int]:
    """Imports allowed only in an ``if settings.prompt_coach_enabled:`` that is a direct
    statement of the ``create_app`` body (not nested in a route handler or another block)."""
    lines: set[int] = set()
    for function in tree.body:
        if isinstance(function, ast.FunctionDef) and function.name == "create_app":
            for branch in function.body:
                if isinstance(branch, ast.If) and _is_flag_test(branch.test):
                    for node in ast.walk(branch):
                        if _imports_prompt_coach(node):
                            lines.add(node.lineno)
    return lines


def _dynamic_imports(tree: ast.Module) -> list[int]:
    """importlib.import_module / __import__ calls naming the Prompt Coach module."""
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = getattr(node.func, "attr", None) or getattr(node.func, "id", None)
        if name in {"import_module", "__import__"} and any(
            isinstance(arg, ast.Constant)
            and isinstance(arg.value, str)
            and "prompt_coach" in arg.value
            for arg in node.args
        ):
            found.append(node.lineno)
    return found


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
        offending += [
            f"{path.relative_to(APP_DIR.parent)}:{line}" for line in _dynamic_imports(tree)
        ]
    assert not offending, f"prompt_coach imported outside the guarded block: {offending}"


def test_guard_rejects_imports_outside_the_flag_block():
    nested = ast.parse(
        "def create_app(settings):\n"
        "    def handler():\n"
        "        if True:\n"
        "            from app.prompt_coach import install_prompt_coach\n"
        "    if settings.prompt_coach_enabled:\n"
        "        from app.prompt_coach import install_prompt_coach\n"
        "    import importlib\n"
        "    importlib.import_module('app.prompt_coach')\n"
    )
    assert _guarded_lines(nested) == {6}
    assert _dynamic_imports(nested) == [8]
