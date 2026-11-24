#!/bin/bash
# Build the one-app home-server image locally from the one program.
#   CYBERBASER_QUARTZ_SEED_ARCHIVE=/path/quartz-seed-v4.5.2.tar.zst deploy/owner-alpha/one-app/build-image.sh [tag]
# Never pushes. Prints the local image ID.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
SEED="${CYBERBASER_QUARTZ_SEED_ARCHIVE:?set CYBERBASER_QUARTZ_SEED_ARCHIVE to the pinned renderer bundle}"
TAG="${1:-localhost/cyberbaser-one-app:dev}"
ENGINE="$(command -v podman || command -v docker)"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/cyberbaser-one-app.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
bun "$REPO/packaging/build.js" --outfile "$STAGE/cyberbaser" >/dev/null
digest="$(bun "$REPO/packaging/src/quartz-seed.js" digest "$SEED")"
expected="$(grep -o "archiveSha256: '[0-9a-f]*'" "$REPO/packaging/src/quartz-seed.js" | cut -d"'" -f2)"
[ "$digest" = "$expected" ] || { echo "renderer bundle digest does not match the pin" >&2; exit 1; }
cp "$REPO/packaging/dist/resources.tar" "$SEED" "$HERE/Containerfile" "$HERE/install.json" "$HERE/container-init.sh" "$STAGE/"
[ "$(basename "$SEED")" = quartz-seed.tar.zst ] || mv "$STAGE/$(basename "$SEED")" "$STAGE/quartz-seed.tar.zst"
"$ENGINE" build -q -t "$TAG" -f "$STAGE/Containerfile" "$STAGE"
