#!/usr/bin/env bash
# Synthetic isolated cluster. Never uses the ambient application DATABASE_URL.
set -Eeuo pipefail
umask 077
pg_bin="${KTS_TEST_PG_BIN:-/usr/lib/postgresql/16/bin}"
test_root="$(mktemp -d /tmp/kts-purchaser-postgres.XXXXXX)"
cleanup() {
  if [[ -f "$test_root/data/postmaster.pid" ]]; then
    "$pg_bin/pg_ctl" -D "$test_root/data" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if [[ "$test_root" == /tmp/kts-purchaser-postgres.* && -d "$test_root" && ! -L "$test_root" ]]; then
    rm -r -- "$test_root"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir "$test_root/socket"
"$pg_bin/initdb" -D "$test_root/data" --username=purchaser_test_owner --auth-local=trust --auth-host=reject --no-locale --encoding=UTF8 >"$test_root/init.log"
"$pg_bin/pg_ctl" -D "$test_root/data" -l "$test_root/postgres.log" -o "-k $test_root/socket -h '' -p 55475 -c shared_buffers=16MB -c max_connections=12 -c work_mem=1MB" -w start >/dev/null
"$pg_bin/psql" -h "$test_root/socket" -p 55475 -U purchaser_test_owner -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE purchaser_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE' \
  -c 'CREATE DATABASE kts_purchaser_integration OWNER purchaser_app' >/dev/null
export DATABASE_URL="postgresql://purchaser_app@localhost/kts_purchaser_integration?host=$test_root/socket&port=55475"
export KTS_PURCHASER_TEST=1
export NODE_ENV=test
export ADMIN_SESSION_SECRET='synthetic-isolated-purchaser-test-only'
node --import tsx --test tests/purchaser-access-db.integration.ts
