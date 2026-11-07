"""Explicit, atomic import of a stopped SQLite v7/v8 installation into empty PostgreSQL."""

import json
import shutil
import sqlite3
import tempfile
from contextlib import contextmanager
from pathlib import Path

from app.llm_config import ModelConfigurations
from app.providers import Settings
from app.storage import Storage
from cryptography.fernet import InvalidToken
from psycopg import sql

TABLES = (
    "users",
    "auth_sessions",
    "sessions",
    "analyses",
    "decisions",
    "user_context",
    "memory_entries",
    "llm_configs",
    "coaching_reports",
    "conversation_content",
    "task_outcomes",
    "prompt_coach_settings",
    "chat_sessions",
    "chat_messages",
    "chat_settings",
    "chat_model_tiers",
)


@contextmanager
def sqlite_snapshot(source_path):
    # WAL-mode files on a read-only Docker mount cannot create a local shared-memory
    # sidecar. Read a private copy instead; never checkpoint or alter the original.
    # The old application must be stopped, or source_path must be a consistent backup.
    with tempfile.TemporaryDirectory(prefix="adaptai-sqlite-import-") as directory:
        snapshot = Path(directory) / "source.sqlite3"
        shutil.copyfile(source_path, snapshot)
        wal = Path(str(source_path) + "-wal")
        if wal.is_file():
            shutil.copyfile(wal, Path(str(snapshot) + "-wal"))
        with sqlite3.connect(snapshot.as_uri() + "?mode=ro", uri=True) as source:
            yield source


def install_optional_tables(store):
    try:
        from app.chat import TABLES as chat_tables
    except ModuleNotFoundError as exc:
        if exc.name != "app.chat":
            raise
    else:
        store.install_module(chat_tables)
    try:
        from app.prompt_coach import SETTINGS_TABLE
    except ModuleNotFoundError as exc:
        if exc.name != "app.prompt_coach":
            raise
    else:
        store.install_module((SETTINGS_TABLE,))


def import_sqlite(source_path: Path, store: Storage, settings: Settings, *, apply=False):
    # URI mode=ro refuses missing files and keeps the source and its privacy flags unchanged.
    source_path = source_path.resolve(strict=True)
    with sqlite_snapshot(source_path) as source:
        source.row_factory = sqlite3.Row
        source.execute("BEGIN")
        if source.execute("PRAGMA user_version").fetchone()[0] not in {7, 8}:
            raise ValueError(
                "Import requires SQLite schema v7 or v8. "
                "Upgrade a backup with the legacy tools first; "
                "legacy raw-content removal needs explicit consent."
            )
        present = {
            row[0] for row in source.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        unknown = present - set(TABLES) - {"sqlite_sequence"}
        if unknown:
            raise ValueError("SQLite contains unknown tables; review them before importing")
        tables = [table for table in TABLES if table in present]
        counts = {
            table: source.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
            for table in tables
        }

        # Ciphertexts stay bound to their original user/config IDs and require the same key.
        if "llm_configs" in present:
            encrypted = source.execute(
                "SELECT id,user_id,key_ciphertext FROM llm_configs WHERE key_ciphertext IS NOT NULL"
            )
            cipher = None
            for row in encrypted:
                if cipher is None:
                    cipher = ModelConfigurations(store, settings).cipher()
                try:
                    value = json.loads(cipher.decrypt(row["key_ciphertext"].encode()))
                    if value["id"] != row["id"] or value["user_id"] != row["user_id"]:
                        raise ValueError("Credential owner mismatch")
                except (InvalidToken, ValueError, KeyError, TypeError):
                    raise ValueError(
                        "The configured encryption key does not match the SQLite credentials"
                    ) from None

        if not apply:
            return counts
        install_optional_tables(store)
        target_tables = set(store.table_names()) - {"schema_migrations"}
        if set(tables) - target_tables:
            raise ValueError("Source contains optional tables whose modules are not installed")
        with store.connect() as target:
            # Import requires an empty destination, including optional tables. Lock before
            # checking so a concurrent request/import cannot turn the copy into a merge.
            target.execute(
                sql.SQL("LOCK TABLE {} IN ACCESS EXCLUSIVE MODE").format(
                    sql.SQL(",").join(map(sql.Identifier, sorted(target_tables)))
                )
            )
            for table in target_tables:
                if target.execute(
                    sql.SQL("SELECT 1 FROM {} LIMIT 1").format(sql.Identifier(table))
                ).fetchone():
                    raise ValueError("PostgreSQL destination is not empty; no data was imported")
            for table in tables:
                columns = [row[1] for row in source.execute(f'PRAGMA table_info("{table}")')]
                statement = sql.SQL("INSERT INTO {} ({}) VALUES ({})").format(
                    sql.Identifier(table),
                    sql.SQL(",").join(map(sql.Identifier, columns)),
                    sql.SQL(",").join(sql.Placeholder() for _ in columns),
                )
                # Preserve SQLite insertion order as the new sequence_id tiebreaker.
                for row in source.execute(f'SELECT * FROM "{table}" ORDER BY rowid'):
                    target.execute(statement, tuple(row))
                copied = target.execute(
                    sql.SQL("SELECT count(*) FROM {}").format(sql.Identifier(table))
                ).fetchone()[0]
                if copied != counts[table]:
                    raise RuntimeError("Import count mismatch; transaction rolled back")
        return counts
