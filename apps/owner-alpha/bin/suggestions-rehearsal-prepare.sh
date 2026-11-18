#!/usr/bin/env bash
# Explicit, network-using preparation. The rehearsal itself never installs.
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
for program in bun git node npm rsync flock sha256sum; do
  command -v "$program" >/dev/null || { printf 'Install %s, then rerun preparation.\n' "$program" >&2; exit 1; }
done
# Frozen manifests only; no lockfile generation or updates.
for app in owner-alpha account-free-intake; do
  bun install --cwd "$ROOT/apps/$app" --frozen-lockfile --ignore-scripts
 done
mkdir -p "$ROOT/.workspace"
printf 'Preparing pinned Quartz renderer and npm dependencies (internet required).\n'
bash "$ROOT/renderers/quartz-cyberbase/setup.sh" "$ROOT/.workspace/suggestions-rehearsal-renderer"
printf 'Preparation complete. Run: bun run --cwd docs try:suggestions\n'
