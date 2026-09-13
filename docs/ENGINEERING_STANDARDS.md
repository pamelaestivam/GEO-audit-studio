# Engineering standards and process

Adapted from practices used at Google, Amazon, Stripe, and GitHub, scaled
down to a project of this size. The point of naming sources is not
cargo-culting their process wholesale — it's borrowing the specific
mechanism that solves a specific failure mode, and dropping the rest.
This document is the *how*; `CLAUDE.md`'s working-dynamic section is the
*why* it exists here. Where they overlap, `CLAUDE.md` wins — it's the
one with the scar tissue from this actual codebase.

## 1. Before writing code: a one-page design note (Google/Amazon RFC, scaled down)

Any change that touches more than one file, changes a public contract
(API shape, DB schema, auth model), or costs real money (a new paid API,
infra) gets a short written note before code, covering:

- **Problem** — one paragraph, in terms of user/business impact, not
  implementation.
- **Options considered** — including "do nothing." Two is a false choice;
  three forces an actual comparison.
- **Chosen approach and why**, including the failure modes it does *not*
  handle (an explicit non-goal is worth more than an implicit one).
- **Blast radius** — what breaks if this is wrong, and how we'd know.

This is not Amazon's six-page narrative — it's the smallest artifact that
forces the "why does this call/step need to exist" question from
`CLAUDE.md` to happen before the diff, not during review. A one-line
bug fix doesn't need one. A new persisted data model, a new auth
mechanism, or a new paid engine integration does.

## 2. Small, focused changes (Google/Stripe)

- One logical change per branch and per commit sequence. A fix doesn't
  carry an unrelated refactor.
- Commit messages explain the root cause, not the diff — "the retry
  wrapper was re-submitting accepted work" beats "fix retry bug."
- A change that can't be described in one sentence is two changes.

## 3. Definition of done

A change is done when, and only when:

1. It builds (`npm run build`) and typechecks (`npm run lint`) clean.
2. `npm test` is green — deterministic analysis, then the real built
   server under real HTTP requests, per `CLAUDE.md`'s "prove it, don't
   assert it."
3. It has been read **adversarially by the same session that wrote it**,
   against the checklist in §5, before anyone else looks at it.
4. It has a PR open against `main`, and **EVAL PM** (`docs/EVAL_PM.md`)
   has scored it SHIP - not "should pass," an actual scored pass.
5. Any known imperfection is written into `TECH_DEBT.md`, not left
   implicit.
6. **It is merged to `main` in the same round it was built.** Standing
   rule, no exceptions without the owner saying so explicitly: every
   change ships as a PR from a short-lived branch, gets its EVAL PM
   score, and merges immediately on SHIP. A REVISE/REJECT verdict is
   fixed and re-scored in that same round, not left for later. A branch
   that outlives the round it was opened in is a defect in the process,
   not a normal state - "pushed the branch" is not a finished fix, and
   neither is "opened the PR."

Mirrors GitHub/Stripe's "green CI is necessary, not sufficient" —
tests catch regressions in what we thought to test; adversarial review
catches the thing we didn't think to test; EVAL PM's score is what makes
"adversarial review happened" checkable instead of asserted.

## 4. Code review bar

Every review — human or the mandatory self-review — asks, in order:

1. **Correctness first.** Does it do the thing, on the actual inputs it
   will see (empty, unicode, concurrent, adversarial), not just the
   happy path demoed once.
2. **Honesty of output.** Anything shown to a user as measured must have
   actually been measured this run (`CLAUDE.md` §"Anything presented to
   a client as measured"). A hardcoded fallback that looks like data is
   a correctness bug, not a style nit.
3. **Necessity.** Could this call, branch, or abstraction not exist at
   all? (`CLAUDE.md`'s "question why a call/step exists" — the most
   valuable review finding in this repo's history was a deletion, not a
   fix.)
4. **Simplicity.** Given it should exist, is this the smallest version
   of it.
5. **Style**, last, because it's cheapest to fix and least likely to
   hide a real bug.

A review that only reaches #5 hasn't reviewed anything.

## 5. Adversarial self-review checklist (mandatory, every merge)

Run this against the diff before it merges, unprompted — this is
`CLAUDE.md`'s standing instruction, made concrete as a checklist so it's
repeatable instead of vibes-based:

- [ ] Dead or contradictory branches (a condition excluded then silently
      re-included; an `if` whose `else` can never run).
- [ ] A value that looks computed but is actually still a hardcoded
      placeholder.
- [ ] Edges no one asked about: empty input, unicode, punctuation in
      names, one item, zero items, concurrent requests.
- [ ] Denominators — does a failed/skipped unit silently count as a
      negative finding?
- [ ] Every user-visible error is a sentence with a next step, never a
      raw provider payload.
- [ ] User input is never overwritten by a detected or generated value.
- [ ] Anything that looks tappable is tappable, and its result lands in
      view on a phone screen.
- [ ] The failure path is visually distinguishable from a real zero.

## 6. Testing pyramid (Google/industry-standard shape, applied here)

- **Unit** — pure functions in `src/analysis.ts`, `src/errors.ts`,
  `src/quotaBreaker.ts`, `src/idempotency.ts`. Fast, no network, one
  behavior per test.
- **Integration/E2E against the real binary** — `test/*E2E.test.ts` spawn
  `dist/server.cjs` against a fake upstream that counts real HTTP hits.
  This is the layer that has actually caught every quota/retry regression
  in this repo; a mock of our own code checking itself would not have.
- **Contract** — `test/contract.test.ts` encodes the product's promises
  to the user (never invent facts, never overwrite input, never leak raw
  JSON) as executable checks, so a violation is a test failure, not a
  bug report from a client.

New capability, new call site touching an answer engine, or new
persisted state → it needs a home in one of these three layers before
merge, not "we'll add a test later."

## 7. Release process

- `main` auto-deploys (Vercel — see `TECH_DEBT.md` §1.4) — a merge to
  `main` is a release to real users, not a checkpoint.
- No merge to `main` without: green `npm test`, adversarial review done,
  an EVAL PM SHIP verdict on the PR, and a `TECH_DEBT.md` entry for
  anything left imperfect.
- Every change goes through a PR — never a direct push to `main` — and
  that PR merges the same round it was opened. No standing branches
  between rounds.
- No skipping hooks, no `--no-verify`, no force-push over shared history.
- A red build on `main` is a stop-the-line event: the next action is
  fixing or reverting it, not building on top of it.

## 8. Security review gates

Run (or invoke the `security-review` skill) before merging any change
that touches: authentication, session handling, anything reading
`req.body`/`req.query` into a code path that calls an external API or a
future datastore, secrets/env handling, or CORS. Given `TECH_DEBT.md`
§2.2 (auth is currently a stub with plaintext-compared passwords and no
session validation), **do not treat auth as low-risk by default in this
repo** — it is the single largest known exposure until it's replaced.

## 9. Decision log

Every non-trivial product or architecture decision (this document's own
adoption included) gets one entry in `docs/DECISIONS.md`: date, decision,
who weighed in, and the one alternative that was seriously considered and
rejected, with why. This is what makes "why does the code do it this way"
answerable six months later without reconstructing the conversation.
