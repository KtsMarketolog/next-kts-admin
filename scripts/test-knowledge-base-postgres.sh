#!/usr/bin/env bash
# Isolated, synthetic data only; never loads application .env or real data.
set -Eeuo pipefail
umask 077
kb_pg_bin="${KTS_TEST_PG_BIN:-/usr/lib/postgresql/16/bin}"
kb_test_root="$(mktemp -d /tmp/kts-knowledge-base-postgres.XXXXXX)"
cleanup() {
  if [[ -f "$kb_test_root/data/postmaster.pid" ]]; then
    "$kb_pg_bin/pg_ctl" -D "$kb_test_root/data" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if [[ "$kb_test_root" == /tmp/kts-knowledge-base-postgres.* && -d "$kb_test_root" && ! -L "$kb_test_root" ]]; then
    rm -r -- "$kb_test_root"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir "$kb_test_root/socket"
"$kb_pg_bin/initdb" -D "$kb_test_root/data" --username=kb_test_owner --auth-local=trust --auth-host=reject --no-locale --encoding=UTF8 >"$kb_test_root/init.log"
"$kb_pg_bin/pg_ctl" -D "$kb_test_root/data" -l "$kb_test_root/postgres.log" -o "-k $kb_test_root/socket -h '' -p 55489 -c shared_buffers=16MB -c max_connections=12 -c work_mem=1MB" -w start >/dev/null
"$kb_pg_bin/psql" -X -h "$kb_test_root/socket" -p 55489 -U kb_test_owner -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE kb_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE' \
  -c 'CREATE DATABASE kts_knowledge_base_integration OWNER kb_app' >/dev/null
export DATABASE_URL="postgresql://kb_app@localhost/kts_knowledge_base_integration?host=$kb_test_root/socket&port=55489"
export KTS_KNOWLEDGE_BASE_TEST=1
export ADMIN_SESSION_SECRET='synthetic-knowledge-base-test-secret-not-for-production'
unset EMPLOYEE_PASSWORD_ENCRYPTION_KEY
export NODE_ENV=test
node --import tsx --test tests/knowledge-base-db.integration.ts
node --import tsx --test tests/knowledge-base-move-db.integration.ts
