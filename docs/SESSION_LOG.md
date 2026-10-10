# Session log (append-only)

One entry per working session, newest last. An entry says what the session did,
found, decided and left open, in enough detail that a session that never saw the
conversation can continue. Do not edit old entries except to add a correction note.
Companion files: `docs/PROGRAM.md` (state), `docs/DECISIONS.md` (why),
`docs/INSIGHTS.md` (what was learned), `docs/OWNER_DIRECTIVES.md` (the mandate).

---

## 2026-10-09 to 2026-10-10: independent review, seven fix PRs, then the owner's answers

**Mandate received:** scrutinise the product with a CTO mindset and supporting
agents, fix what is wrong in small tested PRs, report what could not be verified,
and tell the owner how to try it. Only this repository may be changed; the other
repositories were read-only context.

**Done (all merged to `main`, CI green on each merge):**
#19 two-character acronym brands (HP, 3M) were measured at 0%; #20 accented and
non-Latin vendor names truncated; #21 accuracy rate used the wrong denominator and
re-attributed invented claims; #22 adapters untested, a retiring default model,
wrong-provider advice; #23 score shown without its uncertainty or provenance;
#24 a plain database copy restores nothing (WAL), added `scripts/backup.mjs`;
#25 add-query and tick-task silently did nothing after reload, and a guessed
domain; #26 the written review (`docs/REVIEW_2026-10-09.md`).

**Process findings:** every fix PR's first version failed a fresh-context
adversarial review (a defect in the fix itself), up to four review rounds; a
fact-check of the report found five wrong statements before it merged. Docker Hub
anonymous-pull limits repeatedly failed CI; one unexplained test failure
(`quotaEfficiencyE2E`, "Could not reach Gemini", zero requests) passed on re-run
and did not reproduce locally in three runs. Overlapping random test ports are the
suspect (INFERRED, `TECH_DEBT.md` 2.14).

**2026-10-10, the owner's answers** (verbatim in `docs/OWNER_DIRECTIVES.md`): $0;
must not fail silently and be designed not to fail; automatic deployment to a URL
they open; they know Vercel and Supabase; two decisions delegated to the agents;
keep records. The team protocol ran (three solo positions, one debate round); the
outcome is the 2026-10-10 entry in `docs/DECISIONS.md`.

**Verified this session (MEASURED):** `npm run verify` on merged `main`: 1,092
checks passed, 0 failed, 0 vulnerabilities. Start-up with no key.

**Could not do, and why (so nobody repeats the attempt blindly):**
- Reach the live site, vendor documentation, or Gemini: the sandbox cannot resolve
  outside hosts (network policy; owner action O-1). Web search returns snippets only.
- Delete merged remote branches: the git proxy answers HTTP 403 to ref deletion
  (tested). The fix is the GitHub setting "Automatically delete head branches" (O-5).
- Set branch protection: no tool exists for repository settings (O-5).
- Create the database or set Vercel variables: needs the owner's logins (O-3, O-4).
- Run a real audit: no key (O-2).
- Run Docker: the client exists, no daemon.

**Left open:** see `docs/PROGRAM.md` section 2. Next up, in order: honest first
visit (storage-mode line, no-engine message, default 2), Docker out of required
checks, invariants plus number guard plus "Not counted" panel plus cited-only metric,
$0 guard, step-wise state machine.

**How to resume:** read `docs/OWNER_DIRECTIVES.md`, `docs/PROGRAM.md`, then the
2026-10-10 entry in `docs/DECISIONS.md`; run `npm ci && npm run verify`; pick the
first "next" row in `docs/PROGRAM.md`.
