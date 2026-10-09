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
echo "Production-dependencies-only install runs."
