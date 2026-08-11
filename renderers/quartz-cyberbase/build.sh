#!/usr/bin/env bash
# Render a projected content tree with the pinned Quartz checkout.
#
# Usage: ./build.sh CONTENT_DIR [QUARTZ_DIR]
#   CONTENT_DIR  projected vault copy (already filtered, lowercased, pre-flighted)
#   QUARTZ_DIR   defaults to ~/bench/quartz-site (must have been set up by setup.sh)
#
# Env:
#   COPY_CONTENT=1                 copy instead of symlink
#   OUTPUT_DIR=...                 output path, default $QUARTZ_DIR/public
#   CYBERBASER_EDIT_LINK_MODE=...  public (default) or owner (local builds only)
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 CONTENT_DIR [QUARTZ_DIR]" >&2
  exit 2
fi

CONTENT_DIR="$(cd "$1" && pwd)"
QUARTZ_DIR="${2:-$HOME/bench/quartz-site}"
# Absolutize before any cd: a relative QUARTZ_DIR ("quartz") otherwise turns the
# -d/-o flags into quartz/quartz/... after `cd $QUARTZ_DIR`, which is exactly how
# the first CI run built 0 pages into a directory nobody checked.
if [ ! -d "$QUARTZ_DIR" ]; then
  echo "ERROR: QUARTZ_DIR '$QUARTZ_DIR' does not exist. Run setup.sh first." >&2
  exit 1
fi
QUARTZ_DIR="$(cd "$QUARTZ_DIR" && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-$QUARTZ_DIR/public}"
case "$OUTPUT_DIR" in
  /*) ;;
  *) OUTPUT_DIR="$(pwd)/$OUTPUT_DIR" ;;
esac

CYBERBASER_EDIT_LINK_MODE="${CYBERBASER_EDIT_LINK_MODE:-public}"
case "$CYBERBASER_EDIT_LINK_MODE" in
  public) ;;
  owner)
    if [[ "${CI:-}" =~ ^(1|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss])$ ]]; then
      echo "ERROR: CYBERBASER_EDIT_LINK_MODE=owner is disabled in CI." >&2
      exit 1
    fi
    # Delegate to the same resolveOwnerOrigin() Quartz uses at build time so
    # the private-IPv4 rules live in exactly one renderer implementation.
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if ! CYBERBASER_OWNER_ORIGIN="$(bun "$SCRIPT_DIR/validate-owner-origin.ts" "${CYBERBASER_OWNER_ORIGIN:-}")"; then
      echo "ERROR: owner mode requires an exact CYBERBASER_OWNER_ORIGIN private-network IPv4 origin." >&2
      exit 2
    fi
    export CYBERBASER_OWNER_ORIGIN
    ;;
  *)
    echo "ERROR: CYBERBASER_EDIT_LINK_MODE must be 'public' or 'owner'." >&2
    exit 2
    ;;
esac
export CYBERBASER_EDIT_LINK_MODE

if [ ! -d "$QUARTZ_DIR/quartz" ]; then
  echo "ERROR: $QUARTZ_DIR is not a Quartz checkout. Run setup.sh first." >&2
  exit 1
fi

echo "==> content   : $CONTENT_DIR"
echo "==> quartz    : $QUARTZ_DIR"
echo "==> output    : $OUTPUT_DIR"
echo "==> edit links: $CYBERBASER_EDIT_LINK_MODE"

# Keep the persistent owner cache incremental. A full rm+cp over thousands of
# small files is especially expensive on WSL-mounted filesystems; rsync changes
# only the projection delta while still deleting stale output deterministically.
if [ "${COPY_CONTENT:-0}" = "1" ]; then
  mkdir -p "$QUARTZ_DIR/content"
  rsync -a --delete "$CONTENT_DIR/" "$QUARTZ_DIR/content/"
else
  rm -rf "$QUARTZ_DIR/content"
  ln -s "$CONTENT_DIR" "$QUARTZ_DIR/content"
fi

# Stale output would inflate the page count and hide emitter regressions.
rm -rf "$OUTPUT_DIR"

set +e
# Execute the pre-seeded repository CLI directly. Using npx here would retain a
# runtime package-install fallback, which the immutable image contract forbids.
( cd "$QUARTZ_DIR" && node ./quartz/bootstrap-cli.mjs build -d "$QUARTZ_DIR/content" -o "$OUTPUT_DIR" )
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
