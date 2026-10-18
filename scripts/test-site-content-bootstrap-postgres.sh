#!/usr/bin/env bash
# Synthetic databases only. No application connection settings are read.
set -Eeuo pipefail
umask 077

content_pg_bin="${KTS_TEST_PG_BIN:-/usr/lib/postgresql/16/bin}"
content_test_root="$(mktemp -d /tmp/kts-site-content-postgres.XXXXXX)"
cleanup() {
  if [[ -f "$content_test_root/data/postmaster.pid" ]]; then
    "$content_pg_bin/pg_ctl" -D "$content_test_root/data" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  # Exact directory allocated above, never an existing or caller-supplied database.
  if [[ "$content_test_root" == /tmp/kts-site-content-postgres.* && -d "$content_test_root" && ! -L "$content_test_root" ]]; then
    rm -r -- "$content_test_root"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir "$content_test_root/socket"
"$content_pg_bin/initdb" -D "$content_test_root/data" --username=content_test_owner --auth-local=trust --auth-host=reject --no-locale --encoding=UTF8 >"$content_test_root/init.log"
"$content_pg_bin/pg_ctl" -D "$content_test_root/data" -l "$content_test_root/postgres.log" -o "-k $content_test_root/socket -h '' -p 55481 -c shared_buffers=16MB -c max_connections=20 -c work_mem=1MB" -w start >/dev/null
"$content_pg_bin/psql" -X -h "$content_test_root/socket" -p 55481 -U content_test_owner -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE content_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE' \
  -c 'CREATE DATABASE kts_site_content_runtime OWNER content_app' \
  -c 'CREATE DATABASE kts_site_content_bootstrap OWNER content_app' >/dev/null

export DATABASE_URL="postgresql://content_app@localhost/kts_site_content_runtime?host=$content_test_root/socket&port=55481"
export KTS_SITE_CONTENT_TEST=1
export NODE_ENV=test
node --import tsx --test tests/site-content-bootstrap-db.integration.ts
