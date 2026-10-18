#!/usr/bin/env bash
# Disposable synthetic database; never loads .env or contacts SMTP.
set -Eeuo pipefail
umask 077
outbox_pg_bin="${KTS_TEST_PG_BIN:-/usr/lib/postgresql/16/bin}"
outbox_test_root="$(mktemp -d /tmp/kts-price-outbox-postgres.XXXXXX)"
cleanup() {
  if [[ -f "$outbox_test_root/data/postmaster.pid" ]]; then
    "$outbox_pg_bin/pg_ctl" -D "$outbox_test_root/data" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if [[ "$outbox_test_root" == /tmp/kts-price-outbox-postgres.* && -d "$outbox_test_root" && ! -L "$outbox_test_root" ]]; then
    rm -r -- "$outbox_test_root"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir "$outbox_test_root/socket"
"$outbox_pg_bin/initdb" -D "$outbox_test_root/data" --username=outbox_test_owner --auth-local=trust --auth-host=reject --no-locale --encoding=UTF8 >"$outbox_test_root/init.log"
"$outbox_pg_bin/pg_ctl" -D "$outbox_test_root/data" -l "$outbox_test_root/postgres.log" -o "-k $outbox_test_root/socket -h '' -p 55491 -c shared_buffers=16MB -c max_connections=12 -c work_mem=1MB" -w start >/dev/null
"$outbox_pg_bin/psql" -X -h "$outbox_test_root/socket" -p 55491 -U outbox_test_owner -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE outbox_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE' \
  -c 'CREATE DATABASE kts_price_request_outbox_integration OWNER outbox_app' >/dev/null
export DATABASE_URL="postgresql://outbox_app@localhost/kts_price_request_outbox_integration?host=$outbox_test_root/socket&port=55491"
export KTS_PRICE_REQUEST_OUTBOX_TEST=1
export ADMIN_SESSION_SECRET='synthetic-price-request-test-secret-not-for-production'
unset EMPLOYEE_PASSWORD_ENCRYPTION_KEY
export NODE_ENV=test
node --import tsx --test tests/price-request-outbox-db.integration.ts
