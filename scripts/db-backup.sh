#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
# Compatibility entry point: audited config, private root and the common lock.
# Production connection secrets never appear in command-line arguments.
readonly runner=/home/kts/.local/lib/kts-backup/run.sh
if [[ $# != 0 || ! -x "$runner" || "$(id -un)" != kts ]]; then
  echo 'Run on the configured KTS server as kts, without arguments. See ops/backup/README.md.' >&2
  exit 64
fi
exec "$runner" capture
