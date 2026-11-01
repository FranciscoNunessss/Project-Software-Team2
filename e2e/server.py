"""End-to-end test server: the real application with deterministic fake models.

Started by e2e/playwright.config.ts. It uses a temporary database and never calls a real
provider. The frontend sends ``provider: "auto"``, which resolves to the project Groq model,
so a fake Groq key is configured and the "groq" provider is replaced by ``FakeAssessor``.
``FakeCoach`` replaces the Prompt Coach model through ``prompt_coach_options`` (B1), so the
core needs no test hooks.

Environment: E2E_PROMPT_COACH=false starts the app with the Prompt Coach switched off.
"""

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

DATA = Path(tempfile.mkdtemp(prefix="adaptai-e2e-"))
os.environ["ADAPTAI_DATABASE_PATH"] = str(DATA / "e2e.sqlite3")
os.environ["ADAPTAI_CREDENTIALS_KEY_PATH"] = str(DATA / "e2e.key")

import uvicorn  # noqa: E402
from app.main import create_app  # noqa: E402
from app.models import Assessment, Profile  # noqa: E402
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


def build():
    coach = os.environ.get("E2E_PROMPT_COACH", "true").lower() != "false"
    settings = Settings(
        _env_file=None,
        groq_api_key="e2e-fake-key",
        prompt_coach_enabled=coach,
        browser_origin="http://127.0.0.1:8443",
    )
    return create_app(
        settings,
        overrides={"groq": FakeAssessor()},
        prompt_coach_options={"model_factory": FakeCoach} if coach else None,
    )


if __name__ == "__main__":
    uvicorn.run(build(), host="127.0.0.1", port=int(os.environ.get("E2E_API_PORT", "8000")))
