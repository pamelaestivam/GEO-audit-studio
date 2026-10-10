# Session log (append-only)

One entry per working session, newest last. An entry says what the session did,
found, decided and left open, in enough detail that a session that never saw the
conversation can continue. Do not edit old entries except to add a correction note.
Companion files: `docs/PROGRAM.md` (state), `docs/DECISIONS.md` (why),
`docs/INSIGHTS.md` (what was learned), `docs/OWNER_DIRECTIVES.md` (the mandate).

---

## 2026-10-09 to 2026-10-10: independent review, seven fix PRs, then the owner's answers

**Mandate received:** scrutinise the product with a CTO mindset and supporting
agents, fix what is wrong in small tested PRs, report what could not be verified,
and tell the owner how to try it. Only this repository may be changed; the other
repositories were read-only context.

**Done (all merged to `main`, CI green on each merge):**
#19 two-character acronym brands (HP, 3M) were measured at 0%; #20 accented and
non-Latin vendor names truncated; #21 accuracy rate used the wrong denominator and
re-attributed invented claims; #22 adapters untested, a retiring default model,
wrong-provider advice; #23 score shown without its uncertainty or provenance;
#24 a plain database copy restores nothing (WAL), added `scripts/backup.mjs`;
#25 add-query and tick-task silently did nothing after reload, and a guessed
domain; #26 the written review (`docs/REVIEW_2026-10-09.md`).

**Process findings:** every fix PR's first version failed a fresh-context
adversarial review (a defect in the fix itself), up to four review rounds; a
fact-check of the report found five wrong statements before it merged. Docker Hub
anonymous-pull limits repeatedly failed CI; one unexplained test failure
(`quotaEfficiencyE2E`, "Could not reach Gemini", zero requests) passed on re-run
and did not reproduce locally in three runs. Overlapping random test ports are the
suspect (INFERRED, `TECH_DEBT.md` 2.14).

**2026-10-10, the owner's answers** (verbatim in `docs/OWNER_DIRECTIVES.md`): $0;
must not fail silently and be designed not to fail; automatic deployment to a URL
they open; they know Vercel and Supabase; two decisions delegated to the agents;
keep records. The team protocol ran (three solo positions, one debate round); the
outcome is the 2026-10-10 entry in `docs/DECISIONS.md`.

**Verified this session (MEASURED):** `npm run verify` on merged `main`: 1,092
checks passed, 0 failed, 0 vulnerabilities. Start-up with no key.

**Could not do, and why (so nobody repeats the attempt blindly):**
- Reach the live site, vendor documentation, or Gemini: the sandbox cannot resolve
  outside hosts (network policy; owner action O-1). Web search returns snippets only.
- Delete merged remote branches: the git proxy answers HTTP 403 to ref deletion
  (tested). The fix is the GitHub setting "Automatically delete head branches" (O-5).
- Set branch protection: no tool exists for repository settings (O-5).
- Create the database or set Vercel variables: needs the owner's logins (O-3, O-4).
- Run a real audit: no key (O-2).
- Run Docker: the client exists, no daemon.

**Left open:** see `docs/PROGRAM.md` section 2. Next up, in order: honest first
visit (storage-mode line, no-engine message, default 2), Docker out of required
checks, invariants plus number guard plus "Not counted" panel plus cited-only metric,
$0 guard, step-wise state machine.

**How to resume:** read `docs/OWNER_DIRECTIVES.md`, `docs/PROGRAM.md`, then the
2026-10-10 entry in `docs/DECISIONS.md`; run `npm ci && npm run verify`; pick the
first "next" row in `docs/PROGRAM.md`.

---

## 2026-10-10 (later): records merged, hygiene pattern adopted, three incidents

**Done:** the records PR (#27, merged bddd7f9) passed a fresh-context fact-check (which found a
non-existent required check name, unbuilt behaviour in the present tense, and stale
"always-on service" text) and an EVAL PM (87, SHIP); both sets of findings were fixed before
merge. The team protocol's outcome is in `docs/DECISIONS.md` (2026-10-10). PR #29 (merged
d851fb2) removed a `node_modules` symlink my `git add -A` had put on `main` and made CI fail
on any tracked symlink. The first build step (honest first visit: a temporary-storage
notice, a no-engine notice that disables the run buttons, `DEFAULT_QUERY_COUNT = 2`) was built
and tested (full suite and 81 browser checks passed), was held back for a few hours by incident 3
below, and became PR #30 (branch `claude/first-visit-notices`, since merged as 19005fc).

**Incidents, in order, with what is known:**
1. *Symlink on main.* `git add -A` in the records worktree committed `node_modules` (a link to
   another checkout) in PR #27. CI stayed green because `npm ci` replaces the link. Fixed in
   #29; lesson `docs/INSIGHTS.md` I-12; rule `CLAUDE.md` hygiene 8.
2. *A review agent damaged the shared repository.* While "reviewing", it set `origin` to
   `https://127.0.0.1:1/x.git` (to simulate a failed fetch) and, in a "scratch worktree",
   ran `git checkout -B main`, leaving local `main` one empty commit (d06197e) ahead of
   `bddd7f9` with a stale index. It reported the `main` damage, not the `origin` change. I
   found the `origin` change when `git push` failed. Lesson I-13; rules hygiene 9.
3. *The harness refused the repairs, then the owner authorised them.* `git remote set-url origin
   <github url>` was denied as a remote repoint; so was `git clone` of the GitHub URL, and the
   reviewer's `git update-ref` on `main`. I did not look for variations (rule 10) and carried
   small changes through the GitHub tools meanwhile. The owner then said "you have permission,
   run it"; the same three commands (set the URL back, fetch, reset `main` to `origin/main`,
   after checking the index matched and nothing was untracked) worked at once. The block is
   resolved; the lesson is to ask for exactly that authorisation instead of working round it.

**Continuity routine** (the owner asked that work continue as soon as the session is
available after any limit): trigger `trig_015EVqEooFHDy9HVc3KkL31j`, created 2026-10-10 04:37 UTC,
cron `37 * * * *` (hourly), bound to session `session_01QFrPVVXx3Yfr2MmgoQNy4D`; the
scheduling tool returned that id and `next_run_at` 05:37 UTC when it was created (the
session could not independently re-verify it). Its prompt: pull `main`, read the
directives, program and log, finish any open PR under the gates, else take the first "next"
row, and do nothing outward when only owner actions remain. Stop it with `delete_trigger`.
A session that finds this entry and no routine can recreate it from this description. (Its
first firings, while `origin` was still wrong, would have had to stop; `origin` has since been
repaired, see incident 3.)

**Tested once, not repeated:** deleting a remote branch with `git push origin --delete`
returned HTTP 403 from the git proxy (one attempt, 2026-10-10; I-4). Later the same day, on the
owner's suggestion to rename instead, a delete and a rename through the GitHub API were each
tried once and also answered 403; no variations were tried. A search of the GitHub
tool list found no branch-protection, ruleset, repository-settings or delete-branch tool.

**Learned:** the merge tool refuses a wrong head hash (HTTP 409); read it, never recall it
(I-11). A status script that says MERGED must prove a merge commit exists; the first version
could never print MERGED and called merged branches "nothing to merge" (the reviewer caught it;
rewritten with a test that builds a throwaway repository and runs 25 checks (23 at the time, 25 after the sync-merge case was added), I-10).

**Open (the next session starts here):** PR #30 (first visit) is merged (19005fc). The hygiene PR
(#31) and the CI-strategy PR (#32) are the open ones; then `docs/PROGRAM.md` items 5 to 7
(invariants, $0 guard, step-wise state machine). Branch
deletion and rename are both denied (HTTP 403) from this session, so stale branches stay until the
owner turns on "Automatically delete head branches" (O-5).

**Network facts learned the same day (MEASURED):** egress goes through a policy proxy; the npm
registry, `generativelanguage.googleapis.com`, and git/GitHub through the proxy are reachable;
`vercel.app`, `vercel.com`, `supabase.com` and `ai.google.dev` are not. The repository is public;
this session can push but has no admin rights. GitHub Actions runners are outside this policy, so a
workflow can act as the session's eyes on the live site, with its logs read through the GitHub tools.

---

## 2026-10-10 (later still): CI strategy merged, first measurement of the live site

PRs #30 (honest first visit), #31 (hygiene) and #32 (CI strategy) are merged (19005fc, 09aaa88,
01c4049). Each had its own fresh-context adversarial review and EVAL PM score; every first version
had defects (the CI PR's live check would never have passed on the memory-only preview, a hung site
would have skipped the alert, and its restart proof did not exercise the restarted server).

**First measurement of the live site (MEASURED, GitHub Actions runner, the workspace cannot reach
it):** run https://github.com/pamelaestivam/GEO-audit-studio/actions/runs/38033024298 dispatched the
new `live-check` workflow. The site loads and its API answers at every depth. The refusal checks passed, but an unconfigured server answers 503 to everything, so that is not proof that sign-in enforcement works.
It is **not configured**: `SESSION_SECRET` and `ACCESS_CODES` are not set (so sign-in is
impossible) and no engine key is set (so no audit can run). The workflow opened issue #36 by
itself; that is the check working. Storage is memory only (a warning, not a failure, until the
durable store ships). The action this needs from the owner is O-3 and O-2 in `docs/PROGRAM.md`.

**Also observed:** Vercel's bot emits `deployment_status` events for Preview deployments, which fire
`live-check.yml` (skipped by its condition). A Production event has not been observed yet.

**Open:** PR #33 (report invariants and the zero-figure guard, `docs/PROGRAM.md` row 5, first half) is in
review; then row 5's second half, row 6 (the $0 guard) and row 7 (the step-wise audit).

**Follow-up, later the same day:** #33 (report invariants and the zero-figure guard, 6025447), #34, #35
(Dependabot bumps of the pinned `setup-node` and `checkout` actions, each a three-line change that the
CI it ran under had already exercised) and #37 (this record) are merged. The `deployment_status`
trigger on a finished **Production** deployment is now observed: Vercel's bot fired `live-check` on
`main` after the merges of #33 and #34 (both runs executed and failed on the same two configuration
checks, as expected). Dependabot opens a pull request per pinned action monthly.
