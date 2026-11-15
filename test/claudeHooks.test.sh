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

# settings.json is valid, wires every hook to a file that exists with the right matcher, and the allow-list is EXACTLY this list
# (adding any entry, such as Bash(*) or a git command with a file-writing option, must be a conscious change to this test)
node -e '
const fs=require("fs"); const root=process.argv[1];
const s=JSON.parse(fs.readFileSync(root+"/.claude/settings.json","utf8"));
const fail=(m)=>{console.log(m);process.exit(1)};
if(s.hooks?.PreToolUse?.[0]?.matcher!=="Bash"||!JSON.stringify(s.hooks.PreToolUse).includes("guard-git-add.mjs")) fail("guard not wired to Bash");
if(s.hooks?.SessionStart?.[0]?.matcher!=="startup"||!JSON.stringify(s.hooks.SessionStart).includes("session-start.sh")) fail("session-start not wired to startup only");
if(!JSON.stringify(s.hooks?.Stop).includes("stop-branch-status.sh")) fail("stop hook not wired");
for (const f of ["guard-git-add.mjs","guard-lib.mjs","session-start.sh","stop-branch-status.sh"]) if(!fs.existsSync(root+"/.claude/hooks/"+f)) fail("missing "+f);
const want=["Bash(git status:*)","Bash(git rev-parse:*)","Bash(git remote get-url:*)","Bash(git ls-files:*)","Bash(bash scripts/branch-status.sh)","Bash(npm run lint)","Bash(ls:*)","Bash(wc:*)","Bash(pwd)"];
if(JSON.stringify(s.permissions?.allow)!==JSON.stringify(want)) fail("allow-list is not the reviewed list: "+JSON.stringify(s.permissions?.allow));
' "$repo" && ok "settings.json wires the three hooks with the right matchers and the allow-list is exactly the reviewed one" || bad "settings.json wiring / allow-list"

# the guard must run from any path: a space or a symlink once made it silently do nothing
mkdir -p "$tmp/sp ace/.claude/hooks"; cp "$repo"/.claude/hooks/guard-*.mjs "$tmp/sp ace/.claude/hooks/"
printf '%s' '{"tool_name":"Bash","tool_input":{"command":"git add -A"}}' | node "$tmp/sp ace/.claude/hooks/guard-git-add.mjs" 2>/dev/null; [ "$?" = "2" ] && ok "the guard refuses from a path with a space" || bad "guard silent in a path with a space"
ln -s "$tmp/sp ace/.claude" "$tmp/linked"
printf '%s' '{"tool_name":"Bash","tool_input":{"command":"git add -A"}}' | node "$tmp/linked/hooks/guard-git-add.mjs" 2>/dev/null; [ "$?" = "2" ] && ok "...and through a symlink" || bad "guard silent through a symlink"

refused 'git add -A'
refused 'git add -u'
refused 'git add --update'
refused 'git commit .'
refused 'git commit -m a -- .'
allowed 'git commit -m "-and fix"'
allowed 'git commit -m "-a thing"'
allowed 'git commit -m .'
allowed 'git commit -F msg.txt'
refused 'sudo git add -A'
refused 'env X=1 git add -A'
refused 'timeout 10 git add .'
refused 'xargs git add -A'
refused 'cat <<<x; git add -A'
refused 'git stage -A'
refused 'git add .//'
refused 'git add ./.'
refused 'git add :/*'
refused 'git add ":(top)"'
refused 'git -C src add ..'
refused 'git add --no-ignore-r'
refused '(git add -A)'
refused 'git status # real comment
git add -A'
allowed 'git status # git add -A'
allowed 'echo x # ; git add -A'
refused 'git add --a'
refused 'git add :/'
refused 'git add --no-ignore-removal'
refused 'git add *'
refused '/usr/bin/git add -A'
refused '(cd sub && git add -A)'
refused 'git -C sub add -A>log'
refused "$(printf 'git commit -m "it'"'"'s fine" && git add . && echo done')"
refused "$(printf 'cat > f <<'"'"'EOF'"'"'\nhello\nEOF\ngit add -A')"
refused 'GIT_TRACE=1 git add -A'
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
allowed 'git commit -mupdate'
allowed 'echo git add .'
allowed '# git add -A'
allowed 'git add src/a.ts && git commit -m "x"'
allowed "$(printf 'cat > f <<'"'"'EOF'"'"'\ngit add -A\nEOF\ngit status')"
allowed "$(printf 'git commit -m "$(cat <<'"'"'EOF'"'"'\nfix: say "hello" to it'"'"'s users\n\nCo-Authored-By: x\nEOF\n)"')"
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
printf '%s' "$out" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); process.exit(JSON.stringify(Object.keys(j))==="[\"systemMessage\"]"?0:1)' && ok "...and it is only a message: it cannot block the stop" || bad "stop hook output must be only systemMessage"
out=$(CLAUDE_PROJECT_DIR="$tmp/none" bash "$repo/.claude/hooks/stop-branch-status.sh"); [ "$?" = "0" ] && ok "stop hook in a directory with no script still exits 0" || bad "stop hook must never trap a session"

# Session-start hook with stub npm and a stub test-database script
mkdir -p "$tmp/s/scripts" "$tmp/s/docs" "$tmp/bin"
echo '{}' > "$tmp/s/package-lock.json"
printf '#!/usr/bin/env bash\necho "$@" >> "%s/npm.calls"; mkdir -p node_modules; touch node_modules/.package-lock.json\n' "$tmp" > "$tmp/bin/npm"; chmod +x "$tmp/bin/npm"
printf '#!/usr/bin/env bash\necho postgresql://stub@127.0.0.1:1/x\n' > "$tmp/s/scripts/pg-test-cluster.sh"
printf 'intro\n\n**First action for a cold session:** run the thing\nthen go on\n' > "$tmp/s/docs/PROGRAM.md"
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
# an existing node_modules with no stamp is stamped and left alone (npm ci deletes it before downloading)
rm -f "$tmp/s/node_modules/.lockfile-sha"; : > "$tmp/npm.calls"; start >/dev/null
[ ! -s "$tmp/npm.calls" ] && [ -f "$tmp/s/node_modules/.lockfile-sha" ] && ok "a working node_modules with no stamp is stamped, not reinstalled" || bad "no-stamp case ran npm ci"
# a node_modules left EMPTY by a failed npm ci is not "installed": the next start installs again
rm -rf "$tmp/s/node_modules"; mkdir -p "$tmp/s/node_modules"; printf '#!/usr/bin/env bash\necho "$@" >> "%s/npm.calls"; mkdir -p node_modules; touch node_modules/.package-lock.json\n' "$tmp" > "$tmp/bin/npm"; : > "$tmp/npm.calls"; start >/dev/null
[ -s "$tmp/npm.calls" ] && ok "an empty node_modules with no stamp is installed, not stamped" || bad "empty node_modules was stamped as installed"
printf x > /dev/null
rm -f "$tmp/s/node_modules/.lockfile-sha"; : > "$tmp/npm.calls"; start >/dev/null
[ ! -s "$tmp/npm.calls" ] && ok "a node_modules that looks installed with no stamp is left alone" || bad "installed tree reinstalled"
# a symlinked node_modules (a worktree sharing another checkout's) is never touched
mkdir -p "$tmp/w/scripts" "$tmp/other_nm"; echo '{}' > "$tmp/w/package-lock.json"; printf old > "$tmp/other_nm/.lockfile-sha"; ln -s "$tmp/other_nm" "$tmp/w/node_modules"; : > "$tmp/npm.calls"
CLAUDE_PROJECT_DIR="$tmp/w" PATH="$tmp/bin:$PATH" bash "$repo/.claude/hooks/session-start.sh" >/dev/null
[ ! -s "$tmp/npm.calls" ] && ok "a symlinked node_modules is never reinstalled" || bad "npm ci ran on a symlinked node_modules"
prev_stamp=$(cat "$tmp/s/node_modules/.lockfile-sha" 2>/dev/null)
printf '#!/usr/bin/env bash\nexit 1\n' > "$tmp/bin/npm"; echo '{"changed":2}' > "$tmp/s/package-lock.json"
out=$(start); rc=$?
[ "$rc" = "0" ] && printf '%s' "$out" | grep -q 'npm ci FAILED' && ok "a failing npm ci is reported in a sentence and does not block the session" || bad "failing npm ci" "rc=$rc $out"
[ "$(cat "$tmp/s/node_modules/.lockfile-sha" 2>/dev/null)" = "$prev_stamp" ] && ok "...and the stamp is not written, so the next start retries" || bad "stamp written after a failed install"

if [ "$failures" = "0" ]; then echo; echo "All Claude hook checks passed."; exit 0; else echo; echo "$failures check(s) failed."; exit 1; fi
