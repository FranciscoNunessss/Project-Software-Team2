"""Core tests: the application works with or without its optional modules (Prompt Coach, chat).

These tests are not marked ``prompt_coach`` or ``chat`` so they run in the removal drill too.
"""

import ast
from pathlib import Path

import pytest
from app.main import create_app
from app.providers import Settings
from fastapi.testclient import TestClient

APP_DIR = Path(__file__).resolve().parents[1] / "app"


OPTIONAL = ("prompt_coach", "chat")  # Optional modules: ADR-009 and ADR-011.


def test_features_report_which_modules_are_installed():
    installed = {name: (APP_DIR / f"{name}.py").exists() for name in OPTIONAL}  # Drill: False.
    client = TestClient(create_app(Settings(_env_file=None)))
    response = client.get("/api/features")
    assert response.status_code == 200
    assert response.json() == installed
    if not installed["prompt_coach"]:
        assert client.post("/api/prompt-coach", json={}).status_code == 404
    if not installed["chat"]:
        assert client.get("/api/chats").status_code == 404


def _imports(node: ast.AST, name: str) -> bool:
    full = {f"app.{name}", name}
    if isinstance(node, ast.Import):
        return any(alias.name in full for alias in node.names)
    if isinstance(node, ast.ImportFrom):
        if node.module in full:
            return True
        return node.module in {"app", None} and any(alias.name == name for alias in node.names)
    return False


def _guarded_lines(tree: ast.Module, name: str) -> set[int]:
    """Imports allowed only in a ``try`` that is a direct statement of the ``create_app`` body
    (not nested in a route handler or another block), so the core starts without the file."""
    lines: set[int] = set()
    for function in tree.body:
        if isinstance(function, ast.FunctionDef) and function.name == "create_app":
            for branch in function.body:
                if isinstance(branch, ast.Try):
                    for node in branch.body:
                        if _imports(node, name):
                            lines.add(node.lineno)
    return lines


def _dynamic_imports(tree: ast.Module, name: str) -> list[int]:
    """importlib.import_module / __import__ calls naming the optional module."""
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        called = getattr(node.func, "attr", None) or getattr(node.func, "id", None)
        if called in {"import_module", "__import__"} and any(
            isinstance(arg, ast.Constant) and arg.value in {f"app.{name}", name}
            for arg in node.args
        ):
            found.append(node.lineno)
    return found


@pytest.mark.parametrize("name", OPTIONAL)
def test_only_create_app_imports_an_optional_module_and_tolerates_its_absence(name):
    offending = []
    for path in sorted(APP_DIR.rglob("*.py")):
        if path.name == f"{name}.py":
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        allowed = _guarded_lines(tree, name) if path.name == "main.py" else set()
        for node in ast.walk(tree):
            if _imports(node, name) and node.lineno not in allowed:
                offending.append(f"{path.relative_to(APP_DIR.parent)}:{node.lineno}")
        offending += [
            f"{path.relative_to(APP_DIR.parent)}:{line}" for line in _dynamic_imports(tree, name)
        ]
    assert not offending, f"{name} imported outside the guarded block: {offending}"


def test_guard_rejects_imports_outside_the_create_app_try():
    nested = ast.parse(
        "def create_app(settings):\n"
        "    def handler():\n"
        "        if True:\n"
        "            from app.prompt_coach import install_prompt_coach\n"
        "    try:\n"
        "        from app.prompt_coach import install_prompt_coach\n"
        "    except ModuleNotFoundError:\n"
        "        pass\n"
        "    import importlib\n"
        "    importlib.import_module('app.prompt_coach')\n"
    )
    assert _guarded_lines(nested, "prompt_coach") == {6}
    assert _dynamic_imports(nested, "prompt_coach") == [10]
