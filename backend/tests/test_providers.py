import asyncio
from types import SimpleNamespace

import pytest
from app.models import Profile
from app.providers import LangChainProvider, ProviderFailure, Settings


@pytest.mark.parametrize("provider", ["openai", "ollama"])
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
        "langchain_openai.ChatOpenAI" if provider == "openai" else "langchain_ollama.ChatOllama"
    )
    monkeypatch.setattr(target, FakeModel)
    settings = Settings(
        _env_file=None,
        openai_model="test",
        openai_api_key="fake",
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
    if provider == "openai":
        assert constructed["max_retries"] == 0
    else:
        assert constructed["base_url"] == "http://127.0.0.1:11434"


def test_secret_is_redacted():
    settings = Settings(_env_file=None, openai_api_key="credential-must-stay-private")
    assert "credential-must-stay-private" not in repr(settings)
