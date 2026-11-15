#!/usr/bin/env bash
# The two review seats must pin a real model that is not the author's (docs/ENGINEERING_STANDARDS.md section 10).
# The front matter must start on line 1, hold exactly one model line, and the value is normalised (case, quotes, comments,
# trailing spaces, CR) before it is judged. `inherit` and anything containing the author's model name are refused.
#   bash test/reviewAgents.test.sh
set -u
repo="${REVIEW_AGENTS_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"; failures=0
author_model=sonnet   # the model sessions author on; reviewers must differ (change here and in the standards together)
fail(){ echo "FAIL  $1"; failures=$((failures+1)); }
for a in adversarial-reviewer eval-pm; do
  f="$repo/.claude/agents/$a.md"
  [ "$(head -1 "$f" | tr -d '\r')" = "---" ] || { fail "$a: front matter does not start on line 1"; continue; }
  fm=$(awk 'NR==1{next} /^---\r?$/ {exit} {print}' "$f")
  n=$(printf '%s\n' "$fm" | grep -c '^model:')
  [ "$n" = "1" ] || { fail "$a: $n model lines in the front matter (need exactly 1)"; continue; }
  m=$(printf '%s\n' "$fm" | grep '^model:' | sed 's/^model:[[:space:]]*//; s/[[:space:]]*#.*$//; s/\r$//; s/[[:space:]]*$//; s/^["\x27]//; s/["\x27]$//' | tr 'A-Z' 'a-z')
  case "$m" in
    "") fail "$a pins no model" ;;
    inherit) fail "$a pins inherit, which runs the reviewer on the author's model" ;;
    *"$author_model"*) fail "$a pins $m, the author's model" ;;
    opus|haiku|claude-*) echo "pass  $a pins $m (the author is on $author_model)" ;;
    *) fail "$a pins '$m', which is not a known model name" ;;
  esac
done
grep -q "Reviewers run on a different model from the author" "$repo/docs/ENGINEERING_STANDARDS.md" && echo "pass  the standards record the pairing" || fail "the standards do not record the pairing"
[ "$failures" = "0" ] && { echo; echo "All review-agent checks passed."; exit 0; } || { echo; echo "$failures check(s) failed."; exit 1; }
