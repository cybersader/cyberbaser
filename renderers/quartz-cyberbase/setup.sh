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
QUARTZ_COMMIT="${QUARTZ_COMMIT:-4923affa7722dfc751f1074348e6dad214fe0c08}"
QUARTZ_LOCK_SHA256="${QUARTZ_LOCK_SHA256:-9ea5873a2bb495054f23b16f96d1d41f44348863e655f4c6d86b107f372b09b9}"
QUARTZ_INSTALL_SHA256="${QUARTZ_INSTALL_SHA256:-38bc51071b55a4444abdea3e0620747882e2be3a8610da5715a9c0b40b320850}"
QUARTZ_OFFLINE="${QUARTZ_OFFLINE:-0}"
QUARTZ_SEED_DIR="${QUARTZ_SEED_DIR:-}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUARTZ_DIR="${1:-$HOME/bench/quartz-site}"

echo "==> quartz repo : $QUARTZ_REPO"
echo "==> pinned ref  : $QUARTZ_REF"
echo "==> pinned commit: $QUARTZ_COMMIT"
echo "==> target dir  : $QUARTZ_DIR"

verify_checkout() {
  local directory="$1"
  local actual_ref actual_commit actual_origin actual_lock install_marker
  [ -d "$directory/.git" ] || { echo "ERROR: $directory is not a Git checkout." >&2; exit 1; }
  actual_origin="$(git -C "$directory" remote get-url origin)"
  actual_ref="$(git -C "$directory" describe --tags --exact-match 2>/dev/null || echo "<none>")"
  actual_commit="$(git -C "$directory" rev-parse HEAD)"
  actual_lock="$(sha256sum "$directory/package-lock.json" | cut -d' ' -f1)"
  install_marker="$directory/node_modules/.cyberbaser-install-sha256"
  if [ "$actual_origin" != "$QUARTZ_REPO" ]; then
    echo "ERROR: checkout origin is '$actual_origin', expected '$QUARTZ_REPO'." >&2
    exit 1
  fi
  if [ "$actual_ref" != "$QUARTZ_REF" ] || [ "$actual_commit" != "$QUARTZ_COMMIT" ]; then
    echo "ERROR: checkout is at '$actual_ref' ($actual_commit), expected '$QUARTZ_REF' ($QUARTZ_COMMIT)." >&2
    exit 1
  fi
  if [ "$actual_lock" != "$QUARTZ_LOCK_SHA256" ]; then
    echo "ERROR: Quartz package-lock digest does not match the pinned lock." >&2
    exit 1
  fi
  if [ ! -d "$directory/node_modules" ] \
    || [ ! -f "$install_marker" ] \
    || [ "$(<"$install_marker")" != "$QUARTZ_INSTALL_SHA256" ]; then
    return 1
  fi
  echo "==> verified at $actual_ref ($actual_commit)"
}

case "$QUARTZ_OFFLINE" in
  0)
    if [ ! -d "$QUARTZ_DIR/.git" ]; then
      if [ -e "$QUARTZ_DIR" ] && [ -n "$(ls -A "$QUARTZ_DIR" 2>/dev/null || true)" ]; then
        echo "ERROR: $QUARTZ_DIR exists, is non-empty, and is not a git checkout." >&2
        exit 1
      fi
      mkdir -p "$QUARTZ_DIR"
      git clone --depth 1 --branch "$QUARTZ_REF" "$QUARTZ_REPO" "$QUARTZ_DIR"
    else
      echo "==> existing checkout found, re-pinning"
      ACTUAL_ORIGIN="$(git -C "$QUARTZ_DIR" remote get-url origin)"
      if [ "$ACTUAL_ORIGIN" != "$QUARTZ_REPO" ]; then
        echo "ERROR: checkout origin is '$ACTUAL_ORIGIN', expected '$QUARTZ_REPO'." >&2
        exit 1
      fi
      git -C "$QUARTZ_DIR" fetch --depth 1 origin "refs/tags/$QUARTZ_REF:refs/tags/$QUARTZ_REF" --force
      git -C "$QUARTZ_DIR" checkout --detach --force "$QUARTZ_COMMIT"
    fi
    if ! verify_checkout "$QUARTZ_DIR"; then
      echo "==> npm ci"
      ( cd "$QUARTZ_DIR" && npm ci --no-audit --no-fund )
      printf '%s\n' "$QUARTZ_INSTALL_SHA256" > "$QUARTZ_DIR/node_modules/.cyberbaser-install-sha256"
      verify_checkout "$QUARTZ_DIR"
    else
      echo "==> npm dependencies already match the pinned lockfile"
    fi
    ;;
  1)
    case "$QUARTZ_SEED_DIR" in
      /*) ;;
      *) echo "ERROR: QUARTZ_SEED_DIR must be one absolute path in offline mode." >&2; exit 1 ;;
    esac
    [ -d "$QUARTZ_SEED_DIR" ] && [ ! -L "$QUARTZ_SEED_DIR" ] \
      || { echo "ERROR: offline Quartz seed is missing or substituted." >&2; exit 1; }
    QUARTZ_SEED_DIR="$(realpath "$QUARTZ_SEED_DIR")"
    verify_checkout "$QUARTZ_SEED_DIR" \
      || { echo "ERROR: offline Quartz seed dependencies are incomplete." >&2; exit 1; }
    if [ -L "$QUARTZ_DIR" ]; then
      echo "ERROR: Quartz target must not be a symlink." >&2
      exit 1
    fi
    mkdir -p "$QUARTZ_DIR"
    QUARTZ_DIR="$(realpath "$QUARTZ_DIR")"
    case "$QUARTZ_DIR/" in
      "$QUARTZ_SEED_DIR/"|"$QUARTZ_SEED_DIR/"*)
        echo "ERROR: Quartz target must be separate from the read-only seed." >&2
        exit 1
        ;;
    esac
    echo "==> materializing verified offline Quartz seed"
    rsync -a --delete --chmod=u+rwX "$QUARTZ_SEED_DIR/" "$QUARTZ_DIR/"
    verify_checkout "$QUARTZ_DIR" \
      || { echo "ERROR: materialized Quartz dependencies are incomplete." >&2; exit 1; }
    ;;
  *)
    echo "ERROR: QUARTZ_OFFLINE must be 0 or 1." >&2
    exit 1
    ;;
esac

echo "==> copying renderer config over Quartz defaults"
cp "$HERE/quartz.config.ts" "$QUARTZ_DIR/quartz.config.ts"
cp "$HERE/quartz.layout.ts" "$QUARTZ_DIR/quartz.layout.ts"

# Theme stylesheet. Quartz's componentResources emitter imports
# quartz/styles/custom.scss and appends it after every component stylesheet,
# which is what lets equal-specificity rules in it override upstream.
if [ -f "$HERE/styles/custom.scss" ]; then
  echo "==> copying custom.scss into quartz/styles/"
  cp "$HERE/styles/custom.scss" "$QUARTZ_DIR/quartz/styles/custom.scss"
fi

# Cyberbaser-local transformer plugins. Placed under quartz/cyberbase/ so their
# relative imports (../../plugins/types) resolve against the real Quartz tree.
if [ -d "$HERE/plugins" ]; then
  echo "==> copying transformer plugins into quartz/cyberbase/"
  mkdir -p "$QUARTZ_DIR/quartz/cyberbase"
  cp "$HERE"/plugins/*.ts "$QUARTZ_DIR/quartz/cyberbase/"
fi

# Cyberbaser-local components and their helpers. They import Quartz internals by
# relative path (./types, ../util/lang), so they must land in quartz/components/.
# Plain overwrite-copy every run: idempotent, and it re-lays the current version
# over whatever a previous run left behind.
if [ -d "$HERE/components" ]; then
  echo "==> copying renderer components into quartz/components/"
  for f in "$HERE"/components/*.ts "$HERE"/components/*.tsx; do
    [ -e "$f" ] || continue
    echo "    + $(basename "$f")"
    cp "$f" "$QUARTZ_DIR/quartz/components/"
  done
  if [ -d "$HERE/components/scripts" ]; then
    mkdir -p "$QUARTZ_DIR/quartz/components/scripts"
    for f in "$HERE"/components/scripts/*.inline.ts; do
      [ -e "$f" ] || continue
      echo "    + scripts/$(basename "$f")"
      cp "$f" "$QUARTZ_DIR/quartz/components/scripts/"
    done
  fi
fi

# Quartz ships a sample content/ dir; build.sh replaces it with the projection.
echo "==> setup complete: $QUARTZ_DIR"
echo "    next: ./build.sh <CONTENT_DIR> $QUARTZ_DIR"
