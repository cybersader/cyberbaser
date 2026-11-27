#!/usr/bin/env bash
# Build the relay-only Iroh client to WebAssembly and generate its JS glue.
# Needs: rustup (toolchain pinned in carrier/rust-toolchain.toml), a clang that
# targets wasm32 (ring compiles C), and wasm-bindgen CLI 0.2.128.
# CC_wasm32_unknown_unknown / AR_wasm32_unknown_unknown may point at, e.g., an
# Android NDK or wasi-sdk clang and llvm-ar. WASM_BINDGEN may name the CLI.
set -euo pipefail
cd "$(dirname "$0")/../carrier"
bindgen="${WASM_BINDGEN:-wasm-bindgen}"
[[ "$("$bindgen" --version 2>/dev/null)" == "wasm-bindgen 0.2.128" ]] || {
  echo "wasm-bindgen 0.2.128 is required (set WASM_BINDGEN)" >&2; exit 2; }
cargo build --locked --release --lib --target wasm32-unknown-unknown -j 4
cargo build --locked --release --bin loopback-relay -j 4
"$bindgen" --target web --out-dir target/browser --out-name carrier \
  target/wasm32-unknown-unknown/release/cyberbaser_obsidian_carrier.wasm
