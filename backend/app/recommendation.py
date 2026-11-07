"""Recommendation by task needs and model capabilities (ADR-014, policy needs-capabilities-1).

Deterministic Python, no language model (ADR-014 D8). The function names below are the step
names used in the Product Specification and in tests/test_recommendation.py:

1. ``available_cards``  rated cards the user can actually use (server and personal models)
2. ``hard_filter``      modality, request capabilities, context window, tools 3 needs tools
3. ``coverage``         per need: covers / covers_as_described / short
4. ``model_status``     covers if all cover; covers_as_described if none is short; else short
5. ``choose``           cheapest blended price among the best status; ties: least excess,
                        calibrated before provisional, then id
6. ``fallback``         when nothing covers everything: provisional, or the least short model
7. ``extra_rules``      human verification for risk 3, tools note for tools 3
8. ``explain``          text generated from the coverage, always consistent with the choice

A task need is an interval [estimated, top] on the rubric's 1-3 scale. A capability covers a
need when it reaches the top; it covers it "as described" when it reaches only the estimate.
"""

from dataclasses import dataclass, field
from typing import Literal

from app.catalogue import CAPABILITIES, Card, Catalogue
from app.models import Profile

POLICY_VERSION = "needs-capabilities-1"
# capability need -> rubric dimension that measures it. Ambiguity is not a model capability:
# it is missing information, handled by the Coach (ADR-014 D3).
NEED_SOURCE = {
    "reasoning": "reasoning",
    "context": "context",
    "domain": "domain",
    "reliability": "risk",
    "tools": "tools",
}
UNKNOWN_NEED = (2, 3)
CHARS_PER_TOKEN = 4
STATUS_RANK = {"covers": 0, "covers_as_described": 1, "short": 2}

Status = Literal["covers", "covers_as_described", "short"]


@dataclass(frozen=True)
class Need:
    estimated: int
    top: int
    determined: bool


@dataclass(frozen=True)
class TaskNeeds:
    needs: dict[str, Need]
    modalities: tuple[str, ...]
    capabilities: tuple[str, ...]
    length_tokens: int
    ambiguous: bool

    def public(self) -> dict:
        return {
            "needs": {
                name: {"estimated": need.estimated, "top": need.top, "determined": need.determined}
                for name, need in self.needs.items()
            },
            "modalities": list(self.modalities),
            "capabilities": list(self.capabilities),
            "length_tokens": self.length_tokens,
            "ambiguous": self.ambiguous,
        }


@dataclass(frozen=True)
class Option:
    """A model the user can send to: a server model or one of their personal configurations."""

    provider: str
    model: str | None
    configuration_id: str | None
    label: str


@dataclass
class Evaluated:
    card: Card
    option: Option | None
    coverage: list[dict] = field(default_factory=list)
    status: Status = "short"
    shortfalls: list[str] = field(default_factory=list)
    deficit: int = 0
    excess: int = 0


def task_needs(
    profile: Profile, task_chars: int = 0, capabilities: list[str] | None = None
) -> TaskNeeds:
    needs = {}
    for name, dimension_name in NEED_SOURCE.items():
        dimension = getattr(profile, dimension_name)
        if dimension.score is None:
            needs[name] = Need(*UNKNOWN_NEED, determined=False)
        elif dimension.confidence == "low":
            needs[name] = Need(dimension.score, min(dimension.score + 1, 3), determined=True)
        else:
            needs[name] = Need(dimension.score, dimension.score, determined=True)
    ambiguity = profile.ambiguity.score
    return TaskNeeds(
        needs=needs,
        modalities=tuple(profile.modality.required or ["text"]),
        capabilities=tuple(capabilities or ["text"]),
        length_tokens=max(1, task_chars // CHARS_PER_TOKEN),
        ambiguous=ambiguity is None or ambiguity == 3,
    )


def available_cards(
    catalogue: Catalogue, options: list[Option], resolve=None
) -> tuple[list[Evaluated], list]:
    """Rated cards behind the user's models, one per card (server models first).

    Returns the evaluated shells and the options whose model has no rated card.
    """
    chosen: dict[str, Evaluated] = {}
    unrated: list[Option] = []
    ordered = sorted(
        options,
        key=lambda item: (
            item.configuration_id is None or not item.configuration_id.startswith("server:")
        ),
    )
    for option in ordered:
        card = resolve(option) if resolve else catalogue.card_for(option.provider, option.model)
        if card is None or not card.rated or card.illustrative:
            unrated.append(option)
            continue
        chosen.setdefault(card.id, Evaluated(card=card, option=option))
    return list(chosen.values()), unrated


def illustrative_cards(catalogue: Catalogue) -> list[Evaluated]:
    return [Evaluated(card=card, option=None) for card in catalogue.cards if card.illustrative]


def hard_filter(needs: TaskNeeds, card: Card) -> str | None:
    """Why a card cannot do the task at all, or None."""
    missing = [item for item in needs.modalities if item not in card.facts.modalities]
    if missing:
        return f"no {', '.join(missing)} input"
    missing = [item for item in needs.capabilities if item not in card.facts.capabilities]
    if missing:
        return f"no {', '.join(missing)} support"
    if needs.length_tokens > card.facts.context_window:
        return "the task does not fit in its context window"
    if needs.needs["tools"].estimated == 3 and not card.facts.tool_calling:
        return "no tool calling"
    return None


def coverage(needs: TaskNeeds, card: Card) -> list[dict]:
    result = []
    for name in CAPABILITIES:
        need = needs.needs[name]
        level = card.level(name) or 0
        state: Status = (
            "covers"
            if level >= need.top
            else "covers_as_described"
            if level >= need.estimated
            else "short"
        )
        result.append(
            {
                "need": name,
                "estimated": need.estimated,
                "top": need.top,
                "capability": card.level(name),
                "state": state,
                "provisional": card.capabilities[name].status != "calibrated",
            }
        )
    return result


def model_status(items: list[dict]) -> tuple[Status, list[str]]:
    shortfalls = [item["need"] for item in items if item["state"] == "short"]
    if shortfalls:
        return "short", shortfalls
    if all(item["state"] == "covers" for item in items):
        return "covers", []
    return "covers_as_described", []


LOCAL_PROVIDERS = {"ollama", "lmstudio"}


def price_of(item: Evaluated) -> float | None:
    """The card's blended price; 0 when the user runs the model locally."""
    if item.option is not None and (
        item.option.provider in LOCAL_PROVIDERS or (item.option.model or "").endswith(":free")
    ):
        return 0.0
    if item.option is not None:
        for alias in item.card.aliases:
            same = (alias.provider, alias.model) == (item.option.provider, item.option.model)
            if same and alias.blended_price is not None:
                return alias.blended_price
    return item.card.blended_price


def _price(item: Evaluated) -> float:
    price = price_of(item)
    return float("inf") if price is None else price


def _uncalibrated(item: Evaluated) -> bool:
    return any(rating.status != "calibrated" for rating in item.card.capabilities.values())


def _order(item: Evaluated) -> tuple:
    if item.status == "short":
        return (2, len(item.shortfalls), item.deficit, _price(item), item.card.id)
    return (STATUS_RANK[item.status], _price(item), item.excess, _uncalibrated(item), item.card.id)


def choose(items: list[Evaluated]) -> Evaluated | None:
    """The cheapest model that covers everything; None if no model does."""
    covering = [item for item in items if item.status == "covers"]
    return min(covering, key=_order) if covering else None


def fallback(items: list[Evaluated]) -> tuple[Evaluated, bool]:
    """When nothing covers everything: the best model by the same order, always provisional."""
    return min(items, key=_order), True


def extra_rules(needs: TaskNeeds) -> list[str]:
    notes = []
    if needs.needs["reliability"].estimated == 3:
        notes.append("High risk: verify the result with a person before acting on it.")
    if needs.needs["tools"].estimated == 3:
        notes.append(
            "This task needs tools or live data. The AdaptAI chat does not run tools: "
            "check that the model you use has access to them."
        )
    return notes


def _levels(item: Evaluated, names: list[str]) -> str:
    return ", ".join(f"{name} {item.card.level(name)}" for name in names)


def explain(needs: TaskNeeds, chosen: Evaluated, ordered: list[Evaluated]) -> str:
    """Why this model: what it covers, where a cheaper one falls short, why not a dearer one."""
    wanted = ", ".join(f"{name} {need.top}" for name, need in needs.needs.items())
    if chosen.status == "covers":
        text = (
            f"{chosen.card.name} covers every need of this task ({wanted}) and is the cheapest "
            "of your models that does."
        )
    elif chosen.status == "covers_as_described":
        text = (
            f"{chosen.card.name} covers this task as described, but not every need at its "
            f"upper estimate ({wanted}): the recommendation is provisional."
        )
    else:
        text = (
            f"None of your models covers this task. {chosen.card.name} falls short in the "
            f"fewest needs: {_levels(chosen, chosen.shortfalls)} against "
            + ", ".join(f"{name} {needs.needs[name].estimated}" for name in chosen.shortfalls)
            + "."
        )
    cheaper = [item for item in ordered if item is not chosen and _price(item) < _price(chosen)]
    if cheaper:
        nearest = max(cheaper, key=_price)
        if nearest.shortfalls:
            text += (
                f" {nearest.card.name} costs less but falls short in "
                + ", ".join(nearest.shortfalls)
                + "."
            )
        elif nearest.status == "covers_as_described":
            text += f" {nearest.card.name} costs less but only covers the task as described."
    dearer = [
        item
        for item in ordered
        if item is not chosen and item.status == "covers" and _price(item) > _price(chosen)
    ]
    if dearer and chosen.status == "covers":
        nearest = min(dearer, key=_price)
        text += f" {nearest.card.name} also covers it but costs more than needed."
    return text


@dataclass
class Recommendation:
    candidates: list[dict]
    notes: list[str]
    provisional: bool
    illustrative: bool
    rationale: str
    needs: TaskNeeds


def _gap(item: Evaluated, chosen: Evaluated) -> int:
    """-1 covers less than the recommendation, +1 more than needed, 0 the recommendation."""
    if item is chosen:
        return 0
    if STATUS_RANK[item.status] != STATUS_RANK[chosen.status]:
        return -1 if STATUS_RANK[item.status] > STATUS_RANK[chosen.status] else 1
    if item.status == "short" and (len(item.shortfalls), item.deficit) != (
        len(chosen.shortfalls),
        chosen.deficit,
    ):
        return (
            -1
            if (len(item.shortfalls), item.deficit)
            > (
                len(chosen.shortfalls),
                chosen.deficit,
            )
            else 1
        )
    return 1 if _price(item) >= _price(chosen) else -1


def candidate(item: Evaluated, chosen: Evaluated, catalogue: Catalogue) -> dict:
    option = item.option
    return {
        "id": item.card.id,
        "name": item.card.name,
        "capabilities": list(item.card.facts.capabilities),
        "provider": option.provider if option else None,
        "model": option.model if option else None,
        "configuration_id": option.configuration_id if option else None,
        "label": option.label if option else item.card.name,
        "status": item.status,
        "shortfalls": item.shortfalls,
        "coverage": item.coverage,
        "blended_price": price_of(item),
        "cost_band": catalogue.cost_bands.band(price_of(item)),
        "free": item.card.facts.free
        or (option is not None and (option.model or "").endswith(":free")),
        "local": item.card.facts.local
        or (option is not None and option.provider in LOCAL_PROVIDERS),
        "illustrative": item.card.illustrative,
        "calibrated": not _uncalibrated(item),
        "gap": _gap(item, chosen),
    }


def recommend(
    needs: TaskNeeds, options: list[Option], catalogue: Catalogue, resolve=None
) -> Recommendation:
    """``resolve(option) -> Card | None`` gives each option its levels (app.evaluations)."""
    items, unrated = available_cards(catalogue, options, resolve)
    illustrative = not items
    if illustrative:
        items = illustrative_cards(catalogue)
    notes: list[str] = []
    eligible = []
    for item in items:
        if hard_filter(needs, item.card) is None:
            eligible.append(item)
    if not eligible:
        raise NoEligibleModel()
    for item in eligible:
        item.coverage = coverage(needs, item.card)
        item.status, item.shortfalls = model_status(item.coverage)
        item.deficit = sum(
            entry["estimated"] - (entry["capability"] or 0)
            for entry in item.coverage
            if entry["state"] == "short"
        )
        item.excess = sum(
            max(0, (entry["capability"] or 0) - entry["top"]) for entry in item.coverage
        )
    chosen = choose(eligible)
    provisional = needs.ambiguous
    if chosen is None:
        chosen, provisional = fallback(eligible)
        if chosen.status == "short":
            notes.append(
                "None of your models covers "
                + ", ".join(f"{name} {needs.needs[name].estimated}" for name in chosen.shortfalls)
                + ": add a more capable model or split the task."
            )
    if chosen.status != "covers":
        provisional = True
    notes.extend(extra_rules(needs))
    if illustrative:
        notes.append(
            "None of your models is classified yet, so this recommendation uses the "
            "illustrative demo models."
        )
    elif unrated:
        names = sorted({option.label for option in unrated})
        notes.append("Not classified yet, so never recommended: " + ", ".join(names) + ".")
    ordered = sorted(eligible, key=_order)
    ordered.remove(chosen)
    ordered.insert(0, chosen)
    return Recommendation(
        candidates=[candidate(item, chosen, catalogue) for item in ordered],
        notes=notes,
        provisional=provisional,
        illustrative=illustrative,
        rationale=explain(needs, chosen, ordered),
        needs=needs,
    )


class NoEligibleModel(Exception):
    pass


def candidate_gap(result: dict, candidate_id: str) -> int:
    """Chosen minus recommended for a stored analysis, old (tier) or new (card) policy."""
    recommended = result["recommendation"]
    chosen = next(
        item for item in [recommended, *result["alternatives"]] if item["id"] == candidate_id
    )
    if chosen.get("gap") is not None:
        return chosen["gap"]
    return chosen["capacity"] - recommended["capacity"]
