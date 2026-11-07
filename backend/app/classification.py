"""How a model gets its provisional capability levels (ADR-014, docs/model-classification.md).

Pure functions used by the scripts in scripts/ and by the tests. Nothing here runs when the
application serves requests: the result is a catalogue version, reviewed and committed.

1. Facts come from the provider catalogue (OpenRouter's public model list).
2. A benchmark snapshot holds, per model, the values published by Artificial Analysis.
3. A benchmark mapping says which metric measures each capability (in order of preference)
   and freezes, per metric, the values at the 34th and 67th percentile of the snapshot as
   absolute thresholds: below the first is level 1, from the second on is level 3.
4. A card's level for a capability comes from the first metric of the mapping that the
   model has a value for. Levels are provisional until the team calibrates them.
"""

from statistics import quantiles

from app.catalogue import CAPABILITIES

PERCENTILES = (34, 67)
INDEX = "artificial_analysis_intelligence_index"
DOMAIN_INDICES = (
    "artificial_analysis_finance_and_accounting_index",
    "artificial_analysis_strategy_and_ops_index",
    "artificial_analysis_legal_index",
    "artificial_analysis_healthcare_and_medical_index",
    "artificial_analysis_engineering_index",
    "artificial_analysis_economics_index",
)
DOMAIN_MEAN = "domain_indices_mean"
# Per capability, the metrics in order of preference. The per-benchmark metrics are the
# Intelligence Index evaluations chosen in ADR-014; Artificial Analysis publishes them per
# model on its Pro API. The free API publishes only the indices, so each capability falls
# back to an index: the industry indices for domain, the overall index otherwise.
CAPABILITY_METRICS = {
    "reasoning": ["gpqa_diamond", INDEX],
    "context": ["aa_lcr", INDEX],
    "domain": ["aa_omniscience_accuracy", DOMAIN_MEAN, INDEX],
    "reliability": ["aa_omniscience_non_hallucination_rate", INDEX],
    "tools": ["tau_banking", "artificial_analysis_agentic_index", INDEX],
}


def snapshot_entry(raw: dict) -> dict | None:
    """One model of an Artificial Analysis response: identifiers and numeric metrics only."""
    slug = raw.get("slug")
    if not isinstance(slug, str) or not slug:
        return None
    evaluations = raw.get("evaluations") or {}
    metrics = {
        key: float(value)
        for key, value in evaluations.items()
        if isinstance(value, (int, float)) and not isinstance(value, bool)
    }
    domain = [metrics[key] for key in DOMAIN_INDICES if key in metrics]
    if domain:
        metrics[DOMAIN_MEAN] = round(sum(domain) / len(domain), 4)
    creator = raw.get("model_creator") or {}
    pricing = raw.get("pricing") or {}
    return {
        "slug": slug,
        "name": raw.get("name") if isinstance(raw.get("name"), str) else slug,
        "creator": creator.get("name") if isinstance(creator, dict) else None,
        "release_date": raw.get("release_date"),
        "price_in_per_mtok": pricing.get("price_1m_input_tokens"),
        "price_out_per_mtok": pricing.get("price_1m_output_tokens"),
        "metrics": metrics,
    }


def thresholds(values: list[float], percentiles=PERCENTILES) -> dict:
    """Absolute values at the given percentiles of a distribution (frozen in the mapping)."""
    if len(values) < 10:
        raise ValueError("too few models to set thresholds (at least 10)")
    cuts = quantiles(sorted(values), n=100, method="inclusive")
    return {
        "level_2_from": round(cuts[percentiles[0] - 1], 4),
        "level_3_from": round(cuts[percentiles[1] - 1], 4),
        "models": len(values),
    }


def build_mapping(snapshot: dict, version: str, observed_on: str) -> dict:
    metrics = sorted({metric for items in CAPABILITY_METRICS.values() for metric in items})
    frozen = {}
    for metric in metrics:
        values = [
            entry["metrics"][metric] for entry in snapshot["models"] if metric in entry["metrics"]
        ]
        if len(values) >= 10:
            frozen[metric] = thresholds(values)
    return {
        "version": version,
        "source": snapshot["source"],
        "source_url": snapshot["source_url"],
        "snapshot": snapshot["file"],
        "tier": snapshot.get("tier"),
        "intelligence_index_version": snapshot.get("intelligence_index_version"),
        "observed_on": observed_on,
        "percentiles": list(PERCENTILES),
        "capabilities": CAPABILITY_METRICS,
        "thresholds": frozen,
    }


def level(value: float, limits: dict) -> int:
    if value >= limits["level_3_from"]:
        return 3
    return 2 if value >= limits["level_2_from"] else 1


def rate(entry: dict | None, mapping: dict, *, tool_calling: bool) -> dict[str, dict]:
    """Provisional ratings for the five capabilities; unrated when no metric is available."""
    ratings = {}
    for name in CAPABILITIES:
        if name == "tools" and not tool_calling:
            ratings[name] = {
                "level": 1,
                "status": "provisional",
                "source": "No tool calling in the provider facts",
                "observed_on": mapping["observed_on"],
            }
            continue
        chosen = None
        for position, metric in enumerate(mapping["capabilities"][name]):
            limits = mapping["thresholds"].get(metric)
            if entry and limits and metric in entry["metrics"]:
                chosen = (position, metric, entry["metrics"][metric], limits)
                break
        if chosen is None:
            ratings[name] = {"level": None, "status": "unrated"}
            continue
        position, metric, value, limits = chosen
        fallback = " (fallback: preferred benchmark not in the snapshot)" if position else ""
        ratings[name] = {
            "level": level(value, limits),
            "status": "provisional",
            "source": f"{mapping['source']} {metric}={value:g}, {mapping['version']}{fallback}",
            "observed_on": mapping["observed_on"],
        }
    return ratings


def facts_from_openrouter(model: dict, observed_on: str) -> dict:
    """Card facts from one normalised OpenRouter catalogue entry (app.openrouter.normalise)."""
    modalities = [
        item for item in model["input_modalities"] if item in {"text", "image", "audio", "video"}
    ]
    capabilities = ["text", "code"]
    if "image" in modalities:
        capabilities.append("vision")
    for item in ("audio", "video"):
        if item in modalities:
            capabilities.append(item)
    return {
        "context_window": model["context_length"] or model["top_provider"]["context_length"] or 1,
        "modalities": modalities or ["text"],
        "capabilities": capabilities,
        "tool_calling": "tools" in model["supported_parameters"],
        "structured_output": model["structured_output"],
        "price_in_per_mtok": model["price_input_per_million"],
        "price_out_per_mtok": model["price_output_per_million"],
        "free": model["free"],
        "local": False,
        "source": f"https://openrouter.ai/{model['id']} (OpenRouter public catalogue)",
        "observed_on": observed_on,
    }
