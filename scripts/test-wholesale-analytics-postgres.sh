#!/usr/bin/env bash
# Isolated synthetic analytics database; never loads application connection settings.
set -Eeuo pipefail
umask 077
pg_bin="${KTS_TEST_PG_BIN:-/usr/lib/postgresql/16/bin}"
test_root="$(mktemp -d /tmp/kts-analytics-postgres.XXXXXX)"
cleanup() {
  if [[ -f "$test_root/data/postmaster.pid" ]]; then
    "$pg_bin/pg_ctl" -D "$test_root/data" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if [[ "$test_root" == /tmp/kts-analytics-postgres.* && -d "$test_root" && ! -L "$test_root" ]]; then
    rm -r -- "$test_root"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir "$test_root/socket"
"$pg_bin/initdb" -D "$test_root/data" --username=analytics_test_owner --auth-local=trust --auth-host=reject --no-locale --encoding=UTF8 >"$test_root/init.log"
"$pg_bin/pg_ctl" -D "$test_root/data" -l "$test_root/postgres.log" -o "-k $test_root/socket -h '' -p 55491 -c shared_buffers=16MB -c max_connections=8 -c work_mem=4MB" -w start >/dev/null
"$pg_bin/psql" -X -h "$test_root/socket" -p 55491 -U analytics_test_owner -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE analytics_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE' \
  -c 'CREATE DATABASE kts_analytics_integration OWNER analytics_app' >/dev/null
export DATABASE_URL="postgresql://analytics_app@localhost/kts_analytics_integration?host=$test_root/socket&port=55491"
export KTS_ANALYTICS_TEST=1
export NODE_ENV=test
node --import tsx --test tests/wholesale-analytics-db.integration.ts
