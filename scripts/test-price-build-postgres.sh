#!/usr/bin/env bash
# Disposable synthetic database only. Never reads application connection settings.
set -Eeuo pipefail
umask 077
price_build_pg_bin="${KTS_TEST_PG_BIN:-/usr/lib/postgresql/16/bin}"
price_build_test_root="$(mktemp -d /tmp/kts-price-build-postgres.XXXXXX)"
cleanup() {
  if [[ -f "$price_build_test_root/data/postmaster.pid" ]]; then
    "$price_build_pg_bin/pg_ctl" -D "$price_build_test_root/data" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if [[ "$price_build_test_root" == /tmp/kts-price-build-postgres.* && -d "$price_build_test_root" && ! -L "$price_build_test_root" ]]; then
    rm -r -- "$price_build_test_root"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir "$price_build_test_root/socket" "$price_build_test_root/cache"
"$price_build_pg_bin/initdb" -D "$price_build_test_root/data" --username=price_build_test_owner --auth-local=trust --auth-host=reject --no-locale --encoding=UTF8 >"$price_build_test_root/init.log"
"$price_build_pg_bin/pg_ctl" -D "$price_build_test_root/data" -l "$price_build_test_root/postgres.log" -o "-k $price_build_test_root/socket -h '' -p 55487 -c shared_buffers=16MB -c max_connections=32 -c work_mem=1MB" -w start >/dev/null
"$price_build_pg_bin/psql" -X -h "$price_build_test_root/socket" -p 55487 -U price_build_test_owner -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE price_build_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE' \
  -c 'CREATE DATABASE kts_price_build_integration OWNER price_build_app' >/dev/null
export DATABASE_URL="postgresql://price_build_app@localhost/kts_price_build_integration?host=$price_build_test_root/socket&port=55487"
export KTS_PRICE_BUILD_TEST=1 NODE_ENV=test
export KTS_PRICE_BUILD_CACHE_DIR="$price_build_test_root/cache"
node --import tsx --test tests/price-build-db.integration.ts
# Sequential: the admission suite deliberately exhausts this cluster's connections.
node --import tsx --test tests/price-build-snapshot-deadline-db.integration.ts
