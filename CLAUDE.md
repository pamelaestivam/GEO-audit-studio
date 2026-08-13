# GEO Audit Studio — working notes

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

## Commands

- `npm run dev` — Vite + Express, port 3000 (`PORT` respected)
- `npm run build` — client bundle + `dist/server.cjs`
- `npm start` — run the built server
- `npm run lint` — `tsc --noEmit`
- `npm test` — build, analysis checks, then server contract checks
- `npx tsx test/analysis.test.ts` — deterministic analysis checks only
- `npx tsx test/contract.test.ts` — contract checks (needs a current `dist/`)
