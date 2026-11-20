#!/usr/bin/env bash
# Build only into a new output directory. The vault is always an input, never an output.
set -euo pipefail
umask 077
here=$(cd "$(dirname "$0")" && pwd -P)
root=$(dirname "$here")
usage() { echo 'usage: starters/build.sh quartz|solid|both [vault [new-output-directory]]' >&2; exit 2; }
(( $# >= 1 && $# <= 3 )) || usage
case "$1" in quartz|solid|both) kind=$1 ;; *) usage ;; esac
vault=$(realpath -e "${2:-$here/example-vault}")
output=$(realpath -m "${3:-$PWD/starter-output}")
[[ -d "$vault" && -f "$vault/publish.yml" && ! -L "$vault/publish.yml" ]] || { echo 'A vault with its own publish.yml is required.' >&2; exit 1; }
[[ ! -e "$output" && ! -L "${3:-$PWD/starter-output}" && -d "$(dirname "$output")" ]] || { echo 'Choose a new output directory in an existing parent.' >&2; exit 1; }
case "$root/" in "$vault/"*) echo 'Keep the vault separate from the starter tool installation.' >&2; exit 1 ;; esac
case "$output/" in "$vault/"*) echo 'Output must be outside the vault.' >&2; exit 1 ;; esac
# Sibling staging keeps internal reports (which can name excluded files) out of output.
work=$(mktemp -d "$(dirname "$output")/.starter-work.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
bun install --cwd "$root/packages/publish" --frozen-lockfile
bun install --cwd "$root/packages/projection" --frozen-lockfile
bun "$root/packages/projection/bin/cb-project.js" "$vault" "$work/projected" --report "$work/private-report.json"
mkdir "$work/sites"
if [[ $kind != solid ]]; then
  bash "$here/quartz/render.sh" "$work/projected" "$work/sites/quartz" "$work/quartz-engine"
fi
if [[ $kind != quartz ]]; then
  bun install --cwd "$here/solid" --frozen-lockfile
  bun run --cwd "$here/solid" build "$work/projected" "$work/sites/solid"
fi
# No merge/overwrite of an old site; reserve destination only after all builds succeed.
mkdir -- "$output"
mv -- "$work/sites/"* "$output/"
printf 'Built %s in %s\n' "$kind" "$output"
