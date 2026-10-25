import asyncio
import json
from types import SimpleNamespace

import httpx
import httpx2
import pytest
from app.models import Profile
from app.providers import LangChainProvider, ProviderFailure, Settings
from profile_samples import profile_data


@pytest.mark.parametrize("provider", ["openai", "claude", "groq", "ollama"])
@pytest.mark.parametrize("scenario", ["valid", "invalid", "timeout", "authentication", "rate"])
async def test_adapters_without_network(monkeypatch, provider, scenario):
    constructed = {}

    class FakeModel:
        def __init__(self, **kwargs):
            constructed.update(kwargs)

        def with_structured_output(self, schema, **kwargs):
            assert schema is Profile
            assert kwargs["include_raw"] is True
            if provider in {"claude", "groq"}:
                assert kwargs["method"] == "json_schema"
            if provider == "groq":
                assert kwargs["strict"] is True
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
                else Profile.model_validate(profile_data(reasoning=2, ambiguity=3)),
                "parsing_error": "bad JSON" if scenario == "invalid" else None,
                "raw": SimpleNamespace(
                    usage_metadata={
                        "input_tokens": 20,
                        "output_tokens": 10,
                        "total_tokens": 30,
                    }
                ),
            }

    target = {
        "openai": "langchain_openai.ChatOpenAI",
        "groq": "langchain_openai.ChatOpenAI",
        "claude": "langchain_anthropic.ChatAnthropic",
        "ollama": "langchain_ollama.ChatOllama",
    }[provider]
    monkeypatch.setattr(target, FakeModel)
    settings = Settings(
        _env_file=None,
        openai_model="test",
        openai_api_key="fake",
        claude_model="test-claude",
        anthropic_api_key="fake-anthropic",
        groq_model="openai/gpt-oss-20b",
        groq_api_key="fake-groq",
        ollama_model="test",
        timeout_seconds=0.02,
    )
    adapter = LangChainProvider(provider, settings)
    if scenario == "valid":
        result = await adapter.assess("Private task")
        assert result.profile.ambiguity.score == 3
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
    if provider in {"openai", "groq", "claude"}:
        assert constructed["max_retries"] == 0
        assert constructed["timeout"] == settings.timeout_seconds
        if provider in {"openai", "groq"}:
            assert constructed["use_responses_api"] is False
        if provider == "claude":
            assert constructed["model"] == "test-claude"
            assert constructed["api_key"] == "fake-anthropic"
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
        anthropic_api_key="anthropic-credential-must-stay-private",
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
                            "content": json.dumps(profile_data(reasoning=2, ambiguity=2)),
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
        assert result.profile.reasoning.score == 2
        assert result.usage["total_tokens"] == 30


@pytest.mark.parametrize("provider_id", ["openai", "claude"])
@pytest.mark.parametrize(
    "scenario",
    [
        "valid",
        "invalid",
        "malformed_json",
        "refusal",
        "timeout",
        "authentication",
        "rate",
        "unsupported",
    ],
)
async def test_openai_responses_and_claude_wire_contracts(monkeypatch, provider_id, scenario):
    """Exercise the real SDK serializers and parsers, with HTTP replaced locally."""
    from langchain_openai import ChatOpenAI

    model_id = "configured-codex" if provider_id == "openai" else "configured-claude"
    transport_api = httpx if provider_id == "openai" else httpx2
    status_codes = {"authentication": 401, "rate": 429, "unsupported": 400}
    calls = []

    def handler(request):
        calls.append(request)
        body = json.loads(request.content)
        assert body["model"] == model_id
        assert "Private task" in request.content.decode()
        if scenario == "timeout":
            raise transport_api.ReadTimeout("Private task", request=request)
        if provider_id == "openai":
            assert str(request.url) == "https://api.openai.com/v1/responses"
            assert request.headers["authorization"] == "Bearer fake-openai"
            assert body["store"] is False
            assert body["text"]["format"]["type"] == "json_schema"
            assert body["text"]["format"]["strict"] is True
            assert body["max_output_tokens"] == 4096
            assert not body.get("tools")
        else:
            assert str(request.url) == "https://api.anthropic.com/v1/messages"
            assert request.headers["x-api-key"] == "fake-anthropic"
            assert body["output_config"]["format"]["type"] == "json_schema"
            assert body["max_tokens"] == 2048
            assert "Assess the user's task" in body["system"]
            assert not body.get("tools")
        if scenario in status_codes:
            return transport_api.Response(
                status_codes[scenario],
                json={"type": "error", "error": {"type": "api_error", "message": "Private task"}},
            )
        profile = {
            "reasoning": 99 if scenario == "invalid" else 2,
            "context": 1,
            "ambiguity": 2,
            "explanation": "Synthetic evidence",
        }
        output_text = (
            json.dumps(profile)
            if scenario not in {"malformed_json", "refusal"}
            else "Incomplete JSON"
        )
        if provider_id == "openai":
            response = {
                "id": "resp_synthetic",
                "object": "response",
                "created_at": 1,
                "model": model_id,
                "status": "completed",
                "output": [
                    {
                        "id": "msg_synthetic",
                        "type": "message",
                        "role": "assistant",
                        "status": "completed",
                        "content": (
                            [{"type": "refusal", "refusal": "Cannot assess"}]
                            if scenario == "refusal"
                            else [{"type": "output_text", "text": output_text, "annotations": []}]
                        ),
                    }
                ],
                "usage": {"input_tokens": 20, "output_tokens": 10, "total_tokens": 30},
            }
        else:
            response = {
                "id": "msg_synthetic",
                "type": "message",
                "role": "assistant",
                "model": model_id,
                "content": [{"type": "text", "text": output_text}],
                "stop_reason": "refusal" if scenario == "refusal" else "end_turn",
                "stop_sequence": None,
                "usage": {"input_tokens": 20, "output_tokens": 10},
            }
        return transport_api.Response(200, json=response)

    async with transport_api.AsyncClient(
        transport=transport_api.MockTransport(handler)
    ) as http_client:
        if provider_id == "openai":
            monkeypatch.setattr(
                "langchain_openai.ChatOpenAI",
                lambda **kwargs: ChatOpenAI(**kwargs, http_async_client=http_client),
            )
        else:
            monkeypatch.setattr(
                "langchain_anthropic.chat_models._get_default_async_httpx_client",
                lambda **kwargs: http_client,
            )
        provider = LangChainProvider(
            provider_id,
            Settings(
                _env_file=None,
                openai_model=model_id,
                openai_use_responses_api=True,
                claude_model=model_id,
                openai_api_key="fake-openai",
                anthropic_api_key="fake-anthropic",
            ),
        )
        if scenario == "valid":
            result = await provider.assess("Private task")
            assert result.profile.reasoning == 2
            assert result.usage == {"input_tokens": 20, "output_tokens": 10, "total_tokens": 30}
        else:
            expected = {
                "invalid": "invalid_provider_output",
                "malformed_json": "invalid_provider_output",
                "refusal": "invalid_provider_output",
                "timeout": "provider_timeout",
                "authentication": "provider_authentication",
                "rate": "provider_rate_limit",
                "unsupported": "provider_unsupported_request",
            }[scenario]
            with pytest.raises(ProviderFailure) as failure:
                await provider.assess("Private task")
            assert failure.value.code == expected
            assert "Private task" not in str(failure.value)
        assert len(calls) == 1
