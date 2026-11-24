#!/bin/bash
# One-shot, networkless volume initializer for the one-app image (runs as
# container root with only CAP_CHOWN and CAP_FOWNER). Same layout and modes as
# the Linux installer: owner-only private state, a shared job store and notes
# copy in the share group, the publisher socket directory reachable by the group.
# Without DAC override, every directory is created first and handed over
# deepest first, so a parent is never closed before its children are done.
set -euo pipefail
LAYOUT=(
  "/var/lib/cyberbaser cyberbaser:cyberbaser-share 0700"
  "/var/lib/cyberbaser/home cyberbaser:cyberbaser-share 0700"
  "/var/lib/cyberbaser/cache cyberbaser:cyberbaser-share 0700"
  "/var/lib/cyberbaser/config cyberbaser:cyberbaser-share 0700"
  "/var/lib/cyberbaser/iroh cyberbaser:cyberbaser-share 0700"
  "/var/lib/cyberbaser/setup cyberbaser:cyberbaser-share 0700"
  "/var/lib/cyberbaser/run cyberbaser:cyberbaser-share 0700"
  "/var/lib/cyberbaser-shared/workspace cyberbaser:cyberbaser-share 0770"
  "/var/lib/cyberbaser-shared/workspace/owner-alpha cyberbaser:cyberbaser-share 0710"
  "/var/lib/cyberbaser-shared/workspace/owner-alpha/store cyberbaser:cyberbaser-share 0710"
  "/var/lib/cyberbaser-shared/workspace/owner-alpha/store/jobs cyberbaser:cyberbaser-share 0770"
  "/var/lib/cyberbaser-shared/notes cyberbaser:cyberbaser-share 0770"
  "/var/lib/cyberbaser-publisher cyberbaser-publisher:cyberbaser-share 0700"
  "/run/cyberbaser-publisher cyberbaser-publisher:cyberbaser-share 0710"
)
for entry in "${LAYOUT[@]}"; do read -r path _ _ <<<"$entry"; mkdir -p "$path"; done
# What first-run setup needs (the installer writes the same file on a desktop).
if [ ! -e /var/lib/cyberbaser/layout.json ]; then
  cat > /var/lib/cyberbaser/layout.json <<'JSON'
{
  "listen": { "host": "127.0.0.1", "port": 4317 },
  "reviewSocket": "/var/lib/cyberbaser/run/review.sock",
  "irohStateDirectory": "/var/lib/cyberbaser/iroh",
  "forgeStateDirectory": "/var/lib/cyberbaser-publisher/forge",
  "configFile": "/var/lib/cyberbaser/config/owner-alpha.json",
  "checkout": "/var/lib/cyberbaser-shared/notes/notes"
}
JSON
  chmod 0600 /var/lib/cyberbaser/layout.json
  chown cyberbaser:cyberbaser-share /var/lib/cyberbaser/layout.json
fi
for ((i=${#LAYOUT[@]} - 1; i >= 0; i--)); do
  read -r path owner mode <<<"${LAYOUT[$i]}"
  chmod "$mode" "$path"
  chown "$owner" "$path"
done
echo "cyberbaser volumes ready"
