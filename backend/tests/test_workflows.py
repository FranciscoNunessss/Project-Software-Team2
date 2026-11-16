"""The scheduled workflows the product depends on (ADR-014 A10, weekly public levels)."""

import re
from pathlib import Path

WORKFLOWS = Path(__file__).resolve().parents[2] / ".github" / "workflows"


def test_catalogue_sources_run_every_week_on_their_own_data_branch():
    text = (WORKFLOWS / "catalogue-sources.yml").read_text(encoding="utf-8")
    cron = re.search(r'schedule:\s*\n\s*- cron: "([^"]+)"', text)
    assert cron, "the weekly schedule is missing"
    minute, hour, day, month, weekday = cron.group(1).split()
    assert (day, month) == ("*", "*") and weekday in {"0", "1", "2", "3", "4", "5", "6", "7"}
    assert minute.isdigit() and hour.isdigit()
    # The scheduled run starts on the default branch: it must move to a data branch
    # before committing, and never push to develop or main.
    assert "github.event_name == 'schedule'" in text
    assert 'branch="data/sources-$(date -u +%F)"' in text
    assert 'git switch -c "$branch"' in text
    assert not re.search(r"git push[^\n]*\b(main|develop)\b", text)
    # A manual or pushed run keeps working on any data/** branch.
    assert "workflow_dispatch:" in text and 'branches: ["data/**"]' in text


def test_the_weekly_routine_document_names_the_scheduled_run():
    docs = Path(__file__).resolve().parents[2] / "docs" / "testing-model-evaluations.md"
    assert "Every Monday at 05:00 UTC" in docs.read_text(encoding="utf-8")
