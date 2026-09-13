# Decision log

One entry per non-trivial product or architecture decision, per
`docs/ENGINEERING_STANDARDS.md` §9. Newest first.

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
