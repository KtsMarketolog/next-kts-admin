#!/usr/bin/env bash
# Disposable synthetic database only. Never reads application connection settings.
set -Eeuo pipefail
umask 077

content_version_pg_bin="${KTS_TEST_PG_BIN:-/usr/lib/postgresql/16/bin}"
content_version_test_root="$(mktemp -d /tmp/kts-content-version-postgres.XXXXXX)"
cleanup() {
  if [[ -f "$content_version_test_root/data/postmaster.pid" ]]; then
    "$content_version_pg_bin/pg_ctl" -D "$content_version_test_root/data" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  # Only this process's exact mktemp directory, never a caller-supplied database.
  if [[ "$content_version_test_root" == /tmp/kts-content-version-postgres.* && -d "$content_version_test_root" && ! -L "$content_version_test_root" ]]; then
    rm -r -- "$content_version_test_root"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir "$content_version_test_root/socket"
"$content_version_pg_bin/initdb" -D "$content_version_test_root/data" --username=content_version_test_owner --auth-local=trust --auth-host=reject --no-locale --encoding=UTF8 >"$content_version_test_root/init.log"
"$content_version_pg_bin/pg_ctl" -D "$content_version_test_root/data" -l "$content_version_test_root/postgres.log" -o "-k $content_version_test_root/socket -h '' -p 55504 -c shared_buffers=16MB -c max_connections=16 -c work_mem=1MB" -w start >/dev/null
"$content_version_pg_bin/psql" -X -h "$content_version_test_root/socket" -p 55504 -U content_version_test_owner -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE content_version_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE' \
  -c 'CREATE DATABASE kts_content_version_integration OWNER content_version_app' >/dev/null

# Explicitly replace any ambient URL; this temporary cluster has no TCP listener.
export DATABASE_URL="postgresql://content_version_app@localhost/kts_content_version_integration?host=$content_version_test_root/socket&port=55504"
export KTS_CONTENT_VERSION_TEST=1
export NODE_ENV=test
node --import tsx --test tests/site-content-version-db.integration.ts
