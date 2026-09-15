#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export PATH=/usr/bin:/bin
readonly root=/home/kts/backups/kts-next-admin
readonly installed=/home/kts/.local/lib/kts-backup
[[ "$(id -un)" == kts && "$(id -u)" != 0 ]] || { echo 'Run commissioning as kts' >&2; exit 78; }
[[ -d "$root" && ! -L "$root" && "$(realpath -- "$root")" == "$root" ]] || { echo 'Invalid backup root' >&2; exit 78; }
[[ "$(stat -c '%U:%a' -- "$root")" == kts:700 && "$(cat "$root/.kts-backup-root")" == kts-next-admin ]] || { echo 'Invalid backup root owner or marker' >&2; exit 78; }
case "${1:-}" in
  policy) [[ $# == 2 && "$2" == required ]] || { echo 'Usage: configure.sh policy required' >&2; exit 64; };;
  cloud) [[ $# == 3 ]] || { echo 'Usage: configure.sh cloud BUCKET KMS_KEY_ID' >&2; exit 64; };;
  retention) [[ $# == 3 && "$2" == count && "$3" == 5 ]] || { echo 'Usage: configure.sh retention count 5' >&2; exit 64; };;
  *) echo 'Usage: configure.sh policy required | cloud BUCKET KMS_KEY_ID | retention count 5' >&2; exit 64;;
esac
# Same lock as capture, cloud sync, predeploy and installation.
exec 9>"$root/.operation.lock"
/usr/bin/flock --exclusive --wait 1800 9 || { echo 'Commissioning lock timeout' >&2; exit 75; }
/usr/bin/node "$installed/configure.cjs" "$@"
