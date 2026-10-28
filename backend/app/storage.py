"""SQLite persistence. Each operation owns its connection and transaction."""

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4


class Storage:
    def __init__(self, path: str):
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version > 1:
                raise RuntimeError("Database schema is newer than this application")
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
                (identifier, user_id, title, context),
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
                """SELECT a.*, d.candidate_id FROM analyses a
                   JOIN sessions s ON s.id=a.session_id
                   LEFT JOIN decisions d ON d.analysis_id=a.id
                   WHERE s.user_id=? AND s.id=? ORDER BY a.created_at, a.rowid LIMIT ? OFFSET ?""",
                (user_id, session_id, limit, offset),
            ).fetchall()
            return [
                {
                    "request": json.loads(row["request_json"]),
                    "result": json.loads(row["result_json"]),
                    "candidate_id": row["candidate_id"],
                    "created_at": row["created_at"],
                }
                for row in rows
            ]
