"""Relay: a user's own model, run by the user's own client (ADR-015).

A backend on a server cannot reach a model on the user's machine (the server's ``localhost`` is
the server), but the user's VS Code extension can reach the backend. So the direction is reversed:
the extension keeps a request open (``GET /api/relay/next``) and, when the backend needs the
user's model, the request goes down that connection; the extension calls LM Studio on
``localhost`` and sends the answer back (``POST /api/relay/jobs/{id}/events``).

The backend builds its model with the OpenAI client, so the relay is an HTTP *transport* for it
(``RelayTransport``): the request that would have gone to LM Studio goes to the user's client
instead, and the response (streamed or not) comes back the same way. Prompts, structured output,
validation, recommendation and storage are unchanged.

Rules that keep it safe:

* A job is queued only for the account that made the request, and only that account's client (its
  own session or token) can take it or answer it. Another user's client cannot be reached.
* Without a client connected, a request fails at once with ``relay_unavailable``.
* Only ``POST /v1/chat/completions`` is relayed, with a JSON body; the client enforces the same.
* Sizes, jobs in flight and waiting time are limited, and a client that vanishes ends its jobs.
* The state is in memory: it is for one backend instance (the Free plan has one). More instances
  would need the queue in the database.
"""

import asyncio
import base64
import binascii
import time
from collections import deque
from uuid import uuid4

import httpx
from fastapi import APIRouter, FastAPI, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from app.accounts import AuthenticatedUser

ALLOWED_PATH = "/v1/chat/completions"
MAX_REQUEST_BYTES = 1_000_000
MAX_CHUNK_BYTES = 256_000
MAX_RESPONSE_BYTES = 4_000_000
MAX_JOBS_PER_USER = 4
# A client is "connected" while a request of its is open, and this long after the last one ended
# (between two requests it asks again at once).
CLIENT_GRACE_SECONDS = 6.0
# A request is given to a client; if it does not confirm within ACK_SECONDS (it hung up, or the
# request reached a dead connection) the request goes back in the queue, and after
# PICKUP_SECONDS in all it fails with ``relay_unavailable``.
ACK_SECONDS = 5.0
PICKUP_SECONDS = 15.0
LONG_POLL_SECONDS = 10.0


class RelayError(Exception):
    """The relay could not serve a request; ``code`` is the application's error code."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class Job:
    def __init__(self, user_id: str, request: dict):
        self.id = str(uuid4())
        self.user_id = user_id
        self.request = request
        self.events: asyncio.Queue = asyncio.Queue()
        try:
            self._loop = asyncio.get_running_loop()
        except RuntimeError:
            self._loop = None
        self.picked = False
        self.picked_at = 0.0
        self.acked = False
        self.attempts = 0
        self.finished = False
        self.received = 0

    def push(self, event: dict) -> None:
        if self.finished:
            return
        if self._loop is not None and self._loop.is_running():
            # The waiter lives in this loop; the answer may arrive from another thread.
            self._loop.call_soon_threadsafe(self.events.put_nowait, event)
        else:
            self.events.put_nowait(event)


class Broker:
    def __init__(self):
        self._seen: dict[str, float] = {}
        self._polls: dict[str, int] = {}
        self._pending: dict[str, deque] = {}
        self._wakeup: dict[str, tuple[asyncio.Event, asyncio.AbstractEventLoop]] = {}
        self._jobs: dict[str, Job] = {}

    # -- the client side ---------------------------------------------------------------------

    def connected(self, user_id: str) -> bool:
        if self._polls.get(user_id):
            return True
        seen = self._seen.get(user_id)
        return seen is not None and time.monotonic() - seen < CLIENT_GRACE_SECONDS

    async def next_job(self, user_id: str, wait: float, disconnected=None) -> Job | None:
        """The oldest waiting job of this user, waiting up to ``wait`` seconds for one.

        ``disconnected`` is an async callable that says whether the client hung up: a request that
        was hung up on must not be given a job, because nobody would run it.
        """
        deadline = time.monotonic() + wait
        self._polls[user_id] = self._polls.get(user_id, 0) + 1
        try:
            while True:
                self._seen[user_id] = time.monotonic()
                if disconnected is not None and await disconnected():
                    return None
                queue = self._pending.get(user_id)
                while queue:
                    job = queue.popleft()
                    if not job.finished:
                        job.picked = True
                        job.picked_at = time.monotonic()
                        job.attempts += 1
                        return job
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                event, _ = self._wakeup.setdefault(
                    user_id, (asyncio.Event(), asyncio.get_running_loop())
                )
                event.clear()
                try:
                    await asyncio.wait_for(event.wait(), timeout=min(remaining, 1.0))
                except TimeoutError:
                    pass
        finally:
            self._polls[user_id] -= 1

    def answer(self, user_id: str, job_id: str, events: list[dict]) -> None:
        job = self._jobs.get(job_id)
        if job is None or job.user_id != user_id:
            # The same answer for a job that does not exist and for someone else's.
            raise HTTPException(404, "relay_job_not_found")
        self._seen[user_id] = time.monotonic()
        job.acked = True
        for event in events:
            if event["type"] == "ack":
                continue
            if event["type"] == "chunk":
                job.received += len(event["data"])
                if job.received > MAX_RESPONSE_BYTES:
                    job.push({"type": "error", "code": "relay_response_too_large"})
                    job.finished = True
                    return
            job.push(event)
            if event["type"] in {"end", "error"}:
                job.finished = True
                return

    # -- the backend side --------------------------------------------------------------------

    def submit(self, user_id: str, request: dict) -> Job:
        if not self.connected(user_id):
            raise RelayError("relay_unavailable")
        live = [job for job in self._jobs.values() if job.user_id == user_id and not job.finished]
        if len(live) >= MAX_JOBS_PER_USER:
            raise RelayError("relay_busy")
        job = Job(user_id, request)
        self._jobs[job.id] = job
        self._pending.setdefault(user_id, deque()).append(job)
        waiting = self._wakeup.get(user_id)
        if waiting:
            try:
                waiting[1].call_soon_threadsafe(waiting[0].set)
            except RuntimeError:  # that loop is gone; the client polls again within seconds
                self._wakeup.pop(user_id, None)
        return job

    def requeue(self, job: Job) -> None:
        """Gives a request nobody confirmed back to the queue, first in line."""
        job.picked = False
        self._pending.setdefault(job.user_id, deque()).appendleft(job)
        waiting = self._wakeup.get(job.user_id)
        if waiting:
            try:
                waiting[1].call_soon_threadsafe(waiting[0].set)
            except RuntimeError:
                self._wakeup.pop(job.user_id, None)

    async def wait_for_start(self, job: Job, first_byte: float) -> dict:
        """Waits until a client has taken the request and begun to answer it."""
        deadline = time.monotonic() + PICKUP_SECONDS
        while not job.acked:
            now = time.monotonic()
            if job.picked and now - job.picked_at > ACK_SECONDS:
                if job.attempts >= 3:
                    raise RelayError("relay_unavailable")
                self.requeue(job)
            if now > deadline:
                raise RelayError("relay_unavailable")
            await asyncio.sleep(0.05)
        try:
            event = await asyncio.wait_for(job.events.get(), timeout=first_byte)
        except TimeoutError:
            raise RelayError("relay_timeout") from None
        if event["type"] == "error":
            raise RelayError(event["code"])
        if event["type"] != "start":
            raise RelayError("relay_bad_response")
        return event

    def release(self, job: Job) -> None:
        job.finished = True
        self._jobs.pop(job.id, None)

    def reset(self) -> None:
        self.__init__()


BROKER = Broker()


class RelayStream(httpx.AsyncByteStream):
    def __init__(self, broker: Broker, job: Job, first_byte_seconds: float):
        self.broker, self.job = broker, job
        self.first_byte_seconds = first_byte_seconds

    async def __aiter__(self):
        try:
            while True:
                try:
                    event = await asyncio.wait_for(
                        self.job.events.get(), timeout=self.first_byte_seconds
                    )
                except TimeoutError:
                    raise RelayError("relay_timeout") from None
                if event["type"] == "chunk":
                    yield event["data"]
                elif event["type"] == "end":
                    return
                elif event["type"] == "error":
                    raise RelayError(event["code"])
        finally:
            self.broker.release(self.job)

    async def aclose(self):
        self.broker.release(self.job)


class RelayTransport(httpx.AsyncBaseTransport):
    """The OpenAI client's connection to "LM Studio": it goes through the user's client instead."""

    def __init__(self, user_id: str, broker: Broker | None = None):
        self.user_id = user_id
        self.broker = broker or BROKER

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if request.method != "POST" or request.url.path != ALLOWED_PATH:
            raise RelayError("relay_path_not_allowed")
        body = await request.aread()
        if len(body) > MAX_REQUEST_BYTES:
            raise RelayError("relay_request_too_large")
        timeouts = request.extensions.get("timeout") or {}
        first_byte = float(timeouts.get("read") or 120)
        job = self.broker.submit(
            self.user_id,
            {
                "method": "POST",
                "path": ALLOWED_PATH,
                "content_type": request.headers.get("content-type", "application/json"),
                "body": base64.b64encode(body).decode(),
            },
        )
        try:
            start = await self.broker.wait_for_start(job, first_byte)
        except BaseException:
            self.broker.release(job)
            raise
        headers = {"content-type": start.get("content_type") or "application/json"}
        return httpx.Response(
            start["status"],
            headers=headers,
            stream=RelayStream(self.broker, job, first_byte),
        )


def relay_client(user_id: str, timeout_seconds: float) -> httpx.AsyncClient:
    """An HTTP client whose every request goes through ``user_id``'s own client."""
    return httpx.AsyncClient(
        transport=RelayTransport(user_id),
        timeout=httpx.Timeout(timeout_seconds, connect=timeout_seconds),
    )


# -- the HTTP routes ---------------------------------------------------------------------------


class RelayEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: str = Field(pattern=r"^(ack|start|chunk|end|error)$")
    status: int | None = Field(default=None, ge=100, le=599)
    content_type: str | None = Field(default=None, max_length=200)
    data: str | None = Field(default=None, max_length=int(MAX_CHUNK_BYTES * 1.4))
    code: str | None = Field(default=None, max_length=60, pattern=r"^[a-z_]+$")


class RelayEvents(BaseModel):
    model_config = ConfigDict(extra="forbid")
    events: list[RelayEvent] = Field(min_length=1, max_length=64)


def install_relay(app: FastAPI) -> None:
    router = APIRouter(prefix="/api/relay", tags=["relay"])
    app.state.relay = BROKER

    @router.get("/status")
    def status(user: AuthenticatedUser, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return {"connected": BROKER.connected(user["id"])}

    @router.get("/next")
    async def next_request(
        request: Request,
        user: AuthenticatedUser,
        response: Response,
        wait: float = Query(default=LONG_POLL_SECONDS, ge=0, le=LONG_POLL_SECONDS),
    ):
        response.headers["Cache-Control"] = "no-store"
        job = await BROKER.next_job(user["id"], wait, request.is_disconnected)
        if job is None:
            response.status_code = 204
            return None
        return {"id": job.id, **job.request}

    @router.post("/jobs/{job_id}/events")
    async def events(job_id: str, body: RelayEvents, user: AuthenticatedUser, response: Response):
        response.headers["Cache-Control"] = "no-store"
        decoded = []
        for item in body.events:
            if item.type == "start":
                if item.status is None:
                    raise HTTPException(422, "relay_bad_event")
                decoded.append(
                    {"type": "start", "status": item.status, "content_type": item.content_type}
                )
            elif item.type == "chunk":
                try:
                    data = base64.b64decode(item.data or "", validate=True)
                except (binascii.Error, ValueError):
                    raise HTTPException(422, "relay_bad_event") from None
                if len(data) > MAX_CHUNK_BYTES:
                    raise HTTPException(413, "relay_chunk_too_large")
                decoded.append({"type": "chunk", "data": data})
            elif item.type == "error":
                decoded.append({"type": "error", "code": item.code or "relay_client_error"})
            elif item.type == "ack":
                decoded.append({"type": "ack"})
            else:
                decoded.append({"type": "end"})
        BROKER.answer(user["id"], job_id, decoded)
        return {"status": "ok"}

    app.include_router(router)
