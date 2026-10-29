"""SQLite persistence. Each operation owns its connection and transaction."""

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4


def stored_result(result_json: str) -> dict:
    """A stored analysis as returned by the API; fills fields added after it was stored."""
    result = json.loads(result_json)
    # Analyses stored before ADR-009 used the prompt that rubric-2.0 reproduces.
    result.setdefault("rubric_version", "rubric-2.0")
    return result


def history_result(result: dict) -> dict:
    """Retain a validated profile without free text that could reconstruct a task."""
    safe = dict(result)
    safe["profile"] = {
        key: {**value, "evidence": "Evidence is not retained in history."}
        for key, value in result["profile"].items()
        if isinstance(value, dict)
    }
    safe["profile"]["explanation"] = "Only derived profile metadata is retained."
    safe["rationale"] = "Original explanation is not retained in history."
    safe["guidance"] = []
    safe["clarification_questions"] = []
    if "changes" in result:
        # Evidence of a change is task-derived text: returned once, never stored.
        safe["changes"] = [
            {key: change[key] for key in ("dimension", "before", "after")}
            for change in result["changes"]
        ]
    return safe


class Storage:
    def __init__(self, path: str, *, allow_legacy_redaction: bool = False):
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version > 7:
                raise RuntimeError("Database schema is newer than this application")
            if version in {1, 2} and not allow_legacy_redaction:
                records = db.execute("SELECT count(*) FROM sessions").fetchone()[0]
                if records:
                    raise RuntimeError(
                        "Legacy task content requires explicit removal. Review and run: "
                        "uv run python scripts/migrate_privacy.py --remove-legacy-task-content"
                    )
            if version == 0:
                db.executescript("""
                    BEGIN IMMEDIATE;
                    CREATE TABLE IF NOT EXISTS users (
                        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
                        password_hash TEXT NOT NULL,
                        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                    );
                    CREATE TABLE IF NOT EXISTS auth_sessions (
                        token_hash TEXT PRIMARY KEY,
                        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        expires_at INTEGER NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS auth_user ON auth_sessions(user_id);
                    CREATE TABLE IF NOT EXISTS sessions (
                        id TEXT PRIMARY KEY,
                        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        title TEXT NOT NULL,
                        context TEXT NOT NULL DEFAULT '',
                        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                    );
                    CREATE INDEX IF NOT EXISTS session_user ON sessions(user_id, created_at);
                    CREATE TABLE IF NOT EXISTS analyses (
                        id TEXT PRIMARY KEY,
                        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                        request_json TEXT NOT NULL, result_json TEXT NOT NULL,
                        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                    );
                    CREATE INDEX IF NOT EXISTS analysis_session ON analyses(session_id, created_at);
                    CREATE TABLE IF NOT EXISTS decisions (
                        analysis_id TEXT PRIMARY KEY REFERENCES analyses(id) ON DELETE CASCADE,
                        candidate_id TEXT NOT NULL,
                        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                    );
                    PRAGMA user_version=1;
                    COMMIT;
                """)

            if version < 2:
                db.executescript("""
                    BEGIN IMMEDIATE;
                    CREATE TABLE IF NOT EXISTS user_context (
                        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                        content TEXT NOT NULL DEFAULT '',
                        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                    );
                    PRAGMA user_version=2;
                    COMMIT;
                """)

            if version < 3:
                db.execute("PRAGMA secure_delete=ON")
                db.execute("BEGIN IMMEDIATE")
                db.execute(
                    "ALTER TABLE user_context ADD COLUMN save_enabled INTEGER NOT NULL DEFAULT 0"
                )
                db.execute(
                    "ALTER TABLE user_context ADD COLUMN use_enabled INTEGER NOT NULL DEFAULT 0"
                )
                db.execute("""CREATE TABLE memory_entries (
                    analysis_id TEXT PRIMARY KEY REFERENCES analyses(id) ON DELETE CASCADE,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    metadata_json TEXT NOT NULL
                )""")
                db.execute("CREATE INDEX memory_user ON memory_entries(user_id)")
                for row in db.execute("SELECT id,result_json FROM analyses").fetchall():
                    db.execute(
                        "UPDATE analyses SET request_json='{}',result_json=? WHERE id=?",
                        (json.dumps(history_result(json.loads(row["result_json"]))), row["id"]),
                    )
                for row in db.execute("SELECT id FROM sessions").fetchall():
                    db.execute(
                        "UPDATE sessions SET title=?,context='' WHERE id=?",
                        (f"Session {row['id'][:8]}", row["id"]),
                    )
                db.execute("PRAGMA user_version=3")
                db.commit()
                db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            if version < 4:
                db.executescript("""
                    BEGIN IMMEDIATE;
                    CREATE TABLE llm_configs (
                        id TEXT PRIMARY KEY,
                        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        label TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
                        key_ciphertext TEXT,
                        responses_api INTEGER NOT NULL DEFAULT 0,
                        enabled INTEGER NOT NULL DEFAULT 1,
                        is_default INTEGER NOT NULL DEFAULT 0,
                        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                    );
                    CREATE INDEX llm_user ON llm_configs(user_id);
                    CREATE UNIQUE INDEX llm_default ON llm_configs(user_id) WHERE is_default=1;
                    PRAGMA user_version=4;
                    COMMIT;
                """)
            if version < 5:
                db.executescript("""
                    BEGIN IMMEDIATE;
                    CREATE TABLE IF NOT EXISTS coaching_reports (
                        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                        fingerprint TEXT NOT NULL, model TEXT NOT NULL, report_json TEXT NOT NULL,
                        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                    );
                    PRAGMA user_version=5;
                    COMMIT;
                """)
            if version < 6:
                db.executescript("""
                    BEGIN IMMEDIATE;
                    ALTER TABLE user_context ADD COLUMN
                        coaching_auto_enabled INTEGER NOT NULL DEFAULT 0;
                    PRAGMA user_version=6;
                    COMMIT;
                """)
            if version < 7:
                db.executescript("""
                    BEGIN IMMEDIATE;
                    ALTER TABLE user_context ADD COLUMN
                        conversation_memory_enabled INTEGER NOT NULL DEFAULT 0;
                    CREATE TABLE IF NOT EXISTS conversation_content (
                        analysis_id TEXT PRIMARY KEY REFERENCES analyses(id) ON DELETE CASCADE,
                        task TEXT NOT NULL, task_context TEXT NOT NULL,
                        response_json TEXT NOT NULL
                    );
                    ALTER TABLE coaching_reports ADD COLUMN source_json TEXT NOT NULL DEFAULT '{}';
                    PRAGMA user_version=7;
                    COMMIT;
                """)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def create_session(self, user_id: str, title: str, context: str):
        identifier = str(uuid4())
        with self.connect() as db:
            db.execute(
                "INSERT INTO sessions(id,user_id,title,context) VALUES (?,?,?,?)",
                (identifier, user_id, f"Session {identifier[:8]}", ""),
            )
        return self.session(user_id, identifier)

    def session(self, user_id: str, session_id: str):
        with self.connect() as db:
            row = db.execute(
                "SELECT * FROM sessions WHERE id=? AND user_id=?", (session_id, user_id)
            ).fetchone()
            return dict(row) if row else None

    def history(self, user_id: str, session_id: str, limit: int, offset: int):
        with self.connect() as db:
            rows = db.execute(
                """SELECT a.*, d.candidate_id,c.task,c.task_context,c.response_json FROM analyses a
                   JOIN sessions s ON s.id=a.session_id
                   LEFT JOIN decisions d ON d.analysis_id=a.id
                   LEFT JOIN conversation_content c ON c.analysis_id=a.id
                   WHERE s.user_id=? AND s.id=? ORDER BY a.created_at, a.rowid LIMIT ? OFFSET ?""",
                (user_id, session_id, limit, offset),
            ).fetchall()
            return [
                {
                    "request": json.loads(row["request_json"]),
                    "result": stored_result(row["result_json"]),
                    "candidate_id": row["candidate_id"],
                    "created_at": row["created_at"],
                    "conversation": None
                    if row["task"] is None
                    else {
                        "task": row["task"],
                        "task_context": row["task_context"],
                        "response": stored_result(row["response_json"]),
                    },
                }
                for row in rows
            ]

    def conversation_samples(self, user_id: str):
        """Bounded excerpts, only while both explicit text consent and memory use are on."""
        with self.connect() as db:
            rows = db.execute(
                """SELECT c.task,c.task_context,c.response_json FROM conversation_content c
                   JOIN analyses a ON a.id=c.analysis_id JOIN sessions s ON s.id=a.session_id
                   JOIN user_context u ON u.user_id=s.user_id
                   WHERE s.user_id=? AND u.conversation_memory_enabled=1 AND u.use_enabled=1
                   ORDER BY a.created_at DESC,a.rowid DESC LIMIT 5""",
                (user_id,),
            ).fetchall()
        return [
            {
                "task": row["task"][:3000],
                "task_context": row["task_context"][:500],
                "response_excerpt": json.dumps(json.loads(row["response_json"]).get("profile", {}))[
                    :1000
                ],
            }
            for row in rows
        ]
