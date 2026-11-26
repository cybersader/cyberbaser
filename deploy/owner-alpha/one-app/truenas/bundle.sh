#!/bin/bash
# Produce a private local handoff. This never contacts the appliance or a registry.
set -Eeuo pipefail
umask 0077
[[ $# == 1 && $1 =~ ^sha256:[a-f0-9]{64}$ ]] || { printf 'Pass the tested Docker image inspect ID.\n' >&2; exit 2; }
image=$1
reach=${CYBERBASER_REACH:-relay-only}
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
[[ -z $(git -C "$repo" status --porcelain) ]] || { printf 'Release requires a clean checkout.\n' >&2; exit 1; }
[[ $(docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}}' "$image") == "$image linux/amd64" ]]
revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
[[ $revision =~ ^[a-f0-9]{40}$ ]]
# Allow packaging or docs follow-ups, but not an archive that silently omits
# changes to any executable input to the image.
git -C "$repo" merge-base --is-ancestor "$revision" HEAD
git -C "$repo" diff --quiet "$revision" HEAD -- packaging/build.js packaging/src packaging/systemd \
  apps/owner-alpha apps/account-free-intake packages renderers/quartz-cyberbase \
  deploy/owner-alpha/one-app/{Containerfile,container-init.sh,install.json,render-offline.c}
short=$(git -C "$repo" rev-parse --short "$revision")
tag="cyberbaser:$short"
destination="$repo/.workspace/always-on/release-$short"
[[ ! -e $destination && ! -L $destination ]]
out=$(mktemp -d "$destination.tmp.XXXXXXXX")
trap 'rm -rf -- "$out"' EXIT
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
archive="$out/image.tar"
docker image save --platform linux/amd64 -o "$archive" "$tag"
platform_id=$(docker image inspect --platform linux/amd64 --format '{{.Id}}' "$tag")
exported_manifest=$(tar --occurrence=1 -xOf "$archive" index.json | jq -er '
  .manifests | select(length == 1) | .[0] | select(.platform.os == "linux" and .platform.architecture == "amd64") | .digest')
[[ $exported_manifest =~ ^sha256:[a-f0-9]{64}$ ]]
manifest_path="blobs/sha256/${exported_manifest#sha256:}"
manifest=$(tar --occurrence=1 -xOf "$archive" "$manifest_path" | tee "$out/manifest.json" | sha256sum)
[[ sha256:${manifest%% *} == "$exported_manifest" ]]
config=$(jq -er '.config.digest' "$out/manifest.json")
[[ $config =~ ^sha256:[a-f0-9]{64}$ && ( $platform_id == "$exported_manifest" || $platform_id == "$config" ) ]]
config_path="blobs/sha256/${config#sha256:}"
tar --occurrence=1 -xOf "$archive" manifest.json | jq -e --arg tag "$tag" --arg path "$config_path" '
  length == 1 and .[0].Config == $path and .[0].RepoTags == [$tag]' >/dev/null
computed=$(tar --occurrence=1 -xOf "$archive" "$config_path" | tee "$out/config.json" | sha256sum)
[[ sha256:${computed%% *} == "$config" ]]
jq -e --arg revision "$revision" '.os == "linux" and .architecture == "amd64" and .config.Labels["org.opencontainers.image.revision"] == $revision' "$out/config.json" >/dev/null
rm -- "$out/manifest.json" "$out/config.json"
printf '%s\n' "$config" > "$out/image-id.txt"
printf 'source %s\nplatform linux/amd64\nimage %s\nlocal Docker inspect ID %s\nplatform manifest %s\nplatform config %s\n' \
  "$revision" "$tag" "$image" "$exported_manifest" "$config" > "$out/build.txt"
(cd "$out" && sha256sum image.tar image-id.txt build.txt compose.yaml OPERATE.md paths.tsv > SHA256SUMS)
mv -T --no-clobber -- "$out" "$destination"
[[ ! -e $out ]]
trap - EXIT
printf '%s\n' "$destination"
