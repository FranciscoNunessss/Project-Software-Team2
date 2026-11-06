"""Catalogue v2 validation and version registry (ADR-004, ADR-014)."""

import hashlib
import json
import shutil

import pytest
from app.catalogue import CATALOGUE_DIR, Catalogue, CatalogueError, load_catalogue
from pydantic import ValidationError


def active_data():
    return json.loads((CATALOGUE_DIR / "versions" / "catalogue-2.0.json").read_text())


def test_active_catalogue_loads_and_every_registered_version_matches_its_hash():
    registry = json.loads((CATALOGUE_DIR / "versions.json").read_text())
    for version in registry:
        assert load_catalogue(version).version == version
    assert load_catalogue().version == (CATALOGUE_DIR / "ACTIVE").read_text().strip()


def test_levels_stay_on_the_rubric_scale_and_need_a_source_and_date():
    data = active_data()
    data["cards"][0]["capabilities"]["reasoning"]["level"] = 4
    with pytest.raises(ValidationError):
        Catalogue.model_validate(data)
    data = active_data()
    data["cards"][0]["capabilities"]["reasoning"]["source"] = ""
    with pytest.raises(ValidationError):
        Catalogue.model_validate(data)
    data = active_data()
    data["cards"][0]["capabilities"]["reasoning"] = {"level": 2, "status": "unrated"}
    with pytest.raises(ValidationError):
        Catalogue.model_validate(data)


def test_every_card_has_exactly_five_capabilities():
    data = active_data()
    del data["cards"][0]["capabilities"]["tools"]
    with pytest.raises(ValidationError):
        Catalogue.model_validate(data)


def test_aliases_and_ids_are_unique():
    data = active_data()
    data["cards"][0]["aliases"] = [{"provider": "groq", "model": "same"}]
    data["cards"][1]["aliases"] = [{"provider": "groq", "model": "same"}]
    with pytest.raises(ValidationError):
        Catalogue.model_validate(data)
    data = active_data()
    data["cards"][1]["id"] = data["cards"][0]["id"]
    with pytest.raises(ValidationError):
        Catalogue.model_validate(data)


def test_registered_versions_are_immutable(tmp_path):
    root = tmp_path / "catalogue"
    shutil.copytree(CATALOGUE_DIR, root)
    path = root / "versions" / "catalogue-2.0.json"
    path.write_text(path.read_text().replace("Illustrative small model", "Changed"))
    with pytest.raises(CatalogueError, match="sha256"):
        load_catalogue("catalogue-2.0", root)
    with pytest.raises(CatalogueError, match="not registered"):
        load_catalogue("catalogue-9.9", root)


def test_blended_price_and_cost_bands():
    catalogue = load_catalogue()
    small = catalogue.card("demo-small")
    assert small.blended_price == 0.1
    assert catalogue.cost_bands.band(0.5) == "low"
    assert catalogue.cost_bands.band(0.51) == "medium"
    assert catalogue.cost_bands.band(5.01) == "high"
    assert catalogue.cost_bands.band(None) is None


def test_hash_helper_matches_registry():
    registry = json.loads((CATALOGUE_DIR / "versions.json").read_text())
    data = (CATALOGUE_DIR / "versions" / "catalogue-2.0.json").read_bytes()
    assert registry["catalogue-2.0"] == hashlib.sha256(data).hexdigest()
