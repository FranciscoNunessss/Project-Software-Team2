"""Explicit, cached coaching from derived usage metadata only."""

import asyncio
import hashlib
import json

from fastapi import BackgroundTasks, HTTPException
from langchain_core.exceptions import OutputParserException
from langsmith import tracing_context
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.accounts import AuthenticatedUser
from app.providers import ProviderFailure


class Suggestion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=100)
    explanation: str = Field(min_length=1, max_length=600)
    action: str = Field(min_length=1, max_length=400)


class CoachingReport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    summary: str = Field(min_length=1, max_length=1000)
    suggestions: list[Suggestion] = Field(min_length=1, max_length=3)


class CoachingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    allow_external: bool = False
    expected_model: str = Field(min_length=1, max_length=200)


def snapshot(store, user_id):
    with store.connect() as db:
        rows = db.execute(
            """SELECT a.id,a.result_json,d.candidate_id FROM analyses a
               JOIN sessions s ON s.id=a.session_id
               LEFT JOIN decisions d ON d.analysis_id=a.id WHERE s.user_id=?
               ORDER BY a.created_at DESC,a.rowid DESC LIMIT 50""",
            (user_id,),
        ).fetchall()
    records = []
    for row in rows:
        result = json.loads(row["result_json"])
        recommended = result["recommendation"]
        chosen = next(
            (
                item
                for item in [recommended, *result["alternatives"]]
                if item["id"] == row["candidate_id"]
            ),
            None,
        )
        records.append(
            {
                "id": row["id"],
                "mode": result["mode"],
                "profile": {
                    key: {
                        field: value[field]
                        for field in ("score", "required", "confidence")
                        if field in value
                    }
                    for key, value in result["profile"].items()
                    if isinstance(value, dict)
                },
                "recommended_capacity": recommended["capacity"],
                "chosen_capacity": chosen["capacity"] if chosen else None,
            }
        )
    # Identifiers participate in freshness detection but are not sent to the LLM.
    fingerprint = hashlib.sha256(json.dumps(records, sort_keys=True).encode()).hexdigest()
    metadata = [{key: value for key, value in record.items() if key != "id"} for record in records]
    return fingerprint, {"sample_size": len(metadata), "sample_limit": 50, "assessments": metadata}


class GroqCoach:
    def __init__(self, settings):
        self.settings = settings

    async def generate(self, metadata):
        from langchain_openai import ChatOpenAI
        from openai import APITimeoutError

        try:
            model = ChatOpenAI(
                model=self.settings.groq_model,
                api_key=self.settings.groq_api_key.get_secret_value(),
                base_url="https://api.groq.com/openai/v1",
                max_retries=0,
                timeout=self.settings.timeout_seconds,
                max_tokens=1600,
            )
            prompt = [
                (
                    "system",
                    "You are AdaptAI's learning coach. Use ONLY supplied derived usage "
                    "metadata to produce 1-3 specific learning suggestions. "
                    "Do not invent user tasks, personal traits, prices, model IDs "
                    "or quality/savings claims. Tiers 1/2/3 are an "
                    "illustrative catalogue, not real-world performance. Matching a recommendation "
                    "measures agreement, not correctness. "
                    "Pending choices are not matches or overrides. "
                    "Demo assessments are heuristic and unknown dimensions stay unknown. Prompt "
                    "inflation cannot be assessed because task text is not available. Explain data "
                    "limitations briefly. Suggest concrete next actions grounded in counts, "
                    "dimensions and choice patterns; never execute tasks. Respond in English.",
                ),
                ("human", json.dumps(metadata)),
            ]
            with tracing_context(enabled=False):
                output = await asyncio.wait_for(
                    model.with_structured_output(
                        CoachingReport, method="json_schema", strict=True, include_raw=True
                    ).ainvoke(prompt),
                    timeout=self.settings.timeout_seconds,
                )
            if output.get("parsing_error") or output.get("parsed") is None:
                raise ProviderFailure("invalid_provider_output")
            return CoachingReport.model_validate(output["parsed"])
        except ProviderFailure:
            raise
        except (TimeoutError, APITimeoutError):
            raise ProviderFailure("provider_timeout") from None
        except (ValidationError, OutputParserException, json.JSONDecodeError):
            raise ProviderFailure("invalid_provider_output") from None
        except Exception as exc:
            code = {
                401: "provider_authentication",
                403: "provider_authentication",
                429: "provider_rate_limit",
                404: "provider_model_unavailable",
                400: "provider_unsupported_request",
            }.get(getattr(exc, "status_code", None), "provider_unavailable")
            raise ProviderFailure(code) from None


def install_coaching(app, store, settings):
    locks = {}
    jobs = {}
    attempts = {}

    def automatic_enabled(user_id):
        with store.connect() as db:
            row = db.execute(
                "SELECT coaching_auto_enabled FROM user_context WHERE user_id=?", (user_id,)
            ).fetchone()
        return bool(row and row[0])

    def saved_report(user_id):
        fingerprint, _ = snapshot(store, user_id)
        with store.connect() as db:
            row = db.execute(
                "SELECT * FROM coaching_reports WHERE user_id=?", (user_id,)
            ).fetchone()
        return (
            None
            if not row
            else {
                "report": json.loads(row["report_json"]),
                "model": row["model"],
                "updated_at": row["updated_at"],
                "stale": row["fingerprint"] != fingerprint or row["model"] != settings.groq_model,
            }
        )

    async def generate_report(user_id, automatic=False):
        # Manual requests and background updates share the same per-account lock.
        async with locks.setdefault(user_id, asyncio.Lock()):
            return await generate_locked(user_id, automatic)

    async def generate_locked(user_id, automatic):
        if automatic and not automatic_enabled(user_id):
            return None
        fingerprint, metadata = snapshot(store, user_id)
        if not metadata["sample_size"]:
            raise HTTPException(409, "no_history_for_coaching")
        current = saved_report(user_id)
        if current and not current["stale"]:
            return current
        try:
            report = await GroqCoach(settings).generate(metadata)
        except ProviderFailure as exc:
            raise HTTPException(502, exc.code) from None
        with store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            # A deletion while the model was running must not recreate deleted history.
            actual_fingerprint, _ = snapshot(store, user_id)
            if actual_fingerprint != fingerprint:
                raise HTTPException(409, "history_changed")
            if automatic and not automatic_enabled(user_id):
                return None
            db.execute(
                """INSERT INTO coaching_reports(user_id,fingerprint,model,report_json)
                   VALUES (?,?,?,?)
                   ON CONFLICT(user_id) DO UPDATE SET fingerprint=excluded.fingerprint,
                   model=excluded.model,report_json=excluded.report_json,
                   updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')""",
                (user_id, fingerprint, settings.groq_model, report.model_dump_json()),
            )
        return saved_report(user_id)

    async def update_automatically(user_id):
        try:
            # Coalesce changes made during an in-flight call, without concurrent calls.
            for _ in range(3):
                before, _ = snapshot(store, user_id)
                attempts[user_id] = (before, settings.groq_model)
                try:
                    await generate_report(user_id, automatic=True)
                except HTTPException as exc:
                    if exc.detail != "history_changed":
                        raise
                after, _ = snapshot(store, user_id)
                if before == after or not automatic_enabled(user_id):
                    break
        except HTTPException as exc:
            jobs[user_id] = {"generating": False, "error": exc.detail}
        except Exception:
            jobs[user_id] = {"generating": False, "error": "provider_unavailable"}
        finally:
            jobs.setdefault(user_id, {})["generating"] = False

    def schedule_auto(background, user_id):
        if (
            not automatic_enabled(user_id)
            or jobs.get(user_id, {}).get("generating")
            or not settings.groq_model
            or not settings.groq_api_key.get_secret_value()
        ):
            return
        fingerprint, metadata = snapshot(store, user_id)
        if not metadata["sample_size"]:
            return
        current = saved_report(user_id)
        if current and not current["stale"]:
            return
        # A failed fingerprint is retried manually or after new history, not on every poll.
        if attempts.get(user_id) == (fingerprint, settings.groq_model):
            return
        attempts[user_id] = (fingerprint, settings.groq_model)
        jobs[user_id] = {"generating": True, "error": None}
        background.add_task(update_automatically, user_id)

    @app.get("/api/progress/coaching")
    def get_coaching(user: AuthenticatedUser, background: BackgroundTasks):
        schedule_auto(background, user["id"])
        return {
            "configured": bool(settings.groq_model and settings.groq_api_key.get_secret_value()),
            "model": settings.groq_model,
            "automatic_enabled": automatic_enabled(user["id"]),
            "saved": saved_report(user["id"]),
            **jobs.get(user["id"], {"generating": False, "error": None}),
        }

    @app.post("/api/progress/coaching")
    async def generate(body: CoachingRequest, user: AuthenticatedUser):
        if not body.allow_external:
            raise HTTPException(403, "external_processing_requires_consent")
        if not settings.groq_model or not settings.groq_api_key.get_secret_value():
            raise HTTPException(409, "project_default_not_configured")
        if body.expected_model != settings.groq_model:
            raise HTTPException(409, "model_configuration_changed")
        result = await generate_report(user["id"])
        jobs[user["id"]] = {"generating": False, "error": None}
        return result

    return schedule_auto
