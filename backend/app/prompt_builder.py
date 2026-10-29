"""Versioned assessment rubric (ADR-009).

Each rubric version is an immutable JSON file in backend/rubric/versions/. backend/rubric/ACTIVE
names the version in use and backend/rubric/versions.json records the sha256 of every file.
The assessment prompt, the public rubric (GET /api/rubric) and the deterministic tips and
clarification questions are all derived from the active version.
"""

import hashlib
import json
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

RUBRIC_DIR = Path(__file__).parent.parent / "rubric"
SCORED_DIMENSIONS = ("reasoning", "context", "ambiguity", "domain", "risk", "tools")
Level = Literal["1", "2", "3"]


class RubricError(RuntimeError):
    """The rubric files are missing, invalid or do not match the registry."""


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


class ClarifyWhen(_Strict):
    score_in: list[Literal[1, 2, 3] | None] | None = None
    required_unknown: bool | None = None


class DimensionTips(_Strict):
    missing: str | None
    one: str | None = Field(alias="1")
    two: str | None = Field(alias="2")
    three: str | None = Field(alias="3")

    def for_score(self, score: int | None) -> str | None:
        return {None: self.missing, 1: self.one, 2: self.two, 3: self.three}[score]


class RubricDimension(_Strict):
    name: Literal["reasoning", "context", "ambiguity", "domain", "risk", "tools"]
    definition: str = Field(min_length=1)
    levels: dict[Level, str]
    prompt_lines: list[str] = Field(min_length=1)
    anchors: list[str]
    capacity_driver: bool
    clarify_when: ClarifyWhen | None
    clarify_question: str | None
    clarify_order: int | None
    tips: DimensionTips
    coach_focus: str = Field(min_length=1)


class RubricModality(_Strict):
    definition: str = Field(min_length=1)
    prompt_lines: list[str] = Field(min_length=1)
    anchors: list[str]
    clarify_when: ClarifyWhen | None
    clarify_question: str | None
    clarify_order: int | None
    coach_focus: str = Field(min_length=1)


class GeneralTips(_Strict):
    simple_task: str = Field(min_length=1)


class Rubric(_Strict):
    version: str = Field(pattern=r"^rubric-\d+\.\d+$")
    profile_version: Literal["profile-2"]
    notes: str
    preamble_lines: list[str] = Field(min_length=1)
    dimensions: list[RubricDimension]
    modality: RubricModality
    closing_lines: list[str] = Field(min_length=1)
    general_tips: GeneralTips

    def dimension(self, name: str) -> RubricDimension:
        return next(item for item in self.dimensions if item.name == name)


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _check(rubric: Rubric) -> None:
    names = [item.name for item in rubric.dimensions]
    if tuple(names) != SCORED_DIMENSIONS:
        missing = sorted(set(SCORED_DIMENSIONS) - set(names))
        raise RubricError(
            f"{rubric.version}: dimensions must be {', '.join(SCORED_DIMENSIONS)} in that order"
            + (f"; missing {', '.join(missing)}" if missing else "")
        )
    for item in rubric.dimensions:
        if set(item.levels) != {"1", "2", "3"}:
            raise RubricError(f"{rubric.version}: {item.name} must define levels 1, 2 and 3")
        prompt = " ".join(line.strip() for line in item.prompt_lines)
        for level, text in item.levels.items():
            if f"{level}={text}" not in prompt:
                raise RubricError(
                    f"{rubric.version}: {item.name} level {level} is not in its prompt_lines"
                )
        if (item.clarify_when is None) != (item.clarify_question is None):
            raise RubricError(
                f"{rubric.version}: {item.name} needs both clarify_when and clarify_question"
            )


def load_rubric(version: str | None = None, root: Path = RUBRIC_DIR) -> Rubric:
    """Load and validate a rubric version (the active one by default)."""
    try:
        registry = json.loads((root / "versions.json").read_text(encoding="utf-8"))
        version = version or (root / "ACTIVE").read_text(encoding="utf-8").strip()
    except (OSError, json.JSONDecodeError) as exc:
        raise RubricError(f"rubric registry unreadable: {exc}") from exc
    if version not in registry:
        raise RubricError(f"{version} is not registered in versions.json")
    path = root / "versions" / f"{version}.json"
    if not path.is_file():
        raise RubricError(f"{version}: file {path.name} is missing")
    if _sha256(path) != registry[version]:
        raise RubricError(f"{version}: {path.name} does not match its sha256 in versions.json")
    try:
        rubric = Rubric.model_validate_json(path.read_text(encoding="utf-8"))
    except ValidationError as exc:
        problems = "; ".join(
            f"{'.'.join(str(part) for part in error['loc'])}: {error['msg']}"
            for error in exc.errors()
        )
        raise RubricError(f"{version}: {problems}") from exc
    if rubric.version != version:
        raise RubricError(f"{path.name} declares version {rubric.version}")
    _check(rubric)
    return rubric


@lru_cache(maxsize=1)
def active_rubric() -> Rubric:
    return load_rubric()


def build_assessment_prompt(rubric: Rubric) -> str:
    lines = list(rubric.preamble_lines)
    for item in rubric.dimensions:
        lines.extend(item.prompt_lines)
        lines.extend(f"  {anchor}" for anchor in item.anchors)
    lines.append("")
    lines.extend(rubric.modality.prompt_lines)
    lines.extend(rubric.modality.anchors)
    lines.append("")
    lines.extend(rubric.closing_lines)
    return "\n".join(lines) + "\n"


def public_rubric(rubric: Rubric) -> dict:
    """The rubric as people and clients may see it: never tips or Prompt Coach focus."""
    return {
        "version": rubric.version,
        "profile_version": rubric.profile_version,
        "dimensions": [
            {
                "name": item.name,
                "definition": item.definition,
                "levels": dict(item.levels),
                "anchors": list(item.anchors),
            }
            for item in rubric.dimensions
        ],
        "modality": {
            "definition": rubric.modality.definition,
            "values": ["text", "image", "audio", "video"],
            "anchors": list(rubric.modality.anchors),
        },
    }
