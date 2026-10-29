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
from app.providers import LangChainProvider, ProviderFailure, Settings
from app.storage import Storage

PROVIDERS = ("openai", "claude", "groq", "ollama")
LABELS = {"openai": "OpenAI / Codex", "claude": "Claude", "groq": "Groq", "ollama": "Ollama"}
MODEL_FIELDS = {
    "openai": "openai_model",
    "claude": "claude_model",
    "groq": "groq_model",
    "ollama": "ollama_model",
}
KEY_FIELDS = {"openai": "openai_api_key", "claude": "anthropic_api_key", "groq": "groq_api_key"}


class Configuration(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    label: str = Field(min_length=1, max_length=80)
    provider: Literal["openai", "claude", "groq", "ollama"]
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
        "external": row["provider"] != "ollama",
        "source": "personal",
    }


class ModelConfigurations:
    def __init__(self, store: Storage, settings: Settings):
        self.store = store
        self.settings = settings
        self.key_path = Path(
            settings.credentials_key_path
            or str(Path(settings.database_path).with_suffix(".credentials.key"))
        )

    def cipher(self, *, create=False):
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
                "SELECT * FROM llm_configs WHERE id=? AND user_id=?", (identifier, user_id)
            ).fetchone()
        if not row:
            raise HTTPException(404, "configuration_not_found")
        return dict(row)

    def list(self, user_id):
        with self.store.connect() as db:
            return [
                public_config(row)
                for row in db.execute(
                    "SELECT * FROM llm_configs WHERE user_id=? ORDER BY created_at,rowid",
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
        if body.provider == "ollama":
            encrypted = None
        elif supplied:
            encrypted = (
                self.cipher(create=True)
                .encrypt(
                    json.dumps({"user_id": user_id, "id": identifier, "key": supplied}).encode()
                )
                .decode()
            )
        if body.provider != "ollama" and not encrypted:
            raise HTTPException(422, "api_key_required")
        if body.is_default and not body.enabled:
            raise HTTPException(422, "default_must_be_enabled")
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if body.is_default:
                db.execute("UPDATE llm_configs SET is_default=0 WHERE user_id=?", (user_id,))
            if previous:
                cursor = db.execute(
                    """UPDATE llm_configs SET label=?,provider=?,model=?,key_ciphertext=?,
                       responses_api=?,enabled=?,is_default=? WHERE id=? AND user_id=?""",
                    (
                        body.label,
                        body.provider,
                        body.model,
                        encrypted,
                        body.responses_api,
                        body.enabled,
                        body.is_default,
                        identifier,
                        user_id,
                    ),
                )
                if cursor.rowcount != 1:
                    raise HTTPException(404, "configuration_not_found")
            else:
                db.execute(
                    """INSERT INTO llm_configs(id,user_id,label,provider,model,key_ciphertext,
                       responses_api,enabled,is_default) VALUES (?,?,?,?,?,?,?,?,?)""",
                    (
                        identifier,
                        user_id,
                        body.label,
                        body.provider,
                        body.model,
                        encrypted,
                        body.responses_api,
                        body.enabled,
                        body.is_default,
                    ),
                )
        return public_config(self.owned(user_id, identifier))

    def configured_settings(self, row):
        update = {MODEL_FIELDS[row["provider"]]: row["model"]}
        if row["provider"] != "ollama":
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
        if provider not in {"demo", *PROVIDERS}:
            raise HTTPException(404, "configuration_not_found")
        return (
            provider,
            self.settings,
            (getattr(self.settings, MODEL_FIELDS[provider]) if provider != "demo" else None),
            "server:" + provider,
        )


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
            db.execute("DELETE FROM llm_configs WHERE id=? AND user_id=?", (identifier, user["id"]))
        return {"status": "deleted"}

    @app.get("/api/llm-options")
    def options(user: AuthenticatedUser):
        personal = [item for item in configurations.list(user["id"]) if item["enabled"]]
        server = [
            {
                "id": "server:" + key,
                "provider": key,
                "label": LABELS.get(key, "Demonstration"),
                "model": getattr(configurations.settings, MODEL_FIELDS[key])
                if key != "demo"
                else None,
                "external": key not in {"demo", "ollama"},
                "source": "server",
            }
            for key in ("groq", "openai", "claude", "ollama", "demo")
            if enabled.get(key)
        ]
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
