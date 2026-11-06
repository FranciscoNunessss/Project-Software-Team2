"""Optional AdaptAI Chat module (ADR-011). The core does not depend on this file.

A chat is a session (``sessions``) marked in ``chat_sessions``. The user writes a message,
may analyse it first with the existing ``POST /api/analyze`` (passing the chat id as
``session_id``), and sends it to a model of their choice. Questions and answers are kept in
``chat_messages`` while the chat exists; deleting the chat (or the history) deletes them.

``app.main.create_app`` imports this module late, after every core route, and carries on
without it if the file is missing. Deleting this file (with ``tests/test_chat*.py``) must
leave the core working. The module never changes ``PRAGMA user_version``: its tables are
created with ``CREATE TABLE IF NOT EXISTS``, outside the core migrations.

Privacy: the message text goes only to the model chosen for the answer (the click on Send is
the consent for an external provider, as with Analyse). Nothing is traced. The Educator
receives no message text.
"""

import json
from collections.abc import AsyncIterator, Callable
from types import SimpleNamespace
from typing import Any, Literal
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from langsmith import tracing_context
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.accounts import AuthenticatedUser
from app.llm_config import ModelConfigurations
from app.openrouter import CatalogueUnavailable
from app.providers import Settings, chat_model, provider_error_code
from app.storage import Storage

MAX_MESSAGE_CHARS = 8000
MAX_HISTORY_TURNS = 20
MAX_HISTORY_CHARS = 12000
MAX_ANSWER_TOKENS = 1024
TITLE_CHARS = 60
NEW_CHAT_TITLE = "New chat"
DEMO_ANSWER = (
    "This is the demonstration model, so there is no real answer here. "
    "Add a model in LLM config to chat with it."
)
# Every model is asked for the same output format, so the chat renders all of them alike.
SYSTEM_PROMPT = (
    "You are a helpful assistant. Answer clearly and concisely. "
    "Format answers in Markdown (GitHub-flavoured) when structure helps: headings, lists, "
    "tables and fenced code blocks with a language. Do not use raw HTML."
)

TABLES = (
    "CREATE TABLE IF NOT EXISTS chat_sessions ("
    " session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,"
    " created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
    "CREATE TABLE IF NOT EXISTS chat_messages ("
    " id TEXT PRIMARY KEY,"
    " session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,"
    " role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),"
    " content TEXT NOT NULL,"
    " provider TEXT, model TEXT,"
    " analysis_id TEXT REFERENCES analyses(id) ON DELETE SET NULL,"
    " status TEXT NOT NULL DEFAULT 'complete'"
    "  CHECK (status IN ('complete', 'stopped', 'failed')),"
    " error TEXT,"
    " created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
    "CREATE INDEX IF NOT EXISTS chat_message_session ON chat_messages(session_id, created_at)",
    "CREATE TABLE IF NOT EXISTS chat_settings ("
    " user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,"
    " auto_analyse INTEGER NOT NULL DEFAULT 0)",
    # Removed by ADR-014: models are linked to catalogue cards by their aliases.
    "DROP TABLE IF EXISTS chat_model_tiers",
)

Provider = Literal["auto", "demo", "openai", "claude", "groq", "openrouter", "ollama", "lmstudio"]
# OpenRouter only (ADR-012): the exact catalogue id; it is never replaced silently.
ModelId = Field(
    default=None, min_length=1, max_length=200, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$"
)


class ChatRename(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=120)

    @field_validator("title")
    @classmethod
    def strip(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("title must not be blank")
        return value.strip()


class MessageInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    content: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARS)
    provider: Provider = "auto"
    configuration_id: str | None = Field(default=None, min_length=1, max_length=64)
    model: str | None = ModelId
    analysis_id: str | None = Field(default=None, min_length=1, max_length=36)
    allow_external: bool = False

    @field_validator("content")
    @classmethod
    def not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("content must not be blank")
        return value


class RetryInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider: Provider = "auto"
    configuration_id: str | None = Field(default=None, min_length=1, max_length=64)
    model: str | None = ModelId
    allow_external: bool = False


class ChatSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    auto_analyse: bool


# --- models --------------------------------------------------------------------------------


class ChatModel:
    """Default answer model: the provider's chat model, streamed as text."""

    def __init__(self, provider: str, settings: Settings, model: str | None):
        self.provider, self.settings, self.model = provider, settings, model

    async def stream(self, messages: list[tuple[str, str]]) -> AsyncIterator[str]:
        llm = chat_model(self.provider, self.settings, MAX_ANSWER_TOKENS)
        with tracing_context(enabled=False):
            async for chunk in llm.astream(messages):
                text = (
                    chunk.content
                    if isinstance(chunk.content, str)
                    else "".join(
                        part.get("text", "") for part in chunk.content if isinstance(part, dict)
                    )
                )
                if text:
                    yield text


class DemoChat:
    """The demonstration provider has no language model: it answers with a fixed note."""

    def __init__(self, *_args):
        pass

    async def stream(self, _messages: list[tuple[str, str]]) -> AsyncIterator[str]:
        yield DEMO_ANSWER


# --- helpers -------------------------------------------------------------------------------


def history_for(rows: list[dict]) -> list[tuple[str, str]]:
    """The newest complete turns that fit in MAX_HISTORY_TURNS and MAX_HISTORY_CHARS."""
    kept: list[tuple[str, str]] = []
    total = 0
    for row in reversed(rows):
        if row["status"] == "failed" or not row["content"]:
            continue
        role = "human" if row["role"] == "user" else "ai"
        if len(kept) >= MAX_HISTORY_TURNS * 2 or total + len(row["content"]) > MAX_HISTORY_CHARS:
            break
        kept.append((role, row["content"]))
        total += len(row["content"])
    kept.reverse()
    while kept and kept[0][0] == "ai":  # A conversation sent to a model starts with the user.
        kept.pop(0)
    return kept


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def title_from(content: str) -> str:
    line = " ".join(content.split())
    return line if len(line) <= TITLE_CHARS else line[: TITLE_CHARS - 1].rstrip() + "…"


def public_message(row: dict) -> dict:
    keys = ("id", "role", "content", "provider", "model", "analysis_id", "status", "error")
    message = {key: row[key] for key in keys}
    message["created_at"] = row["created_at"]
    if "result_json" in row and row["result_json"]:
        message["completeness"] = json.loads(row["result_json"]).get("completeness")
    else:
        message["completeness"] = None
    return message


async def answer_events(
    store: Storage, answer, answer_id: str, provider: str, model: str | None, history
) -> AsyncIterator[dict]:
    """Yield ``delta`` (and ``error``) events and keep the answer row in step.

    A model that ends without any text is stored as ``failed`` with ``empty_answer``.
    The row is written in ``finally``: if the client goes away mid-answer the generator is
    closed and the text that arrived so far stays, with status ``stopped``.
    """
    parts: list[str] = []
    status, error = "stopped", None
    try:
        async for text in answer.stream([("system", SYSTEM_PROMPT), *history]):
            parts.append(text)
            yield {"event": "delta", "text": text}
        if "".join(parts).strip():
            status = "complete"
        else:
            # Some models (reasoning models in particular) sometimes end without any answer
            # text. An empty reply is a failure the user can retry, never a "complete" answer.
            status, error = "failed", "empty_answer"
            yield {"event": "error", "code": error}
    except Exception as exc:  # noqa: BLE001 - every provider failure becomes a stored state.
        status, error = "failed", provider_error_code(exc)
        yield {"event": "error", "code": error}
    finally:
        with store.connect() as db:
            db.execute(
                "UPDATE chat_messages SET content=?,provider=?,model=?,status=?,error=? WHERE id=?",
                ("".join(parts), provider, model, status, error, answer_id),
            )


# --- installation --------------------------------------------------------------------------


def install_chat(
    app: FastAPI,
    store: Storage,
    settings: Settings,
    *,
    configurations: ModelConfigurations,
    enabled: dict[str, bool],
    external_providers: set[str],
    model_factory: Callable[..., Any] | None = None,
    openrouter_catalogue: Any | None = None,
) -> None:
    """Install the chat routes on ``app``.

    ``model_factory(provider, settings, model)`` returns an object with
    ``stream(messages) -> AsyncIterator[str]``; it defaults to ``ChatModel`` (``DemoChat``
    for the demonstration provider).
    """
    factory = model_factory or ChatModel
    app.state.chat = {"store": store, "settings": settings, "model_factory": factory}
    with store.connect() as db:
        for statement in TABLES:
            db.execute(statement)

    def owned_chat(db, user_id: str, chat_id: str) -> dict:
        row = db.execute(
            "SELECT s.id, s.title, s.created_at FROM sessions s "
            "JOIN chat_sessions c ON c.session_id=s.id WHERE s.id=? AND s.user_id=?",
            (chat_id, user_id),
        ).fetchone()
        if not row:
            raise HTTPException(404, "chat_not_found")
        return dict(row)

    def messages_of(db, chat_id: str) -> list[dict]:
        return [
            dict(row)
            for row in db.execute(
                "SELECT m.*, a.result_json FROM chat_messages m "
                "LEFT JOIN analyses a ON a.id=m.analysis_id "
                "WHERE m.session_id=? ORDER BY m.created_at, m.rowid",
                (chat_id,),
            )
        ]

    @app.get("/api/chats")
    def list_chats(user: AuthenticatedUser):
        with store.connect() as db:
            rows = db.execute(
                "SELECT s.id, s.title, s.created_at, count(m.id) AS message_count, "
                "coalesce(max(m.created_at), s.created_at) AS updated_at "
                "FROM sessions s JOIN chat_sessions c ON c.session_id=s.id "
                "LEFT JOIN chat_messages m ON m.session_id=s.id WHERE s.user_id=? "
                "GROUP BY s.id ORDER BY updated_at DESC, s.rowid DESC",
                (user["id"],),
            )
            return [dict(row) for row in rows]

    @app.post("/api/chats", status_code=201)
    def create_chat(user: AuthenticatedUser):
        session = store.create_session(user["id"], NEW_CHAT_TITLE, "")
        with store.connect() as db:
            db.execute("UPDATE sessions SET title=? WHERE id=?", (NEW_CHAT_TITLE, session["id"]))
            db.execute("INSERT INTO chat_sessions(session_id) VALUES (?)", (session["id"],))
            chat = owned_chat(db, user["id"], session["id"])
        return {**chat, "message_count": 0, "messages": []}

    @app.get("/api/chats/{chat_id}")
    def get_chat(chat_id: str, user: AuthenticatedUser):
        with store.connect() as db:
            chat = owned_chat(db, user["id"], chat_id)
            messages = [public_message(row) for row in messages_of(db, chat_id)]
        return {**chat, "message_count": len(messages), "messages": messages}

    @app.patch("/api/chats/{chat_id}")
    def rename_chat(chat_id: str, body: ChatRename, user: AuthenticatedUser):
        with store.connect() as db:
            owned_chat(db, user["id"], chat_id)
            db.execute("UPDATE sessions SET title=? WHERE id=?", (body.title, chat_id))
            return owned_chat(db, user["id"], chat_id)

    @app.delete("/api/chats/{chat_id}", status_code=204)
    def delete_chat(chat_id: str, user: AuthenticatedUser):
        with store.connect() as db:
            owned_chat(db, user["id"], chat_id)
            db.execute("DELETE FROM sessions WHERE id=? AND user_id=?", (chat_id, user["id"]))
        return Response(status_code=204)

    async def resolve_model(user_id: str, body) -> tuple[str, Settings, str | None]:
        provider, provider_settings, model, configuration_id = configurations.resolve(
            user_id,
            SimpleNamespace(configuration_id=body.configuration_id, provider=body.provider),
            enabled,
        )
        if configuration_id.startswith("server:") and not enabled.get(provider):
            raise HTTPException(409, "provider_not_configured")
        if body.model is not None:
            if provider != "openrouter":
                raise HTTPException(422, "model_override_not_supported")
            provider_settings = provider_settings.model_copy(
                update={"openrouter_model": body.model}
            )
            model = body.model
        if provider in external_providers and not body.allow_external:
            raise HTTPException(403, "external_processing_requires_consent")
        if provider == "openrouter" and openrouter_catalogue is not None:
            try:
                # A chat needs a text-in, text-out model, not structured output.
                await openrouter_catalogue.check(model, structured=False)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from None
            except CatalogueUnavailable as exc:
                raise HTTPException(502, exc.code) from None
        return provider, provider_settings, model

    def generate(chat_id, answer_id, target, history) -> AsyncIterator[dict]:
        provider, provider_settings, model = target
        use_demo = provider == "demo" and model_factory is None
        answer = DemoChat() if use_demo else factory(provider, provider_settings, model)
        return answer_events(store, answer, answer_id, provider, model, history)

    def finished(user_id: str, chat_id: str, question_id: str, answer_id: str) -> dict:
        with store.connect() as db:
            rows = {row["id"]: row for row in messages_of(db, chat_id)}
            title = owned_chat(db, user_id, chat_id)["title"]
        return {
            "title": title,
            "message": public_message(rows[question_id]),
            "answer": public_message(rows[answer_id]),
        }

    async def respond(request: Request, user_id, chat_id, question_id, answer_id, target, history):
        """Server-Sent Events when the client asks for them, else one JSON body at the end."""
        if "text/event-stream" not in request.headers.get("accept", ""):
            async for _event in generate(chat_id, answer_id, target, history):
                pass
            return finished(user_id, chat_id, question_id, answer_id)

        async def events():
            with store.connect() as db:
                question = public_message(
                    next(row for row in messages_of(db, chat_id) if row["id"] == question_id)
                )
            yield sse("message", {"message": question, "answer_id": answer_id})
            async for event in generate(chat_id, answer_id, target, history):
                name = event.pop("event")
                yield sse(name, event)
            yield sse("done", finished(user_id, chat_id, question_id, answer_id))

        return StreamingResponse(
            events(), media_type="text/event-stream", headers={"X-Accel-Buffering": "no"}
        )

    @app.post("/api/chats/{chat_id}/messages")
    async def send_message(
        chat_id: str, body: MessageInput, request: Request, user: AuthenticatedUser
    ):
        with store.connect() as db:
            chat = owned_chat(db, user["id"], chat_id)
            if (
                body.analysis_id
                and not db.execute(
                    "SELECT 1 FROM analyses WHERE id=? AND session_id=?",
                    (body.analysis_id, chat_id),
                ).fetchone()
            ):
                raise HTTPException(404, "analysis_not_found")
        target = await resolve_model(user["id"], body)

        question_id, answer_id = str(uuid4()), str(uuid4())
        with store.connect() as db:
            db.execute(
                "INSERT INTO chat_messages(id,session_id,role,content,analysis_id) "
                "VALUES (?,?,'user',?,?)",
                (question_id, chat_id, body.content, body.analysis_id),
            )
            if chat["title"] == NEW_CHAT_TITLE:
                db.execute(
                    "UPDATE sessions SET title=? WHERE id=?", (title_from(body.content), chat_id)
                )
            history = history_for(messages_of(db, chat_id))
            db.execute(
                "INSERT INTO chat_messages(id,session_id,role,content,status) "
                "VALUES (?,?,'assistant','','stopped')",
                (answer_id, chat_id),
            )
        return await respond(request, user["id"], chat_id, question_id, answer_id, target, history)

    @app.post("/api/chats/{chat_id}/messages/{answer_id}/retry")
    async def retry_answer(
        chat_id: str, answer_id: str, body: RetryInput, request: Request, user: AuthenticatedUser
    ):
        """Answer the last question again after a failed or stopped answer."""
        with store.connect() as db:
            owned_chat(db, user["id"], chat_id)
            rows = messages_of(db, chat_id)
        if not rows or rows[-1]["id"] != answer_id or rows[-1]["role"] != "assistant":
            raise HTTPException(409, "not_the_last_answer")
        if rows[-1]["status"] == "complete":
            raise HTTPException(409, "answer_already_complete")
        target = await resolve_model(user["id"], body)
        question_id = rows[-2]["id"]
        with store.connect() as db:
            db.execute(
                "UPDATE chat_messages SET content='',status='stopped',error=NULL WHERE id=?",
                (answer_id,),
            )
        history = history_for(rows[:-1])
        return await respond(request, user["id"], chat_id, question_id, answer_id, target, history)

    @app.get("/api/chat/settings", response_model=ChatSettings)
    def get_chat_settings(user: AuthenticatedUser):
        with store.connect() as db:
            row = db.execute(
                "SELECT auto_analyse FROM chat_settings WHERE user_id=?", (user["id"],)
            ).fetchone()
        return ChatSettings(auto_analyse=bool(row and row["auto_analyse"]))

    @app.put("/api/chat/settings", response_model=ChatSettings)
    def put_chat_settings(body: ChatSettings, user: AuthenticatedUser):
        with store.connect() as db:
            db.execute(
                "INSERT INTO chat_settings(user_id, auto_analyse) VALUES (?, ?) "
                "ON CONFLICT(user_id) DO UPDATE SET auto_analyse=excluded.auto_analyse",
                (user["id"], int(body.auto_analyse)),
            )
        return body
