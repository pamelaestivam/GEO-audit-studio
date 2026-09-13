# Decision log

One entry per non-trivial product or architecture decision, per
`docs/ENGINEERING_STANDARDS.md` §9. Newest first.

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
