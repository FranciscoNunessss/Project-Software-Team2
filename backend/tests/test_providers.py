import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest
from app.models import Profile
from app.providers import LangChainProvider, ProviderFailure, Settings


@pytest.mark.parametrize("provider", ["openai", "groq", "ollama"])
@pytest.mark.parametrize("scenario", ["valid", "invalid", "timeout", "authentication", "rate"])
async def test_adapters_without_network(monkeypatch, provider, scenario):
    constructed = {}

    class FakeModel:
        def __init__(self, **kwargs):
            constructed.update(kwargs)

        def with_structured_output(self, schema, **kwargs):
            assert schema is Profile
            assert kwargs["include_raw"] is True
            return self

        async def ainvoke(self, messages):
            assert messages[-1] == ("human", "Private task")
            if scenario == "timeout":
                await asyncio.sleep(1)
            if scenario in {"authentication", "rate"}:
                error = RuntimeError("Private task and secret must not escape")
                error.status_code = 401 if scenario == "authentication" else 429
                raise error
            return {
                "parsed": None
                if scenario == "invalid"
                else Profile(reasoning=2, context=1, ambiguity=3, explanation="Test evidence"),
                "parsing_error": "bad JSON" if scenario == "invalid" else None,
                "raw": SimpleNamespace(
                    usage_metadata={
                        "input_tokens": 20,
                        "output_tokens": 10,
                        "total_tokens": 30,
                    }
                ),
            }

    target = (
        "langchain_openai.ChatOpenAI"
        if provider in {"openai", "groq"}
        else "langchain_ollama.ChatOllama"
    )
    monkeypatch.setattr(target, FakeModel)
    settings = Settings(
        _env_file=None,
        openai_model="test",
        openai_api_key="fake",
        groq_model="openai/gpt-oss-20b",
        groq_api_key="fake-groq",
        ollama_model="test",
        timeout_seconds=0.02,
    )
    adapter = LangChainProvider(provider, settings)
    if scenario == "valid":
        result = await adapter.assess("Private task")
        assert result.profile.ambiguity == 3
        assert result.usage["total_tokens"] == 30
    else:
        codes = {
            "invalid": "invalid_provider_output",
            "timeout": "provider_timeout",
            "authentication": "provider_authentication",
            "rate": "provider_rate_limit",
        }
        with pytest.raises(ProviderFailure) as failure:
            await adapter.assess("Private task")
        assert failure.value.code == codes[scenario]
    if provider in {"openai", "groq"}:
        assert constructed["max_retries"] == 0
        if provider == "groq":
            assert constructed["base_url"] == "https://api.groq.com/openai/v1"
            assert constructed["api_key"] == "fake-groq"
    else:
        assert constructed["base_url"] == "http://127.0.0.1:11434"


def test_secret_is_redacted():
    settings = Settings(
        _env_file=None,
        openai_api_key="credential-must-stay-private",
        groq_api_key="groq-credential-must-stay-private",
    )
    assert "credential-must-stay-private" not in repr(settings)


async def test_groq_openai_compatible_wire_contract(monkeypatch):
    from langchain_openai import ChatOpenAI

    def handler(request):
        assert str(request.url) == "https://api.groq.com/openai/v1/chat/completions"
        assert request.headers["authorization"] == "Bearer fake-groq"
        body = json.loads(request.content)
        assert body["model"] == "openai/gpt-oss-20b"
        assert body["response_format"]["type"] == "json_schema"
        assert body["response_format"]["json_schema"]["strict"] is True
        return httpx.Response(
            200,
            json={
                "id": "synthetic-completion",
                "object": "chat.completion",
                "created": 1,
                "model": body["model"],
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": json.dumps(
                                {
                                    "reasoning": 2,
                                    "context": 1,
                                    "ambiguity": 2,
                                    "explanation": "Synthetic test assessment",
                                }
                            ),
                        },
                    }
                ],
                "usage": {"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30},
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
        monkeypatch.setattr(
            "langchain_openai.ChatOpenAI",
            lambda **kwargs: ChatOpenAI(
                **kwargs,
                http_async_client=http_client,
            ),
        )
        provider = LangChainProvider("groq", Settings(_env_file=None, groq_api_key="fake-groq"))
        result = await provider.assess("Compare two API designs")
        assert result.profile.reasoning == 2
        assert result.usage["total_tokens"] == 30
