# WS3 Team Scope: week 12 (T0, T1, T2 on mock data, T7)

Owner for week 12: Francisco Velhinho (reassigned on 21 Nov 2026). Source of truth: "AdaptAI Release
Plan: Weeks 12 to 15". Prepared with AI assistance (Claude, Anthropic); human review pending.

| Task | What | Where |
|---|---|---|
| T0 | ADR amending ADR-005: roles, k = 5, consent, subtraction attack, enforcement | `docs/adr/ADR-016-team-scope-individual-visibility-with-consent.md` |
| T1 | Organisations, groups, roles, invites, removal | `backend/migrations/010_team_scope.sql`, `backend/app/teams.py`, Team page |
| T2 | Group dashboard by week, on mock C1/C2 data | `backend/app/team_dashboard.py`, `backend/app/team_data.py`, Team page |
| T7 | Demo seed: 1 organisation, 3 groups, 15 synthetic members, 4 weeks of history | `scripts/seed_demo.py` |

## Assumptions (to confirm)

- **k = 5** minimum contributors per week (the value in ADR-005 lives in Drive; adjust one constant,
  `MIN_GROUP_SIZE`).
- **Enforcement in the application, deny-all RLS in the database** (ADR-016 rule 8), instead of the
  plan's "Supabase RLS policies" per role. The Architecture Owner must accept it.
- **D1 (client):** aggregates only until the client confirms; T3 (W13) adds the consent view.
- **Mock data** until the WS1 gateway (C1) and WS4 events (C2) exist; the API says `"source": "mock"`
  and the page shows a "Demo data" note. Costs in EUR use a fixed demo rate (0.92 per USD).

## T1 Organisations, groups, roles and membership

**Objective.** Admins build teams; managers run groups; members belong to them; nobody reads outside
their role.

**Requirements.** Roles admin (organisation), manager and member (group); a manager can manage
several groups. Admins create and delete groups, create invite links (role, optional email, 1 to 30
days, shown once, stored as a hash), revoke invites, list and remove members. Anyone can leave a group.
Writes need the browser session (no API token). Outsiders get 404 (cannot tell a group exists).
Removing a member takes them out of every new aggregate. Account deletion cascades.

**Scenarios and tests** (`backend/tests/test_teams.py`):

| Given / When / Then | Test |
|---|---|
| Admin lists members and removes one; they leave the list | `test_admin_creates_groups_lists_members_and_removes_them` |
| Manager opens the dashboard; cannot list members, invite, remove or create groups | `test_manager_sees_the_dashboard_but_not_the_member_list_and_cannot_change_the_team` |
| Member sees the group's name only; no dashboard, no members, no size | `test_member_sees_only_their_group_name_and_no_team_data` |
| Outsider gets 404 everywhere and an empty list | `test_outsider_cannot_tell_the_group_exists` |
| A manager of two groups (limit case) | `test_a_manager_can_manage_several_groups` |
| Used, revoked or made-up invite: one answer (abuse) | `test_an_invite_works_once_and_a_used_revoked_or_unknown_link_gives_one_answer` |
| Invite bound to an email refused to someone else | `test_an_invite_bound_to_an_email_is_refused_to_anyone_else` |
| Invite token stored only as a hash (privacy) | `test_the_invite_token_is_stored_only_as_a_hash` |
| A member leaves; cannot remove others | `test_a_member_can_leave_and_cannot_remove_others` |
| Account deletion removes memberships (privacy) | `test_deleting_an_account_removes_its_memberships` |
| A leaked IDE token cannot change a team (abuse) | `test_team_writes_need_the_browser_session_not_an_api_token` |
| Duplicate or blank group names (error) | `test_group_names_are_unique_per_organisation_and_trimmed` |

Quota exhausted: not applicable (no LLM call).

## T2 Group dashboard (mock data in W12, real data in W13)

**Objective.** A manager sees tokens, estimated cost and performance of a group by week, with trend,
without anyone being singled out.

**Requirements.** Per group and period (4, 8 or 12 weeks): tokens in and out, estimated cost labelled
"Estimated at catalog prices of <date>", resolved rate, recommendation acceptance, over- and under-sizing,
per week and in total. A week with fewer than k contributors shows "not enough members"; a group with
fewer than k members shows nothing. Members count only from the first full week after joining. Totals
add only the weeks shown. Admin and managers only.

**Scenarios and tests** (`backend/tests/test_team_dashboard.py`):

| Given / When / Then | Test |
|---|---|
| Five contributors in a week: tokens, cost, rates | `test_a_week_with_enough_contributors_shows_tokens_cost_and_rates` |
| Group of 4 (limit): no numbers | `test_a_group_below_the_minimum_size_shows_not_enough_members` |
| Big group, one active person: week hidden (privacy) | `test_a_week_with_fewer_than_five_contributors_is_hidden_even_in_a_big_group` |
| Totals cannot reveal a hidden week (subtraction) | `test_totals_add_up_only_the_weeks_shown_so_a_hidden_week_cannot_be_recovered` |
| Late joiner not in the week they joined | `test_a_member_counts_only_from_the_first_full_week_after_joining` |
| Removed member in no aggregate | `test_a_removed_member_is_in_no_aggregate` |
| Mock records follow C1, no text | `test_mock_records_follow_contract_c1_and_carry_no_text` |
| Totals reconcile with the C1 records (API, database) | `test_dashboard_totals_reconcile_with_the_c1_records_of_the_source` |
| More than 12 weeks refused (error) | `test_the_dashboard_rejects_more_than_twelve_weeks` |
| Role checks on the dashboard | in `test_teams.py` (manager 200, member 403, outsider 404) |

Not done in W12: frozen weekly snapshots (ADR-016 rule 7) need real records (W13); the page load
target from WS1 I1 is not measured yet.

## T7 Demo seed data

**Objective.** A believable team to demo and test against, never on production.

**Requirements.** Runs only with `ADAPTAI_ENVIRONMENT` = preview, demo or local and `--yes`. Needs an
existing account as admin (`--admin-email`). Creates 1 organisation (marked demo), groups Engineering
(6), Support (5) and Interns (4, below k on purpose), 15 synthetic members with `.invalid` emails and
unusable passwords, one late joiner. `--export DIR` writes 4 weeks of C1/C2 JSONL. `--reset` removes
only the demo organisation and the synthetic members.

**Scenarios and tests** (`backend/tests/test_seed_demo.py`): refuses without preview/demo/local
(`test_the_seed_refuses_to_run_without_a_preview_or_demo_environment`); the planned team
(`test_the_plan_has_three_groups_fifteen_members_and_one_group_below_the_minimum`); seed, export and
reset touch only the demo (`test_seed_then_reset_creates_and_removes_only_the_demo`).

## How to test by hand (G2)

```bash
ADAPTAI_ENVIRONMENT=local python scripts/seed_demo.py --admin-email <your account> --yes
```

Then open **Team** in the sidebar: Engineering and Support show the dashboard with demo data, Interns
says "not enough members". Create an invite link, open it in another browser signed in as another
account, and check the roles above.

# WS3 after week 12: T1b, T3 and T4

Prepared with AI assistance (Claude, Anthropic); human review pending.

## T1b Admin policy for pause and start over (WS4 L17)

An organisation admin switches each control on or off (`PUT /api/organisations/{id}/learning-policy`,
browser session only). Both are on by default. A person is under the policy of every organisation in
whose groups they are, and the strictest wins; leaving every group ends it. While pausing is off, a
pause chosen earlier does not apply (new tasks count) and comes back if pausing is allowed again.
Turning learning back on is always possible. Tests: `backend/tests/test_team_policy.py`.

## T3 Member view with consent (ADR-016 rules 4 to 6)

Off unless `ADAPTAI_TEAM_MEMBER_VIEW=true`: ADR-016 is still Proposed and keeps the individual view
behind a flag until the client confirms (D1). A member opts in per group from **Team, Sharing** and
can revoke at any time; leaving the group removes the consent. Managers and admins of that group then
see the member's levels, radar and patterns (all from the WS4 engine, levels without hysteresis); the
member sees the same body on their own screen. No task, text or single result. Members who did not
opt in are not listed. Tests: `backend/tests/test_team_consent.py`, `e2e/team.spec.ts`.

## T4 Multi-group overview

`GET /api/teams/overview?weeks=4|8|12` gives every group the caller runs on the dashboard's totals,
each under the minimum size. Tests: `backend/tests/test_team_overview.py`.

Known limit, also true of the single dashboards: two groups that differ by one person can be
subtracted from each other. ADR-016 does not cover overlapping groups; to be decided.

## Migration

`015_team_policy_consent.sql`. 014 is left for the WS4 migration (`analyses.surface`, `coach_uses`).

## Not done yet

T2 on stored data, TL1 to TL5 and the web/IDE split wait for WS4 (TL0, E0b) and WS1 (I2).
M5 to M7 run after the AI freeze. T5 and T6 (Plus) are not started.
