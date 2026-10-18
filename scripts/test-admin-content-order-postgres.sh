#!/usr/bin/env bash
# Disposable synthetic database only. Never reads application connection settings.
set -Eeuo pipefail
umask 077

order_pg_bin="${KTS_TEST_PG_BIN:-/usr/lib/postgresql/16/bin}"
order_test_root="$(mktemp -d /tmp/kts-content-order-postgres.XXXXXX)"
cleanup() {
  if [[ -f "$order_test_root/data/postmaster.pid" ]]; then
    "$order_pg_bin/pg_ctl" -D "$order_test_root/data" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  # This process's exact mktemp directory only; never a caller-supplied database.
  if [[ "$order_test_root" == /tmp/kts-content-order-postgres.* && -d "$order_test_root" && ! -L "$order_test_root" ]]; then
    rm -r -- "$order_test_root"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir "$order_test_root/socket"
"$order_pg_bin/initdb" -D "$order_test_root/data" --username=order_test_owner --auth-local=trust --auth-host=reject --no-locale --encoding=UTF8 >"$order_test_root/init.log"
"$order_pg_bin/pg_ctl" -D "$order_test_root/data" -l "$order_test_root/postgres.log" -o "-k $order_test_root/socket -h '' -p 55480 -c shared_buffers=16MB -c max_connections=16 -c work_mem=1MB" -w start >/dev/null
"$order_pg_bin/psql" -X -h "$order_test_root/socket" -p 55480 -U order_test_owner -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE order_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE' \
  -c 'CREATE DATABASE kts_content_order_integration OWNER order_app' >/dev/null

# Explicitly replace any ambient URL; this temporary cluster has no TCP listener.
export DATABASE_URL="postgresql://order_app@localhost/kts_content_order_integration?host=$order_test_root/socket&port=55480"
export KTS_CONTENT_ORDER_TEST=1
export NODE_ENV=test
node --import tsx --test tests/admin-content-order-db.integration.ts
