"""Automatic evaluation of the models configured in the app (ADR-014, measure-suite-1).

Only models that someone has configured are evaluated, and each one once:

1. Inventory: the server models and every enabled personal configuration with a model.
2. For each (provider, model) without a current evaluation, a row is created:
   - free, local or server models: queued straight away;
   - a paid model with a user's key: awaiting the user's consent, with an estimated and a
     guaranteed maximum cost (price unknown: the user confirms twice).
3. A background worker runs an adaptive version of measure-suite-1 (level 2 first, then 3
   or 1; at most 40 tasks), grades every answer automatically and stores the levels.
4. Results of official cloud endpoints are shared by every user (scope "shared"); local
   models (Ollama, LM Studio) are evaluated per user and never shared.

Where a model's levels come from, best first (``Ratings``): the team's calibrated catalogue
levels, then our measured levels, then the catalogue's provisional levels, then the
Artificial Analysis overall index (one number for all five capabilities), then the lowest
levels measured in the same family. Without any of them the model is never recommended.
"""

import asyncio
import json
import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from statistics import quantiles
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app import arena
from app.accounts import AuthenticatedUser
from app.catalogue import CAPABILITIES, CATALOGUE_DIR, Card, Catalogue, active_catalogue
from app.measurement import SUITE_VERSION, Task, build_suite, grade
from app.providers import Settings, chat_model
from app.recommendation import LOCAL_PROVIDERS, Option
from app.storage import Storage

LOGGER = logging.getLogger("adaptai.evaluations")
SHARED_PROVIDERS = {"groq", "openrouter", "openai", "claude"}
SEED = 1
PASS = 0.75
OUTPUT_CAP = 1024  # tokens per answer: makes the maximum cost a guarantee
TYPICAL_OUTPUT = 300
PROMPT_OVERHEAD = 40  # tokens of message framing per call
MAX_ERROR_SHARE = 0.10
REFUSED_STREAK = 5  # failed calls in a row (after retries) that end a run early
REEVALUATE_AFTER_DAYS = 90
NOW = "to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"


# --- what is configured ---------------------------------------------------------------------


@dataclass(frozen=True)
class Target:
    provider: str
    model: str
    configuration_id: str  # server:<provider>[:<model>] or a personal configuration id
    user_id: str | None  # None for server models

    @property
    def scope(self) -> str:
        if self.provider in SHARED_PROVIDERS:
            return "shared"
        return self.user_id or "server"

    @property
    def paid_by_user(self) -> bool:
        return self.user_id is not None and self.provider not in LOCAL_PROVIDERS


def inventory(store: Storage, configurations, enabled: dict[str, bool]) -> list[Target]:
    """Every model the app can send to right now: server models and enabled configurations."""
    targets = [
        Target(item["provider"], item["model"], item["id"], None)
        for item in configurations.server_options(enabled)
        if item["provider"] != "demo" and item["model"]
    ]
    with store.connect() as db:
        rows = db.execute(
            "SELECT id,user_id,provider,model FROM llm_configs "
            "WHERE enabled=1 AND model IS NOT NULL AND model<>'' ORDER BY sequence_id"
        ).fetchall()
    targets += [Target(row["provider"], row["model"], row["id"], row["user_id"]) for row in rows]
    # Models chosen from OpenRouter's picker (user_models), while their configuration is on.
    with store.connect() as db:
        chosen = db.execute(
            "SELECT u.user_id,u.configuration_id,u.model,c.provider FROM user_models u "
            "JOIN llm_configs c ON c.id=u.configuration_id AND c.user_id=u.user_id "
            "WHERE c.enabled=1 ORDER BY u.added_at"
        ).fetchall()
    known = {(t.provider, t.model, t.user_id) for t in targets}
    targets += [
        Target(row["provider"], row["model"], row["configuration_id"], row["user_id"])
        for row in chosen
        if (row["provider"], row["model"], row["user_id"]) not in known
    ]
    return targets


def add_user_model(store: Storage, user_id: str, configuration_id: str, model: str) -> Target:
    """Remember a model picked from a provider's catalogue so it is evaluated and recommended."""
    with store.connect() as db:
        config = db.execute(
            "SELECT provider FROM llm_configs WHERE id=%s AND user_id=%s AND enabled=1",
            (configuration_id, user_id),
        ).fetchone()
        if not config or config["provider"] != "openrouter":
            raise HTTPException(404, "configuration_not_found")
        db.execute(
            "INSERT INTO user_models(user_id,configuration_id,model) VALUES (%s,%s,%s) "
            "ON CONFLICT DO NOTHING",
            (user_id, configuration_id, model),
        )
    return Target("openrouter", model, configuration_id, user_id)


# --- the project's own evaluations (A10, layer 3) -------------------------------------------

PROJECT_CONFIGURATION = "project:openrouter"
MOST_USED_FILE = CATALOGUE_DIR / "most-used.json"


def project_targets(settings: Settings, ratings: "Ratings") -> list[Target]:
    """Models no public source rates, measured with the project's key, best known first.

    First the most used models without a public source (most-used.json), then every free
    OpenRouter model in the committed snapshot that no source rates. Paid models only when
    ``evaluation_paid`` is on (the key's account has credit). Empty without the key.
    """
    if not settings.evaluation_openrouter_key.get_secret_value():
        return []
    try:
        most_used = json.loads(MOST_USED_FILE.read_text(encoding="utf-8"))["no_public_source"]
    except (OSError, ValueError, KeyError):
        most_used = []
    snapshot, _ = _router_snapshot()
    ids = [item["model"] for item in most_used if item.get("provider") == "openrouter"]
    ids += sorted(model for model, item in snapshot.items() if item.get("free"))
    if settings.evaluation_paid:
        # Cheapest first: the budget then rates as many models as it can.
        ids += sorted(
            (m for m, item in snapshot.items() if not item.get("free")),
            key=lambda m: (
                (snapshot[m].get("price_input_per_million") or 1e9) * 3
                + (snapshot[m].get("price_output_per_million") or 1e9)
            ),
        )
    targets, seen = [], set()
    for model in ids:
        if model in seen or model not in snapshot:
            continue
        seen.add(model)
        if not snapshot[model].get("free") and not settings.evaluation_paid:
            continue
        if snapshot[model].get("output_modalities", ["text"]) != ["text"]:
            continue  # music, image or speech generators: not chat models
        found = ratings.source("openrouter", model)
        if found is None or found[0] in {"arena", "benchmark", "family"}:
            # Public levels are provisional; free models are measured anyway (they cost 0).
            if found is None or snapshot[model].get("free"):
                targets.append(Target("openrouter", model, PROJECT_CONFIGURATION, None))
    return targets


def project_room(store: Storage, settings: Settings, row_estimate: dict) -> bool:
    """True when a new project run fits today's call limit and the total budget."""
    today = time.strftime("%Y-%m-%d", time.gmtime())
    with store.connect() as db:
        used = db.execute(
            "SELECT COALESCE(SUM(progress),0) AS calls, COALESCE(SUM(spent_usd),0) AS usd "
            "FROM model_evaluations WHERE configuration_id=%s",
            (PROJECT_CONFIGURATION,),
        ).fetchone()
        calls_today = db.execute(
            "SELECT COALESCE(SUM(progress),0) AS calls FROM model_evaluations "
            "WHERE configuration_id=%s AND updated_at LIKE %s",
            (PROJECT_CONFIGURATION, f"{today}%"),
        ).fetchone()["calls"]
        running = db.execute(
            "SELECT COUNT(*) AS n FROM model_evaluations WHERE configuration_id=%s "
            "AND status IN ('queued','running')",
            (PROJECT_CONFIGURATION,),
        ).fetchone()["n"]
    if running or calls_today + max_calls() > settings.evaluation_daily_calls:
        return False
    if row_estimate.get("free"):
        return True
    worst = row_estimate.get("max_usd")
    return worst is not None and float(used["usd"]) + worst <= settings.evaluation_budget_usd


async def ensure_project(store: Storage, settings: Settings, ratings: "Ratings", router=None):
    """Queue at most one project run, the first target without a current evaluation."""
    for target in project_targets(settings, ratings):
        with store.connect() as db:
            current = _current(db, target)
        if current and current["status"] in {"queued", "running"}:
            return current
        if current and current["status"] == "done" and not _stale(current):
            continue
        if (
            current
            and current["status"] == "failed"
            and current["updated_at"]
            > time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - 86400))
        ):
            continue  # a failed project run waits a day: the daily limit has to reset
        facts = await model_facts(target, active_catalogue(), router)
        cost = estimate(
            facts.get("price_in_per_mtok") if facts else None,
            facts.get("price_out_per_mtok") if facts else None,
            is_free(target, facts),
        )
        if not project_room(store, settings, cost):
            return None
        row = await ensure(store, target, router, force=bool(current))
        LOGGER.info("Project evaluation queued: %s", target.model)
        return row
    return None


# --- cost ----------------------------------------------------------------------------------


def suite() -> list[Task]:
    return build_suite(SEED)


def _tokens(task: Task) -> int:
    return len(task.prompt) // 4 + PROMPT_OVERHEAD


def worst_case_input_tokens() -> int:
    """Input tokens of the longest adaptive path: level 2 plus the larger of level 1 or 3."""
    tasks = suite()
    total = 0
    for name in CAPABILITIES:
        by_level = {
            level: sum(_tokens(t) for t in tasks if t.capability == name and t.level == level)
            for level in (1, 2, 3)
        }
        total += by_level[2] + max(by_level[1], by_level[3])
    return total


def max_calls() -> int:
    return len(CAPABILITIES) * 8


def estimate(price_in: float | None, price_out: float | None, free: bool) -> dict:
    """Estimated and guaranteed maximum cost of one adaptive evaluation, in USD."""
    input_tokens = worst_case_input_tokens()
    calls = max_calls()
    known = free or (price_in is not None and price_out is not None)
    result = {
        "calls_max": calls,
        "input_tokens_max": input_tokens,
        "output_tokens_max": calls * OUTPUT_CAP,
        "price_known": known,
        "free": free,
        "estimated_usd": None,
        "max_usd": None,
    }
    if free:
        result.update(estimated_usd=0.0, max_usd=0.0)
    elif known:
        result["estimated_usd"] = round(
            (input_tokens * price_in + calls * TYPICAL_OUTPUT * price_out) / 1e6, 4
        )
        result["max_usd"] = round(
            (input_tokens * price_in + calls * OUTPUT_CAP * price_out) / 1e6, 4
        )
    return result


async def model_facts(target: Target, catalogue: Catalogue, router=None) -> dict | None:
    """Price and facts: the catalogue card (and alias price), else OpenRouter's catalogue."""
    card = catalogue.card_for(target.provider, target.model)
    if card is not None:
        alias = catalogue.alias(target.provider, target.model)
        price_in, price_out = card.facts.price_in_per_mtok, card.facts.price_out_per_mtok
        if alias is not None and alias.price_in_per_mtok is not None:
            price_in, price_out = alias.price_in_per_mtok, alias.price_out_per_mtok
        return {
            **card.facts.model_dump(),
            "price_in_per_mtok": price_in,
            "price_out_per_mtok": price_out,
        }
    if target.provider == "openrouter" and router is not None:
        from app.classification import facts_from_openrouter

        try:
            models, _ = await router.models()
        except Exception:  # noqa: BLE001 - offline: the committed snapshot below answers
            models = []
        match = next((item for item in models if item["id"] == target.model), None)
        if match is not None:
            return facts_from_openrouter(match, time.strftime("%Y-%m-%d"))
    if target.provider == "openrouter":
        return router_snapshot_facts(target.model)
    return None


def is_free(target: Target, facts: dict | None) -> bool:
    if target.provider in LOCAL_PROVIDERS or target.model.endswith(":free"):
        return True
    return bool(facts and (facts.get("free") or facts.get("local")))


# --- the queue -----------------------------------------------------------------------------


def _current(db, target: Target) -> dict | None:
    """The run that answers for this model now: an open one, else the latest done one."""
    row = db.execute(
        "SELECT * FROM model_evaluations WHERE provider=%s AND model=%s AND scope=%s "
        "AND suite_version=%s ORDER BY (status IN ('awaiting_consent','declined','queued',"
        "'running')) DESC, sequence_id DESC LIMIT 1",
        (target.provider, target.model, target.scope, SUITE_VERSION),
    ).fetchone()
    return dict(row) if row else None


def _done(db, provider: str, model: str, scope: str) -> dict | None:
    row = db.execute(
        "SELECT * FROM model_evaluations WHERE provider=%s AND model=%s AND scope=%s "
        "AND suite_version=%s AND status='done' ORDER BY sequence_id DESC LIMIT 1",
        (provider, model, scope, SUITE_VERSION),
    ).fetchone()
    return dict(row) if row else None


def _stale(row: dict) -> bool:
    finished = row.get("finished_at")
    if not finished:
        return False
    age = time.time() - time.mktime(time.strptime(finished[:19], "%Y-%m-%dT%H:%M:%S"))
    return age > REEVALUATE_AFTER_DAYS * 86400


async def ensure(store: Storage, target: Target, router=None, *, force: bool = False) -> dict:
    """Make sure the model has a current evaluation or an open run; returns that row."""
    facts = await model_facts(target, active_catalogue(), router)
    free = is_free(target, facts)
    cost = estimate(
        facts.get("price_in_per_mtok") if facts else None,
        facts.get("price_out_per_mtok") if facts else None,
        free,
    )
    needs_consent = target.paid_by_user and not free
    with store.connect() as db:
        db.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
            (f"{store.schema}:evaluation:{target.provider}:{target.model}:{target.scope}",),
        )
        current = _current(db, target)
        if current and current["status"] in {"awaiting_consent", "declined", "queued", "running"}:
            return current
        if current and current["status"] == "done" and not force and not _stale(current):
            return current
        if current and current["status"] == "failed" and not force:
            # Free runs retry by themselves after an hour; paid ones need the user again.
            recent = current["updated_at"] > time.strftime(
                "%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - 3600)
            )
            if recent or needs_consent:
                return current
        identifier = str(uuid4())
        db.execute(
            """INSERT INTO model_evaluations(id,provider,model,scope,suite_version,status,
               requested_by,configuration_id,total,estimate_json,facts_json)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (
                identifier,
                target.provider,
                target.model,
                target.scope,
                SUITE_VERSION,
                "awaiting_consent" if needs_consent else "queued",
                target.user_id,
                None if needs_consent else target.configuration_id,
                max_calls(),
                json.dumps(cost),
                json.dumps(facts) if facts else None,
            ),
        )
        return dict(
            db.execute("SELECT * FROM model_evaluations WHERE id=%s", (identifier,)).fetchone()
        )


# --- the runner ----------------------------------------------------------------------------

ModelFactory = Callable[[str, Settings, int], Any]


def _claim(store: Storage) -> dict | None:
    with store.connect() as db:
        row = db.execute(
            "SELECT * FROM model_evaluations WHERE status='queued' "
            "ORDER BY sequence_id LIMIT 1 FOR UPDATE SKIP LOCKED"
        ).fetchone()
        if not row:
            return None
        db.execute(
            f"UPDATE model_evaluations SET status='running',updated_at={NOW} WHERE id=%s",
            (row["id"],),
        )
        return dict(row)


def _settings_for(row: dict, configurations) -> Settings:
    identifier = row["configuration_id"] or ""
    if identifier == PROJECT_CONFIGURATION:
        key = configurations.settings.evaluation_openrouter_key
        if row["provider"] != "openrouter" or not key.get_secret_value():
            raise LookupError("project_key_missing")
        return configurations.settings.model_copy(
            update={"openrouter_api_key": key, "openrouter_model": row["model"]}
        )
    if identifier.startswith("server:"):
        from app.llm_config import MODEL_FIELDS

        return configurations.settings.model_copy(
            update={MODEL_FIELDS[row["provider"]]: row["model"]}
        )
    with configurations.store.connect() as db:
        config = db.execute(
            "SELECT * FROM llm_configs WHERE id=%s AND enabled=1", (identifier,)
        ).fetchone()
    if not config or config["provider"] != row["provider"]:
        raise LookupError("configuration_gone")
    settings = configurations.configured_settings(dict(config))
    project_key = configurations.settings.evaluation_openrouter_key
    if (
        row["provider"] == "openrouter"
        and json.loads(row.get("estimate_json") or "{}").get("free")
        and project_key.get_secret_value()
    ):
        # A free model is measured with the project's key: the user's free daily calls stay
        # for their own chats (A11). The result is shared either way.
        settings = settings.model_copy(update={"openrouter_api_key": project_key})
    if config["model"] != row["model"]:
        # A model picked from OpenRouter's catalogue with this configuration's key.
        if row["provider"] != "openrouter":
            raise LookupError("configuration_gone")
        settings = settings.model_copy(update={"openrouter_model": row["model"]})
    return settings


def _text(reply) -> str:
    content = getattr(reply, "content", reply)
    if isinstance(content, list):
        content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
    return str(content).strip()


def _usage(reply, task: Task, answer: str) -> tuple[int, int]:
    usage = getattr(reply, "usage_metadata", None) or {}
    return (
        int(usage.get("input_tokens") or _tokens(task)),
        int(usage.get("output_tokens") or max(1, len(answer) // 4)),
    )


async def _ask(llm, task: Task, sleep: Callable) -> tuple[str | None, Any]:
    wait = 10.0
    for attempt in range(5):
        try:
            reply = await llm.ainvoke([("human", task.prompt)])
            return _text(reply), reply
        except Exception as exc:  # noqa: BLE001 - provider errors vary; retried, then counted
            text = f"{type(exc).__name__} {exc}".lower()
            transient = any(word in text for word in ("429", "rate", "limit", "timeout", "50"))
            if not transient or attempt == 4:
                return None, None
            await sleep(wait)
            wait = min(wait * 2, 120)
    return None, None


def adaptive_levels(rates: dict[str, dict[int, float]]) -> dict[str, int | None]:
    """Level 3 when 2 and 3 pass, 2 when only 2 passes, 1 when 1 passes, else None."""
    result = {}
    for name, by_level in rates.items():
        if by_level.get(2, 0) >= PASS:
            result[name] = 3 if by_level.get(3, 0) >= PASS else 2
        else:
            result[name] = 1 if by_level.get(1, 0) >= PASS else None
    return result


async def run(
    store: Storage,
    row: dict,
    configurations,
    model_factory: ModelFactory = chat_model,
    sleep: Callable = asyncio.sleep,
    wait_turn: Callable | None = None,
) -> dict:
    """Run one claimed evaluation to the end; never raises.

    ``wait_turn`` is awaited before every call: the worker gives way to the users' own
    analyses and chats, which share the provider's rate limits.
    """
    estimate_data = json.loads(row["estimate_json"] or "{}")
    facts = json.loads(row["facts_json"] or "null") or {}
    price_in = facts.get("price_in_per_mtok") or 0
    price_out = facts.get("price_out_per_mtok") or 0
    if estimate_data.get("free"):
        price_in = price_out = 0
    limit = estimate_data.get("max_usd")
    try:
        llm = model_factory(row["provider"], _settings_for(row, configurations), OUTPUT_CAP)
    except Exception as exc:  # noqa: BLE001 - recorded on the row
        return _finish(store, row, "failed", failure=type(exc).__name__)
    tasks = suite()
    results, rates, spent, done, errors, streak = [], {}, 0.0, 0, 0, 0

    async def level(name: str, level: int) -> float:
        nonlocal spent, done, errors, streak
        chosen = [t for t in tasks if t.capability == name and t.level == level]
        passed = 0
        for task in chosen:
            if wait_turn is not None:
                await wait_turn()
            answer, reply = await _ask(llm, task, sleep)
            done += 1
            streak = streak + 1 if answer is None else 0
            if answer is None:
                errors += 1
                results.append(
                    {
                        "id": task.id,
                        "capability": name,
                        "level": level,
                        "passed": False,
                        "error": True,
                        "answer": "",
                    }
                )
            else:
                tokens_in, tokens_out = _usage(reply, task, answer)
                spent += (tokens_in * price_in + tokens_out * price_out) / 1e6
                ok = grade(task, answer)
                passed += ok
                results.append(
                    {
                        "id": task.id,
                        "capability": name,
                        "level": level,
                        "passed": ok,
                        "error": False,
                        "answer": answer[:600],
                    }
                )
            with store.connect() as db:
                db.execute(
                    f"UPDATE model_evaluations SET progress=%s,errors=%s,spent_usd=%s,"
                    f"updated_at={NOW} WHERE id=%s",
                    (done, errors, round(spent, 6), row["id"]),
                )
            if limit and spent >= limit:  # free runs (limit 0) cost nothing
                raise _OverBudget()
            if streak >= REFUSED_STREAK:
                raise _Refused()
        return passed / len(chosen)

    try:
        for name in CAPABILITIES:
            rates[name] = {2: await level(name, 2)}
            next_level = 3 if rates[name][2] >= PASS else 1
            rates[name][next_level] = await level(name, next_level)
    except _OverBudget:
        return _finish(store, row, "failed", failure="cost_limit_reached", results=results)
    except _Refused:
        # No credit, a daily limit reached, a model withdrawn: stop instead of 40 failures.
        return _finish(store, row, "failed", failure="provider_refused", results=results)
    if errors > MAX_ERROR_SHARE * done:
        return _finish(store, row, "failed", failure="too_many_failed_calls", results=results)
    levels = adaptive_levels(rates)
    summary = {
        name: {
            "level": levels[name] or 1,
            "below_level_1": levels[name] is None,
            "pass_rates": {str(k): round(v, 2) for k, v in sorted(rates[name].items())},
        }
        for name in CAPABILITIES
    }
    return _finish(store, row, "done", levels=summary, results=results)


class _OverBudget(Exception):
    pass


class _Refused(Exception):
    pass


def _finish(store, row, status, *, failure=None, levels=None, results=None) -> dict:
    with store.connect() as db:
        db.execute(
            f"""UPDATE model_evaluations SET status=%s,failure=%s,levels_json=%s,
                results_json=%s,updated_at={NOW},finished_at={NOW} WHERE id=%s""",
            (
                status,
                failure,
                json.dumps(levels) if levels else None,
                json.dumps(results) if results else None,
                row["id"],
            ),
        )
        return dict(
            db.execute("SELECT * FROM model_evaluations WHERE id=%s", (row["id"],)).fetchone()
        )


def recover(store: Storage) -> None:
    """After a restart, runs left 'running' are retried when free, or failed when paid (the
    user decides again, so nothing is charged twice without consent)."""
    with store.connect() as db:
        rows = db.execute(
            "SELECT id,estimate_json,configuration_id,provider FROM model_evaluations "
            "WHERE status='running'"
        ).fetchall()
        for row in rows:
            free = json.loads(row["estimate_json"] or "{}").get("free")
            ours = (row["configuration_id"] or "").startswith(("server:", "project:"))
            if free or ours or row["provider"] in LOCAL_PROVIDERS:
                db.execute(
                    f"UPDATE model_evaluations SET status='queued',progress=0,errors=0,"
                    f"updated_at={NOW} WHERE id=%s",
                    (row["id"],),
                )
            else:
                db.execute(
                    f"UPDATE model_evaluations SET status='failed',failure='interrupted',"
                    f"updated_at={NOW},finished_at={NOW} WHERE id=%s",
                    (row["id"],),
                )


def _has_queued(store: Storage) -> bool:
    with store.connect() as db:
        return bool(
            db.execute("SELECT 1 FROM model_evaluations WHERE status='queued' LIMIT 1").fetchone()
        )


async def run_next(
    store, configurations, model_factory=chat_model, sleep=asyncio.sleep, wait_turn=None
):
    row = _claim(store)
    if row is None:
        return None
    return await run(store, row, configurations, model_factory, sleep, wait_turn)


# --- where the levels come from -------------------------------------------------------------

AA_SNAPSHOT = max((CATALOGUE_DIR / "sources").glob("aa-2*.json"), default=CATALOGUE_DIR / "none")
AA_ALIASES = CATALOGUE_DIR / "aa-aliases.json"
INDEX = "artificial_analysis_intelligence_index"


@lru_cache(maxsize=1)
def aa_reference() -> tuple[dict, dict, dict]:
    """Confirmed (provider, model) -> AA slug, slug -> index, and the frozen index thresholds."""
    try:
        snapshot = json.loads(Path(AA_SNAPSHOT).read_text(encoding="utf-8"))
        aliases = json.loads(Path(AA_ALIASES).read_text(encoding="utf-8"))["aliases"]
    except (OSError, ValueError, KeyError):
        return {}, {}, {}
    values = {
        entry["slug"]: entry["metrics"][INDEX]
        for entry in snapshot["models"]
        if INDEX in entry["metrics"]
    }
    cuts = (
        quantiles(sorted(values.values()), n=100, method="inclusive") if len(values) >= 10 else []
    )
    limits = (
        {
            "level_2_from": cuts[33],
            "level_3_from": cuts[66],
            "observed_on": snapshot["observed_on"],
            "version": snapshot.get("intelligence_index_version"),
        }
        if cuts
        else {}
    )
    mapping = {(item["provider"], item["model"]): item["slug"] for item in aliases}
    return mapping, values, limits


@lru_cache(maxsize=1)
def _router_snapshot() -> tuple[dict, str]:
    path = max((CATALOGUE_DIR / "sources").glob("openrouter-2*.json"), default=None)
    if path is None:
        return {}, ""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}, ""
    return {item["id"]: item for item in data.get("models", [])}, data.get("observed_on", "")


def router_snapshot_facts(model: str) -> dict | None:
    """Facts (price, context, tools) of an OpenRouter model from the committed public snapshot,
    for models rated from a public source before anyone measured them."""
    from app.classification import facts_from_openrouter

    models, observed_on = _router_snapshot()
    entry = models.get(model)
    return facts_from_openrouter(entry, observed_on) if entry else None


def family_of(model: str) -> str:
    """The name up to the first part with a digit: 'google/gemma-4-26b-a4b-it:free' -> 'gemma',
    'openai/gpt-oss-20b' -> 'gpt-oss', 'gpt-5.4-mini' -> 'gpt', 'claude-sonnet-5-5' ->
    'claude-sonnet'."""
    name = model.split("/")[-1].split(":")[0].lower()
    parts = []
    for part in re.split(r"[-_ ]", name):
        if re.search(r"\d", part):
            break
        parts.append(part)
    return "-".join(parts) or name


def _slug(provider: str, model: str) -> str:
    return re.sub(r"[^a-z0-9.\-]+", "-", f"{provider}-{model}".lower()).strip("-.") or "model"


class Ratings:
    """Builds the card used by the recommendation for every option (see module docstring)."""

    def __init__(self, store: Storage | None, catalogue: Catalogue, user_id: str | None = None):
        self.catalogue = catalogue
        self.measured: dict[tuple[str, str], dict] = {}
        if store is not None:
            with store.connect() as db:
                rows = db.execute(
                    "SELECT DISTINCT ON (provider,model,scope) provider,model,scope,levels_json,"
                    "facts_json,finished_at,id FROM model_evaluations WHERE status='done' AND "
                    "suite_version=%s AND (scope='shared' OR scope=%s OR scope='server') "
                    "ORDER BY provider,model,scope,sequence_id DESC",
                    (SUITE_VERSION, user_id or ""),
                ).fetchall()
            for row in rows:
                self.measured[(row["provider"], row["model"])] = dict(row)

    def source(self, provider: str, model: str | None) -> tuple[str, dict[str, dict]] | None:
        """(source name, {capability: rating}) for one model, best source first."""
        if not model:
            return None
        card = self.catalogue.card_for(provider, model)
        measured = self.measured.get((provider, model))
        ratings: dict[str, dict] = {}
        names = set()
        for capability in CAPABILITIES:
            rating = None
            if card and card.capabilities[capability].status == "calibrated":
                rating, name = card.capabilities[capability].model_dump(), "calibrated"
            elif measured:
                item = json.loads(measured["levels_json"])[capability]
                rates = ", ".join(f"L{k} {v:.0%}" for k, v in item["pass_rates"].items())
                rating = {
                    "level": item["level"],
                    "status": "measured",
                    "source": f"{SUITE_VERSION} (adaptive): {rates}",
                    "observed_on": (measured["finished_at"] or "")[:10] or "2026-11-07",
                }
                name = "measured"
            elif card and card.capabilities[capability].level is not None:
                rating, name = card.capabilities[capability].model_dump(), "provisional"
            if rating:
                ratings[capability] = rating
                names.add(name)
        if len(ratings) == len(CAPABILITIES):
            return (
                "calibrated"
                if names == {"calibrated"}
                else "measured"
                if "measured" in names
                else "provisional"
            ), ratings
        # LMArena per category (A10): public, free, provisional, below everything measured.
        arena_levels = arena.ratings(provider, model)
        if arena_levels:
            return "arena", arena_levels
        mapping, values, limits = aa_reference()
        slug = mapping.get((provider, model))
        if slug in values and limits:
            value = values[slug]
            level = (
                3
                if value >= limits["level_3_from"]
                else 2
                if value >= limits["level_2_from"]
                else 1
            )
            rating = {
                "level": level,
                "status": "provisional",
                "source": f"Artificial Analysis overall index v{limits['version']} = {value:g} "
                f"({slug}); the same level for every capability",
                "observed_on": limits["observed_on"],
            }
            return "benchmark", dict.fromkeys(CAPABILITIES, rating)
        family = family_of(model)
        members = [
            row for (p, m), row in self.measured.items() if family_of(m) == family and m != model
        ]
        if members:
            lowest = {
                capability: min(
                    json.loads(row["levels_json"])[capability]["level"] for row in members
                )
                for capability in CAPABILITIES
            }
            return "family", {
                capability: {
                    "level": lowest[capability],
                    "status": "provisional",
                    "source": f"Lowest level measured in the {family} family",
                    "observed_on": time.strftime("%Y-%m-%d"),
                }
                for capability in CAPABILITIES
            }
        return None

    def card(self, option: Option) -> Card | None:
        """The card the recommendation compares for this option, or None (never recommended)."""
        found = self.source(option.provider, option.model)
        if found is None:
            return None
        _, ratings = found
        card = self.catalogue.card_for(option.provider, option.model)
        if card is not None:
            return card.model_copy(
                update={
                    "capabilities": {
                        name: card.capabilities[name].model_copy(update=rating)
                        for name, rating in ratings.items()
                    }
                }
            )
        measured = self.measured.get((option.provider, option.model))
        facts = json.loads(measured["facts_json"]) if measured and measured["facts_json"] else None
        if facts is None and option.provider == "openrouter":
            facts = router_snapshot_facts(option.model)
        facts = facts or {
            "context_window": 128000,
            "modalities": ["text"],
            "capabilities": ["text", "code"],
            "tool_calling": False,
            "structured_output": False,
            "price_in_per_mtok": None,
            "price_out_per_mtok": None,
            "free": option.model.endswith(":free"),
            "local": option.provider in LOCAL_PROVIDERS,
            "source": "Unknown: no provider facts",
            "observed_on": time.strftime("%Y-%m-%d"),
        }
        return Card.model_validate(
            {
                "id": _slug(option.provider, option.model),
                "family": family_of(option.model),
                "name": option.model.split("/")[-1],
                "aliases": [],
                "facts": facts,
                "capabilities": ratings,
            }
        )


def pending_for(store: Storage, options: list[Option], user_id: str) -> list[str]:
    """Models of these options without levels yet, with what they wait for (for the notes)."""
    found = []
    with store.connect() as db:
        for option in options:
            if not option.model:
                continue
            server = (option.configuration_id or "").startswith("server:")
            target = Target(
                option.provider,
                option.model,
                option.configuration_id or "",
                None if server else user_id,
            )
            row = _current(db, target)
            if not row or row["status"] == "done":
                continue
            if row["status"] in {"queued", "running"}:
                found.append(f"{option.model} (evaluating, {row['progress']}/{row['total']})")
            elif row["status"] == "awaiting_consent":
                found.append(f"{option.model} (waiting for your consent in LLM config)")
    return found


# --- API -----------------------------------------------------------------------------------


class Consent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    accept: bool
    # Required when the price is unknown: the user confirmed a second time.
    confirm_unknown_price: bool = False


class Reevaluate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    configuration_id: str


class Disagree(BaseModel):
    model_config = ConfigDict(extra="forbid")
    capability: str


def public(row: dict | None, target: Target, ratings: Ratings) -> dict:
    found = ratings.source(target.provider, target.model)
    data = {
        "provider": target.provider,
        "model": target.model,
        "configuration_id": target.configuration_id,
        "shared": target.scope == "shared",
        "paid_by_you": target.paid_by_user,
        "levels_source": found[0] if found else None,
        "levels": found[1] if found else None,
        "evaluation": None,
    }
    if row:
        results = json.loads(row["results_json"] or "[]")
        data["evaluation"] = {
            "id": row["id"],
            "status": row["status"],
            "progress": row["progress"],
            "total": row["total"],
            "errors": row["errors"],
            "failure": row["failure"],
            "estimate": json.loads(row["estimate_json"] or "null"),
            "spent_usd": row["spent_usd"],
            "finished_at": row["finished_at"],
            "levels": json.loads(row["levels_json"] or "null"),
            "examples": [item for item in results if not item.get("error")][:5],
        }
    return data


def install_evaluations(
    app: FastAPI,
    store: Storage,
    configurations,
    enabled: dict[str, bool],
    *,
    model_factory: ModelFactory = chat_model,
    router=None,
    worker: bool = True,
    poll_seconds: float = 5.0,
    inventory_seconds: float = 3600.0,
    pace_seconds: float = 2.0,
    quiet_seconds: float = 20.0,
):
    """Routes, the hook for saved configurations and the background worker."""
    app.state.evaluation_configurations = configurations
    app.state.last_user_call = 0.0

    @app.middleware("http")
    async def note_user_calls(request, call_next):
        # Analyses and chat messages use the same provider quota as the evaluations.
        path = request.url.path
        if request.method == "POST" and (path == "/api/analyze" or path.startswith("/api/chats")):
            app.state.last_user_call = time.monotonic()
        return await call_next(request)

    async def wait_turn():
        """Pace the worker and pause it while users are analysing or chatting."""
        await asyncio.sleep(pace_seconds)
        while time.monotonic() - app.state.last_user_call < quiet_seconds:
            await asyncio.sleep(1)

    def own_targets(user_id: str) -> list[Target]:
        return [
            t for t in inventory(store, configurations, enabled) if t.user_id in {None, user_id}
        ]

    async def on_saved(user_id: str, config: dict):
        if config.get("enabled") and config.get("model"):
            await ensure(
                store, Target(config["provider"], config["model"], config["id"], user_id), router
            )

    app.state.on_configuration_saved = on_saved

    async def on_model_used(user_id: str, configuration_id: str, model: str):
        # First use of a model from OpenRouter's picker: evaluate it like a configured one.
        await ensure(store, add_user_model(store, user_id, configuration_id, model), router)

    app.state.on_model_used = on_model_used

    @app.get("/api/evaluations")
    async def list_evaluations(user: AuthenticatedUser):
        ratings = Ratings(store, active_catalogue(), user["id"])
        with store.connect() as db:
            picked = {
                (row["configuration_id"], row["model"])
                for row in db.execute(
                    "SELECT configuration_id,model FROM user_models WHERE user_id=%s",
                    (user["id"],),
                ).fetchall()
            }
        result = []
        seen = set()
        for target in own_targets(user["id"]):
            if (target.provider, target.model) in seen:
                continue
            seen.add((target.provider, target.model))
            row = await ensure(store, target, router)
            entry = public(row, target, ratings)
            # Picked from OpenRouter's catalogue (not the configuration's own model).
            entry["picked"] = (target.configuration_id, target.model) in picked
            result.append(entry)
        return {"suite": SUITE_VERSION, "models": result}

    def owned_target(user_id: str, evaluation_id: str) -> tuple[dict, Target]:
        with store.connect() as db:
            row = db.execute(
                "SELECT * FROM model_evaluations WHERE id=%s", (evaluation_id,)
            ).fetchone()
        if not row:
            raise HTTPException(404, "evaluation_not_found")
        row = dict(row)
        target = next(
            (
                t
                for t in own_targets(user_id)
                if (t.provider, t.model, t.scope) == (row["provider"], row["model"], row["scope"])
            ),
            None,
        )
        if target is None:
            raise HTTPException(404, "evaluation_not_found")
        return row, target

    @app.post("/api/evaluations/{evaluation_id}/consent")
    def consent(evaluation_id: str, body: Consent, user: AuthenticatedUser):
        row, target = owned_target(user["id"], evaluation_id)
        if row["status"] not in {"awaiting_consent", "declined"}:
            raise HTTPException(409, "evaluation_not_waiting")
        estimate_data = json.loads(row["estimate_json"] or "{}")
        if body.accept and not estimate_data.get("price_known") and not body.confirm_unknown_price:
            raise HTTPException(422, "confirm_unknown_price")
        with store.connect() as db:
            db.execute(
                f"UPDATE model_evaluations SET status=%s,configuration_id=%s,requested_by=%s,"
                f"updated_at={NOW} WHERE id=%s AND status IN ('awaiting_consent','declined')",
                (
                    "queued" if body.accept else "declined",
                    target.configuration_id if body.accept else row["configuration_id"],
                    user["id"],
                    evaluation_id,
                ),
            )
        return {"status": "queued" if body.accept else "declined"}

    class AddModel(BaseModel):
        model_config = ConfigDict(extra="forbid")
        configuration_id: str
        model: str = Field(
            min_length=1, max_length=200, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$"
        )

    @app.post("/api/evaluations/models", status_code=201)
    async def add_model(body: AddModel, user: AuthenticatedUser):
        if router is not None:
            try:
                await router.check(body.model, structured=False)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from None
            except Exception:  # noqa: BLE001 - catalogue unreachable: accept, checked on use
                pass
        row = await ensure(
            store, add_user_model(store, user["id"], body.configuration_id, body.model), router
        )
        return {"id": row["id"], "status": row["status"]}

    @app.delete("/api/evaluations/models")
    def remove_model(configuration_id: str, model: str, user: AuthenticatedUser):
        with store.connect() as db:
            db.execute(
                "DELETE FROM user_models WHERE user_id=%s AND configuration_id=%s AND model=%s",
                (user["id"], configuration_id, model),
            )
        return {"status": "removed"}

    @app.post("/api/evaluations/reevaluate")
    async def reevaluate(body: Reevaluate, user: AuthenticatedUser):
        target = next(
            (t for t in own_targets(user["id"]) if t.configuration_id == body.configuration_id),
            None,
        )
        if target is None:
            raise HTTPException(404, "configuration_not_found")
        row = await ensure(store, target, router, force=True)
        return {"id": row["id"], "status": row["status"]}

    @app.post("/api/evaluations/{evaluation_id}/disagree")
    def disagree(evaluation_id: str, body: Disagree, user: AuthenticatedUser):
        if body.capability not in CAPABILITIES:
            raise HTTPException(422, "unknown_capability")
        owned_target(user["id"], evaluation_id)
        with store.connect() as db:
            db.execute(
                "INSERT INTO evaluation_disagreements(evaluation_id,user_id,capability) "
                "VALUES (%s,%s,%s) ON CONFLICT DO NOTHING",
                (evaluation_id, user["id"], body.capability),
            )
        return {"status": "recorded"}

    if worker:

        @app.on_event("startup")
        async def start_worker():
            async def loop():
                recover(store)
                last_inventory = float("-inf")  # the first inventory runs at start-up
                while True:
                    try:
                        if time.monotonic() - last_inventory > inventory_seconds:
                            for target in inventory(store, configurations, enabled):
                                await ensure(store, target, router)
                            last_inventory = time.monotonic()
                        # Layer 3: one model at a time with the project's key, within its
                        # daily calls and budget; users' models come first.
                        if not _has_queued(store):
                            await ensure_project(
                                store,
                                configurations.settings,
                                Ratings(store, active_catalogue()),
                                router,
                            )
                        while await run_next(
                            store, configurations, model_factory, wait_turn=wait_turn
                        ):
                            pass
                    except Exception:  # noqa: BLE001 - the worker must never die
                        LOGGER.exception("Evaluation worker step failed; retrying")
                    await asyncio.sleep(poll_seconds)

            app.state.evaluation_worker = asyncio.create_task(loop())
