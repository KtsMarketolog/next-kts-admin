#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export PATH=/usr/bin:/bin
readonly root=/home/kts/backups/kts-next-admin
readonly installed=/home/kts/.local/lib/kts-backup
if [[ ! -d "$root" || -L "$root" || "$(cat "$root/.kts-backup-root" 2>/dev/null)" != kts-next-admin ]]; then
  echo 'KTS backup is not installed; refusing an unverified path.' >&2; exit 78
fi
action=${1:-daily}
case "$action" in capture|daily|predeploy|sync|check|restore-local|fetch-restore|restore-downloaded|prune) ;; *) echo 'Unsupported backup action' >&2; exit 64;; esac
# All launch paths, including deploy and manual use, share this lock.
exec 9>"$root/.operation.lock"
/usr/bin/flock --exclusive --wait 1800 9 || { echo 'Backup lock timeout' >&2; exit 75; }
case "$action" in daily|predeploy|sync|check|fetch-restore)
  exec 8>"$root/.upload.lock"
  /usr/bin/flock --exclusive --wait 60 8 || { echo 'Cloud upload lock timeout' >&2; exit 75; };;
esac
/usr/bin/node "$installed/cli.cjs" "$action"
