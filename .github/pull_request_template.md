<!-- Fill every section. "N/A" needs a reason. Delete nothing. -->

## What changed and why
<!-- The root cause, not the diff. What was true before that should not have been? -->

## How it was verified
<!-- Commands you ran and what they printed. For a fix: the failure reproduced BEFORE, the same check passing AFTER. -->
- [ ] `npm run lint`
- [ ] `npm test` (counts: ___ checks, all pass)
- [ ] The new/changed tests were shown to FAIL when the code is broken on purpose (what I broke: ___)
- [ ] UI-visible change: looked at the real screens at desktop and phone width (screenshots or `ux-tourist` report)
- [ ] Deploy-affecting change: `node scripts/smoke.mjs` against a running build

## What was NOT verified
<!-- Be specific. "Nothing" is almost never true. Real engines? A real host? A phone? -->

## Adversarial review
- [ ] Self-review against `docs/ENGINEERING_STANDARDS.md` §5
- [ ] Independent review (`adversarial-reviewer`): verdict ___ ; CONFIRMED findings fixed: ___ ; remaining: ___

## EVAL PM
Groundedness ___/5 · Completeness ___/5 · Relevance ___/5 → ___/100 → SHIP / REVISE / REJECT

## Records
- [ ] `TECH_DEBT.md` updated for anything knowingly left imperfect
- [ ] `docs/DECISIONS.md` entry if a decision was made
- [ ] Docs updated if behaviour or configuration changed

## Risk and rollback
<!-- What breaks if this is wrong, how would we know, how do we undo it? Does merging change what the live site does (new required env vars, new auth rules)? -->
