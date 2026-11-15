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
and no sign-in configuration (owner actions O-2, O-3). Before building S6 I read the code; the review of that
reading corrected it: the reaper bounds a hung audit's row (on submit, job read and advance), not the process; a Gemini
call with no HTTP timeout can block the queue; the breaker, counter and pacer reset on restart. S6 is deferred on purpose
(reasons and residual exposure in `docs/PLAN_STEP_E.md` under S6, entries in TECH_DEBT); S7 is next.
Nothing on the live site, and no real audit, can change until the owner does O-2 and O-3.

**The intermittent end-to-end failure: cause found (2026-10-10, correction to earlier entries):** this log and TECH_DEBT
2.14 had put the intermittent "Could not reach Gemini" / "the app server starts" failures down to load and to overlapping
random port ranges. Both were wrong. The cause is that Node's built-in `fetch` refuses a fixed list of "bad ports"
(3659, 4045, 4190, 6000, 6566 and others) instantly, and seven suites each had one inside their random range (a computed
about 4.6 percent chance per full run of drawing one; four of the seven are the suites that failed). It was found because the diagnostics added first (server logs the underlying cause; suites print
the server's output) printed `(bad port)` in my own forced-failure demonstration, and an independent review reproduced
both shapes deterministically. Fixed by drawing every suite's ports through `test/ports.ts`, guarded by
`test/ports.test.ts` (checks the list against the running Node, the helpers, and that no suite draws ports by hand;
mutation-checked). Not proven: that all five red runs of the day were this (the logs did not print the ports). The review
also fixed three bugs in the output capture (multibyte characters split across chunks, stdout and stderr fragments glued
together, an unbounded line) and the wording of the Vercel-cap note (production did build after the cap message).


## 2026-10-28 to 2026-11-04: the owner's set-up walk-through, three advisories cleared, the PostgreSQL store built

**What the owner did (all from their own screens, relayed as screenshots; the assistant could reach none of these sites):**
created a Gemini key in a project with no billing (AI Studio showed "Free tier"; one read-only request with it
returned 200); added `SESSION_SECRET` and `ACCESS_CODES` in Vercel and redeployed (the first redeploy attempt on
2026-10-28 was refused by Vercel's Hobby cap, "more than 100 in 24 hours", account-wide; a later one went through and
the owner signed in on 2026-10-29); found the signed-in app saying no answer engine is configured, and replaced
`GEMINI_API_KEY` in Vercel (the redeploy to pick it up was still to be done when this was written); turned on
"Automatically delete head branches" (the ruleset step is not available on the free plan for a private repository, so
`PROGRAM.md` O-5 step 2 stays on its documented fallback: CI and the gates in `CLAUDE.md`); created the Supabase project
(Data API off, automatic RLS on, GitHub link empty) and said to move on without storing the connection string anywhere.

**What was found:** three advisories published after 2026-10-10 (body-parser high, qs moderate, vite high) made the CI audit
step fail on every branch, `main` included. Fixed alone first, as a lockfile-only change: PR #55 (merge commit df04c7c):
independent review APPROVE with no findings (it hashed the tarballs itself), EVAL PM 93/100 SHIP, CI green. Local run:
1,845 checks, 0 failures (the sandbox's Chromium build differed from the one Playwright 1.56.1 asks for; the browser
suites ran with an alias of the installed build, outside the repository).

**What was built:** `src/postgresStore.ts` (see `docs/DECISIONS.md` 2026-11-04 and `TECH_DEBT.md` 2.17), wired through
`openStore({ databaseUrl })` from `DATABASE_URL`; `mayReleaseOtherHoldersAtBoot` learned `shared`; a duplicate retried click
reaching two processes is a replay (found by the end-to-end test: a 500 without it, 2 of 3 runs). Tests: the contract
suite on a real PostgreSQL 16.15 (a throwaway local server, `scripts/pg-test-cluster.sh`), `test/postgresConfig.test.ts`
(pure), `test/postgresE2E.test.ts` (the built server, two processes, one database). CI starts the runner's PostgreSQL and
sets `REQUIRE_POSTGRES=1`. Deliberate breakages (no row lock, no owner guard, no duplicate-click handling) each failed a
check. NOT done: nothing has touched Supabase or Vercel with this code.

**First independent review of the PostgreSQL store: CHANGES REQUESTED, all fixed (2026-11-04).** The reviewer (fresh context, a
`git init` in a temporary directory, its own databases) confirmed the main design held (it removed the advisory lock and the
row lock and saw checks fail; a 120-worker stress run gave no duplicate claim) and found: (1) a connection that dies while the
store holds it in a transaction ended the whole server process (an unhandled 'error' event: the pool removes its own listener
while a client is checked out); (2) one person's query text (a NUL, a lone surrogate) reached the plan and made the running-count
query fail for everyone, because of a JSONB cast; my own TECH_DEBT claim that this needed a hand-edited row was wrong;
(3) the daily budgets and the concurrent cap are not enforced across instances (documented now, not fixed); (4) a retried click
that reached two servers at the cap got a 429 instead of a replay (fixed); (5) the start-up claim rule had no test (added; breaking
it now fails); (6) two "never leaks the password" checks could not fail because the test hosts gave messages with no secret (a
pretend PostgreSQL server now returns the address and password in its error text); (7) the duplicate-click end-to-end check was a
coin flip (now twelve and fifteen rounds); plus startup parameters a pooler may refuse, fractional times, a pool that returns
BIGINT as text, and the SQL_ASCII encoding of the local test server (now UTF8). Full suite after the fixes: 2,058 checks, 0
failures, 0 skipped; audit 0. A second fresh-context review of the fixes follows before merge.

**Second independent review: the eight fixes held, one hazard and three small things found, all fixed (2026-11-04).** The reviewer
confirmed each fix by reproducing it and by breaking it (14 mutations, each failed a check; 28 of 28 end-to-end checks in seven runs,
three of them under CPU load) and found: (1) 17 test suites that start the built server pass the shell's environment on, so a
`DATABASE_URL` exported in a shell (the variable DEPLOYMENT 4b tells the owner to set) would make a test run write into that real
database and make the SQLite durability suites silently test PostgreSQL. `TEST_AUTH_ENV` now blanks it, `scripts/prod-install-check.sh`
does too, and `test/testIsolation.test.ts` fails when a suite that starts the server does not (run with a bogus address exported, a
suite ignored it and passed); (2) the plan-driver function had been added by editing the first migration, against the file's own rule:
it is migration 2 now (`CREATE OR REPLACE`); (3) a plan the JSON cast cannot read held a concurrency slot until the run-time limit:
the function now reads the driver key from the text, so it leaves the count when quiet, as on SQLite; (4) a claim waiting on a lock
took two query time limits to be refused: a timed-out connection is now closed instead of rolled back (the server's backend can still
wait for the lock until its holder lets go; PostgreSQL does not notice a closed connection while blocked, which my first version of the
test wrongly asserted and which the run showed to be impossible). Full suite: 2,067 checks, 0 failures, 0 skipped; audit 0.

**Re-check of the second round's fixes (2026-11-04):** findings 2 to 4 held (a version-1 database upgrades cleanly with six
simultaneous starts; the text fallback could not be made to match typed text; a timed-out claim is refused after one limit and the
pool recovers). Finding 1 was only partly closed: `test/vercelServerless.test.ts` builds the app inside the test process, so an
exported `DATABASE_URL` made it open and migrate that database (reproduced: 5 tables), and the guard could not see that shape. The
test now removes the variable itself (0 tables with it exported; 5 with the line deleted), and the guard also flags a test that
imports `../server` or `../api` without doing so, ignores comments, and no longer accepts the bare word DATABASE_URL as isolation
(16 checks, each shape has a fixture). Not tested, said plainly: upgrading a database made by the first commit of this branch
(checked once by the reviewer's own script; no database has ever been made by it).

**Final confirmation (2026-11-04):** the reviewer APPROVED commit 444da8a (the `vercelServerless` leak closed: 0 tables with the variable
exported, on that suite and two others) and noted the guard counted per file, not per server start: removing the spread from the second
spawn of `quotaBreakerE2E` still passed. It now requires one `...TEST_AUTH_ENV` per call that starts the bundle (18 checks; the same
mutation is named by it, and restored). Still true and not covered: a spelling of the in-process import with an extension
(`'../server.ts'`) is not matched, and an env built far from the spawn could satisfy the count without being used; the repository's
convention (no extension, the spread beside the spawn) makes both contrived.

**Correction, same day (2026-11-04):** the owner steps for `DATABASE_URL` (in `docs/DEPLOYMENT.md` 4b, `docs/PROGRAM.md` O-4, and
what the assistant said in chat) told the owner to tick Production AND Preview. Found on reading them again after the merge: a Preview
deployment of any branch with a schema change would upgrade the production database, and its test audits would be real history.
Corrected to Production only (PR #57); the owner is told in chat before setting the variable.

## 2026-11-09: Sign in with Google (PR #58)

**Asked by the owner:** make the login page sign in with Google, with the Connection Wall login as the reference. **Decisions** (recorded
in `docs/DECISIONS.md` 2026-11-09): Google first and the access code second, only invited addresses (`GOOGLE_ALLOWED_EMAILS`), no secret
and no redirect (Google's ID token checked against its published keys with `node:crypto`), sessions follow the list, access codes stay.
**Built and proved with a fake Google** (a local keys server and tokens signed with its key): `src/googleAuth.ts`, `POST /api/auth/google`,
the page (`GoogleSignInButton.tsx`, `AuthPage.tsx`). Two real defects were found by looking at the screens: the Google button asked for 320px
in a 293px space (it measured its own hidden holder), and on a phone the sign-in was under the pitch. A test that awaits a promise that never
settles made Node exit 0 in silence (AbortSignal timers do not keep a process alive): the test now keeps the loop alive and fails on an early end.
**Independent reviews:** security (CHANGES REQUESTED: no way found for a stranger to get a session, but a burst of sign-ins on a cold server was
answered "could not reach Google" while Google was fine, because callers did not wait for the fetch under way; an address folded by the Kelvin
sign could equal an invited one; the keys fetch followed redirects and read a body before bounding it; list entries that match nobody were kept;
five protections had no test) and UX (FIX FIRST: an access-code hint on a Google-only server, a layout jump while the status loaded, reading order,
contrast, widths, focus, touch size). All fixed with a test that fails without each fix. Not proven: Google's real script, button and popup, and the
real console steps (no Google account here): the first real sign-in is that measurement (`TECH_DEBT.md` 2.18). Owner action O-6 in `docs/PROGRAM.md`.

**EVAL PM round (2026-11-09):** scored REVISE (73/100: Groundedness 3) for statements that outran the evidence, not for the code: the PR
said the page is unchanged with no Google settings, but it hid the form behind a wait for the server's status (up to six seconds), moved the
sign-in above the pitch on a phone, and its footer mentioned Google where Google is off. Fixed: the wait is 1.5 seconds, a form someone has
started typing in is never taken away, the footer mentions Google only where Google is on (each shown to fail a check when broken), the PR
body now lists what changes on the page even with Google unset (the short wait, the phone order, larger touch targets, small-text contrast),
and `docs/DEPLOYMENT.md` 4c names the newer console path (Clients), both localhost origins, and that preview deployments cannot use Google's
button. The security re-check of the fixes came back APPROVE (the cold-server burst, Kelvin sign, redirect, oversize and streamed bodies, list
entries, and a 6000-request storm giving 24 fetches).

## 2026-11-14: Strategy review and the free-engine list (analysis only, no product change)

**Asked by Ricardo:** analyse how to evolve the product and evaluate a list of free model providers from another session; plan, do
not implement. **Done:** read the directives, program, decisions and engine code; opened the vendors' own pages (Google, Groq, Mistral)
and searched the rest. **Main finding:** Google's pricing page says web search ("grounding") is not available on the free tier for
`gemini-3.6-flash`, the model this app asks by default, so real audits on the live site are probably refused, and the app would report
that as a quota or rate limit while the readiness check (which asks without search) stays green. Not measured: there is no key in the
workspace. **Also found:** an answer that comes back without a search is scored like a searched one; the suggested free providers are
almost all model hosts with no search (only Mistral's and Groq's search tools are worth a trial, both unproven on a free key); Groq's
Compound and Llama models are gone; Meta's API searches with citations but is paid, US-only and waitlisted. **Written:**
`docs/STRATEGY_2026-11-14.md` (the analysis, the plan in six steps, six decisions with a recommendation each), I-36 to I-40,
`TECH_DEBT.md` 2.19, `docs/PROGRAM.md` row 13 and owner action O-7. **Left open:** everything in the plan; the owner's step 0 (look at the
AI Studio limits, set `GEMINI_MODEL=gemini-2.5-flash-lite`, run one audit) comes first. **Later the same day:** the owner side agreed to the recommendations ("I agree with your recommendation") and asked for a wrap-up and
two prompts for later sessions. Written: the decisions (`docs/DECISIONS.md` 2026-11-14), the build specification
(`docs/PLAN_2026-11.md`: P1 the engine probe, P2 a refused or missing search made visible and the default model changed, P3 run again
and show what changed), and `docs/ENGINEERING_BACKLOG.md` (a review of the tool chain, architecture and code, with tasks in three
groups). No product code changed in this session. Found while reviewing: `scripts/branch-status.sh` cannot answer in a cloud session
(shallow clone), so hard rule 1 was met from the session's own commands instead (backlog group 1, item 1).

**Independent review of these records (2026-11-14, pull request #59): CHANGES REQUESTED, all fixed in the documents.** The record of
the finding held. The build specification did not: its first version added a diagnostic call inside the Gemini retry path, which
would have turned a brief per-minute limit into "search refused" and changed call counts pinned in two existing suites; it changed the
default model without knowing whether the older model accepts the look-up request shape; its readiness question gave the model no
reason to search, and the test fake returns search metadata on every reply, so the new checks could not have failed; the probe's call
budget did not add up; "run again" stored its link on a row that is pruned after a week and would have shown a failed look-up's
sources as gone. `docs/PLAN_2026-11.md` was rewritten: no call is added to any audit path, the default model changes only on a measurement, and
comparisons use only pairs measured in both runs. **Second round, same day:** the reviewer confirmed nine of twelve fixed and found
that the rewritten package was still too clever: a remembered "refused" state cannot work where each request may reach a fresh
process, the readiness search call would itself have tripped the breaker, three readiness checks and five version checks were pinned
and unnamed, and one promised sentence was false. The package was cut down to what needs no shared state (a searched flag on Gemini
answers, a second readiness call outside the retry wrapper, one hint on a quota-failed audit), with every pinned value that changes
named. Also corrected: two sentences that overstated ("nothing we built can see it"; "halves the searching
allowance"), five wrong counts in the backlog, lines in `docs/PROGRAM.md` that an entry of the same day contradicted, and the
`docs/PRD.md` note the decision entry claimed. Lesson (I-41).

**Third round, same day (a fresh reviewer):** nine more points, each with the line that contradicted the plan, none in the record of
the finding. The hint's condition did not exist on the path a provider 429 takes and would have fired on the operator's own call cap;
its second sentence sent the reader to a readiness check that does not ask Gemini while the breaker is tripped; the readiness error
sentence said "refused a web search" for a timeout; the not-searched sentence would have been wrapped in "No answer captured from";
two more pinned checks were unnamed and one named check was not pinned; "run again" did not say that the server, not the page, supplies
the inputs. All corrected in `docs/PLAN_2026-11.md`. Because every round found a pin the plan had not named, the plan now tells its
executor what to do when it meets another one, instead of claiming its lists are complete.

**EVAL PM, first score (2026-11-14): REVISE, 67 of 100** (Groundedness capped at 2 because the scorer was barred from the web and so
could not read the live-check run the records call MEASURED; 4, 4 and 4 without the cap). Its points, all taken: the decision entry
now lists the three things the assistant changed after the owner agreed; I-38 no longer labels the timing of the vendors' changes as
READ; "impossible to miss" became "visible"; the backlog says how a long engineering list squares with "engineering is far ahead of
proof".

**EVAL PM, second score (2026-11-14): SHIP, 87 of 100** (Groundedness 4, Completeness 4, Relevance 5; the scorer read the live-check
run itself, which lifted the cap). Taken from its remaining points: the decision entry's label no longer calls the assistant's choices
part of the agreement, and the strategy's status line points at what changed afterwards. Left as it is and said here: the plan's
third-round fixes were checked against the code by the scorer but not sent to a fourth fresh review, so the plan tells its executor
what to do when the code and the plan disagree; the stale lines in `docs/PROGRAM.md` are corrected by a dated note at the top, not
where they sit.

## 2026-11-15: implementing `docs/PLAN_2026-11.md` (P0, P1 first)

**P0.** Untouched `main` (cd916dc): `npm run verify` exit 0, 2,295 checks passed, 0 failed, with PostgreSQL started by
`scripts/pg-test-cluster.sh` and the browser suites run on a Chromium alias outside the repository (`PLAYWRIGHT_BROWSERS_PATH`
pointing at links to the installed build 1243, I-27). Without the alias the run stops at `uiSmoke` ("Executable doesn't exist").

**P1 (PR #60).** Built `scripts/engine-probe.mjs`, `.github/workflows/engine-probe.yml`, `test/engineProbe.test.ts`; wrote O-8. The
fresh-context review (FIX BEFORE MERGE) found five real defects, all fixed with a check each: the key was scrubbed after the 500 and
4,000 character cuts (a key straddling a cut left its first characters), a 200 reply that was not JSON printed as "web search ran:
no", the closing line printed the planned call count as the made count, a candidate named twice ran twice, and a masked key echo was
not scrubbed. Deliberate breaks: printing without scrub (2 checks fail), cutting before scrubbing (1 check fails).

**P1 merged** as PR #60, merge commit 4b17f3e (CI green, EVAL PM SHIP 93). The workflow was started once on `main`: run 43669524263, outcome SKIP for every provider (no secrets), recorded as I-42.

**P2 (PR #61).** The fake Gemini change (grounding only when the request carries the search tool) went in as its own commit; the whole suite stayed green on it alone (2,322 checks). Then the rule, the readiness search call, the hint, the wording, tests and records. Full verify: 2,372 checks, 0 failed. Five deliberate breaks each failed checks (I-43 records that the first break was not faithful). The fresh-context review: OK TO MERGE with two findings: the `evaluate-query` cell exemption is unreachable with Gemini alone (recorded in TECH_DEBT 2.19) and the hint was decided from all engines' failures (now Gemini's only). The default model was not changed (no probe measurement).

**P2 merged** as PR #61, merge commit cbf093c (CI green, EVAL PM SHIP 93).

**P3 (PR #62).** `POST /api/audit/rerun`, `compareReports` (`src/reportCompare.ts`), the Run again button and the "Since the previous run" strip. Full verify: 2,457 checks, 0 failed. Four deliberate breaks each failed checks (inputs from the body, no `previousAuditId`, failed pairs counted, one-run pairs used). The fresh-context review (FIX BEFORE MERGE, small items) found two pure checks that could not fail (a positive newly-named rival; a `retrieval_failed` cell with text), a double-tap window, a banner and a strip tied to the page instead of the audit: all fixed, the two new checks each broken once and seen to fail. The UX tour found the strip and a failed audit's banner hidden under the sticky header on a phone (fixed: scroll offset and a scroll to the outcome when the re-run ends), identical dates (now date and time) and wording; the stale header counts after any failed audit and the owner-only idempotency scope are recorded in `TECH_DEBT.md` 2.22.

**P3 merged** as PR #62, merge commit af73e71 (CI green on both commits, EVAL PM SHIP 93). **End of session:** the engine probe was started again after the last merge (run 43673980851): SKIP for every provider, no secrets. The live check was started by hand after the last merge (run 43673983040) and passed; its signed-in part was skipped (no secrets). The default model was not changed. Nothing in the plan is left to build; what waits is the owner's O-8 and O-7 (`docs/PROGRAM.md`). Browser suites in this session ran on a Chromium alias (I-45).

## 2026-11-15 (second session): the engineering backlog, Group 1

Rows 13 to 15 of `docs/PROGRAM.md` were merged first, so the whole list was open. **G1.1 (PR #65).** `scripts/branch-status.sh` answered
"unknown" in a shallow clone (every cloud session starts in one, so hard rule 1 could not be met). It now runs `git fetch --unshallow`
(bounded) and judges; if that fails it prints the exact command. `STATUS_NO_DEEPEN=1` turns the deepening off for the test. The test gained
a shallow clone that is deepened and judged, and one that cannot be deepened and names the command. Switching the deepening off made 4
checks fail. Full verify: 2,467 checks, 0 failed (browser suites on the Chromium alias of I-45, PostgreSQL started by
`scripts/pg-test-cluster.sh`).
G1.1 review (fresh context, Opus): FIX BEFORE MERGE, all fixed. The "older merge" test was a copy of the first case (its branch had been deleted, so the clone fell back to main); a hung remote cost two timeouts back to back; a single-branch shallow clone lost the Stale line silently after deepening; a feature-branch shallow clone was never deepened. Now: the deepening fetches every branch in the same call, is skipped when the first fetch already failed, runs before the base-ref check, shows git's reason, and the older-merge test uses a branch that exists. Removing the branch refspec made 3 checks fail.
G1.1 second review round: a deepened single-branch clone kept a narrow fetch rule, so later runs judged from frozen remote refs; the always-run fetch now carries the all-branches rule, and the test runs twice on one clone with a merge and a deletion between runs and times a hanging remote (one bounded wait). Each break (rule removed, skip removed) fails a check.

**G1.1 merged** as PR #65, merge commit 61fd357 (CI green, EVAL PM SHIP 87, review SHIP after two fix rounds). **G1.2 (PR #66).** `.claude/settings.json` with three hooks and a read-only allow-list; `.claude/hooks/guard-git-add.mjs` (refuses `git add -A`, `--all`, `.`, `git commit -a/-am/--all`, ignoring text inside quotes and heredocs), `stop-branch-status.sh` (shows the branch status line as a system message; never blocks), `session-start.sh` (`npm ci` when the lockfile changed, starts the test PostgreSQL and exports `TEST_DATABASE_URL`, prints the first action). `test/claudeHooks.test.sh` in `npm test`. Not merged: it changes what every session may do without asking, so it waits for the owner's yes.
G1.2 review (fresh context, Opus): FIX BEFORE MERGE, fixed. The guard did nothing when its path had a space or a symlink (a "run only if executed directly" check compared a percent-encoded URL with a raw path); the rules moved to `guard-lib.mjs` and the entry file always runs. The quote handling hid later commands after an apostrophe in a double-quoted message: now one left-to-right scan. More ways to stage everything are refused (`:/`, `*`, `--a`, `--no-ignore-removal`, a full path to git, a command in parentheses). The "read-only" allow-list had `git log/diff/show`, which can write a file with `--output`: removed (the owner can add them back knowingly). `npm ci` could empty a working or symlinked `node_modules`: now skipped for a symlink, never run just because the stamp is missing, stamp written only after success; the start hook runs on `startup` only. The test now pins the allow-list to the exact reviewed list.
G1.2 second review round (Opus): FIX BEFORE MERGE, fixed. `git rev-list --output=` can empty a file, so it left the allow-list too (it now holds only `git status|rev-parse|ls-files`, `git remote get-url`, the branch-status script, `npm run lint`, `ls`, `wc`, `pwd`); a node_modules emptied by a failed `npm ci` was stamped as installed on the next start (now stamped only when `node_modules/.package-lock.json` exists, otherwise installed); the guard did not see through `sudo`, `env`, `timeout`, `xargs`, here-strings, `git stage`, `.//`, `./.`, `:/*`, `:(top)`, `..` and `--no-ignore-r`. Every one is now a check, and the deliberate breaks of each rule fail a check.
G1.2 EVAL PM round 1: REVISE 73 (stale PR description; the guard allowed git add -u, git commit . and refused -m "-a thing"). Guard fixed with checks; description rewritten from the file at the head.
**G1.8 (PR #69).** `vite`, `@vitejs/plugin-react`, `@tailwindcss/vite` and the client libraries vite bundles (`react`, `react-dom`, `lucide-react`, `motion`) moved to `devDependencies` (`vite` was listed in both); `dependencies` is now `@google/genai`, `dotenv`, `express`, `pg`. `package-lock.json` regenerated with `npm install --package-lock-only` (no version, resolved or integrity value changed; npm re-flagged dev packages and added six optional `inBundle` entries under `@tailwindcss/oxide-wasm32-wasi`). `vercel.json` gained `installCommand: npm ci --include=dev` (EVAL PM 73 REVISE: without it a production-only install on Vercel could drop the bundler silently, and `live-check.yml` does not report failed deployments). Dependabot gained an npm entry: weekly, security updates only, grouped (`open-pull-requests-limit: 0` switches off routine bumps). `test/dependencyLayout.test.sh` pins both. Full verify after a clean `npm ci`: 2,481 checks, 0 failed (the production-install check inside it installs with `--omit=dev` and boots the built server).
G1.8 review (Opus): FIX BEFORE MERGE, fixed. The dependency move itself held (the bundle loads only the four production packages; lockfile only re-flags dev packages). The Dependabot entry opens nothing while the repository setting "Dependabot alerts" is off (the API answered 403 "disabled"), so the claim was false: now stated as not effective until O-9, with numbered owner steps. The import test missed dynamic and multi-line imports: it now reads the built `dist/server.cjs`; the `open-pull-requests-limit: 0` line and the npm entry are pinned.
**G1.4 (PR #68).** The review seats (`adversarial-reviewer`, `eval-pm`) are pinned to `opus`; `docs/ENGINEERING_STANDARDS.md` section 10 records the pairing and the override rule for an Opus author; `test/reviewAgents.test.sh` fails when a review seat has no pinned model, pins `inherit`, or pins anything containing `sonnet`, the author model hard-coded in the test (it does not read the standards). A `docs/DECISIONS.md` entry records the reversal of PR #64's pin.
G1.4 review (Opus): FIX BEFORE MERGE then OK TO MERGE. Found: the test passed for `inherit`, quoted or capitalised `sonnet`, trailing comments, a missing line-1 fence and duplicate keys; the rule covered only Sonnet and Opus authors; no decision entry; "default session model" had nothing behind it. All fixed with a check each; EVAL PM 87 SHIP.
**G1.3 (PR #67).** `.claude/skills/ship/SKILL.md`: the merge gates as one procedure (suite, pull request from the template, CI, fresh-context review on a different model, fixes, EVAL PM, merge with the hash from `git rev-parse HEAD`, check `main`, branch status). `test/shipSkill.test.sh` keeps it true: front matter, each gate named in order, every file it points at exists; renaming the `eval-pm` gate fails a check.

**G1.9 (PR #71).** `src/modelCalendar.ts` (data and the pure rule `checkCalendar`), `scripts/model-calendar-check.ts`, `.github/workflows/model-calendar.yml` (weekly, goes red with a sentence per problem), `test/modelCalendar.test.ts` in `npm test`. The four defaults were read on the vendors' own pages on 2026-11-15 (a web-fetch agent; final URLs recorded in each entry): Gemini `gemini-3.6-flash` listed, no shutdown date, free-tier "Grounding with Google Search" "Not available"; Claude `claude-sonnet-5-5` Active, retirement "not sooner than September 28, 2027" (tentative, not used as an end date); **OpenAI `gpt-5` Deprecated, shutdown Dec 11, 2026** (replacement named: `gpt-6.1-sol`, not checked against the Responses API); Perplexity `sonar` listed (page prefixes the id and covers the Agent API; the bare chat id is unconfirmed). The finding of the day: the ChatGPT default ends in 26 days, which is why the check is a weekly workflow and not a merge-blocking test; the owner decision is O-10 in `docs/PROGRAM.md`.
G1.9 review (Opus, fetched the vendor pages itself): FIX BEFORE MERGE, fixed. The Perplexity entry was green though Perplexity's migration page says chat-completions support ended 2026-09-27 (an agent's one-page summary had missed it; I-55): now recorded as an end date and listed as due. The workflow wrote its step summary only on success (`bash -e`) and relied on an email that goes to whoever last edited the cron line: it now opens, comments on and closes ONE tracking issue like live-check.yml, and names the 60-day pause. Dates that do not exist (Feb 30) are refused instead of shifted; a bad confirmation date no longer hides an imminent end date; the pages to re-read include the deprecations pages. NOT done: a way to acknowledge a known problem so red means new (the issue stays open and is commented weekly instead; O-10 says so).
**G1.7 (PR #70).** `scripts/commitCheck.mjs` (`commitVerdict`) and `scripts/smoke.mjs --expect-commit <sha>`: the live site's `/api/health` commit must be the expected one, else a FAIL with a sentence naming both and pointing at Vercel's Deployments page; a site that reports no commit is a failure "could not be compared", never a match. `live-check.yml` passes the finished deployment's own sha when a deployment triggered it (main may already be a commit ahead while that deployment builds, which is not a fault), else the head of main read with `git ls-remote`. `test/liveCommit.test.ts` is in `npm test`. NOT verified: a real Vercel site (the sandbox cannot reach it); that `github.event.deployment.sha` is set on the trigger the workflow uses.
G1.7 review (Opus): FIX BEFORE MERGE, fixed. A reported commit of one character matched (only the expected side was validated); two test assertions could not fail (the stand-in always fails the rest of smoke, so the exit code proved nothing: now the flag must add exactly one FAIL line); the workflow test did not check the DEPLOYED_SHA env line; `--expect-commit` with no value or as `=sha` silently skipped the check; `git ls-remote` could match a suffix-named branch; an unreadable head only warned; the mismatch sentence claimed the site was behind though it cannot know the order. All fixed with a check each.

**G1.9 merged** as PR #71, merge commit 5a7e369 (CI green on the head, EVAL PM 87 SHIP). **End of the engineering session of 2026-11-15.** Merged: G1.1 (#65, 61fd357), G1.3 (#67, 2a1a589), G1.4 (#68, a29d152), G1.8 (#69, bace3e4), G1.7 (#70, 0854cf0), G1.9 (#71, 5a7e369). Open and waiting on the owner's yes by design: G1.2 (#66, the `.claude` settings and hooks; EVAL PM 87 SHIP, CI to be read on its head). Not started: G1.5 (test runner), G1.6 (parallel CI), all of Group 2 (G2.6 held), nothing in Group 3 (none was asked for). Every merged item went through a fresh-context Opus review that found real defects (two to three rounds each) and an Opus EVAL PM. One CI run failed once with `EADDRINUSE` in `engineProbe` (I-53) and passed on the next head. New owner items: O-9 (turn on Dependabot alerts and security updates) and O-10 (ChatGPT `gpt-5` ends 2026-12-11; Perplexity chat-completions support ended 2026-09-27; both engines are paid and off). First live-check run after these merges will show whether production reports its commit (TECH_DEBT 2.21).
Corrections after the review of this records change: the table rows for G1.1 and G1.2 were stale and are fixed; the suite count is 58 (53 before the session), not 47; seven items were attempted, not nine. **Where the EVAL PM scores are:** the scores for #65 (87), #67 (87), #68 (87) and #66 (87 SHIP, after a first 73 REVISE) are in their pull request bodies; #69's body records only its first 73 REVISE; the scores for #69 (93), #70 (93) and #71 (87) were relayed in the session and are recorded here (the #70 and #71 bodies say "pending"). **#66 is not mergeable as it stands:** GitHub reported conflicts after main moved (G1.7, G1.9); it needs main merged in again, a green CI on the new head and the owner's yes. **Vercel:** every pull request push builds a preview, and on 2026-11-15 Vercel answered "Deployment rate limited, retry in 24 hours" (more than 100 deployments a day on the free plan, I-56). A production deployment of a later merge may not run until the window resets, so the live check (G1.7) can be red for that reason, not because of its own defect.
