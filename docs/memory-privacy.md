# Profile, memory and usage history

28 October 2026. Local implementation decision draft, following the user's requested
UI and privacy alignment. This does not mark ADR-005 accepted or replace the
Architecture Owner's review of the product's sensitive-data policy.

The Product Specification section 8 and ADR-005 require usage metadata rather than
raw task logs. Earlier local persistence stored task text and provider explanations;
schema v3 removes those fields from active history. Scores, recommendation/eligible
tiers, choices, IDs and timestamps survive. Evidence/explanation text is replaced
with fixed placeholders. Task-derived titles become opaque session labels. Tasks and
task-specific context remain transient, including when memory saving is enabled.

Profile & settings replaces the inactive Team view navigation item. Organisation
aggregates remain a future feature with a separate purpose and privacy threshold.
My progress keeps the established dashboard and metadata history.

Two account settings are independent and initially disabled:

- Save memory: record derived profile values and tier choices for future use.
- Use memory: allow preferences and recent learned metadata in an assessment;
  Assistant can disable this for an individual request.

Learned memory is viewable and clearable. Clearing it does not erase progress or
manually entered preferences. Disabling saving does not erase previous entries.
Deleting a usage session also removes its associated learned entries.
Saving or changing preferences does not invoke an external model. Assessment with
an external provider requires consent for the task and enabled memory together.
Only the latest 20 learned entries are included; raw historical tasks are never sent.

User-entered preferences are an explicit extension separate from session logging.
They can be edited or cleared by saving an empty value. AO/PO review is still needed
for the preference fields, retention period and derived-memory use in the product
baseline. No sensitive information should be requested as a preference.

Derived history also retains provider/version/usage diagnostics for reproducibility.
This metadata set needs reconciliation with the specification's narrower list;
the implementation must not be presented as formally accepted policy compliance.
Personalised coaching now uses derived history as described in the 29 October update below.

Schema v3 cleanup is irreversible in the active database. Existing backups, cloud
sync versions and exports can retain legacy content; the migration does not delete
external copies or promise forensic erasure. No automatic raw-content backup is made.

Existing v1/v2 databases with sessions now block startup instead of automatically
removing content. After reviewing the removal, stop backend workers and explicitly
run `uv run python scripts/migrate_privacy.py --remove-legacy-task-content`. Fresh
databases and already migrated v3 databases start normally. Test collection and test
fixtures both use temporary databases; importing the app during tests cannot migrate
the developer database.

The Assistant now follows the account use-memory setting directly, without a separate
UI switch. Schema v4 adds per-user model configuration and encrypted credentials;
it does not change history retention or run another content-redaction migration.


29 October 2026: Progress workflow and coaching

The separate Allow checkbox is replaced by explicit Analyse and Generate guidance actions,
with destination/data notices next to the controls. The API consent gate remains enforced.
Groq coaching accepts only bounded, derived profile and choice metadata; it excludes raw tasks,
user preferences and identifiers. Structured guidance is cached per account with a source
fingerprint; stale advice is labelled and session deletion invalidates the report. Schema v5
adds this cache without modifying legacy history. Data export includes cached advice; deleting
all usage history clears sessions, choices, derived memory and coaching, with separate UI
confirmation. The account, preferences and configured provider credentials are preserved.
This implementation note does not change formal ADR acceptance status.

Schema v6 adds a separate, initially disabled automatic-coaching preference in Profile.
Its switch explains the Groq destination, derived metadata scope, inclusion of existing history,
saved suggestions and possible quota use. It authorises updates after analyses and choices,
and missing/stale report recovery when opening My progress. Disabling memory alone does not
change this separate permission. Disabling automatic coaching prevents future automatic
requests and prevents saving an automatic response already in flight; it cannot recall a request
already sent. Failures do not automatically repeat for unchanged history. Manual generation
remains available as an explicit action. Cached guidance and usage-deletion controls are unchanged.
