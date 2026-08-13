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

Even with other keys set, `GEMINI_API_KEY` is required: vendor discovery and the
narrative both run on Gemini. Removing that dependency is real work (see 3.4).
The error messages now name this explicitly rather than claiming nothing is
configured.

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

### 2.3 Long audits may hit a proxy timeout (medium)

Queries run sequentially with a 1.2 s gap; engines within a query run in
parallel with a 90 s per-request timeout. A slow 8-query audit across several
engines can therefore exceed typical edge timeouts, and the browser would see a
dropped connection rather than a result.

Proper fix: make the audit a background job — return a job id immediately, poll
for status. That also fixes the "user stares at a spinner for two minutes"
problem. Interim mitigation: keep `MAX_AUDIT_QUERIES` low.

### 2.4 Render free tier sleeps (medium)

First request after ~15 minutes idle takes 50 s or more. Fine for iteration,
bad for a client demo. A paid instance removes it.

### 2.5 Accuracy rate is weakly grounded (medium)

`accuracyRate` is derived from how many inaccuracies the narrative model
reported, over how many times the brand was mentioned. The mention count is
solid; the inaccuracy count is a model judgement with no ground truth to check
against. Treat the number as indicative, not measured. A real version would
diff engine claims against a client-supplied fact sheet.

### 2.6 Vendor discovery depends on one model reading its own output (low-medium)

Discovery is guarded — every extracted name must literally occur in the answer
text or it is discarded — so it cannot invent a competitor. It can still *miss*
one (a vendor mentioned only obliquely), which would slightly flatter the
client's rank. Recall is unmeasured.

### 2.7 Smaller items (low)

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
- No automated test covers the Express layer; `npm test` covers the analysis
  layer only. The provider adapters are untested against real API responses —
  their parsers are written defensively but have never seen live payloads from
  OpenAI, Perplexity or Anthropic.

---

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
