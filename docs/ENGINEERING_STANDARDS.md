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

Added after the 2026-10 audit, each from a defect that shipped past a green build:

- [ ] **Read the literal output with real inputs, including the empty default.**
      The default audit asked the engines "Best software alternatives to  for
      modern teams" (an empty array interpolated, a category invented) and no
      test noticed, because no test read the sentence. Print it. Look at it.
- [ ] **Is it true of this deployment?** Labels and copy that name engines,
      storage, monitoring or security ("Active", "encrypted sessions", "saved")
      must be derived from real state - or removed.
- [ ] **What is public?** List every route and file reachable without a session.
      `GET /server.cjs` returned the compiled backend for months on every
      non-Vercel host. `scripts/smoke.mjs` checks this; run it.
- [ ] **Per-X means per-X.** A "per brand" / "per user" / "per query" value
      computed once and copied to every X is fabricated for all but one of them.
- [ ] **Would the test fail if the code were wrong?** Break the code on purpose
      and watch the test go red. An assertion like `assert(name, true)` after a
      wait, or `check(x, x)`, cannot fail and does not count. If a test passes the
      first time it ran, be suspicious of the test before you celebrate.
- [ ] **Look at the screen.** Open it in a browser at desktop *and* phone width and
      read it as a person would. Half the defects fixed in the 2026-10 round were
      visible at a glance and invisible to every assertion.
- [ ] **A destructive helper does what its name says to everything.** A cleanup
      written as `prune(now + 1000)` deletes the whole table. Read cleanup code as
      if it were the attack.

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

- **UI** — `test/uiSmoke.test.ts` drives the real built app in Chromium
  (desktop and phone) against the real server and a fake engine: sign-in,
  an audit, every module, reload persistence, delete, failure states. Added
  because every UI defect before it was found by eye.
- **Foundation E2E** — `test/foundationE2E.test.ts`: sign-in enforced on every
  spending route, ownership between users, restart survival (including SIGKILL
  mid-audit), budgets, unconfigured-production behaviour.
- **Post-deploy smoke** — `scripts/smoke.mjs <url>` runs against a DEPLOYED
  instance (and CI runs it against the built container). It is the only layer
  that sees what the platform does between the user and the code.

A passing test proves nothing until it has been seen to fail. Break the code on
purpose and confirm the red (§5).

New capability, new call site touching an answer engine, or new
persisted state → it needs a home in one of these layers before
merge, not "we'll add a test later."

## 7. Release process

- **CI is the gate** (`.github/workflows/ci.yml`): lint, `npm audit` (high+),
  `npm test` including the browser tests, and a job that builds the Docker
  image and smoke-tests the running container. A PR does not merge on red.
  *Owner action not doable from a repo:* turn on branch protection for `main`
  requiring the `test` and `docker` checks, so this is enforced by GitHub rather
  than by habit.
- **Fill in the PR template** (`.github/pull_request_template.md`) - it asks for
  what was *not* verified, which is the section that matters.

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
`req.body`/`req.query` into a code path that calls an external API or the
datastore, secrets/env handling, or CORS. Sign-in is now real (`src/auth.ts`:
access code, signed expiring sessions, enforced server-side) but it is still the
single most security-sensitive file: any change to it needs a new test that fails
without the change, and a check that **production still refuses to run
unconfigured instead of falling open**.

## 9. Decision log

Every non-trivial product or architecture decision (this document's own
adoption included) gets one entry in `docs/DECISIONS.md`: date, decision,
who weighed in, and the one alternative that was seriously considered and
rejected, with why. This is what makes "why does the code do it this way"
answerable six months later without reconstructing the conversation.

## 10. Working with agents (Claude sessions and the standing seats)

The product is built by Claude sessions working for the owner. The same rules
apply to every session; they are written down so the next one does not have to
rediscover them.

**Start of a session.** Read `CLAUDE.md`, `TECH_DEBT.md` (open owner actions),
`docs/MVP_AUDIT.md` (current roadmap and decisions waiting on the owner), and
`git log` for what just changed. Run `git status` and `npm test` *before*
touching anything, so you know whether a failure is yours.

**The loop for every change.**
1. Reproduce the problem against the real thing (built server, real browser) and
   record what you saw. If you cannot reproduce it, you do not yet understand it.
2. Fix the root cause. Ask "does this need to exist at all" before "how do I make
   it fail softly".
3. Prove it: a test that fails on the old code and passes on the new, plus the
   whole suite. Then break it on purpose and watch the test go red.
4. **Look at it** - desktop and phone - if a person will see it.
5. **Independent adversarial review**: delegate to the `adversarial-reviewer`
   agent (`.claude/agents/`), which has a fresh context and the brief to break
   the change. Fix every CONFIRMED finding; say why for any you reject. The
   author's own pass (§5) comes first and does not replace this.
6. **EVAL PM** (`eval-pm` agent) scores it. Only SHIP merges.
7. PR using the template, CI green, merge, delete the branch, confirm `main`.
8. Update `TECH_DEBT.md` / `docs/DECISIONS.md` / docs in the same change.

**The `ux-tourist` agent** drives the built app in a browser and reports what
looks untrue, inert or malformed. Use it after any UI-visible change; it found
defects in the 2026-10 round that no assertion could have.

**Truth in reporting.** These are non-negotiable and apply to chat replies as
much as to the UI:
- Say what you *ran* and what it *printed*. "Should work" is not a result.
- Say what you did **not** verify, and why (no API key, no deploy access, a
  network policy). A tryout against a fake must be called a tryout against a fake.
- Never present a fake, a fixture, a placeholder or a guess as a measurement.
- A green suite is not a review, and a suite that has never failed is not yet
  evidence.
- If the owner's instruction cannot be followed as stated (a blocked network, a
  disallowed shortcut), say so plainly and do the honest alternative - do not
  quietly substitute.

**Sandbox hygiene (learned the hard way).**
- Never `pkill -f <pattern>` / `pgrep -f <pattern> | xargs kill` from a shell
  whose own command line contains the pattern: it kills itself. Record the PID
  (`cmd & echo $!`) and kill that.
- Start servers on random ports and always kill them in a `finally`.
- Recursive `mkdir` under `/proc` hangs in this environment; test an unwritable
  path with a directory under a regular file instead.
- The environment's network policy may block hosts (it blocks `google.com`).
  Do not try to route around it; report it and work with what is reachable.

**Permissions and shared state.** Do not push to `main` directly, force-push
shared branches, skip hooks, rotate secrets, or change repository/hosting
settings; those are the owner's. Do not post to GitHub more than a change needs.
Merge only what the standing instruction in `CLAUDE.md` allows (reviewed, scored
SHIP, CI green), and leave nothing stale: merged branches are deleted, open
questions are in `TECH_DEBT.md`.
