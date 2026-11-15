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
In a cloud session `gh` has no valid token (observed 2026-11-15); use the GitHub tools (`create_pull_request`, `pull_request_read` with `get_check_runs`, `merge_pull_request`).

## 1. Before the pull request

1. `git status`: nothing unexpected. Stage **explicit paths** only (`git add path ...`); never `git add -A`, `git add .` or `git commit -a`.
2. Records in the same change: the state table of `docs/ENGINEERING_BACKLOG.md` while that backlog is open, the `docs/PROGRAM.md` row the work belongs to,
   `docs/SESSION_LOG.md`, `docs/INSIGHTS.md` for anything learned, `docs/DECISIONS.md` for a decision, `TECH_DEBT.md` for anything knowingly left.
3. Self-review against `docs/ENGINEERING_STANDARDS.md` section 5: metrics, denominators, empty input, failure paths, user input never
   overwritten, every user-visible error a sentence.
4. A new check has been shown to FAIL when the thing it protects is broken on purpose. Write down what you broke.
5. `npm run verify` green, **one run at a time** (two runs in one checkout collide on `dist/`, I-17). Note the check count.
   Browser suites need Chromium (I-27, I-45); PostgreSQL suites need `TEST_DATABASE_URL` from `bash scripts/pg-test-cluster.sh start` (without it they print SKIP, which is not a pass).
6. A change a person will see: run the `ux-tourist` agent (desktop and phone) before review, with the same read-only briefing and the same check afterwards as in section 4.

## 2. Open the pull request

1. One short-lived branch per change (`claude/<topic>`), commit message says the root cause, ends with the attribution lines of the session.
2. Push with `git push -u origin <branch>`. Create the pull request with the GitHub tool (`gh` has no valid token in a cloud session) and fill
   `.github/pull_request_template.md` completely: every section, "N/A" with a reason, **What was NOT verified** honestly.
3. Do not skip hooks, do not force-push, do not touch `origin`. If the harness blocks a git operation (push, fetch, ref change), **stop and report**; do not look for a variation (hard rule 10). The GitHub tools are the sanctioned route for small files; for anything else ask the owner for the exact commands.

## 3. CI

Read the check named `test` (and the others) from the pull request; do not assume. Red is a finding: read the job log, fix the cause, push,
wait again. Not green means not merged.

## 4. Fresh-context adversarial review

1. Run the `adversarial-reviewer` agent (`.claude/agents/`), briefed read-only: it may experiment only in a `git init` inside `mktemp -d`,
   never in the shared repository (hard rule 9). Give it the pull request number, the branch, and the claim of what behaviour must not move.
2. Its model should differ from the author's (item G1.4 of `docs/ENGINEERING_BACKLOG.md`). The agent definitions pin a model; if the author is on that same model, override it for that call with the Agent tool's `model` parameter and say so in the pull request.
3. After EVERY agent run (reviewer, `eval-pm`, `ux-tourist`): `git remote get-url origin` must be the github.com URL and `git log origin/main..main` must be empty (hard rule 9).
4. A review that was cut short (a limit, a cap, an interruption) is restarted from the start, never accepted as final (hard rule 5).
5. Fix every CONFIRMED finding with a check that failed before the fix; say why for any you reject. Re-run the suite and CI after the fixes.

## 5. EVAL PM

Run the `eval-pm` agent on the pull request (rubric `docs/EVAL_PM.md`), briefed read-only like the reviewer, then do the check of section 4 step 3. Only **SHIP** merges. Paste the scores into the pull request
description's EVAL PM section. REVISE or REJECT: fix, push, wait for CI again on the new head, then score again.

## 6. Merge

1. `git rev-parse HEAD` gives the head hash. Confirm it equals the pull request's head on GitHub, and that `get_check_runs` for **that exact hash** shows `test` green (CI was read again after every push, including after EVAL PM fixes). **Never type a hash from memory** (hard rule 7).
2. Merge as a **merge commit** (not squash, not rebase: `scripts/branch-status.sh` only recognises merge commits), passing that head hash as
   the expected head so a push you did not see cannot slip in.
3. The session cannot delete the branch (HTTP 403); the repository setting does (`docs/PROGRAM.md` O-5).

## 7. After the merge

1. `git fetch origin main`, then check that `origin/main` holds the merge commit. Come back and read CI on `main` until it has a result: a red `main` is a stop-the-line event (the next action is the fix or a revert, nothing built on top of it).
2. If the change is in the deploy path, say that `main` auto-deploys and read `.github/workflows/live-check.yml`'s run when it finishes.
3. Update the records with the merge commit hash (a follow-up change goes through the same procedure).
4. Run `bash scripts/branch-status.sh` in the same turn and write its first line LAST in the reply, plus any open pull request or red CI it cannot see:
   `Branch: <name> | N commit(s) ahead of main, pushed | MERGED (merge commit <sha> is on main)`, or
   `... | NOT merged (<what blocks it>)` when you held the merge (say which: a red gate, a finding not fixed this round, the owner's hold).
5. If the script printed a `Stale:` line, report it to the owner every time (hard rule 3; the repository setting in `docs/PROGRAM.md` O-5 fixes it).
