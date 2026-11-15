#!/usr/bin/env bash
# Stop hook (CLAUDE.md hard rule 1): show the branch status line when the session stops, derived from real git
# state by scripts/branch-status.sh. It shows the line to the user as a system message; it never blocks the stop.
# Always exits 0: a status script that fails must not trap a session.
root="${CLAUDE_PROJECT_DIR:-$PWD}"
cd "$root" 2>/dev/null || exit 0
[ -f scripts/branch-status.sh ] || exit 0
out=$(STATUS_FETCH_TIMEOUT=20 STATUS_DEEPEN_TIMEOUT=60 timeout 100 bash scripts/branch-status.sh 2>/dev/null | head -n 2)
[ -n "$out" ] || out="Branch: unknown | scripts/branch-status.sh printed nothing | status unknown"
printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify({systemMessage:s})+"\n"))'
exit 0
