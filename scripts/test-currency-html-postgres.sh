#!/usr/bin/env bash
# Isolated synthetic PostgreSQL: no ambient connection strings and no TCP listeners.
set -Eeuo pipefail
umask 077
pg_bin="${KTS_TEST_PG_BIN:-/usr/lib/postgresql/16/bin}"
test_root="$(mktemp -d /tmp/kts-currency-html-postgres.XXXXXX)"
cleanup() {
  if [[ -f "$test_root/data/postmaster.pid" ]]; then
    "$pg_bin/pg_ctl" -D "$test_root/data" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  # This exact directory was created by mktemp above, never taken from user input.
  if [[ "$test_root" == /tmp/kts-currency-html-postgres.* && -d "$test_root" && ! -L "$test_root" ]]; then rm -r -- "$test_root"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir "$test_root/socket"
"$pg_bin/initdb" -D "$test_root/data" --username=currency_test_owner --auth-local=trust --auth-host=reject --no-locale --encoding=UTF8 >"$test_root/init.log"
"$pg_bin/pg_ctl" -D "$test_root/data" -l "$test_root/postgres.log" -o "-k $test_root/socket -h '' -p 55476 -c shared_buffers=16MB -c max_connections=12 -c work_mem=1MB" -w start >/dev/null
"$pg_bin/psql" -h "$test_root/socket" -p 55476 -U currency_test_owner -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE currency_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE' \
  -c 'CREATE DATABASE kts_currency_html_integration OWNER currency_app' >/dev/null
export DATABASE_URL="postgresql://currency_app@localhost/kts_currency_html_integration?host=$test_root/socket&port=55476"
export KTS_CURRENCY_HTML_TEST_DATABASE_URL="$DATABASE_URL"
export KTS_CURRENCY_HTML_POSTGRES_TEST=1
export NODE_ENV=test
node --import tsx --test tests/currency-dashboard-html.postgres.test.ts
