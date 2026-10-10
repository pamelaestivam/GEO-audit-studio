#!/usr/bin/env bash
# Exercises scripts/branch-status.sh in a THROWAWAY repository (a bare "origin" and a
# working clone created under mktemp -d). It never touches the repository it lives in.
#
#   bash test/branchStatus.test.sh
set -u
script="$(cd "$(dirname "$0")/.." && pwd)/scripts/branch-status.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
failures=0

check() { # name, haystack, needle
  if printf '%s' "$2" | grep -qF -- "$3"; then echo "pass  $1"; else echo "FAIL  $1"; echo "        wanted: $3"; echo "        got:    $2"; failures=$((failures + 1)); fi
}
absent() { # name, haystack, needle
  if printf '%s' "$2" | grep -qF -- "$3"; then echo "FAIL  $1"; echo "        did not want: $3"; echo "        got:    $2"; failures=$((failures + 1)); else echo "pass  $1"; fi
}
g() { git -C "$tmp/work" -c user.name=t -c user.email=t@t "$@"; }
status() { (cd "$tmp/work" && bash "$script" 2>/dev/null); }

git init -q --bare "$tmp/origin.git"
git init -q -b main "$tmp/work"
g commit -q --allow-empty -m "first"
g remote add origin "$tmp/origin.git"
g push -q origin main
g fetch -q origin

out=$(status)
check "main, nothing in flight" "$out" "Branch: main | up to date with origin/main"
check "...and says nothing in flight" "$out" "nothing in flight"
absent "...and no stale line when nothing is merged" "$out" "Stale:"

g checkout -q -b claude/feature
out=$(status)
check "a new branch with no commits is not reported merged" "$out" "no commits of its own yet (nothing to merge)"
absent "...and is never called MERGED" "$out" "MERGED"

g commit -q --allow-empty -m "work"
out=$(status)
check "a branch with a local commit is NOT merged" "$out" "NOT merged (1 commit(s) not on main yet)"
check "...and says it is not pushed" "$out" "not pushed (no remote branch)"

g push -q origin claude/feature
g fetch -q origin
out=$(status)
check "pushed but unmerged" "$out" "1 commit(s) ahead of main, pushed | NOT merged"
absent "...an unmerged branch is not stale" "$out" "Stale:"

echo x > "$tmp/work/f.txt"
out=$(status)
check "an untracked file is counted" "$out" "1 untracked file(s)"
g add f.txt
out=$(status)
check "an uncommitted change is counted" "$out" "1 uncommitted change(s)"
g commit -q -m "add f"
g push -q origin claude/feature

# Merge it into main with a merge commit (the way pull requests are merged here).
g checkout -q main
g merge -q --no-ff -m "Merge pull request #1" claude/feature
g push -q origin main
g checkout -q claude/feature
g fetch -q origin
out=$(status)
check "after the merge the branch reads MERGED" "$out" "MERGED (merge commit"
absent "...not 'nothing to merge'" "$out" "nothing to merge"
check "...and the merged branch that still exists on the remote is listed as stale" "$out" "Stale: 1 merged remote branch(es) not deleted: claude/feature"

# A fresh branch cut from main is NOT stale and NOT merged.
g checkout -q main
g checkout -q -b claude/fresh
g push -q origin claude/fresh
g fetch -q origin
out=$(status)
check "a fresh branch with no commits of its own" "$out" "no commits of its own yet"
absent "...is not listed as stale itself" "$(printf '%s\n' "$out" | grep '^Stale:')" "claude/fresh"
check "...while the really merged one still is" "$out" "claude/feature"

# Deleting the merged branch on the remote clears the stale line.
git -C "$tmp/origin.git" branch -q -D claude/feature
g fetch -q --prune origin
out=$(status)
absent "after the remote branch is deleted there is no stale line for it" "$out" "claude/feature"

# A sync merge (main merged INTO a feature branch) must not make a new branch cut from
# that main commit read as merged: the sync merge is not on main's first-parent line.
g checkout -q main
g checkout -q -b claude/syncer
g commit -q --allow-empty -m "syncer work"
g checkout -q main
g commit -q --allow-empty -m "main moves on"
g push -q origin main
g fetch -q origin
g checkout -q claude/syncer
g merge -q --no-ff -m "Merge main into syncer" main
# ...and the feature branch is then merged to main, so the sync merge is in main's history.
g checkout -q main
g merge -q --no-ff -m "Merge pull request #2" claude/syncer
g push -q origin main
g fetch -q origin
g checkout -q -b claude/cut-from-main-tip main~1
out=$(status)
check "a branch cut at a main commit that a sync merge brought in is not merged" "$out" "no commits of its own yet"
absent "...and is not called MERGED" "$out" "MERGED"

# Main behind and ahead.
g checkout -q main
g commit -q --allow-empty -m "local only"
out=$(status)
check "local main ahead of origin/main is flagged" "$out" "1 ahead, 0 behind origin/main"

# Detached HEAD.
g checkout -q --detach
out=$(status)
check "a detached HEAD is named as such, not as 'HEAD'" "$out" "Branch: (detached HEAD at"
absent "...and is not called a branch called HEAD" "$out" "Branch: HEAD"

# The base cannot be read.
g checkout -q main
out=$(cd "$tmp/work" && STATUS_BASE=origin/does-not-exist bash "$script" 2>/dev/null)
rc=$?
check "an unreadable base says the status is unknown" "$out" "status unknown"
if [ "$rc" = "0" ]; then echo "FAIL  an unreadable base must exit non-zero"; failures=$((failures + 1)); else echo "pass  ...and exits non-zero"; fi

if [ "$failures" = "0" ]; then echo; echo "All branch-status checks passed."; exit 0; else echo; echo "$failures check(s) failed."; exit 1; fi
