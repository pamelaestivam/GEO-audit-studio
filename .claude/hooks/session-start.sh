#!/usr/bin/env bash
# SessionStart hook: make a cold session ready, then say what the program says to do first.
#  1. npm ci when node_modules is missing or package-lock.json changed since the last install.
#  2. start the throwaway test PostgreSQL when its programs exist, and export TEST_DATABASE_URL for the session.
#  3. print the "First action for a cold session" paragraph of docs/PROGRAM.md (stdout becomes session context).
# Every step is allowed to fail; the hook always exits 0 so a broken network never blocks a session.
root="${CLAUDE_PROJECT_DIR:-$PWD}"
cd "$root" 2>/dev/null || exit 0

# Dependencies. npm ci deletes node_modules before it downloads, so it only runs when it is needed and safe:
#  - never when node_modules is a symlink (a worktree sharing another checkout's), it would empty the other one;
#  - never just because the stamp is missing: an existing node_modules that looks installed (npm writes node_modules/.package-lock.json
#    on success) is stamped and left alone; one that does not look installed (empty or half-deleted by a failed npm ci) is installed;
#  - when package-lock.json changed since the stamp, or node_modules is missing, and then the stamp is written only after success.
stamp="node_modules/.lockfile-sha"
lock_sha=$(sha256sum package-lock.json 2>/dev/null | cut -d' ' -f1)
if [ -f package-lock.json ]; then
  if [ -L node_modules ]; then
    echo "session-start: node_modules is a symlink; not touching it"
  elif [ ! -d node_modules ] || { [ -f "$stamp" ] && [ "$(cat "$stamp" 2>/dev/null)" != "$lock_sha" ]; } || { [ ! -f "$stamp" ] && [ ! -f node_modules/.package-lock.json ]; }; then
    echo "session-start: installing dependencies (npm ci)"
    if npm ci >/tmp/session-start-npm.log 2>&1; then
      mkdir -p node_modules && printf '%s' "$lock_sha" > "$stamp"
    else
      echo "session-start: npm ci FAILED (see /tmp/session-start-npm.log); run it by hand"
    fi
  elif [ ! -f "$stamp" ]; then
    printf '%s' "$lock_sha" > "$stamp"
  fi
fi

if [ -f scripts/pg-test-cluster.sh ] && { ls -d /usr/lib/postgresql/*/bin >/dev/null 2>&1 || command -v pg_ctl >/dev/null 2>&1; }; then
  if url=$(bash scripts/pg-test-cluster.sh start 2>/dev/null | tail -n 1) && [ -n "$url" ]; then
    [ -n "${CLAUDE_ENV_FILE:-}" ] && printf 'export TEST_DATABASE_URL=%q\n' "$url" >> "$CLAUDE_ENV_FILE"
    echo "session-start: test PostgreSQL is up (TEST_DATABASE_URL set for this session)"
  else
    echo "session-start: test PostgreSQL did not start; the postgres suites will print SKIP"
  fi
else
  echo "session-start: no PostgreSQL programs installed; the postgres suites will print SKIP"
fi

if [ -f docs/PROGRAM.md ]; then
  echo "--- docs/PROGRAM.md, first action for a cold session ---"
  grep -A4 -m1 'First action for a cold session' docs/PROGRAM.md | cut -c1-400
fi
exit 0
