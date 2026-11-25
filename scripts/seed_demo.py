"""WS3 T7: create the Team Scope demo (1 organisation, 3 groups, 15 synthetic members).

    # Preview or demo only; the person who presents must already have an account:
    ADAPTAI_ENVIRONMENT=preview python scripts/seed_demo.py --admin-email you@example.com --yes
    # Also write the 4 weeks of synthetic C1 and C2 records, for the WS3 and WS4 test views:
    ... --export demo-history/
    # Remove the demo (organisation and synthetic members):
    ADAPTAI_ENVIRONMENT=preview python scripts/seed_demo.py --reset --yes

The history is the deterministic mock source (``app.team_data``): the dashboard shows it for these
members without storing usage. The script refuses to run unless ADAPTAI_ENVIRONMENT is preview, demo
or local; production never sets it. Synthetic members have unusable passwords and
``.invalid`` emails.
Exit codes: 0 done, 2 refused or not possible.
"""

import argparse
import json
import os
import secrets
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.providers import Settings  # noqa: E402
from app.storage import Storage  # noqa: E402
from app.team_data import MockSource, activity  # noqa: E402

ALLOWED_ENVIRONMENTS = ("preview", "demo", "local")
DEMO_DOMAIN = "demo.adaptai.invalid"
ORGANISATION = "AdaptAI demo organisation"
# Group name -> number of members. "Interns" stays below the minimum size of 5 on purpose.
GROUPS = {"Engineering": 6, "Support": 5, "Interns": 4}
HISTORY_DAYS = 28
DAY = 86400
# The mock source gives each user id a fixed activity, and about one id in five never uses
# AdaptAI. Synthetic members get ids of at least one task a day, so every week of the demo has
# its planned contributors and Engineering and Support show numbers on every seed.
MIN_DEMO_ACTIVITY = 1.0


def demo_user_id() -> str:
    """A new user id that the mock source makes active enough for the demo."""
    while True:
        user_id = str(uuid4())
        if activity(user_id) >= MIN_DEMO_ACTIVITY:
            return user_id


def refuse_unless_allowed(environ: dict[str, str]) -> str | None:
    """The reason to refuse, or None. Production never sets ADAPTAI_ENVIRONMENT."""
    value = environ.get("ADAPTAI_ENVIRONMENT", "").strip().lower()
    if value not in ALLOWED_ENVIRONMENTS:
        return (
            f"ADAPTAI_ENVIRONMENT is {value or 'not set'}: the demo seed runs only on "
            f"{', '.join(ALLOWED_ENVIRONMENTS)}, never on production"
        )
    return None


def plan(now: int) -> list[dict]:
    """The synthetic members: email, group, role and when they joined (all before the history,
    except one Engineering member who joined 10 days ago, to show the joining rule)."""
    members, number = [], 0
    for group, size in GROUPS.items():
        for index in range(size):
            number += 1
            members.append(
                {
                    "email": f"demo-member-{number:02d}@{DEMO_DOMAIN}",
                    "group": group,
                    "role": "manager" if index == 0 else "member",
                    "joined_at": now - (10 if (group, index) == ("Engineering", 5) else 35) * DAY,
                }
            )
    return members


def reset(store: Storage) -> int:
    with store.connect() as db:
        organisations = db.execute("DELETE FROM organisations WHERE demo").rowcount
        users = db.execute("DELETE FROM users WHERE email LIKE %s", (f"%@{DEMO_DOMAIN}",)).rowcount
    print(f"removed {organisations} demo organisation(s) and {users} synthetic member(s)")
    return 0


def seed(store: Storage, admin_email: str, now: int) -> dict:
    with store.connect() as db:
        admin = db.execute(
            "SELECT id FROM users WHERE email=%s", (admin_email.strip().lower(),)
        ).fetchone()
        if admin is None:
            raise SystemExit(f"error: no account with email {admin_email}: sign up first")
        if db.execute("SELECT 1 FROM organisations WHERE demo").fetchone():
            raise SystemExit("error: a demo organisation already exists: run --reset first")
        organisation = str(uuid4())
        db.execute(
            "INSERT INTO organisations(id,name,demo,created_at) VALUES (%s,%s,TRUE,%s)",
            (organisation, ORGANISATION, now),
        )
        db.execute(
            "INSERT INTO organisation_members(organisation_id,user_id,role,joined_at) "
            "VALUES (%s,%s,'admin',%s)",
            (organisation, admin["id"], now - 40 * DAY),
        )
        groups = {}
        for name in GROUPS:
            groups[name] = str(uuid4())
            db.execute(
                "INSERT INTO team_groups(id,organisation_id,name,created_at) VALUES (%s,%s,%s,%s)",
                (groups[name], organisation, name, now - 40 * DAY),
            )
        user_ids = []
        for member in plan(now):
            user_id = demo_user_id()
            user_ids.append(user_id)
            # "!" is never a valid scrypt hex digest: nobody can sign in as a synthetic member.
            db.execute(
                "INSERT INTO users(id,email,password_hash) VALUES (%s,%s,%s)",
                (user_id, member["email"], "!" + secrets.token_hex(16)),
            )
            db.execute(
                "INSERT INTO organisation_members(organisation_id,user_id,role,joined_at) "
                "VALUES (%s,%s,'member',%s)",
                (organisation, user_id, member["joined_at"]),
            )
            db.execute(
                "INSERT INTO group_members(group_id,user_id,role,joined_at) VALUES (%s,%s,%s,%s)",
                (groups[member["group"]], user_id, member["role"], member["joined_at"]),
            )
    return {"organisation": organisation, "groups": groups, "user_ids": user_ids}


def export(directory: Path, user_ids: list[str], now: int) -> None:
    end = datetime.fromtimestamp(now, UTC).date()
    usage, events = MockSource().records(user_ids, end - timedelta(days=HISTORY_DAYS - 1), end)
    directory.mkdir(parents=True, exist_ok=True)
    for name, rows in (("c1-usage.jsonl", usage), ("c2-events.jsonl", events)):
        with (directory / name).open("w", encoding="utf-8") as stream:
            stream.writelines(json.dumps(row) + "\n" for row in rows)
    print(f"wrote {len(usage)} C1 records and {len(events)} C2 events to {directory}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--admin-email", help="existing account that becomes the demo admin")
    parser.add_argument("--export", help="directory for the synthetic C1/C2 history (JSONL)")
    parser.add_argument("--reset", action="store_true", help="remove the demo instead")
    parser.add_argument("--yes", action="store_true", help="confirm the change to the database")
    args = parser.parse_args()
    reason = refuse_unless_allowed(dict(os.environ))
    if reason:
        print(f"refused: {reason}", file=sys.stderr)
        return 2
    if not args.yes:
        print("refused: add --yes to change the database", file=sys.stderr)
        return 2
    settings = Settings()
    store = Storage(settings.database_url.get_secret_value(), settings.database_schema)
    store.migrate()
    if args.reset:
        return reset(store)
    if not args.admin_email:
        print("error: --admin-email is required", file=sys.stderr)
        return 2
    now = int(time.time())
    created = seed(store, args.admin_email, now)
    print(
        f"created the demo organisation with {len(created['groups'])} groups and "
        f"{len(created['user_ids'])} synthetic members; {args.admin_email} is its admin"
    )
    if args.export:
        export(Path(args.export), created["user_ids"], now)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
