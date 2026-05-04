#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"

timestamp="$(date +%Y%m%d-%H%M%S)"
output="$BACKUP_DIR/kts-$timestamp.dump"

pg_dump "$DATABASE_URL" --format=custom --no-owner --no-acl --file="$output"
echo "$output"
