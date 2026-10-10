# Plan: RELIABILITY step e, the step-wise, resumable audit

Written 2026-10-10 by a read-only planning pass over `main` at 145ca8c, so a session with no memory
of the conversation can build it slice by slice. It is a **plan, not a record of what is built**:
the status of each slice is in `docs/PROGRAM.md` row 7 and `docs/RELIABILITY.md` section 6. Line
numbers are as of that commit and drift; search for the names. Design intent: `docs/RELIABILITY.md`
sections 1, 2, 6, 7. Mandate: `docs/OWNER_DIRECTIVES.md` (D-1 $0, D-2 must not fail silently).

## What is true today (the reasons for the design)

- `POST /api/audit/run` creates a job and then runs `void runJob(...)` after answering 202
  (`server.ts`, search `void runJob`). On Vercel the function can be frozen or killed after it
  responds, and each poll may reach a different instance, so work "after the response" is the
  failure class 2 in `docs/RELIABILITY.md`.
- `performAudit` is one ~380-line closure: plan, a sequential collect loop with delays, pure analysis,
  one narrative call, report assembly, `assertReportInvariants`.
- Per process only: the Gemini pacer (`scheduleGeminiCall`, 6.5 s gap), the quota breaker
  (`geminiBreaker`), the call counter and cap (`geminiCalls`), admission (`serialised`).
- The store (`src/store.ts`): job statuses `running | done | error`; a job row has `progress`,
  `result`, `billable`, `budgetKey`; no steps, leases or attempts. `MemoryStore`, `SqliteStore`
  (migrations by `PRAGMA user_version`), `openStore({serverless})` returns memory on Vercel.
- Boot calls `failAllRunning` when the store is durable; the foundation E2E tests assert that
  ("restarted").
- The client (`src/auditClient.ts` `runAuditJob`) POSTs once with an Idempotency-Key, polls GET
  every 2.5 s, treats 404 as expired, and persists nothing about an active job.
- `vercel.json` sets no `maxDuration`; the real maximum is unverified (`docs/PROGRAM.md` section 4).

## Core design

**One engine, two drivers.** All work happens in `advanceJob(jobId, holder, now)`, which performs
exactly one step and returns. The inline driver loops over it in-process after the 202 (default off
Vercel, keeps every existing polling E2E passing). The client driver (`AUDIT_DRIVER=client`, default
when `process.env.VERCEL`) means nothing runs after any response: the page calls
`POST /api/audit/job/:id/advance` once per step.

**Steps** are planned once at submit: `collect:<queryIndex>:<engine>` per question and engine, then
`narrative`, then `finalize`. Analysis is pure and recomputed inside narrative and finalize rather than
stored as its own step. A failed provider call is a stored result (the collectors already return an
evidence object with `error`), not a retry. A collect step is skipped with `skip_reason='breaker'`
when the breaker is tripped. `finalize` assembles the report, runs the invariants, saves the audit and
writes `result` with the same `billable` rule as today.

**Rows** (SQLite migrations 4 and 5, mirrored in `MemoryStore`): `jobs` gains `plan` (JSON),
`phase`, `heartbeat_at`, `instance_id`, `fail_code`; status stays `running | done | error`, and
"stalled" is derived (running, client driver, no recent heartbeat). New `job_steps(job_id, seq, key,
kind, query_index, engine, state pending|leased|done|skipped|failed, attempt, lease_until,
lease_holder, call_started_at, finished_at, result, skip_reason, error_code)`, `shared(name, num,
text)` for pacer, breaker and call counter, and `incidents`.

**New store methods:** `createPlannedJob` (atomic, same unique `(owner, idem_key)` rule),
`getJobSteps`, `claimStep(jobId, holder, leaseMs, now, maxAttempts)` returning `claimed | busy |
exhausted | none` (compare-and-set on state and lease), `markCallStarted`, `completeStep` (first
writer wins, returns boolean), `touchJob`, `recordIncident` / `listIncidents`; later
`claimGeminiSlot`, `tripBreaker`, `getBreaker`, `recordCall`, `callsOn`; `info()` gains
`instanceId`.

**What leases and attempts guarantee (exactly-once is impossible for an external call):** a stored
step is never repeated; two live claimers cannot hold one step; an unfinished step is retried at most
`MAX_STEP_ATTEMPTS` (3) times, then the job ends `failed(step_attempts_exceeded)` with a sentence;
`call_started_at` is written before the network call so a step that died mid-call is counted as a
possibly repeated call, shown to the user (`repeatedCalls`) and logged as an incident. The lease
(`AUDIT_LEASE_MS`) must be longer than the function's maximum duration. Submit becomes free: spend
happens only in `advance` on the one jobId the client holds, which also closes the cold-start-retry
duplicate-job hole on the memory store.

**Lost instance / lost memory must be visible.** If `advance` or GET finds no job (new instance,
memory lost) the server answers 404 `job_not_found` with `storage`. The client, knowing from
`/api/audit/status` that the store is not durable, throws a typed `AuditInterrupted{state_lost,
stepsDone, total, callsMade}` and shows a sentence: the instance holding the audit was replaced, how
many questions had been answered, nothing from the interrupted run is shown as a measurement, running
again can use up to M more engine calls. It never auto-resubmits. A durable record of a lost memory job
is impossible; only a server log line exists, and the sentence must not claim otherwise.

## Slices (each a small PR with its own tests; update `docs/RELIABILITY.md` section 6 and `docs/PROGRAM.md` row 7 in the same PR)

1. **S1 pure seams, no behaviour change.** New `src/auditPipeline.ts`: `planAudit`, `analyseEvidence`,
   `assembleReport` (layer 4, summary guard, invariants), `failedShape`; `performAudit` becomes a thin
   sequential composition. Boundary test: fixed evidence in, report deep-equals a golden JSON captured
   from the pre-refactor server (strip `id`, `createdAt`); the whole suite unchanged, including the
   hit counts in `quotaEfficiencyE2E`. New modules are imported with explicit `.js` extensions
   (`test/vercelEsmImports.test.ts`).
2. **S2 store contract.** Types, migrations, Memory and Sqlite implementations, `instanceId`, tests
   inside `test/store.test.ts` `suite()` so both stores cannot drift: concurrent `claimStep` gives one
   `claimed` and one `busy`; an expired lease is reclaimed with attempt 2; a fourth claim is `exhausted`;
   a double `completeStep` stores one result; steps survive closing and reopening a real SQLite file.
   Nothing in the server uses it yet.
3. **S3 engine and inline driver (behaviour-preserving).** `/api/audit/run` plans and creates the
   planned job, then loops `advanceJob` in-process; `runJob` is removed; the GET view gains additive
   fields (`phase`, `step`, `callsMade`, `repeatedCalls`, `storage`, `instanceId`). Keep the
   late-finish-after-reap behaviour (the foundation E2E at "reaped at JOB_MAX_RUN_MS" must pass
   untouched). Boundary test (`test/auditStepsE2E.test.ts`): a 1-query audit makes exactly 2 fake
   Gemini hits and the SQLite file holds 3 `done` steps with `attempt=1`.
4. **S4 client driver, advance endpoint, visible lost state (the Vercel slice).** `AUDIT_DRIVER=client`:
   `POST /api/audit/job/:id/advance` returns the view plus `outcome advanced | busy | finished | wait`
   and `nextStepAfterMs`; 404 `job_not_found`; `src/auditClient.ts` branches on the driver the 202
   returns and throws `AuditInterrupted`; exempt `/api/audit/job/*` from `spendLimiter`; make
   `countRunning` heartbeat-aware so abandoned jobs do not hold the 2 slots for 15 minutes; add an HTTP
   timeout to the Gemini client; `vercel.json` `functions.maxDuration` (value unverified, record it as
   such). Tests: with the client driver nothing runs after the 202 (0 hits after 1.5 s), advancing to the
   end makes exactly the planned hits, a replayed submit changes nothing, two concurrent advances give one
   `advanced` and one `busy` with a hit delta of exactly 1, a retried submit under another key is never
   advanced, two memory-store processes give `job_not_found` with 0 hits, and `auditClient.test.ts`
   asserts the exact sentence.
5. **S5 resume on a durable store.** Replace the boot `failAllRunning` for stepwise jobs with a sweeper
   (boot, then every 15 s while inline jobs run; not `setInterval` on Vercel); incidents for
   `lease_expired_midcall | step_attempts_exceeded | invariant`; deliberately update the foundation E2E
   SIGKILL assertions (resume instead of "restarted"). Tests with a durable `DATA_DIR`, client driver and
   a short lease: kill between steps (total hits exactly the plan, `repeatedCalls` 0); kill mid-call
   (hits plan + 1, `repeatedCalls` 1, one incident); kill three times on one step (failed with
   `step_attempts_exceeded`, hits capped); two processes on one `DATA_DIR` give one `advanced` and one `busy`.
6. **S6 pacer, breaker and call counter into the store** so two processes sharing a file respect one rate;
   `spend.scope` becomes `'shared store'` when durable. Tests: two processes, every inter-hit gap at least
   the interval; a daily 429 tripped on A means 0 further hits from B; a cap of 2 over two processes gives
   exactly 2 hits.
7. **S7 stalled / Resume / Discard in the UI, visible retries.** Persist `{jobId, startedAt}` in
   `localStorage`, `resumeAuditJob`, a resume banner, the "Retried / Completed after 1 retry" strings,
   `POST /api/audit/job/:id/discard` (only now, because a dead button is forbidden). Browser and pure tests.

## Risks (what could break an existing flow)

- Boot behaviour changes: orphaned jobs resume instead of failing "restarted" (S5, deliberate test edits).
- S1 drift: the golden-report test is the only guard; do not change any string.
- `spendLimiter` counts every POST: exempt the job endpoints or a 3-question audit nears 30 per minute.
- `MAX_CONCURRENT_AUDITS` slots: abandoned client-driven jobs must stop counting (heartbeat).
- `maxDuration` is unverified; a worst-case step (pacing gap, call, a 20 s rate-limit wait, 5 s and 10 s
  retries) can exceed 60 s. Mitigations: HTTP timeout (S4), deferred waits (S6); until then the lease and
  attempt cap keep it bounded and visible.
- A hidden browser tab throttles timers, so a client-driven audit slows in the background.
- Vercel plus memory will look louder before it looks better: each advance may land on another instance,
  so `state_lost` may be common until step f (the durable store). That is the honest outcome, not
  reliability, and copy must not call it reliable (`docs/RELIABILITY.md` line 8).
- Existing E2Es parse the GET job body: change it additively only.
- `serialised()` admission is per process; a transactional admit belongs with step f.

## Do NOT do in this effort without the owner or the durable store

- PostgresStore / Supabase (step f, owner action O-4), or any claim that Vercel audits are durable or
  resumable, or any cross-instance guarantee on the memory store.
- Flip `DEFAULT_QUERY_COUNT` to 3 (decision D): only once audits can resume; consider making it
  server-chosen (3 only when `store.info().durable`).
- A durable call cap, durable incidents (labelled "in-store" until step f), the deep health endpoint,
  owner health section, canary heartbeat (step g), a daily reaper cron (needs owner configuration).
- Verifying anything on the real Vercel deployment (owner actions O-1, O-3); record `maxDuration: 60` as
  AGENT-level and unverified.
- Signed client-carried evidence (a free way to make memory-only Vercel resumable): answer text in request
  bodies under a body limit plus an HMAC trust decision. Raise it as a team or owner decision, not a build.
- Merging without the gates: green CI, a fresh-context adversarial review, an EVAL PM SHIP.
