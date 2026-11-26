#!/bin/bash
# Produce a private local handoff. This never contacts the appliance or a registry.
set -Eeuo pipefail
umask 0077
[[ $# == 1 && $1 =~ ^sha256:[a-f0-9]{64}$ ]] || { printf 'Pass the tested Docker config ID.\n' >&2; exit 2; }
image=$1
reach=${CYBERBASER_REACH:-relay-only}
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
revision=$(git -C "$repo" rev-parse HEAD)
short=$(git -C "$repo" rev-parse --short HEAD)
[[ -z $(git -C "$repo" status --porcelain) ]] || { printf 'Release requires a clean checkout.\n' >&2; exit 1; }
[[ $(docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}}' "$image") == "$image linux/amd64" ]]
tag="cyberbaser:$short"
out="$repo/.workspace/always-on/release-$short"
mkdir -- "$out"
# Never reuse a mutable tag pointing at a different image.
if old=$(docker image inspect --format '{{.Id}}' "$tag" 2>/dev/null) && [[ $old != "$image" ]]; then
  printf 'Release tag already points at another image.\n' >&2
  exit 1
fi
docker image tag "$image" "$tag"
CYBERBASER_IMAGE=$tag CYBERBASER_DATA="${CYBERBASER_DATA:-/mnt/personal/cyberbaser}" CYBERBASER_REACH=$reach \
  docker compose -p cyberbaser -f "$here/compose.yaml" config --no-path-resolution > "$out/compose.yaml"
# Pull policy and role settings survive Compose's expansion; no environment
# variables are needed when middleware consumes the rendered document.
docker compose -f "$out/compose.yaml" config --quiet
install -m 0600 "$here/OPERATE.md" "$here/paths.tsv" "$out/"
printf '%s\n' "$image" > "$out/image-id.txt"
printf 'source %s\nplatform linux/amd64\nimage %s\nDocker config ID %s\n' "$revision" "$tag" "$image" > "$out/build.txt"
docker image save -o "$out/image.tar" "$tag"
(cd "$out" && sha256sum image.tar image-id.txt build.txt compose.yaml OPERATE.md paths.tsv > SHA256SUMS)
printf '%s\n' "$out"
