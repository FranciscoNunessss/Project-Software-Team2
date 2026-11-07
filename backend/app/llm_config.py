"""User-scoped model configurations and a bounded, deterministic Auto selector."""

import json
import os
from pathlib import Path
from typing import Literal
from uuid import uuid4

from cryptography.fernet import Fernet, InvalidToken
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator

from app.accounts import AuthenticatedUser
from app.providers import LangChainProvider, ProviderFailure, Settings, server_models
from app.recommendation import Option
from app.storage import Storage

PROVIDERS = ("openai", "claude", "groq", "openrouter", "ollama", "lmstudio")
# Run on the backend machine: no API key, and nothing leaves it.
LOCAL_PROVIDERS = {"ollama", "lmstudio"}
LABELS = {
    "openai": "OpenAI / Codex",
    "claude": "Claude",
    "groq": "Groq",
    "openrouter": "OpenRouter",
    "ollama": "Ollama",
    "lmstudio": "LM Studio",
}
MODEL_FIELDS = {
    "openai": "openai_model",
    "claude": "claude_model",
    "groq": "groq_model",
    "openrouter": "openrouter_model",
    "ollama": "ollama_model",
    "lmstudio": "lmstudio_model",
}
KEY_FIELDS = {
    "openai": "openai_api_key",
    "claude": "anthropic_api_key",
    "groq": "groq_api_key",
    "openrouter": "openrouter_api_key",
}


class Configuration(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    label: str = Field(min_length=1, max_length=80)
    provider: Literal["openai", "claude", "groq", "openrouter", "ollama", "lmstudio"]
    model: str = Field(min_length=1, max_length=200, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$")
    api_key: SecretStr | None = Field(default=None, max_length=4096)
    responses_api: bool = False
    enabled: bool = True
    is_default: bool = False

    @field_validator("api_key")
    @classmethod
    def valid_key(cls, value):
        if value and any(char.isspace() for char in value.get_secret_value()):
            raise ValueError("API key must not contain whitespace")
        return value


def public_config(row):
    return {key: row[key] for key in ("id", "label", "provider", "model", "created_at")} | {
        "has_key": bool(row["key_ciphertext"]),
        "responses_api": bool(row["responses_api"]),
        "enabled": bool(row["enabled"]),
        "is_default": bool(row["is_default"]),
        "external": row["provider"] not in LOCAL_PROVIDERS,
        "source": "personal",
    }


class ModelConfigurations:
    def __init__(self, store: Storage, settings: Settings):
        self.store = store
        self.settings = settings
        self.key_path = Path(
            settings.credentials_key_path or "backend/data/adaptai.credentials.key"
        )

    def cipher(self, *, create=False):
        if self.settings.credentials_key.get_secret_value():
            try:
                return Fernet(self.settings.credentials_key.get_secret_value().encode())
            except ValueError:
                raise HTTPException(503, "credentials_key_unavailable") from None
        if not self.key_path.exists() and create:
            with self.store.connect() as db:
                if db.execute(
                    "SELECT 1 FROM llm_configs WHERE key_ciphertext IS NOT NULL"
                ).fetchone():
                    raise HTTPException(503, "credentials_key_missing")
            self.key_path.parent.mkdir(parents=True, exist_ok=True)
            try:
                descriptor = os.open(self.key_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(Fernet.generate_key())
            except FileExistsError:
                pass
        try:
            return Fernet(self.key_path.read_bytes())
        except (OSError, ValueError):
            raise HTTPException(503, "credentials_key_unavailable") from None

    def owned(self, user_id, identifier):
        with self.store.connect() as db:
            row = db.execute(
                "SELECT * FROM llm_configs WHERE id=%s AND user_id=%s", (identifier, user_id)
            ).fetchone()
        if not row:
            raise HTTPException(404, "configuration_not_found")
        return dict(row)

    def list(self, user_id):
        with self.store.connect() as db:
            return [
                public_config(row)
                for row in db.execute(
                    "SELECT * FROM llm_configs WHERE user_id=%s ORDER BY created_at,sequence_id",
                    (user_id,),
                )
            ]

    def save(self, user_id, body, identifier=None):
        previous = self.owned(user_id, identifier) if identifier else None
        identifier = identifier or str(uuid4())
        encrypted = (
            previous["key_ciphertext"]
            if previous and previous["provider"] == body.provider
            else None
        )
        supplied = body.api_key.get_secret_value() if body.api_key else ""
        if body.provider in LOCAL_PROVIDERS:
            encrypted = None
        elif supplied:
            encrypted = (
                self.cipher(create=True)
                .encrypt(
                    json.dumps({"user_id": user_id, "id": identifier, "key": supplied}).encode()
                )
                .decode()
            )
        if body.provider not in LOCAL_PROVIDERS and not encrypted:
            raise HTTPException(422, "api_key_required")
        if body.is_default and not body.enabled:
            raise HTTPException(422, "default_must_be_enabled")
        with self.store.connect() as db:
            self.store.lock_user(db, user_id)
            if body.is_default:
                db.execute("UPDATE llm_configs SET is_default=0 WHERE user_id=%s", (user_id,))
            if previous:
                cursor = db.execute(
                    """UPDATE llm_configs SET label=%s,provider=%s,model=%s,key_ciphertext=%s,
                       responses_api=%s,enabled=%s,is_default=%s WHERE id=%s AND user_id=%s""",
                    (
                        body.label,
                        body.provider,
                        body.model,
                        encrypted,
                        int(body.responses_api),
                        int(body.enabled),
                        int(body.is_default),
                        identifier,
                        user_id,
                    ),
                )
                if cursor.rowcount != 1:
                    raise HTTPException(404, "configuration_not_found")
            else:
                db.execute(
                    """INSERT INTO llm_configs(id,user_id,label,provider,model,key_ciphertext,
                       responses_api,enabled,is_default) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (
                        identifier,
                        user_id,
                        body.label,
                        body.provider,
                        body.model,
                        encrypted,
                        int(body.responses_api),
                        int(body.enabled),
                        int(body.is_default),
                    ),
                )
        return public_config(self.owned(user_id, identifier))

    def configured_settings(self, row):
        update = {MODEL_FIELDS[row["provider"]]: row["model"]}
        if row["provider"] not in LOCAL_PROVIDERS:
            try:
                decrypted = json.loads(self.cipher().decrypt(row["key_ciphertext"].encode()))
                if decrypted["user_id"] != row["user_id"] or decrypted["id"] != row["id"]:
                    raise ValueError("Mismatched credential owner")
                update[KEY_FIELDS[row["provider"]]] = SecretStr(decrypted["key"])
            except (InvalidToken, ValueError, KeyError, TypeError, AttributeError):
                raise HTTPException(503, "credentials_unavailable") from None
        update["openai_use_responses_api"] = bool(row["responses_api"])
        return self.settings.model_copy(update=update)

    def resolve(self, user_id, body, enabled):
        identifier = body.configuration_id
        automatic = body.provider == "auto" and not identifier
        if automatic:
            if not enabled.get("groq"):
                raise HTTPException(409, "project_default_not_configured")
            identifier = "server:groq"
        if identifier and not identifier.startswith("server:"):
            row = self.owned(user_id, identifier)
            if not row["enabled"]:
                raise HTTPException(409, "configuration_disabled")
            return row["provider"], self.configured_settings(row), row["model"], identifier
        provider = identifier.removeprefix("server:") if identifier else body.provider
        model_name = None
        if ":" in provider:
            # server:<provider>:<model>, one of the server's listed models (ADR-014).
            provider, model_name = provider.split(":", 1)
            if model_name not in server_models(self.settings, provider):
                raise HTTPException(404, "configuration_not_found")
        if provider not in {"demo", *PROVIDERS}:
            raise HTTPException(404, "configuration_not_found")
        if model_name is not None:
            settings = self.settings.model_copy(update={MODEL_FIELDS[provider]: model_name})
            return provider, settings, model_name, f"server:{provider}:{model_name}"
        return (
            provider,
            self.settings,
            (getattr(self.settings, MODEL_FIELDS[provider]) if provider != "demo" else None),
            "server:" + provider,
        )

    def server_options(self, enabled) -> "list[dict]":
        """One entry per server model; the first model of a provider keeps ``server:<p>``."""
        result = []
        for key in ("groq", "openrouter", "openai", "claude", "ollama", "lmstudio", "demo"):
            if not enabled.get(key):
                continue
            models = server_models(self.settings, key) if key != "demo" else [None]
            if key != "demo" and not models:
                models = [getattr(self.settings, MODEL_FIELDS[key]) or None]
            for index, model in enumerate(models):
                result.append(
                    {
                        "id": "server:" + key if index == 0 else f"server:{key}:{model}",
                        "provider": key,
                        "label": LABELS.get(key, "Demonstration"),
                        "model": model,
                        "external": key != "demo" and key not in LOCAL_PROVIDERS,
                        "source": "server",
                    }
                )
        return result

    def send_options(self, user_id, enabled) -> "list[Option]":
        """Every model the user can send to, for the recommendation (available_cards)."""
        personal = [item for item in self.list(user_id) if item["enabled"]]
        return [
            Option(
                provider=item["provider"],
                model=item["model"],
                configuration_id=item["id"],
                label=f"{item['label']} · {item['model']}" if item["model"] else item["label"],
            )
            for item in [*self.server_options(enabled), *personal]
            if item["provider"] != "demo"
        ]


def install_routes(app: FastAPI, configurations: ModelConfigurations, enabled):
    @app.get("/api/llm-configs")
    def list_configs(user: AuthenticatedUser):
        return configurations.list(user["id"])

    @app.post("/api/llm-configs", status_code=201)
    def create(body: Configuration, user: AuthenticatedUser):
        return configurations.save(user["id"], body)

    @app.put("/api/llm-configs/{identifier}")
    def update(identifier: str, body: Configuration, user: AuthenticatedUser):
        return configurations.save(user["id"], body, identifier)

    @app.delete("/api/llm-configs/{identifier}")
    def remove(identifier: str, user: AuthenticatedUser):
        configurations.owned(user["id"], identifier)
        with configurations.store.connect() as db:
            db.execute(
                "DELETE FROM llm_configs WHERE id=%s AND user_id=%s", (identifier, user["id"])
            )
        return {"status": "deleted"}

    @app.get("/api/llm-options")
    def options(user: AuthenticatedUser):
        personal = [item for item in configurations.list(user["id"]) if item["enabled"]]
        server = configurations.server_options(enabled)
        all_options = [*personal, *server]
        return {
            "options": all_options,
            "auto_configuration_id": "server:groq" if enabled.get("groq") else None,
            "auto_policy": "Auto uses the project's Groq configuration. Personal models are "
            "optional and selected manually. No fallback after a provider failure. "
            "Intelligent routing is not implemented.",
        }

    @app.post("/api/llm-configs/{identifier}/test")
    async def test(identifier: str, user: AuthenticatedUser):
        row = configurations.owned(user["id"], identifier)
        try:
            result = await LangChainProvider(
                row["provider"], configurations.configured_settings(row)
            ).assess(
                "Explain what an API is in one sentence. This is a synthetic connectivity test."
            )
        except ProviderFailure as exc:
            raise HTTPException(502, exc.code) from None
        return {"status": "ok", "model": row["model"], "usage": result.usage}
