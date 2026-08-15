# GEO Audit Studio — working notes

## Working dynamic with the owner (read this first in a new session)

This project is built through repeated rounds of: ship something, the owner
finds it in a real browser, reports exactly what broke, and expects the next
round to fix the *root cause*, not the symptom they happened to see. Patterns
that have held across every round so far:

- **A polished failure message is not success.** Several rounds looked done
  because the error was readable and honest — and were then rejected because
  the *underlying* problem (an amplifying retry storm, calls that never
  needed to exist) was still there. Readable failure is the floor, not the
  goal. Ask "why did this fail at all" before "how do I fail nicely."
- **Prove it, don't assert it.** "Should work now" was never accepted, and
  correctly so. Every fix in this repo that mattered was verified by spawning
  the actual built server (`dist/server.cjs`) and hitting it with real HTTP
  requests — a fake upstream endpoint counting real hits, not a mock of your
  own code checking itself. `test/quotaBreakerE2E.test.ts` and
  `test/quotaEfficiencyE2E.test.ts` are the template for this: they proved a
  bug existed, then proved the fix, by counting actual network calls against
  the real binary. When a fix is check-worthy the same way, verify it the
  same way before reporting back.
- **Adversarial self-review is mandatory before every merge, unprompted.**
  Multiple real bugs in this codebase were caught only because the code was
  reviewed a second time, adversarially, by the same session that wrote it,
  before merging — not because a test happened to catch them. Recurring
  finds from that review: dead/contradictory branches (retry logic that
  excluded then silently re-included the same case), values that look
  computed but are actually still hardcoded placeholders, and edges no one
  asked about yet (empty input, unicode, punctuation in names, concurrent
  requests). Do this even when nothing prompted it.
- **Question why a call/step exists at all, not just whether it degrades
  well.** The most recent round ("I searched a single query, it should not
  get that many calls") was not solved by better retry/backoff — it was
  solved by removing calls that were never necessary (an LLM call whose
  output was being re-verified against source text anyway; an LLM call
  standing in front of a template that already existed as the fallback; a
  network call firing automatically when an explicit opt-in control already
  existed for it). When something is slow, expensive, or fragile, the first
  question is "does this need to happen at all," before "how do I make the
  failure softer."
- **Small, focused PRs, each merged after its own review.** One branch per
  fix, a specific commit message explaining the actual root cause (not just
  what changed), squash-merged after `npm test` is green and the diff has
  been read adversarially. `TECH_DEBT.md` gets a matching entry for anything
  left imperfect, written so a cold read explains why it's still open.
- **User input is sacred; never invent what a lookup can't supply.** This
  surfaced repeatedly in different forms — detected data overwriting typed
  data, placeholder text presented as if it were real, invented search
  volumes, a fabricated competitor. The standing rule below ("user input is
  never overwritten... no field filled with a guess") is not decorative; it
  has been the direct cause of a shipped bug more than once.

## Merge discipline (standing instruction)

**Always run an extensive, adversarial review of a change before merging it to
`main`.** `main` auto-deploys to Render and is what clients see, so a merge is a
release.

**`npm test` must pass before any merge.** It builds, runs the deterministic
analysis checks, then boots the real server and asserts the product's contract
with the user (`test/contract.test.ts`): that failed lookups never invent
business facts, that what the user typed is never overwritten, and that no
user-visible message contains raw provider JSON. Every check there maps to a
defect that actually shipped — treat a failure as a shipped-bug alarm, not a
flaky test.

A green build is not a review. Before merging, explicitly check:

- **Correctness of the metrics**, not just that code runs. Trace one worked
  example end to end by hand and confirm the numbers mean what the label claims.
- **Denominators.** Failed or skipped work must never silently count as a
  negative finding.
- **Divide-by-zero / empty-input paths** — no competitors, no citations, no
  evidence, one query.
- **Anything presented to a client as measured must actually be measured.**
  Never display a number or an engine we did not genuinely query.
- **Failure paths say they failed**, and are visually distinguishable from a
  real finding of zero.
- **User input is never overwritten** by detected or generated values, and no
  field is filled with a guess when a lookup fails.
- **Every user-visible error is a sentence**, not a provider payload, and says
  what to do next.
- **Anything that looks tappable is tappable**, and on a phone the result of
  tapping it is brought into view rather than left below the fold.

## Architecture

The audit pipeline is deliberately layered so metrics stay reproducible:

1. **Evidence collection** (`server.ts`) — queries answer engines, captures
   verbatim text, real source domains, timestamps. Never interprets.
2. **Deterministic analysis** (`src/analysis.ts`) — pure functions only. Every
   headline metric is computed here so two runs of the same evidence always
   agree. This file must stay free of network calls and LLM usage.
3. **Narrative interpretation** — the model receives computed metrics and
   evidence, and is asked only for qualitative judgement. It is never asked to
   produce a number, and empty arrays beat invented findings.
4. **Honest presentation** — only engines actually queried are shown.

## Engine providers

Engines are queried only when their API key is configured. A missing key means
the engine is reported as not measured — never silently simulated by another
model.

| Engine | Env var | Notes |
|---|---|---|
| Gemini | `GEMINI_API_KEY` | Google Search grounding |
| ChatGPT | `OPENAI_API_KEY` | Responses API + `web_search` tool |
| Perplexity | `PERPLEXITY_API_KEY` | `sonar` models, search is native |
| Claude | `ANTHROPIC_API_KEY` | Messages API + `web_search` server tool |

`GEMINI_MODEL`, `OPENAI_MODEL`, `PERPLEXITY_MODEL`, `ANTHROPIC_MODEL` override
model IDs without a code change.

## Known gaps

See `TECH_DEBT.md` — it tracks known debt, expansion ideas, and **open actions
awaiting the owner's decision**. Read it at the start of a session and raise the
open actions (currently: whether to pay for the ChatGPT / Perplexity / Claude
API keys, which are the only thing standing between the code and genuine
multi-engine audits).

Record anything knowingly left imperfect there rather than leaving it for the
next session to rediscover.

## Answer-engine quota — what's known, what isn't, how it's protected

**Nobody in this session (human or Claude) has visibility into the actual
account-level quota numbers.** Neither the owner's questions nor the code in
this repo can see remaining requests, the account's tier, or the exact reset
time from outside the provider's own dashboard. What we know instead comes
entirely from *behaviour*: the 429 responses Gemini has returned, decoded by
`describeProviderError` in `src/errors.ts`.

**To actually check quota, the owner needs to look at:**
- `https://aistudio.google.com/apikey` — shows the key, its project, and
  whether billing is enabled.
- `https://ai.google.dev/gemini-api/docs/rate-limits` — Google's published
  free-tier limits per model (these change over time and by model version,
  so don't hardcode a specific number here — check live).
- The Google Cloud Console, APIs & Services → Generative Language API →
  Quotas, for the account's actual current usage against its limits — this
  is the only place with real numbers, and only the account owner can open it.

**Before blaming the account's quota, check what the app is spending.** Twice
now, "we hit the wall too fast" turned out to be this codebase spending more
than one request's worth of quota per user action, not the ceiling being low
(`TECH_DEBT.md` § 2.6a, then § 2.3b). The most recent one was invisible from
the code alone and only showed up by counting real HTTP hits against the built
server: the browser's cold-start retry was re-submitting an audit the server
had already accepted, so one click cost 16 Gemini calls. Count the calls
before theorising about the quota.

**What the app itself now does about this**, so the next session doesn't
have to re-derive it:
- `GET /api/audit/status` reports whether the quota is currently known to be
  exhausted (from the circuit breaker's own memory of the last failure), a
  human-readable reason, and a reset time. This is *inferred from failures
  already seen*, not fetched from Google — it is empty/healthy after every
  server restart even if the underlying account quota is still exhausted.
- The circuit breaker (`src/quotaBreaker.ts`) trips for a computed cooldown
  on a *daily* quota error and then refuses every further Gemini call
  instantly until that cooldown elapses — see `TECH_DEBT.md` § 2.3a for the
  full history of why. A *per-minute* rate limit is no longer treated the
  same way: it is a pacing signal, so the audit waits the delay the provider
  itself stated and carries on (§ 2.3c). Daily cooldowns run to midnight
  **Pacific**, which is when Google resets them — not UTC.
- Every quota-spending POST is idempotent on a client-supplied
  `Idempotency-Key` (`src/idempotency.ts`), because the cold-start retry in
  `src/apiClient.ts` was otherwise starting a fresh audit per attempt
  (§ 2.3b). Any new endpoint that calls an answer engine needs the same
  treatment — the retry wrapper applies to every request in the app.
- Per-audit call volume is now minimal by construction (§ 2.6a in
  `TECH_DEBT.md`): a single supplied query costs exactly 2 Gemini calls, not
  6-7. This doesn't raise the quota ceiling, it just means far more real
  audits fit under whatever ceiling exists.
- The one lever actually available to raise the ceiling is enabling billing
  on the Gemini API key, or adding a second engine (Perplexity recommended —
  see `TECH_DEBT.md` § 1.1) so quota exhaustion on one engine doesn't stop
  every audit.

If a future session is asked "what's my quota" again, the honest answer is
still "check the dashboard" — this section exists so that answer doesn't
have to be rediscovered from scratch, not so it can be skipped.

## Commands

- `npm run dev` — Vite + Express, port 3000 (`PORT` respected)
- `npm run build` — client bundle + `dist/server.cjs`
- `npm start` — run the built server
- `npm run lint` — `tsc --noEmit`
- `npm test` — build, then every check below, in order
- `npx tsx test/analysis.test.ts` — deterministic analysis + vendor-extraction
  unit checks, no server involved
- `npx tsx test/apiClient.test.ts` — frontend network-retry wrapper, against a
  faked `fetch`
- `npx tsx test/quotaBreaker.test.ts` — circuit breaker + cooldown math, pure
  unit checks
- `npx tsx test/quotaBreakerE2E.test.ts` — spawns the real built server against
  a fake Gemini endpoint that always 429s; counts real HTTP hits to prove the
  breaker actually stops repeated calls (needs a current `dist/`)
- `npx tsx test/quotaEfficiencyE2E.test.ts` — spawns the real built server
  against a fake Gemini endpoint that always succeeds; counts real HTTP hits
  to prove a single-query audit costs exactly 2 calls (needs a current
  `dist/`)
- `npx tsx test/idempotency.test.ts` — retry-safety store, pure unit checks
- `npx tsx test/retrySpendE2E.test.ts` — spawns the real built server against
  a fake Gemini endpoint; proves a retried submit costs one audit's quota
  rather than four, and that a transient per-minute 429 is waited out instead
  of destroying the audit (needs a current `dist/`)
- `npx tsx test/contract.test.ts` — full server contract checks (needs a
  current `dist/`)

The E2E suites use `GEMINI_BASE_URL` (read in `getGeminiClient` in
`server.ts`) to redirect the SDK at a local fake server — a no-op unless
explicitly set, safe to leave alone in every real deployment.
