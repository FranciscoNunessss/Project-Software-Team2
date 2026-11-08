"""End-to-end test server: the real application with deterministic fake models.

Started by e2e/playwright.config.ts. It uses a temporary database and never calls a real
provider. The frontend sends ``provider: "auto"``, which resolves to the project Groq model,
so a fake Groq key is configured and the "groq" provider is replaced by ``FakeAssessor``.
``FakeCoach`` replaces the Prompt Coach model through ``prompt_coach_options`` (B1), so the
core needs no test hooks.

Each test user switches the Prompt Coach on or off in Profile (on by default).
"""

import atexit
import os
import sys
import tempfile
from pathlib import Path
from uuid import uuid4

import psycopg
from psycopg import sql

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

DATA = Path(tempfile.mkdtemp(prefix="adaptai-e2e-"))
DATABASE_URL = os.environ.get("ADAPTAI_TEST_DATABASE_URL", "postgresql://adaptai:adaptai@127.0.0.1:55432/adaptai")
SCHEMA = "e2e_" + uuid4().hex
os.environ["ADAPTAI_DATABASE_URL"] = DATABASE_URL
os.environ["ADAPTAI_DATABASE_SCHEMA"] = SCHEMA
os.environ.pop("ADAPTAI_CREDENTIALS_KEY", None)


def cleanup():
    with psycopg.connect(DATABASE_URL, autocommit=True) as db:
        db.execute(sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(sql.Identifier(SCHEMA)))


atexit.register(cleanup)
os.environ["ADAPTAI_CREDENTIALS_KEY_PATH"] = str(DATA / "e2e.key")

import uvicorn  # noqa: E402
from app.main import create_app  # noqa: E402
from app.models import Assessment, Profile  # noqa: E402
from app.openrouter import OpenRouterCatalogue  # noqa: E402
from app.providers import Settings  # noqa: E402

# A task is "complete" once it states its audience and what an error would cost; the fake
# assessor then reports those dimensions as determined, so re-analysis shows real changes.
COMPLETE_WORDS = ("board", "risk")


def dimension(score, confidence, evidence):
    return {"score": score, "confidence": confidence, "evidence": evidence}


VAGUE = {
    "reasoning": dimension(2, "low", "Asks for a summary but not what it must decide."),
    "context": dimension(None, "undetermined", "The source material is not described."),
    "ambiguity": dimension(3, "medium", "Audience, length and purpose are missing."),
    "domain": dimension(1, "medium", "General business writing."),
    "risk": dimension(None, "undetermined", "Consequences of an error are not stated."),
    "tools": dimension(1, "medium", "No external data or tools are mentioned."),
    "modality": {"required": ["text"], "confidence": "medium", "evidence": "Text in, text out."},
    "explanation": "A short request with the audience, sources and stakes left open.",
}
COMPLETE = {
    "reasoning": dimension(2, "high", "Compare options against stated criteria."),
    "context": dimension(2, "high", "Two related reports must be read together."),
    "ambiguity": dimension(1, "high", "Audience, length and decision are explicit."),
    "domain": dimension(2, "medium", "Common finance terminology."),
    "risk": dimension(2, "high", "An error means rework before the board meeting."),
    "tools": dimension(1, "high", "No tools needed; sources are attached."),
    "modality": {"required": ["text"], "confidence": "high", "evidence": "Text in, text out."},
    "explanation": "Clear goal, audience and sources; moderate reasoning across two reports.",
}


class FakeAssessor:
    async def assess(self, task):
        complete = all(word in task.lower() for word in COMPLETE_WORDS)
        return Assessment(profile=Profile.model_validate(COMPLETE if complete else VAGUE))


def suggestion(dimension_name, kind, title, rationale, quote=None, replacement=None, effect=None):
    return {
        "dimension": dimension_name,
        "kind": kind,
        "title": title,
        "rationale": rationale,
        "quote": quote,
        "replacement": replacement,
        "expected_effect": effect or "determine_dimension",
    }


class FakeCoach:
    """Deterministic Prompt Coach model: one grounded edit, questions and a rewrite."""

    def __init__(self, provider, settings, model):
        pass

    async def __call__(self, schema, system, human):
        return {
            "suggestions": [
                suggestion(
                    "ambiguity",
                    "edit",
                    "Name the audience",
                    "The audience decides length and tone.",
                    quote="summary of the report",
                    replacement="one-page summary of the report for the board",
                    effect="lower_ambiguity",
                ),
                suggestion(
                    "risk",
                    "question",
                    "Say what happens if it is wrong",
                    "Stakes change how carefully the result must be checked.",
                ),
                suggestion(
                    "context",
                    "question",
                    "Name the source material",
                    "The model cannot know which material to read together.",
                ),
            ],
            "rewrite": (
                "Write a one-page summary of the report for the board. "
                "[Which sources must it use?] [What happens if it is wrong?]"
            ),
            "open_questions": [],
        }, {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}


class FakeChat:
    """Fixed answer model for the optional chat (ADR-011): echoes the last question."""

    def __init__(self, provider, settings, model):
        self.provider = provider
        self.model = settings.openrouter_model if provider == "openrouter" else model

    async def stream(self, messages):
        question = messages[-1][1]
        if "limited" in str(self.model):
            # A free model at its daily limit (ADR-014 A11): OpenRouter answers HTTP 429.
            error = RuntimeError("Rate limit exceeded: free-models-per-day")
            error.status_code = 429
            raise error
        if "markdown" in question.lower():
            # Markdown as real models write it, plus raw HTML that must not be rendered.
            for part in (
                "## Steps\n\n1. **Sort** the list\n2. Use `bisect`\n\n",
                "| n | cost |\n|---|---|\n| 8 | 3 |\n\n",
                "```python\nprint('hi')\n```\n\n",
                '<img src="x" onerror="window.__xss = 1">',
            ):
                yield part
            return
        for part in ("Fake answer: ", question):
            yield part


def router_entry(identifier, name, prompt, completion, **extra):
    base = {
        "id": identifier,
        "name": name,
        "description": "Synthetic OpenRouter catalogue entry for the e2e tests.",
        "context_length": 128000,
        "pricing": {"prompt": prompt, "completion": completion},
        "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]},
        "supported_parameters": ["response_format", "structured_outputs"],
    }
    return base | extra


# A synthetic OpenRouter catalogue: no call to openrouter.ai is ever made.
ROUTER_MODELS = [
    router_entry("acme/swift:free", "Swift", "0", "0"),
    router_entry("acme/gratis", "Gratis (no suffix)", "0", "0"),
    router_entry("acme/limited:free", "Limited", "0", "0"),
    # In the public LMArena snapshot (ADR-014 A10): rated before any evaluation.
    router_entry("anthropic/claude-opus-5.5", "Claude Opus 5.5", "0.000005", "0.000025"),
    router_entry("vendor/deluxe", "Deluxe", "0.0000025", "0.00001"),
    # Paid, in no public source; evaluated by e2e/coverage.spec.ts only (results are shared).
    router_entry("vendor/premium", "Premium", "0.000003", "0.000012"),
    router_entry(
        "vendor/embedder",
        "Embedder",
        "0.0000001",
        "0",
        architecture={"input_modalities": ["text"], "output_modalities": ["embeddings"]},
    ),
]


class FakeEvaluated:
    """Answers the evaluation suite (ADR-014) for personal models only. The project's Groq
    model always fails, so the shared server model stays unevaluated and the other tests
    keep their illustrative recommendation."""

    def __init__(self, provider, settings, max_tokens):
        self.provider = provider
        self.model = settings.openrouter_model if provider == "openrouter" else ""

    async def ainvoke(self, messages):
        if self.provider == "groq":
            raise ValueError("e2e: the project model is not evaluated")
        if "limited" in self.model:
            # OpenRouter refuses (no credit / daily limit): the run stops after 5 calls.
            error = RuntimeError("Insufficient credits")
            error.status_code = 402
            raise error
        return type("Reply", (), {"content": "I don't know.", "usage_metadata": None})()


async def fetch_router_models():
    return ROUTER_MODELS


def build():
    settings = Settings(
        _env_file=None,
        groq_api_key="e2e-fake-key",
        browser_origin="http://127.0.0.1:8443",
    )
    return create_app(
        settings,
        overrides={"groq": FakeAssessor(), "openrouter": FakeAssessor()},
        prompt_coach_options={"model_factory": FakeCoach},
        chat_options={"model_factory": FakeChat},
        openrouter_catalogue=OpenRouterCatalogue(fetch_router_models),
        evaluation_options={
            "worker": True,
            "model_factory": FakeEvaluated,
            "poll_seconds": 0.5,
            "inventory_seconds": float("inf"),
            "pace_seconds": 0,
            "quiet_seconds": 0,
        },
    )


if __name__ == "__main__":
    uvicorn.run(build(), host="127.0.0.1", port=int(os.environ.get("E2E_API_PORT", "8000")))
