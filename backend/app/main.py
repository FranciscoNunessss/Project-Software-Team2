import json
import sqlite3
from time import perf_counter
from uuid import uuid4

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from langsmith import tracing_context
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.accounts import AuthenticatedUser, check_origin
from app.accounts import router as accounts_router
from app.assessment import POLICY_VERSION, PROFILE_VERSION
from app.coaching import install_coaching
from app.llm_config import ModelConfigurations, install_routes
from app.models import AnalysisRequest, AnalysisResult, Decision
from app.providers import DemonstrationProvider, LangChainProvider, ProviderFailure, Settings
from app.storage import Storage, history_result
from app.workflow import CATALOGUE, build_workflow


class SessionInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    title: str = Field(default="New session", min_length=1, max_length=120)
    context: str = Field(default="", max_length=4000)


class PersonalContext(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    content: str | None = Field(default=None, max_length=4000)
    save_enabled: bool | None = None
    use_enabled: bool | None = None
    coaching_auto_enabled: bool | None = None


def create_app(settings: Settings | None = None, overrides: dict | None = None) -> FastAPI:
    settings = settings or Settings()
    app = FastAPI(title="AdaptAI", version="0.1.0", dependencies=[Depends(check_origin)])
    store = Storage(settings.database_path)
    app.state.storage = store
    app.state.settings = settings
    app.include_router(accounts_router)
    schedule_coaching = install_coaching(app, store, settings)

    @app.middleware("http")
    async def private_responses(request: Request, call_next):
        response = await call_next(request)
        if request.url.path.startswith(
            (
                "/api/auth",
                "/api/sessions",
                "/api/analyze",
                "/api/decisions",
                "/api/progress",
                "/api/context",
                "/api/llm-",
            )
        ):
            response.headers["Cache-Control"] = "no-store"
        return response

    providers = {"demo": DemonstrationProvider(), **(overrides or {})}
    enabled = {
        "demo": True,
        "openai": bool(settings.openai_model and settings.openai_api_key.get_secret_value()),
        "claude": bool(settings.claude_model and settings.anthropic_api_key.get_secret_value()),
        "groq": bool(settings.groq_model and settings.groq_api_key.get_secret_value()),
        "ollama": bool(settings.ollama_model),
    }
    enabled.update({key: True for key in (overrides or {})})
    configurations = ModelConfigurations(store, settings)
    install_routes(app, configurations, enabled)
    labels = {
        "demo": "Demonstration · local heuristic",
        "openai": "OpenAI",
        "claude": "Claude · Anthropic",
        "groq": "Groq",
        "ollama": "Ollama · local",
    }
    models = {
        "demo": None,
        "openai": settings.openai_model,
        "claude": settings.claude_model,
        "groq": settings.groq_model,
        "ollama": settings.ollama_model,
    }
    external_providers = {"openai", "claude", "groq"}

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, _exc: RequestValidationError):
        return JSONResponse(status_code=422, content={"detail": "Invalid request fields"})

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    @app.get("/api/providers")
    def list_providers():
        return [
            {
                "id": key,
                "label": labels[key],
                "model": models[key],
                "enabled": value,
                "external": key in external_providers,
            }
            for key, value in enabled.items()
        ]

    @app.get("/api/catalogue")
    def catalogue():
        return CATALOGUE

    @app.post("/api/sessions", status_code=201)
    def create_session(body: SessionInput, user: AuthenticatedUser):
        return store.create_session(user["id"], body.title, body.context)

    @app.get("/api/sessions")
    def list_sessions(
        user: AuthenticatedUser,
        limit: int = Query(default=100, ge=1, le=100),
        offset: int = Query(default=0, ge=0),
    ):
        with store.connect() as db:
            return [
                dict(row)
                for row in db.execute(
                    "SELECT s.*,count(a.id) AS analysis_count,count(d.analysis_id) AS choice_count "
                    "FROM sessions s LEFT JOIN analyses a ON a.session_id=s.id "
                    "LEFT JOIN decisions d ON d.analysis_id=a.id WHERE s.user_id=? "
                    "GROUP BY s.id ORDER BY s.created_at DESC,s.rowid DESC LIMIT ? OFFSET ?",
                    (user["id"], limit, offset),
                )
            ]

    def owned_session(user: dict, identifier: str):
        session = store.session(user["id"], identifier)
        if not session:
            raise HTTPException(404, "session_not_found")
        return session

    @app.get("/api/progress")
    def progress(user: AuthenticatedUser):
        with store.connect() as db:
            counts = db.execute(
                """SELECT count(a.id) AS analyses, count(d.analysis_id) AS choices,
                   coalesce(sum(CASE WHEN d.candidate_id =
                       json_extract(a.result_json, '$.recommendation.id') THEN 1 ELSE 0 END), 0)
                       AS matches
                   FROM sessions s LEFT JOIN analyses a ON a.session_id=s.id
                   LEFT JOIN decisions d ON d.analysis_id=a.id WHERE s.user_id=?""",
                (user["id"],),
            ).fetchone()
            sessions = db.execute(
                "SELECT count(*) FROM sessions WHERE user_id=?", (user["id"],)
            ).fetchone()[0]
        return {"sessions": sessions, **dict(counts)}

    @app.get("/api/progress/pending")
    def pending_choices(
        user: AuthenticatedUser,
        limit: int = Query(default=20, ge=1, le=100),
        offset: int = Query(default=0, ge=0),
    ):
        with store.connect() as db:
            rows = db.execute(
                """SELECT a.result_json,a.created_at,s.title FROM analyses a
                   JOIN sessions s ON s.id=a.session_id
                   LEFT JOIN decisions d ON d.analysis_id=a.id
                   WHERE s.user_id=? AND d.analysis_id IS NULL
                   ORDER BY a.created_at DESC,a.rowid DESC LIMIT ? OFFSET ?""",
                (user["id"], limit, offset),
            )
            return [
                {
                    "request": {},
                    "result": json.loads(row["result_json"]),
                    "candidate_id": None,
                    "created_at": row["created_at"],
                    "session_title": row["title"],
                }
                for row in rows
            ]

    @app.get("/api/progress/activity")
    def activity(user: AuthenticatedUser):
        with store.connect() as db:
            rows = db.execute(
                """SELECT s.id AS session_id,s.title,s.created_at,count(a.id) AS analyses,
                   count(d.analysis_id) AS choices FROM sessions s
                   JOIN analyses a ON a.session_id=s.id
                   LEFT JOIN decisions d ON d.analysis_id=a.id WHERE s.user_id=?
                   GROUP BY s.id ORDER BY s.created_at DESC,s.rowid DESC LIMIT 6""",
                (user["id"],),
            ).fetchall()
        return list(reversed([dict(row) for row in rows]))

    @app.delete("/api/progress/history")
    def clear_history(user: AuthenticatedUser):
        with store.connect() as db:
            db.execute("DELETE FROM sessions WHERE user_id=?", (user["id"],))
            db.execute("DELETE FROM coaching_reports WHERE user_id=?", (user["id"],))
        return {"status": "deleted"}

    def context_for(user_id: str):
        with store.connect() as db:
            row = db.execute(
                "SELECT content,updated_at,save_enabled,use_enabled,coaching_auto_enabled "
                "FROM user_context "
                "WHERE user_id=?",
                (user_id,),
            ).fetchone()
            entries = [
                json.loads(item[0])
                for item in db.execute(
                    "SELECT metadata_json FROM memory_entries WHERE user_id=? "
                    "ORDER BY rowid DESC LIMIT 20",
                    (user_id,),
                )
            ]
        settings = (
            dict(row)
            if row
            else {
                "content": "",
                "updated_at": None,
                "save_enabled": False,
                "use_enabled": False,
                "coaching_auto_enabled": False,
            }
        )
        return {
            **settings,
            "save_enabled": bool(settings["save_enabled"]),
            "use_enabled": bool(settings["use_enabled"]),
            "coaching_auto_enabled": bool(settings["coaching_auto_enabled"]),
            "memory": entries,
        }

    @app.get("/api/context")
    def personal_context(user: AuthenticatedUser):
        return context_for(user["id"])

    @app.put("/api/context")
    def save_context(body: PersonalContext, user: AuthenticatedUser, background: BackgroundTasks):
        current = context_for(user["id"])
        changes = body.model_dump(exclude_none=True)
        values = {**current, **changes}
        with store.connect() as db:
            db.execute(
                """INSERT INTO user_context
                   (user_id,content,save_enabled,use_enabled,coaching_auto_enabled)
                   VALUES (?,?,?,?,?)
                   ON CONFLICT(user_id) DO UPDATE SET content=excluded.content,
                   save_enabled=excluded.save_enabled,use_enabled=excluded.use_enabled,
                   coaching_auto_enabled=excluded.coaching_auto_enabled,
                   updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')""",
                (
                    user["id"],
                    values["content"],
                    values["save_enabled"],
                    values["use_enabled"],
                    values["coaching_auto_enabled"],
                ),
            )
        if body.coaching_auto_enabled:
            schedule_coaching(background, user["id"])
        return context_for(user["id"])

    @app.delete("/api/context/memory")
    def clear_memory(user: AuthenticatedUser):
        with store.connect() as db:
            db.execute("DELETE FROM memory_entries WHERE user_id=?", (user["id"],))
        return context_for(user["id"])

    @app.get("/api/progress/dashboard")
    def dashboard(user: AuthenticatedUser):
        over = under = 0
        with store.connect() as db:
            rows = db.execute(
                """SELECT a.result_json, s.id, s.title, s.created_at, d.candidate_id
                   FROM sessions s JOIN analyses a ON a.session_id=s.id
                   JOIN decisions d ON d.analysis_id=a.id WHERE s.user_id=?
                   ORDER BY s.created_at, s.rowid, a.created_at, a.rowid""",
                (user["id"],),
            )
            points = {}
            for row in rows:
                result = json.loads(row["result_json"])
                recommended = result["recommendation"]
                chosen = next(
                    item
                    for item in [recommended, *result["alternatives"]]
                    if item["id"] == row["candidate_id"]
                )
                over += chosen["capacity"] > recommended["capacity"]
                under += chosen["capacity"] < recommended["capacity"]
                point = points.setdefault(
                    row["id"],
                    {
                        "session_id": row["id"],
                        "title": row["title"],
                        "created_at": row["created_at"],
                        "choices": 0,
                        "matches": 0,
                    },
                )
                point["choices"] += 1
                point["matches"] += row["candidate_id"] == recommended["id"]
        return {
            "over": over,
            "under": under,
            "series": [
                {**point, "rate": round(point["matches"] / point["choices"] * 100, 1)}
                for point in list(points.values())[-6:]
            ],
        }

    @app.get("/api/sessions/{identifier}")
    def session_detail(
        identifier: str,
        user: AuthenticatedUser,
        limit: int = Query(default=100, ge=1, le=100),
        offset: int = Query(default=0, ge=0),
    ):
        session = owned_session(user, identifier)
        return {**session, "analyses": store.history(user["id"], identifier, limit, offset)}

    @app.patch("/api/sessions/{identifier}")
    def update_session(identifier: str, body: SessionInput, user: AuthenticatedUser):
        owned_session(user, identifier)
        with store.connect() as db:
            db.execute(
                "UPDATE sessions SET context='' WHERE id=? AND user_id=?",
                (identifier, user["id"]),
            )
        return owned_session(user, identifier)

    @app.delete("/api/sessions/{identifier}")
    def delete_session(identifier: str, user: AuthenticatedUser):
        owned_session(user, identifier)
        with store.connect() as db:
            db.execute("DELETE FROM sessions WHERE id=? AND user_id=?", (identifier, user["id"]))
            db.execute("DELETE FROM coaching_reports WHERE user_id=?", (user["id"],))
        return {"status": "deleted"}

    @app.post("/api/analyze", response_model=AnalysisResult)
    async def analyse(body: AnalysisRequest, user: AuthenticatedUser, background: BackgroundTasks):
        session = (
            owned_session(user, body.session_id)
            if body.session_id
            else store.create_session(user["id"], body.task[:120], "")
        )
        created_session = body.session_id is None
        try:
            return await run_analysis(body, user, background, session)
        except BaseException:
            if created_session:
                with store.connect() as db:
                    db.execute(
                        "DELETE FROM sessions WHERE id=? AND user_id=? AND NOT EXISTS "
                        "(SELECT 1 FROM analyses WHERE session_id=sessions.id)",
                        (session["id"], user["id"]),
                    )
            raise

    async def run_analysis(
        body: AnalysisRequest,
        user: AuthenticatedUser,
        background: BackgroundTasks,
        session: dict[str, object],
    ):
        actual_provider, actual_settings, actual_model, configuration_id = configurations.resolve(
            user["id"], body, enabled
        )
        if (
            (body.expected_configuration_id and body.expected_configuration_id != configuration_id)
            or (body.expected_provider and body.expected_provider != actual_provider)
            or (body.expected_model and body.expected_model != actual_model)
        ):
            raise HTTPException(409, "model_configuration_changed")
        if configuration_id.startswith("server:") and not enabled.get(actual_provider):
            raise HTTPException(409, "provider_not_configured")
        if actual_provider in external_providers and not body.allow_external:
            raise HTTPException(403, "external_processing_requires_consent")
        provider = providers.get(actual_provider) or LangChainProvider(
            actual_provider, actual_settings
        )
        started = perf_counter()
        assessment_request = body.model_copy(update={"provider": actual_provider})
        preferences = context_for(user["id"])
        use_memory = preferences["use_enabled"] and body.use_personal_context is not False
        personal = preferences["content"] if use_memory else ""
        parts = []
        if personal:
            parts.append(f"Personal context:\n{personal}")
        if use_memory and preferences["memory"]:
            parts.append(
                "Usage metadata (previous assessments, not task requirements):\n"
                + json.dumps(preferences["memory"])
            )
        if body.task_context:
            parts.append(f"Task context:\n{body.task_context}")
        if parts:
            assessment_request = assessment_request.model_copy(
                update={"task": "\n\n".join([*parts, f"Task:\n{body.task}"])}
            )
        try:
            with tracing_context(enabled=False):
                state = await build_workflow(provider).ainvoke({"request": assessment_request})
        except ProviderFailure as exc:
            raise HTTPException(502, exc.code) from None
        except ValidationError:
            raise HTTPException(502, "invalid_provider_output") from None
        candidates = state["candidates"]
        identifier = str(uuid4())
        result = AnalysisResult.model_validate(
            {
                "id": identifier,
                "session_id": session["id"],
                "mode": "demonstration" if actual_provider == "demo" else "semantic",
                "provider": actual_provider,
                "assessment_model": actual_model,
                "configuration_id": configuration_id,
                "selection_mode": "auto"
                if body.provider == "auto" and not body.configuration_id
                else "manual",
                "profile": state["profile"],
                "profile_version": PROFILE_VERSION,
                "recommendation_provisional": state["recommendation_provisional"],
                "clarification_questions": state["clarification_questions"],
                "guidance": state["guidance"],
                "recommendation": candidates[0],
                "alternatives": candidates[1:],
                "rationale": state["rationale"],
                "warnings": [
                    "Illustrative catalogue: these tiers are not verified real models.",
                    "Assessment and ranking policy have not been calibrated or validated.",
                ],
                "catalogue_version": CATALOGUE["version"],
                "policy_version": POLICY_VERSION,
                "latency_ms": round((perf_counter() - started) * 1000),
                "confidence_basis": "Uncalibrated heuristic"
                if actual_provider == "demo"
                else "Uncalibrated model assessment",
                "usage": state.get("usage"),
                "observed_cost": None,
            }
        )
        try:
            with store.connect() as db:
                db.execute(
                    "INSERT INTO analyses(id,session_id,request_json,result_json) VALUES (?,?,?,?)",
                    (
                        identifier,
                        session["id"],
                        "{}",
                        json.dumps(history_result(result.model_dump())),
                    ),
                )
                # Re-read opt-in after the provider call, so disabling during a request wins.
                memory_settings = db.execute(
                    "SELECT save_enabled FROM user_context WHERE user_id=?", (user["id"],)
                ).fetchone()
                if memory_settings and memory_settings[0]:
                    memory = {
                        "analysis_id": identifier,
                        "profile": {
                            key: value.get("score", value.get("required"))
                            for key, value in result.profile.model_dump().items()
                            if isinstance(value, dict)
                        },
                        "recommended_capacity": result.recommendation.capacity,
                        "chosen_capacity": None,
                    }
                    db.execute(
                        "INSERT INTO memory_entries VALUES (?,?,?)",
                        (identifier, user["id"], json.dumps(memory)),
                    )
        except sqlite3.IntegrityError:
            # The owner may have deleted the session while the provider was running.
            raise HTTPException(404, "session_not_found") from None
        schedule_coaching(background, user["id"])
        return result

    @app.post("/api/decisions")
    def decide(body: Decision, user: AuthenticatedUser, background: BackgroundTasks):
        with store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT a.result_json FROM analyses a JOIN sessions s ON s.id=a.session_id "
                "WHERE a.id=? AND s.user_id=?",
                (body.analysis_id, user["id"]),
            ).fetchone()
            if not row:
                raise HTTPException(404, "analysis_not_found")
            result = json.loads(row["result_json"])
            eligible = [result["recommendation"], *result["alternatives"]]
            if body.candidate_id not in [item["id"] for item in eligible]:
                raise HTTPException(422, "candidate_not_eligible")
            previous = db.execute(
                "SELECT candidate_id FROM decisions WHERE analysis_id=?", (body.analysis_id,)
            ).fetchone()
            if previous and previous["candidate_id"] != body.candidate_id:
                raise HTTPException(409, "decision_already_recorded")
            db.execute(
                "INSERT OR IGNORE INTO decisions(analysis_id,candidate_id) VALUES (?,?)",
                (body.analysis_id, body.candidate_id),
            )
            saved_memory = db.execute(
                "SELECT m.metadata_json FROM memory_entries m "
                "JOIN user_context c ON c.user_id=m.user_id "
                "WHERE m.analysis_id=? AND m.user_id=? AND c.save_enabled=1",
                (body.analysis_id, user["id"]),
            ).fetchone()
            if saved_memory:
                metadata = json.loads(saved_memory[0])
                metadata["chosen_capacity"] = next(
                    item["capacity"] for item in eligible if item["id"] == body.candidate_id
                )
                db.execute(
                    "UPDATE memory_entries SET metadata_json=? WHERE analysis_id=?",
                    (json.dumps(metadata), body.analysis_id),
                )
        schedule_coaching(background, user["id"])
        return {
            "status": "acknowledged",
            "candidate_id": body.candidate_id,
            "persistence": "database",
        }

    return app


app = create_app()
