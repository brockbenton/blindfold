#!/usr/bin/env bash
# Stops the cluster started by dev-pg.sh. Pass --wipe to also delete its data.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PGDATA="$DIR/.pgdata"
BIN="${PG_BIN:-/usr/bin}"
[ -f "$PGDATA/PG_VERSION" ] && "$BIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1 && "$BIN/pg_ctl" -D "$PGDATA" -m fast stop >/dev/null
[ "${1:-}" = "--wipe" ] && rm -rf "$PGDATA"
echo stopped
