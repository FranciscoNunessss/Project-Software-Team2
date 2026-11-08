from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class AnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    task: str = Field(min_length=1, max_length=8000)
    provider: Literal[
        "auto", "demo", "openai", "claude", "groq", "openrouter", "ollama", "lmstudio"
    ] = "demo"
    configuration_id: str | None = Field(default=None, min_length=1, max_length=64)
    expected_configuration_id: str | None = Field(default=None, max_length=64)
    expected_provider: (
        Literal["demo", "openai", "claude", "groq", "openrouter", "ollama", "lmstudio"] | None
    ) = None
    # OpenRouter only: the exact catalogue id picked in the UI. Checked against the catalogue.
    model: str | None = Field(
        default=None, min_length=1, max_length=200, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$"
    )
    expected_model: str | None = Field(default=None, max_length=200)
    allow_external: bool = False
    use_personal_context: bool | None = None
    task_context: str = Field(default="", max_length=4000)
    session_id: str | None = Field(default=None, max_length=36)
    previous_analysis_id: str | None = Field(default=None, min_length=1, max_length=36)
    required_capabilities: list[Literal["text", "code", "vision"]] = Field(
        default_factory=lambda: ["text"]
    )

    @field_validator("task")
    @classmethod
    def non_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Enter a task")
        return value.strip()


Confidence = Literal["low", "medium", "high", "undetermined"]


class Evidence(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    confidence: Confidence
    evidence: str = Field(min_length=1, max_length=240)

    @field_validator("evidence")
    @classmethod
    def meaningful_evidence(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Evidence must not be blank")
        return value.strip()


class Dimension(Evidence):
    score: int | None = Field(ge=1, le=3)

    @model_validator(mode="after")
    def consistent_uncertainty(self):
        if (self.score is None) != (self.confidence == "undetermined"):
            raise ValueError("Unknown scores require undetermined confidence and vice versa")
        return self


ModalityName = Literal["text", "image", "audio", "video"]


class Modality(Evidence):
    required: list[ModalityName] | None = Field(min_length=1, max_length=4)

    @model_validator(mode="after")
    def consistent_modalities(self):
        if (self.required is None) != (self.confidence == "undetermined"):
            raise ValueError("Unknown modalities require undetermined confidence and vice versa")
        if self.required is not None and len(set(self.required)) != len(self.required):
            raise ValueError("Modalities must be distinct")
        return self


class Profile(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    reasoning: Dimension
    context: Dimension
    ambiguity: Dimension
    domain: Dimension
    risk: Dimension
    tools: Dimension
    modality: Modality
    explanation: str = Field(min_length=1, max_length=1200)


DimensionName = Literal["reasoning", "context", "ambiguity", "domain", "risk", "tools", "modality"]


class Change(BaseModel):
    """A dimension whose value differs from the previous analysis in the same session."""

    dimension: DimensionName
    before: int | list[str] | None
    after: int | list[str] | None
    evidence: str


class Tip(BaseModel):
    """A rubric tip for one dimension, or a general tip when dimension is None."""

    model_config = ConfigDict(extra="forbid")
    dimension: DimensionName | None
    text: str = Field(min_length=1)


class Coverage(BaseModel):
    """One task need against one model capability (policy needs-capabilities-1)."""

    need: Literal["reasoning", "context", "domain", "reliability", "tools"]
    estimated: int = Field(ge=1, le=3)
    top: int = Field(ge=1, le=3)
    capability: int | None = Field(ge=1, le=3)
    state: Literal["covers", "covers_as_described", "short"]
    provisional: bool


class Candidate(BaseModel):
    """A model the analysis compared. Card fields (ADR-014) or, for analyses stored before
    needs-capabilities-1, an illustrative tier with ``capacity`` and the graded fit."""

    id: str
    name: str
    capabilities: list[str] = []
    # Legacy tier fields (prototype-3 and prototype-3-graded).
    capacity: int | None = Field(None, ge=1, le=3)
    sufficiency: float | None = Field(None, ge=0, le=1)
    fit: float | None = Field(None, ge=0, le=1)
    # Card fields (needs-capabilities-1).
    provider: str | None = None
    model: str | None = None
    configuration_id: str | None = None
    label: str | None = None
    status: Literal["covers", "covers_as_described", "short"] | None = None
    shortfalls: list[str] = []
    coverage: list[Coverage] = []
    blended_price: float | None = None
    cost_band: Literal["low", "medium", "high"] | None = None
    free: bool = False
    local: bool = False
    illustrative: bool = False
    calibrated: bool = False
    # Where the levels come from (ADR-014 A9, A10), e.g. "LMArena public ranking of 2026-11-06".
    levels_from: str | None = None
    # Chosen minus recommended: -1 covers less, 0 the recommendation, +1 more than needed.
    gap: int | None = Field(None, ge=-1, le=1)


class Decision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    analysis_id: str
    candidate_id: str


class Assessment(BaseModel):
    profile: Profile
    usage: dict[str, int] | None = None


class AnalysisResult(BaseModel):
    id: str
    configuration_id: str | None = None
    selection_mode: Literal["auto", "manual"] = "manual"
    session_id: str
    mode: Literal["demonstration", "semantic"]
    provider: str
    assessment_model: str | None
    profile: Profile
    profile_version: str
    # Analyses stored before the rubric became data used the prompt that rubric-2.0 reproduces.
    rubric_version: str = "rubric-2.0"
    recommendation_provisional: bool
    clarification_questions: list[str]
    guidance: list[str]
    tips: list[Tip] = []
    recommendation: Candidate
    alternatives: list[Candidate]
    rationale: str
    warnings: list[str]
    catalogue_version: str
    policy_version: str
    latency_ms: int
    confidence_basis: str
    usage: dict[str, int] | None
    observed_cost: float | None
    grading: dict | None = None
    previous_analysis_id: str | None = None
    # None only for analyses stored before completeness was introduced (prototype-3).
    completeness: int | None = Field(default=None, ge=0, le=100)
    changes: list[Change] = []
    # needs-capabilities-1: the task needs and the notes (verification, tools, coverage).
    needs: dict | None = None
    notes: list[str] = []
