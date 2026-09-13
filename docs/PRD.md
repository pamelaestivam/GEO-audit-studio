# GEO Audit Studio — Product Requirements Document

Status: **draft, partially grounded**. Built from `CLAUDE.md`, `TECH_DEBT.md`,
the codebase itself, and the strategy sessions in `docs/DECISIONS.md`.
Sections marked `[NEEDS INPUT]` are gaps this repo genuinely cannot fill
without guessing — per the EVAL PM rubric (`docs/EVAL_PM.md`), a fabricated
market/customer section caps Groundedness at 2 and blocks SHIP, so they're
left open rather than invented. `[ASSUMPTION: ...]` marks an inference this
PRD is making that hasn't been confirmed. See the questions at the end.

*Author: PM Twin (drafted this session). Contributors: CTO, UX Lead, EVAL PM.*

---

## 1. About

GEO Audit Studio measures and reports how a business actually appears
inside AI answer engines (Gemini today; ChatGPT, Perplexity, and Claude
are built but not yet enabled — `TECH_DEBT.md` §1.1) when a real user asks
a real question an AI would answer with a recommendation. It queries the
engines with real prompts, captures verbatim answers and citations, then
runs deterministic analysis (never an LLM) to score visibility, share of
voice, accuracy, and omissions against named competitors — and turns that
into a report and a remediation plan a business could act on.

`[ASSUMPTION: the TLDR above is "answer-engine visibility audits for
businesses, sold as a report and eventually a retainer" — confirmed by
CLAUDE.md and the shape of the product, not stated anywhere as a mission
sentence. Confirm or correct.]`

## 2. Market Insights

### Competitor analysis
`[NEEDS INPUT]` — Nothing in this repo asserts which competitors exist or
what they do. General awareness (not project-specific, not verified live)
places "AI visibility / answer-engine monitoring" as an active, young
category — tools positioned around AI Overviews, ChatGPT, and Perplexity
visibility tracking exist and are actively funded as of this session's
knowledge cutoff. Treating any specific name or claim as fact here would
be exactly the fabrication EVAL PM's rubric caps at Groundedness 2 — a
real competitive scan (live pricing pages, feature lists) should be done
before this section is filled in, not guessed from training memory.

### Market analysis
`[NEEDS INPUT]` — market size, growth rate, saturation.

### Technology analysis
Grounded, since it's this repo: engines are queried live per-request, no
answer is cached or simulated, and a missing API key means an engine is
reported as *not measured* rather than silently substituted
(`CLAUDE.md` §Engine providers). This is a real, checkable differentiator
against any tool that infers AI visibility from search-rank proxies
instead of actually asking the engines.

### Customer segments
**Decided (2026-09-13, owner):** not committing to one ICP yet — still
validating across segments (agency / direct SMB / enterprise in-house).
The client names in `CLAUDE.md`'s working notes (Stripe, Poke House,
Hyundai, City Sports) are audit **subjects** used while building and
testing the pipeline, not confirmed paying customers, and that stays
true for now. Product/UI decisions should stay segment-agnostic until
real usage picks a segment, rather than optimizing for a guess.

### User personas
Deliberately deferred alongside customer segments above — inventing a
named persona ahead of a chosen segment would be exactly the kind of
fabricated specificity EVAL PM's rubric penalizes. Revisit once real
usage or a deliberate segment bet exists.

## 3. The Problem

### Use cases (grounded — this is what the product already does)
- A business or its agency wants to know: when someone asks an AI "best
  X for Y," do we show up, are we described accurately, and who beats us?
- Ongoing: did a fix (schema markup, a new page) move the needle over time
  — currently undermined by `TECH_DEBT.md` §2.1/3.1 (no real persistence
  yet, so "before/after" can't honestly be shown).

### Pain points
Businesses can rank well in traditional search and still be invisible or
misrepresented in an AI-generated answer, with no existing tooling most
buyers have to check that directly — they'd have to manually prompt
several AI products themselves and read the answers.

### Problem statement
`<A business's marketing/SEO owner cannot tell whether ChatGPT, Gemini,
Perplexity, or Claude recommend them accurately (or at all) against their
named competitors, and has no way to track whether that changes over
time.>` `[ASSUMPTION — matches the product as built; not a sentence
Pamela has confirmed verbatim.]`

### Hypotheses and mission statement
`<By bringing real, multi-engine AI-answer evidence and deterministic
scoring to life, we make it possible for a business to see and improve
its AI-answer presence the way it already does for traditional search
[ASSUMPTION].>`

## 4. The Solution

### Business model
**Decided (2026-09-13, owner): freemium, upsell to paid monitoring.** A
free single-engine snapshot audit is the top of funnel; paid unlocks
more engines, real history/trend tracking, and alerts. This directly
sets the paid-tier gate: `TECH_DEBT.md` §3.1 (persistence/history) and
§1.1 (additional engines) are no longer just "highest value" in the
abstract — they're the two things this business model is actually
selling. §3.2 (trend alerting) is the natural next paid feature once
history exists, for the same reason.

Implication for sequencing: shipping the free tier well (accurate,
trustworthy single-engine audits — largely already true, modulo the
fabrication bugs already fixed) matters as much as building the paid
features, since a freemium funnel converts on the free tier's quality
first.

### Ideation / feature backlog
See `TECH_DEBT.md` §3 ("Expansion — worth building next") for the full,
already-prioritized list: persistence + re-audit over time (3.1), trend
alerting (3.2), source-gap → outreach worklist (3.3), provider-agnostic
analysis (3.4), an evidence viewer (3.5), broader query sets (3.6), PDF
export (3.7). This PRD does not re-derive that list; it inherits it.

### Leveraging AI — why AI is essential
Not optional here: the thing being measured *is* AI-generated answers.
There is no non-AI way to know what Gemini or ChatGPT would tell a user
about a business. Analysis and scoring are deliberately kept
**non**-AI (`src/analysis.ts` is pure functions, per `CLAUDE.md`
§Architecture) precisely so the one AI-essential part (querying the
engines) doesn't get muddied by AI also being asked to judge itself.

### Feature prioritization (RICE)
`[NEEDS INPUT]` — Reach/Impact/Confidence need a real user base or at
least a stated target segment (Question 1) to estimate honestly; scoring
them now would be inventing numbers to fill a table. `TECH_DEBT.md` §3's
ordering ("roughly in order of value per unit of effort") is the
CTO/PM's qualitative stand-in until real data exists.

### AI MVP
Already shipped, not hypothetical: live Gemini querying + grounded
citations + deterministic scoring is the MVP, running in production
today (single-engine).

### Roadmap
See `TECH_DEBT.md` §1 (open actions) and §3 (expansion) — this PRD treats
that file as the living roadmap rather than duplicating it here where it
would drift out of sync.

### Technical architecture
See `CLAUDE.md` §Architecture (evidence collection → deterministic
analysis → narrative interpretation → honest presentation) and
`TECH_DEBT.md` §1.4/1.4a for current hosting (Vercel, serverless, one
catch-all function wrapping the existing Express app) and its known
state-sharing limitation.

### Assumptions and constraints
- Gemini is currently a hard dependency (`TECH_DEBT.md` §1.2).
- No real persistence yet; nothing survives a refresh (§2.1).
- Auth is currently a stub, not real authentication (§2.2).
- Every additional answer engine multiplies per-audit cost linearly
  (`MAX_AUDIT_QUERIES`, `CLAUDE.md` §Engine providers).

### Risks
- **Quota/cost risk**: enabling more engines or higher query volume scales
  spend directly; already the subject of the most-fought bug history in
  this repo (`TECH_DEBT.md` §2.3 family).
- **Concurrency risk on Vercel**: in-memory breaker/job/idempotency state
  doesn't survive multiple warm Lambda instances (§1.4a) — a real blocker
  before more than one concurrent user.
- **Trust risk**: any surface that shows a number or chart not backed by
  a real measurement (the bug fixed in §2.1a) directly damages the
  product's core promise the moment a client notices.
- **Market risk**: `[NEEDS INPUT]` — competitive and demand risk can't be
  assessed without the market/customer sections above.

## 5. Requirements

### User journeys
`[NEEDS INPUT]` — no funnel/onboarding is defined beyond "submit a
business, get a report"; whether there's a signup/trial/payment step
depends on Question 2 (business model).

### Functional requirements (grounded — what's actually built)
- Submit a business (name, domain, industry, competitors) and receive an
  audit: per-query engine answers, citations, visibility score, share of
  voice, leader share, accuracy rate, omissions, remediation plan.
- Engines queried live; a missing key reports "not measured," never
  substituted.
- Background job execution with idempotent submission (retries never
  duplicate an audit or its cost).
- Quota-aware: a circuit breaker prevents an exhausted provider quota
  from being rediscovered on every request.

### Non-functional requirements
- Every user-visible number must be a real measurement or explicitly
  marked as not measured — this is the product's core integrity
  guarantee, enforced by `test/contract.test.ts`.
- Cost per audit is bounded and observable (`MAX_AUDIT_QUERIES`).
- `[NEEDS INPUT]`: target latency, uptime/SLA expectations, and any
  compliance requirement (e.g. data retention if audits become
  persisted) all depend on the business model and customer segment.

### AI & data requirements
Evidence is first-party (queried live per audit, not a static dataset).
No training or fine-tuning involved. Persisted history (once built, per
§3.1) would need a decision on retention period and whether audit data
for one client is ever usable across clients (it should not be, without
explicit consent — flagging this now since it's the kind of decision
that's much cheaper to make before the datastore is built than after).

## 6. Challenges

- **Data**: no shortage of things to measure (the engines exist and are
  queryable); the constraint is spend, not availability (§Risks above).
- **Conviction**: `[NEEDS INPUT]` — has any real prospect or client
  confirmed they'd pay for this, and at what frequency? Nothing in the
  repo answers this; see Question 2.

## 7. Positioning

| Use Case | Pain Point | Possible Solution | Impact |
|---|---|---|---|
| "Are we mentioned when someone asks ChatGPT/Gemini for a recommendation in our category?" | No visibility into AI-generated answers today | Live multi-engine query + citation capture | Turns a blind spot into a measured, trackable metric |
| "Did our last SEO/content fix actually move our AI-answer presence?" | No before/after story exists yet (§2.1/3.1) | Persisted history + re-audit on schedule | The single feature most likely to justify a retainer, per the team's own prioritization |
| "Where are competitors winning citations that we aren't?" | Hard to know which sources AI engines trust for this category | Citation Source Map → outreach worklist (§3.3) | Turns findings into a concrete task list, the highest-margin consulting output the data already supports |

## 8. Measuring success

### Metrics
North Star not committed yet (below), but the freemium decision implies
a funnel worth tracking regardless of which North Star is eventually
chosen: free audits run → accounts that return for a second free audit
→ upgrades to paid monitoring → retained paid accounts month-over-month.

### AI-specific metrics
Quality here means: did the engine actually get queried (not simulated),
and does every displayed number trace to real evidence? `test/contract.test.ts`
already encodes this as a pass/fail gate — arguably this product's
AI-specific quality bar is unusually well-defined already, just not
phrased as a PM metric yet.

### North Star metric
**Deferred (2026-09-13, owner): not decided yet.** Candidates remain:
audits run, businesses actively monitored (recurring, not one-off),
retained/paying accounts, or measured visibility-score improvement
across a client's audits over time. Given the freemium decision above,
"free-to-paid conversion rate" is a strong implicit candidate worth
raising again once there's enough usage to make any North Star
meaningful rather than symbolic.

## 9. Launching

### Stakeholders & communication
Solo/small-team project today (Pamela as PM; this session's four-seat
process as the standing engineering/product function). No other
stakeholders identified in the repo.

### Roll-out strategy
**Decided (2026-09-13, owner): let the standing team (PM Twin / CTO / UX
Lead / EVAL PM) prioritize the backlog and keep shipping rounds** rather
than sequencing every round through the owner first. Given the freemium
model above, the team's priority order for what's buildable *without new
infra or credentials from the owner* (persistence needs a datastore
decision; more engines need paid API keys; auth needs Google Cloud
credentials — all still open per `TECH_DEBT.md` §1.1/§1.4/§1.5):

1. Make the existing free tier's UI stop implying functionality that
   doesn't exist yet (the Monitoring Settings honesty fast-follow
   already logged in §2.1a) — small, immediate trust fix.
2. Evidence viewer (§3.5) — the data (verbatim answers, searches run,
   citations) is already captured; this is a presentation feature that
   makes the free tier's single audit more convincing on its own,
   which matters more, not less, under a freemium model.
3. Source-gap → outreach worklist (§3.3) — turns existing Citation
   Source Map data into the "highest-margin consulting output" already
   identified, without needing a second engine or persistence.

Engine/persistence/auth work stays queued and explicitly logged as
owner-blocked (`TECH_DEBT.md` §1.1, §1.4, §1.5) — the team will flag
when a round is ready to start on one of those rather than silently
attempting them without the credentials/decisions they need.

---

## Resolved / open

Answered by the owner 2026-09-13 (via `AskUserQuestion`): ICP (deferred
on purpose), business model (freemium → paid monitoring), North Star
(deferred on purpose), and next-priority process (team decides,
autonomous rounds) — all folded into the sections above. Still genuinely
open: competitor/market analysis (§2), which needs a real market scan,
not a memory-based guess (see §2's own note on why that's not filled in
here).
