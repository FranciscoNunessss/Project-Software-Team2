from collections import OrderedDict
from time import perf_counter
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from langsmith import tracing_context
from pydantic import ValidationError

from app.models import AnalysisRequest, AnalysisResult, Decision
from app.providers import DemonstrationProvider, LangChainProvider, ProviderFailure, Settings
from app.workflow import CATALOGUE, build_workflow


def create_app(settings: Settings | None = None, overrides: dict | None = None) -> FastAPI:
    settings = settings or Settings()
    app = FastAPI(title="AdaptAI", version="0.1.0")
    providers = {"demo": DemonstrationProvider(), **(overrides or {})}
    enabled = {
        "demo": True,
        "openai": bool(settings.openai_model and settings.openai_api_key.get_secret_value()),
        "ollama": bool(settings.ollama_model),
    }
    enabled.update({key: True for key in (overrides or {})})
    choices: OrderedDict[str, list[str]] = OrderedDict()

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, _exc: RequestValidationError):
        return JSONResponse(status_code=422, content={"detail": "Invalid request fields"})

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    @app.get("/api/providers")
    def list_providers():
        return [
            {"id": key, "enabled": value, "external": key == "openai"}
            for key, value in enabled.items()
        ]

    @app.get("/api/catalogue")
    def catalogue():
        return CATALOGUE

    @app.post("/api/analyze", response_model=AnalysisResult)
    async def analyse(body: AnalysisRequest):
        if not enabled.get(body.provider):
            raise HTTPException(409, "provider_not_configured")
        if body.provider == "openai" and not body.allow_external:
            raise HTTPException(403, "external_processing_requires_consent")
        provider = providers.get(body.provider) or LangChainProvider(body.provider, settings)
        started = perf_counter()
        try:
            with tracing_context(enabled=False):
                state = await build_workflow(provider).ainvoke({"request": body})
        except ProviderFailure as exc:
            raise HTTPException(502, exc.code) from None
        except ValidationError:
            raise HTTPException(502, "invalid_provider_output") from None
        candidates = state["candidates"]
        identifier = str(uuid4())
        choices[identifier] = [item.id for item in candidates]
        if len(choices) > 256:
            choices.popitem(last=False)
        return {
            "id": identifier,
            "mode": "demonstration" if body.provider == "demo" else "semantic",
            "provider": body.provider,
            "profile": state["profile"],
            "recommendation": candidates[0],
            "alternatives": candidates[1:],
            "rationale": state["rationale"],
            "warnings": [
                "Illustrative catalogue: these tiers are not verified real models.",
                "Assessment and ranking policy have not been calibrated or validated.",
            ],
            "catalogue_version": CATALOGUE["version"],
            "policy_version": "prototype-1",
            "latency_ms": round((perf_counter() - started) * 1000),
            "confidence_basis": "Uncalibrated heuristic"
            if body.provider == "demo"
            else "Uncalibrated model assessment",
            "usage": state.get("usage"),
            "observed_cost": None,
        }

    @app.post("/api/decisions")
    async def decide(body: Decision):
        if body.analysis_id not in choices:
            raise HTTPException(404, "analysis_expired_or_unknown")
        if body.candidate_id not in choices[body.analysis_id]:
            raise HTTPException(422, "candidate_not_eligible")
        choices.pop(body.analysis_id)
        return {"status": "acknowledged", "candidate_id": body.candidate_id, "persistence": "none"}

    return app


app = create_app()
