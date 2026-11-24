"""PostgreSQL persistence. Connections own a transaction; SQLite is import-only."""

import hashlib
import json
import logging
import re
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg_pool import ConnectionPool

log = logging.getLogger(__name__)


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
        if isinstance(value, dict) and key != "request_quality"
    }
    if result["profile"].get("request_quality"):
        # WS4 L1: the reasons are task-derived text, shown once; only the scores are kept.
        safe["profile"]["request_quality"] = {
            name: {"score": item["score"], "reason": "Reason is not retained in history."}
            for name, item in result["profile"]["request_quality"].items()
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
        # Keep prepared statements disabled for compatibility with transaction poolers.
        self._connection_options = {
            "row_factory": record_row,
            "connect_timeout": 10,
            "prepare_threshold": None,
        }
        self._pool: ConnectionPool | None = None
        self._reused_connection: ContextVar[psycopg.Connection | None] = ContextVar(
            "reused_connection", default=None
        )
        self.migrate()

    def open_pool(self, max_size: int):
        if max_size == 0 or self._pool is not None:
            return
        pool = ConnectionPool(
            self._database_url,
            kwargs=self._connection_options,
            min_size=0,
            max_size=max_size,
            max_idle=60,
            timeout=10,
            open=False,
        )
        pool.open()
        self._pool = pool

    def close_pool(self):
        if self._pool is not None:
            self._pool.close()
            self._pool = None

    @contextmanager
    def reuse_connection(self, db: psycopg.Connection):
        """Use an active transaction for nested storage calls in this scope."""
        token = self._reused_connection.set(db)
        try:
            yield
        finally:
            self._reused_connection.reset(token)

    @contextmanager
    def connect(self, *, user_id: str | None = None):
        reused = self._reused_connection.get()
        if reused is not None:
            # A failed optional reader rolls back to its savepoint, leaving the parent usable.
            with reused.transaction():
                if user_id is not None:
                    self.lock_user(reused, user_id)
                yield reused
            return

        connection = (
            self._pool.connection()
            if self._pool is not None
            else psycopg.connect(self._database_url, **self._connection_options)
        )
        with connection as db:
            # Transaction-local settings are reset when the connection returns to the pool.
            db.execute(
                "SELECT set_config('search_path', %s, true), "
                "set_config('lock_timeout', '15s', true)",
                (self.schema,),
            )
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
                contents = path.read_bytes().replace(b"\r\n", b"\n")
                checksum = hashlib.sha256(contents).hexdigest()
                # Existing Windows installs may have recorded CRLF. Accept only
                # that exact newline variant; changed SQL still fails verification.
                windows_checksum = hashlib.sha256(contents.replace(b"\n", b"\r\n")).hexdigest()
                if version in applied:
                    if applied[version] not in {checksum, windows_checksum}:
                        raise RuntimeError(f"Applied database migration {version} was modified")
                    continue
                db.execute(contents.decode("utf-8"))
                db.execute(
                    "INSERT INTO schema_migrations(version,checksum) VALUES (%s,%s)",
                    (version, checksum),
                )
            self._secure_tables(db)

    def install_module(self, statements):
        with self.connect() as db:
            self._lock_schema(db)
            for statement in statements:
                db.execute(statement)
            self._secure_tables(db)

    def _secure_tables(self, db):
        """Turn Row Level Security on for every table of the schema (a second barrier).

        The application is the only intended client and it connects as the owner of the tables
        (or as a role that bypasses RLS), so nothing changes for it: it still filters by user in
        every query. With RLS on and no policy, any other role that can reach the schema, such as
        the Supabase Data API roles ``anon`` and ``authenticated``, sees no rows at all. Tables of
        optional modules are created at startup, after the migrations, so this runs again after
        each module. A role that does not own a table cannot change it: that is logged, never
        fatal, because the application filters by user regardless.
        """
        rows = db.execute(
            """SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
               WHERE n.nspname=%s AND c.relkind IN ('r','p') AND NOT c.relrowsecurity
               ORDER BY c.relname""",
            (self.schema,),
        ).fetchall()
        for row in rows:
            try:
                with db.transaction():
                    db.execute(
                        sql.SQL("ALTER TABLE {}.{} ENABLE ROW LEVEL SECURITY").format(
                            sql.Identifier(self.schema), sql.Identifier(row[0])
                        )
                    )
            except psycopg.errors.InsufficientPrivilege:
                log.error("Row Level Security NOT enabled on %s: not the table owner", row[0])

    def rls_off_tables(self) -> list[str]:
        """Tables of the schema that still lack Row Level Security (empty when all are secured)."""
        with self.connect() as db:
            rows = db.execute(
                """SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                   WHERE n.nspname=%s AND c.relkind IN ('r','p') AND NOT c.relrowsecurity
                   ORDER BY c.relname""",
                (self.schema,),
            ).fetchall()
        return [row[0] for row in rows]

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
