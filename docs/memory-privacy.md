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

The historical metadata-only decisions below were extended by the user's explicit request on
30 October for optional conversation storage. Current behaviour is described at the end of this
file; existing metadata-only consents were not converted into task-text consent.

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

29 October 2026: Completeness and explained changes (policy prototype-3)

Each analysis now returns a `completeness` value (0 to 100, derived from how many profile
dimensions are determined and confident, the ambiguity score and whether the result is
provisional) and, on a re-analysis in the same session, `previous_analysis_id` and a list of
`changes` for the dimensions whose value differs from that previous analysis. History stores
`completeness`, `previous_analysis_id` and `changes` with only the dimension name and its
before and after values. The evidence of each change is task-derived text: it is returned in
the analysis response but never stored in analyses or history, so later reads of a session show
changes without evidence. (Since 30 October it may also be kept inside the full AI response in
`conversation_content`, only when the user enabled "Save task text and AI responses".) The
previous analysis must belong to the same account and session and use the current profile
version; these checks run before any provider call. A re-analysis is assessed without past
conversation excerpts (numeric usage metadata is kept). No schema migration is needed; analyses
stored earlier have no completeness or changes.

29 October 2026: Educator completeness series and snapshot extensions

The Educator (Groq coaching) snapshot now also contains `completeness_series`: one integer
per session, oldest first (at most the latest 50 sessions), being the completeness of the first
analysis of that session. It is always recomputed from the stored derived profile values
(scores, required modalities, confidence) and `recommendation_provisional` with the current
policy, so analyses stored before completeness existed are included and stored completeness
values are not trusted. With fewer than five values the snapshot adds `insufficient_history`.
The series contains numbers only. (Since 30 October the only text the Educator can receive is
the opted-in `conversation_excerpts`; extensions and the series never carry text.)

Optional modules can register a snapshot extension. Its aggregates appear under `extensions`
and must be numbers or aggregates only, never text; size metrics never unlock the prompting
assessment, which still needs opted-in excerpts (ADR-009); its note is appended to the Educator
system prompt. Without registered extensions nothing is added. Extension data and the prompt
take part in the cache fingerprint, so registering, changing or removing an extension marks
saved guidance stale. No schema migration is needed.

30 October 2026: the version-2 coaching contract generates pattern explanations, next actions
and learning lessons in the same per-user report. It uses the same bounded derived metadata,
plus server-computed sample counts; it adds no task storage or additional provider destination.
The prompt treats scores as task requirements rather than personal abilities. Prompt inflation
is still unassessed: its generated explanation and exercise must acknowledge missing text, and
the structured status permits only `not_assessed`. The contract version participates in cache
freshness, so old summaries do not populate the expanded cards. Existing reports are retained
until a valid update succeeds; generated prose remains advice, not verified conclusions.

30 October 2026: explicitly opted-in conversation storage (schema v7, coaching contract v3).
The user's request authorises an OPTIONAL exception to metadata-only retention. A separate
initially disabled Profile switch explains that new task text, task context and full AI
assessment responses are stored locally, may be reused with memory permission and may be sent
to the chosen Assistant provider / project Groq. Saving is checked again after the assessment
call. No discarded historical text is reconstructed. Numeric history remains sanitised.

Both text permission and Use memory are required to include at most five bounded excerpts in
Assistant/coaching input (3,000 task characters, 500 context characters and 1,000 profile
characters each). Automatic Groq coaching additionally needs its own flag. The report records
source sample counts. Prompting can be provisionally assessed only with these samples; without
them the backend rejects any status other than `not_assessed`. Samples are untrusted content,
not task instructions, and identifying quotations are discouraged in the model prompt.

Revoking text permission stops new saving and reuse, while keeping previously stored records
for owner review/export/deletion. Revoking use permission stops reuse. Both invalidate coaching;
source fingerprints prevent in-flight generation from restoring a report after revocation or
text deletion. A dedicated clear-text action deletes stored conversations and cached advice,
leaving numeric history/settings intact. Session deletion cascades to text. Exports include
opted-in records and may retain copies after deletion. Formal ADR acceptance is unchanged.

The dashboard now displays automatic-coaching status instead of a manual generation button.
The Profile opt-in is the user-facing control for suggestions. Turning it off leaves saved advice
visible but stops new automatic calls. The existing explicit-consent POST remains an API-only
capability; the frontend does not use it. Failure messages explain that new history can trigger
another attempt, rather than directing the user to a removed retry button.
