#!/usr/bin/env bash
# Materialize a pinned Quartz checkout and lay this renderer's config over it.
# Idempotent: safe to re-run; re-pins an existing checkout to QUARTZ_REF.
#
# Usage: ./setup.sh [QUARTZ_DIR]
#   QUARTZ_DIR defaults to ~/bench/quartz-site
set -euo pipefail

QUARTZ_REPO="${QUARTZ_REPO:-https://github.com/jackyzha0/quartz.git}"
# Pinned. Do not bump without re-running the OFM conformance suite (see README).
QUARTZ_REF="${QUARTZ_REF:-v4.5.2}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUARTZ_DIR="${1:-$HOME/bench/quartz-site}"

echo "==> quartz repo : $QUARTZ_REPO"
echo "==> pinned ref  : $QUARTZ_REF"
echo "==> target dir  : $QUARTZ_DIR"

if [ ! -d "$QUARTZ_DIR/.git" ]; then
  if [ -e "$QUARTZ_DIR" ] && [ -n "$(ls -A "$QUARTZ_DIR" 2>/dev/null || true)" ]; then
    echo "ERROR: $QUARTZ_DIR exists, is non-empty, and is not a git checkout." >&2
    exit 1
  fi
  mkdir -p "$QUARTZ_DIR"
  git clone --depth 1 --branch "$QUARTZ_REF" "$QUARTZ_REPO" "$QUARTZ_DIR"
else
  echo "==> existing checkout found, re-pinning"
  git -C "$QUARTZ_DIR" fetch --depth 1 origin "refs/tags/$QUARTZ_REF:refs/tags/$QUARTZ_REF" --force
  git -C "$QUARTZ_DIR" checkout --force "tags/$QUARTZ_REF"
fi

# Fail loudly if the checkout is not actually at the pinned tag.
ACTUAL="$(git -C "$QUARTZ_DIR" describe --tags --exact-match 2>/dev/null || echo "<none>")"
if [ "$ACTUAL" != "$QUARTZ_REF" ]; then
  echo "ERROR: checkout is at '$ACTUAL', expected '$QUARTZ_REF'." >&2
  exit 1
fi
echo "==> verified at $ACTUAL ($(git -C "$QUARTZ_DIR" rev-parse --short HEAD))"

echo "==> npm ci"
( cd "$QUARTZ_DIR" && npm ci --no-audit --no-fund )

echo "==> copying renderer config over Quartz defaults"
cp "$HERE/quartz.config.ts" "$QUARTZ_DIR/quartz.config.ts"
cp "$HERE/quartz.layout.ts" "$QUARTZ_DIR/quartz.layout.ts"

# Quartz ships a sample content/ dir; build.sh replaces it with the projection.
echo "==> setup complete: $QUARTZ_DIR"
echo "    next: ./build.sh <CONTENT_DIR> $QUARTZ_DIR"
