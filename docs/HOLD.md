# HOLD: the program is paused until the owner says "resume"

**Status: ON HOLD.** The owner asked on 2026-10-11 for "a well rounded place to hold on for a moment", with
nothing broken or lost, and said they will ask to resume. This file was written into the repo on 2026-10-13 so a
session that starts cold (or a different one) knows. Delete this file, or change this line to `RESUMED <date>`,
in the same change that resumes the work.

## What a session does while this says ON HOLD

- Read, answer questions, and keep records true. Do **not** start new development, open new feature PRs, push to
  `claude/gemini-call-timeout`, or merge PR #53.
- Do **not** re-enable the hourly routine `trig_015EVqEooFHDy9HVc3KkL31j` (disabled 2026-10-11). Its stored prompt says
  "finish any open PR and merge it" and knows nothing about this hold, so turning it on would restart the work.
  Check with `list_triggers` or `get_trigger` that `enabled` is `false`.
- The session unsubscribed from PR #53 events on 2026-10-11 (said in the handoff comment on #53). Nothing is watching it, so a review or CI result arriving there will not wake anyone.

## The live site (link and what is true about it)

**https://geo-audit-studio-five.vercel.app/**

- It loaded and its API answered on 2026-10-10 (live-check run
  https://github.com/pamelaestivam/GEO-audit-studio/actions/runs/38033024298, read from the Actions page).
- It cannot run a real audit yet: production has no engine key and no sign-in configuration (issue #36; owner
  actions O-2 and O-3 in `docs/PROGRAM.md` section 3). The daily live check was red for that reason on 2026-10-10, which was correct; the days since were not read.
- Not verified from here: this workspace cannot reach `vercel.app`, so the page itself has not been opened by the
  assistant. Whether the newest `main` (97a3adc) is the Production deployment was not read; `64bc0ae` showed a
  success status at 2026-10-10 23:21 UTC.

## The state at the hold (read from GitHub on 2026-10-13; check again, it may have moved)

| Thing | State |
|---|---|
| `main` | 97a3adc (PRs #49, #50, #51, #52 merged). Nothing else in flight on `main`. |
| PR #53 `claude/gemini-call-timeout` | open, head `4de2888d5ed194e3ab45c83371e5f4dfd08418b8`, 6 commits, **held on purpose**. Gives each Gemini request a time limit (`GEMINI_HTTP_TIMEOUT_MS`, default 90 s) so one request that never answers cannot hold every later call behind it for about five minutes. |
| CI on `4de2888` | `test` **success** (run https://github.com/pamelaestivam/GEO-audit-studio/actions/runs/38108163393) and `docker` success. The Vercel preview is refused by the free plan's 100-deployments-a-day cap (TECH_DEBT 2.16); CI `test` is the gate. |
| Adversarial review | earlier rounds found real issues, all fixed; the last round said OK TO MERGE (one nit, fixed). That review read an earlier head, not `4de2888`. |
| EVAL PM | **SHIP 93 on `f234e9d`**, not on `4de2888`. A score belongs to one commit. `4de2888` only tightens the 504 pattern in `src/errors.ts` and its tests. |

## Resume checklist (do these in order; each is executable with no memory of the conversation)

**Only after the owner has said "resume" in a message. Until then none of this is to be run, and #53 is not to be merged.**

1. In `/home/user/GEO-audit-studio` run `git remote get-url origin`; it must print
   `https://github.com/pamelaestivam/GEO-audit-studio`. If not, stop and ask the owner to authorise the repair
   (`docs/PROGRAM.md` top, I-13, I-14).
2. `git fetch origin`; read the head of PR #53 (it must still be `4de2888`, or you are reviewing something new) and the
   CI `test` result on that head. If it is red with a start-up error, read the log for `bad port` and the printed server
   output before anything else; re-run once only if the failure is not this PR's.
3. Run a fresh-context adversarial review of the whole PR diff (agent works only in `git init` inside `mktemp -d`;
   afterwards check `git remote get-url origin` and `git log origin/main..main`), and an EVAL PM score **on the head
   being merged**. If main has moved, merge main into the branch first (expect trivial conflicts at the end of
   `docs/INSIGHTS.md`, `docs/SESSION_LOG.md` and in `docs/PROGRAM.md`, because this record also edits them: keep both
   sides; #53 adds insight I-22, which must sit before I-23 here) and re-run CI.
4. Two optional flags from the last EVAL PM, for the owner or session to take or decline: (a) the clause
   `deadline_exceeded` in `src/errors.ts` has no test of its own, because every test string also contains 504; add a
   case with a bare `DEADLINE_EXCEEDED` or drop the clause; (b) read the PR body once to confirm it repeats the
   corrected claims (about 5 minutes held per attempt before, 90 s after; "not forever").
5. Merge #53 as a merge commit pinned to the real head sha (`git rev-parse`, never typed from memory).
6. Next roadmap rows, in order: the cheap readiness check for a hung audit nobody reads (TECH_DEBT entry "hung audit
   nobody reads"), then S7 (stalled / Resume / Discard in the UI and the extra job fields on `GET /api/audit/job/:id`;
   `docs/PLAN_STEP_E.md`), then row 9's remaining page for the owner. Then re-enable the routine only if the owner asks.

## Owner-only actions still open (unchanged by the hold; `docs/PROGRAM.md` section 3 has the steps)

O-1 let the workspace reach the web; O-2 a free Gemini key; O-3 Vercel environment values, two live-check secrets, and
confirm the Production deployment is Ready (and set `maxDuration` if a step nears 300 s); O-4 Supabase (row 8); O-5 turn
on "Automatically delete head branches" (about 26 merged remote branches are stale; the session cannot delete them).

## Not proven (do not state these as fact)

That every red end-to-end run on 2026-10-10 drew a bad port (the logs did not print ports); that 90 s is the right
default against the real provider (a judgement, grounded answers normally take well under 30 s); that Google enforces
the `X-Server-Timeout` header; Chromium's own blocked-port list for the browser suites; and anything about the live
site that needs a signed-in session.

## Loose ends in the assistant's scratch space (not in the repo; safe to ignore)

Worktrees under the session scratchpad (`wtT` is the #53 branch and holds a helper `node_modules` link that must never
be staged; `wtQ`, `wtX`, `wtZ` are merged and stale). They do not survive the container. Everything that matters is in
git.
