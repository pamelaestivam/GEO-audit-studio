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

---

## 2. Known tech debt

Ordered by how likely it is to hurt.

### 2.1 Nothing is persisted — audits die on refresh (high)

Audits live in React state only. Refreshing the page loses everything, so:

- **History and trend charts are decorative.** `MonitoringTab` falls back to a
  hardcoded array when `historicalScores` is absent, and real reports never set
  it. The chart therefore shows invented movement.
- **Continuous Sweeps is a settings form that schedules nothing.**
- A client cannot be shown "your score moved from X to Y after our fixes",
  which is the main reason anyone renews a subscription.

Needs a datastore (Render offers managed Postgres). This is the single largest
gap between the current build and something sellable.

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
