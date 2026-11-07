# OKR Pulse

A static OKR progress dashboard for AdaptAI (Team 2, Software Project 2026/27, MEI-ISEC).
A GitHub Action measures the key results in [`okrs.yml`](../okrs.yml) every day,
keeps a history of snapshots, and publishes a dashboard on GitHub Pages. There is no
server, no database and no paid service.

```
okrs.yml (repo root)  ──►  collector (Node + TS)  ──►  data/latest.json
  objectives, KRs,          GitHub REST API              data/history/YYYY-MM-DD.json
  semester calendar         + repo files                 data/history/index.json
                                                             │
                      okr-pulse-data branch  ◄───────────────┤
                      GitHub Pages dashboard ◄── Vite build ─┘
```

The OKRs come from **01 Process Charter v0.11 (4 Nov 2026)**. The charter stays the
reference for objectives and targets. When the charter changes, update `okrs.yml` in
the same week.

## Layout

| Path | What it is |
|---|---|
| `../okrs.yml` | Objectives, key results, semester calendar. **The only file most people edit.** |
| `schema/okrs.schema.json` | JSON Schema for `okrs.yml` |
| `collector/` | Reads `okrs.yml`, measures each KR, writes the JSON |
| `collector/collectors/` | One collector per KR type |
| `collector/weekly-summary.ts` | Markdown summary for the weekly issue comment |
| `shared/` | Types, calendar, pace/status maths and UI strings, shared by collector and dashboard |
| `dashboard/` | Vite + React + Tailwind + Recharts dashboard |
| `scripts/mock-data.ts` | Fake but realistic data for dashboard development |
| `test/` | Vitest unit tests (pace, progress, status, config validation, collectors) |
| `../.github/workflows/okr-pulse.yml` | Daily collect → commit data → build → deploy |
| `../.github/workflows/okr-weekly.yml` | Optional Monday summary comment |

## Set up once (repository admin)

1. Merge this into `develop` and, at the next promotion, into `main`. GitHub only runs
   scheduled workflows that are on the default branch (`main`). Until then, run the
   workflow by hand: Actions → OKR Pulse → Run workflow.
2. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
   The repository is public, so Pages is free. The dashboard is public too. It shows KR
   titles, notes and the titles of linked PRs and issues, so don't put anything in
   `okrs.yml` notes that shouldn't be public.
3. The first run creates the `okr-pulse-data` branch, which holds the snapshot history.
   Never merge it into another branch.
4. Optional weekly comment: open an issue titled **OKR Weekly** and pin it. Then set a
   repository variable `OKR_WEEKLY_ISSUE` to its number (Settings → Secrets and variables →
   Actions → Variables). Without it, the summary still appears in the workflow's job summary.
5. Optional, for KR3.3 and any `prs` KR with `label`: create the labels on GitHub. The
   charter names an **`AI-assisted`** pull-request label, which does not exist yet.

The workflow uses only the built-in `GITHUB_TOKEN`. That token also works for private
repositories. Permissions are set per job: `contents: write` only to push to
`okr-pulse-data`, `issues`/`pull-requests`/`actions: read` to measure, and
`pages: write` + `id-token: write` only in the deploy job.

## Run locally

Requires Node 22.

```bash
cd okr-pulse
npm ci
npm run dev          # generates mock data, then opens the dashboard at http://localhost:5173
```

Other commands:

```bash
npm run validate     # check okrs.yml against the schema and cross-references
npm test             # unit tests
npm run mock         # regenerate mock data (dashboard/public/data, git-ignored)
npm run collect      # real collection → out/data (uses GITHUB_TOKEN if set)
npm run collect -- --offline --out out/data   # manual KRs only, no API calls
npm run collect -- --date 2026-11-20          # pretend it is another day
npm run summary -- --data out/data            # print the weekly summary
npm run build        # type-check and build dashboard/ → dist/
```

To look at real data in the dashboard locally, run
`npm run collect -- --out dashboard/public/data` and then `npx vite --config dashboard/vite.config.ts`.
Without a token the GitHub API allows 60 requests an hour. That is enough for this repo,
but set `GITHUB_TOKEN` to a fine-grained, read-only token if you run it often.

## How progress is calculated

For each KR:

- **Progress** = how far the current value has moved from `baseline` towards the target
  of the active checkpoint, from 0 to 100%. It works in both directions: with
  `baseline: 100`, `target: 50` and `direction: lower`, a value of 75 is 50%.
- **Active checkpoint** = the first checkpoint whose milestone week has not ended yet.
  KR2.1 works towards 1 pattern until the end of week 11 (MVP), then towards 3.
- **Expected** (`pace: linear`, the default) = a straight line from the previous
  checkpoint's target (or the baseline), starting at `start_week`, to the active target
  at the end of the milestone week. `pace: constant` expects the full target every week
  from `start_week` on. KR3.1 and KR3.2 use it ("100% every week").
- **Status**: gap = expected − progress, in percentage points.
  gap > `behind_gap` (25) → *Atrasado*; gap > `at_risk_gap` (10) → *Em risco*;
  otherwise → *No bom caminho*; 100% → *Concluído*. A KR with no measured value is
  **Sem dados**. It is never counted as 0.
- **Objective** = average progress of its measured KRs, plus the worst status among them.

Semester weeks run Monday to Sunday, counted from `semester.start_date` (week 1).

## Labelling issues and pull requests with KR ids

Day-to-day work is tracked on ClickUp. GitHub labels matter only for KRs whose type
reads GitHub:

- `type: issues` counts issues with the KR's `label`. The convention is `kr:<KR id>`,
  for example `kr:KR2.1`.
- `type: prs` counts merged PRs with the `label` (if set), touching `paths` (if set),
  into `base` (if set), approved by `require_review_by` (if set).
- `type: pr_reviews` (KR3.3) looks at PRs into `base` that carry the `match.label`
  (`AI-assisted`) **or**, with `match.ai_trailer: true`, have a commit with an AI
  `Co-Authored-By:` trailer. The team already adds those trailers to commits.

Add a label to a PR from the sidebar: *Labels* → choose the label. You can do it before
or after the merge.

## Adding or changing a KR

1. Edit `okrs.yml`. Copy an existing KR of the same type and change `id`,
   `objective_id`, `title` and the target.
2. Give either `target` + `due` (one milestone) **or** `checkpoints` (several milestones),
   not both. Milestone names must match `semester.milestones`.
3. Run `npm run validate`. Each error names the KR and the field, for example:
   `key_results (KR1.1).due: "MVPP" is not a semester milestone (known: ...)`.
4. Open a PR. The workflow's `check` job validates, tests and builds it.

Remember the Learning Agreement (§8.3): KRs may be revised **once**, at mid-semester,
with a written reason. Record that in the charter as well.

### KR types

| `type` | Measures | Required fields | Optional fields |
|---|---|---|---|
| `manual` | value typed by the KR owner | `value` (number or `null`) | `confidence` (0–1), `note`, `updated` (date) |
| `issues` | % of labelled issues closed | `label` | |
| `milestone` | % complete of a GitHub milestone | `name` | |
| `prs` | number of merged PRs | | `label`, `paths` (globs), `base`, `require_review_by` |
| `pr_reviews` | % fewer "changes requested" reviews per PR vs a baseline window | `baseline_weeks: [a, b]` | `base`, `match: {label, ai_trailer}`, `window_weeks` (default 2) |
| `docs` | each file exists + % of Markdown checkboxes ticked | `files` | |
| `ci` | a number in a JSON file inside a workflow artifact | `workflow`, `artifact`, `file`, `json_path` | `branch` |

Fields every KR can have: `owner`, `proposed` (shows a PROPOSTO tag), `unit`,
`direction` (`higher`/`lower`), `baseline`, `start_week`, `pace` (`linear`/`constant`),
and `evidence` (a list of `{title, url}` links shown in the KR details).

### Updating manual KRs every week

Most KRs are measured outside GitHub: the blind review sheet, usability notes, the
PDSA log. The charter keeps weekly values in the "OKRs & Improvement (GCI)" tab of the
DA spreadsheet. Before the weekly replenishment, each KR owner copies the value into
`value:`, sets `updated:` and adjusts `note:` in a small PR. Leave `value: null` until
something has really been measured.

## Documentation health

`docs_health` lists the repository files shown in the "Saúde da documentação" panel:
whether each exists, its checkbox completion, its last commit date on `develop`, and
**Desatualizado** if that date is more than `docs_stale_days` (14) days ago. The charter,
ADRs and specifications live on Google Drive, so they are not measured here.

## Language

The UI defaults to pt-PT with an EN switch, so the dashboard can be shown as an English
deliverable (LA §10). Strings live in `shared/i18n.ts`. Add every new key to both
languages.
