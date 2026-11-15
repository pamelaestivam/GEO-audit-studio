# Design notes for Group 2 of the engineering backlog (2026-11-15)

One short note per item, in the shape of `docs/ENGINEERING_STANDARDS.md` section 1 (problem, options, chosen, not handled, what breaks and how we would know).
Group 2 item 6 (the pacer, breaker and counter in the shared store) is HELD by `docs/DECISIONS.md` 2026-11-14 and has no note. The owner's rules
apply to all of it: $0 spend, nothing a person sees changes, Sonnet for every agent (`docs/OWNER_DIRECTIVES.md`).

## G1.5b. One shared test harness

**Problem.** 37 test files each define their own `check()` (eight more their own `assert`, `pass` or `fail`). A fix to how a failure is
reported, or the early-exit trap of I-31 (a test that prints FAIL and exits 0), has to be made 45 times; `test/testHarness.test.ts` only scans for the trap.
**Options.** (a) Do nothing: the runner (`scripts/run-tests.mjs`) already counts a printed FAIL line as a failure. (b) A codemod that rewrites all 45 files at once.
(c) `test/harness.ts` exporting `check`, `assert`, `section`, `finish()`; new files use it, old files migrate in batches of about ten, each batch proved by the
unchanged pass counts in the runner's table. **Chosen:** (c). **Not handled:** tests that print their own summary format (a few do); they keep it until migrated.
**Blast radius.** A wrong harness makes tests pass that should fail: `finish()` must exit non-zero when any check failed, proved by a harness test that fails a check on purpose;
each batch must show the same check count before and after.

## G2.1. Split `server.ts` behind the golden reports

**Problem.** `server.ts` is 2,474 lines and one `buildApp()` function that holds the routes, the Gemini client, the pacer, the breaker, readiness and the job driver as closures.
Nothing can be tested or changed without loading all of it.
**Options.** (a) Leave it. (b) A big-bang split. (c) One seam per pull request: `gemini.ts` (client, pacer, retry), `readiness.ts`, `driver.ts`, then `routes/` (auth, audit, audits,
status), with a composition root `src/server/app.ts` handing the parts to each other. **Chosen:** (c), cheapest seam first. **Proof of no behaviour change:** before the first seam,
capture (1) the twelve golden reports, (2) a list of every route with its method and the status it answers for a fixed set of requests (a new `test/routes.test.ts`, written and merged
BEFORE any move, against the unmodified server), (3) the full runner table; after each seam all three must be identical. **Not handled:** closures that share mutable state across
seams (the breaker and pacer are shared by `gemini.ts` and `driver.ts`): those get passed as one object, never duplicated. **Blast radius.** The live product; the golden reports
and the routes test are the alarm. A seam that cannot be proved unchanged is not merged.

## G2.2. One port for answer engines

**Problem.** Gemini is called through its SDK inside `server.ts`; the other three are in `src/providers.ts`. Only Gemini has a breaker, a pacer and a call counter, and the list
of engines is a fixed four-name type repeated in `src/spendGuard.ts`.
**Options.** (a) Leave it (three engines are off by the owner's decision). (b) An `AnswerEngine` interface (`id`, `describe()` stating vendor, exact model, whether it searches, free or paid;
`ask(question)` returning evidence with its `searched` flag) behind a registry, Gemini moved behind it last. **Chosen:** (b), after G2.1's `gemini.ts` seam exists. **Not handled:**
per-engine breakers and counters for the three off engines beyond the interface (they stay unused until paid engines are allowed). **Blast radius.** The Gemini path: the quota-breaker,
efficiency and retry-spend end-to-end suites count real calls and must stay green with the same counts.

## G2.3. Real replies as test fixtures

**Problem.** The adapters are tested against replies written by hand from vendor documentation. The engine probe (`scripts/engine-probe.mjs`) is meant to save scrubbed real replies,
but it has never run with a key (`docs/PROGRAM.md` O-8), so there are none.
**Options.** (a) Invent fixtures: no, that is the failure this repository is built against. (b) Wait for real replies, build only the mechanism. **Chosen:** (b): `test/fixtures/real/` with
a README that says it is empty until the probe has a key; a contract test that runs every fixture found there through its adapter and passes (vacuously, said so in its output) when none exist; a
`--compare` mode of the probe is NOT built until there is a saved reply to compare with. **Blast radius.** None until fixtures exist; the test prints "0 real fixtures: not measured".

## G2.4. Check shapes at every trust boundary, then a stricter compiler

**Problem.** `tsconfig.json` is not strict and about 140 `any` sit in `server.ts` and `src/`; provider replies, request bodies and JSON read back from the store are trusted by cast.
**Options.** (a) Turn on `strict` at once (hundreds of errors, one enormous change). (b) Hand-written guards at each boundary, then `strictNullChecks`, then `noImplicitAny`, with a ratchet:
a file holds the compiler's error count and CI fails when it rises. **Chosen:** (b), no schema library (a production dependency needs the owner's yes). The ratchet comes FIRST (it
makes every later step safe), then the guards, then the flags one at a time. **Not handled:** `any` inside tests. **Blast radius.** A wrong guard rejects a real reply as malformed:
each guard is tested on the real shapes the existing suites use, and a rejection is a failed look-up with a sentence, never a crash.

## G2.5. A prompt registry and `promptVersion`

**Problem.** The words put to each engine live in two places and differ (`ANSWER_SYSTEM_PROMPT` in `src/providers.ts` says "Search the web"; the Gemini instruction in `server.ts` says "Use live
web search"), and a report records no version of them, so a change of wording silently changes what is measured. **Chosen:** every text sent to an engine in `src/prompts.ts`, every engine asked in the same words,
a `promptVersion` recorded in the report next to `metricVersion`. **This changes what is recorded in a report**, so the pull request says so in its first line, the golden reports are
updated on purpose (`UPDATE_GOLDEN=1`) with the diff read, and old reports show "prompt version not recorded". **Not handled:** the questions themselves (the standard queries) stay in `src/queries.ts`.
**Blast radius.** What Gemini is asked: the wording is unified to the one that is in use today for Gemini (the only engine in use), so the measurement does not move; the two off engines move to it.

## G2.7. Property-based tests for the analysis

**Problem.** `src/analysis.ts` is pure and carries every headline number, but it is tested on hand-picked examples; the bugs that shipped there came from inputs nobody listed (unicode, punctuation,
empty text). **Chosen:** state its laws and attack them with a seeded generator in plain TypeScript (no library): visibility never exceeds 100 and `timesMentioned` never exceeds the queries; a
brand absent from every text is never mentioned; ranks in one answer are 1..k in order of first appearance; reordering the queries changes no scorecard; appending an empty answer never changes a
numerator; composed and decomposed accents give the same result; cited-only implies not mentioned. The seed is printed on every failure and can be passed back in (`PROP_SEED`). **Not handled:**
shrinking (the failing case is printed whole). **Blast radius.** None on the product; a flaky property is a finding about the code or the law, never a retry.

## G2.8. A protections ledger

**Problem.** The product makes guarantees (one claim per step, the paid-engine refusal, the number guard, the key scrubber, the session check). Each review proves them by hand by breaking the code and
watching a test fail; nothing repeats that, so a test can quietly stop defending a guarantee. **Chosen:** `test/protections.json`: for each guarantee, the exact code change that breaks it (a find-and-
replace on one file) and the test file that must then fail; `scripts/mutate.mjs` copies the repository to a temporary directory, applies each change there, runs only the named test, and reports any
guarantee whose test still passes (undefended) or whose change no longer applies (stale ledger). Run by hand and weekly in a workflow. **Not handled:** finding guarantees nobody wrote down; the
ledger is only as complete as its author. **Blast radius.** None on the product (it works in a temporary copy and never touches the repository); a red weekly run is the alarm.
