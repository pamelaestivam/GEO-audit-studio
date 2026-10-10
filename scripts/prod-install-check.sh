#!/usr/bin/env bash
# Proves the BUILT server runs from a clean directory with only production
# dependencies - the assumption every real deployment (Docker, Render, a VPS)
# depends on. A dependency that is only in devDependencies, or a file the
# bundle expects next to it, shows up here and nowhere else.
#
# Needs a current dist/ (npm run build). Run: bash scripts/prod-install-check.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
DATA="$(mktemp -d)"
PORT="${PORT:-$((7000 + RANDOM % 1000))}"
PID=""
cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
  rm -rf "$WORK" "$DATA"
}
trap cleanup EXIT

cp "$ROOT/package.json" "$ROOT/package-lock.json" "$WORK/"
cp -r "$ROOT/dist" "$WORK/dist"
cd "$WORK"
npm ci --omit=dev --no-audit --no-fund >/dev/null

NODE_ENV=production PORT="$PORT" DATA_DIR="$DATA" GEMINI_API_KEY=not-a-real-key \
  SESSION_SECRET="prod-install-check-secret-0123456789abcdef" ACCESS_CODES="install-check-code" \
  node dist/server.cjs >"$WORK/server.log" 2>&1 &
PID=$!

for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done

node "$ROOT/scripts/smoke.mjs" "http://127.0.0.1:$PORT"
test -f "$DATA/geo-audit.sqlite" && echo "pass  the SQLite database was created under DATA_DIR" \
  || { echo "FAIL  no database file under DATA_DIR"; exit 1; }

# --- state written before a restart must be there after it -------------------------------
# Deep readiness writes a probe row to the store BEFORE it calls Gemini, so signing in and
# calling it leaves durable state even though the fake key makes the Gemini check fail.
TOKEN=$(curl -fsS -X POST "http://127.0.0.1:$PORT/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"ci@example.com","accessCode":"install-check-code"}' \
  | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).token))")
curl -sS --max-time 90 "http://127.0.0.1:$PORT/api/audit/readiness" -H "Authorization: Bearer $TOKEN" >/dev/null || true

start_server() {
  NODE_ENV=production PORT="$PORT" DATA_DIR="$DATA" GEMINI_API_KEY=not-a-real-key \
    SESSION_SECRET="prod-install-check-secret-0123456789abcdef" ACCESS_CODES="install-check-code" \
    node dist/server.cjs >>"$WORK/server.log" 2>&1 &
  PID=$!
  for _ in $(seq 1 40); do
    curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "FAIL  the server did not come back"; cat "$WORK/server.log"; exit 1
}
count_probe_rows() {
  node -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    console.log(db.prepare(\"select count(*) as n from jobs where owner = 'readiness@system'\").get().n);
  " "$1"
}

kill "$PID"; wait "$PID" 2>/dev/null || true; PID=""
start_server
N=$(count_probe_rows "$DATA/geo-audit.sqlite")
[ "$N" -ge 1 ] && echo "pass  probe rows surviving the restart: $N" || { echo "FAIL  state written before the restart is gone ($N rows)"; exit 1; }

# --- a backup of the running database restores what the server wrote ----------------------
node "$ROOT/scripts/backup.mjs" "$DATA" "$DATA/backups/ci.sqlite" >/dev/null
# A second run to the same name must REFUSE, for the right reason (bash -e ignores a failing
# `!`, so this is an explicit if).
if node "$ROOT/scripts/backup.mjs" "$DATA" "$DATA/backups/ci.sqlite" 2>"$WORK/second.err"; then
  echo "FAIL  a second backup run did not refuse to overwrite"; exit 1
fi
grep -q "refusing to overwrite" "$WORK/second.err" || { echo "FAIL  refused for the wrong reason:"; cat "$WORK/second.err"; exit 1; }
N=$(count_probe_rows "$DATA/backups/ci.sqlite")
[ "$N" -ge 1 ] && echo "pass  probe rows in the backup: $N" || { echo "FAIL  the backup is missing the state ($N rows)"; exit 1; }

node "$ROOT/scripts/smoke.mjs" "http://127.0.0.1:$PORT"
echo "Production-dependencies-only install runs, survives a restart, and backs up."
