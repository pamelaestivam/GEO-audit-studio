# GEO Audit Studio — working notes

## Start here (added 2026-10-10)

Before anything else read, in this order: `docs/OWNER_DIRECTIVES.md` (the owner's
standing instructions: **$0 spend, must not fail silently, automatic deployment,
keep records**), `docs/PROGRAM.md` (what is done, next, blocked, and the steps only
the owner can do), the newest entry in `docs/DECISIONS.md`, and
`docs/RELIABILITY.md` (the design for "failure is always visible"). Write what you
learn into `docs/SESSION_LOG.md` and `docs/INSIGHTS.md` before the session ends. When
you must hand the owner a task, first try to do it yourself; if you cannot, say why
and give numbered steps (`docs/OWNER_DIRECTIVES.md` D-8).

## Session hygiene (adopted 2026-10-10 from the owner's confidenceHigh repo; hard rules)

These are the rules that repo's owner set after sessions left work unmerged and
unreported. They apply here with the same force.

1. **Say the branch status at the end of EVERY reply that touches the repo, as one
   line, written LAST.** Run `bash scripts/branch-status.sh` in that same turn and
   copy its first line; add any open PR or red CI it cannot see. Shape:
   `Branch: <name> | N commit(s) ahead of main, pushed | MERGED (merge commit <sha> is on main)`
   or `Branch: <name> | ... | NOT merged (<what blocks it>)`. Never from memory of the plan.
2. **Merge at the end of every round that contained development.** A round ends with
   the change on `main` (a real GitHub pull request, merged as a merge commit), not
   parked on a branch. The gates make that safe, they are not optional: green CI, a
   fresh-context adversarial review, an EVAL PM SHIP. A red gate, a review finding that
   could not be fixed in the round, or an explicit owner instruction to hold the merge are
   the only legitimate reasons a round ends unmerged; then say which and what closes it.
   Being late or the change being "mostly docs" is not a reason.
3. **No stale branches.** One short-lived branch per change, merged the same round.
   `scripts/branch-status.sh` lists merged remote branches that were never deleted (it
   recognises merge-commit merges only; `test/branchStatus.test.sh` proves each state).
   The session cannot delete them (the git proxy answers HTTP 403, and there is no
   GitHub tool for it), so the repository setting "Automatically delete head
   branches" must be on (`docs/PROGRAM.md` O-5); until it is, the script's `Stale:`
   line is reported to the owner every time it is non-empty.
4. **A work ledger so a dead session loses nothing.** Write what was tried and what
   failed when it fails, not when the session ends. `docs/PROGRAM.md` (state and the
   next action, executable by someone with no memory), `docs/SESSION_LOG.md`
   (append-only), `docs/INSIGHTS.md` (what was learned, with how sure we are). A row is
   closed only against evidence (a test, a run, a commit).
5. **A review or agent run that was cut short is restarted, never resumed as final.**
   A review that stopped halfway looks identical to one that found little. If a limit,
   cap or interruption ended it, the next session reruns it from the start and keeps
   whatever partial output exists only as an input.
6. **Continuity.** A scheduled routine was created on 2026-10-10 (id in
   `docs/SESSION_LOG.md`; check it still exists with `list_triggers` before relying on it) to
   wake the session hourly with instructions to pick up `docs/PROGRAM.md`. It must do real work only
   when there is some, and must never take outward actions that need the owner. Stop
   it with `delete_trigger` once the program is complete or the owner asks.
7. **Never fabricate an argument to a tool.** A merge guarded by an expected commit hash
   takes the real hash from `git rev-parse` or the CI run, not a guess (a guessed hash was
   refused on 2026-10-10; the guard did its job).
8. **Stage explicit paths. Never `git add -A` or `git commit -a`.** A helper symlink in a
   worktree (`node_modules` pointing at another checkout) was committed to `main` that way
   (PR #29 removed it; CI now fails if any tracked file is a symlink).
9. **Agents that review or experiment never touch the shared repository.** Worktrees share
   one config and one set of refs, so a "scratch worktree" is not isolation: a review agent
   once set `origin` to a dummy URL and committed to local `main`. Brief them to work only
   in a `git init` inside `mktemp -d`. After any agent run, check
   `git remote get-url origin` (it must be the github.com URL) and `git log origin/main..main`
   (it must be empty).
10. **If the harness blocks a git operation, stop and report; do not look for a variation.**
    Changing a remote URL, moving a branch ref and cloning from a GitHub URL were each
    refused on 2026-10-10. The GitHub tools (create_branch, create_or_update_file,
    push_files, delete_file) remain a sanctioned route for small files; for anything else
    ask the owner to authorise the exact commands, as happened the same day and worked
    at once (`docs/INSIGHTS.md` I-14).

11. **Asking the owner: plain words and a recommendation, always** (`docs/OWNER_DIRECTIVES.md` D-10). Say what it is and why it
    matters in everyday words (no file names, ticket numbers or jargon; explain a term once if you must use it), what happens if they
    do nothing, numbered steps if there is something to do, and end with "I recommend ...". Try to do it yourself first (D-8).
12. **The model is Sonnet, for the session and for every agent** (`docs/OWNER_DIRECTIVES.md` D-11). Agent files pin `model: sonnet`;
    never pass another `model` when starting an agent unless the owner said so in the conversation. `test/reviewAgents.test.sh` checks
    the three agent files.

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
  what changed), merged as a merge commit (see Session hygiene) after `npm test` is green and the diff has
  been read adversarially. `TECH_DEBT.md` gets a matching entry for anything
  left imperfect, written so a cold read explains why it's still open.
- **User input is sacred; never invent what a lookup can't supply.** This
  surfaced repeatedly in different forms — detected data overwriting typed
  data, placeholder text presented as if it were real, invented search
  volumes, a fabricated competitor. The standing rule below ("user input is
  never overwritten... no field filled with a guess") is not decorative; it
  has been the direct cause of a shipped bug more than once.

## Merge discipline (standing instruction)

**Review, then merge. Finishing a fix means it is on `main`.** The owner tests
every change on the live site, and the live site is built from `main` — so a
fix left sitting on a feature branch is a fix the owner cannot see, try, or
sign off. Do not stop at "pushed the branch" and hand the merge back as a
decision for them; that has happened and it blocked a round of testing for no
reason. **No standing branches between rounds** — every change ships as a PR
from a short-lived branch and merges the same round it was opened, per
`docs/ENGINEERING_STANDARDS.md` §3/§7. Only hold the merge if the owner has
explicitly said to, or if review found something that could not be fixed in
the round — and say so plainly in that case rather than going quiet.

**Every PR needs an EVAL PM score before it merges**, not just a read-through.
`docs/EVAL_PM.md` defines the rubric (Groundedness / Completeness / Relevance
→ SHIP / REVISE / REJECT); only SHIP merges. This is what makes "adversarial
review happened" a checkable claim instead of an assertion.

**Always run an extensive, adversarial review of a change before merging it to
`main`.** `main` auto-deploys to Vercel (see `TECH_DEBT.md` §1.4) and is what
clients see, so a merge is a release — which is the reason the review is
mandatory, not a reason to skip the merge.

**CI must be green before any merge** (`.github/workflows/ci.yml`, the one check
named `test`: tracked-symlink guard, audit, lint, `npm test`, and the
production-install check, which also boots the built server, restarts it on the same
data directory, and proves the data file kept the state, the restarted server writes to
the same file, and a backup holds the state). The Docker image build is a separate,
non-gating workflow (`docker.yml`, runs when image files change and weekly) and
`live-check.yml` tests the deployed site daily and when Vercel reports a successful
production deployment,
opening one tracking issue when it fails. Read their results; a red one is a
finding to act on, not something to merge past silently. A fresh-context **adversarial review**
(`.claude/agents/`, `docs/ENGINEERING_STANDARDS.md` §10) must also have been run
on the diff. Do not merge on a self-review alone.

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

## Product team & process

Product direction decisions (not routine bug fixes) run through four
standing seats — PM Twin, CTO, UX Lead, and EVAL PM (`docs/EVAL_PM.md`,
the merge gate that scores rather than builds) — defined in
`docs/TEAM_CHARTER.md`, using the solo → position → debate → decision
protocol described there. Decisions land in `docs/DECISIONS.md`. Product
requirements, including what's genuinely known versus still open (never
fabricated to fill a gap), live in `docs/PRD.md` — read it before
prioritizing the backlog in `TECH_DEBT.md` §3.
The latest adversarial audit, its 20-item roadmap and the decisions awaiting
the owner are in `docs/MVP_AUDIT.md` - read it before choosing what to build.
How to deploy and operate it is `docs/DEPLOYMENT.md`; how to use it is
`docs/USER_GUIDE.md`. Standing review agents live in `.claude/agents/`
(`adversarial-reviewer`, `eval-pm`, `ux-tourist`) and the session workflow that
uses them is `docs/ENGINEERING_STANDARDS.md` §10 - follow it.
Engineering process (design notes, review bar, testing pyramid, release
gates) is in `docs/ENGINEERING_STANDARDS.md` — it makes this file's
"working dynamic" section repeatable as a checklist rather than tribal
knowledge. Read both before a session that touches roadmap or
architecture, not just code.

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
model. **ChatGPT, Perplexity and Claude are paid, and the owner's directive is $0:
they are queried only when `ALLOW_PAID_ENGINES=1` is also set** (a key alone is
ignored and the status says so). `GEMINI_DAILY_CALL_CAP` optionally caps Gemini
calls per UTC day, counted per server process; the real $0 control is a Google
project with no billing account (`src/spendGuard.ts`).

| Engine | Env var | Notes |
|---|---|---|
| Gemini | `GEMINI_API_KEY` | Google Search grounding; an answer with no search behind it is not counted (`errorKind: 'not_searched'`, `metricVersion` 3). A free key may have no search on newer models (`TECH_DEBT.md` 2.19); readiness line `gemini search` asks |
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
- **A refused search is not a used-up quota, and an unsearched answer is not a measurement (`TECH_DEBT.md` 2.19, narrowed).** The
  readiness check has a second Gemini call, `gemini search`, that asks what an audit asks (the search tool and the audit's own
  instruction); it is made OUTSIDE `generateContentWithRetry`, so it is paced, counted and capped like any call but can never trip the
  breaker. A readiness run therefore makes two real Gemini calls. A failed audit that ran into the quota or rate limit carries
  `degradedHint` (never for the operator's own cap). The audit's quota sentence itself is unchanged.
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
- `npm test` — `node scripts/run-tests.mjs`: one build, then every test file in `test/manifest.json` (unit files in parallel, server files two at a time,
  browser and PostgreSQL files one at a time), a timing table at the end, exit 1 if any file failed
- `npm run verify` — lint, `npm test`, and the production audit
- `node scripts/run-tests.mjs --tier unit` (or `server`, `browser`, `postgres`, comma-separated) — one tier; `--changed [base]` — only tests that touch
  what the diff touches (a quick check; CI runs everything); `--list` — show the selection; `--no-build`; `test/x.test.ts ...` — exactly those files
- `export TEST_DATABASE_URL=$(bash scripts/pg-test-cluster.sh start)` — a throwaway local PostgreSQL for the `postgres` tier (without it those files print
  `SKIP ... NOT RUN`; CI sets `REQUIRE_POSTGRES=1`)
- `node scripts/smoke.mjs <url>` — post-deploy check of a RUNNING instance; `bash scripts/prod-install-check.sh` — the built server from a clean
  production-dependencies-only install

The test files, generated from `test/manifest.json` (`node scripts/gen-test-list.mjs`; a test fails if this block is out of date; the long description of each
test is in `docs/TEST_GUIDE.md`):

<!-- tests:start -->
- `test/testHarness.test.ts` (unit) — A guard on the tests themselves.
- `test/testIsolation.test.ts` (server, needs dist/) — A guard on the tests themselves
- `test/ports.test.ts` (unit) — Guards the ports the end-to-end suites use (see test/ports.ts for why)
- `test/analysis.test.ts` (unit) — Deterministic checks for the analysis layer.
- `test/reportView.test.ts` (unit) — Pure checks for how headline numbers are presented.
- `test/statusView.test.ts` (unit) — What the server's own status becomes on screen.
- `test/reportGuard.test.ts` (unit) — The machine checks on a finished report (src/reportGuard.ts)
- `test/spendGuard.test.ts` (unit) — The $0 guard (src/spendGuard.ts)
- `test/rateLimit.test.ts` (unit) — Pure unit checks for the per-IP request limiter.
- `test/auth.test.ts` (unit) — Pure checks for sign-in and sessions.
- `test/googleAuth.test.ts` (unit) — Pure checks for Sign in with Google (src/googleAuth.ts)
- `test/store.test.ts` (postgres, needs dist/) — Contract checks for the durable store.
- `test/postgresConfig.test.ts` (unit) — Pure checks for reading DATABASE_URL
- `test/queries.test.ts` (unit) — The standard queries are the literal questions asked of the answer engines.
- `test/providers.test.ts` (unit) — The ChatGPT / Perplexity / Claude adapters, against response bodies shaped as each vendor's published API documents them (fetch is stubbed
- `test/engineProbe.test.ts` (server, needs dist/) — The engine probe (scripts/engine-probe.mjs, docs/PLAN_2026-11.md P1), run as a real child process against local fakes of the three providers.
- `test/backup.test.ts` (server, needs dist/) — scripts/backup.mjs makes a restorable copy of a database that a server still has open in WAL mode - and a plain file copy of the same database does not.
- `test/apiClient.test.ts` (unit) — Checks for the network-resilience wrapper (`src/apiClient.ts`).
- `test/auditClient.test.ts` (unit) — The page's side of running an audit (`src/auditClient.ts`), against a fake global `fetch`
- `test/idempotency.test.ts` (unit) — Checks for the retry-safety store (`src/idempotency.ts`).
- `test/quotaBreaker.test.ts` (unit) — Checks for the quota circuit breaker (src/quotaBreaker.ts) and the cooldown math behind it (src/errors.ts).
- `test/quotaBreakerE2E.test.ts` (server, needs dist/) — End-to-end proof that the circuit breaker stops the amplification that caused repeated "quota exhausted" failures to keep recurring.
- `test/quotaEfficiencyE2E.test.ts` (server, needs dist/) — Proves the actual call budget of a real audit against a *succeeding* fake Gemini endpoint - not the always-429 fake server used by quotaBreakerE2E.test.ts.
- `test/searchedAnswer.test.ts` (unit) — The searched-or-not rule (src/searchedAnswer.ts) and the sentences that go with it (src/errors.ts).
- `test/unsearchedE2E.test.ts` (server, needs dist/) — End to end, on the real built server and a fake Gemini that counts hits (docs/PLAN_2026-11.md P2)
- `test/reportCompare.test.ts` (unit) — compareReports (src/reportCompare.ts, docs/PLAN_2026-11.md P3), pure
- `test/rerunE2E.test.ts` (server, needs dist/) — Run an audit again, end to end, on the real built server and a fake Gemini that counts hits (docs/PLAN_2026-11.md P3)
- `test/retrySpendE2E.test.ts` (server, needs dist/) — End-to-end proof that a retried request costs what one request costs, and that a transient per-minute rate limit no longer destroys an audit.
- `test/mvpHardeningE2E.test.ts` (server, needs dist/) — End-to-end proof, against the real built server (dist/server.cjs) and a fake Gemini endpoint, of the MVP-hardening fixes.
- `test/diagnostics.test.ts` (server, needs dist/) — The failure diagnostics themselves are tested, because a diagnostic nobody checks can quietly stop working just when it is needed (TECH_DEBT 2.14)
- `test/narrativeAttributionE2E.test.ts` (server, needs dist/) — End to end, against the real built server and a fake Gemini
- `test/reportGuardE2E.test.ts` (server, needs dist/) — End to end, against the real built server and a fake Gemini
- `test/auditGoldenE2E.test.ts` (server, needs dist/) — A golden-report test for the audit pipeline, at the boundary
- `test/auditSteps.test.ts` (unit) — Pure checks for the step helpers (`src/auditSteps.ts`)
- `test/recentTrouble.test.ts` (unit) — Pure checks for the "recent trouble" sentence and verdict the deep readiness check reports (`src/recentTrouble.ts`)
- `test/readinessLine.test.ts` (unit) — How the smoke script reads each entry of the deep readiness answer (scripts/readinessLine.mjs)
- `test/citedOnlyUi.test.ts` (unit) — The executive summary card, rendered to markup
- `test/auditStepsE2E.test.ts` (server, needs dist/) — End to end, against the real built server, a fake Gemini that counts real HTTP hits, and the real SQLite file
- `test/auditClientDriverE2E.test.ts` (server, needs dist/) — End to end, against the real built server and a fake Gemini that counts real HTTP hits
- `test/auditResumeE2E.test.ts` (server, needs dist/) — End to end: an audit that was running when the server died is RESUMED on a durable store, from the step it was on, and every repeated paid call is counted and recorded (docs/PLAN_STEP_E.md, slice S5).
- `test/postgresE2E.test.ts` (postgres, needs dist/) — End to end: the real built server on a real PostgreSQL database, the way two Vercel instances would share one.
- `test/spendGuardE2E.test.ts` (server, needs dist/) — End to end, against the real built server and a fake Gemini
- `test/foundationE2E.test.ts` (server, needs dist/) — End-to-end proof of the foundation
- `test/googleAuthE2E.test.ts` (server, needs dist/) — End to end: Sign in with Google against the real built server, with a fake Google (a local keys server and tokens signed with its key).
- `test/uiSmoke.test.ts` (browser, needs dist/) — Drives the real built app in a real browser (Chromium via Playwright) against the real built server and a fake Gemini at the far end - the way a person uses it.
- `test/rerunUi.test.ts` (browser, needs dist/) — "Run again" and "Since the previous run" in a real browser, desktop and phone, on the real built server with a fake Gemini that changes its answer between the two runs (docs/PLAN_2026-11.md P3).
- `test/googleLoginUi.test.ts` (browser, needs dist/) — The login page with Google, in a real browser (Chromium via Playwright) against the real built server.
- `test/lookupAndBlankDomainE2E.test.ts` (browser, needs dist/) — In the real browser against the real server
- `test/discardedClaimsUi.test.ts` (browser, needs dist/) — In a real browser: when the analysis reports inaccuracy claims that cannot be tied to a captured answer, the Inaccuracies tab must not show the green "No inaccuracies flagged" panel as if nothing had...
- `test/vercelEsmImports.test.ts` (server, needs dist/) — Regression test for the actual production bug this proves it would have caught
- `test/vercelServerless.test.ts` (server, needs dist/) — Proof that the Vercel serverless entry point (api/index.ts) actually answers requests, and that the ordinary Render/local path is unchanged.
- `test/liveCommit.test.ts` (server, needs dist/) — "Which commit is live?" (item G1.7 of docs/ENGINEERING_BACKLOG.md)
- `test/modelCalendar.test.ts` (unit) — The model calendar (item G1.9 of docs/ENGINEERING_BACKLOG.md)
- `test/contract.test.ts` (server, needs dist/) — Contract tests: boot the real built server and assert the guarantees the product makes to a user.
- `test/branchStatus.test.sh` (unit) — Exercises scripts/branch-status.sh in a THROWAWAY repository (a bare "origin" and...
- `test/shipSkill.test.sh` (unit) — The ship skill (.claude/skills/ship/SKILL.md) is only useful if it stays true
- `test/reviewAgents.test.sh` (unit) — The owner's rule (docs/OWNER_DIRECTIVES.md D-11)
- `test/dependencyLayout.test.sh` (unit, needs dist/) — Guards two facts of the dependency layout (item G1.8 of docs/ENGINEERING_BACKLOG.md)
- `test/manifest.test.ts` (unit) — The manifest lists every test file; the runner (real child processes against fake tests): failures, early-exit FAIL lines, skips, tiers, --changed; CLAUDE.md list is up to date.
- `test/claudeHooks.test.sh` (unit) — Proves the session hooks in .claude/: the guard against git add -A, the stop hook, the session-start hook, the allow-list.
- `test/ciWorkflow.test.ts` (unit) — CI in parallel under the same required name: the gate job `test` needs every job and runs always; every tier and both server shards are run; limits, pins and setup.
<!-- tests:end -->

The E2E suites use `GEMINI_BASE_URL` (read in `getGeminiClient` in
`server.ts`) to redirect the SDK at a local fake server — a no-op unless
explicitly set, safe to leave alone in every real deployment.
