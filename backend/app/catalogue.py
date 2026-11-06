"""Versioned model catalogue (ADR-004, ADR-014): one capability card per model.

Each catalogue version is an immutable JSON file in backend/data/catalogue/versions/.
backend/data/catalogue/ACTIVE names the version in use and versions.json records the sha256
of every file, as for the rubric (ADR-009). The backend refuses to start if the active file
is invalid or does not match its hash.

A card holds facts from the provider (context window, modalities, prices), five capability
levels on the rubric's 1-3 scale and the aliases under which providers serve the model. A
capability level is provisional (public benchmarks, docs/model-classification.md), calibrated
(the team's calibration set) or unrated. Only fully rated cards are ever recommended.
"""

import hashlib
import json
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

CATALOGUE_DIR = Path(__file__).parent.parent / "data" / "catalogue"
CAPABILITIES = ("reasoning", "context", "domain", "reliability", "tools")


class CatalogueError(Exception):
    pass


class Rating(BaseModel):
    model_config = ConfigDict(extra="forbid")
    level: int | None = Field(ge=1, le=3)
    status: Literal["provisional", "calibrated", "unrated"]
    source: str = ""
    observed_on: str | None = None

    @model_validator(mode="after")
    def consistent(self):
        if (self.level is None) != (self.status == "unrated"):
            raise ValueError("an unrated capability has no level, a rated one has a level")
        if self.level is not None and (not self.source.strip() or not self.observed_on):
            raise ValueError("a rated capability needs a source and an observed_on date")
        return self


class Alias(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider: Literal["openai", "claude", "groq", "openrouter", "ollama", "lmstudio"]
    model: str = Field(min_length=1, max_length=200)


class Facts(BaseModel):
    model_config = ConfigDict(extra="forbid")
    context_window: int = Field(gt=0)
    modalities: list[Literal["text", "image", "audio", "video"]] = Field(min_length=1)
    # Request-level capabilities the analysis can ask for (AnalysisRequest.required_capabilities).
    capabilities: list[Literal["text", "code", "vision", "audio", "video"]] = Field(min_length=1)
    tool_calling: bool
    structured_output: bool
    price_in_per_mtok: float | None = Field(default=None, ge=0)
    price_out_per_mtok: float | None = Field(default=None, ge=0)
    free: bool = False
    local: bool = False
    source: str = Field(min_length=1)
    observed_on: str = Field(min_length=10, max_length=10)


class Card(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9.\-]*$")
    family: str
    name: str
    illustrative: bool = False
    aliases: list[Alias] = []
    facts: Facts
    capabilities: dict[str, Rating]

    @model_validator(mode="after")
    def five_capabilities(self):
        if set(self.capabilities) != set(CAPABILITIES):
            raise ValueError(f"{self.id}: capabilities must be exactly {', '.join(CAPABILITIES)}")
        return self

    @property
    def rated(self) -> bool:
        return all(self.capabilities[name].level is not None for name in CAPABILITIES)

    def level(self, name: str) -> int | None:
        return self.capabilities[name].level

    @property
    def blended_price(self) -> float | None:
        """(3 x input + output) / 4 per million tokens; 0 for local and free models."""
        if self.facts.local or self.facts.free:
            return 0.0
        price_in, price_out = self.facts.price_in_per_mtok, self.facts.price_out_per_mtok
        if price_in is None or price_out is None:
            return None
        return round((3 * price_in + price_out) / 4, 6)


class CostBands(BaseModel):
    model_config = ConfigDict(extra="forbid")
    currency: str
    unit: str
    low_max: float = Field(ge=0)
    medium_max: float = Field(ge=0)

    def band(self, price: float | None) -> Literal["low", "medium", "high"] | None:
        if price is None:
            return None
        return "low" if price <= self.low_max else "medium" if price <= self.medium_max else "high"


class Catalogue(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: str = Field(pattern=r"^catalogue-\d+\.\d+$")
    rubric_scale: str
    benchmark_mapping: str | None
    observed_on: str
    source: str
    cost_bands: CostBands
    cards: list[Card] = Field(min_length=1)

    @model_validator(mode="after")
    def unique(self):
        ids = [card.id for card in self.cards]
        if len(ids) != len(set(ids)):
            raise ValueError("card ids must be unique")
        aliases = [(alias.provider, alias.model) for card in self.cards for alias in card.aliases]
        if len(aliases) != len(set(aliases)):
            raise ValueError("a provider model may belong to one card only")
        return self

    def card(self, identifier: str) -> Card | None:
        return next((card for card in self.cards if card.id == identifier), None)

    def card_for(self, provider: str, model: str | None) -> Card | None:
        """The card a provider model belongs to, matched exactly on (provider, model)."""
        if not model:
            return None
        return next(
            (
                card
                for card in self.cards
                for alias in card.aliases
                if alias.provider == provider and alias.model == model
            ),
            None,
        )


def load_catalogue(version: str | None = None, root: Path = CATALOGUE_DIR) -> Catalogue:
    try:
        registry = json.loads((root / "versions.json").read_text(encoding="utf-8"))
        version = version or (root / "ACTIVE").read_text(encoding="utf-8").strip()
    except (OSError, ValueError) as exc:
        raise CatalogueError(f"catalogue registry unreadable: {exc}") from None
    if version not in registry:
        raise CatalogueError(f"{version} is not registered in versions.json")
    path = root / "versions" / f"{version}.json"
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise CatalogueError(f"{path.name} unreadable: {exc}") from None
    if hashlib.sha256(data).hexdigest() != registry[version]:
        raise CatalogueError(f"{version}: {path.name} does not match its sha256 in versions.json")
    catalogue = Catalogue.model_validate_json(data)
    if catalogue.version != version:
        raise CatalogueError(f"{path.name} declares version {catalogue.version}")
    return catalogue


@lru_cache(maxsize=1)
def active_catalogue() -> Catalogue:
    return load_catalogue()
