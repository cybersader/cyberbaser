#!/usr/bin/env bash
# Render a projected content tree with the pinned Quartz checkout.
#
# Usage: ./build.sh CONTENT_DIR [QUARTZ_DIR]
#   CONTENT_DIR  projected vault copy (already filtered, lowercased, pre-flighted)
#   QUARTZ_DIR   defaults to ~/bench/quartz-site (must have been set up by setup.sh)
#
# Env:
#   COPY_CONTENT=1   copy instead of symlink (for sandboxes that don't follow links)
#   OUTPUT_DIR=...   output path, default $QUARTZ_DIR/public
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 CONTENT_DIR [QUARTZ_DIR]" >&2
  exit 2
fi

CONTENT_DIR="$(cd "$1" && pwd)"
QUARTZ_DIR="${2:-$HOME/bench/quartz-site}"
OUTPUT_DIR="${OUTPUT_DIR:-$QUARTZ_DIR/public}"

if [ ! -d "$QUARTZ_DIR/quartz" ]; then
  echo "ERROR: $QUARTZ_DIR is not a Quartz checkout. Run setup.sh first." >&2
  exit 1
fi

echo "==> content : $CONTENT_DIR"
echo "==> quartz  : $QUARTZ_DIR"
echo "==> output  : $OUTPUT_DIR"

# Replace whatever content/ is there (Quartz's sample docs, or a previous run).
rm -rf "$QUARTZ_DIR/content"
if [ "${COPY_CONTENT:-0}" = "1" ]; then
  cp -a "$CONTENT_DIR" "$QUARTZ_DIR/content"
else
  ln -s "$CONTENT_DIR" "$QUARTZ_DIR/content"
fi

# Stale output would inflate the page count and hide emitter regressions.
rm -rf "$OUTPUT_DIR"

set +e
( cd "$QUARTZ_DIR" && npx quartz build -d "$QUARTZ_DIR/content" -o "$OUTPUT_DIR" )
STATUS=$?
set -e

if [ "$STATUS" -ne 0 ]; then
  echo "==> BUILD FAILED (exit $STATUS)" >&2
  # Quartz has no per-file error isolation: a single bad YAML frontmatter file
  # aborts the whole build. If this fails, fix the projection's pre-flight.
  exit "$STATUS"
fi

echo "==> pages: $(find "$OUTPUT_DIR" -name '*.html' | wc -l)"
echo "==> size : $(du -sh "$OUTPUT_DIR" | cut -f1)"
echo "$OUTPUT_DIR"
