# Program: where the product stands and what is next

Living document. Read it at the start of any session, update it at the end. Status
words mean exactly: **done** (merged and verified, with how), **in progress**,
**blocked** (names what it waits on), **next**, **open question**. The mandate is
`docs/OWNER_DIRECTIVES.md`; the design is `docs/RELIABILITY.md`; the reasons are
`docs/DECISIONS.md`; the history is `docs/SESSION_LOG.md`.

Last updated: 2026-11-15.

**State on 2026-11-15 (read this first):** `docs/PLAN_2026-11.md` P0 to P3 are all built and merged: P1 the engine probe (PR #60), P2 an
unsearched answer is not counted, the readiness check asks what an audit asks, a quota-failed audit carries a hint (PR #61, `metricVersion`
3), P3 Run again and "Since the previous run" (PR #62). **Nothing a real engine returns has been measured yet**: the probe ran twice
(runs 43669524263 and 43673980851) and printed SKIP for every provider because the repository secrets are not set. **The default model
was therefore NOT changed** (`gemini-3.6-flash`, which Google lists as having no free search); the owner's lever is `GEMINI_MODEL` (O-7).
**What waits on the owner:** O-10 (OpenAI default model ends 2026-12-11; no audit is affected while paid engines are off), O-9 (turn on Dependabot alerts and security updates, 2 minutes), O-8 (probe keys), then O-7 (model), then one real audit on the live site; O-3 step 4 (the daily check's sign-in)
and O-6 (Google sign-in) are unchanged. **Next for the assistant, once O-8 is done:** start the `engine-probe` workflow, write the real
results into `docs/INSIGHTS.md` (MEASURED) and the ledger below, save one scrubbed real reply per provider under `test/fixtures/real/`, then
decide the default model (`docs/PLAN_2026-11.md` P2 item 4, which was deliberately left) and write the plan for a second engine
(`docs/PLAN_2026-11.md` "Not in this plan"). Without keys there is nothing further in the plan to build; the engineering backlog
(`docs/ENGINEERING_BACKLOG.md`) is the other queue and needs its own session.

**Stale lines below, corrected here rather than rewritten (2026-11-14):** the live check of 2026-11-14 (run 43603783051) reports
sign-in set, an engine key set and durable storage. So "Storage on Vercel is process memory" (section 1), "What is left is the
owner's: add `DATABASE_URL`" (row 8), "sign-in is impossible today" (O-3) and "nothing has connected" (ledger) describe an earlier
state. What the run did not print is which kind of store answered, and no signed-in check has run.

**Check this first (a failure that happened once and is fixed):** run
`git remote get-url origin` in `/home/user/GEO-audit-studio`. It must print
`https://github.com/pamelaestivam/GEO-audit-studio`. On 2026-10-10 a review agent had
changed it to a dummy address and left a stray empty commit on local `main`. The owner
authorised the repair and it was done (set the URL back, fetch, reset `main` to
`origin/main`). If it ever recurs, ask the owner to authorise those same commands rather
than looking for another way round. History: `docs/SESSION_LOG.md`; lesson: I-13.

**First action for a cold session:** run `npm ci && npm run verify` (it should report
0 failures), then continue from the state paragraph above (as of 2026-11-15 every package of `docs/PLAN_2026-11.md` is merged).
The owner actions in section 3 run in parallel and block only the rows that name them;
never wait on them to do the others.

## 1. Where it runs

| Fact | Evidence |
|---|---|
| Vercel project `geo-audit-studio` (team `estivampam-9565s-projects`) builds every PR branch and `main`; the preview of the report PR was "Ready" | READ from the Vercel bot comment on PR #26 |
| Production URL `https://geo-audit-studio-five.vercel.app/` | READ from `TECH_DEBT.md` 1.4; the sandbox cannot reach it, so **whether it loads, whether sign-in works, and whether the secrets are set are NOT verified** |
| Storage on Vercel is process memory; the audit runs after the response is sent; limiters, quota breaker and pacer are per-process | READ in `server.ts` (`void runJob(...)` after the 202) and `src/store.ts`; consequence for reliability is INFERRED, not measured |
| Merges so far ran under the owner's GitHub login; PR previews still built | READ |

Until the durable store (item 8) ships, treat the deployment as a preview. Do not
tell the owner or a client that it is dependable.

## 2. Roadmap

| # | Item | Status | Waits on |
|---|---|---|---|
| 1 | Independent review (defects D1 to D8) and fixes #19 to #25 | done | merged to `main`; full suite 1,092 checks passed, 0 failed (MEASURED 2026-10-10) |
| 2 | Records: owner directives, decisions, session log, insights, this file | done | merged #27 (bddd7f9) |
| 2b | Session hygiene: branch-status script and test, `CLAUDE.md` rules, resume routine | done | merged #31 (09aaa88) |
| 2c | Remove a stray `node_modules` symlink from `main`; CI fails on tracked symlinks | done | merged #29 (d851fb2) |
| 2d | Test infrastructure: the intermittent end-to-end failures were suites drawing ports Node's `fetch` refuses; ports now come from `test/ports.ts` with a guard test; failures print the server's own output; the Gemini client's per-request time limit is built and waits for its own PR | done | PR #52 (cause MEASURED by pinning ports; that every red run of 2026-10-10 was this is INFERRED: `TECH_DEBT.md` 2.14, `docs/INSIGHTS.md` I-21) |
| 3 | a. Honest first visit: storage-mode line, "no engine configured", default 2 questions, "n of M" | done | merged #30 (19005fc); CI green, full suite and browser checks passed, review findings fixed. The branches `claude/honest-first-visit` (backup patch) and `claude/session-hygiene*` are obsolete leftovers |
| 4 | b. Docker out of the required checks; CI smoke runs `dist/server.cjs`; daily live-site check | done | merged #32 (01c4049): `docker.yml` (informational; its run on the PR, https://github.com/pamelaestivam/GEO-audit-studio/actions/runs/38031734681, was read from the Actions tab and passed), `live-check.yml` (first run 2026-10-10, see section 4), restart and backup proof in `prod-install-check.sh`. Dependabot keeps the action pins current |
| 5 | c. Invariants, number guard, "Not counted" panel, cited-only as its own number (decision A) | partly | first half merged (#33, 6025447: report invariants, zero-figure guard on the summary, proved end to end); second half merged (#40, ac4ac15: the "Not counted" strip and list for discarded inaccuracy claims, with reasons); the cited-only number is built (decision A: visibility counts only answers that name the brand; the site cited without the name is its own number, `metricVersion` 2; merged #49, c09381d); an incidents record exists (step g); not built: "Not counted" rows for other kinds of discarded item (TECH_DEBT 2.15) |
| 6 | d. Paid-engine refusal and call counters ($0 guard, per instance) | done | merged #39 (145ca8c, `src/spendGuard.ts`); the cross-instance counter waits for the durable store (row 8) |
| 7 | e. Step-wise audit state machine, leases, incidents; default returns to 3 | partly | slice S1 (pure seams: `src/auditPipeline.ts` with `planAudit`, `analyseEvidence`, `assembleReport`, proved unchanged by a twelve-scenario golden-report test; the failed-audit shape stays in `server.ts`) merged (#42, e3e3d78); slice S2 (the store contract for steps, leases, attempts and incidents on both stores; merged #43, 06645d1); slice S3 (an audit now runs as recorded steps under leases, driven in-process; same results on every scenario the tests can reach, which fake only Gemini: twelve golden reports, the quota, retry and restart suites and a step-vs-calls boundary test; the several-engine path is untested and runs engines one after another; merged #44, 05d5bca); slice S4 (the page can drive an audit one step at a time, which is what Vercel uses; a lost job on a stateless deployment is reported as interrupted with how far it got; abandoned audits stop holding slots; a reaped audit that had already made a call stays billable; merged #45, f866429); slice S5 (on a durable store an audit that was running when the server died is taken up again from the step it was on, with every repeated paid call counted and recorded; proved by killing the real server with SIGKILL; merged #46, 1f3f779); S6 deferred on purpose (scoping and reasons in `docs/PLAN_STEP_E.md`, 2026-10-10: the 15-minute reaper bounds a hung audit's row on every submit, job read and advance, but not the process: a Gemini call with no HTTP timeout can still block the queue, and the breaker, counter and pacer reset on restart; both recorded in TECH_DEBT); S7 (stalled / Resume / Discard in the UI and the extra job fields) is next; on Vercel with the memory store a lost audit is still not recoverable. Planned in seven slices in `docs/PLAN_STEP_E.md` (S1 pure seams, S2 store contract, S3 engine and inline driver, S4 client driver for Vercel, S5 resume on a durable store, S6 shared pacer/breaker/counter, S7 stalled/resume UI). On Vercel with the memory store it can make a lost audit VISIBLE but not recoverable: that needs row 8 |
| 8 | f. PostgresStore on Supabase | partly | BUILT 2026-11-04 (`src/postgresStore.ts`, the pull request that carries this line) and proved on a real PostgreSQL 16 (contract suite, two-process end-to-end; `TECH_DEBT.md` 2.17). The owner created the Supabase project on 2026-11-04 (free plan, GitHub link empty, Data API off, automatic RLS on; the Transaction pooler string is the one to use). What is left is the owner's: add `DATABASE_URL` in Vercel and redeploy once (O-4 step 3), then read `/api/audit/status` for `postgres`. NOT verified: the first connection from Vercel to Supabase |
| 9 | g. Deep health, owner health section, scheduled canary with one deduplicated issue | partly | the scheduled live check with one tracking issue is built (`live-check.yml`, #32) and has run once by manual dispatch (it exposed the unconfigured site, issue #36); its trigger on a finished Production deployment is proven (runs 38034259443 and 38034319845 fired on main after the merges of #33 and #34); the deep readiness endpoint exists (`/api/audit/readiness`) and now includes a `recent trouble` check that reads the audits that ended in the last 24 hours together: serious = a step threw or ran out of tries, a report broke its own consistency rules (now recorded as an incident), the driver failed, an audit ended in error with no reason, or EVERY audit came back empty; noted but not a fault = stopped for taking too long, interrupted by a restart, a repeated call, a few empty audits among successes. On a server that keeps nothing across restarts it says "Not checked" rather than claiming health. **The daily live check only runs it when the owner adds two repository secrets (O-3 step 4); until then each run warns that the signed-in checks were skipped.** Merged #47 (97ae7e1); the smoke script prints a `warn` line, not a green one, for any readiness check that passed only because it could not look, and `--warn-non-durable` now also softens the signed-in `readiness: storage` entry (it used to fail there, which would have turned the daily check red the day the sign-in secrets were added while the live site is on a memory store); a check that is not ok still FAILS whether or not it could be verified (`scripts/readinessLine.mjs`, unit-tested). A page that shows the owner the list is not built | O-3 for the live URL |
| 10 | Real-engine verification: one real audit read by a person against the raw answers; record fixtures from it | blocked | owner actions O-1 and O-2 |
| 11 | Branch protection and auto-delete of merged branches | blocked | owner action O-5 |
| 12 | Sign in with Google (`TECH_DEBT.md` 1.5): "Continue with Google" first, access code second, only invited addresses | partly | BUILT 2026-11-09 (`src/googleAuth.ts`; unit, built-server and browser checks use a fake Google; the protections were each broken in turn and a check failed; independent security and UX reviews done). Waits on the owner's Google Cloud client id and the invited list (O-6); not yet tried with a real Google account or Google's real button |
| 13 | Gemini free web search: the default model `gemini-3.6-flash` is listed by Google as having none on the free tier; make the failure visible and move to a model that has it | **partly: the code half is built and merged (PR #61) (2026-11-15, P2: an unsearched answer is not counted, the readiness check asks what an audit asks, a quota-failed audit carries a hint; `metricVersion` 3); the default model is NOT changed because the probe has no measurement yet (O-8); the owner's lever stays `GEMINI_MODEL` (O-7)** (`docs/PLAN_2026-11.md` P2; row 7's S6 and S7 are held until real audits exist, `docs/DECISIONS.md` 2026-11-14) | found 2026-11-14 (`docs/STRATEGY_2026-11-14.md` section 1, `TECH_DEBT.md` 2.19, I-36, I-37). Owner: O-7 (look at the limits, set `GEMINI_MODEL`, run one audit). Assistant: `docs/PLAN_2026-11.md` P2 (a searched-or-not flag on each Gemini answer, a readiness call that searches, a hint on a quota-failed audit; the quota sentence itself stays, see `TECH_DEBT.md` 2.19). NOT measured: what the owner's key returns |
| 14 | The engine probe: real replies from real engines, read from a workflow log (`docs/PLAN_2026-11.md` P1) | **built and merged** (PR #60, 4b17f3e); the first two runs (43669524263, 43673980851) printed SKIP for every provider (I-42) | owner action O-8: add `PROBE_GEMINI_API_KEY` (and optionally Mistral and Groq keys), then ask the assistant to start the workflow |
| 15 | Run an audit again and show what changed (`docs/PLAN_2026-11.md` P3) | **done**: merged PR #62 (af73e71), 2026-11-15; CI green (run on head de37da1, PR #62 checks), EVAL PM SHIP 93 (recorded in the PR description), review findings fixed; 2,457 checks in the full verify; proved on the built server with a fake Gemini and in Chromium desktop and phone. NOT verified: real engines, a live URL | nothing |
| 16 | A second searching engine; the written analysis off Gemini (strategy steps 4 and 5) | blocked | what the probe (row 14) measures on free keys |
| 17 | Engineering backlog: tool chain, architecture, coding (`docs/ENGINEERING_BACKLOG.md`, three groups) | **in progress** (session of 2026-11-15; rows 13 to 15 were merged first). The per-item state is the table at the top of `docs/ENGINEERING_BACKLOG.md`; G1.1 merged (#65, 61fd357); G1.3 (the `ship` skill) merged (#67, 2a1a589); G1.4 (reviewers on another model) merged (#68, a29d152); G1.7 merged (#70, 0854cf0); G1.8 merged (#69, bace3e4; the Dependabot half waits on O-9); G1.9 merged (#71, 5a7e369); G1.5, G1.6 and Group 2 not started (the table in the backlog says why) | the owner: G1.2 (the session's own settings) merges only on their yes in conversation; G2.6 (slice S6) is held |

**Stale remote branches:** merged branches are not deleted automatically (the session
cannot delete them). `bash scripts/branch-status.sh` lists them; turning on GitHub's
"Automatically delete head branches" (O-5, step 1) fixes this for good.

## 3. Owner actions (the session cannot do these; why, and the exact steps)

Steps are as of 2026-10 and the screens may be labelled slightly differently. **Every
menu label below is unverified**: the assistant could not open these sites to check.
Never paste a key or token into chat; keys go in the places named below.

**O-1. Let the assistant's workspace reach the web.** *Why only you:* the cloud
environment's network policy is set in the environment's settings, and the assistant
cannot edit it (tested: every outside host fails with "name not found").
1. In the session's title bar open the cloud environment menu, then **Edit**.
2. Under **Network access** choose a broader level, or under **Allowed domains**
   add: `geo-audit-studio-five.vercel.app`, `vercel.com`, `supabase.com`,
   `ai.google.dev`, `generativelanguage.googleapis.com`. Leave "Allow package
   managers" ticked. (The database itself is reached by the deployed site, not by the
   assistant's workspace, so `*.supabase.co` is not needed for that.)
3. Start a new session (the setting applies to new sessions).
*Unblocks:* opening the live site from the assistant's side, reading vendor docs,
and (with O-2) a real audit.

**O-2. A free Gemini key for real runs.** *Why only you:* creating a key needs your
Google login; secrets must never be in the repo or in chat.
1. Open `https://aistudio.google.com/apikey` and create a key in a project that has
   **no billing account** (this is what makes the $0 promise real; the page shows
   whether billing is enabled).
2. Put it in the environment settings (same menu as O-1) as a secret or environment
   variable named `GEMINI_API_KEY`. Tell the assistant only the variable name.
3. Put the same key in the Vercel project (O-3).
*Then:* record the date you confirmed "no billing" in the table in section 4.

**O-3. Check the Vercel project.** *Why only you:* it needs your Vercel login. **Measured 2026-10-10 by the live check (issue #36), production URL only (Preview not measured): `SESSION_SECRET` and `ACCESS_CODES` are not set, and no engine key is set (so `GEMINI_API_KEY` is among the missing), so sign-in is impossible today.**
1. `vercel.com` then project `geo-audit-studio` then **Settings** then **Environment
   Variables**. Confirm these exist for Production and Preview: `SESSION_SECRET`
   (32 or more random characters), `ACCESS_CODES` (`yourname=a-long-code`),
   `GEMINI_API_KEY`.
2. **Settings** then **Functions**: note the default and maximum duration (the design
   assumes up to 300 s; if it says 10 s, tell the assistant). Note `vercel.json` sets no
   `maxDuration` of its own, so what the dashboard shows is what the functions get; the
   first step-wise PR will set it explicitly.
3. **Deployments**: confirm the latest Production deployment says Ready.
4. (After step 1 works and you can sign in.) So the daily live check can look for failed audits, give it a sign-in:
   on GitHub, repository **Settings** then **Secrets and variables** then **Actions** then **New repository secret**,
   twice: `LIVE_CHECK_EMAIL` (any email) and `LIVE_CHECK_ACCESS_CODE` (one of the codes in `ACCESS_CODES`). Until both
   exist, each daily run prints a warning that the signed-in checks were skipped; nothing else changes. These checks
   make two real Gemini calls (a plain one and one that searches the web) each time the live check runs (daily, and after each Production deployment; at most
   once every five minutes, up to three tries per run), counted by the $0 guard.
Optional and faster: connect the **Vercel** connector in claude.ai (Settings then
Connectors). It gives the assistant read access to projects and deployments, so the
assistant can check this itself. It does not set variables.

**O-4. A durable database (Supabase).** *Why only you:* it needs your Supabase and
Vercel logins and creates an account-level resource.
1. Create a Supabase project (free plan) at `supabase.com`.
2. In Vercel, **Integrations** then add **Supabase** and link it to
   `geo-audit-studio`; this copies the connection variables into the project
   (AGENT-level: verify the integration is offered on the free plan). If it is not,
   copy the project's **pooled connection string** into a Vercel variable named
   `DATABASE_URL`.
3. **(Updated 2026-11-04, after the store was built.)** In Supabase, **Connect**, **Connection String**, Type **URI**, Method
   **Transaction pooler**; replace `[YOUR-PASSWORD]` with the database password (**Reset database password** if it is
   not saved). In Vercel, **Settings**, **Environment Variables**, add `DATABASE_URL` with that string, **Production
   only** (not Preview: a preview of a branch with a schema change would upgrade the production database), **Sensitive**
   on; then **Redeploy** the Production deployment once. Never paste the string into chat. Then
   open `https://geo-audit-studio-five.vercel.app/api/audit/status` and look for `"kind":"postgres"`. If a connection error
   shows in the Vercel logs, `docs/DEPLOYMENT.md` 4b says what to try (the Session pooler string).
   The next line in this list is the original step, kept for the record: tell the assistant "the database is ready". Optional: connect
   the **Supabase** connector in claude.ai so the assistant can create the schema
   itself.
Know before you start: the Supabase free plan pauses a project after about a week
without activity (AGENT); the scheduled canary (item 9) is what keeps it awake.

**O-5. Branch rules.** *Why only you:* the assistant's GitHub tools include no
branch-protection, ruleset, repository-settings or delete-branch tool (searched
2026-10-10), and the git proxy refuses to delete branches (HTTP 403, tested).
1. GitHub, repository **Settings**, **General**: tick **Automatically delete head
   branches**. (This removes merged branches by itself, which fixes the 403 problem.)
2. **Settings**, **Rules**, **Rulesets**, **New branch ruleset**: target the default
   branch; enforcement **Active**; tick **Restrict deletions**, **Block force pushes**,
   **Require a pull request before merging** (0 approvals), **Require status checks**
   (add `test`, which already includes lint; a check only appears in the list after it has run once; do not add a check named `lint`, it does not exist). Leave the
   bypass list empty.
3. If GitHub says rulesets are not available for a private repo on your plan, tell
   the assistant; the fallback is to rely on the CI workflow and the standing
   delegation in `docs/DECISIONS.md`.

**O-6. Google sign-in: a client id and the invited list.** *Why only you:* it needs your Google login and your decision on who
is invited. Steps are in `docs/DEPLOYMENT.md` 4c: (1) Google Cloud Console, OAuth consent screen (External, basic scopes, publish);
(2) Credentials, OAuth client ID, Web application, authorized JavaScript origin `https://geo-audit-studio-five.vercel.app`, copy the
Client ID (no secret is used); (3) Vercel, Production only: `GOOGLE_CLIENT_ID` and `GOOGLE_ALLOWED_EMAILS` (the addresses allowed to
sign in); (4) redeploy once; (5) try it and tell the assistant what the page shows. Labels in the Google console are unverified (the
assistant cannot open it).

**O-7. Find out whether Gemini still searches for free, and switch model (about 15 minutes).** *Why only you:* the workspace holds no
Gemini key and cannot open AI Studio or Vercel (tried 2026-11-14: `GEMINI_API_KEY` is not set here; O-1 lists the blocked hosts).
1. Open `https://aistudio.google.com`, sign in, and open the rate-limit page for the project that owns the key. Find the line for
   search grounding. Tell the assistant the number beside Gemini 3 and beside Gemini 2.5, and the requests-per-day shown for
   `gemini-2.5-flash-lite`.
2. Vercel, project `geo-audit-studio`, **Settings**, **Environment Variables**: add `GEMINI_MODEL` with the value
   `gemini-2.5-flash-lite`, **Production** only. **Redeploy** the Production deployment once.
3. Sign in to the live site and run one audit with one question. Send the assistant a screenshot of the result and of the answer text.
Know before you start: this changes the model the report names (an older, smaller Gemini). It is the only one Google still lets a
free key search with (READ on Google's pricing page, 2026-11-14), and it is the last of its generation, so it may be withdrawn too.
On this model "Auto-Detect" and "Generate Query Matrix" may stop working (they ask for a search and a structured reply in one
request, which older models are believed to refuse; unverified, and they probably do not work today either if search is refused).
Typing the details yourself always works. If you would rather wait for a measurement first, skip step 2 until the probe has run (O-8,
written when `docs/PLAN_2026-11.md` P1 is merged).

**O-8. Give the engine probe its keys, then ask the assistant to run it (about 10 minutes).** *Why only you:* a session cannot create
repository secrets, and creating a key needs your own login at each provider. The probe (`scripts/engine-probe.mjs`, workflow
`engine-probe`) asks real engines a few harmless questions ("What are the best poke restaurants in Austin, Texas?") and prints what came
back, so we learn whether free web search really works for each. Each run makes at most 20 free calls. **The workflow log is public** (the
repository is public): it shows the questions and the engines' answers, never a key (the script removes keys and project numbers before
printing, and a test proves it). Labels below are unverified (the assistant cannot open these sites).
1. Gemini (the one that matters most): open `https://aistudio.google.com/apikey` and use the same free key that is on Vercel, or create
   one in a project with **no billing account**. Copy it.
2. On GitHub open the repository, **Settings**, **Secrets and variables**, **Actions**, **New repository secret**. Name:
   `PROBE_GEMINI_API_KEY`. Value: the key. **Add secret**.
3. Optional, same screen: a free Mistral key (`https://console.mistral.ai`, create an API key) as `PROBE_MISTRAL_API_KEY`, and a free Groq
   key (`https://console.groq.com/keys`) as `PROBE_GROQ_API_KEY`. **If either site asks for a card, stop and tell the assistant**
   (the directive is $0).
4. Tell the assistant "the probe keys are in". It starts the workflow (or you can: **Actions**, **Engine probe**, **Run workflow**) and
   writes the results into `docs/INSIGHTS.md`. Until then every run prints SKIP lines, which is a valid result.
Why it matters: P2's choice of model (`docs/PLAN_2026-11.md` P2 item 4) is made only on this measurement.


**O-9. Turn on Dependabot alerts and security updates (about 2 minutes; assistant cannot: a configuration file cannot switch it on, and the repository reports "Dependabot alerts are disabled").** *Why:* `.github/dependabot.yml` now has an npm entry for security updates, but until these two settings are on it opens nothing, and an advisory is again seen only when CI goes red (I-22). 1. Open https://github.com/pamelaestivam/GEO-audit-studio/settings/security_analysis. 2. Next to "Dependabot alerts" press Enable. 3. Next to "Dependabot security updates" press Enable. 4. Tell the assistant "O-9 done"; the assistant cannot read this setting back through its tools, so it will say it is unverified until the first Dependabot pull request or alert appears.

**O-10. Decide what to do about the ChatGPT default model `gpt-5`, which OpenAI lists as deprecated with shutdown on 2026-12-11 (read 2026-11-15; `src/modelCalendar.ts`).** *Why it waits on you:* the engine is paid and switched off ($0 directive), so no audit is affected today; a replacement id changes what a paid audit would cost and measure, which is your call. 1. Do nothing now if you will not turn on paid engines before 2026-12-11: the weekly model-calendar check keeps ONE tracking issue open and comments on it each Monday until the ids are changed (it also shows that Perplexity's chat-completions support ended 2026-09-27, `sonar`, same decision). Because known problems keep that issue open, a NEW problem arrives as one more line in the same issue, not as a new issue. 2. Or tell the assistant "change the OpenAI default"; it will read OpenAI's page again, pick the replacement the page names (it listed `gpt-6.1-sol`; whether that id works with the Responses API search tool was NOT checked), change `src/providers.ts` and the calendar together, and ask you before anything is spent.
## 4. Verification ledger (what has actually been checked, and what has not)

| Claim | Status | How / date |
|---|---|---|
| Full suite on `main` after the 2026-10-09 merges | verified | `npm run verify`: 1,092 checks passed, 0 failed, 0 vulnerabilities; 2026-10-10 |
| Start-up with no key, dev sign-in, empty engine list | verified | run on merged tree; 2026-10-10 |
| Anything a real answer engine returns | **not verified** | no key, no network in the sandbox |
| Live site loads and its API answers at every depth | verified | `live-check` run https://github.com/pamelaestivam/GEO-audit-studio/actions/runs/38033024298 (manual dispatch, 2026-10-10 about 07:02 UTC, against the workflow's default URL `https://geo-audit-studio-five.vercel.app`, production only; the date and time are from the run page): every frontend and API check passed, and only the two configuration checks below failed. The refusal checks passed, but they accept 503 as well as 401, and an unconfigured server answers 503 to everything, so this shows "an unconfigured server refuses everything", not that sign-in enforcement works (401 under real sign-in has not been exercised live) |
| **Live site is configured: sign-in secrets and an engine key present** | **MEASURED: NOT CONFIGURED** | same run: `SESSION_SECRET` is not set, `ACCESS_CODES` is not set, no engine key is set (issue #36). Nobody can sign in to the live site and no audit can run until the owner sets these in Vercel (O-3, O-2). |
| Live site storage | MEASURED: memory only | reported as a warning by the same run (`--warn-non-durable`) |
| `live-check` trigger on a finished Production deployment | verified | after the merges of #33 and #34 Vercel's bot fired the workflow on `main` (runs https://github.com/pamelaestivam/GEO-audit-studio/actions/runs/38034259443 and https://github.com/pamelaestivam/GEO-audit-studio/actions/runs/38034319845, both executed rather than skipped, and failed on the same two configuration checks); Preview deployments fire it too and are skipped by the job condition. A run for #32's merge shows as cancelled, consistent with the concurrency group keeping only one pending run (which run replaced it was not checked) |
| Vercel function maximum duration on this project | **not verified** | AGENT says 300 s with fluid compute |
| Gemini free grounded-prompt allowance | **not verified** | sources disagree (1,500 per day vs 5,000 per month) |
| Google project has no billing (the $0 control) | **not verified** | owner action O-2 |
| Supabase free-plan scheduled jobs | **not verified** | AGENT silent |
| The owner's Gemini key is accepted by Google | verified | one read-only model-list request returned HTTP 200 (2026-10-28 session; the key's project shows "Free tier" with "Set up billing" in AI Studio, owner screenshot; the project number in the key dialog and the project id in the list were matched by inference only) |
| Live site sign-in works | verified by the owner | owner reported getting in on 2026-10-29 after adding `SESSION_SECRET` and `ACCESS_CODES` and redeploying (a screenshot showed the signed-in app) |
| Live site had an engine key | **not working as of 2026-10-29** | the signed-in app said "No answer engine is configured on this server"; `GEMINI_API_KEY` was replaced in Vercel the same day; whether a redeploy then took effect was not reported. Re-check `/api/audit/status` `engines` |
| PostgresStore against a real PostgreSQL 16.15 | verified | `test/store.test.ts` (159 postgres checks), `test/postgresE2E.test.ts` (28), `test/postgresConfig.test.ts` (26) and `test/testIsolation.test.ts` (18), local on a UTF8 server and in CI; deliberate breakages (no advisory lock, no row lock, no owner guard, no error listener on a checked-out connection, closing a timed-out connection, the JSONB cast, an unreadable plan answering NULL, no rounding, a raw log line, no start-up claim rule, no replay of a lost click or of a click refused by the caps, a suite that starts the server, in a child process or in its own, without removing DATABASE_URL) each made a check fail |
| PostgresStore against Supabase's pooler, from Vercel | **not verified** | nothing has connected; see `TECH_DEBT.md` 2.17 |
| Vercel Hobby deployment cap | MEASURED twice | refused a redeploy on 2026-10-28 ("more than 100 in 24 hours", account-wide); the project's own list showed 8 deployments, so the count includes other projects or deleted deployments |
| Free Gemini web search on the default model `gemini-3.6-flash` | **READ: "Not available" on the free tier; not measured on the owner's key** | Google's pricing page, fetched 2026-11-14 (I-36); owner action O-7 |
| Live site: engine key, sign-in, durable storage | MEASURED | `live-check` run https://github.com/pamelaestivam/GEO-audit-studio/actions/runs/43603783051 (2026-11-14): all three pass; the signed-in checks were skipped (no secrets). Which store kind it reported was not printed |
| A real audit on the live site returns a measured answer | **not verified** | nobody has reported one; see row 13 |
| Run again and "Since the previous run" | verified against a fake engine only | `test/rerunE2E.test.ts`, `test/rerunUi.test.ts`, `test/reportCompare.test.ts`; four deliberate breaks each failed checks (PR #62); not tried on the live site |
| An answer without a web search is not counted; readiness asks with search | verified against a fake engine only | `test/unsearchedE2E.test.ts`, `test/searchedAnswer.test.ts`, five deliberate breaks (PR #61); how often real Gemini answers without searching is UNKNOWN |
| Engine probe workflow | verified to run, no real result | runs 43669524263 and 43673980851: SKIP for every provider (no secrets); the script is proved against fakes by `test/engineProbe.test.ts` |
| Live check after the last merge | MEASURED | run 43673983040 (manual start, 2026-11-15, after PR #62 merged): passed (frontend, backend not downloadable, health, status, an engine configured, sign-in configured, storage durable, strangers refused); the signed-in checks (including the new `readiness: gemini search` line) were skipped, no secrets (O-3 step 4) |
| Docker image on a real host | **not verified** | no daemon in the sandbox |
| Rulesets on this plan | **not verified** | AGENT unsure |

## 5. Rules for whoever continues

1. Keep the "Built?" column in `docs/RELIABILITY.md` true.
2. One PR per item, with CI green, a fresh-context adversarial review, and an EVAL PM
   SHIP before merge (`CLAUDE.md`). Say the branch status in every reply.
3. Never write "durable", "never fails" or "$0 guaranteed" in product copy or docs
   before the step that makes it true has shipped and been tested at the boundary.
4. When something needs the owner, add it to section 3 with the reason the session
   cannot do it, and keep working on what does not depend on it.
