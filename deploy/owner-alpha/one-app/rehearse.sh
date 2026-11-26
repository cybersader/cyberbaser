#!/bin/bash
# One build and one isolated bootstrap rehearsal. Run with heavy-run, a pinned
# seed archive, rootless Podman, and the Fedora base image already present.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ ${1:-} == --image ]]; then
  # Re-test the same artifact when only the lab harness has changed.
  [[ $# == 2 && $2 =~ ^(sha256:)?[0-9a-f]{64}$ ]] || { printf 'Pass the full local image ID.\n' >&2; exit 2; }
  image=$2
else
  image="$(bash "$HERE/build-image.sh" "${1:-localhost/cyberbaser-one-app:lab}")"
fi
# Use only the returned immutable ID, not a tag that can move mid-rehearsal.
exec bash "$HERE/smoke.sh" "$image"
