#!/bin/bash
# Disable inherited tracing before any credential can enter shell variables.
set +xv
set -Eeuo pipefail
umask 077
export PATH=/usr/bin:/bin LC_ALL=C
readonly root=/home/kts/backups/kts-next-admin
readonly config_dir=/home/kts/.config/kts-backup
readonly config_file="$config_dir/config.json"
readonly aws_config="$config_dir/aws-config"
readonly aws_credentials="$config_dir/aws-credentials"

[[ "$(id -un)" == kts && "$(id -u)" != 0 ]] || { echo 'Run credential setup as kts' >&2; exit 78; }
[[ $# == 0 ]] || { echo 'This command accepts no arguments or credential values' >&2; exit 64; }
[[ -t 0 && -t 1 ]] || { echo 'An interactive TTY is required; connect using ssh -t' >&2; exit 64; }
for directory in "$root" "$config_dir"; do
  [[ -d "$directory" && ! -L "$directory" && "$(realpath -- "$directory")" == "$directory" \
    && "$(stat -c '%U:%a' -- "$directory")" == kts:700 ]] || { echo 'Private directory guard failed' >&2; exit 78; }
done
[[ -f "$root/.kts-backup-root" && ! -L "$root/.kts-backup-root" \
  && "$(cat "$root/.kts-backup-root")" == kts-next-admin ]] || { echo 'Backup root marker guard failed' >&2; exit 78; }
[[ -f "$config_file" && ! -L "$config_file" && "$(realpath -- "$config_file")" == "$config_file" \
  && "$(stat -c '%U:%a' -- "$config_file")" == kts:600 ]] || { echo 'Private project configuration guard failed' >&2; exit 78; }
exec 9>"$root/.operation.lock"
/usr/bin/flock --exclusive --wait 1800 9 || { echo 'Credential setup lock timeout' >&2; exit 75; }
if [[ -e "$aws_config" || -L "$aws_config" || -e "$aws_credentials" || -L "$aws_credentials" ]]; then
  echo 'AWS files already exist; refusing to overwrite them' >&2; exit 78
fi
/usr/bin/node - "$config_file" "$root" "$config_dir" <<'NODE'
const fs = require('node:fs');
try {
  const [file, root, directory] = process.argv.slice(2);
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cloud = config.cloud;
  if (config.project !== 'kts-next-admin' || config.root !== root || !cloud
      || cloud.profile !== 'kts-backup' || cloud.region !== 'ru-central1'
      || cloud.endpoint !== 'https://storage.yandexcloud.net'
      || cloud.configFile !== directory + '/aws-config'
      || cloud.credentialsFile !== directory + '/aws-credentials') throw new Error();
} catch { console.error('Audited project/AWS profile guard failed'); process.exit(78); }
NODE

exec 3<>/dev/tty
tty_saved=$(stty -g <&3)
credentials_tmp=''
config_tmp=''
# Discard any inherited export attribute before accepting sensitive input.
unset access_key_id secret_access_key
access_key_id=''
secret_access_key=''
completed=0
cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  stty "$tty_saved" <&3 2>/dev/null || true
  unset access_key_id secret_access_key
  if [[ $completed != 1 ]]; then
    if [[ -n "$credentials_tmp" && -f "$aws_credentials" && ! -L "$aws_credentials" \
      && "$aws_credentials" -ef "$credentials_tmp" ]]; then rm -f -- "$aws_credentials"; fi
    if [[ -n "$config_tmp" && -f "$aws_config" && ! -L "$aws_config" \
      && "$aws_config" -ef "$config_tmp" ]]; then rm -f -- "$aws_config"; fi
  fi
  if [[ -n "$credentials_tmp" && "$credentials_tmp" == "$config_dir"/.aws-credentials.* \
    && -f "$credentials_tmp" && ! -L "$credentials_tmp" ]]; then rm -f -- "$credentials_tmp"; fi
  if [[ -n "$config_tmp" && "$config_tmp" == "$config_dir"/.aws-config.* \
    && -f "$config_tmp" && ! -L "$config_tmp" ]]; then rm -f -- "$config_tmp"; fi
  exec 3>&-
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
stty -echo <&3
builtin printf 'Paste Access Key ID (hidden), then Enter: ' >&3
IFS= builtin read -r -s -u 3 access_key_id
builtin printf '\n' >&3
[[ ${#access_key_id} -ge 10 && ${#access_key_id} -le 128 && "$access_key_id" =~ ^[A-Za-z0-9_-]+$ ]] || { echo 'Invalid access key ID; nothing installed' >&2; exit 64; }
builtin printf 'Paste Secret Access Key (hidden), then Enter: ' >&3
IFS= builtin read -r -s -u 3 secret_access_key
builtin printf '\n' >&3
[[ ${#secret_access_key} -ge 20 && ${#secret_access_key} -le 256 && "$secret_access_key" =~ ^[A-Za-z0-9/+=_-]+$ ]] || { echo 'Invalid secret access key; nothing installed' >&2; exit 64; }

config_tmp=$(mktemp "$config_dir/.aws-config.XXXXXXXX")
credentials_tmp=$(mktemp "$config_dir/.aws-credentials.XXXXXXXX")
chmod 600 -- "$config_tmp" "$credentials_tmp"
builtin printf '[profile kts-backup]\nregion = ru-central1\nendpoint_url = https://storage.yandexcloud.net\noutput = json\n' > "$config_tmp"
# Bash builtin arguments remain inside this process, never in an external argv.
builtin printf '[kts-backup]\naws_access_key_id = %s\naws_secret_access_key = %s\n' \
  "$access_key_id" "$secret_access_key" > "$credentials_tmp"
unset access_key_id secret_access_key
/usr/bin/node -e 'const fs=require("node:fs");for(const file of process.argv.slice(1)){const fd=fs.openSync(file,"r");try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}' "$config_tmp" "$credentials_tmp"
# Atomic no-clobber publication. Hard links cannot overwrite a racing file;
# if the second publication fails, EXIT removes only our first owned link.
ln -- "$config_tmp" "$aws_config"
ln -- "$credentials_tmp" "$aws_credentials"
/usr/bin/node -e 'const fs=require("node:fs");const fd=fs.openSync(process.argv[1],"r");try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}' "$config_dir"
completed=1
builtin printf 'Private AWS profile installed: kts-backup\n'
builtin printf 'Cloud access is not enabled by this command.\n'
