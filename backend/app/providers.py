import asyncio
from json import JSONDecodeError
from typing import Protocol

from pydantic import Field, SecretStr
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


class LangChainProvider:
    def __init__(self, provider: str, settings: Settings):
        self.provider = provider
        self.settings = settings

    async def assess(self, task: str) -> Assessment:
        from anthropic import APITimeoutError as AnthropicTimeoutError
        from langchain_core.exceptions import OutputParserException
        from langsmith import tracing_context
        from openai import APITimeoutError as OpenAITimeoutError
        from pydantic import ValidationError

        use_responses = self.provider == "openai" and self.settings.openai_use_responses_api
        if self.provider in {"openai", "groq"}:
            from langchain_openai import ChatOpenAI

            is_groq = self.provider == "groq"
            model = ChatOpenAI(
                model=self.settings.groq_model if is_groq else self.settings.openai_model,
                api_key=(
                    self.settings.groq_api_key if is_groq else self.settings.openai_api_key
                ).get_secret_value(),
                base_url="https://api.groq.com/openai/v1" if is_groq else None,
                max_retries=0,
                timeout=self.settings.timeout_seconds,
                max_tokens=4096 if use_responses else 2048,
                use_responses_api=use_responses,
                **({"store": False, "reasoning_effort": "low"} if use_responses else {}),
            )
        elif self.provider == "claude":
            from langchain_anthropic import ChatAnthropic

            model = ChatAnthropic(
                model=self.settings.claude_model,
                api_key=self.settings.anthropic_api_key.get_secret_value(),
                max_tokens=2048,
                max_retries=0,
                timeout=self.settings.timeout_seconds,
            )
        elif self.provider == "ollama":
            from langchain_ollama import ChatOllama

            model = ChatOllama(
                model=self.settings.ollama_model,
                base_url="http://127.0.0.1:11434",
                num_predict=2048,
            )
        else:
            raise ProviderFailure("unsupported_provider")
        prompt = [
            ("system", ASSESSMENT_PROMPT),
            ("human", task),
        ]
        structured_options = {"include_raw": True}
        if self.provider == "groq" or use_responses:
            structured_options.update(method="json_schema", strict=True)
        elif self.provider == "claude":
            structured_options.update(method="json_schema")
        try:
            with tracing_context(enabled=False):
                result = await asyncio.wait_for(
                    model.with_structured_output(Profile, **structured_options).ainvoke(prompt),
                    timeout=self.settings.timeout_seconds,
                )
            if result.get("parsing_error") or result.get("parsed") is None:
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
            return Assessment(profile=Profile.model_validate(result["parsed"]), usage=usage)
        except ProviderFailure:
            raise
        except (TimeoutError, OpenAITimeoutError, AnthropicTimeoutError) as exc:
            raise ProviderFailure("provider_timeout") from exc
        except (ValidationError, OutputParserException, JSONDecodeError) as exc:
            raise ProviderFailure("invalid_provider_output") from exc
        except Exception as exc:
            status = getattr(exc, "status_code", None)
            code = {
                401: "provider_authentication",
                403: "provider_authentication",
                429: "provider_rate_limit",
                400: "provider_unsupported_request",
                404: "provider_model_unavailable",
            }.get(status, "provider_unavailable")
            raise ProviderFailure(code) from exc
