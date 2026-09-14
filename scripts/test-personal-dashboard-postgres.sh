#!/usr/bin/env bash
# Synthetic integration test only. Never connects to the application's database.
set -Eeuo pipefail
umask 077

pg_bin="${KTS_TEST_PG_BIN:-/usr/lib/postgresql/16/bin}"
test_root="$(mktemp -d /tmp/kts-personal-postgres.XXXXXX)"
cleanup() {
  if [[ -f "$test_root/data/postmaster.pid" ]]; then
    "$pg_bin/pg_ctl" -D "$test_root/data" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  # mktemp's exact owned directory only; never a supplied path, production data or backups.
  if [[ "$test_root" == /tmp/kts-personal-postgres.* && -d "$test_root" && ! -L "$test_root" ]]; then
    rm -r -- "$test_root"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir "$test_root/socket"
"$pg_bin/initdb" -D "$test_root/data" --username=personal_test_owner --auth-local=trust --auth-host=reject --no-locale --encoding=UTF8 >"$test_root/init.log"
"$pg_bin/pg_ctl" -D "$test_root/data" -l "$test_root/postgres.log" -o "-k $test_root/socket -h '' -p 55473 -c shared_buffers=16MB -c max_connections=12 -c work_mem=1MB" -w start >/dev/null
"$pg_bin/psql" -h "$test_root/socket" -p 55473 -U personal_test_owner -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE personal_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE' \
  -c 'CREATE DATABASE kts_personal_integration OWNER personal_app' >/dev/null

# Explicitly replace any ambient connection string; TCP listeners are disabled.
export DATABASE_URL="postgresql://personal_app@localhost/kts_personal_integration?host=$test_root/socket&port=55473"
export KTS_PERSONAL_TEST=1
export NODE_ENV=test
if [[ -n "${KTS_PERSONAL_TEST_BUNDLE:-}" ]]; then
  # Optional locally compiled test bundle; permits testing without installing tools in production.
  node --test "$KTS_PERSONAL_TEST_BUNDLE"
else
  node --import tsx --test tests/manager-dashboard-db.integration.ts
fi
