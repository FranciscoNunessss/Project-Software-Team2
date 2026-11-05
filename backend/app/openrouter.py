"""OpenRouter model catalogue: fetched dynamically, normalised and validated.

The catalogue (``GET /models``) is public, so it is fetched without the API key: the key is only
ever sent to ``/chat/completions`` by the provider adapter. Nothing here is a static model list.
"""

import asyncio
import time
from collections.abc import Awaitable, Callable
from decimal import Decimal, InvalidOperation

import httpx

BASE_URL = "https://openrouter.ai/api/v1"
FREE_ROUTER = "openrouter/free"
CACHE_SECONDS = 300
_PER_MILLION = Decimal(1_000_000)
_STRUCTURED = {"structured_outputs", "response_format"}

Fetcher = Callable[[], Awaitable[list[dict]]]


class CatalogueUnavailable(Exception):
    """The catalogue could not be fetched or understood; carries a safe error code."""

    def __init__(self, code: str = "openrouter_catalogue_unavailable"):
        self.code = code


def _price(raw) -> Decimal | None:
    """Per-token price as a Decimal; None when missing, unparsable or negative (variable)."""
    if raw is None or isinstance(raw, bool):
        return None
    try:
        value = Decimal(str(raw))
    except InvalidOperation:
        return None
    return value if value.is_finite() and value >= 0 else None


def _per_million(value: Decimal | None) -> float | None:
    return None if value is None else float(value * _PER_MILLION)


def normalise(raw: dict) -> dict | None:
    """One catalogue entry for the UI, or None when the entry is unusable (no id)."""
    identifier = raw.get("id")
    if not isinstance(identifier, str) or not identifier:
        return None
    architecture = raw.get("architecture") or {}
    pricing = raw.get("pricing") or {}
    inputs = [m for m in architecture.get("input_modalities") or [] if isinstance(m, str)]
    outputs = [m for m in architecture.get("output_modalities") or [] if isinstance(m, str)]
    parameters = [p for p in raw.get("supported_parameters") or [] if isinstance(p, str)]
    prompt, completion = _price(pricing.get("prompt")), _price(pricing.get("completion"))
    request = pricing.get("request")
    # Free only when the metadata confirms zero input AND output cost (and no per-request fee).
    free = prompt == 0 and completion == 0 and (request is None or _price(request) == 0)
    text_chat = "text" in inputs and outputs == ["text"]
    structured = bool(_STRUCTURED & set(parameters))
    reason = None
    if not text_chat:
        reason = "Not a text conversation model (other input or output modality)."
    elif not structured:
        reason = "Does not support structured output, which the task assessment requires."
    top = raw.get("top_provider") or {}
    return {
        "id": identifier,
        "name": raw.get("name") if isinstance(raw.get("name"), str) else identifier,
        "organisation": identifier.split("/", 1)[0] if "/" in identifier else "other",
        "description": raw.get("description") if isinstance(raw.get("description"), str) else "",
        "context_length": raw.get("context_length")
        if isinstance(raw.get("context_length"), int)
        else None,
        "price_input_per_million": _per_million(prompt),
        "price_output_per_million": _per_million(completion),
        "free": free,
        "input_modalities": inputs,
        "output_modalities": outputs,
        "supported_parameters": parameters,
        "top_provider": {
            "context_length": top.get("context_length"),
            "max_completion_tokens": top.get("max_completion_tokens"),
            "is_moderated": top.get("is_moderated"),
        },
        "text_chat": text_chat,
        "structured_output": structured,
        "selectable": reason is None,
        "unavailable_reason": reason,
    }


def build_catalogue(entries: list[dict]) -> list[dict]:
    """Normalise every entry. Free and paid models are all kept; nothing is filtered by ``:free``.

    The Auto router is offered separately, so it is not repeated among the individual models.
    """
    models = [item for raw in entries if (item := normalise(raw)) and item["id"] != FREE_ROUTER]
    return sorted(models, key=lambda item: (item["organisation"], item["name"].lower()))


async def fetch_models(
    timeout: float, transport: httpx.AsyncBaseTransport | None = None
) -> list[dict]:
    """GET /models. Any failure becomes a safe error code; no upstream body is ever exposed."""
    try:
        async with httpx.AsyncClient(timeout=timeout, transport=transport) as client:
            response = await client.get(
                f"{BASE_URL}/models", headers={"Accept": "application/json"}
            )
        response.raise_for_status()
        data = response.json().get("data")
    except Exception:
        raise CatalogueUnavailable from None
    if not isinstance(data, list):
        raise CatalogueUnavailable("openrouter_catalogue_invalid")
    return [item for item in data if isinstance(item, dict)]


class OpenRouterCatalogue:
    """In-memory, short-lived cache of the normalised catalogue.

    There is no stale fallback: when a refresh fails the error is reported, never an old list.
    """

    def __init__(self, fetch: Fetcher, ttl: float = CACHE_SECONDS):
        self._fetch = fetch
        self._ttl = ttl
        self._lock = asyncio.Lock()
        self._models: list[dict] | None = None
        self._at = 0.0
        self._wall = 0.0

    async def models(self, refresh: bool = False) -> tuple[list[dict], float]:
        async with self._lock:
            if refresh or self._models is None or time.monotonic() - self._at > self._ttl:
                self._models = None
                self._models = build_catalogue(await self._fetch())
                self._at = time.monotonic()
                self._wall = time.time()
            return self._models, self._wall

    async def check(self, model: str, *, structured: bool = True) -> None:
        """Raise ValueError('model_not_found' | 'model_not_compatible') for an unusable id.

        ``openrouter/free`` is the Auto router and is always allowed without a lookup. The
        assessment needs structured output (``structured=True``); the chat only needs a
        text-in, text-out model (``structured=False``).
        """
        if model == FREE_ROUTER:
            return
        models, _ = await self.models()
        match = next((item for item in models if item["id"] == model), None)
        if match is None:
            raise ValueError("model_not_found")
        if not (match["selectable"] if structured else match["text_chat"]):
            raise ValueError("model_not_compatible")
