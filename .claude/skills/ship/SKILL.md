---
name: ship
description: The merge gates for GEO Audit Studio as one procedure. Use at the end of any round that changed the repository, when the change must reach main. Runs the suite, opens the pull request, waits for CI, runs the fresh-context review and EVAL PM, merges with the real head hash, checks main and reports the branch status.
---

# ship: from a finished change to `main`

`CLAUDE.md` (Session hygiene 1, 2, 7, 8, 9, 10) and `docs/ENGINEERING_STANDARDS.md` sections 3, 7 and 10 are the rules; this is the order to do
them in so nobody rebuilds it from prose. Stop at the first red step; a red gate twice for the same cause means stop and report, not
work around. Never skip a step because the change is "only docs".

Hold the merge, and say why, only when: a gate is red, a review finding could not be fixed this round, or the owner said to hold it.
A pull request that changes the session settings file (`.claude` folder settings) waits for the owner's yes in the conversation (it is not merged by this procedure).
The session cannot run `gh`; use the GitHub tools (`create_pull_request`, `pull_request_read` with `get_check_runs`, `merge_pull_request`).

## 1. Before the pull request

1. `git status`: nothing unexpected. Stage **explicit paths** only (`git add path ...`); never `git add -A`, `git add .` or `git commit -a`.
2. Records in the same change: `docs/ENGINEERING_BACKLOG.md` (item state and pull request number), `docs/PROGRAM.md` row 17,
   `docs/SESSION_LOG.md`, `docs/INSIGHTS.md` for anything learned, `TECH_DEBT.md` for anything knowingly left.
3. Self-review against `docs/ENGINEERING_STANDARDS.md` section 5: metrics, denominators, empty input, failure paths, user input never
   overwritten, every user-visible error a sentence.
4. A new check has been shown to FAIL when the thing it protects is broken on purpose. Write down what you broke.
5. `npm run verify` green, **one run at a time** (two runs in one checkout collide on `dist/`, I-17). Note the check count.
   Browser suites need Chromium (I-27, I-45); PostgreSQL suites need `TEST_DATABASE_URL` (the session-start hook sets it).

## 2. Open the pull request

1. One short-lived branch per change (`claude/<topic>`), commit message says the root cause, ends with the attribution lines of the session.
2. Push with `git push -u origin <branch>`. Create the pull request with the GitHub tool (there is no `gh` here) and fill
   `.github/pull_request_template.md` completely: every section, "N/A" with a reason, **What was NOT verified** honestly.
3. Do not skip hooks, do not force-push, do not touch `origin`.

## 3. CI

Read the check named `test` (and the others) from the pull request; do not assume. Red is a finding: read the job log, fix the cause, push,
wait again. Not green means not merged.

## 4. Fresh-context adversarial review

1. Run the `adversarial-reviewer` agent (`.claude/agents/`), briefed read-only: it may experiment only in a `git init` inside `mktemp -d`,
   never in the shared repository (hard rule 9). Give it the pull request number, the branch, and the claim of what behaviour must not move.
2. Its model differs from the author's (`docs/ENGINEERING_STANDARDS.md` section 10). If the author is on the same model as the pin, override
   the agent's model for that call.
3. After the run: `git remote get-url origin` must be the github.com URL and `git log origin/main..main` must be empty.
4. A review that was cut short (a limit, a cap, an interruption) is restarted from the start, never accepted as final (hard rule 5).
5. Fix every CONFIRMED finding with a check that failed before the fix; say why for any you reject. Re-run the suite and CI after the fixes.

## 5. EVAL PM

Run the `eval-pm` agent on the pull request (rubric `docs/EVAL_PM.md`). Only **SHIP** merges. Paste the scores into the pull request
description's EVAL PM section. REVISE or REJECT: fix, then score again.

## 6. Merge

1. `git rev-parse HEAD` gives the head hash. Confirm it equals the pull request's head on GitHub. **Never type a hash from memory** (hard rule 7).
2. Merge as a **merge commit** (not squash, not rebase: `scripts/branch-status.sh` only recognises merge commits), passing that head hash as
   the expected head so a push you did not see cannot slip in.
3. The session cannot delete the branch (HTTP 403); the repository setting does (`docs/PROGRAM.md` O-5).

## 7. After the merge

1. `git fetch origin main`, then check that `origin/main` holds the merge commit and CI on `main` is running or green.
2. If the change is in the deploy path, say that `main` auto-deploys and read `.github/workflows/live-check.yml`'s run when it finishes.
3. Update the records with the merge commit hash (a follow-up change goes through the same procedure).
4. End the reply with `bash scripts/branch-status.sh` first line, plus any open pull request or red CI it cannot see:
   `Branch: <name> | N commit(s) ahead of main, pushed | MERGED (merge commit <sha> is on main)`.
