#!/bin/bash
# Opt-in container tests. Builds the program, starts a disposable Fedora
# container running systemd (rootless Podman), runs one test script in it as
# root, then removes the container. Nothing is installed on this machine and no
# image is pushed.
#
#   CYBERBASER_QUARTZ_SEED_ARCHIVE=/path/quartz-seed-v4.5.2.tar.zst packaging/test/container/run.sh [install-test.sh|setup-e2e.sh]
#
# setup-e2e.sh runs with no network but loopback (its stand-in GitHub is inside).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
SEED="${CYBERBASER_QUARTZ_SEED_ARCHIVE:?set CYBERBASER_QUARTZ_SEED_ARCHIVE to the pinned renderer bundle}"
SCRIPT="${1:-install-test.sh}"
case "$SCRIPT" in install-test.sh|setup-e2e.sh) ;; *) echo "unknown test script: $SCRIPT" >&2; exit 2;; esac
IMAGE=localhost/cyberbaser-install-test:fedora44
NAME="cyberbaser-install-test-$$"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/cyberbaser-install-test.XXXXXX")"
cleanup() {
  if [ "${CYBERBASER_KEEP_CONTAINER:-}" = 1 ]; then echo "kept container $NAME (podman rm -f $NAME; rm -rf $WORK)"; return; fi
  podman rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"
}
trap cleanup EXIT

bun "$REPO/packaging/build.js" --outfile "$WORK/cyberbaser"
# The job runner and test helpers run as the node account, so they get a
# world-readable copy of just the owner app's sources and dependencies.
mkdir -p "$WORK/src/apps/owner-alpha/test"
rsync -aL --chmod=a+rX,go-w "$REPO/apps/owner-alpha/src" "$REPO/apps/owner-alpha/bin" "$REPO/apps/owner-alpha/node_modules" \
  "$REPO/apps/owner-alpha/package.json" "$WORK/src/apps/owner-alpha/"
cp "$REPO/apps/owner-alpha/test/fake-github.js" "$WORK/src/apps/owner-alpha/test/"
rsync -aL --chmod=a+rX,go-w "$REPO/packages" "$WORK/src/"
mkdir -p "$WORK/src/renderers"
rsync -a --chmod=a+rX,go-w --exclude node_modules "$REPO/renderers/quartz-cyberbase" "$WORK/src/renderers/"
mkdir -p "$WORK/src/apps/account-free-intake"
rsync -aL --chmod=a+rX,go-w "$REPO/apps/account-free-intake/src" "$REPO/apps/account-free-intake/node_modules" \
  "$WORK/src/apps/account-free-intake/"
chmod -R a+rX,go-w "$WORK/src"
podman build -q -t "$IMAGE" -f "$HERE/Containerfile" "$HERE" >/dev/null
NETWORK=()
if [ "$SCRIPT" = setup-e2e.sh ]; then NETWORK=(--network none); fi
# systemd needs CAP_SYS_ADMIN inside the container namespace for BindPaths=; a real host has it.
# CAP_SYS_PTRACE lets the test (as root) look at a service through /proc/<pid>/root.
podman run -d "${NETWORK[@]}" --name "$NAME" --systemd=always --security-opt label=disable --cap-add SYS_ADMIN --cap-add SYS_PTRACE \
  -v "$WORK/cyberbaser:/test/cyberbaser:ro" -v "$SEED:/test/quartz-seed.tar.zst:ro" \
  -v "$HERE:/test/scripts:ro" -v "$WORK/src:/src:ro" "$IMAGE" >/dev/null
podman exec "$NAME" bash "/test/scripts/$SCRIPT"
