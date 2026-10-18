#!/usr/bin/env bash
# Disposable synthetic database only. Never reads application connection settings.
set -Eeuo pipefail
umask 077

atomic_pg_bin="${KTS_TEST_PG_BIN:-/usr/lib/postgresql/16/bin}"
atomic_test_root="$(mktemp -d /tmp/kts-atomic-postgres.XXXXXX)"
cleanup() {
  if [[ -f "$atomic_test_root/data/postmaster.pid" ]]; then
    "$atomic_pg_bin/pg_ctl" -D "$atomic_test_root/data" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  # This process's exact mktemp directory only; never a caller-supplied database.
  if [[ "$atomic_test_root" == /tmp/kts-atomic-postgres.* && -d "$atomic_test_root" && ! -L "$atomic_test_root" ]]; then
    rm -r -- "$atomic_test_root"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir "$atomic_test_root/socket"
"$atomic_pg_bin/initdb" -D "$atomic_test_root/data" --username=atomic_test_owner --auth-local=trust --auth-host=reject --no-locale --encoding=UTF8 >"$atomic_test_root/init.log"
"$atomic_pg_bin/pg_ctl" -D "$atomic_test_root/data" -l "$atomic_test_root/postgres.log" -o "-k $atomic_test_root/socket -h '' -p 55479 -c shared_buffers=16MB -c max_connections=12 -c work_mem=1MB" -w start >/dev/null
"$atomic_pg_bin/psql" -X -h "$atomic_test_root/socket" -p 55479 -U atomic_test_owner -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE atomic_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE' \
  -c 'CREATE DATABASE kts_atomic_integration OWNER atomic_app' >/dev/null

# Explicitly replace any ambient URL; this temporary cluster has no TCP listener.
export DATABASE_URL="postgresql://atomic_app@localhost/kts_atomic_integration?host=$atomic_test_root/socket&port=55479"
export KTS_ATOMIC_SAVES_TEST=1
export ADMIN_SESSION_SECRET='synthetic-atomic-save-integration-secret-not-for-production'
export NODE_ENV=test
node --import tsx --test tests/atomic-saves-db.integration.ts
