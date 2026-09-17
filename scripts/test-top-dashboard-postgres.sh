#!/usr/bin/env bash
# Synthetic integration only. No ambient application database is ever used.
set -Eeuo pipefail
umask 077

pg_bin="${KTS_TEST_PG_BIN:-/usr/lib/postgresql/16/bin}"
test_root="$(mktemp -d /tmp/kts-top-postgres.XXXXXX)"
cleanup() {
  if [[ -f "$test_root/data/postmaster.pid" ]]; then
    "$pg_bin/pg_ctl" -D "$test_root/data" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if [[ "$test_root" == /tmp/kts-top-postgres.* && -d "$test_root" && ! -L "$test_root" ]]; then
    rm -r -- "$test_root"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir "$test_root/socket"
"$pg_bin/initdb" -D "$test_root/data" --username=top_test_owner --auth-local=trust --auth-host=reject --no-locale --encoding=UTF8 >"$test_root/init.log"
"$pg_bin/pg_ctl" -D "$test_root/data" -l "$test_root/postgres.log" -o "-k $test_root/socket -h '' -p 55474 -c shared_buffers=16MB -c max_connections=12 -c work_mem=1MB" -w start >/dev/null
"$pg_bin/psql" -h "$test_root/socket" -p 55474 -U top_test_owner -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE top_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE' \
  -c 'CREATE DATABASE kts_top_integration OWNER top_app' >/dev/null

export DATABASE_URL="postgresql://top_app@localhost/kts_top_integration?host=$test_root/socket&port=55474"
export KTS_TOP_TEST=1
export NODE_ENV=test
node --import tsx --test tests/top-dashboard-db.integration.ts
