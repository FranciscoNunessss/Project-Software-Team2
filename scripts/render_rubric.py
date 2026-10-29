"""Print a rubric version as Markdown for the documentation (defaults to the active one).

uv run python scripts/render_rubric.py [rubric-2.0]
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app.prompt_builder import load_rubric  # noqa: E402


def render(version: str | None = None) -> str:
    rubric = load_rubric(version)
    lines = [f"# Assessment rubric {rubric.version} ({rubric.profile_version})", ""]
    lines += ["| Dimension | Definition | 1 | 2 | 3 |", "| --- | --- | --- | --- | --- |"]
    for item in rubric.dimensions:
        levels = " | ".join(item.levels[key].rstrip(".") for key in ("1", "2", "3"))
        lines.append(f"| {item.name} | {item.definition} | {levels} |")
    lines += ["", f"**Modality:** {rubric.modality.definition}", ""]
    anchors = [(item.name, anchor) for item in rubric.dimensions for anchor in item.anchors]
    if anchors:
        lines += ["## Anchors", ""] + [f"- {name}: {anchor}" for name, anchor in anchors]
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    print(render(sys.argv[1] if len(sys.argv) > 1 else None), end="")
