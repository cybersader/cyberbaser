#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER_DIR="$(cd "$HERE/.." && pwd)"

bun "$HERE/edit-links.test.ts"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
mkdir -p "$TMP_DIR/content" "$TMP_DIR/quartz/quartz"

set +e
CYBERBASER_EDIT_LINK_MODE=preview \
  "$WRAPPER_DIR/build.sh" "$TMP_DIR/content" "$TMP_DIR/quartz" \
  >"$TMP_DIR/invalid-mode.log" 2>&1
INVALID_STATUS=$?
CI=TRUE CYBERBASER_EDIT_LINK_MODE=owner \
  "$WRAPPER_DIR/build.sh" "$TMP_DIR/content" "$TMP_DIR/quartz" \
  >"$TMP_DIR/owner-ci.log" 2>&1
OWNER_CI_STATUS=$?
set -e

if [ "$INVALID_STATUS" -ne 2 ]; then
  echo "expected invalid edit mode to exit 2, got $INVALID_STATUS" >&2
  exit 1
fi
if ! grep -q "CYBERBASER_EDIT_LINK_MODE must be 'public' or 'owner'" "$TMP_DIR/invalid-mode.log"; then
  echo "invalid edit mode did not report the expected error" >&2
  exit 1
fi
if [ "$OWNER_CI_STATUS" -ne 1 ]; then
  echo "expected owner mode in CI to exit 1, got $OWNER_CI_STATUS" >&2
  exit 1
fi
if ! grep -q "CYBERBASER_EDIT_LINK_MODE=owner is disabled in CI" "$TMP_DIR/owner-ci.log"; then
  echo "owner mode in CI did not report the expected error" >&2
  exit 1
fi

# Owner-origin guard: public and hostname origins are rejected before any
# build step; a valid private origin passes the guard. The private case uses a
# bare directory without a Quartz checkout so the run stops right after the
# origin guard (exit 1, "not a Quartz checkout") instead of invoking npx.
mkdir -p "$TMP_DIR/quartz-shell"
set +e
CYBERBASER_EDIT_LINK_MODE=owner CYBERBASER_OWNER_ORIGIN='http://8.8.8.8:4317' \
  "$WRAPPER_DIR/build.sh" "$TMP_DIR/content" "$TMP_DIR/quartz" \
  >"$TMP_DIR/owner-public-ip.log" 2>&1
PUBLIC_IP_STATUS=$?
CYBERBASER_EDIT_LINK_MODE=owner CYBERBASER_OWNER_ORIGIN='http://wiki.internal:4317' \
  "$WRAPPER_DIR/build.sh" "$TMP_DIR/content" "$TMP_DIR/quartz" \
  >"$TMP_DIR/owner-hostname.log" 2>&1
HOSTNAME_STATUS=$?
CYBERBASER_EDIT_LINK_MODE=owner CYBERBASER_OWNER_ORIGIN='http://100.100.100.100:4317' \
  "$WRAPPER_DIR/build.sh" "$TMP_DIR/content" "$TMP_DIR/quartz-shell" \
  >"$TMP_DIR/owner-private.log" 2>&1
PRIVATE_STATUS=$?
set -e

if [ "$PUBLIC_IP_STATUS" -ne 2 ]; then
  echo "expected a public owner origin to exit 2, got $PUBLIC_IP_STATUS" >&2
  exit 1
fi
if [ "$HOSTNAME_STATUS" -ne 2 ]; then
  echo "expected a hostname owner origin to exit 2, got $HOSTNAME_STATUS" >&2
  exit 1
fi
if [ "$PRIVATE_STATUS" -ne 1 ] || ! grep -q "not a Quartz checkout" "$TMP_DIR/owner-private.log"; then
  echo "expected a private RFC 6598 owner origin to pass the origin guard and stop at the checkout check" >&2
  cat "$TMP_DIR/owner-private.log" >&2
  exit 1
fi

printf 'build-mode guard checks passed\n'
