import asyncio
from dataclasses import dataclass
from json import JSONDecodeError
from typing import Literal, Protocol

from pydantic import BaseModel, Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.assessment import ASSESSMENT_PROMPT
from app.models import Assessment, Dimension, Modality, Profile


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ADAPTAI_", env_file=".env", extra="ignore")
    openai_model: str = ""
    openai_api_key: SecretStr = SecretStr("")
    openai_use_responses_api: bool = False
    claude_model: str = ""
    anthropic_api_key: SecretStr = SecretStr("")
    groq_model: str = "openai/gpt-oss-20b"
    groq_api_key: SecretStr = SecretStr("")
    ollama_model: str = ""
    timeout_seconds: float = Field(default=30, gt=0, le=120)
    database_path: str = "backend/data/adaptai.sqlite3"
    credentials_key_path: str = ""
    session_days: int = Field(default=7, ge=1, le=30)
    cookie_secure: bool = False
    browser_origin: str = "http://127.0.0.1:8443"


class AssessmentProvider(Protocol):
    async def assess(self, task: str) -> Assessment: ...


class ProviderFailure(Exception):
    def __init__(self, code: str):
        self.code = code


class DemonstrationProvider:
    async def assess(self, task: str) -> Assessment:
        words = len(task.split())
        unknown = Dimension(
            score=None,
            confidence="undetermined",
            evidence="A word-count demonstration cannot determine this semantic dimension.",
        )
        return Assessment(
            profile=Profile(
                reasoning=unknown,
                context=Dimension(
                    score=1 if words < 80 else 2 if words < 300 else 3,
                    confidence="low",
                    evidence=f"Size proxy: {words} submitted words; not semantic context.",
                ),
                ambiguity=unknown,
                domain=unknown,
                risk=unknown,
                tools=unknown,
                modality=Modality(
                    required=None,
                    confidence="undetermined",
                    evidence="Submission format does not establish execution modalities.",
                ),
                explanation="Local demonstration only. Semantic dimensions remain undetermined; "
                "the context score is an unvalidated word-count proxy.",
            )
        )


@dataclass(frozen=True)
class RoleParameters:
    temperature: float | None
    max_tokens: int
    responses_max_tokens: int


# Per-role generation parameters. A temperature of None means "do not send one".
ROLE_PARAMETERS: dict[str, RoleParameters] = {
    "assessment": RoleParameters(temperature=None, max_tokens=2048, responses_max_tokens=4096),
    "coach": RoleParameters(temperature=0, max_tokens=1600, responses_max_tokens=1600),
    "educator": RoleParameters(temperature=None, max_tokens=4096, responses_max_tokens=4096),
}

_STATUS_CODES = {
    401: "provider_authentication",
    403: "provider_authentication",
    429: "provider_rate_limit",
    400: "provider_unsupported_request",
    404: "provider_model_unavailable",
}

# (provider, model) pairs that answered HTTP 400 to a request carrying a temperature.
_TEMPERATURE_REFUSED: set[tuple[str, str]] = set()


def provider_error_code(exc: BaseException) -> str:
    """Map any provider-side exception to the application's error code."""
    from anthropic import APITimeoutError as AnthropicTimeoutError
    from langchain_core.exceptions import OutputParserException
    from openai import APITimeoutError as OpenAITimeoutError
    from pydantic import ValidationError

    if isinstance(exc, ProviderFailure):
        return exc.code
    if isinstance(exc, (TimeoutError, OpenAITimeoutError, AnthropicTimeoutError)):
        return "provider_timeout"
    if isinstance(exc, (ValidationError, OutputParserException, JSONDecodeError)):
        return "invalid_provider_output"
    return _STATUS_CODES.get(getattr(exc, "status_code", None), "provider_unavailable")


def _model_id(provider: str, settings: Settings) -> str:
    return {
        "openai": settings.openai_model,
        "groq": settings.groq_model,
        "claude": settings.claude_model,
        "ollama": settings.ollama_model,
    }[provider]


def _build_model(provider: str, settings: Settings, max_tokens: int, temperature: float | None):
    use_responses = provider == "openai" and settings.openai_use_responses_api
    sampling = {} if temperature is None else {"temperature": temperature}
    if provider in {"openai", "groq"}:
        from langchain_openai import ChatOpenAI

        is_groq = provider == "groq"
        return ChatOpenAI(
            model=_model_id(provider, settings),
            api_key=(
                settings.groq_api_key if is_groq else settings.openai_api_key
            ).get_secret_value(),
            base_url="https://api.groq.com/openai/v1" if is_groq else None,
            max_retries=0,
            timeout=settings.timeout_seconds,
            max_tokens=max_tokens,
            use_responses_api=use_responses,
            **({"store": False, "reasoning_effort": "low"} if use_responses else {}),
            **sampling,
        )
    if provider == "claude":
        from langchain_anthropic import ChatAnthropic

        return ChatAnthropic(
            model=settings.claude_model,
            api_key=settings.anthropic_api_key.get_secret_value(),
            max_tokens=max_tokens,
            max_retries=0,
            timeout=settings.timeout_seconds,
            **sampling,
        )
    from langchain_ollama import ChatOllama

    return ChatOllama(
        model=settings.ollama_model,
        base_url="http://127.0.0.1:11434",
        num_predict=max_tokens,
        **sampling,
    )


async def _invoke(
    provider: str,
    settings: Settings,
    schema: type[BaseModel],
    prompt: list[tuple[str, str]],
    max_tokens: int,
    temperature: float | None,
) -> tuple[dict, dict[str, int] | None]:
    from langsmith import tracing_context

    use_responses = provider == "openai" and settings.openai_use_responses_api
    model = _build_model(provider, settings, max_tokens, temperature)
    structured_options = {"include_raw": True}
    if provider == "groq" or use_responses:
        structured_options.update(method="json_schema", strict=True)
    elif provider == "claude":
        structured_options.update(method="json_schema")
    with tracing_context(enabled=False):
        result = await asyncio.wait_for(
            model.with_structured_output(schema, **structured_options).ainvoke(prompt),
            timeout=settings.timeout_seconds,
        )
    parsed = result.get("parsed")
    if result.get("parsing_error") or parsed is None:
        raise ProviderFailure("invalid_provider_output")
    raw_usage = getattr(result.get("raw"), "usage_metadata", None)
    usage = (
        None
        if raw_usage is None
        else {
            key: raw_usage[key]
            for key in ("input_tokens", "output_tokens", "total_tokens")
            if isinstance(raw_usage.get(key), int)
        }
    )
    # Validate inside the mapped region so schema violations become invalid_provider_output.
    return schema.model_validate(parsed).model_dump(), usage


async def structured_call(
    provider: str,
    settings: Settings,
    schema: type[BaseModel],
    system: str,
    human: str,
    role: Literal["assessment", "coach", "educator"],
) -> tuple[dict, dict[str, int] | None]:
    """Run one structured-output call and return ``(parsed, usage)``.

    Every failure surfaces as ``ProviderFailure`` with a code from ``provider_error_code``.
    """
    if provider not in {"openai", "groq", "claude", "ollama"}:
        raise ProviderFailure("unsupported_provider")
    parameters = ROLE_PARAMETERS[role]
    use_responses = provider == "openai" and settings.openai_use_responses_api
    max_tokens = parameters.responses_max_tokens if use_responses else parameters.max_tokens
    key = (provider, _model_id(provider, settings))
    temperature = None if use_responses or key in _TEMPERATURE_REFUSED else parameters.temperature
    prompt = [("system", system), ("human", human)]
    try:
        return await _invoke(provider, settings, schema, prompt, max_tokens, temperature)
    except Exception as exc:
        if temperature is None or getattr(exc, "status_code", None) != 400:
            raise ProviderFailure(provider_error_code(exc)) from exc
    # The model rejected the request while a temperature was set: retry once without it.
    try:
        result = await _invoke(provider, settings, schema, prompt, max_tokens, None)
    except Exception as exc:
        raise ProviderFailure(provider_error_code(exc)) from exc
    _TEMPERATURE_REFUSED.add(key)
    return result


class LangChainProvider:
    def __init__(self, provider: str, settings: Settings):
        self.provider = provider
        self.settings = settings

    async def assess(self, task: str) -> Assessment:
        parsed, usage = await structured_call(
            self.provider, self.settings, Profile, ASSESSMENT_PROMPT, task, "assessment"
        )
        return Assessment(profile=Profile.model_validate(parsed), usage=usage)
