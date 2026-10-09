#!/usr/bin/env bash
# Publish web/ through the host's nginx at /swiss-population-grid/ with a shared-password login.
#
#   sudo deploy/install.sh              # prompts for the password (Enter keeps the current one)
#
# Idempotent: re-run it after deploy/ changes, or to change the password (everyone then has to
# sign in again). Expects the repository to be cloned at /var/www/swiss-population-grid, nginx with
# a port-80 default server in /etc/nginx/conf.d/default.conf, and the www-data user.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR=/var/www/swiss-population-grid
LOGIN_DIR=/var/www/swiss-population-grid-login
GEO_CACHE=/var/cache/nginx/swiss-population-grid
HTTP_CONF=/etc/nginx/conf.d/swiss-population-grid.conf
SNIPPET=/etc/nginx/snippets/swiss-population-grid.conf
DEFAULT_SERVER=/etc/nginx/conf.d/default.conf
INCLUDE_LINE="    include $SNIPPET;"

[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)." >&2; exit 1; }
[[ -f "$APP_DIR/web/index.html" ]] || { echo "Expected the repository at $APP_DIR." >&2; exit 1; }
[[ -f "$DEFAULT_SERVER" ]] || { echo "Expected nginx's default server in $DEFAULT_SERVER." >&2; exit 1; }
id www-data >/dev/null 2>&1 || { echo "Expected nginx to run as www-data." >&2; exit 1; }

# The token is what the login page puts in its cookie: SHA-256("spg-v1:" + password).
CURRENT="$(grep -oE '[0-9a-f]{64}' "$HTTP_CONF" 2>/dev/null | head -n1 || true)"
IFS= read -rsp "Password for the web app${CURRENT:+ (Enter keeps the current one)}: " PASSWORD; echo
if [[ -z "$PASSWORD" && -n "$CURRENT" ]]; then
  TOKEN="$CURRENT"
else
  [[ -n "$PASSWORD" ]] || { echo "Empty password." >&2; exit 1; }
  IFS= read -rsp "Repeat it: " AGAIN; echo
  [[ "$PASSWORD" == "$AGAIN" ]] || { echo "The passwords differ." >&2; exit 1; }
  TOKEN="$(printf '%s' "spg-v1:$PASSWORD" | sha256sum | cut -d' ' -f1)"
fi

install -d -m 755 "$LOGIN_DIR" "$(dirname "$SNIPPET")"
install -d -m 700 -o www-data -g www-data "$GEO_CACHE"
install -m 644 "$HERE/login.html" "$LOGIN_DIR/index.html"
install -m 644 "$HERE/nginx-locations.conf" "$SNIPPET"

umask 027
cat > "$HTTP_CONF" <<EOF
# Swiss population grid – http-level part of the shared-password login (see $SNIPPET).
# Written by deploy/install.sh; the cookie holds SHA-256("spg-v1:" + password).
# (an anchored regex, because a 64-character key would not fit nginx's default map hash bucket)
map \$cookie_spg_auth \$spg_authed {
    default 0;
    "~^$TOKEN\$" 1;
}
map \$spg_authed \$spg_guess_key {
    1 "";
    default \$binary_remote_addr;
}
limit_req_zone \$spg_guess_key zone=spg_guess:1m rate=20r/m;
# Local copies of swisstopo responses (see the geo/ locations in $SNIPPET); unused entries stay a year.
proxy_cache_path $GEO_CACHE levels=1:2 keys_zone=spg_geo:50m max_size=20g inactive=365d use_temp_path=off;
EOF
chgrp www-data "$HTTP_CONF" 2>/dev/null || true
chmod 640 "$HTTP_CONF"

if ! grep -qF "$SNIPPET" "$DEFAULT_SERVER"; then
  cp -p "$DEFAULT_SERVER" "$DEFAULT_SERVER.bak-$(date +%Y%m%d%H%M%S)"
  # Add the include right after the first server_name of the default port-80 server.
  sed -i "0,/^\s*server_name .*;/s||&\n$INCLUDE_LINE|" "$DEFAULT_SERVER"
  grep -qF "$SNIPPET" "$DEFAULT_SERVER" || { echo "No server_name line in $DEFAULT_SERVER; add \"$INCLUDE_LINE\" to its server block." >&2; exit 1; }
fi

nginx -t
systemctl reload nginx
echo "Published at http://$(hostname -I | awk '{print $1}')/swiss-population-grid/"
