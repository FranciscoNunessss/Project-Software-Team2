"""Inspect SQLite v7, or explicitly copy it to an empty PostgreSQL schema. Source is read-only."""

import argparse
import json
import sqlite3
import sys
from pathlib import Path

import psycopg
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.providers import Settings  # noqa: E402
from app.storage import Storage  # noqa: E402
from migration_tools.sqlite_import import import_sqlite  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source", type=Path, required=True, help="Stopped SQLite v7 database or consistent backup"
    )
    parser.add_argument(
        "--apply", action="store_true", help="Copy all rows atomically; default only reports counts"
    )
    args = parser.parse_args()
    settings = Settings()
    try:
        store = Storage(settings.database_url.get_secret_value(), settings.database_schema)
        counts = import_sqlite(args.source, store, settings, apply=args.apply)
    except (psycopg.Error, sqlite3.DatabaseError, OSError, HTTPException) as exc:
        # Driver DETAIL fields can contain row data; never print them in a migration log.
        print(json.dumps({"status": "failed", "error": type(exc).__name__}))
        return 1
    except ValueError as exc:
        print(json.dumps({"status": "failed", "error": str(exc)}))
        return 1
    print(json.dumps({"mode": "imported" if args.apply else "preview", "rows": counts}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
