#!/usr/bin/env bash
# Isolated synthetic credentials only. Never loads application .env or real data.
set -Eeuo pipefail
umask 077

password_pg_bin="${KTS_TEST_PG_BIN:-/usr/lib/postgresql/16/bin}"
password_test_root="$(mktemp -d /tmp/kts-client-password-postgres.XXXXXX)"
cleanup() {
  if [[ -f "$password_test_root/data/postmaster.pid" ]]; then
    "$password_pg_bin/pg_ctl" -D "$password_test_root/data" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if [[ "$password_test_root" == /tmp/kts-client-password-postgres.* && -d "$password_test_root" && ! -L "$password_test_root" ]]; then
    rm -r -- "$password_test_root"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir "$password_test_root/socket"
"$password_pg_bin/initdb" -D "$password_test_root/data" --username=password_test_owner --auth-local=trust --auth-host=reject --no-locale --encoding=UTF8 >"$password_test_root/init.log"
"$password_pg_bin/pg_ctl" -D "$password_test_root/data" -l "$password_test_root/postgres.log" -o "-k $password_test_root/socket -h '' -p 55484 -c shared_buffers=16MB -c max_connections=12 -c work_mem=1MB" -w start >/dev/null
"$password_pg_bin/psql" -X -h "$password_test_root/socket" -p 55484 -U password_test_owner -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE password_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE' \
  -c 'CREATE DATABASE kts_client_password_integration OWNER password_app' >/dev/null

export DATABASE_URL="postgresql://password_app@localhost/kts_client_password_integration?host=$password_test_root/socket&port=55484"
export KTS_CLIENT_PASSWORD_TEST=1
export ADMIN_SESSION_SECRET='synthetic-client-password-test-secret-not-for-production'
unset EMPLOYEE_PASSWORD_ENCRYPTION_KEY
export NODE_ENV=test
node --import tsx --test tests/client-password-db.integration.ts
