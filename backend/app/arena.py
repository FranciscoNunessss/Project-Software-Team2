"""Provisional levels from the public LMArena leaderboards (ADR-014 A10, layer 1).

LMArena publishes, per model and per category, a rating from people's votes between two
answers (dataset lmarena-ai/leaderboard-dataset, CC BY 4.0). `scripts/snapshot_lmarena.py`
saves a snapshot; `scripts/build_arena_mapping.py` freezes the thresholds into
`arena-mapping-1.json`. This module turns a model id into five levels, deterministically:

* **Name link.** A confirmed link in `arena-aliases.json` wins; otherwise `normalise` must give
  the same key for the model id and an arena name. Ids in the `blocked` list never link.
* **Variants.** Arena names with the same key (``(High)``, ``(Max)``, ``(Thinking)``) count as
  one model with the lowest rating of each category: the safe error.
* **Confidence.** A category counts only with enough votes and a narrow enough interval;
  otherwise the next category of the chain is used (see ``CHAINS``).
* **Levels.** 3 from the frozen 67th percentile, 2 from the 34th, else 1. Reasoning takes the
  lower of math and hard prompts. Tools without agent data are capped at 2.

Every rating is ``provisional`` and names LMArena, the categories and the publish date.
"""

import json
import re
from functools import lru_cache
from pathlib import Path

from app.catalogue import CATALOGUE_DIR

MAPPING_FILE = CATALOGUE_DIR / "arena-mapping-1.json"
ALIASES_FILE = CATALOGUE_DIR / "arena-aliases.json"
TEXT = "text_style_control"
LABELS = {
    "math": "math",
    "hard_prompts": "hard prompts",
    "expert": "expert",
    "longer_query": "longer query",
    "instruction_following": "instruction following",
    "overall": "overall",
}
# capability -> list of steps; each step is a list of (subset, category) that must all be
# usable (the level is the lowest of them); the first usable step wins.
CHAINS: dict[str, list[list[tuple[str, str]]]] = {
    "reasoning": [
        [(TEXT, "math"), (TEXT, "hard_prompts")],
        [(TEXT, "hard_prompts")],
        [(TEXT, "overall")],
    ],
    "context": [[(TEXT, "longer_query")], [(TEXT, "overall")]],
    "domain": [[(TEXT, "expert")], [(TEXT, "hard_prompts")], [(TEXT, "overall")]],
    "reliability": [
        [("text_factuality", "overall")],
        [(TEXT, "instruction_following")],
        [(TEXT, "overall")],
    ],
    "tools": [[("agent", "overall")], [(TEXT, "overall")]],
}
TOOLS_CAP_WITHOUT_AGENT_DATA = 2


def normalise(name: str) -> str:
    """Comparison key for an arena name or a provider id.

    'Claude Haiku 4.5 (20251001)' and 'anthropic/claude-haiku-4.5' -> 'claude-haiku-4-5';
    'Gemma 4 31B' and 'google/gemma-4-31b-it:free' -> 'gemma-4-31b'. Removes the vendor
    prefix, ':variant', bracketed variants, an 8-digit or ISO date and the suffixes
    -preview, -latest, -instruct, -it. Keeps -exp, -chat, -pro and 4-digit suffixes such as
    -1017: those are different models.
    """
    name = re.sub(r"\s*\(.*?\)", "", name)
    name = name.lower().strip().lstrip("~").split("/")[-1].split(":")[0]
    name = re.sub(r"[._ ]+", "-", name)
    name = re.sub(r"-(\d{8}|\d{4}-\d{2}-\d{2})$", "", name)
    for _ in range(2):
        name = re.sub(r"-(preview|latest|instruct|it)$", "", name)
    return name.strip("-")


def usable(entry: dict | None, subset: str, rules: dict) -> bool:
    if not entry:
        return False
    rule = rules.get(subset, rules["default"])
    if entry["votes"] < rule["min_votes"]:
        return False
    return (
        rule.get("max_interval") is None or entry["upper"] - entry["lower"] <= rule["max_interval"]
    )


def merge_variants(snapshot: dict, rules: dict) -> dict[str, dict[str, dict]]:
    """key -> {subset/category: lowest usable entry (with the arena name)} over variants."""
    merged: dict[str, dict[str, dict]] = {}
    for subset, models in snapshot["subsets"].items():
        for name, categories in models.items():
            key = normalise(name)
            for category, entry in categories.items():
                if not usable(entry, subset, rules):
                    continue
                slot = f"{subset}/{category}"
                current = merged.setdefault(key, {}).get(slot)
                if current is None or entry["rating"] < current["rating"]:
                    merged[key][slot] = {**entry, "name": name}
    return merged


def label(subset: str, category: str) -> str:
    return {"agent": "agent", "text_factuality": "factuality"}.get(subset, LABELS[category])


def level(value: float, limits: dict) -> int:
    return 3 if value >= limits["level_3_from"] else 2 if value >= limits["level_2_from"] else 1


@lru_cache(maxsize=1)
def reference() -> tuple[dict, dict, dict]:
    """(mapping, merged entries by key, aliases) or empty dicts when the files are missing."""
    try:
        mapping = json.loads(Path(MAPPING_FILE).read_text(encoding="utf-8"))
        snapshot = json.loads((CATALOGUE_DIR / mapping["snapshot"]).read_text(encoding="utf-8"))
        aliases = json.loads(Path(ALIASES_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError, KeyError):
        return {}, {}, {}
    return mapping, merge_variants(snapshot, mapping["rules"]), aliases


def key_for(provider: str, model: str, aliases: dict) -> str | None:
    for item in aliases.get("blocked", []):
        if item["model"] == model and item.get("provider", provider) == provider:
            return None
    for item in aliases.get("confirmed", []):
        if item["model"] == model and item.get("provider", provider) == provider:
            return normalise(item["arena"])
    return normalise(model)


def ratings(provider: str, model: str | None) -> dict[str, dict] | None:
    """{capability: rating} from LMArena for this model, or None when it has no usable data."""
    if not model:
        return None
    mapping, merged, aliases = reference()
    if not mapping:
        return None
    key = key_for(provider, model, aliases)
    entries = merged.get(key or "")
    if not entries or f"{TEXT}/overall" not in entries:
        return None
    thresholds = mapping["thresholds"]
    observed = mapping["observed_on"]
    result = {}
    for capability, chain in CHAINS.items():
        for step in chain:
            slots = [f"{subset}/{category}" for subset, category in step]
            if not all(slot in entries and slot in thresholds for slot in slots):
                continue
            levels = [level(entries[slot]["rating"], thresholds[slot]) for slot in slots]
            value = min(levels)
            capped = capability == "tools" and step[0][0] != "agent"
            if capped:
                value = min(value, TOOLS_CAP_WITHOUT_AGENT_DATA)
            parts = ", ".join(
                f"{label(*pair)} {entries['/'.join(pair)]['rating']:.4g} (L{lvl})"
                for pair, lvl in zip(step, levels, strict=True)
            )
            name = entries[slots[0]]["name"]
            cap = "; capped at 2 without agent data" if capped else ""
            result[capability] = {
                "level": value,
                "status": "provisional",
                "source": f"LMArena {observed} ({mapping['version']}, {name}): {parts}{cap}. "
                "CC BY 4.0",
                "observed_on": observed,
            }
            break
    return result if len(result) == len(CHAINS) else None
