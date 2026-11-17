"""Row Level Security as a second barrier: on for every table, and the application unaffected.

The application filters by user in every query. RLS is the barrier behind that: a role that is not
the owner and does not bypass RLS (the Supabase Data API roles, for instance) sees no rows.
"""

import os
from uuid import uuid4

import psycopg
import pytest
from app.main import create_app
from app.providers import Settings
from fastapi.testclient import TestClient
from psycopg import sql

PASSWORD = "test-password-123"


def register(client, email):
    response = client.post("/api/auth/register", json={"email": email, "password": PASSWORD})
    assert response.status_code in (200, 201), response.text
    return response


def rls_flags(store):
    with store.connect() as db:
        return dict(
            db.execute(
                """SELECT c.relname, c.relrowsecurity FROM pg_class c
                   JOIN pg_namespace n ON n.oid=c.relnamespace
                   WHERE n.nspname=%s AND c.relkind IN ('r','p')""",
                (store.schema,),
            ).fetchall()
        )


def test_every_table_has_row_level_security_including_those_of_the_modules():
    with TestClient(create_app(Settings(_env_file=None))) as client:
        flags = rls_flags(client.app.state.storage)
    assert "users" in flags and "schema_migrations" in flags
    # The optional modules create their tables after the migrations.
    modules = {name for name in flags if name.startswith(("chat_", "prompt_coach_"))}
    off = sorted(name for name, enabled in flags.items() if not enabled)
    assert not off, f"Row Level Security is off for: {off} (module tables seen: {sorted(modules)})"


def test_the_application_still_works_with_row_level_security_on():
    with TestClient(create_app(Settings(_env_file=None))) as client:
        register(client, "rls@example.com")
        me = client.get("/api/auth/me")
        assert me.status_code == 200 and me.json()["email"] == "rls@example.com"
        # A real write and a read back: RLS must not get in the owner's way.
        analysis = client.post("/api/analyze", json={"task": "Plan a trip", "provider": "demo"})
        assert analysis.status_code == 200, analysis.text
        assert len(client.get("/api/sessions").json()) == 1


def test_the_startup_can_refuse_to_run_with_row_level_security_off(caplog, monkeypatch):
    with TestClient(create_app(Settings(_env_file=None))) as client:
        store = client.app.state.storage
        with store.connect() as db:
            db.execute("CREATE TABLE unsecured_probe (id TEXT PRIMARY KEY)")
        assert store.rls_off_tables() == ["unsecured_probe"]
        # A start that cannot enable RLS (a role that does not own the tables) is simulated by
        # turning the securing step off. The default only logs an error; the setting refuses.
        monkeypatch.setattr(type(store), "_secure_tables", lambda self, db: None)
        with caplog.at_level("ERROR"):
            create_app(Settings(_env_file=None, require_rls=False))
        assert "Row Level Security is OFF" in caplog.text
        with pytest.raises(RuntimeError, match="ADAPTAI_REQUIRE_RLS"):
            create_app(Settings(_env_file=None, require_rls=True))
        with store.connect() as db:
            db.execute("DROP TABLE unsecured_probe")


def test_a_table_created_later_is_secured_on_the_next_start():
    with TestClient(create_app(Settings(_env_file=None))) as client:
        store = client.app.state.storage
        with store.connect() as db:
            db.execute("CREATE TABLE added_later (id TEXT PRIMARY KEY)")
        assert rls_flags(store)["added_later"] is False
        store.migrate()
        assert rls_flags(store)["added_later"] is True


def test_another_role_sees_no_rows_even_with_select_granted():
    url = os.environ["ADAPTAI_TEST_DATABASE_URL"]
    role = "rls_probe_" + uuid4().hex[:8]
    try:
        admin = psycopg.connect(url, autocommit=True, connect_timeout=10)
    except psycopg.OperationalError:
        pytest.skip("no database")
    with admin:
        try:
            admin.execute(sql.SQL("CREATE ROLE {} NOLOGIN").format(sql.Identifier(role)))
        except psycopg.errors.InsufficientPrivilege:
            pytest.skip("this database role cannot create roles")
        schema = None
        try:
            with TestClient(create_app(Settings(_env_file=None))) as client:
                register(client, "probe@example.com")
                schema = client.app.state.storage.schema
                admin.execute(
                    sql.SQL("GRANT USAGE ON SCHEMA {} TO {}").format(
                        sql.Identifier(schema), sql.Identifier(role)
                    )
                )
                admin.execute(
                    sql.SQL("GRANT SELECT ON ALL TABLES IN SCHEMA {} TO {}").format(
                        sql.Identifier(schema), sql.Identifier(role)
                    )
                )
                owner_count = admin.execute(
                    sql.SQL("SELECT count(*) FROM {}.users").format(sql.Identifier(schema))
                ).fetchone()[0]
                assert owner_count == 1
                try:
                    # PostgreSQL 16: the creator of a role may not be allowed to SET ROLE to it.
                    admin.execute(
                        sql.SQL("GRANT {} TO CURRENT_USER WITH SET TRUE").format(
                            sql.Identifier(role)
                        )
                    )
                except psycopg.errors.SyntaxError:
                    admin.execute(sql.SQL("GRANT {} TO CURRENT_USER").format(sql.Identifier(role)))
                with admin.transaction():
                    admin.execute(sql.SQL("SET LOCAL ROLE {}").format(sql.Identifier(role)))
                    seen = admin.execute(
                        sql.SQL("SELECT count(*) FROM {}.users").format(sql.Identifier(schema))
                    ).fetchone()[0]
                assert seen == 0, "a role without BYPASSRLS must see no rows"
        finally:
            # Roles belong to the whole database server, not to the test schema: never leave one.
            if schema:
                for grant in (
                    "REVOKE ALL ON ALL TABLES IN SCHEMA {} FROM {}",
                    "REVOKE ALL ON SCHEMA {} FROM {}",
                ):
                    admin.execute(
                        sql.SQL(grant).format(sql.Identifier(schema), sql.Identifier(role))
                    )
            admin.execute(sql.SQL("DROP ROLE IF EXISTS {}").format(sql.Identifier(role)))
