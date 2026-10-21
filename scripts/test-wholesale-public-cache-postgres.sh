#!/usr/bin/env bash
# Synthetic throwaway cluster only. Never reads application connection settings or .env files.
set -Eeuo pipefail
umask 077

pg_bin="${KTS_TEST_PG_BIN:-/usr/lib/postgresql/16/bin}"
test_root="$(mktemp -d /tmp/kts-public-cache-postgres.XXXXXX)"
cleanup() {
  if [[ -f "$test_root/data/postmaster.pid" ]]; then
    "$pg_bin/pg_ctl" -D "$test_root/data" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  # Exact directory created above; never a caller-provided path or application database.
  if [[ "$test_root" == /tmp/kts-public-cache-postgres.* && -d "$test_root" && ! -L "$test_root" ]]; then
    rm -r -- "$test_root"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir "$test_root/socket"
"$pg_bin/initdb" -D "$test_root/data" --username=public_cache_test_owner --auth-local=trust --auth-host=reject --no-locale --encoding=UTF8 >"$test_root/init.log"
# Pool (8), concurrent manager fixture, dedicated build lock and reserved slots.
"$pg_bin/pg_ctl" -D "$test_root/data" -l "$test_root/postgres.log" -o "-k $test_root/socket -h '' -p 55476 -c shared_buffers=16MB -c max_connections=16 -c work_mem=1MB" -w start >/dev/null
"$pg_bin/psql" -X -h "$test_root/socket" -p 55476 -U public_cache_test_owner -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE public_cache_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE' \
  -c 'CREATE DATABASE kts_public_cache_integration OWNER public_cache_app' >/dev/null

# Always override any ambient connection. This cluster exposes only its own Unix socket.
export DATABASE_URL="postgresql://public_cache_app@localhost/kts_public_cache_integration?host=$test_root/socket&port=55476"
export KTS_PUBLIC_CACHE_TEST=1
export NODE_ENV=test
export KTS_PRICE_BUILD_TEST=1
export KTS_PRICE_BUILD_CACHE_DIR="$test_root/cache"
node scripts/build-price-worker.mjs
node --import tsx --test tests/wholesale-public-cache-db.integration.ts
