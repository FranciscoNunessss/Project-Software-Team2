"""M4: what following the recommendations costs, as a share of always using the top model (KR1.2).

The method is ``docs/ws5/m4-savings-method.md``. Real token counts, prices of one dated catalogue,
and the same token counts priced on both sides (the top model is not run: decision D2). A task the
blind review judged under-sized is charged the recommended model plus the top model, the retry the
user would need. Pure functions: no model, no database, and no text: a row holds ids and numbers.
L7 (WS4) uses ``cost`` and ``ratio`` per user, without the review penalty.
"""

from __future__ import annotations

from collections import Counter

ROW_FIELDS = frozenset({"task", "model", "tokens_in", "tokens_out", "injection", "local"})
CORRECT, OVER, UNDER = "correct", "over_sized", "under_sized"
VERDICT_OF = {"A": CORRECT, "B": CORRECT, "C": OVER, "D": UNDER}
TARGET_PERCENT = 50.0
TOP_OUTPUT_FACTOR = 1.5
MEASURED, INCOMPLETE, NOT_RUN = "measured", "incomplete", "not_run"
PER_TOKEN = 1_000_000


def prices_from(catalogue) -> dict[str, dict]:
    """USD per million tokens for every real card of a catalogue, with its date."""
    return {
        card.id: {
            "in": card.facts.price_in_per_mtok,
            "out": card.facts.price_out_per_mtok,
            "local": card.facts.local,
            "observed_on": card.facts.observed_on,
        }
        for card in catalogue.cards
        if not card.illustrative
    }


def cost(tokens_in: int, tokens_out: int, price: dict, output_factor: float = 1.0) -> float | None:
    """USD for one call; 0 on a local model; None when the price is unknown.

    A free provider quota is still priced at the catalogue price (contract C1), so free quota
    never shows up as a saving.
    """
    if price.get("local"):
        return 0.0
    if price.get("in") is None or price.get("out") is None:
        return None
    return (tokens_in * price["in"] + tokens_out * output_factor * price["out"]) / PER_TOKEN


def ratio(followed: float, top: float) -> float | None:
    return round(100 * followed / top, 1) if top else None


def verdicts_from_votes(votes: dict[str, list[str]]) -> dict[str, str]:
    """Per task, the most common blind-review answer mapped to correct, over or under-sized.

    A or B is correct. A tie between correct and a fault keeps the fault (conservative).
    """
    verdicts = {}
    for task, answers in votes.items():
        counted = Counter(VERDICT_OF[answer] for answer in answers)
        if not counted:
            continue
        best = max(counted.values())
        leaders = {verdict for verdict, count in counted.items() if count == best}
        verdicts[task] = UNDER if UNDER in leaders else OVER if OVER in leaders else CORRECT
    return verdicts


def rows_from_report(report: dict) -> list[dict]:
    """One row per task from the first repeat of an evaluation run (M3), answer tokens included."""
    injection = set(report.get("injection_tasks", []))
    rows = []
    for row in report.get("rows", []):
        if row.get("repeat", 0) != 0 or "recommended" not in row:
            continue
        tokens = row.get("answer_tokens") or {}
        rows.append(
            {
                "task": row["task"],
                "model": row["recommended"],
                "tokens_in": tokens.get("input_tokens"),
                "tokens_out": tokens.get("output_tokens"),
                "injection": row["task"] in injection,
            }
        )
    return rows


def savings(
    rows: list[dict],
    prices: dict[str, dict],
    reference: dict,
    verdicts: dict[str, str] | None = None,
    run_status: str | None = None,
) -> dict:
    """The KR1.2 result. ``reference``: {"model", "price_in_per_mtok", "price_out_per_mtok",
    "observed_on"}; ``verdicts``: task -> correct, over_sized or under_sized (from M6)."""
    for row in rows:
        extra = set(row) - ROW_FIELDS
        if extra:
            raise ValueError(f"row fields not allowed: {', '.join(sorted(extra))}")
    if run_status == NOT_RUN or not rows:
        return {"status": NOT_RUN, "reason": "the run measured nothing: no ratio is reported"}
    top_price = {"in": reference["price_in_per_mtok"], "out": reference["price_out_per_mtok"]}
    verdicts = verdicts or {}
    totals = {"followed": 0.0, "followed_no_penalty": 0.0, "top": 0.0, "top_x": 0.0}
    unpriced, local, injection, under = [], [], [], []
    for row in rows:
        tokens_in, tokens_out = row.get("tokens_in"), row.get("tokens_out")
        price = prices.get(row["model"])
        if not isinstance(tokens_in, int) or not isinstance(tokens_out, int) or price is None:
            unpriced.append(row["task"])
            continue
        own = cost(tokens_in, tokens_out, price)
        top = cost(tokens_in, tokens_out, top_price)
        top_x = cost(tokens_in, tokens_out, top_price, TOP_OUTPUT_FACTOR)
        if own is None:
            unpriced.append(row["task"])
            continue
        if price.get("local"):
            local.append(row["task"])
        penalty = top if verdicts.get(row["task"]) == UNDER else 0.0
        if penalty:
            under.append(row["task"])
        totals["followed"] += own + penalty
        totals["followed_no_penalty"] += own
        totals["top"] += top
        totals["top_x"] += top_x
        if row.get("injection"):
            injection.append({"task": row["task"], "model": row["model"], "cost": own, "top": top})
    result_ratio = ratio(totals["followed"], totals["top"])
    status = INCOMPLETE if unpriced else MEASURED
    return {
        "status": status,
        "ratio_percent": result_ratio,
        "ratio_without_review_penalty": ratio(totals["followed_no_penalty"], totals["top"]),
        "ratio_if_top_writes_1_5x": ratio(totals["followed"], totals["top_x"]),
        "target_percent": TARGET_PERCENT,
        "passes": status == MEASURED
        and result_ratio is not None
        and result_ratio <= TARGET_PERCENT,
        "review_applied": bool(verdicts),
        "tasks": len(rows),
        "under_sized": under,
        "unpriced": unpriced,
        "local": local,
        "injection": injection,
        "totals_usd": {key: round(value, 6) for key, value in totals.items()},
        "currency": "USD",
        "reference": reference,
    }
