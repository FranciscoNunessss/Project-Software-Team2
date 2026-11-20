# C1 usage record — draft for Ricardo's approval

Producer: WS1 gateway. Consumers: WS3, WS4, WS5; web and IDE callers.
Status: not approved. This document does not authorise storage or gateway changes.
Source: the supplied AdaptAI release plan, shared contracts section.

## Fields from the release plan

| Field | Required meaning |
|---|---|
| call_id, created_at | Identity and creation time of one LLM call. |
| user_id, group_ids | Caller identity; memberships resolved at call time. |
| surface | web or ide. |
| feature | analysis, coach, chat, educator, ide_chat or ide_diff. |
| provider, model, key_owner | Actual execution destination; key_owner is platform or user. |
| tokens_in, tokens_out | Provider-call token usage. |
| latency_ms, queued_ms | Execution latency and time waiting in the queue. |
| est_cost_eur, price_catalog_date | Estimated cost at dated catalogue prices, even for a free call. |
| status | ok, rate_limited, fallback or error. |

No prompt/task text, file content, code, credentials, provider response bodies,
exception bodies or arbitrary free-text metadata may be stored. Fields outside
this table require an approved contract change, not an incidental implementation.

## Decisions required before I2 G1

1. **What counts as a call:** one row for each physical provider attempt or one row
   for the whole logical request with retries? Define retry identities, fallback
   accounting and exactly-once behaviour so tokens and costs cannot double count.
2. **Incomplete usage:** what should token/cost fields contain when a provider fails
   before returning usage or a stream is cancelled? Unknown must not silently become
   measured zero. Any nullability/estimation policy needs explicit approval.
3. **Membership availability:** which WS3 interface resolves group_ids, including
   calls before organisations/groups ship? Define mock behaviour without inventing
   memberships or treating an unavailable resolver as confirmed non-membership.
4. **Time boundaries:** confirm whether latency excludes queue time and includes all
   stream consumption, and when created_at is taken. Retry/backoff and execution
   timings must stay consistent across producer and consumers.
5. **Cancellation:** C1 has no cancelled status. Agree its mapping to the existing
   statuses or approve a contract amendment before adding an enum value.
6. **Prices and currency:** confirm catalogue version selection, unavailable-price
   handling and conversion to EUR if source prices use another currency. No made-up
   exchange rate or extra stored field is introduced by this draft.
7. **Metering failure:** define the visible/recoverable outcome if the usage write
   fails after a provider succeeds. The 100% metering criterion must not be weakened
   to silent best-effort logging or cause an automatic repeat of a billable call.
8. **Access and lifecycle:** confirm ownership, consumer access and retention/deletion
   rules. Team consumers remain subject to ADR-005 aggregation rules. No new manager
   access to individual calls is implied by the existence of group_ids.

## Contract checks to carry into the I2 spec

- Normal web and IDE calls use exactly these fields/enums and their actual model.
- Retry/fallback/cancellation tests assert row count, token/cost accounting and the
  approved statuses; analysis never changes its production model as a fallback.
- Membership changes are tested at the agreed call-time boundary, not reconstructed
  later from the user's current group membership.
- Missing usage, missing prices, quota exhaustion and database failures have explicit
  outcomes; tests reject invented usage/cost values and duplicate records.
- Marker tests cover success, queueing, cancellation, upstream failure and write
  failure, including persistent rows and logs.
- Consumer fixtures are shared with WS3/WS4/WS5 after approval; mocks must not be
  presented as production data or as evidence of an approved contract.

Ricardo's approval and the resulting decisions must be recorded on the card before
I2 implementation. No team member has been contacted by this draft.
