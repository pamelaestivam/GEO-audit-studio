#!/usr/bin/env bash
# The owner's rule (docs/OWNER_DIRECTIVES.md D-11): every agent runs on Sonnet. The two review seats must pin exactly `sonnet` in a
# front matter that starts on line 1, is closed, and holds exactly one model line; the value is normalised (case, quotes, comments,
# trailing spaces, CR) before it is judged, so `inherit`, `opus`, `"Sonnet-x"` and a missing line all fail.
#   bash test/reviewAgents.test.sh
set -u
repo="${REVIEW_AGENTS_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"; failures=0
fail(){ echo "FAIL  $1"; failures=$((failures+1)); }
for a in adversarial-reviewer eval-pm ux-tourist; do
  f="$repo/.claude/agents/$a.md"
  [ -f "$f" ] || { fail "$a: the agent file is missing"; continue; }
  [ "$(head -1 "$f" | tr -d '\r')" = "---" ] || { fail "$a: front matter does not start on line 1"; continue; }
  awk 'NR>1 && /^---\r?$/ {f=1} END{exit !f}' "$f" || { fail "$a: front matter is never closed"; continue; }
  fm=$(awk 'NR==1{next} /^---\r?$/ {exit} {print}' "$f")
  n=$(printf '%s\n' "$fm" | grep -c '^model:')
  [ "$n" = "1" ] || { fail "$a: $n model lines in the front matter (need exactly 1)"; continue; }
  m=$(printf '%s\n' "$fm" | grep '^model:' | sed 's/^model:[[:space:]]*//; s/[[:space:]]*#.*$//; s/\r$//; s/[[:space:]]*$//; s/^["\x27]//; s/["\x27]$//' | tr 'A-Z' 'a-z')
  if [ "$m" = "sonnet" ]; then echo "pass  $a pins sonnet (the owner's rule)"; else fail "$a pins '$m', the owner's rule is sonnet"; fi
done
grep -q "Every agent runs on Sonnet" "$repo/docs/ENGINEERING_STANDARDS.md" && echo "pass  the standards record the rule" || fail "the standards do not record the rule"
[ "$failures" = "0" ] && { echo; echo "All review-agent checks passed."; exit 0; } || { echo; echo "$failures check(s) failed."; exit 1; }
