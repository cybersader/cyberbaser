#!/usr/bin/env bash
# One-click owner-alpha launcher: starts the servers, waits for the one-time
# bootstrap URL, and opens it in the default browser so the owner lands on the
# wiki already signed in. The bootstrap token stays in process memory and a
# mode-0600 temporary log; it is consumed immediately by the opened browser.
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

LOG="$(mktemp)"
cleanup() {
  rm -f "$LOG"
}
trap cleanup EXIT

# Keep the server's stdin on the real terminal when one is actually usable so
# the owner can enter 'b' for additional one-time sign-in links; background
# jobs would otherwise inherit a closed stdin. The node can exist without a
# controlling terminal (headless runs), so probe an actual open.
if { : < /dev/tty; } 2>/dev/null; then
  bash "$HERE/start.sh" "$@" < /dev/tty > >(tee "$LOG") 2>&1 &
else
  echo "==> no terminal: interactive 'b' sign-in links are unavailable this run"
  bash "$HERE/start.sh" "$@" < /dev/null > >(tee "$LOG") 2>&1 &
fi
SERVER_PID=$!

open_url() {
  local url="$1"
  if command -v wslview >/dev/null 2>&1; then
    wslview "$url" >/dev/null 2>&1 && return 0
  fi
  if command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command "Start-Process '$url'" >/dev/null 2>&1 && return 0
  fi
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 && return 0
  fi
  return 1
}

# The first launch can take minutes (Quartz build); later launches reuse the
# cached site and are fast. Poll the captured output for the first bootstrap
# URL on whatever private numeric IPv4 address the config selected.
BOOTSTRAP=""
for _ in $(seq 1 1800); do
  BOOTSTRAP="$(grep -oE 'Owner alpha bootstrap: http://[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+/owner/bootstrap\?token=[A-Za-z0-9_-]{43}' "$LOG" | head -n 1 | sed 's/^Owner alpha bootstrap: //' || true)"
  if [ -n "$BOOTSTRAP" ]; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    printf 'ERROR: owner-alpha exited before printing the bootstrap URL\n' >&2
    wait "$SERVER_PID" || true
    exit 1
  fi
  sleep 1
done

if [ -z "$BOOTSTRAP" ]; then
  printf 'ERROR: timed out waiting for the owner-alpha bootstrap URL\n' >&2
  kill "$SERVER_PID" 2>/dev/null || true
  exit 1
fi

if open_url "$BOOTSTRAP"; then
  printf '==> opened the wiki in your browser (signed in)\n'
else
  printf '==> could not open a browser automatically; open this one-time URL yourself:\n%s\n' "$BOOTSTRAP"
fi
printf '==> keep this window open; enter b then Enter for a one-time sign-in link for another device\n'

wait "$SERVER_PID"
