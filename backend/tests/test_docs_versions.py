"""The versions the docs refer to exist in the repository (ADR-014 section 7.5, NFR-07)."""

import json
import re
from pathlib import Path

from app.catalogue import CATALOGUE_DIR, load_catalogue
from app.recommendation import POLICY_VERSION

ROOT = Path(__file__).resolve().parents[2]
DOCS = [
    ROOT / "README.md",
    ROOT / "docs/model-classification.md",
    ROOT / "docs/adr/ADR-014-recommendation-by-task-needs-and-model-capabilities.md",
]


def mentioned(pattern: str) -> set[str]:
    found = set()
    for path in [item for item in DOCS if item.exists()]:
        found |= set(re.findall(pattern, path.read_text(encoding="utf-8")))
    return found


def test_the_policy_version_in_the_docs_is_the_code_policy():
    assert mentioned(r"needs-capabilities-\d+") == {POLICY_VERSION}


def test_every_catalogue_version_named_in_the_docs_is_registered_or_the_next_one():
    registry = json.loads((CATALOGUE_DIR / "versions.json").read_text())
    active = load_catalogue().version
    for version in mentioned(r"catalogue-\d+\.\d+"):
        major, minor = map(int, version.removeprefix("catalogue-").split("."))
        active_minor = int(active.split(".")[1])
        # The docs may name the next version as the one to build.
        assert version in registry or (major == 2 and minor == active_minor + 1), version


def test_the_benchmark_mapping_named_in_the_docs_is_the_catalogues_or_still_to_be_built():
    mapping = load_catalogue().benchmark_mapping
    if mapping:
        assert (CATALOGUE_DIR / "mappings" / f"{mapping}.json").exists()
