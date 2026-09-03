#!/bin/sh
set -eu

TARGET=${1:-/etc/nginx/sites-available/kts-next-admin}
LOCATION_MARKER='location ~ ^/api/admin/top-dashboard/blocks/[1-9][0-9]*/data/?$ {'

if [ "$(id -u)" -ne 0 ]; then
  echo 'Run this helper as root.' >&2
  exit 1
fi

if [ ! -f "$TARGET" ]; then
  echo "Nginx virtual host not found: $TARGET" >&2
  exit 1
fi

if grep -Fq "$LOCATION_MARKER" "$TARGET"; then
  for directive in \
    'client_max_body_size 501m;' \
    'proxy_request_buffering off;' \
    'proxy_read_timeout 10m;' \
    'proxy_send_timeout 10m;'
  do
    if ! grep -Fq "$directive" "$TARGET"; then
      echo "Existing upload location is missing: $directive" >&2
      exit 1
    fi
  done
  nginx -t
  systemctl reload nginx
  echo 'TOP dashboard upload location is already configured.'
  exit 0
fi

CANDIDATE=$(mktemp "${TARGET}.candidate.XXXXXX")
BACKUP="${TARGET}.backup.$(date -u +%Y%m%dT%H%M%SZ)"
trap 'rm -f -- "$CANDIDATE"' EXIT

awk '
  $0 == "    location /uploads/ {" && inserted == 0 {
    print "    location ~ ^/api/admin/top-dashboard/blocks/[1-9][0-9]*/data/?$ {"
    print "        client_max_body_size 501m;"
    print "        client_body_timeout 10m;"
    print ""
    print "        proxy_pass http://127.0.0.1:3000;"
    print "        proxy_http_version 1.1;"
    print "        proxy_request_buffering off;"
    print "        proxy_read_timeout 10m;"
    print "        proxy_send_timeout 10m;"
    print "        proxy_set_header Host $host;"
    print "        proxy_set_header X-Real-IP $remote_addr;"
    print "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;"
    print "        proxy_set_header X-Forwarded-Proto $scheme;"
    print "    }"
    print ""
    inserted = 1
  }
  { print }
  END { if (inserted != 1) exit 42 }
' "$TARGET" > "$CANDIDATE" || {
  echo 'Could not find the expected /uploads/ location; no changes applied.' >&2
  exit 1
}

cp -a -- "$TARGET" "$BACKUP"
install -o root -g root -m 0644 "$CANDIDATE" "$TARGET"

if ! nginx -t; then
  cp -a -- "$BACKUP" "$TARGET"
  nginx -t
  echo "Invalid candidate restored from $BACKUP" >&2
  exit 1
fi

if ! systemctl reload nginx; then
  cp -a -- "$BACKUP" "$TARGET"
  nginx -t
  systemctl reload nginx
  echo "Reload failed; configuration restored from $BACKUP" >&2
  exit 1
fi

echo "Nginx configured successfully. Backup: $BACKUP"
