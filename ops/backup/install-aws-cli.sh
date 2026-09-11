#!/usr/bin/env bash
# Root-free AWS CLI v2 installation for the audited KTS Linux x86_64 host.
# Vendor instructions/key: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html
# No credentials, S3 calls, system package changes, or automatic upgrades.
set -Eeuo pipefail
umask 077
export PATH=/usr/bin:/bin
export LC_ALL=C

fail() { printf 'AWS CLI installation failed: %s\n' "$1" >&2; exit 1; }
[[ $# == 0 ]] || fail 'this installer accepts no arguments'
[[ $(id -un) == kts && $(id -u) != 0 ]] || fail 'run as the unprivileged kts user'
[[ $(uname -sm) == 'Linux x86_64' ]] || fail 'requires Linux x86_64'

readonly install_root=/home/kts/.local/aws-cli
readonly bin_root=/home/kts/.local/bin
readonly expected_fingerprint=FB5DB77FD5C118B80511ADA8A6310ACC4672475C
readonly vendor_zip=https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip
readonly installer_uid=$(id -u)

for binary in curl unzip gpg gpgconf sha256sum stat readlink awk find mktemp install flock timeout df env; do
  command -v "$binary" >/dev/null || fail "missing prerequisite: $binary"
done

# Refuse symlinked/shared install parents and never replace an existing CLI.
for directory in /home/kts /home/kts/.local; do
  [[ -d $directory && ! -L $directory ]] || fail 'unsafe installation parent'
  [[ $(stat -c %u "$directory") == "$installer_uid" ]] || fail 'unexpected installation parent owner'
  (( (8#$(stat -c %a "$directory") & 0002) == 0 )) || fail 'world-writable installation parent'
done
for target in "$install_root" "$bin_root/aws" "$bin_root/aws_completer"; do
  [[ ! -e $target && ! -L $target ]] || fail 'an AWS CLI target already exists; inspect it before updating'
done
if [[ -e $bin_root || -L $bin_root ]]; then
  [[ -d $bin_root && ! -L $bin_root ]] || fail 'unsafe binary directory'
  [[ $(stat -c %u "$bin_root") == "$installer_uid" ]] || fail 'unexpected binary directory owner'
  (( (8#$(stat -c %a "$bin_root") & 0022) == 0 )) || fail 'shared-writable binary directory'
fi
available_kib=$(df -Pk /home/kts/.local | awk 'NR == 2 { print $4 }')
[[ $available_kib =~ ^[0-9]+$ ]] && (( available_kib >= 1048576 )) || fail 'at least 1 GiB free disk is required'

# The audited .local parent was775; remove only group/world write permission.
chmod go-w /home/kts/.local
install -d -m 700 "$bin_root"
[[ ! -L /home/kts/.local/.kts-aws-cli-install.lock ]] || fail 'unsafe installer lock'
exec 9>/home/kts/.local/.kts-aws-cli-install.lock
flock -n 9 || fail 'another installer is active'
# Repeat target checks while locked.
for target in "$install_root" "$bin_root/aws" "$bin_root/aws_completer"; do
  [[ ! -e $target && ! -L $target ]] || fail 'an AWS CLI target appeared while acquiring the lock'
done

installer_tmp=$(mktemp -d /tmp/kts-aws-cli-install.XXXXXXXXXX)
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  if [[ $installer_tmp =~ ^/tmp/kts-aws-cli-install\.[A-Za-z0-9]{10}$ && -d $installer_tmp && ! -L $installer_tmp ]] \
    && [[ $(stat -c %u "$installer_tmp") == "$installer_uid" ]] \
    && [[ $(readlink -f "$installer_tmp") == "$installer_tmp" ]]; then
    gpgconf --homedir "$installer_tmp/gnupg" --kill all >/dev/null 2>&1 || true
    # Only the exact private mktemp tree owned by this invocation is removed.
    if ! find "$installer_tmp" -xdev -depth -delete; then
      printf 'AWS CLI installer temporary cleanup failed; inspect its private directory.\n' >&2
      result=1
    fi
  else
    printf 'AWS CLI installer refused unsafe temporary cleanup.\n' >&2
    result=1
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
install -d -m 700 "$installer_tmp/gnupg"

# Public signing key copied from the vendor guide, checked against the pinned
# full fingerprint below. It is intentionally not fetched from a keyserver.
printf '%s\n' '-----BEGIN PGP PUBLIC KEY BLOCK-----

mQINBF2Cr7UBEADJZHcgusOJl7ENSyumXh85z0TRV0xJorM2B/JL0kHOyigQluUG
ZMLhENaG0bYatdrKP+3H91lvK050pXwnO/R7fB/FSTouki4ciIx5OuLlnJZIxSzx
PqGl0mkxImLNbGWoi6Lto0LYxqHN2iQtzlwTVmq9733zd3XfcXrZ3+LblHAgEt5G
TfNxEKJ8soPLyWmwDH6HWCnjZ/aIQRBTIQ05uVeEoYxSh6wOai7ss/KveoSNBbYz
gbdzoqI2Y8cgH2nbfgp3DSasaLZEdCSsIsK1u05CinE7k2qZ7KgKAUIcT/cR/grk
C6VwsnDU0OUCideXcQ8WeHutqvgZH1JgKDbznoIzeQHJD238GEu+eKhRHcz8/jeG
94zkcgJOz3KbZGYMiTh277Fvj9zzvZsbMBCedV1BTg3TqgvdX4bdkhf5cH+7NtWO
lrFj6UwAsGukBTAOxC0l/dnSmZhJ7Z1KmEWilro/gOrjtOxqRQutlIqG22TaqoPG
fYVN+en3Zwbt97kcgZDwqbuykNt64oZWc4XKCa3mprEGC3IbJTBFqglXmZ7l9ywG
EEUJYOlb2XrSuPWml39beWdKM8kzr1OjnlOm6+lpTRCBfo0wa9F8YZRhHPAkwKkX
XDeOGpWRj4ohOx0d2GWkyV5xyN14p2tQOCdOODmz80yUTgRpPVQUtOEhXQARAQAB
tCFBV1MgQ0xJIFRlYW0gPGF3cy1jbGlAYW1hem9uLmNvbT6JAlQEEwEIAD4CGwMF
CwkIBwIGFQoJCAsCBBYCAwECHgECF4AWIQT7Xbd/1cEYuAURraimMQrMRnJHXAUC
akV0ygUJDqP4lQAKCRCmMQrMRnJHXFHjD/9eyZLYcKuQOlLvtqSDtUBiEZf6ZZjM
i3ygYH8rJNtuToUH+HvSpe819urJCquXhDrlK6N+aqW0hCLtNABJG/vsafIgvIYJ
hSGgpgtNnQyMV1jViRWqPjbouw8OkYKBThUfT1i2Y+wn58ifs6ODBCmTexWtXspA
Si+Gt49xDOW0APmbOPnI+a4HJW6tVEo6MWS0WjzpiBayR3d1A4pt4YrPfSdDgpLo
h2SLQqlRqvvVZJaWBjhkErNFpfsBA06sDcPEOb0G8LBUbR4WOcdvhe5LubJbZuxC
AG9kNPCVeQP1ixwjgjXKysaxeQ6rv0VzIQgRp6tLVLWhy6AKDNvLjFSsmXZ1Wl08
Y/RlOHXlzLuQMRE6sR1wOdRxc9TsrNWTGiBK65cvSWOy03JeBkQQ8pesqltiyxI9
U21kkgiXtTSKNGfKK8pO27D81YANhRqPK7iTp6kuFiY2WtOg90KTMNlIT+Ff85Y2
b1rHj6Z0SrCkJujhWk3IBPic/wJgz01LEc/OAdUPlby90RJZcIBhSlWhT7mXnXIO
c0HWlNQrns2s3CTyYwZSiSlYe9ApeLwhjDo8NhbFuCAy61l6O5UsR4AfZxx/rGKv
2wFb1/RN/P4gNe6vmxZAPjR0AQcwD3tc2McimOLr/22kmPz8IH3I0X7WoSFr0Biz
E91G7bb0hOb/cA==
=knv7
-----END PGP PUBLIC KEY BLOCK-----' >"$installer_tmp/aws-public-key.asc"

gpg --no-options --batch --homedir "$installer_tmp/gnupg" --with-colons \
  --show-keys "$installer_tmp/aws-public-key.asc" >"$installer_tmp/key-info" 2>"$installer_tmp/key-errors" \
  || fail 'cannot inspect the vendor signing key'
awk -F: -v expected="$expected_fingerprint" \
  '$1 == "pub" { keys++ } $1 == "fpr" { fingerprints++; if ($10 != expected) bad=1 } END { exit !(keys == 1 && fingerprints == 1 && !bad) }' \
  "$installer_tmp/key-info" || fail 'vendor public key fingerprint mismatch'
gpg --no-options --batch --homedir "$installer_tmp/gnupg" --import "$installer_tmp/aws-public-key.asc" \
  >"$installer_tmp/import-log" 2>&1 || fail 'cannot import the verified public key'

printf 'Downloading official AWS CLI v2 package and detached signature.\n'
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --connect-timeout 20 --max-time 300 --retry 3 --retry-max-time 600 \
  --output "$installer_tmp/awscliv2.zip" "$vendor_zip"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --connect-timeout 20 --max-time 60 --retry 3 --retry-max-time 180 \
  --output "$installer_tmp/awscliv2.sig" "$vendor_zip.sig"

gpg --no-options --batch --homedir "$installer_tmp/gnupg" --status-fd 1 \
  --verify "$installer_tmp/awscliv2.sig" "$installer_tmp/awscliv2.zip" \
  >"$installer_tmp/signature-status" 2>"$installer_tmp/signature-errors" \
  || fail 'vendor package signature verification failed'
awk -v expected="$expected_fingerprint" '
  $1 == "[GNUPG:]" && $2 == "VALIDSIG" && $3 == expected { valid++ }
  $1 == "[GNUPG:]" && $2 ~ /^(ERRSIG|BADSIG|EXPSIG|EXPKEYSIG|REVKEYSIG|KEYEXPIRED|SIGEXPIRED|KEYREVOKED)$/ { bad=1 }
  END { exit !(valid == 1 && !bad) }
' "$installer_tmp/signature-status" || fail 'package is not validly signed by the pinned active AWS key'
archive_sha256=$(sha256sum "$installer_tmp/awscliv2.zip" | awk '{ print $1 }')
printf 'Vendor signature verified; package SHA256: %s\n' "$archive_sha256"

unzip -q "$installer_tmp/awscliv2.zip" -d "$installer_tmp/unpacked"
[[ -f $installer_tmp/unpacked/aws/install && ! -L $installer_tmp/unpacked/aws/install ]] \
  || fail 'vendor installer missing from the verified archive'
timeout --signal=TERM --kill-after=15 180 \
  "$installer_tmp/unpacked/aws/install" --install-dir "$install_root" --bin-dir "$bin_root"

resolved_aws=$(readlink -f "$bin_root/aws")
[[ $resolved_aws == "$install_root"/v2/*/dist/aws && -f $resolved_aws ]] \
  || fail 'installed executable resolved outside its dedicated directory'
[[ $(stat -c %u "$resolved_aws") == "$installer_uid" ]] || fail 'installed executable has an unexpected owner'
(( (8#$(stat -c %a "$resolved_aws") & 0022) == 0 )) || fail 'installed executable is shared-writable'

# Empty configuration, no signing, no ambient credential/provider environment.
# Input skeleton generation is local and does not send any AWS/S3 request.
aws_version=$(env -i PATH=/usr/bin:/bin LC_ALL=C AWS_EC2_METADATA_DISABLED=true \
  AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_CLI_AUTO_PROMPT=off \
  AWS_PAGER='' "$bin_root/aws" --version)
[[ $aws_version == aws-cli/2.* ]] || fail 'installed executable is not AWS CLI v2'
timeout --signal=TERM --kill-after=5 30 env -i PATH=/usr/bin:/bin LC_ALL=C \
  AWS_EC2_METADATA_DISABLED=true AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null \
  AWS_CLI_AUTO_PROMPT=off AWS_PAGER='' "$bin_root/aws" s3api put-object \
  --generate-cli-skeleton input --no-sign-request --region ru-central1 >"$installer_tmp/put-object-skeleton.json"
awk '/"IfNoneMatch"[[:space:]]*:/ { supported=1 } END { exit !supported }' \
  "$installer_tmp/put-object-skeleton.json" || fail 'AWS CLI lacks required IfNoneMatch support'
printf 'Installed: %s\nBinary: %s\nOffline IfNoneMatch validation: OK\n' "$aws_version" "$resolved_aws"
