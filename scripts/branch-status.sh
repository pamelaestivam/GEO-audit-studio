#!/usr/bin/env bash
# One-line branch status for the end of every reply that touched the repo, derived
# from real git state (never from memory of what the plan was). Also lists merged
# remote branches that were never deleted: a stale branch is work nobody can see.
#
#   bash scripts/branch-status.sh
#
# First line (this is what goes at the end of the reply):
#   Branch: claude/x | 3 commit(s) ahead of main, pushed | NOT merged (3 commit(s) not on main yet)
#   Branch: claude/x | 3 commit(s) ahead of main, pushed | MERGED (merge commit abc1234 is on main)
#   Branch: claude/x | 0 commit(s) ahead of main, pushed | no commits of its own yet (nothing to merge)
#   Branch: main | up to date with origin/main (abc1234) | nothing in flight
#   Branch: (detached HEAD at abc1234) | ...
# Second line, only when some exist:
#   Stale: N merged remote branch(es) not deleted: a, b (...)
#
# How "merged" is decided: a branch is merged when its tip is a parent of a MERGE
# COMMIT on main (the way this repository merges pull requests). Squash or rebase
# merges leave no such commit, so they show as NOT merged / not stale: do not use
# them here, or check the pull request by hand. The script cannot see pull
# requests or CI (no GitHub access from a script): if a PR is open or CI is red,
# add that to the first line yourself.
#
# Overrides, for tests: STATUS_BASE (default origin/main).
set -u

base_ref="${STATUS_BASE:-origin/main}"
remote="${base_ref%%/*}"
base_branch="${base_ref#*/}"

fetch_note=""
if ! git fetch -q "$remote" 2>/dev/null; then
  echo "warning: could not fetch $remote; the status below may be stale" >&2
  fetch_note=" | (fetch failed: may be stale)"
fi

if ! git rev-parse --verify -q "$base_ref" >/dev/null; then
  echo "Branch: unknown | cannot read $base_ref (is the remote reachable, and is 'origin' a real GitHub URL?) | status unknown"
  exit 1
fi

# "<parent-of-a-merge> <merge-commit>" for every second-or-later parent of a merge on the base.
merge_map=$(git log "$base_ref" --merges --format='%h %P' | awk '{ for (i = 3; i <= NF; i++) print $i, $1 }')
merge_commit_for() { printf '%s\n' "$merge_map" | awk -v t="$1" '$1 == t { print $2; exit }'; }

full=$(git rev-parse HEAD)
head=$(git rev-parse --short HEAD)
branch=$(git symbolic-ref -q --short HEAD || true)
dirty=$(git status --porcelain | grep -v '^??' | wc -l | tr -d ' ')
untracked=$(git status --porcelain | grep -c '^??' || true)
extra=""
[ "$dirty" != "0" ] && extra=" | $dirty uncommitted change(s)"
[ "$untracked" != "0" ] && extra="$extra | $untracked untracked file(s)"

if [ "$branch" = "$base_branch" ]; then
  behind=$(git rev-list --count HEAD.."$base_ref")
  ahead=$(git rev-list --count "$base_ref"..HEAD)
  if [ "$ahead" = "0" ] && [ "$behind" = "0" ]; then
    echo "Branch: $base_branch | up to date with $base_ref ($head) | nothing in flight$extra$fetch_note"
  else
    echo "Branch: $base_branch | $ahead ahead, $behind behind $base_ref ($head) | local $base_branch differs from the remote$extra$fetch_note"
  fi
else
  ahead=$(git rev-list --count "$base_ref"..HEAD)
  if [ -n "$branch" ]; then name="$branch"; else name="(detached HEAD at $head)"; fi

  mc=$(merge_commit_for "$full")
  if [ -n "$mc" ]; then
    merged="MERGED (merge commit $mc is on $base_branch)"
  elif [ "$ahead" = "0" ]; then
    merged="no commits of its own yet (nothing to merge)"
  else
    merged="NOT merged ($ahead commit(s) not on $base_branch yet)"
  fi

  if [ -z "$branch" ]; then
    pushed="not on a branch"
  elif git rev-parse --verify -q "$remote/$branch" >/dev/null; then
    unpushed=$(git rev-list --count "$remote/$branch"..HEAD)
    if [ "$unpushed" = "0" ]; then pushed="pushed"; else pushed="$unpushed commit(s) NOT pushed"; fi
  elif [ -n "$mc" ]; then
    pushed="remote branch already deleted"
  else
    pushed="not pushed (no remote branch)"
  fi
  echo "Branch: $name | $ahead commit(s) ahead of $base_branch, $pushed | $merged$extra$fetch_note"
fi

# Merged remote branches that still exist (never deleted). A branch with no commits
# of its own, or one merged by squash/rebase, is not listed (see the note above).
stale=""
n=0
while IFS= read -r ref; do
  short="${ref#"$remote"/}"
  [ "$short" = "HEAD" ] || [ "$short" = "$base_branch" ] && continue
  tip=$(git rev-parse "$ref")
  if [ -n "$(merge_commit_for "$tip")" ]; then
    stale="${stale:+$stale, }$short"
    n=$((n + 1))
  fi
done < <(git for-each-ref --format='%(refname:short)' "refs/remotes/$remote/")
if [ "$n" -gt 0 ]; then
  echo "Stale: $n merged remote branch(es) not deleted: $stale (turn on GitHub's 'Automatically delete head branches'; the session cannot delete them: HTTP 403)"
fi
