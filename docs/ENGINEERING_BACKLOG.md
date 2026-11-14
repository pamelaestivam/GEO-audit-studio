# Engineering backlog: tool chain, architecture and coding

Written 2026-11-14 after a review of the repository as it stands on `main`
(71c6fbe). Product work is `docs/PLAN_2026-11.md`; this file is about how the
product is built. Each item is one pull request unless it says otherwise, changes no
behaviour a person can see unless it says otherwise, and follows `CLAUDE.md`.

## What the review found (all READ in the repository, 2026-11-14)

| Finding | Evidence |
|---|---|
| The type checker is the only lint, and it is not strict | `tsconfig.json` has no `strict`; about 140 `any` in `server.ts` and `src/` (62 in `server.ts`) |
| The whole server is one function | `server.ts`, 2,344 lines; `buildApp()` runs from line 123 to 2233 and holds the routes, the Gemini client, the pacer, the breaker, readiness and the job driver as closures |
| Gemini is a special case | It is called through its SDK inside `server.ts`; the other three engines are in `src/providers.ts`; only Gemini has a breaker, a pacer and a call counter |
| The questions put to engines live in two places and differ | `ANSWER_SYSTEM_PROMPT` in `src/providers.ts` says "Search the web"; the Gemini instruction in `server.ts` says "Use live web search"; the report records no version of either |
| The test suite is one shell line | `package.json` `test`: 49 files joined by `&&`, run one after another; 38 test files each define their own `check()`; no timing, no parallel runs, no coverage |
| The branch-status rule cannot be met in a cloud session | `scripts/branch-status.sh` printed "status unknown: shallow clone" on 2026-11-14; cloud sessions start from a shallow clone |
| The hard rules are prose | `.claude/` holds three agents and nothing else: no settings, no hooks, no skills. "Never `git add -A`" and "say the branch status" depend on being remembered |
| Reviews share the author's blind spots | The review agents name no model, so they run on the author's; I-6 already records that this is not independence |
| Build tools are production dependencies | `vite`, `@vitejs/plugin-react`, `@tailwindcss/vite` are in `dependencies`; the server bundle needs only `express`, `pg`, `@google/genai`, `dotenv` |
| Dependency updates are watched for GitHub Actions only | `.github/dependabot.yml`; an npm advisory turned `main` red three times in October (I-22) |
| Nothing checks that the live site runs the merged commit | The live check tests behaviour, not which commit is deployed; Vercel has refused deployments before (I-26) |
| Model ids and their end dates are comments | `src/providers.ts`; the default Gemini model lost free search with no signal (I-36) |
| The records are large and hand-kept | `TECH_DEBT.md` is 1,197 lines with sections out of order; one `docs/PROGRAM.md` table cell is a page long; `CLAUDE.md` is loaded into every session and repeats the test list |

## Group 1: do first (cheap, and every later change is safer for it)

1. **Branch status that works in a shallow clone.** `scripts/branch-status.sh` deepens
   the history it needs (`git fetch --deepen` or `--unshallow` of `origin/main`) or
   says exactly which command would, and `test/branchStatus.test.sh` gains a shallow
   case. Hard rule 1 is unmeetable in cloud sessions until this lands.
2. **Turn the hard rules into machinery** (`.claude/settings.json`): a pre-tool hook
   that refuses `git add -A`, `git add .` and `git commit -a`; a stop hook that runs
   the branch-status script and prints its first line; a session-start hook that
   runs `npm ci`, starts the test PostgreSQL when the programs exist, and prints the
   first action from `docs/PROGRAM.md`. Add a permission allow-list for the
   read-only commands the sessions use constantly. Prove each hook with a script
   test, as `test/branchStatus.test.sh` does.
3. **A `ship` skill** (`.claude/skills/ship/`): the merge gates as one procedure
   (full suite, pull request from the template, wait for CI, `adversarial-reviewer`,
   fixes, `eval-pm`, merge with the hash read from `git rev-parse`, check `main`,
   branch status). Today this is rebuilt from prose every session.
4. **Reviewers on a different model from the author.** Set `model:` in
   `.claude/agents/adversarial-reviewer.md` and `eval-pm.md` so a review is not the
   author's own model re-reading its own work, and record the pairing in
   `docs/ENGINEERING_STANDARDS.md` section 10.
5. **A real test runner, with no new dependency.** `scripts/run-tests.mjs` reads a
   manifest (`test/manifest.json`: file, tier `unit | server | browser | postgres`,
   needs-build) and runs unit files in parallel and server files in a small pool
   (ports are already drawn centrally through `test/ports.ts`; I-17 says two runs in
   one checkout collide, so the build happens once, before anything). It prints a
   per-file timing table and the total check count, keeps going after a failure and
   exits non-zero at the end, and supports `--tier` and `--changed` (only the files
   mapped to what the diff touched). One shared `test/harness.ts` replaces the 38
   copies of `check()` and carries the early-exit guard from I-31. `npm test` calls
   the runner; the commands list in `CLAUDE.md` is generated from the manifest.
6. **CI in parallel under the same required name.** Split `ci.yml` into jobs (lint
   and unit, server suites in two shards, browser, postgres, production install)
   with a final job still named `test` that needs them all, so the ruleset keeps
   working. Cache the Playwright browser. Write the timing table to the job summary.
7. **The live check proves which commit is live.** `/api/health` reports the commit
   it was built from (Vercel provides it at build time); `scripts/smoke.mjs --expect-commit`
   compares it with the head of `main`; the live check fails with a sentence when
   the site is behind.
8. **Dependabot for npm (security updates, grouped, weekly), and build tools moved to
   `devDependencies`.** Confirm the Vercel build and `scripts/prod-install-check.sh`
   still pass; the production audit surface shrinks.
9. **A model calendar the machine reads.** `src/modelCalendar.ts`: for every default
   model id, the date it was last confirmed on the vendor's page, what was confirmed
   (for Gemini: free web search yes or no), and any published end date. A unit test
   fails when an end date is under 30 days away or a confirmation is over 90 days
   old, with the sentence saying which page to re-read. Replaces the comments in
   `src/providers.ts`.

## Group 2: structural (each needs a short design note first, `docs/ENGINEERING_STANDARDS.md`)

1. **Split `server.ts` behind the golden reports.** A composition root that builds
   the parts and hands them to each other: `src/server/app.ts`, `routes/` (auth,
   audit, audits, status), `gemini.ts` (client, pacer, retry), `readiness.ts`,
   `driver.ts`. No behaviour change: the twelve golden reports, the end-to-end
   suites and a new check that the list of routes and their status codes is
   unchanged are the proof (I-18 is the method). Do it in three or four pull
   requests, one seam at a time.
2. **One port for answer engines.** `AnswerEngine { id, describe(), ask(question) }`
   where `describe()` states what the engine is (vendor, exact model, searches or
   not, free or paid, the key variable) and `ask` returns the evidence with its
   `searched` flag. Gemini moves behind it like the others. A registry replaces the
   fixed four-name type and the parallel lists in `src/spendGuard.ts`. Each engine
   gets its own breaker, pacer and call counter. Adding an engine becomes one file
   and one registry line.
3. **Real replies as test fixtures.** The engine probe (`docs/PLAN_2026-11.md` P1)
   saves scrubbed real replies under `test/fixtures/real/`. Every adapter gets a
   contract test against them, and the probe workflow gains a `--compare` mode that
   says when a provider's reply shape has drifted from the saved one.
4. **Check shapes at every trust boundary, then make the compiler strict.** Small
   hand-written guards (or one small schema library, decided in the design note) for
   provider replies, request bodies and JSON read back from the store. Then turn on
   `strictNullChecks`, then `noImplicitAny`, with a ratchet: a file holds the error
   count and CI fails if it rises, so it only goes down.
5. **A prompt registry and `promptVersion`.** Every text sent to an engine lives in
   `src/prompts.ts`, every engine is asked in the same words, and the report records
   `promptVersion` next to `metricVersion`. Changing the wording of a question
   changes what is measured; today nothing records it.
6. **The pacer, breaker and call counter in the shared store** (slice S6 of
   `docs/PLAN_STEP_E.md`). On Vercel every instance starts with empty memory, so the
   breaker forgets a wall it just hit and the daily cap counts one instance.
7. **Property-based tests for `src/analysis.ts`.** It is pure, so state its laws and
   let a generator attack them: named plus cited-only never exceeds usable answers;
   reordering evidence changes nothing; adding a failed look-up never changes a
   numerator; a brand absent from every text is never visible. A seeded generator in
   plain TypeScript is enough; print the seed on failure.
8. **A protections ledger.** `test/protections.json`: each guarantee the product
   makes (one claim per step, the paid-engine refusal, the number guard, the key
   scrubber, the session check) with the exact code change that breaks it and the
   test that must then fail. `scripts/mutate.mjs` applies each in a temporary copy
   and reports any guarantee no test defends. The repository already does this by
   hand in every review; this makes it repeatable and runs it weekly.

## Group 3: bets (larger, or worth trying because nobody else does them)

1. **Evidence is the asset; a report is a view.** Store the raw evidence of every
   audit once, immutable, and derive the report from it with a versioned pure
   analysis. A change to a metric definition then re-scores history honestly, side
   by side, instead of leaving old reports frozen under an old rule.
2. **A methodology lab.** A manually started workflow that asks the same question
   N times and reports how much the answers vary; asks with and without the
   instruction text; and writes the result as a dated note. It measures the
   measurement, which is what turns "an observation" into a defensible range
   (`TECH_DEBT.md` 2.13) and is the product's real difference from trackers.
3. **Smoke-test every pull request's own preview deployment** before merge. All four
   Vercel-only incidents (`TECH_DEBT.md` 1.4a to 1.4c) would have been caught there.
4. **The records as data.** One ledger file per kind (program rows, debt items,
   insights) in a structured format, with `docs/PROGRAM.md` and `TECH_DEBT.md`
   generated from it; a docs check that every file path, pull request number and
   test name mentioned in the docs exists; `CLAUDE.md` cut to an index of about a
   hundred lines that points at the rest.
5. **One typed contract for the API.** The routes, their request and reply types and
   their checks in one module used by the server, the page and the smoke script, so
   the three cannot drift.
6. **Accessibility and weight budgets in the browser suite.** An automated
   accessibility pass on each screen, and a failing check when the page bundle grows
   past a set size.
7. **Replay evaluation of the written analysis.** Run the analysis step over saved
   real evidence and track how many sentences the number guard drops and how many
   claims are unattributable, per model. This is how a cheaper or different writer
   model gets chosen on evidence.
8. **A plain-language weekly digest for the owner.** A scheduled workflow that writes
   one issue: what merged, what the live check saw, what waits on the owner, in the
   words of `docs/OWNER_DIRECTIVES.md` D-9. The owner page of `docs/PROGRAM.md` row 9
   without building a page.
