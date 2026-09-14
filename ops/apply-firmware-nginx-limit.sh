#!/bin/sh
# Local preparation does not apply this helper. Run explicitly as root on the VPS.
set -eu

TARGET=${1:-/etc/nginx/sites-available/kts-next-admin}
if [ "$#" -gt 1 ] || [ "$(id -u)" -ne 0 ]; then
  echo 'Run as root, with at most one explicit virtual-host path.' >&2
  exit 1
fi
case "$TARGET" in
  /*/kts-next-admin) ;;
  *) echo 'Expected an absolute path ending in /kts-next-admin.' >&2; exit 1 ;;
esac
if [ ! -f "$TARGET" ] || [ -L "$TARGET" ]; then
  echo 'Expected a regular, non-symlink virtual-host file.' >&2
  exit 1
fi
PARENT=$(dirname -- "$TARGET")
if [ "$(cd -P -- "$PARENT" && pwd -P)" != "$PARENT" ] || [ "$(wc -c < "$TARGET")" -gt 1048576 ]; then
  echo 'Unexpected virtual-host parent path or file size; no changes applied.' >&2
  exit 1
fi

LOCK="${TARGET}.firmware-limit.lock"
if ! mkdir -- "$LOCK"; then
  echo 'Another helper or an unverified crash lock exists; inspect before retrying.' >&2
  exit 1
fi
BACKUP=''
CANDIDATE=''
RESTORE=''
APPLIED=0
KEEP_BACKUP=0

restore_original() {
  RESTORE=$(mktemp "${TARGET}.restore.XXXXXX") || return 1
  cp -p -- "$BACKUP" "$RESTORE" || return 1
  mv -f -- "$RESTORE" "$TARGET" || return 1
  RESTORE=''
  APPLIED=0
  if nginx -t && systemctl reload nginx; then
    echo "Original configuration restored. Backup: $BACKUP" >&2
    return 0
  fi
  echo "Original file restored, but validation/reload needs administrator attention. Backup: $BACKUP" >&2
  return 1
}

cleanup() {
  status=$?
  trap - 0 HUP INT TERM
  if [ "$APPLIED" -eq 1 ]; then
    if ! restore_original; then
      echo "Automatic recovery did not complete. Retain and inspect backup: $BACKUP" >&2
    fi
    status=1
  fi
  if [ -n "$CANDIDATE" ]; then rm -f -- "$CANDIDATE"; fi
  if [ -n "$RESTORE" ]; then rm -f -- "$RESTORE"; fi
  if [ "$KEEP_BACKUP" -eq 0 ] && [ -n "$BACKUP" ]; then rm -f -- "$BACKUP"; fi
  rmdir -- "$LOCK" || true
  exit "$status"
}
trap cleanup 0
trap 'exit 130' HUP INT TERM

BACKUP=$(mktemp "${TARGET}.backup.XXXXXX")
cp -p -- "$TARGET" "$BACKUP"
CANDIDATE=$(mktemp "${TARGET}.candidate.XXXXXX")

# Inspect complete server/location boundaries, not a global matching directive.
# Copy the existing HTTPS root proxy settings, including any access restrictions;
# reject routing/body directives that cannot safely be inherited here.
awk '
  function clean(value) {
    sub(/#.*/, "", value)
    sub(/^[ \t]+/, "", value)
    sub(/[ \t]+$/, "", value)
    return value
  }
  function reject(message) { print message > "/dev/stderr"; bad=1; exit 42 }
  {
    lines[NR]=$0
    line=clean($0)
    if (index(line, "/api/admin/firmware")) mentions++
    if (depth == 0 && line ~ /^server[ \t]*\{$/) { server++; starts[server]=NR }
    if (depth == 1) {
      if (line ~ /^listen[ \t]+(\[::\]:)?443([ \t;]|$)/) tls[server]=1
      if (line ~ /^server_name[ \t]+kts-impex\.ru[ \t]*;$/) canonical[server]=1
      if (line ~ /^client_max_body_size[ \t]+/) bodies[server]=line
      if (line ~ /^location[ \t]+\/uploads\/[ \t]*\{$/) {
        if (anchors[server]) reject("Duplicate uploads anchor; no changes applied.")
        anchors[server]=NR
      }
      if (line ~ /^location[ \t]+\/[ \t]*\{$/) {
        if (roots[server]) reject("Duplicate root location; no changes applied.")
        roots[server]=NR
      }
      if (line ~ /^location[ \t]+=[ \t]+\/api\/admin\/firmware[ \t]*\{$/) {
        if (firmware[server]) reject("Duplicate firmware location; no changes applied.")
        firmware[server]=NR
      }
    }
    braces=line
    opened=gsub(/\{/, "{", braces)
    closed=gsub(/\}/, "}", braces)
    depth+=opened-closed
    if (depth < 0) reject("Unexpected configuration structure; no changes applied.")
    if (line == "}" && depth == 1) {
      if (roots[server] && !rootEnds[server]) rootEnds[server]=NR
      if (firmware[server] && !firmwareEnds[server]) firmwareEnds[server]=NR
    }
  }
  END {
    if (bad) exit 42
    if (depth != 0) reject("Unbalanced configuration; no changes applied.")
    for (s=1; s<=server; s++) if (tls[s] && canonical[s]) { selected=s; count++ }
    if (count != 1 || !anchors[selected] || !roots[selected] || !rootEnds[selected] ||
        bodies[selected] !~ /^client_max_body_size[ \t]+25m;$/) {
      reject("Expected one canonical HTTPS server with existing 25m limit and proxy locations; no changes applied.")
    }
    if (mentions != (firmware[selected] ? 1 : 0)) reject("Unexpected firmware routing already exists; no changes applied.")
    block[++n]="    location = /api/admin/firmware {"
    block[++n]="        client_max_body_size 26m;"
    block[++n]=""
    for (i=roots[selected]+1; i<rootEnds[selected]; i++) {
      line=clean(lines[i])
      if (line ~ /[{}]/ || line ~ /^(root|alias|try_files|return|rewrite|include|client_max_body_size|location)([ \t;]|$)/) {
        reject("Root location has unsupported routing/body directives; manual review required.")
      }
      if (line == "proxy_pass http://127.0.0.1:3000;") proxy++
      else if (line ~ /^proxy_pass[ \t]/) reject("Unexpected upstream; no changes applied.")
      if (line == "proxy_http_version 1.1;") http++
      if (line ~ /^proxy_set_header[ \t]+Host[ \t]+\$host;$/) host++
      if (line ~ /^proxy_set_header[ \t]+X-Real-IP[ \t]+\$remote_addr;$/) realip++
      if (line ~ /^proxy_set_header[ \t]+X-Forwarded-For[ \t]+\$proxy_add_x_forwarded_for;$/) forwarded++
      if (line ~ /^proxy_set_header[ \t]+X-Forwarded-Proto[ \t]+\$scheme;$/) scheme++
      block[++n]=lines[i]
    }
    block[++n]="    }"
    if (proxy != 1 || http != 1 || host != 1 || realip != 1 || forwarded != 1 || scheme != 1) {
      reject("Expected upstream forwarding settings are missing or duplicated; no changes applied.")
    }
    if (firmware[selected]) {
      if (firmwareEnds[selected]-firmware[selected]+1 != n) reject("Existing firmware location differs; no changes applied.")
      for (i=1; i<=n; i++) if (clean(lines[firmware[selected]+i-1]) != clean(block[i])) {
        reject("Existing firmware location differs; no changes applied.")
      }
    }
    for (i=1; i<=NR; i++) {
      if (!firmware[selected] && i == anchors[selected]) {
        for (j=1; j<=n; j++) print block[j]
        print ""
      }
      print lines[i]
    }
  }
' "$BACKUP" > "$CANDIDATE"

nginx -t
if cmp -s -- "$BACKUP" "$CANDIDATE"; then
  echo 'Firmware upload location is already configured; no changes or reload needed.'
  exit 0
fi
if [ -L "$TARGET" ] || ! cmp -s -- "$BACKUP" "$TARGET"; then
  echo 'Virtual host changed during preparation; no changes applied.' >&2
  exit 1
fi
chmod 0644 "$CANDIDATE"
KEEP_BACKUP=1
# Trap-driven recovery also covers interruption after the atomic replacement.
APPLIED=1
mv -f -- "$CANDIDATE" "$TARGET"
CANDIDATE=''
nginx -t
systemctl reload nginx
APPLIED=0
echo "Firmware upload limit configured: exact HTTPS endpoint, 26m. Backup: $BACKUP"
