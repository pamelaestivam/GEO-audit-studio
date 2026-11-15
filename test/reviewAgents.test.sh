#!/usr/bin/env bash
# The two review seats must pin a model, and not the model the standards name as the author's (docs/ENGINEERING_STANDARDS.md section 10).
#   bash test/reviewAgents.test.sh
set -u
repo="$(cd "$(dirname "$0")/.." && pwd)"; failures=0
author_model=sonnet   # the session model that authors changes; reviewers must differ (change here and in the standards together)
for a in adversarial-reviewer eval-pm; do
  f="$repo/.claude/agents/$a.md"
  m=$(sed -n '1,/^---$/{/^model:/p}' "$f" | head -1 | sed 's/^model: *//')
  [ -z "$m" ] && m=$(awk 'NR>1 && /^---$/ {exit} /^model:/ {sub(/^model: */,""); print}' "$f")
  if [ -z "$m" ]; then echo "FAIL  $a pins no model"; failures=$((failures+1))
  elif [ "$m" = "$author_model" ]; then echo "FAIL  $a pins $m, the author's model"; failures=$((failures+1))
  else echo "pass  $a pins $m (the author is on $author_model)"; fi
done
grep -q "Reviewers run on a different model from the author" "$repo/docs/ENGINEERING_STANDARDS.md" && echo "pass  the standards record the pairing" || { echo "FAIL  the standards do not record the pairing"; failures=$((failures+1)); }
[ "$failures" = "0" ] && { echo; echo "All review-agent checks passed."; exit 0; } || { echo; echo "$failures check(s) failed."; exit 1; }
