#!/usr/bin/env bash
# Disposable synthetic identities only; never reads app .env or contacts a live DB.
set -Eeuo pipefail
umask 077
identifier_pg_bin="${KTS_TEST_PG_BIN:-/usr/lib/postgresql/16/bin}"
identifier_test_root="$(mktemp -d /tmp/kts-employee-identifiers-postgres.XXXXXX)"
cleanup() {
  if [[ -f "$identifier_test_root/data/postmaster.pid" ]]; then
    "$identifier_pg_bin/pg_ctl" -D "$identifier_test_root/data" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if [[ "$identifier_test_root" == /tmp/kts-employee-identifiers-postgres.* && -d "$identifier_test_root" && ! -L "$identifier_test_root" ]]; then
    rm -r -- "$identifier_test_root"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir "$identifier_test_root/socket"
"$identifier_pg_bin/initdb" -D "$identifier_test_root/data" --username=identifier_test_owner --auth-local=trust --auth-host=reject --locale="${KTS_TEST_PG_LOCALE:-C}" --encoding=UTF8 >"$identifier_test_root/init.log"
"$identifier_pg_bin/pg_ctl" -D "$identifier_test_root/data" -l "$identifier_test_root/postgres.log" -o "-k $identifier_test_root/socket -h '' -p 55485 -c shared_buffers=16MB -c max_connections=12 -c work_mem=1MB" -w start >/dev/null
"$identifier_pg_bin/psql" -X -h "$identifier_test_root/socket" -p 55485 -U identifier_test_owner -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE identifier_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE' \
  -c 'CREATE DATABASE kts_employee_identifiers_integration OWNER identifier_app' >/dev/null
export DATABASE_URL="postgresql://identifier_app@localhost/kts_employee_identifiers_integration?host=$identifier_test_root/socket&port=55485"
export KTS_EMPLOYEE_IDENTIFIERS_TEST=1
export ADMIN_SESSION_SECRET='synthetic-employee-identifiers-test-secret-not-production'
unset EMPLOYEE_PASSWORD_ENCRYPTION_KEY
export NODE_ENV=test
node --import tsx --test tests/employee-identifiers-db.integration.ts
