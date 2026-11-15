#!/usr/bin/env bash
# The ship skill (.claude/skills/ship/SKILL.md) is only useful if it stays true: it must have valid front matter, name every merge gate in
# order, keep its safety sentences, and point only at files, scripts, npm scripts and agents that exist. It checks keywords, exact
# sentences and names, not the meaning of the prose: a rewording that keeps every sentence and still changes the procedure is a
# review matter, which is why the pull request that changes this file is reviewed.
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
  if [ -e "$repo/$p" ]; then ok "points at a file that exists: $p"; else bad "points at a missing file: $p"; fi
done
# the safety sentences themselves, not only keywords: weakening one fails here
for sentence in 'Merge as a **merge commit** (not squash, not rebase' 'Only **SHIP** merges' 'Not green means not merged' 'Never type a hash from memory' 'git add -A`, `git add .` or `git commit -a`' 'is restarted from the start, never accepted as final' 'a red gate twice for the same cause means stop and report' 'stop and report**; do not look for a variation' 'with the same read-only briefing' 'shows `test` green' 'a red `main` is a stop-the-line event' 'first line LAST in the reply' "waits for the owner's yes" 'briefed read-only: it may experiment only in a `git init` inside `mktemp -d`' 'Run the `eval-pm` agent on the pull request' 'git remote get-url origin` must be the github.com URL' 'report it to the owner every time' 'Stop at the first red step'; do
  grep -q -F -- "$sentence" "$f" && ok "keeps: $sentence" || bad "weakened or removed: $sentence"
done
# front matter is closed (a skill with broken front matter does not load)
[ "$(awk 'NR>1 && /^---$/ {print NR; exit}' "$f")" -gt 2 ] && [ "$(awk 'NR>1 && /^---$/ {print NR; exit}' "$f")" -lt 8 ] 2>/dev/null && ok "front matter is closed" || bad "front matter is not closed"
# every npm script, agent and script it names exists
for n in $(grep -o 'npm run [a-z:-]*' "$f" | awk '{print $3}' | sort -u); do node -e 'process.exit(require(process.argv[1]+"/package.json").scripts[process.argv[2]]?0:1)' "$repo" "$n" && ok "npm script exists: $n" || bad "npm script missing: $n"; done
for a in $(grep -o '`[a-z-]*` agent' "$f" | tr -d '` ' | sed 's/agent$//' | sort -u); do [ -f "$repo/.claude/agents/$a.md" ] && ok "agent exists: $a" || bad "agent missing: $a"; done
for sc in $(grep -o 'scripts/[A-Za-z0-9_.-]*' "$f" | sort -u); do [ -e "$repo/$sc" ] && ok "script exists: $sc" || bad "script missing: $sc"; done
[ "$failures" = "0" ] && { echo; echo "All ship-skill checks passed."; exit 0; } || { echo; echo "$failures check(s) failed."; exit 1; }
