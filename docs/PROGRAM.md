# Program: where the product stands and what is next

Living document. Read it at the start of any session, update it at the end. Status
words mean exactly: **done** (merged and verified, with how), **in progress**,
**blocked** (names what it waits on), **next**, **open question**. The mandate is
`docs/OWNER_DIRECTIVES.md`; the design is `docs/RELIABILITY.md`; the reasons are
`docs/DECISIONS.md`; the history is `docs/SESSION_LOG.md`.

Last updated: 2026-10-10.

**Check this first (a failure that happened once and is fixed):** run
`git remote get-url origin` in `/home/user/GEO-audit-studio`. It must print
`https://github.com/pamelaestivam/GEO-audit-studio`. On 2026-10-10 a review agent had
changed it to a dummy address and left a stray empty commit on local `main`. The owner
authorised the repair and it was done (set the URL back, fetch, reset `main` to
`origin/main`). If it ever recurs, ask the owner to authorise those same commands rather
than looking for another way round. History: `docs/SESSION_LOG.md`; lesson: I-13.

**First action for a cold session:** run `npm ci && npm run verify` (it should report
0 failures), then take the first row marked **next** in section 2 (currently item 3).
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
| 2b | Session hygiene: branch-status script and test, `CLAUDE.md` rules, resume routine | in review | PR #31 |
| 2c | Remove a stray `node_modules` symlink from `main`; CI fails on tracked symlinks | done | merged #29 (d851fb2) |
| 3 | a. Honest first visit: storage-mode line, "no engine configured", default 2 questions, "n of M" | done | merged #30 (19005fc); CI green, full suite and browser checks passed, review findings fixed. The branches `claude/honest-first-visit` (backup patch) and `claude/session-hygiene*` are obsolete leftovers |
| 4 | b. Docker out of the required checks; CI smoke runs `dist/server.cjs`; daily live-site check | done | merged #32 (01c4049): `docker.yml` (informational; its run on the PR, https://github.com/pamelaestivam/GEO-audit-studio/actions/runs/38031734681, was read from the Actions tab and passed), `live-check.yml` (first run 2026-10-10, see section 4), restart and backup proof in `prod-install-check.sh`. Dependabot keeps the action pins current |
| 5 | c. Invariants, number guard, "Not counted" panel, cited-only as its own number (decision A) | partly | first half merged (#33, 6025447: report invariants, zero-figure guard on the summary, proved end to end); "Not counted" panel, cited-only number and an incidents record not built |
| 6 | d. Paid-engine refusal and call counters ($0 guard, per instance) | next | nothing |
| 7 | e. Step-wise audit state machine, leases, incidents; default returns to 3 | next | nothing |
| 8 | f. PostgresStore on Supabase | blocked | owner action O-4 |
| 9 | g. Deep health, owner health section, scheduled canary with one deduplicated issue | partly | the scheduled live check with one tracking issue is built (`live-check.yml`, #32) and has run once by manual dispatch (it exposed the unconfigured site, issue #36); its trigger on a finished Production deployment is proven (runs 38034259443 and 38034319845 fired on main after the merges of #33 and #34); the deep health endpoint and the owner health section are not built | O-3 for the live URL |
| 10 | Real-engine verification: one real audit read by a person against the raw answers; record fixtures from it | blocked | owner actions O-1 and O-2 |
| 11 | Branch protection and auto-delete of merged branches | blocked | owner action O-5 |

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
3. Tell the assistant "the database is ready" in the next session. Optional: connect
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

## 4. Verification ledger (what has actually been checked, and what has not)

| Claim | Status | How / date |
|---|---|---|
| Full suite on `main` after the 2026-10-09 merges | verified | `npm run verify`: 1,092 checks passed, 0 failed, 0 vulnerabilities; 2026-10-10 |
| Start-up with no key, dev sign-in, empty engine list | verified | run on merged tree; 2026-10-10 |
| Anything a real answer engine returns | **not verified** | no key, no network in the sandbox |
| Live site loads and its API answers at every depth | verified | `live-check` run https://github.com/pamelaestivam/GEO-audit-studio/actions/runs/38033024298 (manual dispatch, 2026-10-10 about 07:02 UTC, against the workflow's default URL `https://geo-audit-studio-five.vercel.app`, production only; the date and time are from the run page): every frontend and API check passed, and only the two configuration checks below failed. The refusal checks passed, but they accept 503 as well as 401, and an unconfigured server answers 503 to everything, so this shows "an unconfigured server refuses everything", not that sign-in enforcement works (401 under real sign-in has not been exercised live) |
| **Live site is configured: sign-in secrets and an engine key present** | **MEASURED: NOT CONFIGURED** | same run: `SESSION_SECRET` is not set, `ACCESS_CODES` is not set, no engine key is set (issue #36). Nobody can sign in to the live site and no audit can run until the owner sets these in Vercel (O-3, O-2). |
| Live site storage | MEASURED: memory only | reported as a warning by the same run (`--warn-non-durable`) |
| `live-check` trigger on a finished Production deployment | verified | after the merges of #33 and #34 Vercel's bot fired the workflow on `main` (runs https://github.com/pamelaestivam/GEO-audit-studio/actions/runs/38034259443 and https://github.com/pamelaestivam/GEO-audit-studio/actions/runs/38034319845, both executed rather than skipped, and failed on the same two configuration checks); Preview deployments fire it too and are skipped by the job condition. A run for #32's merge was cancelled by the next one (the concurrency group keeps one pending run) |
| Vercel function maximum duration on this project | **not verified** | AGENT says 300 s with fluid compute |
| Gemini free grounded-prompt allowance | **not verified** | sources disagree (1,500 per day vs 5,000 per month) |
| Google project has no billing (the $0 control) | **not verified** | owner action O-2 |
| Supabase free-plan scheduled jobs | **not verified** | AGENT silent |
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
