# Tech debt, open actions, and expansion

Living record so a future session inherits the context instead of rediscovering
it. Update this file whenever something is knowingly left imperfect.

---

## 1. Open actions — for the repo owner to decide

**Ask about these at the start of the next session.** They are blocked on a
human decision or a paid account, not on engineering.

### 1.1 Enable the other three answer engines (not yet done)

The code queries ChatGPT, Perplexity and Claude for real, but each stays dark
until its key is set in Render → Environment. Today only Gemini is configured,
so every audit measures one engine.

| Engine | Variable | Where | Cost note |
|---|---|---|---|
| ChatGPT | `OPENAI_API_KEY` | platform.openai.com → API keys | Needs billing credit; web search billed per tool call |
| Perplexity | `PERPLEXITY_API_KEY` | perplexity.ai/settings/api | Best value — search is native to `sonar`, not billed separately |
| Claude | `ANTHROPIC_API_KEY` | console.anthropic.com → API keys | Web search billed as a server tool |

Decision needed: which engines to pay for. Recommend starting with Perplexity
alone to see multi-engine output before committing to three bills. Adding a key
requires no code change; the engine appears on the next deploy.

**Cost control before enabling more than one:** every query fans out across
every configured engine, so three engines triples spend per audit. Set
`MAX_AUDIT_QUERIES` (default 8) accordingly.

### 1.2 Gemini is currently mandatory

Even with other keys set, `GEMINI_API_KEY` is required: narrative synthesis
runs on Gemini (vendor discovery no longer does - see 2.6). Removing this
last dependency is real work (see 3.4). The error messages now name this
explicitly rather than claiming nothing is configured.

### 1.3 Custom domain

Deferred until the product is worth showing. Pointing a domain at the Render
service needs no code change.

### 1.4 Vercel hosting (deployed 2026-09-13; API connectivity fixed same day - see 1.4a)

Raised in the 2026-09-13 product strategy session (`docs/DECISIONS.md`)
as a future decision; the owner deployed to Vercel
(`https://geo-audit-studio-five.vercel.app/`) the same day, ahead of that
decision being made. What `1.4` originally flagged as a future risk is
now live, not hypothetical:

- **Confirm environment variables are actually set in Vercel.** `GEMINI_API_KEY`
  and friends do not carry over from Render automatically - if they aren't
  re-entered in the Vercel project's Environment Variables settings, every
  audit will silently run in the degraded/synthesized path. Not verified
  from this session; the owner should check the Vercel dashboard directly.
- **The in-memory job table (2.3), quota circuit breaker (2.3a), and
  idempotency store (2.3b) are now genuinely at risk, not just
  architecturally suspect.** See 1.4a below - the API is reachable as of
  this fix, which means real traffic can now actually hit this problem.

**Do not start building file-based persistence (3.1) against a local
filesystem** - Vercel functions don't have one to persist to between
invocations, and it would need to be rebuilt for a real datastore anyway.
Persistence needs a hosted datastore decision (Vercel Postgres, Vercel KV,
Neon, Upstash, etc.), not a workaround.

### 1.4a Vercel served only the static frontend - every API route 404'd, then crashed (fixed, confirmed via real function logs)

Confirmed by curling the live deploy: `/` returned Vercel's zero-config
Vite build (200, real `index.html`), but `/api/health` and
`/api/audit/status` both returned Vercel's own `404 NOT_FOUND` page -
not this app's error handling. Root cause: Vercel's framework detection
built the frontend (`vite build`) and had no idea `server.ts` (or the
Express app it defines) was supposed to run anywhere. The live product
was, at the time, a page that loads and does nothing.

Fixed by giving Vercel an actual serverless entry point:

- `server.ts` now splits `buildApp()` (constructs the Express app and
  registers every route, never binds a port) from `startServer()` (calls
  `buildApp()` then `app.listen()` - unchanged behavior for Render and
  `npm run dev`/`npm start`). `buildApp` skips the production
  static-file-serving branch when `process.env.VERCEL` is set, since
  Vercel's own CDN serves `dist/` directly.
- `api/[...path].ts` is a Vercel catch-all function: every request under
  `/api/*` lands here via Vercel's file-system routing (no rewrite rules
  needed), calls `buildApp()` once per warm instance, and forwards the
  real `req`/`res` straight to the Express app - the same request
  object Express already knows how to route internally.
- `vercel.json` pins `outputDirectory` to `dist` and appends
  `rm -f dist/server.cjs dist/server.cjs.map` to the build command.
  Without this, the compiled backend bundle - full route logic, prompt
  templates, internal error-handling strings, though no secrets, since
  those are only ever read from `process.env` at runtime - was sitting
  in the public static output and was confirmed reachable at
  `/server.cjs` (curled: `200`). Not sensitive data, but not something
  that should be servable to anyone who asks either.

Verified locally: `test/vercelServerless.test.ts` calls the real
`api/[...path].ts` handler on a real `http.Server` and confirms it
answers `/api/health` and `/api/audit/status`, and separately confirms
`buildApp()` without `VERCEL` set still serves the static frontend
exactly as before - so this change doesn't regress the Render path it
didn't touch. The non-Vercel path was also smoke-tested by hand: built
`dist/`, ran `node dist/server.cjs` for real, curled `/api/health` and
`/`. This routing fix alone was not, by itself, enough to make the live
API work - see the update below for the actual remaining cause and how
it was confirmed.

**Update:** the first fix (routing) and a follow-up guess (lazily
importing `vite`, on the theory that its native esbuild/rollup binaries
were the crash) both merged and deployed correctly - re-checking the
live URL after each still showed the identical
`FUNCTION_INVOCATION_FAILED`. Two different code fixes with zero
observable change, well past normal build time, was itself a signal
worth stopping on rather than guessing a third time - see
`docs/DECISIONS.md` for that reasoning at the time.

**Real root cause, confirmed from the owner's Vercel dashboard (Logs →
expanded function error), not guessed:**

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/var/task/server'
imported from /var/task/api/[...path].js
```

Vercel's Node.js runtime transpiles `api/[...path].ts` and everything it
imports **individually**, unlike `esbuild --bundle` (used for
`dist/server.cjs` on Render), which inlines the whole dependency graph
into one file. At runtime it's real Node ESM resolution loading those
separate files - and unlike a bundler, or `tsx` (what every local test
in this repo runs under), native Node ESM refuses to infer a missing
file extension. Every relative import in the server-side dependency
graph (`api/[...path].ts` → `server.ts` → `src/analysis.ts`,
`src/errors.ts`, `src/quotaBreaker.ts`, `src/idempotency.ts`,
`src/providers.ts`, `src/data/sampleAudits.ts`, `src/types.ts`) was
written without an extension (e.g. `from '../server'`), which is exactly
what `moduleResolution: bundler` in `tsconfig.json` is meant to make
safe for a bundler - just not for Vercel's per-file Node ESM runtime.
Fixed by adding explicit `.js` extensions to all nine of them (the
standard TypeScript "NodeNext" convention: reference the file's eventual
compiled extension, even though the source is `.ts`).

**Why `npm test` never caught this:** every existing test imports
`server.ts`/`api/[...path].ts` through `tsx`, which resolves
extensionless specifiers fine - it never exercised the one property
that's actually Vercel-specific. `test/vercelEsmImports.test.ts` (new)
closes that gap: it statically walks the same module graph Vercel's
runtime walks and fails if any relative import in it lacks an explicit
extension. Verified this would have caught the real bug by temporarily
reverting one import and re-running it (failed as expected), then
restoring the fix.

**Still owner-verified, not just re-asserted:** the owner pulled the
real stack trace from the Vercel dashboard themselves (Logs tab,
expanded a `500 /api/health` entry) - this fix is confirmed against that
trace, not merely deployed and hoped for. The lazy-`vite`-import change
from the earlier guess is left in place; it's a real, independently
justified hardening (a production Lambda has no reason to load a
dev-only toolchain), just not what was actually causing this crash.

**Real risk this fix makes live, not just theoretical:** `geminiBreaker`,
`auditJobs`, and the idempotency store are process-global `Map`s/objects
created once per Lambda cold start. Vercel can and does run multiple
warm instances concurrently under real traffic, each with its own copy
of all three. Before this fix, that risk was moot - the API was
unreachable, so nothing could trigger it. Now it's live: two requests
that land on two different warm instances (a poll racing a cold start,
or genuine concurrent audits) do not share breaker/job/idempotency
state, which is exactly the amplification failure mode 2.3a and 2.3b
were built to prevent, reopened one layer up. Low risk at Pamela's own
solo testing volume; a real blocker before onboarding any second real
user. Fix is the same one already tracked in 3.1/1.4: externalize this
state to a shared store (Vercel KV/Postgres, Upstash Redis) rather than
process memory. Flagging here so it isn't rediscovered as a surprise the
first time two audits actually overlap in production.

### 1.4b The [...path].ts catch-all only matched single-segment /api/* paths in production (fixed)

Discovered immediately after 1.4a's fix went live and `/api/health`
started working: curled a matrix of real paths against the live deploy
and found `/api/health` (single segment) returned real data, but
`/api/audit/status`, `/api/audit/samples`, `/api/a/b` (anything with 2+
segments after `/api/`) all hit **Vercel's own platform 404** - not
Express's, meaning the request never reached the function at all. An
unmatched *single*-segment path like `/api/foo` correctly returned
Express's own "Cannot GET /api/foo", proving the function itself handles
nested routes fine; the failure was entirely at Vercel's own routing
layer, specific to how it was resolving the `[...path].ts` catch-all
filename convention in this project's setup. This session could not
fully diagnose why the catch-all filename behaved this way without
deeper platform access than a curl matrix provides.

Fixed by removing that ambiguity rather than continuing to debug it:
renamed `api/[...path].ts` to `api/index.ts` and added an explicit
`vercel.json` rewrite - `{ "source": "/api/:path*", "destination": "/api" }`
- so routing no longer depends on Vercel's own inference about what a
bracket-catch-all filename should match. This is the same
"single-Express-function-behind-an-explicit-rewrite" pattern used by
Vercel's own official Express examples, chosen originally and then
set aside in favor of the catch-all filename for a smaller diff - worth
remembering that the more explicit form was the more robust one.

`test/vercelServerless.test.ts` now also asserts `vercel.json` actually
contains this rewrite, specifically because calling the handler function
directly (which every other test in this file does) cannot detect this
failure mode at all - it bypasses Vercel's own routing layer entirely,
which is exactly where this bug lived.

### 1.4c The audit job model probably does not fit Vercel (open - inferred, not measured)

> **Superseded 2026-10-10 (`docs/DECISIONS.md`, decision F):** the earlier call that the
> supported deployment is an always-on service (D1 below) was reversed at the owner's
> direction. Vercel stays the host; the fix is a step-wise resumable audit job plus a
> durable store (`docs/RELIABILITY.md`), not a different host. The analysis below is
> still the description of the problem.

Found in the 2026-10-09 MVP audit (`docs/MVP_AUDIT.md` A1). `POST
/api/audit/run` answers `202` and then keeps working after the response;
`GET /api/audit/job/:id` reads the result from a process-global `Map`. On a
serverless host nothing guarantees the function keeps executing after its
response is sent, a poll can land on a different instance than the submit, and
a default three-query audit takes at least ~26s of deliberate Gemini pacing.
The expected symptom is the "That audit is no longer available" message on a
healthy audit, intermittently.

**Not measured** - this environment has no Vercel access. **To confirm:** run
one default audit on the live site and watch for that message; in Vercel ->
Logs check the function duration and any "Task timed out". If it reproduces,
the fix is not another routing tweak - it is item 1 in the roadmap (an
always-on service, or a real queue), decided by the owner (D1).

### 1.5 Set up auth with Google (Google Cloud Console) (tracked, not started)

Raised in the same session, alongside 2.2 (auth is currently not real
auth - anyone who submits a login is auto-registered, no session
validation exists anywhere). Needs from the owner before any code
changes:

- A Google Cloud project with an OAuth 2.0 Client ID (OAuth consent
  screen configured, authorized redirect URIs added) from
  `https://console.cloud.google.com/apis/credentials`.
- A decision on scope: is Google Sign-In replacing the current
  email/password stub outright, or sitting alongside it? Replacing it
  outright is the recommendation, since the stub has no real security
  properties to preserve.
- Where sessions are then stored - this depends on 1.4/2.1's datastore
  decision, since "who is logged in" needs to survive across serverless
  invocations, which an in-memory `Map` cannot do.

**Sequencing note:** doing this before 1.4/2.1 means building session
storage twice. Recommend deciding hosting and datastore first, then
wiring Google auth against the real store once, not against the
in-memory stub.

---

## 2. Known tech debt

Ordered by how likely it is to hurt.

### 2.1 Nothing is persisted — audits die on refresh (high)

Audits live in React state only. Refreshing the page loses everything, so:

- **There is still no real history to show.** See 2.1a - the fabricated chart
  is fixed, but the underlying gap (no audit is ever saved) is not.
- **Continuous Sweeps is a settings form that schedules nothing.** See 2.1a's
  fast-follow note - it also implies persistence the product doesn't have.
- A client cannot be shown "your score moved from X to Y after our fixes",
  which is the main reason anyone renews a subscription.

Needs a datastore (Render offers managed Postgres, or a Vercel-native option
if 1.4 lands first). This is the single largest gap between the current
build and something sellable.

### 2.1a MonitoringTab showed a fabricated trend and a fabricated growth badge (fixed)

`MonitoringTab` fell back to a hardcoded three-point array (`June 2026: 65`,
`July 2026: 71`, current score) whenever `audit.historicalScores` was absent -
which was every real audit, since nothing has ever written to that field
(confirmed by `test/contract.test.ts`'s `historicalScores` assertion, which
only checks the *server* never invents it; nothing on the client enforced
the same rule). Worse, the "+16% Index Growth" badge above the chart was a
literal string constant, shown identically whether the business's real score
had gone up, down, or didn't exist yet. This is exactly the failure mode
`CLAUDE.md` names directly: a polished, readable dashboard that is not
telling the truth.

Raised independently by all three seats in the 2026-09-13 strategy session
(`docs/DECISIONS.md`) as the highest-leverage, lowest-risk fix available -
zero new infrastructure, purely a correctness fix to something already
shipping to real client demos. Fixed in `src/components/MonitoringTab.tsx`:
the chart now renders only real `historicalScores` entries (as few as one),
computes the growth badge from the real first/last score when at least two
points exist, and shows an explicit "Not enough history yet" empty state
otherwise - never a placeholder that could be mistaken for a measurement.

**Fast-follow (fixed):** the Monitoring Settings form below the chart
still copied "Automated AI Search Audit & Alert Settings" and showed a
"Next scheduled audit run" date pulled straight from
`DEFAULT_MONITORING_CONFIG`'s hardcoded `2026-08-17` - the exact same
fabrication pattern as the chart, one control down, and `onUpdateConfig`
only ever updated local React state; saving never scheduled anything
server-side. Labeled the section "Preview - not yet active", replaced
the fake next-run date with an honest "scheduling is not active yet"
line, and reworded the save confirmation and button to describe what
actually happens (preferences saved for later) rather than implying
live automation. Real scheduling still needs 3.1 (persistence) and 3.2
(alerting) built first - this only stops the UI from claiming it already
exists.

### 2.1b A failed analysis step was reported as "100% accuracy" (fixed)

If evidence was collected but the narrative call failed, `inaccuracies` was
`[]`, so the report showed 100% fact accuracy, 0 inaccuracies and "No
Inaccuracies Found - all mentions were factually accurate" - failed work
counted as a negative finding (`CLAUDE.md`, "Denominators"). The report now
carries `narrativeAvailable` / `narrativeNote`; accuracy is `null`; the
summary card, the three qualitative tabs and the export all say "Not assessed".
A fully failed audit no longer ships a placeholder Schema.org task (with an
invented `"price": "0"`), a made-up omission, `accuracyRate: 0`, or every
engine marked `omitted` - it carries empty findings, only the configured
engines, status "no data" and the per-engine reason. One module,
`src/reportView.ts`, now decides how headline numbers are presented, so the
card, export and sidebar cannot disagree again.

Also fixed in the same pass because they were the same defect in different
places: the "Share of Voice" tile described visibility; the Visibility Index
claimed to include accuracy; one answer rendered as a green 100/100 with no
sample size; ticking a remediation checkbox raised the headline score;
"Add & Audit Query" recomputed headline metrics with a formula that counted
failed lookups as appearances; blank offerings/audience were filled with guesses;
and the sidebar said "Continuous Sweeps - Active" for a feature that schedules
nothing.

**Still imperfect:** `accuracyRate` is still a model judgement with no ground
truth (2.5) - it is now labelled "indicative" everywhere it appears.

### 2.2 Authentication is not authentication (FIXED for the invitation-only MVP, 2026-10-09 - see 2.11 for what remains)

**Superseded.** Sign-in is now real: email + an access code the operator hands out, an HMAC-signed expiring session, enforced server-side on every spending and saved-audit route, ownership by (code label, email), production refusing to run unconfigured (`src/auth.ts`, `docs/DEPLOYMENT.md`). The text below is the history of why it was replaced.


`/api/auth/login` **auto-registers any email/password it has not seen**, so
every login attempt succeeds. Users are held in an in-memory `Map` wiped on
every restart or redeploy. Passwords are stored in plaintext and compared with
`===`. There is no session validation on any audit endpoint — the "token" is a
timestamp string that nothing checks.

Anyone with the URL has full access. Do not put this in front of paying clients
without replacing it (real user table, hashed passwords, signed sessions).

**2026-10-09 update (partly fixed; the server side is still open).** Confirmed
by `curl`: a never-seen email with any password returns a user and a token, and
`POST /api/audit/run` with no credentials starts spending quota. The
*client* also made it worse - `AuthPage` caught every sign-in failure
(wrong password, server down) and logged the person in anyway with a locally
invented user, so a wrong password reached the dashboard (reproduced in a real
browser). That fallback is removed, the false "OAuth & encrypted sessions"
and "password reset email sent" copy is corrected, and the dead "Remember me"
box is gone. What remains: the token is checked by nothing, passwords are
plaintext, a demo credential is in source, and audits are unowned. That is
roadmap items 4 and 15, pending D3 in `docs/MVP_AUDIT.md`.

### 2.3 Audit jobs live in memory (FIXED for one instance, 2026-10-09)

**Superseded.** Jobs and saved audits live in the store (`src/store.ts`; SQLite on a persistent disk, memory fallback that says it is not durable). A restart fails orphaned jobs with a sentence. History below.


Audits now run as background jobs (`POST /api/audit/run` returns a job id, the
client polls `/api/audit/job/:id`), which fixed the "Load failed" aborts on
mobile. The job table is an in-memory `Map` with a 30 minute TTL, so a restart
or a free-instance sleep loses an in-flight audit. The client reports this
honestly ("that audit expired before it finished"), but the work is lost.
Resolved properly by the same datastore that 2.1 needs.

Gemini calls are also serialised process-wide to protect the free-tier quota,
which means two concurrent users queue behind each other. Fine for now; it
needs a per-key limiter if the product gets real traffic.

### 2.3a Repeated "quota exhausted" was self-inflicted amplification (fixed)

Real audits (Stripe, Poke House, Hyundai, City Sports) kept hitting Gemini's
free-tier quota and the failure kept recurring. The root cause was in this
codebase, not just the quota itself: every Gemini call site (query
generation, one grounded search per query, vendor discovery, narrative - 6+
per audit) retried independently on a 429, up to 3 times with 30-60s waits.
One exhausted quota could be rediscovered 15-20 times by a single failed
audit, taking minutes and consuming whatever quota might have been about to
recover.

Fixed with a process-wide circuit breaker (`src/quotaBreaker.ts`): the first
quota error trips it for a computed cooldown (the provider's suggested
`retryDelay` for a per-minute cap, or time-to-next-UTC-midnight for a daily
one - `computeQuotaCooldownMs` in `src/errors.ts`), and every subsequent
Gemini call - this audit, any other request, for the rest of the cooldown -
fails instantly with no network call. A `GET /api/audit/status` endpoint
exposes the breaker state so the frontend warns before a user fills out the
whole form and submits into a wall already known to be there, rather than
discovering it only after clicking submit.

Verified end-to-end (`test/quotaBreakerE2E.test.ts`) against the real built
server pointed at a fake Gemini endpoint that always 429s: one audit now
makes a small, bounded number of requests rather than 15+, a second audit
while still tripped makes zero further requests, and two audits fired
concurrently (a race the entry check alone does not close) still stay
bounded because the queued call is re-checked immediately before it executes.

**Not yet covered:** the breaker is Gemini-specific. ChatGPT/Perplexity/Claude
already fail on a single attempt with no retry loop (so they don't have the
amplification bug), but they also have no breaker, so a quota-exhausted
non-Gemini engine still makes one wasted call per query rather than
short-circuiting. Worth generalising to a per-engine breaker if those keys get
enabled and hit the same problem.

### 2.3b One click was buying four audits on a cold instance (fixed)

"This was the first use of the day. It should not have hit the wall so
quick." It was the first use of the day that caused it.

`src/apiClient.ts` retries any request whose connection fails or hangs, which
is right for a Render free instance waking from sleep (2.4). But it was
retrying `POST /api/audit/run`, and **aborting the client's request does not
abort work the server already started**. The submit that wakes the instance
stalls past the 30s timeout while the server accepts it anyway, so each retry
started another audit. Measured against the real built server before the fix:
four attempts, four concurrent audits, **16 real Gemini calls for one click**,
against a free tier documented at 10 requests per minute. The first use of the
day is exactly when the instance is asleep, so it was the run most likely to
be multiplied - the opposite of the intuition that a fresh day should be safe.

Fixed with `src/idempotency.ts`: the client mints one `Idempotency-Key` per
click and reuses it across its own retries; the server replays the job (or the
in-flight promise) already started under that key instead of starting another.
Applied to all four quota-spending endpoints - `/api/audit/run`,
`/api/audit/parse-url`, `/api/audit/generate-queries`,
`/api/audit/evaluate-query`. Proved end to end in
`test/retrySpendE2E.test.ts` by counting real HTTP hits: four retried submits
now cost one audit's quota.

**Not covered:** a browser tab still holding an old bundle sends no key and
gets the old behaviour (every call runs) - deliberate, since silently
collapsing un-keyed requests would turn a real second request into a no-op.
The stores are in-memory, so a restart or a second Render instance loses the
dedup; that is the same gap as 2.1/2.3 and is fixed by the same datastore.
Keys are unauthenticated, so a caller who guessed another user's key would be
handed their job id - no worse than 2.2, where nothing is authenticated at
all, but it becomes real work the moment 2.2 is fixed.

### 2.3c A per-minute rate limit was being treated as an exhausted day (fixed)

The same report had a second cause. `describeProviderError` classified every
429 as `kind: 'quota'`, so `generateContentWithRetry` responded to a
*transient* per-minute limit the same way it responds to a genuinely exhausted
daily quota: trip the breaker, abandon the audit, return zeros. Measured: a
single 429 whose own payload said `retryDelay: 5s` ended the audit after
**one** Gemini call, having waited none of the five seconds it was asked to.

Per-minute refusals are now `kind: 'rate_limit'` and are ridden out - one
wait, of the length the provider actually stated, then the same audit
continues. `kind: 'quota'` is now reserved for a wall lasting until the daily
reset. The wait is capped (`GEMINI_RATE_LIMIT_MAX_WAIT_MS`, default 20s);
past that, or if the retry also fails, the breaker still trips, because a
retry loop at every call site is the amplification 2.3a exists to prevent.
Call sites that deliberately fail fast (brand lookup passes `maxRetries=0`
because a back-off there is what produced "Brand lookup could not be reached")
never wait at all.

Three related things were wrong in the same code path and are also fixed:

- **The banner promised a retry that never happened.** "It will retry
  automatically in 1m 0s" - nothing retried, the audit was already dead, and
  the "1m" was this module's own fallback constant being shown as if the
  provider had said it. Messages now state a duration only when the provider
  stated one, and say so plainly when it did not.
- **Daily quotas reset at midnight Pacific, not UTC**
  (https://ai.google.dev/gemini-api/docs/rate-limits). `msUntilNextUtcMidnight`
  could hold the breaker shut for up to eight hours *after* the quota had
  already reset. Now `msUntilNextQuotaReset`, DST-aware via `Intl`.
- **`includes('429')` matched any string containing those digits** anywhere -
  a request id, a token count - and relabelled unrelated failures as quota
  problems. Now requires 429 to stand alone.

**Still imperfect:** the in-flight pacing gap went from 4s to 6.5s, because 4s
permits 15 requests/minute - above every documented free-tier Flash limit, so
the pacer's own ceiling was higher than the limit it existed to respect. This
makes a normal audit roughly 8 seconds slower. It is a fixed guess at the
limit, not a measured one; a real fix reads the provider's own rate-limit
headers, or the account enables billing (1.1) and the question stops mattering.

### 2.3d Nothing limited how fast, or how many, one client could spend (fixed per process)

Every `POST /api/audit/*` spends the shared quota and was open to anyone with
the URL. Added: a per-IP fixed-window limit (`RATE_LIMIT_PER_MIN`, default 30,
0 disables - `src/rateLimit.ts`), a cap on concurrent audits
(`MAX_CONCURRENT_AUDITS`, default 2 - a replayed submit under the same
`Idempotency-Key` is never refused by it), a reaper for jobs stuck "running"
past 15 minutes (they used to hold a slot forever), a 100kb body limit, and
length/type bounds on `parse-url`, `generate-queries` and `evaluate-query`
(only `/run` had them). Proved against the real binary in
`test/mvpHardeningE2E.test.ts`.

**Still imperfect:** the counters are per process. On a serverless host each
instance has its own, so the effective limit is looser than configured; the
real fix is the same shared store as 2.1/2.3 (roadmap item 11). Limits are by
IP, not by user, because there are no real users yet (2.2).

### 2.4 Render free tier sleeps (medium - partially mitigated)

First request after ~15 minutes idle takes 50 s or more, and the very first
connection attempt can be refused/reset outright while the container is still
booting - not just slow. That surfaced as a raw browser error ("Load failed"
on Safari, "Failed to fetch" on Chrome) reaching the user untranslated,
because it happens outside any try/catch that touches a server response:
`fetch()` itself throws before the server exists to answer.

Every request now goes through `src/apiClient.ts` (`apiFetch`), which retries
network-level failures with backoff (default 3 retries, up to ~10s total) and
only surfaces a message after retries are genuinely exhausted. This covers
the cold-start case but not a paid instance's absence - a client demo still
wants an always-on instance to avoid the 50s wait entirely.

### 2.5 Accuracy rate is weakly grounded (medium)

`accuracyRate` is derived from how many inaccuracies the narrative model
reported, over how many times the brand was mentioned. The mention count is
solid; the inaccuracy count is a model judgement with no ground truth to check
against. Treat the number as indicative, not measured. A real version would
diff engine claims against a client-supplied fact sheet.

### 2.6 Brand matching trades recall for precision (medium)

A multi-word brand is matched on its full name and its domain root only. The
first word alone is no longer matched, because "Poke House" was otherwise
scored as present in every answer about "poke bowls" — the audit reported the
brand as cited, and ranked first, in answers that never named it. Many small
businesses lead with their category word.

The cost is recall: a brand referred to only in shorthand ("Archer" for "Archer
Aviation") is missed unless the shorthand matches the domain root. Understating
visibility is the safer failure, but an alias list supplied per audit would
recover it.

### 2.6a Vendor discovery is now free, not an LLM call

"I searched a single query, it should not get that many calls" - correct,
and the fix went past error handling into removing calls that were never
earning their cost. Vendor discovery used to ask Gemini to list vendors
mentioned in the answers, then verify every returned name literally occurs in
the source text before accepting it - the model's answer was already being
fully re-derived from the text regardless, so `extractCandidateVendors` in
`src/analysis.ts` now does the same job with a capitalised-phrase heuristic
and zero network calls. Same recall-over-precision tradeoff as 2.6: it can
miss a vendor named only in lowercase or unusual casing, or one preceded by
an imperative verb the stopword list doesn't cover, but it cannot invent a
name that isn't in the text, and it never merges two distinct entities
joined by "and" into one wrong candidate (a real bug caught while building
it - `"&"` is kept as a connector since it is conventionally part of a single
name, `"and"` is not, since it lists separate ones).

Query generation is template-based by default too now (`getFallbackQueries`,
already existed, was previously only the fallback for when Gemini failed).
The LLM-authored version (`generateAuditQueries`) still exists, but only
behind the explicit "Generate Query Matrix" step in the Run Audit modal - a
cost the user opts into, not one every default audit pays silently. Brand
lookup (`/api/audit/parse-url`) was also firing automatically on submit
whenever domain or industry were blank; it is now only ever triggered by the
explicit "Auto-Detect from URL" button.

Net effect, verified end-to-end against a real (fake, but protocol-accurate)
Gemini endpoint in `test/quotaEfficiencyE2E.test.ts`: a single supplied query
now costs exactly 2 Gemini calls (one grounded search, one narrative
synthesis) - down from 6-7. The default three-template-query path costs
exactly `N + 1` for `N` queries, not `N + 3` (query generation, vendor
discovery, and narrative all used to be separate calls on top of the
per-query searches).

### 2.6b Vendor discovery was dominated by capitalised filler (fixed, with a recall cost)

2.6a removed the vendor-extraction LLM call and documented the cost as lost
*recall*. Measured in the 2026-10-09 audit, the real cost was lost
*precision*: a realistic markdown answer about Austin poke restaurants
produced 15 "vendors", 13 of them junk (`Monday`, `Pricing`, `Key`, `Why`,
`Austin`, `Yelp`, `Ask Siri`). The client's share of voice - divided by 16
instead of 3 - read 6% instead of 33%, and the "Rivals the engines named that
you did not list" card named `Pricing`, `Key` and `Fresh`. A fabricated rival
is exactly the failure `CLAUDE.md` warns about, and this one was introduced by
an optimisation that was reviewed for its failure mode and still got it wrong.

`extractCandidateVendors` now requires a name to be in a structural position
(bold, list head, heading, table cell) **or** be named at least twice, and
drops weekdays, months, label words ("Pricing", "Key"), generic table headers,
and review sites / search engines / the answer engines themselves (those are
sources, and already appear in the Citation Source Map). `Monday.com` survives
the weekday filter via its domain suffix; `Lowe's` keeps its apostrophe-s.
Tests in `test/analysis.test.ts` pin each of these, including the original
answer.

**Recall cost, stated plainly:** a vendor named exactly once, in unformatted
prose, is no longer discovered. That slightly flatters the client; the user can
add the rival as a tracked competitor and it is then always scored. The
stoplists are hand-maintained (like `COMMON_WORD_BRANDS`, 2.8). The durable fix
is a labelled golden set of real answers with precision/recall asserted in CI,
and an explicit decision on whether one *batched* extraction call per audit is
worth its cost (roadmap item 6).

### 2.12 Edits made after an audit are not persisted (low-medium)

Found in the 2026-10-09 UX tour. Queries added with "Add & Audit Query" and
remediation tasks ticked as done exist in browser state only: the server never
receives them, so they are lost on reload (the card and the Remediation tab now say
so). An added query still costs a real engine call. Persisting both means a PATCH
on the saved audit and a decision on whether an added query joins the headline
figures (today it deliberately does not).

### 2.13 The visibility range is a floor on the uncertainty (low-medium)

`wilsonInterval` (95%, rounded outward) is a confidence interval for the underlying
rate, not a prediction of a repeat run, and it assumes independent readings. Answers
from several engines to one question are counted as ONE reading (so is the
low-sample warning), but three different questions asked once are still treated as
three independent draws of one rate, which they are not. The honest fix is repeated
runs per query with paraphrased questions (MVP_AUDIT item 8); until then the card
says "plausibly" and the disclosure says the real uncertainty is wider. The model
ids shown are those REQUESTED, not necessarily the dated version a provider served.
Saved summaries (the audit list) carry neither the question count nor the models, so
the list badge shows the answer count only. Readings are the questions that produced a
usable answer (`questionsAnswered`; older reports fall back to the number planned).

### 2.5a Inaccuracy claims are attributed, not verified (medium)

Found in the 2026-10-09 independent review. The accuracy rate is now counted per
answer (not claim over mention) and a claim is kept only if it points at a
captured answer that names the brand (by query number, else by loosely matched
text; an engine that is not named means the only engine that answered).
**This is a shape check, not a fact check:** nothing verifies that the claimed
fact appears in that answer, so a hallucinated claim carrying a real query and
engine is still counted. Also: reports saved before this change used a different
definition (claims over mentions); do not trend `accuracyRate` across them. The
structured-output schema asks the model for `engine` and `queryNumber`; whether a
real model honours them has not been seen (no key), which is why discards are
shown to the user rather than hidden (the accuracy tile says "at most this", the
findings tile and sidebar show them as unlisted, never as a clean zero). A claim
whose number and text name different questions is discarded, not placed under a
guess. The narrative model is shown every answer up to `max(40, MAX_AUDIT_QUERIES x
4)`; beyond that cap, answers it never saw would count as "no flagged
inaccuracy". Reports saved before 2026-10-09 carry the older rate and no marker.

### 2.6d Vendor-name discovery still truncates some names (low-medium)

Found in the 2026-10-09 independent review. Accented Latin, Cyrillic and Greek
names are now discovered whole, Latin brands inside Chinese, Japanese and Korean
text are found without absorbing the surrounding characters, and word boundaries
in the brand matcher use the same script-aware class instead of ASCII `\b` (so
"Nestléx" no longer matches "Nestlé"). A brand's label is kept exactly as typed;
matching uses its composed (NFC) form; an underscore stays a word character, so
`adyen_token` is code and not a mention. **Still true:**

- Hyphenated names and names with a leading digit are cut ("Coca-Cola" becomes
  "Coca", "Mercedes-Benz" "Mercedes", "Studio 54 Fitness" "Studio", "3M" is
  dropped). Same class of defect as the accents; not fixed here. Add such a rival
  as a tracked competitor and it is measured correctly.
- Vendors written in CJK, Arabic or other caseless scripts are never discovered
  (there is no capital letter to anchor on); tracked competitors still are.
- Turkish dotted İ does not survive lower-casing in the matcher, so a discovered
  name containing it is dropped at scoring time (a missed rival, not a fabricated
  one). Title-case letters (U+01C5) are not capitals to the discovery pattern.
- A client typed without accents ("Nestle") does not match "Nestlé" in answers.
- A mixed-script look-alike ("Stripe" with a Cyrillic е) is a separate candidate
  from "Stripe"; invisible variation selectors can split one name into two (both
  collapse later in `dedupeMatchers`).
- Answer text is compared in NFC, so an excerpt of a decomposed answer is cut from
  the composed copy and is not a byte-for-byte slice of the stored text.
- Extraction is quadratic on a single very long line (about 9 s for 200 KB of
  table cells, unchanged by the Unicode work); real answers are far smaller.

### 2.6c Two-character brands: acronyms are measured, other short names are not (medium)

Found in the 2026-10-09 independent review. Every brand token under three
characters used to be skipped, so a brand such as HP was measured at 0% and
reported as "omitted" on every engine. Now a name that is **entirely** a
two-character acronym in capitals or digits (HP, 3M, EY, BP), or a longer name
(HP Inc, 3M Company) whose first word is that acronym **and** equals the root of
the domain the user gave (hp.com), is matched exactly as written, with word
boundaries. **Still true, and not fixed:**

- Everything else short still reads 0%: a one-character name; an ordinary word
  (On, Go, It, Us); a name typed in lowercase or mixed case ("hp", "Hp", "hp
  inc"); "HP Inc" with no domain or a different one; a punctuated legal name
  ("HP, Inc."); hyphenated names ("EY-Parthenon"). A domain equal to a dictionary word proves nothing, so none of
  these is promoted. The honest end state is a visible "cannot be measured" state
  instead of a zero; not built.
- An acronym matches by spelling, so it can match another sense of the same
  letters: "$3M" (three million), "200 HP" (horsepower), "BP" (blood pressure), and
  a brand whose whole name is a common acronym ("AI", "IT", "US") is credited with
  every occurrence. Read the evidence for any quoted figure.
- The word boundary is ASCII-only: "éHP" matches, and "HP-UX" matches (a hyphen is
  a boundary).
- A tracked competitor whose name contains the client's ("BP Pulse" beside "BP")
  is dropped by `dedupeMatchers`, the same as "Stripe Atlas" beside "Stripe".

### 2.14 End-to-end tests draw random ports from overlapping ranges (low-medium)

Found 2026-10-10. `test/quotaBreakerE2E.test.ts` (3400-4000) and
`test/quotaEfficiencyE2E.test.ts` (3500-3900) overlap, as do other pairs, and none
handles a collision. One CI run failed in `quotaEfficiencyE2E` ("Could not reach
Gemini", zero requests seen by the fake) and passed on re-run of the same commit; it
did not reproduce locally in three runs. A port collision is the suspected cause
(INFERRED, not proven). Fix: have each test listen on port 0 and read the assigned
port back, and fail loudly on a bind error. Until then a single unexplained red in
those files is a re-run, not a regression, but it must be recorded here.

### 2.15 Loose ends from the reliability work, 2026-10-10 (low-medium)

- **The number guard covers the executive summary, model forecasts (`expectedGain`) and the
  "questions affected" count only.** Claimed and actual facts, omission descriptions, root causes,
  recommendations and remediation descriptions are model free text and are not guarded; a figure
  there is not measured, and the summary note says only what was checked. Saved audits written
  before the guard keep their old summaries.
- **The guard works on extraction.** It removes any sentence in which it finds a figure. It can miss
  a figure written in a way it does not know (a script or phrase not in its lists); a hand-written
  corpus of bad and good phrasings in `test/reportGuard.test.ts` is the only recall evidence, and
  real model phrasing has not been sampled. It removes more than strictly needed (a sentence
  repeating a measured figure, "named twice" as prose), which is the safe direction.
- **Known extraction misses and over-removals:** a bare 4-digit number is read as a year only after a preposition or month, or when it closes a clause or a list of years, so "in 2000 visitors" style phrasings are treated as figures (safe direction) and a year in an unusual position is removed; quantity words not in the lists ("several", "a handful", "most") are deliberately not figures, and others may be missing.
- **Claims without a figure are not checked.** "Acme never appears", "in every answer", "ranked first" pass the guard even when the measured sentence beside them says otherwise (visibility 33%). The guard is about figures; a check of absolute claims against the measured rates needs its own design.
- **Removing a sentence can orphan its neighbours** ("Despite this, the brand is well positioned" after the sentence it answered was removed). The measured sentence comes first and the note says sentences were removed; nothing repairs the prose.
- **Non-English number words and CJK numerals are not recognised** ("trois sur quatre", "五"); this matters only if a summary comes back in another language.
- **The invariants check relations between the report's own figures, not the figures against the raw
  answers.** It cannot catch a wrong brand match, and on realistic reports it holds by construction
  today; it is a tripwire for future code changes, not evidence of correctness. A violation costs
  the audit's collected evidence and the quota behind it (it is not billable to the person), and has
  no incident id: only a server log line.
- **Cited-only as its own number** (RELIABILITY step c, second half) is not built. The "Not counted"
  strip and list exist for discarded inaccuracy claims only (at most 20 rows kept, the rest counted);
  other things the pipeline drops (vendor names that fail verification, answers that errored) are
  counted elsewhere but not listed there. A saved audit from before this change shows its count and says the
  reasons were not recorded. Rows are in the model's order, not grouped by reason (27 near-identical cards
  are possible). `answer_does_not_name_brand` is also the reason when a measured engine had no captured
  answer for that question (the function sees only brand-naming answers), so its sentence says "or no answer
  was captured". The printed/PDF view of the export carries the count and footer, not the rows; the copied
  summary text carries the rows. The export wiring itself (modal calling `notCountedExportText`) has no browser test.
- **The $0 guard counts per process.** `GEMINI_DAILY_CALL_CAP` and the call counter live in memory of one server process; on Vercel each function instance counts alone, so a cap is a brake against loops, not a ceiling on the day's spend, and a restart resets it. The money control is a Google project with no billing account (owner action O-2), which the app cannot see. A durable counter needs the database (PROGRAM row 8).
- **Browser coverage:** the summary-note line on screen and in the export has no browser test.
- **Step e engine (slice S3), still unproven:** the refusal to make a call when the step was taken over before its
  call started (`startCall`) is covered only at the store level (the window between claim and `markCallStarted`
  is too small to hit from outside), and when it fires the page-driven request just answers `busy`. Jobs that end in
  error (a failed or exhausted step, a driver error) are not compacted, so their raw step answers stay for the
  seven-day retention; the person gets no report in those cases.
- **Step e client driver (slice S4) limits:** `vercel.json` sets no `maxDuration` and the Gemini client has no
  HTTP timeout: neither has a principled value until the owner reports the real function limit (O-3; the ledger
  says 300 s with fluid compute is AGENT-level, a 10 s older default is possible). What a person actually sees if
  a step hangs or is killed: the page keeps asking and is told `busy` (the lease is 10 minutes, `AUDIT_LEASE_MS`),
  gives up at its own 8 minutes with a sentence that says the audit has stopped, and the reaper stops the job at
  15 minutes (`JOB_MAX_RUN_MS`). The "three tries then `step_attempts_exceeded`" ending is NOT reachable from a
  page on the default numbers (the page gives up before the lease can expire); it is what a restart-and-resume
  (S5) or a shorter `AUDIT_LEASE_MS` reaches. A gateway error (502/503/504) on an advance is asked again by the
  page, up to four in a row, then ends with a sentence that says the audit is paused. A hidden browser tab
  throttles timers, so a page-driven audit slows in the background. On Vercel with the memory store most advances may land on a different instance
  from the one that took the job, so `AuditInterrupted` may be common until the durable database (row 8).
  A page-driven audit that is abandoned keeps its concurrent-audit slot for `AUDIT_STALL_MS` (3 minutes) and is
  stopped by the reaper after `JOB_MAX_RUN_MS`; if it had already started an engine call it stays billable (it spent
  quota), and only one that never reached an engine is recorded as free (found in the S4 review: it used to be
  recorded as free either way, which let abandon-after-one-step escape both daily budgets). The stall window
  applies only to page-driven audits: a server-driven audit is being worked on however long one step takes. A
  step that ends `step_attempts_exceeded` or `step_exception` is recorded as not billable even if calls were made
  (its sentence says "nothing from it is counted"); reaching that takes three lease expiries, so it is slow to
  repeat, but it is a known gap in the allowance. An old page bundle open across a deploy only polls: against a
  page-driven audit nothing runs and it ends at its own timeout (spending nothing); a reload fixes it.
  `AUDIT_LEASE_MS` shorter than the longest step lets a second advance repeat the call (accounted: `attempt` 2,
  `repeated_calls`, a `lease_expired_midcall` incident); there is no floor on it. Not delivered in S4 and moved to
  S7, where the page first needs them: the additive GET fields `phase`, `step`, `instanceId` (the advance reply
  carries the `steps` summary already); the plan's `wait` outcome was replaced by `nextStepAfterMs` plus `idle`.
- **Step e engine (slice S3) tests:** the several-engine path (steps for each paid engine, one after another) has
  no end-to-end test because only Gemini can be faked; `planSteps`, the ordering and the breaker rule have unit
  tests (`test/auditSteps.test.ts`). `closeJobAfterFailedStep` (a claim reporting an exhausted or failed step) cannot
  be reached by the inline driver, whose own exceptions end the audit in `advanceJob`; it is covered when the
  client driver or the sweeper can re-claim (S4, S5).
- **Step e engine (slice S3), review notes:** deleting a saved audit does not delete the job record that produced it,
  which keeps the report for up to `JOB_RETENTION_MS` (seven days; this predates the steps). The raw answers in
  the step rows are dropped when the job finishes (`compactJobSteps`). A job failed at boot (`failCode:
  restarted`) is not finished by anyone, unlike one the reaper stopped (`stuck`); two processes on one
  `DATA_DIR` are not supported. Closing a failed step on a job the reaper already stopped returns silently.
- **Step e engine (slice S3) limits:** engines now run one after another within a question (one step each),
  where they used to run in parallel; with only Gemini (the free engine) nothing changes, and with several paid
  engines a question takes longer. A crash between saving the audit and marking the job done can, on resume,
  save a second copy under a new id (slice S5 should store the finished report on the finish step first). The
  incident for a late result that was refused (a step taken over while still working) cannot be reached by the
  inline driver and has no end-to-end test until the client driver (S4) can run two advances at once. While
  collecting, the heartbeat is touched once per step, not during a long step.
- **Step e store (slice S2) limits:** a held database writer lock blocks the whole Node process for up to the
  5 s `busy_timeout` (the sqlite calls are synchronous) and then surfaces as a typed `StoreBusyError`
  (`store_busy`), which the server must turn into a sentence (S3/S4). `repeatedCalls` is a lower bound (a
  collector can also retry inside one step). A crash between receiving `exhausted` and closing the job is
  repaired by the next claim reporting it again, not by the store: the engine or the S5 sweeper must close the
  job. Start-up retries only the `journal_mode = WAL` switch (about two seconds, because SQLite refuses it
  at once when another process holds the file); the migrations wait on the writer lock instead. Only the
  `BEGIN IMMEDIATE` paths raise the typed `StoreBusyError`; the plain writes (`updateJob`, `touchJob`,
  `markCallStarted`, `completeStep`) can still raise a raw 'database is locked'. A late result from a holder
  whose step was already taken over is refused by design (fencing): the engine must record that as an incident,
  not drop it silently (S3). If another process holds the writer lock for longer than the 5 s wait while a
  server opens its database, the open raises `StoreBusyError` and `openStore` falls back to memory for that
  process (logged, and the public note says the database could not be opened) until it restarts.
- **First-visit review leftovers (PR #30):** "Add & Audit Query" in the query tab ignores the
  no-engine state; the model-written query count path (`DEFAULT_QUERY_COUNT` in the prompt and
  slice) has no test that fails if removed; three components each poll the status endpoint.

### 2.7 Vendor discovery depends on one model reading its own output (low-medium)

Discovery is guarded — every extracted name must literally occur in the answer
text or it is discarded — so it cannot invent a competitor. It can still *miss*
one (a vendor mentioned only obliquely), which would slightly flatter the
client's rank. Recall is unmeasured.

### 2.11 Known limits of the MVP foundation (read before scaling)

Written 2026-10-09 so none of these is rediscovered:

- **One instance only.** SQLite is a file on one machine. A second instance would
  not see the first one's jobs or audits. The next step is Postgres behind the
  same `Store` interface (`src/store.ts`); the admission lock in `server.ts`
  (`serialised`) only matters once the store is asynchronous and would need to
  become a transaction.
- **Privacy model.** Saved audits belong to (code label, email). Anyone holding a
  code can sign in as any email *under that code* and see audits saved under it.
  Give people who need private audits their own code. The operator can read
  everything in the database. Real per-person accounts need the user table
  (roadmap item 4, Google sign-in - 1.5).
- **Session token is in `localStorage`** and the app sets no
  `Content-Security-Policy`; an injected script could read it. Sessions expire
  (7 days) and die with their code. A CSP and an httpOnly cookie are the fix.
- **Some limits are per process:** the hourly lookup limit and the per-IP limits
  reset on restart (the daily *audit* budgets are in the store and do not).
  `TRUST_PROXY` must match the real number of proxies - too high lets clients
  spoof their address, too low throttles everyone together.
- **No admin kill switch** and **no spend cap on the Gemini key itself** - set one
  in Google's console.
- **Budgets are per access code, not per person.** People who share a code share
  its allowance, and changing the email does not reset it (the email is free
  text). Give each person their own code if they need separate allowances.
  Reusing a label for a *new* person hands them the previous holder's saved audits
  (audits belong to label + email and survive code removal): treat labels as
  identities and retire them, do not recycle them.
- **"Non-billable" failures could be farmed.** An audit that collects no evidence
  is not counted against the budget. Someone could craft queries the engines
  reject and run many such audits; they are still bounded by the concurrency cap
  and the per-IP limit, and cost little, but it is a hole in the budget.
- **A job reaped as stuck stops counting toward the concurrency cap** even while
  its work is still running, and tells the person it failed; if it later finishes
  it flips to done and is saved (the audit was paid for). Slightly confusing, never lossy.
- **The limiter table is capped (50,000 keys)** and fails closed past that: a
  flood from many addresses can make new addresses wait. IPv6 clients are limited
  by /64 to make that hard. Acceptable against unbounded memory.
- **Jobs are not resumable.** An audit cut off by a restart or deploy is marked
  failed with a sentence (and is not counted against the daily budget); the
  person re-runs it. A job reaped as stuck after 15 minutes that later finishes
  is still recorded.
- **No automated backups.** `node scripts/backup.mjs` makes a consistent
  snapshot (a plain copy of `geo-audit.sqlite` alone loses recent writes - they
  are in the WAL), but nothing schedules it or copies it off the host. Use the
  host's disk snapshots too. Deleting an access code does not delete that person's saved
  audits.
- **`node:sqlite` is marked experimental by Node 22** (it prints a warning at
  start). It is stable in practice but the API could change; `engines` pins
  Node >= 22.13.
- **The standard queries are generic.** Two of the three necessarily name the
  brand (a comparison and a price question). The first is brand-neutral only
  when an industry or competitor is given; the report and card warn when every
  query names the brand, because then "100% visible" is near-guaranteed. A real
  audit needs the person's own category questions. Visibility is still a share of
  a handful of answers (the card says how many).
- **Nothing has run against a real answer engine** (no key where this was
  built). The Gemini adapter is exercised against a protocol-faithful fake and,
  once, a real rejected-key response; the ChatGPT/Perplexity/Claude adapters have
  never seen a live payload (2.8).
- **Docker image and `render.yaml`** are unproven until CI/Render run them.

### 2.8 Smaller items (low)

- `CitationSource` is declared twice, in `src/types.ts` and `src/analysis.ts`.
  They agree today; nothing enforces that they keep agreeing.
- Share-of-voice percentages are each rounded independently, so a scoreboard can
  sum to 99 or 101.
- `COMMON_WORD_BRANDS` in `src/analysis.ts` is a hand-maintained list. A brand
  that is an ordinary word but missing from the list (say "Notion" were absent)
  would over-count mentions. Only affects brands whose names are dictionary
  words.
- `untrackedRivals` is computed and returned, and those rivals do appear in
  Competitor Intelligence, but nothing labels them as *discovered* rather than
  tracked — the most interesting part of that finding is not called out.
- ~~`generateSynthesizedAudit` still emits placeholder remediation text.~~ Fixed
  2026-10-09, see 2.1b: the failed-audit report now carries no findings.
- The provider adapters have never seen a LIVE payload from OpenAI, Perplexity or
  Anthropic. `test/providers.test.ts` (added 2026-10-09) runs them against
  fixtures written from the vendors' docs - it pins what is sent and how the
  documented shapes are parsed, not what the services return today. Recording one
  real response per engine into the fixtures is the next step once keys exist.
  Also untested: that `server.ts` passes an adapter's sentence through unflattened (the
  suites never configure a non-Gemini engine, because the vendor URLs are hard-coded);
  re-introducing a second `describeProviderError` over `answer.error` would go unnoticed.
  An invalid-model 400 from OpenAI or Perplexity gets the generic sentence (only the
  wordings listed in `errors.ts` name the model variable), and a 403 "no access to
  model" reads as a rejected key.
- `Core Offerings` was removed from the audit form as low value; the field still
  exists in the API and types, unused, and should be retired properly.
- There is no UI test layer. Interactive regressions (a tile that is not a
  button, a control below the fold on mobile) are still caught only by eye.

---

### 2.9 Search volume is gone, not fixed (low)

Every query used to carry an invented monthly search volume. It is now absent
and labelled "Not measured". Showing a real figure needs a keyword data
provider (Ahrefs, Semrush, Google Keyword Planner) — worth doing, since buyers
expect it, but it must come from a source rather than a model.

## 3. Expansion — worth building next

Roughly in order of value per unit of effort.

### 3.1 Persistence and re-audit over time (highest value)

Store audits, then re-run the same query set on a schedule. Show the delta.
"Your visibility went 12% → 34% after we shipped the schema fixes" is the
argument that justifies a retainer. Unlocks 2.1 wholesale.

### 3.2 Answer-engine trend alerting

Once history exists, alert on drops: a competitor overtaking the client on a
tracked query is exactly the moment a client wants an email. `MonitoringConfig`
already models the settings; only the backend is missing.

### 3.3 Source-gap → outreach worklist

The Citation Source Map already identifies the domains engines trust. The next
step is turning that into a task list: for each high-influence source where the
client is absent, what specifically to do (get listed on G2, answer the Reddit
thread, publish the comparison page). This is the highest-margin consulting
output the data already supports.

### 3.4 Provider-agnostic analysis

Vendor discovery and narrative are hardwired to Gemini. Abstracting them behind
the same provider interface as the answer engines would remove the mandatory
Gemini key (1.2) and let the cheapest capable model do the extraction.

### 3.5 Evidence viewer in the UI

The full verbatim answer, the searches each engine ran, and every citation are
already captured and returned per query — but nothing renders them. A drawer
showing "here is exactly what Perplexity said, and here is where it looked"
would make findings defensible in front of a client's team, and it is mostly a
presentation job since the data is in hand.

### 3.6 Prompt-set expansion

Audits currently run three generated queries. Real buying journeys span far
more intents. Broader, persona-segmented query sets would make share-of-voice
statistically meaningful rather than indicative — gated on cost control (2.3).

### 3.7 PDF export

`ExportReportModal` produces text. A branded PDF is what actually gets forwarded
to a client's executive team.
