# ADR-016: Team Scope, individual visibility with consent (amends ADR-005)

- Status: **Proposed** (21 Nov 2026). Needs team approval and the client's confirmation in the weekly
  update (decision D1). Until the client confirms, the individual view stays behind a feature flag and
  managers see aggregates only.
- Release plan task: WS3 T0. The plan calls this decision "ADR-006"; ADR-006 to ADR-010 already exist
  in Drive, so it takes the next free number in the repository.
- Prepared with AI assistance (Claude, Anthropic); human review pending.

## Context

ADR-005 says team data is shown only in aggregate, above a minimum group size. The client asked for a
Team Scope where a manager sees cost, tokens and performance for the groups they manage and, with the
member's consent, each member's usage and learning evolution. The second part goes beyond ADR-005.

What AdaptAI stores about a person is already limited: scores, levels, enums and numbers, never task
text (marker test). Usage records (contract C1) and learning events (contract C2) keep that rule.

## Decision

1. **Roles.** An organisation has *admins*. A group has *managers* and *members*. A person can manage
   several groups and be a member of others. Only admins create groups, invite and remove people.
2. **Aggregates are the default.** A manager sees group aggregates only: tokens, estimated cost,
   resolved rate, recommendation acceptance, over- and under-sizing, and their trend.
3. **Minimum group size k = 5** (to confirm against the value in ADR-005). A group, or one week of a
   group, with fewer than k *contributing* members (members with at least one record in that week) shows
   "not enough members" instead of numbers. Counting contributors, not names on the list, stops a group
   of ten where only one person used AdaptAI from revealing that person.
4. **Individual view only with consent (opt-in), per group.** A member opts in for one group at a time.
   Consent is off by default, can be revoked at any time, and revoking hides the data immediately
   (the next request, no cache). Without consent the manager sees aggregates only.
5. **Symmetry.** A member can always see exactly what the manager sees about them, on the same screen.
6. **What a manager can never see:** task text, prompt text, file content, code, chat messages, or the
   Coach rewrite. The individual view uses WS4 indicators only (maturity, request-quality trend,
   usage totals), never single tasks.
7. **Subtraction attack.** Comparing a group's numbers before and after one person joins or leaves would
   reveal that person. Rules:
   - **Closed weeks are frozen.** A week's aggregate is computed once the week has closed and is never
     recomputed after a membership change. Only the current, open week follows the current membership.
   - **Joining.** A member counts in a week only if they joined before that week started.
   - **Leaving.** A removed member stops appearing in new aggregates (open week onwards); frozen weeks
     keep the totals they had, so the difference never isolates the person who left.
   - **No member-level comparison across groups**, and no group comparison below k (T4).
8. **Where it is enforced.** The application is the only client of the database and connects as the
   table owner. Every Team Scope query filters by the caller's role in the application, with one
   automated test per role (admin, manager, member, outsider). Row Level Security is on for every table
   with no policy (branch `feature/rls`), so the Supabase Data API roles (`anon`, `authenticated`) see
   no rows at all. Per-role RLS policies inside Postgres would need a database role per request; they are
   not used, and this is a change from the release plan's wording ("Supabase RLS policies") that the
   Architecture Owner must accept.
9. **Leaving the product.** Deleting an account deletes its memberships, consents and invites (cascade).

## Consequences

- T1 builds roles and membership with application checks; T2 builds aggregates with k = 5 counted on
  contributors; T3 (W13) adds consent and the member's mirror view behind the flag.
- Frozen weeks (rule 7) need a snapshot table once real C1/C2 records exist (T2 on real data, W13).
  The W12 dashboard runs on mock data and computes every week on request; this is acceptable only
  because the mock data is synthetic, and it is written on the T2 card.
- Small teams (fewer than 5 people using AdaptAI in a week) see no numbers for that week.

## Open points

1. The exact minimum size in ADR-005 (Drive). This ADR assumes 5.
2. The client's answer to D1 (individual view with consent): until then, aggregates only.
3. The Architecture Owner's acceptance of rule 8 (application checks plus deny-all RLS, instead of per-role RLS policies).
