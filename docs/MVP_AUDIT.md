# MVP audit and 20-item roadmap

Adversarial audit of GEO Audit Studio, 2026-10-09. Written to be read cold.

**How to read the evidence tags.** Each finding says how it is known:
**MEASURED** = reproduced against the built server / in a real browser this
session; **READ** = seen in the code, not exercised; **INFERRED** = reasoned
from how the platform works, not observable from this environment, with the
step that would confirm it.

---

## 0. Who the "agents" are

There are no agent definition files in this repo (no `.claude/agents`, no
subagent configs). The "agents" are the four standing **seats** in
`docs/TEAM_CHARTER.md`, which one Claude session adopts as thinking lenses -
not separate processes or models:

| Seat | Role | Veto |
|---|---|---|
| **PM Twin** | what gets built and why; speaks as the owner | anything that changes what the product promises a client |
| **CTO** | feasibility, sequencing, cost of being wrong | fixes built on an undecided infrastructure assumption |
| **UX Lead** | what users do/feel + what the interface does about it | any number, chart or control that looks real but is not |
| **EVAL PM** | the merge gate - scores, never builds (`docs/EVAL_PM.md`) | nothing merges on REVISE/REJECT |

(The charter's prose says "three seats" and then lists four; the fourth,
EVAL PM, was added later. Cosmetic, but worth fixing next time the file is
touched.) Separately, the product *queries* four answer engines - Gemini,
ChatGPT, Perplexity, Claude - but only Gemini has a key today.

---

## 1. Verdict

> **Status after round 2 (2026-10-09, later the same day).** Findings A1-A4 below
> are *fixed in the code*: sign-in is real and enforced (A2), state is durable
> (A3), every spending route is limited (A4), and an always-on deployment is
> provided (A1 - **you still have to create the host**, and A1 itself remains
> *inferred*, never measured on Vercel). The roadmap table below shows each item's
> current status. A second, independent adversarial review (a fresh-context agent)
> found 12 further defects in round 2's own work - an auth fall-open on a plain
> `npm start`, rate limits bypassable via `X-Forwarded-For`, audits private only
> by claimed email, unbudgeted spend routes, a phone layout overflow, orphaned
> jobs costing budget, a path leak on a public endpoint, stale docs, and default
> queries that make "100%" near-certain - all fixed and each test shown to fail
> without its fix (section 7).


| Use | Safe today? |
|---|---|
| **Owner runs audits and shows the results** (supervised) | **Yes**, on a single always-on process with a disk, once the host is created and a real Gemini key is set (`docs/DEPLOYMENT.md`). The numbers are honest about what they rest on. |
| **A handful of invited users** | **Yes, on that same deployment** - invitation-only sign-in, private audits (per code), budgets. **Not on the Vercel deploy:** see finding A1. |
| **Open signup / paying clients** | **Not yet.** Sign-in is by invitation only, one instance, no Terms/Privacy, no backups scheduled, and the engines have never been run with a real key. |

---

## 2. Findings

### A. Architecture and security - need your direction

**A1 - Audits run as fire-and-forget background work in a request-scoped host
(INFERRED, high confidence).** `POST /api/audit/run` returns `202`, then keeps
working after the response. `api/index.ts` runs that on Vercel. A serverless
function is not guaranteed to keep executing after its response is sent, the
poll (`GET /api/audit/job/:id`) can land on a different instance that has never
heard of the job, and one audit takes at least `(queries + 1) x 6.5s` of
deliberate pacing (about 26s for the default three queries) - longer than the
default function duration on some plans. The visible symptom would be the
existing message *"That audit is no longer available. It may have expired or
the server restarted"* on perfectly healthy audits, intermittently.
*Why this is not MEASURED:* no Vercel access from here. *To confirm in two
minutes:* run one default audit on the live site and watch for that message;
check Vercel -> Logs for the function's duration and any "Task timed out".
This is the same family as every past incident (Render sleeping, Vercel
crash, Vercel routing): **a host whose lifecycle does not match an in-memory,
long-running job design.**

**A2 - Authentication is not authentication (MEASURED). FIXED in round 2** (real sign-in, enforced and tested; limits in `TECH_DEBT.md` 2.11).
- `POST /api/auth/login` with an email the server has never seen returns a
  user and a token. Any password. (`curl` this session.)
- The token is `token-<timestamp>`; **no endpoint checks it.** `POST
  /api/audit/run` with no credentials of any kind returned `202` and started
  spending quota. (`curl` this session.)
- The client made it worse: on *any* sign-in failure - wrong password, server
  down - `AuthPage` caught the error and logged the person in anyway with a
  locally invented user. **Fixed this round** (MEASURED before/after in a real
  browser: wrong password used to reach the dashboard, now shows the server's
  error). The server side is still open.
- A demo account with a password in source (`password123`).

**A3 - Nothing persists (READ + known, `TECH_DEBT.md` 2.1). FIXED in round 2** (SQLite, one instance). Audits live in
React state; a refresh destroys a finished audit. Server state (jobs, breaker,
idempotency keys, users) is process memory. **Mitigated this round:** the app
now asks before the tab closes, and the sidebar says audits are not saved.

**A4 - One shared quota, no admission control (MEASURED). Per-IP, concurrency and body limits fixed in round 1; per-user budgets and lookup limits added in round 2.** Every quota-
spending endpoint was open to the internet and had no per-client limit and no
cap on concurrent audits, so one script - or one stuck retry loop - could burn
the day for everyone. **Fixed this round** (per-IP limit, concurrency cap,
stuck-job reaper, body-size limit; all proved against the real binary). The
limits are per-process, so they are a floor, not the end state (item 11).

**A5 - Gemini is still mandatory and the other three engines have never been
run against a live payload (READ, `TECH_DEBT.md` 1.2, 2.8).** The ChatGPT /
Perplexity / Claude parsers are written defensively but have only ever seen
documentation-shaped fixtures.

### B. Measurement integrity - fixed this round

**B1 - Vendor discovery corrupted share of voice (MEASURED).** The previous
round removed an LLM call by finding vendors with a "capitalised phrase"
heuristic. On a realistic markdown answer about Austin poke restaurants it
returned **15 "vendors", 13 of them junk** - `Monday`, `Pricing`, `Key`, `Why`,
`Austin`, `Yelp`, `Ask Siri`. Consequences, all measured: the client's share of
voice read **6% instead of 33%**, and the Executive Summary's "Rivals the
engines named that you did not list" card listed `Pricing`, `Key` and `Fresh`.
`TECH_DEBT.md` 2.6a had documented the trade-off as lost *recall*; the real
cost was lost *precision*, which is worse for a client-facing report because
it shows a fabricated rival. **Fix:** a name now needs structural evidence
(bold, list head, heading, table cell) or at least two mentions, plus a short
stoplist of weekdays, months, label words and review-site/search-engine names.
Cost, stated plainly: a vendor named exactly once in unformatted prose is not
discovered (it can still be added by hand as a tracked competitor). Verified:
same answer now yields `['Pokeworks', 'Sweetfin']` and share of voice 33%.

**B2 - A failed analysis step read as a perfect score (READ -> MEASURED).** If
the narrative call failed after evidence was collected, `inaccuracies` was
`[]`, so the report showed **100% fact accuracy, 0 inaccuracies, "No
Inaccuracies Found - all mentions were factually accurate"**. Failed work
counted as a negative finding - exactly what CLAUDE.md's "Denominators" rule
forbids. **Fix:** `narrativeAvailable` / `narrativeNote` on the report,
accuracy is `null`, the card says "Not assessed", the three qualitative tabs
say "Not assessed" instead of a clean bill of health.

**B3 - A fully failed audit shipped fabricated content (READ -> MEASURED).**
The degraded report contained a placeholder Schema.org remediation task with an
invented `"price": "0"` offer, a made-up omission ("lack of indexed web
entities"), `accuracyRate: 0`, and **all four engines marked `omitted`** - which
the matrix renders as "the engine left you out", a finding about the client -
including engines that were never configured. The Export modal printed all of
it with no warning. **Fix:** empty findings, only configured engines, status
"no data", per-engine failure reason, and a single presentation module
(`src/reportView.ts`) so the card, export and sidebar cannot disagree.

**B4 - Metrics that did not mean what their label said.**
- "Share of Voice" tile said *"Appeared in X% of tested search prompts"* - that
  is visibility, not share of voice (MEASURED).
- "GEO Visibility Index ... based on recommendation frequency & accuracy" - it is
  the share of captured answers that name the brand; accuracy is not in it.
- One answer rendered as **100/100 in green**. Now: "Named in 1 of 1 answer
  (Gemini)" and a caution under five answers.
- **Ticking a remediation checkbox raised the headline score** by an invented
  share of the remaining gap (`App.tsx`). Removed.
- "Add & Audit Query" recomputed the headline metrics in the browser with a
  different formula that counted a *failed lookup* as the brand appearing, over
  a hardcoded engine list of just Gemini. Now the added query shows its own
  result and the card says it is not in the headline figures.
- Blank "Core offerings" / "Target audience" were filled with "Products and
  services" / "Buyers and decision makers" and shown as the client's own words.

**B5 - UI claims with nothing behind them.** "Continuous Sweeps - **Active**"
and a pulsing "Live Engine Sweeps" dot (nothing is scheduled anywhere); "v2.4"
(invented); "OAuth & encrypted persistent user sessions"; "Password reset
instructions sent to your email" (nothing sent); a "Remember me" checkbox wired
to nothing; "3 LLM auto-generated queries" (they are templates, and a custom
query *replaces* them rather than appending); progress steps on a timer
announcing "Calculating GEO Visibility Index" at 3.8s; "Querying Gemini,
ChatGPT, Perplexity & Claude" regardless of what was configured; sample-brand
chips that started a paid audit on a single tap; an Export button that did
nothing before the first audit. All replaced with true statements or removed.

### C. Reliability - fixed this round

- Raw provider text could reach the report: non-Gemini engine errors were
  stored as `HTTP 401: {...}` and rendered in excerpts. Now a sentence at the
  point of collection; raw text stays in the server log.
- Error handling: malformed JSON, oversize bodies and unknown `/api` routes
  returned Express's HTML page. Now JSON sentences.
- Inputs: `evaluate-query`, `generate-queries`, `parse-url` had no length or
  type bounds (`/run` did). Prompt-injection surface and cost both scale with
  that.
- `describeProviderError` matched `401`/`403` anywhere in a string (the same
  bug class 2.3c fixed for `429`). Tightened.
- The Run Audit modal left a spinning loader with no way out after a failure.
- `evaluate-query` hid the server's actionable error behind "Failed to
  evaluate".
- A dead, unauthenticated `/api/audit/samples` route served invented audits as
  if real. Removed.

---

## 3. The 20 items

**Status:** ✅ done on this branch - 🟡 partly done - 🔵 needs your direction
(section 4) - ⚪ ready to build, no decision needed.

### Foundation - the gate for anything beyond supervised use

| # | Item | Why | Status |
|---|---|---|---|
| 1 | **Pick one runtime that matches the job model**: an always-on Node service serving API + static, or keep Vercel and re-architect around a queue | A1. Every past incident was a host/lifecycle mismatch. | 🟡 chosen: always-on service + disk (`Dockerfile`, `render.yaml`); **you create the host** (`DECISIONS.md`) |
| 2 | **Durable datastore** for jobs, idempotency keys, breaker state, audits, users, sessions | Replaces three process-global `Map`s; unlocks 3, 4, 5, 17, 19. | ✅ SQLite on a disk (one instance). Postgres when you need two |
| 3 | **Durable job execution**: survives restart, resumable, safe with more than one instance | A1, A3. A poll must never depend on which process started the job. | 🟡 restart-safe; a job cut off by a restart is failed with a sentence, not resumed |
| 4 | **Real authentication, enforced server-side on every `/api/audit/*` route, with per-user ownership of audits** | A2. | ✅ invite-code sign-in (chosen D3); Google sign-in later |
| 5 | **Budgets and a kill switch**: per-user audits/day, a global daily spend cap, an admin switch | The owner's recurring pain is quota; this makes it a number you set, not a surprise. | 🟡 daily per-user + global audit budgets, lookup + IP limits; no admin kill switch yet |

### Measurement integrity - the product's actual promise

| # | Item | Why | Status |
|---|---|---|---|
| 6 | **Vendor discovery you can defend**: a labelled golden set of real answers with precision/recall asserted in CI; decide whether one *batched* extraction call per audit is worth its cost | B1 fixed precision by giving up recall; a number should replace the argument. | 🟡 precision fixed; golden set + CI metric not built |
| 7 | **Failure is never a finding** across the whole pipeline, and *accuracy* stops being a model opinion (client-supplied fact sheet, or relabel permanently) | B2, B3 done; `TECH_DEBT.md` 2.5 still open. Also show "2 of 3 queries failed" instead of silently shrinking the denominator. | 🟡 failure-is-never-a-finding done; accuracy still a model opinion |
| 8 | **Sample size and run-to-run variance**: sensible default query count, repeat runs, show a range | Engines are non-deterministic; today a single answer produces a headline number. Cost scales linearly. | 🔵 D4 |
| 9 | **Enable a second engine** (Perplexity first), verify the adapters against live payloads, add per-engine breakers, remove the Gemini-for-narrative dependency | A5. Removes the single point of failure and the single shared quota. | 🔵 D4 |
| 10 | **Brand matching you can steer**: per-audit aliases and exclusions; retire the hand-maintained common-word list | `TECH_DEBT.md` 2.6/2.8. A brand named only by a shorthand is invisible. | ⚪ |

### Reliability and operations

| # | Item | Why | Status |
|---|---|---|---|
| 11 | **Admission control on shared state**: per-user limits and the concurrency cap on the datastore, not in process memory | A4 is fixed per process; this makes it fixed per deployment. | 🟡 audit budgets in the store; lookup and IP limits still per process |
| 12 | **CI plus a post-deploy smoke test** | CI added (`.github/workflows/ci.yml`: lint + `npm test`). The smoke test - `/api/health`, a nested `/api/audit/status`, a rejected POST, against the *deployed URL* - would have caught all four Vercel incidents before you did. | ✅ CI + `scripts/smoke.mjs` + container job (their first GitHub run is the first build of the image) |
| 13 | **Observability**: request/job ids in structured logs, error tracking, an uptime monitor on `/api/health`, a daily "calls per engine" line | Diagnosing the Vercel crash required you to copy a stack trace out of a dashboard. | 🟡 request ids + JSON logs; no error tracker or uptime monitor |
| 14 | **Deep readiness check**: validate each configured key and *model id* with one tiny call at boot/deploy; verify the defaults (`gemini-3.6-flash`, OpenAI `gpt-5`, Anthropic `claude-sonnet-4-5` are unverified here) | A wrong model id currently surfaces as the first customer's failed audit. | ✅ `/api/audit/readiness` (a live check only with a real key) |
| 15 | **Config hygiene**: fail-fast env validation with a sentence, rotate any key ever pasted into a chat, delete the in-source demo credential, keep `.env.example` complete | `.env.example` was missing four of five keys. | 🟡 fail-fast env, demo credential removed, `.env.example` complete; key rotation is yours |

### Product and trust

| # | Item | Why | Status |
|---|---|---|---|
| 16 | **A UI test layer**: Playwright smoke tests in CI against the real server and the fake-engine harness (sign-in, run, each tab, a phone viewport) | `CLAUDE.md` records this as a known gap; every UI defect in B4/B5 was found by eye. This session's browser script is the starting point. | ✅ `test/uiSmoke.test.ts` (desktop + phone, in CI) |
| 17 | **Saved history and re-run delta** ("12% -> 34% after the schema fixes") | The paid-tier feature in the PRD; the reason anyone renews. | 🟡 saved history + delete done; re-run delta not |
| 18 | **Evidence viewer and a forwardable report** (print stylesheet / PDF) | The verbatim answers are already captured; printing currently prints the dark UI. | 🟡 evidence viewer done; forwardable PDF not |
| 19 | **Scheduled re-audits and alerts - or remove the tab** | Honestly labelled "Preview" now; it should not stay a preview forever. | ⚪ |
| 20 | **Legal and trust basics**: Terms and Privacy pages (the sign-in footer cites both and neither exists), a data-retention statement, CSP header, `npm audit` in CI | A public MVP needs these before the first stranger. Basic security headers are done; CSP is not. | 🟡 headers + `npm audit` in CI; Terms/Privacy pages and CSP not |

---

## 4. Decisions (made in your absence - reversible - confirm or change them)

You said to continue without stopping, so D1-D3 were taken at my recommendation
and built; they are logged in `docs/DECISIONS.md`. D4 genuinely needs your money
and keys, so it is still yours. Each of the first three can be replaced later
without throwing the rest away.

- **D1 - Runtime (item 1). CHOSEN and built (you must create the host).** *Recommended: an always-on service* (Render
  starter, Fly, or Railway - roughly $5-10/month) serving the API and the
  built frontend from one process, which is how the code already runs
  (`npm start`). Alternatives: stay on Vercel and rebuild the job path around a
  queue and `waitUntil` (more moving parts, and per-invocation limits), or keep
  free Render for now (sleeps; the cold-start retry logic exists because of it).
- **D2 - Datastore (item 2). CHOSEN: SQLite on a disk (built); Postgres is the next step if you ever need two instances.** *Originally recommended: Postgres* (Neon, or Render's
  managed one). Works with either host. SQLite on a persistent disk is simpler
  but only valid if D1 is an always-on service with a disk.
- **D3 - Auth (item 4). CHOSEN and built.** *Recommended for the first invitees: an invite-code
  gate with a signed, expiring session token* - no third party, needs no
  datastore to start, replaces the placeholder in a day. Google sign-in is the
  right end state but needs a Google Cloud OAuth client from you
  (`TECH_DEBT.md` 1.5); magic-link email needs an email provider.
- **D4 - Engines and spend (items 8, 9). STILL YOURS.** *Recommended: enable Perplexity
  next* (search is native to `sonar`, so it costs least) and keep three
  queries per audit until a second engine is live. Say which keys you will pay
  for and a monthly ceiling, and I will wire the budget guard to it.

---

## 5. EVAL PM score

Round 1 (merged as #17): Groundedness 4, Completeness 4, Relevance 5 -> 87, SHIP.

Round 2 (this branch), scored after the independent review below was addressed:

```
BUILDER: CTO + UX Lead (one session), reviewed by an independent adversarial agent
TASK: Foundation (real auth, durable state), deployment, tryouts, agent process

SCORES
- Groundedness: 4/5 - every claim in the docs was checked against a run or marked unverified; the reviewer's 12 findings were each reproduced, fixed and re-tested; the only contact with a real engine was one rejected-key request
- Completeness: 4/5 - all asked parts delivered; engines, a real host and a phone/real-key tryout are impossible here and said so; Docker and render.yaml unproven until CI/Render run them
- Relevance:    5/5 - each change maps to a user-reported failure class or a reviewer-confirmed defect

COMPOSITE: 87/100 -> SHIP

TOP FIXES
1. Create the host and run `scripts/smoke.mjs` with a real Gemini key (the one thing that cannot be done from here).
2. Enable branch protection on `main` requiring `test` and `docker`.

FLAGS: none
CONFIDENCE: Medium-high - every fix has a test that fails without it; nothing has run against a real engine
```

## 6. What was not verified

- Anything on the live Vercel/Render deployments - no access from here (A1).
- The three non-Gemini engines against live responses (A5).
- That `gemini-3.6-flash` and the other default model ids exist (item 14).
- Real quota numbers - still only visible in the provider's own dashboard
  (`CLAUDE.md`, "Answer-engine quota").

## 7. Round 2 review: what an independent reviewer found in this branch

A fresh-context adversarial reviewer attacked the round-2 diff (`.claude/agents/
adversarial-reviewer.md`). The auth and ownership core held (it tried path
tricks, encodings, token forgery, parallel starts, cross-user polling). It found
real defects *around* it; all CONFIRMED ones are fixed, each with a test that was
shown to fail when the fix is reverted:

| # | Finding | Fix |
|---|---|---|
| 1 | Auth fell open to the public code `dev-access` on a plain `npm start` (NODE_ENV unset) | Dev sign-in needs an explicit opt-in, is production-proof, loopback-only; the built bundle defaults to production |
| 2 | Per-IP limits (incl. the code brute-force limit) bypassed by rotating `X-Forwarded-For` | `TRUST_PROXY` hops, default 0; limiter sweep bounded and capped |
| 3 | Audits private only by *claimed email* | Ownership is `(code label, email)`; labels survive code rotation |
| 4 | Only `/run` was budgeted; readiness stampede | Hourly lookup limit on the other spend routes; single-flight readiness |
| 5 | Phone: page scrolled sideways for a returning user (long brand name) | Header layout fixed; asserted at 390px across tabs |
| 6 | A restart-orphaned job still consumed the daily budget | Orphaned and reaped jobs are non-billable |
| 7 | Public `/api/audit/status` leaked a filesystem path and OS error | Generic public note; detail only in the log |
| 8 | Replayed submit said `running` for a failed job | Reports the job's real status |
| 9 | README, TECH_DEBT, roadmap, `.env.example` stale | Updated (this edit) |
| 10 | Default queries name the brand, so "100%" is near-guaranteed | First question is brand-neutral when an industry or competitor exists; the card warns when every query names the brand |
| 11 | Minor: misleading unreachable message; session-expiry lost context; "fresh search" only via a non-focusable div; HEAD status 401 | Fixed |
| 12 | A job reaped as stuck that later finished dropped its paid-for result | Late completion is recorded |

Also found by running things rather than by the reviewer: the compiled backend
was downloadable on every non-Vercel host; `.env.local` was never read; the
default queries were malformed; competitor "sources" were the same list for every
brand. The reviewer also noted two test weaknesses, fixed: a vacuous assertion,
and that "admission is atomic" is not demonstrably tested (the serialised
admission wrapper only matters once the store is asynchronous - e.g. Postgres -
and is now described as such).
