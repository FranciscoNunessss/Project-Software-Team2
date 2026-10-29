from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class AnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    task: str = Field(min_length=1, max_length=8000)
    provider: Literal["auto", "demo", "openai", "claude", "groq", "ollama"] = "demo"
    configuration_id: str | None = Field(default=None, min_length=1, max_length=64)
    expected_configuration_id: str | None = Field(default=None, max_length=64)
    expected_provider: Literal["demo", "openai", "claude", "groq", "ollama"] | None = None
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


class Candidate(BaseModel):
    id: str
    name: str
    capacity: int = Field(ge=1, le=3)
    capabilities: list[str]


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
    previous_analysis_id: str | None = None
    # None only for analyses stored before completeness was introduced (prototype-3).
    completeness: int | None = Field(default=None, ge=0, le=100)
    changes: list[Change] = []
