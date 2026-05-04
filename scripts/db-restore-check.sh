#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: scripts/db-restore-check.sh path/to/backup.dump" >&2
  exit 1
fi

if [[ -z "${RESTORE_DATABASE_URL:-}" ]]; then
  echo "RESTORE_DATABASE_URL is required and must point to a disposable test database" >&2
  exit 1
fi

backup_file="$1"
if [[ ! -f "$backup_file" ]]; then
  echo "Backup file not found: $backup_file" >&2
  exit 1
fi

pg_restore --clean --if-exists --no-owner --no-acl --dbname="$RESTORE_DATABASE_URL" "$backup_file"
psql "$RESTORE_DATABASE_URL" -c "select count(*) as wholesale_price_lists from wholesale_price_lists;"
