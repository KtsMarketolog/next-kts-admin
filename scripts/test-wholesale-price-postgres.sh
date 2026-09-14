#!/usr/bin/env bash
# Disposable synthetic database only; never reads the application's connection settings.
set -Eeuo pipefail
umask 077

pg_bin="${KTS_TEST_PG_BIN:-/usr/lib/postgresql/16/bin}"
test_root="$(mktemp -d /tmp/kts-wholesale-postgres.XXXXXX)"
cleanup() {
  if [[ -f "$test_root/data/postmaster.pid" ]]; then
    "$pg_bin/pg_ctl" -D "$test_root/data" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  # Only this process's exact mktemp directory; never a caller-supplied directory or database.
  if [[ "$test_root" == /tmp/kts-wholesale-postgres.* && -d "$test_root" && ! -L "$test_root" ]]; then
    rm -r -- "$test_root"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir "$test_root/socket"
"$pg_bin/initdb" -D "$test_root/data" --username=wholesale_test_owner --auth-local=trust --auth-host=reject --no-locale --encoding=UTF8 >"$test_root/init.log"
"$pg_bin/pg_ctl" -D "$test_root/data" -l "$test_root/postgres.log" -o "-k $test_root/socket -h '' -p 55474 -c shared_buffers=16MB -c max_connections=12 -c work_mem=1MB" -w start >/dev/null
"$pg_bin/psql" -h "$test_root/socket" -p 55474 -U wholesale_test_owner -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE wholesale_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE' \
  -c 'CREATE DATABASE kts_wholesale_integration OWNER wholesale_app' >/dev/null

# Explicitly overwrite ambient DATABASE_URL. This cluster has no TCP listener.
export DATABASE_URL="postgresql://wholesale_app@localhost/kts_wholesale_integration?host=$test_root/socket&port=55474"
export KTS_WHOLESALE_TEST=1
export NODE_ENV=test
if [[ -n "${KTS_WHOLESALE_TEST_BUNDLE:-}" ]]; then
  node --test "$KTS_WHOLESALE_TEST_BUNDLE"
else
  node --import tsx --test tests/wholesale-price-db.integration.ts
fi
