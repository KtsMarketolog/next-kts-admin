#!/usr/bin/env bash
# Synthetic disposable database only. Never reads application connection settings.
set -Eeuo pipefail
umask 077

catalog_pg_bin="${KTS_TEST_PG_BIN:-/usr/lib/postgresql/16/bin}"
catalog_test_root="$(mktemp -d /tmp/kts-catalog-stock-postgres.XXXXXX)"
cleanup() {
  if [[ -f "$catalog_test_root/data/postmaster.pid" ]]; then
    "$catalog_pg_bin/pg_ctl" -D "$catalog_test_root/data" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  # Only this process's freshly-created directory, never a supplied data directory.
  if [[ "$catalog_test_root" == /tmp/kts-catalog-stock-postgres.* && -d "$catalog_test_root" && ! -L "$catalog_test_root" ]]; then
    rm -r -- "$catalog_test_root"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir "$catalog_test_root/socket"
"$catalog_pg_bin/initdb" -D "$catalog_test_root/data" --username=catalog_test_owner --auth-local=trust --auth-host=reject --no-locale --encoding=UTF8 >"$catalog_test_root/init.log"
"$catalog_pg_bin/pg_ctl" -D "$catalog_test_root/data" -l "$catalog_test_root/postgres.log" -o "-k $catalog_test_root/socket -h '' -p 55481 -c shared_buffers=16MB -c max_connections=16 -c work_mem=1MB" -w start >/dev/null
"$catalog_pg_bin/psql" -X -h "$catalog_test_root/socket" -p 55481 -U catalog_test_owner -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE catalog_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE' \
  -c 'CREATE DATABASE kts_catalog_stock_integration OWNER catalog_app' >/dev/null

# Explicitly replace any ambient URL; the cluster does not listen on TCP.
export DATABASE_URL="postgresql://catalog_app@localhost/kts_catalog_stock_integration?host=$catalog_test_root/socket&port=55481"
export KTS_CATALOG_STOCK_TEST=1
export NODE_ENV=test
node --import tsx --test tests/catalog-stock-locking-db.integration.ts
