import json
import sqlite3
from time import perf_counter
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from langsmith import tracing_context
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.accounts import AuthenticatedUser, check_origin
from app.accounts import router as accounts_router
from app.assessment import POLICY_VERSION, PROFILE_VERSION
from app.models import AnalysisRequest, AnalysisResult, Decision
from app.providers import DemonstrationProvider, LangChainProvider, ProviderFailure, Settings
from app.storage import Storage
from app.workflow import CATALOGUE, build_workflow


class SessionInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    title: str = Field(default="New session", min_length=1, max_length=120)
    context: str = Field(default="", max_length=4000)


def create_app(settings: Settings | None = None, overrides: dict | None = None) -> FastAPI:
    settings = settings or Settings()
    app = FastAPI(title="AdaptAI", version="0.1.0", dependencies=[Depends(check_origin)])
    store = Storage(settings.database_path)
    app.state.storage = store
    app.state.settings = settings
    app.include_router(accounts_router)

    @app.middleware("http")
    async def private_responses(request: Request, call_next):
        response = await call_next(request)
        if request.url.path.startswith(
            ("/api/auth", "/api/sessions", "/api/analyze", "/api/decisions")
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
                    "SELECT * FROM sessions WHERE user_id=? ORDER BY created_at DESC, rowid DESC "
                    "LIMIT ? OFFSET ?",
                    (user["id"], limit, offset),
                )
            ]

    def owned_session(user: dict, identifier: str):
        session = store.session(user["id"], identifier)
        if not session:
            raise HTTPException(404, "session_not_found")
        return session

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
                "UPDATE sessions SET title=?,context=? WHERE id=? AND user_id=?",
                (body.title, body.context, identifier, user["id"]),
            )
        return owned_session(user, identifier)

    @app.delete("/api/sessions/{identifier}")
    def delete_session(identifier: str, user: AuthenticatedUser):
        owned_session(user, identifier)
        with store.connect() as db:
            db.execute("DELETE FROM sessions WHERE id=? AND user_id=?", (identifier, user["id"]))
        return {"status": "deleted"}

    @app.post("/api/analyze", response_model=AnalysisResult)
    async def analyse(body: AnalysisRequest, user: AuthenticatedUser):
        session = owned_session(user, body.session_id) if body.session_id else None
        if not enabled.get(body.provider):
            raise HTTPException(409, "provider_not_configured")
        if body.provider in external_providers and not body.allow_external:
            raise HTTPException(403, "external_processing_requires_consent")
        provider = providers.get(body.provider) or LangChainProvider(body.provider, settings)
        started = perf_counter()
        assessment_request = body
        if session and session["context"]:
            assessment_request = body.model_copy(
                update={"task": f"Session context:\n{session['context']}\n\nTask:\n{body.task}"}
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
        if session is None:
            session = store.create_session(user["id"], body.task[:120], "")
        result = AnalysisResult.model_validate(
            {
                "id": identifier,
                "session_id": session["id"],
                "mode": "demonstration" if body.provider == "demo" else "semantic",
                "provider": body.provider,
                "assessment_model": models[body.provider],
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
                if body.provider == "demo"
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
                        json.dumps({**body.model_dump(), "session_context": session["context"]}),
                        result.model_dump_json(),
                    ),
                )
        except sqlite3.IntegrityError:
            # The owner may have deleted the session while the provider was running.
            raise HTTPException(404, "session_not_found") from None
        return result

    @app.post("/api/decisions")
    def decide(body: Decision, user: AuthenticatedUser):
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
        return {
            "status": "acknowledged",
            "candidate_id": body.candidate_id,
            "persistence": "database",
        }

    return app


app = create_app()
