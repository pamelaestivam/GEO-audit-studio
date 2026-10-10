# Reliability architecture: designed not to fail, and loud when it does

Status: design of record, agreed by the product team on 2026-10-10 (`docs/DECISIONS.md`).
Mandate: `docs/OWNER_DIRECTIVES.md` D-2. This file says how. Nothing here is built
yet unless the "Built?" column in section 6 says so; keep that column true.

The promise is **"failure is always visible"**, not "it cannot fail". Any copy,
doc or PR that claims "never fails" or "durable" before the thing that makes it
true has shipped is itself a defect (CTO veto, 2026-10-10).

## 1. Failure model

Every way the product can go wrong falls in one of six classes. A defence that
does not name its class is decoration.

| # | Class | Examples | Defence |
|---|---|---|---|
| 1 | Provider | 429 per-minute or daily, 5xx, malformed or empty output, blocked prompt | Existing breaker and retry-after wait; every failed call recorded with a reason code; partial results still report |
| 2 | Platform | Function frozen or killed mid-audit; timeout; instance changed between request and poll | Step-wise jobs: one step per HTTP invocation, nothing runs after a response; leases |
| 3 | State loss | Store unreachable, free database paused, memory store on a serverless host | State is stored per step; the storage mode is shown to the user; a daily canary keeps a free database awake and notices a pause |
| 4 | Logic | Wrong denominator, item discarded without being counted, summary contradicts the metrics | `assertReportInvariants` at finalisation; the number guard on written text; a violation marks the audit `invalid` |
| 5 | Configuration drift | A secret missing on the host, a paid key present, billing enabled at the provider | A deep health check returns booleans only; the canary fails the run when any is red |
| 6 | The alert path itself | The scheduled check stops running | A heartbeat row per run; a missing heartbeat is red on the next run |

## 2. Audit as a persisted state machine (replaces `void runJob()` after a 202)

```
queued -> collecting(query_i, engine) -> analysing -> narrating -> done
                 |                                                  
                 +-> failed(code) | stalled | invalid
```

- One row per job. Each transition is **one HTTP invocation** that awaits its own
  work. No work is started after a response is sent (on a serverless host that work
  can be frozen).
- A step takes a **lease** (`lease_until`, `attempt`). The client's poll advances
  the job when the lease has expired. More than three attempts on one step ends the
  job as `failed(code)` with a sentence.
- Evidence is persisted per (job, query, engine) **before** the next step. A restart
  or a second instance resumes from stored evidence and never repeats a stored call.
- The Gemini pacing gap and the quota breaker move into the store
  (`last_call_at`, `tripped_until`) so every instance sees one truth.
- `stalled` means nobody advanced the job (the tab was closed). The user sees
  "paused, reopen to continue", never an error and never a zero.
- At $0 there is no server clock that can act for a user: the free hosting plan runs
  scheduled jobs at most once a day (AGENT), and a free GitHub schedule cannot advance a
  user's job without a session. Continuation therefore depends on the page being open; a daily
  job only reaps stalled jobs and writes incidents. This is a stated limit, not a
  hidden one.

## 3. Invariants, machine-checked

One pure function, `assertReportInvariants(report, evidence)`, runs when a job is
finalised and again when a saved report is read:

1. `evidence_total = used + discarded`, and every discarded item has a reason code.
2. Headline denominators equal the usable observations (planned = answered + failed).
3. A failed or invalid report carries no metric fields (a failure is never a zero).
4. Every inaccuracy claim ties to a captured answer (query and engine) or is listed
   as not counted.
5. Every number in written text is in the computed set (see section 4).
6. Status is one of the enumerated values.

A violation sets status `invalid`, writes an incident, and the report is never shown
as done.

## 4. Numbers in written text

The summary's figures come from a deterministic sentence built from the computed
metrics. The model writes qualitative prose only. A guard extracts every number from
the model's text, **including spelled-out numbers** ("three of four"), and drops any
sentence containing one that is not in the computed set. A dropped sentence is
recorded as an incident and the user sees a footnote ("1 sentence from the written
summary was removed because it contained a figure we could not verify. All figures
on this page are measured."). If every sentence is dropped, the template-only
summary is shown with the same footnote. No second model call.

## 5. What the user and the owner see

Every failure is shown in four parts: what happened, what it means for the numbers,
what is still valid, what to do next. A failure is never a zero and never a blank tile.

- **Not counted** (one panel, one strip at the top of the report when count > 0):
  "3 items in this audit were not counted. See why." Each row: the raw text, a plain
  reason, a badge "unverified". Footer: "These are excluded from every rate. Accuracy
  is shown as 'at least N'."
- **Degraded**: amber "Not assessed" plus the reason; never 0%.
- **Retried**: "Gemini rate-limited us; waiting 40 s as the provider asked (attempt 2
  of 3). Nothing has failed." and, afterward, "Completed after 1 retry".
- **Stalled**: "paused, reopen to continue" with last-heartbeat time. A Resume or Discard
  button ships only when the lease mechanism it depends on exists (a button that does
  nothing is a dead control).
- **Storage mode**: until the durable store exists, a persistent line: "Preview
  deployment. Audits are kept only while this server stays awake and can be lost on
  reload. Export your report to keep it." The text comes from the server's own status
  response, never hardcoded.
- **No engine configured**: "No engine is configured, so no audit can be measured
  yet." Never a simulated result.
- **Owner health** (a section in the signed-in area, owner only; first slice):
  last good audit age; incidents in 24 h with class, code and whether the user was
  told; store mode; secrets present (booleans only); paid keys detected (red); last
  canary time and result.

## 6. Order of work and status

| Step | Size | Built? |
|---|---|---|
| a. Honest first visit: a visible storage-mode line, "no engine configured", default 2 questions. (The status endpoint already reports storage and the engines, and the app already asks before leaving a page with an unsaved audit; no visible line existed.) | S | yes (PR #30, 19005fc) |
| b. Docker removed from the required checks; CI smoke runs `dist/server.cjs` | S | no |
| c. `assertReportInvariants`, number guard, "Not counted" strip and panel; cited-only as its own number | M | partly: invariants and the number guard on the executive summary are built and tested (`src/reportGuard.ts`; a violation becomes a visible failed audit, not billable, not saved). Not built: the "Not counted" strip and panel, the cited-only number, an incidents table (see `TECH_DEBT.md` 2.15) |
| d. Paid-engine refusal and per-instance call counters (labelled "this instance" until the durable store exists) | S | no |
| e. Step-wise state machine on the memory and SQLite stores, leases, incidents; default returns to 3 | L | no |
| f. PostgresStore for Supabase against the same `Store` contract; the store tests run against both | M-L | blocked on the owner (`docs/PROGRAM.md`, owner actions) |
| g. Deep health endpoint, owner health section, scheduled canary workflow with one deduplicated GitHub issue on failure | M | no |

The durable call cap and the durable incidents table are only durable after step f.
Until then they are labelled "in-store" and the storage mode is shown.

## 7. Tests this design requires (the repo's template is `quotaBreakerE2E` and the SIGKILL test)

- Kill the built server between two steps; restart; the job resumes and the count of
  real HTTP hits to the fake Gemini proves no stored call was repeated.
- Two instances against one store: only one holds a lease.
- Fuzz `assertReportInvariants` with random evidence and prove a report it accepts has
  consistent denominators.
- Mutation-test `src/analysis.ts` and the guard in CI (13 of 14 sampled mutations were
  caught in the 2026-10-09 review; that harness was not committed, so the figure is
  not re-runnable; the adapters had none).
- A canary test that fails closed: break the health endpoint on purpose and assert the
  workflow goes red.
