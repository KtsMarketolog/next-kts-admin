#!/usr/bin/env bash
# Disposable synthetic database only; never reads the application's connection settings.
set -Eeuo pipefail
umask 077

pg_bin="${KTS_TEST_PG_BIN:-/usr/lib/postgresql/16/bin}"
test_root="$(mktemp -d /tmp/kts-login-limit-postgres.XXXXXX)"
cleanup() {
  if [[ -f "$test_root/data/postmaster.pid" ]]; then
    "$pg_bin/pg_ctl" -D "$test_root/data" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  # Only this process's exact mktemp directory, never a caller-supplied path/database.
  if [[ "$test_root" == /tmp/kts-login-limit-postgres.* && -d "$test_root" && ! -L "$test_root" ]]; then
    rm -r -- "$test_root"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir "$test_root/socket"
"$pg_bin/initdb" -D "$test_root/data" --username=login_test_owner --auth-local=trust --auth-host=reject --no-locale --encoding=UTF8 >"$test_root/init.log"
"$pg_bin/pg_ctl" -D "$test_root/data" -l "$test_root/postgres.log" -o "-k $test_root/socket -h '' -p 55475 -c shared_buffers=16MB -c max_connections=12 -c work_mem=1MB" -w start >/dev/null
"$pg_bin/psql" -X -h "$test_root/socket" -p 55475 -U login_test_owner -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE login_rate_limit_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE' \
  -c 'CREATE DATABASE kts_login_rate_limit_integration OWNER login_rate_limit_app' >/dev/null

# Explicitly replace any ambient DATABASE_URL. This cluster has no TCP listener.
export DATABASE_URL="postgresql://login_rate_limit_app@localhost/kts_login_rate_limit_integration?host=$test_root/socket&port=55475"
export KTS_LOGIN_RATE_LIMIT_TEST=1
export NODE_ENV=test
node --import tsx --test tests/admin-login-rate-limit-db.integration.ts
