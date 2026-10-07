#!/usr/bin/env bash
# Synthetic isolated cluster; never uses ambient application DATABASE_URL.
set -Eeuo pipefail
umask 077
pg_bin="${KTS_TEST_PG_BIN:-/usr/lib/postgresql/16/bin}"
test_root="$(mktemp -d /tmp/kts-usage-postgres.XXXXXX)"
cleanup() {
  if [[ -f "$test_root/data/postmaster.pid" ]]; then
    "$pg_bin/pg_ctl" -D "$test_root/data" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if [[ "$test_root" == /tmp/kts-usage-postgres.* && -d "$test_root" && ! -L "$test_root" ]]; then
    rm -r -- "$test_root"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir "$test_root/socket"
"$pg_bin/initdb" -D "$test_root/data" --username=usage_test_owner --auth-local=trust --auth-host=reject --no-locale --encoding=UTF8 >"$test_root/init.log"
"$pg_bin/pg_ctl" -D "$test_root/data" -l "$test_root/postgres.log" -o "-k $test_root/socket -h '' -p 55479 -c shared_buffers=16MB -c max_connections=12 -c work_mem=1MB" -w start >/dev/null
"$pg_bin/psql" -h "$test_root/socket" -p 55479 -U usage_test_owner -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE usage_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE' \
  -c 'CREATE DATABASE kts_usage_integration OWNER usage_app' >/dev/null
export DATABASE_URL="postgresql://usage_app@localhost/kts_usage_integration?host=$test_root/socket&port=55479"
export KTS_USAGE_TEST=1
export NODE_ENV=test
export ADMIN_SESSION_SECRET='synthetic-isolated-usage-test-only'
node --import tsx --test tests/dashboard-usage-db.integration.ts
