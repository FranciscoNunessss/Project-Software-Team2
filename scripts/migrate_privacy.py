"""Explicit, irreversible removal of legacy task content; preserves derived history."""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from migration_tools.legacy_sqlite import LegacySQLiteStorage  # noqa: E402

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument(
    "--remove-legacy-task-content",
    action="store_true",
    required=True,
    help="Permanently remove task text, context and free explanations. "
    "Stop all backend workers before running this command.",
)
parser.add_argument(
    "--database", type=Path, required=True, help="Legacy SQLite database to upgrade"
)
args = parser.parse_args()
if not args.database.is_file():
    parser.error("SQLite database does not exist")
LegacySQLiteStorage(str(args.database), allow_legacy_redaction=True)
print("Privacy migration complete. Derived profiles and choices preserved; legacy text removed.")
