#!/usr/bin/env bash
# Local Postgres for the mint without docker: user-owned cluster in services/mint/.pgdata on port 54329.
# Usage: services/mint/scripts/dev-pg.sh   (idempotent; prints DATABASE_URL)
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PGDATA="$DIR/.pgdata"
PORT="${DEV_PG_PORT:-54329}"
BIN="${PG_BIN:-/usr/bin}"
USER_NAME="$(id -un)"
# Unix socket paths are limited to ~100 bytes; fall back to a short dir for deep worktrees.
SOCK="$PGDATA"
if [ ${#PGDATA} -gt 80 ]; then SOCK="/tmp/blindfold-pg-$(id -u)"; mkdir -p "$SOCK"; fi

if [ ! -f "$PGDATA/PG_VERSION" ]; then
  "$BIN/initdb" -D "$PGDATA" -U "$USER_NAME" -A trust --no-sync >/dev/null
fi
if ! "$BIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
  "$BIN/pg_ctl" -D "$PGDATA" -l "$PGDATA/server.log" -w \
    -o "-p $PORT -k $SOCK -c listen_addresses=127.0.0.1 -c fsync=off -c max_connections=200" start >/dev/null
fi
if ! "$BIN/psql" -h "$SOCK" -p "$PORT" -U "$USER_NAME" -d postgres -tAc "select 1 from pg_database where datname='blindfold'" | grep -q 1; then
  "$BIN/createdb" -h "$SOCK" -p "$PORT" -U "$USER_NAME" blindfold
fi
echo "postgres://$USER_NAME@127.0.0.1:$PORT/blindfold"
