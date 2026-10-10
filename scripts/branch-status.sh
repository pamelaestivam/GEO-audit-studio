#!/usr/bin/env bash
# One-line branch status for the end of every reply that touched the repo, derived
# from real git state (never from memory of what the plan was). Also lists merged
# remote branches that were never deleted: a stale branch is work nobody can see.
#
#   bash scripts/branch-status.sh
#
# Output (the first line is what goes at the end of the reply):
#   Branch: claude/x | 3 commits ahead of main, pushed | NOT merged (not on main yet)
#   Branch: claude/x | 3 commits ahead of main, pushed | MERGED (abc1234 is on main)
#   Branch: main | up to date with origin/main (abc1234) | nothing in flight
# Then, if any exist:
#   Stale: N merged remote branch(es) not deleted: a, b (turn on GitHub's
#   "Automatically delete head branches"; the session cannot delete them: HTTP 403)
#
# It cannot see pull requests (no GitHub access from a script): if a PR is open or
# CI is red, add that to the first line yourself.
set -u
git fetch -q origin 2>/dev/null || echo "warning: could not fetch origin; the status below may be stale" >&2

branch=$(git rev-parse --abbrev-ref HEAD)
head=$(git rev-parse --short HEAD)
base="origin/main"
dirty=$(git status --porcelain | grep -v '^??' | wc -l | tr -d ' ')
untracked=$(git status --porcelain | grep -c '^??' || true)
extra=""
[ "$dirty" != "0" ] && extra=" | $dirty uncommitted change(s)"
[ "$untracked" != "0" ] && extra="$extra | $untracked untracked file(s)"

if [ "$branch" = "main" ]; then
  behind=$(git rev-list --count HEAD..$base 2>/dev/null || echo "?")
  ahead=$(git rev-list --count $base..HEAD 2>/dev/null || echo "?")
  if [ "$ahead" = "0" ] && [ "$behind" = "0" ]; then
    echo "Branch: main | up to date with origin/main ($head) | nothing in flight$extra"
  else
    echo "Branch: main | $ahead ahead, $behind behind origin/main ($head) | local main differs from the remote$extra"
  fi
else
  ahead=$(git rev-list --count $base..HEAD 2>/dev/null || echo "?")
  if git rev-parse --verify -q "origin/$branch" >/dev/null; then
    unpushed=$(git rev-list --count "origin/$branch"..HEAD)
    if [ "$unpushed" = "0" ]; then pushed="pushed"; else pushed="$unpushed commit(s) NOT pushed"; fi
  else
    pushed="not pushed (no remote branch)"
  fi
  if [ "$ahead" = "0" ]; then
    merged="no commits of its own yet (nothing to merge)"
  elif git merge-base --is-ancestor HEAD $base 2>/dev/null; then
    merged="MERGED ($head is on main)"
  else
    merged="NOT merged ($ahead commit(s) not on main yet)"
  fi
  echo "Branch: $branch | $ahead commit(s) ahead of main, $pushed | $merged$extra"
fi

stale=$(git branch -r --merged $base 2>/dev/null | sed 's/^ *//' | grep -v -E '^origin/(main|HEAD)' | sed 's#^origin/##' | tr '\n' ',' | sed 's/,$//; s/,/, /g')
if [ -n "$stale" ]; then
  n=$(echo "$stale" | tr ',' '\n' | wc -l | tr -d ' ')
  echo "Stale: $n merged remote branch(es) not deleted: $stale (turn on GitHub's 'Automatically delete head branches'; the session cannot delete them: HTTP 403)"
fi
