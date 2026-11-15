#!/usr/bin/env bash
# The ship skill (.claude/skills/ship/SKILL.md) is only useful if it stays true: it must have valid front matter, name every merge gate in
# order, and point only at files and scripts that exist. A gate deleted from it, or a renamed script it still names, fails here.
#   bash test/shipSkill.test.sh
set -u
repo="$(cd "$(dirname "$0")/.." && pwd)"; f="$repo/.claude/skills/ship/SKILL.md"; failures=0
ok(){ echo "pass  $1"; }; bad(){ echo "FAIL  $1"; failures=$((failures+1)); }
[ -f "$f" ] && ok "the skill exists" || { bad "the skill is missing"; exit 1; }
head -1 "$f" | grep -q '^---$' && grep -q '^name: ship$' "$f" && grep -q '^description: .\{40,\}' "$f" && ok "front matter has name and description" || bad "front matter"
last=0
for g in 'npm run verify' 'pull_request_template.md' '## 3. CI' 'adversarial-reviewer' 'eval-pm' 'git rev-parse HEAD' 'merge commit' 'branch-status.sh'; do
  n=$(grep -n -F -- "$g" "$f" | head -1 | cut -d: -f1)
  if [ -n "$n" ] && [ "$n" -ge "$last" ]; then ok "gate named in order: $g"; last=$n; else bad "gate missing or out of order: $g"; fi
done
for p in $(grep -o '`[A-Za-z0-9_./-]*\.\(md\|sh\|ts\|yml\|json\)`' "$f" | tr -d '`' | sort -u); do
  case "$p" in .claude/settings.json) ;; esac
  if [ -e "$repo/$p" ]; then ok "points at a file that exists: $p"; else bad "points at a missing file: $p"; fi
done
grep -q 'never `git add -A`' "$f" && ok "carries the explicit-staging rule" || bad "explicit-staging rule missing"
[ "$failures" = "0" ] && { echo; echo "All ship-skill checks passed."; exit 0; } || { echo; echo "$failures check(s) failed."; exit 1; }
