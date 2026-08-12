#!/usr/bin/env bash
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$HERE/.." && pwd)"
PROJECT_ROOT="$(cd "$APP_DIR/../.." && pwd)"
CONFIG_FILE="${1:-$APP_DIR/owner-alpha.local.json}"

case "$CONFIG_FILE" in
  /*) ;;
  *) CONFIG_FILE="$(cd "$(dirname "$CONFIG_FILE")" && pwd)/$(basename "$CONFIG_FILE")" ;;
esac

if [ ! -f "$CONFIG_FILE" ]; then
  printf 'ERROR: owner-alpha config does not exist: %s\n' "$CONFIG_FILE" >&2
  exit 1
fi

# Quartz performs thousands of small-file operations. WSL-mounted Windows paths
# are dramatically slower than ext4, so mirror only the runtime code and keep
# all derived owner-alpha state in a private Linux cache. The canonical source
# checkout remains the exact path bound by owner-alpha.local.json.
case "$PROJECT_ROOT" in
  /mnt/*)
    RUNTIME_ROOT="${OWNER_ALPHA_RUNTIME_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/cyberbaser/owner-alpha-runtime}"
    MARKER="$RUNTIME_ROOT/.cyberbaser-owner-alpha-runtime"
    if [ -e "$RUNTIME_ROOT" ] && [ ! -f "$MARKER" ]; then
      printf 'ERROR: refusing to use unmarked runtime directory: %s\n' "$RUNTIME_ROOT" >&2
      exit 1
    fi
    mkdir -p "$RUNTIME_ROOT/apps/owner-alpha" "$RUNTIME_ROOT/packages" "$RUNTIME_ROOT/renderers/quartz-cyberbase"
    chmod 700 "$RUNTIME_ROOT" "$RUNTIME_ROOT/apps" "$RUNTIME_ROOT/apps/owner-alpha" \
      "$RUNTIME_ROOT/packages" "$RUNTIME_ROOT/renderers" "$RUNTIME_ROOT/renderers/quartz-cyberbase"
    if [ ! -f "$MARKER" ]; then
      printf 'owner-alpha-runtime-v1\n' > "$MARKER"
    elif [ "$(<"$MARKER")" != 'owner-alpha-runtime-v1' ]; then
      printf 'ERROR: owner-alpha runtime marker is not recognized: %s\n' "$MARKER" >&2
      exit 1
    fi

    rsync -a --delete --chmod=Du=rwx,Dgo=,Fu=rw,Fgo= --exclude 'owner-alpha.local.json' "$APP_DIR/" "$RUNTIME_ROOT/apps/owner-alpha/"
    for package in correction linkcheck ofm projection publish trust; do
      rsync -a --delete --chmod=Du=rwx,Dgo=,Fu=rw,Fgo= --exclude 'node_modules' \
        "$PROJECT_ROOT/packages/$package/" \
        "$RUNTIME_ROOT/packages/$package/"
      rsync -a --delete --chmod=Du=rwx,Dgo=,Fu=rw,Fgo= --exclude 'node_modules' \
        "$PROJECT_ROOT/packages/$package/" \
        "$RUNTIME_ROOT/apps/owner-alpha/node_modules/@cyberbaser/$package/"
    done
    rsync -a --delete --chmod=Du=rwx,Dgo=,Fu=rw,Fgo= "$PROJECT_ROOT/renderers/quartz-cyberbase/" "$RUNTIME_ROOT/renderers/quartz-cyberbase/"
    install -m 600 "$PROJECT_ROOT/.gitignore" "$RUNTIME_ROOT/.gitignore"
    RUNTIME_CONFIG="$RUNTIME_ROOT/apps/owner-alpha/owner-alpha.local.json"
    install -m 600 "$CONFIG_FILE" "$RUNTIME_CONFIG"
    if [ ! -d "$RUNTIME_ROOT/.git" ]; then
      git -C "$RUNTIME_ROOT" init -q
    fi
    exec bun "$RUNTIME_ROOT/apps/owner-alpha/src/server.js" "$RUNTIME_CONFIG"
    ;;
  *)
    exec bun "$APP_DIR/src/server.js" "$CONFIG_FILE"
    ;;
esac
