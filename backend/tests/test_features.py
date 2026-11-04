"""Core tests: the application works with or without the optional Prompt Coach module.

These tests are not marked ``prompt_coach`` so they run in the removal drill too.
"""

import ast
from pathlib import Path

from app.main import create_app
from app.providers import Settings
from fastapi.testclient import TestClient

APP_DIR = Path(__file__).resolve().parents[1] / "app"


def test_features_report_whether_the_module_is_installed():
    installed = (APP_DIR / "prompt_coach.py").exists()  # False in the removal drill.
    client = TestClient(create_app(Settings(_env_file=None)))
    response = client.get("/api/features")
    assert response.status_code == 200
    assert response.json() == {"prompt_coach": installed}
    if not installed:
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
    """Imports allowed only in a ``try`` that is a direct statement of the ``create_app`` body
    (not nested in a route handler or another block), so the core starts without the file."""
    lines: set[int] = set()
    for function in tree.body:
        if isinstance(function, ast.FunctionDef) and function.name == "create_app":
            for branch in function.body:
                if isinstance(branch, ast.Try):
                    for node in branch.body:
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


def test_only_create_app_imports_prompt_coach_and_tolerates_its_absence():
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
    assert _guarded_lines(nested) == {6}
    assert _dynamic_imports(nested) == [10]
