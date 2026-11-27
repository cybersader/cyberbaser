#!/bin/bash
# Compile audited, committed program sources and build one local image. Never pushes.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
SEED="${CYBERBASER_QUARTZ_SEED_ARCHIVE:?set CYBERBASER_QUARTZ_SEED_ARCHIVE to the pinned renderer bundle}"
TAG="${1:-localhost/cyberbaser-one-app:dev}"
[[ "$TAG" == localhost/*:* ]] || { printf 'Use a localhost image tag.\n' >&2; exit 1; }
[[ "$(podman info --format '{{.Host.Security.Rootless}}')" == true ]] || { printf 'Rootless Podman required.\n' >&2; exit 1; }
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/cyberbaser-one-app.XXXXXX")"
trap 'rm -rf -- "$STAGE"' EXIT
mkdir -p "$STAGE/source/packaging/dist" "$STAGE/context"
install_cmd=(bun)
build_policy=()
if [[ -n ${CYBERBASER_OFFLINE_TOOLS_IMAGE:-} ]]; then
  # Local content ID only. No registry reference or mutable tag is accepted.
  tools=$CYBERBASER_OFFLINE_TOOLS_IMAGE
  [[ "$tools" =~ ^sha256:[0-9a-f]{64}$ ]]
  [[ $(podman image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}}' "$tools") == "${tools#sha256:} linux/amd64" ]]
  install_cmd=(unshare --user --map-root-user --net -- bun)
  build_policy=(--network none --build-arg "RUNTIME_BASE=$tools" --label "org.cyberbaser.offline-tools=$tools")
fi
SRC="$STAGE/source"
CTX="$STAGE/context"

# packResources() lists tracked AND untracked files. Build in a fresh Git index
# containing only committed release inputs, not the working tree or its caches.
revision="$(git -C "$REPO" rev-parse --verify "${CYBERBASER_BUILD_REVISION:-HEAD}^{commit}")"
git -C "$REPO" archive "$revision" -- packaging/build.js packaging/src packaging/systemd \
  apps/owner-alpha apps/account-free-intake packages renderers/quartz-cyberbase \
  deploy/owner-alpha/one-app/{Containerfile,container-init.sh,install.json,render-offline.c} | tar -x -C "$SRC"
PACK="$SRC/deploy/owner-alpha/one-app"
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git -C "$SRC" init -q --template=
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git -C "$SRC" add -f -- packaging apps packages renderers
cp -- "$SEED" "$CTX/quartz-seed.tar.zst"
digest="$(bun "$SRC/packaging/src/quartz-seed.js" digest "$CTX/quartz-seed.tar.zst")"
expected="$(cd "$SRC" && bun -e 'import { QUARTZ_SEED } from "./packaging/src/quartz-seed.js"; console.log(QUARTZ_SEED.archiveSha256)')"
[[ "$digest" == "$expected" ]] || { printf 'Renderer bundle digest does not match the pin.\n' >&2; exit 1; }

# Dependencies are installed from the committed lock, not a pre-existing
# node_modules (which may contain live workspace symlinks). Skip all npm scripts.
for app in owner-alpha account-free-intake; do
  (cd "$SRC/apps/$app" && "${install_cmd[@]}" install --frozen-lockfile --ignore-scripts --production --prefer-offline) >&2
done
# Some release entry points import package source directly; give those modules
# the same locked resolution as owner-alpha without copying host dependencies.
ln -s apps/owner-alpha/node_modules "$SRC/node_modules"
(cd "$SRC" && bun packaging/build.js --outfile "$CTX/cyberbaser") >&2
# The resource archive must match the tracked allowlist exactly. In particular,
# no build side effects, host files, fixtures or second renderer may ride along.
(cd "$SRC" && bun -e '
  import { RESOURCE_PATHS } from "./packaging/build.js";
  const capture = (argv) => {
    const result = Bun.spawnSync(argv);
    if (result.exitCode !== 0) throw new Error("Could not inspect release inputs");
    return result.stdout.toString();
  };
  const committed = capture(["git", "ls-files", "-z", "--cached", "--", ...RESOURCE_PATHS]).split("\0").filter(Boolean);
  const expected = [".gitignore", ...committed].sort();
  const packed = capture(["tar", "--quoting-style=literal", "-tf", "packaging/dist/resources.tar"]).split("\n").filter(Boolean).sort();
  if (JSON.stringify(expected) !== JSON.stringify(packed)) throw new Error("Release resource list differs from tracked allowlist");
')
cp -- "$SRC/packaging/dist/resources.tar" "$PACK/Containerfile" "$PACK/install.json" "$PACK/container-init.sh" "$CTX/"
case "${CYBERBASER_IMAGE_FORM:-podman}" in
  podman) ;;
  truenas) jq '.port = 4517 | .reach = "relay-only"' "$PACK/install.json" > "$CTX/install.json" ;;
  *) printf 'Unknown image form.\n' >&2; exit 2 ;;
esac
cc -std=c11 -O2 -Wall -Wextra -Werror -fPIE -pie -fstack-protector-strong \
  -Wl,-z,relro,-z,now "$PACK/render-offline.c" -o "$CTX/render-offline"
# Only the allowlisted build artifacts are sent to the container builder.
# Neither the snapshot, lab fixture files nor the host checkout enters it.
podman build --pull=never --force-rm --layers=false --skip-unused-stages \
  --memory 2g --cpu-period 100000 --cpu-quota 200000 "${build_policy[@]}" --label "org.opencontainers.image.revision=$revision" \
  -t "$TAG" --iidfile "$STAGE/image-id" -f "$CTX/Containerfile" "$CTX" >&2
id=$(<"$STAGE/image-id")
[[ "$id" =~ ^(sha256:)?[0-9a-f]{64}$ ]]
printf '%s\n' "$id"
