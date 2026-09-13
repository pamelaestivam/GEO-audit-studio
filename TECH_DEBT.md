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

### 1.4a Vercel served only the static frontend - every API route 404'd (fixed)

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

Verified two ways: `test/vercelServerless.test.ts` (new; wired into
`npm test`) calls the real `api/[...path].ts` handler on a real
`http.Server` and confirms it answers `/api/health` and
`/api/audit/status`, and separately confirms `buildApp()` without
`VERCEL` set still serves the static frontend exactly as before - so
this change doesn't regress the Render path it didn't touch. The
non-Vercel path was also smoke-tested by hand: built `dist/`, ran
`node dist/server.cjs` for real, curled `/api/health` and `/`.
**Not verified**: an actual `vercel deploy`/`vercel dev` run, since this
session has no Vercel CLI credentials. The owner should confirm the live
URL's `/api/health` returns `{"status":"ok",...}` after this merges, not
assume it from the test suite alone.

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

**Fast-follow, not yet done:** the Monitoring Settings form below the chart
still copies for "Automated AI Search Audit & Alert Settings" and shows a
"Next scheduled audit run" date, but `onUpdateConfig` only ever updates
local React state - saving does not schedule anything server-side. The UX
lead seat flagged this as the same honesty problem, one layer down; it was
deliberately not fixed in the same change (it's a copy/scope decision, not
a one-line correctness fix, and `CLAUDE.md` asks for small, focused PRs).
Whoever picks this up next should either disable/label the form as
"preview - not yet active" or wire it to something real once 3.1/3.2 exist.

### 2.2 Authentication is not authentication (high)

`/api/auth/login` **auto-registers any email/password it has not seen**, so
every login attempt succeeds. Users are held in an in-memory `Map` wiped on
every restart or redeploy. Passwords are stored in plaintext and compared with
`===`. There is no session validation on any audit endpoint — the "token" is a
timestamp string that nothing checks.

Anyone with the URL has full access. Do not put this in front of paying clients
without replacing it (real user table, hashed passwords, signed sessions).

### 2.3 Audit jobs live in memory (medium)

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

### 2.7 Vendor discovery depends on one model reading its own output (low-medium)

Discovery is guarded — every extracted name must literally occur in the answer
text or it is discarded — so it cannot invent a competitor. It can still *miss*
one (a vendor mentioned only obliquely), which would slightly flatter the
client's rank. Recall is unmeasured.

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
- `generateSynthesizedAudit` still emits placeholder remediation text. It is
  only reachable on the degraded path, which is now clearly banner-flagged, but
  the content itself is invented and should ideally be empty.
- The provider adapters are untested against real API responses — their parsers
  are written defensively but have never seen live payloads from OpenAI,
  Perplexity or Anthropic. This is the largest remaining untested surface.
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
