#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"

version=0.2.128
bindgen=${WASM_BINDGEN:-wasm-bindgen}
if [[ "$("$bindgen" --version 2>/dev/null || true)" != "wasm-bindgen $version" ]]; then
  bindgen="$PWD/.tools/bin/wasm-bindgen"
  if [[ "$("$bindgen" --version 2>/dev/null || true)" != "wasm-bindgen $version" ]]; then
    cargo install --locked --version "$version" --root "$PWD/.tools" -j 2 wasm-bindgen-cli
  fi
fi
command -v "${CC_wasm32_unknown_unknown:-clang}" >/dev/null || {
  printf >&2 'Install a WASM-capable clang or set CC_wasm32_unknown_unknown to its absolute path.\n'
  exit 2
}
cargo build --locked --bin cyberbaser-iroh-editor-carrier -j 3
cargo build --locked --lib --target wasm32-unknown-unknown -j 3
"$bindgen" --target web --out-dir target/browser --out-name carrier \
  target/wasm32-unknown-unknown/debug/cyberbaser_iroh_editor_carrier.wasm
node ./verify.mjs
