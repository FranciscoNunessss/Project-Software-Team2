"""PostgreSQL persistence. Connections own a transaction; SQLite is import-only."""

import hashlib
import json
import re
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

import psycopg
from psycopg import sql


class Record(tuple):
    """Rows support both named fields and positional access used by existing contracts."""

    def __new__(cls, names, values):
        row = super().__new__(cls, values)
        row._names = names
        return row

    def keys(self):
        return self._names

    def __getitem__(self, key):
        return super().__getitem__(self._names.index(key) if isinstance(key, str) else key)


def record_row(cursor):
    names = tuple(column.name for column in cursor.description) if cursor.description else ()
    return lambda values: Record(names, values)


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
    safe["tips"] = []
    return safe


class Storage:
    def __init__(self, database_url: str, schema: str = "adaptai"):
        if not database_url.startswith(("postgresql://", "postgres://")):
            raise ValueError("ADAPTAI_DATABASE_URL must be a PostgreSQL connection URL")
        if (
            not re.fullmatch(r"[a-z][a-z0-9_]{0,62}", schema)
            or schema == "public"
            or schema.startswith("pg_")
        ):
            raise ValueError("Use a dedicated PostgreSQL schema, for example adaptai")
        self._database_url = database_url
        self.schema = schema
        self.migrate()

    @contextmanager
    def connect(self, *, user_id: str | None = None):
        # Disabling prepared statements also supports Supabase's transaction pooler.
        # SET LOCAL scopes search_path to this transaction, including through a pooler.
        with psycopg.connect(
            self._database_url,
            row_factory=record_row,
            connect_timeout=10,
            prepare_threshold=None,
        ) as db:
            db.execute(sql.SQL("SET LOCAL search_path TO {} ").format(sql.Identifier(self.schema)))
            db.execute("SET LOCAL lock_timeout = '15s'")
            if user_id is not None:
                self.lock_user(db, user_id)
            yield db

    def lock_user(self, db, user_id: str):
        # Transaction-scoped and shared between processes, unlike a Python lock.
        db.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
            (f"{self.schema}:user:{user_id}",),
        )

    def _lock_schema(self, db):
        db.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (f"{self.schema}:schema",)
        )

    def migrate(self):
        with self.connect() as db:
            self._lock_schema(db)
            db.execute(
                sql.SQL("CREATE SCHEMA IF NOT EXISTS {}").format(sql.Identifier(self.schema))
            )
            db.execute("""CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY, checksum TEXT NOT NULL,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())""")
            applied = {
                row["version"]: row["checksum"]
                for row in db.execute("SELECT version,checksum FROM schema_migrations")
            }
            migrations = sorted((Path(__file__).parent.parent / "migrations").glob("*.sql"))
            known = {int(path.name.split("_", 1)[0]) for path in migrations}
            if set(applied) - known:
                raise RuntimeError("Database schema is newer than this application")
            for path in migrations:
                version = int(path.name.split("_", 1)[0])
                contents = path.read_bytes()
                checksum = hashlib.sha256(contents).hexdigest()
                if version in applied:
                    if applied[version] != checksum:
                        raise RuntimeError(f"Applied database migration {version} was modified")
                    continue
                db.execute(contents.decode("utf-8"))
                db.execute(
                    "INSERT INTO schema_migrations(version,checksum) VALUES (%s,%s)",
                    (version, checksum),
                )

    def install_module(self, statements):
        with self.connect() as db:
            self._lock_schema(db)
            for statement in statements:
                db.execute(statement)

    def table_names(self):
        with self.connect() as db:
            return [
                row[0]
                for row in db.execute(
                    "SELECT tablename FROM pg_tables WHERE schemaname=%s ORDER BY tablename",
                    (self.schema,),
                )
            ]

    def create_session(self, user_id: str, title: str, context: str):
        identifier = str(uuid4())
        with self.connect() as db:
            db.execute(
                "INSERT INTO sessions(id,user_id,title,context) VALUES (%s,%s,%s,%s)",
                (identifier, user_id, f"Session {identifier[:8]}", ""),
            )
        return self.session(user_id, identifier)

    def session(self, user_id: str, session_id: str):
        with self.connect() as db:
            row = db.execute(
                "SELECT id,user_id,title,context,created_at FROM sessions "
                "WHERE id=%s AND user_id=%s",
                (session_id, user_id),
            ).fetchone()
            return dict(row) if row else None

    def history(self, user_id: str, session_id: str, limit: int, offset: int):
        with self.connect() as db:
            rows = db.execute(
                """SELECT a.*, d.candidate_id,c.task,c.task_context,c.response_json FROM analyses a
                   JOIN sessions s ON s.id=a.session_id
                   LEFT JOIN decisions d ON d.analysis_id=a.id
                   LEFT JOIN conversation_content c ON c.analysis_id=a.id
                   WHERE s.user_id=%s AND s.id=%s
                   ORDER BY a.created_at, a.sequence_id LIMIT %s OFFSET %s""",
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
                   WHERE s.user_id=%s AND u.conversation_memory_enabled=1 AND u.use_enabled=1
                   ORDER BY a.created_at DESC,a.sequence_id DESC LIMIT 5""",
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


@contextmanager
def temporary_database(settings):
    """A schema owned exclusively by an explicit smoke-test tool; never application history."""
    schema = "smoke_" + uuid4().hex
    temporary = settings.model_copy(update={"database_schema": schema})
    try:
        yield temporary
    finally:
        with psycopg.connect(settings.database_url.get_secret_value(), autocommit=True) as db:
            db.execute(sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(sql.Identifier(schema)))
