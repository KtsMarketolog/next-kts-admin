#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
# An arbitrary restore URL could accidentally target production. Never accept it.
readonly root=/home/kts/backups/kts-next-admin
if [[ $# != 0 || -n "${RESTORE_DATABASE_URL:-}" || "$(id -un)" != kts ]]; then
  echo 'Use no arguments and unset RESTORE_DATABASE_URL. This command performs an isolated Yandex restore on the configured KTS server.' >&2
  exit 64
fi
if [[ ! -d "$root" || -L "$root" || "$(cat "$root/.kts-backup-root" 2>/dev/null)" != kts-next-admin ]]; then
  echo 'Verified KTS backup installation is required.' >&2
  exit 78
fi
# Same orchestration lock as the independent weekly monitor; each service also
# takes the common operation lock through run.sh.
exec 7>"$root/.monitor-restore.lock"
/usr/bin/flock --exclusive --wait 60 7 || exit 75
systemctl --user start kts-backup-fetch-restore.service
systemctl --user start kts-backup-restore.service
