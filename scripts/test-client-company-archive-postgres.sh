#!/usr/bin/env bash
# Disposable synthetic database and files only. Never loads application .env.
set -Eeuo pipefail
umask 077

archive_pg_bin="${KTS_TEST_PG_BIN:-/usr/lib/postgresql/16/bin}"
archive_test_root="$(mktemp -d /tmp/kts-client-archive-postgres.XXXXXX)"
cleanup() {
  if [[ -f "$archive_test_root/data/postmaster.pid" ]]; then
    "$archive_pg_bin/pg_ctl" -D "$archive_test_root/data" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if [[ "$archive_test_root" == /tmp/kts-client-archive-postgres.* && -d "$archive_test_root" && ! -L "$archive_test_root" ]]; then
    rm -r -- "$archive_test_root"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir "$archive_test_root/socket" "$archive_test_root/uploads"
"$archive_pg_bin/initdb" -D "$archive_test_root/data" --username=archive_test_owner --auth-local=trust --auth-host=reject --no-locale --encoding=UTF8 >"$archive_test_root/init.log"
"$archive_pg_bin/pg_ctl" -D "$archive_test_root/data" -l "$archive_test_root/postgres.log" -o "-k $archive_test_root/socket -h '' -p 55483 -c shared_buffers=16MB -c max_connections=12 -c work_mem=1MB" -w start >/dev/null
"$archive_pg_bin/psql" -X -h "$archive_test_root/socket" -p 55483 -U archive_test_owner -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE archive_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE' \
  -c 'CREATE DATABASE kts_client_archive_integration OWNER archive_app' >/dev/null

export DATABASE_URL="postgresql://archive_app@localhost/kts_client_archive_integration?host=$archive_test_root/socket&port=55483"
export UPLOAD_DIR="$archive_test_root/uploads"
export KTS_CLIENT_ARCHIVE_TEST=1
export ADMIN_SESSION_SECRET='synthetic-client-archive-test-secret-not-for-production'
export NODE_ENV=test
node --import tsx --test tests/client-company-archive-db.integration.ts
