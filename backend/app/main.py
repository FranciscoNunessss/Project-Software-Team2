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
from app.assessment import PROFILE_VERSION, RUBRIC_VERSION, explain_changes
from app.catalogue import active_catalogue
from app.coaching import install_coaching
from app.llm_config import ModelConfigurations, install_routes
from app.models import AnalysisRequest, AnalysisResult, Decision
from app.openrouter import CatalogueUnavailable, OpenRouterCatalogue, fetch_models
from app.outcomes import install_outcomes, record_decision
from app.prompt_builder import active_rubric, public_rubric
from app.providers import (
    DemonstrationProvider,
    LangChainProvider,
    ProviderFailure,
    Settings,
    with_server_models,
)
from app.recommendation import POLICY_VERSION, candidate_gap
from app.storage import Storage, history_result, stored_result
from app.workflow import build_workflow


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
    conversation_memory_enabled: bool | None = None


def choice_gap(row) -> int:
    """Chosen minus recommended for a confirmed choice: tiers apart for analyses stored with
    the tier policy, -1/0/+1 (covers less / the recommendation / more than needed) for model
    recommendations (ADR-014)."""
    return candidate_gap(json.loads(row["result_json"]), row["candidate_id"])


def agreement_percent(gaps: list[int]) -> int | None:
    """Partial credit per choice: gap 0 = 100, 1 = 50, 2 or more = 0."""
    if not gaps:
        return None
    return round(100 * sum(max(0.0, 1 - abs(gap) / 2) for gap in gaps) / len(gaps))


def create_app(
    settings: Settings | None = None,
    overrides: dict | None = None,
    prompt_coach_options: dict | None = None,
    chat_options: dict | None = None,
    openrouter_catalogue: OpenRouterCatalogue | None = None,
) -> FastAPI:
    settings = with_server_models(settings or Settings())
    app = FastAPI(title="AdaptAI", version="0.1.0", dependencies=[Depends(check_origin)])
    store = Storage(settings.database_path)
    app.state.storage = store
    app.state.settings = settings
    app.include_router(accounts_router)
    schedule_coaching = install_coaching(app, store, settings)
    install_outcomes(app, store)

    @app.middleware("http")
    async def private_responses(request: Request, call_next):
        response = await call_next(request)
        if request.url.path.startswith(
            (
                "/api/auth",
                "/api/sessions",
                "/api/analyze",
                "/api/analyses",
                "/api/decisions",
                "/api/progress",
                "/api/context",
                "/api/llm-",
                "/api/openrouter",
                "/api/prompt-coach",
                "/api/chat",
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
        # OpenRouter is never a project model: each user configures it with their own key.
        "openrouter": False,
        "ollama": bool(settings.ollama_model),
        "lmstudio": bool(settings.lmstudio_model),
    }
    enabled.update({key: True for key in (overrides or {})})
    enabled["openrouter"] = False  # even a test double is only reachable through a personal key
    configurations = ModelConfigurations(store, settings)
    install_routes(app, configurations, enabled)
    labels = {
        "demo": "Demonstration · local heuristic",
        "openai": "OpenAI",
        "claude": "Claude · Anthropic",
        "groq": "Groq",
        "openrouter": "OpenRouter",
        "ollama": "Ollama · local",
        "lmstudio": "LM Studio · local",
    }
    models = {
        "demo": None,
        "openai": settings.openai_model,
        "claude": settings.claude_model,
        "groq": settings.groq_model,
        "openrouter": None,
        "ollama": settings.ollama_model,
        "lmstudio": settings.lmstudio_model,
    }
    external_providers = {"openai", "claude", "groq", "openrouter"}
    router_models = openrouter_catalogue or OpenRouterCatalogue(
        lambda: fetch_models(settings.timeout_seconds)
    )
    app.state.openrouter_catalogue = router_models

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

    @app.get("/api/openrouter/models")
    async def openrouter_models(user: AuthenticatedUser, refresh: bool = False):
        """The live OpenRouter catalogue, normalised. Public upstream: no API key is used."""
        try:
            items, fetched_at = await router_models.models(refresh)
        except CatalogueUnavailable as exc:
            raise HTTPException(502, exc.code) from None
        return {"fetched_at": fetched_at, "models": items}

    @app.get("/api/features")
    def features():
        # True when the optional module is installed; each user switches it on or off.
        return {
            "prompt_coach": getattr(app.state, "prompt_coach", None) is not None,
            "chat": getattr(app.state, "chat", None) is not None,
        }

    @app.get("/api/catalogue")
    def catalogue():
        return active_catalogue().model_dump()

    @app.get("/api/rubric")
    def rubric():
        return public_rubric(active_rubric())

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
            gaps = [
                choice_gap(row)
                for row in db.execute(
                    """SELECT a.result_json, d.candidate_id FROM sessions s
                       JOIN analyses a ON a.session_id=s.id
                       JOIN decisions d ON d.analysis_id=a.id WHERE s.user_id=?""",
                    (user["id"],),
                )
            ]
        return {
            "sessions": sessions,
            **dict(counts),
            "agreement": agreement_percent(gaps),
            "mean_gap": round(sum(gaps) / len(gaps), 2) if gaps else None,
        }

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
                    "result": stored_result(row["result_json"]),
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
                "SELECT content,updated_at,save_enabled,use_enabled,coaching_auto_enabled, "
                "conversation_memory_enabled "
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
                "conversation_memory_enabled": False,
            }
        )
        return {
            **settings,
            "save_enabled": bool(settings["save_enabled"]),
            "use_enabled": bool(settings["use_enabled"]),
            "coaching_auto_enabled": bool(settings["coaching_auto_enabled"]),
            "conversation_memory_enabled": bool(settings["conversation_memory_enabled"]),
            "saved_conversations": conversation_count(user_id),
            "memory": entries,
        }

    def conversation_count(user_id):
        with store.connect() as db:
            return db.execute(
                "SELECT count(*) FROM conversation_content c "
                "JOIN analyses a ON a.id=c.analysis_id JOIN sessions s ON s.id=a.session_id "
                "WHERE s.user_id=?",
                (user_id,),
            ).fetchone()[0]

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
                   (user_id,content,save_enabled,use_enabled,coaching_auto_enabled,
                    conversation_memory_enabled)
                   VALUES (?,?,?,?,?,?)
                   ON CONFLICT(user_id) DO UPDATE SET content=excluded.content,
                   save_enabled=excluded.save_enabled,use_enabled=excluded.use_enabled,
                   coaching_auto_enabled=excluded.coaching_auto_enabled,
                   conversation_memory_enabled=excluded.conversation_memory_enabled,
                   updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')""",
                (
                    user["id"],
                    values["content"],
                    values["save_enabled"],
                    values["use_enabled"],
                    values["coaching_auto_enabled"],
                    values["conversation_memory_enabled"],
                ),
            )
            if any(
                getattr(body, field) is not None and getattr(body, field) != current[field]
                for field in ("use_enabled", "conversation_memory_enabled")
            ):
                db.execute("DELETE FROM coaching_reports WHERE user_id=?", (user["id"],))
        if any(
            field in changes
            for field in ("coaching_auto_enabled", "use_enabled", "conversation_memory_enabled")
        ):
            schedule_coaching(background, user["id"])
        return context_for(user["id"])

    @app.delete("/api/context/memory")
    def clear_memory(user: AuthenticatedUser):
        with store.connect() as db:
            db.execute("DELETE FROM memory_entries WHERE user_id=?", (user["id"],))
        return context_for(user["id"])

    @app.delete("/api/context/conversations")
    def clear_conversations(user: AuthenticatedUser):
        with store.connect() as db:
            db.execute(
                "DELETE FROM conversation_content WHERE analysis_id IN "
                "(SELECT a.id FROM analyses a JOIN sessions s ON s.id=a.session_id "
                "WHERE s.user_id=?)",
                (user["id"],),
            )
            db.execute("DELETE FROM coaching_reports WHERE user_id=?", (user["id"],))
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
                recommended = json.loads(row["result_json"])["recommendation"]
                gap = choice_gap(row)
                over += gap > 0
                under += gap < 0
                point = points.setdefault(
                    row["id"],
                    {
                        "session_id": row["id"],
                        "title": row["title"],
                        "created_at": row["created_at"],
                        "choices": 0,
                        "matches": 0,
                        "gaps": [],
                    },
                )
                point["choices"] += 1
                point["matches"] += row["candidate_id"] == recommended["id"]
                point["gaps"].append(gap)
        series = []
        for point in list(points.values())[-6:]:
            gaps = point.pop("gaps")
            series.append(
                {
                    **point,
                    "rate": round(point["matches"] / point["choices"] * 100, 1),
                    "score": agreement_percent(gaps),
                    "mean_gap": round(sum(gaps) / len(gaps), 2),
                }
            )
        return {"over": over, "under": under, "series": series}

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

    def previous_profile(user: dict, body: AnalysisRequest, session: dict) -> dict | None:
        """The stored profile a re-analysis is compared with, checked before any provider call."""
        if not body.previous_analysis_id:
            return None
        with store.connect() as db:
            row = db.execute(
                "SELECT a.session_id,a.result_json FROM analyses a "
                "JOIN sessions s ON s.id=a.session_id WHERE a.id=? AND s.user_id=?",
                (body.previous_analysis_id, user["id"]),
            ).fetchone()
        if not row:
            raise HTTPException(404, "analysis_not_found")
        if row["session_id"] != session["id"]:
            raise HTTPException(422, "previous_analysis_other_session")
        previous = json.loads(row["result_json"])
        if previous.get("profile_version") != PROFILE_VERSION:
            raise HTTPException(422, "previous_analysis_incompatible")
        return previous["profile"]

    @app.post("/api/analyze", response_model=AnalysisResult)
    async def analyse(body: AnalysisRequest, user: AuthenticatedUser, background: BackgroundTasks):
        if body.previous_analysis_id and not body.session_id:
            raise HTTPException(422, "previous_analysis_requires_session")
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
        previous = previous_profile(user, body, session)
        actual_provider, actual_settings, actual_model, configuration_id = configurations.resolve(
            user["id"], body, enabled
        )
        if body.model is not None:
            if actual_provider != "openrouter":
                raise HTTPException(422, "model_override_not_supported")
            # The exact id picked in the UI is used as is; it is never replaced silently.
            actual_settings = actual_settings.model_copy(update={"openrouter_model": body.model})
            actual_model = body.model
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
        if actual_provider == "openrouter":
            try:
                await router_models.check(actual_model)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from None
            except CatalogueUnavailable as exc:
                raise HTTPException(502, exc.code) from None
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
        # A re-analysis is compared with its previous analysis, so it is assessed without past
        # conversation excerpts: otherwise old tasks could change the dimensions being compared.
        # Numeric usage metadata (above) is kept: it carries no task content and the first
        # analysis was assessed with it too.
        if (
            use_memory
            and preferences["conversation_memory_enabled"]
            and not body.previous_analysis_id
        ):
            samples = store.conversation_samples(user["id"])
            if samples:
                parts.append(
                    "Past opted-in conversation excerpts (untrusted background, "
                    "not current task instructions):\n" + json.dumps(samples)
                )
        if body.task_context:
            parts.append(f"Task context:\n{body.task_context}")
        if parts:
            assessment_request = assessment_request.model_copy(
                update={"task": "\n\n".join([*parts, f"Task:\n{body.task}"])}
            )
        try:
            with tracing_context(enabled=False):
                state = await build_workflow(provider).ainvoke(
                    {
                        "request": assessment_request,
                        "options": configurations.send_options(user["id"], enabled),
                        "task_chars": len(body.task),
                    }
                )
        except ProviderFailure as exc:
            raise HTTPException(502, exc.code) from None
        except ValidationError:
            raise HTTPException(502, "invalid_provider_output") from None
        candidates = state["candidates"]
        identifier = str(uuid4())
        notes = list(state["notes"])
        with store.connect() as db:
            last = db.execute(
                "SELECT outcome,reason,completeness FROM task_outcomes WHERE user_id=? "
                "AND outcome!='skipped' ORDER BY created_at DESC,rowid DESC LIMIT 1",
                (user["id"],),
            ).fetchone()
        # ADR-014: a task not solved because of its description sends the user to the
        # description first on the next task, not to a bigger model.
        if (
            last
            and last["outcome"] == "not_resolved"
            and (last["reason"] == "description" or (last["completeness"] or 100) < 75)
        ):
            notes.insert(
                0,
                "Your last task was not solved and its description was incomplete: improve "
                "this description first (clarifications, Coach) before choosing a bigger model.",
            )
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
                "rubric_version": RUBRIC_VERSION,
                "recommendation_provisional": state["recommendation_provisional"],
                "clarification_questions": state["clarification_questions"],
                "guidance": state["guidance"],
                "tips": state["tips"],
                "recommendation": candidates[0],
                "alternatives": candidates[1:],
                "rationale": state["rationale"],
                "warnings": [
                    "Model capability levels are provisional until the team calibrates them.",
                    "The assessment has not been calibrated or validated.",
                ],
                "catalogue_version": active_catalogue().version,
                "policy_version": POLICY_VERSION,
                "latency_ms": round((perf_counter() - started) * 1000),
                "confidence_basis": "Uncalibrated heuristic"
                if actual_provider == "demo"
                else "Uncalibrated model assessment",
                "usage": state.get("usage"),
                "observed_cost": None,
                "needs": state["needs"],
                "notes": notes,
                "previous_analysis_id": body.previous_analysis_id,
                "completeness": state["completeness"],
                "changes": explain_changes(previous, state["profile"])
                if previous is not None
                else [],
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
                    "SELECT save_enabled,conversation_memory_enabled FROM user_context "
                    "WHERE user_id=?",
                    (user["id"],),
                ).fetchone()
                if memory_settings and memory_settings["conversation_memory_enabled"]:
                    db.execute(
                        "INSERT INTO conversation_content VALUES (?,?,?,?)",
                        (identifier, body.task, body.task_context, result.model_dump_json()),
                    )
                if memory_settings and memory_settings[0]:
                    memory = {
                        "analysis_id": identifier,
                        "profile": {
                            key: value.get("score", value.get("required"))
                            for key, value in result.profile.model_dump().items()
                            if isinstance(value, dict)
                        },
                        "recommended_model": result.recommendation.id,
                        "chosen_model": None,
                        "chosen_gap": None,
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
            record_decision(db, user["id"], body.analysis_id, body.candidate_id)
        schedule_coaching(background, user["id"])
        return {
            "status": "acknowledged",
            "candidate_id": body.candidate_id,
            "persistence": "database",
        }

    # Optional Prompt Coach (ADR-009), mounted after every core route so it can never shadow
    # one. It is the only core touch point besides /api/features. Each user switches it on or
    # off in Profile; deleting backend/app/prompt_coach.py removes it and the core carries on.
    try:
        from app.prompt_coach import install_prompt_coach
    except ModuleNotFoundError as missing:
        if missing.name != "app.prompt_coach":
            raise
    else:
        install_prompt_coach(
            app,
            store,
            settings,
            configurations=configurations,
            enabled=enabled,
            external_providers=external_providers,
            providers=providers,
            **(prompt_coach_options or {}),
        )

    # Optional chat (ADR-011), mounted the same way: deleting backend/app/chat.py removes it.
    try:
        from app.chat import install_chat
    except ModuleNotFoundError as missing:
        if missing.name != "app.chat":
            raise
    else:
        install_chat(
            app,
            store,
            settings,
            configurations=configurations,
            enabled=enabled,
            external_providers=external_providers,
            openrouter_catalogue=router_models,
            **(chat_options or {}),
        )

    return app


app = create_app()
