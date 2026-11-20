# Secret scanning

AI Integration Policy section 2.2: no keys in prompts or code. The Construction guide says the CI
scans for secrets; until this workflow it did not (the audit of 16 November 2026, contradiction 7).

## What runs

`.github/workflows/secret-scan.yml` runs [gitleaks](https://github.com/gitleaks/gitleaks) (a pinned
release, verified against its published SHA-256) on every pull request and on pushes to `main` and
`develop`. It scans **the commits the change adds**, not the whole history, so an old finding does not
block new work. Findings are redacted in the log.

To audit everything once: Actions, "Secret scan", Run workflow, tick "full history". Treat anything it
finds as leaked: revoke the key first, then decide whether to rewrite history.

## What it does not do

* It does not see the contents of GitHub or Render secrets, only what is committed.
* `.env.example` is skipped by path. In the tests, `e2e/` and the extension tests a finding is hidden
  only when the **path and a marker in the value both match** (`synthetic`, `not_real`, `test-key`,
  ...; see `.gitleaks.toml`). A real key pasted into a test file has no marker and is reported.
  Name a fake value with one of the markers, or add a narrow regex for it; do not allow a folder.
* Every run first plants a random GitHub-token-shaped value in a throw-away file and fails if
  gitleaks does not report it, so a green scan cannot come from a scanner that stopped seeing keys.
* A push that creates a branch scans only its newest commit, not the whole history. Audit the whole
  history once with the manual run ("full history") before the first merge, so the first push to
  `develop` holds no surprise.
* GitHub's own secret scanning and push protection, if enabled by an administrator of the repository,
  are a second layer; this workflow does not need them and does not prove they are on.

## If it fails on your pull request

1. Do not merge. Revoke the key at its provider (a deleted commit is still readable).
2. Remove it from the branch history (an amended or rebased commit), force-push your own branch.
3. If it is a false positive, add the narrowest regex or path to `.gitleaks.toml` in the same pull
   request and say why in the description.
