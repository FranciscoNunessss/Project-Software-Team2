"""Módulo opcional Prompt Coach (ADR-009). Desligado por ADAPTAI_PROMPT_COACH_ENABLED. O núcleo não depende deste ficheiro.

Optional Prompt Coach module (ADR-009). Switched off by ADAPTAI_PROMPT_COACH_ENABLED.
The core does not depend on this file.

``app.main.create_app`` imports this module late, only when the flag is true. Deleting
this file (with its tests) must leave the core application working; see README,
"Prompt Coach (optional)", for the removal procedure. This module must never change
``PRAGMA user_version``: any table it needs is created with ``CREATE TABLE IF NOT EXISTS``,
outside the core migrations, so the core still starts after the module is removed.
"""  # noqa: E501

from collections.abc import Callable
from typing import Any

from fastapi import FastAPI

from app.llm_config import ModelConfigurations
from app.providers import Settings
from app.storage import Storage


def install_prompt_coach(
    app: FastAPI,
    store: Storage,
    settings: Settings,
    *,
    configurations: ModelConfigurations,
    enabled: dict[str, bool],
    external_providers: set[str],
    providers: dict[str, Any],
    model_factory: Callable[..., Any] | None = None,
) -> None:
    """Install the Prompt Coach on ``app``.

    No routes are registered yet; later cards add them. The collaborators are kept on
    ``app.state.prompt_coach`` so those cards can build on them.
    """
    app.state.prompt_coach = {
        "store": store,
        "settings": settings,
        "configurations": configurations,
        "enabled": enabled,
        "external_providers": external_providers,
        "providers": providers,
        "model_factory": model_factory,
    }
