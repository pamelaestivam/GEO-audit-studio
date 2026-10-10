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
`live-check.yml` (skipped by its condition). A Production event has not been observed yet (superseded below).

**Open:** PR #33 (report invariants and the zero-figure guard, `docs/PROGRAM.md` row 5, first half) is in
review; then row 5's second half, row 6 (the $0 guard) and row 7 (the step-wise audit).

**Follow-up, later the same day:** #33 (report invariants and the zero-figure guard, 6025447), #34, #35
(Dependabot bumps of the pinned `setup-node` and `checkout` actions, each a three-line change that the
CI it ran under had already exercised) and #37 (the earlier record) are merged. The `deployment_status`
trigger on a finished **Production** deployment is now observed: Vercel's bot fired `live-check` on
`main` after the merges of #33 and #34 (both runs executed and failed on the same two configuration
checks, as expected). Dependabot opens a pull request per pinned action monthly.

**Later still (PR for the "Not counted" list):** #39, the $0 guard, is merged (145ca8c): paid engines
need `ALLOW_PAID_ENGINES=1`, Gemini calls are counted per UTC day with an optional operator cap that
fails closed on an unreadable value, and a paid key alone now yields a precise reason. A mid-review
failure was my own doing, not the product's: two full suites ran at once and one rebuilt `dist/` under
the other (lesson: one suite at a time per checkout, see `docs/INSIGHTS.md` I-17).

**Step e planned (docs/PLAN_STEP_E.md):** a read-only planning pass sliced the step-wise audit into seven
small PRs with a boundary test each (counting real fake-Gemini hits, as `quotaEfficiencyE2E` does), the
risks, and a list of what must not be claimed or built without the durable store or the owner. Its
honest conclusion: on Vercel with memory-only storage the step-wise design makes a lost audit visible
(designed to give a sentence rather than a hang or a zero; not built) but cannot make it recoverable; that is row 8 (Supabase, owner O-4).

**Step e, slice S1 (PR for `src/auditPipeline.ts`):** #40 (the "Not counted" list, ac4ac15) and #41 (the step e plan, c1da3c4) are merged. Slice S1 moves the analysis and report assembly out of `performAudit` into pure functions with no behaviour change, proved by a golden-report test over twelve scenarios captured from the server before the move (INSIGHTS I-18); the independent reviews found it guarded less than first written, so three scenarios and a list of what it still does not guard were added. Nothing step-wise is built yet; S2 (the store contract) is next.

**Step e, slice S2 (the store contract):** both stores gain ordered steps with leases, bounded attempts, first-writer-wins completion, a heartbeat/instance id and an incidents list; the claim rules are one function (`decideClaim`) that both stores call, and SQLite claims inside `BEGIN IMMEDIATE`. Proved with the same suite on both stores, with two connections to one file, and with eight real processes claiming one step at once (exactly one wins). Six deliberate breakages (a deferred instead of immediate transaction, completion without the state guard, a lease that is never live, one extra attempt, a repeated call not counted, pruning that leaves steps) each fail a check; the reviews added more, and the one divergence they found (an exhausted step keeping its call start on the memory store only) is fixed and tested. The server does not call any of it yet.

The independent review of the store (PR #43) found real faults, all fixed with checks that fail without the fix: a start-up race when several processes open one old database (INSIGHTS I-20), no fencing of `markCallStarted` / `completeStep` by attempt, memory-store aliasing and a duplicate job id accepted, a non-numeric attempt limit meaning unlimited retries, an `exhausted` signal that fired once and was then lost, and the instance id appearing on the public status endpoint (now a store property, not part of `info()`).

**Step e, slice S3 (the engine):** an audit is now planned at submit and run as recorded steps (`advanceJob`, one engine call per question and engine, then the analysis, then the finish) driven by an in-process loop. It had to keep the old behaviour, and the proof covers what the tests can reach (they fake only Gemini): the twelve golden reports captured before S1 (all unchanged), the whole existing suite (including the quota, retry, restart and reaped-job-finishes-late tests), and a new boundary test that counts real fake-Gemini hits against the step rows in the SQLite file. A job the reaper stops as stuck can still be finished (its steps stay claimable), because the old behaviour was to record a late finish. A step that breaks ends the audit as a failed audit that says so, leaves a failed step and an incident, and is not billable.

**Step e, slice S4 (the Vercel slice):** the page can now drive an audit one step at a time (`POST /api/audit/job/:id/advance`, `AUDIT_DRIVER=client`, the default on Vercel). With nobody driving, nothing runs and nothing is spent; two advances at once give one step and one `busy`; the per-minute limiter counts submits but not advances; an audit its page abandoned stops holding a concurrent-audit slot after `AUDIT_STALL_MS`. When the job is not on the instance asked and the deployment keeps no state, the page throws `AuditInterrupted`: a sentence with how many steps had finished, that at least that many engine calls were made, and what running again can cost. It never claims a resume. Real Vercel behaviour is still unverified (owner actions O-1 and O-3).

**Step e, slice S4 review, then S5 (resume):** the independent review and EVAL PM of #45 found real faults, all fixed with checks that fail without the fix and merged (f866429): an audit abandoned after it made calls escaped both daily budgets (the reaper recorded every reaped job as free), the stall window also freed server-driven audits mid-call, the page ended an audit on a gateway error, several sentences claimed more than the code knows, and the ownership/driver/status checks on the advance route had no test that could fail. Slice S5 (this PR) takes up, at boot and on a durable store, the audits a killed server left running: leases held by the dead process are released, server-driven audits are driven again from the step they were on, page-driven ones carry on when the page asks. The proof kills the real server with SIGKILL against the fake Gemini and counts hits: killed between steps costs exactly the planned calls; killed mid-call costs one repeat, recorded; killed three times on a step ends with a sentence and capped calls. Limits kept honest: boot-time only (no periodic sweeper), ONE server process per database file (a booting process releases other processes' live claims), memory stores and Vercel still cannot recover a lost audit (owner O-4). The S5 review then found and I fixed: a job older than the maximum run time was resumed while the person was told it failed (now stopped, not resumed); a second process that could not bind the port released the live process's claims before dying, wedging its audit (release and resume now wait until the server is listening); an audit that failed after paid calls was recorded as free (now counted, and the sentence says so); four docs still said a restart fails the audit. Mutation checks: removing the lease release or the resume makes the restart suites time out loudly ("the audit did not finish"); removing the repeated-call incident, the no-plan sweep, the stale-job stop, the listen-first rule or the spent-audit billing each fails a named check.

**Step e, slice S5 merged; step g started:** #46 (resume after a restart on a durable store) merged as 1f3f779 after its own independent review and EVAL PM; the review's fixes (no resume of an over-age audit, release and resume only once the server is listening, failed-after-calls audits counted, four contradicting docs corrected) are in it. Step g, first slice (PR #47): the deep readiness check gains a `recent trouble` check. Its independent review BLOCKED the first version, correctly: the daily live-site workflow never signed in, so it never called readiness (the headline claim was false); a finished-but-empty audit (rejected key, used-up quota) read as "No audit failed"; a report-invariant violation left no trace; and on a memory store the check was a green no-op. Reworked: audits are counted by when they ended including empty ones (every audit empty is a fault), a report that fails its own consistency rules records an `invariant` incident, a memory-store server says "Not checked", the sentence quotes the most recent serious incident instead of pointing at a page that does not exist, the 24-hour window is enforced in a pure function with edge tests, and the workflow passes optional sign-in secrets and warns loudly when they are absent. Owner step added (PROGRAM O-3 step 4).

**Step g, first slice merged (#47, 97ae7e1)** after two independent reviews (the first BLOCKED, the second asked for wording fixes) and an EVAL PM SHIP (87). A small follow-up makes the smoke script print a `warn` line for any readiness check that passed only because it could not look. Still to do after the merge: observe the first live-check run of the new workflow on `main` (it should warn that the signed-in checks were skipped, and nothing else should change), and the owner's O-3 steps 1 and 4 before the check can see failed audits at all.

**Decision A built (cited-only is its own number):** `mentioned` used to be `name appears OR own domain cited`, which made "Named in N of M answers" false whenever a site was cited without the name. It is now name-only; a new `citedOnly` flag per answer and `observationsCitedOnly` on the report carry the other number, the summary's first sentence says it when it is above zero, the page shows a sub-line with a one-line explainer, `metricVersion: 2` marks the new rule and older saved reports say they were measured under the earlier one. Proved against the real server with a new fake-Gemini mode (one answer names and cites the brand, one only cites the site): visibility 50%, cited-only 1; the old rule gave 100% (mutation-checked in the unit test). The ten existing golden reports changed only by the two new fields. This changes what the product promises a client: the owner is told in chat before the merge (docs/DECISIONS.md, decision A).

**Decision A, review round:** the independent review found that a brand typed with a legal suffix ("Acme Analytics, Inc.") that engines write plainly would now be reported as "cited without being named" (the citation used to hide the miss). Fixed two ways: the name without its legal suffix is matched too, and the report sentence and explainer now say only what was measured (the name as typed did not appear in the answer text). Also: past-audit lists now mark scores from the earlier rule (· earlier rule), the oldest reports (no answer count) get the note, the narrative prompt says "Named in" and carries the cited-only split, the matrix cell explains a cited-only answer, the add-a-question endpoint carries the flag, an invariant pairs metricVersion 2 with the cited-only number, and a render test checks the page really shows the sub-line, explainer and note. Still not handled: a location suffix ("Poke House Austin") is not matched; the explainer says why.

**A test that could not fail (found 2026-10-10):** in a full-suite run `quotaBreakerE2E` printed `FAIL  the app server starts against the fake Gemini endpoint` (the server missed its 20-second start window under load) and the suite still exited 0, because `if (!up) return;` inside `main()` skipped the `process.exit(failures ? 1 : 0)` after its try/finally. Eight such early returns in six test files now set `process.exitCode = 1` first, proved with a copy whose server can never start (original exits 0, fixed exits 1), and `test/testHarness.test.ts` fails if a bare `return;` follows a negated check without an exit status (braced or not, checked against fixtures of each shape). The start-up timeout itself is a load flake and is not addressed here.

**Decision A and the harness fix merged; S6 scoped and deferred (2026-10-10):** decision A is on `main` (#49, c09381d)
after repeated independent reviews; the test-harness fix is on `main` (#50, 22f3882): eight early returns in six E2E
files exited 0 after a failed server start, and `test/testHarness.test.ts` now guards the shape (repeated adversarial rounds,
each found real gaps; the guard is a tripwire, its contrived misses are in TECH_DEBT 2.14). Two separate full local runs each failed once on a start-up problem: `retrySpendE2E` (the server missed its start
window; passed alone three times) and, later, `mvpHardeningE2E` ("Could not reach Gemini", while other commands were
running in parallel; passed alone three times and on a clean rerun). The causes were not captured (the suites spawn the
server with `stdio: 'ignore'`).
The daily live check is red on every deployment and that is correct: issue #36 says the production site has no engine key
and no sign-in configuration (owner actions O-2, O-3). Before building S6 I read the code: the reaper already bounds a
hung audit on every submit, read and advance, and a shared pacer, breaker and counter need a second process on one file,
which the boot release forbids. S6 is deferred on purpose (reasons in `docs/PLAN_STEP_E.md` under S6); S7 is next.
Nothing on the live site, and no real audit, can change until the owner does O-2 and O-3.

