#!/usr/bin/env bash
# Disposable synthetic database only. Never loads application .env.
set -Eeuo pipefail
umask 077

chat_pg_bin="${KTS_TEST_PG_BIN:-/usr/lib/postgresql/16/bin}"
chat_test_root="$(mktemp -d /tmp/kts-client-chat-postgres.XXXXXX)"
cleanup() {
  if [[ -f "$chat_test_root/data/postmaster.pid" ]]; then
    "$chat_pg_bin/pg_ctl" -D "$chat_test_root/data" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if [[ "$chat_test_root" == /tmp/kts-client-chat-postgres.* && -d "$chat_test_root" && ! -L "$chat_test_root" ]]; then
    rm -r -- "$chat_test_root"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir "$chat_test_root/socket"
"$chat_pg_bin/initdb" -D "$chat_test_root/data" --username=chat_test_owner --auth-local=trust --auth-host=reject --no-locale --encoding=UTF8 >"$chat_test_root/init.log"
"$chat_pg_bin/pg_ctl" -D "$chat_test_root/data" -l "$chat_test_root/postgres.log" -o "-k $chat_test_root/socket -h '' -p 55505 -c shared_buffers=16MB -c max_connections=16 -c work_mem=1MB" -w start >/dev/null
"$chat_pg_bin/psql" -X -h "$chat_test_root/socket" -p 55505 -U chat_test_owner -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE chat_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE' \
  -c 'CREATE DATABASE kts_client_chat_integration OWNER chat_app' >/dev/null

export DATABASE_URL="postgresql://chat_app@localhost/kts_client_chat_integration?host=$chat_test_root/socket&port=55505"
export KTS_CLIENT_CHAT_TEST=1
export NODE_ENV=test
node --import tsx --test tests/client-chat-db.integration.ts
