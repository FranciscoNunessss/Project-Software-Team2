from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class AnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    task: str = Field(min_length=1, max_length=8000)
    provider: Literal["demo", "openai", "ollama"] = "demo"
    allow_external: bool = False
    required_capabilities: list[Literal["text", "code", "vision"]] = Field(
        default_factory=lambda: ["text"]
    )

    @field_validator("task")
    @classmethod
    def non_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Enter a task")
        return value.strip()


class Profile(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    reasoning: int = Field(ge=1, le=3)
    context: int = Field(ge=1, le=3)
    ambiguity: int = Field(ge=1, le=3)
    explanation: str = Field(min_length=1, max_length=1200)


class Candidate(BaseModel):
    id: str
    name: str
    capacity: int = Field(ge=1, le=3)
    capabilities: list[str]


class Decision(BaseModel):
    analysis_id: str
    candidate_id: str


class Assessment(BaseModel):
    profile: Profile
    usage: dict[str, int] | None = None


class AnalysisResult(BaseModel):
    id: str
    mode: Literal["demonstration", "semantic"]
    provider: str
    profile: Profile
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
