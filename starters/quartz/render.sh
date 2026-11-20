#!/usr/bin/env bash
# Internal renderer entry point: the first argument is already publicly projected.
set -euo pipefail
[[ $# == 3 ]] || { echo 'usage: render.sh projected-dir new-site-dir new-engine-dir' >&2; exit 2; }
here=$(cd "$(dirname "$0")" && pwd -P)
wrapper="$here/../../renderers/quartz-cyberbase"
input=$(realpath -e "$1"); output=$(realpath -m "$2"); engine=$(realpath -m "$3")
[[ -d "$input" && ! -e "$output" && ! -L "$2" && ! -e "$engine" && ! -L "$3" && "$engine" != "$output" ]] || exit 2
case "$output/" in "$input/"*|"$engine/"*) exit 2 ;; esac
case "$engine/" in "$input/"*|"$output/"*) exit 2 ;; esac
export CYBERBASER_SITE_CONFIG="${STARTER_QUARTZ_SETTINGS:-$here/site.yml}"
export CYBERBASER_EDIT_LINK_MODE=public CYBERBASER_ANALYTICS=off
unset CYBERBASER_ACCOUNT_FREE_INTAKE CYBERBASER_SOURCE_PROVENANCE CYBERBASER_SOURCE_CHECKOUT
bash "$wrapper/setup.sh" "$engine"
OUTPUT_DIR="$output" COPY_CONTENT=0 bash "$wrapper/build.sh" "$input" "$engine"
