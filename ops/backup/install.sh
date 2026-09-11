#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ "$(id -un)" == kts && "$(id -u)" != 0 ]] || { echo 'Run as kts, not root' >&2; exit 1; }
readonly source_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
readonly target=/home/kts/.local/lib/kts-backup
readonly config_dir=/home/kts/.config/kts-backup
readonly root=/home/kts/backups/kts-next-admin
if [[ -L "$root" || -L "$target" || -L "$config_dir" ]]; then echo 'Refusing symlink installation path' >&2; exit 1; fi
if [[ -e "$root" && ! -f "$root/.kts-backup-root" ]]; then echo 'Existing unmarked backup root requires review' >&2; exit 1; fi
install -d -m 700 "$root" "$target" "$config_dir" /home/kts/.config/systemd/user
if [[ ! -e "$root/.kts-backup-root" ]]; then printf 'kts-next-admin\n' > "$root/.kts-backup-root"; fi
[[ "$(cat "$root/.kts-backup-root")" == kts-next-admin ]] || exit 1
# Do not replace runtime files while a capture/upload/restore is running.
exec 9>"$root/.operation.lock"
/usr/bin/flock --exclusive --wait 1800 9 || { echo 'Backup install lock timeout' >&2; exit 75; }
for file in common.cjs cli.cjs capture.cjs cloud.cjs restore.cjs notify.cjs configure.cjs; do install -m 600 "$source_dir/$file" "$target/$file"; done
install -m 600 "$source_dir/package.json" "$target/package.json"
install -m 600 "$source_dir/package-lock.json" "$target/package-lock.json"
npm ci --prefix "$target" --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
install -m 700 "$source_dir/run.sh" "$target/run.sh"
install -m 700 "$source_dir/configure.sh" "$target/configure.sh"
install -m 700 "$source_dir/configure-credentials.sh" "$target/configure-credentials.sh"
if [[ ! -e "$config_dir/config.json" ]]; then install -m 600 "$source_dir/config.example.json" "$config_dir/config.json"; fi
for unit in "$source_dir"/systemd/*; do install -m 600 "$unit" /home/kts/.config/systemd/user/; done
systemctl --user daemon-reload
echo 'KTS backup files installed. Schedule remains unchanged; enable only after cloud setup and restore verification.'
