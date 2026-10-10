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
- `npx tsx test/vercelServerless.test.ts` — proves `api/[...path].ts` (the
  Vercel entry point) actually answers `/api/*` on a real socket, and that
  it does not fall back to serving the frontend for a non-API path; also
  proves the Render/local long-running path is unchanged (needs a current
  `dist/`)
- `npx tsx test/mvpHardeningE2E.test.ts` — spawns the real built server against
  a fake Gemini endpoint with switchable failure modes; proves vendor discovery
  precision end to end, that a failed analysis step is "not assessed" (not 100%
  accurate), that a failed audit carries no fabricated findings, and the rate
  limit / concurrency cap / JSON error behaviour (needs a current `dist/`)
- `npx tsx test/reportView.test.ts`, `npx tsx test/rateLimit.test.ts`,
  `npx tsx test/auth.test.ts`, `npx tsx test/store.test.ts`,
  `npx tsx test/queries.test.ts` — pure unit checks (presentation of headline
  numbers, the limiter, sign-in and sessions, the SQLite/memory store contract,
  the standard queries)
- `npx tsx test/foundationE2E.test.ts` — the real built server: sign-in enforced
  on every spending route, ownership, restart survival (incl. SIGKILL
  mid-audit), budgets, readiness, X-Forwarded-For handling, unconfigured
  production (needs a current `dist/`)
- `npx tsx test/uiSmoke.test.ts` — the real built app in Chromium (desktop and
  phone): sign-in, an audit, every module, reload, delete, failure states
  (needs a current `dist/` and `npx playwright install chromium`)
- `node scripts/smoke.mjs <url>` — post-deploy check of a RUNNING instance;
  `bash scripts/prod-install-check.sh` — the built server from a clean
  production-dependencies-only install
- `npx tsx test/contract.test.ts` — full server contract checks (needs a
  current `dist/`)
- `bash test/branchStatus.test.sh` — the branch-status script against a throwaway
  repository (part of `npm test`)

The E2E suites use `GEMINI_BASE_URL` (read in `getGeminiClient` in
`server.ts`) to redirect the SDK at a local fake server — a no-op unless
explicitly set, safe to leave alone in every real deployment.
