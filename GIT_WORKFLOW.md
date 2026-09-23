# Git Workflow

This document describes how we manage branches, pull requests, and commit history in this repository.

## 1. Branch Structure

- **`main`** — protected. Always reflects a stable, releasable state. No one pushes directly to it.
- **`develop`** — integration branch. All finished feature work lands here first, before eventually being promoted to `main`.
- **`feature/<name>-<short-description>`** — one branch per developer per task (e.g. `feature/rafael-auth-login`). This is where day-to-day development happens.

```
main        ← protected, releases only
  ↑
develop     ← integration branch
  ↑
feature/*   ← individual development branches
```

## 2. Branch Protection Rules

Both `main` and `develop` are protected branches in GitHub. No one pushes directly to either — changes only arrive via merged Pull Requests. `main` is stricter, since it represents the final, released product; `develop` is where day-to-day integration happens.

| Rule | `develop` | `main` |
|---|---|---|
| Direct pushes | Blocked | Blocked |
| Required approvals | 1 | 2 (or team's choice) |
| Must be up to date with base branch before merge | Yes | Yes |
| Required status checks (CI/build/tests) | Recommended | Required |
| Who can merge | Any approved reviewer | Reviewer(s) responsible for releases |

- Require the branch to be up to date with the base branch before merging, so conflicts are resolved beforehand, not discovered after.
- `develop` protection guarantees that even fast, day-to-day integration always goes through review — it just needs fewer approvals and can be a bit more permissive than `main`.

## 3. Daily Workflow

1. Create your feature branch from the latest `develop`:
   ```bash
   git checkout develop
   git pull origin develop
   git checkout -b feature/your-name-your-task
   ```
2. Work and commit normally on your feature branch.
3. Before opening a PR, sync with `develop` using **rebase**, not merge:
   ```bash
   git fetch origin
   git rebase origin/develop
   ```
   This replays your commits on top of the latest `develop`, avoiding unnecessary merge commits and keeping history linear.
4. Push your branch (after a rebase you'll likely need `--force-with-lease`, since history was rewritten):
   ```bash
   git push --force-with-lease origin feature/your-name-your-task
   ```
5. Open a Pull Request into `develop`.

## 4. Reviewing and Fixing Pull Requests

- One or more team members are designated as **reviewers/integrators** for open PRs.
- Their responsibilities:
  - Review the diff for correctness, style, and conflicts with other in-flight work.
  - Request changes or fix small issues directly (with the author's awareness) so the PR is mergeable.
  - Confirm the PR is rebased on the latest `develop` before approving.
  - Merge the PR once approved and CI (if configured) passes.

## 5. Keeping History Clean: Rebase Strategy

To avoid a tangled history full of criss-crossing merge commits, we rebase instead of merge when integrating changes from `develop` into a feature branch.

- **On feature branches:** always rebase onto `develop`, never merge `develop` into your branch.
- **When merging a PR into `develop`:** use "Rebase and merge" (or a fast-forward merge) in GitHub, so the feature's commits are simply appended to `develop`'s history, not wrapped in a merge commit.
- **Never rebase a branch that others are also working from** (e.g. don't rebase `develop` or `main` themselves) — rebase is safe on your own private feature branch, not on shared branches.
- Optionally, squash minor "fix typo" / "wip" commits into a single meaningful commit before opening the PR (`git rebase -i`), so each commit on `develop`/`main` tells a clear story.

## 6. Promoting `develop` → `main`

`develop` is where all feature PRs land and get integrated day to day. `main` only receives code once that integrated work is stable and ready to be considered the "final product" at that point in time.

- Periodically (e.g. at a release milestone, sprint end, or client delivery), a Pull Request is opened from `develop` into `main`.
- This PR is reviewed like any other, following the `main` protection rules above (more approvals, required CI).
- Since `develop` is already a clean, linear history (thanks to the rebase policy above), this can be a simple fast-forward merge, keeping `main`'s history just as clean.
- After merging, it's good practice to tag the resulting commit on `main` (e.g. `v1.2.0`) to mark that release point.

## 7. Commit Message Guidelines

- Keep commits small and focused on one logical change.
- Use a clear, descriptive summary line (e.g. `Add JWT validation to login endpoint`), optionally following [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `refactor:`, `docs:`, etc.) if the team wants a stricter convention.

## Summary

| Rule | Why |
|---|---|
| `main` protected, no direct pushes | Guarantees `main` is always stable/releasable |
| PRs target `develop`, not `main` | Keeps integration and release concerns separate |
| One feature branch per dev/task | Avoids stepping on each other's work |
| Rebase feature branch onto `develop` before PR | Avoids merge commits, keeps history linear |
| Designated reviewer(s) fix/approve PRs | Ensures quality and mergeability before integration |
| Rebase/fast-forward merge into `develop` and `main` | Keeps overall history clean and readable |
