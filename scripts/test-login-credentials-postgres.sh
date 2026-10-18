#!/usr/bin/env bash
# Disposable synthetic authentication database; never reads application .env.
set -Eeuo pipefail
umask 077
login_pg_bin="${KTS_TEST_PG_BIN:-/usr/lib/postgresql/16/bin}"
login_test_root="$(mktemp -d /tmp/kts-login-credentials-postgres.XXXXXX)"
cleanup() {
  if [[ -f "$login_test_root/data/postmaster.pid" ]]; then
    "$login_pg_bin/pg_ctl" -D "$login_test_root/data" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if [[ "$login_test_root" == /tmp/kts-login-credentials-postgres.* && -d "$login_test_root" && ! -L "$login_test_root" ]]; then
    rm -r -- "$login_test_root"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir "$login_test_root/socket"
"$login_pg_bin/initdb" -D "$login_test_root/data" --username=login_test_owner --auth-local=trust --auth-host=reject --no-locale --encoding=UTF8 >"$login_test_root/init.log"
"$login_pg_bin/pg_ctl" -D "$login_test_root/data" -l "$login_test_root/postgres.log" -o "-k $login_test_root/socket -h '' -p 55487 -c shared_buffers=16MB -c max_connections=20 -c work_mem=1MB" -w start >/dev/null
"$login_pg_bin/psql" -X -h "$login_test_root/socket" -p 55487 -U login_test_owner -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE login_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE' \
  -c 'CREATE DATABASE kts_login_credentials_integration OWNER login_app' >/dev/null
export DATABASE_URL="postgresql://login_app@localhost/kts_login_credentials_integration?host=$login_test_root/socket&port=55487"
export KTS_LOGIN_CREDENTIALS_TEST=1
export ADMIN_SESSION_SECRET='synthetic-login-credentials-test-secret-not-for-production'
export ADMIN_PASSWORD='SyntheticEnvironmentPassword129!'
unset EMPLOYEE_PASSWORD_ENCRYPTION_KEY
export NODE_ENV=test
node --import tsx --test tests/login-credentials-db.integration.ts
