import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from app.main import create_app
from app.prompt_builder import (
    RUBRIC_DIR,
    RubricError,
    build_assessment_prompt,
    load_rubric,
    public_rubric,
)
from app.providers import Settings
from fastapi.testclient import TestClient
from profile_samples import profile_data
from test_profiles import analyse

FIXTURE = Path(__file__).parent / "fixtures" / "assessment-v2.txt"
REPO = Path(__file__).resolve().parents[2]


def copy_rubric(tmp_path, mutate):
    root = tmp_path / "rubric"
    shutil.copytree(RUBRIC_DIR, root)
    path = root / "versions" / "rubric-2.0.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    mutate(data)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    registry = {"rubric-2.0": hashlib.sha256(path.read_bytes()).hexdigest()}
    (root / "versions.json").write_text(json.dumps(registry), encoding="utf-8")
    return root


def test_rubric_2_0_reproduces_the_original_prompt_byte_for_byte():
    from app.assessment import ASSESSMENT_PROMPT, RUBRIC_VERSION

    expected = FIXTURE.read_bytes()
    assert build_assessment_prompt(load_rubric("rubric-2.0")).encode("utf-8") == expected
    assert ASSESSMENT_PROMPT.encode("utf-8") == expected
    assert RUBRIC_VERSION == "rubric-2.0"


def test_every_level_text_appears_in_its_prompt_lines():
    rubric = load_rubric("rubric-2.0")
    for item in rubric.dimensions:
        prompt = " ".join(line.strip() for line in item.prompt_lines)
        for level, text in item.levels.items():
            assert f"{level}={text}" in prompt, (item.name, level)


def test_registered_files_are_unchanged_and_active_version_is_registered():
    registry = json.loads((RUBRIC_DIR / "versions.json").read_text(encoding="utf-8"))
    files = {path.stem: path for path in (RUBRIC_DIR / "versions").glob("*.json")}
    assert set(files) == set(registry), "every version file is registered and vice versa"
    for version, path in files.items():
        assert hashlib.sha256(path.read_bytes()).hexdigest() == registry[version], version
    assert (RUBRIC_DIR / "ACTIVE").read_text(encoding="utf-8").strip() in registry


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda data: data["dimensions"].pop(4), "missing risk"),
        (lambda data: data["dimensions"][0].update(colour="blue"), "colour"),
        (lambda data: data.update(version=""), "version"),
        (lambda data: data["dimensions"][1]["levels"].update({"2": "renamed level"}), "level 2"),
        (lambda data: data["dimensions"][2].update(clarify_question=None), "clarify"),
    ],
)
def test_invalid_rubric_fails_with_an_error_naming_the_problem(tmp_path, mutate, message):
    root = copy_rubric(tmp_path, mutate)
    with pytest.raises(RubricError, match=message):
        load_rubric(root=root)


def test_modified_registered_file_is_refused(tmp_path):
    root = tmp_path / "rubric"
    shutil.copytree(RUBRIC_DIR, root)
    path = root / "versions" / "rubric-2.0.json"
    path.write_text(path.read_text(encoding="utf-8").replace("Specialised", "Special"))
    with pytest.raises(RubricError, match="sha256"):
        load_rubric(root=root)


def test_unregistered_active_version_is_refused(tmp_path):
    root = tmp_path / "rubric"
    shutil.copytree(RUBRIC_DIR, root)
    (root / "ACTIVE").write_text("rubric-9.9\n")
    with pytest.raises(RubricError, match="not registered"):
        load_rubric(root=root)


def test_public_rubric_endpoint_hides_tips_and_coach_focus():
    client = TestClient(create_app(Settings(_env_file=None)))
    response = client.get("/api/rubric")
    assert response.status_code == 200
    body = response.json()
    assert body["version"] == "rubric-2.0"
    assert [item["name"] for item in body["dimensions"]] == [
        "reasoning",
        "context",
        "ambiguity",
        "domain",
        "risk",
        "tools",
    ]
    assert body["modality"]["definition"]
    text = json.dumps(body)
    for hidden in ("tips", "coach_focus", "clarify", "prompt_lines"):
        assert hidden not in text
    assert body == public_rubric(load_rubric())


def test_analysis_reports_rubric_version():
    response = analyse(profile_data())
    assert response.status_code == 200
    assert response.json()["rubric_version"] == "rubric-2.0"


def test_render_rubric_script_prints_markdown():
    output = subprocess.run(
        [sys.executable, str(REPO / "scripts" / "render_rubric.py")],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert output.startswith("# Assessment rubric rubric-2.0")
    assert "| risk |" in output
