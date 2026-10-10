# Decision log

One entry per non-trivial product or architecture decision, per
`docs/ENGINEERING_STANDARDS.md` §9. Newest first.

---

## 2026-10-10 - Owner answers to the independent review; team decisions A to G; hosting reversal

**Decision (owner, 2026-10-10, quoted in `docs/OWNER_DIRECTIVES.md`):** spend is $0;
the product must not fail silently and should be designed not to fail; deploy
automatically to a URL the owner opens; use what the owner already knows (Vercel,
Supabase); Q1 and Q3 of the review are delegated to the agents; keep records.

**Who weighed in:** PM Twin, CTO, UX Lead (three independent solo positions, then a
debate round; method in `docs/TEAM_CHARTER.md`). EVAL PM scores each resulting PR.
The seats are prompts run by one assistant, so this is three disciplined lenses and
not three independent people (see `docs/REVIEW_2026-10-09.md`, Part B 7).

**Decisions**

- **A. Visibility counts a brand only when its name appears in the answer text.**
  Cited-only (own domain cited, name absent) is a separate number shown as a
  sub-line ("+2 cite your site without naming you") with a one-line explainer. They
  are never blended. Reports saved before the change used "named or cited"; the
  report gets a `metricVersion` so history is not silently reinterpreted.
  *Process:* this changes what the product promises a client, so the PR says so in
  its first line and the owner is told in chat before merge.
- **B. Numbers in written text.** The summary's figures come from a deterministic
  sentence built from computed metrics. The model writes qualitative prose. A guard
  drops any model sentence containing a number (digits or spelled-out) that is not in
  the computed set, records an incident, and the page says so in a footnote. Token
  substitution (`{named_count}`) was the PM Twin's and CTO's final preference and the
  UX Lead's was the digit guard; each conceded to the other, and the guard is the
  real control in both, so the guard is mandatory and tokens are optional.
- **C. Never fail silently.** Architecture in `docs/RELIABILITY.md`: six failure
  classes, a persisted step-wise audit state machine with leases, invariants checked
  by one pure function, an incidents record, a "Not counted" panel (replaces the
  proposed "Not identified" list: one spec), an owner health section, a scheduled
  canary. Unattributable claims are listed, never silently dropped (review Q4).
- **D. Default question count: 2 until audits can resume, 3 after.** Three is the
  ceiling. A labelled "Quick check (1 question)" mode exists and never shows a bare
  percentage ("1 of 1 answer named you. A single answer is an observation, not a
  rate."). Every rate is printed "n of M", never bare. One question does not help
  robustness, it hides the failure; robustness comes from persisted steps.
- **E. $0.** Provider: key from a project with billing never enabled (owner confirms
  once; recorded in `docs/PROGRAM.md`). App: paid engines **will be** refused unless an explicit
  flag is set (step d, not built), presence of a paid key **will be** a red health
  check, and a call counter **will** stop the app before the free limit (labelled "calls this app made", never "your quota"). The
  app cannot see billing and does not claim to prove $0.
- **F. Hosting reverses the 2026-10-09 "always-on process, SQLite, Vercel unsupported"
  decision.** Vercel stays the host (auto-deploys every merge; the owner knows it),
  Supabase Postgres is to become the durable store (not built; blocked on the owner,
  `docs/PROGRAM.md` O-4), and audits are to run as step-wise resumable jobs (not built). Until the store exists the deployment is labelled "Preview" and nothing
  claims durability. Docker leaves the required checks (CI smoke runs
  `dist/server.cjs`; `scripts/prod-install-check.sh` already exists); the Dockerfile
  stays as an optional, non-blocking self-host path. Docker Hub 429s therefore stop
  failing merges.
- **G. Branch protection.** A required human review is theatre for a solo owner who
  delegates merging (an author cannot approve their own PR, and the merges run under
  the owner's login). Instead: a ruleset on `main` requiring a pull request (0
  approvals), the `test` check (which already runs lint, audit and the whole suite), no force-push, no deletion; a
  machine-checked "EVAL PM: SHIP" line in the PR body; "Automatically delete head
  branches" turned on; and this entry is the written standing delegation. A change
  to a metric definition, spend, or hosting still tells the owner in chat before merge
  (the PM Twin veto, enforced by process).

**Dissent and concessions:** none left open. PM Twin conceded 3-by-default (to 2
interim), the `needs-owner` label as a gate, and tokens (to the guard). UX Lead
conceded the default of 2 and the digit guard and adopted the CTO's panel name. CTO
conceded token substitution as a preference and the GitHub-issue alert over email. UX
Lead's conditions stand: no bare percentage at one answer; every drop told to the
user; no Resume/Discard button before the lease exists. CTO's veto stands: no "never
fails" or "durable" copy before the step that makes it true.

**Alternatives rejected:** keeping SQLite on a free container host (free tiers sleep
and lose disks; AGENT, unverified), staying on in-memory Vercel (cannot honour the
mandate), one question by default (hides failure), a blended "named or cited" score
(a number that means two things), a second model call to verify the first (cost and a
new failure), required human approval (cannot be satisfied by the one human).

**Not verified (AGENT-level or unknown):** Vercel function duration on this project
(300 s with fluid compute per web search; an older default is 10 s); whether the
Supabase free plan provides scheduled jobs; whether a private repo on a free GitHub
plan supports rulesets; the Gemini free grounded-prompt allowance (sources
disagree); whether secrets are set on the live Vercel project. The sandbox this work
runs in cannot reach external hosts, so none of these were tested.

**Reversibility:** every step sits behind the `Store` interface and the pure
analysis layer; each ships as its own PR and can be reverted alone.

---

## 2026-10-09 - Foundation: always-on service, SQLite, invitation sign-in (decided without the owner)

**Decision:** D1 (runtime), D2 (datastore) and D3 (auth) from `docs/MVP_AUDIT.md`
were taken at their recommendations and built, because the owner instructed
"continue ... with no stop" and the alternatives all needed an account or
credential only the owner can create:

- **Runtime:** one always-on process (Docker / Render with a disk) serving API and
  frontend. Vercel is no longer a supported deployment for real use.
- **Datastore:** SQLite via Node's built-in `node:sqlite` on a persistent disk,
  behind a `Store` interface so Postgres can replace it. Single instance.
- **Auth:** email + operator-issued access codes (`label=code`), HMAC-signed
  expiring sessions, ownership by (label, email). No password database.

**Why:** each is the smallest thing that is correct for an invitation-only MVP and
needs nothing from the owner but a host and a few environment variables. SQLite
avoids a managed-database account and bill; invitation codes avoid a Google Cloud
OAuth client; an always-on process is what the code already was.

**Alternatives rejected:** Postgres now (an account and a bill the owner has not
chosen, for traffic that does not need it); Google sign-in now (needs the owner's
OAuth credentials, `TECH_DEBT.md` 1.5); staying on Vercel and rebuilding around a
queue (more moving parts, and the platform's limits are the original problem);
passwords (state to secure, no benefit before real accounts).

**Reversibility:** all three sit behind small seams - `src/store.ts`,
`src/auth.ts`, and `Dockerfile`/`render.yaml` - and none of the audit pipeline
knows which is in use. **D4 (which paid engine keys, and a monthly ceiling) was
not decided: it is the owner's money.** The limits of this foundation are in
`TECH_DEBT.md` 2.11.

**Process note:** the independent adversarial review of this work found 12 real
defects in it, including an auth fall-open the author had not considered. That
review is now a standing step (`docs/ENGINEERING_STANDARDS.md` section 10,
`.claude/agents/adversarial-reviewer.md`).

---

## 2026-10-09 - MVP audit: fix what needs no decision, queue the rest as owner decisions

**Decision:** run an adversarial audit of the whole product against a real
browser and the real built server (`docs/MVP_AUDIT.md`), fix every defect that
needed no infrastructure or product decision in one branch, and turn the rest
into a 20-item roadmap with four named decisions (D1 runtime, D2 datastore, D3
auth, D4 engines/spend) for the owner.

**Who weighed in:** CTO and UX Lead (one session); EVAL PM scored it (87,
SHIP - see the doc).

**Why this shape:** the owner's instruction was "basic things you can fix now;
more significant, ask". The measured defects were mostly of two classes -
*numbers that did not mean what their label said* and *failures presented as
findings* - both squarely inside the product's own honesty rules, needing no
new infrastructure. The structural problems (host/job-model mismatch, no real
auth, no persistence) are each a decision with a cost, so they are queued, not
guessed at.

**What it corrected from an earlier decision:** the 2.6a round removed the
vendor-extraction LLM call and reviewed the *recall* cost; the real cost was
*precision* (13 of 15 discovered "vendors" were junk and share of voice read
6% instead of 33%). Recorded in `TECH_DEBT.md` 2.6b. The lesson is the same
one `CLAUDE.md` already states - "ask why a call exists" is half the question;
the other half is "what does the replacement get wrong, measured on a real
answer, not an imagined one".

**Dissent / not done:** the Vercel job-model problem (`TECH_DEBT.md` 1.4c) is
*inferred*, not measured; it is recorded as such and the confirming step is
written down rather than asserted.

---

## 2026-09-13 — Replace the [...path].ts catch-all with an explicit vercel.json rewrite

**Decision:** immediately after confirming `/api/health` worked live
(the ESM-extension fix above), a curl matrix against the live deploy
found `/api/audit/status` and every other multi-segment `/api/*` path
still hit Vercel's own 404, at the routing layer, before the function
was ever invoked - while single-segment paths worked, including
Express's own 404 for an unmatched one (`/api/foo`). Rather than keep
diagnosing why `[...path].ts` was behaving like a single-segment
dynamic route, replaced it with an explicit `vercel.json` rewrite
(`/api/:path* -> /api`) and renamed the file to `api/index.ts` -
removing Vercel's own catch-all inference from the equation entirely.

**Why:** an explicit rewrite is the same pattern used in Vercel's own
official Express examples, and was considered at the very start of this
work before the catch-all filename was chosen for a smaller diff. That
was the wrong tradeoff here - "smaller diff" isn't worth it when the
alternative is unambiguous and the chosen one has undiagnosed platform
behavior.

**Also added:** a test asserting `vercel.json` actually contains the
rewrite, because every existing test calls the handler function
directly, which bypasses Vercel's routing layer completely and could
not have caught this bug at all, before or after the fix.

**Not fully explained:** why the catch-all filename matched one segment
but not two - this session doesn't have the platform access to say for
certain (Fluid Compute interaction, a Vercel routing-manifest quirk
specific to non-Next.js catch-all functions, something else). Recorded
as unexplained rather than inventing a confident-sounding cause.

---

## 2026-09-13 — Add explicit .js extensions to every relative import Vercel's function graph reaches

**Decision:** the actual root cause of the Vercel API crash (see the
entry below for the two prior attempts) was confirmed from real
production logs the owner pulled from the Vercel dashboard:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/var/task/server'
imported from /var/task/api/[...path].js
```

Vercel's Node.js runtime transpiles files individually rather than
bundling them, so at runtime it's native Node ESM resolution - which,
unlike a bundler or `tsx` (what every local test runs under), requires
an explicit file extension on every relative import. Fixed by adding
`.js` to all nine extensionless relative imports reachable from
`api/[...path].ts`'s and `server.ts`'s module graphs.

**Why this one is different from the two before it:** it's confirmed
against a real stack trace the owner retrieved, not a plausible-sounding
guess. Also added `test/vercelEsmImports.test.ts`, a static check that
walks the same module graph and fails on any future extensionless
import in it - verified to actually catch the bug by reverting one
import and re-running the test before restoring the fix.

**Process note, logged because it's worth repeating:** two prior fixes
(routing, then a lazy `vite` import) were shipped on reasonable-sounding
hypotheses without a way to verify them, and both were wrong about the
*specific* cause even though the first was a real, necessary fix in its
own right and the second a real, independently-justified hardening.
Neither this session nor `docs/EVAL_PM.md`'s rubric treated those as
failures - they were disclosed as unconfirmed at the time, which is what
let the team correctly stop guessing after the second one and ask for
the one input (real logs) that actually closed it, rather than trying a
third hypothesis blind.

---

## 2026-09-13 — Wire the Express app into a Vercel serverless function, don't re-architect for it

**Decision:** Fix the live Vercel deployment's fully-broken API surface
(`/api/*` all 404ing - see `TECH_DEBT.md` §1.4a) by adapting the
*existing* Express app to run as one catch-all serverless function
(`api/[...path].ts`), rather than splitting routes into individual
Vercel functions or rewriting the backend for an edge/stateless model.

**Who weighed in:** CTO (build), EVAL PM (scored the PR before merge).

**Why:** Minimal, well-understood change - the app behaves on Vercel
exactly as it already does on Render (one Express app handling
everything), just with Vercel owning the socket instead of `app.listen`.
Verified locally two ways: a new E2E test hits the real handler on a
real `http.Server`, and the untouched Render/local path was re-tested
by hand to confirm no regression. `dist/server.cjs`'s exposure as a
public static file (a real, independently-discovered issue - curled and
confirmed reachable) was fixed in the same round since it shared the
same root cause and the same `vercel.json` fix surface.

**Alternative considered and rejected:** Split each route into its own
`api/*.ts` file, Vercel-idiomatic style. Rejected - much larger diff for
no behavioral benefit at this traffic scale, and would fragment the
single circuit breaker/job table this codebase already depends on being
one process's worth of shared memory (already fragile enough across
Lambda instances - see the flag below).

**Known limitation, disclosed rather than hidden:** this fix makes the
API *reachable*; it does not make the in-memory quota breaker, job
table, or idempotency store safe across concurrent Vercel instances.
That risk was previously moot (API unreachable) and is now live -
tracked as the most urgent open item in `TECH_DEBT.md` §1.4a.

**Also not verified:** an actual `vercel deploy` - this session has no
Vercel CLI credentials. The owner should confirm `/api/health` on the
live URL after merge.

**Update:** re-checked ~15 min post-merge and again ~10 min after a
follow-up fix (lazy `vite` import, addressing a plausible native-binary
crash) - both times, identical `FUNCTION_INVOCATION_FAILED`, no
observable change. That pattern (two different code fixes, zero
observable difference, well past normal build time) points away from
"the code is still broken" and toward "these merges may not be reaching
a Vercel deploy at all" - see `TECH_DEBT.md` §1.4a's update for exactly
what the owner needs to check in the Vercel dashboard, since this
session cannot see deploy history or function logs without it.

---

## 2026-09-13 — Fix MonitoringTab's fabricated trend/growth data now; defer real persistence and settings-form honesty

**Decision:** Ship a client-only correctness fix removing the hardcoded
historical-score fallback and the hardcoded "+16% Index Growth" badge in
`src/components/MonitoringTab.tsx`, replacing both with an honest
empty-history state and a growth figure computed from real data only.
Do **not** attempt real audit persistence, and do **not** touch the
Monitoring Settings form's "automated sweeps" copy, in the same change.

**Who weighed in:** PM Twin, CTO, UX Lead (adopted under
`docs/TEAM_CHARTER.md`'s solo → position → debate → decision protocol,
run in this session).

**Why (converged reasoning):**
- All three seats independently flagged the same component on their first
  pass, from three different angles - PM Twin from client-trust risk (a
  prospect who notices a fake number stops trusting every other number
  in the report), CTO from correctness ("a value that looks computed but
  is actually still hardcoded" is explicitly called out as a recurring
  bug class in `CLAUDE.md`), UX Lead from research/experience (a
  dashboard number that doesn't move with reality is a trust defect, not
  a cosmetic one). Independent convergence from three lenses was treated
  as a strong signal this was the right first move, not a coincidence to
  second-guess.
- It required no new infrastructure and no hosting/datastore decision,
  making it safe to ship immediately regardless of the still-open Vercel
  and auth questions (below).
- It directly matches the product's own stated architecture pillar
  ("Honest presentation — only engines actually queried are shown") and
  extends it to a surface that had quietly violated it.

**Alternative considered and rejected:** Build real audit persistence now
(TECH_DEBT §3.1, "highest value") so the chart would have genuine data to
show instead of an empty state. Rejected for sequencing, not merit: the
CTO seat's veto held that building storage against the current Render
filesystem is wasted work if hosting moves to Vercel (§1.4, serverless,
no durable local filesystem) before the datastore choice is made, and
building it twice serves no one. The empty state is the honest interim
answer until that infrastructure decision is made once, correctly.

**Also deferred (logged, not lost):** the Monitoring Settings form
implies automated sweeps are running when saving it only updates local
React state. UX Lead raised this as the same underlying problem one
layer down; PM Twin and CTO agreed it's real but is a distinct,
copy/scope decision rather than a one-line fix, and should not ride on
this PR per the "small, focused PRs" standard. Tracked in
`TECH_DEBT.md` §2.1a's fast-follow note.

**Dissent:** none on the fix itself. The only disagreement in the debate
was scope (whether to fold the settings-form fix into the same change),
resolved as above.

**Also logged as open actions** (not part of this decision's implementation,
tracked per the user's request): moving hosting to Vercel
(`TECH_DEBT.md` §1.4) and setting up Google auth via Google Cloud Console
(`TECH_DEBT.md` §1.5). Both are blocked on the owner providing account
access/credentials and a couple of sequencing decisions - see those
entries for exactly what's needed.
