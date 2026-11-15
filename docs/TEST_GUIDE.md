# Test guide (moved out of CLAUDE.md on 2026-11-15)

The long, hand-written description of each test that used to sit in CLAUDE.md's Commands section. The list of test files, their tiers and a one-line summary is now generated from `test/manifest.json` (`node scripts/gen-test-list.mjs`) and lives in CLAUDE.md between the `tests:start` and `tests:end` markers; this file keeps the prose that the generated lines are too short to carry. It is NOT kept in sync automatically: when a test's behaviour changes, update its paragraph here by hand.

## Commands as they stood on 2026-11-15

- `npm run dev` — Vite + Express, port 3000 (`PORT` respected)
- `npm run build` — client bundle + `dist/server.cjs`
- `npm start` — run the built server
- `npm run lint` — `tsc --noEmit`
- `npm test` — build, then every check below, in order
- `npx tsx test/auditClient.test.ts` — the page's side of an audit against a faked `fetch`: a page-driven
  audit posts to advance and never polls; a server-driven one is only polled; a lost job on a stateless
  deployment is `AuditInterrupted` with its exact sentence
- `npx tsx test/auditClientDriverE2E.test.ts` — the real built server with `AUDIT_DRIVER=client`: nothing runs
  after the 202; a replayed or abandoned submit spends nothing; advancing to the end makes exactly the planned
  calls; two simultaneous advances give one `advanced` and one `busy` and one real call; a job on another
  instance of a stateless deployment is a typed 404; advances are not counted by the per-minute limiter; an
  undriven audit stops holding a concurrent-audit slot (needs a current `dist/`)
- `npx tsx test/auditResumeE2E.test.ts` — the real built server on a durable `DATA_DIR`, killed with SIGKILL and started
  again: an audit killed between steps finishes with exactly the planned calls; one killed mid-call repeats that call
  once and says so (a repeated call and an incident); one killed three times on the same step stops with a sentence
  and the calls are capped; a page-driven audit carries on when the page asks again; a job with no plan is failed at
  boot with a code and a sentence (needs a current `dist/`)
- `npx tsx test/googleAuth.test.ts` — Sign in with Google, pure: every wrong ID token refused (algorithm none or HMAC, wrong or weak key,
  other audience or issuer, expired, future, overlong, unverified or missing email, malformed), the invited-list and client-id
  configuration, and Google's key cache (fetched once, one refresh a minute, stale keys kept when Google is down), against keys the
  test makes itself
- `npx tsx test/googleAuthE2E.test.ts` — the real built server with a fake Google keys server: an invited address signs in and the
  session works on protected routes, an uninvited valid account is refused by name, every bad token gets a plain sentence, removing an
  address ends its session, a Google-only server accepts no access code, Google down is a 503 and held keys keep working, rate limit
  (needs a current `dist/`)
- `npx tsx test/googleLoginUi.test.ts` — the login page in Chromium with a stand-in for Google's button script: Google first and the
  access code collapsed under it, not-invited and expired messages, script blocked then "Try again", Google-only and no-Google and
  half-configured pages, the phone layout (way in on the first screen, no sideways scroll; set `GOOGLE_LOGIN_SHOTS_DIR` to save
  screenshots) (needs a current `dist/` and a Chromium)
- `npx tsx test/postgresConfig.test.ts` — reading `DATABASE_URL` and scrubbing it from text: TLS choice by `sslmode`/host, refusals that
  never repeat the address (pure checks, no database)
- `export TEST_DATABASE_URL=$(bash scripts/pg-test-cluster.sh start)` — a throwaway local PostgreSQL for the next two commands (needs the
  `postgresql` server programs installed; without `TEST_DATABASE_URL` they print `SKIP ... NOT RUN`, and CI sets `REQUIRE_POSTGRES=1`)
- `npx tsx test/store.test.ts` also runs the whole contract suite on the PostgreSQL store when `TEST_DATABASE_URL` is set: six stores
  opening at once, a newer database refused, restart survival, eight simultaneous claims from two stores give one, the same key from
  two stores refused, the same columns as SQLite, `openStore` fallbacks that never leak the address
- `npx tsx test/postgresE2E.test.ts` — the real built server, two processes on one PostgreSQL (`AUDIT_DRIVER=client`): the same click
  sent to both makes one job; an audit advanced alternately by both finishes with the planned calls; a server killed mid-call is taken
  over after its claim expires with the repeat recorded; nothing lost when every server is killed; readiness says postgres (needs a
  current `dist/` and `TEST_DATABASE_URL`)
- `npx tsx test/recentTrouble.test.ts` — the "recent trouble" sentence the deep readiness check reports: quiet is healthy, a step that threw or ran out of tries is a fault, restarts and slow audits are noted but are not (pure checks; the end-to-end proof is in `auditStepsE2E`)
- `npx tsx test/engineProbe.test.ts` — the engine probe (`scripts/engine-probe.mjs`, started by hand as the `engine-probe` workflow) as a real
  child process against local fakes of Gemini, Mistral and Groq: the printed blocks (status, whether a search ran, source count, field names,
  the reply cut at 4,000 characters), the call budget (13 calls at 2 questions, 17 at 3; a bigger run or a bad `--questions` is refused before
  any call), SKIP lines for a missing key, and that no key, `projects/<digits>` or ten-digit number reaches the public log although the fake
  failures carry them (no network, no `dist/` needed)
- `npx tsx test/searchedAnswer.test.ts` — the searched-or-not rule on reply shapes and the exact not-searched and hint sentences (pure)
- `npx tsx test/unsearchedE2E.test.ts` — the real built server and the fake Gemini (grounding only when the request carries the search tool;
  modes `unsearched_answer`, `unsearched_second`, `search_refused`, `search_500`): an unsearched answer is not counted (1 of 2, the same
  calls as a searched audit), all unsearched is a failed audit with 1 call, a refused search fails as before (baseline measured on main) plus
  the hint, the cap carries no hint, and each readiness case (two calls, breaker not tripped by a refused search, cached = 0 calls) (needs a current `dist/`)
- `npx tsx test/reportCompare.test.ts` — `compareReports` (`src/reportCompare.ts`), pure: every reason two audits are not comparable, a failed look-up
  on each side with its sources, a rival named only in a pair that failed in the other run, identical, empty and one-question audits
- `npx tsx test/rerunE2E.test.ts` — the real built server and a fake Gemini that changes its answer between two runs: `/api/audit/rerun` reads
  every input from the saved audit (a junk body is ignored), costs exactly what the audit costs, carries `previousAuditId` on the saved report, a second
  user gets the not-found answer, a retried click is one audit, a failed re-run is not saved, the limiter and sign-in apply (needs a current `dist/`)
- `npx tsx test/rerunUi.test.ts` — "Run again" and the "Since the previous run" strip in Chromium, desktop and phone (counts, the caveat, no percentage,
  no sideways scroll, the strip on the first screen, the deleted-earlier-audit sentence, a failed re-run) (needs a current `dist/` and a Chromium)
- `npx tsx test/testHarness.test.ts` — a guard on the tests themselves: no test may `return` early after a failed check without setting an exit status (that printed FAIL and exited 0, so the suite stayed green without having run the test; source scan, checked against fixtures of each shape)
- `npx tsx test/auditSteps.test.ts` — pure checks of the step plan, which answers the steps produced, and the
  quota-breaker rule (including the several-engine cases no end-to-end test can reach)
- `npx tsx test/auditStepsE2E.test.ts` — the real built server, a fake Gemini that counts hits, and the real
  SQLite file: an audit's step rows agree with the calls it made (one question = 2 calls and 3 done steps;
  every engine failing = 1 call and a skipped analysis; a forced step exception = a failed step, an incident,
  a failed audit, not billable). Needs a current `dist/`
- `npx tsx test/auditGoldenE2E.test.ts` — the real built server and a fake Gemini; twelve scenarios' reports
  compared with `test/golden/` after dropping per-run values and sorting keys (captured before `src/auditPipeline.ts` was split out).
  A deliberate change to the report is `UPDATE_GOLDEN=1`, then read the diff (needs a current `dist/`)
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
- `npx tsx test/ports.test.ts` — guards the ports the end-to-end suites use: Node's `fetch` refuses a fixed list
  of ports (3659, 4045, 4190, 6000, 6566 and others) at once, so every suite draws ports through `test/ports.ts`;
  checks the list against the running Node and fails if a suite draws ports by hand
- `npx tsx test/diagnostics.test.ts` — the failure diagnostics themselves: what the server logs about a
  failed Gemini request (the real cause, never a key), what the end-to-end suites print for a server when they fail,
  and, against the real built server with Gemini on a closed port, that the log names ECONNREFUSED while the
  person's sentence does not (needs a current `dist/`)
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
- `bash test/reviewAgents.test.sh` — the three agents pin `model: sonnet`, the owner's rule D-11 (part of `npm test`)

