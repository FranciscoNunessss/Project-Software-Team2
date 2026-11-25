"""Synthetic usage (contract C1) and learning events (contract C2) for the Team Scope (WS3 T2, T7).

Until the WS1 gateway writes real C1 records and WS4 writes C2 events, the group dashboard reads
this source. It is deterministic: the same user and day always give the same records, so the demo,
the seed script and the tests agree. Every record has the contract's fields and nothing else: ids,
enums and numbers, never text. Responses built from it say ``"source": "mock"``.
"""

from __future__ import annotations

import hashlib
import random
from datetime import UTC, date, datetime, timedelta

SOURCE = "mock"
PRICE_CATALOG_DATE = "2026-11-06"
# Demo conversion for estimated cost in EUR; synthetic data only, labelled as such in the UI.
MOCK_EUR_PER_USD = 0.92
# (provider, model, card, USD per million tokens in, out): catalogue-2.1 card prices.
MODELS = (
    ("groq", "openai/gpt-oss-20b", "gpt-oss-20b", 0.03, 0.13),
    ("openrouter", "google/gemma-4-26b-a4b-it", "gemma-4-26b-a4b", 0.0675, 0.225),
    ("openai", "gpt-5.4-mini", "gpt-5-4-mini", 0.75, 4.5),
    ("claude", "claude-sonnet-5-5", "claude-sonnet-5-5", 2.0, 10.0),
)
FEATURES = ("analysis", "coach", "chat", "educator")
C1_FIELDS = (
    "call_id",
    "created_at",
    "user_id",
    "surface",
    "feature",
    "provider",
    "model",
    "key_owner",
    "tokens_in",
    "tokens_out",
    "latency_ms",
    "queued_ms",
    "est_cost_eur",
    "price_catalog_date",
    "status",
)


def _rng(*parts: str) -> random.Random:
    seed = hashlib.sha256(":".join(parts).encode()).hexdigest()
    return random.Random(int(seed[:16], 16))


def activity(user_id: str) -> float:
    """Tasks a day on average for this user; about one user in five never uses AdaptAI."""
    rng = _rng("activity", user_id)
    return 0.0 if rng.random() < 0.2 else round(rng.uniform(0.4, 3.0), 2)


def _day_start(day: date) -> int:
    return int(datetime(day.year, day.month, day.day, tzinfo=UTC).timestamp())


def day_records(user_id: str, day: date) -> tuple[list[dict], list[dict]]:
    """(C1 usage records, C2 events) of one user on one day."""
    rate = activity(user_id)
    rng = _rng("day", user_id, day.isoformat())
    tasks = 0 if rate == 0 else sum(rng.random() < rate / 3 for _ in range(3))
    usage, events = [], []
    start = _day_start(day)
    for task in range(tasks):
        at = start + rng.randint(8 * 3600, 19 * 3600)
        recommended = rng.choices(range(len(MODELS)), weights=(5, 4, 2, 1))[0]
        sizing = rng.choices(("match", "over", "under"), weights=(7, 2, 1))[0]
        chosen = {
            "match": recommended,
            "over": min(recommended + 1, len(MODELS) - 1),
            "under": max(recommended - 1, 0),
        }[sizing]
        if chosen == recommended:
            sizing = "match"
        for feature in ("analysis", "chat"):
            provider, model, _, price_in, price_out = MODELS[0 if feature == "analysis" else chosen]
            tokens_in = rng.randint(600, 2500)
            tokens_out = rng.randint(150, 1800)
            cost_usd = (tokens_in * price_in + tokens_out * price_out) / 1_000_000
            usage.append(
                {
                    "call_id": f"mock-{user_id[:8]}-{day.isoformat()}-{task}-{feature}",
                    "created_at": at,
                    "user_id": user_id,
                    "surface": rng.choice(("web", "web", "ide")),
                    "feature": feature,
                    "provider": provider,
                    "model": model,
                    "key_owner": "platform" if provider == "groq" else "user",
                    "tokens_in": tokens_in,
                    "tokens_out": tokens_out,
                    "latency_ms": rng.randint(900, 14000),
                    "queued_ms": 0,
                    "est_cost_eur": round(cost_usd * MOCK_EUR_PER_USD, 6),
                    "price_catalog_date": PRICE_CATALOG_DATE,
                    "status": "ok",
                }
            )
        events.append(
            {
                "event": "recommendation_decided",
                "user_id": user_id,
                "created_at": at,
                "recommended": MODELS[recommended][2],
                "chosen": MODELS[chosen][2],
                "sizing": sizing,
            }
        )
        if rng.random() < 0.7:  # not every task gets feedback
            events.append(
                {
                    "event": "outcome_reported",
                    "user_id": user_id,
                    "created_at": at + 600,
                    "resolved": rng.choices(("yes", "partly", "no"), weights=(6, 3, 1))[0],
                }
            )
    return usage, events


class MockSource:
    """The dashboard's data source until real C1/C2 records exist."""

    name = SOURCE

    def records(self, user_ids: list[str], start: date, end: date) -> tuple[list[dict], list[dict]]:
        """All records of these users from ``start`` to ``end`` inclusive."""
        usage, events = [], []
        day = start
        while day <= end:
            for user_id in user_ids:
                more_usage, more_events = day_records(user_id, day)
                usage += more_usage
                events += more_events
            day += timedelta(days=1)
        return usage, events
