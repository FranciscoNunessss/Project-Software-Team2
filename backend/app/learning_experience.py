"""WS4 experience: Educator hints (L5), weekly goal (L9), disputes (L11), achievements (L13),
pause and start over (L17). Scores, codes, counts and flags only: never task text.

Everything here reads the engine's input (``learning.dated_tasks``) or its output; the only
language-model call is the restricted dispute judge, injected by ``main`` so tests and the
demonstration provider need no model.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import secrets
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app.accounts import AuthenticatedUser
from app.learning import dated_tasks, reset_at
from app.learning_engine import DIMENSIONS, TaskRecord, compute, level_history
from app.outcomes import owned_analysis
from app.request_quality import guard_ceiling, reason_code
from app.storage import Storage

LOGGER = logging.getLogger(__name__)

# ---- request hash for disputes (L11) ---------------------------------------------------------

DISPUTE_WINDOW = timedelta(hours=24)
FINGERPRINT_SWEEP_SECONDS = 3600
DISPUTES_PER_DAY = 5
MIN_PASSAGE_CHARS = 3


def task_fingerprint(task: str) -> tuple[str, str]:
    """(salt, hash) of the request: proves a passage came from it without storing it."""
    salt = secrets.token_hex(16)
    return salt, hmac.new(bytes.fromhex(salt), task.encode(), hashlib.sha256).hexdigest()


def expire_fingerprints(db) -> None:
    """Forget the request fingerprints once the dispute window has closed (salt and hash
    together would let someone with database access test guesses of a request)."""
    limit = (datetime.now(UTC) - DISPUTE_WINDOW).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    db.execute(
        "UPDATE request_quality SET task_salt=NULL,task_hash=NULL "
        "WHERE task_hash IS NOT NULL AND created_at<%s",
        (limit,),
    )


def sweep_fingerprints(store: Storage) -> None:
    with store.connect() as db:
        expire_fingerprints(db)


def same_task(task: str, salt: str, digest: str) -> bool:
    expected = hmac.new(bytes.fromhex(salt), task.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, digest)


# A judge returns the level (0, 1 or 2) the passage alone supports for one dimension:
# judge(user_id, stored analysis result, dimension, request, passage, allow_external).
Judge = Callable[[str, dict, str, str, str, bool], Awaitable[int]]


class DisputeInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dimension: str = Field(pattern="^(" + "|".join(DIMENSIONS) + ")$")
    # The request as the user analysed it (still in their browser) and the passage they point
    # to. Neither is stored: the request is only compared with its hash.
    task: str = Field(min_length=1, max_length=20000)
    passage: str = Field(min_length=MIN_PASSAGE_CHARS, max_length=1000)
    allow_external: bool = False


# ---- weekly goal (L9) ------------------------------------------------------------------------

GOAL_TARGET = 3
GOALS = (
    *(f"state_{name}" for name in DIMENSIONS),
    "follow_recommendation",
    "one_model_per_chat",
)


def week_of(moment: datetime) -> str:
    year, week, _ = moment.isocalendar()
    return f"{year}-W{week:02d}"


def goal_met_by(code: str, task: TaskRecord) -> bool:
    if code.startswith("state_"):
        name = code.removeprefix("state_")
        return bool(task.scores) and task.scores.get(name) == 2
    if code == "follow_recommendation":
        return task.sizing == "match"
    if code == "one_model_per_chat":
        return task.switched_model is False
    return False


def suggested_goals(tasks: list[TaskRecord]) -> list[str]:
    """The strongest 'to improve' pattern first, then the weakest dimensions; at most 3."""
    indicators = compute(tasks)
    picks: list[str] = []
    for pattern in sorted(indicators.patterns, key=lambda p: -p.hits / max(p.window, 1)):
        if pattern.kind != "improve":
            continue
        code = {
            "missing_dimension": f"state_{pattern.dimension}",
            "over_sizing": "follow_recommendation",
            "under_sizing": "follow_recommendation",
            "model_switching": "one_model_per_chat",
        }.get(pattern.code)
        if code and code not in picks:
            picks.append(code)
    weakest = sorted(
        (item.level, name)
        for name, item in indicators.dimensions.items()
        if item.level is not None and item.level < 4
    )
    for _, name in weakest:
        if f"state_{name}" not in picks:
            picks.append(f"state_{name}")
    for code in ("follow_recommendation", "one_model_per_chat"):
        if code not in picks:
            picks.append(code)
    return picks[:3]


# ---- achievements (L13): quality only, never volume ------------------------------------------

STREAK = 3
RIGHT_MODEL = 5


def achievements(tasks: list[TaskRecord]) -> list[dict]:
    """Every achievement depends on how well something was done, not on how much was used."""
    items = []
    for name in DIMENSIONS:
        scores = [t.scores[name] for t in tasks if t.scores and t.scores.get(name) is not None]
        best, run = 0, 0
        for score in scores:
            run = run + 1 if score == 2 else 0
            best = max(best, run)
        items.append(
            {
                "code": "clear_dimension",
                "dimension": name,
                "unlocked": best >= STREAK,
                "progress": min(best, STREAK),
                "target": STREAK,
            }
        )
        history = [level for level in level_history(scores) if level is not None]
        reached = max(history, default=0)
        items.append(
            {
                "code": "proficient_dimension",
                "dimension": name,
                "unlocked": reached >= 3,
                "progress": min(reached, 3),
                "target": 3,
            }
        )
    good = sum(t.sizing == "match" and t.outcome == "yes" for t in tasks)
    items.append(
        {
            "code": "right_model",
            "dimension": None,
            "unlocked": good >= RIGHT_MODEL,
            "progress": min(good, RIGHT_MODEL),
            "target": RIGHT_MODEL,
        }
    )
    return items


# ---- Educator hint (L5) ----------------------------------------------------------------------

HINT_PAUSE = 3


def educator_hint(store: Storage, user_id: str, scores: dict[str, int | None]) -> dict | None:
    """One hint for the task being analysed: an active 'missing dimension' pattern that this
    request repeats (scored 0 now), unless the user dismissed a hint in the last 3 analyses."""
    # Paused learning means "not now" for the Educator too, not only "do not count".
    if learning_settings(store, user_id)["paused"]:
        return None
    tasks = [task for _, task in counted_tasks(store, user_id)]
    patterns = [p for p in compute(tasks).patterns if p.code == "missing_dimension"]
    candidates = [p for p in patterns if scores.get(p.dimension) == 0]
    if not candidates:
        return None
    with store.connect() as db:
        analyses = db.execute(
            "SELECT count(*) AS n FROM analyses a JOIN sessions s ON s.id=a.session_id "
            "WHERE s.user_id=%s",
            (user_id,),
        ).fetchone()["n"]
        dismissed = {
            row["hint_key"]: row["analyses_at"]
            for row in db.execute(
                "SELECT hint_key,analyses_at FROM learning_hint_dismissals WHERE user_id=%s",
                (user_id,),
            ).fetchall()
        }
    # "Not now" pauses every hint for the next HINT_PAUSE analyses, not only the one dismissed:
    # another hint straight away would read as nagging (G2 WS4 3.3).
    if any(analyses - at < HINT_PAUSE for at in dismissed.values()):
        return None
    pattern = max(candidates, key=lambda p: p.hits)
    return {
        "key": f"missing_{pattern.dimension}",
        "pattern": "missing_dimension",
        "dimension": pattern.dimension,
        "hits": pattern.hits,
        "window": pattern.window,
    }


# ---- pause and start over (L17) --------------------------------------------------------------


def learning_settings(store: Storage, user_id: str) -> dict:
    with store.connect() as db:
        row = db.execute(
            "SELECT paused,reset_at FROM learning_settings WHERE user_id=%s", (user_id,)
        ).fetchone()
    return {
        "paused": bool(row and row["paused"]),
        "reset_at": row["reset_at"] if row else None,
        # Team Scope (WS3 T1) will let an organisation admin turn these off; until then the
        # user always may.
        "can_pause": True,
        "can_reset": True,
    }


def counted_tasks(store: Storage, user_id: str) -> list[tuple[str, TaskRecord]]:
    """Tasks that count for learning: not excluded or paused, and after the last start over."""
    since = reset_at(store, user_id)
    return [
        (at, task)
        for at, task in dated_tasks(store, user_id)
        if not task.excluded and not task.paused and (since is None or at > since)
    ]


class GoalChoice(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str = Field(pattern="^(" + "|".join(GOALS) + ")$")


class SettingsInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    paused: bool


def install_learning_experience(app: FastAPI, store: Storage, judge: Judge) -> None:
    @app.on_event("startup")
    async def start_fingerprint_expiry():
        # The fingerprints must go after 24 hours even for someone who never comes back, so
        # expiry cannot wait for the next analysis or dispute: sweep every hour.
        async def loop():
            while True:
                try:
                    await asyncio.to_thread(sweep_fingerprints, store)
                except Exception:  # noqa: BLE001 - the sweep must never take the app down
                    LOGGER.exception("Fingerprint expiry failed; retrying in an hour")
                await asyncio.sleep(FINGERPRINT_SWEEP_SECONDS)

        app.state.fingerprint_task = asyncio.create_task(loop())

    @app.on_event("shutdown")
    async def stop_fingerprint_expiry():
        task = getattr(app.state, "fingerprint_task", None)
        if task:
            task.cancel()

    @app.get("/api/progress/goal")
    def goal(user: AuthenticatedUser):
        now = datetime.now(UTC)
        week = week_of(now)
        dated = counted_tasks(store, user["id"])
        tasks = [task for _, task in dated]
        suggestions = suggested_goals(tasks)
        with store.connect() as db:
            row = db.execute(
                "SELECT code,target,set_at FROM learning_goals WHERE user_id=%s AND week=%s",
                (user["id"], week),
            ).fetchone()
        if row:
            code, target, since, chosen = row["code"], row["target"], row["set_at"], True
        else:
            monday = (now - timedelta(days=now.weekday())).strftime("%Y-%m-%dT00:00:00")
            code, target, since, chosen = suggestions[0], GOAL_TARGET, monday, False
        progress = sum(goal_met_by(code, task) for at, task in dated if at >= since)
        return {
            "week": week,
            "goal": {
                "code": code,
                "target": target,
                "progress": min(progress, target),
                "met": progress >= target,
                "chosen": chosen,
            },
            "alternatives": [item for item in suggestions if item != code][:2],
        }

    @app.put("/api/progress/goal")
    def choose_goal(body: GoalChoice, user: AuthenticatedUser):
        week = week_of(datetime.now(UTC))
        with store.connect() as db:
            db.execute(
                """INSERT INTO learning_goals(user_id,week,code,target) VALUES (%s,%s,%s,%s)
                   ON CONFLICT (user_id,week) DO UPDATE SET code=EXCLUDED.code,
                   set_at=CASE WHEN learning_goals.code=EXCLUDED.code
                               THEN learning_goals.set_at
                               ELSE to_char(clock_timestamp() AT TIME ZONE 'UTC',
                                            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END""",
                (user["id"], week, body.code, GOAL_TARGET),
            )
        return goal(user)

    @app.get("/api/progress/achievements")
    def list_achievements(user: AuthenticatedUser):
        return {"achievements": achievements([t for _, t in counted_tasks(store, user["id"])])}

    @app.post("/api/learning/hints/{key}/dismiss")
    def dismiss_hint(key: str, user: AuthenticatedUser):
        if key not in {f"missing_{name}" for name in DIMENSIONS}:
            raise HTTPException(404, "hint_not_found")
        with store.connect() as db:
            analyses = db.execute(
                "SELECT count(*) AS n FROM analyses a JOIN sessions s ON s.id=a.session_id "
                "WHERE s.user_id=%s",
                (user["id"],),
            ).fetchone()["n"]
            db.execute(
                """INSERT INTO learning_hint_dismissals(user_id,hint_key,analyses_at)
                   VALUES (%s,%s,%s) ON CONFLICT (user_id,hint_key)
                   DO UPDATE SET analyses_at=EXCLUDED.analyses_at""",
                (user["id"], key, analyses),
            )
        return {"dismissed": key}

    @app.get("/api/learning/settings")
    def get_settings(user: AuthenticatedUser):
        return learning_settings(store, user["id"])

    @app.put("/api/learning/settings")
    def put_settings(body: SettingsInput, user: AuthenticatedUser):
        if not learning_settings(store, user["id"])["can_pause"]:
            raise HTTPException(403, "pause_not_allowed")
        with store.connect() as db:
            db.execute(
                """INSERT INTO learning_settings(user_id,paused) VALUES (%s,%s)
                   ON CONFLICT (user_id) DO UPDATE SET paused=EXCLUDED.paused""",
                (user["id"], int(body.paused)),
            )
        return learning_settings(store, user["id"])

    @app.post("/api/learning/reset")
    def start_over(user: AuthenticatedUser):
        """Deletes the learning data (scores, disputes, exclusions, goals, hints). Feedback
        stays (ADR-014: it calibrates the catalogue) but no task before now counts."""
        if not learning_settings(store, user["id"])["can_reset"]:
            raise HTTPException(403, "reset_not_allowed")
        with store.connect() as db:
            for table in (
                "request_quality",
                "quality_disputes",
                "learning_exclusions",
                "learning_goals",
                "learning_hint_dismissals",
            ):
                db.execute(f"DELETE FROM {table} WHERE user_id=%s", (user["id"],))
            db.execute(
                """INSERT INTO learning_settings(user_id,reset_at)
                   VALUES (%s,to_char(clock_timestamp() AT TIME ZONE 'UTC',
                                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
                   ON CONFLICT (user_id) DO UPDATE SET reset_at=EXCLUDED.reset_at""",
                (user["id"],),
            )
        return learning_settings(store, user["id"])

    @app.post("/api/analyses/{analysis_id}/quality-dispute")
    async def dispute(analysis_id: str, body: DisputeInput, user: AuthenticatedUser):
        dimension = body.dimension
        with store.connect() as db:
            analysis = owned_analysis(db, user["id"], analysis_id)
            expire_fingerprints(db)
            row = db.execute(
                "SELECT * FROM request_quality WHERE analysis_id=%s", (analysis_id,)
            ).fetchone()
            if not row:
                raise HTTPException(404, "quality_not_found")
            if not row["task_hash"] or datetime.fromisoformat(
                row["created_at"].replace("Z", "+00:00")
            ) < (datetime.now(UTC) - DISPUTE_WINDOW):
                raise HTTPException(409, "dispute_window_closed")
            if db.execute(
                "SELECT 1 FROM quality_disputes WHERE analysis_id=%s AND dimension=%s",
                (analysis_id, dimension),
            ).fetchone():
                raise HTTPException(409, "already_disputed")
            today = datetime.now(UTC).strftime("%Y-%m-%dT00:00:00")
            used = db.execute(
                "SELECT count(*) AS n FROM quality_disputes WHERE user_id=%s AND created_at>=%s",
                (user["id"], today),
            ).fetchone()["n"]
        if used >= DISPUTES_PER_DAY:
            raise HTTPException(429, "dispute_limit_reached")
        before = row[dimension]
        if before is None or before >= 2:
            raise HTTPException(409, "nothing_to_dispute")
        # Checked in code, before any model call: the request is the one analysed and the
        # passage is really in it. No free-text justification exists.
        if not same_task(body.task, row["task_salt"], row["task_hash"]):
            raise HTTPException(409, "task_changed")
        if body.passage.strip() not in body.task:
            raise HTTPException(422, "passage_not_in_task")
        if before >= guard_ceiling(dimension, body.task):
            # The guards already hold this score: no passage can raise it, so no model call.
            raise HTTPException(409, "dispute_capped")
        result = json.loads(analysis["result_json"])
        judged = await judge(
            user["id"], result, dimension, body.task, body.passage.strip(), body.allow_external
        )
        # One level at most, and never above what the guards of L1 allow for this request.
        after = max(before, min(before + 1, judged, guard_ceiling(dimension, body.task)))
        accepted = after > before
        with store.connect() as db:
            # The judge call runs outside any transaction, so two disputes sent together both
            # pass the checks above. Check again under the user's lock before writing: the
            # second one gets 409 or 429, never a 500 or a sixth dispute that day.
            store.lock_user(db, user["id"])
            if db.execute(
                "SELECT 1 FROM quality_disputes WHERE analysis_id=%s AND dimension=%s",
                (analysis_id, dimension),
            ).fetchone():
                raise HTTPException(409, "already_disputed")
            if (
                db.execute(
                    "SELECT count(*) AS n FROM quality_disputes "
                    "WHERE user_id=%s AND created_at>=%s",
                    (user["id"], today),
                ).fetchone()["n"]
                >= DISPUTES_PER_DAY
            ):
                raise HTTPException(429, "dispute_limit_reached")
            if accepted:
                codes = json.loads(row["reason_codes"])
                codes[dimension] = reason_code(dimension, after)
                db.execute(
                    f"UPDATE request_quality SET {dimension}=%s,reason_codes=%s "
                    "WHERE analysis_id=%s",
                    (after, json.dumps(codes), analysis_id),
                )
            db.execute(
                """INSERT INTO quality_disputes(analysis_id,user_id,dimension,accepted,
                   score_before,score_after) VALUES (%s,%s,%s,%s,%s,%s)""",
                (analysis_id, user["id"], dimension, int(accepted), before, after),
            )
        return {
            "dimension": dimension,
            "accepted": accepted,
            "score_before": before,
            "score_after": after,
            "code": reason_code(dimension, after),
        }


# ---- the judge prompt (restricted: one dimension, the passage is data) ------------------------


class JudgeVerdict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    level: int = Field(ge=0, le=2)


# The judge prompt is a versioned, immutable file like the rubric (ADR-009): any change is a
# new file and a new evaluation (scripts/run_dispute_eval.py). A test pins its sha256.
JUDGE_VERSION = "dispute-judge-1"
JUDGE_FILE = Path(__file__).parent.parent / "rubric" / "judge" / f"{JUDGE_VERSION}.txt"
JUDGE_SHA256 = "ac3c75a7d5b4b534792d0c10fb863f971fb1e252d05a67b65cbd57a2f3d37506"


def judge_prompt(dimension: str, definition: str) -> str:
    text = JUDGE_FILE.read_text(encoding="utf-8")
    return text.replace("{dimension}", dimension).replace("{definition}", definition)
