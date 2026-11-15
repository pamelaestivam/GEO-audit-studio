#!/usr/bin/env bash
# Proves the session hooks in .claude/ (item 2 of docs/ENGINEERING_BACKLOG.md). Each hook is run as a real
# process against input shaped like the harness sends it; the start-up and stop hooks run in a THROWAWAY repository
# under mktemp -d with stub programs, never in this checkout.
#
#   bash test/claudeHooks.test.sh
set -u
repo="$(cd "$(dirname "$0")/.." && pwd)"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
failures=0
ok()   { echo "pass  $1"; }
bad()  { echo "FAIL  $1"; [ -n "${2:-}" ] && echo "        $2"; failures=$((failures + 1)); }
guard() { node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",tool_input:{command:process.argv[1]}}))' "$1" | node "$repo/.claude/hooks/guard-git-add.mjs" 2>"$tmp/err"; }
refused() { guard "$1"; rc=$?; if [ "$rc" = "2" ] && [ -s "$tmp/err" ]; then ok "refuses: $1"; else bad "should refuse: $1" "exit $rc"; fi; }
allowed() { guard "$1"; rc=$?; if [ "$rc" = "0" ]; then ok "allows: $1"; else bad "should allow: $1" "exit $rc: $(cat "$tmp/err")"; fi; }

# settings.json is valid and wires every hook to a file that exists
node -e '
const s=JSON.parse(require("fs").readFileSync(process.argv[1]+"/.claude/settings.json","utf8"));
const need=["PreToolUse","SessionStart","Stop"]; for (const k of need) if(!s.hooks?.[k]) { console.log("missing "+k); process.exit(1); }
const cmds=JSON.stringify(s.hooks); for (const f of ["guard-git-add.mjs","session-start.sh","stop-branch-status.sh"]) if(!cmds.includes(f)||!require("fs").existsSync(process.argv[1]+"/.claude/hooks/"+f)) { console.log("not wired: "+f); process.exit(1); }
if(!Array.isArray(s.permissions?.allow)||s.permissions.allow.some(x=>/\b(rm|push|add|commit|merge|reset|checkout)\b/.test(x))) { console.log("allow-list is not read-only"); process.exit(1); }
' "$repo" && ok "settings.json parses, wires the three hooks, and the allow-list has no writing command" || bad "settings.json wiring"

refused 'git add -A'
refused 'git add --all'
refused 'git add .'
refused 'git add -Av'
refused 'cd /x && git add -A && git status'
refused 'git -C /x add .'
refused 'git commit -a -m x'
refused 'git commit -am "msg"'
refused 'git commit --all -m x'
refused 'git status; git add .'
allowed 'git add src/a.ts test/b.test.ts'
allowed 'git add docs/x.md'
allowed 'git commit -m "explicit"'
allowed 'git commit --amend -m "x"'
allowed 'git status'
allowed 'npm test'
allowed 'git add -p'
allowed "git commit -m \"Do not run git add -A or git commit -a here\""
allowed "$(printf 'git commit -m "$(cat <<'"'"'EOF'"'"'\nnever git add -A\nEOF\n)"')"
allowed 'echo "git add ." > notes.txt'
allowed ''
echo 'not json' | node "$repo/.claude/hooks/guard-git-add.mjs" 2>/dev/null; [ "$?" = "0" ] && ok "unreadable hook input is allowed, not a crash" || bad "bad input must not block"

# Stop hook: in a throwaway repo it prints the real branch status as a system message and exits 0
mkdir -p "$tmp/p/scripts"; cp "$repo/scripts/branch-status.sh" "$tmp/p/scripts/"
git init -q --bare "$tmp/o.git"; git init -q -b main "$tmp/p"
git -C "$tmp/p" -c user.name=t -c user.email=t@t commit -q --allow-empty -m first
git -C "$tmp/p" remote add origin "$tmp/o.git"; git -C "$tmp/p" push -q origin main 2>/dev/null; git -C "$tmp/p" fetch -q origin
git -C "$tmp/p" checkout -q -b claude/x; git -C "$tmp/p" -c user.name=t -c user.email=t@t commit -q --allow-empty -m work
out=$(CLAUDE_PROJECT_DIR="$tmp/p" bash "$repo/.claude/hooks/stop-branch-status.sh"); rc=$?
[ "$rc" = "0" ] && ok "stop hook exits 0" || bad "stop hook exit $rc"
printf '%s' "$out" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); process.exit(/Branch: claude\/x \| 1 commit\(s\) ahead of main/.test(j.systemMessage)&&/NOT merged/.test(j.systemMessage)?0:1)' && ok "...and the message carries the real branch line" || bad "stop hook message" "$out"
out=$(CLAUDE_PROJECT_DIR="$tmp/none" bash "$repo/.claude/hooks/stop-branch-status.sh"); [ "$?" = "0" ] && ok "stop hook in a directory with no script still exits 0" || bad "stop hook must never trap a session"

# Session-start hook with stub npm and a stub test-database script
mkdir -p "$tmp/s/scripts" "$tmp/s/docs" "$tmp/bin"
echo '{}' > "$tmp/s/package-lock.json"
printf '#!/usr/bin/env bash\necho "$@" >> "%s/npm.calls"; mkdir -p node_modules\n' "$tmp" > "$tmp/bin/npm"; chmod +x "$tmp/bin/npm"
printf '#!/usr/bin/env bash\necho postgresql://stub@127.0.0.1:1/x\n' > "$tmp/s/scripts/pg-test-cluster.sh"
printf 'intro\n\n**First action for a cold session:** run the thing\nthen go on\n' > "$tmp/s/docs/PROGRAM.md"
export PGSTUB=1
start() { CLAUDE_PROJECT_DIR="$tmp/s" CLAUDE_ENV_FILE="$tmp/env" PATH="$tmp/bin:$PATH" bash "$repo/.claude/hooks/session-start.sh"; }
out=$(start); rc=$?
[ "$rc" = "0" ] && ok "start hook exits 0" || bad "start hook exit $rc"
grep -q '^ci' "$tmp/npm.calls" 2>/dev/null && ok "...runs npm ci on a fresh checkout" || bad "npm ci not run"
if ls -d /usr/lib/postgresql/*/bin >/dev/null 2>&1 || command -v pg_ctl >/dev/null 2>&1; then
  grep -q 'TEST_DATABASE_URL' "$tmp/env" 2>/dev/null && ok "...exports TEST_DATABASE_URL for the session" || bad "TEST_DATABASE_URL not exported" "$out"
else echo "skip  PostgreSQL programs not installed here: the database half of the start hook is not exercised"; fi
printf '%s' "$out" | grep -q 'First action for a cold session' && ok "...prints the first action from docs/PROGRAM.md" || bad "first action not printed"
: > "$tmp/npm.calls"; out=$(start)
[ ! -s "$tmp/npm.calls" ] && ok "...does not run npm ci again while package-lock.json is unchanged" || bad "npm ci repeated"
echo '{"changed":1}' > "$tmp/s/package-lock.json"; out=$(start)
[ -s "$tmp/npm.calls" ] && ok "...runs it again when package-lock.json changes" || bad "npm ci not rerun after a lockfile change"
printf '#!/usr/bin/env bash\nexit 1\n' > "$tmp/bin/npm"; echo '{"changed":2}' > "$tmp/s/package-lock.json"
out=$(start); rc=$?
[ "$rc" = "0" ] && printf '%s' "$out" | grep -q 'npm ci FAILED' && ok "a failing npm ci is reported in a sentence and does not block the session" || bad "failing npm ci" "rc=$rc $out"

if [ "$failures" = "0" ]; then echo; echo "All Claude hook checks passed."; exit 0; else echo; echo "$failures check(s) failed."; exit 1; fi
