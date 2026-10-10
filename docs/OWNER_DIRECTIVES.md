# Owner directives (standing)

These are instructions the owner side gave that stay in force until the owner
changes them. They are quoted, dated and numbered so a session that never met
them can still obey them. A directive here outranks a convenience in any other
document. If one of them seems wrong, say so in chat and ask; do not quietly
route around it.

Who speaks: Ricardo (coach) gives these on behalf of the owner (Pamela) and
speaks with the same authority. Source of every quote below: the session of
2026-10-10, unless another date is shown.

## D-1. Spend is $0 for now

> "0 dollars for now."

Meaning, as the team read it (`docs/DECISIONS.md`, 2026-10-10):

- The Gemini key must come from a Google AI Studio project with **billing never
  enabled**. A project without billing answers 429 when the free limit is hit; it
  cannot charge (AGENT-level evidence from web search, to be confirmed by the
  owner in the Google console once and recorded in `docs/PROGRAM.md`).
- No ChatGPT, Perplexity or Claude key is configured. The app refuses to query a
  paid engine unless an explicit environment flag is set, and treats the presence
  of such a key as a configuration alarm.
- The app also keeps its own call counter and stops before the free limit. That
  counter is a safeguard, not the money control; the money control is the missing
  billing account.
- Any new feature that adds a recurring call (a canary, a health probe) must count
  against that same budget.

## D-2. It must not fail silently, and it should be designed not to fail

> "It must not fail silently. It must be designed so it never fails. But if it
> fails, if must be uncovered. Seriously, think strongly on how to implement a
> product in a style that does not fail. Independent on how the user uses it."

Meaning: the design target is "every audit ends in exactly one visible state:
measured, partially measured with stated reasons, or failed with a sentence".
Nothing is dropped without being counted and shown; nothing runs only after a
response is sent; state that matters is stored, not held in memory; a failure
that happens anyway is recorded and reaches the owner. The honest promise is
"failure is always visible", never "it cannot fail". The architecture is in
`docs/RELIABILITY.md`; the failure model, the invariants, and the order of work are
there.

## D-3. Deployment must be automatic and the owner must reach it directly

> "This needs to be smooth, website deployment automatically, and I access there
> directly."

> "I used Vercel and Supabase in other projects."

Meaning: merge to `main` deploys to a URL the owner opens, with no manual steps
and nothing that needs a developer's laptop. The existing Vercel project
(`geo-audit-studio`) is the vehicle; Supabase is the durable store. Anything the
assistant cannot do itself (account actions, secrets) is written as numbered
click-by-click steps in `docs/PROGRAM.md` and nothing else is blocked on it.

## D-4. State of the art

> "You must make this product state of art."

Meaning: no "good enough for a demo" shortcuts that quietly weaken D-2. When a
choice is between a quick path and a path that can be proven, take the provable
one, and say what was proven and how.

## D-5. Keep records and traces

> "Make sure you create record and traces for your insights. This is a
> development that will evolve a lot and not necessarily in this session."

Meaning, in this repo:

| What | Where |
|---|---|
| Standing instructions from the owner | this file |
| Every non-trivial decision, with dissent and rejected alternatives | `docs/DECISIONS.md` |
| What each session did, found, and left open (append-only) | `docs/SESSION_LOG.md` |
| Non-obvious things learned, with how sure we are | `docs/INSIGHTS.md` |
| What is done, in progress, blocked, and next | `docs/PROGRAM.md` |
| Known imperfections | `TECH_DEBT.md` |

A session that learns something writes it in the same session, in the file that
owns it. A fact that exists only in a chat transcript is lost.

## D-6. Decisions the owner delegated to the agents

> "Ask the agents." (on whether a cited-only answer counts as visibility, and on
> whether the written summary may quote numbers)

Those were decided by the team protocol (`docs/TEAM_CHARTER.md`) on 2026-10-10 and
logged in `docs/DECISIONS.md`. The owner can overturn them; until then they stand.

## D-7. Query count

> "At max, but consider reducing to 1 if it helps robustness."

Meaning: three questions is the ceiling. The team's decision is two by default
until audits can resume after a failure, three after that, and an explicit
one-question "quick check" mode that never shows a bare percentage.

## D-8. When the assistant tells the owner to do something

> "If you have instructions to me that, confirm you actually cannot do, if you can
> do it. If you cannot, be very clear of why and walk me through."

Meaning: before handing the owner a step, try it. If it cannot be done from the
session, say exactly what blocked it (the tool, the permission, the network rule)
and give numbered, click-by-click steps. Never present a limitation as a
preference.

## D-9. Plain language

The owner asked for explanations of terms they did not know ("what do you mean?",
"I don't fully understand"). Explain a term the first time it appears in a
message to the owner, in one sentence, without jargon.

## Earlier standing rules that still apply

`CLAUDE.md` holds the rules from earlier rounds (review then merge, EVAL PM before
merge, user input is sacred, nothing presented as measured unless measured, every
error is a sentence). They are not repeated here.
