#!/usr/bin/env bash
# A throwaway PostgreSQL server for the store tests (test/store.test.ts, test/postgresE2E.test.ts).
#
#   bash scripts/pg-test-cluster.sh start   # starts it if needed, prints the TEST_DATABASE_URL to use
#   bash scripts/pg-test-cluster.sh stop    # stops it and leaves the data directory
#   bash scripts/pg-test-cluster.sh url     # prints the address only
#
# It needs the PostgreSQL server programs installed (the `postgresql` package), not a running service. Run as root
# it uses the `postgres` account, which refuses to run as root. The data is disposable: the tests create and drop
# their own schemas, and nothing here is ever pointed at a real database.
set -euo pipefail

PORT="${PGTEST_PORT:-54329}"
DIR="${PGTEST_DIR:-/var/tmp/geo-pgtest-$(id -u)}"
URL="postgresql://postgres@127.0.0.1:${PORT}/postgres"

BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
if [ -z "$BIN" ] && command -v pg_ctl >/dev/null 2>&1; then BIN="$(dirname "$(command -v pg_ctl)")"; fi
if [ -z "$BIN" ] || [ ! -x "$BIN/pg_ctl" ]; then
  echo "PostgreSQL server programs not found (install the postgresql package)." >&2
  exit 1
fi

as_pg() {
  if [ "$(id -u)" = 0 ]; then runuser -u postgres -- "$@"; else "$@"; fi
}

running() { "$BIN/pg_isready" -q -h 127.0.0.1 -p "$PORT"; }

case "${1:-start}" in
  start)
    if ! running; then
      if [ ! -f "$DIR/PG_VERSION" ]; then
        mkdir -p "$DIR"
        if [ "$(id -u)" = 0 ]; then chown postgres:postgres "$DIR"; fi
        chmod 700 "$DIR"
        as_pg "$BIN/initdb" -D "$DIR" -A trust -U postgres >/dev/null
      fi
      as_pg "$BIN/pg_ctl" -D "$DIR" -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$DIR" -l "$DIR/server.log" -w start >/dev/null
    fi
    running || { echo "the throwaway PostgreSQL server did not start (see $DIR/server.log)" >&2; exit 1; }
    echo "$URL"
    ;;
  stop)
    if [ -f "$DIR/PG_VERSION" ]; then as_pg "$BIN/pg_ctl" -D "$DIR" -m fast stop >/dev/null 2>&1 || true; fi
    ;;
  url)
    echo "$URL"
    ;;
  *)
    echo "usage: $0 start|stop|url" >&2
    exit 2
    ;;
esac
